// Port of src/core/effects/aeStylizeAdvanced.ts — Cartoon, Brush Strokes,
// Strobe Light, Color Emboss, Halftone, Kaleidoscope, Vignette, Burn Film.
#include <algorithm>
#include <array>
#include <optional>
#include <unordered_map>
#include <vector>

#include "color_space.hpp"
#include "kernels.hpp"
#include "noise_hash.hpp"
#include "remap.hpp"

namespace premation::effects {

namespace {

constexpr double kPi = 3.141592653589793;

/// `boxBlurRgb`: a clamped, alpha-weighted box, horizontal then vertical,
/// through Uint8ClampedArrays (colour left 0 where the window has no alpha).
std::vector<std::uint8_t> box_blur_rgb(const std::vector<std::uint8_t>& src, int w, int h, int r, ThreadPool* pool) {
  std::vector<std::uint8_t> tmp(src.size(), 0);
  std::vector<std::uint8_t> out(src.size(), 0);
  const auto pass = [&](const std::vector<std::uint8_t>& from, std::vector<std::uint8_t>& to, bool horiz) {
    for_rows(pool, h, [&](int y0, int y1) {
      for (int y = y0; y < y1; ++y) {
        for (int x = 0; x < w; ++x) {
          double ar = 0;
          double ag = 0;
          double ab = 0;
          double aa = 0;
          double n = 0;
          for (int d = -r; d <= r; ++d) {
            const int sx = horiz ? clampi(x + d, 0, w - 1) : x;
            const int sy = horiz ? y : clampi(y + d, 0, h - 1);
            const std::uint8_t* p = from.data() + idx4(sx, sy, w);
            const double a = p[3];
            ar += p[0] * a;
            ag += p[1] * a;
            ab += p[2] * a;
            aa += a;
            n += 1;
          }
          std::uint8_t* o = to.data() + idx4(x, y, w);
          if (aa > 0) {
            o[0] = u8c(ar / aa);
            o[1] = u8c(ag / aa);
            o[2] = u8c(ab / aa);
          }
          o[3] = u8c(aa / std::max(1.0, n));
        }
      }
    });
  };
  pass(src, tmp, true);
  pass(tmp, out, false);
  return out;
}

}  // namespace

void cartoon(RgbaView img, double smoothness, double levels, double edge_threshold, double edge_width,
             double edge_opacity, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  if (w <= 0 || h <= 0) return;
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  const int blur_r = static_cast<int>(std::max(0.0, std::min(12.0, js::round(smoothness))));
  const std::vector<std::uint8_t> smoothed = blur_r > 0 ? box_blur_rgb(src, w, h, blur_r, pool) : src;
  const double n = std::max(2.0, std::min(64.0, js::round(levels)));
  const double step = 255 / (n - 1);
  const double thr = std::max(0.0, edge_threshold);
  const int ink_w = static_cast<int>(std::max(1.0, js::round(edge_width)));
  const double ink_a = clamp01(edge_opacity / 100);
  static constexpr std::array<double, 9> kSx{-1, 0, 1, -2, 0, 2, -1, 0, 1};
  static constexpr std::array<double, 9> kSy{-1, -2, -1, 0, 0, 0, 1, 2, 1};
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        const std::size_t o = idx4(x, y, w);
        for (std::size_t c = 0; c < 3; ++c) out[o + c] = u8c(js::round(smoothed[o + c] / step) * step);
        out[o + 3] = src[o + 3];
        if (ink_a <= 0) continue;
        double gx = 0;
        double gy = 0;
        for (int j = -1; j <= 1; ++j) {
          for (int i = -1; i <= 1; ++i) {
            const int sx = clampi(x + i * ink_w, 0, w - 1);
            const int sy = clampi(y + j * ink_w, 0, h - 1);
            const std::uint8_t* p = src.data() + idx4(sx, sy, w);
            const double l = luma709(p[0], p[1], p[2]);
            const auto k = static_cast<std::size_t>((j + 1) * 3 + (i + 1));
            gx += l * kSx[k];
            gy += l * kSy[k];
          }
        }
        const std::array<double, 2> g2{gx, gy};
        const double mag = js::hypot(g2);
        if (mag <= thr) continue;
        const double k = 1 - clamp01((mag - thr) / std::max(1e-6, thr)) * ink_a;
        for (std::size_t c = 0; c < 3; ++c) out[o + c] = u8c(out[o + c] * k);
      }
    }
  });
}

