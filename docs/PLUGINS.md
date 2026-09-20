# Plugins: architecture and authoring guide

**Status:** shipped.

> **Plugins run in both editions.** A local (`VITE_EDITION=local`) build
> installs plugins from local files — a `.zip`, a `.mplugin` or a folder, from
> the Plugins panel's **Add plugin** menu or by dropping the package on it —
> through the same manifest check, consent screen, signature verification and
> Worker sandbox as the hosted build. What needs motion-back stays server-only:
> browsing and downloading from the registry, update checks, the revocation
> list, account sync of the installed set, and publishing.
> `pluginsEnabled()` gates the feature (true in both), `pluginRegistryEnabled()`
> gates everything that talks to the registry (server only), and the main
> process registers the publish channels only when `pluginPublishEnabled()`.
> A project containing plugin content opens, edits and saves losslessly
> without the plugin: custom layers, plugin effects and proxy subtrees
> round-trip byte-for-byte, including the `plugins[]` block naming id and
> version.
>
> The cross-repo system reference is
> [`PLUGIN_SYSTEM_REFERENCE.md`](PLUGIN_SYSTEM_REFERENCE.md). When it and this
> file disagree, **the code decides, then that file, then this one.**

---

## 0. The one-paragraph version

A plugin is a **package** — `plugin.json` plus an ES module — that the user
installs from a `.zip` or a folder. The manifest is validated and its requested
permissions shown **before any code exists anywhere**; only after the user
accepts does the package's entry module get sent to a dedicated **Worker**,
which locks down its own network globals and then imports the code. From there
the plugin can only send messages naming API methods; the host checks each one
against the permissions that were granted and executes it inside
`runDocumentEdit`, so anything a plugin changes is a single undo. A plugin that
wedges its event loop stops answering a heartbeat and is terminated — the editor
never notices. Installs persist across reloads.

```
 pick .zip / folder
        │  readPluginZip / readPluginFolder      ← bytes → files, no execution
        ▼
   plugin.json ──► parseManifest                 ← strict: id, semver, apiVersion,
        │                                          safe paths, known permissions
        ▼
   consent screen  ("this plugin will be able to: …")
        │  user accepts
        ▼
   pluginStore ──► PluginDatabase                ← index AND payload, ONE
        │          (IndexedDB, one transaction)    transaction; survives reload
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
        │ METHOD_PERMISSIONS[method] granted?     │  no → refused, by name
        ▼                                         │
   hostApi[method](...)  inside runDocumentEdit ──┘   ← one undo entry
```

---

## 1. The threat model, and why it is a Worker

The previous host evaluated a user-picked `.js` file with `new Function` **in
the page's realm**, with live `defaultSceneGraph` / `defaultAnimation` handles
bound in. That is not "scene access"; it is everything the page can do.

What "everything the page can do" is worth has since changed, and in the right
direction. The renderer used to hold two things worth stealing — the account
bearer JWT and the user's own AI provider keys — and the sandbox was partly
justified by that. **On the desktop build it now holds neither.** Provider keys
live in the main process behind a write-only vault with no read-back verb
(`electron/aiKeyVault.ts`); the session tokens live there too, and the renderer
asks for REQUESTS to be made rather than for the credential that makes them
possible (`electron/apiSession.ts`, `electron/apiProxy.ts`).

That does not make the sandbox less necessary. It changes what a sandbox escape
costs, from "the attacker now has the user's account and their provider billing,
permanently" to "the attacker can act as the user while the app is open". Those
are different incidents. The controls are layered deliberately: the sandbox
bounds what plugin code can reach, and the credential split bounds what reaching
it is worth.

"The user chose the file" is not a control. Downloading plugins from strangers
is the normal distribution model for creative tools — it is exactly what After
Effects users are conditioned to do — so social engineering is the expected
attack, not an exotic one.

| Failure | Host realm + `new Function` | Worker sandbox |
|---|---|---|
| Plugin loops forever | Editor frozen permanently | Worker terminated in ~12 s, editor untouched |
| Plugin reads the JWT / AI keys | `localStorage.getItem(…)` | No `localStorage` in a worker realm — **and neither secret is in the renderer at all on desktop** |
| A non-plugin renderer compromise (XSS, a bad dependency) | Takes both secrets | Can spend the session while the app runs; cannot take it elsewhere |
| Plugin phones home | `fetch(…)` | `fetch` replaced with a throwing stub before import |
| Plugin reads the UI / forges clicks | Full DOM | No `document`, no `window` |
| Plugin deletes the project | Direct singleton handle | Needs `scene:write`, and it is one Ctrl-Z |
| User reloads | Everything uninstalled | Installs persist and restart |

Verified live: a plugin's own probe reports
`fetch:DENIED XMLHttpRequest:DENIED WebSocket:DENIED importScripts:DENIED
indexedDB:DENIED localStorage:ABSENT document:ABSENT window:ABSENT`, and a
`while(true)` command returns control to the editor immediately and is killed by
the heartbeat.

**Panels** get the same treatment on the UI side: `sandbox="allow-scripts"`
**without** `allow-same-origin`, so the frame has an opaque origin and cannot
read this document, our cookies or our `localStorage`. Its only exit is
`postMessage`, which the host accepts solely from frames it registered, on the
origin it registered them with, and forwards **only to the worker that owns that
frame** — routing comes from the registration, not from anything the message
says. A panel cannot name an API method, a layer, or another plugin.

The panel document is loaded from `public/plugin-panel.html` and receives the
plugin's markup by `postMessage` after load. It used to be delivered with
`srcdoc`, and that quietly made the entire panel feature decoration: a `srcdoc`
document **inherits the embedder's CSP**, the app ships `script-src 'self'` with
no `'unsafe-inline'`, and a panel is by definition inline script — so panels
rendered as static markup, `motionPanel` was never defined, and not one message
ever reached a plugin. No error, no clue. A document's own `<meta>` policy can
only *add* restrictions, so the frame could not opt back in; loading it from a
real URL is the only way to give it a policy of its own.

That policy (in the shell) is **tighter** than the app's for everything except
inline script: `default-src 'none'`, `connect-src 'none'`. Verified live — a
panel's `fetch` fails and a remote `<img>` is refused.

This stays true now that `net:fetch` exists, and it is deliberate. A plugin
granted network access does **not** get a panel that can reach its declared
hosts — widening the shell's `connect-src` would hand the capability to the
wrong realm. A panel is inline script from the package with nothing between it
and the socket; a worker's request goes through the host, which checks the
permission, the grant and that plugin's own manifest, then caps redirects, size
and rate. `noHostRealmEval.test.ts` refuses the change.

---

## 2. File map

| Concern | File |
|---|---|
| Manifest schema + validation + permission text | `src/core/plugins/manifest.ts` |
| `.zip` / folder reading, size and zip-slip limits | `src/core/plugins/pluginPackage.ts` |
| Wire protocol + method→permission table | `src/core/plugins/protocol.ts` |
| The sandbox (worker side) | `src/core/plugins/pluginWorker.ts` |
| Worker construction (ESM-only, stubbed in tests) | `src/core/plugins/spawnPluginWorker.ts` |
| Method implementations (host side) | `src/core/plugins/hostApi.ts` |
| Install / supervise / permission gate / panels bridge | `src/core/plugins/PluginHost.ts` |
| Persistence | `src/stores/pluginStore.ts` |
| The plugin list (sidebar + dashboard) | `src/layout/Plugins/PluginsList.tsx` |
| A plugin's page: listing, status, log, permissions, reload | `src/layout/Plugins/PluginDetailTab.tsx` |
| Consent screen + its overlay | `src/layout/Plugins/ConsentSheet.tsx` |
| Install from disk (menu, drop, folder) | `src/layout/Plugins/useDiskInstall.tsx` |
| Layer-kind schema + validation | `src/core/plugins/layerKindSchema.ts` |
| Custom layers in a document | `src/core/plugins/customLayers.ts` |
| Which kinds exist, and who may touch them | `src/core/plugins/layerKindRegistry.ts` |
| Proxy regeneration + ownership | `src/core/plugins/proxySubtree.ts` |
| IPC: the one validating registration wrapper | `electron/ipcGuard.ts` |
| Session + tokens, in main | `electron/apiSession.ts`, `electron/credentialStore.ts` |
| Authenticated requests + streams, in main | `electron/apiProxy.ts`, `electron/apiBase.ts` |
| Docked panel + sandboxed frame | `src/layout/Plugins/PluginPanel.tsx` |
| Panel host document (its own CSP) | `public/plugin-panel.html` |
| Plugins menu, built from what is installed | `src/layout/Menu/pluginMenu.ts` |
| Starter template generator | `src/layout/Plugins/starterPlugin.ts` |
| Native ABI + version check (renderer) | `src/core/plugins/native/nativeAbi.ts` |
| Which binary, per platform-arch | `src/core/plugins/native/nativePlatforms.ts` |
| Native trust gate + pinned-hash consent | `src/core/plugins/native/nativeTrust.ts` |
| Native call scheduling, budget, export settle | `src/core/plugins/native/nativeScheduler.ts` |
| Native buffer ownership | `src/core/plugins/native/nativeBuffers.ts` |
| The seam the app calls | `src/core/plugins/native/nativeClient.ts` |
| Native process supervisor (main) | `electron/pluginNativeHost.ts` |
| Native IPC: containment, hashing, staging | `electron/pluginNativeIpc.ts` |
| Inside a plugin's process | `electron/pluginNativeChild.ts`, `electron/pluginNativeChildCore.ts` |
| The ABI as a C header + example addon | `packages/plugin-native-sdk/` |

**Tests:** `pluginPackage.test.ts` (format), `pluginHost.test.ts` (lifecycle,
permission gate, argument validation, command namespacing),
`pluginBridge.test.ts` (panel provenance + routing), `noHostRealmEval.test.ts`
(the architectural guard — no `new Function`, no non-literal dynamic import,
lockdown before import, no `allow-same-origin`).

---

## 3. Package format

```
my-plugin/
  plugin.json      required, at the package root
  main.js          the entry ES module
  panel.html       optional UI
```

Zipping the folder is fine — one wrapping directory is stripped automatically.
`node scripts/pack-plugin.mjs ./my-plugin` produces the `.mplugin` archive and
tells you at pack time about the things the editor would otherwise refuse at
install time.

### More than one file

A package is a module **graph**, not one file. Import your own files with
ordinary relative specifiers:

```js
// main.js
import { solve } from './lib/solver.js';
import './lib/register.js';
const heavy = await import('./lib/heavy.js');   // works too
```

Resolution is what a bundler does, not what a browser does: `./lib/solver` finds
`lib/solver.js`, and `./lib` finds `lib/index.js`. Three things are refused, each
with the fix in the message:

| You wrote | Why it cannot work | Do this instead |
|---|---|---|
| `import { mat4 } from 'gl-matrix'` | there is no `node_modules` and no network | bundle your dependencies into the package |
| `import x from 'https://cdn…/x.js'` | a plugin has no network of its own | ship the file |
| `a.js` ↔ `b.js` importing each other | files load in dependency order, so a cycle has none | move the shared code into a third file |
| `import look from './look.cube'` | only `.js` / `.mjs` are modules | `await motion.package.read('look.cube')` |

The cycle restriction is real — ES modules themselves permit cycles. Each file
becomes its own blob URL inside the sandbox, and a blob URL is minted from its
content, so a module cannot be given a URL until every module it imports already
has one. Two files that import each other have no such order.

Stack traces name your files, not the blob URLs: the sandbox substitutes each
URL for the package path it came from before the line reaches the log.

### Files that are not code

```js
const weights = await motion.package.read('models/seg.onnx');   // ArrayBuffer
const wgsl    = await motion.package.read('shaders/blur.wgsl', 'text');
```

`package.read` reads out of **your own package** — the one the user installed.
It needs no permission, because the bytes arrived under the same signature as
your JavaScript and your entry module could already have carried them as base64;
what it replaces is exactly that base64, which is a third more bytes, decoded on
every boot, and invisible to every size check.

Extensions a package may contain, beyond source and markup:

`.png .jpg .jpeg .webp .wasm .bin .onnx .glb .gltf .ttf .otf .woff2 .cube .exr
.hdr .mp3 .wav`

Native modules — `.node`, `.dll`, `.so`, `.dylib`, `.exe` — are **not** in that
list and will not be. A compiled library would run in the application's own
process, which is a separate tier with its own consent and its own signing gate.

| | Registry install | Folder / `.mplugin` on this machine |
|---|---|---|
| One file | 2 MB | 64 MB |
| Whole package | 8 MB | 512 MB |
| File count | 200 | 5000 |

The registry numbers bound what an anonymous publisher can push into a user's
browser storage over the network. The local ones bound a directory the user or
their administrator put on their own disk, which is where a model, a LUT set or
a font actually fits.

```jsonc
{
  "id": "studio.acme.easing-lab",   // reverse-DNS, lowercase, unique
  "name": "Easing Lab",
  "version": "1.2.0",               // semver
  "description": "…",               // shown to the user before install
  "author": "Acme Studio",
  "homepage": "https://…",          // http(s) only
  "apiVersion": 5,                  // the manifest GRAMMAR version
  "main": "main.js",
  "panel": "panel.html",            // optional
  "permissions": ["scene:read", "animation:write"],
  "requires": ["scene.read", "animation.write"],   // optional; see below
  "optional": ["webgpu"]
}
```

### `apiVersion` is about the grammar, not about what you may call

Two numbers, separate from 5 onward:

| Constant | Now | Answers |
|---|---|---|
| `MANIFEST_VERSION` | 7 | what grammar the host can read — `apiVersion` is checked against this |
| `HOST_API_VERSION` | 5 | what the host can do; reported to you at runtime |

They were one number and it made every host-method addition look like a manifest
change, telling authors their manifests were out of date when nothing about them
was. Bump `apiVersion` when you use a newer manifest **field**; use `requires`
to say what the host must be able to **do**.

#### Which version each newer field arrived in

The parser does not refuse keys it has never heard of, so on an older host a
newer field is **silently ignored** — an `expand` that is ignored is an effect
clipped at the layer edge, a `cpu` that is ignored is an effect that vanishes
from every baked layer and from export. Every field below is therefore gated,
and declaring one on too low an `apiVersion` is refused by name.

| Version | Fields that need it |
|---|---|
| 3 | `contributes.layerKinds`, `render: "none"` / `"proxy"` |
| 4 | `contributes.effects`, `contributes.net`, `render: "shader"` |
| 6 | `contributes.presets` · `importers` · `exporters`, `render: "generator"` |
| 7 | an effect's `glsl` · `cpu` · `expand` · `identity` · `threadSafety` · `frames` · `limits`, a **second** `layer` parameter, a pass's `glsl`, and `contributes.inspector` · `tools` · `shortcuts` · `expressions` |

The trade is deliberate and it is worth knowing before you declare 7: a host
older than the version you name refuses the **whole** package. There is no way
to ship these fields and also install on an older host — and that is the point,
because the alternative is a plugin that installs and half works, with nothing
on screen to say which half.

One `layer` parameter is as old as effects are and still installs on API 4; the
second through fourth need 7, because the extra bindings only exist in the
layout this version generates.

### `requires` and `optional`

Capability strings are additive and permanent — never renamed, never removed,
never repurposed, because your manifest is signed and a string that changed
meaning would silently change what you asked for.

`scene.read` · `scene.write` · `scene.proxy` · `scene.batch` ·
`scene.structured` · `animation.read` · `animation.write` · `animation.typed` ·
`assets.read` · `assets.write` · `timeline` · `composition.manage` ·
`audio.analyse` · `net.fetch` · `storage.global` · `storage.project` ·
`effects.single` · `effects.multipass` · `effects.describe` ·
`layerkinds` · `layerkinds.generator` · `layerkinds.shader` ·
`exporters` · `importers` · `presets` · `panels` · `wasm` ·
`ui.inspector` · `ui.canvas` · `ui.tools` · `ui.shortcuts` · `ui.expressions` ·
`webgpu` *(runtime — depends on the machine)*

`effects.describe` and `animation.typed` arrived together with argument
validation (see *Names are checked* below). They are capabilities, not a
`HOST_API_VERSION` bump, per the rule above: a plugin that needs either says so
in `requires` and an older host refuses the install by name.

`requires` is checked at **install**, and a refusal names the reason: a
capability the host knows but this machine lacks ("needs WebGPU") reads
differently from one no version has ever had, which is a typo.

**Put `webgpu` in `requires` if your plugin is only effects.** On the WebGL2
tier a plugin effect renders its input unchanged, so the plugin is not degraded,
it is inert. Refusing to install is a better answer than looking healthy and
doing nothing. Put it in `optional` instead if effects are a bonus, and
feature-detect: `effects.add` answers
`{ active: false, reason: 'webgpu-unavailable' }` there.

**Omitting `requires` is not "I need nothing".** A manifest without one is
treated as needing whatever its `apiVersion` implied before capabilities
existed, so every already-published plugin keeps working. Write one when you
want a specific answer.

Limits: 2 MB per file, 8 MB per package, 200 files, text extensions only. Paths
containing `..` are refused at the format level.

Those ceilings are on the **uncompressed** size, and both readers check them
before allocating anything — the editor in fflate's `filter`, the registry
against the zip's central directory. A ceiling applied after the allocation it
exists to prevent is not a ceiling: 64 MB of zeros stores in 65 KB, so a
compliant 8 MB archive checked on its compressed bytes can unpack to gigabytes.
There is a third check, a 200× inflation ratio, for the archive that stays under
both absolute limits and is still pathological. The registry counts every entry
where the editor counts only the files it keeps — deliberately stricter, since
the promise is one-directional (refuse anything the editor would refuse).

`main` is loaded as **one file** — bundle your plugin if it has dependencies.

### WebAssembly is allowed

`WebAssembly` is **not** removed at lockdown, and `.wasm` is a recognised binary
extension in the package format. Capability: `wasm`.

It is allowed because it does not widen the sandbox, and that is the whole
argument. A `.wasm` inside the package carries the **same signature** and the
same 2 MB per-file cap as the JavaScript beside it, so it is exactly as reviewed
and exactly as attributable. An instantiated module gets **no imports the
plugin's own JS did not hand it** — no DOM, no host methods, no syscalls — so it
reaches precisely what that JS could reach, which is the method table and
nothing else. A wasm module cannot ask the host for anything; your JS asks, as
before. Refusing it would not have shrunk the sandbox, only pushed authors
toward shipping the same algorithm as minified JavaScript, which is harder to
review, not easier.

`WebAssembly.instantiateStreaming` and `compileStreaming` are **removed**, not
merely unused. Both take a `Response`, and a worker with no network has nothing
to give them; leaving them present would be an API that looks available and
fails in a way that reads as a host bug.

