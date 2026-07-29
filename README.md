# Motion Editor

A desktop motion-graphics application. Compositions, layers, keyframes, a graph
editor, 2.5D space with cameras and lights, effects, masks and mattes, per-glyph
text animators, mesh rigging, particles, and a deterministic export pipeline —
built on a GPU render engine that runs on WebGPU or WebGL2.

It is modelled on After Effects' Classic 3D workflow: if you know AE, the tools,
the panel layout and most of the keyboard shortcuts will already be where you
expect them.

Electron + React + TypeScript. Everything renders through one engine, the same
engine that exports, so what you see in the viewport is what lands in the file.

---

## Contents

- [What it is good for](#what-it-is-good-for)
- [Status](#status)
- [Quick start](#quick-start)
- [Requirements](#requirements)
- [The interface](#the-interface)
- [Features](#features)
- [Export](#export)
- [Architecture](#architecture)
- [Project files and storage](#project-files-and-storage)
- [The optional server](#the-optional-server)
- [Plugins](#plugins)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Testing](#testing)
- [Packaging a release](#packaging-a-release)
- [Contributing](#contributing)
- [Further documentation](#further-documentation)
- [License](#license)

---

## What it is good for

**Motion design for the web and social.** Logo animations, title cards, lower
thirds, animated stickers, UI motion studies. Compose, keyframe, export MP4 for
sharing or WebM with a real alpha channel to drop straight onto a page.

**Animating vector artwork.** Import an SVG and it arrives as editable layers,
with any CSS or SMIL animation it carried converted into real keyframes you can
retime. Import a Lottie file and get its baked animation as tracks.

**Character and prop animation without a 3D pipeline.** The bone tool builds a
skeleton with forward kinematics and IK; the puppet tool deforms a mesh from
pins. Both work on ordinary 2D artwork.

**Explainers and product shots in 2.5D.** Push layers apart in Z, add a camera,
animate a move through them, light them. Classic-3D-style shading, extrusion and
bevels included.

**Templated graphics.** Build a composition once, expose the fields that should
change (text, colours, images), then fill them per output — the same idea as a
MOGRT.

**Batch rendering.** Queue several compositions and resolutions, choose an output
folder, and let them render while you keep working.

### What it is not

Not a video editor — there is no multi-track NLE, no clip-based cutting room.
Not a 3D application: imported models, PBR materials and HDRI environments are
out of scope. Not a real-time collaboration tool.

---

## Status

Version 0.1.0. Used in earnest, but pre-1.0: expect rough edges, and expect the
project file format to still move.

- ~4,000 automated tests across the app and its engine packages
- A pixel-comparison render-test harness with committed reference frames
- Typechecked under TypeScript `strict` with `noUncheckedIndexedAccess`

Known gaps are listed with each feature below rather than being left implied.

---

## Quick start

```bash
git clone <your-fork-url> motion-editor
cd motion-editor
npm install
```

Run the desktop app with hot reload:

```bash
npm run electron:dev
```

Run just the renderer in a browser (faster to iterate on UI; no native menus, no
local file access, no MP4/ProRes export):

```bash
npm run dev
```

Other scripts:

| Command | What it does |
| --- | --- |
| `npm run electron:dev` | Vite + the Electron shell, both watching |
| `npm run dev` | Renderer only, in your browser |
| `npm run build` | Typecheck and build the renderer bundle |
| `npm run electron:build` | Build the renderer + compile main/preload |
| `npm run pack` | Unpacked desktop build (fast, for testing packaging) |
| `npm run dist` | Installer for the current platform |
| `npm test` | The full Jest suite |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run render-tests` | Pixel-compare renders against reference frames |

---

## Requirements

- **Node.js 20+** and npm.
- **A GPU with WebGPU or WebGL2.** WebGPU is preferred and used when available;
  WebGL2 is the fallback. The engine steps down automatically and shows which
  tier it landed on in the viewport header. There is no software renderer — if
  both tiers fail, the app tells you instead of showing you a blank stage.
- **ffmpeg**, for MP4, WebM, GIF and ProRes export. The app looks for it in this
  order:
  1. `$FFMPEG_PATH`, if set and pointing at the executable
  2. `<app resources>/ffmpeg/ffmpeg[.exe]`, if you bundled it (see
     [Packaging](#packaging-a-release))
  3. `ffmpeg` on your `PATH`

  Without ffmpeg, PNG/JPEG sequence, still-frame, Lottie and project export still
  work, and the browser build can encode WebM using WebCodecs. Video export tells
  you plainly when ffmpeg is missing rather than failing vaguely.

---

## The interface

```
┌─────────────────────────────────────────────────────────────────┐
│ Menu bar · toolbar · tool options                               │
├──────────────┬───────────────────────────────────┬──────────────┤
│ Scene tree   │                                   │ Inspector    │
│ Assets       │            Viewport               │  Transform   │
│ Library      │                                   │  Style       │
│ AI           │                                   │  Rigging     │
│              │                                   │  Effects     │
│              │                                   │  Graph       │
│              │                                   │  Presets     │
│              │                                   │  Render      │
├──────────────┴───────────────────────────────────┴──────────────┤
│ Timeline · keyframes · graph editor · transport                 │
├─────────────────────────────────────────────────────────────────┤
│ Status bar                                                      │
└─────────────────────────────────────────────────────────────────┘
```

Panels are dockable, and any panel can be popped out into its own window (useful
on a second monitor — the pop-out stays live-synced with the editor). Workspace
layouts can be saved and switched.

`⌘/Ctrl+Shift+P` opens the command palette, which reaches every registered
command, layer and timecode.

---

## Features

### Compositions and layers

Multiple compositions per project, each with its own size, frame rate, duration
and background. A composition can be nested inside another as a **pre-comp**,
with time remapping, and a composition can be instanced more than once.

Layer types: shapes, text, images, video, audio, solids, nulls, cameras, lights,
adjustment layers, particle emitters, 3D primitives (cube, sphere, plane,
cylinder), extruded 3D text, and pre-comps.

Per layer: blend mode (all 17 of AE's), track and alpha mattes, parenting,
motion blur, quality, shy, solo, lock, label colour, and layer styles.

### Animation

Keyframes on any numeric property, with linear, ease, ease-in, ease-out, hold and
custom bezier interpolation. The **graph editor** edits value and velocity curves
directly. Keyframe assistants cover easy-ease, time-reverse, sequence-layers and
stagger.

Position keeps X and Y as independent tracks, so they can be animated and eased
separately.

**Expressions** on properties, with expression controls (slider, angle, point,
colour, checkbox, dropdown, layer) to drive them from an inspector UI.

**Motion presets** apply named animations to a layer, resolved in composition-
relative units so a preset built for 1080p behaves correctly at any size.

### Shapes and paths

Rectangle, ellipse, polygon, star, line, plus free-drawn paths with the pen,
pencil, brush (pressure-sensitive ink) and curvature tools. Boolean path merges
(union, subtract, intersect, exclude), trim paths, path operators (pucker/bloat,
twist, zig-zag), repeaters, and dashed/tapered strokes.

Fills and strokes can be solid colours or multi-stop linear/radial gradients.

### Text

Font family, weight, style, size, tracking, leading, paragraph spacing and
alignment. **Per-glyph text animators** with a real selector stack — animate
position, scale, rotation, opacity, tracking or colour across characters, words
or lines, with range and wiggly selectors. Text on a path.

### Masks, mattes and effects

Vector masks per layer with keyframeable shapes. Track mattes and alpha mattes.
Adjustment layers apply their effects to everything beneath them.

Effects include blur, glow, drop shadow, colour grading (brightness, contrast,
saturation, hue rotation, levels, curves, posterize, tint), sharpen, noise,
echo, and stylised generators. Effect parameters are keyframeable like any other
property.

### 2.5D space

Any layer can be made 3D, gaining Z position and X/Y rotation. Cameras (one- and
two-node) with focal length and depth of field; lights with colour, intensity,
cone angle and shadows; material options per layer. Extrusion and bevels for
shapes and text.

Orthographic inspection views (top, front, left, …) and multi-view layouts, with
gizmos for move, rotate, scale and a universal gizmo.

The target is AE's **Classic 3D**: flat planes in 3D space, lit and shadowed.
See [`docs/3d-layer-model.md`](docs/3d-layer-model.md) for exactly where it
matches and where it diverges.

### Rigging

The **bone tool** builds a skeleton — forward kinematics, linear blend skinning,
FABRIK inverse kinematics. The **puppet tool** deforms a triangulated mesh from
pins using an as-rigid-as-possible solver. Both are keyframeable and both run
through the same deterministic evaluation path the renderer samples.

Full reference: [`docs/BONE_AND_PUPPET_RIGGING.md`](docs/BONE_AND_PUPPET_RIGGING.md).

### Import

- **SVG** — static files arrive as one intact layer; animated files (CSS or SMIL)
  are converted into real keyframe tracks. See
  [`docs/ANIMATED_SVG_PIPELINE.md`](docs/ANIMATED_SVG_PIPELINE.md).
- **Lottie / bodymovin** — baked animation becomes tracks.
- **Images and video** — dropped onto the canvas or imported into the asset
  library. Video layers seek frame-accurately during export, and can frame-blend.
- **Image sequences** — imported as a single timed layer.
- **Audio** — waveform display on the timeline, and mixed into video exports.

### Particles

A deterministic emitter: rate, lifetime, velocity, gravity, turbulence, size and
colour over life. Deterministic means the same frame always produces the same
field, so an export is reproducible and a re-render is identical.

### Templates

Expose selected properties of a composition as named fields, then fill them per
output. Live preview cards are rendered from the actual compositions.

### AI assistance (optional)

An assistant that can build and edit scenes through a tool registry — insert
layers, set properties, create keyframes — with every change applied as one
reversible edit. It requires the companion server (see
[The optional server](#the-optional-server)); the app is fully usable without it.

### Undo, autosave and recovery

Every edit goes through a command system with a real undo/redo stack, visible in
a History panel. Autosave is debounced, and a crash leaves a recoverable snapshot
the app offers on next launch.

---

## Export

One deterministic frame loop feeds every format. Frame time is exactly
`index / fps` — never wall-clock — so two exports of the same project produce
identical frames, and a re-render after a crash resumes identical work.

### Formats

| Format | Container / codec | Alpha | Notes |
| --- | --- | --- | --- |
| MP4 | H.264, AAC audio | no | The default for sharing. Needs ffmpeg. |
| WebM | VP9, Opus audio | **yes** | Smaller than MP4, plays on the web. |
| MOV | ProRes 4444 | **yes** | Lossless, for handing to another app. Large. Needs ffmpeg. |
| GIF | GIF89a | 1-bit | Palettised across the whole animation. No audio. |
| PNG sequence | zip of PNGs | **yes** | The archival option. Audio rides along as `audio.wav`. |
| JPEG sequence | zip of JPEGs | no | Smaller frames. |
| Still frame | PNG | **yes** | The current frame, snapped to the frame grid. |
| Lottie | bodymovin JSON | — | Vector shapes and transform tracks only. |
| Project | JSON | — | The editable document, re-openable with File ▸ Open. |

### How it works

**On the desktop**, each rendered frame is written to a temp directory and ffmpeg
encodes the sequence **in a child process**. Two consequences that matter:

- The encode never competes with the editor's UI thread or its GPU context. A
  long export leaves the app usable.
- Peak memory is one frame, not the whole render. The finished file is *moved* to
  where you asked for it, so a multi-gigabyte export never passes through the
  app's memory at all.

**In the browser**, frames go to a WebCodecs `VideoEncoder` and are muxed to WebM
by a small built-in Matroska muxer. GIF and zip encoding run in a worker so the
UI keeps painting.

### Preview before you export

The export dialog renders real export frames — same snapshot builder, same
composition scoping, same 1:1 composition-to-frame fit as the encoder receives —
and lets you scrub the whole export range. If a frame contains nothing, it says
so, in the dialog, before anything is written.

### It refuses to produce an empty file

Every path asserts on a real frame count. A zero-frame encode is an error, not a
silently successful black video. The renderer also fails loudly if the GPU
backend did not initialise, rather than handing the encoder an untouched canvas.

### Render queue

Queue several compositions, formats and resolutions. Jobs run one at a time and
report true per-frame progress, elapsed time and — when something fails — the
actual reason. Choose an output folder once and the queue writes into it without
interrupting you; existing files are never overwritten. Pause aborts the frame
loop and kills the running encoder.

Output resolution is independent of composition size, so a quarter-resolution
review copy still frames the whole composition.

---

## Architecture

### Layout

```
electron/          The desktop shell: window, native menus, privileged IPC
  main.ts            Files, bundles, blobs, video encoding, SQLite index
  preload.ts         The only renderer↔main bridge (window.motionEditor)

src/
  core/            Everything that is not UI
    scene/           The scene graph: nodes, components, transforms, parenting
    animation/       Tracks, keyframes, interpolation, presets, expressions
    rendering/       Snapshot building and the render-backend port
    export/          The export pipeline (see below)
    effects/         Blend modes, masks, mattes, adjustment layers, filters
    rig/             Bones, skinning, IK, puppet mesh deformation
    commands/        Command system, undo/redo history, shortcuts
    plugins/         Sandboxed plugin host
    ai/              Assistant tool registry and pipeline
    project/         Save/load, `.motion` bundles, autosave, recovery
  layout/          Every panel and dialog, one directory per surface
  components/      Reusable UI primitives
  stores/          Zustand stores (selection, layout, composition, …)

packages/
  @motion/scene       Scene graph and math, framework-free
  @motion/animation   The animation engine
  @motion/timeline    Timeline model
  @motion/workspace   Viewport interaction: hit testing, gizmos, snapping, grid
  @motion/renderer     The GPU render engine (WebGPU + WebGL2, render graph)
  @motion/ai-tools     Provider-agnostic tool-calling
  @motion/render-tests Pixel-comparison harness and reference frames
```

### The render path

```
Scene graph + animation engine
        │  buildSnapshot(graph, animation, time, …)
        ▼
RenderSnapshot            a flat, immutable description of one frame
        │  snapshotToFrameScene()
        ▼
FrameScene                renderer-native draw list
        │  Renderer.render(viewport, scene)
        ▼
Render graph passes       clear → background → composition → selection → overlay
        │
        ▼
WebGPU or WebGL2 backend
```

`buildSnapshot` is the seam. It samples the animation engine at one time and
produces a plain data structure — which is why the viewport, the export loop, the
export preview, thumbnails and the pixel-comparison tests all render the *same
way* from the *same code*, and why "the export doesn't match the preview" is not
a class of bug that can exist here.

The engine picks its tier at startup: WebGPU if the whole
adapter → device → configure path works, otherwise WebGL2, with a delayed retry
at each rung. Failures surface as a visible error and a tier badge, never as a
blank canvas.

### The export pipeline

```
offlineRenderer.renderOffline()      fixed timestep, yields to the UI each frame
        │  one canvas per frame
        ▼
VideoSink                            where the frame goes
        ├── FfmpegSink   (desktop)   frame → temp dir → ffmpeg child process
        └── WebCodecsSink (browser)  frame → VideoEncoder → webmMuxer
```

- `src/core/export/offlineRenderer.ts` — the deterministic loop
- `src/core/export/videoSink.ts` — the two encoders behind one interface
- `src/core/export/webmMuxer.ts` — a small Matroska/WebM muxer
- `src/core/export/gifEncoder.ts` — GIF89a + LZW, for the browser path
- `src/core/export/exportPreview.ts` — export frames rendered for the dialog
- `electron/main.ts` (`registerRenderIpc`) — frame staging and ffmpeg

### Conventions

- **The scene graph is the source of truth.** A node's transform lives in its
  `Transform` component; nothing else may hold a shadow copy.
- **Every mutation is a command.** Direct writes bypass undo, and undo is the
  feature users notice being broken first.
- **Pure where it can be.** Math, interpolation, geometry, muxing and encoding
  are pure functions with unit tests; only the parts that genuinely need a canvas
  or a GPU touch one.
- **No silent degradation.** If something cannot be done, it raises an error with
  a reason the user can act on. Producing a plausible-looking wrong result is
  considered worse than failing.

---

## Project files and storage

Projects are **local first**: the desktop app owns the file, and the optional
server is a sync target rather than a requirement.

A project is a `.motion` **directory bundle**: JSON chunks for the scene,
animation and metadata, plus a content-addressed `blobs/` directory for asset
bytes. Chunks are written atomically (temp file + rename), so a crash never
leaves a half-written project. Every path is contained within the bundle root —
a chunk name cannot escape it.

A single-file `.json` export is also available (`File ▸ Export ▸ Project`) and
re-opens with `File ▸ Open`.

The desktop build keeps a SQLite index of known projects for the dashboard, and
falls back to an in-memory index if the native driver is unavailable.

---

## The optional server

The app talks to a companion NestJS server (`motion-back`, a separate repository)
for sign-in, cloud project storage and the AI assistant. It is genuinely
optional: without it you lose those three things and keep everything else,
including all export formats.

If you are running the app for the first time and only want the editor, skip the
server and the sidecar entirely — see [Packaging](#packaging-a-release), which
also explains why the current packaging config must be edited before you
distribute a build.

---

## Plugins

Plugins are packages — a `plugin.json` manifest plus an ES module — installed
from a `.zip` or a folder. Each runs in a Worker sandbox with no DOM access, and
its manifest declares the permissions it wants; the user approves them before
anything runs.

Authoring guide and the host API: [`docs/PLUGINS.md`](docs/PLUGINS.md).

---

## Keyboard shortcuts

`⌘` on macOS, `Ctrl` elsewhere. The full list lives in the command palette
(`⌘⇧P`) and the menus; shortcuts can be remapped.

### Tools

| Key | Tool |
| --- | --- |
| `V` / `⇧V` | Selection / direct selection |
| `W` | Rotation |
| `Y` | Pan behind (move anchor point) |
| `H` | Hand |
| `Z` | Zoom |
| `G` | Pen |
| `Q` / `⇧Q` | Rectangle / ellipse |
| `⌘T` | Text |
| `⌘P` | Puppet pin |
| `⌘B` | Bone |

### Project

| Shortcut | Action |
| --- | --- |
| `⌘N` | New project |
| `⌘O` | Open |
| `⌘S` / `⌘⇧S` | Save / save as |
| `⌘⌥⇧S` | Increment and save |
| `⌘K` | Composition settings |

### Editing

| Shortcut | Action |
| --- | --- |
| `⌘Z` / `⌘⇧Z` | Undo / redo |
| `⌘X` `⌘C` `⌘V` | Cut, copy, paste |
| `⌘D` | Duplicate |
| `⌘A` | Select all |
| `Delete` / `Backspace` | Delete selection |
| `⌘⇧C` | Pre-compose |
| `⌘]` / `⌘[` | Bring forward / send backward |
| `⌘⇧]` / `⌘⇧[` | Bring to front / send to back |

### New layers

| Shortcut | Action |
| --- | --- |
| `⌘⌥⇧T` | Text layer |
| `⌘Y` | Solid |
| `⌘⌥Y` | Adjustment layer |

### Animation

| Shortcut | Action |
| --- | --- |
| `F9` | Easy ease |
| `⇧F9` / `⌘⇧F9` | Easy ease in / out |
| `U` | Reveal animated properties (twice: across all layers) |
| `⇧G` | Toggle the graph editor |
| `Space` | Play / pause (hold for the temporary Hand tool) |

### Panels and view

| Shortcut | Action |
| --- | --- |
| `⌘⇧P` | Command palette |
| `F3` | Effect controls |
| `F6` | Render queue |
| `` ` `` | Focus the workspace |
| `C` | Cycle camera navigation (orbit → pan → dolly) |
| `1` / `2` | 3D view: active camera / last custom view |
| `⌘'` | Show grid |
| `⌥'` | Show proportional grid |
| `⌘⇧"` | Snap to grid |
| `⌘⌥M` | Toggle motion paths |

---

## Testing

```bash
npm test                    # everything
npm test -- src/core/export # one directory
npm run typecheck
npm run render-tests        # pixel-compare against reference frames
```

The Jest suite covers the engine packages and the app's core: scene graph and
transforms, animation and interpolation, rigging math, effects, the command
system and undo, the export pipeline (frame timing, muxing, encoding, blank-frame
detection), and component behaviour under jsdom.

`npm run render-tests` renders a catalogue of scenes through the real engine and
compares the output to committed reference PNGs. When a change to the renderer is
*intended* to alter pixels, re-bless the affected scenes:

```bash
npm run render-tests:update -- <scene-name>
```

Then check `git status packages/render-tests/references/` before committing —
blessing is deliberate, and an unreviewed reference change hides a regression.

### Testing notes worth knowing

- Anything that reads pixels back from a GPU canvas must do so in the **same
  task** as the draw call. After an `await`, a canvas that has been composited
  hands back nothing.
- The renderer's Null backend records draw calls, not pixels. It proves structure
  (this many quads, in this order); it cannot prove a shader is correct. Visual
  correctness is what `render-tests` is for.

---

## Packaging a release

```bash
npm run pack   # unpacked build in release/ — fast, for testing
npm run dist   # installer for the current platform
```

**Read `electron-builder.yml` before you distribute anything.** As committed, it:

1. Requires a sibling `../motion-back` checkout that has already been built.
   Without it, `npm run dist` fails. If you only want the editor, delete the
   `extraResources` block.
2. Copies `../motion-back/.env` into the installer. That file holds database
   credentials and API keys, so any build you distribute **leaks them**. Remove
   that entry and configure the server at first run instead.

To make video export work without a system ffmpeg, bundle the binary:

```yaml
extraResources:
  - from: <path-to-folder-containing>/ffmpeg   # ffmpeg or ffmpeg.exe
    to: ffmpeg
```

`electron/main.ts` checks `<resources>/ffmpeg` before falling back to `PATH`.
Note that ffmpeg's own licence terms (LGPL or GPL, depending on the build)
travel with it.

---

## Contributing

Issues and pull requests are welcome.

Before opening a PR:

```bash
npm run typecheck && npm test && npm run lint
```

What tends to get a PR merged quickly:

- **A test that fails before the change and passes after.** For anything with
  pure logic in it, that test should not need a GPU.
- **Comments that explain why, not what.** The code says what it does; a comment
  earns its place by explaining a constraint that is not visible locally.
- **Honest scope.** A feature is done when it is wired to the UI and the UI reads
  its state back. Half-wired features that look finished are worse than absent
  ones — several of this project's bugs were exactly that.
- **No silent fallbacks.** If a code path cannot do what was asked, it should say
  so with a reason, not produce something that looks close.

Larger changes are easier to review if you open an issue first, particularly
anything touching the scene graph, the animation engine or the render path.

---

## Further documentation

| Document | Contents |
| --- | --- |
| [`docs/MOTION_EDITOR_COMPLETE_GUIDE.md`](docs/MOTION_EDITOR_COMPLETE_GUIDE.md) | Every panel, button, tool and action, surface by surface |
| [`docs/3d-layer-model.md`](docs/3d-layer-model.md) | The 3D model, and where it differs from After Effects |
| [`docs/BONE_AND_PUPPET_RIGGING.md`](docs/BONE_AND_PUPPET_RIGGING.md) | Rigging: the math, the data model, the current gaps |
| [`docs/ANIMATED_SVG_PIPELINE.md`](docs/ANIMATED_SVG_PIPELINE.md) | SVG import, from file to keyframes to pixels |
| [`docs/PLUGINS.md`](docs/PLUGINS.md) | Plugin architecture and authoring |
| [`docs/AI_ARCHITECTURE_FULL.md`](docs/AI_ARCHITECTURE_FULL.md) | How the AI assistant is wired, editor and server |

---

## License

`package.json` currently declares `UNLICENSED`. **Pick a license before
publishing** — without one, nobody may legally use or contribute to the code.
Add a `LICENSE` file and update the `license` field to match.

Third-party notes: ffmpeg, if you bundle it, carries its own terms (LGPL or GPL
depending on the build). "After Effects" is a trademark of Adobe; this project
is not affiliated with or endorsed by Adobe, and references to it are
descriptive comparisons only.
