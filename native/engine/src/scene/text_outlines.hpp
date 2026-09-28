// Font-exact text outlines (src/core/text/fontOutlines.ts `outlineRuns` and
// shapesFromText.ts `outlineTextNode`'s choice): a text layer's glyphs as the
// FONT's own Béziers — the shaped glyphs of each line placed the way the
// canvas painter draws them (centred lines on the `middle` baseline about the
// layer centre, letter spacing per gap, the run's variations and synthetic
// bold / oblique) — for convertLayer's Shapes / Masks from Text.
//
// The TS reads the installed face through the Local Font Access API and
// kerns by measuring prefixes on a canvas; the engine shapes the line with
// the FontSet the painter draws with (HarfBuzz pen positions = the canvas's
// kerned advances) and takes each glyph's path from Skia. A variable face is
// outlined at the instance the layer draws at the sampled time: its weight
// as `wght`, width / slant as `wdth` / `slnt`, every `fontAxes` tag with its
// keyed `text.axis.<tag>` value winning.
#pragma once

#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "extrude_mesh.hpp"
#include "json.hpp"
#include "text_measure.hpp"

namespace premation::raster {
class FontSet;
}

namespace premation::doc {
struct Node;
}

namespace premation::scene {

/// shapesFromText.ts `wantsPaintedLayout`: the style asks for what only the
/// painter lays out (case transform, small caps, super/sub, scales, baseline
/// shift, a stroke, paragraph / anchored boxes, non-centred multi-line
/// alignment) — the TRACE is faithful there, the font outlines are not.
[[nodiscard]] bool wants_painted_layout(const js::Json& paintSpec);

/// fontAxes.ts `fontVariationString(drawnVariationOf(node, style, t))`: the
/// CSS font-variation-settings the layer draws with; "" = none. `sampled` are
/// the node's evaluated values (weight / width / slant tracks, `text.axis.*`).
[[nodiscard]] std::string font_variations_of(const doc::Node& n, const MeasuredStyle& s,
                                             const std::vector<std::pair<std::string, double>>& sampled);

struct FontOutlines {
  std::vector<mesh::BezRun> runs;
  /// The block's box from the shaped lines (widest line × the line stack) —
  /// the layer box when the measurer has none for this style (variable axes).
  double width = 0;
  double height = 0;
};

/// fontOutlines.ts `outlineRuns`: every glyph contour of the style's lines in
/// LAYER space (centre origin, y down, absolute handles). nullopt when nothing
/// shaped has an outline (no covering face, blank text).
[[nodiscard]] std::optional<FontOutlines> font_outline_runs(const raster::FontSet& fonts, const MeasuredStyle& s,
                                                            const std::string& variations);

}  // namespace premation::scene
