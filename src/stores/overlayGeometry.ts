/**
 * The overlay geometry MIRROR (B4 round 2, ENGINE_API.md §15.12): the
 * frame-synchronous geometry the viewport's overlays draw — world matrices,
 * drawn boxes, motion paths, text boxes — for the layers the viewport
 * subscribed (`setOverlayGeometry`).
 *
 * Two sources, one read:
 *   • the C++ engine draws the viewport (EngineSurface): the records arrive
 *     WITH each frame (FrameGeometry → the frame's meta) and are published
 *     here as that frame is drawn — the overlays show the geometry of the very
 *     frame under them;
 *   • the page's own renderer draws it: the TypeScript engine computes the
 *     same records for the painted time (core/engine/overlayGeometry.ts),
 *     once per (time, revision).
 *
 * No React per frame: painters read `overlayLayer` when they paint and
 * subscribe (`subscribeOverlayGeometry`) to repaint when a frame's geometry lands.
 */

import { flicksToSeconds, type OverlayKind, type OverlayLayerGeometry, type OverlayRequest, type OverlayRig, type OverlayRigOptions, type OverlayView } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { engineViewport, engineViewportNow } from '@core/engine/windowViewport';
import { documentMirror } from './documentMirror';

/**
 * The records of a viewport no engine frame carries (no FrameGeometry): what
 * an in-process engine computes for its own subscription at a comp time. The
 * TypeScript engine installs its producer here (core/engine/transport.ts) — the
 * page never calls into an engine's evaluation itself; with no producer
 * installed, a viewport the C++ engine does not draw has no geometry.
 */
export interface OverlayGeometryProducer {
  layersAt(viewport: number, seconds: number): OverlayLayerGeometry[];
  viewsAt(viewport: number, seconds: number): OverlayView[];
}

let producer: OverlayGeometryProducer | null = null;

/** An in-process engine's overlay producer (null removes it). */
export function installOverlayGeometryProducer(p: OverlayGeometryProducer | null): void {
  producer = p;
  computed.clear();
}

/** The editor's main viewport (EngineSurface's ENGINE_SURFACE_VIEWPORT): the id the overlays subscribe under in both engines. */
export const MAIN_VIEWPORT = 1;

/** One layer's merged geometry for a frame (the arrays of its records concatenated). */
export type OverlayLayer = Omit<OverlayLayerGeometry, 'layer'> & { layer: string };

interface FrameSet {
  /** Comp time, flicks. */
  time: number;
  revision: number;
  layers: Map<string, OverlayLayer>;
  /** B4 round 5: the subscribed views' cameras, by mode. */
  views: Map<string, OverlayView>;
}

function viewsByMode(views: ReadonlyArray<OverlayView> | undefined): Map<string, OverlayView> {
  const out = new Map<string, OverlayView>();
  for (const v of views ?? []) out.set(v.mode, v);
  return out;
}

const pushed = new Map<number, FrameSet>();
const computed = new Map<number, FrameSet>();
/** Viewports the C++ engine draws (EngineSurface in 'viewport' mode): their geometry is the frames'. */
const engineDriven = new Set<number>();
const listeners = new Map<number, Set<() => void>>();
const subscribed = new Map<number, string>();
/** The last subscription sent per viewport, settled once the engine has it. */
const pendingSubscription = new Map<number, Promise<void>>();
// The real-app harness (scripts/realapp) reads the live maps: what each
// viewport subscribed and the geometry its last drawn frame carried. By
// reference, installed once — nothing per frame.
if (typeof window !== 'undefined') {
  (window as unknown as { __premationOverlayGeometry?: unknown }).__premationOverlayGeometry = { pushed, engineDriven, subscribed };
}

