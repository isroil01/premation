// Ports of three single-kernel TS modules:
//   bezierWarp.ts       Bezier Warp — Coons patch, inverted per pixel by Newton
//   generatePatterns.ts Cell Pattern — Worley F1 / F2 − F1
//   cubeLut.ts          Apply Color LUT — `.cube` 1D / 3D trilinear sampling
// All three are per output pixel, so rows split freely.
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

double hyp(double a, double b) { return jhypot2(a, b); }

// ── bezierWarp.ts ───────────────────────────────────────────────────────────

double bez(double a, double b, double c, double d, double t) {
  const double s = 1 - t;
  return s * s * s * a + 3 * s * s * t * b + 3 * s * t * t * c + t * t * t * d;
}

double bez_d(double a, double b, double c, double d, double t) {
  const double s = 1 - t;
  return 3 * s * s * (b - a) + 6 * s * t * (c - b) + 3 * t * t * (d - c);
}

Pt2 curve(const Pt2& p0, const Pt2& p1, const Pt2& p2, const Pt2& p3, double t) {
  return Pt2{bez(p0.x, p1.x, p2.x, p3.x, t), bez(p0.y, p1.y, p2.y, p3.y, t)};
}

Pt2 curve_d(const Pt2& p0, const Pt2& p1, const Pt2& p2, const Pt2& p3, double t) {
  return Pt2{bez_d(p0.x, p1.x, p2.x, p3.x, t), bez_d(p0.y, p1.y, p2.y, p3.y, t)};
}

/// `coonsPoint(p, u, v)`.
Pt2 coons_point(const std::array<Pt2, 12>& p, double u, double v) {
  const auto& [tl, t1, t2, tr, r1, r2, br, b1, b2, bl, l1, l2] = p;
  const Pt2 top = curve(tl, t1, t2, tr, u);
  const Pt2 right = curve(tr, r1, r2, br, v);
  const Pt2 bot = curve(br, b1, b2, bl, 1 - u);
  const Pt2 left = curve(bl, l1, l2, tl, 1 - v);
  const double bx = (1 - u) * (1 - v) * tl.x + u * (1 - v) * tr.x + u * v * br.x + (1 - u) * v * bl.x;
  const double by = (1 - u) * (1 - v) * tl.y + u * (1 - v) * tr.y + u * v * br.y + (1 - u) * v * bl.y;
  return Pt2{(1 - v) * top.x + v * bot.x + (1 - u) * left.x + u * right.x - bx,
             (1 - v) * top.y + v * bot.y + (1 - u) * left.y + u * right.y - by};
}

/// `coonsJacobian(p, u, v)` → {du, dv}.
std::array<Pt2, 2> coons_jacobian(const std::array<Pt2, 12>& p, double u, double v) {
  const auto& [tl, t1, t2, tr, r1, r2, br, b1, b2, bl, l1, l2] = p;
  const Pt2 top = curve(tl, t1, t2, tr, u);
  const Pt2 top_d = curve_d(tl, t1, t2, tr, u);
  const Pt2 right = curve(tr, r1, r2, br, v);
  const Pt2 right_d = curve_d(tr, r1, r2, br, v);
  const Pt2 bot = curve(br, b1, b2, bl, 1 - u);
  const Pt2 bot_d = curve_d(br, b1, b2, bl, 1 - u);
  const Pt2 left = curve(bl, l1, l2, tl, 1 - v);
  const Pt2 left_d = curve_d(bl, l1, l2, tl, 1 - v);
  const Pt2 du{(1 - v) * top_d.x - v * bot_d.x - left.x + right.x -
                   ((v - 1) * tl.x + (1 - v) * tr.x + v * br.x - v * bl.x),
               (1 - v) * top_d.y - v * bot_d.y - left.y + right.y -
                   ((v - 1) * tl.y + (1 - v) * tr.y + v * br.y - v * bl.y)};
  const Pt2 dv{bot.x - top.x - (1 - u) * left_d.x + u * right_d.x -
                   ((u - 1) * tl.x - u * tr.x + u * br.x + (1 - u) * bl.x),
               bot.y - top.y - (1 - u) * left_d.y + u * right_d.y -
                   ((u - 1) * tl.y - u * tr.y + u * br.y + (1 - u) * bl.y)};
  return {du, dv};
}

constexpr double kUvSlack = 1e-4;

