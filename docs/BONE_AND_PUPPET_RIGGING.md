# Bone Tool & Puppet Tool — the C++ rig engine

**Scope:** what `premation-engine` does for 2D mesh deformation — the Puppet (pin) rig and the
Bone (skeleton) rig: data model, rest mesh, solvers, skinning, caching, costs, determinism, tests,
and what is still missing. The UI side (overlays, inspector, timeline rows) is documented where it
lives; this file is the engine's contract with it.

**Written:** 2026-07-27 (TypeScript engine) · **Rewritten:** 2026-11-02 for the C++ engine
(rigging program, stream C1: R1 caches, R2 coverage, R3 barycentric pins + exact harmonic weights,
R4 ARAP/IK/skinning). The TypeScript engine is deleted (docs/TS_ENGINE_REMOVAL.md); the names of
its modules survive only as section labels in the source comments.

---

## 0. TL;DR

| | Puppet | Skeleton |
|---|---|---|
| Stored at | `fx.puppet` on the layer | `fx.skeleton` on the layer |
| Mesh | one rest mesh per layer, shared by both rigs (grid, path silhouette, or alpha outline) | same mesh |
| Deformer | ARAP (default) or LBS over harmonic pin weights | LBS or dual-quaternion skinning over geodesic bone weights |
| Pin binding | the containing triangle, barycentric (R3) | — |
| Weights | harmonic, cotangent Laplacian, CG to 1e-8 (R3) | geodesic partition, ≤ 4 influences, + weight paint |
| IK | analytic two-bone, FABRIK for 3–8, pole vectors, **IK/FK blend 0..1** (R4) | |
| Caching | rest mesh + bindings + weights + topology, ARAP factor, bone weights, re-cut coverage — value-keyed LRUs (R1) | |
| Per frame | live pins/bones → ARAP right-hand side (or LBS) → skinning → depth sort | |
| Determinism | no wall clock, no threads inside a solve, caches keyed by the inputs that determine the value | |

Both rigs can sit on the **same layer**: the puppet deforms in rest space, the skeleton skins the
result. Rendering consumes `layer.deformedMesh` (`DeformedMeshData`: x,y,u,v per vertex, uint16
triangles, optional per-vertex overlap depth) — an indexed mesh draw, overlap resolved by
triangle order within the layer.

## 1. File map

```
native/engine/src/scene/
├── rig_mesh.hpp/.cpp     the rig block: rest mesh, pin binding, harmonic weights, LBS, ARAP,
│                         bend pins, overlap depth, skeleton FK/IK, geodesic weights, weight paint,
│                         LBS / dual-quaternion skinning, the RigModel the overlays read, the caches
├── rig_cache.hpp         ValueLru<V>: bounded (entries + bytes), value-keyed, mutex-guarded LRU; Fnv64
├── alpha_mesh.hpp/.cpp   image coverage: AlphaPlane, coverage_mask_from_alpha (R2), the legacy
│                         64²/max-alpha mask (tests only), alpha outline → Delaunay mesh
├── rig_coverage.hpp/.cpp decode an image / SVG source → AlphaPlane → default mask, cached per
│                         key + file stamp (bounded LRU)
├── rig_bridge.cpp        build_rig_mesh_for: the document's animation as a RigSampler
├── rig_overlay.cpp       DocRigQueries: the overlay push (pins, bones, IK goals, mesh, weights,
│                         pin path) and getRigPose, over RigModel
└── snapshot_build.cpp    calls build_rig_mesh_for per rigged layer → layer.deformedMesh
native/engine/src/core/rig.cpp     the property catalog (rigSpecs.ts ⇄ catalog/fields.json)
native/engine/src/core/skeleton_pose.{hpp,cpp}  bones, FK, IK (+ stretch / softness), read_skeleton,
                                   live bone / goal sampling — moved out of rig_mesh.cpp 2026-11-03 so
                                   engine_core can pose a skeleton with no mesh (docs/CHARACTER_RIG.md)
native/engine/tests/test_rig_cache.cpp     R1–R4 (this program)
native/engine/tests/test_rig_parity.cpp    frozen deformed-mesh fixtures (rig_parity.json)
native/engine/tests/test_alpha_mesh_parity.cpp  legacy mask + alpha outline fixtures
native/engine/tests/test_b4_round5_rig.cpp  overlay push + getRigPose through the Session
```

