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
  bool opticalKerning = false;
  bool hasFontAxes = false;
};

/// `readMeasuredTextStyle(node, overrides)` — nullopt when the node has no text
/// content. `overrides` are the sampled animated values (fontSize, …) as the
/// TypeScript passes `evalMap`.
[[nodiscard]] std::optional<MeasuredStyle> read_measured_text_style(
    const doc::Node& n, const std::vector<std::pair<std::string, double>>& overrides);

/// `DEFAULT_LINE_HEIGHT`.
inline constexpr double kDefaultLineHeight = 1.2;

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
};

/// The Canvas2D-metrics measurer over the E3 raster module (fonts from `opts`).
[[nodiscard]] std::unique_ptr<TextMeasurer> make_canvas_measurer(const raster::CanvasOptions& opts);

}  // namespace premation::scene
