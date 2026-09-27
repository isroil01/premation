#include "svg_shapes.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <functional>
#include <limits>
#include <numbers>
#include <set>
#include <utility>
#include <vector>

#include "canvas.hpp"
#include "css.hpp"
#include "json.hpp"
#include "svg_doc.hpp"

namespace premation::scene {
namespace {

namespace sv = raster::svg;
using js::Json;
using raster::Mat2D;

/// The circle-arc Bézier handle length (4/3·tan(π/8)).
constexpr double kKappa = 0.5522847498307936;

struct P {
  double x = 0, y = 0;
};
P apply(const Mat2D& m, double x, double y) { return {m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f}; }

std::string num_str(double v) { return js::number_to_string(v); }

/// A CSS colour string for a parsed colour with an extra alpha factor.
std::string css_color(const raster::css::Color& c, double alphaMul) {
  const double a = std::clamp(c.a * alphaMul, 0.0, 1.0);
  if (a <= 0) return "transparent";
  const auto ch = [](double v) { return num_str(std::round(std::clamp(v, 0.0, 255.0))); };
  if (a >= 1) return "rgb(" + ch(c.r) + ", " + ch(c.g) + ", " + ch(c.b) + ")";
  return "rgba(" + ch(c.r) + ", " + ch(c.g) + ", " + ch(c.b) + ", " + num_str(a) + ")";
}

/// Path segments in user units → Bézier runs (anchors with absolute handles).
std::vector<doc::GeoRun> runs_of(const std::vector<sv::PathSeg>& segs) {
  std::vector<doc::GeoRun> runs;
  doc::GeoRun cur;
  cur.closed = false;
  P start;
  const auto flush = [&]() {
    if (cur.points.size() >= 2 || (cur.closed && !cur.points.empty())) runs.push_back(cur);
    cur = doc::GeoRun{};
    cur.closed = false;
  };
  const auto anchor = [](double x, double y) { return doc::GeoPt{x, y, x, y, x, y}; };
  for (const sv::PathSeg& s : segs) {
    const auto p = [&s](std::size_t i) { return static_cast<double>(s.p[i]); };
    switch (s.op) {
      case sv::PathSeg::Op::move:
        flush();
        start = {p(0), p(1)};
        cur.points.push_back(anchor(p(0), p(1)));
        break;
      case sv::PathSeg::Op::line:
        if (cur.points.empty()) cur.points.push_back(anchor(start.x, start.y));
        cur.points.push_back(anchor(p(0), p(1)));
        break;
      case sv::PathSeg::Op::cubic:
        if (cur.points.empty()) cur.points.push_back(anchor(start.x, start.y));
        cur.points.back().outX = p(0);
        cur.points.back().outY = p(1);
        cur.points.push_back(doc::GeoPt{p(4), p(5), p(2), p(3), p(4), p(5)});
        break;
      case sv::PathSeg::Op::close:
        if (cur.points.size() >= 2) {
          const doc::GeoPt& first = cur.points.front();
          const doc::GeoPt& last = cur.points.back();
          if (std::abs(first.x - last.x) < 1e-6 && std::abs(first.y - last.y) < 1e-6) {
            // The closing segment ends on the start: its handle belongs to the first anchor.
            cur.points.front().inX = last.inX;
            cur.points.front().inY = last.inY;
            cur.points.pop_back();
          }
        }
        cur.closed = true;
        flush();
        break;
    }
  }
  flush();
  return runs;
}

struct Viewport {
  double w = 0, h = 0;
};

class Walker {
 public:
  Walker(const sv::Document& d, const std::vector<sv::Style>& styles, doc::SvgShapes& out)
      : doc_(d), styles_(styles), out_(out) {}