void brush_strokes(RgbaView img, double direction, double length, double randomness, double cell_size, double density,
                   ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  const int len = static_cast<int>(std::max(1.0, std::min(32.0, js::round(length))));
  const int cell = static_cast<int>(std::max(1.0, js::round(cell_size)));
  const double jitter = clamp01(randomness / 100) * kPi;
  const double dens = clamp01(density / 100);
  const double base = (direction * kPi) / 180;
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  const int cells_x = (w + cell - 1) / cell;
  for_rows(pool, h, [&](int y0, int y1) {
    // Angle and reach depend only on the cell: computed once per cell of the
    // current cell row (the same values the TS recomputes per pixel).
    std::vector<double> cdx(static_cast<std::size_t>(cells_x));
    std::vector<double> cdy(static_cast<std::size_t>(cells_x));
    std::vector<int> creach(static_cast<std::size_t>(cells_x));
    int cached = -1;
    for (int y = y0; y < y1; ++y) {
      const int cyi = y / cell;
      if (cyi != cached) {
        for (int cxi = 0; cxi < cells_x; ++cxi) {
          const auto u = static_cast<std::size_t>(cxi);
          const double ang = base + (hash2(cxi, cyi) - 0.5) * 2 * jitter;
          cdx[u] = js::cos(ang);
          cdy[u] = js::sin(ang);
          creach[u] = static_cast<int>(std::max(1.0, js::round(len * (0.4 + 0.6 * hash2(cyi, cxi)))));
        }
        cached = cyi;
      }
      for (int x = 0; x < w; ++x) {
        const std::size_t o = idx4(x, y, w);
        const auto u = static_cast<std::size_t>(x / cell);
        const double dx = cdx[u];
        const double dy = cdy[u];
        const int reach = creach[u];
        double ar = 0;
        double ag = 0;
        double ab = 0;
        double aa = 0;
        double n = 0;
        for (int t = -reach; t <= reach; ++t) {
          const double sx = std::min(static_cast<double>(w - 1), std::max(0.0, round_index(x + dx * t)));
          const double sy = std::min(static_cast<double>(h - 1), std::max(0.0, round_index(y + dy * t)));
          const std::uint8_t* p = src.data() + idx4(static_cast<int>(sx), static_cast<int>(sy), w);
          const double a = p[3];
          ar += p[0] * a;
          ag += p[1] * a;
          ab += p[2] * a;
          aa += a;
          n += 1;
        }
        const std::uint8_t* s = src.data() + o;
        if (aa > 0) {
          const double r = ar / aa;
          const double g = ag / aa;
          const double b = ab / aa;
          out[o] = u8c(s[0] + (r - s[0]) * dens);
          out[o + 1] = u8c(s[1] + (g - s[1]) * dens);
          out[o + 2] = u8c(s[2] + (b - s[2]) * dens);
        } else {
          out[o] = s[0];
          out[o + 1] = s[1];
          out[o + 2] = s[2];
        }
        out[o + 3] = u8c(s[3] + (aa / std::max(1.0, n) - s[3]) * dens);
      }
    }
  });
}

void strobe_light(RgbaView img, double time, double period, double duty, double operation, const Rgb& color,
                  double intensity, ThreadPool* pool) {
  const double p = std::max(1e-3, period);
  const double phase = std::fmod(std::fmod(time, p) + p, p) / p;
  if (!(phase < clamp01(duty / 100))) return;
  const double k = clamp01(intensity / 100);
  if (k <= 0) return;
  const double op = js::round(operation);
  const std::array<double, 3> col{color.r, color.g, color.b};
  each_pixel(img, pool, [&](std::uint8_t* px) {
    if (px[3] == 0) return;
    if (op == 1) {
      for (std::size_t c = 0; c < 3; ++c) px[c] = u8c(px[c] + (255 - 2 * px[c]) * k);
    } else if (op == 2) {
      px[3] = u8c(px[3] * (1 - k));
    } else {
      for (std::size_t c = 0; c < 3; ++c) px[c] = u8c(px[c] + (col[c] - px[c]) * k);
    }
  });
}

