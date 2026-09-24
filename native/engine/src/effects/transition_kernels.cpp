// Ports of src/core/effects/transitions.ts (venetian blinds, gradient wipe,
// card wipe, radial wipe, block dissolve — alpha-only reveals) and
// aeChannel.ts (alpha levels, solid composite, channel combiner, remove color
// matting).
#include <algorithm>
#include <array>
#include <vector>

#include "color_space.hpp"
#include "kernels.hpp"

namespace premation::effects {

namespace {

constexpr double kPi = 3.141592653589793;

void clear_alpha(RgbaView img) {
  for (std::size_t i = 3; i < img.data.size(); i += 4) img.data[i] = 0;
}

double clamp_completion(double c) { return c <= 0 ? 0 : c >= 1 ? 1 : c; }

}  // namespace

void venetian_blinds(RgbaView img, double completion, double angle_deg, double width_px, double feather,
                     ThreadPool* pool) {
  const double t = clamp_completion(completion);
  if (t <= 0) return;
  if (t >= 1) {
    clear_alpha(img);
    return;
  }
  const int w = img.w;
  const double pitch = std::max(1.0, width_px);
  const double rad = (angle_deg * kPi) / 180;
  const double cs = js::cos(rad);
  const double sn = js::sin(rad);
  const double soft = std::max(0.0, feather);
  std::uint8_t* data = img.data.data();
  for_rows(pool, img.h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        const double px = x - w / 2.0;
        const double py = y - img.h / 2.0;
        const double proj = px * cs + py * sn;
        double d = std::fmod(proj, pitch);
        if (d < 0) d += pitch;
        const double half = (pitch * t) / 2;
        const double from_centre = std::fabs(d - pitch / 2);
        const double coverage =
            soft <= 0 ? (from_centre < half ? 0 : 1) : std::max(0.0, std::min(1.0, (from_centre - half) / soft));
        std::uint8_t* p = data + idx4(x, y, w);
        p[3] = u8c(p[3] * coverage);
      }
    }
  });
}

void gradient_wipe(RgbaView img, double completion, double softness, bool invert, ThreadPool* pool) {
  const double t = clamp_completion(completion);
  if (t <= 0) return;
  const double soft = std::max(0.0001, softness);
  const double threshold = t * (1 + soft * 2) - soft;
  each_pixel(img, pool, [&](std::uint8_t* px) {
    // luminanceMapFrom: the layer's own luma through a Float32Array.
    const double raw =
        static_cast<double>(static_cast<float>((0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2]) / 255));
    const double lum = invert ? 1 - raw : raw;
    const double coverage = std::max(0.0, std::min(1.0, (lum - threshold) / soft));
    px[3] = u8c(px[3] * coverage);
  });
}

void card_wipe(RgbaView img, double completion, double rows, double columns, double flip_order, ThreadPool* pool) {
  const double t = clamp_completion(completion);
  if (t <= 0) return;
  if (t >= 1) {
    clear_alpha(img);
    return;
  }
  // cardWipeDirection: right, left, down, up, radial.
  const double fo = js::round(flip_order);
  const int dir = (fo >= 0 && fo <= 4) ? static_cast<int>(fo) : 0;
  const int w = img.w;
  const int h = img.h;
  const int cols = static_cast<int>(std::max(1.0, js::round(columns)));
  const int rws = static_cast<int>(std::max(1.0, js::round(rows)));
  const double cell_w = static_cast<double>(w) / cols;
  const double cell_h = static_cast<double>(h) / rws;
  const auto start_of = [&](int cx, int cy) -> double {
    switch (dir) {
      case 1: return cols <= 1 ? 0 : 1 - static_cast<double>(cx) / (cols - 1);
      case 0: return cols <= 1 ? 0 : static_cast<double>(cx) / (cols - 1);
      case 3: return rws <= 1 ? 0 : 1 - static_cast<double>(cy) / (rws - 1);
      case 2: return rws <= 1 ? 0 : static_cast<double>(cy) / (rws - 1);
      default: {
        const double dx = (cx + 0.5) / cols - 0.5;
        const double dy = (cy + 0.5) / rws - 0.5;
        const std::array<double, 2> v{dx, dy};
        return std::min(1.0, js::hypot(v) * 2);
      }
    }
  };
  constexpr double kCardDuration = 0.5;
  const bool flip_h = dir == 0 || dir == 1 || dir == 4;
  std::uint8_t* data = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      const int cy = static_cast<int>(std::min(static_cast<double>(rws - 1), std::floor(y / cell_h)));
      for (int x = 0; x < w; ++x) {
        const int cx = static_cast<int>(std::min(static_cast<double>(cols - 1), std::floor(x / cell_w)));
        const double start = start_of(cx, cy) * (1 - kCardDuration);
        const double local = std::max(0.0, std::min(1.0, (t - start) / kCardDuration));
        const double u = (x - cx * cell_w) / cell_w - 0.5;
        const double v = (y - cy * cell_h) / cell_h - 0.5;
        const double half = (1 - local) / 2;
        const bool inside = flip_h ? std::fabs(u) <= half : std::fabs(v) <= half;
        if (!inside) data[idx4(x, y, w) + 3] = 0;
      }
    }
  });
}

