// Sample (SDK 1.2): Model 3D — an Element 3D class effect. A glTF model drawn
// through the comp camera and lit by the comp lights, anywhere in the frame,
// with its own depth buffer, motion blur and occlusion by the comp's 3D layers.
//
// What the sample proves, end to end:
//   · a FILE param for a .glb / .gltf; a .gltf's .bin through
//     get_asset_sibling_bytes (gltf_lite.hpp parses both — a plugin links only
//     the SDK, so it brings its own loader). No model chosen: a built-in cube.
//   · GPU render (PR_OUT_FLAG_GPU_RENDER) on the engine's Dawn device through
//     `procs` only: its own pipelines, an rgba16float sample target and a
//     depth32float buffer; the comp camera (get_comp_camera) and up to 8 comp
//     lights (get_comp_lights: ambient, parallel, point, spot) — Lambert diffuse +
//     Blinn-Phong specular (shininess from Roughness). With no light in the
//     comp, a headlight from the camera (AE draws unlit layers fully lit), with
//     the same Blinn-Phong term.
//   · placement: Position (POINT_3D, comp world px) + Orientation X / Y / Z +
//     Size (the model's largest extent, px), or a Transform Layer (a LAYER
//     param's world matrix, get_layer_transform: the model rides the layer).
//   · PR_OUT_FLAG_COMP_SPACE: drawn with comp_to_world, on a solid of any size.
//   · texture maps: a Base Color Map (a FILE image: get_asset_image_gpu /
//     get_asset_image) and a Texture Layer (a LAYER param: checkout_layer_gpu /
//     checkout_layer_pixels), both through the model's TEXCOORD_0.
//   · motion blur (PR_OUT_FLAG_USES_SHUTTER): checkout_time at the shutter's
//     sub-times with PR_SAMPLE_PARAMS | _CAMERA | _LAYER_TRANSFORMS, one render
//     per sample (motion_blur_samples, at most 16), averaged.
//   · Composite with Scene Depth (S6, PR_OUT_FLAG_USES_SCENE_DEPTH): a model
//     fragment behind the comp's 3D layers (checkout_scene_depth[_gpu]) is
//     discarded; under motion blur each sub-frame against the depth at its own
//     time (PR_SAMPLE_SCENE_DEPTH, checkout_scene_depth_gpu_at / _at). Render Mode ▸ Scene Depth shows that depth (red = z / 1000 px,
//     blue = nothing drawn) — a debug view, and how the engine tests read it.
//   · a viewer handle (DRAW_OVERLAY / OVERLAY_DRAG) on the model, projected
//     through the comp camera at the viewer's time (comp-space overlay,
//     overlay_set_space); a drag moves Position in the camera's view plane at
//     the model's depth. And a material panel (ui/index.html: colour,
//     roughness, specular).
//   · a CPU path (SMART_RENDER) with the same maths in a small z-buffered
//     rasteriser — flat sampling, no near-plane clipping (a triangle reaching
//     behind the eye is dropped): lower quality, but a frame without a GPU.
//
// Conventions: world space is After Effects' (px, +y down, +z away). glTF is
// +y up / +z toward the viewer: the model is turned 180° about x, centred on
// its bounds and scaled so its largest extent is Size px. Depth everywhere is
// camera-space z ((view · p).z), the scene depth's own unit.
//
// Deterministic: every frame is a pure function of the params, the camera, the
// lights and the model file.
#include <premation_sdk/premation_sdk.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <numbers>
#include <string>
#include <vector>

#include "gltf_lite.hpp"
#include "sample_util.hpp"
#if defined(PRS_SAMPLE_GPU)
#include <dawn/dawn_proc_table.h>
#include <webgpu/webgpu.h>
#endif

