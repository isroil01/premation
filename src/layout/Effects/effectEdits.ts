/**
 * effectEdits — the Effects area's document edits over the engine API (B3,
 * docs/B3_PATTERNS.md §1/§3/§6/§7). Each exported edit is ONE user action = ONE
 * undo entry; the builders (`…Commands`) compose commands for a caller that
 * sends them itself (inside a scrub gesture, or as one `edit`).
 *
 *   effects       add (browser click / drag / "+" menu / presets), remove,
 *                 enable, reorder (arrows + drag), duplicate, reset, paste
 *   parameters    `effects/<id>/<param>` — numbers and colours through the
 *                 inspector's value builders (keyed at the playhead when
 *                 animated, AE setValueAtTime), dropdowns as `choice` BY LABEL,
 *                 checkboxes `bool`, layer pickers `layer`, curves `json`
 *   masks         add / remove / rename / mode / inverted / feather / opacity /
 *                 expansion / shape stopwatch / per-vertex feather (`masks/<id>/…`)
 *   compositing   effect opacity, effect mask, label (`effects/<id>/compositing/…`)
 *   layer styles  add / remove (`styles/<key>`), numeric + colour params
 *                 (`styles/<key>/<param>`, Glass `styles/glass/<param>`), the
 *                 switches, the composition's Global Light
 *   layer         the fx switch, time stretch / reverse / frame blend, freeze
 *                 frame, Cloner / Physics (`layer/cloner|physics`)
 *
 * Effects are addressed by their stable id, never by stack index. Display
 * reads stay direct (B4's mirror replaces them); this module only reads to
 * decide what to send.
 *
 * The one write the engine cannot say yet (an effect on a node that is not a
 * layer) keeps its pre-API writer, marked `B3-legacy` with the gap.
 */

import type { Command, PropertyInit, PropertyWrite, Value } from '@motion/engine-api';
import { defaultAnimation } from '@motion/animation';
import { edit } from '@core/engine/uiEdits';
import { isLayer } from '@core/engine/doc';
import { maskToBezier } from '@core/engine/props';
import { compTime, paths, ref, values } from '@core/engine/propRefs';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { engine } from '@core/engine/engineInstance';
import { keyframeToCompTime } from '@core/timeline/TimelineController';
import {
  addEffect,
  effectDefFor,
  effectOpacityPath,
  effectPropPath,
  getNodeEffects,
  newInstanceParamsOf,
  paramsOf,
  parseColorChannels,
  type Effect,
  type EffectParamDef,
  type EffectParamValue,
  type EffectType,
} from '@core/effects/effects';
import {
  captureEffect,
  listEffectPresets,
  readEffectClipboard,
  type CopiedEffect,
} from '@core/effects/effectClipboard';
import {
  layerStyleEffectId,
  LAYER_STYLE_COLOR_PARAMS,
  LAYER_STYLE_NUMBER_PARAMS,
  type LayerStyles,
} from '@core/effects/layerStyles';
import { glassPropPath } from '@core/effects/glassResolve';
import { GLASS_PROPERTIES, STYLE_FIELDS } from '@core/engine/effectFieldSpecs';
import type { MaskPath } from '@core/effects/mask';
import type { FrameBlend as StoredFrameBlend } from '@core/scene/layerTime';
import { Color } from '@motion/renderer';
import { useWorkspaceStore } from '@stores/projectStore';
import { documentMirror } from '@stores/documentMirror';
import { getTime } from '@stores/playbackClockStore';
import { scalarValueCommands, stopwatchCommands, trackRef, valueCommands } from '@layout/Inspector/inspectorEdits';

// ── Addressing ─────────────────────────────────────────────────────────

const effectGroup = (nodeId: string, effectId: string) => ref(nodeId, paths.effectGroup(effectId));

/** The layer ids among `ids` (a composition root or a stray node is not addressable). */
function layersOf(ids: ReadonlyArray<string>): string[] {
  return [...new Set(ids)].filter((id) => isLayer(id));
}

// ── Effects: the stack ─────────────────────────────────────────────────

