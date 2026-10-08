# The native plugin store

AE parity step 2 (docs/AE_PARITY_PLAN.md). Owner decisions (2026-10-06):
plugins are **free only**; the publisher sets each plugin **public or
private**; plugins **run locally** in `premation-engine`, never on a cloud
GPU. The editor is `isroil01/premation`; the registry is `isroil01/motion-back`
(`src/plugins`, `prisma/schema.prisma`). This page is the contract both follow.

## 1. The bundle

A plugin is a folder (docs/PLUGIN_SDK.md §Packaging) holding
`premation-plugin.json` and one binary per platform it supports:

```json
{
  "manifestVersion": 1,
  "id": "com.example.glow",
  "name": "Example Glow",
  "version": "1.2.0",
  "vendor": "Example",
  "sdk": { "major": 1, "minor": 0 },
  "binary": {
    "windows-x64": "glow.dll",
    "macos-universal": "libglow.dylib",
    "linux-x64": "libglow.so"
  },
  "effects": [ { "matchName": "com.example.glow", "name": "Glow", "category": "Example" } ]
}
```

**Binary keys.** The engine looks up, in order, the most specific key for the
machine it runs on, then the generic one:

| Machine | Keys tried |
|---|---|
| Windows x64 | `windows-x64`, `windows` |
| macOS arm64 | `macos-arm64`, `macos-universal`, `macos` |
| macOS x64 | `macos-x64`, `macos-universal`, `macos` |
| Linux x64 | `linux-x64`, `linux` |
| Linux arm64 | `linux-arm64`, `linux` |

## 2. The package (`.pplugin`)

`node scripts/pack-plugin.mjs <bundle-folder> [--out x.pplugin] [--key key.json]`
zips the bundle into a `.pplugin`:

- The zip holds the bundle's files at its root (`premation-plugin.json` at
  `/premation-plugin.json`), no folders above it. Paths are `/`-separated,
  relative, with no `..`, no absolute paths, no symlinks.
- The packer adds an **`integrity`** member to the manifest before zipping:
  `"integrity": { "files": { "<path>": "<sha256 hex>", ... } }` — every file
  in the package except the manifest itself. An installer refuses a package
  whose files do not match it exactly (a file missing, extra, or different).
- Limits: 2000 files, 128 MB per file, 256 MB per package.

**Signature.** `node scripts/sign-plugin.mjs keygen|sign|verify` (or
`pack-plugin --key`). The publisher signs the **raw `.pplugin` bytes**:
ECDSA P-256 with SHA-256, IEEE P1363 (r‖s, 64 bytes), base64; the public key
is SPKI DER, base64. This is the registry's existing scheme
(`motion-back/src/plugins/plugin-signature.ts`), unchanged. Because the
manifest — with its per-file and so per-platform SHA-256s — is inside the
signed bytes, the signature covers the manifest and every binary.

**Embedded signature (a double-clickable file).** `pack-plugin --key` also
puts `premation-plugin.sig` in the zip: `{ signature, publicKey }`, the same
scheme over the **exact bytes of `premation-plugin.json`**. The manifest's
`integrity` hashes every other file, so this signs the bundle, and a single
`.pplugin` carries its own proof of who made it (§4a). The member is never
in `integrity` and is not installed; the registry accepts and ignores it
(the detached signature over the whole file is what `publish` sends).

## 3. Registry (motion-back)

Existing routes keep their meaning; native packages are a second `kind` of
`PluginVersion`.

- `POST /plugins` (multipart: `file`, `signature`, `publicKey`, `backupKey?`,
  `visibility?`). The server sniffs the package: a zip whose root holds
  `premation-plugin.json` is `kind: "native"`; the old JS package is
  `kind: "js"`. For native it reads the manifest server-side (never from the
  client), checks `integrity` against the zip, and records:
  `sdkMajor`, `sdkMinor`, `effects` (match names, names, categories) and
  `artifacts: [{ platform, file, sha256, size }]` (one per `binary` key).
  Native packages may be up to 256 MB. Store ids are lowercase reverse-DNS
  (`com.example.glow`), as for JS plugins: the first segment is the
  publisher namespace.
- **One package per platform.** A version is published either as one
  package carrying every platform, or as one package per platform
  (`pack-plugin.mjs --only-present` on each OS, then `sign-plugin.mjs
  publish` each): a later publish of the same version with platforms the
  version does not have yet adds them (`PluginPackage` rows). A platform
  already published is never replaced, and every package of a version must
  declare the same SDK and effects.
