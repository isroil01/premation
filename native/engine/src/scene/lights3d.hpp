// Light layers and per-quad lighting (D2w 3D), ported operation for operation:
//
//   LightProps, read_node_light, light_falloff_at, light_attenuation_at,
//   light_reach                                   src/core/scene/light.ts
//   SceneLight, light_aim_3d, aim_to_comp_angle_deg, plane_normal_of,
//   shade_layer, to_shader_lights                 src/core/scene/lightShading.ts
//
// Pure (no document walk, no GPU): pinned by the cross-engine fixture
// tests/data/threed_parity.json.
#pragma once

#include <array>
#include <optional>
#include <string>
#include <vector>

#include "engine_api.hpp"
#include "json.hpp"
#include "model.hpp"

namespace premation::scene {

/// light.ts `Light`.
struct LightProps {
  std::string type = "point";  ///< point | ambient | spot | parallel | environment
  std::string color = "#fff3c0";
  double intensity = 100;
  double radius = 500;
  double angle = 0;
  double cone = 45;
  double coneFeather = 50;
  std::string falloff = "none";  ///< none | legacy | smooth | inverse-square
  double falloffDistance = 500;
  bool shadows = false;
  bool glow = false;
  double shadowDarkness = 100;
  double shadowDiffusion = 0;
  bool shadowMap = false;
  double shadowMapSize = 1024;
  double shadowBias = 3;
  double shadowSoftness = 1;
  std::optional<std::array<double, 3>> poi;
  js::Json envPreset;  ///< EnvironmentSky (a preset id or `asset:<id>`)
  double envRotation = 0;
  double envReflections = 100;
};

/// light.ts `readNodeLight(node)`.
[[nodiscard]] LightProps read_node_light(const doc::Node& n);

/// lightShading.ts `SceneLight`: the optional fields are the TypeScript's
/// optional keys (the form rig and the environment rig leave some unset).
struct SceneLight {
  std::string type = "point";
  std::string color = "#ffffff";
  double intensity = 100;
  double radius = 500;
  double angle = 0;
  double cone = 45;
  bool shadows = false;
  std::optional<double> coneFeather;
  std::optional<std::string> falloff;
  std::optional<double> falloffDistance;
  std::optional<std::array<double, 3>> poi;
  std::optional<bool> shadowMap;
  std::optional<double> shadowMapSize;
  std::optional<double> shadowBias;
  std::optional<double> shadowSoftness;
  std::optional<double> shadowDarkness;
  double x = 0, y = 0, z = 0;
};

/// `{...lt}` of a light layer as a SceneLight (every optional key present).
[[nodiscard]] SceneLight scene_light_of(const LightProps& lt);

/// light.ts `lightFalloffAt(distance, light)`.
[[nodiscard]] double light_falloff_at(double distance, const std::optional<std::string>& falloff, double radius,
                                      const std::optional<double>& falloffDistance);
/// light.ts `lightAttenuationAt(distance, light)`.
[[nodiscard]] double light_attenuation_at(double distance, const std::optional<std::string>& falloff, double radius,
                                          const std::optional<double>& falloffDistance);
/// light.ts `lightReach(light)`.
[[nodiscard]] double light_reach(const std::optional<std::string>& falloff, double radius,
                                 const std::optional<double>& falloffDistance);

/// lightShading.ts `lightAim3D(light)`.
[[nodiscard]] std::optional<std::array<double, 3>> light_aim_3d(const SceneLight& l);
/// lightShading.ts `aimToCompAngleDeg(aim)`.
[[nodiscard]] std::optional<double> aim_to_comp_angle_deg(const std::array<double, 3>& aim);
/// lightShading.ts `planeNormalOf(world)`.
[[nodiscard]] std::array<double, 3> plane_normal_of(const std::array<double, 16>& world);

/// lightShading.ts `shadeLayer(normal, pos, lights, {ambient, diffuse}, oneSided)`:
/// null with no lights.
[[nodiscard]] std::optional<std::array<double, 3>> shade_layer(const std::array<double, 3>& normal,
                                                               const std::array<double, 3>& pos,
                                                               const std::vector<SceneLight>& lights,
                                                               std::optional<double> ambient,
                                                               std::optional<double> diffuse, bool oneSided = false);

/// lightShading.ts `toShaderLights(lights)` in the FrameScene's wire form.
[[nodiscard]] std::vector<api::RenderLight3D> to_shader_lights(const std::vector<SceneLight>& lights);

}  // namespace premation::scene