void radial_wipe(RgbaView img, double completion, double start_angle_deg, double direction, double cx, double cy,
                 double feather_deg, ThreadPool* pool) {
  const double t = clamp_completion(completion);
  if (t <= 0) return;
  if (t >= 1) {
    clear_alpha(img);
    return;
  }
  const int dir = direction >= 2 ? 2 : direction >= 1 ? 1 : 0;  // clockwise, counterclockwise, both
  const double tau = kPi * 2;
  const double start = std::fmod((start_angle_deg * kPi) / 180, tau);
  const double swept = (dir == 2 ? t / 2 : t) * tau;
  const double soft = std::max(0.0, (feather_deg * kPi) / 180);
  const int w = img.w;
  std::uint8_t* data = img.data.data();
  for_rows(pool, img.h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        const double vx = x + 0.5 - cx;
        const double vy = y + 0.5 - cy;
        double a = js::atan2(vx, -vy) - start;
        a = std::fmod(std::fmod(a, tau) + tau, tau);
        double into = 0;
        if (dir == 0) {
          into = swept - a;
        } else if (dir == 1) {
          into = swept - (tau - a);
        } else {
          into = std::max(swept - a, swept - (tau - a));
        }
        const double coverage = soft <= 0 ? (into > 0 ? 0 : 1) : std::max(0.0, std::min(1.0, -into / soft));
        std::uint8_t* p = data + idx4(x, y, w);
        p[3] = u8c(p[3] * coverage);
      }
    }
  });
}

void block_dissolve(RgbaView img, double completion, double block_width, double block_height, double feather,
                    double seed, ThreadPool* pool) {
  const double t = clamp_completion(completion);
  if (t <= 0) return;
  if (t >= 1) {
    clear_alpha(img);
    return;
  }
  const int bw = static_cast<int>(std::max(1.0, js::round(block_width)));
  const int bh = static_cast<int>(std::max(1.0, js::round(block_height)));
  const double soft = std::max(0.0, feather);
  // transitions.ts `blockThreshold`: JS doubles (the seed term is ~1.4e18, so
  // the sum rounds), ToInt32 at each `>>`, ToUint32 at the end. Constant per
  // block, so one per block instead of one per pixel.
  const auto block_threshold = [&](double bx, double by) {
    double n = bx * 374761393.0 + by * 668265263.0 + seed * 1442695040888963328.0;
    std::int32_t i = js::to_int32(n);
    n = static_cast<double>(i ^ (i >> 13)) * 1274126177.0;
    i = js::to_int32(n);
    return static_cast<double>(static_cast<std::uint32_t>(i ^ (i >> 16))) / 4294967295.0;
  };
  const int w = img.w;
  const int blocks_x = (w + bw - 1) / bw;
  std::uint8_t* data = img.data.data();
  for_rows(pool, img.h, [&](int y0, int y1) {
    std::vector<double> thr(static_cast<std::size_t>(blocks_x));
    int cached_by = -1;
    for (int y = y0; y < y1; ++y) {
      const int by = y / bh;
      if (by != cached_by) {
        for (int bx = 0; bx < blocks_x; ++bx) thr[static_cast<std::size_t>(bx)] = block_threshold(bx, by);
        cached_by = by;
      }
      for (int x = 0; x < w; ++x) {
        if (thr[static_cast<std::size_t>(x / bw)] >= t) continue;
        double coverage = 0;
        if (soft > 0) {
          const int in_x = std::min(x % bw, bw - 1 - (x % bw));
          const int in_y = std::min(y % bh, bh - 1 - (y % bh));
          coverage = 1 - std::max(0.0, std::min(1.0, std::min(in_x, in_y) / soft));
        }
        std::uint8_t* p = data + idx4(x, y, w);
        p[3] = u8c(p[3] * coverage);
      }
    }
  });
}

// ── aeChannel.ts ────────────────────────────────────────────────────────────

