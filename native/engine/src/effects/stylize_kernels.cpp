// Ports of src/core/effects/stylize.ts (mosaicData, findEdgesData, embossData)
// and colorEffects.ts `vibranceData`.
#include <algorithm>
#include <array>
#include <vector>

#include "kernels.hpp"

namespace premation::effects {

// ── mosaicData ──────────────────────────────────────────────────────────────
//
// Every cell reads and writes only its own pixels, so this runs in place.

void mosaic(RgbaView img, double h_blocks, double v_blocks, bool sharp_colors, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  if (w <= 0 || h <= 0) return;
  const int cols = static_cast<int>(std::max(1.0, std::min(static_cast<double>(w), js::round(h_blocks))));
  const int rows = static_cast<int>(std::max(1.0, std::min(static_cast<double>(h), js::round(v_blocks))));
  std::uint8_t* d = img.data.data();
  const auto lo = [](int b, int size, int count) {
    return static_cast<int>((static_cast<std::int64_t>(b) * size) / count);
  };
  for_rows(
      pool, rows,
      [&](int b0, int b1) {
        for (int by = b0; by < b1; ++by) {
          const int y0 = lo(by, h, rows);
          const int y1 = lo(by + 1, h, rows);
          for (int bx = 0; bx < cols; ++bx) {
            const int x0 = lo(bx, w, cols);
            const int x1 = lo(bx + 1, w, cols);
            double r = 0;
            double g = 0;
            double b = 0;
            double a = 0;
            if (sharp_colors) {
              const int cx = std::min(w - 1, (x0 + x1) >> 1);
              const int cy = std::min(h - 1, (y0 + y1) >> 1);
              const std::uint8_t* p = d + idx4(cx, cy, w);
              r = p[0];
              g = p[1];
              b = p[2];
              a = p[3];
            } else {
              double n = 0;
              for (int y = y0; y < y1; ++y) {
                for (int x = x0; x < x1; ++x) {
                  const std::uint8_t* p = d + idx4(x, y, w);
                  const double sa = p[3];
                  r += p[0] * sa;
                  g += p[1] * sa;
                  b += p[2] * sa;
                  a += sa;
                  n += 1;
                }
              }
              if (n == 0) continue;
              if (a > 0) {
                r /= a;
                g /= a;
                b /= a;
              } else {
                r = g = b = 0;
              }
              a /= n;
            }
            const std::array<std::uint8_t, 4> px{u8c(r), u8c(g), u8c(b), u8c(a)};
            for (int y = y0; y < y1; ++y) {
              for (int x = x0; x < x1; ++x) {
                std::uint8_t* p = d + idx4(x, y, w);
                p[0] = px[0];
                p[1] = px[1];
                p[2] = px[2];
                p[3] = px[3];
              }
            }
          }
        }
      },
      1);
}

// ── findEdgesData / embossData ──────────────────────────────────────────────
//
// Both read the Rec. 601 luma of neighbours; the luma of a pixel is a pure
// function of its bytes, so it is computed once into a plane (the same double
// the TS recomputes at every tap).

namespace {

std::vector<double> luma_plane(const RgbaView& img, ThreadPool* pool) {
  std::vector<double> lum(img.pixels());
  const std::uint8_t* s = img.data.data();
  const int w = img.w;
  for_rows(pool, img.h, [&](int y0, int y1) {
    const std::size_t e = static_cast<std::size_t>(y1) * static_cast<std::size_t>(w);
    for (std::size_t i = static_cast<std::size_t>(y0) * static_cast<std::size_t>(w); i < e; ++i) {
      lum[i] = luma601(s[i * 4], s[i * 4 + 1], s[i * 4 + 2]);
    }
  });
  return lum;
}

}  // namespace

void find_edges(RgbaView img, bool invert, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  if (w <= 0 || h <= 0) return;
  const std::vector<double> lum = luma_plane(img, pool);
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      const std::size_t ru = static_cast<std::size_t>(std::max(0, y - 1)) * static_cast<std::size_t>(w);
      const std::size_t rc = static_cast<std::size_t>(y) * static_cast<std::size_t>(w);
      const std::size_t rd = static_cast<std::size_t>(std::min(h - 1, y + 1)) * static_cast<std::size_t>(w);
      for (int x = 0; x < w; ++x) {
        const auto xl = static_cast<std::size_t>(std::max(0, x - 1));
        const auto xc = static_cast<std::size_t>(x);
        const auto xr = static_cast<std::size_t>(std::min(w - 1, x + 1));
        const double gx = -lum[ru + xl] + lum[ru + xr] + -2 * lum[rc + xl] + 2 * lum[rc + xr] + -lum[rd + xl] + lum[rd + xr];
        const double gy = -lum[ru + xl] - 2 * lum[ru + xc] - lum[ru + xr] + lum[rd + xl] + 2 * lum[rd + xc] + lum[rd + xr];
        const std::array<double, 2> v2{gx, gy};
        const double mag = std::min(255.0, js::hypot(v2));
        const double v = invert ? 255 - mag : mag;
        std::uint8_t* p = out + (rc + xc) * 4;
        const std::uint8_t b = u8c(v);
        p[0] = b;
        p[1] = b;
        p[2] = b;
        // alpha carried through untouched (already in place)
      }
    }
  });
}

