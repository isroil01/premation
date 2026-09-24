// Port of src/core/effects/aeTransitionsAdvanced.ts — Iris Wipe, Light Wipe,
// Line Sweep, Grid Wipe, Dust & Scratches, Noise Alpha.
#include <algorithm>
#include <array>
#include <vector>

#include "color_space.hpp"
#include "kernels.hpp"
#include "noise_hash.hpp"
#include "rank_hist.hpp"

namespace premation::effects {

namespace {

constexpr double kPi = 3.141592653589793;

double hypot2(double a, double b) { return jhypot2(a, b); }

}  // namespace

void iris_wipe(RgbaView img, double completion, double center_x, double center_y, double points, double rotation,
               double inner_radius, bool use_inner_radius, double feather, bool invert, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  const double t = clamp01(completion / 100);
  const double cx = w / 2.0 + center_x;
  const double cy = h / 2.0 + center_y;
  double max_r = hypot2(std::max(cx, w - cx), std::max(cy, h - cy));
  if (max_r == 0 || std::isnan(max_r)) max_r = 1;
  const double outer = t * max_r;
  const double inner = use_inner_radius ? std::min(outer, inner_radius) : 0;
  const double n = js::round(points);
  const double rot = (rotation * kPi) / 180;
  const double feath = std::max(1e-3, feather);
  const double seg = (kPi * 2) / n;
  const double apothem = n >= 3 ? js::cos(kPi / n) : 1;
  std::uint8_t* data = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        std::uint8_t* p = data + idx4(x, y, w);
        const double a = p[3];
        if (a == 0) continue;
        const double ox = x + 0.5 - cx;
        const double oy = y + 0.5 - cy;
        double d = hypot2(ox, oy);
        if (n >= 3) {
          const double ang = js::atan2(oy, ox) - rot;
          const double local = ang - seg * std::floor(ang / seg + 0.5);
          d = (d * js::cos(local)) / apothem;
        }
        double cover = smoothstep(outer - feath, outer + feath, d);
        if (use_inner_radius && inner > 0) cover = std::max(cover, 1 - smoothstep(inner - feath, inner + feath, d));
        if (invert) cover = 1 - cover;
        p[3] = u8c(a * clamp01(cover));
      }
    }
  });
}

void light_wipe(RgbaView img, double completion, double shape, double angle, double center_x, double center_y,
                double width, const Rgb& color, double intensity, double feather, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  const double t = clamp01(completion / 100);
  const bool radial = js::round(shape) == 1;
  const double cx = w / 2.0 + center_x;
  const double cy = h / 2.0 + center_y;
  const double a = (angle * kPi) / 180;
  const double nx = js::cos(a);
  const double ny = js::sin(a);
  double span = 0;
  if (radial) {
    span = hypot2(std::max(cx, w - cx), std::max(cy, h - cy));
    if (span == 0 || std::isnan(span)) span = 1;
  } else {
    span = std::fabs(w * nx) + std::fabs(h * ny);
  }
  const double front = t * (span + width);
  const double band = std::max(1e-3, width);
  const double glow = clamp01(intensity / 100);
  const double feath = std::max(1e-3, feather);
  const std::array<double, 3> col{color.r, color.g, color.b};
  std::uint8_t* data = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        std::uint8_t* p = data + idx4(x, y, w);
        const double al = p[3];
        if (al == 0) continue;
        const double d = radial ? hypot2(x + 0.5 - cx, y + 0.5 - cy)
                                : (x + 0.5 - (w / 2.0 - (nx * span) / 2)) * nx +
                                      (y + 0.5 - (h / 2.0 - (ny * span) / 2)) * ny;
        const double cover = smoothstep(front - feath, front + feath, d);
        p[3] = u8c(al * clamp01(cover));
        if (glow > 0 && cover > 0) {
          const double ahead = d - front;
          if (ahead >= 0 && ahead <= band) {
            const double k = (1 - ahead / band) * glow;
            for (std::size_t c = 0; c < 3; ++c) p[c] = u8c(p[c] + (col[c] - p[c]) * k);
          }
        }
      }
    }
  });
}

void line_sweep(RgbaView img, double completion, double line_count, double angle, double stagger, double feather,
                bool invert, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  const double t = clamp01(completion / 100);
  const double n = std::max(1.0, std::min(512.0, js::round(line_count)));
  const double a = (angle * kPi) / 180;
  const double nx = js::cos(a);
  const double ny = js::sin(a);
  const double stag = clamp01(stagger / 100);
  const double feath = std::max(1e-3, feather / 100);
  const double across_div = std::max(1.0, std::fabs(w * ny) + std::fabs(h * nx));
  const double along_div = std::max(1.0, std::fabs(w * nx) + std::fabs(h * ny));
  std::uint8_t* data = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        std::uint8_t* p = data + idx4(x, y, w);
        const double al = p[3];
        if (al == 0) continue;
        const double across = ((x + 0.5) * -ny + (y + 0.5) * nx) / across_div;
        const double along = ((x + 0.5) * nx + (y + 0.5) * ny) / along_div;
        const double line = std::floor(clamp01(across) * n);
        const double start = (line / std::max(1.0, n)) * stag;
        const double local_t = clamp01((t - start) / std::max(1e-6, 1 - stag));
        double cover = smoothstep(local_t - feath, local_t + feath, clamp01(along));
        if (invert) cover = 1 - cover;
        p[3] = u8c(al * clamp01(cover));
      }
    }
  });
}

