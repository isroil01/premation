# Motion — System Reference (Editor + Backend)

**Written:** 2026-07-29 · **Sources:** the code in `Desktop/motion-editor` and `Desktop/motion-back`, read directly.

> **Why this file exists.** The other `.md` files in this repo (README, `docs/`) have drifted from the
> implementation and describe things that were renamed, replaced or never shipped. This document was
> written by reading source, not docs. Where a claim comes from a specific file it is cited as
> `path:line` so you can re-check it instead of trusting it.
>
> **Confidence markers.** Sections marked **[verified]** were confirmed by reading the implementation
> and, in some cases, running it. Sections marked **[surveyed]** are from module headers, exported
> APIs and directory structure — the shape is right, individual details may have drifted.
> Sections marked **[gap]** are things the UI implies but the code does not do.
>
> **On `[surveyed]`:** those sections lean on doc-comments *inside* `.ts` files. Prose drifts wherever
> it lives, so treat them as one notch below `[verified]`. Five header claims were spot-checked against
> their implementations on 2026-07-29 and all five held: autosave `?? 60_000`; caster caps
> `slice(0, q.limit ?? 25)` / `?? 12`; the tier probe `'gpu' in navigator → 'WebGL2RenderingContext' in
> window`; `ACCESS_TOKEN_TTL || '1h'` and refresh-days `?? 90`; `DEFAULT_SIGNUP_CREDITS = 25`,
> `CREDITS_PER_RUN = 1`, `DEFAULT_CREDITS_PER_DIRECTOR_RUN = 3`. Note the caster caps are **defaults** —
> a caller passing `q.limit` overrides them.

---

## Table of contents

