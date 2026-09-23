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
 *                 expansion / shape stopwatch (`masks/<id>/…`)
 *   layer styles  add / remove (`styles/<key>`), numeric + colour params
 *                 (`styles/<key>/<param>`), the composition's Global Light
 *   layer         the fx switch, time stretch / reverse / frame blend
 *
 * Effects are addressed by their stable id, never by stack index. Display
 * reads stay direct (B4's mirror replaces them); this module only reads to
 * decide what to send.
 *
 * What the engine cannot say yet keeps its pre-API writer, funnelled through
 * the `legacy…` functions at the bottom — each one marked `B3-legacy` with the
 * precise gap, so the remaining direct writes of this area live in one place.
 */

import type { Command, PropertyInit, PropertyWrite, Value } from '@motion/engine-api';
import { defaultAnimation } from '@motion/animation';
import { edit } from '@core/engine/uiEdits';
import { isLayer } from '@core/engine/doc';
import { maskToBezier } from '@core/engine/props';
import { compTime, paths, ref, values } from '@core/engine/propRefs';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { runAnimEdit } from '@core/animation/animationCommands';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import {
  addEffect,
  effectDefFor,
  effectOpacityPath,
  effectPropPath,
  getNodeEffects,
  newInstanceParamsOf,
  paramsOf,
  parseColorChannels,
  setEffectLabelColor,
  setEffectMaskId,
  setEffectOpacity,
  type Effect,
  type EffectParamDef,
  type EffectParamValue,
  type EffectType,
} from '@core/effects/effects';
import {
  applyEffectPreset,
  captureEffect,
  listEffectPresets,
  pasteEffects,
  readEffectClipboard,
  type CopiedEffect,
} from '@core/effects/effectClipboard';
import { getNodeLayerStyles, setLayerStyles, type LayerStyles } from '@core/effects/layerStyles';
import { hasMaskAnim, setMaskPointFeather, updateMaskPath, type MaskPath } from '@core/effects/mask';
import { updateNodeLayerTime, type FrameBlend as StoredFrameBlend, type LayerTime } from '@core/scene/layerTime';
import { enableNodeCloner } from '@core/scene/clonerExpand';
import { enableNodePhysics } from '@core/simulation/physicsBodies';
import { useWorkspaceStore } from '@stores/projectStore';
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
 * key at the playhead through the engine; a static one keeps the legacy writer
 * (see `legacySetEffectOpacity`). Returns the commands for the engine route,
 * null when the caller must take the legacy one.
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
 * or deleted is a snapshot the API cannot paste yet (legacy).
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
  legacyPasteEffects(layers);
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
 * or instance options keeps the legacy snapshot paste.
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
  return legacyApplyEffectPreset(name, layers);
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
 * the layer's mask shape is keyframed (whole-mask snapshots): there the edit
 * belongs in the shape keyframe at the playhead, which the API's scalar
 * property does not reach (see `legacyPatchAnimatedMask`).
 */
export function maskValueCommands(
  nodeId: string,
  maskId: string,
  key: 'feather' | 'opacity' | 'expansion',
  value: number,
  seconds: number,
): Command[] | null {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || hasMaskAnim(node)) return null;
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
 * → `styles/<key>/<param>`). Glass is not a compiled-effect style: its
 * `glass.<field>` tracks resolve through glassResolve and are not catalog
 * properties, so it never takes the engine route.
 */