namespace {

enum : uint32_t {
  kModel = 1,
  kPosition = 2,
  kOrientX = 3,
  kOrientY = 4,
  kOrientZ = 5,
  kSize = 6,
  kTransformLayer = 7,
  kBaseColor = 8,
  kRoughness = 9,
  kSpecular = 10,
  kBaseMap = 11,
  kTextureLayer = 12,
  kSceneDepth = 13,
  kBlur = 14,
  kRenderMode = 15,
  kMaterialGroup = 20,
  kMaterialGroupEnd = 21,
};
// kModeInScene (SDK 1.4, D4): the model is geometry of the comp's own 3D render (SCENE_CONTRIBUTE):
// lit by its lights, shadowing and shadowed by its 3D layers, intersecting them, in the camera's depth
// of field and motion blur. The effect's own output is then empty.
enum : int { kModeShaded = 1, kModeSceneDepth = 2, kModeInScene = 3 };
constexpr uint32_t kLayerCheckout = 1;  // checkout id of the Texture Layer
constexpr uint32_t kPositionHandle = 1;
constexpr int32_t kMaxShutter = 16;
constexpr std::size_t kMaxLights = 8;
constexpr double kDepthKnee = 1000;  // frag depth = z / (z + K): monotonic, the z-buffer's order

using V3 = std::array<double, 3>;
using M4 = std::array<double, 16>;  // column-major

M4 identity() { return {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1}; }

M4 mul(const M4& a, const M4& b) {
  M4 o{};
  for (std::size_t c = 0; c < 4; ++c) {
    for (std::size_t r = 0; r < 4; ++r) {
      double s = 0;
      for (std::size_t k = 0; k < 4; ++k) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

M4 from(const double* m) {  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  M4 o{};
  for (std::size_t i = 0; i < 16; ++i) o[i] = m[i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  return o;
}

std::array<double, 4> apply(const M4& m, const V3& p) {
  return {m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
          m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14], m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15]};
}

M4 translate(double x, double y, double z) {
  M4 m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

M4 scale(double x, double y, double z) {
  M4 m = identity();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
}

M4 rot(int axis, double deg) {
  const double a = deg * std::numbers::pi / 180;
  const double c = std::cos(a);
  const double s = std::sin(a);
  M4 m = identity();
  if (axis == 0) {
    m[5] = c, m[6] = s, m[9] = -s, m[10] = c;
  } else if (axis == 1) {
    m[0] = c, m[2] = -s, m[8] = s, m[10] = c;
  } else {
    m[0] = c, m[1] = s, m[4] = -s, m[5] = c;
  }
  return m;
}

/// The inverse transpose of m's upper 3×3 (normals), in a 4×4.
M4 normal_matrix(const M4& m) {
  const double a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
  const double A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const double D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const double G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
  double det = a * A + b * B + c * C;
  if (std::abs(det) < 1e-30) det = 1e-30;
  // inverse = adj / det, adj = cofactor matrix transposed; inverse transpose = cofactor / det.
  M4 o = identity();
  o[0] = A / det, o[4] = B / det, o[8] = C / det;
  o[1] = D / det, o[5] = E / det, o[9] = F / det;
  o[2] = G / det, o[6] = H / det, o[10] = I / det;
  return o;
}

/// comp px (after the camera's projection, homogeneous) → the world's clip space (x, y; z, w kept).
M4 comp_to_clip(const double* c2w, int32_t w, int32_t h) {  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  const double sx = 2.0 / std::max(1, w);
  const double sy = -2.0 / std::max(1, h);
  // NOLINTBEGIN(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  return {sx * c2w[0], sy * c2w[3], 0, 0, sx * c2w[1], sy * c2w[4], 0, 0, 0, 0, 1, 0, sx * c2w[2] - 1, sy * c2w[5] + 1, 0, 1};
  // NOLINTEND(cppcoreguidelines-pro-bounds-pointer-arithmetic)
}

// ── the model ──────────────────────────────────────────────────────────────

/// The built-in model (no file chosen): a unit cube, 24 vertices, one normal per face.
gltf_lite::Model cube_model() {
  gltf_lite::Model m;
  const std::array<std::array<float, 3>, 6> normals{{{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}}};
  for (const auto& n : normals) {
    // Two axes spanning the face, so (u, v, n) is right-handed (outward winding counter-clockwise).
    const std::array<float, 3> u = n[0] != 0 ? std::array<float, 3>{0, n[0], 0} : n[1] != 0 ? std::array<float, 3>{0, 0, n[1]} : std::array<float, 3>{n[2], 0, 0};
    const std::array<float, 3> v{n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]};
    const auto base = static_cast<uint32_t>(m.vertices.size());
    const std::array<std::array<float, 2>, 4> corners{{{-1, -1}, {1, -1}, {1, 1}, {-1, 1}}};
    for (const auto& c : corners) {
      gltf_lite::Vertex vx;
      for (std::size_t k = 0; k < 3; ++k) vx.p[k] = 0.5F * (n[k] + c[0] * u[k] + c[1] * v[k]);
      vx.n = n;
      vx.uv = {0.5F * (c[0] + 1), 0.5F * (1 - c[1])};
      m.vertices.push_back(vx);
    }
    for (const uint32_t k : {0U, 1U, 2U, 0U, 2U, 3U}) m.indices.push_back(base + k);
  }
  m.lo = {-0.5F, -0.5F, -0.5F};
  m.hi = {0.5F, 0.5F, 0.5F};
  return m;
}

uint64_t fnv(const uint8_t* d, uint64_t n) {
  uint64_t h = 1469598103934665603ULL;
  for (uint64_t i = 0; i < n; ++i) {
    h ^= d[i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    h *= 1099511628211ULL;
  }
  return h ^ n;
}

/// Parsed models, kept per content (a plugin-side cache; the key is the bytes' hash).
struct ModelCache {
  std::mutex mutex;
  std::map<uint64_t, std::shared_ptr<const gltf_lite::Model>> models;
};
ModelCache& model_cache() {
  static ModelCache c;  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables): the module's cache
  return c;
}

uint32_t index_of(const PrInData* in, PrParamDef* const* params, uint32_t id) {
  for (uint32_t i = 1; i < in->num_params; ++i) {
    if (params[i] != nullptr && params[i]->id == id) return i;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
  return 0;
}

/// The model for this render: the FILE param's (parsed once per content), the cube when none is
/// chosen. nullptr + `why` when the chosen file is missing or unreadable — the layer's error.
std::shared_ptr<const gltf_lite::Model> load_model(const PrInData* in, PrParamDef* const* params, uint64_t& key, std::string& why) {
  const uint32_t pi = index_of(in, params, kModel);
  const PrParamDef* p = pi != 0 ? params[pi] : nullptr;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  static const std::shared_ptr<const gltf_lite::Model> cube = std::make_shared<const gltf_lite::Model>(cube_model());
  if (p == nullptr || p->file_name == nullptr) {
    key = 1;
    return cube;
  }
  if (p->file_missing != 0) {
    why = std::string("Model 3D: the model file '") + p->file_name + "' is missing";
    return nullptr;
  }
  const uint8_t* data = nullptr;
  uint64_t size = 0;
  if (in->host->get_asset_bytes(in->host_ref, pi, &data, &size) != PR_ERR_NONE || data == nullptr) {
    why = std::string("Model 3D: cannot read '") + p->file_name + "'";
    return nullptr;
  }
  key = fnv(data, size) | 2U;
  ModelCache& c = model_cache();
  {
    const std::scoped_lock lock(c.mutex);
    if (const auto it = c.models.find(key); it != c.models.end()) return it->second;
  }
  auto m = std::make_shared<gltf_lite::Model>();
  const gltf_lite::SiblingFn sibling = [&](const std::string& uri, std::vector<uint8_t>& out) {
    const uint8_t* d = nullptr;
    uint64_t n = 0;
    if (in->host->get_asset_sibling_bytes(in->host_ref, pi, uri.c_str(), &d, &n) != PR_ERR_NONE || d == nullptr) return false;
    out.assign(d, d + n);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    return true;
  };
  std::string err;
  if (!gltf_lite::load(std::span<const uint8_t>(data, static_cast<std::size_t>(size)), sibling, *m, err)) {
    why = std::string("Model 3D: '") + p->file_name + "': " + err;
    return nullptr;
  }
  const std::scoped_lock lock(c.mutex);
  if (c.models.size() > 16) c.models.clear();
  return c.models.emplace(key, std::move(m)).first->second;
}

// ── one render's scene: samples, camera, lights, placement, material ──────

struct Light {
  int32_t type = PR_LIGHT_AMBIENT;
  V3 color{};  // × intensity
  V3 pos{};
  V3 dir{};  // the way the light travels (unit)
  double cosOuter = -1, cosInner = -1;
};

struct Material {
  std::array<double, 3> base{1, 1, 1};
  double roughness = 0.5;
  double specular = 0.5;
  bool baseMap = false;
  bool layerMap = false;
};

/// One sub-frame the model is drawn at.
struct Sample {
  int64_t time = 0;
  float weight = 1;
  M4 model = identity();  ///< model → comp world
  M4 view = identity();
  M4 proj = identity();
  V3 eye{};
};

bool has_v12(const PrInData* in) {
  return in->host->struct_size >= offsetof(PrHostSuite, get_asset_sibling_bytes) + sizeof(void*) &&
         in->struct_size >= offsetof(PrInData, comp_to_world) + sizeof(in->comp_to_world);
}
bool has_depth_suite(const PrInData* in) { return in->host->struct_size >= offsetof(PrHostSuite, checkout_scene_depth) + sizeof(void*); }
/// SDK 1.2, later: overlay_set_space, then checkout_scene_depth_gpu_at / _at.
bool has_overlay_space(const PrInData* in) { return in->host->struct_size >= offsetof(PrHostSuite, overlay_set_space) + sizeof(void*); }
bool has_depth_at(const PrInData* in) { return in->host->struct_size >= offsetof(PrHostSuite, checkout_scene_depth_at) + sizeof(void*); }

std::vector<int64_t> sample_times(const PrInData* in, PrParamDef* const* params) {
  std::vector<int64_t> out;
  const bool blur = has_v12(in) && in->motion_blur != 0 && prs::num(params, in, kBlur) != 0 && in->shutter_angle > 0;
  if (!blur) {
    out.push_back(in->current_time);
    return out;
  }
  const int32_t n = std::clamp(static_cast<int32_t>(in->motion_blur_samples), 2, kMaxShutter);
  for (int32_t i = 0; i < n; ++i) {
    // Sample centres across the open shutter: phase … phase + angle.
    const double deg = in->shutter_phase + in->shutter_angle * (static_cast<double>(i) + 0.5) / static_cast<double>(n);
    out.push_back(in->current_time + static_cast<int64_t>(std::llround(deg / 360.0 * static_cast<double>(in->time_step))));
  }
  return out;
}

/// The model's placement at `time`: Transform Layer, else Position / Orientation / Size.
bool placement(const PrInData* in, PrParamDef* const* params, int64_t time, const gltf_lite::Model& model, M4& out) {
  const bool now = time == in->current_time;
  std::array<PrParamDef, 8> at{};
  const auto value = [&](uint32_t id, std::size_t k, std::size_t slot) -> double {
    if (now) return prs::num(params, in, id, k);
    return at.at(slot).value[k];  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
  };
  const std::array<uint32_t, 5> ids{kPosition, kOrientX, kOrientY, kOrientZ, kSize};
  if (!now) {
    for (std::size_t s = 0; s < ids.size(); ++s) {
      at.at(s).struct_size = sizeof(PrParamDef);
      const uint32_t idx = index_of(in, params, ids.at(s));
      if (idx == 0 || in->host->checkout_param(in->host_ref, idx, time, &at.at(s)) != PR_ERR_NONE) return false;
    }
  }
  // Centre on the bounds, glTF (+y up, +z toward the viewer) → AE (+y down, +z away), Size px.
  const double ext = std::max({static_cast<double>(model.hi[0] - model.lo[0]), static_cast<double>(model.hi[1] - model.lo[1]),
                               static_cast<double>(model.hi[2] - model.lo[2]), 1e-9});
  const double s = std::max(0.0, value(kSize, 0, 4)) / ext;
  const M4 local = mul(scale(s, -s, -s), translate(-0.5 * (model.lo[0] + model.hi[0]), -0.5 * (model.lo[1] + model.hi[1]),
                                                   -0.5 * (model.lo[2] + model.hi[2])));
  const uint32_t layerIdx = index_of(in, params, kTransformLayer);
  if (layerIdx != 0 && params[layerIdx]->layer_id != nullptr) {  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    std::array<double, 16> lm{};
    if (in->host->get_layer_transform(in->host_ref, layerIdx, time, lm.data()) == PR_ERR_NONE) {
      out = mul(from(lm.data()), local);  // rides the layer: its layer px origin, its orientation and scale
      return true;
    }
  }
  const M4 r = mul(rot(2, value(kOrientZ, 0, 3)), mul(rot(1, value(kOrientY, 0, 2)), rot(0, value(kOrientX, 0, 1))));
  out = mul(translate(value(kPosition, 0, 0), value(kPosition, 1, 0), value(kPosition, 2, 0)), mul(r, local));
  return true;
}

/// Every sample's camera and placement (a time the host did not evaluate is skipped).
PrErr scene_samples(const PrInData* in, PrParamDef* const* params, const gltf_lite::Model& model, std::vector<Sample>& out) {
  const std::vector<int64_t> times = sample_times(in, params);
  for (const int64_t t : times) {
    Sample s;
    s.time = t;
    PrCamera cam{};
    cam.struct_size = sizeof(cam);
    const PrErr ce = in->host->get_comp_camera(in->host_ref, t, &cam);
    if (ce == PR_ERR_NOT_FOUND) continue;
    if (ce != PR_ERR_NONE) return ce;
    s.view = from(cam.view);
    s.proj = from(cam.projection);
    s.eye = {cam.position[0], cam.position[1], cam.position[2]};
    if (!placement(in, params, t, model, s.model)) continue;
    out.push_back(s);
  }
  for (Sample& s : out) s.weight = 1.0F / static_cast<float>(out.size());
  return PR_ERR_NONE;
}

std::vector<Light> comp_lights(const PrInData* in) {
  std::array<PrLight, PR_MAX_LIGHTS> raw{};
  for (PrLight& l : raw) l.struct_size = sizeof(PrLight);
  uint32_t n = 0;
  std::vector<Light> out;
  if (in->host->get_comp_lights(in->host_ref, in->current_time, raw.data(), PR_MAX_LIGHTS, &n) != PR_ERR_NONE) return out;
  for (uint32_t i = 0; i < std::min<uint32_t>(n, PR_MAX_LIGHTS) && out.size() < kMaxLights; ++i) {
    const PrLight& r = raw.at(i);
    Light l;
    l.type = r.type;
    l.color = {r.color[0] * r.intensity, r.color[1] * r.intensity, r.color[2] * r.intensity};
    l.pos = {r.position[0], r.position[1], r.position[2]};
    const double len = std::max(1e-12, std::hypot(r.direction[0], r.direction[1], r.direction[2]));
    l.dir = {r.direction[0] / len, r.direction[1] / len, r.direction[2] / len};
    if (r.type == PR_LIGHT_SPOT) {
      l.cosOuter = std::cos(r.cone_angle / 2);
      l.cosInner = std::cos(std::max(0.0, r.cone_angle / 2 - r.cone_feather));
    }
    out.push_back(l);
  }
  return out;
}

Material material_of(const PrInData* in, PrParamDef* const* params) {
  Material m;
  for (std::size_t k = 0; k < 3; ++k) m.base.at(k) = prs::num(params, in, kBaseColor, k, 1);
  m.roughness = std::clamp(prs::num(params, in, kRoughness, 0, 50) / 100, 0.02, 1.0);
  m.specular = std::clamp(prs::num(params, in, kSpecular, 0, 50) / 100, 0.0, 1.0);
  return m;
}

double shininess(double roughness) { return std::clamp(2 / std::pow(roughness, 4) - 2, 1.0, 2048.0); }

double dot(const V3& a, const V3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
V3 norm(const V3& a) {
  const double l = std::max(1e-12, std::sqrt(dot(a, a)));
  return {a[0] / l, a[1] / l, a[2] / l};
}
double smoothstep(double e0, double e1, double x) {
  const double t = std::clamp((x - e0) / std::max(1e-9, e1 - e0), 0.0, 1.0);
  return t * t * (3 - 2 * t);
}

/// Lambert + Blinn-Phong over the comp lights (the WGSL `shade` below, line for line).
V3 shade(const V3& albedo, V3 n, const V3& p, const V3& eye, const Material& mat, const std::vector<Light>& lights) {
  const V3 v = norm({eye[0] - p[0], eye[1] - p[1], eye[2] - p[2]});
  if (dot(n, v) < 0) n = {-n[0], -n[1], -n[2]};  // two-sided
  if (lights.empty()) {
    // No comp light: a headlight at the eye — Lambert plus the material's Blinn-Phong (the light
    // and the view coincide, so h = v). Without the specular term Roughness and Specular did
    // nothing in a comp without lights (2026-10-13 QA).
    const double nv = std::max(0.0, dot(n, v));
    const double k = 0.3 + 0.7 * nv;
    const double spec = mat.specular * std::pow(nv, shininess(mat.roughness));
    return {albedo[0] * k + spec, albedo[1] * k + spec, albedo[2] * k + spec};
  }
  V3 c{};
  const double shin = shininess(mat.roughness);
  for (const Light& l : lights) {
    if (l.type == PR_LIGHT_AMBIENT) {
      for (std::size_t k = 0; k < 3; ++k) c.at(k) += albedo.at(k) * l.color.at(k);
      continue;
    }
    const V3 L = l.type == PR_LIGHT_PARALLEL ? V3{-l.dir[0], -l.dir[1], -l.dir[2]} : norm({l.pos[0] - p[0], l.pos[1] - p[1], l.pos[2] - p[2]});
    double att = 1;
    if (l.type == PR_LIGHT_SPOT) att = smoothstep(l.cosOuter, l.cosInner, -dot(L, l.dir));
    const double ndl = std::max(0.0, dot(n, L));
    const V3 h = norm({L[0] + v[0], L[1] + v[1], L[2] + v[2]});
    const double spec = ndl > 0 ? mat.specular * std::pow(std::max(0.0, dot(n, h)), shin) : 0;
    for (std::size_t k = 0; k < 3; ++k) c.at(k) += (albedo.at(k) * ndl + spec) * l.color.at(k) * att;
  }
  return c;
}

// ── CPU: a z-buffered rasteriser ───────────────────────────────────────────

/// A nearest texel (wrapped uv), straight colour. An R32F / missing world: white.
std::array<double, 3> texel(const PrWorld* w, double u, double v) {
  if (w == nullptr || w->width <= 0 || w->height <= 0 || w->format == PR_PIXEL_FORMAT_R32F) return {1, 1, 1};
  const double fu = u - std::floor(u);
  const double fv = v - std::floor(v);
  const auto x = std::min(w->width - 1, static_cast<int32_t>(fu * w->width));
  const auto y = std::min(w->height - 1, static_cast<int32_t>(fv * w->height));
  const prs::Px p = prs::read(*w, x, y);
  if (p.a <= 0) return {0, 0, 0};
  return {p.r / p.a, p.g / p.a, p.b / p.a};
}

float depth_at(const PrWorld* d, int32_t x, int32_t y) {
  if (d == nullptr || x < 0 || y < 0 || x >= d->width || y >= d->height) return std::numeric_limits<float>::infinity();
  float v = 0;
  std::memcpy(&v, static_cast<const uint8_t*>(pr_world_row(d, y)) + static_cast<std::size_t>(x) * 4, 4);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  return v;
}

/// A vertex after the camera: world px on screen, camera z, 1 / w, and what is interpolated.
struct ScreenVertex {
  double x = 0, y = 0, z = 0, invW = 0;
  V3 p{}, n{};
  double u = 0, v = 0;
};

PrErr cpu_render(const PrInData* in, PrOutData* out, PrParamDef* const* params) {
  if (const PrErr f = prs::inject(prs::by_id(params, in, prs::kFaultParamId), out); f != PR_ERR_NONE) return f;
  if (!has_v12(in)) return PR_ERR_BAD_VERSION;
  PrWorld* dst = nullptr;
  if (PrErr e = in->host->checkout_output(in->host_ref, &dst); e != PR_ERR_NONE) return e;
  if (dst == nullptr) return PR_ERR_NONE;
  const bool wantDepth = prs::num(params, in, kSceneDepth) != 0;
  const int mode = static_cast<int>(prs::num(params, in, kRenderMode, 0, kModeShaded));
  PrWorld* sceneDepth = nullptr;
  if ((wantDepth || mode == kModeSceneDepth) && has_depth_suite(in)) {
    // PR_ERR_UNSUPPORTED (no GPU behind this host): the model renders unoccluded.
    if (in->host->checkout_scene_depth(in->host_ref, &sceneDepth) != PR_ERR_NONE) sceneDepth = nullptr;
  }
  const int32_t W = dst->width;
  const int32_t H = dst->height;
  if (mode == kModeInScene) {  // D4: the host draws the model in the comp's 3D scene
    auto row = [&](int32_t y) {
      for (int32_t x = 0; x < W; ++x) prs::write(*dst, x, y, prs::Px{});
    };
    return prs::for_rows(in, H, row);
  }
  if (mode == kModeSceneDepth) {
    auto row = [&](int32_t y) {
      for (int32_t x = 0; x < W; ++x) {
        const float d = depth_at(sceneDepth, x, y);
        prs::write(*dst, x, y, std::isfinite(d) ? prs::Px{d / 1000.0F, 0, 0, 1} : prs::Px{0, 0, 1, 1});
      }
    };
    return prs::for_rows(in, H, row);
  }

  uint64_t key = 0;
  std::string why;
  const std::shared_ptr<const gltf_lite::Model> model = load_model(in, params, key, why);
  if (!model) {
    prs::message(out, why.c_str());
    return PR_ERR_NOT_FOUND;
  }
  std::vector<Sample> samples;
  if (PrErr e = scene_samples(in, params, *model, samples); e != PR_ERR_NONE) return e;
  const std::vector<Light> lights = comp_lights(in);
  Material mat = material_of(in, params);
  PrWorld* baseMap = nullptr;
  if (const uint32_t bi = index_of(in, params, kBaseMap); bi != 0 && params[bi]->file_name != nullptr) {  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    if (in->host->get_asset_image(in->host_ref, bi, &baseMap) != PR_ERR_NONE) baseMap = nullptr;
  }
  PrWorld* layerMap = nullptr;
  if (const uint32_t li = index_of(in, params, kTextureLayer); li != 0 && params[li]->layer_id != nullptr) {  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    if (in->host->checkout_layer_pixels(in->host_ref, kLayerCheckout, &layerMap) != PR_ERR_NONE) layerMap = nullptr;
  }
  const std::array<double, 3> modelColor{model->baseColor[0], model->baseColor[1], model->baseColor[2]};

  std::vector<float> accum(static_cast<std::size_t>(W) * static_cast<std::size_t>(H) * 4, 0.0F);
  std::vector<double> zbuf(static_cast<std::size_t>(W) * static_cast<std::size_t>(H));
  const double* c2w = in->comp_to_world;
  for (const Sample& s : samples) {
    // Each sub-frame occludes against the comp's 3D layers at ITS time (checked out in pre-render).
    PrWorld* sampleDepth = sceneDepth;
    if (wantDepth && s.time != in->current_time && has_depth_at(in)) {
      PrWorld* at = nullptr;
      if (in->host->checkout_scene_depth_at(in->host_ref, s.time, &at) == PR_ERR_NONE && at != nullptr) sampleDepth = at;
    }
    const M4 pvm = mul(s.proj, mul(s.view, s.model));
    const M4 vm = mul(s.view, s.model);
    const M4 nm = normal_matrix(s.model);
    std::vector<ScreenVertex> sv(model->vertices.size());
    std::vector<bool> ok(model->vertices.size());
    for (std::size_t i = 0; i < model->vertices.size(); ++i) {
      const gltf_lite::Vertex& v = model->vertices[i];
      const V3 lp{v.p[0], v.p[1], v.p[2]};
      const auto clip = apply(pvm, lp);
      const auto wp = apply(s.model, lp);
      const auto cp = apply(vm, lp);
      ScreenVertex o;
      ok[i] = clip[3] > 1e-6 && cp[2] > 1e-3;
      const double w = ok[i] ? clip[3] : 1;
      const double cx = clip[0] / w;
      const double cy = clip[1] / w;
      // NOLINTBEGIN(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      o.x = c2w[0] * cx + c2w[1] * cy + c2w[2];
      o.y = c2w[3] * cx + c2w[4] * cy + c2w[5];
      // NOLINTEND(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      o.z = cp[2];
      o.invW = 1 / w;
      o.p = {wp[0], wp[1], wp[2]};
      const auto n = apply(nm, {v.n[0], v.n[1], v.n[2]});
      o.n = {n[0] - nm[12], n[1] - nm[13], n[2] - nm[14]};
      o.u = v.uv[0];
      o.v = v.uv[1];
      sv[i] = o;
    }
    struct Tri {
      std::array<uint32_t, 3> v{};
      int32_t y0 = 0, y1 = 0;
    };
    std::vector<Tri> tris;
    for (std::size_t t = 0; t + 2 < model->indices.size(); t += 3) {
      Tri tri{{model->indices[t], model->indices[t + 1], model->indices[t + 2]}};
      if (!ok[tri.v[0]] || !ok[tri.v[1]] || !ok[tri.v[2]]) continue;  // reaches behind the eye: dropped (no clipping)
      const double ymin = std::min({sv[tri.v[0]].y, sv[tri.v[1]].y, sv[tri.v[2]].y});
      const double ymax = std::max({sv[tri.v[0]].y, sv[tri.v[1]].y, sv[tri.v[2]].y});
      tri.y0 = static_cast<int32_t>(std::max(0.0, std::floor(ymin - 0.5)));
      tri.y1 = static_cast<int32_t>(std::min(static_cast<double>(H - 1), std::ceil(ymax)));
      if (tri.y0 <= tri.y1) tris.push_back(tri);
    }
    auto row = [&](int32_t y) {
      double* zr = &zbuf[static_cast<std::size_t>(y) * static_cast<std::size_t>(W)];
      std::fill(zr, zr + W, std::numeric_limits<double>::infinity());  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      std::vector<float> colour(static_cast<std::size_t>(W) * 4, 0.0F);
      const double py = y + 0.5;
      for (const Tri& t : tris) {
        if (y < t.y0 || y > t.y1) continue;
        const ScreenVertex& a = sv[t.v[0]];
        const ScreenVertex& b = sv[t.v[1]];
        const ScreenVertex& c = sv[t.v[2]];
        const double area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if (std::abs(area) < 1e-12) continue;
        const double xmin = std::min({a.x, b.x, c.x});
        const double xmax = std::max({a.x, b.x, c.x});
        const auto x0 = static_cast<int32_t>(std::max(0.0, std::floor(xmin - 0.5)));
        const auto x1 = static_cast<int32_t>(std::min(static_cast<double>(W - 1), std::ceil(xmax)));
        for (int32_t x = x0; x <= x1; ++x) {
          const double px = x + 0.5;
          double l0 = ((b.x - px) * (c.y - py) - (b.y - py) * (c.x - px)) / area;
          double l1 = ((c.x - px) * (a.y - py) - (c.y - py) * (a.x - px)) / area;
          double l2 = 1 - l0 - l1;
          if (l0 < 0 || l1 < 0 || l2 < 0) continue;
          // Perspective-correct weights.
          const double q0 = l0 * a.invW, q1 = l1 * b.invW, q2 = l2 * c.invW;
          const double qs = q0 + q1 + q2;
          l0 = q0 / qs, l1 = q1 / qs, l2 = q2 / qs;
          const double z = l0 * a.z + l1 * b.z + l2 * c.z;
          if (z <= 0 || z >= zr[x]) continue;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
          if (wantDepth) {
            const double sd = depth_at(sampleDepth, x, y);
            if (z > sd + 0.5 + 0.001 * z) continue;  // behind the comp's 3D layers
          }
          zr[x] = z;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
          const double u = l0 * a.u + l1 * b.u + l2 * c.u;
          const double v = l0 * a.v + l1 * b.v + l2 * c.v;
          V3 albedo{mat.base[0] * modelColor[0], mat.base[1] * modelColor[1], mat.base[2] * modelColor[2]};
          if (baseMap != nullptr) {
            const auto t0 = texel(baseMap, u, v);
            for (std::size_t k = 0; k < 3; ++k) albedo.at(k) *= t0.at(k);
          }
          if (layerMap != nullptr) {
            const auto t1 = texel(layerMap, u, v);
            for (std::size_t k = 0; k < 3; ++k) albedo.at(k) *= t1.at(k);
          }
          const V3 p{l0 * a.p[0] + l1 * b.p[0] + l2 * c.p[0], l0 * a.p[1] + l1 * b.p[1] + l2 * c.p[1], l0 * a.p[2] + l1 * b.p[2] + l2 * c.p[2]};
          const V3 n = norm({l0 * a.n[0] + l1 * b.n[0] + l2 * c.n[0], l0 * a.n[1] + l1 * b.n[1] + l2 * c.n[1], l0 * a.n[2] + l1 * b.n[2] + l2 * c.n[2]});
          const V3 col = shade(albedo, n, p, s.eye, mat, lights);
          float* o = &colour[static_cast<std::size_t>(x) * 4];
          o[0] = static_cast<float>(col[0]);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
          o[1] = static_cast<float>(col[1]);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
          o[2] = static_cast<float>(col[2]);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
          o[3] = 1;                           // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
        }
      }
      float* acc = &accum[static_cast<std::size_t>(y) * static_cast<std::size_t>(W) * 4];
      for (std::size_t i = 0; i < colour.size(); ++i) acc[i] += colour[i] * s.weight;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    };
    if (PrErr e = prs::for_rows(in, H, row); e != PR_ERR_NONE) return e;
  }
  auto write = [&](int32_t y) {
    for (int32_t x = 0; x < W; ++x) {
      const float* a = &accum[(static_cast<std::size_t>(y) * static_cast<std::size_t>(W) + static_cast<std::size_t>(x)) * 4];
      prs::write(*dst, x, y, {a[0], a[1], a[2], a[3]});  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    }
  };
  return prs::for_rows(in, H, write);
}

// ── GPU ─────────────────────────────────────────────────────────────────────
#if defined(PRS_SAMPLE_GPU)

constexpr uint64_t kSlot = 1024;  // one sample's uniforms (U below: 196 floats), 256-aligned
constexpr uint32_t kSlots = kMaxShutter + 1;
constexpr std::size_t kUFloats = 16 * 3 + 4 * 5 + kMaxLights * 16;

constexpr const char* kWgsl = R"(
struct Light { color : vec4f, pos : vec4f, dir : vec4f, cone : vec4f };
struct U {
  mvp : mat4x4f,
  model : mat4x4f,
  nrm : mat4x4f,
  viewZ : vec4f,
  eye : vec4f,
  base : vec4f,
  mat : vec4f,   // roughness, specular, flags (1 base map, 2 layer map, 4 scene depth), light count
  misc : vec4f,  // depth knee, shininess, sample weight, mode (0 copy, 1 scene-depth view)
  lights : array<Light, 8>,
};
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var baseMap : texture_2d<f32>;
@group(0) @binding(2) var layerMap : texture_2d<f32>;
@group(0) @binding(3) var sceneDepth : texture_2d<f32>;

struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) world : vec3f,
  @location(1) n : vec3f,
  @location(2) uv : vec2f,
  @location(3) vz : f32,
};

@vertex
fn vs_mesh(@location(0) p : vec3f, @location(1) n : vec3f, @location(2) uv : vec2f) -> VOut {
  var o : VOut;
  let c = u.mvp * vec4f(p, 1.0);
  o.pos = vec4f(c.xy, 0.5 * c.w, c.w);
  o.world = (u.model * vec4f(p, 1.0)).xyz;
  o.n = (u.nrm * vec4f(n, 0.0)).xyz;
  o.uv = uv;
  o.vz = dot(u.viewZ.xyz, o.world) + u.viewZ.w;
  return o;
}

fn texel(t : texture_2d<f32>, uv : vec2f) -> vec3f {
  let d = textureDimensions(t);
  let f = uv - floor(uv);
  let p = min(vec2u(f * vec2f(d)), d - vec2u(1u));
  let c = textureLoad(t, p, 0);
  if (c.a <= 0.0) { return vec3f(0.0); }
  return c.rgb / c.a;
}

fn shade(albedo : vec3f, n0 : vec3f, p : vec3f) -> vec3f {
  let v = normalize(u.eye.xyz - p);
  var n = normalize(n0);
  if (dot(n, v) < 0.0) { n = -n; }
  let count = u32(u.mat.w + 0.5);
  if (count == 0u) {
    let nv = max(0.0, dot(n, v));
    return albedo * (0.3 + 0.7 * nv) + vec3f(u.mat.y * pow(nv, u.misc.y));
  }
  var c = vec3f(0.0);
  for (var i = 0u; i < count; i++) {
    let l = u.lights[i];
    let kind = i32(l.color.w + 0.5);
    if (kind == 3) { c += albedo * l.color.rgb; continue; }
    var L = normalize(l.pos.xyz - p);
    if (kind == 0) { L = -l.dir.xyz; }
    var att = 1.0;
    if (kind == 1) { att = smoothstep(l.cone.x, l.cone.y, -dot(L, l.dir.xyz)); }
    let ndl = max(0.0, dot(n, L));
    let h = normalize(L + v);
    var spec = 0.0;
    if (ndl > 0.0) { spec = u.mat.y * pow(max(0.0, dot(n, h)), u.misc.y); }
    c += (albedo * ndl + vec3f(spec)) * l.color.rgb * att;
  }
  return c;
}

struct FOut { @location(0) color : vec4f, @builtin(frag_depth) depth : f32 };

@fragment
fn fs_mesh(i : VOut) -> FOut {
  let flags = u32(u.mat.z + 0.5);
  if (i.vz <= 0.0) { discard; }
  if ((flags & 4u) != 0u) {
    let dd = textureDimensions(sceneDepth);
    let px = min(vec2u(i.pos.xy), dd - vec2u(1u));
    let sd = textureLoad(sceneDepth, px, 0).r;
    if (i.vz > sd + 0.5 + 0.001 * i.vz) { discard; }
  }
  var albedo = u.base.rgb;
  if ((flags & 1u) != 0u) { albedo *= texel(baseMap, i.uv); }
  if ((flags & 2u) != 0u) { albedo *= texel(layerMap, i.uv); }
  var o : FOut;
  o.color = vec4f(shade(albedo, i.n, i.world), 1.0);
  o.depth = i.vz / (i.vz + u.misc.x);
  return o;
}

@vertex
fn vs_full(@builtin(vertex_index) k : u32) -> @builtin(position) vec4f {
  let xy = vec2f(f32((k << 1u) & 2u), f32(k & 2u));
  return vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
}

// A sample into the accumulation (additive blend), × its weight.
@fragment
fn fs_accum(@builtin(position) pos : vec4f) -> @location(0) vec4f {
  return textureLoad(baseMap, vec2u(pos.xy), 0) * u.misc.z;
}

// The accumulation (or the scene depth, mode 1) into the effect's output.
@fragment
fn fs_out(@builtin(position) pos : vec4f) -> @location(0) vec4f {
  let dd = textureDimensions(baseMap);
  let c = textureLoad(baseMap, min(vec2u(pos.xy), dd - vec2u(1u)), 0);
  if (u.misc.w > 0.5) {
    if (c.r > 3.0e38) { return vec4f(0.0, 0.0, 1.0, 1.0); }  // +inf: nothing drawn
    return vec4f(c.r / 1000.0, 0.0, 0.0, 1.0);
  }
  return c;
}
)";

WGPUStringView sv(const char* s) { return WGPUStringView{s, WGPU_STRLEN}; }

WGPUTextureFormat wgpu_format(PrGpuFormat f) {
  return f == PR_GPU_FORMAT_RGBA32_FLOAT   ? WGPUTextureFormat_RGBA32Float
         : f == PR_GPU_FORMAT_RGBA16_FLOAT ? WGPUTextureFormat_RGBA16Float
         : f == PR_GPU_FORMAT_R32_FLOAT    ? WGPUTextureFormat_R32Float
                                           : WGPUTextureFormat_RGBA8Unorm;
}

/// What GPU_DEVICE_SETUP builds (behind the gpu_data handle) and the render's size-keyed targets.
struct Gpu {
  const DawnProcTable* p = nullptr;
  WGPUDevice device = nullptr;
  WGPUQueue queue = nullptr;
  WGPUShaderModule module = nullptr;
  WGPUBindGroupLayout layout = nullptr;
  WGPUPipelineLayout pipelineLayout = nullptr;
  WGPURenderPipeline mesh = nullptr;
  WGPURenderPipeline accum = nullptr;
  std::array<WGPURenderPipeline, 3> out{};  // by PrGpuFormat (rgba8 / rgba16f / rgba32f)
  WGPUBuffer uniforms = nullptr;
  WGPUTexture white = nullptr, inf = nullptr;
  WGPUTextureView whiteView = nullptr, infView = nullptr;
  // Per size.
  int32_t w = 0, h = 0;
  WGPUTexture sample = nullptr, accumTex = nullptr, depth = nullptr;
  WGPUTextureView sampleView = nullptr, accumView = nullptr, depthView = nullptr;
  // Per model content.
  uint64_t modelKey = 0;
  WGPUBuffer vb = nullptr, ib = nullptr;
  uint32_t indexCount = 0;
  std::mutex mutex;

  void release_size() {
    for (WGPUTextureView* v : {&sampleView, &accumView, &depthView}) {
      if (*v != nullptr) p->textureViewRelease(*v);
      *v = nullptr;
    }
    for (WGPUTexture* t : {&sample, &accumTex, &depth}) {
      if (*t != nullptr) p->textureRelease(*t);
      *t = nullptr;
    }
  }
  void release_model() {
    if (vb != nullptr) p->bufferRelease(vb);
    if (ib != nullptr) p->bufferRelease(ib);
    vb = ib = nullptr;
    modelKey = 0;
  }
  WGPUTexture texture(int32_t tw, int32_t th, WGPUTextureFormat f, WGPUTextureUsage usage, const char* label) const {
    WGPUTextureDescriptor td = WGPU_TEXTURE_DESCRIPTOR_INIT;
    td.label = sv(label);
    td.size = {static_cast<uint32_t>(tw), static_cast<uint32_t>(th), 1};
    td.format = f;
    td.usage = usage;
    return p->deviceCreateTexture(device, &td);
  }
  void ensure_size(int32_t tw, int32_t th) {
    if (tw == w && th == h && sample != nullptr) return;
    release_size();
    w = tw;
    h = th;
    sample = texture(tw, th, WGPUTextureFormat_RGBA16Float, WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding, "model3d-sample");
    accumTex = texture(tw, th, WGPUTextureFormat_RGBA16Float, WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding, "model3d-accum");
    depth = texture(tw, th, WGPUTextureFormat_Depth32Float, WGPUTextureUsage_RenderAttachment, "model3d-depth");
    sampleView = p->textureCreateView(sample, nullptr);
    accumView = p->textureCreateView(accumTex, nullptr);
    depthView = p->textureCreateView(depth, nullptr);
  }
};

Gpu* gpu_of(const PrInData* in, PrHandle h) {
  void* ptr = in->host->handle_lock(in->host_ref, h);
  if (ptr == nullptr) return nullptr;
  Gpu* g = nullptr;
  std::memcpy(&g, ptr, sizeof(g));
  return g;
}

PrErr gpu_setup(const PrInData* in, PrGpuDeviceSetupExtra* x) {
  const auto* procs = static_cast<const DawnProcTable*>(x->device->procs);
  if (procs == nullptr || x->device->framework != PR_GPU_FRAMEWORK_WEBGPU_DAWN) return PR_ERR_UNSUPPORTED;
  const PrHandle h = in->host->handle_new(in->host_ref, sizeof(Gpu*));
  if (h == 0) return PR_ERR_OUT_OF_MEMORY;
  auto* g = new Gpu();  // NOLINT(cppcoreguidelines-owning-memory): owned through the handle until GPU_DEVICE_SETDOWN
  const DawnProcTable* p = procs;
  g->p = p;
  g->device = static_cast<WGPUDevice>(x->device->wgpu_device);
  g->queue = static_cast<WGPUQueue>(x->device->wgpu_queue);
  p->deviceAddRef(g->device);
  p->queueAddRef(g->queue);

  WGPUShaderSourceWGSL src = WGPU_SHADER_SOURCE_WGSL_INIT;
  src.code = sv(kWgsl);
  WGPUShaderModuleDescriptor md = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
  md.nextInChain = &src.chain;
  md.label = sv("model3d");
  g->module = p->deviceCreateShaderModule(g->device, &md);

  // Explicit layout: every texture is read with textureLoad (unfilterable float: rgba32float maps,
  // the r32float scene depth); the uniforms at a dynamic offset, one slot per sample.
  std::array<WGPUBindGroupLayoutEntry, 4> e{};
  for (auto& en : e) en = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
  e[0].binding = 0;
  e[0].visibility = WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
  e[0].buffer.type = WGPUBufferBindingType_Uniform;
  e[0].buffer.hasDynamicOffset = 1;
  e[0].buffer.minBindingSize = kUFloats * sizeof(float);
  for (uint32_t b = 1; b <= 3; ++b) {
    e.at(b).binding = b;
    e.at(b).visibility = WGPUShaderStage_Fragment;
    e.at(b).texture.sampleType = WGPUTextureSampleType_UnfilterableFloat;
    e.at(b).texture.viewDimension = WGPUTextureViewDimension_2D;
  }
  WGPUBindGroupLayoutDescriptor bld = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
  bld.entryCount = e.size();
  bld.entries = e.data();
  g->layout = p->deviceCreateBindGroupLayout(g->device, &bld);
  WGPUPipelineLayoutDescriptor pld = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
  pld.bindGroupLayoutCount = 1;
  pld.bindGroupLayouts = &g->layout;
  g->pipelineLayout = p->deviceCreatePipelineLayout(g->device, &pld);

  const auto pipeline = [&](const char* vs, const char* fs, WGPUTextureFormat f, bool meshInput, bool depth, bool additive) {
    std::array<WGPUVertexAttribute, 3> attrs{};
    for (auto& a : attrs) a = WGPU_VERTEX_ATTRIBUTE_INIT;
    attrs[0].format = WGPUVertexFormat_Float32x3;
    attrs[0].offset = 0;
    attrs[0].shaderLocation = 0;
    attrs[1].format = WGPUVertexFormat_Float32x3;
    attrs[1].offset = 12;
    attrs[1].shaderLocation = 1;
    attrs[2].format = WGPUVertexFormat_Float32x2;
    attrs[2].offset = 24;
    attrs[2].shaderLocation = 2;
    WGPUVertexBufferLayout vbl = WGPU_VERTEX_BUFFER_LAYOUT_INIT;
    vbl.arrayStride = sizeof(gltf_lite::Vertex);
    vbl.attributeCount = attrs.size();
    vbl.attributes = attrs.data();
    WGPUBlendState blend = WGPU_BLEND_STATE_INIT;
    blend.color = {WGPUBlendOperation_Add, WGPUBlendFactor_One, WGPUBlendFactor_One};
    blend.alpha = {WGPUBlendOperation_Add, WGPUBlendFactor_One, WGPUBlendFactor_One};
    WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
    target.format = f;
    target.blend = additive ? &blend : nullptr;
    WGPUFragmentState frag = WGPU_FRAGMENT_STATE_INIT;
    frag.module = g->module;
    frag.entryPoint = sv(fs);
    frag.targetCount = 1;
    frag.targets = &target;
    WGPUDepthStencilState ds = WGPU_DEPTH_STENCIL_STATE_INIT;
    ds.format = WGPUTextureFormat_Depth32Float;
    ds.depthWriteEnabled = WGPUOptionalBool_True;
    ds.depthCompare = WGPUCompareFunction_Less;
    WGPURenderPipelineDescriptor pd = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    pd.label = sv("model3d");
    pd.layout = g->pipelineLayout;
    pd.vertex.module = g->module;
    pd.vertex.entryPoint = sv(vs);
    pd.vertex.bufferCount = meshInput ? 1 : 0;
    pd.vertex.buffers = meshInput ? &vbl : nullptr;
    pd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    pd.primitive.cullMode = WGPUCullMode_None;
    pd.depthStencil = depth ? &ds : nullptr;
    pd.fragment = &frag;
    return p->deviceCreateRenderPipeline(g->device, &pd);
  };
  g->mesh = pipeline("vs_mesh", "fs_mesh", WGPUTextureFormat_RGBA16Float, true, true, false);
  g->accum = pipeline("vs_full", "fs_accum", WGPUTextureFormat_RGBA16Float, false, false, true);
  for (PrGpuFormat f = PR_GPU_FORMAT_RGBA8_UNORM; f <= PR_GPU_FORMAT_RGBA32_FLOAT; ++f) {
    g->out.at(static_cast<std::size_t>(f)) = pipeline("vs_full", "fs_out", wgpu_format(f), false, false, false);
  }
  WGPUBufferDescriptor bd = WGPU_BUFFER_DESCRIPTOR_INIT;
  bd.label = sv("model3d-uniforms");
  bd.size = kSlot * kSlots;
  bd.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
  g->uniforms = p->deviceCreateBuffer(g->device, &bd);

  // 1×1 stand-ins for unbound maps (white) and an absent scene depth (+inf).
  g->white = g->texture(1, 1, WGPUTextureFormat_RGBA32Float, WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst, "model3d-white");
  g->inf = g->texture(1, 1, WGPUTextureFormat_R32Float, WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst, "model3d-inf");
  g->whiteView = p->textureCreateView(g->white, nullptr);
  g->infView = p->textureCreateView(g->inf, nullptr);
  const std::array<float, 4> one{1, 1, 1, 1};
  const float inf = std::numeric_limits<float>::infinity();
  WGPUTexelCopyBufferLayout bl = WGPU_TEXEL_COPY_BUFFER_LAYOUT_INIT;
  bl.bytesPerRow = 16;
  bl.rowsPerImage = 1;
  const WGPUExtent3D ext{1, 1, 1};
  WGPUTexelCopyTextureInfo dst = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
  dst.texture = g->white;
  p->queueWriteTexture(g->queue, &dst, one.data(), sizeof(one), &bl, &ext);
  dst.texture = g->inf;
  bl.bytesPerRow = 4;
  p->queueWriteTexture(g->queue, &dst, &inf, sizeof(inf), &bl, &ext);

  std::memcpy(in->host->handle_lock(in->host_ref, h), &g, sizeof(g));
  x->gpu_data = h;
  return PR_ERR_NONE;
}

PrErr gpu_setdown(const PrInData* in, PrGpuDeviceSetupExtra* x) {
  Gpu* g = gpu_of(in, x->gpu_data);
  if (g != nullptr) {
    const DawnProcTable* p = g->p;
    g->release_size();
    g->release_model();
    for (WGPURenderPipeline rp : {g->mesh, g->accum, g->out[0], g->out[1], g->out[2]}) {
      if (rp != nullptr) p->renderPipelineRelease(rp);
    }
    if (g->whiteView != nullptr) p->textureViewRelease(g->whiteView);
    if (g->infView != nullptr) p->textureViewRelease(g->infView);
    if (g->white != nullptr) p->textureRelease(g->white);
    if (g->inf != nullptr) p->textureRelease(g->inf);
    if (g->uniforms != nullptr) p->bufferRelease(g->uniforms);
    if (g->pipelineLayout != nullptr) p->pipelineLayoutRelease(g->pipelineLayout);
    if (g->layout != nullptr) p->bindGroupLayoutRelease(g->layout);
    if (g->module != nullptr) p->shaderModuleRelease(g->module);
    p->queueRelease(g->queue);
    p->deviceRelease(g->device);
    delete g;  // NOLINT(cppcoreguidelines-owning-memory): see gpu_setup
  }
  in->host->handle_dispose(in->host_ref, x->gpu_data);
  x->gpu_data = 0;
  return PR_ERR_NONE;
}

void put(std::vector<float>& u, std::size_t at, const M4& m) {
  for (std::size_t i = 0; i < 16; ++i) u[at + i] = static_cast<float>(m[i]);
}
void put4(std::vector<float>& u, std::size_t at, double a, double b, double c, double d) {
  u[at] = static_cast<float>(a);
  u[at + 1] = static_cast<float>(b);
  u[at + 2] = static_cast<float>(c);
  u[at + 3] = static_cast<float>(d);
}

PrErr gpu_render(const PrInData* in, PrOutData* out, PrParamDef* const* params, PrSmartRenderGpuExtra* x) {
  if (const PrErr f = prs::inject(prs::by_id(params, in, prs::kFaultParamId), out); f != PR_ERR_NONE) return f;
  if (!has_v12(in)) return PR_ERR_BAD_VERSION;
  Gpu* g = gpu_of(in, x->gpu_data);
  if (g == nullptr || x->output == nullptr) return PR_ERR_INVALID_PARAM;
  const std::scoped_lock lock(g->mutex);
  const DawnProcTable* p = g->p;
  const int32_t W = x->output->width;
  const int32_t H = x->output->height;
  if (W <= 0 || H <= 0) return PR_ERR_NONE;
  const auto fmt = static_cast<std::size_t>(std::clamp(x->output->format, PR_GPU_FORMAT_RGBA8_UNORM, PR_GPU_FORMAT_RGBA32_FLOAT));
  g->ensure_size(W, H);

  const bool wantDepth = prs::num(params, in, kSceneDepth) != 0;
  const int mode = static_cast<int>(prs::num(params, in, kRenderMode, 0, kModeShaded));
  const PrGpuWorld* sceneDepth = nullptr;
  if ((wantDepth || mode == kModeSceneDepth) && has_depth_suite(in)) {
    if (in->host->checkout_scene_depth_gpu(in->host_ref, &sceneDepth) != PR_ERR_NONE) sceneDepth = nullptr;
  }
  const WGPUTextureView depthView = sceneDepth != nullptr ? static_cast<WGPUTextureView>(sceneDepth->wgpu_texture_view) : g->infView;

  std::vector<float> u(static_cast<std::size_t>(kSlot / sizeof(float) * kSlots), 0.0F);
  const auto slot = [](uint32_t i) { return static_cast<std::size_t>(i) * (kSlot / sizeof(float)); };
  const auto bind = [&](WGPUTextureView a, WGPUTextureView b, WGPUTextureView c) {
    std::array<WGPUBindGroupEntry, 4> be{};
    for (auto& en : be) en = WGPU_BIND_GROUP_ENTRY_INIT;
    be[0].binding = 0;
    be[0].buffer = g->uniforms;
    be[0].size = kUFloats * sizeof(float);
    be[1].binding = 1;
    be[1].textureView = a;
    be[2].binding = 2;
    be[2].textureView = b;
    be[3].binding = 3;
    be[3].textureView = c;
    WGPUBindGroupDescriptor bgd = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    bgd.layout = g->layout;
    bgd.entryCount = be.size();
    bgd.entries = be.data();
    return p->deviceCreateBindGroup(g->device, &bgd);
  };
  const auto encoder = static_cast<WGPUCommandEncoder>(x->wgpu_command_encoder);
  const auto final_pass = [&](WGPUTextureView src, bool depthMode) {
    put4(u, slot(kSlots - 1) + 64, 0, 0, 1, depthMode ? 1 : 0);  // misc
    p->queueWriteBuffer(g->queue, g->uniforms, 0, u.data(), u.size() * sizeof(float));
    const WGPUBindGroup bg = bind(src, g->whiteView, g->infView);
    WGPURenderPassColorAttachment ca = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    ca.view = static_cast<WGPUTextureView>(x->output->wgpu_texture_view);
    ca.loadOp = WGPULoadOp_Clear;
    ca.storeOp = WGPUStoreOp_Store;
    WGPURenderPassDescriptor rp = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    rp.colorAttachmentCount = 1;
    rp.colorAttachments = &ca;
    const WGPURenderPassEncoder pass = p->commandEncoderBeginRenderPass(encoder, &rp);
    p->renderPassEncoderSetPipeline(pass, g->out.at(fmt));
    const auto off = static_cast<uint32_t>(slot(kSlots - 1) * sizeof(float));
    p->renderPassEncoderSetBindGroup(pass, 0, bg, 1, &off);
    p->renderPassEncoderDraw(pass, 3, 1, 0, 0);
    p->renderPassEncoderEnd(pass);
    p->renderPassEncoderRelease(pass);
    p->bindGroupRelease(bg);
  };
  if (mode == kModeSceneDepth) {
    final_pass(depthView, true);
    return PR_ERR_NONE;
  }

  uint64_t key = 0;
  std::string why;
  const std::shared_ptr<const gltf_lite::Model> model = load_model(in, params, key, why);
  if (!model) {
    prs::message(out, why.c_str());
    return PR_ERR_NOT_FOUND;
  }
  if (g->modelKey != key) {
    g->release_model();
    WGPUBufferDescriptor bd = WGPU_BUFFER_DESCRIPTOR_INIT;
    bd.label = sv("model3d-vertices");
    bd.size = (model->vertices.size() * sizeof(gltf_lite::Vertex) + 3U) & ~uint64_t{3};
    bd.usage = WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst;
    g->vb = p->deviceCreateBuffer(g->device, &bd);
    p->queueWriteBuffer(g->queue, g->vb, 0, model->vertices.data(), model->vertices.size() * sizeof(gltf_lite::Vertex));
    bd.label = sv("model3d-indices");
    bd.size = model->indices.size() * sizeof(uint32_t);
    bd.usage = WGPUBufferUsage_Index | WGPUBufferUsage_CopyDst;
    g->ib = p->deviceCreateBuffer(g->device, &bd);
    p->queueWriteBuffer(g->queue, g->ib, 0, model->indices.data(), model->indices.size() * sizeof(uint32_t));
    g->indexCount = static_cast<uint32_t>(model->indices.size());
    g->modelKey = key;
  }

  std::vector<Sample> samples;
  if (PrErr e = scene_samples(in, params, *model, samples); e != PR_ERR_NONE) return e;
  if (mode == kModeInScene) samples.clear();  // D4: the host draws it in the comp's 3D scene; a clear output here
  const std::vector<Light> lights = comp_lights(in);
  const Material mat = material_of(in, params);
  WGPUTextureView baseView = g->whiteView;
  WGPUTextureView layerView = g->whiteView;
  uint32_t flags = 0;
  if (const uint32_t bi = index_of(in, params, kBaseMap); bi != 0 && params[bi]->file_name != nullptr) {  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    const PrGpuWorld* bw = nullptr;
    if (in->host->get_asset_image_gpu(in->host_ref, bi, &bw) == PR_ERR_NONE && bw != nullptr) {
      baseView = static_cast<WGPUTextureView>(bw->wgpu_texture_view);
      flags |= 1U;
    }
  }
  if (const uint32_t li = index_of(in, params, kTextureLayer); li != 0 && params[li]->layer_id != nullptr) {  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    const PrGpuWorld* lw = nullptr;
    if (in->host->checkout_layer_gpu(in->host_ref, kLayerCheckout, &lw) == PR_ERR_NONE && lw != nullptr) {
      layerView = static_cast<WGPUTextureView>(lw->wgpu_texture_view);
      flags |= 2U;
    }
  }
  // Each sub-frame occludes against the comp's 3D layers at ITS time (checked out in pre-render).
  std::vector<WGPUTextureView> sampleDepth(samples.size(), sceneDepth != nullptr ? depthView : nullptr);
  for (std::size_t i = 0; wantDepth && has_depth_at(in) && i < samples.size(); ++i) {
    if (samples[i].time == in->current_time) continue;
    const PrGpuWorld* at = nullptr;
    if (in->host->checkout_scene_depth_gpu_at(in->host_ref, samples[i].time, &at) == PR_ERR_NONE && at != nullptr) {
      sampleDepth[i] = static_cast<WGPUTextureView>(at->wgpu_texture_view);
    }
  }
  const M4 c2c = comp_to_clip(in->comp_to_world, W, H);
  for (std::size_t i = 0; i < samples.size(); ++i) {
    const Sample& s = samples[i];
    const std::size_t at = slot(static_cast<uint32_t>(i));
    const uint32_t sflags = flags | (wantDepth && sampleDepth[i] != nullptr ? 4U : 0U);
    put(u, at, mul(c2c, mul(s.proj, mul(s.view, s.model))));
    put(u, at + 16, s.model);
    put(u, at + 32, normal_matrix(s.model));
    put4(u, at + 48, s.view[2], s.view[6], s.view[10], s.view[14]);
    put4(u, at + 52, s.eye[0], s.eye[1], s.eye[2], 1);
    put4(u, at + 56, mat.base[0] * model->baseColor[0], mat.base[1] * model->baseColor[1], mat.base[2] * model->baseColor[2], 1);
    put4(u, at + 60, mat.roughness, mat.specular, sflags, static_cast<double>(lights.size()));
    put4(u, at + 64, kDepthKnee, shininess(mat.roughness), s.weight, 0);
    for (std::size_t k = 0; k < lights.size(); ++k) {
      const Light& l = lights[k];
      const std::size_t lo = at + 68 + k * 16;
      put4(u, lo, l.color[0], l.color[1], l.color[2], l.type);
      put4(u, lo + 4, l.pos[0], l.pos[1], l.pos[2], 0);
      put4(u, lo + 8, l.dir[0], l.dir[1], l.dir[2], 0);
      put4(u, lo + 12, l.cosOuter, l.cosInner, 0, 0);
    }
  }
  // Queue-ordered: the host submits this call's commands before the next call can write again.
  p->queueWriteBuffer(g->queue, g->uniforms, 0, u.data(), u.size() * sizeof(float));

  const WGPUBindGroup accumGroup = bind(g->sampleView, g->whiteView, g->infView);
  for (std::size_t i = 0; i < samples.size(); ++i) {
    const auto off = static_cast<uint32_t>(slot(static_cast<uint32_t>(i)) * sizeof(float));
    const WGPUBindGroup meshGroup = bind(baseView, layerView, sampleDepth[i] != nullptr ? sampleDepth[i] : g->infView);
    {
      WGPURenderPassColorAttachment ca = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
      ca.view = g->sampleView;
      ca.loadOp = WGPULoadOp_Clear;
      ca.storeOp = WGPUStoreOp_Store;
      ca.clearValue = {0, 0, 0, 0};
      WGPURenderPassDepthStencilAttachment da = WGPU_RENDER_PASS_DEPTH_STENCIL_ATTACHMENT_INIT;
      da.view = g->depthView;
      da.depthLoadOp = WGPULoadOp_Clear;
      da.depthStoreOp = WGPUStoreOp_Discard;
      da.depthClearValue = 1.0F;
      WGPURenderPassDescriptor rp = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
      rp.colorAttachmentCount = 1;
      rp.colorAttachments = &ca;
      rp.depthStencilAttachment = &da;
      const WGPURenderPassEncoder pass = p->commandEncoderBeginRenderPass(encoder, &rp);
      p->renderPassEncoderSetPipeline(pass, g->mesh);
      p->renderPassEncoderSetBindGroup(pass, 0, meshGroup, 1, &off);
      p->renderPassEncoderSetVertexBuffer(pass, 0, g->vb, 0, WGPU_WHOLE_SIZE);
      p->renderPassEncoderSetIndexBuffer(pass, g->ib, WGPUIndexFormat_Uint32, 0, WGPU_WHOLE_SIZE);
      p->renderPassEncoderDrawIndexed(pass, g->indexCount, 1, 0, 0, 0);
      p->renderPassEncoderEnd(pass);
      p->renderPassEncoderRelease(pass);
    }
    p->bindGroupRelease(meshGroup);
    {
      WGPURenderPassColorAttachment ca = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
      ca.view = g->accumView;
      ca.loadOp = i == 0 ? WGPULoadOp_Clear : WGPULoadOp_Load;
      ca.storeOp = WGPUStoreOp_Store;
      ca.clearValue = {0, 0, 0, 0};
      WGPURenderPassDescriptor rp = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
      rp.colorAttachmentCount = 1;
      rp.colorAttachments = &ca;
      const WGPURenderPassEncoder pass = p->commandEncoderBeginRenderPass(encoder, &rp);
      p->renderPassEncoderSetPipeline(pass, g->accum);
      p->renderPassEncoderSetBindGroup(pass, 0, accumGroup, 1, &off);
      p->renderPassEncoderDraw(pass, 3, 1, 0, 0);
      p->renderPassEncoderEnd(pass);
      p->renderPassEncoderRelease(pass);
    }
  }
  if (samples.empty()) {
    // Nothing evaluated (a renderer without the frame hook at a blurred time): a clear output.
    WGPURenderPassColorAttachment ca = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    ca.view = g->accumView;
    ca.loadOp = WGPULoadOp_Clear;
    ca.storeOp = WGPUStoreOp_Store;
    WGPURenderPassDescriptor rp = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    rp.colorAttachmentCount = 1;
    rp.colorAttachments = &ca;
    const WGPURenderPassEncoder pass = p->commandEncoderBeginRenderPass(encoder, &rp);
    p->renderPassEncoderEnd(pass);
    p->renderPassEncoderRelease(pass);
  }
  p->bindGroupRelease(accumGroup);
  final_pass(g->accumView, false);
  return PR_ERR_NONE;
}
#endif  // PRS_SAMPLE_GPU

// ── setup, pre-render, overlay ──────────────────────────────────────────────

PrErr params_setup(const PrInData* in) {
  PrParamDef model = prs::param(PR_PARAM_FILE, kModel, "Model");
  model.file_types = "glb|gltf";
  PrErr e = in->host->add_param(in->host_ref, &model);
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_POINT_3D, kPosition, "Position", {0, 0, 0, 0});
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_ANGLE, kOrientX, "X Rotation", {20, 0, 0, 0});
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_ANGLE, kOrientY, "Y Rotation", {30, 0, 0, 0});
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_ANGLE, kOrientZ, "Z Rotation", {0, 0, 0, 0});
  if (e == PR_ERR_NONE) e = prs::add_float(in, kSize, "Size", 200, 0, 10000, 1, 1000, 1);
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_LAYER, kTransformLayer, "Transform Layer", {0, 0, 0, 0});
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_GROUP_START, kMaterialGroup, "Material", {});
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_COLOR, kBaseColor, "Base Color", {0.8, 0.8, 0.8, 1});
  if (e == PR_ERR_NONE) e = prs::add_float(in, kRoughness, "Roughness", 40, 2, 100, 2, 100, 1);
  if (e == PR_ERR_NONE) e = prs::add_float(in, kSpecular, "Specular", 50, 0, 100, 0, 100, 1);
  if (e == PR_ERR_NONE) {
    PrParamDef map = prs::param(PR_PARAM_FILE, kBaseMap, "Base Color Map");
    map.file_types = "png|jpg|jpeg|exr|hdr|tif|tiff|webp|ppm|pfm";
    e = in->host->add_param(in->host_ref, &map);
  }
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_LAYER, kTextureLayer, "Texture Layer", {0, 0, 0, 0});
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_GROUP_END, kMaterialGroupEnd, "", {});
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_CHECKBOX, kSceneDepth, "Composite with Scene Depth", {0, 0, 0, 0});
  if (e == PR_ERR_NONE) e = prs::add_simple(in, PR_PARAM_CHECKBOX, kBlur, "Motion Blur", {1, 0, 0, 0});
  if (e == PR_ERR_NONE) {
    e = prs::add_simple(in, PR_PARAM_POPUP, kRenderMode, "Render Mode", {kModeShaded, 0, 0, 0}, 0, "Shaded|Scene Depth|In the Comp's 3D Scene");
  }
  if (e == PR_ERR_NONE) e = prs::add_fault_params(in);
  return e;
}

