# B3 patterns — moving a UI write onto the engine API

> NATIVE_CORE_PLAN §5 **B3**: every UI write to the document goes through the
> engine API (docs/ENGINE_API.md). This file is the conversion guide for the
> area migrations. The foundation (B3-0) and one reference slice — the Layers
> panel's eye / lock / solo / shy switches and the Inspector's Opacity row —
> are in the tree; every snippet below is from that code.

## 0. The pieces

| Need | Use | Where |
|---|---|---|
| The engine | `engine()` → `EngineClient` (the session's `LocalEngine`) | `src/core/engine/engineInstance.ts` |
| One user action = one undo entry | `await edit(label, commands)` — always a batch; a typed error is toasted and changes nothing | `src/core/engine/uiEdits.ts` |
| A drag = one undo entry | React: `useGesture()` → `begin(label, e?)` / `send(cmds)` / `end()` / `cancel()`; non-React: `new GestureSession(label)` | `src/hooks/useGesture.ts`, `uiEdits.ts` |
| Property paths | `paths.*` (pure builders), `propRefForTrack(nodeId, track)`, `propRefForComponentProp(nodeId, componentId, key)`, `memberWrite(...)`, `values.*` | `src/core/engine/propRefs.ts` |
| Inspector value / stopwatch / diamond over a selection | `valueCommands`, `stopwatchCommands`, `keyframeToggleCommands` | `src/core/engine/propertyCommands.ts` |
| Events across project open/close | `subscribeEngine(listener)`, `onEngineReplaced(listener)` | `engineInstance.ts` |
| Tests | `setupAppEngine()` + `buildScene(h)`; `await engineIdle()` after a click | `src/core/engine/__testHelpers__/appEngine.ts` |
| The ratchet | `npm run lint:engine-writes`, `node scripts/lint/engineWritesReport.mjs --list <area>` | `eslint.engine-writes.config.mjs`, `src/__tests__/engineWriteRatchet.{test.ts,json}` |

### How the engine is wired (what you can rely on)

- **Boot.** `Providers` calls `bootEngine({ ports: createAppEnginePorts(getProjectManager()), … })`
  after `Application.boot` and the history wiring. `engine()` before that (a
  panel rendered alone in a test) boots a portless engine; file/media commands
  then answer `unsupported`.
- **One history.** Engine entries go on the app's `HistoryService`: Ctrl+Z, the
  History panel and the `undo` command walk one list with the legacy recorders'
  entries until B3 deletes those (ENGINE_API.md §15.3).
- **Project lifecycle.** `ProjectLoaded` / `ProjectUnloaded` (Open, New, Close,
  portable-bundle adopt) rebuild the engine over the swapped document: fresh id
  counters, keyframe index, project path. `subscribeEngine` listeners survive
  and receive a `documentReset`. A gesture begun on the old instance is dead
  (its sends and end are dropped). Code that holds the client must call
  `engine()` each time — never cache it. Crash recovery (`ProjectManager.resume`)
  fires no event: the engine sees the restore as an external change and
  resyncs; a caller that swaps the whole document some other way should call
  `rebuildEngine()`.
- **Real ports** (`appPorts.ts`): `openProject`/`saveProject`/`revertProject`
  read and write through `ProjectManager`'s storage (bundle or single file,
  temp + rename); `importFiles` reads by path over the preload bridge and runs
  the asset store's importer (ingest, content addressing, thumbnails) — the
  record is added by the command, so the import is undoable; `relinkItem`
  re-probes with ffprobe; `collectFiles` writes a `.motion` bundle into the
  folder.
- **The legacy panels still refresh.** Until B4's mirror, the app's engine
  runs with `legacyUiRefresh`: after every forward edit it emits
  `AnimationChanged{nodeId}` per touched layer + a scene revision bump
  (structural edits: `SceneGraphChanged`, `DocumentChanged`). So a panel that
  reads the scene graph directly redraws exactly as it did after the old
  helpers. **Do not add `bumpScene()` after an engine command.**
- **Headless.** The CLI render and the export worker mount `Providers`, so they
  have an engine too. Their document changes (captions, auto-reframe in
  `headlessRender.ts`) are core-side builders, not UI writes; they move onto
  the API with the other automation clients in **B5**. Until then the engine
  sees them as external edits (`documentReset{resync}`), which is correct.

## 1. Simple set (a click, a checkbox, a menu item)

