#include "precomp_frame.hpp"

#include <cmath>

#include "transform.hpp"

namespace premation::scene {

std::optional<Mat3> square_to_quad(const std::array<double, 8>& q) {
  const double p0x = q[0], p0y = q[1], p1x = q[2], p1y = q[3], p2x = q[4], p2y = q[5], p3x = q[6], p3y = q[7];
  const double dx1 = p1x - p2x;
  const double dx2 = p3x - p2x;
  const double dx3 = p0x - p1x + p2x - p3x;
  const double dy1 = p1y - p2y;
  const double dy2 = p3y - p2y;
  const double dy3 = p0y - p1y + p2y - p3y;
  double a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0;
  if (std::abs(dx3) < 1e-12 && std::abs(dy3) < 1e-12) {
    a = p1x - p0x;
    b = p2x - p1x;
    c = p0x;
    d = p1y - p0y;
    e = p2y - p1y;
    f = p0y;
  } else {
    const double den = dx1 * dy2 - dx2 * dy1;
    if (std::abs(den) < 1e-12) return std::nullopt;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
    a = p1x - p0x + g * p1x;
    b = p3x - p0x + h * p3x;
    c = p0x;
    d = p1y - p0y + g * p1y;
    e = p3y - p0y + h * p3y;
    f = p0y;
  }
  Mat3 m;
  const auto f32 = [](double v) { return static_cast<float>(v); };
  m.m = {f32(a), f32(d), f32(g), f32(b), f32(e), f32(h), f32(c), f32(f), 1};
  return m;
}

api::RenderPrecompFrame precomp_frame(const RLayer& l, const Mat3& placement, bool card) {
  api::RenderPrecompFrame out;
  if (l.precompScene3d) {
    const PrecompScene3D& own = *l.precompScene3d;
    const auto& P = placement.m;
    const motion::xf::Mat4 lift = {P[0], P[1], 0, 0, P[3], P[4], 0, 0, 0, 0, 1, 0, P[6], P[7], 0, 1};
    motion::xf::Mat4 proj{};
    for (std::size_t i = 0; i < 16 && i < own.camera3d.projection.size(); ++i) proj[i] = own.camera3d.projection[i];
    const motion::xf::Mat4 lifted = motion::xf::multiply(lift, proj);
    api::RenderCamera3D cam = own.camera3d;
    cam.projection.assign(lifted.begin(), lifted.end());
    out.camera3d = std::move(cam);
    if (!own.lights3d.empty()) out.lights3d = own.lights3d;
    if (own.envMap) out.env_map = own.envMap;
  }
  if (card) {
    out.flat_width = l.width;
    out.flat_height = l.height;
  }
  return out;
}

}  // namespace premation::scene
