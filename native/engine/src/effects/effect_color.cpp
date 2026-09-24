// The bake chain's non-kernel colour and generator routes, ported from the TS:
//   colorLut.ts + aeRoundSevenLuts.ts   per-channel LUT effects
//   effectColorMatrix.ts                 tint / channel-mixer (+ the CSS family's matrices)
//   effects.ts `css`                     the CSS filter strings the chain batches
//   proceduralCanvas2d.ts                gradient-ramp, fractal-noise
// Same operation order, V8's Math (motion_jsmath), Float32 table stores and
// Uint8ClampedArray pixel stores as the TS.

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "effect_chain.hpp"
#include "jsmath.hpp"
#include "noise_hash.hpp"
#include "numconv.hpp"
#include "pixel_ops.hpp"
#include "raster/css.hpp"

namespace premation::effects {
namespace {

using raster::json::Value;
namespace js = motion::js;

double n(const Value& p, std::string_view k) {
  const Value& v = p[k];
  return v.is_number() ? v.num() : 0;
}
std::string jsnum(double v) { return js::number_to_string(v); }
float f32(double v) { return static_cast<float>(v); }

// ── colorLut.ts ──────────────────────────────────────────────────────────────

using Table = std::vector<float>;

Table identity_table() {
  Table t(256);
  for (int i = 0; i < 256; ++i) t[static_cast<std::size_t>(i)] = static_cast<float>(i);
  return t;
}

Table levels_table(double in_black, double in_white, double gamma, double out_black, double out_white) {
  Table t(256);
  const double span = std::max(1e-6, in_white - in_black);
  const double g = 1 / std::max(1e-3, gamma);
  for (int i = 0; i < 256; ++i) {
    double v = (i - in_black) / span;
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    v = js::pow(v, g);
    t[static_cast<std::size_t>(i)] = f32(clamp255(js::round(out_black + v * (out_white - out_black))));
  }
  return t;
}

using Pt = std::array<double, 2>;

Table curves_table(std::vector<Pt> pts) {
  std::ranges::stable_sort(pts, [](const Pt& a, const Pt& b) { return a[0] - b[0] < 0; });
  if (pts.size() < 2) return identity_table();
  Table t(256);
  const std::size_t cnt = pts.size();
  std::vector<double> tangents(cnt);
  for (std::size_t i = 0; i < cnt; ++i) {
    const Pt& p0 = pts[i == 0 ? 0 : i - 1];
    const Pt& p1 = pts[std::min(cnt - 1, i + 1)];
    const double dx = p1[0] - p0[0];
    tangents[i] = dx == 0 ? 0 : (p1[1] - p0[1]) / dx;
  }
  std::size_t seg = 0;
  for (int i = 0; i < 256; ++i) {
    while (seg < cnt - 2 && i > pts[seg + 1][0]) ++seg;
    const auto [x0, y0] = pts[seg];
    const auto [x1, y1] = pts[seg + 1];
    const double dx = x1 - x0;
    const double u = dx <= 0 ? 0 : std::max(0.0, std::min(1.0, (i - x0) / dx));
    const double u2 = u * u;
    const double u3 = u2 * u;
    const double h00 = 2 * u3 - 3 * u2 + 1;
    const double h10 = u3 - 2 * u2 + u;
    const double h01 = -2 * u3 + 3 * u2;
    const double h11 = u3 - u2;
    const double m0 = tangents[seg] * dx;
    const double m1 = tangents[seg + 1] * dx;
    t[static_cast<std::size_t>(i)] = f32(clamp255(js::round(h00 * y0 + h10 * m0 + h01 * y1 + h11 * m1)));
  }
  return t;
}

Table posterize_table(double levels) {
  const double cnt = std::max(2.0, std::min(255.0, js::round(levels)));
  Table t(256);
  for (int i = 0; i < 256; ++i) {
    const double band = js::round((i / 255.0) * (cnt - 1));
    t[static_cast<std::size_t>(i)] = f32(clamp255(js::round((band / (cnt - 1)) * 255)));
  }
  return t;
}

/// curvePoints: the well-formed [x, y] pairs of a Curves param, or none when absent / < 2 / the identity ramp.
std::optional<std::vector<Pt>> curve_points(const Value& p, std::string_view key) {
  const Value& raw = p[key];
  if (!raw.is_array()) return std::nullopt;
  std::vector<Pt> pts;
  for (const auto& q : raw.items()) {
    if (q.is_array() && q.size() == 2 && q[std::size_t{0}].is_number() && q[std::size_t{1}].is_number()) {
      pts.push_back({q[std::size_t{0}].num(), q[std::size_t{1}].num()});
    }
  }
  if (pts.size() < 2) return std::nullopt;
  const bool identity = pts.size() == 2 && pts[0][0] == 0 && pts[0][1] == 0 && pts[1][0] == 255 && pts[1][1] == 255;
  if (identity) return std::nullopt;
  return pts;
}

ChannelLut uniform(const Table& t) { return {t, t, t}; }

ChannelLut curves_tables(const Value& p) {
  const auto composite = curve_points(p, "points");
  const Table base = composite ? curves_table(*composite) : identity_table();
  const auto per_channel = [&](std::string_view key) {
    const auto pts = curve_points(p, key);
    if (!pts) return base;
    const Table own = curves_table(*pts);
    Table out(256);
    for (std::size_t i = 0; i < 256; ++i) out[i] = own[static_cast<std::size_t>(clamp255(js::round(base[i])))];
    return out;
  };
  return {per_channel("redPoints"), per_channel("greenPoints"), per_channel("bluePoints")};
}

double tone_weight(double x, int edge, double width) {
  const double d = (edge == 0 ? x : 1 - x) / width;
  return js::exp(-d * d);
}
double mid_weight(double x, double width) {
  const double d = (x - 0.5) / width;
  return js::exp(-d * d);
}

ChannelLut lumetri_tables(const Value& p) {
  const double exposure = n(p, "exposure");
  const double contrast = n(p, "contrast");
  const double highlights = n(p, "highlights") / 100;
  const double shadows = n(p, "shadows") / 100;
  const double whites = n(p, "whites") / 100;
  const double blacks = n(p, "blacks") / 100;
  const double temperature = n(p, "temperature") / 100;
  const double tint = n(p, "tint") / 100;
  const double gain = js::pow(2, exposure);
  const double k = 1 + contrast / 100;
  const std::array<double, 3> wb{1 + 0.3 * temperature, 1 - 0.3 * tint, 1 - 0.3 * temperature};
  const auto build = [&](double channel_gain) {
    Table t(256);
    for (int i = 0; i < 256; ++i) {
      double x = (i / 255.0) * channel_gain * gain;
      x = x < 0 ? 0 : x > 1 ? 1 : x;
      x = (x - 0.5) * k + 0.5;
      x = x < 0 ? 0 : x > 1 ? 1 : x;
      x += 0.5 * (shadows * tone_weight(x, 0, 0.35) + blacks * tone_weight(x, 0, 0.15) + highlights * tone_weight(x, 1, 0.35) +
                  whites * tone_weight(x, 1, 0.15));
      x = x < 0 ? 0 : x > 1 ? 1 : x;
      t[static_cast<std::size_t>(i)] = f32(clamp255(js::round(x * 255)));
    }
    return t;
  };
  return {build(wb[0]), build(wb[1]), build(wb[2])};
}

Table exposure_table(double stops, double offset, double gamma) {
  Table t(256);
  const double gain = js::pow(2, stops);
  const double inv_gamma = gamma > 0.0001 ? 1 / gamma : 1;
  for (int i = 0; i < 256; ++i) {
    const double linear = (i / 255.0) * gain + offset;
    const double clamped = linear < 0 ? 0 : linear > 1 ? 1 : linear;
    t[static_cast<std::size_t>(i)] = f32(clamp255(js::round(js::pow(clamped, inv_gamma) * 255)));
  }
  return t;
}

ChannelLut color_balance_tables(const Value& p) {
  const auto build = [](double shadow, double mid, double high) {
    const double s = shadow / 100;
    const double m = mid / 100;
    const double hi = high / 100;
    Table t(256);
    for (int i = 0; i < 256; ++i) {
      const double x0 = i / 255.0;
      double x = x0 + 0.5 * (s * tone_weight(x0, 0, 0.35) + m * mid_weight(x0, 0.35) + hi * tone_weight(x0, 1, 0.35));
      x = x < 0 ? 0 : x > 1 ? 1 : x;
      t[static_cast<std::size_t>(i)] = f32(clamp255(js::round(x * 255)));
    }
    return t;
  };
  return {build(n(p, "shadowRed"), n(p, "midtoneRed"), n(p, "highlightRed")),
          build(n(p, "shadowGreen"), n(p, "midtoneGreen"), n(p, "highlightGreen")),
          build(n(p, "shadowBlue"), n(p, "midtoneBlue"), n(p, "highlightBlue"))};
}

ChannelLut gamma_pedestal_gain_tables(const Value& p) {
  struct Transfer {
    double inv_gamma, pedestal, gain;
    [[nodiscard]] double operator()(double x) const {
      const double base = x < 0 ? 0 : x > 1 ? 1 : x;
      return pedestal + gain * js::pow(base, inv_gamma);
    }
  };
  const auto transfer = [](double gamma, double pedestal, double gain) { return Transfer{gamma > 0.0001 ? 1 / gamma : 1, pedestal, gain}; };
  const Transfer master = transfer(n(p, "gamma"), n(p, "pedestal"), n(p, "gain"));
  const auto build = [&](std::string_view gk, std::string_view pk, std::string_view nk) {
    const Transfer own = transfer(n(p, gk), n(p, pk), n(p, nk));
    Table t(256);
    for (int i = 0; i < 256; ++i) {
      const double x = master(own(i / 255.0));
      t[static_cast<std::size_t>(i)] = f32(clamp255(js::round((x < 0 ? 0 : x > 1 ? 1 : x) * 255)));
    }
    return t;
  };
  return {build("redGamma", "redPedestal", "redGain"), build("greenGamma", "greenPedestal", "greenGain"),
          build("blueGamma", "bluePedestal", "blueGain")};
}

// aeRoundSevenLuts.ts
double unit(double x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
Table table_from(const std::function<double(double)>& f) {
  Table t(256);
  for (int i = 0; i < 256; ++i) t[static_cast<std::size_t>(i)] = f32(unit(f(i / 255.0)) * 255);
  return t;
}

ChannelLut color_offset_tables(const Value& p) {
  const double overflow = js::round(n(p, "overflow"));
  const auto shift = [overflow](double phase) {
    return [overflow, phase](double x) {
      const double v = x + (phase / 360);
      if (overflow == 1) {
        const double m = std::fmod(std::fmod(v, 2) + 2, 2);
        return m <= 1 ? m : 2 - m;
      }
      if (overflow == 2) return unit(v);
      const double frac = v - std::floor(v);
      return frac == 0 && v > 0 ? 1.0 : frac;
    };
  };
  return {table_from(shift(n(p, "redPhase"))), table_from(shift(n(p, "greenPhase"))), table_from(shift(n(p, "bluePhase")))};
}

ChannelLut threshold_rgb_tables(const Value& p) {
  const auto cut = [](double level) { return [level](double x) { return x * 255 >= level ? 1.0 : 0.0; }; };
  return {table_from(cut(n(p, "redLevel"))), table_from(cut(n(p, "greenLevel"))), table_from(cut(n(p, "blueLevel")))};
}

ChannelLut cineon_converter_tables(const Value& p) {
  const double type = js::round(n(p, "conversionType"));
  const double black_code = n(p, "tenBitBlackPoint");
  const double white_code = n(p, "tenBitWhitePoint");
  const double internal_black = n(p, "internalBlackPoint") / 255;
  const double internal_white = n(p, "internalWhitePoint") / 255;
  const double gamma = std::max(0.01, n(p, "gamma"));
  const double rolloff = n(p, "highlightRolloff") / 100;
  const double code_span = std::max(1.0, white_code - black_code);
  const double internal_span = internal_white - internal_black;
  const auto log_to_lin = [=](double x) {
    const double code = x * 1023;
    const double density = ((code - black_code) / code_span) * (js::log10(1 / 0.18) + 1);
    double lin = js::pow(10, density * gamma - js::log10(1 / 0.18));
    if (rolloff > 0 && lin > 1) lin = 1 + (1 - js::exp(-(lin - 1) / std::max(0.0001, rolloff))) * rolloff;
    return internal_black + lin * internal_span;
  };
  const auto lin_to_log = [=](double x) {
    const double lin = std::max(0.0001, (x - internal_black) / std::max(0.0001, internal_span));
    const double density = (js::log10(lin) + js::log10(1 / 0.18)) / gamma;
    const double code = black_code + (density / (js::log10(1 / 0.18) + 1)) * code_span;
    return code / 1023;
  };
  const Table t = type == 1 ? table_from(lin_to_log)
                  : type == 2 ? table_from([&](double x) { return lin_to_log(log_to_lin(x)); })
                              : table_from(log_to_lin);
  return {t, t, t};
}

// ── effects.ts css ───────────────────────────────────────────────────────────

/// effects.ts num: a finite number, else the fallback.
double num_fb(const Value& p, std::string_view k, double fb) {
  const Value& v = p[k];
  return v.is_number() && std::isfinite(v.num()) ? v.num() : fb;
}
std::string str_fb(const Value& p, std::string_view k, std::string_view fb) {
  const Value& v = p[k];
  return v.is_string() ? v.str() : std::string(fb);
}
/// effects.ts withAlpha(hex, alpha): `#rrggbb` → rgba(r,g,b,a); anything else is returned as given.
std::string with_alpha(const std::string& hex, double alpha) {
  const double a = std::max(0.0, std::min(1.0, alpha));
  std::size_t b = 0;
  std::size_t e = hex.size();
  while (b < e && std::isspace(static_cast<unsigned char>(hex[b])) != 0) ++b;
  while (e > b && std::isspace(static_cast<unsigned char>(hex[e - 1])) != 0) --e;
  const std::string_view t = std::string_view(hex).substr(b, e - b);
  const auto hexv = [](char ch) { return std::isxdigit(static_cast<unsigned char>(ch)) != 0; };
  if (t.size() != 7 || t[0] != '#' || !std::ranges::all_of(t.substr(1), hexv)) return hex;
  const int v = std::stoi(std::string(t.substr(1)), nullptr, 16);
  return "rgba(" + std::to_string((v >> 16) & 255) + "," + std::to_string((v >> 8) & 255) + "," + std::to_string(v & 255) + "," + jsnum(a) +
         ")";
}

// ── effectColorMatrix.ts ────────────────────────────────────────────────────

using M3 = std::array<double, 9>;
constexpr M3 kI3{1, 0, 0, 0, 1, 0, 0, 0, 1};
constexpr double kLR = 0.2126;
constexpr double kLG = 0.7152;
constexpr double kLB = 0.0722;

M3 mul(const M3& a, const M3& b) {
  M3 r{};
  for (std::size_t row = 0; row < 3; ++row) {
    for (std::size_t col = 0; col < 3; ++col) {
      r[row * 3 + col] = a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
    }
  }
  return r;
}
M3 saturate_matrix(double s) {
  return {kLR + (1 - kLR) * s, kLG - kLG * s, kLB - kLB * s, kLR - kLR * s, kLG + (1 - kLG) * s,
          kLB - kLB * s,       kLR - kLR * s, kLG - kLG * s, kLB + (1 - kLB) * s};
}
M3 sepia_matrix(double p) {
  constexpr M3 kS{0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131};
  M3 out{};
  for (std::size_t i = 0; i < 9; ++i) out[i] = kI3[i] * (1 - p) + kS[i] * p;
  return out;
}
M3 hue_rotate_matrix(double deg) {
  const double a = (deg * 3.141592653589793) / 180;
  const double c = js::cos(a);
  const double s = js::sin(a);
  return {kLR + c * (1 - kLR) + s * -kLR, kLG + c * -kLG + s * -kLG, kLB + c * -kLB + s * (1 - kLB),
          kLR + c * -kLR + s * 0.143,     kLG + c * (1 - kLG) + s * 0.14, kLB + c * -kLB + s * -0.283,
          kLR + c * -kLR + s * -(1 - kLR), kLG + c * -kLG + s * kLG,   kLB + c * (1 - kLB) + s * kLB};
}
M3 scale_matrix(double b) { return {b, 0, 0, 0, b, 0, 0, 0, b}; }
/// effectColorMatrix.ts hex01: `#rrggbb` (optional #) → 0..1, else black.
std::array<double, 3> hex01(const Value& v) {
  if (!v.is_string()) return {0, 0, 0};
  std::string s = v.str();
  std::size_t b = 0;
  std::size_t e = s.size();
  while (b < e && std::isspace(static_cast<unsigned char>(s[b])) != 0) ++b;
  while (e > b && std::isspace(static_cast<unsigned char>(s[e - 1])) != 0) --e;
  s = s.substr(b, e - b);
  if (!s.empty() && s[0] == '#') s.erase(0, 1);
  if (s.size() != 6 || !std::ranges::all_of(s, [](char ch) { return std::isxdigit(static_cast<unsigned char>(ch)) != 0; })) return {0, 0, 0};
  const int x = std::stoi(s, nullptr, 16);
  return {((x >> 16) & 255) / 255.0, ((x >> 8) & 255) / 255.0, (x & 255) / 255.0};
}

// ── proceduralCanvas2d.ts ────────────────────────────────────────────────────

double smooth(double t) { return t * t * (3 - 2 * t); }
double value_noise(double x, double y) {
  const double xi = std::floor(x);
  const double yi = std::floor(y);
  const double fx = smooth(x - xi);
  const double fy = smooth(y - yi);
  const double a = hash2(xi, yi);
  const double b = hash2(xi + 1, yi);
  const double c = hash2(xi, yi + 1);
  const double d = hash2(xi + 1, yi + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
double fbm4(double x, double y) {
  double sum = 0;
  double amp = 0.5;
  double freq = 1;
  for (int o = 0; o < 4; ++o) {
    sum += value_noise(x * freq, y * freq) * amp;
    freq *= 2;
    amp *= 0.5;
  }
  return sum / 0.9375;
}

}  // namespace

// ── LUT ──

bool is_lut_effect(std::string_view type) noexcept {
  static constexpr std::array<std::string_view, 9> kLut{"levels",        "curves",       "posterize",     "exposure",        "lumetri",
                                                        "color-balance", "gamma-pedestal-gain", "color-offset", "threshold-rgb"};
  return std::ranges::find(kLut, type) != kLut.end() || type == "cineon-converter";
}

ChannelLut build_channel_lut(std::string_view type, const Value& p) {
  ChannelLut tables;
  if (type == "levels") {
    tables = uniform(levels_table(n(p, "inputBlack"), n(p, "inputWhite"), n(p, "gamma"), n(p, "outputBlack"), n(p, "outputWhite")));
  } else if (type == "curves") {
    tables = curves_tables(p);
  } else if (type == "posterize") {
    tables = uniform(posterize_table(n(p, "levels")));
  } else if (type == "exposure") {
    tables = uniform(exposure_table(n(p, "exposure"), n(p, "offset"), n(p, "gammaCorrection")));
  } else if (type == "lumetri") {
    tables = lumetri_tables(p);
  } else if (type == "color-balance") {
    tables = color_balance_tables(p);
  } else if (type == "gamma-pedestal-gain") {
    tables = gamma_pedestal_gain_tables(p);
  } else if (type == "color-offset") {
    tables = color_offset_tables(p);
  } else if (type == "threshold-rgb") {
    tables = threshold_rgb_tables(p);
  } else if (type == "cineon-converter") {
    tables = cineon_converter_tables(p);
  } else {
    return {identity_table(), identity_table(), identity_table()};
  }
  // buildChannelLut composes onto the identity: lut[i] = table[clamp255(round(identity[i]))].
  ChannelLut lut{identity_table(), identity_table(), identity_table()};
  for (std::size_t i = 0; i < 256; ++i) {
    lut.r[i] = tables.r[static_cast<std::size_t>(clamp255(js::round(lut.r[i])))];
    lut.g[i] = tables.g[static_cast<std::size_t>(clamp255(js::round(lut.g[i])))];
    lut.b[i] = tables.b[static_cast<std::size_t>(clamp255(js::round(lut.b[i])))];
  }
  return lut;
}

void apply_channel_lut(RgbaView img, const ChannelLut& lut, ThreadPool* pool) {
  // clamp255(Math.round(table[v])) — an integer 0..255, stored exactly.
  std::array<std::array<std::uint8_t, 256>, 3> bytes{};
  for (std::size_t i = 0; i < 256; ++i) {
    bytes[0][i] = static_cast<std::uint8_t>(clamp255(js::round(lut.r[i])));
    bytes[1][i] = static_cast<std::uint8_t>(clamp255(js::round(lut.g[i])));
    bytes[2][i] = static_cast<std::uint8_t>(clamp255(js::round(lut.b[i])));
  }
  std::uint8_t* d = img.data.data();
  const std::size_t stride = static_cast<std::size_t>(img.w) * 4;
  for_rows(pool, img.h, [&](int y0, int y1) {
    for (std::size_t i = static_cast<std::size_t>(y0) * stride; i < static_cast<std::size_t>(y1) * stride; i += 4) {
      d[i] = bytes[0][d[i]];
      d[i + 1] = bytes[1][d[i + 1]];
      d[i + 2] = bytes[2][d[i + 2]];
    }
  });
}

// ── CSS ──

std::string effect_css(std::string_view type, const Value& p) {
  const auto scalar = [&](double def) { return num_fb(p, "amount", def); };
  if (type == "blur") return "blur(" + jsnum(scalar(6)) + "px)";
  if (type == "brightness") return "brightness(" + jsnum(scalar(130) / 100) + ")";
  if (type == "contrast") return "contrast(" + jsnum(scalar(130) / 100) + ")";
  if (type == "saturate") return "saturate(" + jsnum(scalar(160) / 100) + ")";
  if (type == "grayscale") return "grayscale(" + jsnum(scalar(100) / 100) + ")";
  if (type == "sepia") return "sepia(" + jsnum(scalar(80) / 100) + ")";
  if (type == "hue-rotate") return "hue-rotate(" + jsnum(scalar(90)) + "deg)";
  if (type == "invert") return "invert(" + jsnum(scalar(100) / 100) + ")";
  if (type == "glow") {
    const double s = std::max(0.0, std::min(100.0, num_fb(p, "spread", 0))) / 100;
    const double r = std::max(0.0, num_fb(p, "radius", 16) * (1 - s));
    return "drop-shadow(0 0 " + jsnum(r) + "px " + with_alpha(str_fb(p, "color", "#78b4ff"), num_fb(p, "intensity", 90) / 100) + ")";
  }
  if (type == "drop-shadow") {
    const double d = num_fb(p, "distance", 6);
    const double rad = (num_fb(p, "angle", 135) * 3.141592653589793) / 180;
    const std::string dx = js::to_fixed(js::cos(rad) * d, 1);
    const std::string dy = js::to_fixed(js::sin(rad) * d, 1);
    const std::string color = with_alpha(str_fb(p, "color", "#000000"), num_fb(p, "opacity", 55) / 100);
    const double s = std::max(0.0, std::min(100.0, num_fb(p, "spread", 0))) / 100;
    const double soft = std::max(0.0, num_fb(p, "softness", 12) * (1 - s));
    return "drop-shadow(" + dx + "px " + dy + "px " + jsnum(soft) + "px " + color + ")";
  }
  if (type == "hue-saturation") {
    std::string out;
    const double hue = num_fb(p, "hue", 0);
    if (hue != 0) out += "hue-rotate(" + jsnum(hue) + "deg) ";
    out += "saturate(" + jsnum((100 + num_fb(p, "saturation", 0)) / 100) + ") ";
    out += "brightness(" + jsnum((100 + num_fb(p, "lightness", 0)) / 100) + ")";
    return out;
  }
  return "";
}

// ── colour matrix ──

bool is_color_matrix_effect(std::string_view type) noexcept {
  static constexpr std::array<std::string_view, 10> kColor{"brightness", "contrast", "saturate",       "grayscale", "sepia",
                                                           "hue-rotate", "hue-saturation", "invert", "tint",      "channel-mixer"};
  return std::ranges::find(kColor, type) != kColor.end();
}

ColorMatrix effect_color_matrix(std::string_view type, const Value& p) {
  // The primary param (`primaryParamKey`) is `amount` for every scalar-shaped member.
  const double amt = n(p, "amount");
  M3 em = kI3;
  std::array<double, 3> eo{0, 0, 0};
  if (type == "brightness") {
    em = scale_matrix(amt / 100);
  } else if (type == "contrast") {
    const double c = amt / 100;
    const double o = 0.5 * (1 - c);
    em = {c, 0, 0, 0, c, 0, 0, 0, c};
    eo = {o, o, o};
  } else if (type == "saturate") {
    em = saturate_matrix(amt / 100);
  } else if (type == "grayscale") {
    em = saturate_matrix(1 - amt / 100);
  } else if (type == "sepia") {
    em = sepia_matrix(amt / 100);
  } else if (type == "hue-rotate") {
    em = hue_rotate_matrix(amt);
  } else if (type == "hue-saturation") {
    em = mul(scale_matrix((100 + n(p, "lightness")) / 100), mul(saturate_matrix((100 + n(p, "saturation")) / 100), hue_rotate_matrix(n(p, "hue"))));
  } else if (type == "invert") {
    const double i = amt / 100;
    const double k = 1 - 2 * i;
    em = {k, 0, 0, 0, k, 0, 0, 0, k};
    eo = {i, i, i};
  } else if (type == "tint") {
    const auto b = hex01(p["mapBlack"]);
    const auto w = hex01(p["mapWhite"]);
    const double a = amt / 100;
    M3 tint{};
    for (std::size_t i = 0; i < 3; ++i) {
      const double d = w[i] - b[i];
      tint[i * 3] = d * kLR;
      tint[i * 3 + 1] = d * kLG;
      tint[i * 3 + 2] = d * kLB;
    }
    for (std::size_t i = 0; i < 9; ++i) em[i] = kI3[i] * (1 - a) + tint[i] * a;
    eo = {b[0] * a, b[1] * a, b[2] * a};
  } else if (type == "channel-mixer") {
    const auto q = [&](std::string_view k) { return n(p, k) / 100; };
    const double rr = q("redRed"), rg = q("redGreen"), rb = q("redBlue");
    const double gr = q("greenRed"), gg = q("greenGreen"), gb = q("greenBlue");
    const double br = q("blueRed"), bg = q("blueGreen"), bb = q("blueBlue");
    const bool mono = p["monochrome"].is_bool() && p["monochrome"].truthy();
    em = mono ? M3{rr, rg, rb, rr, rg, rb, rr, rg, rb} : M3{rr, rg, rb, gr, gg, gb, br, bg, bb};
    eo = {q("redConst"), q("greenConst"), q("blueConst")};
  } else {
    return {};
  }
  // effectColorMatrix([e]): compose onto the identity.
  ColorMatrix cm;
  cm.m = mul(em, kI3);
  const std::array<double, 3> off{0, 0, 0};
  cm.offset = {em[0] * off[0] + em[1] * off[1] + em[2] * off[2] + eo[0], em[3] * off[0] + em[4] * off[1] + em[5] * off[2] + eo[1],
               em[6] * off[0] + em[7] * off[1] + em[8] * off[2] + eo[2]};
  return cm;
}

void apply_color_matrix_image(RgbaView img, const ColorMatrix& cm, ThreadPool* pool) {
  const auto& m = cm.m;
  const double o0 = cm.offset[0];
  const double o1 = cm.offset[1];
  const double o2 = cm.offset[2];
  std::uint8_t* d = img.data.data();
  const std::size_t stride = static_cast<std::size_t>(img.w) * 4;
  for_rows(pool, img.h, [&](int y0, int y1) {
    for (std::size_t i = static_cast<std::size_t>(y0) * stride; i < static_cast<std::size_t>(y1) * stride; i += 4) {
      const double r = d[i] / 255.0;
      const double g = d[i + 1] / 255.0;
      const double b = d[i + 2] / 255.0;
      d[i] = u8c((m[0] * r + m[1] * g + m[2] * b + o0) * 255);
      d[i + 1] = u8c((m[3] * r + m[4] * g + m[5] * b + o1) * 255);
      d[i + 2] = u8c((m[6] * r + m[7] * g + m[8] * b + o2) * 255);
    }
  });
}

// ── procedural ──

bool is_procedural_effect(std::string_view type) noexcept { return type == "gradient-ramp" || type == "fractal-noise"; }

void apply_procedural_effect(std::string_view type, const Value& p, raster::Canvas2D& oc, double w, double h,
                             std::unique_ptr<raster::Canvas2D>& noise) {
  if (type == "gradient-ramp") {
    const double blend = n(p, "blend");
    const std::string color_a = p["colorA"].is_string() ? p["colorA"].str() : "#ff0000";
    const std::string color_b = p["colorB"].is_string() ? p["colorB"].str() : "#0000ff";
    const double angle = p["angle"].is_number() ? p["angle"].num() : 90;
    const double rad = (angle * 3.141592653589793) / 180;
    const double cx = w / 2;
    const double cy = h / 2;
    const double half = (std::abs(w * js::cos(rad)) + std::abs(h * js::sin(rad))) / 2;
    auto g = std::make_shared<raster::Gradient>();  // shared: a Style references its gradient (canvas.hpp)
    g->kind = raster::Gradient::Kind::linear;
    g->p = {cx - js::cos(rad) * half, cy - js::sin(rad) * half, cx + js::cos(rad) * half, cy + js::sin(rad) * half, 0, 0};
    if (const auto c = raster::css::parse_color(color_a)) g->add_stop(0, *c);
    if (const auto c = raster::css::parse_color(color_b)) g->add_stop(1, *c);
    oc.save();
    oc.setTransform({});
    (void)oc.setGlobalCompositeOperation("source-atop");
    oc.setGlobalAlpha(std::max(0.0, std::min(1.0, blend / 100)));
    raster::Style s;
    s.kind = raster::Style::Kind::gradient;
    s.gradient = g;
    oc.setFillStyle(s);
    oc.fillRect(0, 0, w, h);
    oc.restore();
    return;
  }
  if (type == "fractal-noise") {
    const double scale = std::max(1.0, n(p, "scale"));
    constexpr double kLong = 256;
    const double nw = w >= h ? kLong : std::max(8.0, js::round((w / h) * kLong));
    const double nh = w >= h ? std::max(8.0, js::round((h / w) * kLong)) : kLong;
    const auto iw = static_cast<std::uint32_t>(nw);
    const auto ih = static_cast<std::uint32_t>(nh);
    if (!noise) noise = oc.create_canvas(iw, ih);
    else if (noise->width() != iw || noise->height() != ih) noise->resize(iw, ih);
    std::vector<std::uint8_t> data(static_cast<std::size_t>(iw) * ih * 4);
    const double freq = scale / kLong;
    for (std::uint32_t y = 0; y < ih; ++y) {
      for (std::uint32_t x = 0; x < iw; ++x) {
        const auto v = static_cast<std::uint8_t>(js::round(fbm4(x * freq, y * freq) * 255));
        const std::size_t i = (static_cast<std::size_t>(y) * iw + x) * 4;
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
    noise->putImageData(data, iw, ih, 0, 0);
    oc.save();
    oc.setTransform({});
    (void)oc.setGlobalCompositeOperation("source-atop");
    oc.setImageSmoothing(true);
    oc.drawImage(*noise, 0, 0, nw, nh, 0, 0, w, h);
    oc.restore();
  }
}

}  // namespace premation::effects
