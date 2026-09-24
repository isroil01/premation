// Port of src/core/effects/aeRoundSevenDistort.ts — CC Tiler, CC Ripple
// Pulse, CC Radial ScaleWipe, CC Glass Wipe, CC Image Wipe. The four
// resamples go through `remap_rgba` (distort.ts `remap`); every pass after it
// is per pixel, so rows split freely.
#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
#include <vector>

#include "color_space.hpp"
#include "kernels.hpp"
#include "remap.hpp"

namespace premation::effects {

namespace {

constexpr double kPi = 3.141592653589793;

double hyp(double a, double b) { return jhypot2(a, b); }

/// `pmod(a, m)`: `((a % m) + m) % m`.
double pmod(double a, double m) { return std::fmod(std::fmod(a, m) + m, m); }

}  // namespace

void cc_tiler(RgbaView img, double scale, double center_x, double center_y, double blend_with_original,
              ThreadPool* pool) {
  const double w = img.w;
  const double h = img.h;
  const double k = std::max(0.01, scale / 100);
  const double cx = w / 2 + center_x;
  const double cy = h / 2 + center_y;
  const double blend = clamp01(blend_with_original / 100);
  std::vector<std::uint8_t> src;
  if (blend > 0) src.assign(img.data.begin(), img.data.end());
  remap_rgba(img, pool, [&](double x, double y) -> std::optional<RemapPt> {
    return RemapPt{pmod((x - cx) / k + cx, w), pmod((y - cy) / k + cy, h)};
  });
  if (blend > 0) {
    std::uint8_t* out = img.data.data();
    for_rows(pool, img.h, [&](int y0, int y1) {
      const std::size_t e = static_cast<std::size_t>(y1) * static_cast<std::size_t>(img.w) * 4;
      for (std::size_t i = static_cast<std::size_t>(y0) * static_cast<std::size_t>(img.w) * 4; i < e; ++i) {
        out[i] = u8c(out[i] * (1 - blend) + src[i] * blend);
      }
    });
  }
}

void ripple_pulse(RgbaView img, double center_x, double center_y, double pulse_radius, double amplitude, double width,
                  bool render_bump, ThreadPool* pool) {
  const int w = img.w;
  const double cx = img.w / 2.0 + center_x;
  const double cy = img.h / 2.0 + center_y;
  const double band = std::max(1.0, width);
  remap_rgba(img, pool, [&](double x, double y) -> std::optional<RemapPt> {
    const double dx = x - cx;
    const double dy = y - cy;
    const double r = hyp(dx, dy);
    const double d = r - pulse_radius;
    if (std::fabs(d) >= band || r < 0.0001) return RemapPt{x, y};
    const double disp = amplitude * js::sin((kPi * d) / band);
    return RemapPt{x - (dx / r) * disp, y - (dy / r) * disp};
  });
  if (!render_bump || amplitude == 0) return;
  std::uint8_t* out = img.data.data();
  for_rows(pool, img.h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        const double dx = x + 0.5 - cx;
        const double dy = y + 0.5 - cy;
        const double r = hyp(dx, dy);
        const double d = r - pulse_radius;
        if (std::fabs(d) >= band) continue;
        const double slope = js::cos((kPi * d) / band) * (amplitude / band);
        const double lit = clamp01(1 + slope * 0.5);
        std::uint8_t* o = out + idx4(x, y, w);
        o[0] = u8c(o[0] * lit);
        o[1] = u8c(o[1] * lit);
        o[2] = u8c(o[2] * lit);
      }
    }
  });
}

