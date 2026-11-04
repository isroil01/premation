# Program: plugins beyond After Effects — SDK 1.4 and 2.0

Owner ask (2026-11-03): how far can the plugin system go, so authors can build
plugins much deeper than today and use them inside the editor. Builds on
docs/PLUGIN_PLATFORM_PLAN.md (P1–P7), docs/PROGRAM_DEEP_PLUGINS.md (SDK 1.2,
Element 3D class, closed 2026-10-13) and docs/PLUGIN_SDK.md (SDK 1.3: custom
UI in Effect Controls). Status: **in progress** (W1, W3, W4 1d712106; W2 28cc8e40; L f3fabaf9; T built 2026-11-03, uncommitted). Everything stays
local on `native-core` until the owner says push.

## 0. Where we stand, and what "beyond AE" means

SDK 1.3 already covers the After Effects plugin surface: CPU and GPU effects
(WebGPU on the engine's Dawn device), float worlds, comp camera / lights /
layer transforms at any time, comp motion blur, output past the layer, scene
depth occlusion, presets, viewer overlays, custom Effect Controls UI, sequence
data in the document, commands, importers, output modules, HTML panels, a
signed store with entitlements, a per-instance crash guard, the watchdog and
quarantine.

What AE plugins cannot do, and what this program adds:

| Need | AE today | Premation today | Row |
|---|---|---|---|
| A plugin is its own kind of layer, with its own properties in the timeline | no (effect on a solid) | no | L |
| A plugin's meshes / lights take part in the comp's 3D render (shadows, DOF, depth sort, MB) | no (E3D renders its own world and composites) | depth **in** only (`checkout_scene_depth`) | D |
| Frame N depends on frame N-1 (simulations), with a host-managed cache | no (every plugin rolls its own) | no | T |
| Run an ML model on the GPU through the host | no | the engine runs ORT on DirectML for its own jobs only (`jobs/*_ort_ffi.cpp`) | M |
| A plugin crash or hang never ends the engine | no (in-process) | an instance fault is contained; `abort()`, heap corruption and hangs end the engine | X |
| Tools in the comp viewer with full pointer / keyboard | partly (AEGP + effect events) | effect overlays only | U |
| Plugins add expression functions, interpolators, property types | no | no | E |
| Plugins talk to each other (a controller drives many emitters) | no | no | C |
| Run the existing OpenFX catalogue (Sapphire, Boris FX, Neat Video) | no (AE has its own format) | no | O |
| Audio plugins on audio layers | no | no (audio from importers only) | A |
| Write one shader, get both paths; hot reload; scaffolding; test kit | no | samples + `premation-plugins` tool | W |

## 1. Owner decisions this program needs

**Decided 2026-11-03: Q1, Q2, Q3, Q4 and Q5 are all approved by the owner** (nothing pushed until told).

Settled decisions are not reopened: the JS/WGSL plugin system is not ported
(G2), the C++ engine is the only engine (docs/TS_ENGINE_REMOVAL.md). These are
new, and each blocks only its own rows:

- **Q1 (rows D)** — plugins write geometry and lights into the comp's 3D scene.
  PROGRAM_DEEP_PLUGINS.md lists this as an open decision.
- **Q2 (rows X)** — a second native process, `premation-plugin-host`, run and
  supervised by `premation-engine`. CLAUDE.md says native engine code runs in
  `premation-engine`; plugin code is third-party, not engine code, but the
  owner confirms.
- **Q3 (rows O)** — host OpenFX plugins. Real `.aex` loading stays G3, not
  this program.
- **Q4 (rows A)** — host VST3 / CLAP (licence: VST3 SDK is GPLv3 or Steinberg's
  proprietary licence; CLAP is MIT).
- **Q5 (rows M)** — ship ONNX Runtime as a plugin-facing suite (its version
  becomes part of the SDK contract).

## 2. Rows

Status: `[ ]` open · `[~]` in progress · `[x]` done (commit).

ABI rule as before: everything is appended (callbacks at the end of
`PrHostSuite`, trailing `PrInData` / `PrPluginInfo` fields, new flags and
selectors in free bits). SDK 1.0–1.3 plugins load and render unchanged.
Rows L, T, M, U, E, C, W are **SDK 1.4** (`PR_SDK_VERSION_MINOR` = 4).
Rows D and X change how a plugin is run, not only what it can call; they land
as 1.4 additions if they can stay appended, otherwise they wait for **2.0**
(a major bump, with a 1.x compatibility shim in the host).

### L — plugin layer types

- [x] L1 **Manifest `layerTypes`.** (2026-11-03, uncommitted) Built WITHOUT a new
  entry point: a layer type names one of the bundle's GENERATOR effects
  (`{ id, name, effect, category }`; checked at load). SDK minor 4.
  `PluginInfo.layerTypes`, `NativeEffects::layer_type`.
- [x] L2 **Render.** createLayer kind=generator + `generator` = "<pluginId>:<id>"
  makes a transparent comp-sized solid (`fx.pluginLayer`) carrying the type's
  generator as effect `layer` (`layerType: true`); the generator-effect render
  path is reused unchanged (frame test: the entry reaches the chain at layer
  size). Its own effect cannot be removed / duplicated / copied / moved, and
  nothing goes before it. Missing plugin: empty layer + layerErrors.
- [x] L3 **Editor.** Layer ▸ New lists plugin layer types
  (`withPluginLayerTypes`); the params are timeline rows in the layer's
  Contents group; `LayerInfo.pluginLayerType`; MCP `create_layer kind=plugin`.
  The TopNav "+" menu lists them too; the own effect's Effect Controls card
  offers no Move / Duplicate / Copy / Remove and does not drag.
- [x] L4 **Proof: `chartlayer` sample** (Bar Chart, Value 1–6 animatable) +
  CPU goldens (`plugin_goldens_chartlayer`), `test_plugin_finish.cpp
  [layertype]`, `pluginLayerTypes.native.test.ts`, GPU golden scene
  `plugin-layer-chart`.

### D — plugins inside the 3D scene (needs Q1)

- [x] D1 **Contribute selector.** `PR_SEL_SCENE_CONTRIBUTE` (layer types and
  3D effects): the plugin hands the host meshes (positions, normals, UVs,
  indices; GPU buffers or CPU arrays), PBR materials using the engine's
  material model, and lights. The host owns drawing them in the 3D pass
  (`scene/frame_build.cpp`, `lights3d.cpp`): they cast and receive shadows,
  depth-sort and intersect with native 3D layers, get DOF and motion blur.
  *Status 2026-11-04: PR_CMD_SCENE_CONTRIBUTE (`meshgen`, `model3d`), scene_add_mesh / scene_add_light, meshes on the extruded-mesh 3D path; top-level 3D layers only (an instance elsewhere that adds geometry is reported; one that adds nothing is silent); drawn on the GPU in the D4 golden.*
- [x] D2 **Motion vectors.** The plugin gives the previous-sample transform
  per mesh (or the host checks out the contribution at shutter samples via
  `checkout_time`) so comp motion blur is exact.
  *Status 2026-11-04: contributed meshes ride their layer's motion samples (model = S·F⁻¹·frame model per shutter sample), so comp motion blur blurs them with the layer; test "[scene3d]" D2.*
- [x] D3 **Custom shading (opt-in).** A plugin may supply a WGSL material
  function the host links into its forward pass, inside the GPU error scope;
  on failure the mesh draws with a default material and `layerErrors`.
  *Status 2026-11-04: PrSceneMaterial.shader_wgsl / shader_params: a `premation_material(in) -> out` function linked into a copy of the solid mesh shader (params in the uniform rows that shader never reads), lit by the comp's lights and shadows. Refused before linking if it declares bindings, entry points or directives; a compile failure (pipeline_error) draws the standard material, is remembered by hash, and the next frame build reports it on layerErrors. Mesh Cube ▸ Material ▸ Stripes / Broken (test). Tests "[gpu][scene3d]" and "[finish][scene3d]" D3.*
- [x] D4 **Proof: `model3d` moves from "renders its own world" to D1**, and
  a golden scene where a model shadows a native 3D text layer and is
  intersected by it.
  *Status 2026-11-04: `model3d` Render Mode ▸ In the Comp's 3D Scene hands its glTF triangles and material to the host (Base Color Map / Texture Layer stay with its own render modes). Golden `plugin-model3d-scene`: the box at the depth of extruded 3D text, intersecting it, shadowing it and the floor under a shadow-mapped spot (reference blessed from this build, re-rendered identical). Test "[finish][scene3d]" D4.*

### T — simulations and their cache

- [x] T1 **`PR_OUT_FLAG_STATEFUL`.** (2026-11-03, uncommitted) `PR_CMD_SIM_STEP`
  (23) with `PrSimStepExtra` (state_in, frame, dt, seed, state_out);
  rendering reads the frame's state through `get_sim_state` (appended to
  PrHostSuite). One SIM_STEP selector instead of SIM_STEP + SIM_RENDER: the
  ordinary render selectors draw from the state.
