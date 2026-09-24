// Ports of src/core/effects/warp.ts (Wave Warp, Turbulent Displace, Curl
// Noise) and stylize.ts (Roughen Edges, Scatter) — displacement resamples and
// noise bites, each with the TS's own hash (they differ, and each is JS double
// arithmetic with ToInt32 / ToUint32 at the bit operators).
#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <vector>

#include "kernels.hpp"

namespace premation::effects {

namespace {

constexpr double kPi = 3.141592653589793;

double clampd(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }

/// warp.ts `bilinear`: clamp the point into the layer, straight bilinear.
inline void bilinear(const std::uint8_t* src, int w, int h, double x, double y, std::uint8_t* out) {
  const double cx = clampd(x, 0, w - 1);
  const double cy = clampd(y, 0, h - 1);
  const double x0 = floor_fast(cx);
  const double y0 = floor_fast(cy);
  const double x1 = std::min(static_cast<double>(w - 1), x0 + 1);
  const double y1 = std::min(static_cast<double>(h - 1), y0 + 1);
  const double fx = cx - x0;
  const double fy = cy - y0;
  const std::uint8_t* p00 = src + idx4(static_cast<int>(x0), static_cast<int>(y0), w);
  const std::uint8_t* p10 = src + idx4(static_cast<int>(x1), static_cast<int>(y0), w);
  const std::uint8_t* p01 = src + idx4(static_cast<int>(x0), static_cast<int>(y1), w);
  const std::uint8_t* p11 = src + idx4(static_cast<int>(x1), static_cast<int>(y1), w);
  for (std::size_t c = 0; c < 4; ++c) {
    const double top = p00[c] + (p10[c] - p00[c]) * fx;
    const double bot = p01[c] + (p11[c] - p01[c]) * fx;
    out[c] = u8c(top + (bot - top) * fy);
  }
}

/// warp.ts `hash01`: `(x|0)·C1 + (y|0)·C2 + (seed|0)·C3` (exact in a double
/// for pixel-scale inputs), `n ^ (n >>> 13)`, a JS multiply that rounds, then
/// `n ^ (n >>> 16)`, `>>> 0`.
inline double hash01_warp(double x, double y, double seed) {
  const double n = static_cast<double>(ji32(x)) * 374761393.0 + static_cast<double>(ji32(y)) * 668265263.0 +
                   static_cast<double>(ji32(seed)) * 2147483647.0;
  const std::uint32_t u = ju32(n);
  const auto t = static_cast<std::int32_t>(u ^ (u >> 13U));
  const std::uint32_t m = ju32(static_cast<double>(static_cast<std::int64_t>(t) * 1274126177LL));
  return static_cast<double>(m ^ (m >> 16U)) / 4294967296.0;
}

inline double smooth(double t) { return t * t * (3 - 2 * t); }

/// stylize.ts `valueNoise` hash — `>>` (arithmetic) where warp.ts has `>>>`,
/// a seed term of ~1.4e18 (the sum rounds), and / (2^32 − 1).
inline double hash_stylize(double a, double b, double seed) {
  const double n = a * 374761393.0 + b * 668265263.0 + seed * 1442695040888963328.0;
  const std::int32_t i = ji32(n);
  const std::int32_t t = i ^ (i >> 13);
  const std::int32_t m = ji32(static_cast<double>(static_cast<std::int64_t>(t) * 1274126177LL));
  return static_cast<double>(static_cast<std::uint32_t>(m ^ (m >> 16))) / 4294967295.0;
}

inline double value_noise_stylize(double x, double y, double seed) {
  const double xi = floor_fast(x);
  const double yi = floor_fast(y);
  const double xf = x - xi;
  const double yf = y - yi;
  const double u = xf * xf * (3 - 2 * xf);
  const double v = yf * yf * (3 - 2 * yf);
  const double n00 = hash_stylize(xi, yi, seed);
  const double n10 = hash_stylize(xi + 1, yi, seed);
  const double n01 = hash_stylize(xi, yi + 1, seed);
  const double n11 = hash_stylize(xi + 1, yi + 1, seed);
  return (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v;
}

}  // namespace

void wave_warp(RgbaView img, double wave_height, double wave_width, double direction_deg, double phase_deg,
               ThreadPool* pool) {
  if (wave_height == 0 || wave_width <= 0) return;
  const int w = img.w;
  const int h = img.h;
  const double dir = (direction_deg * kPi) / 180;
  const double dx = js::cos(dir);
  const double dy = js::sin(dir);
  const double px = -dy;
  const double py = dx;
  const double k = (kPi * 2) / wave_width;
  const double phase = (phase_deg * kPi) / 180;
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        const double along = x * px + y * py;
        const double disp = js::sin(along * k + phase) * wave_height;
        bilinear(src.data(), w, h, x - dx * disp, y - dy * disp, out + idx4(x, y, w));
      }
    }
  });
}

