// Text layout (E3): src/core/text/textLayout.ts + the paragraph geometry of
// textExtras.ts, ported with the TS's arithmetic order so glyph positions come
// out equal to the float. Pure — measurement is injected, as in the TS.
#pragma once

#include <functional>
#include <map>
#include <numbers>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "json.hpp"

namespace premation::raster {

// ── textExtras.ts ────────────────────────────────────────────────────────────

inline constexpr double kTextPadX = 12;
inline constexpr double kAutoLeading = 1.2;
inline constexpr double kFauxBoldStrokeRatio = 1.0 / 30.0;

/// TextExtras, the fields the painter reads.
struct TextExtras {
  std::optional<double> leftIndent, rightIndent, firstLineIndent, spaceBefore, spaceAfter;
  std::optional<std::vector<int>> softBreakLines;
  std::string strokeLineJoin;  // '' = default
  std::string strokeOrder;
  bool fauxBold = false, fauxItalic = false, noFill = false, noStroke = false;
  std::string kerningMode;
  std::optional<double> boxHeight;
  std::string boxVerticalAlign;
  std::optional<double> fitScale;
  std::string anchorGrouping;
  std::optional<std::pair<double, double>> groupingAlign;
  std::string fillStrokeMode;
  std::string interCharacterBlending;
  bool ligaturesOff = false, discretionaryLigatures = false, contextualAlternatesOff = false;
  std::vector<int> stylisticSets;
  std::string direction;  // '' | 'rtl' | 'auto'
  bool vertical = false;
  bool verticalRomanAlignment = false;
  std::optional<int> tateChuYokoDigits;
  std::optional<double> boxOffsetY;
};
[[nodiscard]] TextExtras read_text_extras(const json::Value& v);

enum class LineAlign : std::uint8_t { left, center, right };
struct ResolvedAlign {
  LineAlign line = LineAlign::left;
  bool justify = false;
  bool justifyLast = false;
};
[[nodiscard]] ResolvedAlign resolve_align(const std::string& align);
[[nodiscard]] bool is_justifiable_space(const std::string& cluster);

struct ParagraphFrame {
  double boxWidth = 0;
  double padX = 0;
  bool boxText = false;
  std::string align;
  std::optional<double> leftIndent, rightIndent, firstLineIndent;
  bool rtl = false;
};
struct LineFacts {
  double width = 0;
  int spaces = 0;
  bool hardEnd = true;
  bool paragraphStart = true;
};
struct LinePlacement {
  double left = 0;
  double anchor = 0;
  LineAlign lineAlign = LineAlign::left;
  double spaceExtra = 0;
};
[[nodiscard]] LinePlacement place_line(const LineFacts& line, const ParagraphFrame& frame);
[[nodiscard]] std::pair<std::vector<double>, double> line_offsets(const std::vector<bool>& hardEnds, double baseGap,
                                                                  double spaceBefore, double spaceAfter);
[[nodiscard]] std::vector<bool> hard_ends_of(std::size_t lineCount, const std::optional<std::vector<int>>& soft);
struct BoxLinePlacement {
  double dy = 0;
  int visible = 0;
  bool overflow = false;
};
[[nodiscard]] BoxLinePlacement place_lines_in_box(const std::vector<double>& lineYs, const std::vector<double>& lineHeightPx,
                                                  double boxHeight, const std::string& verticalAlign);
[[nodiscard]] std::string_view resolve_paragraph_direction(std::string_view direction, std::string_view paragraphText);

// ── textLayout.ts ────────────────────────────────────────────────────────────

/// TextStyle (+ the ParagraphStyle fields a base style carries). Optional fields
/// keep JS `undefined` distinct from a value, which the TS arithmetic tests.
struct TextStyle {  // NOLINT(bugprone-exception-escape): implicit special members only; bad_alloc terminates by design
  double fontSize = 0;
  std::optional<std::string> fontFamily, fontWeight, fontStyle, fill, strokeColor, verticalAlign;
  std::optional<double> letterSpacing, kerning, strokeWidth, lineHeight, horizontalScale, verticalScale, baselineShift, tsume;
  bool fauxBold = false, fauxItalic = false, allCaps = false, smallCaps = false, tateChuYoko = false;
  std::optional<std::map<std::string, double>> axisOffsets;
  // ParagraphStyle (base only)
  std::string align;
  std::optional<double> paragraphSpacing, leftIndent, rightIndent, firstLineIndent, spaceBefore, spaceAfter;

