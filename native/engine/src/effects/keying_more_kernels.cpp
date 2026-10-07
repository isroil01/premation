// AE parity 5.2 — the keying family past the core key: Keylight 1.2's view
// modes, screen pre-blur, clip rollback and inside / outside masks; Advanced
// Spill Suppressor; Key Cleaner; Remove Grain. Straight RGBA8 in place (the
// bake chain's pixel pass). Deterministic: no clock, no randomness.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <vector>

#include "color_space.hpp"
#include "kernels.hpp"

namespace premation::effects {

namespace {

std::uint8_t u8(double v) { return static_cast<std::uint8_t>(std::max(0.0, std::min(255.0, std::round(v)))); }

/// A separable box blur of one float plane (clamped edges), radius r.
void box_blur_plane(std::vector<float>& plane, int w, int h, int r, ThreadPool* pool) {
  if (r <= 0 || w <= 0 || h <= 0) return;
  const auto uw = static_cast<std::size_t>(w);
  std::vector<float> tmp(plane.size());
  const float inv = 1.0F / static_cast<float>(2 * r + 1);
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      const float* row = plane.data() + static_cast<std::size_t>(y) * uw;
      float* out = tmp.data() + static_cast<std::size_t>(y) * uw;
      float sum = 0;
      for (int k = -r; k <= r; ++k) sum += row[std::clamp(k, 0, w - 1)];
      for (int x = 0; x < w; ++x) {
        out[x] = sum * inv;
        sum += row[std::clamp(x + r + 1, 0, w - 1)] - row[std::clamp(x - r, 0, w - 1)];
      }
    }
  });
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      float* out = plane.data() + static_cast<std::size_t>(y) * uw;
      for (int x = 0; x < w; ++x) {
        float sum = 0;
        for (int k = -r; k <= r; ++k) sum += tmp[static_cast<std::size_t>(std::clamp(y + k, 0, h - 1)) * uw + static_cast<std::size_t>(x)];
        out[x] = sum * inv;
      }
    }
  });
}

/// A boolean plane dilated by `r` (square window): true where any input within r is true.
std::vector<std::uint8_t> dilate(const std::vector<std::uint8_t>& in, int w, int h, int r, ThreadPool* pool) {
  if (r <= 0) return in;
  const auto uw = static_cast<std::size_t>(w);
  std::vector<std::uint8_t> tmp(in.size());
  std::vector<std::uint8_t> out(in.size());
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        std::uint8_t v = 0;
        for (int k = std::max(0, x - r); k <= std::min(w - 1, x + r) && v == 0; ++k) v = in[static_cast<std::size_t>(y) * uw + static_cast<std::size_t>(k)];
        tmp[static_cast<std::size_t>(y) * uw + static_cast<std::size_t>(x)] = v;
      }
    }
  });
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        std::uint8_t v = 0;
        for (int k = std::max(0, y - r); k <= std::min(h - 1, y + r) && v == 0; ++k) v = tmp[static_cast<std::size_t>(k) * uw + static_cast<std::size_t>(x)];
        out[static_cast<std::size_t>(y) * uw + static_cast<std::size_t>(x)] = v;
      }
    }
  });
  return out;
}


}  // namespace

std::vector<float> polygon_coverage(std::span<const double> xy, std::size_t start, std::size_t count, int w, int h) {
  std::vector<float> cov(static_cast<std::size_t>(std::max(0, w)) * static_cast<std::size_t>(std::max(0, h)), 0.0F);
  if (count < 3 || w <= 0 || h <= 0 || (start + count) * 2 > xy.size()) return cov;
  constexpr int kSub = 4;
  std::vector<double> xs;
  for (int y = 0; y < h; ++y) {
    for (int s = 0; s < kSub; ++s) {
      const double sy = y + (s + 0.5) / kSub;
      xs.clear();
      for (std::size_t i = 0; i < count; ++i) {
        const std::size_t a = (start + i) * 2;
        const std::size_t b = (start + (i + 1) % count) * 2;
        const double y0 = xy[a + 1], y1 = xy[b + 1];
        if ((y0 <= sy) == (y1 <= sy)) continue;
        xs.push_back(xy[a] + (sy - y0) / (y1 - y0) * (xy[b] - xy[a]));
      }
      std::ranges::sort(xs);
      for (std::size_t k = 0; k + 1 < xs.size(); k += 2) {
        const double x0 = std::max(0.0, xs[k]);
        const double x1 = std::min(static_cast<double>(w), xs[k + 1]);
        for (int x = static_cast<int>(std::floor(x0)); x < static_cast<int>(std::ceil(x1)); ++x) {
          const double c = std::min(x1, x + 1.0) - std::max(x0, static_cast<double>(x));
          if (c > 0) cov[static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x)] += static_cast<float>(c / kSub);
        }
      }
    }
  }
  return cov;
}

