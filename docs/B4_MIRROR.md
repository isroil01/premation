# B4 — the UI reads a mirror of the document

> NATIVE_CORE_PLAN §5 **B4**: "The UI reads through a mirror fed by change
> events — Inspector/timeline render from the mirror only." Once a panel
> renders from a mirror built only from `getDocument` + the engine's
> revisioned change events (ENGINE_API.md §8), it does not matter which engine
> owns the document — that is what lets F2 move ownership into the C++
> process. This file is the conversion guide; B3_PATTERNS.md is its twin for
> writes.

## 0. The pieces

| Need | Use | Where |
|---|---|---|
| The mirror (no React) | `documentMirror()` → `DocumentMirror` | `src/stores/documentMirror.ts` |
| React hooks over it | `useMirrorLayer`, `useMirrorTree`, `useMirrorProperty`, `useMirrorKeyframes`, `useMirrorValueAt`, `useMirrorComp`, `useActiveMirrorComp`, `useActiveCompFps`, `useMirrorItems`, `useMirrorHistory`, `useMirrorKeys`, `useMirrorTrackWatch`, `useMirrorLayersWatch`, `useRetainTree(s)` | `src/hooks/useMirror.ts` |
| Track name ⇄ API path | `trackRefIn(tree, 'x')` → `{ path, member, factor, info }`; `storedNumber`, `numbersOfValue`, `plainValue` | `src/core/mirror/trackIndex.ts` |
| Editor kind of a layer | `uiKindOf(layerInfo)` (`'shape'`, `'text'`, `'group'`, `'comp'`, …) | `src/core/mirror/layerKinds.ts` |
| Multi-selection rows | `aggregateTrack`, `readTrack`, `isTrackAnimated`, `trackExpression`, `trackKeyTimes`, `navigatorFor`, `groupNavigatorFor`, `selectionKindsOf`, `aggregateLayerFlag` | `src/core/mirror/selection.ts` |
| Labels / units / ranges | `mirrorPropertyMeta(track, layerInfo, tree)` (the registry, fed mirror facts instead of a node id) | `src/core/mirror/metaFacts.ts` |
| The ratchet | `npm run lint:engine-reads`; `node scripts/lint/engineReadsReport.mjs --files inspector` / `--list inspector` | `eslint.engine-reads.config.mjs`, `scripts/lint/engineReadsRule.mjs`, `src/__tests__/engineReadRatchet.{test.ts,json}` |
| Equivalence on both backends | `src/core/engine/__tests__/mirrorEquivalence.test.ts` | |

### What the mirror holds, and what it guarantees

- **Layer headers** (`LayerInfo`: name, kind, parent, source, switches, timing,
  blend, matte, markers, children, hasAudio) and **every keyframe list** —
  eagerly, for every layer.
- **Compositions** (`MirrorComp`: settings, stack order top-first, markers),
  **items**, **project settings**, **render queue**, **history** (undo/redo
  labels), **dirty**, **per-comp layer errors**.
- **Property trees per layer, on demand.** `tree(layer)` loads a layer's
  `PropertyInfo` tree (synchronously on the in-process backend); a component
  that draws a layer's properties keeps it loaded with `useRetainTree`
  (`useMirrorTree` / `useMirrorProperty` / `useMirrorTrackWatch` retain for
  you). 2,000 layers' trees are 57,000 infos, so they are never fetched
  wholesale.
- **Values at a time.** A static property's value is its `PropertyInfo.value`;
  an animated one (or one with an expression) comes from `valueAt(layer, path,
  flicks)` — batched `getPropertyValues` per (time, revision), the last known
  value until the answer lands.
- Records are **immutable**, and an event that restates a record unchanged
  keeps the old object: **identity is the change test** (`React.memo`,
  `useMemo` deps, selector equality).
- Listeners are called **once per engine batch**, per key: `layer:<id>`,
  `layers`, `comp:<id>`, `comps`, `order:<comp>`, `items`, `item:<id>`,
  `tree:<id>`, `prop:<id>|<path>`, `keys:<id>`, `key:<id>|<path>`,
  `value:<id>|<path>`, `history`, `status`, `settings`, `renderQueue`,
  `errors:<comp>`, `doc` (every revision — rarely what you want).
- **Units are the API's** (ENGINE_API.md §3.5): scale in %, degrees, px;
  times are comp-time flicks. `trackRefIn` gives the factor back to stored
  units (`storedNumber`), so a row's `displayScale` applies as before.
