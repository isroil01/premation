# The camera, end to end

**Audience:** an agent or engineer with no prior context who has to reason about,
drive, or extend the camera — and who may need to answer "how does this compare
to After Effects?" without opening AE.

**Last checked against source: 2026-08-10.** When this file and the code
disagree, the code decides. Every claim below names the file it came from so it
can be re-verified rather than trusted.

---

## 1. The shape of it, in one paragraph

A camera is an ordinary layer. It is a `SceneNode` of kind `camera` whose
Transform component carries a handful of extra numeric props (`focalLength`,
`orbitYaw`, `orbitPitch`, `orientationX/Y/Z`, `poiX/Y/Z`, `dofStrength`,
`focusDistance`, `dofAperture`, `filmSize`). Nothing about it is a special
object: it is keyframed by the same animation engine, parented by the same
parent chain, trimmed by the same clip bar, and inspected by the same property
rows as a shape layer. At render time `readSceneCamera` resolves the one active
camera node into a plain `Camera3D` value — an eye position, a focal length, a
principal point and an optional orientation — and `Project3D.projectPoint`
pushes every 3D-enabled layer's corners through a pinhole divide. There is no
scene graph in the GPU sense and no 3D models: "3D" here means 2D layers placed
and oriented in a 3D space, which is exactly After Effects' model.

---

## 2. Data model

### 2.1 Where the numbers live

Camera props are plain entries on the node's **Transform component**
(`src/core/scene/sceneInsert.ts` → `insertCamera`). That is the whole storage
design, and it is why every generic mechanism works on them for free:

| Prop | Unit | Meaning | AE name |
|---|---|---|---|
| `x`, `y`, `z` | comp px | Eye position. `z` is negative when pulled back from the comp plane. | Position |
| `focalLength` | comp px | Distance from eye to the plane that renders 1:1. | Zoom |
| `filmSize` | mm | Virtual sensor width. **Label only** — see §4.2. | Film Size |
| `orbitYaw` | deg | Swing about the point of interest, horizontally. | (orbit tool) |
| `orbitPitch` | deg | Swing about the point of interest, vertically. Clamped ±89. | (orbit tool) |
| `orientationX` | deg | In-place tilt (pitch offset). Rotates about the eye. | X Rotation |
| `orientationY` | deg | In-place pan (yaw offset). Rotates about the eye. | Y Rotation |
| `orientationZ` | deg | Roll — a dutch angle about the view axis. | Z Rotation |
| `poiX/Y/Z` | comp px | Point of Interest. Presence of ANY of the three makes it a two-node camera. | Point of Interest |
| `dofStrength` | px | Maximum defocus blur. 0 or absent = DOF off. | Blur Level |
| `focusDistance` | px | Distance that is sharp. | Focus Distance |
| `dofAperture` | px | Slope of the blur ramp. Defaults to `dofStrength`. | Aperture |

Nothing is stored as a matrix, a quaternion, or a nested object. Every one of
these is a scalar the keyframe engine can animate, which is the reason camera
animation needed no separate system.

### 2.2 One-node vs two-node cameras

`src/core/scene/camera3d.ts` → `cameraFromNode` branches on one test:

```
const hasPOI = poiX !== undefined || poiY !== undefined || poiZ !== undefined;
```

- **One-node (free) camera** — no POI props. Orbit swings the eye about the comp
  centre, and the optical axis stays on the comp centre. Removing the POI props
  is what "Remove target (free camera)" does in the inspector.
- **Two-node (targeted) camera** — any POI prop present. The eye orbits about
  the POI and then **always re-aims at it** via `lookAtOrientation`. Move the
  camera and it re-frames the target; keyframe the POI to lead a shot.

This mirrors AE's one-node/two-node distinction, including the detail that
converting between them is a property-level change rather than a different
layer type.

### 2.3 The camera is a layer, so it has a parent

`cameraFromNode` takes a `worldOf` injection that lifts a point from the node's
parent space into world space, and applies it to **both** the eye and the POI:

