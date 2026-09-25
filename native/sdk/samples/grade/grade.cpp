// Sample GPU effect: Color Grade — gain, lift, saturation and hue rotation in
// straight linear colour. PR_CMD_SMART_RENDER_GPU renders it with WGSL on the
// ENGINE's Dawn device (the texture the chain holds goes in, a texture the
// engine composites comes out: no readback, no copy); PR_CMD_SMART_RENDER is
// the same maths on the CPU, used when the host has no GPU path for the frame.
//
// WebGPU is called through the DawnProcTable the host hands over
// (PrGpuDeviceInfo.procs), so this module links no Dawn of its own.
//
//   Gain (color) · Lift · Saturation · Hue (angle) ▸ Debug: Fault, GPU Fault
//
// GPU Fault = "Invalid commands" records a draw with no pipeline set — a
// validation error the host's error scope catches: the command buffer is
// dropped unsubmitted and the frame renders through the CPU path instead.
#include <premation_sdk/premation_sdk.h>

#include <dawn/dawn_proc_table.h>
#include <webgpu/webgpu.h>

#include <array>
#include <cmath>
#include <cstring>
#include <numbers>

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

/// What GPU_DEVICE_SETUP builds, stored (by pointer) in the per-device handle.
struct GpuState {
  const DawnProcTable* procs = nullptr;
  WGPUDevice device = nullptr;
  WGPUQueue queue = nullptr;
  WGPUShaderModule module = nullptr;
  std::array<WGPURenderPipeline, 3> pipelines{};  // by PrGpuFormat
  WGPUBuffer uniforms = nullptr;
};

WGPUTextureFormat wgpu_format(PrGpuFormat f) {
  return f == PR_GPU_FORMAT_RGBA32_FLOAT   ? WGPUTextureFormat_RGBA32Float
         : f == PR_GPU_FORMAT_RGBA16_FLOAT ? WGPUTextureFormat_RGBA16Float
                                           : WGPUTextureFormat_RGBA8Unorm;
}

WGPUStringView sv(const char* s) { return WGPUStringView{s, WGPU_STRLEN}; }

PrErr gpu_setup(const PrInData* in, PrGpuDeviceSetupExtra* x) {
  const auto* procs = static_cast<const DawnProcTable*>(x->device->procs);
  if (procs == nullptr || x->device->framework != PR_GPU_FRAMEWORK_WEBGPU_DAWN) return PR_ERR_UNSUPPORTED;
  const PrHandle h = in->host->handle_new(in->host_ref, sizeof(GpuState*));
  if (h == 0) return PR_ERR_OUT_OF_MEMORY;
  auto* st = new GpuState();  // NOLINT(cppcoreguidelines-owning-memory): owned through the handle until GPU_DEVICE_SETDOWN
  st->procs = procs;
  st->device = static_cast<WGPUDevice>(x->device->wgpu_device);
  st->queue = static_cast<WGPUQueue>(x->device->wgpu_queue);
  procs->deviceAddRef(st->device);
  procs->queueAddRef(st->queue);

  WGPUShaderSourceWGSL wgsl = WGPU_SHADER_SOURCE_WGSL_INIT;
  wgsl.code = sv(kWgsl);
  WGPUShaderModuleDescriptor md = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
  md.nextInChain = &wgsl.chain;
  md.label = sv("prs-grade");
  st->module = procs->deviceCreateShaderModule(st->device, &md);

  for (PrGpuFormat f = PR_GPU_FORMAT_RGBA8_UNORM; f <= PR_GPU_FORMAT_RGBA32_FLOAT; ++f) {
    WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
    target.format = wgpu_format(f);
    WGPUFragmentState frag = WGPU_FRAGMENT_STATE_INIT;
    frag.module = st->module;
    frag.entryPoint = sv("fs");
    frag.targetCount = 1;
    frag.targets = &target;
    WGPURenderPipelineDescriptor pd = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    pd.label = sv("prs-grade");
    pd.vertex.module = st->module;
    pd.vertex.entryPoint = sv("vs");
    pd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    pd.fragment = &frag;
    st->pipelines.at(static_cast<std::size_t>(f)) = procs->deviceCreateRenderPipeline(st->device, &pd);
  }
  WGPUBufferDescriptor bd = WGPU_BUFFER_DESCRIPTOR_INIT;
  bd.label = sv("prs-grade-uniforms");
  bd.size = 32;
  bd.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
  st->uniforms = procs->deviceCreateBuffer(st->device, &bd);

  std::memcpy(in->host->handle_lock(in->host_ref, h), &st, sizeof(st));
  x->gpu_data = h;
  return PR_ERR_NONE;
}

