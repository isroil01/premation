// The environment light's irradiance half (D2w 3D) — src/core/scene/environmentLight.ts
// `presetPixels`, `shProject`, `shIrradiance`, `environmentRig`: a procedural sky
// projected onto band-2 spherical harmonics (Float32Array storage, so every
// accumulate rounds to float32 as the TypeScript's typed array stores it) and
// expanded into one ambient floor + up to six axis parallels that ride the
// ordinary light array. Pinned by tests/data/threed_parity.json.
//
// Not here yet: `environmentSpecularMap` (the prefiltered reflection atlas) and
// image (`asset:`) skies.
#pragma once

#include <array>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace premation::scene {

struct EnvRigLight {
  bool ambient = true;  ///< kind: 'ambient' | 'parallel'
  std::string color;
  double intensity = 0;
  std::array<double, 3> from{};  ///< parallel only
};

/// environmentLight.ts `presetSh(id)` (27 float32 coefficients); `id` is a preset id.
[[nodiscard]] std::array<float, 27> preset_sh(std::string_view id);

/// `environmentRig(sh, intensityPct, rotationDeg)`.
[[nodiscard]] std::vector<EnvRigLight> environment_rig(const std::array<float, 27>& sh, double intensityPct,
                                                       double rotationDeg);

/// `environmentRigFor(sky, intensityPct, rotationDeg)` for a preset sky (an
/// unknown preset falls back to 'studio'); nullopt for an `asset:` sky.
[[nodiscard]] std::optional<std::vector<EnvRigLight>> environment_rig_for(std::string_view sky, double intensityPct,
                                                                          double rotationDeg);

}  // namespace premation::scene
