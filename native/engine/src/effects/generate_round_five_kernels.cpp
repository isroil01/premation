// Port of src/core/effects/generateRoundFive.ts — Star Burst, Snowfall,
// Rainfall, Write-on (classic line and mask-path forms), Light Burst.
//
// The particle effects stamp in particle order, and a later stamp composites
// over an earlier one. Threads split OUTPUT rows; each replays every stamp in
// that order clipped to its rows, so every pixel sees the TS's sequence.
#include <algorithm>
#include <array>
#include <cmath>
#include <vector>

#include "kernels.hpp"
#include "noise_hash.hpp"

namespace premation::effects {

namespace {

constexpr double kPi = 3.141592653589793;
constexpr double kSqrt1_2 = 0.7071067811865476;  // Math.SQRT1_2

double hyp(double a, double b) { return jhypot2(a, b); }

double fract(double v) { return v - std::floor(v); }

/// `(v % m + m) % m` with JS `%` (fmod).
double wrap(double v, double m) { return std::fmod(std::fmod(v, m) + m, m); }

struct Disc {
  double cx, cy, rad, r, g, b, a01;
};

/// `stampDisc`, rows [ry0, ry1) only.
void stamp_disc_rows(std::uint8_t* out, int w, int h, const Disc& s, int ry0, int ry1) {
  const double fx0 = std::max(0.0, std::floor(s.cx - s.rad));
  const double fx1 = std::min(static_cast<double>(w - 1), std::ceil(s.cx + s.rad));
  const double fy0 = std::max(static_cast<double>(ry0), std::floor(s.cy - s.rad));
  const double fy1 = std::min(static_cast<double>(std::min(h, ry1) - 1), std::ceil(s.cy + s.rad));
  if (!(fx0 <= fx1) || !(fy0 <= fy1)) return;
  const double inv = std::max(1e-6, s.rad);
  for (int y = static_cast<int>(fy0); y <= static_cast<int>(fy1); ++y) {
    for (int x = static_cast<int>(fx0); x <= static_cast<int>(fx1); ++x) {
      const double d = hyp(x + 0.5 - s.cx, y + 0.5 - s.cy);
      if (d > s.rad) continue;
      const double t = d / inv;
      const double cover = t < 0.6 ? 1 : 0.5 + 0.5 * js::cos(((t - 0.6) / 0.4) * kPi);
      const double sa = clamp01(s.a01 * cover);
      if (sa <= 0) continue;
      std::uint8_t* o = out + idx4(x, y, w);
      const double da = o[3] / 255.0;
      const double oa = sa + da * (1 - sa);
      if (oa <= 0) continue;
      o[0] = u8c((s.r * sa + o[0] * da * (1 - sa)) / oa);
      o[1] = u8c((s.g * sa + o[1] * da * (1 - sa)) / oa);
      o[2] = u8c((s.b * sa + o[2] * da * (1 - sa)) / oa);
      o[3] = u8c(oa * 255);
    }
  }
}

void stamp_discs(RgbaView img, const std::vector<Disc>& discs, ThreadPool* pool) {
  if (discs.empty()) return;
  for_rows(pool, img.h, [&](int y0, int y1) {
    for (const Disc& d : discs) stamp_disc_rows(img.data.data(), img.w, img.h, d, y0, y1);
  });
}

struct Star {
  double cx, cy, size, r, g, b, a01;
};

/// `stampStar`, rows [ry0, ry1) only.
void stamp_star_rows(std::uint8_t* out, int w, int h, const Star& s, int ry0, int ry1) {
  const double core = std::max(0.5, s.size * 0.5);
  const double spike_len = s.size * 4;
  const double spike_w = std::max(0.4, s.size * 0.22);
  const double reach = std::ceil(spike_len);
  const double fx0 = std::max(0.0, std::floor(s.cx - reach));
  const double fx1 = std::min(static_cast<double>(w - 1), std::ceil(s.cx + reach));
  const double fy0 = std::max(static_cast<double>(ry0), std::floor(s.cy - reach));
  const double fy1 = std::min(static_cast<double>(std::min(h, ry1) - 1), std::ceil(s.cy + reach));
  if (!(fx0 <= fx1) || !(fy0 <= fy1)) return;
  const double core2 = core * core;
  const double sw2 = spike_w * spike_w;
  const double half_len = spike_len * 0.5;
  for (int y = static_cast<int>(fy0); y <= static_cast<int>(fy1); ++y) {
    for (int x = static_cast<int>(fx0); x <= static_cast<int>(fx1); ++x) {
      const double dx = x + 0.5 - s.cx;
      const double dy = y + 0.5 - s.cy;
      const double d2 = dx * dx + dy * dy;
      double i = js::exp(-d2 / core2);
      const double ax = std::fabs(dx);
      const double ay = std::fabs(dy);
      i += 0.85 * js::exp(-(ay * ay) / sw2) * js::pow(std::max(0.0, 1 - ax / spike_len), 2);
      i += 0.85 * js::exp(-(ax * ax) / sw2) * js::pow(std::max(0.0, 1 - ay / spike_len), 2);
      const double du = std::fabs(dx * kSqrt1_2 + dy * kSqrt1_2);
      const double dv = std::fabs(-dx * kSqrt1_2 + dy * kSqrt1_2);
      i += 0.35 * js::exp(-(dv * dv) / sw2) * js::pow(std::max(0.0, 1 - du / half_len), 2);
      i += 0.35 * js::exp(-(du * du) / sw2) * js::pow(std::max(0.0, 1 - dv / half_len), 2);
      const double sv = clamp01(i * s.a01);
      if (sv <= 0.003) continue;
      std::uint8_t* o = out + idx4(x, y, w);
      o[0] = u8c(o[0] + s.r * sv);
      o[1] = u8c(o[1] + s.g * sv);
      o[2] = u8c(o[2] + s.b * sv);
      o[3] = u8c(std::max(static_cast<double>(o[3]), sv * 255));
    }
  }
}

}  // namespace

void star_burst(RgbaView img, double phase, double amount, double size, Rgb star, double blend, double seed,
                ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::fill(img.data.begin(), img.data.end(), std::uint8_t{0});
  const double n = js::round(clamp01(amount / 100) * 400);
  const double cx = w / 2.0;
  const double cy = h / 2.0;
  const double max_r = hyp(cx, cy);
  const double s = std::floor(seed);
  std::vector<Star> stars;
  for (int i = 0; i < n; ++i) {
    const double ang = hash2(i, s) * kPi * 2;
    const double speed = 0.25 + 0.75 * hash2(i, s + 101);
    const double z0 = hash2(i, s + 202);
    const double t = fract(phase / 1000 * speed + z0);
    const double rad = t * t * max_r;
    const double cos_a = js::cos(ang);
    const double sin_a = js::sin(ang);
    const double px = cx + cos_a * rad;
    const double py = cy + sin_a * rad;
    if (px < -4 || px > w + 4 || py < -4 || py > h + 4) continue;
    const double hx = std::min(static_cast<double>(w - 1), std::max(0.0, js::round(cx + cos_a * max_r * 0.5)));
    const double hy = std::min(static_cast<double>(h - 1), std::max(0.0, js::round(cy + sin_a * max_r * 0.5)));
    const std::uint8_t* ho = src.data() + idx4(static_cast<int>(hx), static_cast<int>(hy), w);
    const double mix_t = ho[3] > 8 ? 0.5 : 1;
    stars.push_back(Star{px, py, std::max(0.5, size) * (0.4 + 0.6 * t), ho[0] * (1 - mix_t) + star.r * mix_t,
                         ho[1] * (1 - mix_t) + star.g * mix_t, ho[2] * (1 - mix_t) + star.b * mix_t, 0.25 + 0.75 * t});
  }
  const double k = clamp01(blend / 100);
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (const Star& st : stars) stamp_star_rows(out, w, h, st, y0, y1);
    if (k <= 0) return;
    const std::size_t e = static_cast<std::size_t>(y1) * static_cast<std::size_t>(w) * 4;
    for (std::size_t i = static_cast<std::size_t>(y0) * static_cast<std::size_t>(w) * 4; i < e; i += 4) {
      const double sa = src[i + 3] / 255.0;
      const double da = out[i + 3] / 255.0;
      const double a = sa * k + da * (1 - k);
      if (a > 0) {
        out[i] = u8c((src[i] * sa * k + out[i] * da * (1 - k)) / a);
        out[i + 1] = u8c((src[i + 1] * sa * k + out[i + 1] * da * (1 - k)) / a);
        out[i + 2] = u8c((src[i + 2] * sa * k + out[i + 2] * da * (1 - k)) / a);
      }
      out[i + 3] = u8c(a * 255);
    }
  });
}

