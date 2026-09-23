/**
 * textEdits — the text area's writes over the engine API (B3,
 * docs/B3_PATTERNS.md): the Character / Paragraph panels, text animators and
 * their selectors, Source Text, Path Options, variable axes, text presets.
 *
 *   useTextParam           one keyframeable number of ONE text layer (an
 *                          animator property, a selector parameter, a Path
 *                          Options value, a font axis, Grouping Alignment):
 *                          display value, a write that keys it when animated
 *                          (AE setValueAtTime), the stopwatch, and the scrub
 *                          gesture — one undo entry per drag
 *   sourceTextCommand      Source Text at the playhead (keyed when animated)
 *   add/remove/enable …    text animator and selector groups by their ids
 *                          (`text/animators/<id>`, `…/selectors/<id>`)
 *   typewriterEdit         the Auto-Animate Typing rig as ONE entry
 *   textPresetEdit         a text style preset over the selection, one entry
 *
 * Reads stay direct (B4's mirror replaces them). What the API cannot address
 * yet funnels through the `legacy*` functions at the bottom, each marked with
 * its gap, so the remaining direct writes of this area live in few places.
 */

import type { Command, PropRef, Value } from '@motion/engine-api';
import { catalogFor } from '@core/engine/props';
import { parseColorChannels } from '@core/effects/effects';
import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { isLayer } from '@core/engine/doc';
import { engine } from '@core/engine/engineInstance';
import { compTime, paths, values as apiValues, fieldValue } from '@core/engine/propRefs';
import { edit, reportEngineError } from '@core/engine/uiEdits';
import { readPropertyValue } from '@core/inspector/multiSelection';
import { applyTextPreset } from '@core/inspector/sectionPresets';
import { readAnimatorData, type SelectorKind } from '@core/text/textAnimators';
import { readRuns } from '@core/text/richText';
import { readNodeKind } from '@core/scene/sceneDerive';
import { remapRunFonts } from '@core/fonts/replaceFonts';
import { familyKey } from '@core/fonts/missingFonts';
import { textLayersInScope, countInLayer, type FindScope, type ScopeCount } from '@core/textTools/textFindReplace';
import { replaceAllInString, replaceAllWithRuns, type FindOptions } from '@core/textTools/findReplaceText';
import type { SceneNode } from '@core/types';
import type { PresetValues } from '@stores/sectionPresetStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { getTime } from '@stores/playbackClockStore';
import { componentPropsCommands } from '@layout/Inspector/useComponentProp';
import { scalarValueCommands, stopwatchCommands, trackRef } from '@layout/Inspector/inspectorEdits';
import { useEngineEdit } from '@layout/Inspector/useEngineEdit';

// ── One keyframeable number ─────────────────────────────────────────────

export interface TextParam {
  animated: boolean;
  /** The value at the playhead. */
  display: number;
  /** Write a value (a key at the playhead when animated). */
  onChange: (v: number) => void;
  /** The stopwatch. */
  toggle: () => void;
  /** ValueField scrub props: a drag is one gesture (engine route only). */
  scrub: { onScrubStart: () => void; onScrubEnd: () => void };
}

/**
 * One keyframeable number of a text layer, by its track name (`ta.0.opacity`,
 * `ta.0.s1.amount`, `text.path.firstMargin`, `text.axis.GRAD`, …).
 *
 * The engine addresses the track when the layer's catalog lists it — every
 * animator property / selector parameter row the timeline shows, Path Options
 * while the layer rides a mask, every font axis (wght / wdth / slnt included,
 * G1), an animator's Blur Y before it was ever written. `customStatic`
 * overrides the static write for a caller that stores the value elsewhere.
 */
