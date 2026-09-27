#include "roto_matte.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>

#include "jsmath.hpp"
#include "stabilize.hpp"

namespace premation::jobs::roto {

namespace mjs = motion::js;
using std::size_t;

namespace {

size_t uz(int v) noexcept { return static_cast<size_t>(std::max(0, v)); }
int ri(double v) { return static_cast<int>(mjs::round(v)); }
double px(std::span<const std::uint8_t> rgba, size_t i) { return static_cast<double>(rgba[i]); }

/// A box blur's mean per pixel, stored Float32 (the TS tmp Float32Array).
std::vector<float> box_mean(const Matte& mask, int w, int h, int r) {
  std::vector<float> tmp(uz(w) * uz(h));
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      double sum = 0;
      int n = 0;
      for (int dy = -r; dy <= r; ++dy) {
        const int yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (int dx = -r; dx <= r; ++dx) {
          const int xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          sum += mask[uz(yy) * uz(w) + uz(xx)];
          n++;
        }
      }
      tmp[uz(y) * uz(w) + uz(x)] = static_cast<float>(sum / n);
    }
  }
  return tmp;
}

}  // namespace

Matte flood_matte(std::span<const std::uint8_t> rgba, int w, int h, const std::vector<Seed>& seeds) {
  const size_t n = uz(w) * uz(h);
  Matte out(n, 0);
  if (seeds.empty() || rgba.size() < n * 4) return out;
  std::vector<std::uint8_t> visited(n, 0);
  std::vector<size_t> stack;
  for (const Seed& seed : seeds) {
    const int sx = std::max(0, std::min(w - 1, ri(seed.x)));
    const int sy = std::max(0, std::min(h - 1, ri(seed.y)));
    const double tol = seed.tolerance;
    const size_t si = uz(sy) * uz(w) + uz(sx);
    const double sr = px(rgba, si * 4);
    const double sg = px(rgba, si * 4 + 1);
    const double sb = px(rgba, si * 4 + 2);
    stack.push_back(si);
    while (!stack.empty()) {
      const size_t i = stack.back();
      stack.pop_back();
      if (visited[i] != 0) continue;
      visited[i] = 1;
      const double r = px(rgba, i * 4);
      const double g = px(rgba, i * 4 + 1);
      const double b = px(rgba, i * 4 + 2);
      if (std::abs(r - sr) + std::abs(g - sg) + std::abs(b - sb) > tol * 3) continue;
      out[i] = 255;
      const size_t x = i % uz(w);
      const size_t y = (i - x) / uz(w);
      if (x > 0) stack.push_back(i - 1);
      if (x + 1 < uz(w)) stack.push_back(i + 1);
      if (y > 0) stack.push_back(i - uz(w));
      if (y + 1 < uz(h)) stack.push_back(i + uz(w));
    }
  }
  return out;
}

std::vector<Pt> matte_to_path(const Matte& mask, int w, int h) {
  std::vector<Pt> pts;
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const size_t i = uz(y) * uz(w) + uz(x);
      if (mask[i] == 0) continue;
      const bool leftEmpty = x == 0 || mask[i - 1] == 0;
      const bool rightEmpty = x == w - 1 || mask[i + 1] == 0;
      const bool topEmpty = y == 0 || mask[i - uz(w)] == 0;
      const bool botEmpty = y == h - 1 || mask[i + uz(w)] == 0;
      if (!(leftEmpty || rightEmpty || topEmpty || botEmpty)) continue;
      pts.push_back(Pt{x + 0.5, y + 0.5});
    }
  }
  // Decimate to ≤ 128 vertices for mask UX.
  if (pts.size() <= 128) return pts;
  const size_t step = (pts.size() + 127) / 128;
  std::vector<Pt> out;
  for (size_t i = 0; i < pts.size(); i += step) out.push_back(pts[i]);
  return out;
}

Matte morph_dilate(const Matte& mask, int w, int h, double radius) {
  const int r = std::max(0, ri(radius));
  if (r <= 0) return mask;
  Matte out(uz(w) * uz(h), 0);
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      std::uint8_t on = 0;
      for (int dy = -r; dy <= r && on == 0; ++dy) {
        const int yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (int dx = -r; dx <= r; ++dx) {
          const int xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (mask[uz(yy) * uz(w) + uz(xx)] != 0) {
            on = 255;
            break;
          }
        }
      }
      out[uz(y) * uz(w) + uz(x)] = on;
    }
  }
  return out;
}

