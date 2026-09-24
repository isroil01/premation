// Text features the D2w "SVG + text + misc" family adds to the scene builder,
// each a port of its TypeScript twin (cited per function):
//
//   text on a path   textPath.ts resolveTextPath + resolveTextPathMask +
//                    flattenMaskPath → RenderLayer.textPath (buildSnapshot's
//                    "Text on a path" block); the E3 text painter lays glyphs on it
//   text animators   textAnimators.ts resolveAnimators + evaluateTextAnimators and
//                    textSelectors.ts (range / wiggly selectors) → RenderLayer.glyphs
#pragma once

#include <string>
#include <string_view>
#include <vector>

#include "model.hpp"
#include "readers.hpp"
#include "scene_types.hpp"

namespace premation::scene {

/// `flattenMaskPath(path, perSegment)` on a stored MaskPath: `{pts, closed}` as
/// a JSON object ({"pts": [{x, y}…], "closed": bool}).
[[nodiscard]] Json flatten_mask_path(const Json& maskPath, int perSegment = 24);

/// buildSnapshot's text-on-path block: the `layer.textPath` a text node gets at
/// this frame (undefined Json when it has none or the path resolves to nothing).
/// `a` = the node's sampled values (textPath.firstMargin, …).
[[nodiscard]] Json resolve_layer_text_path(const doc::Node& n, const Values& a);

/// The node's animators resolved for a frame (`resolveAnimators(node, a)`), as JSON
/// ResolvedAnimator objects. Empty when the node has none.
[[nodiscard]] std::vector<Json> resolve_text_animators(const doc::Node& n, const Values& a);
/// The same over a stored `__animators` array.
[[nodiscard]] std::vector<Json> resolve_text_animators_json(const Json& stored, const Values& a);

/// `evaluateTextAnimators(text, animators, time)` → GlyphTransform[] JSON. `why`
/// names what the port does not evaluate (expression selectors, Character
/// Value / Range, font axes); the result is then undefined and must not be used.
[[nodiscard]] Json evaluate_text_animators(std::string_view text, const std::vector<Json>& animators, double time,
                                         std::string* why);

/// textMoreOptions.ts withTextMoreOptions: Anchor Point Grouping, Grouping
/// Alignment (sampled), Fill & Stroke, Inter-Character Blending and the
/// OpenType switches folded into the layer's `textExtras` (absent at defaults).
void with_text_more_options(Json& extras, const doc::Node& n, const Values& a);

/// `applyGradientTracks(readTextStrokePaint(node), a, TEXT_STROKE_GRADIENT_TRACKS)`:
/// the text stroke's linear / radial gradient (undefined for a solid stroke).
[[nodiscard]] Json text_stroke_paint(const doc::Node& n, const Values& a);

/// vectorDraw.ts rasterPadding for a NON-shape layer: glyphSpread (animator
/// escape) and textPathSpread, clamped to MAX_GLYPH_PAD (baked-effect bleed is
/// the E4 chain's, and text paint layers are reported unported).
[[nodiscard]] double text_raster_padding(const RLayer& l);

}  // namespace premation::scene
