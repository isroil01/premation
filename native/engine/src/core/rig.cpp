#include "rig.hpp"

#include <cmath>
#include <numbers>
#include <set>

#include "anim.hpp"
#include "catalog_data.hpp"
#include "fail.hpp"
#include "fields.hpp"
#include "scene.hpp"
#include "strutil.hpp"
#include "values.hpp"

namespace premation::doc {
namespace {

using api::ErrorCode;
using api::ValueType;
using js::stringify;

constexpr double kDeg = 180.0 / std::numbers::pi;
constexpr double kMeshDensityDefault = 22;

constexpr std::string_view kMatchPuppet = "ADBE FreePin3";
constexpr std::string_view kMatchPin = "ADBE FreePin3 PosPin Atom";
constexpr std::string_view kMatchSkeleton = "Premation Skeleton";
constexpr std::string_view kMatchBone = "Premation Bone";
constexpr std::string_view kMatchIk = "Premation IK Goal";
constexpr std::string_view kMatchController = "Premation Rig Controller";

const Json& specs() { return registry().fields.at("rig"); }

const Json* spec_for(std::string_view owner, std::string_view path) {
  for (const Json& s : specs().arr()) {
    if (s.at("owner").str() == owner && s.at("path").str() == path) return &s;
  }
  return nullptr;
}

const Json& spec_of(const PropBinding& b) {
  const Json* s = b.rig ? spec_for(b.rig->owner, b.rig->spec) : nullptr;
  if (s == nullptr) fail(ErrorCode::internal, "'" + b.path + "' is not a rig property", {.path = b.path});
  return *s;
}

double scale_of(const Json& spec) {
  const Json& s = spec.at("scale");
  if (!s.is_string()) return 1;
  return s.str() == "percent" ? 100.0 : s.str() == "radians" ? kDeg : 1.0;
}

bool is_num(const Json& v) { return v.is_finite_number(); }

const Json& fx_of(const Node& n) { return n.fx(); }

Json puppet_of(const Node& n) {
  const Json& p = fx_of(n).at("puppet");
  return p.is_object() ? p : Json();
}

Json skeleton_of(const Node& n) {
  const Json& s = fx_of(n).at("skeleton");
  return s.is_object() ? s : Json();
}

/// `listOf(o, key)`: the object entries of an array member.
std::vector<Json> list_of(const Json& o, std::string_view key) {
  std::vector<Json> out;
  if (!o.is_object()) return out;
  const Json& v = o.at(key);
  if (!v.is_array()) return out;
  for (const Json& x : v.arr()) {
    if (x.is_object()) out.push_back(x);
  }
  return out;
}

std::vector<Json> with_ids(const std::vector<Json>& list, std::string_view idKey = "id") {
  std::vector<Json> out;
  for (const Json& x : list) {
    if (x.at(idKey).is_string()) out.push_back(x);
  }
  return out;
}

const Json* find_by(const std::vector<Json>& list, std::string_view idKey, std::string_view id) {
  for (const Json& x : list) {
    if (x.at(idKey).is_string() && x.at(idKey).str() == id) return &x;
  }
  return nullptr;
}

/// A raw array member (non-array → empty).
Json::Array raw(const Json& o, std::string_view key) {
  const Json& v = o.at(key);
  return v.is_array() ? v.arr() : Json::Array{};
}

Json get_key(const Json& o, std::string_view key) {
  const std::size_t dot = key.find('.');
  if (dot == std::string_view::npos) return o.at(key);
  const Json& inner = o.at(key.substr(0, dot));
  return inner.is_object() ? inner.at(key.substr(dot + 1)) : Json();
}

/// rigProps.ts `setKey`: undefined deletes; a dotted key writes into a nested object.
Json set_key(const Json& o, std::string_view key, Json v) {
  Json out = o;
  const std::size_t dot = key.find('.');
  if (dot == std::string_view::npos) {
    if (v.is_undefined()) out.erase(key);
    else out.set(key, std::move(v));
    return out;
  }
  const std::string head(key.substr(0, dot));
  const Json inner = o.at(head).is_object() ? o.at(head) : Json::object();
  out.set(head, set_key(inner, key.substr(dot + 1), std::move(v)));
  return out;
}

Json owner_object(const Node& n, const RigRef& ref) {
  if (ref.owner == "layer") return n.fx().is_object() ? n.fx() : Json::object();
  if (ref.owner == "puppet") return puppet_of(n);
  if (ref.owner == "skeleton") return skeleton_of(n);
  const Json* hit = nullptr;
  std::vector<Json> list;
  if (ref.owner == "pin") {
    list = with_ids(list_of(puppet_of(n), "pins"));
    hit = find_by(list, "id", ref.id);
  } else if (ref.owner == "bone") {
    list = with_ids(list_of(skeleton_of(n), "bones"));
    hit = find_by(list, "id", ref.id);
  } else if (ref.owner == "ik") {
    list = with_ids(list_of(skeleton_of(n), "ikTargets"), "boneId");
    hit = find_by(list, "boneId", ref.id);
  } else if (ref.owner == "controller") {
    list = with_ids(list_of(skeleton_of(n), "controllers"));
    hit = find_by(list, "id", ref.id);
  }
  return hit != nullptr ? *hit : Json();
}

ValueType vt_of(const Json& spec) {
  const std::string& t = spec.at("type").str();
  if (t == "scalar") return ValueType::scalar;
  if (t == "vec2") return ValueType::vec2;
  if (t == "choice") return ValueType::choice;
  if (t == "string") return ValueType::string;
  return ValueType::json;
}

std::string replace_id(const std::string& s, const std::string& id) {
  const std::size_t at = s.find("{id}");
  return at == std::string::npos ? s : s.substr(0, at) + id + s.substr(at + 4);
}

PropBinding binding(const std::string& owner, const std::string& id, const std::string& base, const Json& spec) {
  const double k = scale_of(spec);
  PropBinding b;
  b.path = base + "/" + spec.at("path").str();
  b.name = spec.at("label").str();
  b.matchName = spec.at("matchName").str();
  b.valueType = vt_of(spec);
  if (spec.at("tracks").is_array()) {
    for (const Json& t : spec.at("tracks").arr()) b.members.push_back(replace_id(t.str(), id));
  }
  if (spec.at("dataTrack").is_string()) b.dataTrack = replace_id(spec.at("dataTrack").str(), id);
  b.special = Special::rig;
  b.rig = RigRef{owner, id, spec.at("path").str()};
  b.animatable = !b.members.empty() || b.dataTrack.has_value();
  b.unit = spec.at("unit").is_string() ? spec.at("unit").str() : "";
  if (spec.at("min").is_number()) b.min = spec.at("min").num();
  if (spec.at("max").is_number()) b.max = spec.at("max").num();
  if (spec.at("choices").is_array()) {
    b.choices = std::vector<std::string>{};
    for (const Json& c : spec.at("choices").arr()) b.choices->push_back(c.str());
  }
  const Json& def = spec.at("default");
  if (b.valueType == ValueType::scalar && def.is_number()) b.defaultValue = v_scalar(def.num() * k);
  else if (b.valueType == ValueType::vec2 && def.is_array()) b.defaultValue = v_vec2(def.arr()[0].num() * k, def.arr()[1].num() * k);
  else if (b.valueType == ValueType::choice && def.is_string()) b.defaultValue = v_choice(def.str());
  else if (b.valueType == ValueType::string && def.is_string()) b.defaultValue = v_string(def.str());
  else if (b.valueType == ValueType::json) b.defaultValue = v_json("null");
  return b;
}

bool has_track(const Document& d, std::string_view layer, const std::string& prop) {
  const auto* k = anim_track(d, layer, prop);
  return k != nullptr && !k->empty();
}

bool has_pole(const Document& d, std::string_view layer, const Json& target, const std::string& boneId) {
  return target.at("pole").is_object() || has_track(d, layer, "ikPole." + boneId + ".x") ||
         has_track(d, layer, "ikPole." + boneId + ".y");
}

double num2(const Json& spec, std::size_t i) {
  const Json& d = spec.at("default");
  if (d.is_array()) return d.arr()[i].num();
  return d.is_number() ? d.num() : 0.0;
}

Json bind_entry(const Json& skel, const std::string& boneId, const Json& bone) {
  const std::vector<Json> bind = list_of(skel, "bindPose");
  if (bind.empty()) return bone;
  for (const Json& b : bind) {
    if (b.at("id").is_string() && b.at("id").str() == boneId) return b;
  }
  return bone;
}

[[noreturn]] void type_err(const PropBinding& b, const api::Value& v) {
  fail(ErrorCode::type_mismatch,
       "'" + b.path + "' takes a " + std::string(value_type_name(b.valueType)) + ", got " + std::string(kind_name(v.kind())),
       {.path = b.path, .detail = "{\"expected\":\"" + std::string(value_type_name(b.valueType)) + "\"}"});
}

std::vector<double> api_numbers(const PropBinding& b, const Json& spec, const api::Value& v) {
  std::vector<double> nums;
  if (spec.at("type").str() == "scalar") {
    if (v.kind() != VK::scalar) type_err(b, v);
    nums = {get<VK::scalar>(v)};
  } else {
    if (v.kind() != VK::vec2) type_err(b, v);
    nums = {get<VK::vec2>(v).x, get<VK::vec2>(v).y};
  }
  for (const double x : nums) {
    if (!std::isfinite(x)) fail(ErrorCode::invalid_argument, "'" + b.path + "': value must be finite", {.path = b.path});
    const Json& mn = spec.at("min");
    const Json& mx = spec.at("max");
    if ((mn.is_number() && x < mn.num()) || (mx.is_number() && x > mx.num())) {
      fail(ErrorCode::out_of_range,
           "'" + b.path + "' takes " + (mn.is_number() ? js::number_to_string(mn.num()) : "-∞") + ".." +
               (mx.is_number() ? js::number_to_string(mx.num()) : "∞"),
           {.path = b.path});
    }
  }
  return nums;
}

Json copy_list(const std::vector<Json>& list) {
  Json out = Json::array();
  for (const Json& x : list) out.arr_mut().push_back(x);
  return out;
}

/// skeletonCommands `captureBindPose`.
Json captured(const Json& skel) {
  if (!list_of(skel, "bindPose").empty()) return skel;
  Json out = skel;
  out.set("bindPose", copy_list(list_of(skel, "bones")));
  return out;
}

bool in_subtree(const std::vector<Json>& bones, const std::string& boneId, const std::string& candidate) {
  std::optional<std::string> cur = candidate;
  std::set<std::string> seen;
  while (cur && !seen.contains(*cur)) {
    if (*cur == boneId) return true;
    seen.insert(*cur);
    const Json* b = find_by(bones, "id", *cur);
    cur = b != nullptr && b->at("parentId").is_string() ? std::optional<std::string>(b->at("parentId").str()) : std::nullopt;
  }
  return false;
}

Json num_json(double x) { return Json::number(x); }

Json next_owner(const Node& n, const PropBinding& b, const Json& spec, const Json& o, const api::Value& value) {
  const double k = scale_of(spec);
  const std::string& codec = spec.at("codec").str();
  const Json& keys = spec.at("keys");
  const bool clear = spec.at("clearAtDefault").is_bool() && spec.at("clearAtDefault").b();
  auto key = [&](std::size_t i) { return std::string_view(keys.arr()[i].str()); };
  if (codec == "number") {
    const double s = api_numbers(b, spec, value)[0] / k;
    return set_key(o, key(0), clear && spec.at("default").is_number() && s == spec.at("default").num() ? Json() : num_json(s));
  }
  if (codec == "xy") {
    const auto nums = api_numbers(b, spec, value);
    Json out = o;
    for (std::size_t i = 0; i < keys.arr().size(); ++i) {
      const double s = nums[i] / k;
      out = set_key(out, key(i), clear && s == num2(spec, i) ? Json() : num_json(s));
    }
    return out;
  }
  if (codec == "point") {
    const auto nums = api_numbers(b, spec, value);
    Json p = Json::object();
    p.set("x", num_json(nums[0] / k));
    p.set("y", num_json(nums[1] / k));
    return set_key(o, key(0), std::move(p));
  }
  if (codec == "pinPosition") {
    const auto nums = api_numbers(b, spec, value);
    Json p = Json::object();
    p.set("x", num_json(nums[0]));
    p.set("y", num_json(nums[1]));
    Json out = o;
    out.set("position", std::move(p));
    return out;
  }
  if (codec == "choice") {
    if (value.kind() != VK::choice && value.kind() != VK::string) type_err(b, value);
    const std::string s = value.kind() == VK::choice ? get<VK::choice>(value) : get<VK::string>(value);
    bool ok = false;
    for (const Json& c : spec.at("choices").arr()) ok = ok || c.str() == s;
    if (!ok) {
      fail(ErrorCode::out_of_range, "'" + s + "' is not a choice of '" + b.path + "'",
           {.path = b.path, .detail = "{\"choices\":" + stringify(spec.at("choices")) + "}"});
    }
    return set_key(o, key(0), Json::string(s));
  }
  if (codec == "string") {
    if (value.kind() != VK::string) type_err(b, value);
    return set_key(o, key(0), Json::string(get<VK::string>(value)));
  }
  if (codec == "parent") {
    if (value.kind() != VK::string) type_err(b, value);
    const std::string& p = get<VK::string>(value);
    const std::vector<Json> bones = with_ids(list_of(skeleton_of(n), "bones"));
    const std::string& id = b.rig->id;
    if (!p.empty()) {
      if (find_by(bones, "id", p) == nullptr) fail(ErrorCode::not_found, "no bone '" + p + "'", {.path = b.path});
      if (in_subtree(bones, id, p)) fail(ErrorCode::cycle, "bone '" + p + "' cannot parent '" + id + "'", {.path = b.path});
    }
    Json out = o;
    out.set("parentId", p.empty() ? Json::null() : Json::string(p));
    return out;
  }
  if (codec == "json") {
    if (value.kind() != VK::json) type_err(b, value);
    auto parsed = js::parse(get<VK::json>(value));
    if (!parsed) fail(ErrorCode::invalid_argument, "invalid json", {.path = b.path});
    if (!parsed->is_null() && !parsed->is_object()) {
      fail(ErrorCode::invalid_argument, "'" + b.path + "' takes null or a JSON object", {.path = b.path});
    }
    return set_key(o, key(0), parsed->is_null() ? Json() : std::move(*parsed));
  }
  if (codec == "ikMode") {
    const double x = api_numbers(b, spec, value)[0];
    Json out = o;
    out.set("ikMode", Json::string(x >= 0.5 ? "ik" : "fk"));
    return out;
  }
  return o;  // bind: handled by the caller
}

void write_puppet(Document& d, std::string_view layer, Json rig) { sg_set_fx(d, layer, "puppet", std::move(rig)); }
void write_skeleton(Document& d, std::string_view layer, Json rig) { sg_set_fx(d, layer, "skeleton", std::move(rig)); }

/// rigProps.ts `replaceIn`: the entry of `key` whose `idKey` is `id` becomes `next`.
Json replace_in(const Json& rig, std::string_view key, std::string_view idKey, const std::string& id, const Json& next) {
  Json::Array list = raw(rig, key);
  for (Json& x : list) {
    if (x.is_object() && x.at(idKey).is_string() && x.at(idKey).str() == id) x = next;
  }
  Json out = rig;
  out.set(key, Json::array(std::move(list)));
  return out;
}

/// Layers a rig can deform: not a camera, light or audio layer.
bool can_rig(const Node& n) {
  const std::string kind = n.kind();
  return kind != "camera" && kind != "light" && kind != "audio";
}

std::set<std::string> part_ids(std::string_view kind, const Json& rig) {
  std::set<std::string> out;
  for (const Json& x : list_of(rig, kind == "skeleton" ? "bones" : "pins")) {
    if (x.at("id").is_string()) out.insert(x.at("id").str());
  }
  return out;
}

std::string default_mesh_mode(const Node& n) {
  const std::string kind = n.kind();
  return kind == "image" || kind == "svg" ? "silhouette" : "grid";
}

void visual_or_fail(const Node& n, const std::string& layer, const std::string& parent) {
  const std::string kind = n.kind();
  if (kind == "camera" || kind == "light" || kind == "audio") {
    fail(ErrorCode::invalid_argument, "a " + kind + " layer cannot carry a rig", {.layer = layer, .path = parent});
  }
}

std::vector<std::string> track_prefixes(std::string_view kind, const std::string& id) {
  if (kind == "pin") return {"puppet." + id + "."};
  std::vector<std::string> ik{"ikTarget." + id + ".", "ikPole." + id + ".", "ikMode." + id};
  if (kind == "bone") ik.insert(ik.begin(), "bone." + id + ".");
  return ik;
}

void drop_tracks(Document& d, std::string_view layer, const std::vector<std::string>& prefixes) {
  const NodeAnim* a = d.anim(layer);
  if (a == nullptr || prefixes.empty()) return;
  std::set<std::string> drop;
  auto match = [&prefixes](const std::string& p) {
    for (const auto& x : prefixes) {
      if (x.ends_with('.') ? p.starts_with(x) : p == x) return true;
    }
    return false;
  };
  for (const auto& [p, v] : a->tracks) {
    if (match(p)) drop.insert(p);
  }
  for (const auto& [p, v] : a->exprs) {
    if (match(p)) drop.insert(p);
  }
  for (const auto& [p, v] : a->data) {
    if (match(p)) drop.insert(p);
  }
  drop_track_props(d, layer, drop);
}

/// Insert at `at` counted among the addressable (id-carrying object) entries.
Json::Array insert_addressable(const Json& rig, std::string_view key, std::size_t at, const Json& x) {
  Json::Array out = raw(rig, key);
  std::size_t real = out.size();
  std::size_t seen = 0;
  for (std::size_t i = 0; i < out.size(); ++i) {
    if (!out[i].is_object() || !out[i].at("id").is_string()) continue;
    if (seen == at) {
      real = i;
      break;
    }
    ++seen;
  }
  out.insert(out.begin() + static_cast<std::ptrdiff_t>(real), x);
  return out;
}

GroupBinding group(std::string name, std::string_view matchName, api::PropertyKind kind = api::PropertyKind::group,
                   bool enabled = true) {
  GroupBinding g;
  g.name = std::move(name);
  g.matchName = std::string(matchName);
  g.kind = kind;
  g.enabled = enabled;
  return g;
}

std::string name_or(const Json* o, const std::string& fb) {
  if (o != nullptr && o->at("name").is_string() && !o->at("name").str().empty()) return o->at("name").str();
  return fb;
}

}  // namespace

// ── bindings ────────────────────────────────────────────────────────────

void add_rig_bindings(const Document& d, const Node& node, std::string_view layerId,
                      const std::function<void(PropBinding)>& add) {
  auto each = [](std::string_view owner, const std::function<void(const Json&)>& fn) {
    for (const Json& s : specs().arr()) {
      if (s.at("owner").str() == owner) fn(s);
    }
  };
  if (can_rig(node)) each("layer", [&](const Json& s) { add(binding("layer", "", "layer", s)); });
  const Json puppet = puppet_of(node);
  if (puppet.is_object()) {
    each("puppet", [&](const Json& s) { add(binding("puppet", "", "puppet", s)); });
    for (const Json& pin : with_ids(list_of(puppet, "pins"))) {
      const std::string id = pin.at("id").str();
      each("pin", [&](const Json& s) { add(binding("pin", id, "puppet/pins/" + id, s)); });
    }
  }
  const Json skel = skeleton_of(node);
  if (skel.is_object()) {
    each("skeleton", [&](const Json& s) { add(binding("skeleton", "", "skeleton", s)); });
    const std::vector<Json> targets = with_ids(list_of(skel, "ikTargets"), "boneId");
    for (const Json& bone : with_ids(list_of(skel, "bones"))) {
      const std::string id = bone.at("id").str();
      each("bone", [&](const Json& s) { add(binding("bone", id, "skeleton/bones/" + id, s)); });
      const Json* target = find_by(targets, "boneId", id);
      if (target == nullptr) continue;
      each("ik", [&](const Json& s) {
        if (s.at("optional").is_bool() && s.at("optional").b() && !has_pole(d, layerId, *target, id)) return;
        add(binding("ik", id, "skeleton/bones/" + id + "/ik", s));
      });
    }
    for (const Json& c : with_ids(list_of(skel, "controllers"))) {
      const std::string id = c.at("id").str();
      each("controller", [&](const Json& s) { add(binding("controller", id, "skeleton/controllers/" + id, s)); });
    }
  }
}

std::vector<std::string> rig_group_paths(const Node& node) {
  std::vector<std::string> out;
  if (puppet_of(node).is_object()) {
    for (const char* p : {"puppet", "puppet/mesh", "puppet/pins"}) out.emplace_back(p);
  }
  if (skeleton_of(node).is_object()) {
    for (const char* p : {"skeleton", "skeleton/mesh", "skeleton/bones", "skeleton/controllers"}) out.emplace_back(p);
  }
  return out;
}

std::optional<GroupBinding> rig_group_info(const Node& node, const std::string& path) {
  const std::vector<std::string> seg = split(path, '/');
  if (seg[0] == "puppet") {
    if (seg.size() == 1) return group("Puppet", kMatchPuppet);
    if (path == "puppet/mesh") return group("Mesh", "ADBE FreePin3 Mesh Atom");
    if (path == "puppet/pins") return group("Deform", "ADBE FreePin3 PosPins", api::PropertyKind::indexed_group);
    if (seg[1] == "pins" && seg.size() == 3) {
      const std::vector<Json> pins = with_ids(list_of(puppet_of(node), "pins"));
      return group(name_or(find_by(pins, "id", seg[2]), seg[2]), kMatchPin);
    }
    return std::nullopt;
  }
  if (seg[0] == "skeleton") {
    const Json skel = skeleton_of(node);
    if (seg.size() == 1) return group("Skeleton", kMatchSkeleton);
    if (path == "skeleton/mesh") return group("Mesh", "Premation Skeleton Mesh");
    if (path == "skeleton/bones") return group("Bones", "Premation Bones", api::PropertyKind::indexed_group);
    if (path == "skeleton/controllers") return group("Controllers", "Premation Rig Controllers", api::PropertyKind::indexed_group);
    if (seg[1] == "bones" && seg.size() == 3) {
      const std::vector<Json> bones = with_ids(list_of(skel, "bones"));
      return group(name_or(find_by(bones, "id", seg[2]), seg[2]), kMatchBone);
    }
    if (seg[1] == "bones" && seg.size() == 4 && seg[3] == "ik") {
      const std::vector<Json> t = with_ids(list_of(skel, "ikTargets"), "boneId");
      const Json* x = find_by(t, "boneId", seg[2]);
      const bool on = !(x != nullptr && x->at("enabled").is_bool() && !x->at("enabled").b());
      return group("IK", kMatchIk, api::PropertyKind::group, on);
    }
    if (seg[1] == "controllers" && seg.size() == 3) {
      const std::vector<Json> cs = with_ids(list_of(skel, "controllers"));
      return group(name_or(find_by(cs, "id", seg[2]), seg[2]), kMatchController);
    }
    return std::nullopt;
  }
  return std::nullopt;
}

std::optional<double> rig_member_factor(std::string_view member) {
  auto mid = [&](std::string_view prefix, std::string_view suffix) {
    if (!member.starts_with(prefix) || !member.ends_with(suffix) || member.size() <= prefix.size() + suffix.size()) return false;
    const std::string_view id = member.substr(prefix.size(), member.size() - prefix.size() - suffix.size());
    return id.find('.') == std::string_view::npos;
  };
  if (mid("puppet.", ".scale")) return 100.0;
  if (mid("bone.", ".scaleX") || mid("bone.", ".scaleY")) return 100.0;
  if (mid("bone.", ".rotation")) return kDeg;
  return std::nullopt;
}

// ── static values ───────────────────────────────────────────────────────

api::Value read_rig_static(const Node& node, const PropBinding& b) {
  const Json& spec = spec_of(b);
  const RigRef& ref = *b.rig;
  Json o = owner_object(node, ref);
  if (!o.is_object()) o = Json::object();
  const double k = scale_of(spec);
  const std::string& codec = spec.at("codec").str();
  const Json& keys = spec.at("keys");
  auto key = [&](std::size_t i) { return std::string_view(keys.arr()[i].str()); };
  if (codec == "number") {
    const Json v = get_key(o, key(0));
    return v_scalar((is_num(v) ? v.num() : num2(spec, 0)) * k);
  }
  if (codec == "xy") {
    const Json x = get_key(o, key(0));
    const Json y = get_key(o, key(1));
    return v_vec2((is_num(x) ? x.num() : num2(spec, 0)) * k, (is_num(y) ? y.num() : num2(spec, 1)) * k);
  }
  if (codec == "point") {
    const Json p = get_key(o, key(0));
    const double x = p.is_object() && is_num(p.at("x")) ? p.at("x").num() : num2(spec, 0);
    const double y = p.is_object() && is_num(p.at("y")) ? p.at("y").num() : num2(spec, 1);
    return v_vec2(x * k, y * k);
  }
  if (codec == "pinPosition") {
    const Json& p = o.at("position");
    if (p.is_object() && is_num(p.at("x")) && is_num(p.at("y"))) return v_vec2(p.at("x").num(), p.at("y").num());
    return v_vec2(is_num(o.at("x")) ? o.at("x").num() : 0.0, is_num(o.at("y")) ? o.at("y").num() : 0.0);
  }
  if (codec == "choice") {
    const Json v = get_key(o, key(0));
    if (v.is_string()) {
      for (const Json& c : spec.at("choices").arr()) {
        if (c.str() == v.str()) return v_choice(v.str());
      }
    }
    return v_choice(spec.at("default").str());
  }
  if (codec == "string") {
    const Json v = get_key(o, key(0));
    return v_string(v.is_string() ? v.str() : "");
  }
  if (codec == "parent") return v_string(o.at("parentId").is_string() ? o.at("parentId").str() : "");
  if (codec == "json" || codec == "wholeRig") {
    const Json v = get_key(o, key(0));
    return v_json(stringify(v.is_undefined() ? Json::null() : v));
  }
  if (codec == "ikMode") return v_scalar(o.at("ikMode").is_string() && o.at("ikMode").str() == "fk" ? 0.0 : 1.0);
  // bind
  const Json skel = skeleton_of(node);
  const Json e = bind_entry(skel.is_object() ? skel : Json::object(), ref.id, o);
  std::vector<double> nums;
  for (std::size_t i = 0; i < keys.arr().size(); ++i) {
    const Json& v = e.at(key(i));
    nums.push_back((is_num(v) ? v.num() : num2(spec, i)) * k);
  }
  return spec.at("type").str() == "vec2" ? v_vec2(nums[0], nums[1]) : v_scalar(nums[0]);
}

void write_rig_static(Document& d, std::string_view layer, const PropBinding& b, const api::Value& value, bool creating) {
  const Json& spec = spec_of(b);
  const RigRef& ref = *b.rig;
  const Node& node = *d.node(layer);
  if (spec.at("codec").str() == "wholeRig") {
    // layer/puppet, layer/skeleton: replace the whole rig; removed pins / bones lose their keys.
    const std::string kind = spec.at("keys").arr()[0].str();
    if (value.kind() != VK::json) type_err(b, value);
    auto parsed = js::parse(get<VK::json>(value));
    if (!parsed) fail(ErrorCode::invalid_argument, "invalid json", {.path = b.path});
    if (!parsed->is_null() && !parsed->is_object()) {
      fail(ErrorCode::invalid_argument, "'" + b.path + "' takes null or a JSON object", {.path = b.path});
    }
    const std::set<std::string> after = part_ids(kind, *parsed);
    std::vector<std::string> beforeOrder;
    for (const Json& x : list_of(node.fx().at(kind), kind == "skeleton" ? "bones" : "pins")) {
      if (x.at("id").is_string()) beforeOrder.push_back(x.at("id").str());
    }
    Json v = parsed->is_null() ? Json() : std::move(*parsed);
    if (kind == "puppet") write_puppet(d, layer, std::move(v));
    else write_skeleton(d, layer, std::move(v));
    std::vector<std::string> prefixes;
    std::set<std::string> seen;
    for (const auto& id : beforeOrder) {
      if (after.contains(id) || !seen.insert(id).second) continue;
      for (auto& p : track_prefixes(kind == "puppet" ? "pin" : "bone", id)) prefixes.push_back(std::move(p));
    }
    drop_tracks(d, layer, prefixes);
    return;
  }
  const Json o = owner_object(node, ref);
  const std::string L(layer);
  if (!o.is_object()) fail(ErrorCode::not_found, "layer '" + L + "' has no '" + b.path + "'", {.layer = L, .path = b.path});
  if (ref.owner == "puppet" || ref.owner == "pin") {
    const Json rig = puppet_of(node);
    Json next = next_owner(node, b, spec, o, value);
    write_puppet(d, layer, ref.owner == "puppet" ? std::move(next) : replace_in(rig, "pins", "id", ref.id, next));
    return;
  }
  Json skel = skeleton_of(node);
  const std::string& codec = spec.at("codec").str();
  if (codec == "bind") {
    const auto nums = api_numbers(b, spec, value);
    const double k = scale_of(spec);
    skel = captured(skel);
    const Json& keys = spec.at("keys");
    const std::vector<Json> bind = list_of(skel, "bindPose");
    const Json* entry = find_by(bind, "id", ref.id);
    auto patch = [&](Json e) {
      for (std::size_t i = 0; i < keys.arr().size(); ++i) e.set(keys.arr()[i].str(), Json::number(nums[i] / k));
      return e;
    };
    if (entry != nullptr) {
      write_skeleton(d, layer, replace_in(skel, "bindPose", "id", ref.id, patch(*entry)));
    } else {
      Json::Array list = raw(skel, "bindPose");
      list.push_back(patch(o));
      skel.set("bindPose", Json::array(std::move(list)));
      write_skeleton(d, layer, std::move(skel));
    }
    return;
  }
  const Json next = next_owner(node, b, spec, o, value);
  if (spec.at("poseCapture").is_bool() && spec.at("poseCapture").b() && !creating) skel = captured(skel);
  if (ref.owner == "skeleton") write_skeleton(d, layer, next);
  else if (ref.owner == "bone") write_skeleton(d, layer, replace_in(skel, "bones", "id", ref.id, next));
  else if (ref.owner == "ik") write_skeleton(d, layer, replace_in(skel, "ikTargets", "boneId", ref.id, next));
  else if (ref.owner == "controller") write_skeleton(d, layer, replace_in(skel, "controllers", "id", ref.id, next));
}

api::Value pin_key_to_api(const Json& v) {
  const Json p = v.is_array() && !v.arr().empty() ? v.arr()[0] : Json();
  return v_vec2(p.is_object() && is_num(p.at("x")) ? p.at("x").num() : 0.0, p.is_object() && is_num(p.at("y")) ? p.at("y").num() : 0.0);
}

Json api_to_pin_key(const PropBinding& b, const api::Value& v) {
  if (v.kind() != VK::vec2) type_err(b, v);
  Json p = Json::object();
  p.set("x", Json::number(get<VK::vec2>(v).x));
  p.set("y", Json::number(get<VK::vec2>(v).y));
  Json out = Json::array();
  out.arr_mut().push_back(std::move(p));
  return out;
}

void pin_key_spatial(const std::optional<Json>& si, const std::optional<Json>& so, std::vector<double>& spatialIn,
                     std::vector<double>& spatialOut) {
  auto first = [](const std::optional<Json>& t) -> Json {
    if (!t || !t->is_array() || t->arr().empty()) return Json();
    return t->arr()[0].is_object() ? t->arr()[0] : Json();
  };
  const Json i = first(si);
  const Json o = first(so);
  if (!i.is_object() && !o.is_object()) {
    spatialIn.clear();
    spatialOut.clear();
    return;
  }
  spatialIn = i.is_object() ? std::vector<double>{i.at("x").num(), i.at("y").num()} : std::vector<double>{0, 0};
  spatialOut = o.is_object() ? std::vector<double>{o.at("x").num(), o.at("y").num()} : std::vector<double>{0, 0};
}

// ── groups ──────────────────────────────────────────────────────────────

std::optional<RigGroupRef> resolve_rig_group(const Node& node, const std::string& layer, const std::string& path) {
  const std::vector<std::string> seg = split(path, '/');
  if (seg[0] != "puppet" && seg[0] != "skeleton") return std::nullopt;
  auto nf = [&]() { fail(ErrorCode::not_found, "layer '" + layer + "' has no group '" + path + "'", {.layer = layer, .path = path}); };
  auto index_in = [](const std::vector<Json>& list, std::string_view idKey, const std::string& id) {
    for (std::size_t i = 0; i < list.size(); ++i) {
      if (list[i].at(idKey).str() == id) return static_cast<int>(i);
    }
    return -1;
  };
  if (seg.size() == 1) {
    if (!(seg[0] == "puppet" ? puppet_of(node) : skeleton_of(node)).is_object()) nf();
    return RigGroupRef{"rigRoot", layer, seg[0], 0};
  }
  if (seg.size() == 3 && seg[0] == "puppet" && seg[1] == "pins") {
    const int i = index_in(with_ids(list_of(puppet_of(node), "pins")), "id", seg[2]);
    if (i < 0) nf();
    return RigGroupRef{"pin", layer, seg[2], i};
  }
  if (seg.size() == 3 && seg[0] == "skeleton" && (seg[1] == "bones" || seg[1] == "controllers")) {
    const int i = index_in(with_ids(list_of(skeleton_of(node), seg[1])), "id", seg[2]);
    if (i < 0) nf();
    return RigGroupRef{seg[1] == "bones" ? "bone" : "controller", layer, seg[2], i};
  }
  if (seg.size() == 4 && seg[0] == "skeleton" && seg[1] == "bones" && seg[3] == "ik") {
    if (index_in(with_ids(list_of(skeleton_of(node), "ikTargets"), "boneId"), "boneId", seg[2]) < 0) nf();
    return RigGroupRef{"ik", layer, seg[2], 0};
  }
  nf();
  return std::nullopt;
}

std::string rig_group_path(const RigGroupRef& r) {
  if (r.kind == "rigRoot") return r.id;
  if (r.kind == "pin") return "puppet/pins/" + r.id;
  if (r.kind == "bone") return "skeleton/bones/" + r.id;
  if (r.kind == "controller") return "skeleton/controllers/" + r.id;
  return "skeleton/bones/" + r.id + "/ik";
}

const std::vector<RigGroupType>& rig_group_types() {
  static const std::vector<RigGroupType> kTypes{
      {"", std::string(kMatchPuppet), "Puppet"},
      {"puppet/pins", std::string(kMatchPin), "Puppet Pin"},
      {"", std::string(kMatchSkeleton), "Skeleton"},
      {"skeleton/bones", std::string(kMatchBone), "Bone"},
      {"skeleton/bones/*", std::string(kMatchIk), "IK Goal"},
      {"skeleton/controllers", std::string(kMatchController), "Rig Controller"},
  };
  return kTypes;
}

std::optional<RigAddPlan> plan_rig_add(
    Document& d, const std::string& layer, const std::string& parent, const std::string& matchName,
    std::optional<std::uint32_t> index, const std::optional<std::string>& name, const std::vector<api::PropertyInit>& init,
    const std::function<std::string(std::string_view, const std::function<bool(const std::string&)>&)>& mint) {
  const Node& node = *d.node(layer);
  const std::vector<std::string> seg = split(parent, '/');
  // Copies: the plan runs after this function returns.
  auto apply_init = [&d, layer, init](const std::string& path) {
    const Catalog cat = catalog_for(d, layer);
    for (const auto& i : init) {
      const PropBinding& b = require_binding(cat, path + "/" + i.path);
      if (b.special != Special::rig) {
        fail(ErrorCode::invalid_argument, "'" + path + "/" + i.path + "' cannot be initialised", {.layer = layer, .path = path + "/" + i.path});
      }
      write_rig_static(d, layer, b, i.value, true);
    }
  };
  auto check_index = [&](std::size_t count) {
    const std::size_t at = index ? *index : count;
    if (at > count) {
      fail(ErrorCode::out_of_range, "index " + std::to_string(at) + " is past the " + std::to_string(count) + " entries of '" + parent + "'",
           {.layer = layer, .path = parent});
    }
    return at;
  };

  if (parent.empty() && (matchName == kMatchPuppet || matchName == kMatchSkeleton)) {
    visual_or_fail(node, layer, parent);
    const std::string root = matchName == kMatchPuppet ? "puppet" : "skeleton";
    if ((root == "puppet" ? puppet_of(node) : skeleton_of(node)).is_object()) {
      fail(ErrorCode::conflict, "layer '" + layer + "' already has a " + root, {.layer = layer, .path = root});
    }
    const std::string mode = default_mesh_mode(node);
    return RigAddPlan{root, [&d, layer, root, mode, apply_init]() {
                        if (root == "puppet") {
                          Json p = Json::object();
                          p.set("pins", Json::array());
                          p.set("meshMode", Json::string(mode));
                          p.set("meshExpansion", Json::number(0));
                          p.set("meshDensity", Json::number(kMeshDensityDefault));
                          write_puppet(d, layer, std::move(p));
                        } else {
                          Json s = Json::object();
                          s.set("bones", Json::array());
                          s.set("ikTargets", Json::array());
                          if (mode == "silhouette") s.set("meshMode", Json::string("silhouette"));
                          write_skeleton(d, layer, std::move(s));
                        }
                        apply_init(root);
                      }};
  }

  if (parent == "puppet/pins" && matchName == kMatchPin) {
    visual_or_fail(node, layer, parent);
    const Json rig = puppet_of(node);
    const std::vector<Json> pins = with_ids(list_of(rig, "pins"));
    const std::size_t at = check_index(pins.size());
    const std::string id = mint("pin_", [&pins](const std::string& x) { return find_by(pins, "id", x) != nullptr; });
    std::string kind = "advanced";
    for (const auto& i : init) {
      if (i.path == "kind" && (i.value.kind() == VK::choice || i.value.kind() == VK::string)) {
        kind = i.value.kind() == VK::choice ? get<VK::choice>(i.value) : get<VK::string>(i.value);
        break;
      }
    }
    const std::string mode = default_mesh_mode(node);
    const std::string pinName = name ? *name : "Pin " + std::to_string(pins.size() + 1);
    const std::size_t count = pins.size();
    const std::string path = "puppet/pins/" + id;
    return RigAddPlan{path, [&d, layer, rig, at, id, kind, mode, pinName, count, path, apply_init]() {
                        Json pin = Json::object();
                        pin.set("id", Json::string(id));
                        pin.set("name", Json::string(pinName));
                        pin.set("x", Json::number(0));
                        pin.set("y", Json::number(0));
                        pin.set("kind", Json::string("advanced"));
                        if (kind == "starch") pin.set("stiffness", Json::number(8));
                        if (kind == "overlap") pin.set("overlap", Json::number(50));
                        Json next;
                        if (!rig.is_object()) {
                          next = Json::object();
                          Json list = Json::array();
                          list.arr_mut().push_back(pin);
                          next.set("pins", std::move(list));
                          next.set("meshMode", Json::string(mode));
                          next.set("meshExpansion", Json::number(0));
                          next.set("meshDensity", Json::number(kMeshDensityDefault));
                        } else {
                          next = rig;
                          next.set("pins", Json::array(insert_addressable(rig, "pins", at, pin)));
                          if (count == 0) {
                            if (next.at("meshMode").is_undefined()) next.set("meshMode", Json::string(mode));
                            if (next.at("meshExpansion").is_undefined()) next.set("meshExpansion", Json::number(0));
                            if (next.at("meshDensity").is_undefined()) next.set("meshDensity", Json::number(kMeshDensityDefault));
                          }
                        }
                        write_puppet(d, layer, std::move(next));
                        apply_init(path);
                      }};
  }

  if (parent == "skeleton/bones" && matchName == kMatchBone) {
    visual_or_fail(node, layer, parent);
    const Json skel = skeleton_of(node);
    const std::vector<Json> bones = with_ids(list_of(skel, "bones"));
    const std::size_t at = check_index(bones.size());
    const std::string id = mint("bone_", [&bones](const std::string& x) { return find_by(bones, "id", x) != nullptr; });
    const std::string boneName = name ? *name : "Bone " + std::to_string(bones.size() + 1);
    const bool first = bones.empty();
    const bool sil = default_mesh_mode(node) == "silhouette";
    const std::string path = "skeleton/bones/" + id;
    return RigAddPlan{path, [&d, layer, skel, at, id, boneName, first, sil, path, apply_init]() {
                        Json bone = Json::object();
                        bone.set("id", Json::string(id));
                        bone.set("name", Json::string(boneName));
                        bone.set("parentId", Json::null());
                        bone.set("length", Json::number(100));
                        bone.set("x", Json::number(0));
                        bone.set("y", Json::number(0));
                        bone.set("rotation", Json::number(0));
                        Json next = skel.is_object() ? skel : Json::object();
                        next.set("bones", Json::array(insert_addressable(skel.is_object() ? skel : Json::object(), "bones", at, bone)));
                        const Json& t = skel.is_object() ? skel.at("ikTargets") : Json();
                        next.set("ikTargets", t.is_undefined() || t.is_null() ? Json::array() : t);
                        if (first && next.at("meshMode").is_undefined() && sil) next.set("meshMode", Json::string("silhouette"));
                        write_skeleton(d, layer, std::move(next));
                        apply_init(path);
                      }};
  }

  if (seg.size() == 3 && seg[0] == "skeleton" && seg[1] == "bones" && matchName == kMatchIk) {
    const Json skel = skeleton_of(node);
    const std::string boneId = seg[2];
    if (find_by(with_ids(list_of(skel, "bones")), "id", boneId) == nullptr) {
      fail(ErrorCode::not_found, "no bone '" + boneId + "'", {.layer = layer, .path = parent});
    }
    if (find_by(with_ids(list_of(skel, "ikTargets"), "boneId"), "boneId", boneId) != nullptr) {
      fail(ErrorCode::conflict, "bone '" + boneId + "' already has an IK goal", {.layer = layer, .path = parent + "/ik"});
    }
    if (index) fail(ErrorCode::invalid_argument, "an IK goal has no index", {.layer = layer, .path = parent});
    const std::string path = parent + "/ik";
    return RigAddPlan{path, [&d, layer, boneId, path, apply_init]() {
                        Json s = skeleton_of(*d.node(layer));
                        Json list = copy_list(list_of(s, "ikTargets"));
                        Json t = Json::object();
                        t.set("boneId", Json::string(boneId));
                        t.set("x", Json::number(0));
                        t.set("y", Json::number(0));
                        list.arr_mut().push_back(std::move(t));
                        s.set("ikTargets", std::move(list));
                        write_skeleton(d, layer, std::move(s));
                        apply_init(path);
                      }};
  }

  if (parent == "skeleton/controllers" && matchName == kMatchController) {
    const Json skel = skeleton_of(node);
    if (!skel.is_object()) fail(ErrorCode::not_found, "layer '" + layer + "' has no skeleton", {.layer = layer, .path = parent});
    const std::vector<Json> list = with_ids(list_of(skel, "controllers"));
    const std::size_t at = check_index(list.size());
    const std::string id = mint("ctrl_", [&list](const std::string& x) { return find_by(list, "id", x) != nullptr; });
    const std::string path = "skeleton/controllers/" + id;
    return RigAddPlan{path, [&d, layer, skel, at, id, name, path, apply_init]() {
                        Json c = Json::object();
                        c.set("id", Json::string(id));
                        if (name) c.set("name", Json::string(*name));
                        c.set("shape", Json::string("circle"));
                        c.set("side", Json::string("centre"));
                        c.set("size", Json::number(14));
                        Json link = Json::object();
                        link.set("kind", Json::string("ikTarget"));
                        link.set("boneId", Json::string(""));
                        c.set("link", std::move(link));
                        Json next = skel;
                        next.set("controllers", Json::array(insert_addressable(skel, "controllers", at, c)));
                        write_skeleton(d, layer, std::move(next));
                        apply_init(path);
                      }};
  }
  return std::nullopt;
}

void remove_rig_group(Document& d, const RigGroupRef& r) {
  const Node& node = *d.node(r.layer);
  if (r.kind == "rigRoot") {
    if (r.id == "puppet") {
      write_puppet(d, r.layer, Json());
      drop_tracks(d, r.layer, {"puppet."});
    } else {
      write_skeleton(d, r.layer, Json());
      drop_tracks(d, r.layer, {"bone.", "ikTarget.", "ikPole.", "ikMode."});
    }
    return;
  }
  if (r.kind == "pin") {
    Json rig = puppet_of(node);
    if (!rig.is_object()) return;
    Json::Array list = raw(rig, "pins");
    std::erase_if(list, [&](const Json& p) { return p.is_object() && p.at("id").is_string() && p.at("id").str() == r.id; });
    rig.set("pins", Json::array(std::move(list)));
    write_puppet(d, r.layer, std::move(rig));
    drop_tracks(d, r.layer, track_prefixes("pin", r.id));
    return;
  }
  if (r.kind == "bone") {
    Json skel = skeleton_of(node);
    if (!skel.is_object()) return;
    const std::vector<Json> bones = list_of(skel, "bones");
    std::vector<std::string> order{r.id};
    std::set<std::string> removed{r.id};
    bool changed = true;
    while (changed) {
      changed = false;
      for (const Json& b : bones) {
        if (b.at("parentId").is_string() && removed.contains(b.at("parentId").str()) && b.at("id").is_string() &&
            !removed.contains(b.at("id").str())) {
          removed.insert(b.at("id").str());
          order.push_back(b.at("id").str());
          changed = true;
        }
      }
    }
    auto gone = [&](const Json& x, std::string_view key) {
      return x.is_object() && x.at(key).is_string() && removed.contains(x.at(key).str());
    };
    Json next = skel;
    Json::Array bl = raw(skel, "bones");
    std::erase_if(bl, [&](const Json& b) { return gone(b, "id"); });
    next.set("bones", Json::array(std::move(bl)));
    Json::Array tl = raw(skel, "ikTargets");
    std::erase_if(tl, [&](const Json& t) { return gone(t, "boneId"); });
    next.set("ikTargets", Json::array(std::move(tl)));
    if (skel.at("controllers").is_array()) {
      Json::Array cl = skel.at("controllers").arr();
      std::erase_if(cl, [&](const Json& c) {
        return c.is_object() && c.at("link").is_object() && c.at("link").at("boneId").is_string() &&
               removed.contains(c.at("link").at("boneId").str());
      });
      next.set("controllers", Json::array(std::move(cl)));
    }
    const Json& wp = skel.at("weightPaint");
    if (wp.is_object() && wp.at("bones").is_object()) {
      Json wb = Json::object();
      for (const auto& m : wp.at("bones").obj()) {
        if (!removed.contains(m.key)) wb.set(m.key, m.value);
      }
      Json w = wp;
      w.set("bones", std::move(wb));
      next.set("weightPaint", std::move(w));
    } else {
      next.erase("weightPaint");
    }
    if (skel.at("bindPose").is_array()) {
      Json::Array bp = skel.at("bindPose").arr();
      std::erase_if(bp, [&](const Json& b) { return gone(b, "id"); });
      next.set("bindPose", Json::array(std::move(bp)));
    }
    write_skeleton(d, r.layer, std::move(next));
    std::vector<std::string> prefixes;
    for (const auto& id : order) {
      for (auto& p : track_prefixes("bone", id)) prefixes.push_back(std::move(p));
    }
    drop_tracks(d, r.layer, prefixes);
    return;
  }
  if (r.kind == "ik") {
    Json skel = skeleton_of(node);
    if (!skel.is_object()) return;
    Json list = Json::array();
    for (const Json& t : list_of(skel, "ikTargets")) {
      if (!(t.at("boneId").is_string() && t.at("boneId").str() == r.id)) list.arr_mut().push_back(t);
    }
    skel.set("ikTargets", std::move(list));
    write_skeleton(d, r.layer, std::move(skel));
    drop_tracks(d, r.layer, track_prefixes("ik", r.id));
    return;
  }
  if (r.kind == "controller") {
    Json skel = skeleton_of(node);
    if (!skel.is_object()) return;
    Json::Array list = raw(skel, "controllers");
    std::erase_if(list, [&](const Json& c) { return c.is_object() && c.at("id").is_string() && c.at("id").str() == r.id; });
    skel.set("controllers", Json::array(std::move(list)));
    write_skeleton(d, r.layer, std::move(skel));
  }
}

void move_rig_group(Document& d, const RigGroupRef& r, std::size_t toIndex) {
  if (r.kind != "pin" && r.kind != "bone" && r.kind != "controller") {
    fail(ErrorCode::unsupported, "'" + rig_group_path(r) + "' has no order", {.layer = r.layer, .path = rig_group_path(r)});
  }
  const Node& node = *d.node(r.layer);
  Json rig = r.kind == "pin" ? puppet_of(node) : skeleton_of(node);
  const std::string key = r.kind == "pin" ? "pins" : r.kind == "bone" ? "bones" : "controllers";
  const Json::Array all = raw(rig, key);
  auto addressable = [](const Json& x) { return x.is_object() && x.at("id").is_string(); };
  Json::Array moved;
  for (const Json& x : all) {
    if (addressable(x)) moved.push_back(x);
  }
  if (toIndex >= moved.size()) fail(ErrorCode::out_of_range, "toIndex past the end", {.layer = r.layer, .path = rig_group_path(r)});
  const Json x = moved[static_cast<std::size_t>(r.index)];
  moved.erase(moved.begin() + r.index);
  moved.insert(moved.begin() + static_cast<std::ptrdiff_t>(toIndex), x);
  Json::Array next;
  std::size_t i = 0;
  for (const Json& e : all) next.push_back(addressable(e) ? moved[i++] : e);
  rig.set(key, Json::array(std::move(next)));
  if (r.kind == "pin") write_puppet(d, r.layer, std::move(rig));
  else write_skeleton(d, r.layer, std::move(rig));
}

void rename_rig_group(Document& d, const RigGroupRef& r, const std::string& name) {
  if (r.kind != "pin" && r.kind != "bone" && r.kind != "controller") {
    fail(ErrorCode::unsupported, "'" + rig_group_path(r) + "' cannot be renamed", {.layer = r.layer, .path = rig_group_path(r)});
  }
  const Node& node = *d.node(r.layer);
  const Json rig = r.kind == "pin" ? puppet_of(node) : skeleton_of(node);
  const std::string key = r.kind == "pin" ? "pins" : r.kind == "bone" ? "bones" : "controllers";
  bool blank = true;
  for (const char c : name) blank = blank && (c == ' ' || c == '\t' || c == '\n' || c == '\r');
  const std::vector<Json> entries = list_of(rig, key);
  const Json* e = find_by(entries, "id", r.id);
  const Json next = set_key(*e, "name", blank ? Json() : Json::string(name));
  Json out = replace_in(rig, key, "id", r.id, next);
  if (r.kind == "pin") write_puppet(d, r.layer, std::move(out));
  else write_skeleton(d, r.layer, std::move(out));
}

void set_rig_group_enabled(Document& d, const RigGroupRef& r, bool on) {
  if (r.kind != "ik") fail(ErrorCode::unsupported, "'" + rig_group_path(r) + "' has no switch", {.layer = r.layer, .path = rig_group_path(r)});
  const Json skel = skeleton_of(*d.node(r.layer));
  const std::vector<Json> t = list_of(skel, "ikTargets");
  const Json* x = find_by(t, "boneId", r.id);
  write_skeleton(d, r.layer, replace_in(skel, "ikTargets", "boneId", r.id, set_key(*x, "enabled", on ? Json() : Json::boolean(false))));
}

// ── optional properties (the IK pole) ───────────────────────────────────

std::optional<std::string> ik_parent_of(const std::string& path) {
  const std::vector<std::string> seg = split(path, '/');
  if (seg.size() == 4 && seg[0] == "skeleton" && seg[1] == "bones" && seg[3] == "ik") return seg[2];
  return std::nullopt;
}

std::function<void()> plan_ik_add_properties(Document& d, const std::string& layer, const std::string& parentPath,
                                             const std::vector<std::string>& names) {
  const Node& node = *d.node(layer);
  const std::string boneId = *ik_parent_of(parentPath);
  const std::vector<Json> targets = with_ids(list_of(skeleton_of(node), "ikTargets"), "boneId");
  const Json* target = find_by(targets, "boneId", boneId);
  if (target == nullptr) fail(ErrorCode::not_found, "layer '" + layer + "' has no group '" + parentPath + "'", {.layer = layer, .path = parentPath});
  for (const auto& n : names) {
    if (n != "pole") {
      fail(ErrorCode::invalid_argument, "'" + n + "' is not an optional property of an IK goal", {.layer = layer, .path = parentPath + "/" + n});
    }
  }
  const bool present = has_pole(d, layer, *target, boneId);
  const Json t = *target;
  return [&d, layer, boneId, present, t]() {
    if (present) return;
    const Json skel = skeleton_of(*d.node(layer));
    Json next = t;
    Json pole = Json::object();
    pole.set("x", Json::number(0));
    pole.set("y", Json::number(0));
    next.set("pole", std::move(pole));
    write_skeleton(d, layer, replace_in(skel, "ikTargets", "boneId", boneId, next));
  };
}

std::optional<IkRemovePlan> plan_ik_remove_property(Document& d, const std::string& layer, const std::string& path) {
  const std::size_t slash = path.rfind('/');
  if (slash == std::string::npos) return std::nullopt;
  const auto boneId = ik_parent_of(path.substr(0, slash));
  if (!boneId) return std::nullopt;
  const std::string name = path.substr(slash + 1);
  if (name != "pole") fail(ErrorCode::invalid_argument, "'" + path + "' is not an optional property (it cannot be removed)", {.layer = layer, .path = path});
  const std::vector<Json> targets = with_ids(list_of(skeleton_of(*d.node(layer)), "ikTargets"), "boneId");
  const Json* target = find_by(targets, "boneId", *boneId);
  if (target == nullptr || !has_pole(d, layer, *target, *boneId)) {
    fail(ErrorCode::not_found, "layer '" + layer + "' has no property '" + path + "'", {.layer = layer, .path = path});
  }
  const std::string id = *boneId;
  return IkRemovePlan{layer + "|" + path, [&d, layer, id]() {
                        const Json skel = skeleton_of(*d.node(layer));
                        const std::vector<Json> t = list_of(skel, "ikTargets");
                        const Json* x = find_by(t, "boneId", id);
                        write_skeleton(d, layer, replace_in(skel, "ikTargets", "boneId", id, set_key(*x, "pole", Json())));
                        drop_track_props(d, layer, {"ikPole." + id + ".x", "ikPole." + id + ".y"});
                      }};
}

}  // namespace premation::doc