export function useTextParam(
  nodeId: string,
  track: string,
  label: string,
  staticValue: number,
  customStatic?: (v: number) => void,
): TextParam {
  const time = useActiveWorkspace()?.time ?? 0;
  const e = useEngineEdit();
  const animated = defaultAnimation.isAnimated(nodeId, track);
  const display = readPropertyValue(nodeId, track, time, { read: () => staticValue }) ?? staticValue;
  const onEngine = (): boolean => trackRef(nodeId, track) !== null && (animated || !customStatic);
  return {
    animated,
    display,
    onChange: (v) => {
      if (!Number.isFinite(v)) return;
      if (!animated && customStatic) customStatic(v);
      else if (trackRef(nodeId, track)) e.send(`Set ${label}`, scalarValueCommands(track, [{ nodeId, value: v }], { seconds: time }));
    },
    toggle: () => {
      const r = trackRef(nodeId, track);
      const cmds = r?.animatable ? stopwatchCommands([nodeId], [track], time) : [];
      if (cmds.length > 0) e.send(animated ? `Remove ${label} animation` : `Animate ${label}`, cmds);
    },
    scrub: e.scrub(`Set ${label}`, onEngine),
  };
}

// ── Source Text ─────────────────────────────────────────────────────────

/** The layer's style runs index its text: a content change through the API would drop them. */
export function hasStyleRuns(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  return !!node && readRuns(node).length > 0;
}

/**
 * The layer's current style runs, re-sent after a Source Text write — the
 * API's static Source Text drops runs that indexed the old text; the editor
 * keeps them (G1 `text/styleRuns`).
 */
function keepRunsCommands(nodeId: string): Command[] {
  const node = defaultSceneGraph.getNode(nodeId);
  return node && readRuns(node).length > 0 ? fieldCommands(nodeId, paths.textProp('styleRuns'), readRuns(node)) : [];
}

/**
 * Source Text := `text` at comp time `seconds` — a key there when Source Text
 * is animated (AE setValueAtTime), else the static text (keeping the layer's
 * style runs). Null when the node is not a layer.
 */
export function sourceTextCommand(nodeId: string, text: string, seconds: number): Command[] | null {
  if (!isLayer(nodeId)) return null;
  const keyed = defaultAnimation.isDataAnimated(nodeId, 'text.source');
  const set: Command = { type: 'setProperty', prop: { layer: nodeId, path: paths.sourceText() }, value: apiValues.string(text), time: compTime(seconds) };
  return keyed ? [set] : [set, ...keepRunsCommands(nodeId)];
}

/** The Source Text stopwatch (AE: on = a key at the playhead; off = static at the playhead's value, style runs kept). */
export function sourceTextStopwatchCommand(nodeId: string, animated: boolean, seconds: number): Command[] | null {
  if (!isLayer(nodeId)) return null;
  const cmd: Command = { type: 'setAnimated', prop: { layer: nodeId, path: paths.sourceText() }, animated, time: compTime(seconds) };
  return animated ? [cmd] : [cmd, ...keepRunsCommands(nodeId)];
}

// ── Animators and selectors (groups, addressed by id) ───────────────────

const SELECTOR_MATCH_NAMES: Record<SelectorKind, string> = {
  range: 'ADBE Text Selector',
  wiggly: 'ADBE Text Wiggly Selector',
  expression: 'ADBE Text Expressible Selector',
};

function animatorRef(nodeId: string, animatorId: string): PropRef {
  return { layer: nodeId, path: paths.animatorGroup(animatorId) };
}

function selectorRef(nodeId: string, animatorId: string, selectorId: string): PropRef {
  return { layer: nodeId, path: paths.selectorGroup(animatorId, selectorId) };
}

/** Animate ▸ (Add): a fresh animator at the end of the stack. */
export function addAnimatorEdit(nodeId: string): Promise<unknown> {
  return edit('Add Text Animator', {
    type: 'addPropertyGroup', layer: nodeId, parent: paths.animatorsGroup(), matchName: 'ADBE Text Animator', init: [],
  });
}

export function removeAnimatorEdit(nodeId: string, animatorId: string): Promise<unknown> {
  return edit('Remove Text Animator', { type: 'removePropertyGroups', groups: [animatorRef(nodeId, animatorId)] });
}

export function setAnimatorEnabledEdit(nodeId: string, animatorId: string, enabled: boolean): Promise<unknown> {
  return edit(enabled ? 'Enable Animator' : 'Disable Animator', { type: 'setGroupEnabled', groups: [animatorRef(nodeId, animatorId)], enabled });
}