/** Add one effect to every given layer: ONE entry ("Add Gaussian Blur"). */
export async function addEffectEdit(nodeIds: ReadonlyArray<string>, type: EffectType): Promise<string[]> {
  const layers = layersOf(nodeIds);
  const def = effectDefFor(type);
  const strays = [...new Set(nodeIds)].filter((id) => !isLayer(id) && defaultSceneGraph.getNode(id));
  if (def && strays.length > 0) legacyAddEffect(strays, type);
  if (layers.length === 0 || !def) return [];
  const res = await edit(`Add ${def.label}`, { type: 'addEffect', layers, effect: type, params: [] });
  if (!res.ok) return [];
  return (res.value[0] as { groups?: string[] } | undefined)?.groups ?? [];
}

export function removeEffectEdit(nodeId: string, effectId: string, name: string): Promise<unknown> {
  return edit(`Remove ${name}`, { type: 'removePropertyGroups', groups: [effectGroup(nodeId, effectId)] });
}

/** The effect's fx switch (the checkbox in its header). */
export function setEffectEnabledEdit(nodeId: string, effectId: string, enabled: boolean, name: string): Promise<unknown> {
  return edit(`${enabled ? 'Enable' : 'Disable'} ${name}`, {
    type: 'setGroupEnabled', groups: [effectGroup(nodeId, effectId)], enabled,
  });
}

export function duplicateEffectEdit(nodeId: string, effectId: string, name: string): Promise<unknown> {
  return edit(`Duplicate ${name}`, { type: 'duplicatePropertyGroups', groups: [effectGroup(nodeId, effectId)] });
}

/** Move an effect to stack index `toIndex` (its index AFTER the move). No-op when it is already there. */
export async function moveEffectEdit(nodeId: string, effectId: string, toIndex: number): Promise<void> {
  const list = getNodeEffects(nodeId);
  const from = list.findIndex((e) => e.id === effectId);
  if (from < 0 || toIndex < 0 || toIndex >= list.length || toIndex === from) return;
  await edit('Reorder Effects', { type: 'movePropertyGroup', group: effectGroup(nodeId, effectId), toIndex });
}

/** The header's up / down arrows. */
export function nudgeEffectEdit(nodeId: string, effectId: string, dir: -1 | 1): Promise<void> {
  const from = getNodeEffects(nodeId).findIndex((e) => e.id === effectId);
  return moveEffectEdit(nodeId, effectId, from + dir);
}

/**
 * A drag-and-drop reorder: `gap` is the drop indicator's gap in the ORIGINAL
 * list (see `moveEffectTo`), translated to the effect's index after the move.
 */
export function dropEffectEdit(nodeId: string, effectId: string, gap: number): Promise<void> {
  const list = getNodeEffects(nodeId);
  const from = list.findIndex((e) => e.id === effectId);
  const g = Math.max(0, Math.min(gap, list.length));
  // Dropping into the gap just above or below itself is a no-op; removing the
  // dragged effect first shifts every later gap up by one.
  if (from < 0 || g === from || g === from + 1) return Promise.resolve();
  return moveEffectEdit(nodeId, effectId, g > from ? g - 1 : g);
}

// ── Effects: parameters ────────────────────────────────────────────────

/** The track a numeric / colour param is keyed on (`effect.<id>.<key>`); colour = its `_r` member. */
export function paramTrack(effectId: string, param: EffectParamDef): string {
  const base = effectPropPath(effectId, param.key);
  return param.type === 'color' ? `${base}_r` : base;
}

/**
 * The API value of one stored param value, or null when it cannot be said
 * (an enum value that names no option, a malformed colour). `choice` values
 * go BY LABEL (B3_PATTERNS §7).
 */
