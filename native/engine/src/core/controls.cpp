#include "controls.hpp"

#include <algorithm>
#include <set>

#include "catalog_data.hpp"

namespace premation::doc {

namespace {

api::ValueType value_type_of(std::string_view t) {
  if (t == "vec2") return api::ValueType::vec2;
  if (t == "color") return api::ValueType::color;
  return api::ValueType::scalar;
}

std::vector<ControlSpec> parse_specs() {
  std::vector<ControlSpec> out;
  for (const Json& s : registry().fields.at("control").arr()) {
    ControlSpec c;
    c.kind = s.at("kind").str();
    c.matchName = s.at("matchName").str();
    c.label = s.at("label").str();
    c.displayName = s.at("displayName").str();
    c.param = s.at("param").str();
    c.propName = s.at("propName").str();
    c.propMatchName = s.at("propMatchName").str();
    c.valueType = value_type_of(s.at("valueType").str());
    for (const Json& x : s.at("components").arr()) c.components.push_back(x.str());
    for (const Json& x : s.at("defaults").arr()) c.defaults.push_back(x.num());
    c.unit = s.at("unit").str();
    out.push_back(std::move(c));
  }
  return out;
}

/// controlSpecForMarker: the kind a stored marker names ('slider' when unknown).
const ControlSpec& spec_for_marker(const std::string& kind) {
  for (const ControlSpec& s : control_specs()) {
    if (s.kind == kind) return s;
  }
  return control_specs().front();
}

}  // namespace

const std::vector<ControlSpec>& control_specs() {
  static const std::vector<ControlSpec> kSpecs = parse_specs();
  return kSpecs;
}

const ControlSpec* control_spec_for_match_name(std::string_view matchName) {
  for (const ControlSpec& s : control_specs()) {
    if (s.matchName == matchName) return &s;
  }
  return nullptr;
}

std::vector<LayerControl> read_controls(const Node& node) {
  const Component* t = node.comp("Transform");
  if (t == nullptr || !t->props.is_object()) return {};
  std::vector<LayerControl> kinds;
  for (const auto& m : t->props.obj()) {
    if (m.key.starts_with(kControlKindPrefix) && m.value.is_string()) {
      kinds.push_back({m.key.substr(kControlKindPrefix.size()), &spec_for_marker(m.value.str())});
    }
  }
  std::vector<LayerControl> out;
  std::set<std::string, std::less<>> seen;
  for (const auto& m : t->props.obj()) {
    if (!m.key.starts_with(kControlPrefix) || !m.value.is_number()) continue;
    const std::string s = m.key.substr(kControlPrefix.size());
    std::optional<LayerControl> owner;
    for (const LayerControl& k : kinds) {
      const bool owns = std::any_of(k.spec->components.begin(), k.spec->components.end(),
                                    [&](const std::string& sfx) { return k.name + sfx == s; });
      if (owns) {
        owner = k;
        break;
      }
    }
    if (!owner) {
      if (std::any_of(kinds.begin(), kinds.end(), [&](const LayerControl& k) { return k.name == s; })) continue;
      owner = LayerControl{s, &control_specs().front()};
    }
    if (owner->name.empty() || owner->name.find('/') != std::string::npos || seen.contains(owner->name)) continue;
    seen.insert(owner->name);
    out.push_back(std::move(*owner));
  }
  return out;
}

std::vector<std::string> control_members(const LayerControl& c) {
  std::vector<std::string> out;
  out.reserve(c.spec->components.size());
  for (const std::string& sfx : c.spec->components) out.push_back(std::string(kControlPrefix) + c.name + sfx);
  return out;
}

std::string control_group_path(std::string_view name) { return "effects/" + std::string(kControlPrefix) + std::string(name); }

std::vector<PropBinding> control_bindings(const Node& node) {
  std::vector<PropBinding> out;
  for (const LayerControl& c : read_controls(node)) {
    PropBinding b;
    b.path = control_group_path(c.name) + "/" + c.spec->param;
    b.name = c.spec->propName;
    b.matchName = c.spec->propMatchName;
    b.valueType = c.spec->valueType;
    b.members = control_members(c);
    b.animatable = true;
    b.unit = c.spec->unit;
    out.push_back(std::move(b));
  }
  return out;
}

std::optional<LayerControl> resolve_control(const Node& node, const std::string& path) {
  constexpr std::string_view kHead = "effects/";
  if (!path.starts_with(kHead)) return std::nullopt;
  const std::string_view id = std::string_view(path).substr(kHead.size());
  if (id.find('/') != std::string_view::npos || !id.starts_with(kControlPrefix)) return std::nullopt;
  const std::string_view name = id.substr(kControlPrefix.size());
  for (LayerControl& c : read_controls(node)) {
    if (c.name == name) return std::move(c);
  }
  return std::nullopt;
}

std::optional<GroupBinding> control_group_info(const Node& node, const std::string& path) {
  const auto c = resolve_control(node, path);
  if (!c) return std::nullopt;
  GroupBinding g;
  g.path = path;
  g.name = c->name;
  g.matchName = c->spec->matchName;
  g.kind = api::PropertyKind::group;
  g.enabled = true;
  return g;
}

std::string next_free_control_name(const Document& d, const ControlSpec& spec) {
  std::vector<std::string> taken;
  for (const auto& [id, n] : d.nodes()) {
    const Component* t = n->comp("Transform");
    if (t == nullptr || !t->props.is_object()) continue;
    for (const auto& m : t->props.obj()) {
      if (m.key.starts_with(kControlPrefix) && m.value.is_number()) taken.push_back(m.key.substr(kControlPrefix.size()));
    }
  }
  for (int i = 1;; ++i) {
    const std::string name = spec.displayName + " " + std::to_string(i);
    const std::string dotted = name + ".";
    const bool used = std::any_of(taken.begin(), taken.end(), [&](const std::string& t) { return t == name || t.starts_with(dotted); });
    if (!used) return name;
  }
}

}  // namespace premation::doc