void emboss(RgbaView img, double angle_deg, double relief, double contrast, double blend, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  if (w <= 0 || h <= 0) return;
  const double keep = blend <= 0 ? 0 : blend >= 100 ? 1 : blend / 100;
  const double k = contrast / 100;
  const double rad = (angle_deg * 3.141592653589793) / 180;
  const double dx = js::cos(rad) * relief;
  const double dy = js::sin(rad) * relief;
  const std::vector<double> lum = luma_plane(img, pool);
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  const auto at = [&](double x, double y) {
    const double sx = std::min(static_cast<double>(w - 1), std::max(0.0, round_index(x)));
    const double sy = std::min(static_cast<double>(h - 1), std::max(0.0, round_index(y)));
    return lum[static_cast<std::size_t>(sy) * static_cast<std::size_t>(w) + static_cast<std::size_t>(sx)];
  };
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        const std::size_t o = idx4(x, y, w);
        const double d = at(x + dx, y + dy) - at(x - dx, y - dy);
        const double v = std::max(0.0, std::min(255.0, 128 + d * k));
        out[o] = u8c(v + (src[o] - v) * keep);
        out[o + 1] = u8c(v + (src[o + 1] - v) * keep);
        out[o + 2] = u8c(v + (src[o + 2] - v) * keep);
      }
    }
  });
}

// ── vibranceData ────────────────────────────────────────────────────────────

void vibrance(RgbaView img, double vibrance_in, double saturation, ThreadPool* pool) {
  const double vib = vibrance_in / 100;
  const double sat = saturation / 100;
  if (vib == 0 && sat == 0) return;
  std::uint8_t* data = img.data.data();
  const int w = img.w;
  for_rows(pool, img.h, [&](int y0, int y1) {
    const std::size_t e = static_cast<std::size_t>(y1) * static_cast<std::size_t>(w) * 4;
    for (std::size_t i = static_cast<std::size_t>(y0) * static_cast<std::size_t>(w) * 4; i < e; i += 4) {
      if (data[i + 3] == 0) continue;
      const double r = data[i];
      const double g = data[i + 1];
      const double b = data[i + 2];
      const double l = luma601(r, g, b);
      const double mx = std::max(r, std::max(g, b));
      const double mn = std::min(r, std::min(g, b));
      const double current = mx == 0 ? 0 : (mx - mn) / 255;
      const double amount = 1 + sat + vib * (1 - current);
      data[i] = u8c(l + (r - l) * amount);
      data[i + 1] = u8c(l + (g - l) * amount);
      data[i + 2] = u8c(l + (b - l) * amount);
    }
  });
}

}  // namespace premation::effects
