#include "fx_wire.hpp"

#include <cmath>

#include "native_effects.hpp"

namespace premation::plugins {
namespace {

const api::RenderEffectParam* find(const api::RenderEffect& e, std::string_view name) {
  for (const auto& p : e.params) {
    if (p.name == name) return &p;
  }
  return nullptr;
}

double num(const api::RenderEffect& e, std::string_view name, double def) {
  const auto* p = find(e, name);
  if (p == nullptr) return def;
  if (p->kind == api::RenderParamKind::number || p->kind == api::RenderParamKind::flag) return p->number;
  return def;
}

std::string text(const api::RenderEffect& e, std::string_view name) {
  const auto* p = find(e, name);
  return p != nullptr ? p->text : std::string();
}

}  // namespace

std::string checkout_renderable_id(std::string_view layerId, std::int64_t time) {
  return std::string(layerId) + "@" + std::to_string(time);
}

void decode_native_fx(const api::RenderEffect& e, const EffectSpec& spec, RenderInputs& out) {
  out.matchName = text(e, "matchName");
  out.instance = text(e, "instance");
  out.layerId = text(e, "layerId");
  if (auto seq = doc::native_unbase64(text(e, "sequence"))) out.sequence = std::move(*seq);
  out.compTime = static_cast<std::int64_t>(std::llround(num(e, "compTime", 0)));
  out.layerTime = static_cast<std::int64_t>(std::llround(num(e, "layerTime", static_cast<double>(out.compTime))));
  out.fps = num(e, "fps", 30);
  out.timeStep = static_cast<std::int64_t>(std::llround(num(e, "timeStep", out.fps > 0 ? PR_TIME_SCALE / out.fps : 0)));
  out.layerW = static_cast<std::int32_t>(std::lround(num(e, "layerW", 0)));
  out.layerH = static_cast<std::int32_t>(std::lround(num(e, "layerH", 0)));
  out.draft = num(e, "draft", 0) != 0;
  out.values.assign(spec.params.size(), ParamValue{});
  for (std::size_t i = 0; i < spec.params.size(); ++i) {
    const ParamSpec& s = spec.params[i];
    ParamValue& v = out.values[i];
    v.v = s.def;
    const std::string k = "p." + s.key;
    switch (s.type) {
      case PR_PARAM_POINT:
      case PR_PARAM_POINT_3D:
        v.v[0] = num(e, k + "X", s.def[0]);
        v.v[1] = num(e, k + "Y", s.def[1]);
        v.v[2] = num(e, k + "Z", s.def[2]);
        break;
      case PR_PARAM_COLOR:
        if (const auto* p = find(e, k); p != nullptr && p->numbers.size() >= 4) {
          for (std::size_t c = 0; c < 4; ++c) v.v.at(c) = p->numbers[c];
        }
        break;
      case PR_PARAM_LAYER: v.layer = text(e, k); break;
      case PR_PARAM_PATH:
        if (const auto* p = find(e, k); p != nullptr) v.path = p->numbers;
        v.pathClosed = num(e, k + ".closed", 0) != 0;
        break;
      case PR_PARAM_ARBITRARY_DATA:
        if (auto bytes = doc::native_unbase64(text(e, "a." + s.key))) v.arb = std::move(*bytes);
        break;
      case PR_PARAM_GROUP_START:
      case PR_PARAM_GROUP_END:
      case PR_PARAM_BUTTON: break;
      default: v.v[0] = num(e, k, s.def[0]); break;
    }
  }
}

}  // namespace premation::plugins