/// D4 — In the Comp's 3D Scene (PR_CMD_SCENE_CONTRIBUTE): the model's triangles and material, in the
/// layer's px at Position (the layer's own 3D transform places that in the comp). The host draws them on its 3D path. Base Color Map / Texture Layer are not carried there.
PrErr contribute(const PrInData* in, PrParamDef* const* params) {
  if (static_cast<int>(prs::num(params, in, kRenderMode, 0, kModeShaded)) != kModeInScene) return PR_ERR_NONE;
  if (in->host->struct_size < offsetof(PrHostSuite, scene_add_mesh) + sizeof(void*)) return PR_ERR_BAD_VERSION;
  uint64_t key = 0;
  std::string why;
  const std::shared_ptr<const gltf_lite::Model> model = load_model(in, params, key, why);
  if (!model) return PR_ERR_NOT_FOUND;
  if (model->vertices.empty() || model->indices.empty() || model->vertices.size() > PR_MAX_SCENE_VERTICES) return PR_ERR_INVALID_PARAM;
  const double ext = std::max({static_cast<double>(model->hi[0] - model->lo[0]), static_cast<double>(model->hi[1] - model->lo[1]),
                               static_cast<double>(model->hi[2] - model->lo[2]), 1e-9});
  const double s = std::max(0.0, prs::num(params, in, kSize)) / ext;
  const M4 local = mul(scale(s, -s, -s), translate(-0.5 * (model->lo[0] + model->hi[0]), -0.5 * (model->lo[1] + model->hi[1]),
                                                   -0.5 * (model->lo[2] + model->hi[2])));
  const M4 r = mul(rot(2, prs::num(params, in, kOrientZ)), mul(rot(1, prs::num(params, in, kOrientY)), rot(0, prs::num(params, in, kOrientX))));
  // Position is a point param in layer px (the host defaults it to the layer's centre).
  const M4 place = mul(translate(prs::num(params, in, kPosition, 0), prs::num(params, in, kPosition, 1), prs::num(params, in, kPosition, 2)),
                       mul(r, local));
  const std::size_t n = model->vertices.size();
  std::vector<float> pos(3 * n);
  std::vector<float> nrm(3 * n);
  std::vector<float> uv(2 * n);
  for (std::size_t i = 0; i < n; ++i) {
    const gltf_lite::Vertex& v = model->vertices[i];
    for (std::size_t k = 0; k < 3; ++k) {
      pos[(3 * i) + k] = v.p.at(k);
      nrm[(3 * i) + k] = v.n.at(k);
    }
    uv[2 * i] = v.uv[0];
    uv[(2 * i) + 1] = v.uv[1];
  }
  PrSceneMesh mesh{};
  mesh.struct_size = sizeof(PrSceneMesh);
  mesh.positions = pos.data();
  mesh.normals = nrm.data();
  mesh.uvs = uv.data();
  mesh.vertex_count = static_cast<uint32_t>(n);
  mesh.indices = model->indices.data();
  mesh.index_count = static_cast<uint32_t>(model->indices.size());
  for (std::size_t i = 0; i < 16; ++i) mesh.transform[i] = place.at(i);  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
  const Material mat = material_of(in, params);
  mesh.material.struct_size = sizeof(PrSceneMaterial);
  for (std::size_t k = 0; k < 3; ++k) mesh.material.base_color[k] = mat.base.at(k) * model->baseColor.at(k);  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
  mesh.material.base_color[3] = model->baseColor[3];
  mesh.material.metallic = 0;
  mesh.material.roughness = mat.roughness;
  mesh.material.casts_shadows = 1;
  mesh.material.accepts_shadows = 1;
  return in->host->scene_add_mesh(in->host_ref, &mesh);
}

