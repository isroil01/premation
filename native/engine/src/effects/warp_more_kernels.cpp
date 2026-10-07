// AE parity 5.5 — deformation past the fixed warps: Mesh Warp over a variable
// rows × columns mesh, Liquify's painted distortion field, and Reshape (the
// picture inside one mask morphed to another by a thin-plate spline over their
// outlines). Inverse mapping onto the bilinear remap every warp shares.
#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
#include <vector>

#include "kernels.hpp"
#include "remap.hpp"

namespace premation::effects {

namespace {

/// The field's offset at (x, y): bilinear over a (cols + 1) × (rows + 1) grid spanning w × h.
std::array<double, 2> grid_offset(std::span<const double> field, int cols, int rows, double w, double h, double x, double y) {
  const double fx = std::clamp(x / std::max(1e-9, w) * cols, 0.0, static_cast<double>(cols));
  const double fy = std::clamp(y / std::max(1e-9, h) * rows, 0.0, static_cast<double>(rows));
  const int i = std::min(cols - 1, static_cast<int>(std::floor(fx)));
  const int j = std::min(rows - 1, static_cast<int>(std::floor(fy)));
  const double tx = fx - i;
  const double ty = fy - j;
  const auto at = [&](int ii, int jj, int c) { return field[static_cast<std::size_t>((jj * (cols + 1) + ii) * 2 + c)]; };
  std::array<double, 2> out{};
  for (int c = 0; c < 2; ++c) {
    const double top = at(i, j, c) + (at(i + 1, j, c) - at(i, j, c)) * tx;
    const double bot = at(i, j + 1, c) + (at(i + 1, j + 1, c) - at(i, j + 1, c)) * tx;
    out[static_cast<std::size_t>(c)] = top + (bot - top) * ty;
  }
  return out;
}

bool all_zero(std::span<const double> v) {
  return std::ranges::all_of(v, [](double x) { return x == 0; });
}

/// Polygon resampled to `n` points evenly spaced by arc length (closed).
std::vector<std::array<double, 2>> resample_closed(std::span<const double> xy, std::size_t start, std::size_t count, std::size_t n) {
  std::vector<std::array<double, 2>> pts;
  for (std::size_t i = 0; i < count; ++i) pts.push_back({xy[(start + i) * 2], xy[(start + i) * 2 + 1]});
  std::vector<double> cum{0};
  for (std::size_t i = 1; i <= pts.size(); ++i) {
    const auto& a = pts[i - 1];
    const auto& b = pts[i % pts.size()];
    cum.push_back(cum.back() + std::hypot(b[0] - a[0], b[1] - a[1]));
  }
  const double total = cum.back();
  std::vector<std::array<double, 2>> out;
  if (total <= 0 || pts.empty()) return out;
  std::size_t seg = 0;
  for (std::size_t k = 0; k < n; ++k) {
    const double target = total * static_cast<double>(k) / static_cast<double>(n);
    while (seg + 1 < cum.size() - 1 && cum[seg + 1] < target) ++seg;
    const double len = cum[seg + 1] - cum[seg];
    const double t = len > 0 ? (target - cum[seg]) / len : 0;
    const auto& a = pts[seg];
    const auto& b = pts[(seg + 1) % pts.size()];
    out.push_back({a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t});
  }
  return out;
}

/// TPS radial basis U(r²) = r² log r².
double tps_u(double r2) { return r2 > 1e-12 ? r2 * std::log(r2) : 0.0; }

/// Solve the dense system `a · x = b` in place (partial pivoting); false when singular.
bool solve_dense(std::vector<double>& a, std::vector<double>& b, std::size_t n) {
  for (std::size_t c = 0; c < n; ++c) {
    std::size_t piv = c;
    for (std::size_t r = c + 1; r < n; ++r) {
      if (std::abs(a[r * n + c]) > std::abs(a[piv * n + c])) piv = r;
    }
    if (std::abs(a[piv * n + c]) < 1e-12) return false;
    if (piv != c) {
      for (std::size_t k = 0; k < n; ++k) std::swap(a[c * n + k], a[piv * n + k]);
      std::swap(b[c], b[piv]);
    }
    for (std::size_t r = c + 1; r < n; ++r) {
      const double f = a[r * n + c] / a[c * n + c];
      if (f == 0) continue;
      for (std::size_t k = c; k < n; ++k) a[r * n + k] -= f * a[c * n + k];
      b[r] -= f * b[c];
    }
  }
  for (std::size_t c = n; c-- > 0;) {
    double s = b[c];
    for (std::size_t k = c + 1; k < n; ++k) s -= a[c * n + k] * b[k];
    b[c] = s / a[c * n + c];
  }
  return true;
}

}  // namespace

void mesh_warp_grid(RgbaView img, int columns, int rows, std::span<const double> offsets, ThreadPool* pool) {
  const int c = std::clamp(columns, 1, 31);
  const int r = std::clamp(rows, 1, 31);
  if (offsets.size() != static_cast<std::size_t>((c + 1) * (r + 1) * 2) || all_zero(offsets)) return;
  const double w = img.w;
  const double h = img.h;
  remap_rgba(img, pool, [&](double dx, double dy) -> std::optional<RemapPt> {
    const auto o = grid_offset(offsets, c, r, w, h, dx, dy);
    return RemapPt{dx - o[0], dy - o[1]};
  });
}

void liquify_field(RgbaView img, int columns, int rows, std::span<const double> field, double amount, ThreadPool* pool) {
  if (columns < 1 || rows < 1 || field.size() != static_cast<std::size_t>((columns + 1) * (rows + 1) * 2) || amount == 0 ||
      all_zero(field)) {
    return;
  }
  const double w = img.w;
  const double h = img.h;
  remap_rgba(img, pool, [&](double dx, double dy) -> std::optional<RemapPt> {
    const auto o = grid_offset(field, columns, rows, w, h, dx, dy);
    return RemapPt{dx - o[0] * amount, dy - o[1] * amount};
  });
}

bool reshape(RgbaView img, std::span<const double> xy, std::size_t srcStart, std::size_t srcCount, std::size_t dstStart, std::size_t dstCount,
             std::span<const float> boundary, double percent, double elasticity, ThreadPool* pool) {
  const double t = std::clamp(percent, 0.0, 1.0);
  if (t <= 0 || srcCount < 3 || dstCount < 3) return false;
  constexpr std::size_t kK = 32;
  const auto src = resample_closed(xy, srcStart, srcCount, kK);
  const auto dst0 = resample_closed(xy, dstStart, dstCount, kK);
  if (src.size() != kK || dst0.size() != kK) return false;
  // Control pairs: the morph's in-between outline → the source outline (inverse map),
  // plus the frame's corners and edge midpoints holding still.
  std::vector<std::array<double, 2>> from;
  std::vector<std::array<double, 2>> to;
  for (std::size_t i = 0; i < kK; ++i) {
    from.push_back({src[i][0] + (dst0[i][0] - src[i][0]) * t, src[i][1] + (dst0[i][1] - src[i][1]) * t});
    to.push_back(src[i]);
  }
  const double w = img.w;
  const double h = img.h;
  for (const auto& p : std::array<std::array<double, 2>, 8>{{{0, 0}, {w / 2, 0}, {w, 0}, {w, h / 2}, {w, h}, {w / 2, h}, {0, h}, {0, h / 2}}}) {
    from.push_back(p);
    to.push_back(p);
  }
  const std::size_t n = from.size();
  const std::size_t m = n + 3;
  // Elasticity: a stiffer morph smooths more (TPS regularisation λ).
  const double lambda = std::max(0.0, elasticity) * 1e-3 * (w * w + h * h) / 4;
  std::vector<double> A(m * m, 0.0);
  for (std::size_t i = 0; i < n; ++i) {
    for (std::size_t j = 0; j < n; ++j) {
      const double dx = from[i][0] - from[j][0], dy = from[i][1] - from[j][1];
      A[i * m + j] = tps_u(dx * dx + dy * dy) + (i == j ? lambda : 0);
    }
    A[i * m + n] = A[n * m + i] = 1;
    A[i * m + n + 1] = A[(n + 1) * m + i] = from[i][0];
    A[i * m + n + 2] = A[(n + 2) * m + i] = from[i][1];
  }
  std::vector<double> bx(m, 0.0), by(m, 0.0);
  for (std::size_t i = 0; i < n; ++i) {
    bx[i] = to[i][0];
    by[i] = to[i][1];
  }
  std::vector<double> Ax = A;
  if (!solve_dense(Ax, bx, m) || !solve_dense(A, by, m)) return false;
  const bool bounded = boundary.size() == img.pixels();
  remap_rgba(img, pool, [&](double px, double py) -> std::optional<RemapPt> {
    if (bounded) {
      const std::size_t idx = static_cast<std::size_t>(std::clamp(static_cast<int>(py), 0, img.h - 1)) * static_cast<std::size_t>(img.w) +
                              static_cast<std::size_t>(std::clamp(static_cast<int>(px), 0, img.w - 1));
      if (boundary[idx] <= 0) return RemapPt{px, py};
    }
    double sx = bx[n] + bx[n + 1] * px + bx[n + 2] * py;
    double sy = by[n] + by[n + 1] * px + by[n + 2] * py;
    for (std::size_t i = 0; i < n; ++i) {
      const double dx = px - from[i][0], dy = py - from[i][1];
      const double u = tps_u(dx * dx + dy * dy);
      sx += bx[i] * u;
      sy += by[i] * u;
    }
    return RemapPt{sx, sy};
  });
  return true;
}

}  // namespace premation::effects
