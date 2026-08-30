# The 3D layer model — what this editor does, and where it differs from AE

The standing description of the 3D model, for anyone wondering why a 3D scene
behaves the way it does.

Target: **After Effects' Classic 3D renderer**. Flat planes in 3D space, lit and
shadowed, with a working camera. Extrusion, bevels and a per-layer physical
(Cook-Torrance/GGX) shading model exist here as extensions beyond Classic 3D.
Imported 3D models and HDRI environments are explicitly out of scope — that is
AE's Advanced 3D, a separate project.

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
  90° shows its mirrored back, as in AE. A flat quad is also *lit* two-sided
  (`|N·L|`), so its back is not black. Extruded faces are the exception: they
  are real solid geometry, so they light one-sided (`oneSided`, clamped at 0).

## The 2D/3D interaction rule — replicated, deliberately

**This editor replicates AE's behaviour.** A 2D layer between two 3D layers acts
as a wall: it holds its stacking position and splits the 3D layers around it
into separately-sorted render groups. 3D layers below it cannot sort against 3D
layers above it, whatever their Z positions. Adjustment layers and matte pairs
break the stack the same way.

**A light is the one exception.** Its wash occludes nothing and composites
nothing — it is a screen-blended overlay — but a light has no plane to project
and therefore no matrix, so the `!l.matrix` rule used to read it as a 2D wall.
Dropping a light anywhere in the middle of the timeline broke depth sorting for
everything around it: `[near, light, far]` kept list order, so the far layer
painted *over* the near one. AE's lights do not break the 3D stack, so washes are
now lifted out of the sort and re-inserted at the slot they occupied — the
layers on either side sort against each other, and what the wash brightens is
still what the timeline stacked it over.

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
the run. Each run renders as its own depth pass with its own `clearDepth`
(`render3DGroup` re-arms that flag per call), so two 3D layers separated by a 2D
barrier cannot occlude each other through a shared depth buffer.

### What else leaves the depth-tested path

`depthEligible3D` (in `FrameScene.ts`) is the single list, and everything it
rejects falls back to the affine painter path — still correctly *placed*, but
sorted per-quad rather than intersecting per-pixel with its 3D siblings. Beyond
2D layers it rejects: mattes and matte sources, adjustment layers, precomps,
advanced blend modes, preserve-transparency, and **glass / backdrop blur**.

The last one is the surprising one: those styles sample what is composited
*beneath* the layer, which a depth pass cannot supply, so switching a 3D layer to
a glass style quietly stops it interpenetrating its neighbours. An extrusion's
faces carry `depthExempt` together for the same reason — splitting one solid
across two paths visibly comes apart.

A light wash is on this list too, and unlike the painter sort the GPU run cannot
simply step over it: `render3DGroup` draws 3D quads, and the wash has no model
matrix to draw with. So two 3D layers separated by a light paint in the right
*order* but land in separate depth passes and cannot interpenetrate.

Cast shadows used to share that limitation and no longer do — they carry a real
`world3d` now (see **Cast shadows**). The wash is the remaining case, and it is
not obviously the same call: a fixture's glow is a lens/atmospheric effect that
arguably should not be occluded at all, while a **pool** landing on a surface
arguably should. Either way it needs depth-test-without-depth-write, which an
additive quad in a depth pass does not get for free.

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

An extruded layer is tested **per slice** as well: its origin can sit safely in
front while the body sweeps through the near plane, so the origin's guard does
not cover it. Both guards exist because `projectPoint` clamps rather than
rejects, and an unguarded quad past the lens resolves to a ~1000× scale — one
layer smeared opaque across the frame.

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

The untargeted aim is **Direction plus the layer's world rotation**. Rotating a
light turns the fixture, exactly as rotating any other layer turns it, and a spot
parented to a spinning null sweeps with the rig. Summed once, in
`buildSnapshot`'s `nodeLightAimDeg`, so the glow, the per-quad shading, the
per-fragment shader and the viewport cone gizmo cannot disagree. A **targeted**
light ignores rotation outright: a POI is a real 3D aim and wins.

**Falloff**: None (default — the legacy hard radius cutoff and linear ramp) /
Smooth / Inverse Square Clamped. The curves reach *past* the radius, where the
legacy ramp cut off hard.

All of it — both branches — lives in `lightAttenuationAt`. `lightReach` is the
distance past which that is effectively zero (for Inverse Square, where it drops
below 1/256, one step of an 8-bit channel); it sizes a parallel light's landed
pool. The glow wash reads neither — see **The glow wash** below.

**Cone edge**: hard cut at the half-cone, then a **smoothstep** across a feather
band given as a percent of it. The same curve is applied in three places —
`shadeLayer` (CPU per-quad), both shader dialects (per-fragment) and
`spotConeFactor` (the wash) — because a spot whose lit pixels and whose glow
disagree at the edge is worse than either alone. It was a linear ramp, which
corners at both ends and drew two visible lines: one where the feather began, one
where it cut off.

### The glow wash

Lights also render a screen-blended glow *wash*, which AE does not do. It IS
projected through the current view, so its POSITION tracks depth and moves with
the view like everything else. Two things shape it:

