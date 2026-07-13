# Motion Editor — Current State (Full Project Snapshot)

**Written:** 2026-07-13
**Kind:** Ground-truth status report — what actually exists in the code today, not the roadmap or the vision.
**Method:** Direct read of `src/`, `packages/`, `electron/`, config, and tests, cross-checked by five parallel subsystem audits. Typecheck + the full test suite were run at time of writing (both green). Where this contradicts `PRODUCT.md` / `DESIGN.md` / `docs/TECHNICAL_ARCHITECTURE.md`, **this file is the reality**; those are the target.

> This supersedes the previous 2026-07-11 snapshot, which is now substantially out of date. Since then the project roughly doubled in tested surface (279 → **686 tests**) and closed almost every gap the old doc flagged: the GPU renderer is integrated, the "AI" is now a real backend-driven document editor, keyframe edits are reversible commands, and compositing (blend/masks/mattes/adjustment layers/3D/precomps/lights/motion blur/repeaters/trim paths/path ops/text animators), audio, and deterministic offline export all exist.

---

## 1. What Motion Editor is (in one paragraph)

Motion Editor is a **professional, non-destructive motion-design application** — a scene graph + a timeline + a canvas/GPU compositor, in the class of After Effects / Rive / Cavalry. It runs as **both a web app (Vite, `localhost:5173`) and an Electron desktop app**, sharing a single React 18 renderer. The interface is a calm, near-black "control surface": an AE-style menu bar and tool row on top, a Scene/Assets sidebar on the left, a live viewport in the center, a Properties/Motion/Effects/History inspector on the right, and a progressively-disclosed timeline across the bottom. **The core creative loop is real and works end-to-end:** add layers, transform them on canvas, keyframe their properties (with beziers, expressions, motion paths), composite them (blend modes, masks, mattes, 3D, precomps, effects), scrub and play the timeline, and export the result deterministically. It also now has a **real cloud backend integration** (auth, projects, assets, AI, render jobs) against a separate NestJS service (`motion-back`), and an **AI chat** that edits your actual document through reversible keyframe commands.

---

## 2. Tech stack & health

| Area | State |
|---|---|
| **UI** | React 18, Zustand (27 stores), Immer, Radix UI (dialog/popover/select/slider/tooltip), lucide-react, react-colorful. |
| **Language/build** | TypeScript strict-maxed (`strict`, `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`, `noImplicitReturns`, …), Vite 5, `tsc -b`. |
| **Desktop** | Electron 32, electron-builder. Thin privileged shell (file IPC + native menu → renderer command system). |
| **Backend (external)** | `motion-back` — NestJS + Postgres/Prisma at `http://localhost:4000/api` (separate repo, not vendored here). Auth (JWT), projects, assets, AI edit, render queue. |
| **Typecheck** | `npx tsc --noEmit` → **clean, 0 errors** (meaningful given the strict config). |
| **Test suite** | **83 test suites, 686 tests, all passing (~26s).** Concentrated in the engine packages + core animation/compositing/export. **No tests** for `src/core/ai/`, the stateful `AudioEngine`, or the CommandSystem itself. |
| **Codebase size** | ~**53,000 LOC** of `.ts/.tsx` across `src/` + `packages/` + `electron/`. |
| **Version control** | ✅ **Now a git repo** — 10 commits on `main` (initial + 9 feature commits through "Prompt 6"), plus a **large uncommitted working tree** (~220 changed/untracked files) carrying the newest work (3D, audio, precomps, offline render, path ops, cloud/AI, etc.). |
| **AI/LLM deps** | **None in this repo.** No `openai`/`anthropic`/model SDK. The LLM lives in the external `motion-back` service; this app talks to it over HTTP and applies the returned typed ops. |

**How it launches**
- **Web:** `npm run dev` → Vite on `localhost:5173`. Build: `npm run build` (`tsc -b && vite build`) → `dist/`.
- **Electron:** `npm run electron:dev` (Vite + tsc watch + Electron concurrently). Package: `npm run dist`.
- The renderer is host-agnostic: `FileManager.ts` has `browser`, `electron`, and now `api` (cloud) file adapters, so the same UI runs local or cloud-backed.

---

## 3. Architecture at a glance

Onion/layered model (per `docs/TECHNICAL_ARCHITECTURE.md`). The migration from self-contained `src/core/*` engines to framework-independent `packages/@motion/*` is now **largely complete** — and unlike the old snapshot, **all five packages are wired and imported by `src/`.**