void color_emboss(RgbaView img, double direction, double relief, double contrast, double blend_with_original,
                  ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  const double a = (direction * kPi) / 180;
  const int ox = static_cast<int>(js::round(js::cos(a) * std::max(1.0, relief)));
  const int oy = static_cast<int>(js::round(js::sin(a) * std::max(1.0, relief)));
  const double k = std::max(0.0, contrast) / 100;
  const double blend = clamp01(1 - blend_with_original / 100);
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        const std::size_t o = idx4(x, y, w);
        const std::size_t pi = idx4(clampi(x - ox, 0, w - 1), clampi(y - oy, 0, h - 1), w);
        const std::size_t ni = idx4(clampi(x + ox, 0, w - 1), clampi(y + oy, 0, h - 1), w);
        for (std::size_t c = 0; c < 3; ++c) {
          const double d = (src[ni + c] - src[pi + c]) * k;
          const double v = clamp255(src[o + c] + d);
          out[o + c] = u8c(src[o + c] + (v - src[o + c]) * blend);
        }
      }
    }
  });
}

void halftone(RgbaView img, double cell_size, double angle, double contrast, const Rgb& ink, const Rgb& paper,
              bool colorize, double blend_with_original, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  const double cell = std::max(2.0, js::round(cell_size));
  const double a = (angle * kPi) / 180;
  const double ca = js::cos(a);
  const double sa = js::sin(a);
  const double k = std::max(0.01, contrast / 100);
  const double blend = clamp01(1 - blend_with_original / 100);
  struct Mean {
    double l = 0, r = 0, g = 0, b = 0, n = 0;
  };
  // The TS keys its Map by `cx * 65536 + cy` (a double of integers, exact in
  // an int64), so cells that collide there collide here too. Means are float
  // sums in scan order, so this pass stays on one thread.
  std::unordered_map<std::int64_t, Mean> means;
  const auto key_of = [&](double rx, double ry) {
    const double cx = std::floor(rx / cell);
    const double cy = std::floor(ry / cell);
    return static_cast<std::int64_t>(cx * 65536 + cy);
  };
  const std::uint8_t* s = img.data.data();
  {
    std::int64_t last_key = 0;
    Mean* last = nullptr;
    for (int y = 0; y < h; ++y) {
      for (int x = 0; x < w; ++x) {
        const std::uint8_t* p = s + idx4(x, y, w);
        const std::int64_t key = key_of(x * ca + y * sa, -x * sa + y * ca);
        if (last == nullptr || key != last_key) {
          last = &means[key];
          last_key = key;
        }
        last->l += luma709(p[0], p[1], p[2]);
        last->r += p[0];
        last->g += p[1];
        last->b += p[2];
        last->n += 1;
      }
    }
  }
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        const std::size_t o = idx4(x, y, w);
        const double rx = x * ca + y * sa;
        const double ry = -x * sa + y * ca;
        const double cx = std::floor(rx / cell);
        const double cy = std::floor(ry / cell);
        const Mean& m = means.at(static_cast<std::int64_t>(cx * 65536 + cy));
        const double mean = m.l / m.n / 255;
        const double radius = std::sqrt(clamp01((1 - mean) * k)) * (cell * 0.72);
        const std::array<double, 2> d2{rx - (cx * cell + cell / 2), ry - (cy * cell + cell / 2)};
        const bool inside = js::hypot(d2) <= radius;
        const double ink_r = colorize ? m.r / m.n : ink.r;
        const double ink_g = colorize ? m.g / m.n : ink.g;
        const double ink_b = colorize ? m.b / m.n : ink.b;
        const double tr = inside ? ink_r : paper.r;
        const double tg = inside ? ink_g : paper.g;
        const double tb = inside ? ink_b : paper.b;
        out[o] = u8c(src[o] + (tr - src[o]) * blend);
        out[o + 1] = u8c(src[o + 1] + (tg - src[o + 1]) * blend);
        out[o + 2] = u8c(src[o + 2] + (tb - src[o + 2]) * blend);
      }
    }
  });
}

void kaleidoscope(RgbaView img, double segments, double center_x, double center_y, double rotation,
                  double source_angle, double zoom, ThreadPool* pool) {
  const int n = static_cast<int>(std::max(1.0, std::min(64.0, js::round(segments))));
  if (n == 1) return;
  const double cx = img.w / 2.0 + center_x;
  const double cy = img.h / 2.0 + center_y;
  const double rot = (rotation * kPi) / 180;
  const double src_a = (source_angle * kPi) / 180;
  const double seg = (kPi * 2) / n;
  const double scale = std::max(0.01, zoom / 100);
  remap_rgba(img, pool, [&](double dx, double dy) -> std::optional<RemapPt> {
    const double ox = dx - cx;
    const double oy = dy - cy;
    const std::array<double, 2> v{ox, oy};
    const double r = js::hypot(v) / scale;
    double ang = js::atan2(oy, ox) - rot;
    double a = std::fmod(std::fmod(ang, seg) + seg, seg);
    const double idx = std::floor(std::fmod(std::fmod(ang, seg * 2) + seg * 2, seg * 2) / seg);
    if (idx == 1) a = seg - a;
    ang = a + src_a;
    return RemapPt{cx + js::cos(ang) * r, cy + js::sin(ang) * r};
  });
}

