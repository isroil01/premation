# The plugin system, as it stands

A single description of what the plugin platform **is today**, across both
repositories: what it does, how the parts fit, every schema on both sides, and
the exact surface a plugin can reach.

Everything here is implemented and verified **against the source of both
repositories**, not against the other documents — the schemas, the method table
and the manifest interfaces were extracted programmatically, and every constant,
route, gate and guarantee was re-read in the file that implements it. Nothing
here is carried over from a description of the system.

**Verified live on 2026-08-09** against a running backend: a real signed package
was published privately, probed anonymously, flipped to public, downloaded, and
its signature checked byte for byte. The results are in
[§10](#10-what-was-verified-live).

> **Related documents.** [`PLUGINS.md`](PLUGINS.md) is the authoring guide —
> longer, written for someone building a plugin, and the place where design
> reasoning lives. `PLUGIN_SYSTEM_FOR_AI.md` is a condensed map for agents. This
> file is the cross-repo *system* reference: it is the only one that carries the
> registry's database schema alongside the editor's contracts. When they
> disagree, the code decides, then this file, then the others.

---

## 1. What it is

A plugin is a signed zip containing a manifest and a single ES module. The
editor runs it in a Web Worker with no DOM, no globals from the app, and no
network of its own. It talks to the editor over `postMessage`, through one
method table, gated per-call against permissions the user granted at install.

Two repositories:

| Repo | Role |
|---|---|
| **motion-editor** | Package format, sandbox, host API, permission gate, UI, renderer integration |
| **motion-back** | The registry: publishing, storage, visibility, listings, reports, review, revocation |

Neither imports the other. Where both must agree — the manifest grammar, the
method→permission table — they share **byte-identical JSON fixtures** and each
runs its own copy against them. That is the only mechanism keeping them in step.

---

## 2. The package

```
my-plugin/
  plugin.json      required, at the package root
  main.js          the entry ES module
  panel.html       optional UI
```

Zipping the folder is fine — one wrapping directory is stripped.

### Limits

| Limit | Value | Applies to |
|---|---|---|
| Package size | 8 MB | **uncompressed** |
| Single file | 2 MB | **uncompressed** |
| File count | 200 | |
| Inflation ratio | 200× | per entry |
| Shader source | 64 KB | per effect |
| Decoded image | 64 MB / 8192 px per side | assets API |

Both readers check the **declared uncompressed** size before allocating, then
re-check the real inflated length afterwards. The editor uses fflate's `filter`;
the registry reads the zip's central directory. Sizes checked on compressed
bytes bound nothing — 64 MB of zeros stores in 65 KB.

File types: `.js .mjs .json .html .htm .css .svg .txt .md .wgsl .glsl` as text,
`.png .jpg .jpeg .webp .wasm` as binary. Paths containing `..` are refused.

`main` is loaded as one file — bundle dependencies in.

---

## 3. Manifest schema (editor)

```ts
interface PluginManifest {
  id: string;                        // reverse-DNS, lowercase, permanent
  name: string;
  version: string;                   // semver
  description: string;
  author?: string;
  homepage?: string;                 // http(s) only
  apiVersion: number;                // refused if newer than the host
  main: string;                      // package-relative path
  permissions: PluginPermission[];
  contributes: PluginContributes;
  activationEvents: ActivationEvent[];
}

interface PluginContributes {
  commands:   PluginCommandContribution[];
  panels:     PluginPanelContribution[];
  layerKinds: LayerKindContribution[];   // apiVersion ≥ 3
  effects:    EffectContribution[];      // apiVersion ≥ 4
  net:        NetContribution | null;    // apiVersion ≥ 4
}

type ActivationEvent =
  | 'onStartup'
  | `onCommand:${string}`
  | `onPanel:${string}`
  | `onLayerKind:${string}`;
```

**`HOST_API_VERSION = 4.`** `contributes` requires `apiVersion ≥ 2`.
Omitting `activationEvents` means `['onStartup']`.

### Permissions

Eight, and the consent screen is this list. Consent is **per permission** — the
user may untick any of them — and a grant is always intersected with the
manifest.

| Permission | Grants |
|---|---|
| `scene:read` | Layer names, structure, scalar properties |
| `scene:write` | Create, change, delete, reparent layers |
| `animation:read` | Read keyframes, sample animated values |
| `animation:write` | Create and change keyframes and expressions |
| `assets:read` | Read pixels of images already in the composition |
| `assets:write` | Create images |
| `net:fetch` | Contact **only** the hosts in `contributes.net` |
| `timeline` | Read the time and move the playhead |

Registering commands, notifications, opening the plugin's own panel and reading
composition settings need **no** permission.

### Property types

Used by `layerKinds.props` and `effects.params`, one parser for both.

`number` · `string` · `boolean` · `enum` · `color` · `asset` · `layer`

- Animatable: `number`, `color`, `boolean`.
- `asset` and `layer` are **references** and carry no default — no id a package
  names exists in someone else's project.
- `layer` is valid **only** as an effect parameter; a layer kind has no bind
  group to resolve it against.

---

## 4. Registry schema (motion-back, Prisma)

```prisma
model Plugin {
  id      String @id                       // the manifest id, not a uuid
  ownerId String
  owner   User   @relation(...)

  publisherKey           String            // SPKI base64, ECDSA P-256
  nextPublisherKey       String?           // authorised, not yet used
  nextPublisherKeyMethod PluginKeyRotationMethod?
  previousPublisherKey   String?
  keyRotatedAt           DateTime?

  name          String
  description   String
  homepage      String?
  latestVersion String                     // denormalised from newest version

  blocked       Boolean @default(false)    // operator takedown
  blockedReason String?
  visibility    PluginVisibility @default(public)   // owner's choice

  installs    Int @default(0)
  publisherId String?
  publisher   Publisher? @relation(...)

  readme     String?
  readmeHtml String?                       // sanitised at WRITE time
  changelog  String?
  license    String?
  categories String[] @default([])
  media      PluginMedia[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  versions  PluginVersion[]
  cases     PluginCase[]
  rotations PluginKeyRotation[]

  @@index([ownerId]) @@index([updatedAt]) @@index([publisherId]) @@index([installs])
}

model PluginVersion {
  id       String @id @default(uuid())
  pluginId String
  version  String

  packageBytes Bytes                       // the signed archive itself
  size         Int
  sha256       String
  signature    String

  permissions      String[]
  apiVersion       Int
  hasPanel         Boolean @default(false)
  contributes      Json?
  activationEvents String[] @default([])

  riskScore    Int  @default(0)            // publish-time scanner
  scanFindings Json?
  reviewStatus PluginReviewStatus @default(approved)
  reviewNote   String?
  reviewedAt   DateTime?
  reviewedById String?

  createdAt DateTime @default(now())
  @@unique([pluginId, version])
  @@index([reviewStatus, riskScore])
}

model Publisher {
  id             String  @id @default(uuid())
  namespace      String  @unique            // the plugin id prefix, permanent
  displayName    String
  ownerUserId    String
  verified       Boolean @default(false)    // granted by an operator
  verifiedDomain String?
  plugins        Plugin[]
}

model PluginMedia {
  id       String @id @default(uuid())
  pluginId String
  kind     PluginMediaKind                 // icon | screenshot
  bytes    Bytes
  mime     String
  width    Int
  height   Int
  sort     Int @default(0)
}

model PluginCase {
  id          String @id @default(uuid())
  pluginId    String
  version     String @default("")
  status      PluginCaseStatus @default(new)
  reportCount Int @default(0)
  resolvedAt  DateTime?
  reports     PluginReport[]
  @@unique([pluginId, version])
}

model PluginReport {
  id             String @id @default(uuid())
  caseId         String
  category       PluginReportCategory
  message        String?
  reporterUserId String?                   // nullable: reports need no account
  reporterIpHash String?
}

model PluginKeyRotation {
  id        String @id @default(uuid())
  pluginId  String
  fromKey   String
  toKey     String
  method    PluginKeyRotationMethod
  createdAt DateTime @default(now())
}

enum PluginVisibility        { public  private }
enum PluginReviewStatus      { pending approved changes_requested blocked }
enum PluginMediaKind         { icon screenshot }
enum PluginKeyRotationMethod { backup dashboard }
enum PluginCaseStatus        { new triaging actioned dismissed }
enum PluginReportCategory    { malicious impersonation broken inappropriate license }
```

Package bytes live in Postgres as `Bytea`. The client verifies a signature over
those exact bytes, so every hop that could re-encode them would turn a delivery
detail into a signature failure a user reads as "compromised".

---

## 5. Registry HTTP API

**Public** (no token; `Cache-Control: public` where marked):

| Method | Path | Notes |
|---|---|---|
| `GET` | `/plugins` | Browse. `public` visibility only, `blocked:false`, approved versions only. `max-age=60` |
| `GET` | `/plugins/:id` | Detail. 404 for private. `max-age=60` |
| `GET` | `/plugins/:id/versions/:version/download` | `no-store` — increments `installs`. Refuses a version not `approved`, with the same 404 as a version that does not exist |
| `GET` | `/plugins/categories` · `/plugins/permissions` | Static vocabulary, `max-age=3600` |
| `GET` | `/plugins/media/:mediaId` | Icons and screenshots |
| `GET` | `/plugins/revocations` | Signed list; uploads nothing |
| `POST` | `/plugins/:id/report` | The one public route that writes |

**Authenticated:**

| Method | Path | Notes |
|---|---|---|
| `POST` | `/plugins` | Publish (multipart: file, signature, publicKey, visibility, backupKey) |
| `GET` | `/plugins/mine/list` | Own shelf, private and blocked included, carries `visibility` |
| `GET` | `/plugins/mine/:id/detail` | Owner's view, `no-store` |
| `GET` | `/plugins/mine/:id/versions/:version/download` | Owner download, `no-store`. Does **not** increment `installs` — an author fetching their own package is not an install |
| `POST` | `/plugins/updates` | Batch update check for the caller's installed set |
| `PATCH` | `/plugins/:id/listing` | readme, changelog, license, categories, **visibility** |
| `POST`/`DELETE` | `/plugins/:id/media/:kind`, `/plugins/media/:id` | Listing images |
| `POST`/`DELETE` | `/plugins/:id/keys/authorise` | Key rotation (authorising needs the account password) |
| `DELETE` | `/plugins/:id` | Owner withdraws |
| `POST` | `/publishers` · `GET` `/publishers/mine` | Namespace |

**Operator only:** `POST /plugins/:id/block`, `DELETE /plugins/:id/admin`,
`GET /plugins/admin/storage`, the review queue.

> Route order is load-bearing. Express matches in declaration order and `:id`
> matches any single segment, so a literal route declared after a same-length
> parameter route is unreachable. `plugins.routes.spec.ts` refuses that
> structurally.

### Visibility, exactly

`private` means: absent from browse, 404 on detail, 404 on download, and absent
from the update check — **for everyone except the owner**, who reaches it
through the two `mine/` routes.

The public routes do **not** recognise an owner. They are publicly cacheable, so
a response that varied by caller could be stored by a shared cache and served to
the next person.

The refusal is byte-identical to a plugin that never existed. A 403 saying "this
is private" tells anyone who guesses an id that it exists.

Going private stops **new installs**. Copies already installed keep working.

---

## 6. The editor: storage and lifecycle

### Where an installed plugin lives

| Data | Store | Bound |
|---|---|---|
| Package files and binaries | **IndexedDB** (`PluginDatabase`) | browser quota |
| Metadata index (manifest, grants, source, pinned key) | **localStorage** | 1 MB total |

They are written separately, so a crash or quota failure can leave one without
the other. `hydrate()` reconciles **both** directions at boot — index without
payload is dropped, payload without index is freed — and records what it did in
`lastHydration`, which the Plugins panel renders.

**An installed plugin persists across restarts until the user uninstalls it.**
Nothing on the server removes a plugin from a machine that has it. Withdrawal
and blocking stop distribution, not execution.

### Status

`starting` → `running`, or `inactive` (lazy, not yet needed), `stopped`,
`error`. Boot is bounded at 8 s; a worker that misses pings is terminated.
`PluginHost` exposes a revision counter; UI reads it through
`useSyncExternalStore`.

### The sandbox

- Web Worker, ESM, lockdown applied before the plugin's module is imported.
- No `new Function`, no non-literal dynamic `import`.
- **WebAssembly is allowed**, from bytes inside the signed package. A `.wasm`
  file carries the same signature and the same size limits as the JavaScript
  beside it, and an instantiated module receives no imports the plugin's own JS
  did not hand it — so it reaches exactly what that JS could. Capability `wasm`.
  `WebAssembly.instantiateStreaming` and `compileStreaming` are **removed**:
  both take a network response, and the worker has no network.
- Panels run in a sandboxed iframe **without** `allow-same-origin`, with their
  own CSP (`connect-src 'none'` — a panel has no network even when the plugin
  has `net:fetch`).
- A panel talks to its own plugin and nothing else: `motionPanel.send` /
  `motionPanel.onMessage`.
- Inline `<script>` runs in a panel. `<style>` works anywhere in the document,
  including before any body content, and a `<link rel="stylesheet">` pointing at
  a file in the package is inlined by the host before the markup reaches the
  frame — a relative href would otherwise resolve against the app's origin,
  where the package's files do not exist, and the frame has no network to fetch
  one with. An href the host cannot resolve is left as written and fails.

---

## 7. The host API — all 33 methods

Reached only by a `call` message from the worker, after the permission below has
been checked. Every argument is re-validated host-side; every mutation runs
inside one undo entry labelled with the plugin's name.

| Method | Permission |
|---|---|
| `ui.notify` · `ui.openPanel` · `ui.closePanel` | — |
| `commands.register` | — |
| `composition.get` | — |
| `scene.getSelection` · `setSelection` · `getLayers` · `getLayer` · `onLayerChanged` | `scene:read` |
| `scene.createLayer` · `setProperty` · `renameLayer` · `deleteLayer` · `setParent` · `setVisible` · `setLocked` · `setProxyChildren` | `scene:write` |
| `effects.list` | `scene:read` |
| `effects.add` · `effects.remove` · `effects.setParam` | `scene:write` |
| `animation.getTracks` · `animation.sample` | `animation:read` |
| `animation.setKeyframe` · `setKeyframes` · `removeKeyframe` · `setExpression` | `animation:write` |
| `assets.getImage` | `assets:read` |
| `assets.createImage` | `assets:write` |
| `net.fetch` | `net:fetch` |
| `timeline.getTime` · `timeline.setTime` | `timeline` |

Notes that change what you write:

- `scene.createLayer` accepts `shape`, `text`, `group`, `null`, `image` (image
  needs an `assetId`), or `<pluginId>.<kindId>` for a kind you declared.
- `setParent` preserves world pose — grouping does not move the layer. Cycles
  and cross-composition moves are refused.
- 3D is not a flag: writing `z`, `rotationX`, `rotationY` as numbers is what
  makes a layer 3D.
- `effects.add` returns the new effect's **id**. An unknown type is an error.
  So is removing, or setting a parameter on, an id not on the layer.
- Prefer `animation.setKeyframes` over a loop — the bulk call sorts and notifies
  once.
- `ui.sendToPanel` / `ui.onPanelMessage` are worker-side; they post rather than
  call the host.

---

## 8. Contributions

### Commands
Appear in the **Plugins** menu under the plugin's name, and in the palette.
Declared commands show whether or not the worker has run; runtime-registered
ones appear once it is up.

### Panels
`panel.html`, sandboxed. `placement` decides where:

| `placement` | Lands |
|---|---|
| `shared` *(default)* | A tab in the one **Plugin Panels** panel |
| `sidebar` | Own tab in the left rail — **requires `icon`** |
| `inspector` | Own tab in the right rail — **requires `icon`** |

Rails hand out 3 (left) and 2 (right) plugin slots; past that a panel is demoted
to the shared host and the plugin's row says so. Nothing the user clicks closes
a plugin panel — disabling or uninstalling removes it.

### Layer kinds (API 3)
A plugin invents a layer type with declared props. `render` is `none`, `proxy`
(generates real child layers, which survive uninstall) or `shader`. Proxy
children are diffed on a **stable key**; a user editing a generated child
detaches it from plugin ownership.

### Effects (API 4)
WGSL as data — a plugin never runs code in the frame loop, which is why an
effect keeps working with the worker stopped.

You write one function, `@fragment fn fs(...)`, reading `params.<name>`, `src`
and `samp`. The host generates the bindings, the vertex stage, and the uniform
struct. Declaring `@group`, `@binding` or `@vertex` is refused, as is any
fragment entry not named `fs`.

- The uniform block starts with the renderer's **64-byte header** (`mvp`,
  `uvRect`); parameters begin at offset 64.
