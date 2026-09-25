#include "precomp_frame.hpp"

#include "transform.hpp"

namespace premation::scene {

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
