# Motion Editor — Complete Project Documentation

**The single canonical document for this project.** If you read only one file, read this one.

| | |
|---|---|
| **Product** | Motion Editor — an AI-native, professional motion design application (an After Effects–class 2D compositor for the web + desktop) |
| **Repo root** | `C:\Users\isroi\OneDrive\Desktop\motion-editor` |
| **Version** | 0.1.0 (private, unlicensed) |
| **Platform** | Web app (Vite dev server) **and** Electron 32 desktop app (Windows/macOS/Linux installers) |
| **Stack** | TypeScript 5.6 (max-strict) · React 18.3 · Zustand 4.5 · Vite 5.4 · Electron 32 · Jest 29 · CSS Modules |
| **Size** | ~65,800 lines of TS/TSX + ~10,800 lines of CSS · 520 source files · 33 core subsystems · 32 Zustand stores · 5 engine packages |
| **Verified status** | `npx tsc --noEmit` → **0 errors** · `npx jest` → **93 suites / 796 tests, all passing** (~28 s) |
| **Doc last verified against code** | 2026-07-15 |

> **Note on the other markdown files in this repo.** `CURRENT_STATE.md` (2026-07-13) is close to accurate but already drifting (it claims 83 suites / 686 tests; reality is 93/796). `PRODUCT.md` and `DESIGN.md` describe *intent* and are good reading, but `PRODUCT.md` still says "Platform: web" despite a complete Electron build. `docs/TECHNICAL_ARCHITECTURE.md` is explicitly a **target blueprint**, not a description of what exists. `CORE_ROADMAP.md` (2026-07-09) is dead — every item is done or deliberately deleted. **This document supersedes all of them.** See §16 for the doc map.

---

## Table of contents

