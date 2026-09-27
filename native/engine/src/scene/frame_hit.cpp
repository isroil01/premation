#include "frame_hit.hpp"

#include <array>
#include <cmath>
#include <cstddef>

namespace premation::scene {
namespace {

bool in_bounds(const api::Rect& b, double x, double y) {
  return b.width > 0 && b.height > 0 && x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
}

}  // namespace

bool renderable_contains(const api::Renderable& r, double x, double y) {
  if (r.deformed_mesh || r.extruded_mesh || r.three_d || r.generator) return in_bounds(r.bounds, x, y);
  if (r.model_matrix.size() < 9) return in_bounds(r.bounds, x, y);
  // Column-major Mat3 H: (u, v, 1) → (x·w, y·w, w). Solve H·(u, v, 1)ᵀ ∝ (x, y, 1)ᵀ
  // through the adjugate (H⁻¹ up to scale, so no division by det until the end).
  const std::vector<double>& m = r.model_matrix;
  const double a = m[0], b = m[3], c = m[6];  // row 0
  const double d = m[1], e = m[4], f = m[7];  // row 1
  const double g = m[2], h = m[5], k = m[8];  // row 2
  const double det = a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g);
  const double scale = std::abs(a) + std::abs(b) + std::abs(d) + std::abs(e);
  if (!std::isfinite(det) || std::abs(det) <= 1e-9 * scale * scale) return false;  // no area: edge-on
  const std::array<double, 3> p{
      (e * k - f * h) * x + (c * h - b * k) * y + (b * f - c * e),
      (f * g - d * k) * x + (a * k - c * g) * y + (c * d - a * f),
      (d * h - e * g) * x + (b * g - a * h) * y + (a * e - b * d),
  };
  if (!(std::abs(p[2]) > 0)) return false;
  const double u = p[0] / p[2];
  const double v = p[1] / p[2];
  return u >= 0 && u <= 1 && v >= 0 && v <= 1;
}

std::vector<std::string> hit_renderables(const api::RenderFrameScene& scene, double x, double y) {
  std::vector<std::string> out;
  for (std::size_t i = scene.renderables.size(); i-- > 0;) {
    const api::Renderable& r = scene.renderables[i];
    if (r.matte_source || r.adjustment) continue;
    if (!renderable_contains(r, x, y)) continue;
    out.push_back(r.id);
  }
  return out;
}

}  // namespace premation::scene
