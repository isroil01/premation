/*
 * Premation native plugin SDK — effects: the entry point, command selectors,
 * in/out data and flags. Modelled on the After Effects effect API
 * (PF_Cmd / PF_InData / PF_OutData / EffectMain); docs/PLUGIN_SDK.md maps
 * every selector and flag to its AE twin.
 *
 * A plugin module (a .dll / .dylib / .so beside a manifest, see
 * docs/PLUGIN_SDK.md "Packaging") exports ONE symbol:
 *
 *     PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void);
 *
 * which lists the module's effects, each with its own single entry point
 *
 *     PrErr PR_CALL EffectMain(PrCmd cmd, const PrInData* in_data, PrOutData* out_data,
 *                              PrParamDef* const* params, PrWorld* output, void* extra);
 *
 * that dispatches on `cmd`.
 */
#ifndef PREMATION_SDK_PR_EFFECT_H
#define PREMATION_SDK_PR_EFFECT_H

#include "pr_command.h"
#include "pr_gpu.h"
#include "pr_host.h"
#include "pr_io.h"
#include "pr_params.h"
#include "pr_types.h"
#include "pr_world.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ── command selectors ──────────────────────────────────────────────────────
 *   cmd                        extra                     what the plugin does
 *   ABOUT                      —                         write an about text into out_data->return_msg
 *   GLOBAL_SETUP               —                         set out_flags (+ my_version, global_data)
 *   GLOBAL_SETDOWN             —                         free global_data
 *   PARAMS_SETUP               —                         add_param() each parameter, in order
 *   SEQUENCE_SETUP             —                         a new instance: out_data->sequence_data = new handle
 *   SEQUENCE_RESETUP           —                         in_data->sequence_data is the FLAT copy from the
 *                                                        project; rebuild (out_data->sequence_data)
 *   SEQUENCE_FLATTEN           —                         out_data->sequence_data = a flat (pointer-free)
 *                                                        handle the host saves in the project
 *   SEQUENCE_SETDOWN           —                         free in_data->sequence_data
 *   FRAME_SETUP / _SETDOWN     —                         around RENDER (non-smart effects)
 *   RENDER                     —                         params[0]->world → output, params at the frame time
 *   SMART_PRE_RENDER           PrPreRenderExtra*         checkout_layer() what render will need
 *   SMART_RENDER               PrSmartRenderExtra*       checkout_layer_pixels() / checkout_output(), render
 *   USER_CHANGED_PARAM         PrUserChangedParamExtra*  react to a supervised param / button
 *   UPDATE_PARAMS_UI           —                         set_param_ui() (enable / hide / rename)
 *   GPU_DEVICE_SETUP           PrGpuDeviceSetupExtra*    see pr_gpu.h
 *   GPU_DEVICE_SETDOWN         PrGpuDeviceSetupExtra*
 *   SMART_RENDER_GPU           PrSmartRenderGpuExtra*
 *   DRAW_OVERLAY (1.1)         PrOverlayExtra*           overlay_line / _path / _handle: the viewer
 *                                                        overlay, in layer px (PR_OUT_FLAG_CUSTOM_OVERLAY;
 *                                                        1.2: or comp px, overlay_set_space)
 *   OVERLAY_DRAG (1.1)         PrOverlayDragExtra*       a handle was dragged: set_param_value / set_arb_data
 *                                                        (the whole drag is ONE undo step)
 *   LIST_ASSET_FILES (1.2)     PrListAssetFilesExtra*    the files a FILE param's asset reads beside itself
 *                                                        (a .gltf's buffers and images): add_file() each,
 *                                                        relative to the asset's folder. Document side,
 *                                                        at Collect Files; no render, no instance.
 *   DRAW_PARAM_UI (1.3)        PrParamUiExtra*           a PR_PARAM_CUSTOM_UI row in Effect Controls (AE's
 *                                                        custom ECW UI, PF_Cmd_EVENT draw): overlay_line /
 *                                                        _path / _handle, ui_fill, ui_text, in the box's px
 *   PARAM_UI_DRAG (1.3)        PrParamUiDragExtra*       a handle in that box was dragged: set_param_value /
 *                                                        set_arb_data (the whole drag is ONE undo step)
 */
typedef int32_t PrCmd;
#define PR_CMD_ABOUT 0
#define PR_CMD_GLOBAL_SETUP 1
#define PR_CMD_GLOBAL_SETDOWN 2
#define PR_CMD_PARAMS_SETUP 3
#define PR_CMD_SEQUENCE_SETUP 4
#define PR_CMD_SEQUENCE_RESETUP 5
#define PR_CMD_SEQUENCE_FLATTEN 6
#define PR_CMD_SEQUENCE_SETDOWN 7
#define PR_CMD_FRAME_SETUP 8
#define PR_CMD_FRAME_SETDOWN 9
#define PR_CMD_RENDER 10
#define PR_CMD_SMART_PRE_RENDER 11
#define PR_CMD_SMART_RENDER 12
#define PR_CMD_USER_CHANGED_PARAM 13
#define PR_CMD_UPDATE_PARAMS_UI 14
#define PR_CMD_GPU_DEVICE_SETUP 15
#define PR_CMD_GPU_DEVICE_SETDOWN 16
#define PR_CMD_SMART_RENDER_GPU 17
#define PR_CMD_DRAW_OVERLAY 18 /* SDK 1.1 */
#define PR_CMD_OVERLAY_DRAG 19 /* SDK 1.1 */
#define PR_CMD_LIST_ASSET_FILES 20 /* SDK 1.2 */
#define PR_CMD_DRAW_PARAM_UI 21 /* SDK 1.3 */
#define PR_CMD_PARAM_UI_DRAG 22 /* SDK 1.3 */
#define PR_CMD_SIM_STEP 23 /* SDK 1.4: one simulation step (PR_OUT_FLAG_STATEFUL, PrSimStepExtra) */
#define PR_CMD_PUBLISH_CHANNELS 24 /* SDK 1.4 (C): publish this frame's channels (PR_OUT_FLAG_PUBLISHES) */
#define PR_CMD_SCENE_CONTRIBUTE 25 /* SDK 1.4 (D): add meshes / lights to the comp's 3D scene (PR_OUT_FLAG_SCENE_CONTRIBUTE) */
#define PR_CMD_COUNT 26

/* ── out flags (GLOBAL_SETUP) ─────────────────────────────────────────────── */
#define PR_OUT_FLAG_DEEP_COLOR_AWARE (1u << 0)     /* processes 16-bit worlds */
#define PR_OUT_FLAG_FLOAT_COLOR_AWARE (1u << 1)    /* processes 32-bit float worlds */
#define PR_OUT_FLAG_SMART_RENDER (1u << 2)         /* SMART_PRE_RENDER + SMART_RENDER instead of RENDER */
#define PR_OUT_FLAG_GPU_RENDER (1u << 3)           /* SMART_RENDER_GPU on the engine's WebGPU device */
#define PR_OUT_FLAG_SEQUENCE_DATA (1u << 4)        /* per-instance state: the SEQUENCE_* selectors */
#define PR_OUT_FLAG_GENERATOR (1u << 5)            /* draws without reading its input */
#define PR_OUT_FLAG_WIDE_TIME_INPUT (1u << 6)      /* checks out layers at other times */
#define PR_OUT_FLAG_NON_PARAM_VARY (1u << 7)       /* output changes with time even when no param does */
#define PR_OUT_FLAG_SEND_UPDATE_PARAMS_UI (1u << 8) /* wants UPDATE_PARAMS_UI */
#define PR_OUT_FLAG_THREADED_RENDER (1u << 9)      /* render selectors are safe to run concurrently */
/* SDK 1.1 (pr_scene.h): the effect reads the comp camera / lights / layer transforms;
 * the engine evaluates them for it, and they become inputs of its render. */
#define PR_OUT_FLAG_USES_CAMERA (1u << 10)
#define PR_OUT_FLAG_USES_LIGHTS (1u << 11)
#define PR_OUT_FLAG_USES_LAYER_TRANSFORMS (1u << 12)
/* SDK 1.1: draws a viewer overlay (DRAW_OVERLAY) with draggable handles (OVERLAY_DRAG) — AE's PF_Cmd_EVENT. */
#define PR_OUT_FLAG_CUSTOM_OVERLAY (1u << 13)
/* SDK 1.2: asks for param values / camera / lights / layer transforms at other times
 * (checkout_time in SMART_PRE_RENDER, then checkout_param & co. in the render selectors) —
 * AE's PF_CHECKOUT_PARAM at another time. Needs PR_OUT_FLAG_SMART_RENDER. */
#define PR_OUT_FLAG_SAMPLES_TIME (1u << 14)
/* SDK 1.2: renders its own motion blur from PrInData's shutter fields (AE's
 * PF_OutFlag2_I_USE_SHUTTER_ANGLE): the engine does not supersample the layer through it. */
#define PR_OUT_FLAG_USES_SHUTTER (1u << 15)
/* SDK 1.2: the output covers the composition frame, not the layer (Element 3D, Optical Flares
 * on a solid of any size): draw with PrInData.comp_to_world. */
#define PR_OUT_FLAG_COMP_SPACE (1u << 16)
/* SDK 1.2: reads the depth of the comp's 3D layers (PrHostSuite.checkout_scene_depth[_gpu]) —
 * Element 3D's "Composite with scene depth". Only an effect that declares it (and then asks) pays
 * for the depth pass. */
#define PR_OUT_FLAG_USES_SCENE_DEPTH (1u << 17)
/* SDK 1.4: a SIMULATION — frame N needs the state after frame N-1 (particles with forces, cloth,
 * a bouncing body). The host calls PR_CMD_SIM_STEP once per layer frame, in order from the layer's
 * frame 0 (state_in NULL), and keeps the states: a frame renders with the state after its own step
 * (PrHostSuite.get_sim_state in SMART_RENDER / SMART_RENDER_GPU). Scrubbing back reuses kept
 * states; an edit re-steps from the first frame whose inputs changed. The plugin never caches. */
#define PR_OUT_FLAG_STATEFUL (1u << 18)
/* SDK 1.4 (C): the effect publishes named channels each frame (PR_CMD_PUBLISH_CHANNELS, publish_channel)
 * that other instances read (read_channel). The manifest lists each effect's "publishes" / "reads". */
#define PR_OUT_FLAG_PUBLISHES (1u << 19)
/* SDK 1.4 (D): on a 3D layer, PR_CMD_SCENE_CONTRIBUTE each frame adds meshes and lights to the
 * comp's 3D render (scene_add_mesh / scene_add_light, pr_scene.h); the host draws them. */
#define PR_OUT_FLAG_SCENE_CONTRIBUTE (1u << 20)
/** SDK 1.4 (C): the most numbers one channel carries. */
#define PR_MAX_CHANNEL_VALUES 4096

typedef int32_t PrQuality;
#define PR_QUALITY_DRAFT 0
#define PR_QUALITY_HIGH 1

/** What the host tells every selector. Valid for the duration of the call. */
typedef struct PrInData {
  uint32_t struct_size;
  uint32_t host_sdk_version; /* PR_SDK_VERSION of the host */
  const PrHostSuite* host;
  PrHost* host_ref; /* first argument of every host callback */

  const char* match_name; /* the effect's match name (manifest) */
  uint32_t num_params;    /* entries in params[], including params[0] */

  /* time, in PR_TIME_SCALE ticks */
  int64_t current_time; /* LAYER time of the frame being rendered */
  int64_t comp_time;    /* composition time of the frame */
  int64_t time_step;    /* one frame */
  uint32_t time_scale;  /* PR_TIME_SCALE */
  double frame_rate;    /* composition frames per second */

  /* the layer and the world's geometry */
  int32_t width, height;     /* the layer's size, layer pixels */
  int32_t world_width, world_height;
  /** layer pixel (x, y) → world pixel: wx = m[0]x + m[1]y + m[2], wy = m[3]x + m[4]y + m[5]
   *  (row-major 3×3, last row 0 0 1). World pixels are what worlds / GPU textures index. */
  double layer_to_world[9];
  /** World pixels per layer pixel along the layer's x and y axes (the matrix's column lengths):
   *  scale pixel-sized params (a blur radius in layer px) by these. */
  double pixel_scale_x, pixel_scale_y;

  uint32_t project_bit_depth; /* 8, 16 or 32 */
  PrQuality quality;
  PrHandle global_data;
  PrHandle sequence_data;
  /** Stable, opaque instance key (layer + effect ids) for plugin-side caches. NULL outside instances. */
  const char* instance_key;

  /* ── SDK 1.2 (appended: check struct_size >= offsetof(PrInData, comp_to_world) + sizeof(comp_to_world)) ── */
  /** The composition time of layer time 0 (ticks): comp time = layer_start + layer time for a layer
   *  with no stretch / remap. With a stretch, map times through checkout_time instead. */
  int64_t layer_start;
  double comp_width, comp_height; /* the composition, px */
  int32_t layer_is_3d;            /* 1 = the layer is a 3D layer */
  /** 1 when the composition's motion-blur switch and the layer's are both on for this render
   *  (the viewer's preview switch off, or a draft render, gives 0). */
  int32_t motion_blur;
  double shutter_angle;          /* degrees (the composition's setting, 0..720) */
  double shutter_phase;          /* degrees */
  uint32_t motion_blur_samples;  /* the composition's samples per frame */
  uint32_t reserved_1_2;         /* 0 */
  /** Composition pixel (x, y) → world pixel, like layer_to_world (row-major 3×3). On a 2D layer this
   *  is the view of the composition the chain renders in; on a 3D layer (whose chain runs in the
   *  layer's own plane) composition pixels are taken as the layer's pixels. */
  double comp_to_world[9];
} PrInData;

/** What the plugin tells the host. The host zero-fills it before each call
 *  (global_data / sequence_data preset to the current handles). */
typedef struct PrOutData {
  uint32_t struct_size;
  uint32_t my_version; /* PR_VERSION(...) (GLOBAL_SETUP) */
  uint32_t out_flags;  /* PR_OUT_FLAG_* (GLOBAL_SETUP) */
  PrHandle global_data;
  PrHandle sequence_data;
  char return_msg[PR_MAX_MESSAGE]; /* ABOUT text, or why a call failed; NUL-terminated */
} PrOutData;

/** SDK 1.4, PR_CMD_SIM_STEP's `extra`. Params are this step's (the layer frame's) values; in_data's
 *  current_time is the step's layer time. Deterministic: the same document gives the same states on
 *  every machine and in export — use `seed` for randomness, never a clock or an unseeded RNG. */
typedef struct PrSimStepExtra {
  uint32_t struct_size;
  /** The state after the previous step (host-owned bytes, valid for this call); NULL at frame 0. */
  const void* state_in;
  uint32_t state_in_size;
  /** Layer frame index (0 = the layer's first frame) and its seconds per frame. */
  int64_t frame;
  double dt;
  /** Per instance, stable for the life of the effect: a seed for the plugin's own RNG. */
  uint32_t seed;
  /** Set by the plugin: the new state, a handle it made with handle_new (the host disposes it).
   *  0 = the state did not change (state_in is kept). */
  PrHandle state_out;
} PrSimStepExtra;

typedef struct PrPreRenderExtra {
  uint32_t struct_size;
  PrRect request_rect;    /* in: the output region the host needs (world pixels) */
  /* out: what the plugin will produce (preset to request_rect). SDK 1.2: a rect past the
   * layer (e.g. a glow's halo, a flare off the layer) grows the layer's effect buffer — the
   * engine asks once per frame with the world = the layer's own pixels (layer_to_world the
   * identity), capped at the engine's texture limit. */
  PrRect result_rect;
  PrHandle pre_render_data; /* out: handed to SMART_RENDER(_GPU); disposed by the host afterwards */
} PrPreRenderExtra;

typedef struct PrSmartRenderExtra {
  uint32_t struct_size;
  PrHandle pre_render_data;
} PrSmartRenderExtra;

typedef struct PrUserChangedParamExtra {
  uint32_t struct_size;
  uint32_t param_index; /* the param the user changed / the button pressed */
  /* SDK 1.1 (check struct_size): data a plugin panel sent with the button
   * (invokeEffectAction's payload, UTF-8, not NUL-terminated); NULL / 0 for none. */
  const uint8_t* payload;
  uint32_t payload_size;
} PrUserChangedParamExtra;

/* SDK 1.1 — DRAW_OVERLAY. The params are the effect's values at the viewer's time. */
typedef struct PrOverlayExtra {
  uint32_t struct_size;
  double layer_width; /* the layer, px: the overlay's coordinate space */
  double layer_height;
  /* SDK 1.2 (check struct_size): the composition, px — the space of PR_OVERLAY_SPACE_COMP items
   * (PrHostSuite.overlay_set_space). The comp camera is get_comp_camera at in_data->current_time. */
  double comp_width;
  double comp_height;
} PrOverlayExtra;

#define PR_OVERLAY_DRAG_BEGIN 0
#define PR_OVERLAY_DRAG_MOVE 1
#define PR_OVERLAY_DRAG_END 2

/* SDK 1.1 — OVERLAY_DRAG: handle `handle_id` (from overlay_handle) is at (x, y), layer px
 * (SDK 1.2: in the handle's `space`). Write params with set_param_value (an animated one keys at
 * the current time). Every phase of one drag lands in the same undo step. */
typedef struct PrOverlayDragExtra {
  uint32_t struct_size;
  uint32_t handle_id;
  int32_t phase; /* PR_OVERLAY_DRAG_* */
  double x, y;   /* the pointer, layer px */
  double start_x, start_y; /* where the drag began, layer px */
  /* SDK 1.2 (check struct_size): PR_OVERLAY_SPACE_* the handle was drawn in — x, y, start_x, start_y
   * are composition px for a PR_OVERLAY_SPACE_COMP handle. */
  uint32_t space;
  uint32_t reserved_1_2; /* 0 */
} PrOverlayDragExtra;

/* SDK 1.3 — DRAW_PARAM_UI: draw PR_PARAM_CUSTOM_UI param `param_index`'s box in Effect Controls, (0, 0)
 * its top-left, `width` × `height` px (the card's width; the height the param declared). The params
 * are the effect's values at the editor's time. The editor draws the list in its own theme: an item
 * with a NULL colour takes the theme's (lines and paths: the secondary text colour; text: the text
 * colour; fills: the control surface; handles: the accent), so a box that passes NULL matches light,
 * dark and high contrast. */
typedef struct PrParamUiExtra {
  uint32_t struct_size;
  uint32_t param_index;
  double width;
  double height;
} PrParamUiExtra;

/* SDK 1.3 — PARAM_UI_DRAG: handle `handle_id` in param `param_index`'s box is at (x, y), box px
 * (PR_OVERLAY_DRAG_* phases, as OVERLAY_DRAG). Write params with set_param_value / set_arb_data;
 * every phase of one drag lands in the same undo step. */
typedef struct PrParamUiDragExtra {
  uint32_t struct_size;
  uint32_t param_index;
  uint32_t handle_id;
  int32_t phase;           /* PR_OVERLAY_DRAG_* */
  double x, y;             /* the pointer, box px */
  double start_x, start_y; /* where the drag began, box px */
  double width, height;    /* the box, px (as DRAW_PARAM_UI had it) */
} PrParamUiDragExtra;

/* PR_CMD_LIST_ASSET_FILES (SDK 1.2): Collect Files asks which files beside a FILE param's asset
 * the effect reads with get_asset_sibling_bytes, so the collected project carries them (the
 * asset itself is always carried). Called on the document side — no render, no instance, the
 * effect's params as the document holds them — crash-guarded and under the watchdog. Call
 * add_file(refcon, relative) once per file: '/'-separated, relative to the asset's folder, the
 * same rules as get_asset_sibling_bytes (no "..", no absolute path or drive). A file that is not
 * there is reported, never fatal. Not implemented (PR_ERR_NONE without a call, or an SDK 1.0 /
 * 1.1 module): only the asset is carried. */
typedef struct PrListAssetFilesExtra {
  uint32_t struct_size;
  uint32_t param_index;   /* the FILE param (as in params[]) */
  const char* asset_path; /* UTF-8, the asset as a file on disk */
  void* refcon;
  PrErr(PR_CALL* add_file)(void* refcon, const char* relative);
} PrListAssetFilesExtra;

typedef PrErr(PR_CALL* PrEffectMainFn)(PrCmd cmd, const PrInData* in_data, PrOutData* out_data,
                                        PrParamDef* const* params, PrWorld* output, void* extra);

typedef struct PrEffectEntry {
  const char* match_name; /* must equal the manifest's effect matchName */
  PrEffectMainFn main;
} PrEffectEntry;

/** SDK 1.4 (E1/E2): a pure function the plugin offers to expressions (`plugin["<id>"].<name>(…)`)
 *  and, when the manifest lists it under `interpolators`, as a keyframe interpolator
 *  (args: [t, v0, v1] → [value], t 0..1 through the segment). Numbers in (`args`, arrays
 *  flattened), up to `*out_count` numbers out (capacity in, count out; 1 = a number, more = an
 *  array). No host, no state, no I/O: called from any thread, under the watchdog. */
typedef PrErr(PR_CALL* PrExprFn)(const double* args, uint32_t arg_count, double* out, uint32_t* out_count);
typedef struct PrExprEntry {
  const char* name; /* the manifest's expressionFunctions[].name */
  PrExprFn fn;
} PrExprEntry;
#define PR_EXPR_MAX_OUT 16

typedef struct PrPluginInfo {
  uint32_t struct_size;
  uint32_t sdk_version;  /* PR_SDK_VERSION the module was built with */
  const char* plugin_id; /* must equal the manifest's id */
  uint32_t effect_count;
  const PrEffectEntry* effects;
  /* ── SDK 1.2 (appended; the host reads them only when struct_size covers them, so a 1.0 / 1.1
   *    module, whose struct ends at `effects`, keeps loading): what the module contributes besides
   *    effects. Each id must be listed in the manifest's matching key, and every manifest entry
   *    must have its entry point here. ── */
  uint32_t command_count;                      /* pr_command.h — manifest `commands` */
  const PrCommandEntry* commands;
  uint32_t importer_count;                     /* pr_io.h — manifest `importers` */
  const PrImporterEntry* importers;
  uint32_t output_module_count;                /* pr_io.h — manifest `outputModules` */
  const PrOutputModuleEntry* output_modules;
} PrPluginInfo;

typedef const PrPluginInfo*(PR_CALL* PrPluginInfoFn)(void);
#define PR_PLUGIN_INFO_SYMBOL "PremationPluginInfo"

/* SDK 1.4 (E1/E2): a module with expression functions also exports
 *   const PrExprTable* PremationPluginExpressions(void);
 * (a separate symbol, so PrPluginInfo — and every plugin initialising it — is unchanged). */
typedef struct PrExprTable {
  uint32_t struct_size;
  uint32_t count;
  const PrExprEntry* entries;
} PrExprTable;
typedef const PrExprTable*(PR_CALL* PrExprTableFn)(void);
#define PR_EXPR_TABLE_SYMBOL "PremationPluginExpressions"

#ifdef __cplusplus
}
#endif

#endif /* PREMATION_SDK_PR_EFFECT_H */
