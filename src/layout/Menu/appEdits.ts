/**
 * The editor shell's own document edits through the engine API (B3,
 * docs/B3_PATTERNS.md): what `App.tsx` does for the docked timeline (track
 * switches, the stopwatch / navigator diamond / value fields of a property row,
 * the keyframe and clip context menus, row reorder) and the layer verbs the
 * command registry, the menus and the toolbar share. ONE user action = ONE
 * undo entry, labelled as the legacy writer labelled it.
 *
 * Every function here only COMPOSES and SENDS commands. When the API cannot
 * address the target (a node that is not a layer, a property outside the
 * catalog, a key the API cannot address alone) it resolves to `false` and
 * sends nothing, so the caller keeps its legacy writer for the whole action —
 * never half of it. Display reads stay direct until B4.
 */

import type { Command, LayerKind, LayerSwitchesPatch, PropRef } from '@motion/engine-api';
import { defaultAnimation, expandKeyframeProp, type EasingKind } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { layerFlagDef, type LayerFlag } from '@core/scene/layerFlags';
import { nextQuality, type LayerQuality } from '@core/effects/layerQuality';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';
import { uiKindOf } from '@core/mirror/layerKinds';
import { childOrderOf } from '@core/mirror/layerTree';
import { mirrorLayerFlag, mirrorLayerFlagAvailable } from '@core/mirror/layerSwitchFacts';
import { readNodeMask } from '@core/effects/mask';
import { notifyCameraTipIfMissing } from '@core/workspace/cameraNav';
import { compOfLayer, isCompItem, isLayer } from '@core/engine/doc';
import { compTime, type TrackRef } from '@core/engine/propRefs';
import { edit } from '@core/engine/uiEdits';
import { readTransformProp } from '@core/scene/transformWrite';
import { staggerOffsets, type StaggerOptions } from '@core/animation/staggerOffsets';
import { getTimelineController } from '@core/timeline/TimelineController';
import { engine } from '@core/engine/engineInstance';
import { computeFit, intrinsicSizeOf, type FitMode, type Size } from '@core/source/fitCommands';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useRenderQualityStore } from '@stores/renderQualityStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { easePatch, keyIdsAt, trackRef, valueCommands } from '@layout/Inspector/inspectorEdits';
import { reorderCommands } from '@layout/Workspace/layerMenuEdits';
import { easeKeyframes, easeKindOnKeys, setRovingOnKeys } from '@layout/Timeline/keyframeEdits';
import { rippleDeleteLayers } from '@layout/Timeline/timelineEdits';

function notify(message: string, level: 'info' | 'success' | 'warning' = 'info', durationMs = 3200): void {
  useUIStore.getState().notify({ level, message, durationMs });
}

// ── Track switches (the timeline's eye / lock / solo / speaker) ───────

export type TrackSwitch = 'visible' | 'locked' | 'solo';

const SWITCH_LABEL: Record<TrackSwitch, [on: string, off: string]> = {
  visible: ['Show layer', 'Hide layer'],
  locked: ['Lock layer', 'Unlock layer'],
  solo: ['Solo layer', 'Unsolo layer'],
};

function readSwitch(nodeId: string, sw: TrackSwitch): boolean {
  const l = documentMirror().layer(nodeId);
  if (!l) return false;
  return l.switches[sw];
}

/** Flip one switch on one track row. False when the row is not a layer (nothing sent). */
export async function toggleTrackSwitchEdit(nodeId: string, sw: TrackSwitch): Promise<boolean> {
  if (!isLayer(nodeId)) return false;
  const next = !readSwitch(nodeId, sw);
  const [on, off] = SWITCH_LABEL[sw];
  await edit(next ? on : off, { type: 'setLayerSwitches', layers: [nodeId], patch: { [sw]: next } });
  return true;
}

/**
 * AE's Alt+click on a solo switch: a lit switch clears every solo in the
 * document, an unlit one isolates this layer. One entry.
 */
