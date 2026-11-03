# Premation native plugin SDK

Plan step G1 (`docs/NATIVE_CORE_PLAN.md` §5). The owner decided on 2026-09-22 (G2)
that the JavaScript/WGSL plugin system is **not** ported. Native plugins built
against this SDK are the C++ engine's plugin system. The API is modelled on the
After Effects effect API. The table below maps each part to its AE counterpart,
so an AE plugin author can find their way around.

| | |
|---|---|
| Headers | `native/sdk/include/premation_sdk/` (C, versioned ABI; `premation_sdk.h` includes all) |
| Samples | `native/sdk/samples/` — `ripple` (CPU), `rings` (generator + sequence data + button), `checkout` (Layer Displace, Time Echo), `grade` (GPU), `particles` (SDK 1.1: comp camera, lights, layer transforms; SDK 1.2: trails and its own motion blur through `checkout_time`, comp space, presets, a layer-time button); SDK 1.2 plugins that are not effects: `distribute` (a command), `ppmio` (an importer), `ppmseq` (an output module), `statspanel` (a panel + a command); `fxkit` (two effects written once in WGSL, see "Writing effects in WGSL: fxkit"); SDK 1.4: `chartlayer` (a plugin layer type, see "Layer types") |
| Host | `native/engine/src/plugins/` (runs inside `premation-engine`) |
| Tool | `premation-plugins` — list, render, crash-check a plugin folder without an editor |
| Next | `docs/PROGRAM_PLUGINS_BEYOND_AE.md` — proposed SDK 1.4 / 2.0: layer types, plugins in the 3D scene, simulations, ML, out-of-process host (not built) |
| Tests | `engine_plugins_tests` (`tests/test_plugin_host.cpp`, `tests/test_plugin_session.cpp`, `tests/test_plugin_scene.cpp`, `tests/test_plugin_entitlement.cpp`, `tests/test_plugin_sdk12.cpp`, `tests/test_plugin_contrib.cpp`: commands, importers, output modules, panels), `engine_plugins_scene_tests` (`tests/test_plugin_finish.cpp`: the frame hook over a document), `engine_plugins_gpu_tests`, the golden scene `plugin-particles-orbit` (packages/render-tests) |

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
- Optional, cosmetic (a bad value is ignored, never fails the plugin):
  `"icon": "ui/icon.png"` — a PNG / SVG / JPEG / WebP inside the bundle's
  `ui/` folder, shown 16 px in the effect card's header (served like panel
  files, as `plugin-ui://<id>/icon.png`; without one, a plugin installed from
  the store shows its store icon); `"panelTitle": "Studio"` — the label of
  the header button that opens the bundle's panel (`ui/index.html`; default
  "Panel", at most 40 characters).

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
| `DRAW_PARAM_UI` / `PARAM_UI_DRAG` (1.3) | `PF_Cmd_EVENT` in the Effect Controls window (custom ECW UI) | a `CUSTOM_UI` param's box in the effect card (see Custom UI in Effect Controls) |
| `LIST_ASSET_FILES` (1.2) | AE's Collect Files has no plugin hook (Element 3D ships its own model folders) | the files beside a `FILE` param's asset the effect reads, so Collect Files carries them (see Assets) |

Out flags (SDK 1.2 adds `SAMPLES_TIME`, `USES_SHUTTER`, `COMP_SPACE`, below): `DEEP_COLOR_AWARE` (16-bit), `FLOAT_COLOR_AWARE` (32-bit float),
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
| `COLOR` | colour, sRGB-encoded 0..1 as the colour picker shows it; the plugin gets straight RGBA in **linear light** (the working space, SDK 1.2). The document stores it as `#rgb` / `#rrggbb` / `#rrggbbaa`; any other stored value renders the declared default and the layer reports "parameter '…' is not a colour" on layerErrors |
| `POPUP` | choice, 1-based |
| `CHECKBOX` | bool |
| `LAYER` | a layer reference (id, `""` = none) |
| `PATH` | a mask of the layer (its bezier at the frame time, 6 doubles per vertex) |
| `ARBITRARY_DATA` | bytes in the document (`fx.pluginData`), written by the plugin or `setPluginData` |
| `BUTTON` | an action (`invokeEffectAction`, `p<id>`); Effect Controls draws it on its own row where it was declared, inside its group |
| `GROUP_START` / `GROUP_END` | a twirl-down section, open unless `START_COLLAPSED` |
| `STRING` (1.1) | text (`text`; a multi-line field) |
| `CURVE` (1.1) | the Curves effect's point list `[[x, y]…]` in 0..255; the plugin gets `curve` / `curve_count`, x, y in 0..1 |
| `GRADIENT` (1.1) | stops `[[position, r, g, b, a]…]` in 0..1 (colours sRGB-encoded); the plugin gets `gradient` / `gradient_count`, the stops' r, g, b in linear light (SDK 1.2) |
| `FILE` (1.1) | a project item id (`file_types` filters the picker); the plugin gets `file_name`, `file_missing` and the file through `get_asset_path` / `get_asset_bytes` |

Flags: `CANNOT_ANIMATE`, `SUPERVISE`, `HIDDEN`, `START_COLLAPSED`, `DISABLED`.

How Effect Controls draws a plugin effect (as AE does): params and buttons in
declaration order; a group open unless `START_COLLAPSED`; no stopwatch on a
`CANNOT_ANIMATE` param (the engine refuses its keyframes: `notAnimatable`).
`set_param_ui` applies to every row it names: hiding a `GROUP_START` hides the
whole group (nested groups included), and a `POINT`'s state (hidden, disabled,
renamed) applies to both its axis rows. `listEffects` carries the layout:
`EffectInfo.groups` (each group's path, key, `collapsed`) and each action's
`group` and `at` (how many params come before it). The card's ⋯ menu and its
header's **Presets ▾** offer the plugin's presets for that effect (Apply
Preset): the preset's values, every other param back to its default, one undo
entry.

**Descriptions (SDK 1.2).** `PrParamDef.description` (the struct's last field;
check `struct_size` — a module built against an older header simply has none) is
a one-line UTF-8 description, copied at `PARAMS_SETUP` (up to 1024 bytes). Effect
Controls shows it as the param label's tooltip (a dotted underline on hover and
keyboard focus); on a `GROUP_START` it is the group header's tooltip; a `POINT`'s
applies to both axis rows. `listEffects` carries it as
`EffectParamInfo.description` / `EffectGroupInfo.description`.

**The card header.** A plugin effect's header shows the manifest `icon`, its
presets (**Presets ▾**), a button to the bundle's panel labelled `panelTitle`
when it ships `ui/index.html`, and **ⓘ** with the effect's `PR_CMD_ABOUT` text
(`EffectInfo.about`).

**Colours are linear (SDK 1.2).** Every world a plugin reads and writes is linear
working space, and so are its colours: a `COLOR` value (the frame's `params[]`,
`checkout_param` at another time, `DRAW_OVERLAY` / `OVERLAY_DRAG` /
`USER_CHANGED_PARAM` / `UPDATE_PARAMS_UI`) and a `GRADIENT` stop's r, g, b arrive
decoded from the document's sRGB-encoded 0..1 with the IEC 61966-2-1 transfer — the
one the built-in effects decode their colours with — so a `#808080` grey is
0.2159, not 0.5. Alpha and positions are not touched. A colour written back with
`set_param_value` is taken as linear and encoded for the document, so writing back
what was read leaves the document's colour exactly as it was. Declared defaults
(`add_param`) and preset colours are document values, sRGB-encoded like the picker
(`{0.8, 0.8, 0.8}` reaches the plugin as 0.604). After Effects delivers
`PF_ADD_COLOR` values in the project's working space the same way. SDK 1.0 / 1.1
plugins see the same linear values: a colour they used as a display value renders
darker in mid-tones than before.

The SDK 1.1 types are never keyframed. Their defaults go in the fields at the end
of `PrParamDef` (`text`, `curve`, `gradient`, `file_types`); an SDK 1.0 struct
cannot declare them (the plugin fails to load with "needs SDK 1.1").

A `FILE` param's value is a **project item**: the editor's **Choose…** imports
the file as a `data` item (`importFiles` with `asData`: never probed as
footage), so Collect Files copies it (and the files beside it the plugin
lists, see "Assets"), Relink re-points it, Remove Unused keeps it while an
effect uses it, and the project saves it. At render the engine
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
`current_time` is the **layer** time; `comp_time` is the composition time
(SDK 1.2, see "Layer time": before 1.2 the engine passed the comp time in both).
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
- **Evaluated at the frame time** (`time` = `current_time`) or, SDK 1.2, at
  a time the effect checked out (see "Other times"); any other time answers
  `PR_ERR_NOT_FOUND` (`PR_ERR_UNSUPPORTED` on an SDK 1.1 host). `finish_native_frame` writes them from the
  built frame into the effect's chain entry (`fx_wire.hpp`), so they are
  inputs of that effect's render: moving the camera re-renders an effect that
  reads it, and no other. The frame stays a pure function of the document.
- World space is After Effects': pixels, +x right, +y down, +z away from the
  viewer, matrices column-major.