PrErr pre_render(const PrInData* in, PrParamDef* const* params) {
  if (!has_v12(in)) return PR_ERR_NONE;
  // Composite with Scene Depth under motion blur: the comp's 3D layers at each sub-time too.
  const uint32_t depth = prs::num(params, in, kSceneDepth) != 0 && has_depth_at(in) ? PR_SAMPLE_SCENE_DEPTH : 0U;
  for (const int64_t t : sample_times(in, params)) {
    if (t == in->current_time) continue;
    const uint32_t what = PR_SAMPLE_PARAMS | PR_SAMPLE_CAMERA | PR_SAMPLE_LAYER_TRANSFORMS | depth;
    if (PrErr e = in->host->checkout_time(in->host_ref, t, what); e != PR_ERR_NONE) return e;
  }
  const uint32_t li = index_of(in, params, kTextureLayer);
  if (li != 0 && params[li] != nullptr && params[li]->layer_id != nullptr) {  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    return in->host->checkout_layer(in->host_ref, li, kLayerCheckout, in->current_time, nullptr);
  }
  return PR_ERR_NONE;
}

/// The comp camera at the viewer's time (DRAW_OVERLAY / OVERLAY_DRAG may read it on an SDK 1.2
/// host that has overlay_set_space). False = no camera to project with.
bool overlay_camera(const PrInData* in, PrCamera& cam) {
  if (!has_overlay_space(in)) return false;
  cam = PrCamera{};
  cam.struct_size = sizeof(cam);
  return in->host->get_comp_camera(in->host_ref, in->current_time, &cam) == PR_ERR_NONE;
}

