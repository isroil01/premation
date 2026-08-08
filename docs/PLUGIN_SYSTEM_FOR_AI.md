# Premation — Plugin System: Complete Reference

**Audience:** an AI or engineer with no prior context on this codebase.
**Purpose:** one self-contained file describing what the plugin feature *is*, how
it *works end to end*, what is *actually shipped*, and what is *deliberately not*.
**Verified against code on:** 2026-08-04. Editor `v0.3.0`, host API version `1`.
**Repos:** `motion-editor` (Electron/React/Vite desktop app, product name
**Premation**) and `motion-back` (NestJS + Postgres + Prisma backend).

> Every claim below was read out of the current source, not from changelogs.
> File paths are given so each statement can be re-checked.
> Test status at time of writing: **7 suites / 106 tests green**
> (`npx jest src/core/plugins src/layout/Plugins src/layout/Menu/pluginMenu.test.ts`).

---

## 1. One-paragraph summary

A Premation plugin is a **package** — a `plugin.json` manifest plus a single entry
ES module, delivered as a `.zip`/`.mplugin` archive or a folder. The user installs
it from the Plugins manager. The package is parsed and validated as *data* first;
the permissions it requests are shown on a consent screen **before any code exists
anywhere**. Only after the user accepts is the entry module handed to a dedicated
**Web Worker**, which locks down its own network globals and then imports the code.
From that point the plugin can only *send messages naming API methods*; the host
checks each message against the permissions actually granted and executes it inside
`runDocumentEdit`, so anything a plugin changes is a **single undo entry**. A plugin
that wedges its event loop stops answering a heartbeat and is terminated — the editor
never notices. Installs persist across reloads. A plugin can also ship an HTML
**panel**, rendered in a sandboxed iframe with an opaque origin and no network
of its own (`connect-src 'none'`, even when the plugin holds `net:fetch`),
which can talk *only* to its own plugin's worker. There is a hosted **registry** in
`motion-back` with ECDSA-signed packages and trust-on-first-use publisher keys.

---

## 2. Architecture at a glance

```
  ┌─ USER PICKS a .zip / a folder / a registry entry ────────────────────────┐
  │                                                                          │
  │  readPluginZip / readPluginFolder / fetchRegistryPackage                  │
  │      bytes → files map            (registry: signature verified FIRST)    │
  │                    │  nothing is executed at this stage                   │
  │                    ▼                                                      │
  │  plugin.json ──► parseManifest    strict: reverse-DNS id, semver,         │
  │                    │              apiVersion ≤ host, safe paths,          │
  │                    │              known permissions only                  │
  │                    ▼                                                      │
  │  CONSENT SCREEN — "this plugin will be able to: …"                        │
  │      per-permission checkboxes, all ticked by default, any can be         │
  │      unticked; homepage URL shown in full                                 │
  │                    │  user accepts                                        │
  │                    ▼                                                      │
  │  pluginStore  →  localStorage `motion-editor.plugins`  → survives reload  │
  └────────────────────┬─────────────────────────────────────────────────────┘
                       ▼
        PluginHost.start ──► new Worker(pluginWorker.ts, {type:'module'})
                                 │ lockdown()      fetch/XHR/WS/EventSource/
                                 │                 importScripts/Worker/
                                 │                 indexedDB/caches/
                                 │                 BroadcastChannel/sendBeacon
                                 │                 → throwing stubs
                                 │ await import(blob:  plugin's own module)
                                 │ activate(motion)
                                 ▼
                       postMessage {k:'call', id, method, args}
                                 │
   ┌─────────────────────────────┴──────────────────────────────┐
   │ METHOD_PERMISSIONS[method] — granted?                       │
   │   unknown method → error "Unknown API method"               │
   │   ungranted      → error naming the missing permission,     │
   │                     + a line in the plugin's log            │
   ▼ granted / null (core method)                                │
  hostApi[method](...args)  inside runDocumentEdit ──────────────┘
        ↳ arguments re-validated (untrusted: they crossed postMessage)
        ↳ one undo entry, labelled "<Plugin name>: <what>"
```

Two sandboxes, not one:

| | Plugin **logic** | Plugin **panel (UI)** |
|---|---|---|
| Runs in | dedicated Worker | `<iframe sandbox="allow-scripts">` (no `allow-same-origin`) |
| Can draw | no (no DOM) | yes |
| Can reach editor | only via permission-gated RPC | **never** — only `postMessage` to its own worker |
| Network | none (globals stubbed) | none (`default-src 'none'; connect-src 'none'`) |
| Origin | worker realm, no `localStorage` | opaque (`"null"`) |

---

## 3. Threat model — why it is built this way

The **previous** plugin host evaluated a user-picked `.js` file with `new Function`
**in the page's realm**, with live `defaultSceneGraph` / `defaultAnimation` handles
bound in. That is not "scene access"; it is everything the page can do — and this
page holds two things worth stealing, both in `localStorage`: the **account bearer
JWT** and the **user's own AI provider API keys**.

"The user chose the file" is not a control. Downloading plugins from strangers is
the normal distribution model for creative tools (it is what After Effects users
are conditioned to do), so social engineering is the *expected* attack.

