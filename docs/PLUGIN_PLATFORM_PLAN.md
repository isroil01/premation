# Plugin platform plan: deep plugins, easy installs, Premation plugins in the paid plan

Status: **approved 2026-10-08** (all four decisions: the recommendations). Builds on docs/PLUGIN_SDK.md (the SDK as it
is), docs/PLUGIN_STORE.md (store contract) and docs/AE_PARITY_PLAN.md step 2.
Decisions marked **(decided)** were made by the owner on 2026-10-08.

## 0. Goals

1. A user installs a plugin the way they do in After Effects, or easier:
   one click in Dashboard ▸ Plugins, or double-click a downloaded file. They
   never see code: a plugin is a compiled, signed bundle.
2. The SDK can carry the deep plugin class: Particular, Element 3D, Optical
   Flares, Plexus, Saber.
3. Premation publishes its own plugins in the store. They are included in the
   paid plan.
4. **Every plugin runs on the user's computer**, in `premation-engine`, on
   their GPU. No plugin ever needs a cloud GPU, so plugins cost us storage and
   download bandwidth only.

## 1. Where we are (2026-10-08)

| Part | State |
|---|---|
| SDK (AE-style selectors, smart render, Dawn GPU, 8/16/32 bpc, crash isolation) | done |
| Editor store UI, install in main (hash + signature + pinned key, atomic swap), rescan with no restart | done |
| Backend native plugins (`kind`, platforms, per-platform binaries) | **missing**, so the store lists nothing |
| Install from a file / double-click / machine-wide plug-ins folder | **missing** |
| Camera + lights, viewer overlays, custom UI, more param types | **missing** |
| Paid plugins | not possible (store is free only, decided 2026-10-06) |

Package bytes live in Postgres (`PluginVersion.packageBytes`). That is fine for
small JS plugins and wrong for native binaries (tens of MB × 3 platforms ×
versions on a $20/mo Railway database).

## 2. Phases

Each phase ships on its own and has its own gate. The order follows what each
phase unlocks for the next.

### P1 — The store works end to end

Lets every later phase be delivered to users.

**Status (2026-10-08):** built — motion-back branch `plugin-platform`
(native reader, `PluginPackage`, R2 / local package store, `?kind=`,
`?platform=` download record, verified-publisher policy) and the editor
(`?platform=` on install, client `kind` filter removed). The gate below runs
on the test machine (docs/VERIFY_ON_TEST_MACHINE.md).

- **Backend (motion-back):**
  - Read `premation-plugin.json` in `plugin-package.ts`.
  - Add `PluginVersion.kind` (`js` | `native`), `sdk`, `platforms` and
    `effects`.
  - Filter `GET /plugins` on `kind`.
  - Return the `DownloadRecord` (`packageUrl`, `signature`, `sha256`, `size`)
    the editor already expects.
  - Add a review policy for native binaries in `plugin-scan.ts`.
- **Package storage:** move packages out of Postgres into **Cloudflare R2**,
  with local disk in dev and when self-hosting.
  - Not Cloudinary: our plan caps raw files at 10 MB (checked 2026-10-08),
    and a native plugin with assets passes that. Cloudinary keeps AI assets.
  - R2 has no egress fees, and its free tier (10 GB) covers the store at our
    size.
  - Downloads are short-lived presigned URLs (S3 API). Paid plugins are
    signed only for entitled users, so a shared link expires.
  - Env: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
    `R2_BUCKET`. Without them, the local-disk driver is used.
  - Keep `packageBytes` only for legacy JS rows.
- **One package per platform.** A version holds one `.pplugin` per platform
  key (`windows-x64`, `macos-universal`, `linux-x64`). The download record
  picks the package for the requesting machine, so users download only their
  own binary, at about a third of the size.
  - The editor checks SHA-256 and the publisher signature on every install,
    so the storage host never has to be trusted.
- **Editor:**
  - Remove the client-side `kind` filter added on 2026-10-08 once the backend
    filters. The normaliser stays.
  - Regenerate `backend-routes.txt` (the cross-repo route gate).
