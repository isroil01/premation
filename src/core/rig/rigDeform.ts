/**
 * rigDeform — the ONE evaluation path for skeleton posing (FK + IK) and for
 * composing skeleton skinning with puppet-pin deformation. buildSnapshot (live
 * preview AND export ride the same call) and the canvas overlays all evaluate
 * through here, so what the overlay shows is what renders.
 *
 * ── Composition order (skeleton + puppet on ONE layer) ─────────────────────
 * The puppet solve runs in REST space, then the skeleton skinning maps the
 * puppet-refined vertices into posed space:
 *
 *     rest mesh ──deform(pins)──▶ puppet-refined ──LBS(skeleton)──▶ posed
 *
 * Why this order (and not "pose the rest mesh with the skeleton, then run the
 * puppet against the posed configuration"):
 *   • ARAP's reduced Cholesky factorisation is keyed on the REST mesh + handle
 *     set (see arap.ts). A skeleton-posed rest state would change every frame,
 *     forcing an O(m³) refactor per frame (or a churny factor cache) — this
 *     order keeps the rest configuration frame-invariant, so the existing
 *     caching (and bit-determinism) is untouched.
 *   • It is temporally stable: pin weights and ARAP edge weights never depend
 *     on the animated pose, so there is no frame-to-frame binding swim.
 *   • Semantically it still delivers the AE/Rive contract — the skeleton is
 *     the coarse pose and pins refine on top: a pin's rest anchor AND its
 *     displacement are carried through the skeleton skinning, so a pin bound
 *     to a forearm keeps refining the forearm wherever the arm swings, and a
 *     bone rotation moves regions no pin holds.
 * Skinning weights are bound at REST vertex positions (not the puppet-moved
 * ones) so puppet animation cannot re-weight the skeleton binding.
 *
 * Deterministic throughout: pure arithmetic, fixed iteration counts, caches
 * keyed on value signatures. Same input → bit-identical output.
 */

import type { DeformedMesh } from './puppet';
import type { Bone } from './skeleton';
import { computeWorldTransforms, computeBindInverses, boneRoot, boneTip } from './skeleton';
import { type Mat2D, apply, invert, multiply } from './mat2d';
import { solveTwoBone, solveFabrik, anglesFromJoints, type Vec2 } from './ik';
import { boneSegments, type BoneSegment } from './autoWeight';
import { geodesicAutoWeights, weightsAtPoint } from './geodesicWeights';
import { skinVertex, type SkinVertex, type VertexWeight } from './skinning';
import { applyWeightPaint, weightPaintMatches, type WeightPaintMap } from './weightPaint';

// ────────────────────────────────────────────────────────────────────────────
// IK — chain resolution and pose override
// ────────────────────────────────────────────────────────────────────────────

/** An IK target with its live (possibly keyframe-sampled) position, layer-local. */
export interface IkTargetResolved {
  boneId: string;
  x: number;
  y: number;
  /** Bones in the chain (the target bone + its ancestors). Default 2, max 8. */
  chainLength?: number;
  /**
   * Optional pole vector (layer-local): the side a two-bone chain bends toward.
   * Without it the solver preserves the CURRENT bend side, which never flips —
   * a pole is how you choose (and keyframe) the elbow/knee direction.
   */
  pole?: { x: number; y: number };
}

const MAX_CHAIN = 8;
const DEFAULT_CHAIN = 2;

/**
 * The bone ids an IK target drives: the target bone and its ancestors up to
 * `chainLength` bones, root-first. Used both by the solver and by the overlay
 * (dragging any bone of an active chain moves the TARGET, AE/DUIK-style).
 */