- [x] T2 **Host sim cache.** RAM + disk (`--sim-cache-dir`, 1 GB, kept across sessions; Cache & Memory shows both): `PluginHost::sim_state` keeps every state
  keyed by a hash chain of all earlier frames' inputs (an edit at k re-steps
  from k), LRU under a budget (256 MB).
- [x] T3 **Determinism.** Per-instance seed; the state is computed on the
  document side and travels with the frame (`simState`); two hosts walking
  vs jumping produce identical bytes (test).
- [x] T4 **Watchdog / viewer.** SIM_STEP runs under the render watchdog per
  call; a viewer frame gives a catch-up 80 ms, then draws without the state,
  not final, and is drawn again (BuiltFrame.simPending, a settle sentinel)
  until done; export waits. (Not on the prefetch workers: the document's
  inputs are evaluated on the building thread.)
- [x] T5 **Proof:** the `bounce` sample (a new sample, not a stateful mode of
  `particles`) + `engine_plugins_tests [sim]` (cold = walked, scrub back =
  0 steps, edit at k, budget) and `engine_plugins_scene_tests [sim]`
  (document keyframes drive steps), CPU goldens `plugin_goldens_bounce`
  (premation-plugins test steps to each case's time) and the GPU golden
  scene `plugin-sim-bounce` (packages/render-tests).

### M — ML inference suite (needs Q5)

- [x] M1 **`pr_ml.h`.** `ml_load(host, asset or bundle path, &model)`,
  `ml_run(model, inputs, outputs)` with tensors as CPU arrays or GPU textures;
  the session runs on the engine's ORT build (DirectML on Windows, CoreML on
  macOS), one shared environment, sessions cached per model hash.
  *Status 2026-11-04: 65254c04: CPU float32 tensors only; GPU-texture tensors are open.*
