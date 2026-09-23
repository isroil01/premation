#include "paint_common.hpp"

#include <algorithm>
#include <array>
#include <cstdio>

#include "numconv.hpp"

namespace premation::raster {
namespace {

struct Rgba {
  double r = 0, g = 0, b = 0, a = 255;
};

double clamp255(double n) { return std::max(0.0, std::min(255.0, js_round(n))); }

/// fill.ts parseHex (the TS painters' own colour reader, NOT the canvas's).
Rgba parse_hex(std::string_view in) {
  std::string raw(in);
  while (!raw.empty() && raw.front() == ' ') raw.erase(raw.begin());
  while (!raw.empty() && raw.back() == ' ') raw.pop_back();
  std::string low = raw;
  for (char& c : low) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  if ((low.starts_with("rgb(") || low.starts_with("rgba(")) && low.back() == ')') {
    const auto open = low.find('(');
    const std::string body = low.substr(open + 1, low.size() - open - 2);
    std::vector<double> parts;
    std::string cur;
    const auto flush = [&] {
      if (!cur.empty()) parts.push_back(motion::js::string_to_number(std::string_view(cur)));
      cur.clear();
    };
    for (const char c : body) {
      if (c == ',' || c == ' ' || c == '/' || c == '\t') flush();
      else cur.push_back(c);
    }
    flush();
    if (parts.size() >= 3 && std::isfinite(parts[0]) && std::isfinite(parts[1]) && std::isfinite(parts[2])) {
      const double alpha = parts.size() > 3 && std::isfinite(parts[3]) ? parts[3] : 1.0;
      return {clamp255(parts[0]), clamp255(parts[1]), clamp255(parts[2]), clamp255(std::max(0.0, std::min(1.0, alpha)) * 255)};
    }
    return {0, 0, 0, 255};
  }
  std::string h = raw;
  if (!h.empty() && h.front() == '#') h.erase(h.begin());
  if (h.size() == 3) h = std::string{h[0], h[0], h[1], h[1], h[2], h[2]};
  if (h.size() == 6) h += "ff";
  if (h.size() != 8) return {0, 0, 0, 255};
  std::array<unsigned, 4> v{};
  for (std::size_t i = 0; i < 8; ++i) {
    const char c = static_cast<char>(std::tolower(static_cast<unsigned char>(h[i])));
    int d = -1;
    if (c >= '0' && c <= '9') d = c - '0';
    else if (c >= 'a' && c <= 'f') d = c - 'a' + 10;
    if (d < 0) return {0, 0, 0, 255};
    v[i / 2] = v[i / 2] * 16 + static_cast<unsigned>(d);  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
  }
  return {static_cast<double>(v[0]), static_cast<double>(v[1]), static_cast<double>(v[2]), static_cast<double>(v[3])};
}

std::string to_rgba_string(const Rgba& c) {
  return "rgba(" + motion::js::number_to_string(js_round(c.r)) + ", " + motion::js::number_to_string(js_round(c.g)) + ", " +
         motion::js::number_to_string(js_round(c.b)) + ", " + motion::js::to_fixed(c.a / 255.0, 3) + ")";
}

}  // namespace

std::optional<Style> color_style(std::string_view css) {
  const auto c = css::parse_color(css);
  if (!c) return std::nullopt;
  Style s;
  s.kind = Style::Kind::color;
  s.color = *c;
  return s;
}

std::optional<FillPaint> read_fill_paint(const json::Value& v) {
  if (!v.is_object()) return std::nullopt;
  const std::string_view t = v["type"].str_or("");
  FillPaint p;
  if (t == "solid") p.type = FillPaint::Type::solid;
  else if (t == "linear") p.type = FillPaint::Type::linear;
  else if (t == "radial") p.type = FillPaint::Type::radial;
  else return std::nullopt;
  p.color = v["color"].str();
  p.angle = v["angle"].num(0);
  p.cx = v["cx"].num(0.5);
  p.cy = v["cy"].num(0.5);
  p.radius = v["radius"].num(0.5);
  for (const auto& s : v["stops"].items()) p.stops.push_back({s["offset"].num(0), s["color"].str()});
  for (const auto& s : v["opacityStops"].items()) p.opacityStops.push_back({s["offset"].num(0), s["opacity"].num(1)});
  std::ranges::stable_sort(p.stops, {}, &ColorStop::offset);
  std::ranges::stable_sort(p.opacityStops, {}, &OpacityStop::offset);
  p.composite = v["composite"].str();
  p.blendMode = v["blendMode"].str();
  return p;
}

std::string sample_gradient_color(const std::vector<ColorStop>& s, double t) {
  if (s.empty()) return "rgba(0, 0, 0, 1.000)";
  if (s.size() == 1) return to_rgba_string(parse_hex(s[0].color));
  const double x = clamp01(t);
  if (x <= s[0].offset) return to_rgba_string(parse_hex(s[0].color));
  if (x >= s.back().offset) return to_rgba_string(parse_hex(s.back().color));
  for (std::size_t i = 0; i + 1 < s.size(); ++i) {
    const auto& a = s[i];
    const auto& b = s[i + 1];
    if (x >= a.offset && x <= b.offset) {
      const double span = b.offset - a.offset;
      const double f = span <= 0 ? 0 : (x - a.offset) / span;
      const Rgba ca = parse_hex(a.color);
      const Rgba cb = parse_hex(b.color);
      return to_rgba_string({ca.r + (cb.r - ca.r) * f, ca.g + (cb.g - ca.g) * f, ca.b + (cb.b - ca.b) * f,
                             ca.a + (cb.a - ca.a) * f});
    }
  }
  return to_rgba_string(parse_hex(s.back().color));
}

double sample_gradient_opacity(const std::vector<OpacityStop>& s, double t) {
  if (s.empty()) return 1;
  if (t <= s[0].offset) return s[0].opacity;
  if (t >= s.back().offset) return s.back().opacity;
  for (std::size_t i = 0; i + 1 < s.size(); ++i) {
    const auto& a = s[i];
    const auto& b = s[i + 1];
    if (t >= a.offset && t <= b.offset) {
      const double span = b.offset - a.offset;
      const double u = span == 0 ? 0 : (t - a.offset) / span;
      return a.opacity + (b.opacity - a.opacity) * u;
    }
  }
  return s.back().opacity;
}

std::string apply_alpha(std::string_view color, double opacity) {
  const Rgba c = parse_hex(color);
  const double a = std::max(0.0, std::min(255.0, js_round(c.a * clamp01(opacity))));
  const auto h = [](double v) {
    std::array<char, 8> buf{};
    std::snprintf(buf.data(), buf.size(), "%02x", static_cast<unsigned>(js_round(v)));  // NOLINT(cppcoreguidelines-pro-type-vararg)
    return std::string(buf.data());
  };
  return "#" + h(c.r) + h(c.g) + h(c.b) + h(a);
}

std::vector<Gradient::Stop> gradient_stops(const FillPaint& paint) {
  std::vector<Gradient::Stop> out;
  const auto add = [&out](double off, std::string_view color) {
    if (const auto c = css::parse_color(color)) out.push_back({off, *c});
  };
  if (paint.opacityStops.empty()) {
    for (const auto& s : paint.stops) add(clamp01(s.offset), s.color);
    return out;
  }
  // [...new Set([...colors, ...alphas])].map(clamp01).sort
  std::vector<double> offsets;
  for (const auto& s : paint.stops) {
    if (std::ranges::find(offsets, s.offset) == offsets.end()) offsets.push_back(s.offset);
  }
  for (const auto& s : paint.opacityStops) {
    if (std::ranges::find(offsets, s.offset) == offsets.end()) offsets.push_back(s.offset);
  }
  for (double& o : offsets) o = clamp01(o);
  std::ranges::stable_sort(offsets);
  for (const double off : offsets) add(off, apply_alpha(sample_gradient_color(paint.stops, off), sample_gradient_opacity(paint.opacityStops, off)));
  return out;
}

Style make_canvas_gradient(const FillPaint& paint, double w, double h, double ox, double oy) {
  auto g = std::make_shared<Gradient>();
  if (paint.type == FillPaint::Type::linear) {
    const double a = (paint.angle * kJsPi) / 180;
    const double dx = js_cos(a);
    const double dy = js_sin(a);
    const double half = (std::fabs(dx) * w + std::fabs(dy) * h) / 2;
    g->kind = Gradient::Kind::linear;
    g->p[0] = ox - dx * half;
    g->p[1] = oy - dy * half;
    g->p[2] = ox + dx * half;
    g->p[3] = oy + dy * half;
  } else {
    const double cx = ox + (paint.cx - 0.5) * w;
    const double cy = oy + (paint.cy - 0.5) * h;
    const double r = (std::max(0.01, paint.radius) * js_hypot(w, h)) / 2;
    g->kind = Gradient::Kind::radial;
    g->p[0] = cx;
    g->p[1] = cy;
    g->p[2] = 0;
    g->p[3] = cx;
    g->p[4] = cy;
    g->p[5] = r;
  }
  for (const auto& s : gradient_stops(paint)) g->add_stop(s.offset, s.color);
  Style st;
  st.kind = Style::Kind::gradient;
  st.gradient = std::move(g);
  return st;
}

}  // namespace premation::raster
