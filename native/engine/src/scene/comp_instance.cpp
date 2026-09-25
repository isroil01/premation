#include "comp_instance.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <string_view>

#include "scene.hpp"

namespace premation::scene {
namespace {

using doc::Node;

/// OVERRIDE_PROP_KINDS, in declaration order (applyOverridesToComponents walks it).
enum class OverrideKind : std::uint8_t { number, text, color };
struct OverrideProp {
  std::string_view prop;
  OverrideKind kind;
};
constexpr std::array<OverrideProp, 9> kOverridable = {{
    {"x", OverrideKind::number},
    {"y", OverrideKind::number},
    {"rotation", OverrideKind::number},
    {"scaleX", OverrideKind::number},
    {"scaleY", OverrideKind::number},
    {"opacity", OverrideKind::number},
    {"text", OverrideKind::text},
    {"fill", OverrideKind::color},
    {"color", OverrideKind::color},
}};

std::optional<OverrideKind> override_kind_of(std::string_view prop) {
  for (const OverrideProp& p : kOverridable) {
    if (p.prop == prop) return p.kind;
  }
  return std::nullopt;
}

/// isValidOverrideValue.
bool valid_override(std::string_view prop, const Json& v) {
  const auto kind = override_kind_of(prop);
  if (!kind) return false;
  if (*kind == OverrideKind::number) return v.is_number() && std::isfinite(v.num());
  return v.is_string();
}

struct ParsedKey {
  std::string_view node;
  std::string_view prop;
};
/// parseOverrideKey: split at the LAST '/'; neither half empty.
std::optional<ParsedKey> parse_override_key(std::string_view key) {
  const std::size_t i = key.rfind('/');
  if (i == std::string_view::npos || i == 0 || i == key.size() - 1) return std::nullopt;
  return ParsedKey{key.substr(0, i), key.substr(i + 1)};
}

/// overriddenPropsFor (with ANIMATED_CHANNELS: a colour is keyframed as channels).
std::set<std::string, std::less<>> overridden_props_for(const CompOverrides& o, std::string_view node) {
  std::set<std::string, std::less<>> out;
  for (const auto& [k, v] : o) {
    const auto parsed = parse_override_key(k);
    if (!parsed || parsed->node != node) continue;
    out.emplace(parsed->prop);
    if (parsed->prop == "fill") out.insert({"fill_r", "fill_g", "fill_b"});
    if (parsed->prop == "color") out.insert({"color_r", "color_g", "color_b"});
  }
  return out;
}

/// applyOverridesToComponents: each prop onto the LAST component declaring it
/// (the one readBase believes), else the Transform.
std::vector<doc::Component> apply_overrides(const std::vector<doc::Component>& comps, const CompOverrides& o,
                                            const std::string& node) {
  if (o.empty()) return comps;
  std::vector<doc::Component> out;
  bool copied = false;
  std::ptrdiff_t transformIdx = -1;
  for (std::size_t i = 0; i < comps.size(); ++i) {
    if (comps[i].type == "Transform") {
      transformIdx = static_cast<std::ptrdiff_t>(i);
      break;
    }
  }
  for (const OverrideProp& p : kOverridable) {
    const auto it = o.find(node + "/" + std::string(p.prop));
    if (it == o.end() || !valid_override(p.prop, it->second)) continue;
    std::ptrdiff_t idx = -1;
    for (std::size_t i = 0; i < comps.size(); ++i) {
      if (comps[i].props.has(p.prop)) idx = static_cast<std::ptrdiff_t>(i);
    }
    if (idx == -1) idx = transformIdx;
    if (idx == -1) continue;
    if (!copied) {
      out = comps;
      copied = true;
    }
    out[static_cast<std::size_t>(idx)].props.set(p.prop, it->second);
  }
  return copied ? out : comps;
}

class Expander {
 public:
  Expander(const doc::Document& d, WalkNodes& w) : d_(d), w_(w) {}

  const Node* push_clone(const Node& orig, const std::string& id, const std::string& parent, bool atRoot,
                         const CompOverrides& overrides) {
    auto clone = std::make_unique<Node>();
    clone->id = id;
    clone->name = orig.name;
    clone->parent = parent;
    clone->visible = orig.visible;
    clone->locked = orig.locked;
    clone->solo = false;  // solo must not leak across comps
    clone->shy = orig.shy;
    clone->color = orig.color;
    clone->components = apply_overrides(orig.components, overrides, orig.id);
    w_.source.emplace(id, orig.id);
    if (auto ov = overridden_props_for(overrides, orig.id); !ov.empty()) w_.overridden.emplace(id, std::move(ov));
    if (atRoot) w_.instanceRoots.insert(id);
    const Node* p = clone.get();
    w_.owned.push_back(std::move(clone));
    w_.nodes.push_back(p);
    return p;
  }

