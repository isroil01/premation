/**
 * New Layer from Subject — Photoshop's Layer via Copy (Ctrl+J) for a subject
 * cut out of footage: a new layer, directly above, that is ONLY the subject.
 *
 * After Effects has no such command; its tutorials Duplicate (Ctrl+D), which
 * carries every effect, style and mask of the original onto the cut-out, then
 * pan the anchor by hand. Here, as ONE undo entry:
 *
 *   1. duplicate the layer (the copy lands directly above it; the original is
 *      left exactly as it was)
 *   2. the copy keeps what defines the subject — its Object Matte card (on,
 *      not inverted), its Roto Brush / Object Matte outlines and any mask that
 *      cuts — and what makes it look as it does in the shot (colour correction
 *      and keying effects); it loses every other effect, every layer style and
 *      the masks that cut nothing (path-effect geometry), so the original's
 *      blur, glow, stroke, border or shadow do not come along
 *   3. a Roto Brush selection that was only shown (mode None) cuts on the copy
 *   4. the anchor goes to the centre of the subject (the engine's visible box)
 *      with Position compensated, unless Anchor or Position are keyframed —
 *      then the copy keeps the original's placement exactly
 *
 * The engine's selection box and click selection follow what the copy shows
 * (layer_geometry.cpp visible_geometry_at), so the copy handles as the subject.
 */

import type { Command } from '@motion/engine-api';
import { engine, engineIdle } from '@core/engine/engineInstance';
import { reportEngineError } from '@core/engine/uiEdits';
import { compTime, paths } from '@core/engine/propRefs';
import { mirrorEffectHeaders, mirrorEffects, mirrorMaskHeaders } from '@core/mirror/effects';
import { layerSubjects, subjectOutlines } from '@core/workspace/subjects';
import { ROTO_FROZEN_NAME, ROTO_PATH_NAME } from '@core/workspace/rotoBrushTool';
import { OBJECT_MATTE_EFFECT } from '@core/workspace/objectMatteEffect';
import { effectCategoryOf } from '@layout/Effects/effectCategory';
import { documentMirror } from '@stores/documentMirror';
import { trackValuesAt } from '@stores/trackValues';
import { t } from '@core/i18n';
import { centredAnchor } from '@layout/Menu/appEdits';
import { trackRef, valueCommands } from '@layout/Inspector/inspectorEdits';

/** The masks the Object Matte / Roto Brush tools write: the subject's outline. */
const SUBJECT_MASK_NAMES: ReadonlySet<string> = new Set([ROTO_PATH_NAME, ROTO_FROZEN_NAME, 'Object Matte']);

/** Effect folders the copy keeps: the grade and the key, without which the subject would not match its shot. */
const KEPT_CATEGORIES: ReadonlySet<string> = new Set(['Color Correction', 'Keying']);

/** What defines a layer's subject, read from its property tree. */
export interface SubjectParts {
  /** The Object Matte card (the stored cut-out), when the layer has one. */
  card: { id: string; enabled: boolean } | null;
  /** Masks that make up the subject: the tools' outlines and every mask that cuts. */
  keepMasks: string[];
  /** Colour correction and keying: they are how the subject LOOKS in the shot, so the copy matches it. */
  keepEffects: string[];
  /** Roto Brush outlines shown but not cutting (mode None): they cut on the copy. */
  rotoToCut: string[];
  /** Masks that cut nothing and outline nothing: geometry for path effects. */
  dropMasks: string[];
  /** Every other effect: blur, glow, stroke, distortion — what the copy must not inherit. */
  dropEffects: string[];
  /** Every layer style. */
  dropStyles: string[];
}

type TreeLike = Parameters<typeof mirrorMaskHeaders>[0];

/** Pure: the parts of a layer's tree (tested without an engine). */
export function subjectPartsOf(tree: TreeLike): SubjectParts {
  const parts: SubjectParts = { card: null, keepMasks: [], keepEffects: [], rotoToCut: [], dropMasks: [], dropEffects: [], dropStyles: [] };
  for (const e of mirrorEffectHeaders(tree)) {
    if (e.type === OBJECT_MATTE_EFFECT && !parts.card) parts.card = { id: e.id, enabled: e.enabled };
    else if (KEPT_CATEGORIES.has(effectCategoryOf({ type: e.type }) ?? '')) parts.keepEffects.push(e.id);
    else parts.dropEffects.push(e.id);
  }
  for (const m of mirrorMaskHeaders(tree)) {
    const mode = tree?.nodes.get(`masks/${m.id}/mode`)?.value;
    const none = mode?.kind === 'choice' && mode.value === 'none';
    if (SUBJECT_MASK_NAMES.has(m.name)) {
      parts.keepMasks.push(m.id);
      if (none && m.name !== 'Object Matte' && !parts.card) parts.rotoToCut.push(m.id);
    } else if (none) {
      parts.dropMasks.push(m.id);
    } else {
      parts.keepMasks.push(m.id);
    }
  }
  for (const path of tree?.nodes.get('styles')?.children ?? []) parts.dropStyles.push(path.slice('styles/'.length));
  return parts;
}

