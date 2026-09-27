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
import type { BezierPath, Command, MaskMode as ApiMaskMode, PropertyWrite, Value } from '@motion/engine-api';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readAnimatorData } from '@core/text/textAnimators';
import { readPathOps, pathOpPropPath, type PathOp, type PathOpType } from '@core/scene/pathOps';
import { getNodeLayerStyles, layerStyleEffectId, LAYER_STYLE_COLOR_PARAMS, LAYER_STYLE_NUMBER_PARAMS, type LayerStyles } from '@core/effects/layerStyles';
import { effectPropPath, parseColorChannels } from '@core/effects/effects';
import { STYLE_FIELDS } from '@core/engine/effectFieldSpecs';
import { memberWrites } from '@core/engine/propRefs';
import { activePlayheadSeconds, apiColorOfHex } from '@core/engine/trackWrites';
import { catalogFor } from '@core/engine/props';
import type { MaskPath } from '@core/effects/mask';
import { activeCompRootId } from '@core/scene/activeComp';
import { insertAudio, insertMedia, insertSvgDocument, isSvgAsset, readSvgText } from '@core/scene/sceneInsert';
import { documentMirror } from '@stores/documentMirror';
import { buildSvgLayerFragment } from '@/engine-client/svgFragment';
import { buildSvgShapeGroup, type BuiltSvgShapes } from '@core/svg/svgConvert';
import { forgetSvgLayerSrc, readSvgLayer } from '@core/svg/svgLayer';
import { buildLayerFragment, type BuiltLayers } from '@core/engine/offDocument';
import { apiParentOf, compOfLayer, layerIdsOfComp } from '@core/engine/doc';
import { useSelectionStore } from '@stores/selectionStore';
import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { set3DEnabled } from '@core/scene/threeD';
import type { SceneNode } from '@core/types';

const setProps = (writes: readonly PropertyWrite[]): Command => ({
  type: 'setProperties',
  writes: writes.map((w) => ({ prop: w.prop, value: w.value, ...(w.time !== undefined ? { time: w.time } : {}) })),
} as Command);

/** Whether the layer's catalog has `path` (a binding exists). */
function hasPath(layer: string, path: string): boolean {
  try {
    return catalogFor(layer).byPath.has(path);
  } catch {
    return false;
  }
}

/** The binding at `path`, typed as a field write of `raw`, or null. */
function fieldValue(layer: string, path: string, raw: unknown): Value | null {
  let b;
  try {
    b = catalogFor(layer).byPath.get(path);
  } catch {
    return null;
  }
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
  const node = defaultSceneGraph.getNode(layer);
  const index = node ? readAnimatorData(node).findIndex((a) => a.id === id) : -1;
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
  const node = defaultSceneGraph.getNode(layer);
  const a = node ? readAnimatorData(node)[index] : undefined;
  if (!a) throw new AiEngineError('notFound', `'${layer}' has no animator at index ${index}`);
  const base = `text/animators/${a.id}`;
  const sel = a.selectors?.[0]?.id;
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
      addColor = !hasPath(layer, `${base}/props/color`);
      continue;
    }
    if (SELECTOR0_FIELDS.has(key) && sel) {
      const path = `${base}/selectors/${sel}/${key}`;
      const value = fieldValue(layer, path, v);
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
  const writes = Object.keys(nums).length > 0 ? memberWrites(layer, nums, activePlayheadSeconds()) : [];
  if (!writes) refuse('text_animator', Object.keys(nums));
  const all = [...fields, ...writes];
  if (all.length > 0) await session.apply([setProps(all)]);
}

// ── Shape operators (Contents ▸ Trim Paths, Repeater, Zig-Zag, …) ────

/** Numeric params and fields of a path operator as writes (stored units). */
function pathOpWrites(layer: string, opId: string, patch: Readonly<Record<string, unknown>>): PropertyWrite[] {
  const nums: Record<string, number> = {};
  const fields: PropertyWrite[] = [];
  const bad: string[] = [];
  for (const [key, v] of Object.entries(patch)) {
    if (v === undefined || key === 'id' || key === 'type') continue;
    if (typeof v === 'number') { nums[pathOpPropPath(opId, key as never)] = v; continue; }
    const path = `contents/${opId}/${key}`;
    const value = fieldValue(layer, path, v);
    if (value) fields.push({ prop: { layer, path }, value });
    else bad.push(key);
  }
  if (bad.length > 0) refuse('path operator', bad);
  const writes = Object.keys(nums).length > 0 ? memberWrites(layer, nums, activePlayheadSeconds()) : [];
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
  const writes = pathOpWrites(layer, opId, patch);
  if (writes.length > 0) await session.apply([setProps(writes)]);
  return opId;
}

/** `updatePathOp(layer, opId, patch)` as ONE `setProperties` (the operator's type is not patched here). */
export async function patchPathOperator(session: AiEngineSession, layer: string, opId: string, patch: Readonly<Record<string, unknown>>): Promise<void> {
  const node = defaultSceneGraph.getNode(layer);
  if (!node || !readPathOps(node).some((o) => o.id === opId)) throw new AiEngineError('notFound', `'${layer}' has no path operator '${opId}'`);
  const writes = pathOpWrites(layer, opId, patch);
  if (writes.length > 0) await session.apply([setProps(writes)]);
}

