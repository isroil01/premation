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

import { flicksToSeconds, type OverlayKind, type OverlayLayerGeometry } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { overlayGeometryAt } from '@core/engine/overlayGeometry';
import { documentMirror } from './documentMirror';

/** The editor's main viewport (EngineSurface's ENGINE_SURFACE_VIEWPORT): the id the overlays subscribe under in both engines. */
export const MAIN_VIEWPORT = 1;

/** One layer's merged geometry for a frame (the arrays of its records concatenated). */
export type OverlayLayer = Omit<OverlayLayerGeometry, 'layer'> & { layer: string };

interface FrameSet {
  /** Comp time, flicks. */
  time: number;
  revision: number;
  layers: Map<string, OverlayLayer>;
}

const pushed = new Map<number, FrameSet>();
const computed = new Map<number, FrameSet>();
/** Viewports the C++ engine draws (EngineSurface in 'viewport' mode): their geometry is the frames'. */
const engineDriven = new Set<number>();
const listeners = new Map<number, Set<() => void>>();
const subscribed = new Map<number, string>();
/** The last subscription sent per viewport, settled once the engine has it. */
const pendingSubscription = new Map<number, Promise<void>>();

function merge(records: ReadonlyArray<OverlayLayerGeometry>): Map<string, OverlayLayer> {
  const out = new Map<string, OverlayLayer>();
  for (const r of records) {
    const cur = out.get(r.layer);
    if (!cur) {
      out.set(r.layer, { ...r, matrix: [...r.matrix], box: [...r.box], corners: [...r.corners], path: [...r.path], pathKeys: [...r.pathKeys], pins: [...r.pins], bones: [...r.bones], textBox: [...r.textBox], pathFrames: [...r.pathFrames], pathNow: [...r.pathNow] });
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
  }
  return out;
}

function notify(viewport: number): void {
  for (const l of listeners.get(viewport) ?? []) l();
}

/** EngineSurface: the C++ engine draws `viewport` (true) or stopped (false). */
export function setEngineDrivenViewport(viewport: number, driven: boolean): void {
  if (driven) engineDriven.add(viewport);
  else {
    engineDriven.delete(viewport);
    pushed.delete(viewport);
  }
}

/** EngineSurface: a drawn frame's geometry (the records its meta carried). */
export function publishFrameGeometry(viewport: number, time: number, revision: number, records: ReadonlyArray<OverlayLayerGeometry>): void {
  pushed.set(viewport, { time, revision, layers: merge(records) });
  notify(viewport);
}

/**
 * Subscribe the viewport's overlays to `layers` × `kinds` (`setOverlayGeometry`,
 * both engines). Sent only when it changes.
 */
export function subscribeOverlayLayers(viewport: number, layers: ReadonlyArray<string>, kinds: ReadonlyArray<OverlayKind>): Promise<void> {
  const key = `${layers.join('\u0001')}\u0000${kinds.join(',')}`;
  if (subscribed.get(viewport) === key) return pendingSubscription.get(viewport) ?? Promise.resolve();
  subscribed.set(viewport, key);
  computed.delete(viewport);
  // Records computed between the send and the engine taking it were for the old
  // subscription: drop them once it has landed (a control moves no revision).
  const landed = engine().execute({ type: 'setOverlayGeometry', viewport, layers: [...layers], kinds: [...kinds] }).then(() => {
    if (subscribed.get(viewport) === key) computed.delete(viewport);
  });
  pendingSubscription.set(viewport, landed);
  return landed;
}

/** Each overlay's own request, by viewport then owner: the subscription sent is their union. */
const requests = new Map<number, Map<string, { layers: readonly string[]; kinds: readonly OverlayKind[] }>>();

/**
 * One overlay's share of the viewport's subscription (the selection chrome,
 * the text box handles, the puppet pins…): `owner` names it, an empty `layers`
 * withdraws it. The viewport is subscribed to the UNION — every requested layer
 * with every requested kind (`setOverlayGeometry` has one kind list) — sent
 * only when the union changes. Resolves once the engine has the subscription
 * (a React overlay re-renders then: its records exist from that point).
 */
export function requestOverlayLayers(viewport: number, owner: string, layers: ReadonlyArray<string>, kinds: ReadonlyArray<OverlayKind>): Promise<void> {
  let byOwner = requests.get(viewport);
  if (!byOwner) requests.set(viewport, (byOwner = new Map()));
  if (layers.length === 0 || kinds.length === 0) byOwner.delete(owner);
  else byOwner.set(owner, { layers: [...layers], kinds: [...kinds] });
  const allLayers: string[] = [];
  const allKinds: OverlayKind[] = [];
  for (const r of byOwner.values()) {
    for (const l of r.layers) if (!allLayers.includes(l)) allLayers.push(l);
    for (const k of r.kinds) if (!allKinds.includes(k)) allKinds.push(k);
  }
  return subscribeOverlayLayers(viewport, allLayers, allKinds);
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
  if (engineDriven.has(viewport)) return pushed.get(viewport)?.layers.get(layer);
  const rev = documentMirror().revision;
  let set = computed.get(viewport);
  if (!set || set.time !== time || set.revision !== rev) {
    set = { time, revision: rev, layers: merge(overlayGeometryAt(viewport, flicksToSeconds(time))) };
    computed.set(viewport, set);
  }
  return set.layers.get(layer);
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
