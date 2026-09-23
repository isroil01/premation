// The C2 compositor: draws a FrameScene (filled, transformed quads) into a
// scene-linear rgba16float target at comp resolution × preview resolution,
// then presents it letterboxed into an 8-bit slot texture.
//
// Both passes are the shaders C1 already runs: the layer pass is
// packages/renderer's `textured` WGSL verbatim (a 1×1 white texture tinted by
// the layer colour × opacity — exactly how the TS engine draws a solid), the
// display pass is engine_wgsl.hpp's `vs_blit/fs_blit`.
#pragma once

#include <webgpu/webgpu_cpp.h>

#include <cstdint>
#include <vector>

#include "frame_scene.hpp"
#include "gpu.hpp"

namespace premation::render {

class Compositor {
 public:
  bool init(const Gpu& gpu);

  /// Encode `scene` into `target` (an RGBA8Unorm view, targetWidth × targetHeight).
  void encode(wgpu::CommandEncoder& encoder, const FrameScene& scene, const wgpu::TextureView& target,
              std::uint32_t targetWidth, std::uint32_t targetHeight, double resolution);

 private:
  struct QuadSlot {
    wgpu::Buffer uniforms;
    wgpu::BindGroup group;
  };
  void ensure_rt(std::uint32_t w, std::uint32_t h);
  QuadSlot& quad_slot(std::size_t i);
  wgpu::RenderPipeline make_pipeline(const wgpu::ShaderModule& module, const char* vs, const char* fs,
                                     wgpu::TextureFormat format, bool vertexBuffer, bool blend);

  const Gpu* gpu_ = nullptr;
  wgpu::Buffer quad_;
  wgpu::Texture white_;
  wgpu::TextureView whiteView_;
  wgpu::Sampler clamp_;
  wgpu::ShaderModule texturedModule_;
  wgpu::ShaderModule presentModule_;
  wgpu::RenderPipeline textured_;
  wgpu::RenderPipeline blit_;
  wgpu::Buffer blitU_;
  wgpu::BindGroup blitGroup_;
  wgpu::Texture rt_;
  wgpu::TextureView rtView_;
  std::uint32_t rtW_ = 0;
  std::uint32_t rtH_ = 0;
  std::vector<QuadSlot> quads_;
};

}  // namespace premation::render
