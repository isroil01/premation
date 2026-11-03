// Sample (SDK 1.4, L4): Chart Layer — a LAYER TYPE. The manifest's `layerTypes` names this
// generator effect; New ▸ Layer ▸ Bar Chart makes a layer the plugin draws, and the params below
// are that layer's own properties in the timeline (keyframe Value 1–6 to animate the bars).
//
// It is an ordinary GENERATOR effect, so the same code also works as Effects ▸ Bar Chart on any
// layer. The bars fill the layer's rectangle: the host sizes the layer (layerW × layerH), and the
// chart is drawn in layer pixels through layer_to_world, so the layer's transform moves it.
#include <premation_sdk/premation_sdk.h>

#include <algorithm>
#include <array>
#include <cmath>

#include "sample_util.hpp"

namespace {

constexpr int kBars = 6;
enum : uint32_t {
  kValue1 = 1,  // 1..6: Value 1 … Value 6
  kMax = 7,
  kGap = 8,
  kColor = 9,
  kTrack = 10,
  kRadius = 11,
};

PrErr params_setup(const PrInData* in) {
  static constexpr std::array<const char*, kBars> kNames{"Value 1", "Value 2", "Value 3", "Value 4", "Value 5", "Value 6"};
  static constexpr std::array<double, kBars> kDefaults{35, 70, 50, 90, 60, 80};
  for (int i = 0; i < kBars; ++i) {
    const uint32_t id = kValue1 + static_cast<uint32_t>(i);
    if (PrErr e = prs::add_float(in, id, kNames.at(static_cast<std::size_t>(i)), kDefaults.at(static_cast<std::size_t>(i)), 0, 1e6, 0,
                                 100, 1);
        e != PR_ERR_NONE) {
      return e;
    }
  }
  if (PrErr e = prs::add_float(in, kMax, "Scale Maximum", 100, 0.001, 1e6, 1, 200, 1); e != PR_ERR_NONE) return e;
  if (PrErr e = prs::add_float(in, kGap, "Gap", 20, 0, 90, 0, 60, 0); e != PR_ERR_NONE) return e;
  if (PrErr e = prs::add_simple(in, PR_PARAM_COLOR, kColor, "Bar Color", {0.95, 0.55, 0.15, 1.0}); e != PR_ERR_NONE) return e;
  if (PrErr e = prs::add_simple(in, PR_PARAM_COLOR, kTrack, "Track Color", {1.0, 1.0, 1.0, 0.12}); e != PR_ERR_NONE) return e;
  return prs::add_float(in, kRadius, "Corner Radius", 6, 0, 500, 0, 40, 0);
}

/// Coverage of a rounded rectangle [x0,x1]×[y0,y1] with radius r at (px, py), one-pixel soft edge.
float rounded_rect(double px, double py, double x0, double y0, double x1, double y1, double r) {
  if (x1 <= x0 || y1 <= y0) return 0.0F;
  r = std::min({r, (x1 - x0) / 2, (y1 - y0) / 2});
  const double cx = std::clamp(px, x0 + r, x1 - r);
  const double cy = std::clamp(py, y0 + r, y1 - r);
  const double d = std::hypot(px - cx, py - cy) - r;  // < 0 inside
  return static_cast<float>(std::clamp(0.5 - d, 0.0, 1.0));
}

PrErr smart_render(const PrInData* in, PrParamDef* const* params) {
  PrWorld* dst = nullptr;
  if (PrErr e = in->host->checkout_output(in->host_ref, &dst); e != PR_ERR_NONE) return e;
  if (dst == nullptr) return PR_ERR_NONE;
  const double w = std::max(1, in->width);
  const double h = std::max(1, in->height);
  const double maxV = std::max(1e-6, prs::num(params, in, kMax));
  const double gap = std::clamp(prs::num(params, in, kGap) / 100, 0.0, 0.9);
  const double slot = w / kBars;
  const double barW = slot * (1 - gap);
  const double radius = prs::num(params, in, kRadius);
  std::array<double, kBars> top{};
  for (int i = 0; i < kBars; ++i) {
    const double v = std::clamp(prs::num(params, in, kValue1 + static_cast<uint32_t>(i)) / maxV, 0.0, 1.0);
    top.at(static_cast<std::size_t>(i)) = h * (1 - v);
  }
  const auto color = [&](uint32_t id) {
    const auto a = static_cast<float>(prs::num(params, in, id, 3));
    return prs::Px{static_cast<float>(prs::num(params, in, id, 0)) * a, static_cast<float>(prs::num(params, in, id, 1)) * a,
                   static_cast<float>(prs::num(params, in, id, 2)) * a, a};
  };
  const prs::Px bar = color(kColor);
  const prs::Px track = color(kTrack);
  // World pixel → layer pixel (the inverse of layer_to_world's 2×3 part).
  const double* m = in->layer_to_world;
  const double det = m[0] * m[4] - m[1] * m[3];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  auto row = [&](int32_t y) {
    for (int32_t x = 0; x < dst->width; ++x) {
      const double wx = x + dst->origin_x + 0.5 - m[2];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      const double wy = y + dst->origin_y + 0.5 - m[5];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      const double lx = det != 0 ? (m[4] * wx - m[1] * wy) / det : -1;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      const double ly = det != 0 ? (-m[3] * wx + m[0] * wy) / det : -1;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      prs::Px p{};
      const int i = static_cast<int>(std::floor(lx / slot));
      if (i >= 0 && i < kBars && ly >= 0 && ly < h) {
        const double x0 = i * slot + (slot - barW) / 2;
        const float t = rounded_rect(lx, ly, x0, 0, x0 + barW, h, radius);
        const float b = rounded_rect(lx, ly, x0, top.at(static_cast<std::size_t>(i)), x0 + barW, h, radius);
        // The bar over its track (premultiplied "over").
        p = track * (t * (1 - b * bar.a)) + bar * b;
      }
      prs::write(*dst, x, y, p);
    }
  };
  return prs::for_rows(in, dst->height, row);
}

PrErr PR_CALL bars_main(PrCmd cmd, const PrInData* in, PrOutData* out, PrParamDef* const* params, PrWorld* /*output*/,
                        void* /*extra*/) {
  switch (cmd) {
    case PR_CMD_ABOUT: prs::message(out, "Bar Chart 1.0 — Premation SDK sample of a plugin layer type (SDK 1.4)."); return PR_ERR_NONE;
    case PR_CMD_GLOBAL_SETUP:
      out->my_version = PR_VERSION(1, 0, 0);
      out->out_flags = PR_OUT_FLAG_DEEP_COLOR_AWARE | PR_OUT_FLAG_FLOAT_COLOR_AWARE | PR_OUT_FLAG_SMART_RENDER | PR_OUT_FLAG_GENERATOR |
                       PR_OUT_FLAG_THREADED_RENDER;
      return PR_ERR_NONE;
    case PR_CMD_PARAMS_SETUP: return params_setup(in);
    case PR_CMD_SMART_PRE_RENDER: return PR_ERR_NONE;  // a generator checks nothing out
    case PR_CMD_SMART_RENDER: return smart_render(in, params);
    default: return PR_ERR_NONE;
  }
}

const PrEffectEntry kEffects[] = {{"com.premation.samples.chartlayer.bars", &bars_main}};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): C ABI table
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, "com.premation.samples.chartlayer", 1, kEffects, 0, nullptr, 0, nullptr, 0, nullptr};

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
