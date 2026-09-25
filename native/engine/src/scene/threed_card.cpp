// A 3D comp LAYER (buildSnapshot.ts buildPrecompContainer, the `card3d` block):
// the referenced composition renders FLAT, as a card, and the card sits in the
// host's 3D space — placed like an ordinary 3D layer (local TRS, orientation,
// anchor Z, under the 3D parent chain), its four anchor-relative corners
// projected through the host camera. Motion blur re-projects the card through
// the sub-frame camera per sample; Accepts Lights tints it by the per-quad gain.
#include <algorithm>
#include <cmath>

#include "jsmath.hpp"
#include "lights3d.hpp"
#include "scene.hpp"
#include "scene_math.hpp"
#include "threed_port.hpp"

namespace premation::scene {

namespace xf = motion::xf;

namespace {

double transform_num(const doc::Node& n, std::string_view k) {
  const doc::Component* t = n.comp("Transform");
  if (t == nullptr) return 0;
  const Json& v = t->props.at(k);
  return v.is_number() ? v.num() : 0;
}

std::array<double, 16> arr16(const xf::Mat4& m) {
  std::array<double, 16> a{};
  std::copy(m.begin(), m.end(), a.begin());
  return a;
}

}  // namespace

Scene3D::CardPlan Scene3D::comp_card(const doc::Node& group, const Values& gv, const xf::Local2D& gWorld, double baseX,
                                     double baseY, double baseRot, double baseScaleX, double baseScaleY, double refW,
                                     double refH, double anchorX, double anchorY,
                                     const std::function<std::optional<double>(std::string_view, double)>& sample) {
  CardPlan plan;
  // `plan.at` outlives this call (the walk's motion samples): hold the sampler by value.
  const std::function<std::optional<double>(std::string_view, double)> smp = sample;
  const std::optional<xf::Mat4> parent3d = parent_world_3d(group.id);
  const double t = t_;
  const auto num = [&gv](std::string_view k) { return gv.get(k); };
  const doc::Component* tc = group.comp("Transform");
  const Json& scaleZProp = tc != nullptr ? tc->props.at("scaleZ") : Json();
  // Sub-frame values (worldProp / worldScale / ownProp): a property the world
  // pose carries moves by this layer's own change across the shutter.
  const auto worldProp = [smp, t, parent3d](std::string_view k, double now, double ti) {
    if (ti == t) return now;
    const auto s = smp(k, ti);
    if (!s) return now;
    if (parent3d) return *s;
    const auto s0 = smp(k, t);
    return s0 ? now + (*s - *s0) : now;
  };
  const auto worldScale = [smp, t, parent3d](std::string_view k, double now, double ti) {
    if (ti == t) return now;
    auto s = smp("scale", ti);
    if (!s) s = smp(k, ti);
    if (!s) return now;
    if (parent3d) return *s;
    auto s0 = smp("scale", t);
    if (!s0) s0 = smp(k, t);
    return !s0 || *s0 == 0 ? now : now * (*s / *s0);
  };
  const auto ownProp = [smp, t](std::string_view k, double now, double ti) { return ti == t ? now : smp(k, ti).value_or(now); };
  const double z0 = num("z").value_or(transform_num(group, "z"));
  const double rX0 = num("rotationX").value_or(transform_num(group, "rotationX"));
  const double rY0 = num("rotationY").value_or(transform_num(group, "rotationY"));
  const double oX0 = num("orientationX").value_or(transform_num(group, "orientationX"));
  const double oY0 = num("orientationY").value_or(transform_num(group, "orientationY"));
  const double oZ0 = num("orientationZ").value_or(transform_num(group, "orientationZ"));
  const double sZ0 = num("scaleZ").value_or(scaleZProp.is_number() ? scaleZProp.num() : 1);
  const double aZ0 = num("anchorZ").value_or(transform_num(group, "anchorZ"));
  const double x0 = parent3d ? num("x").value_or(baseX) : gWorld.x;
  const double y0 = parent3d ? num("y").value_or(baseY) : gWorld.y;
  const double r0 = parent3d ? num("rotation").value_or(baseRot) : gWorld.rotation;
  const double sx0 = parent3d ? (num("scaleX") ? *num("scaleX") : num("scale").value_or(baseScaleX)) : gWorld.scale_x;
  const double sy0 = parent3d ? (num("scaleY") ? *num("scaleY") : num("scale").value_or(baseScaleY)) : gWorld.scale_y;
  const auto poseAt = [=](double ti) {
    const xf::Mat4 L = xf::compose(xf::Parts3D{
        .position = {worldProp("x", x0, ti), worldProp("y", y0, ti), ownProp("z", z0, ti)},
        .rotation = {(ownProp("rotationX", rX0, ti) + ownProp("orientationX", oX0, ti)) * kDeg,
                     (ownProp("rotationY", rY0, ti) + ownProp("orientationY", oY0, ti)) * kDeg,
                     (worldProp("rotation", r0, ti) + ownProp("orientationZ", oZ0, ti)) * kDeg},
        .scale = {worldScale("scaleX", sx0, ti), worldScale("scaleY", sy0, ti), ownProp("scaleZ", sZ0, ti)},
        .anchor = {0, 0, ownProp("anchorZ", aZ0, ti)},
    });
    return parent3d ? xf::multiply(*parent3d, L) : L;
  };
  // cardFrom: the anchor-relative corners, projected; null when any is clipped.
  const auto cardFrom = [refW, refH, anchorX, anchorY](const xf::Mat4& M,
                                                       const std::function<xf::Projected(xf::Vec3)>& proj) -> std::optional<Card> {
    const auto at = [&](double x, double y) { return proj(xf::transform_point(M, {x, y, 0})); };
    const double left = -refW / 2 - anchorX;
    const double right = refW / 2 - anchorX;
    const double top = -refH / 2 - anchorY;
    const double bottom = refH / 2 - anchorY;
    const xf::Projected O = at(0, 0);
    const std::array<xf::Projected, 4> pts = {at(left, top), at(right, top), at(right, bottom), at(left, bottom)};
    if (O.clipped || std::ranges::any_of(pts, [](const xf::Projected& p) { return p.clipped; })) return std::nullopt;
    const xf::Projected X = at(1, 0);
    const xf::Projected Y = at(0, 1);
    Card c;
    c.quad = {pts[0].x, pts[0].y, pts[1].x, pts[1].y, pts[2].x, pts[2].y, pts[3].x, pts[3].y};
    c.matrix = {X.x - O.x, X.y - O.y, Y.x - O.x, Y.y - O.y, O.x, O.y};
    c.x = O.x;
    c.y = O.y;
    c.depth = O.depth;
    return c;
  };
  const xf::Mat4 M = poseAt(t);
  const std::function<xf::Projected(xf::Vec3)> still = [this](xf::Vec3 p) { return project(p); };
  plan.still = cardFrom(M, still);
  plan.at = [this, poseAt, cardFrom](double ti, double tcomp) {
    std::function<xf::Projected(xf::Vec3)> proj = [this](xf::Vec3 p) { return project(p); };
    if (cameraAnimated_ && viewCam_ != nullptr) {  // projectAtTime(tc)
      auto it = subFrameCameras_.find(tcomp);
      if (it == subFrameCameras_.end()) {
        const std::string camId = h_.anim_id3d(viewCam_->id);
        const xf::Camera cam = camera_from_node(*viewCam_, [this, camId, tcomp](std::string_view k) {
          return doc::anim_sample(c_.d, c_.expr, c_.cache, camId, k, tcomp);
        });
        it = subFrameCameras_.emplace(tcomp, cam).first;
      }
      const xf::Camera fixed = it->second;
      proj = [fixed](xf::Vec3 p) { return xf::project_point(p, fixed); };
    }
    return cardFrom(poseAt(ti), proj);
  };
  // Accepts Lights: the plane normal from the card's world matrix, the gain as a tint.
  if (plan.still && !sceneLights_.empty()) {
    const Material mat = material_of(group, gv);
    if (mat.acceptsLights) {
      const xf::Vec3 wp = xf::transform_point(M, {0, 0, 0});
      if (const auto lit = shade_layer(plane_normal_of(arr16(M)), {wp.x, wp.y, wp.z}, sceneLights_, mat.ambient, mat.diffuse)) {
        plan.lighting = *lit;
      }
    }
  }
  return plan;
}

}  // namespace premation::scene