void snowfall(RgbaView img, double amount, double size, double evolution, double wind, double opacity, Rgb flake,
              double seed, ThreadPool* pool) {
  const double w = img.w;
  const double h = img.h;
  const double n = js::round(clamp01(amount / 100) * std::max(1.0, (w * h) / 1200));
  const double s = std::floor(seed);
  const double a01 = clamp01(opacity / 100);
  std::vector<Disc> discs;
  for (int i = 0; i < n; ++i) {
    const double fx0 = hash2(i, s) * w;
    const double fy0 = hash2(i, s + 11) * h;
    const double speed = 0.4 + 0.8 * hash2(i, s + 23);
    const double sway_amp = 2 + 8 * hash2(i, s + 37);
    const double drop = (evolution / 100) * h * speed;
    const double sway = js::sin(evolution / 40 + i * 1.7) * sway_amp;
    const double drift = (wind / 100) * drop * 0.4;
    const double px = wrap(fx0 + sway + drift, w);
    const double py = std::fmod(fy0 + drop, h + 8) - 4;
    const double rad = std::max(0.5, size) * (0.55 + 0.45 * hash2(i, s + 51));
    discs.push_back(Disc{px, py, rad, flake.r, flake.g, flake.b, a01 * (0.6 + 0.4 * speed)});
  }
  stamp_discs(img, discs, pool);
}