/// World px → comp px through the camera; false behind the eye.
bool project(const PrCamera& cam, const V3& p, double& x, double& y) {
  const M4 pv = mul(from(cam.projection), from(cam.view));
  const auto c = apply(pv, p);  // named: an rvalue would bind std::apply through ADL
  if (!(c[3] > 1e-9)) return false;
  x = c[0] / c[3];
  y = c[1] / c[3];
  return std::isfinite(x) && std::isfinite(y);
}

/// DRAW_OVERLAY: a crosshair on the model and a square around it. SDK 1.2: projected through the
/// comp camera at the viewer's time and drawn in COMP px (overlay_set_space), so the handle sits on
/// the model under any camera. An older host (no camera in the overlay): at Position's x / y in
/// layer px — right only under the default camera on a comp-sized layer at the comp's origin.
PrErr draw_overlay(const PrInData* in, PrParamDef* const* params) {
  if (in->host->struct_size < offsetof(PrHostSuite, overlay_handle) + sizeof(void*)) return PR_ERR_UNSUPPORTED;
  const uint32_t layerIdx = index_of(in, params, kTransformLayer);
  if (layerIdx != 0 && params[layerIdx]->layer_id != nullptr) return PR_ERR_NONE;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic): the layer places it
  const V3 pos{prs::num(params, in, kPosition, 0), prs::num(params, in, kPosition, 1), prs::num(params, in, kPosition, 2)};
  const double r = std::max(8.0, prs::num(params, in, kSize) / 2);
  const float box[4] = {0.4F, 0.8F, 1, 0.7F};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): the SDK's rgba
  PrCamera cam{};
  if (overlay_camera(in, cam)) {
    double cx = 0, cy = 0;
    if (!project(cam, pos, cx, cy)) return PR_ERR_NONE;  // behind the eye: nothing to grab
    if (PrErr e = in->host->overlay_set_space(in->host_ref, PR_OVERLAY_SPACE_COMP); e != PR_ERR_NONE) return e;
    // A square of half-size r in the camera's view plane through the model (its right / down axes).
    const V3 right{cam.world[0], cam.world[1], cam.world[2]};
    const V3 down{cam.world[4], cam.world[5], cam.world[6]};
    std::array<double, 10> xy{};
    const std::array<std::array<double, 2>, 5> corners{{{-1, -1}, {1, -1}, {1, 1}, {-1, 1}, {-1, -1}}};
    for (std::size_t k = 0; k < corners.size(); ++k) {
      const V3 q{pos[0] + r * (corners.at(k)[0] * right[0] + corners.at(k)[1] * down[0]),
                 pos[1] + r * (corners.at(k)[0] * right[1] + corners.at(k)[1] * down[1]),
                 pos[2] + r * (corners.at(k)[0] * right[2] + corners.at(k)[1] * down[2])};
      if (!project(cam, q, xy.at(2 * k), xy.at(2 * k + 1))) return in->host->overlay_handle(in->host_ref, kPositionHandle, cx, cy, PR_OVERLAY_HANDLE_CROSSHAIR);
    }
    if (PrErr e = in->host->overlay_path(in->host_ref, xy.data(), 5, 1, box); e != PR_ERR_NONE) return e;
    return in->host->overlay_handle(in->host_ref, kPositionHandle, cx, cy, PR_OVERLAY_HANDLE_CROSSHAIR);
  }
  const double x = pos[0];
  const double y = pos[1];
  const std::array<double, 10> xy{x - r, y - r, x + r, y - r, x + r, y + r, x - r, y + r, x - r, y - r};
  if (PrErr e = in->host->overlay_path(in->host_ref, xy.data(), 5, 1, box); e != PR_ERR_NONE) return e;
  return in->host->overlay_handle(in->host_ref, kPositionHandle, x, y, PR_OVERLAY_HANDLE_CROSSHAIR);
}