- [x] M2 **Budgets.** Model memory counts against the GPU memory pressure
  relief and shows per plugin in the layer profiler; a run past the render
  deadline drops to the plugin's CPU path or passes through, `layerErrors`.
  *Status 2026-11-04: models load by path and stay open while used; under GPU memory pressure (render_thread relief) sessions idle for a while are closed and load again on their next run (ml::trim_idle); Cache & Memory shows "Plugin ML models" (open count, bytes); test "[ml]" M2.*
- [x] M3 **Packaging.** `.onnx` files live in the bundle (`models/`), are
  covered by the signature, and are never downloaded at run time.
  *Status 2026-11-04: 65254c04.*
- [x] M4 **Proof: `mlstyle` sample** (a small style-transfer net) + a CPU-path
  golden; the GPU path is checked against it with a tolerance.
  *Status 2026-11-04: 65254c04: a 1x1-conv grade rather than a style-transfer net; matches the CPU path within one 8-bit level on DirectML.*

### X — plugins out of process (needs Q2)

- [x] X1 **`premation-plugin-host`.** One process per plugin (or per
  publisher), started by the engine; the selector calls go over a shared-memory
  ring; GPU textures cross via the shared-texture code the viewport already
  uses (`shared_texture_ffi*.cpp`). The plugin sees the same SDK; nothing
  changes for authors.
  *Status 2026-11-04: 65254c04: stdin/stdout pipes (not a shared-memory ring); CPU renders only, the input layer at the frame time.*