- **Writes made around the engine** (a legacy writer that has not moved to
  the API) reach the mirror too: the TS engine reports a write the app bus
  attributes to one layer at once, as an incremental engine-origin batch, and
  an unattributed one as `documentReset{resync}` on the next microtask.
- The **playhead is not in it.** Values at the playhead read the throttled
  display time (`useThrottledTime`), never the raw clock; per-frame motion
  stays on `playbackClockStore` subscriptions.

## 1. Converting a read

| Before | After |
|---|---|
| `useNodeRevision(id)` + `defaultSceneGraph.getNode(id)` | `const layer = useMirrorLayer(id)` (header facts) or `useMirrorLayersWatch([id])` then read `documentMirror()` in render |
| `useNodesRevision(ids)` + `aggregateProperty(ids, prop, t)` | `useMirrorTrackWatch(ids, [prop])` + `aggregateTrack(documentMirror(), ids, prop, t)` — see `layout/Inspector/useMultiPropertyField.ts`, the reference |
| `readNodeKind(node)` | `uiKindOf(layer)` |
| `node.visible / locked / solo / shy`, `readLayerFlag(node, 'motionBlur')`, `is3DEnabled(node)`, `readNodeQuality`, `getNodeBlend`, `getNodeMatte` | `layer.switches.*`, `layer.blendMode`, `layer.matte` |
| `node.parent` | `layer.parent` (undefined at the top of a comp — the API does not name the comp root) |
| `node.name`, `node.color` | `layer.name`, `layer.switches.label` (label index) |
| clip bars (`getLayersForNode`), in/out | `layer.timing` (`inPoint`, `outPoint`, `startTime`, `stretch`: flicks) |
| `defaultAnimation.isAnimated(id, track)` | `isTrackAnimated(m, id, track)` |
| `defaultAnimation.getTrackKeyframes(id, track)` | `m.keyframes(id, trackRefIn(tree, track).path)` (comp-time flicks, API ids) or `trackKeyTimes` (seconds) |
| `defaultAnimation.sample(...)` / `readPropertyValue` | `readTrack(m, id, track, seconds)` / `m.valueAt(id, path, flicks)` |
| `defaultAnimation.getExpressionSrc / isExpressionEnabled / getExpressionError` | `trackExpression(m, id, track)` (per PROPERTY — the API has one expression per property) |
| `getNodeEffects(id)` | the tree's `effects` group: `tree.nodes.get('effects')?.children` → each `effects/<id>` group info (`matchName` = effect type, `name`, `enabled`); params are `effects/<id>/<key>` |
| masks | `masks/<id>` groups; `masks/<id>/{path,feather,opacity,expansion,mode,inverted}` |
| Text component props | `text/<field>` (G1 fields: `plainValue(info.value)`), `text/sourceText` (textDocument), `text/styleRuns` (json) |
| `resolvePropertyMeta(track, nodeId)` | `mirrorPropertyMeta(track, layer, tree)` |
| `useCompositionStore((c) => c.fps)` etc. | `useActiveCompFps()`, `useActiveMirrorComp()?.settings` |
| `getTimelineController().getMarkers() / getWorkArea()` | `comp.markers`, `comp.settings.workArea` |
| `useAssetStore` items | `useMirrorItems()` |
| bus `AnimationChanged` / `NodeUpdated` / `SceneGraphChanged` subscriptions for re-render | a mirror key subscription (`useMirrorKeys`, or the hook for the record you read) |

In a CALLBACK (a click, a menu item), read `documentMirror()` at call time —
never a value captured by a stale closure.

## 2. Rules

- **Read the mirror, not a query per render.** Queries are for what a WRITE
  needs or for things the mirror does not carry by design (`sampleProperty`
  for curves, `getMotionPath`, `copyLayers`). Never a query per played frame.
- **Subscribe to exactly what you read** (the narrowest key). A row keyed on
  `doc` re-renders on every edit anywhere.
- **Gaps.** A datum the API does not carry yet (see the list in §4) stays a
  legacy read with a comment `// B4-gap: <what> — <why>` and stays counted by
  the ratchet. Do not invent API, do not add catalog fields (the B3z agents own
  the model additions, ENGINE_API.md §15.9); report the gap.
- **Writes are not your business here**, except that a write-composition
  helper you touch should read its current values from the mirror too.