export function paramValue(nodeId: string | null, effectId: string, param: EffectParamDef, raw: EffectParamValue): Value | null {
  switch (param.type) {
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
      // A `number` param that the catalog lists as a choice (none today) goes by label.
      const r = nodeId ? trackRef(nodeId, effectPropPath(effectId, param.key)) : null;
      if (r?.valueType === 'choice') {
        const opt = param.options?.find((o) => o.value === raw);
        return opt ? values.choice(opt.label) : null;
      }
      return values.scalar(raw);
    }
    case 'enum': {
      const opt = param.options?.find((o) => o.value === Number(raw));
      return opt ? values.choice(opt.label) : null;
    }
    case 'color': {
      if (typeof raw !== 'string' || !/^#?[0-9a-fA-F]{3,8}$/.test(raw.trim())) return null;
      const [r, g, b, a] = parseColorChannels(raw);
      return values.color(r, g, b, a);
    }
    case 'checkbox': return values.bool(raw === true || raw === 1);
    case 'layer': return values.layer(typeof raw === 'string' ? raw : '');
    case 'maskPath': return values.string(typeof raw === 'string' ? raw : '');
    case 'curve': return Array.isArray(raw) ? values.json(raw) : null;
    default: return null;
  }
}

/**
 * "Set this param to `raw`" at comp time `seconds`: numbers and colours key at
 * the playhead when animated (the inspector's value builders — no
 * auto-keyframe, the effect panel never had it, COMPOSITING_PLAN F22); menus,
 * checkboxes, layer / mask pickers and curves are static `setProperty`s.
 * Empty when the engine does not address the param on this layer.
 */
export function paramCommands(
  nodeId: string,
  effectId: string,
  param: EffectParamDef,
  raw: EffectParamValue,
  seconds: number,
): Command[] {
  if (param.type === 'number' && typeof raw === 'number') {
    const track = effectPropPath(effectId, param.key);
    if (trackRef(nodeId, track)?.valueType === 'choice') {
      const v = paramValue(nodeId, effectId, param, raw);
      return v ? [{ type: 'setProperty', prop: ref(nodeId, paths.effectParam(effectId, param.key)), value: v, time: compTime(seconds) }] : [];
    }
    return scalarValueCommands(track, [{ nodeId, value: raw }], { seconds });
  }
  if (param.type === 'color') {
    if (typeof raw !== 'string') return [];
    const [r, g, b, a] = parseColorChannels(raw);
    const base = effectPropPath(effectId, param.key);
    if (trackRef(nodeId, `${base}_r`)?.valueType !== 'color') return [];
    return valueCommands([{ nodeId, values: { [`${base}_r`]: r, [`${base}_g`]: g, [`${base}_b`]: b, [`${base}_a`]: a } }], { seconds });
  }
  const v = paramValue(nodeId, effectId, param, raw);
  if (!v) return [];
  return [{ type: 'setProperty', prop: ref(nodeId, paths.effectParam(effectId, param.key)), value: v, time: compTime(seconds) }];
}

/** The stopwatch of one numeric / colour param. */
export function paramStopwatchCommands(nodeId: string, effectId: string, param: EffectParamDef, seconds: number): Command[] {
  return stopwatchCommands([nodeId], [paramTrack(effectId, param)], seconds);
}

/** True when any member track of the param is keyed. */
function paramAnimated(nodeId: string, effectId: string, param: EffectParamDef): boolean {
  const base = effectPropPath(effectId, param.key);
  if (param.type === 'color') return ['_r', '_g', '_b', '_a'].some((s) => defaultAnimation.isAnimated(nodeId, `${base}${s}`));
  return defaultAnimation.isAnimated(nodeId, base);
}

/**
 * AE's Reset link: every parameter back to its default — ONE entry. Like the
 * pre-API reset it leaves animation alone: a keyed param keeps its keys (the
 * stopwatch is the one thing that deletes them), so only static params are
 * written.
 */
export async function resetEffectEdit(nodeId: string, effectId: string, name: string): Promise<void> {
  const effect = getNodeEffects(nodeId).find((e) => e.id === effectId);
  const def = effect ? effectDefFor(effect.type) : undefined;
  if (!effect || !def) return;
  const defaults = newInstanceParamsOf(def);
  const writes: PropertyWrite[] = [];
  for (const p of def.params) {
    if (p.type === 'resolved' || paramAnimated(nodeId, effectId, p)) continue;
    const raw = defaults[p.key];
    if (raw === undefined) continue;
    const v = paramValue(nodeId, effectId, p, raw);
    if (v) writes.push({ prop: ref(nodeId, paths.effectParam(effectId, p.key)), value: v });
  }
  if (writes.length > 0) await edit(`Reset ${name}`, { type: 'setProperties', writes });
}