export function styleTrackOnEngine(nodeId: string, track: string | null): boolean {
  if (!track || !track.startsWith('effect.layerstyle:')) return false;
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
// Legacy writers — every write of this area the engine cannot say yet.
// ════════════════════════════════════════════════════════════════════════

/** Effect Opacity's static value (and its Reset). */
export function legacySetEffectOpacity(nodeId: string, effectId: string, pct: number | undefined): void {
  // B3-legacy: engine gap — `effects/<id>/compositing/opacity` is absent from the TS catalog until the field is set, and its static write lands in `params['fx.opacity']` instead of `Effect.opacity` (propertyValue.writeEffectValue has no case for EFFECT_OPACITY_KEY).
  setEffectOpacity(nodeId, effectId, pct);
}

/** Effect Opacity's stopwatch (same gap: setAnimated reads/writes the static through `params`). */
export function legacyEffectOpacityStopwatch(nodeId: string, effect: Effect, seconds: number, display: number): void {
  const path = effectOpacityPath(effect.id);
  // B3-legacy: engine gap — same as legacySetEffectOpacity (setAnimated on/off reads and writes the static value through the wrong field); the legacy key axis.
  const layerT = compToKeyframeTime(nodeId, seconds);
  if (defaultAnimation.isAnimated(nodeId, path)) {
    // B3-legacy: engine gap — as above.
    runAnimEdit('Remove Effect Opacity animation', () => {
      // B3-legacy: engine gap — as above.
      defaultAnimation.removeTrack(nodeId, path);
      // B3-legacy: engine gap — as above. The last sampled value becomes the static one, so the frame looks as it did.
      setEffectOpacity(nodeId, effect.id, display);
    });
    return;
  }
  const stored = effect.opacity ?? 100;
  // B3-legacy: engine gap — as above.
  runAnimEdit('Animate Effect Opacity', () => {
    // B3-legacy: engine gap — as above.
    defaultAnimation.setKeyframe(nodeId, path, layerT, stored);
    // B3-legacy: engine gap — as above. Stamp the field so the layer is on the CPU bake from the first frame (see `Effect.opacity`).
    if (effect.opacity === undefined) setEffectOpacity(nodeId, effect.id, stored);
  });
}

/** Compositing Options › Effect Mask. */
export function legacySetEffectMask(nodeId: string, effectId: string, maskId: string | undefined): void {
  // B3-legacy: engine gap — Effect Mask (`Effect.maskId`) has no API property (`effects/<id>/compositing/mask` is not in the catalog of either engine).
  runAnimEdit('Set effect mask', () => {
    // B3-legacy: engine gap — as above.
    setEffectMaskId(nodeId, effectId, maskId);
  });
}

/** The label colour of one applied effect. */
export function legacySetEffectLabelColor(nodeId: string, effectId: string, color: string | undefined): void {
  // B3-legacy: engine gap — an effect instance's label colour (`Effect.labelColor`) has no API property or command.
  setEffectLabelColor(nodeId, effectId, color);
}

function legacyAddEffect(nodeIds: string[], type: EffectType): void {
  // B3-legacy: engine gap — a node that is not a layer of a composition (a composition root, a stray node) is not addressable by `addEffect`.
  for (const id of nodeIds) addEffect(id, type);
}

function legacyPasteEffects(layers: string[]): void {
  // B3-legacy: engine gap — pasting a captured effect SNAPSHOT (source edited or deleted since the copy): `copyPropertyGroups` needs the live source and there is no fragment-based group paste.
  pasteEffects(layers);
}

function legacyApplyEffectPreset(name: string, layers: string[]): boolean {
  // B3-legacy: engine gap — a saved preset that captured keyframes / fx switch / compositing options / label colour: `addEffect` takes static params only and there is no fragment-based group paste.
  return applyEffectPreset(name, layers);
}

/** Effects ▸ Simulation: Cloner / Physics. */
export function legacyEnableSimulation(nodeId: string, kind: 'cloner' | 'physics'): void {
  // B3-legacy: engine gap — Cloner / Physics are layer modifiers with no API group type (`listGroupTypes` has neither).
  if (kind === 'cloner') enableNodeCloner(nodeId);
  // B3-legacy: engine gap — as above.
  else enableNodePhysics(nodeId);
}

/** Feather / Opacity / Expansion on a mask whose shape is keyframed (see `maskValueCommands`). */
export function legacyPatchAnimatedMask(nodeId: string, maskId: string, patch: Partial<MaskPath>, seconds: number): void {
  // B3-legacy: engine gap — whole-mask shape keyframes (`fx.maskAnim`): the edit lands in the shape keyframe at the playhead; the API's `masks/<id>/feather|opacity|expansion` write the static mask.
  const t = compToKeyframeTime(nodeId, seconds);
  // B3-legacy: engine gap — as above.
  updateMaskPath(nodeId, maskId, patch, t);
}

/** Per-vertex feather (variable-width mask feather). */
export function legacySetMaskVertexFeather(nodeId: string, maskId: string, updates: ReadonlyArray<{ index: number; feather: number | undefined }>, seconds: number): void {
  // B3-legacy: engine gap — variable-width mask feather (`BezierPath.featherPoints`) is not implemented in the TS engine (ENGINE_API.md §14.1).
  const t = compToKeyframeTime(nodeId, seconds);
  for (const u of updates) {
    // B3-legacy: engine gap — as above (the 700 ms recorder folds a toggle's per-vertex writes into one entry, as before).
    setMaskPointFeather(nodeId, maskId, u.index, u.feather, t);
  }
}

/**
 * A layer-style field the API does not address: Glass (all of it), the
 * non-numeric switches (Use Global Light, Invert, Carve, Stroke Position) and
 * an angle still bound to the Global Light (editing it unbinds, which is a
 * switch write). `patch` is merged into the style.
 */
export function legacyPatchLayerStyle(nodeId: string, styleKey: keyof LayerStyles, patch: Record<string, unknown>): void {
  const cur = getNodeLayerStyles(nodeId) as Record<string, Record<string, unknown> | undefined>;
  // B3-legacy: engine gap — Glass params and the layer-style switches (useGlobalLight, invert, direction, position) are not catalog properties (layer styles are `Value.json` in ENGINE_API.md §14.2).
  setLayerStyles(nodeId, { ...(cur as LayerStyles), [styleKey]: { ...(cur[styleKey as string] ?? {}), ...patch } } as LayerStyles);
}

/**
 * Keyframes on a style track the API does not address (Glass `glass.<field>`
 * tracks; a global-light-bound angle, whose first key must also unbind it).
 * `keys` = track → value at the playhead; `remove` = drop these tracks.
 */
export function legacyStyleKeys(
  nodeId: string,
  label: string,
  op: { keys?: Readonly<Record<string, number>>; remove?: ReadonlyArray<string>; before?: () => void },
  seconds: number,
  mergeKey?: string,
): void {
  // B3-legacy: engine gap — as legacyPatchLayerStyle (the legacy key axis).
  const layerT = compToKeyframeTime(nodeId, seconds);
  // B3-legacy: engine gap — as legacyPatchLayerStyle (Glass tracks are not catalog properties; unbinding the Global Light is a switch write).
  runAnimEdit(label, () => {
    op.before?.();
    // B3-legacy: engine gap — as above.
    for (const [track, v] of Object.entries(op.keys ?? {})) defaultAnimation.setKeyframe(nodeId, track, layerT, v);
    // B3-legacy: engine gap — as above.
    for (const track of op.remove ?? []) defaultAnimation.removeTrack(nodeId, track);
  }, mergeKey);
}

/** Freeze frame on/off and its hold time (layer keyframe-axis seconds). */
export function legacyPatchLayerTime(nodeId: string, patch: Partial<LayerTime>): void {
  // B3-legacy: engine gap — `freezeFrame` can only turn a freeze ON (at a comp time); turning it off and editing the held time (layer-time seconds) have no API form.
  updateNodeLayerTime(nodeId, patch);
}