GpuState* state_of(const PrInData* in, PrHandle h) {
  void* p = in->host->handle_lock(in->host_ref, h);
  if (p == nullptr) return nullptr;
  GpuState* st = nullptr;
  std::memcpy(&st, p, sizeof(st));
  return st;
}

PrErr gpu_setdown(const PrInData* in, PrGpuDeviceSetupExtra* x) {
  GpuState* st = state_of(in, x->gpu_data);
  if (st != nullptr) {
    const DawnProcTable* p = st->procs;
    for (WGPURenderPipeline rp : st->pipelines) {
      if (rp != nullptr) p->renderPipelineRelease(rp);
    }
    if (st->module != nullptr) p->shaderModuleRelease(st->module);
    if (st->uniforms != nullptr) p->bufferRelease(st->uniforms);
    p->queueRelease(st->queue);
    p->deviceRelease(st->device);
    delete st;  // NOLINT(cppcoreguidelines-owning-memory): see gpu_setup
  }
  in->host->handle_dispose(in->host_ref, x->gpu_data);
  x->gpu_data = 0;
  return PR_ERR_NONE;
}

PrErr gpu_render(const PrInData* in, PrOutData* out, PrParamDef* const* params, PrSmartRenderGpuExtra* x) {
  if (const PrErr f = prs::inject(prs::by_id(params, in, prs::kFaultParamId), out); f != PR_ERR_NONE) return f;
  GpuState* st = state_of(in, x->gpu_data);
  if (st == nullptr || x->input == nullptr || x->output == nullptr) return PR_ERR_INVALID_PARAM;
  const DawnProcTable* p = st->procs;
  const WGPURenderPipeline pipe = st->pipelines.at(static_cast<std::size_t>(x->output->format));
  const Grade g = grade_of(in, params);
  const std::array<float, 8> u{g.gain[0], g.gain[1], g.gain[2], 1, g.lift, g.sat, g.hc, g.hs};
  // Queue-ordered: the host submits this call's commands before the next call can write again.
  p->queueWriteBuffer(st->queue, st->uniforms, 0, u.data(), sizeof(u));

  const WGPUBindGroupLayout layout = p->renderPipelineGetBindGroupLayout(pipe, 0);
  std::array<WGPUBindGroupEntry, 2> entries{};
  entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
  entries[0].binding = 0;
  entries[0].textureView = static_cast<WGPUTextureView>(x->input->wgpu_texture_view);
  entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
  entries[1].binding = 1;
  entries[1].buffer = st->uniforms;
  entries[1].size = sizeof(u);
  WGPUBindGroupDescriptor bgd = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
  bgd.layout = layout;
  bgd.entryCount = entries.size();
  bgd.entries = entries.data();
  const WGPUBindGroup bg = p->deviceCreateBindGroup(st->device, &bgd);

  WGPURenderPassColorAttachment ca = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
  ca.view = static_cast<WGPUTextureView>(x->output->wgpu_texture_view);
  ca.loadOp = WGPULoadOp_Clear;
  ca.storeOp = WGPUStoreOp_Store;
  WGPURenderPassDescriptor rp = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
  rp.colorAttachmentCount = 1;
  rp.colorAttachments = &ca;
  const WGPURenderPassEncoder pass = p->commandEncoderBeginRenderPass(static_cast<WGPUCommandEncoder>(x->wgpu_command_encoder), &rp);
  const bool invalid = static_cast<int>(prs::num(params, in, kGpuFault, 0, kGpuFaultNone)) == kGpuFaultInvalidCommands;
  if (!invalid) {  // the injected GPU fault: a draw with no pipeline (a validation error at Finish)
    p->renderPassEncoderSetPipeline(pass, pipe);
    p->renderPassEncoderSetBindGroup(pass, 0, bg, 0, nullptr);
  }
  p->renderPassEncoderDraw(pass, 3, 1, 0, 0);
  p->renderPassEncoderEnd(pass);
  p->renderPassEncoderRelease(pass);
  p->bindGroupRelease(bg);
  p->bindGroupLayoutRelease(layout);
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
    case PR_CMD_GPU_DEVICE_SETUP: return gpu_setup(in, static_cast<PrGpuDeviceSetupExtra*>(extra));
    case PR_CMD_GPU_DEVICE_SETDOWN: return gpu_setdown(in, static_cast<PrGpuDeviceSetupExtra*>(extra));
    case PR_CMD_SMART_RENDER_GPU: return gpu_render(in, out, params, static_cast<PrSmartRenderGpuExtra*>(extra));
    default: return PR_ERR_NONE;
  }
}

const PrEffectEntry kEffects[] = {{"com.premation.samples.grade", &grade_main}};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): C ABI table
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, "com.premation.samples.grade", 1, kEffects};

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