// ── Compositing Options › Effect Opacity ───────────────────────────────

/**
 * A value typed / scrubbed into Effect Opacity. On an ANIMATED opacity it is a
 * key at the playhead; a static one is `setEffectOpacityEdit`. Returns the key
 * commands, or null when the opacity is static.
 */
export function effectOpacityCommands(nodeId: string, effectId: string, pct: number, seconds: number): Command[] | null {
  const track = effectOpacityPath(effectId);
  if (!defaultAnimation.isAnimated(nodeId, track) || !trackRef(nodeId, track)) return null;
  return scalarValueCommands(track, [{ nodeId, value: Math.max(0, Math.min(100, pct)) }], { seconds });
}

// ── Copy / paste and effect presets ────────────────────────────────────

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Paste the effect clipboard onto `targets` — ONE entry. When every copied
 * effect is still on its source layer exactly as copied, this is the API's
 * `copyPropertyGroups` (params, keyframes, expressions, fx switch, compositing
 * options, label all come along); a clipboard whose source was since edited
 * or deleted is pasted from its captured snapshot (`pasteEffects`).
 */
export async function pasteEffectsEdit(targets: ReadonlyArray<string>): Promise<void> {
  const layers = layersOf(targets);
  const items = readEffectClipboard();
  if (layers.length === 0 || items.length === 0) return;
  const live = items.every((it) => {
    if (!it.sourceNodeId || !isLayer(it.sourceNodeId)) return false;
    const cur = getNodeEffects(it.sourceNodeId).find((e) => e.id === it.effect.id);
    if (!cur) return false;
    const { sourceNodeId: _src, ...copied } = it;
    return sameJson(captureEffect(it.sourceNodeId, cur), copied);
  });
  if (live) {
    await edit(items.length === 1 ? 'Paste Effect' : 'Paste Effects', {
      type: 'copyPropertyGroups',
      groups: items.map((it) => effectGroup(it.sourceNodeId!, it.effect.id)),
      toLayers: layers,
    });
    return;
  }
  await pasteSnapshotEdit(items.length === 1 ? 'Paste Effect' : 'Paste Effects', items, layers);
}

/**
 * One captured effect as an `addEffect` for `layers`, or null when it carries
 * something `addEffect` cannot set: keyframes, a disabled switch, compositing
 * options, a label colour, a legacy `amount`, a param its definition does not
 * declare, or a value with no API form.
 */
function snapshotAddCommand(item: CopiedEffect, layers: string[]): Command | null {
  const e: Effect = item.effect;
  const def = effectDefFor(e.type);
  if (!def || Object.keys(item.tracks).length > 0) return null;
  if (e.enabled === false || e.opacity !== undefined || e.maskId !== undefined || e.labelColor !== undefined) return null;
  if (typeof e.amount === 'number') return null;
  const declared = new Set(def.params.map((p) => p.key));
  if (Object.keys(e.params ?? {}).some((k) => !declared.has(k))) return null;
  // Every declared param, resolved as the renderer reads the snapshot (its
  // defaults under what it set) — a new instance starts from
  // `newInstanceParams`, which may differ from the defaults a sparse preset
  // relied on.
  const resolved = paramsOf(e);
  const params: PropertyInit[] = [];
  for (const p of def.params) {
    if (p.type === 'resolved') continue;
    const raw = resolved[p.key];
    if (raw === undefined) continue;
    const v = paramValue(null, '', p, raw);
    if (!v) return null;
    params.push({ path: p.key, value: v });
  }
  return { type: 'addEffect', layers, effect: e.type, params };
}

/**
 * Apply a built-in or saved effect preset to `targets`, appending like a
 * paste — ONE entry ("Apply <name>"). A preset of plain effects (every
 * built-in) is `addEffect`s with initial params; one that captured keyframes
 * or instance options is pasted from its snapshot (`pasteEffects`).
 */
