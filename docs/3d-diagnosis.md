# 3D camera / lights / views — Phase 0 diagnosis

**Date:** 2026-07-27 · **Scope:** diagnosis only, no fixes applied.
**Method:** code reading + a throwaway jest harness (`buildSnapshot` driven at
`camera3dMode` ∈ {active, front, back, left, right, top, bottom}, comp 800×600).
The harness was deleted after the run; its numbers are reproduced verbatim below.

---

## Verdict table

| Node | Question | Verdict |
|---|---|---|
| D1 | Per-layer 3D switch exists and is wired? | **Expected behavior** — exists, wired, correct |
| D2 | View camera separate from scene camera? | **Real bug** — ortho views navigate the *scene* camera |
| D3 | Orthographic projection correct? | **Expected behavior** — math is correct; edge-on = zero-area quad is AE-correct |
| D4a | Backface culling? | **Not applicable** — no culling exists anywhere |
| D4b | Near/far clip planes? | **Real bug (minor)** — near *clamps* instead of rejecting; layers behind the camera inflate to 1111× |
| D4c | Frustum culling vs wrong matrix? | **Not applicable** — no frustum-culling stage exists |
| D4d | Comp-frame clipping? | **Expected behavior** — targets are viewport-sized, nothing is clipped |
| D5 | Layers billboarded? | **Not applicable** — no global billboard. (AE's opt-in *Toward Camera* is missing — a gap, not a bug) |
| D6 | Do the six views differ? | **Expected behavior** — all six produce distinct output |
| D7 | Reference geometry inventory | **Real bug — and this is the bulk of the reported symptom** |

**Headline:** the projection math is sound and the six views genuinely differ.
The reported "nothing shows from the side" is two separate things: (a) an
edge-on flat plane correctly drawing zero pixels, which AE does too, and (b) the
complete absence of camera gizmos, frustum cones, light gizmos, and any
always-on ground plane — which is what makes AE's side views legible and is
missing here. Two genuine defects sit alongside that: ortho-view navigation
writes to the scene camera, and the near plane clamps rather than clips.

---

## D1 — Per-layer 3D switch

**Verdict: expected behavior. Exists and is correctly wired.**

- The flag is *implicit*: `is3DEnabled` ([threeD.ts:102](../src/core/scene/threeD.ts#L102))
  returns true when the Transform component carries any of `z` / `rotationX` /
  `rotationY` as a number. `set3DEnabled` ([threeD.ts:202](../src/core/scene/threeD.ts#L202))
  seeds them at 0 / removes them (and drops their animation tracks).
- Eligibility is gated by `canBe3D` ([threeD.ts:96](../src/core/scene/threeD.ts#L96)):
  Transform + kind ∈ {shape, text, image, video}.
- Read at four sites, all consistent: renderer
  ([buildSnapshot.ts:878](../src/core/rendering/buildSnapshot.ts#L878)), selection
  chrome ([ports.ts:144](../src/core/workspace/ports.ts#L144)), gizmo
  ([useGizmo3d.ts:87](../src/layout/Workspace/useGizmo3d.ts#L87)), nav gate
  ([cameraNav.ts:56](../src/core/workspace/cameraNav.ts#L56)).

**Observed** (comp 800×600, one 2D layer + one 3D layer at z=500, both at 400,300):

| view | 2D layer `flat` | 3D layer `deep` |
|---|---|---|
| active | (400, 300) | (400, 300) |
| left | (400, 300) | (−100, 300) |
| top | (400, 300) | (400, −200) |

The 2D layer does not move when the view/camera changes; the 3D layer does.
`flat` also carries no `matrix` (2D draw path untouched). This is exactly AE's
behavior. Tree continues.

**One design note, not a defect:** because the flag is prop-presence rather than
an explicit boolean, `insertCamera` writing `z = -focalLength` makes every
camera satisfy `is3DEnabled`. Two call sites already have to compensate by
excluding kinds — [useGizmo3d.ts:85-87](../src/layout/Workspace/useGizmo3d.ts#L85)
and [ports.ts:151](../src/core/workspace/ports.ts#L151). It works today; it is a
trap for the next 3D-aware surface added.

---

## D2 — View camera vs scene camera

**Verdict: partly correct, one real architectural bug.**

### What is correct

- **The six axis views are viewport-only.** `camera3dMode` lives in
  `guidesStore`; `setCamera3dMode` ([guidesStore.ts:200](../src/stores/guidesStore.ts#L200))
  is a plain zustand `set` — it touches no scene node and creates no undo entry.
  The renderer branches on it at
  [buildSnapshot.ts:513](../src/core/rendering/buildSnapshot.ts#L513) and uses
  `projectOrtho`; the scene camera is not consulted at all.
- **Custom Views 1/2/3 are properly separate.** Stored orbit params
  (`yaw/pitch/distance/poi`) in `guidesStore.customViews`;
  `customViewCamera()` builds a throwaway `Camera3D` that *replaces* the scene
  camera downstream ([cameraNav.ts:254-266](../src/core/workspace/cameraNav.ts#L254),
  [buildSnapshot.ts:517](../src/core/rendering/buildSnapshot.ts#L517)). Orbit /
  track / dolly in a custom view write to the store, not the scene
  ([cameraNav.ts:182-217](../src/core/workspace/cameraNav.ts#L182)).

### The bug

`findNavTarget()` ([cameraNav.ts:168-175](../src/core/workspace/cameraNav.ts#L168))
returns `{kind:'scene'}` for **every** mode that is not `custom1/2/3` — which
includes `front`, `back`, `left`, `right`, `top`, `bottom`.

```ts
const mode = useGuidesStore.getState().camera3dMode;
if (isCustomViewId(mode)) return sceneHasAny3D() ? { kind: 'view', viewId: mode } : null;
const nav = findCameraNav();          // ← ortho views fall through to here
return nav ? { kind: 'scene', ...nav } : null;
```

So Alt+drag orbit, Alt+drag pan and Alt+wheel dolly **while sitting in Top view**
write `orbitYaw` / `orbitPitch` / `x` / `y` / `z` to the scene's Camera layer via
`updateNodeComponentProp`. The view you are looking at does not change (it is
orthographic and ignores the scene camera), so the shot camera is re-framed
invisibly. The in-file comment at
[cameraNav.ts:143-145](../src/core/workspace/cameraNav.ts#L143) states the
assumption behind it — *"and the ortho views, where nav is meaningless"* — which
is the mistaken premise: navigation there is not meaningless, it is
mis-targeted.

Directly violates the acceptance criterion *"Orbiting in Top view moves the view
only."*

**Secondary, same area:** the six ortho views have no framing state of their
own. They share the single 2D viewport pan/zoom (`RenderView`) with every other
view, so panning in Top view also pans Active Camera view. AE gives each view
its own framing.

---

## D3 — Orthographic projection

**Verdict: expected behavior. The projection is correct.**

Ortho basis table at [project3d.ts:87-94](../packages/scene/src/utils/project3d.ts#L87),
scalar projection `projectOrtho` at :111, GPU twin `orthoCameraMatrices` at :261.
Depth axis is derived as `right × down`, so the set is self-consistent by
construction.

**Ran the brief's test.** Three layers at z = −500 / 0 / +500, all at comp centre
(400, 300), comp 800×600:

| view | layer x | layer y | verdict |
|---|---|---|---|
| active | 400 / 400 / 400 | 300 / 300 / 300 | scales 1.818 / 1.000 / 0.690 — correct perspective |
| front | 400 / 400 / 400 | 300 / 300 / 300 | correct (front is the identity for z) |
| back | 400 / 400 / 400 | 300 / 300 / 300 | X mirrored in the matrix (`a = −1`) — correct |
| **left** | **900 / 400 / −100** | 300 / 300 / 300 | **three separated positions** ✅ |
| **right** | **−100 / 400 / 900** | 300 / 300 / 300 | mirrored — correct ✅ |
| **top** | 400 / 400 / 400 | **800 / 300 / −200** | **three separated positions** ✅ |
| **bottom** | 400 / 400 / 400 | **−200 / 300 / 800** | mirrored — correct ✅ |

**Clip planes / volumes** (all logged, none singular or degenerate):

- `PERSPECTIVE_NEAR = 1`, `PERSPECTIVE_FAR = 100000`, `ORTHO_DEPTH_RANGE = ±50000`.
- Default camera for 800×600: `focalLength = 1111.04`, `position = (400, 300, −1111.04)`.
- Left-view matrices — `V = [0,0,1,0, 0,1,0,0, −1,0,0,0, 0,−300,−400,1]`,
  `P = [1,0,0,0, 0,1,0,0, 0,0,1e-5,0, 400,300,0.5,1]`. Determinant non-zero.

### The part that looks like a bug and is not

For an un-rotated layer in Left view the projected 2×3 affine is
`[0, 0, 0, 1, x, y]` — `scaleX = 0`, determinant zero. The quad has zero area, so
the GPU draws **nothing**, not even a hairline.

That is geometrically correct: a Classic-3D layer is a plane of zero thickness,
and a plane seen exactly edge-on has no projected area. AE renders the same
thing — what makes AE's Left view read as a 3D scene is the *overlay* drawn on
top of it, not the layer fill. So this is expected behavior for the fill; the
missing hairline and bounding-box wireframe are a **D7/Phase-2 gap**, not a
projection defect.

The acceptance criterion *"three layers at z = −500/0/+500 show as three
separated lines in Top view"* is already met positionally (y = 800/300/−200) —
but nothing is currently *drawn* at those three positions, because each line has
zero height.

---

## D4 — Culling and clipping

### D4a Backface culling — not applicable

No `cullFace`, `CullMode`, or equivalent anywhere in `packages/renderer/src`.
The only raster state configured is `depthTest` / `depthWrite`
([WebGL2Backend.ts:291](../packages/renderer/src/gpu/backends/WebGL2Backend.ts#L291),
[gpu/types.ts:126](../packages/renderer/src/gpu/types.ts#L126)). Both faces of a
layer render. Matches AE. Not the cause.

### D4b Near / far clip planes — real bug (minor, but visually severe when hit)

`projectPoint` ([project3d.ts:161](../packages/scene/src/utils/project3d.ts#L161)
and :171) **clamps** camera-space z to `NEAR = 1` instead of rejecting the point:

```ts
const clamped = dist < NEAR ? NEAR : dist;
const scale = cam.focalLength / clamped;
```

A layer behind the camera therefore does not disappear — it inflates without
bound. Measured with the default camera (eye at z = −1111):

| layer z | camera-space depth | resulting scaleX |
|---|---|---|
| −1000 | 111.0 | 10.0× |
| −2000 | **1 (clamped)** | **1111×** |
| −100000 | **1 (clamped)** | **1111×** |
| 0 | 1111.0 | 1.000 |
| 50000 | 51111.0 | 0.022 |

At 1111× a single layer covers the entire frame as an opaque smear. Correct
behavior is to drop the layer once it crosses the near plane.

This is the issue the AI recipe layer already works around in prose —
[recipes.ts:514-518](../src/core/ai/recipes.ts#L514) explicitly refuses to use a
real 3D camera dolly because *"dollying in this engine CULLS 3D content it
pushes past its frustum"*. The observed failure is inflation rather than
culling, but it is the same near-plane handling.

Far plane: camera-space depth beyond `PERSPECTIVE_FAR = 100000` gives z-NDC > 1
and is depth-clipped on the GPU. Reachable only at extreme z (layer z ≳ 98 900
with the default camera). Low priority.

### D4c Frustum culling against the wrong matrix — not applicable

There is no frustum-culling stage at all. Nothing can be culled against the
wrong matrix. `camera3d` matrices are derived from the *same* resolved camera or
ortho view the affine path used ([buildSnapshot.ts:1928-1935](../src/core/rendering/buildSnapshot.ts#L1928)),
so the two paths cannot disagree.

### D4d Comp-frame clipping — expected behavior, no clipping to remove

Render targets are declared at **viewport pixel size**, not comp size
([rendergraph/passes/index.ts:50-53](../packages/renderer/src/rendergraph/passes/index.ts#L50)),
and `BackgroundPass` fills only the comp rect
([BackgroundPass.ts:21](../packages/renderer/src/rendergraph/passes/BackgroundPass.ts#L21)).
Geometry outside the composition frame already draws onto the surrounding
pasteboard — the Extended-Viewer *capability* is effectively present.

What is missing is (a) an explicit comp-frame boundary outline to orient
against, and (b) anything worth looking at out there — which is D7. Note that
in the acceptance test above, Left view puts two of the three layers at x = 900
and x = −100, i.e. **outside** an 800-wide comp frame, so extended viewing is
load-bearing for that test.

---

## D5 — Billboarding

**Verdict: not applicable. No global billboard.**

The layer quad is built from the layer's own composed matrix — `affineAt`
([buildSnapshot.ts:902-928](../src/core/rendering/buildSnapshot.ts#L902)) calls
`Matrix4Math.compose({position, rotation, scale, anchor})` and projects three
model-space points through it. The view matrix never enters quad construction.
Confirmed empirically: `rotationY: 60` foreshortens horizontally only, and Back
view flips the X basis to −1 — neither would happen under billboarding.

**Gap (not a bug):** AE's opt-in `Auto-Orient > Toward Camera` /
`Toward Point of Interest` does not exist. The only auto-orient is motion-path
heading ([autoOrient.ts](../src/core/scene/autoOrient.ts)), and it is explicitly
skipped for 3D layers — `if (!is3D && readNodeAutoOrient(node))`
([buildSnapshot.ts:892](../src/core/rendering/buildSnapshot.ts#L892)). So a 3D
layer cannot auto-orient at all today.

---

## D6 — Do the six views actually differ?

**Verdict: expected behavior. Yes, all six differ.**

See the D3 table. Front and Back share screen positions but differ in the
matrix X basis (`a = +1` vs `a = −1`, i.e. mirrored). Left/Right and Top/Bottom
are each other's mirrors and differ from Front on the axis that carries z.
Painter depth also differs per view (Front: ±500, Left: the X spread). The view
matrices are being applied. This branch is eliminated.

---

## D7 — Reference geometry inventory

**Verdict: real bug, and the single largest contributor to the reported symptom.**

| Element | Status | Where |
|---|---|---|
| Ground plane grid | **Exists — but selection-gated** | [Gizmo3dOverlay.tsx:79-109](../src/layout/Workspace/Gizmo3dOverlay.tsx#L79) |
| Three-axis arrows (R/G/B, local·world·view) | Exists — selection-gated | Gizmo3dOverlay.tsx:273-314 |
| Rotation rings / plane quads / scale cubes | Exists — selection-gated | Gizmo3dOverlay.tsx:228-270 |
| Corner axis-orientation widget | Exists, always on | [AxisWidgetOverlay.tsx](../src/layout/Workspace/AxisWidgetOverlay.tsx) |
| Dimensional drag guides (trajectory, drop lines, badge) | Exists, drag-only | Gizmo3dOverlay.tsx:112-195 |
| Per-layer bounding box | Partial — selected layers only, and collapses edge-on | [ports.ts:180-190](../src/core/workspace/ports.ts#L180), [useWorkspace.ts:1556](../src/layout/Workspace/useWorkspace.ts#L1556) |
| **Camera wireframe body** | **Missing entirely** | — |
| **Camera frustum cone** | **Missing entirely** | no `frustum` symbol exists in the repo |
| **Camera POI crosshair + connecting line** | **Missing** (props exist, nothing draws them) | — |
| **Light gizmos** (icon, point radius sphere, spot cone, parallel arrows, POI line) | **Missing entirely** | — |
| **Comp-frame boundary outline** | Missing (only implied by the background fill) | — |

### The three findings that matter

**1. The ground plane only exists while a 3D layer is selected.**
`Gizmo3dOverlay` is mounted behind `gizmo3dProps.is3D && gizmo3dProps.singleId`
([Workspace.tsx:337](../src/layout/Workspace/Workspace.tsx#L337)), and `is3D` is
`selected3DNodes.length > 0` ([useGizmo3d.ts:89](../src/layout/Workspace/useGizmo3d.ts#L89)).
The grid renders inside that overlay. So switching to Left view with nothing
selected gives a completely blank field — even though `groundGridVisible`
defaults to `true` and the menu shows it as on. The grid is the cheapest single
thing that would make a side view legible, and it is invisible exactly when it
is needed most.

**2. Camera layers draw nothing, in any view.**
`kind === 'camera'` is `continue`d out of the render walk
([buildSnapshot.ts:679](../src/core/rendering/buildSnapshot.ts#L679)) and has no
viewport overlay. A camera is completely invisible — no body, no frustum, no
POI. There is therefore no way to see where the camera is relative to the layers,
which is the entire reason to look at a scene from the side. This is the missing
piece the brief calls *"the single most useful piece of 3D reference geometry."*

**3. Light layers draw a screen-space wash that ignores the view.**
[buildSnapshot.ts:714-732](../src/core/rendering/buildSnapshot.ts#L714) emits a
full-comp glow quad at `w.x, w.y` — the layer's 2D world transform. It is not
projected through `project()`, so it ignores z and ignores `camera3dMode`
entirely: switch to Left view and every layer moves while the light glow stays
nailed to its comp x/y. There is no gizmo, no radius sphere, and no spot cone —
and because spot direction is stored as a 2D `lightAngle` (degrees in the comp
plane, [light.ts:24](../src/core/scene/light.ts#L24)), a spot light cannot be
aimed in 3D at all, so there is no 3D cone to draw yet.

---

## Adjacent findings (outside D1–D7, relevant to Phases 2–4)

### The 2D/3D interaction rule is already implemented, and matches AE

[buildSnapshot.ts:1870-1917](../src/core/rendering/buildSnapshot.ts#L1870):
2D layers, adjustment layers and matte pairs are marked `locked` and act as
barriers; contiguous runs of 3D layers between them are depth-sorted
independently. The in-file comment records *why* — sorting 2D layers by
projected depth made them reorder among themselves as the camera orbited. Tests
cover it (`buildSnapshotZSort.test.ts`). **No decision needed; it already
replicates AE.** Worth documenting user-facing.

One caveat to check during Phase 1: the barrier is enforced in the *painter
sort*, but the GPU path also depth-tests. Two 3D layers separated by a 2D
barrier could still intersect via the depth buffer, which the painter order
alone would have prevented.

### Camera property model (Phase 4)

Present: `focalLength` (with FOV presets), `poiX/Y/Z` two-node with a one-node
toggle, `orbitYaw`/`orbitPitch`, `dofStrength` / `focusDistance` / `dofAperture`
([CameraSection.tsx](../src/layout/Inspector/CameraSection.tsx)).

Missing: Zoom and Angle of View as two linked views of one value (only raw
`focalLength` px is exposed); Film Size; camera roll (no `orientationZ` on
cameras — `Camera3D.orientation` is `{yaw, pitch}` only); Auto-Orient mode
selector.

### Light property model (Phase 4)

Present: `type` (point/ambient/spot/parallel), colour, `intensity`, `radius`,
`lightAngle`, `lightCone`, `castShadows` ([light.ts](../src/core/scene/light.ts)).

Missing: POI for spot/parallel (so neither can be aimed in 3D); cone feather;
falloff mode (None / Smooth / Inverse Square Clamped); falloff distance; shadow
darkness; shadow diffusion.

### Material Options (Phase 4)

Present: `castsShadows` (bool), `acceptsShadows` (bool), `acceptsLights`,
`specular` ([material.ts](../src/core/scene/material.ts)).

Missing: the `Only` tri-states on Casts Shadows and Accepts Shadows — which is
how shadow-catcher workflows are built; Light Transmission; Ambient; Diffuse;
Specular Shininess; Metal.

---

## Recommended Phase 1 order

1. **D7 ground plane ungating** — smallest change, largest perceived effect.
   Draw the grid (and comp-frame outline) whenever a 3D view is active,
   independent of selection.
2. **D2 ortho-view navigation** — give each axis view its own framing state and
   stop `findNavTarget()` from falling through to the scene camera. Correctness
   bug with silent data loss (it rewrites the shot camera).
3. **D4b near-plane rejection** — drop layers crossing the near plane instead of
   clamping. Unblocks real 3D camera dollies, which `recipes.ts` currently
   refuses to emit.
4. **D3/D7 edge-on legibility** — bounding-box wireframe for 3D layers drawn
   from the 4×4 model matrix (not the collapsed 2×3 affine), so an edge-on layer
   is a findable hairline rather than nothing.

Phase 2 (camera wireframe + frustum cone, light gizmos) is the remaining bulk
and depends on nothing above.

---

## Phase 1 — landed

Items 1–3 of the order above. Item 4 (edge-on wireframe for *unselected* layers)
moved to Phase 2, where the rest of the per-layer reference geometry lives.

### 1. Ground plane and comp frame no longer depend on the selection

`Gizmo3dOverlay` now mounts on a new `scene3d` predicate
([useGizmo3d.ts](../src/layout/Workspace/useGizmo3d.ts)) — true when the comp
holds a 3D layer or a camera, **or** when the viewport is in any non-Active
view. The transform gizmo inside it is gated separately on `showGizmo`, so it
still requires a selected 3D layer. Added the comp-frame rectangle as projected
3D geometry next to the grid: it reads as the comp rect in Front, a vertical
line edge-on from Left/Right, and a receding quad in a custom view — the
Extended-Viewer edge marker that was missing.

### 2. Ortho views navigate the view, never the scene camera

`NavTarget` gains `{ kind: 'ortho', view }`, and `findNavTarget()` returns it
for all six axis views instead of falling through to `findCameraNav()`.

- **Orbit** promotes the viewport to Custom View 1, seeded from
  `ORTHO_VIEW_ANGLES[view]` so the scene does not jump, then applies the drag.
  An axis view cannot be orbited and stay an axis view, so promotion is the
  honest outcome — and because the view label changes, it is visible rather
  than silent. **Trade-off:** this overwrites `custom1`'s stored params.
- **Track** pans the 2D viewport; **dolly** zooms it (a parallel projection has
  no "closer" other than zoom).
- No scene node is written on any of the three paths, and no undo entry is
  created.

### 3. Near plane rejects instead of clamping

`Projected` gains an additive `clipped?: boolean`, set by `projectPoint` when
the point is at or behind `NEAR`. `buildSnapshot` drops those layers before
they are emitted, which also removes them from the shadow caster/receiver
lists. Overlay callers that only need a finite number are unaffected.

Note the distinction the fix draws: a layer 1px in front of the lens is
*legitimately* enormous — that is perspective. The bug was that a layer
**behind** the camera rendered at that same fixed `focalLength / NEAR` ≈ 1111×,
as though it were 1px in front. Surviving layers are now always a real
projection; only clamped ones are dropped.

Limitation: the test is on the layer's origin, so a large layer straddling the
near plane pops rather than clipping per-fragment. That is the Classic-3D
approximation this compositor makes everywhere (layers are whole quads, not
clipped geometry).

### Verification

- `npx tsc --noEmit` clean.
- Full suite: **328 suites / 3416 tests passing**, 1 suite + 18 tests skipped
  (the pre-existing jsdom-canvas skips) — up from 327 suites / 3376 tests.
- New coverage: `src/core/rendering/buildSnapshot3dViews.test.ts` (six views
  differ; 2D layers immobile in every view; 3D at z=0 matches 2D scale;
  near-plane rejection), ortho-nav cases in
  `src/core/workspace/cameraNavViews.test.ts` (including a direct regression on
  "orbit must not write `orbitYaw`/`orbitPitch` to the camera layer", and a
  check that `ORTHO_VIEW_ANGLES` really reproduce each axis direction), and
  ground-grid projection cases in `packages/workspace/src/__tests__/gizmo3d.test.ts`
  (horizon line edge-on, full grid from Top).

**Not verified live.** The dev server boots to `#/login` behind `RequireAuth`
and there is no dev bypass, so the on-screen result of the ground-plane and
comp-frame change has not been seen in a running app.

---

## Phases 2–4 — landed

The standing description of the resulting model is
[3d-layer-model.md](./3d-layer-model.md); this section records what changed.

### Phase 2 — reference geometry

`packages/workspace/src/selection/sceneGizmos.ts` builds camera, light and
layer wireframes as pure world-space segments; `src/core/workspace/sceneGizmoData.ts`
walks the live scene at the playhead and resolves each device the same way the
RENDERER does (`cameraFromNode`, `readNodeLight`, `nodeWorld3d`), so the chrome
cannot drift off the pixels. `Gizmo3dOverlay` projects them through whatever
view is active, so one description serves every view.

- **Camera**: wireframe body + lens stub, frustum cone to the focus distance
  sized by the angle of view (the far rectangle is the comp frame as the camera
  sees it — same pinhole relation `projectPoint` uses), POI crosshair + line.
  Suppressed for the camera the viewport is looking *through*, whose own cone
  would wrap the viewer and draw a full-screen X.
- **Lights**: point → wireframe sphere at the falloff radius (three great
  circles); spot → cone at the cone angle plus a fainter feather cone; parallel
  → direction ray bundle with arrowheads; ambient → icon only.
- **3D layers**: bounding box, 4 edges flat / 12 extruded. This is what keeps an
  edge-on layer findable — the box collapses to a hairline in that view too, but
  a hairline is a thing you can see and click.
- **Ground plane + comp frame**: already covered in Phase 1.

### Phase 3 — views, navigation, draft mode

The view set, the multi-view layouts and the view-vs-camera navigation rule were
already correct or fixed in Phase 1. The remaining item was **Draft 3D**, which
now forces the ground plane and the scene gizmos on (it already turned shadows,
DOF, lights and motion blur off). That pairing — cheap to render, easy to read —
is the point of the mode, so leaving the spatial aids to a separate toggle the
user has to find was the wrong split.

### Phase 4 — property models

**Camera.** Zoom ↔ Angle of View are now two editable views of one value
(`Project3D.fovForFocalLength` is the new inverse); the angle used to be
read-only text next to an editable focal length, which reads as a broken
control. Added Film Size (virtual sensor width) with the derived millimetre
focal length shown alongside. Camera roll is still not implemented — orientation
is yaw + pitch only.

**Lights.** Added Point of Interest (3D aim), Cone Feather (percent of the
half-cone, AE's model), Falloff (None / Smooth / Inverse Square Clamped),
Falloff Distance, Shadow Darkness and Shadow Diffusion — all wired through to
the renderer, all keyframeable, all defaulting to a no-op.

**Material Options.** Casts Shadows and Accepts Shadows became tri-states with
`Only`, which is how shadow-catcher workflows are built. Added Light
Transmission (tints the shadow with the caster's colour), Ambient, Diffuse and
Metal.

**Auto-Orient.** Off / Along Path / Towards Camera. The last is AE's per-layer,
opt-in billboard, and closes the D5 gap.

### Deliberate non-implementation

**Metal is stored and inspectable but does not render.** Biasing the specular
highlight toward the layer's own colour is a per-fragment term, and the
`shade3d` DTO and shader uniform block carry only specular + shininess. Adding a
field that `snapshotToFrameScene` drops on the floor would look wired and render
nothing, so the renderer comment says why it is absent and the inspector says
plainly that the value is saved but not applied.

### Behaviour changes to be aware of

Everything above defaults to a no-op, with one exception worth stating:

- **Spot cone feather.** The soft edge was a hardcoded 20% of the half-cone. It
  is now the `coneFeather` property, defaulting to AE's 50%. A light that never
  set it reads 20% (`lightShading.ts` treats `undefined` as the old value), so
  saved projects are unchanged — but a spot created from here on has AE's softer
  default edge.

### Verification

- `npx tsc --noEmit` clean.
- Full suite: **332 suites / 3486 tests passing**, 1 suite + 18 tests skipped
  (the pre-existing jsdom-canvas skips) — up from 328 / 3416 at the end of
  Phase 1.
- New coverage: `packages/workspace/src/__tests__/sceneGizmos.test.ts` (frustum
  matches the pinhole relation; camera basis is the forward rotation, not its
  inverse; cones open at the cone angle; POI aims a spot out of the comp plane;
  layer boxes stay findable edge-on), `src/core/scene/lightMaterialModel.test.ts`
  (every falloff curve; the no-op defaults; `only` still counts as ON for every
  boolean reader), and `src/core/rendering/buildSnapshot3dMaterial.test.ts`
  (Towards Camera aims the normal at the eye and does NOT billboard opted-out
  layers; `Only` hides the layer but keeps its shadow; transmission tints;
  darkness/diffusion; Zoom ↔ AOV round-trip).

**Still not verified live** — same login gate as Phase 1.

---

## Follow-up pass — the remaining gaps

Everything left on the post-Phase-4 list, except live visual verification.

### 3D parenting (the biggest one)

Two halves, both needed:

1. **Nulls could not be made 3D at all.** `THREE_D_CAPABLE_KINDS` excluded
   `null`, so the one layer type people reach for first to build a 3D rig was
   the one type that could not take the switch.
2. **Parent chains composed as 2×3 affines.** `worldTransformOf` carries
   x/y/rotation/scaleX/scaleY only, so a child inherited none of its parent's
   `z`, `rotationX` or `rotationY` — a 3D null dollying away in Z left its
   children exactly where they were.

`nodeMatrix.parentWorld3d` now walks the chain as 4×4s, returning null when no
ancestor is 3D so the ordinary 2D path stays byte-identical. When it is
non-null the layer's own transform is used LOCAL (the chain is applied by the
matrix), which is why the renderer's three `affineAt` call sites switched from
`world.*` to `own*` — an expression that reduces correctly in both cases. The
selection chrome (`ports.ts`) got the identical change, so it cannot drift.

A **2D** ancestor is flattened to 2D first (AE's rule); because its world affine
already subsumes everything above it, it REPLACES the accumulated matrix rather
than multiplying into it. Getting that backwards applies the grandparent twice —
there is a test for exactly that.

### Light glow projected through the view

`buildSnapshot`'s light branch emitted the wash at raw comp x/y, ignoring both
depth and the active view. It now projects through the same `project()` closure
everything else uses. Ambient is exempt: it has no position to project.

### Inspection panes draw the reference geometry

Extracted `useSceneRefGeometry` (resolution) and `SceneGeometryOverlay`
(rendering) out of the gizmo overlay, so the 2-up / 4-up panes and the
interactive viewport share ONE path. The panes pass no RenderView, so
`paneViewTransform` reproduces the renderer's centred contain fit — with a test
asserting it against `viewToCamera`, because a silent drift there offsets every
gizmo in every pane.

### Per-view framing

Each view now keeps its own pan/zoom (`guidesStore.viewFraming`, swapped on view
change via new `WorkspaceController.framing()` / `restoreFraming()`). Framing up
a Top view no longer re-frames the shot.

### Camera roll

`Camera3D.orientation` gains `roll`; world → camera is
Rz(−roll)·Rx(−pitch)·Ry(−yaw)·T(−eye). Applied in `projectPoint`, in
`cameraViewMatrix` (computed as a premultiply rather than a hand-expanded 3×3 —
that is where sign errors hide), inverted in `unprojectScreenRay`, and honoured
by the gizmo basis. Tested on invariants rather than matrix entries: the aim must
not change, projection and unprojection must stay exact inverses, and the GPU
4×4 must agree with the scalar path.

### Metal — now rendered

It turned out to be cheap: `shadeParams.w` was spare padding, so Metal needed no
uniform-layout change. Wired through the DTOs and applied in all four shader
variants as `spec * specI * mix(vec3(1), baseRgb, metal)`. The inspector's
"saved but not applied" note is gone, replaced by one that only appears when
Specular is 0 — Metal is invisible without a highlight.

### Corrected from the Phase 2–4 write-up

The GPU depth test does **not** cross the 2D barrier. `CompositionPass.renderList`
already partitions renderables into contiguous `depthEligible3D` runs — a 2D
layer is not depth-eligible, so it splits the run — and each run renders as its
own pass with its own `clearDepth`. The divergence documented earlier did not
exist; `3d-layer-model.md` now says so.

### Verification

- `npx tsc --noEmit` clean.
- Full suite: **340 suites / 3610 tests passing**, 1 suite + 18 tests skipped.
- Shaders validated in a real browser: all three GLSL variants carrying `metal`
  compile on a WebGL2 context, and all three WGSL twins pass
  `createShaderModule` validation on a real WebGPU device. Metal reaches
  `shadeParams.w` (0.75 in, 0.75 out).
- New coverage: `buildSnapshot3dParenting.test.ts` (depth/rotation inheritance,
  three-deep chains, the 2D-ancestor flatten, a parent cycle),
  `buildSnapshotLightProjection.test.ts` (glow follows the view; pane transform
  matches `viewToCamera`), `packages/scene/src/__tests__/cameraRoll.test.ts`.

**Live visual verification remains the one open item** — the dev server boots to
`#/login` behind `RequireAuth` and there is no dev bypass.
