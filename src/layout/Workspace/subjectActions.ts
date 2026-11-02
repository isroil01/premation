/**
 * What can be done with a subject — one list, used by Properties ▸ Subject,
 * right-click ▸ Subject and the subject chip's menu, so the three are always
 * the same (the approved Subject workflow mockup, screen 3).
 *
 * Every action is one undo entry and leaves ordinary layers and effects the
 * user can edit afterwards: nothing here is a special mode.
 */

import type { Command, PropertyInit } from '@motion/engine-api';
import { edit } from '@core/engine/uiEdits';
import { values } from '@core/engine/propRefs';
import { mirrorMaskHeaders } from '@core/mirror/effects';
import { settingsDurationSeconds, settingsFps, settingsSetWorkArea } from '@core/mirror/compFacts';
import { playheadSeconds } from '@core/timeline/timelineView';
import { propagateObjectMatte, rotoFreezeEdit, rotoMattes, ROTO_PATH_NAME } from '@core/workspace/rotoBrushTool';
import { activeCompSettingsNow } from '@hooks/useMirrorFrame';
import { documentMirror } from '@stores/documentMirror';
import { useRotoBrushStore } from '@stores/rotoBrushStore';
import { activeSubjectId, useSubjectStore } from '@stores/subjectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import type { ContextMenuItem } from '@stores/contextMenuStore';
import { t } from '@core/i18n';
import { objectMatteCard } from '@core/workspace/objectMatteEffect';
import { layerSubjects, subjectLocked } from '@core/workspace/subjects';
import { newLayerFromSubject } from './newLayerFromSubjectCommand';
import { fillSubjectGap } from './subjectGapFill';
import { runCreateSubjectTrack } from './placeBehindSubjectCommand';
import { matteOutlineKeys } from './subjectTrack';
import { fetchSubjectTracks, isTracked, retrackRange } from '@core/workspace/subjectTracks';

export type SubjectActionId =
  | 'select' | 'follow' | 'newLayer' | 'textBehind' | 'outline' | 'colorSubject' | 'colorBackground'
  | 'blurBackground' | 'removeBackground' | 'removeFromShot' | 'trackNull' | 'freeze';

export interface SubjectAction {
  id: SubjectActionId;
  label: string;
  description: string;
  run: () => void;
  disabled?: boolean;
}

/** What the layer's subject is today (for labels and enable rules). */
export interface SubjectState {
  /** A selection exists on the layer (any matte mask). */
  selected: boolean;
  /** The matte runs through the shot (keyed outline), not one frame. */
  followed: boolean;
  frozen: boolean;
  /** The selection cuts the layer (its Object Matte effect is on): the background is removed. */
  cuts: boolean;
}

const MATTE_NAMES = new Set(['Object Matte', ROTO_PATH_NAME, 'Roto Brush (Frozen)']);

/**
 * The same, from what the mirror holds right now (a context menu is built
 * synchronously). A layer whose property tree has not arrived reads as
 * having no subject; Properties ▸ Subject loads it and shows the real state.
 */
export function subjectStateNow(layer: string): SubjectState {
  const m = documentMirror();
  const tree = m.tree(layer);
  if (!tree) return { selected: false, followed: false, frozen: false, cuts: false };
  const masks = mirrorMaskHeaders(tree);
  const r = rotoMattes(layer);
  const followed = masks.some((x) => MATTE_NAMES.has(x.name) && m.keyframes(layer, `masks/${x.id}/path`).length > 1);
  return {
    selected: masks.some((x) => MATTE_NAMES.has(x.name)),
    followed,
    frozen: r.frozen.length > 0 || r.subjectFrozen.length > 0,
    cuts: cutsNow(layer, r),
  };
}

/** Whether the subject cuts the layer: its Object Matte effect is on (or an old tool's Add mask cuts). */
function cutsNow(layer: string, r: { live: string[] }): boolean {
  const card = objectMatteCard(layer);
  if (card) return card.enabled !== false;
  return mirrorMaskHeaders(documentMirror().tree(layer)).some((x) => r.live.includes(x.id) && x.cuts);
}

