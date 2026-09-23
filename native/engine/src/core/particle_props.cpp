#include "particle_props.hpp"

#include <vector>

#include "catalog_data.hpp"
#include "meta.hpp"
#include "scene.hpp"
#include "values.hpp"

namespace premation::doc {
namespace {

constexpr std::string_view kPrefix = "particle.";

const Json& keys_of(std::string_view list) { return registry().fields.at("particle").at(list); }

bool in_list(const Json& list, std::string_view key) {
  if (!list.is_array()) return false;
  for (const Json& k : list.arr()) {
    if (k.is_string() && k.str() == key) return true;
  }
  return false;
}

/// fx.particle when it is an object.
const Json* fx_particle(const Node& n) {
  const Json& raw = n.fx().at("particle");
  return raw.is_object() ? &raw : nullptr;
}

bool has_particle_props(const Node& n) { return n.kind() == "particle" && fx_particle(n) != nullptr; }

/// `particle.<key>` → key (empty when not one).
std::string_view particle_key(std::string_view member) {
  return member.starts_with(kPrefix) && member.size() > kPrefix.size() ? member.substr(kPrefix.size()) : std::string_view{};
}

/// `{...DEFAULT_PARTICLE_CONFIG, ...fx.particle}[key]` (undefined when neither has it).
Json merged_at(const Node& n, std::string_view key) {
  const Json* raw = fx_particle(n);
  if (raw != nullptr && raw->has(key)) return raw->at(key);
  return registry().factory.at("particle").at(key);
}

}  // namespace

void add_particle_bindings(const Node& node, const std::function<void(PropBinding)>& add,
                           const std::function<bool(std::string_view)>& claimed) {
  if (!has_particle_props(node)) return;
  const Json& defaults = registry().factory.at("particle");
  for (const Json& k : keys_of("numeric").arr()) {
    const std::string key = k.str();
    const std::string member = std::string(kPrefix) + key;
    if (claimed(member)) continue;
    const PropertyMeta meta = resolve_property_meta(member, &node);
    PropBinding b;
    b.path = "layer/" + member;
    b.name = meta.label.empty() ? member : meta.label;
    b.matchName = member;
    b.valueType = api::ValueType::scalar;
    b.members = {member};
    b.animatable = true;
    b.unit = meta.unit;
    const Json& def = defaults.at(key);
    if (def.is_number()) b.defaultValue = v_scalar(def.num());
    add(std::move(b));
  }
  for (const Json& k : keys_of("color").arr()) {
    const std::string base = std::string(kPrefix) + k.str();
    std::vector<std::string> members{base + "_r", base + "_g", base + "_b", base + "_a"};
    bool taken = false;
    for (const auto& m : members) taken = taken || claimed(m);
    if (taken) continue;
    const PropertyMeta meta = resolve_property_meta(base, &node);
    PropBinding b;
    b.path = "layer/" + base;
    b.name = meta.label.empty() ? base : meta.label;
    b.matchName = base;
    b.valueType = api::ValueType::color;
    b.members = std::move(members);
    b.colorBase = base;
    b.animatable = true;
    add(std::move(b));
  }
}

std::optional<double> read_particle_static(const Node& node, std::string_view member) {
  const std::string_view key = particle_key(member);
  if (key.empty() || !in_list(keys_of("numeric"), key)) return std::nullopt;
  const Json v = merged_at(node, key);
  return v.is_finite_number() ? std::optional<double>(v.num()) : std::nullopt;
}

std::optional<bool> write_particle_static(Document& d, std::string_view nodeId, std::string_view member, double value) {
  const std::string_view key = particle_key(member);
  if (key.empty() || !in_list(keys_of("numeric"), key)) return std::nullopt;
  const Node* n = d.node(nodeId);
  const Json* cur = n != nullptr ? fx_particle(*n) : nullptr;
  if (cur == nullptr) return false;
  Json next = *cur;
  next.set(key, Json::number(value));
  sg_set_fx(d, nodeId, "particle", std::move(next));
  return true;
}

std::optional<std::string> read_particle_color(const Node& node, std::string_view base) {
  const std::string_view key = particle_key(base);
  if (key.empty() || !in_list(keys_of("color"), key)) return std::nullopt;
  Json v = merged_at(node, key);
  if (v.is_undefined() || v.is_null()) v = merged_at(node, "colorStart");
  return v.is_string() ? std::optional<std::string>(v.str()) : std::nullopt;
}

std::optional<bool> write_particle_color(Document& d, std::string_view nodeId, std::string_view base, const std::string& hex) {
  const std::string_view key = particle_key(base);
  if (key.empty() || !in_list(keys_of("color"), key)) return std::nullopt;
  const Node* n = d.node(nodeId);
  const Json* cur = n != nullptr ? fx_particle(*n) : nullptr;
  if (cur == nullptr) return false;
  Json next = *cur;
  next.set(key, Json::string(hex));
  sg_set_fx(d, nodeId, "particle", std::move(next));
  return true;
}

}  // namespace premation::doc
