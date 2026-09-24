// Ports of the keying family: keylight.ts (applyKeyData + chokeAlpha +
// softenAlpha, the applyKeylight sequence), keyingEffects.ts
// (linearColorKeyData, lumaKeyData, shiftChannelsData) and aeKeyingAdvanced.ts
// (colorKeyData, colorRangeData, extractData, spillSuppressorData,
// matteChokerData).
#include <algorithm>
#include <array>
#include <vector>

#include "kernels.hpp"

namespace premation::effects {

namespace {

/// @utils/lang `clamp01` (NaN → 0), which keylight.ts imports.
[[nodiscard]] inline double clamp01_lang(double v) noexcept { return v > 0 ? (v > 1 ? 1 : v) : 0; }

/// colorSpace.ts `smoothstep` (its clamp01 lets NaN through).
[[nodiscard]] inline double smoothstep(double e0, double e1, double x) noexcept {
  if (e1 <= e0) return x < e0 ? 0 : 1;
  const double t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

template <class Fn>
void each_pixel(RgbaView img, ThreadPool* pool, Fn&& fn) {
  std::uint8_t* data = img.data.data();
  const auto w = static_cast<std::size_t>(img.w);
  for_rows(pool, img.h, [&](int y0, int y1) {
    std::uint8_t* p = data + static_cast<std::size_t>(y0) * w * 4;
    std::uint8_t* const e = data + static_cast<std::size_t>(y1) * w * 4;
    for (; p != e; p += 4) fn(p);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  });
}

// ── keylight.ts ─────────────────────────────────────────────────────────────

struct KeyChannels {
  std::size_t p, a, b;
};

KeyChannels key_channels(double r, double g, double bl) {
  if (g >= r && g >= bl) return {1, 0, 2};
  if (bl >= r && bl >= g) return {2, 0, 1};
  return {0, 1, 2};
}

double screen_amount(const std::array<double, 3>& px, const KeyChannels& ch, double balance) {
  const double prim = px[ch.p] / 255;
  const double s1 = px[ch.a] / 255;
  const double s2 = px[ch.b] / 255;
  const double sec = balance * std::max(s1, s2) + (1 - balance) * std::min(s1, s2);
  return prim - sec;
}

double clip_matte(double v, double black, double white) {
  if (white <= black) return v <= black ? 0 : 1;
  const double t = (v - black) / (white - black);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/// `softenAlpha(data, w, h, px)`: a clamped box blur of alpha through a
/// Float32Array; the vertical sums are of floats, so they keep the TS order.
void soften_alpha(RgbaView img, double px, ThreadPool* pool) {
  const int r = static_cast<int>(std::min(25.0, js::round(px)));
  if (r <= 0) return;
  const int w = img.w;
  const int h = img.h;
  const auto uw = static_cast<std::size_t>(w);
  const double win = 2 * r + 1;
  std::vector<float> tmp(img.pixels());
  std::uint8_t* data = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      const std::uint8_t* row = data + static_cast<std::size_t>(y) * uw * 4 + 3;
      // Integer alphas: the sum is exact, so it can slide.
      std::int64_t sum = 0;
      for (int k = -r; k <= r; ++k) sum += row[static_cast<std::size_t>(clampi(k, 0, w - 1)) * 4];
      float* t = tmp.data() + static_cast<std::size_t>(y) * uw;
      for (int x = 0; x < w; ++x) {
        t[x] = static_cast<float>(static_cast<double>(sum) / win);
        sum += row[static_cast<std::size_t>(clampi(x + r + 1, 0, w - 1)) * 4] -
               row[static_cast<std::size_t>(clampi(x - r, 0, w - 1)) * 4];
      }
    }
  });
  for_rows(pool, h, [&](int y0, int y1) {
    std::vector<double> acc(uw);
    for (int y = y0; y < y1; ++y) {
      std::fill(acc.begin(), acc.end(), 0.0);
      for (int k = -r; k <= r; ++k) {
        const float* t = tmp.data() + static_cast<std::size_t>(clampi(y + k, 0, h - 1)) * uw;
        for (std::size_t x = 0; x < uw; ++x) acc[x] += static_cast<double>(t[x]);
      }
      std::uint8_t* row = data + static_cast<std::size_t>(y) * uw * 4 + 3;
      for (std::size_t x = 0; x < uw; ++x) row[x * 4] = u8c(js::round(acc[x] / win));
    }
  });
}

// ── keyingEffects.ts helpers ────────────────────────────────────────────────

double hue_of(double r, double g, double b) {
  const double mx = std::max(r, std::max(g, b));
  const double mn = std::min(r, std::min(g, b));
  const double d = mx - mn;
  if (d == 0) return 0;
  double hue = 0;
  if (mx == r) {
    hue = std::fmod((g - b) / d, 6.0);
  } else if (mx == g) {
    hue = (b - r) / d + 2;
  } else {
    hue = (r - g) / d + 4;
  }
  hue /= 6;
  return hue < 0 ? hue + 1 : hue;
}

double hypot3(double a, double b, double c) {
  const std::array<double, 3> v{a, b, c};
  return js::hypot(v);
}

/// colorSpace.ts `rgbToHsl` → [h, s].
std::array<double, 2> hue_sat(double r, double g, double b) {
  const double rn = r / 255;
  const double gn = g / 255;
  const double bn = b / 255;
  const double mx = std::max(rn, std::max(gn, bn));
  const double mn = std::min(rn, std::min(gn, bn));
  const double l = (mx + mn) / 2;
  const double d = mx - mn;
  if (d == 0) return {0, 0};
  const double s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  double h = 0;
  if (mx == rn) {
    h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  } else if (mx == gn) {
    h = ((bn - rn) / d + 2) / 6;
  } else {
    h = ((rn - gn) / d + 4) / 6;
  }
  return {h, s};
}

double hue_distance(double a, double b) {
  const double d = std::fmod(std::fabs(a - b), 1.0);
  return d > 0.5 ? 1 - d : d;
}

}  // namespace

