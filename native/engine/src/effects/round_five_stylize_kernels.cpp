// Port of src/core/effects/aeStylizeRoundFive.ts — Glass, Texturize, Threads,
// Chromatic Aberration, Hex Tile, Vector Blur.
#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <optional>
#include <vector>

#include "color_space.hpp"
#include "kernels.hpp"
#include "noise_hash.hpp"
#include "remap.hpp"

namespace premation::effects {

namespace {

constexpr double kPi = 3.141592653589793;
constexpr double kDeg = kPi / 180;

double hypot2(double a, double b) {
  const std::array<double, 2> v{a, b};
  return js::hypot(v);
}

/// `gradAt(field, w, h, x, y)`.
std::array<double, 2> grad_at(const std::vector<float>& f, int w, int h, int x, int y) {
  const int xm = std::max(0, x - 1);
  const int xp = std::min(w - 1, x + 1);
  const int ym = std::max(0, y - 1);
  const int yp = std::min(h - 1, y + 1);
  const auto at = [&](int xx, int yy) {
    return static_cast<double>(f[static_cast<std::size_t>(yy) * static_cast<std::size_t>(w) + static_cast<std::size_t>(xx)]);
  };
  const int dxs = xp - xm;
  const int dys = yp - ym;
  return {(at(xp, y) - at(xm, y)) / (dxs != 0 ? dxs : 1), (at(x, yp) - at(x, ym)) / (dys != 0 ? dys : 1)};
}

double texture_pattern(double pattern, double x, double y, double scale) {
  const double s = 100 / std::max(10.0, scale);
  const double u = x * s;
  const double v = y * s;
  const double p = js::round(pattern);
  if (p == 0) {
    const double xi = std::floor(u / 4);
    const double yi = std::floor(v / 4);
    const double fx = (u / 4) - xi;
    const double fy = (v / 4) - yi;
    const double a = hash2(xi, yi * 733);
    const double b = hash2(xi + 1, yi * 733);
    const double c = hash2(xi, (yi + 1) * 733);
    const double d = hash2(xi + 1, (yi + 1) * 733);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
  if (p == 2) return 0.5 + 0.25 * js::sin(u * 0.9) + 0.25 * js::sin(v * 0.9);
  if (p == 3) {
    const double row = std::floor(v / 8);
    const double uu = u + (std::fmod(row, 2.0) == 0 ? 0 : 8);
    const double in_x = std::fmod(std::fmod(uu, 16.0) + 16, 16.0);
    const double in_y = std::fmod(std::fmod(v, 8.0) + 8, 8.0);
    return in_x < 1 || in_y < 1 ? 0 : 0.7;
  }
  const double weave = 0.30 * js::sin(u * 3.7) * js::sin(v * 3.9);
  const double grit = 0.18 * (hash2(std::floor(u * 2), std::floor(v * 2) * 977) - 0.5);
  return 0.5 + weave + grit;
}

/// `sampleChannel`: clamped (to w − 1.001) bilinear of one channel.
double sample_channel(const std::uint8_t* src, int w, int h, double x, double y, std::size_t ch) {
  const double cx = std::min(w - 1.001, std::max(0.0, x));
  const double cy = std::min(h - 1.001, std::max(0.0, y));
  const double x0 = std::floor(cx);
  const double y0 = std::floor(cy);
  const double fx = cx - x0;
  const double fy = cy - y0;
  const int xi = static_cast<int>(x0);
  const int yi = static_cast<int>(y0);
  const int x1 = std::min(w - 1, xi + 1);
  const int y1 = std::min(h - 1, yi + 1);
  return src[idx4(xi, yi, w) + ch] * (1 - fx) * (1 - fy) + src[idx4(x1, yi, w) + ch] * fx * (1 - fy) +
         src[idx4(xi, y1, w) + ch] * (1 - fx) * fy + src[idx4(x1, y1, w) + ch] * fx * fy;
}

}  // namespace

void glass(RgbaView img, double bump_softness, double height, double displacement, double light_angle,
           double light_intensity, double shininess, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  const std::vector<float> field = luma_alpha_field(img, bump_softness, pool);
  const double hgt = height / 100;
  const double disp = displacement;
  remap_rgba(img, pool, [&](double dx, double dy) -> std::optional<RemapPt> {
    const int x = static_cast<int>(std::min(static_cast<double>(w - 1), std::max(0.0, std::floor(dx))));
    const int y = static_cast<int>(std::min(static_cast<double>(h - 1), std::max(0.0, std::floor(dy))));
    const auto g = grad_at(field, w, h, x, y);
    return RemapPt{dx + g[0] * hgt * disp, dy + g[1] * hgt * disp};
  });
  const double la = light_angle * kDeg;
  const double lx = js::cos(la);
  const double ly = -js::sin(la);
  const double gain = light_intensity / 100;
  const double shine = clamp01(shininess / 100);
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        std::uint8_t* o = out + idx4(x, y, w);
        if (o[3] == 0) continue;
        const auto g = grad_at(field, w, h, x, y);
        const double facing = (-g[0] * lx - g[1] * ly) * hgt;
        const double diffuse = 1 + gain * facing * 0.04;
        const double spec = shine * gain * js::pow(clamp01(facing * 0.02), 2) * 255;
        for (std::size_t c = 0; c < 3; ++c) o[c] = u8c(clamp255(o[c] * diffuse + spec));
      }
    }
  });
}

