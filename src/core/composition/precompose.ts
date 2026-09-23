/* eslint-disable no-restricted-syntax -- F11: the `.props` writes and the
 * `components.push` in this file are on a node literal from `makeNode` that has
 * not been added to the graph yet — the case the rule's own message calls
 * legitimate. Every write to a node the graph already owns goes through
 * `defaultSceneGraph.writeProp` / the SceneGraph API, as the rule intends.
 */
/**
 * Pre-compose — After Effects' Layer ▸ Pre-compose (Ctrl+Shift+C).
 *
 * The selected layers go into a NEW COMPOSITION — a real one: it has its own
 * settings record and scene root, it is listed with the project's comps, and it
 * can be placed again anywhere. A comp instance referencing it takes the
 * layers' place in the stack. That is what makes a precomp reusable ("edit it
 * once, every use updates"), and it is the difference from the older in-place
 * precomp GROUP (`precomposeSelected` in sceneInsert), which is still what the
 * AI facade builds.
 *
 * AE's two modes:
 *
 *   • MOVE ALL ATTRIBUTES — the layers move into the new comp with everything on
 *     them (transform, effects, masks, keyframes, clip timing). The new comp is
 *     the size of this one and the instance sits centred, so every layer lands
 *     exactly where it was on screen. "Adjust composition duration to the time
 *     span of the selected layers" trims the new comp to the layers' bars and
 *     slides them to its start; the instance's bar starts where they did.
 *   • LEAVE ALL ATTRIBUTES — one footage-like layer: only its CONTENT (the
 *     media, the vector, the solid's colour) moves into a comp the size of the
 *     layer; the layer itself stays, and becomes the comp instance. It keeps
 *     its id, so its stack slot, timeline bar, keyframes, effects, masks,
 *     matte and every reference to it survive untouched — the keys do not even
 *     change axis, because the bar they were sampled through is the same bar.
 *
 * Keyframes are keyed by node id and stored on the clip's own time axis
 * (`compToKeyframeTime`), so moving a node — and sliding its clip — carries its
 * animation without rewriting a single key.
 *
 * The whole operation is ONE undo step (`runAsOneHistoryEntry`): it touches the
 * scene, the comp table, two timelines and possibly the tabs, and no smaller
 * inverse describes that.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { makeNode } from '@core/scene/sceneInsert';
import { COMP_REF_PROP } from '@core/scene/compInstance';
import { flattenComposition, readNodeKind } from '@core/scene/sceneDerive';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setParentPreservingWorld } from '@core/scene/parenting';
import { activeCompRootId } from '@core/scene/activeComp';
import { is3DEnabled } from '@core/scene/threeD';
import { readNodeLayerTime } from '@core/scene/layerTime';
import { CONTINUOUS_RASTER_PROP } from '@core/scene/continuousRaster';
import { makeSvgComponent, forgetSvgLayerSrc } from '@core/svg/svgLayer';
import { sanitizeSvg } from '@core/svg/svgSanitize';
import { snapshotNodeAnimation, applyNodeAnimation } from '@core/animation/cloneNodeAnimation';
import { defaultAnimation } from '@motion/animation';
import { useProjectStore, DEFAULT_COMP_SETTINGS, type CompositionSettings } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { bumpScene } from '@stores/sceneStore';
import { getTimelineController, mediaSourceFrames } from '@core/timeline/TimelineController';
import { shortId } from '@utils/lang';
import { addCompositionRecord } from './compositionOps';
import { openLayerComposition } from './compNavigation';
import { runAsOneHistoryEntry } from './compositeEdit';
import type { SceneNode } from '@core/types';

export type PrecomposeMode = 'leave' | 'move';

export interface PrecomposeOptions {
  /** Name of the new composition — and of the layer that replaces the selection. */
  name: string;
  mode: PrecomposeMode;
  /** Move mode only: size the new comp's duration to the selected layers' bars. */
  adjustDuration: boolean;
  /** Open the new composition afterwards (AE's "Open New Composition"). */
  openNew: boolean;
  /**
   * Engine API (src/core/engine): the composition to precompose in (default:
   * the active tab's), the ids to create (default: freshly minted), and
   * `quiet` — no selection change, no tab opened. The engine must be
   * deterministic and must not touch editor state.
   */
  hostId?: string;
  mint?: { compId: string; instanceId: string; contentId: string };
  quiet?: boolean;
}

export interface PrecomposeResult {
  compId: string;
  instanceId: string;
}

