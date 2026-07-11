# Motion Editor — Current State (Full Project Snapshot)

**Written:** 2026-07-11
**Kind:** Ground-truth status report — what actually exists in the code today, not the roadmap or the vision.
**Method:** Direct read of `src/`, `packages/`, `electron/`, config, and tests. Typecheck + full test suite were run. Where this contradicts `PRODUCT.md` / `DESIGN.md` / `docs/TECHNICAL_ARCHITECTURE.md`, this file is the reality; those are the target.

---

## 1. What Motion Editor is (in one paragraph)

Motion Editor is a **professional, non-destructive motion-design application** — a scene graph + a timeline + a canvas compositor, in the class of After Effects / Rive / Cavalry. It runs as **both a web app (Vite, `localhost:5173`) and an Electron desktop app**, sharing a single React 18 renderer. The interface is a calm, near-black "control surface": AE-style menu bar and tool row on top, a Scene/Assets sidebar on the left, a live canvas in the center, a Properties/Motion/Effects/History inspector on the right, and a progressively-disclosed timeline across the bottom. **The core creative loop is real and works end-to-end:** you can add layers, transform them on the canvas, keyframe their properties, scrub and play the timeline, watch them render, and export the result.

The product's headline claim — that it is **"AI-native," where an assistant edits your real document through the same reversible command path you use** — is, at this moment, **aspirational**. There is no LLM. What ships under "AI" is a small hardcoded library of motion presets. See §7.

---

## 2. Tech stack & health

| Area | State |
|---|---|
| **UI** | React 18, Zustand (state), Immer, Radix UI (dialog/popover/select/slider/tooltip), lucide-react (icons), react-colorful. |
| **Language/build** | TypeScript (strict-maxed: `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`, `noImplicitReturns`, …), Vite 5, `tsc -b`. |
| **Desktop** | Electron 32, electron-builder. Thin privileged shell (file IPC + native menu → renderer command system). |
| **Tests** | Jest + ts-jest + jsdom. |
| **Typecheck** | `npx tsc --noEmit` → **clean, 0 errors** (meaningful given the strict config). |
| **Test suite** | **41 test files, 279 tests, all passing (~20s).** Coverage concentrated in the engine packages + core animation. **No tests** for the AI subsystem or the CommandSystem. |
| **Version control** | ⚠️ **Not a git repository** — no history to inspect, no branches, no commit trail. |
| **AI/LLM deps** | **None** in `package.json`. No `openai`/`anthropic`/model SDK, no API keys, no network model calls anywhere in `src`. |

**How it launches**
- **Web:** `npm run dev` → Vite on `localhost:5173`. Build: `npm run build` (`tsc -b && vite build`) → `dist/`.
- **Electron:** `npm run electron:dev` (Vite + tsc watch + Electron concurrently). Main process (`electron/main.ts`) loads the dev URL or `dist/index.html`, registers file IPC (`project:open/save`, `file:read/write`) and a native menu that forwards command ids to the renderer's `CommandSystem`. Package: `npm run dist` (electron-builder).
- The renderer is host-agnostic: `FileManager.ts` has a `browser` adapter (File System Access API + localStorage VFS) and an `electron` adapter (`window.motionEditor` IPC) with graceful fallback, so the same UI runs in either.

---

## 3. Architecture at a glance

The codebase follows the onion/layered model in `docs/TECHNICAL_ARCHITECTURE.md` and is **mid-migration** from self-contained `src/core/*` engines toward a framework-independent `packages/@motion/*` monorepo.

```
┌─────────────────────────────────────────────────────────────┐
│ React shell  src/layout/*  src/components/*  src/stores/*    │  ← what the user sees
│   TopNav · LeftSidebar · Workspace(canvas) · Inspector ·      │
│   BottomTimeline · StatusBar · CommandPalette · overlays      │
├─────────────────────────────────────────────────────────────┤
│ App-side controllers / adapters  src/core/*                  │  ← the spine
│   Application(boot) · EventBus · ServiceContainer(DI) ·        │
│   CommandSystem · ShortcutManager · TimelineController ·       │
│   WorkspaceController+ports · SceneGraph(view) ·               │
│   AnimationEngine · Canvas2DBackend · exportManager · …        │
├─────────────────────────────────────────────────────────────┤
│ Framework-independent engines  packages/@motion/*            │  ← the "real" new core
│   @motion/scene · @motion/timeline · @motion/workspace ·      │
│   @motion/renderer (built but ORPHANED — see §6)              │
└─────────────────────────────────────────────────────────────┘
```