  void walk(int i, const Mat2D& ctm, double opacity, const Viewport& vp) {
    const sv::Node& n = doc_.nodes[static_cast<std::size_t>(i)];
    if (!n.element || !n.svgNs) return;
    const sv::Style& s = styles_[static_cast<std::size_t>(i)];
    if (s.displayNone) return;
    static const std::set<std::string, std::less<>> kSkip = {"defs", "clipPath", "mask", "marker", "pattern", "symbol",
                                                             "linearGradient", "radialGradient", "style", "title",
                                                             "desc", "metadata", "filter", "script", "foreignObject"};
    static const std::set<std::string, std::less<>> kAnim = {"animate", "animateTransform", "animateMotion", "set"};
    if (kAnim.contains(n.name)) {
      notes_.insert("SVG animation (SMIL) — the editor's Convert to Editable Shapes keys it");
      return;
    }
    // A <symbol> is drawn only as a <use>'s clone (expand_uses keeps its tag).
    if (kSkip.contains(n.name) && !(n.name == "symbol" && n.shadow)) return;
    Mat2D m = ctm;
    if (const std::string* t = n.attr("transform")) {
      if (const auto tm = sv::parse_transform(*t)) m = m * *tm;
    }
    if (!s.clipPath.empty() || !s.mask.empty()) {
      notes_.insert("clip paths and masks (not cut into the shapes)");
    }
    if (!s.filter.empty() || s.filterUnsupported) notes_.insert("filters");
    const double op = opacity * s.opacity;
    if (n.name == "use") {
      m = m * Mat2D{1, 0, 0, 1, len(i, "x", 0, vp.w), len(i, "y", 0, vp.h)};
      for (const int c : n.children) walk(c, m, op, vp);
      return;
    }
    if (n.name == "svg" || n.name == "symbol") {
      // A nested viewport: x / y, then its viewBox onto width × height.
      const double w = len(i, "width", vp.w, vp.w);
      const double h = len(i, "height", vp.h, vp.h);
      if (n.name == "svg") m = m * Mat2D{1, 0, 0, 1, len(i, "x", 0, vp.w), len(i, "y", 0, vp.h)};
      Viewport inner{w, h};
      if (const std::string* vbv = n.attr("viewBox")) {
        if (const auto vb = sv::parse_view_box(*vbv)) {
          const std::string* par = n.attr("preserveAspectRatio");
          m = m * sv::view_box_transform(*vb, sv::parse_aspect_ratio(par != nullptr ? *par : ""), w, h);
          inner = {vb->w, vb->h};
        }
      }
      for (const int c : n.children) walk(c, m, op, inner);
      return;
    }
    if (n.name == "text") {
      text(i, m, op, vp);
      return;
    }
    if (n.name == "image") {
      image(i, m, op, vp);
      return;
    }
    if (n.name == "g" || n.name == "a" || n.name == "switch") {
      for (const int c : n.children) walk(c, m, op, vp);
      return;
    }
    shape(i, m, op, vp);
  }

  std::set<std::string> notes_;

 private:
  [[nodiscard]] double len(int i, std::string_view attr, double def, double ref) const {
    const std::string* v = doc_.nodes[static_cast<std::size_t>(i)].attr(attr);
    if (v == nullptr) return def;
    const auto l = sv::parse_length(*v);
    if (!l) return def;
    return sv::resolve(*l, ref, styles_[static_cast<std::size_t>(i)].fontSizePx);
  }

  std::string name_of(int i, std::string_view kind) {
    const sv::Node& n = doc_.nodes[static_cast<std::size_t>(i)];
    if (const std::string* id = n.attr("id"); id != nullptr && !id->empty()) return *id;
    return std::string(kind) + " " + std::to_string(++counter_);
  }