/** "Pre-comp N", the first N no composition is already called. */
export function defaultPrecompName(): string {
  const taken = new Set(Object.values(useProjectStore.getState().comps).map((c) => c.name.trim().toLowerCase()));
  let n = 1;
  while (taken.has(`pre-comp ${n}`)) n += 1;
  return `Pre-comp ${n}`;
}

function hasAncestorIn(id: string, set: ReadonlySet<string>): boolean {
  let parent = defaultSceneGraph.getNode(id)?.parent;
  for (let guard = 0; parent && guard < 256; guard++) {
    if (set.has(parent)) return true;
    parent = defaultSceneGraph.getNode(parent)?.parent;
  }
  return false;
}

/**
 * The layers a Pre-compose of `ids` actually moves, back to front in the
 * active comp's stack: known layers of THIS comp, never its root, and never a
 * layer that sits inside another selected one (it travels with its parent).
 */
export function precomposeTargets(ids: ReadonlyArray<string>, host?: string): string[] {
  const hostId = host ?? activeCompRootId();
  if (!defaultSceneGraph.getNode(hostId)) return [];
  const wanted = new Set(ids.filter((id) => id !== hostId && defaultSceneGraph.getNode(id)));
  return flattenComposition(defaultSceneGraph, hostId)
    .map((n) => n.id as string)
    .filter((id) => wanted.has(id) && !hasAncestorIn(id, wanted));
}

function componentProps(node: SceneNode, type: string): Record<string, unknown> | undefined {
  return node.components.find((c) => c.type === type)?.props as Record<string, unknown> | undefined;
}

/** A solid is a shape layer flagged `fx.solid`, filled by `fx.fill`. */
function isSolid(node: SceneNode): boolean {
  return componentProps(node, 'fx')?.solid === true;
}

/** fx keys that define the CONTENT's pixels rather than what the layer does to them. */
const CONTENT_FX_KEYS = ['solid', 'fill', 'fills', 'sequence', CONTINUOUS_RASTER_PROP] as const;

/** fx keys that deform the content itself — they cannot stay on a comp layer. */
const DEFORMER_FX_KEYS = ['puppet', 'skeleton', 'cornerPin'] as const;

/** Transform props that point at the content's source. */
const CONTENT_TRANSFORM_KEYS = ['src', 'assetId', 'audioMuted'] as const;

/** Animation that belongs to the content — the solid's colour, a path — not the layer. */
function isContentTrack(prop: string): boolean {
  return prop === 'fill' || prop.startsWith('fill_') || prop.startsWith('fill.') || prop === 'path.points';
}

/**
 * Why "Leave all attributes" cannot apply to `ids`, or null when it can. The
 * dialog shows the reason under the disabled option, as AE greys it out.
 *
 * Beyond AE's own rule (one layer, not text or shape) it also refuses what a
 * comp layer here cannot yet reproduce, rather than quietly changing the look:
 * the renderer draws a placed composition flat — so a 3D layer would render
 * differently the moment the content moved inside. (Its anchor point and its
 * motion blur it does honour.)
 */
export function leaveAttributesUnavailableReason(ids: ReadonlyArray<string>, hostId?: string): string | null {
  const targets = precomposeTargets(ids, hostId);
  if (targets.length !== 1) return 'Only available when a single layer is selected.';
  const id = targets[0]!;
  const node = defaultSceneGraph.getNode(id);
  if (!node) return 'Only available when a single layer is selected.';
  const kind = readNodeKind(node);
  const splittable = kind === 'image' || kind === 'video' || kind === 'svg' || (kind === 'shape' && isSolid(node));
  if (!splittable) {
    return kind === 'text' || kind === 'shape'
      ? `Not available for ${kind} layers — their content is not a separate source.`
      : 'Only available for footage, image, vector and solid layers.';
  }
  const t = componentProps(node, 'Transform') ?? {};
  if (!(Number(t.width) > 0 && Number(t.height) > 0)) return 'The layer has no size to build a composition from.';
  if (defaultSceneGraph.getChildren(id).length > 0) {
    return 'Other layers are parented to this one — unparent them first, or use Move all attributes.';
  }
  // A 3D composition layer is a flat CARD. It takes light (per card, not per
  // fragment) and turns in real perspective, but it cannot be extruded and it
  // is not in the shadow-map pass — so a 3D layer that is any of those would
  // change its look the moment its content moved inside.
  if (is3DEnabled(node)) return 'Not available for 3D layers yet — a 3D composition layer is a flat card: lit per card, never extruded, and outside the shadow pass.';
  // An off-centre anchor is fine: a composition layer turns around its anchor
  // point like any layer, and it keeps this layer's (see buildPrecompContainer).
  const fx = componentProps(node, 'fx') ?? {};
  if (DEFORMER_FX_KEYS.some((k) => fx[k] !== undefined)) {
    return 'Not available with puppet pins, bones or corner pin — they deform the content, which is moving.';
  }
  if (readNodeLayerTime(node)) return 'Not available for a time-stretched, reversed or frozen layer.';
  return null;
}

