#include "threed_frame.hpp"

#include <algorithm>
#include <limits>
#include <set>
#include <string>

#include "frame_build.hpp"
#include "jsmath.hpp"
#include "transform.hpp"

namespace premation::scene {

namespace {

float f32(double v) { return static_cast<float>(v); }

bool is_identity(const Mat3& m) {
  const auto& a = m.m;
  return a[0] == 1 && a[1] == 0 && a[2] == 0 && a[3] == 0 && a[4] == 1 && a[5] == 0 && a[6] == 0 && a[7] == 0 && a[8] == 1;
}

/// `threeDPlacementOk(parentMatrix, undefined)`: the host camera carries no
/// placement, so only an identity flatten parent keeps the 3D path. (Sealed 3D
/// comp scopes, whose camera carries the instance placement, are not ported.)
bool placement_ok(const Mat3& parent) { return is_identity(parent); }

/// `model3dFor(world3d, layer)`: world3d · the w×h unit-quad bridge (float64).
std::vector<double> model3d_for(const std::array<double, 16>& world3d, const RLayer& l) {
  const double pad = raster_padding(l);
  const double W = l.width + 2 * pad;
  const double H = l.height + 2 * pad;
  const double ox = -0.5 - (W > 0 ? l.anchorX / W : 0);
  const double oy = -0.5 - (H > 0 ? l.anchorY / H : 0);
  const motion::xf::Mat4 bridge = {W, 0, 0, 0, 0, H, 0, 0, 0, 0, 1, 0, ox * W, oy * H, 0, 1};
  motion::xf::Mat4 w{};
  std::copy(world3d.begin(), world3d.end(), w.begin());
  const motion::xf::Mat4 m = motion::xf::multiply(w, bridge);
  return {m.begin(), m.end()};
}

api::Rect bounds_of(const Mat3& mm) {
  const auto& m = mm.m;
  const std::array<std::array<double, 2>, 4> pts = {{
      {m[6], m[7]},
      {static_cast<double>(m[0]) + m[6], static_cast<double>(m[1]) + m[7]},
      {static_cast<double>(m[3]) + m[6], static_cast<double>(m[4]) + m[7]},
      {static_cast<double>(m[0]) + m[3] + m[6], static_cast<double>(m[1]) + m[4] + m[7]},
  }};
  constexpr double kInf = std::numeric_limits<double>::infinity();
  double minX = kInf, minY = kInf, maxX = -kInf, maxY = -kInf;
  for (const auto& p : pts) {
    minX = std::min(minX, p[0]);
    minY = std::min(minY, p[1]);
    maxX = std::max(maxX, p[0]);
    maxY = std::max(maxY, p[1]);
  }
  api::Rect r;
  r.x = minX;
  r.y = minY;
  r.width = maxX - minX;
  r.height = maxY - minY;
  return r;
}

bool check_three_d(const std::vector<api::Renderable>& rs) {
  return std::ranges::any_of(rs, [](const api::Renderable& r) { return r.three_d.has_value() || (r.precomp && check_three_d(r.precomp_children)); });
}

constexpr std::string_view kExtFaceMark = "::ext-";

std::string extrusion_base_id(const std::string& id) {
  const std::size_t at = id.find(kExtFaceMark);
  return at == std::string::npos ? id : id.substr(0, at);
}

void drop_meshes_outside_depth_path(std::vector<api::Renderable>& rs) {
  std::erase_if(rs, [](const api::Renderable& r) { return r.extruded_mesh && (r.depth_exempt || !r.three_d); });
}

void drop_meshes_everywhere(std::vector<api::Renderable>& rs) {
  for (std::size_t i = rs.size(); i-- > 0;) {
    api::Renderable& r = rs[i];
    if (r.precomp && !r.precomp->camera3d) drop_meshes_everywhere(r.precomp_children);
    if (r.extruded_mesh) rs.erase(rs.begin() + static_cast<std::ptrdiff_t>(i));
  }
}

/// `enforceExtrusionPathAgreement(renderables)`.
void enforce_extrusion_path_agreement(std::vector<api::Renderable>& rs) {
  for (api::Renderable& r : rs) {
    if (r.precomp) enforce_extrusion_path_agreement(r.precomp_children);
  }
  std::set<std::string, std::less<>> owners;
  for (const api::Renderable& r : rs) {
    if (r.id.find(kExtFaceMark) != std::string::npos) owners.insert(extrusion_base_id(r.id));
  }
  if (owners.empty()) return;
  std::set<std::string, std::less<>> split;
  for (const api::Renderable& r : rs) {
    const std::string base = extrusion_base_id(r.id);
    if (!owners.contains(base)) continue;
    if (!depth_eligible_3d(r)) split.insert(base);
  }
  if (split.empty()) return;
  for (api::Renderable& r : rs) {
    if (split.contains(extrusion_base_id(r.id))) r.depth_exempt = true;
  }
  drop_meshes_outside_depth_path(rs);
}

}  // namespace

bool depth_eligible_3d(const api::Renderable& r) {
  if (!r.three_d) return false;
  if (r.depth_exempt) return false;
  if (r.matte_source || r.matte || r.adjustment || r.precomp || r.generator) return false;
  if (r.advanced_blend && *r.advanced_blend > 0) return false;
  if (r.preserve_transparency) return false;
  if (r.glass || (r.backdrop_blur && *r.backdrop_blur > 0)) return false;
  if (r.motion_samples.size() > 1) return false;
  if (r.deformed_mesh) return false;
  return true;
}

void apply_three_d(const RLayer& l, const Mat3& parent, api::Renderable& r) {
  // Corner pin is not ported (reported by the walk), so `!pinned` holds.
  if (l.world3d && l.matrix && placement_ok(parent)) {
    api::RenderThreeD t;
    t.model = model3d_for(*l.world3d, l);
    r.three_d = std::move(t);
  }
  if (l.castsShadow3d && r.three_d) r.three_d->casts_shadow = true;
  if (l.lighting) {
    if (l.shade3d && r.three_d && depth_eligible_3d(r)) {
      api::RenderShade3D s;
      const api::RenderShade3D& src = *l.shade3d;
      s.specular = src.specular;
      s.shininess = src.shininess;
      if (src.metal && *src.metal != 0) s.metal = src.metal;  // `...(metal ? {metal} : {})`
      s.roughness = src.roughness;
      s.toon_bands = src.toon_bands;
      if (src.one_sided.value_or(false)) s.one_sided = true;
      s.ambient = src.ambient;
      s.diffuse = src.diffuse;
      s.reflection_intensity = src.reflection_intensity;
      s.reflection_sharpness = src.reflection_sharpness;
      s.reflection_rolloff = src.reflection_rolloff;
      s.transparency = src.transparency;
      s.transparency_rolloff = src.transparency_rolloff;
      s.ior = src.ior;
      if (l.acceptsShadows3d && !*l.acceptsShadows3d) s.accepts_shadows = false;
      s.quad_gain = {(*l.lighting)[0], (*l.lighting)[1], (*l.lighting)[2]};
      r.three_d->shade = std::move(s);
    } else if (r.color) {
      r.color->r = r.color->r * (*l.lighting)[0];
      r.color->g = r.color->g * (*l.lighting)[1];
      r.color->b = r.color->b * (*l.lighting)[2];
    }
  }
}

api::Renderable light_to_renderable(const RLayer& l, const Mat3& parent, double parentOpacity) {
  const LightWash& lw = *l.light;
  const double size = std::max(1.0, lw.screenRadius) * 2;
  const double aim = (l.rotation * std::numbers::pi) / 180;
  const double c = motion::js::cos(aim);
  const double s = motion::js::sin(aim);
  Mat3 compose;
  compose.m = {f32(c * size), f32(s * size), 0, f32(-s * size), f32(c * size), 0, f32(l.x), f32(l.y), 1};
  Mat3 tr;
  tr.m[6] = f32(-0.5);
  tr.m[7] = f32(-0.5);
  const Mat3 model = mat3_mul(parent, mat3_mul(compose, tr));
  api::Renderable r;
  r.id = l.id;
  r.kind = api::RenderableKind::image;
  r.model_matrix.assign(model.m.begin(), model.m.end());
  r.bounds = bounds_of(model);
  r.opacity = parentOpacity * std::max(0.0, std::min(1.0, lw.intensity / 100));
  r.blend = api::RenderBlendMode::screen;
  api::Color white;
  white.r = 1;
  white.g = 1;
  white.b = 1;
  white.a = 1;
  r.color = white;
  r.texture_key = "light:" + l.id;
  r.light_wash = true;
  return r;
}

bool finish_frame_3d(const Snapshot& s, api::RenderFrameScene& sc) {
  enforce_extrusion_path_agreement(sc.renderables);
  const bool has3d = s.camera3d.has_value() && check_three_d(sc.renderables);
  if (!has3d) {
    drop_meshes_everywhere(sc.renderables);
    return false;
  }
  sc.camera3d = s.camera3d;
  if (!s.lights3d.empty()) sc.lights3d = s.lights3d;
  if (s.ssao && s.ssao->enabled) sc.ssao = s.ssao;
  return true;
}

}  // namespace premation::scene