namespace {

/// warp.ts `fbm(X, Y, seed, octaves)` (octaves of `valueNoise2`, seed + i·101,
/// amplitude halving) along one row: Y is fixed, X only grows, so
/// each octave's lattice row (yi, fy) is computed once per row and the four
/// corner hashes are reused while X stays in the same lattice cell. The
/// arithmetic per sample is `fbm`'s own, in its order; only repeated hash
/// evaluations of the same integer corner are skipped.
class FbmRow {
 public:
  FbmRow(double y, double seed, double octaves) : seed_(seed) {
    n_ = static_cast<int>(clampd(std::floor(octaves), 1, 6));
    double freq = 1;
    for (int i = 0; i < n_; ++i) {
      Oct& o = oct_[static_cast<std::size_t>(i)];
      const double yv = y * freq;
      o.yi = floor_fast(yv);
      o.fy = smooth(yv - o.yi);
      o.seed = seed_ + i * 101;
      freq *= 2;
    }
  }
  double at(double x) {
    double total = 0;
    double amp = 1;
    double freq = 1;
    double max_a = 0;
    for (int i = 0; i < n_; ++i) {
      Oct& o = oct_[static_cast<std::size_t>(i)];
      const double xv = x * freq;
      const double xi = floor_fast(xv);
      const double fx = smooth(xv - xi);
      if (!(xi == o.xi)) {
        o.xi = xi;
        o.a = hash01_warp(xi, o.yi, o.seed);
        o.b = hash01_warp(xi + 1, o.yi, o.seed);
        o.c = hash01_warp(xi, o.yi + 1, o.seed);
        o.d = hash01_warp(xi + 1, o.yi + 1, o.seed);
      }
      const double top = o.a + (o.b - o.a) * fx;
      const double bot = o.c + (o.d - o.c) * fx;
      total += ((top + (bot - top) * o.fy) * 2 - 1) * amp;
      max_a += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return total / max_a;
  }

 private:
  struct Oct {
    double yi = 0, fy = 0, seed = 0;
    double xi = std::numeric_limits<double>::quiet_NaN();
    double a = 0, b = 0, c = 0, d = 0;
  };
  double seed_;
  int n_ = 1;
  std::array<Oct, 6> oct_{};
};

}  // namespace

void turbulent_displace(RgbaView img, double amount, double size, double complexity, double evolution,
                        ThreadPool* pool) {
  if (amount == 0 || size <= 0) return;
  const int w = img.w;
  const int h = img.h;
  const double inv = 1 / size;
  const double ev = evolution * 0.01;
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      FbmRow fx_noise(y * inv, 7, complexity);
      FbmRow fy_noise(y * inv + ev, 131, complexity);
      for (int x = 0; x < w; ++x) {
        const double nx = fx_noise.at(x * inv + ev) * amount;
        const double ny = fy_noise.at(x * inv) * amount;
        bilinear(src.data(), w, h, x - nx, y - ny, out + idx4(x, y, w));
      }
    }
  });
}