  /// `{...this, ...run}` with a run style's JSON.
  [[nodiscard]] TextStyle merged(const json::Value& runStyle) const;
};

struct RichRun {
  int start = 0;
  int end = 0;
  const json::Value* style = nullptr;
};

/// textAnimators.ts GlyphTransform (what the painter and layout read).
struct GlyphTransform {  // NOLINT(bugprone-exception-escape): implicit special members only; bad_alloc terminates by design
  std::string ch, displayChar;
  double dx = 0, dy = 0, dz = 0, rotationX = 0, rotationY = 0, scale = 1, scaleY = 1, rotation = 0, opacity = 1,
         fillOpacity = 1, tracking = 0, lineSpacing = 0, blur = 0, skew = 0, strokeWidth = 0;
  std::optional<double> blurY, colorMix, strokeColorMix, anchorX, anchorY, skewAxis, trackingBefore, fillHue,
      fillSaturation, fillBrightness, strokeOpacity, strokeHue, strokeSaturation, strokeBrightness, lineAnchor;
  std::optional<std::string> color, strokeColor;
  std::optional<std::map<std::string, double>> axes;
};
[[nodiscard]] GlyphTransform read_glyph_transform(const json::Value& v);
[[nodiscard]] bool is_identity_transform(const GlyphTransform& t);

struct PlacedGlyph {  // NOLINT(bugprone-exception-escape): implicit special members only; bad_alloc terminates by design
  std::string ch;
  int index = 0;
  double x = 0, y = 0, advance = 0, inkWidth = 0;
  TextStyle style;
  int line = 0;
  const GlyphTransform* transform = nullptr;
  std::optional<double> angle;
  std::optional<std::string> drawn;
  std::optional<int> level;
  // verticalLayout.ts VerticalGlyph extras
  bool vertAlternate = false;
  std::optional<int> tcyStart;
  double tcyScale = 1;
};

struct LineBox {
  double width = 0, y = 0, left = 0;
  double spaceExtra = 0;
  std::string direction;  // '' | 'ltr' | 'rtl'
};

struct TextLayout {
  std::vector<PlacedGlyph> glyphs;
  std::vector<LineBox> lines;
  double width = 0, height = 0;
  std::optional<int> visibleLines;
  std::optional<std::vector<double>> lineLeading;
};

using MeasureGlyph = std::function<double(const std::string&, const TextStyle&)>;
using MeasureRun = std::function<double(const std::string&, const TextStyle&)>;
using OpticalKern = std::function<double(const std::string&, const TextStyle&, const std::string&, const TextStyle&)>;
struct Bearings {
  double left = 0, right = 0;
};
using MeasureBearings = std::function<Bearings(const std::string&, const TextStyle&)>;

struct LayoutOptions {
  const std::vector<RichRun>* runs = nullptr;
  const std::vector<GlyphTransform>* transforms = nullptr;
  double boxWidth = 0;
  MeasureRun measureRun;
  double padX = 0;
  std::optional<std::vector<int>> softBreakLines;
  std::string kerningMode;
  OpticalKern opticalKern;
  MeasureBearings measureBearings;
  std::string direction;  // '' | 'rtl' | 'auto'
};

[[nodiscard]] TextStyle resolve_glyph_style(const TextStyle& base, const std::vector<RichRun>* runs, int index);
struct StyleScale {
  double sx = 1, sy = 1, dy = 0;
};
[[nodiscard]] StyleScale glyph_style_scale(const TextStyle& s);
[[nodiscard]] TextLayout layout_text(const std::string& text, const TextStyle& base, const MeasureGlyph& measure,
                                     const LayoutOptions& opts);

struct LineBidi {
  bool rtl = false;
  std::optional<std::vector<int>> levels;
};
[[nodiscard]] std::vector<LineBidi> paragraph_bidi_lines(const std::vector<std::vector<std::string>>& lines,
                                                         const std::vector<bool>& hardEnds, const std::string& direction);
[[nodiscard]] bool soft_wrap_changes_bidi(const std::string& text, const std::optional<std::vector<int>>& softBreakLines,
                                          const std::string& direction);

struct WholeLineSegment {
  std::string text;
  double x = 0;
  LineAlign align = LineAlign::left;
  double left = 0;
};
struct WholeLinePlan {
  double y = 0, left = 0, width = 0;
  std::vector<WholeLineSegment> segments;
  bool rtl = false;  // 'auto' layouts: this line's paragraph is right-to-left
};
struct WholeLineOptions {
  double boxWidth = 0;
  double padX = 0;
  std::optional<std::vector<int>> softBreakLines;
  std::string direction;
};
[[nodiscard]] std::vector<WholeLinePlan> plan_whole_string_lines(const std::string& text, const TextStyle& base,
                                                                 const std::function<double(const std::string&)>& measureLine,
                                                                 const WholeLineOptions& opts);

// ── verticalLayout.ts / verticalForms.ts / lineBreak.ts ──────────────────────

struct VerticalForm {
  std::string drawn;
  bool upright = false;
  bool alternate = false;
  bool corner = false;
};
/// verticalForms.ts resolveVerticalForm; `alternates` = the face has a vertical
/// alternate for this code point (no alias faces here: always false today).
[[nodiscard]] VerticalForm resolve_vertical_form(const std::string& cluster, bool alternates, bool romanUpright);
/// lineBreak.ts kinsokuAllows / breakOpportunities (without Intl word joins) / wrapUnits.
[[nodiscard]] bool kinsoku_allows(const std::vector<std::string>& units, std::size_t i);
[[nodiscard]] std::vector<bool> break_opportunities(const std::vector<std::string>& units);
[[nodiscard]] std::vector<std::size_t> wrap_units(const std::vector<std::string>& units, const std::vector<double>& lengths, double limit);

struct VerticalLayoutOptions {
  const std::vector<RichRun>* runs = nullptr;
  const std::vector<GlyphTransform>* transforms = nullptr;
  double boxWidth = 0;
  double padX = 0;
  std::optional<double> columnLimit;
  MeasureRun measureRun;
  bool romanUpright = false;
  std::optional<int> tateChuYokoDigits;
  OpticalKern opticalKern;
};
/// verticalLayout.ts layoutVerticalText (vertical alternates always off — see resolve_vertical_form).
[[nodiscard]] TextLayout layout_vertical_text(const std::string& text, const TextStyle& base, const MeasureGlyph& measure,
                                              const VerticalLayoutOptions& opts);
inline constexpr double kSidewaysAngle = std::numbers::pi / 2;

/// verticalForms.ts: Vertical_Orientation of a code point ('U', 'R', 'u' = Tu, 'r' = Tr).
[[nodiscard]] char vertical_orientation_of(char32_t cp);
/// lineBreak.ts isIdeographicUnit.
[[nodiscard]] bool is_ideographic_unit(const std::string& unit);

}  // namespace premation::raster