> **Gap, stated plainly: the worker cannot read its own `.wasm` file yet.** The
> boot message carries the manifest, the entry module's source, the grants and
> the capabilities — not `binaries`. So today the only way to get a module into
> the worker is to embed it in `main.js` (base64 or a byte array) and
> `WebAssembly.instantiate` that, which works and wastes about a third of the
> per-file budget to encoding. A `package.read(path)` verb is the obvious fix
> and is not built. Until it is, `wasm` in `requires` promises that the *engine*
> is present, not that your file is reachable.

The honest reason to reach for it is a real one — a solver, a codec, a
tracker — not speed on the message boundary, which dominates anything small.

---

## 4. Permissions

| Permission | The plugin can |
|---|---|
| `scene:read` | See layer names, structure and scalar properties |
| `scene:proxy` | Write **only inside its own layer kind's proxy subtree** |
| `scene:write` | Create, change and delete layers anywhere — including paths, gradients and strokes |
| `animation:read` | Read keyframes and sample animated values |
| `animation:write` | Create and change keyframes and expressions |
| `assets:read` | Read the pixels of images already in the composition |
| `assets:write` | Create images and place them as layers |
| `net:fetch` | Contact the hosts listed in `contributes.net` — **and only those** |
| `timeline` | Read the current time and move the playhead |
| `composition:write` | Create, rename, open and delete **compositions** |
| `audio:read` | Read the loudness of audio layers over time |
| `export:frames` | Receive every rendered frame of a composition it exports |
| `import:files` | Read the contents of files you open with its format |

`audio:read` is the decoded WAVEFORM, not audio settings. Level, pan and fades
are ordinary animatable properties (`audioLevelDb` and friends) that
`animation:read`/`animation:write` already reach — this is how *loud* the audio
actually is, which is what "convert audio to keyframes" needs. Peaks only: raw
samples are not offered, because a plugin that could read PCM could reconstruct
the recording, and with `net:fetch` take it away. Both verbs return `null` when
there is no audio or it has not finished decoding, so polling is the right
shape rather than catching.

`composition:write` is deliberately NOT part of `scene:write`. "Modify your
layers" is a statement about the composition the user is looking at; adding and
removing compositions restructures the project around them, and deleting one
takes every layer in it. Folding the two together would have made an existing
grant silently mean more than it did when the user gave it. Listing the
project's compositions is `scene:read` — comp names are project data of the same
kind as layer names.

Deleting the LAST composition does not fail: the host mints a fresh empty one,
because a project with nothing open has nowhere to draw. The call still returns
`true`, because the composition it named really is gone.

Registering commands, showing notifications, opening the plugin's own panel,
reading the ACTIVE composition's settings and using **your own storage** need
**no permission** — they neither read project data nor change it.

**If you are writing a generator, ask for `scene:read + scene:proxy`, not
`scene:write`.** A plugin that builds a subtree under its own layer only ever
touches its own children, and the wider permission made its consent screen say
"create, change, delete, reparent layers" — indistinguishable from a plugin that
could rearrange the user's whole project. The narrow scope was always enforced
by `setProxyChildren`; what was missing was a way to *ask* for it. `scene:write`
implies `scene:proxy`, so an existing manifest needs no edit.

The one thing `scene:read + scene:proxy` cannot do is create the parent layer
itself — and it should not. The user adds it from **Layer ▸ New**, which is the
moment they chose to have your content in their project.

Ask for the fewest you need: the list is the install screen. A refused call
returns an error naming the missing permission rather than silently doing
nothing, so a plugin can degrade deliberately (`motion.has('scene:write')`).

Consent is **per permission**, not one yes over the list: the install screen
ticks everything the manifest asks for, and the user may untick any of it.
They can also change their mind later — Plugins ▸ Manage Plugins… ▸
**Permissions** on the row, which restarts the plugin with the new set (the
worker was told what it had at boot). A grant is always intersected with the
manifest, so nothing can hand a plugin more than it disclosed.

Write for this: check `motion.has(p)` rather than assuming, and let a refusal
disable a feature instead of throwing.

---

## 5. Writing a plugin

**Installing happens on the dashboard's Plugins page** in the hosted build, not
in the editor's Plugins panel — it lives beside publishing, since both are about
getting a plugin into the world. The editor's panel finds and runs what is
already installed. **The local edition has no dashboard**, so there the editor's
Plugins panel carries the **Add plugin** menu and accepts a dropped package.

**Download starter template** there produces a working package. Install it with
**Choose folder…**, and from then on iterate with the row's **Reload**, which
works from either surface: it re-reads the folder and reinstalls without asking
for consent again, unless the manifest has started asking for something new.
(The picker still opens — a browser cannot re-read a directory without a
gesture, and a stored handle needs its permission re-granted after a restart
anyway. What Reload removes is the consent screen on every edit.)

So the trip to the dashboard is once per plugin, not once per edit.

The entry module exports `activate`:

```js
export function activate(motion) {
  motion.commands.register(
    { id: 'bounce', label: 'Bounce selection', icon: 'zap', needsSelection: true },
    async ({ selection }) => {
      const t = await motion.timeline.getTime();
      for (const id of selection) {
        await motion.animation.setKeyframes(id, 'y', [
          { t,        value: 0,   easing: 'easeOut' },
          { t + 0.18, value: -60, easing: 'easeIn'  },
          { t + 0.42, value: 0,   easing: 'easeOut' },
        ]);
      }
      await motion.ui.notify(`Bounced ${selection.length} layer(s)`, 'success');
    },
  );
}
```

`export default { activate }` and `export default function (motion)` also work.
Every `motion.*` call returns a promise — it is a message to the editor, not a
function call into it.

### API

```js
motion.manifest                            // your own manifest
motion.permissions / motion.has(p)         // what the user actually granted

motion.ui.notify(message, level)           // info | success | warning | error
motion.ui.openPanel() / closePanel()
motion.ui.sendToPanel(data) / onPanelMessage(fn)

motion.commands.register(spec, handler)    // spec: { id, label, icon?, needsSelection? }
motion.composition.get()                   // { name, width, height, fps, durationSeconds }
motion.composition.list()                  // [{ id, name, width, height, fps, durationSeconds, active }]
motion.composition.create({ name, width, height, fps, durationSeconds })  // → id, and opens it
motion.composition.open(id) / rename(id, name) / delete(id)

motion.scene.getSelection() / setSelection(ids)
motion.scene.getLayers() / getLayer(id)
motion.scene.createLayer({ kind, name, x, y })   // shape | text | group | null | image
motion.scene.setProperty(id, prop, value)         // scalar, or a structured value (below); unknown names refused
motion.scene.renameLayer(id, name) / deleteLayer(id)
motion.scene.setParent(id, parentId | null)      // null → composition root
motion.scene.setVisible(id, bool) / setLocked(id, bool)

motion.effects.list(layerId)                     // [{ id, type, enabled, params }]
motion.effects.add(layerId, type)                // → the new effect's id
motion.effects.remove(layerId, effectId)
motion.effects.setParam(layerId, effectId, key, value)   // key + range checked against the effect
motion.effects.describe(type)                    // { type, label, params: [{ id, label, type, default, min, max, … }] }

motion.animation.getTracks(id) / sample(id, prop, time)
motion.animation.setKeyframe(id, prop, time, value, easing)       // value: number | colour | point
motion.animation.setKeyframes(id, prop, [{ t, value, easing }])   // prefer this
motion.animation.removeKeyframe(id, prop, time)
motion.animation.setExpression(id, prop, source)

motion.timeline.getTime() / setTime(seconds)

motion.audio.getPeaks(layerId)             // { buckets, duration, peaks[] } | null
motion.audio.getAmplitude(layerId, sec)    // 0..1 | null  — drive animation from sound

motion.onRenderFinished(fn)                // post-render action; returns unsubscribe
motion.exporters.register(id, handlers)    // provide an output format (API 6)
motion.importers.register(id, handlers)    // read an input format (API 6)

motion.scene.apply(ops)                          // many mutations, ONE undo entry
motion.storage.get(key, scope?) / set(key, value, scope?)
motion.storage.delete(key, scope?) / list(scope?, prefix?)  // scope: 'global' (default) | 'project'
```

Prefer `setKeyframes` over a loop of `setKeyframe`: the bulk API sorts once and
notifies once. Writing a generated track a keyframe at a time is quadratic and
is what used to freeze the app on imports.

### The widget vocabulary — richer UI without plugin markup

A layer kind declares typed properties and the host draws them. The vocabulary
is wider than it was:

```json
"props": {
  "spin":    { "type": "angle",   "default": 0, "animatable": true },
  "soft":    { "type": "boolean", "default": false, "group": "Edges" },
  "feather": { "type": "number",  "default": 0, "group": "Edges",
               "showIf": { "prop": "soft", "equals": true } },
  "notes":   { "type": "string",  "default": "", "multiline": true }
}
```

| | |
|---|---|
| `angle` | A dial. Degrees, **unbounded** — a revolution is a legitimate value, and clamping to 0–360 would make a spin stop at the wrap. Animatable. |
| `group` | A flat section heading. Ungrouped props stay in one unlabelled run at the top, so every plugin written before this reads exactly as it did. |
| `multiline` | A textarea. `string` only — **refused** on anything else rather than ignored. |
| `showIf` | Show this property only when a **sibling** has a value. The sibling must exist and cannot be the property itself; both are install errors. |

Groups are flat by design and there is no nesting: a plugin that could nest
groups could hide a property inside a collapsed one the user never opens, which
is a different thing from organising a panel. A `showIf`-hidden row is removed
rather than greyed — a control the plugin says does not apply is not one the
user should be left wondering how to enable.

**There is still no way to render your own markup, and there will not be.** A
plugin that could draw into the inspector could draw a convincing permission
prompt, and every plugin's panel would age differently from the app around it.
If the vocabulary is missing something your control genuinely needs, that is a
request for another entry in the table above — the answer is a wider
vocabulary, never an escape hatch. Your own **panel** is where free-form UI
lives, in its own sandboxed frame.

### Importers — reading a format the editor cannot (API 6)

```json
"contributes": { "importers": [
  { "id": "tga", "label": "Truevision TGA", "extensions": ["tga", "vda"] }
] }
```

```js
motion.importers.register('tga', {
  decode({ name, bytes }) { return { width, height, pixels } },  // RGBA8
})
```

Return pixels and nothing else — not a name, not a folder, not a layer.
Everything after the decode is the path every other import already takes, which
is what makes a plugin format a first-class import rather than a parallel one.

**A plugin never opens a file.** It is handed the bytes of one the user chose,
and only for an extension it declared — that is what `import:files` grants, and
its consent line says so. Formats the editor already reads are refused: a plugin
shadowing `.png` turns a working import into a plugin bug the user has no reason
to suspect.

The host validates what you return against the size you reported, so a decoder
whose buffer does not match its dimensions fails by name rather than making the
host read past the end of an array.

### Presets and behaviours (API 6)

```json
"contributes": { "presets": [
  { "name": "Drift", "tracks": [],
    "expressions": [{ "prop": "transform.y", "expr": "wiggle(2, 30)" }] }
] }
```

They appear in the Presets panel foldered under your plugin's name, and apply
whether or not your worker is running — a preset is data.

**You cannot register an expression FUNCTION**, and it is worth knowing why,
because it is two walls rather than one:

1. An expression is evaluated inside the render, per property per frame, and
   plugin code lives in a Worker. Same wall that makes effects WGSL-only.
2. The interpreter is a **closed vocabulary on purpose**. Expressions are parsed
   and interpreted, never `eval`'d — `new Function` is refused by the app's CSP,
   and relaxing that would let any shared project run code in a renderer holding
   your auth token. A plugin-supplied name would mean either running plugin code
   (wall 1) or re-opening that hole.

So you ship expression **source**, which goes through the same interpreter a
user-typed expression does and reaches nothing extra. It is **not** syntax-
checked at publish: the registry has no expression engine, and checking on one
side only would produce a preset that publishes and then refuses to install. A
broken one surfaces inline and editable, like your own.

`applyFn` and `builtin` are refused by name. A manifest cannot carry a function,
but a *string* under `applyFn` would arrive truthy and non-callable and the
apply path would call it.

### Exporters — writing a format the editor does not know (API 6)

Declare it, then claim it:

```json
"contributes": { "exporters": [
  { "id": "webp", "label": "Animated WebP", "extension": "webp" }
] }
```

```js
motion.exporters.register('webp', {
  begin(info) { this.enc = new MyEncoder(info.width, info.height, info.fps) },
  addFrame(f) { this.enc.push(f.pixels) },   // RGBA8, Uint8ClampedArray
  finish() { return this.enc.bytes() },      // ArrayBuffer | Uint8Array
  dispose() { this.enc?.free() },            // cancel / failure path
})
```

Your format appears in the export dropdown **after** the built-ins, hinted with
your plugin's name. Choosing it starts your plugin — the user naming your format
is a stronger signal than any activation event.

**The host writes the file.** You return bytes; the save dialog, output
directory and overwrite prompt stay where they already are. An exporter that
could write its own file would be an exporter that could write somewhere else.

**This is the one place plugin JS runs per frame**, and the reason effects
cannot is instructive: an effect runs inside a synchronous render sixty times a
second, so a Worker hop is fatal. An export is already a frame-at-a-time loop
that takes minutes and blocks nothing interactive. Frames are *transferred*, not
copied — a 4K frame is 33 MB — so the buffer is yours and gone from the host.

**Frames are `export:frames`, and it is an alarming permission on purpose.** To
encode a composition you see every rendered pixel of it: more than `assets:read`
(the images already in the project) and more than `scene:read` (its structure).
Held with `net:fetch` it is the finished video leaving the machine, and the
consent line says so.

**Extensions the editor writes itself are refused** — `mp4`, `png`, `wav` and
the rest. Not collision (the host's formats are matched first, so a duplicate
would never be reached) but honesty: a `.mp4` a plugin produced is a file whose
contents its name does not predict, and the failure lands wherever the user
takes it next. Four exporters per plugin; ids may not contain a dot, because the
host addresses yours as `plugin:<pluginId>.<exporterId>` and splits on the last
one.

A step that overruns 60 s, or a plugin that stops answering, fails the export
with a message naming the plugin rather than stalling the render queue.

### Post-render actions

`motion.onRenderFinished(fn)` fires when a render leaves the queue. Declare
`onRenderFinished` in `activationEvents` to be *started* by one — a plugin that
only reacts to renders has nothing to do until a render happens, and waking it
at startup is a worker idling for an event most sessions never fire.

```js
motion.onRenderFinished((r) => {
  if (r.status !== 'done') return
  motion.net.fetch('https://hooks.example.com/render', {
    method: 'POST',
    body: JSON.stringify({ comp: r.compositionName, file: r.fileName, ms: r.elapsedMs }),
  })
})
```

`status` is `done` (a file was written), `skipped` (it rendered, but you
dismissed the save dialog — **there is no file**, so a plugin that uploads on
completion must not fire here), or `failed` (with `error`). The rest is
`compositionName`, `fileName`, `format`, `width`, `height`, `fps`,
`durationSec`, `elapsedMs`.

**You get metadata, never the render.** No encoded bytes and no directory —
`fileName` is the basename only. Handing a plugin the file would make
"post-render action" mean "exfiltrate the render", which is a different feature
needing a different consent screen; handing it the path would tell it where you
keep your work, which it has no use for and — holding `net:fetch` — could send.

Gated on `scene:read`, with no permission of its own: everything in the payload
is either the composition's own name and size, which `scene:read` already
covers, or the fact that a render happened.

Listeners are a list, so registering two is two — and a handler that throws is
logged to your plugin's row without silencing the others.

### Structured values — paths, gradients and strokes

`setProperty` takes a number, a string or a boolean for any property. Four
properties additionally take a **structured** value, which is how a plugin gives
a layer an actual shape rather than only moving one around.

```js
// An outline. Tangents are optional — omit them for a polyline.
motion.scene.setProperty(id, 'points', [
  { x: -50, y: -50 },
  { x:  50, y: -50 },
  { x:   0, y:  50, inX: -10, inY: 0, outX: 10, outY: 0 },
])

// Several outlines on one layer — a donut, a letter with a counter.
motion.scene.setProperty(id, 'subpaths', [
  { points: outer },
  { points: inner, open: false },
])

// Solid or gradient fill.
motion.scene.setProperty(id, 'fillPaint', {
  type: 'linear', angle: 45,
  stops: [{ offset: 0, color: '#ff0055' }, { offset: 1, color: '#0055ff' }],
})

// A stroke. PATCHED onto the layer's existing one, so setting the width
// does not reset the cap, the join or the dash pattern.
motion.scene.setProperty(id, 'stroke', { width: 4, color: '#000000', dash: [6, 3] })
```

Declare `scene.structured` in `requires` if your plugin cannot work without it —
it is a capability, not a version, so an older host says so at install rather
than at the call.

**No new permission.** A structured write is still "change a property of a
layer", so it rides on `scene:write` (or `scene:proxy` inside your own subtree).
Splitting it out would add a line to the consent screen for a distinction the
user cannot act on.

**Geometry is created if the layer has none.** A shape layer made with
`scene.createLayer` carries no outline — the primitives that ship with one get
it from the insert path, which you do not go through. Writing `points` gives it
one.

**The value is parsed, not stored.** Every field is rebuilt: non-finite numbers
are refused (a `NaN` in a path becomes a layer that cannot be drawn, measured or
clicked, and nothing points back at you), colours must be `#rgb` / `#rrggbb` /
`#rrggbbaa`, and gradient stop `id`s you supply are **ignored** — the host mints
them. Errors name the exact index, so `"points[41].y" must be a finite number`
is what you get rather than a silent bad path.

**Bounds are refusals, not clamps**: 10 000 points per path, 256 subpaths, 64
gradient stops, 32 dash segments. Clamping would hand you a path that is not the
one you built with no way to notice.

Validation completes before anything is written, so a refused call has changed
nothing — including inside a `scene.apply` batch.

**`fill` means `fillPaint`.** Setting `fill` to a gradient object routes it to
`fillPaint`, and setting it to a hex colour makes a solid `fillPaint` (on a text
layer, whose `fill` is a plain colour string, the colour is written as before).
`'linear-gradient'` and `'radial-gradient'` are accepted as the `type`. A CSS
gradient **string** — `'linear-gradient(90deg, #f00, #00f)'` — is refused with
the object form in the message; CSS is not parsed.

### Names are checked

`scene.setProperty`, `animation.setKeyframe(s)` and `effects.setParam` refuse a
name the layer or effect does not have, and the error names the closest real
one:

```
"opactiy" is not a property of "Shape 1". Did you mean "opacity"?
"blur" is not a parameter of Drop Shadow ("drop-shadow"). Its parameters:
  distance, angle, softness, spread, color, opacity.
  effects.describe("drop-shadow") lists their types and ranges.
```

These calls used to succeed: an unknown prop was written onto the layer's
Transform, an unknown track was created, an unknown effect param was stored
beside the real one — none of which renders. A name counts as known when the
layer already holds it or has a track for it, the property registry describes
it, or it is a structured prop; an effect param must be in the effect's
definition. `effects.setParam` also checks the value against the param's type
and `min`/`max` — a refusal, not a clamp, matching the Effect Controls field.
Ask `motion.effects.describe(type)` for the ids and ranges rather than guessing:

```js
const { params } = await motion.effects.describe('glow');
// [{ id: 'radius', type: 'number', min: 0, max: 60, default: 16, … },
//  { id: 'color', type: 'color', … }, …, { id: 'fx.opacity', min: 0, max: 100, … }]
```

`describe` needs no permission — it reads the host's effect catalogue, not the
project.

### Colour and point keyframes

A keyframe `value` may be a number, a **colour** or a **point**:

```js
await motion.animation.setKeyframes(id, 'fill', [
  { t: 0, value: '#ff0055' },
  { t: 1, value: { r: 0, g: 85, b: 255, a: 0.5 } },   // r/g/b 0–255, a 0–1
]);
await motion.animation.setKeyframes(id, 'position', [
  { t: 0, value: { x: 0, y: 0 } },
  { t: 1, value: { x: 200, y: 80 } },
]);
```

A colour is written as the four channel tracks the renderer reads —
`fill_r`, `fill_g`, `fill_b`, `fill_a`, each 0–1 — exactly what keying the colour
in the inspector writes. It works on `fill`, `stroke`, `color`, a later stroke's
`stroke.<n>.color`, and an effect's colour param (`effect.<effectId>.<param>`).
A point writes axis tracks: `x`/`y`/`z` for `position`, `anchorX/Y/Z` for
`anchor`, `scaleX/Y/Z` for `scale`, `poiX/Y/Z` for `pointOfInterest`, and
`<prop>X`/`<prop>Y` for any property that has those tracks. Colour strings are
hex only (`#rgb`, `#rrggbb`, `#rrggbbaa`); every keyframe in one call must be
the same kind. Anything else is refused by name. `animation.sample` still
returns one number — sample a channel track to read a colour back.

### `scene.apply` — many mutations, one undo entry

**One host call is one undo entry.** Twelve calls are twelve entries, and a user
undoing your plugin's work presses Ctrl-Z twelve times without knowing how many
to expect. That is the real reason to batch, more than the round trips.

```js
const [rowId] = await motion.scene.apply([
  { op: 'createLayer', kind: 'group', name: 'Row' },
  { op: 'createLayer', kind: 'shape', name: 'A', parent: { ref: 0 } },
  { op: 'createLayer', kind: 'shape', name: 'B', parent: { ref: 0 } },
  { op: 'setProperty', layer: { ref: 1 }, prop: 'x', value: 0 },
  { op: 'setProperty', layer: { ref: 2 }, prop: 'x', value: 120 },
]);
```

- `{ ref: n }` is the result of op *n* — how a batch creates something and then
  refers to it.
- Everything applies or nothing does, and it is **one** undo entry.
- Store notifications are coalesced at the store, so 1,000 creates cost one
  re-render rather than 2,000.
- The permission needed is the **union of the ops present**: a read-only batch
  needs no write grant.
- Limits: 10,000 ops, 8 MB. An error names the failing op's **index**.
- Creates anchor to where op 0 landed, not to the user's selection — otherwise a
  thousand creates would build a thousand-deep chain, because the underlying
  insert parents to whatever is selected.

### `storage` — remembering things

```js
await motion.storage.set('lastPreset', 'wobble');            // scope defaults to 'global'
await motion.storage.set('seed', 42, 'project');
const seed = await motion.storage.get('seed', 'project');
await motion.storage.delete('seed', 'project');
const keys = await motion.storage.list('project', 'ui.');     // (scope?, prefix?)
```

**Key first, scope last and optional.** That is the canonical form. Hosts before
this change only accepted the older **scope-first** order —
`storage.set('global', 'lastPreset', 'wobble')` — and it still works: a call
whose first argument is exactly `'global'` or `'project'` *and* carries the
scope-first arity (2 arguments for `get`/`delete`, 3 for `set`) is read that
way; everything else is key-first. The one ambiguity that rule leaves: a key
literally named `global` or `project` passed together with a scope. Name your
keys something else. A call that fits neither form rejects with the expected
signature in the message. Plugins that must also run on older hosts should use
the scope-first order, or declare `requires` on a host new enough to accept
both.

Two scopes, and picking the wrong one is the mistake worth avoiding:

| Scope | Lives in | Survives | Use it for |
|---|---|---|---|
| `global` | IndexedDB, 1 MB per plugin | update **and** uninstall | preferences, an API base URL, "don't show this again" |
| `project` | the project document, 256 KB per plugin | travels with the file | anything that describes *this* project |

`global` surviving uninstall is deliberate: a reinstall that forgot everything
would make every update feel like a reset. `project` travelling with the file is
what lets a colleague open the project and see what your plugin computed.

Values are capped at 64 KB. A write past a quota throws with
`code === 'storage-quota-exceeded'` rather than silently truncating — catch it
and tell the user, because a plugin that quietly stops remembering is a bug
report nobody can reproduce.

Keys are namespaced to your plugin id. No other plugin can read them, and no
permission is required: your own settings are not the user's data.

`setParent` does not move the layer on screen — it adopts the local transform
that reproduces where it already is, so grouping is not a nudge. It is refused
if it would make a layer its own ancestor, or cross compositions.

`effects.add` takes a TYPE and returns the new effect's **id**; everything after
addresses that id. Your own effects are `<pluginId>.<effectId>` and are addable
only while your plugin is running. A type this editor does not have is an error
rather than a silent no-op — as is removing or setting a parameter on an effect
id that is not on the layer, both of which would otherwise succeed quietly and
leave you debugging a project that did not change.

### Panels

`panel.html` is plain HTML, run in the sandboxed frame with two globals:

```js
motionPanel.send(data);        // → your plugin's onPanelMessage
motionPanel.onMessage(fn);     // ← your plugin's sendToPanel
```

The panel talks to **your plugin only**. It has no access to the editor, and no
access to the network — inline `<script>` runs, `fetch` does not.

A panel docks like every other panel — it can be moved between the two docks
and popped out into its own window.

#### Where it lands: `placement`

You declare what kind of panel it is; the host decides where it goes.

```json
"panels": [
  { "id": "main", "title": "Easing Lab", "entry": "panel.html",
    "placement": "sidebar", "icon": "graph-value" }
]
```

| `placement` | Where it appears |
|---|---|
| `shared` *(default)* | A tab inside the one **Plugin Panels** panel in the right inspector, shared with every other `shared` panel |
| `sidebar` | Its **own tab** in the left sidebar, beside Scene, Assets and Library |
| `inspector` | Its **own tab** in the right inspector, beside Properties and Effects |

Pick `shared` unless your panel is a place the user goes rather than a control
they reach for. It costs no rail space, and it is what every panel written
before this field existed already gets.

`sidebar` and `inspector` **require an `icon`** — the rail shows glyphs, not
titles, so a panel without one is a tab the user cannot tell from anybody
else's. Names come from the editor's icon set and are checked when the package
is validated, by the editor *and* by the registry, so a typo is a publish error
rather than a generic glyph you never notice.

**A tab of your own is granted, not guaranteed.** Each rail hands out a fixed
number of plugin slots (3 on the left, 2 on the right); past that a panel is
*demoted* to the shared host. It still opens and `motion.ui.openPanel()` still
reveals it — it just does not own a glyph. Which happened is printed on your
plugin's row in the Plugins panel, so a demotion never reads as your plugin
being broken. Write the panel so it works either way: there is deliberately no
API to ask where you ended up, because there is nothing useful you could do
differently.

#### Getting it on screen

`motion.ui.openPanel()` reveals your panel wherever it landed. The user can also
reach it from **Plugins ▸ *Your plugin*: Panel**, or by clicking its rail tab —
which, if you declared `onPanel:<id>` in `activationEvents`, is what starts your
plugin in the first place. The tab exists whenever your plugin is installed and
enabled, running or not; the panel states its status until the worker is up.

**Nothing the user clicks closes it.** There is no ✕ on a plugin panel, on a
plugin tab, or on the Plugins panel. A panel belongs to the rail for as long as
its plugin is installed and enabled; disabling or uninstalling from the Plugins
panel is what removes it, and that also stops the worker. So do not build a
"close me" control into your panel expecting the tab to go away —
`motion.ui.closePanel()` switches away from a `shared` tab, and does nothing at
all to a tab of your own.

### Where your plugin shows up

| Contribution | Where the user finds it |
|---|---|
| `commands.register(...)` | The **Plugins** menu, under your plugin's name, and ⌘⇧P |
| `panel` in the manifest | Wherever its `placement` sends it (above) + a `Your plugin: Panel` command |
| `ui.notify(...)` | A toast, always prefixed with your plugin's name |
| The package itself | **Plugins ▸ Manage Plugins…** — status, permissions, enable/disable, uninstall |

A plugin that is installed but not running still appears in the menu, disabled,
saying why. Nothing an installed plugin does is invisible.

---

## 6. Supervision

- **Boot timeout** — 8 s to `activate`, then stopped with a reason.
- **Heartbeat** — a ping every 4 s; two unanswered ⇒ terminated as
  "stopped responding". A wedged plugin cannot wedge the editor because its loop
  is in another thread.
- **Errors are surfaced, not swallowed** — a fatal shows in the manager row with
  a **Restart** button and as a toast prefixed with the plugin's name.
- **Log** — each row has one. It carries the plugin's own `console.*` output
  (forwarded from the worker, where DevTools is not something a user of the
  packaged app has), every call the permission gate refused, and the crash that
  stopped it. Kept after the plugin dies — that is when it gets read — and
  bounded at 200 lines so a logging loop cannot grow the host.
- **Enable / disable** is distinct from uninstall: disabling terminates the
  worker and unregisters its commands but keeps the package.
- **A panel never outlives its worker.** Stopping a plugin — disabled, crashed,
  uninstalled — closes its panel. A frame still on screen with nothing answering
  it reads as the editor being broken.

---

## 7. The registry

Plugins ▸ Manage Plugins… ▸ **Browse** installs from the registry that lives in
motion-back (`src/plugins/`). A registry install is not a shortcut past the
permission screen — the download is verified, then parsed by the same package
reader a local file goes through, then shown on the same consent screen.

### What is actually guaranteed

**Trust on first use.** A publisher generates a keypair; the registry records the
public key the first time a plugin id is published, and every later version must
carry a signature that verifies against that same key. The editor re-checks the
signature **on the user's machine**, against the key stored with the installed
copy — not the key the download claims. So:

| Attack | Result |
|---|---|
| Package modified in transit or on a CDN | Fails verification locally, not installed |
| Someone else publishes under your plugin id | Refused: id is owned by the first publisher |
| Your registry account is stolen | Refused: the thief has no signing key |
| Registry itself is compromised and serves a new key | Refused on update: the client pins the stored key |
| A publisher ships something malicious under their own key | **Not covered.** Signing says who, never whether they meant well — which is why the permission screen still exists. |

ECDSA P-256 / SHA-256, signature as IEEE-P1363, key as SPKI. The editor's
verifier is `src/core/plugins/registry.ts`; the registry that signs packages is a
separate hosted service and is not part of this repository. A test signs with
Node and verifies with WebCrypto, because that seam breaking silently would mean
nothing installs.

### Publishing

Everything a publisher does lives on one page: **Dashboard ▸ Plugins ▸
Publishing** (`?tab=plugins&view=publishing`). Claiming your namespace, cutting
a release, editing a listing's copy and pictures, flipping a listing between
public and private, and withdrawing one are all there, as a rail of your
listings beside the one you are working on.

**From the app.** Hit publish and you are asked how to sign:

| | |
|---|---|
| **Use an existing key…** | opens a file picker for your `*.json` key file |
| **Create a new key…** | asks where to save one, makes it, and signs with it right away |

Pick *Create a new key…* the first time. There is nothing to find beforehand —
a signing key is a file you make, not something the registry issues you.

**From the command line**, for scripted releases:

```bash
node scripts/sign-plugin.mjs keygen --out ./my-plugin.key.json
node scripts/sign-plugin.mjs publish my-plugin.zip --key ./my-plugin.key.json --token <access token>
```

Both produce and accept the same file — P-256, `{ privateKey, publicKey }` as
base64 PKCS8 and SPKI — so you can start in the app and script it later, or the
other way round.

The private key never leaves the machine, and Premation never stores it: publish
sends the package, the signature and the public key, and you are asked for the
key file each time. Remembering it in the OS keychain would make anything
running as you able to publish as you, which is the compromise the signing model
exists to survive.

> **Keep the key file, and back it up.** It is your publisher identity. The
> registry pins it on your first publish and every later version of that plugin
> must verify against it — so losing it means republishing under a new id, and
> anyone who has it can publish as you. That is the cost of the guarantee rather
> than an oversight.
>
> Register a **backup key on your first publish**, while you have no install
> base and it costs nothing. Authorising one later needs your account password
> and prompts every user who already has the plugin.

Published versions are immutable: re-publishing an existing version is refused,
because two different sets of bytes claiming to be `1.2.0` would make the
signature guarantee unusable.

### Updates

Checked **only when the manager is opened** — never on a timer, never in the
background. This is the editor asking the registry, on the screen where the
answer is the point — not a plugin reaching anywhere. A plugin's own network
path, where it has one, is `motion.net.fetch` (§13). A failed check is
silent, so working offline does not produce errors.

An update that asks for **more permissions than were granted** goes back through
the consent screen rather than installing quietly. A plugin withdrawn by an
operator is reported to anyone running it, and their copy keeps working — the
package is blocked, not deleted, because breaking someone's project is usually a
bigger harm than the one a takedown addresses.

## 8. Deliberately out of scope

These are settled decisions, written down so they stop being re-proposed.

- **Rating, comments, curation.** The registry lists what was published; it does
  not editorialise, and there is no ranking signal beyond the deduplicated
  install count. The raw download count exists but is internal and never ranked
  on — two numbers on a listing invite a comparison the inflatable one always
  wins.
- **Fetching a URL the user supplies at runtime.** Considered and rejected. It
  sounds like a small addition to `net:fetch` and is not: the whole guarantee is
  that a plugin's reachable hosts are *declared, signed, and shown on the
  consent screen*, so a plugin that can be handed an arbitrary URL has consent
  for "contact the internet" no matter what the screen said. There is no runtime
  host allowlist, no host-mediated URL dialog, and no `net.requestHost`. If your
  plugin needs a user-chosen endpoint, declare the host it belongs to.
- **Automatic blocking on a report threshold.** Reports are cheap by design —
  no account needed — so a count that blocks is a takedown button handed to
  anyone who can make the count go up. A case escalates to a human; nothing else.
- **Plugin-to-plugin communication.** One worker and one frame each, and no
  shared channel between them. Two plugins that can talk are two plugins whose
  combined permissions are the union of what the user granted separately, which
  is not what the consent screen said.
- **Multi-file entry modules.** `main` is a single ES module; bundle first.
- **Background or periodic update checks.** Only when the manager is opened. The
  single exception is the revocation list, which is a safety mechanism and
  uploads nothing — see §10.
- ~~**Render-path plugins.**~~ **Shipped in API 4** — see §12. This said "a
  plugin cannot draw pixels" and stopped being true. It arrived the way this
  entry predicted: a separate class with a synchronous, deterministic contract
  (WGSL as data, never JS in the frame loop) rather than an extension of the
  command API.
- ~~**Native code.**~~ **Shipped — see §19.** This said a plugin is JavaScript
  and WebAssembly and nothing else. The constraint it was protecting (a bad
  plugin must not be able to take the editor down) is still absolute; what
  changed is how it is kept. A native module runs in a `utilityProcess` of its
  own, behind a signature AND a separately-worded consent step naming the
  binary by hash, and a crash costs one process and one frame.
- ~~**Documents referencing plugins.**~~ **No longer true as of API 3** — see §9.
  A document containing a plugin-defined layer names the plugin that defines it.
  The guarantee it replaced is spelled out there in full.

---

## 9. Layer kinds (API 3)

A plugin can declare a layer type the editor has never heard of, with animatable
properties that appear in the timeline and the graph editor and behave like
native ones. You ship a **schema**, not a widget: the host renders the inspector
from it with its own components, so a plugin contributes no markup and no CSS.

```jsonc
"apiVersion": 3,
"contributes": {
  "layerKinds": [{
    "id": "depthImage",              // camelCase; namespaced as <pluginId>.depthImage
    "label": "Depth Image",
    "render": "proxy",               // required — see below
    "schemaVersion": 1,              // monotonic; drives onMigrateLayer
    "props": {
      "focal":  { "type": "number", "default": 50, "min": 0, "max": 100, "animatable": true },
      "source": { "type": "asset",  "assetKind": "image" },
      "mode":   { "type": "enum",   "values": ["parallax", "displace"], "default": "parallax" }
    }
  }]
}
```

Only `number`, `color` and `boolean` may be `animatable` — a string keyframe is
not something the interpolator can do, and accepting one here would push the
failure into the graph editor after you had shipped. Every `default` is checked
against its own constraints at install time, for the same reason.

### `render` is part of the schema, not a runtime choice

- **`"none"`** — a controller. It draws nothing; its properties exist to drive
  other layers. Shown as a null-style gizmo, selectable in the viewport.
- **`"proxy"`** — you maintain a subtree of native layers as children and the
  host renders those. The custom layer is the authored, animatable interface;
  the children are its output.
- **`"shader"`** (API 4, drawn from API 6) — the kind draws itself, with one of
  your own effects. Add `"shader": "<effectId>"` naming an id from
  `contributes.effects` and the host renders the layer as a transparent surface
  carrying that effect, with its time / comp-size / frame inputs filled in. The
  kind's declared props are passed to the effect by NAME, so `focal` on the kind
  drives `focal` on the shader with no wiring. Without the field the kind parses
  and draws nothing, which is what it did before the field existed.
- **`"generator"`** (API 6) — the kind produces geometry every frame from real
  plugin code: particles, sprites, meshes. See §17.

`proxy` ships first because it is the one whose documents survive your plugin
being uninstalled: the children are ordinary layers and keep rendering. A
`shader` or `generator` kind does not draw at all without the plugin that
provides it — a real cost, and the reason to pick `proxy` whenever your output
can be expressed as native layers.

### The one thing to get right: authored versus animated

> **`scene.onLayerChanged` fires for AUTHORED property edits only. It never
> fires for animated value changes.**

This is the contract, not a tuning detail, and getting it wrong is the mistake
whose symptom will not look like your bug.

An animatable property changes **every frame** during playback. If regeneration
were driven by value changes, per-frame regeneration would be the steady state
rather than an edge case — and coalescing cannot save you, because coalescing
protects against a burst that ends and animation never ends.

- **You regenerate** when the authored schema changes: the user drags `focal`,
  picks a different `mode`, assigns an asset. Bursts are coalesced by the host,
  so a drag produces one regeneration, not one per pointer event.
- **The host animates** what you already generated, through ordinary expression
  bindings on the children.