export async function applyEffectPresetEdit(name: string, targets: ReadonlyArray<string>): Promise<boolean> {
  const layers = layersOf(targets);
  const preset = listEffectPresets().find((p) => p.name === name);
  if (!preset || layers.length === 0) return false;
  const cmds = preset.items.map((it) => snapshotAddCommand(it, layers));
  if (cmds.every((c): c is Command => c !== null)) {
    const res = await edit(`Apply ${name}`, cmds);
    return res.ok;
  }
  const res = await pasteSnapshotEdit(`Apply ${name}`, preset.items, layers);
  return res.ok;
}

// ── Masks (the Effects panel's mask cards) ─────────────────────────────

const maskGroup = (nodeId: string, maskId: string) => ref(nodeId, paths.maskGroup(maskId));

/** Rectangle / Ellipse: a new mask with this shape and mode. */
export function addMaskEdit(nodeId: string, mask: MaskPath, label: string): Promise<unknown> {
  return edit(label, {
    type: 'addMask', layer: nodeId, path: maskToBezier(mask), mode: mask.mode, inverted: mask.inverted,
    ...(mask.name ? { name: mask.name } : {}),
  });
}

export function removeMaskEdit(nodeId: string, maskId: string, label: string): Promise<unknown> {
  return edit(label, { type: 'removePropertyGroups', groups: [maskGroup(nodeId, maskId)] });
}

/** Mask Mode (not animatable in AE: holds across every shape keyframe). */
export function setMaskModeEdit(nodeId: string, maskId: string, mode: string): Promise<unknown> {
  return edit('Mask Mode', { type: 'setProperty', prop: ref(nodeId, paths.mask(maskId, 'mode')), value: values.choice(mode) });
}

export function setMaskInvertedEdit(nodeId: string, maskId: string, inverted: boolean): Promise<unknown> {
  return edit(inverted ? 'Invert Mask' : 'Uninvert Mask', {
    type: 'setProperty', prop: ref(nodeId, paths.mask(maskId, 'inverted')), value: values.bool(inverted),
  });
}

export function renameMaskEdit(nodeId: string, maskId: string, name: string): Promise<unknown> {
  return edit('Rename Mask', { type: 'renamePropertyGroup', group: maskGroup(nodeId, maskId), name });
}

/**
 * Feather / Opacity (0..100) / Expansion of a mask as commands, or null when
 * the engine does not address the mask. On a keyframed shape the engine holds
 * the value across every shape keyframe (AE: these are not part of the path).
 */
export function maskValueCommands(
  nodeId: string,
  maskId: string,
  key: 'feather' | 'opacity' | 'expansion',
  value: number,
  seconds: number,
): Command[] | null {
  const track = `mask.${maskId}.${key}`;
  if (!trackRef(nodeId, track)) return null;
  return scalarValueCommands(track, [{ nodeId, value }], { seconds });
}

/**
 * "Keyframe shape" / "Un-animate": the Mask Path stopwatch. The layer's mask
 * shapes are keyed together (one snapshot per key), so the first mask's path
 * property stands for all of them.
 */
export function setMaskShapeAnimatedEdit(nodeId: string, firstMaskId: string, animated: boolean, seconds: number): Promise<unknown> {
  return edit(animated ? 'Animate Mask Path' : 'Stop Animating Mask Path', {
    type: 'setAnimated', prop: ref(nodeId, paths.mask(firstMaskId, 'path')), animated, time: compTime(seconds),
  });
}

// ── Layer styles ───────────────────────────────────────────────────────

/** A layer style's checkbox: add it with its defaults, or remove it (with its keyframes). */
export function setLayerStyleOnEdit(nodeId: string, styleKey: keyof LayerStyles, on: boolean, label: string): Promise<unknown> {
  if (on) {
    return edit(`Add ${label}`, { type: 'addPropertyGroup', layer: nodeId, parent: 'styles', matchName: `style:${styleKey}`, init: [] });
  }
  return edit(`Remove ${label}`, { type: 'removePropertyGroups', groups: [ref(nodeId, paths.styleGroup(styleKey))] });
}

/**
 * True when the engine addresses this style track (`effect.layerstyle:<key>.<param>`
 * → `styles/<key>/<param>`, and Glass's `glass.<param>` → `styles/glass/<param>`).
 */