> transforming only the eye would swing the camera around a target that stayed
> pinned in comp space, which reads as the shot sliding off its subject as the
> rig moves.

This matters because the standard AE camera rig is a camera parented to a null
that is then animated or orbited. Before this existed the rig moved nothing at
all: the timeline showed the parent link, the UI let you create it, and the
render ignored it.

---

## 3. Which camera is active

`activeCameraNode` in `src/core/scene/camera3d.ts` is the single selection rule.
Every consumer goes through it — renderer, viewport chrome, gizmos, the C-key
tool. Three conditions, matching AE:

1. **Topmost, not first.** Creation order is paint order and paint order is
   back-to-front, so "the first camera found" is the *bottom-most* one. The
   function walks the composition's flattened node list in reverse.
2. **Enabled.** `node.visible === false` disqualifies it.
3. **Live now.** An `isLiveAt` filter applies the same in/out clip-bar test
   ordinary layers get, so a camera trimmed to the second half of the comp does
   not steer the first half.

It is also **scoped to `rootId`** — the active composition — because comps are
separate root subtrees and a whole-scene search let one composition's camera
steer another's render.

`readSceneDof` shares this exact function on purpose: when the two searched
independently, depth of field could be read off a different camera than the one
doing the projecting.

---

## 4. The projection

`packages/scene/src/utils/project3d.ts` is pure, framework-free, and is the only
place the maths lives. Both the CPU path (hit-testing, painter sort) and the GPU
path (4×4 matrices) are derived here so they cannot drift apart.

### 4.1 The pinhole divide

```
dist   = p.z - cam.position.z          // > 0 when in front of the camera
scale  = cam.focalLength / max(dist, NEAR)
screen = cam.principal + (p.xy - cam.position.xy) * scale
```

Conventions worth internalising:

- The camera looks **down +z** at the comp plane at `z = 0`. Comp space is
  **y-down**.
- The default camera sits at `z = -focalLength`, so a layer at `z = 0` projects
  at `scale = 1`. Moving a layer to `+z` (further) shrinks it; `-z` enlarges it.
- **`principal` must not track the camera.** An earlier version used
  `position.x/y` for both the eye and the principal point, which made the camera
  term cancel algebraically at `z = 0`: panning the camera in X/Y moved nothing
  and layers at other depths drifted the wrong way. It looked correct only
  because the default camera sits at the comp centre, where the two coincide.
- **`NEAR = 1` is a clamp, not a reject.** A clamped point is not a projection —
  a layer just behind the camera resolves to a ~1111× scale on a 1920 comp, i.e.
  one layer smeared opaque over the whole frame. `Projected.clipped` flags it;
  callers that draw geometry must drop the layer, callers that only need a
  finite number (overlays, gizmos) can ignore it.

### 4.2 Zoom, angle of view, and film size

`focalLengthForFov` and `fovForFocalLength` are exact inverses, and the
inspector edits both as **two views of one value** — editing either updates the
other. The default is 39.6° horizontal, AE's "50mm" comp-framing feel.

Film size is deliberately inert: it converts the angle of view into a millimetre
reading (`filmSize / (2·tan(fov/2))`) and changes nothing about what the camera
sees. That is what a real sensor swap does, and the inspector says so in as many
words.

Lens presets (`CameraSection.tsx`) are stored as fields of view, not millimetres,
because the millimetre number is derived: 15mm/100°, 24mm/73°, 35mm/54°,
50mm/39.6°, 80mm/25°, 135mm/15°.

### 4.3 Orientation

`world → camera` is `Rz(−roll) · Rx(−pitch) · Ry(−yaw) · T(−eye)`. Roll is
applied **last**, which is what makes it spin the frame rather than re-aim the
camera. A camera with zero orientation takes a separate, simpler code path and
renders byte-identically to the pre-orientation implementation — that is a
deliberate guarantee, not an accident, pinned by `cameraRoll.test.ts`.

**Where yaw and pitch come from is the part the matrix cannot tell you.** Three
sources compose into those two fields, in `cameraFromNode`:

1. the **base aim** — `orbitCamera`'s angles on a one-node camera, or
   `lookAtOrientation(eye, poi)` on a two-node one;
2. plus **`orientationY`** (yaw) and **`orientationX`** (pitch), the in-place
   rotation, added as offsets;
3. and `orientationZ` as roll, kept separate because it is applied last.

The offset composition is the whole design of in-place rotation: on a targeted
camera the look-at establishes the aim and these nudge it, so a camera can be
turned off its subject while still tracking. Set rather than added, the look-at
would overwrite them every frame and the controls would do nothing — the failure
mode `cameraOrientation.test.ts` was written to catch, red first.

Because only `orbitCamera` moves the eye, in-place rotation rotates about the
eye by construction, never about the POI or the comp centre.

### 4.4 Orbit

`orbitCamera(basePosition, poi, yaw, pitch)` keeps the eye's distance from the
POI, swings by yaw/pitch, and returns the orientation that keeps the POI
centred. `yaw = pitch = 0` returns the base configuration untouched.

---

## 5. Views: what you are looking through

`Camera3dMode` (`src/stores/guidesStore.ts`) has three families, and the
renderer treats them very differently:

| Mode | Projection | Reads the scene camera? | Writes to the scene? |
|---|---|---|---|
| `active` | Perspective, `projectPoint` | Yes | Yes — nav writes camera props |
| `front` `back` `left` `right` `top` `bottom` | **Orthographic**, `projectOrtho` | No | **Never** |
| `custom1` `custom2` `custom3` | Perspective, from stored view params | No | No — writes the view's params |

**The axis views are parallel projections.** `scale` is always 1, so a flat comp
appears edge-on (a line) in any side or top view and only 3D-offset layers spread
apart. That is the point of an orthographic view: true depth relationships
without perspective distortion.

**Custom views are AE parity and never touch the shot camera.** They store
`{yaw, pitch, distance, poi}` in `guidesStore` and build a projection camera from
them through the same `Project3D` helpers `camera3d.ts` uses. `distance` and
`poi` are `null` until navigated, meaning "comp-relative default" (POI = comp
centre, distance = 1.2 × default focal length), resolved at camera-build time so
one comp's dimensions never get baked into the store.

Orbiting an **axis** view promotes it to `custom1` — swinging off the axis makes
it a custom view by definition. This is fixed rather than "last used" so the
promotion is predictable and the view label visibly changes.

There is a 1 / 2 / 4-pane layout (`ViewLayout`), matching AE's 1 View / 2 Views /
4 Views. In the 2×2 layout only cell 0 is the interactive stage; cells 1–3 are
view-only inspection panes.

---

## 6. Navigation

`src/core/workspace/cameraNav.ts` is the one home for orbit / track / dolly
writes. Two input paths drive it and they share every code path below:

- **Modifier nav:** `Alt+drag` orbits, `Shift+Alt+drag` (or `Alt+middle-drag`)
  tracks XY, `Alt+wheel` dollies.
- **The C-key camera tool:** cycles orbit → pan → dolly, then plain left-drag.

| Gesture | Writes | Feel |
|---|---|---|
| Orbit | `orbitYaw += dx·0.4`, `orbitPitch += dy·0.4` (clamped ±89) | 0.4°/px on every path |
| Track XY | `x -= dx/scale`, `y -= dy/scale`, and the POI with it | Framing follows the cursor, so the camera moves opposite the drag |
| Dolly | `z -= delta·2` | Drag up / wheel up = dolly in |

Three design points that are easy to get wrong:

1. **Track moves the POI too** on a two-node camera. Without that, tracking
   would re-aim the camera instead of shifting the framing.
2. **Nav writes are keyframe-aware.** They go through `applyNodePropsKeyframed`,
   the same dual path the layer gizmo uses: always the static base prop, plus a
   keyframe when the prop is already animated or Auto-Keyframe is on. Before
   this, dragging a layer's gizmo keyframed and dragging the camera did not,
   which is not a distinction After Effects makes.
