# Changelog

Newest first. Each entry is what a person opening the app after an update
would want to know; the engine-level detail is in `ROADMAP.md`.

## 0.8.5 — 2026-09-20

Open an After Effects project, and a plugin publishing screen that is no
longer a pop-up.

- **After Effects projects open directly.** `File ▸ Open` now takes `.aep` and
  `.aepx`: compositions, layers and their parenting, transforms with their
  keyframes and easing, masks, text with its font and tracking, and effects
  matched by name. Footage is relinked by filename where it can be found and
  clearly listed where it cannot, so a project with missing media still opens
  and tells you exactly what to point at. The import report says what came
  across and what did not — nothing is silently dropped.
- **Publishing a plugin has a real workspace.** It used to be a single modal
  with the namespace claim, every listing and the upload form stacked inside
  it. It is now a proper screen: your listings down one side, the one you are
  editing beside them with its own tabs for details, media, guide and
  changelog, a save bar that appears only when something is unsaved, and a
  withdraw dialog that offers "make it private instead" rather than making
  removal the only exit. Your signing key still never touches the app — the
  system file prompt hands it straight to the signer.
- **The cloud dashboard reads like a tool.** The clearest fix: the row you had
  selected was the hardest one to read. Selected items in the sidebar sat at
  2.80:1 contrast against 7.36:1 for everything else, so the page you were on
  was the one you could not see. Selection now reads at 4.73:1 and is pinned
  by a test in all three themes. Alongside that: the format filter is a
  segmented control instead of an operating-system dropdown that ignored the
  dark theme, the search field stopped resizing itself and shoving the control
  beside it, render rows show progress only while something is actually
  rendering and show the failure reason inline when it is not, and the empty
  Assets and Trash screens offer the action instead of describing the buttons
  above them.
- **Timeline editing in bulk.** Select a range of clips, drag a whole group as
  one bar, stagger a selection (including a zigzag), zoom anchored to the
  pointer rather than the playhead, and nudge by less than a frame.
- **Two small asks.** Once your email is confirmed the app asks, once, how you
  found it — and once you have made something it asks how it is going. Both
  are remembered on your account, so declining is honoured on every machine
  you sign in on rather than coming back after a reinstall.

## 0.8.3 — 2026-09-14

Text that reads like After Effects set it, and a batch of shape and render
fixes.

- **Real multilingual text**: full right-to-left and bidirectional layout
  (Arabic, Hebrew — mixed with Latin in one line), **vertical writing** with
  tate-chū-yoko and kinsoku line-breaking for CJK, and **true optical
  kerning**. Source-text expressions can now drive what a text layer says.
- **Time Stretch on any layer**, not just footage.
- **Rounded rectangles stay rounded** everywhere geometry is rebuilt: under
  any path operator (Trim, Zig-Zag, Repeater…), through Merge Paths booleans
  and the path cloner, and under the Knife — all of which used to square the
  corners off. Scaled layers keep circular corners, and animated radii are
  honoured throughout.
- **Projected shadows no longer paint over the layer casting them**, and the
  lamp's wash survives alongside its shadow.
- **Properties panel no longer loops**: since 0.8.1 the panel re-rendered
  itself endlessly while it was open ("Maximum update depth exceeded" in the
  console, hundreds of times), wasting CPU the whole time. Its rows in the
  inspector's ⋯ menu (keyframe lanes, Open Effect Controls) now also stay put
  instead of only appearing because of that loop.
- **Object Matte installs reliably**: the custom model install pairs the
  encoder/decoder downloads through the app itself (no more copy-pasting two
  URLs into the right folders), with resumable, verified downloads.

## 0.8.2 — 2026-09-12

Sound, brought up to the level of the rest of the app. The audio engine was
already strong; almost none of it had a front door.

- **An Audio panel that actually mixes** (Ctrl+4): a proper VU with clipping
  indicators and peak hold, and two faders that change the **selected layer's**
  level and pan — not just another meter. Units in decibels or percent, and a
  slider minimum, as After Effects has.
- **Levels you can keyframe from anywhere**: an audio layer's Level now has a
  stopwatch in the inspector like every other property. Layers made before this
  keep the exact loudness they had. **Pan** is new, and keyframeable too.
