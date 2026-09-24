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

Schema size today: **123 commands** (93 document edits, 25 controls, 5 project
I/O — B1 miscounted; corrected in B2 from the meta table; G1 added
`addProperties` / `removeProperties`), **32 queries**, **27 events** (13 revisioned, 14 ephemeral), 350 structs,
11 unions, 69 enums — `SCHEMA_COUNTS` in `generated/meta.ts` (C3 added the five
frame-channel messages, their union and `PixelFormat`, §13; D2 added the
`Render` family, `96_render.eapi` — the serialized FrameScene the C++ render
graph consumes, a file format and in-process value, never a pipe message).

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
| Mask | `masks/<maskId>/path`, `…/feather`, `…/opacity`, `…/expansion`, `…/mode`, `…/inverted`, `…/rotoBezier` (§15.10) | path: whole-mask snapshots in `fx.maskAnim` (not a track); others `mask.<pathId>.<prop>` |
| Source text | `text/sourceText` (`textDocument` Value) | data track `text.source` + `Text.content`/`__runs` |
| Text animator | `text/animators/<animatorId>/props/<prop>`, selector `text/animators/<animatorId>/selectors/<selectorId>/<param>` | `ta.<i>.<param>`, `ta.<i>.s<j>.<param>` |
| Font axis | `text/axes/<tag>` — every axis, `wght` / `wdth` / `slnt` included (G1: one path each; their static value is the Text component's `fontWeight` — number or CSS weight string — / `fontWidth` / `fontSlant`) | `text.axis.<tag>`; `fontWeight`, `fontWidth`, `fontSlant` |
| Text fields (G1, static) | `text/<key>` for the Text component's Character / Paragraph / box / More Options / OpenType fields (`fontFamily`, `fontStyle`, `stroke`, `strokeOrder`, `align`, `direction`, `orientation`, `boxWidth`, `anchorGrouping`, `ligatures`, `stylisticSets`, `strokePaint`… — `src/core/text/textFields.ts` TEXT_FIELDS); `text/styleRuns` (json, the per-character style runs); `text/pathOptions/path` (string: one of the layer's mask ids, `''` = not on a path) and `text/pathOptions/<param>` | Text component props; `__runs`; `fx.textPath` (`textPath.<param>`) |
| Text animator / selector fields (G1, static) | `text/animators/<a>/props/trackingType`, `…/characterRange` (choices), `…/color`, `…/strokeColor` (optional colours, see `addProperties`), `…/blurY` (always present: unset = linked to Blur X); `text/animators/<a>/selectors/<s>/kind` (switched in place, id kept), `basedOn`, `mode`, `units`, `shape`, `randomizeOrder`, `lockDimensions`, `randomSeed`, `expression` (per kind) | animator / selector objects in `Text.__animators` |
| Layer fill (G1) | `layer/fill` (colour, keyed through `fill_r/_g/_b/_a`: AE's Solid Color / Fill Color — present while the fill is solid); `layer/fillPaint`, `layer/fills` (json paint objects: the primary paint, the stack); `layer/width` / `layer/height` on text layers (the wrap box) | `fx.fill` solid paint, else the `fill` string on Style / Text; `fx.fills` |
| Shape contents | `contents/<groupId>/…/<param>` | `pathop.<opId>.<param>`, `fx.fill(s)`, `fx.stroke(s)` |
| Shape outline (§15.10) | `layer/path.points` (path value), `layer/pathRotoBezier`, `layer/pointBindings` | `Geometry.points` / `open` + the `path.points` data track; `Geometry.rotoBezier`, `Geometry.pointBindings` |
| 3D material / geometry | `material/<param>`, `geometry/<param>` | bare names (`metal`, `extrusionDepth`, …) |
| Camera / light | `camera/<param>`, `light/<param>` | flat transform props |
| Paint stroke | `paint/<strokeId>/<param>`, `paint/<strokeId>/path`; the stroke itself (points, pen input, switches) and the layer's Paint on Transparent through the paint-stroke commands (§4.7, ids 615–620) | `paint.<strokeId>.*`, `fx.paint` |
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
closed, per-vertex feather, per-vertex editing state), `gradient`, `textDocument` (text + style runs +
paragraphs + box + orientation), `layer`/`item` references, `scalars` (numeric
list), and `json` — an explicit **escape hatch** for structured values not yet
typed (§14.2 lists every use). The engine type-checks every write against the
property's `ValueType`.

**Units (decided in C3, enforced on both engines).** Every numeric value that
crosses the API — `setProperty`/`setProperties` values, keyframe values,
`getPropertyValues`, `getPropertyTree` values and defaults, `sampleProperty`,
change events — is in **After Effects units**: pixels for position, anchor and
sizes; **percent** for `transform/scale` (100 = identity) and
`transform/opacity` (0–100); **degrees** for every rotation and orientation;
colours are straight RGBA 0–1. The TypeScript engine stores scale as a
multiplier and converts at its seam (`props.ts` `apiUnitFactor` /
`toApiNums` / `fromApiNums`); opacity and rotation it already stores in these
units. The C++ engine stores the AE unit directly. `PropertyInfo.unit` says
`%` for scale.