function subtreeIds(rootIds: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  const walk = (id: string): void => {
    out.push(id);
    for (const child of defaultSceneGraph.getChildren(id)) walk(child.id as string);
  };
  for (const id of rootIds) walk(id);
  return out;
}

/** The host comp's settings, filled from the defaults when it has no record. */
function hostSettings(hostId: string): Omit<CompositionSettings, 'id' | 'name'> {
  const c = useProjectStore.getState().comps[hostId];
  return c ? { ...DEFAULT_COMP_SETTINGS, ...c } : { ...DEFAULT_COMP_SETTINGS };
}

/**
 * A comp instance centred in a `width × height` frame — the shape
 * `insertCompInstance` builds, placed exactly rather than at the cursor.
 */
function makeInstanceNode(name: string, refCompId: string, x: number, y: number, width: number, height: number, id?: string): SceneNode {
  const node = makeNode('comp', name);
  if (id) {
    const minted = node.id;
    node.id = id;
    for (const c of node.components) if (c.id.startsWith(minted)) c.id = id + c.id.slice(minted.length);
  }
  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    t.props.x = x;
    t.props.y = y;
    t.props.width = width;
    t.props.height = height;
  }
  node.transform.position.x = x;
  node.transform.position.y = y;
  node.components.push({ id: `${node.id}_fx`, type: 'fx', props: { precomp: true, [COMP_REF_PROP]: refCompId } });
  return node;
}

/**
 * Put `instanceId` in `parentId`'s stack where `slot` non-moved siblings sit
 * below it — i.e. exactly where the frontmost moved layer was.
 */
function placeInStack(parentId: string, instanceId: string, slot: number): void {
  const order = defaultSceneGraph.getChildOrder(parentId).filter((id) => id !== instanceId);
  order.splice(Math.min(slot, order.length), 0, instanceId);
  defaultSceneGraph.setChildOrder(parentId, order);
}

/**
 * Hand clip geometry to `toCompId` for every node in `ids`, grouped by the
 * timeline that owns each one today. Done BEFORE the scene move: a scene sync
 * that ran in between would see the nodes gone from the host and delete their
 * trims, where a sync now only re-seeds bars the move then takes away again.
 */
function transferClips(ids: ReadonlyArray<string>, toCompId: string): void {
  const controller = getTimelineController();
  const byOwner = new Map<string, string[]>();
  for (const id of ids) {
    const owner = controller.compIdForNode(id);
    const list = byOwner.get(owner);
    if (list) list.push(id);
    else byOwner.set(owner, [id]);
  }
  for (const [owner, list] of byOwner) controller.transferNodeClips(list, owner, toCompId);
}