void keylight_full(RgbaView img, const KeylightParams& p, const KeylightExtras& x, ThreadPool* pool) {
  if (x.neutral()) {
    keylight(img, p, pool);
    return;
  }
  const int w = img.w;
  const int h = img.h;
  const std::size_t n = img.pixels();
  std::uint8_t* d = img.data.data();
  if (x.view == 1) return;  // Source: the footage as it came in.
  // The colours the matte is pulled from: a box-blurred copy (Screen Pre-blur).
  std::array<std::vector<float>, 3> src;
  for (std::size_t c = 0; c < 3; ++c) {
    src[c].resize(n);
    for (std::size_t i = 0; i < n; ++i) src[c][i] = d[i * 4 + c];
  }
  const int blur = static_cast<int>(std::min(20.0, std::round(x.preBlur)));
  if (blur > 0) {
    for (auto& plane : src) box_blur_plane(plane, w, h, blur, pool);
  }
  const std::array<double, 3> key{p.screen.r, p.screen.g, p.screen.b};
  const KeyChannels ch = key_channels(key[0], key[1], key[2]);
  const double balance = std::clamp(p.balance, 0.0, 1.0);
  const double gain = std::max(0.0, p.gain);
  const double ref = screen_amount(key, ch, balance);
  const double denom = std::fabs(ref) < 1e-4 ? 1 : ref;
  const double cb = std::clamp(p.clip_black, 0.0, 1.0);
  const double cw = std::clamp(p.clip_white, 0.0, 1.0);
  std::vector<float> raw(n);
  std::vector<float> matte(n);
  for_rows(pool, h, [&](int y0, int y1) {
    for (std::size_t i = static_cast<std::size_t>(y0) * static_cast<std::size_t>(w); i < static_cast<std::size_t>(y1) * static_cast<std::size_t>(w); ++i) {
      const std::array<double, 3> c{src[0][i], src[1][i], src[2][i]};
      const double v = 1 - (screen_amount(c, ch, balance) / denom) * gain;
      raw[i] = static_cast<float>(std::clamp(v, 0.0, 1.0));
      matte[i] = static_cast<float>(clip_matte(v, cb, cw));
    }
  });
  // Clip Rollback: in the band where the clipped matte turns from opaque to
  // not, the unclipped (detailed) matte comes back.
  const int roll = static_cast<int>(std::min(50.0, std::round(x.rollback)));
  if (roll > 0) {
    std::vector<std::uint8_t> opaque(n);
    std::vector<std::uint8_t> clear(n);
    for (std::size_t i = 0; i < n; ++i) {
      opaque[i] = matte[i] >= 0.999F ? 1 : 0;
      clear[i] = matte[i] < 0.999F ? 1 : 0;
    }
    const auto nearOpaque = dilate(opaque, w, h, roll, pool);
    const auto nearClear = dilate(clear, w, h, roll, pool);
    for (std::size_t i = 0; i < n; ++i) {
      // Clip Black zeroed the faint edge detail (hair, motion blur): bring it back here.
      if (nearOpaque[i] != 0 && nearClear[i] != 0) matte[i] = std::max(matte[i], raw[i]);
    }
  }
  // Inside Mask holds the subject; Outside Mask drops what is outside the shot.
  if (x.inside.size() == n) {
    for (std::size_t i = 0; i < n; ++i) matte[i] = std::max(matte[i], std::clamp(x.inside[i], 0.0F, 1.0F));
  }
  if (x.outside.size() == n) {
    for (std::size_t i = 0; i < n; ++i) matte[i] *= 1 - std::clamp(x.outside[i], 0.0F, 1.0F);
  }
  const double despill = std::clamp(p.despill, 0.0, 1.0);
  const bool intermediate = x.view == 4;
  for (std::size_t i = 0; i < n; ++i) {
    std::uint8_t* px = d + i * 4;
    const double a0 = px[3];
    if (a0 == 0) continue;
    const double alpha = intermediate ? raw[i] : matte[i];
    px[3] = u8(a0 * alpha);
    if (!intermediate && despill > 0 && alpha > 0) {
      std::array<double, 3> c{static_cast<double>(px[0]), static_cast<double>(px[1]), static_cast<double>(px[2])};
      const double cap = std::max(c[ch.a], c[ch.b]);
      if (c[ch.p] > cap) {
        c[ch.p] += (cap - c[ch.p]) * despill;
        px[0] = u8(c[0]);
        px[1] = u8(c[1]);
        px[2] = u8(c[2]);
      }
    }
  }
  if (!intermediate) {
    const int cr = static_cast<int>(std::min(10.0, std::round(std::fabs(p.choke))));
    if (cr != 0) alpha_min_max(img, cr, !(p.choke > 0), pool);
    soften_alpha(img, p.matte_softness, pool);
  }
  if (x.view == 2 || x.view == 3) {
    // Screen Matte: the matte as grey; Status: black / white / mid grey where it is neither.
    for (std::size_t i = 0; i < n; ++i) {
      std::uint8_t* px = d + i * 4;
      const double a = px[3] / 255.0;
      double g = a * 255;
      if (x.view == 3) g = a >= 0.995 ? 255 : a <= 0.005 ? 0 : 128;
      px[0] = px[1] = px[2] = u8(g);
      px[3] = 255;
    }
  }
}