void radial_scale_wipe(RgbaView img, double completion, double center_x, double center_y, bool reverse,
                       ThreadPool* pool) {
  const double t = clamp01(completion / 100);
  if (t <= 0) return;
  if (t >= 1) {
    std::fill(img.data.begin(), img.data.end(), std::uint8_t{0});
    return;
  }
  const double cx = img.w / 2.0 + center_x;
  const double cy = img.h / 2.0 + center_y;
  const double k = reverse ? 1 - t : 1 / (1 - t);
  remap_rgba(img, pool, [&](double x, double y) -> std::optional<RemapPt> {
    return RemapPt{(x - cx) * k + cx, (y - cy) * k + cy};
  });
  const double fade = 1 - t;
  std::uint8_t* out = img.data.data();
  for_rows(pool, img.h, [&](int y0, int y1) {
    const std::size_t e = static_cast<std::size_t>(y1) * static_cast<std::size_t>(img.w) * 4;
    for (std::size_t i = static_cast<std::size_t>(y0) * static_cast<std::size_t>(img.w) * 4; i < e; i += 4) {
      out[i + 3] = u8c(out[i + 3] * fade);
    }
  });
}

void glass_wipe(RgbaView img, double completion, double displacement, double softness, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  const double t = clamp01(completion / 100);
  if (t <= 0) return;
  if (t >= 1) {
    std::fill(img.data.begin(), img.data.end(), std::uint8_t{0});
    return;
  }
  const double band = std::max(0.02, clamp01(softness / 100));
  // lumAt over the SOURCE, once per pixel.
  std::vector<double> lum(img.pixels());
  const std::uint8_t* s = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (std::size_t i = static_cast<std::size_t>(y0) * static_cast<std::size_t>(w);
         i < static_cast<std::size_t>(y1) * static_cast<std::size_t>(w); ++i) {
      lum[i] = luma709(s[i * 4], s[i * 4 + 1], s[i * 4 + 2]) / 255;
    }
  });
  const auto lum_at = [&](double x, double y) {
    const double xi = std::max(0.0, std::min(static_cast<double>(w - 1), x));
    const double yi = std::max(0.0, std::min(static_cast<double>(h - 1), y));
    return lum[static_cast<std::size_t>(yi) * static_cast<std::size_t>(w) + static_cast<std::size_t>(xi)];
  };
  const double lead = t * (1 + band) - band * 0.5;
  remap_rgba(img, pool, [&](double x, double y) -> std::optional<RemapPt> {
    const double xi = std::floor(x);
    const double yi = std::floor(y);
    const double l = lum_at(xi, yi);
    const double edge = clamp01((lead - l) / band);
    if (edge <= 0 || edge >= 1) return RemapPt{x, y};
    const double gx = lum_at(xi + 1, yi) - lum_at(xi - 1, yi);
    const double gy = lum_at(xi, yi + 1) - lum_at(xi, yi - 1);
    const double k = displacement * js::sin(kPi * edge);
    return RemapPt{x + gx * k, y + gy * k};
  });
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        const double l = lum[static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x)];
        const double edge = clamp01((lead - l) / band);
        std::uint8_t* o = out + idx4(x, y, w);
        o[3] = u8c(o[3] * (1 - edge));
      }
    }
  });
}

void image_wipe(RgbaView img, double completion, double border_softness, double gradient_channel,
                bool invert_gradient, ThreadPool* pool) {
  const double t = clamp01(completion / 100);
  if (t <= 0) return;
  const double band = std::max(0.001, clamp01(border_softness / 100));
  const double th = t * (1 + 2 * band) - band;
  std::uint8_t* d = img.data.data();
  for_rows(pool, img.h, [&](int y0, int y1) {
    const std::size_t e = static_cast<std::size_t>(y1) * static_cast<std::size_t>(img.w) * 4;
    for (std::size_t o = static_cast<std::size_t>(y0) * static_cast<std::size_t>(img.w) * 4; o < e; o += 4) {
      const double r = d[o];
      const double g = d[o + 1];
      const double b = d[o + 2];
      const double a = d[o + 3];
      double v = 0;
      if (gradient_channel == 1) {
        v = a / 255;
      } else if (gradient_channel == 2) {
        v = r / 255;
      } else if (gradient_channel == 3) {
        v = g / 255;
      } else if (gradient_channel == 4) {
        v = b / 255;
      } else {
        v = luma709(r, g, b) / 255;
      }
      if (invert_gradient) v = 1 - v;
      d[o + 3] = u8c(a * (1 - smoothstep(th - band, th + band, v == 0 ? 0 : v)));
    }
  });
}

}  // namespace premation::effects
