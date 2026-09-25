// Sample layer-checkout effects (one module, two effects):
//
//   Layer Displace  displaces the input by ANOTHER layer's pixels (a Layer
//                   parameter checked out at the current time in pre-render):
//                   Map Layer · Use (Luminance | Red/Green) · Max Horizontal ·
//                   Max Vertical ▸ Debug: Fault. Where the build has Dawn's
//                   headers (PRS_SAMPLE_GPU) a GPU effect too: its
//                   SMART_RENDER_GPU reads the map through checkout_layer_gpu
//                   and computes what SMART_RENDER does, in WGSL.
//   Time Echo       mixes the input with its OWN layer at earlier / later
//                   times (checkouts of param 0 at other times —
//                   PR_OUT_FLAG_WIDE_TIME_INPUT): Echo Time (s) · Echoes ·
//                   Decay ▸ Debug: Fault
#include <premation_sdk/premation_sdk.h>

#include <array>
#include <cmath>

#include "sample_util.hpp"
#if defined(PRS_SAMPLE_GPU)
#include "sample_gpu.hpp"
#endif

namespace {

// ── Layer Displace ─────────────────────────────────────────────────────────

enum : uint32_t { kMapLayer = 1, kUse = 2, kMaxH = 3, kMaxV = 4 };
constexpr uint32_t kMapCheckout = 1;

uint32_t param_index_of(const PrInData* in, PrParamDef* const* params, uint32_t id) {
  for (uint32_t i = 1; i < in->num_params; ++i) {
    if (params[i] != nullptr && params[i]->id == id) return i;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
  return 0;
}

PrErr displace_render(const PrInData* in, PrOutData* out, PrParamDef* const* params) {
  if (const PrErr f = prs::inject(prs::by_id(params, in, prs::kFaultParamId), out); f != PR_ERR_NONE) return f;
  PrWorld* src = nullptr;
  PrWorld* map = nullptr;
  PrWorld* dst = nullptr;
  if (PrErr e = in->host->checkout_layer_pixels(in->host_ref, 0, &src); e != PR_ERR_NONE) return e;
  if (PrErr e = in->host->checkout_layer_pixels(in->host_ref, kMapCheckout, &map); e != PR_ERR_NONE) return e;
  if (PrErr e = in->host->checkout_output(in->host_ref, &dst); e != PR_ERR_NONE) return e;
  if (dst == nullptr) return PR_ERR_NONE;
  const double scale = 0.5 * (in->pixel_scale_x + in->pixel_scale_y);
  const double mh = prs::num(params, in, kMaxH) * scale;
  const double mv = prs::num(params, in, kMaxV) * scale;
  const bool luma = prs::num(params, in, kUse) < 2;
  auto row = [&](int32_t y) {
    for (int32_t x = 0; x < dst->width; ++x) {
      double dx = 0;
      double dy = 0;
      if (map != nullptr) {
        const prs::Px m = prs::read(*map, x, y);
        // Straight map values, 0.5 = no displacement (AE Displacement Map).
        const float inv = m.a > 0 ? 1.0F / m.a : 0.0F;
        const double r = m.r * inv;
        const double g = m.g * inv;
        const double l = 0.2126 * r + 0.7152 * g + 0.0722 * m.b * inv;
        const double h = m.a > 0 ? (luma ? l : r) : 0.5;
        const double v = m.a > 0 ? (luma ? l : g) : 0.5;
        dx = (h - 0.5) * 2 * mh;
        dy = (v - 0.5) * 2 * mv;
      }
      prs::write(*dst, x, y, src != nullptr ? prs::sample(*src, x + 0.5 + dx, y + 0.5 + dy) : prs::Px{});
    }
  };
  return prs::for_rows(in, dst->height, row);
}

#if defined(PRS_SAMPLE_GPU)
constexpr uint32_t kDisplaceFlags = PR_OUT_FLAG_DEEP_COLOR_AWARE | PR_OUT_FLAG_FLOAT_COLOR_AWARE | PR_OUT_FLAG_SMART_RENDER |
                                    PR_OUT_FLAG_GPU_RENDER | PR_OUT_FLAG_THREADED_RENDER;

/// displace_render's maths per output pixel: prs::sample's bilinear taps, transparent outside.
constexpr const char* kDisplaceWgsl = R"(
struct U { p: vec4f };  // (max horizontal px, max vertical px, luminance, has map)
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var map: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
}
fn tap(p: vec2i) -> vec4f {
  let size = vec2i(textureDimensions(src));
  if (any(p < vec2i(0)) || any(p >= size)) { return vec4f(0.0); }
  return textureLoad(src, p, 0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let xy = vec2i(pos.xy);
  var d = vec2f(0.0);
  if (u.p.w > 0.0) {
    let m = textureLoad(map, xy, 0);
    if (m.a > 0.0) {
      let inv = 1.0 / m.a;
      let l = 0.2126 * m.r * inv + 0.7152 * m.g * inv + 0.0722 * m.b * inv;
      let hv = select(vec2f(m.r * inv, m.g * inv), vec2f(l), u.p.z > 0.0);
      d = (hv - 0.5) * 2.0 * u.p.xy;
    }
  }
  let f = vec2f(xy) + d;
  let f0 = floor(f);
  let t = f - f0;
  let i = vec2i(f0);
  let a = tap(i);
  let b = tap(i + vec2i(1, 0));
  let c = tap(i + vec2i(0, 1));
  let e = tap(i + vec2i(1, 1));
  return (a * (1.0 - t.x) + b * t.x) * (1.0 - t.y) + (c * (1.0 - t.x) + e * t.x) * t.y;
}
)";

PrErr displace_gpu_render(const PrInData* in, PrOutData* out, PrParamDef* const* params, PrSmartRenderGpuExtra* x) {
  if (const PrErr f = prs::inject(prs::by_id(params, in, prs::kFaultParamId), out); f != PR_ERR_NONE) return f;
  const prs::gpu::State* st = prs::gpu::state_of(in, x->gpu_data);
  if (st == nullptr || x->input == nullptr || x->output == nullptr) return PR_ERR_INVALID_PARAM;
  const PrGpuWorld* map = nullptr;
  if (PrErr e = in->host->checkout_layer_gpu(in->host_ref, kMapCheckout, &map); e != PR_ERR_NONE) return e;
  const double scale = 0.5 * (in->pixel_scale_x + in->pixel_scale_y);
  const std::array<float, 4> u{static_cast<float>(prs::num(params, in, kMaxH) * scale), static_cast<float>(prs::num(params, in, kMaxV) * scale),
                               prs::num(params, in, kUse) < 2 ? 1.0F : 0.0F, map != nullptr ? 1.0F : 0.0F};
  // No map: the input stands in at its binding, unread (u.p.w = 0).
  const std::array<const PrGpuWorld*, 2> textures{x->input, map != nullptr ? map : x->input};
  prs::gpu::draw(*st, x, textures, u);
  return PR_ERR_NONE;
}
#else
constexpr uint32_t kDisplaceFlags =
    PR_OUT_FLAG_DEEP_COLOR_AWARE | PR_OUT_FLAG_FLOAT_COLOR_AWARE | PR_OUT_FLAG_SMART_RENDER | PR_OUT_FLAG_THREADED_RENDER;
#endif

PrErr PR_CALL displace_main(PrCmd cmd, const PrInData* in, PrOutData* out, PrParamDef* const* params, PrWorld* /*output*/,
                            [[maybe_unused]] void* extra) {
  switch (cmd) {
    case PR_CMD_ABOUT: prs::message(out, "Layer Displace 1.0 — Premation SDK sample (checks out another layer)."); return PR_ERR_NONE;
    case PR_CMD_GLOBAL_SETUP:
      out->my_version = PR_VERSION(1, 0, 0);
      out->out_flags = kDisplaceFlags;
      return PR_ERR_NONE;
    case PR_CMD_PARAMS_SETUP: {
      PrErr e = prs::add_simple(in, PR_PARAM_LAYER, kMapLayer, "Map Layer", {});
      if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_POPUP, kUse, "Use", {1, 0, 0, 0}, 0, "Luminance|Red/Green");
      if (e == PR_ERR_NONE) e = prs::add_float(in, kMaxH, "Max Horizontal", 20, -2000, 2000, -100, 100, 1);
      if (e == PR_ERR_NONE) e = prs::add_float(in, kMaxV, "Max Vertical", 20, -2000, 2000, -100, 100, 1);
      if (e == PR_ERR_NONE) e = prs::add_fault_params(in);
      return e;
    }
    case PR_CMD_SMART_PRE_RENDER: {
      PrErr e = in->host->checkout_layer(in->host_ref, 0, 0, in->current_time, nullptr);
      const uint32_t mapIndex = param_index_of(in, params, kMapLayer);
      if (e == PR_ERR_NONE && mapIndex != 0) e = in->host->checkout_layer(in->host_ref, mapIndex, kMapCheckout, in->current_time, nullptr);
      return e;
    }
    case PR_CMD_SMART_RENDER: return displace_render(in, out, params);
#if defined(PRS_SAMPLE_GPU)
    case PR_CMD_GPU_DEVICE_SETUP: return prs::gpu::setup(in, static_cast<PrGpuDeviceSetupExtra*>(extra), kDisplaceWgsl, "prs-displace", 16);
    case PR_CMD_GPU_DEVICE_SETDOWN: return prs::gpu::setdown(in, static_cast<PrGpuDeviceSetupExtra*>(extra));
    case PR_CMD_SMART_RENDER_GPU: return displace_gpu_render(in, out, params, static_cast<PrSmartRenderGpuExtra*>(extra));
#endif
    default: return PR_ERR_NONE;
  }
}