- **Gate:**
  - Publish the `grade` sample with `sign-plugin.mjs publish`, then install it
    from the Store tab on Windows and macOS.
  - The effect appears in the Effects panel with no restart.
  - Export renders it.

### P2 — Install like After Effects: file, double-click, vendor installers

**Status (2026-10-08):** built — `electron/pluginFileInstall.ts`, the
`.pplugin` file association, `InstallPackageDialog.tsx`, the machine-wide
folder in the engine and export arguments, and a signature embedded by
`pack-plugin --key` so a single file proves its publisher
(docs/PLUGIN_STORE.md §2, §4a). The gate runs on the test machine.

- **`.pplugin` file association** (`electron-builder.yml` `fileAssociations`):
  - Double-clicking opens Premation, or reaches the running copy through
    `second-instance` / `open-file`.
  - The install confirm dialog names the publisher, the version, whether the
    plugin is verified, and what it can access.
  - The install then goes through the same verify → stage → swap path as a
    store install.
- **Plugins ▸ Installed ▸ "Install from file…"**, the same flow without the
  double-click.
- **Unknown publishers:** a package not signed by a store publisher installs
  only after an explicit "Install anyway". Its key is pinned on that first
  install, as for store installs.
- **Machine-wide plug-ins folder**, where vendors' own `.exe`/`.pkg`
  installers drop bundles (AE's `MediaCore` equivalent). The engine scans it
  beside `<userData>/native-plugins`:
  - Windows: `%ProgramData%\Premation\Plug-ins`
  - macOS: `/Library/Application Support/Premation/Plug-ins`
  - Linux: `/usr/share/premation/plug-ins`
- **Gate:**
  - Double-click a `.pplugin` with the app closed, and again with it open.
  - A tampered package is refused.
  - A bundle copied into the machine folder shows up after Rescan.

### P3 — Paid plan: Premation plugins

**Status (2026-10-08):** built — registry (`Plugin.tier` from the manifest's
`entitlement`, verified `premation` publisher only; 402 `plan_required`;
`GET /plugins/entitlement` signed with the operator key), Electron main
(token refresh at start / sign-in / 24 h, verified with the pinned key, kept
as `native-plugins/entitlement.json`, dropped at sign-out, passed as
`--entitlement` and the export job's `pluginEntitlement`), the engine
(`plugins/entitlement.cpp`: a self-contained ECDSA P-256 check before the
bundle loads; `locked` status; the frame says "requires Premation Cloud"),
and the editor (store badge, locked rows with "Check plan", the open notice).

See §3 for the design. In order:
- backend tier + download gating;
- entitlement token;
- engine check;
- editor locked state;
- the first Premation plugin published.

### P4 — SDK 1.1: camera, lights, comp

**Status (2026-10-08):** built — `pr_scene.h`, the three callbacks appended
to `PrHostSuite`, `PR_OUT_FLAG_USES_CAMERA / _LIGHTS / _LAYER_TRANSFORMS`, the
scene written into the chain entry by `finish_native_frame` (`fx_wire`
encode/decode), and the open `particles` sample, tested on the CPU host
(`tests/test_plugin_scene.cpp`). The orbiting-camera golden render test runs
on the GPU machine (docs/VERIFY_ON_TEST_MACHINE.md).

The biggest unlock for deep plugins. Callbacks are **appended** to
`PrHostSuite`, so SDK 1.0 plugins keep loading.

- `get_comp_camera(host, time, PrCamera*)`:
  - world matrix, zoom/FOV, film size;
  - depth of field (focus distance, aperture);
  - "no camera" means the comp's default view.
- `get_comp_lights(host, time, PrLight* out, count)`: type, colour,
  intensity, cone, falloff, shadows.
- `get_layer_transform(host, param_index, time, double m[16])`: a `LAYER`
  param's 3D world matrix. Emitters and Plexus vertices need it.
- **How it's evaluated:**
  - The engine evaluates all of these at the frame time.
  - The frame stays a pure function of the document.
  - `scene_finish` treats a plugin that reads the camera as depending on it,
    so moving the camera re-renders the effect.
- **Gate:**
  - New `particles` sample: a 3D emitter rendered through the comp camera.
  - A golden render test that orbits the camera.

### P5 — Viewer interaction and plugin UI

**Status (2026-10-08):** built — `PR_CMD_DRAW_OVERLAY` / `PR_CMD_OVERLAY_DRAG`,
`PR_OUT_FLAG_CUSTOM_OVERLAY`, the `overlay_line / _path / _handle` callbacks,
the `plugin` overlay kind (`overlay_geometry.cpp`), `dragEffectOverlay` (a
gesture = one entry) and the editor's `PluginOverlay`; panels as
`plugin-ui://<id>/` (electron/pluginPanelProtocol.ts: `ui/` only, strict CSP,
no navigation out) in a `sandbox="allow-scripts"` frame on the effect card,
the message API in `src/core/nativePlugins/pluginPanel.ts`, and
`PrUserChangedParamExtra.payload` for a panel's button data. Gate met on the
headless engine (`pluginPanel.native.test`); the in-app checks are in
docs/VERIFY_ON_TEST_MACHINE.md.

- **Viewer overlays** (AE's `PF_Cmd_EVENT` draw / click / drag):
  - A new `PR_CMD_DRAW_OVERLAY` selector returns a draw list: lines, handles,
    paths, in layer space.
  - The engine turns the list into overlay geometry, beside
    `overlay_geometry.cpp`.
  - The editor draws it the way it draws masks today.
  - A drag on a handle sends `PR_CMD_OVERLAY_DRAG`, which writes params
    through `set_param_value`, one undo entry per drag.
  - No plugin code runs in the UI process (CLAUDE.md).
- **Plugin panel** (Optical Flares' editor, Element 3D's scene setup,
  Looks):
  - A bundle may ship `ui/index.html`.
  - The editor shows it in a sandboxed iframe: no Node, no network,
    `connect-src 'none'`.
  - The panel talks to the engine only through a small message API:
    read/write params, set arbitrary data, invoke a button, request a preview
    frame.
  - The panel never draws the render; the engine does.
- **Gate:**
  - The `rings` sample gets a draggable centre handle and a panel that edits
    its palette.
  - Undo and redo restore both the handle position and the palette.

### P6 — More parameter types and assets

**Status (2026-10-08):** built — `PR_PARAM_STRING / CURVE / GRADIENT / FILE`
(SDK 1.1 fields at the end of `PrParamDef`), `get_asset_path` /
`get_asset_bytes`, `importFiles` `asData` (a `data` item: relink, collect,
Remove Unused and save carry it; `layers_using_item` counts FILE params),
the chain entry's resolved file and the "file is missing" layer error
(`scene_finish.cpp`), `EffectParamInfo.kind` / `fileTypes`, the editor's text,
gradient and file controls (curves reuse the Curves editor), and the
`grademap` sample. Tested on the CPU host (`tests/test_plugin_params.cpp`) and
the headless engine (`pluginParams.native.test`); the render-side checks are in
docs/VERIFY_ON_TEST_MACHINE.md.

- New param types:
  - `STRING` (multi-line text);
  - `CURVE` (AE Curves-style points);
  - `GRADIENT` (stops);
  - `FILE` (a project asset reference: a model, a LUT, a texture).
- `FILE` params go through the asset system, so collect, relink and save
  carry them, and a missing file is a `layerErrors` entry, not a crash.
- `get_asset_bytes` / `get_asset_path` callbacks.

### P7 — Non-effect plugins (later, own plan)

Importers and exporters, panels without an effect, menu commands. Not needed
for the paid-plan launch.

## 3. Premation plugins in the paid plan

### 3.1 What is sold

**(decided)** Third-party plugins stay free (2026-10-06 decision unchanged).
Only plugins published by Premation's own verified publisher (`premation`) can
be marked **Included with Premation Cloud**. Selling third-party plugins needs
payouts, tax and refunds per vendor, which is a separate project.

### 3.2 Gating: download, plus a signed entitlement checked locally

The binary runs locally, so we cannot keep it from a determined copier. No AE
vendor can either. The aim is that paying is the easy path and lapsing is
honest, never that the plugin is uncrackable.

1. **Download gate (server).**
   - `Plugin.tier = 'cloud'`.
   - `GET /plugins/:id/versions/:v/download` returns the signed package URL
     only to a user whose entitlement includes `pro`.
   - Everyone else gets `402 plan_required`; the Store shows
     "Included with Premation Cloud — Upgrade".
2. **Entitlement token (server → main).**
   - The backend signs a token with the operator key, the same pinned key as
     the revocation list (`OPERATOR_PUBLIC_KEY`):
     `{ userId, plan: 'pro', validUntil: periodEnd + 14 days, issuedAt }`.
   - Main refreshes it on sign-in, every app start and every 24 h while
     online, and stores it next to `state.json`.
   - Offline use works until `validUntil`.
3. **Load check (engine).**
   - A manifest may say `"entitlement": "premation-cloud"`.
   - Main passes the token to the engine with the plugin dirs.
   - The engine's plugin host verifies the signature and the expiry **before**
     loading such a bundle. This is C++ in our process; the plugin itself
     needs no licence code.
   - With no valid token the plugin is listed as `locked`, and its effects are
     not added.
4. **Lapsed subscription: never data loss.**
   - A project that uses a locked plugin opens normally.
   - The effect keeps all its params and data, renders as pass-through, and is
     recorded on `layerErrors` as "Requires Premation Cloud". This is the
     existing missing-plugin path (`missingPluginContent.ts`).
   - Renewing brings it back exactly as it was.

### 3.3 No cloud GPUs

- Preview and export run locally with the plugin, like every other effect.
- The cloud render worker keeps refusing plugin effects with a clear message
  ("This project uses plugins — render it in the desktop app"). That refusal
  already exists in the step-2 plan. Plugins never become a cloud GPU cost.
- **Our only plugin cost is storage.** R2 does not charge for downloads.

### 3.4 Publishing our own plugins

- They are built in CI from a private repo (or `examples/plugin-ci/`):
  Windows, macOS universal, Linux.
- They are signed with Premation's plugin key, which is held offline. A
  backup key is authorised at first publish, as the store requires.
- They are published with `sign-plugin.mjs publish` and `tier=cloud`.
- Updates reach users through the existing `POST /plugins/updates` check.

### 3.5 Pricing and positioning

**(decided)** Premation Cloud is $9/mo for hosting today. Adding plugins makes
it "hosting + Premation plugins". Decided: keep one paid plan and one
price; add "Premation plugins" to the plan card, Billing and `/pricing`.

**(decided)** The landing page says "free, open-source AE alternative". Closed,
paid plugins sit beside that. Decided: the editor, the engine and the
SDK stay open source and free; Premation's own plugins are closed add-ons, said
plainly on `/pricing`, the way Blender's ecosystem works.

### 3.6 First Premation plugins

Built on P4/P5, so each one also exercises the SDK:

1. **Particles** (Particular-class): needs P4.
2. **Light flares** (Optical Flares-class): needs P4 + P5 overlays.
3. **Energy / Saber-class stroke glow**: SDK 1.0 already suffices, so it can
   ship first, right after P3.

## 4. Order and sizing

| # | Phase | Repos | Size |
|---|---|---|---|
| 1 | P1 store end to end + R2, per-platform packages | back, editor | M |
| 2 | P2 file / double-click / machine folder | editor | S–M |
| 3 | P3 paid tier + entitlement + engine check | back, editor, native | M |
| 4 | First Premation plugin (Saber-class) | plugin repo | M |
| 5 | P4 camera / lights / layer transforms | native, SDK | M |
| 6 | Particles plugin | plugin repo | L |
| 7 | P5 overlays + plugin panel | native, editor | L |
| 8 | P6 params + assets | native, editor | M |
| 9 | P7 non-effect plugins | — | later |

Every native phase runs the golden render tests and the plugin host tests
(`engine_plugins_tests`, `engine_plugins_gpu_tests`). Every backend phase runs
the motion-back suite and refreshes `backend-routes.txt`.
