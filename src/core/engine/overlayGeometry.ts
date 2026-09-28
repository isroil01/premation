/**
 * The overlay geometry push (B4 round 2, ENGINE_API.md §15.12) — the
 * TypeScript engine's side. `setOverlayGeometry` subscriptions live here
 * (transport.ts routes the control); `overlayGeometryAt` is the twin of the
 * C++ producer (native/engine/src/core/overlay_geometry.cpp): the records a
 * frame carries, computed from this engine's document at a comp time. When the
 * page's own renderer draws the viewport there is no frame channel, so the
 * page asks for them per painted frame (src/stores/overlayGeometry.ts); when
 * the C++ engine draws it, they arrive with the frame instead.
 */

import type { OverlayKind, OverlayLayerGeometry, OverlayRequest, OverlayView } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { scene3dOf, viewOf } from './overlayScene3d';
import { overlayRigOptions, rigOverlayOf } from './rigOverlay';
import { defaultAnimation, effectiveSpatialTangents } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { compSizeOf } from '@core/composition/compSizes';
import { parentWorld2DAt, world2DAt, world3DAt } from '@core/scene/layerSpace';
import { readNode3D } from '@core/scene/threeD';
import { readGeometry } from '@core/workspace/geometry';
import { compToKeyframeTime, getRemappedTime } from '@core/timeline/TimelineController';
import { layerGeometryAt } from './layerBoundsQuery';
import { compOfLayer, isLayer } from './doc';
import { compFps } from './time';

interface Subscription {
  layers: string[];
  kinds: ReadonlySet<OverlayKind>;
}

const subscriptions = new Map<number, Subscription>();

/** `setOverlayGeometry`: replace a viewport's subscription (no layers or no kinds = none). */
export function setOverlaySubscription(viewport: number, layers: ReadonlyArray<string>, kinds: ReadonlyArray<OverlayKind>): void {
  if (layers.length === 0 || kinds.length === 0) subscriptions.delete(viewport);
  else subscriptions.set(viewport, { layers: [...layers], kinds: new Set(kinds) });
}

/** The viewport's subscription, or undefined. */
export function overlaySubscription(viewport: number): { layers: readonly string[]; kinds: ReadonlySet<OverlayKind> } | undefined {
  return subscriptions.get(viewport);
}

// ── B4 round 5: per-overlay groups and the view cameras (setOverlayGeometry `groups` / `views`) ──

interface GroupsAndViews {
  groups: Array<{ layers: string[]; kinds: ReadonlySet<OverlayKind> }>;
  views: string[];
}
const groupsAndViews = new Map<number, GroupsAndViews>();

/** `setOverlayGeometry`'s `groups` and `views` (replaced with the rest of the subscription; none = cleared). */
export function setOverlayGroupsAndViews(viewport: number, groups: ReadonlyArray<OverlayRequest>, views: ReadonlyArray<string>): void {
  const gs = groups.filter((g) => g.layers.length > 0 && g.kinds.length > 0).map((g) => ({ layers: [...g.layers], kinds: new Set(g.kinds) }));
  if (gs.length === 0 && views.length === 0) groupsAndViews.delete(viewport);
  else groupsAndViews.set(viewport, { groups: gs, views: [...views] });
}

/**
 * Each subscribed layer with the kinds it gets, in order: `layers` (× `kinds`)
 * first, then each group's layers not listed yet — a layer named by several
 * gets the union of their kinds.
 */
export function subscribedLayerKinds(viewport: number): Array<[string, Set<OverlayKind>]> {
  const out = new Map<string, Set<OverlayKind>>();
  const add = (id: string, kinds: ReadonlySet<OverlayKind>): void => {
    let cur = out.get(id);
    if (!cur) out.set(id, (cur = new Set()));
    for (const k of kinds) cur.add(k);
  };
  const sub = subscriptions.get(viewport);
  if (sub) for (const id of sub.layers) add(id, sub.kinds);
  for (const g of groupsAndViews.get(viewport)?.groups ?? []) for (const id of g.layers) add(id, g.kinds);
  return [...out];
}