// ── Time Echo ──────────────────────────────────────────────────────────────

enum : uint32_t { kEchoTime = 1, kEchoes = 2, kDecay = 3 };
constexpr int32_t kMaxEchoes = 8;

int32_t echoes_of(const PrInData* in, PrParamDef* const* params) {
  return static_cast<int32_t>(std::lround(std::clamp(prs::num(params, in, kEchoes, 0, 3), 1.0, static_cast<double>(kMaxEchoes))));
}

PrErr echo_pre_render(const PrInData* in, PrParamDef* const* params) {
  PrErr e = in->host->checkout_layer(in->host_ref, 0, 0, in->current_time, nullptr);
  const double step = prs::num(params, in, kEchoTime, 0, -0.1);
  for (int32_t k = 1; e == PR_ERR_NONE && k <= echoes_of(in, params); ++k) {
    const auto t = in->current_time + static_cast<int64_t>(std::llround(step * k * in->time_scale));
    e = in->host->checkout_layer(in->host_ref, 0, static_cast<uint32_t>(k), t, nullptr);
  }
  return e;
}

PrErr echo_render(const PrInData* in, PrOutData* out, PrParamDef* const* params) {
  if (const PrErr f = prs::inject(prs::by_id(params, in, prs::kFaultParamId), out); f != PR_ERR_NONE) return f;
  PrWorld* dst = nullptr;
  if (PrErr e = in->host->checkout_output(in->host_ref, &dst); e != PR_ERR_NONE) return e;
  if (dst == nullptr) return PR_ERR_NONE;
  const int32_t n = echoes_of(in, params);
  std::array<PrWorld*, kMaxEchoes + 1> w{};
  for (int32_t k = 0; k <= n; ++k) {
    if (PrErr e = in->host->checkout_layer_pixels(in->host_ref, static_cast<uint32_t>(k), &w.at(static_cast<std::size_t>(k))); e != PR_ERR_NONE) {
      return e;
    }
  }
  const auto decay = static_cast<float>(std::clamp(prs::num(params, in, kDecay, 0, 0.5), 0.0, 1.0));
  auto row = [&](int32_t y) {
    for (int32_t x = 0; x < dst->width; ++x) {
      // Composite: the current frame over the echoes, each weaker by `decay` (AE Echo, "composite in back").
      prs::Px acc = w[0] != nullptr ? prs::read(*w[0], x, y) : prs::Px{};
      float k = 1;
      for (int32_t e = 1; e <= n; ++e) {
        k *= decay;
        const PrWorld* we = w.at(static_cast<std::size_t>(e));
        if (we == nullptr) continue;
        const prs::Px p = prs::read(*we, x, y) * k;
        acc = acc + p * (1 - acc.a);
      }
      prs::write(*dst, x, y, acc);
    }
  };
  return prs::for_rows(in, dst->height, row);
}

