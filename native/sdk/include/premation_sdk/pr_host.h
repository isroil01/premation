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
  void(PR_CALL* progress)(PrHost* host, double fraction);
  void(PR_CALL* log)(PrHost* host, int32_t level, const char* message);

  /* ── render selectors ──
   * Run fn(refcon, thread_index, i, count) for every i in [0, count) on the
   * host's worker threads (each call is crash-guarded too); returns the first
   * non-zero PrErr. `thread_index` < iterate_threads() — index per-thread scratch with it. */
  PrErr(PR_CALL* iterate)(PrHost* host, int32_t count, void* refcon, PrIterateFn fn);
  int32_t(PR_CALL* iterate_threads)(PrHost* host);
} PrHostSuite;

#ifdef __cplusplus
}
#endif

#endif /* PREMATION_SDK_PR_HOST_H */