void rainfall(RgbaView img, double amount, double length, double angle, double evolution, double opacity, Rgb rain,
              double seed, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  const double n = js::round(clamp01(amount / 100) * std::max(1.0, (static_cast<double>(w) * h) / 2500));
  const double s = std::floor(seed);
  const double rad = (angle * kPi) / 180;
  const double dir_x = js::sin(rad);
  const double dir_y = js::cos(rad);
  const double a01 = clamp01(opacity / 100);
  const double len = std::max(2.0, length);
  struct Drop {
    double px0, py0;
  };
  std::vector<Drop> drops;
  for (int i = 0; i < n; ++i) {
    const double fx0 = hash2(i, s) * w;
    const double fy0 = hash2(i, s + 11) * h;
    const double speed = 0.8 + 0.6 * hash2(i, s + 23);
    const double travel = (evolution / 100) * h * 3 * speed;
    drops.push_back(Drop{wrap(fx0 + dir_x * travel, w), std::fmod(fy0 + dir_y * travel, h + len) - len / 2});
  }
  const double steps = std::ceil(len);
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int ry0, int ry1) {
    for (const Drop& d : drops) {
      for (int k = 0; k < steps; ++k) {
        const double x = js::round(d.px0 - dir_x * k);
        const double y = js::round(d.py0 - dir_y * k);
        if (x < 0 || x >= w || y < ry0 || y >= ry1) continue;
        const double sa = a01 * (1 - k / steps) * 0.9;
        std::uint8_t* o = out + idx4(static_cast<int>(x), static_cast<int>(y), w);
        const double da = o[3] / 255.0;
        const double oa = sa + da * (1 - sa);
        if (oa <= 0) continue;
        o[0] = u8c((rain.r * sa + o[0] * da * (1 - sa)) / oa);
        o[1] = u8c((rain.g * sa + o[1] * da * (1 - sa)) / oa);
        o[2] = u8c((rain.b * sa + o[2] * da * (1 - sa)) / oa);
        o[3] = u8c(oa * 255);
      }
    }
  });
}

void write_on_line(RgbaView img, double start_x, double start_y, double end_x, double end_y, double completion,
                   double brush_size, Rgb brush, double wobble, double taper, ThreadPool* pool) {
  const double w = img.w;
  const double h = img.h;
  const double t1 = clamp01(completion / 100);
  if (t1 <= 0) return;
  const double sx = w / 2 + start_x;
  const double sy = h / 2 + start_y;
  const double ex = w / 2 + end_x;
  const double ey = h / 2 + end_y;
  const double dx = ex - sx;
  const double dy = ey - sy;
  const double len = hyp(dx, dy);
  if (len < 1e-3) return;
  const double nx = -dy / len;
  const double ny = dx / len;
  const double amp = (wobble / 100) * len * 0.12;
  const double radius = std::max(0.5, brush_size / 2);
  const double steps = std::max(2.0, std::ceil((len * t1) / std::max(1.0, radius * 0.5)));
  std::vector<Disc> discs;
  for (int k = 0; k <= steps; ++k) {
    const double t = (k / steps) * t1;
    const double bend = amp * (js::sin(t * kPi * 3.1) * 0.7 + js::sin(t * kPi * 7.3) * 0.3);
    const double px = sx + dx * t + nx * bend;
    const double py = sy + dy * t + ny * bend;
    const double tip_span = std::max(1e-6, (taper / 100) * t1);
    const double from_tip = (t1 - t) / tip_span;
    const double thin = taper > 0 && from_tip < 1 ? 0.25 + 0.75 * from_tip : 1;
    discs.push_back(Disc{px, py, radius * thin, brush.r, brush.g, brush.b, 1});
  }
  stamp_discs(img, discs, pool);
}