Matte morph_erode(const Matte& mask, int w, int h, double radius) {
  const int r = std::max(0, ri(radius));
  if (r <= 0) return mask;
  Matte out(uz(w) * uz(h), 0);
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      std::uint8_t on = 255;
      for (int dy = -r; dy <= r && on != 0; ++dy) {
        const int yy = y + dy;
        if (yy < 0 || yy >= h) {
          on = 0;
          break;
        }
        for (int dx = -r; dx <= r; ++dx) {
          const int xx = x + dx;
          if (xx < 0 || xx >= w || mask[uz(yy) * uz(w) + uz(xx)] == 0) {
            on = 0;
            break;
          }
        }
      }
      out[uz(y) * uz(w) + uz(x)] = on;
    }
  }
  return out;
}

Matte morph_open(const Matte& mask, int w, int h, double radius) { return morph_dilate(morph_erode(mask, w, h, radius), w, h, radius); }
Matte morph_close(const Matte& mask, int w, int h, double radius) { return morph_erode(morph_dilate(mask, w, h, radius), w, h, radius); }

Matte refine_matte_edge(std::span<const std::uint8_t> rgba, const Matte& mask, int w, int h, double tol) {
  double sr = 0;
  double sg = 0;
  double sb = 0;
  double n = 0;
  for (size_t i = 0; i < mask.size(); ++i) {
    if (mask[i] == 0) continue;
    sr += px(rgba, i * 4);
    sg += px(rgba, i * 4 + 1);
    sb += px(rgba, i * 4 + 2);
    n++;
  }
  if (n == 0) return mask;
  sr /= n;
  sg /= n;
  sb /= n;
  const double thr = tol * 3;
  Matte out = mask;
  for (int y = 1; y < h - 1; ++y) {
    for (int x = 1; x < w - 1; ++x) {
      const size_t i = uz(y) * uz(w) + uz(x);
      const std::uint8_t m = mask[i];
      const bool boundary = m != mask[i - 1] || m != mask[i + 1] || m != mask[i - uz(w)] || m != mask[i + uz(w)];
      if (!boundary) continue;
      const double dist = std::abs(px(rgba, i * 4) - sr) + std::abs(px(rgba, i * 4 + 1) - sg) + std::abs(px(rgba, i * 4 + 2) - sb);
      out[i] = dist <= thr ? 255 : 0;
    }
  }
  return out;
}

Matte soft_feather_mask(const Matte& mask, int w, int h, double radius) {
  if (radius <= 0) return mask;
  const int r = std::max(1, ri(radius));
  const std::vector<float> tmp = box_mean(mask, w, h, r);
  Matte out(tmp.size());
  for (size_t i = 0; i < tmp.size(); ++i) out[i] = static_cast<std::uint8_t>(mjs::round(static_cast<double>(tmp[i])));
  return out;
}

Matte refine_roto_matte(std::span<const std::uint8_t> rgba, const Matte& mask, int w, int h, double morphRadius, double featherPx,
                        double edgeTol) {
  Matte m = morph_open(mask, w, h, morphRadius);
  m = morph_close(m, w, h, morphRadius);
  m = refine_matte_edge(rgba, m, w, h, edgeTol);
  const Matte soft = soft_feather_mask(m, w, h, featherPx);
  // The contour from the soft mid-level, so the path sits in the feather ramp.
  Matte binary(soft.size());
  for (size_t i = 0; i < soft.size(); ++i) binary[i] = soft[i] >= 128 ? 255 : 0;
  return binary;
}

// ── grabCut.ts ──────────────────────────────────────────────────────────

namespace {

struct ColourModel {
  std::array<double, 3> mean{128, 128, 128};
  std::array<double, 3> var{1e4, 1e4, 1e4};
};

ColourModel fit_model(std::span<const std::uint8_t> rgba, const std::vector<std::uint8_t>& mask) {
  double sr = 0;
  double sg = 0;
  double sb = 0;
  double n = 0;
  for (size_t i = 0; i < mask.size(); ++i) {
    if (mask[i] != 1) continue;
    sr += px(rgba, i * 4);
    sg += px(rgba, i * 4 + 1);
    sb += px(rgba, i * 4 + 2);
    n++;
  }
  ColourModel m;
  if (n == 0) return m;
  m.mean = {sr / n, sg / n, sb / n};
  double vr = 0;
  double vg = 0;
  double vb = 0;
  for (size_t i = 0; i < mask.size(); ++i) {
    if (mask[i] != 1) continue;
    const double dr = px(rgba, i * 4) - m.mean[0];
    const double dg = px(rgba, i * 4 + 1) - m.mean[1];
    const double db = px(rgba, i * 4 + 2) - m.mean[2];
    vr += dr * dr;
    vg += dg * dg;
    vb += db * db;
  }
  m.var = {std::max(16.0, vr / n), std::max(16.0, vg / n), std::max(16.0, vb / n)};
  return m;
}

double log_lik(const ColourModel& m, double r, double g, double b) {
  const double dr = r - m.mean[0];
  const double dg = g - m.mean[1];
  const double db = b - m.mean[2];
  return -0.5 * (dr * dr / m.var[0] + dg * dg / m.var[1] + db * db / m.var[2]) -
         0.5 * (mjs::log(m.var[0]) + mjs::log(m.var[1]) + mjs::log(m.var[2]));
}

/// `buildTrimap`: 0 = BG, 1 = unknown band, 2 = FG.
std::vector<std::uint8_t> build_trimap(const Matte& fg, int w, int h, double radius) {
  std::vector<std::uint8_t> trimap(uz(w) * uz(h), 0);
  const int r = std::max(1, ri(radius));
  for (size_t i = 0; i < fg.size(); ++i) {
    if (fg[i] != 0) trimap[i] = 2;
  }
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const size_t i = uz(y) * uz(w) + uz(x);
      if (trimap[i] == 2) continue;
      bool near = false;
      for (int dy = -r; dy <= r && !near; ++dy) {
        const int yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (int dx = -r; dx <= r; ++dx) {
          const int xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (fg[uz(yy) * uz(w) + uz(xx)] != 0) {
            near = true;
            break;
          }
        }
      }
      if (near) trimap[i] = 1;
    }
  }
  return trimap;
}

}  // namespace

