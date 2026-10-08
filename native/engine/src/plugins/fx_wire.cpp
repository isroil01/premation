#include "fx_wire.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
#include <vector>

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

const std::vector<double>* nums(const api::RenderEffect& e, std::string_view name, std::size_t atLeast) {
  const auto* p = find(e, name);
  return p != nullptr && p->numbers.size() >= atLeast ? &p->numbers : nullptr;
}

template <std::size_t N>
std::array<double, N> take(const std::vector<double>& v, std::size_t at = 0) {
  std::array<double, N> out{};
  std::copy_n(v.begin() + static_cast<std::ptrdiff_t>(at), N, out.begin());
  return out;
}

void put(api::RenderEffect& e, std::string name, api::RenderParamKind kind, double number, std::vector<double> numbers = {}) {
  for (auto& p : e.params) {
    if (p.name == name) {
      p.kind = kind;
      p.number = number;
      p.numbers = std::move(numbers);
      return;
    }
  }
  api::RenderEffectParam p;
  p.name = std::move(name);
  p.kind = kind;
  p.number = number;
  p.numbers = std::move(numbers);
  e.params.push_back(std::move(p));
}

const api::Renderable* find_renderable(const std::vector<api::Renderable>& list, std::string_view id) {
  for (const auto& r : list) {
    if (r.id == id) return &r;
    if (const api::Renderable* c = find_renderable(r.precomp_children, id)) return c;
  }
  return nullptr;
}

/// A renderable's layer → world matrix: its 3D model, else its 2D model at z = 0.
std::optional<std::vector<double>> world_matrix(const api::Renderable& r) {
  if (r.three_d && r.three_d->model.size() == 16) return r.three_d->model;
  if (r.model_matrix.size() == 9) {
    const auto& m = r.model_matrix;
    return std::vector<double>{m[0], m[1], 0, m[2], m[3], m[4], 0, m[5], 0, 0, 1, 0, m[6], m[7], 0, m[8]};
  }
  return std::nullopt;
}

std::int32_t sdk_light_type(api::RenderLightType t) {
  switch (t) {
    case api::RenderLightType::parallel: return PR_LIGHT_PARALLEL;
    case api::RenderLightType::spot: return PR_LIGHT_SPOT;
    case api::RenderLightType::point: return PR_LIGHT_POINT;
    case api::RenderLightType::ambient: return PR_LIGHT_AMBIENT;
  }
  return PR_LIGHT_AMBIENT;
}

}  // namespace

std::string checkout_renderable_id(std::string_view layerId, std::int64_t time) {
  return std::string(layerId) + "@" + std::to_string(time);
}