- **Fade In and Fade Out** — one click each, written as ordinary keyframes you
  can reshape afterwards, and they leave an existing duck alone.
- **Noise Gate**: pull a layer down wherever it is quieter than a threshold —
  room tone between phrases, hiss under a take.
- **Four new audio effects**, matching After Effects 26.3: **Compressor**,
  **Distortion** (six characters plus a bitcrusher), **De-esser** for taming
  harsh "s" sounds, and the Noise Gate above. Parametric EQ now has three
  bands, Tone plays five notes and white noise, Flange & Chorus has real
  multiple voices, and Reverb gained Diffusion and Brightness.
- **Audio Spectrum and Audio Waveform can follow a path** — including a
  circle, so the spectrum-ring-around-a-logo look is finally possible. Both
  also gained side options, softness, hue interpolation and an adjustable
  analysis window. *The Audio Waveform effect had never drawn anything at all;
  it does now.*
- **A speaker switch on every layer** in the timeline, beside the eye, and
  Alt-click a solo switch to solo just that layer.
- **Audio-only preview**: Numpad `.` plays the sound from the playhead in real
  time without drawing the picture, so a long composition auditions at true
  speed. Numpad `*` drops a marker while it plays — tap along to the music.
- **`L` shows a layer's audio levels, `LL` shows its waveform**, on the same
  time axis as the keyframes above them. (`L` previously did nothing.)
- **Preferences ▸ Audio**: choose which device previews play through, and trade
  latency for stability on a busy machine.

Also in this release: composition navigation and Pre-compose, the Layer
viewer, the mini-flowchart, and fixes to mask keyframe timing, motion-blur
frame rounding and projected shadows.

## 0.8.1 — 2026-09-10

Everything in 0.8.0, plus a refreshed interface:

- **Refreshed controls**: new styling for buttons, inputs, sliders, switches,
  tabs, segmented controls and accordions, on updated theme tokens (radius,
  shadows, spacing).
- **Properties panel**: search the selected layer's properties, an options
  menu and layer actions in the selection header, a 3×3 anchor-snap grid and
  a presets menu on Transform and Appearance, and the 3D switch as its own
  control. Effects now live in the Effect Controls panel, one click away.
- **Assets panel toolbar**: New Folder, add the selection to the composition
  or at the playhead, Interpret Footage, and New Composition from Footage.
- **Toolbars scroll** sideways when a panel is too narrow to show them all.
- Library, Transcript and title-bar polish.

## 0.8.0 — 2026-09-10

- **3D lighting that behaves**: adding a light no longer shows a phantom
  second light — the automatic Ambient Fill is now an even lift across the
  frame, and its icon appears only while it is selected. New 3D layers answer
  lights and shadows out of the box; a light sitting between two layers no
  longer breaks shadow-map shadows; unticking Cast Shadows turns the shadow
  map off too; 3D solids cast shadows in both shadow modes.
- **Cameras you can direct**: Camera Options and Light Options in the
  timeline (Zoom, orbit, point of interest, depth of field, intensity, cone,
  shadow dials — stopwatch any of them from there); the View menu and every
  2-up / 4-up pane list each camera by name to look through;
  **Layer ▸ Camera ▸ Distribute Layers in Z** spreads layers in depth for
  instant parallax without changing the framing; a **Camera** preset folder
  (Push In, Pull Out, Orbit Sweep, Drift Parallax, Dolly Zoom, Handheld);
  Layer ▸ New ▸ Camera… / Light… open their option dialogs
  (Ctrl+Alt+Shift+C / L); new cameras and lights are numbered.
- **Effects on 3D layers**: glows, blurs, beams, light rays and lens flares
  are no longer clipped at a 3D layer's edge; Levels, Curves, Posterize,
  Exposure, Lumetri and the colour effects reach extruded shapes, 3D
  primitives and imported glTF models; gradient-filled extrusions grade their
  walls too.
- **Nested comps in 3D**: a composition placed as a layer renders its 3D
  through its own camera and lights — real depth, lighting and shadows —
  instead of a flat projection.
