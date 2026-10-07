#include "sam_pipeline.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>

namespace premation::jobs::sam {

namespace {

/// JavaScript Math.round for x ≥ 0 (ties up), without floor(x + 0.5)'s rounding slip.
double js_round(double x) noexcept {
  const double r = std::floor(x);
  return x - r >= 0.5 ? r + 1 : r;
}

}  // namespace

Letterbox letterbox(std::uint32_t width, std::uint32_t height) noexcept {
  Letterbox l;
  const std::uint32_t edge = std::max(width, height);
  if (edge == 0) return l;
  l.scale = static_cast<double>(kInputSize) / edge;
  l.resizedW = static_cast<std::uint32_t>(std::min<double>(kInputSize, js_round(width * l.scale)));
  l.resizedH = static_cast<std::uint32_t>(std::min<double>(kInputSize, js_round(height * l.scale)));
  return l;
}

std::vector<float> preprocess(std::span<const std::uint8_t> rgba, std::uint32_t width, std::uint32_t height) {
  constexpr std::size_t T = kInputSize;
  constexpr std::size_t plane = T * T;
  // Zero-filled: SAM's processor pads with 0 AFTER normalization.
  std::vector<float> out(3 * plane, 0.0F);
  if (width == 0 || height == 0 || rgba.size() < static_cast<std::size_t>(width) * height * 4) return out;
  const Letterbox l = letterbox(width, height);
  for (std::size_t y = 0; y < l.resizedH; ++y) {
    const auto sy = static_cast<std::size_t>(std::min<double>(height - 1, js_round(static_cast<double>(y) / l.scale)));
    for (std::size_t x = 0; x < l.resizedW; ++x) {
      const auto sx = static_cast<std::size_t>(std::min<double>(width - 1, js_round(static_cast<double>(x) / l.scale)));
      const std::size_t s = (sy * width + sx) * 4;
      const std::size_t d = y * T + x;
      for (std::size_t c = 0; c < 3; ++c) {
        out[c * plane + d] = static_cast<float>((rgba[s + c] / 255.0 - kMean[c]) / kStd[c]);
      }
    }
  }
  return out;
}

std::optional<Prompts> prompts_for(std::span<const Point> points, const std::optional<Box>& box, double scale) {
  Prompts p;
  for (const Point& pt : points) {
    p.coords.push_back(static_cast<float>(pt.x * scale));
    p.coords.push_back(static_cast<float>(pt.y * scale));
    p.labels.push_back(pt.label == 1 ? 1 : 0);
  }
  if (box && p.coords.empty()) {
    p.coords.push_back(static_cast<float>(((box->x0 + box->x1) / 2) * scale));
    p.coords.push_back(static_cast<float>(((box->y0 + box->y1) / 2) * scale));
    p.labels.push_back(1);
  }
  if (p.labels.empty()) return std::nullopt;
  return p;
}

std::size_t best_mask(std::span<const float> iouScores) noexcept {
  std::size_t best = 0;
  for (std::size_t i = 1; i < iouScores.size(); ++i) {
    if (iouScores[i] > iouScores[best]) best = i;
  }
  return best;
}

std::vector<std::uint8_t> upsample_mask(std::span<const float> logits, std::size_t offset, std::uint32_t width,
                                        std::uint32_t height, double scale) {
  constexpr std::size_t M = kMaskSize;
  std::vector<std::uint8_t> out(static_cast<std::size_t>(width) * height, 0);
  if (logits.size() < offset + M * M) return out;
  const double step = scale / (static_cast<double>(kInputSize) / M);
  constexpr double kMaxF = static_cast<double>(M) - 1.001;
  for (std::size_t y = 0; y < height; ++y) {
    const double fy = std::min(kMaxF, static_cast<double>(y) * step);
    const auto y0 = static_cast<std::size_t>(std::floor(fy));
    const double ty = fy - static_cast<double>(y0);
    for (std::size_t x = 0; x < width; ++x) {
      const double fx = std::min(kMaxF, static_cast<double>(x) * step);
      const auto x0 = static_cast<std::size_t>(std::floor(fx));
      const double tx = fx - static_cast<double>(x0);
      const double i00 = logits[offset + y0 * M + x0];
      const double i10 = logits[offset + y0 * M + x0 + 1];
      const double i01 = logits[offset + (y0 + 1) * M + x0];
      const double i11 = logits[offset + (y0 + 1) * M + x0 + 1];
      const double v = i00 * (1 - tx) * (1 - ty) + i10 * tx * (1 - ty) + i01 * (1 - tx) * ty + i11 * tx * ty;
      out[y * width + x] = v > 0 ? 255 : 0;
    }
  }
  return out;
}

void constrain_to_box(std::vector<std::uint8_t>& mask, std::uint32_t width, std::uint32_t height, const Box& box) {
  const double mx = std::abs(box.x1 - box.x0) * 0.08 + 4;
  const double my = std::abs(box.y1 - box.y0) * 0.08 + 4;
  const double x0 = std::min(box.x0, box.x1) - mx;
  const double x1 = std::max(box.x0, box.x1) + mx;
  const double y0 = std::min(box.y0, box.y1) - my;
  const double y1 = std::max(box.y0, box.y1) + my;
  if (mask.size() < static_cast<std::size_t>(width) * height) return;
  for (std::size_t y = 0; y < height; ++y) {
    for (std::size_t x = 0; x < width; ++x) {
      const auto fx = static_cast<double>(x);
      const auto fy = static_cast<double>(y);
      if (fx < x0 || fx > x1 || fy < y0 || fy > y1) mask[y * width + x] = 0;
    }
  }
}

std::vector<std::uint8_t> mask_from_decoder(std::span<const float> iouScores, std::span<const float> predMasks,
                                            std::uint32_t width, std::uint32_t height, const std::optional<Box>& box) {
  constexpr std::size_t plane = static_cast<std::size_t>(kMaskSize) * kMaskSize;
  if (iouScores.empty() || predMasks.size() < iouScores.size() * plane) return {};
  const std::size_t best = best_mask(iouScores);
  std::vector<std::uint8_t> mask = upsample_mask(predMasks, best * plane, width, height, letterbox(width, height).scale);
  if (box) constrain_to_box(mask, width, height, *box);
  return mask;
}

std::vector<trace::TracePoint> matte_contour(std::span<const std::uint8_t> mask, std::uint32_t width,
                                             std::uint32_t height, std::size_t maxPoints) {
  trace::TraceOptions opts;  // traceBitmap.ts defaults: 128, tolerance 1, min area 4
  const std::vector<trace::TracedContour> contours = trace::trace_bitmap(mask, width, height, 1, opts);
  const trace::TracedContour* best = nullptr;
  double bestArea = 0;
  for (const trace::TracedContour& c : contours) {
    if (c.hole) continue;
    const double a = std::abs(trace::signed_area(c.points));
    if (best == nullptr || a > bestArea) {
      best = &c;
      bestArea = a;
    }
  }
  if (best == nullptr) return {};
  const std::size_t n = best->points.size();
  const std::size_t cap = std::max<std::size_t>(3, maxPoints);
  const std::size_t stride = std::max<std::size_t>(1, (n + cap - 1) / cap);
  std::vector<trace::TracePoint> out;
  for (std::size_t i = 0; i < n; i += stride) out.push_back(best->points[i]);
  return out;
}

}  // namespace premation::jobs::sam