```
┌─────────────────────────────────────────────────────────────┐
│ React shell   src/layout/*  src/components/*  src/stores/*   │  ← what the user sees
│   TopNav · LeftSidebar · Workspace(viewport) · Inspector ·    │
│   BottomTimeline+GraphEditor · StatusBar · CommandPalette ·   │
│   RenderQueue · Auth · AI prompt bar · overlays               │
├─────────────────────────────────────────────────────────────┤
│ App-side controllers / adapters   src/core/*                 │  ← the spine
│   Application(boot) · EventBus · ServiceContainer(DI) ·        │
│   CommandSystem+HistoryService · ShortcutManager ·            │
│   TimelineController · WorkspaceController+ports ·             │
│   buildSnapshot · Canvas2DBackend / MotionRendererBackend ·   │
│   animationCommands · api client · exportManager · …          │
├─────────────────────────────────────────────────────────────┤
│ Framework-independent engines   packages/@motion/*           │  ← the "real" core
│   @motion/scene · @motion/timeline · @motion/workspace ·      │
│   @motion/renderer (NOW INTEGRATED) · @motion/animation       │
└─────────────────────────────────────────────────────────────┘
```

**Data flow (the working loop):**
```
input (canvas tool / menu / shortcut / inspector / AI prompt)
  → mutation via Command (scene/timeline/workspace) or runAnimEdit (keyframes)
  → EventBus event (AnimationChanged / NodeUpdated / …) + sceneStore revision bump
  → re-derive: timeline tracks, inspector rows, RenderSnapshot (buildSnapshot)
  → backend.renderFrame(snapshot) → pixels  [Canvas2D default, GPU opt-in]
  → renderCache.mark(t) feeds the timeline cache bar
```

**Three undo domains coexist** (worth knowing): the CommandSystem history (keyframe edits via `anim.edit`, scene structural commands), the `@motion/timeline` engine's own history (clip/layer/marker structure), and a coarse store-snapshot history (`historyStore`). Not yet unified.

---

## 4. `packages/` — the five engines (all wired)

Each is a standalone TS package with its own `package.json`, jest config, and `__tests__/`, aliased as `@motion/*` in `vite.config.ts`, `tsconfig.json`, and `jest.config.cjs`.

| Package | ~Src LOC | Test files | Wired? |
|---|---|---|---|
| scene | ~2,100 | 11 | ✅ |
| timeline | ~2,500 | 6 | ✅ |
| workspace | ~4,700 | 9 | ✅ |
| renderer | ~4,000 | 9 | ✅ **now integrated** |
| animation | ~850 | 3 | ✅ (most-imported) |

### `@motion/scene` — Scene Graph ✅ source of truth
ECS-style object hierarchy: `Scene` container, `SceneNode` with components (Transform + data components Fill/Stroke/Shadow/Blur/Mask/Gradient/Text/Media/Camera/Light/Particle/Physics), ~20 node factories. O(1) id index, **cycle detection** (`wouldCreateCycle`), structural validation with stable error codes, reparenting, deep-clone duplicate, traversal (dfs/bfs), `SelectionModel`, `TransformSystem` (dirty-flag world-matrix propagation), and **versioned serialization with a migration registry**. **New 3D math:** `utils/matrix4.ts` (column-major 4×4) + `utils/project3d.ts` (AE-convention pinhole camera projection returning `{x,y,scale,depth}`). Consumed by `src/core/scene/*` and `buildSnapshot.ts`.