  /// A shape element's segments in user units.
  std::vector<sv::PathSeg> segments(int i, const Viewport& vp) const {
    const sv::Node& n = doc_.nodes[static_cast<std::size_t>(i)];
    std::vector<sv::PathSeg> out;
    const auto f = [](double v) { return static_cast<float>(v); };
    const auto seg = [&](sv::PathSeg::Op op, std::array<float, 6> p) {
      sv::PathSeg s;
      s.op = op;
      s.p = p;
      out.push_back(s);
    };
    const auto ellipse = [&](double cx, double cy, double rx, double ry) {
      const double kx = rx * kKappa;
      const double ky = ry * kKappa;
      seg(sv::PathSeg::Op::move, {f(cx + rx), f(cy), 0, 0, 0, 0});
      seg(sv::PathSeg::Op::cubic, {f(cx + rx), f(cy + ky), f(cx + kx), f(cy + ry), f(cx), f(cy + ry)});
      seg(sv::PathSeg::Op::cubic, {f(cx - kx), f(cy + ry), f(cx - rx), f(cy + ky), f(cx - rx), f(cy)});
      seg(sv::PathSeg::Op::cubic, {f(cx - rx), f(cy - ky), f(cx - kx), f(cy - ry), f(cx), f(cy - ry)});
      seg(sv::PathSeg::Op::cubic, {f(cx + kx), f(cy - ry), f(cx + rx), f(cy - ky), f(cx + rx), f(cy)});
      seg(sv::PathSeg::Op::close, {});
    };
    if (n.name == "path") {
      if (const std::string* d = n.attr("d")) out = sv::parse_path_data(*d);
    } else if (n.name == "rect") {
      const double x = len(i, "x", 0, vp.w);
      const double y = len(i, "y", 0, vp.h);
      const double w = len(i, "width", 0, vp.w);
      const double h = len(i, "height", 0, vp.h);
      if (!(w > 0) || !(h > 0)) return out;
      double rx = len(i, "rx", -1, vp.w);
      double ry = len(i, "ry", -1, vp.h);
      if (rx < 0 && ry < 0) rx = ry = 0;
      else if (rx < 0) rx = ry;
      else if (ry < 0) ry = rx;
      rx = std::min(rx, w / 2);
      ry = std::min(ry, h / 2);
      if (rx > 0 && ry > 0) {
        const double kx = rx * (1 - kKappa);
        const double ky = ry * (1 - kKappa);
        seg(sv::PathSeg::Op::move, {f(x + rx), f(y), 0, 0, 0, 0});
        seg(sv::PathSeg::Op::line, {f(x + w - rx), f(y), 0, 0, 0, 0});
        seg(sv::PathSeg::Op::cubic, {f(x + w - kx), f(y), f(x + w), f(y + ky), f(x + w), f(y + ry)});
        seg(sv::PathSeg::Op::line, {f(x + w), f(y + h - ry), 0, 0, 0, 0});
        seg(sv::PathSeg::Op::cubic, {f(x + w), f(y + h - ky), f(x + w - kx), f(y + h), f(x + w - rx), f(y + h)});
        seg(sv::PathSeg::Op::line, {f(x + rx), f(y + h), 0, 0, 0, 0});
        seg(sv::PathSeg::Op::cubic, {f(x + kx), f(y + h), f(x), f(y + h - ky), f(x), f(y + h - ry)});
        seg(sv::PathSeg::Op::line, {f(x), f(y + ry), 0, 0, 0, 0});
        seg(sv::PathSeg::Op::cubic, {f(x), f(y + ky), f(x + kx), f(y), f(x + rx), f(y)});
      } else {
        seg(sv::PathSeg::Op::move, {f(x), f(y), 0, 0, 0, 0});
        seg(sv::PathSeg::Op::line, {f(x + w), f(y), 0, 0, 0, 0});
        seg(sv::PathSeg::Op::line, {f(x + w), f(y + h), 0, 0, 0, 0});
        seg(sv::PathSeg::Op::line, {f(x), f(y + h), 0, 0, 0, 0});
      }
      seg(sv::PathSeg::Op::close, {});
    } else if (n.name == "circle") {
      const double r = len(i, "r", 0, std::sqrt((vp.w * vp.w + vp.h * vp.h) / 2));
      if (r > 0) ellipse(len(i, "cx", 0, vp.w), len(i, "cy", 0, vp.h), r, r);
    } else if (n.name == "ellipse") {
      double rx = len(i, "rx", -1, vp.w);
      double ry = len(i, "ry", -1, vp.h);
      if (rx < 0 && ry >= 0) rx = ry;
      if (ry < 0 && rx >= 0) ry = rx;
      if (rx > 0 && ry > 0) ellipse(len(i, "cx", 0, vp.w), len(i, "cy", 0, vp.h), rx, ry);
    } else if (n.name == "line") {
      seg(sv::PathSeg::Op::move, {f(len(i, "x1", 0, vp.w)), f(len(i, "y1", 0, vp.h)), 0, 0, 0, 0});
      seg(sv::PathSeg::Op::line, {f(len(i, "x2", 0, vp.w)), f(len(i, "y2", 0, vp.h)), 0, 0, 0, 0});
    } else if (n.name == "polyline" || n.name == "polygon") {
      if (const std::string* pts = n.attr("points")) {
        const auto list = sv::parse_points(*pts);
        for (std::size_t k = 0; k < list.size(); ++k) {
          seg(k == 0 ? sv::PathSeg::Op::move : sv::PathSeg::Op::line, {list[k][0], list[k][1], 0, 0, 0, 0});
        }
        if (n.name == "polygon" && !list.empty()) seg(sv::PathSeg::Op::close, {});
      }
    }
    return out;
  }

