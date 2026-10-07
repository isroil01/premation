/**
 * Engine-command builders for the AI tool handlers (B5, docs/ENGINE_API.md §12,
 * §15.6): the writes the tools used to make through legacy document helpers
 * (`addTextAnimator` / `updateAnimator`, `addPathOp` / `updatePathOp`,
 * `updateDropShadow`, `set3DEnabled`, `addMaskPath`, …), sent on the turn's
 * engine session instead — the same commands the Inspector sends, so a turn
 * is one engine gesture, replayable from the command log in either engine.
 *
 * Values arrive in the helpers' STORED units (what the legacy writers took);
 * `memberWrites` converts to API units per track. A write the API does not
 * address is refused (`AiEngineError`, a failed tool call) — never made
 * around the engine.
 */

import { AiEngineError, type AiEngineSession } from '@motion/ai-tools';
import { secondsToFlicks, type BezierPath, type Command, type MaskMode as ApiMaskMode, type PropertyInfo, type PropertyWrite, type Value } from '@motion/engine-api';
import { pathOpPropPath, type PathOpType } from '@core/scene/pathOps';
import { layerStyleEffectId, LAYER_STYLE_COLOR_PARAMS, LAYER_STYLE_NUMBER_PARAMS, type LayerStyles } from '@core/effects/layerStyles';
import { effectPropPath, parseColorChannels } from '@core/effects/effects';
import { STYLE_FIELDS } from '@core/engine/effectFieldSpecs';
import { memberWrites } from '@core/engine/propRefs';
import { activePlayheadSeconds, apiColorOfHex } from '@core/engine/trackWrites';
import type { MaskPath } from '@core/effects/mask';
import { activeCompRootId } from '@core/scene/activeComp';
import { buildMedia, isSvgAsset, readSvgText } from '@core/scene/layerBuilders';
import { documentMirror } from '@stores/documentMirror';
import { engineIdle } from '@core/engine/engineInstance';
import { buildSvgLayerFragment } from '@/engine-client/svgFragment';
import { buildSvgShapeGroupInto, mirrorCarry } from '@core/svg/svgConvert';
import { fetchSvgLayerData } from '@core/svg/svgLayerData';
import { forgetSvgLayerSrc } from '@core/svg/svgLayer';
import { apiParentOf, layerIdsOfComp } from '@core/mirror/docFacts';
import { FragmentBuilder, type BuiltFragment } from '@/engine-client/fragmentBuilder';
import { insertFrame } from '@/engine-client/insertFragment';
import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { SCENE_KIND_PROP } from '@core/scene/sceneKind';
import type { SceneNode } from '@core/types';

const setProps = (writes: readonly PropertyWrite[]): Command => ({
  type: 'setProperties',
  writes: writes.map((w) => ({ prop: w.prop, value: w.value, ...(w.time !== undefined ? { time: w.time } : {}) })),
} as Command);

/** The layer's properties under `path`, by path, asked of the engine. */
async function propertiesUnder(session: AiEngineSession, layer: string, path: string): Promise<ReadonlyMap<string, PropertyInfo>> {
  try {
    const tree = await session.query({ type: 'getPropertyTree', layer, path, depth: 0 });
    return new Map(tree.nodes.map((n) => [n.path, n]));
  } catch {
    // No group there yet (a layer without styles): nothing under it.
    return new Map();
  }
}

/** The property `b`, typed as a field write of `raw`, or null. */
function fieldValue(b: PropertyInfo | undefined, raw: unknown): Value | null {
  if (!b) return null;
  if (b.valueType === 'choice' && typeof raw === 'string' && (!b.choices || b.choices.includes(raw))) return { kind: 'choice', value: raw };
  if (b.valueType === 'bool' && typeof raw === 'boolean') return { kind: 'bool', value: raw };
  if (b.valueType === 'string' && typeof raw === 'string') return { kind: 'string', value: raw };
  if (b.valueType === 'color' && typeof raw === 'string') return apiColorOfHex(raw);
  if (b.valueType === 'scalar' && typeof raw === 'number' && Number.isFinite(raw)) return { kind: 'scalar', value: raw };
  return null;
}

function refuse(what: string, keys: readonly string[]): never {
  throw new AiEngineError('unsupported', `${what}: the engine API does not address ${keys.join(', ')}`);
}

// ── What a write composes from (asked of the engine) ─────────────────

