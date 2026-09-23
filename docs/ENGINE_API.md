# Premation engine API

> **B1 of `docs/NATIVE_CORE_PLAN.md` §5, 2026-09-23.** The contract between the
> Electron UI and the engine. The UI sends **commands** (change the document),
> **queries** (read it) and **transport** controls; the engine answers with
> **results**, batched **change events** and frames. Today's TypeScript engine
> implements it first (B2), every UI write moves onto it (B3), and moving the
> engine into the C++ process `premation-engine` then changes where the bytes go,
> not the UI.
>
> One schema — `packages/engine-api/schema/*.eapi` — generates the TypeScript
> types and codec (`packages/engine-api/src/generated/`) and the C++ structs and
> codec (`native/protocol/generated/`). `npm run engine-api:gen` regenerates both;
> a Jest test fails if either is stale, and another fails if this document stops
> naming any command, query or event.

Contents: §1 principles · §2 inventory (what B3 has to move) · §3 addressing ·
§4 commands · §5 gestures and history · §6 transport · §7 queries · §8 events and
the UI mirror · §9 wire format (decision + measurements) · §10 errors · §11
versioning · §12 automation · §13 frames · §14 gaps against After Effects ·
§15 B2 implementation notes (what B3 deletes) · §16 files.

Schema size today: **121 commands** (91 document edits, 25 controls, 5 project
I/O — B1 miscounted; corrected in B2 from the meta table), **32 queries**, **27 events** (13 revisioned, 14 ephemeral), 309 structs,
10 unions, 49 enums — `SCHEMA_COUNTS` in `generated/meta.ts`.

---

## 1. Principles

1. **The document changes only through commands.** A command is a plain value,
   loggable, replayable, and has an exact inverse. Nothing else — no panel, no
   store, no plugin, no AI tool — writes the scene graph, the animation engine,
   the timeline engine or the project/composition/asset stores.
2. **Editor state never enters the API's document.** Selection, zoom, panel
   layout, scroll, open tabs, expanded rows, the playhead's UI copy, tool state:
   UI only (CLAUDE.md). The engine does own a few *engine-facing* view facts —
   which composition the clock follows, each viewport's size/zoom/ROI, preview
   quality — and receives them as **control** commands that never touch the
   document or history (§6).
3. **The engine owns time.** It runs the clock, keeps audio and video in sync,
   and tells the UI where the playhead is; the UI never ticks a render.
4. **One API for everyone.** UI, AI tools, scripts, plugins, the CLI and replay
   all send the same commands (§12). `Request.origin` says who.
5. **Failure changes nothing.** A rejected command, or any command of a rejected
   batch, leaves the document exactly as it was and returns a typed error (§10).
6. **Stable ids everywhere.** Every layer, item, property group, keyframe and
   marker is addressed by an id that survives edits, save/load and undo (§3).
7. **Primitives in the schema, macros in the client.** A command exists when its
   result depends on engine state the client cannot compute cheaply or safely
   (precompose, split, shapes from text, bake expression) or when it is a
   primitive with its own inverse. Pure arithmetic over values the client can
   query (align, distribute, easy ease, center anchor, sequence-with-offsets,
   wiggler) is a client-side **batch** of primitives — one undo entry, no new
   inverse to maintain.

---

## 2. Inventory — every document write today

Evidence for B3's size, gathered 2026-09-22 on `native-core` (`b2f3b2ed`) by
grepping every `.ts`/`.tsx` under `src/` and `packages/` (patterns listed per
table). "UI" = `src/layout`, `src/components`, `src/stores`, `src/hooks`,
`src/pages`, plus `src/App.tsx` and `src/providers` where noted. Tests excluded
from counts unless stated. Counts are call sites (matching lines).

### 2.1 Write mechanisms and where they are called from

| Mechanism | Write API | Production call sites | UI call sites | Samples (UI) |
|---|---|---|---|---|
| **SceneGraph** (`src/core/scene/SceneGraph.ts:214`, singleton `defaultSceneGraph`) | 11 core methods (`addNode` 252, `addChild` 258, `setParent` 298, `setLocalTransform` 350, `setSeparateDimensions` 370, `removeNode` 383, `setChildOrder` 449, `writeProp` 478, `addComponent` 515, `removeComponent` 534, `clear` 793) + 31 `fx` setters (`setEffects` 543 … `setFxKey` 777) + 5 live-view setters (`name`, `visible`, `locked`, `solo`, `color`) | 707 (src/core 355, render-tests harness 328) | 24 direct (layout 23, stores 1) + 8 direct view assignments | `Inspector/CharacterPanel.tsx:464`, `Inspector/ClonerSection.tsx:53`, `Inspector/MotionControls.tsx:119`, `stores/componentStore.ts:70`, `BottomTimeline/PopoutTimeline.tsx:134` |
| `updateNodeComponentProp` (`core/inspector/InspectorAPI.ts:6`) + `useNodeComponentProp` hook | `writeProp` + `NodeUpdated` + revision bump | 24 + 102 | 19 + 102 (CharacterPanel 39, CameraSection 25, LightSection 23 …) | `Workspace/TextEditOverlay.tsx:321`, `Inspector/ModelSection.tsx:81` |
| Scene helper modules (`layerFlags`, `sceneInsert`, `parenting`, `renameLayer`, `labelColor`, `transformWrite`, `setNode*`/`updateNode*` in effects/paint/material/threeD) | wrap SceneGraph | — | 190 (52 named helpers + 138 `setNode*`/`updateNode*`) | `Scene/ScenePanel.tsx:411`, `Inspector/ParentControl.tsx:49`, `Timeline/layerSwitches.ts:54` |
| **AnimationEngine** (`packages/animation/src/AnimationEngine.ts:1414`, `defaultAnimation`) | 27 mutating methods (`setKeyframes` 427, `setKeyframe` 451, `removeKeyframe` 467, `moveKeyframe` 476, `setEasing` 487, `setBezier` 501, `setSpatialTangent` 519, `setRoving` 561, `updateKeyframe` 584, `setSpatialInterp` 614, `removeTrack` 623, `setTrackKeyframes` 669, data-track ×6, expressions ×4, `clearNode`, `clear`, `restore`, `batch`) | setKeyframe 207, setKeyframes 62, removeTrack 59, batch 61, setBezier 32, setDataTrack 27, setExpression 25, setTrackKeyframes 23, updateKeyframe 22, others ≤ 17 | setKeyframe 76, removeTrack 26, setBezier 15, updateKeyframe 14, setDataKeyframe 6, setDataTrack 6, removeKeyframe 8, … (≈ 170, mostly inside `runAnimEdit` closures) | `Effects/EffectStack.tsx:208`, `Timeline/GraphEditor.tsx:1095`, `Inspector/RetimeSection.tsx:250`, `Motion/ExpressionEditor.tsx:144` |
| `runAnimEdit` / `beginAnimEdit` / `recordAnimEdit` (`core/animation/animationCommands.ts:292/253/272`) | diff-based anim undo command | 208 / 14 / 11 | 118 / 12 / 8 (layout 93, App 17, components 6, stores 2) | `Effects/EffectStack.tsx:206`, `Timeline/GraphEditor.tsx:882`, `App.tsx:524` |
| `compToKeyframeTime` (`core/timeline/TimelineController.ts:2406`) | time-space conversion before every keyframe write | 131 | 64 | — disappears: API times are comp-time flicks (§3.2) |
| **TimelineController** (`src/core/timeline/TimelineController.ts:205`) | 64 methods: comp rate/duration, transport, clip edits (setClipStart 655, trimClipTo 795, slip/slide, splitClip 1277, ripple*, rollEditSeconds 914), markers (1545–1657), work area (1678–1733) | 222 | 144 (layout 105, App 25, providers 6, pages 4, stores 3, hooks 1) | `App.tsx:1326`, `Composition/CompositionSettingsDialog.tsx:115`, `Timeline/useClipDrag.ts:609` |
| Timeline engine bypass | `c.timeline.addMarker`, `timeline.history.silently(...)` | 7 (`sceneEditDetectLayer.ts:136`, `beatCommands.ts:79`, `precompose.ts:300/306`, `layerTimeCommands.ts:293/554/624`) | 0 | — |
| **projectStore** comps (`stores/projectStore.ts:348`) + `compositionStore` wrapper | `createComp` 547, `removeComp` 564, `updateComp` 520, `replaceComps` 570 | 49 project actions (17 document) + 35 wrapper calls | ≈ 28 document writes (`update` 16 layout + 2 pages, `setBackgroundPaint` 6, `setTransparent` 2, `updateComp` 2) | `Composition/NewCompositionDialog.tsx:236` |
| `compositionOps.ts` | create/adopt/rename/duplicate/delete composition | 18 | via dialogs | — |
| **assetStore** (`stores/assetStore.ts:756`) | addAsset, addAssetsBatch, removeAsset(s), folders ×3, moveAssetToFolder, setInterpretation, setProxy, setTags, setLabel | 41 | ≈ 25 (AssetsPanel, InterpretFootageModal, MediaSection, DashboardPage) | `Assets/AssetsPanel.tsx:168`, `InterpretFootageModal.tsx:133` |
| Relink / replace footage | `relinkLiveAsset` (capture → rewrite node `src` → restore), `replaceLayerSourceWithAsset` | 3 | 3 (`RelinkAssetsDialog.tsx:35`, `Timeline.tsx:1567`, `Workspace.tsx:540`) | — |
| Effects (`core/effects/effects.ts`: addEffect 4945, updateEffectParam 4955, removeEffect 5065, toggleEffect 5070, moveEffect 5106, …; `writeEffectParams.ts:51`) | `fx.effects` + `effect.<id>.<param>` tracks | — | 28 in 6 files (EffectStack.tsx 21) | `Effects/EffectStack.tsx:212–892`, `Effects/AddEffectMenu.tsx:76` |
| Masks (`core/effects/mask.ts`: addMaskPath 727, updateMaskPath 736, … keyframeMask 617) | `fx.mask`, `fx.maskAnim` | — | 24 (layout 19, App 5) | `Effects/EffectsPanel.tsx:761–906`, `LayerMaskEditor.tsx:121` |
| Text (`core/text/textAnimators.ts` 851–979, `richText.ts` writeRuns 323 / applyStyleToRange 194) | `Text.__animators`, `Text.__runs` via writeProp | — | 25 (+ the 102 `useNodeComponentProp` uses) | `Inspector/CharacterPanel.tsx:340` |
| Layer styles (`core/effects/layerStyles.ts`, 21 setters) | `fx.layerStyles` | 118 | 80 (all `Effects/LayerStylesControls.tsx`) | — |
| Material / 3D geometry (`core/scene/material.ts`, `threeD.ts`, 19 setters) | flat transform props via writeProp | — | 34 (MaterialSection 21, ThreeDControl 6, …) | — |
| Paint / puppet / skeleton / tracker apply | `fx.paint`, `fx.puppet`, `fx.skeleton`, keyframes via `applyTrack.ts` | setPuppet 16 | paint 7, puppet 17, skeleton 27, tracker 11 | `Workspace/PuppetOverlay.tsx:426`, `Inspector/trackMotion/trackMotionActions.ts:129` |

