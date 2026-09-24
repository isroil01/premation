// A light's glow-wash texture (`light:<id>`): AppTextureProvider `rasterizeLight`
// ported call for call onto the C++ Canvas2D — a flat plate (ambient), the
// two-stop radial gradient (point / parallel), the gradient masked to its cone
// (spot), or a feathered disc (a landed beam's pool). 512², aim-agnostic: the
// renderable turns the quad.
#pragma once

#include "canvas.hpp"
#include "json.hpp"
#include "raster_source.hpp"
#include "scene_types.hpp"

namespace premation::scene {

[[nodiscard]] raster::RasterOutput draw_light_wash(const LightWash& light, const raster::CanvasOptions& opts);

/// The fields the texture depends on (the texture feed's spec + cache key).
[[nodiscard]] js::Json light_wash_spec(const LightWash& l);
[[nodiscard]] LightWash light_wash_of_spec(const js::Json& spec);

}  // namespace premation::scene
