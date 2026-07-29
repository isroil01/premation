# Motion Editor — Complete Guide

**Everything the app is: every surface, every panel, every button, every tool, every shortcut, every action, and how it all fits together.**

Generated from the source tree on 2026-07-23. Version `0.1.0` (`package.json`).
Where this doc says "does X", it means the code path exists and is wired; a few
places are explicitly flagged as stubbed/gated.

---

## Table of Contents

1. [What the product is](#1-what-the-product-is)
2. [Running it](#2-running-it)
3. [App shell & navigation (routes)](#3-app-shell--navigation-routes)
4. [The editor frame — anatomy of the screen](#4-the-editor-frame--anatomy-of-the-screen)
5. [Menu bar — every menu, every item](#5-menu-bar--every-menu-every-item)
6. [Toolbar — every tool](#6-toolbar--every-tool)
7. [The viewport (canvas) — interactions & overlays](#7-the-viewport-canvas--interactions--overlays)
8. [Left sidebar panels](#8-left-sidebar-panels)
9. [Right inspector panels](#9-right-inspector-panels)
10. [Timeline & Graph Editor](#10-timeline--graph-editor)
11. [Animation system — keyframes, easing, expressions, presets](#11-animation-system--keyframes-easing-expressions-presets)
12. [3D system](#12-3d-system)
13. [Effects & compositing](#13-effects--compositing)
14. [Rigging — puppet & skeleton](#14-rigging--puppet--skeleton)
15. [Text & typography](#15-text--typography)
16. [Motion graphics primitives (shape operators)](#16-motion-graphics-primitives-shape-operators)
17. [Audio](#17-audio)
18. [Compositions, precomps & instances](#18-compositions-precomps--instances)
19. [Asset & content libraries](#19-asset--content-libraries)
20. [The AI assistant](#20-the-ai-assistant)
21. [Export & Render Queue](#21-export--render-queue)
22. [Presentation / review mode](#22-presentation--review-mode)
23. [History, versions, autosave, recovery](#23-history-versions-autosave-recovery)
24. [Collaboration — comments & review links](#24-collaboration--comments--review-links)
25. [Settings, customization, plugins](#25-settings-customization-plugins)
26. [Account, backend, billing](#26-account-backend-billing)
27. [Complete keyboard shortcut reference](#27-complete-keyboard-shortcut-reference)
28. [Architecture — how it's built](#28-architecture--how-its-built)
29. [Testing & quality gates](#29-testing--quality-gates)
30. [Known gaps / gated features](#30-known-gaps--gated-features)

---

## 1. What the product is

Motion Editor is a **professional, AI-native motion design application** — an
After Effects–class desktop tool, built as an Electron app on a React 18 +
TypeScript + Vite renderer, with a cloud backend (`motion-back`, NestJS +
Postgres) for auth, projects, assets, render queue and AI proxying.

The design target is **After Effects parity** for the core compositing/animation
workflow, plus things AE doesn't have:

- A real **AI director** that plans and builds scenes with 45 typed tools.
- **Local-first** project bundles (`.motion`) with optional encrypted cloud sync.
- A **calm-by-default** timeline (one row per layer until you ask for more).
- Built-in **content libraries** (motion graphics, transitions, SFX, Lottie, UI kit, cursors).

Two render backends exist behind one contract: a Canvas2D backend and a WebGL2/
WebGPU GPU backend, both driven from the same immutable per-frame *snapshot*.

---

## 2. Running it

```bash
npm run electron:dev
```

That is the real app: it compiles the Electron main process, starts Vite on
`localhost:5173`, waits for it, and launches Electron. Other scripts:

| Script | What it does |
|---|---|
| `npm run dev` | Vite only — browser renderer, no Electron IPC (file/bundle features degrade) |
| `npm run build` | `tsc -b` + Vite production build |
| `npm run electron:build` | Vite build + compile `electron/` |
| `npm run pack` / `npm run dist` | electron-builder — unpacked dir / installers |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint over `.ts/.tsx` |
| `npm test` | Jest suite |
| `npm run render-tests` | Golden-frame render regression suite |
| `npm run render-tests:update` | Re-bless golden frames |

The editor expects the backend (`motion-back`) on port **4000** for login,
cloud projects, AI, and MP4 muxing. Without it you bounce to `/login`.

---

## 3. App shell & navigation (routes)

`HashRouter` (Electron-safe). Routes in `src/routes/AppRouter.tsx`:

| Route | Screen | Guard |
|---|---|---|
| `/` | redirect → `/dashboard` | — |
| `/login` | Auth page (sign in) | public |
| `/register` | Auth page (create account) | public |
| `/forgot-password` | Request reset email | public |
| `/reset-password` | Set new password from token | public |
| `/dashboard` | Project dashboard — list/create/open projects | `RequireAuth` |
| `/editor` | Editor with a scratch/last project | `RequireAuth` |
| `/editor/:projectId` | Editor bound to a cloud project | `RequireAuth` |
| `*` | redirect → `/` | — |

**Dashboard** (`src/pages/DashboardPage.tsx`) is where compositions are born —
one project per composition, with size/fps/duration chosen at creation. There is
deliberately **no "New Composition…" inside the editor menu**; the Project panel
handles in-project composition management instead.

---

## 4. The editor frame — anatomy of the screen

`src/layout/EditorLayout/EditorLayout.tsx`:

```
┌──────────────────────────────────────────────────────────────┐
│ TitleBar        (window chrome: minimize / maximize / close)  │
├──────────────────────────────────────────────────────────────┤
│ TopNav          menu bar + tool rail + Animate/Insert menus   │
│ ToolOptionsBar  contextual options for the active tool        │
├───────────┬──────────────────────────────┬───────────────────┤
│           │                              │                   │
│ Left      │   Workspace (viewport)       │  Right Inspector  │
│ Sidebar   │   • ViewportHeader           │  (8 tabs)         │
│ (5 tabs)  │   • Canvas + overlays        │                   │
│           │   • corner overlays          │                   │
├───────────┴──────────────────────────────┴───────────────────┤
│ BottomTimeline  (Timeline / Graph Editor + transport)         │
├──────────────────────────────────────────────────────────────┤
│ StatusBar   info readout · FPS meter · VU meter · account      │
└──────────────────────────────────────────────────────────────┘
```

Every region is a **DockPanel**: panels register themselves into a region, tabs
can be reordered, moved between the two sidebars, closed and reopened. Layout is
JSON-serialisable and persisted; **View → Reset Layout** restores the defaults.

Region toggles: **View → Toggle Scene Panel / Toggle Inspector / Toggle Timeline**.

Global overlay hosts mounted once at the root:

- **ModalHost** — the modal stack (`modalStore`).
- **ContextMenuHost** — right-click menus, clamped to the viewport, closes on Esc/outside click.
- **NotificationHost** — toast stack with auto-dismiss (`uiStore.notify`).
- **OnboardingOverlay** — first-run tour; step 1 offers "Coming from After Effects?" shortcut import.
- **CommandPalette** — see §27.

---

## 5. Menu bar — every menu, every item

`src/layout/Menu/menuModel.ts` + `AppMenuBar.tsx`. The menu bar is a *thin
renderer*: labels, enabled-state and shortcut hints all come from the registered
command, so a greyed item means the command's `enabled()` returned false.
Hovering between open groups switches menus, like a native menu bar.

### File
| Item | Command | Shortcut |
|---|---|---|
| New Project | `project.new` | Ctrl/Cmd+N |
| Open… | `project.open` | Ctrl/Cmd+O |
| Save | `project.save` | Ctrl/Cmd+S |
| Save As… | `project.saveAs` | Ctrl/Cmd+Shift+S |
| Increment and Save | `project.incrementAndSave` | Ctrl/Cmd+Alt+Shift+S |
| Export… | `file.export` | — |
| Version History… | `file.versionHistory` | — |
| Close Project | `project.close` | — |

### Edit
Undo (Ctrl+Z), Redo (Ctrl+Shift+Z), Cut (Ctrl+X), Copy (Ctrl+C), Paste (Ctrl+V),
Select All (Ctrl+A), Deselect (Esc), Duplicate (Ctrl+D), Delete (Backspace / Del).

Cut/Copy act on **selected keyframes if any, else selected layers**.

### Composition
- **Composition Settings…** (Ctrl/Cmd+K) — name, width/height, frame rate, duration, background colour, and pasteboard (canvas surround) colour under "Environment".
- **Save Frame As PNG** — current frame to disk.

### Layer
- **New →** Text (Ctrl+Alt+Shift+T), Solid… (Ctrl+Y), Camera, Light, Null Object (Ctrl+Alt+Shift+Y), Adjustment Layer (Ctrl+Alt+Y)
- **Bring to Front / Bring Forward / Send Backward / Send to Back**
- **Pre-compose…** (Ctrl+Shift+C)
- *(also registered, reachable via palette)* **Rig Logo for Animation**, **Merge Paths: Union / Subtract / Intersect / Exclude**

### Effect
Quick-add entries: Fast Box Blur, Glow, Brightness & Contrast, Contrast,
Hue/Saturation, Grayscale, Sepia, Hue Rotate. (The full 30-effect palette lives
in the Effects panel — §13.)

### Animation
Keyframe Assistant: **Easy Ease** (F9), **Easy Ease In** (Shift+F9),
**Easy Ease Out** (Ctrl+Shift+F9); **Keyframe Interpolation: Linear**, **Hold**.

### View
Toggle Scene Panel · Toggle Inspector · Toggle Timeline · Toggle Grid · Toggle
Rulers · Toggle Safe Areas · Reset Layout · Switch Theme (Ctrl+Shift+K).

### Window
Command Palette · Present (Preview) · Project · Effects · Render Queue · Graph
Editor · Customize… · Plugins….

### Help
Take a Tour · About Motion Editor.

### Examples (registered commands)
**Load: Nova AI — SaaS Ad** and **Load: Complex Showcase** build full demo
scenes. Both *replace* the scene, so both confirm first if the project is dirty.

---

## 6. Toolbar — every tool

`src/layout/TopNav/TopNav.tsx`. Tools are grouped; each group remembers the last
tool used in it, so the rail stays compact. The **ToolOptionsBar** underneath
shows contextual options for whatever is active.

### Pointer group
| Tool | Key | What it does |
|---|---|---|
| Selection | `V` | Select/move layers; marquee-select; drag handles |
| Direct Selection | `A` | Select individual path points/handles |
| Rotation | `W` | Rotate around the anchor point |
| Pan Behind (Anchor) | `Y` | Move the anchor point without moving the layer |
| Hand | `H` | Pan the view (Space = temporary hand) |
| Zoom | `Z` | Click to zoom in, Alt-click to zoom out |

### Pen group
Pen (`G`), Pencil, Brush (pressure ink), Curvature Pen.

### Shape group
Rectangle (`Q`), Ellipse (`Shift+Q`), Polygon, Star, Line Segment.

### Text
Text tool (`Ctrl+T`) — creates a text layer; double-click an existing text layer
to edit **on canvas** via the contentEditable `TextEditOverlay` (Enter commits,
Esc cancels, blur commits). This replaced `window.prompt`, which Electron refuses.

### Mask tools
Rectangle Mask, Ellipse Mask — draw a mask directly on the selected layer.

### Rig tools
- **Puppet Position Pin** (`Ctrl+P`) — drop pins on a mesh, drag to deform.
- **Bone** (`Ctrl+B`) — draw a skeleton chain on a layer.

Both are disabled unless the selection is a riggable leaf (shape or image layer);
the tooltip tells you so and points at **Rig Logo** for groups.

### Camera tool
`C` cycles the left-drag camera mode: **Orbit → Pan (Track XY) → Dolly**. A toast
announces the mode. `Esc` (or picking `V`) exits. Only live when the comp has a
camera and a 3D layer — otherwise the bare `C` falls through harmlessly.

### Top-bar menus (not tools, but buttons on the same strip)
- **Insert menu** — Solid, Camera, Light, Adjustment Layer, Null, Audio (file picker), Particle emitter, Image Sequence (multi-file picker), Lottie import (file picker), 3D primitive, 3D Text, Composition instance (any other comp in the project).
- **Animate menu** — every animation preset (see §11), the four text rigs, Easy Ease All, Time-Reverse Keyframes, Sequence Layers (bars, end-to-end), Stagger Animations (0.3 s), Add Slider Control (expression rig).
- **Undo / Redo** buttons, live-enabled off the history stack.
- **Snap toggle**, **3D toggle** for the selected layer.
- **SceneControls** — quick scene-level toggles.

---

## 7. The viewport (canvas) — interactions & overlays

`src/layout/Workspace/Workspace.tsx`, driven by the framework-independent
`@motion/workspace` engine through `useWorkspace`.

```
┌──────────────────────────────────────────────────────┐
│ ViewportHeader: ← [Comp name] · W×H · Free/Fixed …   │
│                 motion path … Zoom · Fit · View opts │
├──────────────────────────────────────────────────────┤
│  Stage (dot-grid / checkerboard void)                │
│      ┌──────────────────────────┐                    │
│      │  Composition canvas      │  ← framed, shadowed│
│      └──────────────────────────┘                    │
│  [BL: info bar]              [BR: zoom controls]     │
│              [BC: AI prompt bar]                     │
└──────────────────────────────────────────────────────┘
```

### ViewportHeader controls
Back button · composition name · **size preset picker** (shared grouped catalog
in `core/composition/presets.ts`) · **Free / Fixed** framing (Fixed locks the
camera so the comp never drifts; persisted per workspace) · motion-path toggle ·
zoom % · Fit · view options (grid, rulers, safe areas, guides) · **+Camera** and
**+Light** buttons which open real creation dialogs (`SceneInsertDialogs`) rather
than inserting hardcoded seeds.

### Direct manipulation
- Click to select, Shift-click to add, marquee to rubber-band.
- Drag to move; corner/edge handles to scale; the multi-select gizmo gives group
  bounds with corner scale handles.
- Arrow keys nudge (Shift = larger step).
- `Space` held = temporary hand tool; `Delete`/`Backspace` delete; `Esc` deselects.
- Double-click a text layer → on-canvas editing.
- Double-click a UI-kit component → drill into it.
- Snapping with guides (toggleable), plus snap guides computed against siblings.

### Drag & drop onto the canvas
The viewport accepts drops from every library and from the OS: shapes, text,
media files, cursor items, UI-kit components, motion-GFX items, transitions, SFX,
Lottie items, saved components, effects, and animation presets. Dropping an
effect or preset onto a layer applies it to that layer.

### Overlays rendered above the canvas
| Overlay | Purpose |
|---|---|
| `TextEditOverlay` | on-canvas contentEditable text editing |
| `PuppetOverlay` | puppet pins, mesh wireframe, drag handles |
| `BoneOverlay` | skeleton bones, joints, IK targets |
| `Gizmo3dOverlay` | 3D transform gizmo (Universal / Position / Scale / Rotation), ground grid at Y=0, dimensional guides — pink trajectory line, drop lines to the floor, live callout badge. Screen-constant sizing so it doesn't shrink with distance. |
| `AxisWidgetOverlay` | bottom-left world X/Y/Z orientation widget, projected through the current camera; screen-fixed; appears whenever the comp has any 3D layer |
| `FocusBreadcrumb` | "Main › Scene 2 › Logo" trail when Focus Mode is engaged; click a crumb to jump, `Esc` steps up |

### Multi-view layouts
`1 View` / `2 Views` / `4 Views`. In 2-up the interactive stage shrinks to the
left half; in 4-up to the top-left quadrant. The other cells are
`SecondaryViewPane`s — view-only renders of the same comp through a different
view (Active Camera, any orthographic view, or a custom view), each with its own
canvas and render backend.

### 3D view switching
`1` → Active Camera. `2` → last custom view used.

---

## 8. Left sidebar panels

Registered in `src/App.tsx`; content in `layout/EditorLayout/DemoPanels.tsx`.

### 8.1 Scene & Layers (`scene`)
The layer tree. Virtualised `TreeView` with:
- search/filter box,
- per-layer **label colours** (AE palette) via right-click,
- visibility / lock / solo / shy toggles,
- drag to reparent and reorder,
- right-click context menu: rename, duplicate, delete, precompose, label colour, rig, etc.
- selection is two-way with the canvas and the timeline.

### 8.2 Assets & Media (`assets`)
Imported media (images, video, audio, sequences). Shows thumbnails and file
sizes, supports folders (stored in `localStorage`), drag-to-canvas, and
`content-visibility` so a big library scrolls smoothly. Assets are stored via
Cloudinary in the cloud path (`<kind>:<public_id>`; audio is uploaded as
`resource_type: 'video'`) and a local blob store in the local-first path.

### 8.3 Flow & EaseCopy (`flow`)
A **cubic-bézier flow curve editor**: drag the two control handles on an SVG
graph or type the four numbers, then **Apply** to the selected keyframes.
**Copy** stores the ease of a selected keyframe, **Paste** stamps it onto any
other selection — the "ease clipboard" (`easeClipboardStore`).

### 8.4 Elements & Library (`library`)
One tab with four sections (tab strip inside the panel):

| Section | Count | What's in it |
|---|---|---|
| **Motion GFX** | 24 | Ready-made mograph elements; cards animate live in the panel (Canvas2D preview drawing the real `buildSnapshot`) |
| **Transitions** | 20 | Phase-aware transitions — `detectPhase` figures out whether you're placing an in/out/cross transition |
| **Sound FX** | 12 | SFX one-shots, drag to timeline |
| **Lottie** | 8 | Bundled Lottie animations with SVG previews, plus file import |

Two more catalogs feed the canvas from elsewhere: **Cursors** (24 items) and the
**UI Kit** (15 components — double-click to drill in). Insert == preview sizing,
so what you see in the card is what lands on the canvas.

### 8.5 AI Assistant (`ai`)
See §20. Hoisted above the dock tree (`AiChatContext`) so switching tabs
mid-generation doesn't cancel the run.

Also available but not left-docked by default: **Project panel** (compositions —
create, open, rename, duplicate, delete), **Components panel**, **Shapes panel**,
**Text panel**, **History panel**, **Comments panel**, **Render Queue**.

---

## 9. Right inspector panels

Eight tabs. Each has its own **search box** that filters sections by title *and*
by intent keywords (searching "color" surfaces Appearance; "pick whip" surfaces
Parenting). Matched sections auto-open.

### 9.1 Transform (`properties`)
- **Transform** — Position X/Y(/Z), Scale, Rotation, Opacity, Anchor Point, size. Every row has a stopwatch (keyframe toggle) and a scrubbable `ValueField`. Includes the **3D Layer switch** (`ThreeDControl`) which adds Z, X-rotation and Y-rotation props.
- **Parent & Link** — parent picker that reparents *without moving the layer on screen*; the option list excludes the layer and its descendants so cycles are impossible.
- **Align & Distribute** — align left/center/right/top/middle/bottom, distribute evenly.

### 9.2 Style (`style`)
Appearance (fill, stroke, gradients, corner radius), Text section (see §15),
Media section (source, trim, speed, fit, crop, volume), Compositing controls
(blend mode, track mattes), Layer switches, Layer Styles (Drop Shadow, Outer
Glow), Audio controls & waveform, Camera section (focal length + mm presets),
Light section (colour / intensity / radius — both keyframeable), Particle
section, Precomp controls, Shape effects.

### 9.3 Rigging (`rig`)
Puppet controls (mesh density/expansion → deterministic mesh rebuild; per-pin
static rotation and stiffness) and Bone controls (chain editing, IK targets,
pose). Every edit is a single undo step via `puppetCommands`.

### 9.4 Effects (`effects`)
The **Effect Stack** — AE's Effect Controls. Each applied effect gets an enable
toggle, reorder, remove, and **one row per parameter**. Numeric params are
keyframeable (stopwatch writes tracks under `effect.<id>.<param>`, sampled per
frame by `buildSnapshot`). Includes the tone **CurveEditor** for the Curves
effect (drag points, click empty space to add, Alt-click to remove, endpoints
pinned in X).

### 9.5 Easing (`motion`)
**MotionEditorPanel** — the large, direct-manipulation curve editor. Lists the
selected layer's animated properties; picking one draws its value-over-time curve
with big draggable keyframes. Selecting a keyframe exposes easing presets (which
reshape the curve live) and exact numeric entry. Sequencing lives in the
timeline; this panel owns *how* a value moves.

Also here: **ExpressionEditor** — VS-Code-flavoured (JetBrains Mono,
quick-insert autocomplete for the API, inline plain-language errors, a live value
that updates as you scrub, and AI-assist that produces an *editable* expression,
never a locked result).

### 9.6 Motion Tools (`motiontools`)
A quick-action pad: 3×3 **anchor-point grid** (click a dot to move the anchor to
that corner/edge/centre), AE **label colour** swatches, and one-click tweaks —
toggle 3D, insert Null, insert Shape, insert Camera, insert Text, Precompose,
toggle Time Remap, toggle Trim Paths, trim layer in/out to the playhead.

### 9.7 Presets (`presets`)
**PresetsBar** — save the selected layer's animation as a named preset, and
delete saved ones. *Applying* presets lives in the top-bar Animate menu (one home
per action).

### 9.8 Settings (`misc`)
Per-layer misc settings, Time Controls (stretch %, reverse, freeze frame, frame
blending), motion-path options (auto-orient), and the local-first **Version
History section** (list snapshots, save a named version, restore an older one).

---

## 10. Timeline & Graph Editor

### Timeline (`src/layout/Timeline/Timeline.tsx`)
**Calm by default.** Every layer is a *single* row showing one neutral animation
block that summarises where its keyframes live. Expanding a track — via the
disclosure chevron or the `U` reveal shortcut — splits it into one sub-row per
animated property, each with draggable keyframes.

Row features:
- **Live scrubbable value fields on property rows**, so a whole animation can be
  built without crossing to the inspector.
- Keyframe diamonds: drag to retime, marquee-select, copy/paste, delete.
- Layer bars: drag to move in time, edge-drag to trim, split at playhead.
- Search filter, **shy** toggle, solo/lock/visibility columns, label colours.
- Work-area in/out markers, comp markers.
- Transport bar: play/pause, jump to start/end, frame step, loop.

### Graph Editor (`GraphEditor.tsx`)
AE-style **Value / Speed** graph:
- *Value mode* draws animated property curves as SVG Bézier paths.
- *Speed mode* draws the derivative (rate of change) — read-only vertically,
  because a Y position there is a speed, not a value.
- Interactive keyframe diamonds: drag horizontally to retime, vertically to
  change value; bézier handles reshape easing.

### Timeline shortcuts (`useTimelineKeys`)
| Key | Action |
|---|---|
| Home / End | Go to start / end |
| Page Down / Page Up | Next / previous frame |
| Shift+Page Up/Down | Previous / next marker |
| `J` / `K` | Previous / next keyframe |
| `B` / `N` | Set work-area in / out at the playhead |
| `Shift+B` | Clear the work area |
| Ctrl/Cmd+Shift+D | Split selected clips at the playhead |
| Ctrl/Cmd+Z / +Shift+Z | Undo / redo timeline edits |
| Ctrl/Cmd+C / +V | Copy / paste keyframes at the playhead |
| Ctrl/Cmd+Alt+S | Smooth motion path for selected layers |
| `[` / `]` | Trim layer in / out |

Arrow keys and Space are deliberately *not* claimed here — the viewport owns them.

---

## 11. Animation system — keyframes, easing, expressions, presets

### Keyframes
Tracks live on the `@motion/animation` engine. A property is animated when it has
a track; the stopwatch in the inspector or timeline arms it. Values are sampled
per frame into the render snapshot.

**Critical time-axis rule:** keyframes are written and read on the *layer-local*
axis via `getRemappedTime(id, compTime)`. `toLayerTime` is a naive
"subtract clip start" and mixing the two is what caused the classic
"my two keyframes overwrite each other" bug. Never mix them.

**Add-keyframe chords:** `Alt+Shift+<prop>` keys the current visible value —
`P` position, `S` scale, `R` rotation, `T` opacity, `A` anchor — and auto-reveals
the row so the new diamond is visible.

**Reveal chords:** bare `P` / `S` / `R` / `T` / `A` expand the selection and show
only that property. `U` reveals *only keyframed* properties (AE behaviour); the
chevron twirl shows the whole tree.

### Easing
- Presets: **Ease**, **Ease In**, **Ease Out**, **Linear**, **Hold** — F9 family + the Animation menu.
- Arbitrary cubic-bézier via the **Flow** panel, with copy/paste of eases between keyframes.
- The MotionEditorPanel and Graph Editor both edit the curve directly.

### Keyframe assistants
Easy Ease All, Time-Reverse Keyframes, Sequence Layers (bars end-to-end),
Stagger Animations (0.3 s default), smooth motion path.

### Expressions
A real expression language (`packages/animation/src/exprLang.ts`) evaluated per
frame, with vector support. `Add Slider Control` creates a named rig control you
reference anywhere with `ctrl('Name')`. The editor shows live values while
scrubbing and plain-language errors.

> Note: the dev-mode CSP blocks `new Function`, which historically made
> `set_expression` inert in dev; the shipped path evaluates through the engine's
> own interpreter.

### Animation presets (33, applied from the Animate menu)
**Entrances:** Fade In · Pop In · Bounce In · Slide In Left · Slide In Right ·
Rise Up · Drop In · Spiral Entrance · Skid Slide In
**Exits:** Fade Out · Zoom Out Exit · Rotate Out Exit
**Loops/idles:** Spin · Pulse · Shake · Heartbeat · Elastic Float · Jelly Wobble ·
Glitch Jitter · Wiggle Drift · Wind Sway
**3D:** Flip In 3D · Card Flip 3D · Swing In 3D · Depth Push In · Orbit Tilt 3D ·
3D Twirl In · 3D Cube Roll · Cinematic Pan 3D
**Text rigs:** Typewriter · Bounce In Words · Spin & Fade Characters · Tracking Reveal

Your own presets: save from the Presets panel, apply from the Animate menu.

---

## 12. 3D system

A true 3D pipeline, not a fake perspective hack.

- **3D layers** — the `ThreeDControl` switch adds Z, X-rotation and Y-rotation. The renderer projects the layer through the composition camera with a proper 4×4 matrix pipeline (perspective scale, parallax, tilt).
- **Cameras** — real camera layers with a pinhole lens model; focal length in comp-space px, with familiar mm presets. Created through a proper "New Camera" dialog.
- **Lights** — per-fragment **Lambert + Blinn-Phong** shading. Colour, intensity and radius are all keyframeable.
- **Materials** — per-layer material properties feeding the shading model.
- **Extrusion** — give a 2D shape/text real depth.
- **Z-sorting** and depth-of-field blur.
- **Ground grid** at Y=0 and the **axis widget** for orientation.
- **Camera navigation** — `C` cycles orbit/pan/dolly; Alt-drag also orbits/pans/dollies.
- **Draft 3D** toggle for faster interaction.
- **Auto-orient** — rotate a layer to face its direction of travel along the animated position path.

**Gotcha worth knowing:** `canBe3D` is a single gate — a layer can go 3D if it has a Transform component. Solid layers historically could *not* because the renderer pins them.

**Renderer gotcha:** the FBO V-flip is per-backend — WebGL2 flips, WebGPU must not. Use `targetSampleUv` / `renderTargetFlipV`, never a raw `SCREEN_FLIP_UV`.

---

## 13. Effects & compositing

### The 30 effect types (`core/effects/effects.ts`)
`blur` · `glow` · `drop-shadow` · `brightness` · `contrast` · `saturate` ·
`grayscale` · `sepia` · `hue-rotate` · `hue-saturation` · `invert` · `levels` ·
`curves` · `posterize` · `tint` · `channel-mixer` · `gradient-ramp` ·
`fractal-noise` · `displacement-map` · `motion-tile` · `fill` ·
`four-color-gradient` · `stroke` · `beam` · `sharpen` · `noise` · `keylight` ·
`wave-warp` · `turbulent-displace` · `echo`

Each has a full parameter set — e.g. Glow has radius / colour / intensity; Drop
Shadow has distance / angle / softness / colour / opacity; Levels has input
black/white, gamma, output black/white; Channel Mixer has the full 12-coefficient
matrix plus a monochrome switch; Displacement Map takes a **layer** parameter.

### Compositing
- **Blend modes** (`core/effects/blendMode.ts`).
- **Track mattes** (`matte.ts`) — alpha/luma, inverted.
- **Masks** with animatable paths (`mask.ts`, `maskAnim.ts`).
- **Adjustment layers** — effects apply to everything beneath.
- **Layer styles** — Drop Shadow + Outer Glow, compiled to the CSS-filter path.
- **Motion blur** — per-layer and comp-level.
- **Layer quality** switches, **effect baking**, colour LUTs, colour matrices.
- **Echo** (temporal trails), **Keylight** (chroma key), **Warp**.

---

## 14. Rigging — puppet & skeleton

Two *distinct* systems.

### Puppet (AE-Puppet-grade)
- ARAP (as-rigid-as-possible) solver.
- Mesh generated from the layer's **alpha/silhouette**, with density and expansion controls; the rest-mesh is cached by key so rebuilds are deterministic.
- **PuppetControls** inspector: per-pin static rotation and stiffness.
- Puppet pins are keyframeable (`set_puppet_pin_keyframes` AI tool exists too).
- `PuppetOverlay` draws the mesh and pins on canvas.

### Skeleton / bone rig
- Native bone + mesh rig in `src/core/rig/`.
- Forward kinematics, **linear blend skinning**, two-bone IK and **FABRIK** IK — all live.
- CPU and GPU skinning paths. The classic "mesh deforms but the object doesn't move" bug was a GPU-path issue fixed via `normalizeDeformedMesh`.
- `BoneOverlay` draws bones/joints; `pose_skeleton` is an AI tool.

### Rig Logo for Animation
One command that flattens a multi-part logo (group / precomp / multi-selection)
into a single image layer and drops a starter puppet rig on it. A single riggable
image/shape leaf is rigged in place instead.

---

## 15. Text & typography

- **TextSection** inspector: family, size, weight, letter-spacing, line-height, alignment, colour.
- **FontPicker** — enumerates locally installed fonts via the Chromium Local Font Access API (`queryLocalFonts()`), lazily on first open (may prompt for permission). Falls back to a curated Google-font list + system fonts. Every option renders in its own family as a live preview; arrows + Enter select.
- **Text animators** (`TextAnimatorControls`) — AE-style animator groups: a **range selector** (by characters / words / lines, with a falloff shape) plus transform offsets (position, scale, rotation, opacity, tracking, colour). Every numeric parameter has a stopwatch; keyframes go through the reversible command path.
- **Text on a path** (`set_text_on_path`).
- **3D text** and **per-character 3D**.
- Four ready-made text rigs in the Animate menu (Typewriter, Bounce In Words, Spin & Fade Characters, Tracking Reveal).

---

## 16. Motion graphics primitives (shape operators)

Consolidated into a **single "+ Add" menu** in `ShapeEffects` — no stacked
per-effect Add buttons.

| Operator | What it does | Keyframeable |
|---|---|---|
| **Repeater** | Fan a shape into N copies with offset transform | every parameter |
| **Path Operator** | Zig-Zag, Round Corners, Pucker & Bloat, Twist | Amount / Detail |
| **Trim Paths** | Reveal a portion of the outline stroke (write-on, chase) | Start / End / Offset |
| **Merge Paths** | Union / Subtract / Intersect / Exclude across 2+ shape layers | — |
| **Audio Waveform** | Amplitude *envelope* visualiser driven by a referenced audio layer (not an FFT spectrum) | config fields |
| **Particles** | Emitter with a full config block; every numeric field keyframeable under `particle.<key>`, colours via channel tracks | yes |

---

## 17. Audio

- Import audio via the Insert menu (stored as `resource_type: 'video'` in Cloudinary).
- **AudioControls** inspector: decoded waveform display with playhead marker, level, in/out trim, mute.
- Playback driven by the transport through the **AudioEngine** (Web Audio).
- **VU meter** in the status bar — stereo peak bars off the master L/R analysers, only while playing, hidden entirely if Web Audio never produced an analyser.
- Audio is muxed into MP4 exports through the Electron backend (`render:stageAudio` → `render:muxMp4`).
- The SFX library (12 items) drops one-shots straight onto the timeline.

---

## 18. Compositions, precomps & instances

- **Project panel** — the list of compositions: create, open, rename, duplicate, delete. All mutations route through `core/composition/compositionOps`; the panel owns no logic.
- **Composition Settings** (Ctrl+K) — name, size, fps, duration, background, pasteboard colour. fps/duration also write into the TimelineController so the time domain stays consistent.
- **Pre-compose** (Ctrl+Shift+C) — wrap the selection into a nested comp.
- **Precomp rendering** — the subtree renders to its own FBO and composites as one unit, so group opacity / blend / effects apply to the nested animation correctly (FBO isolation is real, not faked).
- **Time Remap** — keyframe the nested content's internal time for holds, reverses and speed ramps independent of comp time.
- **Composition instances** — insert comp A into comp B; AE-style stacking rules apply.
- **Size presets** come from one shared grouped catalog (`presets.ts`), used by both the dashboard and the viewport header.

---

## 19. Asset & content libraries

| Library | Items | Insert path |
|---|---|---|
| Motion GFX | 24 | drag to canvas; live Canvas2D card previews |
| Transitions | 20 | drag onto a layer/cut; phase-aware |
| Sound FX | 12 | drag to timeline |
| Lottie | 8 bundled + file import | drag or File-import |
| Cursors | 24 | drag to canvas |
| UI Kit | 15 | drag to canvas; double-click to drill in |

**Lottie import** is real: rigs come in as baked animated paths. The engine works
in **absolute** coordinates while Lottie is relative — the `buildSnapshot`
`path.points` hook is the keystone of that conversion. `preserveWorld` handling
was fixed so imported layers don't jump.

**Templates**: MOGRT-style — a template exposes only specific `TemplateField`s,
and end users edit just those (`writeProp`). Template cards animate live using
the real `buildSnapshot` drawn through Canvas2D at a shared 30 fps rAF.
(Image-swap fields and the authoring UI are still TODO.)

**Components**: save any subtree as a reusable component; thumbnails via
`componentThumbs`.

---

## 20. The AI assistant

### The surface
A left-sidebar tab (`AiChatPanel`), arranged like ChatGPT/Claude: header (new
chat / history) → scrolling thread → composer pinned at the bottom.

The thread shows:
- your messages and the assistant's replies (markdown),
- a **live plan checklist** as the director works,
- **Director pipeline stages** for generative prompts,
- a **result preview** with **Apply / Decline**.

Composer row:
- prompt textarea (image attachments supported),
- **provider + model picker**,
- **execution mode picker**: **Manual** (review a preview before it lands) or
  **Auto** (apply directly).

There's also a **bottom-centre AI prompt bar** floating over the canvas for quick
one-liners.

### How it works
1. **Router / Intent** classifies the request.
2. The **PipelineOrchestrator** runs stages: `intent` → `spec` → `storyboard` → `scene` → `animation` → `camera` → `timeline` → `creative` → `toolPlan` → `verifier`, plus a `promptOptimizer`.
3. The **AgentLoop** executes tool calls against the live scene through `toolHandlers.ts`.
4. Everything runs inside an **AI transaction** (`aiTransaction.ts`) so Decline rolls back cleanly and Apply is one undo step.
5. `renderFeedback` gives the model **sighted** feedback — it can see what it rendered on every path, not just guess.

### The 45 tools (`packages/ai-tools`)
**Read/inspect:** `describe_scene` · `get_selection` · `list_assets` ·
`list_capabilities` · `list_presets` · `read_tracks` · `evaluate_at`

**Create:** `create_layer` · `create_media` · `create_media_from_attachment` ·
`create_mask` · `add_scene` · `add_background` · `add_title` ·
`add_kinetic_title` · `add_lower_third` · `add_cards` · `add_emblem` ·
`add_ambient_orbs` · `add_light_sweep`

**Modify:** `update_layer` · `delete_layer` · `reparent_layer` ·
`update_composition` · `define_style` · `add_effect` · `update_effect`

**Animate:** `set_keyframes` · `remove_keyframes` · `set_easing` ·
`set_expression` · `apply_preset` · `stagger_in` · `text_animator` ·
`add_camera_move` · `add_transition`

**Shapes/paths:** `add_repeater` · `add_path_operator` · `merge_paths` ·
`set_trim_path` · `set_text_on_path`

**Rigging:** `create_puppet_rig` · `create_skeleton_rig` · `pose_skeleton` ·
`set_puppet_pin_keyframes`

### De-templating: entrance archetypes
So AI output doesn't all look the same, entrances are a **parameter**, not a
template. Six archetypes — `rise`, `scale_pop`, `blur_resolve`, `slide_settle`,
`mask_wipe`, `char_cascade` — each a distinct keyframe/easing plan, auto-varied
per role (titles, cards, emblems…) and coercible away from targets they can't work on.

### Providers & keys
Two ways to power it (**Settings → AI**):
- **Motion AI** — our provider account, metered and billed to the user, nothing to manage. *(Disabled while in development; the server says so.)*
- **Your own key** — OpenAI / Anthropic / Gemini. The key is sent **once** to the backend gateway, stored **AES-encrypted** against your account, and never kept in the renderer. `motion-back /ai/stream` proxies the byte stream; the agent loop itself runs in the renderer.

---

## 21. Export & Render Queue

### Export dialog (File → Export…)
Renders **off-screen**, shows progress, never blocks the editor. Seven presets:

| Format | Ext | Notes |
|---|---|---|
| **MP4 Video** | `.mp4` | requires the backend online (muxed via Electron `render:muxMp4`) |
| **GIF Animation** | `.gif` | fully local render, encoded in a worker |
| **Video (WebM)** | `.webm` | deterministic frame-by-frame render |
| **PNG sequence** | `.zip` | lossless frames, deterministic |
| **Still frame** | `.png` | current frame |
| **Lottie** | `.json` | editable Lottie for web/mobile |
| **Project** | `.json` | re-openable Motion project file |

Options: resolution scale (**Full / Half / Quarter**), fps, duration, time range.

### Render Queue (Window → Render Queue)
AE-style queue: add jobs targeting the current composition, start/pause all, skip
or remove individual jobs, clear finished. Rendering is **real** — each job runs
the deterministic offline renderer, reports true per-frame progress, and
downloads the output. An **Output Module dialog** configures per-job settings.
Cancellation is enforced server-side too. The queue is throttled so the UI stays
responsive, and GIF/zip encoding happens in a worker.

> Build gotcha: `import.meta` breaks Jest, so the encode worker is spawned
> through a dynamic import in `spawnEncodeWorker.ts`.

---

## 22. Presentation / review mode

**Window → Present (Preview)** — full-bleed, distraction-free playback on a dark
stage with real player chrome:

- frame-accurate transport (start / prev / play / next / end / loop),
- a seekable, draggable progress bar,
- timecode (current / total) computed at the *composition* frame rate,
- size + fps + preview-quality badges — the quality badge actually re-renders,
- **Download current frame (PNG)** and **Export video…**.

---

## 23. History, versions, autosave, recovery

Four layers of "don't lose work":

1. **Undo/redo** — `CommandSystem` + `HistoryService`. Every mutation is a reversible command; the top-bar buttons and menu items are live-bound to `canUndo/canRedo` via the `UndoStackChanged` event.
2. **History panel** — Photoshop-style visual history. Lists every recorded state oldest → newest, current highlighted, redoable states dimmed. Click a row to jump (non-destructive). Double-click a label to rename it ("Client v1 look"). The camera button pins a named snapshot.
3. **Version history** — two flavours:
   - *Cloud*: `VersionHistoryPanel` (File → Version History…) browses motion-back autosave snapshots + manual checkpoints, capture a named checkpoint, restore any entry (the server rewinds the project head too).
   - *Local-first*: `VersionHistorySection` in the inspector lists the `.motion` bundle's snapshots; save/restore named versions. Only renders when `LOCAL_FIRST` is on and a bundle is open.
4. **Autosave + recovery** — `AutosaveController` debounces persistence; `recovery.ts` + the Electron `index:addRecovery` IPC keep a crash-recovery trail.

---

## 24. Collaboration — comments & review links

- **CommentsPanel** — layer- and timecode-anchored review comments. Add a note on the selected layer at the current time; click a comment to jump the editor to that layer *and* that moment.
- **ReviewBar** — set the document's approval status and copy a **self-contained review link** that carries the project and its comments.

Real-time multi-cursor collaboration is *not* implemented (see §30).

---

## 25. Settings, customization, plugins

### Customize dialog (Window → Customize…)
Four tabs:
- **Shortcuts** — rebind / disable / reset any command key, with live conflict warnings. Rebinds persist through `shortcutOverrides` and re-apply through the ShortcutManager on next launch.
- **Workspaces** — apply a layout preset, save the current layout as a preset, delete user presets.
- **Appearance** — accent colour + theme (light/dark, CSS-variable driven).
- **AI** — connect your own OpenAI / Claude / Gemini account.

### Plugins (Window → Plugins…)
`PluginsModal` lists available plugins with a runtime **Install / Uninstall**
toggle. Installing registers the plugin's commands *immediately* — no restart —
and they show up in the Command Palette right away. `PluginHost` gives plugins
the `registerCommand` API; `src/plugins/samplePlugins.ts` ships examples.

### Status bar
- **InfoReadout** — AE's Info panel condensed: pixel colour swatch + RGBA and composition-space X,Y under the pointer. Shows a muted placeholder off-viewport (or when the colour is unreadable on the GPU backend).
- **FpsMeter** — real rAF-measured FPS. Off by default, click to toggle.
- **VUMeter** — stereo audio levels while playing.
- **AccountButton** — session state; opens the auth modal signed-out, an account menu signed-in.

---

## 26. Account, backend, billing

- **Auth** — email/password against motion-back, with forgot/reset flows. `RequireAuth` guards `/dashboard` and `/editor`. If motion-back is down, you bounce to `/login`.
- **Cloud projects** — projects, assets, versions and the render queue live server-side; `/files` serves signed URLs.
- **Billing** (`BillingSection`) — plan catalog, credit balance and whether checkout is open all come from the **server**; nothing is decided client-side. Stripe webhooks are wired.
- **AI credits** — metered per plan through the gateway.
- **Sync** — `ProjectSyncService` + `SyncEngine` with `ProjectCipher` (E2E encryption), manifest diffing, and an HTTP transport. The decided architecture (Option B, RFC in `ARCHITECTURE_RFC.md`) is: **desktop is the source of truth**, the backend is services-only plus an opt-in, end-to-end-encrypted **opaque sync vault** (a paid feature). The chunked `.motion` bundle + 6-table SQLite index is designed but **not yet fully implemented**.

### Electron IPC surface (`electron/main.ts`)
Local index: `index:available` · `upsertProject` · `getProject` · `listProjects` ·
`removeProject` · `markMissing` · `addRecovery` · `listRecovery` · `clearRecovery`
Projects/files: `project:open` · `project:chooseSavePath` · `file:read` · `file:write`
Bundles: `bundle:read` · `bundle:writeAtomic` · `bundle:remove` · `bundle:list` · `project:openBundleDir`
Blobs: `blob:has` · `blob:read` · `blob:write` · `blob:remove` · `blob:list`
Render: `render:beginJob` · `render:stageFrame` · `render:stageAudio` · `render:muxMp4`
Window/app: `window:minimize` · `window:maximize` · `window:close` · `app:version` · `app:quit`

---

## 27. Complete keyboard shortcut reference

> `Cmd` on macOS, `Ctrl` on Windows/Linux. Every one of these is rebindable in
> **Customize → Shortcuts**. Chords never fire while focus is in a text input.

### Command Palette
`Cmd/Ctrl+Shift+P` — opens from anywhere, *including while a field is focused*
(it owns its own listener). One search box, mode-switched by the first character:

| Prefix | Mode |
|---|---|
| *(plain text)* | search everything |
| `>` | commands |
| `@` | layers |
| `#` | compositions |
| `:` | timecode (jump to a time) |

### File & project
| Chord | Action |
|---|---|
| Cmd/Ctrl+N | New Project |
| Cmd/Ctrl+O | Open Project |
| Cmd/Ctrl+S | Save |
| Cmd/Ctrl+Shift+S | Save As |
| Cmd/Ctrl+Alt+Shift+S | Increment and Save |

### Edit
| Chord | Action |
|---|---|
| Cmd/Ctrl+Z / +Shift+Z | Undo / Redo |
| Cmd/Ctrl+X / C / V | Cut / Copy / Paste (keyframes if selected, else layers) |
| Cmd/Ctrl+A | Select All |
| Esc | Deselect (or exit camera tool) |
| Cmd/Ctrl+D | Duplicate |
| Backspace / Delete | Delete selected |

### Layers & comps
| Chord | Action |
|---|---|
| Cmd/Ctrl+K | Composition Settings |
| Cmd/Ctrl+Alt+Shift+T | New Text layer |
| Cmd/Ctrl+Y | New Solid |
| Cmd/Ctrl+Alt+Shift+Y | New Null Object |
| Cmd/Ctrl+Alt+Y | New Adjustment Layer |
| Cmd/Ctrl+Shift+C | Pre-compose |
| Cmd/Ctrl+Shift+] / ] / [ / Shift+[ | Bring to Front / Forward / Backward / to Back |

### Tools
`V` Selection · `A` Direct Selection · `W` Rotation · `Y` Pan Behind · `H` Hand ·
`Z` Zoom · `G` Pen · `Q` Rectangle · `Shift+Q` Ellipse · `Ctrl+T` Text ·
`Ctrl+P` Puppet Pin · `Ctrl+B` Bone · `C` Camera tool cycle

### Animation
| Chord | Action |
|---|---|
| F9 | Easy Ease |
| Shift+F9 | Easy Ease In |
| Cmd/Ctrl+Shift+F9 | Easy Ease Out |
| `U` | Reveal keyframed properties |
| `P` / `S` / `R` / `T` / `A` | Reveal Position / Scale / Rotation / Opacity / Anchor |
| Alt+Shift+ P/S/R/T/A | Add a keyframe on that property at the current value |

### Timeline / transport
Home · End · PageUp/PageDown · Shift+PageUp/Down · `J`/`K` · `B`/`N` · `Shift+B` ·
`[`/`]` · Cmd/Ctrl+Shift+D · Cmd/Ctrl+Alt+S — see §10.

### View
| Chord | Action |
|---|---|
| Cmd/Ctrl+Shift+K | Switch theme |
| `` ` `` | Focus the workspace viewport |
| `1` | 3D view: Active Camera |
| `2` | 3D view: last custom view |
| F3 | Graph Editor |
| F6 | (registered view command) |
| Cmd/Ctrl+Alt+M | (registered view command) |
| Shift+G | (registered view command) |

### Viewport (when focused)
Space (hold) = temporary hand · Arrow keys nudge · Delete/Backspace ·
Esc · Alt+drag = orbit/pan/dolly in 3D.

---

## 28. Architecture — how it's built

### Stack
React 18 · TypeScript 5.6 · Vite 5 · Electron 32 · Zustand (+ Immer) state ·
Radix UI primitives · react-router-dom (HashRouter) · better-sqlite3 (local
index) · fflate (zip) · polygon-clipping (path booleans) · Jest + Testing Library.

### Layered layout
```
src/
├── components/   design-system primitives (26 of them: Accordion, AngleDial,
│                 Button, Checkbox, ColorPicker, DockPanel, Dropdown, EmptyState,
│                 ErrorBoundary, Icon, IconButton, Input, Inspector, List, Menu,
│                 Modal, Panel, Popover, ScrollArea, Slider, SplitPane, Switch,
│                 Tabs, Tooltip, TreeView, ValueField, VirtualList)
├── core/         the engines — 40+ domains (ai, animation, api, assets, audio,
│                 collab, commands, composition, dnd, effects, events, export,
│                 files, inspector, layout, library, localIndex, lottie, motion,
│                 paint, particles, persistence, plugins, project, rendering,
│                 rig, scene, services, settings, sync, template, text, theme,
│                 time, timeline, workspace)
├── layout/       the 33 UI regions/panels described above
├── stores/       40 Zustand stores (selection, scene, project, timeline, guides,
│                 ui, layout, history, assets, auth, billing, presentation, …)
├── pages/        Auth · Dashboard · Editor
├── routes/       AppRouter + RequireAuth
├── providers/    Providers.tsx — registers ALL commands & shortcuts at boot
├── plugins/      sample plugins
├── hooks/ utils/ themes/ tokens/ workers/
electron/         main.ts · preload.ts · backend.ts · localIndexDb.ts
packages/         ai-tools · animation · renderer · scene · timeline · workspace
                  · render-tests
```

### The render contract
```
SceneGraph (+ AnimationEngine tracks, at time t)
        ↓ buildSnapshot(t)
   immutable Snapshot  ── the single source of truth for a frame
        ↓
   RenderBackend  ──┬── Canvas2D backend
                    └── GPU backend (WebGL2 / WebGPU)
```

Everything downstream — the viewport, secondary view panes, library card
previews, template previews, offline export, and the golden-frame tests — draws
the *same* snapshot. That's why a preview looks like the export.

**Caveat worth remembering:** Canvas2D previews skip GPU-only effects, and a
`NullBackend` produces no pixels at all — library/template cards therefore draw
through a real Canvas2D backend, not the null one.

### Commands & shortcuts
`Providers.tsx` is the single registration hub (~1200 lines). Each command is
`{ id, label, icon, shortcut, enabled(), execute() }`. The **ShortcutManager**
resolves chords **most-recently-registered first**, which is how the camera
tool's `Esc` wins while active and falls through to Deselect otherwise. The menu
bar, palette and toolbar are all thin renderers over this one registry.

### Events
A typed `EventBus` (`PanelOpened`, `PanelClosed`, `PanelResized`,
`UndoStackChanged`, `AnimationChanged`, `RevealAnimatedProps`, …) decouples the
engines from the UI.

---

## 29. Testing & quality gates

- **Jest** — 235 suites / 2306 tests green as of the last full audit. Unit tests sit next to their modules (`*.test.ts`).
- **Golden-frame render tests** (`packages/render-tests`) — offscreen Electron + SwiftShader renders 89 deterministic scenes and pixel-compares against blessed references. `npm run render-tests`; `--update` re-blesses.
- **Typecheck**: `npm run typecheck`. **Lint**: `npm run lint`.

> **OneDrive gotcha (important):** running `npx jest` directly in the OneDrive
> working copy silently runs only ~2 of the suites, because OneDrive placeholder
> files hide the rest from the resolver. Mirror the repo to local disk for a real
> full run. Likewise, a grep returning zero hits inside OneDrive is not proof of
> absence.

---

## 30. Known gaps / gated features

Honest list of what is *not* done:

| Area | Status |
|---|---|
| Real-time collaboration (live cursors, multi-user editing) | not implemented — comments + review links only |
| Local-first `.motion` chunked bundle + 6-table SQLite | designed in the RFC, **not yet implemented**; engines are frozen pending it |
| ffmpeg bundling for fully offline MP4 | open decision — MP4 currently needs the backend |
| Director-memory placement | open decision in the RFC |
| Template image-swap fields + authoring UI | TODO |
| Motion AI (first-party metered provider) | disabled while in development; BYO-key works |
| GPU per-frame render off the main thread | still main-thread; the offload boundary is identified |
| Panel surfacing in a live Electron session | audited in tests, not live-UI-verified end-to-end |
| `set_expression` under the dev CSP | dev CSP blocks `new Function`; ships through the engine interpreter |

---

## Quick workflow walkthroughs

### A. Build an animated title from scratch
1. Dashboard → **New project**, pick size/fps/duration.
2. Toolbar → **Text tool** (`Ctrl+T`), click the canvas, type.
3. Right inspector → **Style** → set font (FontPicker), size, colour.
4. Top bar → **Animate** → **Rise Up** (or **Typewriter** for a text rig).
5. Timeline: press `U` to reveal the keyframed properties; drag diamonds to retime.
6. Select a keyframe → press **F9** for Easy Ease, or open **Easing** for the big curve editor.
7. **File → Export…** → WebM or MP4 → Full → Export.

### B. Add depth with a camera
1. Select the layer → inspector → **3D Layer** switch on.
2. Insert menu → **Camera** (dialog: preset lens).
3. Press `C` to cycle Orbit → Pan → Dolly and frame the shot; the axis widget shows orientation.
4. Keyframe the camera's position/orientation, or use **Animate → Cinematic Pan 3D**.
5. Insert a **Light**; keyframe intensity for a reveal.
6. `2` switches to a custom view to check the layout in depth; `1` returns to Active Camera.

### C. Let the AI build a scene
1. Left sidebar → **AI Assistant**.
2. Pick a provider/model; set mode to **Manual** for a reviewable preview.
3. Prompt: *"Make a 6-second SaaS product intro with a kinetic title, three feature cards staggering in, and a light sweep."*
4. Watch the plan checklist and pipeline stages; the director calls tools against the live scene.
5. **Apply** (one undo step) or **Decline** (clean rollback).
6. Refine by hand — everything it made is ordinary layers, keyframes and effects.

### D. Rig and animate a logo
1. Import the logo (Assets panel or drag onto the canvas).
2. Command Palette (`Ctrl+Shift+P`) → **Rig Logo for Animation** — flattens a group and drops a starter puppet rig.
3. **Puppet Pin** tool (`Ctrl+P`) → add/move pins; **Rigging** panel tunes mesh density, expansion, per-pin stiffness.
4. Keyframe pin positions across the timeline.
5. Or use the **Bone** tool (`Ctrl+B`) for a skeleton with IK and pose it per frame.

---

*End of guide.*