- SDK 1.2: on a composition with no 3D layer (Particular on a 2D solid) the
  effect still gets the comp's camera and lights — the scene's own, evaluated
  off the document — instead of the default view.
- The manifest says `"sdk": { "major": 1, "minor": 1 }`; an engine with SDK
  1.0 lists such a plugin as failed ("needs SDK 1.1") instead of loading it.

## SDK 1.2 at a glance — the After Effects mapping

| Premation (SDK 1.2) | After Effects | For |
|---|---|---|
| `PR_OUT_FLAG_SAMPLES_TIME`, `checkout_time(host, time, what)` in `SMART_PRE_RENDER` | `PF_CHECKOUT_PARAM` / AEGP stream values at another time | params, camera, lights, layer transforms at other (layer) times |
| `checkout_param(host, index, time, PrParamDef*)` | `PF_CHECKOUT_PARAM` | a param's value at the frame or a checked-out time |
| `get_comp_camera` / `get_comp_lights` / `get_layer_transform` at a checked-out time | `AEGP_GetEffectCamera`, the light suites, `AEGP_GetLayerToWorldXform` at a time | trails, motion blur, simulations |
| `PrInData.shutter_angle`, `shutter_phase`, `motion_blur`, `motion_blur_samples`; `PR_OUT_FLAG_USES_SHUTTER` | `in_data->shutter_angle` / `shutter_phase`, `PF_OutFlag2_I_USE_SHUTTER_ANGLE` | the effect renders its own blur |
| `current_time` = layer time; `layer_start`, `comp_width` / `comp_height`, `layer_is_3d` | `in_data->current_time` (layer time) | start offset, Time Stretch, reverse, freeze |
| `PrPreRenderExtra.result_rect` past the layer; `PR_OUT_FLAG_COMP_SPACE`, `comp_to_world` | `max_result_rect` / `result_rect`, `PF_OutFlag_I_EXPAND_BUFFER` | a glow's halo, a flare off the layer, Element 3D on any solid |
| `get_asset_image` / `get_asset_image_gpu` / `get_asset_sibling_bytes` | the plugin's own loaders | images decoded by the engine; a glTF's `.bin` and textures |
| manifest `presets`, `presets/*.json` | `.ffx` animation presets | listed under the plugin in Effects & Presets |
| `PR_OUT_FLAG_USES_SCENE_DEPTH`, `checkout_scene_depth_gpu` / `checkout_scene_depth` | none (Element 3D renders the comp's 3D layers itself for "Composite with scene depth") | occlusion by the comp's own 3D layers |
| `COLOR` values and `GRADIENT` stops in linear light; `set_param_value` encodes back | colour params in the project's working space | colours that match the linear worlds |
| `get_comp_camera` / `get_comp_lights` / `get_layer_transform` in `DRAW_OVERLAY` / `OVERLAY_DRAG`; `overlay_set_space(host, PR_OVERLAY_SPACE_COMP)`; `PrOverlayDragExtra.space` | `AEGP_GetEffectCamera` in `PF_Cmd_EVENT`, `PF_EA_LAYER` / `PF_EA_COMP` coordinate spaces | handles on a 3D point the plugin projects itself |
| `checkout_time(..., PR_SAMPLE_SCENE_DEPTH)`, `checkout_scene_depth_gpu_at` / `checkout_scene_depth_at` | none | occlusion per motion-blur sub-frame |

Everything is appended: new `PrHostSuite` callbacks at the end (check
`struct_size >= offsetof(PrHostSuite, get_asset_sibling_bytes) + sizeof(void*)`),
new `PrInData` fields at the end (check
`struct_size >= offsetof(PrInData, comp_to_world) + sizeof(in_data->comp_to_world)`),
new flags in free bits. SDK 1.0 and 1.1 plugins load and render unchanged; a
plugin whose manifest says `"minor": 2` fails on an older engine with "needs SDK 1.2".

## Other times (SDK 1.2)

A trail, a plugin's own motion blur or a simulation's history reads the scene
at times other than the frame's. In After Effects that is `PF_CHECKOUT_PARAM`
and the AEGP stream suites at any time; here the effect says up front what it
will read, and the engine evaluates exactly that:

1. Declare `PR_OUT_FLAG_SAMPLES_TIME` (with `SMART_RENDER`) and the
   `USES_CAMERA` / `USES_LIGHTS` / `USES_LAYER_TRANSFORMS` flags of what it reads.
2. In `SMART_PRE_RENDER` call `checkout_time(host, time, what)` for each time —
   a **layer** time in ticks — with `what` any of `PR_SAMPLE_PARAMS`,
   `PR_SAMPLE_CAMERA`, `PR_SAMPLE_LIGHTS`, `PR_SAMPLE_LAYER_TRANSFORMS`
   (`PR_SAMPLE_ALL`). Asking again for a time adds bits; at most
   `PR_MAX_TIME_SAMPLES` (1024) times per instance and frame.
3. In any render selector, `checkout_param(host, index, time, &def)` (the caller
   sets `def.struct_size`) and `get_comp_camera` / `get_comp_lights` /
   `get_layer_transform` answer for the frame's time and every checked-out time.
   Another time is `PR_ERR_NOT_FOUND`: skip that sample, never fail the frame (a
   renderer that runs no frame hook, such as `premation-render` on a frame file,
   evaluates none).

`finish_native_frame` (`scene_finish.cpp`) runs the pre-render once per frame
and evaluates the requested values **off the document** — the effect's
animatable params (keyframes and expressions at that layer time), the scene
camera, the lights and the LAYER params' world matrices — never a whole frame
per time. Comp times between frames map to source times between frames, as a
layer's motion-blur samples do. Every evaluation is kept for the frame, so many
effects asking for the same shutter samples pay once. The values are written
into the effect's chain entry (`fx_wire.hpp`, `s<i>.*`), so a frame is still a
pure function of the document: preview, export and a restarted engine render
the same pixels. Static params (strings, curves, files, layers, paths) are the
frame's at every time.

When the viewer shows the comp through another camera than the scene's (a
custom or axis view, which never moves) the samples keep that view; when the
frame's lights are not the scene's (Draft 3D) they keep the frame's. A sample
at the frame's own time always equals the frame.

The `particles` sample uses it: Trail Length draws each particle again at the
past frames, where the camera, the emitter and Velocity put it then, and with
the comp's motion blur on it renders its own blur over the shutter.

## Layer time (SDK 1.2)

`current_time` is the layer's own time — its start offset, Time Stretch,
reverse and freeze, the mapping its keyframes use — and `comp_time` the
composition's. Every time an effect passes the host (`checkout_layer`,
`checkout_time`, the scene callbacks) is a layer time; the engine maps it back
to comp time where it builds or evaluates the composition. `layer_start` is the
comp time of layer time 0 (with no stretch, comp time = `layer_start` + layer
time). `comp_width`, `comp_height` and `layer_is_3d` describe the composition
and the layer. Buttons, overlays and the params UI get the layer time of the
playhead too (the `particles` sample's **Reseed From Playhead** writes it).
Inside a nested composition (a precomp layer) `comp_time` is that
composition's time — the source time its instance shows at this frame, through
the instance's start offset, stretch and time remap — and `layer_start` is
relative to it. Times passed to the host map back through each instance to
the frame's composition (the camera, the lights and a checkout's frame are
evaluated there), anchored at the frame's own time; a Time Remap on an
instance is followed exactly at the frame's time and by its offset / stretch at
other times. `comp_width` / `comp_height` and the camera stay the frame's
composition's. A layer of a collapsed precomp runs on the frame's clock, as it
is drawn.

## Motion blur (SDK 1.2)

`PrInData.shutter_angle` and `shutter_phase` (degrees) and `motion_blur_samples`
are the composition's settings; `motion_blur` is 1 when the render, the
composition's switch and the layer's switch are all on (the viewer's Draft
preview turns it off). An effect that declares `PR_OUT_FLAG_USES_SHUTTER`
renders its own blur — it checks out the shutter's times and draws each (AE's
`PF_OutFlag2_I_USE_SHUTTER_ANGLE`) — and the engine does **not** supersample its
layer through it: the layer is drawn once, at the frame. An effect without the
flag is rendered with its layer as before.

## Output beyond the layer (SDK 1.2)

Once per frame the engine runs `SMART_PRE_RENDER` with the world = the layer's
own pixels (`request_rect` = the layer, `layer_to_world` the identity). A
`result_rect` past the layer (a glow's halo, a flare off the layer's edge) grows
the layer's effect buffer by that much — the built-in effects' grow bounds
(`reachPx` in the chain entry) — capped at the engine's texture limit. On a 2D
layer the chain already runs in the frame's own buffer, so the output shows
anywhere in the frame; on a 3D layer the layer-space buffer grows.

`PR_OUT_FLAG_COMP_SPACE`: the effect's output covers the composition frame
(Element 3D, Optical Flares, Particular on a solid of any size). Draw with
`PrInData.comp_to_world` (composition px → world px, row-major like
`layer_to_world`): on a 2D layer it is the view of the composition the chain
renders in; on a 3D layer, whose chain runs in the layer's own plane,
composition pixels are taken as the layer's.

## Assets (SDK 1.2)

A `FILE` param's file, beyond `get_asset_path` / `get_asset_bytes`:

