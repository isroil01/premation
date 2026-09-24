// Port of src/core/effects/aeDistortRoundFive.ts — Flo Motion, Lens,
// Griddler, Ball Action, Drizzle.
#include <algorithm>
#include <array>
#include <optional>
#include <vector>

#include "kernels.hpp"
#include "noise_hash.hpp"
#include "remap.hpp"

namespace premation::effects {

namespace {

constexpr double kPi = 3.141592653589793;

double hypot2(double a, double b) {
  const std::array<double, 2> v{a, b};
  return js::hypot(v);
}

}  // namespace

void flo_motion(RgbaView img, double k1x, double k1y, double k1a, double k2x, double k2y, double k2a, double falloff,
                ThreadPool* pool) {
  const double w = img.w;
  const double h = img.h;
  struct Knot {
    double x, y, a;
  };
  const std::array<Knot, 2> knots{Knot{w / 2 + k1x, h / 2 + k1y, k1a / 100}, Knot{w / 2 + k2x, h / 2 + k2y, k2a / 100}};
  const double sigma = std::max(4.0, (falloff / 100) * std::min(w, h));
  const double two_sigma2 = 2 * sigma * sigma;
  const double reach = sigma * 1.2;
  remap_rgba(img, pool, [&](double dx, double dy) -> std::optional<RemapPt> {
    double ox = 0;
    double oy = 0;
    for (const Knot& k : knots) {
      if (k.a == 0) continue;
      const double vx = dx - k.x;
      const double vy = dy - k.y;
      const double d2 = vx * vx + vy * vy;
      const double g = js::exp(-d2 / two_sigma2);
      ox -= vx * k.a * g * (reach / sigma);
      oy -= vy * k.a * g * (reach / sigma);
    }
    return RemapPt{dx + ox, dy + oy};
  });
}

void lens(RgbaView img, double center_x, double center_y, double size, double convergence, ThreadPool* pool) {
  const double w = img.w;
  const double h = img.h;
  const double cx = w / 2 + center_x;
  const double cy = h / 2 + center_y;
  const double ball_r = std::max(4.0, (size / 100) * (std::min(w, h) / 2));
  const double conv = clamp01(convergence / 100);
  const double half_diag = hypot2(w, h) / 2;
  const double pull = ball_r + (half_diag - ball_r) * conv;
  remap_rgba(img, pool, [&](double dx, double dy) -> std::optional<RemapPt> {
    const double vx = dx - cx;
    const double vy = dy - cy;
    const double r = hypot2(vx, vy);
    if (r > ball_r) return std::nullopt;
    const double rn = r / ball_r;
    const double src_r = pull * (js::asin(std::min(1.0, rn)) / (kPi / 2));
    if (r < 1e-6) return RemapPt{w / 2, h / 2};
    const double s = src_r / r;
    return RemapPt{w / 2 + vx * s, h / 2 + vy * s};
  });
}

void griddler(RgbaView img, double tile_size, double horizontal_scale, double vertical_scale, double rotation,
              ThreadPool* pool) {
  const double tile = std::max(4.0, tile_size);
  const double sx = std::max(0.01, horizontal_scale / 100);
  const double sy = std::max(0.01, vertical_scale / 100);
  const double rot = (rotation * kPi) / 180;
  const double cos_r = js::cos(rot);
  const double sin_r = js::sin(rot);
  remap_rgba(img, pool, [&](double dx, double dy) -> std::optional<RemapPt> {
    const double ccx = (std::floor(dx / tile) + 0.5) * tile;
    const double ccy = (std::floor(dy / tile) + 0.5) * tile;
    const double lx = dx - ccx;
    const double ly = dy - ccy;
    const double ux = (lx * cos_r + ly * sin_r) / sx;
    const double uy = (-lx * sin_r + ly * cos_r) / sy;
    if (std::fabs(ux) > tile / 2 || std::fabs(uy) > tile / 2) return std::nullopt;
    return RemapPt{ccx + ux, ccy + uy};
  });
}

void ball_action(RgbaView img, double grid, double ball_size, double scatter_amt, double seed, ThreadPool* pool) {
  // Balls may overlap, and a later cell (scan order cy, cx) overwrites an
  // earlier one. Threads split OUTPUT rows; each walks every cell in that same
  // order, clipped to its rows, so the last writer is the TS's last writer.
  const int w = img.w;
  const int h = img.h;
  const double g = std::max(4.0, grid);
  const double R = (g / 2) * clamp01(ball_size / 100);
  const double jit = (scatter_amt / 100) * g * 0.5;
  const double s = std::floor(seed);
  const int cols = static_cast<int>(std::ceil(w / g));
  const int rows = static_cast<int>(std::ceil(h / g));
  struct Ball {
    double bx, by, ccx, ccy;
    int x0, x1, y0, y1;
  };
  std::vector<Ball> balls;
  balls.reserve(static_cast<std::size_t>(cols) * static_cast<std::size_t>(rows));
  for (int cy = 0; cy < rows; ++cy) {
    for (int cx = 0; cx < cols; ++cx) {
      const double bx = (cx + 0.5) * g + (hash2(cx * 7919.0 + cy, s) - 0.5) * 2 * jit;
      const double by = (cy + 0.5) * g + (hash2(cx * 7919.0 + cy, s + 77) - 0.5) * 2 * jit;
      balls.push_back(Ball{bx, by, (cx + 0.5) * g, (cy + 0.5) * g,
                           static_cast<int>(std::max(0.0, std::floor(bx - R))),
                           static_cast<int>(std::min(static_cast<double>(w - 1), std::ceil(bx + R))),
                           static_cast<int>(std::max(0.0, std::floor(by - R))),
                           static_cast<int>(std::min(static_cast<double>(h - 1), std::ceil(by + R)))});
    }
  }
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::fill(img.data.begin(), img.data.end(), std::uint8_t{0});
  std::uint8_t* out = img.data.data();
  const double scale = g / (2 * R);
  for_rows(pool, h, [&](int ya, int yb) {
    for (const Ball& b : balls) {
      const int y0 = std::max(b.y0, ya);
      const int y1 = std::min(b.y1, yb - 1);
      for (int y = y0; y <= y1; ++y) {
        for (int x = b.x0; x <= b.x1; ++x) {
          const double dx = x + 0.5 - b.bx;
          const double dy = y + 0.5 - b.by;
          const double d = hypot2(dx, dy);
          if (d > R) continue;
          const double dn = d / R;
          const double lift = dn > 1e-6 ? (js::asin(std::min(1.0, dn)) / (kPi / 2)) / dn : 1;
          const double sxp = std::min(static_cast<double>(w - 1), std::max(0.0, round_index(b.ccx + dx * lift * scale)));
          const double syp = std::min(static_cast<double>(h - 1), std::max(0.0, round_index(b.ccy + dy * lift * scale)));
          const std::uint8_t* sp = src.data() + idx4(static_cast<int>(sxp), static_cast<int>(syp), w);
          if (sp[3] == 0) continue;
          const double nz = std::sqrt(std::max(0.0, 1 - dn * dn));
          const double light = clamp01(0.35 + 0.65 * ((-dx / R) * 0.5 + (-dy / R) * 0.5 + nz * 0.7));
          std::uint8_t* o = out + idx4(x, y, w);
          o[0] = u8c(clamp255(sp[0] * light));
          o[1] = u8c(clamp255(sp[1] * light));
          o[2] = u8c(clamp255(sp[2] * light));
          o[3] = sp[3];
        }
      }
    }
  });
}

void drizzle(RgbaView img, double drip_rate, double ripple_height, double spreading, double evolution, double seed,
             ThreadPool* pool) {
  const int n = static_cast<int>(js::round(clamp01(drip_rate / 100) * 30));
  if (n == 0 || ripple_height <= 0) return;
  const double w = img.w;
  const double h = img.h;
  const double s = std::floor(seed);
  const double spread = std::max(8.0, spreading);
  struct Drop {
    double x, y, ring_r, amp;
  };
  std::vector<Drop> drops;
  for (int i = 0; i < n; ++i) {
    const double v = evolution / 200 + hash2(i, s + 303);
    const double cycle = v - std::floor(v);
    drops.push_back(Drop{hash2(i, s) * w, hash2(i, s + 11) * h, cycle * spread, ripple_height * (1 - cycle)});
  }
  const double band_w = std::max(3.0, spread * 0.08);
  const double freq = kPi / (band_w * 0.6);
  remap_rgba(img, pool, [&](double dx, double dy) -> std::optional<RemapPt> {
    double ox = 0;
    double oy = 0;
    for (const Drop& d : drops) {
      const double vx = dx - d.x;
      const double vy = dy - d.y;
      const double r = hypot2(vx, vy);
      const double off = r - d.ring_r;
      if (std::fabs(off) > band_w * 2.5 || r < 1e-3) continue;
      const double env = js::exp(-(off * off) / (2 * band_w * band_w));
      const double wave = js::sin(off * freq) * d.amp * env;
      ox += (vx / r) * wave;
      oy += (vy / r) * wave;
    }
    if (ox == 0 && oy == 0) return RemapPt{dx, dy};
    return RemapPt{dx + ox, dy + oy};
  });
}

}  // namespace premation::effects
