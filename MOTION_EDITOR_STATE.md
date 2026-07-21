# Motion Editor — Full State & Feature Reference

> **Source of truth:** This document was reconstructed by reading the actual `.ts`/`.tsx`
> source (not the older `.md` docs). It describes what the code *actually* does today,
> including honest notes on what is stubbed, gated, or experimental.

**Product:** "Professional AI-native motion design application" — an After Effects-class
motion-graphics editor with a built-in AI director/agent.
**Stack:** React 18 + TypeScript + Vite + Electron 32, Zustand (+ immer) state, CSS Modules,
React Router (HashRouter). Backend = `motion-back` (NestJS + Prisma) as a separate service.

---

## 1. High-Level Architecture

The app is a **framework-independent engine core** (`src/core/*` and standalone `@motion/*`
packages) driven by a thin React UI that reads/writes the engine through **Zustand stores**,
a typed **EventBus**, and a **CommandSystem**.

```
                ┌─────────────────────────────────────────────┐
   React UI ───►│ Zustand stores  ·  EventBus  ·  CommandSystem │
                └───────────────┬─────────────────────────────┘
                                ▼
        SceneGraph + AnimationEngine ──► buildSnapshot() ──► RenderBackend ──► pixels
                                                              (Canvas2D | WebGL2 | WebGPU)
                                ▲
                     AI Agent (tools mutate the SceneGraph)
```

**Two runtimes from one renderer bundle:**
- **Browser / Vite dev** at `localhost:5173`; API/asset calls hit same-origin `/api`, `/files` (Vite proxy).
- **Electron desktop** loads from `file://` (prod); talks to the backend's absolute origin.

**Render pipeline is pure:** `SceneGraph` + `AnimationEngine` @ time → `buildSnapshot()`
produces an immutable, fully-resolved `RenderSnapshot` → a `RenderBackend` consumes it
(`renderFrame(snapshot) → pixels`). Backends hold no document authority. This is what makes
export deterministic and byte-reproducible.

**Packages (`@motion/*` aliases):** `renderer` (GPU), `scene` (ECS scene + 3D math),
`animation` (keyframe/expression engine), `timeline`, `workspace` (viewport/camera/tools),
`ai-tools` (shared AI tool vocabulary).

---

## 2. Application Flow

**Auth → Dashboard → Editor**, all via `HashRouter` (mandated by Electron `file://`).

- **Auth** (`AuthPage.tsx`) — one component, four modes: login / register / forgot / reset.
  Backed by `authStore`; privacy-conscious messaging. Already-authenticated users redirect away.
- **Dashboard** (`DashboardPage.tsx`) — fully wired to the backend. Six tabs:
  - **Home** — stat cards (projects, active renders, storage used) + recent projects.
  - **Projects & Drafts** — debounced server search, orientation filter, multi-select bulk
    trash, pagination, real metadata (updatedAt, layerCount, revision, resolution, fps).
  - **Assets Library** — upload/delete real assets with thumbnails, type filter.
  - **Render Queue** — real jobs with progress, status, cancel/download.
  - **Trash** — restore / permanent-delete with purge countdown.
  - **Settings** — profile/plan, storage, **AI Assistant setup**, Billing, Editor Preferences.
  - **Create project** = "Workspace Setup" modal (name, size presets, w/h/fps/duration,
    background) → creates cloud project → navigates to `/editor/:id`.
- **Editor** (`EditorPage.tsx`) — mounts `<Providers>` (boots the engine) wrapping the
  `EditorShell` UI. With a `:projectId` it also mounts three headless helpers:
  **ProjectLoader** (installs cloud file adapter, opens project once),
  **CloudAutosave** (debounced PUT of the whole document),
  **CloudThumbnail** (periodic poster-frame upload).

---

## 3. The Editor UI Surfaces

