#include "props.hpp"

#include <algorithm>
#include <cmath>
#include <set>

#include "catalog_data.hpp"
#include "fail.hpp"
#include "fxstate.hpp"
#include "meta.hpp"
#include "ptree.hpp"
#include "scene.hpp"
#include "strutil.hpp"
#include "time_conv.hpp"

namespace premation::doc {
namespace {

using api::ErrorCode;
using api::ValueType;
using js::stringify;

const Node& node_of(const Document& d, std::string_view id) {
  const Node* n = d.node(id);
  if (n == nullptr) fail(ErrorCode::not_found, "no layer '" + std::string(id) + "'", {.layer = std::string(id)});
  return *n;
}

std::string detail_expected(api::ValueType t) {
  return "{\"expected\":\"" + std::string(value_type_name(t)) + "\"}";
}

// ── apiPathFor ───────────────────────────────────────────────────────────

std::string api_path_for(std::string_view prop, const StaticPropertyRow* row, const std::vector<std::string>& animIds,
                         const std::vector<std::vector<std::string>>& selIds) {
  if (prop.starts_with(kGroupPlaceholderPrefix)) {
    const std::string_view key = prop.substr(kGroupPlaceholderPrefix.size());
    if (key == "anchor") return "transform/anchorPoint";
    if (key == "position") return "transform/position";
    return "transform/" + std::string(key);
  }
  if (row != nullptr && row->merged) return "transform/position";
  if (row != nullptr && row->group == "transform") {
    if (prop == "x" || prop == "y" || prop == "z") return "transform/position/" + std::string(prop);
    if (prop == "rotationX") return "transform/xRotation";
    if (prop == "rotationY") return "transform/yRotation";
    if (prop == "opacity") return "transform/opacity";
    if (prop == "rotation") return "transform/rotation";
  }
  if (auto eff = parse_prefixed_id_rest(prop, "effect.")) {
    if (auto styleKey = style_key_from_effect_id(eff->id)) return "styles/" + *styleKey + "/" + eff->rest;
    if (eff->rest == kEffectOpacityKey) return "effects/" + eff->id + "/compositing/opacity";
    return "effects/" + eff->id + "/" + eff->rest;
  }
  if (prop.starts_with("effect.") && prop.size() > 7 && prop.substr(7).find('.') == std::string_view::npos) {
    return "effects/" + std::string(prop.substr(7)) + "/amount";
  }
  if (auto m = parse_prefixed_id_rest(prop, "mask.")) return "masks/" + m->id + "/" + m->rest;
  if (auto op = parse_prefixed_id_rest(prop, "pathop.")) return "contents/" + op->id + "/" + op->rest;
  if (prop.starts_with("polystar.") && prop.size() > 9) return "contents/polystar/" + std::string(prop.substr(9));
  if (auto p = parse_prefixed_id_rest(prop, "paint.")) return "paint/" + p->id + "/" + p->rest;
  if (auto tag = parse_axis_prop_path(prop)) return "text/axes/" + *tag;
  if (auto ta = parse_animator_track(prop)) {
    const std::string aid = ta->anim < static_cast<int>(animIds.size()) ? animIds[static_cast<std::size_t>(ta->anim)]
                                                                        : "#" + std::to_string(ta->anim);
    if (!ta->sel) return "text/animators/" + aid + "/props/" + ta->param;
    const auto ai = static_cast<std::size_t>(ta->anim);
    const auto si = static_cast<std::size_t>(*ta->sel);
    const std::string sid = ai < selIds.size() && si < selIds[ai].size() ? selIds[ai][si] : "#" + std::to_string(*ta->sel);
    return "text/animators/" + aid + "/selectors/" + sid + "/" + ta->param;
  }
  if (prop == kAudioLevelDbProp) return "audio/levels";
  if (prop == kAudioPanProp) return "audio/pan";
  if (prop == "timeRemap") return "timeRemap";
  if (prop == "timeSpeed") return "layer/timeSpeed";
  if (row != nullptr) {
    const std::string& g = row->group;
    if (g == "material" || g == "geometry" || g == "camera" || g == "light") return g + "/" + std::string(prop);
    if (g == "text" && prop != "animators" && prop != "sourceText" && prop != "axes") return "text/" + std::string(prop);
  }
  std::string p(prop);
  std::replace(p.begin(), p.end(), '/', '_');
  return "layer/" + p;
}

ValueType value_type_for_members(std::size_t n, bool color) {
  if (color) return ValueType::color;
  return n <= 1 ? ValueType::scalar : n == 2 ? ValueType::vec2 : n == 3 ? ValueType::vec3 : ValueType::vec4;
}

std::optional<api::Value> default_for(ValueType vt, const std::vector<std::string>& members, const Node& n,
                                      const Json& d) {
  if (vt == ValueType::color) return std::nullopt;
  if (members.size() == 1) {
    if (!d.is_number()) return std::nullopt;
    return v_scalar(d.num() * api_unit_factor(members[0]));
  }
  std::vector<double> vals;
  for (const auto& m : members) {
    const Json dv = resolve_property_meta(m, &n).defaultValue;
    vals.push_back(dv.is_number() ? dv.num() * api_unit_factor(m) : 0.0);
  }
  return vector_value(vt, vals);
}

constexpr std::string_view kMaskModes[] = {"none", "add", "subtract", "intersect", "lighten", "darken", "difference"};

}  // namespace

std::string PropBinding::lead() const {
  if (!members.empty()) return members[0];
  return dataTrack.value_or("");
}

const PropBinding* Catalog::find(std::string_view path) const {
  const auto it = byPath.find(path);
  return it == byPath.end() ? nullptr : &props[it->second];
}

const PropBinding* Catalog::by_member(std::string_view member) const {
  const auto it = byMember.find(member);
  return it == byMember.end() ? nullptr : &props[it->second];
}

// ── the catalog ──────────────────────────────────────────────────────────

Catalog catalog_for(const Document& d, std::string_view layerId) {
  const Node& node = node_of(d, layerId);
  const std::vector<Json> animators = read_animator_data(node);
  std::vector<std::string> animIds;
  std::vector<std::vector<std::string>> selIds;
  for (const Json& a : animators) {
    animIds.push_back(a.at("id").is_string() ? a.at("id").str() : "undefined");
    std::vector<std::string> s;
    if (a.at("selectors").is_array()) {
      for (const Json& x : a.at("selectors").arr()) s.push_back(x.at("id").is_string() ? x.at("id").str() : "undefined");
    }
    selIds.push_back(std::move(s));
  }
  const std::vector<StaticPropertyRow> rows = build_static_property_tree(d, layerId);
  Catalog cat;
  cat.layer = std::string(layerId);
  auto add = [&cat](PropBinding b) {
    if (cat.byPath.contains(b.path)) return;
    const std::size_t idx = cat.props.size();
    cat.byPath.emplace(b.path, idx);
    for (const auto& m : b.members) cat.byMember.try_emplace(m, idx);
    if (b.dataTrack) cat.byMember.try_emplace(*b.dataTrack, idx);
    cat.props.push_back(std::move(b));
  };
  const std::optional<Json> mask = read_node_mask(node);
  auto add_mask_props = [&](const Json& p) {
    const std::string id = p.at("id").is_string() ? p.at("id").str() : "undefined";
    PropBinding path;
    path.path = "masks/" + id + "/path";
    path.name = "Mask Path";
    path.matchName = "ADBE Mask Shape";
    path.valueType = ValueType::path;
    path.special = Special::maskPath;
    path.maskId = id;
    add(std::move(path));
    for (const char* key : {"feather", "opacity", "expansion"}) {
      const std::string m = "mask." + id + "." + key;
      const PropertyMeta meta = resolve_property_meta(m, &node);
      PropBinding b;
      b.path = "masks/" + id + "/" + key;
      b.name = meta.label;
      b.matchName = std::string("ADBE Mask ") + key;
      b.valueType = ValueType::scalar;
      b.members = {m};
      b.unit = meta.unit;
      add(std::move(b));
    }
    PropBinding mode;
    mode.path = "masks/" + id + "/mode";
    mode.name = "Mode";
    mode.matchName = "ADBE Mask Mode";
    mode.valueType = ValueType::choice;
    mode.special = Special::maskMode;
    mode.maskId = id;
    mode.animatable = false;
    mode.choices = std::vector<std::string>{};
    for (auto m : kMaskModes) mode.choices->emplace_back(m);
    add(std::move(mode));
    PropBinding inv;
    inv.path = "masks/" + id + "/inverted";
    inv.name = "Inverted";
    inv.matchName = "ADBE Mask Inverted";
    inv.valueType = ValueType::bool_;
    inv.special = Special::maskInverted;
    inv.maskId = id;
    inv.animatable = false;
    add(std::move(inv));
  };

  for (const StaticPropertyRow& row : rows) {
    if (row.maskTrack || row.prop == kMaskAnimProp) {
      if (mask) {
        for (const Json& p : mask->at("paths").arr()) add_mask_props(p);
      }
      continue;
    }
    const bool color = row.members.size() == 4 && row.members[0].ends_with("_r") && row.members[1].ends_with("_g") &&
                       row.members[2].ends_with("_b") && row.members[3].ends_with("_a");
    if (row.members.empty()) {
      if (auto p = parse_prefixed_id_rest(row.prop, "paint."); p && p->rest == "path") {
        PropBinding b;
        b.path = api_path_for(row.prop, &row, animIds, selIds);
        b.name = row.label;
        b.matchName = row.prop;
        b.valueType = ValueType::path;
        b.dataTrack = row.prop;
        add(std::move(b));
      }
      continue;
    }
    if (row.prop.starts_with(std::string(kGroupPlaceholderPrefix) + "rotation") && row.members.size() > 1) {
      StaticPropertyRow asTransform = row;
      asTransform.group = "transform";
      asTransform.merged.reset();
      for (const auto& m : row.members) {
        const PropertyMeta meta = resolve_property_meta(m, &node);
        PropBinding b;
        b.path = api_path_for(m, &asTransform, animIds, selIds);
        b.name = meta.label;
        b.matchName = m;
        b.valueType = ValueType::scalar;
        b.members = {m};
        b.unit = meta.unit;
        b.min = meta.min;
        b.max = meta.max;
        if (meta.defaultValue.is_number()) b.defaultValue = v_scalar(meta.defaultValue.num());
        add(std::move(b));
      }
      continue;
    }
    const std::string& base = color ? row.prop : row.members[0];
    const PropertyMeta meta = resolve_property_meta(color ? row.members[0] : base, &node);
    const ValueType vt = value_type_for_members(row.members.size(), color);
    PropBinding b;
    b.path = api_path_for(row.prop, &row, animIds, selIds);
    b.name = row.label;
    b.matchName = row.merged ? *row.merged : row.prop;
    b.valueType = vt;
    b.members = row.members;
    if (color) b.colorBase = row.prop;
    b.animatable = meta.keyframeable;
    b.unit = !color && api_unit_factor(row.members[0]) == 100 ? "%" : row.valueUnit ? *row.valueUnit : meta.unit;
    if (!color) {
      b.min = meta.min;
      b.max = meta.max;
    }
    b.defaultValue = default_for(vt, row.members, node, meta.defaultValue);
    add(std::move(b));
  }

  // Separated position: the combined property still exists (not animatable).
  if (cat.byPath.contains("transform/position/x")) {
    PropBinding b;
    b.path = "transform/position";
    b.name = "Position";
    b.matchName = "Position";
    b.members = {"x", "y"};
    if (cat.byPath.contains("transform/position/z")) b.members.emplace_back("z");
    b.valueType = b.members.size() == 3 ? ValueType::vec3 : ValueType::vec2;
    b.animatable = false;
    b.separated = true;
    b.unit = "px";
    const std::size_t idx = cat.props.size();
    cat.byPath.insert_or_assign(b.path, idx);
    cat.props.push_back(std::move(b));
  }

  if (text_component(node) != nullptr) {
    PropBinding b;
    b.path = "text/sourceText";
    b.name = "Source Text";
    b.matchName = "ADBE Text Document";
    b.valueType = ValueType::text_document;
    b.dataTrack = std::string(kSourceTextProp);
    b.special = Special::sourceText;
    add(std::move(b));
  }

  const std::vector<Json> effects = read_node_effects(node);
  for (const Json& effect : effects) {
    const EffectDef* edef = registry().effect(effect.at("type").str());
    if (edef == nullptr) continue;
    const std::string eid = effect.at("id").is_string() ? effect.at("id").str() : "undefined";
    for (const auto& p : edef->params) {
      if (p.type == "number" || p.type == "color" || p.type == "resolved") continue;
      PropBinding b;
      b.path = "effects/" + eid + "/" + p.key;
      b.name = p.label;
      b.matchName = p.key;
      b.valueType = p.type == "checkbox" ? ValueType::bool_
                    : p.type == "enum"   ? ValueType::choice
                    : p.type == "layer"  ? ValueType::layer
                    : p.type == "maskPath" ? ValueType::string
                                           : ValueType::json;
      b.special = Special::effectParam;
      b.effectId = eid;
      b.paramKey = p.key;
      b.animatable = false;
      b.unit = p.unit.value_or("");
      if (p.type == "enum") {
        b.choices = std::vector<std::string>{};
        for (const auto& o : p.options) b.choices->push_back(o.label);
      }
      add(std::move(b));
    }
  }

  if (mask) {
    for (const Json& p : mask->at("paths").arr()) add_mask_props(p);
  }

  if (const NodeAnim* an = d.anim(layerId)) {
    for (const auto& [prop, keys] : an->tracks) {
      if (cat.byMember.contains(prop)) continue;
      const PropertyMeta meta = resolve_property_meta(prop, &node);
      PropBinding b;
      b.path = api_path_for(prop, nullptr, animIds, selIds);
      b.name = meta.label.empty() ? prop : meta.label;
      b.matchName = prop;
      b.valueType = ValueType::scalar;
      b.members = {prop};
      b.unit = meta.unit;
      add(std::move(b));
    }
    for (const auto& [prop, track] : an->data) {
      if (cat.byMember.contains(prop)) continue;
      PropBinding b;
      b.path = api_path_for(prop, nullptr, animIds, selIds);
      b.name = prop;
      b.matchName = prop;
      b.valueType = track.kind == "text"            ? ValueType::string
                    : track.kind == "points"        ? ValueType::path
                    : track.kind == "gradientStops" ? ValueType::gradient
                                                    : ValueType::scalar;
      b.dataTrack = prop;
      add(std::move(b));
    }
  }

  // Groups from path prefixes.
  const Json styles = get_node_layer_styles(node);
  const std::vector<Json> ops = read_path_ops(node);
  auto group_name = [&](const std::string& path) -> GroupBinding {
    GroupBinding g;
    g.path = path;
    const std::vector<std::string> seg = split(path, '/');
    auto str_or = [](const Json& v, const std::string& fb) {
      if (v.is_undefined() || v.is_null()) return fb;
      return v.is_string() ? v.str() : stringify(v);
    };
    if (seg.size() == 1) {
      static const std::pair<std::string_view, std::string_view> kRootNames[] = {
          {"text", "Text"},           {"contents", "Contents"},          {"masks", "Masks"},
          {"effects", "Effects"},     {"transform", "Transform"},        {"styles", "Layer Styles"},
          {"camera", "Camera Options"}, {"light", "Light Options"},      {"geometry", "Geometry Options"},
          {"material", "Material Options"}, {"audio", "Audio"},          {"paint", "Paint"},
          {"layer", "Layer"},         {"timeRemap", "Time Remap"},       {"plugin", "Plugin"}};
      g.name = seg[0];
      for (const auto& [k, v] : kRootNames) {
        if (k == seg[0]) g.name = std::string(v);
      }
      g.matchName = seg[0];
      const bool indexed = seg[0] == "masks" || seg[0] == "effects" || seg[0] == "contents" || seg[0] == "styles" ||
                           seg[0] == "paint";
      g.kind = indexed ? api::PropertyKind::indexed_group : api::PropertyKind::group;
      return g;
    }
    if (seg[0] == "effects" && seg.size() == 2) {
      const Json* e = find_by_id(effects, seg[1]);
      if (e != nullptr) {
        const EffectDef* def = registry().effect(e->at("type").str());
        g.name = def != nullptr ? def->label : str_or(e->at("type"), "undefined");
        g.matchName = str_or(e->at("type"), "undefined");
        g.enabled = !(e->at("enabled").is_bool() && !e->at("enabled").b());
      } else {
        g.name = seg[1];
        g.matchName = seg[1];
      }
      return g;
    }
    if (seg[0] == "masks" && seg.size() == 2) {
      int idx = -1;
      const Json* p = nullptr;
      if (mask) {
        const auto& paths = mask->at("paths").arr();
        for (std::size_t i = 0; i < paths.size(); ++i) {
          if (paths[i].at("id").is_string() && paths[i].at("id").str() == seg[1]) {
            idx = static_cast<int>(i);
            p = &paths[i];
            break;
          }
        }
      }
      g.name = p != nullptr ? str_or(p->at("name"), "Mask " + std::to_string(idx + 1)) : "Mask " + std::to_string(idx + 1);
      g.matchName = "ADBE Mask Atom";
      g.enabled = p != nullptr ? !(p->at("mode").is_string() && p->at("mode").str() == "none") : true;
      return g;
    }
    if (seg[0] == "styles" && seg.size() == 2) {
      g.name = seg[1];
      g.matchName = "style:" + seg[1];
      const Json& s = styles.at(seg[1]);
      g.enabled = !(s.at("enabled").is_bool() && !s.at("enabled").b());
      return g;
    }
    if (seg[0] == "contents" && seg.size() == 2) {
      const Json* o = find_by_id(ops, seg[1]);
      g.name = o != nullptr ? o->at("type").str() : seg[1];
      g.matchName = o != nullptr ? "pathop:" + o->at("type").str() : seg[1];
      return g;
    }
    if (path == "text/animators") {
      g.name = "Animators";
      g.matchName = "ADBE Text Animators";
      g.kind = api::PropertyKind::indexed_group;
      return g;
    }
    if (seg[0] == "text" && seg.size() >= 3 && seg[1] == "animators") {
      const Json* a = find_by_id(animators, seg[2]);
      int ai = -1;
      for (std::size_t i = 0; i < animators.size(); ++i) {
        if (&animators[i] == a) ai = static_cast<int>(i);
      }
      if (seg.size() == 3) {
        g.name = a != nullptr ? str_or(a->at("name"), "Animator " + std::to_string(ai + 1)) : "Animator 0";
        g.matchName = "ADBE Text Animator";
        g.enabled = a == nullptr || !(a->at("enabled").is_bool() && !a->at("enabled").b());
        return g;
      }
      if (seg.size() == 4) {
        const bool props = seg[3] == "props";
        g.name = props ? "Properties" : "Selectors";
        g.matchName = props ? "ADBE Text Animator Properties" : "ADBE Text Selectors";
        g.kind = seg[3] == "selectors" ? api::PropertyKind::indexed_group : api::PropertyKind::group;
        return g;
      }
      if (seg.size() == 5) {
        const Json* s = nullptr;
        if (a != nullptr && a->at("selectors").is_array()) s = find_by_id(a->at("selectors").arr(), seg[4]);
        if (s != nullptr) {
          g.name = (s->at("kind").is_undefined() || s->at("kind").is_null() ? std::string("range") : str_or(s->at("kind"), "range")) +
                   " selector";
        } else {
          g.name = seg[4];
        }
        g.matchName = "ADBE Text Selector";
        g.enabled = s == nullptr || !(s->at("enabled").is_bool() && !s->at("enabled").b());
        return g;
      }
    }
    g.name = seg.back();
    g.matchName = seg.back();
    return g;
  };
  std::function<void(const std::string&)> ensure_group = [&](const std::string& path) {
    if (cat.groups.contains(path)) return;
    cat.groups.set(path, group_name(path));
    const std::size_t slash = path.rfind('/');
    if (slash == std::string::npos) {
      cat.roots.push_back(path);
    } else {
      const std::string parent = path.substr(0, slash);
      ensure_group(parent);
      cat.groups.find(parent)->children.push_back(path);
    }
  };
  for (const Json& e : effects) ensure_group("effects/" + (e.at("id").is_string() ? e.at("id").str() : std::string("undefined")));
  if (mask) {
    for (const Json& p : mask->at("paths").arr()) ensure_group("masks/" + (p.at("id").is_string() ? p.at("id").str() : std::string("undefined")));
  }
  for (std::size_t i = 0; i < animators.size(); ++i) {
    ensure_group("text/animators/" + animIds[i] + "/props");
    for (const auto& sid : selIds[i]) ensure_group("text/animators/" + animIds[i] + "/selectors/" + sid);
  }
  for (const Json& o : ops) ensure_group("contents/" + o.at("id").str());
  for (const PropBinding& b : cat.props) {
    const std::size_t slash = b.path.rfind('/');
    if (slash == std::string::npos) {
      if (std::find(cat.roots.begin(), cat.roots.end(), b.path) == cat.roots.end()) cat.roots.push_back(b.path);
      continue;
    }
    const std::string parent = b.path.substr(0, slash);
    if (cat.byPath.contains(parent)) continue;
    ensure_group(parent);
    cat.groups.find(parent)->children.push_back(b.path);
  }
  return cat;
}

const PropBinding& require_binding(const Catalog& cat, std::string_view path) {
  const PropBinding* b = cat.find(path);
  if (b == nullptr) {
    fail(ErrorCode::not_found, "layer '" + cat.layer + "' has no property '" + std::string(path) + "'",
         {.layer = cat.layer, .path = std::string(path)});
  }
  return *b;
}

// ── values ──────────────────────────────────────────────────────────────

double api_unit_factor(std::string_view member) noexcept {
  return member == "scale" || member == "scaleX" || member == "scaleY" || member == "scaleZ" ? 100.0 : 1.0;
}

std::vector<double> to_api_nums(const PropBinding& b, std::vector<double> nums) {
  if (b.colorBase) return nums;
  for (std::size_t i = 0; i < nums.size(); ++i) nums[i] *= api_unit_factor(i < b.members.size() ? std::string_view(b.members[i]) : std::string_view());
  return nums;
}

std::vector<double> from_api_nums(const PropBinding& b, std::vector<double> nums) {
  if (b.colorBase) return nums;
  for (std::size_t i = 0; i < nums.size(); ++i) nums[i] /= api_unit_factor(i < b.members.size() ? std::string_view(b.members[i]) : std::string_view());
  return nums;
}

api::Value vector_value(api::ValueType vt, const std::vector<double>& v) {
  auto at = [&](std::size_t i, double fb = 0) { return i < v.size() ? v[i] : fb; };
  switch (vt) {
    case ValueType::scalar: return v_scalar(at(0));
    case ValueType::vec2: return v_vec2(at(0), at(1));
    case ValueType::vec3: return v_vec3(at(0), at(1), at(2));
    case ValueType::vec4: return v_vec4(at(0), at(1), at(2), at(3));
    case ValueType::color: return v_color(at(0), at(1), at(2), at(3, 1));
    default: return v_scalar(at(0));
  }
}

std::vector<double> numbers_of(const PropBinding& b, const api::Value& value) {
  const std::size_t n = b.members.size();
  auto bad = [&]() {
    fail(ErrorCode::type_mismatch,
         "'" + b.path + "' takes a " + std::string(value_type_name(b.valueType)) + ", got " + std::string(kind_name(value.kind())),
         {.path = b.path, .detail = detail_expected(b.valueType)});
  };
  std::vector<double> out;
  switch (value.kind()) {
    case VK::scalar:
    case VK::int_:
    case VK::bool_:
    case VK::vec2:
    case VK::vec3:
    case VK::vec4:
    case VK::color: out = numbers_loose(value); break;
    default: bad();
  }
  if (b.valueType == ValueType::color && value.kind() != VK::color) bad();
  if (b.valueType != ValueType::color && value.kind() == VK::color) bad();
  if (out.size() < n) {
    if (out.size() == 2 && n == 3) return out;
    bad();
  }
  for (const double x : out) {
    if (!std::isfinite(x)) fail(ErrorCode::invalid_argument, "'" + b.path + "': value must be finite", {.path = b.path});
  }
  out.resize(n);
  return out;
}

// ── the static value seam (propertyValue.ts) ─────────────────────────────

namespace {

std::optional<double> channel_of(std::string_view color, std::string_view suffix) {
  std::string hex;
  for (const char c : color) {
    if (c != ' ' && c != '\t' && c != '\n' && c != '\r') hex.push_back(c);
  }
  // `color.trim().replace('#', '')` removes the FIRST '#'.
  if (const auto pos = hex.find('#'); pos != std::string::npos) hex.erase(pos, 1);
  std::string full;
  if (hex.size() == 3) {
    for (const char c : hex) {
      full.push_back(c);
      full.push_back(c);
    }
  } else if (hex.size() >= 6) {
    full = hex.substr(0, 6);
  } else {
    return std::nullopt;
  }
  const int i = suffix == "_r" ? 0 : suffix == "_g" ? 2 : suffix == "_b" ? 4 : -1;
  if (i < 0) return 1.0;
  // Number.parseInt(s, 16): leading hex digits; NaN when none.
  const std::string two = full.substr(static_cast<std::size_t>(i), 2);
  int v = 0;
  int digits = 0;
  for (const char c : two) {
    int dv = -1;
    if (c >= '0' && c <= '9') dv = c - '0';
    else if (c >= 'a' && c <= 'f') dv = c - 'a' + 10;
    else if (c >= 'A' && c <= 'F') dv = c - 'A' + 10;
    if (dv < 0) break;
    v = v * 16 + dv;
    ++digits;
  }
  if (digits == 0) return std::nullopt;
  return static_cast<double>(v) / 255.0;
}

struct ChannelSplit {
  std::string base;
  std::string suffix;
};
std::optional<ChannelSplit> split_channel(std::string_view prop) {
  if (prop.size() < 2) return std::nullopt;
  const std::string_view suffix = prop.substr(prop.size() - 2);
  if (suffix != "_r" && suffix != "_g" && suffix != "_b" && suffix != "_a") return std::nullopt;
  return ChannelSplit{std::string(prop.substr(0, prop.size() - 2)), std::string(suffix)};
}

std::optional<double> read_effect_value(const Node& n, const std::string& effectId, const std::string& key) {
  const auto channel = split_channel(key);
  if (auto styleKey = style_key_from_effect_id(effectId)) {
    const Json styles = get_node_layer_styles(n);
    const Json& style = styles.at(*styleKey);
    if (style.is_undefined() || style.is_null()) return std::nullopt;
    if (channel) {
      const Json& cols = registry().layerStyles.at("colorParams").at(*styleKey);
      if (cols.is_object()) {
        for (const auto& m : cols.obj()) {
          if (m.value.is_string() && m.value.str() == channel->base) {
            const Json& c = style.at(m.key);
            return c.is_string() ? channel_of(c.str(), channel->suffix) : std::nullopt;
          }
        }
      }
      return std::nullopt;
    }
    const auto field = style_field_for_param(*styleKey, key);
    if (!field) return std::nullopt;
    const Json* bind = style_number_binding(*styleKey, *field);
    const double scale = bind != nullptr && bind->at("scale").is_number() ? bind->at("scale").num() : 1.0;
    const Json& raw = style.at(*field);
    return raw.is_number() ? std::optional<double>(raw.num() * scale) : std::nullopt;
  }
  const std::vector<Json> effects = read_node_effects(n);
  const Json* effect = find_by_id(effects, effectId);
  if (effect == nullptr) return std::nullopt;
  const Json params = params_of(*effect);
  if (channel) {
    const Json& c = params.at(channel->base);
    return c.is_string() ? channel_of(c.str(), channel->suffix) : std::nullopt;
  }
  const Json& v = params.at(key);
  if (v.is_number()) return v.num();
  if (v.is_bool()) return v.b() ? 1.0 : 0.0;
  return std::nullopt;
}

bool write_effect_value(Document& d, std::string_view nodeId, const std::string& effectId, const std::string& key,
                        double value) {
  if (split_channel(key)) return false;
  const Node& n = *d.node(nodeId);
  if (auto styleKey = style_key_from_effect_id(effectId)) {
    const auto field = style_field_for_param(*styleKey, key);
    if (!field) return false;
    const Json* bind = style_number_binding(*styleKey, *field);
    const double scale = bind != nullptr && bind->at("scale").is_number() ? bind->at("scale").num() : 1.0;
    Json styles = get_node_layer_styles(n);
    const Json& style = styles.at(*styleKey);
    if (style.is_undefined() || style.is_null()) return false;
    Json next = style;
    next.set(*field, Json::number(value / (scale != 0 ? scale : 1)));
    styles.set(*styleKey, std::move(next));
    set_layer_styles(d, nodeId, styles);
    return true;
  }
  const std::vector<Json> effects = read_node_effects(n);
  const Json* effect = find_by_id(effects, effectId);
  if (effect == nullptr) return false;
  const EffectDef* def = registry().effect(effect->at("type").str());
  const EffectParamDef* param = def != nullptr ? def->param(key) : nullptr;
  if (param != nullptr && param->type != "number" && param->type != "checkbox" && param->type != "enum") return false;
  update_effect_param(d, nodeId, effectId, key,
                      param != nullptr && param->type == "checkbox" ? Json::boolean(value != 0) : Json::number(value));
  return true;
}

}  // namespace

std::optional<double> read_static_property_value(const Document& d, std::string_view nodeId, std::string_view prop) {
  const Node* np = d.node(nodeId);
  if (np == nullptr) return std::nullopt;
  const Node& n = *np;
  if (auto eff = parse_prefixed_id_rest(prop, "effect.")) return read_effect_value(n, eff->id, eff->rest);
  if (auto pp = parse_paint_prop_path(prop)) {
    if (auto strokes = read_node_paint(n)) {
      if (const Json* s = find_by_id(*strokes, pp->strokeId)) return read_paint_stroke_value(*s, pp->key);
    }
    return std::nullopt;
  }
  if (auto pc = parse_paint_color_path(prop)) {
    if (auto strokes = read_node_paint(n)) {
      if (const Json* s = find_by_id(*strokes, pc->strokeId)) {
        const Json& c = s->at("color");
        return channel_of(c.is_string() ? c.str() : stringify(c), std::string("_") + pc->channel);
      }
    }
    return std::nullopt;
  }
  if (auto mk = parse_mask_prop_path(prop)) {
    const Json mask = get_node_mask(n);
    const Json* p = mask_path_by_id(mask, mk->pathId);
    if (p == nullptr) return std::nullopt;
    const Json& v = p->at(mk->key);
    if (mk->key == "opacity") return v.num() * 100;  // undefined*100 = NaN in TS
    if (v.is_number()) return v.num();
    return std::nullopt;
  }
  if (auto op = parse_prefixed_id_rest(prop, "pathop.")) {
    const std::vector<Json> ops = read_path_ops(n);
    const Json* found = find_by_id(ops, op->id);
    if (found == nullptr) return std::nullopt;
    const Json& v = found->at(op->rest);
    return v.is_number() ? std::optional<double>(v.num()) : std::nullopt;
  }
  if (auto tp = parse_text_path_prop_path(prop)) {
    const auto cfg = read_text_path_config(n);
    return cfg ? std::optional<double>(text_path_param_value(*cfg, *tp)) : std::nullopt;
  }
  if (auto tag = parse_axis_prop_path(prop)) {
    const Json axes = read_font_axes_prop(n);
    const Json& v = axes.at(*tag);
    return v.is_number() ? std::optional<double>(v.num()) : std::nullopt;
  }
  if (auto ta = parse_animator_path(prop)) {
    const std::vector<Json> data = read_animator_data(n);
    const auto idx = static_cast<std::size_t>(ta->index);
    const Json* animator = idx < data.size() ? &data[idx] : nullptr;
    // animatorSlot
    std::optional<std::pair<std::size_t, std::string>> slot;
    if (animator != nullptr) {
      if (ta->selector) slot = std::make_pair(static_cast<std::size_t>(*ta->selector), ta->param);
      else if (ta->param == "start" || ta->param == "end" || ta->param == "offset") slot = std::make_pair(std::size_t{0}, ta->param);
      else if (ta->param == "wiggleFreq") slot = std::make_pair(std::size_t{0}, std::string("wigglesPerSecond"));
    }
    if (slot) {
      const Json& sels = animator->at("selectors");
      const Json* sel = sels.is_array() && slot->first < sels.arr().size() ? &sels.arr()[slot->first] : nullptr;
      if (sel == nullptr) return std::nullopt;
      const Json& v = sel->at(slot->second);
      return v.is_number() ? std::optional<double>(v.num()) : std::nullopt;
    }
    if (auto tag = axis_tag_of_param(ta->param)) {
      if (animator == nullptr) return std::nullopt;
      const Json& v = animator->at("axes").at(*tag);
      return v.is_number() ? std::optional<double>(v.num()) : std::nullopt;
    }
    if (animator == nullptr) return std::nullopt;
    const Json& v = animator->at(ta->param);
    return v.is_number() ? std::optional<double>(v.num()) : std::nullopt;
  }
  // isGradientGeometryProp: gradient paints on a text layer (editor-authored; see ptree.cpp).
  for (const Component& c : n.components) {
    const Json* v = c.props.find(prop);
    if (v != nullptr && v->is_number()) return v->num();
  }
  if (prop == "x") return view_transform(n).x;
  if (prop == "y") return view_transform(n).y;
  return std::nullopt;
}

bool write_static_property_value(Document& d, std::string_view nodeId, std::string_view prop, double value) {
  const Node* np = d.node(nodeId);
  if (np == nullptr) return false;
  if (auto eff = parse_prefixed_id_rest(prop, "effect.")) return write_effect_value(d, nodeId, eff->id, eff->rest, value);
  if (auto pp = parse_paint_prop_path(prop)) {
    const auto strokes = read_node_paint(*np);
    const Json* s = strokes ? find_by_id(*strokes, pp->strokeId) : nullptr;
    if (s == nullptr) return false;
    update_paint_stroke(d, nodeId, pp->strokeId, paint_stroke_patch(*s, pp->key, value));
    return true;
  }
  if (auto mk = parse_mask_prop_path(prop)) {
    const Json mask = get_node_mask(*np);
    if (mask_path_by_id(mask, mk->pathId) == nullptr) return false;
    Json patch = Json::object();
    patch.set(mk->key, Json::number(mk->key == "opacity" ? value / 100 : value));
    update_mask_path(d, nodeId, mk->pathId, patch);
    return true;
  }
  if (auto op = parse_prefixed_id_rest(prop, "pathop.")) {
    const std::vector<Json> ops = read_path_ops(*np);
    if (find_by_id(ops, op->id) == nullptr) return false;
    Json patch = Json::object();
    patch.set(op->rest, Json::number(value));
    update_path_op(d, nodeId, op->id, patch);
    return true;
  }
  if (auto tp = parse_text_path_prop_path(prop)) {
    if (!read_text_path_config(*np)) return false;
    const bool flag = *tp == "reversed" || *tp == "perpendicular" || *tp == "forceAlignment";
    Json patch = Json::object();
    patch.set(*tp, flag ? Json::boolean(value >= 0.5) : Json::number(value));
    update_text_path(d, nodeId, patch);
    return true;
  }
  if (auto tag = parse_axis_prop_path(prop)) {
    const Component* text = text_component(*np);
    if (text == nullptr) return false;
    Json axes = read_font_axes_prop(*np);
    axes.set(*tag, Json::number(value));
    return sg_write_prop(d, nodeId, text->id, "fontAxes", std::move(axes));
  }
  if (auto ta = parse_animator_path(prop)) {
    const std::vector<Json> data = read_animator_data(*np);
    const auto idx = static_cast<std::size_t>(ta->index);
    if (idx >= data.size()) return false;
    const Json& cur = data[idx];
    std::optional<std::pair<std::size_t, std::string>> slot;
    if (ta->selector) slot = std::make_pair(static_cast<std::size_t>(*ta->selector), ta->param);
    else if (ta->param == "start" || ta->param == "end" || ta->param == "offset") slot = std::make_pair(std::size_t{0}, ta->param);
    else if (ta->param == "wiggleFreq") slot = std::make_pair(std::size_t{0}, std::string("wigglesPerSecond"));
    const auto tag = axis_tag_of_param(ta->param);
    Json patch = Json::object();
    if (slot) {
      patch.set(slot->second, Json::number(value));
      update_selector(d, nodeId, idx, slot->first, patch);
    } else if (tag) {
      Json axes = cur.at("axes").is_object() ? cur.at("axes") : Json::object();
      axes.set(*tag, Json::number(value));
      patch.set("axes", std::move(axes));
      update_animator(d, nodeId, idx, patch);
    } else {
      patch.set(ta->param, Json::number(value));
      update_animator(d, nodeId, idx, patch);
    }
    return true;
  }
  const Component* comp = nullptr;
  for (const Component& c : np->components) {
    const Json* v = c.props.find(prop);
    if (v != nullptr && v->is_number()) {
      comp = &c;
      break;
    }
  }
  if (comp == nullptr && resolve_property_meta(prop, np).group == "transform") comp = np->comp("Transform");
  if (comp == nullptr) return false;
  const std::string cid = comp->id;
  return sg_write_prop(d, nodeId, cid, prop, Json::number(value));
}

// ── mask paths ⇄ BezierPath ──────────────────────────────────────────────

api::BezierPath mask_to_bezier(const Json& p) {
  api::BezierPath b;
  const Json& pts = p.at("points");
  if (pts.is_array()) {
    for (const Json& pt : pts.arr()) {
      const double x = pt.at("x").num();
      const double y = pt.at("y").num();
      b.vertices.push_back(x);
      b.vertices.push_back(y);
      b.in_tangents.push_back(pt.at("inX").num() - x);
      b.in_tangents.push_back(pt.at("inY").num() - y);
      b.out_tangents.push_back(pt.at("outX").num() - x);
      b.out_tangents.push_back(pt.at("outY").num() - y);
    }
  }
  b.closed = p.at("closed").is_bool() && p.at("closed").b();
  return b;
}

Json bezier_to_points(const api::BezierPath& b, const Json* prev) {
  const std::size_t n = b.vertices.size() / 2;
  if (b.in_tangents.size() != b.vertices.size() && !b.in_tangents.empty()) {
    fail(ErrorCode::invalid_argument, "path tangents must match vertices");
  }
  if (b.out_tangents.size() != b.vertices.size() && !b.out_tangents.empty()) {
    fail(ErrorCode::invalid_argument, "path tangents must match vertices");
  }
  Json out = Json::array();
  auto tan = [](const std::vector<double>& v, std::size_t i) { return i < v.size() ? v[i] : 0.0; };
  for (std::size_t i = 0; i < n; ++i) {
    const double x = b.vertices[2 * i];
    const double y = b.vertices[2 * i + 1];
    Json pt = Json::object();
    pt.set("x", Json::number(x));
    pt.set("y", Json::number(y));
    pt.set("inX", Json::number(x + tan(b.in_tangents, 2 * i)));
    pt.set("inY", Json::number(y + tan(b.in_tangents, 2 * i + 1)));
    pt.set("outX", Json::number(x + tan(b.out_tangents, 2 * i)));
    pt.set("outY", Json::number(y + tan(b.out_tangents, 2 * i + 1)));
    if (prev != nullptr && prev->is_array() && i < prev->arr().size()) {
      const Json& f = prev->arr()[i].at("feather");
      if (!f.is_undefined()) pt.set("feather", f);
    }
    out.arr_mut().push_back(std::move(pt));
  }
  return out;
}

// ── static reads and writes ──────────────────────────────────────────────

namespace {

std::optional<api::Color> color_of_string(const Json& s) {
  if (!s.is_string() || !is_hex_color(s.str())) return std::nullopt;
  const auto c = parse_color_channels(s.str());
  return api::Color{c[0], c[1], c[2], c[3]};
}

std::optional<std::string> style_color_field(std::string_view styleKey, std::string_view param) {
  const Json& cols = registry().layerStyles.at("colorParams").at(styleKey);
  if (!cols.is_object()) return std::nullopt;
  for (const auto& m : cols.obj()) {
    if (m.value.is_string() && m.value.str() == param) return m.key;
  }
  return std::nullopt;
}

std::optional<api::Color> read_color_base(const Node& n, const std::string& base) {
  if (auto eff = parse_prefixed_id_rest(base, "effect.")) {
    if (auto styleKey = style_key_from_effect_id(eff->id)) {
      const Json styles = get_node_layer_styles(n);
      const auto field = style_color_field(*styleKey, eff->rest);
      return field ? color_of_string(styles.at(*styleKey).at(*field)) : std::nullopt;
    }
    const std::vector<Json> effects = read_node_effects(n);
    const Json* e = find_by_id(effects, eff->id);
    return e != nullptr ? color_of_string(params_of(*e).at(eff->rest)) : std::nullopt;
  }
  for (const Component& c : n.components) {
    if (auto col = color_of_string(c.props.at(base))) return col;
  }
  return std::nullopt;
}

bool write_color_base(Document& d, std::string_view nodeId, const std::string& base, const api::Color& c) {
  const std::string hex = channels_to_color(c.r, c.g, c.b, c.a);
  const Node& n = *d.node(nodeId);
  if (auto eff = parse_prefixed_id_rest(base, "effect.")) {
    if (auto styleKey = style_key_from_effect_id(eff->id)) {
      Json styles = get_node_layer_styles(n);
      const Json& style = styles.at(*styleKey);
      const auto field = style_color_field(*styleKey, eff->rest);
      if (style.is_undefined() || style.is_null() || !field) return false;
      Json next = style;
      next.set(*field, Json::string(hex));
      styles.set(*styleKey, std::move(next));
      set_layer_styles(d, nodeId, styles);
      return true;
    }
    const std::vector<Json> effects = read_node_effects(n);
    if (find_by_id(effects, eff->id) == nullptr) return false;
    update_effect_param(d, nodeId, eff->id, eff->rest, Json::string(hex));
    return true;
  }
  for (const Component& comp : n.components) {
    if (comp.props.at(base).is_string()) {
      const std::string cid = comp.id;
      return sg_write_prop(d, nodeId, cid, base, Json::string(hex));
    }
  }
  return false;
}

std::vector<double> numbers_of_default(const api::Value& v) {
  switch (v.kind()) {
    case VK::scalar: return {get<VK::scalar>(v)};
    case VK::vec2: return {get<VK::vec2>(v).x, get<VK::vec2>(v).y};
    case VK::vec3: return {get<VK::vec3>(v).x, get<VK::vec3>(v).y, get<VK::vec3>(v).z};
    default: return {};
  }
}

std::string string_of(const Json& v) {
  if (v.is_undefined() || v.is_null()) return "";
  if (v.is_string()) return v.str();
  if (v.is_number()) return js::number_to_string(v.num());
  if (v.is_bool()) return v.b() ? "true" : "false";
  return stringify(v);
}

}  // namespace

api::Value read_static(const Document& d, std::string_view layer, const PropBinding& b) {
  const Node& n = node_of(d, layer);
  switch (b.special) {
    case Special::sourceText: {
      const Component* t = text_component(n);
      const Json& content = t != nullptr ? t->props.at("content") : Json::null();
      return v_text(content.is_string() ? content.str() : "");
    }
    case Special::maskPath: {
      const auto mask = read_node_mask(n);
      const Json* p = mask ? mask_path_by_id(*mask, *b.maskId) : nullptr;
      return p != nullptr ? v_path(mask_to_bezier(*p)) : v_none();
    }
    case Special::maskMode: {
      const auto mask = read_node_mask(n);
      const Json* p = mask ? mask_path_by_id(*mask, *b.maskId) : nullptr;
      const Json& mode = p != nullptr ? p->at("mode") : Json::null();
      return v_choice(mode.is_undefined() || mode.is_null() ? "add" : string_of(mode));
    }
    case Special::maskInverted: {
      const auto mask = read_node_mask(n);
      const Json* p = mask ? mask_path_by_id(*mask, *b.maskId) : nullptr;
      return v_bool(p != nullptr && p->at("inverted").is_bool() && p->at("inverted").b());
    }
    case Special::effectParam: {
      const std::vector<Json> effects = read_node_effects(n);
      const Json* e = find_by_id(effects, *b.effectId);
      const Json v = e != nullptr ? params_of(*e).at(*b.paramKey) : Json();
      const EffectDef* def = e != nullptr ? registry().effect(e->at("type").str()) : nullptr;
      const EffectParamDef* pd = def != nullptr ? def->param(*b.paramKey) : nullptr;
      if (b.valueType == ValueType::bool_) return v_bool((v.is_bool() && v.b()) || (v.is_number() && v.num() == 1));
      if (b.valueType == ValueType::choice) {
        if (pd != nullptr) {
          for (const auto& o : pd->options) {
            if (v.is_number() && o.value == v.num()) return v_choice(o.label);
          }
        }
        return v_choice(v.is_undefined() || v.is_null() ? "" : string_of(v));
      }
      if (b.valueType == ValueType::layer) return v_layer(v.is_string() ? v.str() : "");
      if (b.valueType == ValueType::string) return v_string(v.is_string() ? v.str() : "");
      return v_json(stringify(v.is_undefined() ? Json::null() : v));
    }
    case Special::none: break;
  }
  if (b.colorBase) {
    if (auto c = read_color_base(n, *b.colorBase)) return v_color(c->r, c->g, c->b, c->a);
    std::vector<double> ch;
    for (const auto& m : b.members) ch.push_back(read_static_property_value(d, layer, m).value_or(0));
    return vector_value(ValueType::color, ch);
  }
  if (b.dataTrack) return v_none();
  std::vector<double> nums;
  const std::vector<double> defs = b.defaultValue ? numbers_of_default(*b.defaultValue) : std::vector<double>{};
  for (std::size_t i = 0; i < b.members.size(); ++i) {
    if (auto v = read_static_property_value(d, layer, b.members[i])) {
      nums.push_back(*v * api_unit_factor(b.members[i]));
    } else {
      nums.push_back(i < defs.size() ? defs[i] : 0.0);
    }
  }
  return vector_value(b.valueType, nums);
}

void write_static(Document& d, std::string_view layer, const PropBinding& b, const api::Value& value) {
  const Node& n = node_of(d, layer);
  auto mismatch = [&](std::string what) { fail(ErrorCode::type_mismatch, "'" + b.path + "' takes " + what, {.path = b.path}); };
  switch (b.special) {
    case Special::sourceText: {
      if (value.kind() != VK::text_document && value.kind() != VK::string) mismatch("a textDocument");
      const std::string text = value.kind() == VK::string ? get<VK::string>(value) : get<VK::text_document>(value).text;
      const Component* comp = text_component(n);
      if (comp == nullptr) fail(ErrorCode::not_found, "not a text layer", {.layer = std::string(layer)});
      const std::string cid = comp->id;
      const Json before = comp->props.at("content");
      const bool hadRuns = !comp->props.at("__runs").is_undefined();
      (void)sg_write_prop(d, layer, cid, "content", Json::string(text));
      if (!(before.is_string() && before.str() == text) && hadRuns) (void)sg_write_prop(d, layer, cid, "__runs", Json());
      return;
    }
    case Special::maskPath:
    case Special::maskMode:
    case Special::maskInverted: {
      Json m = read_node_mask(n).value_or(Json());
      if (!m.is_object()) {
        m = Json::object();
        m.set("paths", Json::array());
      }
      auto& paths = m.find_mut("paths")->arr_mut();
      std::size_t idx = paths.size();
      for (std::size_t i = 0; i < paths.size(); ++i) {
        if (paths[i].at("id").is_string() && paths[i].at("id").str() == *b.maskId) {
          idx = i;
          break;
        }
      }
      if (idx == paths.size()) fail(ErrorCode::not_found, "no mask '" + *b.maskId + "'", {.layer = std::string(layer), .path = b.path});
      Json next = paths[idx];
      if (b.special == Special::maskPath) {
        if (value.kind() != VK::path) mismatch("a path");
        const auto& bp = get<VK::path>(value);
        next.set("points", bezier_to_points(bp, &paths[idx].at("points")));
        next.set("closed", Json::boolean(bp.closed));
      } else if (b.special == Special::maskMode) {
        const bool ok = value.kind() == VK::choice &&
                        std::find(std::begin(kMaskModes), std::end(kMaskModes), get<VK::choice>(value)) != std::end(kMaskModes);
        if (!ok) {
          fail(ErrorCode::type_mismatch, "'" + b.path + "' takes one of none, add, subtract, intersect, lighten, darken, difference",
               {.path = b.path});
        }
        next.set("mode", Json::string(get<VK::choice>(value)));
      } else {
        if (value.kind() != VK::bool_) mismatch("a bool");
        next.set("inverted", Json::boolean(get<VK::bool_>(value)));
      }
      paths[idx] = next;
      Json mask = Json::object();
      mask.set("paths", Json::array(paths));
      sg_set_fx(d, layer, "mask", mask);
      if (b.special != Special::maskPath) {
        const std::vector<Json> anim = read_node_mask_anim(*d.node(layer));
        if (!anim.empty()) {
          std::vector<Json> out;
          for (const Json& k : anim) {
            Json e = k;
            Json ps = Json::array();
            for (const Json& p : k.at("mask").at("paths").arr()) {
              if (p.at("id").is_string() && p.at("id").str() == *b.maskId) {
                Json q = p;
                q.set("mode", next.at("mode"));
                q.set("inverted", next.at("inverted"));
                ps.arr_mut().push_back(std::move(q));
              } else {
                ps.arr_mut().push_back(p);
              }
            }
            Json km = Json::object();
            km.set("paths", std::move(ps));
            e.set("mask", std::move(km));
            out.push_back(std::move(e));
          }
          set_mask_anim(d, layer, std::move(out));
        }
      }
      return;
    }
    case Special::effectParam: {
      const std::vector<Json> effects = read_node_effects(n);
      const Json* e = find_by_id(effects, *b.effectId);
      if (e == nullptr) fail(ErrorCode::not_found, "no effect '" + *b.effectId + "'", {.layer = std::string(layer), .path = b.path});
      const EffectDef* def = registry().effect(e->at("type").str());
      const EffectParamDef* pd = def != nullptr ? def->param(*b.paramKey) : nullptr;
      Json v;
      if (b.valueType == ValueType::bool_) {
        if (value.kind() != VK::bool_) mismatch("a bool");
        v = Json::boolean(get<VK::bool_>(value));
      } else if (b.valueType == ValueType::choice) {
        if (value.kind() != VK::choice) mismatch("a choice");
        const EffectOption* opt = nullptr;
        if (pd != nullptr) {
          for (const auto& o : pd->options) {
            if (o.label == get<VK::choice>(value)) {
              opt = &o;
              break;
            }
          }
        }
        if (opt == nullptr) {
          std::string choices = "[";
          if (b.choices) {
            for (std::size_t i = 0; i < b.choices->size(); ++i) {
              if (i > 0) choices += ",";
              choices += stringify(Json::string((*b.choices)[i]));
            }
          }
          choices += "]";
          fail(ErrorCode::out_of_range, "'" + get<VK::choice>(value) + "' is not a choice of '" + b.path + "'",
               {.path = b.path, .detail = "{\"choices\":" + choices + "}"});
        }
        v = Json::number(opt->value);
      } else if (b.valueType == ValueType::layer) {
        if (value.kind() != VK::layer) mismatch("a layer");
        v = Json::string(get<VK::layer>(value));
      } else if (b.valueType == ValueType::string) {
        if (value.kind() != VK::string) mismatch("a string");
        v = Json::string(get<VK::string>(value));
      } else {
        if (value.kind() != VK::json) mismatch("json");
        auto parsed = js::parse(get<VK::json>(value));
        if (!parsed) fail(ErrorCode::invalid_argument, "invalid json", {.path = b.path});
        v = std::move(*parsed);
      }
      update_effect_param(d, layer, *b.effectId, *b.paramKey, std::move(v));
      return;
    }
    case Special::none: break;
  }
  if (b.dataTrack) {
    fail(ErrorCode::unsupported, "'" + b.path + "' has no static value in this engine; key it instead", {.path = b.path});
  }
  if (b.colorBase) {
    if (value.kind() != VK::color) mismatch("a color");
    if (!write_color_base(d, layer, *b.colorBase, get<VK::color>(value))) {
      fail(ErrorCode::not_found, "nowhere to store '" + b.path + "'", {.path = b.path});
    }
    return;
  }
  const std::vector<double> nums = from_api_nums(b, numbers_of(b, value));
  for (std::size_t i = 0; i < nums.size(); ++i) {
    const std::string& m = b.members[i];
    if (!write_static_property_value(d, layer, m, nums[i])) {
      const Component* t = d.node(layer)->comp("Transform");
      if (t == nullptr) fail(ErrorCode::not_found, "nowhere to store '" + b.path + "'", {.path = b.path});
      const std::string cid = t->id;
      (void)sg_write_prop(d, layer, cid, m, Json::number(nums[i]));
    }
  }
}

// ── keyframes ────────────────────────────────────────────────────────────

std::string fallback_key_id(std::string_view layer, std::string_view member, double t) {
  return "@" + std::string(layer) + "|" + std::string(member) + "|" + js::number_to_string(t);
}

std::optional<FallbackKey> parse_fallback_key_id(std::string_view id) {
  // /^@(.+)\|(.+)\|(-?[0-9.eE+-]+)$/ — greedy: the LAST two '|'.
  if (id.size() < 6 || id[0] != '@') return std::nullopt;
  const std::size_t p2 = id.rfind('|');
  if (p2 == std::string_view::npos || p2 + 1 >= id.size()) return std::nullopt;
  const std::size_t p1 = id.rfind('|', p2 - 1);
  if (p1 == std::string_view::npos || p1 <= 1 || p1 + 1 >= p2) return std::nullopt;
  const std::string_view tstr = id.substr(p2 + 1);
  for (std::size_t i = 0; i < tstr.size(); ++i) {
    const char c = tstr[i];
    const bool ok = is_ascii_digit(c) || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-';
    if (!ok) return std::nullopt;
  }
  char* end = nullptr;
  const std::string ts(tstr);
  const double t = std::strtod(ts.c_str(), &end);
  if (end != ts.c_str() + ts.size() || !std::isfinite(t)) return std::nullopt;  // Number() of a malformed literal is NaN
  return FallbackKey{std::string(id.substr(1, p1 - 1)), std::string(id.substr(p1 + 1, p2 - p1 - 1)), t};
}

bool is_animated(const Document& d, std::string_view layer, const PropBinding& b) {
  if (b.special == Special::maskPath) return !read_node_mask_anim(node_of(d, layer)).empty();
  if (b.dataTrack) return anim_is_data_animated(d, layer, *b.dataTrack);
  return std::any_of(b.members.begin(), b.members.end(), [&](const std::string& m) { return anim_is_animated(d, layer, m); });
}

std::string mask_key_id(std::string_view layer, const Json& k, std::string_view maskId) {
  const Json& id = k.at("id");
  if (id.is_string() && !id.str().empty()) return id.str() + "@" + std::string(maskId);
  return fallback_key_id(layer, "mask:" + std::string(maskId), k.at("t").num());
}

namespace {

std::optional<api::Easing> easing_of_json(const Json& e) {
  if (!e.is_string()) return std::nullopt;
  const std::string& s = e.str();
  if (s == "linear") return api::Easing::linear;
  if (s == "hold") return api::Easing::hold;
  if (s == "bezier") return api::Easing::bezier;
  if (s == "ease") return api::Easing::ease;
  if (s == "easeIn") return api::Easing::ease_in;
  if (s == "easeOut") return api::Easing::ease_out;
  if (s == "easeInOut") return api::Easing::ease_in_out;
  if (s == "step") return api::Easing::step;
  if (s == "autoBezier") return api::Easing::auto_bezier;
  if (s == "continuousBezier") return api::Easing::continuous_bezier;
  return std::nullopt;
}

std::optional<std::array<double, 4>> bezier_of_json(const Json& b) {
  if (!b.is_array() || b.arr().size() < 4) return std::nullopt;
  return std::array<double, 4>{b.arr()[0].num(), b.arr()[1].num(), b.arr()[2].num(), b.arr()[3].num()};
}

KeyAt base_key(double t, std::string id, api::Value value, std::optional<api::Easing> easing,
               std::optional<std::array<double, 4>> bezier, std::optional<double> label) {
  KeyAt k;
  k.t = t;
  k.id = std::move(id);
  k.value = std::move(value);
  k.easing = easing.value_or(api::Easing::linear);
  k.bezier = bezier;
  k.label = label.value_or(0);
  return k;
}

api::Value data_value_to_api(const PropBinding& b, const Json& v) {
  if (b.special == Special::sourceText) return v_text(v.is_string() ? v.str() : "");
  if (v.is_string()) return v_string(v.str());
  if (v.is_number()) return v_scalar(v.num());
  if (v.is_array() && !v.arr().empty() && v.arr()[0].at("x").is_number()) {
    api::BezierPath p;
    for (const Json& pt : v.arr()) {
      const double x = pt.at("x").num();
      const double y = pt.at("y").num();
      p.vertices.push_back(x);
      p.vertices.push_back(y);
      auto nz = [](const Json& j, double fb) { return j.is_undefined() || j.is_null() ? fb : j.num(); };
      p.in_tangents.push_back(nz(pt.at("inX"), x) - x);
      p.in_tangents.push_back(nz(pt.at("inY"), y) - y);
      p.out_tangents.push_back(nz(pt.at("outX"), x) - x);
      p.out_tangents.push_back(nz(pt.at("outY"), y) - y);
    }
    return v_path(std::move(p));
  }
  return v_json(stringify(v.is_undefined() ? Json::null() : v));
}

Json api_to_data_value(const PropBinding& b, const api::Value& value) {
  if (b.special == Special::sourceText) {
    if (value.kind() == VK::text_document) return Json::string(get<VK::text_document>(value).text);
    if (value.kind() == VK::string) return Json::string(get<VK::string>(value));
    fail(ErrorCode::type_mismatch, "'" + b.path + "' takes a textDocument", {.path = b.path});
  }
  switch (value.kind()) {
    case VK::string: return Json::string(get<VK::string>(value));
    case VK::scalar: return Json::number(get<VK::scalar>(value));
    case VK::path: {
      const Json pts = bezier_to_points(get<VK::path>(value), nullptr);
      Json out = Json::array();
      for (const Json& p : pts.arr()) {
        Json q = Json::object();
        for (const char* k : {"x", "y", "inX", "inY", "outX", "outY"}) q.set(k, p.at(k));
        out.arr_mut().push_back(std::move(q));
      }
      return out;
    }
    case VK::json: {
      auto parsed = js::parse(get<VK::json>(value));
      if (!parsed) fail(ErrorCode::invalid_argument, "invalid json", {.path = b.path});
      return std::move(*parsed);
    }
    default:
      fail(ErrorCode::type_mismatch, "'" + b.path + "' cannot take a " + std::string(kind_name(value.kind())), {.path = b.path});
  }
}

double sample_member(const Document& d, std::string_view layer, const std::string& prop, double t, double fallback) {
  const auto* keys = anim_track(d, layer, prop);
  if (keys == nullptr || keys->empty()) return fallback;
  return sample_keys(*keys, t).value_or(fallback);
}

}  // namespace

std::vector<KeyAt> read_keys(const Document& d, std::string_view layer, const PropBinding& b) {
  std::vector<KeyAt> out;
  if (b.special == Special::maskPath) {
    for (const Json& k : read_node_mask_anim(node_of(d, layer))) {
      const Json* p = mask_path_by_id(k.at("mask"), *b.maskId);
      const Json& lab = k.at("label");
      out.push_back(base_key(k.at("t").num(), mask_key_id(layer, k, *b.maskId), p != nullptr ? v_path(mask_to_bezier(*p)) : v_none(),
                             easing_of_json(k.at("easing")), bezier_of_json(k.at("bezier")),
                             lab.is_number() ? std::optional<double>(lab.num()) : std::nullopt));
    }
    return out;
  }
  if (b.dataTrack) {
    if (const DataTrack* tr = anim_data_track(d, layer, *b.dataTrack)) {
      for (const DataKey& k : tr->keys) {
        out.push_back(base_key(k.t, k.id ? *k.id : fallback_key_id(layer, *b.dataTrack, k.t), data_value_to_api(b, k.value),
                               k.easing, k.bezier, k.label));
      }
    }
    return out;
  }
  std::vector<const std::vector<Key>*> tracks;
  std::set<double> times;
  for (const auto& m : b.members) {
    const auto* tr = anim_track(d, layer, m);
    tracks.push_back(tr);
    if (tr != nullptr) {
      for (const Key& k : *tr) times.insert(k.t);
    }
  }
  if (times.empty()) return out;
  const api::Value stat = read_static(d, layer, b);
  const std::vector<double> statNums = stat.kind() == VK::none ? std::vector<double>{} : from_api_nums(b, numbers_loose(stat));
  for (const double t : times) {
    const Key* lead = nullptr;
    std::string leadMember = b.members[0];
    std::vector<double> nums;
    std::vector<double> sIn;
    std::vector<double> sOut;
    bool anySpatial = false;
    for (std::size_t i = 0; i < b.members.size(); ++i) {
      const Key* k = nullptr;
      if (tracks[i] != nullptr) {
        for (const Key& x : *tracks[i]) {
          if (x.t == t) {
            k = &x;
            break;
          }
        }
      }
      if (k != nullptr && lead == nullptr) {
        lead = k;
        leadMember = b.members[i];
      }
      nums.push_back(k != nullptr ? k->value : sample_member(d, layer, b.members[i], t, i < statNums.size() ? statNums[i] : 0.0));
      sIn.push_back(k != nullptr && k->si ? *k->si : 0.0);
      sOut.push_back(k != nullptr && k->so ? *k->so : 0.0);
      if (k != nullptr && (k->si || k->so)) anySpatial = true;
    }
    KeyAt ka;
    ka.t = t;
    ka.id = lead->id ? *lead->id : fallback_key_id(layer, leadMember, t);
    ka.value = vector_value(b.valueType, to_api_nums(b, nums));
    ka.easing = lead->easing.value_or(api::Easing::linear);
    ka.bezier = lead->bezier;
    ka.continuous = lead->continuous.value_or(false);
    ka.roving = lead->roving.value_or(false);
    ka.spatialInterp = lead->spatial.value_or(api::SpatialInterp::legacy);
    if (anySpatial) {
      ka.spatialIn = std::move(sIn);
      ka.spatialOut = std::move(sOut);
    }
    ka.label = lead->label.value_or(0);
    out.push_back(std::move(ka));
  }
  return out;
}

api::Time key_time_to_flicks(const PCtx& c, std::string_view layer, const PropBinding& b, double t) {
  return seconds_to_flicks(keyframe_to_comp_time(c.d, c.view, layer, t, b.lead()));
}

double flicks_to_key_time(const PCtx& c, std::string_view layer, const PropBinding& b, api::Time flicks) {
  return comp_to_keyframe_time(c.d, c.view, layer, flicks_to_seconds(flicks), b.lead());
}

api::Keyframe key_at_to_api(const PCtx& c, std::string_view layer, const PropBinding& b, const KeyAt& k) {
  api::Keyframe out;
  out.id = k.id;
  out.time = key_time_to_flicks(c, layer, b, k.t);
  out.value = k.value;
  out.easing = k.easing;
  if (k.bezier) out.bezier = api::CubicBezier{(*k.bezier)[0], (*k.bezier)[1], (*k.bezier)[2], (*k.bezier)[3]};
  out.continuous = k.continuous;
  out.roving = k.roving;
  out.spatial_interp = k.spatialInterp;
  out.spatial_in = k.spatialIn;
  out.spatial_out = k.spatialOut;
  out.label = k.label > 0 && k.label < 4294967296.0 ? static_cast<std::uint32_t>(k.label) : 0U;
  return out;
}

// ── keyframe writes ──────────────────────────────────────────────────────

namespace {

template <class K>
void apply_key_fields(K& k, const KeyWrite& w) {
  if (w.easing) k.easing = *w.easing;
  if (w.bezier) {
    if (*w.bezier) k.bezier = **w.bezier;
    else k.bezier.reset();
  }
  if (w.label) {
    if (*w.label != 0) k.label = *w.label;
    else k.label.reset();
  }
}

void put_mask_keys(const PCtx& c, std::string_view layer, const PropBinding& b, const std::vector<KeyWrite>& writes) {
  const Node& n = node_of(c.d, layer);
  const Json staticMask = read_node_mask(n).value_or([] {
    Json m = Json::object();
    m.set("paths", Json::array());
    return m;
  }());
  std::vector<Json> anim = read_node_mask_anim(n);
  for (const KeyWrite& w : writes) {
    const Json* existing = nullptr;
    for (const Json& k : anim) {
      if (k.at("t").num() == w.t) {
        existing = &k;
        break;
      }
    }
    Json baseMask;
    if (existing != nullptr) {
      baseMask = existing->at("mask");
    } else if (!anim.empty()) {
      const Json* before = nullptr;
      for (const Json& k : anim) {
        if (k.at("t").num() <= w.t) before = &k;
      }
      baseMask = (before != nullptr ? *before : anim[0]).at("mask");
    } else {
      baseMask = staticMask;
    }
    Json mask = baseMask;
    if (w.value) {
      if (w.value->kind() != VK::path) fail(ErrorCode::type_mismatch, "'" + b.path + "' takes a path", {.path = b.path});
      const auto& pts = get<VK::path>(*w.value);
      Json paths = Json::array();
      bool found = false;
      for (const Json& p : mask.at("paths").arr()) {
        if (p.at("id").is_string() && p.at("id").str() == *b.maskId) {
          Json q = p;
          q.set("points", bezier_to_points(pts, &p.at("points")));
          q.set("closed", Json::boolean(pts.closed));
          paths.arr_mut().push_back(std::move(q));
          found = true;
        } else {
          paths.arr_mut().push_back(p);
        }
      }
      mask = Json::object();
      mask.set("paths", std::move(paths));
      if (!found) fail(ErrorCode::not_found, "no mask '" + *b.maskId + "'", {.path = b.path});
    }
    std::string entryId;
    if (existing != nullptr && existing->at("id").is_string() && !existing->at("id").str().empty()) {
      entryId = existing->at("id").str();
    } else {
      entryId = w.id.substr(0, w.id.find('@'));
    }
    Json next = existing != nullptr ? *existing : Json::object();
    next.set("t", Json::number(w.t));
    next.set("mask", std::move(mask));
    next.set("id", Json::string(entryId));
    std::erase_if(anim, [&](const Json& k) { return k.at("t").num() == w.t; });
    anim.push_back(std::move(next));
  }
  std::stable_sort(anim.begin(), anim.end(), [](const Json& a, const Json& b2) { return a.at("t").num() < b2.at("t").num(); });
  set_mask_anim(c.d, layer, std::move(anim));
}

double static_num(const Document& d, std::string_view layer, const PropBinding& b, std::size_t i) {
  return read_static_property_value(d, layer, b.members[i]).value_or(0);
}

Json current_data_value(const PCtx& c, std::string_view layer, const PropBinding& b, double t) {
  if (const DataTrack* tr = anim_data_track(c.d, layer, *b.dataTrack)) {
    if (auto v = sample_data_track(*tr, t)) return *v;
  }
  if (b.special == Special::sourceText) {
    const api::Value s = read_static(c.d, layer, b);
    return Json::string(s.kind() == VK::text_document ? get<VK::text_document>(s).text : "");
  }
  fail(ErrorCode::invalid_argument, "'" + b.path + "' needs a value for its first keyframe", {.path = b.path});
}

}  // namespace

void put_keys(const PCtx& c, std::string_view layer, const PropBinding& b, const std::vector<KeyWrite>& writes) {
  if (writes.empty()) return;
  if (b.special == Special::maskPath) {
    put_mask_keys(c, layer, b, writes);
    return;
  }
  Document& d = c.d;
  if (b.dataTrack) {
    const DataTrack* track = anim_data_track(d, layer, *b.dataTrack);
    const std::string kind = track != nullptr ? track->kind
                             : b.special == Special::sourceText   ? "text"
                             : b.valueType == ValueType::path     ? "points"
                             : b.valueType == ValueType::gradient ? "gradientStops"
                                                                  : "number";
    std::vector<DataKey> keys = track != nullptr ? track->keys : std::vector<DataKey>{};
    for (const KeyWrite& w : writes) {
      const DataKey* existing = nullptr;
      for (const DataKey& k : keys) {
        if (k.t == w.t) {
          existing = &k;
          break;
        }
      }
      Json value = w.value ? api_to_data_value(b, *w.value) : existing != nullptr ? existing->value : current_data_value(c, layer, b, w.t);
      DataKey next = existing != nullptr ? *existing : DataKey{};
      next.id = existing != nullptr && existing->id ? *existing->id : w.id;
      next.t = w.t;
      next.value = std::move(value);
      apply_key_fields(next, w);
      std::erase_if(keys, [&](const DataKey& k) { return k.t == w.t; });
      keys.push_back(std::move(next));
    }
    std::stable_sort(keys.begin(), keys.end(), [](const DataKey& a, const DataKey& b2) { return a.t < b2.t; });
    DataTrack t;
    t.kind = kind;
    t.keys = std::move(keys);
    anim_set_data_track(d, layer, *b.dataTrack, std::move(t));
    return;
  }
  if (b.members.empty()) fail(ErrorCode::not_animatable, "'" + b.path + "' cannot take keyframes", {.path = b.path});
  std::vector<std::vector<Key>> tracks;
  for (const auto& m : b.members) {
    const auto* tr = anim_track(d, layer, m);
    tracks.push_back(tr != nullptr ? *tr : std::vector<Key>{});
  }
  for (const KeyWrite& w : writes) {
    std::optional<std::vector<double>> nums;
    if (w.value) {
      if (b.colorBase && w.value->kind() != VK::color) {
        fail(ErrorCode::type_mismatch, "'" + b.path + "' takes a color", {.path = b.path});
      }
      nums = from_api_nums(b, numbers_of(b, *w.value));
    }
    for (std::size_t i = 0; i < b.members.size(); ++i) {
      std::vector<Key>& list = tracks[i];
      const Key* existing = nullptr;
      for (const Key& k : list) {
        if (k.t == w.t) {
          existing = &k;
          break;
        }
      }
      double v = 0;
      if (nums) {
        v = i < nums->size() ? (*nums)[i] : existing != nullptr ? existing->value : 0.0;
      } else {
        v = existing != nullptr ? existing->value : sample_member(d, layer, b.members[i], w.t, static_num(d, layer, b, i));
      }
      Key next = existing != nullptr ? *existing : Key{};
      next.t = w.t;
      next.value = v;
      next.id = existing != nullptr && existing->id ? *existing->id : w.id;
      apply_key_fields(next, w);
      if (w.continuous) next.continuous = *w.continuous;
      if (w.roving) next.roving = *w.roving;
      if (w.spatialInterp) {
        if (*w.spatialInterp == api::SpatialInterp::legacy) next.spatial.reset();
        else next.spatial = *w.spatialInterp;
      }
      if (w.spatialIn) {
        if (!*w.spatialIn) next.si.reset();
        else if (!(*w.spatialIn)->empty()) next.si = i < (*w.spatialIn)->size() ? (**w.spatialIn)[i] : 0.0;
      }
      if (w.spatialOut) {
        if (!*w.spatialOut) next.so.reset();
        else if (!(*w.spatialOut)->empty()) next.so = i < (*w.spatialOut)->size() ? (**w.spatialOut)[i] : 0.0;
      }
      std::erase_if(list, [&](const Key& k) { return k.t == w.t; });
      list.push_back(std::move(next));
      std::stable_sort(list.begin(), list.end(), [](const Key& a, const Key& b2) { return a.t < b2.t; });
    }
  }
  for (std::size_t i = 0; i < b.members.size(); ++i) anim_set_track(d, layer, b.members[i], std::move(tracks[i]));
}

void drop_keys(const PCtx& c, std::string_view layer, const PropBinding& b, const std::vector<double>& times) {
  if (times.empty()) return;
  Document& d = c.d;
  auto dropped = [&](double t) { return std::find(times.begin(), times.end(), t) != times.end(); };
  if (b.special == Special::maskPath) {
    const std::vector<Json> anim = read_node_mask_anim(node_of(d, layer));
    std::vector<Json> keep;
    for (const Json& k : anim) {
      if (!dropped(k.at("t").num())) keep.push_back(k);
    }
    if (keep.empty() && !anim.empty()) {
      for (const Json& k : anim) {
        if (dropped(k.at("t").num())) {
          sg_set_fx(d, layer, "mask", k.at("mask"));
          break;
        }
      }
    }
    set_mask_anim(d, layer, keep.empty() ? std::nullopt : std::optional<std::vector<Json>>(std::move(keep)));
    return;
  }
  if (b.dataTrack) {
    const DataTrack* track = anim_data_track(d, layer, *b.dataTrack);
    if (track == nullptr) return;
    DataTrack next = *track;
    std::vector<DataKey> keep;
    for (const DataKey& k : track->keys) {
      if (!dropped(k.t)) keep.push_back(k);
    }
    if (keep.empty() && b.special == Special::sourceText) {
      for (const DataKey& k : track->keys) {
        if (dropped(k.t)) {
          if (k.value.is_string()) write_static(d, layer, b, v_string(k.value.str()));
          break;
        }
      }
    }
    next.keys = std::move(keep);
    anim_set_data_track(d, layer, *b.dataTrack, next.keys.empty() ? std::nullopt : std::optional<DataTrack>(std::move(next)));
    return;
  }
  std::vector<std::optional<double>> lastValues(b.members.size());
  bool emptied = false;
  for (std::size_t i = 0; i < b.members.size(); ++i) {
    const auto* kfs = anim_track(d, layer, b.members[i]);
    const std::vector<Key> all = kfs != nullptr ? *kfs : std::vector<Key>{};
    std::vector<Key> keep;
    for (const Key& k : all) {
      if (!dropped(k.t)) keep.push_back(k);
    }
    if (keep.empty() && !all.empty()) {
      emptied = true;
      for (const Key& k : all) {
        if (dropped(k.t)) {
          lastValues[i] = k.value;
          break;
        }
      }
    }
    anim_set_track(d, layer, b.members[i], std::move(keep));
  }
  if (emptied && !b.colorBase) {
    for (std::size_t i = 0; i < b.members.size(); ++i) {
      if (lastValues[i]) (void)write_static_property_value(d, layer, b.members[i], *lastValues[i]);
    }
  } else if (emptied && b.colorBase) {
    auto lv = [&](std::size_t i, double fb) { return i < lastValues.size() && lastValues[i] ? *lastValues[i] : fb; };
    (void)write_color_base(d, layer, *b.colorBase, api::Color{lv(0, 0), lv(1, 0), lv(2, 0), lv(3, 1)});
  }
}

std::optional<api::Value> value_at(const PCtx& c, std::string_view layer, const PropBinding& b, double t) {
  const Document& d = c.d;
  if (b.special == Special::maskPath) {
    const std::vector<KeyAt> keys = read_keys(d, layer, b);
    const KeyAt* k = nullptr;
    for (const KeyAt& x : keys) {
      if (x.t <= t) k = &x;
    }
    if (k == nullptr && !keys.empty()) k = &keys[0];
    return k != nullptr ? k->value : read_static(d, layer, b);
  }
  if (b.dataTrack) {
    const DataTrack* tr = anim_data_track(d, layer, *b.dataTrack);
    std::optional<Json> v = tr != nullptr ? sample_data_track(*tr, t) : std::nullopt;
    if (!v || v->is_undefined()) {
      api::Value s = read_static(d, layer, b);
      if (s.kind() == VK::none) return std::nullopt;
      return s;
    }
    if (b.special == Special::sourceText) return v_text(string_of(*v));
    if (v->is_string()) return v_string(v->str());
    if (v->is_number()) return v_scalar(v->num());
    return std::nullopt;
  }
  if (b.members.empty()) return read_static(d, layer, b);
  const api::Value stat = read_static(d, layer, b);
  std::vector<double> statNums;
  switch (stat.kind()) {
    case VK::color:
    case VK::scalar:
    case VK::vec2:
    case VK::vec3: statNums = numbers_loose(stat); break;
    default: break;
  }
  std::vector<double> nums;
  for (std::size_t i = 0; i < b.members.size(); ++i) {
    const auto* kfs = anim_track(d, layer, b.members[i]);
    const double sv = i < statNums.size() ? statNums[i] : 0.0;
    if (kfs == nullptr || kfs->empty()) {
      nums.push_back(sv);
      continue;
    }
    const auto s = anim_sample(d, c.expr, c.cache, layer, b.members[i], t);
    nums.push_back(s ? *s * (b.colorBase ? 1.0 : api_unit_factor(b.members[i])) : sv);
  }
  return vector_value(b.valueType, nums);
}

}  // namespace premation::doc
