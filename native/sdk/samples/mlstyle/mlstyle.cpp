// Sample (SDK 1.4, M): ML Style — an effect that runs an ONNX model through the host's ML suite
// (pr_ml.h). The model ships in the bundle (models/style.onnx, made by tools/make_model.py): a
// 1x1 convolution that grades the picture warm. The host runs it on the engine's own ONNX Runtime
// (DirectML on Windows, Core ML on macOS, else the CPU) with one session per model, shared by
// every instance.
//
// When the suite is missing (an older host) or the model cannot run, or when CPU Only is on, the
// effect applies the same matrix itself: the result matches within float rounding.
#include <premation_sdk/premation_sdk.h>

#include <algorithm>
#include <array>
#include <cstring>
#include <vector>

#include "sample_util.hpp"

namespace {

enum : uint32_t { kStrength = 1, kCpuOnly = 2 };

// Keep in step with tools/make_model.py (MATRIX, BIAS).
constexpr std::array<std::array<float, 3>, 3> kMatrix{{{0.90F, 0.25F, 0.05F}, {0.10F, 0.80F, 0.10F}, {0.05F, 0.20F, 0.65F}}};
constexpr std::array<float, 3> kBias{0.02F, 0.01F, 0.04F};

bool has_ml(const PrInData* in) { return in->host->struct_size >= offsetof(PrHostSuite, ml_provider) + sizeof(void*); }

/// The model on `planes` (NCHW, 3 planes of n): true and `out` filled when the host ran it.
bool run_model(const PrInData* in, const std::vector<float>& planes, int32_t w, int32_t h, std::vector<float>& out) {
  if (!has_ml(in)) return false;
  uint32_t model = 0;
  if (in->host->ml_load(in->host_ref, "models/style.onnx", &model) != PR_ERR_NONE) return false;
  PrTensor input{};
  input.struct_size = sizeof(PrTensor);
  input.data = const_cast<float*>(planes.data());  // NOLINT(cppcoreguidelines-pro-type-const-cast): the host only reads inputs
  input.count = planes.size();
  input.rank = 4;
  input.shape[0] = 1;
  input.shape[1] = 3;
  input.shape[2] = h;
  input.shape[3] = w;
  PrTensor output{};
  output.struct_size = sizeof(PrTensor);
  if (in->host->ml_run(in->host_ref, model, &input, 1, &output, 1) != PR_ERR_NONE) return false;
  if (output.data == nullptr || output.count != planes.size()) return false;
  out.assign(output.data, output.data + output.count);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic): the host's tensor
  return true;
}

PrErr smart_render(const PrInData* in, PrParamDef* const* params) {
  PrWorld* src = nullptr;
  PrWorld* dst = nullptr;
  if (PrErr e = in->host->checkout_layer_pixels(in->host_ref, 0, &src); e != PR_ERR_NONE) return e;
  if (PrErr e = in->host->checkout_output(in->host_ref, &dst); e != PR_ERR_NONE) return e;
  if (src == nullptr || dst == nullptr) return PR_ERR_NONE;
  const int32_t w = dst->width;
  const int32_t h = dst->height;
  const std::size_t n = static_cast<std::size_t>(w) * static_cast<std::size_t>(h);
  // The layer, unpremultiplied, as 3 planes (NCHW) and its alpha.
  std::vector<float> planes(3 * n);
  std::vector<float> alpha(n);
  for (int32_t y = 0; y < h; ++y) {
    for (int32_t x = 0; x < w; ++x) {
      const int32_t sx = x + dst->origin_x - src->origin_x;
      const int32_t sy = y + dst->origin_y - src->origin_y;
      const prs::Px p = sx >= 0 && sy >= 0 && sx < src->width && sy < src->height ? prs::read(*src, sx, sy) : prs::Px{};
      const std::size_t i = (static_cast<std::size_t>(y) * static_cast<std::size_t>(w)) + static_cast<std::size_t>(x);
      const float k = p.a > 0 ? 1.0F / p.a : 0.0F;
      planes[i] = p.r * k;
      planes[n + i] = p.g * k;
      planes[(2 * n) + i] = p.b * k;
      alpha[i] = p.a;
    }
  }
  std::vector<float> styled;
  const bool cpuOnly = prs::num(params, in, kCpuOnly) != 0;
  if (cpuOnly || !run_model(in, planes, w, h, styled)) {
    styled.resize(3 * n);
    for (std::size_t i = 0; i < n; ++i) {
      for (std::size_t c = 0; c < 3; ++c) {
        styled[(c * n) + i] = (kMatrix[c][0] * planes[i]) + (kMatrix[c][1] * planes[n + i]) + (kMatrix[c][2] * planes[(2 * n) + i]) + kBias[c];
      }
    }
  }
  const auto s = static_cast<float>(std::clamp(prs::num(params, in, kStrength) / 100, 0.0, 1.0));
  auto row = [&](int32_t y) {
    for (int32_t x = 0; x < w; ++x) {
      const std::size_t i = (static_cast<std::size_t>(y) * static_cast<std::size_t>(w)) + static_cast<std::size_t>(x);
      const float a = alpha[i];
      prs::Px p{};
      p.r = std::max(0.0F, planes[i] + ((styled[i] - planes[i]) * s)) * a;
      p.g = std::max(0.0F, planes[n + i] + ((styled[n + i] - planes[n + i]) * s)) * a;
      p.b = std::max(0.0F, planes[(2 * n) + i] + ((styled[(2 * n) + i] - planes[(2 * n) + i]) * s)) * a;
      p.a = a;
      prs::write(*dst, x, y, p);
    }
  };
  return prs::for_rows(in, h, row);
}

PrErr PR_CALL mlstyle_main(PrCmd cmd, const PrInData* in, PrOutData* out, PrParamDef* const* params, PrWorld* /*output*/, void* /*extra*/) {
  switch (cmd) {
    case PR_CMD_ABOUT: prs::message(out, "ML Style 1.0 — Premation SDK sample of the ML suite (SDK 1.4, pr_ml.h)."); return PR_ERR_NONE;
    case PR_CMD_GLOBAL_SETUP:
      out->my_version = PR_VERSION(1, 0, 0);
      out->out_flags = PR_OUT_FLAG_DEEP_COLOR_AWARE | PR_OUT_FLAG_FLOAT_COLOR_AWARE | PR_OUT_FLAG_SMART_RENDER | PR_OUT_FLAG_THREADED_RENDER;
      return PR_ERR_NONE;
    case PR_CMD_PARAMS_SETUP:
      if (PrErr e = prs::add_float(in, kStrength, "Strength", 100, 0, 100, 0, 100, 0); e != PR_ERR_NONE) return e;
      return prs::add_simple(in, PR_PARAM_CHECKBOX, kCpuOnly, "CPU Only", {0, 0, 0, 0});
    case PR_CMD_SMART_PRE_RENDER: return in->host->checkout_layer(in->host_ref, 0, 0, in->current_time, nullptr);
    case PR_CMD_SMART_RENDER: return smart_render(in, params);
    default: return PR_ERR_NONE;
  }
}

const PrEffectEntry kEffects[] = {{"com.premation.samples.mlstyle", &mlstyle_main}};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): C ABI table
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, "com.premation.samples.mlstyle", 1, kEffects, 0, nullptr, 0, nullptr, 0, nullptr};

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
