#include "mask_fit.hpp"

#include <cmath>
#include <vector>

namespace premation::jobs::maskfit {

namespace {

using tracking::Pt;

struct Centroids {
  Pt s, d;
};
Centroids centroids(std::span<const Pt> src, std::span<const Pt> dst) {
  Centroids c;
  const double n = static_cast<double>(src.size());
  for (std::size_t i = 0; i < src.size(); ++i) {
    c.s.x += src[i].x / n;
    c.s.y += src[i].y / n;
    c.d.x += dst[i].x / n;
    c.d.y += dst[i].y / n;
  }
  return c;
}

/// Solve the 3×3 system `m · x = r` (Cramer); false when singular.
bool solve3(const std::array<double, 9>& m, const std::array<double, 3>& r, std::array<double, 3>& x) {
  const auto det3 = [](const std::array<double, 9>& a) {
    return a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
  };
  const double det = det3(m);
  if (std::abs(det) < 1e-12) return false;
  for (std::size_t k = 0; k < 3; ++k) {
    std::array<double, 9> mk = m;
    for (std::size_t row = 0; row < 3; ++row) mk[row * 3 + k] = r[row];
    x[k] = det3(mk) / det;
  }
  return true;
}

}  // namespace

std::optional<Affine> fit_affine(std::span<const Pt> src, std::span<const Pt> dst, Method method) {
  const std::size_t n = std::min(src.size(), dst.size());
  if (n == 0 || method == Method::vertices || method == Method::perspective) return std::nullopt;
  src = src.first(n);
  dst = dst.first(n);
  const Centroids c = centroids(src, dst);
  Affine t;
  if (method == Method::position) {
    t.tx = c.d.x - c.s.x;
    t.ty = c.d.y - c.s.y;
    return t;
  }
  if (method == Method::positionRotation || method == Method::positionScaleRotation) {
    if (n < 2) return std::nullopt;
    // Procrustes: the rotation (and scale) about the centroids.
    double sxx = 0, sxy = 0, norm = 0;
    for (std::size_t i = 0; i < n; ++i) {
      const double ux = src[i].x - c.s.x, uy = src[i].y - c.s.y;
      const double vx = dst[i].x - c.d.x, vy = dst[i].y - c.d.y;
      sxx += ux * vx + uy * vy;
      sxy += ux * vy - uy * vx;
      norm += ux * ux + uy * uy;
    }
    if (norm < 1e-12) return std::nullopt;
    const double angle = std::atan2(sxy, sxx);
    const double scale = method == Method::positionScaleRotation ? std::hypot(sxx, sxy) / norm : 1.0;
    t.a = scale * std::cos(angle);
    t.b = scale * std::sin(angle);
    t.c = -t.b;
    t.d = t.a;
    t.tx = c.d.x - (t.a * c.s.x + t.c * c.s.y);
    t.ty = c.d.y - (t.b * c.s.x + t.d * c.s.y);
    return t;
  }
  // Affine: least squares, x' and y' solved separately over [x, y, 1].
  if (n < 3) return std::nullopt;
  std::array<double, 9> m{};
  std::array<double, 3> rx{}, ry{};
  for (std::size_t i = 0; i < n; ++i) {
    const std::array<double, 3> v{src[i].x, src[i].y, 1};
    for (std::size_t r = 0; r < 3; ++r) {
      for (std::size_t k = 0; k < 3; ++k) m[r * 3 + k] += v[r] * v[k];
      rx[r] += v[r] * dst[i].x;
      ry[r] += v[r] * dst[i].y;
    }
  }
  std::array<double, 3> px{}, py{};
  if (!solve3(m, rx, px) || !solve3(m, ry, py)) return std::nullopt;
  t.a = px[0];
  t.c = px[1];
  t.tx = px[2];
  t.b = py[0];
  t.d = py[1];
  t.ty = py[2];
  return t;
}

void transform_path(api::BezierPath& path, const Affine& t) {
  for (std::size_t i = 0; i + 1 < path.vertices.size(); i += 2) {
    const double x = path.vertices[i], y = path.vertices[i + 1];
    path.vertices[i] = t.a * x + t.c * y + t.tx;
    path.vertices[i + 1] = t.b * x + t.d * y + t.ty;
  }
  for (std::vector<double>* tan : {&path.in_tangents, &path.out_tangents}) {
    for (std::size_t i = 0; i + 1 < tan->size(); i += 2) {
      const double x = (*tan)[i], y = (*tan)[i + 1];
      (*tan)[i] = t.a * x + t.c * y;
      (*tan)[i + 1] = t.b * x + t.d * y;
    }
  }
}

void transform_path(api::BezierPath& path, const tracking::Mat3& h) {
  const std::vector<double> before = path.vertices;
  const auto project = [&](double x, double y, double& ox, double& oy) {
    const auto p = tracking::project_homography(h, Pt{x, y});
    ox = p ? p->x : x;
    oy = p ? p->y : y;
  };
  for (std::size_t i = 0; i + 1 < path.vertices.size(); i += 2) project(before[i], before[i + 1], path.vertices[i], path.vertices[i + 1]);
  for (std::vector<double>* tan : {&path.in_tangents, &path.out_tangents}) {
    for (std::size_t i = 0; i + 1 < tan->size() && i + 1 < before.size(); i += 2) {
      double ex = 0, ey = 0;
      project(before[i] + (*tan)[i], before[i + 1] + (*tan)[i + 1], ex, ey);
      (*tan)[i] = ex - path.vertices[i];
      (*tan)[i + 1] = ey - path.vertices[i + 1];
    }
  }
}

Method method_of(api::MaskTrackMethod m) noexcept {
  switch (m) {
    case api::MaskTrackMethod::position: return Method::position;
    case api::MaskTrackMethod::position_rotation: return Method::positionRotation;
    case api::MaskTrackMethod::position_scale_rotation: return Method::positionScaleRotation;
    case api::MaskTrackMethod::affine: return Method::affine;
    case api::MaskTrackMethod::perspective: return Method::perspective;
    case api::MaskTrackMethod::vertices: break;
  }
  return Method::vertices;
}

}  // namespace premation::jobs::maskfit
