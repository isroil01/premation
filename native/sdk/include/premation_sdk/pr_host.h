/*
 * Premation native plugin SDK — the host's callback suite.
 *
 * PrInData.host points at this table for every selector; pass PrInData.host_ref
 * as the first argument. A callback used outside the selectors it is listed
 * for returns PR_ERR_INVALID_CALLBACK. New callbacks are only ever APPENDED
 * (check `struct_size` before calling one newer than the SDK minor you target).
 *
 * Threading: the host may run PR_CMD_RENDER / SMART_PRE_RENDER / SMART_RENDER /
 * SMART_RENDER_GPU of different frames on different threads at once (the
 * engine builds one frame while it renders another). Everything else
 * (setup, sequence, params UI) is serialised per plugin module. During render
 * selectors sequence data is READ-ONLY (After Effects' multi-frame rendering
 * rule).
 */
#ifndef PREMATION_SDK_PR_HOST_H
#define PREMATION_SDK_PR_HOST_H

#include "pr_gpu.h"
#include "pr_params.h"
#include "pr_scene.h"
#include "pr_ml.h"
#include "pr_types.h"
#include "pr_world.h"

#ifdef __cplusplus
extern "C" {
#endif

#define PR_LOG_DEBUG 0
#define PR_LOG_INFO 1
#define PR_LOG_WARN 2
#define PR_LOG_ERROR 3

/** A row / tile job for PrHostSuite.iterate: process item `i` of `count`. */
typedef PrErr(PR_CALL* PrIterateFn)(void* refcon, int32_t thread_index, int32_t i, int32_t count);

typedef struct PrHostSuite {
  uint32_t struct_size;

  /* ── memory (any selector) ──
   * Handles are host memory, so a flattened sequence-data block can be read by
   * the host, and a plugin can never free engine memory by mistake. A pointer
   * from handle_lock stays valid until handle_resize / handle_dispose. Global
   * data lives until GLOBAL_SETDOWN, sequence data until SEQUENCE_SETDOWN
   * (the host disposes what a plugin forgets); a handle created during a
   * render selector is disposed when the call returns. */
  PrHandle(PR_CALL* handle_new)(PrHost* host, size_t size); /* zero-filled; 0 on failure */
  void*(PR_CALL* handle_lock)(PrHost* host, PrHandle h);    /* NULL for 0 / unknown handles */
  size_t(PR_CALL* handle_size)(PrHost* host, PrHandle h);
  PrErr(PR_CALL* handle_resize)(PrHost* host, PrHandle h, size_t size);
  void(PR_CALL* handle_dispose)(PrHost* host, PrHandle h);

  /* ── PR_CMD_PARAMS_SETUP ── declare the next parameter (copied). */
  PrErr(PR_CALL* add_param)(PrHost* host, const PrParamDef* def);

  /* ── PR_CMD_SMART_PRE_RENDER ──
   * Ask for a layer's pixels at a time. `param_index` 0 = the effect's input
   * (the layer as it enters this effect), otherwise a PR_PARAM_LAYER param's
   * index. `time` is a LAYER time in PR_TIME_SCALE ticks (in_data->current_time
   * for "now"). `checkout_id` is the plugin's own number for the request. The
   * result rect (world pixels) is written to `out_rect` (may be NULL). */
  PrErr(PR_CALL* checkout_layer)(PrHost* host, uint32_t param_index, uint32_t checkout_id, int64_t time,
                                 PrRect* out_rect);

  /* ── PR_CMD_SMART_RENDER ──
   * The pixels of a checkout made in pre-render (a world the host owns, valid
   * until the selector returns; *out_world = NULL when the layer is empty or
   * absent), and the output world. */
  PrErr(PR_CALL* checkout_layer_pixels)(PrHost* host, uint32_t checkout_id, PrWorld** out_world);
  PrErr(PR_CALL* checkout_output)(PrHost* host, PrWorld** out_world);

  /* ── PR_CMD_SMART_RENDER_GPU ── a checkout as a GPU texture (see pr_gpu.h). */
  PrErr(PR_CALL* checkout_layer_gpu)(PrHost* host, uint32_t checkout_id, const PrGpuWorld** out_world);

  /* ── PR_CMD_UPDATE_PARAMS_UI / PR_CMD_USER_CHANGED_PARAM ──
   * Change how a parameter is shown (PR_PARAM_UI_* flags; `name` NULL keeps it). */
  PrErr(PR_CALL* set_param_ui)(PrHost* host, uint32_t param_index, uint32_t ui_flags, const char* name);
  /* ── PR_CMD_USER_CHANGED_PARAM only ──
   * Write a parameter's value (the same encoding as PrParamDef.value; `count`
   * values). The write joins the user's edit in ONE undo step. On an animated
   * parameter it sets the keyframe at the current time. */
  PrErr(PR_CALL* set_param_value)(PrHost* host, uint32_t param_index, const double* value, uint32_t count);
  /* Replace an ARBITRARY_DATA parameter's bytes (USER_CHANGED_PARAM only). */
  PrErr(PR_CALL* set_arb_data)(PrHost* host, uint32_t param_index, const uint8_t* data, uint32_t size);

  /* ── any selector ── */
  /** Non-zero when the host wants the current render abandoned (return PR_ERR_INTERRUPTED). */
  int32_t(PR_CALL* abort_requested)(PrHost* host);
  /** How far the call is (0..1). In a command, importer or output-module call it
   * also restarts the watchdog's clock, so a long command that reports progress
   * at least once per watchdog period (10 s) is never treated as a hang. Render
   * selectors are not extended (docs/PLUGIN_SDK.md, "The watchdog"). */
  void(PR_CALL* progress)(PrHost* host, double fraction);
  void(PR_CALL* log)(PrHost* host, int32_t level, const char* message);

  /* ── render selectors ──
   * Run fn(refcon, thread_index, i, count) for every i in [0, count) on the
   * host's worker threads (each call is crash-guarded too); returns the first
   * non-zero PrErr. `thread_index` < iterate_threads() — index per-thread scratch with it. */
  PrErr(PR_CALL* iterate)(PrHost* host, int32_t count, void* refcon, PrIterateFn fn);
  int32_t(PR_CALL* iterate_threads)(PrHost* host);

  /* ── SDK 1.1 (appended; check struct_size >= offsetof(PrHostSuite, get_layer_transform)
   *    + sizeof(void*) before calling) ── the render selectors, at the frame's time
   * (`time` = in_data->current_time) or, SDK 1.2, a layer time the effect checked out in
   * SMART_PRE_RENDER (checkout_time); any other time answers PR_ERR_NOT_FOUND
   * (PR_ERR_UNSUPPORTED on an SDK 1.1 host).
   * Declare PR_OUT_FLAG_USES_CAMERA / _USES_LIGHTS / _USES_LAYER_TRANSFORMS in
   * GLOBAL_SETUP, or these answer PR_ERR_INVALID_CALLBACK. See pr_scene.h.
   * SDK 1.2: also in PR_CMD_DRAW_OVERLAY / PR_CMD_OVERLAY_DRAG, at the viewer's time
   * (in_data->current_time; any other time: PR_ERR_NOT_FOUND) — project a 3D point for a
   * comp-space handle (overlay_set_space). */
  PrErr(PR_CALL* get_comp_camera)(PrHost* host, int64_t time, PrCamera* out_camera);
  /* Up to `capacity` lights into `out_lights` (each struct_size set by the caller);
   * the comp's light count (≤ PR_MAX_LIGHTS) into *out_count. */
  PrErr(PR_CALL* get_comp_lights)(PrHost* host, int64_t time, PrLight* out_lights, uint32_t capacity, uint32_t* out_count);
  /* A PR_PARAM_LAYER param's world matrix (layer px → comp world px, column-major).
   * PR_ERR_NOT_FOUND when the param names no layer. A 2D layer is its 2D
   * transform at z = 0. */
  PrErr(PR_CALL* get_layer_transform)(PrHost* host, uint32_t param_index, int64_t time, double out_matrix[16]);

  /* ── SDK 1.1, PR_CMD_DRAW_OVERLAY only ── the viewer overlay's draw list, layer px
   * (the editor maps it with the layer like a mask; SDK 1.2: composition px after
   * overlay_set_space(host, PR_OVERLAY_SPACE_COMP)). Colours are straight RGBA 0..1;
   * NULL = the viewer's handle colour. At most 256 items and 2048 points per call, 192 per path. */
  PrErr(PR_CALL* overlay_line)(PrHost* host, double x0, double y0, double x1, double y1, const float* rgba);
  PrErr(PR_CALL* overlay_path)(PrHost* host, const double* xy, uint32_t point_count, int32_t closed, const float* rgba);
  /* A draggable handle; `handle_id` comes back in PrOverlayDragExtra. `shape`: PR_OVERLAY_HANDLE_*. */
  PrErr(PR_CALL* overlay_handle)(PrHost* host, uint32_t handle_id, double x, double y, uint32_t shape);
  /* ── SDK 1.1, any selector with params (render, USER_CHANGED_PARAM, overlays) ──
   * A FILE param's asset. get_asset_path writes the absolute path (UTF-8, NUL-terminated)
   * into `buf` (`*out_len` = its length without the NUL; PR_ERR_OUT_OF_MEMORY and the
   * length needed when `capacity` is too small). get_asset_bytes reads the file once per
   * call (at most 512 MiB); `*data` stays valid until the selector returns.
   * PR_ERR_INVALID_PARAM: not a FILE param; PR_ERR_NOT_FOUND: none chosen or missing. */
  PrErr(PR_CALL* get_asset_path)(PrHost* host, uint32_t param_index, char* buf, uint32_t capacity, uint32_t* out_len);
  PrErr(PR_CALL* get_asset_bytes)(PrHost* host, uint32_t param_index, const uint8_t** data, uint64_t* size);

  /* ── SDK 1.2 (appended; check struct_size >= offsetof(PrHostSuite, get_asset_sibling_bytes)
   *    + sizeof(void*) before calling) ── */
  /* PR_CMD_SMART_PRE_RENDER, PR_OUT_FLAG_SAMPLES_TIME only: the effect will read `what`
   * (PR_SAMPLE_* bits, pr_scene.h) at LAYER time `time` in its render selectors. Asking again
   * for a time adds bits. At most PR_MAX_TIME_SAMPLES times per instance and frame
   * (PR_ERR_OUT_OF_MEMORY past that). Camera / lights / transforms also need their USES_* flag. */
  PrErr(PR_CALL* checkout_time)(PrHost* host, int64_t time, uint32_t what);
  /* Render selectors: param `param_index` at layer time `time` — in_data->current_time (the
   * param as params[] has it) or a time checked out with PR_SAMPLE_PARAMS (else
   * PR_ERR_NOT_FOUND). The caller sets out_def->struct_size; pointers inside stay valid until
   * the selector returns. AE's PF_CHECKOUT_PARAM. */
  PrErr(PR_CALL* checkout_param)(PrHost* host, uint32_t param_index, int64_t time, PrParamDef* out_def);
  /* Any selector with params: a FILE param's image (png, jpg, tiff, exr, hdr, …) decoded by the
   * engine to linear, premultiplied RGBA32F (PR_PIXEL_FORMAT_RGBA32F; origin 0, 0). The host
   * keeps it per file and modification time; *out_world stays valid until the selector returns.
   * PR_ERR_UNSUPPORTED: not an image the engine reads. */
  PrErr(PR_CALL* get_asset_image)(PrHost* host, uint32_t param_index, PrWorld** out_world);
  /* PR_CMD_SMART_RENDER_GPU only: the same image as an rgba32float texture on the engine's
   * device, uploaded once and kept per file and modification time (dropped with the device). */
  PrErr(PR_CALL* get_asset_image_gpu)(PrHost* host, uint32_t param_index, const PrGpuWorld** out_world);
  /* Any selector with params: a file beside a FILE param's asset — a glTF's `.bin` and textures,
   * an `.obj`'s `.mtl`. `relative` is a UTF-8 path under the asset's folder ('/' separators;
   * no "..", no absolute path, no symlink out: PR_ERR_INVALID_PARAM). At most 512 MiB
   * (PR_ERR_OUT_OF_MEMORY); *data stays valid until the selector returns. */
  PrErr(PR_CALL* get_asset_sibling_bytes)(PrHost* host, uint32_t param_index, const char* relative, const uint8_t** data,
                                          uint64_t* size);

  /* ── SDK 1.2, scene depth (appended after get_asset_sibling_bytes; check struct_size >=
   *    offsetof(PrHostSuite, checkout_scene_depth) + sizeof(void*) before calling) ──
   * Declare PR_OUT_FLAG_USES_SCENE_DEPTH in GLOBAL_SETUP, or these answer PR_ERR_INVALID_CALLBACK.
   *
   * The depth of the composition's 3D layers OTHER than the effect's own layer, seen through the
   * comp camera at the frame's time — Element 3D's "Composite with scene depth". It is world-sized:
   * pixel (x, y) is world pixel (x, y) of this render, so layer_to_world / comp_to_world line up
   * with it. Each pixel holds the CAMERA-SPACE Z of the nearest surface: the distance from the eye
   * ALONG THE VIEW AXIS, in composition px — (view · p).z with PrCamera.view (pr_scene.h), positive in
   * front of the camera; not the straight-line distance to the eye. Compare a fragment's own
   * (view · p).z with it. +INFINITY where no 3D layer is drawn. A texel whose coverage (texture alpha
   * × mask × layer opacity, or a solid's shape) is under 1/255 writes no depth, as in the engine's
   * own 3D pass; any other one does (depth is not blended). The 3D layers are the ones of the
   * composition the effect's layer is in — with the 3D layers inside its collapsed (continuously
   * rasterized) 3D precomps, posed as the 3D renderer draws them — at the frame time (a motion-blur
   * sub-time: checkout_scene_depth_gpu_at below).
   *
   * It is an input of the frame: moving a 3D layer re-renders the effect. The engine renders it
   * once per frame and render size for every effect that asks, and only when one asks.
   *
   * checkout_scene_depth_gpu — PR_CMD_SMART_RENDER_GPU: an r32float texture on the engine's device
   *   (PR_GPU_FORMAT_R32_FLOAT, TEXTURE_BINDING | COPY_SRC; read it with textureLoad), valid until
   *   the selector returns.
   * checkout_scene_depth — PR_CMD_SMART_RENDER / PR_CMD_RENDER: a PrWorld of PR_PIXEL_FORMAT_R32F
   *   (one float per pixel, row_bytes apart), the same depth read back from the GPU; the host owns
   *   it until the selector returns.
   * PR_ERR_UNSUPPORTED (and *out = NULL): this render has no GPU to draw the depth with (the SDK's
   * CPU host in premation-plugins and the host tests) — render without occlusion. Call them from the
   * selector's own thread, not from an iterate() job. */
  PrErr(PR_CALL* checkout_scene_depth_gpu)(PrHost* host, const PrGpuWorld** out_world);
  PrErr(PR_CALL* checkout_scene_depth)(PrHost* host, PrWorld** out_world);

  /* ── SDK 1.2, overlay space (appended after checkout_scene_depth; check struct_size >=
   *    offsetof(PrHostSuite, overlay_set_space) + sizeof(void*) before calling) ──
   * PR_CMD_DRAW_OVERLAY only: what the coordinates of the overlay_line / overlay_path /
   * overlay_handle calls that FOLLOW are in — PR_OVERLAY_SPACE_LAYER (the default: layer px, the
   * editor maps them with the layer like a mask) or PR_OVERLAY_SPACE_COMP (composition px: a point
   * the plugin projected through the comp camera itself — get_comp_camera, which DRAW_OVERLAY and
   * OVERLAY_DRAG may call at in_data->current_time — drawn by the viewer's comp → screen only).
   * A handle's OVERLAY_DRAG reports the pointer in that handle's space (PrOverlayDragExtra.space).
   * PR_ERR_INVALID_PARAM for another value. */
  PrErr(PR_CALL* overlay_set_space)(PrHost* host, uint32_t space);

  /* ── SDK 1.2, scene depth at another time (appended after overlay_set_space; check struct_size >=
   *    offsetof(PrHostSuite, checkout_scene_depth_at) + sizeof(void*) before calling) ──
   * The scene depth (checkout_scene_depth_gpu / checkout_scene_depth above, same format, same
   * PR_ERR_UNSUPPORTED without a GPU) at LAYER time `time`: in_data->current_time (the frame's own
   * depth), or a time the effect checked out in SMART_PRE_RENDER with checkout_time(...,
   * PR_SAMPLE_SCENE_DEPTH) — the comp's 3D layers posed at that time, seen through the comp camera
   * at that time (else PR_ERR_NOT_FOUND). What an effect that renders its own motion blur
   * (PR_OUT_FLAG_USES_SHUTTER) occludes each sub-frame with. A layer the engine cannot pose at the
   * time (a precomp's instance copy) keeps its frame pose. Each distinct time is its own pass. */
  PrErr(PR_CALL* checkout_scene_depth_gpu_at)(PrHost* host, int64_t time, const PrGpuWorld** out_world);
  PrErr(PR_CALL* checkout_scene_depth_at)(PrHost* host, int64_t time, PrWorld** out_world);

  /* ── SDK 1.3, Effect Controls boxes (appended after checkout_scene_depth_at; check struct_size >=
   *    offsetof(PrHostSuite, ui_text) + sizeof(void*) before calling) ──
   * PR_CMD_DRAW_PARAM_UI only (else PR_ERR_INVALID_CALLBACK), in the box's px, with overlay_line /
   * overlay_path / overlay_handle (which DRAW_PARAM_UI also takes). Colours are straight RGBA 0..1;
   * NULL = the editor theme's (see PrParamUiExtra). Same limits as the overlay: 256 items, 2048 points.
   *
   * ui_fill: a filled polygon (`point_count` x, y pairs, 3..192), drawn under the lines that follow.
   * ui_text: one line of UTF-8 (≤ 256 bytes) at (x, y) = its baseline's start (PR_UI_TEXT_LEFT), centre
   *   (_CENTER) or end (_RIGHT), `size` px (6..48), in the editor's UI font. */
  PrErr(PR_CALL* ui_fill)(PrHost* host, const double* xy, uint32_t point_count, const float* rgba);
  PrErr(PR_CALL* ui_text)(PrHost* host, double x, double y, const char* utf8, double size, uint32_t align, const float* rgba);

  /* ── SDK 1.4, simulations (appended after ui_text; check struct_size >= offsetof(PrHostSuite,
   *    get_sim_state) + sizeof(void*)) ──
   * get_sim_state: in SMART_RENDER / SMART_RENDER_GPU of a PR_OUT_FLAG_STATEFUL effect, the state
   * after this frame's PR_CMD_SIM_STEP (host-owned, valid for the call). PR_ERR_NOT_FOUND when the
   * frame has none (a step failed); PR_ERR_INVALID_CALLBACK elsewhere. */
  PrErr(PR_CALL* get_sim_state)(PrHost* host, const void** data, uint32_t* size);

  /* ── SDK 1.4, published channels (appended after get_sim_state; check struct_size >=
   *    offsetof(PrHostSuite, read_channel) + sizeof(void*)) ──
   * publish_channel: in PR_CMD_PUBLISH_CHANNELS only — this frame's value of a channel the
   *   manifest lists under the effect's "publishes" (1..PR_MAX_CHANNEL_VALUES finite numbers;
   *   copied). A channel two instances publish in one frame is an error on the second.
   * read_channel: in PUBLISH_CHANNELS, SMART_PRE_RENDER, SMART_RENDER(_GPU) and RENDER — a channel
   *   the manifest lists under "reads": up to `capacity` numbers into `out`, the channel's length in
   *   `*count`. PR_ERR_NOT_FOUND when no instance published it this frame. The host runs the frame's
   *   publishers in the order these declarations give and refuses a cycle (layerErrors). */
  PrErr(PR_CALL* publish_channel)(PrHost* host, const char* name, const double* values, uint32_t count);
  PrErr(PR_CALL* read_channel)(PrHost* host, const char* name, double* out, uint32_t capacity, uint32_t* count);

  /* ── SDK 1.4, the ML suite (pr_ml.h; appended after read_channel; check struct_size >=
   *    offsetof(PrHostSuite, ml_provider) + sizeof(void*)) ──
   * ml_load: a model the bundle ships ("models/<name>.onnx"); any selector of an effect. The same
   *   file is the same id for the plugin's every instance. PR_ERR_NOT_FOUND: no such file;
   *   PR_ERR_UNSUPPORTED: no runtime in this build; PR_ERR_INVALID_PARAM: a path outside models/.
   * ml_run: the render selectors only. Inputs are float32 tensors; each output's data / count /
   *   shape / rank is filled by the host (memory valid until the selector returns). Outputs named
   *   NULL are the model's outputs in order. PR_ERR_INTERNAL: the run failed (its reason in the log).
   * ml_provider: where the model runs ("dml", "coreml", "cuda", "cpu"), NUL-terminated. */
  PrErr(PR_CALL* ml_load)(PrHost* host, const char* bundle_path, uint32_t* out_model);
  PrErr(PR_CALL* ml_run)(PrHost* host, uint32_t model, const PrTensor* inputs, uint32_t input_count, PrTensor* outputs, uint32_t output_count);
  PrErr(PR_CALL* ml_provider)(PrHost* host, uint32_t model, char* out, uint32_t capacity);

  /* ── SDK 1.4, the 3D scene (pr_scene.h; appended after ml_provider; check struct_size >=
   *    offsetof(PrHostSuite, scene_add_light) + sizeof(void*)) ──
   * PR_CMD_SCENE_CONTRIBUTE only. scene_add_mesh copies the mesh (≤ PR_MAX_SCENE_MESHES per
   * frame); scene_add_light adds a light (a PrLight with its position and direction in LAYER px,
   * ≤ 8 per frame). PR_ERR_INVALID_PARAM: a malformed mesh (an index out of range, a NaN). */
  PrErr(PR_CALL* scene_add_mesh)(PrHost* host, const PrSceneMesh* mesh);
  PrErr(PR_CALL* scene_add_light)(PrHost* host, const PrLight* light);
} PrHostSuite;

/* SDK 1.3: ui_text's `align`. */
#define PR_UI_TEXT_LEFT 0
#define PR_UI_TEXT_CENTER 1
#define PR_UI_TEXT_RIGHT 2

#define PR_OVERLAY_HANDLE_SQUARE 0
#define PR_OVERLAY_HANDLE_CIRCLE 1
#define PR_OVERLAY_HANDLE_CROSSHAIR 2

/* SDK 1.2: overlay_set_space / PrOverlayDragExtra.space. */
#define PR_OVERLAY_SPACE_LAYER 0
#define PR_OVERLAY_SPACE_COMP 1

#ifdef __cplusplus
}
#endif

#endif /* PREMATION_SDK_PR_HOST_H */