| Failure | Host realm + `new Function` (old) | Worker sandbox (current) |
|---|---|---|
| Plugin loops forever | Editor frozen permanently | Worker terminated in ~12 s, editor untouched |
| Plugin reads the JWT / AI keys | `localStorage.getItem(…)` | No `localStorage` in a worker realm |
| Plugin phones home | `fetch(…)` | `fetch` replaced with a throwing stub before import |
| Plugin reads the UI / forges clicks | Full DOM | No `document`, no `window` |
| Plugin deletes the project | Direct singleton handle | Needs `scene:write`, and it is one Ctrl-Z |
| User reloads | Everything uninstalled | Installs persist and auto-restart |

**Live-verified in the running app** (and again in a *packaged* build over `file://`,
driven via CDP): a plugin's own probe reports
`fetch:DENIED XMLHttpRequest:DENIED WebSocket:DENIED importScripts:DENIED
indexedDB:DENIED localStorage:ABSENT document:ABSENT window:ABSENT`; a `while(true)`
command returns control to the editor immediately and is killed by the heartbeat
while other plugins keep running; an ungranted call is refused *by permission name*.

### The panel CSP trap (historical, fixed — important context)

Panels were originally delivered with `srcdoc`. That quietly made the entire panel
feature decoration: a `srcdoc` document **inherits the embedder's CSP**, the app
ships `script-src 'self'` with no `'unsafe-inline'`, and a panel is by definition
inline script. So panels rendered as static markup, `motionPanel` was never defined,
and not one message ever reached a plugin. No error, no clue. A document's own
`<meta>` policy can only *add* restrictions, so the frame could not opt back in.
The fix: load the panel shell from a **real URL** (`public/plugin-panel.html`) so it
has a policy of its own — one that is *tighter* than the app's for everything except
inline script.

---

## 4. File map

### `motion-editor` (client)

| Concern | File |
|---|---|
| Manifest schema, validation, permission text | `src/core/plugins/manifest.ts` |
| `.zip` / folder reading, size + zip-slip limits | `src/core/plugins/pluginPackage.ts` |
| Wire protocol + method→permission table | `src/core/plugins/protocol.ts` |
| The sandbox, worker side | `src/core/plugins/pluginWorker.ts` |
| Worker construction (ESM-only, stubbed in tests) | `src/core/plugins/spawnPluginWorker.ts` (+ `.stub.ts`) |
| Method implementations, host side | `src/core/plugins/hostApi.ts` |
| Install / supervise / permission gate / panel bridge | `src/core/plugins/PluginHost.ts` |
| Registry client + **signature verification** | `src/core/plugins/registry.ts` |
| Persistence (localStorage) | `src/stores/pluginStore.ts` |
| The plugin list, searchable and paged | `src/layout/Plugins/PluginsList.tsx` |
| A plugin's page: listing, status, log, perms editor, reload | `src/layout/Plugins/PluginDetailTab.tsx` |
| Consent screen | `src/layout/Plugins/ConsentSheet.tsx` |
| Docked panel + sandboxed frame | `src/layout/Plugins/PluginPanel.tsx` |
| Panel host document (its own CSP) | `public/plugin-panel.html` |
| Plugins menu, built from what is installed | `src/layout/Menu/pluginMenu.ts` |
| Menu wiring (dynamic groups) | `src/layout/Menu/useAppMenuGroups.ts` |
| Starter template generator (`.zip` download) | `src/layout/Plugins/starterPlugin.ts` |
| Boot wiring: `pluginHost.configure(...)`, `view.plugins` command | `src/providers/Providers.tsx` (~L1054–1100) |
| Dock panel registration | `src/layout/EditorLayout/panelDefs.ts:94`, `DemoPanels.tsx:1908` |
| Native menubar entry | `electron/main.ts:783` (`Plugins ▸ Manage Plugins…`) |
| Publishing CLI | `scripts/sign-plugin.mjs` |
| Edition gate for the registry | `src/core/config/edition.ts:136` |

**Client tests:** `pluginPackage.test.ts` (format), `pluginHost.test.ts` (lifecycle,
permission gate, argument validation, command namespacing), `pluginBridge.test.ts`
(panel provenance + routing), `registry.test.ts` (signature verify),
`noHostRealmEval.test.ts` (**architectural guard** — no `new Function`/`eval`, no
non-literal dynamic `import()` in host files, lockdown-before-import ordering, no
`allow-same-origin` on the panel iframe), `PluginsModal.test.tsx`, `pluginMenu.test.ts`,
`fakeWorker.testkit.ts` (injected via `PluginHost.setWorkerFactory`).

### `motion-back` (registry)

| Concern | File |
|---|---|
| Endpoints (all behind `JwtAuthGuard`) | `src/plugins/plugins.controller.ts` |
| Publish / browse / download / updates / block | `src/plugins/plugins.service.ts` |
| ECDSA verification, server side | `src/plugins/plugin-signature.ts` (+ `.spec.ts`) |
| Server-side manifest read from uploaded bytes | `src/plugins/plugin-package.ts` |
| DTOs / validation caps | `src/plugins/dto/plugin.dto.ts` |
| Module registration | `src/plugins/plugins.module.ts`, `src/app.module.ts:52` |
| Data model | `prisma/schema.prisma` (`model Plugin`, `model PluginVersion`) |
| Migration (additive, applied) | `prisma/migrations/20260729120000_add_plugin_registry/` |

