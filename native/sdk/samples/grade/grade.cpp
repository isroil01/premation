// Sample GPU effect: Color Grade — gain, lift, saturation and hue rotation in
// straight linear colour. PR_CMD_SMART_RENDER_GPU renders it with WGSL on the
// ENGINE's Dawn device (the texture the chain holds goes in, a texture the
// engine composites comes out: no readback, no copy); PR_CMD_SMART_RENDER is
// the same maths on the CPU, used when the host has no GPU path for the frame.
//
//   Gain (color) · Lift · Saturation · Hue (angle) ▸ Debug: Fault, GPU Fault
//
// GPU Fault = "Invalid commands" records a draw with no pipeline set — a
// validation error the host's error scope catches: the command buffer is
// dropped unsubmitted and the frame renders through the CPU path instead.
#include <premation_sdk/premation_sdk.h>

#include <array>
#include <cmath>
#include <numbers>

#include "sample_gpu.hpp"
#include "sample_util.hpp"

namespace {

enum : uint32_t { kGain = 1, kLift = 2, kSaturation = 3, kHue = 4, kGpuFault = 5 };
enum : int { kGpuFaultNone = 1, kGpuFaultInvalidCommands = 2 };

/// The grade as 3×3 + offset, shared by the CPU and GPU paths.
struct Grade {
  std::array<float, 3> gain{1, 1, 1};
  float lift = 0;
  float sat = 1;
  float hc = 1;  // cos(hue)
  float hs = 0;  // sin(hue)
};

Grade grade_of(const PrInData* in, PrParamDef* const* params) {
  Grade g;
  for (std::size_t i = 0; i < 3; ++i) g.gain.at(i) = static_cast<float>(prs::num(params, in, kGain, i, 1));
  g.lift = static_cast<float>(prs::num(params, in, kLift) / 100);
  g.sat = static_cast<float>(prs::num(params, in, kSaturation, 0, 100) / 100);
  const double h = prs::num(params, in, kHue) * std::numbers::pi / 180;
  g.hc = static_cast<float>(std::cos(h));
  g.hs = static_cast<float>(std::sin(h));
  return g;
}

/// The same operations, in the same order, as the WGSL below.
prs::Px apply(const Grade& g, prs::Px p) {
  if (p.a <= 0) return {};
  const float inv = 1.0F / p.a;
  std::array<float, 3> c{p.r * inv * g.gain[0] + g.lift, p.g * inv * g.gain[1] + g.lift, p.b * inv * g.gain[2] + g.lift};
  const float l = 0.2126F * c[0] + 0.7152F * c[1] + 0.0722F * c[2];
  for (float& v : c) v = l + (v - l) * g.sat;
  // Rotation about the grey axis: R = cos·I + (1−cos)/3·J + sin/√3·S.
  const float k = (1 - g.hc) / 3;
  const float s = g.hs / std::sqrt(3.0F);
  const float sum = c[0] + c[1] + c[2];
  const std::array<float, 3> r{g.hc * c[0] + k * sum + s * (c[2] - c[1]), g.hc * c[1] + k * sum + s * (c[0] - c[2]),
                               g.hc * c[2] + k * sum + s * (c[1] - c[0])};
  return {r[0] * p.a, r[1] * p.a, r[2] * p.a, p.a};
}

constexpr const char* kWgsl = R"(
struct U { gain: vec4f, p: vec4f };  // p = (lift, sat, cos, sin)
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let px = textureLoad(src, vec2i(pos.xy), 0);
  if (px.a <= 0.0) { return vec4f(0.0); }
  let inv = 1.0 / px.a;
  var c = px.rgb * inv * u.gain.rgb + vec3f(u.p.x);
  let l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  c = vec3f(l) + (c - vec3f(l)) * u.p.y;
  let k = (1.0 - u.p.z) / 3.0;
  let s = u.p.w / sqrt(3.0);
  let sum = c.r + c.g + c.b;
  let r = vec3f(u.p.z * c.r + k * sum + s * (c.b - c.g),
                u.p.z * c.g + k * sum + s * (c.r - c.b),
                u.p.z * c.b + k * sum + s * (c.g - c.r));
  return vec4f(r * px.a, px.a);
}
)";