Before — `src/core/scene/sceneInsert.ts` (still used by the viewport's context menu):

```ts
runDocumentEdit(label, () => {
  for (const id of ids) {
    const node = defaultSceneGraph.getNode(id);
    if (node) node[flag] = next;
  }
  bumpScene();
});
```

After — `src/layout/Scene/layerSwitchEdits.ts`:

```ts
const patch: LayerSwitchesPatch = { [sw]: next };
const cmds = ids.filter((id) => isLayer(id))
  .map((id) => ({ type: 'setLayerSwitches', layers: [id], patch }) as Command);
await edit(cmds.length === 1 ? verb : `${verb} (${cmds.length} layers)`, cmds);
```

Rules:

- **Decide the new value from a direct read** (`!readSwitch(anchorId, sw)`),
  then send the value — never "toggle" on the engine side. Display reads stay
  direct until B4.
- **No `runDocumentEdit`, no `bumpScene`, no `batchHistory`.** The engine
  records the inverse and refreshes the panels.
- **Label the batch as the user would read it in Edit ▸ Undo.** An empty label
  keeps the command's own (`Layer Switches`, `Set Opacity`).
- **Handlers are `void`-ed promises in JSX:** `onClick={() => { void toggleLayerSwitchAnchored(nodeId, 'visible'); }}`.
- A command answers a **typed error** instead of doing half a job (a locked
  layer, a vanished id, a comp that cannot be 3D). `edit` toasts it; pass
  `{ quiet: true }` when the caller shows its own message and read `res.ok`.
- Something the API does not address yet (here: a composition ROOT's row —
  compositions are items, not layers) keeps the legacy writer **explicitly**,
  with a comment naming the gap; do not invent a command.

## 2. Multi-select batch

One user action over N layers is ONE `edit` with N commands (or one command
that takes many targets: `setProperties`, `deleteLayers`, `setLayerSwitches`
within one comp). A batch is all-or-nothing: if command k fails, 0…k−1 roll
back and the error carries `commandIndex`.

`setLayerSwitches` takes the layers of ONE composition; a selection can span a
precomp and its parent, so the reference sends one command per layer inside
one batch — one entry either way.

Anchoring (the clicked row's state decides the direction for the whole set)
is UI logic and stays in the UI: `anchoredLayerIds(anchorId)`.

## 3. Drag gesture (scrub, gizmo, bar drag)

Before — every move was an independent write that the 700 ms debounce or a
`mergeKey` had to glue back together:

```ts
applyAbsolute(nodeIds, prop, engine, { ...opts, mergeKey, label: `Set ${meta.label}` });
```

After — `src/layout/Inspector/useMultiPropertyField.ts` (`viaEngine`):

```ts
const gesture = useGesture();

const sendValues = useCallback((writes, label) => {
  const cmds = valueCommands(prop, writes, { seconds: time, autoKeyframe });
  if (gesture.isActive()) gesture.send(cmds);   // inside the scrub: one entry
  else void edit(label, cmds);                  // a typed value / reset: one entry
}, [prop, time, autoKeyframe, gesture]);

const onScrubStart = useCallback(() => {
  starts.current = snapshotStarts(nodeIds, prop, time, access);
  if (engineOn) gesture.begin(`Set ${meta.label}`);
}, [/* … */]);
const onScrubEnd = useCallback(() => { if (engineOn) void gesture.end(); }, [engineOn, gesture]);
```

For a pointer drag you own, pass the pointerdown event so the hook captures
the pointer and ends the gesture on `lostpointercapture` / `pointercancel`:

```tsx
const g = useGesture();
<div
  onPointerDown={(e) => g.begin('Move', e)}
  onPointerMove={(e) => { if (g.isActive()) g.send(moveCommands(e)); }}
  onPointerUp={() => { void g.end(); }}
/>
```

What the hook guarantees (pinned by `src/hooks/useGesture.test.tsx`): pointer
up / capture loss / pointercancel / window blur / unmount → **commit**; Escape
→ **cancel** (every edit of the gesture reverts, nothing recorded); `begin`
while one is open ends the previous one first; a gesture leaked by a bug is
committed before the next one opens, so undo never stays blocked.

Rules:

- **Every message carries the absolute value for the current pointer
  position** (start value + delta), never an increment: sends are
  latest-wins, intermediate messages may be dropped.
- **Coalescable commands** (`setProperty`, `setProperties`, `setLayerTiming`,
  `updateKeyframes`, …, see `[coalesce]` in the schema) are the ones to send
  per move — and only in their **absolute** forms.
- **Never send a relative command inside a gesture** (`moveKeyframes {delta}`,
  `moveLayersInTime {delta}`, `trimLayers {delta}`): the engine applies each
  message on top of the previous one and `GestureSession` drops intermediate
  messages, so deltas double-apply or go missing. Compute the target from the
  drag-start state and send `updateKeyframes {time}` / `setLayerTiming`
  (absolute). Relative commands are for one-shot actions (a nudge key press,
  a menu item). Found by the timeline migration; `layout/Timeline/
  timelineEdits.ts` and `keyframeEdits.ts` are the reference.
- **The one exception: a structural step the drag builds on** (Direct
  Selection inserts a vertex at pointer down — `editPathTopology`, relative —
  then reshapes it): send it ONCE as a kept message,
  `send(cmds, { keep: true })` (`GestureSession`, `ToolTransaction`,
  `sendToolEdit(..., { keep: true })`). A kept message is never dropped and
  lands in order; the absolute messages after it stay latest-wins
  (`core/workspace/ports.ts` `sendOutlineEdit`, ENGINE_API.md §15.10).
- **The gizmo moves from pointer state immediately**; the engine's refresh
  follows within a frame. Do not await sends in a pointermove handler.
- **No React state per move** (CLAUDE.md performance rule): `useGesture` does
  not re-render unless you pass `{ trackActive: true }`.

## 4. Keyframes: add / remove / move / ease

- **Times are comp-time flicks**: `compTime(seconds)` (= `secondsToFlicks`). The
  engine converts to each layer's keyframe axis — `compToKeyframeTime` leaves
  the UI with this step.
- **Keyframe ids come from the engine**, never from `makeKeyframeId` /
  `parseKeyframeId` (positional; they change when a key moves). Read them with
  the `getKeyframes` query, keep them in UI state (selection), send them back
  in `deleteKeyframes` / `moveKeyframes` / `updateKeyframes`.

`src/core/engine/propertyCommands.ts`:

```ts
const res = await client.query({ type: 'getKeyframes', props: animated.map((r) => r.ref),
  range: { start: time - eps, duration: 2 * eps } });
const atTime = res.value.sets.flatMap((s) => s.keyframes
  .filter((k) => Math.abs(k.time - time) <= eps).map((k) => k.id));
if (atTime.length > 0) return [{ type: 'deleteKeyframes', ids: atTime }];
return [{ type: 'addKeyframes', keys: animated.map((r) => ({ prop: r.ref, time, spatialIn: [], spatialOut: [] })) }];
```

- **The stopwatch** is `setAnimated` per property (`stopwatchCommands`) — not
  `setKeyframe` + `removeTrack`.
- **Setting a value on an animated property** is `setProperty` with `time`
  (AE setValueAtTime) — it creates or replaces the key at the playhead.
  Auto-keyframe on an unanimated property is `addKeyframes` with a value
  (`valueCommands` decides per layer).
- **Moving keys** in a drag: `updateKeyframes { patches: [{ id, time }] }`
  with each key's ABSOLUTE target time (its drag-start time + the drag
  delta) per move inside a gesture — not `moveKeyframes {delta}` (see §3). A
  multi-key drag release is one undo entry
  (`layout/Timeline/keyframeEdits.ts`). `moveKeyframes {delta}` is right for a
  one-shot nudge.
- **Easing / handles / hold / roving / labels**: `updateKeyframes` patches.
  Easy Ease, Keyframe Velocity, Toggle Hold are client macros that compute
  patches (ENGINE_API.md §1 rule 7).

## 5. Property paths

UI code holds today's track names; the API addresses `/` paths. Never
re-derive the mapping in a panel — `src/core/engine/propRefs.ts` resolves it
through the engine's own catalog:

| You hold | Call | Result |
|---|---|---|
| node + track (`opacity`, `x`, `effect.fx_1.radius`, `mask.m1.feather`, `ta.0.s1.start`) | `propRefForTrack(nodeId, track)` | `{ ref, member, members, valueType }` — `x` is member 0 of `transform/position` unless dimensions are separated; `ta.0` resolves to the animator's **id** |
| node + component id + prop key (`useNodeComponentProp` callers) | `propRefForComponentProp(nodeId, cid, key)` | catalog path, else `camera/…`, `light/…`, `text/…`, `layer/…` by component |
| effect id + param | `paths.effectParam(id, key)`; effect opacity `paths.effectOpacity(id)` | `effects/fx_1/radius`, `effects/fx_1/compositing/opacity` |
| mask id | `paths.mask(id, 'feather' \| 'path' \| 'mode' \| …)` | `masks/m1/feather` |
| text animator / selector id | `paths.animatorProp(aid, p)`, `paths.selectorParam(aid, sid, p)` | `text/animators/a1/props/opacity` |
| layer style key | `paths.styleParam('dropShadow', 'distance')` | `styles/dropShadow/distance` |
| material / geometry / camera / light | `paths.material(p)` … | `material/metal` |
| one member of a vector (X field, a colour channel) | `memberWrite(nodeId, track, n, seconds)` | a whole-value `PropertyWrite` (the API writes Position as one vec2) |
| a static FIELD (G1): a Text component string / choice / switch / box number, an animator or selector field, Path Options ▸ Path, style runs, a fill paint | `fieldCommands(nodeId, path, raw)` (layout/Text/textEdits.ts); component props through `useComponentProp` go there on their own | `text/align`, `text/animators/a1/selectors/s1/basedOn`, `layer/fillPaint` — ENGINE_API.md §15.7 |
| an optional animator property (Add ▸ Property) | `addAnimatorPropertiesEdit`, `removeAnimatorPropertyEdit` | `addProperties` / `removeProperties` |

Values: `values.scalar/vec2/vec3/color/bool/choice/string/layer/json`.
Colours are ONE value (`color`), not four `_r/_g/_b/_a` tracks.

## 6. Compound operations (precompose, split, paste, duplicate, sequence…)

If the API has a command, send it — the engine computes the result and records
an exact inverse (`precompose`, `splitLayers`, `pasteLayers` with a
`copyLayers` fragment, `duplicateLayers`, `sequenceLayers`, `rippleDeleteLayers`,
`createComposition{fromItems}`, `groupLayers`). Do not rebuild them in the UI
from primitives.

If it is pure arithmetic over values the UI can read (align, distribute,
center anchor, easy ease, wiggler), compute the primitives in the UI and send
ONE `edit(label, commands)` — a client macro (ENGINE_API.md §1 rule 7).

If it needs something the TS engine cannot do yet (`convertLayer`,
`separateLayer`, `autoTrace` answer `unsupported`), keep the legacy path for
that operation, say so in a comment, and leave its sites in the ratchet.

Selection after a compound op is the UI's: read the ids from the result
(`const r = await edit(...); if (r.ok) select(r.value[0].layers)`).

## 7. Effect params

`setProperty` on `effects/<id>/<param>` — static or keyed at `time`, exactly
like a transform property. Dropdowns are `choice` values **by label**, checkboxes
`bool`, layer pickers `layer`. Add/remove/reorder/enable are `addEffect`,
`removePropertyGroups`, `movePropertyGroup`, `setGroupEnabled` on the group
path `effects/<id>`. A slider drag is a gesture (§3).

## 8. Reading values for display

**Stays direct until B4.** Panels keep reading `defaultSceneGraph`,
`defaultAnimation`, the stores and the timeline for what they draw, and keep
re-rendering on the bus / revision hooks (`useNodeRevision`, `useSceneRevision`)
— the engine's legacy refresh drives those. Do not add engine queries for
display (B4 replaces all reads with a mirror at once). Use queries only when a
WRITE needs engine-side facts: keyframe ids (§4), a `copyLayers` fragment,
`getPropertyTree` for a generic UI.

## 9. Tests

```ts
let h: Harness & { engine: LocalEngine };
beforeEach(async () => { h = await setupAppEngine(); s = await buildScene(h); });
afterEach(async () => { await h.dispose(); });

await act(async () => { fireEvent.click(lockButton); await engineIdle(); });
expect(historyLabels().at(-1)).toBe('Lock layer');
await h.run({ type: 'undo' });
```

`engineIdle()` waits for every queued request (and its follow-ups, like a
gesture's next message). Commands are asynchronous: a test that clicked and
then read the scene synchronously must now await (see
`src/layout/Scene/ScenePanel.test.tsx`). Pin: one entry per user action, undo
restores exactly (`h.doc()` before === after undo), redo reapplies.

## 10. The ratchet

`engine-writes/no-direct-document-write` (scripts/lint/engineWritesRule.mjs)
counts the remaining direct writes per area; `src/__tests__/engineWriteRatchet.test.ts`
fails if any area goes UP. After migrating: `node scripts/lint/engineWritesReport.mjs --update`
and commit the lower JSON. `--list <area>` prints every site.

It is syntactic: it flags mutator calls on `defaultSceneGraph` / `defaultAnimation`
/ the timeline controller, the pre-API history helpers (`runAnimEdit`,
`runDocumentEdit`, `batchHistory`, …), `updateNodeComponentProp` /
`useNodeComponentProp`, positional keyframe ids, `compToKeyframeTime`, store
writes (comps, assets, the recorder), node view assignments (`node.visible =`),
and any write-verb helper imported from an engine-writing `@core/*` module.
A flagged name that is not a document write goes in `NOT_WRITES` /
`NOT_DOCUMENT_MODULES` in the rule with a reason; inline disables are
ignored by that config on purpose.

Baseline 2026-09-23 (B3-0): **1,413** sites — inspector 509, effects 166,
viewport/tools 164, timeline 143, text 125, AI/plugins/commands 113,
comps/assets/dialogs 80, other 69, layers 44.

B3 is done when every area is 0; the rule then moves into `eslint.config.js` as
an error and the legacy helpers are deleted (ENGINE_API.md §15.3).