function moveAllAttributes(targets: string[], opts: PrecomposeOptions): PrecomposeResult {
  const hostId = opts.hostId ?? activeCompRootId();
  const host = hostSettings(hostId);
  const controller = getTimelineController();

  // Where the precomp layer goes: the frontmost selected layer's slot.
  const front = targets[targets.length - 1]!;
  const anchorParent = defaultSceneGraph.getNode(front)?.parent ?? hostId;
  const moved = new Set(targets);
  const orderBefore = defaultSceneGraph.getChildOrder(anchorParent);
  const frontIdx = orderBefore.indexOf(front);
  const slot = orderBefore.slice(0, Math.max(0, frontIdx)).filter((id) => !moved.has(id)).length;

  // The layers' span on the host clock, read before their clips move.
  let spanStart = Infinity;
  let spanEnd = -Infinity;
  if (opts.adjustDuration) {
    for (const id of targets) {
      for (const l of controller.getLayersForNode(id)) {
        spanStart = Math.min(spanStart, l.start);
        spanEnd = Math.max(spanEnd, l.start + l.duration);
      }
    }
  }
  const span = opts.adjustDuration && Number.isFinite(spanStart) && spanEnd > spanStart
    ? { start: spanStart, frames: spanEnd - spanStart }
    : null;

  const compId = addCompositionRecord({
    ...(opts.mint ? { id: opts.mint.compId } : {}),
    name: opts.name,
    width: host.width,
    height: host.height,
    fps: host.fps,
    durationSeconds: span ? span.frames / host.fps : host.durationSeconds,
    background: host.background,
    transparent: host.transparent,
    ...(host.pixelAspect !== undefined ? { pixelAspect: host.pixelAspect } : {}),
  });

  transferClips(subtreeIds(targets), compId);
  // Back to front, so the new comp's stack keeps their relative order.
  for (const id of targets) setParentPreservingWorld(id, compId);

  // Same size as the host and centred: comp space inside maps 1:1 onto the
  // host's, so nothing moves on screen.
  const instance = makeInstanceNode(opts.name, compId, host.width / 2, host.height / 2, host.width, host.height, opts.mint?.instanceId);
  defaultSceneGraph.addChild(hostId, instance);
  if (anchorParent !== hostId) setParentPreservingWorld(instance.id, anchorParent);
  placeInStack(anchorParent, instance.id, slot);

  controller.syncFromScene(compId);
  controller.syncFromScene(hostId);

  if (span) {
    const inner = controller.timelineForComp(compId);
    const innerTrack = inner?.timeline.getTrack(inner.trackId);
    if (inner && innerTrack) {
      inner.timeline.history.silently(() => {
        for (const l of [...innerTrack.layers]) inner.timeline.setLayerStart(l.id, l.start - span.start);
      });
    }
    const outer = controller.timelineForComp(hostId);
    const bar = controller.getLayersForNode(instance.id)[0];
    if (outer && bar) outer.timeline.history.silently(() => outer.timeline.setLayerStart(bar.id, span.start));
    controller.invalidateLayerIndex();
  }

  return { compId, instanceId: instance.id };
}

