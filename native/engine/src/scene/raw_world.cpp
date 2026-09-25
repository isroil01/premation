#include "raw_world.hpp"

#include <cmath>
#include <limits>
#include <vector>

#include "scene.hpp"

namespace premation::scene {

namespace xf = motion::xf;

std::optional<xf::Local2D> RawWorld::local(const std::string& id) {
  const doc::Node* n = d_.node(id);
  if (n == nullptr) return std::nullopt;
  // readBase's transform half: the last component carrying each number wins.
  std::optional<double> x, y, rotation, scaleX, scaleY, scale;
  for (const doc::Component& c : n->components) {
    if (const auto v = c.props.number_at("x")) x = v;
    if (const auto v = c.props.number_at("y")) y = v;
    if (const auto v = c.props.number_at("rotation")) rotation = v;
    if (const auto v = c.props.number_at("scaleX")) scaleX = v;
    if (const auto v = c.props.number_at("scaleY")) scaleY = v;
    if (const auto v = c.props.number_at("scale")) scale = v;
  }
  const doc::ViewTransform vt = doc::view_transform(*n);
  const double bx = x.value_or(vt.x);
  const double by = y.value_or(vt.y);
  const double br = rotation.value_or(vt.rotation);
  const double bsx = scaleX ? *scaleX : scale.value_or(1);
  const double bsy = scaleY ? *scaleY : scale.value_or(1);
  const std::vector<std::pair<std::string, double>> av = doc::anim_evaluate_node(d_, expr_, cache_, id, t_);
  const auto get = [&av](std::string_view k) -> std::optional<double> {
    for (const auto& [key, v] : av) {
      if (key == k) return v;
    }
    return std::nullopt;
  };
  const auto sc = get("scale");
  xf::Local2D l;
  l.x = get("x").value_or(bx);
  l.y = get("y").value_or(by);
  l.rotation = get("rotation").value_or(br);
  l.scale_x = get("scaleX").value_or(sc.value_or(bsx));
  l.scale_y = get("scaleY").value_or(sc.value_or(bsy));
  return l;
}

std::vector<std::pair<std::string, double>> RawWorld::values(const std::string& id) {
  return doc::anim_evaluate_node(d_, expr_, cache_, id, t_);
}

Json RawWorld::path_points(const std::string& id) const {
  const doc::DataTrack* tr = doc::anim_data_track(d_, id, "path.points");
  if (tr == nullptr) return {};
  const auto v = doc::sample_data_track(*tr, t_);
  if (!v || !v->is_array() || v->arr().size() < 3 || !v->arr()[0].is_object() || !v->arr()[0].has("x")) return {};
  Json out = Json::array();
  for (const Json& p : v->arr()) {
    const Json& px = p.at("x");
    const Json& py = p.at("y");
    const auto h = [&p](const char* k, const Json& fb) { return p.at(k).is_undefined() || p.at(k).is_null() ? fb : p.at(k); };
    Json q = Json::object();
    q.set("x", px);
    q.set("y", py);
    q.set("inX", h("inX", px));
    q.set("inY", h("inY", py));
    q.set("outX", h("outX", px));
    q.set("outY", h("outY", py));
    out.arr_mut().push_back(std::move(q));
  }
  return out;
}

xf::Mat2D RawWorld::world_matrix(const std::string& nodeId) {
  if (const auto it = world_.find(nodeId); it != world_.end()) return it->second;
  std::vector<std::string> path;
  std::unordered_map<std::string, std::size_t> onPath;
  std::optional<xf::Mat2D> above;
  std::ptrdiff_t cycleFrom = -1;
  for (std::string id = nodeId;;) {
    onPath.emplace(id, path.size());
    path.push_back(id);
    const doc::Node* n = d_.node(id);
    if (n == nullptr || !n->parent) break;
    const std::string& parent = *n->parent;
    if (const auto it = world_.find(parent); it != world_.end()) {
      above = it->second;
      break;
    }
    if (const auto seen = onPath.find(parent); seen != onPath.end()) {
      cycleFrom = static_cast<std::ptrdiff_t>(seen->second);
      break;
    }
    id = parent;
  }
  xf::Mat2D world;
  for (std::ptrdiff_t i = static_cast<std::ptrdiff_t>(path.size()) - 1; i >= 0; --i) {
    const std::string& id = path[static_cast<std::size_t>(i)];
    const auto l = local(id);
    const xf::Mat2D lm = l ? xf::local_matrix(*l) : xf::Mat2D{};
    if (cycleFrom >= 0 && i >= cycleFrom) world = lm;
    else if (i == static_cast<std::ptrdiff_t>(path.size()) - 1) world = above ? xf::multiply(*above, lm) : lm;
    else world = xf::multiply(world, lm);
    world_[id] = world;
  }
  return world;
}

Json bind_path_points(RawWorld& raw, const std::string& shapeId, const Json& pathPoints, const Json& bindings) {
  if (!bindings.is_array() || bindings.arr().empty() || !pathPoints.is_array() || pathPoints.arr().empty()) return {};
  const xf::Mat2D inv = xf::invert(raw.world_matrix(shapeId));
  Json moved = pathPoints;
  Json::Array& pts = moved.arr_mut();
  bool any = false;
  const auto num = [](const Json& o, std::string_view k) {
    const Json& v = o.at(k);
    return v.is_number() ? v.num() : std::numeric_limits<double>::quiet_NaN();  // `undefined + dx` is NaN
  };
  for (const Json& b : bindings.arr()) {
    const Json& idx = b.at("index");
    const Json& nullId = b.at("nullId");
    if (!idx.is_number() || !nullId.is_string()) continue;
    const double i = idx.num();
    if (!(i >= 0) || i != std::floor(i) || i >= static_cast<double>(pts.size())) continue;
    Json& pt = pts[static_cast<std::size_t>(i)];
    if (!pt.is_object() || raw.document().node(nullId.str()) == nullptr) continue;
    const xf::Mat2D nullW = raw.world_matrix(nullId.str());
    const xf::Vec2 local = xf::transform_point(inv, {nullW.e, nullW.f});
    const double dx = local.x - num(pt, "x");
    const double dy = local.y - num(pt, "y");
    if (dx == 0 && dy == 0) continue;
    for (const char* k : {"x", "inX", "outX"}) pt.set(k, Json::number(num(pt, k) + dx));
    for (const char* k : {"y", "inY", "outY"}) pt.set(k, Json::number(num(pt, k) + dy));
    any = true;
  }
  return any ? moved : Json{};
}

}  // namespace premation::scene
