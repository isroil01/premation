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
- **`"shader"`** — reserved, refused with a version message. Not a typo on your
  part.

`proxy` ships first because it is the one whose documents survive your plugin
being uninstalled: the children are ordinary layers and keep rendering.

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
2. **No asset picker.** An `asset` prop renders read-only in the inspector; a
   plugin can set it, but a user cannot choose one.
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