### 2.2 The existing command and history layers

| Layer | What it is | Calls (prod) | Notes |
|---|---|---|---|
| `CommandSystem` (`core/commands/CommandSystem.ts:30`) | id → handler registry for menus/shortcuts/palette | `execute` 20, `registry.register` 67 | **258** literal command ids + ~30 template families; ≈ 124 edit the document, ≈ 134 are UI/view (`view.*` 58, `tool.*`, `transport.*`, `help.*` …). Only **2** carry their own `undo`. These map onto the API as *client-side* commands that send engine commands. |
| `HistoryService` (`HistoryService.ts:15`) | undo/redo stacks of `IUndoableCommand` (500) | — | Becomes the engine's history (§5). |
| `runDocumentEdit` (`documentEdit.ts:35`) | snapshot scene+anim+clips before/after one mutate | 75 (layout 37, App 5, core 33) | Snapshot command, not an inverse. |
| `runAsOneHistoryEntry[Sync]` (`core/composition/compositeEdit.ts:85/148`) | full `captureDocument()` before/after | 13 + 1 | The only path that undoes comps/tabs/guides. |
| `historyStore` (`stores/historyStore.ts`) | **700 ms debounce** (`RECORD_DEBOUNCE_MS`, line 106) keyed by `anim` / `node:<id>:<prop>` / `scene`; a different key flushes the pending entry; records `StoreSnapshotCommand(before, after)` of scene+anim+clips | `batchHistory` 22, `record` 9, `flush` 12, `runRestoring` 12 | Replaced by gestures (§5.3). |
| AI transaction (`core/ai/aiTransaction.ts:61`) | one snapshot command per agent run; tools write the live graph through facades | 3 entry points | 65 tools: 8 read, 41 write, 16 compose recipes. |
| Plugin host (`core/plugins/hostApi.ts`) | 53 methods, **20 mutate**, each a `runDocumentEdit`; `scene.apply` batches 12 op kinds (≤ 10 000 ops / 8 MB) | — | Permission-checked (`protocol.ts:239`). Native SDK has **no** mutation API; native sequence data lives in an in-memory LRU, not the document. |
| `.aep` import (`core/aep/aepApply.ts:293`), CLI render (`core/cli/headlessRender.ts`) | build documents with direct graph/anim calls; `.aep` resets the undo baseline instead of recording | — | Become `importProject` and command replay. |

So edits reach history in **four** ways today (anim-diff commands, scene+anim
snapshots, full-document snapshots, and the debounced recorder), which is why
the one-undo-history work (A2) was needed. The API collapses them into one:
commands with inverses, grouped by gestures and batches.

### 2.3 What is document state and what is not

| State | Today | API |
|---|---|---|
| Scene nodes, components, `fx`, parenting, stack order | SceneGraph | document (layers, properties, groups) |
| Keyframes, expressions, data tracks | AnimationEngine | document (keyframes, expressions) |
| Clip geometry (in/out/start), markers | Timeline engine (`clip:<nodeId>` bars) | document (`LayerTiming`, markers) |
| Composition settings | `projectStore.comps` (**not undoable today**) | document (`setCompositionSettings`, undoable) |
| Footage items, folders, interpretation | `assetStore` (folders + interpretation in **localStorage**, not the document) | document items |
| Render queue | render queue store | document (AE saves it with the project) |
| Solo, label colour | `custom.solo`, `custom.labelColor` | document switches |
| Shy | view-ish flag stuck on the cached node view | document switch (AE saves shy) |
| Guides, motion-blur defaults, colour management, swatches, materials, transitions | stores saved by `captureDocument` | project/comp settings where AE has them (colour, motion blur); swatches/guides stay editor state (§14.3) |
| Selection (6 stores), expanded rows, panel layout, viewport zoom, timeline zoom/scroll, open tabs, breadcrumbs, playhead UI copy | stores — but timeline zoom/scroll/`currentFrame` and open tabs are **serialized into the document today** | **never** in the API document |
| `SceneNode.selected` | a field on the engine's node | removed from the document model |

### 2.4 Size of B3

Distinct UI write call sites, de-duplicated where one wraps another:
scene graph ≈ 365 (343 in 56 UI files + App 17 + providers 4), animation ≈ 170
(118 wrappers + ≈ 50 unwrapped engine calls), timeline 144, compositions ≈ 28,
assets ≈ 25, layer styles/material/paint/puppet/skeleton/tracker ≈ 170 not
already counted. **≈ 900 call sites across roughly 150 files**, dominated by
`src/layout/Inspector`, `src/layout/Timeline`, `src/layout/Effects` and
`src/App.tsx`. The 2 `CommandSystem` undo commands and 258 command ids route
through the same API. Plus, on the engine side of the seam (B2's
`EngineClient` implementation, not B3), `src/core` holds 355 direct SceneGraph
calls and the AI/plugin/`.aep`/CLI writers.

### 2.5 Defects found while taking the inventory

These are not fixed in B1 (no behaviour change); B2/B3 must not copy them into
the API implementation. Each is a candidate test for the undo-parity suite.

1. **Shy is lost on load and on snapshot undo.** `toggleLayerFlag` writes
   `shy` onto the cached `AppNodeView` (`layerFlags.ts:312`); saving picks it
   up (`sceneProjectIO.ts:62`), but `SceneGraph.wrap` (218–236) never restores it.
2. **Stack order written around its guard.** `cloneLayerNode.ts:102–113` and
   `layerSnapshot.ts:116–126` cast to the private `engine()` and assign
   `custom.childIds`, skipping `setChildOrder`'s checks.
3. **Silent lost writes.** `t.props.x = …` on a live node (e.g. `clipboard.ts:404`)
   is discarded: `.components` is rebuilt as a copy on every read (SceneGraph.ts:158).
4. **Keyframe ids are positional.** `makeKeyframeId` = `nodeId::prop::t`
   (`packages/animation/src/keyframeId.ts`); moving a key changes its id, and the
   `Position` pseudo-prop id names no real track. The API mints stable ids (§3.3).
5. **Some tangent edits are not undoable.** `kfEqual` (`animationCommands.ts:211`)
   ignores `continuous`, `roving` and `spatialInterp`, so Break/Link Tangents
   (`GraphEditor.tsx:1897`) can record nothing.
6. **Merged data-track drags redo to the first step.** `mergeFrom`
   (`animationCommands.ts:118`) does not update `dataAfter` for tracks already in
   the command.
7. **Mask-shape keyframe edits wrapped in `runAnimEdit` record nothing**
   (`App.tsx:940–944`): the edit is on the scene graph, the diff is on animation.
8. **Text animator tracks are index-addressed** (`ta.<i>.…`); removing animator 0
   (`textAnimators.ts:874`) hands its keyframes to the next one.
9. **Composition settings are not undoable**; history snapshots hold scene,
   animation and clips only.
10. **Editor state is in the document**: timeline zoom/scroll/current frame
    (`Serializer.ts:29,68`) and open tabs (`cloudDocument.ts:136–180`).
11. `AnimationEngine.clearNode` / `clear` change state without notifying.
12. Asset folders and interpretation live in localStorage; there is no rename-asset
    action; relink rewrites node `src` through a capture/restore round trip.
13. Work-area edits are not undoable (`Timeline.setRange` skips `history.run`).