void advanced_spill_suppressor(RgbaView img, const SpillParams& p, ThreadPool* pool) {
  const std::size_t n = img.pixels();
  std::uint8_t* d = img.data.data();
  KeyChannels ch{1, 0, 2};
  if (p.method == 1) {
    ch = key_channels(p.key.r, p.key.g, p.key.b);
  } else {
    // Standard: the screen is whichever of green / blue dominates the frame.
    double green = 0, blue = 0;
    for (std::size_t i = 0; i < n; ++i) {
      const std::uint8_t* px = d + i * 4;
      if (px[3] == 0) continue;
      green += std::max(0, px[1] - std::max(px[0], px[2]));
      blue += std::max(0, px[2] - std::max(px[0], px[1]));
    }
    ch = blue > green ? KeyChannels{2, 0, 1} : KeyChannels{1, 0, 2};
  }
  const double sup = std::clamp(p.suppression, 0.0, 1.0);
  const double range = std::clamp(p.spillRange, 0.0, 1.0);
  const double tol = std::clamp(p.tolerance, 0.0, 1.0);
  const double desat = std::clamp(p.desaturate, 0.0, 1.0);
  const double colorFix = std::clamp(p.colorCorrection, 0.0, 1.0);
  const double lumaFix = std::clamp(p.lumaCorrection, 0.0, 1.0);
  const int w = img.w;
  for_rows(pool, img.h, [&](int y0, int y1) {
    for (std::size_t i = static_cast<std::size_t>(y0) * static_cast<std::size_t>(w); i < static_cast<std::size_t>(y1) * static_cast<std::size_t>(w); ++i) {
      std::uint8_t* px = d + i * 4;
      if (px[3] == 0) continue;
      std::array<double, 3> c{px[0] / 255.0, px[1] / 255.0, px[2] / 255.0};
      const double before = luma709(c[0], c[1], c[2]);
      // Spill Range: from the mean of the other two (conservative) to their max (aggressive).
      const double limit = (1 - range) * std::max(c[ch.a], c[ch.b]) + range * (c[ch.a] + c[ch.b]) / 2;
      double spill = std::max(0.0, c[ch.p] - limit);
      if (p.method == 1) {
        // Ultra: Tolerance widens the spill a pixel may carry before it counts in full.
        spill *= std::min(1.0, spill / std::max(1e-3, 0.02 + 0.5 * (1 - tol)));
      }
      spill *= sup;
      if (spill <= 0) continue;
      c[ch.p] -= spill;
      // Spill Color Correction: the removed spill returns as neutral light.
      c[ch.a] += spill * colorFix * 0.5;
      c[ch.b] += spill * colorFix * 0.5;
      if (desat > 0) {
        const double L = luma709(c[0], c[1], c[2]);
        const double k = 1 - std::min(1.0, desat * spill * 4);
        for (double& v : c) v = L + (v - L) * k;
      }
      if (lumaFix > 0) {
        const double dl = (before - luma709(c[0], c[1], c[2])) * lumaFix;
        for (double& v : c) v += dl;
      }
      px[0] = u8(c[0] * 255);
      px[1] = u8(c[1] * 255);
      px[2] = u8(c[2] * 255);
    }
  });
}