/** Whether the parts describe a subject at all: a card, or a mask that cuts or will. */
export function hasSubject(parts: SubjectParts, tree: TreeLike): boolean {
  if (parts.card) return true;
  if (parts.rotoToCut.length > 0) return true;
  return parts.keepMasks.some((id) => {
    const mode = tree?.nodes.get(`masks/${id}/mode`)?.value;
    return !(mode?.kind === 'choice' && mode.value === 'none');
  });
}

export type NewLayerFromSubjectResult =
  | { ok: true; layer: string }
  | { ok: false; reason: 'noLayer' | 'noSubject' | 'engine'; message: string };

/** The commands that turn the duplicate into the subject alone. */
function cleanupCommands(copy: string, parts: SubjectParts, sourceName: string): Command[] {
  const cmds: Command[] = [{ type: 'renameLayer', layer: copy, name: t('workspace.subjects.copyName', '{name} (subject)', { name: sourceName || 'Footage' }) }];
  const groups = [
    ...parts.dropEffects.map((id) => ({ layer: copy, path: paths.effectGroup(id) })),
    ...parts.dropStyles.map((k) => ({ layer: copy, path: paths.styleGroup(k) })),
    ...parts.dropMasks.map((id) => ({ layer: copy, path: paths.maskGroup(id) })),
  ];
  if (groups.length > 0) cmds.push({ type: 'removePropertyGroups', groups });
  if (parts.card) {
    if (!parts.card.enabled) cmds.push({ type: 'setGroupEnabled', groups: [{ layer: copy, path: paths.effectGroup(parts.card.id) }], enabled: true });
    cmds.push({ type: 'setProperty', prop: { layer: copy, path: paths.effectParam(parts.card.id, 'invert') }, value: { kind: 'bool', value: false } });
  }
  for (const id of parts.rotoToCut) {
    cmds.push({ type: 'setProperty', prop: { layer: copy, path: paths.mask(id, 'mode') }, value: { kind: 'choice', value: 'add' } });
  }
  return cmds;
}

/** Anchor on the subject's centre (Position compensated), or nothing when the placement is keyframed. */
async function anchorCommands(copy: string, seconds: number): Promise<Command[]> {
  const m = documentMirror();
  const keyed = ['anchorX', 'anchorY', 'x', 'y', 'scaleX', 'scaleY', 'rotation'].some((track) => {
    const ref = trackRef(copy, track);
    return ref ? m.keyframes(copy, ref.ref.path).length > 0 : false;
  });
  if (keyed) return [];
  const res = await engine().query({ type: 'getLayerBounds', layers: [copy], time: compTime(seconds), space: 'layer', includeEffects: false });
  const b = res.ok ? res.value.bounds[0]?.bounds : undefined;
  if (!b) return [];
  const [anchorX = 0, anchorY = 0, x = 0, y = 0, scaleX = 1, scaleY = 1, rotation = 0] =
    await trackValuesAt(copy, ['anchorX', 'anchorY', 'x', 'y', 'scaleX', 'scaleY', 'rotation'], seconds);
  const values = centredAnchor({ x: b.x + b.width / 2, y: b.y + b.height / 2 }, { anchorX, anchorY, x, y, scaleX, scaleY, rotation });
  return values ? valueCommands([{ nodeId: copy, values }], { seconds, autoKeyframe: false }) : [];
}

/**
 * Make the subject's own layer from `layer` (one undo entry). Resolves the new
 * layer's id, or why nothing was made (engine refusals are already reported).
 */
/**
 * The effects that style `subject` on `layer` (they travel with it to its own
 * layer): with several subjects, those reading it alone (compositing/subjectId);
 * with one, every effect Applied To the subject or its background and the
 * subject-reading ones (Matte Stroke, Selective Color AI). Never the card.
 */
