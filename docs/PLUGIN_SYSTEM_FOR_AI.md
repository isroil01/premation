# Premation plugins — condensed map

**Audience:** an agent or engineer with no prior context, needing orientation
fast. **This file is a map, not the territory.** It is deliberately short and
carries no detail that is stated in the other two — a third full copy is a third
thing to keep true, and the previous version of this file rotted exactly that
way: it described host API **1** while the product shipped **5**, and asserted
that browse required a token and that a plugin could not draw pixels, both of
which had been false for months.

| For | Read |
|---|---|
| Both repos, every schema, the exact surface | [`PLUGIN_SYSTEM_REFERENCE.md`](PLUGIN_SYSTEM_REFERENCE.md) |
| Building a plugin, and why the design is what it is | [`PLUGINS.md`](PLUGINS.md) |
| What is true right now | the code |

**When any of these disagree, the code decides, then the reference, then the
authoring guide, then this file.**

**Last checked against source: 2026-08-09.**

> **Hosted-build feature.** The UI is hidden in a local (`VITE_EDITION=local`)
> build and a local build never contacts the registry. A project containing
> plugin content still opens and saves losslessly there — it just has nothing to
> run it with.

---

## The shape of it, in one paragraph

A plugin is a signed zip: `plugin.json` plus one ES module. It is parsed as
**data** first, and the permissions it asks for are shown on a consent screen
**before any code exists anywhere**. Only after the user accepts does the entry
module reach a dedicated **Web Worker**, which calls `lockdown()` — removing
`fetch`, XHR, WebSockets, IndexedDB, `importScripts`, `new Function` — and then
imports it. From there the plugin can only post messages naming API methods; the
host re-validates every argument and checks every call against the permissions
actually granted. A plugin that wedges its event loop stops answering a
heartbeat and is terminated. A plugin may also ship an HTML **panel**, rendered
in a sandboxed iframe with no `allow-same-origin` and `connect-src 'none'` —
a panel has no network even when the plugin holds `net:fetch` — which can talk
only to its own worker. Packages are distributed by a registry in `motion-back`
with ECDSA-P256 signatures and trust-on-first-use publisher keys.

---

## The numbers that date a document

If a plugin doc disagrees with this table, that doc is stale.

| | Value |
|---|---|
| `MANIFEST_VERSION` | **5** — the grammar; `apiVersion` is checked against this |
| `HOST_API_VERSION` | **5** — what the host can do; independent since 5 |
| Host methods | **38** |
| Permissions | **9** |
| Static capabilities | **17** (+ `webgpu`, which is runtime) |

---

## Ten load-bearing facts

1. **A plugin never runs code in the frame loop.** Effects are WGSL shipped as
   *data*; the host generates the bindings, the vertex stage and the uniform
   struct. This is why a plugin effect keeps drawing with the worker stopped.
2. **A panel has no network.** `connect-src 'none'`, unconditionally.
3. **Permissions are intersected, never widened.** A grant is
   `manifest ∩ user choice`, and any increase re-enters consent.
4. **Signature is over the exact published bytes.** No re-encoding, re-zipping
   or normalising anywhere from publish to local verification.
5. **Local key pinning wins.** The editor verifies against the key stored with
   the installed copy, never the key a download asserts.
6. **Version immutability.** Bytes for a `(pluginId, version)` are written once.
7. **Refusals are indistinguishable.** Private, nonexistent, blocked and
   not-yet-approved all return the same 404 with the same body.
8. **Public routes are cacheable and caller-blind.** No public response varies
   by identity — which is why owners have separate `mine/` routes rather than
   the public ones learning to recognise them.
9. **Blocking and withdrawal stop distribution, not execution.** Nothing on the
   server removes a plugin from a machine that has it. Revocation *tells* a
   running copy; it does not delete it.
10. **The scanner is advisory.** It gates review, never publication, and it is
    a pattern match over source a hostile author fully controls. The sandbox is
    the boundary.

---

## Where to look

**motion-editor**

| Concern | File |
|---|---|
| Is this build allowed plugins at all | `src/core/config/edition.ts` |
| Manifest grammar, permission text | `src/core/plugins/manifest.ts` |
| Capabilities, back-compat table, install check | `src/core/plugins/capabilities.ts` |
| Zip reading, size and zip-slip limits | `src/core/plugins/pluginPackage.ts` |
| Wire protocol, method→permission | `src/core/plugins/protocol.ts` |
| Sandbox (worker side), `lockdown()` | `src/core/plugins/pluginWorker.ts` |
| The 38 method implementations | `src/core/plugins/hostApi.ts` |
| Batch op grammar | `src/core/plugins/sceneBatch.ts` |
| Plugin storage, scopes and quotas | `src/core/plugins/pluginStorage.ts` |
| Install, supervise, permission gate, panels | `src/core/plugins/PluginHost.ts` |
| Persistence (index + payload, one transaction) | `src/stores/pluginStore.ts` · `src/core/services/PluginDatabase.ts` |
| Registry client · revocation | `src/core/plugins/registry.ts` · `revocation.ts` |
| Effects: schema, uniform layout, WGSL gate | `effectSchema.ts` · `wgslValidation.ts` · `pluginEffectMaterial.ts` |
| Layer kinds and proxy subtrees | `layerKindSchema.ts` · `customLayers.ts` · `proxySubtree.ts` |
| Network policy · main-process transport | `pluginNetFetch.ts` · `electron/pluginNet.ts` |
| UI | `src/layout/Plugins/*` |