---

## 5. Package format

```
my-plugin/
  plugin.json      required, at the package root
  main.js          the entry ES module
  panel.html       optional UI
```

Zipping the folder is fine — **one** wrapping directory is stripped automatically
(only when *every* entry shares the prefix).

```jsonc
{
  "id": "studio.acme.easing-lab",   // reverse-DNS, lowercase, unique, stable
  "name": "Easing Lab",             // 1–80 chars
  "version": "1.2.0",               // semver (prerelease suffix allowed)
  "description": "…",               // 1–400 chars — this is what the user reads
  "author": "Acme Studio",          // optional, ≤80
  "homepage": "https://…",          // optional, http(s) only, ≤300, shown at install
  "apiVersion": 1,                  // refused if newer than HOST_API_VERSION (=1)
  "main": "main.js",                // package-relative, no `..`, no absolute/drive paths
  "panel": "panel.html",            // optional
  "permissions": ["scene:read", "animation:write"]
}
```

**Limits** (`pluginPackage.ts`): 2 MB per file, 8 MB per package, 200 files, text
extensions only (`.js .mjs .json .html .htm .css .svg .txt .md`). Paths containing
`..` are refused at the format level (zip-slip). `__MACOSX` and `.DS_Store` dropped.
Zip detection is by **magic bytes (`PK`)**, not the filename. Total persisted size
across all plugins is capped at 12 MB (`pluginStore.ts`).

`main` is loaded as **one file** — bundle your plugin if it has dependencies.

---

## 6. Permissions

Defined in `manifest.ts`; the method→permission mapping is `METHOD_PERMISSIONS` in
`protocol.ts`. Nothing outside this list is grantable.

| Permission | The plugin can | Methods it unlocks |
|---|---|---|
| `scene:read` | See layer names, structure and scalar properties | `scene.getSelection`, `scene.setSelection`, `scene.getLayers`, `scene.getLayer` |
| `scene:write` | Create, change and delete layers | `scene.createLayer`, `scene.setProperty`, `scene.renameLayer`, `scene.deleteLayer` |
| `animation:read` | Read keyframes and sample animated values | `animation.getTracks`, `animation.sample` |
| `animation:write` | Create and change keyframes and expressions | `animation.setKeyframe`, `setKeyframes`, `removeKeyframe`, `setExpression` |
| `timeline` | Read the current time and move the playhead | `timeline.getTime`, `timeline.setTime` |

**Needs no permission** (`null` in the table): `ui.notify`, `ui.openPanel`,
`ui.closePanel`, `commands.register`, `composition.get` — they neither read project
data nor change it, so gating them would only add a dialog with nothing behind it.

**Consent is per-permission**, not one yes over the list. The install screen ticks
everything the manifest asks for; the user may untick any of it. They can change
their mind later via **Plugins ▸ Manage Plugins… ▸ Permissions** on the row, which
restarts the plugin (the worker was told what it had at boot). A grant is **always
intersected with the manifest** (`PluginHost.install` and `setGranted`), so a UI bug
can only ever grant *less* than was disclosed, never more.

A refused call returns an error **naming the missing permission** rather than
silently doing nothing, and is written to the plugin's log — so a plugin can degrade
deliberately with `motion.has('scene:write')`.

---

## 7. The plugin-facing API (`motion`)

The entry module exports `activate`. `export default { activate }` and
`export default function (motion)` also work.

```js
export function activate(motion) {
  motion.commands.register(
    { id: 'bounce', label: 'Bounce selection', icon: 'zap', needsSelection: true },
    async ({ selection }) => {
      const t = await motion.timeline.getTime();
      for (const id of selection) {
        await motion.animation.setKeyframes(id, 'y', [
          { t,          value: 0,   easing: 'easeOut' },
          { t: t + 0.18, value: -60, easing: 'easeIn'  },
          { t: t + 0.42, value: 0,   easing: 'easeOut' },
        ]);
      }
      await motion.ui.notify(`Bounced ${selection.length} layer(s)`, 'success');
    },
  );
}
```

**Every `motion.*` call returns a promise** — it is a message to the editor, not a
function call into it.

