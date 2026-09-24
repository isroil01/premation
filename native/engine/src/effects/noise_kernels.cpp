// Ports of src/core/effects/noiseEffects.ts (turbulentNoiseData, addGrainData,
// medianData) and canvas2dEffects.ts `addNoiseData` (the `noise` effect).
#include <algorithm>
#include <array>
#include <vector>

#include "kernels.hpp"
#include "noise_hash.hpp"
#include "rank_hist.hpp"

namespace premation::effects {

// ── addNoiseData ────────────────────────────────────────────────────────────

namespace {

/// canvas2dEffects.ts `noiseHash` — NOT u32 arithmetic: the products are JS
/// doubles (the last one rounds past 2^53), then ToInt32 / ToUint32 where the
/// TS applies `^` and `>>>`. Reproduced step for step.
double noise_hash(int x, int y, int seed, int ch) noexcept {
  std::int32_t t = 0;
  // Every term below 2^53 (|seed| < 2^21, x and y are pixel indices): the JS
  // doubles are exact integers, so the int64 sum IS the double's value.
  if (seed > -(1 << 21) && seed < (1 << 21)) {
    const std::int64_t s = static_cast<std::int64_t>(x) * 374761393LL + static_cast<std::int64_t>(y) * 668265263LL +
                           static_cast<std::int64_t>(seed) * 2147483647LL + static_cast<std::int64_t>(ch) * 40503LL;
    const auto u = static_cast<std::uint32_t>(static_cast<std::uint64_t>(s));
    t = static_cast<std::int32_t>(u ^ (u >> 13U));
  } else {
    const double n = static_cast<double>(x) * 374761393.0 + static_cast<double>(y) * 668265263.0 +
                     static_cast<double>(seed) * 2147483647.0 + static_cast<double>(ch) * 40503.0;
    t = js::to_int32(n) ^ static_cast<std::int32_t>(js::to_uint32(n) >> 13U);
  }
  // int32 x 1274126177 is exact in int64; converting it to double rounds it
  // exactly as the JS multiply does (one correctly rounded result), and the
  // rounded value is still an integer below 2^63, so its low 32 bits are
  // ToInt32 of the JS double.
  const double n2 = static_cast<double>(static_cast<std::int64_t>(t) * 1274126177LL);
  const auto u2 = static_cast<std::uint32_t>(static_cast<std::uint64_t>(static_cast<std::int64_t>(n2)));
  const std::uint32_t r = u2 ^ (u2 >> 16U);
  return (static_cast<double>(r) / 4294967296.0) * 2 - 1;
}

}  // namespace

void add_noise(RgbaView img, double amount, double evolution, bool mono, ThreadPool* pool) {
  const double strength = amount * 255;
  const int seed = js::to_int32(evolution);
  const int w = img.w;
  std::uint8_t* data = img.data.data();
  for_rows(pool, img.h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        std::uint8_t* p = data + idx4(x, y, w);
        if (p[3] == 0) continue;
        if (mono) {
          const double n = noise_hash(x, y, seed, 0) * strength;
          p[0] = u8c(p[0] + n);
          p[1] = u8c(p[1] + n);
          p[2] = u8c(p[2] + n);
        } else {
          p[0] = u8c(p[0] + noise_hash(x, y, seed, 0) * strength);
          p[1] = u8c(p[1] + noise_hash(x, y, seed, 1) * strength);
          p[2] = u8c(p[2] + noise_hash(x, y, seed, 2) * strength);
        }
      }
    }
  });
}

// ── turbulentNoiseData ──────────────────────────────────────────────────────

void turbulent_noise(RgbaView img, double scale, double complexity, double evolution, double contrast,
                     double brightness, bool invert, ThreadPool* pool) {
  const double s = std::max(1.0, scale);
  const int octaves = static_cast<int>(std::max(1.0, std::min(8.0, js::round(complexity))));
  const double gain = contrast / 100;
  const double lift = brightness / 100;
  const int w = img.w;
  std::uint8_t* data = img.data.data();
  std::array<double, 8> seeds{};
  for (int o = 0; o < octaves; ++o) seeds[static_cast<std::size_t>(o)] = evolution + o * 13.7;
  for_rows(pool, img.h, [&](int y0, int y1) {
    for (int py = y0; py < y1; ++py) {
      for (int px = 0; px < w; ++px) {
        std::uint8_t* p = data + idx4(px, py, w);
        if (p[3] == 0) continue;
        double sum = 0;
        double amp = 1;
        double norm = 0;
        double freq = 1 / s;
        for (int o = 0; o < octaves; ++o) {
          const double sgn = VnoisePoint(px * freq, py * freq).sample(seeds[static_cast<std::size_t>(o)]) - 0.5;
          sum += std::fabs(sgn) * 2 * amp;
          norm += amp;
          amp *= 0.5;
          freq *= 2;
        }
        double v = sum / norm;
        v = (v - 0.5) * gain + 0.5 + lift;
        if (invert) v = 1 - v;
        const std::uint8_t level = u8c(clamp255(js::round(v * 255)));
        p[0] = level;
        p[1] = level;
        p[2] = level;
      }
    }
  });
}

