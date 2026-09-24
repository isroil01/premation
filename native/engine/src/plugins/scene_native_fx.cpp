#include "scene_native_fx.hpp"

#include "fxstate.hpp"
#include "native_effects.hpp"
#include "props.hpp"

namespace premation::scene {
namespace {

void put_num(api::RenderEffect& e, std::string name, double v) {
  api::RenderEffectParam p;
  p.name = std::move(name);
  p.kind = api::RenderParamKind::number;
  p.number = v;
  e.params.push_back(std::move(p));
}

void put_flag(api::RenderEffect& e, std::string name, bool v) {
  api::RenderEffectParam p;
  p.name = std::move(name);
  p.kind = api::RenderParamKind::flag;
  p.number = v ? 1 : 0;
  e.params.push_back(std::move(p));
}

void put_text(api::RenderEffect& e, std::string name, std::string v) {
  api::RenderEffectParam p;
  p.name = std::move(name);
  p.kind = api::RenderParamKind::text;
  p.text = std::move(v);
  e.params.push_back(std::move(p));
}

void put_nums(api::RenderEffect& e, std::string name, std::vector<double> v, api::RenderParamKind kind) {
  api::RenderEffectParam p;
  p.name = std::move(name);
  p.kind = kind;
  p.numbers = std::move(v);
  e.params.push_back(std::move(p));
}

/// A mask path of the layer (as the snapshot resolved it at the frame) → 6 doubles per vertex.
std::optional<std::pair<std::vector<double>, bool>> mask_path(const RLayer& l, std::string_view maskId) {
  const Json& paths = l.mask.at("paths");
  if (!paths.is_array()) return std::nullopt;
  for (const Json& p : paths.arr()) {
    if (!(p.at("id").is_string() && p.at("id").str() == maskId)) continue;
    const api::BezierPath b = doc::mask_to_bezier(p);
    std::vector<double> out;
    const std::size_t n = b.vertices.size() / 2;
    out.reserve(n * 6);
    for (std::size_t i = 0; i < n; ++i) {
      out.push_back(b.vertices[i * 2]);
      out.push_back(b.vertices[i * 2 + 1]);
      out.push_back(i * 2 + 1 < b.in_tangents.size() ? b.in_tangents[i * 2] : 0);
      out.push_back(i * 2 + 1 < b.in_tangents.size() ? b.in_tangents[i * 2 + 1] : 0);
      out.push_back(i * 2 + 1 < b.out_tangents.size() ? b.out_tangents[i * 2] : 0);
      out.push_back(i * 2 + 1 < b.out_tangents.size() ? b.out_tangents[i * 2 + 1] : 0);
    }
    return std::make_pair(std::move(out), b.closed);
  }
  return std::nullopt;
}

}  // namespace

bool is_native_effect(std::string_view type) noexcept { return doc::NativeEffects::find(type) != nullptr; }

std::optional<api::RenderEffect> native_effect_entry(const Json& e, const Json& params, const RLayer& l) {
  const std::string type = e.at("type").is_string() ? e.at("type").str() : std::string();
  const doc::NativeEffect* ne = doc::NativeEffects::find(type);
  if (ne == nullptr) return std::nullopt;
  const std::string effectId = e.at("id").is_string() ? e.at("id").str() : std::string();
  api::RenderEffect out;
  out.type = "native-plugin";
  put_text(out, "matchName", type);
  put_text(out, "instance", l.id + "/" + effectId);
  put_text(out, "layerId", l.id);
  put_num(out, "layerW", l.width);
  put_num(out, "layerH", l.height);
  if (l.draft) put_flag(out, "draft", true);
  for (const doc::EffectParamDef& p : ne->def.params) {
    const Json& v = params.at(p.key);
    const std::string name = "p." + p.key;
    if (p.type == "number" || p.type == "enum") {
      put_num(out, name, v.is_number() ? v.num() : p.def.is_number() ? p.def.num() : 0);
    } else if (p.type == "checkbox") {
      put_flag(out, name, (v.is_bool() && v.b()) || (v.is_number() && v.num() != 0));
    } else if (p.type == "color") {
      const std::string hex = v.is_string() ? v.str() : p.def.is_string() ? p.def.str() : "#ffffff";
      const auto c = doc::parse_color_channels(hex);
      put_nums(out, name, {c[0], c[1], c[2], c[3]}, api::RenderParamKind::color);
    } else if (p.type == "layer") {
      put_text(out, name, v.is_string() ? v.str() : "");
    } else if (p.type == "maskPath") {
      if (v.is_string() && !v.str().empty()) {
        if (auto path = mask_path(l, v.str())) {
          put_nums(out, name, std::move(path->first), api::RenderParamKind::numbers);
          put_flag(out, name + ".closed", path->second);
        }
      }
    }
  }
  return out;
}

}  // namespace premation::scene