- Members are ordered by **alignment descending** — every `vec4` first.
- `boolean` → `f32`. Colour is **0..1**.
- A `layer` parameter adds a **fourth binding**, named after the parameter, so a
  shader can sample a second texture. Max one per effect.
- The validator refuses `while`/`loop`, non-literal loop bounds, loops over 256
  or nested past 3, storage/atomics/`@compute`/`discard`.
- Compilation is bounded at 5 s; failure renders passthrough, never a broken
  frame. A device loss while a plugin effect is drawing disables that effect by
  name — reversibly.
- **WebGPU only.** On the WebGL2 tier a plugin effect renders its input
  unchanged.

### Network (API 4)
`net:fetch` ⟺ `contributes.net`, both directions, max 8 exact hosts.

The request is made in the **main process**, because the renderer's CSP names
our backend and never a plugin's host. The renderer checks plugin identity,
declared hosts, grant, budget and the redirect hop; main re-checks scheme and
the **resolved address**, applies a byte cap and timeout, sends no cookies, and
returns 3xx without following. DNS rebinding is why main resolves: blocking
`localhost` by name stops nothing.

---

## 9. Trust and distribution

**Signing.** ECDSA P-256 / SHA-256, IEEE-P1363, key as SPKI. The registry pins
the public key on first publish; every later version must verify against it. The
editor re-checks **on the user's machine** against the key stored with the
installed copy — not the key the download claims.

