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

#include "pr_gpu.h"
#include "pr_host.h"
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
#define PR_CMD_COUNT 18

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

typedef struct PrPreRenderExtra {
  uint32_t struct_size;
  PrRect request_rect;    /* in: the output region the host needs (world pixels) */
  PrRect result_rect;     /* out: what the plugin will produce (preset to request_rect) */
  PrHandle pre_render_data; /* out: handed to SMART_RENDER(_GPU); disposed by the host afterwards */
} PrPreRenderExtra;

typedef struct PrSmartRenderExtra {
  uint32_t struct_size;
  PrHandle pre_render_data;
} PrSmartRenderExtra;

typedef struct PrUserChangedParamExtra {
  uint32_t struct_size;
  uint32_t param_index; /* the param the user changed / the button pressed */
} PrUserChangedParamExtra;

typedef PrErr(PR_CALL* PrEffectMainFn)(PrCmd cmd, const PrInData* in_data, PrOutData* out_data,
                                        PrParamDef* const* params, PrWorld* output, void* extra);

typedef struct PrEffectEntry {
  const char* match_name; /* must equal the manifest's effect matchName */
  PrEffectMainFn main;
} PrEffectEntry;

typedef struct PrPluginInfo {
  uint32_t struct_size;
  uint32_t sdk_version;  /* PR_SDK_VERSION the module was built with */
  const char* plugin_id; /* must equal the manifest's id */
  uint32_t effect_count;
  const PrEffectEntry* effects;
} PrPluginInfo;

typedef const PrPluginInfo*(PR_CALL* PrPluginInfoFn)(void);
#define PR_PLUGIN_INFO_SYMBOL "PremationPluginInfo"

#ifdef __cplusplus
}
#endif

#endif /* PREMATION_SDK_PR_EFFECT_H */