**Layer space is centre-origin** (the spec was silent; C3 chose): a layer's
`transform/anchorPoint` (0, 0) is the middle of its box, and a new layer's
anchor is (0, 0) whatever its size. This is the TypeScript engine's storage,
its file format and the `.aep` importer's target (`anchorX = aeAnchor −
width/2`); After Effects measures from the top-left, which a UI can show by
adding size/2 — a display convention, not a document one. The C++ engine
moved to it in C3 (it had AE's top-left). `getLayerTransforms` matrices map
this centre-origin layer space to comp pixels. Position is where the anchor
lands in the comp in both.

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
| `addHistoryCheckpoint` | control | B3z — History ▸ Snapshot: a NAMED entry that changes nothing, a point to jump back to. Clears redo like any entry; `gestureOpen` while a gesture is open. |
| `restoreDocument` | edit | B3z — replace the whole document with a saved / cloud version (`.motion` JSON) as ONE undoable entry; history is kept, undo brings the document back exactly. Unreadable input is `decode` / `unsupported` and changes nothing. |
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
| `importBytes` | B3 — import from bytes (a browser-picked / dropped file, a bundled sound, a generated image): the media port stores the bytes and returns the record. Inverse: remove the items (stored bytes untouched). |
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
| `setCompositionSettings` [c] | Patch name, size, pixel aspect, rate, duration, start timecode, background (colour or gradient), transparency, work area, motion blur (shutter angle/phase, samples, adaptive limit, and — G1 — the comp's Enable Motion Blur switch, `MotionBlurSettings.enabled`), 3D renderer, global light, drop frame, preserve rate/resolution, world settings. Changing rate or duration never moves keyframes (times are flicks). Inverse: previous values of patched fields. **Undoable — today it is not.** |
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
| `setBlendMode`, `setTrackMatte` | Matte by reference to any layer (AE 2023); no `matte.layer` = the classic positional matte (the layer above, B3z). Inverse: previous values. |
| `replaceLayerSource` | Inverse: previous source (and size if changed). |
| `groupLayers` / `ungroupLayer` | Premation group layers. Inverse: ungroup / regroup with the same group id. |
| `convertLayer` | Engine-evaluated conversions: shapes from text, masks from text, shapes from vector, editable text, uncompose, bake transform. Inverse: remove the created layers (and restore the source layer's visibility if the conversion hid it). |
| `pasteLayers` | Paste a `DocumentFragment` (from the `copyLayers` query). `parent` (B3z) pastes INTO a layer of `comp` (the fragment's top-level layers become its children; `index` stays a comp-stack index). The copied stacking is kept (the fragment's first layer is the front-most, per parent). References between pasted layers follow the copies (§15.9 WS-L1). Inverse: delete pasted layers and any items the paste created. |
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
| `rippleDeleteRange` | B3z — delete a comp TIME RANGE and close the gap (transcript editing): layers crossing an edge are split there, the parts inside deleted, later unlocked layers move left by the range's length. Inverse: every split, deleted and shifted layer. |
| `shiftLayerKeyframes` | B3z — move every keyframe a layer owns by a layer-time delta (Stagger / Sequence animation), data tracks included, time remap / speed excluded. Inverse: shift back. |
| `addTransition`, `setTransition` [c], `removeTransitions` | B3z — a transition on the cut between two layers (kind, whole-frame duration, alignment); refused with the frames the handles lack when a source cannot pay for the overlap. Remove puts each cut back exactly as it was before the transition. Inverse: the previous records and everything they materialised. Event: `transitionsChanged`. |
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
| `addProperties` | G1 — AE's Add ▸ Property: OPTIONAL properties that exist only once added, under `parent` (`text/animators/<id>/props`): Anchor Point X/Y/Z (Z only on a 3D layer), Skew Axis, Line Anchor, Character Value, Fill / Stroke Hue·Saturation·Brightness, Stroke Opacity, Fill Color / Stroke Color (`color`, `strokeColor`) and Font Axis properties (`axis<TAG>`, at most 8 distinct tags per layer — `outOfRange`). A property already present keeps its value. Returns the property paths in input order. Inverse: the animator as it was. |
| `removeProperties` | G1 — delete optional properties with their keyframes and expressions (a non-optional property: `invalidArgument`; an absent one: `notFound`). Inverse: the properties, keys and expressions back exactly. |
| `pasteEffects` | B3z — Edit ▸ Paste of copied effects from a captured snapshot (the source may since have changed or gone), and applying a saved effect preset, onto several layers at a stack index. Returns the new groups. Inverse: remove them. |
| `removeStroke` | B3z — delete Contents ▸ Stroke N of a shape's stroke stack with its tracks and expressions; the strokes above move down one index with their tracks. Inverse: the stack and tracks exactly. |
| `addPaintStroke` | B3 — append one PAINT stroke (Effects ▸ Paint ▸ Brush N; `fx.paint`) from a JSON object without an id (the engine mints `pstroke_<n>`), renormalised (`normalizeStroke`); `points` must be a non-empty array of finite {x, y}. `keys` key the new stroke's numeric params (Write On's End, in %) at LAYER seconds, the axis of its `inPoint`/`outPoint`. Returns the id. Inverse: the paint and tracks as they were. |
| `updatePaintStroke` [c] | B3 — merge a JSON patch into one stroke and renormalise; a member set to null clears that key; `id` cannot be patched. The video switch (`visible`), Shift-continue (joined points + pen arrays). Inverse: the stroke as it was. |
| `removePaintStrokes` | B3 — delete strokes with every track, expression and data track under `paint.<id>.` (Paint panel ▸ delete, Tool Options ▸ Undo last stroke). Inverse: strokes and tracks exactly. |
| `setPaintOnTransparent` | B3 — AE Paint on Transparent on layers that have strokes (else `notFound`). Inverse: the previous flag. |
| `setPaintStrokePath` | B3 — drawing with a stroke selected: with the Path animated, a Path key at `time`; else the static points, the old per-point pen input dropped. Inverse: the stroke / track as they were. |
| `setPaintPathAnimated` | B3 — the Path stopwatch: ON keys the current points at `time` (already animated: no change); OFF removes the Path keys, keeping the static points. Inverse: the track as it was. |
| `editPathTopology` | B3 — a STRUCTURAL edit of an outline (`masks/<id>/path`, a shape's `layer/path.points`) in EVERY state, static + each key: split a segment, remove vertices, Set First Vertex, Reverse Path Direction, Continue Path (`op`), and/or the Closed switch (`closed`). States the op does not apply to are left alone; none at all = `invalidArgument`. Key ids/times/easing kept (§15.10). Inverse: every state exactly. |
| `setShapeOutline` | B3 — the Knife: a shape layer's outline becomes independent runs (`Geometry.subpaths`), the single-run outline cleared, shape type `path`. Not a shape: `invalidArgument`; animated outline: `animated`. Inverse: the outline exactly. |

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
| `listPlugins`, `getEffectUi` | G1: the native SDK plugins the engine found (loaded / disabled / failed with why / quarantined after ending the engine); a plugin effect's parameter UI at a time (UPDATE_PARAMS_UI: enabled, hidden, renamed). The TypeScript engine hosts no native plugins (empty list; builtin effects answer every param enabled). |
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
compute.

**Replay-parity rules (C3; both engines enforce them, `crossEngine.test.ts` checks them):**

1. **One revision per request.** A single edit, a batch of N commands, one undo,
   one redo, an `endGesture{commit:false}` that reverts, and a
   `jumpToHistory` over any number of entries each move the revision by
   exactly one (zero when nothing changed). Each `setProperty` inside a gesture
   is its own request, so its own revision; `endGesture{commit:true}` moves
   none. (The TS engine used to bump once per step of a jump; fixed in C3.)
2. **One `EventBatch` per request**, carrying the change AND the status events
   it caused (`historyChanged`, `dirtyChanged`, `transportChanged`,
   `playhead` of a seek), `causedBy` = the request's `seq`. Batches the engine
   sends on its own (playback ticks, stats, a job) have no `causedBy` and
   `origin: engine`. (The TS engine used to send the status events in a second
   batch, and the C++ engine sent a seek's playhead without `causedBy`; both
   fixed in C3.)
3. **Events before the response.** The batch reaches the client before the
   response to the same request, so when a caller's `await` resumes the mirror
   already shows the change. A client must still not rely on it across an IPC
   hop: `ProcessEngineClient` keeps the mirror's revision (`eventRevision`)
   apart from the newest revision a response reported.
4. **Kinds may differ, facts may not.** Upserts are full records, so an engine
   may report more than changed (the TS engine sends `compositionChanged` with
   every new layer and `layersChanged` with property edits; the C++ engine
   sends `propertiesChanged` with keyframe edits). The rule is that a mirror
   fed only by one engine's events equals that engine's queries — checked per
   engine by the cross-engine test.

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
| `transitionsChanged` | Every transition of one composition (full replacement), after a transition command or its undo. |
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

Frames reach the viewport by the route phase C1 chose: **shared GPU textures**
(docs/VIEWPORT_ROUTE.md). `setViewport` carries everything the route needs to
know about the target (CSS size × devicePixelRatio). Frames are never sent as
ordinary events.

The frame route has its own message family, **`FrameChannel`**
(`schema/95_frames.eapi`, C3), on its own pipe pair (engine fd 3 → host, host →
engine fd 4), framed like the command pipe:

| Message | Direction | Meaning |
|---|---|---|
| `FrameSlots` | engine → host | A ring of N shared textures (generation, viewport, size, format, NT handles valid in the host). Retires every older generation. |
| `FrameReady` | engine → host | Slot N holds a finished frame (frame, comp time, the revision it shows, size, frames dropped since the last one, render timestamps for measurement). |
| `FrameRelease` | host → engine | Chromium is done with a slot (a stale generation is ignored). |
| `FramePing` / `FramePong` | host ⇄ engine | The supervisor's heartbeat, answered by the engine's document core thread. |

They are generated like everything else: C++ `api::FrameChannelMessage`, and —
because Electron main cannot import packages/ — a standalone TypeScript module
`electron/generated/frameChannel.ts` (+ a copy of the wire runtime), emitted by
the same generator for exactly this family. The event ids 2100–2199 stay
reserved and unused.

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
layer-style arrays, face materials, plugin custom-layer params. G1 added four
json FIELDS (static properties, `animatable: false`): `text/styleRuns` (the
per-character style runs, grapheme-indexed; a static Source Text change drops
them, a client that keeps them re-sends them after it), `layer/fillPaint` and
`layer/fills` (fill paint objects: `{type: solid | linear | radial, …}`) and
`text/strokePaint` (a text layer's gradient stroke). Each should
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
  the asset store's `addAsset`, collect files). **Done in B3-0** (`src/core/engine/appPorts.ts`).

**B3-0 (2026-09-23)** landed the foundation the area migrations use: one app engine booted in
`Providers` and rebuilt on `ProjectLoaded`/`ProjectUnloaded` (`engineInstance.ts`: `engine()`,
`subscribeEngine`), `edit`/`GestureSession` (`uiEdits.ts`) and `useGesture` (`src/hooks`),
property-path helpers (`propRefs.ts`), a legacy UI refresh so today's panels redraw after engine
edits (`legacyRefresh.ts`, removed by B4), and the per-area ratchet
(`npm run lint:engine-writes`, `src/__tests__/engineWriteRatchet.test.ts`). Conversion guide with
before/after code: **docs/B3_PATTERNS.md**.

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

### 15.5 C3 — the C++ engine as a second backend

`ProcessEngineClient` (`packages/engine-api/src/process.ts`) is the
`EngineClient` over the preload's `motionEditor.engine` bridge → Electron main
(`electron/engineHost.ts`, `EngineSupervisor`) → `premation-engine`. It is
selected by `PREMATION_ENGINE=process` (or `{ "backend": "process" }` in
`<userData>/engine.json`); default OFF. It applies the §8.2 revision rule,
records the §12 command log, replays it into a restarted engine before any new
request (ids are deterministic, so the same requests mint the same ids), and on
the supervisor's `fallback` switches to the TypeScript engine with one notice.

**The cross-engine replay** (`src/core/engine/__tests__/crossEngine.test.ts`)
records every corpus session on the TS engine and replays the log in lockstep
into a fresh TS engine and the real C++ engine (`--no-gpu`), translating ids
(`IdMap`). Per request: same outcome, same revision delta, ≤ 1 batch each, a
batch whenever the revision moved; at the end, per engine, an event-fed mirror
equals that engine's queries, and the two documents agree on stack order,
names and the five transform properties (values at 4 times + keyframes).
Commands the C++ engine answers `unsupported` are skipped and counted; so are
later requests that reference what only the TS engine created (dependents), and
undo/redo over TS-only history entries (the history is modelled so the rest
stays comparable). Result 2026-09-23: **9/9 sessions pass, 0 mismatches**; the
native-subset session compares **41/41** requests (0 unsupported, 0 dependent;
56 final values and 3 keyframes equal, both event mirrors exact). Across the
eight B2 sessions (265 records): 79 compared, 74 unsupported (25 command types —
items, folders, effects, markers, work area, parenting, most layer-time and
keyframe-retiming commands, non-solid layer kinds), 98 dependent, 14 TS-only
history moves. Catalog gap found: TS null layers have no `transform/opacity`
(AE nulls do; the C++ engine has it) — reported, not failed.

**Real app** (Electron 44, RTX 4060, `PREMATION_ENGINE=process`): the engine
starts on Chromium's GPU (vendor 0x10DE); layers created through the process
client render in the engine surface; a 41-message opacity drag is one undo
entry (`setProperty` RTT p50 1.0–1.2 ms, p95 1.6–1.8 ms through IPC), undo/redo
exact; playback 29.8–30.0 fps drawn for a 30 fps comp, engine render-done →
drawn p50 1.3–1.5 ms; killing `premation-engine.exe` → a new process, 55
requests replayed in 29 ms, 0 mismatches, document snapshot identical; three
kills inside 60 s → one fallback notice and the next `createLayer` lands on the
TypeScript engine.

Limits (for D): the command log lives in the page, so a page reload loses it
(the client reconnects and resyncs, but a crash after that cannot restore the
earlier work) — the log should move to main, which owns the engine; on fallback
the C++ document is not migrated into the TS one (`IdMap` can translate; the
units and ids now agree); frame forwarding holds one transfer in flight and
drops the rest (main dropped ~28 % of 60 Hz announcements at a 30 fps comp
while idle frames re-rendered); the engine surface keeps its last frame after
a fallback.

### 15.6 B5 — AI tools, scripts and command logs on the API

**AI tools.** The `ToolContext` facades (`packages/ai-tools/src/types.ts`) are async
and speak composition time; the context carries the turn's `AiEngineSession`
(`apply(commands)`, `query(q)`, `legacy(gap)`). An AI turn is ONE gesture labelled
after the turn, origin `ai` (`src/core/ai/aiTransaction.ts`): the whole turn is one
undo entry and one replayable span of the command log; rollback is
`endGesture{commit:false}`. The host facades (`src/core/ai/toolContext.ts`) send
engine commands where the API expresses the tool's write EXACTLY and fall back to the
pre-engine writer otherwise, naming the gap (`LEGACY_GAPS`); an engine refusal also
falls back (nothing changed). A turn with any gap — or any write the engine saw
around it (`documentReset{resync}`) — commits as one whole-document snapshot entry
instead (still one undo step, not replayable). `runToolTurn(label, calls)` runs tool
calls as a turn without a model.

**Command logs.** `src/core/automation/commandLog.ts`: `await recordSession()` → `stop()`
returns JSON lines (the engine's own log + `gestureSeq` in the header);
`replaySession(log)` rebuilds the app engine and replays; `writesAroundEngine` says
whether the recording is exact. The app records when `setCommandLogRecording(true)`
(development builds, `VITE_RECORD_COMMAND_LOG=1`). `premation render … --commands
<log.jsonl>` replays a log before rendering. Dev handle: `window.__premationAutomation`.

**Scripts.** `src/core/scripting/`: `runScript(source, {consent})` runs the source in a
dedicated Worker (no DOM, storage or network) with one global, `premation`
(`execute`/`batch`/`query`/`onEvents`/`log`). Permissions `document.read` /
`document.write` are declared in a `// @permissions` header and granted per run;
control and io commands are never available. One run = one gesture `Script: <name>`,
origin `script`; a throw, a timeout or a crash rolls it back.

