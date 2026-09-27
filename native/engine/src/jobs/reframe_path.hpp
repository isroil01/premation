// Auto-reframe's camera path — src/core/reframe/reframePath.ts, ported
// operation for operation (Math.exp through motion_jsmath). Pure.
#pragma once

#include <cstdint>
#include <span>
#include <vector>

namespace premation::jobs::reframe {

struct Geometry {
  double sourceWidth = 0;
  double sourceHeight = 0;
  double targetWidth = 0;
  double targetHeight = 0;
};

struct Attention {
  double x = 0.5;
  double y = 0.5;
  double confidence = 1;
};

struct PathOptions {
  double deadZone = 0.12;
  double lagSeconds = 0.5;
  double sampleRate = 12;
  double confidenceFloor = 0.05;
};

struct XYPath {
  std::vector<double> x;
  std::vector<double> y;
};

struct Pan {
  double x = 0;
  double y = 0;
};

[[nodiscard]] double cover_scale(const Geometry& g) noexcept;
[[nodiscard]] Pan pan_range(const Geometry& g) noexcept;
[[nodiscard]] XYPath build_reframe_path(std::span<const Attention> samples, std::span<const int> cuts, const Geometry& g,
                                        const PathOptions& options);

enum class PathEase : std::uint8_t { linear, step };

struct PathKeyframe {
  double t = 0;
  double value = 0;
  PathEase easing = PathEase::linear;
};

[[nodiscard]] std::vector<PathKeyframe> path_to_keyframes(std::span<const double> path, std::span<const int> cuts, double sampleRate,
                                                         double tolerance = 0.75);

}  // namespace premation::jobs::reframe