### Top chrome
- **TitleBar** — custom frameless window chrome (min/max/close via IPC).
- **TopNav** (AE-style, two rows) — tool groups (Pointer V / Direct-select A / Rotate W /
  Pan-behind Y / Hand H / Zoom Z; Pen G / Pencil / Brush / Curvature; Text; Shapes Rect Q /
  Ellipse / Polygon / Star / Line; Mask), a "New layer" dropdown (shape/text/solid/group/null/
  adjustment/comp-instance/camera/light/particle/audio/image-sequence/**Lottie import**), a 3D
  toggle, an Animate dropdown (presets + text rigs + easy-ease + stagger + slider rig), Snap
  toggle, Undo/Redo, Customize. Row 2 = contextual `ToolOptionsBar`.
- **App menu** — data-driven (`menuModel.ts`); in Electron the *native* menu forwards command
  ids to the same CommandSystem (no duplicated behavior).

### Left sidebar tabs
| Tab | Content |
|-----|---------|
| **Assistant** | AI chat panel (see §7) |
| **Templates** | Animated presets + full-scene templates + no-code authoring |
| **Scene** | Layer tree — search, drag reorder/reparent, hide/lock/solo, context menu (rename/duplicate/arrange/group/precompose/label-color/delete) |
| **Assets** | AE-style project bin: folders, import file/folder, drag to canvas |
| **Components** | Save selection as reusable component, insert/drag, delete |
| **Shapes** | 11 shape presets |
| **Text** | 10 styled text presets |

### Right inspector tabs
| Tab | Content |
|-----|---------|
| **Transform** | Transform (+3D), Parent & Link, Align & Distribute |
| **Style** | Text styles, text animators, Fill & Stroke, Blend & Matte, Layer Styles, Geometry & Path effects |
| **Effects** | Searchable categorized effect browser + Effect Stack + Masks |
| **Easing** | Big direct-manipulation curve editor (`MotionEditorPanel`) |
| **Presets** | Motion presets browser |
| **Settings** | Kind-specific (Camera/Light/Particle/Media/Precomp/Null/Audio) + Switches & Quality + Time & Playback |

On-demand panels (opened via commands): Project, History, Render Queue, Comments.

### Workspace viewport
Dual-canvas stage (content canvas keyed by backend + overlay canvas + text-edit overlay),
driven by the `@motion/workspace` engine. Keyboard nudge/delete/escape; full drag-and-drop
from library panels with screen→world placement. **ViewportHeader**: comp name, size label,
**Free vs Fixed** camera-lock toggle, motion-path controls, zoom/fit/grid/rulers/safe-areas/
channel/resolution.

### Timeline (`BottomTimeline`)
- **Transport & header:** timecode, layer/property filter search, play transport, add marker
  (layer or comp), Loop + Draft toggles, preview-resolution dropdown (Full/Half/Third/Quarter),
  Global Shy + Global Motion-Blur toggles, Split/Trim buttons, interpolation pills, Graph Editor
  toggle, row-height cycle, zoom. Real project tabs (main comp + opened group/precomp tabs).
- **Track grid:** layers derived from scene graph (front-most on top), nested groups, per-node
  clip bars. Select (shift/cmd additive), inline rename, drag reorder, reparent (pick-whip),
  visibility/lock/solo, blend mode, track matte, per-layer switches, label color, double-click
  to drill in (comp opens source / group opens tab / layer enters Focus Mode).
- **Properties & keyframes:** AE reveal shortcuts (U animated, UU all, P/S/R/T/A/M/L filters);
  stopwatch to animate; keyframe add/move/delete/drag; context menu (Easy Ease / In / Out /
  Linear / copy / paste-at-playhead / hold / roving); scrubbable per-property value fields
  (with math), auto-keyframe optional; RAM-preview green cache bar; work-area in/out.
- **GraphEditor** — value/speed curve editor synced to timeline scroll.

### Other surfaces
- **CommandPalette** (`Cmd/Ctrl+Shift+P`) — mode-aware: `>` commands, `@` layers, `#` comps,
  `:` timecode. (`Cmd/Ctrl+K` = Composition Settings.)
- **PresentationMode** — full-bleed player with seek/scrub, quality badges, download frame,
  export, fullscreen, keyboard shortcuts.
- **Comments & Review** — layer+timecode-anchored notes (localStorage), Draft→In-Review→
  Approved status chips + shareable review link.
- **History** — Photoshop-style visual snapshot list (jump non-destructively, pin named snapshots).
- **VersionHistoryPanel** — server-side cloud checkpoints (list/capture/restore).
- **RenderQueuePanel** — AE-style queue with per-job format/progress/status.
- **ExportDialog** — format/resolution + pre-flight warning of dropped features per renderer.
- **Onboarding** — 5-step first-run tour, AE-shortcuts toggle.
- **CustomizeDialog** — Shortcuts (rebind/disable/reset with conflict detection), Workspaces,
  Appearance (accent, theme, render backend).

---

## 4. Core Engine — What Actually Works

### Scene graph & layer types
Layer kinds (`SceneKind`): **group, null, shape, text, image, video, audio, camera, light,
adjustment, particle, comp (precomp/nested)**. Shape primitives: `rect`, `ellipse`, `path`
(bezier, open polylines, trim arcs).

Working, tested capabilities:
- Parenting, world-transform composition, anchor points, alignment, label colors.
- **3D:** per-layer 3D, scene camera with depth-of-field, lights (point/ambient/spot/parallel),
  materials, painter-order z-sorting via emitted matrix + depth.
- **Motion-graphics shape ops:** Repeater (AE-style copies), Trim Paths, path boolean/merge ops,
  auto-orient along motion path.
- **Time:** layer in/out, time-remap, stretch.
- **Precomps / nested comps & comp instances** (instances expanded at render time).
- **Image sequences.**
- Built-in seed scenes: default, SaaS Ad, Complex Showcase, UI components.

### Animation engine (`@motion/animation`)
- Keyframe interpolation with cubic-bezier easing (CSS semantics): linear, step, easeIn,
  easeOut, ease, easeInOut, autoBezier, continuousBezier, hold; spatial tangents; spring /
  roving / speed-graph sampling.
- **Expression language** — full AST + parser + evaluator: `wiggle`, `loopOut`, `valueAtTime`,
  `velocity`, `clamp`, `random`, `Math.*`, `layer()`, `thisComp`, audio, control rigs (`ctrl()`).
- Undoable keyframe editing, keyframe assistants (typewriter, bounce-in-words, spin-fade
  characters, tracking reveal), keyframe clipboard.
- **Effect params are keyframeable** via the same track path (`effect.<id>.<param>`).
- **~30 built-in animation presets** across Entrances / Exits / Emphasis / 3D / Text
  (Fade/Pop/Bounce/Slide/Rise/Drop/Spiral In; Zoom/Rotate Out; Spin/Pulse/Shake/Heartbeat/
  Elastic/Jelly/Glitch/Wiggle/Wind; Flip/Card-Flip/Swing/Depth/Orbit/Cinematic-Pan 3D;
  Typewriter/Bounce-Words/Spin-Fade/Tracking-Reveal text).

### Effects (28 types, multi-param & keyframeable)
blur, glow, drop-shadow, brightness, contrast, saturate, grayscale, sepia, hue-rotate,
hue-saturation, invert, **levels**, **curves**, **posterize**, **tint**, **channel-mixer**,
**gradient-ramp**, **fractal-noise**, **displacement-map**, **motion-tile**, **fill**,
**four-color-gradient**, **stroke**, **beam**, **sharpen**, **noise**, **keylight** (chroma key),
**echo** (temporal ghosting). (Plus wave-warp / turbulent-displace in the warp module.)

Also working: **blend modes** (per-layer), **track/alpha mattes** (alpha/luma + inverses),
**masks** (add/subtract/intersect, bezier, feather, expansion, inverted, animated),
**adjustment layers**, **layer styles** (shadow/glow), **motion blur** (multi-sample, shutter
angle/phase), **layer quality** (best/draft), **effect bake**.

### Other engine subsystems
- **Particles** — deterministic closed-form emitter (point/box/circle; circle/square/line/star
  shapes; birth rate, lifetime, speed, gravity, color start/end — all keyframeable).
- **Paint** — AE Paint effect (brush strokes in layer space, paint/erase), rich Fill (solid/
  linear/radial, multi-fill stack), multi-stroke outlines.
- **Text** — multi-line layout, alignment, letter spacing, rich per-character runs, full AE-style
  text animators (range selectors characters/words/lines; square/ramp/triangle/round/smooth
  shapes; per-glyph transforms), text-on-a-path, font catalog.
- **Rig** (character rigging, "Phase 1: pure math") — 2D affine, skeleton FK/bind pose, linear
  blend skinning, two-bone + FABRIK IK, mesh triangulation, auto-weighting. *Math foundation only
  — no confirmed full UI/render wiring yet.*
- **Lottie** — **importer** (parse → plan → apply; scalar transform tracks subset). Lottie
  *export* is transform-keyframe JSON only.
- **Audio** — Web Audio engine, playback, waveform generation, audio→keyframe RMS envelope
  (audio-driven animation), mixdown to WAV for export muxing.

### Rendering backends
- **Canvas2D** — default, reference backend, most complete.
- **GPU (`@motion/renderer`)** — WebGL2 + WebGPU + Null (headless/test) backends; RenderGraph
  passes (Clear/Background/Shape/Image/Video/Text/Mask/Composition/Effect/Overlay/Selection);
  shader registry (GLSL + WGSL), LUT shader, render-to-texture ping-pong for adjustments/mattes/
  motion-blur. **Experimental** and opt-in.

**Backend capability differences (honest):**

| Feature | Canvas2D | GPU |
|---------|----------|-----|
| GPU shader effects (gradient-ramp/fractal-noise) | ⚠️ fallback | ✅ |
| displacement-map / motion-tile | ❌ no-op | ✅ |
| Per-glyph text animators | ✅ | ❌ Canvas2D-only |
| Motion blur | ❌ **disabled per product requirement** | ✅ |
| Gradient fills | ✅ full | ⚠️ first stop only |
| Outline strokes over primitives | ✅ | ⚠️ "Canvas2D only for now" |
| Adjustment layers / track mattes / LUT effects | ✅ | ✅ (some paths still Canvas2D) |

`capabilities.ts` analyzes a document, picks the export backend, and **reports what it dropped**
rather than silently no-op'ing.

### Export / render
Formats: **webm, mp4, png, png-sequence, jpg-sequence, json (editable project), lottie, gif**.
- **Deterministic offline renderer** — fixed-timestep, frame time = `index/fps` exactly →
  byte-identical reproducible frames; AbortSignal cancellation.
- **WebM / GIF / PNG / JPG** — fully client-side (MediaRecorder; hand-written GIF89a/LZW encoder;
  zipped sequences).
- **MP4** — primary path uploads a JPG-sequence zip (+ mixed `audio.wav`) to the backend render
  API for server-side muxing; **falls back to local MediaRecorder MP4** when the backend is offline.

---

## 5. Command / Undo & Persistence

### Commands & undo
- Mature **CommandSystem** — engine-agnostic `Command` objects (id/label/shortcut/execute/undo),
  registry by id + chord, `CommandContext` with DI services, `HistoryService` (two stacks,
  capacity **500**, suspend/resume for AI macros, jump-to, rename), composite/macro commands,
  `ShortcutManager` (window-level capture, per-command enabled, double-tap `UU`, persisted
  user overrides, AE preset).
- **Note — two coexisting undo mechanisms:** the CommandSystem/HistoryService stack *and* a
  separate snapshot-based `historyStore` (records on Animation/Node/SceneGraph changes). Most
  scene/animation edits use the snapshot history; command-style actions use the command stack.
- Real cut/copy/paste for keyframes (relative-time, easing/tangents preserved) and layers.

### Persistence (three layers)
| Layer | Mechanism | Contents |
|-------|-----------|----------|
| App settings | `localStorage` (`motion-editor.settings`) | theme, workspace layouts, recent projects, onboarding, crash-recovery snapshot |
| **Project documents (primary)** | **Cloud backend** REST (`/projects/:id`, `/autosave`) | the real project store |
| Local project files | Electron FS (IPC) or browser File System Access API / localStorage VFS | `.motion` JSON when saving locally |

- **No `electron-store`** — settings are plain localStorage.
- `FileManager` auto-selects an adapter (Electron / Browser / cloud `ApiFileAdapter`).
- Document format: cloud stores the richer `EditorDocument` v1.1.0 (scene + animation + comps +
  timelines + motionBlur + guides).
- **Dual autosave:** local `AutosaveController` (60s → recovery snapshot; "Recover unsaved work?"
  modal next launch) **and** cloud `CloudAutosave` (~1.2s debounced PUT with revision bump).
  Cloud thumbnails uploaded at ≥2-min intervals.

---

## 6. Desktop / Platform Layer

- **Electron main** (`electron/main.ts`) — frameless window, security-correct
  (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, preload-only), privileged
  `local-file://` protocol for local assets, native File/Edit/View menu forwarding command ids,
  external links → `shell.openExternal`.
- **Preload bridge** — narrow typed surface (`window.motionEditor` / `window.electronAPI`);
  **no AI surface** (AI runs server-side). IPC: `project:open/chooseSavePath`, `file:read/write`,
  `window:minimize/maximize/close`, `app:version/quit`, `menu:command`.
- **Backend sidecar** (`electron/backend.ts`) — can spawn `motion-back` on :4000 using Electron's
  own Node, health-check, reuse, teardown. **Opt-in** (`MOTION_LOCAL_BACKEND=1`); default assumes
  you run `motion-back` yourself.
- **Packaging** (`electron-builder.yml`) — win NSIS installer, mac dmg, linux AppImage; bundles
  the `motion-back` backend as `extraResources` (portability caveat: needs a reachable DB — config
  suggests switching to SQLite for a truly portable installer).

**Run commands:**
- `npm run dev` — browser only (Vite).
- `npm run electron:dev` — full desktop dev (Vite + electron watch). *Requires `motion-back` on :4000.*
- `npm run electron:build` / `pack` / `dist` — production build & installers.
- `npm run typecheck`, `npm test`, `npm run lint`.

---

## 7. AI Subsystem (the headline feature)

Two layers: **`packages/ai-tools`** (pure tool vocabulary + JSON-schema validator + registry +
OpenAI/Anthropic/Gemini wire adapters) and **`src/core/ai`** (agent loop, scene-mutating tool
handlers, system prompt/context, multi-stage production pipeline, visual self-critique).

### Providers & models (BYOK via server gateway)
- **BYOK with a server-side gateway** — the editor never holds a provider key. Keys are stored
  **encrypted server-side**; only `{present, hint}` (masked tail) returns to the client. Model
  calls stream through `POST /ai/stream` on the backend, which owns the key + endpoint allowlist
  and pipes SSE bytes back.
- Three dialects: **openai, anthropic, gemini** (+ a metered first-party `motion` target).
- Default models: Anthropic `claude-sonnet-5`, OpenAI `gpt-4o`, Gemini `gemini-3.5-flash`.
- UI model suggestions: Claude (sonnet-5 / opus-4-8 / haiku-4-5), OpenAI (gpt-4o / gpt-4o-mini /
  o4-mini), Gemini (3.5-flash / 3.1-pro-preview) — users may type any id the provider accepts.

### Agent loop
1. **Router** (pure heuristic) classifies prompt → `trivial_edit` vs `generative`.
2. **Generative** runs the multi-stage pipeline to produce an execution plan, executed
   programmatically via the tool registry (roles resolved to created node ids).
3. **Sighted polish** — renders key frames and enters the direct tool loop with a critique prompt.
4. **Direct agent loop** — up to 22 turns: stream model → execute tool calls → feed results back;
   self-critique up to 2× with rendered frames; loop-guard nudges/aborts on repeated identical calls.
5. All writes land in **one undo transaction**. The UI always runs in `preview` mode → exposes
   **Apply / Discard**. Pipeline errors fail-safe into the direct loop.

### Multi-stage production pipeline (generative path)
9 LLM planning stages, each with strict JSON-schema validation + one-shot auto-repair:
Intent → Creative Director → Motion Spec → Storyboard (beats) → Scene Planner (per-beat) →
Animation + Camera Planner (per-beat) → Timeline Planner → Tool Planner (execution plan) →
Critique & Verification (deterministic verify + LLM repair). *(The "Stage Stubs" comment in code
is stale — the stages are actually wired.)*

### The 35 AI tools (what the AI can do to the scene)
**Read (7):** `describe_scene`, `read_tracks`, `evaluate_at`, `get_selection`,
`list_capabilities`, `list_presets`, `list_assets`.

**Write / low-level (16):** `create_layer` (shape/text/solid/null/group/camera/light/adjustment/
particle), `delete_layer`, `reparent_layer`, `update_layer` (props, 3D, motion-blur, 17 blend
modes, mattes), `set_keyframes` (batch, all easings + bezier), `remove_keyframes`, `set_easing`,
`set_expression` (full expression language), `add_effect` (28 types), `update_effect`,
`text_animator`, `create_media` (place asset), `create_media_from_attachment` (decode base64
attachment → upload → place), `create_mask`, `update_composition` (duration/fps/background only —
**width/height locked after creation**), `apply_preset`.

**High-level compose (12)** — the model is steered to prefer these; they compile to primitives
with built-in layout/stagger/easing/style: `add_scene`, `add_transition`, `add_background`,
`add_title`, `add_emblem`, `add_cards`, `stagger_in`, `add_camera_move`, `add_kinetic_title`,
`add_light_sweep`, `add_ambient_orbs`, `add_lower_third`. Named `style` aesthetics
(premium/minimal/bold/playful, apple/luxury/corporate/startup/fun).

### Visual self-critique ("the agent's eyes")
Renders the live scene to 3 JPEG stills (comp-times 0.35 / 0.7 / last frame, ≤1280px) via the
deterministic offline renderer and feeds them back as images with a critique prompt so the model
reviews and fixes its own output. Best-effort, degrades gracefully.

### Chat / streaming
- Per-provider SSE parsing over a shared reader; abort cancels fetch → gateway aborts upstream.
- Typed gateway errors (`no_key`, `auth`, `rate_limit`, `overloaded`, `context_length`,
  `coming_soon`, `upgrade_required`, `no_credits`, `cancelled`).
- **Server-side conversation persistence** per cloud project (ChatGPT-style; only prose turns
  stored, not tool traffic). History budget: last 24 turns; images kept for last 2 image turns.
- Chat UI: streamed text, per-tool activity labels, pipeline-stage tracker, plan checklist,
  provider/model picker, up to 3 image attachments, Apply/Discard preview.

---

## 8. Backend API Surface (`motion-back`)

Base `http://localhost:4000/api` (or same-origin `/api` in browser). Bearer JWT in localStorage.
- **Auth:** register / login / me / forgot-password / reset-password.
- **Projects:** paginated CRUD, `/autosave` (optimistic concurrency via `baseRevision`),
  thumbnail, trash/restore/permanent-delete, version history (save/restore).
- **Assets:** list / upload / delete (multipart).
- **Billing:** plans / me / checkout — **`paymentsEnabled` is false** until a provider is
  configured; entitlement is server-decided (webhook/operator), no client-side plan mutation.
- **AI:** keys (BYOK), conversations, `/ai/stream` gateway.
- **Render:** `/render` (mp4 server-muxed only), frame upload, poll, list, cancel.

---

## 9. Testing

- Jest (ts-jest, jsdom), multi-project (root + `packages/*`).
- **~166 test files** total: `src/` ≈ 116, `packages/` ≈ 50 (scene 13, workspace 13, renderer 9,
  animation 7, timeline 6, ai-tools 2).
- Best-covered: rendering, scene, effects; then template/paint/audio/timeline/text/export.
- **Big untested gaps:** the entire Electron layer (main/preload/backend sidecar),
  `Providers.tsx` (boot/command wiring), `App.tsx`/EditorShell (timeline logic), cloud adapters/
  autosave, PluginHost, most stores/UI components.
- ⚠️ Known measurement gotcha (from project memory): `npx jest` on OneDrive can silently run only
  a fraction of suites because online-only placeholder files read as symlinks — "green" locally
  can be meaningless unless mirrored to local disk.

---

## 10. Honest Status: Stubbed / Gated / Experimental

| Area | Status |
|------|--------|
| **Motion AI** (metered first-party) | Gated; messaged "still in development — connect your own key." BYOK is the working path. |
| **Billing / payments** | `paymentsEnabled` false; "Upgrade to Pro" only fires a toast. No real checkout flow. |
| **Dashboard "Actions" dropdown** | Hardcoded `disabled` — the one truly dead control. |
| **GPU (WebGL2/WebGPU) backend** | Experimental; several features still Canvas2D-only (adjustments, mattes, LUT color, first-stop gradients, per-glyph text). |
| **Motion blur on Canvas2D** | Code exists but hard-disabled "per product requirement"; enabled only on GPU. |
| **Component reuse** | Phase 1 = independent clones; live master→instance linking is a later phase. |
| **Pipeline "fast tier" models** | Hardcodes stale/retired ids (`gemini-1.5-flash`, `gpt-4o-mini`, `claude-3-5-haiku`) contradicting the current model list — a latent bug if that tier is ever used. |
| **Router** | Ignores its constructor options; purely heuristic (no model-based classification). |
| **Mask-shape animation as an AI tool** | Not exposed; reveals must use effect/layer animation. |
| **AI file import** | AI can only place already-imported assets (or decode prompt attachments), not import files itself. |
| **Rig subsystem** | Pure-math "Phase 1" foundation; no confirmed full render/UI integration. |
| **Lottie** | Import + export limited to scalar transform tracks (not full shape/expression fidelity). |
| **Plugin system** | Real in-process API + 2 demo plugins; no sandboxing, no external/marketplace loading. |
| **Local AI keys** | Can transiently sit in `localStorage` (`motion_editor_local_ai_key_*`) before server sync — minor security note. |

Beyond the above, the surveyed feature set (timeline keyframing, curve/motion editor, effects,
masks, templates, render queue, export, presentation, comments/review, history, version history,
command palette, onboarding, AI chat, customize) is wired to real engine/store/backend logic. No
"coming soon" / placeholder-panel strings were found in the UI.

---

## 11. Key File Map

| Area | Entry points |
|------|--------------|
| App boot / commands | `src/providers/Providers.tsx`, `src/core/application/Application.ts`, `src/core/bootstrap/registerCoreServices.ts` |
| Editor shell / timeline logic | `src/App.tsx`, `src/layout/EditorLayout/`, `src/layout/BottomTimeline/` |
| Render pipeline | `src/core/rendering/buildSnapshot.ts`, `RenderBackend.ts`, `Canvas2DBackend.ts`, `MotionRendererBackend.ts` |
| GPU renderer | `packages/renderer` (WebGL2/WebGPU/Null backends, RenderGraph, shaders) |
| Scene / animation | `src/core/scene/`, `packages/scene`, `packages/animation` |
| Effects | `src/core/effects/` (28 types, mattes, masks, blend, motion blur) |
| AI agent | `src/core/ai/AgentLoop.ts`, `toolHandlers.ts`, `buildContext.ts`, `pipeline/`, `packages/ai-tools` |
| AI chat UI | `src/layout/AiChat/`, `src/layout/Workspace/useAiChat.ts` |
| Backend client | `src/core/api/client.ts`, `env.ts`, `cloudDocument.ts` |
| Electron | `electron/main.ts`, `preload.ts`, `backend.ts` |
| State | `src/stores/*` (see §7 of exploration — ~40 Zustand stores) |
```