Gaps B5 found on the engine side were closed in G2 (§15.8): gesture ids are in the
id counters, the app's undo/redo/jump send engine requests, and `applyPreset`
converts to the layer's keyframe axis.

### 15.7 G1 — static fields, optional properties and the data-model gaps

**Fields.** Everything a layer stores outside its keyframe tracks that the UI
edits — a Text component's strings / choices / switches / box numbers, a text
animator's Tracking Type and Character Range, a selector's kind / Based On /
Mode / Units / Shape / Randomize Order / Lock Dimensions / Random Seed /
expression, Path Options ▸ Path, style runs, fill paints — is a property of the
catalog with `special: 'field'` (`src/core/engine/fields.ts`, C++
`native/engine/src/core/fields.cpp`), typed by one spec table both engines read
(`src/core/text/textFields.ts`, generated into the C++ catalog data by
`GEN_NATIVE_CATALOG=1 npx jest crossEngineCatalog`). `setProperty` /
`setProperties` / `resetProperty` type-check a field against its spec
(`typeMismatch`, a choice outside the list `outOfRange`, a number outside
min..max `outOfRange`); `setAnimated` / keys / expressions refuse it
(`notAnimatable`) — AE keys these through the TextDocument, not one by one.
Clear-at-default fields (OpenType switches, Tracking Type, Character Range)
store nothing at their default, the shape the editor always wrote. A
`strokeOrder` write keeps the legacy `strokeOverFill` boolean in step. A
selector kind switched in place keeps the selector's id, Based On, Mode and
enable, and drops the keyframes/expressions of the parameters the new kind
does not have.