void texturize(RgbaView img, double pattern, double contrast, double scale, double light_angle, ThreadPool* pool) {
  const double gain = contrast / 100;
  if (gain <= 0) return;
  const double la = light_angle * kDeg;
  const double lx = js::cos(la);
  const double ly = -js::sin(la);
  const int w = img.w;
  std::uint8_t* data = img.data.data();
  for_rows(pool, img.h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        std::uint8_t* p = data + idx4(x, y, w);
        if (p[3] == 0) continue;
        const double t0 = texture_pattern(pattern, x - lx, y - ly, scale);
        const double t1 = texture_pattern(pattern, x + lx, y + ly, scale);
        const double shade = 1 + gain * (t1 - t0);
        for (std::size_t c = 0; c < 3; ++c) p[c] = u8c(clamp255(p[c] * shade));
      }
    }
  });
}

void threads(RgbaView img, double thickness, double spacing, double depth, ThreadPool* pool) {
  const int th = static_cast<int>(std::max(2.0, js::round(thickness)));
  const int gap = static_cast<int>(std::max(0.0, js::round(spacing)));
  const int period = th + gap;
  const double dk = clamp01(depth / 100);
  const int w = img.w;
  std::uint8_t* data = img.data.data();
  for_rows(pool, img.h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        std::uint8_t* p = data + idx4(x, y, w);
        const bool in_h = (y % period) < th;
        const bool in_v = (x % period) < th;
        if (!in_h && !in_v) {
          p[0] = p[1] = p[2] = p[3] = 0;
          continue;
        }
        const bool v_on_top = ((x / period) + (y / period)) % 2 == 0;
        const bool show_v = in_v && (v_on_top || !in_h);
        const int across = show_v ? (x % period) : (y % period);
        const double profile = js::sin(((across + 0.5) / th) * kPi);
        double shade = 0.55 + 0.45 * profile;
        if (in_h && in_v && dk > 0) {
          const int under = show_v ? (y % period) : (x % period);
          const int edge = std::min(under, th - 1 - under);
          if (edge < 1.5) shade *= 1 - dk * 0.6;
        }
        for (std::size_t c = 0; c < 3; ++c) p[c] = u8c(clamp255(p[c] * shade));
      }
    }
  });
}

void chromatic_aberration(RgbaView img, double amount, double aberration_mode, double angle, double falloff,
                          double center_x, double center_y, ThreadPool* pool) {
  if (amount <= 0) return;
  const int w = img.w;
  const int h = img.h;
  const double cx = w / 2.0 + center_x;
  const double cy = h / 2.0 + center_y;
  const double max_r = std::max(1.0, hypot2(std::max(cx, w - cx), std::max(cy, h - cy)));
  const bool linear = js::round(aberration_mode) == 1;
  const double la = angle * kDeg;
  const double lvx = js::cos(la) * amount;
  const double lvy = js::sin(la) * amount;
  const double ex = 1 + (falloff / 100) * 3;
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        double vx = lvx;
        double vy = lvy;
        if (!linear) {
          const double dx = x - cx;
          const double dy = y - cy;
          const double r = hypot2(dx, dy);
          if (r < 1e-3) continue;
          const double scale = (amount * js::pow(r / max_r, ex)) / r;
          vx = dx * scale;
          vy = dy * scale;
        }
        std::uint8_t* o = out + idx4(x, y, w);
        o[0] = u8c(clamp255(sample_channel(src.data(), w, h, x - vx, y - vy, 0)));
        o[2] = u8c(clamp255(sample_channel(src.data(), w, h, x + vx, y + vy, 2)));
        const double a_shift = std::max(sample_channel(src.data(), w, h, x - vx, y - vy, 3),
                                        sample_channel(src.data(), w, h, x + vx, y + vy, 3));
        o[3] = u8c(clamp255(std::max(static_cast<double>(o[3]), a_shift)));
      }
    }
  });
}

