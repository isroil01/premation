# Premation native plugin SDK

Plan step G1 (`docs/NATIVE_CORE_PLAN.md` §5). The owner decided on 2026-09-22 (G2)
that the JavaScript/WGSL plugin system is **not** ported. Native plugins built
against this SDK are the C++ engine's plugin system. The API is modelled on the
After Effects effect API. The table below maps each part to its AE counterpart,
so an AE plugin author can find their way around.

| | |
|---|---|
| Headers | `native/sdk/include/premation_sdk/` (C, versioned ABI; `premation_sdk.h` includes all) |
| Samples | `native/sdk/samples/` — `ripple` (CPU), `rings` (generator + sequence data + button), `checkout` (Layer Displace, Time Echo), `grade` (GPU), `particles` (SDK 1.1: comp camera, lights, layer transforms) |
| Host | `native/engine/src/plugins/` (runs inside `premation-engine`) |
| Tool | `premation-plugins` — list, render, crash-check a plugin folder without an editor |
| Tests | `engine_plugins_tests` (`tests/test_plugin_host.cpp`, `tests/test_plugin_session.cpp`, `tests/test_plugin_scene.cpp`, `tests/test_plugin_entitlement.cpp`) |

## Packaging

A plugin is a **bundle**: a folder that holds `premation-plugin.json` and the
binary it names for each platform.

```json
{
  "manifestVersion": 1,
  "id": "com.example.glow",
  "name": "Example Glow",
  "version": "1.2.0",
  "vendor": "Example",
  "sdk": { "major": 1, "minor": 0 },
  "binary": { "windows": "glow.dll", "macos": "libglow.dylib", "linux": "libglow.so" },
  "effects": [ { "matchName": "com.example.glow", "name": "Glow", "category": "Example" } ]
}
```

- The manifest is read and version-checked **before** the binary is loaded. A
  malformed manifest, a missing binary or an incompatible SDK leaves the plugin
  listed as `failed` with the reason, and none of its code has run.
- Ids are 1–100 characters from `[A-Za-z0-9._-]` and start with a letter. An
  effect's match name is `<id>` or `<id>.<name>`. That keeps match names unique
  across plugins and apart from built-in effect types.
- SDK compatibility: the plugin's major must equal the host's major, and its
  minor must be ≤ the host's minor.
- The engine scans every folder passed with `--plugins` (Electron passes
  `<userData>/native-plugins`) plus every folder in `PREMATION_PLUGIN_PATH`
  (`;`-separated). Each folder may be a bundle itself or a folder of bundles.
  Load order is sorted, so it is deterministic.

The module exports one symbol:

```c
PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void);
```

It lists the module's effects, each with its own entry point
`PrErr EffectMain(PrCmd, const PrInData*, PrOutData*, PrParamDef* const*, PrWorld*, void* extra)`.
The plugin id and the match names must match the manifest.

## Selectors (`pr_effect.h`)

| Premation | After Effects | What the plugin does |
|---|---|---|
| `ABOUT` | `PF_Cmd_ABOUT` | text into `return_msg` |
| `GLOBAL_SETUP` / `_SETDOWN` | same | out flags, version, `global_data` |
| `PARAMS_SETUP` | same | `add_param` for each parameter, in order |
| `SEQUENCE_SETUP` / `_RESETUP` / `_FLATTEN` / `_SETDOWN` | same | per-instance state; FLATTEN hands back the pointer-free bytes the project stores |
| `FRAME_SETUP` / `RENDER` / `FRAME_SETDOWN` | same | non-smart render: `params[0]->world` → `output` |
| `SMART_PRE_RENDER` / `SMART_RENDER` | same | `checkout_layer` in pre-render, `checkout_layer_pixels` / `checkout_output` in render |
| `USER_CHANGED_PARAM` | same | a button, or a param flagged `SUPERVISE`; may `set_param_value` / `set_arb_data` and change sequence data |
| `UPDATE_PARAMS_UI` | same | `set_param_ui` (enable / hide / rename) |
| `GPU_DEVICE_SETUP` / `_SETDOWN`, `SMART_RENDER_GPU` | `PF_Cmd_GPU_DEVICE_SETUP`, `PF_Cmd_SMART_RENDER_GPU` | Dawn/WebGPU on the engine's own device (see GPU) |
| `DRAW_OVERLAY` / `OVERLAY_DRAG` (1.1) | `PF_Cmd_EVENT` (draw / drag) | the viewer overlay (see Viewer overlays) |

