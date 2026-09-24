// The environment light's irradiance half (D2w 3D) — src/core/scene/environmentLight.ts
// `presetPixels`, `shProject`, `shIrradiance`, `environmentRig`: a procedural sky
// projected onto band-2 spherical harmonics (Float32Array storage, so every
// accumulate rounds to float32 as the TypeScript's typed array stores it) and
// expanded into one ambient floor + up to six axis parallels that ride the
// ordinary light array. Pinned by tests/data/threed_parity.json.
//
// Also the reflection half: `environmentSpecularMap` (the prefiltered equirect
// atlas, 5 roughness levels, sqrt-encoded RGBA8). Not here: image (`asset:`) skies.
#pragma once

#include <array>
#include <cstdint>
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

/// environmentLight.ts `EnvSpecularMap`.
struct EnvSpecularMap {
  std::string id;
  std::uint32_t width = 0;
  std::uint32_t height = 0;  ///< per-level height × levels
  std::uint32_t levels = 0;
  double scale = 0;
  std::vector<std::uint8_t> data;
};

/// `environmentSpecularMap(sky)` for a preset sky (unknown → 'studio'); nullopt
/// for an asset: sky. Memoised per content id (the TypeScript's LRU of 8).
[[nodiscard]] std::optional<EnvSpecularMap> environment_specular_map(std::string_view sky);

}  // namespace premation::scene
