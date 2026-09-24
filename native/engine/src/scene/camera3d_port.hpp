// The pure halves of the snapshot's 3D block (D2w 3D, docs/NATIVE_CORE_PLAN.md):
// ported operation for operation from their TypeScript twins, float64 like the
// TypeScript, no document walk and no GPU — so the cross-engine fixture
// (tests/data/threed_parity.json, src/core/scene/threeDCrossEngine.test.ts)
// pins them in ctest.
//
//   DofConfig, dof_blur_px, dof_iris_params, read_node_dof   src/core/scene/camera3d.ts
//   Material, read_node_material                              src/core/scene/material.ts
//   layer_corner_depths, plan_dof_coc_corners                  src/core/rendering/dofStrips.ts
//   dof_effect, planar_dof_effect                              buildSnapshot.ts dofEffectOf / the planar branch
#pragma once

#include <array>
#include <functional>
#include <optional>
#include <string>
#include <string_view>

#include "json.hpp"
#include "model.hpp"
#include "transform.hpp"

namespace premation::scene {

/// camera3d.ts DofConfig (optional fields absent = the TypeScript's missing key).
struct DofConfig {
  double strength = 0;
  double focus = 0;
  double aperture = 0;
  std::optional<double> focalLength;
  std::optional<double> fStop;
  std::optional<double> irisBlades;
  std::optional<double> irisRoundness;
  std::optional<double> highlightGain;
  std::optional<double> irisRotation;
  std::optional<double> irisAspect;
  std::optional<double> highlightThreshold;
  std::optional<double> highlightSaturation;
  std::optional<double> diffractionFringe;
};

/// camera3d.ts `dofBlurPx(depth, dof)` — the legacy ramp, or the thin-lens CoC when fStop is present.
[[nodiscard]] double dof_blur_px(double depth, const DofConfig& dof);

/// camera3d.ts `dofIrisParams(dof)`.
struct IrisParams {
  std::optional<double> blades, roundness, highlightGain, rotationDeg, aspect, highlightThreshold, highlightSaturation,
      fringe;
};
[[nodiscard]] IrisParams dof_iris_params(const DofConfig& dof);

/// `(nodeId, prop) => number | undefined` — the camera readers' animated sampler.
using PropSample = std::function<std::optional<double>(std::string_view prop)>;

/// camera3d.ts `readNodeDof(node, w, h, sample)`: null when the camera has no blur level.
[[nodiscard]] std::optional<DofConfig> read_node_dof(const doc::Node& camera, double width, double height,
                                                      const PropSample& sample);

/// buildSnapshot `dofEffectOf(depth)`: the per-layer `{id:'dof', type:'blur'}` effect, or
/// undefined below 0.3 px.
[[nodiscard]] js::Json dof_effect(double depth, const DofConfig& dof);

/// dofStrips.ts `layerCornerDepths(world3d, w, h, project)` (null when a corner is clipped).
using ProjectFn = std::function<motion::xf::Projected(motion::xf::Vec3)>;
[[nodiscard]] std::optional<std::array<double, 4>> layer_corner_depths(const motion::xf::Mat4& world3d, double width,
                                                                       double height, const ProjectFn& project);

/// dofStrips.ts `planDofCocCorners(cornerDepths, dof)`.
struct PlanarCoc {
  std::array<double, 4> corners{};
  double maxPx = 0;
};
[[nodiscard]] std::optional<PlanarCoc> plan_dof_coc_corners(const std::array<double, 4>& cornerDepths,
                                                            const DofConfig& dof);
/// The planar branch's effect (`amount: maxPx, coc0..3, iris…`).
[[nodiscard]] js::Json planar_dof_effect(const PlanarCoc& planar, const DofConfig& dof);

/// material.ts MaterialOptions (the fields the snapshot reads).
struct Material {
  bool castsShadows = true;
  std::string castsShadowsMode = "on";
  std::string acceptsShadowsMode = "on";
  bool shadowOnly = false;
  double lightTransmission = 0;
  double ambient = 100;
  double diffuse = 50;
  double metal = 0;
  bool acceptsLights = false;
  bool acceptsShadows = true;
  double specular = 0;
  double shininess = 32;
  std::string shading = "phong";
  double roughness = 50;
  double toonBands = 3;
  double displacement = 0;
  double displacementSubdivisions = 0;
  std::optional<std::string> heightMapAssetId, heightMapSrc;
  double reflectionIntensity = 100;
  double reflectionSharpness = 0;
  double reflectionRolloff = 0;
  double transparency = 0;
  double transparencyRolloff = 0;
  double ior = 1.52;
};

/// material.ts `readNodeMaterial(node, av)`: the Transform's stored props, the
/// MATERIAL_ANIMATABLE tracks in `animated` layered over them.
using AnimatedLookup = std::function<std::optional<double>(std::string_view prop)>;
[[nodiscard]] Material read_node_material(const doc::Node& n, const AnimatedLookup& animated = {});

/// `Number(x.toFixed(digits))`.
[[nodiscard]] double fixed_num(double x, int digits);

}  // namespace premation::scene
