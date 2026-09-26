// Per-character 3D text (D2w 3D leftovers) — src/core/text/perChar3D.ts
// `layoutPerChar3D` + `createGlyphMeasure`, and buildSnapshot's `glyphExtras`:
// with Enable Per-character 3D each non-blank glyph of a 3D text layer becomes
// its own plane, placed relative to the layer centre from the SAME layout the
// rasterizer runs (raster::layout_text / layout_vertical_text), carrying the
// text animator's z / rotationX / rotationY / anchor. Scene3D multiplies each
// placement into the layer's world matrix and emits a one-character text layer
// per glyph (threed_port.cpp), plus the glyph's own body when extruded.
//
// Glyph advances come from a Canvas2D measureText at the font string
// createGlyphMeasure builds; with no canvas the layout is refused (the
// TypeScript's headless ratio estimate only ever governs its tests).
#pragma once

#include <optional>
#include <string>
#include <vector>

#include "canvas.hpp"
#include "scene_types.hpp"

namespace premation::scene {

/// perChar3D.ts GlyphPlacement.
struct GlyphPlacement {
  int index = 0;
  std::string ch;
  double offsetX = 0, offsetY = 0, offsetZ = 0;
  double width = 0, height = 0;
  double rotation = 0, rotationX = 0, rotationY = 0;
  double scale = 1, opacity = 1;
  std::optional<std::string> fill;
  double anchorX = 0, anchorY = 0, anchorZ = 0;
};

/// MAX_PER_CHAR_GLYPHS: above this the layer stays one plane.
inline constexpr std::size_t kMaxPerCharGlyphs = 200;

/// `layoutPerChar3D({...})` as buildSnapshot calls it for `layer` (its text,
/// style, textExtras, runs and animator glyphs) in a box `boxWidth` wide.
/// Empty = not per-character (no text, all blank, or over the cap).
[[nodiscard]] std::vector<GlyphPlacement> layout_per_char_3d(const RLayer& layer, double boxWidth, const raster::CanvasOptions& canvas);

/// buildSnapshot `glyphExtras`: the layer's textExtras without the block-level
/// fields a glyph plane must not re-apply (boxOffsetY, orientation,
/// verticalRomanAlignment, direction); undefined when nothing is left.
[[nodiscard]] Json glyph_extras_of(const Json& textExtras);

}  // namespace premation::scene
