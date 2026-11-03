#include "worldxf.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <functional>
#include <map>
#include <numbers>
#include <set>
#include <vector>

#include "bone_link.hpp"
#include "readmodel.hpp"
#include "scene.hpp"
#include "timeline.hpp"

namespace premation::doc {
namespace {

/// geometry.ts `isDrawableKind`, plus `adjustment` (B1, docs/PROGRAM_3D_PERF_UX.md):
/// an adjustment layer has a Transform like any other and the frame walk
/// (snapshot_build.cpp Walk::local_of) places it and its children by it, so
/// reading it as identity here made `setParent keepWorldTransform` drop a
/// centred grade / rain pass to its new parent's origin and `getLayerTransforms`
/// answer identity for it.
bool is_drawable_kind(const std::string& kind) {
  if (kind.find('.') != std::string::npos) return true;
  return kind == "shape" || kind == "text" || kind == "image" || kind == "video" || kind == "svg" || kind == "light" ||
         kind == "camera" || kind == "particle" || kind == "comp" || kind == "null" || kind == "group" ||
         kind == "adjustment";
}

}  // namespace

std::optional<motion::xf::Local2D> read_geometry_local(const Node& n) {
  if (!is_drawable_kind(n.kind())) return std::nullopt;
  std::optional<double> x;
  std::optional<double> y;
  std::optional<double> rotation;
  std::optional<double> scaleX;
  std::optional<double> scaleY;
  std::optional<double> scale;
  for (const Component& c : n.components) {
    const Json& p = c.props;
    if (p.at("x").is_number()) x = p.at("x").num();
    if (p.at("y").is_number()) y = p.at("y").num();
    if (p.at("rotation").is_number()) rotation = p.at("rotation").num();
    if (p.at("scaleX").is_number()) scaleX = p.at("scaleX").num();
    if (p.at("scaleY").is_number()) scaleY = p.at("scaleY").num();
    if (p.at("scale").is_number()) scale = p.at("scale").num();
  }
  const ViewTransform vt = view_transform(n);
  motion::xf::Local2D l;
  l.x = x.value_or(vt.x);
  l.y = y.value_or(vt.y);
  l.rotation = rotation.value_or(vt.rotation);
  l.scale_x = scaleX ? *scaleX : scale.value_or(1);
  l.scale_y = scaleY ? *scaleY : scale.value_or(1);
  return l;
}

namespace {

using AnimValues = std::map<std::string, double, std::less<>>;

/// The transform props a layer space reads. Only these are sampled: evaluating
/// every expressed prop of the node would re-enter an expression that asks for
/// its own layer's space (`thisLayer.toComp(...)` on Opacity) until the step
/// budget ran out.
constexpr std::array<std::string_view, 16> kSpaceProps = {
    "x", "y", "z", "rotation", "rotationX", "rotationY", "orientationX", "orientationY", "orientationZ",
    "scale", "scaleX", "scaleY", "scaleZ", "anchorX", "anchorY", "anchorZ"};

/// `defaultAnimation.evaluateNode(node, getRemappedTime(node, seconds))` as a
/// lookup, restricted to kSpaceProps.
AnimValues evaluate_at(const SpaceCtx& c, std::string_view node, double seconds) {
  const double t = comp_to_keyframe_time(c.d, c.view, node, seconds);
  AnimValues av;
  for (const std::string_view prop : kSpaceProps) {
    if (const auto v = anim_sample(c.d, c.expr, c.cache, node, prop, t)) av.insert_or_assign(std::string(prop), *v);
  }
  return av;
}

std::optional<double> get(const AnimValues& av, std::string_view k) {
  const auto it = av.find(k);
  return it == av.end() ? std::nullopt : std::optional<double>(it->second);
}

std::optional<motion::xf::Local2D> local_at(const SpaceCtx& c, std::string_view node, double seconds) {
  const Node* n = c.d.node(node);
  if (n == nullptr) return std::nullopt;
  auto g = read_geometry_local(*n);
  if (!g) return std::nullopt;
  const AnimValues av = evaluate_at(c, node, seconds);
  const auto sc = get(av, "scale");
  motion::xf::Local2D l;
  l.x = get(av, "x").value_or(g->x);
  l.y = get(av, "y").value_or(g->y);
  l.rotation = get(av, "rotation").value_or(g->rotation);
  l.scale_x = get(av, "scaleX") ? *get(av, "scaleX") : sc.value_or(g->scale_x);
  l.scale_y = get(av, "scaleY") ? *get(av, "scaleY") : sc.value_or(g->scale_y);
  return l;
}

/// `worldMatrixOf(node, localOf, parentOf)`: world = parentWorld · local up the
/// chain; a node ON a parent cycle is a root. A part bound to a bone of its
/// character composes the bone's link between the two (bone_link.hpp).
template <class LocalOf, class LinkOf>
motion::xf::Mat2D world_matrix_of(const Document& d, std::string_view node, const LocalOf& localOf,
                                  const LinkOf& linkOf) {
  using motion::xf::Mat2D;
  const Mat2D identity{1, 0, 0, 1, 0, 0};
  std::vector<std::string> path;
  std::set<std::string> onPath;
  std::string id(node);
  std::size_t cycleFrom = std::string::npos;
  for (;;) {
    const Node* n = d.node(id);
    onPath.insert(id);
    path.push_back(id);
    if (n == nullptr || !n->parent) break;
    const std::string parent = *n->parent;
    if (onPath.contains(parent)) {
      for (std::size_t i = 0; i < path.size(); ++i) {
        if (path[i] == parent) cycleFrom = i;
      }
      break;
    }
    id = parent;
  }
  Mat2D world = identity;
  for (std::size_t k = path.size(); k-- > 0;) {
    const std::optional<motion::xf::Local2D> local = localOf(path[k]);
    const Mat2D lm = local ? motion::xf::local_matrix(*local) : identity;
    if (cycleFrom != std::string::npos && k >= cycleFrom) world = lm;
    else if (k == path.size() - 1) world = lm;
    else if (const std::optional<Mat2D> link = linkOf(path[k])) world = motion::xf::multiply(motion::xf::multiply(world, *link), lm);
    else world = motion::xf::multiply(world, lm);
  }
  return world;
}

/// A node's 2D world affine at comp `seconds`, every link's ANIMATED values
/// winning — what the renderer lifts a 2D parent by (threed_port.cpp
/// `parent_world_3d` / `parent_world_matrix` over the walk's `world2d`). The
/// static geometry left a 3D layer under a keyed 2D null where the null was
/// authored while the frame drew it where the null had moved.
motion::xf::Mat2D world_2d_animated(const SpaceCtx& c, std::string_view node, double seconds) {
  return world_matrix_of(
      c.d, node, [&c, seconds](const std::string& id) { return local_at(c, id, seconds); },
      [&c, seconds](const std::string& id) -> std::optional<motion::xf::Mat2D> {
        const Node* n = c.d.node(id);
        return n != nullptr ? bone_link_at(c.d, c.view, c.expr, c.cache, *n, seconds) : std::nullopt;
      });
}

/// threeD.ts `readNode3D` / anchor.ts `readNodeAnchor`: a Transform number, else 0.
double transform_num(const Node& n, std::string_view prop) {
  const Component* t = n.comp("Transform");
  if (t == nullptr) return 0;
  const Json& v = t->props.at(prop);
  return v.is_number() ? v.num() : 0;
}

/// nodeMatrix.ts `resolveNode3DTransform(node, seconds)`.
std::optional<motion::xf::Node3DTransform> resolve_node_3d(const SpaceCtx& c, const Node& n, double seconds) {
  const auto g = read_geometry_local(n);
  if (!g) return std::nullopt;
  const AnimValues av = evaluate_at(c, n.id, seconds);
  motion::xf::Node3DTransform v;
  v.x = get(av, "x").value_or(g->x);
  v.y = get(av, "y").value_or(g->y);
  v.z = get(av, "z").value_or(transform_num(n, "z"));
  v.rotation_x = get(av, "rotationX").value_or(transform_num(n, "rotationX"));
  v.rotation_y = get(av, "rotationY").value_or(transform_num(n, "rotationY"));
  v.rotation_z = get(av, "rotation").value_or(g->rotation);
  v.orientation_x = get(av, "orientationX").value_or(transform_num(n, "orientationX"));
  v.orientation_y = get(av, "orientationY").value_or(transform_num(n, "orientationY"));
  v.orientation_z = get(av, "orientationZ").value_or(transform_num(n, "orientationZ"));
  const auto sc = get(av, "scale");
  v.scale_x = get(av, "scaleX") ? *get(av, "scaleX") : sc.value_or(g->scale_x);
  v.scale_y = get(av, "scaleY") ? *get(av, "scaleY") : sc.value_or(g->scale_y);
  v.scale_z = get(av, "scaleZ").value_or(1);
  v.anchor_x = get(av, "anchorX").value_or(transform_num(n, "anchorX"));
  v.anchor_y = get(av, "anchorY").value_or(transform_num(n, "anchorY"));
  v.anchor_z = get(av, "anchorZ").value_or(transform_num(n, "anchorZ"));
  return v;
}

/// The bone link `n` composes under its character, lifted to 3D (bone_link.hpp); nullopt when not bound.
std::optional<motion::xf::Mat4> link_3d_at(const SpaceCtx& c, const Node& n, double seconds) {
  const auto link = bone_link_at(c.d, c.view, c.expr, c.cache, n, seconds);
  return link ? std::optional<motion::xf::Mat4>(motion::xf::from_mat2d(*link)) : std::nullopt;
}

/// liveWorld3d.ts `parentWorldMatrixAt(node, seconds)` (+ nodeMatrix `parentWorld3d`). A part of a character
/// (bound to a bone) sits in its bone's space: the link follows the group's world, 3D or not.
std::optional<motion::xf::Mat4> parent_world_matrix_at(const SpaceCtx& c, std::string_view node, double seconds) {
  const Node* n = c.d.node(node);
  if (n == nullptr || !n->parent) return std::nullopt;
  const std::string parentId = *n->parent;
  std::set<std::string> seen{std::string(node)};
  bool any3d = false;
  std::vector<const Node*> chain;
  for (const Node* p = c.d.node(parentId); p != nullptr && !seen.contains(p->id);
       p = p->parent ? c.d.node(*p->parent) : nullptr) {
    seen.insert(p->id);
    chain.push_back(p);
    if (is_3d_enabled(*p)) any3d = true;
  }
  const auto withOwnLink = [&](motion::xf::Mat4 parent) {
    const auto link = link_3d_at(c, *n, seconds);
    return link ? motion::xf::multiply(parent, *link) : parent;
  };
  if (any3d) {
    std::optional<motion::xf::Mat4> acc;
    for (std::size_t k = chain.size(); k-- > 0;) {
      const Node& a = *chain[k];
      if (!is_3d_enabled(a)) {
        acc = motion::xf::from_mat2d(world_2d_animated(c, a.id, seconds));  // the 2D walk composes a's link
        continue;
      }
      const auto local = resolve_node_3d(c, a, seconds);
      if (!local) continue;
      if (acc) {
        if (const auto link = link_3d_at(c, a, seconds)) acc = motion::xf::multiply(*acc, *link);
      }
      const motion::xf::Mat4 own = motion::xf::compose_node_3d(*local);
      acc = acc ? motion::xf::multiply(*acc, own) : own;
    }
    if (acc) return withOwnLink(*acc);
  }
  // Pure-2D chain: the parent's own world affine, lifted (z untouched, AE's rule).
  return withOwnLink(motion::xf::from_mat2d(world_2d_animated(c, parentId, seconds)));
}

/// `toWorldPointAt(node, seconds, p)`: a point in the node's PARENT space → world.
motion::xf::Vec3 to_world_point_at(const SpaceCtx& c, std::string_view node, double seconds, motion::xf::Vec3 p) {
  const auto m = parent_world_matrix_at(c, node, seconds);
  return m ? motion::xf::transform_point(*m, p) : p;
}

/// `nodeWorldWithParents3d(node, seconds)`.
std::optional<motion::xf::Mat4> node_world_with_parents_3d(const SpaceCtx& c, const Node& n, double seconds) {
  const auto t = resolve_node_3d(c, n, seconds);
  if (!t) return std::nullopt;
  const motion::xf::Mat4 local = motion::xf::compose_node_3d(*t);
  const auto parent = parent_world_matrix_at(c, n.id, seconds);
  return parent ? motion::xf::multiply(*parent, local) : local;
}

/// camera3d.ts `cameraFromNode`, sampled through layerSpace.ts's geometry-only
/// sampler (static prop: the last component carrying it; a sample wins), lifted
/// through `toWorldPointAt`.
motion::xf::Camera camera_from_node(const SpaceCtx& c, const Node& n, double w, double h, double seconds) {
  const auto stat = [&n](std::string_view k) {
    std::optional<double> out;
    for (const Component& comp : n.components) {
      const Json& v = comp.props.at(k);
      if (v.is_number()) out = v.num();
    }
    return out;
  };
  const double t = comp_to_keyframe_time(c.d, c.view, n.id, seconds);
  const auto val = [&](std::string_view k) {
    const auto s = anim_sample(c.d, c.expr, c.cache, n.id, k, t);
    return s ? s : stat(k);
  };
  motion::xf::CameraProps p;
  p.x = val("x");
  p.y = val("y");
  p.z = val("z");
  p.focal_length = val("focalLength");
  p.orbit_yaw = val("orbitYaw");
  p.orbit_pitch = val("orbitPitch");
  p.poi_x = val("poiX");
  p.poi_y = val("poiY");
  p.poi_z = val("poiZ");
  p.orientation_x = val("orientationX");
  p.orientation_y = val("orientationY");
  p.orientation_z = val("orientationZ");
  const motion::xf::Camera cam =
      motion::xf::camera_from_props(p, w, h, [&](motion::xf::Vec3 v) { return to_world_point_at(c, n.id, seconds, v); });
  // Camera program R2b: a one-node camera turns with its parents.
  const bool twoNode = p.poi_x || p.poi_y || p.poi_z;
  const motion::xf::Camera parented = twoNode ? cam : rotate_camera_with_parent(cam, parent_world_matrix_at(c, n.id, seconds));
  // Camera program R3b: Auto-Orient Along Path (one-node), before the shake.
  motion::xf::Camera aimed = parented;
  if (const auto dir = camera_path_direction(c.d, c.expr, c.cache, n, n.id, t,
                                             [&](motion::xf::Vec3 v) { return to_world_point_at(c, n.id, seconds, v); })) {
    aimed = orient_camera_along(cam, *dir, p.orientation_x.value_or(0), p.orientation_y.value_or(0),
                                p.orientation_z.value_or(0));
  }
  // Camera program R1: procedural shake after the aim (threed_port.cpp's twin).
  motion::xf::CameraShake sh;
  sh.seconds = t;
  if (const auto v = val("shakeAmount")) sh.amount = *v;
  if (const auto v = val("shakeRotation")) sh.rotation = *v;
  if (const auto v = val("shakeFrequency")) sh.frequency = *v;
  if (const auto v = val("shakeSeed")) sh.seed = *v;
  return motion::xf::apply_camera_shake(aimed, sh);
}

/// `readSceneCamera(graph, w, h, sample)` with no root (the editor's expression
/// provider): the LAST visible camera in flattenScene order (roots in node
/// order, each subtree depth-first in child order), else the default camera.
motion::xf::Camera read_scene_camera(const SpaceCtx& c, double w, double h, double seconds) {
  const Node* found = nullptr;
  std::set<std::string> seen;
  std::function<void(const Node&)> walk = [&](const Node& n) {
    if (!seen.insert(n.id).second) return;
    if (n.kind() == "camera" && n.visible) found = &n;
    for (const auto& ch : n.children) {
      if (const Node* child = c.d.node(ch)) walk(*child);
    }
  };
  for (const auto& [id, n] : c.d.nodes()) {
    if (!n->parent) walk(*n);
  }
  return found != nullptr ? camera_from_node(c, *found, w, h, seconds) : motion::xf::default_camera(w, h);
}

}  // namespace

std::optional<motion::xf::Vec3> camera_path_direction(const Document& d, const ExprEnv& expr, ExprCache& cache,
                                                      const Node& n, std::string_view animId, double kt,
                                                      const std::function<motion::xf::Vec3(motion::xf::Vec3)>& lift) {
  if (n.kind() != "camera" || read_auto_orient_mode(n) != "path") return std::nullopt;
  std::array<double, 3> base{0, 0, 0};
  constexpr std::array<std::string_view, 3> kAxes = {"x", "y", "z"};
  for (const Component& comp : n.components) {
    for (const std::string_view k : {std::string_view("poiX"), std::string_view("poiY"), std::string_view("poiZ")}) {
      if (comp.props.at(k).is_number()) return std::nullopt;  // two-node: it aims at its Point of Interest
    }
    for (std::size_t i = 0; i < 3; ++i) {
      if (comp.props.at(kAxes.at(i)).is_number()) base.at(i) = comp.props.at(kAxes.at(i)).num();
    }
  }
  // The keyed span over the position tracks: outside it the tangent is held.
  std::optional<double> first;
  std::optional<double> last;
  for (const std::string_view k : kAxes) {
    const auto* keys = anim_track(d, animId, k);
    if (keys == nullptr || keys->empty()) continue;
    first = first ? std::min(*first, keys->front().t) : keys->front().t;
    last = last ? std::max(*last, keys->back().t) : keys->back().t;
  }
  if (!first || !last || !std::isfinite(kt)) return std::nullopt;
  const double t = std::clamp(kt, *first, *last);
  const auto at = [&](double tt) {
    std::array<double, 3> v = base;
    for (std::size_t i = 0; i < 3; ++i) {
      if (const auto s = anim_sample(d, expr, cache, animId, kAxes.at(i), tt)) v.at(i) = *s;
    }
    const motion::xf::Vec3 p{v[0], v[1], v[2]};
    return lift ? lift(p) : p;
  };
  constexpr double kH = 1.0 / 120;
  const auto diff = [](motion::xf::Vec3 a, motion::xf::Vec3 b) { return motion::xf::Vec3{b.x - a.x, b.y - a.y, b.z - a.z}; };
  const auto zero = [](motion::xf::Vec3 v) { return v.x == 0 && v.y == 0 && v.z == 0; };
  motion::xf::Vec3 dir = diff(at(t), at(std::min(t + kH, *last)));
  if (zero(dir)) dir = diff(at(std::max(t - kH, *first)), at(t));
  if (zero(dir) || !std::isfinite(dir.x) || !std::isfinite(dir.y) || !std::isfinite(dir.z)) return std::nullopt;
  return dir;
}

namespace {

/// Camera-local (right, down, forward) → world: the order of transform.cpp
/// `unproject_screen_ray` (roll, then pitch about x, then yaw about y).
motion::xf::Vec3 turn_by(motion::xf::Vec3 v, const std::optional<motion::xf::Orientation>& o) {
  if (!o) return v;
  constexpr double kDeg = std::numbers::pi / 180;
  const double roll = o->roll.value_or(0) * kDeg;
  double vx = v.x;
  double vy = v.y;
  const double vz = v.z;
  if (roll != 0) {
    const double rx = std::cos(roll) * vx - std::sin(roll) * vy;
    vy = std::sin(roll) * vx + std::cos(roll) * vy;
    vx = rx;
  }
  const double cx = std::cos(o->pitch * kDeg);
  const double sx = std::sin(o->pitch * kDeg);
  const double cy = std::cos(o->yaw * kDeg);
  const double sy = std::sin(o->yaw * kDeg);
  const double y1 = cx * vy - sx * vz;
  const double z1 = sx * vy + cx * vz;
  return {cy * vx + sy * z1, y1, -sy * vx + cy * z1};
}

motion::xf::Vec3 unit(motion::xf::Vec3 v) {
  const double l = std::hypot(v.x, v.y, v.z);
  return l > 0 ? motion::xf::Vec3{v.x / l, v.y / l, v.z / l} : v;
}

}  // namespace

motion::xf::Camera rotate_camera_with_parent(const motion::xf::Camera& cam, const std::optional<motion::xf::Mat4>& parent) {
  if (!parent) return cam;
  namespace xf = motion::xf;
  const xf::Vec3 o = xf::transform_point(*parent, {0, 0, 0});
  const auto axis = [&](xf::Vec3 e) {
    const xf::Vec3 p = xf::transform_point(*parent, e);
    return unit(xf::Vec3{p.x - o.x, p.y - o.y, p.z - o.z});
  };
  const xf::Vec3 ax = axis({1, 0, 0});
  const xf::Vec3 ay = axis({0, 1, 0});
  const xf::Vec3 az = axis({0, 0, 1});
  // Unrotated parents (translation / uniform or axis scale only): nothing to do.
  if (ax.y == 0 && ax.z == 0 && ay.x == 0 && ay.z == 0 && az.x == 0 && az.y == 0 && ax.x > 0 && ay.y > 0 && az.z > 0) return cam;
  const auto rot = [&](xf::Vec3 v) {
    return xf::Vec3{ax.x * v.x + ay.x * v.y + az.x * v.z, ax.y * v.x + ay.y * v.y + az.y * v.z, ax.z * v.x + ay.z * v.y + az.z * v.z};
  };
  const xf::Vec3 f = unit(rot(turn_by({0, 0, 1}, cam.orientation)));
  const xf::Vec3 d = unit(rot(turn_by({0, 1, 0}, cam.orientation)));
  const xf::Orientation look = xf::look_at_orientation({0, 0, 0}, f);
  xf::Orientation base{.yaw = look.yaw, .pitch = look.pitch, .roll = std::nullopt};
  const xf::Vec3 r0 = turn_by({1, 0, 0}, base);
  const xf::Vec3 d0 = turn_by({0, 1, 0}, base);
  // down = cos(roll)·d0 − sin(roll)·r0.
  const double roll = std::atan2(-(d.x * r0.x + d.y * r0.y + d.z * r0.z), d.x * d0.x + d.y * d0.y + d.z * d0.z) * 180 / std::numbers::pi;
  xf::Camera out = cam;
  xf::Orientation turned{.yaw = look.yaw, .pitch = look.pitch, .roll = std::nullopt};
  if (std::abs(roll) > 1e-9) turned.roll = roll;
  out.orientation = turned;
  return out;
}

motion::xf::Camera orient_camera_along(const motion::xf::Camera& cam, motion::xf::Vec3 dir, double oriX, double oriY,
                                       double roll) {
  const motion::xf::Orientation o = motion::xf::look_at_orientation({0, 0, 0}, dir);
  motion::xf::Orientation composed{.yaw = o.yaw + oriY, .pitch = o.pitch + oriX, .roll = std::nullopt};
  if (roll != 0) composed.roll = roll;
  motion::xf::Camera out = cam;
  if (composed.yaw != 0 || composed.pitch != 0 || composed.roll.value_or(0) != 0) {
    out.orientation = composed;
  } else {
    out.orientation.reset();
  }
  return out;
}

std::optional<motion::xf::Node3DTransform> local_3d_at(const SpaceCtx& c, const Node& n, double seconds) {
  return resolve_node_3d(c, n, seconds);
}

std::optional<motion::xf::Mat4> parent_world_at(const SpaceCtx& c, std::string_view node, double seconds) {
  return parent_world_matrix_at(c, node, seconds);
}

motion::xf::Vec3 world_point_at(const SpaceCtx& c, std::string_view node, double seconds, motion::xf::Vec3 p) {
  return to_world_point_at(c, node, seconds, p);
}

std::optional<motion::xf::Mat4> node_world_3d_at(const SpaceCtx& c, const Node& n, double seconds) {
  return node_world_with_parents_3d(c, n, seconds);
}

motion::xf::Camera camera_at(const SpaceCtx& c, const Node& n, double w, double h, double seconds) {
  return camera_from_node(c, n, w, h, seconds);
}

std::optional<motion::xf::Mat4> world_3d_at(const SpaceCtx& c, std::string_view node, double seconds, double compWidth,
                                            double compHeight) {
  const Node* n = c.d.node(node);
  if (n == nullptr) return std::nullopt;
  const std::string kind = n->kind();
  const bool device = kind == "camera" || kind == "light";
  if (!is_3d_enabled(*n) && !device) return std::nullopt;
  // Devices first: a camera's space is its EYE, a light's its lifted position.
  if (device) {
    motion::xf::Vec3 position;
    if (kind == "camera") {
      position = camera_from_node(c, *n, compWidth, compHeight, seconds).position;
    } else {
      const AnimValues av = evaluate_at(c, node, seconds);
      const auto g = read_geometry_local(*n);
      position = to_world_point_at(c, node, seconds,
                                   {get(av, "x").value_or(g ? g->x : 0), get(av, "y").value_or(g ? g->y : 0),
                                    get(av, "z").value_or(transform_num(*n, "z"))});
    }
    return motion::xf::compose(motion::xf::Parts3D{.position = position, .rotation = {}, .scale = {1, 1, 1}, .anchor = {}});
  }
  return node_world_with_parents_3d(c, *n, seconds);
}

std::optional<LayerSpace> layer_space_at(const SpaceCtx& c, std::string_view node, double seconds, double compWidth,
                                         double compHeight) {
  const Node* n = c.d.node(node);
  if (n == nullptr) return std::nullopt;
  const std::string kind = n->kind();
  const bool device = kind == "camera" || kind == "light";
  if (!is_3d_enabled(*n) && !device) {
    // 2D: the composition is the world plane.
    return LayerSpace{motion::xf::LayerSpace2D(world_2d_animated(c, node, seconds))};
  }
  // 3D: layer → world is a 4x4 (world_3d_at); world → comp is the camera.
  const std::optional<motion::xf::Mat4> m = world_3d_at(c, node, seconds, compWidth, compHeight);
  if (!m) return std::nullopt;
  return LayerSpace{
      motion::xf::LayerSpace3D(*m, read_scene_camera(c, compWidth, compHeight, seconds), compWidth, compHeight)};
}

std::optional<motion::xf::Local2D> local_transform_at(const PCtx& c, std::string_view node, double seconds) {
  const Node* n = c.d.node(node);
  if (n == nullptr) return std::nullopt;
  auto g = read_geometry_local(*n);
  if (!g) return std::nullopt;
  const double t = comp_to_keyframe_time(c.d, c.view, node, seconds);
  std::map<std::string, double, std::less<>> av;
  for (const std::string_view prop : kSpaceProps) {  // not every prop: see kSpaceProps
    if (const auto v = anim_sample(c.d, c.expr, c.cache, node, prop, t)) av.insert_or_assign(std::string(prop), *v);
  }
  auto get = [&](std::string_view k) -> std::optional<double> {
    const auto it = av.find(k);
    return it == av.end() ? std::nullopt : std::optional<double>(it->second);
  };
  const auto sc = get("scale");
  motion::xf::Local2D l;
  l.x = get("x").value_or(g->x);
  l.y = get("y").value_or(g->y);
  l.rotation = get("rotation").value_or(g->rotation);
  l.scale_x = get("scaleX") ? *get("scaleX") : sc.value_or(g->scale_x);
  l.scale_y = get("scaleY") ? *get("scaleY") : sc.value_or(g->scale_y);
  return l;
}

motion::xf::Mat2D world_2d_at(const PCtx& c, std::string_view node, double seconds) {
  using motion::xf::Mat2D;
  const Mat2D identity{1, 0, 0, 1, 0, 0};
  std::vector<std::string> path;
  std::set<std::string> onPath;
  std::string id(node);
  std::size_t cycleFrom = std::string::npos;
  for (;;) {
    const Node* n = c.d.node(id);
    onPath.insert(id);
    path.push_back(id);
    if (n == nullptr || !n->parent) break;
    const std::string parent = *n->parent;
    if (onPath.contains(parent)) {
      for (std::size_t i = 0; i < path.size(); ++i) {
        if (path[i] == parent) cycleFrom = i;
      }
      break;
    }
    id = parent;
  }
  Mat2D world = identity;
  for (std::size_t k = path.size(); k-- > 0;) {
    const auto local = local_transform_at(c, path[k], seconds);
    const Mat2D lm = local ? motion::xf::local_matrix(*local) : identity;
    if (cycleFrom != std::string::npos && k >= cycleFrom) world = lm;
    else if (k == path.size() - 1) world = lm;
    else if (const auto link = bone_link_at(c.d, c.view, c.expr, c.cache, *c.d.node(path[k]), seconds))
      world = motion::xf::multiply(motion::xf::multiply(world, *link), lm);
    else world = motion::xf::multiply(world, lm);
  }
  return world;
}

}  // namespace premation::doc