Enforced structurally rather than by discipline: both behaviours hook the
scene graph's authored write path, and animation samples tracks without ever
writing a property — so playback cannot reach the notifier at all.

### Referencing a parent property from a proxy child

```js
// In the child you generate, not at runtime:
layer('Depth Image', 'plugin.focal')
```

**Write the name; the host stores an id.** A name is resolved to the layer's
stable id at AUTHORING time and stored as `layer('#n_a1b2c3', 'plugin.focal')`.
Nothing at evaluation time looks a layer up by name, which is what makes the
binding survive a rename — before this, renaming a depth layer silently made
every child read 0, with the symptom appearing nowhere near the rename.

The `#` prefix keeps the two unambiguous: without it, a layer whose NAME
happened to equal another layer's id would resolve to the wrong one. It is
available to user-authored expressions too, and the resolution layer treats both
forms identically. A name that resolves to nothing is left exactly as written
rather than rewritten to `#undefined` — an already-broken reference should not
become a permanently broken and untraceable one. Documents written before this
are repaired on load; unresolvable references are reported, never dropped.

**A user's own expressions are not rewritten to ids, and do not need to be.**
The source text is what they typed and what they see when they open the
expression editor, so replacing a layer name with `#n_a1b2c3` would make their
formula unreadable to them in order to fix a problem they have not hit. The
rename carries the references instead: renaming a layer updates every expression
that named it to the NEW NAME, in the same undo entry, so the text stays
readable and the reference stays correct.

Two details matter if you are reasoning about this from a plugin:

- The rewrite is keyed on **resolution, not on matching text**. Layer names are
  not unique and `layer('Panel')` means the first `Panel` in traversal order, so
  renaming a second layer of that name leaves every reference alone — rewriting
  by text match would silently retarget them to the layer being renamed.
- Renaming a layer **to** a name another layer already holds can steal that
  name's resolution. Nothing errors and no text changes; the affected
  expressions are named in a warning rather than rewritten, because which layer
  the author meant is not something the editor can know.

Note the `plugin.` prefix on the property. Your declared properties animate
under `plugin.<name>`, fixed rather than per-plugin because a stored track key
must not depend on which plugin is installed. It is reserved: no native property
may begin with it. It never appears in the inspector — users see your `label`.

This binding shape was chosen over "the host pushes evaluated values into
children each frame" for two reasons, one measured and one structural:

- **Measured.** 48 bound children, sampled every frame, cost ~0.5 ms/frame in
  the slowest realm available (jest's VM, an upper bound) against a 16.7 ms
  budget, and scale linearly. `proxyBindingCost.test.ts` keeps that honest.
- **Structural, and the reason it wins.** The binding is evaluated by the
  ENGINE, with no plugin involved — so a proxy subtree animates correctly in a
  document opened without your plugin installed. The missing-plugin fallback
  comes for free instead of being a second code path to keep working.

The cost is that your generated output is expression-bearing, so plugin-written
expressions carry `authoredBy: <pluginId>`. A document full of expressions with
no origin label is unpickable later.

### Regenerating: `setProxyChildren`

```js
motion.scene.onLayerChanged('depthImage', async ({ layerId }) => {
  const layer = await motion.scene.getLayer(layerId);
  await motion.scene.setProxyChildren(layerId, [
    { key: 'plane-0', kind: 'shape', name: 'Near',
      expressions: { x: `layer('${layer.name}', 'plugin.focal')` } },
    { key: 'plane-1', kind: 'shape', name: 'Far' },
  ]);
});
```

**`key` must be stable across regenerations.** The host DIFFS on it: a child
whose key is unchanged keeps its scene-graph layer id. Churn the keys and you
churn the ids — and layer ids are referenced by selection, by parenting, by
other layers' expressions and by the undo stack, so a user's selection jumps, an
unrelated `layer('Near', …)` goes dead, and undo granularity collapses. All of
it lands far from the parameter tweak that caused it.

A regeneration is **one undo entry**, labelled with your plugin's name. The host
**rate-limits** regeneration per plugin: a plugin that regenerates in response to
its own regeneration is a loop, and the failure mode is a wedged editor, so it is
stopped by the host rather than left to author discipline.

### Who owns a generated child

**A user editing one of your generated layers detaches the WHOLE subtree from
your plugin, permanently, and your next `setProxyChildren` is refused.**

The alternative — refusing the user's edit — was rejected. The point of
`render: 'proxy'` is that your output is ORDINARY layers; a subtree the user may
look at but not touch is a black box, and it would make your output your
property rather than their document.

Detaching the whole subtree rather than the one child edited is deliberate: a
half-owned subtree is a state neither side can reason about, and your next
regeneration would have to diff around a hole the user created.

Nothing is destroyed. Detaching clears a mark; every layer stays exactly as it
was, now belonging to the user. Generated children are marked in the
**document**, not only in the UI, so a collaborator sees the same thing.

### What a document stores, and what happens without your plugin

A custom layer serialises as one component whose TYPE carries the namespace
(`pluginLayer:<pluginId>.<kindId>`), with your declared props on it under their
own names. The document also carries a top-level list of the plugins it
references (id, version, publisher, kinds used), derived from its CONTENTS at
save time — never from what happens to be installed, because a project saved on
a machine missing the plugin must still name it.

Without your plugin:

1. **The layer is never lost.** Not on uninstall, not on open, not on
   save-and-reopen.
2. **It still renders**, if it is `proxy` — the children are ordinary layers.
   And it still ANIMATES, because the bindings are evaluated by the engine.
3. **It is inert and says so**: properties read-only, your logic not run, a
   non-blocking banner naming what is missing with an offer to install it.
4. **Keyframes survive untouched.**
5. **Reinstalling reactivates it in place**, with the original values.

What is NOT guaranteed is the authored interface: the custom layer's properties
are read-only, so changing `focal` does nothing until the plugin is back. The
subtree is a frozen snapshot of the last regeneration.

### Schema versions

`schemaVersion` is monotonic and stored per layer.

- **Plugin newer than the document** → you get one chance to migrate via
  `onMigrateLayer(oldProps, fromVersion)`, run inside `runDocumentEdit` as one
  undo entry and validated like any other plugin input. Anything that fails
  validation falls back to that property's DEFAULT — but a property your
  migration did not mention KEEPS its value if it still validates. Defaulting an
  unrelated, still-valid, animated property because a migration was buggy is
  destructive; keeping it is at worst occasionally wrong. On any drop the
  pre-migration props are QUARANTINED under `__preMigration`, so a reset is
  recoverable rather than merely reported. Keyframes are never touched.
- **Plugin OLDER than the document** → marked **inert, never guessed**. The
  older plugin cannot know what the newer one stored.

### Known gaps in this API

Found by writing a real depth/parallax plugin against it. Listed rather than
worked around, because a workaround in one plugin is a missing API the next
author hits without it.

~~1. `onLayerKind` cannot bootstrap your own first layer.~~ **Fixed.** The host
   creates it, from your schema, under **Layer ▸ New ▸ `<your label>`** — built
   from the registry, so your kind appears whether or not your worker is
   running. Choosing it creates the layer at your declared defaults and THEN
   activates you, exactly as opening a document does. You keep pure lazy
   activation; declare `onLayerKind:<id>` and nothing else.
~~2. **No asset picker.**~~ **Fixed.** An `asset` prop renders a picker listing
   the project's images. Only images, because `assetKind` can only be `image`;
   an id whose asset has gone stays selected and is marked *(missing)* rather
   than silently clearing, so a lost reference is something the user can fix
   instead of something they have to notice.
3. **`render: 'none'` has a gizmo but no dedicated overlay.** It is selectable
   and draggable; it draws as a plain container.

---

## 10. Revocation — what a user sees when a plugin is withdrawn

An operator takedown used to reach a user only when they happened to open the
plugin manager. It now reaches them within a boot, and mid-session if the app is
already running.

**How it works.** The client fetches a small signed list from
`GET /plugins/revocations` — public, cached, no auth — and matches it locally.
It uploads nothing. That is deliberate and it is the reason revocation is not
built on `POST /plugins/updates`, which sends the user's whole installed set:
the enforcement mechanism must not be the thing that tells the registry who runs
what.

The list is signed with an **operator** key pinned in the app, not a publisher
key. A publisher key says "the same author made this"; the operator key says
"the registry says stop". An author who could sign a revocation list could
un-revoke their own plugin, or revoke a competitor's.

**What a user sees.** The plugin stops — immediately, not at the next restart —
and is disabled. A toast names it and gives the operator's reason verbatim, and
the same reason goes to the plugin's log. It cannot be re-enabled or reinstalled
while it is listed.

**What does not happen.** The package is not deleted and nothing they made is
destroyed. Documents that reference the plugin keep opening; a `proxy` layer's
generated children keep rendering and keep animating, because their bindings are
evaluated by the engine. Breaking someone's project is usually a bigger harm
than the one a takedown addresses.

**When the list cannot be fetched**, the last verified one keeps applying and
the failure is silent — being offline is normal. A list past its freshness
window is still enforced and its staleness surfaced, because a client that
stopped enforcing a stale list would make "block the fetch" the entire exploit.
A list with a lower sequence number than one already seen is refused, so a
replayed older list cannot un-revoke anything.

With no operator key configured, the client refuses every list and the server
answers 503 rather than serving an unsigned one. An unsigned kill switch is one
anybody can pull.

**The key is live.** The operator keypair is generated by motion-back
`npm run operator-key`; its private half is `MOTION_REVOCATION_KEY` on the
server and exists nowhere else, and its public half is a pinned constant in the
editor. Because it is pinned rather than fetched, **rotating it costs an app
release** — which is the correct price for a control of this weight, since a key
the server can choose is a key an attacker who controls the server can choose.

That pin is the one part of the chain no unit test can check on its own: a typo,
an empty constant, or a keypair regenerated and never redeployed all produce a
client that silently refuses every list, which is indistinguishable from a
registry with nothing to revoke. So `revocationKeyIsPinned.test.ts` verifies a
fixture signed by the real operator private key, and the server's
`revocation.service.spec.ts` verifies its own output with the client's exact
primitives (`spki` import, 64-byte IEEE P1363). Rotate the key and both must be
regenerated — the tests failing is the intended way to find out.

---

## 11. Trust and safety

Signing says *who*. Permissions say *what*. Neither says whether the author
meant well, and no amount of cryptography will — a correctly signed package
from a verified publisher, asking only for permissions it genuinely uses, can
still do something nobody consented to. Everything in this section exists
because that gap is real and is not closable by better cryptography.

### Reporting a plugin

Anyone can report one, from the plugin's detail tab or from the row's context
menu in the Plugins panel. Five categories — malicious behaviour, impersonation,
broken or abandoned, inappropriate content, license violation — plus an optional
message.

**No account is required.** The endpoint takes an identity when the caller has
one and refuses nobody, because the moment worth reporting is often *before*
installing: the person best placed to notice a listing impersonating another
plugin has not signed up, and a dialog demanding an account first would simply
lose the report.

**The publisher is never told who reported them.** Both halves matter and they
pull in opposite directions: a report we cannot attribute is one we cannot meter
or weigh, so the reporter is recorded server-side; a reporter the accused can
identify gets retaliated against and stops reporting, so nothing publisher-facing
or reviewer-facing carries it. Addresses are stored as a salted HMAC, never raw —
the IPv4 space is small enough to enumerate, so an unsalted digest of an address
is a lookup table, not a one-way function.

**Reports collapse into cases.** A plugin that starts misbehaving gets reported
by forty people in an hour, all about the same version, all correct. Forty rows
in an inbox is forty decisions about one artefact, and a reviewer makes most of
them badly out of fatigue. So reports attach to a case keyed on (plugin,
version), and the count becomes signal — forty people noticed — rather than
volume to wade through.

**A dismissed case reopens when someone reports it again.** Without that, one
dismissal is permanent immunity: every later report lands on a closed case
nobody looks at, and the reviewer who was wrong in week one never finds out in
week six. A plugin that turns malicious *after* review is exactly what the queue
is for.

### Publish-time scanning

Automated, advisory, and fast. It gates **review**, not publication.

The package is scanned after the signature verifies and the manifest parses,
never before — the same order the client uses on install, and for the same
reason: unverified bytes must not reach a parser. Checks cover obfuscation
heuristics, very long single lines, base64 blobs that *decode to code*, computed
dynamic `import()`, `eval` and the `Function` constructor, decode-then-execute
pairs, and panel-bridge use by a package that declares no panel.

The highest-signal check is **permission/behaviour mismatch**, and it is
interesting in both directions. A package asking for `scene:write` that never
writes is either a copy-pasted manifest or someone establishing a permission to
use later, after the reviews stop — either way the consent screen overstates
what the code does, and a consent screen that overstates is one users learn to
click through. A package calling a method it never asked for will be refused at
runtime, so it is untested code or a build against a different manifest.

Results attach to the version as a risk score plus findings, and **gate
nothing**. Your publish is live the moment it succeeds: downloadable,
searchable, and `latestVersion`.

**The findings come back to you as `warnings` on the publish response.** Read
them — the highest-signal one is `permission-undeclared`, which means your code
calls a method your manifest never asked permission for. Those calls are
**refused at runtime**, so the plugin installs, looks healthy, and silently
fails at the one thing it was written to do. A successful publish cannot tell
you that; the warning can.

> **The scanner is not the security boundary. The sandbox is.** Every check is a
> pattern match over source a hostile author controls completely, and every one
> can be evaded by someone who reads the source — which is public. If the
> platform's safety ever depends on a finding here, the platform is not safe.
> Findings are prompts for a person, never verdicts.
>
> That is also why it no longer gates. A check that stops only the people who
> were not trying to get past it, while silently burying honest authors who
> mistyped a permission, was costing more than it bought. The score is still
> computed and stored, because "what did the scanner see when this shipped?" is
> the first useful question when an abuse report arrives.

### The reviewer queue

Admin-only, at `/admin/plugins/review`. Open cases, ordered by distinct
reporters rather than age — a queue sorted oldest-first puts a low-risk package
from Tuesday above eleven reports of data theft that arrived this morning, which
is the ordering that gets a queue abandoned.

Its held-versions half is now permanently empty: nothing writes `pending`. The
code is kept because `blocked` and `changes_requested` are still real operator
decisions, and because a deployment that wants the gate back needs one line.

Per-case actions: approve, request changes (with a note the publisher reads),
block the version, block the plugin, suspend the publisher. Every one requires
a reason, and every one is recorded in the shared audit log with actor,
timestamp and reason.

**The reason is the product.** For a block it is written to `blockedReason`,
signed into the revocation list, and shown to the user when their copy stops
mid-session. The sentence an operator types in the console is the sentence a
stranger reads when their work is interrupted — which is why a minimum length is
enforced. "No" is indistinguishable from a bug, and the user's next move is to
reinstall the thing that was just taken away from them.

**Blocking writes the revocation list directly.** There is no separate "publish
the revocation" step: `RevocationService` derives its signed list from the same
`blocked` column the block sets. A kill switch with a manual second stage is one
that gets left half-pulled.

Two deliberate separations:

- **Blocking a version ≠ blocking a plugin.** One build being bad does not mean
  users on the previous version should lose it.
- **Suspending a publisher leaves their plugins up.** Taking down everything an
  author ever shipped punishes every user of every one of their plugins for
  something the author did. Block the ones that need blocking, explicitly, so
  the audit log shows each was a decision rather than a side effect.

### What a publisher sees

Their own shelf carries the review state of any version of theirs that is not
live, with the reviewer's note — so a held version is never an unexplained
silence they have to email someone about.

They do **not** see the risk score or the findings. The score is an internal
triage number that reads as a rating, and the findings are a list of the exact
patterns the scanner looks for, which is the evasion guide.

### Changing a signing key

Trust-on-first-use used to mean a key change was refused permanently, and a
publisher who lost their key republished under a new id. That is defensible as
a guarantee and brutal as a product: it discards the install base, the install
count, and the id every existing document references — and it punishes the one
thing we most want authors to do, which is not keep a signing key somewhere
that survives losing a laptop.

Rotation replaces "never" with "only with something else you already proved".
There are three gates, and a stolen account clears exactly one of them:

1. **Authorising a key needs the account password**, re-entered. Either register
   a backup alongside your first publish — the one moment it is free of risk,
   since there is no install base to hijack yet — or add one from the dashboard
   later. Publishing can never authorise a key: if it could, a stolen session
   would be enough to take a plugin.
2. **Rotating needs a package actually signed with that key.** An authorisation
   that never ships anything changes nothing, and the authorisation is *spent*
   on use — two keys that can both sign forever is what rotation exists to end.
3. **Every installed copy needs its own user to accept.** The editor never
   re-pins silently. It shows "the publisher's signing key changed", explains
   that this is also what an account takeover looks like, and offers keeping the
   current version as the emphasised choice. Declining is not an error; the
   installed plugin goes on working.

The change is on the plugin's public listing — when it happened and how it was
authorised — because "the publisher's key changed" is precisely what someone who
took over an account would want accepted quietly.

If the editor's key-change prompt is unavailable for any reason, the update is
**refused**, not accepted. A missing dialog is not consent.

---

## 12. Effects (API 4)

A plugin can draw pixels. It ships **kernels and a typed parameter schema** —
WGSL for WebGPU, GLSL ES 3.0 for WebGL2, a WASM or JS kernel for the CPU raster
and export path, in any combination — and it does not ship a callback.

### Shaders as data, never JS in the frame loop

This is the constraint everything else follows from, and it is structural
rather than a performance preference. Plugin code lives in a Worker, so reaching
it means `postMessage`, which means awaiting a reply inside what has to be a
synchronous render. One async hop per effect per frame is playback that stutters
and an export that takes minutes, and no amount of batching fixes an
architecture that has to ask another thread what colour a pixel is.

So your JS registers an effect and drives its parameters. It is never in the
loop — which is also why your effect keeps working in a document opened by
someone whose editor never started your worker.

```json
{
  "apiVersion": 4,
  "contributes": {
    "effects": [{
      "id": "tint",
      "label": "Tint",
      "shader": "@fragment\nfn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {\n  return textureSample(src, samp, uv) * params.amount;\n}",
      "params": {
        "amount": { "type": "number", "default": 1, "min": 0, "max": 2, "animatable": true }
      }
    }]
  }
}
```

### Parameters are ordinary properties

`params` uses the same schema `layerKinds.props` does, validated by the same
code. An `animatable` parameter becomes a keyframe track keyed exactly like
every other property — no new machinery in the animation engine, nothing
special in the timeline or the graph editor.

Only `number`, `color`, `boolean` and `point` are accepted as values, plus
`layer` as a texture input. `string` has no bytes in a uniform block, `asset` is
a reference rather than a value, and `enum` would need an index mapping you had
to keep in your head and in step with your schema. All three are refused at
install rather than discovered from a black frame — as is a parameter whose name
collides with one the host fills in (see *Host-filled inputs*).

### You write one function. The host writes everything else.

Write a `@fragment` entry point **named `fs`**, and read `params.<name>`, `src`
and `samp`. That is the whole surface.

You must **not** declare `@group`, `@binding`, or a `@vertex` shader — all three
are refused at install. The host generates the parameter block, the input
texture, the sampler and the vertex stage, and prepends them to your source.

Three reasons, and none of them is tidiness:

- **The vertex stage is identical for every effect** — the same full-screen quad
  transform. Asking each author to hand-copy a matrix multiply whose only
  possible contribution is a bug is not an interface.
- **The uniform block starts with the renderer's own header.** `mvp` and
  `uvRect` occupy its first 64 bytes and the vertex stage reads the transform
  from exactly there. A block that began with your first parameter would
  compile, bind, and draw a quad with a garbage transform — nothing would error.
- **Hand-written uniform layout is a padding bug** that surfaces as wrong
  colours rather than as an error.

You also get a **host block** at offset 64 — 80 bytes of values the host fills
in, listed under *Host-filled inputs* below. One of them matters even for the
simplest single-pass effect:

```wgsl
params.texelSize   // vec2 — one over the target's dimensions
params.passScale   // this pass's downsample
params.passIndex   // 0-based
```

`texelSize` is how you sample a neighbour: `uv + vec2(params.texelSize.x, 0.0)`
is one pixel to the right, at whatever resolution the host allocated. Hardcoding
a resolution is correct on your composition and wrong on everyone else's, by an
amount that reads as a bad kernel rather than a bad assumption.

**`uv` spans the pass's target, not your layer.** The quad is full-target, so
`uv` is always inside `[0, 1]`: on a 2D layer that is the whole viewport, on a 3D
layer it is the layer plus the margin your `expand` reserved, and on WebGL2 it
runs bottom-up. Sample textures at `uv`. To find your *layer*, use `layerRect`:

```wgsl
let local = (uv - params.layerRect.xy) / params.layerRect.zw; // 0..1 top-down over the layer
let px    = local * params.layerSize;                          // layer px; < 0 in the left/top margin
```

`layerRect.zw` is negative on an axis the backend flips, which is why the
division above is the form to use: it comes out top-down on both backends, and
`layerRect.xy + local * layerRect.zw` takes you back to `uv` for sampling. A
procedural kernel that ignores this paints the whole target, mirrored between
WebGPU and WebGL2.

After that block, the generated struct orders your parameters by **alignment,
descending** — every `vec4` first — starting at offset **144**. A scalar before
a `vec4` would leave a 12-byte hole the struct does not describe, and every
member after it would read shifted bytes: no compile error, no exception, just
wrong colours that look like your maths.

> The parameter base moved from 96 to 128 when the host block grew to carry the
> time, the sizes and a seed, and from 128 to 144 when it grew again for
> `layerRect`. Nothing you ship is invalidated by that: a plugin ships *source*,
> and both sides of this layout — the struct you compile against and the bytes
> the host packs — are generated from one description, so your effect is simply
> recompiled against the new one.

### More than one pass

Declare `passes` instead of `shader`/`glsl` — up to eight (sixteen on the
extended tier), each with its own `wgsl`, `glsl`, or both:

```jsonc
{
  "id": "gaussian",
  "label": "Gaussian Blur",
  "params": { "radius": { "type": "number", "default": 8, "min": 0, "max": 32 } },
  "passes": [
    { "name": "horizontal", "wgsl": "…" },
    { "name": "vertical",   "wgsl": "…", "reads": "previous" }
  ]
}
```

The host allocates the intermediate targets, ping-pongs them and runs the passes
in order. You never see a target.

| Field | |
|---|---|
| `scale` | `1`, `0.5` or `0.25`. The target's downsample |
| `reads` | `previous` (default), `origin`, `both`. `origin` is the chain's input, at binding 4 |

**Use `scale` for anything with a large radius.** A pass at scale *s* renders
into a target that fraction of the viewport, and — this is the part worth
internalising — the same tap count then reaches `1/s` times further, because
one texel of a quarter-size target is four pixels of the image. So a
quarter-scale blur is both sixteen times cheaper *and* four times wider than the
identical shader at full scale. Measured on hardware: 14 composition pixels of
spread at full, 48 at quarter.

`params.texelSize` is always your own target's, so you write the kernel once and
it behaves correctly at every scale.

**`reads: "origin"` gives you `origin` at binding 4** — the image as it entered
your chain, before any of your passes touched it. That is what a composite step
needs: a bloom adds its blurred copy back *over the original*, and by the time
you get there the original is several ping-pongs ago.

```wgsl
// The last pass of a bloom.
let base  = textureSample(origin, samp, uv);
let light = textureSample(src,    samp, uv);
return base + light * params.intensity;
```

`both` is the same binding; use it when you read `src` as well, which a
composite almost always does. `reads` on the *first* pass is refused
permanently — its `src` and its `origin` are the same texture.

**A full chain: four passes, each at full, half or quarter scale, each reading
the previous pass or the original.** Separable blurs, convolutions, iterative
filters, downsampled large-radius work, and bloom.

`reads` on the *first* pass is refused permanently, for a different reason: its
`src` and its `origin` are the same texture, so no version will make that valid.

**The cost budget is 3**, where a pass costs `scale²`. A separable blur is 2 and
four full-scale passes is 4, which is refused. The budget already understands
downsampling — a ¼-scale pass costs a sixteenth of a full one — so a bloom will
fit at about 2.13 the day `scale` renders.

`com.example.separable-blur` is a complete working sample. Two things in it are
not obvious and will both bite on a first attempt:

- **The loop bound must be a numeric literal** — not a `const`, which the
  validator's regex does not resolve, and certainly not a uniform. Loop to a
  fixed maximum and multiply the taps beyond your live radius by zero. A GPU was
  not saving that work anyway.
- **Handle the parameter's zero.** At radius 0 a Gaussian's sigma is 0 and every
  weight is NaN, which draws black — at the setting nobody changes first.

A chain compiles to one pipeline per pass, registered as
`<pluginId>.<effectId>#<passName>`. A single-pass effect keeps the bare
`<pluginId>.<effectId>` it always had. If any pass fails to compile the whole
effect renders passthrough and is marked failed by name — never a half-applied
chain.

The entry point must be called `fs` because that is the name the render pipeline
looks for, and every built-in shader here uses it. A differently-named one
compiles and then fails to bind, with a driver error naming nothing you wrote —
so it is refused at install with a message that says what to rename.

### What the validator refuses, and why

A GPU cannot be preempted. A fragment shader that takes too long is not slow —
it is a hang, and the operating system's answer is to reset the device, which on
Windows destroys every GPU context in the process. So one plugin's shader can
black out a viewport for a document that has nothing else wrong with it.

Refused before compilation:

- **A loop whose bound is not a literal.** `for (var i = 0; i < params.count; …)`
  lets a slider decide how long the GPU spends per pixel. Bounds must be
  literal, at most 256 per loop, nested at most 3 deep — bounds multiply.
- **`while` and `loop`**, which have no syntactic bound at all.
- **`discard`** — effects composite, so a discarded fragment shows the layer
  beneath rather than transparency. Use `alpha = 0.0`.
- **Storage buffers, atomics, `@compute`** — an effect reads its declared
  parameters and the input texture, and nothing else.
- Sources over 64 KB, or roughly 2000 statements.

Unlike the publish-time package scanner, which is advisory because it reasons
about intent, this refuses **syntax**. A loop whose bound is not a literal has
no bounded cost whoever wrote it and whatever they meant.

### When it goes wrong anyway

- **Compilation is bounded.** A driver that has not answered in 5 seconds is not
  waited on further.
- **Failure is passthrough, never a broken frame.** An effect that cannot
  compile renders its input unchanged. A missing or black layer reads as "my
  project is corrupted".
- **Device loss is attributed.** If the graphics device resets while one of your
  effects is drawing, that effect is disabled by name and the user is told which
  plugin. This is a *suspicion* and is worded as one — a device can also be lost
  because a driver updated or another application hung the GPU, and a loss with
  no plugin effect drawing blames nobody. The user can turn it back on, which
  recompiles it and puts it through every gate again.

### The layout is checked against a real GPU

`npm run verify-plugin-effect` renders a plugin-shaped effect at several
parameter values on an actual WebGPU adapter and fits a line through the
results. Three outcomes it can tell apart: output tracking the parameter (the
shader ran and read it from the right offset), output flat at the wrong value
(read from the wrong offset — the bug that actually shipped, where the generated
struct omitted the renderer's 64-byte header and the first parameter landed on
`mvp`), and output flat at the input value (never ran at all).

The golden-pixel gate cannot substitute: it runs WebGL2, where a plugin effect
is the host-generated passthrough, so the scene would pass while proving
nothing. `uniformLayoutOracle.test.ts` checks the same property statically and
runs everywhere; this is the version that asks a device.

**A skip is not a pass.** On a machine with no adapter the probe exits 0 and
says so, which is deliberate — but a probe that *fails* now exits 1 and says
which. It did not always: it loaded its page from a `data:` URL, an opaque
origin where `isSecureContext` is false and `navigator.gpu` therefore does not
exist at any hardware, and reported that as "no WebGPU adapter on this machine".
It skipped on every machine, for months, while reading as an environment limit.

### `render: "shader"` on a layer kind

Live as of API 4. It was a reserved value refused with a *version* message
before that, so an author who tried it early was told "not supported in this
version" rather than "unknown render strategy".

Note the cost against `"proxy"`: a proxy leaves ordinary layers behind and keeps
rendering after an uninstall, and a shader kind does not draw at all without the
plugin that provides its shader. Prefer `"proxy"` when your output can be
expressed as native layers.

### Three kinds of kernel: WGSL, GLSL, and CPU

An effect declares one or more of:

| Field | Runs on | Language |
|---|---|---|
| `shader` | WebGPU | WGSL, one `@fragment fn fs` |
| `glsl` | WebGL2 | GLSL ES 3.0, one `vec4 fs(vec2 uv)` |
| `cpu` | anywhere | WASM or JS, `render(input, output, w, h, params, host)` |

`shader` is API 4; `glsl` and `cpu` need `"apiVersion": 7`.

**An effect with no kernel at all is refused at install.** It would appear in
the browser, show its parameters, and change no pixels on any machine — which
reads as a broken plugin rather than as an incomplete manifest.

**A kernel missing for the LIVE backend is reported, not passed through.** The
effect reaches the state `unsupported` and emits no pass, so the layer renders
as if the effect were not there, and the reason names what to ship:

> “Bloom” ships WGSL, and this frame needs GLSL ES 3.0. Add a "glsl" kernel to
> the effect, or a "cpu" kernel, which stands in for any missing backend.

That is a change from the old behaviour, which drew a generated *passthrough* on
WebGL2 and said so only in the UI. Passthrough is still what a failed compile
falls back to; it is no longer what a missing kernel does.

```jsonc
{
  "id": "tint",
  "label": "Tint",
  "shader": "@fragment\nfn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> { … }",
  "glsl":   "vec4 fs(vec2 uv) { return texture(src, uv) * amount; }",
  "cpu":    { "module": "kernels/tint.wasm" }
}
```

**The GLSL contract mirrors the WGSL one.** You write `vec4 fs(vec2 uv)`; the
host writes `#version 300 es`, the std140 `Object` block (the *same* layout, so
both languages read the same bytes), `uniform sampler2D src`, the varyings, and
`main`. You must not write `#version`, `#extension`, `uniform`, `layout(...)`,
`main`, `discard` or `gl_FragColor` — each is refused at install with the reason,
because each either collides with generated code or does not exist under
`#version 300 es`. In GLSL your parameters are **bare names** (`amount`), not
`params.amount`; a layer input keeps the name you gave it, via a generated
`#define`.

Compile errors from a driver are re-pointed at **your** line numbers before they
are reported — the preamble is generated, and a log that named a line inside it
would send you looking for code you did not write.

A **chain must declare a language on every pass or on none**. A four-pass bloom
missing GLSL on its third pass would run three passes and stop, leaving the
layer holding an intermediate step, so the manifest is refused and the passes
missing it are named.

### CPU kernels

```jsonc
{ "cpu": { "module": "kernels/bloom.wasm", "entry": "render" } }
```

The module is read out of your package (so it carries the same integrity check
as everything else in it) and run by the host — never in your plugin's worker,
which is not woken. A kernel is a pure function over pixels: no host API, no
document, no network, no storage. That is the same structural constraint effects
have everywhere else, not a sandbox claim.

Where it runs depends on who is asking. **Inside an effect chain** — the bake —
it runs on the calling thread, in order with the built-in effects around it,
because effects composite and an effect lifted out of its order is a wrong
picture rather than a slow one. A caller that can *wait* for a whole-layer pass
instead hands the job to a **pool of host-owned workers**, which serialises it
according to your `threadSafety` and keeps only the newest request per lane
while the user scrubs.

```js
exports.render = function (input, output, width, height, params, host) {
  // input/output: Float32Array, RGBA, PREMULTIPLIED, 0..1, display sRGB
  for (var i = 0; i < input.length; i++) output[i] = input[i];
};
```

Two buffers, because an effect that reads a neighbourhood would otherwise read
pixels it has already written. Float32 because that is what the GPU path works
in — a kernel and its shader twin are then the same arithmetic. Premultiplied
because compositing is only linear in that form; the conversion from the raster
path's 8-bit straight-alpha bytes happens at the worker boundary, off the main
thread.

A **WASM** kernel exports `memory` and `render(inPtr, outPtr, width, height, time, seed)`,
and optionally `alloc`; without an allocator the host places the buffers at
`__heap_base` and grows the memory to fit.

`host` carries everything the shaders read out of the uniform block (below),
plus two things only a CPU kernel has:

- `host.cache` — `get(key)` / `set(key, value, bytes?)`, scoped to the effect
  **instance**, least-recently-used inside a byte budget. For the work that does
  not depend on the pixels: a LUT, a noise field, a weight kernel. Per worker,
  not global; an entry larger than the whole budget is not stored.
- `host.frames` — neighbouring frames, when you declared `frames` (below).

**The one-frame warm-up.** Instantiating a module is asynchronous; calling one
is not. The first frame an effect appears on, the host loads the module and
leaves the layer unchanged; every frame after that runs the kernel in place, in
order with the built-in effects around it. Blocking the render thread on a WASM
compile instead would be a stall on the frame the user adds the effect.

### Host-filled inputs

Every effect's parameter block carries these, whether or not it declares
anything. They are **not** parameters: you read them, you never declare them,
and a parameter that collides with one of these names is refused at install.

| WGSL / GLSL | |
|---|---|
| `texelSize` | `vec2`, one over the target's dimensions |
| `passScale`, `passIndex` | this pass's downsample and 0-based index |
| `compSize`, `layerSize` | `vec2`, composition and layer size in px |
| `time` | **this layer's** time in seconds — a retimed layer does not share the comp's |
| `compTime` | the playhead, in composition seconds |
| `frame`, `fps` | frame index at the comp's rate, and the rate |
| `pixelScale` | raster px per composition px (device ratio × zoom) |
| `downsample` | 1 at full quality, 2 at half, 4 at quarter |
| `seed` | stable per effect instance, across frames, sessions and machines |
| `layerRect` | `vec4`, your layer's box in `uv` units — `(uv - layerRect.xy) / layerRect.zw` is 0..1 top-down over the layer (GPU kernels; a CPU kernel's buffer is its layer canvas) |

