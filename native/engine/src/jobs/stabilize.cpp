#include "stabilize.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>

#include "jsmath.hpp"

namespace premation::jobs::stabilize {
namespace {

using std::size_t;
namespace mjs = motion::js;

size_t uz(int v) noexcept { return static_cast<size_t>(std::max(0, v)); }

double hypot2(double a, double b) noexcept {
  const std::array<double, 2> v{a, b};
  return mjs::hypot(v);
}

/// pixelMotionFlow.ts `blockSad` over Float32 luma (clamped samples).
double block_sad(const FloatLuma& A, const FloatLuma& B, int ax, int ay, int dx, int dy, int r) noexcept {
  const int w = A.w;
  const int h = A.h;
  double sad = 0;
  for (int oy = -r; oy <= r; ++oy) {
    const int ya = std::min(h - 1, std::max(0, ay + oy));
    const int yb = std::min(h - 1, std::max(0, ay + oy + dy));
    for (int ox = -r; ox <= r; ++ox) {
      const int xa = std::min(w - 1, std::max(0, ax + ox));
      const int xb = std::min(w - 1, std::max(0, ax + ox + dx));
      sad += std::abs(static_cast<double>(A.data[uz(ya) * uz(w) + uz(xa)]) - static_cast<double>(B.data[uz(yb) * uz(w) + uz(xb)]));
    }
  }
  return sad;
}

/// `searchAllCells` (two-stage block match) over Float32 luma.
std::vector<double> search_cells(const FloatLuma& a, const FloatLuma& b, int step, int r, int s, double minImp) {
  const int w = a.w;
  const int h = a.h;
  const int cols = std::max(1, w / step);
  const int rows = std::max(1, h / step);
  std::vector<double> raw(uz(cols) * uz(rows) * scene::pixmo::kSearchStride, 0.0);
  for (int gy = 0; gy < rows; ++gy) {
    for (int gx = 0; gx < cols; ++gx) {
      const int ax = std::min(w - 1, static_cast<int>(mjs::round((gx + 0.5) * step)));
      const int ay = std::min(h - 1, static_cast<int>(mjs::round((gy + 0.5) * step)));
      const double zero = block_sad(a, b, ax, ay, 0, 0, r);
      double best = zero;
      int bx = 0;
      int by = 0;
      for (int oy = -s; oy <= s; oy += 2) {
        for (int ox = -s; ox <= s; ox += 2) {
          if (ox == 0 && oy == 0) continue;
          const double sad = block_sad(a, b, ax, ay, ox, oy, r);
          if (sad < best) {
            best = sad;
            bx = ox;
            by = oy;
          }
        }
      }
      const int cx = bx;
      const int cy = by;
      for (int oy = -1; oy <= 1; ++oy) {
        for (int ox = -1; ox <= 1; ++ox) {
          if (ox == 0 && oy == 0) continue;
          const double sad = block_sad(a, b, ax, ay, cx + ox, cy + oy, r);
          if (sad < best) {
            best = sad;
            bx = cx + ox;
            by = cy + oy;
          }
        }
      }
      const size_t o = (uz(gy) * uz(cols) + uz(gx)) * scene::pixmo::kSearchStride;
      raw[o] = zero;
      raw[o + 1] = best;
      raw[o + 2] = bx;
      raw[o + 3] = by;
      if (zero - best < minImp * std::max(1.0, zero)) continue;
      raw[o + 4] = block_sad(a, b, ax, ay, bx - 1, by, r);
      raw[o + 5] = block_sad(a, b, ax, ay, bx + 1, by, r);
      raw[o + 6] = block_sad(a, b, ax, ay, bx, by - 1, r);
      raw[o + 7] = block_sad(a, b, ax, ay, bx, by + 1, r);
    }
  }
  return raw;
}

/// globalMotion.ts `gaussSmooth`: edge-truncated, weights renormalized.
std::vector<double> gauss_smooth(const std::vector<double>& v, double sigma) {
  const size_t n = v.size();
  if (sigma <= 0 || n < 2) return v;
  std::vector<double> out(n, 0.0);
  const int radius = std::max(1, static_cast<int>(std::ceil(sigma * 3)));
  std::vector<double> weights(uz(radius * 2 + 1));
  for (int k = -radius; k <= radius; ++k) {
    weights[uz(k + radius)] = mjs::exp(-(static_cast<double>(k) * k) / (2 * sigma * sigma));
  }
  const long long len = static_cast<long long>(n);
  for (long long i = 0; i < len; ++i) {
    double sum = 0;
    double wsum = 0;
    for (int k = -radius; k <= radius; ++k) {
      const long long j = i + k;
      if (j < 0 || j >= len) continue;
      const double w = weights[uz(k + radius)];
      sum += v[static_cast<size_t>(j)] * w;
      wsum += w;
    }
    out[static_cast<size_t>(i)] = sum / wsum;
  }
  return out;
}

}  // namespace

Sim compose_sim(const Sim& outer, const Sim& inner) noexcept {
  return Sim{outer.a * inner.a - outer.b * inner.b, outer.b * inner.a + outer.a * inner.b,
             outer.a * inner.tx - outer.b * inner.ty + outer.tx, outer.b * inner.tx + outer.a * inner.ty + outer.ty};
}

Sim invert_sim(const Sim& s) noexcept {
  const double d = s.a * s.a + s.b * s.b;
  if (d < 1e-12) return Sim{};
  const double ia = s.a / d;
  const double ib = -s.b / d;
  return Sim{ia, ib, -(ia * s.tx - ib * s.ty), -(ib * s.tx + ia * s.ty)};
}

XY apply_sim(const Sim& s, double x, double y) noexcept { return XY{s.a * x - s.b * y + s.tx, s.b * x + s.a * y + s.ty}; }

double sim_rotation(const Sim& s) noexcept { return mjs::atan2(s.b, s.a); }
double sim_scale(const Sim& s) noexcept { return hypot2(s.a, s.b); }
Sim sim_from(double rot, double scale, double tx, double ty) noexcept {
  return Sim{mjs::cos(rot) * scale, mjs::sin(rot) * scale, tx, ty};
}

FloatLuma luma_255_of(std::span<const std::uint8_t> rgba, int w, int h) {
  FloatLuma out;
  out.w = w;
  out.h = h;
  const size_t n = uz(w) * uz(h);
  out.data.assign(n, 0.0F);
  for (size_t i = 0, p = 0; i < n && p + 2 < rgba.size(); ++i, p += 4) {
    out.data[i] = static_cast<float>(static_cast<double>(rgba[p]) * 0.299 + static_cast<double>(rgba[p + 1]) * 0.587 +
                                     static_cast<double>(rgba[p + 2]) * 0.114);
  }
  return out;
}

FloatLuma downsample_luma(const FloatLuma& in, int factor) {
  if (factor <= 1) return in;
  FloatLuma out;
  out.w = std::max(1, in.w / factor);
  out.h = std::max(1, in.h / factor);
  out.data.assign(uz(out.w) * uz(out.h), 0.0F);
  const double inv = 1.0 / (static_cast<double>(factor) * factor);
  for (int y = 0; y < out.h; ++y) {
    for (int x = 0; x < out.w; ++x) {
      double sum = 0;
      for (int oy = 0; oy < factor; ++oy) {
        for (int ox = 0; ox < factor; ++ox) {
          // In range whenever the plane is at least `factor` px (always, from flow_factor); clamped otherwise.
          const int sy = std::min(in.h - 1, y * factor + oy);
          const int sx = std::min(in.w - 1, x * factor + ox);
          sum += static_cast<double>(in.data[uz(sy) * uz(in.w) + uz(sx)]);
        }
      }
      out.data[uz(y) * uz(out.w) + uz(x)] = static_cast<float>(sum * inv);
    }
  }
  return out;
}

int flow_factor(int decodedW, int decodedH) noexcept { return std::max(1, std::max(decodedW, decodedH) / 480); }

scene::pixmo::FlowField compute_flow_f32(const FloatLuma& a, const FloatLuma& b) {
  const scene::pixmo::ResolvedFlowOptions o = scene::pixmo::resolve_flow_options(scene::pixmo::FlowOptions{});
  const int cols = std::max(1, a.w / o.step);
  const int rows = std::max(1, a.h / o.step);
  const std::vector<double> raw = search_cells(a, b, o.step, o.r, o.s, o.minImp);
  return scene::pixmo::finalize_flow(raw, cols, rows, o.step, o.minImp);
}

std::vector<MotionSamplePoint> flow_sample_points(const scene::pixmo::FlowField& f, double scaleX, double scaleY) {
  std::vector<MotionSamplePoint> out;
  for (int gy = 0; gy < f.rows; ++gy) {
    for (int gx = 0; gx < f.cols; ++gx) {
      const size_t i = uz(gy) * uz(f.cols) + uz(gx);
      if (f.valid[i] == 0) continue;
      out.push_back(MotionSamplePoint{(gx + 0.5) * f.step * scaleX, (gy + 0.5) * f.step * scaleY,
                                      static_cast<double>(f.dx[i]) * scaleX, static_cast<double>(f.dy[i]) * scaleY});
    }
  }
  return out;
}

std::optional<Sim> fit_similarity(std::span<const MotionSamplePoint> points, int trimRounds) {
  std::vector<MotionSamplePoint> active(points.begin(), points.end());
  std::optional<Sim> fit;
  for (int round = 0; round <= trimRounds; ++round) {
    if (active.size() < 3) return fit;
    double mx = 0;
    double my = 0;
    double mX = 0;
    double mY = 0;
    for (const MotionSamplePoint& p : active) {
      mx += p.x;
      my += p.y;
      mX += p.x + p.dx;
      mY += p.y + p.dy;
    }
    const double n = static_cast<double>(active.size());
    mx /= n;
    my /= n;
    mX /= n;
    mY /= n;
    double sxx = 0;
    double sxy = 0;
    double syx = 0;
    double syy = 0;
    double spp = 0;
    for (const MotionSamplePoint& p : active) {
      const double cx = p.x - mx;
      const double cy = p.y - my;
      const double CX = p.x + p.dx - mX;
      const double CY = p.y + p.dy - mY;
      sxx += cx * CX;
      sxy += cx * CY;
      syx += cy * CX;
      syy += cy * CY;
      spp += cx * cx + cy * cy;
    }
    if (spp < 1e-9) return fit;
    const double a = (sxx + syy) / spp;
    const double b = (sxy - syx) / spp;
    fit = Sim{a, b, mX - (a * mx - b * my), mY - (b * mx + a * my)};
    if (round == trimRounds) break;
    std::vector<double> residuals;
    residuals.reserve(active.size());
    for (const MotionSamplePoint& p : active) {
      const XY q = apply_sim(*fit, p.x, p.y);
      residuals.push_back(hypot2(q.x - (p.x + p.dx), q.y - (p.y + p.dy)));
    }
    std::vector<double> sorted = residuals;
    std::sort(sorted.begin(), sorted.end());
    const double median = sorted[sorted.size() / 2];
    const double cut = std::max(0.5, median * 2.5);
    std::vector<MotionSamplePoint> next;
    for (size_t i = 0; i < active.size(); ++i) {
      if (residuals[i] <= cut) next.push_back(active[i]);
    }
    if (next.size() == active.size()) break;
    active = std::move(next);
  }
  return fit;
}

std::optional<Sim> pair_motion(const FloatLuma& a, const FloatLuma& b, double scaleX, double scaleY) {
  const scene::pixmo::FlowField flow = compute_flow_f32(a, b);
  const std::vector<MotionSamplePoint> pts = flow_sample_points(flow, scaleX, scaleY);
  return fit_similarity(pts);
}

std::vector<Sim> stabilizing_corrections(std::span<const std::optional<Sim>> pairs, double sigmaFrames) {
  const size_t n = pairs.size() + 1;
  std::vector<Sim> path{Sim{}};
  path.reserve(n);
  for (size_t i = 0; i < pairs.size(); ++i) path.push_back(compose_sim(pairs[i].value_or(Sim{}), path[i]));
  // decomposePath: translation, UNWRAPPED rotation, log-scale.
  std::vector<double> tx(n);
  std::vector<double> ty(n);
  std::vector<double> rot(n);
  std::vector<double> logS(n);
  double prevRot = 0;
  constexpr double kPi = 3.141592653589793;
  for (size_t i = 0; i < n; ++i) {
    const Sim& s = path[i];
    tx[i] = s.tx;
    ty[i] = s.ty;
    double r = sim_rotation(s);
    while (r - prevRot > kPi) r -= 2 * kPi;
    while (r - prevRot < -kPi) r += 2 * kPi;
    rot[i] = r;
    prevRot = r;
    logS[i] = mjs::log(std::max(1e-6, sim_scale(s)));
  }
  const std::vector<double> stx = gauss_smooth(tx, sigmaFrames);
  const std::vector<double> sty = gauss_smooth(ty, sigmaFrames);
  const std::vector<double> srot = gauss_smooth(rot, sigmaFrames);
  const std::vector<double> slog = gauss_smooth(logS, sigmaFrames);
  std::vector<Sim> out;
  out.reserve(n);
  for (size_t i = 0; i < n; ++i) {
    const Sim smooth = sim_from(srot[i], mjs::exp(slog[i]), stx[i], sty[i]);
    out.push_back(compose_sim(smooth, invert_sim(path[i])));
  }
  return out;
}

}  // namespace premation::jobs::stabilize
