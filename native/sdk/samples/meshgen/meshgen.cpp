// Sample (SDK 1.4, D): Mesh Cube — geometry a plugin adds to the comp's 3D SCENE. On a 3D layer,
// PR_CMD_SCENE_CONTRIBUTE hands the host a cube (scene_add_mesh) and a point light above it
// (scene_add_light), in the layer's own pixels. The host draws them in its 3D pass like any 3D
// layer: depth-sorted and intersecting with the comp's other 3D layers, lit by the comp's lights,
// casting and receiving shadows, in the camera's depth of field.
//
// The effect's own 2D output is empty: the layer shows only what it added to the scene.
#include <premation_sdk/premation_sdk.h>

#include <array>
#include <cmath>

#include "sample_util.hpp"

namespace {

enum : uint32_t { kSize = 1, kColor = 2, kMetal = 3, kRough = 4, kLight = 5 };

bool has_scene(const PrInData* in) { return in->host->struct_size >= offsetof(PrHostSuite, scene_add_light) + sizeof(void*); }

PrErr contribute(const PrInData* in, PrParamDef* const* params) {
  if (!has_scene(in)) return PR_ERR_BAD_VERSION;
  const auto s = static_cast<float>(prs::num(params, in, kSize) / 2);
  const auto cx = static_cast<float>(in->width) / 2;
  const auto cy = static_cast<float>(in->height) / 2;
  // 6 faces × 4 corners, each face with its own normal (flat shading).
  struct Face {
    std::array<float, 3> n, u, v;
  };
  constexpr std::array<Face, 6> kFaces{{{{0, 0, -1}, {1, 0, 0}, {0, 1, 0}},
                                        {{0, 0, 1}, {-1, 0, 0}, {0, 1, 0}},
                                        {{1, 0, 0}, {0, 0, 1}, {0, 1, 0}},
                                        {{-1, 0, 0}, {0, 0, -1}, {0, 1, 0}},
                                        {{0, -1, 0}, {1, 0, 0}, {0, 0, 1}},
                                        {{0, 1, 0}, {1, 0, 0}, {0, 0, -1}}}};
  std::array<float, 72> pos{};
  std::array<float, 72> nrm{};
  std::array<float, 48> uv{};
  std::array<uint32_t, 36> idx{};
  constexpr std::array<std::array<float, 2>, 4> kCorners{{{-1, -1}, {1, -1}, {1, 1}, {-1, 1}}};
  for (std::size_t f = 0; f < kFaces.size(); ++f) {
    const Face& face = kFaces[f];
    for (std::size_t c = 0; c < 4; ++c) {
      const std::size_t v = (f * 4) + c;
      for (std::size_t k = 0; k < 3; ++k) {
        pos[(v * 3) + k] = (face.n[k] + (face.u[k] * kCorners[c][0]) + (face.v[k] * kCorners[c][1])) * s;
        nrm[(v * 3) + k] = face.n[k];
      }
      pos[v * 3] += cx;  // around the layer's centre, in layer px
      pos[(v * 3) + 1] += cy;
      uv[v * 2] = (kCorners[c][0] + 1) / 2;
      uv[(v * 2) + 1] = (kCorners[c][1] + 1) / 2;
    }
    const auto b = static_cast<uint32_t>(f * 4);
    const std::array<uint32_t, 6> tri{b, b + 1, b + 2, b, b + 2, b + 3};
    for (std::size_t k = 0; k < 6; ++k) idx[(f * 6) + k] = tri[k];
  }
  PrSceneMesh mesh{};
  mesh.struct_size = sizeof(PrSceneMesh);
  mesh.positions = pos.data();
  mesh.normals = nrm.data();
  mesh.uvs = uv.data();
  mesh.vertex_count = 24;
  mesh.indices = idx.data();
  mesh.index_count = 36;
  for (int i = 0; i < 16; ++i) mesh.transform[i] = i % 5 == 0 ? 1.0 : 0.0;  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
  mesh.material.struct_size = sizeof(PrSceneMaterial);
  for (uint32_t k = 0; k < 4; ++k) mesh.material.base_color[k] = prs::num(params, in, kColor, k);  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
  mesh.material.metallic = prs::num(params, in, kMetal) / 100;
  mesh.material.roughness = prs::num(params, in, kRough) / 100;
  mesh.material.casts_shadows = 1;
  mesh.material.accepts_shadows = 1;
  if (PrErr e = in->host->scene_add_mesh(in->host_ref, &mesh); e != PR_ERR_NONE) return e;
  const double intensity = prs::num(params, in, kLight) / 100;
  if (intensity <= 0) return PR_ERR_NONE;
  PrLight light{};
  light.struct_size = sizeof(PrLight);
  light.type = PR_LIGHT_POINT;
  light.color[0] = light.color[1] = light.color[2] = 1;
  light.intensity = intensity;
  light.position[0] = cx;
  light.position[1] = cy - (4 * s);  // above the cube (y down)
  light.position[2] = -4 * s;        // and toward the camera
  light.casts_shadows = 1;
  light.shadow_darkness = 0.6;
  return in->host->scene_add_light(in->host_ref, &light);
}

PrErr PR_CALL meshgen_main(PrCmd cmd, const PrInData* in, PrOutData* out, PrParamDef* const* params, PrWorld* /*output*/, void* /*extra*/) {
  switch (cmd) {
    case PR_CMD_ABOUT: prs::message(out, "Mesh Cube 1.0 — Premation SDK sample of geometry in the 3D scene (SDK 1.4, D)."); return PR_ERR_NONE;
    case PR_CMD_GLOBAL_SETUP:
      out->my_version = PR_VERSION(1, 0, 0);
      out->out_flags = PR_OUT_FLAG_FLOAT_COLOR_AWARE | PR_OUT_FLAG_SMART_RENDER | PR_OUT_FLAG_GENERATOR | PR_OUT_FLAG_THREADED_RENDER |
                       PR_OUT_FLAG_SCENE_CONTRIBUTE;
      return PR_ERR_NONE;
    case PR_CMD_PARAMS_SETUP:
      if (PrErr e = prs::add_float(in, kSize, "Size", 200, 1, 10000, 10, 1000, 0); e != PR_ERR_NONE) return e;
      if (PrErr e = prs::add_simple(in, PR_PARAM_COLOR, kColor, "Color", {0.85, 0.55, 0.2, 1.0}); e != PR_ERR_NONE) return e;
      if (PrErr e = prs::add_float(in, kMetal, "Metal", 30, 0, 100, 0, 100, 0); e != PR_ERR_NONE) return e;
      if (PrErr e = prs::add_float(in, kRough, "Roughness", 40, 0, 100, 0, 100, 0); e != PR_ERR_NONE) return e;
      return prs::add_float(in, kLight, "Light", 80, 0, 400, 0, 200, 0);
    case PR_CMD_SCENE_CONTRIBUTE: return contribute(in, params);
    case PR_CMD_SMART_PRE_RENDER: return PR_ERR_NONE;
    case PR_CMD_SMART_RENDER: {
      PrWorld* dst = nullptr;
      if (PrErr e = in->host->checkout_output(in->host_ref, &dst); e != PR_ERR_NONE) return e;
      if (dst == nullptr) return PR_ERR_NONE;
      auto row = [&](int32_t y) {
        for (int32_t x = 0; x < dst->width; ++x) prs::write(*dst, x, y, prs::Px{});
      };
      return prs::for_rows(in, dst->height, row);
    }
    default: return PR_ERR_NONE;
  }
}

const PrEffectEntry kEffects[] = {{"com.premation.samples.meshgen", &meshgen_main}};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): C ABI table
const PrPluginInfo kInfo = {sizeof(PrPluginInfo), PR_SDK_VERSION, "com.premation.samples.meshgen", 1, kEffects, 0, nullptr, 0, nullptr, 0, nullptr};

}  // namespace

extern "C" PR_EXPORT const PrPluginInfo* PR_CALL PremationPluginInfo(void) { return &kInfo; }