```js
motion.manifest                            // your own manifest
motion.permissions / motion.has(p)         // what the user ACTUALLY granted

motion.ui.notify(message, level)           // 'info' | 'success' | 'warning' | 'error'
motion.ui.openPanel() / closePanel()       // errors if manifest declares no "panel"
motion.ui.sendToPanel(data)
motion.ui.onPanelMessage(fn)

motion.commands.register(spec, handler)    // spec: { id, label, icon?, needsSelection? }
motion.composition.get()                   // { name, width, height, fps, durationSeconds }

motion.scene.getSelection() / setSelection(ids)
motion.scene.getLayers()                   // flat, depth-first walk of all roots
motion.scene.getLayer(id)                  // { id, name, kind, parent, visible, locked, children, props }
motion.scene.createLayer({ kind, name?, x?, y? })   // kind: shape | text | group | null
motion.scene.setProperty(id, prop, value)  // number | string | boolean only
motion.scene.renameLayer(id, name) / deleteLayer(id)

motion.animation.getTracks(id)             // [{ prop, keyframes: [{t, value, easing}] }]
motion.animation.sample(id, prop, time)
motion.animation.setKeyframe(id, prop, time, value, easing?)
motion.animation.setKeyframes(id, prop, [{ t, value, easing? }])   // PREFER THIS
motion.animation.removeKeyframe(id, prop, time)
motion.animation.setExpression(id, prop, source)

motion.timeline.getTime() / setTime(seconds)
```

**Host-side guarantees** (`hostApi.ts`):

- **Arguments are untrusted** and re-validated on the host — they crossed a
  `postMessage` boundary from third-party code. Strings 1–500 chars; numbers must be
  finite; unknown layer ids fail by name; property values restricted to scalars;
  max **5000 keyframes per call**.
- **Writes are undoable as ONE entry**, via `runDocumentEdit("<Plugin name>: <what>")`.
- **Toasts are always prefixed with the plugin's name** — an unprefixed toast that
  looks like the editor talking is a phishing surface.
- **`createLayer` is limited to primitives** (`shape`, `text`, `group`, `null`) — a
  plugin has no business minting a camera or a comp root.
- **`deleteLayer` refuses a composition root.**
- **Only JSON-safe scalars cross the boundary** in `layerView` — geometry arrays and
  nested config would balloon the message and mean nothing without the types.
- **Prefer `setKeyframes`** over a loop of `setKeyframe`: bulk sorts once and notifies
  once; a keyframe at a time is quadratic and is what used to freeze the app.

### Panels

`panel.html` is plain HTML, run in the sandboxed frame with exactly two globals:

```js
motionPanel.send(data);        // → your plugin's onPanelMessage
motionPanel.onMessage(fn);     // ← your plugin's sendToPanel
```

Panel routing is by **frame registration**, never by the message body
(`PluginHost.registerFrame` + `claimFrame`). A message is accepted only if it came
from a frame the host created, still registered, on the origin it was registered with
(`"null"` — opaque). A panel therefore **cannot name an API method, a layer, or
another plugin**. The shell's own lifecycle messages (`__panelHtml`, `__panelReady`)
are filtered out so they never reach a plugin's listener.