## 2. Data model

Storage is unchanged: `fx.puppet` / `fx.skeleton` objects and the keyframe tracks
`puppet.<pin>.position|rotation|stiffness|scale|overlap`, `bone.<id>.x|y|rotation|scaleX|scaleY`,
`ikTarget.<id>.x|y`, `ikPole.<id>.x|y`, `ikMode.<id>`.

### 2.1 Mesh settings (both rigs; the puppet's win when it has pins)

| key | type | default | meaning |
|---|---|---|---|
| `meshDensity` | number | 22 | grid cells per side (2–50); the alpha outline's lattice spacing = longSide / density |
| `meshExpansion` | px | 0 | grid grown / outline offset |
| `meshMode` | `grid` \| `silhouette` | grid | silhouette: trace a closed path or the image alpha |
| **`traceAccuracy`** | 0–100 | **60** | R2, image layers: coverage cell ≈ 16 px at 0, **4.6 px at 60**, 2 px at 100 (`coverage_cell_px`), at most 512 cells across |
| **`alphaThreshold`** | 0–255 | **32** | R2, image layers: a pixel counts as covered at this alpha or above |
| **`preserveVolume`** (skeleton only) | `off` \| `on` | **off** | R4: dual-quaternion skinning |
| `solver` (puppet) | `arap` \| `lbs` | arap | |
| `maxRotationDeg` (puppet) | ° | 0 = off | ARAP rotation refinement clamp |

Catalog paths: `puppet/mesh/traceAccuracy`, `puppet/mesh/alphaThreshold`,
`skeleton/mesh/traceAccuracy`, `skeleton/mesh/alphaThreshold`, `skeleton/mesh/preserveVolume`
(rigSpecs.ts rows + fields.json; static, not keyframeable).

**Old documents:** the fields are absent → the defaults apply. The coverage mask itself changed in R2
(64² max-alpha → ~4.6 px cells by area share), so an image-layer rig saved before 2026-11-02 meshes
more finely than it did; vector-layer rigs are unaffected by R2 but their pin weights changed with R3
(see §10).

### 2.2 Pins

`{id, x, y, kind?, position?, rotation?, stiffness?, scale?, overlap?, overlapExtent?}` — `x,y` is
the rest anchor, `position` a static pose, the track overrides it. Kinds: `advanced` (default),
`position`, `starch`, `bend`, `overlap`. A bend pin is not a driver: it rotates/scales the mesh
about its own carried point after the other pins have solved.

### 2.3 Skeleton

`{bones: [{id, parentId, length, x, y, rotation (radians), scaleX?, scaleY?, influenceRadius?}],
bindPose?: [...], ikTargets: [{boneId, x, y, chainLength?, pole?, enabled?, ikMode?}],
weightPaint?: {vertexCount, bones: {boneId: {vertexIndex: weight}}}, controllers?, preserveVolume?}`.

## 3. Rest mesh

`build_rest_mesh` (rig_mesh.cpp) — one of:

1. **Grid** (`meshMode: grid`): `cells × cells` quads over the layer box + pad + expansion, each quad
   two triangles. With a closed path or an image mask only covered cells are kept (a corner or an
   interior probe inside; for an alpha mask the probe lattice is no coarser than a mask cell, ≤ 8×8);
   `expansion > 0` dilates the kept cells by one.
2. **Path silhouette**: a closed `Geometry.points` path ear-clipped and subdivided 0–3 rounds by
   density (`< 8 → 0, < 18 → 1, < 32 → 2, else 3`), ≤ 65535 vertices.
3. **Alpha outline** (image / SVG layers): marching squares over the coverage mask → Douglas–Peucker
   (tolerance = half a mask cell) → miter offset by expansion + tolerance → boundary resampling + hex
   Steiner lattice → Bowyer–Watson Delaunay clipped to the region. A region whose kept triangles cover
   < 97 % of it is retried with the boundary sampled twice as finely; over the 2600-point budget the
   lattice AND (R2) the boundary step coarsen ×1.6, four attempts, then the covered grid.

UVs are `(x + w/2 + pad) / (w + 2·pad)`; vertices are float32.

### 3.1 Image coverage (R2)

