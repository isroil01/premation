// Emscripten glue over include/motion. Thin on purpose: every exported
// function is one call into the C ABI with the packed layout, so the JS side
// (packages/native-bridge) has one `Float64Array` protocol for both bindings.
//
// The error-message buffer is not surfaced here; the status code is returned
// and `motion_status_name` is exported for a readable name. Full messages
// arrive with the N1 loader work.

#include <emscripten/emscripten.h>

#include <cstddef>
#include <cstdint>

#include "motion/motion_abi.h"
#include "motion/motion_eval.h"

extern "C" {

EMSCRIPTEN_KEEPALIVE std::uint32_t motion_wasm_abi_version() { return motion_abi_version(); }

EMSCRIPTEN_KEEPALIVE const char* motion_wasm_status_name(std::int32_t status) {
  switch (status) {
    case MOTION_OK:
      return motion_status_name(MOTION_OK);
    case MOTION_INVALID_ARG:
      return motion_status_name(MOTION_INVALID_ARG);
    case MOTION_OUT_OF_RANGE:
      return motion_status_name(MOTION_OUT_OF_RANGE);
    case MOTION_INTERNAL:
      return motion_status_name(MOTION_INTERNAL);
    default:
      return "UNKNOWN";
  }
}

/// `packed`: count * MOTION_KEYFRAME_PACKED_DOUBLES doubles in linear memory
/// (8-byte aligned — allocate with _malloc). Writes *out on OK.
EMSCRIPTEN_KEEPALIVE std::int32_t motion_wasm_sample_scalar(const double* packed, std::size_t count,
                                                            double t, double* out) {
  return static_cast<std::int32_t>(motion_eval_sample_scalar_packed(packed, count, t, out, nullptr));
}

EMSCRIPTEN_KEEPALIVE std::int32_t motion_wasm_sample_scalar_batch(const double* packed,
                                                                  std::size_t count,
                                                                  const double* times,
                                                                  std::size_t n, double* out) {
  return static_cast<std::int32_t>(
      motion_eval_sample_scalar_packed_batch(packed, count, times, n, out, nullptr));
}

}  // extern "C"