/** The viewport's subscribed views' cameras at comp `seconds`, in subscription order (resolved in the active tab's composition). */
export function overlayViewsAt(viewport: number, seconds: number): OverlayView[] {
  const views = groupsAndViews.get(viewport)?.views ?? [];
  if (views.length === 0) return [];
  const comp = activeCompRootId();
  return views.map((mode) => viewOf(mode, comp, seconds));
}

/** At most this many points on a motion path (the frame channel's cap; overlay_geometry.hpp kOverlayPathPoints). */
const PATH_POINTS = 128;

function matrixOf(id: string, seconds: number): number[] {
  const comp = compOfLayer(id);
  const size = (comp ? compSizeOf(comp) : undefined) ?? { width: 1920, height: 1080 };
  const m3 = world3DAt(id, seconds, { width: size.width, height: size.height });
  if (m3) return Array.from(m3);
  const m = world2DAt(id, seconds);
  return [m.a, m.b, 0, 0, m.c, m.d, 0, 0, 0, 0, 1, 0, m.e, m.f, 0, 1];
}

function boundsOf(id: string, seconds: number, g: OverlayLayerGeometry): void {
  const geo = layerGeometryAt(id, seconds);
  if (!geo) return;
  const l = geo.offsetX - geo.width / 2;
  const t = geo.offsetY - geo.height / 2;
  g.box = [l, t, geo.width, geo.height];
  const m = world2DAt(id, seconds);
  const local = [l, t, l + geo.width, t, l + geo.width, t + geo.height, l, t + geo.height];
  g.corners = [];
  for (let i = 0; i < local.length; i += 2) {
    g.corners.push(m.a * local[i]! + m.c * local[i + 1]! + m.e, m.b * local[i]! + m.d * local[i + 1]! + m.f);
  }
}

function textBoxOf(id: string, seconds: number, g: OverlayLayerGeometry): void {
  const node = defaultSceneGraph.getNode(id);
  if (!node || !node.components.some((c) => c.type === 'Text')) return;
  const av = defaultAnimation.hasAnimation(id) ? Object.fromEntries(defaultAnimation.evaluateNode(id, getRemappedTime(id, seconds))) : undefined;
  const geo = readGeometry(node, av);
  if (!geo) return;
  g.textBox = [-geo.width / 2, geo.offsetY - geo.height / 2, geo.width, geo.height];
}

