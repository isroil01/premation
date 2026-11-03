#include "fx_wire.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
#include <string>
#include <unordered_map>
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

std::string text(const api::RenderEffect& e, std::string_view name) {
  const auto* p = find(e, name);
  return p != nullptr ? p->text : std::string();
}

/// The entry's params by name — an SDK 1.2 entry may carry thousands (time samples), so the
/// decoder looks each one up once instead of scanning the list per name.
class Index {
 public:
  explicit Index(const api::RenderEffect& e) {
    map_.reserve(e.params.size());
    for (const auto& p : e.params) map_.emplace(p.name, &p);
  }
  [[nodiscard]] const api::RenderEffectParam* find(const std::string& name) const {
    const auto it = map_.find(name);
    return it == map_.end() ? nullptr : it->second;
  }
  [[nodiscard]] double num(const std::string& name, double def) const {
    const auto* p = find(name);
    if (p == nullptr) return def;
    if (p->kind == api::RenderParamKind::number || p->kind == api::RenderParamKind::flag) return p->number;
    return def;
  }
  [[nodiscard]] std::string text(const std::string& name) const {
    const auto* p = find(name);
    return p != nullptr ? p->text : std::string();
  }
  [[nodiscard]] const std::vector<double>* nums(const std::string& name, std::size_t atLeast) const {
    const auto* p = find(name);
    return p != nullptr && p->numbers.size() >= atLeast ? &p->numbers : nullptr;
  }

 private:
  std::unordered_map<std::string_view, const api::RenderEffectParam*> map_;
};

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