| Attack | Result |
|---|---|
| Package altered in transit or on a CDN | Fails local verification |
| Someone else publishes under your id | Refused — the id belongs to the first publisher |
| Registry account stolen | Refused — the thief has no signing key |
| Registry compromised, serves a new key | Refused on update — the client pins the stored key |
| Publisher ships something malicious under their own key | **Not covered.** That is what the permission screen is for |

**Publishing from the editor.** The renderer sends package bytes and a
visibility choice to the main process, which opens a file picker for the key,
signs, attaches the session and uploads. The private key never enters the
renderer and is never stored — one picker per publish. A browser tab falls back
to `scripts/sign-plugin.mjs`.

**Key rotation.** A backup key may be registered at first publish (free of risk
— no install base yet). Later, authorising one needs the account **password**,
and rotation happens only when a package actually arrives signed with it. Every
installed copy prompts its own user before accepting the new key.

**Publish-time scanning** produces a risk score; past a threshold the version is
held `pending` and download refuses it — without naming the review, since that
would tell a guesser a version exists. Publishers see the decision and the
reviewer's words, never the score or the findings.

**Reports** need no account. They aggregate into a `PluginCase` per
plugin+version.

**Revocation** is a signed, cached, public manifest the client matches locally,
uploading nothing. A revoked plugin is reported to anyone running it and their
copy keeps working — the package is blocked, not deleted.