PrErr gpu_render(const PrInData* in, PrOutData* out, PrParamDef* const* params, PrSmartRenderGpuExtra* x) {
  if (const PrErr f = prs::inject(prs::by_id(params, in, prs::kFaultParamId), out); f != PR_ERR_NONE) return f;
  const prs::gpu::State* st = prs::gpu::state_of(in, x->gpu_data);
  if (st == nullptr || x->input == nullptr || x->output == nullptr) return PR_ERR_INVALID_PARAM;
  const Grade g = grade_of(in, params);
  const std::array<float, 8> u{g.gain[0], g.gain[1], g.gain[2], 1, g.lift, g.sat, g.hc, g.hs};
  const std::array<const PrGpuWorld*, 1> textures{x->input};
  const bool invalid = static_cast<int>(prs::num(params, in, kGpuFault, 0, kGpuFaultNone)) == kGpuFaultInvalidCommands;
  prs::gpu::draw(*st, x, textures, u, !invalid);
  return PR_ERR_NONE;
}

PrErr cpu_render(const PrInData* in, PrOutData* out, PrParamDef* const* params) {
  if (const PrErr f = prs::inject(prs::by_id(params, in, prs::kFaultParamId), out); f != PR_ERR_NONE) return f;
  PrWorld* src = nullptr;
  PrWorld* dst = nullptr;
  if (PrErr e = in->host->checkout_layer_pixels(in->host_ref, 0, &src); e != PR_ERR_NONE) return e;
  if (PrErr e = in->host->checkout_output(in->host_ref, &dst); e != PR_ERR_NONE) return e;
  if (dst == nullptr) return PR_ERR_NONE;
  const Grade g = grade_of(in, params);
  auto row = [&](int32_t y) {
    for (int32_t x = 0; x < dst->width; ++x) prs::write(*dst, x, y, apply(g, src != nullptr ? prs::read(*src, x, y) : prs::Px{}));
  };
  return prs::for_rows(in, dst->height, row);
}

PrErr PR_CALL grade_main(PrCmd cmd, const PrInData* in, PrOutData* out, PrParamDef* const* params, PrWorld* /*output*/,
                         void* extra) {
  switch (cmd) {
    case PR_CMD_ABOUT: prs::message(out, "Color Grade 1.0 — Premation SDK sample (GPU effect on the engine's Dawn device)."); return PR_ERR_NONE;
    case PR_CMD_GLOBAL_SETUP:
      out->my_version = PR_VERSION(1, 0, 0);
      out->out_flags = PR_OUT_FLAG_DEEP_COLOR_AWARE | PR_OUT_FLAG_FLOAT_COLOR_AWARE | PR_OUT_FLAG_SMART_RENDER |
                       PR_OUT_FLAG_GPU_RENDER | PR_OUT_FLAG_THREADED_RENDER;
      return PR_ERR_NONE;
    case PR_CMD_PARAMS_SETUP: {
      PrErr e = prs::add_simple(in, PR_PARAM_COLOR, kGain, "Gain", {1, 1, 1, 1});
      if (e == PR_ERR_NONE) e = prs::add_float(in, kLift, "Lift", 0, -100, 100, -20, 20, 2);
      if (e == PR_ERR_NONE) e = prs::add_float(in, kSaturation, "Saturation", 100, 0, 400, 0, 200, 1);
      if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_ANGLE, kHue, "Hue", {0, 0, 0, 0});
      // The shared Debug group, plus this sample's GPU-side fault.
      if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_GROUP_START, prs::kFaultGroupId, "Debug", {}, PR_PARAM_FLAG_START_COLLAPSED);
      if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_POPUP, prs::kFaultParamId, "Fault", {1, 0, 0, 0}, 0, prs::kFaultChoices);
      if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_POPUP, kGpuFault, "GPU Fault", {kGpuFaultNone, 0, 0, 0}, 0, "None|Invalid commands");
      if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_GROUP_END, prs::kFaultGroupEndId, "", {});
      return e;
    }
    case PR_CMD_SMART_PRE_RENDER: return in->host->checkout_layer(in->host_ref, 0, 0, in->current_time, nullptr);
    case PR_CMD_SMART_RENDER: return cpu_render(in, out, params);
    case PR_CMD_GPU_DEVICE_SETUP: return prs::gpu::setup(in, static_cast<PrGpuDeviceSetupExtra*>(extra), kWgsl, "prs-grade", 32);
    case PR_CMD_GPU_DEVICE_SETDOWN: return prs::gpu::setdown(in, static_cast<PrGpuDeviceSetupExtra*>(extra));
    case PR_CMD_SMART_RENDER_GPU: return gpu_render(in, out, params, static_cast<PrSmartRenderGpuExtra*>(extra));
    default: return PR_ERR_NONE;
  }
}

const PrEffectEntry kEffects[] = {{"com.premation.samples.grade", &grade_main}};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): C ABI table
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, "com.premation.samples.grade", 1, kEffects};

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