void key_cleaner(RgbaView img, double radius, bool reduceChatter, double contrast, double strength, ThreadPool* pool) {
  const int r = static_cast<int>(std::min(50.0, std::round(radius)));
  const double s = std::clamp(strength, 0.0, 1.0);
  if (r <= 0 || s <= 0) return;
  const int w = img.w;
  const int h = img.h;
  const std::size_t n = img.pixels();
  std::uint8_t* d = img.data.data();
  std::vector<float> alpha(n);
  std::vector<std::uint8_t> edge(n);
  for (std::size_t i = 0; i < n; ++i) {
    alpha[i] = d[i * 4 + 3] / 255.0F;
    edge[i] = d[i * 4 + 3] > 0 && d[i * 4 + 3] < 255 ? 1 : 0;
  }
  // The edge zone: soft pixels, plus where opaque meets clear.
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x + 1 < w; ++x) {
      const std::size_t i = static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x);
      if ((d[i * 4 + 3] == 0) != (d[(i + 1) * 4 + 3] == 0)) edge[i] = edge[i + 1] = 1;
    }
  }
  const auto zone = dilate(edge, w, h, r, pool);
  if (reduceChatter) {
    // Reduce Chatter: a 3×3 median of the matte in the zone (single-frame chatter).
    std::vector<float> med = alpha;
    for (int y = 1; y + 1 < h; ++y) {
      for (int x = 1; x + 1 < w; ++x) {
        const std::size_t i = static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x);
        if (zone[i] == 0) continue;
        std::array<float, 9> v{};
        std::size_t k = 0;
        for (int dy = -1; dy <= 1; ++dy) {
          for (int dx = -1; dx <= 1; ++dx) v[k++] = alpha[static_cast<std::size_t>(y + dy) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x + dx)];
        }
        std::nth_element(v.begin(), v.begin() + 4, v.end());
        med[i] = v[4];
      }
    }
    alpha = std::move(med);
  }
  std::vector<float> smooth = alpha;
  box_blur_plane(smooth, w, h, std::max(1, r / 2), pool);
  box_blur_plane(smooth, w, h, std::max(1, r / 2), pool);
  const double k = std::max(0.0, contrast);
  for (std::size_t i = 0; i < n; ++i) {
    if (zone[i] == 0 || (d[i * 4 + 3] == 0 && smooth[i] < 0.002F)) continue;
    const double a = std::clamp((smooth[i] - 0.5) * k + 0.5, 0.0, 1.0);
    const double out = alpha[i] + (a - alpha[i]) * s;
    d[i * 4 + 3] = u8(out * 255);
  }
}