void keylight(RgbaView img, const KeylightParams& p, ThreadPool* pool) {
  const std::array<double, 3> key{p.screen.r, p.screen.g, p.screen.b};
  const KeyChannels ch = key_channels(key[0], key[1], key[2]);
  const double balance = clamp01_lang(p.balance);
  const double gain = std::max(0.0, p.gain);
  const double despill = clamp01_lang(p.despill);
  const double ref = screen_amount(key, ch, balance);
  const double denom = std::fabs(ref) < 1e-4 ? 1 : ref;
  const double clip_black = clamp01_lang(p.clip_black);
  const double clip_white = clamp01_lang(p.clip_white);
  each_pixel(img, pool, [&](std::uint8_t* px) {
    const double a0 = px[3];
    if (a0 == 0) return;
    std::array<double, 3> c{static_cast<double>(px[0]), static_cast<double>(px[1]), static_cast<double>(px[2])};
    const double amt = (screen_amount(c, ch, balance) / denom) * gain;
    const double alpha = clip_matte(1 - amt, clip_black, clip_white);
    px[3] = u8c(js::round(a0 * alpha));
    if (despill > 0 && alpha > 0) {
      const double cap = std::max(c[ch.a], c[ch.b]);
      if (c[ch.p] > cap) {
        c[ch.p] = c[ch.p] + (cap - c[ch.p]) * despill;
        px[0] = u8c(c[0]);
        px[1] = u8c(c[1]);
        px[2] = u8c(c[2]);
      }
    }
  });
  const double choke = p.choke;
  const int cr = static_cast<int>(std::min(10.0, js::round(std::fabs(choke))));
  if (cr != 0) alpha_min_max(img, cr, !(choke > 0), pool);
  soften_alpha(img, p.matte_softness, pool);
}

void linear_color_key(RgbaView img, const Rgb& key, double match_on, double tolerance, double softness,
                      bool keep_matched, ThreadPool* pool) {
  const int mode = match_on == 1 ? 1 : match_on == 2 ? 2 : 0;  // colorMatchMode: rgb / hue / chroma
  const double tol = std::max(0.0, std::min(1.0, tolerance / 100));
  const double soft = std::max(0.0, std::min(1.0, softness / 100));
  const double key_hue = hue_of(key.r, key.g, key.b);
  const double key_lum = luma601(key.r, key.g, key.b);
  each_pixel(img, pool, [&](std::uint8_t* px) {
    if (px[3] == 0) return;
    const double r = px[0];
    const double g = px[1];
    const double b = px[2];
    double distance = 0;
    if (mode == 1) {
      const double dh = std::fabs(hue_of(r, g, b) - key_hue);
      distance = std::min(dh, 1 - dh) * 2;
    } else if (mode == 2) {
      const double pix_lum = luma601(r, g, b);
      if (pix_lum <= 0.5) {
        distance = key_lum <= 0.5 ? 0 : 1;
      } else {
        const double k = key_lum / pix_lum;
        distance = std::min(1.0, hypot3(r * k - key.r, g * k - key.g, b * k - key.b) / 441.673);
      }
    } else {
      distance = std::min(1.0, hypot3(r - key.r, g - key.g, b - key.b) / 441.673);
    }
    double matched = 0;
    if (distance <= tol) {
      matched = 1;
    } else if (soft <= 0 || distance >= tol + soft) {
      matched = 0;
    } else {
      matched = 1 - (distance - tol) / soft;
    }
    const double keep = keep_matched ? matched : 1 - matched;
    px[3] = u8c(px[3] * keep);
  });
}

