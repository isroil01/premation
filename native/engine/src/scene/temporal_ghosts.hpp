// Temporal ghosts for the scene builder (D2w time / comp): Echo and Wide Time
// draw the layer at OTHER points in time as ordinary layers.
//
//   src/core/effects/temporalGhosts.ts   readGhostSpec (which times, how bright)
//   src/core/effects/echo.ts             readEchoConfig
//   buildSnapshot.ts                     the ghost emission (x / y / rotation
//                                        resampled at t + dt, flags stripped)
#pragma once

#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "scene_types.hpp"

namespace premation::scene {

struct GhostStep {
  double dt = 0;       ///< seconds from now (negative = the past)
  double opacity = 0;  ///< multiplier on the layer's own opacity
};

struct GhostSpec {
  std::vector<GhostStep> steps;  ///< farthest first
  std::string blend = "normal";  ///< EchoOperator as a blend mode
  bool inFront = false;          ///< Composite In Front: drawn after the layer
};

/// `readGhostSpec(effects, fps)`: Echo wins over Wide Time; null = no ghosts.
[[nodiscard]] std::optional<GhostSpec> read_ghost_spec(const std::vector<Json>& effects, double fps);

using GhostSampler = std::function<std::optional<double>(std::string_view, double)>;
/// Places a 3D ghost at comp time `ti` from its x / y / rotation offsets.
using GhostPlace3D = std::function<void(RLayer&, double ti, double dx, double dy, double drot)>;

/// The ghost copies of `layer` (buildSnapshot's emission): each resampled
/// through `sample(prop, compTime)` (undefined = the live value). `localX/Y/Rot`
/// are the layer's live local values, `px/py/rot` its placed ones. A 3D layer
/// passes `place3d`, which rebuilds the ghost's matrix instead of moving x / y.
[[nodiscard]] std::vector<RLayer> ghost_layers(const RLayer& layer, const GhostSpec& spec, double t, const GhostSampler& sample,
                                               double localX, double localY, double localRot, double px, double py,
                                               double rot, const GhostPlace3D& place3d);

}  // namespace premation::scene
