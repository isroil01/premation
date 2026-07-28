# Plugin system audit

> **⚠️ HISTORICAL.** This audited the prototype that has since been replaced.
> Its verdict ("rebuild from zero") was acted on: see
> [`PLUGINS.md`](./PLUGINS.md) for what exists now. Everything below describes
> code that no longer exists — kept because the *reasoning* still governs the
> replacement (why host-realm execution was the thing that was wrong, why
> `registerEffect` was deleted rather than extended, and why the rebuild cost
> nothing).

**Date:** 2026-07-27
**Scope:** Phase 0 only. Nothing was modified.
**Method:** read every file matching `plugin` across `src/`, `packages/`, `electron/`; traced each entry point to its consumers.

---

## Verdict

> **Rebuild from zero — four of the five foundational triggers are hit, and the blast radius is exactly zero: no third-party plugins exist, nothing about plugins is persisted anywhere, and no document can reference a plugin because the format has no field for one.**

Evidence in §0D. The unusual part is the second clause: this is a free decision, so the rebuild question is only about effort, not about breaking anyone.

---

## 0A — What does "plugin" mean here?

**Three unrelated things share the word.** Establishing which is which is the first job.

### 1. `MotionPlugin` — a third-party JS scripting API (the real one)

Defined at [`src/core/plugins/PluginHost.ts:29-35`](../src/core/plugins/PluginHost.ts). A plugin is an object with `id`, `name`, `description`, and `activate(ctx)`. On install, `activate` is called with a `PluginContext` (`PluginHost.ts:17-27`) and may register commands and "effects".

This **is** third-party-facing. `PluginsModal.tsx:54-63` renders a file input accepting `.js,.ts`, and `PluginsModal.tsx:34` feeds the file's text to `pluginHost.installFromSource()`, which evaluates it via `new Function` (`PluginHost.ts:87-92`). Arbitrary sideloading of arbitrary source is the shipped install path.

### 2. `ApplicationPlugin` — an internal engine-registration mechanism

Defined at [`src/core/application/Application.ts:46-56`](../src/core/application/Application.ts), registered at `Application.ts:125-140`. The file's own header (`Application.ts:12-14`) describes it as how "future engines register themselves as plugins at boot". Not third-party-facing, no relation to `MotionPlugin`, no shared code. **The rest of this brief does not apply to it.** It should probably be renamed, but that is out of scope.

### 3. Aspirational comments

`packages/renderer/src/shaders/ShaderRegistry.ts:3` ("future user/plugin effects register the same way") and `packages/scene/src/components/dataComponents.ts:69` ("Enables plugins…"). Both are comments describing intent. Neither has a plugin caller.

### Has it shipped?

- **Reachable in the UI:** yes. `Providers.tsx:972-973` registers a `view.plugins` command; `menuModel.ts:157` puts "Plugins…" in a menu. Not behind a flag.
- **Has any user installed one?** Unknowable directly, but **structurally it cannot have persisted**: the installed set is an in-memory `Map` (`PluginHost.ts:45`), and there is no settings key, no file, and no database column for plugin state anywhere (grep for `installedPlugins`/`pluginState`/`'plugins'` across `src/` returns nothing; `src/core/persistence`, `src/core/project`, `src/core/files` contain no occurrence of "plugin"). Every install is lost on reload.
- **Is there a plugin not written by us?** No evidence of one, and none could survive a reload to be found. The only plugins in the repo are `src/plugins/samplePlugins.ts` (two, first-party).

### The finding that matters most

**`registerEffect` is dead code.** `PluginContext.registerEffect` (`PluginHost.ts:19`, implemented `PluginHost.ts:70`) stores into a map read only by `listEffects()` (`PluginHost.ts:122-124`), and **`listEffects` has zero callers** — grep across `src/` and `packages/` returns only its own definition. `samplePlugins.ts:31-40` registers an effect named `elastic`; it is reachable from nothing and appears in no UI.

Worse, a `PluginEffect` was never a render-path concept in the first place. Its contract is `apply: (nodeId, time) => void` (`PluginHost.ts:13`) and the sample implementation (`samplePlugins.ts:34-39`) just writes keyframes. **It authors document mutations, not pixels.** The word "effect" here means "a macro that keyframes something", which is the same thing the animation-preset system already does properly.

**So: there is no render-path plugin capability in this codebase, not even a stub.** Class 2 and Class 3 of the target architecture are absent, not partial.