### `@motion/timeline` — Timeline structure ✅ authority
Frames-canonical time system (`FrameRate`, ms/seconds/timecode). Every structural mutation (add/remove/move/duplicate track & layer, split, trim, setStart, group/ungroup, markers) routes through an **undoable `History` command** (this package's *own* history, separate from CommandSystem). Timer-free playback: `tick(dtMs)` advances the playhead with loop wrap. Binary-search (`lowerBound`/`upperBound`) for sorted temporal lookups. Markers at 3 scopes, zoom/scroll/fit, work-area/loop ranges, serialization. Consumed by `src/core/timeline/TimelineController.ts`.
⚠️ Still holds **no keyframes/interpolation** — clip/layer/marker *structure* only. Property animation lives in `@motion/animation`.

### `@motion/workspace` — Interaction/viewport engine ✅ deepest wiring
Wired via ports (`SceneGraphPort`, `SelectionPort`, `RendererPort`, `CommandPort`). `Viewport`/`Camera`/`CameraAnimator` (eased), `CoordinateSystem`, `Grid`/`Guides`/`SnapEngine` (stateless world-space snap to grid/guides/edges/centers/corners), `HitTester` + **quadtree `SpatialIndex`** (built for 100k+ objects), `SelectionController`/`Marquee`/resize-rotate handle transforms, `CursorManager`, `InputSystem` (DOM-event normalization), a `ToolManager` with **10 tools** (Select, DirectSelection, Move, Hand, Zoom, Rectangle, Ellipse, Pen, Text, Camera), and a `WorkspaceCommands` bus. **New:** `math/BezierPoint.ts` (anchor + absolute in/out handles). Consumed by `src/core/workspace/*` and driven from `src/layout/Workspace/`.

### `@motion/renderer` — GPU renderer ✅ **NOW INTEGRATED (was orphaned)**
WebGPU-primary / WebGL2-fallback / Null-headless render-graph engine: `Renderer` façade, three real backends, `ResourceManager`, shader/material systems, ~10 render passes (Background/Clear/Image/Shape/Text/Video/Mask/Effect/Selection/Overlay), **render graph with topological sort + cycle detection + transient-target reuse**, std140 uniform packing (`pipeline/uniforms.ts`), SDF renderables + color-matrix, command batching, and multi-sample motion blur.
**Integration (commit `30753d7` + working tree):** implemented behind the app's `RenderBackend` port by `src/core/rendering/MotionRendererBackend.ts`; `createRenderBackend.ts` is a runtime factory (`canvas2d` default vs `webgl2`/`webgpu`/`null`), user-selectable in `CustomizeDialog` and `renderBackendStore`; called live from viewport hooks and the offline renderer; covered by integration tests. **Canvas2D remains the default**; GPU is additive/opt-in.

### `@motion/animation` — Animation Engine ✅ value authority
Keyframe property tracks + expressions keyed by `(nodeId, prop)`, sampled at time `t` → `SceneValueSnapshot` merged over base state. `AnimationEngine` (CRUD, `setTrackKeyframes`/`getTrackKeyframes` deep-copy seams for the command layer, `sample`/`evaluateNode`/`evaluateScene`, snapshot/restore). Framework-independent via injected providers: change-listener, **audio-level provider**, **control-rig provider**. `interpolate.ts` — `cubicBezierEase` (Newton's-method solve), step/ease families, `sampleTrack`, `sampleSpeed` (velocity), roving keyframes, easy-ease presets. `expressions.ts` — AE-style expressions compiled once via `new Function`, curated sandbox (`time,value,audio,ctrl,wiggle,clamp,linear,random,Math`), **deterministic value noise** (reproducible playback), tokenizer/bracket-matcher for the editor. Singleton `defaultAnimation` used across ~30 files.

---

## 5. `src/core/` — the app-side spine (substantially real)

**No stub/TODO-only directories.** Highlights:

**Boot & foundations**
- `application/Application.ts` — singleton boot façade: EventBus → DI container → `registerCoreServices` → `CommandSystem` → `ShortcutManager` → plugins → `ApplicationReady`.
- `services/ServiceContainer.ts` — minimal `Map`-based DI; typed tokens in `coreServices.ts`.
- `events/EventBus.ts` + `EventTypes.ts` — strongly-typed synchronous pub/sub, ~30 typed events, per-listener isolation.
- `bootstrap/registerCoreServices.ts` — the composition root (7 core services + wiring).

**Command system (now reversible for keyframes)**
- `commands/` — `CommandRegistry`, `CommandSystem` (the only sanctioned executor; pushes to history iff `cmd.undo` exists), `HistoryService` (dual-stack, capacity 500, **context-builder injection** so undo/redo re-run with valid context, merge/coalesce via `peek()`), `ShortcutManager` (capture-phase, dispatch by commandId so rebinds resolve, skips editable targets), and **`shortcutOverrides.ts`** (persisted user rebind/disable map + conflict detector).
- ⭐ **`animation/animationCommands.ts`** — the headline fix (commit `4d4448f`). `AnimEditCommand` captures per-track before/after keyframe arrays and swaps them; `diffTracks` computes the minimal touched set; `runAnimEdit(label, mutate)` collapses any multi-keyframe edit into **one reversible `anim.edit` command**; `beginAnimEdit()/commit()` for live drags with merge-key coalescing (a scrub-drag = one undo step). **Every** keyframe edit — inspector, motion editor, presets, assistants, AI, motion-path drags — now flows through this. So the architecture's "every edit is a typed, undoable command" promise now holds for animation.

**Rendering** (see §6) · **Effects** (see §7) · **Animation/Motion/AI/Audio/Text** (see §8–11) · **Export** (see §12).

**Cloud & persistence**
- `api/client.ts` — real dependency-free fetch client for `motion-back` (JWT auth in localStorage): auth (register/login/me), projects (list/create/get/update/**autosave with optimistic `baseRevision`**/delete), assets (list/upload multipart/delete), **ai (`aiEdit`)**, render (create/get/list jobs).
- `api/cloudDocument.ts` + `files/ApiFileAdapter.ts` — capture/restore the *full* document (scene + animation snapshot + composition) to/from the cloud; a swappable `FileAdapter` (`kind: 'api'`) routes Open/Save to backend project ids, gated on `isAuthenticated()`.
- `persistence/` — `AutosaveController` (60s interval + visibility/unload flush, dirty-only), `recovery.ts` (capture/restore scene+anim snapshots on boot), `ProjectService`/`ProjectSerializer`.
- `project/ProjectManager.ts` — full lifecycle (new/open/save/saveAs/close, dirty flag, MRU) decoupled via `ProjectDocumentIO`; `RecentProjects` (bounded MRU).
- `files/FileManager.ts` — three adapters (Browser: File System Access API / localStorage VFS; Electron IPC; API cloud), swappable at runtime.

**Support services** — `settings/SettingsManager` (persisted K/V, swappable backend, per-key observe), `theme/ThemeManager` (light/dark/system + accent), `logging/Logger` (leveled, scoped, ring-buffer), `loading/LoadingManager` (async task tracker), `inspector/` (PropertyRegistry: `componentType::propName` → React editor).

**Extensibility & collab** — `plugins/PluginHost.ts` (real runtime install/uninstall with clean unregister; distinct from the boot-time `ApplicationPlugin`), `collab/review.ts` (real but V1: base64-URL "review link" of the whole project + comments + status; no server/presence/CRDT). `assets/` spans an in-memory `AssetService`, an IndexedDB blob store (`AssetDatabase`), and cloud upload.

**Residue cleaned up since the old doc:** the orphaned `core/timeline/TimelineEngine.ts` was deleted and the stale `core/index.ts` barrel pruned to a single export (commit `62be409`).

---

## 6. Rendering & compositing (the biggest change vs. the old doc)

The old snapshot said: Canvas2D-only, effects = CSS approximations, no 3D/precomps/masks, WebM = realtime capture. **Almost all of that is now false.**

- **`rendering/buildSnapshot.ts` (~556 LOC)** — the pure projection core (`SceneGraph + AnimationEngine + t → immutable RenderSnapshot`). The `buildSnapshot3d/Effects/Light/Precomp/Repeater` names exist only as **test files**; the features are all inline here: parenting via cached world transforms, solo, focus-mode ghosting, per-layer **time remap**, keyframeable effect amounts, **3D projection** (scene camera → 4×4 compose → projected 2×3 affine + painter-order depth sort), **lights** (radial-glow layers), **precomp routing** (descendants → container `precompLayers`, nesting-aware, internal time remap), **repeaters** (N cumulative transformed/faded copies), **path ops** (zig-zag/pucker/twist/round), **trim paths**, **anchor points**, **auto-orient**, **per-glyph text animators**, and **motion-blur sub-frame sampling**. Wired into the live viewport, presentation mode, and export.
- **`rendering/Canvas2DBackend.ts` (~821 LOC)** — the reference backend and **default live path**. Full compositor: camera/fit transform, preview chrome (float shadow + transparency checkerboard, off for export), then per-layer handling of adjustment layers (re-composite region through CSS filter), precomps (offscreen canvas + opacity/blend/filter/mask), lights, motion blur (accumulate samples at opacity/n), track mattes (alpha/alpha-inv/luma/luma-inv via scratch canvases + `lumaToAlpha`), gradients, aligned/dashed strokes, trim-path stroking, images/video/multiline+per-glyph text, grid/safe-area/ruler overlays.
- **`rendering/MotionRendererBackend.ts` + `snapshotToFrameScene.ts` + `AppTextureProvider.ts`** — the GPU path. Maps `RenderSnapshot` → renderer `FrameScene`; color effects → per-pixel `colorMatrix`; shapes → SDFs; masks/mattes/paths/text **CPU-rasterized to textures and uploaded**. Async device init coalesces a pending frame until ready.
- **`rendering/renderCache.ts`** — AE-style RAM-preview cache (buckets at 1/30s → contiguous ranges for the timeline cache bar; invalidates on animation change).

**GPU gaps (confirmed):** `EffectPass.enabled = false` — GPU **color grading works**, but GPU **spatial effects (blur/glow/drop-shadow) are not yet implemented**; on the GPU path masks/mattes/text are CPU-rasterized rather than native passes; gradients use the first stop; strokes are skipped. Canvas2D has no such gaps. Two backend-selection paths coexist (`RendererFactory.detectBestBackend` and `createRenderBackend.resolveBackendChoice`) — a consolidation target.

---

## 7. Effects & compositing modules (`src/core/effects/`)

All effect state lives on each node's `fx` component (so History/autosave/export capture it for free) and emits `AnimationChanged` on write. Every module has a paired test.

| Module | What it does |
|---|---|
| `effects.ts` | 10 effect types (blur, glow, drop-shadow, brightness, contrast, saturate, grayscale, sepia, hue-rotate, invert) → CSS filter fns; stack CRUD; keyframeable amounts (`effect.<id>`). Canvas2D path. |
| `effectColorMatrix.ts` | The 7 color-grade effects composed into one 3×3 matrix+offset (Rec.709 luma, proper sepia/contrast/invert) — the **GPU path's** per-pixel answer to CSS filters. |
| `blendMode.ts` | Full **17-mode** AE blend set with `gpuSafe` flags → Canvas `globalCompositeOperation`. |
| `mask.ts` + `maskAnim.ts` | Vector **bezier masks** (rect/ellipse presets, add/subtract/intersect, inverted, feather+opacity stored), **animated/keyframeable mask shapes** (lerp points, snap on vertex-count mismatch). Deferred: on-canvas pen editing, feather blur, GPU MaskPass. |
| `matte.ts` | **Track mattes** alpha/alpha-inv/luma/luma-inv. |
| `adjustment.ts` | **Adjustment layers** (filter applies to everything beneath). |
| `layerStyles.ts` | Photoshop-style drop-shadow + outer-glow → CSS `drop-shadow()`. Inner shadow/overlays deferred. |
| `motionBlur.ts` | Multi-sample accumulation: evenly-spaced sub-frame times across the shutter interval (shutterAngle/360, AE convention), deterministic. Two-level gating (comp store + per-layer flag). |

**Paint** (`src/core/paint/`): rich fills (solid / linear / radial multi-stop gradients, layer-local relative coords) and strokes (width/color/opacity/align/dash/cap/join). Static editing + undo; per-stop keyframing deferred (engine is scalar-only). Canvas2D renders all; GPU uses first stop / skips strokes.

---

## 8. Animation, motion & keyframe features (`src/core/animation/`, `src/core/motion/`)

Beyond the reversible-command spine (§5):

- **`animationPresets.ts`** — capture a layer's tracks as a named preset and re-apply anchored at the playhead, as one undoable command. **11 built-ins** (Fade In/Out, Pop In, Spin, Pulse, Bounce In, Slide In L/R, Rise Up, Drop In, Shake) with relative tracks that resolve against the layer's base value (position-agnostic); user presets persist via SettingsManager. UI: `PresetsBar`, TopNav Animate menu.
- **`keyframeAssistants.ts`** — AE-style bulk actions: **Easy Ease All** (33%-influence bezier on every keyframe), **Time-Reverse** (mirror within span), **Sequence Layers** (stagger ≥2 layers), **Typewriter** (builds a text-animator rig + keyframes the range selector), per-keyframe easing presets. All wrapped as reversible edits.
- **`expressionControls.ts`** — **slider control rigs**: a control is a plain numeric prop `ctrl_<name>` on Transform, so the inspector auto-renders a keyframeable/undoable row; `controlValue(name,t)` is the global-by-name accessor bound into the engine as the `ctrl()` expression provider.
- **`motion/motionPath.ts`** — turns x/y position keyframes into a spatial bezier trajectory + auto-orient heading. Drawn as an **on-canvas overlay** with **draggable keyframe dots** (`useWorkspace` hit-tests dots; dragging one `screenToWorld`s the pointer and `runAnimEdit`s both x & y under one merge key → single undo). `scene/autoOrient.ts` overrides layer rotation with velocity heading.

---

## 9. The "AI" reality (major update — no longer a stub)

The old snapshot's verdict ("UI-only chat stub with no handler; static dictionary of 5 presets; no model, no network") is **outdated**. There are now **two distinct AI surfaces**:

### (a) Backend-driven chat assistant — real, wired end-to-end
- `src/layout/Workspace/AiPromptBar.tsx` — the send button (and Enter) **has a working handler**: it captures the live document (`captureDocument()`), selection, and playhead time, calls `api.aiEdit({prompt, document, selection, atTime, …})`, and replays the returned `KeyframeOp[]` via `applyAiOps`.
- `src/core/ai/applyOps.ts` — replays ops (`set`/`remove`/`move`/`easing`) inside **one `runAnimEdit`**, so an entire AI edit collapses to a **single reversible `anim.edit` command** and the authored keyframes remain fully editable in the timeline like hand-made ones.
- The **LLM itself lives in the external `motion-back` service**, not this repo — there is no model SDK here, only the typed HTTP contract (`AiEditResult { label, message, ops, fallback }`). Documented graceful degradation: no backend key → server returns a deterministic preset (`fallback: true`); no session → it still animates the local scene sent in the request body.

This realizes the product's headline principle — **the AI edits your real document through the exact same reversible command path you use** — for the keyframe-op vocabulary. (It does not yet create/delete layers or edit non-keyframe structure; the op set is keyframe-only.)

### (b) Contextual preset suggestions — the former "5 canned presets," reframed
- `src/core/ai/suggestions.ts` — a static `ACTIONS` dictionary of 5 entries (`reveal`, `spin`, `float`, `pop`, `headline`) mapped by node kind, each authoring real keyframes from the node's current base value, wrapped in `runAnimEdit`. This is now a *secondary* quick-suggestion surface (sparkle button + suggestion cards), separate from the backend chat, and deterministic by design.

⚠️ `src/core/ai/` has **zero tests** — the only untested feature subsystem.

---

## 10. Audio (`src/core/audio/`) — real Web Audio pipeline

- `AudioEngine.ts` — single `AudioContext` authority (singleton). Decodes assets → `AudioBuffer` + `WaveformPeaks` (cached, in-flight-deduped, handles `data:`/`blob:`/`http`). **`sync(playing, timeSec, layers)`** reconciles live `BufferSource` voices with the transport: starts/stops per audible layer, seeks into buffers to match the playhead, detects seek/loop drift (0.25s tolerance) and restarts voices, respects per-layer gain/mute. **`currentLevel()`** reads envelope amplitude at the playhead — this drives the expression engine's `audio` accessor. Degrades gracefully with no Web Audio (SSR/tests).
- `waveform.ts` — pure DSP (per-bucket max-abs peaks, mono mix, interpolated `amplitudeAt`, mirrored SVG `waveformPath`). Tested.
- `audioScene.ts` (scene → flat `AudioLayerState[]`), `useAudioPlayback.ts` (`AudioPlaybackBridge` React host syncing on play-state/time/scene changes). UI: `AudioControls` renders the waveform.
- ⚠️ The stateful `AudioEngine` (voice reconciliation, seek drift) is **untested**; only the pure `waveform.ts` is.

---

## 11. Text animators (`src/core/text/textAnimators.ts`)

After Effects-style per-glyph animators: groups stored as a hidden `__animators` array on the Text component; each numeric param (`start,end,offset,x,y,scale,rotation,opacity,tracking`) is keyframeable under prop-path `ta.<i>.<param>` (through the same reversible command path). Range selectors (characters/words/lines) with 6 falloff shapes; pure `evaluateTextAnimators → per-glyph GlyphTransform` (position/rotation/tracking add, scale/opacity multiply, color blend). UI: `TextAnimatorControls`; consumed by the Typewriter assistant. Tested.

---

## 12. Export & render queue (deterministic)

- **`export/offlineRenderer.ts`** — the deterministic core: `frameTimeAt(i,fps) = i/fps` (fixed timestep → **byte-identical frames regardless of machine speed**). Renders each frame into an offscreen backend (honors the chosen backend, awaits GPU readiness), yields to a `FrameSink`, supports `AbortSignal` and frame ranges. Pure timing helpers unit-tested.
- **`export/exportManager.ts`** — presets **PNG / PNG-seq / JPG-seq / JSON / Lottie / WebM**. JSON = re-openable project; **Lottie** = valid Lottie JSON from transform tracks (opacity/rotation/position; shapes empty — transform-only); **WebM** = deterministic offline frames → MediaRecorder VP9 (container wall-clock-paced, but content reproducible). Sequences zip stills.
- **`export/zip.ts`** — dependency-free STORE ZIP writer with unit-tested CRC-32.
- **`stores/renderQueueStore.ts` + `layout/RenderQueue/RenderQueuePanel.tsx`** — a real AE-style **render queue** (F6): jobs target comp+format, run **serially through the deterministic offline renderer** with real per-frame progress, Pause aborts via `AbortController`, output downloads. Caveat: **mp4/gif fall back to WebM** (no in-browser H.264/GIF muxer).

---

## 13. The UI layer (`src/layout/`, `src/components/`, `src/stores/`)

Mature and almost entirely real. Boot: `main.tsx → App → <Providers><EditorShell/></Providers>`. `Providers.tsx` (~750 LOC) is the boot orchestrator (Application.boot, command/tool/project registration, theme, seed scene/animation, plugin host, command-palette commands, onboarding, autosave + crash-recovery). `App.tsx` (~590 LOC) wires the enormous BottomTimeline handler set and AE reveal shortcuts.

**Panels — all render real content** except one flagged item:
- **TopNav / TopToolbar** — AE two-row chrome: menu bar over the CommandRegistry, comp-settings, **AI sparkle** popover (Normal/Minimal/Off + contextual suggestions), Preview, Export; tool row with Select/DirectSelect/Move/Rotate/Scale/**Hand (H)/Zoom (Z)/Ellipse (E)**/Pen/Text/Rectangle, alignment/distribute, Snap/Grid/Rulers toggles, a consolidated **New-layer dropdown** (Shape/Text/Solid/Group/Null/Adjustment/Camera/Light/Audio) + 3D toggle, an **Animate menu** (presets, Typewriter, Easy-Ease-All, Time-Reverse, Sequence Layers, Add Slider Control), and always-visible **Undo/Redo**.
- **Workspace** — dual-canvas viewport (content + interaction overlay), AE composition header, renderer seam (`useWorkspace`/`useViewportRenderer`), the working **AI prompt bar**, suggestion cards, motion-path overlay.
- **Inspector** (RightInspector) — full property suite: Transform/Appearance/Text/Media/Motion/Parent/Anchor/**3D/Repeater/TrimPath/Precomp/PathOp/ShapeEffects/TextAnimator/Audio** sections.
- **Timeline** (~1,370 LOC) — virtualized AE-style rows (one calm row per layer, expanding into per-property keyframe sub-rows), ruler + green render-cache bar, ~460px resizable header, blend-mode/parent dropdowns, work-area band, markers, clip bars with trim/split; plus a separate **GraphEditor** (Value/Speed curves, Shift+G). Transport via `usePlaybackClock` (rAF, visibility-aware) + `useTimelineKeys`.
- **Motion** — direct-manipulation curve editor + VS-Code-flavored **ExpressionEditor** (with `suggestExpression` assist) + PresetsBar.
- **Effects** — per-layer effect stack with scrubbable params + keyframe stopwatches; EffectControls, Fill/Stroke/LayerStyles/Time/TrimPath controls.
- **RenderQueue, History** (visual, click-to-jump), **Comments** (layer+timecode anchored + approval flow + share link), **Composition** (new/settings dialogs), **Presentation**, **Onboarding**, **Plugins** (install/uninstall toggles live command registration), **Settings/CustomizeDialog** (shortcut rebinding + workspace presets), **StatusBar** (layer/selection counts, comp title + dirty dot, FPS meter, ⌘K, **Account button**), **TitleBar**, **CommandPalette** (⌘K fuzzy commands/layers/timecodes), **Auth** (real login/register modal + account menu), **focus** (breadcrumb + ghosting), **overlays** (Modal/ContextMenu/Notification hosts).
- ⚠️ **The one provisional piece:** `EditorLayout/DemoPanels.tsx` supplies some sidebar/inspector *body* content and is explicitly labeled demo, "to be replaced by panels registered by the Scene."

**Stores (27):** scene, selection, keyframeSelection, ui, workspace, composition, layout, guides, focus, presentation, onboarding, preference, uiStore, contextMenu, modal, commandPalette, comments, history, assetStore, aiSuggestion, **auth**, **review**, **renderQueue**, **motionBlur**, **renderBackend**, **renderQuality**. Component library: Icon, Button, IconButton, Input, ValueField, Checkbox, Switch, Slider, Tooltip, Popover, Menu, Dropdown, Modal, Tabs, Panel, DockPanel, SplitPane, ScrollArea, TreeView, VirtualList, List, Accordion, Inspector, ColorPicker, EmptyState, ErrorBoundary.

---

## 14. Can a user create motion, 0 → advanced, right now?

Traced through real code. **The central loop works, and the ceiling has risen from "intermediate" to genuinely "advanced 2D + basic 3D."**

### ✅ Level 0 — Basics
Insert shape/text/solid/group/null/adjustment/camera/light/audio; draw with Rectangle/Ellipse/Pen/Text; select (canvas hit-test, Scene tree, timeline); move/resize/rotate (engine tools → CommandPort), arrow-nudge, numeric inspector; pan/zoom, zoom-to-fit, grid/safe-area/rulers.

### ✅ Level 1 — Keyframe animation
Stopwatch a property → keyframe at the playhead; add/move/delete keyframes on the timeline; AE `U/P/S/R/T` reveal; scrub + play (`usePlaybackClock` pumps the engine, `buildSnapshot` + backend draw each frame); **undo/redo now covers keyframe edits** (via `anim.edit`), work area + markers, clip trim/split/move, autosave + crash recovery.

### ✅ Level 2 — Intermediate
Bezier easing (Motion curve editor + Graph Editor), multiple animated tracks/layer, **expressions** (wiggle/audio-reactive/`ctrl()` rigs), **effects** (blur/glow/color etc.), **presets** (11 built-in + save your own), **keyframe assistants** (easy-ease-all, time-reverse, sequence-layers, typewriter), **motion paths** with draggable dots + auto-orient, focus mode, presentation mode, ⌘K, theming.

### ✅ Level 3 — Advanced (NEW since the old doc)
**Compositing:** 17 blend modes, vector masks (add/subtract/intersect, inverted, animated), track mattes (alpha/luma), adjustment layers, layer styles. **3D:** 3D layers projected through a scene camera with depth sort + point lights. **Precomps:** nested comps → offscreen texture with internal time remap. **Motion graphics:** repeaters, trim paths, path ops (zig-zag/pucker/twist/round), per-glyph text animators. **Motion blur** (multi-sample). **Audio** layers with waveforms + audio-reactive expressions. **AI** chat that authors reversible keyframes on your real document. **Cloud** projects/assets/auth. **Deterministic export** (PNG/seq/JSON/Lottie/WebM) + a render queue. **GPU backend** (opt-in, WebGL2/WebGPU) for color-graded rendering.

### ❌ Still not yet (the remaining ceiling)
- **AI beyond keyframes** — the op vocabulary is keyframe-only (set/remove/move/easing); it can't yet create/delete layers or restructure the document. And the model is external (`motion-back`), so AI only works when that service is running.
- **GPU spatial effects** — `EffectPass` is disabled; blur/glow/drop-shadow don't render on the GPU path (they work on Canvas2D). GPU masks/mattes/text are CPU-rasterized, not native passes; GPU gradients use the first stop and skip strokes.
- **Real H.264/MP4 & GIF export** — mp4/gif fall back to WebM (no in-browser muxer).
- **Keyframeable color/gradient/vector values** — the AnimationEngine is scalar-only, so per-stop gradient and mask-feather animation are deferred.
- **Real-time collaboration** — only a serverless base64 "review link"; no presence/CRDT.
- **Mask pen-editing on canvas, inner-shadow/overlay layer styles, unified undo stack.**

**Bottom line:** a user can now build a genuinely advanced 2D (and basic 3D) motion piece — layers, eased curves, expressions, masks, mattes, blend modes, precomps, 3D + lights, text animators, motion blur, audio — talk to an AI that edits it reversibly, and export it deterministically. The differentiators that were vaporware in the last snapshot are now real; what remains are depth items (GPU spatial effects, richer AI ops, MP4/GIF, unified undo).

---

## 15. Honest scorecard

| Subsystem | State |
|---|---|
| Scene graph (`@motion/scene`) incl. 3D math | ✅ Real, tested, authoritative |
| Timeline structure (`@motion/timeline`) | ✅ Real, tested, undoable, authoritative |
| Workspace/tools/hit-test/snap (`@motion/workspace`) | ✅ Real, most-tested, authoritative |
| Animation engine (`@motion/animation`) | ✅ Real, tested, now a package |
| **Reversible keyframe commands** | ✅ **Real & wired — the old gap is closed** |
| Canvas2D rendering + snapshot pipeline | ✅ Real, default live path |
| **GPU renderer (`@motion/renderer`)** | ✅ **Integrated & opt-in** (spatial effects still stubbed) |
| Compositing: blend/masks/mattes/adjustment/layer-styles | ✅ Real, tested (Canvas2D) |
| 3D layers + lights | ✅ Real, tested |
| Precomps + time remap | ✅ Real, tested |
| Repeaters / trim paths / path ops / text animators | ✅ Real, tested |
| Motion blur (multi-sample) | ✅ Real, tested |
| Paint (fills/gradients/strokes) | ✅ Real (Canvas2D; scalar-only animation) |
| Audio (Web Audio + waveforms + audio expressions) | ✅ Real (engine untested) |
| Export (PNG/seq/JSON/Lottie/WebM) + deterministic offline | ✅ Real (mp4/gif → WebM) |
| Render queue | ✅ Real |
| Command/DI/EventBus/shortcuts/boot spine | ✅ Real, wired |
| Autosave / recovery / project I/O / theme / settings / files | ✅ Real |
| **Cloud backend (auth/projects/assets/render/AI)** | ✅ **Real client** (needs `motion-back` running) |
| **AI document editing** | ✅ **Real (backend-driven, reversible, keyframe-op vocabulary); model external** |
| Plugins (runtime host) | ✅ Real, lightly populated |
| Collab | ⚠️ V1 review-link only (no server/presence) |
| Assets panel content | ⚠️ Partly demo (`DemoPanels`); real cloud/IndexedDB plumbing exists |
| GPU spatial effects (blur/glow) | ❌ `EffectPass` disabled |
| MP4/GIF export, richer-than-keyframe AI, unified undo, scalar-only animation | ❌ / ⚠️ Deferred |
| `src/core/ai/` + stateful `AudioEngine` tests | ⚠️ Untested |

**One-sentence summary:** Motion Editor is now a **real, strict-typed, heavily-tested (686 tests) advanced 2D + basic-3D motion editor** with a complete engine stack (scene/timeline/workspace/animation packages + Canvas2D and an integrated opt-in GPU renderer), full compositing (blend/masks/mattes/3D/precomps/lights/motion-blur/repeaters/text-animators), audio, deterministic export with a render queue, a cloud backend, and — the headline turnaround from the last snapshot — an **AI chat that edits your real document through the same reversible keyframe-command path you use**; the remaining gaps are depth items (GPU spatial effects, MP4/GIF muxing, AI ops beyond keyframes, a unified undo stack, and animatable non-scalar values).

---

## 16. Highest-leverage next steps (implied by the gaps)

1. **Implement GPU spatial effects** — enable `EffectPass` (blur/glow/drop-shadow materials) so the GPU path reaches Canvas2D parity; add native GPU mask/matte passes to retire the CPU-rasterize fallback.
2. **Broaden the AI op vocabulary** — add layer create/delete/restructure ops (and property/effect edits) to `aiEdit`/`applyOps` so the assistant can do more than keyframes, still reversibly.
3. **Real MP4/GIF export** — add an in-browser H.264/GIF muxer (or route through `motion-back`'s render jobs) instead of the WebM fallback.
4. **Non-scalar animation tracks** — color/gradient/vector keyframes to unlock animatable gradients, mask feather, and per-stop motion.
5. **Unify the three undo domains** — fold timeline-clip history and the store-snapshot history into the CommandSystem history for one coherent undo stack.
6. **Test the untested** — `src/core/ai/` and the stateful `AudioEngine` (voice reconciliation / seek drift) are the notable coverage holes.
7. **Consolidate** — merge the two backend-selection paths (`RendererFactory` vs `createRenderBackend`); replace `DemoPanels` with Scene-registered panels; refresh the stale in-code comments in `AppTextureProvider`/`snapshotToFrameScene`/`renderBackendStore`.
8. **Commit the working tree** — ~220 files of the newest work (3D, audio, precomps, offline render, path ops, cloud/AI) are uncommitted; the git history currently stops at "Prompt 6."
