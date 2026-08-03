# Premation (motion-editor) — Complete Reference

**One file. Everything the product is, everything it does, how each thing is wired, how to work in it, and where it honestly stands against the competition.**

| | |
|---|---|
| **Product name** | Premation |
| **Repository slug** | `motion-editor` (do NOT rename — `motion-editor.*` localStorage keys depend on it) |
| **Version** | `0.1.2` (pre-1.0) |
| **License** | AGPL-3.0-only |
| **Written against** | commit `faef1c3`, branch `fix/wiring-audit`, 2026-08-03. §16.2 and §16.3 updated 2026-08-03 on `fix/gate-ai-local-and-ship` — both are now closed |
| **Repo path** | `C:\Users\isroi\dev\motion-editor` |
| **Stack** | Electron 32 + React 18 + TypeScript 5.6 + Vite 5 + Zustand 4 |
| **Renderer** | One GPU render graph: WebGPU, falling back to WebGL2. No software rasteriser. |
| **Size** | ~230,000 lines TS/TSX across `src/` (~165k) and `packages/` (~66k) |
| **Tests** | 418 test files; ~440 suites / ~4,800 tests, under a minute. Plus a golden-image GPU harness. |

> **Method note.** Every count, list and claim in this document was read out of the source at the commit above, not from the `.md` docs. Where this document contradicts another doc in `docs/`, this one was checked later.
>
> `README.md` and `ROADMAP.md` were both stale on a major point when this was written; both have since been rewritten (§16.3), so that warning no longer applies to them. It still applies to this document: §16.2 was itself wrong about one thing, corrected in place there.

---

## Table of contents

