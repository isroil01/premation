// AppTextureProvider.rasterizeSvg's sizing, ported line for line (svg_render.hpp).

#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>

#include "svg_render.hpp"

namespace premation::raster::svg {
namespace {

constexpr double kRasterMax = 4096;    // AppTextureProvider RASTER_MAX
constexpr double kSvgTargetLong = 2048;  // rasterizeSvg SVG_TARGET_LONG

bool js_space(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f'; }

/// JavaScript parseFloat: the longest numeric prefix after leading whitespace.
double js_parse_float(std::string_view s) {
  while (!s.empty() && js_space(s.front())) s.remove_prefix(1);
  std::size_t i = 0;
  if (i < s.size() && (s[i] == '+' || s[i] == '-')) ++i;
  if (s.substr(i).starts_with("Infinity")) return s[0] == '-' ? -HUGE_VAL : HUGE_VAL;
  const std::size_t digits0 = i;
  while (i < s.size() && s[i] >= '0' && s[i] <= '9') ++i;
  bool any = i > digits0;
  if (i < s.size() && s[i] == '.') {
    std::size_t j = i + 1;
    while (j < s.size() && s[j] >= '0' && s[j] <= '9') ++j;
    any = any || j > i + 1;
    i = j;
  }
  if (!any) return std::nan("");
  if (i < s.size() && (s[i] == 'e' || s[i] == 'E')) {
    std::size_t j = i + 1;
    if (j < s.size() && (s[j] == '+' || s[j] == '-')) ++j;
    const std::size_t e0 = j;
    while (j < s.size() && s[j] >= '0' && s[j] <= '9') ++j;
    if (j > e0) i = j;
  }
  std::string_view num = s.substr(0, i);
  if (num.starts_with('+')) num.remove_prefix(1);
  double v = 0;
  (void)std::from_chars(num.data(), num.data() + num.size(), v);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  return v;
}

/// JavaScript Number(token) for a token without whitespace.
double js_number(std::string_view s) {
  if (s.empty()) return 0;
  if (s == "Infinity" || s == "+Infinity") return HUGE_VAL;
  if (s == "-Infinity") return -HUGE_VAL;
  if (s.size() > 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X' || s[1] == 'o' || s[1] == 'O' || s[1] == 'b' || s[1] == 'B')) {
    const int base = s[1] == 'x' || s[1] == 'X' ? 16 : s[1] == 'o' || s[1] == 'O' ? 8 : 2;
    std::uint64_t u = 0;
    const auto r = std::from_chars(s.data() + 2, s.data() + s.size(), u, base);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    if (r.ec != std::errc() || r.ptr != s.data() + s.size()) return std::nan("");  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    return static_cast<double>(u);
  }
  std::string_view t = s;
  if (t.starts_with('+')) t.remove_prefix(1);
  double v = 0;
  const auto r = std::from_chars(t.data(), t.data() + t.size(), v);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  if (r.ec != std::errc() || r.ptr != t.data() + t.size()) return std::nan("");  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  return v;
}

/// String.prototype.split(/[\s,]+/).
std::vector<std::string_view> js_split_ws_comma(std::string_view s) {
  std::vector<std::string_view> out;
  std::size_t start = 0;
  std::size_t i = 0;
  while (i < s.size()) {
    if (js_space(s[i]) || s[i] == ',') {
      out.push_back(s.substr(start, i - start));
      while (i < s.size() && (js_space(s[i]) || s[i] == ',')) ++i;
      start = i;
    } else {
      ++i;
    }
  }
  out.push_back(s.substr(start));
  return out;
}

/// Math.round.
double js_round(double v) { return std::floor(v + 0.5); }

std::string fmt(double v) {
  std::array<char, 32> b{};
  const auto r = std::to_chars(b.data(), b.data() + b.size(), v);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  return {b.data(), r.ptr};
}

/// decodeURIComponent: false on a malformed escape (the TS then throws).
bool decode_uri_component(std::string_view in, std::string& out) {
  out.clear();
  for (std::size_t i = 0; i < in.size(); ++i) {
    if (in[i] != '%') {
      out.push_back(in[i]);
      continue;
    }
    if (i + 2 >= in.size()) return false;
    const auto hv = [](char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1; };
    const int hi = hv(in[i + 1]);
    const int lo = hv(in[i + 2]);
    if (hi < 0 || lo < 0) return false;
    out.push_back(static_cast<char>(hi * 16 + lo));
    i += 2;
  }
  return true;
}

}  // namespace

std::optional<std::string> svg_markup_from_data_url(std::string_view src) {
  // decodeSvgDataUrl: base64 → UTF-8 bytes; otherwise decodeURIComponent.
  const std::size_t comma = src.find(',');
  if (!src.starts_with("data:") || comma == std::string_view::npos) return std::nullopt;
  std::string meta(src.substr(0, comma));
  for (char& c : meta) c = c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c;
  const std::string_view body = src.substr(comma + 1);
  if (meta.find(";base64") != std::string::npos) {
    const auto bytes = base64_decode(body);
    if (!bytes) return std::nullopt;
    return std::string(bytes->begin(), bytes->end());
  }
  std::string out;
  if (!decode_uri_component(body, out)) return std::nullopt;
  return out;
}

RasterOutput rasterize_svg(std::string_view markup, const RasterizeOptions& opts) {
  RasterOutput out;
  Document doc;
  std::string error;
  if (!parse_xml(markup, doc, error)) {
    out.error = "SVG did not parse: " + error;
    return out;
  }
  Node& svg = doc.nodes[static_cast<std::size_t>(doc.root)];
  if (!svg.svgNs || svg.name != "svg") {
    out.error = "SVG image: the root is not an <svg> element";
    return out;
  }
  const auto parse_len = [&svg](std::string_view a) {
    const std::string* v = svg.attr(a);
    if (v == nullptr || v->empty()) return 0.0;
    const double n = js_parse_float(*v);
    return std::isfinite(n) && n > 0 ? n : 0.0;
  };
  double w = parse_len("width");
  double h = parse_len("height");
  const std::string* vbAttr = svg.attr("viewBox");
  const auto vb = js_split_ws_comma(vbAttr != nullptr ? std::string_view(*vbAttr) : std::string_view());
  const auto vbn = [&vb](std::size_t i) {
    const double v = js_number(vb[i]);
    return v > 0 ? v : 0.0;  // NaN > 0 is false
  };
  const double vbW = vb.size() == 4 ? vbn(2) : 0.0;
  const double vbH = vb.size() == 4 ? vbn(3) : 0.0;
  if ((w == 0 || h == 0) && vbW != 0 && vbH != 0) {
    if (w != 0 && h == 0) h = (w * vbH) / vbW;
    else if (h != 0 && w == 0) w = (h * vbW) / vbH;
    else {
      w = vbW;
      h = vbH;
    }
  }
  if (w == 0 || h == 0) {
    w = 512;
    h = 512;
  }
  const double longEdge = std::max(w, h);
  const double targetLong = std::min(kRasterMax, std::max(longEdge, kSvgTargetLong));
  const double scale = targetLong / longEdge;
  const double rw = std::max(1.0, std::min(kRasterMax, js_round(w * scale)));
  const double rh = std::max(1.0, std::min(kRasterMax, js_round(h * scale)));
  svg.set_attr("width", fmt(rw));
  svg.set_attr("height", fmt(rh));
  if ((vbAttr == nullptr || vbAttr->empty()) && vbW == 0) svg.set_attr("viewBox", "0 0 " + fmt(w) + " " + fmt(h));

  std::string extra;
  if (opts.fillColor && !opts.fillColor->empty() && *opts.fillColor != "none" && *opts.fillColor != "transparent") {
    extra = "path, circle, rect, polygon, polyline, ellipse, text { fill: " + *opts.fillColor + " !important; }";
  }
  expand_uses(doc);
  std::vector<Style> styles;
  compute_styles(doc, extra, styles, out.unsupported);
  const auto W = static_cast<std::uint32_t>(rw);
  const auto H = static_cast<std::uint32_t>(rh);
  if (!render_document(doc, styles, W, H, opts, out.rgba, out.unsupported, error)) {
    out.error = error.empty() ? "SVG render failed" : error;
    return out;
  }
  out.width = W;
  out.height = H;
  out.ok = true;
  return out;
}

}  // namespace premation::raster::svg