export function ikChainIds(
  bones: readonly Bone[],
  targetBoneId: string,
  chainLength = DEFAULT_CHAIN,
): string[] {
  const byId = new Map(bones.map((b) => [b.id, b]));
  const max = Math.max(1, Math.min(MAX_CHAIN, Math.floor(chainLength)));
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur = byId.get(targetBoneId);
  while (cur && chain.length < max && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain;
}

/**
 * Apply IK targets on top of FK-sampled bones: for each target, resolve the
 * chain (analytic two-bone for 2-bone chains, FABRIK for longer, direct aim
 * for a single bone) and override the chain bones' LOCAL rotations (radians —
 * the unit `fromTRS`/`computeWorldTransforms` consume) so the end bone's tip
 * reaches the target. Bones outside every chain keep their FK pose untouched.
 *
 * Write-back is delta-based: each chain link's solved world angle minus its
 * current world angle is added to the bone's local rotation (accumulating
 * upstream deltas), which is exact for arbitrary child root offsets and needs
 * no assumption that a child sits on its parent's tip.
 */
export function applyIk(bones: readonly Bone[], targets: readonly IkTargetResolved[]): Bone[] {
  const out = bones.map((b) => ({ ...b }));
  if (targets.length === 0 || out.length === 0) return out;
  const byId = new Map(out.map((b) => [b.id, b]));

  for (const t of targets) {
    const end = byId.get(t.boneId);
    if (!end) continue;
    const chainIds = ikChainIds(out, t.boneId, t.chainLength ?? DEFAULT_CHAIN);
    if (chainIds.length === 0) continue;
    const chain = chainIds.map((id) => byId.get(id)!);

    // Current pose of the whole skeleton (earlier targets' writes included).
    const world = computeWorldTransforms({ bones: out });
    const joints: Vec2[] = chain.map((b) => boneRoot(world.get(b.id)!));
    joints.push(boneTip(world.get(end.id)!, end.length));

    const lengths: number[] = [];
    let degenerate = false;
    for (let i = 0; i < joints.length - 1; i++) {
      const a = joints[i]!;
      const b = joints[i + 1]!;
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      if (l < 1e-6) degenerate = true;
      lengths.push(l);
    }
    if (degenerate) continue;

    const target: Vec2 = { x: t.x, y: t.y };
    // Current world angle of each link (root_i → joint_{i+1}).
    const currentAngles = anglesFromJoints(joints);
    let solvedAngles: number[];

    if (chain.length === 1) {
      // Single-link chain: aim the bone straight at the target.
      const j0 = joints[0]!;
      solvedAngles = [Math.atan2(target.y - j0.y, target.x - j0.x)];
    } else if (chain.length === 2) {
      // Analytic two-bone (arm/leg). Preserve the current bend side so the
      // elbow/knee does not pop when the target crosses the chain line.
      const j0 = joints[0]!;
      const j1 = joints[1]!;
      const j2 = joints[2]!;
      let bendPositive: boolean;
      if (t.pole) {
        // Explicit pole: bend toward whichever side of the root→target line the
        // pole sits on. Deterministic and keyframeable, so the joint can be made
        // to flip rather than only holding its current side.
        const ax = target.x - j0.x;
        const ay = target.y - j0.y;
        const side = ax * (t.pole.y - j0.y) - ay * (t.pole.x - j0.x);
        bendPositive = side >= 0;
      } else {
        // Preserve the current bend side so the joint does not pop when the
        // target crosses the chain line.
        bendPositive =
          (j1.x - j0.x) * (j2.y - j1.y) - (j1.y - j0.y) * (j2.x - j1.x) >= 0;
      }
      const sol = solveTwoBone(j0, lengths[0]!, lengths[1]!, target, bendPositive);
      solvedAngles = [sol.angle1, sol.angle2];
    } else {
      const solved = solveFabrik(joints, lengths, target);
      solvedAngles = anglesFromJoints(solved);
    }

    // Delta write-back, accumulating upstream rotation into downstream links.
    let cumulative = 0;
    for (let i = 0; i < chain.length; i++) {
      const delta = solvedAngles[i]! - (currentAngles[i]! + cumulative);
      chain[i]!.rotation += delta;
      cumulative += delta;
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Skeleton binding — per-(mesh × rest skeleton) skinning data, cached
// ────────────────────────────────────────────────────────────────────────────

export interface SkeletonBinding {
  /** Per-vertex bone weights, index-aligned with the rest mesh vertices. */
  weights: VertexWeight[][];
  /** Bind-pose world transforms of the REST bones. */
  bindWorld: Map<string, Mat2D>;
  bindInverse: Map<string, Mat2D>;
  /** Bind-pose world segments — for weighting arbitrary points (overlays). */
  segments: BoneSegment[];
  /**
   * The rest mesh this binding was computed against. Point helpers interpolate
   * `weights` over its triangles so an overlay dot skins with the SAME
   * (geodesic) field the mesh renders with — re-deriving point weights from
   * `segments` alone would silently reintroduce Euclidean cross-gap bleed.
   */
  mesh: DeformedMesh;
}

/** Deterministic signature of a skeleton's REST pose (binding identity). */
function restBonesKey(bones: readonly Bone[]): string {
  return bones
    .map(
      (b) =>
        `${b.id}|${b.parentId ?? ''}|${b.length}|${b.x}|${b.y}|${b.rotation}|${b.scaleX ?? 1}|${b.scaleY ?? 1}`,
    )
    .join(';');
}

/**
 * Deterministic signature of a paint map (FNV-1a over bone → index:weight, in
 * sorted order so key order can never change the hash). Painting must
 * invalidate the cached binding, but the map is far too large to key on
 * directly.
 */
function paintKey(paint: WeightPaintMap | undefined): string {
  if (!paint) return 'nopaint';
  let h = 2166136261 >>> 0;
  const mix = (s: string): void => {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  };
  for (const boneId of Object.keys(paint.bones).sort()) {
    mix(boneId);
    const per = paint.bones[boneId]!;
    for (const idx of Object.keys(per).sort((a, b) => Number(a) - Number(b))) {
      mix(idx);
      mix(String(Math.round(per[Number(idx)]! * 1024)));
    }
  }
  return `p${paint.vertexCount}:${h.toString(36)}`;
}

/** Bindings kept per mesh — bone edits churn keys, so keep this small. */
const BINDING_CACHE_CAP = 4;
const bindingCache = new WeakMap<DeformedMesh, Map<string, SkeletonBinding>>();

/**
 * Weights + bind transforms for (rest mesh × rest skeleton), computed once and
 * cached (mirroring the ARAP topology cache pattern) — the old per-frame
 * autoWeightVertex-over-every-vertex recompute is gone.
 */
export function getSkeletonBinding(
  restMesh: DeformedMesh,
  restBones: readonly Bone[],
  paint?: WeightPaintMap,
): SkeletonBinding {
  let perMesh = bindingCache.get(restMesh);
  if (!perMesh) {
    perMesh = new Map();
    bindingCache.set(restMesh, perMesh);
  }
  const numVerts = restMesh.vertices.length / 4;
  // Painted overrides are positional, so a paint map from a different mesh
  // resolution is ignored rather than smeared onto unrelated vertices.
  const livePaint = weightPaintMatches(paint, numVerts) ? paint : undefined;
  const key = `${restBonesKey(restBones)}|${paintKey(livePaint)}`;
  const cached = perMesh.get(key);
  if (cached) return cached;

  const bindWorld = computeWorldTransforms({ bones: [...restBones] });
  const bindInverse = computeBindInverses(bindWorld);
  const segments = boneSegments(restBones, bindWorld);

  // GEODESIC auto-weights: bone influence travels through the mesh graph, not
  // across transparent gaps — see geodesicWeights.ts for the rationale.
  const auto = geodesicAutoWeights(restMesh, segments);
  const weights: VertexWeight[][] = new Array(numVerts);
  for (let i = 0; i < numVerts; i++) {
    weights[i] = livePaint ? applyWeightPaint(auto[i]!, i, livePaint) : auto[i]!;
  }

  const binding: SkeletonBinding = { weights, bindWorld, bindInverse, segments, mesh: restMesh };
  if (perMesh.size >= BINDING_CACHE_CAP) {
    const oldest = perMesh.keys().next().value;
    if (oldest !== undefined) perMesh.delete(oldest);
  }
  perMesh.set(key, binding);
  return binding;
}

/**
 * Skin a vertex buffer with the skeleton pose. `source` supplies the positions
 * to transform — the rest mesh vertices for a skeleton-only layer, or the
 * puppet-deformed vertices when both rigs compose. Weights ALWAYS come from
 * the rest positions (the binding), so puppet motion never re-weights bones.
 * UVs are carried through untouched.
 */
export function skinRigVertices(
  binding: SkeletonBinding,
  poseWorld: Map<string, Mat2D>,
  source: Float32Array,
): Float32Array {
  const numVerts = source.length / 4;
  const outVerts = new Float32Array(source.length);
  for (let i = 0; i < numVerts; i++) {
    const v: SkinVertex = {
      x: source[i * 4 + 0]!,
      y: source[i * 4 + 1]!,
      weights: binding.weights[i] ?? [],
    };
    const p = skinVertex(v, poseWorld, binding.bindInverse);
    outVerts[i * 4 + 0] = p.x;
    outVerts[i * 4 + 1] = p.y;
    outVerts[i * 4 + 2] = source[i * 4 + 2]!;
    outVerts[i * 4 + 3] = source[i * 4 + 3]!;
  }
  return outVerts;
}

// ────────────────────────────────────────────────────────────────────────────
// Point skinning — overlay helpers (pin dots, pointer mapping)
// ────────────────────────────────────────────────────────────────────────────

/** Blended skinning matrix Σ wᵢ·(poseᵢ·bindInvᵢ) at a set of weights (or null). */
function blendedMatrix(
  weights: readonly VertexWeight[],
  poseWorld: Map<string, Mat2D>,
  bindInverse: Map<string, Mat2D>,
): Mat2D | null {
  let a = 0, b = 0, c = 0, d = 0, e = 0, f = 0;
  let total = 0;
  for (const { boneId, weight } of weights) {
    if (weight === 0) continue;
    const pose = poseWorld.get(boneId);
    const bind = bindInverse.get(boneId);
    if (!pose || !bind) continue;
    const m = multiply(pose, bind);
    a += m[0] * weight; b += m[1] * weight; c += m[2] * weight;
    d += m[3] * weight; e += m[4] * weight; f += m[5] * weight;
    total += weight;
  }
  if (total === 0) return null;
  return [a / total, b / total, c / total, d / total, e / total, f / total];
}

/**
 * Map a point into posed space, with weights bound at `restAnchor` applied to
 * `source` — exactly how skinRigVertices treats a mesh vertex, so a puppet
 * pin's dot lands on the composed mesh.
 */
export function skinPointAt(
  restAnchor: Vec2,
  source: Vec2,
  binding: SkeletonBinding,
  poseWorld: Map<string, Mat2D>,
): Vec2 {
  const w = weightsAtPoint(binding.mesh, binding.weights, restAnchor, binding.segments);
  const m = blendedMatrix(w, poseWorld, binding.bindInverse);
  if (!m) return { x: source.x, y: source.y };
  return apply(m, source.x, source.y);
}

/**
 * Fixed-point iterations for unskinPoint — FIXED count → deterministic.
 *
 * Was 3, which is not enough. Measured worst-case round-trip residual on a
 * posed two-bone arm (`puppetPinPlacement.test.ts`), at a point where the two
 * weight columns are still meaningfully mixed and the displacement is large —
 * the hardest case for this iteration:
 *
 *     iters:  3      4      6      8      10     12
 *     resid:  6.43   2.22   0.187  0.028  0.007  0.002   (px)
 *
 * At 3 the inverse was off by ~11% of the displacement, which fed a visibly
 * wrong rest coordinate into puppet pin placement. Convergence is ~0.28x per
 * iteration, so 12 is essentially exact with headroom for sharper weight fields
 * (more bones / higher falloff) than that test exercises.
 *
 * This runs on POINTER INPUT only — once per click-add, once per pointermove
 * during a drag — never in the render loop, so the extra iterations are free.
 */
const UNSKIN_ITERATIONS = 12;

/**
 * Inverse of skinPointAt for pointer input: given a POSED-space point, recover
 * the rest-space point that skins onto it. The blended matrix depends on the
 * (unknown) rest position, so iterate a fixed-count fixed point: weight at the
 * current guess, invert the blended matrix, re-map. Converges fast anywhere
 * the weight field is smooth; degenerate blends fall back to the input.
 */
export function unskinPoint(
  posed: Vec2,
  binding: SkeletonBinding,
  poseWorld: Map<string, Mat2D>,
): Vec2 {
  let guess: Vec2 = { x: posed.x, y: posed.y };
  for (let i = 0; i < UNSKIN_ITERATIONS; i++) {
    const w = weightsAtPoint(binding.mesh, binding.weights, guess, binding.segments);
    const m = blendedMatrix(w, poseWorld, binding.bindInverse);
    if (!m) return guess;
    guess = apply(invert(m), posed.x, posed.y);
  }
  return guess;
}
