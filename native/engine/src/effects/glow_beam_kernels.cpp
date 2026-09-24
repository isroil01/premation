// Ports of deepGlow.ts (Deep Glow's octave pyramid) with the shared
// packages/renderer deepGlowKernel.ts arithmetic, and beamPath.ts (Energy
// Beam: spine resampling, the distance / glow field, the linear-light add).
//
// Deep Glow's separable passes keep the TS's per-pixel tap order (−16 … 16)
// and its Float32 stores; each output line is independent, so lines split
// across the pool. Beam Path is a per-pixel field.
#include <algorithm>
#include <array>
#include <cmath>
#include <vector>

#include "kernels.hpp"
#include "noise_hash.hpp"

namespace premation::effects {

namespace {

constexpr int kTaps = 16;          // DEEP_GLOW_TAPS
constexpr double kReach = 4;       // DEEP_GLOW_REACH
constexpr double kPenUp = 1e9;     // BEAM_PEN_UP
constexpr std::size_t kBeamMaxPoints = 64;

double hyp(double a, double b) {
  const std::array<double, 2> v{a, b};
  return js::hypot(v);
}

double srgb_to_linear01(double c) { return c <= 0.04045 ? c / 12.92 : js::pow((c + 0.055) / 1.055, 2.4); }

double linear_to_srgb01(double c) {
  if (c <= 0) return 0;
  if (c >= 1) return 1;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * js::pow(c, 1 / 2.4) - 0.055;
}

/// deepGlow.ts / beamPath.ts `decodeTable()`: Float32 sRGB → linear.
const std::array<float, 256>& decode_table() {
  static const std::array<float, 256> t = [] {
    std::array<float, 256> v{};
    for (std::size_t i = 0; i < 256; ++i) v[i] = static_cast<float>(srgb_to_linear01(static_cast<double>(i) / 255));
    return v;
  }();
  return t;
}

/// `Math.round(linearToSrgb01(v) * 255)` into a byte.
std::uint8_t encode(double v) { return u8c(js::round(linear_to_srgb01(v) * 255)); }

double deep_glow_step(double sigma) { return std::max(1.0, std::ceil((kReach * sigma) / kTaps)); }
double deep_glow_inv(double sigma) { return sigma <= 1e-3 ? 1e12 : 1 / (2 * sigma * sigma); }

/// `blur1D(src, dst, w, h, axis, sigmas)`.
void blur_1d(const std::vector<float>& src, std::vector<float>& dst, int w, int h, int axis,
             const std::array<double, 3>& sigmas, ThreadPool* pool) {
  const double step = deep_glow_step(std::max(std::max(sigmas[0], sigmas[1]), sigmas[2]));
  const std::array<double, 3> inv{deep_glow_inv(sigmas[0]), deep_glow_inv(sigmas[1]), deep_glow_inv(sigmas[2])};
  constexpr std::size_t kN = 2 * kTaps + 1;
  std::array<double, kN> wr{};
  std::array<double, kN> wg{};
  std::array<double, kN> wb{};
  double sr = 0;
  double sg = 0;
  double sb = 0;
  for (int i = -kTaps; i <= kTaps; ++i) {
    const double x = i * step;
    const double x2 = x * x;
    const double r = js::exp(-x2 * inv[0]);
    const double g = js::exp(-x2 * inv[1]);
    const double b = js::exp(-x2 * inv[2]);
    const auto k = static_cast<std::size_t>(i + kTaps);
    wr[k] = r;
    wg[k] = g;
    wb[k] = b;
    sr += r;
    sg += g;
    sb += b;
  }
  for (std::size_t i = 0; i < kN; ++i) {
    wr[i] /= sr;
    wg[i] /= sg;
    wb[i] /= sb;
  }
  // `p + i·step` clamped to the line, in doubles as the TS computes it.
  const auto tap = [step](int p, int i, int len) {
    const double q = p + i * step;
    return q < 0 ? 0 : q >= len ? len - 1 : static_cast<int>(q);
  };
  if (axis == 0) {
    for_rows(pool, h, [&](int y0, int y1) {
      for (int l = y0; l < y1; ++l) {
        const float* row = src.data() + static_cast<std::size_t>(l) * static_cast<std::size_t>(w) * 4;
        float* out = dst.data() + static_cast<std::size_t>(l) * static_cast<std::size_t>(w) * 4;
        for (int p = 0; p < w; ++p) {
          double r = 0;
          double g = 0;
          double b = 0;
          double a = 0;
          for (int i = -kTaps; i <= kTaps; ++i) {
            const int q = tap(p, i, w);
            const float* s = row + static_cast<std::size_t>(q) * 4;
            const auto k = static_cast<std::size_t>(i + kTaps);
            r += s[0] * wr[k];
            g += s[1] * wg[k];
            b += s[2] * wb[k];
            a += s[3] * wg[k];
          }
          float* d = out + static_cast<std::size_t>(p) * 4;
          d[0] = static_cast<float>(r);
          d[1] = static_cast<float>(g);
          d[2] = static_cast<float>(b);
          d[3] = static_cast<float>(a);
        }
      }
    });
    return;
  }
  // Vertical: each output row sums its 33 source rows in tap order; the
  // per-pixel sum order is the TS's, the row-at-a-time loop vectorises.
  const std::size_t stride = static_cast<std::size_t>(w) * 4;
  for_rows(pool, h, [&](int y0, int y1) {
    std::vector<double> acc(stride);
    for (int p = y0; p < y1; ++p) {
      std::fill(acc.begin(), acc.end(), 0.0);
      for (int i = -kTaps; i <= kTaps; ++i) {
        const int q = tap(p, i, h);
        const float* s = src.data() + static_cast<std::size_t>(q) * stride;
        const auto k = static_cast<std::size_t>(i + kTaps);
        const double kr = wr[k];
        const double kg = wg[k];
        const double kb = wb[k];
        for (std::size_t x = 0; x < stride; x += 4) {
          acc[x] += s[x] * kr;
          acc[x + 1] += s[x + 1] * kg;
          acc[x + 2] += s[x + 2] * kb;
          acc[x + 3] += s[x + 3] * kg;
        }
      }
      float* out = dst.data() + static_cast<std::size_t>(p) * stride;
      for (std::size_t x = 0; x < stride; ++x) out[x] = static_cast<float>(acc[x]);
    }
  });
}

// ── beamPath.ts spine ───────────────────────────────────────────────────────

using Flat = std::vector<double>;

std::vector<Flat> subpaths_of(const Flat& flat) {
  std::vector<Flat> out;
  Flat cur;
  for (std::size_t i = 0; i + 1 < flat.size(); i += 2) {
    const double x = flat[i];
    const double y = flat[i + 1];
    if (!std::isfinite(x) || !std::isfinite(y) || x >= kPenUp) {
      if (cur.size() >= 4) out.push_back(cur);
      cur.clear();
      continue;
    }
    cur.push_back(x);
    cur.push_back(y);
  }
  if (cur.size() >= 4) out.push_back(cur);
  return out;
}

double arc_length(const Flat& p) {
  double l = 0;
  for (std::size_t i = 2; i + 1 < p.size(); i += 2) l += hyp(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return l;
}

Flat resample(const Flat& p, double n) {
  const double count = static_cast<double>(p.size()) / 2;
  if (n >= count) return p;
  const double total = arc_length(p);
  Flat out{p[0], p[1]};
  if (total <= 0) return out;
  std::size_t seg = 0;
  double seg_start = 0;
  double seg_len = hyp(p[2] - p[0], p[3] - p[1]);
  for (int k = 1; k < n - 1; ++k) {
    const double target = (k / (n - 1)) * total;
    while (static_cast<double>(seg) < count - 2 && seg_start + seg_len < target) {
      seg_start += seg_len;
      ++seg;
      seg_len = hyp(p[seg * 2 + 2] - p[seg * 2], p[seg * 2 + 3] - p[seg * 2 + 1]);
    }
    const double t = seg_len > 0 ? std::min(1.0, std::max(0.0, (target - seg_start) / seg_len)) : 0;
    out.push_back(mixd(p[seg * 2], p[seg * 2 + 2], t));
    out.push_back(mixd(p[seg * 2 + 1], p[seg * 2 + 3], t));
  }
  out.push_back(p[p.size() - 2]);
  out.push_back(p[p.size() - 1]);
  return out;
}

/// `beamSpine(flat)` → points (same space as the input) and total length.
Flat beam_spine(const Flat& flat, double& total_len) {
  const std::vector<Flat> subs = subpaths_of(flat);
  total_len = 0;
  if (subs.empty()) return {};
  std::vector<double> lens;
  double total = 0;
  for (const Flat& s : subs) {
    lens.push_back(arc_length(s));
    total += lens.back();
  }
  const double ns = static_cast<double>(subs.size());
  const double budget = static_cast<double>(kBeamMaxPoints) - (ns - 1);
  Flat out;
  double remaining = budget;
  for (std::size_t i = 0; i < subs.size(); ++i) {
    const double share = total > 0 ? js::round((lens[i] / total) * budget) : std::floor(budget / ns);
    const double n = std::max(
        2.0, std::min(std::min(remaining - 2 * (ns - 1 - static_cast<double>(i)), share),
                      static_cast<double>(subs[i].size()) / 2));
    remaining -= n;
    if (i > 0) {
      out.push_back(kPenUp);
      out.push_back(0);
    }
    const Flat r = resample(subs[i], n);
    out.insert(out.end(), r.begin(), r.end());
  }
  total_len = total;
  return out;
}

double sstep(double e0, double e1, double x) {
  if (e1 <= e0) return x < e0 ? 0 : 1;
  const double t = std::max(0.0, std::min(1.0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/// noiseHash.ts `fbmU(px, py, seed, octaves)`.
double fbm_u(double px, double py, double seed, double octaves) {
  double total = 0;
  double amp = 1;
  double freq = 1;
  double max_a = 0;
  for (int i = 0; i < 6; ++i) {
    if (i >= octaves) break;
    total += (vnoise_u(px * freq, py * freq, seed + i * 101) * 2 - 1) * amp;
    max_a += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return total / max_a;
}

struct BeamSeg {
  double ax, ay, bx, by, abx, aby, len, sa, sb, ta, tb;
};

}  // namespace

void deep_glow(RgbaView img, const DeepGlowSettings& s, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  if (s.radius <= 0 && !s.glow_only) return;
  const std::size_t n = img.pixels() * 4;
  const auto& lut = decode_table();
  std::uint8_t* d = img.data.data();
  std::vector<float> lin(n);
  for (std::size_t o = 0; o < n; o += 4) {
    const double a = d[o + 3] / 255.0;
    lin[o] = static_cast<float>(lut[d[o]] * a);
    lin[o + 1] = static_cast<float>(lut[d[o + 1]] * a);
    lin[o + 2] = static_cast<float>(lut[d[o + 2]] * a);
    lin[o + 3] = static_cast<float>(a);
  }
  // deepGlowField.
  std::vector<float> level(lin);
  if (s.threshold > 0) {
    for (std::size_t o = 0; o < n; o += 4) {
      const double a = level[o + 3];
      if (a <= 0) {
        level[o] = level[o + 1] = level[o + 2] = level[o + 3] = 0;
        continue;
      }
      const double lum = (0.2126 * level[o] + 0.7152 * level[o + 1] + 0.0722 * level[o + 2]) / a;
      if (lum <= s.threshold) {
        level[o] = level[o + 1] = level[o + 2] = level[o + 3] = 0;
        continue;
      }
      const double f = (lum - s.threshold) / lum;
      level[o] = static_cast<float>(level[o] * f);
      level[o + 1] = static_cast<float>(level[o + 1] * f);
      level[o + 2] = static_cast<float>(level[o + 2] * f);
      level[o + 3] = static_cast<float>(a * f);
    }
  }
  std::vector<float> tmp(n);
  std::vector<float> acc(n, 0.0F);
  // deepGlowOctaves(radius, octaves).
  const double k = std::max(1.0, js::round(s.octaves));
  std::vector<double> deltas;
  double prev = 0;
  for (int i = 0; i < k; ++i) {
    const double sigma = s.radius / js::pow(2, k - 1 - i);
    deltas.push_back(std::sqrt(std::max(0.0, sigma * sigma - prev * prev)));
    prev = sigma;
  }
  const double weight = 1 / static_cast<double>(deltas.size());
  for (const double delta : deltas) {
    const double sx = delta * s.aspect_x;
    const double sy = delta * s.aspect_y;
    blur_1d(level, tmp, w, h, 0, {sx * s.chroma.r, sx * s.chroma.g, sx * s.chroma.b}, pool);
    blur_1d(tmp, level, w, h, 1, {sy * s.chroma.r, sy * s.chroma.g, sy * s.chroma.b}, pool);
    for_rows(pool, h, [&](int y0, int y1) {
      const std::size_t e = static_cast<std::size_t>(y1) * static_cast<std::size_t>(w) * 4;
      for (std::size_t o = static_cast<std::size_t>(y0) * static_cast<std::size_t>(w) * 4; o < e; o += 4) {
        acc[o] = static_cast<float>(acc[o] + level[o] * weight);
        acc[o + 1] = static_cast<float>(acc[o + 1] + level[o + 1] * weight);
        acc[o + 2] = static_cast<float>(acc[o + 2] + level[o + 2] * weight);
        const double wa = level[o + 3] * weight;
        acc[o + 3] = static_cast<float>(acc[o + 3] + wa - acc[o + 3] * wa);
      }
    });
  }
  // deepGlowData's composite.
  const double tr = 1 + (s.tint.r - 1) * s.tint_amount;
  const double tg = 1 + (s.tint.g - 1) * s.tint_amount;
  const double tb = 1 + (s.tint.b - 1) * s.tint_amount;
  constexpr double kDitherAmp = 2 / (255 * 12.92);
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        const std::size_t o = idx4(x, y, w);
        double gr = acc[o] * s.gain * tr;
        double gg = acc[o + 1] * s.gain * tg;
        double gb = acc[o + 2] * s.gain * tb;
        double ga = std::min(1.0, acc[o + 3] * s.gain);
        if (s.dither && ga > 0) {
          const double dn = (hash01u(static_cast<std::uint32_t>(x), static_cast<std::uint32_t>(y), 0) - 0.5) * kDitherAmp;
          gr = std::max(0.0, gr + dn);
          gg = std::max(0.0, gg + dn);
          gb = std::max(0.0, gb + dn);
          ga = std::max(0.0, ga + dn);
        }
        const double a = s.glow_only ? ga : std::min(1.0, lin[o + 3] + ga);
        const double r = std::min(a, (s.glow_only ? 0 : static_cast<double>(lin[o])) + gr);
        const double g = std::min(a, (s.glow_only ? 0 : static_cast<double>(lin[o + 1])) + gg);
        const double b = std::min(a, (s.glow_only ? 0 : static_cast<double>(lin[o + 2])) + gb);
        std::uint8_t* q = d + o;
        if (a <= 0) {
          q[0] = q[1] = q[2] = q[3] = 0;
          continue;
        }
        q[0] = encode(r / a);
        q[1] = encode(g / a);
        q[2] = encode(b / a);
        q[3] = u8c(js::round(a * 255));
      }
    }
  });
}

void beam_path(RgbaView img, std::span<const double> path_points, const BeamPathOptions& o, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  Flat spine;
  if (path_points.size() >= 4) {
    spine.assign(path_points.begin(), path_points.end());
  } else {
    spine = {o.start_x, o.start_y, o.end_x, o.end_y};
  }
  double total_len = 0;
  Flat pts = beam_spine(spine, total_len);
  for (std::size_t i = 0; i + 1 < pts.size(); i += 2) {
    if (pts[i] >= kPenUp) continue;
    pts[i] = pts[i] + w / 2.0;
    pts[i + 1] = pts[i + 1] + h / 2.0;
  }
  // beamFieldAt's per-segment constants, in segment order.
  const std::size_t count = pts.size() / 2;
  std::vector<BeamSeg> segs;
  if (count >= 2 && total_len > 0) {
    double acc = 0;
    for (std::size_t i = 0; i + 1 < count; ++i) {
      const double ax = pts[i * 2];
      const double ay = pts[i * 2 + 1];
      const double bx = pts[i * 2 + 2];
      const double by = pts[i * 2 + 3];
      if (ax >= kPenUp || bx >= kPenUp) continue;
      const double abx = bx - ax;
      const double aby = by - ay;
      const double len = hyp(abx, aby);
      const double sa = acc / total_len;
      const double sb = (acc + len) / total_len;
      acc += len;
      if (len <= 1e-6) continue;
      const double va = std::max(sa, o.start);
      const double vb = std::min(sb, o.end);
      if (vb <= va) continue;
      segs.push_back(BeamSeg{ax, ay, bx, by, abx, aby, len, sa, sb, (va - sa) / (sb - sa), (vb - sa) / (sb - sa)});
    }
  }
  const bool valid = count >= 2 && total_len > 0;
  const double half_w = o.core_width / 2;
  const double win = std::max(o.end - o.start, 1e-6);
  const double inv = 1 / o.distortion_scale;
  const double ev = o.evolution * 0.01;
  const auto field = [&](double qx, double qy, double& core_out, double& glow_out) {
    core_out = 0;
    glow_out = 0;
    if (!valid) return;
    double x = qx;
    double y = qy;
    if (o.distortion > 0) {
      const double fx = std::floor(qx);
      const double fy = std::floor(qy);
      const double dpdx =
          fbm_u((fx + 1) * inv + ev, fy * inv - ev, 53, 3) - fbm_u((fx - 1) * inv + ev, fy * inv - ev, 53, 3);
      const double dpdy =
          fbm_u(fx * inv + ev, (fy + 1) * inv - ev, 53, 3) - fbm_u(fx * inv + ev, (fy - 1) * inv - ev, 53, 3);
      x += dpdy * o.distortion;
      y -= dpdx * o.distortion;
    }
    double core = 0;
    double dmin = 1e9;
    for (const BeamSeg& sg : segs) {
      double t = ((x - sg.ax) * sg.abx + (y - sg.ay) * sg.aby) / (sg.len * sg.len);
      t = std::max(sg.ta, std::min(sg.tb, t));
      const double px = sg.ax + sg.abx * t;
      const double py = sg.ay + sg.aby * t;
      const double d = hyp(x - px, y - py);
      const double s_at = sg.sa + t * (sg.sb - sg.sa);
      const double u = (s_at - o.start) / win;
      const double wh = half_w * mixd(o.start_size, o.end_size, std::max(0.0, std::min(1.0, u)));
      const double soft = wh * o.core_softness;
      const double cov = 1 - sstep(wh - soft, wh + soft + 0.75, d);
      if (cov > core) core = cov;
      const double dg = d - wh;
      if (dg < dmin) dmin = dg;
    }
    if (dmin >= 1e9) return;
    const double dd = std::max(0.0, dmin);
    double glow = o.glow_intensity * o.flicker * js::pow(1 + dd / o.glow_spread, -o.glow_exponent);
    glow *= 1 - sstep(6 * o.glow_spread, 10 * o.glow_spread, dd);
    core_out = core * o.flicker;
    glow_out = glow;
  };
  const auto& table = decode_table();
  const bool beam_only = o.composite == 1;
  std::uint8_t* d = img.data.data();
  for_rows(pool, h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < w; ++x) {
        std::uint8_t* q = d + idx4(x, y, w);
        double core = 0;
        double glow = 0;
        field(x + 0.5, y + 0.5, core, glow);
        const double add_a = std::min(1.0, core + std::min(1.0, glow));
        if (add_a <= 0 && !beam_only) continue;
        const double sa = beam_only ? 0 : q[3] / 255.0;
        const double sr = beam_only ? 0 : table[q[0]] * sa;
        const double sg = beam_only ? 0 : table[q[1]] * sa;
        const double sb = beam_only ? 0 : table[q[2]] * sa;
        const double a = std::min(1.0, sa + add_a);
        const double r = std::min(a, sr + o.core_color.r * core + o.glow_color.r * glow);
        const double g = std::min(a, sg + o.core_color.g * core + o.glow_color.g * glow);
        const double b = std::min(a, sb + o.core_color.b * core + o.glow_color.b * glow);
        if (a <= 0) {
          q[0] = q[1] = q[2] = q[3] = 0;
          continue;
        }
        q[0] = encode(r / a);
        q[1] = encode(g / a);
        q[2] = encode(b / a);
        q[3] = u8c(js::round(a * 255));
      }
    }
  });
}

}  // namespace premation::effects
