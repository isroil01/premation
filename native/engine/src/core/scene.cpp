#include "scene.hpp"

#include <algorithm>
#include <map>
#include <set>
#include <utility>

namespace premation::doc {
namespace {

constexpr std::string_view kCompRoot = "comp_root";

std::string kind_of_plain(const Node& n) {
  for (const auto& c : n.components) {
    const Json* k = c.props.find("__kind");
    if (k != nullptr && k->is_string()) return k->str();
  }
  return "group";
}

using LocalFn = std::optional<motion::xf::Local2D> (*)(const Document&, std::string_view);

std::optional<motion::xf::Local2D> sg_local_of(const Document& d, std::string_view id) {
  const Node* n = d.node(id);
  if (n == nullptr) return std::nullopt;
  return base_local(*n);
}

std::optional<std::string> sg_parent_of(const Document& d, std::string_view id) {
  const Node* n = d.node(id);
  if (n == nullptr || !n->parent || *n->parent == kCompRoot) return std::nullopt;
  return n->parent;
}

/// worldTransform.ts `worldMatrixOf` (iterative, cycle rule), for SceneGraph's
/// static-base reader.
motion::xf::Mat2D world_matrix_static(const Document& d, const std::string& nodeId) {
  std::vector<std::string> path;
  std::map<std::string, std::size_t, std::less<>> onPath;
  std::ptrdiff_t cycleFrom = -1;
  for (std::string id = nodeId;;) {
    onPath.emplace(id, path.size());
    path.push_back(id);
    const auto parent = sg_parent_of(d, id);
    if (!parent) break;
    const auto seen = onPath.find(*parent);
    if (seen != onPath.end()) {
      cycleFrom = static_cast<std::ptrdiff_t>(seen->second);
      break;
    }
    id = *parent;
  }
  motion::xf::Mat2D world;
  for (std::size_t k = path.size(); k-- > 0;) {
    const auto local = sg_local_of(d, path[k]);
    const motion::xf::Mat2D lm = local ? motion::xf::local_matrix(*local) : motion::xf::Mat2D{};
    if (cycleFrom >= 0 && static_cast<std::ptrdiff_t>(k) >= cycleFrom) {
      world = lm;
    } else if (k == path.size() - 1) {
      world = lm;
    } else {
      world = motion::xf::multiply(world, lm);
    }
  }
  return world;
}

}  // namespace

std::string engine_type_of_kind(std::string_view kind) {
  static const std::map<std::string, std::string, std::less<>> kMap = {
      {"group", "group"}, {"null", "group"},   {"shape", "rectangle"},  {"text", "text"},
      {"image", "image"}, {"video", "video"},  {"svg", "image"},        {"camera", "group"},
      {"light", "group"}, {"adjustment", "rectangle"}, {"particle", "rectangle"},
  };
  const auto it = kMap.find(kind);
  return it != kMap.end() ? it->second : "null";
}

void sg_add_node(Document& d, Node n) {
  if (d.node(n.id) != nullptr) return;
  if (n.name.empty()) n.name = engine_type_of_kind(kind_of_plain(n));
  d.add_node(std::move(n));
}

void sg_add_child(Document& d, const std::string& parentId, Node n) {
  const std::string id = n.id;
  n.parent = parentId;
  if (d.node(id) == nullptr) sg_add_node(d, std::move(n));
  if (d.node(parentId) != nullptr) {
    const Node& p = *d.node(parentId);
    if (std::find(p.children.begin(), p.children.end(), id) == p.children.end()) {
      d.node_mut(parentId).children.push_back(id);
    }
  }
  if (d.node(id) != nullptr && d.node(id)->parent != parentId) d.node_mut(id).parent = parentId;
}

void sg_remove_node(Document& d, std::string_view id) {
  const Node* n = d.node(id);
  if (n == nullptr) return;
  if (n->parent && d.node(*n->parent) != nullptr) {
    const std::string me(id);
    auto kids = d.node(*n->parent)->children;
    const auto it = std::find(kids.begin(), kids.end(), me);
    if (it != kids.end()) {
      kids.erase(it);
      d.node_mut(*n->parent).children = std::move(kids);
    }
  }
  const std::vector<std::string> children = d.node(id)->children;
  for (const auto& c : children) sg_remove_node(d, c);
  d.remove_node_only(id);
}

std::vector<std::string> sg_child_order(const Document& d, std::string_view id) {
  const Node* n = d.node(id);
  return n != nullptr ? n->children : std::vector<std::string>{};
}

bool sg_set_child_order(Document& d, std::string_view id, const std::vector<std::string>& next) {
  const Node* n = d.node(id);
  if (n == nullptr) return false;
  if (next.size() != n->children.size()) return false;
  std::multiset<std::string, std::less<>> have(n->children.begin(), n->children.end());
  for (const auto& c : next) {
    const auto it = have.find(c);
    if (it == have.end()) return false;
    have.erase(it);
  }
  if (n->children != next) d.node_mut(id).children = next;
  return true;
}

void sg_set_parent(Document& d, const std::string& childId, const std::optional<std::string>& newParentId,
                   bool preserveWorld) {
  const Node* ce = d.node(childId);
  if (ce == nullptr) return;
  const std::optional<std::string> oldParentId = ce->parent;
  const std::optional<std::string> targetId =
      newParentId && *newParentId != kCompRoot ? newParentId : std::optional<std::string>();
  if (oldParentId == targetId || oldParentId == newParentId) return;

  std::optional<motion::xf::Mat2D> childWorld;
  if (preserveWorld) childWorld = world_matrix_static(d, childId);

  if (oldParentId && d.node(*oldParentId) != nullptr) {
    auto kids = d.node(*oldParentId)->children;
    const auto it = std::find(kids.begin(), kids.end(), childId);
    if (it != kids.end()) {
      kids.erase(std::remove(kids.begin(), kids.end(), childId), kids.end());
      d.node_mut(*oldParentId).children = std::move(kids);
    }
  }
  d.node_mut(childId).parent = newParentId;
  if (newParentId && d.node(*newParentId) != nullptr) {
    const Node& p = *d.node(*newParentId);
    if (std::find(p.children.begin(), p.children.end(), childId) == p.children.end()) {
      d.node_mut(*newParentId).children.push_back(childId);
    }
  }
  if (preserveWorld && childWorld) {
    const motion::xf::Mat2D parentWorld = targetId ? world_matrix_static(d, *targetId) : motion::xf::Mat2D{};
    const motion::xf::Local2D l = motion::xf::local_under_parent(*childWorld, parentWorld);
    sg_set_local_transform(d, childId, l.x, l.y, l.rotation, l.scale_x, l.scale_y);
  }
}

bool sg_write_prop(Document& d, std::string_view nodeId, std::string_view componentId, std::string_view prop,
                   Json value) {
  const Node* n = d.node(nodeId);
  if (n == nullptr || n->comp_by_id(componentId) == nullptr) return false;
  for (auto& c : d.node_mut(nodeId).components) {
    if (c.id == componentId) {
      c.props.set(prop, std::move(value));
      return true;
    }
  }
  return false;
}

void sg_set_fx(Document& d, std::string_view nodeId, std::string_view key, Json value) {
  if (d.node(nodeId) == nullptr) return;
  Node& n = d.node_mut(nodeId);
  Component* fx = n.comp_mut("fx");
  if (fx == nullptr) {
    n.components.push_back(Component{std::string(nodeId) + "_fx", "fx", Json::object()});
    fx = &n.components.back();
  }
  fx->props.set(key, std::move(value));
}

bool sg_add_component(Document& d, std::string_view nodeId, Component c) {
  if (d.node(nodeId) == nullptr) return false;
  Node& n = d.node_mut(nodeId);
  std::erase_if(n.components, [&c](const Component& x) { return x.type == c.type; });
  n.components.push_back(std::move(c));
  return true;
}

bool sg_remove_component(Document& d, std::string_view nodeId, std::string_view type) {
  const Node* n = d.node(nodeId);
  if (n == nullptr || n->comp(type) == nullptr) return false;
  std::erase_if(d.node_mut(nodeId).components, [type](const Component& x) { return x.type == type; });
  return true;
}

void sg_set_local_transform(Document& d, std::string_view nodeId, double x, double y, double rotation,
                            std::optional<double> scaleX, std::optional<double> scaleY) {
  const Node* n = d.node(nodeId);
  if (n == nullptr) return;
  const Component* target = n->comp_with_number("x");
  if (target == nullptr) return;
  const std::string cid = target->id;
  sg_write_prop(d, nodeId, cid, "x", Json::number(x));
  sg_write_prop(d, nodeId, cid, "y", Json::number(y));
  sg_write_prop(d, nodeId, cid, "rotation", Json::number(rotation));
  if (scaleX) sg_write_prop(d, nodeId, cid, "scaleX", Json::number(*scaleX));
  if (scaleY) sg_write_prop(d, nodeId, cid, "scaleY", Json::number(*scaleY));
}

void sg_set_separate_dimensions(Document& d, std::string_view nodeId, bool on) {
  const Node* n = d.node(nodeId);
  if (n == nullptr) return;
  const Component* target = n->comp_with_number("x");
  if (target == nullptr) return;
  sg_write_prop(d, nodeId, target->id, "separateDimensions", Json::boolean(on));
}

ViewTransform view_transform(const Node& n) {
  ViewTransform t;
  for (const auto& c : n.components) {
    if (const auto v = c.props.number_at("x")) t.x = *v;
    if (const auto v = c.props.number_at("y")) t.y = *v;
    if (const auto v = c.props.number_at("rotation")) t.rotation = *v;
  }
  return t;
}

motion::xf::Local2D base_local(const Node& n) {
  double scaleX = 1;
  double scaleY = 1;
  for (const auto& c : n.components) {
    if (const auto v = c.props.number_at("scaleX")) scaleX = *v;
    if (const auto v = c.props.number_at("scaleY")) scaleY = *v;
  }
  const ViewTransform t = view_transform(n);
  return motion::xf::Local2D{t.x, t.y, t.rotation, scaleX, scaleY};
}

std::optional<std::string> read_shape_type(const Node& n) {
  for (const auto& c : n.components) {
    if (auto s = c.props.string_at("shapeType")) return s;
  }
  return std::nullopt;
}

bool is_solid_node(const Node& n) {
  for (const auto& c : n.components) {
    if (c.type == "fx" && c.props.at("solid").is_bool() && c.props.at("solid").b()) return true;
  }
  return false;
}

bool is_precomp(const Node& n) {
  const Component* fx = n.comp("fx");
  return fx != nullptr && fx->props.at("precomp").is_bool() && fx->props.at("precomp").b();
}

std::optional<std::string> read_comp_ref(const Node& n) {
  for (const auto& c : n.components) {
    const Json& v = c.props.at("__compRef");
    if (v.is_string() && !v.str().empty()) return v.str();
  }
  return std::nullopt;
}

bool read_comp_collapse(const Node& n) {
  if (!read_comp_ref(n)) return false;
  for (const auto& c : n.components) {
    const Json& v = c.props.at("collapseTransforms");
    if (v.is_bool() && v.b()) return true;
  }
  return false;
}

const Json& transform_props(const Node& n) {
  static const Json kEmpty = Json::object();
  const Component* t = n.comp("Transform");
  return t != nullptr ? t->props : kEmpty;
}

bool is_3d_enabled(const Node& n) {
  const Component* t = n.comp("Transform");
  if (t == nullptr) return false;
  for (const char* p : {"z", "rotationX", "rotationY"}) {
    if (t->props.at(p).is_number()) return true;
  }
  return false;
}

bool can_be_3d(const Node& n) {
  if (n.comp("Transform") == nullptr) return false;
  const std::string kind = n.kind();
  if (kind == "comp") {
    const Json& fx = n.fx();
    const Json& ref = fx.at("__compRef");
    const Json& col = fx.at("collapseTransforms");
    return ref.is_string() && !ref.str().empty() && !(col.is_bool() && col.b());
  }
  return kind == "shape" || kind == "text" || kind == "image" || kind == "video" || kind == "null" || kind == "svg";
}

// ── doc.ts ───────────────────────────────────────────────────────────────

bool is_comp_item(const Document& d, std::string_view id) {
  if (d.comp(id) == nullptr) return false;
  const Node* n = d.node(id);
  if (n == nullptr) return false;
  return !n->parent || (is_precomp(*n) && !n->children.empty() && !read_comp_ref(*n));
}

std::vector<std::string> comp_item_ids(const Document& d) {
  std::vector<std::string> out;
  for (const auto& [id, rec] : d.comps()) {
    if (is_comp_item(d, id)) out.push_back(id);
  }
  return out;
}

std::optional<std::string> enclosing_comp_root_of(const Document& d, std::string_view id) {
  const Node* start = d.node(id);
  if (start == nullptr) return std::nullopt;
  const Node* cur = start->parent ? d.node(*start->parent) : nullptr;
  std::set<std::string, std::less<>> seen{start->id};
  while (cur != nullptr) {
    if (is_precomp(*cur) || !cur->parent) return cur->id;
    if (seen.contains(cur->id)) break;
    seen.insert(cur->id);
    cur = d.node(*cur->parent);
  }
  return start->parent;
}

std::optional<std::string> comp_of_layer(const Document& d, std::string_view id) {
  const Node* n = d.node(id);
  if (n == nullptr || !n->parent) return std::nullopt;
  return enclosing_comp_root_of(d, id);
}

std::vector<std::string> layer_ids_of_comp(const Document& d, std::string_view comp) {
  std::vector<std::string> out;
  // Explicit stack (a deep chain must not overflow): children back→front,
  // visited front-most first, a parent before its children.
  struct Frame {
    const Node* node;
    std::size_t next;  // index from the END of children
  };
  const Node* root = d.node(comp);
  if (root == nullptr) return out;
  std::vector<Frame> stack{{root, 0}};
  std::set<std::string, std::less<>> guard;
  while (!stack.empty()) {
    Frame& f = stack.back();
    if (f.next >= f.node->children.size()) {
      stack.pop_back();
      continue;
    }
    const std::string& id = f.node->children[f.node->children.size() - 1 - f.next];
    ++f.next;
    const Node* n = d.node(id);
    if (n == nullptr) continue;
    out.push_back(id);
    if (!is_precomp(*n) && guard.insert(id).second) stack.push_back({n, 0});
  }
  return out;
}

std::optional<std::string> api_parent_of(const Document& d, std::string_view id) {
  const Node* n = d.node(id);
  if (n == nullptr || !n->parent) return std::nullopt;
  const auto comp = comp_of_layer(d, id);
  if (comp && *n->parent == *comp) return std::nullopt;
  return n->parent;
}

api::LayerKind layer_kind_of(const Node& n) {
  using K = api::LayerKind;
  if (read_comp_ref(n)) return K::precomp;
  const std::string kind = n.kind();
  if (kind == "comp") return K::precomp;
  if (kind == "group") return is_precomp(n) ? K::precomp : K::group;
  if (kind == "null") return K::null;
  if (kind == "text") return K::text;
  if (kind == "video") return K::video;
  if (kind == "audio") return K::audio;
  if (kind == "svg") return K::svg;
  if (kind == "camera") return K::camera;
  if (kind == "light") return K::light;
  if (kind == "adjustment") return K::adjustment;
  if (kind == "particle") return K::particle;
  if (kind == "image") {
    const Json& seq = n.fx().at("sequence");
    const bool truthy = !(seq.is_undefined() || seq.is_null() || (seq.is_bool() && !seq.b()) ||
                          (seq.is_number() && (seq.num() == 0 || seq.num() != seq.num())) ||
                          (seq.is_string() && seq.str().empty()));
    return truthy ? K::sequence : K::image;
  }
  if (is_solid_node(n)) return K::solid;
  for (const auto& c : n.components) {
    if (c.type == "Primitive" || c.type == "Model") return K::model3d;
  }
  for (const auto& c : n.components) {
    if (c.type == "plugin" || c.type == "PluginLayer") return K::generator;
  }
  const auto st = read_shape_type(n);
  if (st) {
    if (*st == "rect") return K::rectangle;
    if (*st == "ellipse") return K::ellipse;
    if (*st == "polygon" || *st == "star" || *st == "triangle") return K::polygon;
  }
  if (n.comp("Geometry") != nullptr) return K::path;
  return K::shape;
}

std::optional<std::string> layer_source_of(const Node& n) {
  if (auto r = read_comp_ref(n)) return r;
  for (const auto& c : n.components) {
    const Json& a = c.props.at("assetId");
    if (a.is_string() && !a.str().empty()) return a.str();
    const Json& b = c.props.at("__assetId");
    if (b.is_string() && !b.str().empty()) return b.str();
  }
  return std::nullopt;
}

const Json* find_asset(const Document& d, std::string_view id) {
  for (const auto& a : d.items().assets) {
    if (a.at("id").is_string() && a.at("id").str() == id) return &a;
  }
  return nullptr;
}

const Folder* find_folder(const Document& d, std::string_view id) {
  for (const auto& f : d.items().folders) {
    if (f.id == id) return &f;
  }
  return nullptr;
}

bool id_taken(const Document& d, std::string_view id) {
  return d.node(id) != nullptr || d.comp(id) != nullptr || find_asset(d, id) != nullptr ||
         find_folder(d, id) != nullptr;
}

std::vector<std::string> layers_using_item(const Document& d, std::string_view item) {
  std::vector<std::string> out;
  for (const auto& [id, n] : d.nodes()) {
    if (!n->parent) continue;
    const auto src = layer_source_of(*n);
    if (src && *src == item) out.push_back(id);
  }
  return out;
}

std::optional<ItemRef> resolve_item(const Document& d, std::string_view id) {
  if (is_comp_item(d, id)) return ItemRef{ItemRefKind::composition, std::string(id)};
  if (find_asset(d, id) != nullptr) return ItemRef{ItemRefKind::footage, std::string(id)};
  if (find_folder(d, id) != nullptr) return ItemRef{ItemRefKind::folder, std::string(id)};
  return std::nullopt;
}

bool is_descendant(const Document& d, std::string_view ancestor, std::string_view nodeId) {
  const Node* n = d.node(nodeId);
  std::optional<std::string> p = n != nullptr ? n->parent : std::nullopt;
  std::set<std::string, std::less<>> seen;
  while (p) {
    if (*p == ancestor) return true;
    if (!seen.insert(*p).second) return false;
    const Node* pn = d.node(*p);
    p = pn != nullptr ? pn->parent : std::nullopt;
  }
  return false;
}

}  // namespace premation::doc