/** motionPath.ts over one layer, mapped into comp space through the parent's world matrix at `seconds` (useWorkspace pathToComp). */
function motionPathOf(id: string, seconds: number, g: OverlayLayerGeometry): void {
  const node = defaultSceneGraph.getNode(id);
  if (!node) return;
  const xs = defaultAnimation.getTrackKeyframes(id, 'x') ?? [];
  const ys = defaultAnimation.getTrackKeyframes(id, 'y') ?? [];
  const times = [...new Set([...xs, ...ys].map((k) => k.t))].sort((a, b) => a - b);
  if (times.length === 0) return;
  let baseX = 0;
  let baseY = 0;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (typeof p.x === 'number') baseX = p.x;
    if (typeof p.y === 'number') baseY = p.y;
  }
  const baseZ = readNode3D(node).z;
  const parent = parentWorld2DAt(id, seconds);
  const raw = (t: number): [number, number, number] => [
    defaultAnimation.sample(id, 'x', t) ?? baseX,
    defaultAnimation.sample(id, 'y', t) ?? baseY,
    defaultAnimation.sample(id, 'z', t) ?? baseZ,
  ];
  const toComp = (x: number, y: number): [number, number] => [parent.a * x + parent.c * y + parent.e, parent.b * x + parent.d * y + parent.f];
  const push = (out: number[], t: number): void => {
    const [x, y, z] = raw(t);
    const [cx, cy] = toComp(x, y);
    out.push(t, cx, cy, z);
  };
  const tmin = times[0]!;
  const tmax = times[times.length - 1]!;
  if (tmax > tmin) {
    const count = Math.max(8, 16 * Math.max(1, times.length - 1));
    const steps = Math.min(count, PATH_POINTS - 1);
    for (let i = 0; i <= steps; i++) push(g.path, tmin + ((tmax - tmin) * i) / steps);
    const comp = compOfLayer(id);
    const dt = 1 / Math.max(1, comp ? compFps(comp) : 30);
    const eps = 1e-5;
    for (let t = tmin; t <= tmax + eps; t += dt) {
      const c = Math.min(tmax, t);
      push(g.pathFrames, c);
      if (c >= tmax - eps) break;
    }
  }
  times.forEach((t, i) => {
    const [x, y, z] = raw(t);
    const ix = xs.findIndex((k) => k.t === t);
    const iy = ys.findIndex((k) => k.t === t);
    const tx = ix >= 0 ? effectiveSpatialTangents(xs, ix) : {};
    const ty = iy >= 0 ? effectiveSpatialTangents(ys, iy) : {};
    const linear = (xs[ix]?.spatialInterp ?? ys[iy]?.spatialInterp) === 'linear';
    const [cx, cy] = toComp(x, y);
    const rec = [t, cx, cy, z, NaN, NaN, NaN, NaN];
    if (!linear && i > 0) {
      const q = raw(times[i - 1]!);
      const [hx, hy] = toComp(x + (tx.si ?? (q[0] - x) / 3), y + (ty.si ?? (q[1] - y) / 3));
      rec[4] = hx;
      rec[5] = hy;
    }
    if (!linear && i < times.length - 1) {
      const q = raw(times[i + 1]!);
      const [hx, hy] = toComp(x + (tx.so ?? (q[0] - x) / 3), y + (ty.so ?? (q[1] - y) / 3));
      rec[6] = hx;
      rec[7] = hy;
    }
    g.pathKeys.push(...rec);
  });
  const [nx, ny, nz] = raw(compToKeyframeTime(id, seconds, 'x'));
  const [ncx, ncy] = toComp(nx, ny);
  g.pathNow = [ncx, ncy, nz];
}

function emptyRecord(layer: string): OverlayLayerGeometry {
  return { layer, matrix: [], box: [], corners: [], path: [], pathKeys: [], pins: [], bones: [], textBox: [], pathFrames: [], pathNow: [] };
}

/** The viewport's subscribed geometry at comp time `seconds`, in subscription order (the C++ producer's twin). */
export function overlayGeometryAt(viewport: number, seconds: number): OverlayLayerGeometry[] {
  const out: OverlayLayerGeometry[] = [];
  // B4 round 5: each layer with ITS kinds (the `layers` × `kinds` list, then the groups).
  for (const [id, kinds] of subscribedLayerKinds(viewport)) {
    if (!isLayer(id)) continue;
    const g = emptyRecord(id);
    if (kinds.has('transform')) g.matrix = matrixOf(id, seconds);
    if (kinds.has('bounds')) boundsOf(id, seconds, g);
    if (kinds.has('motionPath')) motionPathOf(id, seconds, g);
    if (kinds.has('textBox')) textBoxOf(id, seconds, g);
    // B4 round 5: the puppet pins / skeleton (rigOverlay.ts; the C++ twin is scene/rig_overlay.cpp).
    if (kinds.has('rig')) {
      const rig = rigOverlayOf(id, seconds, overlayRigOptions(viewport));
      if (rig) g.rig = rig;
    }
    if (kinds.has('scene3d')) {
      const scene = scene3dOf(id, seconds);
      if (scene) g.scene = scene;
    }
    out.push(g);
  }
  return out;
}