void remove_grain(RgbaView img, double strength, int radius, int passes, double detail, double chroma, bool showNoise,
                  ThreadPool* pool) {
  const double st = std::clamp(strength, 0.0, 1.0);
  const int r = std::clamp(radius, 1, 8);
  const int np = std::clamp(passes, 1, 4);
  if (st <= 0) return;
  const int w = img.w;
  const int h = img.h;
  const std::size_t n = img.pixels();
  std::uint8_t* d = img.data.data();
  // YCbCr planes, 0..255.
  std::array<std::vector<float>, 3> ycc;
  for (auto& plane : ycc) plane.resize(n);
  for (std::size_t i = 0; i < n; ++i) {
    const double R = d[i * 4], G = d[i * 4 + 1], B = d[i * 4 + 2];
    const double Y = luma709(R, G, B);
    ycc[0][i] = static_cast<float>(Y);
    ycc[1][i] = static_cast<float>((B - Y) / 1.8556);
    ycc[2][i] = static_cast<float>((R - Y) / 1.5748);
  }
  const std::array<std::vector<float>, 3> original = ycc;
  // Range sigmas: grain-sized steps blend, edges (bigger steps) do not. Detail
  // keeps fine luma texture; Chroma sets how hard the colour noise is smoothed.
  const double sigmaY = 2 + 28 * st * (1 - 0.8 * std::clamp(detail, 0.0, 1.0));
  const double sigmaC = 2 + 40 * st * std::clamp(chroma, 0.0, 1.0);
  const double sigmaS = std::max(0.5, r / 2.0);
  std::vector<double> spatial(static_cast<std::size_t>((2 * r + 1) * (2 * r + 1)));
  for (int dy = -r; dy <= r; ++dy) {
    for (int dx = -r; dx <= r; ++dx) spatial[static_cast<std::size_t>((dy + r) * (2 * r + 1) + dx + r)] = std::exp(-(dx * dx + dy * dy) / (2 * sigmaS * sigmaS));
  }
  for (int pass = 0; pass < np; ++pass) {
    std::array<std::vector<float>, 3> next = ycc;
    for_rows(pool, h, [&](int y0, int y1) {
      for (int y = y0; y < y1; ++y) {
        for (int x = 0; x < w; ++x) {
          const std::size_t i = static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x);
          const float cy = ycc[0][i];
          std::array<double, 3> sum{0, 0, 0};
          std::array<double, 3> wsum{0, 0, 0};
          for (int dy = -r; dy <= r; ++dy) {
            const int yy = std::clamp(y + dy, 0, h - 1);
            for (int dx = -r; dx <= r; ++dx) {
              const int xx = std::clamp(x + dx, 0, w - 1);
              const std::size_t j = static_cast<std::size_t>(yy) * static_cast<std::size_t>(w) + static_cast<std::size_t>(xx);
              const double sp = spatial[static_cast<std::size_t>((dy + r) * (2 * r + 1) + dx + r)];
              // Range weight from the luma step: grain blends, edges keep.
              const double dl = ycc[0][j] - cy;
              const double wy = sp * std::exp(-(dl * dl) / (2 * sigmaY * sigmaY));
              const double wc = sp * std::exp(-(dl * dl) / (2 * sigmaC * sigmaC));
              sum[0] += wy * ycc[0][j];
              wsum[0] += wy;
              sum[1] += wc * ycc[1][j];
              sum[2] += wc * ycc[2][j];
              wsum[1] += wc;
            }
          }
          next[0][i] = static_cast<float>(sum[0] / std::max(1e-9, wsum[0]));
          next[1][i] = static_cast<float>(sum[1] / std::max(1e-9, wsum[1]));
          next[2][i] = static_cast<float>(sum[2] / std::max(1e-9, wsum[1]));
        }
      }
    });
    ycc = std::move(next);
  }
  for (std::size_t i = 0; i < n; ++i) {
    double Y = ycc[0][i], Cb = ycc[1][i], Cr = ycc[2][i];
    if (showNoise) {
      Y = 128 + (original[0][i] - Y) * 4;
      Cb = (original[1][i] - Cb) * 4;
      Cr = (original[2][i] - Cr) * 4;
    }
    const double R = Y + 1.5748 * Cr;
    const double B = Y + 1.8556 * Cb;
    const double G = (Y - 0.2126 * R - 0.0722 * B) / 0.7152;
    d[i * 4] = u8(R);
    d[i * 4 + 1] = u8(G);
    d[i * 4 + 2] = u8(B);
  }
}

}  // namespace premation::effects
