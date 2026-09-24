// Port of src/core/effects/aeBlurAdvanced.ts — Bilateral, Smart Blur, Camera
// Lens Blur, and the budget proxy (`fitKernelSize` / `downsampleBox` /
// `upsampleBilinear`) the TS runs them through. The proxy is part of the
// reference: a 1080p layer is blurred at ≤ 512 px and upsampled in the TS, so
// it is here too, byte for byte. (Lifting the budget is a look change, to be
// decided with the golden gate, not a port.)
#include <algorithm>
#include <vector>

#include "kernels.hpp"

namespace premation::effects {

namespace {

constexpr int kMaxRadius = 24;
constexpr double kExactBudget = 8'000'000;
constexpr int kProcMaxEdge = 512;

using Buf = std::vector<std::uint8_t>;

double kernel_cost(int w, int h, int r) {
  const double k = 2.0 * r + 1;
  return static_cast<double>(w) * h * k * k;
}

struct Fit {
  int nw;
  int nh;
  int nr;
};

Fit fit_kernel_size(int w, int h, int r) {
  if (kernel_cost(w, h, r) <= kExactBudget && std::max(w, h) <= kProcMaxEdge) return {w, h, r};
  const double edge_scale = kProcMaxEdge / static_cast<double>(std::max({w, h, 1}));
  const double cost_scale = std::sqrt(kExactBudget / std::max(1.0, kernel_cost(w, h, r)));
  const double scale = std::min({1.0, edge_scale, cost_scale});
  return {static_cast<int>(std::max(1.0, js::round(w * scale))), static_cast<int>(std::max(1.0, js::round(h * scale))),
          static_cast<int>(std::max(1.0, js::round(r * scale)))};
}

Buf downsample_box(const Buf& src, int w, int h, int nw, int nh, ThreadPool* pool) {
  Buf out(static_cast<std::size_t>(nw) * static_cast<std::size_t>(nh) * 4, 0);
  for_rows(pool, nh, [&](int ya, int yb) {
    for (int y = ya; y < yb; ++y) {
      const int y0 = static_cast<int>((static_cast<std::int64_t>(y) * h) / nh);
      const int y1 = std::max(y0 + 1, static_cast<int>((static_cast<std::int64_t>(y + 1) * h) / nh));
      for (int x = 0; x < nw; ++x) {
        const int x0 = static_cast<int>((static_cast<std::int64_t>(x) * w) / nw);
        const int x1 = std::max(x0 + 1, static_cast<int>((static_cast<std::int64_t>(x + 1) * w) / nw));
        double ar = 0;
        double ag = 0;
        double ab = 0;
        double aa = 0;
        double n = 0;
        for (int sy = y0; sy < y1; ++sy) {
          for (int sx = x0; sx < x1; ++sx) {
            const std::uint8_t* p = src.data() + idx4(sx, sy, w);
            const double sa = p[3];
            ar += p[0] * sa;
            ag += p[1] * sa;
            ab += p[2] * sa;
            aa += sa;
            n += 1;
          }
        }
        std::uint8_t* d = out.data() + idx4(x, y, nw);
        if (aa > 0) {
          d[0] = u8c(ar / aa);
          d[1] = u8c(ag / aa);
          d[2] = u8c(ab / aa);
        }
        d[3] = u8c(n > 0 ? aa / n : 0);
      }
    }
  });
  return out;
}

Buf upsample_bilinear(const Buf& src, int sw, int sh, int dw, int dh, ThreadPool* pool) {
  Buf out(static_cast<std::size_t>(dw) * static_cast<std::size_t>(dh) * 4, 0);
  const double sx_scale = static_cast<double>(sw) / dw;
  const double sy_scale = static_cast<double>(sh) / dh;
  const auto mix = [](double p, double q, double t) { return p + (q - p) * t; };
  for_rows(pool, dh, [&](int ya, int yb) {
    for (int y = ya; y < yb; ++y) {
      const double fy = (y + 0.5) * sy_scale - 0.5;
      const int y0 = static_cast<int>(std::max(0.0, std::min(static_cast<double>(sh - 1), std::floor(fy))));
      const int y1 = std::min(sh - 1, y0 + 1);
      const double ty = fy - y0;
      for (int x = 0; x < dw; ++x) {
        const double fx = (x + 0.5) * sx_scale - 0.5;
        const int x0 = static_cast<int>(std::max(0.0, std::min(static_cast<double>(sw - 1), std::floor(fx))));
        const int x1 = std::min(sw - 1, x0 + 1);
        const double tx = fx - x0;
        const std::uint8_t* a = src.data() + idx4(x0, y0, sw);
        const std::uint8_t* b = src.data() + idx4(x1, y0, sw);
        const std::uint8_t* c = src.data() + idx4(x0, y1, sw);
        const std::uint8_t* d = src.data() + idx4(x1, y1, sw);
        std::uint8_t* o = out.data() + idx4(x, y, dw);
        for (std::size_t k = 0; k < 4; ++k) {
          const double top = mix(a[k], b[k], tx);
          const double bot = mix(c[k], d[k], tx);
          o[k] = u8c(mix(top, bot, ty));
        }
      }
    }
  });
  return out;
}

template <class Kernel>
void run_at_budget(RgbaView img, int radius, ThreadPool* pool, Kernel&& kernel) {
  const int w = img.w;
  const int h = img.h;
  const Fit f = fit_kernel_size(w, h, radius);
  Buf src(img.data.begin(), img.data.end());
  Buf result;
  if (f.nw == w && f.nh == h) {
    result = kernel(src, w, h, radius);
  } else {
    const Buf small = downsample_box(src, w, h, f.nw, f.nh, pool);
    const Buf blurred = kernel(small, f.nw, f.nh, f.nr);
    result = upsample_bilinear(blurred, f.nw, f.nh, w, h, pool);
  }
  std::copy(result.begin(), result.end(), img.data.begin());
}

// ── Bilateral ───────────────────────────────────────────────────────────────

Buf bilateral_exact(const Buf& src, int w, int h, int r, double color_sigma, bool preserve_alpha, ThreadPool* pool) {
  Buf out(src.size(), 0);
  const double ss = std::max(0.5, r / 2.0);
  const double sr = std::max(1.0, color_sigma);
  const double inv2ss = 1 / (2 * ss * ss);
  const double inv2sr = 1 / (2 * sr * sr);
  const int size = r * 2 + 1;
  std::vector<double> spatial(static_cast<std::size_t>(size) * static_cast<std::size_t>(size));
  for (int dy = -r, k = 0; dy <= r; ++dy) {
    for (int dx = -r; dx <= r; ++dx, ++k) {
      // Float32Array store, read back as a double.
      spatial[static_cast<std::size_t>(k)] =
          static_cast<double>(static_cast<float>(js::exp(-static_cast<double>(dx * dx + dy * dy) * inv2ss)));
    }
  }
  // The colour term is exp(−dc · inv2sr) of an INTEGER dc in [0, 3·255²]: one
  // table holds every value the TS computes per tap.
  constexpr int kMaxDc = 3 * 255 * 255;
  std::vector<double> range(static_cast<std::size_t>(kMaxDc) + 1);
  for (int dc = 0; dc <= kMaxDc; ++dc) range[static_cast<std::size_t>(dc)] = js::exp(-static_cast<double>(dc) * inv2sr);

  for_rows(pool, h, [&](int ya, int yb) {
    for (int y = ya; y < yb; ++y) {
      for (int x = 0; x < w; ++x) {
        const std::size_t o = idx4(x, y, w);
        const int cr = src[o];
        const int cg = src[o + 1];
        const int cb = src[o + 2];
        double ar = 0;
        double ag = 0;
        double ab = 0;
        double aa = 0;
        double wsum = 0;
        const double* sp = spatial.data();
        for (int dy = -r; dy <= r; ++dy) {
          const int sy = std::min(h - 1, std::max(0, y + dy));
          const std::uint8_t* row = src.data() + idx4(0, sy, w);
          for (int dx = -r; dx <= r; ++dx, ++sp) {
            const int sx = std::min(w - 1, std::max(0, x + dx));
            const std::uint8_t* p = row + static_cast<std::size_t>(sx) * 4;
            const int nr = p[0];
            const int ng = p[1];
            const int nb = p[2];
            const int dc = (nr - cr) * (nr - cr) + (ng - cg) * (ng - cg) + (nb - cb) * (nb - cb);
            const double wt = *sp * range[static_cast<std::size_t>(dc)];
            const double sa = p[3];
            ar += nr * sa * wt;
            ag += ng * sa * wt;
            ab += nb * sa * wt;
            aa += sa * wt;
            wsum += wt;
          }
        }
        if (aa > 0) {
          out[o] = u8c(ar / aa);
          out[o + 1] = u8c(ag / aa);
          out[o + 2] = u8c(ab / aa);
        }
        out[o + 3] = preserve_alpha ? src[o + 3] : u8c(aa / std::max(1e-6, wsum));
      }
    }
  });
  return out;
}

// ── Smart Blur ──────────────────────────────────────────────────────────────

Buf smart_exact(const Buf& src, int w, int h, int r, double thr, double m, ThreadPool* pool) {
  Buf out(src.size(), 0);
  std::vector<double> lum(static_cast<std::size_t>(w) * static_cast<std::size_t>(h));
  for (std::size_t i = 0; i < lum.size(); ++i) lum[i] = luma709(src[i * 4], src[i * 4 + 1], src[i * 4 + 2]);
  for_rows(pool, h, [&](int ya, int yb) {
    for (int y = ya; y < yb; ++y) {
      for (int x = 0; x < w; ++x) {
        const std::size_t o = idx4(x, y, w);
        const double cl = lum[o / 4];
        double ar = 0;
        double ag = 0;
        double ab = 0;
        double aa = 0;
        int n = 0;
        int rejected = 0;
        int total = 0;
        for (int dy = -r; dy <= r; ++dy) {
          const int sy = std::min(h - 1, std::max(0, y + dy));
          const std::size_t row = static_cast<std::size_t>(sy) * static_cast<std::size_t>(w);
          for (int dx = -r; dx <= r; ++dx) {
            if (dx * dx + dy * dy > r * r) continue;
            const std::size_t si = row + static_cast<std::size_t>(std::min(w - 1, std::max(0, x + dx)));
            ++total;
            if (std::fabs(lum[si] - cl) > thr) {
              ++rejected;
              continue;
            }
            const std::uint8_t* p = src.data() + si * 4;
            const double sa = p[3];
            ar += p[0] * sa;
            ag += p[1] * sa;
            ab += p[2] * sa;
            aa += sa;
            ++n;
          }
        }
        const double edge = total > 0 ? static_cast<double>(rejected) / total : 0;
        double rr = 0;
        double gg = 0;
        double bb = 0;
        if (aa > 0) {
          rr = ar / aa;
          gg = ag / aa;
          bb = ab / aa;
        } else {
          rr = src[o];
          gg = src[o + 1];
          bb = src[o + 2];
        }
        if (m == 1) {
          const std::uint8_t v = u8c(clamp255(edge * 255));
          out[o] = v;
          out[o + 1] = v;
          out[o + 2] = v;
          out[o + 3] = src[o + 3];
        } else if (m == 2) {
          const double k = 1 - clamp01(edge);
          out[o] = u8c(rr * k);
          out[o + 1] = u8c(gg * k);
          out[o + 2] = u8c(bb * k);
          out[o + 3] = src[o + 3];
        } else {
          out[o] = u8c(rr);
          out[o + 1] = u8c(gg);
          out[o + 2] = u8c(bb);
          out[o + 3] = n > 0 ? u8c(aa / n) : src[o + 3];
        }
      }
    }
  });
  return out;
}

// ── Camera Lens Blur ────────────────────────────────────────────────────────

Buf camera_exact(const Buf& src, int w, int h, int r, double blades, double rotation, double gain, double threshold,
                 ThreadPool* pool) {
  constexpr double kPi = 3.141592653589793;
  // The iris as runs of (dy, dx) taps in the TS's scan order.
  struct Tap {
    int dy;
    int dx;
  };
  std::vector<Tap> taps;
  const double n = js::round(blades);
  const double rot = (rotation * kPi) / 180;
  double mask_sum = 0;
  for (int dy = -r; dy <= r; ++dy) {
    for (int dx = -r; dx <= r; ++dx) {
      const double dist = std::sqrt(static_cast<double>(dx * dx + dy * dy));
      bool inside = false;
      if (n < 3) {
        inside = dist <= r;
      } else {
        const double ang = js::atan2(dy, dx) - rot;
        const double seg = (kPi * 2) / n;
        const double local = ang - seg * std::floor(ang / seg + 0.5);
        inside = dist * js::cos(local) <= r * js::cos(kPi / n);
      }
      if (inside) {
        taps.push_back({dy, dx});
        mask_sum += 1;
      }
    }
  }
  if (mask_sum <= 0) return src;

  const double thr = clamp01(threshold / 100);
  const double g = std::max(1.0, gain);
  // boost(v, l) · sa depends only on the SAMPLE pixel: one plane per channel
  // holds the exact product the TS forms at every tap (× wt, which is 1).
  const std::size_t np = static_cast<std::size_t>(w) * static_cast<std::size_t>(h);
  std::vector<double> pr(np);
  std::vector<double> pg(np);
  std::vector<double> pb(np);
  for (std::size_t i = 0; i < np; ++i) {
    const double nr = src[i * 4];
    const double ng = src[i * 4 + 1];
    const double nb = src[i * 4 + 2];
    const double sa = src[i * 4 + 3];
    const double l = luma709(nr, ng, nb) / 255;
    const auto boost = [&](double v) {
      return l > thr ? v * (1 + (g - 1) * (l - thr) / std::max(1e-6, 1 - thr)) : v;
    };
    pr[i] = boost(nr) * sa * 1.0;
    pg[i] = boost(ng) * sa * 1.0;
    pb[i] = boost(nb) * sa * 1.0;
  }
  Buf out(src.size(), 0);
  for_rows(pool, h, [&](int ya, int yb) {
    for (int y = ya; y < yb; ++y) {
      for (int x = 0; x < w; ++x) {
        double ar = 0;
        double ag = 0;
        double ab = 0;
        double aa = 0;
        double wsum = 0;
        for (const Tap& t : taps) {
          const int sy = std::min(h - 1, std::max(0, y + t.dy));
          const int sx = std::min(w - 1, std::max(0, x + t.dx));
          const std::size_t si = static_cast<std::size_t>(sy) * static_cast<std::size_t>(w) + static_cast<std::size_t>(sx);
          ar += pr[si];
          ag += pg[si];
          ab += pb[si];
          aa += src[si * 4 + 3];
          wsum += 1;
        }
        const std::size_t o = idx4(x, y, w);
        if (aa > 0) {
          const double mr = ar / aa;
          const double mg = ag / aa;
          const double mb = ab / aa;
          const double ml = luma709(mr, mg, mb) / 255;
          const double k2 = ml > 1 ? 1 / ml : 1;
          out[o] = u8c(clamp255(mr * k2));
          out[o + 1] = u8c(clamp255(mg * k2));
          out[o + 2] = u8c(clamp255(mb * k2));
        }
        out[o + 3] = u8c(aa / std::max(1e-6, wsum));
      }
    }
  });
  return out;
}

}  // namespace

void bilateral_blur(RgbaView img, double radius, double color_sigma, bool preserve_alpha, ThreadPool* pool) {
  const int r = static_cast<int>(std::max(0.0, std::min(static_cast<double>(kMaxRadius), js::round(radius))));
  if (r == 0 || img.w <= 0 || img.h <= 0) return;
  run_at_budget(img, r, pool, [&](const Buf& d, int pw, int ph, int pr) {
    return bilateral_exact(d, pw, ph, pr, color_sigma, preserve_alpha, pool);
  });
}

void smart_blur(RgbaView img, double radius, double threshold, double mode, ThreadPool* pool) {
  const int r = static_cast<int>(std::max(0.0, std::min(static_cast<double>(kMaxRadius), js::round(radius))));
  if (r == 0 || img.w <= 0 || img.h <= 0) return;
  const double thr = std::max(0.0, threshold);
  const double m = js::round(mode);
  run_at_budget(img, r, pool,
                [&](const Buf& d, int pw, int ph, int pr) { return smart_exact(d, pw, ph, pr, thr, m, pool); });
}

void camera_lens_blur(RgbaView img, double radius, double blades, double rotation, double gain, double threshold,
                      ThreadPool* pool) {
  const int r = static_cast<int>(std::max(0.0, std::min(static_cast<double>(kMaxRadius), js::round(radius))));
  if (r == 0 || img.w <= 0 || img.h <= 0) return;
  run_at_budget(img, r, pool, [&](const Buf& d, int pw, int ph, int pr) {
    return camera_exact(d, pw, ph, pr, blades, rotation, gain, threshold, pool);
  });
}

}  // namespace premation::effects