1. [What Premation is](#1-what-premation-is)
2. [The two editions](#2-the-two-editions)
3. [Running and building it](#3-running-and-building-it)
4. [Architecture — the whole map](#4-architecture--the-whole-map)
5. [The document model](#5-the-document-model)
6. [The render pipeline](#6-the-render-pipeline)
7. [Complete feature inventory](#7-complete-feature-inventory)
8. [The AI layer](#8-the-ai-layer)
9. [Plugins](#9-plugins)
10. [Export and the render queue](#10-export-and-the-render-queue)
11. [Persistence, versions, sync](#11-persistence-versions-sync)
12. [The UI surface — complete](#12-the-ui-surface--complete)
    · [design system + tokens](#120-the-design-system) · [region map](#121-region-map) · [TitleBar](#122-titlebar) · [TopNav](#123-topnav--the-tool-row) · [left sidebar](#124-left-sidebar--5-panels) · [right inspector](#125-right-inspector--8-panels) · [canvas](#126-the-canvas-workspace) · [modals](#128-modals-and-dialogs) · [context menus](#1210-context-menus) · [undo model](#1212-undo--history-model) · [assets & proxies](#1213-assets-proxies-and-media) · [focus mode](#1214-focus-mode-and-navigation) · [panels](#1215-panels--the-registry) · [tools](#1216-tools--the-registry-20-classes--2-overlay-tools) · [preferences](#1219-workspaces-and-preferences)
13. [Keyboard reference](#13-keyboard-reference)
14. [Workflows — step by step](#14-workflows--step-by-step)
15. [Quality gates and testing](#15-quality-gates-and-testing)
16. [Honest state — partial, missing, broken](#16-honest-state--partial-missing-broken)
17. [Competitive comparison](#17-competitive-comparison)
18. [File map — where everything lives](#18-file-map--where-everything-lives)
19. [Glossary](#19-glossary)

---

## 1. What Premation is

Premation is a **desktop motion-design and animation editor** modelled on **After Effects' Classic 3D workflow**. It is a timeline-and-keyframe compositor, not a web animation toy and not a 3D DCC.

The one-paragraph version:

> You create a composition, stack layers in it (shapes, text, images, video, audio, SVG, Lottie, nested comps, cameras, lights, nulls, adjustment layers, particles), animate any numeric property with keyframes on a timeline, shape those keyframes in a bezier graph editor or drive them with expressions, composite the stack with 36 blend modes / masks / track mattes / 10 layer styles / 38 effects, flip layers into a shared 3D space with real cameras, lights and shadows, deform them with bone or puppet rigs — and then export the exact frames you saw in the viewport, because the viewport and the exporter run the *same* GPU render graph.

**Three things that define the product's shape:**

1. **One engine.** There is no "preview renderer" and "export renderer". `buildSnapshot` produces one immutable frame description; `packages/renderer` draws it. The viewport and the offline exporter both call it. WYSIWYG is structural, not aspirational.
2. **Local-first.** A project is a `.motion` **directory bundle** on your disk. Assets are content-addressed by SHA-256. Version history is local and structurally shared. The local edition makes *zero* network requests — the API layer refuses to send.
3. **AE muscle memory is a feature.** Tool shortcuts, panel layout, reveal keys (`P`/`S`/`R`/`T`/`U`), `F9` easy-ease, `Alt+[`/`]` trim, `[`/`]` move-layer-to-playhead, two-level motion blur gating, the 2D-layer-as-wall 3D sorting rule — all replicated deliberately.

**What it is explicitly NOT:**

- Not an AE Advanced 3D competitor — no imported 3D models, no PBR materials, no HDRI environments. Extrusion and bevels exist as an extension beyond Classic 3D, but the target is flat planes in 3D space.
- Not a collaboration tool. Review comments, approvals and shareable review links were **removed outright**, not gated. There is no multiplayer.
- Not a motion-tracking / rotoscoping tool. Out of scope by direction.

---

## 2. The two editions

One source tree, two builds, selected at build time by `VITE_EDITION`. The dividing line is exactly *"does a backend service exist"*.

| | **local** (`VITE_EDITION=local`) | **server** (default) |
|---|---|---|
| Accounts / sign-in / OAuth | absent — opens straight into the editor | required |
| Projects | on disk, `.motion` bundle | cloud, with autosave + thumbnails |
| Assets | on disk, content-addressed SHA-256 | cloud library |
| Version history | local `versions/` store | server-side |
| Encrypted project sync | absent | available (paid) |
| Billing / plans | absent | LemonSqueezy |
| Plugin registry (hosted) | absent — local `.zip`/folder install still works | available |
| AI assistant | **enabled**, BYOK via OS keychain + Electron main process | enabled, via hosted gateway |
| Export | local ffmpeg | local ffmpeg |
| Network | **none at all** — API layer refuses to send | full |

**The critical rule (enforced by convention, stated in `src/core/config/edition.ts`):** read the **capability predicate**, never the edition.

```ts
cloudAccountsEnabled()    // sign-in, registration, OAuth, sessions
cloudProjectsEnabled()    // dashboard, cloud autosave, cloud version history
billingEnabled()          // plans, checkout
cloudSyncEnabled()        // the opt-in client-encrypted sync vault
aiEnabled()               // → true in BOTH editions (both are BYOK)
aiRunsThroughBackend()    // → only difference: WHO holds the key
pluginRegistryEnabled()   // hosted registry browse/update
```

`billingEnabled()` says *why* the code is gated. `isLocalEdition()` only says *where it happens to be true today*.

---

## 3. Running and building it

```bash
npm install
```

**Desktop app, OSS edition (the normal one to build):**

```bash
npm run electron:dev:local
```

**Renderer only, in a browser tab** — faster iteration, but no filesystem, no native menus, no ffmpeg export:

```bash
npm run dev:local
```

Drop the `:local` suffix to build the `server` edition; it will sit on a sign-in screen without a backend.

**Requirements**
- Node 20+
- A GPU with WebGPU or WebGL2. There is **no software fallback**.
- **ffmpeg** — for `.mp4` / `.mov` export only. Everything else (including WebM/GIF/PNG/Lottie) works without it. Lookup order: `$FFMPEG_PATH` → binary bundled next to the packaged app → `ffmpeg` on `PATH`. If none is found, mp4 export fails with a message saying exactly that and nothing else is affected.

**All scripts**

| Script | What it does |
|---|---|
| `npm run dev` / `dev:local` | Vite renderer only |
| `npm run electron:dev` / `:local` | compile main → Vite → Electron, with HMR |
| `npm run build` / `build:local` | `tsc -b && vite build` |
| `npm run electron:build` / `:local` | renderer build + main-process compile |
| `npm run pack` / `pack:local` / `pack:selfhosted` | unpacked app dir, no publish |
| `npm run dist` / `dist:local` / `dist:selfhosted` | full installers |
| `npm test` | jest — ~440 suites / ~4,800 tests |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | eslint 9 flat config |
| `npm run render-tests` / `:update` | golden-image GPU harness (real Chromium) |
| `npm run release:patch/minor/major` | `npm version` → tag → GH Actions draft release |

> **Trap (recorded):** this repo must NOT live under OneDrive. OneDrive hides test files from jest (13 suites went invisible) and breaks `git stash`.

---

## 4. Architecture — the whole map

### 4.1 The layer cake

```
┌──────────────────────────────────────────────────────────────────────┐
│  electron/          main process: windows, IPC (46 channels), native  │
│                     menus, ffmpeg spawn, OS keychain, SQLite index,   │
│                     auto-update, AI key vault + provider proxy        │
├──────────────────────────────────────────────────────────────────────┤
│  src/routes/        AppRouter (HashRouter) + RequireAuth              │
│  src/pages/         EditorPage, DashboardPage, auth pages             │
│  src/layout/        29 panel/surface families (38k lines)             │
│  src/components/    36 UI primitives (Button, Slider, ColorPicker…)   │
│  src/stores/        47 Zustand stores (6.9k lines)                    │
├──────────────────────────────────────────────────────────────────────┤
│  src/core/          41 subsystems (110k lines) — the application core │
│    commands  scene  effects  animation  text  rendering  export  ai   │
│    plugins  project  persistence  sync  template  library  rig  audio │
│    particles  paint  svg  lottie  timeline  workspace  settings  …    │
├──────────────────────────────────────────────────────────────────────┤
│  packages/          12 engine packages (66k lines), pure & testable   │
│    scene  animation  timeline  workspace  renderer  audio             │
│    ai-tools  caster  technique-library  design-system                 │
│    product-motion  render-tests                                       │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.2 The twelve packages

| Package | Files | What it owns |
|---|---|---|
| `@motion/scene` | 39 | Scene graph, nodes, components, transforms, hit-testing, serialization, systems |
| `@motion/animation` | 18 | Keyframes, easing, interpolation, data tracks, **expressions** (own lexer/parser/evaluator), Lottie path maths |
| `@motion/timeline` | 29 | Timeline model: clips, layers, tracks, markers, playhead, ranges, selection, history, frame-rate/time types |
| `@motion/workspace` | 57 | Viewport interaction: camera, coordinates, grid, guides, hit-test + spatial index, input, marquee, selection, gizmos (incl. 3D), snapping, **20 tools** |
| `@motion/renderer` | 71 | The GPU render graph: WebGPU + WebGL2 backends, shaders, passes, resources, raster, camera, viewport |
| `@motion/audio` | 3 | Audio analysis primitives |
| `@motion/ai-tools` | 20 | The **62-tool registry** the assistant calls, plus provider adapters (Anthropic / OpenAI / Gemini) and SSE |
| `@motion/caster` | 7 | Deterministic generative pipeline: brief → cast → sequence → emit |
| `@motion/technique-library` | 16 | Hand-authored motion techniques (entrance ×4 files, kinetic ×2, scene ×2) with schema + lint |
| `@motion/design-system` | 24 | Look packs, colour, type, grid, shape, depth, surface, stage, devices + template families |
| `@motion/product-motion` | 12 | UI/UX motion as its own discipline: springs not beziers, 200–300ms budgets, shared-element transitions, no motion blur |
| `@motion/render-tests` | — | Golden-image harness driving real Chromium |

### 4.3 The command layer

Everything that mutates state from user input goes through **one** registry.

```ts
interface Command {
  id: CommandId; label: string; description?: string; icon?: string;
  enabled?: () => boolean;      // menus grey out
  isChecked?: () => boolean;    // menus show toggle state
  shortcut?: KeyChord;          // registered independently
  execute(ctx: CommandContext): void | Promise<void>;
  undo?(ctx): void | Promise<void>;
}
```

- **Engine-agnostic** — no React, no DOM inside `execute`.
- **Idempotent registration** — re-registering an id replaces it.
- **Observable** — the menu bar, the command palette (`Ctrl+K`) and the shortcut settings all render *from the registry*, so there is exactly one source of truth for a feature's label, availability and chord.
- **Undoable** via `IUndoableCommand` + `CompositeCommand` (undoes in reverse order).

The app menu (`src/layout/Menu/menuModel.ts`) is a **data-only model** — 9 groups, 63 items, each naming a command id. Audited 2026-08-03: **all 63 resolve to a registered command**; the panel registry and renderer map are 1:1 with no orphans on either side; there is not a single `TODO`/`FIXME` marker in `src/`.

Shortcuts are rebindable per command with a **conflict detector**, persisted through `SettingsManager`, applied over registry defaults by `ShortcutManager`. The default preset is the **AE keymap**.

### 4.4 State: 47 Zustand stores

Grouped by what they own:

| Domain | Stores |
|---|---|
| Document | `projectStore` `compositionStore` `sceneStore` `componentStore` `assetStore` `templateStore` `projectLibraryStore` |
| Selection & edit | `selectionStore` `keyframeSelectionStore` `faceSelectionStore` `textEditStore` `paintStore` `easeClipboardStore` |
| History | `historyStore` (+ baseline & granularity tests) `versionHistoryStore` |
| Viewport | `guidesStore` `workspaceViewStore` `renderBackendStore` `renderQualityStore` `motionBlurStore` |
| UI shell | `layoutStore` `uiStore` `modalStore` `contextMenuStore` `commandPaletteStore` `focusStore` `infoStore` `preferenceStore` `onboardingStore` |
| Output | `renderQueueStore` `presentationStore` |
| Account / cloud | `authStore` `entitlementStore` `cloudProjectStore` `aiProviderStore` |
| Extensibility | `pluginStore` |

### 4.5 Event bus

`getEventBus()` carries cross-cutting signals that would otherwise force prop-drilling or circular imports — e.g. `RevealAnimatedProps` (the `U` key), scene-revision bumps, effect/blend/matte writes. Typed in `src/core/events/EventTypes.ts`.

### 4.6 Electron main process

46 IPC channels, grouped:

| Group | Channels |
|---|---|
| Window | `window:minimize/maximize/close`, `popout:spawnWindow` |
| App | `app:version`, `app:quit`, `diag:gpuReport` |
| Files | `file:read/write`, `project:open`, `project:chooseSavePath`, `project:openBundleDir` |
| Bundles | `bundle:read/list/remove/writeAtomic` |
| Content-addressed blobs | `blob:has/read/write/remove/list` |
| Media | `media:probe` (incl. alpha detection), `proxy:cancel` |
| Render | `render:beginJob/cancel/clean/save/saveTo/chooseOutputDir/stageAudio` |
| Local index (SQLite) | `index:available/upsertProject/getProject/listProjects/removeProject/markMissing/addRecovery/listRecovery/clearRecovery` |
| Secrets | `credentials:available/get/clear`, `aiKeys:available/status/clear`, `ai:cancel` |
| Auth | `oauth:openExternal` |

Plus `updater.ts` — electron-updater against the GitHub release, `autoDownload = false`, consent-gated, **not** pointed at any first-party backend so it keeps working for self-hosters.

---

## 5. The document model

### 5.1 Scene graph

A **scene** is a tree of `SceneNode`s. A node has a transform, a `kind`, and a list of **components** carrying props. Components are the authority — writing `node.transform` directly instead of through the transform component is a known way to lose the edit (`components.push()` on a copy is discarded).

**Node kinds** (13):

| kind | Meaning |
|---|---|
| `group` | Folder / precomp-less grouping |
| `null` | Null object — transform-only parent target |
| `shape` | Vector shape layer (paths, fills, strokes) |
| `text` | Text layer (rich text, per-glyph) |
| `image` | Still image |
| `video` | Video, with optional audio track |
| `svg` | Imported SVG (hybrid: intact layer or converted tree) |
| `audio` | Audio-only layer |
| `camera` | 3D camera |
| `light` | 3D light |
| `adjustment` | Adjustment layer — effects apply to everything beneath |
| `particle` | Particle emitter |
| `comp` | Composition instance (precomp / nested comp) |

**Per-layer switches** live on an `fx` component so history, autosave and export capture them for free: effects stack, blend mode, track matte, motion blur, adjustment flag, 3D flag, quality, collapse-transformation, layer styles, masks, puppet rig, skeleton rig, path operator, trim, repeater, text path.

### 5.2 Animation model

- A **track** is `(nodeId, prop)` → keyframes. Prop paths are strings, including nested ones: `effect.<id>.<param>`, `effect.layerstyle:<style>.<param>`, `trim.start`, `rep.copies`, `path.points`, `puppet.pin.<id>.x`.
- A **keyframe** carries `time`, `value`, `easing`, `bezier` handles, a linked-tangent flag, `roving`, and spatial tangents for positional data.
- **Easing presets**: Linear, Ease, EaseIn, EaseOut, Hold. Per-keyframe interpolation, per-side.
- **The single time axis rule:** `getRemappedTime()` is the **only** keyframe time axis sampled. Comp time → layer time conversion (`compToKeyframeTime` / `keyframeToCompTime`) accounts for clip start, stretch and time-remap. Keying at raw comp time lands on the wrong frame for any trimmed or stretched layer — this is the single most common class of bug in this area.
- **Layer styles ARE keyframeable** — tracks land on `effect.layerstyle:<style>.<param>`, and the render emit gates must accept an animated style even when its static value looks inert.

### 5.3 Expressions

Not `new Function`. A **hand-written lexer / parser / evaluator** (`packages/animation/src/exprLang.ts`, 438 lines) with a callee safety check. That is what makes expressions work under the packaged app's CSP — the same constraint that killed the AI path's `set_expression` until it was rebuilt.

**API surface:** `time`, `value`, `wiggle`, `loopIn`/`loopOut`, `valueAtTime`, `velocity`, `speed`, `linear`, `ease`, `clamp`, `layer`, `thisComp`, `thisLayer`, `thisProperty`, `audio`, and `ctrl()` for expression-control rigs.

**Evaluation guarantees:**
- Cross-layer reads are live: `layerAt(name, prop, t)`.
- **Cycle detection** at the engine level.
- **Depth-16 chain cap.**
- Self-reference is *structurally* prevented: `selfAt` samples keyframes only, never the expression-adjusted value, so `valueAtTime` cannot recurse through its own expression.
- Errors are surfaced per property (`getExpressionError`), not swallowed.

### 5.4 Compositions

- Multiple comps per project, with a registry (`comps` in `meta.json`).
- **Comp instances** (precomps) nest, with **collapse transformations** implemented.
- Comp settings: size, frame rate, duration, background.
- Composition presets, and per-comp motion-blur master gate.

---

## 6. The render pipeline

```
Scene graph + Animation tracks + Timeline state + Guides + comp settings
        │
        │  buildSnapshot(t)              ← src/core/rendering/buildSnapshot.ts
        │    • sample every animated prop at the LAYER's time
        │    • evaluate expressions
        │    • resolve parenting → world matrices
        │    • resolve comp instances / precomps (with collapse)
        │    • text layout → PlacedGlyphs (+ per-char 3D, animators)
        │    • shape path ops → trim → repeater → merge
        │    • rig deform → layer.deformedMesh
        │    • particles → closed-form positions at t
        │    • painter-sort 3D layers, honouring the 2D-layer-as-wall rule
        │    • motion-blur sample times (shutter angle + phase)
        ▼
   FrameSnapshot  (immutable, pure data, no engine handles)
        │
        │  snapshotToFrameScene
        ▼
   FrameScene ──► RenderGraph passes ──► WebGPUBackend | WebGL2Backend | NullBackend
        │            (CompositionPass, effect passes, blend/stencil groups)
        │
        ├──► viewport canvas          (interactive)
        └──► offlineRenderer          (export — SAME graph, same code)
```

**Invariants that make this trustworthy:**

- **Alpha is PREMULTIPLIED everywhere**, converted at *decode* time. Both upload flags mean "destination premultiplied."
- **Backend resolution:** check `resolvedKind`, not `kind` — the test harness's swiftshader flag suppresses Dawn, so a harness that "ran WebGPU" may never have.
- **Canvas ownership** is tracked in a `WeakSet` — a canvas that got a 2d context can never be bound to GPU afterwards. (The packaged "GPU unavailable" bug was a mousemove pixel-sampler burning the viewport canvas to 2d before async GPU init.)
- **WebGL2 FBOs are V-flipped, WebGPU must not be.** One of the two most-repeated 3D bugs.
- **Bake-vs-GPU is TWO predicates**, not one: "this effect forces a CPU bake" ≠ "the bake can draw it". Collapsing them killed Fill / Stroke / Sharpen / Noise and the Color-Overlay + Stroke layer styles.
- **Content hashing** keys the frame cache. Anything hashed must actually change the pixels, or you invalidate the cache to re-render an identical image (see §16.2, item 2).
- **Determinism:** the render-tests harness re-renders for byte-identical output from the same snapshot. That gates the back half (renderFrame → GPU → readback). It does **not** yet gate the front half — a stochastic source sampled into the snapshot would pass every time. This is the open "M5 pipeline-determinism" item.

---

## 7. Complete feature inventory

### 7.1 Compositing

| Feature | State | Detail |
|---|---|---|
| Nested compositions / comp instances | ✅ | Multi-comp project, instance sizing, precomp from selection |
| Collapse transformations | ✅ | AE semantics |
| Continuous rasterization | ⚠️ | The one remaining gap in the composition-boundary work |
| 2D + 3D in one space | ✅ | AE's Classic 3D model |
| **Blend modes** | ✅ **36 of AE's 38** | See table below |
| Track mattes | ✅ | `alpha` / `luma`, each invertible (a mode + a boolean, not 4 enum values); decoupled from stacking order |
| Masks | ✅ | Bezier paths, 7 modes, feather, opacity, expansion, inverted, animatable path (`path.points` vertex morph) |
| Effect-scoped masks (M6) | ✅ | An effect can be scoped to a mask path; the mask's feather drives falloff and its opacity drives intensity. Invariant: an effect mask never modifies layer alpha |
| Adjustment layers | ✅ | Affect everything beneath; break the 3D stack like AE |
| **Layer styles** | ✅ **10** | Drop Shadow, Outer Glow, Inner Shadow, Inner Glow, Satin, Bevel & Emboss, Color Overlay, Gradient Overlay, Stroke, **Glass** |
| Compositing groups | ✅ | Advanced-blend path renders layer + backdrop to separate targets — the topology stencils need |
| Motion blur | ✅ | Per-layer opt-in + comp master gate (AE's two-level rule), shutter **angle and phase** (−90 default), **adaptive sample count** |
| Frame blending | ✅ | |
| Backdrop blur | ✅ | |

**Blend modes — 36, in AE's own menu order and group names:**

| Group | Modes |
|---|---|
| Normal | Normal |
| Subtractive | Darken, Multiply, Color Burn, Classic Color Burn\*, Linear Burn, Darker Color |
| Additive | Add, Lighten, Screen, Color Dodge, Classic Color Dodge\*, Linear Dodge, Lighter Color |
| Complex | Overlay, Soft Light, Hard Light, Linear Light, Vivid Light, Pin Light, Hard Mix |
| Difference | Difference, Classic Difference\*, Exclusion, Subtract, Divide |
| HSL | Hue, Saturation, Color, Luminosity |
| Utility | Alpha Add, Luminescent Premultiply — these write **alpha**, not just colour |
| Matte | Stencil Alpha, Stencil Luma, Silhouette Alpha, Silhouette Luma — these replace the backdrop with a scaled copy of itself and contribute no colour |

\* The three **Classic** modes are compatibility **aliases**. The names are kept so an imported project round-trips and the picker matches AE's, but they currently render identically to their modern counterparts. This was **measured**, not assumed — the Classic branches were written as unclamped forms and the output clamp collapses them back. Shipping them as "unclamped variants" would have been a parity claim the pixels don't support. Logged as F9; closing it needs AE's pre-7.0 formulas.

**Missing vs AE's 38:** Dissolve and Dancing Dissolve. Both are per-pixel stochastic, which is why they're gated behind the pipeline-determinism work rather than the blend maths.

### 7.2 Effects — all 38

Each effect is a stack entry on the layer's `fx` component, with typed params (`number` / `color` / `checkbox` / `curve` / `layer`), an `enabled` flag, and an optional `maskId` scope. Every numeric param is keyframeable via `effect.<id>.<param>`.

| # | Type | Label | Notable params |
|---|---|---|---|
| 1 | `blur` | Blur | amount px |
| 2 | `glow` | Glow | radius, **colour**, intensity |
| 3 | `drop-shadow` | Drop Shadow | distance, **angle**, softness, colour, opacity |
| 4 | `brightness` | Brightness | amount |
| 5 | `contrast` | Contrast | amount |
| 6 | `saturate` | Saturate | amount |
| 7 | `grayscale` | Grayscale | amount |
| 8 | `sepia` | Sepia | amount |
| 9 | `hue-rotate` | Hue | degrees |
| 10 | `hue-saturation` | Hue/Saturation | master hue / saturation / lightness |
| 11 | `invert` | Invert | amount |
| 12 | `levels` | Levels | input black/white, gamma, output black/white |
| 13 | `curves` | Curves | full curve control-point editor |
| 14 | `posterize` | Posterize | levels 2–255 |
| 15 | `tint` | Tint | map black→, map white→, amount |
| 16 | `channel-mixer` | Channel Mixer | full 3×3 + constants + monochrome |
| 17 | `gradient-ramp` | Gradient Ramp | |
| 18 | `fractal-noise` | Fractal Noise | scale |
| 19 | `displacement-map` | Displace | amount, **map layer reference** |
| 20 | `motion-tile` | Motion Tile | scale |
| 21 | `fill` | Fill | colour, opacity |
| 22 | `four-color-gradient` | 4-Color Gradient | 4 corner colours + blend |
| 23 | `stroke` | Stroke | width, colour, opacity |
| 24 | `beam` | Beam | start/end XY, thickness, softness, length, colour |
| 25 | `sharpen` | Sharpen | amount |
| 26 | `noise` | Noise & Grain | amount, evolution, monochrome |
| 27 | `keylight` | **Keylight (Chroma Key)** | screen colour, balance, gain, clip black/white, despill, choke, matte softness |
| 28 | `wave-warp` | Wave Warp | height, width, direction, phase |
| 29 | `turbulent-displace` | Turbulent Displace | amount, size, complexity, evolution |
| 30 | `echo` | Echo | echo time, count, start intensity, decay |
| 31 | `inner-shadow` | Inner Shadow | distance, angle, softness, colour, opacity |
| 32 | `inner-glow` | Inner Glow | size, colour, opacity |
| 33 | `satin` | Satin | distance, angle, size, colour, opacity, invert |
| 34 | `bevel` | Bevel & Emboss | size, depth, angle, altitude, highlight + shadow colour/opacity |
| 35 | `directional-blur` | Directional Blur | direction, length |
| 36 | `linear-wipe` | Linear Wipe | completion, wipe angle, feather |
| 37 | `transform` | Transform | position XY, scale, rotation, opacity (a second transform in the effect stack) |
| 38 | `posterize-time` | Posterize Time | frame rate |

Plus, alongside the stack: **colour LUT** support, **canvas2d-only** effect paths, effect **clipboard** (copy/paste an effect or a whole stack), effect **presets** (save/apply), and per-effect **adjustment-layer** semantics.

### 7.3 Shape layers

| Feature | State | Detail |
|---|---|---|
| Rect / ellipse / polygon / star / line | ✅ | Live parametric, with tool options |
| Pen / pencil / curvature tools | ✅ | Full bezier authoring |
| **Trim Paths** | ✅ | `trim.start`/`.end`/`.offset`, keyframeable. Correctly handles the wrap-past-end two-arc case; arc-length table |
| **Repeater** | ✅ | Copies + position/rotation/scale/opacity offsets, cumulative in each copy's rotated frame, all params keyframeable. The three previously-missing AE params (per-copy anchor, start offset, composite order) landed in `a0edf7a` |
| **Merge Paths** | ✅ | All four AE ops (union / subtract / intersect / exclude), polygon booleans, both **live** (non-destructive, evaluated at render) and destructive |
| **Offset Paths** | ✅ | |
| **Wiggle Paths** | ✅ | Spatial displacement along the normal, **plus** the time term added in `61fc1fc` (was frozen — seeded by point index only) |
| Zig Zag, Round Corners, Pucker & Bloat, Twist | ✅ | |
| **Path operator stacking** | ⚠️ | `fx.pathOp` is a **single slot** — one operator per node, not AE's chainable contents list. Same single-slot shape for `trim`, `rep`, `textPath` |
| Wiggle Transform (shape operator) | ❌ | Absent. Note the *expression* `wiggle()` is fully implemented — different feature |
| Multi-paint (multiple fills/strokes) | ✅ | With opacity stops |

### 7.4 Text

| Feature | State | Detail |
|---|---|---|
| Rich text | ✅ | Per-run styling |
| Paragraph text | ✅ | Box-constrained wrapping |
| Font catalogue + picker | ✅ | |
| Kerning / tracking / leading | ✅ | Kerning agreement tested |
| **Text animators** | ✅ | Full AE model |
| **Range selectors** | ✅ | `start`/`end`/`offset` + `amount`, `smoothness`, `easeHigh`, `easeLow` — AE's full Advanced options |
| **Multiple selectors per animator** | ✅ | `selectors[]` |
| **Wiggly selector** | ✅ | `wiggleFreq` |
| Per-character / per-word / per-line | ✅ | `basedOn: RangeBasedOn`, with a per-basedOn unit map cached per string |
| **Per-character 3D** | ✅ | Separate landed module |
| **Path text** | ✅ | Glyphs placed by arc length with tangent rotation, spine driven by a **mask path**, `firstMargin` keyframeable |
| Text-on-path via AI | ✅ | `set_text_on_path` tool |
| Ready-made text rigs | ✅ | Typewriter, Bounce In Words, Spin & Fade Characters, Tracking Reveal |
| **Text presets** | ✅ | 18 |

### 7.5 Transform, hierarchy and 3D

| Feature | State | Detail |
|---|---|---|
| **Parenting** | ✅ | `canReparent` rejects loops; `reparentNode` compensates the local transform so the layer does not move; `eligibleParents`; `insertNull` |
| Null objects | ✅ | Own inspector branch |
| **Anchor point tooling** | ✅ | `moveAnchorCompensated`; a real **Pan Behind tool** with AE semantics including "dragging the body moves the anchor too"; rotate spins about the anchor |
| Auto-orient | ✅ | |
| 3D layer switch | ✅ | A 3D layer is a **quad at z=0 with no thickness** — seen edge-on it draws nothing (correct, matches AE); a wireframe keeps it findable and clickable |
| **The 2D-layer-as-wall rule** | ✅ | A 2D layer between two 3D layers holds its stacking position and splits the 3D layers into separately-sorted groups. Adjustment layers and matte pairs break the stack the same way |
| Both faces render | ✅ | No backface culling, as in AE |
| **Cameras** | ✅ | One-node / two-node, active-camera selection, camera navigation, camera tool, DOF blur |
| **Lights** | ✅ | With shading, projection, shadows, one resolver for the light model |
| **Extrusion + bevels** | ✅ | Beyond Classic 3D. Rounded bevels; per-face materials; face picking |
| Materials | ✅ | Per-face material assignment |
| Corner pin | ✅ | |
| Views | ✅ | Single / secondary / **quad view**, custom views, ground grid, draft 3D |
| **3D gizmo** | ✅ | Screen-constant size, axis modes, state |
| 3D gizmo snapping | ❌ | Store field exists with **zero readers and zero writers** |

### 7.6 The timeline — full anatomy

The timeline is ~4,000 lines across three layers, and it is the panel most of the work happens in. It gets its own deep section because a feature table under-describes it.

#### 7.6.1 The three layers

```
┌─────────────────────────────────────────────────────────────────────┐
│  packages/timeline  — the ENGINE (pure, 29 files, ~2,000 lines)     │
│    Timeline · TimelineState · Layer · Track · Clip · Playhead        │
│    Marker · MarkerList · TimelineSelection · History · Serializer    │
│    Time · FrameRate · TimeRange · navigation · ranges · search       │
│    No React, no DOM. Emits typed events.                            │
├─────────────────────────────────────────────────────────────────────┤
│  src/core/timeline/TimelineController.ts — the ADAPTER (1,158 lines)│
│    One timeline registry PER COMPOSITION. Bridges the engine to the  │
│    scene graph, the command history, the event bus and the stores.   │
│    Owns clip↔layer time conversion. 60+ operations.                  │
├─────────────────────────────────────────────────────────────────────┤
│  src/layout/Timeline + BottomTimeline — the UI (~4,000 lines)        │
│    Timeline.tsx is a CONTROLLED RENDERER with zero animation or      │
│    playback logic. It consumes a `TimelineModel` and reports intents.│
└─────────────────────────────────────────────────────────────────────┘
```

The UI/engine contract is explicit and documented in `TimelineModel.ts`: *the engine* computes the visible window, dispatches `TimelineFocused` / `TimeChanged` / `PlayStateChanged`, and resolves keyframe positions; *the UI* renders the ruler, headers and lanes, hosts the playhead and drag-to-scrub, and virtualizes rows.

#### 7.6.2 The design principle: "calm by default"

Every layer is a **single row** showing one neutral animation block that summarizes where its keyframes live. A track only expands — via the disclosure chevron or the `U` reveal shortcut — into one sub-row per animated property, each with its own draggable keyframes. Collapsed rows stay quiet. This is a deliberate departure from tools that dump every track open.

#### 7.6.3 Row anatomy

Rows are a discriminated union, uniformly virtualized:

| Row type | What it is |
|---|---|
| `track` | The layer summary row — clip bars, a summary keyframe block, markers, waveform |
| `category` | An accordion grouping the layer's properties. Three categories, auto-derived: **Transform** (anchor/position/scale/rotation/orientation/opacity), **Effects** (effect params, blur, shadow, glow, filter), **Contents & Styles** (everything else) |
| `prop` | One property sub-row: label, live value fields, stopwatch or keyframe navigator, and its keyframe diamonds |

**Static placeholder rows** are a real feature, not a gap. A property with no keyframe track yet still appears in the tree with a **stopwatch** instead of the `◀◆▶` navigator — that is the AE property tree, and it is what lets you enable animation from the timeline without knowing where the property lives in the inspector.

**Live scrubbable values in the timeline.** Every property row shows its value at the playhead in editable `ValueField`s, with the right unit (`px` / `%` / `°`) and the right prop mapping (Position edits `['x','y']`, Opacity edits `['opacity']`). Without this the timeline could only ever *add* a keyframe — changing what it held meant a round trip to the inspector.

#### 7.6.4 The track header column

A wide (default 460px, user-resizable) header that is effectively AE's layer switches panel:

- Disclosure chevron · layer icon · **inline-rename** (confirmed on blur/Enter) · colour stripe with a label-colour picker
- **Eye** (visibility) · **Lock** · **Solo** · **speaker** (audio mute — *separate* from the eye, which hides the picture)
- **Blend mode** dropdown (all 36, grouped as in §7.1)
- **Track matte** dropdown (alpha/luma ± invert)
- **Parent** dropdown, populated from `eligibleParents` so loops can't be selected
- Six switch flags: **shy**, **collapse transformations**, **effects enabled**, **motion blur**, **adjustment layer**, **3D**
- Drag-to-reorder rows
- Depth indentation for nested/grouped layers
- **Ghosting** — rows outside the current Focus Mode context are dimmed rather than hidden

#### 7.6.5 The lane area

| Element | Behaviour |
|---|---|
| **Ruler** | Timecode labels honouring the comp's **start frame** (labels add it; tick positions stay 0-based) |
| **Cache bar** | A thin green band directly under the ruler showing **real frame-cache coverage** — the actual RAM-preview state, not a guess |
| **Work area** | A band on the ruler + a faint tint over the lanes. Draggable by either edge or by the body. Playback loops within it |
| **Clip bars** | Per-layer bars with `start` / `duration`, colour, label. **Drag to move, drag either edge to trim.** Video/audio bars carry `sourceInSec`/`sourceOutSec` so the waveform slices to the **audible region** rather than stretching the whole file across the bar |
| **Waveforms** | Drawn from real peaks (`peaksInRange`), for audio layers *and* video layers (whose audio shares the picture's asset) |
| **Markers** | Comp markers on the ruler; **layer markers** stored layer-relative (so they travel with a trimmed layer) and converted once to comp seconds for drawing |
| **Playhead** | Drag-to-scrub, keyboard nudge. Passed as a **separate prop** from the model so 60fps playback doesn't rebuild the model and re-render the whole row tree |
| **Loop region** | Independent of the work area |
| **Zoom** | Wheel zoom anchored at the cursor, fit-to-viewport, reset-to-100% |

#### 7.6.6 Keyframe interaction

- **Diamond shapes encode easing.** Each diamond is drawn as **two independent halves** — `easeIn` (the easing of the segment *arriving*) and `easeOut` (the easing of the segment *leaving*) are carried separately, so "eased in, hold out" renders as the distinct thing it is. Hold, roving, first and last keyframes each have their own glyph (`keyframeShape.ts`, with a `describeShapes` accessibility path).
- **Marquee multi-select** across rows and layers (`marqueeSelection.ts`), with an additive combine mode and a drag threshold so a click isn't a marquee.
- **Multi-drag** commits the whole selection.
- **Snapping** (`keyframeSnap.ts`) to the playhead, other keyframes, markers, clip edges and work-area bounds — with the **dragged keys excluded from their own snap targets** (otherwise a selection snaps to itself and can't move).
- **Time-scale a selection** (`keyframeTimeScale.ts`) — AE's Alt-drag on a selection range, via grips at either end. Scales the selection in time proportionally.
- **Right-click context menu** on a keyframe: interpolation, easing, roving, delete, copy/paste.
- **Keyframe navigator** `◀ ◆ ▶` per property row — jump to previous/next keyframe, and the diamond toggles a keyframe at the playhead **holding the property's current value**.
- Copy/paste keyframes (`C`/`V` in timeline scope) across layers and properties; copy/paste **ease** separately.

#### 7.6.7 Performance

- **Uniform row virtualization** — track, category and property rows all go through one virtualizer, so a comp with thousands of rows scrolls at full rate.
- **`areRowPropsEqual` memoization** on rows — the single most important perf lever in this panel.
- **Playhead as a separate prop** — see above; this is what keeps 60fps playback from rebuilding the model object.
- Waveform peaks are computed per visible range, not for the whole file.

#### 7.6.8 The transport bar (BottomTimeline)

- **Timecode readout** — `mm:ss:ff @ fps`, editable
- Go to start / previous frame / **play-pause** / next frame / go to end
- **Loop playback** toggle
- **Draft quality** toggle *(nearest-neighbour sampling for that layer — see §16.2 item 5; the renderer reader landed in `5e7c937`)*
- **Preview resolution** picker — lower = faster playback, does not change size or export
- **Global Shy** toggle — hides all shy-flagged layers
- **Global Motion Blur** toggle — the comp-level half of AE's two-level gate (disabled off-GPU)
- **Split at Playhead** (`Ctrl+Shift+D`) · **Trim In** (`Alt+[`) · **Trim Out** (`Alt+]`)
- **Keyframe interpolation** picker
- **Graph Editor** toggle (`Shift+F3`)
- **Row height** cycle — Compact 24 / Normal 30 / Tall 44
- **Zoom reset**
- **Search / filter** box over layer names
- Comp tabs, each closable

#### 7.6.9 TimelineController operations (the full verb list)

*Transport* — `play` `pause` `togglePlay` `tick` `seekSeconds` `goToStart` `goToEnd` `nextFrame` `previousFrame`
*Zoom/scroll* — `getPixelsPerSecond` `setPixelsPerSecond` (with an anchor) `fitZoom` `setScrollPixels`
*Comp* — `setFrameRate` `setDurationSeconds` `fpsForNode` `compIdForNode` `durationFramesForNode`
*Clips* — `setClipStart` `trimClipTo` `splitClip` `splitSelectedAtPlayhead` `trimSelectedStartToPlayhead` `trimSelectedEndToPlayhead` `moveSelectedStartToPlayhead` `moveSelectedEndToPlayhead` `sequenceLayerBars` `deleteLayer` `transferNodeClips` (moves clips when a layer changes comp)
*Time conversion* — `toLayerTime` `toAbsoluteTime`
*Markers* — `addMarkerAtPlayhead` `addLayerMarkerAtPlayhead` `removeMarker` `getMarkers` `getLayerMarkers` `goToNextMarker` `goToPrevMarker`
*Work area* — `setWorkAreaIn` `setWorkAreaOut` `setWorkArea` `clearWorkArea` `getWorkArea` `isLooping` `setLooping`
*Keyframes* — `goToNextKeyframe` `goToPrevKeyframe`
*History* — `undo` `redo` `canUndo` `canRedo` (timeline edits push a `TimelineCommandAdapter` onto the **global** history, so Ctrl+Z is one stack)
*Persistence* — `capture` `restore` `syncFromScene`
*Cache* — `invalidateLayerIndex` `getLayersForNode`

### 7.7 Animation model features

| Feature | State | Detail |
|---|---|---|
| **Graph editor** | ✅ | 713-line editor: **value AND speed** curves, bezier handles (working on linear keys too), tangent alignment, separate tested speed maths (`outgoingSpeed`/`withIncomingSpeed`/`influences`). Toggle: `Shift+F3` |
| Roving keyframes | ✅ | Context menu + Motion panel |
| Easing presets | ✅ | Linear / Ease / EaseIn / EaseOut / Hold; `F9` family |
| Per-keyframe, per-side interpolation | ✅ | Independent in/out easing |
| Keyframe assistants | ✅ | Easy-ease-all, time-reverse, sequence layers, stagger |
| Spatial bezier tangents | ✅ | With motion-path overlay + tangent handles on canvas |
| **Motion paths** | ✅ | Visible, editable, dot spacing configurable (`Ctrl+Alt+M`) |
| **Expressions** | ✅ | See §5.3 |
| Expression controls (rigs) | ✅ | Seven kinds behind one `ctrl(name)` accessor |
| Time remap | ✅ | With correct comp↔keyframe time conversion |
| Layer trim / stretch / slip | ✅ | `Alt+[` / `Alt+]`; slip slides both source edges |
| Auto-keyframe mode | ✅ | `timelineAutoKeyframe` preference |
| **Presets** | ✅ | **15** animation + **18** text + **6** behaviour + **5** scenery = **44** |
| Preset preview | ✅ | Live animated cards replaying the same choreography the insert applies |
| RAM preview | ✅ | Real cache coverage drawn under the ruler |

### 7.8 Rigging — bone and puppet

Both rigs can live on the **same layer** and **compose** (puppet first in rest space; skeleton skins on top).

| | **Puppet tool** | **Bone tool** |
|---|---|---|
| Toolbar id / shortcut | `puppet-pin` · `Ctrl+P` | `bone` · `Ctrl+B` |
| Stored at | `fx.puppet` | `fx.skeleton` |
| Deformer | **ARAP** (default) or LBS over a grid mesh | **Linear Blend Skinning** over the same mesh |
| Rigging primitive | Position pins + rotation, stiffness, scale, overlap | Bone hierarchy + FK, **IK targets, pole vectors** |
| Solver | Sorkine–Alexa ARAP, cotangent Laplacian, dense Cholesky | Analytic two-bone + **FABRIK** |
| Auto-binding | Laplacian harmonic weights, 150 Jacobi iterations | Inverse-distance-to-segment, capped at 4 influences |
| Keyframeable | pin position (eased + spatial tangents), rotation, stiffness, scale, overlap | bone rotation / x / y / scaleX / scaleY, IK target x/y, IK pole x/y |
| Undo | `PuppetEditCommand` — 1 gesture = 1 step | `SkeletonEditCommand` — 1 gesture = 1 step |
| Renders via | `layer.deformedMesh` → GPU indexed mesh draw (overlap = painter's index order) | same |
| Authoring | **Puppet Sketch recording**, motion path + tangent handles, advanced-pin gizmo | Mesh preview, **weight painting**, bone names |
| AI tools | `create_puppet_rig`, `set_puppet_pin_keyframes` | `create_skeleton_rig`, `pose_skeleton` |

Deliberate deltas vs AE: one engine (AE carries two for back-compat), one mesh per layer, overlap resolves *within* the layer rather than through the scene depth buffer. Vs DUIK/Rive — the right benchmark, since AE has no skeleton at all — the gap is that weight painting is brush-only, with no per-vertex numeric editor.

### 7.9 Particles

Deterministic, **closed-form** emitter (AE's CC Particle World shape). Because it's closed-form, "all particles alive at time `t`" is computed directly — no simulation state, so scrubbing backwards and exporting out of order are both exact.

- Emitter types: `point` / `box` / `circle`
- Particle shapes: `circle` / `square` / `line` / `star`
- Blend: `normal` / `add`
- Params: birth rate, lifetime + randomness, emitter width/height, velocity, spread, gravity, drag, size + size-over-life, colour + colour-over-life, opacity curve, rotation, seed
- All numeric params keyframeable; colour params keyframeable

### 7.10 Paint

Real pressure-sensitive brush strokes with fill/stroke, multi-paint, opacity stops, and correct paint-space coordinates (`paintCoords`) so strokes stay put under layer transforms.

### 7.11 Audio

| Feature | State |
|---|---|
| Audio layers from imported files | ✅ |
| **Audio from video** | ✅ — decode failure *is* the no-audio signal |
| Waveform generation + display | ✅ (windowed range generation) |
| Level automation, keyframed | ✅ |
| Solo / mute / speed | ✅ |
| **Audio mixdown** for export | ✅ including open-ended clips |
| Audio-driven expressions (`audio`) | ✅ |
| `analyse_audio` AI tool | ✅ |
| VU meter in status bar | ✅ |
| Transport-synced playback | ✅ — the **clip bar owns audio timing** |

### 7.12 Import

| Format | Behaviour |
|---|---|
| **Images** | PNG/JPG/WebP → image layer. Content-addressed on import |
| **Image sequences** | Detected and imported as one layer |
| **Video** | Probed for dimensions, fps, duration, **alpha**, audio. Proxy generation + proxy manager for smooth scrubbing |
| **Audio** | WAV/MP3/etc → audio layer with waveform |
| **SVG — hybrid** | *Static* SVG imports as **one intact `svg` layer** (retains original by default). *Animated* SVG (CSS animations **or** SMIL) is converted to **keyframes**. Sanitized through DOMPurify. Convertible to an editable shape tree on demand |
| **Lottie / Bodymovin** | Full planner → apply pipeline. Shape trees per drawable, transform channels with bezier easing, parenting, animated bezier paths → `path.points` vertex-morph tracks. **`layers[0]` is the TOP layer.** Import report surfaces anything the planner couldn't handle |

### 7.13 Templates and libraries

**Templates (MOGRT-style):** a template is *an authored scene + its exposed fields*. Field kinds drive the control shown in the panel; fields read/write against the **live** graph. Tests assert every exposed field targets a real node+component+prop and that **only** exposed props change.

- **Media slots** — a fill repoints `assetId`; slot geometry, instances and cover behaviour are their own subsystem
- **Protected time regions** (responsive time / M7) — mark regions that must not stretch when the template's duration changes
- **Per-glyph** template fields
- Authoring path (`templateAuthoring.ts`) turns a scene into a template
- Live Canvas2D preview cards

**Libraries** — six catalogues, all inserting through the *same* write path a user would use, so everything is editable and undoable afterwards:

| Library | What it inserts |
|---|---|
| **Motion graphics** | Lower thirds, callouts, titles, data widgets, loops — built from engine primitives + keyframes. `build` (static) and `animate` (choreography) are authored once and replayed by *both* the insert and the preview card, so an inserted element lands looking exactly like its card |
| **UI Kit** | Music players, analytics cards, search bars, CTA banners, glass credit cards, device frames — authored as SVG components, inserted as a unified master group of editable vector + text layers |
| **Cursors** | Real vector cursor geometry (system pointers, resize arrows, zoom) as editable multi-part groups, some with built-in keyframe choreography starting at the playhead |
| **Transitions** | Real keyframe recipes through the animation engine. **Layer mode** picks the entrance or exit variant per layer from its timeline clip |
| **SFX** | **Procedurally synthesized** real audio — deterministic mono PCM from pure DSP (seeded noise, sine sweeps, one-pole filters; no WebAudio, no network), encoded as 16-bit WAV, inserted through the identical pipeline as an imported audio file |
| **Lottie** | Bundled, genuinely importable Lottie documents authored against exactly the feature set the planner understands. Preview cards are drawn from the *same plan the import applies* |

---

## 8. The AI layer

**Both editions are BYOK.** The only difference is who holds the key:

- **server** — the hosted gateway proxies the call and encrypts keys at rest with `AI_KEY_SECRET`.
- **local** — the key lives in the **OS keychain** (`electron/aiKeyVault.ts`) and the provider call is made from the **Electron main process** (`electron/aiProxy.ts`), never the renderer. Two reasons: the renderer's CSP allows only `'self'` and localhost, and the key must never enter renderer scope where plugin code lives.

There are **no credits** and **no plan gate** on the assistant in either edition.

**Providers:** Anthropic, OpenAI, Gemini — with per-provider adapters and SSE streaming. Provider + model are picked from the composer.

### 8.1 The 62 tools

Grouped by file (`packages/ai-tools/src/tools/`):

**Read** — `describe_scene`, `get_selection`, `list_assets`, `list_capabilities`, `list_presets`, `read_tracks`, `evaluate_at`

**Write (document)** — `create_layer`, `update_layer`, `delete_layer`, `reparent_layer`, `create_precomp`, `update_composition`, `create_media`, `create_media_from_attachment`, `create_mask`, `create_gradient`, `import_svg`, `generate_image`, `recolor_lottie_vector`

**Write (animation)** — `set_keyframes`, `remove_keyframes`, `set_easing`, `set_spring`, `set_expression`, `set_time_remap`, `apply_preset`, `stagger_in`, `text_animator`, `set_trim_path`, `set_text_on_path`

**Write (look)** — `add_effect`, `update_effect`, `update_effect_param`, `apply_layer_style`, `set_shadow_stack`, `set_motion_blur`, `set_light`, `define_style`, `merge_paths`, `add_path_operator`, `add_repeater`

**Rigging** — `create_puppet_rig`, `set_puppet_pin_keyframes`, `create_skeleton_rig`, `pose_skeleton`

**Audio** — `analyse_audio`

**Compose (high-level, technique-backed)** — `add_scene`, `add_background`, `add_title`, `add_kinetic_title`, `add_lower_third`, `add_cards`, `add_logo_reveal`, `add_emblem`, `add_transition`, `add_camera_move`, `add_light_sweep`, `add_ambient_orbs`, `add_radial_burst`, `add_path_morph`, `add_surface_treatment`

### 8.2 The three execution paths

```
                    ┌──────────────────────────────────────┐
  prompt ──────────►│  AgentLoop (streamTurn)              │  direct tool-calling loop
                    │  provider SSE → tool calls → execute │
                    └──────────────────────────────────────┘

                    ┌──────────────────────────────────────┐
  prompt ──────────►│  CasterRunner  →  @motion/caster     │  DETERMINISTIC generative
                    │  brief → cast → validate → sequence  │  pipeline
                    │  → emit ToolCall[] → execute         │
                    │  + fit critic (filmstrip evidence)   │
                    └──────────────────────────────────────┘

                    ┌──────────────────────────────────────┐
  prompt ──────────►│  DirectorRunner → /ai/director/run   │  multi-director planner
                    │  (server edition — motion-back)      │  (schema-pruned for tokens)
                    └──────────────────────────────────────┘
```

**The caster is the interesting one.** `@motion/caster` is **pure** — it builds prompts, validates responses and emits `ToolCall[]`, and calls nothing. The model's job is narrow: pick technique ids and seeds from a hand-authored **technique library**. Everything the model can get wrong is validated and repaired downstream (`validateCasting`) — an unknown id falls back to the top-ranked candidate, an out-of-range param falls back to its default. So the response parser is **deliberately lenient**: extract what you can, hand the rest to a validator that expects to be lied to.

**Three invariants the runner enforces:**
1. **One prompt = one undo entry.** Calls execute against the same `ToolContext` the direct loop uses, inside the caller's transaction.
2. **The editor never holds a provider key** in server mode — every call names a provider and lets the gateway attach the key.
3. **Failures are recorded, never swallowed** — a malformed response is a logged path failure and a deterministic fallback, not a silent empty run.

### 8.3 Supporting machinery

- **`archetypes.ts` / `recipes.ts` / `design.ts`** — the creative taxonomy the caster casts against
- **`@motion/technique-library`** — hand-authored techniques (entrance, kinetic, scene) with a schema and a **linter**
- **`@motion/design-system`** — look packs, colour, type, grid, shape, depth, surface, stage, device frames + template families
- **`@motion/product-motion`** — a *separate discipline* with rules that deliberately contradict the editorial library: springs not beziers, 200–300ms not 400–900ms, exits faster than entrances, 8–24px travel, shared-element transitions instead of cuts, **no motion blur ever**
- **`filmstrip.ts` / `verify.ts` / `renderFeedback.ts`** — the self-critique pass: render frames, hand them back to the model as evidence, re-rank. **Measure, don't trust the verifier.**
- **`assetVisualAnalyzer.ts`, `imageAttachment.ts`** — image input
- **`rigGuard.ts`** — guards rig-touching tool calls
- **`aiTransaction.ts`** — the one-undo-entry boundary
- **Emitter rule (recorded, important):** the **caster is primary; libraries emit**. One timeline per node+prop — two emitters writing the same track is how animations silently overwrite each other.

### 8.4 Execution modes in the UI

- **Auto (Direct apply)** — AI changes apply immediately
- **Manual (Review preview)** — review a preview before applying
- Plus a *generative* toggle that emits several alternatives and ranks them by the linters at **no extra model calls** (same brief and casting, re-seeded).

---

## 9. Plugins

**Status: shipped.** A plugin is a **package** — `plugin.json` + an ES module — installed from a `.zip` or a folder.

```
 pick .zip / folder
        │  readPluginZip / readPluginFolder      ← bytes → files, NO execution
        ▼
   plugin.json ──► parseManifest                 ← strict: id, semver, apiVersion,
        │                                          safe paths, known permissions
        ▼
   consent screen  ("this plugin will be able to: …")
        │  user accepts
        ▼
   pluginStore (localStorage)  ────────────────► survives reload
        │
        ▼
   PluginHost.start ──► new Worker(pluginWorker.ts)
                            │ lockdown()          ← fetch/XHR/WS/IDB/importScripts
                            │ await import(blob)   ← the plugin's own module
                            │ activate(motion)
                            ▼
                       postMessage {k:'call', method, args}
                            │
        ┌───────────────────┴─────────────────────┐
        │ METHOD_PERMISSIONS[method] granted?     │  no → refused, BY NAME
        ▼                                         │
   hostApi[method](...)  inside runDocumentEdit ──┘   ← ONE undo entry
```

**Why a Worker, not the host realm.** The previous host `new Function`'d a user-picked `.js` file *in the page's realm* with live `defaultSceneGraph` / `defaultAnimation` handles bound in. That page holds the account bearer JWT and the user's AI provider keys, both in localStorage. "The user chose the file" is not a control — downloading plugins from strangers is the normal distribution model for creative tools.

| Failure | Host realm + `new Function` | Worker sandbox |
|---|---|---|
| Plugin loops forever | Editor frozen permanently | Worker terminated in ~12s via heartbeat, editor untouched |
| Plugin reads the JWT / AI keys | `localStorage.getItem(…)` | No `localStorage` in a worker realm |
| Plugin phones home | `fetch(…)` | `fetch` replaced with a throwing stub **before** import |
| Plugin reads the UI / forges clicks | Full DOM | No `document`, no `window` |
| Plugin deletes the project | Direct singleton handle | Needs `scene:write`, and it is one Ctrl-Z |
| User reloads | Everything uninstalled | Installs persist and restart |

**Permissions:** `scene:read`, `scene:write`, `animation:read`, `animation:write` (and more), checked per method call by name.

**Guarantees:** every plugin mutation runs inside `runDocumentEdit`, so it is a **single undo step**. Packages are signed (TOFU key model). Plugins get a docked panel (not a modal — a plugin panel is for use *while* dragging on the canvas). The Plugins menu group is built dynamically. **Trap:** `srcdoc` inherits the parent CSP, which is what once made plugin panels inert.

Full authoring guide: [`docs/PLUGINS.md`](PLUGINS.md).

---

## 10. Export and the render queue

### 10.1 Formats — 9

| Format | Ext | Notes | Desktop only |
|---|---|---|---|
| **MP4 · H.264** | `.mp4` | Plays everywhere. Best default for sharing | ✅ (ffmpeg) |
| **WebM · VP9** | `.webm` | Smaller than MP4, **keeps transparency**, ideal for web | — |
| **MOV · ProRes 4444** | `.mov` | Lossless **with alpha**, for editing elsewhere. Large | ✅ (ffmpeg) |
| **Animated GIF** | `.gif` | No audio, 256 colours | — |
| **PNG sequence** | `.zip` | Lossless frames with alpha, zipped. The archival option | — |
| **JPEG sequence** | `.zip` | Smaller frames, no alpha | — |
| **Still frame** | `.png` | The current frame as one PNG | — |
| **Lottie** | `.json` | Vector animation for web/mobile players. **Shapes only** | — |
| **Project file** | `.json` | The editable document, re-openable with File ▸ Open | — |

Also: **Composition ▸ Save Frame As PNG** for a quick single frame.

### 10.2 How it renders

- **One deterministic frame loop** (`offlineRenderer`): frame time is computed from frame index, never from wall-clock.
- Frames are rasterised by **the same engine that draws the viewport**.
- Frames stream to disk **one at a time** — peak memory is one frame, not the whole render. A long export leaves the app usable.
- ffmpeg is a **child process**; the render's staging directory is cleaned on abort.
- `frameContract` and `exportRefusesBadFrame` tests enforce that a malformed frame aborts rather than being silently written.
- Audio is mixed down and staged (`render:stageAudio`) before muxing.
- Failure to find ffmpeg produces an actionable message naming the format and the alternative.

### 10.3 Render queue

A real queue panel: add job, duplicate job, remove, clear completed, retry failed, skip, per-job progress + elapsed time, output-module dialog (format + settings), output directory chooser, and job statuses `queued` / `rendering` / `done` / `failed` / `skipped`.

> **The button is "Stop", and it aborts.** It was labelled "Pause" and did this
> silently; it now says so, and confirms mid-render. There is still no resume —
> stopping discards the current job's progress. See §16.2 item 4.

---

## 11. Persistence, versions, sync

### 11.1 The `.motion` bundle

A project is a **directory bundle** (like `.sketch` / `.fcpbundle`), not a single opaque file:

```
MyProject.motion/
├── manifest.json          written LAST, so a crash can't corrupt the bundle
├── scene.json             ┐  separate chunks, content-hashed, so a save
├── animation.json         │  writes only what actually changed
├── timeline.json          │  (timelines + motionBlur + guides)
├── meta.json              ┘  (comps registry)
├── assets/                imported media, addressed by SHA-256
└── versions/              local version history, structurally shared
```

**Chunk partition is strict — no overlap**, so decode is unambiguous. Every `EditorDocument` field lands in exactly one chunk; `version` is lifted to `manifest.documentVersion`. Optional chunks are omitted when empty and decode tolerates their absence. Container format version is `2.0.0`, distinct from the inner document version.

**Deriveable data is deliberately NOT in the bundle** — thumbnails, proxies and waveforms live in the app cache dir so bundles stay small and portable.

Adding authored state later means: add a chunk name in `types.ts`, write it in `encodeBundle`, read it in `decodeBundle`, extend the round-trip test.

### 11.2 Saving and recovery

- `AutosaveController` — debounced persistence
- Atomic bundle writes (`bundle:writeAtomic`)
- `recovery.ts` + the SQLite recovery index — crash recovery entries
- `confirmDiscard` on close (`confirmOnClose` preference)
- `incrementName` → **Increment and Save** (`Ctrl+Alt+Shift+S`)
- **`networkFreeSavePath` test** — proves the local edition's save path makes no network call

### 11.3 Version history

Local `versions/` store with **structural sharing** — snapshots share unchanged objects rather than storing full copies, so an animation-only change costs one new object. Exposed as **File ▸ Version History…** and a `VersionHistorySection` in the inspector. `VersionEntry` / `VersionMeta` in `bundle/VersionStore.ts`.

### 11.4 Encrypted sync (server edition only)

The full stack exists and is tested: **`ProjectCipher`** (client-side encryption), **`manifestDiff`** (chunk-level three-way diff), **`SyncEngine`** (reconcile), **`httpSyncTransport`**, and the `/api/sync` endpoints behind it. It shipped without any way to invoke it; **File ▸ Sync Project…** is that way.

### 11.5 Local index

SQLite (`better-sqlite3`) via the main process: projects list, per-project facts, recovery entries, missing-file marking. This is the backing store a local project browser would use — the data layer exists and is tested; the browser UI does not exist yet (§16.1).

---

## 12. The UI surface — complete

This section enumerates the entire interface: the design system underneath it, then every region, panel, button, dropdown, modal, overlay and context menu.

### 12.0 The design system

#### 12.0.1 Token layers

Three layers, in strict order. A component may only read the semantic layer.

```
src/tokens/*.css     PRIMITIVE — the only raw literals in the system
    colors.css       slate 0→1000 ladder + hue ramps (violet, blue, …)
    spacing.css      4px base: --space-0 … --space-13 (0,2,4,6,8,12,16,20,24,32,40,48,64,80)
    typography.css   IBM Plex Sans / Plex Mono; scale 36·24·20·14·13·12·11·10
    radius.css       corner ladder
    shadows.css      elevation ladder
    motion.css       durations + easing curves
    zindex.css       the single layering authority
    domain.css       DOMAIN semantics (identical in both themes)
        ↓
src/themes/*.css     SEMANTIC — dark.css / light.css map primitives to roles
        ↓
*.module.css         COMPONENT — reads semantic vars only
```

**Rules encoded in the token files themselves:**

- *"These are the ONLY raw color literals in the system."* Everything else composes from the semantic layer.
- *"Use these tokens; never write hardcoded px values for padding/margin/gap."*
- *"Never hardcode font-size/font-weight literals in components."*
- **Micro (10px) is the floor.** *"Nothing in the product renders below 10px."* It exists for exactly one job: uppercase, letter-spaced chrome labels and badges (`WebGPU`, `RGB`, `fx`, switch-column glyphs) where caps height and tracking carry legibility. Never for sentence-case text or values. Body copy starts at 12px.
- **Plex Mono carries all numerics** — timecodes, values, coordinates.
- **The neutral ladder is TRUE neutral** (zero blue tint) with decisive steps so panels visibly lift off the frame: `#0b0b0c` frame/wells → `#171718` panels → `#212123` raised controls → `#2b2b2e` hover → `#000000` the workspace void.

> **Recorded trap:** ~275 dead `var()` fallbacks once hid **17 phantom tokens** — names that resolved to nothing and silently fell back. A token census must read **computed styles**, not CSS text.

#### 12.0.2 Domain tokens (identical in both themes)

| Token family | Rule |
|---|---|
| `--color-ai-*` | **AI identity is ALWAYS violet** (`#8b5cf6`) and is *never* used for nav, selection or categories |
| `--color-category-*` / `--color-layer-*` | Per-layer-kind hues — text, shape, image, video, audio, camera, light, null, 3d. **Colourblind-safe and always paired with an icon**, never colour alone |
| `--color-temporal*` | The AE-blue interactive highlight (`#2988ff`) for time-domain affordances |
| Timeline chrome | Its own fixed palette, independent of theme accent |

> **Trap:** never template `--color-layer-*` values into generated markup — they must resolve at runtime from the theme.

#### 12.0.3 Motion tokens

Three durations for UI chrome and no others: **fast 120ms** (hovers, toggles) · **base 160ms** (panels, popovers, cards) · **slow 220ms** (modals, mode transitions, Focus Mode). Plus `instant 0ms` and `slower 320ms`.

Curves: `standard` `cubic-bezier(0.2,0,0,1)` is the default ease-out; `emphasized`, `decelerate`, `accelerate` for directional intent; **`spring` `cubic-bezier(0.34,1.56,0.64,1)` is reserved for direct-manipulation feedback only** (drag, snap, scrub) — never for panel chrome.

`--motion-hover-transition` is a prebuilt composite so every hover animates the same five properties identically. Respects the `editorReduceMotion` preference.

#### 12.0.4 z-index — one authority

`base 0` → `panel 10` → `sticky 100` → `overlay 500` → `modal 1300` → `dropdown 1350` → `popover 1360` → `tooltip 1370` → `notification 1400` → `floating-window 1500` → `drag-ghost 9999`. Centralized *"so panels/modals/popovers never collide."*

#### 12.0.5 Component library — 36 primitives

| Component | What it provides |
|---|---|
| **Button** | 5 variants (`primary` `secondary` `ghost` `tertiary` `danger`) × 4 sizes (`xs` `sm` `md` `lg`); loading state swaps label for a spinner; `fullWidth`; `leftIcon`/`rightIcon`; polymorphic `as` (button\|a); forwards ref |
| **IconButton** | Same variant/size ladder; **`aria-label` required**; built-in Tooltip; `active` state |
| **Input** | Sizes, `fullWidth`, `leftIcon`, clear affordance |
| **ValueField** | The scrubbable numeric field — drag to scrub with modifier-scaled precision (`scrubMath.ts`, tested), type to enter, unit suffix. Used everywhere a number is edited |
| **Slider** | Radix-backed |
| **AngleDial** | Rotary angle control with its own tested maths (`angleDialMath.ts`) |
| **ColorPicker** | `react-colorful`, hex + alpha entry |
| **Checkbox** / **Switch** | Boolean controls |
| **Dropdown** | The workhorse menu: `item` / `checkbox` / `separator` / nested submenus, icons, shortcuts, disabled states |
| **Menu** | Menu primitives |
| **Popover** / **Tooltip** | Radix-backed, z-index-token driven |
| **Modal** | Radix dialog with sizes; `Dialogs.tsx` adds `customConfirm`, `customAlert`, `customPrompt` — the Electron-safe replacements for the native functions |
| **Panel** | The panel shell — header, icon, title, close, `hideHeader` |
| **DockPanel** | Tab strip + docking for a region |
| **SplitPane** | Resizable splits |
| **Tabs** | |
| **Accordion** | Collapsible sections — what the Properties panel is built from |
| **PropertyRow** | A labelled row with `StopwatchButton` + `KeyframeNavigator` (`◀ ◆ ▶`) |
| **MatteControl** | Track-matte menu (`matteMenu.ts`) |
| **TreeView** | The layer tree: selection, drag-reorder, inline rename, context menu, per-row actions |
| **VirtualList** | Row virtualizer |
| **List** / **ScrollArea** / **Pagination** | |
| **Icon** | **168 named glyphs**, Phosphor + Lucide backed. Names are deliberately distinct *glyphs*, not just distinct names — with icon-only tabs, two panels sharing a glyph are indistinguishable |
| **Logo** | The brand mark — one component; wordmark 0.78× the mark |
| **EmptyState** / **LoadingScreen** / **ErrorBoundary** | Consistent zero, loading and failure states |
| **Inspector** | Generic inspector shell + `DefaultEditors` + `NodeInspector` |
| **CloudAutosave** / **CloudThumbnailWorker** / **ReadOnlyBanner** | Server-edition surfaces |

> **Recorded trap:** Button and IconButton size ladders once **disagreed** — same token names, different computed sizes. Verify chrome consistency by censusing computed styles.

---

### 12.1 Region map

```
┌──────────────────────────────────────────────────────────────────────────┐
│ TitleBar        app menu · window controls (frameless custom chrome)      │
├──────────────────────────────────────────────────────────────────────────┤
│ TopNav          tool row · new-layer · animate · snap · undo/redo ·       │
│                 workspaces · customize · account       [ToolOptionsBar]   │
├────────────┬────────────────────────────────────────────┬────────────────┤
│ LeftSidebar│  Workspace (canvas)                        │ RightInspector │
│  Scene     │    rulers · guides · grid · gizmos ·        │  Properties    │
│  Assets    │    overlays (text edit, bone, puppet,       │  Rigging       │
│  Library   │    motion path, marquee, snap lines)        │  Effects       │
│  AI        │                          [ViewControls]    │  Graph         │
│  Project   │                          [SceneControls]   │  Presets       │
│            │                          [FocusBreadcrumb] │  History       │
│            │                                            │  Render        │
│            │                                            │  Plugins       │
├────────────┴────────────────────────────────────────────┴────────────────┤
│ BottomTimeline  transport · timecode · tools · comp tabs                  │
│ Timeline        ruler · cache bar · headers · lanes · [GraphEditor]       │
├──────────────────────────────────────────────────────────────────────────┤
│ StatusBar       FpsMeter · InfoReadout · VUMeter                          │
└──────────────────────────────────────────────────────────────────────────┘
  Floating: CommandPalette · Modals · ContextMenuHost · Notifications ·
            OnboardingOverlay · PresentationMode · popped-out panel windows
```

### 12.2 TitleBar

Frameless custom chrome. Holds the **AppMenuButton** (rendering `APP_MENU` from the command registry — §12.9) and the window controls (minimize / maximize / close via `window:*` IPC).

### 12.3 TopNav — the tool row

Left to right, separated by dividers into groups:

1. **Back to Dashboard** (server edition)
2. **Pointer tools** — Selection `V` · Direct Selection `Shift+V` · Rotation `W` · Pan Behind `Y` · Hand `H` · Zoom `Z`
3. **Pen tools** — Pen `G` · Pencil · Brush (pressure ink) · Curvature Pen
4. **Shape tools** — Rectangle `Q` · Ellipse `Shift+Q` · Polygon · Star · Line Segment
5. **Text** `Ctrl+T`
6. **Mask tools** — Rectangle Mask · Ellipse Mask
7. **Rig tools** — Puppet Position Pin `Ctrl+P` · Bone `Ctrl+B`
8. **+ New layer ▾** — Text, Solid…, Camera, Light, Null Object, Adjustment Layer, shapes
9. **Animate ▾** — all 44 presets, then the text rigs (Typewriter, Bounce In Words, Spin & Fade Characters, Tracking Reveal — disabled unless a text layer is selected), then Easy Ease All Keyframes, Time-Reverse Keyframes, Sequence Layers (bars, end-to-end), Stagger Animations (0.3s), then **Add Expression Control ▸** (a submenu of seven control kinds, all resolving through one `ctrl(name)` accessor — a submenu rather than seven flat entries because they are one action with a type)
10. **Snapping** toggle
11. **Rig Logo for Animation** (when a riggable leaf is selected)
12. **More tools ▾**
13. **Undo** `Ctrl+Z` / **Redo** `Ctrl+Shift+Z`
14. **Workspaces ▾** — Default / Animation / Effects / Minimal + Save Current Workspace…
15. **Customize** — Shortcuts, Workspaces, Appearance
16. **Active tool name** hint, then the **AccountButton** (server edition)

**ToolOptionsBar** — a contextual second row that changes with the active tool (brush size / hardness / flow, shape corner radius, star point count and inner radius, pen options, etc.).

### 12.4 Left sidebar — 5 panels

**Scene** — the layer tree. Search box (`Search layers…`) filtering the whole tree and auto-expanding matches; `TreeView` with multi-select, **drag-to-reorder**, **inline rename**, per-row **eye** (show/hide), depth indentation for groups/precomps, and the layer context menu (§12.10).

**Assets** — search across all assets. Toolbar: **Import** (multi-select `image/* video/* audio/*`), **Folder** (`webkitdirectory` — imports a whole folder keeping its structure), **New** folder. Breadcrumb folder navigation. Per asset: thumbnail, **Add to composition**, **Delete asset**, proxy state row. Per folder: **Delete folder and all its contents**. Drag onto canvas or timeline.

**Library — 7 tabs** — **Motion GFX** · **Transitions** · **Sound FX** · **Lottie UI** · **Components** · **Shapes** · **Text**. Every card is drag-to-canvas (typed `setCanvasDrag` payload) as well as click-to-insert, and renders a **live animated preview** driven by the same `build`/`animate` choreography the insert applies.

> Components / Shapes / Text were written, exported, and then left with **no way in** — their only references were panel-renderer entries under ids that were never registered. Saved Components in particular is a whole feature (it is what `componentThumb` renders thumbnails for). They were surfaced here rather than deleted.

**AI** — message list (markdown-rendered) · streaming tool-call progress with per-step labels · Director pipeline stage readout for generative prompts · image attachment · composer with **provider picker**, **model picker**, **execution-mode picker** (Auto / Manual), an **alternatives** toggle, and a Send/Stop button.

**Project** — on-demand project panel.

### 12.5 Right inspector — 8 panels

**Properties** (the merged panel) — an `Accordion` of sections shown conditionally by layer kind, with **one** search box over all of them:

| Section | Appears for |
|---|---|
| **Transform** | every layer — anchor, position (x/y/z), scale, rotation (+ X/Y/orientation in 3D), opacity; each with stopwatch + keyframe navigator |
| **Align & Distribute** | 2+ selected |
| **Parent & Link** | every layer |
| **Switches & Quality** | every layer — shy, collapse, effects, motion blur, adjustment, 3D, quality |
| **Blend & Matte** | every layer |
| **Layer Styles** | every layer — the 10 styles with full params |
| **Saved Styles** | style presets |
| **Time & Playback** | trim, stretch, time remap, frame blending |
| **Fill & Stroke** | shape layers |
| **Geometry & Path Effects** | shape layers — path operators, trim paths, repeater |
| **Text Styles** / **Text Animators** | text layers |
| **Media Settings** | image / video / audio-bearing layers |
| **Audio Settings** | audio-bearing layers (+ waveform) |
| **Camera Settings** | camera layers |
| **Light Settings** | light layers |
| **Particle Settings** | particle layers |
| **SVG Layer** | svg layers (+ convert-to-shapes) |
| **Null Object** | null layers |
| **Pre-composition** | comp instances |
| **Puppet Mesh Pins** / **Skeleton Bone Rigging** | rigged layers |
| **Face Materials** | extruded 3D layers |
| **Version History** | project-level |
| **Template Fields** | when the doc is a template |

**Rigging** — bone hierarchy tree, IK targets and poles, weight-painting controls, mesh preview, puppet pin list with per-pin rotation / stiffness / scale / overlap.

**Effects** — the stack for the selected layer. Add from a searchable palette of the 38 types; per effect: enable toggle, expand for all params (each keyframeable), reorder, delete, mask scoping. Stack-level: **Copy All Effects**, **Paste Effects**, **Save Preset**, **Apply Preset**, **Delete Preset**.

**Graph** — the graph editor **and** the expression editor. Value/speed toggle, bezier handles, tangent alignment, roving; `ExpressionEditor` with tokenizer-driven highlighting, bracket matching and inline error reporting.

**Presets** — all 44 with live `PresetPreview` cards driven by `previewTicker`, plus save/delete of user presets and Copy/Paste Ease.

**History** — the undo stack as a list; named entries (pinned snapshots, the "Open" baseline) render differently from auto-captured edits. Click any entry to jump.

**Render** — the render queue (§10.3).

**Plugins** — third-party plugin UI. Docked rather than modal, because a plugin panel is for use *while* dragging on the canvas.

### 12.6 The canvas (Workspace)

**Chrome** — rulers · guides (draggable from rulers) · grid · proportional grid · safe areas · ground grid (3D) · region of interest · channel isolation (R/G/B/A) · layer bounding boxes · motion paths with dot density · snap lines · marquee.

**Overlays** — `TextEditOverlay` (an editable box seeded with the layer's text — the replacement for `window.prompt`, which Electron's Chromium refuses) · `BoneOverlay` · `PuppetOverlay` · gizmo overlays · `FocusBreadcrumb` (`Main › Scene 2 › Logo`).

**ViewControls** (canvas top-right) — zoom out / **zoom field** (drag or double-click to type) / zoom in / fit-comp, a **magnification presets** menu, Rulers toggle, Safe Areas toggle, **Channel View** picker, and a **View Options ▾** menu:
Grid · Rulers · Safe Areas · **3D Camera ▸** (Active Camera + views) · **View Layout ▸** (1 View / 2 Views (view-only right pane) / 4 Views (2×2 grid, top-left interactive)) · **Show Channel ▸** · Motion Paths · **Motion Path Dots ▸** (off / small / medium / large) · **Resolution ▸** · Auto-Keyframe Mode · **Region of Interest ▸** (Restrict to Region / Region to Centre / Clear Region).

**SceneControls** (3D) — camera tools **Orbit Around Cursor** / **Pan Camera** / **Dolly Camera** (hold Alt to use temporarily, `C` to cycle); gizmo modes **Universal** (move·rotate·scale) / **Position** / **Scale** / **Rotation**; ground-plane toggle; layer-bounding-box toggle.

**Snapping** (`SnapEngine`) — pure and stateless per call, computed in **world units** with the screen-px threshold converted at the current zoom so the magnet feels constant. Settings: enabled, to grid, to guides, to objects, to edges, to centers, threshold px. Returns the corrected position **plus the snap lines to highlight**.

**Selection** — click, shift-click additive, marquee, oriented bounding boxes, multi-select gizmo with a shared transform origin, dimensional guides while dragging, hit-testing via a spatial index.

### 12.7 Bottom — timeline

Full anatomy in §7.6: transport bar, ruler, cache bar, work area, track headers, lanes, keyframe interaction, graph editor, comp tabs.

### 12.8 Modals and dialogs

| Modal | Opened from | Contents |
|---|---|---|
| **New Composition** | dashboard / command | size, fps, duration, background, presets |
| **Composition settings** | Composition menu (`comp.settings`) | same, for the open comp |
| **Export composition** | File ▸ Export… | format picker with per-format hints, range, resolution, output path |
| **Version History** | File ▸ Version History… | snapshot list, restore |
| **Customize** | TopNav / Window ▸ Customize… | 3 tabs — **Shortcuts** (rebind, disable, conflict detection), **Workspaces**, **Appearance** |
| **Settings** | account menu | app settings |
| **Account** | AccountButton | profile, plan (server edition) |
| **Plugins** | Plugins menu | install from `.zip`/folder, **permission consent screen**, enable/disable, open panel, uninstall |
| **New camera** | Layer ▸ New ▸ Camera | one-node / two-node, preset lens |
| **New light** | Layer ▸ New ▸ Light | type, colour, intensity, cone, shadows |
| **Recover unsaved work?** | boot, when the recovery index has entries | recover / discard |
| **Upgrade to Pro** | plan gates (server edition) | |
| **Output Module** | render queue | per-job format + settings |
| **About Premation** | Help ▸ About | version, license |
| **customConfirm / customAlert / customPrompt** | anywhere | Electron-safe replacements for `window.confirm/alert/prompt`, with the same call shape |

### 12.9 The app menu

9 groups, 63 items — enumerated in §12.17. Every item names a command id; the registry supplies label, enabled state and chord, so the menu bar stays a thin renderer. A dynamically-built **Plugins** group is appended.

### 12.10 Context menus

Ten call sites. The main ones:

**Layer / canvas** — Select All · Deselect · Duplicate · Delete · Rename… · **Arrange ▸** (Bring to Front / Bring Forward / Send Backward / Send to Back) · Group Selection · Ungroup · Pre-compose… · **Label Color ▸** · **Merge Paths ▸** (Live Union (Add) / Live Subtract / Live Intersect / Live Exclude (XOR) / Bake Union / Bake Subtract / Bake Intersect / Bake Exclude — live is non-destructive, bake is destructive) · **Add Keyframe ▸** (Position / Scale / Rotation / Opacity / All Transform) · Rig Logo for Animation · Fit Comp in View · None (Default)

**Keyframe** — Easy Ease · Easy Ease In · Easy Ease Out · Linear Interpolation · **Enable/Disable Hold (Stepped)** · **Enable/Disable Roving (Rove Across Time)** · Copy Keyframes (`Ctrl+C`) · Paste at Playhead (`Ctrl+V`) · Delete keyframe

**Clip** — Split at playhead · Delete clip · Start · End

**Property row**, **panel header** (dock / pop-out / close), **asset**, and **plugin** each have their own.

### 12.11 Floating and system surfaces

- **Command palette** (`Ctrl+K`) — fuzzy search over the whole command registry, showing each command's live label, enabled state and chord
- **Notifications** — `uiStore.notify({ level, message, durationMs })`; success / warning / error
- **Onboarding overlay** — Help ▸ Take a Tour
- **Presentation mode** — full-screen preview, plus a separate-window variant
- **Popped-out panels** — any panel into its own OS window (`popout:spawnWindow`), synced through a broadcast channel
- **Status bar** — `FpsMeter` (live render fps), `InfoReadout` (cursor position, selection dimensions, contextual hints), `VUMeter` (live audio levels)
- **Read-only banner** — server edition, when the document isn't editable

### 12.12 Undo / history model

- **Two stacks**, capacity **500**, engine-agnostic — the service does not know what state commands mutate.
- A command participates in undo only if it provides `undo`.
- **Coalescing by target.** A burst of edits on the *same* target merges into one entry, so a drag is one `Ctrl+Z`. `schedule(key)` commits the pending entry when the **target changes** — before this, a plain 700ms timer merged unrelated edits (recolour one layer, nudge another → one Ctrl+Z took back both, with no way to recover just one).
  - *Limit, deliberately encoded:* snapshots are captured when the entry is **committed**, not when the edit happened, so the first change of a new target lands in the previous entry. Each action still gets its own step, but the boundary is off by one event. Only per-operation commands fix that properly; this is a mitigation, not a cure.
- **Named entries** — deliberate, user-meaningful entries (pinned snapshots, the "Open" baseline) are flagged `named` and render differently in the History panel.
- **One stack for everything.** Timeline edits push a `TimelineCommandAdapter`; plugin edits and AI runs wrap in `runDocumentEdit` / `aiTransaction`. There is no second undo stack anywhere.
- **`CompositeCommand`** undoes its children in reverse order. `suspend`/`resume` for programmatic batches.
- ⚠️ **Recorded severe bug (fixed):** history was once baselined *after* `seedDefaultScene`, so one undo wiped the project.

### 12.13 Assets, proxies and media

**Import** is content-addressed: bytes → SHA-256 → `assets/`. Duplicate imports dedupe for free.

**Probing** (`media:probe`, main process) returns dimensions, fps, duration, **alpha presence** and audio presence. Alpha is detected, never assumed.

**Proxies** — a low-resolution stand-in decoded **during editing, never during output**. Measured, not guessed:

| | 4K | 1080p | 540p |
|---|---:|---:|---:|
| seek, random | 171.8 ms | 36.6 | 17.4 |
| seek, 1-frame step | 148.0 ms | 40.9 | 16.3 |
| GPU upload (WebGPU) | 4.3 ms | 4.4 | 3.8 |
| GPU upload (WebGL2) | 0.1 ms | 0.1 | 0.1 |

Two conclusions drive the design: **seek is 97.6% of the cost at 4K** and the only term that scales with resolution; upload is **flat** across a 16× payload range, so it is per-call overhead, not bytes. And since seek cost *is* decode-from-keyframe cost, a proxy wins on resolution **and** on GOP length — hence `-g 12`, far shorter than the 60 the measurement used.

**Invariants:** generation never blocks import (`startProxy` returns as soon as the job is queued); the asset renders at full resolution the whole time and switches only when a proxy is ready **and** Use Proxies is on; **every** failure path — no ffmpeg, encode error, cancellation, asset deleted mid-encode — lands the asset back at full resolution rather than in an error state, *because "slower than it could be" is always better than "wrong"*; and export **always** uses the original.

### 12.14 Focus mode and navigation

Two ideas share one navigation stack:

- **Enter a precomp/group in place** — pushes it onto `path`. The parent renders **ghosted** around the focused subtree, so you never lose context.
- **Isolate a single layer** — sets `isolatedId`; everything else ghosts.

A **breadcrumb** (`Main › Scene 2 › Logo`) always shows location. `Esc` steps up one level; clicking a segment jumps directly. Ghosted state propagates into the timeline (`track.ghosted`) so both surfaces agree.

### 12.15 Panels — the registry

| Panel | Region | Closable | Notes |
|---|---|---|---|
| **Scene** | left | no | Layer tree, virtualized |
| **Assets** | left | no | Imported media |
| **Library** | left | no | The six catalogues |
| **AI** | left | no | Assistant chat + composer |
| **Project** | left | yes, on-demand | |
| **Properties** | right | no | *Merged 2026-08-03* — `style` and `misc` folded in. All three were accordions of property sections for the selected layer, so the split only made the user guess which tab owned the property they wanted, and each carried a search box that couldn't see the other two |
| **Rigging** | right | no | Bone + puppet |
| **Effects** | right | no | The effect stack |
| **Graph** | right | no | Graph editor **and** expression editor |
| **Presets** | right | no | |
| **History** | right | yes, on-demand | |
| **Render** | right | on-demand | Render queue |
| **Plugins** | right | yes, on-demand | Opens itself when a plugin calls `motion.ui.openPanel()` |
| **Timeline** | bottom | — | Plus the graph editor toggle |

Panels can be **popped out into separate windows** (`popout:spawnWindow`), which is why `PANEL_DEFS` lives in its own module — a pop-out renders `PopoutRoute`, never `EditorShell`, so it can't rely on the layout store's registration.

**Deliberately absent:** a `comments` panel. Review comments, approvals and shareable review links were removed outright — not gated, not hidden behind a plan.

**Removed as duplicates (2026-07-25), not as features:** `flow` (a second full bezier easing editor writing through the wrong store, showing stale handles) and `motiontools` (a shortcut board for six properties other panels own, two of whose writes were *wrong* — label colour bypassed `setNodeLabelColor` so it never serialized, and time remap keyed at comp time instead of converting through `compToKeyframeTime`).

### 12.16 Tools — the registry (20 classes + 2 overlay tools)

| Class | id | Shortcut | Behaviour |
|---|---|---|---|
| `SelectTool` | `select` | `V` | Click, shift-click additive, marquee, transform handles |
| `DirectSelectionTool` | `direct-select` | `Shift+V` | Per-vertex / per-handle editing on paths and masks |
| `MoveTool` | `move` | — | Constrained translate |
| `RotateTool` | `rotate` | `W` | Spins about the **anchor**, AE semantics |
| `PanBehindTool` | `pan-behind` | `Y` | Places the anchor without moving the layer; dragging the body moves the anchor too |
| `HandTool` | `hand` | `H` | Pan the view |
| `ZoomTool` | `zoom` | `Z` | Click / drag zoom |
| `PenTool` | `pen` | `G` | Full bezier authoring |
| `PencilTool` | `pencil` | — | Freehand, fitted to beziers |
| `BrushTool` | `brush` | — | Pressure-sensitive ink |
| `CurvatureTool` | `curvature` | — | Curvature-pen authoring |
| `RectangleTool` | `rectangle` | `Q` | Live parametric rect |
| `EllipseTool` | `ellipse` | `Shift+Q` | Live parametric ellipse |
| `PolygonTool` | `polygon` | — | N-gon with point count |
| `StarTool` | `star` | — | Points + inner radius |
| `LineTool` | `line` | — | Line segment |
| `MaskRectangleTool` | `mask-rect` | — | Rect mask on the selected layer |
| `MaskEllipseTool` | `mask-ellipse` | — | Ellipse mask |
| `TextTool` | `text` | `Ctrl+T` | Inline canvas text editing |
| `CameraTool` | `camera` | — | 3D camera navigation |
| *(overlay)* Puppet Position Pin | `puppet-pin` | `Ctrl+P` | §7.8 |
| *(overlay)* Bone | `bone` | `Ctrl+B` | §7.8 |

> Note on `A`: the AE preset deliberately leaves bare `A` to the anchor-point **reveal** shortcut, so Direct Selection took `Shift+V` rather than stealing it.

### 12.17 App menu — 9 groups, 63 items

**File** New Project · Open… · Save · Save As… · Increment and Save · **Sync Project…** · Export… · **Version History…** · Close Project
**Edit** Undo · Redo · Cut · Copy · Paste · Select All · Deselect · Duplicate · Delete
**Composition** Composition Settings… · Save Frame As PNG
**Layer** New ▸ Text / Solid… / Camera / Light / Null Object / Adjustment Layer · Bring to Front / Forward · Send Backward / to Back · **Pre-compose…**
**Effect** Fast Box Blur · Glow · Brightness & Contrast · Contrast · Hue/Saturation · Grayscale · Sepia · Hue Rotate
**Animation** Keyframe Assistant: Easy Ease · Easy Ease In · Easy Ease Out · Keyframe Interpolation: Linear · Hold
**View** Toggle Scene Panel / Inspector / Timeline · Show Grid · Show Proportional Grid · Snap to Grid · Toggle Rulers · Toggle Safe Areas · Reset Layout · Switch Theme
**Window** Command Palette · Present (Preview) · Project · Effects · Render Queue · Graph Editor · Customize…
**Help** Take a Tour · About Premation
*(+ a dynamically-built **Plugins** group)*

> "New Composition…" is deliberately absent — compositions and their size are created from the dashboard, one project per composition.

### 12.18 Viewport chrome — the full guides model

`guidesStore` owns every piece of viewport chrome behind one cache key so a change invalidates exactly once:

rulers · grid (spacing, subdivisions, style, colour) · **proportional grid** (columns × rows) · snap to grid · guides · safe areas · **ground grid** · **draft 3D** · channel isolation (R/G/B/A) · motion-path visibility + dot density · `viewLayout` (1 / 2 / 4 views) · `secondaryViewMode` · `quadViewModes[4]` · custom views · `camera3dMode` · **region of interest** · pixel sampler · layer-bounds toggle · `gizmo3dState` · `gizmo3dAxisMode` · `gizmo3dSnapping` *(⚠️ no readers — §16.1)*.

### 12.19 Workspaces and preferences

**Workspaces** — 4 built-in layouts (**Default**, **Animation**, **Effects**, **Minimal**) plus user-saved ones. Persisted, restorable, and synced across pop-out windows via a broadcast channel (`syncChannel` / `windowSync`).

**Preferences** (`preferenceStore`, all persisted):

| Preference | Values / default |
|---|---|
| `theme` | dark *(default)* / light |
| `uiScale` | 1 |
| `buttonSize` | sm / **md** / lg |
| `iconSize` | sm / **md** / lg |
| `sidebarDensity` | compact / **default** / comfortable |
| `timelineAutoKeyframe` | false |
| `editorReduceMotion` | false |
| `confirmOnClose` | **true** |
| `timelineHeaderWidth` | 460 |
| `retainOriginalSvg` | **true** |
| `showLayerBounds` | **true** |
| `useProxies` | false |

**Themes** — `dark.css` / `light.css` map the primitive layer to semantic roles; an accent colour is selectable on top (`accent.ts`), and a pasteboard colour for the area outside the comp.

---

## 13. Keyboard reference

Defaults follow **After Effects**. Every chord below is rebindable in Customize ▸ Shortcuts.

### Transport & timeline
| Chord | Action |
|---|---|
| `Space` | Play / pause |
| `J` / `K` | Previous / next frame |
| `Home` / `End` | Go to start / end |
| `PageUp` / `PageDown` | Step by second |
| `B` / `N` | Set work-area in / out |
| `Shift+B` | Extend work area |
| `[` / `]` | Move layer start / end to playhead |
| `Alt+[` / `Alt+]` | **Trim** layer in / out at playhead |
| `Alt+S` | Split layer at playhead |
| `Shift+D` | Duplicate in timeline |
| `Z` | Zoom timeline to fit |
| `C` / `V` | Copy / paste keyframes (timeline scope) |

### Property reveal (AE)
| Chord | Reveals |
|---|---|
| `P` | Position (`x`, `y`, `z`, merged pseudo-row, static placeholder) |
| `S` | Scale |
| `R` | Rotation (incl. `rotationX`/`rotationY`) |
| `T` | Opacity |
| `A` | Anchor point |
| `M` | Masks |
| `L` | Audio levels |
| `U` | Toggle **animated** properties on the selection |
| `UU` | Toggle animated properties across **all** layers |

### Add keyframe (AE's `Alt+Shift+<prop>`)
`Alt+Shift+P` position · `Alt+Shift+S` scale · `Alt+Shift+R` rotation · `Alt+Shift+T` opacity · `Alt+Shift+A` anchor
Each adds a keyframe on every selected layer at the playhead, enables animation if needed, holds the value currently on screen, and reveals the new diamond.

### Easing
`F9` Easy Ease · `Shift+F9` Easy Ease In · `Ctrl+Shift+F9` Easy Ease Out

### Edit
`Ctrl+Z` / `Ctrl+Shift+Z` undo / redo · `Ctrl+X` / `Ctrl+C` / `Ctrl+V` · `Ctrl+A` select all · `Esc` deselect · `Ctrl+D` duplicate · `Delete` / `Backspace` delete

### Layer order
`Ctrl+Shift+]` bring to front · `Ctrl+]` bring forward · `Ctrl+[` send backward · `Ctrl+Shift+[` send to back

### Layer / comp
`Ctrl+Shift+C` pre-compose · `Ctrl+Alt+Shift+T` new text · `Ctrl+Y` new solid · `Ctrl+Alt+Shift+Y` new null · `Ctrl+Alt+Y` new adjustment · `Ctrl+Alt+M` motion path

### Project
`Ctrl+N` new · `Ctrl+O` open · `Ctrl+S` save · `Ctrl+Shift+S` save as · `Ctrl+Alt+Shift+S` increment and save

### View / panels
`Ctrl+K` command palette · `Ctrl+Shift+K` (palette variant) · `` ` `` focus workspace · `F3` graph editor · `Shift+F3` (rebound) · `F6` · `Shift+G` · `U` reveal · `Ctrl+'` grid · `Alt+'` proportional grid · `Ctrl+Shift+"` snap to grid · `1` / `2` view modes · `C` camera cycle · `Esc` camera exit

---

## 14. Workflows — step by step

### 14.1 First run → first export

1. `npm run electron:dev:local` → the app opens straight into the editor (local edition has no sign-in).
2. **Help ▸ Take a Tour** if you want the guided version.
3. Drop media onto the **Assets** panel, or use **Layer ▸ New ▸ …** to create a layer.
4. Set the comp up: **Composition ▸ Composition Settings…** (size, fps, duration, background).
5. Animate: select a layer, press `P`, click the stopwatch, move the playhead, change the value.
6. Preview with `Space`.
7. **File ▸ Export…** → pick a format → render. Or queue it: **Window ▸ Render Queue**.
8. **Ctrl+S** — you'll be asked for a `.motion` bundle location on first save.

### 14.2 Keyframing a property (the canonical loop)

1. Select the layer.
2. Reveal the property: `P`/`S`/`R`/`T`/`A`, or twirl it open in the timeline.
3. Click the **stopwatch** to enable animation — this writes a keyframe at the playhead **holding the value currently on screen**. (Three call sites — stopwatch, add-keyframe command, timeline value fields — deliberately share one `propertyValueAt` definition so they can't key different numbers.)
4. Move the playhead, change the value → a keyframe is added automatically.
   - Or press `Alt+Shift+<prop>` to key without changing anything.
   - Or turn on **auto-keyframe** in preferences.
5. Shape the timing: select keyframes → `F9` (Easy Ease), or open the **Graph** panel for bezier handles.
6. Refine spatially: enable the motion path (`Ctrl+Alt+M`) and drag the tangent handles on canvas.

> **The one rule that bites:** keyframes live on the **layer's** time axis (`getRemappedTime`), not comp time. If a layer is trimmed, stretched or time-remapped, keying at comp time lands on the wrong frame. Everything in the codebase that writes a keyframe converts first.

### 14.3 Building a 3D scene

1. Enable the **3D switch** on the layers you want in space.
2. **Layer ▸ New ▸ Camera** — the viewport now looks through it. `C` cycles cameras, `Esc` exits camera nav.
3. **Layer ▸ New ▸ Light** — set type, intensity, colour, cone; enable shadows on the light and "casts shadows" on the layers.
4. Spread layers in Z. Remember: a 3D layer is a **plane with no thickness** — edge-on it draws nothing (that's correct). Use **Top/Left/quad view** to see the spread.
5. Watch for the **2D-layer-as-wall rule**: a 2D layer (or an adjustment layer, or a matte pair) between two 3D layers splits them into separately-sorted render groups. If two 3D layers refuse to sort against each other, look for a 2D layer between them.
6. Extrude for depth: enable extrusion, set depth and bevel, assign per-face materials.
7. Animate the camera, or use the AI `add_camera_move` tool.

### 14.4 Masking and mattes

**Mask** (cuts the layer it lives on):
1. Select the layer → Rectangle/Ellipse Mask tool, or the Pen tool.
2. Draw. Set mode (`add` / `subtract` / `intersect` / `lighten` / `darken` / `difference` / `none`), feather, opacity, expansion, inverted.
3. `M` reveals mask properties. The mask **path itself** is keyframeable (vertex morph).

**Track matte** (one layer cuts another):
1. Put the matte layer above the target.
2. On the target, set the matte source and mode: **Alpha** or **Luma**, with an **invert** toggle. (Decoupled from stacking order — you pick the source explicitly.)

**Effect-scoped mask** (M6):
1. Draw a path and set its mode to **`none`** — mode `none` exists precisely so a path can be geometry without being a cut.
2. On the effect, set its `maskId` to that path. The mask's feather drives the effect's edge falloff; its opacity drives the effect's intensity.
3. Invariant: outside the mask the layer is **byte-identical**, alpha included. An effect mask decides *where the effect applies*, never *where the layer exists*.

### 14.5 Text animators

1. Text tool → type on canvas (an inline editable box, not a `window.prompt`).
2. Properties ▸ Text ▸ **Add Animator** → pick the property (position, scale, rotation, opacity, fill colour, tracking, skew…).
3. The animator gets a **Range Selector**. Set `basedOn` (characters / words / lines), then animate `start` / `end` / `offset`.
4. Open **Advanced**: `amount`, `smoothness`, `easeHigh`, `easeLow` — AE's full option set.
5. Add more selectors to the same animator (they compose), including a **wiggly** selector with its own frequency.
6. For 3D per-character motion, enable **per-character 3D**.
7. Shortcut: use a ready-made rig — Typewriter, Bounce In Words, Spin & Fade Characters, Tracking Reveal — from the Animate menu, then edit the keyframes it wrote.

**Text on a path:** draw a mask path on the text layer, then set the layer's text-path to it. Glyphs place by arc length with tangent rotation; `firstMargin` is keyframeable.

### 14.6 Rigging a character (puppet)

1. Select the layer → **Puppet Position Pin** tool (`Ctrl+P`).
2. Click to place pins. Auto-binding computes Laplacian harmonic weights (150 Jacobi iterations).
3. Drag a pin → the mesh deforms with **ARAP** (or switch to LBS). One gesture = one undo step.
4. Per pin: rotation, stiffness, scale, overlap (overlap resolves by painter's index order *within* the layer).
5. Animate: move the playhead and drag — pin positions keyframe with easing and **spatial tangents**.
6. Or record in real time with **Puppet Sketch**.
7. Optionally add a **skeleton** on the same layer — puppet applies first in rest space, skeleton skins on top.

**Bone rig:** Bone tool (`Ctrl+B`) → draw a hierarchy → paint weights with the brush → pose with FK, or add an **IK target** with a **pole vector** (analytic two-bone, or FABRIK for longer chains). Bone rotation/position/scale and IK target/pole positions are all keyframeable.

### 14.7 Using the assistant

> **Server edition only.** The local (OSS) edition does not ship the assistant —
> the panel, the commands, the settings tab and the shell's AI IPC are all
> absent. The BYOK machinery below is built and unchanged; it is a distribution
> decision, gated by `aiEnabled()`. See §16.2 item 2.

1. Open the **AI** panel.
2. Connect a provider (Anthropic / OpenAI / Gemini) and enter your key. On the desktop build it goes into the **OS keychain**; the call is made from the Electron main process, never the renderer.
   - Key entry lives in **Customize… → AI** (`0639bfa` moved it there from the dashboard, which is a server-edition-only route).
3. Pick a provider + model in the composer.
4. Choose the execution mode: **Auto** (apply immediately) or **Manual** (review a preview first).
5. Prompt it. The result is **one undo entry** regardless of how many tool calls it made.
6. For generative work, turn on the alternatives toggle — it emits several variants and ranks them with the linters at **no extra model calls**.
7. Everything it did is normal editable document state — keyframes, effects, layers. Nothing is locked or opaque.

### 14.8 Authoring a template

1. Build the scene normally.
2. Mark the properties you want exposed as **template fields** — each field names a real node + component + prop, and the field's *kind* determines the control the panel shows.
3. Add **media slots** where a user should drop their own footage or logo (filling a slot repoints `assetId`).
4. Mark **protected time regions** — regions that must not stretch when the template's duration changes.
5. Save as a template. Tests enforce that every exposed field targets something real and that applying field values changes **only** the exposed props.

### 14.9 Writing a plugin

1. `plugin.json` — id, semver, apiVersion, entry path, requested **permissions**, optional panel.
2. An ES module exporting `activate(motion)`.
3. Zip it (or point at the folder) → install → the consent screen lists exactly what it will be able to do, **before any code exists anywhere**.
4. Inside, you get `motion.*` methods. Each call is permission-checked by name and runs inside `runDocumentEdit`, so it's one undo step.
5. If your plugin blocks its event loop it stops answering the heartbeat and is terminated in ~12 seconds — the editor never notices.

Full guide: [`docs/PLUGINS.md`](PLUGINS.md).

### 14.10 Exporting

1. **File ▸ Export…** (or add to the queue via **Window ▸ Render Queue**).
2. Pick the format — the dialog tells you what each one is for and what it costs.
3. For mp4/mov you need ffmpeg. If it isn't found, you get a message naming the reason and the alternative (WebM or PNG sequence).
4. The export renders through the **same engine as the viewport**, streams frames to disk one at a time, and muxes with a local ffmpeg child process.
5. The app stays usable during a long render.

### 14.11 Recovering from a crash

1. Reopen the app — the recovery index (SQLite) surfaces the recovery modal.
2. Bundles are written **manifest-last**, so a partially-written save is detectably incomplete rather than silently corrupt.
3. If you need an older state, **File ▸ Version History…** — snapshots share unchanged objects, so history is cheap and complete.

### 14.12 Contributing / debugging

1. Read the last ~10 commit **bodies** — this repo uses commit bodies as the delta ledger, and they carry more truth than the `.md` docs.
2. **The `.md` docs are stale. Read the code.**
3. Live-verify by importing `/src` modules in the running app's console — but beware: a console import can return a **second singleton** (Vite duplicate module instances).
4. Run `npm test` (fast). Run `npm run render-tests` before and after any renderer change — clean HEAD is green, so it bisects visual regressions by percentage.
5. Never bench under jest — the vm realm reorders the profile.
6. Verify **reads**, not just writes: trace control → handler → store/command → **reader**. A control is only wired when something downstream consumes what it writes.

---

## 15. Quality gates and testing

| Gate | Command | What it proves |
|---|---|---|
| Unit + integration | `npm test` | ~440 suites / ~4,800 tests, under a minute |
| Types | `npm run typecheck` | `tsc --noEmit` across the whole workspace |
| Lint | `npm run lint` | eslint 9 flat config, incl. a custom rule closing the F11 defect class |
| **Golden-image render tests** | `npm run render-tests` | Real Chromium, real GPU. Committed reference frames, pixelmatch diff by percentage |

**Testing philosophy visible in the tree:**

- Tests live *next to* the code (`buildSnapshot3dParenting.test.ts` beside `buildSnapshot.ts`), not in a parallel tree.
- **Behaviour-shaped names**: `exportRefusesBadFrame.test.ts`, `networkFreeSavePath.test.ts`, `noHostRealmEval.test.ts`, `puppetSnapshotParity.test.ts`, `verifyAgainstCompose.test.ts`. Each asserts a *guarantee*, not an implementation.
- **Parity tests** pin two paths together: `overlayMeshParity`, `puppetSnapshotParity`, `kerningAgreement`, `parFitOrder`.
- The render-tests harness is the **pixel gate**. Only update goldens when you've looked at the diff and can say why the new pixels are correct.

**Known testing traps (recorded):**
- The repo must not live under OneDrive — it hides test files from jest. **Check the suite count.**
- Never benchmark under jest — the vm realm distorts the profile.
- `node-canvas` ignores `ctx.filter`, so headless-canvas fidelity ≠ browser fidelity.
- The harness's swiftshader flag suppresses Dawn — check `resolvedKind`, not `kind`, or you'll believe you tested WebGPU when you tested WebGL2.

---

## 16. Honest state — partial, missing, broken

Two audits were run on 2026-08-03. This section merges them and updates both against HEAD (`faef1c3`), since several items were fixed after the audits were written.

### 16.1 Missing features

| Item | Why it's absent |
|---|---|
| **Dissolve / Dancing Dissolve** blend modes | The last 2 of AE's 38. Both are per-pixel stochastic — the cost isn't the blend, it's a determinism contract between preview and export |
| **Pipeline-determinism gate** | The existing gate re-renders from the *same snapshot object*, so it covers renderFrame → GPU → readback but is structurally blind to the front half. A stochastic source sampled into the snapshot would pass every time. Dissolve is the first mode that needs this |
| **Variable-width mask feather** | Feather is a single scalar per path; `MaskPoint` carries only x/y + handles. Uniform feather *is* implemented and rendered |
| **Wiggle Transform** (shape operator) | No implementation. The *expression* `wiggle()` is complete — different feature |
| **Chainable path-operator stack** | `fx.pathOp` is a single slot; AE's shape contents list chains. Same single-slot shape for `trim`, `rep`, `textPath` |
| **3D gizmo snapping** | `guidesStore.gizmo3dSnapping` has zero readers and zero writers outside the store; `toggleGizmo3dSnapping` has no caller |
| **Local project browser** | The local edition opens straight into the editor. The SQLite local index and the version store both exist and are tested; the home surface that would use them doesn't |
| **Continuous rasterization** | The one remaining gap in the composition-boundary work |
| Motion tracking / rotoscoping | Out of scope by direction |
| Real-time collaboration | Removed outright, not deferred |
| Imported 3D models, PBR, HDRI | Out of scope — that's AE's Advanced 3D, a separate project |

### 16.2 Broken or half-wired (P1/P2 at HEAD)

| # | Item | State |
|---|---|---|
| 1 | ~~`window.prompt` dead in Electron (3 features)~~ | ✅ **Fixed at HEAD** (`faef1c3`) — Save Workspace, Save Effect Preset and layer Rename now use `customPrompt`. Zero `window.prompt(` call sites remain |
| 2 | ~~**AI provider setup is unreachable in the local edition**~~ | ✅ **Resolved — by removing the surface, not by mounting it.** The original fix landed (`0639bfa`): `AiSettingsSection` was mounted in the Customize… dialog and the link repointed. Then the product decision changed: **the local edition no longer ships the assistant at all.** `aiEnabled()` is `isServerEdition()` again, and the panel, renderers, Customize tab, `openAiSettings` and the AI Focus workspace are each gated, as is the AI IPC registration in the Electron main process. There is no key-entry surface in the local edition because there is nothing to enter a key for. The BYOK implementation is untouched and still ships in the server edition |
| 3 | ~~**"Dock Bottom Timeline" makes a panel disappear**~~ | ✅ **Fixed** (`cf23d1e`). The menu item is gone. Guard: `src/layout/__tests__/panelDocking.test.ts` parses the dock targets `PanelHeader` offers and the regions `DockPanel` is actually mounted for, and fails if the first is not a subset of the second |
| 4 | ~~**Render Queue "Pause" is actually "Abort"**~~ | ✅ **Fixed** (`cf23d1e`). Labelled **Stop**, stop icon, title *"Stop rendering — discards progress on the current job"*, and a confirm dialog that only appears when a job is genuinely mid-render. Real pause/resume remains unbuilt and is still a separate project |
| 5 | ~~**Per-layer "Draft Quality" switch is write-only**~~ | ✅ **Fixed** (`5e7c937`) — the renderer reader was implemented rather than the switch removed. Chain: `buildSnapshot.ts:1597` → `RenderLayer.quality` → `snapshotToFrameScene.ts:579` sets `sampling: 'nearest'` → `CompositionPass.ts:275` selects a nearest-clamp sampler. Guard: `src/core/rendering/__tests__/contentHashReaders.test.ts` asserts **every** field folded into the content key has a reader in the pixel path — 35 fields, `quality` among them. That guard is the general fix for this class |
| 6 | **Classic Color Burn / Dodge / Difference render identically to their modern counterparts** | ⚠️ Known and documented (F9) — **note re-confirmed accurate this run.** The names are kept for round-tripping and picker parity. Verified by rendering both and comparing — not assumed. Closing it needs AE's pre-7.0 formulas |

Plus (from the audit) 5 P3 "duplicated or inconsistent" and 11 P4 "dead code / permanently-disabled UI / stale docstring" items. Full detail: [`docs/EDITOR_WIRING_AUDIT.md`](EDITOR_WIRING_AUDIT.md).

> **§16.2 is closed.** Items 1–5 are fixed; item 6 is a documented parity note, not a defect.
>
> One correction to this document's own account, found while walking it. §16.2
> item 2 as written above described "8 dead `!aiEnabled()` branches" whose false
> path had never executed. **That was wrong.** There are eight branches, but they
> are `aiRunsThroughBackend()` branches (`aiKeyStore` ×6, `aiTransport`,
> `DirectorRunner`), rewritten from `aiEnabled()` in `2dffc8f`. That predicate is
> `isServerEdition()`, which is false in the local edition — so those false paths
> had been live all along, and `aiTransport.test.ts` and
> `directorEditionGate.test.ts` already covered them. Nothing needed correcting.
>
> The genuinely dangerous state was the opposite one, and this document did not
> name it: `aiEnabled()` had become `() => true` with **zero runtime callers**.
> Flipping it to `isServerEdition()` would have hidden *nothing* while passing a
> typecheck and looking exactly like a fix. §2·0 — a value whose readers had
> drifted away from it. Every surface had to be gated individually, which is what
> `editionAiSurface.test.ts` now pins.

### 16.3 Documentation that is stale

| Doc | What was wrong | State |
|---|---|---|
| `README.md` | Said the AI assistant is *"disabled and reads 'coming soon'"* in the local edition | ✅ **Rewritten.** The sentence had become *coincidentally* true again — local ships no assistant — but for the opposite reason to the one it gave. It now says the surface is absent rather than pending, that this is a distribution decision and not a technical limit, and that the no-network guarantee is enforced in the main process |
| `ROADMAP.md` | Listed "Bring-your-own-key AI" under **Now** as the biggest gap, with a 4-step plan whose steps 1–4 were all done | ✅ **Rewritten.** The item is out of **Now** and recorded under **Not planned**, including that all four steps were completed and then deliberately reverted — so nobody rebuilds it |
| `docs/FEATURE_AUDIT.md` | Correct when written, but 4 of its ⚠️/❌ items shipped immediately after | ✅ **Marked.** Stencil/Silhouette (`045cd09`), keyframe-selection time scaling (`59e6f9c`), Wiggle Paths time term (`61fc1fc`), repeater's three missing params (`a0edf7a`) are flagged inline as shipped, with the counts restated. The audit body is left as the snapshot it was |
| `src/core/effects/layerQuality.ts` docstring | Claimed the renderer reads it to toggle `imageSmoothingEnabled`. It did not | ✅ **Fixed in `5e7c937`**, and by building the reader rather than deleting the claim. The docstring now names the real chain and points at the guard test |

**The general rule for this repo: the commit bodies are the delta ledger. The `.md` files lag. Read the code.**

> Every entry in this table was a docstring or a doc asserting a reader,
> behaviour or gap that did not exist. That is the third instance of the pattern
> on this project, and it is why the two guards that landed with these fixes —
> `contentHashReaders.test.ts` and `editionAiSurface.test.ts` — assert the
> *presence of a consumer* rather than the correctness of a value. A claim with a
> test behind it is a claim that cannot quietly go stale.

### 16.4 What's notably *more* complete than expected

Worth stating because the plans repeatedly under-read the build:

- Expressions are **not** `new Function` — a real hand-written language with cycle detection and a depth cap. That's what makes them work under CSP.
- Motion blur has shutter **phase** and **adaptive sampling** — both beyond the stated ask.
- The mask model includes AE's 7th mode (`none`), effect-scoped masking, and protected time regions.
- Track mattes were already decoupled from stacking order.
- The compositing-group boundary the stencil modes were estimated as *needing first* already existed — checking the renderer rather than the estimate turned an L into an M.
- Templates (exposed fields, field kinds, data binding, media slots, responsive time) are complete and tested — "do not rebuild."

---

## 17. Competitive comparison

### 17.1 Against After Effects (the stated target)

| Area | AE | Premation | Verdict |
|---|---|---|---|
| Blend modes | 38 | **36** | Missing Dissolve + Dancing Dissolve only |
| Effects | 400+ (incl. 3rd party) | **38** built-in | Big gap in *breadth*; the ones present are parameterised properly (Levels, Curves, Channel Mixer, Keylight with despill/choke/softness) |
| Layer styles | 9 | **10** | Parity + Glass |
| Masks | Bezier, 7 modes, variable feather | Bezier, 7 modes, uniform feather, **effect-scoped** | Variable-width feather is the gap |
| Track mattes | alpha/luma ± invert | same, **decoupled from stacking order** | Parity |
| Graph editor | value + speed | **value + speed** | Parity |
| Expressions | JS engine, huge API | Own language, ~18 functions, cycle-safe | Smaller API; safer + CSP-compatible |
| Text animators | Full selector stack | **Full selector stack** + multiple selectors + wiggly | Parity |
| Shape operators | Chainable contents list | 7 operators, **single slot** | Real structural gap |
| 3D | Classic + Advanced (Cinema 4D) | **Classic + extrusion/bevels** | Advanced 3D out of scope by choice |
| Cameras / lights / shadows | ✅ | ✅ | Parity |
| Motion blur | angle, phase, adaptive | **angle, phase, adaptive** | Parity |
| Puppet tool | 2 engines, pins | **ARAP + LBS**, pins + sketch | Parity; one engine by choice |
| **Bone / skeleton rig** | ❌ (needs DUIK) | ✅ **FK + IK + FABRIK + weight painting** | **Premation wins** |
| Particles | CC Particle World etc. | Deterministic closed-form emitter | Fewer options; **exact scrubbing** |
| Motion tracking / roto | ✅ | ❌ | AE wins, by direction |
| Precomps / nesting | ✅ | ✅ | Parity |
| Templates (MOGRT) | ✅ | ✅ + media slots + protected time | Parity+ |
| Lottie export | via plugin | **built in** | Premation wins |
| Plugins | CEP/UXP, unsandboxed | **Worker sandbox, permissioned, signed** | Premation wins on security |
| AI | Firefly, bolted on | **62 tools, agent loop, deterministic caster, self-critique** | **Premation wins decisively** |
| Price | subscription | **free / AGPL** | Premation wins |
| Ecosystem, plugins, tutorials, hiring pool | enormous | ~zero | **AE wins decisively** |
| Maturity | 30 years | pre-1.0 | AE wins |

**Honest summary vs AE:** Premation is at genuine feature parity on the *core compositing and animation model* — keyframes, graph editor, expressions, text animators, masks, mattes, blend modes, 3D, motion blur, precomps, templates. Where it loses is **breadth** (effects count, 400 vs 38), **ecosystem**, and **maturity**. Where it wins is **rigging** (AE has no skeleton), **AI**, **plugin security**, **local-first file format**, and **price**.

### 17.2 Against the wider field

| | **Premation** | **After Effects** | **Rive** | **Jitter** | **Cavalry** | **LottieFiles / Lottielab** | **Framer Motion** |
|---|---|---|---|---|---|---|---|
| Category | Desktop compositor | Desktop compositor | Interactive runtime + editor | Web motion tool | Desktop 2D motion | Lottie authoring | Code library |
| Runs | Desktop (Electron) | Desktop | Web + desktop | Web | Desktop | Web | In your app |
| Timeline + keyframes | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ (code) |
| Graph editor (value+speed) | ✅ | ✅ | partial | partial | ✅ | partial | ❌ |
| Expressions / scripting | ✅ own lang | ✅ JS | ✅ state machine | ❌ | ✅ JS | ❌ | ✅ (it *is* code) |
| 3D space, cameras, lights | ✅ | ✅ | limited | ❌ | limited | ❌ | ❌ |
| Bone/skeleton rigging | ✅ | ❌ | ✅ (best-in-class) | ❌ | ❌ | ❌ | ❌ |
| Mesh/puppet deform | ✅ ARAP | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Video compositing / keying | ✅ Keylight | ✅ | ❌ | limited | limited | ❌ | ❌ |
| Effects stack | 38 | 400+ | few | few | many | ❌ | ❌ |
| Interactive state machines | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ |
| Lottie import **and** export | ✅ both | import only | export | export | export | ✅ both | consume only |
| Video export (mp4/mov/ProRes) | ✅ | ✅ | limited | ✅ | ✅ | limited | ❌ |
| AI generation | ✅ deep (62 tools) | shallow | ❌ | some | ❌ | some | ❌ |
| Plugin system | ✅ sandboxed | ✅ unsandboxed | ❌ | ❌ | ✅ | ❌ | n/a |
| Local-first / offline | ✅ fully | ✅ | partial | ❌ cloud | ✅ | ❌ cloud | ✅ |
| Open source | ✅ AGPL | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ MIT |
| Price | free (local) | subscription | subscription | subscription | one-time/sub | freemium | free |
| Collaboration | ❌ by choice | limited | ✅ | ✅ | ❌ | ✅ | n/a |
| Maturity | pre-1.0 | 30 yrs | mature | mature | mature | mature | mature |

### 17.3 Where Premation is genuinely differentiated

1. **Rigging in a compositor.** AE has no skeleton at all — AE users buy DUIK. Rive has skeletons but isn't a video compositor. Premation has ARAP puppet + FK/IK/FABRIK skeleton **composing on the same layer**, keyframeable, GPU-deformed, in a tool that also exports ProRes 4444.
2. **The AI layer is architectural, not a feature bolt-on.** 62 typed tools, a pure deterministic caster over a hand-authored technique library, a validator that expects the model to lie, a self-critique pass with rendered-frame evidence, and a hard "one prompt = one undo entry" contract. Nothing in this category is close.
3. **Plugin security.** Permissions shown *before any code exists anywhere*; Worker sandbox with `fetch`/`localStorage`/DOM removed; heartbeat termination; signed packages; every mutation is one undo. AE's CEP/UXP model is "run whatever you downloaded."
4. **One engine for preview and export.** No "final render looks different" class of bug, backed by golden-image tests on real GPU.
5. **The file format.** A chunked, content-hashed directory bundle with structurally-shared local version history and SHA-256 content-addressed assets. Incremental saves that touch only what changed. Nothing here is proprietary or opaque.
6. **Truly offline + AGPL.** The local edition makes zero network requests — the API layer refuses to send.

### 17.4 Where it loses, plainly

1. **Effect breadth** — 38 vs AE's 400+. This is the single biggest practical gap for a working motion designer.
2. **Ecosystem** — no plugin market, no tutorials, no template marketplace, no community, no hiring pool.
3. **Maturity** — pre-1.0, with a documented list of half-crossed seams (§16.2) and breaking `.motion` format changes still expected before 1.0.
4. **No motion tracking / rotoscoping** — a hard blocker for a large class of VFX work.
5. **No collaboration** — deliberate, but it *is* a loss against Rive/Jitter/Figma-adjacent workflows.
6. **No local project browser** yet in the OSS edition.
7. **Chainable shape operators** — AE's contents list is a real workflow, and single-slot operators are a visible ceiling.

---

## 18. File map — where everything lives

```
motion-editor/
├── electron/                    Electron main process
│   ├── main.ts                  windows, 46 IPC channels, ffmpeg, native menus
│   ├── preload.ts               the bridge
│   ├── aiKeyVault.ts            OS keychain for provider keys (BYOK, local edition)
│   ├── aiProxy.ts               provider calls from the MAIN process, never renderer
│   ├── credentialStore.ts       OS keychain for sessions
│   ├── localIndexDb.ts          SQLite project index + recovery
│   ├── mediaProbe*.ts           dimensions, fps, duration, ALPHA, audio detection
│   ├── backend.ts               server-edition backend glue
│   └── updater.ts               electron-updater against the GitHub release
│
├── src/
│   ├── App.tsx                  editor root: reveal keys, timeline model, context menus
│   ├── providers/Providers.tsx  boots Application, registers ~70 commands + shortcuts
│   ├── routes/AppRouter.tsx     HashRouter + RequireAuth
│   ├── pages/                   EditorPage, DashboardPage, auth pages
│   │
│   ├── core/                    41 subsystems — the application core
│   │   ├── commands/            Command registry, ShortcutManager, History, clipboard
│   │   ├── scene/               scene graph, parenting, anchor, 3D, extrusion, faces,
│   │   │                        materials, lights, camera3d, trim, repeater, pathOps,
│   │   │                        mergePaths, compInstance, layerTime, imageSequence
│   │   ├── effects/             38 effects, 36 blend modes, 10 layer styles, masks,
│   │   │                        mattes, adjustment, motion blur, keylight, LUT, echo
│   │   ├── animation/           presets (15+18+6+5), assistants, clipboard, easing,
│   │   │                        expression controls, preset preview
│   │   ├── text/                layout, measure, rich text, animators, selectors,
│   │   │                        path text, per-char 3D, font catalogue
│   │   ├── rendering/           buildSnapshot (+ ~25 focused test files), backends,
│   │   │                        capabilities, canvasOwnership, frame cache
│   │   ├── rig/                 ARAP, LBS, IK/FABRIK, skinning, weight paint, puppet
│   │   ├── export/              exportManager, offlineRenderer, encoders, GIF, WebM
│   │   ├── ai/                  AgentLoop, CasterRunner, DirectorRunner, tool handlers,
│   │   │                        verify, filmstrip, archetypes, recipes, transactions
│   │   ├── plugins/             PluginHost, Worker, manifest, permissions, registry
│   │   ├── project/             ProjectManager, .motion bundle, versions, migrations
│   │   ├── persistence/         Autosave, serializer, storage, recovery
│   │   ├── sync/                ProjectCipher, SyncEngine, manifestDiff, transport
│   │   ├── template/            fields, media slots, responsive time, authoring
│   │   ├── library/             6 catalogues (mograph, UI kit, cursors, transitions,
│   │   │                        SFX synth, Lottie)
│   │   ├── audio/  particles/  paint/  svg/  lottie/  timeline/  workspace/
│   │   ├── config/edition.ts    ← THE capability predicates
│   │   └── settings/  theme/  time/  source/  localIndex/  services/  events/
│   │
│   ├── layout/                  29 panel families
│   │   ├── EditorLayout/        shell, panelDefs (the canonical panel registry)
│   │   ├── Timeline/            Timeline, GraphEditor, speedGraph, marquee, snapping
│   │   ├── Inspector/           ~50 property sections
│   │   ├── Workspace/           canvas, overlays (bone, puppet, text edit), useWorkspace
│   │   ├── AiChat/  Effects/  Motion/  Templates/  RenderQueue/  Plugins/
│   │   └── Menu/  TopNav/  CommandPalette/  Settings/  Presentation/  Onboarding/
│   │
│   ├── components/              36 UI primitives
│   ├── stores/                  47 Zustand stores
│   ├── tokens/  themes/  styles/
│   └── types/  hooks/  utils/  workers/
│
├── packages/                    12 engine packages (see §4.2)
├── docs/                        9 design/audit docs (+ this one)
├── build/  release/  scripts/
├── electron-builder.yml         + .selfhosted.yml
└── jest.config.cjs  vite.config.ts  eslint.config.js  tsconfig.json
```

---

## 19. Glossary

| Term | Meaning here |
|---|---|
| **Snapshot** | `FrameSnapshot` — the immutable, pure-data description of one frame, produced by `buildSnapshot(t)`. Contains no engine handles. Both the viewport and the exporter render from one |
| **Comp** | Composition. Has size, fps, duration, background, a layer stack, and its own motion-blur master gate |
| **Comp instance / precomp** | A comp used as a layer inside another comp. Supports collapse transformations |
| **Node** | A layer in the scene graph. Has a transform, a `kind`, and components |
| **Component** | A typed prop bag on a node. **The transform component is the authority** — writing `node.transform` directly is a known way to lose the edit |
| **`fx` component** | Where per-layer switches live: effects, blend, matte, motion blur, quality, masks, rigs, path ops. Storing them here means history/autosave/export capture them for free |
| **Track** | `(nodeId, prop)` → keyframes. Prop paths can be nested: `effect.<id>.<param>`, `effect.layerstyle:<style>.<param>`, `path.points` |
| **Layer time** | The time axis keyframes actually live on, after clip start, stretch and time remap. `getRemappedTime()` is the **only** keyframe axis sampled |
| **Bake** | Rendering an effect on the CPU. "Forces a bake" and "the bake can draw it" are **two separate predicates** |
| **Caster** | The pure, deterministic generative pipeline. Builds prompts, validates responses, emits `ToolCall[]`, calls nothing |
| **Technique** | A hand-authored, linted, parameterised motion recipe the caster casts against |
| **Edition** | `local` (OSS, offline, no backend) or `server` (hosted). Read the **capability predicate**, never the edition |
| **`.motion` bundle** | The project directory format: manifest-last, content-hashed chunks, SHA-256 assets, structurally-shared versions |
| **Golden / render test** | A committed reference PNG compared against real GPU output by pixelmatch. The pixel gate |
| **Resolved kind** | The backend that actually ran (`resolvedKind`), as opposed to the one that was requested (`kind`). Always check the resolved one |

---

*Generated from source at `faef1c3` on 2026-08-03. Counts drift — re-derive from the registries before quoting them.*
