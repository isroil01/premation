#include "layer_geometry.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <limits>
#include <numbers>
#include <string>
#include <utility>
#include <vector>

#include "anim.hpp"
#include "fail.hpp"
#include "fxstate.hpp"
#include "scene.hpp"
#include "scene/session_hooks.hpp"
#include "timeline.hpp"

namespace premation::doc {
namespace {

using api::ErrorCode;
using Values = std::vector<std::pair<std::string, double>>;

/// geometry.ts `isDrawableKind`, plus `adjustment` (B1, docs/PROGRAM_3D_PERF_UX.md):
/// an adjustment layer's quad is its box (frame_build.cpp adjustment_to_renderable:
/// width × height centred on its position, the comp's size when it has none),
/// so getLayerBounds answers that box instead of nothing.
bool is_drawable_kind(const std::string& kind) {
  if (kind.find('.') != std::string::npos) return true;
  return kind == "shape" || kind == "text" || kind == "image" || kind == "video" || kind == "svg" || kind == "light" ||
         kind == "camera" || kind == "particle" || kind == "comp" || kind == "null" || kind == "group" ||
         kind == "adjustment";
}

std::optional<double> value_of(const Values& av, std::string_view k) {
  for (const auto& [prop, v] : av) {
    if (prop == k) return v;
  }
  return std::nullopt;
}

/// geometry.ts `animatedPropsOf` at `seconds` (the node's keyframe axis).
Values animated_at(const SpaceCtx& c, std::string_view node, double seconds) {
  const NodeAnim* a = c.d.anim(node);
  if (a == nullptr || a->empty()) return {};
  return anim_evaluate_node(c.d, c.expr, c.cache, node, comp_to_keyframe_time(c.d, c.view, node, seconds));
}

/// The layer's composition size (geometry.ts reads the active comp; the layer's own is the one it is drawn in).
std::pair<double, double> comp_size_of(const Document& d, std::string_view node) {
  if (const auto comp = comp_of_layer(d, node)) {
    if (const Json* rec = d.comp(*comp)) {
      const double w = rec->at("width").is_number() && rec->at("width").num() != 0 ? rec->at("width").num() : 1920;
      const double h = rec->at("height").is_number() && rec->at("height").num() != 0 ? rec->at("height").num() : 1080;
      return {w, h};
    }
  }
  return {1920, 1080};
}

/// buildSnapshot.ts SIZE, keyed by RENDER kind (an svg renders as an image).
std::pair<double, double> kind_size(const std::string& kind, double compW, double compH) {
  if (kind == "light" || kind == "camera") return {48, 48};
  if (kind == "particle") return {140, 140};
  if (kind == "null") return {60, 60};
  if (kind == "group") return {280, 280};
  if (kind == "comp" || kind == "adjustment") return {compW, compH};  // B1: a size-less adjustment layer is comp-sized
  if (kind == "svg" || kind == "image") return {280, 180};
  if (kind == "shape") return {220, 220};
  if (kind == "text") return {320, 80};
  if (kind == "video") return {480, 270};
  return {100, 100};
}

bool name_is_round(const std::string& name) {
  std::string lower = name;
  for (char& ch : lower) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
  return lower.find("circle") != std::string::npos || lower.find("ellip") != std::string::npos ||
         lower.find("dot") != std::string::npos || lower.find("orb") != std::string::npos;
}

std::optional<LayerGeometry> geometry(const SpaceCtx& c, TextQueries* text, const Node& n, double seconds, int depth);

/// geometry.ts `groupContentBounds(node, depth, live = true)` at `seconds`.
struct Box {
  double minX, minY, maxX, maxY;
};

/// A running min/max over points, for a path's exact extent.
struct Extent {
  double minX = std::numeric_limits<double>::infinity();
  double minY = std::numeric_limits<double>::infinity();
  double maxX = -std::numeric_limits<double>::infinity();
  double maxY = -std::numeric_limits<double>::infinity();
  void add(double x, double y) {
    if (!std::isfinite(x) || !std::isfinite(y)) return;
    minX = std::min(minX, x);
    minY = std::min(minY, y);
    maxX = std::max(maxX, x);
    maxY = std::max(maxY, y);
  }
  [[nodiscard]] bool ok() const { return std::isfinite(minX) && std::isfinite(maxX) && std::isfinite(minY) && std::isfinite(maxY); }
};

/// One axis of a cubic Bézier: the parameters in (0, 1) where it turns (its
/// derivative's roots), so the extent covers the curve, not its control hull.
void cubic_turns(double p0, double p1, double p2, double p3, std::vector<double>& ts) {
  const double a = -p0 + 3 * p1 - 3 * p2 + p3;
  const double b = 2 * (p0 - 2 * p1 + p2);
  const double c = p1 - p0;
  const auto keep = [&ts](double t) {
    if (t > 0 && t < 1) ts.push_back(t);
  };
  if (std::abs(a) < 1e-12) {
    if (std::abs(b) > 1e-12) keep(-c / b);
    return;
  }
  const double disc = b * b - 4 * a * c;
  if (disc < 0) return;
  const double s = std::sqrt(disc);
  keep((-b + s) / (2 * a));
  keep((-b - s) / (2 * a));
}

/// The exact extent of a path run (BezierPoint[]: x, y and optional in/out
/// handles, which default to the vertex): what the shape draws, which is the
/// box After Effects puts around a shape layer — not the width × height the
/// shape was made in (a star inscribed in its ellipse sat in a box wider and
/// taller than its points).
void add_path(Extent& e, const Json& pts, bool open) {
  if (!pts.is_array() || pts.arr().empty()) return;
  struct P {
    double x, y, inX, inY, outX, outY;
  };
  std::vector<P> ps;
  ps.reserve(pts.arr().size());
  for (const Json& p : pts.arr()) {
    if (!p.at("x").is_number() || !p.at("y").is_number()) continue;
    const double x = p.at("x").num();
    const double y = p.at("y").num();
    const auto handle = [&p](const char* k, double fallback) { return p.at(k).is_number() ? p.at(k).num() : fallback; };
    ps.push_back({x, y, handle("inX", x), handle("inY", y), handle("outX", x), handle("outY", y)});
  }
  if (ps.empty()) return;
  for (const P& p : ps) e.add(p.x, p.y);
  const std::size_t segs = open ? ps.size() - 1 : ps.size();
  std::vector<double> ts;
  for (std::size_t i = 0; i < segs; ++i) {
    const P& a = ps[i];
    const P& b = ps[(i + 1) % ps.size()];
    ts.clear();
    cubic_turns(a.x, a.outX, b.inX, b.x, ts);
    cubic_turns(a.y, a.outY, b.inY, b.y, ts);
    for (const double t : ts) {
      const double u = 1 - t;
      const double w0 = u * u * u;
      const double w1 = 3 * u * u * t;
      const double w2 = 3 * u * t * t;
      const double w3 = t * t * t;
      e.add(w0 * a.x + w1 * a.outX + w2 * b.inX + w3 * b.x, w0 * a.y + w1 * a.outY + w2 * b.inY + w3 * b.y);
    }
  }
}

/// A parametric polystar's outline at the time (path_ops.cpp `apply_polystar`, the same vertices and handles).
void add_polystar(Extent& e, const Json& cfg, const Values& av) {
  const auto v = [&](const char* param) {
    std::string path = "polystar.";
    path += param;
    if (const auto animated = value_of(av, path)) return *animated;
    return cfg.at(param).is_number() ? cfg.at(param).num() : 0.0;
  };
  constexpr double kPi = std::numbers::pi;
  const bool star = cfg.at("starType").is_string() && cfg.at("starType").str() == "star";
  const double cnt = std::max(3.0, std::round(v("points")));
  const double total = star ? cnt * 2 : cnt;
  const double step = (kPi * 2) / total;
  const double start = (v("rotation") - 90) * kPi / 180;
  const double outerRadius = std::max(0.0, v("outerRadius"));
  const double innerRadius = std::max(0.0, v("innerRadius"));
  Json pts = Json::array();
  for (double i = 0; i < total; ++i) {
    const bool outer = !star || std::fmod(i, 2.0) == 0;
    const double r = outer ? outerRadius : innerRadius;
    const double pct = (outer ? v("outerRoundness") : v("innerRoundness")) / 100;
    const double ang = start + i * step;
    const double x = std::cos(ang) * r;
    const double y = std::sin(ang) * r;
    const double tx = -std::sin(ang);
    const double ty = std::cos(ang);
    const double hl = (kPi * r * pct) / (2 * cnt);
    Json p = Json::object();
    p.set("x", Json::number(x));
    p.set("y", Json::number(y));
    p.set("inX", Json::number(x - tx * hl));
    p.set("inY", Json::number(y - ty * hl));
    p.set("outX", Json::number(x + tx * hl));
    p.set("outY", Json::number(y + ty * hl));
    pts.arr_mut().push_back(std::move(p));
  }
  add_path(e, pts, false);
}

/// A shape layer's drawn outline extent at `seconds`, in layer space: the
/// parametric polystar, else the animated path, else the stored Geometry
/// (one path or its subpaths). nullopt = the shape has no path (rect, ellipse).
std::optional<Box> shape_path_extent(const SpaceCtx& c, const Node& n, const Values& av, double seconds) {
  Extent e;
  if (const auto cfg = read_node_polystar(n)) {
    add_polystar(e, *cfg, av);
  } else {
    bool live = false;
    if (const DataTrack* tr = anim_data_track(c.d, n.id, "path.points")) {
      if (const auto pts = sample_data_track(*tr, comp_to_keyframe_time(c.d, c.view, n.id, seconds));
          pts && pts->is_array() && pts->arr().size() > 1) {
        const Component* geom = n.comp("Geometry");
        add_path(e, *pts, geom != nullptr && geom->props.at("open").is_bool() && geom->props.at("open").b());
        live = e.ok();
        // A compound outline: its other subpaths, live from their own tracks or as stored.
        const Json subs = geom != nullptr ? geom->props.at("subpaths") : Json();
        if (live && subs.is_array()) {
          for (std::size_t i = 1; i < subs.arr().size(); ++i) {
            const bool open = subs.arr()[i].at("open").is_bool() && subs.arr()[i].at("open").b();
            const DataTrack* st = anim_data_track(c.d, n.id, shape_subpath_track(i));
            const auto sp = st != nullptr ? sample_data_track(*st, comp_to_keyframe_time(c.d, c.view, n.id, seconds)) : std::nullopt;
            add_path(e, sp && sp->is_array() ? *sp : subs.arr()[i].at("points"), open);
          }
        }
      }
    }
    if (!live) {
      for (const Component& comp : n.components) {
        const Json& pts = comp.props.at("points");
        const bool open = comp.props.at("open").is_bool() && comp.props.at("open").b();
        if (pts.is_array() && !pts.arr().empty()) add_path(e, pts, open);
        if (comp.type != "Geometry" || !comp.props.at("subpaths").is_array()) continue;
        for (const Json& sp : comp.props.at("subpaths").arr()) {
          add_path(e, sp.at("points"), sp.at("open").is_bool() && sp.at("open").b());
        }
      }
    }
  }
  if (!e.ok()) return std::nullopt;
  return Box{e.minX, e.minY, e.maxX, e.maxY};
}
std::optional<Box> group_union(const SpaceCtx& c, TextQueries* text, const Node& n, double seconds, int depth) {
  if (depth > 16) return std::nullopt;  // cycle guard
  if (n.children.empty()) return std::nullopt;
  constexpr double kInf = std::numeric_limits<double>::infinity();
  Box b{kInf, kInf, -kInf, -kInf};
  for (const std::string& id : n.children) {
    const Node* child = c.d.node(id);
    if (child == nullptr) continue;
    const auto g = geometry(c, text, *child, seconds, depth + 1);
    if (!g) continue;
    const double halfW = std::abs(g->width * g->scaleX) / 2;
    const double halfH = std::abs(g->height * g->scaleY) / 2;
    const double cx = g->x + g->offsetX * g->scaleX;
    const double cy = g->y + g->offsetY * g->scaleY;
    b.minX = std::min(b.minX, cx - halfW);
    b.minY = std::min(b.minY, cy - halfH);
    b.maxX = std::max(b.maxX, cx + halfW);
    b.maxY = std::max(b.maxY, cy + halfH);
  }
  if (!std::isfinite(b.minX) || !std::isfinite(b.minY) || !std::isfinite(b.maxX) || !std::isfinite(b.maxY)) return std::nullopt;
  return b;
}

std::optional<LayerGeometry> geometry(const SpaceCtx& c, TextQueries* text, const Node& n, double seconds, int depth) {
  const std::string kind = n.kind();
  if (!is_drawable_kind(kind)) return std::nullopt;
  const Values av = animated_at(c, n.id, seconds);

  std::optional<double> x, y, rotation, scaleX, scaleY, scale, width, height, radius;
  std::optional<std::string> shapeType;
  for (const Component& comp : n.components) {
    const Json& p = comp.props;
    if (p.at("x").is_number()) x = p.at("x").num();
    if (p.at("y").is_number()) y = p.at("y").num();
    if (p.at("rotation").is_number()) rotation = p.at("rotation").num();
    if (p.at("scaleX").is_number()) scaleX = p.at("scaleX").num();
    if (p.at("scaleY").is_number()) scaleY = p.at("scaleY").num();
    if (p.at("scale").is_number()) scale = p.at("scale").num();
    if (p.at("width").is_number()) width = p.at("width").num();
    if (p.at("height").is_number()) height = p.at("height").num();
    if (p.at("shapeType").is_string()) shapeType = p.at("shapeType").str();
    if (p.at("radius").is_number()) radius = p.at("radius").num();
    else if (p.at("outerRadius").is_number()) radius = p.at("outerRadius").num();
    else if (p.at("r").is_number()) radius = p.at("r").num();
  }
  // The evaluated values at the time win.
  for (const char* k : {"x", "y", "rotation", "scaleX", "scaleY", "scale", "width", "height"}) {
    const auto v = value_of(av, k);
    if (!v) continue;
    const std::string_view key = k;
    if (key == "x") x = v;
    else if (key == "y") y = v;
    else if (key == "rotation") rotation = v;
    else if (key == "scaleX") scaleX = v;
    else if (key == "scaleY") scaleY = v;
    else if (key == "scale") scale = v;
    else if (key == "width") width = v;
    else height = v;
  }

  // A shape's drawn outline (exact, at the time). It is the box: the
  // width × height a path shape was made in is only where its points started.
  std::optional<Box> pathBox;
  std::optional<std::pair<double, double>> pointsBounds;
  if (kind == "shape") {
    pathBox = shape_path_extent(c, n, av, seconds);
    if (pathBox) pointsBounds = std::pair<double, double>{std::max(1.0, pathBox->maxX - pathBox->minX), std::max(1.0, pathBox->maxY - pathBox->minY)};
  }

  // Text sizes to its MEASURED box (the text port: fixed paragraph box, else the font box).
  std::optional<TextGeometry> measured;
  if (kind == "text") {
    if (text == nullptr) fail(ErrorCode::unsupported, "text is measured with fonts, which this engine has none of (headless)", {.layer = n.id});
    measured = text->text_geometry(n, av);
    if (!measured) fail(ErrorCode::unsupported, "this text style is outside the engine's text port", {.layer = n.id});
  }

  const auto [compW, compH] = comp_size_of(c.d, n.id);
  std::pair<double, double> size;
  if (measured) size = {measured->width, measured->height};
  else if (pointsBounds) size = *pointsBounds;
  else if (kind == "light" || kind == "camera") size = {48, 48};
  else if (radius && *radius > 0) size = {*radius * 2, *radius * 2};
  else size = kind_size(kind, compW, compH);

  const bool hasAuthoredDim = width && height && *width > 0 && *height > 0;
  double finalW = measured ? measured->width : pointsBounds ? pointsBounds->first : hasAuthoredDim ? *width : size.first;
  double finalH = measured ? measured->height : pointsBounds ? pointsBounds->second : hasAuthoredDim ? *height : size.second;
  double offsetX = pathBox ? (pathBox->minX + pathBox->maxX) / 2 : 0;
  double offsetY = measured ? measured->dy : pathBox ? (pathBox->minY + pathBox->maxY) / 2 : 0;

  // Full-frame solids: an unseeded solid fills the composition.
  bool isSolid = false;
  if (kind == "shape") {
    for (const Component& comp : n.components) {
      if (comp.type == "fx" && comp.props.at("solid").is_bool() && comp.props.at("solid").b()) isSolid = true;
    }
  }
  const ViewTransform vt = view_transform(n);
  double finalX = x.value_or(vt.x);
  double finalY = y.value_or(vt.y);
  if (isSolid && (!hasAuthoredDim || (*width == 100 && *height == 100))) {
    finalW = compW;
    finalH = compH;
    finalX = compW / 2;
    finalY = compH / 2;
  }

  // A group wraps its content at the time.
  if (kind == "group") {
    if (const auto b = group_union(c, text, n, seconds, depth)) {
      finalW = std::max(1.0, b->maxX - b->minX);
      finalH = std::max(1.0, b->maxY - b->minY);
      offsetX = (b->minX + b->maxX) / 2;
      offsetY = (b->minY + b->maxY) / 2;
    }
  }

  LayerGeometry g;
  g.x = finalX;
  g.y = finalY;
  g.rotationDeg = rotation.value_or(vt.rotation);
  g.width = finalW;
  g.height = finalH;
  g.scaleX = scaleX ? *scaleX : scale.value_or(1);
  g.scaleY = scaleY ? *scaleY : scale.value_or(1);
  g.ellipse = shapeType ? *shapeType == "ellipse" : name_is_round(n.name);
  g.offsetX = offsetX;
  g.offsetY = offsetY;
  return g;
}

// ── what masks and a stored subject matte leave visible ─────────────────────

/// One mask outline flattened for the visible region: its polygon (layer
/// space), exact extent, and how far its soft edge reaches past the line
/// (Expansion + half the Feather, px; negative = pulled in).
struct Outline {
  std::vector<std::pair<double, double>> poly;
  Box box{};
  double grow = 0;
  bool inverted = false;
  std::string mode;
};

/// The masks the Object Matte / Roto Brush tools key the subject's outline on (rotoBrushTool.ts).
bool is_matte_outline_name(const Json& name) {
  if (!name.is_string()) return false;
  const std::string& s = name.str();
  return s == "Object Matte" || s == "Roto Brush" || s == "Roto Brush (Frozen)";
}

std::optional<Outline> outline_of(const Json& p, const Values& av) {
  const Json& pts = p.at("points");
  if (!pts.is_array() || pts.arr().size() < 2) return std::nullopt;
  Extent e;
  const bool open = p.at("closed").is_bool() && !p.at("closed").b();
  add_path(e, pts, open);
  if (!e.ok()) return std::nullopt;
  Outline o;
  o.box = Box{e.minX, e.minY, e.maxX, e.maxY};
  const std::string id = p.at("id").is_string() ? p.at("id").str() : "";
  const double feather = value_of(av, "mask." + id + ".feather").value_or(p.at("feather").is_number() ? p.at("feather").num() : 0);
  const double expansion = value_of(av, "mask." + id + ".expansion").value_or(p.at("expansion").is_number() ? p.at("expansion").num() : 0);
  double vertexFeather = 0;  // a per-vertex feather can reach further than the uniform one
  for (const Json& pt : pts.arr()) {
    if (pt.at("feather").is_number()) vertexFeather = std::max(vertexFeather, pt.at("feather").num());
  }
  o.grow = expansion + std::max(std::max(0.0, feather), vertexFeather) / 2;
  o.inverted = p.at("inverted").is_bool() && p.at("inverted").b();
  o.mode = p.at("mode").is_string() ? p.at("mode").str() : "add";
  // 16 steps a segment: the hit test's polygon, within a fraction of a pixel of the curve at editor sizes.
  const auto& v = pts.arr();
  const std::size_t n = v.size();
  const std::size_t segs = open ? n - 1 : n;
  o.poly.reserve(segs * 16 + 1);
  const auto num = [](const Json& j, const char* k, double fb) { return j.at(k).is_number() ? j.at(k).num() : fb; };
  for (std::size_t i = 0; i < segs; ++i) {
    const Json& a = v[i];
    const Json& b = v[(i + 1) % n];
    const double ax = num(a, "x", 0), ay = num(a, "y", 0), bx = num(b, "x", 0), by = num(b, "y", 0);
    const double c1x = num(a, "outX", ax), c1y = num(a, "outY", ay), c2x = num(b, "inX", bx), c2y = num(b, "inY", by);
    for (int s = 0; s < 16; ++s) {
      const double t = s / 16.0;
      const double u = 1 - t;
      o.poly.emplace_back(u * u * u * ax + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * bx,
                          u * u * u * ay + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * by);
    }
  }
  return o;
}

/// Even-odd point in polygon, with the outline's soft edge: within `grow` px
/// outside the line counts as inside (and a negative grow pulls the inside in).
bool outline_contains(const Outline& o, double x, double y) {
  const auto& p = o.poly;
  if (p.size() < 3) return false;
  bool in = false;
  double best = std::numeric_limits<double>::infinity();
  for (std::size_t i = 0, j = p.size() - 1; i < p.size(); j = i++) {
    const auto [xi, yi] = p[i];
    const auto [xj, yj] = p[j];
    if ((yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) in = !in;
    const double dx = xj - xi, dy = yj - yi;
    const double len2 = dx * dx + dy * dy;
    const double t = len2 > 0 ? std::clamp(((x - xi) * dx + (y - yi) * dy) / len2, 0.0, 1.0) : 0.0;
    best = std::min(best, std::hypot(x - (xi + t * dx), y - (yi + t * dy)));
  }
  return o.grow >= 0 ? (in || best <= o.grow) : (in && best >= -o.grow);
}

Box grown(const Box& b, double by) { return Box{b.minX - by, b.minY - by, b.maxX + by, b.maxY + by}; }
Box unite(const Box& a, const Box& b) {
  return Box{std::min(a.minX, b.minX), std::min(a.minY, b.minY), std::max(a.maxX, b.maxX), std::max(a.maxY, b.maxY)};
}
Box meet(const Box& a, const Box& b) {
  return Box{std::max(a.minX, b.minX), std::max(a.minY, b.minY), std::min(a.maxX, b.maxX), std::min(a.maxY, b.maxY)};
}

/// Whether the layer's stored subject matte (setLayerMatte, the Object Matte /
/// Roto Brush cut-out) cuts it right now — snapshot_build.cpp's rule: through
/// an enabled Object Matte effect (not inverted), or standing in for the
/// footage when it was not stored for an effect and the layer has none.
bool matte_cuts(const Node& n) {
  const Json& am = n.fx().at("alphaMatte");
  if (!am.is_object() || !am.at("frames").is_array() || am.at("frames").arr().empty()) return false;
  bool card = false;
  for (const Json& e : read_node_effects(n)) {
    if (!(e.at("type").is_string() && e.at("type").str() == "object-matte")) continue;
    card = true;
    if (e.at("enabled").is_bool() && !e.at("enabled").b()) continue;
    const Json& inv = params_of(e).at("invert");
    if ((inv.is_bool() && inv.b()) || (inv.is_number() && inv.num() != 0)) return false;  // the background stays: no shrink
    return true;
  }
  const Json& by = am.at("cutByEffect");
  return !card && !(by.is_bool() && by.b());
}

/// What the layer's masks and stored matte leave visible at `seconds`.
struct Visible {
  std::vector<Outline> active;  ///< the masks that cut, in stack order
  std::vector<Outline> matte;   ///< the stored matte's outline masks, when it cuts
  bool baseFull = true;         ///< the stack starts from the whole layer (its first cut is not Add / Lighten)
  bool cuts = false;
};

Visible visible_of(const SpaceCtx& c, const Node& n, double seconds) {
  Visible v;
  const double kt = comp_to_keyframe_time(c.d, c.view, n.id, seconds);
  Json mask;
  if (const std::span<const Json> anim = mask_anim_view(n); !anim.empty()) {
    if (auto m = interpolate_mask(anim, kt)) mask = *m;
  } else if (auto m = read_node_mask(n)) {
    mask = *m;
  }
  if (!mask.is_object() || !mask.at("paths").is_array()) return v;
  const Values av = animated_at(c, n.id, seconds);
  const bool matte = matte_cuts(n);
  for (const Json& p : mask.at("paths").arr()) {
    const std::string mode = p.at("mode").is_string() ? p.at("mode").str() : "add";
    if (mode == "none") {
      if (matte && is_matte_outline_name(p.at("name"))) {
        if (auto o = outline_of(p, av)) v.matte.push_back(std::move(*o));
      }
      continue;
    }
    auto o = outline_of(p, av);
    if (!o) continue;
    if (v.active.empty()) v.baseFull = !(mode == "add" || mode == "lighten");
    v.active.push_back(std::move(*o));
  }
  v.cuts = !v.active.empty() || !v.matte.empty();
  return v;
}

/// The box of what `v` leaves of `full` (layer space); nullopt = all of it.
std::optional<Box> visible_box(const Visible& v, const Box& full) {
  if (!v.cuts) return std::nullopt;
  std::optional<Box> cur;
  if (v.active.empty() || v.baseFull) cur = full;
  for (const Outline& o : v.active) {
    const Box b = grown(o.box, std::max(0.0, o.grow));
    if (o.mode == "add" || o.mode == "lighten" || o.mode == "difference") {
      cur = o.inverted ? full : (cur ? unite(*cur, b) : b);
    } else if (o.mode == "subtract") {
      if (o.inverted && cur) cur = meet(*cur, b);  // takes away everything outside it
    } else if (!o.inverted && cur) {  // intersect / darken
      cur = meet(*cur, b);
    }
  }
  if (!v.matte.empty()) {
    // A soft, refined matte edge can sit a few pixels past its traced outline.
    Box m = grown(v.matte.front().box, std::max(4.0, v.matte.front().grow));
    for (std::size_t i = 1; i < v.matte.size(); ++i) m = unite(m, grown(v.matte[i].box, std::max(4.0, v.matte[i].grow)));
    cur = cur ? meet(*cur, m) : m;
  }
  if (!cur) return std::nullopt;
  const Box r = meet(*cur, full);
  // Nothing left (every outline off the layer): keep the whole box, so the layer stays reachable.
  if (!(r.maxX - r.minX > 0.5) || !(r.maxY - r.minY > 0.5)) return std::nullopt;
  constexpr double kEps = 0.01;
  if (r.minX <= full.minX + kEps && r.minY <= full.minY + kEps && r.maxX >= full.maxX - kEps && r.maxY >= full.maxY - kEps) {
    return std::nullopt;
  }
  return r;
}

/// The painter's mask stack (mask_paint.cpp), as a yes / no at one point.
bool visible_at(const Visible& v, double x, double y) {
  if (!v.cuts) return true;
  bool in = v.active.empty() || v.baseFull;
  for (const Outline& o : v.active) {
    const bool hit = outline_contains(o, x, y) != o.inverted;
    if (o.mode == "add" || o.mode == "lighten") in = in || hit;
    else if (o.mode == "subtract") in = in && !hit;
    else if (o.mode == "difference") in = in != hit;
    else in = in && hit;  // intersect / darken
  }
  if (in && !v.matte.empty()) {
    in = std::ranges::any_of(v.matte, [&](const Outline& o) {
      Outline soft = o;
      soft.grow = std::max(4.0, o.grow);
      return outline_contains(soft, x, y);
    });
  }
  return in;
}

/// Kinds whose box the masks can trim: everything drawn with pixels of its own.
bool trims_to_visible(const std::string& kind) {
  return kind != "group" && kind != "camera" && kind != "light" && kind != "null" && kind != "adjustment";
}

}  // namespace

std::optional<LayerGeometry> layer_geometry_at(const SpaceCtx& c, TextQueries* text, std::string_view node, double seconds) {
  const Node* n = c.d.node(node);
  if (n == nullptr) return std::nullopt;
  return geometry(c, text, *n, seconds, 0);
}

std::optional<LayerGeometry> visible_geometry_at(const SpaceCtx& c, TextQueries* text, std::string_view node, double seconds) {
  const Node* n = c.d.node(node);
  if (n == nullptr) return std::nullopt;
  auto g = geometry(c, text, *n, seconds, 0);
  if (!g || !trims_to_visible(n->kind())) return g;
  const Box full{g->offsetX - g->width / 2, g->offsetY - g->height / 2, g->offsetX + g->width / 2, g->offsetY + g->height / 2};
  const auto b = visible_box(visible_of(c, *n, seconds), full);
  if (!b) return g;
  g->width = b->maxX - b->minX;
  g->height = b->maxY - b->minY;
  g->offsetX = (b->minX + b->maxX) / 2;
  g->offsetY = (b->minY + b->maxY) / 2;
  g->ellipse = false;
  return g;
}

bool visible_contains(const SpaceCtx& c, std::string_view node, double seconds, double x, double y) {
  const Node* n = c.d.node(node);
  if (n == nullptr || !trims_to_visible(n->kind())) return true;
  return visible_at(visible_of(c, *n, seconds), x, y);
}

}  // namespace premation::doc
