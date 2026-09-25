// F1: chapter marks as the FFMETADATA1 text ffmpeg maps onto an mp4 / mov
// (src/core/export/chapters.ts `formatFfmetadata`), byte for byte. The
// chapters arrive resolved (the editor derives them from the composition's
// markers at queue time); only the text is produced here.
#pragma once

#include <cmath>
#include <cstdint>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace premation::exporter {

struct Chapter {
  double startMs = 0;
  double endMs = 0;
  std::string title;  // UTF-8
};

namespace detail {

/// ECMAScript WhiteSpace + LineTerminator: what `/\s+/g` and `trim()` match.
constexpr bool js_space(char32_t c) noexcept {
  return c == 0x09 || c == 0x0A || c == 0x0B || c == 0x0C || c == 0x0D || c == 0x20 || c == 0xA0 || c == 0x1680 ||
         (c >= 0x2000 && c <= 0x200A) || c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x3000 ||
         c == 0xFEFF;
}

/// The UTF-8 sequence at `s[i]`: its code point and byte length. A malformed
/// sequence is one byte that is not white space.
inline std::pair<char32_t, std::size_t> utf8_at(std::string_view s, std::size_t i) noexcept {
  const auto b = static_cast<unsigned char>(s[i]);
  const std::size_t n = b < 0x80 ? 1 : (b >> 5U) == 0x6 ? 2 : (b >> 4U) == 0xE ? 3 : (b >> 3U) == 0x1E ? 4 : 0;
  if (n == 0 || i + n > s.size()) return {0xFFFD, 1};
  char32_t c = n == 1 ? b : b & (0x7FU >> n);
  for (std::size_t k = 1; k < n; ++k) {
    const auto cb = static_cast<unsigned char>(s[i + k]);
    if ((cb >> 6U) != 0x2) return {0xFFFD, 1};
    c = (c << 6U) | (cb & 0x3FU);
  }
  return {c, n};
}

/// `escapeFfmetadataValue`: white-space runs → one space, `= ; # \` escaped, trimmed.
inline std::string escape_value(std::string_view v) {
  std::string out;
  bool inSpace = false;
  for (std::size_t i = 0; i < v.size();) {
    const auto [c, n] = utf8_at(v, i);
    if (js_space(c)) {
      inSpace = true;
    } else {
      if (inSpace) out += ' ';
      inSpace = false;
      if (c == '=' || c == ';' || c == '#' || c == '\\') out += '\\';
      out.append(v.substr(i, n));
    }
    i += n;
  }
  const std::size_t first = out.find_first_not_of(' ');
  return first == std::string::npos ? std::string() : out.substr(first);
}

/// `Math.max(0, Math.round(ms))` as JavaScript prints it (the values are finite and far below 2^53).
inline std::string ms_text(double ms) {
  const double f = std::floor(ms);
  const double r = ms - f >= 0.5 ? f + 1 : f;
  return std::to_string(r > 0 ? static_cast<std::int64_t>(r) : 0);
}

}  // namespace detail

/// The FFMETADATA1 file for `chapters`; empty when there are none (no file, no ffmpeg input).
inline std::string format_ffmetadata(const std::vector<Chapter>& chapters) {
  if (chapters.empty()) return {};
  std::string s = ";FFMETADATA1\n";
  for (const Chapter& c : chapters) {
    s += "[CHAPTER]\nTIMEBASE=1/1000\nSTART=" + detail::ms_text(c.startMs) + "\nEND=" + detail::ms_text(c.endMs) +
         "\ntitle=" + detail::escape_value(c.title) + "\n";
  }
  return s;
}

}  // namespace premation::exporter