/** Add ▸ Selector ▸ <kind>: appended to the animator's stack. */
export function addSelectorEdit(nodeId: string, animatorId: string, kind: SelectorKind): Promise<unknown> {
  return edit('Add Selector', {
    type: 'addPropertyGroup', layer: nodeId, parent: `${paths.animatorGroup(animatorId)}/selectors`, matchName: SELECTOR_MATCH_NAMES[kind], init: [],
  });
}

export function removeSelectorEdit(nodeId: string, animatorId: string, selectorId: string): Promise<unknown> {
  return edit('Remove Selector', { type: 'removePropertyGroups', groups: [selectorRef(nodeId, animatorId, selectorId)] });
}

export function setSelectorEnabledEdit(nodeId: string, animatorId: string, selectorId: string, enabled: boolean): Promise<unknown> {
  return edit(enabled ? 'Enable Selector' : 'Disable Selector', { type: 'setGroupEnabled', groups: [selectorRef(nodeId, animatorId, selectorId)], enabled });
}

/**
 * Auto-Animate Typing — `applyTypewriter`'s rig as ONE entry: a new animator
 * with Opacity 0, its range selector hard-edged (Smoothness 0), and Start keyed
 * 0 → 100 % over `durationSec` from comp time `seconds`, linear. The selector's
 * id is minted by the engine, so the add and the rest run inside one gesture.
 */
export async function typewriterEdit(nodeId: string, seconds: number, durationSec = 1.5): Promise<boolean> {
  if (!isLayer(nodeId)) return false;
  const label = 'Typewriter';
  const client = engine();
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return false;
  }
  let ok = false;
  const added = await client.execute({
    type: 'addPropertyGroup', layer: nodeId, parent: paths.animatorsGroup(), matchName: 'ADBE Text Animator',
    init: [{ path: 'props/opacity', value: apiValues.scalar(0) }],
  });
  if (!added.ok) reportEngineError(label, added.error);
  else {
    const animatorId = ((added.value as { groups?: string[] }).groups?.[0] ?? '').split('/')[2] ?? '';
    const node = defaultSceneGraph.getNode(nodeId);
    const selectorId = node ? readAnimatorData(node).find((a) => a.id === animatorId)?.selectors?.[0]?.id : undefined;
    if (selectorId) {
      const start: PropRef = { layer: nodeId, path: paths.selectorParam(animatorId, selectorId, 'start') };
      const res = await client.batch(label, [
        { type: 'setProperty', prop: { layer: nodeId, path: paths.selectorParam(animatorId, selectorId, 'smoothness') }, value: apiValues.scalar(0) },
        {
          type: 'addKeyframes',
          keys: [
            { prop: start, time: compTime(seconds), value: apiValues.scalar(0), easing: 'linear', spatialIn: [], spatialOut: [] },
            { prop: start, time: compTime(seconds + durationSec), value: apiValues.scalar(100), easing: 'linear', spatialIn: [], spatialOut: [] },
          ],
        },
      ]);
      if (!res.ok) reportEngineError(label, res.error);
      else ok = true;
    }
  }
  const closed = await client.endGesture(opened.value.gesture, ok);
  if (!closed.ok) reportEngineError(label, closed.error);
  return ok;
}

// ── Static fields and optional properties (G1) ──────────────────────────

/**
 * The commands for "field `path` := `raw`" on a layer (a text / animator /
 * selector field, Path Options ▸ Path, style runs), or [] when the layer has
 * no such field or the value cannot be one. `raw` is what the UI holds (a
 * string, a boolean, a number, a hex, undefined = the default).
 */
export function fieldCommands(nodeId: string, path: string, raw: unknown): Command[] {
  if (!isLayer(nodeId)) return [];
  const b = catalogFor(nodeId).byPath.get(path);
  const value = b ? fieldValue(b, raw) : null;
  return value ? [{ type: 'setProperty', prop: { layer: nodeId, path }, value }] : [];
}