void luma_key(RgbaView img, double key_type, double threshold, double tolerance, double softness, ThreadPool* pool) {
  const double kt = js::round(key_type);
  const int type = (kt >= 0 && kt <= 3) ? static_cast<int>(kt) : 0;  // brighter / darker / similar / dissimilar
  const double cut = std::max(0.0, std::min(1.0, threshold / 255));
  const double tol = std::max(0.0, tolerance / 255);
  const double soft = std::max(0.0, softness / 255);
  each_pixel(img, pool, [&](std::uint8_t* px) {
    if (px[3] == 0) return;
    const double l = luma601(px[0], px[1], px[2]) / 255;
    double into = 0;
    switch (type) {
      case 0: into = l - cut; break;
      case 1: into = cut - l; break;
      case 2: into = tol - std::fabs(l - cut); break;
      default: into = std::fabs(l - cut) - tol; break;
    }
    if (type == 0 || type == 1) into += tol;
    double alpha = 0;
    if (into <= 0) {
      alpha = 1;
    } else if (soft <= 0) {
      alpha = 0;
    } else {
      alpha = std::max(0.0, std::min(1.0, 1 - into / soft));
    }
    px[3] = u8c(px[3] * alpha);
  });
}

void shift_channels(RgbaView img, double alpha_from, double red_from, double green_from, double blue_from,
                    ThreadPool* pool) {
  // channelSource: alpha, red, green, blue, luminance, full-on, full-off.
  const auto source = [](double v) {
    const double r = js::round(v);
    return (r >= 0 && r <= 6) ? static_cast<int>(r) : 0;
  };
  const int sa = source(alpha_from);
  const int sr = source(red_from);
  const int sg = source(green_from);
  const int sb = source(blue_from);
  each_pixel(img, pool, [&](std::uint8_t* px) {
    const std::uint8_t r = px[0];
    const std::uint8_t g = px[1];
    const std::uint8_t b = px[2];
    const std::uint8_t a = px[3];
    const auto pick = [&](int s) -> std::uint8_t {
      switch (s) {
        case 0: return a;
        case 1: return r;
        case 2: return g;
        case 3: return b;
        case 4: return u8c(luma601(r, g, b));
        case 5: return 255;
        default: return 0;
      }
    };
    px[0] = pick(sr);
    px[1] = pick(sg);
    px[2] = pick(sb);
    px[3] = pick(sa);
  });
}

void color_key(RgbaView img, const Rgb& key, double tolerance, double edge_softness, ThreadPool* pool) {
  const double max_dist = std::sqrt(3.0 * 255 * 255);
  const double tol = clamp01(tolerance / 100) * max_dist;
  const double soft = clamp01(edge_softness / 100) * max_dist;
  each_pixel(img, pool, [&](std::uint8_t* px) {
    const double a = px[3];
    if (a == 0) return;
    const double dr = px[0] - key.r;
    const double dg = px[1] - key.g;
    const double db = px[2] - key.b;
    const double d = std::sqrt(dr * dr + dg * dg + db * db);
    px[3] = u8c(a * smoothstep(tol, tol + soft, d));
  });
}

void color_range(RgbaView img, const Rgb& key, double space, double min_tol, double max_tol, double luma_weight,
                 ThreadPool* pool) {
  const double mode = js::round(space);
  const double wl = clamp01(luma_weight / 100);
  const auto project = [&](double r, double g, double b) -> std::array<double, 3> {
    if (mode == 2) return {r, g, b};
    const double y = luma709(r, g, b);
    if (mode == 1) return {y, (b - y) * 0.565, (r - y) * 0.713};
    return {y, (r - g) * 0.5, (g - b) * 0.5};
  };
  const auto k = project(key.r, key.g, key.b);
  const double lo = clamp01(min_tol / 100) * 255;
  const double hi = std::max(lo + 1e-6, clamp01(max_tol / 100) * 255);
  each_pixel(img, pool, [&](std::uint8_t* px) {
    const double a = px[3];
    if (a == 0) return;
    const auto p = project(px[0], px[1], px[2]);
    const double dy = (p[0] - k[0]) * wl;
    const double du = p[1] - k[1];
    const double dv = p[2] - k[2];
    const double d = std::sqrt(dy * dy + du * du + dv * dv);
    px[3] = u8c(a * smoothstep(lo, hi, d));
  });
}