The panel shell's CSP: `default-src 'none'; script-src 'unsafe-inline';
style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src 'none';
object-src 'none'; base-uri 'none'; form-action 'none'`. Verified live: a panel's
`fetch` fails and a remote `<img>` is refused.

Panels appear as the **Plugins** panel in the right-hand dock (`panelDefs.ts` id
`plugins`, region `rightInspector`, `onDemand: true`), so they tab alongside Effects
and Graph and can be floated or popped out. Several plugins with panels share it as
tabs (tab strip only renders with more than one).

---

## 8. Where a plugin shows up in the UI

| Contribution | Where the user finds it |
|---|---|
| `commands.register(...)` | The **Plugins** menu, under the plugin's name, and the Command Palette (⌘⇧P) as `"<Plugin name>: <label>"` |
| `panel` in the manifest | The **Plugins** dock panel + a free `plugin.<id>.panel` command ("Open Panel") |
| `ui.notify(...)` | A toast, always prefixed with the plugin's name |
| The package itself | **Plugins ▸ Manage Plugins…** — status, permissions, log, enable/disable, uninstall |

Command ids are namespaced `plugin.<pluginId>.<specId>` — two vendors may both ship
`apply`, and the command registry is a flat id space.

The free panel command is deliberately **kept out of `info.commands`**, so the
manager's "3 commands" count reports what the plugin actually contributed.

The **Plugins menu is built dynamically** from what is installed (`pluginMenu.ts` →
`useAppMenuGroups`) — every other menu group is a static list, because every other
group ships with the app. A plugin that is installed but **not running still appears,
disabled, labelled with why** (`(disabled)` / `(stopped — see Manage Plugins…)`). A
running plugin contributing nothing shows as `(no commands)`. Nothing an installed
plugin does is invisible.

---

## 9. Lifecycle and supervision (`PluginHost.ts`)

| Concern | Behaviour |
|---|---|
| Boot | `configure()` at app boot starts every **enabled** plugin from `localStorage` |
| Boot timeout | **8 s** to reach `activate`, then stopped with a reason |
| Heartbeat | `ping` every **4 s**; **2** unanswered ⇒ terminated as "stopped responding" |
| Crash | Surfaced as a toast (prefixed) **and** in the manager row, with a **Restart** button; the error survives the runtime being gone |
| Log | Per-plugin ring buffer, **200 lines**, kept **after** the plugin dies (that is when it gets read), dropped on uninstall. Carries the plugin's forwarded `console.*`, every refused call, and the crash |
| Enable / disable | Distinct from uninstall: disabling terminates the worker and unregisters its commands but keeps the package |
| Panel lifetime | **A panel never outlives its worker** — stopping a plugin (disabled, crashed, uninstalled) closes its panel |
| Permission change | `setGranted` → intersect with manifest → restart |
| Reactivity | `subscribe()` / `getRevision()` for `useSyncExternalStore` |

**Status values:** `stopped | starting | running | error`. The manager distinguishes
"Disabled" (user turned it off) from "Not running" (enabled but no runtime) —
showing "Disabled" next to a toggle reading "Enabled" is a contradiction the user
cannot resolve.

### Boot-order trap (documented, worked around)

The editor shell registers dock panels in a mount effect **and closes on-demand ones
right after**, while plugins start from `configure()`. A plugin calling
`motion.ui.openPanel()` inside `activate()` loses both races. `showPluginPanel` therefore
**polls** (100 ms × 40) instead of calling `openPanel` once. Also, `useResponsiveLayout`
collapses `rightInspector` under 1024 px on mount — verify panel behaviour at ≥1280 px
or the panel opens into a collapsed region and looks broken.

---

## 10. Persistence

`src/stores/pluginStore.ts`, zustand + `localStorage` key **`motion-editor.plugins`**.

Stores the package **source**, not a running instance: starting a plugin is the host's
job and happens fresh each session, so a plugin that wedges the app cannot wedge it
permanently — disable it and reload.

`InstalledPlugin` = `{ manifest, files, granted, enabled, installedAt, updatedAt,
source?, publisherKey? }` where:

- `source: 'folder' | 'file' | 'registry'` — only used to decide whether to offer **Reload**.
- `publisherKey` — the **pin** for registry updates. Carried forward across updates
  (losing it on reinstall would silently downgrade every later update to unverified).
- Records are **shape-checked on read**: this survived a reload, an app upgrade, and
  possibly a hand-edited `localStorage`; a malformed record is dropped, not handed
  to the sandbox loader.
- Save failure (quota / private mode) is reported to the user, not swallowed.

> ⚠️ **Naming boundary:** the `motion-editor.*` localStorage keys must never be
> renamed even though the product is called Premation — renaming orphans every
> existing user's installs.

---

## 11. Authoring workflow

1. **Plugins ▸ Manage Plugins… ▸ Download starter template** — generates a complete,
   working `.zip` on the fly (`starterPlugin.ts`; id `com.example.hello-motion`,
   permissions `scene:read`, `animation:write`, `timeline`). It exercises every part
   of the API once: a command, a permission-gated write, and a panel that talks back.
   Nothing is installed by this — the manager's list stays empty until the user
   installs something themselves.
2. Unzip, edit `main.js` / `panel.html`.
3. Install with **Choose folder…** (or drop a `.zip`, or **Choose package…**).
4. Iterate with the row's **Reload**: re-reads the folder and reinstalls **with no
   consent screen** unless the manifest now asks for something new (or the id changed,
   or it no longer parses). The picker still opens — a browser cannot re-read a
   directory without a gesture, and a stored `FileSystemHandle` needs its permission
   re-granted after a restart anyway. What Reload removes is the consent screen on
   every single edit.
5. Debug via the row's **Log** — the plugin's `console.*` is forwarded from the worker
   (a user of the packaged app has no DevTools).

**Dev-only noise:** Vite injects its HMR client into module workers, so `[vite] connected.`
appears in a plugin's log under `npm run dev`. Not present in the packaged build.

---

## 12. The registry (`motion-back`)

### Endpoints — all behind `JwtAuthGuard`, including browse

An unauthenticated browse endpoint would be a free enumeration of every package and
its permission list, plus an unmetered download path.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/plugins?q=&limit=&offset=` | Browse (excludes blocked). `limit` clamped 1–100, default 30 |
| `GET` | `/plugins/mine` | What the signed-in user has published, blocked included |
| `POST` | `/plugins/updates` | Batch update check. Body: `{ installed: [{id, version}] }`, capped at **200** |
| `GET` | `/plugins/:id` | Detail summary |
| `GET` | `/plugins/:id/versions/:version/download` | Bytes (base64) + signature + publisher key + sha256; increments `installs` |
| `POST` | `/plugins` | Publish (multipart `file` + `signature` + `publicKey`) |
| `DELETE` | `/plugins/:id` | Unpublish (owner only) |
| `POST` | `/plugins/:id/block` | Operator takedown — `RolesGuard` + `@Roles(admin)` |

`POST /plugins/updates` is a POST *because* it carries the caller's installed set,
which is a list rather than a cache key — and that list is data about the user that
has no business sitting in a URL or a proxy log.

### Crypto — exact parameters (both sides must agree)

- **ECDSA P-256, SHA-256.** Not Ed25519 (the better primitive) because the editor
  verifies with **WebCrypto**, where P-256 has been present for a decade and Ed25519
  is a compatibility gamble on whatever Chromium a build happens to ship.
- **Signature over the RAW PACKAGE BYTES**, nothing else — not the manifest, not a
  client-reported hash. Signing anything *derived* would put the derivation inside
  the trust boundary.