/** One field write = one undo entry. */
export function fieldEdit(label: string, nodeId: string, path: string, raw: unknown): Promise<unknown> {
  return edit(label, fieldCommands(nodeId, path, raw));
}

/** Several fields of one selector as ONE entry (Selector / Based On / Mode / Units / Shape / …). */
export function selectorFieldsEdit(nodeId: string, animatorId: string, selectorId: string, patch: Readonly<Record<string, unknown>>): Promise<unknown> {
  const base = paths.selectorGroup(animatorId, selectorId);
  const cmds = Object.entries(patch).flatMap(([k, v]) => fieldCommands(nodeId, `${base}/${k}`, k === 'randomSeed' && typeof v === 'number' ? Math.round(v) : v));
  const key = Object.keys(patch)[0] ?? '';
  return edit(key === 'kind' ? 'Change Selector' : 'Set Selector Option', cmds);
}

/** AE's Add ▸ Property (optional properties, `axis<TAG>` font axes, Fill / Stroke Color). Resolves false when refused. */
export async function addAnimatorPropertiesEdit(nodeId: string, animatorId: string, names: ReadonlyArray<string>, init: Command[] = []): Promise<boolean> {
  const res = await edit(names.length === 1 ? 'Add Property' : 'Add Properties', [
    { type: 'addProperties', parent: { layer: nodeId, path: `${paths.animatorGroup(animatorId)}/props` }, names: [...names] },
    ...init,
  ], { quiet: true });
  return res.ok;
}

/** Delete an optional animator property (with its keyframes and expression). */
export function removeAnimatorPropertyEdit(nodeId: string, animatorId: string, name: string): Promise<unknown> {
  return edit('Remove Property', { type: 'removeProperties', props: [{ layer: nodeId, path: paths.animatorProp(animatorId, name) }] });
}

/**
 * An animator's optional Fill / Stroke Color: `hex` sets it (adding the
 * property first when the animator does not have it), undefined removes it.
 */
export function animatorColorEdit(nodeId: string, animatorId: string, key: 'color' | 'strokeColor', hex: string | undefined, present: boolean): Promise<unknown> {
  if (hex === undefined) return present ? removeAnimatorPropertyEdit(nodeId, animatorId, key) : Promise.resolve();
  const set: Command = { type: 'setProperty', prop: { layer: nodeId, path: paths.animatorProp(animatorId, key) }, value: fieldValueOfHex(hex) };
  if (present) return edit(key === 'color' ? 'Set Fill Color' : 'Set Stroke Color', set);
  return addAnimatorPropertiesEdit(nodeId, animatorId, [key], [set]);
}

function fieldValueOfHex(hex: string): Value {
  const [r, g, b, a] = parseColorChannels(hex);
  return apiValues.color(r, g, b, a);
}

// ── Presets ─────────────────────────────────────────────────────────────

/**
 * A text style preset (or a Character panel preset chip) onto every text layer
 * of the selection, ONE entry. Through the engine when it addresses every
 * value on every layer (numbers the catalog lists: Font Size, Tracking…);
 * a preset that also carries a family / weight / style (strings — no API
 * property yet) keeps the pre-API bag writer for the WHOLE preset, so it stays
 * one undo entry instead of splitting in two.
 */
export function textPresetEdit(nodeIds: ReadonlyArray<string>, values: PresetValues, label = 'Apply Text preset'): void {
  const seconds = getTime();
  const cmds: Command[] = [];
  let legacy = false;
  for (const id of nodeIds) {
    const comp = defaultSceneGraph.getNode(id)?.components.find((c) => c.type === 'Text');
    if (!comp) continue;
    const r = componentPropsCommands(id, comp.id, values, seconds);
    if (Object.keys(r.rest).length > 0) { legacy = true; break; }
    cmds.push(...r.cmds);
  }
  if (legacy) {
    legacyTextPreset(nodeIds, values);
    return;
  }
  void edit(label, cmds);
}


// ── Document-wide text macros (client macros over the API, ONE entry each) ──

/**
 * Replace Fonts: every text layer's family (and its styled runs' families)
 * through `text/fontFamily` + `text/styleRuns` — one undo entry. `replacements`
 * maps a family (any case) → the new family. Resolves the number of layers changed.
 */