/// A new entry (the name is known to be absent: the samples' own names).
void append(api::RenderEffect& e, std::string name, api::RenderParamKind kind, double number, std::vector<double> numbers = {}) {
  api::RenderEffectParam p;
  p.name = std::move(name);
  p.kind = kind;
  p.number = number;
  p.numbers = std::move(numbers);
  e.params.push_back(std::move(p));
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

using Writer = void (*)(api::RenderEffect&, std::string, api::RenderParamKind, double, std::vector<double>);

void write_camera(api::RenderEffect& e, const std::string& pre, const api::RenderCamera3D& c, Writer w) {
  if (c.view.size() != 16 || c.projection.size() != 16) return;
  w(e, pre + "cam.has", api::RenderParamKind::flag, 1, {});
  w(e, pre + "cam.ortho", api::RenderParamKind::flag, c.eye.size() < 3 ? 1 : 0, {});
  w(e, pre + "cam.view", api::RenderParamKind::numbers, 0, c.view);
  w(e, pre + "cam.proj", api::RenderParamKind::numbers, 0, c.projection);
  if (c.eye.size() >= 3) w(e, pre + "cam.eye", api::RenderParamKind::numbers, 0, {c.eye[0], c.eye[1], c.eye[2]});
  w(e, pre + "cam.zoom", api::RenderParamKind::number, c.projection[5], {});
  if (c.dof) {
    w(e, pre + "cam.dof", api::RenderParamKind::flag, c.dof->strength > 0 ? 1 : 0, {});
    w(e, pre + "cam.focus", api::RenderParamKind::number, c.dof->focus, {});
    w(e, pre + "cam.aperture", api::RenderParamKind::number, c.dof->aperture, {});
  }
}

void write_lights(api::RenderEffect& e, const std::string& pre, const std::vector<api::RenderLight3D>& lights, Writer w) {
  std::vector<double> flat;
  flat.reserve(lights.size() * kLightStride);
  for (const api::RenderLight3D& l : lights) {
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
  w(e, pre + "lights", api::RenderParamKind::numbers, 0, std::move(flat));
}

void put_w(api::RenderEffect& e, std::string n, api::RenderParamKind k, double v, std::vector<double> vs) { put(e, std::move(n), k, v, std::move(vs)); }
void append_w(api::RenderEffect& e, std::string n, api::RenderParamKind k, double v, std::vector<double> vs) {
  append(e, std::move(n), k, v, std::move(vs));
}

SceneCamera read_camera(const Index& ix, const std::string& pre) {
  SceneCamera c;
  const auto* view = ix.nums(pre + "cam.view", 16);
  const auto* proj = ix.nums(pre + "cam.proj", 16);
  c.hasCamera = ix.num(pre + "cam.has", 0) != 0 && view != nullptr && proj != nullptr;
  if (c.hasCamera) {
    c.view = take<16>(*view);
    c.projection = take<16>(*proj);
    if (const auto* eye = ix.nums(pre + "cam.eye", 3)) c.eye = take<3>(*eye);
    c.orthographic = ix.num(pre + "cam.ortho", 0) != 0;
    c.zoom = ix.num(pre + "cam.zoom", c.projection[5]);
    c.dofEnabled = ix.num(pre + "cam.dof", 0) != 0;
    c.focusDistance = ix.num(pre + "cam.focus", c.zoom);
    c.aperture = ix.num(pre + "cam.aperture", 0);
  }
  return c;
}

std::vector<SceneLight> read_lights(const Index& ix, const std::string& pre) {
  std::vector<SceneLight> lights;
  if (const auto* flat = ix.nums(pre + "lights", 0)) {
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
  return lights;
}

/// The params' values from `pre` + `p.<key>`. `sample`: only the animatable kinds, and a value
/// absent from the entry keeps what `values` already holds (the frame's).
void read_values(const Index& ix, const EffectSpec& spec, const std::string& pre, std::vector<ParamValue>& values, bool sample) {
  for (std::size_t i = 0; i < spec.params.size(); ++i) {
    const ParamSpec& s = spec.params[i];
    ParamValue& v = values[i];
    if (!sample) v.v = s.def;
    const std::string k = pre + "p." + s.key;
    switch (s.type) {
      case PR_PARAM_POINT:
      case PR_PARAM_POINT_3D:
        v.v[0] = ix.num(k + "X", v.v[0]);
        v.v[1] = ix.num(k + "Y", v.v[1]);
        v.v[2] = ix.num(k + "Z", v.v[2]);
        break;
      case PR_PARAM_COLOR:
        if (const auto* p = ix.find(k); p != nullptr && p->numbers.size() >= 4) {
          for (std::size_t c = 0; c < 4; ++c) v.v.at(c) = p->numbers[c];
        }
        break;
      case PR_PARAM_SLIDER:
      case PR_PARAM_FLOAT_SLIDER:
      case PR_PARAM_ANGLE:
      case PR_PARAM_POPUP:
      case PR_PARAM_CHECKBOX: v.v[0] = ix.num(k, v.v[0]); break;
      default:
        if (sample) break;  // static kinds: the frame's value at every time
        switch (s.type) {
          case PR_PARAM_LAYER: v.layer = ix.text(k); break;
          case PR_PARAM_PATH:
            if (const auto* p = ix.find(k); p != nullptr) v.path = p->numbers;
            v.pathClosed = ix.num(k + ".closed", 0) != 0;
            break;
          case PR_PARAM_ARBITRARY_DATA:
            if (auto bytes = doc::native_unbase64(ix.text("a." + s.key))) v.arb = std::move(*bytes);
            break;
          // SDK 1.1.
          case PR_PARAM_STRING: v.text = ix.find(k) != nullptr ? ix.text(k) : s.text; break;
          case PR_PARAM_CURVE: {
            const auto* p = ix.nums(k, 4);
            v.curve = p != nullptr ? *p : s.curve;
            break;
          }
          case PR_PARAM_GRADIENT: {
            const auto* p = ix.nums(k, 5);
            v.gradient = p != nullptr ? *p : s.gradient;
            break;
          }
          case PR_PARAM_FILE:
            v.fileItem = ix.text(k);
            v.filePath = ix.text(k + ".path");
            v.fileName = ix.text(k + ".name");
            v.fileMissing = ix.num(k + ".missing", 0) != 0;
            break;
          case PR_PARAM_GROUP_START:
          case PR_PARAM_GROUP_END:
          case PR_PARAM_BUTTON:
          case PR_PARAM_CUSTOM_UI: break;
          default: v.v[0] = ix.num(k, s.def[0]); break;
        }
        break;
    }
  }
}

std::vector<std::optional<std::array<double, 16>>> read_matrices(const Index& ix, const EffectSpec& spec, const std::string& pre) {
  std::vector<std::optional<std::array<double, 16>>> out(spec.params.size(), std::nullopt);
  for (std::size_t i = 0; i < spec.params.size(); ++i) {
    if (spec.params[i].type != PR_PARAM_LAYER) continue;
    if (const auto* m = ix.nums(pre + "p." + spec.params[i].key + ".m", 16)) out[i] = take<16>(*m);
  }
  return out;
}

}  // namespace

const api::Renderable* find_renderable_in(const std::vector<api::Renderable>& list, std::string_view id) {
  for (const auto& r : list) {
    if (r.id == id) return &r;
    if (const api::Renderable* c = find_renderable_in(r.precomp_children, id)) return c;
  }
  return nullptr;
}

std::optional<std::vector<double>> renderable_world_matrix(const api::Renderable& r) {
  if (r.three_d && r.three_d->model.size() == 16) return r.three_d->model;
  if (r.model_matrix.size() == 9) {
    const auto& m = r.model_matrix;
    return std::vector<double>{m[0], m[1], 0, m[2], m[3], m[4], 0, m[5], 0, 0, 1, 0, m[6], m[7], 0, m[8]};
  }
  return std::nullopt;
}

void encode_native_file(api::RenderEffect& e, const doc::NativeActionRequest::File& f) {
  const std::string k = "p." + f.key;
  api::RenderEffectParam* item = nullptr;
  for (auto& p : e.params) {
    if (p.name == k) item = &p;
  }
  if (item == nullptr) {
    e.params.emplace_back();
    item = &e.params.back();
    item->name = k;
  }
  item->kind = api::RenderParamKind::text;
  item->text = f.item;
  const auto put_text = [&](const std::string& name, const std::string& v) {
    for (auto& p : e.params) {
      if (p.name == name) {
        p.kind = api::RenderParamKind::text;
        p.text = v;
        return;
      }
    }
    api::RenderEffectParam p;
    p.name = name;
    p.kind = api::RenderParamKind::text;
    p.text = v;
    e.params.push_back(std::move(p));
  };
  put_text(k + ".path", f.path);
  put_text(k + ".name", f.name);
  put(e, k + ".missing", api::RenderParamKind::flag, f.missing ? 1 : 0);
}

std::string checkout_renderable_id(std::string_view layerId, std::int64_t time) {
  return std::string(layerId) + "@" + std::to_string(time);
}

void encode_native_scene(api::RenderEffect& e, const EffectSpec& spec, const api::RenderFrameScene& scene,
                         const api::RenderCamera3D* camera, const std::vector<api::RenderLight3D>* lights) {
  const bool cam = spec.has(PR_OUT_FLAG_USES_CAMERA);
  const bool lightsOn = spec.has(PR_OUT_FLAG_USES_LIGHTS);
  const bool layers = spec.has(PR_OUT_FLAG_USES_LAYER_TRANSFORMS);
  if (!cam && !lightsOn && !layers) return;
  put(e, "compW", api::RenderParamKind::number, scene.width);
  put(e, "compH", api::RenderParamKind::number, scene.height);
  if (cam && camera != nullptr) {
    write_camera(e, "", *camera, &put_w);
  } else if (cam && scene.camera3d) {
    write_camera(e, "", *scene.camera3d, &put_w);
  }
  if (lightsOn) write_lights(e, "", lights != nullptr ? *lights : scene.lights3d, &put_w);
  if (layers) {
    for (const ParamSpec& s : spec.params) {
      if (s.type != PR_PARAM_LAYER) continue;
      const std::string id = text(e, "p." + s.key);
      if (id.empty()) continue;
      if (const api::Renderable* r = find_renderable_in(scene.renderables, id)) {
        if (auto m = renderable_world_matrix(*r)) put(e, "p." + s.key + ".m", api::RenderParamKind::numbers, 0, std::move(*m));
      }
    }
  }
}

namespace {
/// A PR_SAMPLE_SCENE_DEPTH sample's pose (encode_native_samples writes it).
DepthPose read_depth_pose(const Index& ix, const std::string& pre) {
  DepthPose d;
  const auto* view = ix.nums(pre + "dp.cam.view", 16);
  const auto* proj = ix.nums(pre + "dp.cam.proj", 16);
  if (view != nullptr && proj != nullptr) {
    api::RenderCamera3D c;
    c.view.assign(view->begin(), view->begin() + 16);
    c.projection.assign(proj->begin(), proj->begin() + 16);
    d.camera = std::move(c);
  }
  const std::string ids = ix.text(pre + "dp.ids");
  const std::vector<double>* models = ix.nums(pre + "dp.m", 0);
  std::size_t at = 0;
  std::size_t k = 0;
  while (models != nullptr && at < ids.size() && (k + 1) * 16 <= models->size()) {
    std::size_t end = ids.find('\n', at);
    if (end == std::string::npos) end = ids.size();
    const auto first = models->begin() + static_cast<std::ptrdiff_t>(k * 16);
    d.models.emplace_back(ids.substr(at, end - at), std::vector<double>(first, first + 16));
    at = end + 1;
    ++k;
  }
  return d;
}
}  // namespace

void decode_overlay_scene(const doc::NativeScene& scene, const EffectSpec& spec, RenderInputs& in) {
  api::RenderEffect e;
  put(e, "compW", api::RenderParamKind::number, scene.compW);
  put(e, "compH", api::RenderParamKind::number, scene.compH);
  if (spec.has(PR_OUT_FLAG_USES_CAMERA) && scene.camera) write_camera(e, "", *scene.camera, &put_w);
  if (spec.has(PR_OUT_FLAG_USES_LIGHTS)) write_lights(e, "", scene.lights, &put_w);
  if (spec.has(PR_OUT_FLAG_USES_LAYER_TRANSFORMS)) {
    for (const auto& [key, m] : scene.matrices) put(e, "p." + key + ".m", api::RenderParamKind::numbers, 0, m);
  }
  const Index ix(e);
  in.compW = scene.compW;
  in.compH = scene.compH;
  if (spec.has(PR_OUT_FLAG_USES_CAMERA)) in.camera = read_camera(ix, "");
  if (spec.has(PR_OUT_FLAG_USES_LIGHTS)) in.lights = read_lights(ix, "");
  if (spec.has(PR_OUT_FLAG_USES_LAYER_TRANSFORMS)) in.layerMatrices = read_matrices(ix, spec, "");
}

void encode_native_samples(api::RenderEffect& e, const EffectSpec& spec, std::vector<SampleWire> samples) {
  std::ranges::sort(samples, {}, &SampleWire::time);
  std::vector<double> index;
  index.reserve(samples.size() * 2);
  for (std::size_t i = 0; i < samples.size(); ++i) {
    SampleWire& s = samples[i];
    index.push_back(static_cast<double>(s.time));
    index.push_back(static_cast<double>(s.what));
    const std::string pre = "s" + std::to_string(i) + ".";
    if ((s.what & PR_SAMPLE_PARAMS) != 0) {
      for (api::RenderEffectParam& p : s.params) {
        p.name = pre + p.name;
        e.params.push_back(std::move(p));
      }
    }
    if ((s.what & PR_SAMPLE_CAMERA) != 0 && spec.has(PR_OUT_FLAG_USES_CAMERA) && s.camera) write_camera(e, pre, *s.camera, &append_w);
    if ((s.what & PR_SAMPLE_LIGHTS) != 0 && spec.has(PR_OUT_FLAG_USES_LIGHTS)) write_lights(e, pre, s.lights, &append_w);
    if ((s.what & PR_SAMPLE_LAYER_TRANSFORMS) != 0 && spec.has(PR_OUT_FLAG_USES_LAYER_TRANSFORMS)) {
      for (auto& [key, m] : s.matrices) append(e, pre + "p." + key + ".m", api::RenderParamKind::numbers, 0, std::move(m));
    }
    if ((s.what & PR_SAMPLE_SCENE_DEPTH) != 0 && spec.has(PR_OUT_FLAG_USES_SCENE_DEPTH) && s.depth) {
      const DepthPose& d = *s.depth;
      if (d.camera && d.camera->view.size() == 16 && d.camera->projection.size() == 16) {
        append(e, pre + "dp.cam.view", api::RenderParamKind::numbers, 0, d.camera->view);
        append(e, pre + "dp.cam.proj", api::RenderParamKind::numbers, 0, d.camera->projection);
      }
      std::string ids;
      std::vector<double> models;
      models.reserve(d.models.size() * 16);
      for (const auto& [id, m] : d.models) {
        if (m.size() != 16) continue;
        if (!ids.empty()) ids += '\n';
        ids += id;
        models.insert(models.end(), m.begin(), m.end());
      }
      api::RenderEffectParam t;
      t.name = pre + "dp.ids";
      t.kind = api::RenderParamKind::text;
      t.text = std::move(ids);
      e.params.push_back(std::move(t));
      append(e, pre + "dp.m", api::RenderParamKind::numbers, 0, std::move(models));
    }
  }
  put(e, "samples", api::RenderParamKind::numbers, 0, std::move(index));
}

void decode_native_fx(const api::RenderEffect& e, const EffectSpec& spec, RenderInputs& out) {
  const Index ix(e);
  out.matchName = ix.text("matchName");
  out.instance = ix.text("instance");
  out.layerId = ix.text("layerId");
  if (auto seq = doc::native_unbase64(ix.text("sequence"))) out.sequence = std::move(*seq);
  // SDK 1.4 (T): a STATEFUL effect's state for this frame (scene_finish.cpp); absent = none.
  if (const auto* sim = ix.find("simState"); sim != nullptr) {
    if (auto st = doc::native_unbase64(sim->text)) out.simState = std::move(*st);
  }
  // SDK 1.4 (C): the frame's channels it reads (scene_finish.cpp), `ch.<name>`.
  for (const api::RenderEffectParam& p : e.params) {
    if (p.name.starts_with("ch.") && p.kind == api::RenderParamKind::numbers) out.channels[p.name.substr(3)] = p.numbers;
  }
  out.compTime = static_cast<std::int64_t>(std::llround(ix.num("compTime", 0)));
  out.layerTime = static_cast<std::int64_t>(std::llround(ix.num("layerTime", static_cast<double>(out.compTime))));
  out.fps = ix.num("fps", 30);
  out.timeStep = static_cast<std::int64_t>(std::llround(ix.num("timeStep", out.fps > 0 ? PR_TIME_SCALE / out.fps : 0)));
  out.layerW = static_cast<std::int32_t>(std::lround(ix.num("layerW", 0)));
  out.layerH = static_cast<std::int32_t>(std::lround(ix.num("layerH", 0)));
  out.draft = ix.num("draft", 0) != 0;
  out.values.assign(spec.params.size(), ParamValue{});
  read_values(ix, spec, "", out.values, false);
  // SDK 1.1 (encode_native_scene).
  out.compW = ix.num("compW", 0);
  out.compH = ix.num("compH", 0);
  if (spec.has(PR_OUT_FLAG_USES_CAMERA)) out.camera = read_camera(ix, "");
  if (spec.has(PR_OUT_FLAG_USES_LIGHTS)) out.lights = read_lights(ix, "");
  if (spec.has(PR_OUT_FLAG_USES_LAYER_TRANSFORMS)) out.layerMatrices = read_matrices(ix, spec, "");
  // SDK 1.2 (scene_finish.cpp).
  out.layerStart = static_cast<std::int64_t>(std::llround(ix.num("layerStart", static_cast<double>(out.compTime - out.layerTime))));
  out.layer3d = ix.num("layer3d", 0) != 0;
  out.motionBlur = ix.num("mb", 0) != 0;
  out.shutterAngle = ix.num("shutterAngle", 0);
  out.shutterPhase = ix.num("shutterPhase", 0);
  out.motionBlurSamples = static_cast<std::uint32_t>(std::max(0.0, ix.num("mbSamples", 0)));
  out.samples.clear();
  if (const auto* index = ix.nums("samples", 0)) {
    out.samples.reserve(index->size() / 2);
    for (std::size_t i = 0; i + 1 < index->size(); i += 2) {
      TimeSample s;
      s.time = static_cast<std::int64_t>(std::llround((*index)[i]));
      s.what = static_cast<std::uint32_t>(std::max(0.0, (*index)[i + 1]));
      const std::string pre = "s" + std::to_string(i / 2) + ".";
      if ((s.what & PR_SAMPLE_PARAMS) != 0) {
        s.values = out.values;
        read_values(ix, spec, pre, s.values, true);
      }
      if ((s.what & PR_SAMPLE_CAMERA) != 0 && spec.has(PR_OUT_FLAG_USES_CAMERA)) s.camera = read_camera(ix, pre);
      if ((s.what & PR_SAMPLE_LIGHTS) != 0 && spec.has(PR_OUT_FLAG_USES_LIGHTS)) s.lights = read_lights(ix, pre);
      if ((s.what & PR_SAMPLE_LAYER_TRANSFORMS) != 0 && spec.has(PR_OUT_FLAG_USES_LAYER_TRANSFORMS)) s.layerMatrices = read_matrices(ix, spec, pre);
      if ((s.what & PR_SAMPLE_SCENE_DEPTH) != 0 && spec.has(PR_OUT_FLAG_USES_SCENE_DEPTH)) s.depth = read_depth_pose(ix, pre);
      out.samples.push_back(std::move(s));
    }
    std::ranges::stable_sort(out.samples, {}, &TimeSample::time);
  }
}

}  // namespace premation::plugins