`seed` is stable on purpose: a noise field reseeded per frame boils, and one
seeded from the clock is a different picture in preview and in export.

A CPU kernel reads the same values as named fields on `host`.

### Layer inputs, and frames either side

Up to **four** `layer` parameters. The first is bound at 3, the rest at 5, 6 and
7 — 4 is `origin` whether or not your effect has one, because a binding number
that moved with an unrelated part of your manifest would be one three separate
places had to re-derive and agree on. The second onwards need
`"apiVersion": 7`; one has always been allowed.

```jsonc
"params": {
  "depth":  { "type": "layer" },
  "normal": { "type": "layer" }
}
```

An input you have not pointed at anything **self-samples** rather than being
skipped: a declared binding with nothing bound is an invalid pipeline, so a
missing input draws something visibly wrong instead of nothing at all.

`frames: [-2, 2]` declares a temporal window over your own layer, handed to a
**CPU kernel** as `host.frames[-1]` and so on. Honest limits, because this is
the part most likely to disappoint:

- **±2 frames**, and only for a `cpu` kernel, and only under `"apiVersion": 7`.
  The GPU path has no binding for neighbouring frames, so declaring the window
  without a kernel to receive it is refused rather than accepted and ignored.
- **An offset the provider could not supply is ABSENT**, not zero-filled. Handle
  the miss — a kernel differencing against a black frame flashes at exactly the
  moments (the first frame, a seek) where a miss is likeliest.
- For an image or video layer the frames are its own **source** frames. For a
  **composited** layer — a precomp, a shape layer with effects beneath yours —
  the provider generally cannot supply them, because producing one would mean
  rendering another frame of the whole composition inside this one. Design for
  the window being empty.

### Region: `expand`, and `isIdentity`

Two declarations the host evaluates **per frame**, from your live parameter
values, in the same place After Effects' pre-render phase asks the same
questions. Both need `"apiVersion": 7`.

```jsonc
"expand":   { "right": { "param": "distance" }, "bottom": { "param": "distance" } },
"identity": [{ "param": "amount", "equals": 0 }]
```

`expand` is AE's max result rect, per side: how far outside the layer box you
draw, so the host reserves margin instead of clipping you. Each side is a number
or a `{ param, factor, plus }` formula over one of your own parameters, because
reach is animatable and a constant would have to be the worst case on every
frame. `spread` (one number for all four sides) still works; declaring both
takes the larger per side, which is the only reading that cannot clip.

`identity` skips the effect's passes **entirely** when every rule holds — an
effect stack is full of effects sitting at zero, each otherwise costing a
full-screen pass, a target and a pipeline bind every frame. It is data rather
than a callback for the reason at the top of this section: asking your worker
would be an async hop inside a synchronous render. A parameter nobody has
touched reads its declared **default**, not zero.

### Thread safety

```jsonc
"threadSafety": "instance"
```

| | |
|---|---|
| `unsafe` | one kernel call at a time across the whole plugin |
| `instance` | **default** — concurrent across effect instances, in order within one |
| `full` | no constraint; frames of one instance may overlap |

Needs `"apiVersion": 7`.

The default is strict deliberately: a wrong `full` is a race that shows up as
one corrupt frame in a hundred, which is unreportable, while an over-strict
default costs throughput and nothing else.

### Limits: `standard` and `extended`

```jsonc
"limits": "extended"
```

Needs `"apiVersion": 7`, including to name `standard` explicitly.

Every **rule** is identical in both tiers — no unbounded loop, no author
bindings, a `fs` entry. Only the **numbers** move:

| | standard | extended |
|---|---|---|
| Kernel source | 64 KB | 256 KB |
| Statements | 2000 | 8000 |
| Literal loop bound | 256 | 1024 |
| Passes / fill budget | 8 / 6 | 16 / 12 |

`extended` is a **request**, granted only for a plugin the user installed
themselves — a local folder or Developer Mode. A published plugin is refused it
with the reason. A manifest field that raised its own ceiling would be a ceiling
that does not exist, since every plugin would simply declare it.

What never moves is the refusal of an *unbounded* loop: trust raises a ceiling,
it does not make an uncostable loop costable.

### Known limits, stated

- **A missing kernel is now an error, not a passthrough.** The tiers a plugin
  can reach are its author's decision, and the surfaces still say what the
  machine can do:

  | Where | What the user or author sees |
  |---|---|
  | `effects.add` | `{ id, active: false, reason: 'webgpu-unavailable' }` on a tier this effect cannot use |
  | The plugin's row in the manager | a muted line saying its effects cannot draw on this renderer |
  | `requires: ["webgpu"]` | the install is refused, with the reason |
  | The project file | the effect is **saved** and draws wherever a kernel exists |

  Muted rather than red, deliberately: the plugin is fine and the work is not
  lost. This is a fact about the machine and about which kernels were shipped.

- **A CPU kernel bakes the layer.** An effect with no kernel for the live
  backend routes its layer through the CPU raster path, which is where the
  kernel runs. That is slower than the GPU path and it is the only way the
  effect draws at all; an effect that *does* have a kernel for the live backend
  is left on the GPU.
- **A kernel cannot be interrupted.** JavaScript has no preemption and a WASM
  instance has no fuel unless it opted in, so a runaway kernel is recovered by
  terminating its worker (8 s), not by asking it to stop. The frame goes out
  with the layer unchanged.
- **The statement ceiling is a proxy for cost, not a cost model.** A real one
  would mean writing a WGSL front end, and a hand-written parser fed hostile
  input is a worse liability than the thing it would protect.
- **Eight passes, and a cost budget of 6.** A pass costs `scale²` — its share of
  the layer's pixels — so eight quarter-scale passes cost 0.5 and eight
  full-scale ones cost 8 and are refused. Four full-scale passes (cost 4) now
  fit; they did not under the old budget of 3, which existed specifically to
  refuse them.

  The ceiling is a **constant and cannot adapt to the machine**, which is worth
  knowing before asking for it: it is checked during manifest validation, and
  the registry validates the same manifest on a server with no GPU. A
  hardware-dependent budget would let a plugin publish and then be refused at
  install with nothing naming the machine that drew the line. Adapting to the
  hardware is a render-time decision, not a manifest one.
- **A chain gets one `origin`, not one per pass.** It is the image entering the
  whole chain, captured before pass 0 — not "the pass before the previous one".
- **Four `layer` parameters per effect**, shared by every pass rather than
  being per-pass.
- **A CPU kernel on the bake path gets the COMP's time as `host.time`.** The
  bake is handed pixels and a chain with no layer beside them, so a retimed
  layer's kernel differs between the GPU and CPU paths until the bake carries a
  layer time. Stated rather than left to be discovered.
- **The compute cache is per worker.** Two workers running the same effect
  instance each build their own copy once; there is no shared memory here, and
  copying an entry between workers would cost more than rebuilding it.

### Gaps found rebuilding the depth plugin on shaders

The depth/parallax plugin has now been built three times against this API and
found a real gap each time — it is the only exercise here written from the
*outside*. `depthPluginRebuild.test.ts` is the report, executable: each gap is
an assertion that pins the current limitation and fails when it is lifted.

1. **CLOSED — an effect can sample up to four other layers.** The gap was that a
   depth plugin displaces one image by another and the generated bind group had
   exactly one texture. A `layer`-typed parameter closed it for one input;
   round C2 raised the ceiling to four, at bindings 3, 5, 6 and 7.

2. **A `render: "shader"` layer kind is not connected to an effect.** The
   strategy says a kind draws itself; nothing says *with what*. A plugin
   declaring both a kind and an effect has no way to state the relationship, so
   such a manifest is accepted and means less than it appears to.

3. **CLOSED — an effect reads the time, the sizes, the rate and a seed.** Not
   as the `'resolved'` parameter type this report proposed, and the difference
   is the interesting part: a host-filled *parameter* would be a row in the
   author's list that they cannot set, must not name twice, and would have to
   declare in every effect to reach values the host knows unconditionally. They
   are members of the block instead — every effect has them, no effect declares
   them, and a parameter that collides with one of their names is refused.

4. **A shader kind is forced to declare properties it does not have.**
   `parseLayerKinds` refuses a kind with no props — correct for `none` and
   `proxy`, where props *are* the authored interface, and wrong for `shader`,
   whose parameters live on its effect. Today an author invents a property to
   satisfy a rule written before their render strategy existed, and then leaves
   it unread: a control that does nothing, which is what the rule exists to
   prevent.

Gaps 1 and 3 are now **closed** (round C2), and the assertions that pinned them
have been rewritten to pin the new contract rather than deleted — a gap report
whose fixed entries vanish cannot be read back as a history. Gaps 2 and 4 stand:
both are validator changes the registry's copy of the corpus would have to agree
on, and a gap report that quietly patches what it finds stops being a report.

---

## 13. Network (API 4)

A plugin can contact the internet. It declares **which hosts**, the user
approves them **by name**, and the request is made by the host — never by the
plugin.

### Why hosts are declared, and why they are exact

Every other permission bounds what a plugin can *touch*. This one bounds where
it can *send*, and that is a different kind of question. "Can contact websites"
is not a decision anyone can act on; "can contact `api.acme.com`" is. So the
manifest lists hosts, the consent screen prints them verbatim, and the host
checks every request against that same list.

```json
{
  "apiVersion": 4,
  "permissions": ["scene:read", "net:fetch"],
  "contributes": {
    "net": { "hosts": ["api.acme.com", "cdn.acme.com"] }
  }
}
```

The permission and the block **imply each other, both ways**. `net:fetch` with
no hosts puts a permission on the install screen with nothing under it. Hosts
with no permission is the shape of a plugin that adds the permission in a later
version, once the list has been sitting in the manifest unread.

Wildcards are refused. `*.example.com` on a consent screen is a category, not
a destination, and the whole value of the list is that a user can read it and
recognise what is on it. The cost is real — three subdomains means three
entries — and it falls on the author who knows their own infrastructure rather
than on the user deciding whether to trust it. Eight hosts is the cap: a list
nobody reads is a list nobody checks.

### The consent screen says the dangerous part out loud

`net:fetch` is the one permission whose danger is a **combination**. A plugin
holding `scene:read` and `net:fetch` together can copy the user's project
somewhere else. That is not a flaw in the design — it is what the pair means —
so the text says it in those words rather than listing two capabilities and
leaving the user to multiply them.

### What the host enforces, per request

The plugin has no `fetch`; `fetch`, `XMLHttpRequest` and `WebSocket` are all
removed at worker lockdown. `motion.net.fetch(url, init)` is a message, and the
host checks it like any other:

| Rule | Why |
|---|---|
| HTTPS only | Plain HTTP is readable and modifiable by anything on the path, and this traffic carries whatever the plugin was granted |
| Exact host match | `api.example.com` does not permit `evil.api.example.com`, and neither permits the other |
| **Every redirect hop re-checked** | `redirect: "manual"`; a 302 off the list is refused, not followed |
| Max 4 hops | A redirect chain is not a loophole to walk |
| **Resolved address checked, not just the name** | Below |
| 8 MB response cap | Counted **as bytes arrive**, not from `content-length` — a header is a claim |
| 15 s timeout | |
| 60 requests/minute per plugin | Refused destinations count too, so probing is not free |
| `credentials: "omit"` | The user's cookies are not the plugin's to spend |
| Response headers filtered | `content-type`, `content-length`, `etag`, `last-modified` — the rest is fingerprinting surface |

Refusals name **only the host**, never the full URL: the URL is
attacker-chosen and may end up in a log or a screenshot, and the host is the
part a user can act on.

### DNS rebinding, which is the interesting one

Declaring `api.acme.com` and blocking `localhost` by *name* stops nothing. A
host the author controls can resolve to `127.0.0.1` — the name is on the list,
and the socket lands on the user's own machine. So the check is on the
**resolved address**: loopback, link-local, RFC1918, carrier-grade NAT,
benchmark ranges, multicast, IPv6 loopback and unique-local, and
IPv4-mapped-IPv6 spellings of all of them.

### The request is made by the main process, and why

A renderer cannot resolve DNS, and it cannot reach a plugin's hosts either. The
app shell ships a CSP whose `connect-src` names our backend, our media origins
and localhost — `api.acme.com` is not on it, so a renderer-side plugin request
is refused before a socket opens.

The fix people reach for is to widen `connect-src` to cover every host every
installed plugin declared. That loosens the policy for the **whole renderer**,
not for the plugin: any script that ever runs there inherits the widened reach
as a side effect of a plugin the user installed for something unrelated.

So the request moves instead of the policy. The renderer's ceiling stays exactly
where it was, and the work is split:

| | Renderer (`pluginNetFetch.ts`) | Main (`electron/pluginNet.ts`) |
|---|---|---|
| Which plugin is asking | ✔ | — |
| Declared hosts, the grant, the budget | ✔ | — |
| The redirect loop and hop budget | ✔ | — |
| https only | ✔ | ✔ |
| Resolved address refused if private | ✔ | ✔ |
| Byte cap, timeout, no cookies | ✔ | ✔ |
| Opens the socket | — | ✔ |

The overlap is deliberate. Main is where the connection happens, so it does not
take a destination on trust from a caller — even one it believes. The renderer
is where the manifest and the grant live, so main cannot know whether a host was
declared. Neither side is sufficient alone.

**Redirects are not followed in main.** A hop is a new destination and has to be
re-checked against the plugin's declared hosts, which main cannot see. So a 3xx
comes back as a 3xx with its `Location`, and the renderer re-runs the same
check it ran on the original.

This is **not** a general fetch bridge. `apiProxy.ts` refuses to be one because
main attaches the user's bearer to its requests, and an open relay would spend
that credential on any URL. These verbs attach nothing — no token, no cookie, no
key — and `ipcGuard` keeps them out of reach of a plugin panel, which is a
subframe. What is left to protect is the user's own network, and the table above
is how.

`installPluginNetBridge()` runs at the renderer entry, before any plugin host
boots. In a browser build there is no bridge, the resolver stays null, and
`netGuardStatus()` reports `rebindingCheck: false` rather than implying a
protection that is not running.

### The panel stays network-free

A plugin granted `net:fetch` does **not** get a panel that can reach its
declared hosts. The shell keeps `connect-src 'none'`. Widening it would hand
the capability to the wrong realm: a panel is inline script from the package
with nothing between it and the socket, while a worker's request passes the
permission gate, the grant, the manifest, and every cap above. There is a
regression guard in `noHostRealmEval.test.ts`, and it fails if either the
policy loosens or the frame path starts reading `contributes.net`.

### Both validators, one corpus

`motion-back` re-implements every rule above — it must, since it accepts the
package before any editor sees it, and a package the registry accepts and the
editor then refuses is a download that cannot work. The two are kept honest by
`__fixtures__/manifests.json`, byte-identical in both repos, with 13 cases for
`net` alone. The permission text is shared the same way
(`permissions.json`), because the sentence a user reads on the marketplace and
the one they read on the install screen must be the same sentence.

---

## 14. Scale, and the metric that decides it

Nothing in this section is built. It is written down so it is not rediscovered
as an emergency, which is the only reason to write it down before it is needed.

### Package bytes stay in Postgres until one number says otherwise

They are in `PluginVersion.packageBytes` because the client verifies a
signature over those exact bytes, and every hop that could re-encode them turns
a delivery detail into a signature failure a user reads as "this plugin is
compromised".

The number that decides the move is **not** total storage. `totalBytes` is the
obvious metric and the least urgent — Postgres is comfortable holding tens of
gigabytes of `Bytea`, and the pain it eventually causes (backup and restore
windows) arrives slowly and visibly.

The one that bites first is **`peakResponseBytes`**. Serving a download reads
the whole row into the Node process and base64-encodes it, so an 8 MB package
becomes ~10.7 MB of string, per concurrent download, in the heap. Ten
simultaneous installs of the largest allowed package is ~107 MB of transient
heap on top of everything else. That is what becomes an out-of-memory restart
under a launch spike, and it is driven by package **size** and **concurrency** —
neither of which appears in a storage total.

`GET /plugins/admin/storage` (operator only) reports all of it. Watch
`p95Bytes` and `maxBytes` against download concurrency; when their product
approaches the process memory limit, move the bytes.

### The precondition is already in place

Moving bytes to object storage means bytes and metadata stop sharing an origin.
What binds them again is the digest — and the digest has to travel with the
**metadata**, not with the bytes:

* `sha256` is in the browse listing, the detail response and the update offer.
* `fetchRegistryPackage` verifies the downloaded bytes against the digest its
  CALLER was given, and deliberately ignores the `sha256` in the download
  response. A digest that arrives alongside the bytes it describes cannot
  detect anything about them.
* Absent a digest, the install falls back to the signature alone, which is what
  it always had. The digest is not the security boundary and must never be
  described as one: it answers "are these the bytes the registry named", while
  only the pinned publisher key survives a compromised registry.

This shipped before the move rather than during it, because adding a field to a
response is cheap now and a protocol change made under pressure afterwards.

### Update checks could stop identifying users

`POST /plugins/updates` sends the caller's installed plugin set, which tells
the server what software is on a specific person's machine. The revocation list
shows the alternative: a signed, cached, public manifest the client matches
locally, uploading nothing. If that model is extended to updates,
`POST /plugins/updates` can be retired.

Gated on the same "when the numbers demand it" rule, and worth noting the
tension: the manifest grows with the catalogue, so it trades a request that
scales with one user's installs for a download that scales with every published
plugin. There is a catalogue size where that stops being a good trade.

### The trusted tier is not being built

Verified publishers only, an unmistakable install-time warning, a Node host with
filesystem and subprocess access. Defensible as an opt-in tier a user accepts
with eyes open; catastrophic as a default. **Not before Stage 1 is mature** —
and Stage 1 shipped days ago, so the answer today is no.

### Route order is load-bearing

Express matches in declaration order and `:id` matches any single segment. The
signed revocation list was declared below `@Get(':id')` and therefore answered
404 "no plugin revocations" — the safety mechanism the whole design rests on,
unreachable, with nothing reporting it because the client swallows that failure
on purpose so being offline is not an error.

Neither existing test could see it: the guard test reads decorator metadata,
where the route is present and correctly public. Only the order was wrong.
`plugins.routes.spec.ts` now refuses it structurally — within one method, a
leading-literal route must be declared before any same-length route whose first
segment is a parameter — and `plugins.public.spec.ts` checks the real response
over real HTTP.

---

## 15. Incident runbook

Who blocks a plugin, how, what the user sees, and what is said publicly. Written
before it is needed, because the first time this path runs should not also be
the first time anyone reads it.

### Severity, and what it changes

| | What it looks like | First move |
|---|---|---|
| **P1** | Actively harmful: exfiltrating projects, destroying documents, a malicious update to a popular plugin | Block immediately, ask questions after |
| **P2** | Harmful if used: an undisclosed capability, a permission grab, impersonation of another publisher | Hold the version, contact the publisher |
| **P3** | Wrong but not dangerous: broken package, misleading listing, licence complaint | Normal review queue |

Blocking is reversible and cheap. A P1 judgement call that turns out wrong costs
a publisher a few hours; the reverse costs users their work. Block first.

### The path

1. **A report arrives** — `POST /plugins/:id/report`, from a user who may not
   have an account. It lands in the case queue, deduplicated per plugin and
   version.
2. **A reviewer triages** at `/admin/plugins/review`. Publish-time scanner
   findings are attached and are **advisory** — a high score is a reason to
   look, never a reason to act on its own.
3. **An operator blocks.** Requires the `admin` role. A reason of at least 8
   characters is mandatory, and it is not bureaucracy: that string is what the
   user is shown, so "spam" helps nobody.
4. **The revocation list picks it up automatically.** `blocked` +
   `blockedReason` are what `RevocationService` signs. There is no separate
   "publish the revocation" step to forget.
5. **Running installs stop at next boot**, and mid-session for anyone who has
   the manager open.

### What the user sees

They are told the plugin was withdrawn and given the reason string verbatim.
**Their copy keeps working.** Blocking hides a plugin from browse and refuses
new downloads; it does not delete anything. Breaking someone's project is
usually a bigger harm than the one the takedown addresses.

The exception is `DELETE /plugins/:id/admin`, which destroys the bytes and the
version history and cannot be undone. It exists for content that must not remain
on our servers at all, and for nothing else. It is not the tool for abuse.

### Verify it actually worked

The failure mode here is silence. `fetchRevocationList` swallows errors on
purpose so that being offline is not an error a user sees while opening a panel
— which means a broken revocation path reports nothing at all. It was broken
exactly this way once (§14).

So after blocking anything, check the list directly:

```bash
curl -s https://<host>/api/plugins/revocations
```

Confirm three things: the response has `payload` and `signature` (not a 404
body — a 404 from a route-order mistake and a genuinely empty list are different
failures), the plugin id appears in `entries`, and `seq` has increased. A
client refuses a list whose `seq` is not newer than the one it holds, so a
stalled sequence means the block does not propagate.

### What is said publicly

- **Name what happened, not who reported it.** Reporters are never identified,
  including to the publisher.
- **The reason string is public**, because the user already sees it. Write it
  knowing that.
- **Do not describe the exploit** while installs are still running. "This
  version could read files outside your project" is enough; the method is not.
- **Say when it is resolved**, in the same place. A withdrawal notice with no
  follow-up reads as an unresolved accusation forever.

### Key compromise

A stolen publisher key is the one case blocking does not fix, because the
attacker can sign. Block every affected version, then require rotation — the
publisher re-authorises with their account **password**, not just a session, and
every installed copy prompts its own user before accepting the new key. Three
gates, and a stolen account clears only one.

## 16. Installing from a folder on this machine

Every host a professional already uses ships plugins as files in a known
directory. After Effects scans `…/Common/Plug-ins/7.0/MediaCore` and its own
`Plug-ins` folder; an OFX host scans `…/Common Files/OFX/Plugins` plus whatever
`OFX_PLUGIN_PATH` names; Resolve loads Fuses from a Fusion directory. A vendor
installer writes files there and the host picks them up at launch. Nobody drags
a zip onto a panel — and an author REALLY does not want to, once per edit.

### Where it looks

| | Path |
|---|---|
| Yours | `<userData>/Plugins` — the folder button in the Plugins panel opens it |
| Machine-wide | Windows `%ProgramData%\<App>\Plugins` · macOS `/Library/Application Support/<App>/Plugins` · Linux `/usr/share/<app>/plugins` |
| Override | `MOTION_PLUGIN_PATH`, `;`-separated on Windows and `:`-separated elsewhere |