- **A two-stop radial gradient at the authored radius.** The quad's half-size is
  `radius` in comp pixels, carried as `screenRadius`. It does *not* take the
  perspective scale at the light's depth: that was tried and reverted, because a
  light anywhere near the camera then flooded the whole frame with flat colour
  (a 500px radius at z = −400 became a 1667px quad on a 480×360 comp), wiping out
  its own falloff and screen-blending every other layer toward white.
- **The texture is aim-agnostic** (a spot's cone opens along +X) and the quad is
  rotated to aim it. Baking the aim in meant every degree of rotation was a cache
  miss and a full CPU re-raster of 512² pixels.

A wash whose profile follows the light's own Falloff curve — so all three modes
stop glowing where they stop lighting — is a real improvement and was attempted
here. It is not in: it changes what every light looks like, so it needs its own
re-blessed reference frames and a deliberate decision rather than riding along
with a lighting fix. `references/light-point` is the specification for the
current look.

The one exception to projection is an ambient light, which lifts the whole frame
uniformly and has no position to project — projecting it would slide a full-frame
wash off the frame. **Draft 3D drops the wash entirely**, along with the rest of
the lighting.

### Beams that land

A **targeted** spot or parallel light does not glow at its fixture: its wash is
projected onto the surface it lights, the same construction cast shadows use. The
light's axis is intersected with the nearest lights-accepting plane in front of
it, and the wash is flattened onto that plane — placed where the axis meets it,
grown by how far the beam travelled, dimmed by `lightAttenuationAt` over that
distance, and given the receiver's depth so DOF defocuses the pool with the wall
rather than with the lamp.

A cone crossing a plane is a **disc**, so a landed beam swaps the wedge for a
feathered one (`pool`) — flat across the beam, feathered at the rim by Cone
Feather. The travel distance is already in its intensity, so no falloff is
applied twice.

Deliberately narrow, and everything outside it keeps the fixture glow unchanged:

- An **untargeted** spot aims within the comp plane by construction, so it has no
  depth component to travel along. Its wedge at the fixture is already the
  correct footprint of a cone whose axis lies in the plane.
- A **point** light radiates in every direction. It has no beam to land.
- No lights-accepting plane in front of the light, or a beam that dies before it
  arrives, leaves the fixture glow alone rather than painting a pool the light
  cannot throw.

The same whole-quad approximation as everywhere else: the pool is a disc sized by
`travel × tan(half-cone)`, not the true ellipse an angled plane would cut.

### Cast shadows

Not a shadow map. Every shadow-casting non-ambient light **projects a copy of
each caster onto the nearest shadow-accepting plane behind it** — the shadow is
an ordinary render layer, built in **world space** and projected like any other
3D layer, so it depth-sorts with the scene and an object standing in front of the
wall occludes the shadow on it.

It is nudged one world unit toward the camera rather than left coplanar with the
receiver: coplanar quads z-fight on the GPU depth path and sort arbitrarily on
the painter path. A second light's shadow takes another half unit, so two
shadows on one wall cannot fight either.

What follows from the model, and is not a bug:

- A receiver must be a 3D layer whose material accepts shadows. Nothing else
  catches a shadow.
- The light has to be in *front* of the caster to throw the shadow backward onto
  something. A light behind the caster has nothing behind it to light.
- There is no self-shadowing, no shadow of a shadow, and no curved receiver — a
  shadow lands on a plane because a plane is all there is.
- Scaling about the light by a single `t` is exact for a caster parallel to the
  receiver — the same whole-quad approximation used everywhere here. A tilted
  caster gets a flattened silhouette rather than the true sheared quad.
- The shadow is always a plain dark silhouette: it does not inherit the caster's
  blend mode. Inherited, a screen-blended caster threw an invisible shadow (black
  screened is a no-op) and a multiply-blended one threw a double-dark hole.
- Cost is casters × receivers, so a dense 3D scene with several shadow-casting
  lights multiplies quickly. This is what **Draft 3D** exists to switch off.

A layer that never enters the 3D path keeps the older 2D approximation instead: a
`drop-shadow` effect offset along the first shadow light's direction.

## Material Options — per 3D layer

Casts Shadows (Off / On / **Only**), Light Transmission, Accepts Shadows
(Off / On / **Only**), Accepts Lights, Ambient, Diffuse, Shading model, Specular
Intensity, Specular Shininess *or* Roughness, Metal.

**Shading model** is per layer: *Phong* (the default and the original look) or
*Physical (PBR)* — Cook-Torrance/GGX, where **Roughness** replaces Shininess and
Metal means "reflects its own colour, no diffuse". This is the one piece of AE's
Advanced 3D material model that lives here.

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

**Draft 3D** turns shadows, DOF and motion blur off, collects no scene lights at
all (so per-quad shading, per-fragment shade data and the light glow wash all
fall away together), and forces the spatial aids on. Fast to preview, and easier
to read while blocking out a scene.

The 2-up and 4-up inspection panes draw the same geometry, through the same
resolver (`useSceneRefGeometry`) and the same component, so a 4-up of Top /
Front / Right / Active Camera shows frustums, light cones, the ground plane and
layer boxes in every cell.