- **Deep Glow**: a physically based glow with a tight core and a long 1/r²
  tail, exposure, threshold, aspect, chromatic aberration and tint.
- **Energy Beam**: a Saber-style beam along a mask path, a text outline or a
  line — reveal, taper, distortion, flicker — with twenty presets
  (Lightsaber, Neon, Electric Arc, Plasma…); Lightning follows a mask path.
- **Particles v2 and Plexus**: sphere emitters, drag, size / opacity / colour
  ramps, sub-emission, velocity streaks and sprite sheets; Plexus draws
  point-and-line networks over a point cloud, a mask path or live particles.
- **More 3D**: height displacement from an image on extrusions, primitives
  and models; a second shadow-mapped light; Cryptomatte ID mattes from EXR in
  the Track Matte picker.
- **Tracking and masks**: Write-on and Vegas follow a mask path (a tracked
  mask moves the effect with the object); draw around an object to get a mask;
  the Object Matte neural model ships with the app and works out of the box;
  one-click tracking fixes, Parent to null, and mask tracks over 64 points.
- **Motion blur** is sized from how far a layer's silhouette travels, so
  spins, scale pops and card flips no longer strobe; per-layer Shutter Phase.
- **Also**: paste SVG straight from Illustrator; the render queue picks up
  where it stopped after a relaunch; 3D text extrusion gains gradient walls and
  face picking; the AI assistant's camera move is a real 3D camera.
- **Eighteen more After Effects effects** (201 in the browser, every one a
  GPU shader with a CPU reference, except the three lookup-table colour
  effects that render free on both backends):
  - *Simulation*: **CC Particle Systems II** — a point / ellipse emitter on the
    comp clock with Explosive, Direction Axis and Fountain physics, gravity,
    resistance, birth→death size and colour, Add or Normal compositing; and
    **CC Bubbles**, keyframed like Snowfall.
  - *Generate / Perspective*: **Fractal** (Mandelbrot and Julia, smooth
    escape colouring) and **3D Glasses** (red-cyan / red-green / red-blue /
    balanced anaglyph, stereo pair, interlace).
  - *Stylize*: **CC Kernel** (3×3 convolution), **CC Block Load** (progressive
    block loading) and **CC Threshold RGB**.
  - *Keying*: **Color Difference Key** and **CC Simple Wire Removal**.
  - *Colour*: **Broadcast Colors** (NTSC / PAL legaliser), **Noise HLS**,
    **CC Color Offset** and **Cineon Converter** (log ↔ linear for DPX/EXR).
  - *Distort / Transition*: **CC Tiler**, **CC Ripple Pulse**, **CC Radial
    ScaleWipe**, **CC Glass Wipe** and **CC Image Wipe**.
- **Twenty more effect presets** in the Effects & Presets panel (forty in
  all): Particle Sparks, Fountain, Rising Bubbles, Anaglyph 3D, Mandelbrot
  Backdrop, Julia Swirl, Sharpen / Edge Detect Kernel, Broadcast Safe, Log
  Footage Linearize, Psychedelic Offset, Three-Tone Threshold, Loading Blocks,
  Ripple Splash, Glass Reveal, Radial Collapse, Tile Wall, Green Screen
  Difference Key, HLS Film Grain and Wire Removal.

## 0.7.0 — 2026-09-06

- **Effects run on the GPU**: 177 of 183 effects now render as shaders — every
  keyer, distortion, transition, blur, noise, stylize, interior layer style,
  particle generator and the auto colour corrections. Video with effects or
  motion tracks plays at full speed instead of dropping to a per-frame CPU
  bake, and a "cpu fx" row in the viewport HUD shows the six that still bake
  (Vegas, Numbers, Timecode, Audio Spectrum, Audio Waveform, Lightning).
  Noise- and particle-based effects keep their controls and density but land
  in a different random arrangement than before.
- **Camera verbs** (Layer ▸ Camera): Create Orbit Null, Set / Link Focus
  Distance to a layer or to the point of interest, and Look at Selected / All
  under View ▸ Viewport ▸ 3D View. New lights bring an Ambient Fill so the
  unlit side of a 3D object is no longer black.