Each root is scanned four levels deep. A directory holding `plugin.json` **is**
a plugin and is not descended into, so a package's own `lib/` cannot register a
second one. Folders whose name ends in `()` or starts with `~` are skipped —
AE's convention, kept because vendors already follow it, so "rename it to turn
it off" works here the way it does there. Both an unpacked folder and a
`.mplugin` archive are accepted.

Two copies of the same plugin id resolve by **version**, highest wins, and the
panel names the copy it ignored. Not by which directory was scanned first:
search-path order is an implementation detail nobody can predict from outside,
while "drop a newer build in your own folder and it takes over" is a rule an
author can act on.

### Signed, or Developer Mode

A registry package is signed, and the signature is checked on the user's machine
over the exact bytes about to be installed. A folder cannot be: its author is
editing the files. So the folder tier has two ways to be allowed to run, and
exactly two.

**Sign it.** `node scripts/pack-plugin.mjs ./my-plugin --key ./plugin-key.json`
writes `my-plugin-1.0.0.mplugin` and `my-plugin-1.0.0.mplugin.sig` beside it.
The sidecar holds a detached ECDSA P-256 / SHA-256 signature over the archive's
exact bytes — the same form `scripts/sign-plugin.mjs sign` produces for the
registry, verified by the same code. A signed package loads with no switch.

**Or turn on Developer Mode**, in the Plugins panel. Unsigned packages in these
folders then load, and a change on disk reloads them. It is persisted, it warns
before it turns on, and it changes nothing else: a plugin loaded this way runs in
the same Worker, behind the same permission gate, through the same consent
screen. What it changes is whose code is allowed to get that far. It does not
reach the native tier either — `runtime: "native"` has its own trust record.

Revocation still applies to both. A withdrawn plugin does not become
installable by putting it in a folder.

### The edit/run loop

1. Put your folder in the plugins directory — the folder button in the Plugins
   panel opens it, creating it if it is not there yet.
2. Turn on Developer Mode. Press **Load**, grant permissions once.
3. Edit. The folders are watched while Developer Mode is on, so the panel
   re-scans on save; press **Reload** to restart the plugin with the new files.
4. **Log** shows everything the plugin printed, plus any error it threw, with
   stack frames named after your files.

You are asked to grant permissions again only when something about what the
plugin may do has changed: a manifest that grew a permission, a package that
turned `runtime: "native"`, or a signed package arriving under a different
publisher key than the one this machine pinned. A reload that asks for the same
things reloads silently — an author saving a file twenty times must not answer
twenty consent screens, and nothing has changed to consent to.

### What the main process will and will not do

Scanning and reading happen in Electron's main process, because the renderer has
no filesystem and that is a property worth keeping. The renderer can ask for the
list of roots, for the candidates in them, for the bytes of **one package inside
a root**, and for the user's own folder to be opened. It cannot name a path
outside those roots: `plugins:read` resolves the path and refuses anything that
is not contained in one, which is what keeps it from being "read any file on
this machine". There is no write verb at all.

---

## 17. Generator layers (API 6)

A `render: "generator"` layer kind produces **geometry**, once per frame, from
real JavaScript you write. It is the strategy for output the other two cannot
express: fifty thousand particles is not fifty thousand native layers, and a
simulation is not a function of screen position.

```jsonc
"apiVersion": 6,
"contributes": {
  "layerKinds": [{
    "id": "sparks",
    "label": "Sparks",
    "render": "generator",
    "schemaVersion": 1,
    "props": {
      "rate":    { "type": "number", "default": 400, "min": 0, "max": 5000, "animatable": true },
      "gravity": { "type": "number", "default": 240, "animatable": true },
      "tint":    { "type": "color",  "default": "#ff8a2a", "animatable": true }
    }
  }]
}
```

```js
motion.generators.register('sparks', (req) => {
  const sim = req.state ?? seed(req.seed);
  step(sim, 1 / req.fps, req.params);
  return {
    instances: pack(sim),      // Float32Array, 9 floats per instance
    count: sim.alive,
    primitive: 'point',
    state: sim,                // carried to the next frame, and checkpointed
  };
});
```

### The instance buffer

One `Float32Array`, **nine floats per instance**, in this order:

| offset | field      | meaning |
|--------|------------|---------|
| 0,1,2  | `x, y, z`  | layer pixels, origin at the **centre** of the layer box; `z` is depth |
| 3      | `size`     | the instance's side, in layer px |
| 4      | `rotation` | **radians** |
| 5–8    | `r,g,b,a`  | 0..1, **straight** alpha (the host premultiplies) |

With `stride: 11` two more floats follow — `u, v`, the top-left of this
instance's cell in a texture your package ships (`textureAssetKey`), whose cell
size you declare once as `cellSize`.

It is one typed array rather than an array of objects because that is the
difference between a feature that works at 50 000 particles and one that does
not: a single buffer is one allocation and, with `transfer: true`, a **move**
rather than a copy across the worker boundary. Return `transfer: true` only if
you built the buffer fresh — the host will detach a pool you meant to reuse.

`primitive` is `'point'` (soft round falloff), `'quad'` (hard-edged),
`'sprite'` (your texture, needs stride 11) or `'mesh'` (your triangles, placed
once per instance; `mesh: { vertices, indices }`, five floats per vertex —
x, y, z, u, v).

### Your own sprite texture

`textureAssetKey` names a **file inside your own package** — `sprites/atlas.png`
— not a project asset id, because an asset id means nothing in someone else's
project while a file you shipped is the same everywhere. It is read out of your
installed payload through the same resolution `motion.package.read` uses, so it
can reach exactly what you shipped and nothing else on the machine. `.png`,
`.jpg` and `.webp` all work.

It is decoded **once per file**, however many layers and frames name it, and the
decode is asynchronous while your frame is not. So the first frame or two of a
brand-new sprite field draw as untextured points and upgrade the moment the
image lands — and an **export waits** for it rather than shipping untextured
sprites. A file that is missing, corrupt or larger than 4096 px on a side is
reported once in your plugin's log and the layer keeps drawing untextured.

`cellSize` is the size of one atlas cell in texture UV (`[0.5, 0.5]` for a 2×2
sheet) and each instance's `u, v` is the **top-left of its cell**, so a sprite
samples `u,v + corner × cellSize`. Declared once per frame rather than per
instance, because every sprite in an atlas run is the same size and repeating it
50 000 times would cost 400 KB a frame to say one thing.

### The frame request

```
{ layerTime, compTime, frame, fps, compSize, layerSize, params, seed, state }
```

`layerTime` is the layer's own clock — time stretch, time remap and Speed %
already applied — and is what a simulation should integrate. `frame` is the
integer composition frame and is what the host keys its checkpoints on. `seed`
is stable for the life of the layer and saved with the document, so the same
project gives the same particles on every machine.

### Determinism, and what the host does for you

**The same frame must give the same instances.** The host guarantees half of it:
your `state` is checkpointed every few frames, and a seek replays from the
nearest checkpoint at or before the target, so the `state` you are handed is
always the state that frame really had — never whatever the playhead happened
to leave behind. You owe the other half: no `Math.random()`, no wall clock,
nothing the request did not carry.

One limitation worth knowing: the intermediate frames of a catch-up are
simulation steps, not frames anyone looks at, and they are given the TARGET
frame's sampled `params`. A generator whose behaviour swings violently over a
few animated frames will reproduce those frames slightly differently after a
long seek than after playing into them.

### When your code runs

Never inside the render loop. The host requests frames ahead of the playhead
during playback, serves the most recent available frame while the exact one is
being made (so the viewport never blanks), drops superseded requests during a
scrub, and **awaits the exact frame during export** — a generator that does not
answer in time fails the export by name rather than shipping the previous
frame's particles under this frame's number.

A `generate` that takes longer than two seconds (twenty in export) is reported
as a plugin error, and three consecutive failures stop the layer asking until
something about it changes.

### What the layer is, once you have returned

An ordinary layer. The instances are drawn instanced into an offscreen and
composited like any other content, so blend modes, masks, track mattes, effect
stacks and motion blur apply to the result with no special cases. `blend: 'add'`
on the FRAME composites the instances additively against each other inside the
field; the layer's own blend mode still applies to the finished field.

When the layer is 3D, instance `z` drives a perspective divide through the
composition's camera — position and size scale by `focal / (focal − z)` — so a
system flying past the lens parallaxes. It is not a depth test against other
layers: the field composites as one flat layer, and instances draw in the order
you packed them.

### Limits

| | |
|---|---|
| instances per layer per frame | 200 000 |
| mesh vertices / indices | 65 536 / 196 608 |
| `generate` budget | 2 s preview, 20 s export |

Selection, the marquee and raster padding all follow your instances rather than
the emitter box. Declare `maxBounds` if your particles leave the box and you
would rather the host did not measure them — it is the one per-instance pass the
host does on the main thread.

---

## 18. Plugin UI (API 7)

Everything in this section is one idea seen from five sides: a plugin that can be
**used** rather than only invoked. They landed in one grammar version because
half of them is not worth shipping — a tool with no way to draw is a cursor that
does nothing visible, and parameters with no way to act on them are a form.

The rule the whole section obeys is the one §9 states for layer kinds and means
just as literally here: **you declare, the host draws.** There is no callback
that returns markup, no handle on a canvas, no DOM. A plugin that could render
into the inspector or paint into the viewport could draw a convincing permission
prompt, and every plugin's controls would age differently from the app around
them. When the vocabulary is missing something, the answer is another entry in
it — never an escape hatch. Free-form UI lives in your **panel**, in its own
sandboxed frame (§5).

```json
"apiVersion": 7,
"contributes": {
  "commands": [{ "id": "bake", "label": "Bake pins", "submenu": "Cleanup" }],
  "inspector": [ ... ],
  "tools":     [ ... ],
  "shortcuts": [{ "command": "bake", "chord": "Ctrl+Alt+P" }],
  "expressions": [{ "name": "pulse", "args": 1, "default": 0 }]
}
```

Capabilities: `ui.inspector`, `ui.canvas`, `ui.tools`, `ui.shortcuts`,
`ui.expressions`. List in `requires` whichever your plugin cannot work without.

### 18.1 Parameters on somebody else's layer

`contributes.inspector` declares a **section in the Properties panel** for layers
you did not create. §9's `props` describe a layer your plugin invented; these
describe your controls on an ordinary shape, text or image layer.

```json
"inspector": [{
  "id": "lift",
  "title": "3D Lift",
  "icon": "cube",
  "appliesTo": ["shape", "text"],
  "params": [
    { "name": "amount",  "type": "slider",  "default": 50, "min": 0, "max": 100,
      "unit": "%", "animatable": true },
    { "name": "radius",  "type": "slider",  "default": 4, "min": 0.1, "max": 500,
      "logarithmic": true, "unit": "px" },
    { "name": "mode",    "type": "enum",    "default": "soft",
      "options": [{ "value": "soft", "label": "Soft Light" },
                  { "value": "hard", "label": "Hard Light" }] },
    { "name": "tint",    "type": "color",   "default": "#ff8800cc", "alpha": true },
    { "name": "centre",  "type": "point",   "default": { "x": 0, "y": 0 }, "animatable": true },
    { "name": "origin",  "type": "point3d", "default": { "x": 0, "y": 0, "z": 0 } },
    { "name": "spin",    "type": "angle",   "default": 0, "animatable": true },
    { "name": "soft",    "type": "checkbox","default": false },
    { "name": "feather", "type": "slider",  "default": 1, "group": "Edges",
      "showIf": { "param": "soft", "equals": true } },
    { "name": "bake",    "type": "button",  "label": "Bake pins", "command": "bake" },
    { "name": "state",   "type": "status",  "label": "State", "text": "Idle" }
  ]
}]
```

| type | control | notes |
|---|---|---|
| `slider` / `number` | value field | `unit` is drawn in the field. `logarithmic` (slider only) makes a pixel of drag a constant **ratio** — the step is recomputed from the current value — and needs `min` above zero. |
| `angle` | dial | Always degrees, unbounded: a revolution is a legitimate value. |
| `checkbox` | tick | |
| `enum` | dropdown | `options` carry a **label** each. That is the whole reason this is not a string list. |
| `color` | swatch | `alpha: true` to edit and store `#rrggbbaa`. A default with alpha on a parameter that did not ask for it is refused — a plugin reading `#ff8800` and handed `#ff8800cc` renders the wrong colour and never finds out. |
| `point` / `point3d` | one row of X/Y(/Z) fields | Stored as separate numbers per axis, so each axis is an ordinary animatable property. |
| `button` | button | Runs one of **your own** `contributes.commands`, named by `command`. A button wired to a command the manifest does not declare is an install error. |
| `status` | read-only line | You write it with `motion.ui.setStatus(...)`. Never saved with the document — it is what your plugin currently believes, and a belief from last Tuesday restored with the project is worse than no line. |

`group` is a flat heading (never nested — see §9), `showIf` names a **sibling**
parameter, `label` falls back to a humanised `name`, and `animatable` is only for
the numeric and point types.

`appliesTo` lists layer kinds; omit it for every layer. The section appears with
one plugin's title, and when several plugins contribute to the same layer it is
titled "Plugin parameters" with each panel attributed to its plugin by name.

**Animatable means animatable.** A parameter with `"animatable": true` is a real
property: it keyframes, eases, takes an expression, appears in the graph editor
and aggregates over a multi-selection with a dash for mixed values, because the
row is the same row `Position` uses. Nothing in the render path reads it — it is
**your** input. Sample it with `motion.animation.sample(layerId, path)`, exactly
as for a layer kind's props.

Read and write values from your worker:

```js
const values = await motion.params.get(layerId);          // every parameter, defaults included
await motion.params.set(layerId, 'amount', 75);           // one panel
await motion.params.set(layerId, 'lift', 'amount', 75);   // several panels: name one
motion.ui.setStatus('state', `${pins.length} pins placed`);
```

A parameter the user has never touched **stores nothing** and reads as its
declared default; the values component appears on the layer at the first write.
They are the user's data, so they survive an uninstall — the section disappears,
the values do not, and reinstalling finds the work where it was left.

### 18.2 On-canvas UI — a retained draw list

After Effects hands a custom-UI effect a Drawbot context and calls it back on a
draw event. That works because an AE plugin is native code in the host's process.
Here you are in a Worker: a callback cannot cross the boundary, and one that
could would be third-party code running inside the viewport's paint.

So you send **data**. `motion.ui.draw(list)` replaces your whole drawing; the
host repaints it every frame with the layer's transform applied.

```js
motion.ui.draw({
  layerId, space: 'layer',
  items: [
    { k: 'line',   from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, color: '#4da3ff', dash: true },
    { k: 'rect',   x: 0, y: 0, w: 100, h: 60 },
    { k: 'circle', x: 50, y: 30, r: 20, fill: '#ffffff' },
    { k: 'path',   points: [{ x: 0, y: 0 }, { x: 40, y: 20 }], close: false },
    { k: 'text',   x: 0, y: -10, text: 'Lift', size: 11 },
    { k: 'handle', id: 'p0', x: 100, y: 0, shape: 'circle', hitRadius: 9 }
  ]
});

motion.ui.onCanvas((e) => {
  // e.type: 'down' | 'move' | 'up' | 'hover' | 'key'
  // e.x / e.y are in the LAYER's space; e.handleId names the grabbed handle.
  if (e.type === 'move' && e.handleId === 'p0') {
    motion.scene.setProperty(e.layerId, 'x', e.x);
  }
});
```

- **Coordinates are the layer's own** — the same space its anchor point and mask
  vertices are in. The host applies parenting, 3D and animation when it paints
  and un-applies them when it routes an event back, so you never see a zoom
  level, a pan offset, a device pixel ratio or a window size. `space: "comp"`
  (with `layerId: null`) is the escape hatch for a gizmo that belongs to the
  composition rather than to a layer.
- **Handles are inputs.** Their `radius` and `hitRadius` are in **screen**
  pixels, so a grab target stays grabbable at 25% zoom. The nearest handle within
  its radius wins, not the first one you emitted.
- **Drawing is not a claim on the canvas.** A press on one of your handles is
  yours; a press anywhere else falls through to Select, so your gizmo can sit on
  screen while the user keeps working. If you want the whole viewport, contribute
  a **tool** (§18.3) — a tool also receives `key` events, which a drawing does
  not.
- **One gesture is one undo step.** The host opens a history bracket on the press
  and closes it on the release, so however many `scene.setProperty` calls your
  drag makes, the user presses Ctrl-Z once.
- Limits, enforced on arrival: 512 items, 512 points per path, 120 characters of
  text, colours as **hex literals only**, coordinates finite. A list that breaks
  them is refused whole rather than drawn in part.

### 18.3 Tools

```json
"tools": [{ "id": "place", "label": "Place pin", "icon": "crosshair", "cursor": "crosshair" }],
"activationEvents": ["onTool:place"]
```

The tool appears in the toolbar (plugins share one flyout — the strip is the most
contested space in the editor), in the Plugins menu and in the palette. While it
is active your plugin receives **every** pointer and key event in the composition
window, in layer space, through the same `motion.ui.onCanvas` handler; picking any
built-in tool stands it down, and `motion.tools.onChanged` tells you either way.

`icon` is required — the strip is glyphs — and `cursor` comes from a fixed list
(`default`, `crosshair`, `move`, `grab`, `text`, `rotate`, `pen`), never a URL: an
arbitrary cursor image is a fake pointer drawn a few pixels from the real one.
Four tools per plugin.

### 18.4 Shortcuts

```json
"shortcuts": [{ "command": "bake", "chord": "Ctrl+Alt+P" }]
```

Write `Mod` for Cmd on macOS and Ctrl elsewhere. A chord needs at least one
modifier (function keys excepted) — a bare letter takes it from every surface
that might want it.

A declared chord is a **request**. It is granted when nothing else holds it and
**refused with a line in your log** when something does, naming the command that
has it. That is not a failed install: your command stays in the Plugins menu and
the palette, and the user can bind their own chord in **Customize...**, which
walks the command registry and therefore already sees plugin commands. The check
reads the live registry, so a chord the user has moved counts as free where it
used to be and taken where it now is.

### 18.5 Menu grouping

`commands[].submenu` folds a command under a heading inside your own block of the
Plugins menu — one level, never a tree. Past the menu's 14-entry ceiling the host
folds **every** plugin into a submenu of its own name, whether they asked or not:
a menu that runs off the bottom of the window has entries nobody can reach.

Your panels also appear in **Window ▸ Panels**, which is where a user looks for
"what else can I dock" — the Plugins menu is where they look when they are
thinking about plugins, which is a different moment.

### 18.6 Expression functions, and why they are precomputed

```json
"expressions": [{ "name": "pulse", "args": 1, "default": 0, "description": "beat strength" }]
```

```js
// Push values as you compute them — then every call is a cache hit.
motion.expressions.provide('pulse', [2], 0.75);

// Or answer on demand. The host asks once per argument list it has not seen.
motion.expressions.handle('pulse', (t) => computePulse(t));
```

