// SVG document → editable parts (the static half of src/utils/svgParser.ts
// `parseSvgToShapes`) for convertLayer {shapesFromVector, editableText}:
// every painted <path> / <rect> / <circle> / <ellipse> / <line> / <polyline>
// / <polygon> as Bézier runs in the document's VIEWPORT px (transforms, nested
// <svg> viewports and <use> clones applied), its fill (colour, or a linear /
// radial gradient as FillPaint), stroke and opacity; <text> as text parts;
// <image> as image parts. Built on the engine's own SVG parser and cascade
// (raster/svg_doc.hpp — the renderer's), so what converts is what draws.
//
// Not carried (named in SvgShapes::notCarried, in the user's words): CSS /
// SMIL animation (the editor's converter keys it), clip paths and masks,
// filters, markers, patterns, dashes on scaled strokes stay as authored.
#pragma once

#include <optional>
#include <string>
#include <string_view>

#include "convert_geometry.hpp"

namespace premation::scene {

/// nullopt + `why` when the markup does not parse or has no <svg> root.
/// `fillOverride` = the SVG layer's recolour (`fill: X !important` on shapes and text).
[[nodiscard]] std::optional<doc::SvgShapes> svg_document_shapes(std::string_view markup,
                                                                const std::optional<std::string>& fillOverride,
                                                                std::string& why);

}  // namespace premation::scene