Matte grab_cut_matte(std::span<const std::uint8_t> rgba, int w, int h, const std::vector<Seed>& seeds, const GrabCutOptions& opts) {
  const Matte seedFg = flood_matte(rgba, w, h, seeds);
  const std::vector<std::uint8_t> trimap = build_trimap(seedFg, w, h, opts.unknownRadius);
  std::vector<std::uint8_t> labels = trimap;
  for (int it = 0; it < opts.iterations; ++it) {
    std::vector<std::uint8_t> fgMask(labels.size(), 0);
    std::vector<std::uint8_t> bgMask(labels.size(), 0);
    for (size_t i = 0; i < labels.size(); ++i) {
      if (labels[i] == 2) fgMask[i] = 1;
      else if (labels[i] == 0) bgMask[i] = 1;
    }
    const ColourModel fg = fit_model(rgba, fgMask);
    const ColourModel bg = fit_model(rgba, bgMask);
    for (size_t i = 0; i < labels.size(); ++i) {
      if (trimap[i] != 1) continue;  // only free unknowns; hard FG / BG stick
      const double r = px(rgba, i * 4);
      const double g = px(rgba, i * 4 + 1);
      const double b = px(rgba, i * 4 + 2);
      labels[i] = log_lik(fg, r, g, b) >= log_lik(bg, r, g, b) ? 2 : 0;
    }
  }
  Matte out(labels.size());
  for (size_t i = 0; i < labels.size(); ++i) out[i] = labels[i] == 2 ? 255 : 0;
  out = morph_open(out, w, h, 1);
  out = morph_close(out, w, h, 1);
  if (opts.featherPx > 0) return refine_roto_matte(rgba, out, w, h, 1, opts.featherPx, 28);
  return out;
}

// ── rotoBrush.ts ────────────────────────────────────────────────────────

Matte blur_mask(const Matte& mask, int w, int h, double radius) {
  if (radius <= 0) return mask;
  const int r = std::max(1, ri(radius));
  const std::vector<float> tmp = box_mean(mask, w, h, r);
  Matte out(tmp.size());
  for (size_t i = 0; i < tmp.size(); ++i) out[i] = tmp[i] >= 128.0F ? 255 : 0;
  return out;
}

Matte refine_frame_matte(std::span<const std::uint8_t> rgba, const Matte& mask, int w, int h, double feather, const Seed& seed) {
  // GrabCut on the propagated region as the FG prior, intersected so it cannot jump to a new object.
  GrabCutOptions o;
  o.unknownRadius = 6;
  o.iterations = 3;
  o.featherPx = feather;
  const Matte gc = grab_cut_matte(rgba, w, h, {seed}, o);
  Matte fused(mask.size(), 0);
  bool any = false;
  for (size_t i = 0; i < mask.size(); ++i) {
    if (mask[i] != 0 && gc[i] != 0) {
      fused[i] = 255;
      any = true;
    }
  }
  return refine_roto_matte(rgba, any ? fused : mask, w, h, 1, feather, 28);
}

Matte warp_matte(const Matte& mask, int w, int h, const scene::pixmo::FlowField& flow, double scaleX, double scaleY) {
  Matte out(uz(w) * uz(h), 0);
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const stabilize::XY d = stabilize::sample_flow(flow, x / scaleX, y / scaleY);
      const int sx = ri(x - d.x * scaleX);
      const int sy = ri(y - d.y * scaleY);
      if (sx >= 0 && sy >= 0 && sx < w && sy < h) out[uz(y) * uz(w) + uz(x)] = mask[uz(sy) * uz(w) + uz(sx)];
    }
  }
  return out;
}

}  // namespace premation::jobs::roto