void encode_native_scene(api::RenderEffect& e, const EffectSpec& spec, const api::RenderFrameScene& scene) {
  const bool cam = spec.has(PR_OUT_FLAG_USES_CAMERA);
  const bool lights = spec.has(PR_OUT_FLAG_USES_LIGHTS);
  const bool layers = spec.has(PR_OUT_FLAG_USES_LAYER_TRANSFORMS);
  if (!cam && !lights && !layers) return;
  put(e, "compW", api::RenderParamKind::number, scene.width);
  put(e, "compH", api::RenderParamKind::number, scene.height);
  if (cam && scene.camera3d && scene.camera3d->view.size() == 16 && scene.camera3d->projection.size() == 16) {
    const api::RenderCamera3D& c = *scene.camera3d;
    put(e, "cam.has", api::RenderParamKind::flag, 1);
    put(e, "cam.ortho", api::RenderParamKind::flag, c.eye.size() < 3 ? 1 : 0);
    put(e, "cam.view", api::RenderParamKind::numbers, 0, c.view);
    put(e, "cam.proj", api::RenderParamKind::numbers, 0, c.projection);
    if (c.eye.size() >= 3) put(e, "cam.eye", api::RenderParamKind::numbers, 0, {c.eye[0], c.eye[1], c.eye[2]});
    put(e, "cam.zoom", api::RenderParamKind::number, c.projection[5]);
    if (c.dof) {
      put(e, "cam.dof", api::RenderParamKind::flag, c.dof->strength > 0 ? 1 : 0);
      put(e, "cam.focus", api::RenderParamKind::number, c.dof->focus);
      put(e, "cam.aperture", api::RenderParamKind::number, c.dof->aperture);
    }
  }
  if (lights) {
    std::vector<double> flat;
    for (const api::RenderLight3D& l : scene.lights3d) {
      double dx = 0, dy = 0, dz = 0;
      if (l.type == api::RenderLightType::spot || l.type == api::RenderLightType::parallel) {
        dx = l.aim_x - l.x;
        dy = l.aim_y - l.y;
        dz = l.aim_z - l.z;
        const double len = std::sqrt(dx * dx + dy * dy + dz * dz);
        if (len > 0) {
          dx /= len;
          dy /= len;
          dz /= len;
        }
      }
      const double r = l.color.size() > 0 ? l.color[0] : 1;
      const double g = l.color.size() > 1 ? l.color[1] : 1;
      const double b = l.color.size() > 2 ? l.color[2] : 1;
      const std::array<double, kLightStride> one{static_cast<double>(sdk_light_type(l.type)), r, g, b, l.gain, l.x, l.y, l.z, dx, dy, dz,
                                                 2 * l.half_cone_rad, l.cone_feather_rad, l.falloff_mode, l.falloff_distance,
                                                 l.shadow_map.value_or(false) ? 1.0 : 0.0, l.shadow_darkness.value_or(0),
                                                 l.shadow_diffusion.value_or(0)};
      flat.insert(flat.end(), one.begin(), one.end());
    }
    put(e, "lights", api::RenderParamKind::numbers, 0, std::move(flat));
  }
  if (layers) {
    for (const ParamSpec& s : spec.params) {
      if (s.type != PR_PARAM_LAYER) continue;
      const std::string id = text(e, "p." + s.key);
      if (id.empty()) continue;
      if (const api::Renderable* r = find_renderable(scene.renderables, id)) {
        if (auto m = world_matrix(*r)) put(e, "p." + s.key + ".m", api::RenderParamKind::numbers, 0, std::move(*m));
      }
    }
  }
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
  // SDK 1.1 (encode_native_scene).
  out.compW = num(e, "compW", 0);
  out.compH = num(e, "compH", 0);
  if (spec.has(PR_OUT_FLAG_USES_CAMERA)) {
    SceneCamera c;
    const auto* view = nums(e, "cam.view", 16);
    const auto* proj = nums(e, "cam.proj", 16);
    c.hasCamera = num(e, "cam.has", 0) != 0 && view != nullptr && proj != nullptr;
    if (c.hasCamera) {
      c.view = take<16>(*view);
      c.projection = take<16>(*proj);
      if (const auto* eye = nums(e, "cam.eye", 3)) c.eye = take<3>(*eye);
      c.orthographic = num(e, "cam.ortho", 0) != 0;
      c.zoom = num(e, "cam.zoom", c.projection[5]);
      c.dofEnabled = num(e, "cam.dof", 0) != 0;
      c.focusDistance = num(e, "cam.focus", c.zoom);
      c.aperture = num(e, "cam.aperture", 0);
    }
    out.camera = c;
  }
  if (spec.has(PR_OUT_FLAG_USES_LIGHTS)) {
    std::vector<SceneLight> lights;
    if (const auto* flat = nums(e, "lights", 0)) {
      for (std::size_t at = 0; at + kLightStride <= flat->size() && lights.size() < PR_MAX_LIGHTS; at += kLightStride) {
        const auto v = take<kLightStride>(*flat, at);
        SceneLight l;
        l.type = static_cast<std::int32_t>(v[0]);
        l.color = {v[1], v[2], v[3]};
        l.intensity = v[4];
        l.position = {v[5], v[6], v[7]};
        l.direction = {v[8], v[9], v[10]};
        l.coneAngle = v[11];
        l.coneFeather = v[12];
        l.falloff = static_cast<std::int32_t>(v[13]);
        l.falloffDistance = v[14];
        l.castsShadows = v[15] != 0;
        l.shadowDarkness = v[16];
        l.shadowDiffusion = v[17];
        lights.push_back(l);
      }
    }
    out.lights = std::move(lights);
  }
  if (spec.has(PR_OUT_FLAG_USES_LAYER_TRANSFORMS)) {
    out.layerMatrices.assign(spec.params.size(), std::nullopt);
    for (std::size_t i = 0; i < spec.params.size(); ++i) {
      if (spec.params[i].type != PR_PARAM_LAYER) continue;
      if (const auto* m = nums(e, "p." + spec.params[i].key + ".m", 16)) out.layerMatrices[i] = take<16>(*m);
    }
  }
}

}  // namespace premation::plugins
