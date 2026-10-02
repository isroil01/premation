/**
 * The rig in the overlay geometry push, and `getRigPose` (B4 round 5,
 * ENGINE_API.md §15.14) — the TypeScript engine's side. The C++ twin is
 * native/engine/src/scene/rig_overlay.cpp over rig_mesh.cpp's rig block.
 *
 * What the Puppet Pin and Bone overlays drew by running the rig modules in the
 * page — the live pins, the solved skeleton, the deformed lattice, the focus
 * pin's motion path, the focus bone's weights — resolved once here, engine
 * side, as buildSnapshot resolves the rig: the puppet solve in REST space, then
 * the skeleton pose carries it (rigDeform.ts). Every point is LAYER space (the
 * layer's local px, the space readGeometry's box is in).
 *
 * The mesh is nodeRestMesh's (rigMeshInputs.ts), sized by the layer's box AT
 * THE TIME (layerGeometryAt) — the overlays sized it by the static box, so a
 * keyed size drew a lattice the render did not use. `authoring` is the Puppet
 * Pin tool's pinless preview mesh (nodeRestMesh `authoringPreview`).
 */

import type { OverlayRig, OverlayRigOptions, RigBonePose, RigIkGoal, RigPinPose, RigPose, GetRigPose, Vec2 } from '@motion/engine-api';
import { dataPathTangents, defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { useAssetStore } from '@stores/assetStore';
import { deform, pinKindOf, readNodePuppet, restPointFromDeformed, type DeformedMesh } from '@core/rig/puppet';
import { resolveLivePins } from '@core/rig/livePins';
import { resolveLiveBones } from '@core/rig/liveBones';
import { chainModeOf, resolveIkTargets } from '@core/rig/liveIkTargets';
import { bindPoseBones, readNodeSkeleton } from '@core/rig/skeletonCommands';
import { computeWorldTransforms } from '@core/rig/skeleton';
import type { Mat2D } from '@core/rig/mat2d';
import { applyIk, getSkeletonBinding, skinPointAt, skinRigVertices, unskinPoint, type SkeletonBinding } from '@core/rig/rigDeform';
import { nodeRestMesh } from '@core/rig/rigMeshInputs';
import { fail } from './errors';
import { isLayer } from '@core/mirror/docFacts';
import { layerGeometryAt } from './layerBoundsQuery';
import { checkTime, flicksToSeconds } from './time';

/** Per viewport: setOverlayGeometry's `rig` (replaced with the rest of the subscription). */
const rigOptions = new Map<number, OverlayRigOptions>();

/** `setOverlayGeometry`'s `rig` for `viewport` (absent = no focus, the rig's own mesh). */
export function setOverlayRigOptions(viewport: number, opts: OverlayRigOptions | undefined): void {
  if (opts) rigOptions.set(viewport, { pin: opts.pin, bone: opts.bone, authoring: opts.authoring });
  else rigOptions.delete(viewport);
}

/** The viewport's rig options, or undefined. */
export function overlayRigOptions(viewport: number): OverlayRigOptions | undefined {
  return rigOptions.get(viewport);
}

/** One layer's rig resolved at a time. */
interface RigState {
  restMesh: DeformedMesh;
  /** The puppet solve alone (rest vertices without pins). */
  puppetDeformed: Float32Array;
  /** What renders: the puppet solve carried through the skeleton pose. */
  vertices: Float32Array;
  pins: RigPinPose[];
  bones: RigBonePose[];
  ik: RigIkGoal[];
  binding: SkeletonBinding | null;
  poseWorld: Map<string, Mat2D> | null;
  /** The layer's keyframe-axis seconds at the time. */
  layerT: number;
}

const assetLookup = (id: string): { src?: string } | undefined => useAssetStore.getState().assets.find((a) => a.id === id);

/** The rig of layer `id` at comp time `seconds`, or null: no layer / box, or (`authoring` off) no pins and no bones. */
function rigStateOf(id: string, seconds: number, authoring: boolean): RigState | null {
  const node = defaultSceneGraph.getNode(id);
  if (!node) return null;
  const puppetRig = readNodePuppet(node);
  const skel = readNodeSkeleton(node);
  const storedPins = puppetRig?.pins ?? [];
  const storedBones = skel?.bones ?? [];
  if (!authoring && storedPins.length === 0 && storedBones.length === 0) return null;
  const geom = layerGeometryAt(id, seconds);
  if (!geom) return null;
  const restMesh = nodeRestMesh(node, geom, assetLookup, authoring);
  const layerT = compToKeyframeTime(id, seconds);

  const livePins = resolveLivePins(storedPins, id, layerT, defaultAnimation);
  const puppetDeformed = storedPins.length > 0
    ? deform(livePins, restMesh, puppetRig?.solver ?? 'arap', puppetRig?.maxRotationDeg)
    : restMesh.vertices;

  let vertices = puppetDeformed;
  let binding: SkeletonBinding | null = null;
  let poseWorld: Map<string, Mat2D> | null = null;
  const bones: RigBonePose[] = [];
  const ik: RigIkGoal[] = [];
  if (skel && storedBones.length > 0) {
    const live = resolveLiveBones(storedBones, id, layerT, defaultAnimation);
    for (const tg of skel.ikTargets ?? []) {
      // resolveIkTargets' sampling for every stored goal (a disabled one too — the overlay greys its controller).
      const r = resolveIkTargets({ ikTargets: [{ ...tg, enabled: true }] }, id, layerT, defaultAnimation)[0]!;
      ik.push({
        bone: tg.boneId,
        enabled: tg.enabled !== false,
        x: r.x,
        y: r.y,
        pole: r.pole ? [r.pole.x, r.pole.y] : [],
        ...(tg.chainLength !== undefined ? { chainLength: tg.chainLength } : {}),
        mode: chainModeOf(tg, id, layerT, defaultAnimation),
      });
    }
    // resolveActiveIkTargets: the enabled goals in IK mode.
    const active = ik
      .filter((g) => g.enabled && g.mode === 'ik')
      .map((g) => ({ boneId: g.bone, x: g.x, y: g.y, chainLength: g.chainLength, ...(g.pole.length === 2 ? { pole: { x: g.pole[0]!, y: g.pole[1]! } } : {}) }));
    const posed = applyIk(live, active);
    poseWorld = computeWorldTransforms({ bones: posed });
    binding = getSkeletonBinding(restMesh, bindPoseBones(skel), skel.weightPaint);
    vertices = skinRigVertices(binding, poseWorld, puppetDeformed);
    storedBones.forEach((b, i) => {
      const l = live[i]!;
      const p = posed[i]!;
      const w = poseWorld!.get(b.id);
      bones.push({
        id: b.id,
        x: l.x, y: l.y, rotation: l.rotation, scaleX: l.scaleX ?? 1, scaleY: l.scaleY ?? 1,
        posedX: p.x, posedY: p.y, posedRotation: p.rotation,
        world: w ? [...w] : [],
      });
    });
  }

  const pins: RigPinPose[] = storedPins.map((pin, i) => {
    const live = livePins[i]!;
    const kind = pinKindOf(pin);
    // A bend pin sits wherever the other pins carried it: its solved mesh vertex.
    const k = kind === 'bend' ? restMesh.pinVertexIndices[pin.id] : undefined;
    const c = k !== undefined && puppetDeformed.length >= k * 4 + 2
      ? { x: puppetDeformed[k * 4]!, y: puppetDeformed[k * 4 + 1]! }
      : { x: live.x, y: live.y };
    const drawn = binding && poseWorld ? skinPointAt(c, c, binding, poseWorld) : c;
    return { id: pin.id, kind, x: drawn.x, y: drawn.y, cx: c.x, cy: c.y, rotation: live.rotation ?? 0, scale: live.scale ?? 1 };
  });

  return { restMesh, puppetDeformed, vertices, pins, bones, ik, binding, poseWorld, layerT };
}

/**
 * The puppet lattice as index pairs (PuppetOverlay's puppetLatticePath): the
 * unique triangle edges; `boxesOnly` keeps the rest-axis-aligned ones (a grid
 * cell's diagonal omitted).
 */
function latticeEdges(rest: Float32Array, triangles: Uint16Array, boxesOnly: boolean): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    const tri = [triangles[i]!, triangles[i + 1]!, triangles[i + 2]!];
    for (let e = 0; e < 3; e++) {
      let a = tri[e]!;
      let b = tri[(e + 1) % 3]!;
      if (a > b) [a, b] = [b, a];
      const key = a * 65536 + b;
      if (seen.has(key)) continue;
      seen.add(key);
      if (boxesOnly) {
        const ax = rest[a * 4]!, ay = rest[a * 4 + 1]!;
        const bx = rest[b * 4]!, by = rest[b * 4 + 1]!;
        if (Math.abs(ax - bx) > 1e-3 && Math.abs(ay - by) > 1e-3) continue;
      }
      out.push(a, b);
    }
  }
  return out;
}

