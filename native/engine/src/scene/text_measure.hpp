// Text measurement for the scene builder — src/core/text/measureText.ts
// `readMeasuredTextStyle` + `measureTextSize` (the RENDER box a text layer's
// texture is allocated at, which is also its layer width / height).
//
// The style reader is font-free (here); the measuring itself needs fonts and
// the Canvas2D `measureText` metrics, so it sits behind `TextMeasurer`,
// implemented over the E3 raster module (text_measure_ffi-free: raster only)
// in text_measure.cpp. A builder with no measurer reports text as unported.
#pragma once

#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "model.hpp"

namespace premation::raster {
struct CanvasOptions;
}

namespace premation::scene {

/// MeasuredTextStyle (measureText.ts) — the fields this port measures.
struct MeasuredStyle {
  std::string content;
  double fontSize = 48;
  std::string fontFamily = "Inter";
  std::string fontWeight = "600";
  std::string fontStyle = "normal";
  std::optional<double> fontWidth, fontSlant;
  double letterSpacing = 0;
  double lineHeight = 1.2;
  double paragraphSpacing = 0;
  std::optional<double> boxWidth;
  std::optional<std::string> textTransform, fontVariant, verticalAlign;
  std::optional<double> verticalScale, horizontalScale, baselineShift;
  std::optional<double> leftIndent, rightIndent, firstLineIndent, spaceBefore, spaceAfter;
  bool fauxBold = false;
  bool fauxItalic = false;
  bool vertical = false;
  bool verticalRomanAlignment = false;
  std::optional<int> tateChuYokoDigits;  ///< auto tate-chu-yoko (vertical only)
  bool opticalKerning = false;
  bool hasFontAxes = false;
  // Paragraph box (textExtras.ts readParagraphBox), paragraph text only.
  std::optional<double> boxHeight;       ///< fixed box height (auto-size Off / Fit)
  std::string boxVerticalAlign;          ///< "" = top, "center", "bottom"
  bool boxFit = false;                   ///< Fit Text to Box
  std::optional<double> boxAnchorHeight; ///< auto-height box's authored height
  bool hasLineRuns = false;              ///< character runs that change a line's height
  /// measureText.ts readLineRuns: the runs that change a line's size or
  /// leading, in grapheme indices (legacy code-point runs migrated).
  struct LineRun {
    double start = 0;
    double end = 0;
    std::optional<double> fontSize, lineHeight;
  };
  std::vector<LineRun> lineRuns;
  /// Set by wrapping: the wrapped content's soft-break line numbers.
  std::optional<std::vector<int>> softBreakLines;
  /// Set by wrapping a Fit Text to Box style (measureText.ts fitScaleOf): the
  /// type scale ≤ 1 its box holds all of its text at; it wraps at
  /// boxWidth / fitScale and draws scaled (textExtras.fitScale).
  std::optional<double> fitScale;
};

/// textExtras.ts softBreakLines(raw, wrapped): the wrapped line numbers that
/// end in a soft break — a '\n' with no '\n' under it in `raw`, whether the
/// wrap REPLACED a space (same length) or INSERTED the break (CJK, longer).
/// A wrapped string shorter than `raw` (never produced) reads as all hard.
[[nodiscard]] std::vector<int> soft_break_lines(std::string_view raw, std::string_view wrapped);

/// measureText.ts MIN_FIT_SCALE: Fit Text to Box never shrinks below this.
inline constexpr double kMinFitScale = 0.05;

/// `readMeasuredTextStyle(node, overrides)` — nullopt when the node has no text
/// content. `overrides` are the sampled animated values (fontSize, …) as the
/// TypeScript passes `evalMap`.
[[nodiscard]] std::optional<MeasuredStyle> read_measured_text_style(
    const doc::Node& n, const std::vector<std::pair<std::string, double>>& overrides);

/// `DEFAULT_LINE_HEIGHT`.
inline constexpr double kDefaultLineHeight = 1.2;

/// Where the lines of a WRAPPED paragraph style sit (measureText.ts
/// boxPlacementOf's stack, before the box placement): centre-origin baselines,
/// each line's leading, the tallest line and the block height. With line runs
/// it is textLayout.ts paragraphLineMetrics (the painter's own stackLines);
/// without, the uniform lineOffsets stack. Measures no glyph.
struct LineStack {
  std::vector<double> ys;
  std::vector<double> leading;  ///< one entry (uniform) without per-range leading runs
  double lineHeightPx = 0;
  double blockHeight = 0;
};
[[nodiscard]] LineStack paragraph_line_stack(const MeasuredStyle& wrapped);

/// measureTextBoxes' FONT box (stroke width 0), relative to the draw origin:
/// the line block's font-metric top / bottom and half the widest advance.
struct FontBox {
  double top = 0;
  double bottom = 0;
  double halfWidth = 0;
};

/// One laid-out line's glyph metrics (TextMeasurer::measure_glyph_lines): the
/// pen after each grapheme (canvas prefix width + tracking; the last = `width`),
/// the line's width as measureTextBoxes counts it (tracking and optical pairs
/// included) and its font band about the middle baseline.
struct GlyphLine {
  std::vector<double> pens;
  double width = 0;
  double ascent = 0;
  double descent = 0;
};

class TextMeasurer {
 public:
  TextMeasurer() = default;
  virtual ~TextMeasurer() = default;
  TextMeasurer(const TextMeasurer&) = delete;
  TextMeasurer& operator=(const TextMeasurer&) = delete;
  TextMeasurer(TextMeasurer&&) = delete;
  TextMeasurer& operator=(TextMeasurer&&) = delete;
  /// `measureTextSize(style)` → {w, h}; nullopt when this style is outside the
  /// port (vertical type, paragraph boxes, optical kerning, variable axes).
  [[nodiscard]] virtual std::optional<std::pair<double, double>> measure_text_size(const MeasuredStyle& s) = 0;
  /// The canvas (fonts) the measurer draws with — what text extrusion traces its
  /// outline on. Null = no canvas (text bodies report unported).
  [[nodiscard]] virtual const raster::CanvasOptions* canvas_options() const noexcept { return nullptr; }
  /// `wrappedStyle(s)`: paragraph text with its content wrapped at the box and
  /// its soft breaks recorded (and a Fit Text to Box style its fitScale);
  /// point text unchanged. nullopt = a wrap outside the port; `why` names it.
  [[nodiscard]] virtual std::optional<MeasuredStyle> wrapped_style(const MeasuredStyle& s, std::string* why) = 0;
  /// `measureTextBoxes(s).font` on the style's own (uncased) content — the
  /// selection box (B4 round 2: getTextLayout.box, getLayerBounds). Paragraph
  /// text measures its wrapped content. nullopt outside the port (vertical
  /// type, variable axes, a wrap outside it).
  [[nodiscard]] virtual std::optional<FontBox> measure_font_box(const MeasuredStyle& s) {
    (void)s;
    return std::nullopt;
  }
  /// B4 round 5 (getTextLayout.glyphs): each '\n'-separated line of the
  /// ALREADY-WRAPPED horizontal `s` measured as measureText.ts
  /// `measureGlyphBoxes` does. nullopt outside the port (as measure_font_box).
  [[nodiscard]] virtual std::optional<std::vector<GlyphLine>> measure_glyph_lines(const MeasuredStyle& s) {
    (void)s;
    return std::nullopt;
  }
};

/// The Canvas2D-metrics measurer over the E3 raster module (fonts from `opts`).
[[nodiscard]] std::unique_ptr<TextMeasurer> make_canvas_measurer(const raster::CanvasOptions& opts);

}  // namespace premation::scene