- **Storage.** Package bytes go to Cloudflare R2 (S3 API) when
  `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and
  `R2_BUCKET` are set, otherwise to local disk under `UPLOAD_DIR` behind
  signed `/files` URLs. Not Postgres (`packageBytes` stays for legacy JS
  rows only) and not Cloudinary (10 MB raw cap).
- **Review policy.** Every native version is scanned (`plugin-scan.ts`):
  binary count, size, unexpected files, effects not owned by the id. A new
  version of a public native plugin whose publisher is not **verified** is
  held for review (`pending`). **No native plugin becomes public unless its
  publisher is verified**: publishing public or switching to `public` without
  verification answers 403 with `detail.code: "publisher_not_verified"`.
  Private plugins never need review to install for their owner. (JS
  packages keep their old rules; the editor no longer runs them.)
- **Visibility.** `private` means only the owner can see it in browse,
  detail, updates and download. Toggled with `PATCH /plugins/:id/listing
  { visibility }`. Enforced in `plugins.service.ts` browse, detail, download
  and updates (the existing behaviour, kept and tested for native).
- `GET /plugins?kind=native` filters browse (`&sdk=1.0` keeps only what
  that SDK loads). A caller naming only `apiVersion` is a pre-0.9 editor and
  gets JS plugins. Summaries and details carry `kind`, `sdk: {major, minor}`,
  `platforms: string[]`, `effects`.
- **Download.** `GET /plugins/:id/versions/:version/download?platform=<machine>`
  (and the owner's `/plugins/mine/:id/...`) answers, for native,
  `{ id, version, kind: "native", platforms, packageUrl, signature,
  publisherKey, sha256, size, artifacts, packages }` for the package that
  machine resolves to (§1's key order; `machine` is `windows-x64`,
  `macos-arm64`, `macos-x64`, `linux-x64` or `linux-arm64`). `packageUrl` is
  a 15-minute presigned URL to the bytes (no base64 in JSON for a 256 MB
  file); size, SHA-256 and signature are that package's own. A version with
  no build for the machine answers 404 `code: "platform_unavailable"`. JS
  versions keep `package` (base64).
- `POST /plugins/updates { installed: [{ id, version }] }` answers the newer
  approved, visible versions.
- `GET /plugins/revocations` — the signed revocation list, unchanged; the
  engine refuses a revoked plugin at start (§5).
- Free only: there is no price, licence key or payout anywhere.

## 4. Editor install (Electron main, `electron/ipc/nativePlugins.ts`)

1. The page asks main to install `{ id, version, owner?: boolean }`. Main
   fetches the download record with the user's session (so private plugins
   work for their owner) and `?platform=` for this machine, then the bytes
   from `packageUrl`.
2. Verify: size and SHA-256 equal the record; the signature verifies over the
   bytes with `publisherKey`; and `publisherKey` is the key this machine
   pinned for the id at first install (a changed key is refused with a clear
   message unless the registry reports an authorised rotation).
3. Unzip into `<userData>/native-plugins/.staging/<id>-<random>/`, rejecting
   unsafe paths, then check every file against the manifest's `integrity`
   and that the manifest's `id` and `version` equal the request.
4. Swap atomically: rename the staged folder to `<userData>/native-plugins/<id>`
   (the previous copy is renamed aside first and removed after). On Windows a
   loaded DLL cannot be replaced: the new copy waits in `.pending/<id>` and is
   swapped in at the next engine start (before `--plugins` is scanned).
5. macOS: remove `com.apple.quarantine` from the installed files (a signed
   download the user chose to install).
6. Ask the engine to `rescanPlugins` (§5): the plugin's effects are usable
   without a restart.

`<userData>/native-plugins/state.json` holds `{ plugins: { <id>: { enabled,
version, publisherKey, installedAt } }, uninstall: [ids] }`. Uninstall adds
the id to `uninstall` and disables it now; the folder is deleted at the next
start (Windows locks loaded DLLs). Enabled/disabled is applied at engine start
through `setPluginEnabled`.

## 4a. Install from a file (plan P2, `electron/pluginFileInstall.ts`)

Plugins ▸ Installed ▸ **Install from file…**, or a double-click on a
`.pplugin` (`electron-builder.yml` `fileAssociations`; Windows passes the
path in argv / `second-instance`, macOS sends `open-file`; with the app
closed it opens and then shows the dialog).

1. Main reads the file and checks it like a store download: zip, safe paths,
   `integrity` exact. Then who signed it: the embedded signature (§2), else
   a `<file>.sig` beside it, else unsigned. A signature that does not verify
   refuses the file.
2. Trust, from the store's public listing for the id (`GET /plugins/:id`):
   signed with the store's key (or its authorised next key) is a **store
   publisher** (verified or not); else signed with the key this machine
   already pinned for the id is **the same publisher as your installed
   copy**; else **unknown** (or **unsigned**).
3. The page's dialog names the plugin, version, publisher and trust, the
   effects, and what it can access (native code with the app's access). An
   unknown or unsigned package installs only through **Install anyway**
   (never on Enter); its key is pinned then, as a store install pins it.
   Refused outright: a key different from the pinned one, no build for this
   machine, a revoked plugin.
4. Install goes through the same stage → swap as §4 (`stageAndSwap`), then
   the engine rescans. The page never names a path: main holds the checked
   package behind a single-use token for ten minutes.

**Machine-wide plug-ins folder.** Vendors' own installers drop bundle
folders into `%ProgramData%\Premation\Plug-ins` (Windows),
`/Library/Application Support/Premation/Plug-ins` (macOS) or
`/usr/share/premation/plug-ins` (Linux). The engine scans it as a second
`--plugins` (and the export job too); main never writes it. The revocation
list covers its bundles by id and version like installed ones.

## 4b. Premation Cloud plugins (plan §3.2)

- A manifest may say `"entitlement": "premation-cloud"`. Only the verified
  `premation` publisher can publish such a package (403
  `tier_not_allowed`); the plugin is `tier: "cloud"` in listings and its
  download answers 402 `plan_required` unless the caller's plan includes
  Premation plugins.
- `GET /plugins/entitlement` (signed in) answers `{ plan, token, validUntil }`.
  `token` is `{ payload, signature }`: `payload` is JSON `{ v: 1, userId,
  plan: "pro", validUntil, issuedAt }` signed with the operator key (the
  revocation list's key, pinned in the app and the engine); `validUntil` is
  the paid period's end + 14 days.
- Main refreshes it at start, at sign-in and every 24 h, verifies it, keeps
  it as `<userData>/native-plugins/entitlement.json` and deletes it at
  sign-out. A plan without Premation plugins keeps the token already here
  (it runs to its own end); offline changes nothing.
- The engine gets `--entitlement <file>` (export jobs: `pluginEntitlement`)
  and checks the signature and `validUntil` before opening such a bundle.
  Without a valid token the plugin is `locked`: never loaded, its effects
  pass through with "requires Premation Cloud" on `layerErrors`, the project
  keeps every value, and renewing (then restarting) brings it back.

## 5. Engine

- `rescanPlugins` (command, `70_jobs.eapi`): rescans the plugin folders and
  answers the plugin list; new bundles load at once. A plugin already loaded
  stays loaded until the engine restarts (a module cannot be swapped under live
  instances), so an update or uninstall applies at the next start; the editor
  says so.
- `--plugin-disabled <id>` (repeatable): listed `disabled`, not loaded — none
  of its code runs until `setPluginEnabled` turns it on.
- `listEffects` carries a plugin effect's buttons (`actions`) and param
  precision; the editor builds its effect cards from it
  (`src/core/inspector/pluginEffectDefs.ts`), honours `getEffectUi`
  (hidden / renamed / disabled params) and runs buttons with
  `invokeEffectAction`.
- Export: the export job starts its own plugin host over the same folders,
  disabled set and revocations (job fields `plugins`, `pluginDisabled`,
  `pluginRevoked`, written by `electron/engineExport.ts` for the app's export
  queue and the CLI), so plugin effects render in exports. Server renders
  are refused before submission when the project uses plugin effects, naming
  the plugins (`src/layout/Export/cloudRender.ts`).
- Revocation: Electron fetches the signed list at start (public, no session),
  verifies it with the operator key pinned in the app, keeps the newest, and
  hands the engine the installed plugins it hits at every launch
  (`--revoked <file>`); a listed plugin is reported `revoked` and never
  loaded. A versioned entry only hits that version.

## 6. Tooling and the SDK artifact

- `scripts/pack-plugin.mjs` / `scripts/sign-plugin.mjs` (also in the SDK at
  `share/premation-sdk/`): pack (deterministic), keygen, sign, verify,
  publish. `--only-present` packs a one-OS build.
- A release attaches `premation-sdk-<platform>.zip` (Windows x64, macOS arm64,
  macOS x64, Linux x64): headers, `find_package(PremationSdk)` with
  `premation_add_plugin()`, `bin/premation-plugins`, the samples and the tools
  (`.github/workflows/release.yml`, `cmake --install … --component sdk`).
- `examples/plugin-ci/` is a complete plugin repository: an example effect and
  a workflow that builds three platforms against the SDK, merges them, packs,
  signs and publishes on a tag.