In an expression:

```js
plugin.studio_acme_lab.pulse(time) * 100
```

**Why it is not a direct call.** The expression engine is synchronous by
construction: it interprets an AST and calls your function once per animated
property per frame, inside the frame budget. You live behind a `postMessage`.
There is no arrangement of those two facts in which your code runs *during* an
evaluation — the alternatives are blocking the render thread on a worker (which
the platform forbids, and which would be a hang if it did not) or making every
expression async, which would change the meaning of every expression already
written.

So the contract is a cache, and it is stated rather than hidden:

- a **hit** returns your value immediately, with no round trip;
- a **miss** returns your declared `default` and asks you once for that argument
  list; when you answer, the value lands in the cache and the next frame is
  correct.

A plugin that pushes its values with `provide` never misses. `default` is
therefore required: a function that returns nothing on its first frame makes
every expression using it throw on the frame the user adds it. Values are a
number or a vector of 2 to 4 numbers; the cache holds 256 argument lists per
function and drops the oldest, because an expression scrubbed over time calls
with a new argument every frame.

Everything hangs off one name, `plugin.<namespace>`, where the namespace is your
plugin id with dots and dashes folded to underscores. One name, because the
expression scope's keys are the **language** — `wiggle` is part of it and your
function is not — and a scope whose contents appear with what the user has
installed could be neither documented nor completed. Two plugins whose ids fold
to the same namespace are a collision: the second is refused and told so, rather
than shadowing the first.

## 19. Native modules (the compiled tier)

Everything above this section is JavaScript, WebAssembly and shaders. That
covers almost everything, and where it does not cover it the gap is not small:
a hardware decoder, an optical-flow tracker, a mesh solver, a pixel kernel with
twenty years of hand-written SIMD in it. Those arrive as compiled libraries or
they do not arrive, and an author with one of them cannot port it to
WebAssembly on request.

So a plugin may ship a **native module** — an N-API addon, or a Rust/C++
`cdylib` behind an N-API shim — and the editor will call it.

### It runs in a process of its own

One Electron `utilityProcess` per plugin, started on first use, stopped after a
minute of nothing to do, killed and restarted when it hangs or crashes. After
Effects loads plugins into its own address space, and a bad one takes the
application down with the user's unsaved work; that trade made sense for a tool
whose plugins arrive as vendor installers a professional deliberately bought,
and it is the wrong one here.

What follows from the process boundary, and what to design around:

- **A crash costs one process and one frame.** The frame still renders, with
  your effect skipped, and the failure is reported against your plugin by name.
- **Blocking is fine.** `motion_plugin_render` is synchronous; take the whole
  core for the length of the call. The host holds a hard timeout (8 s by
  default) and kills the process when it expires, so do not block on a socket.
- **There is no editor API in your process.** No document, no scene graph, no
  GPU device. You are a function over the bytes you are handed.
- **Three crashes and your module is off for the session**, with a message in
  your plugin's log rather than an afternoon of process launches.

### The ABI

Five exports, and a version checked before any of the others is called:

```c
uint32 motion_plugin_abi_version(void);          /* MOTION_PLUGIN_ABI_VERSION */
object motion_plugin_register(object hostInfo);  /* once per process */
object motion_plugin_describe(void);             /* what this addon implements */
object motion_plugin_render(object request);     /* the work — synchronous */
void   motion_plugin_dispose(void);              /* normal shutdown only */
```

`motion_plugin_abi_version` returns `major * 1000 + minor`. The host refuses a
different MAJOR and a NEWER MINOR, naming both versions — it never calls into a
binary whose contract it does not agree about, because calling a function whose
stack frame the host disagrees about is not a wrong answer, it is a crash.

`motion_plugin_render` dispatches on `request.call`:

| `call` | What you get | What you return |
|---|---|---|
| `"effect"` | `input` and `output` buffers, `params`, `host` (the same values a CPU kernel's `host` carries), optional `neighbours` | the `output` you wrote, or `{ ok: true, identity: true }` |
| `"generate"` | one generator frame's request — `layerTime`, `frame`, `params`, `seed`, `state` | `instances`, `count`, `primitive`, optional `state` |
| `"invoke"` | `{ method, payload, buffers? }` | `{ ok: true, result }` |

Answer only what you list in `describe().calls`; the host refuses the rest
before they reach you. `describe()` also declares `pixelFormat` — premultiplied
32-bit float RGBA by default, which is what the GPU path and the CPU kernels
both work in, so a native fast path and its shader twin are the same arithmetic
— and `threadSafety`, the same three words (`unsafe`, `instance`, `full`) the
CPU kernels declare, governing whether the host may have two calls in flight.

The contract ships as `packages/plugin-native-sdk`: a C header, the same thing
as TypeScript types, a working example addon with `binding.gyp` and
`CMakeLists.txt`, and build instructions. Build against **Electron**, not
against Node, and build Node-API — N-API insulates you from V8's version, a
Nan/V8 addon does not.

### The manifest block

```jsonc
"native": {
  "abi": 1,
  "platforms": {
    "win32-x64":    "bin/win32-x64/fx.node",
    "darwin-arm64": "bin/darwin-arm64/fx.node",
    "linux-x64":    "bin/linux-x64/fx.node"
  },
  "hashes": { "bin/win32-x64/fx.node": "<sha256, written by the packer>" },
  "threadSafety": "full",
  "timeoutMs": 4000,
  "idleTimeoutMs": 60000
}
```

The host picks by `process.platform`-`process.arch` and does nothing cleverer:
no x64-on-arm64 fallback, because an x64 binary does not run under Rosetta in a
utility process and a silent fallback would work on your machine and not your
user's. A package with no entry for the current machine is listed as
**unavailable on this platform** rather than as broken — ship a JavaScript or
WebAssembly fallback (`contributes.effects[].cpu`) and that user still gets the
effect, slowly.

`native` is not `runtime: "native"`. That is the renderer-realm tier, a
different thing with a different failure mode; declaring one never implies the
other, because each has a consent question of its own.

### The trust gate

Native code is unsandboxed, so **both** of these are required, every time:

1. **A valid signature** over the package (`pack-plugin --key`, verified on the
   user's machine over the exact bytes). An unsigned package loads only from a
   folder, with Developer Mode on.
2. **A separate consent step**, worded for what it is. It names the binary by
   path and hash, and says the sentence: this runs outside the plugin sandbox
   with your full user privileges, and the permission list does not limit it.

Consent is **pinned to the binary's SHA-256**. Version numbers are written by
the author; a hash is written by the bytes, so pinning it means "you agreed to
THIS code" survives a swap that keeps the version string. A rebuilt binary
re-asks. A version bump that ships the identical binary does not — prompting
for that trains people to click through the prompt that matters.

A revocation kills the process and destroys the consent record. The main process
re-hashes the file before every load and refuses a mismatch, refuses any path
outside a plugins folder or the app's staging directory, and refuses a
package-relative path that resolves outside its own package.

### Packing

```sh
node scripts/pack-plugin.mjs ./my-plugin --native --key ./plugin-key.json
```

`--native` is required: without it a compiled file is refused with a sentence
saying so, which is what keeps a package from containing a program by accident.
With it, the binaries named in `native.platforms` are packaged and a SHA-256 for
each is written into the manifest — inside the package, so the signature covers
them, which lets the editor say "this binary is not the one the package was
built with" instead of merely "the hash changed".

During development, an unpacked folder works as it does for every other tier:
edit, rebuild the addon, reload the plugin. A reload terminates the process and
starts a new one — a native module cannot be unloaded from a process, because
the OS keeps the library mapped — and the rebuilt binary's new hash asks for
consent again, which is one click per build rather than a restart.

An archive is different in one way: a file inside a zip cannot be loaded, so the
binary for this machine is written to `<userData>/PluginNative/<id>/<sha256>/`
first. The hash names the directory, so identical bytes stage once and a rebuilt
binary lands somewhere new rather than overwriting a file the OS may still have
mapped.

### Scheduling, and the budget

Native calls go through a scheduler with the same lane rule as the CPU kernels:
`unsafe` serialises everything for the plugin, `instance` serialises per effect
instance, `full` runs concurrently. During preview it is **latest-wins** — a
call the playhead has moved past resolves as "did not happen" and your layer
renders unchanged. During export nothing is dropped, every frame is awaited, and
a call that does not land in time makes the export refuse the frame rather than
write it with the previous frame's pixels.

There is also a budget: a preview call over ~24 ms benches the plugin for two
seconds, so the playhead keeps moving and the effect falls back to its
JavaScript path. Export ignores it — a plugin too slow for a viewport is not too
slow for a file.

### Buffers

Pixel buffers are **handed over**, not copied: the main process transfers them
into your process, and your answer transfers them back. A buffer you have
answered with is no longer yours, and keeping a reference to one reads memory
that belongs to another process. On the editor's side the same rule is enforced
— a buffer read after it was handed to a plugin throws a named error rather than
silently rendering a black frame.

One copy remains and cannot be removed: `ipcRenderer.invoke` structure-clones,
so the renderer-to-main hop is a copy. `SharedArrayBuffer` would remove it and
is deliberately not the default — shared memory has no ownership at all, and the
torn frame that results from a plugin writing while the compositor reads is not
reproducible.

### Pixel precision — what each tier actually carries

Worth stating plainly, because the format names invite the wrong conclusion.

**Your GPU effect already runs at half-float.** The renderer's compositing
targets are `rgba16float` throughout, so a WGSL or GLSL pass reads and writes
at that precision with nothing to ask for. If your effect needs the bits, ship
a shader.

**Your CPU kernel and your native addon are 8-bit at source.** Every route
into them starts at Canvas2D's `getImageData`, which has no wider form.
`pixelFormat: "f32-premul"` is therefore a *container*, not a promise: you get
8-bit data widened to float, and the conversion happens once in your own
process instead of inside your inner loop. That is a real benefit and it is
not more bits.

So the CPU kernel is the **twin** that keeps your effect working when a layer
is baked — a mask-scoped effect beside it, fill opacity, a path-following
style — rather than the place to do high-precision work. An effect that needs
precision ships a shader and uses the kernel as its fallback.

### Sequence data — what your effect remembers between frames

A native effect call used to be stateless. Every frame handed you pixels,
params and a time, and threw away everything you worked out. For a colour grade
that is correct and free. For the plugins this tier exists to host it is the
whole cost: an optical-flow retimer re-derives the flow field, a denoiser
re-builds its noise model, a raytracer re-builds its BVH — once per frame, for
a value that did not change.

After Effects calls this `sequence_data`, and essentially every serious AE
plugin is built on it, because it is what lets a plugin be expensive **once**.

**The round trip.** `request.state` is whatever you returned as `state` from
this instance's previous frame:

```c
/* frame 1 */  request.state === undefined   →  answer { ok: true, output, state: myBVH }
/* frame 2 */  request.state === myBVH       →  answer { ok: true, output }
/* frame 3 */  request.state === myBVH       →  answer { ok: true, output }
```

- **Omit `state`** to keep what the host holds. This is the case you want on
  almost every frame. Returning your cache again each frame is also correct and
  costs a structured clone of the whole thing per frame — which is exactly the
  cost the field exists to avoid.
- **Return `null`** to clear it.

**It is a cache, and the host may drop it at any moment.** `state` is absent on
the first frame, after a param you named in `invalidateOn` changes, when the
host is over its ceiling and yours was the least recently used, and after
anything that restarts your process — an unload, a reload, a crash, a
revocation. An addon that cannot rebuild from nothing will fail on somebody's
second frame.

**Nothing here is saved.** AE flattens sequence data into the project, which is
why AE plugins implement flatten/unflatten and why a corrupt one breaks the
project rather than the render. What the user authored belongs in params —
typed, validated, animatable, saved. What you *derived* from those params
belongs in `state`, where losing it costs a recompute and nothing else.

**Saying what invalidates it.** By default nothing does, and that is the right
default rather than the lazy one: the expensive caches this exists for depend
on the SOURCE, not on the controls, and rebuilding a flow field because a
slider moved is the cost you came here to remove. If your cache *does* depend
on a control, name it:

```json
{
  "id": "retime",
  "label": "Optical Retime",
  "params": {
    "speed":   { "type": "number", "default": 50 },
    "quality": { "type": "number", "default": 2 }
  },
  "invalidateOn": ["quality"]
}
```

Moving `speed` keeps the flow field; moving `quality` throws it away. Names are
checked against the effect's own params at parse, because a typo here is a
cache that silently never invalidates — which surfaces as a wrong frame long
after the manifest was written.

**Ceilings.** 64 instances across all plugins, 64 MB per entry. Go over the
per-entry limit and the host refuses to hold it, tells you so against your
plugin's name in its log, and renders the frame anyway: a refused cache is
slow, never broken.

## 20. Param supervision — reacting to your own controls

An effect's parameters were a one-way street: the user moved them, the shader
read them, and the plugin had no say in between. That is enough for a colour
grade and not enough for an effect with a **preset** — pick "Filmic" and eight
sliders should move to the values that mean Filmic, and dragging one of those
sliders should set the dropdown to "Custom".

After Effects calls this `PF_Cmd_USER_CHANGED_PARAM`. It is also how an effect
keeps itself coherent: a "lock aspect" checkbox that makes height follow width,
a radius that clamps itself against a quality budget, a colour that recomputes
its complement.

**Declare which params you want to hear about**, in the manifest:

```json
{
  "id": "filmic",
  "label": "Filmic Grade",
  "supervises": ["preset"],
  "params": {
    "preset": { "type": "number", "default": 0, "min": 0, "max": 3 },
    "lift":   { "type": "number", "default": 0 },
    "gain":   { "type": "number", "default": 1 }
  }
}
```

**Then answer:**

```js
motion.effects.onParamChanged('filmic', ({ changed, params }) => {
  if (changed !== 'preset') return null;
  return PRESETS[params.preset] ?? null;   // { lift, gain }
});
```

Return an object of params to write, or `null` to change nothing.

### The rules, and why each one is there

**It is opt-in, per param.** An effect that names nothing in `supervises` costs
exactly what it always did: no round trip, no timer, nothing. Names are checked
against your own params at parse — a name matching nothing is a callback that
never fires, and nothing on screen would say so.

**You are called once per gesture, not once per commit.** A slider commits
thirty times a second; supervising each one would put a worker round trip
inside a drag loop. The call is trailing-debounced per (layer, effect), so a
drag fires one supervision carrying the value it **ended** on.

**You cannot loop.** The params you write back are applied with supervision
suppressed for that instance, so normalising a value you also supervise is safe
rather than an infinite exchange.

**Your answer is filtered.** Keys the effect does not declare are dropped, and
values that did not actually move are ignored — a reply is plugin output
arriving through a channel the user did not initiate, and writing what is
already there would manufacture an undo step out of "no change".

**Taking too long costs the user nothing.** Past 1.5 s the host gives up on
that edit. The user's own change already landed, so nothing is lost but your
adjustment.

**Your answer is its own undo entry**, labelled after your effect — "Filmic
Grade adjusted Lift and Gain". AE folds the supervised change into the user's
edit because its plugins are in-process and answer synchronously; ours answer
across a boundary, and awaiting that inside the user's edit would mean a
dropdown that hangs for as long as a plugin feels like taking. Two undos rather
than one, and the history says what happened.

**A stopped plugin does not supervise.** The trigger is a slider, not something
the user named by hand, so it never wakes a worker — the same rule generator
layers follow.

## 21. Audio effects (API 8)

A plugin can process **sound**, not just pixels.

```json
{
  "id": "air",
  "label": "Air",
  "category": "Filters",
  "params": [
    { "key": "amount", "label": "Amount", "unit": "dB", "min": 0, "max": 12, "default": 3 }
  ],
  "chain": [
    { "kind": "biquad", "type": "highshelf", "set": { "frequency": 8000, "gain": { "param": "amount" } } },
    { "kind": "gain", "set": { "gain": 1 } }
  ]
}
```

That is the whole plugin. There is no code to write: the effect appears in the
audio-effect menu, its parameters appear in the inspector, and they keyframe.

### Why it is a declared graph and not a sample callback

After Effects' `PF_Cmd_AUDIO_RENDER` hands a plugin a buffer of samples and
takes one back. Copying that here would break the one rule this app's audio is
built on, and it is worth being exact about which.

`audioEffects.ts` states it: there is **exactly one** function that turns a
list of effects into audio nodes, and both the live `AudioEngine` and the
offline `audioMixdown` call it. The failure that rule prevents is a mix that
sounds right while scrubbing and renders differently — "discoverable only by
exporting and listening, which is the worst possible feedback loop".

A sample callback cannot keep that. Live playback would need an AudioWorklet,
which this codebase has a standing rule against and which the gate and duck
effects already route around by baking to keyframes, while the offline path
could call your plugin directly. That is two implementations of one effect,
and the one that is wrong is the one you only hear after a twenty-minute
export.

So you declare a chain of the same primitives the built-in effects are made
of, and the same builder wires it. Parity is structural rather than something
to test for, and your effect works in preview and in export because it is the
same nodes in both.

**What that costs, honestly:** you cannot write a sample loop. No convolution
reverb from your own impulse response, no spectral denoiser, nothing whose
maths is not expressible as WebAudio nodes. That is a real limit and the
deliberate price of the parity rule. The families it does cover — EQ, filters,
delay, modulation, distortion, stereo work, gain staging — are what most audio
plugins actually are.

### The primitives

`biquad` · `gain` · `delay` · `panner` · `compressor` · `waveshaper`

Every one exists identically on `AudioContext` and `OfflineAudioContext`,
which is what makes the parity a property of the list. A node that behaved
differently between the two would not belong here whatever it could do.

### Settings, and how a parameter animates one

A setting is a fixed number, or `{ "param": "<name>" }` naming one of your
declared parameters. The reference is what makes your effect **animatable**:
the host resolves it through `buildParamRamp`, the same seam level, pan and
fades ride, so a keyframed plugin parameter schedules exactly like a keyframed
built-in one. A bare number costs no ramp at all.

Settings are checked against the node kind. `{ "kind": "gain", "set":
{ "frequency": 800 } }` would typecheck and build and do nothing, so it is
refused — as is a `{ "param": ... }` naming a parameter you did not declare,
which would be a slider the user can move that reaches no node.

### Limits

8 effects per plugin · 8 nodes per chain · 12 params per effect · 5 s of delay
line · 256-point shaper curve.

A delay whose `delayTime` is driven by a parameter reserves against that
parameter's **maximum**, because `DelayNode` takes its ceiling at construction
and cannot grow — otherwise an animated sweep silently stops getting longer.

### When your plugin is not there

A document that uses your audio effect keeps it. Disable or uninstall the
plugin and the signal passes through untouched, with the layer's parameters
intact; re-enable it and the sound comes back. A project must not fall silent
because a plugin was toggled — silence is the one failure nobody notices until
they have exported.
