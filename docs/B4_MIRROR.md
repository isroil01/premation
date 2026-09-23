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
