// Ports of src/core/effects/aeColor.ts (photoFilterData, blackAndWhiteData,
// tritoneData, thresholdData), toneEffects.ts (selectiveColorData,
// shadowHighlightData) and colorEffects.ts `coloramaData` — the colour passes
// that read all three channels (or the neighbourhood), so no per-channel LUT
// can express them.
#include <algorithm>
#include <array>
#include <span>

#include "kernels.hpp"

namespace premation::effects {

namespace {

/// @utils/lang `clamp01` — NaN → 0 (unlike colorSpace.ts `clamp01`).
[[nodiscard]] inline double clamp01_lang(double v) noexcept { return v > 0 ? (v > 1 ? 1 : v) : 0; }

/// Straight RGBA pixels [y0, y1) of `img`, as a flat byte range.
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

struct Hsl {
  double h;
  double s;
  double l;
};

Hsl rgb_to_hsl(double r, double g, double b) {
  const double rn = r / 255;
  const double gn = g / 255;
  const double bn = b / 255;
  const double mx = std::max(rn, std::max(gn, bn));
  const double mn = std::min(rn, std::min(gn, bn));
  const double l = (mx + mn) / 2;
  const double d = mx - mn;
  if (d == 0) return {0, 0, l};
  const double s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  double h = 0;
  if (mx == rn) {
    h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  } else if (mx == gn) {
    h = ((bn - rn) / d + 2) / 6;
  } else {
    h = ((rn - gn) / d + 4) / 6;
  }
  return {h, s, l};
}

double hue_to_channel(double p, double q, double t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1.0 / 6) return p + (q - p) * 6 * t;
  if (t < 1.0 / 2) return q;
  if (t < 2.0 / 3) return p + (q - p) * (2.0 / 3 - t) * 6;
  return p;
}

std::array<double, 3> hsl_to_rgb(double h, double s, double l) {
  if (s == 0) {
    const double v = clamp255(l * 255);
    return {v, v, v};
  }
  const double q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const double p = 2 * l - q;
  return {clamp255(hue_to_channel(p, q, h + 1.0 / 3) * 255), clamp255(hue_to_channel(p, q, h) * 255),
          clamp255(hue_to_channel(p, q, h - 1.0 / 3) * 255)};
}

}  // namespace

