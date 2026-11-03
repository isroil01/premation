// Sample (SDK 1.4, E1/E2): plugin EXPRESSION FUNCTIONS and an INTERPOLATOR — pure C functions the
// manifest lists under `expressionFunctions`; expressions call them as
//   plugin["com.premation.samples.mathfns"].smoothstep(0, 100, time * 50)
// and `springy` (listed under `interpolators`) can ease a keyframe segment: args (t, v0, v1).
// `crash` faults on purpose (the host disables it for the session; the engine carries on).
#include <premation_sdk/premation_sdk.h>

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace {

PrErr PR_CALL smoothstep(const double* a, uint32_t n, double* out, uint32_t* out_count) {
  if (n < 3 || *out_count < 1) return PR_ERR_INVALID_PARAM;
  const double e0 = a[0], e1 = a[1];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  const double t = e1 == e0 ? 0.0 : std::clamp((a[2] - e0) / (e1 - e0), 0.0, 1.0);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  out[0] = t * t * (3 - 2 * t);
  *out_count = 1;
  return PR_ERR_NONE;
}

/// remap(x, inLo, inHi, outLo, outHi) — or with arrays for the outs: remap(x, a, b, [r,g,b], [r,g,b]).
PrErr PR_CALL remap(const double* a, uint32_t n, double* out, uint32_t* out_count) {
  if (n < 5 || (n - 3) % 2 != 0) return PR_ERR_INVALID_PARAM;
  const uint32_t dims = (n - 3) / 2;
  if (dims > *out_count) return PR_ERR_INVALID_PARAM;
  const double span = a[2] - a[1];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  const double t = span == 0 ? 0 : (a[0] - a[1]) / span;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  for (uint32_t i = 0; i < dims; ++i) {
    const double lo = a[3 + i], hi = a[3 + dims + i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    out[i] = lo + (hi - lo) * t;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
  *out_count = dims;
  return PR_ERR_NONE;
}

/// An interpolator: (t, v0, v1) → value. A damped spring that overshoots and settles at v1.
PrErr PR_CALL springy(const double* a, uint32_t n, double* out, uint32_t* out_count) {
  if (n < 3 || *out_count < 1) return PR_ERR_INVALID_PARAM;
  const double t = std::clamp(a[0], 0.0, 1.0);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  const double p = t >= 1 ? 1.0 : 1 - std::exp(-6 * t) * std::cos(12 * t);
  out[0] = a[1] + (a[2] - a[1]) * p;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  *out_count = 1;
  return PR_ERR_NONE;
}

/// A compound interpolator (E3): (t, a..., b...) -> every number of a curve / gradient blended with a
/// smoothstep ease. The host sizes `out` to the value's length.
PrErr PR_CALL smoothblend(const double* a, uint32_t n, double* out, uint32_t* out_count) {
  if (n < 3 || (n - 1) % 2 != 0 || (n - 1) / 2 > *out_count) return PR_ERR_INVALID_PARAM;
  const uint32_t len = (n - 1) / 2;
  const double t = std::clamp(a[0], 0.0, 1.0);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  const double s = t * t * (3 - 2 * t);
  for (uint32_t i = 0; i < len; ++i) out[i] = a[1 + i] + (a[1 + len + i] - a[1 + i]) * s;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  *out_count = len;
  return PR_ERR_NONE;
}

PrErr PR_CALL crash(const double* /*a*/, uint32_t /*n*/, double* /*out*/, uint32_t* /*out_count*/) {
  volatile int* bad = nullptr;
  *bad = 1;  // NOLINT(clang-analyzer-core.NullDereference): the fault being demonstrated
  return PR_ERR_NONE;
}

const PrExprEntry kExpressions[] = {{"smoothstep", &smoothstep}, {"remap", &remap}, {"springy", &springy}, {"smoothblend", &smoothblend}, {"crash", &crash}};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): C ABI table
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, "com.premation.samples.mathfns", 0, nullptr, 0, nullptr, 0, nullptr, 0, nullptr};
const PrExprTable kTable = {sizeof(PrExprTable), 5, kExpressions};

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
extern "C" PR_EXPORT const PrExprTable* PR_CALL PremationPluginExpressions(void) { return &kTable; }
