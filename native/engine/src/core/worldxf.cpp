#include "worldxf.hpp"

#include <functional>
#include <map>
#include <set>
#include <vector>

#include "scene.hpp"
#include "timeline.hpp"

namespace premation::doc {
namespace {

bool is_drawable_kind(const std::string& kind) {
  if (kind.find('.') != std::string::npos) return true;
  return kind == "shape" || kind == "text" || kind == "image" || kind == "video" || kind == "svg" || kind == "light" ||
         kind == "camera" || kind == "particle" || kind == "comp" || kind == "null" || kind == "group";
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

/// `defaultAnimation.evaluateNode(node, getRemappedTime(node, seconds))` as a lookup.
AnimValues evaluate_at(const SpaceCtx& c, std::string_view node, double seconds) {
  const double t = comp_to_keyframe_time(c.d, c.view, node, seconds);
  AnimValues av;
  for (auto& [prop, v] : anim_evaluate_node(c.d, c.expr, c.cache, node, t)) av.insert_or_assign(prop, v);
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
/// chain; a node ON a parent cycle is a root.
template <class LocalOf>
motion::xf::Mat2D world_matrix_of(const Document& d, std::string_view node, const LocalOf& localOf) {
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
    else world = motion::xf::multiply(world, lm);
  }
  return world;
}

/// liveParent3DResolvers' `world2DOf`: the STATIC geometry's world affine.
motion::xf::Mat2D world_2d_static(const Document& d, std::string_view node) {
  return world_matrix_of(d, node, [&d](const std::string& id) -> std::optional<motion::xf::Local2D> {
    const Node* n = d.node(id);
    return n != nullptr ? read_geometry_local(*n) : std::nullopt;
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

/// liveWorld3d.ts `parentWorldMatrixAt(node, seconds)` (+ nodeMatrix `parentWorld3d`).
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
  if (any3d) {
    std::optional<motion::xf::Mat4> acc;
    for (std::size_t k = chain.size(); k-- > 0;) {
      const Node& a = *chain[k];
      if (!is_3d_enabled(a)) {
        acc = motion::xf::from_mat2d(world_2d_static(c.d, a.id));
        continue;
      }
      const auto local = resolve_node_3d(c, a, seconds);
      if (!local) continue;
      const motion::xf::Mat4 own = motion::xf::compose_node_3d(*local);
      acc = acc ? motion::xf::multiply(*acc, own) : own;
    }
    if (acc) return acc;
  }
  // Pure-2D chain: the parent's own world affine, lifted (z untouched, AE's rule).
  return motion::xf::from_mat2d(world_2d_static(c.d, parentId));
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
  return motion::xf::camera_from_props(p, w, h,
                                       [&](motion::xf::Vec3 v) { return to_world_point_at(c, n.id, seconds, v); });
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

std::optional<LayerSpace> layer_space_at(const SpaceCtx& c, std::string_view node, double seconds, double compWidth,
                                         double compHeight) {
  const Node* n = c.d.node(node);
  if (n == nullptr) return std::nullopt;
  const std::string kind = n->kind();
  const bool device = kind == "camera" || kind == "light";
  if (!is_3d_enabled(*n) && !device) {
    // 2D: the composition is the world plane.
    return LayerSpace{motion::xf::LayerSpace2D(
        world_matrix_of(c.d, node, [&c, seconds](const std::string& id) { return local_at(c, id, seconds); }))};
  }
  // 3D. Devices first: a camera's space is its EYE, a light's its lifted position.
  std::optional<motion::xf::Mat4> m;
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
    m = motion::xf::compose(motion::xf::Parts3D{.position = position, .rotation = {}, .scale = {1, 1, 1}, .anchor = {}});
  } else {
    m = node_world_with_parents_3d(c, *n, seconds);
  }
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
  for (auto& [prop, v] : anim_evaluate_node(c.d, c.expr, c.cache, node, t)) av.insert_or_assign(prop, v);
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
    else world = motion::xf::multiply(world, lm);
  }
  return world;
}

}  // namespace premation::doc