- **Signature encoding: IEEE P1363 (`r||s`, exactly 64 bytes), base64.** WebCrypto
  produces/consumes exactly this; **Node defaults to DER** for ECDSA and must be told
  `dsaEncoding: 'ieee-p1363'`. Getting this wrong yields a verifier that rejects every
  valid signature and reads as "the publisher's key is wrong".
  A spec signs with Node and verifies with WebCrypto specifically to pin that seam.
- **Public key as SPKI, base64.**
- Malformed key/signature ⇒ **`false`, not a throw** — from the caller's point of view
  it is the same answer, and an exception would be a 500 on a stranger-controlled request.

### Trust on first use (TOFU)

`Plugin.publisherKey` is recorded on the **first** publish of an id. Every later
version must carry a signature verifying against that same key **and** come from the
same owner — two checks catching different things: the owner check stops someone else
claiming the id; the key check stops the owner's own account, *if stolen*, shipping an
update signed with a key the original publisher never had.

**The client pins the key.** For an update, the editor verifies against the key stored
with the **installed copy** (`InstalledPlugin.publisherKey`), never the one the
response carries — a server that can hand over both the package and the key it should
be checked with is a server that can hand over anything. Verification happens on the
user's machine, before the bytes reach the zip reader.

| Attack | Result |
|---|---|
| Package modified in transit or on a CDN | Fails verification locally, not installed |
| Someone else publishes under your plugin id | Refused — id owned by the first publisher (403) |
| Your registry account is stolen | Refused — the thief has no signing key (403) |
| Registry compromised, serves a new key | Refused on update — the client pins the stored key |
| A publisher ships something malicious under their own key | **Not covered.** Signing says *who*, never whether they meant well — which is why the permission screen still exists |

### Other registry invariants

- **Published versions are immutable.** Re-publishing an existing version is refused —
  two different byte sets claiming to be `1.2.0` would make the signature guarantee
  unusable. Enforced by a unique index on `(pluginId, version)`.
- **Metadata is read server-side from the uploaded bytes**, never from form fields
  (`plugin-package.ts`) — a publisher must not be able to advertise fewer permissions
  than the package declares. The server's validator is deliberately *duplicated* from
  the editor's (different processes, neither can call the other) and refuses anything
  the editor would refuse.
- **Signature is checked BEFORE the package is parsed**, and parsed before anything is
  written — unsigned bytes never reach the zip reader, the only component processing
  attacker-controlled structure.
- **`latestVersion` only moves forward** (numeric semver compare — `'1.10.0' > '1.9.0'`
  is false as strings, which is exactly the bug that silently stops updates after the
  tenth patch). A release outranks a prerelease of the same version.
- **Package bytes live in Postgres `Bytes`**, deliberately not object storage: the
  client verifies a signature over the exact bytes, and every re-encoding hop (a CDN
  normalising a "raw" upload, a storage-driver switch) would surface to the user as
  "this plugin is compromised".
- **A blocked plugin is hidden from browse and refused for download, but NOT deleted.**
  Installed copies keep working — breaking someone's project is usually a bigger harm
  than the one a takedown addresses. The withdrawal *is* reported to anyone running it.

### Install / update flow in the editor

- A **registry install is not a shortcut past the permission screen**: verified →
  parsed by the same package reader a local file goes through → the same consent screen.
- **Update checks fire only when the manager is opened** — never on a timer, never in
  the background. This is the editor asking the registry, not a plugin reaching
  anywhere — a plugin's own path is `motion.net.fetch`. This is the
  *editor* asking, on the screen where the answer is the point. **Failure is silent**
  so working offline does not produce errors.
- An update asking for **more permissions than were granted** goes back through consent.
- An update for a plugin installed from a **local file** is refused with an explanation:
  there is no pinned key to check it against.

### Publishing CLI (`scripts/sign-plugin.mjs`)

```bash
node scripts/sign-plugin.mjs keygen --out ./my-plugin.key.json
node scripts/sign-plugin.mjs sign my-plugin.zip --key ./my-plugin.key.json
node scripts/sign-plugin.mjs publish my-plugin.zip --key ./my-plugin.key.json \
     --token <access token> [--api http://localhost:4000/api]
```

The private key never leaves the machine — `publish` sends the package, the signature
and the **public** key. **Keep the key file:** it is the only thing that can ship an
update; losing it means republishing under a new id, which is the cost of the guarantee
rather than an oversight.

---

## 13. Current state — what is shipped and verified

**Status: shipped and production-grade.** Editor v0.3.0, host API v1.

✅ Package format (`.zip` / `.mplugin` / folder), strict manifest validation, size and
zip-slip limits
✅ Worker sandbox with lockdown-before-import; live-verified denials in dev **and in a
packaged build over `file://`**
✅ Per-permission consent at install, and a Permissions editor afterwards
✅ Permission gate on every RPC, refusals named and logged
✅ All writes undoable as one entry, arguments re-validated host-side
✅ Persistence across reloads + auto-restart of enabled plugins
✅ Supervision: 8 s boot timeout, 4 s heartbeat / 2 missed, restart button, 200-line log
✅ Commands in the Plugins menu (dynamic) and the Command Palette, namespaced
✅ Sandboxed panels in the right-hand dock, tabbed, with their own tight CSP
✅ Manager UI: install (drop / file / folder), Browse, enable/disable, uninstall, Log,
Permissions, Reload, Open Panel, update badge
✅ Starter template download
✅ Registry in `motion-back`: publish / browse / download / update-check / unpublish /
operator block, ECDSA P-256 signatures, TOFU publisher keys, immutable versions
✅ `sign-plugin.mjs` CLI
✅ Architectural guard test (`noHostRealmEval.test.ts`) that fails if anyone reintroduces
host-realm evaluation or `allow-same-origin`
✅ Native Electron menubar entry