- **Tests.** A fixture built with `defaultSceneGraph.addNode` is fetched by the
  mirror on demand (`getLayers`), but a later direct write with no bus event
  is invisible to it — build fixtures through the engine (`setupAppEngine()` +
  `h.run({ type: 'createLayer', … })`) and `await act(async () => { await engineIdle(); })`
  after an edit.

## 3. Coordination (parallel agents)

B3z-a / B3z-b are moving the remaining WRITES of the same files onto the
engine API; D2w owns `native/engine/src/scene` and the render thread. Re-read a
file right before editing it, make scoped edits, never revert someone else's
change, never `git stash` / `git reset` / `git checkout -- <file>`, never
commit. Files are CRLF: use the Edit tool, never `sed -i`. Never start Vite.

## 4. Gaps found so far (data the API does not carry)

- Modifier stacks (`__modifiers` on a component) and pinned properties
  (`__pinned`) — layer data with no catalog path.
- Per-member expressions (an expression on Y of Position alone): the API has
  one per property.
- Plugin layer kinds (`plugin:<id>/<kind>`): `LayerInfo` names a `generator`
  but not which one.
- Stroke-stack units (taper length units, wave units) used by the metadata
  registry.
- Found converting the Inspector and timeline (each named where it is read,
  and in the exit table below): an item's MEDIA TYPE (still / video / audio /
  svg) and its probe state; the Essential Properties a comp PUBLISHES
  (`__essentialProps`); the inserted-element tag (`__mographId`); an SVG
  layer's stored document; the layer time config (freeze, a baked stretch);
  per-MEMBER key lists; a text-layout query; clip source windows (roll limits);
  a Lift (non-ripple range delete) command; a layer-as-preset capture query.

### Closed in b4-mirror-reads (2026-09-26, both engines — ENGINE_API.md §15.11; the ratchet 679 → 592)

Converted on the way (§1 conversions, no gap): the Layers tree and its filter
facts (`sceneRows` over the mirror: kinds, glyphs, plugin marks, labels,
sources, keys, effect counts), reparent reveal, the Character panel, the
missing-font check and Replace Fonts, the Effects panel's mask list
(`core/mirror/masks.ts`), the Composition Settings draft
(`compRecordFromSettings`), pristine-comp adoption, footage assembly, the
asset predicates, the Compositing / Media / time-stretch reads, the still-image
pickers, Essential Properties (section, Pinned tab, promote menu), the mograph
root, the clip menu's time verbs, the stopwatch's lock / mask state, the 3D
camera tip.


- An item's media type and probe state: `ItemInfo.mediaType` (`none` / `image`
  / `video` / `audio`), `ItemInfo.alphaProbed` / `audioProbed`.
- The Essential Properties a comp publishes: `CompSettings.essentialProps`
  (rides `compositionChanged`).
- The inserted-element tag: `LayerInfo.mographId`; the plugin that generated a
  layer: `LayerInfo.managedBy`; the shape primitive the Layers glyph narrows on:
  `LayerInfo.shapeType`.
- Plugin layer kinds: `LayerInfo.generator` now names a custom plugin layer's
  kind too (its `kind` stays the shape it draws); the editor-kind readers
  (`inspectorMirror`, `canBe3DLayer`, `isPaintableLayer`) key on it.
- The layer time config: `LayerTiming.freeze?` (the held layer-axis time),
  `LayerTiming.bakedStretch?` (a bake's factor on a layer with no source).
- Lift: the `liftRange` command (971) → `TimeRangeEdit {layers, splits,
  deleted}`; Extract's toast counts come off the mirror before
  `rippleDeleteRange`.
- Clip roll limits: from the two layers' `LayerTiming` (`inPoint - startTime`
  is the source-in, `sourceDuration` the bounded source) —
  `core/mirror/rollLimits.ts`, no API needed.

Still open (each site marked `B4-gap`): a text-layout query (`getTextLayout`:
lines, box, fit scale — paragraph ⇄ point, box auto-size, the Text Box card),
layer bounds (`readGeometry` / `getLayerBounds`; C++ needs text measure and the
group union), per-member key lists (keyframe assistants over non-catalog
tracks), a layer-as-preset capture (`capturePreset {layer}`: C++ needs the
preset unit conversion), the keyframe / effect clipboards in API form, the
proxy record, the Cryptomatte set, an SVG layer's document, the plugin schema
version, per-member expression preview, the Assets panel's object URLs.