export function subjectStyleIds(layer: string, subject: string | null): string[] {
  const all = mirrorEffects(documentMirror().tree(layer));
  const many = layerSubjects(layer).length > 1;
  return all
    .filter((e) => e.type !== OBJECT_MATTE_EFFECT)
    .filter((e) => (many && subject
      ? e.subjectId === subject
      : !!e.subjectScope || e.type === 'matte-stroke' || e.type === 'selective-color-ai' || (subject !== null && e.subjectId === subject)))
    .map((e) => e.id);
}

export async function newLayerFromSubjectEdit(layer: string, seconds: number, subject: string | null = null): Promise<NewLayerFromSubjectResult> {
  const m = documentMirror();
  const src = m.layer(layer);
  if (!src) return { ok: false, reason: 'noLayer', message: t('workspace.subjects.newLayerNoLayer', 'Select the layer the subject is on.') };
  await m.loadTrees([layer]);
  const parts = subjectPartsOf(m.tree(layer));
  // Separating one of several subjects: the copy keeps that one; its styles move with it.
  const subjects = layerSubjects(layer);
  const lifted = subject ? subjects.find((s) => s.id === subject) ?? null : subjects.length === 1 ? subjects[0]! : null;
  const movedStyles = lifted ? subjectStyleIds(layer, lifted.id) : [];
  if (!hasSubject(parts, m.tree(layer))) {
    return { ok: false, reason: 'noSubject', message: t('workspace.subjects.newLayerNeedsSubject', 'Select the subject first: Object Matte, Roto Brush or a mask.') };
  }
  const label = t('workspace.subjects.newLayerLabel', 'New Layer from Subject');
  const client = engine();
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return { ok: false, reason: 'engine', message: opened.error.message };
  }
  let ok = false;
  let copy: string | null = null;
  try {
    const dup = await client.execute({ type: 'duplicateLayers', layers: [layer] });
    if (!dup.ok) {
      reportEngineError(label, dup.error);
      return { ok: false, reason: 'engine', message: dup.error.message };
    }
    copy = (dup.value as { layers?: string[] }).layers?.[0] ?? null;
    if (!copy) return { ok: false, reason: 'engine', message: label };
    await engineIdle();
    // The copy's own ids (a duplicate may re-id its groups): read from its tree, not the original's.
    await m.loadTrees([copy]);
    const copyParts = subjectPartsOf(m.tree(copy));
    // The copy's own ids for the subject's styles (a duplicate may re-id its groups): kept, not dropped.
    const copyStyles = new Set(lifted ? subjectStyleIds(copy, lifted.id) : []);
    copyParts.dropEffects = copyParts.dropEffects.filter((id) => !copyStyles.has(id));
    const cmds = cleanupCommands(copy, copyParts, lifted && subjects.length > 1 ? lifted.name : src.name);
    if (lifted && subjects.length > 1) {
      // The other subjects leave the copy: their frames and their outlines (their styles were dropped above).
      const outlines = subjectOutlines(copy);
      const otherMasks: Array<{ layer: string; path: string }> = [];
      for (const s of subjects) {
        if (s.id === lifted.id) continue;
        cmds.push({ type: 'setLayerMatte', layer: copy, frames: [], merge: false, subject: s.id });
        const mask = outlines.get(s.id);
        if (mask) otherMasks.push({ layer: copy, path: paths.maskGroup(mask) });
      }
      if (otherMasks.length > 0) cmds.push({ type: 'removePropertyGroups', groups: otherMasks });
    }
    // The original no longer draws the subject's styles: they are on the copy now.
    if (movedStyles.length > 0) cmds.push({ type: 'removePropertyGroups', groups: movedStyles.map((id) => ({ layer, path: paths.effectGroup(id) })) });
    const res = await client.batch(label, cmds);
    if (!res.ok) {
      reportEngineError(label, res.error);
      return { ok: false, reason: 'engine', message: res.error.message };
    }
    await engineIdle();
    const anchor = await anchorCommands(copy, seconds);
    if (anchor.length > 0) {
      const moved = await client.batch(label, anchor);
      if (!moved.ok) {
        reportEngineError(label, moved.error);
        return { ok: false, reason: 'engine', message: moved.error.message };
      }
    }
    ok = true;
  } finally {
    const closed = await client.endGesture(opened.value.gesture, ok);
    if (!closed.ok) reportEngineError(label, closed.error);
  }
  return ok && copy ? { ok: true, layer: copy } : { ok: false, reason: 'engine', message: label };
}