**motion-back**

| Concern | File |
|---|---|
| Is the registry served | `src/plugins/plugins.edition.ts` |
| Publish, browse, detail, download, counters | `src/plugins/plugins.service.ts` |
| Routes (order is load-bearing) | `src/plugins/plugins.controller.ts` |
| Signature verification | `src/plugins/plugin-signature.ts` |
| README rendering, construct-only | `src/plugins/plugin-listing.ts` |
| Reports · review · revocation | `reports.service.ts` · `review.service.ts` · `revocation.service.ts` |
| Schema | `prisma/schema.prisma` |

---

## What the two repos share, and how it is held

Neither imports the other. Where both must agree they share **byte-identical
JSON fixtures** and each runs its own copy against them:

`manifests.json` (grammar cases) · `permissions.json` (consent text) ·
`methodPermissions.json` (method→permission) · `reportCategories.json` ·
`capabilityBackCompat.json` (what an `apiVersion` implied)

Identity is enforced by `scripts/fixtures-hash.mjs`, itself byte-identical in
both repos, which hashes all five with CRLF→LF normalisation and fails naming
the sibling repository. Their digests live in `__fixtures__/CHECKSUMS.txt`.
Before that, "keep these in sync" was a comment.

**Adding a host method that needs a permission** therefore means editing
`methodPermissions.json` in both repos and re-running the hash script in both.
The fixture check is what stops the registry and the editor disagreeing about
what a method costs.

Note that the fixture carries **28** entries, not 38: a method needing no
permission is absent from it rather than mapped to `null`. `ui.*`,
`commands.register`, `composition.get` and `storage.*` are free, and
`scene.apply` takes the union of the ops in the batch, so none of them has a
fixed entry to share.

The README XSS corpus (`readmeXss.json`) is **not** shared — rendering happens
only in `motion-back`, so it lives there alone.

---

## Traps that have actually bitten

- **Express route order.** `:id` matches any single segment, so a literal route
  declared after a same-length parameter route is unreachable —
  `/plugins/:id/revocations` swallowed `/plugins/revocations` for months.
  `plugins.routes.spec.ts` refuses that structurally, and a metadata-only guard
  *cannot* see it.
- **Prisma selects every scalar by default.** `PluginVersion.packageBytes` is
  the 8 MB archive; a query without an explicit `select` drags every blob in the
  result set into heap. Every such query carries one except the two download
  paths and publish.
- **Size checks on compressed bytes bound nothing.** 64 MB of zeros stores in
  65 KB. Both readers check the declared uncompressed size before allocating and
  the real inflated length after.
- **`installs` is public, indexed, and moved by an unauthenticated GET.** It is
  deduplicated per (plugin, version, address, day); the raw `downloads` counter
  is internal and never ranked on.
- **A count must not block anything.** Reporting needs no account, so an
  automatic block on a threshold is a takedown button anyone can press.
- **An ETag over a per-request field can never match.** The revocation content
  tag covers `{seq, entries}` only, and freshness re-bases on the last
  *confirmation* — including a 304.
- **A cached safety list is worthless if nothing enforces it.** Revocations are
  enforced *before* enabled plugins start, not when the manager is opened.
- **Rendering HTML at write time cannot be repaired.** A renderer bug poisons
  every row already written. README renders on read; `readmeHtml` is deprecated
  and always `NULL`.

---

## Known gaps, stated

- **Multi-pass effects are declared, not implemented.** `effects.multipass` is a
  reserved capability; the generator still emits the single-pass uniform layout.
  Landing it moves the parameter base from 64 to 96 and requires the generator,
  the validator and the uniform-offset probe in one commit, with the probe
  re-run on real hardware.
- **A worker cannot read its own `.wasm`.** WebAssembly is allowed and `.wasm`
  is carried in the package, but the boot message does not include `binaries`.
  Embedding the module in `main.js` works; a `package.read(path)` verb is the
  fix and is not built.
- **A plugin effect does not render on the WebGL2 tier.** Now reported rather
  than silent — `effects.add` answers `{ active: false, reason }`, the manager
  says so, and `requires: ["webgpu"]` refuses the install.
- **Master→instance sync, live collaboration, and runtime fetching of
  user-supplied URLs are out of scope** — the last one deliberately and
  permanently: a plugin that can be handed an arbitrary URL has consent for
  "contact the internet" regardless of what the consent screen said.