Out flags: `DEEP_COLOR_AWARE` (16-bit), `FLOAT_COLOR_AWARE` (32-bit float),
`SMART_RENDER`, `GPU_RENDER`, `SEQUENCE_DATA`, `GENERATOR`, `WIDE_TIME_INPUT`,
`NON_PARAM_VARY`, `SEND_UPDATE_PARAMS_UI`, `THREADED_RENDER`.

## Parameters (`pr_params.h`)

Params are declared, and the engine keyframes and evaluates them. At every
render the plugin receives each param's value at the frame's time; it never
interpolates anything itself. In the document each param is an ordinary effect
property under `effects/<id>/p<paramId>`, so undo, keyframes, expressions,
copy/paste, save/open and change events all work as they do for a builtin.

| Param | Document property |
|---|---|
| `SLIDER`, `FLOAT_SLIDER`, `ANGLE` | number (angle in °, valid range → min/max) |
| `POINT`, `POINT_3D` | numbers `p<id>X`, `p<id>Y` (`p<id>Z`), layer px from the layer centre; the plugin gets layer pixels |
| `COLOR` | colour (straight RGBA 0..1 to the plugin) |
| `POPUP` | choice, 1-based |
| `CHECKBOX` | bool |
| `LAYER` | a layer reference (id, `""` = none) |
| `PATH` | a mask of the layer (its bezier at the frame time, 6 doubles per vertex) |
| `ARBITRARY_DATA` | bytes in the document (`fx.pluginData`), written by the plugin or `setPluginData` |
| `BUTTON` | an action (`invokeEffectAction`, `p<id>`) |
| `GROUP_START` / `GROUP_END` | a twirl-down section |
| `STRING` (1.1) | text (`text`; a multi-line field) |
| `CURVE` (1.1) | the Curves effect's point list `[[x, y]…]` in 0..255; the plugin gets `curve` / `curve_count`, x, y in 0..1 |
| `GRADIENT` (1.1) | stops `[[position, r, g, b, a]…]` in 0..1; the plugin gets `gradient` / `gradient_count` |
| `FILE` (1.1) | a project item id (`file_types` filters the picker); the plugin gets `file_name`, `file_missing` and the file through `get_asset_path` / `get_asset_bytes` |

Flags: `CANNOT_ANIMATE`, `SUPERVISE`, `HIDDEN`, `START_COLLAPSED`, `DISABLED`.

The SDK 1.1 types are never keyframed. Their defaults go in the fields at the end
of `PrParamDef` (`text`, `curve`, `gradient`, `file_types`); an SDK 1.0 struct
cannot declare them (the plugin fails to load with "needs SDK 1.1").

A `FILE` param's value is a **project item**: the editor's **Choose…** imports
the file as a `data` item (`importFiles` with `asData`: never probed as
footage), so Collect Files copies it, Relink re-points it, Remove Unused keeps
it while an effect uses it, and the project saves it. At render the engine
resolves the item to a file (`p.<key>.path`, `.missing` in the chain entry), so
a relink re-renders the effect. A missing file never fails the frame: the
plugin sees `file_missing = 1` and `get_asset_*` answer `PR_ERR_NOT_FOUND`,
and the layer reports "file '…' is missing" on `layerErrors`.
`get_asset_bytes` reads the file once per call (≤ 512 MiB). The `grademap`
sample uses all four types (a 1D `.cube` LUT as its FILE).

## Pixels (`pr_world.h`)

- Worlds are full-frame, premultiplied, in the linear working space, at the size
  of the chain's buffer. `in_data->layer_to_world` maps layer pixels to world
  pixels. Scale pixel-sized params by `pixel_scale_x/y`.
- Depth follows AE's down-conversion (`PluginHost::world_format`). A 32-bpc
  project gives `FLOAT_COLOR_AWARE` effects `RGBA32F`, `DEEP_COLOR_AWARE`
  effects `RGBA16` and every other effect `RGBA8`; 16-bpc and 8-bpc projects
  work the same way. The host converts with pure functions (`world_convert.hpp`):
  round-half-away for the integer depths and round-to-nearest-even for half
  floats. The same frame always converts to the same bytes.