export function styleTrackOnEngine(nodeId: string, track: string | null): boolean {
  if (!track || !(track.startsWith('effect.layerstyle:') || track.startsWith('glass.'))) return false;
  const r = trackRef(nodeId, track.replace(/_[rgba]$/, '_r'));
  return r !== null;
}

/** The composition the active tab shows (the one the Global Light belongs to). */
function activeCompId(): string {
  const ws = useWorkspaceStore.getState();
  const tab = ws.activeTabId ? ws.tabs[ws.activeTabId] : null;
  return tab?.compositionId || 'comp_default';
}

/** Global Light angle / altitude — a composition setting. */
export function globalLightCommands(patch: { globalLightAngle?: number; globalLightAltitude?: number }): Command[] {
  return [{ type: 'setCompositionSettings', comp: activeCompId(), patch }];
}

// ── Layer: fx switch, time ─────────────────────────────────────────────

export function setLayerEffectsEnabledEdit(nodeId: string, on: boolean): Promise<unknown> {
  return edit(on ? 'Enable Effects' : 'Disable Effects', { type: 'setLayerSwitches', layers: [nodeId], patch: { effectsEnabled: on } });
}

/** Time stretch % and reverse are ONE signed stretch in the API (negative = reversed). */
export function layerStretchCommands(nodeId: string, stretchPct: number, reverse: boolean): Command[] {
  if (!Number.isFinite(stretchPct) || stretchPct <= 0) return [];
  return [{ type: 'setLayerTiming', items: [{ layer: nodeId, stretch: (reverse ? -1 : 1) * (stretchPct / 100) }] }];
}

const API_FRAME_BLEND: Record<StoredFrameBlend, 'off' | 'frameMix' | 'pixelMotion'> = {
  none: 'off',
  mix: 'frameMix',
  pixelMotion: 'pixelMotion',
};

export function setFrameBlendEdit(nodeId: string, blend: StoredFrameBlend): Promise<unknown> {
  return edit('Frame Blending', { type: 'setLayerSwitches', layers: [nodeId], patch: { frameBlend: API_FRAME_BLEND[blend] ?? 'off' } });
}

// ════════════════════════════════════════════════════════════════════════
// Compositing options, simulation, mask feather, layer styles, freeze
// (B3z-a: closed engine gaps — effectsB3za.test.ts pins the engine side)
// ════════════════════════════════════════════════════════════════════════

const effectField = (nodeId: string, effectId: string, field: 'mask' | 'label') =>
  ref(nodeId, `${paths.effectGroup(effectId)}/compositing/${field}`);

/** Effect Opacity's static value; `undefined` = Reset (100, which the engine stores as absent). */
export function setEffectOpacityEdit(nodeId: string, effectId: string, pct: number | undefined): Promise<unknown> {
  const v = pct === undefined ? 100 : Math.max(0, Math.min(100, pct));
  return edit(pct === undefined ? 'Reset Effect Opacity' : 'Set Effect Opacity', {
    type: 'setProperty', prop: ref(nodeId, paths.effectOpacity(effectId)), value: values.scalar(v),
  });
}

/**
 * Effect Opacity's stopwatch. On keys the current value at the playhead; off
 * leaves the value at the playhead as the static one, so the frame looks as it
 * did (the engine's setAnimated semantics).
 */
export function effectOpacityStopwatchEdit(nodeId: string, effect: Effect, seconds: number): Promise<unknown> {
  const animated = defaultAnimation.isAnimated(nodeId, effectOpacityPath(effect.id));
  return edit(animated ? 'Remove Effect Opacity animation' : 'Animate Effect Opacity', {
    type: 'setAnimated', prop: ref(nodeId, paths.effectOpacity(effect.id)), animated: !animated, time: compTime(seconds),
  });
}

/** Compositing Options › Effect Mask (`undefined` = the whole layer). */
export function setEffectMaskEdit(nodeId: string, effectId: string, maskId: string | undefined): Promise<unknown> {
  return edit('Set effect mask', { type: 'setProperty', prop: effectField(nodeId, effectId, 'mask'), value: values.string(maskId ?? '') });
}