/** The layer's operator of `type` (the first), adding one at the end of the chain if absent; resolves to its id. */
export async function ensurePathOperator(session: AiEngineSession, layer: string, type: 'trim' | 'repeater'): Promise<string> {
  const node = defaultSceneGraph.getNode(layer);
  const existing = node ? readPathOps(node).find((o: PathOp) => o.type === type) : undefined;
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
  const styles = getNodeLayerStyles(layer) as Record<string, { enabled?: boolean } | undefined>;
  const cur = styles[key];
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
  const writes = Object.keys(nums).length > 0 ? memberWrites(layer, nums, activePlayheadSeconds()) : [];
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
    const writes = memberWrites(layer, nums, activePlayheadSeconds());
    if (!writes) refuse('create_mask', Object.keys(nums));
    await session.apply([setProps(writes)]);
  }
  return id;
}

// ── Inserts built off-document (media, SVG) ──────────────────────────

/**
 * Run a legacy insert off-document and send its layers as ONE `pasteLayers`
 * (offDocument.ts — the UI's own route for inserts `createLayer` cannot carry:
 * a fitted footage box, an SVG document, a converted group). Resolves to the
 * new top layer's id; null when the builder added nothing.
 */
async function pasteBuilt(session: AiEngineSession, comp: string, built: BuiltLayers | null, extra: readonly Command[] = []): Promise<string | null> {
  if (!built) return null;
  const r = await session.apply([
    { type: 'pasteLayers', comp, fragment: built.fragment, index: built.index, ...(built.parent ? { parent: built.parent } : {}) } as Command,
    ...extra,
  ]);
  const ids = (r[0] as { layers?: string[] }).layers ?? [];
  const at = built.tops[0] ? built.scratchIds.indexOf(built.tops[0]) : 0;
  return ids[at >= 0 ? at : 0] ?? null;
}

/**
 * Place an imported asset as a layer, as the Project panel's insert does
 * (`insertMedia`: contain-fitted to the comp, an SVG routed to its document
 * layer or editable shapes, audio as an audio layer) — built off-document,
 * inserted with ONE `pasteLayers`. Resolves to the new layer's id.
 */
export async function insertAssetLayer(session: AiEngineSession, asset: ImportedAsset, at?: { x?: number; y?: number }): Promise<string | null> {
  const comp = activeCompRootId() as string;
  let svgText: string | null = null;
  if (asset.type !== 'audio' && isSvgAsset(asset)) {
    svgText = await readSvgText(asset.src);
    if (!svgText) throw new AiEngineError('io', `the SVG '${asset.name}' could not be read`);
  }
  const sizeHint = Math.max(asset.metadata?.width ?? 0, asset.metadata?.height ?? 0) || undefined;
  const built = buildLayerFragment(comp, () => {
    if (asset.type === 'audio') insertAudio(asset);
    else if (svgText !== null) insertSvgDocument(svgText, asset.name, { sizeHint });
    // Not an SVG: insertMedia's body is synchronous (its only await is the SVG read).
    else void insertMedia(asset);
    // The inserters select what they made: place it (a SCRATCH write, like the insert).
    const id = useSelectionStore.getState().ids[0];
    const node = id ? defaultSceneGraph.getNode(id) : undefined;
    const t = node?.components.find((c) => c.type === 'Transform');
    if (node && t && at?.x !== undefined) defaultSceneGraph.writeProp(node.id, t.id, 'x', at.x);
    if (node && t && at?.y !== undefined) defaultSceneGraph.writeProp(node.id, t.id, 'y', at.y);
  });
  return pasteBuilt(session, comp, built);
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
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || !readSvgLayer(node)) return null;
  const comp = compOfLayer(nodeId);
  if (!comp) return null;
  let result: BuiltSvgShapes | null = null;
  const built = buildLayerFragment(comp, () => { result = buildSvgShapeGroup(nodeId); });
  if (!built || !(result as BuiltSvgShapes | null)) return null;
  // Replace in place (AE's conversions put the result where the source was):
  // the SVG layer's comp-stack slot, inside the same parent layer when nested.
  const parent = apiParentOf(nodeId);
  const slot = layerIdsOfComp(comp).indexOf(nodeId);
  const r = await session.apply([
    { type: 'pasteLayers', comp, fragment: built.fragment, index: slot >= 0 ? slot : built.index, ...(parent ? { parent } : built.parent ? { parent: built.parent } : {}) } as Command,
    { type: 'deleteLayers', layers: [nodeId] } as Command,
  ]);
  forgetSvgLayerSrc(nodeId);
  return (r[0] as { layers?: string[] }).layers?.[0] ?? null;
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
 * compositor does not draw glTF meshes yet), built off-document and inserted
 * with ONE `pasteLayers`: `createLayer` has no footage source for a null.
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
      props: { [SCENE_KIND_PROP]: 'null', x: at.x, y: at.y, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0, width: 100, height: 100, assetId },
    }],
  };
  const built = buildLayerFragment(comp, () => {
    defaultSceneGraph.addChild(comp, node);
    set3DEnabled(node.id, true);
  });
  return pasteBuilt(session, comp, built);
}