**Verified end to end** (both a dev run and a packaged `electron:build` driven over CDP):
persisted install auto-started; plugin opened its own panel; a click *inside* the
sandboxed panel round-tripped to the worker and back with the full sandbox probe; menu
items ran; `needsSelection` greyed out correctly; disabling tore the panel and tab down;
a forged message from an unregistered window was dropped; registry publish → browse →
install (key pinned) → downgrade → reopen manager → update badge → update to 1.1.0;
tampered download failed WebCrypto verify; non-admin block → 403; unauthenticated
browse → 401; owner unpublish worked.

### Edition gating (important, current)

`pluginRegistryEnabled() === isServerEdition()` (`src/core/config/edition.ts:136`).

- **Server/cloud edition:** the full feature, registry included.
- **Local / self-host edition (`VITE_EDITION=local`):** the registry is **off**.
  `browseRegistry()` returns `[]` and `checkForUpdates()` returns `[]`;
  `fetchRegistryPackage()` refuses on its own rather than trusting callers to have been
  gated. **Installing from a local file or folder is unaffected** — that path never
  touched the network.

---

## 14. Known rough edges / honest gaps

These are real, current, and small. Listed so nobody rediscovers them as bugs.

1. **The Browse tab is still visible in the local edition** and renders
   *"Nothing published yet."* rather than *"not available in this edition"* —
   `browseRegistry()` returns an empty list and the empty-state copy cannot tell the
   two situations apart (`PluginsModal.tsx:341-344`).
2. **Stale doc comment:** `PluginPanel.tsx`'s header still says the markup is delivered
   by `srcdoc`. The code loads `plugin-panel.html` from a URL and posts the markup in
   after load — the srcdoc approach is exactly what was removed (§3). The comment
   inside `PANEL_SHELL_URL` and the HTML file itself are correct.
3. **`GET /plugins/mine` and `POST /plugins/:id/block` have no client UI** — publisher
   shelf and operator takedown are API/CLI-only today. No plugin surface exists in
   `motion-landing`'s admin either.
4. **React `act()` warnings** in `PluginsModal.test.tsx` from the mount-time update
   check. Tests pass; the warning is noise.
5. **Packages are stored in `localStorage`** (12 MB total cap). Fine for source-code-sized
   plugins; it is not an asset store.
6. **Plugins are global, not per-project.** A document referencing a plugin does not
   exist (see §15) — a plugin's output is ordinary keyframes.

---

## 14b. Documents DO reference plugins (API 3)

**This replaces a guarantee that used to be listed under "out of scope", and the
old wording is still worth reading: *"A plugin's output is ordinary keyframes, so
a project opens identically with the plugin uninstalled."* That was true and it
was load-bearing. API 3 ends it: a project containing a
`studio.acme.lab.depthImage` layer names a plugin, and there is no way to give
plugins first-class layer types without that.**

The guarantee is replaced rather than dropped. What follows is the full
contract.

### What a document stores for a custom layer

One component whose TYPE carries the namespace, on an otherwise ordinary node:

```jsonc
{ "type": "pluginLayer:studio.acme.lab.depthImage",
  "props": {
    "__kind": "studio.acme.lab.depthImage",
    "__pluginId": "studio.acme.lab",
    "__kindId": "depthImage",
    "__schemaVersion": 1,
    "focal": 72, "mode": "displace", "source": "asset-3"   // declared props
  } }
```

Declared properties sit directly on that component under their own names,
because that is what makes them **ordinary properties**: `writeProp` addresses
`(nodeId, componentId, propName)` and the animation engine keys on the same
triple, so the timeline and the graph editor need no special case for them. If
they ever do, the props are modelled wrong.

Namespacing by component TYPE rather than by a prop-name prefix is what stops
two plugins that both declare `focal` from colliding, with no name mangling.

Animation tracks use a separate, FIXED prefix: `plugin.focal`. Tracks are keyed
by a concatenated `(nodeId, propPath)` string, and a plugin is free to declare a
prop called `opacity` — unprefixed, animating it would have addressed the
layer's native opacity and silently faded the layer out. The prefix is fixed
rather than per-plugin because a stored track key must not depend on which
plugin is installed. `plugin.` is reserved: no native property may begin with
it, enforced by `reservedPropPrefix.test.ts` and refused at
`scene.setProperty`.

The document also carries a top-level list of the plugins it references:

```jsonc
"plugins": [ { "id": "studio.acme.lab", "version": "1.2.0",
               "publisher": "Acme Studio", "kinds": ["depthImage"] } ]
```

