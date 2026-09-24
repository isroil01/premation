/*
 * Premation native plugin SDK — the declarative parameter model.
 *
 * During PR_CMD_PARAMS_SETUP a plugin declares its parameters, in order, with
 * PrHostSuite.add_param (pr_host.h). The engine owns them from then on: they
 * are ordinary effect properties in the document — keyframeable, expression-
 * driven, undoable, saved with the project, edited through the engine API and
 * listed by the editor's generic effect UI. At render time the plugin receives
 * every parameter's value AT THE FRAME'S TIME in params[] (index 0 is the
 * input layer, AE's convention; user parameters start at 1, in declaration
 * order, group markers included).
 *
 * Parameter ids: `id` is the parameter's identity on disk (AE's disk id).
 * It must be > 0, unique within the effect, and never reused for something
 * else — the document stores values by it (`p<id>`), so a plugin update may
 * reorder, rename or add parameters freely, but must keep ids.
 */
#ifndef PREMATION_SDK_PR_PARAMS_H
#define PREMATION_SDK_PR_PARAMS_H

#include "pr_types.h"
#include "pr_world.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef int32_t PrParamType;
#define PR_PARAM_LAYER 0          /* a layer of the composition (params[0] is the effect's input) */
#define PR_PARAM_SLIDER 1         /* integer slider */
#define PR_PARAM_FLOAT_SLIDER 2   /* float slider */
#define PR_PARAM_ANGLE 3          /* degrees */
#define PR_PARAM_POINT 4          /* 2D point, layer pixels */
#define PR_PARAM_POINT_3D 5       /* 3D point, layer pixels */
#define PR_PARAM_COLOR 6          /* RGBA, straight (unpremultiplied), 0..1 */
#define PR_PARAM_POPUP 7          /* one of `popup_choices`, 1-based */
#define PR_PARAM_CHECKBOX 8
#define PR_PARAM_PATH 9           /* a mask of the effect's layer (its bezier at the frame time) */
#define PR_PARAM_GROUP_START 10   /* a twirly group; ends at the matching GROUP_END */
#define PR_PARAM_GROUP_END 11
#define PR_PARAM_ARBITRARY_DATA 12 /* opaque bytes the plugin owns (static, saved with the project) */
#define PR_PARAM_BUTTON 13        /* a button: pressing it sends PR_CMD_USER_CHANGED_PARAM */

/* PrParamDef.flags */
#define PR_PARAM_FLAG_CANNOT_ANIMATE (1u << 0)  /* never keyframeable */
#define PR_PARAM_FLAG_SUPERVISE (1u << 1)       /* send PR_CMD_USER_CHANGED_PARAM when the user changes it */
#define PR_PARAM_FLAG_HIDDEN (1u << 2)          /* not shown in the effect UI (still a document property) */
#define PR_PARAM_FLAG_START_COLLAPSED (1u << 3) /* GROUP_START: twirled up */
#define PR_PARAM_FLAG_DISABLED (1u << 4)        /* shown greyed out (UPDATE_PARAMS_UI may flip it) */

/* PrHostSuite.set_param_ui flags */
#define PR_PARAM_UI_DISABLED (1u << 0)
#define PR_PARAM_UI_HIDDEN (1u << 1)

/** Most popup choices (`popup_choices` is split on '|'). */
#define PR_MAX_POPUP_CHOICES 64

/**
 * One parameter.
 *
 * SETUP (add_param): the plugin fills type, id, name, flags, the default in
 * `value`, and the type's range / choices. Strings are copied by the host
 * before add_param returns.
 *
 * RENDER (params[i]): the host fills every field for the frame's time;
 * pointers stay valid for the duration of the selector call only.
 *
 * Value encoding in `value[4]`, by type:
 *   SLIDER / FLOAT_SLIDER / ANGLE  value[0]
 *   POINT                          value[0..1] = x, y in LAYER pixels from the layer's top-left
 *                                  (AE's convention). The default is declared as an OFFSET FROM
 *                                  THE LAYER CENTRE in layer pixels (so it is size-independent);
 *                                  the host adds width/2, height/2 before delivering it.
 *   POINT_3D                       value[0..2] (same convention; z as declared)
 *   COLOR                          value[0..3] = r, g, b, a (straight, 0..1, working space)
 *   POPUP                          value[0] = 1-based choice index
 *   CHECKBOX                       value[0] = 0 or 1
 *   others                         unused
 */
typedef struct PrParamDef {
  uint32_t struct_size;
  PrParamType type;
  uint32_t id;
  uint32_t flags;
  const char* name; /* UTF-8 */

  double value[4];
  /* SLIDER / FLOAT_SLIDER / ANGLE: the valid range (values are clamped to it)
   * and the slider's range (the UI's default span). */
  double valid_min, valid_max;
  double slider_min, slider_max;
  int32_t precision;          /* decimal places the UI shows (FLOAT_SLIDER, ANGLE) */
  const char* popup_choices;  /* POPUP: "Choice A|Choice B|Choice C" */

  /* ── render-time only ── */
  /** LAYER: the referenced layer's id (NULL = none). params[0]: the effect's own layer. */
  const char* layer_id;
  /** LAYER (non-smart PR_CMD_RENDER only): the layer's pixels; params[0]: the input world. */
  PrWorld* world;
  /** PATH: the mask's cubic bezier at the frame's time, in layer pixels: `path_count` vertices,
   *  each 6 doubles (x, y, in-tangent dx, dy, out-tangent dx, dy — tangents relative to the vertex). */
  const double* path;
  uint32_t path_count;
  int32_t path_closed;
  /** ARBITRARY_DATA: the stored bytes (NULL/0 = none stored yet). */
  const uint8_t* arb_data;
  uint32_t arb_size;
} PrParamDef;

#ifdef __cplusplus
}
#endif

#endif /* PREMATION_SDK_PR_PARAMS_H */
