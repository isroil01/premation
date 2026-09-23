/*
 * Premation native core — motion_expr: property expressions.
 *
 * The C ABI over the port of packages/animation/src/expressions.ts (the
 * expression language: parsed, never executed as code). Semantics are the
 * TypeScript's, exactly — including its error text — as gated by
 * native/tests/golden_expr.inc, which the TypeScript itself generates.
 *
 *   motion_expr_compile   source (UTF-8) → handle. A SYNTAX error is not a
 *                         call failure: the handle carries it and every
 *                         evaluation reports it (as `compileExpression` does).
 *   motion_expr_eval      evaluate a handle for one context. The expression's
 *                         own failure (unknown name, bad argument, budget) is
 *                         a MOTION_EXPR_RESULT_ERROR result with its message,
 *                         not a status: the call itself succeeded.
 *   motion_expr_free      release a handle (NULL is a no-op).
 *
 * A compiled handle is immutable; any number of threads may evaluate it at
 * once. The evaluation budget (200 000 AST steps, depth 512) is per thread and
 * is SHARED with evaluations started from inside a host callback on the same
 * thread — so a cross-layer chain cannot multiply it, as in TypeScript.
 *
 * The host: every callback in motion_expr_host may be NULL, meaning "no such
 * provider", which is not the same as a provider that finds nothing (see each
 * field). Callbacks must not throw or longjmp; they may re-enter
 * motion_expr_eval (that is how a cross-layer read evaluates the other
 * layer's expression). Strings passed to and from callbacks are UTF-8 with an
 * explicit length and are valid only for the duration of the call.
 *
 * Source Text evaluation (text.sourceText, the style object, runText) is
 * available through the C++ API (libs/motion_expr/expr.hpp) only for now: its
 * data is a tree of optional strings that the engine protocol, not this
 * header, will carry. Reading text.sourceText through this ABI reports the
 * TypeScript's "this layer has no Source Text" error.
 */

#ifndef MOTION_EXPR_H
#define MOTION_EXPR_H

// NOLINTBEGIN(modernize-use-using, modernize-deprecated-headers, modernize-macro-to-enum, modernize-redundant-void-arg, modernize-avoid-c-arrays, cppcoreguidelines-avoid-c-arrays, cppcoreguidelines-macro-usage, performance-enum-size, cppcoreguidelines-use-enum-class)

#include <stddef.h>
#include <stdint.h>

#include "motion_abi.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct motion_expr motion_expr;

/** Capacity of a result's message, including the NUL. UTF-8, truncated on a
 *  code point boundary. */
#define MOTION_EXPR_MESSAGE_CAP 512

typedef enum motion_expr_result_kind {
  MOTION_EXPR_RESULT_NULL = 0,   /**< empty expression: use the underlying value */
  MOTION_EXPR_RESULT_NUMBER = 1, /**< value[0] */
  MOTION_EXPR_RESULT_VECTOR = 2, /**< value[0..size), 1 <= size <= 4 (x→0, y→1, z→2) */
  MOTION_EXPR_RESULT_ERROR = 3   /**< message holds the plain-language error */
} motion_expr_result_kind;

typedef struct motion_expr_result {
  int32_t kind; /**< motion_expr_result_kind */
  uint32_t size;
  double value[4];
  char message[MOTION_EXPR_MESSAGE_CAP];
} motion_expr_result;

/** Host callback outcome. */
typedef enum motion_expr_host_status {
  MOTION_EXPR_HOST_NOT_FOUND = 0, /**< no such layer / prop / control */
  MOTION_EXPR_HOST_OK = 1,
  /** Fail the whole expression with `message` (the engine's "Cycle
   *  detected…" / "Maximum cross-layer evaluation depth…" travel this way). */
  MOTION_EXPR_HOST_ERROR = 2
} motion_expr_host_status;

typedef enum motion_expr_space_op {
  MOTION_EXPR_TO_COMP = 0,
  MOTION_EXPR_FROM_COMP = 1,
  MOTION_EXPR_TO_WORLD = 2, /**< writes 3 components */
  MOTION_EXPR_FROM_WORLD = 3
} motion_expr_space_op;

typedef enum motion_expr_marker_scope { MOTION_EXPR_MARKERS_COMP = 0, MOTION_EXPR_MARKERS_LAYER = 1 } motion_expr_marker_scope;