// ── addGrainData ────────────────────────────────────────────────────────────

void add_grain(RgbaView img, double intensity, double size, double saturation, double seed, ThreadPool* pool) {
  const double amount = intensity / 100;
  if (amount == 0) return;
  const double pitch = std::max(0.1, size);
  const double sat = std::max(0.0, std::min(1.0, saturation / 100));
  const int w = img.w;
  std::uint8_t* data = img.data.data();
  for_rows(pool, img.h, [&](int y0, int y1) {
    for (int py = y0; py < y1; ++py) {
      for (int px = 0; px < w; ++px) {
        std::uint8_t* p = data + idx4(px, py, w);
        if (p[3] == 0) continue;
        const double r = p[0];
        const double g = p[1];
        const double b = p[2];
        const double l = luma601(r, g, b) / 255;
        const double response = 4 * l * (1 - l);
        if (response <= 0) continue;
        const double nx = px / pitch;
        const double ny = py / pitch;
        const VnoisePoint vp(nx, ny);
        const double mono = (vp.sample(seed) - 0.5) * 2;
        const double kick = amount * response * 128;
        if (sat == 0) {
          p[0] = u8c(clamp255(r + mono * kick));
          p[1] = u8c(clamp255(g + mono * kick));
          p[2] = u8c(clamp255(b + mono * kick));
        } else {
          const double nr = (vp.sample(seed + 1.7) - 0.5) * 2;
          const double ng = (vp.sample(seed + 5.3) - 0.5) * 2;
          const double nb = (vp.sample(seed + 9.1) - 0.5) * 2;
          p[0] = u8c(clamp255(r + (mono * (1 - sat) + nr * sat) * kick));
          p[1] = u8c(clamp255(g + (mono * (1 - sat) + ng * sat) * kick));
          p[2] = u8c(clamp255(b + (mono * (1 - sat) + nb * sat) * kick));
        }
      }
    }
  });
}

// ── medianData ──────────────────────────────────────────────────────────────
//
// The TS sorts the (clipped) window per pixel per channel and takes element
// `count >> 1`. The same order statistic comes out of a sliding 256-bin
// histogram per channel (Huang's algorithm): the window moves one column at a
// time, and the running median moves by the few bins the update shifted
// (rank_hist.hpp).

void median(RgbaView img, double radius, ThreadPool* pool) {
  const int r = static_cast<int>(std::max(0.0, std::min(8.0, js::round(radius))));
  if (r == 0) return;
  const int w = img.w;
  const int h = img.h;
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int py = y0; py < y1; ++py) {
      const int ya = std::max(0, py - r);
      const int yb = std::min(h - 1, py + r);
      const int rows = yb - ya + 1;
      std::array<RankHist, 3> hist{};
      const auto column = [&](int sx, bool add) {
        for (int sy = ya; sy <= yb; ++sy) {
          const std::uint8_t* s = src.data() + idx4(sx, sy, w);
          for (std::size_t c = 0; c < 3; ++c) {
            if (add) {
              hist[c].add(s[c]);
            } else {
              hist[c].remove(s[c]);
            }
          }
        }
      };
      for (int sx = 0; sx <= std::min(w - 1, r); ++sx) column(sx, true);
      for (int px = 0; px < w; ++px) {
        if (px > 0) {
          if (px - r - 1 >= 0) column(px - r - 1, false);
          if (px + r < w) column(px + r, true);
        }
        const std::size_t di = idx4(px, py, w);
        const std::uint8_t a = src[di + 3];
        out[di + 3] = a;
        if (a == 0) {
          out[di] = 0;
          out[di + 1] = 0;
          out[di + 2] = 0;
          continue;
        }
        const int cols = std::min(w - 1, px + r) - std::max(0, px - r) + 1;
        const int k = (rows * cols) >> 1;
        for (std::size_t c = 0; c < 3; ++c) out[di + c] = static_cast<std::uint8_t>(hist[c].kth(k));
      }
    }
  });
}

}  // namespace premation::effects