export async function replaceFontFamiliesEdit(replacements: ReadonlyMap<string, string>): Promise<number> {
  const map = new Map<string, string>();
  for (const [from, to] of replacements) if (to.trim()) map.set(familyKey(from), to.trim());
  if (map.size === 0) return 0;
  const texts: SceneNode[] = [];
  defaultSceneGraph.traverse((n) => { if (readNodeKind(n) === 'text' && isLayer(n.id)) texts.push(n); });
  const cmds: Command[] = [];
  let layers = 0;
  for (const node of texts) {
    const before = cmds.length;
    const family = (node.components.find((c) => c.type === 'Text')?.props as Record<string, unknown> | undefined)?.fontFamily;
    const next = typeof family === 'string' ? map.get(familyKey(family)) : undefined;
    if (next !== undefined && next !== family) cmds.push(...fieldCommands(node.id, paths.textProp('fontFamily'), next));
    const runs = remapRunFonts(readRuns(node), map);
    if (runs.changed) cmds.push(...fieldCommands(node.id, paths.textProp('styleRuns'), runs.runs));
    if (cmds.length > before) layers += 1;
  }
  if (cmds.length === 0) return 0;
  const res = await edit('Replace Fonts', cmds);
  return res.ok ? layers : 0;
}

/**
 * Find and Replace Text over a scope: static text (its style runs shifted to
 * stay on their characters) and every Source Text keyframe value — one undo
 * entry. Keyed layers are rewritten through their keys (AE: the keys ARE the
 * value); keyframe ids come from the engine.
 */
export async function replaceTextEdit(scope: FindScope, find: string, replacement: string, opts: FindOptions): Promise<ScopeCount> {
  if (!find) return { matches: 0, layers: 0 };
  const targets = textLayersInScope(scope).filter((n) => isLayer(n.id) && countInLayer(n, find, opts) > 0);
  if (targets.length === 0) return { matches: 0, layers: 0 };
  const cmds: Command[] = [];
  let matches = 0;
  for (const node of targets) {
    const ref: PropRef = { layer: node.id, path: paths.sourceText() };
    if (defaultAnimation.isDataAnimated(node.id, 'text.source')) {
      const q = await engine().query({ type: 'getKeyframes', props: [ref] });
      if (!q.ok) continue;
      const patches = (q.value.sets[0]?.keyframes ?? []).flatMap((k) => {
        if (k.value.kind !== 'textDocument') return [];
        const r = replaceAllInString(k.value.value.text, find, replacement, opts);
        if (r.count === 0) return [];
        matches += r.count;
        return [{ id: k.id, value: apiValues.string(r.text), spatialIn: [], spatialOut: [] }];
      });
      if (patches.length > 0) cmds.push({ type: 'updateKeyframes', patches });
      continue;
    }
    const content = (node.components.find((c) => c.type === 'Text')?.props as Record<string, unknown> | undefined)?.content;
    if (typeof content !== 'string') continue;
    const runs = readRuns(node);
    const r = replaceAllWithRuns(content, runs, find, replacement, opts);
    if (r.count === 0) continue;
    matches += r.count;
    cmds.push({ type: 'setProperty', prop: ref, value: apiValues.string(r.text) });
    if (runs.length > 0) cmds.push(...fieldCommands(node.id, paths.textProp('styleRuns'), r.runs));
  }
  if (cmds.length === 0) return { matches: 0, layers: 0 };
  const res = await edit('Replace Text', cmds);
  return res.ok ? { matches, layers: targets.length } : { matches: 0, layers: 0 };
}
// ── Legacy funnels (engine gaps) ────────────────────────────────────────

/** A text preset with values the API cannot address (see `textPresetEdit`). */
function legacyTextPreset(nodeIds: ReadonlyArray<string>, values: PresetValues): void {
  // B3-legacy: engine gap — Text component string props (fontFamily / fontWeight / fontStyle / align …) have no API property; one batchHistory entry.
  applyTextPreset(nodeIds, values);
}