**Immutability.** Re-publishing an existing version is refused: two different
sets of bytes claiming to be `1.2.0` would make the signature guarantee
unusable.

**Updates** are checked only when the manager is opened — never on a timer. An
update asking for more permissions goes back through consent.

---

## 10. What was verified live

Against a running backend, with a real signed package (`auditco.secret-tool`):

| Step | Result |
|---|---|
| Publish with `visibility=private` | stored, `latestVersion 1.0.0` |
| Anonymous browse | not listed (`total: 0`) |
| Anonymous detail / download | `404` / `404` |
| 404 body vs a nonexistent id | indistinguishable |
| Owner `mine/list` | listed, `visibility: private` |
| Owner authenticated download | `200`, full package |
| `PATCH` to `public` → browse | listed |
| `PATCH` to `public` → anonymous download | `200` |
| Downloaded bytes vs published bytes | identical |
| Signature against publisher key | verifies |
| `sha256` vs metadata | matches |
| One byte flipped | verification fails |
| Owner `DELETE` → browse / detail / download | `0` / `404` / `404` |

Shader compilation is verified separately on a real GPU: the composed WGSL for a
two-texture effect compiles with zero diagnostics and builds a valid four-binding
pipeline (`npm run verify-plugin-effect`, plus the uniform-offset probe, which
fits `out = 254.80·amount`, R² = 1.0000).