1. [The two applications](#1-the-two-applications)
2. [Running them](#2-running-them)
3. [Motion Editor — architecture](#3-motion-editor--architecture)
4. [The document model](#4-the-document-model)
5. [The engine packages](#5-the-engine-packages)
6. [The rendering pipeline](#6-the-rendering-pipeline)
7. [Feature inventory](#7-feature-inventory)
8. [The AI system](#8-the-ai-system)
9. [Plugins](#9-plugins)
10. [Export and render](#10-export-and-render)
11. [Persistence, projects and sync](#11-persistence-projects-and-sync)
12. [Motion Back — architecture](#12-motion-back--architecture)
13. [The API surface](#13-the-api-surface)
14. [End-to-end workflows](#14-end-to-end-workflows)
15. [Known gaps and sharp edges](#15-known-gaps-and-sharp-edges)

---

## 1. The two applications

| | **motion-editor** | **motion-back** |
|---|---|---|
| What it is | Desktop motion-design application ("Pro-AE") | HTTP API for accounts, projects, assets, AI and rendering |
| Stack | Electron 32 + React 18 + TypeScript + Vite + Zustand | NestJS 10 + Postgres + Prisma 5 |
| Location | `Desktop/motion-editor` | `Desktop/motion-back` |
| Renders | WebGPU → WebGL2, in-process | Nothing — it shells out to ffmpeg for cloud renders |
| Owns the document | **Yes.** The desktop app is the source of truth | No. It stores blobs and, optionally, opaque ciphertext |

The relationship is deliberately thin. The editor works fully offline: scene graph, animation, rendering
and export all run locally. The backend adds accounts, cloud project storage, an AI key vault + stream
proxy, a plugin registry, an encrypted sync vault and server-side rendering. Nothing in the editor's core
loop requires it.

---

## 2. Running them

**Editor (desktop, the real target):**

```bash
npm run electron:dev
```

That compiles `electron/` with tsc, starts Vite on 5173, and launches Electron against it
(`package.json` scripts). `npm run dev` gives you the browser-only build — usable, but with no
filesystem, no ffmpeg and no OS keychain, so export is limited to WebM/PNG and projects cannot be
saved as bundles.

Other scripts that matter: `npm test` (jest), `npm run typecheck` (`tsc --noEmit`),
`npm run render-tests` (golden-image renderer tests, `packages/render-tests/scripts/run.mjs`),
`npm run dist` (electron-builder).

**Backend:**

```bash
npm run start:dev
```

Needs Postgres and a `.env`; `src/main.ts` calls `assertEnv()` *before* `NestFactory.create` so a bad
config is refused at boot rather than at first request. Prisma: `npm run prisma:migrate`,
`npm run prisma:generate`, `npm run db:seed`.

---

## 3. Motion Editor — architecture

### 3.1 The layering rule

The codebase is split into **framework-independent engines** (`packages/*`) and **the application**
(`src/*`). The engines have no React, no DOM, no timers and no rendering; they are driven by the app
through ports. This is not decoration — it is why the timeline, animation and workspace engines are
unit-testable without a browser.

```
packages/                            src/
  animation/   value authority        core/        app services over the engines
  timeline/    temporal data          layout/      React panels
  scene/       node/component model   stores/      Zustand state
  workspace/   interaction engine     components/  shared UI
  renderer/    GPU render graph       pages/       routes: Auth, Dashboard, Editor
  ai-tools/    tool registry          providers/   app-wide wiring
  caster/      AI casting pipeline    hooks/       React glue
  technique-library/  motion library  workers/     thumbnail worker
  design-system/      layout library
  product-motion/     product recipes    electron/  main, preload, ffmpeg, keychain, sqlite
  render-tests/       golden images
```

### 3.2 App shell

`src/App.tsx` → `AppRouter.tsx` (HashRouter, because Electron loads from `file://`) → routes:

| Route | Page | Purpose |
|---|---|---|
| `/login`, `/register`, `/forgot-password`, `/reset-password` | `AuthPage.tsx` (one component, four modes) | Email+password, Google/GitHub OAuth |
| `/oauth` | `OAuthCallbackPage.tsx` | Exchanges the OAuth code for tokens |
| `/dashboard` | `DashboardPage.tsx` | Project list, recents, new project |
| `/editor`, `/editor/:projectId` | `EditorPage.tsx` | The editor itself |
| `/popout/:panelId` | `PopoutRoute.tsx` | A panel torn off into its own Electron window |
| `/` and `*` | — | Redirect to `/dashboard` and `/` respectively |

`RequireAuth.tsx` gates the authenticated routes. `Providers.tsx` binds the engines to React —
notably it bridges the AnimationEngine's change sink onto the event bus, which is what makes a
keyframe edit repaint.

### 3.3 State

Zustand, ~40 stores in `src/stores/`. The ones you will touch most:

| Store | Owns |
|---|---|
| `sceneStore` | Scene revision counter (`bumpScene()` is how anything says "the graph changed") |
| `selectionStore` | Selected node ids |
| `projectStore` | Tabs, active tab, per-tab time/frame/playing, comps |
| `compositionStore` | Active comp width/height/fps/duration |
| `historyStore` | Undo stack, snapshot commands, history baseline |
| `assetStore` | Imported asset records + metadata |
| `renderQueueStore`, `renderBackendStore`, `renderQualityStore` | Output jobs, GPU tier badge, quality |
| `aiProviderStore` | Which AI provider is connected (the authority on the AI key gate) |
| `pluginStore`, `templateStore`, `componentStore`, `versionHistoryStore` | Feature state |
| `guidesStore`, `paintStore`, `focusStore`, `layoutStore`, `workspaceViewStore` | Viewport/UI |

Note the split: **the scene graph is not in a store.** It is a singleton (`defaultSceneGraph`) and
stores hold a revision number that components subscribe to. That is why almost every panel begins with
`useSceneRevision((s) => s.rev)`.

### 3.4 Panels

`src/layout/` — each directory is a dockable panel or a piece of app chrome.

| Area | Panels |
|---|---|
| Canvas | `Workspace` (viewport, gizmos, overlays, secondary pane), `SceneControls`, `TopNav`/`ToolOptionsBar`/`ViewControls` |
| Time | `Timeline` (bars, keyframes, graph editor, speed graph), `BottomTimeline`, `Motion` (motion editor, expression editor, presets) |
| Properties | `Inspector` (30 sections — see §7), `RightInspector`, `Effects` (effect stack, curve editor, layer styles, time controls) |
| Assets | `Project` panel, `Templates`, `Plugins`, `LeftSidebar` |
| Output | `Export` (dialog + preview), `RenderQueue` (queue + output module dialog) |
| Meta | `Menu` (app menu bar), `CommandPalette`, `History` + `VersionHistory`, `Settings`, `Presentation`, `Onboarding`, `StatusBar` (FPS, info readout, VU meter), `TitleBar`, `AiChat`, `Auth` |

Panels are described declaratively in `EditorLayout/panelDefs.ts` and can be popped out into separate
OS windows via `popout:spawnWindow` (preload).

---

## 4. The document model

### 4.1 Scene graph

Nodes carry **components**; the node's "kind" is a prop on a component, not a class:

```ts
type SceneKind =
  | 'group' | 'null' | 'shape' | 'text' | 'image' | 'video' | 'svg'
  | 'audio' | 'camera' | 'light' | 'adjustment' | 'particle' | 'comp';
```
`src/core/scene/seedDefaultScene.ts:17`

The kind lives under `__kind` (`SCENE_KIND_PROP`) so the UI can choose an icon without guessing.
Read it with `readNodeKind(node)` — never by inspecting components yourself, because the plain-view
components are rebuilt on read.

**Two rules that cause real bugs when broken** (both are recorded in the code):

1. `node.transform.position` is **not** the authority — the Transform component's props are. Writing
   the former strands a node.
2. Props must be written through `defaultSceneGraph.writeProp(...)`, not mutated in place, because
   components are materialised per read.

### 4.2 Compositions

Compositions are **separate root subtrees of one graph**. There is no per-comp graph object. Therefore:

- Anything that renders or lists "the comp" must scope with `flattenComposition(graph, rootId)`.
- `flattenScene(graph)` walks *every* comp and is almost always the wrong call in feature code
  (`src/core/scene/sceneDerive.ts:31` and `:50`).
- The active comp root is `activeCompRootId()` (`src/core/scene/activeComp.ts:20`), resolved from the
  active tab — for a drill-down precomp tab it is the precomp group node, which is exactly where an
  insert should land.

Precomps, comp instances, and collapse-transforms are all supported (`core/scene/precomp.ts`,
`compInstance.ts`, `buildSnapshotCollapseTransforms.test.ts`).

### 4.3 Animation

`packages/animation/AnimationEngine.ts` is the **value authority**. Property tracks keyed by
(nodeId, prop); given a time it samples every track into a `SceneValueSnapshot` the renderer merges
over the scene's base values. It never mutates the scene during playback — authoring keyframes are the
truth, sampled values are derived and disposable.

Supported: keyframes with per-side bezier handles, easing kinds, roving keyframes, tangent smoothing,
**data tracks** (non-scalar values like path points, gradient stops, text source), and **expressions**
(`expressions.ts` + a small expression language in `exprLang.ts`).

**The time axis rule:** `getRemappedTime` is the *only* keyframe axis the renderer samples. A layer's
comp time → source time mapping folds in clip trims, layer time (stretch/reverse/freeze) and precomp
remaps; writing a keyframe on the raw comp axis while reading it on the layer axis is the classic
"my keyframes overwrite each other" bug (see `TransformSection.keyframe.test.tsx`).

### 4.4 Timeline

`packages/timeline` — canonical unit is **frames**, driven by an external clock via `tick(dtMs)`.
It owns tracks, layers, clips, markers, playhead, ranges, selection and its own undo history for clip
edits. `src/core/timeline/TimelineController.ts` is the app-side adapter and holds the scene↔clip
bridge, including:

- `setClipStart`, `trimClipTo(edge)`, `splitClip(seconds)`, split/trim-to-playhead for a selection
- per-layer markers that travel with a trimmed or slid layer
- `mediaSourceFrames(node, fps)` — how long a media layer *can* be (asset duration), which bounds trims
- `clip.sourceFrameAt(frame)` — the comp→source frame mapping that makes trimming real rather than cosmetic

---

## 5. The engine packages

| Package | What it is |
|---|---|
| `@motion/animation` | Tracks, keyframes, interpolation, data tracks, expressions, Lottie path helpers |
| `@motion/timeline` | Tracks/layers/clips/markers/playhead/ranges/selection + serialization + its own history |
| `@motion/scene` | Node & component model, systems, serialization, interop |
| `@motion/renderer` | GPU render graph: WebGPU + WebGL2 backends, passes, resources, shaders, raster, viewport, camera |
| `@motion/workspace` | Interaction engine: camera, coordinates, grid, guides, snapping, hit-testing, selection, cursor, input, tools. Never renders, never mutates the graph — it goes through ports |
| `@motion/ai-tools` | The AI tool registry, schemas, provider adapters, emitters, spring solver |
| `@motion/caster` | The casting pipeline: prompts, validation, sequencing, emission |
| `@motion/technique-library` | The motion technique catalog + the casting query + lint |
| `@motion/design-system` | Layout templates, colour, type, grid, depth, devices, surface, stage, packs |
| `@motion/product-motion` | Product-launch choreography, shared-element transitions, cursor motion |
| `@motion/render-tests` | Golden-image regression harness (`node packages/render-tests/scripts/run.mjs`) |
| `@motion/audio` | Audio analysis |

---

## 6. The rendering pipeline

### 6.1 One engine, three tiers

`createRenderBackend.ts` is explicit: there is exactly **one** rendering engine, the GPU-backed
`MotionRendererBackend`. Canvas2D survives only as a *rasterizer* that produces textures for the GPU
compositor — it is not a backend. Selection order:

```
WebGPU (when available) → WebGL2 → Null (headless/test)
```

If GPU context creation fails the backend steps itself down and emits `EngineError` / `EngineReady`,
which `renderBackendStore` mirrors into the tier badge in the status bar.

### 6.2 Frame path

```
scene graph + animation + timeline
        │
        ▼
buildSnapshot(...)            ← per-frame, comp-scoped (flattenComposition)
  • resolves each node to a RenderLayer
  • folds time: clip.sourceFrameAt → layer time (stretch/reverse/freeze) → precomp remap chain
  • reads masks, mattes, blend, adjustment, quality, paint, effects, 3D world
  • gates layers outside their clip's trimmed range
        ▼
snapshotToFrameScene(...)     ← RenderLayer[] → Renderable[] (the renderer's own model)
  • affine mat3 for 2D layers; mat4 model for the depth-tested 3D path
  • frame-blend layers split into two weighted renderables
        ▼
MotionRendererBackend         ← textures, effect chains, passes
        ▼
@motion/renderer render graph ← CompositionPass, 3D pass w/ hardware perspective divide
```

Caches worth knowing: `frameCache` (rendered frames, for RAM preview), `renderCache`,
`videoFrameCache` (decoded video frames, for frame blending), `AppTextureProvider` (textures, with
`retain()`), `contentHash` (what makes a cached frame reusable).

### 6.3 3D

Real 3D, not fake: `Mat4` with "real z and w, hardware perspective divide"
(`packages/renderer/src/core/math/Mat4.ts:5`). `CompositionPass` runs a depth-tested 3D pass with
`mvp3dFor(viewport, camera3d, model)` and handles solid, textured (`image`/`video`/`text`) and
per-fragment shaded quads. Cameras (`core/scene/camera3d.ts`), lights + shading
(`light.ts`, `lightShading.ts`), materials, extrusion, face picking and per-character 3D all exist.

The 3D switch applies to kinds `shape | text | image | video | null` only
(`src/core/scene/threeD.ts:91`), and the depth props are `z, rotationX, rotationY`.

---

## 7. Feature inventory

### 7.1 Layers and creation **[surveyed]**

Shapes (with path ops, merge paths, trim paths, repeaters), text (rich text, layout, text-on-path,
per-character 3D, animators + selectors), images, image **sequences**, video, SVG (hybrid import:
static SVG stays one intact layer, animated SVG converts to keyframes), audio, cameras, lights,
adjustment layers, nulls, particles, precomps and comp instances.

### 7.2 The inspector

30 sections in `src/layout/Inspector/`, routed by what is selected:

`Transform`, `Align`, `Appearance`, `Compositing`, `LayerSwitches`, `Parent`, `ThreeD`, `Camera`,
`Light`, `FaceMaterials`, `Text`, `TextAnimator`, `FontPicker`, `Shape effects`, `PathOps`, `TrimPath`,
`Repeater`, `Media`, `Svg`, `Audio` + `AudioWaveform`, `Particle`, `Precomp`, `Puppet`, `Bone`,
`StylePresets`, `Motion`, `KeyframeRow`/`ColorKfRow`, `VersionHistory`.

### 7.3 Effects **[verified — list read from the registry]**

35 effect types in `src/core/effects/effects.ts`:

> beam · bevel · channel-mixer · curves · directional-blur · displacement-map · drop-shadow · echo ·
> fill · four-color-gradient · fractal-noise · glow · gradient-ramp · hue-saturation · inner-glow ·
> inner-shadow · keylight (chroma key) · levels · linear-wipe · motion-tile · noise · posterize ·
> posterize-time · satin · sharpen · stroke · tint · transform · turbulent-displace · wave-warp
> (+ curve/number/color/checkbox/layer param types)

Plus, as separate subsystems: **masks** (animated, feather, expansion, invert, modes), **track mattes**,
**blend modes**, **layer styles** (drop/inner shadow, outer/inner glow, satin, bevel, colour overlay,
gradient overlay, stroke), **motion blur**, **adjustment layers**, **colour LUT** and colour-matrix
paths, **glass/interior styles**, **echo**, **warp**.

### 7.4 Motion authoring **[surveyed]**

Motion presets and behaviour presets (`core/animation/*Presets.ts`), keyframe assistants, easing
selection + an easing clipboard, keyframe clipboard, a graph editor with a **speed graph**, an
expression editor with expression controls, spring solving (`@motion/ai-tools/spring.ts`), auto-orient,
and per-layer time controls (stretch / reverse / freeze / frame-mix).

### 7.5 Rig and puppet **[surveyed]**

A full bone+mesh rig: skeleton, FK, linear blend skinning, FABRIK IK, auto-weighting, weight painting,
mesh generation, ARAP solver for the puppet tool, GPU-side rig deform, and puppet sketch. Accepts
`shape | text | image | video` layers (`src/core/rig/rigMeshInputs.ts:61`).

### 7.6 Import **[surveyed / partly verified]**

- **SVG** — sanitised (`svgSanitize.ts`), capability-checked, hybrid import
- **Lottie** — `core/lottie/lottieImport.ts` + an import report; shape trees expand per drawable
- **Image sequences** — numbered stills detected and played as one footage layer
- **Video / image / audio** — via `importLocalAsset` into the project bundle, content-addressed by
  hash, with intrinsic metadata probed (`width/height/duration`)
- **Fonts** — `core/text/fontCatalog.ts`

### 7.7 Libraries and templates **[surveyed]**

`core/library/`: mograph, transitions, SFX, cursors, UI kit, Lottie (with preview).
`core/template/`: a registry + 7 native templates (`gradientHero`, `lowerThird`, `photoPromo`,
`quoteCard`, `reelIntro`, `titleCard`, plus `builders`), MOGRT-style exposed **template fields**, live
preview controller and template authoring.

### 7.8 Audio **[verified]**

Audio layers with per-clip voices (one clip = one voice, so a split audio layer is two voices),
keyframable levels, waveform generation and display, a Web Audio playback engine, and a mixdown that
both export paths attach to the video (ffmpeg on desktop). **The clip bar is the authority on when
audio sounds** — not the component props (`src/core/audio/audioScene.ts:6`).

---

## 8. The AI system

This is the most distinctive part of the product, and it has an unusual shape: **the model never picks
raw keyframes.** It casts from constrained libraries and deterministic emitters produce the animation.

### 8.1 Where the model call happens

The agent loop runs **in the editor**, on purpose — tools mutate the scene graph, which lives there.
The model call does not: it goes through `POST /ai/stream` on the backend, which holds the user's
provider key encrypted server-side, owns the endpoint allowlist, and pipes the provider's SSE bytes
back verbatim. **The editor never sees a provider key and never talks to a provider host directly**
(`src/core/ai/AgentLoop.ts:1`).

### 8.2 Routing

`classifyPrompt` (`core/ai/pipeline/Router.ts`) is a pure function — deliberately a regex, not a model
call — that splits prompts into:

- `trivial_edit` → the **direct tool loop** (`AgentLoop`)
- `generative` → the **caster / director pipeline**

### 8.3 The caster pipeline

`@motion/caster` is pure: it builds prompts, validates responses, and emits `ToolCall[]`. It calls
nothing. `CasterRunner.ts` supplies the model hooks over `/ai/stream` and executes the calls.

What the model is shown is the key design decision: never a `TechniqueDef`, never a `LayoutTemplate`,
never a keyframe — just short one-line briefs, pre-filtered by look pack, energy, slot duration and
which roles the content can actually fill, **capped at 25 motion candidates and 12 layout candidates**.
The stated reason: handing a model 250 options produces a pick from the top of the list, not a
considered choice (`packages/caster/src/cast.ts:1`, `packages/technique-library/src/registry.ts:1`).

Validation is not optional. A cast naming an unknown technique, a forbidden one, a clashing pair, or one
whose slot is too short is **rejected and replaced with the highest-ranked valid candidate** — the model
is not asked to try again.

### 8.4 The director pipeline

`POST /ai/director/run` (backend, SSE). The server runs a multi-director pipeline and streams typed
events the editor renders as progress:

```
intent_resolved → director_start/done ×6 → scene_composed → animation_composed
→ tool_calls → critique ×N → finish
```

`DirectorRunner.ts` bridges those events into the editor's live execution engine.

### 8.5 Tools

`packages/ai-tools` — the registry with JSON schemas and provider adapters. Roughly 45 tools:

- **Read:** `describe_scene`, `read_tracks`, `evaluate_at`, `get_selection`, `list_capabilities`,
  `list_presets`, `list_assets`
- **Write (document):** `create_layer`, `delete_layer`, `reparent_layer`, `update_layer`,
  `create_media`, `create_mask`, `create_precomp`, `import_svg`
- **Write (motion):** `set_keyframes`, `remove_keyframes`, `set_easing`, `set_expression`,
  `set_spring`, `set_time_remap`, `set_motion_blur`, `text_animator`
- **Write (look):** `add_effect`, `update_effect`, `update_effect_param`, `apply_layer_style`,
  `create_gradient`, `add_surface_treatment`, `set_light`, `set_shadow_stack`, `recolor_lottie_vector`
- **Composed recipes:** `add_background`, `add_title`, `add_emblem`, `add_cards`, `stagger_in`,
  `define_style`, `add_camera_move`, `add_kinetic_title`, `add_light_sweep`, `add_ambient_orbs`,
  `add_lower_third`, `add_scene`, `add_transition`, `add_logo_reveal`, `add_radial_burst`,
  `add_path_morph`
- **Media:** `generate_image`, `analyse_audio`

### 8.6 Undo and verification

**One prompt = one undo entry.** A run can fan out into dozens of tool calls across the scene graph
*and* the animation engine, so `aiTransaction.ts` snapshots the whole document before and after and
pushes a single `StoreSnapshotCommand`. Mutations land live, so the canvas animates as the model works.

`verify.ts` runs cheap deterministic checks before any render-and-critique pass — off-canvas layers,
keyframes past the comp end, simultaneous entrances. Its header is worth reading before editing it: an
earlier version of the verifier produced **five findings against known-good output and all five were
wrong**, so each check now carries a structural constraint (e.g. `offscreen` samples position over time
and only reports a layer off-canvas at *every* sample).

`renderFeedback.ts` + `filmstrip.ts` + `assetVisualAnalyzer.ts` support the vision critique pass.

---

## 9. Plugins

**The design rule, stated in the code: plugin code never runs in the host realm**
(`src/core/plugins/PluginHost.ts:1`).

A plugin runs in a dedicated Worker with no DOM, no `localStorage` (which is where the account bearer
token and plaintext AI keys live) and no network. It reaches the document only by posting a message
naming a method, and the host decides per message whether the required permission was granted at
install time.

Permissions (`src/core/plugins/manifest.ts:20`):

| Permission | Means |
|---|---|
| `scene:read` | See layer names, structure, properties |
| `scene:write` | Create/change/delete layers — every change undoable |
| `animation:read` | See keyframes, sample animated values |
| `animation:write` | Create/change keyframes and expressions — undoable |
| `timeline` | Read the current time and move the playhead |

Manifests are reverse-DNS (`studio.acme.easing-lab`), semver'd, and carry an `apiVersion` — a plugin
written against a newer host generation is refused rather than run.

Packages are signed **ECDSA P-256 / SHA-256** and verified twice: on publish by the backend, and again
in the editor before install. The editor-side check is the one that matters — it is what makes a
compromised registry or a modified download detectable on the user's machine
(`motion-back/src/plugins/plugin-signature.ts:1`). P-256 was chosen over Ed25519 deliberately for
WebCrypto compatibility across shipped Chromium versions.

---

## 10. Export and render

### 10.1 Local export **[verified]**

`src/core/export/exportManager.ts`. Every format shares **one deterministic frame loop**
(`offlineRenderer.ts`: frame time is exactly `index / fps`, never wall-clock), so an export is
reproducible and matches the viewport. The loop converges async media work (video seeks, texture loads)
before capturing each frame.

| Format | Path |
|---|---|
| MP4 | ffmpeg child process (desktop only) — `libx264` video, `aac` 192k audio |
| MOV | ffmpeg — `prores_ks` profile 4444, `yuva444p10le` (**alpha-preserving**), `pcm_s16le` audio |
| WebM | ffmpeg on desktop — `libvpx-vp9` + `libopus` 160k; WebCodecs + `webmMuxer.ts` in the browser |
| GIF | ffmpeg on desktop; `gifEncoder.ts` in the browser |
| PNG / JPEG sequence | Frames zipped by a worker (`zip.ts`, `encode.worker.ts`) |
| PNG (single) | One frame, snapped to the frame grid |
| Lottie | Shapes + transform tracks as bodymovin JSON |
| JSON | The editable project document, re-openable with File ▸ Open |

Audio is mixed down (`mixdownAudio(startSec, endSec)`) and staged via `render:stageAudio` before the
ffmpeg call; `-shortest` guards length. Desktop-only formats fail with an explicit message telling the
user to export WebM or a PNG sequence in the browser.

The **Render Queue** panel adds AE-style output modules and multiple queued jobs
(`RenderQueuePanel.tsx`, `OutputModuleDialog.tsx`); `exportPreview.ts` renders the preview strip.

### 10.2 Cloud render **[surveyed]**

`POST /render` creates a job; the editor uploads frames to `POST /render/:id/frames` (a zip); the
backend's `render.worker.ts` unpacks it and spawns ffmpeg, then stores the artifact through
`StorageService` and returns `resultUrl`. Jobs are listed/cancelled via `GET /render`, `GET /render/:id`,
`POST /render/:id/cancel`. Statuses and formats are Prisma enums (`RenderStatus`, `RenderFormat`).

---

## 11. Persistence, projects and sync

### 11.1 Local-first **[surveyed]**

The desktop app is the source of truth. A project is a **`.motion` directory bundle**: a document plus
a content-addressed blob store (dedup by hash). `bundleProjectIO.ts` joins `projectDocumentIO`
(captures/restores the full `EditorDocument` from the live engines) to `BundleRepository`, without
`ProjectManager` learning the bundle format. Assets imported locally get a `motion-blob:<hash>` src
that the GPU loader resolves without any network (`localBlobSource.ts`).

Electron exposes exactly the primitives this needs (`electron/preload.ts`): `project.open`,
`project.chooseSavePath`, `bundle.{read,writeAtomic,remove,list}`, `blob.{has,read,write,remove,list}`,
`file.{read,write}`.

### 11.2 Autosave, recovery, history

`AutosaveController` writes a crash-recovery snapshot on an interval, only when dirty, and flushes when
the window hides or closes. It explicitly does **not** clear the unsaved indicator — that is reserved
for an explicit Save. Recovery rows are kept in a local SQLite index (`electron/localIndexDb.ts`,
`index:*` IPC), which also backs the project list and "file has gone missing" marking.

Undo is `CommandSystem` + `HistoryService` + `historyStore`, with snapshot commands for coarse
multi-subsystem edits (AI runs, document restores). There is a documented severe past bug worth
remembering: **history must not be baselined at boot after seeding a default scene**, or the first undo
wipes the project.

Version history is separate and server-side: `POST /projects/:id/versions`, list, fetch, restore.

### 11.3 Encrypted sync vault **[verified from source]**

Opt-in, paid-plan gated, and **zero-knowledge**:

- The project key is derived from the user's passphrase on-device (PBKDF2 → AES-GCM, Web Crypto only,
  no dependencies) and never leaves the machine (`ProjectCipher.ts`).
- Each chunk is sealed independently with a random 12-byte IV prepended, so decryption is
  self-describing.
- `SyncEngine` runs one reconcile-and-exchange cycle: fetch remote → decrypt manifest →
  `reconcile(base, local, remote)` → conflicts stop the cycle and the caller keeps a conflict copy;
  otherwise pull/push chunks and compare-and-swap the manifest at the expected revision.
- The server stores opaque bytes and does no interpretation (`motion-back/src/sync/sync.service.ts:1`).

### 11.4 Credentials

Refresh tokens live in the OS keychain via `credentials:*` IPC (`electron/credentialStore.ts`), not in
`localStorage`.

---

## 12. Motion Back — architecture

NestJS modules under `src/`:

| Module | Responsibility |
|---|---|
| `auth` | Register/login, JWT access tokens, refresh-token rotation, sessions, password reset, OAuth (Google/GitHub), admin-email bootstrap, session purge job |
| `projects` | CRUD, autosave, thumbnails, trash + restore + permanent delete, versions, trash-purge job |
| `assets` | Upload/list/delete, backed by `StorageService` |
| `ai` | BYOK key vault, model catalog, `/ai/stream` proxy, image generation, conversations, the director pipeline, usage/credits policy |
| `render` | Render jobs, frame upload, ffmpeg worker, cancellation |
| `sync` | The encrypted vault: manifest CAS + content-addressed chunks |
| `plugins` | Registry: publish, list, versions, signed downloads, blocking |
| `billing` | Plan catalog, checkout, Stripe webhook |
| `admin` | Overview/system metrics, user administration, credits, suspend, projects, renders, AI usage, audit log |
| `files` | Serves locally-stored files behind an expiring HMAC signature |
| `common` | Env assertion, audit service, cache, storage, mailer, guards, filters, interceptors, request-id + security-headers middleware, pagination, contracts |

### 12.1 Data model

Prisma models (`prisma/schema.prisma`): `User`, `Role`(enum), `AuditLog`, `RefreshToken`,
`PasswordResetToken`, `Project`, `ProjectVersion`, `Asset` + `AssetType`, `RenderJob` +
`RenderStatus` + `RenderFormat`, `AiProviderKey`, `AiConversation`, `AiMessage`, `AiUsage`,
`BillingEvent`, `SyncState`, `SyncChunk`, `Plugin`, `PluginVersion`.

Migrations of note: `add_sync_vault`, `add_roles_and_audit_log`, `add_refresh_tokens`,
`add_plugin_registry`.

### 12.2 Security decisions worth knowing **[verified from headers]**

- **Two-token sessions.** Access tokens are stateless JWTs, checked on every request and therefore
  deliberately short (default 1h) — "a stolen one is worth an hour". Long-lived sessions are carried by
  rotating refresh tokens stored hashed. Concurrent refreshes are single-flighted; racing them revokes
  the session.
- **AI keys at rest** are AES-256-GCM with `AI_KEY_SECRET` held only in the server env; the wire format
  is `base64(iv).base64(authTag).base64(ciphertext)`. The settings UI only ever receives a masked hint
  computed at save time — the server never hands key material back to a client (`ai/key-crypto.ts`).
- **Audit entries are redaction-filtered** by regex (`pass|secret|token|apikey|authorization|credential`)
  because an audit row is one careless spread away from persisting a password forever.
- **`/files` is signed, not public.** It replaced an unauthenticated static mount where any leaked UUID
  was permanent public access. Since `<img>`/`<video>` cannot send an Authorization header, the guard is
  an expiring HMAC in the URL. Cloudinary files never route through it.
- **Plans live on the server** because entitlement is a commercial fact, not a presentation detail
  (`billing/plans.ts`).
- **Motion AI credits.** Motion AI runs on the platform's own OpenAI key, so it is metered in credits
  (`MOTION_AI_SIGNUP_CREDITS`, default 25; `CREDITS_PER_DIRECTOR_RUN`, default 3). **BYOK spends no
  credits** — the user already pays the provider, and charging would be charging twice
  (`ai/ai-policy.ts`).

---

## 13. The API surface

Extracted from the controllers. All paths are relative to the API base.

**Auth** — `POST /auth/register` · `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout` ·
`GET /auth/me` · `GET /auth/sessions` · `DELETE /auth/sessions` · `POST /auth/forgot-password` ·
`POST /auth/reset-password` · `GET /auth/providers` · `GET /auth/oauth/:provider/start` ·
`GET /auth/oauth/:provider/callback` · `POST /auth/oauth/exchange`

**Projects** — `GET /projects` · `POST /projects` · `GET /projects/trash` · `GET /projects/:id` ·
`PATCH /projects/:id` · `PUT /projects/:id/autosave` · `PUT /projects/:id/thumbnail` ·
`DELETE /projects/:id` · `POST /projects/:id/restore` · `DELETE /projects/:id/permanent` ·
`POST|GET /projects/:id/versions` · `GET /projects/:id/versions/:versionId` ·
`POST /projects/:id/versions/:versionId/restore`

**Assets** — `POST /assets` · `GET /assets` · `DELETE /assets/:id`

**AI** — `GET /ai/models` · `GET /ai/keys` · `PUT /ai/keys/:provider` · `DELETE /ai/keys/:provider` ·
`POST /ai/image` · `POST /ai/stream` · `POST /ai/director/run` · `GET /ai/conversations` ·
`GET /ai/conversations/:id` · `POST /ai/conversations/:id/messages` · `DELETE /ai/conversations/:id`

**Render** — `POST /render` · `GET /render` · `GET /render/:id` · `POST /render/:id/cancel` ·
`POST /render/:id/frames`

**Sync** — `GET /sync/:projectId` · `GET /sync/:projectId/chunks/:hash/exists` ·
`GET /sync/:projectId/chunks/:hash` · `PUT /sync/:projectId/chunks/:hash` · `PUT /sync/:projectId`

**Plugins** — `GET /plugins` · `GET /plugins/mine` · `POST /plugins/updates` · `GET /plugins/:id` ·
`GET /plugins/:id/versions/:version/download` · `POST /plugins` · `DELETE /plugins/:id` ·
`POST /plugins/:id/block`

**Billing** — `GET /billing/plans` · `GET /billing/me` · `POST /billing/checkout` ·
`POST /billing/webhook`

**Admin** — `GET /admin/overview` · `GET /admin/system` · `POST /admin/system/cache/clear` ·
`GET /admin/users` · `GET /admin/users/:id` · `PATCH /admin/users/:id` ·
`POST /admin/users/:id/credits` · `POST /admin/users/:id/suspend` · `POST /admin/users/:id/unsuspend` ·
`DELETE /admin/users/:id` · `GET /admin/projects` · `GET /admin/renders` ·
`POST /admin/renders/:id/cancel` · `GET /admin/ai/usage` · `GET /admin/audit`

**Other** — `GET /files/*` (HMAC-signed) · `GET /health`, `/health/live`, `/health/ready`

The editor's typed client is `src/core/api/client.ts`, with a tag-based response cache (`cache.ts`),
transport (`transport.ts`), session handling (`session.ts`) and a `/files` URL re-signing path.

---

## 14. End-to-end workflows

### 14.1 First run → first export

1. **Launch** `npm run electron:dev`. `AppRouter` sends an unauthenticated user to `/auth`.
2. **Sign in** with email+password or OAuth. The access token lands in memory/localStorage; the
   refresh token goes to the **OS keychain**.
3. **Dashboard** lists cloud projects (`GET /projects`) and local recents (SQLite index). Create a new
   project, or open a `.motion` bundle.
4. **Editor** boots the engines through `Providers`, seeds or restores the scene, baselines history
   (*after* seeding — see §11.2), and starts the autosave controller.
5. **Compose.** Add layers from the toolbar, Library, Templates, or the command palette. Layers land in
   `activeCompRootId()`.
6. **Animate.** Stopwatch a property → keyframes on the layer's remapped time axis. Refine in the graph
   editor or the speed graph; apply motion presets; add expressions.
7. **Look.** Effects stack, layer styles, masks, mattes, blend modes, 3D + camera + lights.
8. **Time.** Trim/split/slide clips on the timeline; per-layer stretch/reverse/freeze; time remap.
9. **Preview.** Viewport playback with RAM preview via `frameCache`; Presentation mode for full-screen.
10. **Export.** Export dialog or Render Queue → deterministic frame loop → ffmpeg (desktop) or
    WebCodecs (browser) → file on disk.

### 14.2 AI-assisted creation

```
user prompt
   │
   ├─ classifyPrompt → 'trivial_edit' ─────────────► AgentLoop
   │                                                   │ model turn via POST /ai/stream (key stays server-side)
   │                                                   │ tool calls execute against the live ToolContext
   │                                                   ▼
   └─ classifyPrompt → 'generative' ──► caster / director
                                            │ candidates filtered & capped (25 motion / 12 layout)
                                            │ model casts by taste; invalid casts replaced deterministically
                                            │ emitters produce ToolCall[]
                                            ▼
                                    deterministic verify (arithmetic checks)
                                            │
                                            ▼
                                    optional render + vision critique
                                            │
                                            ▼
              everything wrapped in ONE aiTransaction → ONE undo entry
```

### 14.3 BYOK key setup

Settings ▸ AI → `PUT /ai/keys/:provider` with the raw key → encrypted AES-256-GCM at rest → the UI
receives only a masked hint. `aiProviderStore` is the authority on "a provider is connected" — not the
presence of a key string anywhere in the client. BYOK runs cost **0 credits**.

### 14.4 Cloud sync (opt-in)

Enable sync → enter a passphrase → PBKDF2 derives the project key on-device → chunks and manifest are
sealed → `GET /sync/:projectId` for the remote manifest → `reconcile` → upload missing chunks
(`PUT /sync/:projectId/chunks/:hash`) → compare-and-swap the manifest (`PUT /sync/:projectId`).
Conflicts stop the cycle and produce a local conflict copy. The server never sees plaintext.

### 14.5 Publishing a plugin

Author → package → sign with the publisher's P-256 key → `POST /plugins` (backend verifies the
signature) → users `GET /plugins`, download a version, and the **editor verifies the signature again**
before install → the user grants explicit permissions → the plugin runs in a Worker with no DOM, no
storage, no network.

### 14.6 Cloud render

`POST /render` → editor renders frames locally and uploads them zipped to `POST /render/:id/frames` →
`render.worker.ts` unzips and spawns ffmpeg → artifact stored via `StorageService` → `resultUrl`
returned; poll `GET /render/:id` or list `GET /render`.

---

## 15. Known gaps and sharp edges

These are verified, not speculative. They are the things most likely to waste your time.

### 15.1 Video footage has no audio **[verified — gap]**

Importing an `.mp4` gives you picture only. Video elements are hard-muted
(`src/core/rendering/AppTextureProvider.ts:319`), `readAudioLayers` only collects nodes whose kind is
`audio` (`src/core/audio/audioScene.ts:152`), and nothing demuxes a container. Editing a talking-head
clip and exporting produces a silent file unless you import a separate audio asset. This is the single
biggest limitation for anyone treating the app as a video editor.

### 15.2 The Media inspector's video controls are write-only **[verified — gap]**

In `src/layout/Inspector/MediaSection.tsx`, **Fit Mode, Crop Top/Right/Bottom/Left, Speed, Start Offset,
Loop and Muted** write props that nothing in the render pipeline reads. Only *Replace* (src/assetId) and
the Time Remap row do anything. The working equivalents live elsewhere: speed → Time Controls stretch,
start offset → clip trim/slip, crop → a mask.

### 15.3 No corner pin / perspective effect **[verified — gap]**

There is no corner-pin, homography or projective-warp effect anywhere; `warp.ts` is Wave Warp and
Turbulent Displace only. The 2D layer model is a **mat3 affine** — it can skew but never foreshorten.
Screen-replacement / device-mockup shots are only reachable through the true-3D path (make the layer 3D,
orient it under a camera), which is eyeball-matched rather than corner-pinned, and there is no tracker.

*Implementation note if this gets built:* the shaders already take a `mat3 mvp` and discard the third
component (`packages/renderer/src/shaders/builtin.ts:82`). Emitting `vec4(p.xy, 0.0, p.z)` instead lets
the hardware do the divide **and** gives perspective-correct UV interpolation — so a 4-point homography
becomes a small, mostly-shader change with keyframable corners.

### 15.4 Video decode is `<video>` seeking, not WebCodecs **[verified]**

No demuxer, so there is no true random access and the source frame rate is unknowable. Frame blending
brackets on the *composition's* fps and degrades predictably when they differ — documented honestly at
the top of `src/core/rendering/videoFrameCache.ts`. There are no proxies or optimized media; scrubbing
heavy 4K is one seek per frame.

### 15.5 No NLE semantics **[verified]**

No ripple delete/insert, no clip-to-clip transitions (cross-fade with opacity keyframes instead), no
speed-ramp UI (time remap covers it), no stabilization or tracking, no captions/subtitles, and no
lossless passthrough — every export re-encodes every frame.

### 15.6 Scene-wide vs comp-scoped reads **[partly fixed]**

`flattenScene` walks every composition. The camera and DOF lookups are already scoped (every non-test
call site passes a `rootId`), and the "Make all 3D" button in `CameraSection` was fixed on 2026-07-29 to
use `flattenComposition(defaultSceneGraph, activeCompRootId())` — it previously flipped the 3D switch on
layers in *every* comp and persisted that. Still unscoped and worth auditing: `capabilities.ts`,
`useWorkspace.ts`, `ports.ts`, `sceneGizmoData.ts`, `expressionControls.ts`, `exportManager.ts`,
`audioScene.ts`.

### 15.7 Testing caveats **[verified]**

- Jest under OneDrive silently skips suites when placeholders appear — **check the suite count**, and
  note that `packages/*` suites are effectively invisible in the default run.
- Never benchmark under jest: the vm realm reorders the profile.
- `@testing-library/jest-dom` types break `tsc -b`.
- Live-verifying by `import('/src/…')` in the console can hand back a *second* Vite module instance —
  a different singleton than the app's.

### 15.8 Documentation drift

The README and `docs/` in this repo do not match the code. Treat this file as the entry point and the
code as the authority; when they disagree, the code wins and this file should be corrected.

---

## Appendix — where to start reading, by task

| If you are changing… | Start at |
|---|---|
| How a frame is built | `src/core/rendering/buildSnapshot.ts` |
| How a layer reaches the GPU | `src/core/rendering/snapshotToFrameScene.ts` → `MotionRendererBackend.ts` |
| Keyframes / values | `packages/animation/src/AnimationEngine.ts`, `interpolate.ts` |
| Clips, trims, splits | `src/core/timeline/TimelineController.ts`, `packages/timeline/src/clips/Clip.ts` |
| Canvas interaction | `packages/workspace/src/Workspace.ts` |
| An inspector control | copy a section from `src/layout/Inspector/` — and wire the **read** side too |
| An effect | `src/core/effects/effects.ts` (registry) + the pass that consumes it |
| An AI tool | `packages/ai-tools/src/tools/`, then `src/core/ai/toolHandlers.ts` |
| Save / open / bundles | `src/core/project/`, `src/core/persistence/` |
| Anything server-side | `motion-back/src/<module>/<module>.controller.ts` then `.service.ts` |