**The spine is real.** DI container (`ServiceContainer`), typed event bus (`EventBus`), command registry + undo/redo/shortcuts (`CommandSystem`), and a boot/lifecycle façade (`Application`) all exist, are implemented, and are wired at startup (`bootstrap/registerCoreServices.ts`). Mutations, events, and rendering flow through these.

**Data flow (the working loop):**
```
input (canvas tool / menu / shortcut / inspector)
  → scene/timeline/workspace mutation (via controller or port)
  → EventBus event (AnimationChanged / NodeUpdated / …) + sceneStore revision bump
  → re-derive: timeline tracks, inspector rows, render snapshot
  → Canvas2DBackend.renderFrame(snapshot) → pixels
  → renderCache marks the frame (feeds the timeline cache bar)
```

---

## 4. `packages/` — the four engines (~12,400 LOC, 229 tests)

Each is a standalone TS package with its own `package.json`, `README`, jest config, and `__tests__/`. Aliased as `@motion/*` in `vite.config.ts`, `tsconfig.json`, and `jest.config.cjs` — **except the renderer, which is aliased nowhere.**

### `@motion/scene` — Scene Graph  ✅ active source of truth
Full object-hierarchy engine: ECS-style `Component`/`TransformComponent`/`DataComponent`, ~15 typed node factories (rectangle, ellipse, text, image, video, camera, group, null…), O(1) id index with duplicate/collision prevention, **cycle detection**, reparenting, deep-clone duplicate, predicate queries, a `SelectionModel`, `TransformSystem` with dirty-flag world-matrix propagation, and **versioned serialization with a migration registry**. ~1,763 LOC src / ~40 tests. Consumed by `src/core/scene/SceneGraph.ts` (which calls it "the single source of truth").

### `@motion/timeline` — Timeline (clips/layers/markers)  ✅ active authority
Frames-canonical time system (`FrameRate`, ms/seconds/timecode). Every structural mutation (add/remove/move/duplicate track & layer, split, trim, setStart, group/ungroup, markers) routes through an **undoable `History` command**. Timer-free playback: `tick(dtMs)` advances the playhead with loop wrap-around. Markers at 3 scopes, zoom/scroll/fit navigation, work-area/loop ranges, serialization. ~2,497 LOC src / ~56 tests. Consumed by `src/core/timeline/TimelineController.ts`.
⚠️ **This package has no keyframes or interpolation** — it manages clip/layer/marker *structure* only. Property animation lives separately (§5, AnimationEngine).

### `@motion/workspace` — Interaction/viewport engine  ✅ active, deepest wiring
The interaction layer, wired via **ports** (`SceneGraphPort`, `SelectionPort`, `RendererPort`, `CommandPort`). Includes `Viewport`/`Camera`/`CameraAnimator` (eased), `CoordinateSystem`, `Grid`/`Guides`/`SnapEngine`, `HitTester` + `SpatialIndex`, `SelectionController`/`Marquee`/resize-rotate handle transforms, `CursorManager`, `InputSystem` (DOM-event normalization), a `ToolManager` with **9 built-in tools** (Select, Move, Hand, Zoom, Rectangle, Ellipse, Pen, Text, Camera), and a `WorkspaceCommands` bus. ~4,435 LOC src / ~85 tests (the most-tested package). Consumed by `src/core/workspace/{WorkspaceController,ports,geometry}.ts` and driven from React in `src/layout/Workspace/`.

### `@motion/renderer` — GPU renderer  ⚠️ BUILT BUT ORPHANED
A complete WebGPU-primary / WebGL2-fallback / Null-headless render-graph engine: `Renderer` façade, three backends, `ResourceManager`, shader/material systems, ~11 render passes (Background/Clear/Image/Shape/Text/Video/Mask/Effect/Selection/Overlay), `Camera2D`, `Viewport`. `WebGL2Backend.ts` is a genuine GL2 implementation (shader compile/link, std140 UBOs, FBO targets, instanced draws, blend state). ~3,754 LOC src / ~48 tests (headless against `NullBackend`).
**It is imported by nothing in `src/`** and aliased in no config. The live app renders through the simpler `src/core/rendering/Canvas2DBackend.ts` instead. This is the single biggest piece of finished-but-unintegrated code in the project.

