#include "catalog_data.hpp"

#include "native_effects.hpp"

#include <cstdio>
#include <cstdlib>
#include <string>

namespace premation::doc {
namespace {

#include "generated/catalog_data.inc"

std::optional<double> opt_num(const Json& o, std::string_view k) { return o.number_at(k); }
std::optional<std::string> opt_str(const Json& o, std::string_view k) { return o.string_at(k); }

Registry build() {
  std::string text;
  for (const char* chunk : kCatalogJsonChunks) text += chunk;
  const auto parsed = js::parse(text);
  if (!parsed) {
    // The data is generated and pinned by a test; failing to parse it is a
    // build defect, not a runtime condition to recover from.
    std::fputs("premation-engine: generated catalog data does not parse\n", stderr);
    std::abort();
  }
  const Json& d = *parsed;
  Registry c;
  for (const Json& e : d.at("effects").arr()) {
    EffectDef def;
    def.type = e.at("type").str();
    def.label = e.at("label").str();
    def.gpuOnly = e.bool_at("gpuOnly").value_or(false);
    for (const Json& p : e.at("params").arr()) {
      EffectParamDef pd;
      pd.key = p.at("key").str();
      pd.label = p.at("label").str();
      pd.type = p.at("type").str();
      for (const Json& o : p.at("options").arr()) pd.options.push_back({o.at("value").num(), o.at("label").str()});
      pd.group = opt_str(p, "group");
      pd.unit = opt_str(p, "unit");
      pd.min = opt_num(p, "min");
      pd.max = opt_num(p, "max");
      pd.precision = opt_num(p, "precision");
      pd.def = p.at("default");
      def.params.push_back(std::move(pd));
    }
    if (e.has("newInstanceParams")) def.newInstanceParams = e.at("newInstanceParams");
    c.effectIndex.emplace(def.type, c.effects.size());
    c.effects.push_back(std::move(def));
  }
  for (const auto& m : d.at("staticMeta").obj()) {
    StaticMeta s;
    const Json& v = m.value;
    s.label = v.at("label").str();
    s.group = v.at("group").str();
    s.type = v.at("type").str();
    s.unit = v.at("unit").str();
    s.min = opt_num(v, "min");
    s.max = opt_num(v, "max");
    s.defaultValue = v.at("defaultValue");
    s.keyframeable = v.bool_at("keyframeable").value_or(true);
    s.displayScale = opt_num(v, "displayScale");
    c.staticMeta.emplace(m.key, std::move(s));
  }
  c.layerStyles = d.at("layerStyles");
  c.pathOps = d.at("pathOps");
  c.polystar = d.at("polystar");
  c.animators = d.at("animators");
  c.fields = d.at("fields");
  c.paint = d.at("paint");
  c.strokeTracks = d.at("strokeTracks");
  c.latent = d.at("latent");
  for (const Json& k : d.at("maskKeys").arr()) c.maskKeys.push_back(k.str());
  for (const Json& k : d.at("textPathParams").arr()) c.textPathParams.push_back(k.str());
  for (const Json& l : d.at("labels").arr()) {
    c.labelColors.push_back(l.at("color").str());
    c.labelIds.push_back(l.at("id").str());
  }
  c.presets = d.at("presets");
  c.factory = d.at("factory");
  for (const Json& b : d.at("blendModes").arr()) c.blendModes.push_back(b.str());
  for (const Json& cmd : d.at("commands").arr()) {
    c.commandKinds.emplace(static_cast<std::uint32_t>(cmd.at("id").num()), cmd.at("kind").str());
    c.commandNames.emplace(static_cast<std::uint32_t>(cmd.at("id").num()), cmd.at("type").str());
  }
  return c;
}

}  // namespace

const EffectParamDef* EffectDef::param(std::string_view key) const noexcept {
  for (const auto& p : params) {
    if (p.key == key) return &p;
  }
  return nullptr;
}

const EffectParamDef* EffectDef::primary() const noexcept {
  for (const auto& p : params) {
    if (p.type == "number") return &p;
  }
  return nullptr;
}

const EffectDef* Registry::effect(std::string_view type) const noexcept {
  const auto it = effectIndex.find(type);
  if (it != effectIndex.end()) return &effects[it->second];
  // G1: a native SDK plugin effect the plugin host registered (native_effects.hpp).
  const NativeEffect* native = NativeEffects::find(type);
  return native != nullptr ? &native->def : nullptr;
}

const StaticMeta* Registry::meta(std::string_view path) const noexcept {
  const auto it = staticMeta.find(path);
  return it != staticMeta.end() ? &it->second : nullptr;
}

const Registry& registry() {
  static const Registry kCatalog = build();
  return kCatalog;
}

}  // namespace premation::doc