function merge(records: ReadonlyArray<OverlayLayerGeometry>): Map<string, OverlayLayer> {
  const out = new Map<string, OverlayLayer>();
  for (const r of records) {
    const cur = out.get(r.layer);
    if (!cur) {
      out.set(r.layer, { ...r, matrix: [...r.matrix], box: [...r.box], corners: [...r.corners], path: [...r.path], pathKeys: [...r.pathKeys], pins: [...r.pins], bones: [...r.bones], textBox: [...r.textBox], pathFrames: [...r.pathFrames], pathNow: [...r.pathNow], local: [...(r.local ?? [])], ...(r.rig ? { rig: copyRig(r.rig) } : {}) });
      continue;
    }
    cur.matrix.push(...r.matrix);
    cur.box.push(...r.box);
    cur.corners.push(...r.corners);
    cur.path.push(...r.path);
    cur.pathKeys.push(...r.pathKeys);
    cur.pins.push(...r.pins);
    cur.bones.push(...r.bones);
    cur.textBox.push(...r.textBox);
    cur.pathFrames.push(...r.pathFrames);
    cur.pathNow.push(...r.pathNow);
    cur.local.push(...(r.local ?? []));
    // B4 round 5: the scene3d record rides one of the layer's records (the first).
    if (r.scene && !cur.scene) cur.scene = r.scene;
    // B4 round 5: a long rig spans records — its arrays concatenate.
    if (r.rig) cur.rig = cur.rig ? mergeRig(cur.rig, r.rig) : copyRig(r.rig);
  }
  return out;
}

function copyRig(r: OverlayRig): OverlayRig {
  return {
    pins: [...r.pins], bones: [...r.bones], ik: [...r.ik], vertices: [...r.vertices], rest: [...r.rest],
    triangles: [...r.triangles], edges: [...r.edges], weights: [...r.weights], pinPath: [...r.pinPath], pinKeys: [...r.pinKeys],
  };
}

function mergeRig(cur: OverlayRig, r: OverlayRig): OverlayRig {
  cur.pins.push(...r.pins);
  cur.bones.push(...r.bones);
  cur.ik.push(...r.ik);
  cur.vertices.push(...r.vertices);
  cur.rest.push(...r.rest);
  cur.triangles.push(...r.triangles);
  cur.edges.push(...r.edges);
  cur.weights.push(...r.weights);
  cur.pinPath.push(...r.pinPath);
  cur.pinKeys.push(...r.pinKeys);
  return cur;
}

function notify(viewport: number): void {
  for (const l of listeners.get(viewport) ?? []) l();
}

/** Layer ids the mirror held when the removal watch last looked (see `watchLayerRemovals`). */
let mirrorLayers: ReadonlySet<string> = new Set();
let stopLayerWatch: (() => void) | null = null;

/**
 * A layer the document no longer has must leave the pushed sets AT ONCE.
 *
 * The pushed set is the last DRAWN frame's, and the frame carrying a delete
 * lands after the mirror (and the page's replica, and the selection prune) has
 * already seen it: for that window `overlayLayer` still answered with the gone
 * layer's box and matrix, so every overlay that read it when the mirror revision
 * moved — the effect / gradient / track-point / roto / rig chrome — drew its box
 * over nothing, and none of them re-reads when the frame lands. Dropping the
 * record here makes "gone" answer `undefined` as `overlayLayer` promises, and
 * tells the listeners so frame-synchronous painters repaint without it.
 *
 * Exactly the ids that LEFT the mirror are dropped (not "any id it does not
 * hold"): a layer whose record arrives before the mirror has learned of it is
 * not gone.
 */
function watchLayerRemovals(): () => void {
  mirrorLayers = new Set(documentMirror().layerIds());
  return documentMirror().subscribe(['layers'], () => {
    const now = new Set(documentMirror().layerIds());
    const removed: string[] = [];
    for (const id of mirrorLayers) if (!now.has(id)) removed.push(id);
    mirrorLayers = now;
    if (removed.length === 0) return;
    for (const [viewport, set] of pushed) {
      let dropped = false;
      for (const id of removed) dropped = set.layers.delete(id) || dropped;
      if (dropped) notify(viewport);
    }
  });
}

/** EngineSurface: the C++ engine draws `viewport` (true) or stopped (false). */
export function setEngineDrivenViewport(viewport: number, driven: boolean): void {
  if (driven) {
    engineDriven.add(viewport);
    stopLayerWatch ??= watchLayerRemovals();
  } else {
    engineDriven.delete(viewport);
    pushed.delete(viewport);
    if (engineDriven.size === 0) {
      stopLayerWatch?.();
      stopLayerWatch = null;
    }
  }
}