---

## 0B — Inventory

### 1. Plugin classes supported

| Target class | Status | Evidence |
|---|---|---|
| **1. Asset packs** (no code) | **Absent as a plugin class**, but the machinery is ~all there under another name | Animation presets have save / apply / delete / folder tree: `animationPresets.ts:480` (`saveCurrentAsPreset`), `:608` (`applyPreset`), `:637` (`deletePreset`), `:261` (`BUILTIN_PRESETS`). Packaging/installing a *set* of them does not exist. |
| **2. Shader effects** | **Absent** | `EffectType` is a closed TypeScript union (`src/core/effects/effects.ts:12-49`). A plugin cannot add a member. No manifest, no shader ingestion path. |
| **3. WASM effects** | **Absent** | No WASM anywhere in the plugin path. |
| **4. Panel / command plugins** | **Commands: partial and working. Panels: absent.** | Commands: `PluginHost.ts:69` → real command registry, searchable in the palette. Panels: there is no iframe in the entire app — grep for `<iframe`/`sandbox=` across `src/` returns nothing. |

> ⚠️ **The brief's line citations are stale.** It cites `animationPresets.ts:174, 519-544` and `EffectsPanel.tsx:58, 153-160`. Those numbers predate today's preset work; `animationPresets.ts` has since grown. Current locations are in the table above. `EffectsPanel.tsx` is 319 lines and contains no plugin or vendor reference at all.

### 2. Execution model

**Host realm, directly, with no isolation of any kind.**

- Bundled plugins: `plugin.activate(ctx)` is called inline at `PluginHost.ts:77`.
- Sideloaded plugins: `new Function('pluginHost', 'defaultSceneGraph', 'defaultAnimation', …)` at `PluginHost.ts:87-92`, invoked at `:93`.

No Worker, no iframe, no WASM, no GPU. The only Worker in the app is `src/workers/thumbnailWorker.ts`, unrelated.

### 3. Manifest

**None.** The "manifest" is the four inline fields of the `MotionPlugin` object literal (`PluginHost.ts:29-35`): `id`, `name`, `description`, `activate`. No version, no vendor, no `minHostApi`, no type, no permissions, no parameters, no entry point.

`id` is a bare string (`'elastic-overshoot'`, `samplePlugins.ts:12`) — not reverse-DNS, not namespaced, and collision between two vendors is silent: `install()` returns early on a duplicate id (`PluginHost.ts:65`).

### 4. Parameters

**Plugins have no parameters at all.** There is no parameter concept in `PluginContext`, in `PluginEffect`, or in `MotionPlugin`. A plugin's behaviour is hardcoded in its `activate` body. Nothing to render, nothing to keyframe, nothing in the property registry.

### 5. Render integration

**There is none.** No plugin path reaches `layer.effects`, `buildSnapshot`, `snapshotToFrameScene`, or the render graph. A plugin's only route to pixels is indirect: writing keyframes on native properties via `ctx.animation` (`PluginHost.ts:72`), which the native renderer then draws. GPU resources are never exposed to a plugin because a plugin never reaches the GPU.

### 6. UI surfaces

One: a modal (`PluginsModal.tsx:91-93`), opened from the command palette and a menu item (`Providers.tsx:972-973`, `menuModel.ts:157`). Plugin-registered *commands* also appear in the command palette, which is the one part working as intended. Plugins appear nowhere in the effects browser.

### 7. Install / manage / uninstall

- Install: `PluginHost.install()` (`:64`), or `installFromSource()` from a picked file (`PluginsModal.tsx:26-50`).
- Uninstall: `PluginHost.uninstall()` (`:108-116`) — unregisters commands and drops effects, calls an optional disposer.
- **Persisted state: none.** `installed` (`:45`) and `userPlugins` (`:47`) are in-memory fields. Reload = everything uninstalled, and a sideloaded plugin's source is gone with it.

### 8. Permissions and sandbox

**No permission model.** `PluginContext` hands out live references to the real singletons — `scene: defaultSceneGraph` and `animation: defaultAnimation` (`PluginHost.ts:71-72`). A plugin has the same authority as the host: full read/write of the document, plus everything reachable in the host realm through `new Function` (`window`, `fetch`, `localStorage`, the DOM).