/// OVERLAY_DRAG. A comp-space handle (SDK 1.2): the model moves in the camera's view plane at its
/// own depth — the point at the model's camera-space z that projects to the pointer. A layer-px
/// handle (an older host): Position's x / y follow the pointer; z stays.
PrErr overlay_drag(const PrInData* in, PrParamDef* const* params, const PrOverlayDragExtra* drag) {
  if (drag == nullptr || drag->handle_id != kPositionHandle) return PR_ERR_NONE;
  const uint32_t i = index_of(in, params, kPosition);
  if (i == 0) return PR_ERR_NONE;
  const V3 pos{prs::num(params, in, kPosition, 0), prs::num(params, in, kPosition, 1), prs::num(params, in, kPosition, 2)};
  const bool comp = drag->struct_size >= offsetof(PrOverlayDragExtra, space) + sizeof(drag->space) && drag->space == PR_OVERLAY_SPACE_COMP;
  PrCamera cam{};
  if (comp && overlay_camera(in, cam)) {
    // Camera space c = (a, b, z, 1) with z the model's depth; P · c lands on the pointer:
    //   (P·c).x − px (P·c).w = 0, (P·c).y − py (P·c).w = 0 — two linear equations in a, b.
    const M4 P = from(cam.projection);
    const M4 view = from(cam.view);
    const double z = apply(view, pos)[2];
    const double px = drag->x;
    const double py = drag->y;
    const double a00 = P[0] - px * P[3], a01 = P[4] - px * P[7];
    const double a10 = P[1] - py * P[3], a11 = P[5] - py * P[7];
    const double b0 = -(P[8] * z + P[12]) + px * (P[11] * z + P[15]);
    const double b1 = -(P[9] * z + P[13]) + py * (P[11] * z + P[15]);
    const double det = a00 * a11 - a01 * a10;
    if (std::abs(det) < 1e-12) return PR_ERR_NONE;
    const double ca = (b0 * a11 - a01 * b1) / det;
    const double cb = (a00 * b1 - b0 * a10) / det;
    const M4 world = from(cam.world);
    const V3 local{ca, cb, z};
    const auto w = apply(world, local);
    const std::array<double, 3> v{w[0], w[1], w[2]};
    if (!std::isfinite(v[0]) || !std::isfinite(v[1]) || !std::isfinite(v[2])) return PR_ERR_NONE;
    return in->host->set_param_value(in->host_ref, i, v.data(), 3);
  }
  const std::array<double, 3> v{drag->x, drag->y, pos[2]};
  return in->host->set_param_value(in->host_ref, i, v.data(), 3);
}