**The other G1 model changes.** The first static write of an unstored text
property (Grouping Alignment, Font Width, a string-stored weight) lands on the
Text component, never the Transform (both engines' static seam). `wght` /
`wdth` / `slnt` are `text/axes/<tag>` like every other axis (static value read
from `fontWeight` — a number, a decimal string, `normal` or `bold` — /
`fontWidth` / `fontSlant`; a write stores a number). An animator's Blur Y is
always addressable (unset = linked, reads as Blur X). Path Options' params
moved to `text/pathOptions/<param>` beside `text/pathOptions/path`. A layer's
solid fill colour is `layer/fill` (keyed through `fill_r/_g/_b/_a`, written to
the solid `fx.fill` paint when there is one, else the `fill` string). The
comp's motion-blur switch is `MotionBlurSettings.enabled`.

**Commands.** `addProperties` / `removeProperties` (§4.7) — AE's Add ▸
Property and deleting a property, for text animators (the only optional
properties the model has today).

**UI and AI.** `fieldCommands(nodeId, path, raw)` (layout/Text/textEdits.ts)
and `fieldWrite` / `fieldBindingForComponentProp` (core/engine/propRefs.ts)
turn what a panel holds into field writes; `useComponentProp` sends a Text
component's fields and a layer's fill colour through them, so every
`useComponentProp` row of the Character / Paragraph panels is on the engine.
Style runs are a client macro: the panel computes the runs (pure
`applyStyleToRange`) and sends `text/styleRuns`; Find/Replace Text and Replace
Fonts are client macros over `text/sourceText` / `text/styleRuns` /
`text/fontFamily` / `updateKeyframes`. The AI facades (`src/core/ai/toolContext.ts`)
create shape / solid / text / group / light layers through `createLayer` (a
light is ONE light — After Effects adds no ambient light beside it), write fill
colours and text fields as fields, write a static value on an animated
property as a key at the playhead (AE), key one member of a vector (Scale X)
as the whole vector, pass dropdown effect params by value or label, set roving
and remove a last key through `updateKeyframes` / `deleteKeyframes`, and set
the comp motion blur through `setCompositionSettings`.

**Still not in the API** (the reasons are at each `B3-legacy` site): the
paint-stop keyframes (`fill.stops` data track) and gradient-geometry static
writers inside legacy drag transactions; the shape stroke stack; the Style
component's arbitrary props in the generic node inspector; paragraph-text
conversions whose tests pin non-layer nodes; placement-aware inserts
(`placeInComp`, continuous raster) of text presets; a text layer's unstored
stroke width; puppet / polystar / skeleton rigs.

### 15.8 G2 — engine-internal correctness (both engines)

Every item landed in the TypeScript and the C++ engine together, with a replay
case (`__testHelpers__/corpus.ts`, `G2: …` sessions) that the cross-engine
replay runs against both.

- **Batch inverses.** A batch's inverse keeps each part's first-seen before and
  last-seen after, but a document-scope capture lists only the parts that exist,
  so a part an EARLIER command of the batch created looked pre-existing (undoing
  a batch of two `createComposition` kept the first; its layers had no events),
  and a part an earlier command's after still held looked alive after a later
  command removed it (an `editWorkArea` after another comp's removed a layer with
  no `layersRemoved`, and undo did not restore it). Now a key only the after has
  starts as absent, and a key only the before has ends as absent
  (`LocalEngine.runEdits`; the C++ journal already did). The generated corpus now
  batches every builder (the `NO_BATCH` exclusion is gone).
- **Keyframe events after a dropped cache row.** The event builder forgot a
  layer's reported keyframe lists when the layer was removed or its bar moved;
  a later report (a multi-entry `jumpToHistory` that restores the layer AND
  un-keys it) then never sent the empty list. Both builders remember the paths
  they dropped and report the no-longer-animated ones empty. The replay's
  "shared event gap" tolerance is removed: every mirror gap fails.
- **Gesture ids** come from the id allocator (`gesture` counter, a session
  counter that survives New Project), so a log header carries them;
  `recordSession` no longer burns a probe gesture and `replaySession` no longer
  burns empty gestures (a B5-format header's `gestureSeq` is read as the counter).
- **UI undo is an engine request.** `performUndo` / `performRedo` /
  `performJumpTo` (Ctrl+Z, Ctrl+Shift+Z, Edit ▸ Undo, the toolbar, the History
  panel) send `undo` / `redo` / `jumpToHistory` to the session's engine
  (`setHistoryRoute`, registered by `engineInstance`), so they are in the command
  log and a keyboard-undo session replays revision-exact (verified in the real app).
- **`applyPreset`** converts `time` (composition) to each layer's keyframe axis
  (start offset, stretch); the AI facade's axis-match fallback is gone.
- **Save/open** of guides, swatches, materials, transitions and plugin storage in
  the C++ document (`DocExtras`, docio.cpp — the stores' sanitisers ported;
  document entries without a usable id get `sw_doc_<n>` / `mat_doc_<n>` in BOTH
  engines instead of a clock id). `--test-ports-dir` mirrors the C++ engine's
  saved projects so the replay compares them.
- **Copy fragments** are written with sorted keys in both engines
  (`canonicalStringify`), so `copyLayers` is compared byte for byte.
- **3D layer spaces in expressions**: `toComp` / `fromComp` / `toWorld` /
  `fromWorld` on 3D layers, 3D parent chains through 2D parents, cameras (one-
  and two-node) and lights, through the active camera — `layerSpaceAt` ported
  (worldxf.cpp `layer_space_at`); 2D spaces now sample expressions and the
  layer's keyframe axis like the TypeScript.
- **Gradient geometry rows** (`fillAngle`, `fillCenterX|Y`, `fillRadius`,
  `strokeAngle`…) on text layers, read from / written into the paint (fill stack
  included); **paint strokes** are renormalised on write (`normalizeStroke`), and
  a raw stroke's values read with JavaScript arithmetic (absent → NaN/undefined).
- **Query path**: `getPropertyValues` over 2,000 layers × 5 properties spent its
  time in per-property catalog builds and an O(bars) bar lookup per sample. A
  read scope indexes bars per timeline during a query, and catalogs are cached
  per layer until the next command. `crossEngineBench` (C++ through the pipe):
  evaluate 10,000 values 410 → 86 ms, read them pre-expression 400 → 69 ms,
  `getLayerTransforms` 68 → 35 ms.
- **SVG in precompose (leave attributes)**: the content's SVG component is
  rebuilt (`makeSvgComponent`) with its sanitised markup re-scoped to the
  content's id — the editor re-sanitises the source; the engine rewrites the
  `<scope>__` names the sanitiser's id scoping wrote, which is byte-identical.

### 15.9 B3z — the last UI writes (in progress, 2026-09-24)

B3z-a (inspector, effects, text) and B3z-b (timeline, viewport/tools,
tools/core, comps/assets/dialogs, AI/plugins/commands, layers, other) close the
remaining ratchet sites. To keep parallel schema work from colliding, B3z-b
**owns the design** of these model additions (inspector controls use them
rather than adding their own) and **claims these command-id ranges**:

| Area | Ids | What |
|---|---|---|
| Session / history | 20–29 | history checkpoints, whole-document restore (cloud versions) |
| Items | 70–79 | import from bytes, remaining interpretation fields |
| Compositions | 120–139 | work-area clear, comp-root template/responsive-time data |
| Layers | 230–269 | pasteLayers parent / ref remap, subtree delete, layer-kind gaps |
| Layer time | 330–349 | transitions, time-stretch dialog, unfreeze, track-local ripple |
| Properties / keyframes | 420–439, 520–539 | member keys, roving retime, graph-editor gaps |
| Groups | 650–699 | puppet pins, skeleton/bones/IK, mask/shape drawing (paint strokes landed as commands 615–620) |
| Markers | 710–719 | marker colour tokens |

**Off-document builders** (`src/core/engine/offDocument.ts`). An insert
(a preset, a Lottie import, a library rig, a configured camera, captions) is a
client-side builder whose result is a set of NEW layers — what a `copyLayers`
fragment carries. `buildLayerFragment(comp, build)` runs the legacy builder
against a scratch state of the document inside one synchronous task, encodes
the layers it added, and restores the document exactly (the parts machinery);
`insertBuiltLayers(label, comp, build)` then sends ONE `pasteLayers` (both
engines, one undo entry, engine-minted ids) and selects the result. The run
fails (`OffDocumentError`) if the builder changed anything but new layers of
that composition — an existing layer, an item, composition settings, the
timeline's markers — so a builder with other effects must send those as
commands of its own. The ratchet treats writer calls lexically inside the
callback as scratch writes (`OFF_DOCUMENT_BUILDERS` in the rule).

#### Layer inserts — `pasteLayers` parent and reference remap (WS-L1, both engines)

`pasteLayers.parent?: LayerId` (field 5): the fragment's top-level layers go
under that layer of `comp` (Premation groups nest; parenting IS nesting, so any
layer of the comp is accepted, as `createLayer.parent`); a parent in another
composition is `invalidArgument`. `index` keeps its meaning — a stack index
among the composition's OTHER layers — and the pasted layers' own descendants
no longer count toward it (a pasted group at index k lands at k, its children
right under it; before, its children shifted the slot). Pasted siblings keep
the copied stacking (the first in fragment order is the front-most; both
engines used to reverse a multi-layer paste). `buildLayerFragment` returns the
existing layer the builder built into as `parent`, and `insertBuiltLayers`
sends it.

**References between pasted layers follow the copies** (AE does this for
parenting and track mattes). A stored layer reference is replaced ONLY when it
is a string equal to the id of a layer IN the fragment; references to other
layers are kept as they are. The complete list — any component of a pasted
row (`layers.ts remapLayerRefs` ⇄ `handlers_layers2.cpp remap_layer_refs`):

| Where | What |
|---|---|
| row `parent` | parenting (nesting) — as before |
| `matte.sourceId` | track matte source |
| `effects[*].params[*]` (string values) | layer-valued effect params (Set Matte, Displacement Map, Compound Blur, audio effects, plugin `layer` params, Layer Control) — by value, because plugin schemas are not in every engine's registry |
| `__cloner.pathLayerId`, `__cloner.falloff.layerId` | cloner path / falloff field layer |
| `__audioDriver[*].sourceLayerId` | audio-driven property source (`mix` is not an id) |
| `paint.strokes[*].cloneSourceId` | clone-stamp source layer |
| `pluginLayer:*` component, top-level string props not named `__…` | a plugin layer's `layer` props |

Expressions address layers by NAME (AE) and are not rewritten; animation data
tracks carry the new id already. Sites moved onto `insertBuiltLayers` /
`pasteLayers`: shape/text/primitive/solid/camera/light inserts (the New Light
dialog now makes ONE light — AE — no Ambient Fill beside it; the silent
insert keeps it), every library insert (motion graphics, Lottie items and
files, cursors, UI kit, animation presets, saved components, plugin layer
kinds — now INTO the active comp), templates (a gesture: `deleteLayers` of
the comp's layers, then `setCompositionSettings` + `pasteLayers`; the fields
follow the minted ids), and captions (`deleteLayers` of the old captions +
one `pasteLayers`, one entry). Auto-reframe is a gesture of
`createComposition` → `createLayer{precomp, init scale}` →
`setDimensionsSeparated` + `addKeyframes`. The Lottie importer's
`LegacyDocumentContext` now only ever runs inside the off-document builder.

#### Rigging — puppet and skeleton paths (WS-R, both engines)

Puppet pins and skeletons are ordinary property groups and properties: the
generic group commands (`addPropertyGroup`, `removePropertyGroups`,
`movePropertyGroup`, `renamePropertyGroup`, `setGroupEnabled`,
`addProperties` / `removeProperties`) and the generic value commands
(`setProperty`, `addKeyframes`, `updateKeyframes`, `deleteKeyframes`,
`setAnimated`, expressions) — no rig-specific command. Storage is unchanged
(`fx.puppet`, `fx.skeleton`, the `puppet.<pin>.*` / `bone.<id>.*` /
`ikTarget.<id>.*` / `ikPole.<id>.*` / `ikMode.<id>` tracks), so every document
opens as it did. Bindings: `src/core/engine/rigProps.ts` ⇄
`native/engine/src/core/rig.cpp` (catalog `special: 'rig'`).
After Effects' Puppet effect is the reference for the puppet; the skeleton
(Premation-only, Duik-like) follows the same conventions.

A group exists while its data does: `puppet` while the layer has a puppet rig,
`skeleton` while it has a skeleton. Group ids are engine-minted (`pin_<n>`,
`bone_<n>`, `ctrl_<n>`), never reused within a document.

| Path | Kind | Value / storage | Notes |
|---|---|---|---|
| `puppet` | group "Puppet" (`ADBE FreePin3`) | `fx.puppet` | `addPropertyGroup{parent:'', matchName:'ADBE FreePin3'}` creates an empty rig (mesh mode by layer kind, as the first pin did); removing it deletes every pin and its keys (AE: delete the Puppet effect). |
| `puppet/mesh/density` · `expansion` | field scalar | `meshDensity` (absent = 22), `meshExpansion` (absent = 0) | AE Mesh ▸ Density / Expansion (not keyframeable here). |
| `puppet/mesh/mode` | field choice `grid` \| `silhouette` | `meshMode` (absent = grid) | |
| `puppet/mesh/solver` | field choice `arap` \| `lbs` | `solver` (absent = arap) | |
| `puppet/mesh/rotationRefinement` | field scalar ≥ 0 | `maxRotationDeg` (0 = unlimited = absent) | AE Mesh Rotation Refinement. |
| `puppet/pins` | indexed group "Deform" | `pins[]` | order = `movePropertyGroup`. |
| `puppet/pins/<pin>` | group (`ADBE FreePin3 PosPin Atom`), name = `pin.name` | one pin | `addPropertyGroup{parent:'puppet/pins'}` (creates the rig when absent); `init`: `restPosition`, `kind`, `position`, …; `renamePropertyGroup`; remove = pin + all its keys. |
| `…/<pin>/position` | vec2, animatable | keys: `puppet.<pin>.position` points track (`[{x,y}]`, spatial tangents = the data key's `si`/`so`); static: `pin.position`, absent = the rest anchor | AE Puppet Pin ▸ Position (layer px, rest space when a skeleton also skins the layer). A static write moves the pin without a key (NEW stored field; the renderer's `resolveLivePins` reads it). Deleting the last key leaves the pin static at that key (AE). |
| `…/<pin>/rotation` | scalar °, animatable | `puppet.<pin>.rotation`; static `pin.rotation` | Advanced / Bend pin Rotation. |
| `…/<pin>/scale` | scalar **%**, animatable | `puppet.<pin>.scale` (stored ×1); static `pin.scale` | Advanced / Bend pin Scale (API unit percent, like transform scale). |
| `…/<pin>/stiffness` | scalar ≥ 0, animatable | `puppet.<pin>.stiffness`; static `pin.stiffness` | AE Starch ▸ Amount (any pin kind here). |
| `…/<pin>/overlap` | scalar −100..100, animatable | `puppet.<pin>.overlap`; static `pin.overlap` | AE Overlap ▸ In Front. |
| `…/<pin>/overlapExtent` | field scalar ≥ 0.05 | `pin.overlapExtent` (absent = 1) | AE Overlap ▸ Extent. |
| `…/<pin>/kind` | field choice `position` \| `starch` \| `bend` \| `advanced` \| `overlap` | `pin.kind` (absent = advanced) | Switching to bend keeps the position keys (dormant). |
| `…/<pin>/restPosition` | field vec2 | `pin.x`, `pin.y` | Where the pin binds the mesh (AE keeps this internal; set it in `init`). |
| `skeleton` | group "Skeleton" (`Premation Skeleton`) | `fx.skeleton` | `addPropertyGroup{parent:'', matchName:'Premation Skeleton'}`; removing it deletes every bone, IK goal, controller and their keys. |
| `skeleton/mesh/density` · `expansion` · `mode` | fields | `meshDensity`, `meshExpansion`, `meshMode` | The skinning mesh when no puppet rig shares the layer. |
| `skeleton/weightPaint` | field json (§14.2) | `weightPaint` (sparse `{vertexCount, bones:{id:{vertex:weight}}}`; null = none) | A paint stroke = ONE `setProperty` on release. |
| `skeleton/bones` | indexed group "Bones" | `bones[]` | |
| `skeleton/bones/<bone>` | group (`Premation Bone`), name = `bone.name` | one bone | `addPropertyGroup{parent:'skeleton/bones'}` (creates the skeleton when absent); `init` writes the new bone's values without capturing a bind pose; remove = the bone's SUBTREE, their IK goals, controllers, weight-paint and bind-pose entries and every key. |
| `…/<bone>/position` | vec2, animatable | `bone.<id>.x/.y`; static `bone.x/.y` (local to the parent) | |
| `…/<bone>/rotation` | scalar **°**, animatable | `bone.<id>.rotation` (stored **radians**); static `bone.rotation` | |
| `…/<bone>/scale` | vec2 **%**, animatable | `bone.<id>.scaleX/.scaleY` (stored ×1) | |
| `…/<bone>/parent` | field string (`''` = root) | `bone.parentId` | A cycle is `invalidArgument`. |
| `…/<bone>/length` | field scalar > 0 | `bone.length` | |
| `…/<bone>/influenceRadius` | field scalar ≥ 0 (0 = unlimited = absent) | `bone.influenceRadius` | |
| `…/<bone>/restPosition` · `restRotation` (°) · `restScale` (%) | fields | the bone's `bindPose` entry (absent = the bone itself) | The RIG-mode edit: what the skin is bound to. |
| `…/<bone>/ik` | group "IK" (`Premation IK Goal`) | the `ikTargets` entry of this bone | `addPropertyGroup{parent:'skeleton/bones/<bone>'}`; `setGroupEnabled` = `enabled`; remove = the goal + its target/pole/mode keys. |
| `…/ik/target` | vec2, animatable | `ikTarget.<id>.x/.y`; static `target.x/.y` | |
| `…/ik/pole` | vec2, animatable, OPTIONAL | `ikPole.<id>.x/.y`; static `target.pole` | `addProperties{parent:'…/ik', names:['pole']}` / `removeProperties`. |
| `…/ik/mode` | scalar 0..1, animatable | `ikMode.<id>`; static `target.ikMode` (fk = 0, ik = 1) | ≥ 0.5 = IK (sampled as a hold). |
| `…/ik/chainLength` | field scalar 1..8 | `target.chainLength` (absent = 2) | |
| `skeleton/controllers/<ctrl>` | group (`Premation Rig Controller`), name = `controller.name` | one controller | fields `shape`, `side` (choices), `size`, `offset` (vec2), `drives` (`bone` \| `ikTarget`), `bone` (string). |
| `layer/puppet`, `layer/skeleton` | field json | the whole rig | Whole-rig replace (rig presets, AI rigs, paste); removed pins / bones lose their keys. |

**Static pose writes capture the bind pose.** A static (un-keyed) write of a
bone's `position` / `rotation` / `scale` or an IK `target` / `pole` first pins
the rig's bind pose to the current bones when it has none (legacy
`captureBindPose`), so a pose drag without keyframes deforms instead of moving
the rest pose with it. The rest fields write the bind pose (capturing it
first). A rig-mode edit of a bone = its `rest*` field (plus the pose property's
static value when the property is not animated).

**UI mapping.** Pin placement = one `addPropertyGroup` (`init`: `restPosition`
= the click mapped back through the current deformation, `kind`, and
`position` = the clicked point when the mesh is displaced); a pin drag = a
gesture of `addKeyframes` at the playhead with the absolute value per move
(puppet pins always key — After Effects auto-keys pins); rotate / scale gizmo
the same on `rotation` / `scale`; Puppet Sketch = ONE batch of
`deleteKeyframes` (the keys inside the recorded span, AE) + `addKeyframes`
(the reduced keys with their easing); a motion-path tangent drag = a gesture
of `updateKeyframes {spatialIn, spatialOut}`. Bone draw = `addPropertyGroup`
on `skeleton/bones` (`init`: `parent`, `length`, `position`, `rotation`); a
pose / IK / pole / controller drag = a gesture of `addKeyframes` (keyframing:
the property is animated or auto-keyframe is on) or `setProperty` (static);
IK/FK switch = a client macro (`planChainSwitch`) writing `mode`, rotations
and `target`; a rig preset = `setProperty('layer/skeleton')`. 3D IK
(Ik3DSection) is a client macro over transform rotation keys.

#### Layer fields (B3z-a, both engines)

G1's static FIELDS (§15.7) generalised from the Text component to every
layer. `src/core/engine/layerFieldSpecs.ts` is a DATA table (`LAYER_FIELDS`,
pure; generated into the C++ catalog as `fields.layer` by
`GEN_NATIVE_CATALOG=1 npx jest crossEngineCatalog`), read by
`src/core/engine/fields.ts` (owner `layer`) and `native/engine/src/core/fields.cpp`
(`layer_*`). Each row is one static (`animatable: false`) property:

- `path` — the API path; `type` / `default` / `choices` / `min` / `max` /
  `clearAtDefault` exactly as a G1 field (`setProperty` / `setProperties` /
  `resetProperty` type-check it; keys, stopwatch and expressions answer
  `notAnimatable`).
- `store` — where the value lives: a prop of the layer's first component of a
  type (`component`, or an ordered list: the first type the layer carries), or
  a key of its `fx` component (`fx`, optionally a `key` inside that object —
  the object must exist). A write creates nothing else.
- `when` — when the layer HAS the property: a component type, layer kinds /
  excluded kinds, 3D on, an `fx` key present. Absent = every layer that has the
  storage.
- `encode` — a choice / bool whose stored form differs from the API value
  (`[API value, stored raw]` pairs, stored `null` = absent): `material/shading`
  `phong` is stored as an absent `shadingModel`, a light's `castsShadows` false
  as absent, a stored `false` also reads as false.
- `json: 'object' | 'array'` — a json field's shape; `null` clears it; any
  other shape is `invalidArgument`. The client computes the whole next value
  (a toggled switch inside a cloner config) and sends it; the engine stores it
  verbatim and undo restores the previous value exactly (parts, §15.2).
- `mirror` — a second store written with the same raw value (a legacy marker
  other readers use: `primitive/type` → `Transform.primitiveType`).

Bindings are appended after the G1 block in table order, skipping a path the
catalog already has (both engines add them identically; the property tree is
compared across engines). Rows today:

| Path | Type | Storage | On |
|---|---|---|---|
| `material/shading` | choice `phong` \| `pbr` \| `toon` | `Transform.shadingModel` (phong = absent) | 3D layers |
| `material/toonBands` | scalar 2..8 (3 = absent) | `Transform.toonBands` | 3D |
| `material/heightMap` | string item id ('' = none) | `Transform.heightMapAssetId` | 3D |
| `material/displacementSubdivisions` | scalar 0..3 | `Transform.displacementSubdiv` | 3D |
| `material/faceMaterials` | json object `{side?, bevel?, back?: {fill?, gain?}}` | `Transform.faceMaterials` | 3D |
| `geometry/bevelStyle` | choice `angular` \| `concave` \| `convex` | `Transform.bevelStyle` (angular = absent) | 3D layers with Geometry Options |
| `text/perCharacter3D` | bool | `Transform.perChar3D` | text layers |
| `light/lightType` · `light/falloff` · `light/environment` | choice · choice · string (`studio` \| `sky` \| `sunset` \| `asset:<id>`) | `Transform.lightType` / `falloff` / `envPreset` | lights |
| `light/castsShadows` · `light/glow` · `light/shadowMap` | bool | `Transform.castShadows` / `lightGlow` / `shadowMap` | lights |
| `light/shadowMapSize` | scalar 64..8192 (1024 = absent) | `Transform.shadowMapSize` | lights |
| `camera/filmSize` | scalar mm (36 = absent) | `Transform.filmSize` | cameras |
| `primitive/type` | choice sphere … box (+ mirror `Transform.primitiveType`) | `Primitive.type` | 3D primitive layers |
| `primitive/radius` … `tube`, `radialSegments`, `heightSegments`, `capped` | scalar / bool | `Primitive.<key>` | 3D primitive layers |
| `layer/particle` | json object (the emitter config) | `fx.particle` | particle layers |
| `layer/cloner` · `layer/physics` · `layer/audioWaveform` | json object | `fx.__cloner` / `fx.__physics` / `fx.audioWaveform` | visual layers |
| `layer/modifiers` | json object `{<prop>: {modifiers, previous}}` | `Transform.__modifiers` | every layer |
| `layer/precompose` | bool (a group composited as one unit) | `fx.precomp` | group layers |
| `layer/compOverrides` | json object `{"<origId>/<prop>": value}` | `fx.__compOverrides` | precomp layers |
| `layer/sequenceLoop` | bool | `fx.imageSequence.loop` | image sequences |
| `audio/effects` | json array (declared WebAudio chain) | `fx.audioEffects` | audio / video / precomp |
| `audio/drivers` · `audio/ducking` · `audio/gate` | json object (analysis records) | `Transform.__audioDriver` / `__ducking`, `Audio`-or-`Transform.__gate` | as above |

The analysis-driven audio tools (ducking, gate, driver, silence removal) and
the tracker are CLIENT MACROS (§1 rule 7): the analysis is not a document
write; its result is one batch of ordinary commands plus the record field.
Replay: the `B3z: layer fields …` corpus session, the `properties: every
property …` sweep (every row is bumped on every layer kind) and the generated
corpus (json fields are now among the static fields it writes).

#### Layer operations and text (B3z-a worker B)

- **`setTrackMatte` without `matte.layer`** (mode ≠ none) is AE's classic
  positional matte — the layer directly above in the stack — stored as
  `fx.matte {mode, inverted}` with no `sourceId`, as the editor always stored
  "Layer Above". Both engines accepted only a source before; the random corpus
  already emitted the form (it is no longer an error in either engine).
  Replay: `B3z: Layer Above track matte and latent text Tracking / Leading`.
- **Latent text Tracking / Leading**: `letterSpacing` and `lineHeight` are
  latent rows (`latentPropSpecs.ts`, home `Text`) — a text layer that has not
  stored them addresses `text/letterSpacing` / `text/lineHeight` (the paths a
  stored value has), so a text preset or the Character panel writes them
  through the engine.
- **Text presets** (`textPresetEdit`) are one batch of field / property writes:
  a keyword weight is sent as its number (`bold` ≡ 700 on `text/axes/wght`),
  the legacy `strokeOverFill` boolean as `text/strokeOrder`, `content` as Source
  Text (+ its style runs). The pre-API bag writer is gone from the text area.
- **Point ⇄ paragraph text and Box Auto-Size** (`paragraphTextCommands.ts`) are
  client macros, ONE batch each: `text/boxWidth|boxHeight|boxAutoSize`, a Fit
  Text to Box scale baked into `text/fontSize` / `text/letterSpacing` /
  `text/paragraphSpacing`, Source Text (static: the wrapped text + `text/styleRuns`
  re-sent — each soft wrap replaces one space, so the runs keep their indices;
  keyed: `updateKeyframes` values with each key's own wrap, keyframe ids from
  `getKeyframes`), and the compensating Position (`setProperties`, keyed at the
  playhead when animated). A keyed layer's static text is not rewritten — AE
  has no separate static value while the stopwatch is on.
- **Convert SVG to Editable Shapes** is a client macro, not `convertLayer`: the
  SVG parser (fonts for `<text>`, clip intersection, CSS/SMIL → keys) runs in the
  editor off-document (`buildSvgShapeGroup` inside `buildLayerFragment`) and the
  result goes out as ONE batch `pasteLayers` (at the SVG layer's stack slot and
  parent) + `deleteLayers` of the SVG layer — replayable in both engines.
  `convertLayer{shapesFromVector}` stays `unsupported` in both engines: the C++
  engine has no SVG geometry parser (only the G2 sanitiser), and the TS parser
  measures text through the DOM.
- **Create Masks from Text** is the same shape: glyph outlines (async font
  loading) → an off-document build of the comp-sized solid in the text colour
  with one mask per contour → ONE batch `pasteLayers` + `setLayerSwitches
  {visible:false}` on the text.
- **Replace Footage with a file** (Inspector ▸ Replace): a library item →
  `replaceLayerSource{keepSize}`; any other path → ONE engine gesture
  `importFiles` (by path) then `replaceLayerSource` on the new item (AE adds the
  file to the project). The per-layer image-sequence loop is `layer/sequenceLoop`.
- **Comp motion-blur master**: switching a layer's motion blur on while the
  comp master is off sends `setCompositionSettings{motionBlur.enabled:true}` in
  the switch's own batch (AE's dual gate, one undo entry). Clear Work Area in
  the Preview panel is `clearWorkArea`. Transform presets reach Skew / Skew
  Axis / Fill Opacity at their defaults through worker C's latent bindings.