- `iterate(count, fn)` runs `fn` for each row on the host's worker pool. Each job
  is crash-guarded.

## Time and checkouts

Times are integer ticks of `PR_TIME_SCALE` (705,600,000 per second, flicks).
`current_time` is the **layer** time; `comp_time` is the composition time.
`SMART_PRE_RENDER` may check out:

- the effect's input (param index 0) at the current time, which is the chain's
  buffer;
- another layer (a `LAYER` param), or its own layer at another time
  (`WIDE_TIME_INPUT`).

The engine resolves checkouts from the frame itself. For each checkout at
another time, `finish_native_frame` (`scene_finish.cpp`) builds that layer at
that time and adds it as a hidden renderable `<layer>@<flicks>`. A frame stays a
pure function of the document: preview, export and a restarted engine render
the same pixels.

## The comp camera and lights (SDK 1.1, `pr_scene.h`)

AE's `PF_Cmd`-era plugins read the comp camera and lights through
`AEGP_GetEffectCamera` / `AEGP_GetLayerToWorldXform`; Particular, Element 3D,
Plexus and Optical Flares are built on them. SDK 1.1 appends three host
callbacks to `PrHostSuite` (an SDK 1.0 plugin never reads past the old end; a
1.1 plugin checks `struct_size` first, see the `particles` sample):

| Callback | Gives |
|---|---|
| `get_comp_camera(host, time, PrCamera*)` | camera → world and world → camera matrices, the projection (camera → comp px), eye, zoom, vertical FOV, film size, depth of field (focus distance, aperture). `has_camera = 0`: the comp's default view (After Effects' default camera, centred). |
| `get_comp_lights(host, time, PrLight*, capacity, &count)` | every comp light: type, colour, intensity, position, direction, cone, falloff, shadows (≤ `PR_MAX_LIGHTS`). |
| `get_layer_transform(host, param_index, time, double m[16])` | a `LAYER` param's world matrix (layer px → comp world px; a 2D layer at z = 0). |

- **Declare what you read** in `GLOBAL_SETUP`: `PR_OUT_FLAG_USES_CAMERA`,
  `PR_OUT_FLAG_USES_LIGHTS`, `PR_OUT_FLAG_USES_LAYER_TRANSFORMS`. Without the
  flag the callback answers `PR_ERR_INVALID_CALLBACK`.
- **Evaluated at the frame time** (`time` = `current_time`; another time
  answers `PR_ERR_UNSUPPORTED`). `finish_native_frame` writes them from the
  built frame into the effect's chain entry (`fx_wire.hpp`), so they are
  inputs of that effect's render: moving the camera re-renders an effect that
  reads it, and no other. The frame stays a pure function of the document.
- World space is After Effects': pixels, +x right, +y down, +z away from the
  viewer, matrices column-major.
- The manifest says `"sdk": { "major": 1, "minor": 1 }`; an engine with SDK
  1.0 lists such a plugin as failed ("needs SDK 1.1") instead of loading it.

## Viewer overlays (SDK 1.1)

AE's `PF_Cmd_EVENT` draw / click / drag, without plugin code in the UI
process. Declare `PR_OUT_FLAG_CUSTOM_OVERLAY` in `GLOBAL_SETUP`, then:

- `PR_CMD_DRAW_OVERLAY` (`PrOverlayExtra`: the layer size): call
  `overlay_line`, `overlay_path` and `overlay_handle` with layer-pixel
  coordinates. The params are the effect's values at the viewer's time. The
  engine runs this when it builds overlay geometry (`overlay_geometry.cpp`);
  the editor maps the list with the layer, as it maps a mask. Limits: 256
  items, 2048 points per call, 192 per path; extra items are dropped.
- `PR_CMD_OVERLAY_DRAG` (`PrOverlayDragExtra`: handle id, phase
  `BEGIN`/`MOVE`/`END`, pointer and start in layer px): write params with
  `set_param_value` (an animated param keys at the current time) or
  `set_arb_data`. The editor sends `dragEffectOverlay`; begin → end is **one**
  undo entry.
- A plugin that crashes while drawing draws nothing; the frame still renders.

The `rings` sample draws its three rings and a crosshair at its centre; dragging
the crosshair moves `Center`.

## Plugin panels (SDK 1.1)