export async function soloExclusiveEdit(nodeId: string): Promise<boolean> {
  if (!isLayer(nodeId)) return false;
  const only = !readSwitch(nodeId, 'solo');
  const cmds: Command[] = [];
  const m = documentMirror();
  for (const id of m.layerIds()) {
    if ((only && id === nodeId) || !m.layer(id)?.switches.solo || !isLayer(id)) continue;
    cmds.push({ type: 'setLayerSwitches', layers: [id], patch: { solo: false } });
  }
  if (only) cmds.push({ type: 'setLayerSwitches', layers: [nodeId], patch: { solo: true } });
  if (cmds.length === 0) return true;
  await edit(only ? 'Solo only this layer' : 'Clear all solos', cmds);
  return true;
}

/** The clip bar's speaker glyph: AE's audio switch (`audioEnabled`). */
export async function toggleAudioMuteEdit(nodeId: string): Promise<void> {
  const n = documentMirror().layer(nodeId);
  if (!n || !isLayer(nodeId)) return;
  const kind = uiKindOf(n);
  if (kind !== 'audio' && kind !== 'video') return;
  const muted = !n.switches.audioEnabled;
  await edit(muted ? 'Unmute layer audio' : 'Mute layer audio', {
    type: 'setLayerSwitches', layers: [nodeId], patch: { audioEnabled: muted },
  });
}

/**
 * One AE switch-column flag on one track row (`layerFlags`' verbs, as a
 * `setLayerSwitches`), with the same feedback the legacy toggle gave. Returns
 * false when the flag has no API switch (nothing sent).
 */
export async function toggleLayerFlagEdit(nodeId: string, flag: LayerFlag): Promise<boolean> {
  const m = documentMirror();
  const node = m.layer(nodeId);
  if (!node || !isLayer(nodeId)) return false;
  const def = layerFlagDef(flag);
  if (!mirrorLayerFlagAvailable(m, nodeId, flag)) {
    notify(`${def.label} isn't available for that layer`, 'warning', 2600);
    return true;
  }
  const next: boolean | LayerQuality = def.cycles ? nextQuality(node.switches.quality) : !mirrorLayerFlag(node, flag);
  const on = next === true;
  let patch: LayerSwitchesPatch;
  switch (flag) {
    case 'quality': patch = { quality: next as LayerQuality }; break;
    case 'fxEnabled': patch = { effectsEnabled: on }; break;
    case 'frameBlend': patch = { frameBlend: on ? 'frameMix' : 'off' }; break;
    case 'shy': patch = { shy: on }; break;
    case 'collapse': patch = { collapse: on }; break;
    case 'motionBlur': patch = { motionBlur: on }; break;
    case 'adjustment': patch = { adjustment: on }; break;
    case 'guide': patch = { guide: on }; break;
    case 'preserveTransparency': patch = { preserveTransparency: on }; break;
    case 'threeD': patch = { threeD: on }; break;
    default: return false;
  }
  const label = typeof next === 'string' ? `Quality: ${next[0]!.toUpperCase()}${next.slice(1)}` : `${on ? 'Enable' : 'Disable'} ${def.label}`;
  const res = await edit(label, { type: 'setLayerSwitches', layers: [nodeId], patch });
  if (!res.ok) return true;
  // The feedback `toggleLayerFlag` gave (layerSwitchFeedback.ts / cameraNav).
  if (flag === 'guide') {
    notify(on ? 'Guide layer — visible while editing, omitted from export' : 'No longer a guide layer', 'success');
  } else if (flag === 'threeD' && on) {
    notifyCameraTipIfMissing((message, level) => notify(message, level));
  } else if (flag === 'motionBlur' && on) {
    const mb = useMotionBlurStore.getState();
    if (!mb.enabled) {
      // B3-legacy: engine gap — the composition motion-blur MASTER (`enabled`) is not a field of the API's MotionBlurSettings; AE's dual gate still turns it on here (a store setting, as before).
      mb.setEnabled(true);
      notify('Motion Blur enabled for this layer and the composition', 'success');
    }
    if (useRenderQualityStore.getState().draft) {
      notify('Draft preview is on — motion blur samples are paused until draft is off', 'warning');
    }
  } else if (flag === 'adjustment' && on && (documentMirror().layer(nodeId)?.effectCount ?? 0) === 0) {
    notify('Adjustment layer is on — add effects to grade layers beneath it');
  }
  return true;
}

