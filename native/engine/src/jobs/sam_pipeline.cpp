#include "sam_pipeline.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <utility>
#include <vector>

namespace premation::jobs::sam {

namespace {

/// JavaScript Math.round for x ≥ 0 (ties up), without floor(x + 0.5)'s rounding slip.
double js_round(double x) noexcept {
  const double r = std::floor(x);
  return x - r >= 0.5 ? r + 1 : r;
}

/// The mask's largest 8-connected subject (>= 128) with its SMALL holes filled (each under
/// `holeShare` of the subject's area; the default 2 %), 0 / 255: the one region whose outer
/// contour matte_contour wants. Tracing the raw matte of a cluttered frame (thousands of
/// specks and holes) took minutes at 2560×1440; this pass is linear. A large hole — the gap
/// between an arm and the body, the inside of a handle — is part of the shape and stays.
std::vector<std::uint8_t> largest_filled(std::span<const std::uint8_t> mask, std::uint32_t width, std::uint32_t height, double holeShare) {
  const std::size_t w = width;
  const std::size_t h = height;
  const std::size_t n = w * h;
  std::vector<std::uint32_t> label(n, 0);
  std::vector<std::size_t> stack;
  std::uint32_t next = 0;
  std::uint32_t best = 0;
  std::size_t bestCount = 0;
  for (std::size_t s = 0; s < n; ++s) {
    if (mask[s] < 128 || label[s] != 0) continue;
    const std::uint32_t id = ++next;
    std::size_t count = 0;
    label[s] = id;
    stack.push_back(s);
    while (!stack.empty()) {
      const std::size_t i = stack.back();
      stack.pop_back();
      ++count;
      const std::size_t x = i % w;
      const std::size_t y = i / w;
      for (int dy = -1; dy <= 1; ++dy) {
        for (int dx = -1; dx <= 1; ++dx) {
          if ((dx == 0 && dy == 0) || (dx < 0 && x == 0) || (dy < 0 && y == 0) || (dx > 0 && x + 1 >= w) || (dy > 0 && y + 1 >= h)) continue;
          const std::size_t j = (y + static_cast<std::size_t>(static_cast<std::ptrdiff_t>(dy) + 1) - 1) * w +
                                (x + static_cast<std::size_t>(static_cast<std::ptrdiff_t>(dx) + 1) - 1);
          if (mask[j] < 128 || label[j] != 0) continue;
          label[j] = id;
          stack.push_back(j);
        }
      }
    }
    if (count > bestCount) {
      bestCount = count;
      best = id;
    }
  }
  std::vector<std::uint8_t> out(n, 0);
  if (best == 0) return out;
  // Holes: everything not the subject that the border cannot reach (4-connected) is inside it.
  std::vector<std::uint8_t> outside(n, 0);
  auto seed = [&](std::size_t i) {
    if (label[i] == best || outside[i] != 0) return;
    outside[i] = 1;
    stack.push_back(i);
  };
  for (std::size_t x = 0; x < w; ++x) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (std::size_t y = 0; y < h; ++y) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (!stack.empty()) {
    const std::size_t i = stack.back();
    stack.pop_back();
    const std::size_t x = i % w;
    const std::size_t y = i / w;
    if (x > 0) seed(i - 1);
    if (x + 1 < w) seed(i + 1);
    if (y > 0) seed(i - w);
    if (y + 1 < h) seed(i + w);
  }
  // Holes (not the subject, not reachable from the border): each 4-connected one is measured;
  // a small one is filled, a large one is kept open (its pixels count as outside).
  const auto maxHole = static_cast<std::size_t>(std::max(0.0, holeShare) * static_cast<double>(bestCount));
  std::vector<std::size_t> hole;
  for (std::size_t s = 0; s < n; ++s) {
    if (label[s] == best || outside[s] != 0) continue;
    hole.clear();
    outside[s] = 2;  // 2 = a hole under measurement
    stack.push_back(s);
    while (!stack.empty()) {
      const std::size_t i = stack.back();
      stack.pop_back();
      hole.push_back(i);
      const std::size_t x = i % w;
      const std::size_t y = i / w;
      const auto grow = [&](std::size_t j) {
        if (label[j] == best || outside[j] != 0) return;
        outside[j] = 2;
        stack.push_back(j);
      };
      if (x > 0) grow(i - 1);
      if (x + 1 < w) grow(i + 1);
      if (y > 0) grow(i - w);
      if (y + 1 < h) grow(i + w);
    }
    const std::uint8_t mark = hole.size() <= maxHole ? 3 : 1;  // 3 = filled, 1 = open (outside)
    for (const std::size_t i : hole) outside[i] = mark;
  }
  for (std::size_t i = 0; i < n; ++i) out[i] = outside[i] == 1 ? 0 : 255;
  return out;
}

}  // namespace

std::vector<std::uint8_t> subject_region(std::span<const std::uint8_t> mask, std::uint32_t width, std::uint32_t height, double holeShare) {
  if (mask.size() < std::size_t{width} * height || width == 0 || height == 0) return {};
  return largest_filled(mask, width, height, holeShare);
}

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
  if (l.scale >= 1.0) {
    // A frame no larger than the input: nearest, as samPipeline.ts did.
    for (std::size_t y = 0; y < l.resizedH; ++y) {
      const auto sy = static_cast<std::size_t>(std::min<double>(height - 1, js_round(static_cast<double>(y) / l.scale)));
      for (std::size_t x = 0; x < l.resizedW; ++x) {
        const auto sx = static_cast<std::size_t>(std::min<double>(width - 1, js_round(static_cast<double>(x) / l.scale)));
        const std::size_t s = (sy * width + sx) * 4;
        const std::size_t d = y * T + x;
        for (std::size_t c = 0; c < 3; ++c) out[c * plane + d] = static_cast<float>((rgba[s + c] / 255.0 - kMean[c]) / kStd[c]);
      }
    }
    return out;
  }
  // A frame larger than the input (every camera frame): an AREA filter — each input pixel is the
  // mean of the source pixels it covers. Nearest sampling dropped most of a 1080p frame's pixels,
  // and the edge the model saw was wherever the kept pixel fell, a cell or two off the true one;
  // the mean keeps hair and thin edges as the soft mix they are.
  const auto span_of = [](std::size_t i, std::size_t count, double scale, std::uint32_t limit) {
    const auto a = static_cast<std::size_t>(std::min<double>(limit - 1, std::floor(static_cast<double>(i) / scale)));
    auto b = static_cast<std::size_t>(std::min<double>(limit, std::floor(static_cast<double>(i + 1) / scale)));
    if (i + 1 == count) b = limit;  // the last input pixel takes the rest
    if (b <= a) b = a + 1;
    return std::pair<std::size_t, std::size_t>{a, b};
  };
  std::vector<std::pair<std::size_t, std::size_t>> xs(l.resizedW);
  for (std::size_t x = 0; x < l.resizedW; ++x) xs[x] = span_of(x, l.resizedW, l.scale, width);
  std::array<double, 3> sum{};
  for (std::size_t y = 0; y < l.resizedH; ++y) {
    const auto [sy0, sy1] = span_of(y, l.resizedH, l.scale, height);
    for (std::size_t x = 0; x < l.resizedW; ++x) {
      const auto [sx0, sx1] = xs[x];
      sum = {0.0, 0.0, 0.0};
      for (std::size_t sy = sy0; sy < sy1; ++sy) {
        const std::uint8_t* row = rgba.data() + (sy * width + sx0) * 4;
        for (std::size_t sx = sx0; sx < sx1; ++sx, row += 4) {
          sum[0] += row[0];
          sum[1] += row[1];
          sum[2] += row[2];
        }
      }
      const double n = static_cast<double>((sy1 - sy0) * (sx1 - sx0));
      const std::size_t d = y * T + x;
      for (std::size_t c = 0; c < 3; ++c) out[c * plane + d] = static_cast<float>((sum[c] / n / 255.0 - kMean[c]) / kStd[c]);
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
  if (mask.size() < std::size_t{width} * height) return {};
  const std::vector<std::uint8_t> subject = largest_filled(mask, width, height, kSmallHoleShare);
  const std::vector<trace::TracedContour> contours = trace::trace_bitmap(subject, width, height, 1, opts);
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
