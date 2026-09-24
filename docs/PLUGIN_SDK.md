# Premation native plugin SDK

Plan step G1 (`docs/NATIVE_CORE_PLAN.md` §5). The owner decided on 2026-09-22 (G2)
that the JavaScript/WGSL plugin system is **not** ported. Native plugins built
against this SDK are the C++ engine's plugin system. The API is modelled on the
After Effects effect API. The table below maps each part to its AE counterpart,
so an AE plugin author can find their way around.

| | |
|---|---|
| Headers | `native/sdk/include/premation_sdk/` (C, versioned ABI; `premation_sdk.h` includes all) |
| Samples | `native/sdk/samples/` — `ripple` (CPU), `rings` (generator + sequence data + button), `checkout` (Layer Displace, Time Echo), `grade` (GPU) |
| Host | `native/engine/src/plugins/` (runs inside `premation-engine`) |
| Tool | `premation-plugins` — list, render, crash-check a plugin folder without an editor |
| Tests | `engine_plugins_tests` (`tests/test_plugin_host.cpp`, `tests/test_plugin_session.cpp`) |

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

Flags: `CANNOT_ANIMATE`, `SUPERVISE`, `HIDDEN`, `START_COLLAPSED`, `DISABLED`.

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
  path on that device.

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

The TypeScript engine hosts no native plugins: `listPlugins` is empty and
`invokeEffectAction` is `unsupported`. The editor's surfaces (the Effects
panel, the Inspector's effect cards, a plugin manager) use these queries
once `engine()` is the C++ engine (plan D5). Until then native plugins run
where the C++ engine renders: the engine viewport and `premation-plugins`.

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