void curl_noise(RgbaView img, double amount, double size, double complexity, double evolution, ThreadPool* pool) {
  if (amount == 0 || size <= 0) return;
  const int w = img.w;
  const int h = img.h;
  const double inv = 1 / size;
  const double ev = evolution * 0.01;
  const double k = amount * size * 0.5;
  // ψ on the (w+2)×(h+2) lattice around the layer, once: the TS evaluates it
  // four times per pixel at these same integer points.
  const int pw = w + 2;
  std::vector<double> psi(static_cast<std::size_t>(pw) * static_cast<std::size_t>(h + 2));
  for_rows(pool, h + 2, [&](int r0, int r1) {
    for (int r = r0; r < r1; ++r) {
      const int y = r - 1;
      FbmRow row(y * inv - ev, 53, complexity);
      for (int c = 0; c < pw; ++c) {
        const int x = c - 1;
        psi[static_cast<std::size_t>(r) * static_cast<std::size_t>(pw) + static_cast<std::size_t>(c)] =
            row.at(x * inv + ev);
      }
    }
  });
  const auto at = [&](int x, int y) {
    return psi[static_cast<std::size_t>(y + 1) * static_cast<std::size_t>(pw) + static_cast<std::size_t>(x + 1)];
  };
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        const double dpdx = at(x + 1, y) - at(x - 1, y);
        const double dpdy = at(x, y + 1) - at(x, y - 1);
        // curlNoiseField is a Float32Array.
        const auto fx = static_cast<double>(static_cast<float>(dpdy * k));
        const auto fy = static_cast<double>(static_cast<float>(-dpdx * k));
        bilinear(src.data(), w, h, x - fx, y - fy, out + idx4(x, y, w));
      }
    }
  });
}

void roughen_edges(RgbaView img, double border, double scale, double complexity, double evolution, double seed,
                   double edge_sharpness, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  if (border <= 0 || w <= 0 || h <= 0) return;
  const int octaves = static_cast<int>(std::max(1.0, std::min(6.0, js::round(complexity))));
  const double freq = 1 / std::max(1.0, (scale / 100) * 20);
  const double evo = evolution / 60;
  const double sharp = std::max(0.0, edge_sharpness);
  std::uint8_t* data = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        std::uint8_t* p = data + idx4(x, y, w);
        const double a = p[3];
        if (a != 0) {
          double n = 0;
          double amp = 1;
          double f = freq;
          double norm = 0;
          for (int i = 0; i < octaves; ++i) {
            n += value_noise_stylize(x * f + evo, y * f + evo, seed + i * 101) * amp;
            norm += amp;
            amp *= 0.5;
            f *= 2;
          }
          n /= norm != 0 ? norm : 1;
          const double bite = n * border * (255 / std::max(1.0, border));
          p[3] = u8c(std::max(0.0, a - bite));
        }
        // applyRoughenEdges' Edge Sharpness, over every pixel of the result.
        if (sharp > 0) {
          const double an = p[3] / 255.0;
          p[3] = u8c(js::round(255 * std::min(1.0, std::max(0.0, (an - 0.5) * (1 + sharp * 2) + 0.5))));
        }
      }
    }
  });
}

void scatter(RgbaView img, double amount, double grain, double seed, double evolution, ThreadPool* pool) {
  const double radius = std::max(0.0, amount);
  if (radius == 0) return;
  const int g = grain >= 2 ? 2 : grain >= 1 ? 1 : 0;  // both, horizontal, vertical
  const int w = img.w;
  const int h = img.h;
  const auto hash = [&](double x, double y, double salt) {
    const double n = x * 374761393.0 + y * 668265263.0 + seed * 1442695040888963328.0 + salt * 2246822519.0 +
                     evolution * 3266489917.0;
    const std::int32_t i = ji32(n);
    const std::int32_t t = i ^ (i >> 13);
    const std::int32_t m = ji32(static_cast<double>(static_cast<std::int64_t>(t) * 1274126177LL));
    return static_cast<double>(static_cast<std::uint32_t>(m ^ (m >> 16))) / 4294967295.0;
  };
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        const double ox = g == 2 ? 0 : (hash(x, y, 1) - 0.5) * 2 * radius;
        const double oy = g == 1 ? 0 : (hash(x, y, 2) - 0.5) * 2 * radius;
        const double sx = std::min(static_cast<double>(w - 1), std::max(0.0, round_index(x + ox)));
        const double sy = std::min(static_cast<double>(h - 1), std::max(0.0, round_index(y + oy)));
        const std::uint8_t* s = src.data() + idx4(static_cast<int>(sx), static_cast<int>(sy), w);
        std::uint8_t* o = out + idx4(x, y, w);
        o[0] = s[0];
        o[1] = s[1];
        o[2] = s[2];
        o[3] = s[3];
      }
    }
  });
}

}  // namespace premation::effects