  struct Gradient {
    Json paint;
    std::string first = "transparent";
  };

  /// A url() paint's gradient as FillPaint (sceneInsert.ts parsedGradientToFillPaint).
  std::optional<Gradient> gradient(const std::string& id, const P& bbMin, const P& bbMax) {
    const int g = doc_.by_id(id);
    if (g < 0) return std::nullopt;
    const sv::Node& gn = doc_.nodes[static_cast<std::size_t>(g)];
    if (gn.name != "linearGradient" && gn.name != "radialGradient") {
      notes_.insert("pattern fills");
      return std::nullopt;
    }
    // Stops: its own, else the referenced gradient's (one href hop, as far as the file uses).
    int stopsOf = g;
    const auto has_stops = [this](int e) {
      for (const int c : doc_.nodes[static_cast<std::size_t>(e)].children) {
        if (doc_.nodes[static_cast<std::size_t>(c)].name == "stop") return true;
      }
      return false;
    };
    if (!has_stops(g)) {
      if (const std::string* h = doc_.href(g); h != nullptr && h->size() > 1 && (*h)[0] == '#') {
        const int r = doc_.by_id(std::string_view(*h).substr(1));
        if (r >= 0) stopsOf = r;
      }
    }
    Gradient out;
    Json stops = Json::array();
    Json opacityStops = Json::array();
    bool ramp = false;
    int k = 0;
    double last = 0;
    for (const int c : doc_.nodes[static_cast<std::size_t>(stopsOf)].children) {
      const sv::Node& sn = doc_.nodes[static_cast<std::size_t>(c)];
      if (sn.name != "stop") continue;
      const sv::Style& ss = styles_[static_cast<std::size_t>(c)];
      double off = 0;
      if (const std::string* o = sn.attr("offset")) {
        if (const auto l = sv::parse_length(*o)) off = l->unit == sv::Unit::percent ? l->v / 100 : l->v;
      }
      off = std::max(last, std::clamp(off, 0.0, 1.0));
      last = off;
      Json st = Json::object();
      st.set("id", Json::string("stop_" + std::to_string(k)));
      st.set("offset", Json::number(off));
      st.set("color", Json::string(css_color(ss.stopColor, 1)));
      stops.arr_mut().push_back(std::move(st));
      Json os = Json::object();
      os.set("id", Json::string("op_" + std::to_string(k)));
      os.set("offset", Json::number(off));
      os.set("opacity", Json::number(ss.stopOpacity));
      opacityStops.arr_mut().push_back(std::move(os));
      if (ss.stopOpacity < 1) ramp = true;
      if (k == 0) out.first = css_color(ss.stopColor, ss.stopOpacity);
      ++k;
    }
    if (k == 0) return std::nullopt;
    const bool userSpace = gn.attr("gradientUnits") != nullptr && *gn.attr("gradientUnits") == "userSpaceOnUse";
    const double bw = std::max(1e-9, bbMax.x - bbMin.x);
    const double bh = std::max(1e-9, bbMax.y - bbMin.y);
    const auto frac = [&](std::string_view attr, double def, bool xAxis) {
      const std::string* v = gn.attr(attr);
      if (v == nullptr) return def;
      const auto l = sv::parse_length(*v);
      if (!l) return def;
      const double raw = l->unit == sv::Unit::percent ? l->v / 100 : l->v;
      if (!userSpace || l->unit == sv::Unit::percent) return raw;
      return xAxis ? (raw - bbMin.x) / bw : (raw - bbMin.y) / bh;
    };
    Json paint = Json::object();
    if (gn.name == "radialGradient") {
      paint.set("type", Json::string("radial"));
      paint.set("cx", Json::number(frac("cx", 0.5, true)));
      paint.set("cy", Json::number(frac("cy", 0.5, false)));
      double r = 0.5;
      if (const std::string* v = gn.attr("r")) {
        if (const auto l = sv::parse_length(*v)) r = l->unit == sv::Unit::percent ? l->v / 100 : (userSpace ? l->v / std::max(bw, bh) : l->v);
      }
      paint.set("radius", Json::number(r));
    } else {
      const double x1 = frac("x1", 0, true);
      const double y1 = frac("y1", 0, false);
      const double x2 = frac("x2", 1, true);
      const double y2 = frac("y2", 0, false);
      paint.set("type", Json::string("linear"));
      paint.set("angle", Json::number(std::atan2(y2 - y1, x2 - x1) * 180 / std::numbers::pi));
    }
    paint.set("stops", std::move(stops));
    if (ramp) paint.set("opacityStops", std::move(opacityStops));
    if (gn.attr("gradientTransform") != nullptr) notes_.insert("gradient transforms");
    out.paint = std::move(paint);
    return out;
  }