function leaveAllAttributes(layerId: string, opts: PrecomposeOptions): PrecomposeResult | null {
  const node = defaultSceneGraph.getNode(layerId);
  if (!node) return null;
  const hostId = opts.hostId ?? activeCompRootId();
  const host = hostSettings(hostId);
  const controller = getTimelineController();

  const kind = readNodeKind(node);
  const transform = node.components.find((c) => c.type === 'Transform');
  const style = node.components.find((c) => c.type === 'Style');
  const svg = node.components.find((c) => c.type === 'svg');
  const tp = (transform?.props ?? {}) as Record<string, unknown>;
  const fxProps = componentProps(node, 'fx') ?? {};
  const layerW = Number(tp.width);
  const layerH = Number(tp.height);
  const width = Math.max(1, Math.round(layerW));
  const height = Math.max(1, Math.round(layerH));

  // Footage keeps its own length (the comp IS the clip); stills, vectors and
  // solids last as long as this comp, as AE sizes a leave-attributes precomp.
  const sourceFrames = mediaSourceFrames(node, host.fps);
  const compId = addCompositionRecord({
    ...(opts.mint ? { id: opts.mint.compId } : {}),
    name: opts.name,
    width,
    height,
    fps: host.fps,
    durationSeconds: sourceFrames !== null ? sourceFrames / host.fps : host.durationSeconds,
    background: host.background,
    transparent: host.transparent,
  });

  // ── The content, untransformed and centred in its own comp ───────────
  const contentId = opts.mint?.contentId ?? `${kind}_${shortId()}`;
  const pick = (from: Record<string, unknown>, keys: ReadonlyArray<string>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (from[k] !== undefined) out[k] = structuredClone(from[k]);
    return out;
  };
  const contentFx = pick(fxProps, CONTENT_FX_KEYS);
  const styleProps = (style?.props ?? {}) as Record<string, unknown>;
  const components: SceneNode['components'] = [
    {
      id: `${contentId}_t`,
      type: 'Transform',
      props: {
        [SCENE_KIND_PROP]: kind,
        x: width / 2,
        y: height / 2,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        anchorX: 0,
        anchorY: 0,
        width: layerW,
        height: layerH,
        ...pick(tp, CONTENT_TRANSFORM_KEYS),
      },
    },
    {
      id: `${contentId}_s`,
      type: 'Style',
      props: { opacity: 100, ...(styleProps.fill !== undefined ? { fill: styleProps.fill } : {}) },
    },
  ];
  if (Object.keys(contentFx).length > 0) components.push({ id: `${contentId}_fx`, type: 'fx', props: contentFx });
  if (svg) {
    // The stored markup's ids are scoped to the node that holds it, so the
    // content's copy is sanitized again under its own id.
    const sp = svg.props as Record<string, unknown>;
    const sourceMarkup = String(sp.sourceMarkup ?? '');
    const capabilities = sp.capabilities as Parameters<typeof sanitizeSvg>[2];
    const clean = sourceMarkup ? sanitizeSvg(sourceMarkup, contentId.replace(/[^\w-]/g, '_'), capabilities) : null;
    components.push(makeSvgComponent(`${contentId}_svg`, {
      sourceMarkup,
      sanitizedMarkup: clean?.markup ?? String(sp.sanitizedMarkup ?? ''),
      size: {
        width: Number(sp.intrinsicWidth) || layerW,
        height: Number(sp.intrinsicHeight) || layerH,
        viewBox: (sp.viewBox as [number, number, number, number] | null | undefined) ?? null,
      },
      capabilities: capabilities as Parameters<typeof makeSvgComponent>[1]['capabilities'],
      fileName: String(sp.fileName ?? node.name ?? ''),
      livePlayback: sp.livePlayback === true,
    }));
  }
  defaultSceneGraph.addChild(compId, {
    id: contentId,
    name: node.name,
    parent: compId,
    children: [],
    transform: { position: { x: width / 2, y: height / 2 }, rotation: 0, scale: { x: 1, y: 1 } },
    components,
    visible: true,
    locked: false,
  } as unknown as SceneNode);

  // The content's own animation goes with it; everything else stays.
  const snap = snapshotNodeAnimation(layerId);
  const contentAnim = {
    tracks: snap.tracks.filter((t) => isContentTrack(t.prop)),
    dataTracks: snap.dataTracks.filter((t) => isContentTrack(t.prop)),
    expressions: snap.expressions.filter((e) => isContentTrack(e.prop)),
  };
  applyNodeAnimation(contentId, contentAnim);
  for (const t of contentAnim.tracks) defaultAnimation.removeTrack(layerId, t.prop);
  for (const t of contentAnim.dataTracks) defaultAnimation.setDataTrack(layerId, t.prop, null);
  for (const e of contentAnim.expressions) defaultAnimation.removeExpression(layerId, e.prop);

  // ── The layer itself becomes the composition layer, in place ─────────
  if (transform) {
    defaultSceneGraph.writeProp(layerId, transform.id, SCENE_KIND_PROP, 'comp');
    for (const k of CONTENT_TRANSFORM_KEYS) defaultSceneGraph.writeProp(layerId, transform.id, k, undefined);
  }
  if (style && styleProps.fill !== undefined) defaultSceneGraph.writeProp(layerId, style.id, 'fill', undefined);
  for (const k of CONTENT_FX_KEYS) defaultSceneGraph.setFxKey(layerId, k, undefined);
  if (svg) {
    defaultSceneGraph.removeComponent(layerId, 'svg');
    forgetSvgLayerSrc(layerId);
  }
  defaultSceneGraph.setFxKey(layerId, 'precomp', true);
  defaultSceneGraph.setFxKey(layerId, COMP_REF_PROP, compId);
  // AE names the precomp layer after the composition it now shows.
  node.name = opts.name;

  // The content's bar starts at the new comp's 0 with the footage's own
  // in-point there; the layer's bar in this comp is untouched, so its trim
  // still picks the same stretch of footage — now through the comp.
  controller.syncFromScene(compId);
  controller.syncFromScene(hostId);

  return { compId, instanceId: layerId };
}

/**
 * Pre-compose `ids` right now, with no history entry — the core that
 * `precomposeLayers` wraps, and what tests drive. Null when nothing qualifies
 * (including Leave on a selection it cannot split).
 */
export function precomposeNow(ids: ReadonlyArray<string>, opts: PrecomposeOptions): PrecomposeResult | null {
  const targets = precomposeTargets(ids);
  if (targets.length === 0) return null;
  const named = { ...opts, name: opts.name.trim() || defaultPrecompName() };
  let result: PrecomposeResult | null;
  if (named.mode === 'leave') {
    result = leaveAttributesUnavailableReason(targets, opts.hostId) === null ? leaveAllAttributes(targets[0]!, named) : null;
  } else {
    result = moveAllAttributes(targets, named);
  }
  if (!result) return null;
  if (!named.quiet) useSelectionStore.getState().set([result.instanceId]);
  bumpScene();
  if (named.openNew && !named.quiet) openLayerComposition(result.instanceId);
  return result;
}

/** AE's Pre-compose as one undoable step. */
export function precomposeLayers(ids: ReadonlyArray<string>, opts: PrecomposeOptions): Promise<PrecomposeResult | null> {
  return runAsOneHistoryEntry('Pre-compose', () => precomposeNow(ids, opts));
}
