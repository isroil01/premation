// The text painter: src/core/rendering/raster/textPaint.ts paintTextInBox and
// the src/core/text layout it drives (textLayout, textExtras, bidi, vertical,
// text-on-path, optical kerning, animators' per-glyph transforms), ported onto
// the C++ Canvas2D.
#pragma once

#include <string>
#include <vector>

#include "canvas.hpp"
#include "json.hpp"

namespace premation::raster {

/// Paint a TextSpec into `ctx` in its UNPADDED box (0,0)–(width,height); the
/// caller has applied the supersample and padding transform.
void paint_text_in_box(Canvas2D& ctx, const json::Value& spec, std::vector<std::string>& unsupported);

}  // namespace premation::raster
