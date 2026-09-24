// lineBreak.ts (E3): where a line or a vertical column may break — kinsoku
// shori, the ideographic / space / hyphen opportunities and the Intl.Segmenter
// word joins (word_break_ffi.cpp) — plus the greedy wrap and the
// Vertical_Orientation lookup those rules stand on. Skia-free (engine_raster_core).
#pragma once

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace premation::raster {

/// verticalForms.ts: Vertical_Orientation of a code point ('U', 'R', 'u' = Tu, 'r' = Tr).
[[nodiscard]] char vertical_orientation_of(char32_t cp);
/// lineBreak.ts isIdeographicUnit.
[[nodiscard]] bool is_ideographic_unit(const std::string& unit);
/// lineBreak.ts isBreakSpace.
[[nodiscard]] bool is_break_space(const std::string& unit);

/// lineBreak.ts kinsokuAllows / breakOpportunities / wrapUnits.
[[nodiscard]] bool kinsoku_allows(const std::vector<std::string>& units, std::size_t i);
[[nodiscard]] std::vector<bool> break_opportunities(const std::vector<std::string>& units);
[[nodiscard]] std::vector<std::size_t> wrap_units(const std::vector<std::string>& units, const std::vector<double>& lengths, double limit);

// ── Intl.Segmenter word segmentation (word_break_ffi.cpp) ───────────────────

/// One segment of `new Intl.Segmenter(undefined, {granularity: 'word'}).segment(text)`.
struct WordSegment {
  std::size_t index = 0;  // UTF-16 offset of the segment's start (JS string index)
  bool wordLike = false;  // Segment.isWordLike
};

/// The word segments of UTF-16 `text`, or nullopt when no segmenter is available
/// (the TS's "without Intl.Segmenter" branch: spaces and hyphens only). ICU's
/// break iterator, loaded from the system at first use — V8's Intl.Segmenter IS
/// ICU's word break iterator, dictionaries included (Thai, Lao, Khmer, Myanmar …).
[[nodiscard]] std::optional<std::vector<WordSegment>> word_segments(std::u16string_view text);

/// The ICU the segmenter runs on ("icu 74 (libicuuc.so.74)"), or "" when none loaded.
[[nodiscard]] std::string word_segmenter_info();

/// lineBreak.ts setWordSegmenterForTest: run without the segmenter.
void set_word_segmenter_disabled_for_test(bool disabled);

}  // namespace premation::raster
