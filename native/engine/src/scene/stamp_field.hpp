// E4: Plexus and Write-on's brush form as a data texture the GPU stamps
// (shaders/wgsl/stamp-field.wgsl), instead of a full-frame CPU bake.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "scene_types.hpp"

namespace premation::scene {

struct StampTexture {
  std::string key;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::vector<std::uint8_t> rgba;
  std::uint32_t instances = 0;  ///< triangles + lines + points, in that draw order
  double over = 0;              ///< how the stamps land on the layer (stamp-field.wgsl)
};

/// The stamp texture for one effect, or nullopt when this effect is not a
/// GPU stamp (or it draws nothing).
[[nodiscard]] std::optional<StampTexture> stamp_for_effect(const RLayer& layer, const Json& effect);

/// Every stamp texture a GPU-routed layer needs.
[[nodiscard]] std::vector<StampTexture> stamp_textures(const RLayer& layer);

}  // namespace premation::scene