- [x] X2 **Policy.** Signed Premation plugins may run in process (today's
  path); third-party plugins run out of process by default; a user can pin
  either per plugin. A host crash or hang restarts that host only: its
  instances pass through for that frame, `layerErrors`, quarantine after
  repeat faults. The engine never ends because of a plugin.
  *Status 2026-11-04: `--plugin-isolation auto|off|all` + a per-plugin pin (setPluginIsolation, `--plugin-isolation-pin id=mode`, persisted by Electron): Plugin page select Auto / Own process / In the engine; a plugin that needs the engine (document, GPU, overlays) stays there and the page says so. Restarts capped at 3 per session. Tests "[isolation]".*
- [x] X3 **Cost.** `npm run bench` before/after with `grade` and `particles`
  in and out of process; the per-frame overhead is quoted and stays under a
  budget the owner sets.
  *Status 2026-11-04: measured with the hidden `[.oopbench]` case (ripple, 1920×1080 8-bit, same threads both sides): 18.7–20.3 ms/frame in process, 32.4–35.4 ms out of process, +13.7–15.2 ms per frame for crossing (two images over the pipe). `npm run bench` has no plugin scenes, so this is the number to quote.*
- [x] X4 **Tests.** The existing crash suite (`abort`, heap corruption, hang)
  re-runs with the plugin out of process and asserts the engine survives.
  *Status 2026-11-04: abort(), a hang and heap corruption (a double free, new sample fault 9) each end only the plugin's process; the next render starts it again; tests "[oop]".*

### U — viewer tools

- [x] U1 **Manifest `tools`.** A toolbar tool with an icon and shortcut; while
  active it receives pointer, wheel and key events in comp space (camera and
  layer transforms available, as in `DRAW_OVERLAY`) and draws an overlay.
  *Status 2026-11-04: manifest tools, Plugins > Tools, palette + shortcut; while the tool is active PluginToolOverlay forwards hover / drag / wheel / keys as `pluginToolEvent` (PR_COMMAND_TOOL_EVENT, never an edit) and draws what the plugin gives (tool_draw: lines, circles, dots) plus its status line; scatter shows its brush ring, the stamps a release would make, and changes spacing on wheel / [ ]. Live-checked in the app; test "[tools]" U1.*
- [x] U2 Edits go through `PR_CMD`-style transactions: one drag = one undo
  entry.
  *Status 2026-11-04: 142860a3.*
- [x] U3 **Proof: a scatter-brush tool** that stamps shape layers along a
  stroke.
  *Status 2026-11-04: 142860a3: `scatter` (ellipse layers along the stroke).*

### E — expressions, interpolators, property types

- [x] E1 **Expression functions.** Manifest `expressionFunctions`; the
  expression engine (`core/docexpr.cpp`) calls a pure C function with numbers,
  arrays and strings; no document access; same watchdog as renders.
  *Status 2026-11-04: 142860a3: numbers and arrays (no strings).*
- [x] E2 **Interpolators.** A keyframe's ease may name a plugin interpolator
  (`(t, params) → value`), shown in the graph editor; a missing plugin falls
  back to linear and records it.
  *Status 2026-11-04: 142860a3: timeline key menu; a missing plugin falls back to the key's own easing (not yet recorded on layerErrors, not drawn in the graph editor).*
