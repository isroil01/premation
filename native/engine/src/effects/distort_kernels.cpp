// Ports of src/core/effects/distort.ts — the inverse-map resamples (bulge,
// spherize, twirl, corner pin, polar coordinates, mirror, offset, optics
// compensation, mesh warp, liquify) and their shared bilinear `remap`.
#include <algorithm>
#include <array>
#include <optional>
#include <vector>

#include "kernels.hpp"

namespace premation::effects {

namespace {

constexpr double kPi = 3.141592653589793;

double hypot2(double a, double b) {
  const std::array<double, 2> v{a, b};
  return js::hypot(v);
}

double clampd(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }

struct Pt {
  double x, y;
};

/// distort.ts `remap`: for each destination pixel centre, `invert` names the
/// source point (or nothing: transparent); straight-alpha bilinear, taps
/// outside the layer contribute nothing (their weight is simply lost).
template <class Invert>
void remap(RgbaView img, ThreadPool* pool, Invert&& invert) {
  const int w = img.w;
  const int h = img.h;
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int dy = y0; dy < y1; ++dy) {
      for (int dx = 0; dx < w; ++dx) {
        std::uint8_t* o = out + idx4(dx, dy, w);
        const std::optional<Pt> s = invert(dx + 0.5, dy + 0.5);
        if (!s) {
          o[0] = o[1] = o[2] = o[3] = 0;
          continue;
        }
        const double sx = s->x - 0.5;
        const double sy = s->y - 0.5;
        const double x0 = floor_fast(sx);
        const double yy0 = floor_fast(sy);
        const double fx = sx - x0;
        const double fy = sy - yy0;
        std::array<const std::uint8_t*, 4> tap{};
        std::array<double, 4> wt{};
        for (int j = 0; j <= 1; ++j) {
          for (int i = 0; i <= 1; ++i) {
            const double px = x0 + i;
            const double py = yy0 + j;
            const auto k = static_cast<std::size_t>(j * 2 + i);
            if (px < 0 || px >= w || py < 0 || py >= h) {
              tap[k] = nullptr;
              continue;
            }
            tap[k] = src.data() + idx4(static_cast<int>(px), static_cast<int>(py), w);
            wt[k] = (i != 0 ? fx : 1 - fx) * (j != 0 ? fy : 1 - fy);
          }
        }
        for (std::size_t c = 0; c < 4; ++c) {
          double acc = 0;
          for (std::size_t k = 0; k < 4; ++k) {
            if (tap[k] != nullptr) acc += tap[k][c] * wt[k];
          }
          o[c] = u8c(acc);
        }
      }
    }
  });
}

double radial_falloff(double dist, double radius) {
  if (radius <= 0 || dist >= radius) return 0;
  const double t = 1 - dist / radius;
  return t * t * (3 - 2 * t);
}

using Mat3 = std::array<double, 9>;

std::optional<Mat3> square_to_quad(double x0, double y0, double x1, double y1, double x2, double y2, double x3,
                                   double y3) {
  const double dx1 = x1 - x2;
  const double dx2 = x3 - x2;
  const double dx3 = x0 - x1 + x2 - x3;
  const double dy1 = y1 - y2;
  const double dy2 = y3 - y2;
  const double dy3 = y0 - y1 + y2 - y3;
  const double den = dx1 * dy2 - dx2 * dy1;
  if (std::fabs(den) < 1e-9) return std::nullopt;
  const double g = (dx3 * dy2 - dx2 * dy3) / den;
  const double hh = (dx1 * dy3 - dx3 * dy1) / den;
  return Mat3{x1 - x0 + g * x1, x3 - x0 + hh * x3, x0, y1 - y0 + g * y1, y3 - y0 + hh * y3, y0, g, hh, 1};
}

std::optional<Mat3> invert3(const Mat3& m) {
  const auto [a, b, c, d, e, f, g, h, i] = m;
  const double A = e * i - f * h;
  const double B = f * g - d * i;
  const double C = d * h - e * g;
  const double det = a * A + b * B + c * C;
  if (std::fabs(det) < 1e-12) return std::nullopt;
  const double s = 1 / det;
  return Mat3{A * s, (c * h - b * i) * s, (b * f - c * e) * s, B * s, (a * i - c * g) * s,
              (c * d - a * f) * s, C * s, (b * g - a * h) * s, (a * e - b * d) * s};
}

}  // namespace

void bulge(RgbaView img, double cx, double cy, double radius, double height, ThreadPool* pool) {
  const double amount = height / 100;
  if (amount == 0 || radius <= 0) return;
  remap(img, pool, [&](double dx, double dy) -> std::optional<Pt> {
    const double vx = dx - cx;
    const double vy = dy - cy;
    const double f = radial_falloff(hypot2(vx, vy), radius);
    if (f == 0) return Pt{dx, dy};
    const double scale = 1 - amount * f;
    return Pt{cx + vx * scale, cy + vy * scale};
  });
}