- `get_asset_image(host, index, &world)`: the image decoded by the engine — PNG,
  JPEG, WebP, GIF, BMP, TIFF (the engine's still decoders), OpenEXR, Radiance
  `.hdr`, binary `.ppm` / `.pfm` — as linear, premultiplied `RGBA32F` (8-bit
  footage is sRGB-decoded and straight alpha premultiplied). Kept per file, size
  and modification time: a re-saved file decodes again. `PR_ERR_UNSUPPORTED`: not
  an image the engine reads.
- `get_asset_image_gpu(host, index, &gpuWorld)` (`SMART_RENDER_GPU`): the same
  image as an `rgba32float` texture on the engine's device, uploaded once per
  file and modification time and dropped with the device.
- `get_asset_sibling_bytes(host, index, "textures/albedo.png", &data, &size)`: a
  file beside the asset (a glTF's `.bin` and textures, an `.obj`'s `.mtl`).
  `relative` uses `/` (or `\`); no `..`, no absolute path or drive, no symlink
  out of the asset's folder (`PR_ERR_INVALID_PARAM`); at most 512 MiB.

Collect Files copies a `FILE` param's file **and the files beside it the
plugin lists**. The collected project stores files content-addressed
(`blobs/<hh>/<sha256>`: no names, no folders), so it asks the effect which
siblings its asset needs:

- `PR_CMD_LIST_ASSET_FILES` (SDK 1.2, `PrListAssetFilesExtra`: `param_index`,
  `asset_path`, `add_file(refcon, relative)`). Document side, on the engine's
  core thread, once per `FILE` param with a value, at Collect Files — never
  from a render, never an edit (nothing goes into undo; viewing a project never
  dirties it). Crash-guarded and under the watchdog. The effect's params are
  the document's (`params[]`, the asset as `file_name`); call `add_file` once
  per file, `/`-separated and relative to the asset's folder, with the rules of
  `get_asset_sibling_bytes` (no `..`, no absolute path or drive). The `model3d`
  sample reads its `.gltf` and lists every `buffers[].uri` and `images[].uri`
  that is not a `data:` URI (percent-decoded).
- An SDK 1.0 / 1.1 module, or one that adds nothing, gets its asset carried and
  nothing beside it. A fault or an error return while listing is reported in
  Collect Files' list ("the plugin could not list the files beside it … only the
  file itself is collected") and disables the plugin as any fault does (the
  frame's layerErrors say so); the asset itself is still collected. A listed
  file that is not there is reported, never fatal.
- The collected item records `path: "motion-blob:<sha256>"` and
  `collected: { name: "box.gltf", siblings: { "box.bin": "motion-blob:…",
  "tex/albedo.png": "motion-blob:…" } }`. Opening the project (and an export's
  snapshot) lays the files out again under their names in a content-addressed
  folder (`<temp>/premation-collected/<key>/`), so `p.<key>.path`,
  `get_asset_bytes` and `get_asset_sibling_bytes` see the same layout as before
  the collect. The record travels with every save: a bundle (Save As copies
  its blobs), the portable `.motion` (`assets/blob-<sha256>`), recovery, an
  export's snapshot; a collect of a collected project carries the table as it is.
  A JSON save or a cloud save keeps the record and the references; like every
  collected footage file, the bytes stay in the bundle they were collected into.

Plugin-imported footage (an importer claims it by extension, P7b) is collected
the same way: its item keeps `collected.name` (`clip.ppm`), and is laid out
under that name when opened, so the importer still claims it.

## Scene depth (SDK 1.2)

Element 3D's **Composite with scene depth**: a model passes behind the comp's
own 3D layers. After Effects gives a plugin no depth buffer (E3D rebuilds the
comp's 3D layers itself); Premation hands it one.

- Declare `PR_OUT_FLAG_USES_SCENE_DEPTH` in `GLOBAL_SETUP` (without it the
  callbacks answer `PR_ERR_INVALID_CALLBACK`).
- `checkout_scene_depth_gpu(host, &gpuWorld)` in `SMART_RENDER_GPU`: an
  `r32float` texture (`PR_GPU_FORMAT_R32_FLOAT`) on the engine's device. It is
  not filterable: read it with `textureLoad`.
- `checkout_scene_depth(host, &world)` in `SMART_RENDER` / `RENDER`: the same
  depth read back, a `PR_PIXEL_FORMAT_R32F` world (one float per pixel).
- `PR_ERR_UNSUPPORTED` when the render has no GPU to draw the depth with (the
  SDK's `premation-plugins` CPU host, the host tests): render without occlusion.

What a pixel holds:

| | |
|---|---|
| layers | the comp's 3D layers **other than the effect's own**, in the composition the layer is in (a sealed precomp's own camera and layers inside it), and the 3D layers inside its **collapsed** 3D precomps (no camera of their own, not a flat 3D card): the 3D renderer draws those under the comp's camera with their own models, and so does the depth (their alpha × the precomp's opacity) |
| view | the comp camera at the frame's time; at a motion-blur sub-time with `checkout_scene_depth_gpu_at` (below) |
| size | world-sized: pixel (x, y) is world pixel (x, y) of this render, so `layer_to_world` / `comp_to_world` line up with it |
| value | the **camera-space z** of the nearest surface: the distance from the eye along the view axis, in comp px — `(view · p).z` with `PrCamera.view`, positive in front. Not the straight-line distance to the eye. Compare a fragment's own `(view · p).z` with it. |
| empty | `+inf` where no 3D layer is drawn |
| transparency | a texel whose coverage (texture alpha × mask × opacity, or a solid's shape) is under 1/255 writes no depth — the engine's own 3D pass discards by the same rule; any other texel does (depth is not blended) |

It is an input of the frame: moving a 3D layer (or the camera) re-renders the
effect, and an effect that never asks never pays. The engine draws it in its
own pass over the 3D group's geometry (`render_graph/scene_depth.cpp`: the
quads and the extruded / model meshes, through the scope's camera and the
chain's `comp_to_world`) the first time an effect of the frame asks, and every
effect of the frame that asks with the same world size and placement shares it
(an effect on a 2D layer excludes no drawn layer, so all of them share one pass).
Call the checkouts from the selector's own thread, not from an `iterate()` job.

**At a sub-time (motion blur).** An effect that blurs itself
(`PR_OUT_FLAG_USES_SHUTTER`) renders sub-frames at other times; occluding each
against the frame's depth smears the model behind a layer that moves. Ask for
the depth at those times:

1. In `SMART_PRE_RENDER`, add `PR_SAMPLE_SCENE_DEPTH` to the `checkout_time`
   bits for each sub-time (not in `PR_SAMPLE_ALL`: each time is a depth pass of
   its own).
2. In the render, `checkout_scene_depth_gpu_at(host, time, &gpuWorld)`
   (`SMART_RENDER_GPU`) or `checkout_scene_depth_at(host, time, &world)`
   (`SMART_RENDER` / `RENDER`) — appended after `overlay_set_space`; check
   `struct_size >= offsetof(PrHostSuite, checkout_scene_depth_at) + sizeof(void*)`.
   `time` = `in_data->current_time` is the frame's depth; a time not checked out
   with the bit answers `PR_ERR_NOT_FOUND`.

The engine evaluates, for each such time, the comp camera and every 3D layer the
depth draws (keyframes, parenting, expressions; sub-frame exact) and the frame
carries them, so preview and export draw the same depth. A layer inside a
collapsed precomp is posed by the composition built at the sub-time (its
instance's motion and its own, through nested collapsed precomps), built once
per sub-time and only when such a layer is in the depth; a layer not drawn at
that time keeps its frame pose. The precomp's opacity is the frame's.

## Presets (SDK 1.2)

A bundle ships named starting points for its effects (AE's `.ffx`), in the manifest

```json
"presets": [
  { "name": "Warm Fountain", "category": "Fountains", "effect": "com.example.particles",
    "values": { "p2": 600, "p8": "#ffb347", "p5": 2, "p1": [0, -100] } }
]
```

and / or as `presets/*.json` in the bundle (one such object, or
`{ "presets": [ … ] }`). `effect` defaults to the plugin's first effect. Values
are by param key: numbers, angles and sliders (clamped to the valid range),
popups (a 1-based number or the choice's label), checkboxes, colours
(`"#rrggbb[aa]"` or `[r, g, b(, a)]` in 0..1), points (`[x, y(, z)]` or `p<id>X` …,
offsets from the layer centre as the document stores them), strings, curves and
gradients. A key the effect lacks, a `LAYER` / `FILE` / `PATH` param, or a value
of the wrong kind is dropped; a preset without a name, or naming an effect the
bundle does not list, is skipped and logged — never a failed plugin.

`listPlugins` returns them (`PluginInfo.presets`, values in the API's own
encoding); the editor lists them under their effect in Effects & Presets, and
applying one is **one** `addEffect` with the values as its `params` — one undo
entry, no plugin code beyond what adding the effect runs.

## Viewer overlays (SDK 1.1)

AE's `PF_Cmd_EVENT` draw / click / drag, without plugin code in the UI
process. Declare `PR_OUT_FLAG_CUSTOM_OVERLAY` in `GLOBAL_SETUP`, then:

- `PR_CMD_DRAW_OVERLAY` (`PrOverlayExtra`: the layer size): call
  `overlay_line`, `overlay_path` and `overlay_handle` with layer-pixel
  coordinates — the same layer px the render takes (`(0, 0)` the top-left of
  the layer's box as drawn, `PrInData.layer_to_world`), so a handle at a
  POINT param's value sits where the plugin draws it on every layer kind. The
  params are the effect's values at the viewer's time and the layer size is the
  document's (an overlay needs no render first). The engine runs this when it
  builds overlay geometry (`overlay_geometry.cpp`), takes the items into the
  layer's local space (`handlers_native.hpp` `NativeLayerFrame`: centred on the
  layer's origin, a 2D layer's anchor out) and the editor maps them with the
  layer, as it maps a mask. Limits: 256 items, 2048 points per call, 192 per
  path; extra items are dropped.
- `PR_CMD_OVERLAY_DRAG` (`PrOverlayDragExtra`: handle id, phase
  `BEGIN`/`MOVE`/`END`, pointer and start in layer px): write params with
  `set_param_value` (an animated param keys at the current time) or
  `set_arb_data`. The editor sends `dragEffectOverlay`; begin → end is **one**
  undo entry.
- A plugin that crashes while drawing draws nothing; the frame still renders.

The `rings` sample draws its three rings and a crosshair at its centre; dragging
the crosshair moves `Center`.

**SDK 1.2 — overlays through the camera.** A layer-px overlay is right for a 2D
handle, not for a 3D point (Element 3D's model position, a light's target): the
editor maps layer px with the layer, so a point that is not on the layer's plane
sits in the wrong place under any camera that is not the default. So:

- In `DRAW_OVERLAY` and `OVERLAY_DRAG` the scene callbacks answer at the viewer's
  time (`in_data->current_time`, or the comp time): `get_comp_camera`,
  `get_comp_lights`, `get_layer_transform` — each still needs its
  `PR_OUT_FLAG_USES_*`. Another time answers `PR_ERR_NOT_FOUND` (there are no
  checked-out times outside a render). The engine evaluates them off the document
  for the composition the layer is in (the topmost visible camera live at that
  time, else the comp's default view), only for what the effect declared.
- `overlay_set_space(host, PR_OVERLAY_SPACE_COMP)` (appended after
  `checkout_scene_depth`; `PR_OVERLAY_SPACE_LAYER` is the default) makes the
  `overlay_line` / `_path` / `_handle` calls that follow take **composition px**:
  project the point yourself — `(projection · view · p).xy / w` with `PrCamera` —
  and the editor draws it through the viewer's comp → screen only.
  `PrOverlayExtra.comp_width` / `comp_height` (appended) are that space's size.
- A drag of a comp-space handle reports the pointer in comp px:
  `PrOverlayDragExtra.space` (appended; check `struct_size`) is
  `PR_OVERLAY_SPACE_COMP` and `x`, `y`, `start_x`, `start_y` are comp px. To move
  a 3D point in the camera's view plane, solve for the camera-space point at the
  point's own depth that projects to the pointer and take it back to the world
  with `PrCamera.world` (the `model3d` sample, `overlay_drag`).
- The comp px are those of the comp camera (the active camera layer, else the
  default view): in a viewer looking through a custom or axis view the handles
  follow the comp camera, as the effect's render does.

## Custom UI in Effect Controls (SDK 1.3)

AE lets a plugin draw its own control inside Effect Controls (`PF_PUI_CONTROL`:
a curve editor, a histogram, a palette strip between the param rows), drawn on
`PF_Cmd_EVENT` with Drawbot. Premation does the same without plugin code in the
UI process: the engine runs the plugin, and the editor draws what it returns.

- Declare a `PR_PARAM_CUSTOM_UI` param in `PARAMS_SETUP`; `value[0]` is the box's
  height in px (24..600; 0 = 120). It has no value of its own, so it shows and
  edits other params or arbitrary data. The card draws it where you declared it
  (inside its group, between the rows around it), as wide as the card, with the
  param's name above it. `set_param_ui` hides, renames and disables it like any
  row. **An older host refuses the unknown type and fails the whole plugin:**
  declare the box only when `PR_SDK_VERSION_MINOR_OF(in_data->host_sdk_version)
  >= 3` (the `rings` sample does).
- `PR_CMD_DRAW_PARAM_UI` (`PrParamUiExtra`: the param's index, the box's `width`
  and `height`): draw with `overlay_line`, `overlay_path`, `overlay_handle` and
  the SDK 1.3 `ui_fill` (a filled polygon) and `ui_text` (one line of UTF-8, at
  its baseline, left / centre / right) in box px, `(0, 0)` the top-left. The
  params are the effect's values at the editor's time (animated ones included),
  with the instance's sequence and arbitrary data. Same limits as the overlay
  (256 items, 2048 points).
- `PR_CMD_PARAM_UI_DRAG` (`PrParamUiDragExtra`: handle id, phase
  `BEGIN`/`MOVE`/`END`, pointer and start in box px, the box size): write with
  `set_param_value` / `set_arb_data`. The editor sends `dragEffectParamUi`
  inside one gesture: begin → end is **one** undo entry, and Esc reverts it.
- **Colours.** Pass `NULL` and the editor draws the item in its theme: lines and
  paths in the secondary text colour, text in the text colour, fills in the
  control surface, handles in the accent. A box drawn with `NULL` colours
  matches dark, light and high contrast. Pass RGBA for data colours (a palette,
  a histogram's channels).
- The box is drawn again when the time or the document changes. A plugin that
  fails or crashes while drawing draws nothing: the card shows an empty box.

The `rings` sample's **Palette** box shows the palette's colours (Shuffle
Palette updates them) and Spacing on a track; dragging its handle sets Spacing.

Engine API: `EffectInfo.customUis` (`key`, `label`, `group`, `at`, `height`),
the query `drawEffectParamUi { layer, effect, key, width, time? }` →
`{ items, height }`, and the command `dragEffectParamUi`.

## Plugin panels (SDK 1.1)

Optical Flares' editor or Element 3D's scene setup, without plugin code in the
editor: a bundle may ship `ui/index.html` (and its scripts, styles, images and
fonts beside it in `ui/`). The effect card's header then shows a button to it
(labelled with the manifest's `panelTitle`, default **Panel**), and the editor
shows the page in a floating window's frame:

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
| `{ id, type: 'setParams', values: [{ key, value }…], label? }` | several `setParam`s (≤ 64) as ONE undo entry — a preset button (`model3d`'s Clay / Gloss); the entry reads `<effect>: <label>` |
| `{ id, type: 'setArbitraryData', key: 'p3', data: '<base64>' }` | `setPluginData`: an ARBITRARY_DATA param's bytes (≤ 256 KiB) |
| `{ id, type: 'invokeButton', key: 'p9', payload? }` | `invokeEffectAction`: `USER_CHANGED_PARAM` with `PrUserChangedParamExtra.payload` (UTF-8, ≤ 64 KiB) — a hidden button (`PR_PARAM_FLAG_HIDDEN`) is how a panel hands the plugin data for its sequence data |
| `{ id, type: 'requestPreview', maxSize? }` | the engine renders the layer at the current time; the reply carries `image` (a PNG data URL). The panel never renders. |
| `{ type: 'shortcut', action: 'undo' \| 'redo' }` | Edit ▸ Undo / Redo, as the menu runs them — honoured only while the panel's frame has the focus |

The editor sends `{ type: 'state', effect, plugin, time, params, values, data }`
on `ready` and after every document change (undo and redo too): `params` as
the plugin shows them, `values` the effect's stored values, `data` the
sequence data (`sequence`) and arbitrary-data params, base64. Each request gets
`{ type: 'reply', id, ok, error?, image? }`. Every edit is an ordinary engine
command: one undo entry, saved with the project, in the command log.

The `rings` panel reads its palette from the sequence data and applies an
edited one through the hidden **Set Palette** button (`#rrggbb` colours as the
payload).

A key pressed inside the panel stays in its sandboxed frame: the editor's
shortcuts never see it. A panel forwards Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y
(Cmd on macOS) with the `shortcut` message — the samples' `keydown` handler
does, except in a text field, which keeps its own undo. The editor runs it only
while that frame holds the focus, so a panel cannot undo on its own.

### Matching the editor (theme and panel kit)

After Effects' split, kept: the editor draws a plugin's **params** (the Effect
Controls card, from `EffectInfo.params`) and its **viewer handles** (overlay
geometry), so those always look native. A panel is the plugin's own page, and
the editor never restyles it. Like AE (`PF_AppColorSuite`, a CEP panel's skin
info and theme-changed event), it offers the panel its look instead. A panel
can use that look or ignore it. This applies to effect panels and to dockable
panels (below).

**The `theme` message.** Every panel frame gets
`{ premation: 1, type: 'theme', theme }` when it loads, again on `ready`
(before `state` / `context`), and whenever the user changes theme, high
contrast or density:

```js
theme = {
  name: 'dark' | 'light',
  contrast: 'normal' | 'more',            // 'more' = the high-contrast theme
  density: 'compact' | 'default' | 'comfortable',
  vars: { '--pm-surface-1': '#2b2b2e', '--pm-text': '#e1e1e1', … },  // resolved values
}
```

The `--pm-*` names are a stable contract: new ones may be added, and none is
renamed or removed. The list is in `src/core/nativePlugins/panelTheme.ts`:

| Group | Names |
|---|---|
| Surfaces | `--pm-surface-0` (app ground), `-1` (panels), `-2` (controls, wells), `-3` (popovers); `--pm-surface-hover`, `-active`, `-selected` |
| Text | `--pm-text`, `--pm-text-secondary`, `--pm-text-tertiary`, `--pm-text-disabled` |
| Lines | `--pm-border`, `--pm-border-strong`, `--pm-border-subtle`, `--pm-field-border`, `--pm-field-border-hover` |
| Accent | `--pm-accent`, `-hover`, `-active`, `-subtle`, `--pm-accent-text` (links), `--pm-on-accent`, `--pm-selection`, `--pm-focus-ring` |
| Status | `--pm-success`, `--pm-warning`, `--pm-danger`, `--pm-info` |
| Type | `--pm-font-family`, `--pm-font-family-mono` (values), `--pm-font-size`, `--pm-line-height`, `--pm-font-size-small`, `--pm-line-height-small`, `--pm-weight-label`, `--pm-weight-value`, `--pm-weight-heading` |
| Geometry (follows Density) | `--pm-radius`, `--pm-radius-surface`, `--pm-control-height`, `--pm-row-height`, `--pm-padding`, `--pm-gap` |

**The panel kit.** The app serves two files inside every panel's own origin,
at a path no bundle can ship, so they pass the panel's CSP as they are:

```html
<link rel="stylesheet" href="/.premation/premation-ui.css">
<script src="/.premation/premation-ui.js"></script>
<link rel="stylesheet" href="panel.css">  <!-- yours, after the kit -->
```

- `premation-ui.css` declares every `--pm-*` with the dark theme's values (the
  editor's default, so the first paint is already right). It styles **plain
  HTML** like the editor: body type and ground, `button` (plus `.pm-primary`
  and `.pm-quiet`), text / number / select / textarea fields, checkboxes, radios
  and ranges in the accent colour, focus rings and scrollbars. It also has a few
  layout helpers: `.pm-row`, `.pm-label`, `.pm-grow`, `.pm-hint`, `.pm-section`,
  `.pm-heading`, `.pm-list` (with `.pm-selected`), `.pm-value`, `.pm-mono`, and
  `.pm-success` / `-warning` / `-danger`.
- `premation-ui.js` applies each `theme` message: it sets the variables on
  `:root` and `data-theme` / `data-contrast` / `data-density` on `<html>`, then
  fires a `premationtheme` event (`detail` = the theme) for a panel that paints
  a canvas. `window.premationTheme()` returns the latest theme.

The kit is the app's, not the bundle's. Don't copy it into `ui/`. A panel
always gets the current editor's look, so after an editor update it may look
slightly different. Code against the `--pm-*` names, not exact pixels. A panel
that wants its own brand can skip the kit, or link it and override what it
needs. `statspanel` uses the kit and no colours of its own.

## Plugins that are not effects (SDK 1.2, P7)

After Effects has three plugin classes besides effects: AEGP (menu commands
that edit the project), AEIO (footage formats the app cannot read) and output
modules (formats the Render Queue writes), and AEGP plugins also dock panels.
Premation has all four. A bundle may list any of them in its manifest, with
or without effects (`effects` may then be empty or absent; docs/PLUGIN_STORE.md
§1 has the keys), and the module hands their entry points over in
`PrPluginInfo`'s SDK 1.2 trailing fields:

```c
const PrCommandEntry kCommands[] = {{"distribute", &distribute_main}};
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, "com.example.tools",
                            0, NULL,            /* effects */
                            1, kCommands,       /* SDK 1.2: commands (pr_command.h) */
                            0, NULL,            /* importers (pr_io.h) */
                            0, NULL};           /* output modules (pr_io.h) */
```

A 1.0 / 1.1 module's struct ends at `effects` and keeps loading: the host reads
the new fields only when `struct_size` covers them. A manifest entry without
its entry point (or the other way round) fails the plugin before it is used.
A disabled, failed, quarantined or locked plugin contributes nothing: its
commands leave the Plugins menu, its formats the import picker and the
Render Queue, its panels the dock.

| | AE | Premation | Header | Sample |
|---|---|---|---|---|
| Command | AEGP `AEGP_InsertMenuCommand` + command hook | manifest `commands`, `PrCommandEntry` | `pr_command.h` | `distribute` (Distribute Layers) |
| Importer | AEIO `AEIO_GetInSpecInfo`, `AEIO_DrawSparseFrame` | manifest `importers`, `PrImporterEntry` | `pr_io.h` | `ppmio` (.ppm / .pfm) |
| Output module | AEIO output (`AEIO_StartAdding`, `AEIO_AddFrame`, `AEIO_EndAdding`) | manifest `outputModules`, `PrOutputModuleEntry` | `pr_io.h` | `ppmseq` (a .ppm sequence) |
| Panel | AEGP panels (`AEGP_RegisterCreatePanelHook`) | manifest `panels` (no code: an HTML page) | — | `statspanel` (Layer Stats) |

### Commands (`pr_command.h`)

A command is one selector, `PR_COMMAND_RUN`, with a `PrCommandContext`: the
active composition, the selected layers (top first), the playhead (comp time,
ticks), the composition's frame rate and `args_json` (runPluginCommand's
`args`). It reads and edits the document through the **engine API** — the
same API the editor speaks — as JSON, through `PrCommandSuite`:

```c
const char* json; uint32_t len;
ctx->engine->engine_query(ctx->host_ref, "{\"type\":\"getComposition\",\"comp\":\"comp_1\"}", &json, &len);
ctx->engine->engine_command(ctx->host_ref,
    "{\"type\":\"setProperty\",\"prop\":{\"layer\":\"l2\",\"path\":\"transform/position\"},"
    "\"value\":{\"kind\":\"vec2\",\"value\":{\"x\":100,\"y\":50}},\"time\":0}", &json, &len);
```

- The JSON is the API's TypeScript object form (packages/engine-api types):
  flat unions (Command, Query and their results) carry `type`; other unions
  `kind` and `value`; enums their names; bytes base64; times integer ticks.
  The engine translates it with the schema itself (`api_schema.inc`, generated
  with the codec), so every query and edit command the schema has is there.
- A result is host-owned JSON, valid until RUN returns. An engine error answers
  `PR_ERR_INVALID_PARAM` (`PR_ERR_NOT_FOUND` for `notFound`) with
  `{"code": "…", "message": "…"}`.
- Only **edit** commands: no undo / redo, open / save, transport, jobs, or
  another runPluginCommand.
- **One invocation = one undo entry**, labelled with the command's name, origin
  `plugin`. Every edit lands in the request's journal as it is made (the next
  query sees it). If RUN returns an error, or any edit failed, or the plugin
  crashes, **all** of it rolls back. The command log keeps the edits the plugin
  made (a batch, `LogRecord.job` = `plugin:<id>/<command>`), never the
  runPluginCommand, so a crash replay does not run the plugin again.
- It runs in premation-engine on the core thread, under the crash guard, the
  crash journal and the watchdog. A crash rolls back, the command is off for the
  session (listed `enabled: false` with why) and `setPluginEnabled(true)`
  re-arms it; a hang quarantines the plugin and restarts the engine. A command
  that legitimately runs longer than the watchdog (baking expressions over a
  long comp, say) calls `progress()` as it goes: each call restarts the
  watchdog's clock (see "The watchdog" below).
- The editor: the **Plugins** menu (a submenu per manifest `menu`), the command
  palette ("Plugins: Distribute Layers"; Customize can bind a shortcut), and
  `runPluginCommand` from anywhere else (a plugin panel's `command`). The engine API:
  `listPluginCommands`, `runPluginCommand`.

### Importers (`pr_io.h`)

Files with an importer's extensions import and render through the plugin
instead of the engine's decoders:

| Selector | In | Out |
|---|---|---|
| `PR_IMPORT_PROBE` | `path` | `info`: size, `frame_rate` and `duration` (0 = a still), `has_alpha`, `linear`, `pixel_format`, audio format, `codec` |
| `PR_IMPORT_OPEN` | `path` | `file_data` (a handle the plugin owns) |
| `PR_IMPORT_READ_FRAME` | `time` (source time) | `frame`: a host world of `info.width × info.height` at `info.pixel_format` — straight RGBA, display-encoded unless `linear` |
| `PR_IMPORT_READ_AUDIO` | `audio_start`, `audio_frames` | `audio` (interleaved float32), `audio_frames_read` |
| `PR_IMPORT_CLOSE` | `file_data` | — |

- `importFiles` probes through the plugin (the Project panel shows its size,
  rate and codec); the media picker offers the extensions; Collect Files,
  Relink and Remove Unused treat the item like any footage.
- The texture feed reads frames through it (premultiplied there, encoded to
  sRGB when `linear`), cached by file, modification time and source time; at
  most 16 files stay open.
- A file the plugin refuses fails the import with "plugin failed to read …"
  (`io`). A failure at render time draws nothing for that layer and names it on
  `layerErrors`; the frame renders. A crash turns the importer off for the
  session (every read then fails with why) until the plugin is enabled again.
- Sound (`has_audio`, `READ_AUDIO`): the engine's audio decoders ask the
  plugin first (audio/external_audio.hpp), so the item's sound goes through
  the same down-mix and resampler as a decoded file — it plays in the
  playback mixer, is in the export mix (and an output module's
  `WRITE_AUDIO`) and is what the audio jobs analyse. A file with
  `width = height = 0` and `has_audio` is sound only (an audio item).
- Analysis jobs (tracker, stabilizer, scene detection, roto, …) read the
  item's frames through the importer too (jobs/media_input.cpp
  `open_plugin_frames`). The jobs that run in a child process (Object
  Matte, the face tracker; jobs/child_job.hpp) start a plugin host of their
  own from the engine's plugin folders, revocation list and entitlement
  token, with every plugin the engine does not run at that moment
  (disabled, quarantined, failed, revoked, locked, or with an importer that
  crashed this session) listed disabled: the same importer, the same frames,
  and no plugin code the engine would not run. A plugin crash there fails
  that job only.
- A job on footage whose importer's plugin does not run fails with why
  ("plugin failed to read 'x.ppm': plugin '…' is disabled"), rather than
  reading the file through another decoder.
- The `ppmio` sample reads a PPM holding several images back to back as
  moving footage (30 fps, or `# fps <n>` in the first header) and a second
  format, `.praw` (`PRAW <rate> <channels>` + interleaved float32), that is
  sound only.

### Output modules (`pr_io.h`)

An output module is an export format: `plugin:<plugin id>/<module id>` in the
Export dialog's **Plugins** category and in the Render Queue, with its declared
`options` drawn as controls (popup — the value a 1-based index —, number with
`min` / `max`, checkbox).

| Selector | What the module gets |
|---|---|
| `PR_OUTPUT_BEGIN` | `path` (what the user chose), size, frame rate, frame count, audio format (0 channels = none), `options_json` (`{ "<id>": value }`, defaults filled, clamped) → `job_data` |
| `PR_OUTPUT_WRITE_FRAME` | `frame_index` (0-based), `time`, `frame`: RGBA32F, straight alpha, display-encoded (the output space) — in order |
| `PR_OUTPUT_WRITE_AUDIO` | the mix, interleaved float32, after the frames |
| `PR_OUTPUT_END` | `cancelled` = 1 when the job did not finish |

The `ppmseq` sample writes `shot.wav` (32-bit float) beside `shot_00000.ppm` …
when the export carries sound.

The export job (`premation-engine --export`, job fields `sequence:
"plugin:…"`, `pluginPath`, `pluginOptions`) runs the module in its own
process with its own plugin host; the module writes its files itself (nothing
is moved afterwards). A crash or an error fails that job with the module's
message; the editor and the engine carry on.

### Panels (manifest `panels`)

A dockable panel with no effect behind it: `{ "id", "name", "page" }` shows
`ui/<page>` from the bundle in the P5 sandbox (`plugin-ui://<id>/<page>`,
`sandbox="allow-scripts"`, no Node, no storage, no network). The Plugins menu
▸ Panels opens it; it docks like any on-demand panel and pops out into its
own window (the window's route carries the id encoded, `#/popout/plugin%3A…%2F<panel>`). It talks to
the editor by `window.parent.postMessage({ premation: 1, … }, '*')`:

| Panel sends | What happens |
|---|---|
| `{ type: 'ready' }` | the editor answers `context` |
| `{ id, type: 'query', request }` | the engine API query (`{ type: 'getComposition', comp }`); the reply's `result` is its answer |
| `{ id, type: 'command', request, label? }` | one EDIT command, origin `plugin`: one undo entry (a `runPluginCommand` runs the plugin's own command) |
| `{ id, type: 'command', commands: [...], label }` | several edits as ONE undo entry |
| `{ type: 'shortcut', action: 'undo' \| 'redo' }` | Edit ▸ Undo / Redo for a key pressed in the panel (only while its frame has the focus; an `undo` COMMAND stays refused) |
| `{ id, type: 'settings', set? }` | the plugin's saved settings (`result`, an object; `{}` at first). `set` (an object, ≤ 256 KiB) replaces them first. Editor prefs, per user — never the document |
| `{ id, type: 'listEditorCommands' }` | `result.commands`: `{ id, label, shortcut, enabled }` for every editor command a panel may run |
| `{ id, type: 'editorCommand', command }` | runs that editor command as its menu item would — only while the frame has the focus (the click that asked was in the panel). File, app, account, help and plugin-management commands are refused |
| `{ id, type: 'runScript', source, name }` | runs a Premation script as File ▸ Scripts does: the user's consent prompt, the Script Editor console, one undo step. `result.value` is the script's return value. Same focus rule |
| `{ id, type: 'setShortcuts', shortcuts: [{ id, key, ctrl?, alt?, shift?, meta? }] }` | binds chords editor-wide while the panel is open; each needs Ctrl, Alt or Cmd (or is an F key). A chord an editor command owns is refused (`result.refused: [{ id, reason }]`). A press sends the panel `{ type: 'invoke', id }`, and for 2 s the panel may act as if clicked |
| `{ id, type: 'saveFile', name, text }` | the save dialog for a text file (≤ 1 MiB) named `name`. Same focus rule |
| `{ id, type: 'openFile', accept }` | the open dialog; `result` is `{ name, text }` (≤ 1 MiB) or null when cancelled. Same focus rule |

The editor sends `{ type: 'context', plugin, comp, layers, time, keyframes, properties }`
(`keyframes`: `[{ layer, key, path, member? }]`, the selected keys by engine id, for
`updateKeyframes`; `properties`: `[{ layer, path, member }]`, the selected property rows) on `ready`
and after every document change (undo and redo too), selection or time change,
and `{ type: 'reply', id, ok, result?, error? }` to each request. Requests over
1 MiB, non-edit commands (undo, save, transport, jobs) and unknown types are
refused with an error reply; nothing changes. It also sends `theme`, and the
panel kit works here too ("Matching the editor" above).

## Layer types (SDK 1.4)

A plugin can add its own **kind of layer**: Layer ▸ New ▸ <name>, beside Text and
Solid. A layer type is drawn by one of the bundle's own generator effects, so it needs
no new entry point:

```json
"effects":    [ { "matchName": "com.you.charts.bars", "name": "Bar Chart" } ],
"layerTypes": [ { "id": "bars", "name": "Bar Chart", "effect": "com.you.charts.bars" } ]
```

- The effect must declare `PR_OUT_FLAG_GENERATOR`. A layer type that names a
  non-generator fails the plugin at load and says why. The manifest says
  `"sdk": { "minor": 4 }`.
- The type's id is `<plugin id>:<id>`. `listPlugins` lists it under
  `PluginInfo.layerTypes` while the plugin is loaded.
- `createLayer { kind: generator, generator: "<plugin id>:<id>" }` makes a
  comp-sized solid with a transparent fill. The type's effect is its effect
  `layer`, marked `layerType`. `LayerInfo.kind` is `generator` and
  `LayerInfo.pluginLayerType` names the type. `LayerInfo.generator` stays
  empty: that field marks retired JavaScript plugin layers.
- The effect's params are the layer's own properties. Their paths are
  `effects/layer/<key>`; `createLayer`'s `init` may set them; they keyframe and
  take expressions like any property. The timeline shows them in the layer's
  Contents group, not under Effects.
- The layer's own effect stays first. It cannot be removed, duplicated, copied
  on its own or moved, and nothing can be added at index 0. Other effects stack
  after it as on any layer.
- Rendering is the generator path unchanged. The plugin draws layer pixels
  (`width × height`, the layer's size) through `layer_to_world`, so the layer's
  transform, masks, mattes, styles and blend mode apply.
- A missing or disabled plugin leaves the layer empty (the fill is
  transparent). The effect is reported on `layerErrors`, as any missing plugin
  effect is.
- The same effect still works as an ordinary effect on any layer.
- MCP: `create_layer { kind: "plugin", layerType }`. `list_capabilities kinds`
  lists `pluginLayerTypes`.

The `chartlayer` sample (`native/sdk/samples/chartlayer`) is a bar chart whose
Value 1–6 are animatable layer properties. Its golden renders run as ctest
`plugin_goldens_chartlayer`.

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

### The watchdog

A selector call that runs longer than the watchdog (10 s; `--watchdog <ms>`)
is a hang. The engine cannot stop a thread safely, so it quarantines the plugin
and ends; the supervisor restarts it.

**`progress()` extends commands, not renders** (decided 2026-10-27). In a P7
call — a command's `PR_CMD_RUN`, an importer or an output-module selector —
every `host->progress(host, fraction)` restarts that call's clock: the watchdog
measures the time since the last progress report, not since the call began. A
command may therefore run as long as it needs if it reports at least once per
watchdog period; report from the loop that does the work (every item, every
frame), not from a timer thread, so a command stuck in that loop still stops
reporting and is still caught. A command that reports nothing is held to 10 s
as before. Render selectors (`SMART_PRE_RENDER`, `SMART_RENDER[_GPU]`, `RENDER`)
and the setup/param selectors are not extended: a frame has a deadline, and a
render that needs more than 10 s is a hang whatever it reports. `fraction` is
informational (0..1); it need not grow.

The same report keeps the engine itself alive: a command runs on the engine's
core thread, and Electron's supervisor kills an engine whose core has been on
one item for 30 s (`stuckMs`, electron/engineSupervisor.ts) as a deadlock. A
command's progress also restarts that busy clock (`HostOptions::onProgress` →
the core watchdog in engine_process.cpp), so a reporting command outlasts both
limits and a silent one hits whichever comes first.

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
| `listPluginCommands` / `runPluginCommand` | SDK 1.2 commands (see "Commands"): one undo entry per run |
| `PluginInfo.commands` / `importers` / `outputModules` / `panels` | what a plugin contributes besides effects, from its manifest |

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

## Building an Element 3D class plugin

The `model3d` sample (`native/sdk/samples/model3d`, open source) is the
walkthrough: a glTF model drawn through the comp camera and lights, anywhere in
the frame, with motion blur and occlusion by the comp's 3D layers, on the GPU
and on the CPU. What it does, step by step, and the After Effects call each
step replaces:

| Step | Premation | After Effects |
|---|---|---|
| Draw on a solid of any size, anywhere in the frame | `PR_OUT_FLAG_COMP_SPACE`; project with `PrInData.comp_to_world` | `PF_OutFlag_I_EXPAND_BUFFER`, `result_rect` = the comp |
| Load the model | a `FILE` param (`file_types` `"glb\|gltf"`), `get_asset_bytes`; a `.gltf`'s `.bin` through `get_asset_sibling_bytes` | the plugin opens the path itself |
| Textures | a `FILE` image param through `get_asset_image_gpu` / `get_asset_image` (decoded by the engine, linear premultiplied); a `LAYER` param through `checkout_layer_gpu` / `checkout_layer_pixels` | `PF_CHECKOUT_PARAM` on a layer param; the plugin's own image loaders |
| Camera and lights | `PR_OUT_FLAG_USES_CAMERA` / `_USES_LIGHTS`; `get_comp_camera`, `get_comp_lights` | `AEGP_GetEffectCamera`, the light suites |
| Follow a layer | a `LAYER` param, `PR_OUT_FLAG_USES_LAYER_TRANSFORMS`, `get_layer_transform` | `AEGP_GetLayerToWorldXform` |
| Render on the GPU | `PR_OUT_FLAG_GPU_RENDER`, `SMART_RENDER_GPU`: your own pipelines and depth buffer on the engine's Dawn device, through `device->procs` | the GPU suites (`PF_GPUDeviceSuite`) |
| Motion blur | `PR_OUT_FLAG_USES_SHUTTER` + `PR_OUT_FLAG_SAMPLES_TIME`: `checkout_time` at the shutter's sub-times with `PR_SAMPLE_PARAMS \| _CAMERA \| _LAYER_TRANSFORMS`, one render per sample, averaged | `PF_OutFlag2_I_USE_SHUTTER_ANGLE`, `PF_CHECKOUT_PARAM` at other times |
| Occlusion by the comp's 3D layers | `PR_OUT_FLAG_USES_SCENE_DEPTH`, `checkout_scene_depth_gpu` / `checkout_scene_depth` | none: E3D renders the comp's layers itself |
| A handle in the viewer | `PR_OUT_FLAG_CUSTOM_OVERLAY`: `DRAW_OVERLAY` / `OVERLAY_DRAG` | `PF_Cmd_EVENT` |
| A setup panel | `ui/index.html`, the `setParam` / `requestPreview` messages | E3D's Scene Setup window |
| Works without a GPU | `SMART_RENDER`: the same maths on the CPU | the CPU render path |

**1. Flags and params.** `GLOBAL_SETUP` declares `SMART_RENDER | GENERATOR |
GPU_RENDER | USES_CAMERA | USES_LIGHTS | USES_LAYER_TRANSFORMS | SAMPLES_TIME |
USES_SHUTTER | COMP_SPACE | USES_SCENE_DEPTH | CUSTOM_OVERLAY`. The params:
Model (`FILE`), Position (`POINT_3D`, comp world px), X / Y / Z Rotation,
Size (the model's largest extent in px), Transform Layer (`LAYER`), a Material
group (Base Color, Roughness, Specular, Base Color Map, Texture Layer),
Composite with Scene Depth, Motion Blur, Render Mode (Shaded / Scene Depth) and
the samples' Debug group. Keep param ids stable: the document stores values by
them, and the panel addresses them as `p<id>`.

**2. The model.** `gltf_lite.hpp` reads `.glb` and `.gltf` (+ `.bin` through
`get_asset_sibling_bytes`, or a `data:` URI): triangle primitives, the node
hierarchy, positions, normals, uvs, indices and the first material's
`baseColorFactor`. Parse once per file content (the sample keys a cache by the
bytes' hash) — never per frame. No model chosen: a built-in cube. A chosen file
that is missing or unreadable returns `PR_ERR_NOT_FOUND` with the reason in
`return_msg`: the host records it on `layerErrors` and the frame renders, and
the instance stays enabled (an error return is not a fault).

**3. Space.** World space is After Effects' (px, +y down, +z away). glTF is +y
up and +z toward the viewer, so the model is turned 180° about x, centred on its
bounds and scaled to Size. A vertex goes model → world (the placement: Position
× rotations × size, or the Transform Layer's matrix) → camera
(`PrCamera.view`) → comp px (`PrCamera.projection`, divide by w) → world px
(`comp_to_world`). On the GPU the last two are one matrix: comp_to_world and
the NDC mapping lifted to act on homogeneous x, y, w. Depth is camera-space z
everywhere — the same unit as the scene depth, so the occlusion test is one
comparison.

**4. Shading.** Lambert diffuse + Blinn-Phong specular (shininess from
Roughness), two-sided, over up to 8 comp lights: ambient adds `albedo ×
colour × intensity`, parallel lights along `direction`, point lights from
`position`, spot lights with a smoothstep over the cone and feather. With no
light in the comp a headlight from the camera keeps the model readable (AE lights
unlit layers fully), with the same Blinn-Phong term (the light at the eye: `h = v`),
so Roughness and Specular show without a light too. The WGSL and the C++ are the
same function, line for line.

**5. The GPU path.** `GPU_DEVICE_SETUP` builds one WGSL module, an explicit bind
group layout (every texture `unfilterable-float` and read with `textureLoad`:
the `rgba32float` maps and the `r32float` depth are not filterable without a
device feature), a mesh pipeline into an `rgba16float` sample target with its
own `depth32float` buffer, an additive accumulation pipeline, and an output
pipeline per `PrGpuFormat`. `SMART_RENDER_GPU` uploads the model once per
content, writes one uniform slot per shutter sample, and records into the host's
encoder: per sample, the mesh pass then an additive pass (× 1/N) into the
accumulation; then the accumulation into the output. Never submit; never keep
the encoder. A GPU error is caught by the host's error scope and the frame
renders on the CPU path.

**6. Motion blur.** In `SMART_PRE_RENDER`, when `PrInData.motion_blur` is 1 and
`shutter_angle` > 0, call `checkout_time` for N = `motion_blur_samples`
(clamped to 2..16) sample times centred across `shutter_phase … shutter_phase +
shutter_angle`. In the render, read the camera (`get_comp_camera`), the
placement params (`checkout_param`) and the Transform Layer
(`get_layer_transform`) at each time; a time the host did not evaluate answers
`PR_ERR_NOT_FOUND` — skip that sample, never fail the frame. Lights are read at
the frame time.

**7. Scene depth.** With Composite with Scene Depth on, call
`checkout_scene_depth_gpu` and discard a fragment whose camera z is behind the
depth at its pixel (`z > depth + 0.5 + 0.001 z`: a small bias, so a model sitting
exactly on a card does not flicker). `PR_ERR_UNSUPPORTED` (no GPU): render
unoccluded. The CPU path does the same with `checkout_scene_depth`. Under motion
blur the sample also checks out `PR_SAMPLE_SCENE_DEPTH` at each shutter time and
occludes each sub-frame with `checkout_scene_depth_gpu_at` / `_at` at that time
(the frame's depth where a time was not evaluated).

**8. Viewer handle and panel.** `DRAW_OVERLAY` reads the comp camera at the
viewer's time (`get_comp_camera`), projects Position, switches to comp px
(`overlay_set_space(host, PR_OVERLAY_SPACE_COMP)`) and draws a crosshair handle
there inside a square of Size / 2 in the camera's view plane — on the model
under any camera. `OVERLAY_DRAG` gets the pointer in comp px
(`PrOverlayDragExtra.space`), solves for the camera-space point at the model's
own depth that projects to it (two linear equations in x, y), takes it back to
the world with `PrCamera.world` and writes Position with `set_param_value` — the
model moves in the camera's view plane, and the whole drag is one undo entry. On
a host without `overlay_set_space` it falls back to layer px at Position's x / y.
With a Transform Layer the layer places the model and no handle is drawn. The
panel (`ui/`) sets Base Color,
Roughness, Specular and the depth checkbox with `setParam` and shows a
`requestPreview`.

**9. The CPU path.** `SMART_RENDER` runs the same transform and shading in a
small rasteriser: per output row (`iterate`), every triangle over that row,
perspective-correct barycentrics, a z-buffer in camera z, nearest texels. It is
lower quality — no near-plane clipping (a triangle reaching behind the eye is
dropped), no filtering — but a machine without a GPU still gets the frame.

**10. Tests.** `engine_plugins_tests` (`tests/test_plugin_model3d.cpp`): the cube
through the camera, `.glb` and `.gltf` + `.bin` giving the same picture, a missing
model as a layer error, CPU occlusion against a depth, the Debug ▸ Fault popup in a
child process. `engine_plugins_gpu_tests`: the scene depth's values (camera z, +inf,
the effect's own layer excluded, one pass per frame), GPU vs CPU coverage, and
occlusion on both paths. Golden scenes (`packages/render-tests`):
`plugin-model3d-orbit` (camera orbit, a checker Base Color Map, point + ambient
light), `plugin-model3d-blur` (the sample's own motion blur under a camera pan),
`plugin-model3d-occlusion` (a 3D card in front of the model).
`models/make_models.mjs` regenerates the test assets (a 2 × 1 × 1 box as `.glb`
and as `.gltf` + `.bin`, an 8 × 8 checker), all made for the sample.

## Starting a plugin

`create-premation-plugin.mjs` (in the SDK's `share/premation-sdk/`, source
`scripts/create-premation-plugin.mjs`) writes a complete project:

```sh
node sdk/share/premation-sdk/create-premation-plugin.mjs glow --id com.you.glow --name "Glow" --template effect
```

| Template | What you get |
|---|---|
| `effect` | a C++ effect: CPU smart render, 8/16/32 bpc, rows in parallel (a tint mixed by Amount, to replace) |
| `fx` | an effect written once in WGSL with fxkit (below): GPU path + generated C++ CPU twin (a vignette) |
| `command` | a Plugins-menu command that edits the project through `engine_command`, one undo step (nudges the selection) |

Each has `CMakeLists.txt` (`find_package(PremationSdk)`), the manifest,
`tests/cases.json` for the test kit, a README, `.gitignore` and the CI
workflow from `examples/plugin-ci/` (three platforms, golden renders, a signed
`.pplugin`, publish on a `v*` tag). All three build against an installed SDK
and load in `premation-plugins` (checked 2026-11-03 on Windows / clang-cl).
The script is not on npm; run it from the SDK.

## Writing effects in WGSL: fxkit

fxkit (`native/sdk/fxkit/`, installed as `share/premation-sdk/fxkit/` and
`include/premation_fxkit/`) writes an effect **once**: the GPU runs the WGSL,
and `fxkit.mjs` transpiles the same kernel to C++ for the CPU path. The
plugin stays a native module (decision G2): fxkit is a code generator, not a
script runtime. It is the generator the Atelier pack is built with.

A project is a folder with `fxkit.json` (the manifest, plus an optional
`"fxkit": { "category", "families", "catalogJs" }` block) and `fx/*.fx`:

```text
/*@fx
{ "name": "Chroma Split", "family": "Distort", "summary": "…",
  "params": [ { "id": 1, "key": "amount", "type": "float", "name": "Amount", "unit": "px",
                "default": 12, "min": 0, "max": 400 } ],
  "expand": "amount + 2",
  "presets": [ { "name": "Subtle Lens", "values": { "amount": 4 } } ] }
*/
fn effect(p: vec2f) -> vec4f {
  let d = vec2f(prm.amount, 0.0);
  return vec4f(src(p - d).r, src(p).g, src(p + d).b, src(p).a);
}
```

- `node fxkit.mjs <project>` writes `gen/fx_gen.hpp`, `gen/lib.inc`,
  `gen/catalog.json` and `premation-plugin.json`; `--check` fails if any is
  out of date (and holds the kit's swizzle tables to the generator).
  `premation_add_fx_plugin(name PROJECT <dir> [DAWN_INCLUDE_DIR <dir>])`
  runs it at configure time and again when an `.fx` changes. Without
  `DAWN_INCLUDE_DIR` the plugin renders on its CPU twin only.
- Params: `float`, `int`, `angle`, `checkbox`, `popup`, `color`, `point`,
  `layer` (one aux layer, read with `aux(p)`), groups and buttons; ids 1..899
  (900+ are the kit's: Mix or Composite/Opacity, a hidden Set Values button,
  a hidden path tag). `"unit": "px"` lengths are scaled with the preview
  resolution; points arrive in world px; colours in linear light. `"show"`
  hides a param by an expression over the others.
- The kernel sees `p` in world px (pixel centres) and returns premultiplied
  linear RGBA. Inputs: `src(p)`, `texel(i)`, `level(k, p)` (a pyramid of up
  to 6 levels, `"pyramid": n`), `pass_a(p)` / `pass_b(p)` (up to 2 earlier
  full-frame passes, `"passes": ["blur_x", "blur_y"]`), `aux(p)`. Frame:
  `to_layer`, `to_world`, `layer_size`, `world_size`, `comp_size`, `time_s`,
  `px_scale`, `quality`. Library (`fxkit/std.fx`, plus your own
  `fx/_lib.fx`): hashes, value / gradient noise, fBm, Voronoi, complex maths,
  sRGB / OKLab / HSV, blend helpers, `blurred`, `luma_grad`.
- `"generator": true` composites over the layer (Composite popup);
  `"animated": true` re-renders every frame; `"expand"` grows the output
  (an expression over the params, in px).
- The WGSL subset (`fxkit.mjs` refuses anything else, naming the file): `fn`
  with typed params, `let` / `var` / `const`, `if (…)`, `for` / `loop`,
  `vec2f`/`vec3f`/`vec4f`/`vec2i`/`f32`/`i32`/`u32`, read-only swizzles,
  `array<T, N>`. No structs, ternaries (use `select`), float `%` (use
  `fmodp`), vector compares, swizzle assignment, matrices or `discard`.
- Parity: the CPU twin is built with `-ffp-contract=off`.
  `engine_plugins_gpu_tests "[fxkit]"` holds the sample's GPU and CPU paths to
  within one 8-bit step, 2.4e-4 at 16 bpc and 8.1e-7 at 32 bpc (RTX 4060,
  2026-11-03).

## Hot reload (Developer Mode)

Plugins ▸ Installed ▸ **Developer Mode**: turn on *Reload plugins when they
are rebuilt* and add your build output folder (a bundle folder or a folder of
bundles, e.g. `build/plugins`). The editor then:

1. Restarts the engine with each dev folder as one more `--plugins` and with
   `--plugin-shadow <userData>/plugin-shadow/<launch>`. Every plugin binary,
   and the `.dll` / `.so` / `.dylib` files beside it, loads from a copy there.
   Your linker can therefore overwrite the original while Premation runs.
   Windows locks a loaded DLL, so without the copy the build fails. The open
   project is replayed across the restart.
2. Watches the dev folders. When a bundle's binary or manifest changes and
   the writes stop for 0.8 s, it sends the engine `reloadPlugin` for that
   bundle's plugin id and shows a toast.

`reloadPlugin` (engine API, also callable from scripts and panels) loads the
bundle again beside the old one. The new build is swapped in only after its
`GLOBAL_SETUP` and `PARAMS_SETUP` succeed:

- Renders already running finish on the old module.
- Each instance is set down by the old build and set up again from the
  document's flat sequence data (`SEQUENCE_RESETUP`) on its next render.
  Sequence data must therefore survive a rebuild, or be rebuilt from defaults.
- The effect definitions, commands and panels follow the new manifest.
- The RAM and disk frame caches are purged.
- A build that does not load, or a manifest that does not parse or changed
  its id, keeps the old module loaded. The error names the reason.
- A quarantine from the previous build is lifted, and crashed instances get a
  new chance.

What a reload does not do:

- The old module stays mapped for the life of the engine, because its code
  may still be on a stack.
- GPU data it set up is released when the device goes away or the engine
  stops, not at the reload. A threaded GPU render may still be using it.
- Shadow copies are per launch. Older launches' folders are removed at the
  next start.
- A plugin that finds its own files through its module path (instead of the
  host's asset callbacks) sees the shadow folder.

Developer Mode is per user, stored in `<native-plugins>/.dev.json`, never in
a project.

## Golden tests: `premation-plugins test`

```sh
premation-plugins --plugins build/plugins/glow test tests/cases.json --bless   # write tests/golden/*.pgold
premation-plugins --plugins build/plugins/glow test tests/cases.json           # compare
```

`cases.json` is `{ "cases": [ { "name", "effect", "bits"?, "size"?, "time"?,
"params"?, "tolerance"? } ] }`. `params` are keyed by SDK param id (`v[0]`,
or `[v0, v1, v2, v3]` for colours and points). Each case renders the host's
test pattern on the CPU path and compares it with
`tests/golden/<name>.pgold` (float RGBA). The default tolerance is one 8-bit
step at 8 bpc, 1e-3 at 16 and 1e-4 at 32. A failure prints the max
difference and writes `<name>.actual.pgold` next to the golden. The exit code
is 0 only when every case passes. The fxkit sample's cases run in ctest as
`plugin_goldens_fxkit`.

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