**B2 dispositions** (regression tests in `src/core/engine/__tests__/defects.test.ts`):
#1 fixed at the seam — shy is stored on the engine node and `wrap`/restore carry it; #2 fixed —
`cloneLayerNode`/`layerSnapshot` go through `setChildOrder` (and a restored layer keeps solo,
shy, colour); #3 fixed — the clipboard offsets the plain clone before insertion, and the API
writes only through `writeProp`/the property seam; #4 fixed — stable `Keyframe.id` + the 1.9.0
migration (§15.2); #5 fixed — `kfEqual` compares continuity, roving, spatial mode, id, label;
#6 fixed — `mergeFrom` adopts `dataAfter`; #7 fixed — App.tsx records mask-key moves with
`runDocumentEdit`, and the API keys mask shapes as ordinary undoable keyframes; #8 fixed —
removing/adding/moving animators or selectors re-keys their `ta.*` tracks
(`rekeyTextAnimatorTracks`), and the API addresses them by id; #9/#13 correct through the API
(`setCompositionSettings`, `setWorkArea` are undoable); the pre-API dialogs stay non-undoable
until B3 routes them through it; #10 left: the canonical document used for undo parity and
replay strips tabs/playhead/zoom, but `captureDocument` still saves them (removing them from the
file is a format change for B4, when the mirror owns view state); #11 left (not on an API
path); #12 fixed — folders, per-item organisation and interpretation are saved in the document
(`EditorDocument.projectItems`), localStorage is only a cache, and the API edits them undoably;
relink is `relinkItem`.

---

## 3. Addressing

### 3.1 Ids

