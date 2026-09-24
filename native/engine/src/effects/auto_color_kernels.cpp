// Port of src/core/effects/aeColorAdvanced.ts — the histogram autos (Equalize,
// Auto Levels / Contrast / Color) and the HSL colour selectors (Change Color,
// Change to Color, Leave Color, Toner).
//
// The TS builds its tables in `Uint8Array`s, whose store TRUNCATES (unlike the
// clamped pixel buffer, which rounds half to even) — `u8t` below; the pixel
// writes are `u8c` as everywhere else. Histograms are integer counts, so they
// are gathered per row chunk and summed without changing a value.
#include <algorithm>
#include <array>
#include <vector>

#include "color_space.hpp"
#include "kernels.hpp"

namespace premation::effects {

namespace {

using Table = std::array<std::uint8_t, 256>;
using Hist = std::array<std::uint32_t, 256>;

struct Hists {
  Hist r{}, g{}, b{};
  std::uint32_t n = 0;
};

Hists histograms(RgbaView img, ThreadPool* pool) {
  // Per-chunk histograms merged in chunk order: sums of counts, exact.
  const int chunks = std::max(1, std::min(img.h, 64));
  std::vector<Hists> part(static_cast<std::size_t>(chunks));
  const auto w = static_cast<std::size_t>(img.w);
  const std::uint8_t* data = img.data.data();
  for_rows(
      pool, chunks,
      [&](int c0, int c1) {
        for (int c = c0; c < c1; ++c) {
          Hists& hs = part[static_cast<std::size_t>(c)];
          const int y0 = static_cast<int>(static_cast<std::int64_t>(c) * img.h / chunks);
          const int y1 = static_cast<int>(static_cast<std::int64_t>(c + 1) * img.h / chunks);
          const std::uint8_t* p = data + static_cast<std::size_t>(y0) * w * 4;
          const std::uint8_t* e = data + static_cast<std::size_t>(y1) * w * 4;
          for (; p != e; p += 4) {  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
            if (p[3] == 0) continue;
            ++hs.r[p[0]];
            ++hs.g[p[1]];
            ++hs.b[p[2]];
            ++hs.n;
          }
        }
      },
      1);
  Hists out;
  for (const Hists& hs : part) {
    for (std::size_t i = 0; i < 256; ++i) {
      out.r[i] += hs.r[i];
      out.g[i] += hs.g[i];
      out.b[i] += hs.b[i];
    }
    out.n += hs.n;
  }
  return out;
}

void apply_tables(RgbaView img, const Table& rt, const Table& gt, const Table& bt, double blend, ThreadPool* pool) {
  const double k = clamp01(1 - blend / 100);
  if (k <= 0) return;
  each_pixel(img, pool, [&](std::uint8_t* px) {
    if (px[3] == 0) return;
    const int r = px[0];
    const int g = px[1];
    const int b = px[2];
    px[0] = u8c(r + (rt[static_cast<std::size_t>(r)] - r) * k);
    px[1] = u8c(g + (gt[static_cast<std::size_t>(g)] - g) * k);
    px[2] = u8c(b + (bt[static_cast<std::size_t>(b)] - b) * k);
  });
}

int percentile(const Hist& hist, double total, double frac) {
  if (total <= 0) return 0;
  const double target = total * clamp01(frac);
  double acc = 0;
  for (std::size_t i = 0; i < 256; ++i) {
    acc += hist[i];
    if (acc >= target && hist[i] > 0) return static_cast<int>(i);
  }
  return 255;
}

Table stretch_table(double lo, double hi) {
  Table t{};
  const double span = hi - lo;
  for (std::size_t i = 0; i < 256; ++i) {
    t[i] = span <= 0 ? static_cast<std::uint8_t>(i) : u8t(clamp255(((static_cast<double>(i) - lo) / span) * 255));
  }
  return t;
}

}  // namespace

void equalize(RgbaView img, double mode, double amount, double blend, ThreadPool* pool) {
  const Hists hs = histograms(img, pool);
  if (hs.n == 0) return;
  const double n = hs.n;
  const auto cdf_table = [&](const Hist& hist) {
    Table t{};
    double acc = 0;
    for (std::size_t i = 0; i < 256; ++i) {
      acc += hist[i];
      t[i] = u8t(clamp255((acc / n) * 255));
    }
    return t;
  };
  const double k = clamp01(amount / 100);
  const auto mix = [&](const Table& t) {
    Table out{};
    for (std::size_t i = 0; i < 256; ++i) {
      const double di = static_cast<double>(i);
      out[i] = u8t(clamp255(di + (t[i] - di) * k));
    }
    return out;
  };
  if (js::round(mode) == 1) {
    Hist lh{};
    const std::uint8_t* d = img.data.data();
    for (std::size_t i = 0; i < img.pixels(); ++i) {
      const std::uint8_t* p = d + i * 4;
      if (p[3] == 0) continue;
      ++lh[static_cast<std::size_t>(js::round(clamp255(luma709(p[0], p[1], p[2]))))];
    }
    const Table t = mix(cdf_table(lh));
    apply_tables(img, t, t, t, blend, pool);
    return;
  }
  apply_tables(img, mix(cdf_table(hs.r)), mix(cdf_table(hs.g)), mix(cdf_table(hs.b)), blend, pool);
}

void auto_levels(RgbaView img, double black_clip, double white_clip, double blend, ThreadPool* pool) {
  const Hists hs = histograms(img, pool);
  if (hs.n == 0) return;
  const double n = hs.n;
  const double lo = clamp01(black_clip / 100);
  const double hi = 1 - clamp01(white_clip / 100);
  apply_tables(img, stretch_table(percentile(hs.r, n, lo), percentile(hs.r, n, hi)),
               stretch_table(percentile(hs.g, n, lo), percentile(hs.g, n, hi)),
               stretch_table(percentile(hs.b, n, lo), percentile(hs.b, n, hi)), blend, pool);
}

void auto_contrast(RgbaView img, double black_clip, double white_clip, double blend, ThreadPool* pool) {
  const Hists hs = histograms(img, pool);
  if (hs.n == 0) return;
  Hist all{};
  for (std::size_t i = 0; i < 256; ++i) all[i] = hs.r[i] + hs.g[i] + hs.b[i];
  const double total = static_cast<double>(hs.n) * 3;
  const int lo = percentile(all, total, clamp01(black_clip / 100));
  const int hi = percentile(all, total, 1 - clamp01(white_clip / 100));
  const Table t = stretch_table(lo, hi);
  apply_tables(img, t, t, t, blend, pool);
}

void auto_color(RgbaView img, double black_clip, double white_clip, double snap_neutral, double blend,
                ThreadPool* pool) {
  const Hists hs = histograms(img, pool);
  if (hs.n == 0) return;
  const double n = hs.n;
  const double lo = clamp01(black_clip / 100);
  const double hi = 1 - clamp01(white_clip / 100);
  const auto build = [&](const Hist& hist) { return stretch_table(percentile(hist, n, lo), percentile(hist, n, hi)); };
  Table rt = build(hs.r);
  Table gt = build(hs.g);
  Table bt = build(hs.b);
  const double strength = clamp01(snap_neutral / 100);
  if (strength > 0) {
    const auto med_of = [&](const Hist& hist, const Table& table) {
      Hist post{};
      for (std::size_t i = 0; i < 256; ++i) post[table[i]] += hist[i];
      return percentile(post, n, 0.5);
    };
    const int mr = med_of(hs.r, rt);
    const int mg = med_of(hs.g, gt);
    const int mb = med_of(hs.b, bt);
    const double target = (mr + mg + mb) / 3.0;
    const auto gamma_for = [&](double median) {
      const double m = clamp01(median / 255);
      const double t = clamp01(target / 255);
      if (m <= 0.001 || m >= 0.999 || t <= 0.001 || t >= 0.999) return 1.0;
      const double g = js::log(m) / js::log(t);
      return std::min(3.0, std::max(1.0 / 3, g));
    };
    const auto warp = [&](Table& table, double gamma) {
      const double g = 1 + (gamma - 1) * strength;
      if (std::fabs(g - 1) < 1e-4) return;
      for (std::size_t i = 0; i < 256; ++i) table[i] = u8t(clamp255(js::pow(table[i] / 255.0, 1 / g) * 255));
    };
    warp(rt, gamma_for(mr));
    warp(gt, gamma_for(mg));
    warp(bt, gamma_for(mb));
  }
  apply_tables(img, rt, gt, bt, blend, pool);
}

void change_color(RgbaView img, const Rgb& target, double hue_tol, double sat_tol, double light_tol, double softness,
                  double hue_shift, double sat_scale, double light_scale, bool invert, ThreadPool* pool) {
  const Hsl t = rgb_to_hsl(target.r, target.g, target.b);
  const double h_t = clamp01(hue_tol / 100) * 0.5;
  const double s_t = clamp01(sat_tol / 100);
  const double l_t = clamp01(light_tol / 100);
  const double soft = clamp01(softness / 100);
  each_pixel(img, pool, [&](std::uint8_t* px) {
    if (px[3] == 0) return;
    const Hsl c = rgb_to_hsl(px[0], px[1], px[2]);
    const double dh = 1 - smoothstep(h_t * (1 - soft), h_t, hue_distance(c.h, t.h));
    const double ds = 1 - smoothstep(s_t * (1 - soft), s_t, std::fabs(c.s - t.s));
    const double dl = 1 - smoothstep(l_t * (1 - soft), l_t, std::fabs(c.l - t.l));
    double m = dh * ds * dl;
    if (invert) m = 1 - m;
    if (m <= 0) return;
    const double nh = std::fmod(c.h + hue_shift / 360 + 1, 1.0);
    const double ns = clamp01(c.s * (1 + sat_scale / 100));
    const double nl = clamp01(c.l * (1 + light_scale / 100));
    const auto rgb = hsl_to_rgb(nh, ns, nl);
    for (std::size_t k = 0; k < 3; ++k) px[k] = u8c(px[k] + (rgb[k] - px[k]) * m);
  });
}

void change_to_color(RgbaView img, const Rgb& from, const Rgb& to, double hue_tol, double sat_tol, double light_tol,
                     double softness, bool preserve_lightness, ThreadPool* pool) {
  const Hsl f = rgb_to_hsl(from.r, from.g, from.b);
  const Hsl d = rgb_to_hsl(to.r, to.g, to.b);
  const double h_t = clamp01(hue_tol / 100) * 0.5;
  const double s_t = clamp01(sat_tol / 100);
  const double l_t = clamp01(light_tol / 100);
  const double soft = clamp01(softness / 100);
  each_pixel(img, pool, [&](std::uint8_t* px) {
    if (px[3] == 0) return;
    const Hsl c = rgb_to_hsl(px[0], px[1], px[2]);
    const double mh = 1 - smoothstep(h_t * (1 - soft), h_t, hue_distance(c.h, f.h));
    const double ms = 1 - smoothstep(s_t * (1 - soft), s_t, std::fabs(c.s - f.s));
    const double ml = 1 - smoothstep(l_t * (1 - soft), l_t, std::fabs(c.l - f.l));
    const double m = mh * ms * ml;
    if (m <= 0) return;
    const double nl = preserve_lightness ? clamp01(c.l + (d.l - f.l)) : d.l;
    const auto rgb = hsl_to_rgb(d.h, d.s, nl);
    for (std::size_t k = 0; k < 3; ++k) px[k] = u8c(px[k] + (rgb[k] - px[k]) * m);
  });
}

void leave_color(RgbaView img, const Rgb& target, double tolerance, double softness, double amount, ThreadPool* pool) {
  const double th = rgb_to_hsl(target.r, target.g, target.b).h;
  const double tol = clamp01(tolerance / 100) * 0.5;
  const double soft = clamp01(softness / 100);
  const double strength = clamp01(amount / 100);
  each_pixel(img, pool, [&](std::uint8_t* px) {
    if (px[3] == 0) return;
    const double r = px[0];
    const double g = px[1];
    const double b = px[2];
    const double h = rgb_to_hsl(r, g, b).h;
    const double keep = 1 - smoothstep(tol * (1 - soft), tol, hue_distance(h, th));
    const double drain = (1 - keep) * strength;
    if (drain <= 0) return;
    const double y = luma709(r, g, b);
    px[0] = u8c(r + (y - r) * drain);
    px[1] = u8c(g + (y - g) * drain);
    px[2] = u8c(b + (y - b) * drain);
  });
}

void toner(RgbaView img, const std::array<Rgb, 5>& stops, double blend, ThreadPool* pool) {
  Table rt{};
  Table gt{};
  Table bt{};
  for (std::size_t i = 0; i < 256; ++i) {
    const double p = (static_cast<double>(i) / 255) * 4;
    const double idx = std::min(3.0, std::floor(p));
    const double f = p - idx;
    const Rgb& a = stops[static_cast<std::size_t>(idx)];
    const Rgb& b = stops[static_cast<std::size_t>(idx) + 1];
    rt[i] = u8t(clamp255(a.r + (b.r - a.r) * f));
    gt[i] = u8t(clamp255(a.g + (b.g - a.g) * f));
    bt[i] = u8t(clamp255(a.b + (b.b - a.b) * f));
  }
  const double k = clamp01(1 - blend / 100);
  if (k <= 0) return;
  each_pixel(img, pool, [&](std::uint8_t* px) {
    if (px[3] == 0) return;
    const int r = px[0];
    const int g = px[1];
    const int b = px[2];
    const auto y = static_cast<std::size_t>(js::round(clamp255(luma709(r, g, b))));
    px[0] = u8c(r + (rt[y] - r) * k);
    px[1] = u8c(g + (gt[y] - g) * k);
    px[2] = u8c(b + (bt[y] - b) * k);
  });
}

}  // namespace premation::effects