- **Left for B3z-b's commands** (schema only when this landed): the Shift
  pick-whip JUMP (`setParent{jump,time}`), the non-footage Time Stretch field
  (`timeStretchLayers`), the Freeze Frame switch and Freeze Time field
  (`unfreezeLayers`: on a frozen layer `freezeFrame{time}` re-holds the frame
  it already shows, AE-correct for the menu command, so a typed source time is
  `[unfreezeLayers, freezeFrame{keyframeToCompTime(v)}]`), the Cryptomatte ID
  matte (import from bytes, items 70–79), rename with expression repair and
  group / ungroup across parents (WS-M).

### 15.10 B3 paths — outlines on the API (both engines, 2026-09-24)

The Mask and Shape Path verbs, the Pen / Direct Selection / Convert Vertex
ports, the Knife and Create Nulls From Paths write through these (tools/core:
`pathCommands.ts`, `pathEdits.ts`, `ports.ts`). Command ids 630–631 (the
Groups range); the rest are values and properties.

- **`BezierPath.vertexStates`** (field 6, `PathVertexState {vertex, broken,
  tension?}`): each vertex's EDITING state — an Alt-split handle pair, a
  RotoBezier tension (0..1, else `outOfRange`). It changes no pixel; it is what
  the next edit of the vertex does. Reads list one entry per vertex that has
  any. A write follows the `featherPoints` rule: an EMPTY list keeps each
  vertex's current state by index (clients that build a path without it keep
  working); a non-empty list is authoritative — `[{vertex: 0, broken: false}]`
  is "none on any vertex". The tools always send it authoritatively
  (`toolEdits.ts` `vertexStatesOfPoints`). Masks and shape outlines alike
  (stored as `broken` / `tension` on the point objects).