  /// anchorClone: centre-anchors a collapsed expansion (x = −w/2, y = −h/2).
  const Node* anchor_clone(const std::string& instanceId, const std::string& ref) {
    const auto size = comp_size_of(d_, ref);
    if (!size) return nullptr;
    auto a = std::make_unique<Node>();
    a->id = instanceId + "::__anchor";
    a->name = "__anchor";
    a->parent = instanceId;
    doc::Component t;
    t.id = a->id + "_t";
    t.type = "Transform";
    t.props.set("__kind", Json::string("group"));
    t.props.set("x", Json::number(-size->first / 2));
    t.props.set("y", Json::number(-size->second / 2));
    t.props.set("rotation", Json::number(0));
    a->components.push_back(std::move(t));
    const Node* p = a.get();
    w_.owned.push_back(std::move(a));
    w_.nodes.push_back(p);
    return p;
  }

  std::vector<const Node*> children_of(const std::string& id) const {
    std::vector<const Node*> out;
    const Node* n = d_.node(id);
    if (n == nullptr) return out;
    for (const std::string& c : n->children) {
      if (const Node* cn = d_.node(c)) out.push_back(cn);
    }
    return out;
  }

  void clone_subtree(const std::vector<const Node*>& origs, const std::string& parentId, const std::string& prefix,
                     const std::vector<std::string>& stack, std::size_t depth, bool atRoot,
                     const CompOverrides& overrides) {
    if (depth > kMaxCompDepth) return;
    for (const Node* orig : origs) {
      const std::string cid = prefix + orig->id;
      push_clone(*orig, cid, parentId, atRoot, overrides);
      if (const auto ref = doc::read_comp_ref(*orig)) {
        // A nested COLLAPSED instance expands its own reference (deeper prefix)
        // unless that re-enters an open comp; a sealed one stays a bare comp node.
        if (doc::read_comp_collapse(*orig) && std::ranges::find(stack, *ref) == stack.end() && d_.node(*ref) != nullptr) {
          const Node* anchor = anchor_clone(cid, *ref);
          std::vector<std::string> next = stack;
          next.push_back(*ref);
          clone_subtree(children_of(*ref), anchor != nullptr ? anchor->id : cid, cid + "::", next, depth + 1, false,
                        read_comp_overrides(*orig));
        }
      } else {
        clone_subtree(children_of(orig->id), cid, prefix, stack, depth, false, overrides);
      }
    }
  }