| Thing | Id | Today | Notes |
|---|---|---|---|
| Layer | `LayerId` (string) | scene node uuid | Stable. A layer *is* its timeline bar: there is no separate clip id in the API. |
| Timeline bar | — | `clip:<nodeId>` (`TimelineController.ts:192`, `seedBarId`), `:1`, `:2` suffixes for legacy multi-bar nodes | The TS `EngineClient` maps `LayerId` ⇄ bar id; legacy multi-bar nodes are split into layers on migration. |
| Project item | `ItemId` | composition id / asset id | Compositions, footage, folders share one id space in the API. |
| Property group | `GroupId` | effect `fx_<n>` (unique per node only), mask `mask_<n>`, path-op id, paint stroke id, puppet pin id; text animators and selectors have **no id** (index) | API group ids are unique **per layer**; text animators/selectors get ids in B2 (fixes §2.5 #8). |
| Keyframe | `KeyframeId` | derived `nodeId::prop::t` | Engine-assigned, opaque, stable across move/retime/undo/save. B2 keeps an id table beside each track until the TS engine stores ids. |
| Marker | `MarkerId` | `MarkerData.id` | Already stable. |
| Job / render item | `JobId` / `RenderItemId` | — | Engine-assigned. |

Ids are opaque to the UI: never parse them. The engine never reuses an id within
a document (undo restores the *same* id).

### 3.2 Time

All API times are integers in **flicks** (1/705,600,000 s), comp time unless a
field says otherwise (layer markers use layer time). 705,600,000 is divisible
by 24, 25, 30, 48, 50, 60, 90, 100, 120 and by every NTSC rate's frame length
(24000/1001 → 29,429,400 flicks per frame), so frame boundaries are exact
integers — no `+1 µs` nudge, no float drift between engines. A JS number holds
flicks exactly for ±147 days (the codec rejects anything outside
[−2^52, 2^52)). The TS engine stores seconds (keyframes) and frames (clips);
`secondsToFlicks`/`frameToFlicks` in `packages/engine-api/src/time.ts` are the
only conversions, at the seam. Frame rates are exact `Rational`s.

### 3.3 Keyframes

A keyframe carries the model `motion_eval` (the first C++ library) already
implements bit-exactly: `easing` of the segment that starts at the key
(`linear | hold | bezier | ease | easeIn | easeOut | easeInOut | step |
autoBezier | continuousBezier`), `bezier` handles `[x1,y1,x2,y2]`, `continuous`,
`roving`, `spatialInterp`, per-dimension `spatialIn`/`spatialOut` tangents, and a
colour `label`. Values are a full `Value` (a vec3 position is one keyframe, not
three). Where the TS engine holds per-dimension tracks whose times do not align
(legacy documents), the dimensions are addressed separately (`transform/position/x`).

### 3.4 Property paths

`PropRef = { layer, path }`. A path is `/`-separated; groups are addressed by
their `GroupId`, never by index.

| Property | API path | Today's TS track / storage |
|---|---|---|
| Transform | `transform/anchorPoint`, `transform/position`, `transform/scale`, `transform/rotation`, `transform/xRotation`, `transform/yRotation`, `transform/orientation`, `transform/opacity` | `anchorX/Y/Z`, `x y z`, `scaleX/Y/Z`, `rotation`, `rotationX/Y`, `orientationX/Y/Z`, `opacity` |
| Separated dimension | `transform/position/x` | `x` |
| Effect param | `effects/<effectId>/<param>`; effect opacity `effects/<effectId>/compositing/opacity` (AE's Compositing Options group: 19 effects declare their own `opacity` param, so the flat path was ambiguous) | `effect.<id>.<param>`, `effect.<id>.fx.opacity` |
| Colour (any) | one `color` Value at its path | four tracks `<base>_r/_g/_b/_a` |
| Layer style | `styles/<styleId>/<param>` | `effect.layerstyle:<styleKey>.<param>` |
| Mask | `masks/<maskId>/path`, `…/feather`, `…/opacity`, `…/expansion`, `…/mode`, `…/inverted` | path: whole-mask snapshots in `fx.maskAnim` (not a track); others `mask.<pathId>.<prop>` |
| Source text | `text/sourceText` (`textDocument` Value) | data track `text.source` + `Text.content`/`__runs` |
| Text animator | `text/animators/<animatorId>/props/<prop>`, selector `text/animators/<animatorId>/selectors/<selectorId>/<param>` | `ta.<i>.<param>`, `ta.<i>.s<j>.<param>` |
| Font axis | `text/axes/<tag>` | `text.axis.<tag>` |
| Shape contents | `contents/<groupId>/…/<param>` | `pathop.<opId>.<param>`, `fx.fill(s)`, `fx.stroke(s)` |
| 3D material / geometry | `material/<param>`, `geometry/<param>` | bare names (`metal`, `extrusionDepth`, …) |
| Camera / light | `camera/<param>`, `light/<param>` | flat transform props |
| Paint stroke | `paint/<strokeId>/<param>`, `paint/<strokeId>/path` | `paint.<strokeId>.*` |
| Puppet pin | `puppet/<pinId>/position` … | `puppet.<pin>.*` |
| Audio | `audio/levels`, `audio/pan` | `audioLevelDb`, `audioPan` |
| Time remap / retime | `timeRemap`, `layer/timeSpeed` | `timeRemap`, `timeSpeed` |
| Expression controls | `effects/<controlId>/<param>` | `ctrl_<name>` |
| Layer-level params (solid colour, plugin layer params) | `layer/<param>`, `plugin/<param>` | component props |

Non-animatable fields (mask mode, blend mode of a style, text box size…) are
properties too: `setProperty` writes them; `PropertyInfo.animatable` says which
may take keyframes. `propPath()`/`parsePropPath()` in `src/propPath.ts` build and
check paths.

### 3.5 Values

`Value` is a tagged union: `none`, `bool`, `int`, `scalar`, `vec2`, `vec3`,
`vec4`, `color` (straight RGBA in the working space, may exceed 1), `string`,
`choice` (an enum member by name), `path` (`BezierPath`: vertices, tangents,
closed, per-vertex feather), `gradient`, `textDocument` (text + style runs +
paragraphs + box + orientation), `layer`/`item` references, `scalars` (numeric
list), and `json` — an explicit **escape hatch** for structured values not yet
typed (§14.2 lists every use). The engine type-checks every write against the
property's `ValueType`.

---

## 4. Commands

Every command below is a message in the schema; "Inverse" is exactly what undo
restores. Unless marked, a command is an **edit**: one history entry (or part of
the open gesture/batch), a new document revision, and change events. `[c]` =
coalescable inside a gesture (§5.2). Controls and I/O never enter history.

### 4.1 History and session

| Command | Kind | Semantics / inverse |
|---|---|---|
| `undo` / `redo` | control | Move one entry. Undo is itself a revision (the document moves *forward* to a state equal to an older one) so the mirror only ever applies events forward. Error `nothingToUndo`/`nothingToRedo`; `gestureOpen` while a gesture is open. |
| `jumpToHistory` | control | Undo/redo repeatedly to `position` (History panel). |
| `beginGesture` / `endGesture` | control | §5. `endGesture{commit:false}` reverts every edit of the gesture (Esc during a drag). |
| `clearHistory`, `setHistoryLimit` | control | Document unchanged. |
| `newProject`, `openProject`, `revertProject` | io | Replace the document; clear history; the UI receives `documentReset`. |
| `saveProject` | io | Temp file + rename. `copy:true` = Save a Copy (path and dirty flag unchanged). |
| `collectFiles` | io | Copy project + used files to a folder; document unchanged. |
| `setAutosave` | control | Recovery cadence (a preference the engine executes). |
| `importProject` | edit | Import `.motion`/`.aep`/`.aepx` into a new folder. Inverse: remove every imported item. |
| `setProjectSettings` | edit | Patch (bit depth, working space, linear blending, OCIO config, time display, expression engine, frame numbering, sample rate). Inverse: previous values of the patched fields. |

### 4.2 Items (footage, folders) and render queue

| Command | Semantics / inverse |
|---|---|
| `importFiles` | Import files (sequence detection, target folder, interpretation, optional comp). Inverse: remove the items (files untouched). |
| `relinkItem` | Point an item at another file (relink / Replace Footage). Inverse: old path (+ old interpretation unless kept). |
| `reloadItems` | control — re-read from disk. |
| `removeItems` | Remove items; with `removeUsingLayers` also their layers, otherwise error `locked` if used. Inverse: items and layers restored with the same ids and positions. |
| `renameItem`, `setItemLabel`, `setItemComment`, `setItemTags` | Inverse: previous value. |
| `createFolder`, `moveItems` | Inverse: delete the folder / previous parents. |
| `setInterpretation` | Alpha mode, premultiplied matte, conform rate, pixel aspect, field order, loops, colour profile, start timecode. Inverse: previous values of patched fields. |
| `removeUnusedItems` | Inverse: restore removed items. |
| `setProxy` | Assign/enable/clear a proxy. Inverse: previous proxy state. |
| `addRenderItems`, `setRenderItem`, `removeRenderItems`, `reorderRenderItems` | Render queue (saved with the project, as in AE). Inverses: remove / previous settings / restore / previous order. Rendering itself is a job (§4.9). |

### 4.3 Compositions

| Command | Semantics / inverse |
|---|---|
| `createComposition` | From settings, or `fromItems` (size/rate/duration from the first item, a layer per item). Inverse: remove it. |
| `duplicateComposition` | `deep` also duplicates nested comps. Inverse: remove the copies. |
| `setCompositionSettings` [c] | Patch name, size, pixel aspect, rate, duration, start timecode, background (colour or gradient), transparency, work area, motion blur (shutter angle/phase, samples, adaptive limit), 3D renderer, global light, drop frame, preserve rate/resolution, world settings. Changing rate or duration never moves keyframes (times are flicks). Inverse: previous values of patched fields. **Undoable — today it is not.** |
| `setWorkArea` [c] | Inverse: previous range. |
| `precompose` | `moveAll` or `leaveAttributes` (one layer only), optional duration fit. Inverse: original layers restored exactly (ids, properties, keyframes, parenting, stack slots), new comp removed. |
| `trimCompToWorkArea`, `cropComposition` | Inverse: previous duration/size and every shifted layer time / position. |
| `assembleComposition` | Clips laid end to end with overlap. Inverse: remove it. |

### 4.4 Layers

| Command | Semantics / inverse |
|---|---|
| `createLayer` | Any `LayerKind` (null, solid, shape, rectangle, ellipse, polygon, path, text, image, video, audio, svg, precomp, camera, light, group, component, particle, model3d, generator, adjustment, sequence), with source item, parent, stack index, in/out/start and initial property values. Inverse: delete it. |
| `deleteLayers` | Children are unparented keeping world transform. Inverse: layers back with the same ids, properties, keyframes, effects, parenting and stack slots; children re-parented. |
| `duplicateLayers` | Copies directly above; returns new ids in input order. Inverse: delete copies. |
| `reorderLayers` | Move a set (keeping relative order) to `toIndex`. Inverse: previous full order. |
| `setParent` | `keepWorldTransform` (AE default) rewrites transform values/keys so nothing jumps. Inverse: previous parent **and** the rewritten transform values/keys. Error `cycle`. |
| `renameLayer`, `setLayerComment` | Inverse: previous value. |
| `setLayerSwitches` | Patch visible, audio, solo, lock, shy, collapse, quality, fx, motion blur, adjustment, 3D, guide, frame blend, auto-orient, preserve transparency, label. Inverse: each layer's previous value of each patched switch. |
| `setBlendMode`, `setTrackMatte` | Matte by reference to any layer (AE 2023). Inverse: previous values. |
| `replaceLayerSource` | Inverse: previous source (and size if changed). |
| `groupLayers` / `ungroupLayer` | Premation group layers. Inverse: ungroup / regroup with the same group id. |
| `convertLayer` | Engine-evaluated conversions: shapes from text, masks from text, shapes from vector, editable text, uncompose, bake transform. Inverse: remove the created layers (and restore the source layer's visibility if the conversion hid it). |
| `pasteLayers` | Paste a `DocumentFragment` (from the `copyLayers` query). Inverse: delete pasted layers and any items the paste created. |
| `separateLayer` | Break apart into per-part layers. Inverse: remove parts, restore original. |
| `autoTrace` | Masks from alpha/luma over a range. Inverse: remove the created masks. |

### 4.5 Layer time (the timeline bars)

| Command | Semantics / inverse |
|---|---|
| `setLayerTiming` [c] | **The primitive**: in/out/start/stretch for many layers. Inverse: previous values. |
| `moveLayersInTime` [c] | Move by `delta`; `ripple` shifts later layers. Inverse: previous timing of every moved layer. |
| `trimLayers` [c] | Trim `in`/`out` edge to `time`, optional ripple. Inverse: previous timing of trimmed and rippled layers. |
| `slipLayers` [c], `slideLayer` [c], `rollEdit` [c] | Slip source under fixed in/out; slide with neighbour trims; roll the cut between two layers. Inverse: previous timing of all touched layers. |
| `splitLayers` | Original keeps the left part and its id; right parts get new ids (keyframes/markers split). Inverse: delete right parts, restore original out point. |
| `rippleDeleteLayers` | Delete and close gaps. Inverse: restore layers and shifted timings. |
| `editWorkArea` | Lift or extract the work area. Inverse: restore every trimmed/split/shifted layer. |
| `insertGap` | Inverse: shift back. |
| `timeReverseLayers` | Inverse: reverse again (exact: stretch sign + mirrored keys). |
| `setTimeRemap` | Enabling creates AE's two boundary keys; disabling removes the property. Inverse: previous state incl. keys. |
| `freezeFrame` | At `time` or last frame. Inverse: previous remap state and timing. |
| `setRetime` | Normal / Speed % / Frames with parameter. Inverse: previous mode + retime keys. |
| `sequenceLayers` | End to end with overlap, optional crossfade. Inverse: previous timings and opacity keys. |

### 4.6 Properties and keyframes

| Command | Semantics / inverse |
|---|---|
| `setProperty` [c] | Not animated: sets the static value (`time` ignored). Animated: `time` required — creates or replaces the key at `time` (AE `setValueAtTime`); without it, error `animated`. Returns the key id when one was touched. Inverse: previous static value, or removal of the created key / previous value of the replaced one. |
| `setProperties` [c] | Many writes, one command, all-or-nothing (multi-layer drags). |
| `resetProperty` | Default value (a key at `time` if animated). Inverse: previous value/key. |
| `setAnimated` | The stopwatch. On: one key at `time` with the current value. Off: remove all keys; static value = value at `time`. Inverse: exact previous keys/value. |
| `setDimensionsSeparated` | Split/merge dimensions and their keys as AE does. Inverse: the previous keys exactly. |
| `setExpression` | Set/replace; empty source removes. Returns diagnostics; a failing expression is stored disabled (AE). Inverse: previous source + enabled flag. |
| `setExpressionEnabled` | Inverse: previous flags. |
| `convertExpressionToKeyframes` | Bake over a range at a step. Inverse: previous keys + expression. |
| `linkProperty` | Pickwhip: sets an expression reading `target`. Inverse: previous expression. |
| `addKeyframes` | Keys at times (value defaults to the evaluated value); a key already at that time is replaced **and keeps its id**. Inverse: remove added keys, restore replaced ones. |
| `deleteKeyframes` | Deleting the last key leaves the property static at its value. Inverse: keys back with the same ids. |
| `moveKeyframes` [c] | By `delta`; a moved key landing on an unmoved key replaces it. Inverse: previous times + the replaced keys (same ids). |
| `updateKeyframes` [c] | Patch value, easing, handles, continuity, roving, spatial mode/tangents, label (the graph editor's handle drags, Easy Ease, Keyframe Velocity, Toggle Hold, labels). Inverse: every patched field. |
| `scaleKeyframes` [c] | Alt-drag time scaling around a pivot. Inverse: previous times (+ replaced keys). |
| `reverseKeyframes` | Time-Reverse Keyframes. Inverse: reverse again (exact). |
| `pasteKeyframes` | Keys from any property onto `prop` starting at `time`. Inverse: remove them, restore replaced ones. |

### 4.7 Property groups (effects, masks, animators, shapes, styles, strokes, pins)

| Command | Semantics / inverse |
|---|---|
| `addEffect` | By match name, on several layers, at a stack index, with initial params. Returns `effects/<id>` per layer. Inverse: remove them. |
| `addMask` | Path, mode (none/add/subtract/intersect/lighten/darken/difference), name, index, inverted. Inverse: remove. |
| `addPropertyGroup` | Any other group under a parent path by match name: text animators, selectors, shape contents (rect, ellipse, polystar, path, fill, stroke, gradient fill/stroke, trim, repeater, merge, offset, round corners, twist, wiggle, zig-zag, pucker/bloat), layer styles, paint strokes, puppet pins, expression controls. Inverse: remove. |
| `removePropertyGroups` | With their keys and expressions. Inverse: back at their index with the same ids. |
| `movePropertyGroup` | Reorder within the parent. Inverse: previous index. |
| `duplicatePropertyGroups`, `copyPropertyGroups` | Copies (same layer / other layers). Inverse: remove the copies. |
| `setGroupEnabled` | fx switch, mask enable, animator enable. Inverse: previous flags. |
| `renamePropertyGroup` | Inverse: previous name. |
| `applyPreset` | Animation preset at `time`. Inverse: remove added groups, restore overwritten keys. |
| `invokeEffectAction` | A plugin effect's button (param supervision). The plugin's resulting writes are one history entry; inverse is that entry. |

`setEffectParam` and `setMaskPath` from the plan's §2 sketch are `setProperty`
on an effect or mask path — one command, one inverse implementation.

### 4.8 Markers

| Command | Semantics / inverse |
|---|---|
| `addMarkers` | Composition or layer markers (time, duration, name, comment, label). Inverse: remove. |
| `updateMarkers` [c] | Patch incl. chapter, URL, cue point, protected region. Inverse: previous fields. |
| `deleteMarkers` | Inverse: restore with the same ids. |
| `moveMarkers` [c] | Inverse: previous times. |

### 4.9 Jobs and plugins

| Command | Kind | Semantics |
|---|---|---|
| `startJob` | control | Track motion (position … planar, forward/backward/both, apply to a property), stabilize, auto-trace, scene detect, object matte, transcribe, audio analysis, render queue items, pre-render. A job never edits while it runs; on success its result is applied as **one** history entry (`origin: engine`) unless `apply:false`. |
| `cancelJob` | control | Nothing is applied. |
| `applyJobResult` | edit | Apply a finished `apply:false` job. Inverse: that entry. |
| `setPluginEnabled` | control | Session enable/disable (installation stays in the editor's plugin manager). |
| `setPluginData` | edit | Plugin data **in the document** (AE sequence data / arbitrary-data params) — today it is an in-memory LRU. Inverse: previous bytes. |

### 4.10 Transport and viewport — §6.

---

## 5. Gestures and history

### 5.1 One entry per user action

The engine keeps one linear history of entries; each entry is a list of applied
commands with their recorded inverses (the engine records the *concrete* inverse
at apply time — e.g. the replaced keyframe — so undo never re-derives anything).

- A single edit command outside a gesture is one entry, labelled from the command
  (`Set Position`, `Delete 3 Layers`) unless the UI supplies a label via a batch.
- A **batch** (`RequestBody.batch`, label + commands) is one entry and atomic:
  if command *k* fails, commands 0…k−1 are rolled back and the error names *k*.
- A **gesture** (`beginGesture(label)` … `endGesture(commit)`) is one entry for
  everything applied in between, from any origin. Gestures do not nest
  (`gestureOpen`); `endGesture` without one is `noGesture`. `commit:false`
  applies the inverses (Esc cancels a drag, the document returns exactly). If the
  UI disconnects mid-gesture the engine commits it (nothing the user saw is lost).
- `control` and `io` commands never enter history; `undo`/`redo` inside a gesture
  are refused.

### 5.2 How drags coalesce

A drag sends `beginGesture('Move')`, then one `setProperty` (or `setLayerTiming`,
`moveKeyframes`, …) per pointer move, then `endGesture(true)`. Inside a gesture,
consecutive `[c]`-marked commands with the **same coalesce key** — command type
+ target (`PropRef` / layer set / keyframe id set) — merge: the entry keeps the
*first* command's inverse and the *last* command's value. A 3-second drag at
60 Hz is 180 messages on the pipe (~18 KB, §9.3) and one entry holding one
inverse per touched property. Each message is still applied immediately and
produces events, so the rendered frame follows the pointer within a frame.

The UI moves the gizmo from its own pointer state immediately (it never waits
for the round trip), then adopts the engine's value when the event arrives; the
mirror ignores events older than a pending gesture write it has already shown
(§8.3).

### 5.3 What replaces the 700 ms debounce

`historyStore`'s 700 ms timer guesses where an action ends by watching change
events. With the API every place that starts an interaction also ends it:
pointer down/up, text field focus/commit, slider drag start/end, a menu command
(one batch). So:

| Today | With the API |
|---|---|
| Debounced `schedule(key)` on `AnimationChanged` / `NodeUpdated` / `SceneGraphChanged` | Nothing listens to changes to build history. |
| `batchHistory(key, fn)` | A batch, or a gesture around `fn`'s commands. |
| `beginAnimEdit` → `commit` (drags) | `beginGesture` → `endGesture`. |
| `runAnimEdit` / `runDocumentEdit` / `runAsOneHistoryEntry` | One command or one batch; the engine records inverses. |
| Scrubbing a number field | Gesture from pointer down to up; typed value = one command. |
| Keyboard nudges (arrow keys, 10 presses) | Each press is one command and one entry — After Effects' behaviour. No time-based grouping exists anywhere: history must replay identically (§12), and a wall-clock rule would make it depend on typing speed. |
| `flush()` before engine history runs | Not needed: there is one history. |

### 5.4 What undo restores

Exactly the inverse of each command in the entry, applied in reverse order. The
events produced by undo are ordinary change events with a new revision
(`historyChanged` follows). Undo never restores editor state: selection is the
UI's business (it may re-select the ids named in the undone entry's events).

---

## 6. Transport (engine-owned clock)

| Command | Semantics |
|---|---|
| `setActiveComposition` | Which comp the clock and viewports follow (the active tab). |
| `play` | Rate (±, up to 4× for J/K/L), range (all / work area / custom), audio on/off, `cacheFirst` (RAM preview: cache then play at full rate), optional start time. Audio is the master clock when enabled; video drops frames rather than drifting (AE-style `min(dt, 1.5 frames)` pacing becomes an engine policy). |
| `pause` | Optionally return to the start (numpad 0 vs space). |
| `seek` [c] | `exact` or `scrub` (preview quality allowed, audio scrub on). Coalesced: only the newest pending seek is rendered. |
| `step` | ± frames. |
| `setLoop` | once / loop / ping-pong. |
| `setPreviewQuality` | Resolution (full/half/third/quarter/auto), fast previews (off/adaptive/draft/wireframe), draft 3D, motion blur in preview, adaptive floor. |
| `setAudioPreview` | Mute, volume, scrub audio. |
| `setViewport` [c] / `closeViewport` | Per viewport: pixel size, DPR, zoom, pan, region of interest, channel (RGB/R/G/B/alpha/straight), exposure, transparency grid, display transform, single-layer view (Layer panel) with or without effects. |
| `setCacheBudget`, `purgeCache` | RAM/disk cache sizing and purges. |
| `setInteracting` | Hint while dragging: the engine may drop to draft until it ends. |

The engine reports the clock with ephemeral `playhead` events (at most once per
displayed frame, and after every seek) and `transportChanged` on state changes;
`cacheChanged` drives the green cache bar. None of these carry a revision and
none touch history. The UI's `playbackClockStore` becomes a mirror of
`playhead`; `usePlaybackClock`'s rAF loop, `controller.tick` and
`flushRenderNow` leave the UI.

---

## 7. Queries

Queries answer at the revision in their `Response` and never change anything.

| Query | Returns |
|---|---|
| `getDocument` | `DocumentSnapshot`: revision, path, dirty, project settings, items, comps (settings + layer order + markers), layer headers, optionally every property tree and keyframe set, render queue. The mirror's initial load. |
| `getComposition`, `getLayers` | Comp + its layer headers; layer headers by id. |
| `getPropertyTree` | `PropertyInfo` nodes under a path to a depth, with values at a time: name, match name, kind, value type, animatable/animated, dimensions, separated, enabled, value, default, min/max/soft range, choices, unit, expression + error, key count, children, hidden. |
| `getPropertyValues` | Values at a time, evaluated or pre-expression. |
| `sampleProperty`, `getMotionPath` | Dense samples (+ speed) for the graph editor and motion paths. |
| `getKeyframes`, `getMarkers` | Keyframe sets / markers, optionally in a range. |
| `copyLayers` | A `DocumentFragment` for the clipboard. |
| `getWaveform` | Min/max (+ RMS) peaks per bucket per channel for a layer or item range. |
| `listFonts` | Families, styles, PostScript names, weight, italic, variable axes, scripts. |
| `getItems`, `getThumbnail` | Item metadata (size, duration, rate, codec, alpha, audio, colour profile, missing, proxy); encoded thumbnail. |
| `listEffects`, `listGroupTypes`, `listPresets` | The effect catalog with full param schemas (drives the Effects & Presets panel and generic effect UIs); addable group types under a path; presets. |
| `getCapabilities` | GPU adapter/backend/VRAM/max texture, hardware decoders, export formats, colour management, float, plugin APIs, expression engines, threads. |
| `hitTest` | Layers under a comp point at a time (topmost or all). |
| `getLayerBounds`, `getLayerTransforms` | Bounds/corners in comp/layer/viewport space; 4×4 layer→comp matrices — what gizmos draw from. |
| `getTextLayout` | Glyph boxes/lines for in-viewport text editing. |
| `evaluateExpression` | Preview an expression without storing it. |
| `readPixels` | Working-space pixel values of a viewport region (Info panel, eyedropper). |
| `findLayers`, `getDependencies` | Search; uses/used-by (flowchart, expression refs, precomp nesting). |
| `getHistory`, `getRenderStats`, `getLayerErrors`, `getJobs`, `getRenderQueue` | Status. |
| `getCommandLog` | Recorded requests since a revision (replay, bug reports, §12). |

---

## 8. Events and the UI mirror

### 8.1 Batches and revisions

Every applied edit increments the document **revision** by one (undo and redo
included). After each request (or engine-initiated change such as a job result),
the engine sends one `EventBatch { fromRevision, toRevision, events, causedBy,
origin }`. Revisioned events are complete facts, never deltas the mirror must
compute:

| Event | Meaning (all upserts are full records) |
|---|---|
| `documentReset` | Mirror invalid — refetch `getDocument` (open/new/revert/recovered/engine restart/resync). |
| `projectSettingsChanged` | New `ProjectSettings`. |
| `itemsChanged` / `itemsRemoved` | Upsert `ItemInfo`s / remove ids. |
| `compositionChanged` | New `CompSettings` of a comp. |
| `layersChanged` / `layersRemoved` / `layerOrderChanged` | Upsert `LayerInfo` headers / remove / the full new stack order. |
| `propertiesChanged` | Changed `PropertyInfo`s of one layer (value, animated, expression, …). |
| `keyframesChanged` | Full replacement key lists per changed property (empty = no longer animated). |
| `propertyGroupsChanged` | The new ordered child list under a parent path (group added/removed/moved/renamed/enabled). |
| `markersChanged` | All markers of one owner. |
| `renderQueueChanged` | All render items. |

Ephemeral (no revision, `fromRevision == toRevision`): `historyChanged`,
`dirtyChanged`, `transportChanged`, `playhead`, `renderStatsUpdated`,
`cacheChanged`, `engineError`, `layerErrors` (the complete per-layer error set of
a comp — `snapshot.layerErrors`), `jobProgress`, `jobFinished`, `projectSaved`,
`assetStatusChanged`, `fontsChanged`, `autosaved`.

### 8.2 Applying a batch

The mirror holds `revision`. For a batch:

1. `fromRevision == revision` → apply every event in order, set `revision =
   toRevision`, then notify subscribers **once** (one Zustand `set` per store per
   batch, never per event — CLAUDE.md "no React render per played frame").
2. `fromRevision > revision` (a gap — lost message, engine restart) → drop the
   batch and resync with `getDocument`.
3. `toRevision <= revision` → already applied (duplicate), ignore.

Because events carry full records, applying is assignment, not recomputation:
the mirror stays dumb and the two engines are interchangeable.

### 8.3 Optimistic UI during gestures

During a gesture the UI shows its local value. When a `keyframesChanged`/
`propertiesChanged` for the same property arrives with `causedBy` equal to a
request the UI already superseded, the UI keeps its newer local value; the last
response of the gesture is always authoritative.

---

## 9. Wire format — decision and measurements

### 9.1 Decision

**A small custom schema → codegen, emitting the protobuf wire encoding
canonically.** Not FlatBuffers.

- One schema language (`.eapi`, §9.2) generates TypeScript types, a TypeScript
  codec, command/query/event metadata, C++ structs and a C++ codec. The
  generator is ~1,400 lines of dependency-free CommonJS: it runs on CI's Node 20,
  needs no native tool (no `flatc`, no `protoc`), and the Jest test calls it in
  memory to prove the checked-in output is current.
- The encoding is the protobuf wire format (varint keys, zigzag, little-endian
  fixed floats, length-delimited nesting, packed numeric lists) written
  **canonically** (field-number order, required fields always written, absent
  optionals and empty lists never written), so both encoders produce identical
  bytes. That is tested for every message type (§9.4), and `protoc --decode_raw`
  can read a captured message when debugging.
- Numbers measured on this machine (below): smaller than FlatBuffers on every
  payload (drag write 100 B vs 184–192 B, full 2,000-layer document 3.39 MiB vs
  4.0–5.4 MiB); faster to encode in both languages; faster to fully decode in
  Node; comparable in C++. FlatBuffers wins only zero-copy *partial* reads,
  which the UI mirror does not do — it must materialize plain objects into
  stores — and which the engine does not need for commands of ~100 bytes.

### 9.2 The schema language

```text
version 1.0;                      // protocol major.minor
family "Layers";                  // groups following declarations (docs, meta)
alias LayerId = string;           // scalar aliases
enum MatteMode { none = 0; alpha = 1; "color-dodge" = 6; }   // 0 = default
struct TrackMatte { layer?: LayerId = 1; mode: MatteMode = 2; }
union Value { none: void = 1; scalar: f64 = 4; vec2: Vec2 = 5; }   // exactly one
command setTrackMatte = 208 [coalesce] { layer: LayerId = 1; matte: TrackMatte = 2; } -> ResultStruct;
query getLayers = 1002 { layers: LayerId[] = 1; } -> LayerDetails;
event layersChanged = 2005 [ephemeral] { layers: LayerInfo[] = 1; }
```

Scalars: `bool i32 u32 i64 u64 f32 f64 string bytes`; `T?` optional, `T[]`
list (never optional — empty is absent). Commands take `[control]`, `[io]`,
`[coalesce]`; events `[ephemeral]`. The generator synthesizes the `Command`,
`CommandResult`, `Query`, `QueryResult` and `Event` unions from the
declarations (keyed by their ids), validates numbers, names, types and
C++-layout cycles, and refuses what it cannot represent.

TypeScript shape: structs are interfaces; enums are string unions (`'color-dodge'`,
matching today's code); unions are `{ kind, value }`; the synthesized unions are
flat `{ type: 'setProperty', …fields }`. 64-bit integers are JS numbers (safe
range enforced). C++ shape: plain structs with defaulted `operator==`,
`std::optional`, `std::vector`, `std::variant` unions with a `Kind` enum,
`enum class` enums, `encode(Writer&, const T&)` / `Status decode(Reader&, T&)` —
no exceptions, no raw `new`, no macros.

### 9.3 Measurements

Payloads are built identically in TypeScript (`packages/engine-api/bench/benchDocument.ts`)
and C++ (`native/protocol/bench/bench_protocol.cpp`); the encoded sizes are
**byte-identical across the two languages** (100 / 330 / 398,183 / 3,556,183 B).
Machine: Windows 11, Node 24.16, clang-cl 23.1 (RelWithDebInfo, `/O2`). Medians
of 7 batches. FlatBuffers 25.12.19 (vcpkg baseline) / npm `flatbuffers` 25.9.23,
code generated by `flatc --gen-object-api` from an equivalent `.fbs`; "decode"
means materialize everything (object API `unpack`), because that is what the
mirror needs.

**TypeScript (Node 24)** — `npm run engine-api:bench`

| Payload | engine-api | JSON (+UTF-8) | V8 serialize (Electron IPC) | FlatBuffers obj API |
|---|---|---|---|---|
| `setProperty` drag write | **100 B** · 0.9 µs enc · 0.7 µs dec | 185 B · 1.7 · 1.5 µs | 177 B · 6.2 · 4.6 µs | 184 B · 4.1 · 1.0 µs |
| Drag event batch (`keyframesChanged`) | **330 B** · 1.8–2.6 · 1.7–2.1 µs | 777 B · 4.4 · 4.8 µs | 753 B · 7.4 · 8.4 µs | 592 B · 5.9 · 2.3 µs |
| `getDocument` 2,000 layers, headers | **389 KiB** · 2.2 ms · 2.5 ms | 1.33 MiB · 6.5 · 6.0 ms | 1.10 MiB · 4.6 · 7.4 ms | 500 KiB · 9.1 · 3.2 ms |
| `getDocument` 2,000 layers + 24,000 properties + 4,000 keys | **3.39 MiB** · 16 ms · 20 ms | 11.4 MiB · 54 · 52 ms | 9.98 MiB · 54 · 82 ms | 5.40 MiB · 125 · 41 ms (lazy walk of all layer names: 0.33 ms) |

**C++ (clang-cl 23)** — `node native/protocol/build.mjs --bench` and the FlatBuffers twin

| Payload | engine-api encode · decode | FlatBuffers Pack · Verify · UnPack |
|---|---|---|
| `setProperty` | **100 B** · 0.10 µs · 0.20 µs | 192 B · 0.22 µs · 0.04 µs · 0.32 µs |
| Drag event batch | 330 B · 0.49 µs · 1.3 µs | — |
| 2,000 layers, headers | **398 KB** · 0.9 ms · 2.3 ms | 466 KB · 1.7 ms · 0.14 ms · 1.6 ms |
| 2,000 layers, full | **3.56 MB** · 9.1 ms · 27.7 ms | 4.19 MB · 25.6 ms · 2.2 ms · 29.2 ms |

What the numbers mean for the product: a 60 Hz drag costs the UI < 3 µs per
pointer move to encode and decode (both directions) and ~26 KB/s of pipe; the
worst realistic message, a full 2,000-layer document on open, is ~20 ms to
decode in the UI — once, off the interaction path. The C++ decoder is
allocation-bound on big documents (every `std::string`), which only matters for
engine-side decoding of documents, which never happens (the engine decodes
commands; it *encodes* documents, 9 ms).

### 9.4 Criteria

| Criterion | Custom (chosen) | FlatBuffers |
|---|---|---|
| Availability | Nothing to install; generator is plain Node. | vcpkg `flatbuffers` 25.12.19 at our baseline (builds `flatc` in 57 s); npm `flatbuffers` **25.9.23** — the runtime lags the compiler, so TS and C++ would run different versions. `flatc` must exist on every dev machine and CI job that regenerates TS, i.e. a native tool in the web toolchain. |
| TS codegen | String-union enums matching today's code, erasable syntax, JS numbers, discriminated unions, one `codecs.X` per type. 10.5k lines codec + 3.4k types for 319 types. | `enum`s (non-erasable), `bigint` for every 64-bit field (flick times would be `bigint`), `string \| Uint8Array` fields, unions as parallel `xType`/`x` fields, one file per type (30 files / 4,027 lines for 24 types — ~4× our per-type size). |
| C++ codegen | Plain structs, `std::variant`, `operator==`, `Status` returns, compiles clean under the repo's `/W4 /WX -Wconversion -Wshadow -Wpedantic`. 17.9k + 4.2k lines for 319 types, one TU. | Object API uses `void*` unions with internal `new`/`delete`, `unique_ptr` per sub-table, no equality by default. Reader API is zero-copy but every access is an accessor call. |
| Schema quirks found | — | A union field `value` silently reserves `value_type`; our `PropertyInfo.valueType` had to be renamed to compile. |
| Evolution | Protobuf rules (§11): add optional fields and new variants; never renumber/retype; unknown fields skipped (tested both languages). | Similar (append-only tables, deprecate), plus struct layouts frozen forever. |
| Verification | Every decode bounds-checks as it goes; truncation at every byte offset is tested. | Separate `Verifier` pass required on untrusted input. |
| Debuggability | `protoc --decode_raw` works on captures; the TS types *are* the JSON log format. | Binary-only without the schema. |

### 9.5 Cross-language proof

- `packages/engine-api/src/roundtrip.test.ts`: for **every** struct and union
  (319 types, 1,258 samples: all-optionals-present, all-absent, one per union
  variant, unicode strings, extreme integers), the generated TS codec must emit
  exactly the bytes of the generator's independent reflective encoder, and
  decode back to an equal value. Plus unknown-field skipping, unknown commands
  (`unknownVariant`), missing required fields, bad enums, every truncation.
- `native/protocol/tests/test_protocol.cpp`: every one of those 1,258 encodings
  (`generated/fixtures.inc`) decodes with the C++ codec and re-encodes to the
  identical bytes (2,536 checks), a C++-built `setProperty` request encodes to
  the pinned TypeScript bytes
  (`1a460807…4a0052000`), and the same failure modes return the right `Status`.

---

## 10. Errors

A request either fully applies or changes nothing. The `Response.outcome` is a
typed `EngineError { code, message, commandIndex?, layer?, path?, item?, detail? }`
with `code` one of: `internal`, `invalidArgument`, `notFound`, `typeMismatch`,
`outOfRange`, `locked`, `cycle`, `notAnimatable`, `animated`, `conflict`,
`unsupported`, `gestureOpen`, `noGesture`, `busy`, `io`, `decode`,
`permissionDenied`, `expressionError`, `nothingToUndo`, `nothingToRedo`,
`cancelled`. `commandIndex` identifies the failing command of a batch;
`detail` is machine-readable JSON (e.g. the expected `ValueType`).

Rendering failures are **not** request errors: a bad layer/effect/plugin/decode
is isolated and reported through `layerErrors` (CLAUDE.md reliability rule).
`engineError` reports engine-side faults not tied to a request; `fatal: true`
precedes a restart (C2), after which the UI receives `documentReset{engineRestarted}`.

A request with `baseRevision` set is rejected with `conflict` if the document
moved on — for scripts and AI tools that read, think, then write.

---

## 11. Versioning and compatibility

- `version major.minor` in the schema; `Hello`/`Welcome` exchange it first.
  **Major** must match exactly or the engine answers `Goodbye{versionMismatch}`.
  A newer **minor** on either side is fine: each side sends only what the lower
  minor knows (the other side's minor is in the handshake).
- Minor-compatible changes: new commands/queries/events/variants (new ids), new
  **optional** fields, new enum members (a peer that does not know one rejects
  that one message with `decode`/`badEnum` — which the minor negotiation avoids).
- Major changes: removing or renumbering anything, changing a field's type,
  making an optional field required, changing a command's semantics.
- Field numbers and command/query/event ids are forever; removed ones are left
  as gaps (never reused). Id ranges: commands 1–99 session, 50–199 items/comps/
  render queue, 200–399 layers and time, 400–699 properties/keys/groups,
  700–849 markers/transport, 850–899 jobs/plugins; queries 1000–1199; events
  2000–2199 (2100–2199 reserved for frames).
- The project **file** format is not this protocol: documents keep their own
  version and migrations (plan §0).

---

## 12. Automation: one API for UI, AI, scripts, plugins

- **AI tools** (65 today, `packages/ai-tools`): each write tool becomes a
  function from its parameters to a command batch (`create_layer` →
  `createLayer` + `addEffect`…, `set_keyframes` → `addKeyframes`,
  `update_layer` → `setProperties`); read tools become queries. The agent run's
  single undo entry becomes a gesture (`beginGesture('AI: …')` … `endGesture`),
  `origin: ai`. The alias-handle resolution in `packages/ai-tools/src/registry.ts`
  maps onto command results (`LayerRef`).
- **Plugins**: the 20 mutating host methods and `scene.apply`'s 12 batch ops map
  1:1 onto commands (`scene.createLayer` → `createLayer`, `effects.setParam` →
  `setProperty`, `animation.setKeyframes` → `addKeyframes`, …) sent with
  `origin: plugin`; the host keeps its permission table and label prefix. The
  native SDK gains the same commands in G1.
- **Scripts / CLI**: a script is a client that speaks the protocol (Node over
  the same pipe, or a JSON-lines front end): the command log format *is* the
  script format.
- **Command logs and replay (B5, plan §6)**: `LogRecord { request,
  revisionAfter, documentHash }` per applied request, retrievable with
  `getCommandLog`. Replaying the requests against a fresh engine (either
  implementation) must reproduce the revisions and document hashes — the phase
  B–F safety net. Transport and viewport controls are logged too (so a replay
  can reproduce frames), but never change the hash.

---

## 13. Frames

Frames reach the viewport by the route phase C1 chooses (frames copied into the
page, a native child window, or a shared GPU texture — measured, not assumed).
The schema reserves event ids 2100–2199 for that route's messages
(frame-ready notifications carrying viewport id, comp, time, revision, size and
a handle). `setViewport` already carries everything a route needs to know about
the target. Frames are never sent as ordinary events.

---

## 14. Gaps

### 14.1 Against After Effects (what the API covers that neither engine does yet, and what neither covers)

Covered by the schema, **not implemented in today's TS engine** (B2 must return
`unsupported` or implement):

- Stable keyframe ids; keyframe colour labels.
- Rational frame rates and flick time (TS: float seconds + integer frames).
- OCIO / working space / linear blending / 32-bit float (`ProjectSettings`); the
  TS GPU path is half-float, CPU effects are 8-bit.
- Variable-width mask feather (`BezierPath.featherPoints`).
- Marker chapter / URL / cue point / protected region; layer comments; item
  comments.
- Undoable composition settings, work area, footage interpretation, render queue.
- Plugin data stored in the document; plugin effect action buttons as one entry.
- Matte by reference to any layer (check against `setNodeMatte`); preserve
  frame rate / resolution for nested comps; 3D renderer choice beyond classic.
- Jobs as an engine concept (tracking, stabilize, object matte, transcription run
  UI-side today).

Not in the schema (AE has it; out of B1 scope, listed so nobody assumes it):

- Per-dimension temporal ease (speed + influence per dimension) and separate
  incoming/outgoing interpolation types per keyframe — the API carries
  `motion_eval`'s segment model; AE's model maps onto it for 1-D and combined
  properties but not for per-dimension influence on unseparated vectors.
- Essential Graphics / Master Properties / Motion Graphics Templates, responsive
  design (time) beyond protected-region flags.
- JavaScript expression engine parity (the enum reserves `javascript`; only the
  hand-written language exists).
- Content-Aware Fill, Roto Brush 2 refinement, 3D Camera Tracker, Warp
  Stabilizer's shape-based modes, Mocha-style planar tracking (the `planar`
  track kind is reserved).
- Multiple output modules per render item, post-render actions.
- Data-driven animation (JSON/CSV data layers), team projects, ExtendScript
  compatibility, ScriptUI.
- Proxy *generation* (pre-render exists as a job; automatic proxy workflows do not).
- Layer panel view options beyond effects on/off (e.g. per-mask render toggles).

### 14.2 Escape hatches (untyped JSON today)

`Value.json`, `CompSettings.world` (environment preset, ground level, sky,
SSAO), `RenderSettings.encoderOptions`, `DocumentFragment.data`,
`EngineError.detail`, `invokeEffectAction.payload`. Properties that will use
`Value.json` until typed: particle emitter settings, puppet rig settings
(mesh, solver), skeleton rigs, path-operator configs, text-on-path options,
layer-style arrays, face materials, plugin custom-layer params. Each should
become a typed `Value` variant or a property subtree before D1; a test can
list the remaining uses from the property catalog.

### 14.3 Decisions this document makes (flag for review)

- Guides, grids and swatches stay editor state (they are saved in the document
  today); AE saves guides per comp — revisit if users expect them to travel with
  projects.
- Shy is document state (AE semantics), fixing §2.5 #1.
- A layer is its timeline bar; legacy multi-bar nodes split on migration.
- No time-based coalescing: the 700 ms debounce is removed, not moved (§5.3). Each keyboard nudge is its own entry, as in AE.

---

## 15. B2 implementation notes — the TypeScript engine behind the API

B2 (2026-09-23) implements every command, query and event on today's engine:
`src/core/engine/LocalEngine.ts`, an `EngineClient` (`packages/engine-api/src/client.ts`).

### 15.1 Coverage

| Family | State |
|---|---|
| 91 edit commands | All dispatched. **86** implemented with exact inverses. **5** answer a typed error and change nothing: `convertLayer`, `separateLayer`, `autoTrace` (need font outlines / rendered pixels the TS engine only has inside editor dialogs — E3/D2), `invokeEffectAction` (native-SDK plugins, G1; JS plugins are not ported, plan §5 G2), `applyJobResult` (`notFound`: no engine jobs yet). Partial: `importProject` takes `.motion` only; `setInterpretation` refuses ignore/invert alpha, matte colour, start timecode and colour profile; `setCompositionSettings` refuses `backgroundGradient` and maps `motionBlur` onto the project-wide store (the TS engine has one); `setBlendMode` refuses the modes the TS renderer lacks; `setProxy` is footage-only; `reorderLayers`/`groupLayers` need one parent (parenting is nesting, below). |
| 30 controls + io | All implemented. `openProject`/`saveProject`/`revertProject`/`collectFiles`/`importFiles` go through injected `EnginePorts` (`unsupported` when none is attached — B3 attaches the Electron ones). `startJob` answers `unsupported` (jobs run in the editor until E/F). Transport forwards to today's controller for the ACTIVE comp and keeps the rest as engine state; viewport/cache/preview controls are recorded state (the TS renderer still draws the viewport). |
| 32 queries | 26 answered from the document. `getWaveform`, `getThumbnail`, `hitTest`, `getLayerBounds`, `getTextLayout`, `readPixels` answer `unsupported` (renderer-side until D2/E2); `getRenderStats`/`getLayerErrors`/`getJobs` answer empty (the editor's renderer owns those numbers today). |
| 27 events | All 13 revisioned events emitted from the changed parts; ephemeral `historyChanged`, `dirtyChanged`, `transportChanged`, `playhead`, `projectSaved` emitted; the render/job/asset/font/autosave ones have no TS source yet. |

### 15.2 Undo: parts

The document is addressed as PARTS (`src/core/engine/state.ts`): `node:<id>` (the saved row),
`anim:<id>` (tracks, expressions, data tracks), `clips:<comp>` (bar geometry), `tl:<comp>`
(rate, duration, ranges, composition and layer markers, bar order), `comp:<id>`, `order` (node
insertion order = saved order and comp order), `items`, `project`, `rq`, `mb`, `cm`. A handler
validates, then declares the parts it may touch; the engine captures them before and after
`apply`, and the CHANGED parts are the entry's inverse (befores) and redo (afters) — recorded
at apply time, restored in dependency order, so ids come back exactly and undo never
re-derives anything. Commands with an unbounded footprint (delete, split, precompose, ripple…)
use document scope: the structurally shared capture (`captureSharedState`), so unchanged nodes
cost an identity check. Tests run with `verifyScopes`, which fails any command that changed a
part outside its declared scope.

- One history: entries are `EngineHistoryEntry`s on the app's `HistoryService` (the T1 unified
  stack), so the app's Ctrl+Z, the History panel and the `undo`/`redo` commands walk one list.
- A gesture accumulates first-seen befores and last-seen afters per part: "first inverse, last
  value" for coalescable drags, one entry for everything else in it; `endGesture{commit:false}`
  applies the befores as a new revision. A batch is one entry; a failure at k restores every
  before and reports `commandIndex`.
- A failed command changes nothing: validation throws before `apply`; an exception inside
  `apply` restores the captured befores.
- Stable keyframe ids: `Keyframe.id` / `DataKeyframe.id` (`k<n>`), carried by every mutator,
  minted by the engine, stamped on any id-less key a command's scope touches (the pre-API
  helpers still create id-less keys), assigned to every key of an opened file by the 1.9.0
  migration. Keys never stamped are addressed by the positional fallback `@layer|track|t`.
  Mask-shape keys are `<entry>@<maskId>`. Copies (duplicate, split, paste) re-mint.
- Every id the engine creates is deterministic (`src/core/engine/ids.ts`), so replay reproduces
  them.
- Parenting is nesting in the TS scene graph: a comp's stack is the depth-first, front-first
  walk; `reorderLayers`/`groupLayers` move siblings of one parent.

### 15.3 Coexistence until B3, and what B3 deletes

While the UI still writes directly (≈ 900 call sites, §2.4), the engine and the old recorders
share one stack safely:

1. Every engine edit calls `historyStore.flush()` first (a pending debounced UI edit gets its own
   entry, in order), runs with `restoring: true` (the 700 ms recorder does not capture what the
   engine writes) and `HistoryService.suspend()` (nothing a helper pushes lands beside the
   engine's entry), and re-baselines the recorder afterwards (`runRestoring(() => {})`).
2. Undoing a NON-engine entry (debounce snapshot, timeline command, `runAnimEdit`) through the
   engine answers with `documentReset{resync}`; so does any document change made outside the
   engine (`SceneGraphChanged`/`NodeUpdated`/`AnimationChanged`/`DocumentChanged` while the
   engine is idle).
3. Timelines are built for every composition before a command runs (they are a lazy mirror;
   built inside a command they would be captured as created by it).

B3 must delete or change (call-site counts from §2):

- `historyStore`'s debounce recorder: `attachHistoryRecording`, `schedule`, `RECORD_DEBOUNCE_MS`,
  `batchHistory` (22 sites), `record` (9), `flush` (12), `runRestoring` (12), `baselineHistory`;
  the engine's flush/runRestoring calls in `LocalEngine.runEdits`, `pushEntry`, `endGesture`,
  `historyStep` and `clearHistoryStacks` go with it.
- `runAnimEdit` / `beginAnimEdit` / `recordAnimEdit` (208 / 14 / 11 production sites; 118 / 12 / 8
  in UI) → commands, batches, gestures; `runDocumentEdit` (75), `runAsOneHistoryEntry[Sync]`
  (13 + 1) and `StoreSnapshotCommand` → batches.
- The timeline engine's own history hook (`TimelineCommandAdapter`, `onPush`/`onBeforeRun` in
  `TimelineController.initTimeline`) and the 144 UI controller calls → layer-time commands.
- Direct SceneGraph writes from the UI (≈ 365), `updateNodeComponentProp` / `useNodeComponentProp`
  (19 + 102), scene helper modules (190), effects (28), masks (24), text (25), layer styles (80),
  material/3D (34), paint/puppet/skeleton/tracker (≈ 62), compositions (≈ 28), assets (≈ 25) →
  commands; lint then forbids the imports (plan B3 exit).
- The positional keyframe id codec (`makeKeyframeId`/`parseKeyframeId`, `POSITION_PSEUDO_PROP`)
  in the timeline and graph editor → API keyframe ids; the engine's positional fallback and
  `stampMissingKeyIds` then go too.
- `compToKeyframeTime` at the 64 UI sites → API comp-time flicks.
- The external-change detector (`LocalEngine.attachBus`) once nothing writes around the engine.
- Attach real `EnginePorts` (project read/write through `ProjectManager`, media import through
  the asset store's `addAsset`, collect files).

### 15.4 Known limits left for later phases

- The inverse restores PARTS, not command-specific inverses; the C++ engine (D1/F2) records
  whatever inverse it likes — replay (§12) of the same log is the parity check.
- Keyframe times go through `compToKeyframeTime`/`keyframeToCompTime`, which are
  frame-quantized inside a clip: API times are exact at frame boundaries only in the TS engine.
- Source Text writes carry plain text; style runs through the API arrive with B3.
- `AnimationEngine.clear`/`clearNode` still do not notify (§2.5 #11, not on an API path).
- The codec's `encode` returns a view of a SHARED writer and `decode` returns `bytes` fields as
  views of its input: a caller that decodes `encode()`'s output must copy it first (the wire
  test mode does).

---

## 16. Files

| Path | What |
|---|---|
| `packages/engine-api/schema/*.eapi` | The schema (read in file-name order). |
| `packages/engine-api/codegen/generate.cjs` | Parser, validator, TS + C++ generators, reflective encoder, sampler. `npm run engine-api:gen` / `engine-api:check`. |
| `packages/engine-api/src/generated/{types,codec,meta}.ts` | Generated TS (do not edit). |
| `packages/engine-api/src/{wire,time,propPath,index}.ts` | Hand-written TS runtime and helpers. |
| `packages/engine-api/src/client.ts` | `EngineClient` (the transport-agnostic contract) + `EngineClientBase` helpers. |
| `src/core/engine/LocalEngine.ts` | The TypeScript engine behind the API (B2): requests, history entries, gestures, events, log. |
| `src/core/engine/state.ts` | Parts: capture, diff, restore — the inverse machinery (§15.2). |
| `src/core/engine/props.ts` | Property catalog: API paths ⇄ today's storage; keyframe read/write. |
| `src/core/engine/handlers/*.ts` | One handler per edit command, by family. |
| `src/core/engine/{queries,events,model,transport,keyIndex,ids,replay,canonical}.ts` | Queries, event building, read model, transport, keyframe id index, deterministic ids, replay, canonical document. |
| `src/core/engine/__tests__/` | Per-command undo parity, controls, events + mirror, queries, defects, replay corpus. |
| `packages/engine-api/src/*.test.ts` | Round trips for every type, staleness, doc coverage. |
| `packages/engine-api/bench/` | `npm run engine-api:bench` (set `ENGINE_API_BENCH_EXTRA` to an adapter module to add a comparator). |
| `packages/engine-api/bench/flatbuffers-eval/` | The FlatBuffers twin used in §9.3 (`bench.fbs`, the C++ bench). The TS side was an esbuild-bundled adapter mapping the plain payloads onto flatc's `*T` object-API classes, passed via `ENGINE_API_BENCH_EXTRA`; flatc came from vcpkg at the repo baseline. Not built by anything. |
| `native/protocol/include/premation/protocol/wire.hpp` | Hand-written C++ runtime. |
| `native/protocol/generated/{engine_api.hpp,engine_api.cpp,fixtures.inc}` | Generated C++ (do not edit). |
| `native/protocol/{CMakeLists.txt,CMakePresets.json,build.mjs}` | Separate CMake project (no vcpkg packages); `npm run protocol:build` configures, builds, tests; `--bench` runs the codec benchmark. |
| `native/protocol/tests/test_protocol.cpp`, `bench/bench_protocol.cpp` | C++ round trip of every fixture; C++ benchmark. |