The **one** boundary that exists is on the postMessage bridge (`PluginHost.ts:153-177`): messages are ignored unless the sender was registered via `registerFrame` and is still on its registered origin (`:158-159`). It is well built and tested (`pluginBridge.test.ts`). **But `registerFrame` has zero non-test callers**, and no iframe exists in the app — so the bridge is currently unreachable machinery guarding a door into a room with no wall.

### 9. Documents

**A document stores nothing about plugins.** Project serialization (`src/core/project/projectDocumentIO.ts`, version `'1.1.0'` at `:27`) writes the scene graph; there is no plugin field anywhere in the format. Because a plugin's only effect is writing ordinary keyframes, its output is **indistinguishable from a user's manual edit** once written.

This has one good consequence and one bad one:
- Good: no document can be broken by changing the plugin system.
- Bad: plugin contribution is unattributable and untrackable — you cannot find which projects used a plugin, or undo a plugin's contribution as a unit.

---

## 0C — Rubric

### Architecture

| Question | Answer | Evidence |
|---|---|---|
| Render-path and document-path plugins separate? | **No** — but not by conflation. Only the document path exists; `registerEffect` (`PluginHost.ts:19`) *names* itself render-path and is a document mutator (`samplePlugins.ts:34-39`) that nothing consumes. | |
| Render-path call synchronous? | **N/A** — no render-path call exists. |
| Stable immutable id, used as the document key? | **No.** Bare non-namespaced string (`samplePlugins.ts:12`); documents contain no plugin key at all. |
| Versioned host API with `minHostApi`? | **No.** No version field on either side. |

### Determinism

| Question | Answer | Evidence |
|---|---|---|
| Can a render-path plugin `fetch` or import at runtime? | **N/A (no render path)** — but any plugin can: `new Function` bodies run in the host realm (`PluginHost.ts:87`) with full global access. |
| Read a wall clock? | **Yes**, same reason. |
| Unseeded randomness? | **Yes**, same reason. |
| Time supplied by host? | **Partially, by accident.** `PluginEffect.apply(nodeId, time)` (`PluginHost.ts:13`) passes a time; nothing calls it. |
| Test that a frame renders identically twice? | **No** for plugins. (The engine has `packages/render-tests`, but no plugin participates in it.) |
| Test that preview and export agree? | **No** for plugins. |

### Parameters

All five: **No.** There is no parameter concept — see §0B.4.

### Render contract

| Question | Answer |
|---|---|
| Host allocates all GPU resources? | **Vacuously yes** — plugins have no GPU access whatsoever. |
| Bounds growth declarable? What happens to a glow at the layer edge? | **No such concept for plugins.** For *native* effects the host does compute padding (`rasterPadding`, `src/core/rendering/raster/vectorDraw.ts:172`), so the capability exists to build on. |
| Point vs spatial declared? | **No.** |
| Same pipeline stage as a native effect? | **N/A** — plugin effects never render. |

### Portability

**Untestable as specified, and that is itself the finding.** The brief says to open a document referencing an uninstalled plugin and see what survives. **No document can reference a plugin** (§0B.9), so there is nothing to open. A plugin's keyframes survive perfectly — because they are ordinary keyframes with no plugin identity attached, which is the same reason nothing can be attributed, updated, or repaired later.

### Security

| Question | Answer | Evidence |
|---|---|---|
| `eval` / `new Function` / dynamic `import()` of plugin code in the host realm? | **Yes — `new Function`.** `PluginHost.ts:87-92`, reached from a user file picker at `PluginsModal.tsx:34`. |
| Plugin UI in a sandboxed iframe without `allow-same-origin`? | **No plugin UI exists.** No iframe in the app. |
| Timeout / terminate for looping plugin code? | **No.** A `while(true)` in `activate` hangs the editor permanently; there is no Worker to terminate. |
| Permissions declared and shown before install? | **No.** |

**Assessment:** the sideload path is a full arbitrary-code-execution surface presented as a file picker. It is mitigated only by requiring a deliberate user action and by not persisting — a malicious plugin does not survive reload. The postMessage bridge, by contrast, is genuinely well hardened (`PluginHost.ts:158-159` + `pluginBridge.test.ts`); it is the one piece of security work here worth preserving.

### Operations

| Question | Answer |
|---|---|
| Per-plugin frame cost measured? | **No.** |
| Plugin Manager, enable/disable, uninstall? | **Partial.** `PluginsModal.tsx` lists and toggles install/uninstall. No enable/disable distinct from uninstall, no versions, no permissions display, no cost, no update status, no vendor. It is a list with a button. |

