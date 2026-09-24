#include "threed_port.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <numbers>
#include <utility>

#include "anim.hpp"
#include "env_light.hpp"
#include "extrusion_mesh.hpp"
#include "fxstate.hpp"
#include "layer_styles.hpp"
#include "primitive_mesh.hpp"
#include "text_measure.hpp"
#include "jsmath.hpp"
#include "scene.hpp"
#include "scene_math.hpp"
#include "timeline.hpp"
#include "worldxf.hpp"

namespace premation::scene {

namespace xf = motion::xf;
using js::Json;

namespace {

/// buildSnapshot CAMERA_MOTION_PROPS.
constexpr std::array<std::string_view, 12> kCameraMotionProps = {
    "x", "y", "z", "focalLength", "orbitYaw", "orbitPitch", "poiX", "poiY", "poiZ",
    "orientationX", "orientationY", "orientationZ"};

double hypot3(double a, double b, double c) {
  const std::array<double, 3> v{a, b, c};
  return motion::js::hypot(v);
}

std::optional<xf::OrthoView> ortho_view_of(const std::string& mode) {
  if (mode == "front") return xf::OrthoView::kFront;
  if (mode == "back") return xf::OrthoView::kBack;
  if (mode == "left") return xf::OrthoView::kLeft;
  if (mode == "right") return xf::OrthoView::kRight;
  if (mode == "top") return xf::OrthoView::kTop;
  if (mode == "bottom") return xf::OrthoView::kBottom;
  return std::nullopt;
}

/// threeD.ts `readNode3D`: the (first) Transform's number, else 0.
double t3(const doc::Node& n, std::string_view k) {
  const doc::Component* t = n.comp("Transform");
  if (t == nullptr) return 0;
  const Json& v = t->props.at(k);
  return v.is_number() ? v.num() : 0;
}

/// autoOrient.ts `isAutoOrientedToCamera`.
bool auto_oriented_to_camera(const doc::Node& n) {
  const Json& v = fx_props(n).at("autoOrient");
  return v.is_string() && v.str() == "camera";
}

std::array<double, 16> to_arr(const xf::Mat4& m) {
  std::array<double, 16> a{};
  std::copy(m.begin(), m.end(), a.begin());
  return a;
}

/// buildSnapshot `shadowTint(fill, transmission)`.
std::string shadow_tint(const std::optional<std::string>& fill, double transmission) {
  if (transmission <= 0) return "#000000";
  if (!fill) return "#000000";
  std::string_view f = *fill;
  if (!f.empty() && f.front() == '#') f.remove_prefix(1);
  if (f.size() != 6 || !std::ranges::all_of(f, [](char ch) { return std::isxdigit(static_cast<unsigned char>(ch)) != 0; })) {
    return "#000000";
  }
  const auto n = static_cast<std::uint32_t>(std::stoul(std::string(f), nullptr, 16));
  const auto ch = [&](unsigned shift) {
    const double v = motion::js::round(static_cast<double>((n >> shift) & 0xFFU) * std::min(1.0, transmission));
    static constexpr char kHex[] = "0123456789abcdef";
    const auto iv = static_cast<unsigned>(v);
    std::string s;
    s.push_back(kHex[(iv >> 4U) & 0xFU]);
    s.push_back(kHex[iv & 0xFU]);
    return s;
  };
  return "#" + ch(16) + ch(8) + ch(0);
}

api::RenderDof dof_wire(const DofConfig& d) {
  api::RenderDof o;
  o.strength = d.strength;
  o.focus = d.focus;
  o.aperture = d.aperture;
  o.focal_length = d.focalLength;
  o.f_stop = d.fStop;
  o.iris_blades = d.irisBlades;
  o.iris_roundness = d.irisRoundness;
  o.highlight_gain = d.highlightGain;
  o.iris_rotation = d.irisRotation;
  o.iris_aspect = d.irisAspect;
  o.highlight_threshold = d.highlightThreshold;
  o.highlight_saturation = d.highlightSaturation;
  o.diffraction_fringe = d.diffractionFringe;
  return o;
}

std::vector<double> mat_vec(const xf::Mat4& m) { return {m.begin(), m.end()}; }

bool has_world3d(const std::vector<RLayer>& ls) {
  return std::ranges::any_of(ls, [](const RLayer& l) { return l.world3d.has_value() || (l.precompLayers && has_world3d(*l.precompLayers)); });
}

}  // namespace

Scene3D::Scene3D(Scene3DHost& host, const BuildContext& c, const SnapshotComp& comp, double t,
                 const std::optional<MotionBlurCfg>& motionBlur)
    : h_(host), c_(c), comp_(comp), t_(t), mb_(motionBlur) {}

xf::Projected Scene3D::project(xf::Vec3 p) const {
  if (ortho_) return xf::project_ortho(p, *ortho_, comp_.width, comp_.height);
  return xf::project_point(p, *camera_);
}

std::optional<xf::Node3DTransform> Scene3D::local3d(const std::string& id) {
  // buildSnapshot `local3DOf` → nodeMatrix.ts `resolveNode3DTransform(n, remapOf(id)(t))`.
  const doc::Node* n = h_.node3d(id);
  if (n == nullptr) return std::nullopt;
  const auto g = doc::read_geometry_local(*n);
  if (!g) return std::nullopt;
  const double kt = doc::comp_to_keyframe_time(c_.d, c_.view, id, h_.remap3d(id, t_));
  const Values av(doc::anim_evaluate_node(c_.d, c_.expr, c_.cache, id, kt));
  const auto [ax, ay] = read_node_anchor(*n);
  xf::Node3DTransform v;
  v.x = av.get("x").value_or(g->x);
  v.y = av.get("y").value_or(g->y);
  v.z = av.get("z").value_or(t3(*n, "z"));
  v.rotation_x = av.get("rotationX").value_or(t3(*n, "rotationX"));
  v.rotation_y = av.get("rotationY").value_or(t3(*n, "rotationY"));
  v.rotation_z = av.get("rotation").value_or(g->rotation);
  v.orientation_x = av.get("orientationX").value_or(t3(*n, "orientationX"));
  v.orientation_y = av.get("orientationY").value_or(t3(*n, "orientationY"));
  v.orientation_z = av.get("orientationZ").value_or(t3(*n, "orientationZ"));
  v.scale_x = av.get("scaleX") ? *av.get("scaleX") : av.get("scale").value_or(g->scale_x);
  v.scale_y = av.get("scaleY") ? *av.get("scaleY") : av.get("scale").value_or(g->scale_y);
  v.scale_z = av.get("scaleZ").value_or(1);
  v.anchor_x = av.get("anchorX").value_or(ax);
  v.anchor_y = av.get("anchorY").value_or(ay);
  v.anchor_z = av.get("anchorZ").value_or(t3(*n, "anchorZ"));
  return v;
}

std::optional<xf::Mat4> Scene3D::parent_world_3d(const std::string& id) {
  // nodeMatrix.ts `parentWorld3d(id, resolvers, cache)`.
  const auto parentId = h_.parent3d_of(id);
  if (!parentId) return std::nullopt;
  if (const auto it = parent3dCache_.find(*parentId); it != parent3dCache_.end()) return it->second;
  const auto is3dOf = [this](const std::string& nid) {
    const doc::Node* n = h_.node3d(nid);
    return n != nullptr && doc::is_3d_enabled(*n);
  };
  std::vector<std::string> seen{id};
  std::vector<std::string> chain;
  bool any3d = false;
  for (std::optional<std::string> cur = parentId; cur && std::ranges::find(seen, *cur) == seen.end(); cur = h_.parent3d_of(*cur)) {
    seen.push_back(*cur);
    chain.push_back(*cur);
    if (is3dOf(*cur)) any3d = true;
  }
  if (!any3d) {
    parent3dCache_.emplace(*parentId, std::nullopt);
    return std::nullopt;
  }
  std::optional<xf::Mat4> acc;
  for (std::size_t i = chain.size(); i-- > 0;) {
    const std::string& cid = chain[i];
    if (!is3dOf(cid)) {
      acc = xf::from_mat2d(xf::local_matrix(h_.world2d(cid)));
      continue;
    }
    const auto local = local3d(cid);
    if (!local) continue;
    const xf::Mat4 own = xf::compose_node_3d(*local);
    acc = acc ? xf::multiply(*acc, own) : own;
  }
  parent3dCache_.emplace(*parentId, acc);
  return acc;
}

std::optional<xf::Mat4> Scene3D::parent_world_matrix(const std::string& id) {
  // buildSnapshot `parentWorldMatrixOf`.
  const auto parentId = h_.parent3d_of(id);
  if (!parentId) return std::nullopt;
  if (auto p3 = parent_world_3d(id)) return p3;
  return xf::from_mat2d(xf::local_matrix(h_.world2d(*parentId)));
}

xf::Vec3 Scene3D::to_world_point(const std::string& id, xf::Vec3 p) {
  const auto m = parent_world_matrix(id);
  return m ? xf::transform_point(*m, p) : p;
}

xf::Vec3 Scene3D::node_world_position(const doc::Node& n) {
  const Values& av = h_.values3d(n.id);
  const auto g = doc::read_geometry_local(n);
  return to_world_point(n.id, {av.get("x").value_or(g ? g->x : 0), av.get("y").value_or(g ? g->y : 0),
                               av.get("z").value_or(t3(n, "z"))});
}

double Scene3D::node_light_aim_deg(const doc::Node& n, const LightProps& lt) {
  const double base = h_.values3d(n.id).get("lightAngle").value_or(lt.angle);
  return base + h_.world2d(n.id).rotation;
}

const doc::Node* Scene3D::view_camera_node(const std::vector<const doc::Node*>& nodes) {
  // camera3d.ts `viewCameraNode(graph, mode, rootId, {isLiveAt})`.
  const std::string& mode = comp_.camera3dMode;
  constexpr std::string_view kPrefix = "camera:";
  if (mode.size() > kPrefix.size() && mode.starts_with(kPrefix)) {
    const std::string id = mode.substr(kPrefix.size());
    for (const doc::Node* n : nodes) {
      if (n->id != id) continue;
      if (n->kind() == "camera" && n->visible) return n;
      break;
    }
  }
  for (std::size_t i = nodes.size(); i-- > 0;) {
    const doc::Node* n = nodes[i];
    if (n->kind() != "camera" || !n->visible) continue;
    if (!h_.live3d(n->id)) continue;
    return n;
  }
  return nullptr;
}

xf::Camera Scene3D::camera_from_node(const doc::Node& n, const std::function<std::optional<double>(std::string_view)>& sample) {
  // camera3d.ts `cameraFromNode(node, w, h, sample, toWorldPoint)`.
  xf::CameraProps p;
  std::optional<double> roll;
  std::optional<double> oriX;
  std::optional<double> oriY;
  for (const doc::Component& c : n.components) {
    const Json& q = c.props;
    const auto num = [&q](const char* k, std::optional<double>& into) {
      if (q.at(k).is_number()) into = q.at(k).num();
    };
    num("orientationZ", roll);
    num("orientationX", oriX);
    num("orientationY", oriY);
    num("x", p.x);
    num("y", p.y);
    num("z", p.z);
    num("focalLength", p.focal_length);
    num("orbitYaw", p.orbit_yaw);
    num("orbitPitch", p.orbit_pitch);
    num("poiX", p.poi_x);
    num("poiY", p.poi_y);
    num("poiZ", p.poi_z);
  }
  const auto s = [&sample](std::string_view k, std::optional<double>& into) {
    if (const auto v = sample(k)) into = v;
  };
  s("x", p.x);
  s("y", p.y);
  s("z", p.z);
  s("focalLength", p.focal_length);
  s("orbitYaw", p.orbit_yaw);
  s("orbitPitch", p.orbit_pitch);
  s("poiX", p.poi_x);
  s("poiY", p.poi_y);
  s("poiZ", p.poi_z);
  s("orientationZ", roll);
  s("orientationX", oriX);
  s("orientationY", oriY);
  p.orientation_z = roll;
  p.orientation_x = oriX;
  p.orientation_y = oriY;
  const std::string id = n.id;
  return xf::camera_from_props(p, comp_.width, comp_.height, [this, id](xf::Vec3 v) { return to_world_point(id, v); });
}

void Scene3D::setup(const std::vector<const doc::Node*>& nodes) {
  ortho_ = ortho_view_of(comp_.camera3dMode);
  const bool custom = !ortho_ && comp_.customViewCamera.has_value();
  viewCam_ = ortho_ ? nullptr : view_camera_node(nodes);
  if (!ortho_) {
    if (custom) {
      camera_ = *comp_.customViewCamera;
    } else if (viewCam_ != nullptr) {
      const std::string id = viewCam_->id;
      camera_ = camera_from_node(*viewCam_, [this, id](std::string_view k) { return h_.values3d(id).get(k); });
    } else {
      camera_ = xf::default_camera(comp_.width, comp_.height);
    }
  }
  // Camera motion blur: an animated active camera blurs every 3D layer.
  if (!ortho_ && !custom && mb_ && viewCam_ != nullptr) {
    cameraAnimated_ = std::ranges::any_of(kCameraMotionProps, [&](std::string_view p) { return doc::anim_is_animated(c_.d, viewCam_->id, p); });
  }
  // Depth of field (off in ortho / custom views and Draft 3D).
  if (!(ortho_ || custom || comp_.draft3d) && viewCam_ != nullptr) {
    const std::string id = viewCam_->id;
    dof_ = read_node_dof(*viewCam_, comp_.width, comp_.height, [this, id](std::string_view k) { return h_.values3d(id).get(k); });
  }

  // Cast-shadow lights (projected copies; the first two mapped lights take maps instead).
  if (!comp_.draft3d) {
    int mapped = 0;
    for (const doc::Node* n : nodes) {
      if (n->kind() != "light") continue;
      if (!n->visible || !h_.live3d(n->id)) continue;
      const LightProps lt = read_node_light(*n);
      if (!lt.shadows || lt.type == "ambient" || lt.type == "environment") continue;
      if (lt.shadowMap && mapped < 2) {
        ++mapped;
        hasShadowMapLight_ = true;
        continue;
      }
      const Values& av = h_.values3d(n->id);
      const xf::Vec3 wp = node_world_position(*n);
      ShadowLight sl;
      sl.x = wp.x;
      sl.y = wp.y;
      sl.z = wp.z;
      sl.intensity = av.get("intensity").value_or(lt.intensity);
      sl.darkness = av.get("shadowDarkness").value_or(lt.shadowDarkness) / 100;
      sl.diffusion = av.get("shadowDiffusion").value_or(lt.shadowDiffusion);
      shadowLights_.push_back(sl);
    }
  }

  // The form rig (extruded solids in a comp with no lights).
  if (!comp_.draft3d) {
    const double cx = comp_.width / 2;
    const double cy = comp_.height / 2;
    constexpr double kFar = 100000;
    SceneLight base;
    base.color = "#ffffff";
    base.radius = 500;
    base.angle = 0;
    base.cone = 45;
    base.shadows = false;
    base.shadowMap = false;
    base.falloff = "none";
    const auto parallel = [&](double fx, double fy, double fz, double intensity) {
      double l = hypot3(fx, fy, fz);
      if (l == 0 || std::isnan(l)) l = 1;
      SceneLight s = base;
      s.type = "parallel";
      s.intensity = intensity;
      s.x = cx - (fx / l) * kFar;
      s.y = cy - (fy / l) * kFar;
      s.z = 0 - (fz / l) * kFar;
      s.poi = std::array<double, 3>{cx, cy, 0};
      return s;
    };
    SceneLight amb = base;
    amb.type = "ambient";
    amb.intensity = 30;
    amb.x = cx;
    amb.y = cy;
    amb.z = 0;
    formRig_.push_back(amb);
    formRig_.push_back(parallel(0.45, 0.62, 0.64, 64));
    formRig_.push_back(parallel(-0.8, 0.05, 0.4, 14));
  }

  // Scene lights in world space.
  if (!comp_.draft3d) {
    for (const doc::Node* n : nodes) {
      if (n->kind() != "light") continue;
      if (!n->visible || !h_.live3d(n->id)) continue;
      const LightProps lt = read_node_light(*n);
      const Values& av = h_.values3d(n->id);
      const xf::Vec3 wp = node_world_position(*n);
      if (lt.type == "environment") {
        // The SH probe expanded into its derived rig (env_light.cpp): one ambient
        // floor + up to six axis parallels, riding the ordinary light array.
        const double envRot = av.get("envRotation").value_or(lt.envRotation);
        const double envIntensity = av.get("intensity").value_or(lt.intensity);
        const double cx = comp_.width / 2;
        const double cy = comp_.height / 2;
        const double envRefl = av.get("envReflections").value_or(lt.envReflections) / 100;
        EnvReflect er;
        er.sky = lt.envPreset;
        er.intensity = std::max(0.0, (envIntensity / 100) * envRefl);
        er.rotationDeg = envRot;
        er.nodeId = n->id;
        envReflect_ = std::move(er);
        const std::string sky = lt.envPreset.is_string() ? lt.envPreset.str() : "studio";
        const auto rig = environment_rig_for(sky, envIntensity, envRot);
        if (!rig) {
          unported_.emplace_back(n->id, "environment light from an image (asset:) sky");
          continue;
        }
        for (const EnvRigLight& rl : *rig) {
          SceneLight s = scene_light_of(lt);
          s.color = rl.color;
          s.intensity = rl.intensity;
          s.shadows = false;
          s.shadowMap = false;
          s.falloff = "none";
          if (rl.ambient) {
            s.type = "ambient";
            s.poi = std::nullopt;
            s.x = cx;
            s.y = cy;
            s.z = 0;
          } else {
            constexpr double kFar = 100000;
            s.type = "parallel";
            s.x = cx - rl.from[0] * kFar;
            s.y = cy - rl.from[1] * kFar;
            s.z = 0 - rl.from[2] * kFar;
            s.poi = std::array<double, 3>{cx, cy, 0};
          }
          sceneLights_.push_back(std::move(s));
        }
        continue;
      }
      SceneLight r = scene_light_of(lt);
      r.intensity = av.get("intensity").value_or(lt.intensity);
      r.radius = av.get("radius").value_or(lt.radius);
      r.angle = node_light_aim_deg(*n, lt);
      r.cone = av.get("lightCone").value_or(lt.cone);
      r.coneFeather = av.get("lightConeFeather").value_or(lt.coneFeather);
      r.falloffDistance = av.get("falloffDistance").value_or(lt.falloffDistance);
      r.shadowDarkness = av.get("shadowDarkness").value_or(lt.shadowDarkness);
      r.shadowBias = av.get("shadowBias").value_or(lt.shadowBias);
      r.shadowSoftness = av.get("shadowSoftness").value_or(lt.shadowSoftness);
      {
        const std::optional<double> px = av.get("poiX") ? av.get("poiX") : lt.poi ? std::optional<double>((*lt.poi)[0]) : std::nullopt;
        const std::optional<double> py = av.get("poiY") ? av.get("poiY") : lt.poi ? std::optional<double>((*lt.poi)[1]) : std::nullopt;
        const std::optional<double> pz = av.get("poiZ") ? av.get("poiZ") : lt.poi ? std::optional<double>((*lt.poi)[2]) : std::nullopt;
        if (!px && !py && !pz) {
          r.poi = std::nullopt;
        } else {
          const xf::Vec3 w = to_world_point(n->id, {px.value_or(0), py.value_or(0), pz.value_or(0)});
          r.poi = std::array<double, 3>{w.x, w.y, w.z};
        }
      }
      r.x = wp.x;
      r.y = wp.y;
      r.z = wp.z;
      if (const auto aim3 = light_aim_3d(r)) {
        if (const auto deg = aim_to_comp_angle_deg(*aim3)) r.angle = *deg;
      }
      sceneLightById_[n->id] = sceneLights_.size();
      sceneLights_.push_back(std::move(r));
    }
  }
}

Scene3D::Affine Scene3D::affine_at(const Layer3D& s, double wx, double wy, double wz, double rX, double rY, double rZ,
                                   double sX, double sY, double sZ,
                                   const std::function<xf::Projected(xf::Vec3)>* proj) const {
  const xf::Mat4 L = xf::compose(xf::Parts3D{
      .position = {wx, wy, wz},
      .rotation = {(rX + s.oriX) * kDeg, (rY + s.oriY) * kDeg, (rZ + s.oriZ) * kDeg},
      .scale = {sX, sY, sZ},
      .anchor = {0, 0, s.anchorZ},
  });
  const xf::Mat4 M = s.parent3d ? xf::multiply(*s.parent3d, L) : L;
  const auto P = [&](xf::Vec3 v) { return proj != nullptr ? (*proj)(v) : project(v); };
  Affine a;
  a.O = P(xf::transform_point(M, {0, 0, 0}));
  const xf::Projected X = P(xf::transform_point(M, {1, 0, 0}));
  const xf::Projected Y = P(xf::transform_point(M, {0, 1, 0}));
  a.matrix = {X.x - a.O.x, X.y - a.O.y, Y.x - a.O.x, Y.y - a.O.y, a.O.x, a.O.y};
  a.world = M;
  return a;
}

Material Scene3D::material_of(const doc::Node& n, const Values& a) const {
  return read_node_material(n, [&a](std::string_view k) { return a.get(k); });
}

std::vector<std::string> Scene3D::unported_features(const doc::Node& n, const Values& /*a*/) const {
  // Mesh bodies (extrusions, primitives, models) report from finish_layer, where
  // the TypeScript decides between them; per-character planes replace the quad.
  std::vector<std::string> out;
  const doc::Component* t = n.comp("Transform");
  if (n.kind() == "text" && t != nullptr && t->props.at("perChar3D").is_bool() && t->props.at("perChar3D").b()) {
    out.emplace_back("per-character 3D text");
  }
  return out;
}

bool Scene3D::place(const doc::Node& n, const Values& a, double baseX, double baseY, double baseRot, double baseScaleX,
                    double baseScaleY, const xf::Local2D& world, Layer3D& s, double& px, double& py, double& sx,
                    double& sy, double& rot, RLayer& l) {
  s.is3d = true;
  s.worldX = world.x;
  s.worldY = world.y;
  s.z3 = a.get("z").value_or(t3(n, "z"));
  s.rotX = a.get("rotationX").value_or(t3(n, "rotationX"));
  s.rotY = a.get("rotationY").value_or(t3(n, "rotationY"));
  s.oriX = a.get("orientationX").value_or(t3(n, "orientationX"));
  s.oriY = a.get("orientationY").value_or(t3(n, "orientationY"));
  s.oriZ = a.get("orientationZ").value_or(t3(n, "orientationZ"));
  s.anchorZ = a.get("anchorZ").value_or(t3(n, "anchorZ"));
  s.extrusionDepth = std::max(0.0, a.get("extrusionDepth").value_or(std::max(0.0, t3(n, "extrusionDepth"))));
  {
    const doc::Component* tc = n.comp("Transform");
    const Json& sz = tc != nullptr ? tc->props.at("scaleZ") : Json();
    s.scaleZ = a.get("scaleZ").value_or(sz.is_number() ? sz.num() : 1);
  }
  s.parent3d = parent_world_3d(n.id);
  s.ownX = s.parent3d ? a.get("x").value_or(baseX) : world.x;
  s.ownY = s.parent3d ? a.get("y").value_or(baseY) : world.y;
  s.ownRot = s.parent3d ? a.get("rotation").value_or(baseRot) : world.rotation;
  s.ownScaleX = s.parent3d ? (a.get("scaleX") ? *a.get("scaleX") : a.get("scale").value_or(baseScaleX)) : world.scale_x;
  s.ownScaleY = s.parent3d ? (a.get("scaleY") ? *a.get("scaleY") : a.get("scale").value_or(baseScaleY)) : world.scale_y;
  s.depth = project({world.x, world.y, s.z3}).depth;
  s.faceRotX = s.rotX;
  s.faceRotY = s.rotY;
  if (camera_ && auto_oriented_to_camera(n)) {
    const xf::Orientation look = xf::look_at_orientation({world.x, world.y, s.z3}, camera_->position);
    s.faceRotX = look.pitch - s.oriX;
    s.faceRotY = look.yaw - s.oriY;
  }
  const Affine af = affine_at(s, s.ownX, s.ownY, s.z3, s.faceRotX, s.faceRotY, s.ownRot, s.ownScaleX, s.ownScaleY, s.scaleZ);
  if (af.O.clipped) return false;
  const auto& m = af.matrix;
  l.matrix = m;
  l.world3d = to_arr(af.world);
  s.world3d = af.world;
  px = af.O.x;
  py = af.O.y;
  sx = hypot2(m[0], m[1]);
  sy = hypot2(m[2], m[3]);
  rot = motion::js::atan2(m[1], m[0]) / kDeg;
  s.depth = af.O.depth;
  l.depth = s.depth;
  return true;
}

void Scene3D::shade(const Layer3D& s, RLayer& l) {
  if (!(s.is3d && s.world3d && !sceneLights_.empty())) return;
  const Material& mat = s.mat;
  if (!mat.acceptsLights) return;
  const auto lit = shade_layer(plane_normal_of(to_arr(*s.world3d)), {s.worldX, s.worldY, s.z3}, sceneLights_, mat.ambient, mat.diffuse);
  if (lit) l.lighting = *lit;
  api::RenderShade3D sh;
  sh.specular = mat.specular / 100;
  sh.shininess = mat.shininess;
  if (mat.metal > 0) sh.metal = mat.metal / 100;
  if (mat.shading == "pbr") sh.roughness = mat.roughness / 100;
  if (mat.shading == "toon") sh.toon_bands = mat.toonBands;
  sh.ambient = mat.ambient;
  sh.diffuse = mat.diffuse;
  if (mat.reflectionIntensity != 100) sh.reflection_intensity = mat.reflectionIntensity / 100;
  if (mat.reflectionSharpness > 0) sh.reflection_sharpness = mat.reflectionSharpness / 100;
  if (mat.reflectionRolloff > 0) sh.reflection_rolloff = mat.reflectionRolloff / 100;
  if (mat.transparency > 0) sh.transparency = mat.transparency / 100;
  if (mat.transparencyRolloff > 0) sh.transparency_rolloff = mat.transparencyRolloff / 100;
  if (mat.ior != 1.52) sh.ior = mat.ior;
  l.shade3d = std::move(sh);
}

std::function<std::array<double, 6>(double, double)> Scene3D::matrix_at(const doc::Node& n, const Values& a, double baseX,
                                                                         double baseY, double baseRot, const Layer3D& s) {
  if (!s.is3d) return {};
  const double localX = a.get("x").value_or(baseX);
  const double localY = a.get("y").value_or(baseY);
  const double localRot = a.get("rotation").value_or(baseRot);
  const std::string id = n.id;
  return [this, id, localX, localY, localRot, s](double ti, double tc) {
    const auto sample = [&](std::string_view p, double tt) { return doc::anim_sample(c_.d, c_.expr, c_.cache, id, p, tt); };
    const auto sc = sample("scale", ti);
    const double rX = s.faceRotX != s.rotX ? s.faceRotX : sample("rotationX", ti).value_or(s.rotX);
    const double rY = s.faceRotY != s.rotY ? s.faceRotY : sample("rotationY", ti).value_or(s.rotY);
    const double sX = sc ? *sc : sample("scaleX", ti).value_or(s.ownScaleX);
    const double sY = sc ? *sc : sample("scaleY", ti).value_or(s.ownScaleY);
    std::function<xf::Projected(xf::Vec3)> proj;
    if (cameraAnimated_ && viewCam_ != nullptr) {
      auto it = subFrameCameras_.find(tc);
      if (it == subFrameCameras_.end()) {
        const std::string camId = viewCam_->id;
        const xf::Camera cam = camera_from_node(*viewCam_, [this, camId, tc](std::string_view k) {
          return doc::anim_sample(c_.d, c_.expr, c_.cache, camId, k, tc);
        });
        it = subFrameCameras_.emplace(tc, cam).first;
      }
      const xf::Camera fixed = it->second;
      proj = [fixed](xf::Vec3 p) { return xf::project_point(p, fixed); };
    }
    return affine_at(s, s.ownX + (sample("x", ti).value_or(localX) - localX), s.ownY + (sample("y", ti).value_or(localY) - localY),
                     sample("z", ti).value_or(s.z3), rX, rY, s.ownRot + (sample("rotation", ti).value_or(localRot) - localRot), sX, sY,
                     s.scaleZ, proj ? &proj : nullptr)
        .matrix;
  };
}

void Scene3D::effects(const Layer3D& s, bool isSolid, double px, double py, RLayer& l) {
  std::vector<Json> gpuFx;
  if (s.is3d && dof_) {
    Json e = dof_effect(s.depth, *dof_);
    if (!e.is_undefined()) gpuFx.push_back(std::move(e));
  }
  const Material& mat = s.mat;
  if (mat.castsShadows && (s.is3d || !isSolid)) {
    if (s.is3d && (!shadowLights_.empty() || hasShadowMapLight_)) {
      Caster c;
      c.layerId = l.id;
      c.z = s.z3;
      c.transmission = mat.lightTransmission / 100;
      c.world3d = s.world3d.value_or(xf::kIdentity4);
      shadowCasters_.push_back(std::move(c));
    } else if (!shadowLights_.empty()) {
      // shadowEffectOf(px, py).
      const ShadowLight& L = shadowLights_.front();
      double dx = px - L.x;
      double dy = py - L.y;
      const double len = hypot2(dx, dy);
      if (len < 1) {
        dx = 0;
        dy = 1;
      } else {
        dx /= len;
        dy /= len;
      }
      const double strength = std::max(0.0, std::min(1.0, (L.intensity / 100) * L.darkness));
      if (strength > 0) {
        const double angle = std::fmod(((motion::js::atan2(dy, dx) * 180) / std::numbers::pi + 360), 360.0);
        Json p = Json::object();
        p.set("distance", Json::number(fixed_num(6 + 10 * strength, 1)));
        p.set("angle", Json::number(fixed_num(angle, 1)));
        p.set("softness", Json::number(fixed_num(6 + 8 * strength + L.diffusion, 0)));
        p.set("color", Json::string("#000000"));
        p.set("opacity", Json::number(fixed_num(45 * strength, 1)));
        Json e = Json::object();
        e.set("id", Json::string("cast-shadow"));
        e.set("type", Json::string("drop-shadow"));
        e.set("params", std::move(p));
        gpuFx.push_back(std::move(e));
      }
    }
  }
  if (s.is3d && mat.acceptsShadows) shadowReceivers_.push_back({s.z3, s.depth, l.id});
  if (s.is3d) {
    if (mat.castsShadows) l.castsShadow3d = true;
    if (!mat.acceptsShadows) l.acceptsShadows3d = false;
  }
  if (s.is3d && mat.acceptsLights) lightReceivers_.push_back({s.z3, s.depth, l.id});
  if (mat.shadowOnly) l.visible = false;
  for (Json& e : gpuFx) l.effects.push_back(std::move(e));
  // The caster's final state (its shadow is a copy of it, minus compositing).
  for (Caster& c : shadowCasters_) {
    if (c.layerId == l.id && !c.layer) c.layer = std::make_shared<RLayer>(l);
  }
}

void Scene3D::before_emit(const Layer3D& s, RLayer& l) {
  if (!(s.is3d && dof_ && l.matrix && l.world3d && s.extrusionDepth <= 0 && !l.deformedMesh)) return;
  xf::Mat4 w{};
  std::copy(l.world3d->begin(), l.world3d->end(), w.begin());
  const auto corners = layer_corner_depths(w, l.width, l.height, [this](xf::Vec3 p) { return project(p); });
  const auto planar = corners ? plan_dof_coc_corners(*corners, *dof_) : std::nullopt;
  if (!planar) return;
  std::erase_if(l.effects, [](const Json& e) { return e.at("id").is_string() && e.at("id").str() == "dof"; });
  l.effects.push_back(planar_dof_effect(*planar, *dof_));
  // `emitLayer({...layer, effects})` emits a COPY: the shadow splice below can no
  // longer find the caster / receiver object in the stack.
  copiedOnEmit_.push_back(l.id);
}

namespace {

/// colorLut.ts LUT_BUILDERS / effectColorMatrix.ts COLOR_MATRIX_BUILDERS.
bool is_lut_type(std::string_view t) {
  static constexpr std::array<std::string_view, 10> k = {"levels", "curves", "posterize", "exposure", "lumetri",
                                                         "color-balance", "gamma-pedestal-gain", "color-offset",
                                                         "threshold-rgb", "cineon-converter"};
  return std::ranges::find(k, t) != k.end();
}
bool is_color_type(std::string_view t) {
  static constexpr std::array<std::string_view, 10> k = {"brightness", "contrast", "saturate", "grayscale", "sepia",
                                                         "hue-rotate", "hue-saturation", "invert", "tint", "channel-mixer"};
  return std::ranges::find(k, t) != k.end();
}
std::string type_of(const Json& e) { return e.at("type").is_string() ? e.at("type").str() : std::string(); }
bool fx_enabled(const Json& e) { return !(e.at("enabled").is_bool() && !e.at("enabled").b()); }
bool is_dof(const Json& e) { return e.at("id").is_string() && e.at("id").str() == "dof"; }

/// faceMaterials.ts `resolveFaceMaterial(materials, kind, layerFill)`.
struct FaceMat {
  std::string fill;
  double gain = 1;
  bool explicitFill = false;  ///< `materials[kind]?.fill` is set
};
FaceMat resolve_face_material(const Json& mats, std::string_view kind, const std::string& layerFill) {
  const Json& m = mats.is_object() ? mats.at(kind) : Json();
  FaceMat out;
  const double def = kind == "back" ? 0.55 : 0.72;  // EXTRUSION_BACK_GAIN / EXTRUSION_WALL_GAIN
  out.gain = m.at("gain").is_number() ? m.at("gain").num() : def;
  out.explicitFill = m.at("fill").is_string();
  out.fill = out.explicitFill ? m.at("fill").str() : layerFill;
  return out;
}

std::string_view role_name(api::RenderMeshRole r) {
  switch (r) {
    case api::RenderMeshRole::front: return "front";
    case api::RenderMeshRole::back: return "back";
    case api::RenderMeshRole::side: return "side";
    case api::RenderMeshRole::bevel: return "bevel";
  }
  return "side";
}

/// The shade3d of a lit mesh carrier (one-sided: its faces bound a volume).
api::RenderShade3D mesh_shade(const Material& m) {
  api::RenderShade3D s;
  s.specular = m.specular / 100;
  s.shininess = m.shininess;
  s.one_sided = true;
  s.ambient = m.ambient;
  s.diffuse = m.diffuse;
  if (m.shading == "pbr") {
    s.roughness = m.roughness / 100;
    s.metal = m.metal / 100;
  }
  if (m.shading == "toon") {
    s.toon_bands = m.toonBands;
    s.metal = m.metal / 100;
  }
  return s;
}

/// The scrub every mesh carrier gets (features the mesh path cannot stage).
void scrub_carrier(RLayer& c) {
  c.matte = std::nullopt;
  c.isMatteSource = false;
  c.isAdjustment = false;
  c.motionSamples.clear();
  c.deformedMesh = std::nullopt;
  c.glass = std::nullopt;
  c.backdropBlur = std::nullopt;
  c.preserveTransparency = false;
  c.lighting = std::nullopt;
  c.shade3d = std::nullopt;
}

/// primitiveLayer.ts `readNodePrimitive(node)` → `primitiveKey(spec)`.
std::optional<std::string> primitive_key_of(const doc::Node& n) {
  const doc::Component* c = n.comp("Primitive");
  if (c == nullptr) return std::nullopt;
  const Json& p = c->props;
  const std::string type = p.at("type").is_string() ? p.at("type").str() : "";
  static constexpr std::array<std::string_view, 6> kTypes = {"sphere", "cylinder", "cone", "torus", "capsule", "box"};
  if (std::ranges::find(kTypes, type) == kTypes.end()) return std::nullopt;
  const double s = 240;
  double radius = s / 2, radiusTop = s / 2, height = s, width = s, depth = s, tube = s / 6, radial = 32, heightSeg = 16;
  if (type == "torus") {
    radial = 48;
    heightSeg = 16;
  }
  if (type == "capsule") {
    radius = s / 4;
    heightSeg = 8;
  }
  const auto clampNum = [&p](const char* k, double lo, double hi, double fb) {
    const Json& v = p.at(k);
    return v.is_number() && std::isfinite(v.num()) ? std::max(lo, std::min(hi, v.num())) : fb;
  };
  radius = clampNum("radius", 0.01, 100000, radius);
  radiusTop = clampNum("radiusTop", 0, 100000, radiusTop);
  height = clampNum("height", 0.01, 100000, height);
  width = clampNum("width", 0.01, 100000, width);
  depth = clampNum("depth", 0.01, 100000, depth);
  tube = clampNum("tube", 0.01, 100000, tube);
  radial = motion::js::round(clampNum("radialSegments", 3, 256, radial));
  heightSeg = motion::js::round(clampNum("heightSegments", 2, 256, heightSeg));
  const bool capped = !(p.at("capped").is_bool() && !p.at("capped").b());
  const auto nn = [](double v) { return js::number_to_string(motion::js::round(v * 1000) / 1000); };
  const auto ii = [](double v) { return js::number_to_string(v); };
  if (type == "sphere") return "prim:sphere:" + nn(radius) + ":" + ii(radial) + ":" + ii(heightSeg);
  if (type == "cylinder") return "prim:cyl:" + nn(radiusTop) + ":" + nn(radius) + ":" + nn(height) + ":" + ii(radial) + ":" + (capped ? "1" : "0");
  if (type == "cone") return "prim:cone:" + nn(radius) + ":" + nn(height) + ":" + ii(radial) + ":" + (capped ? "1" : "0");
  if (type == "torus") return "prim:torus:" + nn(radius) + ":" + nn(tube) + ":" + ii(heightSeg) + ":" + ii(radial);
  if (type == "capsule") return "prim:capsule:" + nn(radius) + ":" + nn(height) + ":" + ii(radial) + ":" + ii(heightSeg);
  return "prim:box:" + nn(width) + ":" + nn(height) + ":" + nn(depth);
}

}  // namespace

void Scene3D::finish_layer(const doc::Node& n, const Values& a, Layer3D& s, RLayer layer,
                           const std::function<void(RLayer)>& emit, const std::function<void(std::string)>& report) {
  if (!s.is3d || !layer.world3d) {
    emit(std::move(layer));
    return;
  }
  double frontInset = 0;
  bool frontDrawnByMesh = false;
  const std::optional<std::string> primKey = primitive_key_of(n);
  const doc::Component* tc = n.comp("Transform");
  const Json& tp = tc != nullptr ? tc->props : Json();
  const bool perCharText = layer.kind == LayerKind::text && tp.at("perChar3D").is_bool() && tp.at("perChar3D").b();
  const double layerW = layer.width;
  const double layerH = layer.height;

  // ── TRUE 3D extrusion: the mesh carrier (extrusionMesh.ts) ──
  if (s.extrusionDepth > 0 && !primKey) {
    const Material& extMat = s.mat;
    const Json faceMats = tp.at("faceMaterials").is_object() ? tp.at("faceMaterials") : Json::object();
    const bool extLit = extMat.acceptsLights && (!sceneLights_.empty() || !formRig_.empty());
    if (extLit && sceneLights_.empty()) formRigUsed_ = true;
    const Json styles = doc::get_node_layer_styles(n);
    const bool anyStyle = styles.is_object() && std::ranges::any_of(styles.obj(), [](const Json::Member& m) {
                            return m.value.is_object() && m.value.at("enabled").is_bool() && m.value.at("enabled").b();
                          });
    const std::string wallBase = layer.fill.value_or("#2a2a2a");  // EXTRUSION_WALL_FALLBACK_FILL
    std::string wallFill = wallBase;
    if (anyStyle) {
      const auto overlayOn = [&](const char* k) {
        const Json& o = styles.at(k);
        return o.is_object() && o.at("enabled").is_bool() && o.at("enabled").b() && o.at("opacity").num() > 0;
      };
      if (overlayOn("colorOverlay") || overlayOn("gradientOverlay")) report("extrusion walls under a colour / gradient overlay style");
    }
    std::vector<Json> faceStyles;
    if (anyStyle) {
      const auto compiled = layer_styles_to_effects(styles, comp_.globalLightAngle, comp_.globalLightAltitude,
                                                    [](std::string_view) { return false; });
      if (compiled) {
        static constexpr std::array<std::string_view, 5> kFace = {"layerstyle:innerShadow", "layerstyle:innerGlow",
                                                                  "layerstyle:satin", "layerstyle:bevel", "layerstyle:stroke"};
        for (const Json& e : *compiled) {
          if (e.at("id").is_string() && std::ranges::find(kFace, e.at("id").str()) != kFace.end()) faceStyles.push_back(e);
        }
      }
    }
    const double meshBevel = std::max(0.0, a.get("bevelDepth").value_or(std::max(0.0, t3(n, "bevelDepth"))));
    const bool complexOutline = layer.kind == LayerKind::text || (layer.kind == LayerKind::shape && layer.primitive == "path");
    const double holeDepthStatic = tp.at("holeBevelDepth").is_number() ? std::max(0.0, std::min(100.0, tp.at("holeBevelDepth").num())) : 100;
    const double holeBevelScale = std::max(0.0, std::min(100.0, a.get("holeBevelDepth").value_or(holeDepthStatic))) / 100;
    const bool spatialFx = std::ranges::any_of(layer.effects, [](const Json& e) {
      return fx_enabled(e) && !is_dof(e) && !is_color_type(type_of(e)) && !is_lut_type(type_of(e));
    });
    const bool meshBlockedByFx = spatialFx && !complexOutline;
    const bool meshBlockedByStyles = !faceStyles.empty() && !complexOutline;
    const bool styledFront = complexOutline && (spatialFx || !faceStyles.empty());
    const bool meshOwnsFront = complexOutline && meshBevel > 0 && !perCharText && !styledFront;
    std::vector<Json> meshEffects;
    if (styledFront) {
      for (const Json& e : layer.effects) {
        if (fx_enabled(e) && (is_dof(e) || is_color_type(type_of(e)) || is_lut_type(type_of(e)))) meshEffects.push_back(e);
      }
    } else {
      meshEffects = layer.effects;
    }
    if (perCharText) report("per-character 3D text (per-glyph extrusion)");
    std::optional<KeyedMesh> built;
    if (!(meshBlockedByFx || meshBlockedByStyles)) {
      const raster::CanvasOptions* canvas = c_.measurer != nullptr ? c_.measurer->canvas_options() : nullptr;
      if (const auto outline = extrusion_outline_for(layer, layerW, layerH, canvas)) {
        ExtrusionMeshRequest req;
        req.depth = s.extrusionDepth;
        req.bevel = meshBevel;
        req.bevelStyle = bevel_profile_of(tp.at("bevelStyle").is_string() ? tp.at("bevelStyle").str() : "angular");
        req.frontCap = meshOwnsFront;
        if (styledFront) req.frontBevel = false;
        if (complexOutline) req.holeBevelScale = holeBevelScale;
        built = extrusion_mesh_for(*outline, layerW, layerH, req);
      }
    }
    bool meshEmitted = false;
    if (built) {
      const mesh::ExtrudedMesh& mesh = *built->mesh;
      frontInset = mesh.bevel;
      const xf::Mat4 M = [&] {
        xf::Mat4 m{};
        std::copy(layer.world3d->begin(), layer.world3d->end(), m.begin());
        return m;
      }();
      const xf::Projected O = project(xf::transform_point(M, {0, 0, 0}));
      if (!O.clipped) {
        const bool isMedia = layer.kind == LayerKind::image || layer.kind == LayerKind::video;
        const bool hasFrontCap = std::ranges::any_of(mesh.ranges, [](const mesh::MeshRange& r) { return api_role(r.role) == api::RenderMeshRole::front; });
        const bool gradientFill = layer.fillPaint.is_object() && layer.fillPaint.at("type").is_string() && layer.fillPaint.at("type").str() != "solid";
        const bool wallPaint = gradientFill && wallFill == wallBase;
        auto data = std::make_shared<ExtrudedMeshData>();
        mesh_to_api(built->key, mesh, data->geometry);
        data->geometry.ranges.clear();
        for (const mesh::MeshRange& r : mesh.ranges) {
          MeshRange3D o;
          o.role = api_role(r.role);
          o.first = r.first;
          o.count = r.count;
          if (o.role == api::RenderMeshRole::front) {
            o.fill = wallFill;
            o.gain = 1;
            o.textured = true;
          } else {
            const std::string_view rn = role_name(o.role);
            const FaceMat fm = resolve_face_material(faceMats, rn, wallFill);
            o.fill = fm.fill;
            o.gain = fm.explicitFill ? 1 : fm.gain;
            const Json& back = faceMats.at("back");
            o.textured = isMedia && o.role == api::RenderMeshRole::back && !back.at("fill").is_string();
            o.paintTextured = wallPaint && !o.textured && !fm.explicitFill;
          }
          data->ranges.push_back(std::move(o));
        }
        if (wallPaint) {
          ExtrudedMeshData::Paint p;
          p.key = "paint:" + layer.id;
          p.fillPaint = layer.fillPaint;
          p.fill = wallBase;
          p.width = layerW;
          p.height = layerH;
          data->paint = std::move(p);
        }
        if (std::abs(extMat.displacement) > 1e-6 && (extMat.heightMapAssetId || extMat.heightMapSrc)) report("height-map displacement");
        const bool carriesContent = isMedia || hasFrontCap;
        RLayer carrier;
        if (carriesContent) {
          carrier = layer;
          scrub_carrier(carrier);
          carrier.effects = meshEffects;
        } else {
          carrier.effects = meshEffects;
          carrier.kind = LayerKind::shape;
          carrier.primitive = "rect";
          carrier.blend = layer.blend;
          carrier.x = layer.x;
          carrier.y = layer.y;
          carrier.rotation = layer.rotation;
          carrier.scaleX = layer.scaleX;
          carrier.scaleY = layer.scaleY;
          carrier.matrix = layer.matrix;
          carrier.world3d = layer.world3d;
          carrier.depth = layer.depth;
          carrier.opacity = layer.opacity;
          carrier.width = layerW;
          carrier.height = layerH;
          carrier.fill = resolve_face_material(faceMats, "side", wallFill).fill;
          carrier.visible = layer.visible;
          carrier.flatFacet = true;
          carrier.castsShadow3d = layer.castsShadow3d;
        }
        carrier.id = layer.id + "::ext-mesh";
        carrier.extrudedMesh = std::move(data);
        if (extLit) {
          carrier.lighting = std::array<double, 3>{1, 1, 1};
          carrier.shade3d = mesh_shade(extMat);
        }
        emit(std::move(carrier));
        meshEmitted = true;
        if (hasFrontCap) frontDrawnByMesh = true;
      }
    }
    if (!meshEmitted) {
      // perGlyphExtrusion / the slice stack / the geometric faces (extrusion.ts).
      const bool isComplexContent = layer.kind == LayerKind::text || (layer.kind == LayerKind::shape && layer.primitive != "rect" && layer.primitive != "ellipse");
      report(isComplexContent ? "3D extrusion slice stack (no traceable outline)" : "3D extrusion faces (effects or interior styles)");
    }
  }

  // ── glTF models / parametric primitives: the mesh REPLACES the quad ──
  std::optional<RLayer> modelLayer;
  if (n.comp("Model") != nullptr && n.comp("Model")->props.at("modelKey").is_string()) {
    report("glTF models placed in 3D");
  } else if (primKey) {
    if (const auto pm = primitive_mesh_for_key(*primKey)) {
      const Material& mMat = s.mat;
      const bool mLit = mMat.acceptsLights && !sceneLights_.empty();
      if (std::abs(mMat.displacement) > 1e-6 && (mMat.heightMapAssetId || mMat.heightMapSrc)) report("height-map displacement");
      auto data = std::make_shared<ExtrudedMeshData>();
      primitive_mesh_to_api(*pm, data->geometry);
      data->geometry.ranges.clear();
      MeshRange3D r;
      r.role = pm->doubleSided ? api::RenderMeshRole::front : api::RenderMeshRole::side;
      r.first = 0;
      r.count = static_cast<std::uint32_t>(pm->indices.size());
      r.fill = layer.fill.value_or("#3b8276");  // PRIMITIVE_FALLBACK_FILL
      r.gain = 1;
      data->ranges.push_back(std::move(r));
      RLayer m = layer;
      std::vector<Json> meshFx;
      for (const Json& e : layer.effects) {
        if (fx_enabled(e) && (is_color_type(type_of(e)) || is_lut_type(type_of(e)))) meshFx.push_back(e);
      }
      scrub_carrier(m);
      m.effects = std::move(meshFx);
      m.extrudedMesh = std::move(data);
      if (mLit) {
        m.lighting = std::array<double, 3>{1, 1, 1};
        m.shade3d = mesh_shade(mMat);
      }
      modelLayer = std::move(m);
    }
  }

  if (modelLayer) {
    emit(std::move(*modelLayer));
  } else if (frontDrawnByMesh) {
    // The front cap is part of the extrusion mesh.
  } else if (frontInset > 0) {
    RLayer f = layer;
    const auto insetR = [frontInset](double r) { return std::max(0.0, r - frontInset); };
    f.width = layerW - 2 * frontInset;
    f.height = layerH - 2 * frontInset;
    f.cornerRadius = insetR(f.cornerRadius);
    if (f.cornerRadii) {
      for (double& r : *f.cornerRadii) r = insetR(r);
    }
    copiedOnEmit_.push_back(layer.id);
    emit(std::move(f));
  } else {
    before_emit(s, layer);
    emit(std::move(layer));
  }
}

std::optional<RLayer> Scene3D::light_layer(const doc::Node& n) {
  const Values& av = h_.values3d(n.id);
  const LightProps lt = read_node_light(n);
  if (lt.type == "environment") return std::nullopt;
  const xf::Vec3 wp = node_world_position(n);
  double lx = comp_.width / 2;
  double ly = comp_.height / 2;
  if (lt.type != "ambient") {
    const xf::Projected p = project(wp);
    lx = p.x;
    ly = p.y;
  }
  const auto byId = sceneLightById_.find(n.id);
  const double aimDeg = byId != sceneLightById_.end() ? sceneLights_[byId->second].angle : node_light_aim_deg(n, lt);
  const double radius = av.get("radius").value_or(lt.radius);
  const double falloffDistance = av.get("falloffDistance").value_or(lt.falloffDistance);
  const double reach = light_reach(lt.falloff, radius, falloffDistance);
  RLayer w;
  w.id = n.id;
  w.kind = LayerKind::shape;
  w.x = lx;
  w.y = ly;
  w.rotation = aimDeg;
  w.scaleX = 1;
  w.scaleY = 1;
  w.depth = 0;
  w.opacity = 1;
  w.width = comp_.width;
  w.height = comp_.height;
  w.fill = "#000";
  w.visible = n.visible && lt.glow;
  LightWash lw;
  lw.color = lt.color;
  lw.intensity = av.get("intensity").value_or(lt.intensity);
  lw.radius = radius;
  lw.screenRadius = lt.type == "ambient" ? std::max(comp_.width, comp_.height) / 2 : radius;
  lw.type = lt.type;
  lw.cone = av.get("lightCone").value_or(lt.cone);
  lw.coneFeather = av.get("lightConeFeather").value_or(lt.coneFeather);
  w.light = std::move(lw);
  if (lt.type == "spot" || lt.type == "parallel") washLights_.push_back({n.id, reach});
  return w;
}

void Scene3D::finish(std::vector<RLayer>& layers) {
  // environmentSpecularMap (the prefiltered reflection atlas) is not ported: a frame
  // that would carry envMap falls back.
  if (envReflect_ && envReflect_->intensity > 0 && has_world3d(layers)) {
    unported_.emplace_back(envReflect_->nodeId, "environment reflection map (prefiltered atlas)");
  }
  const auto findTop = [&layers](const std::string& id) -> std::ptrdiff_t {
    for (std::size_t i = 0; i < layers.size(); ++i) {
      if (layers[i].id == id) return static_cast<std::ptrdiff_t>(i);
    }
    return -1;
  };
  const auto copied = [this](const std::string& id) { return std::ranges::find(copiedOnEmit_, id) != copiedOnEmit_.end(); };

  // ── Beams that land ──
  if (!washLights_.empty() && !lightReceivers_.empty()) {
    for (const Wash& w : washLights_) {
      const auto it = sceneLightById_.find(w.nodeId);
      if (it == sceneLightById_.end()) continue;
      const SceneLight& L = sceneLights_[it->second];
      const auto aim = light_aim_3d(L);
      if (!aim || (*aim)[2] <= 1e-3) continue;
      const Receiver* receiver = nullptr;
      for (const Receiver& r : lightReceivers_) {
        if (!(r.z > L.z + 1)) continue;
        if (receiver == nullptr || r.z < receiver->z) receiver = &r;
      }
      if (receiver == nullptr) continue;
      const double travel = (receiver->z - L.z) / (*aim)[2];
      if (!std::isfinite(travel) || travel <= 0) continue;
      const double carried = light_attenuation_at(travel, L.falloff, L.radius, L.falloffDistance);
      if (carried <= 0.004) continue;
      const double cx = L.x + (*aim)[0] * travel;
      const double cy = L.y + (*aim)[1] * travel;
      const double half = std::max(1e-3, (L.cone / 2) * (std::numbers::pi / 180));
      const double footprint = L.type == "parallel" ? w.reach : std::max(1.0, travel * motion::js::tan(std::min(half, 1.5)));
      const xf::Projected cp = project({cx, cy, receiver->z});
      if (cp.clipped) continue;
      const std::ptrdiff_t wi = findTop(w.nodeId);
      if (wi < 0 || !layers[static_cast<std::size_t>(wi)].light) continue;
      RLayer& wl = layers[static_cast<std::size_t>(wi)];
      wl.x = cp.x;
      wl.y = cp.y;
      wl.depth = receiver->depth - 0.5;
      wl.rotation = 0;
      wl.light->screenRadius = footprint * cp.scale;
      wl.light->intensity = wl.light->intensity * carried;
      wl.light->pool = true;
    }
  }

  // ── Projected cast shadows ──
  struct ShadowLayer {
    RLayer layer;
    std::string casterId;
    std::string receiverId;
  };
  std::vector<ShadowLayer> shadowLayers;
  if (!shadowLights_.empty() && !shadowCasters_.empty() && !shadowReceivers_.empty()) {
    int lightIndex = 0;
    for (const ShadowLight& L : shadowLights_) {
      const double strength = std::max(0.0, std::min(1.0, (L.intensity / 100) * L.darkness));
      if (strength <= 0) {
        ++lightIndex;
        continue;
      }
      for (const Caster& caster : shadowCasters_) {
        if (!caster.layer) continue;
        const Receiver* receiver = nullptr;
        for (const Receiver& r : shadowReceivers_) {
          if (!(r.z > caster.z + 1)) continue;
          if (receiver == nullptr || r.z < receiver->z) receiver = &r;
        }
        if (receiver == nullptr) continue;
        const double denom = caster.z - L.z;
        if (std::abs(denom) < 1) continue;
        const double t = (receiver->z - L.z) / denom;
        if (!std::isfinite(t) || t <= 0) continue;
        if (t > 8) continue;
        const RLayer& src = *caster.layer;
        const double gap = receiver->z - caster.z;
        const double softness = std::min(200.0, 4 + gap * 0.05 + L.diffusion);
        const double opacity = src.opacity * strength * 0.55 * std::max(0.25, 1 - gap / 4000);
        const xf::Mat4& cw = caster.world3d;
        const double cScaleX = hypot3(cw[0], cw[1], cw[2]);
        const double cScaleY = hypot3(cw[4], cw[5], cw[6]);
        const double zBias = 1 + lightIndex * 0.5;
        const xf::Mat4 M = xf::compose(xf::Parts3D{
            .position = {L.x + (cw[12] - L.x) * t, L.y + (cw[13] - L.y) * t, receiver->z - zBias},
            .rotation = {0, 0, 0},
            .scale = {cScaleX * t, cScaleY * t, 1},
            .anchor = {0, 0, 0},
        });
        const xf::Projected O = project(xf::transform_point(M, {0, 0, 0}));
        if (O.clipped) continue;
        const xf::Projected FX = project(xf::transform_point(M, {1, 0, 0}));
        const xf::Projected FY = project(xf::transform_point(M, {0, 1, 0}));
        const std::array<double, 6> sm = {FX.x - O.x, FX.y - O.y, FY.x - O.x, FY.y - O.y, O.x, O.y};
        RLayer shadow = src;
        shadow.id = lightIndex == 0 ? src.id + "::shadow" : src.id + "::shadow:" + std::to_string(lightIndex);
        shadow.visible = true;
        shadow.x = O.x;
        shadow.y = O.y;
        shadow.scaleX = hypot2(sm[0], sm[1]);
        shadow.scaleY = hypot2(sm[2], sm[3]);
        shadow.rotation = motion::js::atan2(sm[1], sm[0]) / kDeg;
        shadow.matrix = sm;
        shadow.world3d = to_arr(M);
        shadow.depth = O.depth;
        shadow.opacity = opacity;
        shadow.blend = "normal";
        shadow.preserveTransparency = false;
        shadow.fill = shadow_tint(src.fill, caster.transmission);
        shadow.fillPaint = Json();
        shadow.fillPaints = Json();
        shadow.stroke = Json();
        shadow.lighting = std::array<double, 3>{0, 0, 0};
        shadow.shade3d = std::nullopt;
        Json params = Json::object();
        params.set("amount", Json::number(fixed_num(softness, 1)));
        Json blur = Json::object();
        blur.set("id", Json::string("shadow-blur"));
        blur.set("type", Json::string("blur"));
        blur.set("params", std::move(params));
        shadow.effects = {std::move(blur)};
        shadow.matte = std::nullopt;
        shadow.isMatteSource = false;
        shadow.isAdjustment = false;
        shadow.motionSamples.clear();
        shadowLayers.push_back({std::move(shadow), caster.layerId, receiver->layerId});
      }
      ++lightIndex;
    }
  }
  for (std::size_t i = shadowLayers.size(); i-- > 0;) {
    ShadowLayer& sl = shadowLayers[i];
    const std::ptrdiff_t ci = copied(sl.casterId) ? -1 : findTop(sl.casterId);
    if (ci < 0) {
      layers.push_back(std::move(sl.layer));
      continue;
    }
    const std::ptrdiff_t ri = copied(sl.receiverId) ? -1 : findTop(sl.receiverId);
    const std::ptrdiff_t at = ri >= 0 && ri < ci ? ri + 1 : ci;
    layers.insert(layers.begin() + at, std::move(sl.layer));
  }

  // ── 3D depth sort within runs bounded by order-dependent layers ──
  if (!std::ranges::any_of(layers, [](const RLayer& l) { return l.matrix.has_value(); })) return;
  std::vector<bool> locked(layers.size(), false);
  for (std::size_t i = 0; i < layers.size(); ++i) {
    const RLayer& l = layers[i];
    if (l.isAdjustment) locked[i] = true;
    if (!l.matrix) locked[i] = true;
    if (l.matte) {
      locked[i] = true;
      if (l.matte->sourceId) {
        const std::ptrdiff_t j = findTop(*l.matte->sourceId);
        if (j >= 0) locked[static_cast<std::size_t>(j)] = true;
      } else if (i + 1 < layers.size()) {
        locked[i + 1] = true;
      }
    }
  }
  std::vector<RLayer> sorted;
  sorted.reserve(layers.size());
  struct Parked {
    std::size_t at;
    RLayer layer;
  };
  std::vector<Parked> parked;
  std::vector<RLayer> run;
  const auto flushRun = [&]() {
    std::ranges::stable_sort(run, [](const RLayer& p, const RLayer& q) { return q.depth - p.depth < 0; });
    for (RLayer& l : run) sorted.push_back(std::move(l));
    run.clear();
  };
  for (std::size_t i = 0; i < layers.size(); ++i) {
    RLayer& l = layers[i];
    if (l.light) {
      parked.push_back({sorted.size() + run.size(), std::move(l)});
      continue;
    }
    if (locked[i]) {
      flushRun();
      sorted.push_back(std::move(l));
    } else {
      run.push_back(std::move(l));
    }
  }
  flushRun();
  for (std::size_t k = 0; k < parked.size(); ++k) {
    const std::size_t at = std::min(parked[k].at + k, sorted.size());
    sorted.insert(sorted.begin() + static_cast<std::ptrdiff_t>(at), std::move(parked[k].layer));
  }
  layers = std::move(sorted);
}

void Scene3D::emit(Snapshot& s, const std::vector<RLayer>& layers) const {
  if (!has_world3d(layers)) return;
  api::RenderCamera3D cam;
  if (ortho_) {
    const xf::OrthoMatrices om = xf::ortho_camera_matrices(*ortho_, comp_.width, comp_.height);
    cam.view = mat_vec(om.view);
    cam.projection = mat_vec(om.projection);
  } else {
    cam.view = mat_vec(xf::camera_view_matrix(*camera_));
    cam.projection = mat_vec(xf::camera_projection_matrix(*camera_));
    cam.eye = {camera_->position.x, camera_->position.y, camera_->position.z};
    if (dof_) cam.dof = dof_wire(*dof_);
  }
  s.camera3d = std::move(cam);
  const std::vector<SceneLight>& shipped = !sceneLights_.empty() ? sceneLights_ : formRigUsed_ ? formRig_ : sceneLights_;
  if (!shipped.empty()) s.lights3d = to_shader_lights(shipped);
  if (const Json* rec = c_.d.comp(comp_.rootId)) {
    const Json& ss = rec->at("ssao");
    if (ss.is_object() && ss.at("enabled").is_bool() && ss.at("enabled").b()) {
      api::RenderSsao o;
      o.enabled = true;
      o.radius = ss.at("radius").is_number() ? ss.at("radius").num() : 0;
      o.intensity = ss.at("intensity").is_number() ? ss.at("intensity").num() : 0;
      o.quality = ss.at("quality").is_string() && ss.at("quality").str() == "full" ? api::RenderSsaoQuality::full
                                                                                   : api::RenderSsaoQuality::half;
      s.ssao = o;
    }
  }
}

}  // namespace premation::scene