Optical Flares' editor or Element 3D's scene setup, without plugin code in the
editor: a bundle may ship `ui/index.html` (and its scripts, styles, images and
fonts beside it in `ui/`). The effect card then shows **Open Panel**, and the
editor shows the page in a frame:

- served by the app as `plugin-ui://<plugin id>/…` from the bundle's `ui/`
  folder only (no `..`, hidden files or symlinks out);
- `sandbox="allow-scripts"`: an opaque origin, no Node, no storage, no popups,
  no navigation out of the bundle;
- under its own policy: `default-src 'none'`, scripts/styles/images/fonts from
  the bundle, `connect-src 'none'` — no network at all.

The panel talks to the editor with `window.parent.postMessage({ premation: 1, … }, '*')`:

| Panel sends | What happens |
|---|---|
| `{ type: 'ready' }` | the editor answers with `state` |
| `{ id, type: 'setParam', key: 'p2', value }` | `setProperty` on the param (a number, a checkbox, `{ r, g, b, a }`; a point is `p<id>X` / `p<id>Y`); an animated param keys at the current time |
| `{ id, type: 'setArbitraryData', key: 'p3', data: '<base64>' }` | `setPluginData`: an ARBITRARY_DATA param's bytes (≤ 256 KiB) |
| `{ id, type: 'invokeButton', key: 'p9', payload? }` | `invokeEffectAction`: `USER_CHANGED_PARAM` with `PrUserChangedParamExtra.payload` (UTF-8, ≤ 64 KiB) — a hidden button (`PR_PARAM_FLAG_HIDDEN`) is how a panel hands the plugin data for its sequence data |
| `{ id, type: 'requestPreview', maxSize? }` | the engine renders the layer at the current time; the reply carries `image` (a PNG data URL). The panel never renders. |

The editor sends `{ type: 'state', effect, plugin, time, params, values, data }`
on `ready` and after every document change (undo and redo too): `params` as
the plugin shows them, `values` the effect's stored values, `data` the
sequence data (`sequence`) and arbitrary-data params, base64. Each request gets
`{ type: 'reply', id, ok, error?, image? }`. Every edit is an ordinary engine
command: one undo entry, saved with the project, in the command log.

The `rings` panel reads its palette from the sequence data and applies an
edited one through the hidden **Set Palette** button (`#rrggbb` colours as the
payload).

## Sequence data

Per-instance state lives **in the document**, not only in the process:

- `addEffect` runs SEQUENCE_SETUP → FLATTEN → SETDOWN and stores the flat bytes
  with the effect, in the same undo entry.
- A render rebuilds the instance from those bytes (RESETUP) whenever they change.
- A button (`USER_CHANGED_PARAM`) produces new bytes plus param writes as **one**
  undo entry. Undo brings back the old bytes, and the old bytes render the old
  picture.

This is how `rings` keeps its palette: shuffle, undo and redo all render exactly.

## GPU (`pr_gpu.h`)

A `GPU_RENDER` effect records WebGPU commands into the **host's** command
encoder, on the engine's own Dawn device:

- The input is the chain's texture as is; the output is a texture the host owns
  (render attachment, storage, sampled, copy). Nothing is copied or read back.
- Call WebGPU through `device->procs` (Dawn's `DawnProcTable`). Never link a
  second copy of Dawn.
- The call runs inside a crash guard **and** a validation + out-of-memory error
  scope. A GPU error drops the command buffer unsubmitted, and the effect renders
  on its CPU path for that frame.
- `GPU_DEVICE_SETUP` runs once per device. If it fails, the effect uses its CPU
  path on that device. When the engine's device changes (a new renderer, a
  recovered device loss), the host sends `GPU_DEVICE_SETDOWN` for the old one
  first and sets up again on the next frame.
- Keep the GPU and CPU paths the same maths. At 16 bpc they can still differ on
  over-range values: the CPU world is integer 0..32768 and clips, the GPU buffer
  is half float and does not. `grade`'s *Debug ▸ GPU Fault* records invalid
  commands, so you can watch the error scope and the CPU fallback work
  (`engine_plugins_gpu_tests`).
- `premation-render --plugins <dir> [--plugin-gpu 0]` renders a FrameScene with
  native plugin entries outside the editor. Use `--plugin-gpu 0` to force the
  CPU path.

## Crash isolation