void alpha_levels(RgbaView img, double in_black, double in_white, double gamma, double out_black, double out_white,
                  ThreadPool* pool) {
  std::array<std::uint8_t, 256> table{};
  const double span = std::max(1e-6, in_white - in_black);
  const double g = 1 / std::max(1e-3, gamma);
  for (std::size_t i = 0; i < 256; ++i) {
    const double t = clamp01((static_cast<double>(i) - in_black) / span);
    table[i] = u8t(clamp255(out_black + (out_white - out_black) * js::pow(t, g)));
  }
  each_pixel(img, pool, [&](std::uint8_t* px) { px[3] = table[px[3]]; });
}

void solid_composite(RgbaView img, const Rgb& color, double source_opacity, double solid_opacity, double mode,
                     ThreadPool* pool) {
  const double so = clamp01(source_opacity / 100);
  const double co = clamp01(solid_opacity / 100);
  const double m = js::round(mode);
  const double cr = color.r;
  const double cg = color.g;
  const double cb = color.b;
  each_pixel(img, pool, [&](std::uint8_t* px) {
    const double sa = (px[3] / 255.0) * so;
    const double r = px[0];
    const double g = px[1];
    const double b = px[2];
    double br = r;
    double bg = g;
    double bb = b;
    if (m == 1) {
      br = (r * cr) / 255;
      bg = (g * cg) / 255;
      bb = (b * cb) / 255;
    } else if (m == 2) {
      br = 255 - ((255 - r) * (255 - cr)) / 255;
      bg = 255 - ((255 - g) * (255 - cg)) / 255;
      bb = 255 - ((255 - b) * (255 - cb)) / 255;
    } else if (m == 3) {
      br = r + cr;
      bg = g + cg;
      bb = b + cb;
    }
    px[0] = u8c(clamp255(cr * co + (br - cr * co) * sa));
    px[1] = u8c(clamp255(cg * co + (bg - cg * co) * sa));
    px[2] = u8c(clamp255(cb * co + (bb - cb * co) * sa));
    px[3] = u8c(clamp255(255 * (sa + co - sa * co)));
  });
}

void channel_combiner(RgbaView img, double mode, ThreadPool* pool) {
  const double m = js::round(mode);
  each_pixel(img, pool, [&](std::uint8_t* px) {
    const double r = px[0];
    const double g = px[1];
    const double b = px[2];
    const std::uint8_t a = px[3];
    if (m == 0) {
      const Hsl c = rgb_to_hsl(r, g, b);
      px[0] = u8c(clamp255(c.h * 255));
      px[1] = u8c(clamp255(c.s * 255));
      px[2] = u8c(clamp255(c.l * 255));
    } else if (m == 1) {
      const auto c = hsl_to_rgb(r / 255, g / 255, b / 255);
      px[0] = u8c(c[0]);
      px[1] = u8c(c[1]);
      px[2] = u8c(c[2]);
    } else if (m == 2) {
      const double y = luma709(r, g, b);
      px[0] = u8c(clamp255(y));
      px[1] = u8c(clamp255((b - y) * 0.565 + 128));
      px[2] = u8c(clamp255((r - y) * 0.713 + 128));
    } else if (m == 3) {
      const double y = r;
      const double u = g - 128;
      const double v = b - 128;
      px[0] = u8c(clamp255(y + 1.403 * v));
      px[1] = u8c(clamp255(y - 0.344 * u - 0.714 * v));
      px[2] = u8c(clamp255(y + 1.770 * u));
    } else if (m == 4) {
      px[3] = u8c(clamp255(luma709(r, g, b)));
    } else if (m == 5) {
      px[0] = a;
      px[1] = a;
      px[2] = a;
      px[3] = 255;
    } else if (m == 6) {
      const std::uint8_t v = std::max(px[0], std::max(px[1], px[2]));
      px[0] = px[1] = px[2] = v;
    } else if (m == 7) {
      const std::uint8_t v = std::min(px[0], std::min(px[1], px[2]));
      px[0] = px[1] = px[2] = v;
    }
  });
}

void remove_color_matting(RgbaView img, const Rgb& bg, double threshold, double amount, ThreadPool* pool) {
  const double floor_a = clamp01(threshold / 100);
  const double strength = clamp01(amount / 100);
  if (strength <= 0) return;
  const std::array<double, 3> bgc{bg.r, bg.g, bg.b};
  each_pixel(img, pool, [&](std::uint8_t* px) {
    const double a = px[3] / 255.0;
    if (a <= floor_a || a >= 1) return;
    const double inv = 1 - a;
    for (std::size_t c = 0; c < 3; ++c) {
      const double premul = px[c];
      const double straight = (premul - bgc[c] * inv) / a;
      px[c] = u8c(clamp255(premul + (straight - premul) * strength));
    }
  });
}

}  // namespace premation::effects
