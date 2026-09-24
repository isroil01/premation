/*
 * Premation native plugin SDK — the GPU path.
 *
 * The engine renders on Dawn (Chromium's WebGPU implementation) over D3D12 /
 * Metal / Vulkan. A GPU effect (PR_OUT_FLAG_GPU_RENDER) is handed the engine's
 * OWN device and textures — no copy, no readback:
 *
 *   PR_CMD_GPU_DEVICE_SETUP     once per device: build pipelines, keep them in
 *                               `gpu_data` (a handle the plugin fills).
 *   PR_CMD_SMART_RENDER_GPU     per frame: record commands into the HOST's
 *                               command encoder that read `input` and write
 *                               `output`. Never submit; never keep the encoder.
 *   PR_CMD_GPU_DEVICE_SETDOWN   release what setup built.
 *
 * WebGPU handles are Dawn's C objects (webgpu.h: WGPUDevice, WGPUTexture, …).
 * Call them through `procs` — Dawn's DawnProcTable (<dawn/dawn_proc_table.h>)
 * for the engine's Dawn — so the plugin never links its own copy of Dawn (two
 * copies would each have their own globals). Dawn's objects are ref-counted:
 * the host's handles are borrowed for the call; AddRef what you keep.
 *
 * Native handles: where Dawn exposes them, the backend's own device and queue
 * are provided too (D3D12: ID3D12Device*, ID3D12CommandQueue*). A plugin that
 * uses them must synchronise itself with Dawn; the WebGPU path is the
 * supported one. `native_texture` is NULL where the pinned Dawn does not expose
 * a texture's backend resource (D3D12 today).
 *
 * Isolation: the host wraps the selector in a crash guard AND a WebGPU error
 * scope; a validation / out-of-memory error from the plugin's commands fails
 * the effect for that layer exactly like a crash (the command buffer is never
 * submitted), never the frame.
 */
#ifndef PREMATION_SDK_PR_GPU_H
#define PREMATION_SDK_PR_GPU_H

#include "pr_types.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef int32_t PrGpuFramework;
#define PR_GPU_FRAMEWORK_NONE 0
#define PR_GPU_FRAMEWORK_WEBGPU_DAWN 1

typedef int32_t PrGpuBackend;
#define PR_GPU_BACKEND_UNKNOWN 0
#define PR_GPU_BACKEND_D3D12 1
#define PR_GPU_BACKEND_METAL 2
#define PR_GPU_BACKEND_VULKAN 3

/** GPU texture formats (WebGPU names). */
typedef int32_t PrGpuFormat;
#define PR_GPU_FORMAT_RGBA8_UNORM 0
#define PR_GPU_FORMAT_RGBA16_FLOAT 1
#define PR_GPU_FORMAT_RGBA32_FLOAT 2

typedef struct PrGpuDeviceInfo {
  uint32_t struct_size;
  PrGpuFramework framework;
  PrGpuBackend backend;
  uint32_t device_index;       /* distinguishes devices across SETUP/SETDOWN pairs */
  const void* procs;           /* const DawnProcTable* */
  void* wgpu_instance;         /* WGPUInstance */
  void* wgpu_adapter;          /* WGPUAdapter (may be NULL) */
  void* wgpu_device;           /* WGPUDevice */
  void* wgpu_queue;            /* WGPUQueue */
  void* native_device;         /* ID3D12Device* / id<MTLDevice> / VkDevice, or NULL */
  void* native_queue;          /* ID3D12CommandQueue* / id<MTLCommandQueue> / VkQueue, or NULL */
  int32_t float32_filterable;  /* rgba32float may be sampled with a filtering sampler */
} PrGpuDeviceInfo;

/**
 * A texture handed to the plugin: full frame, premultiplied, linear working
 * space, the same pixels a CPU world would hold. `input` is sampleable
 * (TEXTURE_BINDING, COPY_SRC); `output` is a render attachment, storage
 * texture and copy destination (RENDER_ATTACHMENT | STORAGE_BINDING |
 * TEXTURE_BINDING | COPY_DST | COPY_SRC). The output's content is undefined:
 * write every pixel.
 */
typedef struct PrGpuWorld {
  uint32_t struct_size;
  int32_t width;
  int32_t height;
  PrGpuFormat format;
  void* wgpu_texture;       /* WGPUTexture */
  void* wgpu_texture_view;  /* WGPUTextureView (whole texture, one mip) */
  void* native_texture;     /* backend resource where exposed, else NULL */
} PrGpuWorld;

/** extra for PR_CMD_GPU_DEVICE_SETUP / PR_CMD_GPU_DEVICE_SETDOWN. */
typedef struct PrGpuDeviceSetupExtra {
  uint32_t struct_size;
  const PrGpuDeviceInfo* device;
  PrHandle gpu_data; /* SETUP: the plugin stores its per-device handle here; SETDOWN: it disposes it */
} PrGpuDeviceSetupExtra;

/** extra for PR_CMD_SMART_RENDER_GPU. */
typedef struct PrSmartRenderGpuExtra {
  uint32_t struct_size;
  const PrGpuDeviceInfo* device;
  PrHandle gpu_data;           /* what GPU_DEVICE_SETUP stored */
  void* wgpu_command_encoder;  /* WGPUCommandEncoder: record into it; the host finishes + submits */
  const PrGpuWorld* input;
  const PrGpuWorld* output;
  PrHandle pre_render_data;    /* what SMART_PRE_RENDER left in PrPreRenderExtra.pre_render_data */
} PrSmartRenderGpuExtra;

#ifdef __cplusplus
}
#endif

#endif /* PREMATION_SDK_PR_GPU_H */