PrErr PR_CALL echo_main(PrCmd cmd, const PrInData* in, PrOutData* out, PrParamDef* const* params, PrWorld* /*output*/,
                        void* /*extra*/) {
  switch (cmd) {
    case PR_CMD_ABOUT: prs::message(out, "Time Echo 1.0 — Premation SDK sample (checks its layer out at other times)."); return PR_ERR_NONE;
    case PR_CMD_GLOBAL_SETUP:
      out->my_version = PR_VERSION(1, 0, 0);
      out->out_flags = PR_OUT_FLAG_DEEP_COLOR_AWARE | PR_OUT_FLAG_FLOAT_COLOR_AWARE | PR_OUT_FLAG_SMART_RENDER |
                       PR_OUT_FLAG_WIDE_TIME_INPUT | PR_OUT_FLAG_THREADED_RENDER;
      return PR_ERR_NONE;
    case PR_CMD_PARAMS_SETUP: {
      PrErr e = prs::add_float(in, kEchoTime, "Echo Time (seconds)", -0.1, -10, 10, -1, 1, 3);
      if (e == PR_ERR_NONE) {
        PrParamDef d = prs::param(PR_PARAM_SLIDER, kEchoes, "Number of Echoes");
        d.value[0] = 3;
        d.valid_min = 1;
        d.valid_max = kMaxEchoes;
        d.slider_min = 1;
        d.slider_max = kMaxEchoes;
        e = in->host->add_param(in->host_ref, &d);
      }
      if (e == PR_ERR_NONE) e = prs::add_float(in, kDecay, "Decay", 0.5, 0, 1, 0, 1, 2);
      if (e == PR_ERR_NONE) e = prs::add_fault_params(in);
      return e;
    }
    case PR_CMD_SMART_PRE_RENDER: return echo_pre_render(in, params);
    case PR_CMD_SMART_RENDER: return echo_render(in, out, params);
    default: return PR_ERR_NONE;
  }
}

const PrEffectEntry kEffects[] = {{"com.premation.samples.checkout.displace", &displace_main},  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): C ABI table
                                  {"com.premation.samples.checkout.echo", &echo_main}};
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, "com.premation.samples.checkout", 2, kEffects};

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
