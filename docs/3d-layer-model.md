# The 3D layer model — what this editor does, and where it differs from AE

Companion to [3d-diagnosis.md](./3d-diagnosis.md). That document is the audit;
this one is the standing description of the model, for anyone wondering why a
3D scene behaves the way it does.

Target: **After Effects' Classic 3D renderer**. Flat planes in 3D space, lit and
shadowed, with a working camera. Extrusion and bevels exist here as an extension
beyond Classic 3D; imported 3D models, PBR materials and HDRI environments are
explicitly out of scope (that is AE's Advanced 3D, a separate project).

---

## A 3D layer is a plane with no thickness

This is the single fact that explains most surprises.

A layer with its 3D switch on is a quad at z = 0 in its own local space. It has
no depth unless you extrude it. Consequences that are **correct behaviour, not
bugs**:

- **Seen exactly edge-on, a 3D layer draws nothing.** From the Left view a
  front-facing layer is a line of zero width; its projected area is zero, so
  there are no pixels. AE does the same thing. The viewport draws a bounding-box
  wireframe over it so it stays findable and clickable — that hairline is the
  layer, and it is all there is to see.
- **A scene where everything sits at z = 0 shows one line in Top view.** There is
  no depth to look at. Spread the layers in Z and they separate.
- **Both faces render.** There is no backface culling, so a layer rotated past
  90° shows its mirrored back, as in AE.

## The 2D/3D interaction rule — replicated, deliberately

**This editor replicates AE's behaviour.** A 2D layer between two 3D layers acts
as a wall: it holds its stacking position and splits the 3D layers around it
into separately-sorted render groups. 3D layers below it cannot sort against 3D
layers above it, whatever their Z positions. Adjustment layers and matte pairs
break the stack the same way.

Implemented in `buildSnapshot.ts`'s painter sort (search for `locked`), covered
by `buildSnapshotZSort.test.ts`.

**Why replicate it rather than "fix" it.** The rule is architecturally
necessary, not a quirk: you cannot depth-sort something that was already
composited in 2D. It also protects a subtler property — a 2D layer's position is
camera-independent, but its *projected depth* is not. When 2D layers were sorted
alongside 3D ones they reordered among themselves as the camera orbited, and
sorted by their Y position in a Top view. Their placement was always right; only
their paint order was wrong.

**The GPU path honours it too.** `CompositionPass.renderList` partitions
renderables into contiguous runs of `depthEligible3D` ones, and a 2D layer (or
matte, adjustment, or advanced-blend layer) is not depth-eligible, so it splits
the run. Each run renders as its own depth pass with its own `clearDepth`, so
two 3D layers separated by a 2D barrier cannot occlude each other through a
shared depth buffer.

## Parenting

A 3D layer inherits its parent chain as a full 4×4 transform: position, DEPTH and
3D rotation all propagate. Nulls can take the 3D switch, which is what makes a 3D
null usable as a rig.

A **2D** ancestor is flattened to 2D first (AE's rule) and contributes only its
x/y/rotation/scale — it has no depth to give. Because its world affine already
subsumes everything above it, a 2D layer mid-chain replaces the accumulated
matrix rather than multiplying into it; 3D ancestors below it still compose on
top.

A layer with no 3D ancestor takes the ordinary 2D composition path unchanged.

## Cameras

- **One-node** (position) or **two-node** (position + Point of Interest, which
  it always aims at). Adding any POI component makes a camera two-node.
- **Zoom and Angle of View are one value.** Zoom is the distance at which a layer
  renders 1:1 — a layer at z = 0 with the camera at distance = zoom renders at
  100%. That relation is what makes 2D and 3D layers agree on scale. Editing
  either field moves the other.
- **Film Size** is the virtual sensor width. It changes the millimetre focal
  length *reading* only; the actual view is set by Zoom / Angle of View.
- **Depth of Field**: Blur Level (cap), Focus Distance, Aperture (ramp slope).
- **Roll** (`orientationZ`) spins the frame about the view axis — a dutch angle —
  without re-aiming the camera. World → camera is Rz(−roll)·Rx(−pitch)·Ry(−yaw),
  so roll applies last.

### Near plane

A layer at or behind the camera's near plane is **dropped**, not drawn. The test
is on the layer's *origin*, so a large layer straddling the near plane pops
rather than clipping per-fragment — the same whole-quad approximation used
everywhere here. A layer 1px in front of the lens is legitimately enormous; that
is perspective, not a defect.

## Lights

| Type | Position | Aim | Key properties |
|---|---|---|---|
| Ambient | ignored | — | intensity, colour |
| Parallel | yes | POI or 2D angle | + shadows, darkness, diffusion |
| Spot | yes | POI or 2D angle | + cone angle, cone feather (%), falloff, radius, falloff distance |
| Point | yes | — | + falloff, radius, falloff distance |

**Aim**: with a Point of Interest a light aims in real 3D. Without one it falls
back to `angle`, a comp-plane direction that can only swing the light *within*
the comp plane — it can never point at a layer sitting at a different depth.
Adding a target is the fix, and the inspector says so.

**Falloff**: None (default — the legacy hard radius cutoff and linear ramp) /
Smooth / Inverse Square Clamped. The curves reach *past* the radius, where the
legacy ramp cut off hard.

Lights also render a screen-blended glow *wash*, which AE does not do. It IS
projected through the current view, so it tracks depth and moves with the view
like everything else. The one exception is an ambient light, which lifts the
whole frame uniformly and has no position to project — projecting it would slide
a full-frame wash off the frame.

## Material Options — per 3D layer

Casts Shadows (Off / On / **Only**), Light Transmission, Accepts Shadows
(Off / On / **Only**), Accepts Lights, Ambient, Diffuse, Specular Intensity,
Specular Shininess, Metal.

`Only` on either shadow switch keeps the layer fully present in the shadow pass
but stops it being drawn — that is how shadow-catcher setups are built: a layer
that receives a shadow onto transparency without rendering itself.

**Light Transmission** bleeds the caster's own colour into its shadow, so a
coloured or translucent layer throws a coloured shadow rather than a black hole.

**Metal** tints the specular highlight toward the layer's own colour: 0 reads as
plastic (the highlight keeps the light's colour), 1 as metal. It rides in the
spare `shadeParams.w` uniform slot, so it costs no layout change — and it is
visible only where there IS a highlight, so the inspector says to raise Specular
when Specular is 0.

## Auto-Orient

Off / Along Path / **Towards Camera**. Towards Camera is AE's per-layer, opt-in
billboard: the layer's normal is aimed at the active camera's eye, overriding its
own X/Y rotation. It is opt-in on purpose — a renderer that billboards *every*
layer is broken, because rotating the view would then change nothing and the
scene would look permanently flat-on.

A camera's "Orient Towards Point of Interest" is not a separate switch: a camera
carrying POI props always aims at them.

## Views

Active Camera, Front / Back / Left / Right / Top / Bottom (orthographic), and
Custom View 1–3 (perspective).

**Views are viewport-only.** They are not scene objects, are not keyframeable,
and are never rendered to output. Switching views does not modify any scene
camera and creates no undo entry.

**Navigation follows the view, not the camera** — except in Active Camera view,
where orbit/pan/dolly move the scene camera and are therefore keyframeable and
undoable, which is the whole point of that view.

- Custom views: orbit / track / dolly write the view's stored params.
- Orthographic views: track pans the viewport, dolly zooms it. **Orbit promotes
  the viewport to Custom View 1**, seeded from the axis angles so the scene does
  not jump — an axis view cannot be orbited and stay an axis view. The view
  label changes, so the promotion is visible. Note this overwrites Custom
  View 1's stored params.

## Viewport reference geometry

None of it affects rendered output.

- **Ground plane** at the comp's bottom edge, with a horizon line — a floor seen
  from floor level correctly collapses to a horizontal line in Front/Left/Right/Back.
- **Comp frame** as projected 3D geometry: the comp rect from the front, a
  vertical line edge-on, a receding quad from a custom view.
- **Camera**: wireframe body + frustum cone drawn to the focus distance and
  sized by the angle of view, plus the POI crosshair and connecting line. Drawn
  in every view except through that camera itself.
- **Lights**: point → wireframe sphere at the falloff radius; spot → cone at the
  cone angle with the feather edge; parallel → direction rays; ambient → icon
  only. Plus POI crosshair and line where aimed.
- **3D layers**: bounding-box wireframe (4 edges flat, 12 extruded), and the
  three-axis arrows on the selected layer.

Nothing clips to the comp frame — render targets are viewport-sized — so cameras
and lights sitting outside the frame are visible, which is what makes a side
view useful at all.

**Draft 3D** turns shadows, DOF and motion blur off and forces the spatial aids
on. Fast to preview, and easier to read while blocking out a scene.

The 2-up and 4-up inspection panes draw the same geometry, through the same
resolver (`useSceneRefGeometry`) and the same component, so a 4-up of Top /
Front / Right / Active Camera shows frustums, light cones, the ground plane and
layer boxes in every cell.