/**
 * The child GROUPS of `path` on a layer (`contents`, `text/animators`), in
 * order — asked of the engine (`getPropertyTree`): the facts a write is
 * composed from, exact at the write's revision.
 */
async function childGroupsOf(session: AiEngineSession, layer: string, path: string): Promise<PropertyInfo[]> {
  let nodes: readonly PropertyInfo[];
  try {
    nodes = (await session.query({ type: 'getPropertyTree', layer, path, depth: 0 })).nodes;
  } catch {
    return [];
  }
  const prefix = `${path}/`;
  return nodes.filter((n) => n.kind !== 'property' && n.path.startsWith(prefix) && !n.path.slice(prefix.length).includes('/'));
}

const lastSegment = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** A text layer's animators, in order: each id and its selectors' ids. */
export async function textAnimators(session: AiEngineSession, layer: string): Promise<Array<{ id: string; selectors: string[] }>> {
  const out: Array<{ id: string; selectors: string[] }> = [];
  for (const a of await childGroupsOf(session, layer, 'text/animators')) {
    const selectors = (await childGroupsOf(session, layer, `${a.path}/selectors`)).map((g) => lastSegment(g.path));
    out.push({ id: lastSegment(a.path), selectors });
  }
  return out;
}

/** A layer's shape operators (Contents ▸ Trim Paths, Repeater, …), in chain order. */
export async function pathOperators(session: AiEngineSession, layer: string): Promise<Array<{ id: string; type: string; params: Record<string, number> }>> {
  let nodes: readonly PropertyInfo[];
  try {
    nodes = (await session.query({ type: 'getPropertyTree', layer, path: 'contents', depth: 0 })).nodes;
  } catch {
    return [];
  }
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  return nodes
    .filter((g) => g.kind !== 'property' && g.matchName.startsWith('pathop:') && g.path.split('/').length === 2)
    .map((g) => {
      // The operator's static numeric params (stored units), by key.
      const params: Record<string, number> = {};
      for (const c of g.children) {
        const v = byPath.get(c)?.value;
        if (v?.kind === 'scalar') params[lastSegment(c)] = v.value;
      }
      return { id: lastSegment(g.path), type: g.matchName.slice('pathop:'.length), params };
    });
}

// ── Switches ─────────────────────────────────────────────────────────

/** The layer's 3D switch (`set3DEnabled`'s replacement). */
export async function setThreeD(session: AiEngineSession, layer: string, on: boolean): Promise<void> {
  await session.apply([{ type: 'setLayerSwitches', layers: [layer], patch: { threeD: on } } as Command]);
}

// ── Text animators ───────────────────────────────────────────────────

/** Add an animator (AE Animate ▸ …) at the end of the layer's list; resolves to its INDEX (the `ta.<i>.*` tracks). */
export async function addTextAnimatorGroup(session: AiEngineSession, layer: string): Promise<number> {
  const r = await session.apply([{ type: 'addPropertyGroup', layer, parent: 'text/animators', matchName: 'ADBE Text Animator', init: [] } as Command]);
  const path = (r[0] as { groups?: string[] }).groups?.[0] ?? '';
  const id = path.split('/')[2];
  const index = (await textAnimators(session, layer)).findIndex((a) => a.id === id);
  if (index < 0) throw new AiEngineError('internal', `the new animator '${path}' is not on '${layer}'`);
  return index;
}

/** Selector-0 fields a flat animator patch may carry (the legacy aliases). */
const SELECTOR0_FIELDS = new Set(['basedOn', 'shape', 'mode', 'units', 'randomizeOrder']);

/**
 * `updateAnimator(layer, index, patch)` as commands: numbers are the
 * `ta.<index>.<key>` tracks (selector 0's Start / End / Offset included), the
 * choices selector 0's fields, `color` the optional Fill Color (added first).
 * Numbers land at the playhead (a key where the property is animated).
 */
