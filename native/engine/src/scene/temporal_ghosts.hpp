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

/// The 2D ghost copies of `layer` (buildSnapshot's emission, 2D branch): each
/// resampled through `sample(prop, compTime)` (undefined = the live value).
/// `localX/Y/Rot` are the layer's live local values, `px/py/rot` its placed ones.
[[nodiscard]] std::vector<RLayer> ghost_layers(const RLayer& layer, const GhostSpec& spec, double t,
                                               const std::function<std::optional<double>(std::string_view, double)>& sample,
                                               double localX, double localY, double localRot, double px, double py,
                                               double rot);

}  // namespace premation::scene