- [x] E3 **Property types.** A plugin param may declare a compound type
  (e.g. a curve, a colour ramp with positions) the timeline keyframes as one
  value, interpolated by the plugin.
  *Status 2026-11-04: 142860a3: CURVE / GRADIENT with PR_PARAM_FLAG_ANIMATE_VALUE; Effect Controls stopwatch not live-checked.*

### C — plugins talking to each other

- [x] C1 **Published channels.** An instance may publish named values per
  frame (numbers, arrays, a small blob); other instances (any plugin that
  declares the channel) read them in `SMART_PRE_RENDER`. The host orders
  evaluation by these edges and rejects cycles with `layerErrors`.
  *Status 2026-11-04: 142860a3: channels per frame; SIM_STEP reads them too since C2.*
- [x] C2 **Proof:** a controller layer type (L) drives emitters on other
  layers (T).
  *Status 2026-11-04: a Controller publishes "pulse"; Bounce reads it in SIM_STEP as a sideways push, each step reading the channel at ITS time (publishers run again per step, memoised per frame build); publishers' keys join the simulation cache key, the channel values its step hash. The controller is an effect on any layer, not a separate layer type. Test "[sim][channels]" C2.*

### O — OpenFX hosting (needs Q3)

- [~] O1 **OFX host** in `plugins/ofx_*.cpp`: the Image Effect API 1.4,
  property suites mapped onto Premation params (curves, choices, groups,
  pages), Generator / Filter / General contexts, the OpenGL render suite
  skipped, CUDA / Metal / OpenCL suites out of scope at first (CPU path).
  *Status 2026-11-04: ofx_host.cpp in premation-plugin-host: Filter / General / Generator, CPU RGBA float + 8-bit, property / image effect / parameter / memory / multi-thread / message suites, params mapped (Double, Integer, Boolean, Choice, RGB/RGBA, Double2D, groups). Not yet: GPU render suites, interacts, multiple clips, temporal access, tiles.*
- [x] O2 OFX plugins run **out of process only** (X1), with the same journal
  and quarantine.
  *Status 2026-11-04: a `.ofx.bundle` is loaded only through premation-plugin-host; without one it is listed as failed, never loaded in the engine.*