### Closed in b4-round2 (2026-09-27, both engines — ENGINE_API.md §15.12; the ratchet 592 → 530)

- A layer-as-preset capture: `capturePreset {layer}` (Motion Presets ▸ Save;
  the library stays the editor's — `saveUserPreset`).
- A text-layout query: `getTextLayout {layer, time, overrides?}` — the render
  and selection boxes, the wrap, the paragraph box, where the line block sits;
  the overrides ask "where would the lines be if…". Point ⇄ Paragraph and Box
  Auto-Size compose their writes from two answers (paragraphTextCommands.ts);
  the Text Box card reads `useTextLayout` (measured) + `mirrorParagraphBox`
  (stored). The C++ answer measures with the scene port's TextMeasurer.
- Layer bounds: `getLayerBounds {layers, time, space}` (readGeometry's box, a
  group's union at the time; layer / comp space) — Align & Distribute, stroke
  gradient defaults (`layerBoxAt`, src/stores/layerBoxes.ts), SAM masks and
  Auto-Rig (`fetchLayerBox`).
- The keyframe / effect clipboards in API form: `copyKeyframes {keys}` (whole
  keys per property → `pasteKeyframes`), `copyEffects {layer, effects}` (the
  capture `pasteEffects` takes; the paste's "still as copied" test compares two
  captures).
- Per-member key lists: `getMemberKeyframes {layer, members}` — The Smoother,
  The Wiggler (lists, menu predicates, the previews' "before"), the Motion
  editor's property list, U / Shift+U reveal, Time-Reverse / Easy Ease All
  enablement (src/stores/memberTracks.ts, `useMemberTracks`).
- An SVG layer's document: `LayerInfo.svg` (role) + `getSvgDocument`.
- The Cryptomatte set: `getCryptomatte {item}` (TS: the page's EXR decode,
  announced as `assetStatusChanged`; C++: `unsupported` until EXR decode).
- The frame-synchronous overlay geometry push: `setOverlayGeometry` →
  `FrameGeometry` before each FrameReady (src/stores/overlayGeometry.ts) — the
  motion path overlay (draw + hit test) reads it.

Still open after round 2: the proxy record (job state in the page's asset
store — proxy generation as an engine job closes it), the Assets panel's object
URLs (`getThumbnail`), the plugin schema version (waits for the Custom Layer
section's path writes), per-member expression preview, rig pins / bones in the
geometry push (the rig sampler is scene-side), and the WorkspaceController's
geometry-backed SceneGraphPort (the push carries matrices and boxes; the port
also needs anchors, 3D projection per view, extruded hulls, clip gating, path
points and masks from the mirror — a parity-checked step of its own).

## 5. What is left (2026-09-24: 681 reads, from 765)

The ratchet (`node scripts/lint/engineReadsReport.mjs`) by area: viewport/tools
239, other 126, inspector 107, AI/plugins/commands 54, comps/assets/dialogs 50,
layers 40, text 25, timeline 23, effects 17. By kind: helper 414, singleton
150, store 57, revision 36, timeline 19, viewport 5.

What came off in B4-more (765 → 681), and why each is sound:

- **Transport is not the document.** The timeline's seeks, steps, keyframe /
  marker navigation and `pauseInactiveComps` go through
  `@core/timeline/timelineView` (a seam: ENGINE_API §6 control state)
  instead of `getTimelineController()` — BottomTimeline, useTimelineKeys,
  usePlaybackClock, markerCommands. The popout timeline installs the same
  engine-side `timelineUpkeep` App.tsx does instead of its own
  `SceneGraphChanged` subscription.
- **The work area is a CompSettings fact.** The API states "no work area" as
  the whole composition; `compFacts.settingsHasWorkArea` /
  `settingsSetWorkArea` answer the controller's `getWorkArea() === null`
  (timeline fit, the status-bar fit button, the preview-cache readout, Lift /
  Extract enablement, the export form, the render queue). A work area set to
  exactly the whole composition reads as none — it covers the same frames.
- **Markers, transitions, row menus from the mirror.** The marker editor and
  the marker commands (`mirrorMarkerById`, the layer's in point for a layer
  marker), the timeline's transition boxes (`MirrorComp.transitions`), a row's
  Reset availability (`mirrorCanResetProperties`) and its expression entries
  (`expressionRowMenu.ts`: state from `trackExpressionFacts`, new, per member;
  the actions are `setExpression` batches, not the legacy writers).
- **`CompSettings.pristine` is reported** by both engines (TS `model.ts`,
  native `readmodel.cpp`) — the API declared it, neither engine answered it, so
  EditorTabs' existing read was always false. CompositionSummary and Smart
  Animate now read it from the mirror.
- **The motion-blur master is `CompSettings.motionBlur.enabled`.** The
  Compositing card and the Preview menu read the mirror and write
  `setCompositionSettings`; turning a layer's motion blur on turns the master
  on in the SAME batch (Layers switches, the timeline switch column) — before,
  a store write outside history.
- **Document-change triggers use the mirror's `doc` key** (autosave, cloud /
  local thumbnail workers): once per engine batch, writes around the engine
  included; a landed video decode is not a revision.
- **Panels:** the command palette's layer / comp lists, the export form
  (chapters, range, transparent seed, name), the render queue's job, the Time
  Stretch dialog (rate, bar, footage-or-bake), the paint tool options.
- **Classification** (`PURE_READS`, each checked: arguments, a static table or
  the editor's own module state): easing vocabulary, the keyframe-assistant
  maths, bounce / stagger planning, the keyframe clipboard's entries, the user
  preset library count, `previewChoreography` (transport only), SVG toasts,
  `clampSignedStretch`, `propertyResetValue`; `expandKeyframeProp` is a string
  table (Position → x/y/z), not engine state.

What came off in the B4 finish, and why each is sound:

- **Engine wiring out of the UI shell.** The expression engine's providers
  (`layer()`, `thisComp`, `sourceRectAtTime`, `toComp`, `marker`, `ctrl()`,
  audio level, the change sink) moved from `Providers.tsx` to
  `core/engine/expressionProviders.ts`; App's `SceneGraphChanged →
  syncFromScene` bar upkeep to `core/engine/timelineUpkeep.ts`; PluginHost's
  write-path hook to `plugins/authoredWriteHook.ts`. They read the TS
  engine's document because they ARE the engine; they leave with it (D1).
  Plugin management (`pluginHost.*` — install, list, logs, panels) no longer
  counts as a document read.
- **Classification.** A @core module that uses `useProjectStore` is an engine
  reader only when it mentions `comps` (rule D's own test — tabs, dirty flags
  and the active tab are session state). Camera-navigation dispatch
  (`orbitNavBy`, `trackNavBy`, `dollyNavBy`, `smoothDollyNavBy`,
  `cancelSmoothDolly`) is a tool operation in the engine-side tool port, not a
  read (`TOOL_DISPATCH` in the rule); choosing the camera
  (`findNavTarget`, `resolveOrbitPivot`) stays counted.
- **Conversions.** The timeline stopwatch / key diamond (`appEdits`) decide
  "animated" from the mirror's key list.

The remaining reads fall into these categories. The first three stay until
their owner moves into the engine process; the rest are ordinary conversions
(§1) that were not sound to do blind.

| Category | ≈ Sites | Why it is still a direct read |
|---|---|---|
| **Per-frame playhead reads in the viewport** — overlays and gizmos (motion path, puppet / bone / IK, gradient and focus-plane handles, text-edit box, 3D axis widget, paint space, track points) drawing evaluated geometry (`readGeometry`, `motionPath*`, world matrices, `sample`, `evaluateNode`) | 75 | They redraw on every played frame. The mirror is asynchronous — `valueAt` answers the last known value until a batched `getPropertyValues` lands — and a query per played frame is forbidden (§2). They move with the viewport (C/D5): the engine returns `getLayerTransforms` / `getMotionPath` / `hitTest` answers with the frame it renders. **Left on purpose.** |
| **The TypeScript renderer's inputs in the page** — `useViewportRenderer`, `useLayerViewerRenderer`, Presentation, Source Monitor, export preview (`buildSnapshot`, `compSizeOf`, snapshot signatures) | 32 | The renderer still runs in the page and its input IS the engine's document; D5 moves it into the engine process behind the flag. Not a display read to convert. |
| **Engine jobs run from the UI** — tracking / scene-edit detection / auto-trace / bake (`@core/tracking`, `sceneEditCommand`, `bakeCommands`), and the command builders the palette calls (`build*Commands`) | 35 | Analysis that reads pixels and the document engine-side and returns commands. The API has `startJob` but these jobs are not registered as engine jobs yet (G-phase). |
| **Legacy revision plumbing** — `useSceneRevision`, `useNodeRevision`, bus `AnimationChanged` / `SceneGraphChanged` / `NodeUpdated` subscriptions | 36 | Re-render triggers of components that still read the scene graph (CharacterPanel, EffectsPanel's mask list, the Inspector sections in the exit table, the viewport renderers, the App shell); each goes when its component reads the mirror. Engine-side upkeep that FEEDS the scene revision (`Providers` AnimationChanged → bumpScene, historyStore's snapshot listeners, `useSceneRevisionFrame` itself) leaves with the TS engine. |
| **Timeline controller** — `getLayersForNode` / `getRemappedTime` in the app-shell and clip commands, the transport pump, roll limits, footage assembly, transcripts | 19 | Transport and document facts the mirror has are converted (B4-more); what remains needs clip GEOMETRY (source windows after stretch / remap, `clipGeometrySignature`) or IS the TS clock (`usePlaybackClock`'s tick). |
| **App-shell commands** (`Providers.tsx` 73, `App.tsx` 29, `appEdits` 17) — command-palette `enabled` predicates, Select All, selection pruning on scene change, the property-reveal commands | ~120 | Each predicate reads a node / kind / animated fact at call time. The ones left rely on non-catalog tracks (`animatedProps` over every stored track: Time-Reverse / Easy Ease All / reveal-animated), on the scene graph's node set (Select All walks `traverse` — the graph's nodes, not the API's layers + items; selection pruning runs synchronously with legacy writes the mirror sees a microtask later), or are command builders / engine jobs (row 3). |
| **Panels not converted yet** — Layers tree (`sceneRows`: built from a `SceneGraph` the ordering tests pass in), Character panel, the Effects panel's mask list, Composition Settings' draft (the store's `CompositionSettings` record, gradient paint included), footage assembly, templates | ~200 | Ordinary §1 conversions; several touch the §4 gaps (modifier stacks, per-member expressions, plugin layer kinds, stroke units, media type) and keys outside the catalog (a mirror conversion would silently drop them). The Inspector's and the timeline's are all named in the exit table below. |
| **Keyframe assistants / stagger** (`appEdits` `layerKeys`, `hasKeys`) | 6 | The legacy assistants act on EVERY stored track, including tracks outside the catalog; the mirror lists API properties only, so converting would change which keys move. Needs the catalog to cover those tracks first (B3z/G1). |

### The B4 exit for the Inspector and the timeline (2026-09-24)

"Inspector/timeline render from the mirror only": every display read the
mirror can answer is converted. **Inspector 107** (from 112) and **timeline
23** (from 69) remain, and each is one of the reasons below — none is an
unconverted ordinary read. Each site carries a `B4-gap` / `B4-kept` comment
(or sits under one) naming what would close it. Per-file counts:
`node scripts/lint/engineReadsReport.mjs --files inspector` / `--files timeline`.

**Inspector (107)**

| Reason | Sites | Where | Closes with |
|---|---|---|---|
| **Engine jobs** — tracking and its apply / solve plans | 18 | `trackMotion/trackMotionActions` 13, `trackMotion/trackApplyEdits` 5 | registered engine jobs (G-phase; row 3 above) |
| **Engine jobs** — audio decode and analysis (envelopes, waveform, ducking, gate, silence, voice) | 12 | `AudioControls` 2, `AudioDriverSection`, `AudioWaveformSection`, `DuckingDialog`, `GateDialog` 2, `SilenceRemovalDialog`, `MediaSection` (`audioVoiceFor`), `audioEdits` 3 | an audio-analysis job / query on the engine's decoder |
| **Engine jobs** — particle / physics bakes, 3D IK pose and bake, environment SH | 5 | `ParticleSection`, `PhysicsSection`, `Ik3DSection`, `ikEdits`, `LightSection` (`ensureEnvironmentSh`) | engine jobs; SH is render infrastructure (D) |
| **Engine jobs** — proxy generation / attach / detach / cancel | 4 | `ProxyRow` | proxy jobs as engine jobs (C-phase) |
| Rig: live bone pose, IK goals and chain mode (rig tracks sampled by the animation engine), the skinning mesh (scene node + decoded alpha) | 8 | `BoneControls` | a rig-track sampler query; mesh building engine-side |
| Drawn geometry: a layer's evaluated box (`readGeometry`), world bounds for Align | 5 | `appearance/StrokeRows` 2, `trackMotionActions` 2 (SAM segment box), `inspectorEdits` (`planAlign`) | `getLayerBounds` / `getLayerTransforms` answers (C/D5) |
| Text layout: point ↔ paragraph conversion and box auto-size measure the text as it renders and hold it still through the evaluated pose; Swap Fill/Stroke composes per Text component | 11 | `paragraphTextCommands` 10, `textCommands` | a `getTextLayout` query (lines, box, fit scale); path-addressed text writes |
| Inserted-element tag `__mographId` and its component-prop fields | 7 | `MographParamsSection` | a `layer/mographId` field |
| SVG layer's stored document / retained source (convert, revert) | 9 | `svgLayerActions` 6, `SvgSection`, `inspectorSectionParts` 2 | a `layer/svg` json field |
| Essential Properties a comp publishes (`__essentialProps`) | 5 | `CompOverridesSection` 2, `ColorKfRow`, `PinnedSection`, `propertyRowMenu` | a `CompInfo.essentialProps` |
| Keyframe clipboard captures TS keyframe records | 1 | `propertyRowMenu` (`copyKeyframeAt`) | the clipboard in API form (paste already sends engine commands) |
| Layer time config: freeze and its time, a baked stretch (`fx.__bakedStretch`), an EXR's Cryptomatte set | 5 | `CompositingSection` 4, `MediaSection` (`getNodeLayerTime`) | `LayerTiming.freeze?`, the baked factor on `LayerTiming`, a cryptomatte datum on the item |
| Item media type (still / video / audio / svg) and probe state | 6 | `MediaSection`, `CustomLayerSection`, `LightSection`, `MaterialSection`, `ParticleSection`, `ProxyRow` (+ the proxy record) | `ItemInfo.mediaType` (+ `ItemInfo.proxy`) |
| Path operators' Wiggles/Second and Correlation (not in the catalog) | 4 | `PathOpControls` | `contents/<opId>/…` properties |
| Primitive's STORED params (a type switch fills unstored ones from the new type's defaults) | 2 | `PrimitiveSection` | the engine sizing the layer box on `primitive/type` |
| Plugin layer record (`__schemaVersion`, component id; `generator` is '') | 1 | `CustomLayerSection` | `layer/pluginSchemaVersion` + a working `generator` |
| Model blend-shape names | 1 | `ModelSection` | `model/targetNames` |
| Component-id write layer / raw stored props (Style opacity, stored per-corner radii, the generic component list) | 3 | `StylePresetsSection`, `appearance/CornerRows`, `components/Inspector/NodeInspector` | path-addressed writes; absent-vs-default in the catalog |

**Timeline (23)**

| Reason | Sites | Where | Closes with |
|---|---|---|---|
| The transport pump — `tick` advances the TS clock every played frame | 1 | `usePlaybackClock` | the engine's transport clock (C/D) — per-frame, kept on purpose |
| Keyframe assistants / choreography act on the stored MEMBER tracks (every stored track, catalog or not) | 9 | `SmootherDialog` 2, `WigglerDialog`, `assistantPreview`, `MotionEditorPanel`, `ChoreographySection` 3, `useTimelineKeys` (Smooth Motion Path) | per-member key lists in the API / the catalog covering those tracks (B3z/G1) |
| Keyframe clipboard (Ctrl+C) | 1 | `useTimelineKeys` | the clipboard in API form |
| Expression preview evaluates a draft per member and Source Text's text+style result | 3 | `ExpressionEditor` | `evaluateExpression` with `member?` and a textDocument result |
| Multicam: playable media URL, the `__multicamAngle` tag, audio-sync analysis, the angle cut (a legacy write) | 4 | `MulticamViewer` | an ItemInfo media URL, `layer/multicamAngle`, an engine job |
| Clip geometry: roll limits need the clips' source windows | 1 | `useClipDrag` | clip source-in on `LayerTiming` or a `rollLimits` query |
| Lift has no API command (`rippleDeleteRange` is Extract and reports no counts) | 2 | `clipEditCommands` | a `liftRange` (delete range without ripple) returning split / delete counts |
| Save as preset captures the layer as a preset | 1 | `MotionPresetsPanel` | a `capturePreset {layer}` query |
| The AE row projection (sections, order, placeholder rows, legacy track names) | 1 | `buildPropertyRows` | moving the projection onto the mirror tree, a parity-checked step |
