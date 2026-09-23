// Decoded frame → GPU texture the render graph samples (Dawn, render thread).
//
//   CPU frame  → its planes are written as-is into R/RG/RGBA 8- or 16-bit UINT
//                textures (one WriteTexture per plane, the decoder's own row
//                stride — no repacking) and a WGSL pass converts them.
//   GPU frame  → (Windows, zero-copy) the shared NV12/P010 surface is imported
//                once per pool slot as a Dawn multi-planar texture
//                (SharedTextureMemory, keyed mutex), its two plane views feed
//                the same WGSL pass. No byte crosses the CPU.
//
// The pass applies the frame's Y'CbCr matrix + range (yuv.hpp), bilinear
// chroma upsampling (co-sited horizontally, centred vertically — the
// MPEG-2/H.264/HEVC default and ProRes/DNx 4:2:2), alpha scaling and
// premultiplication (textures are premultiplied; a straight file is multiplied
// once here, AppTextureProvider.ts). Output: RGBA16Float by default (10/12-bit
// sources keep their precision), the stream's own non-linear R'G'B' — the
// render graph's inputSpace decides what that means.
#pragma once

#include <webgpu/webgpu_cpp.h>

#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "decoded_frame.hpp"
#include "media_types.hpp"

namespace premation::media {

/// Optional Dawn features the converter uses when the device has them.
/// Request these (when the adapter offers them) at device creation.
[[nodiscard]] std::vector<wgpu::FeatureName> wanted_device_features(const wgpu::Adapter& adapter);
/// The same list unfiltered (rg::RendererOptions::optionalFeatures filters by adapter).
[[nodiscard]] std::vector<wgpu::FeatureName> candidate_device_features();

struct ConvertedFrame {
  wgpu::Texture texture;
  wgpu::TextureView view;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  bool zeroCopy = false;
};

struct ConvertStats {
  std::uint64_t conversions = 0;
  std::uint64_t zeroCopy = 0;
  std::uint64_t uploadedBytes = 0;
  std::uint64_t imports = 0;
  double importMs = 0;  // CPU time spent importing shared surfaces into Dawn (once per pool slot)
};

class FrameConverter {
 public:
  explicit FrameConverter(wgpu::Device device, wgpu::TextureFormat output = wgpu::TextureFormat::RGBA16Float);
  ~FrameConverter();
  FrameConverter(const FrameConverter&) = delete;
  FrameConverter& operator=(const FrameConverter&) = delete;
  FrameConverter(FrameConverter&&) = delete;
  FrameConverter& operator=(FrameConverter&&) = delete;

  /// The device can import this platform's hardware surfaces.
  [[nodiscard]] bool zero_copy_capable() const noexcept { return zeroCopyNv12_; }
  /// …including 10-bit P010 surfaces (DecoderOptions::keepHighBitOnGpu).
  [[nodiscard]] bool zero_copy_p010() const noexcept { return zeroCopyP010_; }

  /// Convert `f` into a new (or recycled) texture; encodes and submits its own
  /// command buffer. False (with `error`) when the frame can't be converted.
  bool convert(const DecodedFrame& f, AlphaMode alpha, ConvertedFrame& out, std::string& error);
  /// Pulldown weave: even rows from `top`, odd rows from `bottom`.
  bool weave(const ConvertedFrame& top, const ConvertedFrame& bottom, ConvertedFrame& out, std::string& error);
  /// Give a texture back for reuse (same size + format).
  void recycle(ConvertedFrame&& f);

  [[nodiscard]] const ConvertStats& stats() const noexcept { return stats_; }
  [[nodiscard]] wgpu::TextureFormat output_format() const noexcept { return output_; }

 private:
  struct PlaneTex {
    wgpu::Texture texture;
    wgpu::TextureView view;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    wgpu::TextureFormat format = wgpu::TextureFormat::Undefined;
  };
  struct Imported;
  bool ensure_plane(PlaneTex& p, std::uint32_t w, std::uint32_t h, wgpu::TextureFormat fmt);
  ConvertedFrame target(std::uint32_t w, std::uint32_t h);
  void run_pass(bool floatPlanes, const std::array<wgpu::TextureView, 4>& planes, const std::vector<float>& uniforms,
                const ConvertedFrame& out);

  wgpu::Device device_;
  wgpu::Queue queue_;
  wgpu::TextureFormat output_;
  bool zeroCopyNv12_ = false;
  bool zeroCopyP010_ = false;
  wgpu::RenderPipeline uintPipeline_;
  wgpu::RenderPipeline floatPipeline_;
  wgpu::RenderPipeline weavePipeline_;
  wgpu::Buffer uniforms_;
  std::array<PlaneTex, 4> planes_{};
  wgpu::TextureView dummyUint_;
  wgpu::TextureView dummyFloat_;
  std::vector<ConvertedFrame> free_;
  std::unordered_map<std::uint64_t, std::unique_ptr<Imported>> imported_;
  ConvertStats stats_;
};

}  // namespace premation::media
