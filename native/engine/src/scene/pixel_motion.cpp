#include "pixel_motion.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <cstring>

#include "jsmath.hpp"

namespace premation::scene::pixmo {

namespace {

namespace mjs = motion::js;

using Sz = std::size_t;

Sz uz(int v) { return static_cast<Sz>(v); }

/// blockSad: SAD between the block in `a` at (ax, ay) and the one in `b` at
/// (ax+dx, ay+dy); out-of-bounds samples clamp. Integer, exact.
double block_sad(std::span<const std::int32_t> a, std::span<const std::int32_t> b, int w, int h, int ax, int ay, int dx, int dy,
                 int r) {
  std::int64_t sad = 0;
  for (int oy = -r; oy <= r; ++oy) {
    const int ya = std::min(h - 1, std::max(0, ay + oy));
    const int yb = std::min(h - 1, std::max(0, ay + oy + dy));
    for (int ox = -r; ox <= r; ++ox) {
      const int xa = std::min(w - 1, std::max(0, ax + ox));
      const int xb = std::min(w - 1, std::max(0, ax + ox + dx));
      sad += std::llabs(static_cast<std::int64_t>(a[(uz(ya) * uz(w)) + uz(xa)]) - b[(uz(yb) * uz(w)) + uz(xb)]);
    }
  }
  return static_cast<double>(sad);
}

/// parabolic: the three-point vertex, clamped to ±0.5.
double parabolic(double cm, double c0, double cp) {
  const double denom = cm - (2 * c0) + cp;
  if (denom <= 1e-9) return 0;
  const double off = (0.5 * (cm - cp)) / denom;
  return std::max(-0.5, std::min(0.5, off));
}

/// bilinearRgba: edge-clamped bilinear fetch into float32 `px`.
void bilinear_rgba(std::span<const std::uint8_t> data, int w, int h, double x, double y, std::array<float, 4>& px) {
  const double cx = std::min(static_cast<double>(w - 1), std::max(0.0, x));
  const double cy = std::min(static_cast<double>(h - 1), std::max(0.0, y));
  const double x0 = std::floor(cx);
  const double y0 = std::floor(cy);
  const double x1 = std::min(static_cast<double>(w - 1), x0 + 1);
  const double y1 = std::min(static_cast<double>(h - 1), y0 + 1);
  const double fx = cx - x0;
  const double fy = cy - y0;
  const Sz W = uz(w);
  const Sz p00 = ((static_cast<Sz>(y0) * W) + static_cast<Sz>(x0)) * 4;
  const Sz p10 = ((static_cast<Sz>(y0) * W) + static_cast<Sz>(x1)) * 4;
  const Sz p01 = ((static_cast<Sz>(y1) * W) + static_cast<Sz>(x0)) * 4;
  const Sz p11 = ((static_cast<Sz>(y1) * W) + static_cast<Sz>(x1)) * 4;
  for (Sz c = 0; c < 4; ++c) {
    const double v = (((data[p00 + c] * (1 - fx)) + (data[p10 + c] * fx)) * (1 - fy)) +
                     (((data[p01 + c] * (1 - fx)) + (data[p11 + c] * fx)) * fy);
    px[c] = static_cast<float>(v);
  }
}

}  // namespace

std::uint8_t to_uint8_clamp(double v) noexcept {
  if (std::isnan(v) || v <= 0) return 0;
  if (v >= 255) return 255;
  const double f = std::floor(v);
  double r = f;
  if (f + 0.5 < v) {
    r = f + 1;
  } else if (!(v < f + 0.5)) {
    r = std::fmod(f, 2) == 0 ? f : f + 1;  // a tie rounds to even
  }
  return static_cast<std::uint8_t>(r);
}

ResolvedFlowOptions resolve_flow_options(const FlowOptions& o) {
  ResolvedFlowOptions r;
  r.step = static_cast<int>(std::max(4.0, o.step));
  r.r = static_cast<int>(std::max(2.0, o.blockRadius));
  r.s = static_cast<int>(std::max(2.0, o.searchRadius));
  r.minImp = o.minImprovement;
  return r;
}

std::vector<std::int32_t> luma_int_of(std::span<const std::uint8_t> rgba, int w, int h) {
  std::vector<std::int32_t> out(uz(w) * uz(h), 0);
  for (Sz i = 0, p = 0; i < out.size(); ++i, p += 4) {
    out[i] = (rgba[p] * 77) + (rgba[p + 1] * 150) + (rgba[p + 2] * 29);
  }
  return out;
}

std::vector<double> search_all_cells(std::span<const std::int32_t> a, std::span<const std::int32_t> b, int w, int h, int step, int r,
                                     int s, double minImp) {
  const int cols = std::max(1, w / step);
  const int rows = std::max(1, h / step);
  std::vector<double> raw(uz(cols) * uz(rows) * kSearchStride, 0);
  for (int gy = 0; gy < rows; ++gy) {
    for (int gx = 0; gx < cols; ++gx) {
      const int ax = std::min(w - 1, static_cast<int>(mjs::round((gx + 0.5) * step)));
      const int ay = std::min(h - 1, static_cast<int>(mjs::round((gy + 0.5) * step)));
      const double zero = block_sad(a, b, w, h, ax, ay, 0, 0, r);
      double best = zero;
      int bx = 0;
      int by = 0;
      for (int oy = -s; oy <= s; oy += 2) {
        for (int ox = -s; ox <= s; ox += 2) {
          if (ox == 0 && oy == 0) continue;
          const double sad = block_sad(a, b, w, h, ax, ay, ox, oy, r);
          if (sad < best) {
            best = sad;
            bx = ox;
            by = oy;
          }
        }
      }
      // Refine around the coarse winner (anchored: a neighbourhood argmin).
      const int cx = bx;
      const int cy = by;
      for (int oy = -1; oy <= 1; ++oy) {
        for (int ox = -1; ox <= 1; ++ox) {
          if (ox == 0 && oy == 0) continue;
          const double sad = block_sad(a, b, w, h, ax, ay, cx + ox, cy + oy, r);
          if (sad < best) {
            best = sad;
            bx = cx + ox;
            by = cy + oy;
          }
        }
      }
      const Sz o = ((uz(gy) * uz(cols)) + uz(gx)) * kSearchStride;
      raw[o] = zero;
      raw[o + 1] = best;
      raw[o + 2] = bx;
      raw[o + 3] = by;
      if (zero - best < minImp * std::max(1.0, zero)) continue;
      raw[o + 4] = block_sad(a, b, w, h, ax, ay, bx - 1, by, r);
      raw[o + 5] = block_sad(a, b, w, h, ax, ay, bx + 1, by, r);
      raw[o + 6] = block_sad(a, b, w, h, ax, ay, bx, by - 1, r);
      raw[o + 7] = block_sad(a, b, w, h, ax, ay, bx, by + 1, r);
    }
  }
  return raw;
}

FlowField finalize_flow(std::span<const double> raw, int cols, int rows, int step, double minImp) {
  const Sz n = uz(cols) * uz(rows);
  std::vector<float> dx(n, 0.0F);
  std::vector<float> dy(n, 0.0F);
  FlowField f;
  f.cols = cols;
  f.rows = rows;
  f.step = step;
  f.valid.assign(n, 0);
  for (Sz i = 0; i < n; ++i) {
    const Sz o = i * kSearchStride;
    const double zero = raw[o];
    const double best = raw[o + 1];
    if (zero - best < minImp * std::max(1.0, zero)) continue;
    dx[i] = static_cast<float>(raw[o + 2] + parabolic(raw[o + 4], best, raw[o + 5]));
    dy[i] = static_cast<float>(raw[o + 3] + parabolic(raw[o + 6], best, raw[o + 7]));
    f.valid[i] = 1;
  }
  // One 3×3 box-smooth so neighbours share their estimate.
  f.dx = dx;
  f.dy = dy;
  for (int gy = 0; gy < rows; ++gy) {
    for (int gx = 0; gx < cols; ++gx) {
      double sx = 0;
      double sy = 0;
      int cnt = 0;
      for (int oy = -1; oy <= 1; ++oy) {
        for (int ox = -1; ox <= 1; ++ox) {
          const int yy = gy + oy;
          const int xx = gx + ox;
          if (yy < 0 || yy >= rows || xx < 0 || xx >= cols) continue;
          sx += static_cast<double>(dx[(uz(yy) * uz(cols)) + uz(xx)]);
          sy += static_cast<double>(dy[(uz(yy) * uz(cols)) + uz(xx)]);
          ++cnt;
        }
      }
      f.dx[(uz(gy) * uz(cols)) + uz(gx)] = static_cast<float>(sx / cnt);
      f.dy[(uz(gy) * uz(cols)) + uz(gx)] = static_cast<float>(sy / cnt);
    }
  }
  return f;
}

FlowField compute_flow(std::span<const std::int32_t> a, std::span<const std::int32_t> b, int w, int h, const FlowOptions& opts) {
  const ResolvedFlowOptions o = resolve_flow_options(opts);
  const int cols = std::max(1, w / o.step);
  const int rows = std::max(1, h / o.step);
  const std::vector<double> raw = search_all_cells(a, b, w, h, o.step, o.r, o.s, o.minImp);
  return finalize_flow(raw, cols, rows, o.step, o.minImp);
}

void warp_blend(std::span<const std::uint8_t> a, std::span<const std::uint8_t> b, int w, int h, const FlowField& flow,
                double flowScaleX, double flowScaleY, double t, std::span<std::uint8_t> out) {
  std::array<float, 4> pa{};
  std::array<float, 4> pb{};
  const double invSX = 1 / flowScaleX;
  const double invSY = 1 / flowScaleY;
  const int cols = flow.cols;
  const int rows = flow.rows;
  const double step = flow.step;
  const auto fget = [](const std::vector<float>& v, Sz i) { return static_cast<double>(v[i]); };
  std::vector<Sz> x0s(uz(w));
  std::vector<Sz> x1s(uz(w));
  std::vector<double> fxs(uz(w));
  for (int x = 0; x < w; ++x) {
    const double gx = std::min(static_cast<double>(cols - 1), std::max(0.0, ((x * invSX) / step) - 0.5));
    const double x0 = std::floor(gx);
    x0s[uz(x)] = static_cast<Sz>(x0);
    x1s[uz(x)] = static_cast<Sz>(std::min(static_cast<double>(cols - 1), x0 + 1));
    fxs[uz(x)] = gx - x0;
  }
  Sz o = 0;
  for (int y = 0; y < h; ++y) {
    const double gy = std::min(static_cast<double>(rows - 1), std::max(0.0, ((y * invSY) / step) - 0.5));
    const double y0 = std::floor(gy);
    const double y1 = std::min(static_cast<double>(rows - 1), y0 + 1);
    const double fy = gy - y0;
    const Sz r0 = static_cast<Sz>(y0) * uz(cols);
    const Sz r1 = static_cast<Sz>(y1) * uz(cols);
    for (int x = 0; x < w; ++x, o += 4) {
      const Sz x0 = x0s[uz(x)];
      const Sz x1 = x1s[uz(x)];
      const double fx = fxs[uz(x)];
      const Sz i00 = r0 + x0;
      const Sz i10 = r0 + x1;
      const Sz i01 = r1 + x0;
      const Sz i11 = r1 + x1;
      const double fdxv = (((fget(flow.dx, i00) * (1 - fx)) + (fget(flow.dx, i10) * fx)) * (1 - fy)) +
                          (((fget(flow.dx, i01) * (1 - fx)) + (fget(flow.dx, i11) * fx)) * fy);
      const double fdyv = (((fget(flow.dy, i00) * (1 - fx)) + (fget(flow.dy, i10) * fx)) * (1 - fy)) +
                          (((fget(flow.dy, i01) * (1 - fx)) + (fget(flow.dy, i11) * fx)) * fy);
      const double dx = fdxv * flowScaleX;
      const double dy = fdyv * flowScaleY;
      bilinear_rgba(a, w, h, x - (dx * t), y - (dy * t), pa);
      bilinear_rgba(b, w, h, x + (dx * (1 - t)), y + (dy * (1 - t)), pb);
      for (Sz c = 0; c < 4; ++c) {
        out[o + c] = to_uint8_clamp((static_cast<double>(pa[c]) * (1 - t)) + (static_cast<double>(pb[c]) * t));
      }
    }
  }
}

void deinterlace_data(std::span<std::uint8_t> data, int width, int height, bool keepUpper) {
  if (width < 1 || height < 2) return;
  const int keepParity = keepUpper ? 0 : 1;
  const Sz rowBytes = uz(width) * 4;
  for (int y = 0; y < height; ++y) {
    if ((y & 1) == keepParity) continue;
    const int above = y - 1;
    const int below = y + 1;
    const Sz row = uz(y) * rowBytes;
    if (above < 0) {  // top edge: only the kept row below exists
      std::memmove(data.data() + row, data.data() + (uz(below) * rowBytes), rowBytes);
      continue;
    }
    if (below >= height) {
      std::memmove(data.data() + row, data.data() + (uz(above) * rowBytes), rowBytes);
      continue;
    }
    const Sz ra = uz(above) * rowBytes;
    const Sz rb = uz(below) * rowBytes;
    for (Sz x = 0; x < rowBytes; ++x) {
      data[row + x] = static_cast<std::uint8_t>((data[ra + x] + data[rb + x] + 1) >> 1);  // +1 rounds to nearest
    }
  }
}

}  // namespace premation::scene::pixmo