Derived from the document's CONTENTS at capture time, **never** from what
happens to be installed — a project saved on a machine missing the plugin must
still list it, because that is exactly the machine whose user needs to be told.
`version` and `publisher` are absent when the plugin is not installed; the id
alone is enough for `premation://plugin/<id>`.

### When the plugin is absent

1. **The layer is never lost.** Not on uninstall, not on open, not on
   save-and-reopen. Silently discarding a user's work because software is
   missing is the worst outcome available.
2. **It still renders**, if it is `render: "proxy"` — see below.
3. **It is inert and says so**: properties read-only, plugin logic not run, a
   non-blocking banner naming what is missing.
4. **Keyframes survive untouched.** They live on the node's properties like any
   others, so nothing has to preserve them — which is the point.
5. **Reinstalling reactivates it in place**, with the original values.

### What `render: "proxy"` guarantees, and what it does not

A `proxy` kind maintains a subtree of **native** layers as children, and the
host renders those. They are ordinary layers in the document, so:

**Guaranteed without the plugin:** the project opens, the subtree draws, and it
ANIMATES — children reference the parent's animated properties through ordinary
expressions evaluated by the engine, so animation needs no plugin at runtime.

**Not guaranteed:** the authored interface. The custom layer's own properties
are read-only, so changing `focal` does nothing until the plugin is back. The
subtree is a frozen snapshot of the last regeneration.

`render: "none"` has no subtree by definition. It is a controller whose
properties drive other layers, and without its plugin it is an inert gizmo that
still holds its values and its keyframes.

`render: "shader"` is reserved and refused with a version message. It is the one
strategy that could NOT survive its plugin being absent, which is why `proxy`
ships first.

### Schema versions

`schemaVersion` is monotonic and stored per layer.

- **Plugin newer than the document** → the plugin gets one chance to migrate via
  `onMigrateLayer(oldProps, fromVersion)`, run inside `runDocumentEdit` as one
  undo entry. Its return value is validated like any other plugin input.
  Anything that fails validation falls back to that property's DEFAULT — but a
  property the migration did not mention KEEPS its value if it still validates.
  Defaulting an unrelated, still-valid, animated property because a plugin
  author shipped a bad migration is destructive; keeping it is at worst
  occasionally wrong. On any drop, the pre-migration props are QUARANTINED on
  the node under `__preMigration`, so a reset is recoverable rather than merely
  reported. Keyframes are never touched.
- **Plugin OLDER than the document** (a downgrade) → marked **inert, never
  guessed**. The older plugin cannot know what the newer one stored, so running
  it would silently discard whatever the newer schema added.

---

## 15. Deliberately out of scope

- **Render-path (shader / WASM) plugins.** A plugin **cannot draw pixels**. The old
  `registerEffect` claimed to and never did. If this arrives it will be a *separate*
  class with a synchronous, deterministic contract, not an extension of this one.
- **Multi-file entry modules.** `main` is a single ES module; bundle first.
- **Rating, comments, curation.** The registry lists what was published; it does not
  editorialise, and there is no ranking signal beyond install count.
- **Plugin-to-plugin communication.** Each plugin gets its own worker and its own frame;
  there is no shared channel.
- **Background/periodic update checks.** Only when the manager opens, by design.

---

## 16. Extension points — how to add to this system safely

**Adding an API method:**
1. Add the method name → required permission (or `null`) to `METHOD_PERMISSIONS`
   (`protocol.ts`). *A method absent from this table is refused as unknown — this table
   is the gate, not a list.*
2. Implement it in `createHostApi` (`hostApi.ts`): re-validate every argument, and wrap
   any mutation in `edit(...)` so it lands as one undo entry.
3. Expose it on the worker-side `buildApi` (`pluginWorker.ts`) as a thin `call(...)`.
4. Document it in `docs/PLUGINS.md` §5 and add a case to `pluginHost.test.ts`.

**Adding a permission:** add it to `PERMISSIONS` in `manifest.ts` (label + detail — this
text is what the user reads at install) **and** to `KNOWN_PERMISSIONS` in
`motion-back/src/plugins/plugin-package.ts`, or the registry will reject packages the
editor would accept.

**Breaking the plugin API:** bump `HOST_API_VERSION` in `manifest.ts`. Packages with a
higher `apiVersion` are refused with a message telling the user to update the app.

**Never:** reintroduce `new Function`/`eval` or a non-literal dynamic `import()` in host
files, move lockdown after the plugin import, or add `allow-same-origin` to the panel
iframe — `noHostRealmEval.test.ts` fails on all four, and each one collapses the entire
security model.

---

## 17. Canonical docs and cross-references

- `docs/PLUGINS.md` — the authoring-facing guide (architecture + how to write a plugin).
  This file is a superset aimed at machine readers.
- `docs/plugin-audit.md` — HISTORICAL; the audit that produced this rewrite.
- `docs/PREMATION_COMPLETE_REFERENCE.md` — whole-product architecture reference.
- Product name is **Premation**; the repo slug (`motion-editor`) and the
  `motion-editor.*` localStorage keys are load-bearing and must not be renamed.
