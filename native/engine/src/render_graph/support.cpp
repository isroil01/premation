// What the C++ render graph can render today. A frame that needs anything else
// is reported `not-ported` (with every reason) instead of being drawn wrong —
// the parity harness counts it, never fails it, and the list below is exactly
// the "what remains" of D2.
#include "support.hpp"

#include <algorithm>

#include "effect_chain.hpp"
#include "threed.hpp"

namespace premation::rg {
namespace {

void add(std::vector<std::string>& out, std::string why) {
  if (std::find(out.begin(), out.end(), why) == out.end()) out.push_back(std::move(why));
}

void check(const api::Renderable& r, bool sceneHas3d, const api::RenderFrameFile& f, std::vector<std::string>& out) {
  if (r.extruded_mesh && !(sceneHas3d && depth_eligible_3d(r))) add(out, "extruded mesh outside a 3D group");
  if (r.precomp && r.precomp->flat_width) add(out, "3D composition card");
  for (const auto& e : r.effects) {
    std::string why;
    if (!effect_ported(e, why)) add(out, why);
    if (e.type == "plugin") {
      const Fx fx(e);
      const bool have = std::any_of(f.shaders.begin(), f.shaders.end(), [&](const auto& s) { return s.name == fx.text("shader"); });
      if (!have) add(out, "plugin effect without its shader source");
    }
  }
  for (const auto& c : r.precomp_children) check(c, sceneHas3d || (r.precomp && r.precomp->camera3d), f, out);
}

}  // namespace

std::vector<std::string> unported_features(const api::RenderFrameFile& f) {
  std::vector<std::string> out;
  if (f.view.overlays_active) add(out, "overlay pass (grid / guides)");
  if (f.view.viewer_lut_active) add(out, "viewer LUT blit");
  if (f.view.bit_depth == 32) add(out, "32-bit float intermediates");
  const bool has3d = f.scene.camera3d.has_value();
  for (const auto& r : f.scene.renderables) check(r, has3d, f, out);
  unported_3d(f, out);
  for (const auto& b : f.blobs) {
    if (b.mipmapped) add(out, "mipmapped texture");
  }
  return out;
}

}  // namespace premation::rg