`rig_coverage.cpp` decodes the source once (file / data URL / SVG through the C++ SVG renderer),
reduces its alpha to an `AlphaPlane` of at most 1024 px on the long side (integer box average), and
cuts the **default** mask. The mask carries its plane; when a layer's `traceAccuracy` /
`alphaThreshold` differ from the defaults `rig_mesh.cpp` re-cuts the mask from the plane (cached by
plane key + settings).

`coverage_mask_from_alpha`: cells of `coverage_cell_px(traceAccuracy) = 16 · 0.125^(a/100)` source
pixels, `cols = clamp(round(W / cell), 1, min(512, W))` (rows alike); a cell is kept when at least
**35 %** of its pixels have `alpha ≥ alphaThreshold`. A 1080 px character at the default gets
~235 cells across (was 64 → cells of ~17 px that fused legs and arms); the share rule stops a single
anti-aliased pixel from claiming a cell, so gaps stay gaps.

The legacy builder `coverage_mask_from_image_data` (64² max-alpha ≥ 12) remains only for
`tests/data/alpha_mesh_parity.json`.

## 4. Pin binding and weights (R3)

`finish_rest_mesh`:

- **Binding.** Each pin finds the rest triangle that contains it (barycentric test, tolerance
  −1e-6) and stores the three corners + weights (`PinBinding`). Off the mesh: the nearest vertex,
  weight 1. `pinVertex` (the heaviest corner) is kept for callers that want one vertex.
- **Harmonic weights.** The cotangent Laplacian of the mesh (`build_topology`: per-edge
  `0.5·max(1e-3, cot)`, degenerate triangles 0.5, clamped |cot| ≤ 1e3) is built once and shared with
  ARAP. For pin *p*: Dirichlet values 1 on *p*'s corners, 0 on every other pin's corners, Δw = 0
  elsewhere, solved with Jacobi-preconditioned conjugate gradients to a relative residual of 1e-8
  (at most min(3000, free+8) iterations, clamped to [0,1]). Vertices in a component with no pin get
  0. Columns are then normalised to sum to 1 per vertex.

What this buys: a pin's handle is the point the user clicked, not the nearest grid vertex; dragging
it moves that exact point (test "a pin binds to its triangle and lands where it is dragged");
rotation and scale pivot on it; the weights are the true harmonic field instead of a 150-sweep
Jacobi approximation (which on a 10k-vertex mesh had not spread past the pins).

## 5. Puppet solvers

### 5.1 LBS (`deform_lbs`)

Per vertex, displacement = Σ wₚ · (Tₚ(v) − v) with Tₚ the pin's rotation·scale about its rest point
plus its translation. Stiffness sharpens weights: wₚ^(1+s), renormalised.

### 5.2 ARAP (`deform_arap_with_handles`) — default

Sorkine–Alexa as-rigid-as-possible over the cotangent topology:

- **Handles:** every corner of every pin's binding triangle, target = the pin's transform applied to
  the corner (`resolve_pinned_vertices`); fewer than 2 bound pins → the LBS warm start is the answer.
- **Local step:** per free vertex the best rotation of its one-ring (atan2 of the covariance),
  clamped to `maxRotationDeg` when set.
- **Global step:** the free system `(D − W) x = b` with pinned neighbours on the right-hand side.
  Free count ≤ 1200 (≤ 512 with stiffness): dense Cholesky, factored once and **cached** (R1), the
  per-frame work is two back-substitutions per outer iteration. Larger: 64 Gauss–Seidel sweeps.
- **Outer iterations:** **8 with a cached factor** (R4), 4 on the Gauss–Seidel path.
- Stiffness scales the edge weights by `1 + 6·(sᵢ + sⱼ)/2`; the factor key includes the stiffness
  values, so an animated stiffness re-factors (only) when it changes.
- A non-finite result falls back to the LBS warm start.

### 5.3 Bend pins

Drivers (non-bend pins) solve first over a driver mesh whose weight columns exclude the bend pins
(cached under the rest key). Each bend pin then rotates/scales its rigid core (its own corners + every
vertex with harmonic weight ≥ 0.8) about its carried point — the barycentric point of its triangle in
the solved mesh — and ARAP runs again with those vertices added as handles (LBS solver: a weighted
rotation blend instead).

### 5.4 Overlap

Pins with `overlap ≠ 0` write a per-vertex depth (weights^(1/extent), normalised); triangles are
stable-sorted by mean depth — painter's order within the layer.

## 6. Skeleton