3. **One gesture is one undo entry.** All of a gesture's props go in a single
   call so orbit (yaw + pitch) and track (x + y + POI) collapse to one history
   step instead of two or four.

Wheel dollying runs through a `DollyEaser` with a rAF loop so it glides rather
than steps, and the target is re-resolved every eased frame — switching views
mid-glide keeps writing to the right place.

### 6.1 When navigation does nothing, and why that is correct

A camera only moves layers whose **3D switch is on**, in AE too. So camera
navigation requires a camera layer *and* at least one 3D content layer; cameras
and lights never count as content. `describeNavUnavailable()` exists because the
inertness being *silent* was the actual bug — a user who adds a camera to a flat
comp, picks the camera tool and drags cannot tell "this does nothing here" from
"this is broken", and reported it as the latter. The function returns the next
step as a sentence, and `CameraSection` shows a live "N of M layers are 3D"
count with a one-click **Make all 3D**.

---

## 7. Depth of field

`dofBlurPx(depth, dof)` in `camera3d.ts`:

```
defocus = |depth − focus| / max(1, focus)
blur    = min(strength, defocus · aperture)
```

`strength` is the cap (AE's Blur Level), `aperture` is the slope (AE's
Aperture), `focus` defaults to the focal length — the comp plane — so a fresh
camera keeps everything sharp. `aperture` defaults to `strength`, which
reproduces the older single-scalar ramp exactly.

**Be precise about what this is.** The blur is computed per layer from that
layer's depth and pushed through as an ordinary `blur` effect entry, which the
`CompositionPass` renders. There is no DOF code in `packages/renderer`. A layer
that spans a range of depths therefore gets **one uniform blur**, not a
gradient. Calling it "depth of field" is fair at the shot level and misleading
at the pixel level; see `docs/EDITOR_REFERENCE.md` §4.

DOF is off entirely in orthographic views (no lens), in custom views (you are
not looking through the shot camera), and under Draft 3D.

---

## 8. Comparison with After Effects

### 8.1 What matches, deliberately

| Behaviour | Here | After Effects |
|---|---|---|
| Camera is a layer with keyframeable props | Yes | Yes |
| One-node / two-node cameras | Yes, by POI presence | Yes |
| Topmost enabled live camera wins | Yes | Yes |
| Camera follows its parent chain | Yes | Yes |
| Zoom ↔ Angle of View as one value | Yes | Yes |
| Film size is a label, not a lens change | Yes | Yes |
| Orbit / Track XY / Track Z tools | Yes, C cycles them, and they are visible toolbar buttons in `SceneControls.tsx` | Yes, C cycles them |
| In-place X / Y / Z rotation (tripod pan, tilt, dutch) | Yes, `orientationX/Y/Z`, offsets onto the base aim | Yes |
| In-place rotation on a TARGETED camera without losing tracking | Yes, by offset composition (§4.3) | Yes |
| 1 / 2 / 4 view layouts | Yes | Yes |
| Six orthographic axis views | Yes | Yes |
| Custom views that never move the shot camera | Yes, three of them | Yes |
| Only 3D-enabled layers respond | Yes | Yes |
| Auto-orient "Towards Camera" | Yes (`autoOrient.ts`, 3D layers only) | Yes |
| Depth of field with focus distance + aperture | Approximated, see §7 | Real |

### 8.2 Where the models genuinely differ

- **"3D" means oriented 2D layers.** No imported meshes, no PBR materials, no
  HDRI. Extrusion exists (`extrusion.ts`) but the primitive is still a layer in
  a space. AE is the same in its classic renderer; it differs in having Cinema
  4D / Advanced 3D renderers this app has no equivalent of.
- **Depth of field is a per-layer uniform blur** (§7). AE's is a real
  circle-of-confusion applied per pixel.