Every selector call runs through a guard (`guard_ffi.cpp`: SEH on Windows;
SIGSEGV/SIGBUS/SIGFPE/SIGILL on an alternate stack on POSIX) and the crash journal:

| What the plugin does | What happens |
|---|---|
| access violation, divide by zero, stack overflow*, illegal instruction, a C++ exception, in a render selector | That **instance** is disabled: the layer renders as if the effect were off, and the failure is on `layerErrors`. The process, the frame and every other layer and instance continue. |
| the same in setup, params or sequence selectors | The **plugin** fails to load; it is listed as `failed` with the reason |
| returns an error | The call fails and the frame renders without it; the instance stays enabled |
| hangs (longer than the watchdog, default 10 s) | The plugin is quarantined in the journal and the engine ends; the supervisor restarts it and replays the document |
| `abort()`, `exit()`, heap corruption that does not fault | The engine dies. The journal's in-flight slot survives in the mapped file, and the next start **quarantines** the plugin (AE's "this plugin crashed last time") |

\* On POSIX a stack overflow is reported as an access violation (both are SIGSEGV).

A quarantined plugin is listed but not loaded. `setPluginEnabled(true)` retries
it and clears the quarantine.

## Engine API

| | |
|---|---|
| `listPlugins` | every plugin found: loaded / disabled / failed (with why) / quarantined |
| `listEffects` | plugin effects beside the builtins, `provider` = the plugin id |
| `addEffect` | a plugin effect by match name (its initial sequence data lands in the same entry); a disabled plugin's effect is `notFound` |
| `invokeEffectAction` | a button or supervised param change: one undo entry |
| `getEffectUi` | the param UI state (UPDATE_PARAMS_UI) at a time |
| `setPluginEnabled` | enable / disable for this session; re-enabling retries a failed or quarantined plugin |
| `setPluginData` | write a plugin's document data (arbitrary-data params) |

The C++ engine is the only engine (the TypeScript one is deleted), so these
queries always answer from `premation-engine`. Native plugins render in the
engine viewport and in `premation-plugins` today. The editor surfaces that
expose them — installing from the plugin store, the Effects panel and Add
menu, the Properties effect cards built from `EffectInfo.params`, and export
with plugins — are AE parity step 2 (docs/AE_PARITY_PLAN.md). A project whose
plugin is missing keeps the effect untouched: it passes through, is recorded
on `layerErrors`, and one notice names the missing plugin
(`src/core/project/missingPluginContent.ts`).

## Distributing a plugin

Plugins are distributed through the plugin store (docs/PLUGIN_STORE.md): free,
public or private (private installs only for its publisher), and installed by
the editor with a signature check and no restart.

1. Build against the SDK from a release (`premation-sdk-<platform>.zip`):
   `find_package(PremationSdk)` and `premation_add_plugin(name SOURCES …
   MANIFEST premation-plugin.json)` lay the bundle out under
   `<build>/plugins/<name>/`.
2. List platform-specific binaries under `binary` with the keys
   `windows-x64`, `macos-universal` (or `macos-arm64` / `macos-x64`),
   `linux-x64` (the plain `windows` / `macos` / `linux` keys still work).
3. `node pack-plugin.mjs <bundle> --key plugin-key.json` (keygen once with
   `sign-plugin.mjs keygen`, and keep the key: it is the only thing that can
   ship an update) → `<id>-<version>.pplugin` (signed inside, so users can
   double-click it to install) and its detached `.sig` (for the store).
4. Publish from the editor (Dashboard ▸ Plugins ▸ Publish) or with
   `sign-plugin.mjs publish`. Public needs a verified publisher.

`examples/plugin-ci/` does all of this in GitHub Actions for three platforms.

## Building and testing a plugin

```sh
# the samples build with the engine (native/sdk/CMakeLists.txt): <build>/plugins/<name>/
cmake --preset linux-clang-engine && cmake --build --preset linux-clang-engine
premation-plugins --plugins build/linux-clang-engine/plugins list
premation-plugins --plugins build/linux-clang-engine/plugins --bits 32 render com.premation.samples.ripple
premation-plugins --plugins build/linux-clang-engine/plugins crash-check com.premation.samples.ripple 2   # 2 = access violation
```

Each sample has a **Debug ▸ Fault** popup that injects each fault class. The
host tests use it to prove every isolation row above in a child process.