/// `solveUV(p, target, w, h)`.
std::optional<Pt2> solve_uv(const std::array<Pt2, 12>& p, Pt2 target, double w, double h) {
  double u = w > 0 ? target.x / w : 0;
  double v = h > 0 ? target.y / h : 0;
  for (int i = 0; i < 24; ++i) {
    const Pt2 s = coons_point(p, u, v);
    const double ex = s.x - target.x;
    const double ey = s.y - target.y;
    if (ex * ex + ey * ey < 1e-8) break;
    const auto [du, dv] = coons_jacobian(p, u, v);
    const double det = du.x * dv.y - dv.x * du.y;
    if (std::fabs(det) < 1e-12) return std::nullopt;
    u -= (dv.y * ex - dv.x * ey) / det;
    v -= (du.x * ey - du.y * ex) / det;
    if (!std::isfinite(u) || !std::isfinite(v)) return std::nullopt;
    if (u < -1) {
      u = -1;
    } else if (u > 2) {
      u = 2;
    }
    if (v < -1) {
      v = -1;
    } else if (v > 2) {
      v = 2;
    }
  }
  const Pt2 f = coons_point(p, u, v);
  if (js::pow(f.x - target.x, 2) + js::pow(f.y - target.y, 2) > 0.25) return std::nullopt;
  if (u < -kUvSlack || u > 1 + kUvSlack || v < -kUvSlack || v > 1 + kUvSlack) return std::nullopt;
  return Pt2{u, v};
}

// ── cubeLut.ts ──────────────────────────────────────────────────────────────

struct Lut {
  int size = 0;
  int size1d = 0;
  std::vector<float> data;
  std::array<double, 3> dmin{0, 0, 0};
  std::array<double, 3> dmax{1, 1, 1};
};

double to_domain(double v, const Lut& lut, std::size_t i) {
  return clamp01_lang((v - lut.dmin[i]) / (lut.dmax[i] - lut.dmin[i]));
}

/// `sampleCubeLut(lut, r, g, b, out)`.
void sample_lut(const Lut& lut, double r, double g, double b, std::array<double, 3>& out) {
  if (lut.size1d > 0) {
    const double n = lut.size1d - 1;
    const auto ch = [&](double v, std::size_t i) {
      const double x = to_domain(v, lut, i) * n;
      const double lo = std::floor(x);
      const double hi = std::min(lo + 1, n);
      const double f = x - lo;
      const double a = lut.data[static_cast<std::size_t>(lo) * 3 + i];
      const double c = lut.data[static_cast<std::size_t>(hi) * 3 + i];
      return a + (c - a) * f;
    };
    out[0] = ch(r, 0);
    out[1] = ch(g, 1);
    out[2] = ch(b, 2);
    return;
  }
  const double n = lut.size - 1;
  const double x = to_domain(r, lut, 0) * n;
  const double y = to_domain(g, lut, 1) * n;
  const double z = to_domain(b, lut, 2) * n;
  const double x0 = std::floor(x);
  const double y0 = std::floor(y);
  const double z0 = std::floor(z);
  const double x1 = std::min(x0 + 1, n);
  const double y1 = std::min(y0 + 1, n);
  const double z1 = std::min(z0 + 1, n);
  const double fx = x - x0;
  const double fy = y - y0;
  const double fz = z - z0;
  const auto sz = static_cast<std::size_t>(lut.size);
  const auto at = [&](double xi, double yi, double zi, std::size_t c) -> double {
    return lut.data[(static_cast<std::size_t>(xi) + static_cast<std::size_t>(yi) * sz +
                     static_cast<std::size_t>(zi) * sz * sz) * 3 + c];
  };
  for (std::size_t c = 0; c < 3; ++c) {
    const double c00 = at(x0, y0, z0, c) + (at(x1, y0, z0, c) - at(x0, y0, z0, c)) * fx;
    const double c10 = at(x0, y1, z0, c) + (at(x1, y1, z0, c) - at(x0, y1, z0, c)) * fx;
    const double c01 = at(x0, y0, z1, c) + (at(x1, y0, z1, c) - at(x0, y0, z1, c)) * fx;
    const double c11 = at(x0, y1, z1, c) + (at(x1, y1, z1, c) - at(x0, y1, z1, c)) * fx;
    const double c0 = c00 + (c10 - c00) * fy;
    const double c1 = c01 + (c11 - c01) * fy;
    out[c] = c0 + (c1 - c0) * fz;
  }
}

}  // namespace

void bezier_warp(RgbaView img, const std::array<Pt2, 12>& points, ThreadPool* pool) {
  const double w = img.w;
  const double h = img.h;
  remap_rgba(img, pool, [&](double dx, double dy) -> std::optional<RemapPt> {
    const std::optional<Pt2> uv = solve_uv(points, Pt2{dx, dy}, w, h);
    if (!uv) return std::nullopt;
    return RemapPt{uv->x * w, uv->y * h};
  });
}