---

## 5. `src/core/` — the app-side spine (substantially real)

Essentially **no stub/TODO-only directories.** Highlights:

- **animation/** — ⭐ One of the strongest engines, and **not yet extracted to a package.** `AnimationEngine.ts` is a full keyframe/track authority: sampling, easing, **compiled expressions** (`expressions.ts`), interpolation (`interpolate.ts`), and snapshot/restore for history. This is where all property animation actually lives. Has real unit tests.
- **rendering/** — `Canvas2DBackend.ts` (full compositor: camera transform, per-layer transform/opacity/CSS-filter effects, shapes/text/image/video, drop-shadowed 1920×1080 comp, grid/safe-area/ruler overlays) + `buildSnapshot.ts` (pure scene+anim→immutable `RenderSnapshot`, with solo/focus/ghost logic) + `renderCache.ts`. **This is the renderer the app runs on.**
- **commands/** — Real registry + `CommandSystem` (execute/undo/redo/history/shortcut dispatch) + `ShortcutManager` + `HistoryService`. Wired to the menu and command palette.
- **events/**, **services/**, **application/**, **bootstrap/** — typed EventBus, DI container + typed tokens, boot façade, composition root. All real, all wired.
- **scene/**, **timeline/**, **workspace/** — thin controllers/adapters over the `@motion/*` packages (SceneGraph "view", TimelineController, WorkspaceController + ports).
- **export/** — `exportManager.ts`: real **PNG / JSON / WebM (MediaRecorder, frame-by-frame) / Lottie** export via the actual Canvas2D backend. Wired to `ExportDialog`.
- **persistence/** — `AutosaveController` (interval + visibility/unload flush), `recovery.ts` (capture/restore scene+anim snapshots on boot), `ProjectService`/`ProjectSerializer`.
- **project/** — `ProjectManager` (new/open/save/saveAs/close, dirty flag, MRU) decoupled via `ProjectDocumentIO`; `RecentProjects`.
- **effects/** — visual-effect stack (blur/glow/color) compiled to a CSS filter string, stored on an `fx` component, consumed by the renderer, edited by `EffectsPanel`.
- **files/**, **settings/**, **theme/**, **logging/**, **loading/**, **plugins/**, **collab/**, **inspector/**, **assets/** — all small-to-medium but **functional** (file adapters, persisted settings, light/dark/system theme, ring-buffer logger, busy/progress tracker, runtime plugin host, base64-URL project sharing for review, property editor registry, map-backed asset registry).

**Known residue / debt inside core:**
- `core/timeline/TimelineEngine.ts` — an **older, orphaned** mini-engine, superseded by `TimelineController` over `@motion/timeline`. Only referenced by its own test + the stale barrel. Dead weight.
- `core/index.ts` barrel is **stale** — still exports the dead `TimelineEngine`; most real modules are imported by deep path instead.
- Two event mechanisms coexist by design: the app `EventBus` + the packages' own internal emitters (`timeline.events`, workspace), bridged in the controllers.

---

## 6. The runtime the user actually sees

Entry: `index.html` → `src/main.tsx` (`createRoot` → `<ErrorBoundary><App/>`) → `App.tsx` → `<Providers><EditorShell/></Providers>`.

**Panels that render real content:**
- **TopNav** — AE-style menu bar + tool row (Select/Move/Rotate/Scale/Pen/Text/Shape, Insert shape/text/group, Preview, Export, AI sparkle).
- **LeftSidebar** — **Scene** tree (live) + **Assets** panel (⚠️ hardcoded `SAMPLE_ASSETS`, the one clearly mock panel).
- **Workspace (center)** — real dual-canvas viewport (content + interaction overlay); draws the live scene, selection box/handles, marquee, snap lines.
- **RightInspector** — Properties, Motion (curve editor), Effects, Comments, History.
- **BottomTimeline** — timecode + transport + one summary row per layer, expanding into per-property keyframe sub-rows; clip bars, markers, work area, render-cache bar.
- **StatusBar** — live layer/selection count, FPS meter, live timecode, ⌘K search.
- **Overlays** (mounted in `Providers`) — CommandPalette, Presentation mode, Onboarding tour, Modal host, Context-menu host, Notification host.

**Seed content:** a 1920×1080 / demo composition with 5 real layers (circle, rectangle, text "Hello", logo image, background video) and a demo animation (circle bounce/spin, rect rotate/fade). This is placeholder *content* standing in for a real project load — the load/persistence plumbing exists.

---

## 7. The "AI" reality (important)

**What the docs promise** (`PRODUCT.md`, `TECHNICAL_ARCHITECTURE.md`): an assistant reads the document and proposes **typed, reversible edits through the same Command/undo path the user uses** — "nothing it does is ever unaccountable or unrecoverable."

**What actually ships:**
- `src/core/ai/suggestions.ts` — a **static dictionary of 5 canned animations** (`reveal`, `spin`, `float`, `pop`, `headline`), each an `apply(nodeId, t)` that writes fixed keyframe values. A `BY_KIND` table maps a layer's kind to a preset list; `useSuggestions.ts` filters by selection minus dismissals. It is a deterministic lookup table with a sparkles icon — **no model, no generation, no reasoning, no network.**
- `AiPromptBar.tsx` (the "chat") is an explicit **UI-only stub** — the send button has **no handler**; the panel shows placeholder text. Its own comment says AI logic "plugs in later behind onSubmit."
- **The one true thing:** applying a preset authors *real, editable keyframes* on the Animation Engine, which do appear in the timeline and can be dragged/retimed/deleted like hand-made ones. So the "everything stays editable" principle holds.
- **The gap vs the promise:** presets call `AnimationEngine.setKeyframe(...)` **directly**. That path touches **neither `CommandSystem` nor `HistoryService`** — in fact **no keyframe-editing command exists anywhere.** So AI-authored (and hand-authored) keyframe edits sit *outside* the typed command/patch protocol the architecture describes, and are not reversible through the command/undo stack the docs advertise (undo for them, where it exists, relies on the coarser snapshot-based recovery mechanism, not command patches).

**Verdict:** the "AI-native" positioning is currently **mock/aspirational**. The command foundation is real; the AI layer that is supposed to ride it does not.

---

## 8. Can a user create motion, 0 → advanced, right now?

Traced through real code. **The central loop works; the ceiling is intermediate.**

### ✅ Level 0 — Basics (fully working)
- Insert a shape / text / group (TopNav Insert, or draw with the Rectangle/Ellipse/Text/Pen tools).
- Select (canvas click + hit-test, Scene tree, or timeline track); see selection box + handles.
- Move / resize / rotate on canvas (engine tools → CommandPort → scene graph), arrow-key nudge, or numeric inspector edits.
- Pan/zoom the camera, zoom-to-fit, toggle grid / safe-area / rulers.

### ✅ Level 1 — Keyframe animation (fully working)
- Turn on a property's stopwatch in the Properties panel → sets a keyframe at the playhead.
- Add/move/delete keyframes directly on the timeline; expand a layer (chevron or AE `U`/`P`/`S`/`R`/`T` reveal shortcuts) to see per-property sub-rows.
- Scrub the playhead; press play → `usePlaybackClock` pumps the engine, `AnimationEngine.evaluateScene(t)` samples values, `Canvas2DBackend` draws each frame. The seeded circle bounces/spins live.
- Undo/redo (for structural scene/timeline ops), work area + markers, clip trim/split/move, autosave + crash recovery.

### ✅ Level 2 — Intermediate (working)
- **Bezier easing** in the Motion curve editor (drag handles, easing presets).
- **Multiple animated property tracks** per layer.
- **Expressions** — property values driven by compiled expressions, evaluated per frame (`ExpressionEditor` → `expressions.ts`).
- **Effects** — blur / glow / color, applied as CSS filters via the `fx` component.
- **Focus mode** (enter a group / isolate a leaf), presentation mode, command palette (⌘K), theming.
- **Preset "AI" motions** (reveal/spin/float/pop/headline) that drop in as editable keyframes.
- **Export** to PNG / JSON / WebM / Lottie.

### ❌ Not yet (the advanced ceiling)
- **Real AI authoring** — no LLM; no natural-language "animate this" (§7).
- **GPU rendering / real shaders / blend modes / masks at the pixel level** — the finished `@motion/renderer` is orphaned; the app runs on Canvas2D. Effects are CSS-filter approximations, not GPU passes.
- **3D** — layer-3D category hues exist in the design system, but no 3D transform/camera pipeline is wired.
- **Precomps / nested compositions / time-remapping** — modeled in the vision, not implemented.
- **Real asset import** — the Assets panel is mock data; no import pipeline (SVG/Lottie/AE/video-decode) into the document.
- **Deterministic offline export** — WebM export uses real-time `MediaRecorder` capture, not the fixed-timestep full-quality offline render path the TAD specifies.
- **Command-routed keyframe edits** — keyframe editing bypasses the CommandSystem (§7), so the "every edit is a typed undoable command" guarantee is not yet true for animation.

**Bottom line:** today a user can genuinely build a real 2D keyframe animation — layers, eased curves, expressions, effects, playback — and export it. What they *cannot* yet do is the stuff that defines the product's differentiation and its "advanced" tier: talk to an AI that edits the document, render on the GPU, work in 3D, nest compositions, or import real assets.

---

## 9. Honest scorecard

| Subsystem | State |
|---|---|
| Scene graph (`@motion/scene`) | ✅ Real, tested, authoritative |
| Timeline structure (`@motion/timeline`) | ✅ Real, tested, undoable, authoritative |
| Workspace/tools/hit-test/snap (`@motion/workspace`) | ✅ Real, most-tested, authoritative |
| Animation (keyframes/easing/expressions) | ✅ Real, tested — but lives in `src/core`, not a package, and bypasses CommandSystem |
| Canvas2D rendering + snapshot pipeline | ✅ Real, this is what runs |
| Command/DI/EventBus/shortcuts/boot spine | ✅ Real, wired |
| Export (PNG/JSON/WebM/Lottie) | ✅ Real (WebM = realtime capture, not offline render) |
| Autosave / recovery / project I/O / theming / settings / files | ✅ Real |
| Effects (CSS-filter blur/glow/color) | ✅ Real, but not GPU |
| GPU renderer (`@motion/renderer`) | ⚠️ Built & tested, **orphaned** (unused) |
| Assets panel | ⚠️ Mock data |
| **AI (chat + document authoring)** | ❌ **Stub / preset picker, no LLM, bypasses command path** |
| 3D / precomps / asset import / offline render | ❌ Not implemented |
| Legacy `core/timeline/TimelineEngine.ts`, stale `core/index.ts` barrel | ⚠️ Dead residue |
| Git / version control | ⚠️ Not a repo |

**One-sentence summary:** Motion Editor is a **real, strict-typed, well-tested 2D keyframe motion editor** with a serious engine foundation (scene/timeline/workspace packages + a working Canvas2D renderer and animation engine) and a fully functional create→keyframe→play→export loop — but its headline "AI-native" differentiator is not yet built, its finished GPU renderer is unwired, and animation edits still bypass the very command system the architecture is designed around.

---

## 10. Highest-leverage next steps (implied by the gaps)

1. **Route keyframe edits through `CommandSystem`** — make the documented "every edit is a typed, undoable command" true for animation (currently the biggest promise/reality gap after AI).
2. **Wire a real AI path** — give `AiPromptBar.onSubmit` a provider that emits typed commands/patches (the command layer it needs already exists).
3. **Integrate `@motion/renderer`** — swap Canvas2D → the orphaned WebGL2/WebGPU render graph behind the existing `RenderBackend` port, unlocking real GPU effects/blend/masks.
4. **Real asset import** — replace `SAMPLE_ASSETS` with an import pipeline feeding `AssetService`.
5. **Extract animation into `@motion/animation`** and delete `core/timeline/TimelineEngine.ts` + prune the stale `core/index.ts` barrel.
6. **`git init`** — the project has no version control.