  /// A paint → (CSS colour, FillPaint or undefined).
  std::pair<std::string, Json> paint_of(const sv::Paint& p, double opacity, const sv::Style& s, const P& bbMin, const P& bbMax) {
    switch (p.kind) {
      case sv::Paint::Kind::none: return {"transparent", Json()};
      case sv::Paint::Kind::color: return {css_color(p.color, opacity), Json()};
      case sv::Paint::Kind::current: return {css_color(s.color, opacity), Json()};
      case sv::Paint::Kind::url:
        if (auto g = gradient(p.url, bbMin, bbMax)) return {g->first, std::move(g->paint)};
        if (p.fallback == sv::Paint::Kind::color) return {css_color(p.fallbackColor, opacity), Json()};
        if (p.fallback == sv::Paint::Kind::current) return {css_color(s.color, opacity), Json()};
        return {"transparent", Json()};
    }
    return {"transparent", Json()};
  }

  void shape(int i, const Mat2D& m, double opacity, const Viewport& vp) {
    const sv::Style& s = styles_[static_cast<std::size_t>(i)];
    const std::vector<sv::PathSeg> segs = segments(i, vp);
    if (segs.empty() || s.hidden) return;
    std::vector<doc::GeoRun> runs = runs_of(segs);
    if (runs.empty()) return;
    // The user-space box (objectBoundingBox gradients), then the viewport.
    P uMin{std::numeric_limits<double>::infinity(), std::numeric_limits<double>::infinity()};
    P uMax{-uMin.x, -uMin.y};
    for (const doc::GeoRun& r : runs) {
      for (const doc::GeoPt& p : r.points) {
        uMin = {std::min(uMin.x, p.x), std::min(uMin.y, p.y)};
        uMax = {std::max(uMax.x, p.x), std::max(uMax.y, p.y)};
      }
    }
    P vMin{std::numeric_limits<double>::infinity(), std::numeric_limits<double>::infinity()};
    P vMax{-vMin.x, -vMin.y};
    for (doc::GeoRun& r : runs) {
      for (doc::GeoPt& p : r.points) {
        const P a = apply(m, p.x, p.y);
        const P in = apply(m, p.inX, p.inY);
        const P out = apply(m, p.outX, p.outY);
        p = doc::GeoPt{a.x, a.y, in.x, in.y, out.x, out.y};
        vMin = {std::min(vMin.x, a.x), std::min(vMin.y, a.y)};
        vMax = {std::max(vMax.x, a.x), std::max(vMax.y, a.y)};
      }
    }
    doc::SvgPart part;
    part.kind = doc::SvgPart::Kind::path;
    part.name = name_of(i, "Path");
    part.centerX = (vMin.x + vMax.x) / 2;
    part.centerY = (vMin.y + vMax.y) / 2;
    part.width = std::max(1.0, vMax.x - vMin.x);
    part.height = std::max(1.0, vMax.y - vMin.y);
    for (doc::GeoRun& r : runs) {
      for (doc::GeoPt& p : r.points) {
        p.x -= part.centerX;
        p.inX -= part.centerX;
        p.outX -= part.centerX;
        p.y -= part.centerY;
        p.inY -= part.centerY;
        p.outY -= part.centerY;
      }
    }
    part.runs = std::move(runs);
    auto [fill, fillPaint] = paint_of(s.fill, s.fillOpacity, s, uMin, uMax);
    part.fill = std::move(fill);
    part.fillPaint = std::move(fillPaint);
    if (s.stroke.kind != sv::Paint::Kind::none) {
      auto [strokeColor, strokePaint] = paint_of(s.stroke, 1, s, uMin, uMax);
      if (!strokePaint.is_undefined()) notes_.insert("gradient strokes (their first colour)");
      const double scale = std::sqrt(std::abs(m.a * m.d - m.b * m.c));
      const double width = sv::resolve(s.strokeWidth, std::sqrt((vp.w * vp.w + vp.h * vp.h) / 2), s.fontSizePx) * scale;
      if (width > 0 && strokeColor != "transparent") {
        Json st = Json::object();
        st.set("enabled", Json::boolean(true));
        st.set("color", Json::string(strokeColor));
        st.set("width", Json::number(width));
        st.set("opacity", Json::number(std::clamp(s.strokeOpacity, 0.0, 1.0)));
        static constexpr std::array<const char*, 3> kCaps = {"butt", "round", "square"};
        static constexpr std::array<const char*, 5> kJoins = {"miter", "round", "bevel", "miter", "round"};
        st.set("cap", Json::string(kCaps.at(static_cast<std::size_t>(s.cap))));
        st.set("join", Json::string(kJoins.at(static_cast<std::size_t>(s.join))));
        st.set("align", Json::string("center"));
        Json dash = Json::array();
        for (const sv::Length& l : s.dashArray) dash.arr_mut().push_back(Json::number(sv::resolve(l, vp.w, s.fontSizePx) * scale));
        st.set("dash", std::move(dash));
        if (!s.dashArray.empty()) st.set("dashOffset", Json::number(sv::resolve(s.dashOffset, vp.w, s.fontSizePx) * scale));
        st.set("miterLimit", Json::number(s.miterLimit));
        part.stroke = std::move(st);
        part.fillAboveStroke = s.paintOrderStrokeFirst;
      }
    }
    if (!s.markerStart.empty() || !s.markerMid.empty() || !s.markerEnd.empty()) notes_.insert("markers");
    part.opacity = opacity;
    out_.parts.push_back(std::move(part));
  }

