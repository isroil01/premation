#include "worldxf.hpp"

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