function xyPairs(v: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < v.length; i += 4) out.push(v[i]!, v[i + 1]!);
  return out;
}

/** The pin path samples per key span (PuppetOverlay's SEGMENTS). */
const PIN_PATH_SEGMENTS = 24;

/** The `rig` record of layer `id` at comp time `seconds`, or undefined (no rig to show). */
export function rigOverlayOf(id: string, seconds: number, opts: OverlayRigOptions | undefined): OverlayRig | undefined {
  const s = rigStateOf(id, seconds, opts?.authoring === true);
  if (!s) return undefined;
  const { restMesh } = s;
  const posed = (p: { x: number; y: number }): { x: number; y: number } =>
    s.binding && s.poseWorld ? skinPointAt(p, p, s.binding, s.poseWorld) : p;
  // A grid mesh draws boxes; an outline mesh (or a grid the box filter empties) every unique edge.
  const edges = (restMesh.layout ?? 'grid') === 'grid' ? latticeEdges(restMesh.vertices, restMesh.triangles, true) : [];
  const lattice = edges.length > 0 ? edges : latticeEdges(restMesh.vertices, restMesh.triangles, false);

  const weights: number[] = [];
  if (opts?.bone && s.binding) {
    const n = restMesh.vertices.length / 4;
    for (let i = 0; i < n; i++) weights.push(s.binding.weights[i]?.find((w) => w.boneId === opts.bone)?.weight ?? 0);
  }

  const pinPath: number[] = [];
  const pinKeys: number[] = [];
  const track = opts?.pin ? defaultAnimation.getDataTrack(id, `puppet.${opts.pin}.position`) : null;
  if (opts?.pin && track && track.keyframes.length > 1) {
    const handles = dataPathTangents(track, 0);
    const first = track.keyframes[0]!.t;
    const last = track.keyframes[track.keyframes.length - 1]!.t;
    const steps = PIN_PATH_SEGMENTS * (track.keyframes.length - 1);
    for (let i = 0; i <= steps; i++) {
      const v = defaultAnimation.sampleData(id, `puppet.${opts.pin}.position`, first + ((last - first) * i) / steps);
      if (!Array.isArray(v) || !v[0]) continue;
      const p = posed(v[0] as { x: number; y: number });
      pinPath.push(p.x, p.y);
    }
    for (const h of handles) {
      const p = posed({ x: h.x, y: h.y });
      const inn = h.in ? posed(h.in) : null;
      const out = h.out ? posed(h.out) : null;
      pinKeys.push(h.t, h.x, h.y, p.x, p.y, inn?.x ?? NaN, inn?.y ?? NaN, out?.x ?? NaN, out?.y ?? NaN);
    }
  }

  return {
    pins: s.pins,
    bones: s.bones,
    ik: s.ik,
    vertices: xyPairs(s.vertices),
    rest: xyPairs(restMesh.vertices),
    triangles: Array.from(restMesh.triangles),
    edges: lattice,
    weights,
    pinPath,
    pinKeys,
  };
}

