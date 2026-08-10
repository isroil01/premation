# Bone Tool & Puppet Tool — Complete Reference

**Scope:** everything Premation ships for 2D mesh deformation — the Puppet (pin) tool and the Bone (skeleton) tool: the math, the data model, the evaluation path, the UI surfaces, the AI tools, caching/performance, determinism guarantees, test coverage, and the honest current state including gaps and known defects.

**Written:** 2026-07-27 · **Last updated:** 2026-07-28 (Phases 1–4 of the AE-parity brief landed)
**Verified against:** working tree at `Desktop/motion-editor`; rig-related suites green
(21 suites / 238 tests), whole repo green (364 suites / 3864 tests).

---

## 0. TL;DR — what actually ships

| | Puppet tool | Bone tool |
|---|---|---|
| Toolbar id | `puppet-pin` | `bone` |
| Shortcut | `Ctrl/Cmd+P` | `Ctrl/Cmd+B` |
| Stored at | `fx.puppet` on the layer | `fx.skeleton` on the layer |
| Deformer | ARAP (default) or LBS over a grid mesh | Linear Blend Skinning over the same mesh |
| Rigging primitive | position pins (+ rotation, stiffness, scale, overlap) | bone hierarchy (+ FK, IK targets, pole vectors) |
| Solver quality | Sorkine–Alexa ARAP, cotangent Laplacian, dense Cholesky | analytic two-bone + FABRIK |
| Auto-binding | Laplacian harmonic weights (150 Jacobi iters) | inverse-distance-to-segment, capped at 4 influences |
| Keyframeable | pin position (eased + spatial tangents) / rotation / stiffness / scale / overlap | bone rotation / x / y / scaleX / scaleY, IK target x / y, IK pole x / y |
| Undo | `PuppetEditCommand` (1 gesture = 1 step) | `SkeletonEditCommand` (1 gesture = 1 step) |
| Renders via | `layer.deformedMesh` → GPU indexed mesh draw (overlap = painter's index order) | same |
| Authoring | Puppet Sketch recording, motion path + tangent handles, advanced-pin gizmo, **bend pins** | **auto-rig presets**, mesh preview, **weight painting + per-vertex numeric weights**, **controllers**, **IK/FK switching**, bone names |
| AI tools | `create_puppet_rig`, `set_puppet_pin_keyframes` | `create_skeleton_rig`, `pose_skeleton` |

Both rigs can live on the **same layer** and **compose** (puppet first, in rest space; skeleton skins on top).

This is a complete, production-shaped implementation of both the *math* and the *authoring UX*.
Against After Effects the remaining deltas are deliberate, not missing work: there is one engine
(AE carries two for backward compatibility), one mesh per layer, and overlap resolves **within** the
layer rather than through the scene depth buffer (§12.6). Against DUIK/Rive — the right benchmark
for the bone tool, since AE has no skeleton at all — **the named feature gaps are now closed**:
controllers, per-chain IK/FK switching with pose preservation, auto-rig presets (biped + quadruped)
and a per-vertex numeric weight editor all ship. Remaining defects and open items: §12.

The one thing deliberately NOT inherited from DUIK is **controllers driving puppet pins**. DUIK does
that because AE has no skeleton, so a pin *is* the joint and a null-plus-expression is the only
handle available — a workaround for a missing rig model. This project has the rig model, so a
controller links to a `bone` or an `ikTarget` and the solver reads it directly. The rest of this
document is that reasoning; `EDITOR_REFERENCE.md` §3 places rigging in the wider feature map.

---

## 1. File map

All rig math lives in `src/core/rig/` — pure, framework-free, no engine deps.

```
src/core/rig/
├── mat2d.ts             57 LOC   2D affine matrix [a,b,c,d,e,f]; fromTRS/multiply/apply/invert/angleOf
├── skeleton.ts          69 LOC   Bone/Skeleton types, FK world transforms, bind inverses, root/tip
├── ik.ts               122 LOC   solveTwoBone (law of cosines), solveFabrik, anglesFromJoints
├── skinning.ts          77 LOC   skinVertex/skinMesh/normalizeWeights (LBS core)
├── autoWeight.ts        68 LOC   distanceToSegment, boneSegments, autoWeightVertex/Mesh
├── mesh.ts             172 LOC   flattenOutline/earClip/buildMesh/subdivide — backs meshMode:'silhouette'
├── puppet.ts           911 LOC   PuppetRig/PuppetPin types, buildRestMesh (grid + silhouette),
│                                 harmonic weights, deformLbs, deform() dispatcher, rotation clamp,
│                                 overlap depth field, triangle depth sort, rest-mesh LRU cache
├── arap.ts             685 LOC   As-Rigid-As-Possible solver (Sorkine–Alexa local/global),
│                                 stiffness energy term, rotation refinement, solver-cliff constants
├── rigDeform.ts        386 LOC   THE evaluation path: applyIk (+ pole vectors), getSkeletonBinding,
│                                 skinRigVertices, skinPointAt, unskinPoint
├── rigMeshInputs.ts    120 LOC   SHARED mesh inputs — buildSnapshot and the overlay both resolve
│                                 layer kind / image src / coverage mask here so they cannot drift
├── weightPaint.ts      177 LOC   sparse per-(bone,vertex) weight overrides + brush + merge
├── puppetSketch.ts     164 LOC   real-time recording, time thinning, Douglas–Peucker, easing
├── rigIds.ts            55 LOC   collision-free ordinal ids for pins / bones
├── puppetCommands.ts   140 LOC   undoable pin add/delete/settings/pin-edit
├── skeletonCommands.ts 194 LOC   undoable bone add/delete/update, IK target, mesh settings, paint
└── (tests)             ~2400 LOC across 10 files + __tests__/ (3 more)
```

Integration & UI:

```
src/core/rendering/buildSnapshot.ts        :1334-1440   evaluation for preview AND export
src/core/rendering/imageAlphaCoverage.ts   101 LOC      async bitmap-alpha decode → coverage mask
src/core/rendering/snapshotToFrameScene.ts :340-357     normalizeDeformedMesh (pixel → unit-quad)
src/core/rendering/RenderBackend.ts        :242         RenderLayer.deformedMesh
packages/renderer/.../passUtils.ts         :254-280     GPU vertex/index buffer + emitDeformedMesh
packages/renderer/.../FrameScene.ts        :236         deformedMesh ⇒ NOT depth-eligible 3D

src/layout/Workspace/PuppetOverlay.tsx     841 LOC      pin UI, mesh wireframe, weight heatmap,
                                                        motion path + tangent handles, advanced-pin
                                                        gizmo, Puppet Sketch recording
src/layout/Workspace/BoneOverlay.tsx       793 LOC      bone UI, IK + pole handles, mesh preview,
                                                        weight-paint brush
src/layout/Inspector/PuppetControls.tsx    281 LOC      "Puppet Mesh Pins" inspector section
src/layout/Inspector/BoneControls.tsx      241 LOC      "Skeleton Bone Rigging" inspector section
src/layout/EditorLayout/DemoPanels.tsx     :1120-1148   "Rigging" panel accordion assembly
src/layout/EditorLayout/panelDefs.ts       :61          panel { id:'rig', title:'Rigging', icon:'bone' }
src/layout/TopNav/TopNav.tsx               :91-92,248   toolbar buttons + canRig gating
src/providers/Providers.tsx                :113-114     Ctrl+P / Ctrl+B command registration
src/core/scene/rigLogo.ts                  413 LOC      "Rig Logo for Animation" (rasterize-then-rig)
src/core/ai/toolHandlers.ts                :863-1054    4 AI tools
src/core/workspace/WorkspaceController.ts  :39          'puppet-pin' → 'select' cursor
```

---

## 2. Data model

### 2.1 Where rigs are stored

Both rigs live inside the layer's **`fx` component props** on the SceneNode:

```ts
node.components.find(c => c.type === 'fx').props.puppet    // PuppetRig
node.components.find(c => c.type === 'fx').props.skeleton  // SkeletonRig
```

Readers: `readNodePuppet(node)` (`puppet.ts:72`), `readNodeSkeleton(node)` (`skeletonCommands.ts:42`).
Writers: `SceneGraph.setPuppet(nodeId, rig)` / `setSkeleton(nodeId, rig)` (`SceneGraph.ts:421,426`).

Because they are plain JSON on a component, rigs **serialize with the project for free** — no separate rig store, no migration surface.

### 2.2 Puppet types (`puppet.ts`)

```ts
interface PuppetPin {
  id: string;
  name: string;
  x: number;          // layer-local, origin at the layer CENTER
  y: number;
  rotation?: number;  // degrees — static fallback; rotates the influence field around the pin
  stiffness?: number; // >= 0 — static fallback; "starch" (AE's Starch pin, as an energy term)
  scale?: number;     // uniform scale around the pin (1 = unchanged) — AE's Advanced pin
  overlap?: number;   // -100..100 draw-depth where the mesh folds over itself — AE's Overlap pin
  overlapExtent?: number; // how far that depth influence reaches (default 1)
}

interface PuppetRig {
  pins: PuppetPin[];
  meshExpansion?: number; // px padding past the layer boundary (default 8)
  meshDensity?: number;   // grid subdivisions per side, clamped 2..50 (default 15)
  solver?: 'lbs' | 'arap'; // default 'arap'
  maxRotationDeg?: number;  // Mesh Rotation Refinement; absent = unlimited
  meshMode?: 'grid' | 'silhouette'; // default 'grid'
}

/** What the solver actually consumes — the live, possibly keyframe-sampled state. */
interface DeformPin { id; x; y; rotation?; stiffness?; scale?; overlap?; overlapExtent? }

interface DeformedMesh {
  vertices: Float32Array;   // flat [x, y, u, v, ...]
  triangles: Uint16Array;   // flat triangle indices (depth-sorted when overlap is in play)
  pinRestPositions: Record<string, {x,y}>;
  weights: Record<string, Float32Array>;  // pinId → per-vertex weight column
}
```

### 2.3 Skeleton types (`skeleton.ts`, `skeletonCommands.ts`)

```ts
interface Bone {
  id: string;
  name?: string;       // human-readable label; falls back to `id`
  parentId: string | null;
  length: number;      // along local +x; the tip is at (length, 0)
  x: number; y: number;
  rotation: number;    // RADIANS — see §12.4
  scaleX?: number; scaleY?: number;
}

interface IKTarget {
  boneId: string;
  x: number; y: number;   // LAYER-LOCAL px
  enabled?: boolean;
  chainLength?: number;   // bones in the solved chain (target + ancestors), default 2, max 8
  pole?: { x: number; y: number }; // the side a 2-bone chain bends toward; absent = preserve current
}

interface SkeletonRig extends Skeleton {   // { bones: Bone[] }
  ikTargets?: IKTarget[];
  meshDensity?: number;    // only consulted on a skeleton-ONLY layer
  meshExpansion?: number;
  weightPaint?: WeightPaintMap; // sparse per-(bone,vertex) overrides on the auto binding
}
```

### 2.4 Animation track namespace

Everything animatable is a normal track on the existing animation engine — no bespoke rig timeline.

| Track | Kind | Unit | Authored by |
|---|---|---|---|
| `puppet.<pinId>.position` | **data** track, `points` kind, value `[{x,y}]`; supports temporal easing AND spatial tangents | layer-local px, **rest space** | canvas pin drag, Puppet Sketch, `set_puppet_pin_keyframes` |
| `puppet.<pinId>.rotation` | scalar | degrees | Alt-drag on canvas, inspector, `set_keyframes` |
| `puppet.<pinId>.stiffness` | scalar | ≥ 0 | inspector, `set_keyframes` |
| `puppet.<pinId>.scale` | scalar | 1 = unchanged | gizmo handle, inspector, `set_keyframes` |
| `puppet.<pinId>.overlap` | scalar | −100..100 | inspector, `set_keyframes` |
| `bone.<boneId>.rotation` | scalar | **radians** | canvas bone drag, `pose_skeleton` |
| `bone.<boneId>.x` / `.y` | scalar | layer-local px | canvas root-bone drag, `pose_skeleton` |
| `bone.<boneId>.scaleX` / `.scaleY` | scalar | 1 = unchanged | inspector |
| `ikTarget.<boneId>.x` / `.y` | scalar | layer-local px | canvas IK-handle drag |
| `ikPole.<boneId>.x` / `.y` | scalar | layer-local px | canvas pole-handle drag |

`toolContext.ts:85-97` documents this namespace to the AI and deliberately excludes `puppet.<pinId>.position` from the scalar-keyframe surface (it is a data track).

When no track exists for a property, the **static value on the pin/bone is the fallback** — so a rig is fully usable with zero keyframes.

---

## 3. The Puppet tool — how it works

### 3.1 Rest-mesh construction (`buildRestMesh`)

Two modes, selected by `rig.meshMode`. **`'silhouette'`** ear-clips the layer's outline directly
(§12.1) — better triangle distribution on thin diagonal artwork, and every vertex lands on the
artwork. **`'grid'`** is the default: a **regular grid, then culled**:

1. **Grid.** `cols = rows = clamp(meshDensity, 2, 50)` over the box
   `[-w/2 - pad - expansion, +w/2 + pad + expansion]` × same for y.
   Each vertex carries `[x, y, u, v]`; the UV maps into the *padded* rasterized texture
   (`u = (x + w/2 + pad) / (w + 2·pad)`), so stroke padding is respected.

2. **Coverage cull.** A single predicate decides whether a grid cell is artwork:
   - **Shape/vector layers** → `silhouetteFromPathPoints(pathPoints, open)` gives a closed
     polygon; even-odd `pointInPolygon` test. Open strokes → no silhouette.
   - **Image layers** → an alpha-derived `PuppetCoverageMask` (see §3.2).
   - **Neither** → plain bbox grid (no culling).

   A cell is kept if **any of its 4 corners** is covered, or its **center** is (catches thin parts).
   Kept cells are then **dilated by one ring** (8-neighbourhood) so weights have margin to diffuse
   into. Vertices are compacted and re-indexed; triangles emitted as 2 per surviving cell.

   *Why it matters:* without the cull, a logo's transparent bbox corners join the mesh and harmonic
   weights diffuse *across empty space*, so a pin on one leg of an L-shape drags the other leg.

3. **Pin anchoring.** Each pin snaps to its **nearest mesh vertex** (`pinVertexIndices`). That vertex
   becomes the pin's hard constraint.

4. **Harmonic (Laplacian) weights.** For each pin, solve a discrete Laplace equation by
   **150 Jacobi iterations**: the pin's own vertex is locked at 1.0, every *other* pin's vertex is
   locked at 0.0, and every free vertex is the unweighted average of its neighbours. Then
   **normalize per vertex** so the pin weights sum to 1 (uniform split if the sum is 0).

   This is why influence flows *along the artwork* rather than through Euclidean space — the
   diffusion is over mesh connectivity, which the cull has already shaped to the silhouette.

5. **Cache.** `getCachedRestMesh(nodeId, w, h, pad, rig, silhouette, coverage)` keys on
   `nodeId:w:h:pad:expansion:density:silhouetteHash:coverageKey:pinsKey` where `pinsKey` is
   `id:x:y` per pin. Moving a pin via a *keyframe track* does **not** change the key (the static
   rest position is what's hashed), so the mesh + weights are built once and reused across every
   frame of playback.

### 3.2 Image-alpha coverage (`coverageMaskFromImageData` + `imageAlphaCoverage.ts`)

For image layers there is no path outline, so coverage comes from the bitmap's alpha channel:

- The image is drawn into a small offscreen canvas capped at **64×64**, alpha read once.
- Each cell is "covered" if any of a bounded, evenly-strided ≤8×8 probe set has **alpha ≥ 12**.
- The mask gets an **FNV-1a key** over dims + threshold + cell bytes → stable cache identity.
- The decode is **async**. `getImageCoverageMask()` returns `undefined` on first call (the frame
  falls back to the bbox grid — never blocks, never throws), kicks off the decode, and on
  completion emits `AnimationChanged { nodeId: '__puppet_coverage__' }` so the surface re-renders
  with the tighter mesh next frame. Failures are recorded in a `failed` set and **never retried**,
  so a broken URL can't thrash.

### 3.3 Solver A — Linear Blend Skinning (`deformLbs`)

Per-pin rigid transform, weight-blended per vertex:

- **Translation** — the pin's displacement from its rest position.
- **Rotation + scale** (AE's Advanced pin) — a *similarity* transform around the pin's rest
  position, weighted by that pin's weight column. Scale folds straight into the rotation matrix
  (`cos·s`, `sin·s`). Expressed as a *displacement*, so θ=0 **and** s=1 reduces **exactly** to the
  translate-only path.
- **Stiffness** — exponentiates the weight column (`w^(1+s)`) and renormalizes per vertex,
  sharpening the falloff.

All per-pin data (weight column, rest pos, delta, cos/sin, stiffness exponent) is precomputed once
outside the vertex loop.

**Failure mode:** LBS is what "candy-wrappers." Two handles imposing conflicting rotations make the
linear average collapse toward zero area. This is exactly what ARAP exists to fix, and there's a
regression test asserting it (`arap.test.ts:127`).

### 3.4 Solver B — ARAP (`arap.ts`) — the default

Implements **Sorkine–Alexa, "As-Rigid-As-Possible Surface Modeling" (SGP 2007)** specialised to a
planar triangle mesh. Minimises

```
E = Σ_i Σ_{j∈N(i)} w_ij · || (p'_i − p'_j) − R_i (p_i − p_j) ||²
```

**Local/global iteration, fixed at 4 outer passes:**

- **Local step** — best-fit rotation per free vertex in closed form. 2D orthogonal Procrustes needs
  no SVD: `θ = atan2(S10 − S01, S00 + S11)`. A pin's `rotation` *fixes* `R` at its constrained
  vertex, so its 1-ring rotates rigidly by that angle.
- **Global step** — solve the cotangent-Laplacian system `L p' = b` **exactly** for the free
  (non-handle) vertices.

**Edge weights.** Cotangent weights accumulated as `0.5·cot(opposite angle)` per incident triangle.
Degenerate triangles fall back to uniform 0.5 on all three edges. Negative cotangents (obtuse
slivers) clamp up to `COT_MIN = 1e-3`; the cap is `COT_MAX = 1e3`. Stored CSR-style
(`nbrIdx`/`nbrW`/`off`/`diag`) and memoised on the mesh object via `WeakMap`.

**Factorisation caching — the core perf trick.** The reduced system matrix is **fixed per
(mesh × handle-set)**, so it's dense-Cholesky-factorised *once* and cached; each outer iteration
only re-runs forward/back substitution on a fresh RHS. Handle sets are keyed by the sorted pinned-
vertex list.

**Stiffness as a first-class energy term** (not just a warm-start hint):
```
s_i  = Σ_p W_p(i) · max(0, stiffness_p)          // diffuse via harmonic weight columns
w'_ij = w_ij · (1 + K · (s_i + s_j)/2),  K = 6.0  // scale the cotangent weights
```
Stiffer regions carry more energy weight, so the global solve keeps their edges closer to rigid.
Two correctness consequences, both tested:
- A **uniform** stiffness field scales every weight by the same constant → same argmin → **no
  visible change**. Only stiffness *gradients* bite. (`arap.test.ts:218`)
- **Zero/absent** stiffness reduces **bit-identically** to the plain cotangent path.
  (`arap.test.ts:169`)

**Mesh Rotation Refinement.** `rig.maxRotationDeg` caps rotation in two places: each pin's authored
rotation (`clampPinRotations`, which returns the *same array* when nothing exceeds the limit, so the
unclamped path stays allocation-free and bit-identical), and ARAP's per-vertex local-step θ. Sparse
handle sets otherwise let the local step fit large rotations that read as twisting.

**Overlap pins.** A per-vertex signed depth is diffused through the same harmonic weight columns
(`overlapDepthField`), with `overlapExtent` flattening a pin's falloff via a root — the inverse of
what `stiffness` does with a power. That depth then resolves as draw order, not a depth test
(§12.12). No overlap pin ⇒ `null` ⇒ the index buffer is passed through untouched.

**Tunables and their cliffs:**

| Constant | Value | Meaning |
|---|---|---|
| `OUTER_ITERATIONS` | 4 | local/global passes |
| `DENSE_MAX` | 1200 | max free vertices for the dense Cholesky path |
| `GS_SWEEPS` | 64 | Gauss–Seidel sweeps when dense is unavailable |
| `STIFF_K` | 6.0 | stiffness → energy coupling |
| `STIFF_QUANT` | 1024 | stiffness signature quantization (cache key stability) |
| `STIFF_DENSE_MAX` | 512 | dense cap **under stiffness** — guards the O(m³) per-frame refactor cliff when stiffness is *animated* |
| `STIFF_FACTOR_CACHE_CAP` | 8 | bounded eviction for animated-stiffness factorisations |

**Practical read:** grid vertex count is `(density+1)²`. So **density ≥ 34** (1225 verts) leaves the
dense path; **with any stiffness, density ≥ 22** (529 verts) leaves it. Both fall back to
fixed-sweep Gauss–Seidel — still fully deterministic, just softer convergence.

**MEASURED COST** (600×300 layer, 2 pins; *warm* = steady per-frame once the factorisation is
cached, which is what playback pays):

| density | verts | first call | warm/frame | ~fps |
|---|---|---|---|---|
| 15 (default) | 256 | 27 ms | **3.1 ms** | 319 |
| 25 | 676 | 122 ms | 10.2 ms | 98 |
| 33 (`maxExactMeshDensity`) | 1156 | **673 ms** | **36.5 ms** | **27** |
| 40 | 1681 | 110 ms | 34.1 ms | 29 |
| 50 | 2601 | 68 ms | 43.4 ms | 23 |

Two counter-intuitive things, and the reason the inspector now discloses cost and exactness
**separately**:

* **The exact-solve boundary is not the performance boundary.** Density 33 is the last density that
  fits the dense Cholesky path *and* the point where a 673 ms hitch and 27 fps live — the
  factorisation is O(m³). An "exact ≤ 33" marker on its own reads as a recommendation to go there.
  `SMOOTH_PLAYBACK_MAX_DENSITY = 25` is the separate, measured cost threshold.
* **Past 33 the FIRST call gets cheaper** (no dense factorisation) while the steady cost stays high,
  so a slow first frame is not a reliable signal of the ongoing cost.

Cost is per rigged layer per frame, so several rigged layers multiply it. The overlap path is
cheap by comparison: `overlapDepthField` 0.03–0.06 ms, `sortTrianglesByDepth` 0.23–1.15 ms.

**Rest-mesh memory** (the `REST_MESH_CACHE_CAP = 16` sizing): 8.6 KB at density 15, 39.9 KB at 33,
90.3 KB at 50 — so the cap bounds the cache at **0.13–1.41 MB**, comfortably below the ~3 MB the
constant's comment estimates.

**Robustness.** ARAP **never throws and never returns NaN.** `deform()` always computes the LBS
field first and passes it as *both* warm start and fallback. ARAP bails to it verbatim when:
fewer than 2 distinct handles, empty mesh, or any non-finite result. A non-positive-definite reduced
system (a mesh component with no handle) degrades to Gauss–Seidel rather than failing.

### 3.5 Dispatcher

```ts
export function deform(pins, restMesh, solver = 'arap'): Float32Array {
  const lbs = deformLbs(pins, restMesh);
  if (solver === 'lbs') return lbs;
  return deformArap(pins, restMesh, lbs);
}
```

---

## 4. The Bone tool — how it works

### 4.1 Forward kinematics (`skeleton.ts`)

`computeWorldTransforms(skel)` resolves parent-first with memoisation, accepts bones **in any
order**, and resolves a **cycle to identity** for the offending bone rather than looping forever.
Local pose is `fromTRS(x, y, rotation, scaleX, scaleY)`; world is `parentWorld ∘ local`.

`boneRoot(m)` = `apply(m, 0, 0)`; `boneTip(m, length)` = `apply(m, length, 0)`.

### 4.2 Inverse kinematics (`ik.ts` + `applyIk` in `rigDeform.ts`)

Three solvers, selected by chain length:

- **1 bone** — direct aim: `atan2(target − root)`.
- **2 bones** — `solveTwoBone`, analytic law-of-cosines, single-shot and exact. `bendPositive`
  picks the elbow side. Out-of-reach targets clamp into the reachable annulus
  (`[|l1−l2| + 1e-6, l1+l2 − 1e-6]`) so `acos` never goes singular, and report `clamped: true`.
  The caller **preserves the current bend side** by testing the cross product of the current joint
  configuration, so the elbow/knee doesn't pop when the target crosses the chain line.
- **3–8 bones** — `solveFabrik`, 12 iterations, 0.25px tolerance, root pinned. Unreachable targets
  stretch straight toward the goal.

**Write-back is delta-based** (`rigDeform.ts:145`): each link's solved world angle minus its current
world angle is added to the bone's *local* rotation, accumulating upstream deltas. This is exact for
arbitrary child root offsets — it does **not** assume a child sits on its parent's tip.

`ikChainIds(bones, targetBoneId, chainLength)` returns the target bone plus its ancestors, root-first,
guarded against cycles and clamped to `[1, 8]`. It's used by both the solver and the overlay.

### 4.3 Auto-weighting (`autoWeight.ts`)

Binding starts fully automatic, and **weight painting** (§4.6) layers overrides on top:

```
raw weight to bone b = 1 / (distanceToSegment(vertex, b.root, b.tip)^falloff + 1e-6)   // falloff = 2
```
then `normalizeWeights(raw, maxInfluences = 4, epsilon = 1e-4)` — drop below-epsilon influences,
keep the 4 strongest, normalize to sum 1.

Distance is to the bone **segment** (root→tip), not the joint, so a long bone influences along its
whole length.

### 4.4 Skinning (`skinning.ts`)

```
v' = Σ weightᵢ · (poseWorldᵢ · bindInverseᵢ) · v
```

Vertices are in **bind world space**; `bindInverse` maps back into each bone's local frame,
`poseWorld` re-places under the current pose. A vertex with no live bones falls back to its bind
position.

### 4.6 Weight painting (`weightPaint.ts`)

Auto-weighting is a good first guess and a bad final answer — it cannot know a sleeve belongs to the
forearm rather than the torso it happens to sit near, and no amount of bone placement fixes that.

Overrides are **sparse** (`boneId → { vertexIndex: weight }`), so an untouched rig costs nothing and
serialises to nothing. They are keyed by the **vertex count they were painted at**: vertex indices
are positional, so a mesh rebuilt at a different density discards the map rather than smearing
weights onto unrelated artwork.

Brush modes are `add` / `subtract` / `smooth`, with a smoothstep-feathered edge. `smooth` pulls
toward the mean of the values already under the brush, which is what removes the crunchy boundary
auto-weighting leaves. `applyWeightPaint` merges: painted bones keep their painted value verbatim,
the remaining `1 − Σ painted` is shared across the unpainted bones in proportion to their auto
weights, then the vertex is renormalised. The brush is authored in SCREEN px and converted by zoom,
so its felt size is constant. One stroke = one undo step (the overlay paints into a scratch map and
commits on release).

### 4.5 Binding cache (`getSkeletonBinding`, `rigDeform.ts:189`)

Weights + bind transforms are computed **once per (rest mesh × rest skeleton)** and cached in a
`WeakMap<DeformedMesh, Map<restBonesKey, SkeletonBinding>>` with a cap of 4 entries
(bone edits churn keys). `restBonesKey` is a deterministic string over every bone's
id/parent/length/x/y/rotation/scale.

Before this cache existed, `autoWeightVertex` ran over every vertex *every frame*. The cache key is
`restBonesKey + paintKey`, so painting invalidates the binding — the paint map is far too large to
key on directly, hence an FNV-1a hash over sorted bone → index:weight pairs.

---

## 5. Composition: both rigs on one layer

Documented at length in `rigDeform.ts:1-32`. The order is:

```
rest mesh ──deform(pins)──▶ puppet-refined ──LBS(skeleton)──▶ posed
```

The puppet solves **in rest space**; the skeleton then maps the puppet-refined vertices into posed
space. Three reasons this order and not the reverse:

1. **Cache validity.** ARAP's reduced Cholesky factorisation is keyed on the *rest* mesh + handle
   set. A skeleton-posed rest state would change every frame, forcing an O(m³) refactor per frame.
   This order keeps the rest configuration frame-invariant.
2. **Temporal stability.** Pin weights and ARAP edge weights never depend on the animated pose, so
   there's no frame-to-frame binding swim.
3. **Semantics.** It still delivers the AE/Rive contract — skeleton is the coarse pose, pins refine
   on top. A pin bound to a forearm keeps refining the forearm wherever the arm swings; a bone
   rotation moves regions no pin holds.

**Skinning weights are bound at REST vertex positions**, never the puppet-moved ones, so puppet
animation can't re-weight the skeleton binding.

**Shared mesh.** One rest mesh serves both rigs. When a puppet rig exists its `meshDensity`/
`meshExpansion` win (its pin weights are baked into that mesh); a skeleton-only layer reads
density/expansion off its own config. `BoneControls` reflects this — it hides the "Skinning Mesh"
card and shows an explanatory note when the layer also has pins.

**Overlay round-tripping.** Because pins are stored in rest space but drawn on a posed mesh,
`rigDeform.ts` provides two helpers used only by the overlay:
- `skinPointAt(restAnchor, source, binding, poseWorld)` — maps a pin's dot onto the composed mesh.
- `unskinPoint(posed, binding, poseWorld)` — the inverse, for pointer input. The blended matrix
  depends on the unknown rest position, so it runs a **fixed 3-iteration** fixed point (weight at
  the current guess → invert → re-map). Fixed count ⇒ deterministic.

---

## 6. Evaluation & render path

### 6.1 buildSnapshot (`buildSnapshot.ts:1334-1440`)

**One code path serves live preview and export** — this is the parity guarantee.

```
puppetRig = readNodePuppet(node);  skelRig = readNodeSkeleton(node)
if (hasPuppet || hasSkel):
    pad        = rasterPadding(layer)
    silhouette = silhouetteFromPathPoints(pathPoints, pathOpen)
    coverage   = (!silhouette && kind==='image' && src) ? getImageCoverageMask(assetId ?? src, src) : undefined
    meshRig    = hasPuppet ? puppetRig : { pins: [], density/expansion from skelRig }
    restMesh   = getCachedRestMesh(node.id, w, h, pad, meshRig, silhouette, coverage)
    rigT       = layer.sourceTime ?? t          // time-remap aware

    deformed = restMesh.vertices
    if hasPuppet: sample puppet.<pin>.position|rotation|stiffness → deform(pins, restMesh, solver)
    if hasSkel:   sample bone.<b>.rotation|x|y → applyIk(bones, ikTargets) → computeWorldTransforms
                  → skinRigVertices(getSkeletonBinding(restMesh, restBones), poseWorld, deformed)

    layer.deformedMesh = { vertices: deformed, triangles: restMesh.triangles }
```

Note `rigT = layer.sourceTime ?? t` — rigs respect **time remapping** and precomp source time.

### 6.2 Snapshot → GPU

- `snapshotToFrameScene.ts:493` attaches `normalizeDeformedMesh(mesh, w, h, pad)`.
  **This normalisation is load-bearing.** The renderer's model matrix maps a `[0,1]` **unit quad**
  to comp space, like every textured quad. Feeding raw pixel coordinates throws the geometry
  off-screen (the layer simply vanishes). So: `n = v/(dim + 2·pad) + 0.5`. UVs pass through
  untouched. There's a dedicated regression test (`deformedMeshTransform.test.ts`).
- `needsShapeRaster()` returns **true** for any layer with a `deformedMesh` — a rigged shape must
  rasterize to a `path:` texture (there's no SDF form to warp).
- `passUtils.ts:254` allocates keyed vertex/index buffers
  (`geometry:mesh-vertex:<id>:<count>`), uploads, and calls `emitDeformedMesh` instead of
  `emitTextured`.
- `FrameScene.ts:236` — **a `deformedMesh` makes a layer NOT depth-eligible for 3D.** See §12.6.

---

## 7. UI surfaces

### 7.1 Toolbar & shortcuts

- `TopNav.tsx:91-92` — Puppet Position Pin Tool (`Ctrl+P`), Bone Tool (`Ctrl+B`).
- Both buttons are **gated on `canRig`** = exactly one selected layer AND
  `isRiggableLeafNode(node)`. When disabled, the tooltip explains:
  *"— select a shape or image layer (use Rig Logo for a group)"*.
- Shortcuts are really registered as commands in `Providers.tsx:113-114`
  (`tool.puppet-pin` / `tool.bone`, chord `{ key:'p'|'b', meta:true }`), so they also appear in the
  command palette with proper icons.

### 7.2 PuppetOverlay (`PuppetOverlay.tsx`) — active only when `activeTool === 'puppet-pin'`

An absolutely-positioned SVG over the canvas that re-solves the mesh client-side and mirrors
buildSnapshot exactly (including the skeleton composition branch).

- **Wireframe** — every triangle drawn at `rgba(0,191,255,0.25)`.
- **Weight heatmap** — select a pin and the triangles tint blue → green/yellow → red by that pin's
  average vertex weight. This is the *only* weight visualization in the product.
- **Click empty area** → add a pin (`addPuppetPin`, one undo step). Bounds-checked against
  `±(half + pad)`; a click outside clears selection instead.
- **Drag a pin** → live-writes `puppet.<pinId>.position` data keyframes at the current time,
  inside a `beginAnimEdit()` transaction committed on pointerup as *"Move Puppet Pin \<id\>"*.
- **Alt-drag a pin** → rotate sub-mode; writes `puppet.<pinId>.rotation` scalar keyframes,
  committed as *"Rotate Puppet Pin \<id\>"*. A 14px indicator line shows non-zero rotation.
- **Double-click a pin** or **Delete/Backspace** with a pin selected → `deletePuppetPin`.
- **Click-add suppression** — `pointerup` synthesizes a click even after a drag, and
  `stopPropagation` on `pointerdown` does *not* stop it. A `suppressClickAddRef` guard kills the
  stray pin that used to spawn on every drag release.
- **Skeleton awareness** — pin dots are drawn through `skinPointAt` so they land on the composed
  mesh, and drag input is mapped back through `unskinPoint` so pin tracks stay in rest space.

### 7.3 BoneOverlay (`BoneOverlay.tsx`) — active only when `activeTool === 'bone'`

- **Bone rendering** — tapered quad from root to tip, plus a root joint circle (r=6) and tip circle
  (r=4). Colour-coded: selected `#2b7eff`, hovered `#00e699`, **in an active IK chain `#ff0055`**,
  otherwise `#ffaa00`. Drawn from the **solved** pose (FK + IK), so the overlay previews exactly
  what renders.
- **Chain drawing** — click empty canvas with a bone selected → a new child bone grows **from the
  parent's tip** toward the click, with local rotation derived from the parent's world angle.
  No selection → a root bone at the click, length 40.
- **Drag a bone** → FK rotate around its own root (`bone.<id>.rotation`), or translate for a root
  bone (`bone.<id>.x/.y`). **If the bone belongs to an active IK chain the drag redirects to moving
  the TARGET** — AE/DUIK behaviour, rather than fighting the solver.
- **IK handles** — a red crosshair per enabled target with a 14px invisible hit circle. Drag to move
  the goal (writes `ikTarget.<boneId>.x/.y`); **double-click disables** the target.
- **Click-add suppression** — same guard as the puppet overlay, plus a `CLICK_SLOP_PX = 3` travel
  threshold so a real drag never spawns a bone.

### 7.4 Inspector — the "Rigging" panel

`panelDefs.ts:61` registers `{ id:'rig', title:'Rigging', icon:'bone', region:'rightInspector' }`.
`DemoPanels.tsx:1120-1148` assembles the accordion:

- **"Skeleton Bone Rigging"** shows when the layer has a skeleton, OR the bone tool is active, OR
  the layer has no puppet.
- **"Puppet Mesh Pins"** shows when the layer has a puppet, OR the puppet tool is active, OR the
  layer has no skeleton.

**PuppetControls** — pin count badge, "Add Pin" (activates the tool), solver dropdown
(ARAP / LBS), Mesh Density slider (2–50), Mesh Expansion slider (0–100), then a card per pin with
Rotation (°) and Stiffness fields plus delete. Empty state offers *"Place Pins with Puppet Tool
(Ctrl+P)"*.

**BoneControls** — bone count badge, "Add Joint", a Skinning Mesh card (density/expansion) **only
when there is no puppet rig** (otherwise an explanatory note about composition), then a card per
bone: parent indicator (`← parentId` or `(Root)`), Bone Length, **Rest Angle (converted rad↔deg at
the display boundary)**, and an Enable IK Target / IK Active toggle.

### 7.5 "Rig Logo for Animation" (`rigLogo.ts`)

Menu entry at `DemoPanels.tsx:299`. Solves the "I want to rig my multi-part logo" problem:

Puppet/bone rigging only works on a **single leaf image or shape layer**, because the warp mesh
comes from its bitmap alpha or path silhouette. A group/precomp has no composited texture to warp
(the renderer flattens precomps at draw time). So:

- **Exactly one riggable leaf selected** (`image` or `shape`, no children) → rig it in place, no
  quality loss.
- **Anything else** (group, precomp, multi-selection) → render the subtree through the **real GPU
  engine** at native resolution tight to its world bounds (transparent background, up to 4 passes
  awaiting media), export a PNG data URL, insert it as one image layer at the original comp bounds,
  and rig that.

Either way it seeds a **starter rig**: an "Anchor" pin at bottom-center and a "Wave" pin at
top-center, switches to the puppet tool, and notifies *"Logo ready to rig — drag pins to animate."*

The GPU rasterize sits behind an injectable `rasterize` seam so the decision logic is unit-testable
without a GPU. `MAX_RASTER_DIM = 2048` caps device resolution.

---

## 8. Undo / command integration

Both rigs follow the `AnimEditCommand` convention: a command captures before/after state and swaps
between them, and is pushed onto history **already applied** (push does not re-execute).
**One user gesture = one undo step.**

`puppetCommands.ts`:
- `addPuppetPin(nodeId, pin)` → *"Add Puppet Pin \<name\>"*
- `deletePuppetPin(nodeId, pinId)` → *"Delete Puppet Pin \<id\>"*. Also removes
  `puppet.<pinId>.position|rotation|stiffness`, captured as a **nested `AnimEditCommand`**, so undo
  restores the pin *and* its keyframes.
- `updatePuppetSettings(nodeId, { meshDensity, meshExpansion, solver })`
- `updatePuppetPin(nodeId, pinId, { rotation, stiffness, name })`

`skeletonCommands.ts`:
- `addBone` / `deleteBone` (also cascades: removes child bones whose `parentId` matches, drops IK
  targets, and removes `bone.<id>.rotation|x|y` + `ikTarget.<id>.x|y` tracks in a nested anim edit)
- `updateBone`, `setIKTarget`, `updateSkeletonSettings`

Canvas drags use `beginAnimEdit()` / `recordAnimEdit(tx.commit(label))` so a whole drag is one step.

---

## 9. AI tools

Registered in `toolHandlers.ts:1122-1130`, documented to the model in `toolPlan.ts:146-170`:

| Tool | Args |
|---|---|
| `create_puppet_rig` | `{ layerId, pins: [{name?, x, y}] }` — layer-local coords centered on origin; returns generated pin ids |
| `set_puppet_pin_keyframes` | `{ layerId, pinId, keyframes: [{timeSec, x, y}] }` — the primary way to make a rig move |
| `create_skeleton_rig` | `{ layerId, bones: [{id, parentId?, length, x?, y?, rotation?}] }` |
| `pose_skeleton` | `{ layerId, bonePoses: [{boneId, timeSec, rotation, x?, y?}] }` — **degrees in the schema, converted to radians on write** |

Both create-tools **reject non-riggable layers** with an actionable message:
> *"Layer 'X' is a group — puppet rigs only apply to shape, image, or text layers. Rasterize it
> first (the 'Rig Logo for Animation' command flattens a group/precomp to a single riggable image)."*

`set_puppet_pin_keyframes` refuses if there's no rig yet: *"Call create_puppet_rig first."*

The prompt explicitly warns: *do not* `set_keyframes` on `puppet.<pinId>.position` — it's a points
data track.

---

## 10. Determinism guarantees

This is treated as a hard contract throughout — export must equal preview, frame for frame.

- **No `Date.now()`, no `Math.random()`** anywhere in the solvers.
  (`Date.now()` appears only in *authoring* code for id generation — see §12.7.)
- **Fixed iteration counts** everywhere: 150 Jacobi (weights), 4 ARAP outer, 64 GS sweeps,
  12 FABRIK, 3 unskin.
- **Fixed traversal and factorisation order**; `Float64` arithmetic internally, `Float32` output.
- **Caches keyed on value signatures**, not identity or time: FNV-1a hashes for silhouettes,
  coverage masks, and stiffness fields; quantized stiffness (1/1024) so static stiffness yields one
  stable key.
- **Coverage masks** are fixed-resolution alpha downsamples with a fixed threshold, keyed by asset
  identity — the same source always caches the same mask, so scrubbing never resamples or drifts.
- Verified by `puppetSnapshotParity.test.ts`: two snapshot builds at the same time are
  bit-identical, **and** a fresh graph + fresh animation engine reproduces the same vertices.

---

## 11. Test coverage

**18 rig-related suites, 188 tests** (`npx jest src/core/rig src/core/animation/dataKeyframeEasing
src/core/animation/dataSpatialTangents src/core/workspace/renderSubscribers src/core/scene/rigLogo`).
Whole repo: **364 suites / 3864 tests** green.

| Suite | What it locks down |
|---|---|
| `puppet.test.ts` (16) | deterministic rest mesh + auto-weight; LBS; bit-identical repeats; single-pin rigid rotation; zero-rotation/stiffness ≡ translate-only; stiffness sharpens falloff; silhouette culling; image-alpha culling; coverage determinism |
| `arap.test.ts` (14) | bit-identical repeats; **two-pin bent bar: ARAP keeps triangle area where LBS candy-wraps to ~zero**; zero stiffness bit-identical; stiffness *gradient* starches but a *uniform* field changes nothing; <2 pins → exact LBS fallback; degenerate mesh never NaN; solver-cliff threshold reported correctly |
| `phase3.test.ts` (33) | per-pin scale (1 ≡ unscaled bit-identically; scale centred on the pin; composes with rotation); rotation refinement (no-limit returns the same array; clamps preserve sign); silhouette meshing (fewer vertices, all on the artwork, normalized weights, degenerate fallback); overlap depth (null when unused, highest near its pin, opposing signs, extent broadens); Puppet Sketch (straight run → 2 points, L-corner preserved, tolerance monotonic, endpoints exact, deterministic, recorder lifecycle) |
| `overlapOrder.test.ts` (11) | painter's ordering back-to-front; winding preserved; stable sort; index multiset unchanged; buildSnapshot attaches depth + reorders only when overlap exists; scale / rotation-refinement / animated scale / bone scale all reach the rendered mesh |
| `weightPaint.test.ts` (15) | map lifecycle; refuses a mismatched mesh rather than smearing; add/subtract/smooth; feathering; clamping; immutability; determinism; merge redistributes and always renormalises to 1 |
| `overlayMeshParity.test.ts` (8) | overlay and snapshot agree for image layers; the pre-fix derivation genuinely differed; weight columns match; undecoded bitmap falls back on both sides; coverage precedence rules |
| `puppetPinPlacement.test.ts` (4) | click-add stores rest space; `unskinPoint` sub-pixel accurate; a pin draws back under the pointer; identity without a skeleton |
| `puppetPinEasing.test.ts` (7) | easing on a pin's position track reaches the deformed mesh (ease-in/out, hold, custom bezier); endpoints exact |
| `dataSpatialTangents.test.ts` (15) | straight by default; a tangent bends the path; endpoints pinned; mirror vs broken points; spatial and temporal independent; handle positions round-trip; smooth / straighten |
| `dataKeyframeEasing.test.ts` (12) | F9 reaches a data keyframe and changes the sampled value; Hold; Linear clears; values untouched; scalar path unregressed; mixed selection |
| `rigIds.test.ts` (11) | lowest free ordinal; gap filling; never reissues; batch self-collision; legacy timestamp ids respected; deterministic; rest-mesh cache bounded + **LRU keeps the active mesh resident under churn** |
| `renderSubscribers.test.ts` (4) | multiple render-tick subscribers coexist; disposer removes only its own; double-dispose safe; unsubscribing mid-tick |
| `rig.test.ts` (13) | FK composition + cycle guard; LBS blending; `normalizeWeights`; two-bone reach + unreachable; FABRIK; `anglesFromJoints` |
| `mesh.test.ts` (8) | `flattenOutline`, `polygonArea`, `earClip` (square + concave L), `subdivide`, auto-weight — **now covering shipping code** (§12.1) |
| `puppetSnapshotParity.test.ts` (3) | live vs export bit-parity; fresh-graph reproducibility; animation genuinely changes the mesh |
| `puppetInteraction.test.ts` (1) | the exact overlay gesture animates the rendered mesh |
| `skeletonCommands.test.ts` (2) | bone add with undo/redo; update + clean delete |
| `deformedMeshTransform.test.ts` (2) | rest-mesh corners map to the layer rect; a displaced pin follows |
| `rigLogo.test.ts` (9) | rig-target decision; starter pins deterministic + no id reuse; text routes to rasterize (§12.10) |

### Golden-frame coverage

`packages/render-tests/harness/scenes/rig.ts` adds **8 scenes** — `rig-puppet-bend`,
`rig-puppet-lbs-vs-arap`, `rig-puppet-scale`, `rig-puppet-rotation-refinement`, `rig-puppet-overlap`,
`rig-skeleton-pose`, `rig-skeleton-bone-scale`, `rig-compose-puppet-skeleton`. Before these,
`deformedMesh` had **zero** pixel coverage, which is a problem because the mesh path is exactly where
vertex-level assertions miss things: UV mapping into the padded texture, the unit-quad normalisation
in `snapshotToFrameScene`, triangle winding, and — since overlap resolves as draw ORDER — which fold
ends up on top. References are blessed from WebGL2 and were eyeballed frame by frame.

### Component coverage

`PuppetOverlay.test.tsx` (13), `BoneOverlay.test.tsx` (13) and `RigControls.test.tsx` (17) cover the
pointer plumbing and the inspector, which previously had none: click-add bounds and id uniqueness,
the stray-pin suppression guard, drags writing tracks rather than static props, the gizmo's scale
handle, bone selection / FK posing / IK pole drags, the mesh preview and weight heatmap, paint
strokes, and — in the inspector — the radians↔degrees conversion on Rest Angle, the solver-quality
disclosure, and the `0 = unlimited` sentinel.

Two shims make this possible and are worth knowing about (`jest.setup.ts`): **jsdom ships no
`PointerEvent` class at all**, so testing-library fell back to a generic `Event` carrying no
`clientX`/`clientY` — handlers then computed `undefined - 0` = NaN and silently wrote NaN
coordinates. It also has no pointer-capture methods. Both are polyfilled. The test that covers
`capturePointer`'s guard explicitly re-mocks `setPointerCapture` to throw, so it exercises the guard
rather than the polyfilled happy path.

**Still not covered:** the GPU mesh-buffer path in `passUtils`, and the async
`imageAlphaCoverage` decode.

## 12. Current state — gaps, defects, and honest limitations

The math layer is complete and well-tested. Everything below is real, verified against the code, and
ordered roughly by impact.

> **Status (2026-07-28).** Phases 1–4 of the parity brief have landed. §12.1 (dead `mesh.ts`) is
> resolved — it now backs the `meshMode: 'silhouette'` path. §12.6 (3D depth exclusion) remains
> OPEN by design: overlap resolves as painter's ordering **within** the layer
> (`sortTrianglesByDepth`), deliberately not via the scene depth buffer. §12.9's list is now built:
> weight painting, bone/pin names, mesh preview under the Bone tool, IK pole vectors, bone scale
> keyframing, per-pin scale, and Overlap pins all ship.
>
> **Status (2026-07-27 fix pass).** §12.2, §12.3, §12.4, §12.7, §12.8, §12.10 and §12.11 are
> **FIXED** — each is marked below with what changed and how it was verified. §12.1, §12.5, §12.6
> and §12.9 remain open. Two things were discovered while fixing:
>
> * **`unskinPoint` was under-iterated.** `UNSKIN_ITERATIONS = 3` left a **6.4px** worst-case
>   round-trip error (~11% of the displacement) where two bone weight columns still mix and the
>   displacement is large — feeding a visibly wrong rest coordinate into pin placement. Measured
>   convergence: `3 → 6.43, 4 → 2.22, 6 → 0.187, 8 → 0.028, 10 → 0.007, 12 → 0.002 px`. Raised to
>   **12**; it runs on pointer input only, never in the render loop.
> * **Data-track easing already exists.** `DataKeyframe` carries `easing` / `bezier`, and
>   `sampleDataTrack` remaps the segment parameter through the temporal curve (including `hold` /
>   `step`). Puppet pin motion is therefore **not** linear-only. Verified end to end in
>   `puppetPinEasing.test.ts` — ease-in/out/hold/bezier all reach the deformed mesh. What is still
>   missing is **spatial** tangents for point-valued data tracks (curved pin paths) and **Easy Ease
>   / F9 on a data keyframe** — `applyEasingToKeyframes` only walks the scalar-track API.

### 12.1 `mesh.ts` was dead code — **FIXED** (2026-07-28)

`flattenOutline` / `earClip` / `subdivide` / `polygonArea` had no callers outside their own tests.
They now back `PuppetRig.meshMode: 'silhouette'` (§3.1): instead of culling a uniform grid, the
layer's outline is ear-clipped and midpoint-subdivided, which puts every vertex on the artwork.
On a thin diagonal bar this uses fewer vertices than the grid for the same shape.

Grid remains the **default** — changing it would change every existing rig's deformation.

**A real bug surfaced doing this:** `earClip` pushes the final triangle of a 3-point ring
*unconditionally*, so three collinear points return one zero-area triangle rather than nothing. A
triangle-count check therefore passes and you get a mesh that deforms nothing. `buildSilhouetteMesh`
now rejects outlines whose `polygonArea` is below a fraction of the layer area, *before*
triangulating, and falls back to the grid.

Still unused: `buildMesh`, and the plural `skinMesh` / `autoWeightMesh` (only the per-vertex forms
are called).

### 12.2 `onRender` was a single-slot setter with three registrants — **FIXED**

```ts
onRender(cb: () => void): void { this.renderCb = cb; }   // WorkspaceController.ts:108
```

Registrants: `useWorkspace.ts:388` (the actual viewport draw), `PuppetOverlay.tsx:83`,
`BoneOverlay.tsx:70`. It is **not** a listener list, and neither overlay unsubscribes.

Both overlays mount unconditionally (`Workspace.tsx:335-336` — their `useEffect` runs before the
early `return null` for the inactive tool). Child effects run before parent effects, so
`useWorkspace`'s `render` registers last and wins — meaning **the overlays' "force re-render on
render ticks / camera movements" effect never fires.** The overlays still repaint via store
subscriptions and scene bumps, so this is not a blank screen; the likely symptom is pin/bone handles
lagging a camera pan or zoom until some other state change lands.

*Needs a live check to confirm the user-visible symptom, but the code-level defect is unambiguous.*
Fix is small: make `onRender` a subscribe/dispose list.

### 12.3 Overlay wireframe disagreed with what renders (image layers) — **FIXED**

`PuppetOverlay.tsx:143-150` calls:

```ts
getCachedRestMesh(node.id, geom.width, geom.height, pad, puppetRig ?? {pins:[]}, silhouette)
//                                                              ↑ no `coverage` argument
```

`buildSnapshot` passes the alpha coverage mask; the overlay does not. So on an **image layer**, the
overlay draws the untrimmed bbox grid while the renderer deforms an alpha-culled mesh — different
vertex counts, different weights, different heatmap. Shape layers are unaffected (both pass the
silhouette).

### 12.4 Pin *placement* ignored skeleton posing (drag did not) — **FIXED**

In the same file, the drag path correctly maps pointer input to rest space:

```ts
const localCoords = toRestSpace(screenToLocal(currentScreen.x, currentScreen.y));  // :296
```

but the click-to-add path does not:

```ts
const localCoords = screenToLocal(sx, sy);                                        // :365
const newPin: PuppetPin = { id: pinId, name: ..., x: localCoords.x, y: localCoords.y };
```

On a layer that has **both** a posed skeleton and puppet pins, a newly added pin gets a posed-space
coordinate stored as a rest-space value, so it lands somewhere other than where you clicked. Adding
`toRestSpace(...)` there matches the drag path.

### 12.5 `Bone.rotation` is radians in the data model — **OPEN (by design)**

`skeleton.ts` stores radians (the unit `fromTRS` consumes); the inspector converts at the display
boundary (`BoneControls.tsx:138-143`) and `pose_skeleton` converts from its degree schema. Puppet
pin rotation, by contrast, is **degrees**. This asymmetry is intentional and documented in-code, but
it is a live footgun for anything new that writes `bone.<id>.rotation` directly — there is already a
fixed bug comment about typing "45" and getting 45 *radians* (≈2578°).

### 12.6 Rigged layers are excluded from the 3D depth path — **OPEN**

`FrameScene.ts:236` — `if (r.deformedMesh) return false;` in `depthEligible3D`. A rigged layer
cannot participate in per-fragment 3D lighting or depth sorting; it composites as a flat textured
mesh. Fine today, but it means "rig a 3D-lit character" is not currently possible.

### 12.7 Ids came from `Date.now()` — **FIXED**

`PuppetOverlay` uses `pin_${Date.now()}`; `BoneOverlay` uses
`bone_${Date.now().toString(36).slice(2,8)}`; `rigLogo.starterPuppetPins` uses `pin_${now}_${i}`.
These are *authoring-time* only (never in a solver), so determinism is preserved — but two pins
added in the same millisecond collide, and the bone id takes a 6-char slice of a base-36 timestamp,
which is not collision-free either.

### 12.8 `restMeshCache` was unbounded — **FIXED**

`puppet.ts:582` — `const restMeshCache = new Map<string, DeformedMesh>()`, module-level, **no
eviction**. The key includes every pin's static `id:x:y`, so each pin add/move-in-rest and each
density/expansion change leaves a full mesh + weight matrix behind for the session. Contrast the
ARAP stiffness factor cache (capped at 8) and the skeleton binding cache (capped at 4), which both
evict. On a long authoring session over a dense mesh this is a real leak.

### 12.9 Authoring features — **BUILT** (2026-07-28)

Every item that used to be listed here now ships. Kept as a record of what was added and where:

- **Weight painting** → `weightPaint.ts` + the brush in `BoneOverlay`. Sparse per-(bone,vertex)
  overrides, add/subtract/smooth, one undo step per stroke. See §4.6.
- **Advanced pin components** → per-pin `scale` (folded into the rotation matrix as a similarity,
  so ARAP's local step scales the pin's 1-ring rigidly) and **Overlap pins** (§12.12). `stiffness`
  already covered AE's Starch, better, as a real energy term.
- **Bend pins** → `bendPins.ts`. A pin that derives its position from the others and acts on the
  deformation they already produced, solved in two passes (drivers only, then bends on top in list
  order). Supersedes the note that used to sit here calling AE's Bend pin "the one pin type still
  not modelled".
- **Mesh preview under the Bone tool** → `BoneOverlay` draws the posed skinning mesh and, with a
  bone selected, that bone's weight field as a heatmap.
- **Bone names** → `Bone.name`, editable inline in `BoneControls` (falls back to the id).
- **IK pole vectors** → `IKTarget.pole` + keyframeable `ikPole.<boneId>.x|y`, with a draggable
  handle. The solver still preserves the current bend side when no pole is set.
- **Bone scale keyframing** → `bone.<id>.scaleX|scaleY` are now sampled in `buildSnapshot`.

Since then, and closing the two items this section used to list as absent:

- **Bend pins** (above) — AE's Bend pin, modelled against the rig rather than as a convenience.
- **Per-vertex numeric weight editor** → `setVertexWeight` in `weightPaint.ts` + the Vertex Weights
  card in `BoneControls`, reached by the bone overlay's **Pick Vertex** mode. Editing one weight
  redistributes the others in proportion and writes the whole vertex, so the typed number is what
  reads back and what deforms. A single-influence vertex is read-only by construction.
- **Controllers** → `controllers.ts`, linked to a `bone` or an `ikTarget` by field, drawn at the
  driven point plus an offset.
- **Per-chain IK/FK switching** → `ikfk.ts`, keyframeable as `ikMode.<boneId>`, pose-preserving in
  both directions.
- **Auto-rig presets** → `rigPresets.ts`, biped and quadruped, gated on `validateRig`, one undo
  entry each, reachable from the Rigging panel and the Command Palette.

Nothing from the original gap list remains open. Out of scope by decision, not omission:
controllers driving puppet pins (see §1).

### 12.10 Riggable-kind inconsistency around text — **FIXED**

`RIGGABLE_KINDS = {'shape', 'image', 'text'}` and `isRiggableKind` accept **text** — the AI tools
gate on this, so `create_puppet_rig` will happily rig a text layer. But:

- `resolveRigTarget`'s in-place branch only accepts `image | shape` (`rigLogo.ts:95`), so
  "Rig Logo" on a selected text layer rasterizes it instead of rigging it in place.
- `buildSnapshot` derives the silhouette from `pathPoints` (vector geometry) and the coverage mask
  only for `layerKind === 'image'` — a text layer gets **neither**, so it falls back to the plain
  bbox grid. The `rigLogo.ts:57` comment *"Text rigs its glyph mask"* does not describe the
  implementation.

So text rigging technically works but deforms the whole bounding box, including empty space between
glyphs, which is exactly the artifact the coverage cull was built to prevent.

### 12.11 Solver quality cliffs were silent — **FIXED**

Crossing `DENSE_MAX` (density ≥ 34, or ≥ 22 with stiffness) drops ARAP from exact dense Cholesky to
64 fixed Gauss–Seidel sweeps. The result is still deterministic and stable, but softer — and nothing
in the UI indicates it happened. The density slider goes to 50 with no warning.

---

### 12.12 Overlap resolves by draw order, not a depth buffer — **BY DESIGN**

`sortTrianglesByDepth` reorders the mesh's own index buffer back-to-front rather than depth-testing.
Two reasons, both structural:

1. The GPU vertex format is fixed at `[x, y, u, v]`. A per-vertex depth would need a fifth attribute
   — a shader and pipeline change — for a value only this one layer type uses.
2. The mesh is a single alpha-blended textured draw. A real depth test fights blending at the
   silhouette edges, where the mesh is semi-transparent.

For an opaque folded mesh, painter's ordering produces the same picture. It is exact for the
common case (an arm over a torso) and degrades gracefully on genuinely interpenetrating geometry,
where no single ordering is correct anyway. This is also *why* §12.6 stays open: overlap is resolved
**within** the layer, deliberately not by joining the scene depth buffer.

## 13. Quick reference — extending this

**Add a per-pin property** (e.g. an "overlap" ordering scalar):
1. Add to `PuppetPin` and `DeformPin` in `puppet.ts`.
2. Sample it in **both** `buildSnapshot.ts:1374` and `PuppetOverlay.tsx:155` (they must mirror).
3. Consume it in `deformLbs` and/or `deformArap`. If it changes the ARAP *system matrix*, it must
   join the factor cache key like stiffness does, with its own quantized signature and a bounded
   cache — otherwise you reintroduce a per-frame O(m³) refactor.
4. Add a `ValueField` to `PuppetControls.tsx` calling `updatePuppetPin`.
5. Add a bit-identity test: absent/zero value must reduce **exactly** to the existing path.

**Add a bone property:** `Bone` in `skeleton.ts` → sample in `buildSnapshot.ts:1402` and
`BoneOverlay.tsx:118` → `restBonesKey` in `rigDeform.ts:171` (or the binding cache goes stale) →
`BoneControls.tsx` → `deleteBone`'s track cleanup in `skeletonCommands.ts:126`.

**Non-negotiables:** no `Date.now()`/`Math.random()` in a solver; fixed iteration counts; caches
keyed by value signature; any new fallback must be graceful (return the warm-start buffer, never
NaN, never throw); and the overlay must mirror `buildSnapshot` exactly or the preview lies.