void write_on_path(RgbaView img, std::span<const double> flat, double completion, double brush_size, Rgb brush,
                   double taper, ThreadPool* pool) {
  const double w = img.w;
  const double h = img.h;
  const double t1 = clamp01(completion / 100);
  const std::size_t n = flat.size() / 2;
  if (t1 <= 0 || n < 2) return;
  std::vector<double> xs(n);
  std::vector<double> ys(n);
  std::vector<double> arc(n);
  for (std::size_t i = 0; i < n; ++i) {
    xs[i] = w / 2 + flat[i * 2];
    ys[i] = h / 2 + flat[i * 2 + 1];
    arc[i] = i == 0 ? 0 : arc[i - 1] + hyp(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  }
  const double total = arc[n - 1];
  if (total < 1e-3) return;
  const double radius = std::max(0.5, brush_size / 2);
  const double drawn = total * t1;
  const double step = std::max(0.75, radius * 0.5);
  const double tip_span = std::max(1e-6, (taper / 100) * drawn);
  std::size_t seg = 1;
  std::vector<Disc> discs;
  for (double d = 0; d <= drawn; d += step) {
    while (seg < n - 1 && arc[seg] < d) ++seg;
    const double a0 = arc[seg - 1];
    const double a1 = arc[seg];
    const double f = a1 > a0 ? (d - a0) / (a1 - a0) : 0;
    const double px = xs[seg - 1] + (xs[seg] - xs[seg - 1]) * f;
    const double py = ys[seg - 1] + (ys[seg] - ys[seg - 1]) * f;
    const double from_tip = (drawn - d) / tip_span;
    const double thin = taper > 0 && from_tip < 1 ? 0.25 + 0.75 * from_tip : 1;
    discs.push_back(Disc{px, py, radius * thin, brush.r, brush.g, brush.b, 1});
  }
  stamp_discs(img, discs, pool);
}

void light_burst(RgbaView img, double center_x, double center_y, double intensity, double ray_length,
                 ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  const double gain = std::max(0.0, intensity / 100);
  const double reach = clamp01(ray_length / 100);
  if (gain <= 0 || reach <= 0) return;
  const double cx = w / 2.0 + center_x;
  const double cy = h / 2.0 + center_y;
  constexpr int kSamples = 24;
  std::array<double, kSamples + 1> ts{};
  std::array<double, kSamples + 1> wks{};
  for (int k = 1; k <= kSamples; ++k) {
    ts[static_cast<std::size_t>(k)] = (static_cast<double>(k) / kSamples) * reach;
    wks[static_cast<std::size_t>(k)] = 1 - static_cast<double>(k) / (kSamples + 1);
  }
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        double ar = 0;
        double ag = 0;
        double ab = 0;
        double aa = 0;
        double wsum = 0;
        for (std::size_t k = 1; k <= kSamples; ++k) {
          const double t = ts[k];
          const double sx = round_index(x + (cx - x) * t);
          const double sy = round_index(y + (cy - y) * t);
          if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
          const std::uint8_t* so = src.data() + idx4(static_cast<int>(sx), static_cast<int>(sy), w);
          const double wk = wks[k];
          const double a = so[3] / 255.0;
          ar += so[0] * a * wk;
          ag += so[1] * a * wk;
          ab += so[2] * a * wk;
          aa += a * wk;
          wsum += wk;
        }
        if (wsum <= 0) continue;
        const double rr = ar / wsum;
        const double rg = ag / wsum;
        const double rb = ab / wsum;
        const double boost = gain * clamp01(luma709(rr, rg, rb) / 255);
        if (boost <= 0) continue;
        std::uint8_t* o = out + idx4(x, y, w);
        o[0] = u8c(255 - (255 - o[0]) * (255 - clamp255(rr * boost)) / 255);
        o[1] = u8c(255 - (255 - o[1]) * (255 - clamp255(rg * boost)) / 255);
        o[2] = u8c(255 - (255 - o[2]) * (255 - clamp255(rb * boost)) / 255);
        o[3] = u8c(std::max(static_cast<double>(o[3]), clamp01((aa / wsum) * boost) * 255));
      }
    }
  });
}

}  // namespace premation::effects
