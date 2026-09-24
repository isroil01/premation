// Sample CPU effect: Ripple — a radial sine displacement of the layer, with an
// optional tint. Smart render, 8/16/32-bit worlds, rows in parallel through
// the host's iterate(). Every parameter is animatable by the engine.
//
//   Center (point) · Amplitude · Wavelength · Phase (angle) · Sampling (popup)
//   ▸ Tint: Enable (checkbox) · Color · Amount
//   ▸ Debug: Fault
#include <premation_sdk/premation_sdk.h>

#include <cmath>
#include <numbers>

#include "sample_util.hpp"

namespace {

enum : uint32_t {
  kCenter = 1,
  kAmplitude = 2,
  kWavelength = 3,
  kPhase = 4,
  kSampling = 5,
  kTintGroup = 6,
  kTintOn = 7,
  kTintColor = 8,
  kTintAmount = 9,
  kTintGroupEnd = 10,
};

PrErr params_setup(const PrInData* in) {
  PrErr e = prs::add_simple(in, PR_PARAM_POINT, kCenter, "Center", {0, 0, 0, 0});
  if (e == PR_ERR_NONE) e = prs::add_float(in, kAmplitude, "Amplitude", 12, 0, 1000, 0, 100, 1);
  if (e == PR_ERR_NONE) e = prs::add_float(in, kWavelength, "Wavelength", 60, 2, 4000, 4, 400, 1);
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_ANGLE, kPhase, "Phase", {0, 0, 0, 0});
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_POPUP, kSampling, "Sampling", {2, 0, 0, 0}, 0, "Nearest|Bilinear");
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_GROUP_START, kTintGroup, "Tint", {});
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_CHECKBOX, kTintOn, "Enable", {0, 0, 0, 0});
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_COLOR, kTintColor, "Color", {0.2, 0.6, 1.0, 1.0});
  if (e == PR_ERR_NONE) e = prs::add_float(in, kTintAmount, "Amount", 50, 0, 100, 0, 100, 1);
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_GROUP_END, kTintGroupEnd, "", {});
  if (e == PR_ERR_NONE) e = prs::add_fault_params(in);
  return e;
}

PrErr smart_render(const PrInData* in, PrOutData* out, PrParamDef* const* params) {
  if (const PrErr f = prs::inject(prs::by_id(params, in, prs::kFaultParamId), out); f != PR_ERR_NONE) return f;
  PrWorld* src = nullptr;
  PrWorld* dst = nullptr;
  if (PrErr e = in->host->checkout_layer_pixels(in->host_ref, 0, &src); e != PR_ERR_NONE) return e;
  if (PrErr e = in->host->checkout_output(in->host_ref, &dst); e != PR_ERR_NONE) return e;
  if (dst == nullptr) return PR_ERR_NONE;

  const auto c = prs::to_world(in, prs::num(params, in, kCenter, 0), prs::num(params, in, kCenter, 1));
  const double scale = std::max(1e-6, 0.5 * (in->pixel_scale_x + in->pixel_scale_y));
  const double amp = prs::num(params, in, kAmplitude) * scale;
  const double wave = std::max(1e-3, prs::num(params, in, kWavelength) * scale);
  const double phase = prs::num(params, in, kPhase) * std::numbers::pi / 180;
  const bool bilinear = prs::num(params, in, kSampling) >= 2;
  const bool tint = prs::num(params, in, kTintOn) != 0;
  const prs::Px tc{static_cast<float>(prs::num(params, in, kTintColor, 0)), static_cast<float>(prs::num(params, in, kTintColor, 1)),
                   static_cast<float>(prs::num(params, in, kTintColor, 2)), 1};
  const auto tintK = static_cast<float>(prs::clamp01(static_cast<float>(prs::num(params, in, kTintAmount) / 100)));

  auto row = [&](int32_t y) {
    for (int32_t x = 0; x < dst->width; ++x) {
      const double px = x + 0.5;
      const double py = y + 0.5;
      const double dx = px - c[0];
      const double dy = py - c[1];
      const double d = std::sqrt(dx * dx + dy * dy);
      const double off = amp * std::sin(2 * std::numbers::pi * d / wave - phase);
      const double ux = d > 1e-9 ? dx / d : 0;
      const double uy = d > 1e-9 ? dy / d : 0;
      const double sx = px - ux * off;
      const double sy = py - uy * off;
      prs::Px p = src == nullptr ? prs::Px{}
                  : bilinear      ? prs::sample(*src, sx, sy)
                                  : prs::read(*src, static_cast<int32_t>(std::floor(sx)), static_cast<int32_t>(std::floor(sy)));
      if (tint && p.a > 0) {
        // Premultiplied: the tint colour at the pixel's own coverage.
        const prs::Px t{tc.r * p.a, tc.g * p.a, tc.b * p.a, p.a};
        p = p * (1 - tintK) + t * tintK;
      }
      prs::write(*dst, x, y, p);
    }
  };
  return prs::for_rows(in, dst->height, row);
}

PrErr PR_CALL ripple_main(PrCmd cmd, const PrInData* in, PrOutData* out, PrParamDef* const* params, PrWorld* /*output*/,
                          void* /*extra*/) {
  switch (cmd) {
    case PR_CMD_ABOUT: prs::message(out, "Ripple 1.0 — Premation SDK sample (CPU effect, 8/16/32 bpc)."); return PR_ERR_NONE;
    case PR_CMD_GLOBAL_SETUP:
      out->my_version = PR_VERSION(1, 0, 0);
      out->out_flags = PR_OUT_FLAG_DEEP_COLOR_AWARE | PR_OUT_FLAG_FLOAT_COLOR_AWARE | PR_OUT_FLAG_SMART_RENDER |
                       PR_OUT_FLAG_THREADED_RENDER;
      return PR_ERR_NONE;
    case PR_CMD_PARAMS_SETUP: return params_setup(in);
    case PR_CMD_SMART_PRE_RENDER: return in->host->checkout_layer(in->host_ref, 0, 0, in->current_time, nullptr);
    case PR_CMD_SMART_RENDER: return smart_render(in, out, params);
    default: return PR_ERR_NONE;
  }
}

const PrEffectEntry kEffects[] = {{"com.premation.samples.ripple", &ripple_main}};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): C ABI table
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, "com.premation.samples.ripple", 1, kEffects};

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
