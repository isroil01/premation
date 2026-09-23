#include "handlers_optional.hpp"

#include <set>

#include "catalog_data.hpp"
#include "fields.hpp"
#include "fxstate.hpp"
#include "rig.hpp"
#include "scene.hpp"
#include "strutil.hpp"

namespace premation::doc {
namespace {

using api::ErrorCode;

/// fontAxes.ts MAX_ANIMATED_AXES: AE's per-layer limit on animated font axes.
constexpr std::size_t kMaxAnimatedAxes = 8;

struct Optional {
  enum class Kind : std::uint8_t { number, color, axis };
  Kind kind = Kind::number;
  std::string name;
  Json value;       ///< the number / colour Add ▸ Property stores
  std::string tag;  ///< axis tag
};

/// optionalProps.ts `optionalOf(name)`.
std::optional<Optional> optional_of(std::string_view name) {
  for (const Json& o : registry().animators.at("optional").arr()) {
    if (o.at("param").is_string() && o.at("param").str() == name) {
      return Optional{Optional::Kind::number, std::string(name), o.at("defaultValue"), {}};
    }
  }
  for (const Json& o : registry().fields.at("animatorOptional").arr()) {
    if (o.at("key").is_string() && o.at("key").str() == name) {
      return Optional{Optional::Kind::color, std::string(name), o.at("default"), {}};
    }
  }
  if (name.size() > 4 && name.starts_with("axis") && is_axis_tag(name.substr(4))) {
    return Optional{Optional::Kind::axis, std::string(name), Json(), std::string(name.substr(4))};
  }
  return std::nullopt;
}

struct AnimatorAt {
  std::size_t index = 0;
  std::vector<Json> data;
};

/// optionalProps.ts `animatorOf(layer, path)`.
AnimatorAt animator_of(const Document& d, const std::string& layer, const std::string& path) {
  const std::vector<std::string> seg = split(path, '/');
  if (!(seg.size() == 4 && seg[0] == "text" && seg[1] == "animators" && seg[3] == "props")) {
    fail(ErrorCode::unsupported, "'" + path + "' has no optional properties in this engine (text/animators/<id>/props has)",
         {.layer = layer, .path = path});
  }
  const Node& node = *d.node(layer);
  if (node.comp("Text") == nullptr) fail(ErrorCode::not_found, "layer '" + layer + "' is not a text layer", {.layer = layer, .path = path});
  AnimatorAt out;
  out.data = read_animator_data(node);
  for (std::size_t i = 0; i < out.data.size(); ++i) {
    const Json& id = out.data[i].at("id");
    if (id.is_string() && id.str() == seg[2]) {
      out.index = i;
      return out;
    }
  }
  fail(ErrorCode::not_found, "no animator '" + seg[2] + "'", {.layer = layer, .path = path});
}

bool present(const Json& a, const Optional& o) {
  if (o.kind == Optional::Kind::axis) {
    const Json& axes = a.at("axes");
    return axes.is_object() && axes.has(o.tag);
  }
  return !a.at(o.name).is_undefined();
}

/// textAnimators.ts `removeAnimatorProperty(node, index, param)`.
void remove_animator_property(Document& d, std::string_view layer, std::size_t index, const std::string& param) {
  std::vector<Json> data = read_animator_data(*d.node(layer));
  if (index >= data.size()) return;
  Json next = data[index];
  if (auto tag = axis_tag_of_param(param)) {
    Json axes = data[index].at("axes").is_object() ? data[index].at("axes") : Json::object();
    axes.erase(*tag);
    const bool empty = axes.obj().empty();
    next.set("axes", empty ? Json() : std::move(axes));
  } else {
    next.erase(param);
  }
  data[index] = normalize_animator(next);
  write_animators(d, layer, std::move(data));
}

}  // namespace

ResultOf<api::AddProperties> handle(const api::AddProperties& c, HCtx& x) {
  Document& d = x.d;
  const std::string layer = c.parent.layer;
  (void)require_layer(d, layer);
  if (c.names.empty()) fail(ErrorCode::invalid_argument, "no property names given", {.layer = layer, .path = c.parent.path});
  if (ik_parent_of(c.parent.path)) {
    // An IK goal's optional Pole (rig.hpp).
    const auto run = plan_ik_add_properties(d, layer, c.parent.path, c.names);
    x.label = "Add Property";
    run();
    api::PropertyPaths out;
    for (const auto& n : c.names) out.paths.push_back(c.parent.path + "/" + n);
    return out;
  }
  const AnimatorAt at = animator_of(d, layer, c.parent.path);
  const Node& node = *d.node(layer);
  const Json cur = at.data[at.index];
  std::vector<Optional> opts;
  for (const auto& name : c.names) {
    auto o = optional_of(name);
    if (!o) {
      fail(ErrorCode::invalid_argument, "'" + name + "' is not an optional property of a text animator",
           {.layer = layer, .path = c.parent.path + "/" + name});
    }
    if (o->name == "anchorZ" && !is_3d_enabled(node)) {
      fail(ErrorCode::invalid_argument, "'anchorZ' needs a 3D layer (per-character 3D)", {.layer = layer, .path = c.parent.path + "/" + name});
    }
    opts.push_back(std::move(*o));
  }
  std::set<std::string> used;
  for (const Json& a : at.data) {
    if (a.at("axes").is_object()) {
      for (const auto& m : a.at("axes").obj()) used.insert(m.key);
    }
  }
  for (const auto& o : opts) {
    if (o.kind == Optional::Kind::axis) used.insert(o.tag);
  }
  if (used.size() > kMaxAnimatedAxes) {
    fail(ErrorCode::out_of_range, "a text layer's animators can drive at most 8 font axes", {.layer = layer, .path = c.parent.path});
  }
  Json patch = Json::object();
  std::optional<Json> axes;
  for (const auto& o : opts) {
    if (present(cur, o) || patch.has(o.name) || (o.kind == Optional::Kind::axis && axes && axes->has(o.tag))) continue;
    if (o.kind == Optional::Kind::axis) {
      Json next = axes ? *axes : (cur.at("axes").is_object() ? cur.at("axes") : Json::object());
      next.set(o.tag, Json::number(0));
      axes = next;
      patch.set("axes", std::move(next));
    } else {
      patch.set(o.name, o.value);
    }
  }
  x.label = opts.size() == 1 ? "Add Property" : "Add Properties";
  if (!patch.obj().empty()) update_animator(d, layer, at.index, patch);
  api::PropertyPaths out;
  for (const auto& n : c.names) out.paths.push_back(c.parent.path + "/" + n);
  return out;
}

ResultOf<api::RemoveProperties> handle(const api::RemoveProperties& c, HCtx& x) {
  Document& d = x.d;
  if (c.props.empty()) fail(ErrorCode::invalid_argument, "no properties given");
  struct Plan {
    std::string layer;
    std::string animatorId;
    Optional o;
  };
  std::vector<Plan> plans;
  std::vector<IkRemovePlan> rigRuns;
  for (const auto& p : c.props) {
    (void)require_layer(d, p.layer);
    if (auto ik = plan_ik_remove_property(d, p.layer, p.path)) {
      bool seen = false;
      for (const auto& r : rigRuns) seen = seen || r.key == ik->key;
      if (!seen) rigRuns.push_back(std::move(*ik));
      continue;
    }
    const std::size_t slash = p.path.rfind('/');
    const std::string parent = slash == std::string::npos ? std::string() : p.path.substr(0, slash);
    const std::string name = slash == std::string::npos ? p.path : p.path.substr(slash + 1);
    const AnimatorAt at = animator_of(d, p.layer, parent);
    auto o = optional_of(name);
    if (!o) {
      fail(ErrorCode::invalid_argument, "'" + p.path + "' is not an optional property (it cannot be removed)",
           {.layer = p.layer, .path = p.path});
    }
    const Json& a = at.data[at.index];
    if (!present(a, *o)) {
      fail(ErrorCode::not_found, "layer '" + p.layer + "' has no property '" + p.path + "'", {.layer = p.layer, .path = p.path});
    }
    const std::string aid = a.at("id").str();
    bool dup = false;
    for (const auto& q : plans) dup = dup || (q.layer == p.layer && q.animatorId == aid && q.o.name == o->name);
    if (dup) continue;
    plans.push_back(Plan{p.layer, aid, std::move(*o)});
  }
  x.label = plans.size() + rigRuns.size() == 1 ? "Remove Property" : "Remove Properties";
  for (const auto& r : rigRuns) r.run();
  for (const auto& plan : plans) {
    const std::vector<Json> data = read_animator_data(*d.node(plan.layer));
    std::size_t index = 0;
    for (std::size_t i = 0; i < data.size(); ++i) {
      if (data[i].at("id").is_string() && data[i].at("id").str() == plan.animatorId) index = i;
    }
    // AE: a deleted property takes its keyframes and expression with it.
    const std::string track = plan.o.kind == Optional::Kind::axis ? animator_axis_prop_path(index, plan.o.tag)
                                                                   : animator_prop_path(index, plan.o.name);
    drop_track_props(d, plan.layer, {track});
    remove_animator_property(d, plan.layer, index, plan.o.name);
  }
  return {};
}

}  // namespace premation::doc