/** The label colour of one applied effect (`undefined` = none). */
export function setEffectLabelColorEdit(nodeId: string, effectId: string, color: string | undefined): Promise<unknown> {
  return edit('Set effect label', { type: 'setProperty', prop: effectField(nodeId, effectId, 'label'), value: values.string(color ?? '') });
}

function legacyAddEffect(nodeIds: string[], type: EffectType): void {
  // B3-legacy: engine gap — a node that is not a layer of a composition (a composition root, a stray node) is not addressable by `addEffect`.
  for (const id of nodeIds) addEffect(id, type);
}

/** Captured effects (a clipboard snapshot or a saved preset) onto `layers` — ONE `pasteEffects`. */
function pasteSnapshotEdit(label: string, items: ReadonlyArray<CopiedEffect>, layers: string[]): Promise<{ ok: boolean }> {
  const effects = items.map(({ effect, tracks }) => ({ effect, tracks }));
  return edit(label, { type: 'pasteEffects', layers, effects: JSON.stringify(effects) });
}

/**
 * Effects ▸ Simulation: switch the layer's Cloner / Physics on, keeping any
 * settings it already carries (`layer/cloner`, `layer/physics` — json fields).
 */
export function enableSimulationEdit(nodeId: string, kind: 'cloner' | 'physics'): Promise<unknown> {
  const path = paths.layerParam(kind);
  const m = documentMirror();
  m.tree(nodeId);
  const cur = m.property(nodeId, path)?.value;
  let prev: Record<string, unknown> = {};
  if (cur?.kind === 'json') {
    try {
      const parsed: unknown = JSON.parse(cur.value);
      if (parsed && typeof parsed === 'object') prev = parsed as Record<string, unknown>;
    } catch { /* an unreadable value starts from the defaults */ }
  }
  return edit(kind === 'cloner' ? 'Add Cloner' : 'Add Physics', {
    type: 'setProperty', prop: ref(nodeId, path), value: values.json({ ...prev, enabled: true }),
  });
}

/**
 * Per-vertex feather (variable-width mask feather) as ONE path write at the
 * playhead: the mask's feather points are the whole answer (a vertex without
 * one has none; `[{segment: 0, radius: -1}]` clears every vertex).
 */
export async function setMaskVertexFeatherEdit(
  nodeId: string,
  maskId: string,
  updates: ReadonlyArray<{ index: number; feather: number | undefined }>,
  seconds: number,
): Promise<void> {
  const prop = ref(nodeId, paths.mask(maskId, 'path'));
  const time = compTime(seconds);
  const res = await engine().query({ type: 'getPropertyValues', props: [prop], time, evaluated: false });
  if (!res.ok) return;
  const cur = res.value.values[0]?.value;
  if (cur?.kind !== 'path') return;
  const n = cur.value.vertices.length / 2;
  const feather: Array<number | undefined> = Array.from({ length: n }, () => undefined);
  for (const fp of cur.value.featherPoints) if (fp.t === 0 && fp.radius >= 0 && fp.segment < n) feather[fp.segment] = fp.radius;
  for (const u of updates) if (u.index >= 0 && u.index < n) feather[u.index] = u.feather === undefined ? undefined : Math.max(0, u.feather);
  const featherPoints = feather.flatMap((r, segment) => (r === undefined ? [] : [{ segment, t: 0, radius: r, tension: 0 }]));
  const path = { ...cur.value, featherPoints: featherPoints.length > 0 ? featherPoints : [{ segment: 0, t: 0, radius: -1, tension: 0 }] };
  await edit('Mask Vertex Feather', { type: 'setProperty', prop, value: { kind: 'path', value: path }, time });
}

/** The keyframe track of one layer-style field (numbers and colour bases), or null. */
function styleFieldTrack(styleKey: string, field: string): { track: string; scale: number; color: boolean } | null {
  if (styleKey === 'glass') {
    const g = GLASS_PROPERTIES.find((x) => x.key === field);
    return g ? { track: glassPropPath(field as Parameters<typeof glassPropPath>[0]), scale: 1, color: g.type === 'color' } : null;
  }
  const n = LAYER_STYLE_NUMBER_PARAMS[styleKey]?.[field];
  if (n) return { track: effectPropPath(layerStyleEffectId(styleKey as keyof LayerStyles), n.param), scale: n.scale, color: false };
  const c = LAYER_STYLE_COLOR_PARAMS[styleKey]?.[field];
  if (c) return { track: effectPropPath(layerStyleEffectId(styleKey as keyof LayerStyles), c), scale: 1, color: true };
  return null;
}