// ── Row reorder (drag a track header) ─────────────────────────────────

/**
 * Move `fromId` next to its sibling `anchorId` in CHILD order ('after' = in
 * front of it). `reorderLayers` addresses the composition's stack, so the new
 * sibling order goes through `reorderCommands`. False when either is not a
 * layer of the same parent.
 */
export async function moveLayerAdjacentEdit(fromId: string, anchorId: string, position: 'before' | 'after'): Promise<boolean> {
  const m = documentMirror();
  const from = m.layer(fromId);
  const anchor = m.layer(anchorId);
  // The scene parent: the group a layer sits in, else its composition.
  const parent = from ? from.parent ?? from.comp : undefined;
  if (!from || !anchor || !parent || parent !== (anchor.parent ?? anchor.comp) || !isLayer(fromId) || !isLayer(anchorId)) return false;
  const comp = compOfLayer(fromId);
  if (!comp) return false;
  const kids = childOrderOf(m, parent);
  const rest = kids.filter((id) => id !== fromId);
  const at = rest.indexOf(anchorId);
  if (at < 0) return false;
  const next = [...rest];
  next.splice(position === 'after' ? at + 1 : at, 0, fromId);
  if (next.every((id, i) => id === kids[i])) return true;
  const cmds = reorderCommands(comp, parent, kids, next, new Set([fromId]));
  if (cmds.length === 0) return true;
  await edit('Reorder layer', cmds);
  return true;
}

// ── Property rows (stopwatch, navigator diamond, value fields) ────────

function refsFor(nodeId: string, tracks: readonly string[]): TrackRef[] | null {
  const out: TrackRef[] = [];
  const seen = new Set<string>();
  for (const t of tracks) {
    const r = trackRef(nodeId, t);
    if (!r) return null;
    if (seen.has(r.ref.path)) continue;
    seen.add(r.ref.path);
    out.push(r);
  }
  return out;
}

/**
 * A property is animated: the document mirror holds keys for its API property
 * (B4 — one key list per property: any member track keyed for numbers, the data
 * track for text / paths / gradients).
 */
function refAnimated(nodeId: string, r: TrackRef): boolean {
  return documentMirror().keyframes(nodeId, r.ref.path).length > 0;
}

/**
 * The navigator diamond on a timeline property row: keys at the playhead → remove
 * them; none → add one holding the current value on every animated member
 * property. False when a track is not addressable.
 */
export async function propertyKeyToggleEdit(nodeId: string, prop: string, seconds: number): Promise<boolean> {
  const tracks = expandKeyframeProp(prop).filter((p) => defaultAnimation.getTrackKeyframes(nodeId, p));
  if (tracks.length === 0) return true;
  const refs = refsFor(nodeId, tracks);
  if (!refs) return false;
  const animated = refs.filter((r) => refAnimated(nodeId, r)).map((r) => r.ref);
  if (animated.length === 0) return true;
  const at = await keyIdsAt(animated, seconds);
  if (at.length > 0) {
    await edit('Remove keyframe', { type: 'deleteKeyframes', ids: at });
    return true;
  }
  const time = compTime(seconds);
  await edit('Add keyframe', { type: 'addKeyframes', keys: animated.map((p) => ({ prop: p, time, spatialIn: [], spatialOut: [] })) });
  return true;
}

/**
 * A timeline property row's stopwatch (`setAnimated`): lit → every listed
 * property stops animating (static at the playhead value), unlit → the first
 * key at the playhead holding the current value. False when not addressable.
 */