/** EngineSurface: a drawn frame's geometry (the records its meta carried). */
export function publishFrameGeometry(
  viewport: number,
  time: number,
  revision: number,
  records: ReadonlyArray<OverlayLayerGeometry>,
  views?: ReadonlyArray<OverlayView>,
): void {
  pushed.set(viewport, { time, revision, layers: merge(records), views: viewsByMode(views) });
  notify(viewport);
}

/**
 * Subscribe the viewport's overlays (`setOverlayGeometry`, both engines): one
 * group per overlay (its layers × ITS kinds) and the view modes whose cameras
 * the frames carry. Sent only when it changes.
 */
function subscribeOverlayGroups(viewport: number, groups: ReadonlyArray<OverlayRequest>, views: ReadonlyArray<string>): Promise<void> {
  // B4 round 5: the rig overlay's focus rides the same control (setOverlayRigFocus).
  const rig = rigFocus.get(viewport);
  lastGroups.set(viewport, { groups: [...groups], views: [...views] });
  const key = `${groups.map((g) => `${g.layers.join('\u0001')}\u0002${g.kinds.join(',')}`).join('\u0003')}\u0000${views.join('\u0001')}`
    + (rig ? `\u0000${rig.pin}\u0001${rig.bone}\u0001${rig.authoring ? 1 : 0}` : '');
  if (subscribed.get(viewport) === key) return pendingSubscription.get(viewport) ?? Promise.resolve();
  subscribed.set(viewport, key);
  computed.delete(viewport);
  // Records computed between the send and the engine taking it were for the old
  // subscription: drop them once it has landed (a control moves no revision).
  // `viewport` is this window's local id; the engine's is base + local (windowViewport.ts).
  const send = (id: number): Promise<unknown> =>
    engine().execute({ type: 'setOverlayGeometry', viewport: id, layers: [], kinds: [], groups: groups.map((g) => ({ layers: [...g.layers], kinds: [...g.kinds] })), views: [...views], ...(rig ? { rig: { ...rig } } : {}) });
  // In the editor window the id is known and the command goes out in this tick, as it always did.
  const known = engineViewportNow(viewport);
  const landed = (known !== null ? send(known) : engineViewport(viewport).then(send))
    .then(() => {
      if (subscribed.get(viewport) === key) computed.delete(viewport);
    });
  pendingSubscription.set(viewport, landed);
  return landed;
}

/** B4 round 5: the rig overlay's focus per viewport (setOverlayGeometry `rig`), and the groups last sent with it. */
const rigFocus = new Map<number, OverlayRigOptions>();
const lastGroups = new Map<number, { groups: OverlayRequest[]; views: string[] }>();

/**
 * The rig overlay's editor-side focus (the selected pin's motion path, the
 * selected bone's weights, the Puppet Pin tool's authoring mesh) — sent with
 * the viewport's subscription when it changes; undefined clears it.
 */
export function setOverlayRigFocus(viewport: number, focus: OverlayRigOptions | undefined): Promise<void> {
  if (focus) rigFocus.set(viewport, { pin: focus.pin, bone: focus.bone, authoring: focus.authoring });
  else rigFocus.delete(viewport);
  const last = lastGroups.get(viewport) ?? { groups: [], views: [] };
  return subscribeOverlayGroups(viewport, last.groups, last.views);
}

/** Each overlay's own request, by viewport then owner: the subscription sent is one group per owner. */
const requests = new Map<number, Map<string, { layers: readonly string[]; kinds: readonly OverlayKind[]; views: readonly string[] }>>();

/**
 * One overlay's share of the viewport's subscription (the selection chrome,
 * the text box handles, the puppet pins, the 3D reference geometry…): `owner`
 * names it; no layers × kinds and no views withdraws it. Each owner is its own
 * group — its layers get ITS kinds (B4 round 5; before, every requested layer
 * got every kind any overlay asked for) — and `views` are the view modes whose
 * resolved view camera the frames should carry (`overlayView`). Sent only when
 * a request changes. Resolves once the engine has the subscription (a React
 * overlay re-renders then: its records exist from that point).
 */