void spherize(RgbaView img, double cx, double cy, double radius, double amount_pct, ThreadPool* pool) {
  const double amount = amount_pct / 100;
  if (amount == 0 || radius <= 0) return;
  remap(img, pool, [&](double dx, double dy) -> std::optional<Pt> {
    const double vx = dx - cx;
    const double vy = dy - cy;
    const double dist = hypot2(vx, vy);
    if (dist >= radius || dist == 0) return Pt{dx, dy};
    const double nr = dist / radius;
    const double bent = (2 / kPi) * js::asin(nr);
    const double scale = 1 + amount * (bent / nr - 1);
    return Pt{cx + vx * scale, cy + vy * scale};
  });
}

void twirl(RgbaView img, double cx, double cy, double radius, double angle_deg, ThreadPool* pool) {
  const double max_angle = (angle_deg * kPi) / 180;
  if (max_angle == 0 || radius <= 0) return;
  remap(img, pool, [&](double dx, double dy) -> std::optional<Pt> {
    const double vx = dx - cx;
    const double vy = dy - cy;
    const double dist = hypot2(vx, vy);
    if (dist >= radius) return Pt{dx, dy};
    const double angle = max_angle * (1 - dist / radius);
    const double cs = js::cos(angle);
    const double sn = js::sin(angle);
    return Pt{cx + vx * cs - vy * sn, cy + vx * sn + vy * cs};
  });
}

void corner_pin(RgbaView img, const std::array<double, 8>& k, ThreadPool* pool) {
  const auto fwd = square_to_quad(k[0], k[1], k[2], k[3], k[4], k[5], k[6], k[7]);
  const auto inv = fwd ? invert3(*fwd) : std::nullopt;
  if (!inv) {
    std::fill(img.data.begin(), img.data.end(), std::uint8_t{0});
    return;
  }
  const auto [a, b, c, d, e, f, g, hh, i] = *inv;
  const double w = img.w;
  const double h = img.h;
  remap(img, pool, [&](double dx, double dy) -> std::optional<Pt> {
    const double den = g * dx + hh * dy + i;
    if (std::fabs(den) < 1e-9) return std::nullopt;
    const double u = (a * dx + b * dy + c) / den;
    const double v = (d * dx + e * dy + f) / den;
    if (u < 0 || u > 1 || v < 0 || v > 1) return std::nullopt;
    return Pt{u * w, v * h};
  });
}

void polar_coordinates(RgbaView img, double interpolation, bool polar_to_rect, ThreadPool* pool) {
  const double t = clampd(interpolation / 100, 0, 1);
  if (t <= 0) return;
  const double w = img.w;
  const double h = img.h;
  const double cx = w / 2;
  const double cy = h / 2;
  const double max_r = hypot2(cx, cy);
  const double tau = kPi * 2;
  remap(img, pool, [&](double dx, double dy) -> std::optional<Pt> {
    double sx = 0;
    double sy = 0;
    if (!polar_to_rect) {
      const double vx = dx - cx;
      const double vy = dy - cy;
      const double r = hypot2(vx, vy);
      double a = js::atan2(vx, -vy) / tau;
      if (a < 0) a += 1;
      sx = a * w;
      sy = (r / max_r) * h;
    } else {
      const double a = (dx / w) * tau;
      const double r = (dy / h) * max_r;
      sx = cx + r * js::sin(a);
      sy = cy - r * js::cos(a);
    }
    if (t < 1) {
      sx = dx + (sx - dx) * t;
      sy = dy + (sy - dy) * t;
    }
    return Pt{sx, sy};
  });
}

void mirror(RgbaView img, double cx, double cy, double angle_deg, ThreadPool* pool) {
  const double rad = (angle_deg * kPi) / 180;
  const double nx = js::cos(rad);
  const double ny = js::sin(rad);
  remap(img, pool, [&](double dx, double dy) -> std::optional<Pt> {
    const double d = (dx - cx) * nx + (dy - cy) * ny;
    if (d <= 0) return Pt{dx, dy};
    return Pt{dx - 2 * d * nx, dy - 2 * d * ny};
  });
}

void offset(RgbaView img, double shift_x, double shift_y, double blend, ThreadPool* pool) {
  const double keep = clampd(blend / 100, 0, 1);
  const int w = img.w;
  const int h = img.h;
  if (keep >= 1 || w <= 0 || h <= 0) return;
  const double tx = shift_x - w / 2.0;
  const double ty = shift_y - h / 2.0;
  const auto wrap = [](double v, double n) { return std::fmod(std::fmod(v, n) + n, n); };
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int ya, int yb) {
    for (int dy = ya; dy < yb; ++dy) {
      for (int dx = 0; dx < w; ++dx) {
        const std::size_t di = idx4(dx, dy, w);
        const double sx = wrap(dx + 0.5 - tx, w) - 0.5;
        const double sy = wrap(dy + 0.5 - ty, h) - 0.5;
        const double x0 = floor_fast(sx);
        const double yy0 = floor_fast(sy);
        const double fx = sx - x0;
        const double fy = sy - yy0;
        std::array<std::size_t, 4> at{};
        std::array<double, 4> wt{};
        for (int j = 0; j <= 1; ++j) {
          for (int i = 0; i <= 1; ++i) {
            const auto k = static_cast<std::size_t>(j * 2 + i);
            at[k] = idx4(static_cast<int>(wrap(x0 + i, w)), static_cast<int>(wrap(yy0 + j, h)), w);
            wt[k] = (i != 0 ? fx : 1 - fx) * (j != 0 ? fy : 1 - fy);
          }
        }
        for (std::size_t c = 0; c < 4; ++c) {
          double acc = 0;
          for (std::size_t k = 0; k < 4; ++k) acc += src[at[k] + c] * wt[k];
          out[di + c] = u8c(keep <= 0 ? acc : acc + (src[di + c] - acc) * keep);
        }
      }
    }
  });
}