export async function propertyStopwatchEdit(nodeId: string, props: readonly string[], seconds: number): Promise<boolean> {
  const node = documentMirror().layer(nodeId);
  // A composition is not a layer: its tracks are not addressable (false → legacy).
  if (!node) return !isCompItem(nodeId);
  if (node.switches.locked) return true;
  const refs = refsFor(nodeId, props);
  if (!refs || refs.length === 0 || refs.some((r) => !r.animatable)) return false;
  const anyAnimated = refs.some((r) => refAnimated(nodeId, r));
  const time = compTime(seconds);
  await edit(anyAnimated ? 'Disable animation' : 'Enable animation', refs.map((r) => ({ type: 'setAnimated', prop: r.ref, animated: !anyAnimated, time }) as Command));
  return true;
}

/**
 * The mask row's stopwatch: the layer's mask shapes are keyed together, so the
 * first mask's Path stands for all of them. False when the layer has no mask.
 */
export async function maskShapeStopwatchEdit(nodeId: string, animated: boolean, seconds: number): Promise<boolean> {
  const node = defaultSceneGraph.getNode(nodeId);
  const first = node ? readNodeMask(node)?.paths[0] : undefined;
  if (!node || !first || !isLayer(nodeId)) return false;
  await edit(animated ? 'Disable mask animation' : 'Enable mask animation', {
    type: 'setAnimated', prop: { layer: nodeId, path: `masks/${first.id}/path` }, animated: !animated, time: compTime(seconds),
  });
  return true;
}

/**
 * The commands a timeline value field sends for one (layer, member track):
 * a key at the playhead when animated (or under auto-keyframe), else the
 * static value — the inspector's contract (`valueCommands`). Null when the
 * track is not addressable; [] for a locked layer.
 */
export function propertyValueCommands(
  nodeId: string,
  prop: string,
  value: number,
  seconds: number,
  autoKeyframe: boolean,
): Command[] | null {
  const node = documentMirror().layer(nodeId);
  // A composition is not a layer: its tracks are not addressable (null → legacy).
  if (!node) return isCompItem(nodeId) ? null : [];
  if (node.switches.locked) return [];
  const r = trackRef(nodeId, prop);
  if (!r || r.members.length === 0) return null;
  return valueCommands([{ nodeId, values: { [prop]: value } }], { seconds, autoKeyframe });
}

/**
 * Alt+Shift+P / S / R / T / A: a key at the playhead on each named property of
 * every selected (unlocked) layer, holding the value it has there. Tracks a
 * layer does not have are skipped. One entry.
 */
export async function addKeyframesForSelectionEdit(nodeIds: readonly string[], tracks: readonly string[], seconds: number): Promise<void> {
  const keys: Array<{ prop: PropRef; time: number; spatialIn: number[]; spatialOut: number[] }> = [];
  const seen = new Set<string>();
  const time = compTime(seconds);
  for (const id of nodeIds) {
    const n = documentMirror().layer(id);
    if (!n || n.switches.locked) continue;
    for (const t of tracks) {
      const r = trackRef(id, t);
      if (!r || !r.animatable) continue;
      const k = `${id}|${r.ref.path}`;
      if (seen.has(k)) continue;
      seen.add(k);
      keys.push({ prop: r.ref, time, spatialIn: [], spatialOut: [] });
    }
  }
  if (keys.length === 0) return;
  await edit('Add keyframe', { type: 'addKeyframes', keys });
}

// ── The keyframe context menu ─────────────────────────────────────────

/**
 * One interpolation kind on one timeline key (the diamond's Keyframe
 * Interpolation submenu). Hold goes through `easeKeyframes`, which spells it
 * the way the key's track stores it.
 */
export function setKeyInterpolationEdit(uiId: string, kind: EasingKind, label: string): Promise<void> {
  if (kind === 'hold') return easeKeyframes([uiId], { easing: 'hold' }, label);
  return easeKindOnKeys([uiId], kind);
}

