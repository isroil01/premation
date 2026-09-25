// Shared GPU helpers for the SDK samples' SMART_RENDER_GPU paths (not part of
// the SDK itself): the per-device state GPU_DEVICE_SETUP builds — one WGSL
// module, a full-output pipeline per PrGpuFormat, a uniform buffer — kept
// behind the gpu_data handle, and the one draw a render records.
//
// WebGPU is called through the DawnProcTable the host hands over
// (PrGpuDeviceInfo.procs), so a sample links no Dawn of its own.
#pragma once

#include <premation_sdk/premation_sdk.h>

#include <dawn/dawn_proc_table.h>
#include <webgpu/webgpu.h>

#include <array>
#include <cstdint>
#include <cstring>
#include <span>

namespace prs::gpu {

/// What GPU_DEVICE_SETUP builds, stored (by pointer) in the per-device handle.
struct State {
  const DawnProcTable* procs = nullptr;
  WGPUDevice device = nullptr;
  WGPUQueue queue = nullptr;
  WGPUShaderModule module = nullptr;
  std::array<WGPURenderPipeline, 3> pipelines{};  // by PrGpuFormat
  WGPUBuffer uniforms = nullptr;
  uint64_t uniformBytes = 0;
};

inline WGPUTextureFormat wgpu_format(PrGpuFormat f) {
  return f == PR_GPU_FORMAT_RGBA32_FLOAT   ? WGPUTextureFormat_RGBA32Float
         : f == PR_GPU_FORMAT_RGBA16_FLOAT ? WGPUTextureFormat_RGBA16Float
                                           : WGPUTextureFormat_RGBA8Unorm;
}

inline WGPUStringView sv(const char* s) { return WGPUStringView{s, WGPU_STRLEN}; }

/// GPU_DEVICE_SETUP. `wgsl` has entry points `vs` (a full-output triangle from
/// vertex_index) and `fs`; its textures sit at bindings 0… and the uniform
/// block of `uniformBytes` right after them.
inline PrErr setup(const PrInData* in, PrGpuDeviceSetupExtra* x, const char* wgsl, const char* label, uint64_t uniformBytes) {
  const auto* procs = static_cast<const DawnProcTable*>(x->device->procs);
  if (procs == nullptr || x->device->framework != PR_GPU_FRAMEWORK_WEBGPU_DAWN) return PR_ERR_UNSUPPORTED;
  const PrHandle h = in->host->handle_new(in->host_ref, sizeof(State*));
  if (h == 0) return PR_ERR_OUT_OF_MEMORY;
  auto* st = new State();  // NOLINT(cppcoreguidelines-owning-memory): owned through the handle until GPU_DEVICE_SETDOWN
  st->procs = procs;
  st->device = static_cast<WGPUDevice>(x->device->wgpu_device);
  st->queue = static_cast<WGPUQueue>(x->device->wgpu_queue);
  st->uniformBytes = uniformBytes;
  procs->deviceAddRef(st->device);
  procs->queueAddRef(st->queue);

  WGPUShaderSourceWGSL source = WGPU_SHADER_SOURCE_WGSL_INIT;
  source.code = sv(wgsl);
  WGPUShaderModuleDescriptor md = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
  md.nextInChain = &source.chain;
  md.label = sv(label);
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
    pd.label = sv(label);
    pd.vertex.module = st->module;
    pd.vertex.entryPoint = sv("vs");
    pd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    pd.fragment = &frag;
    st->pipelines.at(static_cast<std::size_t>(f)) = procs->deviceCreateRenderPipeline(st->device, &pd);
  }
  WGPUBufferDescriptor bd = WGPU_BUFFER_DESCRIPTOR_INIT;
  bd.label = sv(label);
  bd.size = uniformBytes;
  bd.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
  st->uniforms = procs->deviceCreateBuffer(st->device, &bd);

  std::memcpy(in->host->handle_lock(in->host_ref, h), &st, sizeof(st));
  x->gpu_data = h;
  return PR_ERR_NONE;
}

