// What the C++ render graph can render today. A frame that needs anything else
// is reported `not-ported` (with every reason) instead of being drawn wrong —
// the parity harness counts it, never fails it, and the list below is exactly
// the "what remains" of D2.
#include "support.hpp"

#include <algorithm>

#include "color/color_system.hpp"
#include "effect_chain.hpp"
#include "threed.hpp"

namespace premation::rg {
namespace {

void add(std::vector<std::string>& out, std::string why) {
  if (std::ranges::find(out, why) == out.end()) out.push_back(std::move(why));
}

void check(const api::Renderable& r, bool sceneHas3d, const api::RenderFrameFile& f, std::vector<std::string>& out) {
  if (r.extruded_mesh && !(sceneHas3d && depth_eligible_3d(r))) add(out, "extruded mesh outside a 3D group");
  if (r.precomp && r.precomp->flat_width) add(out, "3D composition card");
  for (const auto& e : r.effects) {
    std::string why;
    if (!effect_ported(e, why)) add(out, why);
    if (e.type == "plugin") {
      const Fx fx(e);
      const bool have = std::ranges::any_of(f.shaders, [&](const auto& s) { return s.name == fx.text("shader"); });
      if (!have) add(out, "plugin effect without its shader source");
    }
  }
  for (const auto& c : r.precomp_children) check(c, sceneHas3d || (r.precomp && r.precomp->camera3d), f, out);
}

}  // namespace

std::vector<std::string> unported_features(const api::RenderFrameFile& f) {
  std::vector<std::string> out;
  // Overlays and the viewer LUT are drawn when the file carries their
  // parameters (RenderView.overlays / viewerLut); an older exporter set only the flags.
  if (f.view.overlays_active && !f.view.overlays) add(out, "overlay pass without its parameters (re-export the scene)");
  if (f.view.viewer_lut_active && !f.view.viewer_lut) add(out, "viewer LUT without its parameters (re-export the scene)");
  if (f.view.color_management && !ColorSystem::available()) add(out, "colour management (this build has no OpenColorIO)");
  const bool has3d = f.scene.camera3d.has_value();
  for (const auto& r : f.scene.renderables) check(r, has3d, f, out);
  unported_3d(f, out);
  return out;
}

}  // namespace premation::rg