/** Rove Across Time on one timeline key: the engine re-times the roving run for constant speed. */
export function setKeyRovingEdit(uiId: string, roving: boolean): Promise<void> {
  return setRovingOnKeys([uiId], roving);
}

// ── The clip context menu ─────────────────────────────────────────────

/** "Delete Layer" / "Delete Layer and Close Gap" on a clip bar. False when the bar has no layer. */
export async function deleteClipLayerEdit(nodeId: string | null | undefined, ripple: boolean): Promise<boolean> {
  if (!nodeId || !isLayer(nodeId)) return false;
  const n = documentMirror().layer(nodeId);
  if (!n || n.switches.locked) return true;
  if (ripple) {
    await rippleDeleteLayers([nodeId]);
  } else {
    const res = await edit('Delete layer', { type: 'deleteLayers', layers: [nodeId] });
    if (res.ok) {
      const sel = useSelectionStore.getState();
      if (sel.ids.includes(nodeId)) sel.set(sel.ids.filter((id) => id !== nodeId));
    }
  }
  return true;
}

// ── Layer ▸ Transform (the registry's fit / centre commands) ──────────

/**
 * Per-layer transform values → ONE entry, the `writeTransformProps` contract
 * (animated → a key at the playhead, auto-keyframe → a first key, else the
 * static value). Null when a track is not addressable on one of the layers.
 */
function transformCommands(entries: ReadonlyArray<{ nodeId: string; values: Record<string, number> }>, seconds: number): Command[] | null {
  for (const e of entries) {
    if (!isLayer(e.nodeId)) return null;
    for (const t of Object.keys(e.values)) if (!trackRef(e.nodeId, t)) return null;
  }
  return valueCommands(entries, { seconds, autoKeyframe: usePreferenceStore.getState().timelineAutoKeyframe });
}

async function sendTransform(label: string, entries: ReadonlyArray<{ nodeId: string; values: Record<string, number> }>, seconds: number): Promise<boolean> {
  if (entries.length === 0) return true;
  const cmds = transformCommands(entries, seconds);
  if (!cmds) return false;
  if (cmds.length > 0) await edit(label, cmds);
  return true;
}

/**
 * AE's Centre Anchor Point in Layer Content over the selection: the anchor
 * goes to 0,0 (the content centre) and Position moves by the same offset so
 * nothing jumps — read at the playhead (`readTransformProp`), as the legacy
 * command did. One entry for the whole selection. False → legacy.
 */
export function centreAnchorEdit(nodeIds: readonly string[], seconds: number): Promise<boolean> {
  const entries = nodeIds.flatMap((nodeId) => {
    const ax = readTransformProp(nodeId, 'anchorX', 0);
    const ay = readTransformProp(nodeId, 'anchorY', 0);
    if (ax === 0 && ay === 0) return [];
    const x = readTransformProp(nodeId, 'x', 0);
    const y = readTransformProp(nodeId, 'y', 0);
    return [{ nodeId, values: { anchorX: 0, anchorY: 0, x: x - ax, y: y - ay } }];
  });
  return sendTransform('Centre Anchor Point', entries, seconds);
}

/** Centre In View over the selection: Position to the middle of `frame`. One entry. */
export function centreInCompEdit(nodeIds: readonly string[], frame: Size, seconds: number): Promise<boolean> {
  const entries = nodeIds
    .filter((id) => isLayer(id) || isCompItem(id))
    .map((nodeId) => ({ nodeId, values: { x: Math.round(frame.width / 2), y: Math.round(frame.height / 2) } }));
  return sendTransform('Centre In Frame', entries, seconds);
}

/** Fit / Fill / Native Size over the selection (`computeFit` on each layer's intrinsic size). One entry. */
export function fitLayersEdit(nodeIds: readonly string[], frame: Size, mode: FitMode, seconds: number): Promise<boolean> {
  const entries = nodeIds.flatMap((nodeId) => {
    const node = defaultSceneGraph.getNode(nodeId);
    const intrinsic = node ? intrinsicSizeOf(node) : null;
    if (!node || !intrinsic) return [];
    const fitted = computeFit(intrinsic, frame, mode);
    return [{ nodeId, values: { width: fitted.width, height: fitted.height, scaleX: 1, scaleY: 1 } }];
  });
  return sendTransform('Fit Layer', entries, seconds);
}