void vignette(RgbaView img, double amount, double size, double feather, double roundness, double center_x,
              double center_y, ThreadPool* pool) {
  const double amt = amount / 100;
  if (amt == 0) return;
  const int w = img.w;
  const double inner = clamp01(size / 100);
  const double feath = std::max(1e-3, clamp01(feather / 100));
  const double round = clamp01(roundness / 100);
  const double cx = w / 2.0 + center_x;
  const double cy = img.h / 2.0 + center_y;
  const double half_w = w / 2.0;
  const double half_h = img.h / 2.0;
  double diag = std::sqrt(half_w * half_w + half_h * half_h);
  if (diag == 0 || std::isnan(diag)) diag = 1;
  const double inv_diag = 1 / diag;
  const double inv_feath = 1 / feath;
  std::uint8_t* data = img.data.data();
  for_rows(pool, img.h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      const double dy = y + 0.5 - cy;
      const double ey = dy / half_h;
      for (int x = 0; x < w; ++x) {
        std::uint8_t* p = data + idx4(x, y, w);
        if (p[3] == 0) continue;
        const double dx = x + 0.5 - cx;
        const double ex = dx / half_w;
        const double d_ellipse = std::sqrt(ex * ex + ey * ey);
        const double d_circle = std::sqrt(dx * dx + dy * dy) * inv_diag;
        const double d = d_ellipse + (d_circle - d_ellipse) * round;
        double t = (d - inner) * inv_feath;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        // The TS gain map is a Float32Array.
        const auto k = static_cast<double>(static_cast<float>(1 - amt * (t * t * (3 - 2 * t))));
        p[0] = u8c(p[0] * k);
        p[1] = u8c(p[1] * k);
        p[2] = u8c(p[2] * k);
      }
    }
  });
}

void burn_film(RgbaView img, double burn, double center_x, double center_y, const Rgb& burn_color,
               const Rgb& char_color, double randomness, double seed, ThreadPool* pool) {
  const double t = clamp01(burn / 100);
  if (t <= 0) return;
  const int w = img.w;
  const int h = img.h;
  const double cx = w / 2.0 + center_x;
  const double cy = h / 2.0 + center_y;
  const std::array<double, 2> mr{std::max(cx, w - cx), std::max(cy, h - cy)};
  double max_r = js::hypot(mr);
  if (max_r == 0 || std::isnan(max_r)) max_r = 1;
  const double hot = t * max_r * 1.15;
  const double jitter = clamp01(randomness / 100);
  const double sd = js::round(seed);
  const std::array<double, 3> bc{burn_color.r, burn_color.g, burn_color.b};
  const std::array<double, 3> cc{char_color.r, char_color.g, char_color.b};
  std::uint8_t* data = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        std::uint8_t* p = data + idx4(x, y, w);
        if (p[3] == 0) continue;
        const std::array<double, 2> dv{x + 0.5 - cx, y + 0.5 - cy};
        const double d = js::hypot(dv);
        const double n = (hash2(x + sd, y - sd) - 0.5) * jitter * max_r * 0.18;
        const double front = d - n;
        const double cook = t * 0.55;
        if (cook > 0) {
          const Hsl c = rgb_to_hsl(p[0], p[1], p[2]);
          const auto rgb = hsl_to_rgb(c.h, c.s * (1 - cook * 0.7), clamp01(c.l + cook * 0.25));
          p[0] = u8c(rgb[0]);
          p[1] = u8c(rgb[1]);
          p[2] = u8c(rgb[2]);
        }
        if (front <= hot) {
          p[0] = u8c(bc[0]);
          p[1] = u8c(bc[1]);
          p[2] = u8c(bc[2]);
          p[3] = u8c(clamp255(p[3] * clamp01((front / std::max(1e-6, hot)) * 0.35)));
        } else if (front <= hot * 1.18) {
          const double k = 1 - clamp01((front - hot) / std::max(1e-6, hot * 0.18));
          for (std::size_t c = 0; c < 3; ++c) p[c] = u8c(p[c] + (cc[c] - p[c]) * k);
        }
      }
    }
  });
}

}  // namespace premation::effects