/** The actions as context-menu rows (right-click ▸ Subject, the subject chip). */
export function subjectMenuItems(layer: string, hooks: SubjectActionHooks): ContextMenuItem[] {
  const actions = subjectActions(layer, subjectStateNow(layer), hooks);
  const rows: ContextMenuItem[] = [];
  for (const a of actions) {
    rows.push({ id: `subject-${a.id}`, label: a.label, disabled: a.disabled, onSelect: a.run });
    // Select / Follow, then the designs, then the matte's own state.
    if (a.id === 'follow' || a.id === 'removeBackground') rows.push({ id: `subject-sep-${a.id}`, separator: true });
  }
  return rows;
}

export async function subjectStateOf(layer: string): Promise<SubjectState> {
  const m = documentMirror();
  await m.loadTrees([layer]);
  const masks = mirrorMaskHeaders(m.tree(layer));
  const r = rotoMattes(layer);
  return {
    selected: masks.some((x) => MATTE_NAMES.has(x.name)),
    followed: (await matteOutlineKeys(layer)) !== null,
    frozen: r.frozen.length > 0 || r.subjectFrozen.length > 0,
    cuts: cutsNow(layer, r),
  };
}

const notify = (message: string, level: 'info' | 'success' | 'warning' = 'success'): void => {
  useUIStore.getState().notify({ level, message, durationMs: 3200 });
};

/** The work area, or the whole composition without one. */
function workAreaNow(): { start: number; end: number } {
  const settings = activeCompSettingsNow();
  const wa = settingsSetWorkArea(settings);
  return { start: wa ? wa.start : 0, end: wa ? wa.end : settingsDurationSeconds(settings) };
}

/** Follow a subject (default the active one) through the work area, both ways, as a Tasks-panel job (the explicit Follow). */
export async function followSubject(layer: string, subject: string = activeSubjectId(layer), origin: number = playheadSeconds()): Promise<void> {
  await walkSubject(layer, subject, workAreaNow(), false, t('workspace.subjects.following', 'Following the subject'), origin);
}

/** How far either side of an edit the automatic first Follow reaches (autoTrack.ts). */
export const AUTO_FOLLOW_SPAN_S = 3;

/**
 * The automatic tracking's first Follow: `span` seconds either side of the
 * edit (clamped to the work area), not the whole work area — a selection
 * tracks where the user is working within seconds, while the explicit Follow
 * button still carries it through the whole shot. Frames tracked earlier
 * outside the span stay (keepOutside), so a later edit extends the track.
 */
export async function followSubjectNear(layer: string, subject: string, time: number, span: number = AUTO_FOLLOW_SPAN_S): Promise<void> {
  const wa = workAreaNow();
  const range = { start: Math.max(wa.start, time - span), end: Math.min(wa.end, time + span) };
  if (range.end <= range.start) return;
  await walkSubject(layer, subject, range, true, t('workspace.subjects.following', 'Following the subject'), time);
}

/** Footage that moves: a video item (a still's subject is rightly held on every frame). */
export function layerMoves(nodeId: string): boolean {
  const m = documentMirror();
  const src = m.layer(nodeId)?.source;
  return !!src && m.item(src)?.mediaType === 'video';
}

/**
 * A style is going onto a subject of moving footage: if the subject is still
 * HELD (selected on a frame or two, the same matte on every frame), it is
 * tracked first — else the style would sit where the subject was while the
 * subject moves on. Nothing for stills, a tracked or locked subject, a walk
 * already running, or with automatic tracking off.
 */
export async function ensureSubjectTracked(layer: string, subject: string): Promise<void> {
  if (!useSubjectStore.getState().autoTrack || !layerMoves(layer) || subjectLocked(layer, subject) || subjectWalkRunning(layer, subject)) return;
  const frames = (await fetchSubjectTracks(layer)).find((s) => s.subject === subject)?.frames ?? [];
  if (frames.length === 0 || isTracked(frames, settingsFps(activeCompSettingsNow()))) return;
  const fix = frames.find((f) => f.fix) ?? frames[0]!;
  await followSubject(layer, subject, fix.time);
}

/** The walks running now, by `layer:subject` → cancel. A new walk of the same subject cancels the old one. */
const runningWalks = new Map<string, () => void>();

/** Whether a walk of the subject is running. */
export function subjectWalkRunning(layer: string, subject: string): boolean {
  return runningWalks.has(`${layer}:${subject}`);
}

/** Cancel the subject's running walk, if any (its result is then not applied). */
export function cancelSubjectWalk(layer: string, subject: string): void {
  runningWalks.get(`${layer}:${subject}`)?.();
}

/**
 * Re-track a tracked subject between the fixes either side of `time` (the
 * Subjects panel's tracking lane, after a fix): only those frames are walked
 * again, from the matte at `time`; every other frame and fix stays.
 */