/**
 * A layer-style patch (STORED units, as the style object holds them: 0..1
 * opacities, hex colours) as commands: the switches (Use Global Light, Invert,
 * Direction, Position) as field writes FIRST — so an angle that also unbinds the
 * Global Light lands unbound — then the numbers and colours at the playhead
 * (keyed when animated). Fields no binding describes are reported and skipped.
 */
export function layerStylePatchCommands(
  nodeId: string,
  styleKey: keyof LayerStyles,
  patch: Readonly<Record<string, unknown>>,
  seconds: number,
): Command[] {
  const key = styleKey as string;
  const fields: Command[] = [];
  const nums: Record<string, number> = {};
  const skipped: string[] = [];
  for (const [field, v] of Object.entries(patch)) {
    const sw = STYLE_FIELDS.find((f) => f.style === key && f.key === field);
    if (sw) {
      if (sw.type === 'bool' && typeof v === 'boolean') {
        fields.push({ type: 'setProperty', prop: ref(nodeId, paths.styleParam(key, field)), value: values.bool(v) });
      } else if (sw.type === 'choice' && typeof v === 'string') {
        fields.push({ type: 'setProperty', prop: ref(nodeId, paths.styleParam(key, field)), value: values.choice(v) });
      } else skipped.push(field);
      continue;
    }
    const t = styleFieldTrack(key, field);
    if (t && t.color && typeof v === 'string') {
      const c = Color.fromHex(v);
      Object.assign(nums, { [`${t.track}_r`]: c.r, [`${t.track}_g`]: c.g, [`${t.track}_b`]: c.b, [`${t.track}_a`]: c.a ?? 1 });
    } else if (t && !t.color && typeof v === 'number' && Number.isFinite(v)) {
      nums[t.track] = v * t.scale;
    } else skipped.push(field);
  }
  if (skipped.length > 0) console.warn(`[layerStylePatchCommands] ${key}: not addressed by the engine: ${skipped.join(', ')}`);
  const vals = Object.keys(nums).length > 0 ? valueCommands([{ nodeId, values: nums }], { seconds }) : [];
  return [...fields, ...vals];
}

/** Switch a style's Use Global Light off (so its own angle / altitude render). */
export function unbindGlobalLightCommands(nodeId: string, styleKey: keyof LayerStyles): Command[] {
  return layerStylePatchCommands(nodeId, styleKey, { useGlobalLight: false }, 0);
}

/** A layer-style patch as ONE undo entry at the active playhead. */
export function patchLayerStyleEdit(nodeId: string, styleKey: keyof LayerStyles, patch: Readonly<Record<string, unknown>>): Promise<unknown> {
  const cmds = layerStylePatchCommands(nodeId, styleKey, patch, getTime());
  return cmds.length > 0 ? edit('Edit Layer Style', cmds) : Promise.resolve();
}

/**
 * Freeze frame on/off and its hold time (source seconds on the layer's
 * keyframe axis). On holds the frame at `seconds` (the playhead); a typed hold
 * time re-freezes there — `unfreezeLayers` + `freezeFrame` as one entry.
 */
export function setFreezeFrameEdit(nodeId: string, on: boolean, seconds: number): Promise<unknown> {
  if (!on) return edit('Unfreeze Frame', { type: 'unfreezeLayers', layers: [nodeId] });
  return edit('Freeze Frame', { type: 'freezeFrame', layer: nodeId, time: compTime(seconds), lastFrame: false });
}

export function setFreezeTimeEdit(nodeId: string, holdSeconds: number): Promise<unknown> {
  return edit('Freeze Frame', [
    { type: 'unfreezeLayers', layers: [nodeId] },
    { type: 'freezeFrame', layer: nodeId, time: compTime(keyframeToCompTime(nodeId, Math.max(0, holdSeconds))), lastFrame: false },
  ]);
}
