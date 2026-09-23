#include "css.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <functional>
#include <system_error>

namespace premation::raster::css {
namespace {

struct Named {
  std::string_view name;
  std::uint32_t rgb;
};

// CSS Color 4 named colours (sorted for binary search).
constexpr std::array<Named, 148> kNamed{{
    {"aliceblue", 0xF0F8FF}, {"antiquewhite", 0xFAEBD7}, {"aqua", 0x00FFFF}, {"aquamarine", 0x7FFFD4},
    {"azure", 0xF0FFFF}, {"beige", 0xF5F5DC}, {"bisque", 0xFFE4C4}, {"black", 0x000000},
    {"blanchedalmond", 0xFFEBCD}, {"blue", 0x0000FF}, {"blueviolet", 0x8A2BE2}, {"brown", 0xA52A2A},
    {"burlywood", 0xDEB887}, {"cadetblue", 0x5F9EA0}, {"chartreuse", 0x7FFF00}, {"chocolate", 0xD2691E},
    {"coral", 0xFF7F50}, {"cornflowerblue", 0x6495ED}, {"cornsilk", 0xFFF8DC}, {"crimson", 0xDC143C},
    {"cyan", 0x00FFFF}, {"darkblue", 0x00008B}, {"darkcyan", 0x008B8B}, {"darkgoldenrod", 0xB8860B},
    {"darkgray", 0xA9A9A9}, {"darkgreen", 0x006400}, {"darkgrey", 0xA9A9A9}, {"darkkhaki", 0xBDB76B},
    {"darkmagenta", 0x8B008B}, {"darkolivegreen", 0x556B2F}, {"darkorange", 0xFF8C00}, {"darkorchid", 0x9932CC},
    {"darkred", 0x8B0000}, {"darksalmon", 0xE9967A}, {"darkseagreen", 0x8FBC8F}, {"darkslateblue", 0x483D8B},
    {"darkslategray", 0x2F4F4F}, {"darkslategrey", 0x2F4F4F}, {"darkturquoise", 0x00CED1}, {"darkviolet", 0x9400D3},
    {"deeppink", 0xFF1493}, {"deepskyblue", 0x00BFFF}, {"dimgray", 0x696969}, {"dimgrey", 0x696969},
    {"dodgerblue", 0x1E90FF}, {"firebrick", 0xB22222}, {"floralwhite", 0xFFFAF0}, {"forestgreen", 0x228B22},
    {"fuchsia", 0xFF00FF}, {"gainsboro", 0xDCDCDC}, {"ghostwhite", 0xF8F8FF}, {"gold", 0xFFD700},
    {"goldenrod", 0xDAA520}, {"gray", 0x808080}, {"green", 0x008000}, {"greenyellow", 0xADFF2F},
    {"grey", 0x808080}, {"honeydew", 0xF0FFF0}, {"hotpink", 0xFF69B4}, {"indianred", 0xCD5C5C},
    {"indigo", 0x4B0082}, {"ivory", 0xFFFFF0}, {"khaki", 0xF0E68C}, {"lavender", 0xE6E6FA},
    {"lavenderblush", 0xFFF0F5}, {"lawngreen", 0x7CFC00}, {"lemonchiffon", 0xFFFACD}, {"lightblue", 0xADD8E6},
    {"lightcoral", 0xF08080}, {"lightcyan", 0xE0FFFF}, {"lightgoldenrodyellow", 0xFAFAD2}, {"lightgray", 0xD3D3D3},
    {"lightgreen", 0x90EE90}, {"lightgrey", 0xD3D3D3}, {"lightpink", 0xFFB6C1}, {"lightsalmon", 0xFFA07A},
    {"lightseagreen", 0x20B2AA}, {"lightskyblue", 0x87CEFA}, {"lightslategray", 0x778899}, {"lightslategrey", 0x778899},
    {"lightsteelblue", 0xB0C4DE}, {"lightyellow", 0xFFFFE0}, {"lime", 0x00FF00}, {"limegreen", 0x32CD32},
    {"linen", 0xFAF0E6}, {"magenta", 0xFF00FF}, {"maroon", 0x800000}, {"mediumaquamarine", 0x66CDAA},
    {"mediumblue", 0x0000CD}, {"mediumorchid", 0xBA55D3}, {"mediumpurple", 0x9370DB}, {"mediumseagreen", 0x3CB371},
    {"mediumslateblue", 0x7B68EE}, {"mediumspringgreen", 0x00FA9A}, {"mediumturquoise", 0x48D1CC}, {"mediumvioletred", 0xC71585},
    {"midnightblue", 0x191970}, {"mintcream", 0xF5FFFA}, {"mistyrose", 0xFFE4E1}, {"moccasin", 0xFFE4B5},
    {"navajowhite", 0xFFDEAD}, {"navy", 0x000080}, {"oldlace", 0xFDF5E6}, {"olive", 0x808000},
    {"olivedrab", 0x6B8E23}, {"orange", 0xFFA500}, {"orangered", 0xFF4500}, {"orchid", 0xDA70D6},
    {"palegoldenrod", 0xEEE8AA}, {"palegreen", 0x98FB98}, {"paleturquoise", 0xAFEEEE}, {"palevioletred", 0xDB7093},
    {"papayawhip", 0xFFEFD5}, {"peachpuff", 0xFFDAB9}, {"peru", 0xCD853F}, {"pink", 0xFFC0CB},
    {"plum", 0xDDA0DD}, {"powderblue", 0xB0E0E6}, {"purple", 0x800080}, {"rebeccapurple", 0x663399},
    {"red", 0xFF0000}, {"rosybrown", 0xBC8F8F}, {"royalblue", 0x4169E1}, {"saddlebrown", 0x8B4513},
    {"salmon", 0xFA8072}, {"sandybrown", 0xF4A460}, {"seagreen", 0x2E8B57}, {"seashell", 0xFFF5EE},
    {"sienna", 0xA0522D}, {"silver", 0xC0C0C0}, {"skyblue", 0x87CEEB}, {"slateblue", 0x6A5ACD},
    {"slategray", 0x708090}, {"slategrey", 0x708090}, {"snow", 0xFFFAFA}, {"springgreen", 0x00FF7F},
    {"steelblue", 0x4682B4}, {"tan", 0xD2B48C}, {"teal", 0x008080}, {"thistle", 0xD8BFD8},
    {"tomato", 0xFF6347}, {"turquoise", 0x40E0D0}, {"violet", 0xEE82EE}, {"wheat", 0xF5DEB3},
    {"white", 0xFFFFFF}, {"whitesmoke", 0xF5F5F5}, {"yellow", 0xFFFF00}, {"yellowgreen", 0x9ACD32},
}};

std::string lower_trim(std::string_view s) {
  while (!s.empty() && (s.front() == ' ' || s.front() == '\t' || s.front() == '\n')) s.remove_prefix(1);
  while (!s.empty() && (s.back() == ' ' || s.back() == '\t' || s.back() == '\n')) s.remove_suffix(1);
  std::string out(s);
  for (char& c : out) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return out;
}

int hexv(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

std::optional<double> number(std::string_view s) {
  if (s.empty()) return std::nullopt;
  if (s.front() == '+') s.remove_prefix(1);
  double d = 0.0;
  const auto r = std::from_chars(s.data(), s.data() + s.size(), d);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  if (r.ec != std::errc() || r.ptr != s.data() + s.size()) return std::nullopt;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  return d;
}

std::vector<std::string_view> split_args(std::string_view body) {
  std::vector<std::string_view> out;
  std::size_t i = 0;
  while (i < body.size()) {
    while (i < body.size() && (body[i] == ' ' || body[i] == ',' || body[i] == '/' || body[i] == '\t')) ++i;
    const std::size_t st = i;
    while (i < body.size() && body[i] != ' ' && body[i] != ',' && body[i] != '/' && body[i] != '\t') ++i;
    if (i > st) out.push_back(body.substr(st, i - st));
  }
  return out;
}

double clamp(double v, double lo, double hi) { return std::min(hi, std::max(lo, v)); }

std::optional<double> alpha_of(std::string_view p) {
  if (!p.empty() && p.back() == '%') {
    const auto v = number(p.substr(0, p.size() - 1));
    return v ? std::optional<double>(clamp(*v / 100.0, 0, 1)) : std::nullopt;
  }
  const auto v = number(p);
  return v ? std::optional<double>(clamp(*v, 0, 1)) : std::nullopt;
}

double hue_to_rgb(double p, double q, double t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1.0 / 6) return p + (q - p) * 6 * t;
  if (t < 1.0 / 2) return q;
  if (t < 2.0 / 3) return p + (q - p) * (2.0 / 3 - t) * 6;
  return p;
}

}  // namespace

std::optional<Color> parse_color(std::string_view in) {
  const std::string s = lower_trim(in);
  if (s.empty()) return std::nullopt;
  if (s[0] == '#') {
    const std::string_view h = std::string_view(s).substr(1);
    for (char c : h) {
      if (hexv(c) < 0) return std::nullopt;
    }
    if (h.size() == 3 || h.size() == 4) {
      Color c;
      c.r = hexv(h[0]) * 17;
      c.g = hexv(h[1]) * 17;
      c.b = hexv(h[2]) * 17;
      c.a = h.size() == 4 ? (hexv(h[3]) * 17) / 255.0 : 1.0;
      return c;
    }
    if (h.size() == 6 || h.size() == 8) {
      const auto byte = [&h](std::size_t i) { return hexv(h[i]) * 16 + hexv(h[i + 1]); };
      Color c;
      c.r = byte(0);
      c.g = byte(2);
      c.b = byte(4);
      c.a = h.size() == 8 ? byte(6) / 255.0 : 1.0;
      return c;
    }
    return std::nullopt;
  }
  if (s == "transparent") return Color{0, 0, 0, 0};
  const auto open = s.find('(');
  if (open != std::string::npos && s.back() == ')') {
    const std::string_view fn = std::string_view(s).substr(0, open);
    const auto args = split_args(std::string_view(s).substr(open + 1, s.size() - open - 2));
    if ((fn == "rgb" || fn == "rgba") && (args.size() == 3 || args.size() == 4)) {
      Color c;
      const std::array<double*, 3> ch{&c.r, &c.g, &c.b};
      for (std::size_t i = 0; i < 3; ++i) {
        std::string_view p = args[i];
        std::optional<double> v;
        if (!p.empty() && p.back() == '%') {
          v = number(p.substr(0, p.size() - 1));
          if (v) *v = *v * 255.0 / 100.0;
        } else {
          v = number(p);
        }
        if (!v) return std::nullopt;
        // Blink clamps and rounds rgb() channels to 8 bits.
        *ch.at(i) = std::round(clamp(*v, 0, 255));
      }
      if (args.size() == 4) {
        const auto a = alpha_of(args[3]);
        if (!a) return std::nullopt;
        c.a = *a;
      }
      return c;
    }
    if ((fn == "hsl" || fn == "hsla") && (args.size() == 3 || args.size() == 4)) {
      std::string_view hs = args[0];
      if (hs.size() > 3 && hs.substr(hs.size() - 3) == "deg") hs.remove_suffix(3);
      const auto h = number(hs);
      std::string_view ss = args[1];
      std::string_view ls = args[2];
      if (!ss.empty() && ss.back() == '%') ss.remove_suffix(1);
      if (!ls.empty() && ls.back() == '%') ls.remove_suffix(1);
      const auto sat = number(ss);
      const auto lig = number(ls);
      if (!h || !sat || !lig) return std::nullopt;
      const double hh = std::fmod(std::fmod(*h, 360.0) + 360.0, 360.0) / 360.0;
      const double sv = clamp(*sat / 100.0, 0, 1);
      const double lv = clamp(*lig / 100.0, 0, 1);
      const double q = lv < 0.5 ? lv * (1 + sv) : lv + sv - lv * sv;
      const double p = 2 * lv - q;
      Color c;
      c.r = std::round(hue_to_rgb(p, q, hh + 1.0 / 3) * 255);
      c.g = std::round(hue_to_rgb(p, q, hh) * 255);
      c.b = std::round(hue_to_rgb(p, q, hh - 1.0 / 3) * 255);
      if (args.size() == 4) {
        const auto a = alpha_of(args[3]);
        if (!a) return std::nullopt;
        c.a = *a;
      }
      return c;
    }
    return std::nullopt;
  }
  const auto it = std::ranges::lower_bound(kNamed, std::string_view(s), std::less<>{}, &Named::name);
  if (it != kNamed.end() && it->name == s) {
    return Color{static_cast<double>((it->rgb >> 16U) & 0xFFU), static_cast<double>((it->rgb >> 8U) & 0xFFU),
                 static_cast<double>(it->rgb & 0xFFU), 1.0};
  }
  return std::nullopt;
}

std::optional<double> parse_length_px(std::string_view in, double emPx) {
  const std::string s = lower_trim(in);
  if (s.empty()) return std::nullopt;
  std::string_view v = s;
  double scale = 1.0;
  if (v.size() > 2 && v.substr(v.size() - 2) == "px") {
    v.remove_suffix(2);
  } else if (v.size() > 2 && v.substr(v.size() - 2) == "em") {
    v.remove_suffix(2);
    scale = emPx;
  } else if (v.size() > 2 && v.substr(v.size() - 2) == "pt") {
    v.remove_suffix(2);
    scale = 4.0 / 3.0;
  }
  const auto n = number(v);
  if (!n) return std::nullopt;
  if (scale == 1.0 && s != "0" && s.find("px") == std::string::npos && *n != 0.0) return std::nullopt;
  return *n * scale;
}

std::optional<Font> parse_font(std::string_view in) {
  const std::string s(in);
  Font f;
  std::size_t i = 0;
  const auto skip_ws = [&] { while (i < s.size() && s[i] == ' ') ++i; };
  // Leading style / variant / weight / stretch keywords, up to the size token.
  for (;;) {
    skip_ws();
    std::size_t j = i;
    while (j < s.size() && s[j] != ' ') ++j;
    const std::string tok = lower_trim(std::string_view(s).substr(i, j - i));
    if (tok.empty()) return std::nullopt;
    if (tok == "italic" || tok == "oblique") { f.italic = true; i = j; continue; }
    if (tok == "normal") { i = j; continue; }
    if (tok == "small-caps") { f.smallCaps = true; i = j; continue; }
    if (tok == "bold") { f.weight = 700; i = j; continue; }
    if (tok == "bolder") { f.weight = 700; i = j; continue; }
    if (tok == "lighter") { f.weight = 100; i = j; continue; }
    if (tok == "condensed") { f.stretch = 75; i = j; continue; }
    if (tok == "semi-condensed") { f.stretch = 87.5; i = j; continue; }
    if (tok == "expanded") { f.stretch = 125; i = j; continue; }
    if (tok == "semi-expanded") { f.stretch = 112.5; i = j; continue; }
    if (tok == "ultra-condensed") { f.stretch = 50; i = j; continue; }
    if (tok == "extra-condensed") { f.stretch = 62.5; i = j; continue; }
    if (tok == "extra-expanded") { f.stretch = 150; i = j; continue; }
    if (tok == "ultra-expanded") { f.stretch = 200; i = j; continue; }
    if (tok.find_first_not_of("0123456789") == std::string::npos) {
      f.weight = std::clamp(std::stoi(tok), 1, 1000);
      i = j;
      continue;
    }
    // The size (optionally "/line-height").
    std::string sizeTok = tok;
    const auto slash = sizeTok.find('/');
    if (slash != std::string::npos) sizeTok = sizeTok.substr(0, slash);
    const auto px = parse_length_px(sizeTok, 16.0);
    if (!px || *px < 0) return std::nullopt;
    f.sizePx = *px;
    i = j;
    break;
  }
  // Family list.
  while (i < s.size()) {
    skip_ws();
    if (i >= s.size()) break;
    std::string fam;
    if (s[i] == '"' || s[i] == '\'') {
      const char q = s[i++];
      while (i < s.size() && s[i] != q) fam.push_back(s[i++]);
      if (i < s.size()) ++i;
    } else {
      while (i < s.size() && s[i] != ',') fam.push_back(s[i++]);
      while (!fam.empty() && fam.back() == ' ') fam.pop_back();
    }
    if (!fam.empty()) f.families.push_back(fam);
    skip_ws();
    if (i < s.size() && s[i] == ',') ++i;
  }
  if (f.families.empty()) return std::nullopt;
  return f;
}

std::optional<Filter> parse_filter(std::string_view in) {
  const std::string s = lower_trim(in);
  if (s == "none" || s.empty()) return Filter{};
  if (s.starts_with("blur(") && s.back() == ')') {
    const auto px = parse_length_px(std::string_view(s).substr(5, s.size() - 6), 16.0);
    if (!px || *px < 0) return std::nullopt;
    return Filter{*px};
  }
  return std::nullopt;
}

std::vector<Range> parse_unicode_range(std::string_view in) {
  std::vector<Range> out;
  const std::string s = lower_trim(in);
  std::size_t i = 0;
  while (i < s.size()) {
    while (i < s.size() && (s[i] == ' ' || s[i] == ',')) ++i;
    if (i + 2 > s.size() || s[i] != 'u' || s[i + 1] != '+') break;
    i += 2;
    const auto hex = [&](char32_t& v) {
      v = 0;
      bool any = false;
      while (i < s.size() && hexv(s[i]) >= 0) {
        v = v * 16 + static_cast<char32_t>(hexv(s[i]));
        ++i;
        any = true;
      }
      return any;
    };
    Range r;
    if (!hex(r.lo)) break;
    r.hi = r.lo;
    if (i < s.size() && s[i] == '-') {
      ++i;
      if (!hex(r.hi)) break;
    }
    out.push_back(r);
  }
  return out;
}

}  // namespace premation::raster::css