export async function retrackSubject(layer: string, subject: string, time: number): Promise<void> {
  const fps = settingsFps(activeCompSettingsNow());
  const range = retrackRange((await fetchSubjectTracks(layer)).find((s) => s.subject === subject)?.frames ?? [], time, fps);
  if (!range) {
    notify(t('workspace.subjects.retrackNothing', 'Nothing to re-track here: move the playhead onto the subject\'s tracked frames.'), 'warning');
    return;
  }
  await walkSubject(layer, subject, range, true, t('workspace.subjects.retracking', 'Re-tracking the subject'), time);
}

/**
 * The walk all of them run, as a Tasks-panel job (the work runs in the engine's
 * model process, on its batch lane). It is BACKGROUND work: the tools stay
 * usable — the store's `tracking` flag (not `busy`, which locks the tools)
 * says a walk is on and how far it is.
 */
async function walkSubject(layer: string, subject: string, range: { start: number; end: number }, keepOutside: boolean, label: string,
  origin: number = playheadSeconds()): Promise<void> {
  const fps = settingsFps(activeCompSettingsNow());
  const { start, end } = range;
  const store = useRotoBrushStore.getState();
  const key = `${layer}:${subject}`;
  // One walk per subject: a newer one (a second fix while the first re-track runs) replaces it.
  runningWalks.get(key)?.();
  const jobId = `follow-${layer}-${subject}`;
  let cancelled = false;
  const cancel = (): void => { cancelled = true; };
  runningWalks.set(key, cancel);
  useUIStore.getState().startJob({ id: jobId, kind: 'analysis', label, progress: 0, cancel });
  store.setTracking(true, 0);
  try {
    const r = await propagateObjectMatte(layer, store.strokes, {
      origin, start, end, fps, direction: 'both', featherPx: store.featherPx, refine: store.refine, box: store.box, subject, keepOutside,
    }, (f) => {
      useUIStore.getState().updateJob(jobId, { progress: f });
      useRotoBrushStore.getState().setTracking(true, f);
      return !cancelled;
    });
    useUIStore.getState().finishJob(jobId, r.status === 'cancelled'
      ? { status: 'cancelled', message: t('workspace.subjects.followCancelled', 'Following cancelled') }
      : { status: 'done', message: t('workspace.subjects.followDone', 'Subject followed over {n} frames', { n: r.frames }) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    useUIStore.getState().finishJob(jobId, { status: 'failed', message });
    notify(message, 'warning');
  } finally {
    if (runningWalks.get(key) === cancel) runningWalks.delete(key);
    // Another subject's walk may still run: the flag stays while any does.
    if (runningWalks.size === 0) useRotoBrushStore.getState().setTracking(false);
  }
}

let fxSeq = 0;

/**
 * One effect on the layer, one undo entry; `scope` makes it Apply To the subject or the background.
 * With several subjects it reads the active one alone (Compositing Options ▸ subjectId).
 */
async function addEffect(layer: string, label: string, effect: string, params: PropertyInit[], scope?: 'subject' | 'background'): Promise<boolean> {
  const id = `fx_subject_${Date.now().toString(36)}_${(fxSeq++).toString(36)}`;
  const commands: Command[] = [{ type: 'addEffect', layers: [layer], effect, params, id }];
  if (scope) commands.push({ type: 'setProperty', prop: { layer, path: `effects/${id}/compositing/subject` }, value: values.string(scope) });
  if (layerSubjects(layer).length > 1) {
    commands.push({ type: 'setProperty', prop: { layer, path: `effects/${id}/compositing/subjectId` }, value: values.string(activeSubjectId(layer)) });
  }
  const res = await edit(label, commands);
  if (res.ok) {
    useSelectionStore.getState().set([layer]);
    void ensureSubjectTracked(layer, activeSubjectId(layer));
  }
  return res.ok;
}

const hex = (h: string): ReturnType<typeof values.color> => {
  const n = Number.parseInt(h.replace('#', ''), 16);
  return values.color(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

/** Outline / Glow presets (Matte Stroke), the mockup's screen 5. */
export const OUTLINE_PRESETS = {
  neon: { label: () => t('workspace.subjects.preset.neon', 'Neon'), params: [
    { path: 'color', value: hex('#ffe14d') }, { path: 'width', value: values.scalar(8) }, { path: 'softness', value: values.scalar(1) },
    { path: 'glowAmount', value: values.scalar(60) }, { path: 'glowRadius', value: values.scalar(24) },
  ] },
  comic: { label: () => t('workspace.subjects.preset.comic', 'Comic outline'), params: [
    { path: 'color', value: hex('#ffffff') }, { path: 'width', value: values.scalar(10) },
  ] },
  dashes: { label: () => t('workspace.subjects.preset.dashes', 'Marching dashes'), params: [
    { path: 'color', value: hex('#ffffff') }, { path: 'width', value: values.scalar(4) }, { path: 'dashed', value: values.bool(true) },
  ] },
  halo: { label: () => t('workspace.subjects.preset.halo', 'Soft halo'), params: [
    { path: 'color', value: hex('#bfe3ff') }, { path: 'width', value: values.scalar(2) }, { path: 'softness', value: values.scalar(6) },
    { path: 'glowAmount', value: values.scalar(80) }, { path: 'glowRadius', value: values.scalar(40) },
  ] },
} as const satisfies Record<string, { label: () => string; params: PropertyInit[] }>;

/** Selective Color (AI) looks, screen 6. */
export const COLOR_LOOKS = {
  pop: { label: () => t('workspace.subjects.look.pop', 'Colour pop'), params: [
    { path: 'applyTo', value: values.choice('Outside Matte') }, { path: 'saturation', value: values.scalar(-100) }, { path: 'lightness', value: values.scalar(-25) }, { path: 'matteFeather', value: values.scalar(4) },
  ] },
  warm: { label: () => t('workspace.subjects.look.warm', 'Warm subject'), params: [
    { path: 'applyTo', value: values.choice('Inside Matte') }, { path: 'colorize', value: values.bool(true) }, { path: 'colorizeColor', value: hex('#ff9a3c') }, { path: 'colorizeAmount', value: values.scalar(35) },
  ] },
  teal: { label: () => t('workspace.subjects.look.teal', 'Teal background'), params: [
    { path: 'applyTo', value: values.choice('Outside Matte') }, { path: 'colorize', value: values.bool(true) }, { path: 'colorizeColor', value: hex('#1f8a8a') }, { path: 'colorizeAmount', value: values.scalar(60) },
  ] },
  spotlight: { label: () => t('workspace.subjects.look.spotlight', 'Spotlight'), params: [
    { path: 'applyTo', value: values.choice('Outside Matte') }, { path: 'lightness', value: values.scalar(-60) }, { path: 'matteFeather', value: values.scalar(24) },
  ] },
} as const satisfies Record<string, { label: () => string; params: PropertyInit[] }>;

export function outlineSubject(layer: string, preset: keyof typeof OUTLINE_PRESETS = 'neon'): Promise<boolean> {
  return addEffect(layer, t('workspace.subjects.outlineLabel', 'Outline Subject'), 'matte-stroke', [...OUTLINE_PRESETS[preset].params]);
}

export function colorSubject(layer: string, look: keyof typeof COLOR_LOOKS): Promise<boolean> {
  return addEffect(layer, t('workspace.subjects.colorLabel', 'Color Subject'), 'selective-color-ai', [...COLOR_LOOKS[look].params]);
}

/** Portrait-style depth: a Gaussian Blur that Applies To the background — one video, the subject stays sharp. */
export async function blurBackground(layer: string): Promise<boolean> {
  const ok = await addEffect(layer, t('workspace.subjects.blurLabel', 'Blur Background'), 'gaussian-blur', [{ path: 'blurriness', value: values.scalar(24) }], 'background');
  if (ok) notify(t('workspace.subjects.blurDone', 'Background blurred behind the subject.'));
  return ok;
}

/** Remove Background: the subject's Object Matte effect on (the layer is cut to the subject) or off. */
async function toggleRemoveBackground(layer: string, cuts: boolean): Promise<void> {
  const label = cuts ? t('workspace.subjects.keepBackground', 'Keep Background') : t('workspace.subjects.removeBackground', 'Remove Background');
  const card = objectMatteCard(layer);
  if (card) {
    await edit(label, { type: 'setGroupEnabled', groups: [{ layer, path: `effects/${card.id}` }], enabled: !cuts });
    return;
  }
  // A layer selected with the old tool: its cut masks Add ⇄ None.
  const masks = mirrorMaskHeaders(documentMirror().tree(layer)).filter((x) => x.name === ROTO_PATH_NAME || x.name === 'Roto Brush (Frozen)');
  if (masks.length === 0) return;
  await edit(label, masks.map((x) => ({ type: 'setProperty' as const, prop: { layer, path: `masks/${x.id}/mode` }, value: values.choice(cuts ? 'none' : 'add') })));
}

export interface SubjectActionHooks {
  /** Text Behind opens its popover (TextBehindDialog); the caller owns where it shows. */
  openTextBehind: (layer: string) => void;
}

export function subjectActions(layer: string, state: SubjectState, hooks: SubjectActionHooks): SubjectAction[] {
  const needs = !state.selected;
  return [
    { id: 'select', label: t('workspace.subjects.action.select', 'Select Subject…'), description: t('workspace.subjects.action.selectDesc', 'Hover the person and click'),
      run: () => {
        useSelectionStore.getState().set([layer]);
        useUIStore.getState().setActiveTool('object-matte');
      } },
    { id: 'follow', label: t('workspace.subjects.action.follow', 'Follow Through Shot'), description: t('workspace.subjects.action.followDesc', 'Carry the selection to every frame'),
      disabled: needs, run: () => { void followSubject(layer); } },
    { id: 'newLayer', label: t('workspace.subjects.action.separate', 'Separate Subject'), description: t('workspace.subjects.action.separateDesc', 'Its own layer, to move or resize it alone — keeps its tracking and styles'),
      disabled: needs, run: () => { void newLayerFromSubject(layer); } },
    { id: 'textBehind', label: t('workspace.subjects.action.textBehind', 'Text Behind'), description: t('workspace.subjects.action.textBehindDesc', 'Selected text goes behind the person'),
      disabled: needs, run: () => hooks.openTextBehind(layer) },
    { id: 'outline', label: t('workspace.subjects.action.outline', 'Outline / Glow'), description: t('workspace.subjects.action.outlineDesc', 'Border that follows them'),
      disabled: needs, run: () => { void outlineSubject(layer); } },
    { id: 'colorSubject', label: t('workspace.subjects.action.colorSubject', 'Color Subject'), description: t('workspace.subjects.action.colorSubjectDesc', 'Tint, hue, saturation'),
      disabled: needs, run: () => { void colorSubject(layer, 'warm'); } },
    { id: 'colorBackground', label: t('workspace.subjects.action.colorBackground', 'Color Background'), description: t('workspace.subjects.action.colorBackgroundDesc', 'Everything except them'),
      disabled: needs, run: () => { void colorSubject(layer, 'pop'); } },
    { id: 'blurBackground', label: t('workspace.subjects.action.blurBackground', 'Blur Background'), description: t('workspace.subjects.action.blurBackgroundDesc', 'Portrait-style depth'),
      disabled: needs, run: () => { void blurBackground(layer); } },
    { id: 'removeBackground', label: state.cuts ? t('workspace.subjects.action.keepBackground', 'Keep Background') : t('workspace.subjects.action.removeBackground', 'Remove Background'),
      description: state.cuts ? t('workspace.subjects.action.keepBackgroundDesc', 'Show the whole picture again') : t('workspace.subjects.action.removeBackgroundDesc', 'Keep only the person'),
      disabled: needs, run: () => { void toggleRemoveBackground(layer, state.cuts); } },
    { id: 'removeFromShot', label: t('workspace.subjects.action.removeFromShot', 'Remove from Shot'),
      description: t('workspace.subjects.action.removeFromShotDesc', 'Rebuild the background where it was (Content-Aware Fill)'),
      disabled: needs, run: () => { void fillSubjectGap(layer, activeSubjectId(layer)); } },
    { id: 'trackNull', label: t('workspace.subjects.action.trackNull', 'Track with Null'), description: t('workspace.subjects.action.trackNullDesc', 'Stickers follow the person'),
      disabled: !state.followed, run: () => { void runCreateSubjectTrack(layer); } },
    { id: 'freeze', label: state.frozen ? t('workspace.subjects.action.unfreeze', 'Unfreeze') : t('workspace.subjects.action.freeze', 'Freeze'),
      description: state.frozen ? t('workspace.subjects.action.unfreezeDesc', 'Let the matte change again') : t('workspace.subjects.action.freezeDesc', 'Lock the matte'),
      disabled: needs, run: () => {
        const e = rotoFreezeEdit(layer, !state.frozen);
        if (e.commands.length) void edit(e.label, e.commands);
      } },
  ];
}
