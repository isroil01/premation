// Port of src/core/effects/aeDistortAdvanced.ts — Ripple, Magnify, Warp, Page
// Turn, Split, Slant, Smear, Rolling Shutter, Radial Shadow.
#include <algorithm>
#include <array>
#include <optional>
#include <vector>

#include "kernels.hpp"
#include "remap.hpp"

namespace premation::effects {

namespace {

constexpr double kPi = 3.141592653589793;

double clampd(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }

double hypot2(double a, double b) {
  const std::array<double, 2> v{a, b};
  return js::hypot(v);
}

}  // namespace

void ripple(RgbaView img, double center_x, double center_y, double radius, double amplitude, double frequency,
            double phase, double decay, ThreadPool* pool) {
  if (amplitude == 0) return;
  const double cx = img.w / 2.0 + center_x;
  const double cy = img.h / 2.0 + center_y;
  const double rad = radius > 0 ? radius : hypot2(img.w, img.h);
  const double ph = (phase * kPi) / 180;
  const double dec = std::max(0.0, decay);
  remap_rgba(img, pool, [&](double dx, double dy) -> std::optional<RemapPt> {
    const double ox = dx - cx;
    const double oy = dy - cy;
    const double d = hypot2(ox, oy);
    if (d < 1e-6 || d > rad) return RemapPt{dx, dy};
    const double t = 1 - d / rad;
    const double falloff = t * t * (3 - 2 * t) * js::exp(-dec * (d / rad));
    const double push = js::sin((d / std::max(1e-6, rad)) * frequency * kPi * 2 - ph) * amplitude * falloff;
    const double k = (d - push) / d;
    return RemapPt{cx + ox * k, cy + oy * k};
  });
}

void magnify(RgbaView img, double center_x, double center_y, double magnification, double radius, double shape,
             double feather, ThreadPool* pool) {
  const double scale = std::max(0.01, magnification / 100);
  if (std::fabs(scale - 1) < 1e-6 || radius <= 0) return;
  const double cx = img.w / 2.0 + center_x;
  const double cy = img.h / 2.0 + center_y;
  const bool sq = js::round(shape) == 1;
  const double feath = clampd(feather, 0, radius);
  remap_rgba(img, pool, [&](double dx, double dy) -> std::optional<RemapPt> {
    const double ox = dx - cx;
    const double oy = dy - cy;
    const double d = sq ? std::max(std::fabs(ox), std::fabs(oy)) : hypot2(ox, oy);
    if (d > radius) return RemapPt{dx, dy};
    const double edge = radius - feath;
    const double t = feath <= 0 ? 1 : 1 - clamp01((d - edge) / feath);
    const double s = 1 + (1 / scale - 1) * (t * t * (3 - 2 * t));
    return RemapPt{cx + ox * s, cy + oy * s};
  });
}

void warp(RgbaView img, double style, double bend, double horizontal, double vertical, double axis,
          ThreadPool* pool) {
  const double b = bend / 100;
  if (b == 0 && horizontal == 0 && vertical == 0) return;
  const double st = js::round(style);
  const bool vert = js::round(axis) == 1;
  const double w = img.w;
  const double h = img.h;
  remap_rgba(img, pool, [&](double dx, double dy) -> std::optional<RemapPt> {
    const double u = vert ? (dy / h) * 2 - 1 : (dx / w) * 2 - 1;
    const double v = vert ? (dx / w) * 2 - 1 : (dy / h) * 2 - 1;
    double du = 0;
    double dv = 0;
    if (st == 0) {
      dv = b * (1 - u * u);
    } else if (st == 1) {
      dv = b * (1 - u * u) * (v * 0.5 + 0.5);
    } else if (st == 2) {
      dv = b * js::sin(u * kPi * 2) * (v * 0.5 + 0.5);
    } else if (st == 3) {
      dv = b * js::sin(u * kPi * 2);
    } else if (st == 4) {
      const double r = hypot2(u, v);
      const double k = 1 + b * (1 - clamp01(r));
      du = u * (k - 1);
      dv = v * (k - 1);
    } else if (st == 5) {
      dv = b * (u * 0.5 + 0.5);
    } else {
      dv = b * (1 - u * u) * v;
    }
    const double su = u - du - (vert ? vertical : horizontal) / 100;
    const double sv = v - dv - (vert ? horizontal : vertical) / 100;
    const double sx = vert ? ((sv + 1) / 2) * w : ((su + 1) / 2) * w;
    const double sy = vert ? ((su + 1) / 2) * h : ((sv + 1) / 2) * h;
    return RemapPt{sx, sy};
  });
}

void page_turn(RgbaView img, double amount, double angle, double radius, double back_opacity, double shading,
               ThreadPool* pool) {
  const double t = clamp01(amount / 100);
  if (t <= 0) return;
  const int w = img.w;
  const int h = img.h;
  const double a = (angle * kPi) / 180;
  const double nx = js::cos(a);
  const double ny = js::sin(a);
  const double diag = std::fabs(w * nx) + std::fabs(h * ny);
  const double fold_at = (1 - t) * diag - (w * nx + h * ny) / 2 + diag * 0;
  const double rad = std::max(1.0, radius);
  const double back_a = clamp01(back_opacity / 100);
  const double shade = clamp01(shading / 100);
  const std::vector<std::uint8_t> data(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  const auto sample = [&](double sx, double sy, std::uint8_t* o, double mul, double alpha_mul) {
    const double x0 = std::floor(sx - 0.5);
    const double y0 = std::floor(sy - 0.5);
    const double fx = sx - 0.5 - x0;
    const double fy = sy - 0.5 - y0;
    for (std::size_t c = 0; c < 4; ++c) {
      double acc = 0;
      for (int j = 0; j <= 1; ++j) {
        for (int i = 0; i <= 1; ++i) {
          const double px = x0 + i;
          const double py = y0 + j;
          if (px < 0 || px >= w || py < 0 || py >= h) continue;
          acc += data[idx4(static_cast<int>(px), static_cast<int>(py), w) + c] *
                 ((i != 0 ? fx : 1 - fx) * (j != 0 ? fy : 1 - fy));
        }
      }
      o[c] = u8c(c == 3 ? acc * alpha_mul : acc * mul);
    }
  };
  for_rows(pool, h, [&](int y0, int y1) {
    for (int dy = y0; dy < y1; ++dy) {
      for (int dx = 0; dx < w; ++dx) {
        std::uint8_t* o = out + idx4(dx, dy, w);
        const double d = (dx + 0.5 - w / 2.0) * nx + (dy + 0.5 - h / 2.0) * ny - fold_at;
        if (d < 0) continue;  // flat part: the source pixel, already in place
        o[0] = o[1] = o[2] = o[3] = 0;
        if (d > kPi * rad) continue;
        const double theta = d / rad;
        const double back = rad * js::sin(theta);
        const double sx = dx + 0.5 - nx * (d + back);
        const double sy = dy + 0.5 - ny * (d + back);
        if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
        const double lit = 1 - shade * (1 - js::cos(theta));
        sample(sx, sy, o, clamp01(lit) * (0.35 + 0.65 * back_a), back_a);
      }
    }
  });
}

void split(RgbaView img, double offset, double angle, double center_x, double center_y, ThreadPool* pool) {
  if (offset == 0) return;
  const double a = (angle * kPi) / 180;
  const double nx = js::cos(a);
  const double ny = js::sin(a);
  const double cx = img.w / 2.0 + center_x;
  const double cy = img.h / 2.0 + center_y;
  const double half = offset / 2;
  remap_rgba(img, pool, [&](double dx, double dy) -> std::optional<RemapPt> {
    const double side = (dx - cx) * nx + (dy - cy) * ny >= 0 ? 1 : -1;
    return RemapPt{dx - side * half * nx, dy - side * half * ny};
  });
}

void slant(RgbaView img, double slant_px, double axis, double floor_v, ThreadPool* pool) {
  if (slant_px == 0) return;
  const bool vert = js::round(axis) == 1;
  const double anchor = clamp01(floor_v);
  const double w = img.w;
  const double h = img.h;
  remap_rgba(img, pool, [&](double dx, double dy) -> std::optional<RemapPt> {
    if (vert) return RemapPt{dx, dy - slant_px * (dx / w - anchor)};
    return RemapPt{dx - slant_px * (dy / h - anchor), dy};
  });
}

void smear(RgbaView img, double from_x, double from_y, double to_x, double to_y, double radius, double elasticity,
           ThreadPool* pool) {
  const double fx = img.w / 2.0 + from_x;
  const double fy = img.h / 2.0 + from_y;
  const double vx = to_x - from_x;
  const double vy = to_y - from_y;
  if ((vx == 0 && vy == 0) || radius <= 0) return;
  const double el = std::max(0.1, elasticity / 100);
  remap_rgba(img, pool, [&](double dx, double dy) -> std::optional<RemapPt> {
    const double d = hypot2(dx - fx, dy - fy);
    if (d >= radius) return RemapPt{dx, dy};
    const double t = 1 - d / radius;
    const double k = js::pow(t * t * (3 - 2 * t), 1 / el);
    return RemapPt{dx - vx * k, dy - vy * k};
  });
}

void rolling_shutter(RgbaView img, double sweep, double wobble, double direction, bool vertical, ThreadPool* pool) {
  if (sweep == 0 && wobble == 0) return;
  const bool flip = js::round(direction) == 1;
  const double w = img.w;
  const double h = img.h;
  remap_rgba(img, pool, [&](double dx, double dy) -> std::optional<RemapPt> {
    const double along = vertical ? dx / w : dy / h;
    const double t = flip ? 1 - along : along;
    const double shift = sweep * t + wobble * js::sin(t * kPi * 2);
    return vertical ? RemapPt{dx, dy - shift} : RemapPt{dx - shift, dy};
  });
}

void radial_shadow(RgbaView img, double light_x, double light_y, double projection, const Rgb& color, double opacity,
                   double softness, double render_mode, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  const double lx = w / 2.0 + light_x;
  const double ly = h / 2.0 + light_y;
  const double proj = 1 + std::max(0.0, projection) / 100;
  const double op = clamp01(opacity / 100);
  const bool shadow_only = js::round(render_mode) == 1;
  const std::vector<std::uint8_t> data(img.data.begin(), img.data.end());
  std::vector<float> shadow(img.pixels(), 0.0F);
  for_rows(pool, h, [&](int y0, int y1) {
    for (int dy = y0; dy < y1; ++dy) {
      for (int dx = 0; dx < w; ++dx) {
        const double sx = lx + (dx + 0.5 - lx) / proj;
        const double sy = ly + (dy + 0.5 - ly) / proj;
        if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
        shadow[static_cast<std::size_t>(dy) * static_cast<std::size_t>(w) + static_cast<std::size_t>(dx)] =
            static_cast<float>(data[idx4(ji32(sx), ji32(sy), w) + 3] / 255.0);
      }
    }
  });
  if (softness > 0) box_blur_plane(shadow, w, h, js::round(softness), pool);
  const std::array<double, 3> col{color.r, color.g, color.b};
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (std::size_t p = static_cast<std::size_t>(y0) * static_cast<std::size_t>(w);
         p < static_cast<std::size_t>(y1) * static_cast<std::size_t>(w); ++p) {
      const std::size_t i = p * 4;
      const double s = clamp01(static_cast<double>(shadow[p])) * op;
      const double la = data[i + 3] / 255.0;
      if (shadow_only) {
        out[i] = u8c(col[0]);
        out[i + 1] = u8c(col[1]);
        out[i + 2] = u8c(col[2]);
        out[i + 3] = u8c(clamp255(s * 255));
        continue;
      }
      const double out_a = la + s * (1 - la);
      if (out_a <= 0) {
        out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
        continue;
      }
      for (std::size_t c = 0; c < 3; ++c) out[i + c] = u8c(clamp255((data[i + c] * la + col[c] * s * (1 - la)) / out_a));
      out[i + 3] = u8c(clamp255(out_a * 255));
    }
  });
}

}  // namespace premation::effects
