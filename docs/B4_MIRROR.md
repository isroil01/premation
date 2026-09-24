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

## 5. What is left (2026-09-24: 765 reads, from 852)

The ratchet (`node scripts/lint/engineReadsReport.mjs`) by area: viewport/tools
239, other 135, inspector 112, timeline 69, AI/plugins/commands 66,
comps/assets/dialogs 61, layers 41, text 25, effects 17. By kind: helper 452,
singleton 153, store 67, revision 46, timeline 42, viewport 5.

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
| **Legacy revision plumbing** — `useSceneRevision`, `useNodeRevision`, bus `AnimationChanged` / `SceneGraphChanged` / `NodeUpdated` subscriptions | 46 | Re-render triggers of components that still read the scene graph; each goes when its component reads the mirror (a `useMirror*` subscription replaces it). |
| **Timeline controller** — clip geometry, `getLayersForNode`, markers, `getRemappedTime` in clip-edit commands, fit, the multicam viewer | 42 | The mirror carries `layer.timing` and markers; callers that need clip GEOMETRY (bars after stretch / remap, `clipGeometrySignature`) have no mirror field yet. |
| **App-shell commands** (`Providers.tsx` 73, `App.tsx` 28) — command-palette `enabled` predicates, Select All, selection pruning on scene change, the property-reveal commands | ~100 | Each predicate reads a node / kind / animated fact at call time; convertible one by one to `documentMirror()` + `uiKindOf` / `isTrackAnimated`, but several rely on non-catalog tracks (legacy data tracks) the mirror does not list. |
| **Panels not converted yet** — Layers tree (`sceneRows`: built from a `SceneGraph` the ordering tests pass in), Inspector tracker / paragraph / bone / mograph / SVG sections, Character panel, effect browser previews, export form, asset assembly | ~250 | Ordinary §1 conversions; several touch the §4 gaps (modifier stacks, per-member expressions, plugin layer kinds, stroke units) and keys outside the catalog (a mirror conversion would silently drop them). |
| **Keyframe assistants / stagger** (`appEdits` `layerKeys`, `hasKeys`) | 6 | The legacy assistants act on EVERY stored track, including tracks outside the catalog; the mirror lists API properties only, so converting would change which keys move. Needs the catalog to cover those tracks first (B3z/G1). |
