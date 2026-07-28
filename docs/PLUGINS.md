# Plugins: architecture and authoring guide

**Status:** shipped. Supersedes the "rebuild from zero" verdict in
[`plugin-audit.md`](./plugin-audit.md) — that audit described the prototype this
replaced, and its §0B inventory is now historical.

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
        │ METHOD_PERMISSIONS[method] granted?     │  no → refused, by name
        ▼                                         │
   hostApi[method](...)  inside runDocumentEdit ──┘   ← one undo entry
```

---

## 1. The threat model, and why it is a Worker

The previous host evaluated a user-picked `.js` file with `new Function` **in
the page's realm**, with live `defaultSceneGraph` / `defaultAnimation` handles
bound in. That is not "scene access"; it is everything the page can do — and
this page holds two things worth stealing: the account bearer JWT and the user's
own AI provider keys, both in `localStorage`.

"The user chose the file" is not a control. Downloading plugins from strangers
is the normal distribution model for creative tools — it is exactly what After
Effects users are conditioned to do — so social engineering is the expected
attack, not an exotic one.

| Failure | Host realm + `new Function` | Worker sandbox |
|---|---|---|
| Plugin loops forever | Editor frozen permanently | Worker terminated in ~12 s, editor untouched |
| Plugin reads the JWT / AI keys | `localStorage.getItem(…)` | No `localStorage` in a worker realm |
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
**without** `allow-same-origin`, delivered by `srcdoc` so the frame never
navigates. Its only exit is `postMessage`, which the host accepts solely from
frames it registered, on the origin it registered them with, and forwards **only
to the worker that owns that frame** — routing comes from the registration, not
from anything the message says. A panel cannot name an API method, a layer, or
another plugin.

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
| Manager UI + consent screen | `src/layout/Plugins/PluginsModal.tsx` |
| Panel host (sandboxed iframe) | `src/layout/Plugins/PluginPanel.tsx` |
| Starter template generator | `src/layout/Plugins/starterPlugin.ts` |

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

```jsonc
{
  "id": "studio.acme.easing-lab",   // reverse-DNS, lowercase, unique
  "name": "Easing Lab",
  "version": "1.2.0",               // semver
  "description": "…",               // shown to the user before install
  "author": "Acme Studio",
  "homepage": "https://…",          // http(s) only
  "apiVersion": 1,                  // refused if newer than the host
  "main": "main.js",
  "panel": "panel.html",            // optional
  "permissions": ["scene:read", "animation:write"]
}
```

Limits: 2 MB per file, 8 MB per package, 200 files, text extensions only. Paths
containing `..` are refused at the format level.

`main` is loaded as **one file** — bundle your plugin if it has dependencies.

---

## 4. Permissions

| Permission | The plugin can |
|---|---|
| `scene:read` | See layer names, structure and scalar properties |
| `scene:write` | Create, change and delete layers |
| `animation:read` | Read keyframes and sample animated values |
| `animation:write` | Create and change keyframes and expressions |
| `timeline` | Read the current time and move the playhead |

Registering commands, showing notifications, opening the plugin's own panel and
reading composition settings need **no permission** — they neither read project
data nor change it.

Ask for the fewest you need: the list is the install screen. A refused call
returns an error naming the missing permission rather than silently doing
nothing, so a plugin can degrade deliberately (`motion.has('scene:write')`).

---

## 5. Writing a plugin

Plugins ▸ **Download starter template** produces a working package. The entry
module exports `activate`:

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

motion.scene.getSelection() / setSelection(ids)
motion.scene.getLayers() / getLayer(id)
motion.scene.createLayer({ kind, name, x, y })   // shape | text | group | null
motion.scene.setProperty(id, prop, value)
motion.scene.renameLayer(id, name) / deleteLayer(id)

motion.animation.getTracks(id) / sample(id, prop, time)
motion.animation.setKeyframe(id, prop, time, value, easing)
motion.animation.setKeyframes(id, prop, [{ t, value, easing }])   // prefer this
motion.animation.removeKeyframe(id, prop, time)
motion.animation.setExpression(id, prop, source)

motion.timeline.getTime() / setTime(seconds)
```

Prefer `setKeyframes` over a loop of `setKeyframe`: the bulk API sorts once and
notifies once. Writing a generated track a keyframe at a time is quadratic and
is what used to freeze the app on imports.

### Panels

`panel.html` is plain HTML, run in the sandboxed frame with two globals:

```js
motionPanel.send(data);        // → your plugin's onPanelMessage
motionPanel.onMessage(fn);     // ← your plugin's sendToPanel
```

The panel talks to **your plugin only**. It has no access to the editor.

---

## 6. Supervision

- **Boot timeout** — 8 s to `activate`, then stopped with a reason.
- **Heartbeat** — a ping every 4 s; two unanswered ⇒ terminated as
  "stopped responding". A wedged plugin cannot wedge the editor because its loop
  is in another thread.
- **Errors are surfaced, not swallowed** — a fatal shows in the manager row with
  a **Restart** button and as a toast prefixed with the plugin's name.
- **Enable / disable** is distinct from uninstall: disabling terminates the
  worker and unregisters its commands but keeps the package.

---

## 7. Deliberately out of scope for v1

- **A registry / marketplace.** No network path, no update check, no signing.
  Distribution is a file, which is honest about what the trust model is.
- **Render-path (shader / WASM) plugins.** A plugin cannot draw pixels. The
  previous `registerEffect` claimed to and never did — see the audit §0A. When
  this arrives it will be a *separate* class with a synchronous, deterministic
  contract, not an extension of this one.
- **Multi-file entry modules.** `main` is a single ES module; bundle first.
- **Documents referencing plugins.** A plugin's output is ordinary keyframes, so
  a project opens identically with the plugin uninstalled.