- **FK** (`compute_world`): parent-first, memoised; a cycle resolves to identity.
- **IK** (`apply_ik`): per enabled goal, the chain of `chainLength` (1–8) ancestors; 1 bone = aim,
  2 = analytic law-of-cosines with the elbow on the pole's side (or the current bend), 3–8 = FABRIK
  (12 iterations, 0.25 px). The solve yields per-bone rotation deltas relative to the chain above.
- **IK/FK blend (R4):** `ikMode.<bone>` keyframes read as a weight in [0,1] (clamped); the applied
  rotation is `FK + blend · (IK − FK)` per bone. Stored `ikMode: 'fk'` = 0, anything else = 1. The
  overlay still reports `mode` as `ik` at ≥ 0.5 and carries `blend` (`RigIkOut.blend`). The static
  property codec (rig.cpp `ikMode`) still writes the string; a numeric static value is C2's call.
- **Binding** (`cached_bone_binding`): the bind pose (`bindPose` else the bones) gives one segment per
  bone; weights by geodesic distance over the mesh edge graph (Dijkstra from a band of nearest
  vertices), partitioned with a cubic falloff inside a seam band `max(1.5·meanEdge, 0.18·meanBone)`,
  `influenceRadius` fades, ≤ 4 influences; `weightPaint` (when `vertexCount` matches) overrides per
  vertex. Cached per rest mesh + segments + paint (R1).
- **Skinning:** linear blend (Σ w · poseᵢ·bindInvᵢ · v; a partial total leaves the rest on the
  identity) or, with `preserveVolume: on`, the bones' rigid parts blended as 2D dual quaternions
  (real (w, z), dual (dx, dy); hemisphere-matched to the first bone; uniform scale blended linearly).
  A joint vertex then swings on an arc at its radius instead of pinching toward the chord (test
  "preserveVolume keeps a joint vertex at its radius"). The overlay's point helpers (`skin`,
  `unskin`) use the same blend.

## 7. Composition

`build_rig_mesh`: rest mesh → puppet deform (if pins) → skeleton skinning (if bones) → overlap sort.
The overlay model (`build_rig_model`) runs the same pipeline and additionally resolves every pin's
drawn point (through the skeleton), every bone's live and solved pose, every IK goal, the lattice
edges, a bone's weights and a pin's motion path. The Puppet tool's pinless `authoring` preview builds
the mesh without a rig.

## 8. Caching (R1)

`rig_cache.hpp` `ValueLru<V>`: an `unordered_map` + recency list behind one mutex, bounded by entry
count and a byte estimate, oldest out first; `insert` returns the value already stored on a race.
Keys are the **serialised inputs** (`KeyWriter`: doubles as their 8 bytes, strings length-prefixed),
never a digest, so a hit is the value a miss would compute — `test_rig_cache.cpp` asserts the
vertices, triangles and depth of a warm build are bit-identical to a cold one, and to the overlay
model's.

| cache | key | value | bound |
|---|---|---|---|
| rest | width, height, pad, expansion, density (+ the stored density), silhouette flag, cells, pins (id, x, y, kind), path points, coverage key (or cells), + `drivers` variants per bend-pin set | vertices, triangles, pin bindings, harmonic columns, topology | 64 entries / 128 MB |
| factor | rest key + pinned flags + stiffness per pin | dense Cholesky (m² doubles) or the stiffness-scaled weights for Gauss–Seidel | 64 / 192 MB |
| bones | rest key + bind segments (id, root, tip, radius) + `stringify(weightPaint.bones)` | geodesic weights (+ paint), segments, seam band | 64 / 64 MB |
| coverage (re-cut) | alpha plane key + traceAccuracy + alphaThreshold | mask | 32 / 16 MB |
| decoded images (rig_coverage.cpp) | assetId ?? src + path + size + mtime | AlphaPlane (≤ 1 MB) + default mask, or a remembered failure | 64 / 96 MB |

Per frame, with warm caches, the rig block does: live pin/bone sampling, LBS (O(n·pins)), ARAP
local steps + 2 back-substitutions × 8 (O(8·(nnz + m²))), skinning O(n·4), the overlap sort
O(t log t). Nothing O(m³), no Dijkstra, no CG. A pin drag (every pointer move = a getRigPose query
plus a frame) therefore no longer re-factors; the first build after a rest-state change does.

