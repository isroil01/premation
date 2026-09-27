// Where the eye goes in a frame — src/core/reframe/saliency.ts, ported
// operation for operation (Math.cos / Math.hypot through motion_jsmath).
// Pixels in, a point out. The camera path is reframe_path.hpp.
#pragma once

#include <cstdint>
#include <span>
#include <vector>

namespace premation::jobs::saliency {

struct Options {
  double motionWeight = 1;
  double detailWeight = 0.35;
  double centrePrior = 1.5;
};

struct AttentionPoint {
  double x = 0.5;
  double y = 0.5;
  double confidence = 0;
};

struct FrameAnalysis {
  AttentionPoint point;
  std::vector<float> luma;
};

/// Rec.601 luma in 0..255 (lumaFromRgba). `rgba` is straight RGBA8, tightly packed.
[[nodiscard]] std::vector<float> luma_from_rgba(std::span<const std::uint8_t> rgba, std::uint32_t width, std::uint32_t height);

/// Per-pixel interest. `previous` null (or a different length) contributes no motion.
[[nodiscard]] std::vector<float> saliency_map(std::span<const float> luma, const std::vector<float>* previous, std::uint32_t width,
                                              std::uint32_t height, const Options& options = {});

/// ADD a cosine bell scaled by the map's own mean energy. No-op when the map has no energy.
void add_centre_prior(std::span<float> map, std::uint32_t width, std::uint32_t height, double strength);

[[nodiscard]] AttentionPoint attention_centre(std::span<const float> map, std::uint32_t width, std::uint32_t height);

[[nodiscard]] FrameAnalysis analyse_frame(std::span<const std::uint8_t> rgba, const std::vector<float>* previousLuma, std::uint32_t width,
                                          std::uint32_t height, const Options& options = {});

}  // namespace premation::jobs::saliency
