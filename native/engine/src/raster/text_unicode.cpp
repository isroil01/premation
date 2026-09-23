#include "text_unicode.hpp"

namespace premation::raster {

std::vector<char32_t> code_points(std::string_view s) {
  std::vector<char32_t> out;
  std::size_t i = 0;
  while (i < s.size()) {
    const auto b0 = static_cast<unsigned char>(s[i]);
    char32_t cp = 0xFFFD;
    std::size_t n = 1;
    const auto cont = [&](std::size_t k) { return static_cast<char32_t>(static_cast<unsigned char>(s[i + k]) & 0x3FU); };
    if (b0 < 0x80) {
      cp = b0;
    } else if ((b0 >> 5U) == 0x6 && i + 1 < s.size()) {
      cp = (static_cast<char32_t>(b0 & 0x1FU) << 6U) | cont(1);
      n = 2;
    } else if ((b0 >> 4U) == 0xE && i + 2 < s.size()) {
      cp = (static_cast<char32_t>(b0 & 0x0FU) << 12U) | (cont(1) << 6U) | cont(2);
      n = 3;
    } else if ((b0 >> 3U) == 0x1E && i + 3 < s.size()) {
      cp = (static_cast<char32_t>(b0 & 0x07U) << 18U) | (cont(1) << 12U) | (cont(2) << 6U) | cont(3);
      n = 4;
    }
    out.push_back(cp);
    i += n;
  }
  return out;
}

void append_utf8(std::string& out, char32_t cp) {
  if (cp < 0x80) {
    out.push_back(static_cast<char>(cp));
  } else if (cp < 0x800) {
    out.push_back(static_cast<char>(0xC0U | (cp >> 6U)));
    out.push_back(static_cast<char>(0x80U | (cp & 0x3FU)));
  } else if (cp < 0x10000) {
    out.push_back(static_cast<char>(0xE0U | (cp >> 12U)));
    out.push_back(static_cast<char>(0x80U | ((cp >> 6U) & 0x3FU)));
    out.push_back(static_cast<char>(0x80U | (cp & 0x3FU)));
  } else {
    out.push_back(static_cast<char>(0xF0U | (cp >> 18U)));
    out.push_back(static_cast<char>(0x80U | ((cp >> 12U) & 0x3FU)));
    out.push_back(static_cast<char>(0x80U | ((cp >> 6U) & 0x3FU)));
    out.push_back(static_cast<char>(0x80U | (cp & 0x3FU)));
  }
}

std::size_t utf16_length(std::string_view s) {
  std::size_t n = 0;
  for (const char32_t c : code_points(s)) n += c >= 0x10000 ? 2 : 1;
  return n;
}

namespace {

bool is_extend(char32_t c) {
  return (c >= 0x0300 && c <= 0x036F) || (c >= 0x0483 && c <= 0x0489) || (c >= 0x0591 && c <= 0x05BD) ||
         c == 0x05BF || c == 0x05C1 || c == 0x05C2 || c == 0x05C4 || c == 0x05C5 || c == 0x05C7 ||
         (c >= 0x0610 && c <= 0x061A) || (c >= 0x064B && c <= 0x065F) || c == 0x0670 ||
         (c >= 0x06D6 && c <= 0x06DC) || (c >= 0x06DF && c <= 0x06E4) || c == 0x06E7 || c == 0x06E8 ||
         (c >= 0x06EA && c <= 0x06ED) || (c >= 0x0900 && c <= 0x0903) || (c >= 0x093A && c <= 0x094F) ||
         (c >= 0x0E31 && c <= 0x0E3A && c != 0x0E32 && c != 0x0E33) || (c >= 0x0E47 && c <= 0x0E4E) ||
         (c >= 0x1AB0 && c <= 0x1AFF) || (c >= 0x1DC0 && c <= 0x1DFF) || (c >= 0x200C && c <= 0x200D) ||
         (c >= 0x20D0 && c <= 0x20FF) || (c >= 0x302A && c <= 0x302F) || (c >= 0x3099 && c <= 0x309A) ||
         (c >= 0xFE00 && c <= 0xFE0F) || (c >= 0xFE20 && c <= 0xFE2F) || (c >= 0x1F3FB && c <= 0x1F3FF) ||
         (c >= 0xE0020 && c <= 0xE007F) || (c >= 0xE0100 && c <= 0xE01EF);
}
bool is_regional(char32_t c) { return c >= 0x1F1E6 && c <= 0x1F1FF; }
bool hangul_l(char32_t c) { return c >= 0x1100 && c <= 0x115F; }
bool hangul_v(char32_t c) { return c >= 0x1160 && c <= 0x11A7; }
bool hangul_t(char32_t c) { return c >= 0x11A8 && c <= 0x11FF; }
bool hangul_syl(char32_t c) { return c >= 0xAC00 && c <= 0xD7A3; }

}  // namespace

std::vector<std::string> split_graphemes(std::string_view text) {
  std::vector<std::string> out;
  const auto cps = code_points(text);
  std::size_t i = 0;
  while (i < cps.size()) {
    std::string cl;
    char32_t prev = cps[i];
    append_utf8(cl, prev);
    int ri = is_regional(prev) ? 1 : 0;
    ++i;
    while (i < cps.size()) {
      const char32_t c = cps[i];
      bool join = false;
      if (prev == U'\r' || prev == U'\n') {
        join = prev == U'\r' && c == U'\n';
      } else {
        join = is_extend(c) || (prev == 0x200D && c >= 0x2000) || (is_regional(c) && ri % 2 == 1) ||
               (hangul_l(prev) && (hangul_l(c) || hangul_v(c) || hangul_syl(c))) ||
               ((hangul_v(prev) || hangul_syl(prev)) && (hangul_v(c) || hangul_t(c))) || (hangul_t(prev) && hangul_t(c));
      }
      if (!join) break;
      if (is_regional(c)) ++ri;
      append_utf8(cl, c);
      prev = c;
      ++i;
    }
    out.push_back(std::move(cl));
  }
  return out;
}

bool is_js_blank(std::string_view s) {
  for (const char32_t c : code_points(s)) {
    const bool ws = c == 0x09 || c == 0x0A || c == 0x0B || c == 0x0C || c == 0x0D || c == 0x20 || c == 0xA0 ||
                    c == 0x1680 || (c >= 0x2000 && c <= 0x200A) || c == 0x2028 || c == 0x2029 || c == 0x202F ||
                    c == 0x205F || c == 0x3000 || c == 0xFEFF;
    if (!ws) return false;
  }
  return true;
}

bool is_line_break(std::string_view c) { return c == "\n" || c == "\r\n" || c == "\r"; }

bool has_complex_script(std::string_view text) {
  for (const char32_t c : code_points(text)) {
    if ((c >= 0x0590 && c <= 0x08FF) || (c >= 0x0900 && c <= 0x0DFF) || (c >= 0x0E00 && c <= 0x0EFF) ||
        (c >= 0x0F00 && c <= 0x0FFF) || (c >= 0x1000 && c <= 0x109F) || (c >= 0x1780 && c <= 0x17FF) ||
        (c >= 0x1800 && c <= 0x18AF) || (c >= 0xA840 && c <= 0xA87F) || (c >= 0xFB1D && c <= 0xFDFF) ||
        (c >= 0xFE70 && c <= 0xFEFF) || (c >= 0x10AC0 && c <= 0x10AFF) || (c >= 0x1E900 && c <= 0x1E95F)) {
      return true;
    }
  }
  return false;
}

namespace {

char32_t upper_cp(char32_t c) {
  if (c >= 'a' && c <= 'z') return c - 32;
  if ((c >= 0xE0 && c <= 0xFE && c != 0xF7)) return c - 32;
  if (c == 0xFF) return 0x178;
  if (c >= 0x100 && c <= 0x17F && c != 0x130 && c != 0x131 && c != 0x138 && c != 0x149 && c != 0x17F) {
    if ((c >= 0x139 && c <= 0x148) || (c >= 0x179 && c <= 0x17E)) return (c % 2 == 0) ? c - 1 : c;
    return (c % 2 == 1) ? c - 1 : c;
  }
  if (c >= 0x3B1 && c <= 0x3C9 && c != 0x3C2) return c - 32;
  if (c == 0x3C2) return 0x3A3;
  if (c >= 0x430 && c <= 0x44F) return c - 32;
  if (c >= 0x450 && c <= 0x45F) return c - 80;
  return c;
}
char32_t lower_cp(char32_t c) {
  if (c >= 'A' && c <= 'Z') return c + 32;
  if (c >= 0xC0 && c <= 0xDE && c != 0xD7) return c + 32;
  if (c == 0x178) return 0xFF;
  if (c >= 0x100 && c <= 0x17F && c != 0x130 && c != 0x131 && c != 0x138 && c != 0x149 && c != 0x17F) {
    if ((c >= 0x139 && c <= 0x148) || (c >= 0x179 && c <= 0x17E)) return (c % 2 == 1) ? c + 1 : c;
    return (c % 2 == 0) ? c + 1 : c;
  }
  if (c >= 0x391 && c <= 0x3A9 && c != 0x3A2) return c + 32;
  if (c >= 0x410 && c <= 0x42F) return c + 32;
  if (c >= 0x400 && c <= 0x40F) return c + 80;
  return c;
}

}  // namespace

std::string to_upper(std::string_view s) {
  std::string out;
  for (const char32_t c : code_points(s)) {
    if (c == 0xDF) out += "SS";  // ß → SS (V8/ICU)
    else append_utf8(out, upper_cp(c));
  }
  return out;
}

std::string to_lower(std::string_view s) {
  std::string out;
  for (const char32_t c : code_points(s)) append_utf8(out, lower_cp(c));
  return out;
}

}  // namespace premation::raster