void hex_tile(RgbaView img, double radius, double border, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  const double R = std::max(2.0, radius);
  const double hex_w = R * 1.5;
  const double hex_h = R * std::sqrt(3.0);
  const double bd = clamp01(border / 100);
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        const double col = round_index(x / hex_w);
        double best = std::numeric_limits<double>::infinity();
        double bcx = 0;
        double bcy = 0;
        for (int dc = -1; dc <= 1; ++dc) {
          const double c = col + dc;
          const double ccx = c * hex_w;
          const double off = static_cast<std::int64_t>(c) % 2 == 0 ? 0 : hex_h / 2;  // c is an integer
          const double row = round_index((y - off) / hex_h);
          for (int dr = -1; dr <= 1; ++dr) {
            const double ccy = (row + dr) * hex_h + off;
            const double d = (x - ccx) * (x - ccx) + (y - ccy) * (y - ccy);
            if (d < best) {
              best = d;
              bcx = ccx;
              bcy = ccy;
            }
          }
        }
        const double sx = std::min(static_cast<double>(w - 1), std::max(0.0, round_index(bcx)));
        const double sy = std::min(static_cast<double>(h - 1), std::max(0.0, round_index(bcy)));
        const std::uint8_t* s = src.data() + idx4(static_cast<int>(sx), static_cast<int>(sy), w);
        std::uint8_t* o = out + idx4(x, y, w);
        o[0] = s[0];
        o[1] = s[1];
        o[2] = s[2];
        o[3] = s[3];
        if (bd > 0) {
          const double d = std::sqrt(best);
          const double edge =
              clamp01((d - (hex_h / 2 - std::max(1.0, R * 0.12) - bd * R * 0.3)) / std::max(1.0, R * 0.12));
          const double shade = 1 - bd * edge;
          for (std::size_t c = 0; c < 3; ++c) o[c] = u8c(clamp255(o[c] * shade));
        }
      }
    }
  });
}

void vector_blur(RgbaView img, double amount, double angle_offset, double smoothness, ThreadPool* pool) {
  if (amount <= 0) return;
  const int w = img.w;
  const int h = img.h;
  const std::vector<float> field = luma_alpha_field(img, smoothness, pool);
  const double rot = angle_offset * kDeg;
  const double cos_r = js::cos(rot);
  const double sin_r = js::sin(rot);
  const int K = static_cast<int>(std::max(2.0, std::min(24.0, js::round(amount))));
  const double step = amount / K;
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        const auto g = grad_at(field, w, h, x, y);
        const double mag = hypot2(g[0], g[1]);
        double fx = 0;
        double fy = 0;
        if (mag > 1e-4) {
          const double tx = -g[1] / mag;
          const double ty = g[0] / mag;
          fx = tx * cos_r - ty * sin_r;
          fy = tx * sin_r + ty * cos_r;
        }
        std::uint8_t* o = out + idx4(x, y, w);
        if (fx == 0 && fy == 0) continue;  // source pixel, already in place
        std::array<double, 4> acc{};
        double cnt = 0;
        for (int k = -K; k <= K; ++k) {
          const double sx = round_index(x + fx * k * step);
          const double sy = round_index(y + fy * k * step);
          if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
          const std::uint8_t* s = src.data() + idx4(static_cast<int>(sx), static_cast<int>(sy), w);
          for (std::size_t c = 0; c < 4; ++c) acc[c] += s[c];
          cnt += 1;
        }
        if (cnt == 0) {
          o[0] = o[1] = o[2] = o[3] = 0;
          continue;
        }
        for (std::size_t c = 0; c < 4; ++c) o[c] = u8c(clamp255(acc[c] / cnt));
      }
    }
  });
}

}  // namespace premation::effects