- **`layer/path.points`** on a drawn shape layer (the timeline's Path row) is
  a PATH value — it was catalogued as a scalar: static value = the Geometry
  component's `points` + Closed (`Geometry.open`, absent = closed); keys = the
  whole-outline `path.points` data track. A shape's Closed is the OUTLINE's,
  not a key's: a key write with another `closed` flips `Geometry.open`, and
  every key reads it. `featherPoints` with a radius ≥ 0 are `unsupported` (a
  shape vertex has no feather). The stopwatch keys the static outline; off, it
  leaves the outline static at `time`; deleting the last key leaves it at that
  key's shape. A primitive with only a `path.points` track keeps the plain
  data-track binding (keys only).
- **`masks/<id>/rotoBezier`** (bool, static): AE's RotoBezier switch, held in
  the static mask and every shape keyframe (like mode / inverted).
  **`layer/pathRotoBezier`** (bool) and **`layer/pointBindings`** (json array
  `[{index, nullId}]`, Create Nulls From Paths ▸ Points Follow Nulls) are layer
  fields on the Geometry component (`layerFieldSpecs.ts`).
- **`light/poiX|Y|Z`**: a light's Point of Interest is latent like a one-node
  camera's (`camera/poiX|Y|Z`) — addressable before the layer stores it (the
  viewport's POI handle); the first write stores it on the Transform.
- **`editPathTopology`** (630) `{prop, op?, closed?}`: a STRUCTURAL edit of an
  outline in EVERY state — the static outline and each keyframe — because keys
  whose vertex counts or orders differ hold instead of morphing. `op`
  (`PathTopologyOp`): `insert {segment, u}` (de Casteljau: the drawn curve is
  unchanged, the new vertex at `segment + 1`), `remove {indices}` (≥ 2 must
  stay), `firstVertex {indices: [i]}` (a closed outline rotates; an open one
  can only start at its last vertex, which reverses it), `reverse`, `extend
  {points, atStart}` (Continue Path: the same local points in every state).
  The op runs on each state's own closed state, then `closed` sets the switch
  everywhere. A state the op does not apply to is left alone; an op that
  applies to none is `invalidArgument`. Feathers and vertex states travel with
  their vertices; keyframe ids, times and easing are kept. The replay is
  `packages/workspace` pathTopology.ts (TS) and its port in
  `native/engine/src/core/handlers_paths.cpp` (same arithmetic order).
- **`setShapeOutline`** (631) `{layer, runs}`: the Knife — the layer's outline
  becomes independent runs (`Geometry.subpaths`, `open` per run), the
  single-run `Geometry.points` is cleared, `Transform.shapeType` becomes
  `path`, and a layer without Geometry gets one (`<id>_g`). Not a shape:
  `invalidArgument`; an animated outline: `animated`.
- **Gestures: kept messages.** A drag's messages are latest-wins (§5.2). A
  STRUCTURAL step inside a drag — Direct Selection inserts a vertex at pointer
  down (`editPathTopology`, a RELATIVE command) and the drag then reshapes it —
  is sent with `GestureSession.send(cmds, { keep: true })` /
  `ToolTransaction.send(label, cmds, { keep: true })`: never dropped for a
  later message, applied once, in order.

Left (the ratchet's remaining tools/core sites): `ports.ts`
`applyNodePropsKeyframed` and the legacy anim transaction in
`viewportGesture.ts` (`gestureAnimEdit` / `endViewportGesture`'s record) —
used by `cameraCommands` (Set Focus Distance to Layer, Distribute Layers in Z:
synchronous callers beside their own expression / 3D-switch writes; that
module's migration) and `sendNodeValues`' fallback for a node outside a
composition. `providers/clipboardEdits.ts` calls `pastePathEdit` — an engine
edit; the ratchet flags the write verb lexically.

## 16. Files

| Path | What |
|---|---|
| `packages/engine-api/schema/*.eapi` | The schema (read in file-name order). |
| `packages/engine-api/codegen/generate.cjs` | Parser, validator, TS + C++ generators, reflective encoder, sampler. `npm run engine-api:gen` / `engine-api:check`. |
| `packages/engine-api/src/generated/{types,codec,meta}.ts` | Generated TS (do not edit). |
| `packages/engine-api/src/{wire,time,propPath,index}.ts` | Hand-written TS runtime and helpers. |
| `packages/engine-api/src/client.ts` | `EngineClient` (the transport-agnostic contract) + `EngineClientBase` helpers. |
| `packages/engine-api/src/process.ts` | `ProcessEngineClient` — the C++ process backend (C3): bridge types, §8.2 rule, crash-recovery replay, fallback. |
| `packages/engine-api/src/idMap.ts` | `IdMap` — carries a request stream between engines whose ids differ (cross-engine replay). |
| `packages/engine-api/schema/95_frames.eapi` | The `FrameChannel` family (§13). |
| `electron/generated/{frameChannel,engineWire}.ts` | Generated standalone TS for that family (Electron main). |
| `electron/engineHost.ts` | The flag, the supervisor, IPC (`engine:request/status/receiverReady`), shared-texture frame forwarding. |
| `src/core/engine/process/processEngine.ts`, `src/components/EngineSurface/` | The window's process client (+ dev handle) and the surface that draws engine frames. |
| `src/core/engine/LocalEngine.ts` | The TypeScript engine behind the API (B2): requests, history entries, gestures, events, log. |
| `src/core/engine/state.ts` | Parts: capture, diff, restore — the inverse machinery (§15.2). |
| `src/core/engine/props.ts` | Property catalog: API paths ⇄ today's storage; keyframe read/write. |
| `src/core/engine/handlers/*.ts` | One handler per edit command, by family. |
| `src/core/engine/{queries,events,model,transport,keyIndex,ids,replay,canonical}.ts` | Queries, event building, read model, transport, keyframe id index, deterministic ids, replay, canonical document. |
| `src/core/engine/fields.ts`, `src/core/text/textFields.ts`, `native/engine/src/core/fields.cpp` | G1 static field properties (the spec table both engines read) and their C++ port. |
| `src/core/engine/handlers/optionalProps.ts`, `native/engine/src/core/handlers_optional.cpp` | `addProperties` / `removeProperties`. |
| `src/core/engine/__tests__/` | Per-command undo parity, controls, events + mirror, queries, defects, replay corpus. |
| `packages/engine-api/src/*.test.ts` | Round trips for every type, staleness, doc coverage. |
| `packages/engine-api/bench/` | `npm run engine-api:bench` (set `ENGINE_API_BENCH_EXTRA` to an adapter module to add a comparator). |
| `packages/engine-api/bench/flatbuffers-eval/` | The FlatBuffers twin used in §9.3 (`bench.fbs`, the C++ bench). The TS side was an esbuild-bundled adapter mapping the plain payloads onto flatc's `*T` object-API classes, passed via `ENGINE_API_BENCH_EXTRA`; flatc came from vcpkg at the repo baseline. Not built by anything. |
| `native/protocol/include/premation/protocol/wire.hpp` | Hand-written C++ runtime. |
| `native/protocol/generated/{engine_api.hpp,engine_api.cpp,fixtures.inc}` | Generated C++ (do not edit). |
| `native/protocol/{CMakeLists.txt,CMakePresets.json,build.mjs}` | Separate CMake project (no vcpkg packages); `npm run protocol:build` configures, builds, tests; `--bench` runs the codec benchmark. |
| `native/protocol/tests/test_protocol.cpp`, `bench/bench_protocol.cpp` | C++ round trip of every fixture; C++ benchmark. |