std::array<Pt2, 12> bezier_warp_rest(double w, double h) {
  return {Pt2{0, 0},         Pt2{w / 3, 0},     Pt2{(2 * w) / 3, 0}, Pt2{w, 0},
          Pt2{w, h / 3},     Pt2{w, (2 * h) / 3}, Pt2{w, h},         Pt2{(2 * w) / 3, h},
          Pt2{w / 3, h},     Pt2{0, h},         Pt2{0, (2 * h) / 3}, Pt2{0, h / 3}};
}

void cell_pattern(RgbaView img, double size, double evolution, double contrast, bool invert, bool membrane,
                  ThreadPool* pool) {
  const int w = img.w;
  const double cell = std::max(2.0, size);
  const double gain = std::max(0.01, contrast / 100);
  const double e0 = std::floor(evolution);
  const double ef = evolution - e0;
  const std::uint32_t s0 = ju32(e0);
  const std::uint32_t s1 = ju32(e0 + 1);
  const std::uint32_t s17 = ju32(e0 + 17);
  const std::uint32_t s18 = ju32(e0 + 18);
  std::uint8_t* d = img.data.data();
  for_rows(pool, img.h, [&](int y0, int y1) {
    for (int py = y0; py < y1; ++py) {
      const double gy = std::floor(py / cell);
      for (int px = 0; px < w; ++px) {
        std::uint8_t* o = d + idx4(px, py, w);
        if (o[3] == 0) continue;
        const double gx = std::floor(px / cell);
        double f1 = std::numeric_limits<double>::infinity();
        double f2 = f1;
        for (int oy = -1; oy <= 1; ++oy) {
          for (int ox = -1; ox <= 1; ++ox) {
            const double cx = gx + ox;
            const double cy = gy + oy;
            const std::uint32_t ux = ju32(cx);
            const std::uint32_t uy = ju32(cy);
            const double jx = mixd(hash01u(ux, uy, s0), hash01u(ux, uy, s1), ef);
            const double jy = mixd(hash01u(ux, uy, s17), hash01u(ux, uy, s18), ef);
            const double fx = (cx + jx) * cell;
            const double fy = (cy + jy) * cell;
            const double dd = hyp(px - fx, py - fy);
            if (dd < f1) {
              f2 = f1;
              f1 = dd;
            } else if (dd < f2) {
              f2 = dd;
            }
          }
        }
        const double raw = membrane ? (f2 - f1) / cell : f1 / cell;
        double v = std::max(0.0, std::min(1.0, raw * gain));
        if (invert) v = 1 - v;
        const std::uint8_t level = u8c(js::round(v * 255));
        o[0] = level;
        o[1] = level;
        o[2] = level;
      }
    }
  });
}

void apply_color_lut(RgbaView img, double size, double size1d, std::span<const double> data,
                     std::span<const double> domain_min, std::span<const double> domain_max, double intensity,
                     ThreadPool* pool) {
  // fromStoredLut's validation: an unreadable table renders unchanged.
  if (size == 0 && size1d == 0) return;
  if (size > 0 && size1d > 0) return;
  if (size < 0 || size1d < 0) return;  // not a parser output; keeps the indexing defined
  const double expected = size > 0 ? size * size * size * 3 : size1d * 3;
  if (static_cast<double>(data.size()) != expected) return;
  for (const double v : data) {
    if (!std::isfinite(v)) return;
  }
  Lut lut;
  lut.size = static_cast<int>(size);
  lut.size1d = static_cast<int>(size1d);
  lut.data.assign(data.begin(), data.end());  // new Float32Array(o.data)
  for (std::size_t i = 0; i < 3; ++i) {
    if (domain_min.size() == 3) lut.dmin[i] = domain_min[i];
    if (domain_max.size() == 3) lut.dmax[i] = domain_max[i];
    if (!(lut.dmax[i] > lut.dmin[i])) return;
  }
  if (!(intensity > 0)) return;
  const double k = intensity > 1 ? 1 : intensity;
  std::uint8_t* d = img.data.data();
  for_rows(pool, img.h, [&](int y0, int y1) {
    std::array<double, 3> out{};
    const std::size_t e = static_cast<std::size_t>(y1) * static_cast<std::size_t>(img.w) * 4;
    for (std::size_t i = static_cast<std::size_t>(y0) * static_cast<std::size_t>(img.w) * 4; i < e; i += 4) {
      if (d[i + 3] == 0) continue;
      const double r = d[i] / 255.0;
      const double g = d[i + 1] / 255.0;
      const double b = d[i + 2] / 255.0;
      sample_lut(lut, r, g, b, out);
      d[i] = u8c((r + (out[0] - r) * k) * 255);
      d[i + 1] = u8c((g + (out[1] - g) * k) * 255);
      d[i + 2] = u8c((b + (out[2] - b) * k) * 255);
    }
  });
}

}  // namespace premation::effects
