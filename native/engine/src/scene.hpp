// The C1 test scene: a real (small) render graph on Dawn using the TypeScript
// engine's WGSL verbatim.
//
//   textured  (renderer 'textured')   tiled background + a rotating card → rtA  (rgba16float, comp res)
//   blur H    (renderer 'blur')       rtA → rtB
//   blur V    (renderer 'blur')       rtB → rtA
//   vignette  (renderer 'vignette')   rtA → rtB
//   present   (engine_wgsl.hpp)       rtB → target (8-bit, any size, letterboxed) + frame counter
//
// Pixels are a pure function of the frame index (no clock reads).
#pragma once

#include <webgpu/webgpu_cpp.h>

#include <cstdint>
#include <map>

#include "gpu.hpp"

namespace premation {

class Scene {
 public:
  bool init(const Gpu& gpu, std::uint32_t compWidth, std::uint32_t compHeight);

  // Encode one frame. `target` is any RGBA8/BGRA8 unorm view of size
  // targetWidth × targetHeight; the comp is letterboxed into it.
  void encode(wgpu::CommandEncoder& encoder, std::uint32_t frame, const wgpu::TextureView& target,
              wgpu::TextureFormat targetFormat, std::uint32_t targetWidth, std::uint32_t targetHeight);

  std::uint32_t comp_width() const { return compW_; }
  std::uint32_t comp_height() const { return compH_; }

 private:
  struct PresentPipelines {
    wgpu::RenderPipeline blit;
    wgpu::RenderPipeline bits;
    wgpu::BindGroup blitGroup;
    wgpu::BindGroup bitsGroup;
  };
  const PresentPipelines& present_for(wgpu::TextureFormat format);
  wgpu::RenderPipeline make_pipeline(const wgpu::ShaderModule& module, const char* vs, const char* fs,
                                     wgpu::TextureFormat format, bool vertexBuffer);
  wgpu::BindGroup make_group(const wgpu::RenderPipeline& pipeline, const wgpu::Buffer& uniforms,
                             const wgpu::TextureView& texture, const wgpu::Sampler& sampler);

  const Gpu* gpu_ = nullptr;
  std::uint32_t compW_ = 0;
  std::uint32_t compH_ = 0;

  wgpu::Buffer quad_;
  wgpu::Texture source_;
  wgpu::Texture white_;
  wgpu::Texture rtA_;
  wgpu::Texture rtB_;
  wgpu::TextureView rtAView_;
  wgpu::TextureView rtBView_;
  wgpu::Sampler repeat_;
  wgpu::Sampler clamp_;

  wgpu::ShaderModule texturedModule_;
  wgpu::ShaderModule blurModule_;
  wgpu::ShaderModule vignetteModule_;
  wgpu::ShaderModule presentModule_;

  wgpu::RenderPipeline textured_;
  wgpu::RenderPipeline blur_;
  wgpu::RenderPipeline vignette_;

  // One uniform buffer + bind group per draw; written every frame.
  wgpu::Buffer bgU_, cardU_, blurHU_, blurVU_, vignetteU_, blitU_, bitsU_;
  wgpu::BindGroup bgGroup_, cardGroup_, blurHGroup_, blurVGroup_, vignetteGroup_;

  std::map<wgpu::TextureFormat, PresentPipelines> present_;
};

}  // namespace premation
