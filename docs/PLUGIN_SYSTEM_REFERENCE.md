# The plugin system, as it stands

> **Plugins are a hosted-build feature.** The UI is hidden in a local build and
> a local build never contacts the registry. A project containing plugin content
> still **opens and saves losslessly** there — custom layers, plugin effects and
> proxy subtrees round-trip byte-for-byte with the plugin absent — it simply has
> nothing to run them with. See [§0](#0-which-builds-have-this).

A single description of what the plugin platform **is today**, across both
repositories: what it does, how the parts fit, every schema on both sides, and
the exact surface a plugin can reach.

This was written against the source of both repositories rather than against the
other documents: schemas, the method table and the manifest interfaces were read
out of the files that define them, and the constants, routes and gates below
were checked in the file that implements each one.

That is a description of how it was written, not a guarantee that stays true.
An earlier version of this line claimed every fact had been extracted
programmatically and re-verified — a claim the document cannot keep, because it
ages the moment either repository moves and nothing re-checks it. Where a fact
here *is* held down by something, the something is named: the shared fixtures
(§11), `docFeatureCounts`-style guards, and the live run in §10. Everything else
is a good-faith reading of the code on the date below. **When this file and the
code disagree, the code is right.**

**Last checked against source: 2026-08-09.**

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

## 0. Which builds have this

| Build | Plugins UI | Registry | A project containing plugin content |
|---|---|---|---|
| **Hosted** (`VITE_EDITION` unset / server) | Yes | Yes | Runs |
| **Local / self-hosted** (`VITE_EDITION=local`) | Hidden | **Never contacted** | Opens, edits, saves — plugin content inert but intact |

Two predicates, deliberately separate:

- `pluginsEnabled()` — whether the feature exists at all. Gates the panel, the
  menu, effect and layer-kind registration, and the host's boot.
- `pluginRegistryEnabled()` — whether the marketplace is reachable. Gates browse,
  install-from-registry, the update check, and the revocation fetch.

A local build fails both. It is not a stripped binary with a hidden switch: the
registry client is never called, so a self-hosted editor makes no request to
premation.com on account of plugins, ever.

**Losslessness is the invariant that makes this safe.** A file authored on a
hosted build and opened on a local one keeps its custom layers, plugin effects
and proxy subtrees exactly as written, including the `plugins[]` provenance
block naming id and version; saving it again reproduces the same bytes. The
inverse — a local build quietly dropping what it could not run — would turn
"open this to look at it" into data loss, so it is covered by a round-trip test
that serialises, parses and re-serialises with the plugin uninstalled.

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
method→permission table, what an old `apiVersion` implied — they share
**byte-identical JSON fixtures** and each runs its own copy against them. That
is the only mechanism keeping them in step, and it is now enforced by a checksum
rather than asked for in a comment: see [§11](#11-file-map).

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
| Shader source | 64 KB | **per pass** |
| Passes per effect | 4 | |
| Pass cost budget | 3 | sum of `scale²` |
| Decoded image | 64 MB / 8192 px per side | assets API |
| Shader compile | 5 s per pass, 10 s per chain | |
| Worker boot | 8 s | per plugin |
| `storage` — `global` | 1 MB | per plugin, IndexedDB |
| `storage` — `project` | 256 KB | per plugin, in the document |
| `storage` — one value | 64 KB | any scope |
| `scene.apply` ops | 10,000 | per batch |
| `scene.apply` payload | 8 MB | per batch |
| Declared net hosts | 8 | exact hosts, per manifest |
| Revocation fetch | 5 s | per attempt |
| README render | 512 KB | falls back to plain `<pre>` |

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
  apiVersion: number;                // the manifest GRAMMAR version
  main: string;                      // package-relative path
  permissions: PluginPermission[];
  requires?: Capability[];           // refuse to install without these
  optional?: Capability[];           // feature-detect at runtime
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

### Two version numbers, moving independently

| Constant | Value | Answers |
|---|---|---|
| `MANIFEST_VERSION` | **5** | What GRAMMAR this host can read. `apiVersion` is compared against this |
| `HOST_API_VERSION` | **5** | What the host can DO. Reported to the plugin; not what `apiVersion` is checked against |

They were one number through 4 and are separate from 5 on. The reason is that
they answer different questions and were drifting apart in practice: adding a
host method does not change how a manifest is written, and adding a manifest
field does not change what a plugin may call. With one number, every method
addition forced a grammar bump that told authors their manifests were outdated
when nothing about them was.

`contributes` requires `apiVersion ≥ 2`. Omitting `activationEvents` means
`['onStartup']`.

### Capabilities

`requires` is what a plugin cannot run without; `optional` is what it will use
if present. Capability strings are **additive and permanent** — never renamed,
never removed, never repurposed — because a manifest is signed and a string that
changed meaning would silently change what a published plugin asked for.

**Static** (present in every hosted build):

`scene.read` · `scene.write` · `scene.proxy` · `scene.batch` ·
`animation.read` · `animation.write` · `assets.read` · `assets.write` ·
`timeline` · `net.fetch` · `storage.global` · `storage.project` ·
`effects.single` · `effects.multipass` · `layerkinds` · `panels` · `wasm`

**Runtime** (depends on the machine): `webgpu`

`webgpu` is why the concept exists. A plugin effect is WGSL, and on the WebGL2
tier it renders its input unchanged — an effect plugin installed there is not
degraded, it is inert. Putting `webgpu` in `requires` is how an author says
"there is no point installing me here", which beats a plugin that looks healthy
and quietly does nothing.

The check runs at **install**, not at first call. A plugin that installs and
then fails is worse than one that never installs: the user has already approved
its permissions, it sits in the list looking fine, and the failure surfaces
later attached to whatever they were doing.

Two refusals, distinguished on purpose: a capability this host knows but this
machine lacks ("needs WebGPU") is an upgrade; one no version has ever had is a
typo in the manifest.

**A manifest with no `requires` is not treated as needing nothing.** It is
granted the set its `apiVersion` implied before capabilities existed —
`CAPABILITIES_BY_API_VERSION`, a pinned table rather than a computed one, so the
static list above can grow without retroactively making an API-4 plugin look
like it asked for things that did not exist when it was signed. The table is
asserted against `__fixtures__/capabilityBackCompat.json`, held byte-identically
in both repos.

### Permissions

Nine, and the consent screen is this list. Consent is **per permission** — the
user may untick any of them — and a grant is always `manifest ∩ user choice`.
Any increase re-enters consent.

| Permission | Grants |
|---|---|
| `scene:read` | Layer names, structure, scalar properties |
| `scene:proxy` | Write **only inside a layer kind's own proxy subtree** |
| `scene:write` | Create, change, delete, reparent layers anywhere |
| `animation:read` | Read keyframes, sample animated values |
| `animation:write` | Create and change keyframes and expressions |
| `assets:read` | Read pixels of images already in the composition |
| `assets:write` | Create images |
| `net:fetch` | Contact **only** the hosts in `contributes.net` |
| `timeline` | Read the time and move the playhead |

`scene:proxy` exists so a generator plugin can stop asking for the whole scene.
A plugin that builds a subtree under its own layer needs to write exactly there,
and `scene:write` was the only way to say it — a consent screen reading "create,
change, delete, reparent layers" for a plugin that only ever touches its own
children. The scope was already enforced by `setProxyChildren`; what was missing
was a way to *ask* for the narrow thing.

`scene:write` **implies** `scene:proxy`. An existing manifest asking for the
wider permission does not need editing, and the implication is expanded at grant
time rather than at the gate, so what is stored is what was consented to.

`scene:read + scene:proxy` cannot create the PARENT layer, and should not: the
user adds it from **Layer ▸ New**, which is the moment they chose to have this
plugin's content in their project.

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

  installs    Int @default(0)              // deduplicated; browse ranks on THIS
  downloads   Int @default(0)              // raw fetches; internal, never ranked
  publisherId String?
  publisher   Publisher? @relation(...)

  readme     String?
  readmeHtml String?                       // DEPRECATED, always NULL — see below
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

model PluginInstallDay {                   // what makes `installs` deduplicated
  id       String @id @default(uuid())
  pluginId String
  version  String
  ipHash   String                          // HMAC, keyed; never the address
  day      String                          // YYYY-MM-DD, UTC
  @@unique([pluginId, version, ipHash, day])
  @@index([day])                           // so a retention sweep is one scan
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
  id            String @id @default(uuid())
  pluginId      String
  version       String @default("")
  status        PluginCaseStatus @default(new)
  reportCount   Int @default(0)            // raw volume; shown, tie-break only
  reporterCount Int @default(0)            // DISTINCT reporters; the queue's sort
  resolvedAt    DateTime?
  reports       PluginReport[]
  @@unique([pluginId, version])
  @@index([status, reporterCount])
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

**Package bytes live in Postgres as `Bytea`,** up to 8 MB per version, one row
per version, kept forever because versions are immutable. The reason is
transactional simplicity: one transaction covers metadata and bytes, one backup
covers both, and there is no second system to keep consistent. (An earlier note
here claimed object storage would re-encode the bytes and break the signature.
That is false — object storage returns exactly what was PUT — and a wrong reason
in a comment is what makes someone reopen a settled question.)

The consequence that bites is Prisma's default: **no `select` means every scalar,
including the 8 MB blob.** The review queue over fifty pending versions is up to
400 MB of heap to render a list of names. Every `PluginVersion` query carries an
explicit `select` except the two download paths and publish, and
`packageBytesSelection.spec.ts` sweeps for the rule rather than for a list of
blessed lines. `GET /plugins/admin/storage` reports total bytes, bytes by
plugin, and version count, so the growth is measured before it is a surprise.

**`readmeHtml` is deprecated and always `NULL`.** It held HTML rendered at write
time, on the reasoning that one crossing of a security boundary is easier to
audit than one per reader. What that missed is repair: a renderer bug leaves
every row written before the fix poisoned, patching the renderer does not clean
them, and the dashboard injects this into a page where operators are signed in —
so "poisoned" means stored XSS against a live session. README is rendered **on
read** from `readme`, which makes the renderer in effect always the deployed one.

`plugin-listing.ts` is **construct-only**, not parse-then-sanitise: it escapes
first and then builds the allowed tags itself, so there is no parser whose
disagreement with a browser's could be exploited. Generated `<code>` and `<a>`
spans are parked behind sentinels before the emphasis pass — without that, an
emphasis rewrite could reach inside a generated `href`, which is the mXSS shape.
Rendering is capped at 512 KB with a plain-text `<pre>` fallback.

---

## 5. Registry HTTP API

**Public** (no token; `Cache-Control: public` where marked):

| Method | Path | Notes |
|---|---|---|
| `GET` | `/plugins` | Browse. `public` visibility only, `blocked:false`, approved versions only. `max-age=60` |
| `GET` | `/plugins/:id` | Detail. 404 for private. `max-age=60` |
| `GET` | `/plugins/:id/versions/:version/download` | `no-store` — moves the counters (below). Refuses a version not `approved`, with the same 404 as a version that does not exist |
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
| `GET` | `/plugins/mine/:id/versions/:version/download` | Owner download, `no-store`. Moves **neither** counter — an author fetching their own package is not an install. Guarded by authentication, not ownership, so a signed-in stranger reaching it counts normally |
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

### The two counters

| Column | Moves | Public? | Ranked on? |
|---|---|---|---|
| `downloads` | Every fetch of the bytes by a non-owner | No | Never |
| `installs` | At most once per `(plugin, version, address, day)` | Yes | Yes |

One column could not be both. `installs` is indexed, browse orders on it, and
the route that moved it is an unauthenticated public GET — so a shell loop moved
marketplace rankings, and the listings worth pushing up are exactly the ones
somebody would bother to push.

`installs` is **not** a count of unique people: an office behind one NAT counts
once, a commuter counts several times as their address changes. It is a ceiling
on how fast the number can be moved from one place, which is the property a
ranking needs.

The `PluginInstallDay` unique constraint **is** the deduplication. The insert is
attempted first and the counter moves only if it succeeded, so two concurrent
downloads race in Postgres — a read-then-write would let both through. A
download with no resolvable address moves `downloads` but not `installs`: with
nothing to deduplicate against, counting it would hand back the unlimited
increment. Addresses are stored only as a keyed HMAC, under a label distinct
from the one abuse reports use, so the two tables cannot be joined to answer
"which reporter also downloaded this".

### Reports and the review queue

Reports need no account. They aggregate into a `PluginCase` per
`(plugin, version)`, and the queue orders on **distinct reporters**, not raw
volume: "forty people noticed" and "one person clicked forty times" are the same
`reportCount`, and sorting on that hands the top of a reviewer's day to whoever
is most determined. Both numbers are returned, because their difference is
itself the signal.

A reporter is their account when signed in and their address hash when not,
matched only within its own namespace — so the answer does not depend on arrival
order. A report with neither moves the raw count only.

| Ceiling | Value | Bounds |
|---|---|---|
| Per account, rolling hour | 10 | rate |
| Per address, rolling hour | 20 | rate |
| Per account, per case | 3 | pile-on |
| Per address, **per plugin**, no window | 8 | a campaign |

The last one closes the gap the per-case cap leaves: a case is keyed on
(plugin, **version**) and the reporter picks the version, so three reports
against 1.0.0, three against 1.0.1 and three against a version that never
shipped never trip it — while the queue fills with cases about one plugin, which
reads to a reviewer as a plugin in serious trouble.

**No threshold on any count blocks a plugin.** A case escalates to a human and
nothing else. An automatic block driven by a count is a takedown button handed
to anyone who can make the count go up, and reporting is cheap by design.

---

## 6. The editor: storage and lifecycle

### Where an installed plugin lives

| Data | Store | Bound |
|---|---|---|
| Package files and binaries | IndexedDB, `packages` | browser quota |
| Metadata index (manifest, grants, source, pinned key, security events) | IndexedDB, `index` | 1 MB total |
| A plugin's own `global` bag | IndexedDB, `storage` | 1 MB per plugin |
| A plugin's own `project` bag | inside the project document | 256 KB per plugin |

All three stores are `PluginDatabase`, at `DB_VERSION = 3`.

The index used to live in `localStorage`. Two storage systems meant two writes
with no way to commit them together, so a crash or a quota failure between them
left an index entry with no package (a plugin that lists and cannot start,
forever) or a package no index points at (megabytes of software the user
believes they removed). `put` and `remove` now name both stores in **one
transaction** and resolve on `oncomplete` — a request can succeed while the
transaction aborts, and reporting success there is the torn write itself.

`hydrate()` stays, because it still catches what a transaction cannot: an
aborted commit, a database the browser evicted, and every record written by an
older build. It reconciles **both** directions and records what it did in
`lastHydration`, which the Plugins panel renders — silently dropping something a
user installed is how a plugin manager loses trust. It also performs the
one-time move off `localStorage`, **verify-then-clear**: the old key is removed
only after the new record has been read back, because clear-then-write would
lose every installed plugin the one time the write failed.

The two bags have opposite lifetimes, which is why they are separate stores
rather than one record. A `global` bag survives update and uninstall — it is a
plugin's settings, and deleting them on update would make every upgrade a reset.
A `project` bag travels with the file, so a project sent to a colleague carries
what the plugin remembered about it. Both are namespaced per plugin, capped at
64 KB per value, and a write past the quota throws
`storage-quota-exceeded` rather than silently truncating.

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
- **WebAssembly is allowed.** `WebAssembly` survives lockdown and `.wasm` is a
  recognised binary extension. A `.wasm` file carries the same signature and the
  same 2 MB cap as the JavaScript beside it, and an instantiated module receives
  no imports the plugin's own JS did not hand it — so it reaches exactly what
  that JS could. Capability `wasm`. `WebAssembly.instantiateStreaming` and
  `compileStreaming` are **removed**: both take a network response, and the
  worker has no network.
  **Gap:** the boot message carries the entry module's source and not
  `binaries`, so a worker cannot read its own `.wasm` file. Embedding it in
  `main.js` works; a `package.read(path)` verb is the fix and is not built.
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

## 7. The host API — all 38 methods

Reached only by a `call` message from the worker, after the permission below has
been checked. Every argument is re-validated host-side.

| Method | Permission |
|---|---|
| `ui.notify` · `ui.openPanel` · `ui.closePanel` | — |
| `commands.register` | — |
| `composition.get` | — |
| `storage.get` · `set` · `delete` · `list` | — |
| `scene.getSelection` · `setSelection` · `getLayers` · `getLayer` · `onLayerChanged` | `scene:read` |
| `scene.setProxyChildren` | `scene:proxy` |
| `scene.createLayer` · `setProperty` · `renameLayer` · `deleteLayer` · `setParent` · `setVisible` · `setLocked` | `scene:write` |
| `scene.apply` | union of the ops in the batch |
| `effects.list` | `scene:read` |
| `effects.add` · `effects.remove` · `effects.setParam` | `scene:write` |
| `animation.getTracks` · `animation.sample` | `animation:read` |
| `animation.setKeyframe` · `setKeyframes` · `removeKeyframe` · `setExpression` | `animation:write` |
| `assets.getImage` | `assets:read` |
| `assets.createImage` | `assets:write` |
| `net.fetch` | `net:fetch` |
| `timeline.getTime` · `timeline.setTime` | `timeline` |

`storage.*` needs no permission. A plugin's own bag is not the user's data — it
is the plugin's, namespaced to it, readable by nothing else — and a consent
screen line for "this plugin can remember its own settings" is a line that
teaches people to click through consent screens.

### Undo granularity

**One host call is one undo entry**, labelled with the plugin's name. Twelve
calls are twelve entries, and undoing a plugin's work means pressing Ctrl-Z
twelve times.

`scene.apply` is the answer to that, and the reason it exists is as much about
undo as about round trips. A batch is **one** entry: everything in it applies or
none of it does, and one Ctrl-Z takes it all back. It also coalesces store
notifications — a naive loop of 40 mutations produced 82 re-renders, because the
scene graph bumps independently of the host, so the coalescing has to happen at
the store (`batchScene`), not in `hostApi`.

Limits: 10,000 ops, 8 MB. An op may reference an earlier op's result by index
(`{ ref: n }`), which is how a batch creates a layer and then parents to it. The
permission required is the **union** of the ops present, so a read-only batch
needs no write grant.

Notes that change what you write:

- `scene.createLayer` accepts `shape`, `text`, `group`, `null`, `image` (image
  needs an `assetId`), or `<pluginId>.<kindId>` for a kind you declared.
- Inside `scene.apply`, creates anchor to **where op 0 landed**, not to the
  user's selection. `insertPrimitive` parents to the selection, so a batch of a
  thousand creates would otherwise build a thousand-deep chain.
- `setParent` preserves world pose — grouping does not move the layer. Cycles
  and cross-composition moves are refused.
- 3D is not a flag: writing `z`, `rotationX`, `rotationY` as numbers is what
  makes a layer 3D.
- `effects.add` returns the new effect's **id**. An unknown type is an error.
  So is removing, or setting a parameter on, an id not on the layer.
  On the WebGL2 tier it returns `{ id, active: false, reason: 'webgpu-unavailable' }`
  — the effect is stored in the project and will draw on a WebGPU machine, but
  saying so beats returning an id that draws nothing.
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
  `uvRect`), then the host's **32-byte pass block**; parameters begin at
  offset **96**. See below.
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
  unchanged. This is now *reported* rather than silent: `effects.add` answers
  `{ active: false, reason: 'webgpu-unavailable' }`, the plugin's row in the
  manager says its effects cannot draw on this renderer, and a manifest may put
  `webgpu` in `requires` to refuse installation outright. The effect is still
  saved with the project and draws on a machine that can.

### Multi-pass (capability `effects.multipass`)

An effect may declare up to **4** passes instead of one `shader`. The two are
mutually exclusive — an effect declaring both does not say which one draws.

```ts
interface EffectPass {
  name: string;                              // camelCase, unique in the chain
  wgsl: string;                              // same one-`fs` contract, same validator
  scale?: 1 | 0.5 | 0.25;                    // ⚠ only 1 is rendered — see below
  reads?: 'previous' | 'origin' | 'both';    // ⚠ only 'previous' is rendered
}
```

The host allocates the targets, ping-pongs them and sequences the draws. A
plugin never sees a target, never allocates one, and still never runs code in
the frame loop.

Execution reuses the renderer's existing spatial-effects chain: `registerEffects`
composes one shader per pass, `snapshotToFrameScene` emits one scene entry per
pass, and `runEffectsChain` — which already ping-pongs for a layer carrying a
blur then a glow — runs them in order. No new render mechanism was added.

> ### ⚠ `scale` and `reads` are in the format and NOT rendered
>
> Both are parsed, budgeted, documented — and **refused at install and at
> publish**, in both repositories, with a message naming the reason.
>
> `scale`: the renderer's offscreen targets are a fixed, statically-declared set
> and every one is viewport-sized. There is nowhere to draw a quarter-size pass.
>
> `reads: origin | both`: the chain ping-pongs between a small pool, so the
> pass-0 input is overwritten before a later pass could sample it. Keeping it
> alive needs a target reserved across the whole chain, and the pool has none to
> spare — it contends with the one glow borrows for its wide lobe.
>
> They are refused rather than ignored because accepting them and rendering at
> full size, or binding a reused texture, is wrong output with no error: a bloom
> four times the cost the author budgeted, or a composite against whatever was
> last drawn there. Widening later is backward-compatible in both directions —
> manifests that publish today keep working, ones refused today start working.
> The reverse, shipping a field that silently does nothing and then making it
> real, breaks every plugin that guessed around it.
>
> **So what works today is: up to four full-scale passes, each reading the one
> before it.** That is a separable blur, a multi-tap convolution, an iterative
> sharpen — the bulk of what one `fs` function could not express.

**Bindings per pass.** 0 uniform, 1 `src` (the previous pass's output, or the
layer for pass 0), 2 `samp`, 3 the optional `layer` param texture, **4 optional
`origin`** — the pass-0 input, reachable only once `reads` is renderable.
`origin` stays at 4 even when 3 is unused: sliding it down would make a binding
number depend on an unrelated part of the manifest, which the generator and the
resource-binding side would each have to derive separately.

`reads` on pass 0 is refused permanently and separately — its `src` and its
`origin` are the same texture, so naming one is a statement no renderer can
satisfy. That refusal keeps its own message, because "wait for a later version"
would be wrong advice.

**The cost budget.** A pass costs `scale²` — its share of the pixels — and a
chain may total **3**. Both numbers differ from the work order that specified
them (`1/scale²`, budget 6), which was inverted and self-contradictory:
`1/scale²` scores quarter scale, the cheapest pass allowed, at sixteen times a
full one and puts a single one over the budget; and under either exponent four
full-scale passes cost 4, so a budget of 6 does not refuse the chain the same
brief says it must.

| Chain | Cost | |
|---|---|---|
| Separable blur, two full-scale passes | 2 | ✓ |
| Bloom: bright pass, two ¼-scale blurs, composite | ≈2.13 | ✓ |
| Four ¼-scale passes | 0.25 | ✓ |
| Four full-scale passes | 4 | ✗ |

**Compilation.** 5 s per pass, 10 s total. Any pass failing renders the whole
effect passthrough and marks it failed by name — never a partially applied
chain. Device loss disables by name, reversibly, as before.

**Registry naming.** A single-pass effect keeps the bare
`<pluginId>.<effectId>`, unchanged, so every already-published effect resolves
exactly as it did. A chain suffixes each pass: `acme.blur#horizontal`.

A working two-pass separable Gaussian blur ships as
`src/layout/Plugins/blurSamplePlugin.ts`.

### The host pass block — why parameters start at 96

A pass needs its own texel size: a blur samples `uv ± texelSize`, and a pass at
`scale: 0.25` renders into a quarter-size target, so the value differs per pass
and an author cannot compute it. A 32-byte host block sits between the
renderer's header and the author's parameters.

```
offset  0   renderer header      mvp (48) + uvRect (16)      64 bytes
offset 64   host pass block      texelSize : vec2<f32>
                                 passScale : f32
                                 passIndex : f32
                                 _reserved : vec4<f32>       32 bytes
offset 96   parameters, alignment-descending as before
```

`_reserved` rounds the block to 32 so the parameter base is 16-aligned, and so
the next field this has to carry does not move every offset again.

The block is emitted for **single-pass effects too**. Two layouts would make
every parameter offset depend on a condition that the CPU packer and the shader
generator each evaluate separately — the exact shape of the bug that made the
64-byte renderer header necessary in the first place.

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

**Getting a key at all.** The publish flow asks *Use an existing key… / Create a
new key… / Cancel*, and the second generates one in the main process, writes it
`0600` where the user chooses, and signs with it immediately. Byte-compatible
with `scripts/sign-plugin.mjs keygen` — same curve, same field names, same
encodings — so the two are interchangeable.

Added because the flow previously opened a file picker demanding a key that only
the CLI script could make, which anyone who installed the app rather than
cloning the repo had no way to produce. A dialog that cannot be satisfied is
worse than a missing feature: it reads as "you should already have this".

**Publishing from the editor.** The renderer sends package bytes and a
visibility choice to the main process, which opens a file picker for the key,
signs, attaches the session and uploads. The private key never enters the
renderer and is never stored — one picker per publish. A browser tab falls back
to `scripts/sign-plugin.mjs`.

**Key rotation.** A backup key may be registered at first publish (free of risk
— no install base yet). Later, authorising one needs the account **password**,
and rotation happens only when a package actually arrives signed with it.

The authorised successor is **published on the detail response**
(`nextPublisherKey`, `nextPublisherKeyMethod`), which reverses a deliberate
earlier omission. Withholding it looked prudent — why tell an attacker which key
to steal next — but it made the prompt useless: a client first learned of the
new key in the same response asking it to trust that key, which is no evidence
at all. So every rotation produced the same generic prompt, including the one a
thief with a stolen account most wants shown. Publishing it lets an installed
copy pin the successor **before** it is used, and then tell three cases apart:

| The installed copy already pinned this key | Prompt |
|---|---|
| Yes, and it was registered as a `backup` at first publish | Quiet — it was authorised before there was anything to steal |
| Yes, authorised later via `dashboard` | Prompt, naming the date and method |
| No | Prompt hard — this key was never announced |

Every case is recorded in the plugin's `securityEvents` (capped at 20), which
the manager shows. The public `PluginKeyRotation` history is append-only: a
history a publisher could edit would be worth nothing.

Note the asymmetry in `KeyChangeRequest.authorisation`: it can be `dashboard` or
`unknown`, never `backup`. A backup rotation that matches a locally pinned key
does not reach the prompt at all, so there is no path that would produce it —
and a value that can never occur is a branch nobody tests.

**Publish-time scanning** produces a risk score and findings, both stored on the
version — and **gates nothing**. A publish goes live.

The gate was removed deliberately. The scanner is a pattern match over source a
hostile author fully controls, so anyone reading the public rule list can score
zero; it stopped the careless and not the deliberate. What it reliably stopped
was honest authors — the first plugin ever published against this registry was
held for a permission mismatch, silently, and disappeared from the marketplace
its author had just published to.

The findings now go **to the author**, as `warnings` on the publish response.
They were withheld while they gated publication (naming the rules you tripped is
naming what to avoid tripping); with no gate there is nothing left to protect,
and `permission-undeclared` in particular tells an author their plugin will have
calls refused at runtime — which a successful publish otherwise hides completely.

`reviewStatus` still exists and download still refuses anything that is not
`approved`. Nothing writes `pending` any more; what remains are the operator
decisions `blocked` and `changes_requested`, which still bite. The protections
that were always doing the work are unchanged: the sandbox, the permission
screen, signature pinning, the report path into a human, and an operator's block
— which reaches machines that already installed it, as no pre-publication gate
ever could.

**Reports** need no account, aggregate into a `PluginCase` per plugin+version,
and are metered four ways — see [§5](#reports-and-the-review-queue). No count
blocks anything automatically.

**Revocation** is a signed, cached, public manifest the client matches locally,
uploading nothing. A revoked plugin is reported to anyone running it and their
copy keeps working — the package is blocked, not deleted.

It is fetched at **host boot**, not when the manager is opened, and the cached
list is enforced **before** enabled plugins are started. Those are two separate
facts and the second was the real defect: a 304 — the common cold start — left
the client with a perfectly good cached list and no code path that acted on it,
so a revoked plugin kept running until someone happened to open the Plugins
panel. The fetch is bounded at 5 s and sends `If-None-Match`; the ETag is a
content tag over `{seq, entries}` only, because `issuedAt` is per-request and an
ETag including it could never match. Freshness is re-based on the last
**confirmation** (including a 304), not the last full body — otherwise a
correctly-unchanged list ages into "stale" and warns about nothing.

The operator key is pinned locally. `acceptRevocationList` takes exactly one
argument for that reason, and a standing test sweeps for a second — remembering
an ETag is a separate function, because the fix for "the pin is being widened"
is to delete the argument, not to widen the sweep.

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
pipeline (`npm run verify-plugin-effect`, plus the uniform-offset probe).

**A chain actually executes** — `npm run verify-plugin-chain`, real adapter,
2026-08-10. The sample plugin's own composed passes (bundled out of the app with
esbuild, not retyped) run over a 4×4 bright square:

| stage | spread X | spread Y |
|---|---|---|
| source | 4 | 4 |
| after `horizontal` | **14** | 4 |
| after `vertical` | 14 | **14** |

Each pass widened its own axis and left the other alone. That discriminates four
distinct failures at once: a pass that never ran, a `texelSize` of zero (no
widening at all), pass 0 drawn twice (X widens again), and a pass blurring both
axes. Confirmed non-vacuous by composing pass 0 twice — X went 14 → 20 with Y
stuck at 4, and the probe failed.

This probe exists because unit tests could not answer the question. Two composed
shaders, two registry entries and two scene entries are all equally consistent
with a renderer that draws the first one twice — and for a while, that is
roughly what was happening: `passes` parsed, composed, budgeted and documented,
with nothing executing it, and every test green.

**Uniform-offset probe, re-run on real hardware, 2026-08-10:**

| amount | mean output | pass block |
|---|---|---|
| 0.00 | 0.00 | 255 |
| 0.25 | 64.00 | 255 |
| 0.50 | 127.00 | 255 |
| 0.75 | 191.00 | 255 |
| 1.00 | 255.00 | 255 |

`out = 254.80·amount + 0.00`, R² = 1.0000, parameter read from **offset 96**.

> ★ **The fit is identical to the one recorded for the 64-byte layout, and that
> is exactly why the probe gained a second channel.** Moving the parameter and
> the packing together produces the same slope, so the slope alone cannot
> distinguish the new layout from the old one — or from a build that dropped
> the pass block and left `amount` back at 64. The shader now also returns
> whether `texelSize`, `passScale` and `passIndex` arrived intact, in the green
> channel. Confirmed non-vacuous by corrupting one packed value: green fell to
> 0 across all five samples while the fit stayed at R² = 1.0000.

Not verified live, and worth being explicit about: the counting split
([§5](#the-two-counters)) and the distinct-reporter ordering are covered by unit
tests against a store that enforces the unique constraints, not by a run against
Postgres. The constraint expressions themselves are in the migrations and have
not been executed against a real database from this work.

---

## 11. File map

**motion-editor**

| Concern | File |
|---|---|
| Which builds have plugins at all | `src/core/config/edition.ts` |
| Manifest schema, validation, permission text | `src/core/plugins/manifest.ts` |
| Capability list, back-compat table, install check | `src/core/plugins/capabilities.ts` |
| Zip/folder reading, size and zip-slip limits | `src/core/plugins/pluginPackage.ts` |
| Wire protocol, method→permission table | `src/core/plugins/protocol.ts` |
| Sandbox (worker side) | `src/core/plugins/pluginWorker.ts` |
| Host method implementations | `src/core/plugins/hostApi.ts` |
| Batch op grammar and validation | `src/core/plugins/sceneBatch.ts` |
| Plugin storage — scopes, quotas, project capture | `src/core/plugins/pluginStorage.ts` |
| Install, supervise, permission gate, panels | `src/core/plugins/PluginHost.ts` |
| Persistence — index and payload in one transaction | `src/stores/pluginStore.ts` · `src/core/services/PluginDatabase.ts` |
| Panel HTML: path resolution, `<link>` inlining | `src/layout/Plugins/panelHtml.ts` · `public/plugin-panel.html` |
| README rendering in the manager (sandboxed frame) | `src/layout/Plugins/readmeDocument.ts` · `ReadmeFrame.tsx` |
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
| Whether the registry is served at all | `src/plugins/plugins.edition.ts` |
| Package reading and manifest validation | `src/plugins/plugin-package.ts` |
| Publish, browse, detail, download, visibility, counters | `src/plugins/plugins.service.ts` |
| Routes | `src/plugins/plugins.controller.ts` · `publishers.controller.ts` · `review.controller.ts` |
| Signature verification | `src/plugins/plugin-signature.ts` |
| Publish-time scanner | `src/plugins/plugin-scan.ts` |
| README rendering (construct-only) and listing validation | `src/plugins/plugin-listing.ts` |
| Client address and its keyed hash | `src/plugins/client-ip.ts` |
| Reports · review · revocation | `reports.service.ts` · `review.service.ts` · `revocation.service.ts` |
| Schema | `prisma/schema.prisma` |

**Shared, byte-identical in both** — five files, digests in
`__fixtures__/CHECKSUMS.txt`:

`manifests.json` (grammar cases) · `permissions.json` (consent text) ·
`methodPermissions.json` (method→permission) · `reportCategories.json` ·
`capabilityBackCompat.json` (what an `apiVersion` implied)

Identity is **enforced**, not conventional: `scripts/fixtures-hash.mjs` is
itself byte-identical in both repos, hashes all five with CRLF→LF
normalisation, and fails with a message naming the sibling repository. Before
this, "keep these in sync" was a sentence in a comment, which is the same as no
mechanism at all.

`methodPermissions.json` holds **28** entries for **38** methods. A method
needing no permission is absent rather than mapped to `null`: `ui.*`,
`commands.register`, `composition.get` and `storage.*` are free, and
`scene.apply` resolves to the union of the ops in the batch, so none of them has
one fixed answer to share.

The README XSS corpus (`readmeXss.json`) is **not** shared — rendering happens
only in the registry, so it lives only there.

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

A plugin's row also carries, when they apply: what `hydrate()` reconciled at
boot, whether its effects can draw on this renderer, a takedown notice (which
for `malicious` cannot be dismissed unread), and its `securityEvents` — the
record of every key rotation it has been through and how each was authorised.

**Nothing the user clicks closes a plugin surface.** A ✕ on a plugin panel would
be a control that means "hide this until something else brings it back", which
is not a state the user can reason about; disabling or uninstalling the plugin
is what removes it, and both are reversible from one place.

In a local build none of this appears — see [§0](#0-which-builds-have-this).