void extract_matte(RgbaView img, double channel, double black, double white, double black_soft, double white_soft,
                   bool invert, ThreadPool* pool) {
  const double ch = js::round(channel);
  each_pixel(img, pool, [&](std::uint8_t* px) {
    const double a = px[3];
    if (a == 0) return;
    const double r = px[0];
    const double g = px[1];
    const double b = px[2];
    const double v = ch == 1 ? r : ch == 2 ? g : ch == 3 ? b : ch == 4 ? a : luma709(r, g, b);
    const double up = smoothstep(black - black_soft, black + black_soft, v);
    const double down = 1 - smoothstep(white - white_soft, white + white_soft, v);
    double m = clamp01(up * down);
    if (invert) m = 1 - m;
    px[3] = u8c(a * m);
  });
}

void spill_suppressor(RgbaView img, const Rgb& key, double amount, bool preserve_luma, ThreadPool* pool) {
  const double kh = hue_sat(key.r, key.g, key.b)[0];
  const double strength = clamp01(amount / 100);
  if (strength <= 0) return;
  each_pixel(img, pool, [&](std::uint8_t* px) {
    if (px[3] == 0) return;
    const double r = px[0];
    const double g = px[1];
    const double b = px[2];
    const auto hs = hue_sat(r, g, b);
    const double near = (1 - smoothstep(0.08, 0.25, hue_distance(hs[0], kh))) * clamp01(hs[1] * 2) * strength;
    if (near <= 0) return;
    const double before = luma709(r, g, b);
    double nr = r;
    double ng = g;
    double nb = b;
    const auto mean2 = [](double x, double y) { return (x + y) / 2; };
    if (kh > 0.25 && kh < 0.45) {
      ng = g + (std::min(g, mean2(r, b)) - g) * near;
    } else if (kh >= 0.45 && kh < 0.75) {
      nb = b + (std::min(b, mean2(r, g)) - b) * near;
    } else {
      nr = r + (std::min(r, mean2(g, b)) - r) * near;
    }
    if (preserve_luma) {
      const double after = luma709(nr, ng, nb);
      if (after > 1e-3) {
        const double k = before / after;
        nr *= k;
        ng *= k;
        nb *= k;
      }
    }
    px[0] = u8c(clamp255(nr));
    px[1] = u8c(clamp255(ng));
    px[2] = u8c(clamp255(nb));
  });
}

namespace {

/// aeKeyingAdvanced.ts `boxBlurAlpha`: clamped box, Float32 stores, sums of
/// floats in the TS's tap order (d = -r … r) per pixel.
void box_blur_plane(std::vector<float>& a, int w, int h, double radius, ThreadPool* pool) {
  const int r = static_cast<int>(std::max(1.0, js::round(radius)));
  const double span = r * 2 + 1;
  const auto uw = static_cast<std::size_t>(w);
  std::vector<float> tmp(a.size());
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      const float* row = a.data() + static_cast<std::size_t>(y) * uw;
      float* t = tmp.data() + static_cast<std::size_t>(y) * uw;
      for (int x = 0; x < w; ++x) {
        double s = 0;
        for (int d = -r; d <= r; ++d) s += static_cast<double>(row[clampi(x + d, 0, w - 1)]);
        t[x] = static_cast<float>(s / span);
      }
    }
  });
  for_rows(pool, h, [&](int y0, int y1) {
    std::vector<double> acc(uw);
    for (int y = y0; y < y1; ++y) {
      std::fill(acc.begin(), acc.end(), 0.0);
      for (int d = -r; d <= r; ++d) {
        const float* t = tmp.data() + static_cast<std::size_t>(clampi(y + d, 0, h - 1)) * uw;
        for (std::size_t x = 0; x < uw; ++x) acc[x] += static_cast<double>(t[x]);
      }
      float* o = a.data() + static_cast<std::size_t>(y) * uw;
      for (std::size_t x = 0; x < uw; ++x) o[x] = static_cast<float>(acc[x] / span);
    }
  });
}

}  // namespace

void matte_choker(RgbaView img, double spread, double choke, double softness, double iterations, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  if (w <= 0 || h <= 0) return;
  const int passes = static_cast<int>(std::max(1.0, std::min(5.0, js::round(iterations))));
  std::vector<float> alpha(img.pixels());
  std::uint8_t* data = img.data.data();
  for (std::size_t p = 0; p < alpha.size(); ++p) alpha[p] = data[p * 4 + 3];
  const auto morph_r = [](double radius) { return static_cast<int>(std::max(1.0, js::round(radius))); };
  for (int n = 0; n < passes; ++n) {
    if (spread > 0) plane_min_max(alpha, w, h, morph_r(spread), true, pool);
    if (softness > 0) box_blur_plane(alpha, w, h, softness, pool);
    if (choke > 0) plane_min_max(alpha, w, h, morph_r(choke), false, pool);
  }
  for (std::size_t p = 0; p < alpha.size(); ++p) data[p * 4 + 3] = u8c(clamp255(static_cast<double>(alpha[p])));
}

}  // namespace premation::effects
