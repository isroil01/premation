# Plugins: architecture and authoring guide

**Status:** shipped.

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
panel's `fetch` fails and a remote `<img>` is refused. Panels have no network,
exactly as the worker has none.

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
| Docked panel + sandboxed frame | `src/layout/Plugins/PluginPanel.tsx` |
| Panel host document (its own CSP) | `public/plugin-panel.html` |
| Plugins menu, built from what is installed | `src/layout/Menu/pluginMenu.ts` |
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

Plugins ▸ **Download starter template** produces a working package. Install it
with **Choose folder…**, and from then on iterate with the row's **Reload**:
it re-reads the folder and reinstalls without asking for consent again, unless
the manifest has started asking for something new. (The picker still opens —
a browser cannot re-read a directory without a gesture, and a stored handle
needs its permission re-granted after a restart anyway. What Reload removes is
the consent screen on every edit.)

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

The panel talks to **your plugin only**. It has no access to the editor, and no
access to the network — inline `<script>` runs, `fetch` does not.

It appears as the **Plugins** panel in the right-hand dock, so it tabs alongside
Effects and Graph and can be floated or popped out like any other panel. Several
plugins with panels share it as tabs. `motion.ui.openPanel()` reveals yours; the
user can also reach it from **Plugins ▸ *Your plugin*: Panel** or the manager's
**Open Panel** button.

### Where your plugin shows up

| Contribution | Where the user finds it |
|---|---|
| `commands.register(...)` | The **Plugins** menu, under your plugin's name, and ⌘⇧P |
| `panel` in the manifest | The **Plugins** dock panel + a `Your plugin: Open Panel` command |
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

```bash
node scripts/sign-plugin.mjs keygen --out ./my-plugin.key.json
node scripts/sign-plugin.mjs publish my-plugin.zip --key ./my-plugin.key.json --token <access token>
```

The private key never leaves the machine — publish sends the package, the
signature and the public key. **Keep the key file.** It is the only thing that
can ship an update; losing it means republishing under a new id, which is the
cost of the guarantee rather than an oversight.

Published versions are immutable: re-publishing an existing version is refused,
because two different sets of bytes claiming to be `1.2.0` would make the
signature guarantee unusable.

### Updates

Checked **only when the manager is opened** — never on a timer, never in the
background. Plugins themselves still have no network path at all; this is the
editor asking, on the screen where the answer is the point. A failed check is
silent, so working offline does not produce errors.

An update that asks for **more permissions than were granted** goes back through
the consent screen rather than installing quietly. A plugin withdrawn by an
operator is reported to anyone running it, and their copy keeps working — the
package is blocked, not deleted, because breaking someone's project is usually a
bigger harm than the one a takedown addresses.

## 8. Deliberately out of scope

- **Rating, comments, curation.** The registry lists what was published; it does
  not editorialise, and there is no ranking signal beyond install count.
- **Render-path (shader / WASM) plugins.** A plugin cannot draw pixels. The
  previous `registerEffect` claimed to and never did — see the audit §0A. When
  this arrives it will be a *separate* class with a synchronous, deterministic
  contract, not an extension of this one.
- **Multi-file entry modules.** `main` is a single ES module; bundle first.
- **Documents referencing plugins.** A plugin's output is ordinary keyframes, so
  a project opens identically with the plugin uninstalled.
