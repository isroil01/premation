// B4 round 2 (ENGINE_API.md §15.12): `getTextLayout` and readGeometry's text
// box over the scene port's TextMeasurer — what the Point ⇄ Paragraph
// conversions, Box Auto-Size, the Text Box card and getLayerBounds measure.
// The TypeScript twins: src/core/engine/textLayoutQuery.ts and the text branch
// of src/core/workspace/geometry.ts `readGeometry`.
//
// Inside the port: horizontal point and paragraph text (greedy word wrap,
// indents, paragraph spacing, anchored auto-height boxes). Outside it (the
// answer is `unsupported`, naming why): vertical type, Fit Text to Box, runs
// that change a line's size or leading, variable axes, Capitalize case, CJK
// line breaking — the same limits the scene port reports as unported.
#pragma once

#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "engine_api.hpp"
#include "session_hooks.hpp"
#include "text_measure.hpp"

namespace premation::scene {

/// getTextLayout for the text node `n`: its stored style with `overrides`
/// winning. Throws doc::EngineFail (invalidArgument: no content; unsupported:
/// outside the port).
[[nodiscard]] api::TextLayout text_layout_of(TextMeasurer& m, const doc::Node& n, const api::TextLayoutOverrides* overrides);

/// readGeometry's measured text box: a FIXED paragraph box as authored, else
/// the font-metric selection box (paragraph text keeps its authored width; an
/// anchored auto-height box moves by its line-block offset). `overrides` are
/// the evaluated values at the time (fontSize, boxWidth, …). Text on a path
/// measures as the plain selection box (its bent extent is not in the port).
/// nullopt when the style is outside the port or the node has no text.
[[nodiscard]] std::optional<TextGeometry> text_geometry_of(TextMeasurer& m, const doc::Node& n,
                                                          const std::vector<std::pair<std::string, double>>& overrides);

}  // namespace premation::scene