// ── Keyframe assistants (the Animation menu) ──────────────────────────

/**
 * Every key of a layer's animated NUMERIC properties (the legacy assistants'
 * `currentTracks`), by API property. Null when one of them is not
 * addressable (the caller keeps its legacy assistant).
 */
async function layerKeys(nodeId: string): Promise<Array<{ ref: PropRef; keys: Array<{ id: string; time: number }> }> | null> {
  const props = defaultAnimation.animatedProps(nodeId).filter((p) => (defaultAnimation.getTrackKeyframes(nodeId, p)?.length ?? 0) > 0);
  if (props.length === 0) return [];
  const refs = refsFor(nodeId, props);
  if (!refs) return null;
  const res = await engine().query({ type: 'getKeyframes', props: refs.map((r) => r.ref) });
  if (!res.ok) return null;
  return res.value.sets.map((s) => ({ ref: s.prop, keys: s.keyframes.map((k) => ({ id: k.id, time: k.time })) }));
}

/**
 * Time-Reverse Keyframes on a layer. The legacy assistant mirrors every key
 * within the layer's OVERALL span; `reverseKeyframes` mirrors each property
 * within its own. Through the engine when the two agree (every animated
 * property spans the same time — the common case); otherwise false → legacy.
 * Resolves to 'none' when the layer has no keys.
 */
export async function timeReverseKeyframesEdit(nodeId: string): Promise<boolean | 'none'> {
  const sets = await layerKeys(nodeId);
  if (!sets) return false;
  const all = sets.flatMap((s) => s.keys);
  if (all.length === 0) return 'none';
  const spans = sets.filter((s) => s.keys.length > 0).map((s) => {
    const t = s.keys.map((k) => k.time);
    return `${Math.min(...t)}:${Math.max(...t)}`;
  });
  if (new Set(spans).size > 1) return false;
  await edit('Time-reverse keyframes', { type: 'reverseKeyframes', ids: all.map((k) => k.id) });
  return true;
}

/** Easy Ease every key of a layer's animated numeric properties. One entry. */
export async function easyEaseAllEdit(nodeId: string): Promise<boolean | 'none'> {
  const sets = await layerKeys(nodeId);
  if (!sets) return false;
  const ids = sets.flatMap((s) => s.keys.map((k) => k.id));
  if (ids.length === 0) return 'none';
  await edit('Easy ease all keyframes', { type: 'updateKeyframes', patches: ids.map((id) => easePatch(id, 'Ease')) });
  return true;
}

/** Whether a layer owns any keyframe (scalar tracks, data tracks) — display read. */
function hasKeys(nodeId: string): boolean {
  return defaultAnimation.animatedProps(nodeId).some((p) => (defaultAnimation.getTrackKeyframes(nodeId, p)?.length ?? 0) > 0)
    || defaultAnimation.getDataAnimatedPropPaths(nodeId).length > 0;
}

/**
 * Stagger animations: shift EVERY keyframe of each animated layer by its
 * pattern offset (`staggerOffsets`, the timeline's own maths) in LAYER time —
 * `shiftLayerKeyframes` (B3z): sub-frame offsets, keys before 0 and properties
 * outside the catalog included, the way the legacy assistant shifted whole
 * tracks. One entry. Resolves to 'none' with fewer than two animated layers.
 */
export async function staggerKeyframesEdit(
  nodeIds: readonly string[],
  pattern: StaggerOptions,
  label = 'Sequence layers',
): Promise<boolean | 'none'> {
  const animated = [...new Set(nodeIds)].filter((id) => isLayer(id) && hasKeys(id));
  if (animated.length < 2) return 'none';
  const offsets = staggerOffsets(animated.length, pattern);
  const items = animated
    .map((layer, i) => ({ layer, delta: compTime(offsets[i] ?? 0) }))
    .filter((it) => it.delta !== 0);
  if (items.length > 0) await edit(label, { type: 'shiftLayerKeyframes', items });
  return true;
}

