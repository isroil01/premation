#include "content_aware.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

#include "pixel_motion.hpp"
#include "stabilize.hpp"

namespace premation::jobs::caf {

namespace {

std::uint32_t imul(std::uint32_t a, std::uint32_t b) noexcept { return a * b; }

/// contentAwareFill.ts `rand`: the mulberry-style uint32 step, then / 2^32.
class Rng {
 public:
  explicit Rng(std::uint32_t seed) noexcept : state_(seed) {}
  [[nodiscard]] double next() noexcept {
    state_ += 0x6d2b79f5u;
    std::uint32_t t = state_;
    t = imul(t ^ (t >> 15), t | 1u);
    t ^= t + imul(t ^ (t >> 7), t | 61u);
    t ^= t >> 14;
    return static_cast<double>(t) / 4294967296.0;
  }

 private:
  std::uint32_t state_;
};

/// `(n | 0)` for a finite value that fits in int32: truncate toward zero.
int trunc0(double n) noexcept { return static_cast<int>(std::trunc(n)); }

}  // namespace

int inpaint_patch_match(std::span<std::uint8_t> rgba, int width, int height, std::span<const std::uint8_t> hole,
                        const InpaintOptions& opts) {
  if (width <= 0 || height <= 0) return 0;
  const int n = width * height;
  if (static_cast<int>(rgba.size()) < n * 4 || static_cast<int>(hole.size()) < n) return 0;
  const int half = opts.patchHalf;
  const int iters = opts.iterations;
  std::vector<int> nnx(static_cast<std::size_t>(n), 0);
  std::vector<int> nny(static_cast<std::size_t>(n), 0);
  std::vector<int> known;
  std::vector<int> holes;
  known.reserve(static_cast<std::size_t>(n));
  holes.reserve(static_cast<std::size_t>(n));
  for (int i = 0; i < n; ++i) {
    if (hole[static_cast<std::size_t>(i)] != 0) holes.push_back(i);
    else known.push_back(i);
  }
  if (holes.empty() || known.empty()) return 0;

  // `(holes.length * 2654435761) >>> 0` — ToUint32, not a truncating cast.
  double prod = static_cast<double>(holes.size()) * 2654435761.0;
  prod = std::fmod(prod, 4294967296.0);
  if (prod < 0) prod += 4294967296.0;
  const std::uint32_t seed = opts.seed.value_or(static_cast<std::uint32_t>(prod));
  Rng rng(seed);
  auto rand_known = [&]() {
    const int k = trunc0(rng.next() * static_cast<double>(known.size()));
    return known[static_cast<std::size_t>(std::clamp(k, 0, static_cast<int>(known.size()) - 1))];
  };
  for (const int i : holes) {
    const int k = rand_known();
    nnx[static_cast<std::size_t>(i)] = k % width;
    nny[static_cast<std::size_t>(i)] = k / width;
  }

  auto patch_dist = [&](int tx, int ty, int sx, int sy) {
    double sum = 0;
    int c = 0;
    for (int dy = -half; dy <= half; ++dy) {
      for (int dx = -half; dx <= half; ++dx) {
        const int ax = tx + dx;
        const int ay = ty + dy;
        const int bx = sx + dx;
        const int by = sy + dy;
        if (ax < 0 || ay < 0 || ax >= width || ay >= height) continue;
        if (bx < 0 || by < 0 || bx >= width || by >= height) continue;
        const int ai = ay * width + ax;
        const int bi = by * width + bx;
        if (hole[static_cast<std::size_t>(ai)] != 0 && hole[static_cast<std::size_t>(bi)] != 0) continue;
        const int ap = ai * 4;
        const int bp = bi * 4;
        const int dr = static_cast<int>(rgba[static_cast<std::size_t>(ap)]) - static_cast<int>(rgba[static_cast<std::size_t>(bp)]);
        const int dg = static_cast<int>(rgba[static_cast<std::size_t>(ap + 1)]) - static_cast<int>(rgba[static_cast<std::size_t>(bp + 1)]);
        const int db = static_cast<int>(rgba[static_cast<std::size_t>(ap + 2)]) - static_cast<int>(rgba[static_cast<std::size_t>(bp + 2)]);
        sum += static_cast<double>(dr * dr + dg * dg + db * db);
        ++c;
      }
    }
    return c > 0 ? sum / static_cast<double>(c) : 1e12;
  };

  for (int it = 0; it < iters; ++it) {
    const bool forward = it % 2 == 0;
    std::vector<int> order = holes;
    if (!forward) std::reverse(order.begin(), order.end());
    for (const int i : order) {
      const int tx = i % width;
      const int ty = i / width;
      int bestX = nnx[static_cast<std::size_t>(i)];
      int bestY = nny[static_cast<std::size_t>(i)];
      double bestD = patch_dist(tx, ty, bestX, bestY);
      const int nx0 = forward ? tx - 1 : tx + 1;
      const int ny0 = ty;
      const int nx1 = tx;
      const int ny1 = forward ? ty - 1 : ty + 1;
      const int nbrs[2][2] = {{nx0, ny0}, {nx1, ny1}};
      for (const auto& nb : nbrs) {
        const int nx = nb[0];
        const int ny = nb[1];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const int ni = ny * width + nx;
        if (hole[static_cast<std::size_t>(ni)] == 0) continue;
        const int candX = nnx[static_cast<std::size_t>(ni)] + (tx - nx);
        const int candY = nny[static_cast<std::size_t>(ni)] + (ty - ny);
        if (candX < half || candY < half || candX >= width - half || candY >= height - half) continue;
        if (hole[static_cast<std::size_t>(candY * width + candX)] != 0) continue;
        const double d = patch_dist(tx, ty, candX, candY);
        if (d < bestD) {
          bestD = d;
          bestX = candX;
          bestY = candY;
        }
      }
      int radius = std::max(width, height);
      while (radius >= 1) {
        const int rx = bestX + trunc0((rng.next() * 2.0 - 1.0) * static_cast<double>(radius));
        const int ry = bestY + trunc0((rng.next() * 2.0 - 1.0) * static_cast<double>(radius));
        if (rx >= half && ry >= half && rx < width - half && ry < height - half &&
            hole[static_cast<std::size_t>(ry * width + rx)] == 0) {
          const double d = patch_dist(tx, ty, rx, ry);
          if (d < bestD) {
            bestD = d;
            bestX = rx;
            bestY = ry;
          }
        }
        radius /= 2;
      }
      nnx[static_cast<std::size_t>(i)] = bestX;
      nny[static_cast<std::size_t>(i)] = bestY;
    }
  }

  for (const int i : holes) {
    const int sx = nnx[static_cast<std::size_t>(i)];
    const int sy = nny[static_cast<std::size_t>(i)];
    const int sp = (sy * width + sx) * 4;
    const int dp = i * 4;
    rgba[static_cast<std::size_t>(dp)] = rgba[static_cast<std::size_t>(sp)];
    rgba[static_cast<std::size_t>(dp + 1)] = rgba[static_cast<std::size_t>(sp + 1)];
    rgba[static_cast<std::size_t>(dp + 2)] = rgba[static_cast<std::size_t>(sp + 2)];
    rgba[static_cast<std::size_t>(dp + 3)] = 255;
  }
  return static_cast<int>(holes.size());
}

int propagate_fill_frame(std::span<const std::uint8_t> prev, std::span<std::uint8_t> next, int width, int height,
                         std::span<std::uint8_t> hole, const InpaintOptions& opts) {
  if (width <= 0 || height <= 0) return 0;
  const int n = width * height;
  if (static_cast<int>(prev.size()) < n * 4 || static_cast<int>(next.size()) < n * 4 || static_cast<int>(hole.size()) < n) return 0;
  const stabilize::FloatLuma prevL = stabilize::luma_255_of(prev, width, height);
  const stabilize::FloatLuma nextL = stabilize::luma_255_of(next, width, height);
  scene::pixmo::FlowOptions flowOpts;
  flowOpts.step = 4;
  const scene::pixmo::FlowField flow = stabilize::compute_flow_f32(prevL, nextL, flowOpts);
  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      const int i = y * width + x;
      if (hole[static_cast<std::size_t>(i)] == 0) continue;
      const stabilize::XY d = stabilize::sample_flow(flow, x, y);
      const double sx = static_cast<double>(x) - d.x;
      const double sy = static_cast<double>(y) - d.y;
      if (sx < 0 || sy < 0 || sx >= static_cast<double>(width - 1) || sy >= static_cast<double>(height - 1)) continue;
      const int x0 = trunc0(sx);
      const int y0 = trunc0(sy);
      const double fx = sx - static_cast<double>(x0);
      const double fy = sy - static_cast<double>(y0);
      auto sample = [&](int xx, int yy, int ch) {
        return static_cast<double>(prev[static_cast<std::size_t>((yy * width + xx) * 4 + ch)]);
      };
      const int dp = i * 4;
      for (int ch = 0; ch < 3; ++ch) {
        const double v = sample(x0, y0, ch) * (1 - fx) * (1 - fy) + sample(x0 + 1, y0, ch) * fx * (1 - fy) +
                         sample(x0, y0 + 1, ch) * (1 - fx) * fy + sample(x0 + 1, y0 + 1, ch) * fx * fy;
        next[static_cast<std::size_t>(dp + ch)] = scene::pixmo::to_uint8_clamp(v);
      }
      next[static_cast<std::size_t>(dp + 3)] = 255;
      hole[static_cast<std::size_t>(i)] = 0;
    }
  }
  std::vector<std::uint8_t> residual(static_cast<std::size_t>(n), 0);
  for (int i = 0; i < n; ++i) residual[static_cast<std::size_t>(i)] = hole[static_cast<std::size_t>(i)] != 0 ? 255 : 0;
  return inpaint_patch_match(next, width, height, residual, opts);
}