export async function patchTextAnimator(session: AiEngineSession, layer: string, index: number, patch: Readonly<Record<string, unknown>>): Promise<void> {
  const a = (await textAnimators(session, layer))[index];
  if (!a) throw new AiEngineError('notFound', `'${layer}' has no animator at index ${index}`);
  const base = `text/animators/${a.id}`;
  const props = await propertiesUnder(session, layer, base);
  const sel = a.selectors[0];
  const nums: Record<string, number> = {};
  const fields: PropertyWrite[] = [];
  const bad: string[] = [];
  let addColor = false;
  let color: string | undefined;
  for (const [key, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (typeof v === 'number') { nums[`ta.${index}.${key}`] = v; continue; }
    if (key === 'color' && typeof v === 'string') {
      color = v;
      addColor = !props.has(`${base}/props/color`);
      continue;
    }
    if (SELECTOR0_FIELDS.has(key) && sel) {
      const path = `${base}/selectors/${sel}/${key}`;
      const value = fieldValue(props.get(path), v);
      if (value) { fields.push({ prop: { layer, path }, value }); continue; }
    }
    bad.push(key);
  }
  if (bad.length > 0) refuse('text_animator', bad);
  if (addColor) await session.apply([{ type: 'addProperties', parent: { layer, path: `${base}/props` }, names: ['color'] } as Command]);
  if (color !== undefined) {
    const value = apiColorOfHex(color);
    if (!value) refuse('text_animator', ['color']);
    fields.push({ prop: { layer, path: `${base}/props/color` }, value });
  }
  const writes = Object.keys(nums).length > 0 ? await memberWritesNow(layer, nums) : [];
  if (!writes) refuse('text_animator', Object.keys(nums));
  const all = [...fields, ...writes];
  if (all.length > 0) await session.apply([setProps(all)]);
}

/**
 * `memberWrites` over the layer's property tree as the engine has it NOW:
 * the tree loaded (the turn may touch a layer nobody selected) and the mirror
 * caught up with what this turn just added (a new operator / animator / style).
 * Without both, a member of a group added a moment ago is "not addressable".
 */
async function memberWritesNow(layer: string, nums: Readonly<Record<string, number>>): Promise<PropertyWrite[] | null> {
  await documentMirror().loadTree(layer);
  await engineIdle();
  return memberWrites(layer, nums, activePlayheadSeconds());
}

// ── Shape operators (Contents ▸ Trim Paths, Repeater, Zig-Zag, …) ────

/** Numeric params and fields of a path operator as writes (stored units). */
async function pathOpWrites(layer: string, opId: string, patch: Readonly<Record<string, unknown>>, props: ReadonlyMap<string, PropertyInfo>): Promise<PropertyWrite[]> {
  const nums: Record<string, number> = {};
  const fields: PropertyWrite[] = [];
  const bad: string[] = [];
  for (const [key, v] of Object.entries(patch)) {
    if (v === undefined || key === 'id' || key === 'type') continue;
    if (typeof v === 'number') { nums[pathOpPropPath(opId, key as never)] = v; continue; }
    const path = `contents/${opId}/${key}`;
    const value = fieldValue(props.get(path), v);
    if (value) fields.push({ prop: { layer, path }, value });
    else bad.push(key);
  }
  if (bad.length > 0) refuse('path operator', bad);
  const writes = Object.keys(nums).length > 0 ? await memberWritesNow(layer, nums) : [];
  if (!writes) refuse('path operator', Object.keys(nums));
  return [...fields, ...writes];
}

/**
 * `addPathOp(layer, { ...op })` as commands: the operator is added (`contents`
 * ▸ `pathop:<type>`, the engine mints its id), then its parameters written.
 * Resolves to the new operator's id — `pathop.<id>.<param>` is its tracks.
 */
export async function addPathOperator(session: AiEngineSession, layer: string, type: PathOpType, patch: Readonly<Record<string, unknown>> = {}): Promise<string> {
  const r = await session.apply([{ type: 'addPropertyGroup', layer, parent: 'contents', matchName: `pathop:${type}`, init: [] } as Command]);
  const opId = ((r[0] as { groups?: string[] }).groups?.[0] ?? '').split('/')[1] ?? '';
  if (!opId) throw new AiEngineError('internal', `adding a ${type} to '${layer}' returned no operator`);
  const writes = await pathOpWrites(layer, opId, patch, await propertiesUnder(session, layer, `contents/${opId}`));
  if (writes.length > 0) await session.apply([setProps(writes)]);
  return opId;
}

/** `updatePathOp(layer, opId, patch)` as ONE `setProperties` (the operator's type is not patched here). */
export async function patchPathOperator(session: AiEngineSession, layer: string, opId: string, patch: Readonly<Record<string, unknown>>): Promise<void> {
  if (!(await pathOperators(session, layer)).some((o) => o.id === opId)) throw new AiEngineError('notFound', `'${layer}' has no path operator '${opId}'`);
  const writes = await pathOpWrites(layer, opId, patch, await propertiesUnder(session, layer, `contents/${opId}`));
  if (writes.length > 0) await session.apply([setProps(writes)]);
}

/** The layer's operator of `type` (the first), adding one at the end of the chain if absent; resolves to its id. */
export async function ensurePathOperator(session: AiEngineSession, layer: string, type: 'trim' | 'repeater'): Promise<string> {
  const existing = (await pathOperators(session, layer)).find((o) => o.type === type);
  return existing ? existing.id : addPathOperator(session, layer, type);
}

// ── Layer styles ─────────────────────────────────────────────────────

/**
 * `updateDropShadow` / `updateOuterGlow`: the style is added (with its
 * defaults, switched on) when the layer has none, then patched — switches as
 * field writes, numbers and colours at the playhead. STORED units (opacity
 * 0..1, hex colours), as the style object holds them.
 */
export async function patchLayerStyle(session: AiEngineSession, layer: string, styleKey: keyof LayerStyles, patch: Readonly<Record<string, unknown>>): Promise<void> {
  const key = styleKey as string;
  // The style group as the engine reports it (`styles/<key>`, `enabled` = its switch).
  const cur = (await propertiesUnder(session, layer, 'styles')).get(`styles/${key}`);
  if (!cur) await session.apply([{ type: 'addPropertyGroup', layer, parent: 'styles', matchName: `style:${key}`, init: [] } as Command]);
  else if (patch.enabled === true && cur.enabled === false) {
    await session.apply([{ type: 'setGroupEnabled', groups: [{ layer, path: `styles/${key}` }], enabled: true } as Command]);
  }
  const fields: PropertyWrite[] = [];
  const nums: Record<string, number> = {};
  const bad: string[] = [];
  const fxId = layerStyleEffectId(styleKey);
  for (const [field, v] of Object.entries(patch)) {
    if (v === undefined || field === 'enabled') continue;
    const sw = STYLE_FIELDS.find((f) => f.style === key && f.key === field);
    if (sw) {
      const path = `styles/${key}/${field}`;
      if (sw.type === 'bool' && typeof v === 'boolean') fields.push({ prop: { layer, path }, value: { kind: 'bool', value: v } });
      else if (sw.type === 'choice' && typeof v === 'string') fields.push({ prop: { layer, path }, value: { kind: 'choice', value: v } });
      else bad.push(field);
      continue;
    }
    const n = LAYER_STYLE_NUMBER_PARAMS[key]?.[field];
    const c = LAYER_STYLE_COLOR_PARAMS[key]?.[field];
    if (n && typeof v === 'number' && Number.isFinite(v)) {
      nums[effectPropPath(fxId, n.param)] = v * n.scale;
    } else if (c && typeof v === 'string') {
      const track = effectPropPath(fxId, c);
      const [r, g, b, a] = parseColorChannels(v);
      Object.assign(nums, { [`${track}_r`]: r, [`${track}_g`]: g, [`${track}_b`]: b, [`${track}_a`]: a });
    } else bad.push(field);
  }
  if (bad.length > 0) refuse(`layer style ${key}`, bad);
  const writes = Object.keys(nums).length > 0 ? await memberWritesNow(layer, nums) : [];
  if (!writes) refuse(`layer style ${key}`, Object.keys(nums));
  const all = [...fields, ...writes];
  if (all.length > 0) await session.apply([setProps(all)]);
}

// ── Masks ────────────────────────────────────────────────────────────

const API_MASK_MODES: ReadonlySet<string> = new Set(['none', 'add', 'subtract', 'intersect', 'lighten', 'darken', 'difference']);

/**
 * `addMaskPath(layer, mask)` as `addMask` + its Feather / Opacity / Expansion
 * (`masks/<id>/…`, stored units: opacity 0..1). Resolves to the engine's mask id.
 */
export async function addMaskFromPath(session: AiEngineSession, layer: string, mask: MaskPath, bezier: BezierPath): Promise<string> {
  const mode = API_MASK_MODES.has(mask.mode) ? (mask.mode as ApiMaskMode) : null;
  if (!mode) refuse('create_mask', [`mode ${mask.mode}`]);
  const r = await session.apply([{ type: 'addMask', layer, path: bezier, mode, inverted: !!mask.inverted, ...(mask.name ? { name: mask.name } : {}) } as Command]);
  const id = ((r[0] as { groups?: string[] }).groups?.[0] ?? '').split('/')[1] ?? '';
  if (!id) throw new AiEngineError('internal', `adding a mask to '${layer}' returned no mask`);
  const nums: Record<string, number> = {};
  if (mask.feather) nums[`mask.${id}.feather`] = mask.feather;
  if (mask.opacity !== undefined && mask.opacity !== 1) nums[`mask.${id}.opacity`] = mask.opacity;
  if (mask.expansion) nums[`mask.${id}.expansion`] = mask.expansion;
  if (Object.keys(nums).length > 0) {
    const writes = await memberWritesNow(layer, nums);
    if (!writes) refuse('create_mask', Object.keys(nums));
    await session.apply([setProps(writes)]);
  }
  return id;
}

// ── Inserts laid into fragments (media, SVG) ──────────────────────────

/**
 * Send a built fragment as ONE `pasteLayers` (the UI's own route for inserts
 * `createLayer` cannot carry: a fitted footage box, an SVG document, a 3D
 * null with a model source). Resolves to the pasted id of scratch layer
 * `pick` (default: the front-most top-level layer); null when nothing was built.
 */
async function pasteFragment(session: AiEngineSession, comp: string, built: BuiltFragment | null, pick?: string): Promise<string | null> {
  if (!built) return null;
  const r = await session.apply([{ type: 'pasteLayers', comp, fragment: built.fragment } as Command]);
  const ids = (r[0] as { layers?: string[] }).layers ?? [];
  const want = pick ?? built.tops[0];
  const at = want ? built.scratchIds.indexOf(want) : 0;
  return ids[at >= 0 ? at : 0] ?? null;
}

/**
 * Place an imported asset as a layer, as the Project panel's insert does
 * (layerBuilders.ts `buildMedia`: contain-fitted to the comp, an SVG routed to
 * its document layer or editable shapes, audio as an audio layer) — laid into
 * a fragment, inserted with ONE `pasteLayers`. Resolves to the new layer's id.
 */
export async function insertAssetLayer(session: AiEngineSession, asset: ImportedAsset, at?: { x?: number; y?: number }): Promise<string | null> {
  const comp = activeCompRootId() as string;
  let svgText: string | null = null;
  if (asset.type !== 'audio' && isSvgAsset(asset)) {
    svgText = await readSvgText(asset.src);
    if (!svgText) throw new AiEngineError('io', `the SVG '${asset.name}' could not be read`);
  }
  const b = new FragmentBuilder({ idPrefix: 'ai' });
  const made = buildMedia(b, insertFrame(comp), asset, svgText);
  if (!made) return null;
  // The layer the insert selects, placed where the model asked.
  if (at?.x !== undefined) b.setProp(made.id, 'Transform', 'x', at.x);
  if (at?.y !== undefined) b.setProp(made.id, 'Transform', 'y', at.y);
  const id = await pasteFragment(session, comp, b.build(), made.id);
  made.report();
  return id;
}

/**
 * The sanitized SVG document layer at {x, y} — laid into a fragment by the
 * engine client (engine-client/svgFragment.ts, no off-document run) and
 * inserted with ONE `pasteLayers`. Null = the sanitizer refused the markup
 * (nothing sent).
 */
export async function insertSvgMarkupLayer(session: AiEngineSession, markup: string, name: string, at: { x?: number; y?: number }): Promise<string | null> {
  const comp = activeCompRootId() as string;
  const settings = documentMirror().comp(comp)?.settings;
  const made = buildSvgLayerFragment(markup, name, {
    compWidth: settings?.width ?? 1920,
    compHeight: settings?.height ?? 1080,
    ...(at.x !== undefined ? { x: at.x } : {}),
    ...(at.y !== undefined ? { y: at.y } : {}),
  });
  if (!made) return null;
  const r = await session.apply([{ type: 'pasteLayers', comp, fragment: made.built.fragment } as Command]);
  return ((r[0] as { layers?: string[] }).layers ?? [])[0] ?? null;
}

/**
 * Convert to Editable Shapes (svgLayerActions.ts `convertSvgToShapes`, the
 * Inspector's route): the parser runs off-document, the group is pasted at the
 * SVG layer's slot and the SVG layer deleted — ONE batch. Resolves to the
 * group's id; null when the SVG has no vector paths (nothing sent).
 */
export async function convertSvgLayer(session: AiEngineSession, nodeId: string): Promise<string | null> {
  const m = documentMirror();
  const layer = m.layer(nodeId);
  if (layer?.svg !== 'layer') return null;
  const data = await fetchSvgLayerData(nodeId);
  if (!data) return null;
  // Built on the client into a fragment (no page replica), as the Inspector's
  // Convert to Editable Shapes: the layer's own composition is the frame, its
  // stored transform / appearance the carry.
  const comp = layer.comp;
  await m.loadTree(nodeId);
  const b = new FragmentBuilder({ idPrefix: 'svgconv' });
  const r = buildSvgShapeGroupInto(b, insertFrame(comp), data, mirrorCarry(nodeId));
  const built = b.build();
  if (!built || !r) return null;
  // Replace in place (AE's conversions put the result where the source was):
  // the SVG layer's comp-stack slot, inside the same parent layer when nested.
  const parent = apiParentOf(nodeId);
  const slot = layerIdsOfComp(comp).indexOf(nodeId);
  const res = await session.apply([
    { type: 'pasteLayers', comp, fragment: built.fragment, index: Math.max(0, slot), ...(parent ? { parent } : {}) } as Command,
    { type: 'deleteLayers', layers: [nodeId] } as Command,
  ]);
  forgetSvgLayerSrc(nodeId);
  return (res[0] as { layers?: string[] }).layers?.[0] ?? null;
}

// ── Media bytes ──────────────────────────────────────────────────────

/** Import generated / attached bytes as a footage item (`importBytes`); resolves to the item's record. */
export async function importAssetBytes(session: AiEngineSession, file: File): Promise<ImportedAsset> {
  const data = new Uint8Array(await file.arrayBuffer());
  // `source: ai` — generated / attached media, filed as the AI's (the cloud-upload policy of the asset store).
  const r = await session.apply([{ type: 'importBytes', files: [{ name: file.name, data, mimeType: file.type, source: 'ai' }] } as Command]);
  const id = (r[0] as { items?: string[] }).items?.[0];
  const asset = id ? useAssetStore.getState().assets.find((a) => a.id === id) : undefined;
  if (!asset) throw new AiEngineError('io', `'${file.name}' was not imported`);
  return asset;
}

/**
 * A 3D null that anchors a generated model (`assetId` on its Transform — the
 * compositor does not draw glTF meshes yet), laid into a fragment and inserted
 * with ONE `pasteLayers`: `createLayer` has no footage source for a null. 3D as
 * `set3DEnabled` makes a layer: the depth props stored, answering lights.
 */
export async function insertModelPlaceholder(session: AiEngineSession, name: string, at: { x: number; y: number }, assetId: string): Promise<string | null> {
  const comp = activeCompRootId() as string;
  const id = `null_model_${Math.random().toString(36).slice(2, 10)}`;
  const node: SceneNode = {
    id, name, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: at.x, y: at.y }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{
      id: `${id}_t`,
      type: 'Transform',
      props: {
        [SCENE_KIND_PROP]: 'null', x: at.x, y: at.y, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0, width: 100, height: 100, assetId,
        acceptsLights: true, z: 0, rotationX: 0, rotationY: 0,
      },
    }],
  };
  const b = new FragmentBuilder({ idPrefix: 'ai' });
  b.addChild(null, node);
  return pasteFragment(session, comp, b.build());
}

