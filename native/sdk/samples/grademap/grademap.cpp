// Sample CPU effect: Grade Map — the SDK 1.1 parameter types (plan P6).
//
//   Channels (STRING)    which channels the map writes: any of "r", "g", "b" ("rgb")
//   Tone Curve (CURVE)   applied to the pixel's luma first
//   Gradient (GRADIENT)  maps the curved luma to a colour
//   LUT (FILE, .cube)    a 1D .cube LUT applied last, read with get_asset_bytes;
//                        none chosen or missing: skipped (the host reports a missing
//                        file on the layer — the effect never fails over it)
//   Mix                  0..100 % over the input
//   ▸ Debug: Fault
#include <premation_sdk/premation_sdk.h>

#include <array>
#include <cstddef>
#include <cstdlib>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

#include "sample_util.hpp"

namespace {

enum : uint32_t { kChannels = 1, kCurve = 2, kGradient = 3, kLut = 4, kMix = 5 };

/// The SDK 1.1 fields exist in the host's PrParamDef (an SDK 1.0 host would refuse the params anyway).
bool has_11(const PrParamDef* p) { return p != nullptr && p->struct_size >= offsetof(PrParamDef, file_missing) + sizeof(int32_t); }

PrErr params_setup(const PrInData* in) {
  PrParamDef s = prs::param(PR_PARAM_STRING, kChannels, "Channels");
  s.text = "rgb";
  PrErr e = in->host->add_param(in->host_ref, &s);
  if (e == PR_ERR_NONE) {
    static constexpr std::array<double, 6> kCurveDef{0, 0, 0.5, 0.5, 1, 1};
    PrParamDef c = prs::param(PR_PARAM_CURVE, kCurve, "Tone Curve");
    c.curve = kCurveDef.data();
    c.curve_count = 3;
    e = in->host->add_param(in->host_ref, &c);
  }
  if (e == PR_ERR_NONE) {
    static constexpr std::array<double, 10> kStops{0, 0, 0, 0, 1, 1, 1, 1, 1, 1};
    PrParamDef g = prs::param(PR_PARAM_GRADIENT, kGradient, "Gradient");
    g.gradient = kStops.data();
    g.gradient_count = 2;
    e = in->host->add_param(in->host_ref, &g);
  }
  if (e == PR_ERR_NONE) {
    PrParamDef f = prs::param(PR_PARAM_FILE, kLut, "LUT");
    f.file_types = "cube";
    e = in->host->add_param(in->host_ref, &f);
  }
  if (e == PR_ERR_NONE) e = prs::add_float(in, kMix, "Mix", 100, 0, 100, 0, 100, 1);
  if (e == PR_ERR_NONE) e = prs::add_fault_params(in);
  return e;
}

/// Piecewise-linear through the curve's points (x ascending).
float curve_at(const double* xy, uint32_t n, float v) {
  if (xy == nullptr || n < 2) return v;
  if (v <= xy[0]) return static_cast<float>(xy[1]);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  for (uint32_t i = 1; i < n; ++i) {
    const double x0 = xy[2 * (i - 1)], y0 = xy[2 * (i - 1) + 1], x1 = xy[2 * i], y1 = xy[2 * i + 1];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    if (v <= x1) return static_cast<float>(x1 > x0 ? y0 + (y1 - y0) * (v - x0) / (x1 - x0) : y1);
  }
  return static_cast<float>(xy[2 * n - 1]);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
}

/// The gradient's straight colour at `t` (stops by position).
std::array<float, 3> gradient_at(const double* st, uint32_t n, float t) {
  if (st == nullptr || n == 0) return {t, t, t};
  const auto rgb = [&](uint32_t i) {
    return std::array<float, 3>{static_cast<float>(st[5 * i + 1]), static_cast<float>(st[5 * i + 2]), static_cast<float>(st[5 * i + 3])};  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  };
  if (t <= st[0]) return rgb(0);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  for (uint32_t i = 1; i < n; ++i) {
    const double p0 = st[5 * (i - 1)], p1 = st[5 * i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    if (t <= p1) {
      const auto k = static_cast<float>(p1 > p0 ? (t - p0) / (p1 - p0) : 1);
      const auto a = rgb(i - 1), b = rgb(i);
      return {a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k};
    }
  }
  return rgb(n - 1);
}

/// A 1D `.cube` LUT (LUT_1D_SIZE N, then N "r g b" rows). Empty for anything else (3D cubes included).
std::vector<std::array<float, 3>> parse_cube_1d(std::string_view text) {
  std::vector<std::array<float, 3>> rows;
  std::size_t size = 0;
  std::size_t at = 0;
  while (at < text.size()) {
    std::size_t end = text.find('\n', at);
    if (end == std::string_view::npos) end = text.size();
    std::string line(text.substr(at, end - at));
    at = end + 1;
    if (line.empty() || line[0] == '#') continue;
    if (line.rfind("LUT_1D_SIZE", 0) == 0) {
      size = static_cast<std::size_t>(std::strtoul(line.c_str() + 11, nullptr, 10));  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      continue;
    }
    if (line.rfind("LUT_3D_SIZE", 0) == 0) return {};
    char* p = line.data();
    std::array<float, 3> v{};
    bool ok = true;
    for (float& c : v) {
      char* next = nullptr;
      c = std::strtof(p, &next);
      ok = ok && next != p;
      p = next;
    }
    if (ok) rows.push_back(v);
  }
  if (size < 2 || rows.size() != size || size > 65536) return {};
  return rows;
}

float lut_at(const std::vector<std::array<float, 3>>& lut, std::size_t ch, float v) {
  const float x = prs::clamp01(v) * static_cast<float>(lut.size() - 1);
  const auto i = static_cast<std::size_t>(x);
  const std::size_t j = i + 1 < lut.size() ? i + 1 : i;
  const float k = x - static_cast<float>(i);
  return lut[i].at(ch) * (1 - k) + lut[j].at(ch) * k;
}

PrErr smart_render(const PrInData* in, PrOutData* out, PrParamDef* const* params) {
  if (const PrErr f = prs::inject(prs::by_id(params, in, prs::kFaultParamId), out); f != PR_ERR_NONE) return f;
  PrWorld* src = nullptr;
  PrWorld* dst = nullptr;
  if (PrErr e = in->host->checkout_layer_pixels(in->host_ref, 0, &src); e != PR_ERR_NONE) return e;
  if (PrErr e = in->host->checkout_output(in->host_ref, &dst); e != PR_ERR_NONE) return e;
  if (dst == nullptr) return PR_ERR_NONE;

  const PrParamDef* chan = prs::by_id(params, in, kChannels);
  const PrParamDef* curve = prs::by_id(params, in, kCurve);
  const PrParamDef* grad = prs::by_id(params, in, kGradient);
  if (!has_11(chan) || !has_11(curve) || !has_11(grad)) return PR_ERR_UNSUPPORTED;
  const std::string_view channels = chan->text != nullptr ? chan->text : "rgb";
  const std::array<bool, 3> on{channels.find('r') != std::string_view::npos, channels.find('g') != std::string_view::npos,
                               channels.find('b') != std::string_view::npos};
  const auto mix = prs::clamp01(static_cast<float>(prs::num(params, in, kMix) / 100));

  // The LUT, when one is chosen and on disk.
  std::vector<std::array<float, 3>> lut;
  for (uint32_t i = 1; i < in->num_params; ++i) {
    if (params[i] == nullptr || params[i]->id != kLut) continue;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    const uint8_t* bytes = nullptr;
    uint64_t size = 0;
    if (in->host->struct_size >= offsetof(PrHostSuite, get_asset_bytes) + sizeof(void*) &&
        in->host->get_asset_bytes(in->host_ref, i, &bytes, &size) == PR_ERR_NONE) {
      lut = parse_cube_1d(std::string_view(reinterpret_cast<const char*>(bytes), static_cast<std::size_t>(size)));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): text bytes
    }
  }

  auto row = [&](int32_t y) {
    for (int32_t x = 0; x < dst->width; ++x) {
      const prs::Px p = src == nullptr ? prs::Px{} : prs::read(*src, x, y);
      if (p.a <= 0) {
        prs::write(*dst, x, y, p);
        continue;
      }
      // Straight colour, luma → curve → gradient (→ LUT), back to premultiplied.
      const std::array<float, 3> s{p.r / p.a, p.g / p.a, p.b / p.a};
      const float luma = prs::clamp01(0.2126F * s[0] + 0.7152F * s[1] + 0.0722F * s[2]);
      std::array<float, 3> m = gradient_at(grad->gradient, grad->gradient_count, curve_at(curve->curve, curve->curve_count, luma));
      if (!lut.empty()) {
        for (std::size_t c = 0; c < 3; ++c) m.at(c) = lut_at(lut, c, m.at(c));
      }
      std::array<float, 3> o = s;
      for (std::size_t c = 0; c < 3; ++c) {
        if (on.at(c)) o.at(c) = s.at(c) * (1 - mix) + m.at(c) * mix;
      }
      prs::write(*dst, x, y, prs::Px{o[0] * p.a, o[1] * p.a, o[2] * p.a, p.a});
    }
  };
  return prs::for_rows(in, dst->height, row);
}

PrErr PR_CALL grademap_main(PrCmd cmd, const PrInData* in, PrOutData* out, PrParamDef* const* params, PrWorld* /*output*/,
                            void* /*extra*/) {
  switch (cmd) {
    case PR_CMD_ABOUT: prs::message(out, "Grade Map 1.0 — Premation SDK sample (STRING, CURVE, GRADIENT and FILE params)."); return PR_ERR_NONE;
    case PR_CMD_GLOBAL_SETUP:
      out->my_version = PR_VERSION(1, 0, 0);
      out->out_flags = PR_OUT_FLAG_DEEP_COLOR_AWARE | PR_OUT_FLAG_FLOAT_COLOR_AWARE | PR_OUT_FLAG_SMART_RENDER | PR_OUT_FLAG_THREADED_RENDER;
      return PR_ERR_NONE;
    case PR_CMD_PARAMS_SETUP: return params_setup(in);
    case PR_CMD_SMART_PRE_RENDER: return in->host->checkout_layer(in->host_ref, 0, 0, in->current_time, nullptr);
    case PR_CMD_SMART_RENDER: return smart_render(in, out, params);
    default: return PR_ERR_NONE;
  }
}

const PrEffectEntry kEffects[] = {{"com.premation.samples.grademap", &grademap_main}};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): C ABI table
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, "com.premation.samples.grademap", 1, kEffects};

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
