// layerStyles.ts `styledSurfaceFill(styles, baseFill)` (D2w 3D leftovers): the
// colour an extrusion's walls take under a Colour / Gradient Overlay style —
// the overlay repaints the front face, so the walls follow it instead of the
// raw fill (one object, one colour). `#rrggbb` out, fill.ts parseHex in.
// Pinned by tests/data/styled_surface_parity.json.
#pragma once

#include <string>
#include <string_view>

#include "json.hpp"

namespace premation::scene {

[[nodiscard]] std::string styled_surface_fill(const js::Json& styles, std::string_view baseFill);

}  // namespace premation::scene