---

## 11. File map

**motion-editor**

| Concern | File |
|---|---|
| Manifest schema, validation, permission text | `src/core/plugins/manifest.ts` |
| Zip/folder reading, size and zip-slip limits | `src/core/plugins/pluginPackage.ts` |
| Wire protocol, method→permission table | `src/core/plugins/protocol.ts` |
| Sandbox (worker side) | `src/core/plugins/pluginWorker.ts` |
| Host method implementations | `src/core/plugins/hostApi.ts` |
| Install, supervise, permission gate, panels | `src/core/plugins/PluginHost.ts` |
| Persistence | `src/stores/pluginStore.ts` |
| Layer-kind schema · custom layers · registry · proxies | `layerKindSchema.ts` · `customLayers.ts` · `layerKindRegistry.ts` · `proxySubtree.ts` |
| Effect schema, uniform layout, WGSL gate | `effectSchema.ts` · `wgslValidation.ts` · `pluginEffectMaterial.ts` · `pluginEffects.ts` |
| Network policy · main-process transport | `pluginNetFetch.ts` · `electron/pluginNet.ts` |
| Registry client · revocation | `src/core/plugins/registry.ts` · `revocation.ts` |
| Publishing from the app | `electron/pluginPublish.ts` |
| The list, detail, consent, panels | `src/layout/Plugins/*` |
| Renderer integration | `src/core/rendering/snapshotToFrameScene.ts`, `packages/renderer/.../CompositionPass.ts` |