 private:
  const doc::Document& d_;
  WalkNodes& w_;
};

}  // namespace

CompOverrides read_comp_overrides(const doc::Node& n) {
  CompOverrides out;
  for (const doc::Component& c : n.components) {
    const Json& bag = c.props.at("__compOverrides");
    if (!bag.is_object()) continue;
    for (const Json::Member& m : bag.obj()) {
      const auto parsed = parse_override_key(m.key);
      if (parsed && valid_override(parsed->prop, m.value)) out.insert_or_assign(m.key, m.value);
    }
  }
  return out;
}

std::optional<std::pair<double, double>> comp_size_of(const doc::Document& d, std::string_view ref) {
  const Json* rec = d.comp(ref);
  if (rec == nullptr) return std::nullopt;
  const Json& w = rec->at("width");
  const Json& h = rec->at("height");
  if (!w.is_number() || !h.is_number()) return std::nullopt;
  return std::pair<double, double>{w.num(), h.num()};
}

WalkNodes expand_walk_nodes(const doc::Document& d, const std::vector<const doc::Node*>& flat,
                            const std::string& activeRoot, const CompOverrides& own) {
  WalkNodes w;
  const bool anyInstance = std::ranges::any_of(flat, [](const Node* n) { return doc::read_comp_ref(*n).has_value(); });
  if (!anyInstance) {
    w.nodes = flat;
  } else {
    Expander ex(d, w);
    for (const Node* n : flat) {
      w.nodes.push_back(n);
      const auto ref = doc::read_comp_ref(*n);
      if (!ref || !doc::read_comp_collapse(*n)) continue;  // sealed: rendered by its own pass
      if (*ref == activeRoot || d.node(*ref) == nullptr) continue;
      const std::vector<std::string> stack = activeRoot.empty() ? std::vector<std::string>{*ref}
                                                                : std::vector<std::string>{activeRoot, *ref};
      const Node* anchor = ex.anchor_clone(n->id, *ref);
      ex.clone_subtree(ex.children_of(*ref), anchor != nullptr ? anchor->id : n->id, n->id + "::", stack, 1, false,
                       read_comp_overrides(*n));
    }
  }
  // applyOwnOverrides: the sealed pass's overrides, keyed by the walked node's own id.
  if (!own.empty()) {
    for (const Node*& n : w.nodes) {
      auto ov = overridden_props_for(own, n->id);
      if (ov.empty()) continue;
      auto copy = std::make_unique<Node>(*n);
      copy->components = apply_overrides(n->components, own, n->id);
      w.overridden.insert_or_assign(n->id, std::move(ov));
      n = copy.get();
      w.owned.push_back(std::move(copy));
    }
  }
  return w;
}

void prefix_layer_ids(std::vector<RLayer>& layers, const std::string& prefix) {
  for (RLayer& l : layers) {
    l.id = prefix + l.id;
    if (l.matteSourceId) l.matteSourceId = prefix + *l.matteSourceId;
    if (l.precompLayers) prefix_layer_ids(*l.precompLayers, prefix);
  }
}

std::optional<NestedComp> nested_comp_layers(const BuildContext& c, const SnapshotComp& host, double hostFps,
                                             const doc::Node& instance, const std::string& ref, double nestedTime,
                                             const std::optional<MotionBlurCfg>& motionBlur) {
  const std::vector<std::string>& stack = host.compStack;
  if (std::ranges::find(stack, ref) != stack.end() || stack.size() >= kMaxCompDepth) return std::nullopt;
  if (c.d.node(ref) == nullptr) return std::nullopt;
  SnapshotComp nested = host;
  if (const auto size = comp_size_of(c.d, ref)) {
    nested.width = size->first;
    nested.height = size->second;
  }
  nested.rootId = ref;
  nested.compOverrides = read_comp_overrides(instance);
  nested.transparent = true;  // content, not a backdrop
  nested.camera3dMode = "active";
  nested.customViewCamera = std::nullopt;
  nested.compStack = stack;
  nested.compStack.push_back(ref);
  nested.fps = hostFps;
  Snapshot s = build_snapshot(c, nested, nestedTime, motionBlur);
  NestedComp out;
  const std::string prefix = instance.id + "::";
  for (LayerError& e : s.layerErrors) {
    e.layerId = prefix + e.layerId;
    out.errors.push_back(std::move(e));
  }
  if (s.camera3d) {
    PrecompScene3D p;
    p.camera3d = std::move(*s.camera3d);
    p.lights3d = std::move(s.lights3d);
    p.envMap = std::move(s.envMap);
    out.scene3d = std::move(p);
  }
  out.layers = std::move(s.layers);
  prefix_layer_ids(out.layers, prefix);
  return out;
}

Json instance_frame_mask(const Json& authored, const std::string& id, double w, double h) {
  const bool hasAuthored = authored.is_object() && authored.at("paths").is_array() && !authored.at("paths").arr().empty();
  Json path = Json::object();
  path.set("id", Json::string(id + "::frame"));
  path.set("mode", Json::string(hasAuthored ? "intersect" : "add"));
  path.set("closed", Json::boolean(true));
  path.set("feather", Json::number(0));
  path.set("opacity", Json::number(1));
  path.set("expansion", Json::number(0));
  path.set("inverted", Json::boolean(false));
  Json pts = Json::array();
  const std::array<std::array<double, 2>, 4> corners = {{{-w / 2, -h / 2}, {w / 2, -h / 2}, {w / 2, h / 2}, {-w / 2, h / 2}}};
  for (const auto& [x, y] : corners) {
    Json q = Json::object();  // key order as the TypeScript literal (x, y, inX, inY, outX, outY)
    q.set("x", Json::number(x));
    q.set("y", Json::number(y));
    q.set("inX", Json::number(x));
    q.set("inY", Json::number(y));
    q.set("outX", Json::number(x));
    q.set("outY", Json::number(y));
    pts.arr_mut().push_back(std::move(q));
  }
  path.set("points", std::move(pts));
  Json paths = Json::array();
  if (hasAuthored) {
    for (const Json& p : authored.at("paths").arr()) paths.arr_mut().push_back(p);
  }
  paths.arr_mut().push_back(std::move(path));
  Json out = Json::object();  // `{ paths: [...authored.paths, frame] }`
  out.set("paths", std::move(paths));
  return out;
}

std::vector<MotionSample> instance_world_samples(const std::vector<MotionSample>& local, const LocalPose& now,
                                                 const motion::xf::Local2D& world) {
  const auto ratio = [](double v, double of) { return of != 0 ? v / of : 1.0; };
  std::vector<MotionSample> out;
  out.reserve(local.size());
  for (const MotionSample& s : local) {
    MotionSample o = s;
    o.x = world.x + (s.x - now.x);
    o.y = world.y + (s.y - now.y);
    o.rotation = world.rotation + (s.rotation - now.rotation);
    o.scaleX = world.scale_x * ratio(s.scaleX, now.scaleX);
    o.scaleY = world.scale_y * ratio(s.scaleY, now.scaleY);
    out.push_back(o);
  }
  return out;
}

}  // namespace premation::scene
