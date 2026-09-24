#include "line_break.hpp"

#include <algorithm>
#include <array>
#include <map>
#include <string_view>
#include <utility>

#include "text_unicode.hpp"

namespace premation::raster {
namespace {

#include "vertical_orientation.inc"

void append_utf16(std::u16string& out, char32_t cp) {
  if (cp < 0x10000) {
    out.push_back(static_cast<char16_t>(cp));
    return;
  }
  const char32_t v = cp - 0x10000;
  out.push_back(static_cast<char16_t>(0xD800 + (v >> 10)));
  out.push_back(static_cast<char16_t>(0xDC00 + (v & 0x3FF)));
}

}  // namespace

char vertical_orientation_of(char32_t cp) {
  const auto it = std::ranges::upper_bound(kVoStarts, cp);
  if (it == kVoStarts.begin()) return 'R';
  const auto i = static_cast<std::size_t>(it - kVoStarts.begin() - 1);
  return i < kVoValues.size() ? kVoValues[i] : 'R';
}

bool is_break_space(const std::string& unit) { return unit == " " || unit == "\t"; }

bool is_ideographic_unit(const std::string& unit) {
  if (unit.empty() || is_break_space(unit)) return false;
  return vertical_orientation_of(code_points(unit).front()) != 'R';
}

bool kinsoku_allows(const std::vector<std::string>& units, std::size_t i) {
  if (i == 0 || i >= units.size()) return false;
  const auto a = code_points(units[i - 1]);
  const auto b = code_points(units[i]);
  if (!b.empty() && std::ranges::find(kKinsokuNoStart, b.front()) != kKinsokuNoStart.end()) return false;
  if (!a.empty() && std::ranges::find(kKinsokuNoEnd, a.back()) != kKinsokuNoEnd.end()) return false;
  return true;
}

std::vector<bool> break_opportunities(const std::vector<std::string>& units) {
  const std::size_t n = units.size();
  std::vector<bool> out(n, false);
  if (n < 2) return out;

  // Word-segment starts where BOTH neighbouring segments are word-like (ICU's
  // dictionary word breaks: Thai, Lao, Khmer, Myanmar; script changes).
  std::optional<std::vector<bool>> wordJoins;
  {
    std::u16string text;
    std::map<std::size_t, std::size_t> starts;  // UTF-16 offset → unit index
    for (std::size_t i = 0; i < n; ++i) {
      starts[text.size()] = i;  // Map.set: a later unit at the same offset (an empty unit) wins
      for (const char32_t cp : code_points(units[i])) append_utf16(text, cp);
    }
    if (auto segs = word_segments(text)) {
      wordJoins.emplace(n, false);
      bool prevWordLike = false;
      for (const auto& s : *segs) {
        const auto at = starts.find(s.index);
        if (at != starts.end() && at->second > 0 && s.wordLike && prevWordLike) (*wordJoins)[at->second] = true;
        prevWordLike = s.wordLike;
      }
    }
  }

  for (std::size_t i = 1; i < n; ++i) {
    const auto& a = units[i - 1];
    const auto& b = units[i];
    if (is_break_space(b)) continue;
    if (!kinsoku_allows(units, i)) continue;
    if (is_break_space(a)) { out[i] = true; continue; }
    if (is_ideographic_unit(a) || is_ideographic_unit(b)) { out[i] = true; continue; }
    const auto acps = code_points(a);
    // a.codePointAt(a.length - 1): the last UTF-16 unit — the last code point for BMP text.
    if (!acps.empty() && (acps.back() == 0x2D || acps.back() == 0x2010)) { out[i] = true; continue; }
    if (wordJoins && (*wordJoins)[i]) out[i] = true;
  }
  return out;
}

std::vector<std::size_t> wrap_units(const std::vector<std::string>& units, const std::vector<double>& lengths, double limit) {
  std::vector<std::size_t> starts;
  if (!(limit > 0)) return starts;
  const auto opportunities = break_opportunities(units);
  constexpr double kFitEps = 0.5;
  std::size_t start = 0;
  double len = 0;
  for (std::size_t i = 0; i < units.size(); ++i) {
    const double w = i < lengths.size() ? lengths[i] : 0;
    if (i > start && !is_break_space(units[i]) && len + w > limit + kFitEps) {
      std::size_t b = i;
      while (b > start && !opportunities[b]) --b;
      if (b == start) {
        b = i;
        while (b - 1 > start && !kinsoku_allows(units, b)) --b;
        if (!kinsoku_allows(units, b)) b = i;
      }
      starts.push_back(b);
      start = b;
      len = 0;
      for (std::size_t k = b; k < i; ++k) len += k < lengths.size() ? lengths[k] : 0;
    }
    len += w;
  }
  return starts;
}

}  // namespace premation::raster
