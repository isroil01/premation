// Unicode pieces of the text layout port (E3): grapheme clusters (the TS uses
// Intl.Segmenter; this is the UAX #29 subset motion_expr also uses) and UAX #9
// bidi levels (the TS has its own UAX #9, src/core/text/bidi.ts; here SheenBidi,
// a conformant implementation, behind bidi_ffi.cpp), plus the cluster-level
// helpers bidi.ts exposes (clusterBidi, resetLineEnd, visualOrder).
#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace premation::raster {

/// Extended grapheme clusters of UTF-8 text, as UTF-8 strings.
[[nodiscard]] std::vector<std::string> split_graphemes(std::string_view text);

/// Code points of UTF-8 text.
[[nodiscard]] std::vector<char32_t> code_points(std::string_view text);

/// UTF-8 encode.
void append_utf8(std::string& out, char32_t cp);

/// JS String.prototype.length of a UTF-8 string (UTF-16 code units).
[[nodiscard]] std::size_t utf16_length(std::string_view s);

/// JS `s.trim() === ''` (ECMAScript WhiteSpace + LineTerminator).
[[nodiscard]] bool is_js_blank(std::string_view s);

/// graphemes.ts isLineBreak.
[[nodiscard]] bool is_line_break(std::string_view cluster);

/// graphemes.ts hasComplexScript.
[[nodiscard]] bool has_complex_script(std::string_view text);

/// JS toUpperCase / toLowerCase for the ranges V8's ICU mapping is used on in
/// practice (ASCII, Latin-1, Latin Extended-A, Greek, Cyrillic); others unchanged.
[[nodiscard]] std::string to_upper(std::string_view s);
[[nodiscard]] std::string to_lower(std::string_view s);

// ── bidi (bidi.ts) ──────────────────────────────────────────────────────────

/// UAX #9 bidi classes (the subset of distinctions bidi.ts's helpers need).
enum class BidiClass : std::uint8_t { L, R, AL, EN, ES, ET, AN, CS, NSM, BN, B, S, WS, ON, LRE, LRO, RLE, RLO, PDF, LRI, RLI, FSI, PDI };
[[nodiscard]] BidiClass bidi_class_of(char32_t cp);

struct BidiResolution {
  std::vector<int> levels;  // one per code point
  int paragraphLevel = 0;
};

/// Levels of `cps`; direction 0 = LTR, 1 = RTL, -1 = auto (P2/P3). Paragraph
/// separators split paragraphs as bidi.ts's resolveIds does; L1 applied.
[[nodiscard]] BidiResolution resolve_bidi(const std::vector<char32_t>& cps, int direction);

/// bidi.ts clusterBidi: each cluster takes its first code point's level.
[[nodiscard]] BidiResolution cluster_bidi(const std::vector<std::string>& clusters, int direction);
/// bidi.ts resetLineEnd (L1 at a line end), in place.
void reset_line_end(const std::vector<std::string>& clusters, std::vector<int>& levels, int paragraphLevel);
/// bidi.ts visualOrder (L2): order[v] = logical index at visual position v.
[[nodiscard]] std::vector<int> visual_order(const std::vector<int>& levels);
/// bidi.ts hasStrongRtl / paragraphLevelOf.
[[nodiscard]] bool has_strong_rtl(std::string_view text);
[[nodiscard]] int paragraph_level_of(std::string_view text);

}  // namespace premation::raster