void optics_compensation(RgbaView img, double field_of_view, bool reverse, double center_x, double center_y,
                         ThreadPool* pool) {
  const double fov = clampd(field_of_view, 0, 180);
  if (fov <= 0) return;
  const double w = img.w;
  const double h = img.h;
  const double cx = w / 2 + center_x;
  const double cy = h / 2 + center_y;
  double norm = hypot2(w / 2, h / 2);
  if (norm == 0 || std::isnan(norm)) norm = 1;  // `|| 1`
  const double k = js::tan((fov * kPi) / 360) * 0.5;
  remap(img, pool, [&](double dx, double dy) -> std::optional<Pt> {
    const double vx = dx - cx;
    const double vy = dy - cy;
    const double r = hypot2(vx, vy) / norm;
    if (r == 0) return Pt{dx, dy};
    double scale = 0;
    if (reverse) {
      scale = 1 / (1 + k * r * r);
    } else {
      const double disc = 1 - 4 * r * r * k;
      scale = disc <= 0 ? 1 / (2 * r * r * k) : (1 - std::sqrt(disc)) / (2 * r * r * k);
    }
    return Pt{cx + vx * scale, cy + vy * scale};
  });
}

void mesh_warp(RgbaView img, const std::array<Pt2, 16>& offsets, ThreadPool* pool) {
  constexpr int n = 4;  // MESH_WARP_N
  if (std::all_of(offsets.begin(), offsets.end(), [](const Pt2& o) { return o.x == 0 && o.y == 0; })) return;
  const double step_x = img.w / static_cast<double>(n - 1);
  const double step_y = img.h / static_cast<double>(n - 1);
  remap(img, pool, [&](double dx, double dy) -> std::optional<Pt> {
    const int gx = static_cast<int>(std::min(static_cast<double>(n - 2), std::max(0.0, std::floor(dx / step_x))));
    const int gy = static_cast<int>(std::min(static_cast<double>(n - 2), std::max(0.0, std::floor(dy / step_y))));
    const double tx = clampd((dx - gx * step_x) / step_x, 0, 1);
    const double ty = clampd((dy - gy * step_y) / step_y, 0, 1);
    const auto at = [&](int ix, int iy) -> const Pt2& { return offsets[static_cast<std::size_t>(iy * n + ix)]; };
    const Pt2& o00 = at(gx, gy);
    const Pt2& o10 = at(gx + 1, gy);
    const Pt2& o01 = at(gx, gy + 1);
    const Pt2& o11 = at(gx + 1, gy + 1);
    const double top_x = o00.x + (o10.x - o00.x) * tx;
    const double top_y = o00.y + (o10.y - o00.y) * tx;
    const double bot_x = o01.x + (o11.x - o01.x) * tx;
    const double bot_y = o01.y + (o11.y - o01.y) * tx;
    const double ox = top_x + (bot_x - top_x) * ty;
    const double oy = top_y + (bot_y - top_y) * ty;
    return Pt{dx - ox, dy - oy};
  });
}

void liquify(RgbaView img, double cx, double cy, double radius, double push_x, double push_y, double twirl_deg,
             double pinch_pct, ThreadPool* pool) {
  const double twirl_rad = (twirl_deg * kPi) / 180;
  const double pinch = pinch_pct / 100;
  if (radius <= 0 || (push_x == 0 && push_y == 0 && twirl_rad == 0 && pinch == 0)) return;
  remap(img, pool, [&](double dx, double dy) -> std::optional<Pt> {
    const double vx = dx - cx;
    const double vy = dy - cy;
    const double f = radial_falloff(hypot2(vx, vy), radius);
    if (f == 0) return Pt{dx, dy};
    double sx = dx - push_x * f;
    double sy = dy - push_y * f;
    if (twirl_rad != 0 || pinch != 0) {
      const double rx = sx - cx;
      const double ry = sy - cy;
      const double angle = -twirl_rad * f;
      const double cs = js::cos(angle);
      const double sn = js::sin(angle);
      const double scale = 1 + pinch * f;
      sx = cx + (rx * cs - ry * sn) * scale;
      sy = cy + (rx * sn + ry * cs) * scale;
    }
    return Pt{sx, sy};
  });
}

}  // namespace premation::effects