/** Passed to markers_at; the host calls `add` once per marker, in any order. */
typedef struct motion_expr_marker_sink {
  void* opaque;
  void (*add)(void* opaque, double time, double duration, const char* name, size_t name_len, const char* comment,
              size_t comment_len);
} motion_expr_marker_sink;

typedef struct motion_expr_host {
  void* user;
  /** ctrl(name) → *out. NULL: every control reads 0. NOT_FOUND also reads 0. */
  int32_t (*ctrl)(void* user, const char* name, size_t name_len, double* out);
  /** The property's KEYFRAMED value at t (may be NaN or ±Infinity).
   *  NULL: valueAtTime & co. return the context's value. */
  int32_t (*self_at)(void* user, double t, double* out, char* message, size_t message_cap);
  /** Another layer's property at t. `name` may be "#<id>". NULL or NOT_FOUND: 0. */
  int32_t (*layer_at)(void* user, const char* name, size_t name_len, const char* prop, size_t prop_len, double t,
                      double* out, char* message, size_t message_cap);
  /** sourceRectAtTime → out[4] = {top, left, width, height}. NULL/NOT_FOUND: the layer box. */
  int32_t (*source_rect_at)(void* user, double t, int32_t extents, double out[4]);
  /** Coordinate space of a layer (`name` NULL = this layer). NOT_FOUND or a
   *  NULL callback is a stated error ("cannot see this layer's transform").
   *  Called first as an existence probe (op TO_COMP, point 0,0,0), then for
   *  the conversion — so it must be a pure function of its arguments. */
  int32_t (*space_at)(void* user, const char* name, size_t name_len, double t, int32_t op, const double in[3],
                      double out[3]);
  /** Markers of one scope. NULL: none. */
  void (*markers_at)(void* user, int32_t scope, const motion_expr_marker_sink* sink);
} motion_expr_host;

/** Presence bits for the optional context fields. */
#define MOTION_EXPR_HAS_AUDIO 0x1u
#define MOTION_EXPR_HAS_SELF_SPAN 0x2u
#define MOTION_EXPR_HAS_COMP 0x4u
#define MOTION_EXPR_HAS_LAYER_INFO 0x8u
#define MOTION_EXPR_HAS_PROP_SEED 0x10u

typedef struct motion_expr_context {
  double time;
  double value;
  uint32_t flags; /**< MOTION_EXPR_HAS_* */
  uint32_t reserved;
  double audio;
  double span_start, span_end;
  double comp_width, comp_height, comp_duration, comp_fps, comp_num_layers;
  const char* layer_name; /**< UTF-8, layer_name_len bytes */
  size_t layer_name_len;
  double layer_width, layer_height;
  double prop_seed; /**< see motion_expr_string_seed */
  const double* key_times; /**< ascending; key_count of them (may be NULL when 0) */
  size_t key_count;
  const motion_expr_host* host; /**< may be NULL: no providers at all */
} motion_expr_context;

/** Compile UTF-8 source. *out receives a handle to free with motion_expr_free,
 *  also when the source has a syntax error (see motion_expr_compile_error). */
MOTION_API motion_status motion_expr_compile(const char* src, size_t len, motion_expr** out, motion_error* err);

/** Copy the compile error (UTF-8) into buf; returns 1 if there is one, else 0. */
MOTION_API int32_t motion_expr_compile_error(const motion_expr* expr, char* buf, size_t cap);

MOTION_API void motion_expr_free(motion_expr* expr);

/** Evaluate. MOTION_OK whenever the evaluation ran (including an expression
 *  error, reported in `out`); INVALID_ARG for NULL expr/ctx/out; INTERNAL for
 *  an unexpected failure (out->kind is then ERROR too). */
MOTION_API motion_status motion_expr_eval(const motion_expr* expr, const motion_expr_context* ctx,
                                          motion_expr_result* out, motion_error* err);

/** AnimationEngine's per-(node, prop) seed: stringSeed(nodeId + ":" + prop),
 *  over the UTF-16 code units of the UTF-8 `s`. */
MOTION_API double motion_expr_string_seed(const char* s, size_t len);

#ifdef __cplusplus
} /* extern "C" */
#endif

// NOLINTEND(modernize-use-using, modernize-deprecated-headers, modernize-macro-to-enum, modernize-redundant-void-arg, modernize-avoid-c-arrays, cppcoreguidelines-avoid-c-arrays, cppcoreguidelines-macro-usage, performance-enum-size, cppcoreguidelines-use-enum-class)

#endif /* MOTION_EXPR_H */
