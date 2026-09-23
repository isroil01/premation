// CSS value parsing the Canvas2D API needs (E3): colours (fillStyle /
// strokeStyle / addColorStop), the `font` shorthand, `letterSpacing` lengths and
// the `filter` blur. Mirrors what Blink accepts for these canvas properties; an
// unparseable value returns nullopt and the caller keeps its previous state, as
// the canvas does.
#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace premation::raster::css {

/// A parsed colour: channels 0..255 (8-bit when it came from hex/named), alpha 0..1.
struct Color {
  double r = 0.0;
  double g = 0.0;
  double b = 0.0;
  double a = 1.0;
  bool operator==(const Color&) const = default;
};

[[nodiscard]] std::optional<Color> parse_color(std::string_view s);

/// The `font` shorthand, as CanvasRenderingContext2D.font parses it.
struct Font {
  bool italic = false;
  bool smallCaps = false;
  int weight = 400;
  /// font-stretch as a percentage (condensed = 75 …); 100 = normal.
  double stretch = 100.0;
  double sizePx = 10.0;
  /// Family names in order, unquoted (generic families keep their keyword).
  std::vector<std::string> families;
};

[[nodiscard]] std::optional<Font> parse_font(std::string_view s);

/// A `<length>` in px ("3px", "0", "-1.5px"); em units resolve against `emPx`.
[[nodiscard]] std::optional<double> parse_length_px(std::string_view s, double emPx);

/// `filter`: the blur radius when the value is exactly one `blur(<length>)`, 0 for
/// "none"; nullopt for anything else (unsupported filter functions).
struct Filter {
  double blurPx = 0.0;
};
[[nodiscard]] std::optional<Filter> parse_filter(std::string_view s);

/// Unicode ranges of a CSS `unicode-range` descriptor.
struct Range {
  char32_t lo = 0;
  char32_t hi = 0;
};
[[nodiscard]] std::vector<Range> parse_unicode_range(std::string_view s);

}  // namespace premation::raster::css
