// Invert (example) — the smallest useful Premation plugin: inverts the
// layer's colour, keeping its alpha, mixed by Amount. CPU, smart render,
// 8/16/32-bit worlds, rows in parallel through the host's iterate().
//
// sample_util.hpp ships with the SDK (share/premation-sdk/samples/common):
// pixel read/write per depth, parameter helpers, and for_rows.
#include <premation_sdk/premation_sdk.h>

#include "sample_util.hpp"

namespace {

enum : uint32_t { kAmount = 1 };

PrErr smart_render(const PrInData* in, PrParamDef* const* params) {
  PrWorld* src = nullptr;
  PrWorld* dst = nullptr;
  if (PrErr e = in->host->checkout_layer_pixels(in->host_ref, 0, &src); e != PR_ERR_NONE) return e;
  if (PrErr e = in->host->checkout_output(in->host_ref, &dst); e != PR_ERR_NONE) return e;
  if (dst == nullptr) return PR_ERR_NONE;
  const float k = prs::clamp01(static_cast<float>(prs::num(params, in, kAmount) / 100));
  auto row = [&](int32_t y) {
    for (int32_t x = 0; x < dst->width; ++x) {
      const prs::Px p = src == nullptr ? prs::Px{} : prs::read(*src, x, y);
      // Premultiplied: the inverse of a colour at coverage a is a − c.
      const prs::Px inv{p.a - p.r, p.a - p.g, p.a - p.b, p.a};
      prs::write(*dst, x, y, p * (1 - k) + inv * k);
    }
  };
  return prs::for_rows(in, dst->height, row);
}

PrErr PR_CALL invert_main(PrCmd cmd, const PrInData* in, PrOutData* out, PrParamDef* const* params, PrWorld* /*output*/,
                          void* /*extra*/) {
  switch (cmd) {
    case PR_CMD_ABOUT: prs::message(out, "Invert 1.0 — an example Premation plugin."); return PR_ERR_NONE;
    case PR_CMD_GLOBAL_SETUP:
      out->my_version = PR_VERSION(1, 0, 0);
      out->out_flags = PR_OUT_FLAG_DEEP_COLOR_AWARE | PR_OUT_FLAG_FLOAT_COLOR_AWARE | PR_OUT_FLAG_SMART_RENDER |
                       PR_OUT_FLAG_THREADED_RENDER;
      return PR_ERR_NONE;
    case PR_CMD_PARAMS_SETUP: return prs::add_float(in, kAmount, "Amount", 100, 0, 100, 0, 100, 1);
    case PR_CMD_SMART_PRE_RENDER: return in->host->checkout_layer(in->host_ref, 0, 0, in->current_time, nullptr);
    case PR_CMD_SMART_RENDER: return smart_render(in, params);
    default: return PR_ERR_NONE;
  }
}

const PrEffectEntry kEffects[] = {{"com.example.invert", &invert_main}};  // NOLINT(modernize-avoid-c-arrays): C ABI table
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, "com.example.invert", 1, kEffects};

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