  void text(int i, const Mat2D& m, double opacity, const Viewport& vp) {
    const sv::Style& s = styles_[static_cast<std::size_t>(i)];
    if (s.hidden) return;
    std::string content;
    const std::function<void(int)> collect = [&](int e) {
      const sv::Node& n = doc_.nodes[static_cast<std::size_t>(e)];
      if (!n.element) {
        content += n.text;
        return;
      }
      if (styles_[static_cast<std::size_t>(e)].displayNone) return;
      for (const int c : n.children) collect(c);
    };
    collect(i);
    // xml:space default: collapse whitespace, trim.
    std::string collapsed;
    bool space = false;
    for (const char c : content) {
      const bool ws = c == ' ' || c == '\n' || c == '\r' || c == '\t';
      if (ws) {
        space = !collapsed.empty();
      } else {
        if (space) collapsed += ' ';
        space = false;
        collapsed += c;
      }
    }
    if (collapsed.empty()) return;
    const auto first = [&](std::string_view attr, double ref) {
      const std::string* v = doc_.nodes[static_cast<std::size_t>(i)].attr(attr);
      if (v == nullptr) return 0.0;
      std::string_view rest = *v;
      sv::skip_comma_ws(rest);
      const std::size_t end = rest.find_first_of(" ,\t\n");
      const auto l = sv::parse_length(rest.substr(0, end));
      return l ? sv::resolve(*l, ref, s.fontSizePx) : 0.0;
    };
    const double x = first("x", vp.w);
    const double y = first("y", vp.h);
    const double fs = s.fontSizePx;
    // The run's box: an average advance of 0.55 em per character (the layer
    // re-measures itself once it is a text layer), its middle 0.35 em above the baseline.
    const double w = 0.55 * fs * static_cast<double>(collapsed.size());
    double cx = x;
    if (s.anchor == sv::Anchor::start) cx = x + w / 2;
    else if (s.anchor == sv::Anchor::end) cx = x - w / 2;
    const P c = apply(m, cx, y - 0.35 * fs);
    const double scale = std::sqrt(std::abs(m.a * m.d - m.b * m.c));
    doc::SvgPart part;
    part.kind = doc::SvgPart::Kind::text;
    part.name = name_of(i, "Text");
    part.centerX = c.x;
    part.centerY = c.y;
    part.width = w * scale;
    part.height = fs * 1.2 * scale;
    part.text = collapsed;
    part.fontSize = fs * scale;
    part.fontFamily = s.fontFamily.empty() ? std::string() : s.fontFamily.front();
    part.fontWeight = std::to_string(s.fontWeight);
    part.fontStyle = s.italic ? "italic" : "normal";
    P z{0, 0};
    part.fill = paint_of(s.fill, s.fillOpacity, s, z, z).first;
    part.opacity = opacity;
    if (std::abs(m.b) > 1e-9 || std::abs(m.c) > 1e-9) notes_.insert("rotated or skewed text (placed upright)");
    out_.parts.push_back(std::move(part));
  }