- **Layer ▸ Time**: reverse, freeze frame, time-remap enable, and stretch
  commands on the selected layers.
- **Smoother 3D handling**: dragging a 3D object, camera or light no longer
  shows the gizmo moving ahead of the object; the 3D Rotation and Orientation
  rows all edit their values.
- **Puppet**: tighter outline meshes on character cut-outs, bend pins that keep
  a rigid core and let the mesh solve the transition, and pins placed on a
  posed character land where you clicked.
- **Bug batch**: tracker overlay no longer reads as broken video, Character
  panel typography (case, small caps, super/subscript, scale, baseline,
  stroke) renders, one-sided keyframe navigators on every property row,
  Library duplicates removed, Media Browser file picking, channel views
  (R / G / B / Alpha) and the frame cache now agree, Lottie trim paths and
  animated SVG first frames import correctly, Preview panel controls work.
- **UX batch** (from `docs/UX_UI_IMPROVEMENT_PLAN.md`): design tokens with a
  density tier and high-contrast theme, native menus generated from one model,
  a docked Export panel, progress toasts with a job tray, mixed-value
  multi-select editing in the inspector, camera bookmarks, snapshot / wipe
  compare, timeline auto-follow, markers, lift / extract / ripple, and a
  faster playhead clock.

## 0.6.0 — 2026-09-03

- **Dialogs that get out of the way**: Composition Settings, Keyframe Velocity,
  the Smoother, the Wiggler and Interpret Footage are now floating tool windows —
  drag them by the title, keep working behind them, and they come back where you
  left them. Enter confirms any dialog.
- **Export as a panel**: Window ▸ Export docks the export form beside the
  inspector so you can queue renders without leaving the timeline.
- **Progress you can see**: renders, cache passes, transcription and model
  downloads show a progress toast and sit in the status-bar job tray, with
  "Reveal file" when a render lands.
- **Autosave settings** (Preferences ▸ Files): interval, how many snapshots to
  keep, an optional folder, and the last autosave time in the status bar.
- **Start screen**: search, sort by recent or name, pin projects, a Templates
  row, and Open folder… on the desktop.
- **Power-user tour** (Help ▸ Power-user tour): JKL, U / UU, `;` to fit, quick
  apply with `+`, and the command palette.
- **Help everywhere**: a `?` on every panel header opens the matching section of
  the docs; error screens and failed exports link to what to try next.
- **Version compare**: in Version History, "Compare with current" wipes between
  a saved version and the live composition at the playhead.

## 2026-09-02

- Source Monitor with in/out points, JKL shuttle and Insert / Overwrite / Add to
  end / New comp from range.
- Timeline edit tools as visible modes — Selection, Razor, Slip, Slide, Roll —
  with clip-edge snapping and Fit Composition / Fit Work Area.
- Per-cut transitions, Assemble from Footage, a Scopes panel, a Transcript panel
  with text-based editing, silence removal and ducking, chapters from markers.
- One graph editor with parametric stagger, modifier stacks, audio-reactive
  drivers, bake dynamics, the Smoother and the Wiggler as real dialogs.
- 3D: image skies and reflections, the full glTF PBR map set, curved primitives,
  a material editor, Composition Settings ▸ World, 3D IK.
- A knife tool, on-canvas gradient editor, smart guides, project swatches, an
  interactive onboarding tour, and Window ▸ Workspace.

## 2026-08-30

- A headless CLI (`premation render`) over the same deterministic pipeline.
- Data-driven batch rendering from CSV; captions in and out (`.srt` / `.vtt`)
  and generated from the composition's own audio.
- Auto-reframe to another aspect ratio; the pick-whip for parenting and
  expressions; a download-on-demand Object Matte model; idle caching of the
  whole work area.

## 2026-08-18

- The frame cache is keyed on scene content and survives undo and restart.
- Output-module templates; cloner cascade, push and path modes; physics rotation.

## 2026-08-17

- A named ease-curve library, a disk tier under the frame cache, onion skinning,
  text and colour Essential Properties, cloners with effectors, 2D rigid-body
  physics.