What invalidates the rest entry: moving a pin's rest anchor, adding/removing pins, density /
expansion / mode / trace settings, the layer's size or padding, an animated path (each sampled path
is a new key — a path-animated rigged layer still rebuilds per frame and churns the LRU), a changed
image file. Failures (an outline that cannot be triangulated) are not cached.

## 9. Costs you can read off the code

- Rest grid: `(cells+1)²` vertices, ≤ 51² = 2601. Alpha outline: ≤ 2600 points per region,
  ≤ 65535 vertices.
- Topology: one pass over triangles + a sort per vertex ring.
- Harmonic weights: per pin one CG run, each iteration O(nnz) ≈ 6n; Laplacian CG converges in
  O(√n)-ish iterations with the diagonal preconditioner, capped at 3000. 20 pins on a 5k-vertex
  outline is tens of milliseconds, once.
- Cholesky: m³/3 flops once (1200 free → ~0.6 GFLOP), 11.5 MB; per frame 2·8 back-substitutions
  of m² each.
- Geodesic weights: one Dijkstra per bone, O(bones · n log n), once.
- Coverage: one pass over the alpha plane per cut (≤ 1024² bytes), once per image × settings.
- DQ skinning: per vertex per influence one atan2 + two sincos; LBS one 2×3 multiply.

## 10. Determinism and parity

- No wall clock, no RNG, no threads inside a solve; CG and ARAP have fixed operation order; cache
  keys are values. `motion::js` math where V8 behaviour mattered.
- **Fixtures that change on purpose with this program:** `tests/data/rig_parity.json` (every
  puppet case: pin binding + harmonic weights differ from the TypeScript's; ARAP runs 8 outer
  iterations) and, for image-layer cases that went over the point budget, `alpha_mesh_parity.json`.
  Re-bless with `PARITY_REBLESS=1 engine_scene_core_tests "[parity]"` and review the diff as code.
  `test_b4_round5_rig.cpp`'s numbers (bone poses, skinned pin points) do not depend on the puppet
  weights and should hold.

## 11. Tests

- `test_rig_cache.cpp`: cache hit == miss (bits), overlay model shares the caches; barycentric
  landing for LBS and ARAP; single-pin rigid translation; coverage cells/threshold/key and the
  re-cut through the rig; IK blend 0 / 0.5 / 1; DQ vs linear at a 90° joint.
- `test_rig_parity.cpp`, `test_alpha_mesh_parity.cpp`: frozen fixtures (re-bless, §10).
- `test_b4_round5_rig.cpp`: overlay push, getRigPose, pole side, payload split.
- `test_rig_coverage.cpp`: SVG / relative-path / remote sources.

## 12. What remains missing

- **Dense cap.** ARAP's exact path stops at 1200 free vertices (512 with stiffness); large outline
  meshes still take 64 Gauss–Seidel sweeps × 4. A sparse Cholesky (or CG with the cached
  preconditioner) would lift the cap — the factor cache is ready for it.
- **Pins outside the mesh** bind to the nearest vertex with weight 1 (no extrapolation).
- **Two pins in one triangle** share constrained corners (both get 1 there, normalised to ½ each).
- **Animated silhouette paths** rebuild the rest mesh every frame (keyed by the sampled points).
- **IK blend static value** is still the `ik`/`fk` string in the document (track values blend).
- **Non-uniform bone scale under preserveVolume** is approximated by the uniform scale √|det|.
- **Overlap** is per-layer triangle order, not scene depth (by design).
- **Bone rotation** is stored in radians (API speaks degrees) — unchanged.

## 13. Properties added by this program (for C2 / MCP)

| path | key | type | default | range |
|---|---|---|---|---|
| `puppet/mesh/traceAccuracy` | `traceAccuracy` | scalar | 60 | 0–100 (%) |
| `puppet/mesh/alphaThreshold` | `alphaThreshold` | scalar | 32 | 0–255 |
| `skeleton/mesh/traceAccuracy` | `traceAccuracy` | scalar | 60 | 0–100 (%) |
| `skeleton/mesh/alphaThreshold` | `alphaThreshold` | scalar | 32 | 0–255 |
| `skeleton/mesh/preserveVolume` | `preserveVolume` | choice | `off` | `off` \| `on` |

`ikMode.<bone>` track values are now read as a 0..1 blend (were thresholded at 0.5).
