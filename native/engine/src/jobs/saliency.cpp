#include "saliency.hpp"

#include <algorithm>
#include <cmath>
#include <numbers>

#include "jsmath.hpp"

namespace premation::jobs::saliency {

std::vector<float> luma_from_rgba(std::span<const std::uint8_t> rgba, std::uint32_t width, std::uint32_t height) {
  const std::size_t n = static_cast<std::size_t>(width) * height;
  std::vector<float> out(n, 0.f);
  const std::size_t bytes = std::min(rgba.size() / 4, n);
  for (std::size_t i = 0; i < bytes; ++i) {
    const std::size_t p = i * 4;
    const double y = 0.299 * static_cast<double>(rgba[p]) + 0.587 * static_cast<double>(rgba[p + 1]) + 0.114 * static_cast<double>(rgba[p + 2]);
    out[i] = static_cast<float>(y);
  }
  return out;
}

std::vector<float> saliency_map(std::span<const float> luma, const std::vector<float>* previous, std::uint32_t width, std::uint32_t height,
                                const Options& options) {
  const std::size_t n = static_cast<std::size_t>(width) * height;
  std::vector<float> out(n, 0.f);
  if (width < 3 || height < 3 || luma.size() < n) return out;
  const bool usePrevious = previous != nullptr && previous->size() == luma.size();
  for (std::uint32_t y = 1; y + 1 < height; ++y) {
    for (std::uint32_t x = 1; x + 1 < width; ++x) {
      const std::size_t i = static_cast<std::size_t>(y) * width + x;
      const double dx = std::abs(static_cast<double>(luma[i + 1]) - static_cast<double>(luma[i - 1]));
      const double dy = std::abs(static_cast<double>(luma[i + width]) - static_cast<double>(luma[i - width]));
      const double detail = (dx + dy) * 0.5;
      const double motion = usePrevious ? std::abs(static_cast<double>(luma[i]) - static_cast<double>((*previous)[i])) : 0;
      out[i] = static_cast<float>(motion * options.motionWeight + detail * options.detailWeight);
    }
  }
  if (options.centrePrior > 0) add_centre_prior(out, width, height, options.centrePrior);
  return out;
}

void add_centre_prior(std::span<float> map, std::uint32_t width, std::uint32_t height, double strength) {
  const std::size_t n = static_cast<std::size_t>(width) * height;
  if (map.size() < n || n == 0 || !(strength > 0)) return;
  double total = 0;
  for (std::size_t i = 0; i < n; ++i) total += static_cast<double>(map[i]);
  if (total <= 0) return;
  const double mean = total / static_cast<double>(n);
  const double cx = (static_cast<double>(width) - 1) / 2;
  const double cy = (static_cast<double>(height) - 1) / 2;
  const double rx = std::max(1.0, cx);
  const double ry = std::max(1.0, cy);
  for (std::uint32_t y = 0; y < height; ++y) {
    for (std::uint32_t x = 0; x < width; ++x) {
      const double nx = (static_cast<double>(x) - cx) / rx;
      const double ny = (static_cast<double>(y) - cy) / ry;
      const double pair[2] = {nx, ny};
      const double r = std::min(1.0, motion::js::hypot(pair));
      const double bell = 0.5 + 0.5 * motion::js::cos(std::numbers::pi * r);
      const std::size_t i = static_cast<std::size_t>(y) * width + x;
      map[i] = static_cast<float>(static_cast<double>(map[i]) + mean * strength * bell);
    }
  }
}

AttentionPoint attention_centre(std::span<const float> map, std::uint32_t width, std::uint32_t height) {
  const std::size_t n = static_cast<std::size_t>(width) * height;
  if (width == 0 || height == 0 || map.size() < n) return {};
  double total = 0;
  double sx = 0;
  double sy = 0;
  for (std::uint32_t y = 0; y < height; ++y) {
    for (std::uint32_t x = 0; x < width; ++x) {
      const double w = static_cast<double>(map[static_cast<std::size_t>(y) * width + x]);
      if (w <= 0) continue;
      total += w;
      sx += static_cast<double>(x) * w;
      sy += static_cast<double>(y) * w;
    }
  }
  if (total <= 0) return AttentionPoint{0.5, 0.5, 0};

  const double cx = sx / total;
  const double cy = sy / total;
  const double halfW = std::max(1.0, static_cast<double>(width) / 6);
  const double halfH = std::max(1.0, static_cast<double>(height) / 6);
  double inside = 0;
  const int x0 = std::max(0, static_cast<int>(std::floor(cx - halfW)));
  const int x1 = std::min(static_cast<int>(width) - 1, static_cast<int>(std::ceil(cx + halfW)));
  const int y0 = std::max(0, static_cast<int>(std::floor(cy - halfH)));
  const int y1 = std::min(static_cast<int>(height) - 1, static_cast<int>(std::ceil(cy + halfH)));
  for (int y = y0; y <= y1; ++y) {
    for (int x = x0; x <= x1; ++x) inside += std::max(0.0, static_cast<double>(map[static_cast<std::size_t>(y) * width + static_cast<std::uint32_t>(x)]));
  }
  const double share = inside / total;
  const double uniform = (static_cast<double>(x1 - x0 + 1) * static_cast<double>(y1 - y0 + 1)) /
                         (static_cast<double>(width) * static_cast<double>(height));
  const double confidence = uniform >= 1 ? 0 : std::max(0.0, std::min(1.0, (share - uniform) / (1 - uniform)));
  return AttentionPoint{cx / std::max(1.0, static_cast<double>(width) - 1), cy / std::max(1.0, static_cast<double>(height) - 1), confidence};
}

FrameAnalysis analyse_frame(std::span<const std::uint8_t> rgba, const std::vector<float>* previousLuma, std::uint32_t width, std::uint32_t height,
                            const Options& options) {
  FrameAnalysis out;
  out.luma = luma_from_rgba(rgba, width, height);
  const std::vector<float> map = saliency_map(out.luma, previousLuma, width, height, options);
  out.point = attention_centre(map, width, height);
  return out;
}

}  // namespace premation::jobs::saliency