  void image(int i, const Mat2D& m, double opacity, const Viewport& vp) {
    const std::string* href = doc_.href(i);
    if (href == nullptr || href->empty()) return;
    const double x = len(i, "x", 0, vp.w);
    const double y = len(i, "y", 0, vp.h);
    const double w = len(i, "width", 0, vp.w);
    const double h = len(i, "height", 0, vp.h);
    if (!(w > 0) || !(h > 0)) return;
    const P c = apply(m, x + w / 2, y + h / 2);
    const double scale = std::sqrt(std::abs(m.a * m.d - m.b * m.c));
    doc::SvgPart part;
    part.kind = doc::SvgPart::Kind::image;
    part.name = name_of(i, "Image");
    part.centerX = c.x;
    part.centerY = c.y;
    part.width = w * scale;
    part.height = h * scale;
    part.href = *href;
    part.opacity = opacity;
    out_.parts.push_back(std::move(part));
  }

  const sv::Document& doc_;
  const std::vector<sv::Style>& styles_;
  doc::SvgShapes& out_;
  int counter_ = 0;
};

}  // namespace

std::optional<doc::SvgShapes> svg_document_shapes(std::string_view markup, const std::optional<std::string>& fillOverride,
                                                  std::string& why) {
  sv::Document d;
  std::string error;
  if (!sv::parse_xml(markup, d, error)) {
    why = "the SVG did not parse: " + error;
    return std::nullopt;
  }
  if (d.root < 0 || !d.nodes[static_cast<std::size_t>(d.root)].svgNs || d.nodes[static_cast<std::size_t>(d.root)].name != "svg") {
    why = "the document's root is not an <svg> element";
    return std::nullopt;
  }
  sv::expand_uses(d);
  std::string extra;
  if (fillOverride && !fillOverride->empty() && *fillOverride != "none" && *fillOverride != "transparent") {
    extra = "path, circle, rect, polygon, polyline, ellipse, text { fill: " + *fillOverride + " !important; }";
  }
  std::vector<sv::Style> styles;
  std::vector<std::string> unsupported;
  sv::compute_styles(d, extra, styles, unsupported);
  // The root viewport: rasterize_svg's intrinsic size (width / height, the
  // viewBox's, else 512 × 512), the viewBox mapped onto it.
  const sv::Node& root = d.nodes[static_cast<std::size_t>(d.root)];
  const auto root_len = [&](std::string_view a) {
    const std::string* v = root.attr(a);
    if (v == nullptr) return 0.0;
    const auto l = sv::parse_length(*v);
    if (!l || l->unit == sv::Unit::percent) return 0.0;
    const double n = sv::resolve(*l, 0, 16);
    return std::isfinite(n) && n > 0 ? n : 0.0;
  };
  double w = root_len("width");
  double h = root_len("height");
  std::optional<sv::ViewBox> vb;
  if (const std::string* v = root.attr("viewBox")) vb = sv::parse_view_box(*v);
  if (vb && (w == 0 || h == 0) && vb->w > 0 && vb->h > 0) {
    if (w != 0 && h == 0) h = w * vb->h / vb->w;
    else if (h != 0 && w == 0) w = h * vb->w / vb->h;
    else {
      w = vb->w;
      h = vb->h;
    }
  }
  if (w == 0 || h == 0) {
    w = 512;
    h = 512;
  }
  Mat2D m;
  Viewport vp{w, h};
  if (vb && vb->w > 0 && vb->h > 0) {
    const std::string* par = root.attr("preserveAspectRatio");
    m = sv::view_box_transform(*vb, sv::parse_aspect_ratio(par != nullptr ? *par : ""), w, h);
    vp = {vb->w, vb->h};
  }
  doc::SvgShapes out;
  out.width = w;
  out.height = h;
  Walker walker(d, styles, out);
  const double rootOpacity = styles[static_cast<std::size_t>(d.root)].opacity;
  for (const int c : root.children) walker.walk(c, m, rootOpacity, vp);
  if (markup.find("@keyframes") != std::string_view::npos || markup.find("animation") != std::string_view::npos) {
    walker.notes_.insert("CSS animation — the editor's Convert to Editable Shapes keys it");
  }
  out.notCarried.assign(walker.notes_.begin(), walker.notes_.end());
  return out;
}

}  // namespace premation::scene