inline State* state_of(const PrInData* in, PrHandle h) {
  void* p = in->host->handle_lock(in->host_ref, h);
  if (p == nullptr) return nullptr;
  State* st = nullptr;
  std::memcpy(&st, p, sizeof(st));
  return st;
}

/// GPU_DEVICE_SETDOWN: release what setup built (the device may be lost — releasing is still valid).
inline PrErr setdown(const PrInData* in, PrGpuDeviceSetupExtra* x) {
  State* st = state_of(in, x->gpu_data);
  if (st != nullptr) {
    const DawnProcTable* p = st->procs;
    for (WGPURenderPipeline rp : st->pipelines) {
      if (rp != nullptr) p->renderPipelineRelease(rp);
    }
    if (st->module != nullptr) p->shaderModuleRelease(st->module);
    if (st->uniforms != nullptr) p->bufferRelease(st->uniforms);
    p->queueRelease(st->queue);
    p->deviceRelease(st->device);
    delete st;  // NOLINT(cppcoreguidelines-owning-memory): see setup
  }
  in->host->handle_dispose(in->host_ref, x->gpu_data);
  x->gpu_data = 0;
  return PR_ERR_NONE;
}

/// Record one draw over the whole output into the host's encoder: `textures`
/// at bindings 0…, then `uniforms`. `valid` false leaves the pipeline and bind
/// group unset — the samples' injected GPU fault, a validation error at Finish.
inline void draw(const State& st, const PrSmartRenderGpuExtra* x, std::span<const PrGpuWorld* const> textures, std::span<const float> uniforms,
                 bool valid = true) {
  const DawnProcTable* p = st.procs;
  const WGPURenderPipeline pipe = st.pipelines.at(static_cast<std::size_t>(x->output->format));
  // Queue-ordered: the host submits this call's commands before the next call can write again.
  p->queueWriteBuffer(st.queue, st.uniforms, 0, uniforms.data(), uniforms.size_bytes());

  const WGPUBindGroupLayout layout = p->renderPipelineGetBindGroupLayout(pipe, 0);
  std::array<WGPUBindGroupEntry, 4> entries{};
  const std::size_t n = textures.size();
  for (std::size_t i = 0; i < n; ++i) {
    entries.at(i) = WGPU_BIND_GROUP_ENTRY_INIT;
    entries.at(i).binding = static_cast<uint32_t>(i);
    entries.at(i).textureView = static_cast<WGPUTextureView>(textures[i]->wgpu_texture_view);
  }
  entries.at(n) = WGPU_BIND_GROUP_ENTRY_INIT;
  entries.at(n).binding = static_cast<uint32_t>(n);
  entries.at(n).buffer = st.uniforms;
  entries.at(n).size = st.uniformBytes;
  WGPUBindGroupDescriptor bgd = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
  bgd.layout = layout;
  bgd.entryCount = n + 1;
  bgd.entries = entries.data();
  const WGPUBindGroup bg = p->deviceCreateBindGroup(st.device, &bgd);

  WGPURenderPassColorAttachment ca = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
  ca.view = static_cast<WGPUTextureView>(x->output->wgpu_texture_view);
  ca.loadOp = WGPULoadOp_Clear;
  ca.storeOp = WGPUStoreOp_Store;
  WGPURenderPassDescriptor rp = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
  rp.colorAttachmentCount = 1;
  rp.colorAttachments = &ca;
  const WGPURenderPassEncoder pass = p->commandEncoderBeginRenderPass(static_cast<WGPUCommandEncoder>(x->wgpu_command_encoder), &rp);
  if (valid) {
    p->renderPassEncoderSetPipeline(pass, pipe);
    p->renderPassEncoderSetBindGroup(pass, 0, bg, 0, nullptr);
  }
  p->renderPassEncoderDraw(pass, 3, 1, 0, 0);
  p->renderPassEncoderEnd(pass);
  p->renderPassEncoderRelease(pass);
  p->bindGroupRelease(bg);
  p->bindGroupLayoutRelease(layout);
}

}  // namespace prs::gpu