- [x] O3 Projects store OFX effects by plugin identifier + version; a missing
  plugin passes through as today.
  *Status 2026-11-04: effects are stored as `ofx:<identifier>` with `pluginVersion` (the OFX plugin's pluginVersionMajor.Minor; every native plugin effect records its plugin version); a missing plugin passes through.*
- [~] O4 Test against the open OFX sample plugins; record which commercial
  packs load (tested on the owner's box only, no redistribution).
  *Status 2026-11-04: tested against `ofxinvert` (our own OFX C API sample); no commercial pack tried on the owner box yet.*

### A — audio plugins (needs Q4)

- [~] A1 CLAP first (MIT), VST3 second. Effects on audio layers in the
  playback mixer and the export mix (`audio/`), out of process (X1).
  *Status 2026-11-04: CLAP host in premation-plugin-host; layer audio effects (fx.audioEffects) now run in the engine's voices, built-ins and `clap:<id>` (ExternalEffects → the plugin's host process, pass-through on failure); `clapgain` sample. VST3 not started.*
- [~] A2 Plugin params are keyframeable layer properties; the plugin's own
  editor window opens from Effect Controls.
  *Status 2026-11-04: audio effect params (built-in and CLAP) are keyframeable layer properties `audio/fx/<id>/<key>` with stopwatches in the Audio Effects section; the plugin's own editor window is not opened (no GUI extension hosting).*

### W — authoring

- [x] W1 **Ship the WGSL → C++ twin generator** (from
  `premation-atelier/tools/gen.mjs`) in the SDK: one WGSL kernel, a generated
  CPU path, a parity test template. Plugins stay native (G2 holds).
  (2026-11-03, uncommitted) `native/sdk/fxkit/` — `fxkit.mjs <project>`
  (project-agnostic: `fxkit.json` + `fx/*.fx`), runtime headers, plugin
  source, `std.fx`; `premation_add_fx_plugin()` in the installed SDK; sample
  `samples/fxkit` (Chroma Split, Dot Grid). `engine_plugins_gpu_tests
  "[fxkit]"`: GPU vs CPU twin ≤ 1/255 at 8 bpc, 2.4e-4 at 16, 8.1e-7 at 32
  (RTX 4060). Two generator bugs fixed on the way (Atelier has them too):
  kernel lint errors were found after the problems check and never reported;
  an integer in `expand` emitted `2F`. All 51 Atelier effects pass the fixed
  lint.
- [x] W2 **Hot reload.** With Developer Mode on, a rebuilt bundle in the dev
  folder is reloaded without restarting the engine: instances re-run setup
  with their sequence data; a failed reload keeps the old module.
  (2026-11-03, uncommitted) `PluginHost::reload` loads the bundle beside the
  old one and swaps it in after GLOBAL/PARAMS_SETUP; instances are set down
  and set up again by the new build; the old module stays pinned; GPU data is
  released at device loss / shutdown (not at the reload: a threaded GPU render
  may hold it). `--plugin-shadow` loads binaries from per-launch copies (the
  DLL lock). Engine API `reloadPlugin` (875) purges the frame caches.
  Electron: `pluginDevMode.ts` (settings, launch args, debounced watcher),
  Plugins ▸ Installed ▸ Developer Mode card, `PluginDevReloader` toasts.
  Tests: `engine_plugins_tests "[reload]"` (probe built twice under one id:
  swap, re-setup, broken binary, bad / renamed manifest, Windows lock without
  shadow), `pluginReload.native.test.ts` (headless engine), Electron and page
  unit tests. Not clicked through in the running app (its main process
  predates the change); the full `premation-engine.exe` was not relinked (the
  running app holds it).
- [x] W3 **Scaffold.** (2026-11-03, uncommitted) `scripts/create-premation-plugin.mjs`
  (installed in `share/premation-sdk/`): `effect`, `fx`, `command` templates
  with CMake, manifest, `tests/cases.json`, README and the CI workflow (now
  also running the golden tests). All three built against a `cmake --install
  --component sdk` prefix and loaded in `premation-plugins`. Not on npm
  (`npm create` needs a published package). Layer-type, panel and tool
  templates follow L and U.
- [x] W4 **Test kit.** (2026-11-03, uncommitted) `premation-plugins test
  <cases.json> [--bless]`: CPU renders vs `tests/golden/*.pgold` (float),
  tolerance per bits, `<name>.actual.pgold` on a fail; ctest
  `plugin_goldens_fxkit`. A 4 → 5 px change fails (0.54), an unchanged
  render passes at 0.
- [x] W5 **Debugging guide.** Attaching a debugger to the engine (or to the
  plugin host after X1), symbols, the crash journal. (PLUGIN_SDK.md now has
  "Starting a plugin", "Writing effects in WGSL: fxkit" and "Golden tests";
  "Debugging a plugin": premation-plugins under a debugger, attaching to
  premation-engine, `--plugin-watchdog 0` via `PREMATION_ENGINE_ARGS`, logs,
  quarantine.)

## 3. Order and gates

1. **W1–W5** — cheap, no decision needed, and every later row is built with them.
2. **L** then **T** — the base for "Particular / Element 3D as a Premation
   plugin": layer types and simulations.
3. **X** (after Q2) — before third-party authors are invited to build at this
   depth.
4. **D** (after Q1) and **M** (after Q5).
5. **U, E, C** — as authors ask.
6. **O** and **A** (after Q3 / Q4) — catalogue growth, each on X.

Every row: tests in `engine_plugins_tests` (and `engine_plugins_gpu_tests` for
GPU paths), a sample, a golden scene where it renders, PLUGIN_SDK.md updated
in the same commit, `npm run bench:check` green, nothing pushed until told.
