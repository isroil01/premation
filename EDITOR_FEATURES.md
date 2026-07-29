# Motion Editor — What You Can Actually Do

**Everything available on the editor page.** Written 2026-07-29 by reading the source: command
registrations, panel definitions, keyboard handlers, effect and preset registries, and the library
catalogs. Nothing here is copied from older docs, and nothing is aspirational — if a control exists but
does nothing, it is listed in §21 as dead rather than as a feature.

---

## Contents

1. [What kind of video you can make](#1-what-kind-of-video-you-can-make)
2. [The editor screen](#2-the-editor-screen)
3. [Tools](#3-tools)
4. [Layers you can create](#4-layers-you-can-create)
5. [Transform & properties](#5-transform--properties)
6. [Animation](#6-animation)
7. [The timeline](#7-the-timeline)
8. [3D, cameras and lights](#8-3d-cameras-and-lights)
9. [Effects, masks and styles](#9-effects-masks-and-styles)
10. [Text](#10-text)
11. [Shapes and paths](#11-shapes-and-paths)
12. [Rigging and puppet](#12-rigging-and-puppet)
13. [Content libraries](#13-content-libraries)
14. [Working with footage, images and audio](#14-working-with-footage-images-and-audio)
15. [The AI assistant](#15-the-ai-assistant)
16. [Preview and playback](#16-preview-and-playback)
17. [Export](#17-export)
18. [Project, history and collaboration](#18-project-history-and-collaboration)
19. [Plugins](#19-plugins)
20. [Complete keyboard reference](#20-complete-keyboard-reference)
21. [What it can't do](#21-what-it-cant-do)

---

## 1. What kind of video you can make

**In one sentence:** motion graphics — titles, logo reveals, kinetic type, product/app promos, social
ads, lower thirds, UI showreels, explainer segments — composited in 2D or true 3D, up to 8K, exported
as MP4/MOV/WebM/GIF/PNG-sequence/Lottie.

It is an **After Effects–class motion design tool**, not a video editor. You can put footage in a
composition and animate it, but see §21 before planning a talking-head edit.

### Composition presets (built in)

| Category | Presets |
|---|---|
| Social vertical | Instagram Reel/Story 1080×1920 · TikTok 1080×1920 · YouTube Shorts 1080×1920 |
| Social square/portrait | Instagram Post 1080×1080 · Instagram Portrait 1080×1350 · LinkedIn Post 1200×1200 |
| Social landscape | X/Twitter Post 1600×900 · Web Banner 1456×816 |
| YouTube | 1080p 1920×1080 · 1440p 2560×1440 · 4K 3840×2160 |
| Broadcast / large | HD 720p 1280×720 · 4K UHD 3840×2160 · **8K UHD 7680×4320** |
| Cinema | DCI 2K 2048×1080 · DCI 4K 4096×2160 · Ultrawide 2560×1080 |
| Other | Classic 4:3 1440×1080 · Presentation 1920×1080 |

Any custom width/height is also allowed.

### Frame rates

23.976 (film/NTSC pulldown) · 24 (film) · 25 (PAL) · 29.97 (NTSC) · 30 (standard digital/social) ·
50 (PAL HFR) · 60 (smooth motion/gaming) · 120 (slow-motion source) — plus custom.

### Durations

Quick picks 5s · 10s · 15s · 30s · 1m · 3m · 10m, or any custom duration. Multiple compositions live in
one project and can be nested into each other.

### Starting points

Six built-in native templates — **Gradient Hero, Lower Third, Photo Promo, Quote Card, Reel Intro,
Title Card** — plus two demo scenes loadable from the command palette (*Nova AI — SaaS Ad*,
*Complex Showcase*). Templates support MOGRT-style **exposed fields**, so a template author can publish
just the text, colour and **media slots** for someone else to fill in.

A **media slot** is a placeholder layer the author exposes with a **fit policy**. The person filling the
template drops in a clip — any aspect ratio, any source kind — and it lands correctly framed without
touching the transform tools. See §13.

---

## 2. The editor screen

### Left sidebar (tabs)

| Tab | What it holds |
|---|---|
| **Scene** | The layer tree for the active composition |
| **Assets** | Imported images, video, audio, SVG, Lottie |
| **Library** | Mograph, transitions, SFX, cursors, UI kit, Lottie components, templates |
| **AI** | The assistant chat |
| **Project** | Project-level browser (on demand) |

### Right inspector (tabs)

**Transform · Style · Rigging · Effects · Graph · Presets · Settings**, plus on-demand
**History · Render · Plugins**.

### Other chrome

Top navigation with the app menu bar, tool bar, **tool options bar** (context-sensitive per tool) and
view controls · bottom timeline · status bar with **FPS meter, info readout and audio VU meter** ·
command palette · notification host · context menus · onboarding tour.

Panels can be **moved between regions**, **closed**, and **popped out into their own OS window**
("Move panel to another region", "Close panel", popout). Layout is savable as a workspace and resettable.

### Viewport

Zoom in/out with magnification presets · pan · rulers · guides · **grid** and **proportional grid**
(with configurable columns/rows, gridline spacing, line colour, style, subdivisions) · **snapping**
(toggleable, and Snap to Grid is independent of Show Grid) · safe areas · motion paths ·
**secondary view pane** for a second angle · custom 3D views · axis widget · fullscreen ·
**presentation mode** (full-screen playback, also as a separate window).

---

## 3. Tools

| Tool | Key | What it does |
|---|---|---|
| Select | `V` | Pick and transform layers |
| Direct Selection | `Shift+V` | Pick individual path points (**not `A`** — the AE keymap preset leaves `A` to reveal-anchor-point, so `tool.direct-select` is rebound to `Shift+V` in `shortcutOverrides.ts`) |
| Hand | `H` | Pan the viewport |
| Zoom | `Z` | Zoom the viewport |
| Move | — | Move-only transform |
| Rotate | `W` | Rotate layers |
| Pan Behind (Anchor Point) | `Y` | Move the anchor point without moving the layer |
| Pen | `G` | Draw and edit bezier paths |
| Brush | — | Paint strokes (size, colour, smoothing, hardness) |
| Text | `Ctrl+T` | Create and edit text |
| Rectangle | `Q` | Draw rectangles |
| Ellipse | `Shift+Q` | Draw ellipses |
| Puppet Position Pin | `Ctrl+P` | Place deformation pins |
| Bone | `Ctrl+B` | Build a skeleton for rigging |
| Camera (Orbit/Pan/Dolly) | `C` cycles, `Esc` exits | Navigate 3D space |

---

## 4. Layers you can create

**13 layer kinds:** Group · Null · Shape · Text · Image · Video · SVG · Audio · Camera · Light ·
Adjustment · Particle · Composition (precomp).

From the Layer menu: **Text, Solid…, Camera, Light, Null Object, Adjustment Layer**, plus
**Pre-compose…** and **Rig Logo for Animation**. Media layers come from importing assets. Particle
emitters, precomps and comp instances come from the insert dialogs.

**Ordering:** Bring to Front / Bring Forward / Send Backward / Send to Back.
**Structure:** parenting (any layer to any other layer **in the same composition** — there is no
cross-composition parenting, as in After Effects), grouping, precomposing, and comp instances that
re-use one composition in many places. Binding a layer to a parent never moves it on screen.

**Per-layer switches:** visibility, lock, solo/shy (with a Global Shy toggle), 3D, motion blur,
adjustment, draft quality, **auto-orient**, label colour, blend mode, track matte, **frame blend**,
**time stretch/remap**.

**On a placed composition only** (AE's sunburst): **Collapse Transformations**. Off, the comp renders
to its own frame first and composites as one flat card, so its 3D layers cannot meet the host's camera.
On, its layers are spliced straight into the host — they meet the host's camera, depth sort and lights
as ordinary layers, and are deliberately not cropped to their own frame. It switches compositing only;
it does not re-rasterize vectors (see §21).

---

## 5. Transform & properties

Position (with **separate X/Y tracks** on demand), Scale (with lock-dimensions), Rotation, Anchor Point,
Opacity, Z depth, Rotation X/Y for 3D layers, skew, and size.

**Align & Distribute** — left/centre/right, top/middle/bottom, and equal spacing.

**Fit** — **Fit to Comp** (`Cmd/Ctrl+Alt+F`), **Fit to Comp Width**, **Fit to Comp Height**, **Fill Comp**
(crops to the frame, for full-bleed backgrounds), **Set to Native Size**, and **Centre Anchor Point in
Layer Content**. These are one-shot commands that compute a size and write it, not a stored mode — so
after running one the layer is an ordinary layer you can still drag by the handles. They read the
layer's *intrinsic* size, so a placed composition, a still and a video clip all fit by the same rule.

**Appearance/Style:** fill (solid, **linear gradient**, **radial gradient** with angle/radius/stops),
stroke (colour, width, cap: butt/round/square, join: miter/round/bevel, dash patterns, alignment
inside/centre/outside, gradient strokes), corner radius, and reusable **style presets** you can save and
re-apply.

---

## 6. Animation

**Keyframes on every animatable property.** Stopwatch a property to start; keyframes carry per-side
bezier handles, and you can also keyframe non-scalar data (path points, gradient stops, text source,
colour).

**Easing:** Easy Ease (`F9`), Easy Ease In (`Shift+F9`), Easy Ease Out (`Ctrl+Shift+F9`), Linear
interpolation, Hold interpolation, a full **curve editor** with adjustable ease-in/ease-out influence,
roving keyframes, tangent smoothing, and an **easing clipboard** to copy a curve between keyframes.

**Graph editor** (`Shift+F3` — the AE preset rebinds it from the registry's `Shift+G`) with
**value graph and speed graph** modes.

**Expressions** — a built-in expression language with an expression editor and expression controls,
per property.

**Springs** — physical spring solving as an alternative to easing.

**Keyframe assistants & utilities:** copy/paste keyframes (`Ctrl+C`/`Ctrl+V` in the timeline),
smooth motion path (`Ctrl+Alt+S`), auto-keyframe mode (records a keyframe when a property changes with
the playhead parked), reveal animated properties (`U`), reveal modified properties.

**Motion presets, ready to apply:**

- **Animation (15):** Fade In · Fade Out · Rise Up · Slide In · Pop In · Pulse · Shake · Spin ·
  Zoom Out Exit · Elastic Float · Depth Push In · Flip In 3D · Swing In 3D · 3D Twirl In · Cinematic Pan 3D
- **Behaviours (6, continuous):** Drift · Orbit · Pendulum · Auto-Scroll · Fade In+Out · **Audio Throb**
- **Scenery:** Aurora · Gradient Drift · Drifting Noise · Dissolve In · Blur Dissolve Out
- **Text (18):** see §10

**Motion blur** — per-layer and global, with shutter angle, shutter phase, sample count and an adaptive
sample limit.

---

## 7. The timeline

Clip bars per layer with **trim, split, slide and slip**; a layer can hold multiple clips after a split.

- **Split at playhead** — `Ctrl+Shift+D`
- **Trim In / Trim Out to playhead** — `Alt+[` / `Alt+]`
- **Move layer start/end to playhead** — `[` / `]`
- **Work area** in/out (`B` / `N`), clear (`Shift+B`) — and render/preview can be limited to it
- **Markers** — comp markers and per-layer markers that travel with a trimmed or slid layer;
  jump between them with `Shift+PageUp` / `Shift+PageDown`
- **Time controls per layer** — time stretch (%), reverse, freeze frame (with freeze time), and
  **frame blending** (Off / Frame Mix)
- **Time remap** — keyframe the source time of a layer or precomp for ramps, holds and reverses
- Track header column is resizable; layers and properties are filterable; keyframe detail level and
  keyframe shapes are configurable
- Marquee selection of keyframes, snapping of keyframes, and a graph editor toggle

---

## 8. 3D, cameras and lights

**Real 3D** with hardware perspective — not a 2.5D fake. Any Shape, Text, Image, Video or Null layer can
be switched to 3D, gaining Z, Rotation X and Rotation Y.

**Cameras:** focal length in comp px, angle of view, **film size**, lens presets (15mm Ultra Wide ·
24mm Wide · 35mm Reportage · 50mm Standard · 80mm Portrait · 135mm Tele), orbit yaw/pitch, roll,
point of interest, and **depth of field** (focus distance, aperture, blur strength). A "Make all 3D"
helper switches every 3D-capable layer in the *active* composition.

**Lights:** type, colour, intensity, cone angle for spots, falloff (including Inverse Square Clamped),
shadows — with per-layer **Casts Shadows** and **Accepts Lights** switches, plus shininess and
per-fragment shading.

**Parenting a camera or a light** works exactly like parenting any other layer, which is what makes the
standard null-object rig possible: parent a camera to a Null, animate the Null, and the shot follows.
Binding a camera or light to a parent never moves it on screen — its values are simply reinterpreted in
the parent's space from that point on.

**Which camera you look through:** the **topmost enabled** Camera layer whose in/out range covers the
current frame. Hide it, trim it away, or put another camera above it and the next one down takes over.
A camera belongs to its own composition and has no effect on any other.

**Point of Interest follows the parent.** A camera's (and a spot light's) Point of Interest is a
parent-space property, just like its Position — so the whole rig travels together and a shot holds its
subject as the Null moves. It is *not* world-locked: if you want a camera to keep staring at a fixed
point in the composition while its rig moves, put an expression on the Point of Interest. This is the
one convention you cannot infer from the UI, and the two behaviours look very different once a rig
starts moving.

**Camera tools only move 3D layers.** In the Active Camera view the camera tools (orbit / track /
dolly) write to the camera layer itself, and keyframe it when Auto-Keyframe is on. In an orthographic
or custom view they move *the view only* and leave every scene node untouched. A composition with no 3D
layer has nothing for a camera to move, so the tools say so rather than doing nothing silently.

**Cameras and lights can also be dragged directly.** In an orthographic or custom view each one shows a
grab dot at its position, and a second dot on its Point of Interest when it has one — drag either
independently to move the device or re-aim it. Drags honour Auto-Keyframe and land as a single undo
step, and a device on a parent rig stays under the cursor rather than snapping back. The camera you are
currently looking *through* has no handle: its wireframe is hidden in its own view, and there is no
meaningful way to drag the eye you are seeing from. Switch to a Left or Top view to move it, as in
After Effects. Spot lights get the same pair; an ambient light gets none, having no position that
changes anything.

**Also:** extrusion with bevel depth, per-face materials, face picking/selection, per-character 3D for
text, 3D view presets (`1` active camera, `2` last custom view), and a 3D gizmo overlay. In the
orthographic and custom views the composition frame is drawn as a dashed outline over the plain
viewport background — the solid backdrop is only painted in the camera view, because a flat fill can't
be shown edge-on the way the frame itself is.

---

## 9. Effects, masks and styles

### Effects (38 in the registry)

| Group | Effects |
|---|---|
| Blur & sharpen | blur · directional-blur · sharpen |
| Quick colour (menu: Effect ▸ …) | brightness · contrast · saturate · grayscale · sepia · hue-rotate · invert |
| Colour | levels · curves · hue-saturation · tint · channel-mixer · posterize |
| Keying | **keylight** (chroma key / green screen) |
| Generate | glow · beam · fill · stroke · gradient-ramp · four-color-gradient · fractal-noise · noise · linear-wipe · motion-tile |
| Distort | wave-warp · turbulent-displace · displacement-map · transform |
| Time | echo · posterize-time |
| Stylize | drop-shadow · inner-shadow · inner-glow · bevel · satin |

Effects stack per layer, are individually enable/disable-able, are keyframable, can be copied between
layers, and are reorderable. Adjustment layers apply an effect stack to everything beneath.

### Masks

Bezier masks with **animated shapes**, feather, opacity, expansion, inversion and mask modes.

### Track mattes

Alpha and luma mattes with a selectable matte source layer.

### Blend modes

Full layer blend-mode list, per layer.

### Layer styles (Photoshop-style, 9)

Drop Shadow · Inner Shadow · Outer Glow · Inner Glow · Bevel & Emboss (angle, altitude, depth, size,
direction, highlight/shadow colour + opacity) · Satin · Colour Overlay · Gradient Overlay · Stroke —
all with a **Use Global Light** option and a global light angle.

### Glass / material treatment

A dedicated glass system: blur, refraction, chromatic aberration, grain, saturation, tint + tint
opacity, edge width, rim (colour, opacity, width, angle), specular (intensity, angle, falloff).

---

## 10. Text

Rich text with font family (searchable font picker), size, weight, italic, tracking, leading, alignment
(left/centre/right/justify), fill and stroke, and per-character control.

**Text on a path**, **per-character 3D**, and **auto-animate typing**.

**Text animators** with selectors (range, expression selector) — the AE model: add an animator, add a
selector, animate any property through it.

**18 text presets:** Typewriter · Type Out · Cascade · Wave · Word Rise · Scatter In · Converge Out ·
Decode · Dissolve Out · Fall Away · Flicker · Focus Pull · Inch Worm · Jitter · Spotlight · Spring In ·
Sway · Colour Sweep.

Also: convert audio to keyframes for audio-driven text, and source-text keyframes.

---

## 11. Shapes and paths

Rectangle, ellipse, polygon, star, line, and free bezier paths drawn with the pen tool.

- **Path operations / merge paths:** Union · Subtract · Intersect · Exclude (XOR)
- **Trim paths** — start, end, offset, keyframable (the standard "line draws itself" animation)
- **Repeater** — copies with offset transform
- **Shape effects** stack
- **Path morphing** between shapes
- Editable SVG: **Convert to Editable Shapes** (with an option to keep the original SVG layer so it can
  be reverted)

---

## 12. Rigging and puppet

A real character/logo rig, not just parenting:

- **Bones** — build a skeleton, set bone length, FK posing
- **Inverse Kinematics** — FABRIK solver
- **Skinning** — linear blend skinning with automatic weighting, adjustable mesh density and expansion,
  and **weight painting**
- **Puppet pins** — position pins with an ARAP (as-rigid-as-possible) deform solver, mesh mode and
  rotation refinement settings
- **Rig Logo for Animation** — a one-command setup that rigs a logo layer

Works on Shape, Text, Image and Video layers.

---

## 13. Content libraries

Drop-in content, all editable after insertion:

| Library | Count | Examples |
|---|---|---|
| **Mograph** | 24 | Slam Title · Glitch Title · Split Duo · Word Swap · Tracking Reveal · Number Counter · Progress Bar · Loader Ring · Orbit Spinner · Particle Burst · Ripple Rings · News Ticker · Neon Flicker · Glass Panel · Grid Reveal · Stacked Blocks · Focus Frame · Marker Pin · Handle Bar · Corner Tab · Badge Float · Chat Pop · Arrow Point · Minimal Line |
| **Transitions** | 20 | Cross Fade · Dip to Black · Luma Flash · Blur Through · Glitch Cut · Iris Circle · Venetian Bars · Whip Pan · Whip Vertical · Spin Whip · Zoom Through · Scale Bounce · Wipe (Up/Down/Left/Right) · Slide (Up/Down/Left/Right) |
| **SFX** | 12 | Fast/Heavy Whoosh · Cinematic Boom · Sub Drop · Riser · Hit Impact · Thud · UI Click · Button Pop · Toggle Switch · Room Tone · Rain Noise |
| **Cursors** | 24 | macOS/Windows arrows · Pointer · Grab/Grabbing · Text I-Beam · Crosshair · Pen Nib · Eyedropper · Resize (4 directions) · Zoom In/Out · Not Allowed · Busy Spinner · Click Ripple · Double Burst · Glow Trail · Spotlight Follow |
| **UI Kit** | 15 | Pro Phone Mockup · Pro Browser Window · Glass Command Bar · Glass Music Player · Glass Credit Card · Glass Input Field · Glass Toast · Glowing Action Button · Glowing Analytics Card · Modern Toggle · Gradient Hero Banner · User Profile Card · Audio Waveform Card · Action Icon Pill |
| **Lottie components** | 8 | Pill Stepper · Dynamic Island · Fluid Switch · Glass Action Pill · Face ID Scan · Volume Slider Pill · Notification Toast · Liquid Toggle |
| **Templates** | 6 | Gradient Hero · Lower Third · Photo Promo · Quote Card · Reel Intro · Title Card |

Cursor + UI-kit + mograph together are aimed squarely at **app/product demo videos**.

*Counts above are the actual catalog lengths (`MOGRAPH_ITEMS`, `TRANSITION_ITEMS`, `SFX_ITEMS`,
`CURSOR_ITEMS`, `UI_COMPONENTS`, `LOTTIE_ITEMS`). They were previously overstated by one to two in
every row, and the Lottie library was listed as "~40" when it holds 8.*

### Template media slots

Expose a placeholder layer as a **media slot** and the person filling the template just drops a source
in. Slots take **video, stills, image sequences and whole compositions** — the fit resolves against the
source's intrinsic size, so it never has to know which kind it got.

| Fit policy | What the filler gets |
|---|---|
| **Contain** (default) | The whole source visible, letterboxed inside the slot. Nothing is cropped away without the author asking for it. |
| **Cover** | Fills the slot, overflow cropped, centred. The crop happens in texture space, so a covered source can never spill outside the slot into the rest of the composition. |
| **Native** | The source at its own pixel size. For slots that mark a position rather than a frame. |

There is no Stretch: contain, cover and native cover the real cases, and an author who genuinely wants
distortion can pick native and scale the layer.

**The slot's frame is the placeholder's own box**, not the composition — so a phone screen inside a
device mockup, or a card in a grid, frames against itself. The authored box is captured when the slot
is created, so **re-filling reframes from the original rect** rather than nesting each fill inside the
last.

**A slot in an animated template still animates as authored.** Filling writes only the layer's size (and
a texture crop for cover); position, scale and rotation are never touched, so the author's keyframes
survive intact and the fitted content rides along inside them.

An **unfilled slot renders exactly as the author designed it** — in the editor and on export. An
unfilled template exports looking unfinished, not broken.

**Filling a slot fills every placement of that template.** A template is a composition, so the way to
deliver one piece of content to several platforms is to instance it into a 16:9, a 9:16 and a 1:1 host
composition. Slots belong to the template, so filling one once puts the clip in all three, each framed
against its own slot rect — nothing has to be kept in sync by hand. The case this deliberately does not
serve is three *different* clips in three placements of the same template; see §21.

---

## 14. Working with footage, images and audio

### Import

Images, video, audio, **SVG** (sanitised; hybrid import keeps static SVG as one intact layer and
converts animated SVG to keyframes), **Lottie/bodymovin JSON**, and **numbered image sequences**
(auto-detected and played as one footage layer). Assets are content-addressed into the project bundle.

**On desktop, video and audio are probed on import** for facts the browser cannot report: the real
source frame rate, the container's pixel aspect, and whether there is an audio stream at all. The rate
is what frame blending brackets on, and the stream inventory is why a clip's audio controls appear
immediately rather than after a decode eventually fails.

The probe needs `ffprobe`/`ffmpeg` on `PATH` (or `FFMPEG_PATH`/`FFPROBE_PATH`), so it is best-effort
even on desktop, and absent in the browser build. **Import never fails or is skipped when it does not
run** — you get size and duration from the media element exactly as before, the frame rate reads as
unknown, and frame blending falls back to the composition's rate. Conform can be set by hand in either
case.

### Video layers

Position/scale/rotate/opacity like any layer, in 2D or 3D · trim, split and slip on the timeline ·
time stretch, reverse, freeze frame, time remap · **frame mix** blending for slowed footage · masks,
mattes, blend modes · the full effect stack including **keylight** chroma key · Replace Footage · the
clip's **own audio track** (below).

The Media section is deliberately short: source + Replace, Time Remap, and audio Level/Mute. There is
no Fit Mode, Crop, Speed or Start Offset control, because the Fit commands (§5), a mask and Time Remap
already do those jobs — the section used to show all four and none of them was connected to anything.

**Footage is auto-fitted on import** (contained in the frame, centred). A 4K clip dropped into a 1080
composition used to arrive at 3840×2160 — four times the frame, with only its centre visible. Native
size is still one command away.

### Interpret Footage

Reinterpretation is attached to the **file**, not the layer, so correcting it updates every layer using
that footage at once — you can fix a mis-tagged import after you have already cut with it.

| Setting | What it does |
|---|---|
| **Conform frame rate** | Play the source as if shot at this rate (24 → 25 for PAL, 30 → 24 for a slow-mo look). Also what frame blending brackets on. Defaults to the probed rate; only set when you deliberately override the file. |
| **Pixel aspect ratio** | Anamorphic and DV sources display at their true shape instead of stretched. Applied to width. |
| **Loop count** | How many times the source plays. Extends a clip bar past the file's own length with real frames instead of a held one. `0` loops forever. |

### Audio

Audio layers with waveform display (and display modes), **keyframable levels in dB**, gain, a VU meter,
**convert audio to keyframes** for audio-reactive animation, the **Audio Throb** behaviour, and audio
mixdown attached to video exports. Clip bars own audio timing, so splitting an audio layer gives two
independently-timed voices.

**Level is keyframable on both audio layers and video layers**, in decibels, with the same stopwatch as
any other property — so you can duck a clip under a voiceover. The curve is scheduled onto the gain
rather than assigned per frame, so it slides smoothly instead of stepping, and **preview and export
share one curve builder** so the rendered file matches what you heard. Mute is instant and not
keyframable. **Solo covers audio too**, on both layer kinds.

**The clip bar draws its waveform**, for audio and video layers alike, and it shows the *audible
window* — trim or slip the bar and the drawn shape follows, because it slices the envelope to the
clip's own source range rather than squeezing the whole file into the bar. A **speaker glyph** on the
bar shows and toggles that layer's audio mute, independently of the visibility eye (which hides the
picture).

**A video layer plays its own audio.** Import an `.mp4`/`.webm` and the file's audio track is decoded
alongside the picture and scheduled off the same clip bar — trim, split or move the bar and the sound
follows, in preview and in the exported file alike. Per-layer **Level** and **Mute** live in the Media
section; hiding the layer silences it. A file with no audio track says so instead of failing quietly.
(The `<video>` elements the renderer scrubs for frames stay muted — they are seeked, not played — so
the sound comes from a decoded buffer, which is also what makes it sample-accurate on export.)

### Particles

A particle system with emitter type, particle shape, amplitude, random seed and a simulation that is
deterministic (so scrubbing is stable).

---

## 15. The AI assistant

A chat panel in the left sidebar that **edits the document directly** — not a code generator.

- Simple instructions ("make the title fade in") go to a **direct tool loop** with **62 document tools**
  (7 read · 25 write · 13 compose · 17 craft):
  create/update/delete layers, set keyframes, easing, expressions, springs, effects, masks, precomps,
  lights, gradients, layer styles, text animators, time remap, motion blur, image generation, SVG
  import, audio analysis.
- Creative requests ("make me a product launch intro") go to a **casting pipeline** that chooses from a
  curated technique + layout library and emits real keyframes, with a deterministic fallback whenever
  the model picks something invalid.
- Options in the panel include a **look pack**, **energy**, an execution mode, and "Let the AI choose".
- **Everything a prompt does lands in one undo step.**
- **Bring your own key** (OpenAI / Anthropic / Google) or use Motion AI on credits. Keys are held
  encrypted server-side; the editor never handles them.
- Changes apply immediately to the canvas, so you watch it build.

---

## 16. Preview and playback

Space-bar transport · loop playback · reverse playback · go to start/end (`Home`/`End`) · next/previous
frame (`PageDown`/`PageUp`) · jump to next/previous **keyframe** (`K`/`J`) · jump to markers ·
scrub the playhead · seek bar · RAM-cached preview so a cached range plays at full rate ·
**presentation mode** for full-screen review · draft quality toggle for speed · GPU tier badge and
**FPS meter** in the status bar · download/save the current frame.

---

## 17. Export

**Export dialog** (format, quality, resolution) and a **Render Queue** with output modules for batching
several outputs.

| Format | Notes |
|---|---|
| **MP4** | H.264 (`libx264`) + AAC 192k — desktop |
| **MOV** | ProRes 4444, `yuva444p10le` — **keeps alpha**, PCM audio — desktop |
| **WebM** | VP9 + Opus 160k on desktop; WebCodecs in the browser |
| **GIF** | Animated GIF |
| **PNG / JPEG sequence** | Zipped image sequence |
| **PNG (single frame)** | Also via Composition ▸ Save Frame As PNG |
| **Lottie** | Shapes + transform tracks as bodymovin JSON |
| **JSON** | The editable project document |

Every frame is rendered on a deterministic clock (`frame / fps`), so exports are reproducible and match
the viewport exactly. Audio is mixed down and muxed automatically. Cloud rendering is available for
offloading long jobs.

---

## 18. Project, history and collaboration

New / Open / Save / Save As / **Increment and Save** / Close · autosave every 60 seconds with crash
recovery · recent projects · **unlimited undo/redo** with a visual History panel and snapshot states ·
**Version History** (named snapshots you can restore) · multiple compositions per project with tabs and
drill-down into precomps · **Sync Project…** to an end-to-end encrypted vault (your passphrase never
leaves the machine) · cloud project storage and thumbnails · accounts with Google/GitHub sign-in.

---

## 19. Plugins

Install third-party plugins from a signed registry or by dropping a package onto the Plugins panel.
Plugins run **sandboxed in a worker** with no DOM, no storage and no network, and must request explicit
permissions: read layers, modify layers, read animation, modify animation, control the playhead. Every
change a plugin makes is undoable. Plugins can contribute commands to the palette and menus.

---

## 20. Complete keyboard reference

### File & edit

| Action | Key |
|---|---|
| New Project | `Ctrl+N` |
| Open Project | `Ctrl+O` |
| Save | `Ctrl+S` |
| Save As | `Ctrl+Shift+S` |
| Increment and Save | `Ctrl+Alt+Shift+S` |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Cut / Copy / Paste | `Ctrl+X` / `Ctrl+C` / `Ctrl+V` |
| Select All / Deselect | `Ctrl+A` / `Esc` |
| Duplicate | `Ctrl+D` |
| Delete | `Backspace` or `Delete` |

### Layers & composition

| Action | Key |
|---|---|
| Composition Settings | `Ctrl+K` |
| New Text layer | `Ctrl+Alt+Shift+T` |
| New Solid | `Ctrl+Y` |
| New Null Object | `Ctrl+Alt+Shift+Y` |
| New Adjustment Layer | `Ctrl+Alt+Y` |
| Pre-compose | `Ctrl+Shift+C` |
| Fit to Comp | `Ctrl+Alt+F` |
| Bring to Front / Forward | `Ctrl+Shift+]` / `Ctrl+]` |
| Send Backward / to Back | `Ctrl+[` / `Ctrl+Shift+[` |

### Tools

`V` Select · `Shift+V` Direct Select · `H` Hand · `Z` Zoom · `W` Rotate · `Y` Pan Behind · `G` Pen ·
`Q` Rectangle · `Shift+Q` Ellipse · `Ctrl+T` Text · `Ctrl+P` Puppet Pin · `Ctrl+B` Bone ·
`C` Camera tool (cycles orbit/pan/dolly) · `Esc` exit camera tool

### Timeline & playback

| Action | Key |
|---|---|
| Go to start / end | `Home` / `End` |
| Next / previous frame | `PageDown` / `PageUp` |
| Next / previous keyframe | `K` / `J` |
| Next / previous marker | `Shift+PageDown` / `Shift+PageUp` |
| Split at playhead | `Ctrl+Shift+D` |
| Move layer start / end to playhead | `[` / `]` |
| Trim In / Out to playhead | `Alt+[` / `Alt+]` |
| Work area in / out | `B` / `N` |
| Clear work area | `Shift+B` |
| Copy / paste keyframes | `Ctrl+C` / `Ctrl+V` |
| Smooth motion path | `Ctrl+Alt+S` |
| Reveal animated properties | `U` |

### Animation

`F9` Easy Ease · `Shift+F9` Easy Ease In · `Ctrl+Shift+F9` Easy Ease Out · `Shift+F3` Graph Editor

### View & panels

| Action | Key |
|---|---|
| Command Palette | `Ctrl+Shift+P` |
| Switch Theme | `Ctrl+Shift+K` |
| Graph Editor | `Shift+F3` |
| Show Grid | `Ctrl+'` |
| Proportional Grid | `Alt+'` |
| Snap to Grid | `Ctrl+Shift+"` |
| Toggle Motion Paths | `Ctrl+Alt+M` |
| Render Queue | `F6` |
| Effect Controls | `F3` |
| Focus Workspace | `` ` `` |
| 3D View: Active Camera / Last Custom | `1` / `2` |

Shortcuts are **remappable** in Customize…

---

## 21. What it can't do

Stated plainly so you don't plan around something that isn't there. Every entry below was
re-confirmed against the code on 2026-07-29 — a limitation is removed the moment it stops
reproducing, and nothing is carried forward on faith.

1. **No corner pin / perspective warp.** There is no way to drag four corners onto a phone or laptop
   screen in a photo. You can approximate it by making the layer 3D and orienting it under a camera,
   but it's eyeball-matched, and there is no tracker.
2. **No continuous rasterization.** Collapse Transformations (§4) changes how a placed composition
   composites, but nothing re-rasterizes vector content at the scale it ends up drawn at. Blow a
   nested comp of shapes or text up past 100% and it magnifies its raster like a bitmap instead of
   redrawing crisp, the way After Effects' matching switch would.
3. **Premultiplied alpha fringes.** Footage whose alpha is premultiplied — ProRes 4444, most WebM/VP9
   alpha encodes — is multiplied by its own alpha a second time on the way to the screen, so soft
   edges carry a dark halo that is obvious against a light background. There is no Interpret Footage
   ▸ Alpha control yet to tell it otherwise.
4. **Speed changes mute a clip's audio.** Time stretch, reverse and time remap retime the picture by
   choosing a different source frame; audio would have to be *resampled*, which needs a pitch
   decision and a DSP pass that isn't built. Rather than let the sound drift steadily out of sync,
   the clip's audio is muted and the inspector says why. Trim the clip bar instead of changing speed
   when a shot's audio has to survive.
5. **No NLE editing model.** No ripple delete/insert, no clip-to-clip transitions on a timeline (you
   cross-fade with opacity keyframes), no speed-ramp UI (time remap covers it), no stabilization or
   motion tracking, no captions/subtitles, and every export re-encodes every frame.
6. **The camera wireframe is sized in composition pixels, not screen pixels.** It therefore shrinks as
   you zoom out, and at low zoom on a large composition the body and lens stub get small enough that
   which way the camera is pointing is hard to read. The geometry is correct and does turn with the
   camera — it is only the on-screen size that doesn't hold.
7. **Template slots have no per-instance override.** A slot belongs to the template composition, so
   filling one changes every placement of that template at once. That is what multi-format delivery
   wants, and it is the wrong shape for the other job — three product variants from one template, each
   placement holding a different clip. After Effects covers that with Master Properties, which exposes a
   precomp's essential properties per layer; there is no equivalent here. Duplicate the composition per
   variant in the meantime.
8. **A 3D layer whose origin passes behind the camera disappears completely.** That matches After
   Effects — a layer is a flat plane and there is no per-fragment near-plane clipping — but the whole
   layer pops out at once rather than being clipped progressively, and its wireframe box goes with it,
   so there is no on-screen cue that it is still in the scene just behind you.

Also worth knowing: video decoding uses standard HTML video seeking rather than a frame-exact decoder,
so scrubbing heavy 4K footage is slow and frame blending degrades when the source frame rate differs
from the composition's when neither the desktop probe nor Conform has supplied the real source rate. A
video's audio is decoded from the file as a whole rather than streamed, so the sound of a very long
clip appears a moment after the picture does.