void photo_filter(RgbaView img, double fr, double fg, double fb, double density, bool preserve_luminosity,
                  ThreadPool* pool) {
  const double d = density <= 0 ? 0 : density >= 100 ? 1 : density / 100;
  if (d == 0) return;
  const double gr = fr / 255;
  const double gg = fg / 255;
  const double gb = fb / 255;
  each_pixel(img, pool, [&](std::uint8_t* px) {
    const double r = px[0];
    const double g = px[1];
    const double b = px[2];
    double nr = r + (r * gr - r) * d;
    double ng = g + (g * gg - g) * d;
    double nb = b + (b * gb - b) * d;
    if (preserve_luminosity) {
      const double before = luma601(r, g, b);
      const double after = luma601(nr, ng, nb);
      if (after > 1e-6) {
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

void black_and_white(RgbaView img, const BwWeights& wts, const std::array<double, 3>* tint, ThreadPool* pool) {
  Hsl t{};
  if (tint != nullptr) t = rgb_to_hsl((*tint)[0], (*tint)[1], (*tint)[2]);
  each_pixel(img, pool, [&](std::uint8_t* px) {
    const int r = px[0];
    const int g = px[1];
    const int b = px[2];
    const int mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const int mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const int md = r + g + b - mx - mn;
    const double w_primary = mx == r ? wts.reds : mx == g ? wts.greens : wts.blues;
    const double w_secondary = mn == b ? wts.yellows : mn == r ? wts.cyans : wts.magentas;
    const double grey = mn + (md - mn) * w_secondary + (mx - md) * w_primary;
    if (tint != nullptr) {
      const auto c = hsl_to_rgb(t.h, t.s, clamp255(grey) / 255);
      px[0] = u8c(c[0]);
      px[1] = u8c(c[1]);
      px[2] = u8c(c[2]);
    } else {
      const std::uint8_t v = u8c(clamp255(grey));
      px[0] = v;
      px[1] = v;
      px[2] = v;
    }
  });
}

void tritone(RgbaView img, const std::array<double, 3>& sh, const std::array<double, 3>& mid,
             const std::array<double, 3>& hi, double blend, ThreadPool* pool) {
  const double keep = blend <= 0 ? 0 : blend >= 100 ? 1 : blend / 100;
  if (keep >= 1) return;
  each_pixel(img, pool, [&](std::uint8_t* px) {
    const double r = px[0];
    const double g = px[1];
    const double b = px[2];
    const double t = luma601(r, g, b) / 255;
    std::array<double, 3> m{};
    if (t <= 0.5) {
      const double u = t * 2;
      for (std::size_t c = 0; c < 3; ++c) m[c] = sh[c] + (mid[c] - sh[c]) * u;
    } else {
      const double u = (t - 0.5) * 2;
      for (std::size_t c = 0; c < 3; ++c) m[c] = mid[c] + (hi[c] - mid[c]) * u;
    }
    px[0] = u8c(clamp255(m[0] + (r - m[0]) * keep));
    px[1] = u8c(clamp255(m[1] + (g - m[1]) * keep));
    px[2] = u8c(clamp255(m[2] + (b - m[2]) * keep));
  });
}

void threshold(RgbaView img, double level, ThreadPool* pool) {
  each_pixel(img, pool, [&](std::uint8_t* px) {
    const std::uint8_t v = luma601(px[0], px[1], px[2]) >= level ? 255 : 0;
    px[0] = v;
    px[1] = v;
    px[2] = v;
  });
}

SelectiveRange selective_range(double v) noexcept {
  const double r = js::round(v);
  if (r >= 0 && r <= 8) return static_cast<SelectiveRange>(static_cast<int>(r));
  return SelectiveRange::reds;
}

namespace {

double range_weight(SelectiveRange range, double r, double g, double b) {
  const double mx = std::max(r, std::max(g, b));
  const double mn = std::min(r, std::min(g, b));
  const double mid = r + g + b - mx - mn;
  if (mx <= 0) return range == SelectiveRange::blacks ? 1 : 0;
  const auto primary = [&](double ch) { return ch == mx ? (mx - mid) / mx : 0; };
  const auto secondary = [&](double opp) { return opp == mn ? (mid - mn) / mx : 0; };
  switch (range) {
    case SelectiveRange::reds: return primary(r);
    case SelectiveRange::greens: return primary(g);
    case SelectiveRange::blues: return primary(b);
    case SelectiveRange::cyans: return secondary(r);
    case SelectiveRange::magentas: return secondary(g);
    case SelectiveRange::yellows: return secondary(b);
    case SelectiveRange::whites: return clamp01_lang((mn - 0.5) * 2);
    case SelectiveRange::blacks: return clamp01_lang((0.5 - mx) * 2);
    case SelectiveRange::neutrals: return clamp01_lang(1 - (std::fabs(mx - 0.5) + std::fabs(mn - 0.5)) * 2);
  }
  return 0;
}

}  // namespace

void selective_color(RgbaView img, SelectiveRange range, double cyan, double magenta, double yellow, double black,
                     bool relative, ThreadPool* pool) {
  const double dc = cyan / 100;
  const double dm = magenta / 100;
  const double dy = yellow / 100;
  const double dk = black / 100;
  if (dc == 0 && dm == 0 && dy == 0 && dk == 0) return;
  each_pixel(img, pool, [&](std::uint8_t* px) {
    if (px[3] == 0) return;
    const double r = px[0] / 255.0;
    const double g = px[1] / 255.0;
    const double b = px[2] / 255.0;
    const double w = range_weight(range, r, g, b);
    if (w <= 0) return;
    const double k = 1 - std::max(r, std::max(g, b));
    const double inv = 1 - k;
    if (inv <= 1e-6) {
      const double nk = clamp01_lang(k + (relative ? dk * k : dk) * w);
      const std::uint8_t v = u8c(js::round((1 - nk) * 255));
      px[0] = v;
      px[1] = v;
      px[2] = v;
      return;
    }
    const double c = (1 - r - k) / inv;
    const double m = (1 - g - k) / inv;
    const double y = (1 - b - k) / inv;
    const auto apply = [&](double v, double d) { return clamp01_lang(v + (relative ? d * v : d) * w); };
    const double nc = apply(c, dc);
    const double nm = apply(m, dm);
    const double ny = apply(y, dy);
    const double nk = clamp01_lang(k + (relative ? dk * k : dk) * w);
    const double ninv = 1 - nk;
    px[0] = u8c(js::round((1 - nc) * ninv * 255));
    px[1] = u8c(js::round((1 - nm) * ninv * 255));
    px[2] = u8c(js::round((1 - ny) * ninv * 255));
  });
}

void shadow_highlight(RgbaView img, double shadow_amount, double highlight_amount, double radius, double tonal_width,
                      ThreadPool* pool) {
  const double sa = shadow_amount / 100;
  const double ha = highlight_amount / 100;
  if (sa == 0 && ha == 0) return;
  std::vector<std::uint8_t> mask(img.data.begin(), img.data.end());
  blur_rgba(RgbaView{mask, img.w, img.h}, std::max(0.0, radius), BlurDims::both, 1, true, pool);
  const double width = std::max(0.01, tonal_width / 100);
  const std::uint8_t* base = img.data.data();
  each_pixel(img, pool, [&](std::uint8_t* px) {
    if (px[3] == 0) return;
    const auto i = static_cast<std::size_t>(px - base);
    const double local = luma601(mask[i], mask[i + 1], mask[i + 2]) / 255;
    const double ds = local / width;
    const double dh = (1 - local) / width;
    const double gain = 1 + sa * js::exp(-ds * ds) - ha * js::exp(-dh * dh);
    px[0] = u8c(px[0] * gain);
    px[1] = u8c(px[1] * gain);
    px[2] = u8c(px[2] * gain);
  });
}

namespace {

struct Stop {
  double at;
  std::array<double, 3> rgb;
};

// colorEffects.ts COLORAMA_PALETTES, in index order (indices are stable).
constexpr std::array<Stop, 4> kFire{{{0, {0, 0, 0}}, {0.35, {200, 30, 0}}, {0.7, {255, 190, 0}}, {1, {255, 255, 230}}}};
constexpr std::array<Stop, 7> kSpectrum{{{0, {255, 0, 0}},
                                         {0.17, {255, 255, 0}},
                                         {0.33, {0, 255, 0}},
                                         {0.5, {0, 255, 255}},
                                         {0.67, {0, 0, 255}},
                                         {0.83, {255, 0, 255}},
                                         {1, {255, 0, 0}}}};
constexpr std::array<Stop, 2> kRampGrey{{{0, {0, 0, 0}}, {1, {255, 255, 255}}}};
constexpr std::array<Stop, 3> kIce{{{0, {0, 4, 40}}, {0.5, {0, 140, 210}}, {1, {230, 250, 255}}}};
constexpr std::array<Stop, 3> kSolarize{{{0, {0, 0, 0}}, {0.5, {255, 240, 180}}, {1, {0, 0, 0}}}};

std::span<const Stop> palette(int index) {
  switch (index) {
    case 1: return kSpectrum;
    case 2: return kRampGrey;
    case 3: return kIce;
    case 4: return kSolarize;
    default: return kFire;
  }
}

std::array<double, 3> sample_palette(std::span<const Stop> stops, double t) {
  const double x = t < 0 ? 0 : t > 1 ? 1 : t;
  if (x <= stops.front().at) return stops.front().rgb;
  if (x >= stops.back().at) return stops.back().rgb;
  for (std::size_t i = 0; i + 1 < stops.size(); ++i) {
    const Stop& a = stops[i];
    const Stop& b = stops[i + 1];
    if (x >= a.at && x <= b.at) {
      const double span = b.at - a.at;
      const double f = span <= 0 ? 0 : (x - a.at) / span;
      return {a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f, a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f,
              a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f};
    }
  }
  return stops.back().rgb;
}

}  // namespace

void colorama(RgbaView img, int palette_index, double phase_shift, double cycle_repetitions, double blend_with_original,
              ThreadPool* pool) {
  const std::span<const Stop> stops = palette(palette_index);
  const double phase = phase_shift / 360;
  const double reps = std::max(0.01, cycle_repetitions);
  const double keep = blend_with_original < 0 ? 0 : blend_with_original > 1 ? 1 : blend_with_original;
  each_pixel(img, pool, [&](std::uint8_t* px) {
    if (px[3] == 0) return;
    const double r = px[0];
    const double g = px[1];
    const double b = px[2];
    const double t = luma601(r, g, b) / 255;
    double u = std::fmod(t * reps + phase, 1.0);
    if (u < 0) u += 1;
    const auto p = sample_palette(stops, u);
    px[0] = u8c(p[0] + (r - p[0]) * keep);
    px[1] = u8c(p[1] + (g - p[1]) * keep);
    px[2] = u8c(p[2] + (b - p[2]) * keep);
  });
}

}  // namespace premation::effects