- **Shadows are 2.5D projections**, not cast geometry. Shading itself is
  per-fragment: Lambert plus Blinn-Phong on the depth-tested path (`builtin.ts`,
  `fn shade3d`, driven by a world-position varying), with `quadGain` in
  `FrameScene.ts` as the documented fallback, and extrusion shaded per face. An
  earlier version of this section claimed the opposite; see `EDITOR_REFERENCE.md`
  §5 (2026-08-10) for the correction and `retiredDocClaims.test.ts` for the guard
  that now keeps it corrected.
- **Camera tracking & planar 3D solve.** Point / planar / mesh / Smooth Stabilize
  live under `src/core/tracking/`; `applyPlanarCameraSolve` keys a one-node
  camera from a tracked plane (homography decomposition — not full SfM).
  Subspace warp + rolling-shutter footholds are in `subspaceWarp.ts`.
- **Rotation is three scalars, not two groups.** AE splits a camera's rotation
  into Orientation and X/Y/Z Rotation; here `orientationX/Y/Z` are the single
  set, composing as offsets onto the base aim (§4.3). The expressible moves are
  the same — tripod pan, tilt, dutch angle, and all three on a tracking camera —
  but a project that distinguishes the two AE groups does not round-trip that
  distinction.

Canonical gap list: `docs/EDITOR_REFERENCE.md` §4.

---

## 9. Programmatic surface (for an agent driving the editor)

**Creating one.** `insertCamera({ name?, focalLength?, twoNode? })` centres the
camera on the real comp and pulls it back by its focal length so the comp plane
renders 1:1 for any chosen lens. `twoNode: true` seeds the POI at the comp
centre. The AE-style dialog is `openCameraDialog()`.

**AI tool layer.** `CAMERA_PROPS` in `src/core/ai/toolContext.ts` is the
whitelist: `focalLength`, `orbitYaw`, `orbitPitch`, `orientationX/Y/Z`,
`poiX/Y/Z`, `dofStrength`, `focusDistance`, `dofAperture`. Use `orientationY`
for a pan and `orbitYaw` for a dolly-arc — they look alike in a prompt and are
different shots. Writing one of these to a non-camera node fails
loudly with a message naming the fix, because a library-emitted camera move that
lands on a shape layer is otherwise a silent no-op. `add_camera_move` is the
high-level recipe (`push_in` / `pull_out`).

**Rules an agent must respect:**

1. A camera moves nothing until some content layer has its 3D switch on. Check
   first, or the work is invisible.
2. Set `z` relative to `focalLength`, not to an absolute number: `z =
   -focalLength` is the 1:1 plane for whatever lens is in use.
3. To animate, keyframe the props — there is no separate camera-animation API.
   `cameraFromNode` samples animated values **in preference to** the static
   props (`sample?.(id, prop) ?? staticProp`), so writing a base prop on a prop
   that already has keyframes has no visible effect. That is precisely why
   `applyNodePropsKeyframed` writes both.
4. Do not write camera props while an orthographic or custom view is active
   expecting to see the result — those views ignore the scene camera.

---

## 10. Files

| Concern | File |
|---|---|
| Resolve the active camera + DOF from the scene | `src/core/scene/camera3d.ts` |
| The projection maths, CPU and GPU forms | `packages/scene/src/utils/project3d.ts` |
| Orbit / track / dolly writes | `src/core/workspace/cameraNav.ts` |
| Custom-view params and their camera | `src/core/workspace/customViews.ts` |
| View mode + pane layout state | `src/stores/guidesStore.ts` |
| Inspector UI | `src/layout/Inspector/CameraSection.tsx` |
| Creation + defaults | `src/core/scene/sceneInsert.ts` (`insertCamera`) |
| New Camera dialog | `src/layout/Workspace/SceneInsertDialogs.tsx` |
| Consumption at render time | `src/core/rendering/buildSnapshot.ts` |
| Agent-facing prop whitelist | `src/core/ai/toolContext.ts` |
| Tests | `packages/scene/src/__tests__/project3d.test.ts`, `cameraRoll.test.ts`, `src/core/workspace/cameraNavViews.test.ts` |