// ── Layer bars ───────────────────────────────────────────────────────

/** One layer's bar, COMPOSITION seconds (`set_layer_timing`'s item). */
export interface LayerTimingSeconds {
  nodeId: string;
  /** Comp time at which the layer's source time 0 plays (AE Start Time). */
  startSec?: number;
  /** Comp time the bar starts. */
  inSec?: number;
  /** Comp time the bar ends. */
  outSec?: number;
}

/**
 * Bars as ONE absolute `setLayerTiming` (the timeline's own trim / move
 * primitive, ENGINE_API.md §3.1), seconds → flicks. Fields left out stay as
 * they are. Resolves to the number of layers the command carried; zero items
 * sends nothing.
 */
export async function applyLayerTiming(session: AiEngineSession, items: readonly LayerTimingSeconds[]): Promise<number> {
  const patches = items
    .map((i) => ({
      layer: i.nodeId,
      ...(i.startSec !== undefined ? { startTime: secondsToFlicks(i.startSec) } : {}),
      ...(i.inSec !== undefined ? { inPoint: secondsToFlicks(i.inSec) } : {}),
      ...(i.outSec !== undefined ? { outPoint: secondsToFlicks(i.outSec) } : {}),
    }))
    .filter((p) => Object.keys(p).length > 1);
  if (patches.length === 0) return 0;
  await session.apply([{ type: 'setLayerTiming', items: patches } as Command]);
  return patches.length;
}