/// SDK 1.2 LIST_ASSET_FILES (Collect Files): a .gltf's external buffers and images, so a collected
/// project carries them beside the model.
PrErr list_asset_files(const PrInData* in, PrOutData* out, PrParamDef* const* params, const PrListAssetFilesExtra* x) {
  if (const PrErr f = prs::inject(prs::by_id(params, in, prs::kFaultParamId), out); f != PR_ERR_NONE) return f;
  if (x == nullptr || x->asset_path == nullptr || x->add_file == nullptr || x->param_index != index_of(in, params, kModel)) return PR_ERR_NONE;
  const std::string utf8(x->asset_path);
  std::ifstream file(std::filesystem::path(std::u8string(utf8.begin(), utf8.end())), std::ios::binary);
  if (!file) return PR_ERR_NONE;  // the host reports a missing asset itself
  const std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
  std::vector<std::string> uris;
  std::string why;
  if (!gltf_lite::external_uris(bytes, uris, why)) return PR_ERR_NONE;  // not a model: nothing beside it
  for (const std::string& u : uris) (void)x->add_file(x->refcon, u.c_str());
  return PR_ERR_NONE;
}

PrErr PR_CALL model3d_main(PrCmd cmd, const PrInData* in, PrOutData* out, PrParamDef* const* params, PrWorld* /*output*/,
                           void* extra) {
  switch (cmd) {
    case PR_CMD_ABOUT:
      prs::message(out, "Model 3D 1.0 — Premation SDK sample (an Element 3D class effect: glTF models through the comp camera and "
                        "lights, motion blur, scene-depth occlusion).");
      return PR_ERR_NONE;
    case PR_CMD_GLOBAL_SETUP:
      out->my_version = PR_VERSION(1, 0, 0);
      out->out_flags = PR_OUT_FLAG_DEEP_COLOR_AWARE | PR_OUT_FLAG_FLOAT_COLOR_AWARE | PR_OUT_FLAG_SMART_RENDER | PR_OUT_FLAG_GENERATOR |
                       PR_OUT_FLAG_USES_CAMERA | PR_OUT_FLAG_USES_LIGHTS | PR_OUT_FLAG_USES_LAYER_TRANSFORMS | PR_OUT_FLAG_SAMPLES_TIME |
                       PR_OUT_FLAG_USES_SHUTTER | PR_OUT_FLAG_COMP_SPACE | PR_OUT_FLAG_USES_SCENE_DEPTH | PR_OUT_FLAG_CUSTOM_OVERLAY |
                       PR_OUT_FLAG_SCENE_CONTRIBUTE  // D4: Render Mode ▸ In the Comp's 3D Scene
#if defined(PRS_SAMPLE_GPU)
                       | PR_OUT_FLAG_GPU_RENDER
#endif
          ;
      return PR_ERR_NONE;
    case PR_CMD_PARAMS_SETUP: return params_setup(in);
    case PR_CMD_SMART_PRE_RENDER: return pre_render(in, params);
    case PR_CMD_SCENE_CONTRIBUTE: return contribute(in, params);
    case PR_CMD_SMART_RENDER: return cpu_render(in, out, params);
#if defined(PRS_SAMPLE_GPU)
    case PR_CMD_GPU_DEVICE_SETUP: return gpu_setup(in, static_cast<PrGpuDeviceSetupExtra*>(extra));
    case PR_CMD_GPU_DEVICE_SETDOWN: return gpu_setdown(in, static_cast<PrGpuDeviceSetupExtra*>(extra));
    case PR_CMD_SMART_RENDER_GPU: return gpu_render(in, out, params, static_cast<PrSmartRenderGpuExtra*>(extra));
#endif
    case PR_CMD_DRAW_OVERLAY: return draw_overlay(in, params);
    case PR_CMD_OVERLAY_DRAG: return overlay_drag(in, params, static_cast<const PrOverlayDragExtra*>(extra));
    case PR_CMD_LIST_ASSET_FILES: return list_asset_files(in, out, params, static_cast<const PrListAssetFilesExtra*>(extra));
    default: return PR_ERR_NONE;
  }
}

const PrEffectEntry kEffects[] = {{"com.premation.samples.model3d", &model3d_main}};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): C ABI table
PrPluginInfo make_info() {
  PrPluginInfo i{};  // no commands, importers or output modules
  i.struct_size = sizeof(PrPluginInfo);
  i.sdk_version = PR_SDK_VERSION;
  i.plugin_id = "com.premation.samples.model3d";
  i.effect_count = 1;
  i.effects = kEffects;
  return i;
}
const PrPluginInfo kInfo = make_info();

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
