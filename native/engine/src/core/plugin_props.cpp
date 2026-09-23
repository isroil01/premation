#include "plugin_props.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <map>
#include <set>

#include "fail.hpp"
#include "fxstate.hpp"
#include "scene.hpp"
#include "strutil.hpp"

namespace premation::doc {
namespace {

using api::ErrorCode;
using api::ValueType;
using js::stringify;

constexpr std::string_view kLayerComponentPrefix = "pluginLayer:";
constexpr std::string_view kLayerTrackPrefix = "plugin.";
constexpr std::string_view kPanelComponentPrefix = "PluginParams.";
constexpr std::string_view kPanelIdPrefix = "pluginui_";
constexpr std::array<std::string_view, 3> kAxes{"x", "y", "z"};

/// pluginProps.ts SEG: /^[A-Za-z0-9-]+$/.
bool seg_ok(std::string_view s) {
  if (s.empty()) return false;
  return std::all_of(s.begin(), s.end(), [](char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-';
  });
}

bool is_axis(std::string_view a) { return std::find(kAxes.begin(), kAxes.end(), a) != kAxes.end(); }

std::vector<std::string> split_dots(std::string_view s) {
  std::vector<std::string> out;
  std::size_t start = 0;
  while (true) {
    const std::size_t dot = s.find('.', start);
    if (dot == std::string_view::npos) {
      out.emplace_back(s.substr(start));
      return out;
    }
    out.emplace_back(s.substr(start, dot - start));
    start = dot + 1;
  }
}

struct PluginTrack {
  bool layer = false;
  std::string slug;
  std::string panel;
  std::string name;
  std::optional<std::string> axis;
};

/// `parsePluginTrack(prop)`.
std::optional<PluginTrack> parse_plugin_track(std::string_view prop) {
  if (prop.starts_with(kPluginPanelTrackPrefix)) {
    const std::vector<std::string> seg = split_dots(prop.substr(kPluginPanelTrackPrefix.size()));
    if (seg.size() < 3 || seg.size() > 4) return std::nullopt;
    if (!std::all_of(seg.begin(), seg.end(), [](const std::string& s) { return seg_ok(s); })) return std::nullopt;
    PluginTrack t;
    t.slug = seg[0];
    t.panel = seg[1];
    t.name = seg[2];
    if (seg.size() == 4) {
      if (!is_axis(seg[3])) return std::nullopt;
      t.axis = seg[3];
    }
    return t;
  }
  if (prop.starts_with(kLayerTrackPrefix)) {
    const std::string_view name = prop.substr(kLayerTrackPrefix.size());
    if (!seg_ok(name) || name.starts_with('_')) return std::nullopt;
    PluginTrack t;
    t.layer = true;
    t.name = std::string(name);
    return t;
  }
  return std::nullopt;
}

const Component* layer_kind_component(const Node& n) {
  for (const Component& c : n.components) {
    if (c.type.starts_with(kLayerComponentPrefix)) return &c;
  }
  return nullptr;
}

std::string panel_type(std::string_view slug, std::string_view panel) {
  return std::string(kPanelComponentPrefix) + std::string(slug) + "." + std::string(panel);
}

/// `parsePanelType(type)`.
std::optional<std::pair<std::string, std::string>> parse_panel_type(std::string_view type) {
  if (!type.starts_with(kPanelComponentPrefix)) return std::nullopt;
  const std::vector<std::string> seg = split_dots(type.substr(kPanelComponentPrefix.size()));
  if (seg.size() != 2 || !seg_ok(seg[0]) || !seg_ok(seg[1])) return std::nullopt;
  return std::make_pair(seg[0], seg[1]);
}

/// pluginProps.ts `ownKey`.
bool own_key(std::string_view k) {
  if (k.starts_with('_')) return false;
  const std::vector<std::string> seg = split_dots(k);
  return seg_ok(seg[0]) && seg.size() <= 2;
}

struct Home {
  const Component* comp = nullptr;
  std::string key;
};

Home static_home(const Node& n, const PluginTrack& t) {
  if (t.layer) return Home{layer_kind_component(n), t.name};
  return Home{n.comp(panel_type(t.slug, t.panel)), t.axis ? t.name + "." + *t.axis : t.name};
}

ValueType field_type(const Json& v) {
  if (v.is_bool()) return ValueType::bool_;
  if (v.is_string()) return ValueType::string;
  return ValueType::json;
}

PropBinding numeric_binding(std::string path, const std::string& name, std::vector<std::string> members) {
  PropBinding b;
  b.path = std::move(path);
  b.name = name;
  b.matchName = members[0];
  b.valueType = members.size() <= 1 ? ValueType::scalar : members.size() == 2 ? ValueType::vec2 : ValueType::vec3;
  b.members = std::move(members);
  b.animatable = true;
  // The static seam owns the value: nothing is invented on the Transform.
  b.home = std::vector<std::string>{};
  return b;
}

PropBinding field_binding(std::string path, const std::string& name, const std::string& component, const std::string& key,
                          const Json& stored) {
  PropBinding b;
  b.path = std::move(path);
  b.name = name;
  b.matchName = key;
  b.valueType = field_type(stored);
  b.special = Special::field;
  b.field = FieldRef{"plugin", key, component, std::nullopt};
  b.animatable = false;
  return b;
}

}  // namespace

std::optional<std::string> plugin_api_path(std::string_view prop) {
  const auto t = parse_plugin_track(prop);
  if (!t) return std::nullopt;
  if (t->layer) return "plugin/" + t->name;
  return "plugin/" + t->slug + "/" + t->panel + "/" + t->name;
}

std::optional<std::optional<double>> read_plugin_static(const Node& n, std::string_view prop) {
  const auto t = parse_plugin_track(prop);
  if (!t) return std::nullopt;
  const Home h = static_home(n, *t);
  if (h.comp == nullptr) return std::optional<double>{};
  const Json& v = h.comp->props.at(h.key);
  return v.is_number() ? std::optional<double>(v.num()) : std::optional<double>{};
}

std::optional<bool> write_plugin_static(Document& d, std::string_view nodeId, std::string_view prop, double value) {
  const auto t = parse_plugin_track(prop);
  if (!t) return std::nullopt;
  const Node* n = d.node(nodeId);
  if (n == nullptr) return false;
  const Home h = static_home(*n, *t);
  if (h.comp == nullptr) return false;
  const std::string cid = h.comp->id;
  return sg_write_prop(d, nodeId, cid, h.key, Json::number(value));
}

void add_plugin_bindings(const Node& node, const std::vector<std::string>& trackNames,
                         const std::function<void(PropBinding)>& add) {
  std::vector<PluginTrack> tracks;
  for (const auto& p : trackNames) {
    if (auto t = parse_plugin_track(p)) tracks.push_back(std::move(*t));
  }
  if (const Component* kind = layer_kind_component(node)) {
    std::set<std::string> names;  // sorted, like JS [...names].sort() (ASCII)
    for (const auto& m : kind->props.obj()) {
      if (own_key(m.key) && m.key.find('.') == std::string::npos) names.insert(m.key);
    }
    for (const auto& t : tracks) {
      if (t.layer) names.insert(t.name);
    }
    for (const auto& name : names) {
      const Json& v = kind->props.at(name);
      std::string path = "plugin/" + name;
      if (v.is_undefined() || v.is_number()) add(numeric_binding(std::move(path), name, {std::string(kLayerTrackPrefix) + name}));
      else add(field_binding(std::move(path), name, kind->type, name, v));
    }
  }
  struct Panel {
    std::string slug;
    std::string panel;
    const Component* comp = nullptr;
  };
  std::map<std::string, Panel> panels;  // sorted by component type
  for (const Component& c : node.components) {
    if (auto p = parse_panel_type(c.type)) panels.insert_or_assign(c.type, Panel{p->first, p->second, &c});
  }
  for (const auto& t : tracks) {
    if (t.layer) continue;
    const std::string type = panel_type(t.slug, t.panel);
    if (!panels.contains(type)) panels.emplace(type, Panel{t.slug, t.panel, nullptr});
  }
  for (const auto& [type, p] : panels) {
    std::map<std::string, std::set<std::string>> numeric;
    std::map<std::string, Json> other;
    if (p.comp != nullptr) {
      for (const auto& m : p.comp->props.obj()) {
        if (!own_key(m.key) || m.value.is_undefined()) continue;
        const std::vector<std::string> seg = split_dots(m.key);
        const std::string& name = seg[0];
        if (m.value.is_number()) {
          if (seg.size() == 2 && !is_axis(seg[1])) continue;
          numeric[name].insert(seg.size() == 2 ? seg[1] : std::string());
        } else if (seg.size() == 1) {
          other.insert_or_assign(name, m.value);
        }
      }
    }
    for (const auto& t : tracks) {
      if (t.layer || t.slug != p.slug || t.panel != p.panel || other.contains(t.name)) continue;
      numeric[t.name].insert(t.axis.value_or(std::string()));
    }
    std::set<std::string> names;
    for (const auto& [n, _] : numeric) names.insert(n);
    for (const auto& [n, _] : other) names.insert(n);
    const std::string base = "plugin/" + p.slug + "/" + p.panel;
    const std::string prefix = std::string(kPluginPanelTrackPrefix) + p.slug + "." + p.panel + ".";
    for (const auto& name : names) {
      std::string path = base + "/" + name;
      if (const auto it = other.find(name); it != other.end()) {
        add(field_binding(std::move(path), name, type, name, it->second));
        continue;
      }
      std::vector<std::string> members;
      for (const auto a : kAxes) {
        if (numeric[name].contains(std::string(a))) members.push_back(prefix + name + "." + std::string(a));
      }
      if (members.empty()) members.push_back(prefix + name);
      add(numeric_binding(std::move(path), name, std::move(members)));
    }
  }
}

std::vector<std::string> plugin_panel_group_paths(const Node& node) {
  std::vector<std::string> out;
  for (const Component& c : node.components) {
    if (auto p = parse_panel_type(c.type)) out.push_back("plugin/" + p->first + "/" + p->second);
  }
  std::sort(out.begin(), out.end());
  return out;
}

api::Value read_plugin_field(const Node& node, const PropBinding& b) {
  const Component* comp = node.comp(b.field->animatorId.value_or(""));
  const Json v = comp != nullptr ? comp->props.at(b.field->key) : Json();
  if (b.valueType == ValueType::bool_) return v_bool(v.is_bool() && v.b());
  if (b.valueType == ValueType::string) return v_string(v.is_string() ? v.str() : std::string());
  return v_json(stringify(v.is_undefined() ? Json::null() : v));
}

void write_plugin_field(Document& d, std::string_view layer, const PropBinding& b, const api::Value& value) {
  Json raw;
  if (value.kind() == VK::bool_ && b.valueType == ValueType::bool_) {
    raw = Json::boolean(get<VK::bool_>(value));
  } else if (value.kind() == VK::string && b.valueType == ValueType::string) {
    raw = Json::string(get<VK::string>(value));
  } else if (value.kind() == VK::json) {
    auto parsed = js::parse(get<VK::json>(value));
    if (!parsed) fail(ErrorCode::invalid_argument, "invalid json", {.path = b.path});
    raw = std::move(*parsed);
  } else {
    fail(ErrorCode::type_mismatch,
         "'" + b.path + "' takes a " + std::string(value_type_name(b.valueType)) + " (or json), got " +
             std::string(kind_name(value.kind())),
         {.path = b.path, .detail = "{\"expected\":\"" + std::string(value_type_name(b.valueType)) + "\"}"});
  }
  const std::string type = b.field->animatorId.value_or("");
  const Node* n = d.node(layer);
  const Component* comp = n != nullptr ? n->comp(type) : nullptr;
  if (comp == nullptr) {
    fail(ErrorCode::not_found, "layer '" + std::string(layer) + "' has no " + type, {.layer = std::string(layer), .path = b.path});
  }
  const std::string cid = comp->id;
  // Stored verbatim — JSON null included (an empty asset slot).
  (void)sg_write_prop(d, layer, cid, b.field->key, std::move(raw));
}

std::optional<PanelGroup> parse_panel_group_path(std::string_view path) {
  const std::vector<std::string> seg = [&] {
    std::vector<std::string> out;
    std::size_t start = 0;
    while (true) {
      const std::size_t slash = path.find('/', start);
      if (slash == std::string_view::npos) {
        out.emplace_back(path.substr(start));
        return out;
      }
      out.emplace_back(path.substr(start, slash - start));
      start = slash + 1;
    }
  }();
  if (seg.size() != 3 || seg[0] != "plugin" || !seg_ok(seg[1]) || !seg_ok(seg[2])) return std::nullopt;
  return PanelGroup{seg[1], seg[2], panel_type(seg[1], seg[2]), std::string(kPanelIdPrefix) + seg[1] + "_" + seg[2]};
}

std::optional<std::string> panel_group_for_match_name(std::string_view matchName) {
  const auto p = parse_panel_type(matchName);
  if (!p) return std::nullopt;
  return "plugin/" + p->first + "/" + p->second;
}

Json panel_init_props(const std::vector<api::PropertyInit>& init) {
  Json out = Json::object();
  for (const auto& i : init) {
    const std::string& path = i.path;
    // /^[a-z][a-zA-Z0-9]{0,31}$/
    const bool nameOk = !path.empty() && path.size() <= 32 && path[0] >= 'a' && path[0] <= 'z' &&
                        std::all_of(path.begin(), path.end(), [](char c) {
                          return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
                        });
    if (!nameOk) fail(ErrorCode::invalid_argument, "'" + path + "' is not a plugin param name", {.path = path});
    auto num = [&](double x) {
      if (!std::isfinite(x)) fail(ErrorCode::invalid_argument, "'" + path + "': value must be finite", {.path = path});
      return Json::number(x);
    };
    const api::Value& v = i.value;
    switch (v.kind()) {
      case VK::scalar: out.set(path, num(get<VK::scalar>(v))); break;
      case VK::int_: out.set(path, num(static_cast<double>(get<VK::int_>(v)))); break;
      case VK::bool_: out.set(path, Json::boolean(get<VK::bool_>(v))); break;
      case VK::string: out.set(path, Json::string(get<VK::string>(v))); break;
      case VK::choice: out.set(path, Json::string(get<VK::choice>(v))); break;
      case VK::vec2:
        out.set(path + ".x", num(get<VK::vec2>(v).x));
        out.set(path + ".y", num(get<VK::vec2>(v).y));
        break;
      case VK::vec3:
        out.set(path + ".x", num(get<VK::vec3>(v).x));
        out.set(path + ".y", num(get<VK::vec3>(v).y));
        out.set(path + ".z", num(get<VK::vec3>(v).z));
        break;
      case VK::color: {
        const api::Color& c = get<VK::color>(v);
        out.set(path, Json::string(channels_to_color(c.r, c.g, c.b, c.a)));
        break;
      }
      case VK::json: {
        auto parsed = js::parse(get<VK::json>(v));
        if (!parsed) fail(ErrorCode::invalid_argument, "invalid json", {.path = path});
        out.set(path, std::move(*parsed));
        break;
      }
      default:
        fail(ErrorCode::type_mismatch, "'" + path + "': a plugin param takes a number, point, bool, string, colour or json",
             {.path = path});
    }
  }
  return out;
}

}  // namespace premation::doc