namespace {

bool point_in_poly(double x, double y, const Poly& poly) {
  bool inside = false;
  const std::size_t n = poly.points.size();
  if (n < 3) return false;
  for (std::size_t i = 0, j = n - 1; i < n; j = i++) {
    const double xi = poly.points[i].first;
    const double yi = poly.points[i].second;
    const double xj = poly.points[j].first;
    const double yj = poly.points[j].second;
    if ((yi > y) != (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

}  // namespace

void raster_hole(std::span<std::uint8_t> hole, int width, int height, std::span<const Poly> polys) {
  if (width <= 0 || height <= 0) return;
  const int n = width * height;
  if (static_cast<int>(hole.size()) < n) return;
  std::fill(hole.begin(), hole.begin() + n, static_cast<std::uint8_t>(0));
  for (const Poly& poly : polys) {
    if (poly.points.size() < 3) continue;
    for (int y = 0; y < height; ++y) {
      for (int x = 0; x < width; ++x) {
        if (point_in_poly(static_cast<double>(x) + 0.5, static_cast<double>(y) + 0.5, poly)) {
          hole[static_cast<std::size_t>(y * width + x)] = 255;
        }
      }
    }
  }
}

int propagate_fill_bidirectional(std::vector<std::vector<std::uint8_t>>& frames, int width, int height,
                                 std::vector<std::vector<std::uint8_t>>& holes, const InpaintOptions& opts) {
  if (frames.empty() || frames.size() != holes.size()) return 0;
  int filled = 0;
  for (std::size_t i = 0; i < frames.size(); ++i) {
    if (i == 0) {
      filled += inpaint_patch_match(frames[0], width, height, holes[0], opts);
    } else {
      filled += propagate_fill_frame(frames[i - 1], frames[i], width, height, holes[i], opts);
    }
  }
  for (int i = static_cast<int>(frames.size()) - 2; i >= 0; --i) {
    const auto ui = static_cast<std::size_t>(i);
    const bool any = std::any_of(holes[ui].begin(), holes[ui].end(), [](std::uint8_t v) { return v != 0; });
    if (!any) continue;
    std::vector<std::uint8_t> residual = holes[ui];
    filled += propagate_fill_frame(frames[ui + 1], frames[ui], width, height, residual, opts);
  }
  return filled;
}

}  // namespace premation::jobs::caf