export function requestOverlayLayers(
  viewport: number,
  owner: string,
  layers: ReadonlyArray<string>,
  kinds: ReadonlyArray<OverlayKind>,
  views: ReadonlyArray<string> = [],
): Promise<void> {
  let byOwner = requests.get(viewport);
  if (!byOwner) requests.set(viewport, (byOwner = new Map()));
  const hasLayers = layers.length > 0 && kinds.length > 0;
  if (!hasLayers && views.length === 0) byOwner.delete(owner);
  else byOwner.set(owner, { layers: hasLayers ? [...layers] : [], kinds: hasLayers ? [...kinds] : [], views: [...views] });
  const groups: OverlayRequest[] = [];
  const allViews: string[] = [];
  for (const r of byOwner.values()) {
    if (r.layers.length > 0) groups.push({ layers: [...r.layers], kinds: [...r.kinds] });
    for (const v of r.views) if (!allViews.includes(v)) allViews.push(v);
  }
  return subscribeOverlayGroups(viewport, groups, allViews);
}

/**
 * The layer → screen placement of a pushed record's matrix (`transform`): the
 * screen origin, the on-screen angle and the axis scales — what the DOM
 * overlays glue to (the twin of the viewport's scene-node placement). The 2D
 * chain as the column-major 4×4 the push carries; `toScreen` is the viewport
 * camera's comp → screen (view state). Null without a matrix.
 */
export function overlayScreenPlacement(
  g: OverlayLayer | undefined,
  toScreen: (p: { x: number; y: number }) => { x: number; y: number },
): { x: number; y: number; rotationDeg: number; scaleX: number; scaleY: number } | null {
  const m = g?.matrix;
  if (!m || m.length < 16) return null;
  const a = m[0]!, b = m[1]!, c = m[4]!, d = m[5]!;
  const s = toScreen({ x: m[12]!, y: m[13]! });
  return { x: s.x, y: s.y, rotationDeg: (Math.atan2(b, a) * 180) / Math.PI, scaleX: Math.hypot(a, b) || 1, scaleY: Math.hypot(c, d) || 1 };
}

/**
 * One subscribed layer's geometry for the frame the viewport shows at comp
 * time `time` (flicks): the engine's pushed frame when it draws the viewport,
 * else the TypeScript engine's records for `time` (computed once per time and
 * revision). Undefined for a layer not subscribed, gone, or before the first frame.
 */
export function overlayLayer(viewport: number, layer: string, time: number): OverlayLayer | undefined {
  return frameSet(viewport, time)?.layers.get(layer);
}

/** The frame set the viewport shows at comp time `time` (flicks): the pushed one, else the TypeScript engine's (once per time and revision). */
function frameSet(viewport: number, time: number): FrameSet | undefined {
  if (engineDriven.has(viewport)) return pushed.get(viewport);
  if (!producer) return undefined;
  const rev = documentMirror().revision;
  let set = computed.get(viewport);
  if (!set || set.time !== time || set.revision !== rev) {
    const seconds = flicksToSeconds(time);
    set = { time, revision: rev, layers: merge(producer.layersAt(viewport, seconds)), views: viewsByMode(producer.viewsAt(viewport, seconds)) };
    computed.set(viewport, set);
  }
  return set;
}

/**
 * B4 round 5: the resolved view camera of `mode` for the frame the viewport
 * shows at comp time `time` (flicks) — requested with `requestOverlayLayers(…,
 * views)`. Undefined before the first frame of the subscription.
 */
export function overlayView(viewport: number, mode: string, time: number): OverlayView | undefined {
  return frameSet(viewport, time)?.views.get(mode);
}

/** Told when a frame's geometry lands for `viewport` (engine-driven viewports). */
export function subscribeOverlayGeometry(viewport: number, cb: () => void): () => void {
  let set = listeners.get(viewport);
  if (!set) listeners.set(viewport, (set = new Set()));
  set.add(cb);
  return () => {
    set!.delete(cb);
  };
}