/** `getRigPose`. */
export function rigPoseAnswer(q: GetRigPose): RigPose {
  if (!isLayer(q.layer)) fail('notFound', `no layer '${q.layer}'`, { layer: q.layer });
  checkTime(q.time);
  const s = rigStateOf(q.layer, flicksToSeconds(q.time), q.authoring === true);
  const rest: Vec2[] = [];
  const anchors: Vec2[] = [];
  for (const p of q.points) {
    const r = s?.binding && s.poseWorld ? unskinPoint(p, s.binding, s.poseWorld) : { x: p.x, y: p.y };
    rest.push({ x: r.x, y: r.y });
    const a = s ? restPointFromDeformed(r, s.restMesh, s.puppetDeformed) : null;
    anchors.push(a ? { x: a.x, y: a.y } : { x: r.x, y: r.y });
  }
  const vertexCount = s ? s.restMesh.vertices.length / 4 : 0;
  const weights = s?.binding && q.vertex !== undefined && q.vertex < vertexCount
    ? [...(s.binding.weights[q.vertex] ?? [])].sort((a, b) => b.weight - a.weight).map((w) => ({ bone: w.boneId, weight: w.weight }))
    : [];
  return { bones: s?.bones ?? [], ik: s?.ik ?? [], rest, anchors, weights, vertexCount };
}