---

## 0D — Verdict and how it was reached

**Rebuild from zero.** Triggers hit:

1. **Render-path and document-path share one mechanism — hit, in the worst form.** They do not merely share a mechanism; `registerEffect` (`PluginHost.ts:19`, `:70`) presents itself as the render-path API while being a document mutator that nothing reads (`samplePlugins.ts:31-40`, zero `listEffects` callers). Extending this means first deleting the thing that claims to be the feature.
2. **Plugin code executes in the host realm — hit, decisively.** `new Function` at `PluginHost.ts:87`; direct singleton handles at `PluginHost.ts:71-72`. The brief's own words apply: there is no sandbox retrofit, the execution model *is* the thing that is wrong.
3. **Render-path call is async — not applicable**, since no render call exists. This is the one trigger not hit, and only because the capability is absent.
4. **Effect plugins draw their own parameter UI — hit vacuously and worse.** They do not draw parameters; they have none. Every plugin's behaviour is hardcoded, so nothing is preserved by extending.
5. **No stable plugin id in documents — hit.** Documents carry no plugin reference at all (`projectDocumentIO.ts`).

Four of five, and each is foundational. Against the "extend if" list: every item there presumes a working execution model, a manifest, and declared parameters. None of the three exists.

**Honest qualifier on the word "rebuild":** the thing being rebuilt is ~450 lines (`PluginHost.ts` 185, `PluginsModal.tsx` 93, `samplePlugins.ts` 64, `pluginBridge.test.ts` 73, CSS 95). This is closer to "the feature was prototyped and never finished" than to "a mature system needs replacing". The verdict is not a criticism of a large investment — it is the observation that there is very little here, and what there is points the wrong way.

**Worth keeping from the existing code:**
- The postMessage origin-gating and its tests (`PluginHost.ts:138-177`, `pluginBridge.test.ts`) — directly reusable for Class 4 panels, which is exactly what it was built for.
- The command-registration path (`PluginHost.ts:69`) — the one part that works end to end.
- The preset save/apply/delete/folder machinery (`animationPresets.ts:261, 480, 608, 637`) as the foundation for Class 1 asset packs, per the brief's own step 1.

---

## 0E — Blast radius

| Question | Answer |
|---|---|
| Plugins against the current API? | **Two, both first-party** (`samplePlugins.ts`). No third-party plugin is known, and none could persist to be found (§0A). |
| Stored documents referencing a plugin? | **Structurally zero.** Not "none found" — the document format has no field capable of holding a plugin reference (`projectDocumentIO.ts`, §0B.9). No backend query is needed to establish this; it is a property of the format. |
| What survives a rebuild? | **Everything in every document**, because no document depends on plugins. The two sample plugins would be rewritten (~60 lines). Any sideloaded plugin a user has is already lost on every reload. |
| Compatibility shim feasible? | **Unnecessary.** There is no stored format to be compatible with. A clean break costs nothing. |

**This is a free decision.** Per the brief's own criterion — "a rebuild with zero installed plugins and zero affected documents is a free decision" — no sign-off with numbers is required. The numbers are zero.

---

## Open forks — flagged, as instructed

**Fork 1 (who can publish?) has already been answered by the implementation, and answered as "open sideloading":** `PluginsModal.tsx:54-63` accepts an arbitrary `.js`/`.ts` file from disk and executes it. If open sideloading is *not* the intended policy, this is a live arbitrary-code-execution path that should be removed regardless of what Phase 1 turns out to be — it is currently the only install mechanism a real user can reach.

**Fork 2 (do we need WASM?)** — the implementation has committed to nothing; there is no WASM anywhere. The default of skipping it for v1 is unobstructed.

**Fork 3 (registry / review / signing / distribution)** — nothing committed. No network path, no registry, no update check.

---

## Two things the audit turned up that the brief did not ask about

1. **`registerEffect` should be deleted whatever happens.** It is unreachable, it misnames a document mutator as an effect, and its existence is the main reason someone could believe this codebase has render-path plugins. Anyone reading `PluginContext` today would reasonably conclude effect plugins work.
2. **The naming collision with `ApplicationPlugin`** (`Application.ts:46`) will keep costing time. Two unrelated concepts, one word, both in `src/core/`.

---

## Stop condition

Audit complete. Verdict delivered. **No code written, nothing modified.** Awaiting direction before Phase 1.