/** Stagger Animations: the 0.3 s cascade (the no-questions version of the dialog). */
export function staggerAnimationsEdit(nodeIds: readonly string[], intervalSec: number): Promise<boolean | 'none'> {
  return staggerKeyframesEdit(nodeIds, { mode: 'cascade', step: intervalSec, reverse: false, balance: false, seed: 1 });
}

/**
 * Sequence Layers (bars end to end, optional opacity cross-dissolve over the
 * overlap): the engine's `sequenceLayers`, one entry including the fades. A
 * selection spanning compositions sends one command per composition in the
 * same batch (B3z), each in selection order. 'none' when no composition has
 * two selected layers with bars.
 */
export async function sequenceLayerBarsEdit(nodeIds: readonly string[], overlapSeconds: number, crossfade: boolean): Promise<boolean | 'none'> {
  const layers = nodeIds.filter((id) => isLayer(id) && getTimelineController().getLayersForNode(id).length > 0);
  const byComp = new Map<string, string[]>();
  for (const id of layers) {
    const comp = compOfLayer(id)!;
    const list = byComp.get(comp) ?? [];
    if (!list.includes(id)) list.push(id);
    byComp.set(comp, list);
  }
  const cmds: Command[] = [...byComp.values()]
    .filter((list) => list.length >= 2)
    .map((list) => ({ type: 'sequenceLayers', layers: list, overlap: compTime(overlapSeconds), crossfade }));
  if (cmds.length === 0) return 'none';
  const res = await edit('Sequence Layers', cmds);
  return res.ok;
}

// ── Animation presets ─────────────────────────────────────────────────

/**
 * An animation preset (the Animate menu, Quick Apply) on layers at a comp time
 * — the engine's `applyPreset`, one entry over every layer. Resolves to
 * whether it applied (a refusal is toasted).
 */
export async function applyAnimationPresetEdit(nodeIds: readonly string[], preset: string, seconds: number): Promise<boolean> {
  const layers = nodeIds.filter((id) => isLayer(id));
  if (layers.length === 0) return false;
  const res = await edit('', { type: 'applyPreset', layers, preset, time: compTime(seconds) });
  return res.ok;
}

// ── New layers ────────────────────────────────────────────────────────

/**
 * Where a new layer lands: the composition the active tab edits, or — on a
 * drill-down tab whose "root" is a group layer — that group inside its comp.
 */
export function insertTarget(): { comp: string; parent?: string } | null {
  const root = activeCompIdNow();
  if (!root) return null;
  if (isCompItem(root)) return { comp: root };
  if (isLayer(root)) {
    const comp = compOfLayer(root);
    return comp ? { comp, parent: root } : null;
  }
  return null;
}

/**
 * A plain new layer through `createLayer` (null, adjustment, group, particle
 * system, a precomp instance): the engine's factory places it at the composition centre. The
 * new layer is selected. Resolves to its id, or null when nothing was made
 * (the caller keeps its legacy insert).
 */
export async function createLayerEdit(
  kind: Extract<LayerKind, 'null' | 'adjustment' | 'group' | 'precomp' | 'particle'>,
  opts: { name?: string; source?: string; label?: string } = {},
): Promise<string | null> {
  const target = insertTarget();
  if (!target) return null;
  const res = await edit(opts.label ?? '', {
    type: 'createLayer',
    comp: target.comp,
    kind,
    ...(target.parent ? { parent: target.parent } : {}),
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.source ? { source: opts.source } : {}),
    init: [],
  });
  if (!res.ok) return null;
  const id = (res.value[0] as { layer?: string } | undefined)?.layer ?? null;
  if (id) useSelectionStore.getState().set([id]);
  return id;
}