void grid_wipe(RgbaView img, double completion, double columns, double rows, double shape, double random,
               double feather, bool invert, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  const double t = clamp01(completion / 100);
  const int cols = static_cast<int>(std::max(1.0, std::min(256.0, js::round(columns))));
  const int rws = static_cast<int>(std::max(1.0, std::min(256.0, js::round(rows))));
  const double sh = js::round(shape);
  const double rnd = clamp01(random / 100);
  const double feath = std::max(1e-3, feather / 100);
  const double cw = static_cast<double>(w) / cols;
  const double chh = static_cast<double>(h) / rws;
  std::uint8_t* data = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        std::uint8_t* p = data + idx4(x, y, w);
        const double al = p[3];
        if (al == 0) continue;
        const double ci = std::min(static_cast<double>(cols - 1), std::floor(x / cw));
        const double ri = std::min(static_cast<double>(rws - 1), std::floor(y / chh));
        const double start = hash2(ci, ri) * rnd;
        const double local_t = clamp01((t - start) / std::max(1e-6, 1 - rnd));
        const double u = ((x + 0.5) - (ci * cw + cw / 2)) / (cw / 2);
        const double v = ((y + 0.5) - (ri * chh + chh / 2)) / (chh / 2);
        const double d = sh == 1   ? std::fabs(u) + std::fabs(v)
                         : sh == 2 ? hypot2(u, v)
                                   : std::max(std::fabs(u), std::fabs(v));
        const double r = local_t * 1.4143;
        double cover = smoothstep(r - feath, r + feath, d);
        if (invert) cover = 1 - cover;
        p[3] = u8c(al * clamp01(cover));
      }
    }
  });
}

void dust_and_scratches(RgbaView img, double radius, double threshold, ThreadPool* pool) {
  // The TS sorts a clamped CIRCULAR window per pixel per channel; the disc is
  // slid one column at a time instead (each disc row drops its left sample and
  // gains its right one), and the running median gives the same element.
  const int w = img.w;
  const int h = img.h;
  const int r = static_cast<int>(std::max(1.0, std::min(8.0, js::round(radius))));
  const double thr = std::max(0.0, threshold);
  std::array<int, 17> half{};  // disc half-width per dy (+r offset)
  int count = 0;
  for (int dy = -r; dy <= r; ++dy) {
    int hw = 0;
    while ((hw + 1) * (hw + 1) + dy * dy <= r * r) ++hw;
    half[static_cast<std::size_t>(dy + r)] = hw;
    count += 2 * hw + 1;
  }
  const int k = count >> 1;
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      std::array<RankHist, 3> hist{};
      const auto sample = [&](int sx, int dy) -> const std::uint8_t* {
        return src.data() + idx4(clampi(sx, 0, w - 1), clampi(y + dy, 0, h - 1), w);
      };
      for (int dy = -r; dy <= r; ++dy) {
        const int hw = half[static_cast<std::size_t>(dy + r)];
        for (int dx = -hw; dx <= hw; ++dx) {
          const std::uint8_t* s = sample(dx, dy);
          for (std::size_t c = 0; c < 3; ++c) hist[c].add(s[c]);
        }
      }
      for (int x = 0; x < w; ++x) {
        if (x > 0) {
          for (int dy = -r; dy <= r; ++dy) {
            const int hw = half[static_cast<std::size_t>(dy + r)];
            const std::uint8_t* gone = sample(x - 1 - hw, dy);
            const std::uint8_t* come = sample(x + hw, dy);
            for (std::size_t c = 0; c < 3; ++c) {
              hist[c].remove(gone[c]);
              hist[c].add(come[c]);
            }
          }
        }
        const std::size_t o = idx4(x, y, w);
        if (src[o + 3] == 0) continue;
        for (std::size_t c = 0; c < 3; ++c) {
          const int med = hist[c].kth(k);
          out[o + c] = std::fabs(static_cast<double>(src[o + c] - med)) > thr ? static_cast<std::uint8_t>(med) : src[o + c];
        }
      }
    }
  });
}

void noise_alpha(RgbaView img, double amount, bool uniform, double seed, double phase, bool clip_result,
                 ThreadPool* pool) {
  const double amt = clamp01(amount / 100);
  if (amt <= 0) return;
  const double sd = js::round(seed);
  const double ph = js::round(phase);
  const int w = img.w;
  std::uint8_t* data = img.data.data();
  for_rows(pool, img.h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        std::uint8_t* p = data + idx4(x, y, w);
        const double a = p[3];
        if (a == 0) continue;
        double n = hash2(x + sd + ph * 7919, y - sd + ph * 104729);
        if (!uniform) n = n * n;
        const double v = a * (1 - amt * n);
        p[3] = u8c(clip_result ? std::min(a, clamp255(v)) : clamp255(v));
      }
    }
  });
}

}  // namespace premation::effects