1. [What this project is](#1-what-this-project-is)
2. [Quick start](#2-quick-start)
3. [Repository layout](#3-repository-layout)
4. [Architecture: the big picture](#4-architecture-the-big-picture)
5. [The five engine packages](#5-the-five-engine-packages)
6. [The rendering pipeline](#6-the-rendering-pipeline)
7. [The scene model](#7-the-scene-model)
8. [The animation model](#8-the-animation-model)
9. [Effects and compositing](#9-effects-and-compositing)
10. [Commands, undo, and the event bus](#10-commands-undo-and-the-event-bus)
11. [Export and rendering out](#11-export-and-rendering-out)
12. [The AI system](#12-the-ai-system)
13. [The UI layer](#13-the-ui-layer)
14. [Electron, backend, and persistence](#14-electron-backend-and-persistence)
15. [Using the app: a user's guide](#15-using-the-app-a-users-guide)
16. [Complete keyboard shortcut reference](#16-complete-keyboard-shortcut-reference)
17. [Testing and quality gates](#17-testing-and-quality-gates)
18. [Known gaps, limitations, and gotchas](#18-known-gaps-limitations-and-gotchas)
19. [How to extend the app](#19-how-to-extend-the-app)
20. [Glossary](#20-glossary)

---

## 1. What this project is

Motion Editor is a **professional motion design tool** — the kind of application After Effects, Cavalry, Rive, and Apple Motion occupy. You place layers on a canvas, animate their properties over time with keyframes, composite them with blend modes and masks, and export video.

Three things make it distinct:

**It is AI-native in a specific, non-gimmicky way.** You can type "make the logo slide up and fade in" into the prompt bar at the bottom of the viewport. The AI does not re-author your document as an opaque blob, and it does not generate pixels. It emits **typed operations** (`set keyframe`, `remove keyframe`, `create layer`) which are replayed through *exactly the same reversible command path a human drag uses*. The result is that everything the AI makes is a normal keyframe you can select, drag, re-ease, and undo with `Ctrl+Z`. This is the central architectural promise of the codebase, and it is enforced at the code level: `applyAiOps` → `runAnimEdit` → one entry on the CommandSystem history.

**Its engines are genuinely decoupled.** Five packages under `packages/` (`@motion/scene`, `@motion/renderer`, `@motion/timeline`, `@motion/animation`, `@motion/workspace`) are framework-independent TypeScript libraries. They contain **zero imports of each other** and zero React. They talk through data contracts (DTOs), injected provider functions, and port interfaces. All wiring happens in one place: the app in `src/`. This means the renderer could move WebGL → WebGPU → native without touching the UI, and every engine runs headless in Node (which is why 340 of the 796 tests are pure engine tests with no DOM).

**Precision and reversibility are the top quality attributes.** Not speed, not friendliness. From `PRODUCT.md`: the target user is a professional motion designer with AE muscle memory. Value fields do math. Keyframe edits capture before/after track state so undo moves only the tracks you touched. Offline export uses a fixed timestep (`t = index / fps`) so the same project renders byte-identical frames on any machine.

### Product positioning (from `PRODUCT.md`)

- **Who:** professional motion designers, desktop, pointer + keyboard, AE/Cavalry/Motion/Rive muscle memory.
- **Brand:** powerful, technical, serious. Anti-references: Canva-style consumer apps (too toy) and cluttered legacy pro tools (too hostile).
- **Principles:** restraint · earned density · respect muscle memory · precision and reversibility above all.
- **Accessibility:** colorblind-safe layer hues *always* paired with an icon shape; a full `prefers-reduced-motion` path; WCAG AA as a working floor.

---

## 2. Quick start

### Run the web app

```bash
cd C:\Users\isroi\OneDrive\Desktop\motion-editor
npm install
npm run dev          # → http://localhost:5173  (strictPort: true)
```

The dev server proxies `/api` and `/files` to `http://localhost:4000` (override with `MOTION_API_TARGET`). Everything is same-origin so the `default-src 'self'` CSP holds.

### Run the desktop app

```bash
npm run electron:dev
```

This compiles `electron/` with tsc, starts Vite, waits for `localhost:5173`, then launches Electron pointed at it — all via `concurrently -k`.

### Run the backend (optional but needed for AI, cloud projects, MP4)

The backend is **motion-back**, a separate NestJS + Postgres/Prisma repo expected at `../motion-back` (sibling of this folder). Run it yourself on port 4000:

```bash
cd ../motion-back && npm run start:dev
```

Electron *can* spawn it for you, but only when opted in: `MOTION_LOCAL_BACKEND=1`. (The docblock in `electron/backend.ts` claims the app always owns the server — that comment is stale; `electron/main.ts:185` gates it.)

**The app works fully without the backend.** Without it you lose: login, cloud projects, version history, real AI (it degrades to a deterministic local preset), and MP4 export. Everything else — the whole editor, WebM/GIF/PNG/JSON export — is local.

### Every npm script

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server on :5173 |
| `npm test` | Jest, root config → all 93 suites (packages + src) |
| `npm run typecheck` | `tsc --noEmit` — **root project only**, not packages, not electron |
| `npm run build` | `tsc -b && vite build` → `dist/` |
| `npm run preview` | Serve the built `dist/` |
| `npm run electron:compile` | `tsc -p electron/tsconfig.json` → `dist-electron/` |
| `npm run electron:watch` | Same, in watch mode |
| `npm run electron:dev` | Compile + Vite + Electron, concurrently |
| `npm run electron:build` | `vite build && tsc -p electron/tsconfig.json` |
| `npm run electron:start` | Launch Electron in dev mode (always loads :5173, never `dist/`) |
| `npm run pack` | `electron:build && electron-builder --dir` (unpacked, fast) |
| `npm run dist` | `electron:build && electron-builder` (real installer) |
| `npm run lint` | ⚠️ **Broken** — eslint is not installed and there is no eslint config |

### Environment variables

| Var | Effect |
|---|---|
| `MOTION_API_TARGET` | Vite dev proxy target (default `http://localhost:4000`) |
| `MOTION_BACKEND_PORT` | Backend port Electron probes (default `4000`) |
| `MOTION_BACKEND_ENTRY` | Absolute path to motion-back's `main.js`, overriding discovery |
| `MOTION_LOCAL_BACKEND=1` | Let Electron spawn motion-back itself |
| `VITE_BACKEND_ORIGIN` | Override the backend origin used by the Electron build |
| `NODE_ENV=development` | Makes Electron load `localhost:5173` instead of `dist/index.html` |

---

## 3. Repository layout

```
motion-editor/
├── packages/                    # Framework-independent engines. No React. No cross-imports.
│   ├── scene/                   # @motion/scene     — the object hierarchy (source of truth)
│   ├── animation/               # @motion/animation — keyframes, easing, expressions
│   ├── timeline/                # @motion/timeline  — tracks, layers, clips, playhead, markers
│   ├── renderer/                # @motion/renderer  — WebGPU/WebGL2 render graph
│   └── workspace/               # @motion/workspace — camera, tools, hit-testing, snapping
│
├── src/                         # The application. The ONLY place the engines are wired together.
│   ├── core/                    # 33 non-React subsystems (the app's own domain layer)
│   │   ├── rendering/           # buildSnapshot, RenderBackend port, Canvas2D + GPU backends
│   │   ├── scene/               # SceneGraph façade, 3D, precomps, path ops, repeaters, lights
│   │   ├── animation/           # animationCommands (the reversibility spine), presets
│   │   ├── effects/             # blend modes, masks, mattes, color matrix, motion blur
│   │   ├── export/              # offline renderer, GIF/zip encoders, export manager
│   │   ├── api/                 # motion-back HTTP client, AI edit endpoint
│   │   ├── ai/                  # applyAiOps — turns AI ops into reversible commands
│   │   ├── commands/            # CommandSystem, HistoryService, ShortcutManager
│   │   ├── events/              # EventBus + typed event map
│   │   ├── timeline/            # TimelineController (owns @motion/timeline)
│   │   ├── workspace/           # WorkspaceController (owns @motion/workspace)
│   │   ├── persistence/         # autosave, crash recovery, project serializer
│   │   └── … audio, paint, text, plugins, project, services, settings, theme, files, collab
│   ├── layout/                  # The editor UI: TopNav, Timeline, Inspector, Workspace, panels
│   ├── components/             # Reusable primitives (Button, TreeView, SplitPane, DockPanel…)
│   ├── stores/                  # 32 Zustand stores
│   ├── providers/               # Providers.tsx — boots the whole application
│   ├── routes/ pages/           # HashRouter, auth gate, Dashboard / Editor / Auth pages
│   ├── tokens/ themes/ styles/  # Design tokens + light/dark themes
│   └── plugins/                 # Sample runtime plugins
│
├── electron/                    # main.ts (window, IPC, protocol), preload.ts, backend.ts
├── docs/TECHNICAL_ARCHITECTURE.md   # Aspirational blueprint (target, not reality)
├── CURRENT_STATE.md PRODUCT.md DESIGN.md CORE_ROADMAP.md   # See §16
├── vite.config.ts jest.config.cjs tsconfig.json electron-builder.yml index.html
└── DOCUMENTATION.md             # ← you are here
```

### Path aliases

Declared identically in three places (`vite.config.ts`, `tsconfig.json`, `jest.config.cjs` — **all three must stay in sync**):

`@` → `src` · `@core` · `@components` · `@layout` · `@stores` · `@hooks` · `@styles` · `@tokens` · `@themes` · `@app-types` → `src/types` · `@utils` · `@assets` · `@providers`

and the five engines: `@motion/scene`, `@motion/workspace`, `@motion/timeline`, `@motion/animation`, `@motion/renderer` → `packages/<name>/src/index.ts`.

> **Important:** the `@motion/*` aliases point at **TypeScript source**, not build output. The packages are never built or published — the app's bundler compiles them. There is no npm `workspaces` field; the monorepo is held together purely by path aliases.

---

## 4. Architecture: the big picture

### The layering rule

```
┌──────────────────────────────────────────────────────────────┐
│  src/layout, src/components   — React. Renders. Forwards input.│
├──────────────────────────────────────────────────────────────┤
│  src/stores                   — Zustand. UI state only.        │
├──────────────────────────────────────────────────────────────┤
│  src/core                     — The app's domain layer.        │
│                                 Owns the engines. No React.    │
├──────────────────────────────────────────────────────────────┤
│  packages/@motion/*           — Engines. No React, no app,     │
│                                 no imports of each other.      │
└──────────────────────────────────────────────────────────────┘
        ↑ dependencies only ever point UPWARD in this diagram
```

The engines do not know the app exists. The app adapts them. This is stated in nearly every engine file header and it holds — a grep for `from '@motion/` inside `packages/` returns zero results.

### How five non-communicating engines cooperate

Each engine declares its needs as a **contract** rather than an import:

| Engine | Decoupling device | Who really fulfils it |
|---|---|---|
| `scene` | `SceneEventMap` emitter + `flatProps` schema + `GraphFacade` | the base layer; everyone reads it |
| `renderer` | the `FrameScene` DTO + the `RenderBackend` interface | the app converts scene → FrameScene |
| `timeline` | `ports.ts`: `SourceResolver`, `TimeConsumer`, `TimelineCommandSink`, `TimelineEventForwarder` | the app implements all four |
| `animation` | five injected providers (`setChangeListener`, `setAudioLevelProvider`, `setControlProvider`, `setLayerResolver`, `setBaseValueProvider`) | the app binds them at boot |
| `workspace` | `ports/index.ts`: `SceneGraphPort`, `SelectionPort`, `CommandPort`, `RendererPort` | the app implements all four |

The subtlest link is between `@motion/animation` and `@motion/scene`. Animation stores values keyed by `(nodeId, propPath)` where `propPath` is a plain string like `'x'` or `'opacity'`. Scene ships `DEFAULT_FLAT_SCHEMA` in `interop/flatProps.ts`, which maps exactly those strings onto real node fields. Neither package imports the other; the schema *is* the contract.

### The one data flow that explains everything

```
user input (pointer / keyboard / menu / AI prompt)
   │
   ▼
Command  or  runAnimEdit(label, mutate)          ← the ONLY sanctioned mutation paths
   │
   ├──▶ mutates SceneGraph and/or AnimationEngine
   ├──▶ records ONE reversible entry on CommandSystem history
   │
   ▼
EventBus emits ('AnimationChanged' | 'SceneGraphChanged' | 'NodeUpdated')
   │  and/or sceneStore.bumpScene() increments a revision counter
   │
   ▼
useWorkspace's render closure runs  (pull-based — controller.requestRender(), not a rAF loop)
   │
   ▼
buildSnapshot(graph, anim, t, focus, overlays, view, motionBlur, comp) → RenderSnapshot
   │
   ▼
backend.renderFrame(snapshot)   →  Canvas2DBackend  |  MotionRendererBackend (GPU)
   │
   ▼
renderCache.mark(t)   → the green cache bar under the timeline ruler
```

Everything else in this document is detail hanging off that spine.

### Two fundamental design decisions worth internalising

**1. The renderer is a pure function of an immutable snapshot.** From `RenderBackend.ts`: a snapshot is *"an immutable, fully-resolved description of a frame"* and the backend is *"a PURE function of it."* Backends hold no document authority and no React reference. This is what makes two completely different backends (Canvas2D and a GPU render graph) interchangeable at runtime, and what makes deterministic offline export possible.

**2. Authoring data is the truth; sampled values are derived and disposable.** The `AnimationEngine` **never mutates the scene graph during playback**. Keyframes are the truth; `evaluateNode(id, t)` produces a throwaway `Map` of values that `buildSnapshot` merges over the scene's base values for that one frame. Nothing is ever "baked in."

---

## 5. The five engine packages

All five share the same shape: `"type": "module"`, `main`/`types` → `src/index.ts` (raw TS), `sideEffects: false`, and two scripts (`typecheck`, `test`). Each has its own `jest.config.cjs` and can run standalone.

### 5.1 `@motion/scene` — the scene graph

**Domain:** the single source of truth for the object hierarchy. Pure data + systems. 11 test files, 63 cases.

**Composition over inheritance.** A `SceneNode` (`src/nodes/SceneNode.ts`) is a bag of components. Every node owns a `TransformComponent`; everything else (Fill, Stroke, Text, Media, Camera, Light, Particle, Physics…) is an optional `DataComponent`. New node types are **registered** (`registerNodeType`), never subclassed. There are 17 node factories: `createRootNode`, `createCompositionNode`, `createGroupNode`, `createNullNode`, `createRectangleNode`, `createEllipseNode`, `createPolygonNode`, `createPathNode`, `createTextNode`, `createImageNode`, `createVideoNode`, `createAudioNode`, `createSVGNode`, `createCameraNode`, `createLightNode`, `createComponentNode`, `createParticleNode`.

**`Scene` owns the invariants** (`src/core/Scene.ts`): the root node, a typed event emitter, a `SelectionModel`, and a private `Map<NodeId, SceneNode>` index giving O(1) `find`/`contains` and duplicate-id rejection. All structural mutation funnels through `add`/`insert`/`remove`/`delete`/`move`/`duplicate`.

**Transforms are dirty-flag driven.** `TransformComponent` holds 2D *and* 3D state (`position`, `rotation`, `scale`, `skew`, `anchor`, `size`, plus `positionZ`, `rotationX`, `rotationY`, `scaleZ`, `anchorZ`, `separateDimensions`). Every setter calls `markDirty()`; `getLocalMatrix()`/`getWorldMatrix()` are lazy; `updateWorldTransforms(root)` walks the graph dirty-aware.

**8 events:** `NodeCreated`, `NodeDeleted`, `NodeMoved`, `NodeUpdated`, `ParentChanged`, `SelectionChanged`, `VisibilityChanged`, `TransformChanged`.

**Interop is the interesting part.** Two bridges let consumers who don't speak typed components still participate:
- `flatProps.ts` — `DEFAULT_FLAT_SCHEMA` maps flat animatable names (`x`, `y`, `rotation`, `scaleX`, `opacity`, `fill`, `content`, `fontSize`) to node fields. This is the contract that lets `@motion/animation`'s string `PropPath`s land on real nodes.
- `GraphFacade.ts` — a legacy id-addressed container API over a `Scene`.

**Serialization** is versioned (`SCENE_FORMAT_VERSION = 1`) with a migration registry. Note the trick in `index.ts`: `serialize()`/`toJSON()` are **grafted onto `Scene.prototype` via declaration merging** specifically to avoid an import cycle between `Scene` and `Serializer`.

Performance is tested at 100k nodes.

### 5.2 `@motion/animation` — values over time

**Domain:** keyframe property tracks keyed by `(nodeId, prop)`, interpolation/easing, and JS expressions. 3 test files (colocated, not in `__tests__/`), 78 cases.

**Storage:** two nested maps — `tracks: Map<nodeId, Map<PropPath, PropertyTrack>>` and `expressions: Map<nodeId, Map<PropPath, CompiledExpression>>`.

**Scalar-only by design.** Values are numbers in v1; vectors and colors are represented as *separate scalar tracks*. This is why `buildSnapshot` recombines `fill_r`/`fill_g`/`fill_b`/`fill_a` back into a hex color — an elegant consequence, not a hack.

**`Keyframe` = `{ t, value, easing?, bezier?, roving?, si?, so? }`.** `si`/`so` are **spatial bezier tangents in value space**. When either end of a segment defines one, the value follows a 1D cubic bezier — and because the `x` and `y` tracks share the same eased parameter, the 2D trajectory becomes a true cubic bezier. That is how AE-style **curved motion paths** work here. Temporal easing remaps the segment parameter; it does not change the spatial shape.

**Five injected providers** (each with a no-op default) are the whole decoupling strategy: `setChangeListener` (bound to the app's EventBus at boot; `'*'` = all nodes), `setAudioLevelProvider` (backs the `audio` expression accessor), `setControlProvider` (backs `ctrl(name)` slider rigs), `setLayerResolver` (layer *name* → nodeId, since the engine doesn't know scene names), `setBaseValueProvider` (a node's static value when a cross-layer read finds no track).

**Atomic capture/restore is the basis of precise undo:** `getTrackKeyframes(nodeId, prop)` deep-copies one track; `setTrackKeyframes(...)` restores it. The command layer diffs before/after arrays of *only the touched tracks*.

**Expression sandboxing is the most carefully engineered part.** Expressions compile once via `new Function` — safe because it is the user's own formula on their own machine (this mirrors AE's model). The curated API is `time, value, audio, ctrl, wiggle, clamp, linear, random, Math, valueAtTime, layer, layerAt, loopOut, loopIn`. Two structural guarantees:
- `selfAt` samples the property's **keyframes only, never the expression** — so `valueAtTime`/`loopOut`/`loopIn` cannot recurse through the expression itself.
- `crossLayerValue` caps depth at 1 and **never evaluates the referenced layer's expression** — making chains and self-reference cycles structurally impossible.

Noise is deterministic (`hash01` uses `Math.sin(n * 127.1) * 43758.5453`, never `Math.random`), so playback is reproducible. Editor support ships too: `tokenizeExpression` for highlighting, `matchBracket`, `EXPRESSION_API` for autocomplete, and `suggestExpression(intent)` — which is explicitly *a small local heuristic, not a hosted model*, and always returns editable text.

**Roving keyframes:** a maximal run of `roving` keyframes bounded by two non-roving anchors is retimed so each sits at the fraction of the time span equal to its cumulative |value| distance from the start anchor — i.e. the value moves at constant speed through them.

### 5.3 `@motion/timeline` — temporal data

**Domain:** tracks, layers, clips, markers, playhead, ranges, selection, navigation, with its own undo history. 6 test files, 57 cases.

```
Timeline
├── frameRate, duration, playhead, selection, ranges (loop/preview/workArea), view
├── markers
└── tracks[]                    ← ordered lanes
    ├── flags (locked/hidden/muted/solo), kind, groupId, markers
    └── layers[]                ← ordered stack
        ├── clip (start/duration/sourceIn/sourceDuration)   ← trim/split geometry
        ├── sourceId → a @motion/scene node id
        └── markers (relative)
```

**The canonical unit is frames** (integer normally, fractional during smooth playback). `time/Time.ts` converts to ms/seconds/SMPTE timecode for any rate; `FrameRate` supports 23.976/24/25/29.97/30/60/120 with drop-frame.

**Timer-free playback.** `play()`/`pause()`/`stop()` only set state. An external clock advances via `tick(dtMs)`. This is what keeps the engine independent of any host loop — and it's why the app owns `usePlaybackClock`.

**Undoable by construction.** Every structural mutation routes through a local `History` of `Command { label, do(), undo() }`.

**Scale:** O(1) id lookups for tracks/layers, O(log n) marker queries via binary search (`lowerBound`/`upperBound`/`insertSorted`). Tested with thousands of tracks/layers/markers.

**22 typed events**, including `LayerTrimmed`, `LayerSplit`, `PlayheadMoved`, `RangeChanged`, `TimelineZoomChanged`.

`ports.ts` documents the four intended seams to siblings — notably `TimeConsumer.onCurrentTimeChanged`, which is the timeline → animation link, and `SourceResolver`, which lets trims be bounded by a media asset's real duration.

### 5.4 `@motion/renderer` — the GPU render graph

**Domain:** backend-abstracted GPU rendering. WebGPU primary, WebGL2 fallback, Null for headless/tests. It renders a `FrameScene` and nothing else. 9 test files, 56 cases — all headless against `NullBackend`.

```
        Renderer  (façade, lifecycle, viewports)
           │ depends on ▼  (never imports a concrete backend)
      RenderBackend ── WebGPUBackend | WebGL2Backend | NullBackend
           ▲
   ResourceManager · ShaderCache · MaterialSystem · RenderGraph · QuadRenderer
```

**The backend seam** (`gpu/RenderBackend.ts`) is the one dependency-inversion point: resource creation (buffers, textures, samplers, shaders, pipelines, bind groups, render targets) + frame lifecycle (`beginFrame`, `beginRenderPass`, `endFrame`, `present`, `resize`, `dispose`). Only three files in the entire package speak WebGPU/WebGL.

**The render graph** (`rendergraph/RenderGraph.ts`): passes declare `reads`/`writes`/`after`; the graph builds a producer map, links data and explicit edges, and topologically sorts with **Kahn's algorithm using insertion-order tie-breaking for determinism**. Cycles throw. Compilation is memoized and invalidated on change. `declareTarget(name, fn)` registers transient targets resolved per-frame and deduped by name+size.

`buildDefaultGraph()` registers seven passes: `ClearPass` → `BackgroundPass` → `CompositionPass` → `SelectionPass` → `OverlayPass`, plus `MaskPass` and `EffectPass` (both **disabled** by default). Five transient targets are declared: `MASK_TARGET`, `SCENE_COLOR_TARGET`, `LAYER_TARGET`, `BLUR_TARGET1`, `BLUR_TARGET2`.

> **Dead code worth knowing about:** `ShapePass.ts`, `ImagePass.ts`, `VideoPass.ts`, `TextPass.ts` still exist on disk but are neither re-exported from `passes/index.ts` nor added to the default graph — the monolithic `CompositionPass` superseded them. Consequently `SelectionPass.after = ['text']` and `EffectPass.after = ['text']` are dead links that silently fall back to insertion order.

**Dynamic pass toggling:** `Renderer.renderViewport` reads `scene.hasEffects` each frame, flips `effectPass.enabled`, retargets it between `SCENE_COLOR_TARGET` and `SURFACE`, and invalidates the graph — so the graph literally recompiles when a scene starts or stops needing post-processing.

**Resources** (`ResourceManager`) use a keyed pool per kind with LRU garbage collection: `acquire(key, frame, create, pinned)`, then `collect(frame, maxIdle)` auto-disposes anything idle past a frame window. Dedup by key means no duplicate GPU allocations.

**Shaders** in `shaders/builtin.ts` each ship **both** WGSL and GLSL ES 300 sources: `solid`, `textured`, `masked-textured`, `blur`, `gradient-ramp`, `fractal-noise`, `displacement-map`, `motion-tile`.

**The input contract** (`scene/FrameScene.ts`) is a flat, **paint-ordered** `Renderable[]` with world matrices already resolved. Each carries `modelMatrix` (unit quad → world), `bounds` (culling), `opacity`, `blend`, and optionally `color`, `sdf` (`rounded`|`ellipse` — real geometry, not flat quads), `colorMatrix`, `effects`, `textureKey`, `uvRect`, `clip`, `maskId`. This DTO is precisely what keeps the renderer from importing `@motion/scene`.

### 5.5 `@motion/workspace` — interaction

**Domain:** everything between the user and the graph — viewport, camera, coordinates, tools, input, selection, hit-testing, grid, guides, snapping. It coordinates; it never draws and never mutates the graph directly. 10 test files, 86 cases.

```
host events ─▶ InputSystem ─▶ ToolManager ─▶ tools ─▶ commands / camera
                                   │
   Workspace ◀── subsystems (camera, selection, guides…) ─▶ events + overlay
```

**Four ports** (`ports/index.ts`): `SceneGraphPort` (read-only node views + change subscription), `SelectionPort` (**the app owns selection truth**; the workspace drives it so undo and scripting stay consistent), `CommandPort` (the workspace *submits* intents; it never keeps history), `RendererPort` (told *what* to repaint, never *how* the user interacts).

**Twelve subsystems**, all owned by the `Workspace` class as readonly fields: `viewport` (DPR/high-DPI aware), `camera` (pan/zoom-to-cursor/fit/selection), `animator` (eased center + **log-space zoom** tweens), `coordinates` (screen ⇄ viewport ⇄ world ⇄ parent ⇄ local), `grid` (infinite, adaptive **1-2-5** spacing), `guides`, `snap`, `hitTester`, `selectionController`, `cursor` (base + a transient override *stack*), `input`, `tools`.

**Hit testing = quadtree broad-phase + precise narrow-phase.** `SpatialIndex` is built for 100k+ nodes; `HitTester` resolves overlaps by z-priority and delegates to each node's `hitTestLocal` for the precise test.

**Tools are pluggable state machines.** `Tool` is an all-optional-hooks interface; `ToolContext` defines exactly what a tool may touch (`selectionIds`, `screenToWorld`, `requestRender`, `setSnapLines`, `setTool`, `execute`, `buildSnapTargets`, `snapRect`). `ToolManager` supports `pushTemporary(id)`/`popTemporary()` — that's how hold-Space-for-Hand works. 15 built-in tools: Select, DirectSelection, Move, Hand, Zoom, Rectangle, Ellipse, Polygon, Star, Line, Pen, Pencil, Curvature, Text, Camera.

**Six command intents:** `workspace.moveNodes`, `resizeNode`, `rotateNode`, `createNode`, `deleteNodes`, `updateNodePath`.

**In-memory adapters ship in the public API** (`adapters/memory.ts`: `MemoryScene`, `MemorySelection`, `RecordingCommandPort`) — a faithful port triple that makes the whole engine runnable headless in Node. Missing renderer/commands fall back to no-ops, so `Workspace` runs with no host at all.

> **Known gap:** `MaskRectangleTool` and `MaskEllipseTool` are defined and exported from `tools/index.ts` but **not re-exported from the package barrel** — they're unreachable to anyone importing from `@motion/workspace`.

---

## 6. The rendering pipeline

This is the heart of the app. Read this section twice.

```
SceneGraph + AnimationEngine + time t
        │
        ▼  buildSnapshot()                     src/core/rendering/buildSnapshot.ts
   RenderSnapshot { width, height, background, transparent, time, layers[], overlays, view }
        │
        ▼  RenderBackend port                  src/core/rendering/RenderBackend.ts
        │
   ┌────┴──────────────────────────────┐
   ▼                                   ▼
Canvas2DBackend                 MotionRendererBackend
(THE reference backend,         (GPU, opt-in, behind on features)
 default, feature-complete)             │
                                        ▼ snapshotToFrameScene()
                                   FrameScene DTO → @motion/renderer
                                   (Renderer + Viewport + WebGL2/WebGPU/Null)
```

### 6.1 The snapshot types (`RenderBackend.ts`)

- `LayerKind = 'shape' | 'text' | 'image' | 'video'`
- `RenderLayer` — ~50 fields, grouped:
  - **Identity/compositing:** `id`, `kind`, `blend?`, `mask?`, `matte?`, `isMatteSource?`, `isAdjustment?`
  - **Structure:** `precompLayers?: ReadonlyArray<RenderLayer>` (nested comp), `light?: { color, intensity, radius }`
  - **Transform:** `x`, `y` (**center** position, comp space), `rotation` (degrees), `scaleX/scaleY`, `anchorX?/anchorY?`, `matrix?: [a,b,c,d,e,f]` (**present for 3D layers; when set it supersedes the scalars for drawing**), `depth?`
  - **Paint:** `opacity` (0..1), `width`, `height`, `fill`, `fillPaint?`, `stroke?`, `visible`
  - **Shape:** `primitive?: 'rect'|'ellipse'|'path'`, `cornerRadius?`, `pathPoints?`, `pathOpen?`, `trim?`
  - **Text:** `text?`, `fontSize?`, `fontFamily?`, `fontWeight?`, `fontStyle?`, `letterSpacing?`, `lineHeight?`, `align?`, `glyphs?`
  - **Effects/media:** `filter?` (CSS string, for Canvas2D), `effects?` (structured, for GPU), `src?`, `assetId?`, `motionSamples?`
- `RenderView` — `{ scale, offsetX, offsetY }`, defining `canvasPx = compPx * scale + offset`
- `RenderSnapshot` — `{ width, height, background, transparent?, time?, layers, overlays?, view? }`
- `RenderBackend` — `kind`, `attach(canvas)`, `resize(w, h, dpr)`, `renderFrame(snapshot)`, `setPreviewChrome?(on)`, `dispose()`, `readyPromise?`

`setPreviewChrome` is the **preview/export seam**: it enables the float shadow and transparency checkerboard. It is left off for export so transparent comps yield real alpha.

### 6.2 Backend selection (`createRenderBackend.ts`)

`BackendChoice = 'canvas2d' | 'webgl2' | 'webgpu' | 'null' | 'auto'`.

Resolution order: **explicit argument › the `rendering.backend` setting › Canvas2D**. `'auto'` probes: `'gpu' in navigator` → webgpu; `WebGL2RenderingContext` in window → webgl2; else canvas2d. The whole read is wrapped in try/catch so tests with no SettingsManager fall through to the default.

Design intent, verbatim: *"Defaults to Canvas2D so nothing changes unless the user opts in — the GPU path is additive."*

There is a second, live path: `useWorkspace` reads `useRenderBackendStore(s => s.choice)` and passes it explicitly, with `backendChoice` in the effect's dep array — so flipping the store **rebuilds and re-attaches the backend live**. (Note: `useRenderBackendStore` is primarily a developer/testing seam; the UI does not expose a renderer toggle.)

> **There is deliberately no CPU/GPU toggle in the UI.** This was built, then removed on purpose: AE exposes one renderer (GPU acceleration is automatic with silent CPU fallback), never a toolbar switch. The model is *one engine*: Canvas2D is the engine today; the GPU path becomes the engine automatically once it reaches parity.

### 6.3 `buildSnapshot` — the single most important function (674 lines)

```ts
buildSnapshot(
  graph: SceneGraph,
  anim: AnimationEngine,
  t: number,
  focus?: SnapshotFocus,
  overlays?: RenderOverlays,
  view?: RenderView,
  motionBlur?: MotionBlurConfig,
  comp: SnapshotComp = DEFAULT_COMP,
): RenderSnapshot
```

Execution order:

1. `flattenScene(graph)`; `anySolo = nodes.some(n => n.solo)` — **AE solo semantics**: if anything is soloed, only soloed layers render.
2. Build `nodeById` + a `worldCache: Map<string, Matrix2D>`.
3. **`remapOf(id)`** — composes *three independent time remaps* into one `(t) => t'`:
   - timeline clip retime (`clip.sourceFrameAt(frame) / fps`)
   - per-layer time (`readNodeLayerTime` → stretch / reverse / freeze)
   - precomp time remap — if the nearest precomp root has a keyframed `precompTime`, sample it. *The group's own animation stays on comp time; only its nested content remaps.*
4. `valuesOf(id)` — memoized `anim.evaluateNode(id, remapOf(id)(t))`.
5. `worldTransformOf(...)` for parenting, memoized in `worldCache`.
6. **Precomp routing** — layers are routed into their nearest precomp's inner array, recursively emitting containers so nesting works.
7. **Camera** — `'front'` → default orthographic-ish camera; else `readSceneCamera(graph, w, h, sample)` (animatable).
8. **Per-node loop.** For each node:
   - skip structural kinds (`group`, `null`, `camera`, `audio`)
   - **in/out gate:** if the node has timeline clips and none is active at `gateFrame`, skip. The gate frame clamps to `lastFrame = round(duration*fps) - 1` *so a full-length layer doesn't blink out at the exactly-end playhead* (clip spans are end-exclusive).
   - `light` → emit a comp-sized carrier layer with `light: {...}`, continue
   - `readBase(node)` scans components for `x/y/rotation/opacity/scaleX/scaleY/scale/fill/content/fontSize/…`; opacity is `/100`
   - resolve effects **once** into both a CSS `filter` (Canvas2D) and structured `effects` (GPU)
   - **3D projection:** compose a `Matrix4`, project three points (origin + unit X + unit Y) through the camera, derive the 2×3 affine `matrix = [ax, ay, cx, cy, O.x, O.y]`. *Z-rotation, xy-scale, z-depth (scale + parallax) and tilt all fall out of it.* `depth = O.depth`.
   - auto-orient (2D only), animated paint recombination (`fill_r/g/b/a` → hex), anchor, path operators, trim path, motion blur sampling, text animators, repeater copies
9. **3D depth sort** — farthest-first, but **only when 3D and not order-dependent**. Mattes and adjustment layers rely on list order, so sorting is skipped when any are present.
10. `resolveMatteSources(layers)` — resolves explicit `sourceId` mattes (matching AE 23+ semantics) and flags `layers[i].isMatteSource = true` on the referenced layer.

`SIZE: Record<LayerKind, {w,h}>` (shape 220×220, text 320×80, image 280×180, video 480×270) is *shared with the Workspace interaction engine so hit-testing and selection overlays match what's drawn.*

### 6.4 `Canvas2DBackend` — the reference backend (821 lines)

This is the default and the most complete implementation. It does real offscreen precomp compositing, mattes via `scratchA`/`scratchB` + `lumaToAlpha`, adjustment layers, lights (screen-blend radial gradient), gradients, strokes, trim paths, and glyph-level text animators. It caches images and video elements.

### 6.5 The GPU path

`MotionRendererBackend` owns a `@motion/renderer` `Renderer` + `Viewport` + GPU backend. **Its central design problem is an async seam**: the renderer initialises asynchronously (WebGPU especially) while the port's `attach()`/`renderFrame()` are synchronous. Solution: init in the background, coalesce frames requested before the device is ready into a single `pending` snapshot, flush on ready. On init failure it warns, disposes, and stays not-ready — *"the surface simply shows nothing rather than throwing into React's render loop."*

`snapshotToFrameScene` is the pure adapter. Its notable parts:
- **Center-pivot fix** — the renderer maps a unit quad `[0,1]²`, so every model matrix is post-multiplied by `translation(-0.5, -0.5)`.
- **Motion blur** — `snapshotToFrameScene` currently drops `motionSamples`, so GPU motion blur is unimplemented.
- `layerBlendToGpu` narrows the full 17-mode AE set to the GPU union with family fallbacks (`color-dodge→screen`, `hard-light→overlay`, HSL modes→`normal`). **Kept in sync with `gpuSafe` in `blendMode.ts` by comment only, not by types.**
- `viewToCamera` — the algebra is documented inline: Canvas2D is `canvasPx = compPx·scale + offset`, Camera2D is `screenPx = (world − center)·zoom + viewport/2`, therefore `zoom = scale` and `center = (viewport/2 − offset)/scale`.
- `flattenLayers` skips `!visible`, `isMatteSource`, `isAdjustment`, and **`layer.light`** — that last skip is load-bearing: *"Without this skip the light's carrier layer (a full-comp black shape) rasterized as an opaque black rectangle over the frame."*

`AppTextureProvider` resolves `textureKey` → GPU texture. Renderer passes call `get(key)` **synchronously mid-frame** while decode is async, so: (1) the backend feeds sources each frame via `setImage`/`setText`/`setVideo`; (2) `get()` returns the decoded texture **or a shared 1×1 white placeholder** so a box still shows while loading and no textured layer ever silently vanishes; (3) decode completion flips the entry and fires `onChange`, which emits `AnimationChanged` with the sentinel `nodeId: '__texture__'` to force a repaint.

Texture key namespaces: `asset:<id>` (images/video), `text:<id>` (rasterized text), `path:<id>`, `mask:<id>`.

**GPU content parity is complete for shapes (with real rounded-rect/ellipse SDF geometry), images, text, and video, plus full color grading** (affine color effects composed into one 3×3 matrix + offset — applied CPU-side for solids, per-pixel in the textured shader otherwise). See §18 for what's still missing.

### 6.6 `renderCache`

`BUCKET = 1/30`. `mark(t)` on every rendered frame; `ranges()` merges buckets into contiguous second-ranges to feed the **green cache bar** under the timeline ruler. Any animation change invalidates the whole cache.

---

## 7. The scene model

### 7.1 The `SceneGraph` façade

The app's `SceneGraph` (`src/core/scene/SceneGraph.ts`) is **a façade over `@motion/scene`'s `Scene`, which is the single source of truth. There is no duplicated node copy.**

Each app node *is* an engine node. Each app component lives in the engine's generic bag as a `DataComponent` (`type` + `data`, with the original component id preserved under `__cid`). `getNode()` returns a cached **live view** (`AppNodeView`) that reconstructs the loose shape on demand, with field writes proxying back to the engine.

Reserved keys: `__kind`, `__cid`, `transform`.

Kind → engine type: `group→group`, `null→group`, `shape→rectangle`, `text→text`, `image→image`, `video→video`, `camera→group`, `light→group`, `adjustment→rectangle`.

### 7.2 The `fx` component pattern

A private `setFx(nodeId, key, value)` backs a whole family of setters that all write onto **one `fx` DataComponent** created on demand: `setEffects`, `setBlendMode`, `setMask`, `setMaskAnim`, `setMatte`, `setAdjustment`, `setMotionBlur`, `setAutoOrient`, `setRepeater`, `setTrimPath`, `setPathOp`, `setPrecomp`, `setFill`, `setStroke`, `setSolid`, `setLayerTime`, `setLayerStyles`.

The rationale recurs in every consumer file: *"stored on an `fx` component so History, autosave, and export capture them for free."* This is a genuinely good pattern — one storage decision buys persistence for seventeen features.

### 7.3 Node kinds

`shape`, `text`, `image`, `video`, `group`, `null`, `camera`, `light`, `audio`, `adjustment`.

`sceneDerive.ts` maps each to a timeline stripe color (`KIND_COLOR`), a raw hex canvas fill (`KIND_FILL` — *canvas `fillStyle` cannot resolve CSS `var(...)`*), and an icon. **Purple is never used for a layer kind — it is reserved exclusively for AI**, so groups map to Null slate.

### 7.4 Transforms and parenting

`worldTransform.ts`: `localMatrix(l)`, `matrixToLocal(m)`, memoized `worldMatrixOf` (= `parentWorld · local`), and `localUnderParent(childWorld, parentWorld)` (= `inverse(parentWorld) · childWorld`, for reparent-without-moving).

**Documented approximation:** the decomposition folds any shear from a rotated + non-uniformly-scaled parent back into translate/rotate/scale, because the renderer draws in TRS. Exact for common cases; an acknowledged approximation otherwise.

`setParent` deliberately does **not** touch the transform — callers that want "reparent without moving" compensate explicitly.

### 7.5 3D

`THREE_D_PROPS = ['z', 'rotationX', 'rotationY']`. `is3DEnabled(node)`, `set3DEnabled(nodeId, on)`.

The elegance is worth stating: *once those props are present they behave like any other numeric prop — the inspector renders a keyframeable, undoable row for each automatically, so 3D values animate through the exact same command path as x/y/rotation.* No special-casing anywhere.

`camera3d.ts` gives `readSceneCamera(graph, w, h, sample)` — the first Camera layer if present, else a default framed to the comp; `sample` makes it animatable.

### 7.6 Precomps, lights, and the rest

- **Precomps** (`precomp.ts`) — a precomp is a subtree of the scene tree, so it is **cycle-safe by construction: it can never contain itself.** `nearestPrecompRoot(node, nodeById)` drives snapshot routing.
- **Lights** (`light.ts`) — color from the Style fill; intensity/radius are numeric props so the inspector keyframes them for free. Scope is stated honestly: *"True 3D material-response lighting is out of scope for a 2D compositor."* A light renders as a radial warm gradient with screen blend.
- **`sceneInsert.ts`** (571 lines) — `duplicateSelectedLayers`, `deleteSelectedLayers`, `toggleSelectedLocked`, `toggleSelectedSolo`, `groupSelectedLayers`, `ungroupSelected`, `precomposeSelected`.
- **`pathOps.ts`** — zig-zag, round, **pucker/bloat**, **twist**. `shapeOutline` takes a `subdivide` param so a rect gets 8 points per edge for pucker/twist, which makes them deform smoothly rather than just moving corners.
- **`trimPath.ts`**, **`repeater.ts`**, **`alignNodes.ts`**, **`anchor.ts`** (pan-behind: set anchor + shift x/y by `R·S·Δanchor` so the layer stays put), **`autoOrient.ts`**, **`layerTime.ts`** (stretch/reverse/freeze + frame blending), **`labelColor.ts`**.
- **Seeds:** `seedDefaultScene.ts`, `seedComplexShowcase.ts`, `seedSaaSAd.ts` — loadable from the **Examples** menu.

---

## 8. The animation model

### 8.1 The reversibility spine — `animationCommands.ts`

Read this file's header if you read nothing else in `src/core`:

> *"Every user- or AI-authored change to the AnimationEngine flows through here so it becomes a single, undoable transaction on the CommandSystem history — the promise the app makes ('everything AI generates stays editable and reversible') made literal."*

The model: a command captures the affected property tracks' keyframe arrays **before** and **after** the mutation and swaps between them. It is precise — only the touched tracks move — *"the opposite of the coarse whole-document history snapshot."*

Two entry points:

```ts
runAnimEdit(label, mutate, mergeKey?)   // snapshot → mutate → diff → record ONE command
beginAnimEdit()  /  commit(label)       // for pointer drags that mutate on every move;
                                        // records a single command on release
```

`mergeKey` coalesces a whole drag into one undo step — e.g. motion-path drags use `` `mpdrag:${nodeId}:${t}` ``.

**Rule for contributors: anything that touches animation must go through `runAnimEdit` or `beginAnimEdit`/`commit`. Direct engine mutation is not undoable.**

### 8.2 Easing

`EasingKind = linear | step | ease | easeIn | easeOut | easeInOut | bezier | hold`.

`cubicBezierEase([x1,y1,x2,y2], x)` solves `x(s) = x` by Newton's method then returns `y(s)` — matching CSS `cubic-bezier` semantics exactly. Presets: `EASY_EASE_BEZIER = [1/3, 0, 2/3, 1]`, `EASY_EASE_OUT_BEZIER = [0, 0, 2/3, 1]`, `EASY_EASE_IN_BEZIER = [1/3, 0, 1, 1]`.

`sampleSpeed(track, t, dt = 1/240)` is a symmetric finite difference — it feeds the Graph Editor's Speed tab.

### 8.3 Motion paths

`src/core/motion/motionPath.ts` — `motionPathSamples`, `motionPathKeyframes`, `motionPathTangents`, `setPathTangent(nodeId, t, part, pos, mirror)`, `smoothMotionPath`, `autoOrientAngleDeg`. Everything is in composition/world space; the overlay converts to screen via the camera.

The on-canvas motion path is **directly editable**: drag a keyframe point to retime/move it, drag a tangent handle to reshape the curve, hold **Alt** to break the tangent pair. `useWorkspace` intercepts these before the engine sees the pointer event, precisely so a path drag can't also move or marquee the layer.

### 8.4 Time remapping — three layers that compose

1. **Clip retime** — from the timeline engine (trim/split geometry).
2. **Layer time** — stretch, reverse, freeze (`remapTime(t, cfg, span)`).
3. **Precomp time** — a keyframed `precompTime` on a precomp root remaps only its nested content.

They compose in `buildSnapshot.remapOf` into a single `(t) => t'` per node.

---

## 9. Effects and compositing

| Feature | File | Notes |
|---|---|---|
| **Effect stack** | `effects/effects.ts` | `Effect { id, type, amount, enabled? }`. Compiles to a CSS `filter` for Canvas2D; stack order preserved because filters compose left-to-right. |
| **Keyframeable effect params** | same | `effectPropPath(id)` → `'effect.fx_3'`. `buildSnapshot` samples it per frame, so **effect amounts animate through the same reversible keyframe path as transforms** (AE Effect Controls stopwatches). |
| **Blend modes** | `effects/blendMode.ts` | **17 of AE's ~38 modes** in AE menu order, grouped by family, each flagged `gpuSafe`. `blendToComposite` maps to Canvas2D (`add` → `lighter`). |
| **Color matrix** | `effects/effectColorMatrix.ts` | The insight: brightness/contrast/saturate/grayscale/sepia/hue-rotate/invert are all **affine color transforms**, so they compose into ONE 3×3 matrix + offset. The GPU path can't use CSS filters, so it applies this instead — CPU-side for a solid color, per-pixel in a shader for textures. Matrices match CSS filter semantics exactly and are unit-tested against known values. |
| **Masks** | `effects/mask.ts` | Modes `add`/`subtract`/`intersect`. Coordinates are layer-**local centred** space `[-w/2..w/2]` so a mask composes cleanly with the layer transform. **Animatable**: `interpolateMask` lerps paired points; a path whose point count differs between keyframes snaps to the nearer keyframe (no vertex-count morph). |
| **Mattes** | `effects/matte.ts` | `alpha` / `luma` / `alpha-inv` / `luma-inv`. Supports both explicit layer targeting (AE 23+) and Preserve Underlying Transparency (`matte: 'preserve-alpha'`). The matte source layer is consumed, not drawn. Canvas2D composites via offscreen buffers. |
| **Adjustment layers** | `effects/adjustment.ts` | The effect stack applies to the composite of everything beneath it within the composition. |
| **Motion blur** | `effects/motionBlur.ts` | Multi-sample accumulation. Shutter interval = `shutterAngle/360` of one frame (180° = half a frame, AE convention). **Two-level gate: the composition enables it AND each layer opts in.** Deterministic sample times. |
| **Layer styles** | `effects/layerStyles.ts` | Drop shadow + outer glow; both compile to `drop-shadow()`. |
| **Paint** | `paint/fill.ts`, `stroke.ts` | Solid / linear / radial fills with color stops; gradient geometry is layer-local relative. |
| **Text animators** | `text/textAnimators.ts` | AE-style range selectors: `characters`/`words`/`lines` × `square`/`rampUp`/`rampDown`/`triangle`/`round`/`smooth`. Group metadata lives as a hidden `__animators` array; each numeric parameter is keyframeable via `animatorPropPath(index, param)`. Output is `glyphs: GlyphTransform[]` on the RenderLayer. |

---

## 10. Commands, undo, and the event bus

### 10.1 Commands

> *"Commands are the only sanctioned way to mutate application state from user input (menus, shortcuts, context menus, scripts)."*

`Command { id, label, description?, icon?, enabled?(), isChecked?(), shortcut?: KeyChord, execute(ctx), undo?(ctx) }`. Properties: engine-agnostic (no React/DOM inside `execute`), **idempotent registration** (re-registering an id replaces it), undo/redo capable, observable.

`CommandSystem` is the only sanctioned entry point for *executing*: resolve by id/shortcut → build a `CommandContext` → execute, capturing undoables → emit feedback on the event bus. *"This is the layer that knows about Application. Commands themselves never do."*

`HistoryService` maintains two stacks. A command participates in undo only if it provides `undo()`. It is engine-agnostic — it does not know what state commands mutate. Notable methods: `jumpTo(index)` (**non-linear history navigation**, which is what powers the Photoshop-style History panel), `withSuppressed(fn)` (run without recording — how undo/redo avoid re-recording themselves), `setLabel(i, label)` (rename a history entry).

`ShortcutManager` installs **one window-level capture-phase keydown listener**. Components never register shortcuts; commands declare their chord in metadata. Key behaviors: exact chord match, most-recently-added wins, **disabled commands let the chord fall through** (so Esc can close a menu), inputs/textareas/contentEditable are ignored, and dispatch is by `commandId` not by chord — so user rebinds resolve correctly. `shortcutOverrides.ts` persists user remaps (`null` = disabled) with pure-function conflict detection.

### 10.2 The two undo systems (important)

| | Coarse | Fine |
|---|---|---|
| Where | `stores/historyStore.ts` | `core/animation/animationCommands.ts` + CommandSystem |
| Granularity | whole-document snapshot | before/after keyframe arrays of only touched tracks |
| Entry | debounced (700 ms) on `AnimationChanged`/`NodeUpdated`/`SceneGraphChanged` | `runAnimEdit` / `beginAnimEdit`+`commit` |
| Role today | secondary snapshot / crash-recovery layer | **the real undo stack** — what Ctrl+Z, the toolbar, and the History panel use |

They coexist. Anything touching animation should use `runAnimEdit`.

### 10.3 The event bus

`EventBus` (`on`/`emit`/`off`/`clear`) is independent from React — engines can publish and subscribe without depending on the UI. Event names are PascalCase, past-tense.

Groups: **Lifecycle** (`ApplicationReady`, `ApplicationShutdown`) · **Workspace** (`WorkspaceChanged`, `WorkspaceFocused`, `WorkspaceBlurred`) · **Panels/layout** (`PanelOpened`, `PanelClosed`, `PanelFocused`, `PanelResized`, `PanelMoved`, `PanelDocked`, `PanelUndocked`, `LayoutChanged`, `ThemeChanged`) · **Project** (`ProjectLoaded`, `ProjectUnloaded`, `ProjectSaved`, `ProjectDirtyChanged`) · **Selection** (`SelectionChanged`) · **Scene** (`SceneGraphChanged`, `NodeUpdated`) · **Animation** (`AnimationChanged { nodeId? }`) · **Timeline** (`TimelineFocused`, `TimelineBlurred`, `TimeChanged`, `PlayStateChanged`) · **Undo** (`UndoStackChanged`) · **Engine** (`EngineReady`, `EngineError`).

**`AnimationChanged` is the load-bearing event.** It is emitted by `AnimationEngine.notifyChange` (bound at boot), consumed by `useWorkspace` to request a render, and used to invalidate `renderCache`. It is also *synthesized* by `MotionRendererBackend` with the sentinel `nodeId: '__texture__'` to force a repaint when an async texture decode lands — a slight abuse of the event's semantics, but a documented one.

### 10.4 Boot order (`Application.ts` + `Providers.tsx`)

1. Apply persisted preferences to the document (theme, UI scale, reduce-motion)
2. Service container (DI)
3. EventBus
4. CommandRegistry + CommandSystem
5. ShortcutManager
6. Register built-in + project commands and default panels
7. Wire ThemeManager + ProjectManager into the UI
8. Mount global overlay hosts (modals, context menus, notifications)
9. Wire autosave, crash-recovery prompt, renderCache, plugin host, onboarding

---

## 11. Export and rendering out

### 11.1 Determinism

From `offlineRenderer.ts`, verbatim:

> *"Replaces realtime MediaRecorder sampling (which drops frames and is non-reproducible) with a fixed-timestep loop: every frame's time is `index / fps` exactly, so the same project always renders byte-identical frames regardless of machine speed (assuming the same fonts and platform text rasterizer)."*

`renderOffline(params, onFrame, signal?)` creates an offscreen canvas, builds a backend, **awaits `backend.readyPromise`** (the GPU async seam), loops the frame range checking `signal?.aborted` (throwing `AbortError`), and yields between frames so progress paints and cancellation can interrupt. `backend.dispose()` in `finally`.

`exportView(outW, outH, comp?)` does an **exact fit-contain**. There's a bug-fix comment worth preserving: the backend's implicit fallback fit insets by 8% (preview "float" framing), *which exported every frame with a border.*

### 11.2 Formats

| Format | How | Server needed? |
|---|---|---|
| **WebM** | Offline frames → dedicated capture canvas → `captureStream(0)` + `requestFrame()` per frame → MediaRecorder VP9 @ 10 Mbps. Honest caveat: content is fixed-timestep so frames are reproducible; the *container* is paced by wall-clock. | No |
| **PNG / JPG sequence** | Offline frames → `frame_00001.png` → **hand-rolled dependency-free STORE zip** (`zip.ts`, crc32 unit-tested against known vectors). JPEG quality 0.92. | No |
| **GIF** | Offline `getImageData` per frame → `gifEncoder.ts` — a hand-rolled LZW + palette quantizer, no dependency. | No |
| **PNG** (single) | Snapshot at the current time | No |
| **JSON** | `{ version, scene: sceneProjectIO.capture(), animation: defaultAnimation.snapshot(), exportedAt }` — the full project | No |
| **Lottie** | Builds Lottie 5.7.0 from transform tracks. ⚠️ **Position is baked static** (`{a:0, k:[x,y,0]}`); only opacity/rotation get real keyframes. A real limitation. | No |
| **MP4** | `api.createRender` → render frames locally → `renderSequenceZip` → `api.uploadRenderFrames` → **poll `api.getRender(id)` every 1 s** until completed → download `resultUrl`. Progress is segmented 0.1 / 0.1–0.5 / 0.5–0.95. | **Yes** (localhost:4000) |

### 11.3 The render queue

There is no local queue module. The queue is **server-side**, surfaced through `api.createRender` / `getRender` / `listRenders` / `cancelRender` with statuses `queued|running|completed|failed|canceled`. The client-side `renderQueueStore` drives the Render Queue panel (F6) with real offline rendering, true per-frame progress, and AbortSignal-based pause.

---

## 12. The AI system

```
prompt + document + selection + atTime + conversationId
   → POST /ai/edit                       (api.aiEdit — src/core/api/client.ts)
   → AiEditResult { label, message, ops: AiOp[], fallback, conversationId? }
   → applyAiOps(label, ops)              (src/core/ai/applyOps.ts)
   → runAnimEdit(label, …)               (src/core/animation/animationCommands.ts)
   → ONE undoable command on the CommandSystem history
```

`AiOp` is a **closed union**:
- **Keyframe ops:** `set` (`{target, properties: Record<string, number>, timing: {t, curve?}}`), `remove`, `move`, `easing`
- **Structural ops:** `create_layer`, `delete_layer`, `reparent_layer`

`fallback: boolean` signals a degraded/heuristic response. `conversationId` is set when the edit was persisted — reuse it to append to the same thread.

**This is the architectural payoff of the whole codebase: the AI emits ops, not pixels, and they land through the same `runAnimEdit` path as a human drag.** So "everything AI generates stays editable and reversible" is literally true, not marketing.

**The UI:** `AiPromptBar.tsx` (946 lines) is pinned bottom-center of the viewport ("Ask anything…"), a slim prompt that expands into a chat panel on focus. It sends the live document (`captureDocument()`) + selection. It uses the violet AI tokens **exclusively** — no other surface in the app may use purple.

**Degradation:** no backend key → a deterministic local preset. No session → it still animates from the local scene in the request body. The LLM itself lives in motion-back; **there is no AI/LLM SDK in this repo.**

Separately, `suggestExpression(intent)` in `@motion/animation` is *not* AI — it's a small local heuristic, and its result is always editable text.

---

## 13. The UI layer

### 13.1 Layout

```
TitleBar                                     (custom chrome — Electron frame: false)
├─ TopNav          menu row + tool row
├─ body: SplitPane columns
│    LeftSidebar | [ Workspace / Timeline vertical SplitPane ] | RightInspector
└─ StatusBar
```

Columns are **reorderable** by store state (`leftSidebarPosition`, `rightInspectorPosition`, `timelinePosition`) producing four possible orders. Regions resize via `SplitPane` and **collapse to a 36 px rail rather than vanishing**.

`App.tsx` (687 lines) exports `App` (thin — wraps `EditorShell` in `<Providers>`) and `EditorShell`. Its big job is **deriving the `TimelineModel`** from three sources: the scene graph (one track per node), the animation engine (per-property sub-tracks + keyframes), and the timeline engine (clip bars). It also merges `x`/`y`/`z` into a single pseudo-property `'Position'` unless `separateDimensions` is on, mirrors the scene into the timeline engine on every revision bump, and owns the AE reveal shortcuts (U/UU/P/S/R/T/M).

### 13.2 Panels

Ten registered panels:

| id | Title | Region | Closable |
|---|---|---|---|
| `scene` | Scene | left | ✔ |
| `assets` | Assets | left | ✔ |
| `libraries` | Libraries | left | ✘ |
| `properties` | Properties | right | ✔ |
| `motion` | Motion | right | ✔ |
| `effects` | Effects | right | ✔ |
| `motionTools` | Motion Tools | right | ✔ |
| `comments` | Comments | right | ✔ |
| `history` | History | right | ✔ |
| `renderQueue` | Render Queue | right | ✔ |

`DockPanel` renders a vertical icon tab rail plus the active panel. Tabs support HTML5 drag reorder, cross-region moves, a grip-button popover ("Move '{panel}' to…"), and a right-click menu. **Only `leftSidebar` and `rightInspector` are dockable** — the bottom region is a dedicated timeline, never a generic dock (moving a panel there would orphan it).

Layout presets (`workspaceLayouts.ts`): **Default, Animation, Effects, Minimal** — plus save/delete your own.

### 13.3 The inspector

`InspectorContent` switches on `readNodeKind(node)` and builds an Accordion:

| Kind | Sections |
|---|---|
| *nothing selected* | "Nothing selected" + a 4-step **"Give it motion"** guide |
| `shape` | Transform · Parent & Link · Motion & Keyframes · Appearance (Fill & Stroke) · Geometry & Path Effects · Align & Distribute |
| `text` | Transform · Parent · Motion · **Text Styles** · Appearance · **Text Animators** · Align |
| `image`/`video` | Transform · Parent · Motion · **Media Settings** · Align |
| `group` | Transform · Parent · **Pre-composition** + child count + "Enter Group (Focus Mode)" · Motion |
| `camera` | Transform · Parent · Camera Settings |
| `light` | Transform · Light Settings |
| `null` | Transform · Parent · Motion · Null Object Info |
| `audio` | Parent + Audio Controls |

Every inspector section lives in `src/layout/Inspector/`: `AlignSection`, `AppearanceSection`, `AudioControls`, `ColorKfRow`, `FontPicker`, `MediaSection`, `MotionControls`, `ParentControl`, `PathOpControls`, `PrecompControl`, `RepeaterControls`, `ShapeEffects`, `TextAnimatorControls`, `TextSection`, `ThreeDControl`, `TransformSection`, `TrimPathControls`.

### 13.4 The timeline

`Timeline.tsx` (1571 lines). Header column + lanes, rows **flattened into a uniform list and vertically virtualized** (visible + 4-row overscan). Defaults: ruler 26 px, track 30 px, header 460 px, cache bar 4 px.

**Track header (the AE switch column):** layer number · drag grip · disclosure chevron · kind icon · **color swatch** · name (double-click to rename) · **Blend Mode** dropdown · **Parent** dropdown · then flags: **Shy · fx · Motion Blur · Adjustment · 3D · eye · solo · lock**.

**Interactions:** playhead drag (with `role="slider"` keyboard support) · ruler scrub · **Ctrl+Wheel** zoom · draggable work-area band with trim handles · marker flags · the green cache bar · clip move/trim (live on a ref, engine told only on release) · keyframe drag with **frame snapping (hold Alt for free sub-frame placement)** · Shift+click multi-select · **marquee rubber-band selection across all rows** (pure logic in `marqueeSelection.ts`, unit-tested) · track reorder · search filtering that auto-expands matching layers · global Shy.

**Easing pills** (in the header): `Linear ◆—◆` · `Ease ◆⌒◆` · `EaseIn ◆⤴` · `EaseOut ⤵◆` · `Hold ◆|◆`. They act on the selected keyframes, falling back to all keyframes on selected layers.

**Graph Editor** (`GraphEditor.tsx`, ⇧G): **Value** and **Speed** tabs (speed = central-difference derivative). SVG bezier paths per property with a fixed 6-color series palette and a legend. Rotated-square keyframe diamonds: drag X = retime, drag Y = change value. **Bezier handles** appear on a selected keyframe whose easing is `bezier`, with dashed tangent lines. Undo via `beginAnimEdit()` on pointer-down → `commit('Move Keyframe' | 'Edit Curve')` on release. Shares `pixelsPerSecond` + `scrollLeft` with the timeline for pixel alignment.

### 13.5 `useWorkspace` — the render loop (1004 lines)

`src/layout/Workspace/useWorkspace.ts`. Its stated role: *"React owns only DOM elements (a content canvas + an overlay canvas + the stage) and forwards raw pointer/wheel input to the engine. The engine does everything else."*

**It is pull-based, not a rAF loop:**

```ts
const render = () => {
  backend.renderFrame(buildSnapshot(
    defaultSceneGraph, defaultAnimation,
    timeRef.current, focusRef.current, overlaysRef.current,
    controller.getView(),              // camera pan/zoom from @motion/workspace
    motionBlurRef.current,
    { ...compRef.current, camera3dMode: camera3dModeRef.current },
  ));
  renderCache.mark(timeRef.current);
  paintOverlay(...);       // selection chrome, guides, rulers
  paintMotionPath(...);    // the editable motion path
};
controller.onRender(render);   // everything calls controller.requestRender()
```

**The ref-mirror pattern is deliberate:** every render-affecting value is written to a ref on each React render, because the `render` closure is created once in the mount effect. There's a bug-fix comment on `camera3dModeRef` explaining exactly why: *"the raw closure froze it at mount and deadened the 3D/2D toggle."*

**`sizeAll` has real defensive engineering:** it skips degenerate <1px layouts *"so we never poison the engine viewport to 1×1 or waste the one-shot fit-to-composition"*; DPR is capped at 2; and the one-shot fit only fires once the stage measures ≥240×160, because *"on first load the stage can briefly measure collapsed (mid-mount / behind the onboarding tour); fitting then pins the zoom to ~5% and it never recovers."* Three backstops: a rAF, a window-resize listener, and a 600 ms timeout.

**Input priority** — `onDown` resolves in strict order, each short-circuiting: **ruler strip** (drag out a new guide) → **motion-path keyframe/tangent** → **existing guide line** → **the engine**.

`paintOverlay` reads theme tokens live from `getComputedStyle` (`--color-selection`, `--color-primary-subtle`, `--color-border-strong`) — selection chrome follows the theme, it is not a hardcoded blue.

### 13.6 Stores (32)

The load-bearing ones:

| Store | Drives |
|---|---|
| `layoutStore` (448 LOC) | The whole editor frame + docking. Persists to localStorage + SettingsManager. |
| `uiStore` | Active tool, toasts, graph editor, snap, grid, rulers, global shy. Exports `subscribeUI()` for non-React engines. |
| `projectStore` | Multi-comp tabs, playhead time, playing state, dirty flag. |
| `compositionStore` | **Not a real store** — a façade hook over `projectStore`'s active comp, with sanitization (W/H 1–16384, fps 1–240). Default: 1920×1080 @30, 10 s, `#101014`. |
| `selectionStore` / `keyframeSelectionStore` | Layer selection / keyframe selection (`nodeId::prop@time`). The latter is what makes easing pills, Delete, and Motion Tools all act on the same set. |
| `sceneStore` | A revision counter (`bumpScene()`) for the non-reactive scene graph. |
| `focusStore` | Focus Mode / precomp drill-down + ghosting + breadcrumb. |
| `assetStore` | Imported assets; uploads when authed, blob URLs otherwise; IndexedDB-backed. |
| `renderQueueStore` (210 LOC) | Real offline rendering jobs with AbortSignal. |
| `motionBlurStore` / `renderQualityStore` / `guidesStore` / `renderBackendStore` | Render config. Draft ANDs off motion blur. (Note: `renderBackendStore` is for dev/testing only). |
| `historyStore` | The coarse snapshot layer (see §10.2). |
| `preferenceStore` | Theme, UI scale, auto-keyframe, reduce-motion, confirm-on-close. Pluggable backend. |
| plus | `authStore`, `cloudProjectStore`, `versionHistoryStore`, `projectLibraryStore`, `componentStore`, `commentsStore`, `reviewStore`, `commandPaletteStore`, `contextMenuStore`, `modalStore`, `onboardingStore`, `presentationStore` |

### 13.7 Design system

**CSS Modules everywhere.** `src/styles/global.css` is explicitly the *only* global CSS file; every component ships a sibling `*.module.css`.

Token layers, imported in order:
1. `tokens/colors.css` — **the only raw color literals in the app.** Slate ladder, brand blue, **AI violet**, azure accent.
2. `tokens/spacing.css`, `typography.css`, `radius.css`, `shadows.css`
3. `tokens/motion.css` — durations (instant/fast 120 · base 160 · slow 220 · slower 320 ms) + eases. `spring` is *direct-manipulation only, never panel chrome.*
4. `tokens/zindex.css` — base 0 → drag-ghost 9999
5. `themes/dark.css` + `themes/light.css` — the semantic layer
6. `tokens/domain.css` — **imported last** because it depends on theme vars. AI violet (**reserved exclusively for AI**), layer category hues (colorblind-safe, always paired with an icon), temporal accent, timeline chrome.

Core rules from `DESIGN.md`: **depth by value-stepping, not shadow** (panel lighter than frame; inputs recessed/darker); hairline seams only at region boundaries; exact 20–44 px control heights; tabular numerics; one azure accent for selection *and* primary action; a warm/cool split (blue = selection, ember = time/now, violet = AI); progressive disclosure (one quiet timeline row per layer until expanded).

`ThemeManager` is the single authority: `theme.apply()` sets `data-theme` on the document and mirrors into `preferenceStore`.

---

## 14. Electron, backend, and persistence

### 14.1 `electron/main.ts`

Single `BrowserWindow`, 1600×1000 (min 1024×700), `backgroundColor: '#0a0a0b'`, hidden until `ready-to-show`. **`frame: false`** — hence the custom TitleBar and the `window:minimize/maximize/close` IPC.

Hardened `webPreferences`: `contextIsolation: true`, `nodeIntegration: false`, **`sandbox: true`**. `setWindowOpenHandler` denies all in-app new windows and forwards to `shell.openExternal`.

Dev vs prod: `NODE_ENV === 'development'` → `loadURL('http://localhost:5173')`, else `loadFile(dist/index.html)`.

GPU: `app.commandLine.appendSwitch('use-angle', 'default')`.

**`local-file://` protocol** — privileged (`bypassCSP: true, secure: true, supportFetchAPI: true, stream: true`), strips the scheme, decodes, applies a Windows drive-letter fixup, then `net.fetch('file://' + path)`.

**IPC:** `project:open` (dialog), `project:chooseSavePath` (dialog), `file:read`, `file:write`, `window:minimize|maximize|close`, `app:version`, `app:quit`. Main→renderer: `menu:command` — the native menu sends a command id string which the renderer runs through **the same CommandSystem the UI uses**, so the native menu duplicates no behavior.

**CSP** is not set in main.ts. It comes solely from the `<meta http-equiv>` in `index.html`:
```
default-src 'self'; connect-src 'self' http://localhost:* ws://localhost:* blob:;
img-src 'self' http://localhost:* blob: data:; media-src 'self' http://localhost:* blob: data:;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com;
script-src 'self'
```
`http://localhost:*` is whitelisted so the Electron renderer (which has no dev proxy) can reach motion-back absolutely; the browser build goes same-origin.

### 14.2 `electron/preload.ts`

A thin forwarder with no privileged logic. It exposes the **same object twice**: `window.motionEditor` and `window.electronAPI`. Surface: `platform`, `version`, `project.{open, chooseSavePath}`, `file.{read, write}`, `window.{minimize, maximize, close}`, `app.{quit, version}`, `onMenuCommand(handler)` (returns an unsubscribe function).

### 14.3 `electron/backend.ts`

Manages **motion-back**. Port `MOTION_BACKEND_PORT || 4000`, health probe `/api/health`.

Entry resolution: `MOTION_BACKEND_ENTRY` → packaged `<resourcesPath>/backend/dist/main.js` → dev sibling `../motion-back/dist/main.js` → `null`.

`startBackend()`: reuse if already healthy; if no entry found, just wait 4 s for an externally-run server; else spawn with `ELECTRON_RUN_AS_NODE: '1'` (**runs on Electron's bundled Node — no system Node needed**) and wait up to 30 s for health.

Gated behind `MOTION_LOCAL_BACKEND === '1'`. **The file's own docblock claims otherwise and is stale.**

### 14.4 The API client (`src/core/api/client.ts`)

Dependency-free by design so stores, adapters, and the assistant can all use it. Bearer JWT in localStorage (`motion-editor.auth-token`). Errors become `ApiError extends Error` with `status` + `body`.

**`assetUrl(src)` is a CSP workaround worth knowing.** The backend returns absolute `http://localhost:4000/files/<key>`; in-browser those are cross-origin and blocked by `default-src 'self'`, so media never loads. It regex-collapses to `/files/<key>` for the browser (routed via the Vite proxy) but keeps the absolute origin for Electron (no dev proxy there). blob:/data: pass through.

Surface: *auth* (`register`, `login`, `me`) · *projects* (`list`, `create`, `get`, `update`, **`autosave`**, `delete`) · *versions* (`list`, `get`, `save`, `restore`) · *assets* (`list`, `upload`, `delete`) · *ai* (`aiEdit`, `listConversations`, `getConversation`) · *render* (`createRender`, `uploadRenderFrames`, `getRender`, `listRenders`, `cancelRender`).

**Optimistic concurrency:** `baseRevision` on `updateProject`/`autosave`, `revision` on `ProjectSummary`.

### 14.5 Persistence

- **`cloudDocument.ts`** bridges two formats: the editor's on-disk `ProjectFile` is **scene-only**; the backend stores a richer, self-contained `EditorDocument` (scene + animation + comp) so AI and render services have everything they need.
- **`AutosaveController`** writes a crash-recovery snapshot every 60 s. Three behaviors: only writes when dirty (*"a quiet session costs nothing"*); flushes on tab-hidden/window-closing; and the important semantic — **autosave protects against data loss; it does NOT clear the unsaved indicator. That's reserved for an explicit Save.**
- **`recovery.ts`** shows a "Recover unsaved work?" modal on boot, but only when the snapshot's `projectId` matches the URL.
- **`FileManager`** picks an adapter at runtime: `BrowserFileAdapter` or `ElectronFileAdapter` (which bridges to `window.motionEditor` IPC).

### 14.6 Routing

**HashRouter**, and the why is documented: *"because the production Electron build loads the renderer from `file://` (dist/index.html), where the HTML5 history API has no server to rewrite deep links."*

On boot it calls `useAuthStore.hydrate()` exactly once and holds routing behind `<BootSplash/>` until it resolves, *"so RequireAuth never has to guess whether a returning user is still signed in."*

Pages: `AuthPage`, `DashboardPage`, `EditorPage`.

### 14.7 Packaging (`electron-builder.yml`)

`appId: com.motioneditor.app`. Files: `dist/**`, `dist-electron/**`, `package.json`. Targets: **win → nsis** (not one-click; user picks the install dir), **mac → dmg**, **linux → AppImage**.

`extraResources` bundles motion-back as a sidecar: its `dist`, `node_modules`, `prisma`, and `.env`. **The config's own comments admit this is wrong for distribution** — it ships the server's node_modules including the Prisma engine *and its `.env` secrets*. A portable installer needs motion-back on SQLite with the API key entered as a first-run setting.

---

## 15. Using the app: a user's guide

### 15.1 The mental model

A **composition** (default 1920×1080 @ 30 fps, 10 s) contains **layers**. Layers have **properties** (position, rotation, scale, opacity, and kind-specific ones). You animate a property by putting **keyframes** on it at different times; the app interpolates between them. Layers composite bottom-to-top with **blend modes**, **masks**, and **mattes**.

### 15.2 Creating layers

Four ways:
- **The tool row** — pick Rectangle (`Q`), Ellipse (`⇧Q`), Text (`⌘T`), Pen (`G`), Line (`L`), Polygon, Star, Pencil (`⇧P`), Curvature (`⌥P`) and draw on the canvas.
- **The "New layer" dropdown** in the TopNav — Shape / Text / Solid… / Group / Null Object / Adjustment Layer / Camera / Light / Audio…
- **The Layer menu** — with shortcuts (`⌘Y` solid, `⌘⌥⇧T` text, `⌘⌥⇧Y` null, `⌘⌥Y` adjustment).
- **The Libraries panel** — Shapes, Text presets (Title/Subtitle/Body/Caption/…), UI components, and your own saved Components.

**Importing media:** Assets panel → Import (or the file input). Images/video/audio go into the library **and straight onto the canvas** — nothing is a two-step anymore.

### 15.3 How to animate — the thing that isn't obvious

This is the single most common point of confusion, so it's spelled out in the app's own empty state ("Give it motion"):

1. **Select a layer.**
2. In the Inspector → Transform, click the **stopwatch / "Animate"** button next to a property. That creates the property's track.
3. **Move the playhead**, then **change the value**. That writes a second keyframe.
4. **Play** (`Space`).

Other routes to the same place:
- The **Animate dropdown** in the TopNav — every motion preset, plus Typewriter / Bounce In Words / Spin & Fade Characters / Tracking Reveal (text only), Easy Ease All Keyframes, Time-Reverse Keyframes, Sequence Layers (0.3 s stagger, needs 2+), Add Slider Control.
- The **AI prompt bar** at the bottom of the viewport — describe the motion in words.
- The **Libraries → Motion tab** — click a preset.

### 15.4 Refining motion

- **Easing:** select keyframes → click an easing pill in the timeline header (Linear / Ease / EaseIn / EaseOut / Hold). Or right-click a keyframe for Hold/Stepped, Roving, Delete.
- **Curves:** open the **Graph Editor** (`⇧G`). Set a keyframe's easing to `bezier` and its tangent handles appear — drag them. The **Speed** tab shows the derivative.
- **Motion paths:** with a layer selected, its path is drawn on the canvas. Drag the keyframe points to move them; drag tangent handles to curve the path; hold **Alt** to break a tangent pair.
- **Roving keyframes:** mark middle keyframes roving and they retime themselves for constant speed.
- **Expressions:** attach a formula to any property. Available: `time, value, audio, ctrl, wiggle, clamp, linear, random, Math, valueAtTime, layer, loopOut, loopIn`. Example: `wiggle(2, 30)`.
- **Reveal shortcuts (AE muscle memory):** `U` shows only animated properties on the selection; `UU` across all layers; `P` position, `S` scale, `R` rotation, `T` opacity, `M` mask.

### 15.5 Compositing

- **Blend mode** and **Parent** are dropdowns right in each timeline track header.
- **Masks:** add a mask in the Effects panel, or draw with the mask tools. Modes: add / subtract / intersect. Masks can be **keyframed** ("Keyframe shape").
- **Track mattes:** set a layer's matte to alpha/luma (+inverted) and pick an explicit source layer (AE 23+ semantics). The targeted layer becomes the matte source and is consumed. You can also use Preserve Underlying Transparency to clip a layer to the combined alpha of all layers beneath it.
- **Adjustment layers:** their effect stack applies to everything beneath them.
- **Motion blur:** two gates — the global toggle in the timeline header AND the per-layer switch in the track header. Configure shutter angle and samples.
- **Pre-compose** (`⌘⇧C`): wrap layers into a nested composition. Its time can be remapped independently.
- **3D:** the 3D toggle in the TopNav (or the per-layer 3D switch) adds `z`, `rotationX`, `rotationY` — which then animate like any other property. Add a Camera layer to fly through it.

### 15.6 Getting around

- **Command palette (`⌘K`)** — the fastest path to anything. Prefixes: `>` commands · `@` layers · `#` compositions · `:` go to a timecode.
- **Focus Mode** — double-click a group (or "Enter Group") to isolate it; everything else ghosts out. A breadcrumb shows the path; `Esc` steps up one level.
- **Shy layers** — mark a layer shy, then toggle global Shy to hide all of them from the timeline.
- **Workspace layouts** — `⇧F1` Default · `⇧F2` Animation · `⇧F3` Effects · `⇧F4` Minimal. Save your own in Customize.
- **Panels** are draggable between the left and right docks.

### 15.7 Exporting

**Export…** in the TopNav (or File → Export…). Pick a format and a resolution (Full/Half/Quarter, with a live W×H readout). Then either **Export now** or **Add to Queue** (webm / png-seq / jpg-seq), which opens the Render Queue (`F6`).

MP4 requires the backend running on localhost:4000. Everything else is fully local.

### 15.8 Collaboration-ish features

- **Comments** panel — pin a comment to a layer at a time.
- **Review status** — draft / in review / approved.
- **Review links** — `collab/review.ts` builds a shareable link with **the payload inside the link itself. No server required.**
- **Presentation mode** — full-bleed client review with minimal transport (`Esc` exits, `Space` plays).
- **Version history** — cloud checkpoints (manual / autosave / recovery), newest first, restorable.

### 15.9 Plugins

**Window → Plugins…** — install and uninstall **at runtime, no restart**. A plugin gets a `PluginContext` with `registerCommand`, `registerEffect`, `scene`, `animation`, `getSelection`, `notify`. Its commands appear in the command palette immediately.

The sample plugins make a deliberate point: they **author editable keyframes on the selected layer**, proving effects stay non-destructive. E.g. `elastic-overshoot` writes three rotation keyframes at t = 0 / 0.3 / 0.55.

---

## 16. Complete keyboard shortcut reference

> `⌘` = Cmd on macOS / **Ctrl on Windows** (the code's `isMeta` treats them identically). **Every command chord is user-remappable** via Window → Customize… → Shortcuts, persisted through `shortcutOverrides.ts`; `null` disables a chord entirely.

### Tools

| Key | Tool | | Key | Tool |
|---|---|---|---|---|
| `V` | Select | | `G` | Pen |
| `A` | Direct Selection | | `⌥P` | Curvature Pen |
| `H` | Hand | | `⇧P` | Pencil |
| `Z` | Zoom | | `⌘T` | Text |
| `W` | Move | | `Q` | Rectangle |
| `L` | Line | | `⇧Q` | Ellipse |

Polygon and Star have no default binding.

### Edit / project / layer

| Chord | Command | | Chord | Command |
|---|---|---|---|---|
| `⌘Z` | Undo | | `⌘N` | New Composition… |
| `⌘⇧Z` | Redo | | `⌘⌥N` | New Project |
| `⌘X` | Cut | | `⌘O` | Open Project… |
| `⌘C` | Copy | | `⌘S` | Save |
| `⌘V` | Paste | | `⌘⇧S` | Save As… |
| `⌘A` | Select All | | `⌘⌥⇧T` | New Text Layer |
| `Esc` | Deselect | | `⌘Y` | New Solid… |
| `⌘D` | Duplicate | | `⌘⌥⇧Y` | New Null Object |
| `Backspace` / `Delete` | Delete Selected | | `⌘⌥Y` | New Adjustment Layer |
| `⌘G` / `⌘⇧G` | Group / Ungroup | | `⌘⇧C` | Pre-compose… |
| `⌘⇧K` | Switch Theme | | `` ` `` | Focus Workspace |

> **`Delete` and `Cut` prefer keyframes over layers** when the keyframe selection is non-empty (AE convention). All the removals batch into one undoable command.

### Panels & workspaces

`F3` Effects · `F6` Render Queue · `⇧G` Graph Editor · `⇧F1`–`⇧F4` Workspace: Default / Animation / Effects / Minimal

### Command palette

`⌘K` toggle (**owns its own capture-phase listener, so it fires even inside form fields**) · `↓`/`↑` move (wrapping) · `Enter` run · `Esc` close · prefixes `>` `@` `#` `:`

### Timeline transport

`Home` / `End` start / end · `PageDown` / `PageUp` next / prev frame · `⇧PageDown` / `⇧PageUp` next / prev marker · `J` / `K` prev / next keyframe · `B` work-area in · `N` work-area out · `⇧B` clear work area · `[` / `]` move selected layer start / end to playhead · `⌥[` / `⌥]` trim start / end to playhead · `⌘⇧D` split clips at playhead

> Deliberately avoids Arrows and Space — the viewport owns those.

### AE reveal (in the timeline)

`U` toggle animated props on the selection · `UU` (double-tap ≤ 350 ms) across all layers · `P` Position · `S` Scale · `R` Rotation · `T` Opacity · `M` Mask

### Timeline panel

`Delete`/`Backspace` delete selected keyframes · `⌘A` select all keyframes · `Ctrl+Wheel` zoom · playhead: `←`/`→` ±1 frame, `⇧←`/`⇧→` ±1 s, `Home`/`End` bounds · `⇧click` a keyframe toggles multi-select · **`Alt` while dragging a keyframe disables frame snapping** · track header: `Enter` select, `F2` rename

### Viewport

`Space` (hold) temporary Hand tool · `Delete`/`Backspace` delete selection · `Esc` clear selection · arrows nudge 1 px · `⇧`+arrows nudge 10 px

### Presentation mode

`Esc` exit · `Space` play/pause

---

## 17. Testing and quality gates

**Verified live on 2026-07-15:**

```
npx tsc --noEmit   →  0 errors
npx jest           →  93 suites, 796 tests, all passing, ~28 s
```

Distribution:

| Location | Files | Notes |
|---|---|---|
| `packages/` | **38** (41%) | scene 11 · workspace 9+1 · renderer 9 · timeline 6 · animation 3 (colocated) |
| `src/core/` | **52** | scene 12 · rendering 10 · effects 9 · export 3 · commands 3 · animation 3 · paint 2 · audio 2 · timeline/text/motion/layout/inspector/api/ai 1 each |
| `src/layout/`, `src/components/` | **3** | Timeline, CommandPalette, Inspector |

**Testing is heavily weighted toward engine and core logic; only 3 of 93 files touch React.** That is a deliberate consequence of the architecture — the engines are pure and headless, so they're cheap to test, and the interesting logic lives there. The renderer tests all run against `NullBackend`, which records draw calls; `QuadRenderer` emits exactly one draw per renderable, so N visible shapes → N draws is a meaningful structural assertion.

Two conventions coexist: `packages/` mostly uses `__tests__/` directories (animation is the exception, colocated); `src/` is largely colocated.

**What tests cannot cover here:** GPU *pixel* correctness. `NullBackend` records draw structure, not pixels; `computer screenshot` hangs on this app's rAF loop; and probing `canvas.getContext('2d')` permanently poisons a canvas that a GPU backend wants to attach to. So shader/visual correctness relies on jest for structure plus a human eyeballing it in a real browser. The affine color math is exact and unit-tested against known CSS-filter values, which is why the color-grading work was low-risk despite that.

---

## 18. Known gaps, limitations, and gotchas

### Feature gaps

1. **The GPU path is meaningfully behind Canvas2D.** GPU content parity is complete (shapes with real SDF geometry, images, text, video, full color grading), but still missing: **spatial effects** (blur/glow/drop-shadow need offscreen render-to-texture + separable blur passes — `EffectPass` and `MaskPass` are registered but disabled), **mask/matte compositing**, **true precomp compositing** (it flattens instead), **path geometry** (needs triangulation — paths render flat), **gradients** (first stop only), **strokes**, **lights**, **HSL blend modes**, and **motion blur**. Canvas2D is the default and the reference for a reason.
2. **Lottie export bakes position** as a static value; only opacity and rotation get real keyframes.
3. **MP4 requires the backend.** WebM/GIF/PNG-seq are the local paths; there's no in-repo H.264 muxer.
4. **Animation is scalar-only** (v1). Colors and vectors work via separate scalar tracks that `buildSnapshot` recombines.
5. **AI ops cover keyframes + basic structural ops** (create/delete/reparent layer). Not effects, not masks.
6. **2D Glow & Light Scope:** True 3D point/spot/parallel lights with material diffuse/specular shading (like AE's 3D Lights and Material Options) are out of scope for this 2D compositor. In our engine, "Glow" (`type: 'glow'`) is implemented as a 0-offset colored halo (`drop-shadow` filter / glow approximation), while simulated 2D lighting is achieved via screen-blended radial gradient layers (`gradient-ramp` / overlay shapes).
7. **Mask editing:** Vector masks support keyframeable shape interpolation (`points`), `feather`, `opacity`, `expansion` (miter-bisector dilation/erosion), and inversion (`evenodd` clipping). An on-canvas pen tool (`MaskPathTool`) for freehand bezier drawing is not yet wired.
8. **No multi-composition registry** — the model is subtree-precomps, not a comp browser.
9. **No image-sequence import.**
10. **Audio is never exported.** Audio layers preview and drive expressions (the `audio` accessor) but no export format includes an audio track.
11. **Compositions cannot be reused.** A precomp is a subtree, so it exists in exactly one place. There is no instancing; duplicating a precomp produces an independent copy that does not track the original.

### Color Architecture & Working Space (`sRGB` vs `Linear` / `Rec709`)

1. **Non-linear sRGB (8-bpc) Default Engine**: Motion Editor currently operates entirely in non-linear sRGB (`8-bit per channel`) via standard `Canvas2D` rendering and CSS filter color operations (`effectColorMatrix`, `mixHex`, and adjustment layers).
2. **Divergence from After Effects Linear Light (`32-bit float`)**: In After Effects, enabling a linear working space (`sRGB_Linear` or `Rec709`) with 32-bit floating point ensures color grading, lighting, and compositing happen in physical linear space (`toLinear` ingress, `toSRGB` egress). Blending directly in 8-bit non-linear sRGB causes midtone blending to shift gamma compared to true linear light, causes bright highlights to clip abruptly at `255`, and means additive/screen blend modes do not conserve physical light energy.
3. **Roadmap for Linear Compositing (`32-bpc / SRGB_LINEAR`)**:
   - Project/Composition profile toggle supporting `SRGB_LINEAR` and `Rec.709` working spaces.
   - Upgrading `WebGPU` / `WebGL` render targets from `rgba8unorm` to `rgba16float` / `rgba32float` texture buffers (`scratchA` / `scratchB`).
   - Adding explicit shader stages (`toLinear` on texture ingress/sampling and `toSRGB` display colorimetry on final output to canvas).

### Code gotchas — things that will bite you

1. **`MOTION_BLUR_FPS = 60` was hardcoded** in `useWorkspace` and `useViewportRenderer` (fixed in recent AE Parity audit: both now dynamically read `compositionStore.getState().comp().fps` with fallback to `60`).
2. **`RULER_DEVICE_PX = 16` is duplicated** between `useWorkspace.ts` and `Canvas2DBackend.drawOverlays`, coupled by comment only.
3. **`layerBlendToGpu` ↔ `gpuSafe`** is comment-enforced, not type-enforced. Add a blend mode in one place and the other silently drifts.
4. **`useCommand().canExecute` always returns `true`** — a real stub. Any UI relying on it for disabled states is not actually gated.
5. **The `'__texture__'` sentinel** on `AnimationChanged` is a repaint hack riding an animation event.
6. **Clip timing and keyframes are two universes** — keyframes are sampled by *absolute comp time*, while clips carry trim/split geometry. A clip-culling block in `buildSnapshot` was **deliberately removed** because it over-culled still-animating layers. Re-enable it only once clip retime actually remaps sampling time.
7. **Four dead passes** in the renderer (`ShapePass`, `ImagePass`, `VideoPass`, `TextPass`) and two dead `after: ['text']` links (§5.4).
8. **`MaskRectangleTool`/`MaskEllipseTool` aren't in the `@motion/workspace` barrel** — unreachable to consumers.
9. **`tsc -b` does nothing useful.** `npm run build` runs `tsc -b` against a root tsconfig with no `references` and `noEmit: true`. The five package tsconfigs and `electron/tsconfig.json` are outside that graph — **`npm run typecheck` never typechecks the packages.** Only each package's own `npm run typecheck` does.
10. **`npm run lint` is broken** — no eslint, no config.
11. **`npm run electron:start` forces `NODE_ENV=development`**, so it always loads :5173. **No script exercises the production `loadFile(dist/index.html)` path locally.**
12. **Strict-mode traps:** `noUncheckedIndexedAccess` is on, so computed tuple indices need `!` and array destructuring yields `T | undefined`. `exactOptionalPropertyTypes` and `noPropertyAccessFromIndexSignature` are deliberately **off**.
13. **`FrameRate` is a plain `{fps}` object with no `valueOf`** — `t * frameRateObj` silently yields `NaN`. Always `getFrameRate().fps`.

### Security issues worth flagging

1. **`file:write` has no gate** (`electron/main.ts`). Unlike `project:open`/`chooseSavePath`, it takes an arbitrary path from the renderer and writes it with **no dialog and no path validation**.
2. **`local-file://` has no path containment check** — it resolves *any* absolute path on disk, with `bypassCSP: true`.
   Together, these mean the renderer has effectively unrestricted filesystem read/write. The `sandbox: true` / `contextIsolation: true` hardening above them is doing less than it appears.
3. **`electron-builder.yml` ships `../motion-back/.env`** into the installer — secrets in a distributable. The config's own comment admits it.

### Repo hygiene

- The working tree is **large and dirty** (~218 changed files). Git history is prompt-session-driven; both the first and last commits are named "initial commit."
- Loose scratch artifacts sit un-gitignored in the root: `add_shaders.js`, `add_uniforms.js`, `create_claude_video.js`, `create_saas_advertisement.js`, `update_comp_pass.js`, `claude_ai_video.json`, `saas_benchmark_project.json`. Also `docs/antigravity_concept_showcase.html`, referenced by nothing.
- **`DESIGN.md` specifies IBM Plex Sans**, but `index.html` loads ten *other* Google font families and not IBM Plex. `main.ts`'s `backgroundColor: '#0a0a0b'` matches no DESIGN.md token.

### The doc map

| File | Date | Status |
|---|---|---|
| **`DOCUMENTATION.md`** (this file) | 2026-07-15 | ✅ **Canonical.** Verified against code + a live test run. |
| `CURRENT_STATE.md` | 2026-07-13 | 🟡 Broadly accurate, drifting. Claims 83 suites/686 tests (now 93/796) and 10 commits (now 16). |
| `PRODUCT.md` | 2026-07-11 | 🟡 Good on vision. Wrong on one fact: says "Platform: web" despite a full Electron build. |
| `DESIGN.md` | 2026-07-11 | 🟡 Current in spirit; the font token has drifted from `index.html`. |
| `docs/TECHNICAL_ARCHITECTURE.md` | 2026-07-10 | 🔵 **Aspirational by declaration** — "the target it converges to." Not a description of reality. No CI, no conformance suites, no perceptual-diff harness exist. |
| `CORE_ROADMAP.md` | 2026-07-09 | 🔴 **Dead.** Every item is done or deliberately deleted (item 3 asks for a `TimelineEngine` that commit `62be409` removed). Safe to delete. |

---

## 19. How to extend the app

### Add a new node kind

1. Register the type in `@motion/scene` (`registerNodeType`) or map to an existing engine type in `KIND_TO_ENGINE_TYPE` (`src/core/scene/SceneGraph.ts`).
2. Add the kind to `readNodeKind` + `KIND_COLOR` / `KIND_FILL` / `KIND_ICON` in `sceneDerive.ts`. **Do not use purple — it's reserved for AI.**
3. Emit a `RenderLayer` for it in `buildSnapshot`'s per-node loop (or add it to the structural-skip list).
4. Draw it in `Canvas2DBackend.drawLayer`, and map it in `snapshotToFrameScene.KIND_MAP` for the GPU path.
5. Add an inspector branch in `InspectorContent`.
6. Add an insert path (TopNav "New layer" dropdown + a Layer-menu command).

### Add a property that animates

You often don't have to do anything. **Any numeric prop on a node is automatically keyframeable and undoable** — the `NodeInspector` renders a stopwatch row for each, and it flows through the same command path as `x`/`y`. That's how 3D (`z`, `rotationX`, `rotationY`) works with zero special-casing. Make sure `buildSnapshot.readBase` reads it and the backend draws it.

### Add an effect

1. Add the type to `EffectType` + `EFFECT_DEFS` in `effects/effects.ts`.
2. If it's an affine color transform, add its matrix to `effectColorMatrix.ts` — you get both the CPU and GPU paths for free. If it's spatial, it needs a CSS `filter` mapping in `effectsToFilter` for Canvas2D, and a real GPU pass (currently deferred).
3. The amount is keyframeable automatically via `effectPropPath(id)`.

### Add a command (and a shortcut)

```ts
getCommandRegistry().register({
  id: 'my.thing',
  label: 'Do My Thing',
  shortcut: { key: 'j', meta: true },     // meta = Cmd on mac, Ctrl on Windows
  execute: (ctx) => { /* … */ },
  undo: (ctx) => { /* … */ },             // omit and it won't participate in undo
});
```
Register it in `Providers.tsx`. It becomes searchable in the palette immediately. Add it to `APP_MENU` in `menuModel.ts` if it belongs in a menu. **Never add a `window.addEventListener('keydown')` for it** — the ShortcutManager owns that.

### Add a panel

```ts
registerPanel({ id: 'myPanel', title: 'My Panel', icon: 'sparkles',
                region: 'rightInspector', weight: 1, closable: true });
```
in `App.tsx`'s registration effect, plus a renderer in `DemoPanels.getInspectorRenderers`. Registration is idempotent.

### Add a plugin

Implement `MotionPlugin` and put it in `src/plugins/`. `activate(ctx)` gets `registerCommand`, `registerEffect`, `scene`, `animation`, `getSelection`, `notify`, and returns an optional disposer. **Install/uninstall works at runtime with no restart.** Follow the sample plugins' lead: author real editable keyframes, don't do anything destructive.

### The three rules

1. **Mutate through Commands or `runAnimEdit`.** Nothing else. Direct engine mutation is not undoable and will not be captured by history, autosave, or export.
2. **Never import the app from `packages/`.** If an engine needs something from the app, it declares a port or a provider and the app injects it.
3. **Store per-layer feature data on the `fx` component** via `setFx`. History, autosave, and export capture it for free.

---

## 20. Glossary

| Term | Meaning |
|---|---|
| **Adjustment layer** | A layer whose effect stack applies to the composite of everything beneath it. |
| **`buildSnapshot`** | The function that turns (scene + animation + time) into an immutable `RenderSnapshot`. The center of the app. |
| **Clip** | Timeline trim/split geometry for a layer: `start`, `duration`, `sourceIn`, `sourceDuration`. Distinct from keyframes. |
| **Comp / Composition** | A canvas with a size, fps, duration, and background, containing layers. |
| **`FrameScene`** | The DTO the GPU renderer consumes: a flat, paint-ordered list of `Renderable`s with world matrices resolved. |
| **Focus Mode** | Isolating a group/precomp; everything else ghosts. |
| **`fx` component** | One `DataComponent` per node holding seventeen features' data, so persistence is free. |
| **Matte** | Using one layer's alpha or luminance to cut out another. The matte source is consumed, not drawn. |
| **Port** | An interface an engine declares and the app implements, so the engine never imports the app. |
| **Precomp** | A nested composition — here, a subtree of the scene tree (hence cycle-safe by construction). |
| **`PropPath`** | A string key like `'x'` or `'effect.fx_3'` identifying one animatable scalar on a node. |
| **`RenderBackend`** | The port a renderer implements: `attach`, `resize`, `renderFrame(snapshot)`, `dispose`. |
| **Repeater** | Duplicates a layer N times with a transform delta. Copies are pure visual duplicates that don't participate in matte/adjustment ordering. |
| **Roving keyframe** | A keyframe retimed automatically so the value moves at a constant rate through it. |
| **`runAnimEdit`** | The wrapper that makes any animation mutation a single reversible command. |
| **Shy** | A layer flag; the global Shy toggle hides all shy layers from the timeline. |
| **Solo** | AE semantics: if *anything* is soloed, only soloed layers render. |
| **Spatial tangent (`si`/`so`)** | Bezier tangents in *value* space. Shared by the x and y tracks, they make the 2D trajectory a true cubic bezier — i.e. a curved motion path. |
| **Track** | Animation: a property's keyframe list. Timeline: a lane. Two different meanings — context matters. |
| **motion-back** | The separate NestJS + Postgres/Prisma backend at `../motion-back`. Auth, projects, assets, AI, render queue. |

---

*Written 2026-07-15. Verified against the code and a live `tsc` + `jest` run at that date. When this document and the code disagree, the code is right — please fix this file.*