**motion-back**

| Concern | File |
|---|---|
| Package reading and manifest validation | `src/plugins/plugin-package.ts` |
| Publish, browse, detail, download, visibility | `src/plugins/plugins.service.ts` |
| Routes | `src/plugins/plugins.controller.ts` · `publishers.controller.ts` · `review.controller.ts` |
| Signature verification | `src/plugins/plugin-signature.ts` |
| Publish-time scanner | `src/plugins/plugin-scan.ts` |
| Reports · review · revocation | `reports.service.ts` · `review.service.ts` · `revocation.service.ts` |
| Schema | `prisma/schema.prisma` |

**Shared, byte-identical in both:** `__fixtures__/manifests.json` (grammar
cases), `__fixtures__/permissions.json` (consent text),
`__fixtures__/methodPermissions.json` (method→permission).

---

## 12. Where things appear for a user

| Contribution | Found in |
|---|---|
| `commands.register` / `contributes.commands` | **Plugins** menu, under the plugin's name, and the command palette |
| `contributes.panels` | Wherever `placement` sends it, plus a `Your plugin: Panel` command |
| `contributes.effects` | The effects browser, in a folder named after the plugin |
| `contributes.layerKinds` | The layer-creation menu |
| `ui.notify` | A toast, always prefixed with the plugin's name |

Installing a plugin happens on the **dashboard's Plugins page**, beside
publishing. The editor's Plugins panel finds and runs what is already installed;
the row's **Reload** re-reads a folder install from either surface.
