// convertLayer / separateLayer (ENGINE_API.md §4.4) — the conversions the
// engine evaluates itself.
//
// Answered only by an engine with its conversion geometry attached
// (HCtx::geometry — the engine process attaches one): a core-only engine (the
// headless build, the parity harness) answers `unsupported` exactly as the
// TypeScript engine does, so the replay corpus keeps comparing like with like
// (convert_geometry.hpp).
//
//   bakeTransform  a COPY of the layer, out of its parent, whose Position /
//                  Rotation / Scale are keyed on every frame of its span with
//                  the world transform the original draws with (keyframes,
//                  expressions and the parent chain baked); their expressions
//                  disabled (AE's Convert Expression to Keyframes). 2D layers.
//   separateLayer  a shape layer whose outline has several runs (subpaths):
//                  one shape layer per run, in the original's place, front to
//                  back in run order; the original removed.
//
//   shapesFromText a path layer of the text's glyph contours (the geometry's
//                  text_outlines: the painted text traced), beside the text,
//                  the text hidden (layerCreateEdits.ts shapesFromTextEdit).
//   masksFromText  a comp-sized solid in the text's colour with one mask per
//                  contour, ordered and moded by nesting (masksFromText.ts).
//
// The rest (shapes from vector, editable text, uncompose) need the SVG parser
// or a picture-preserving precomp flatten the engine does not have yet:
// `unsupported` with the reason (the editor's own dialogs build them).
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "anim.hpp"
#include "convert_geometry.hpp"
#include "fail.hpp"
#include "fxstate.hpp"
#include "handlers_groups.hpp"
#include "handlers_layers.hpp"
#include "native_effects.hpp"
#include "props.hpp"
#include "readmodel.hpp"
#include "scene.hpp"
#include "time_conv.hpp"
#include "timeline.hpp"
#include "transform.hpp"
#include "worldxf.hpp"

namespace premation::doc {

using api::ErrorCode;

namespace {

void require_geometry(const HCtx& x, const std::string& what) {
  if (x.geometry == nullptr) {
    fail(ErrorCode::unsupported, "'" + what + "' needs the engine's conversion geometry (fonts, outlines, evaluation); this engine has none");
  }
}

/// The layer's composition, 2D, with frames to bake — or a refusal.
struct BakeSpan {
  std::string comp;
  double fps = 30;
  double f0 = 0;
  double f1 = 0;
};

BakeSpan bake_span(HCtx& x, const std::string& layer) {
  Document& d = x.d;
  BakeSpan s;
  s.comp = comp_of_layer(d, layer).value_or("");
  if (s.comp.empty()) fail(ErrorCode::invalid_argument, "the layer is not in a composition", {.layer = layer});
  double cw = 1920;
  double ch = 1080;
  if (const Json* rec = d.comp(s.comp); rec != nullptr && rec->at("width").is_number() && rec->at("height").is_number()) {
    cw = rec->at("width").num();
    ch = rec->at("height").num();
  }
  if (world_3d_at(SpaceCtx{d, x.view, x.expr, x.cache}, layer, 0, cw, ch)) {
    fail(ErrorCode::unsupported, "baking a 3D layer's transform is not supported yet", {.layer = layer});
  }
  s.fps = comp_fps(d, s.comp);
  const api::LayerTiming timing = layer_timing(d, layer);
  s.f0 = std::max(0.0, std::ceil(flicks_to_frames(timing.in_point, s.fps) - 1e-9));
  s.f1 = std::min(flicks_to_frames(timing.out_point, s.fps), comp_duration_frames(d, s.comp));
  if (s.f1 <= s.f0) fail(ErrorCode::out_of_range, "the layer has no frames to bake", {.layer = layer});
  return s;
}

api::LayerList bake_transform(const std::string& layer, HCtx& x) {
  Document& d = x.d;
  const BakeSpan span = bake_span(x, layer);
  // Sample the ORIGINAL first: its world transform per composition frame.
  struct Sample {
    double frame = 0;
    motion::xf::Local2D local;
  };
  std::vector<Sample> samples;
  for (double f = span.f0; f < span.f1; f += 1) {
    const motion::xf::Mat2D m = world_2d_at(x.pc(), layer, f / span.fps);
    samples.push_back(Sample{f, motion::xf::matrix_to_local(m)});
  }
  const std::string name = d.node(layer)->name;
  api::DuplicateLayers dup;
  dup.layers = {layer};
  const std::string copy = handle(dup, x).layers.at(0);
  // Out of its parent: the copy's own transform is then its world transform.
  if (const Node* n = d.node(copy); n != nullptr && n->parent && *n->parent != span.comp && d.node(*n->parent) != nullptr &&
                                    comp_of_layer(d, *n->parent).has_value()) {
    api::SetParent sp;
    sp.layers = {copy};
    sp.keep_world_transform = false;
    (void)handle(sp, x);
  }
  const Catalog cat = catalog_for(d, copy);
  const PropBinding& pos = require_binding(cat, "transform/position");
  const PropBinding& rot = require_binding(cat, "transform/rotation");
  const PropBinding& scl = require_binding(cat, "transform/scale");
  const auto keyed = [&](const PropBinding& b, std::size_t member, auto&& value) {
    if (member >= b.members.size()) return;
    std::vector<Key> keys;
    keys.reserve(samples.size());
    for (const Sample& s : samples) {
      Key k;
      k.id = x.mint_key_id();
      k.t = flicks_to_key_time(x.pc(), copy, b, frames_to_flicks(s.frame, span.fps));
      k.value = value(s.local);
      k.easing = api::Easing::linear;
      keys.push_back(std::move(k));
    }
    const std::string& m = b.members[member];
    anim_set_track(d, copy, m, std::move(keys));
    // AE: the expression is DISABLED, not removed.
    if (anim_has_expr(d, copy, m)) anim_set_expr_enabled(d, copy, m, false);
  };
  keyed(pos, 0, [](const motion::xf::Local2D& l) { return l.x; });
  keyed(pos, 1, [](const motion::xf::Local2D& l) { return l.y; });
  keyed(rot, 0, [](const motion::xf::Local2D& l) { return l.rotation; });
  keyed(scl, 0, [](const motion::xf::Local2D& l) { return l.scale_x; });
  keyed(scl, 1, [](const motion::xf::Local2D& l) { return l.scale_y; });
  d.node_mut(copy).name = name + " (baked)";
  x.label = "Bake Transform";
  return api::LayerList{{copy}};
}

// ── Create Shapes / Masks from Text ─────────────────────────────────────────

/// masksFromText.ts `textFillOf`: the Text component's fill, else the first
/// component's string fill, else white.
std::string text_fill_of(const Node& n) {
  if (const Component* t = n.comp("Text"); t != nullptr && t->props.at("fill").is_string()) return t->props.at("fill").str();
  for (const Component& c : n.components) {
    if (c.props.at("fill").is_string()) return c.props.at("fill").str();
  }
  return "#ffffff";
}

/// The text layer's outlines at the playhead, or a refusal naming why.
TextOutlines outlines_of(const std::string& layer, HCtx& x) {
  const Node& n = *x.d.node(layer);
  if (n.kind() != "text") fail(ErrorCode::invalid_argument, "only a text layer has outlines to convert", {.layer = layer});
  std::string why;
  std::optional<TextOutlines> o = x.geometry->text_outlines(GeoCtx{x.d, x.view, x.expr, x.cache}, layer, flicks_to_seconds(x.time), why);
  if (!o || o->runs.empty()) fail(ErrorCode::unsupported, "the text could not be outlined: " + why, {.layer = layer});
  return std::move(*o);
}

/// The layer's stack index among its composition's layers (createLayer's `index`).
std::uint32_t stack_index_of(const Document& d, const std::string& comp, const std::string& layer) {
  const std::vector<std::string> ids = layer_ids_of_comp(d, comp);
  const auto it = std::find(ids.begin(), ids.end(), layer);
  return static_cast<std::uint32_t>(it == ids.end() ? 0 : it - ids.begin());
}

/// The text's parent when it is a layer of the composition (groups nest), else none.
std::optional<std::string> layer_parent_of(const Document& d, const std::string& comp, const std::string& layer) {
  const Node* n = d.node(layer);
  if (n == nullptr || !n->parent || *n->parent == comp || d.node(*n->parent) == nullptr) return std::nullopt;
  return comp_of_layer(d, *n->parent) == comp ? n->parent : std::nullopt;
}

void hide_layer(const std::string& layer, HCtx& x) {
  api::SetLayerSwitches hide;
  hide.layers = {layer};
  hide.patch.visible = false;
  (void)handle(hide, x);
}

Json run_json(const GeoRun& r) {
  Json pts = Json::array();
  pts.arr_mut().reserve(r.points.size());
  for (const GeoPt& p : r.points) {
    Json o = Json::object();
    o.set("x", Json::number(p.x));
    o.set("y", Json::number(p.y));
    o.set("inX", Json::number(p.inX));
    o.set("inY", Json::number(p.inY));
    o.set("outX", Json::number(p.outX));
    o.set("outY", Json::number(p.outY));
    pts.arr_mut().push_back(std::move(o));
  }
  Json run = Json::object();
  run.set("points", std::move(pts));
  run.set("open", Json::boolean(!r.closed));
  return run;
}

/// layerCreateEdits.ts `shapesFromTextEdit`: a path layer whose Geometry is one
/// run per glyph contour (counters as runs of their own), the text's transform
/// and fill, beside the text (just above it); the text hidden (AE keeps it).
api::LayerList shapes_from_text(const std::string& layer, HCtx& x) {
  Document& d = x.d;
  const TextOutlines o = outlines_of(layer, x);
  const std::string comp = comp_of_layer(d, layer).value_or("");
  const Node& text = *d.node(layer);
  const Json tp = transform_props(text);
  const auto num = [&tp](std::string_view k, double fb) { return tp.at(k).is_finite_number() ? tp.at(k).num() : fb; };
  double opacity = 100;
  for (const char* type : {"Style", "Text"}) {
    if (const Component* s = text.comp(type); s != nullptr && s->props.at("opacity").is_finite_number()) {
      opacity = s->props.at("opacity").num();
      break;
    }
  }
  const std::string fill = text_fill_of(text);
  api::CreateLayer create;
  create.comp = comp;
  create.kind = api::LayerKind::path;
  create.name = text.name + (o.fromFont ? " Outlines (outlines)" : " Outlines (traced)");
  create.parent = layer_parent_of(d, comp, layer);
  create.index = stack_index_of(d, comp, layer);
  const std::string id = handle(create, x).layer;
  const std::string tId = id + "_t";
  (void)sg_write_prop(d, id, tId, "x", Json::number(num("x", 0)));
  (void)sg_write_prop(d, id, tId, "y", Json::number(num("y", 0)));
  (void)sg_write_prop(d, id, tId, "rotation", Json::number(num("rotation", 0)));
  (void)sg_write_prop(d, id, tId, "scaleX", Json::number(num("scaleX", 1)));
  (void)sg_write_prop(d, id, tId, "scaleY", Json::number(num("scaleY", 1)));
  (void)sg_write_prop(d, id, tId, "anchorX", Json::number(num("anchorX", 0)));
  (void)sg_write_prop(d, id, tId, "anchorY", Json::number(num("anchorY", 0)));
  (void)sg_write_prop(d, id, tId, "width", Json::number(o.width));
  (void)sg_write_prop(d, id, tId, "height", Json::number(o.height));
  (void)sg_write_prop(d, id, tId, "shapeType", Json::string("path"));
  (void)sg_write_prop(d, id, id + "_s", "fill", Json::string(fill));
  (void)sg_write_prop(d, id, id + "_s", "opacity", Json::number(opacity));
  // Runs, never the flat point list: a letter with a counter is two runs.
  Json runs = Json::array();
  for (const GeoRun& r : o.runs) runs.arr_mut().push_back(run_json(r));
  Json g = Json::object();
  g.set("subpaths", std::move(runs));
  (void)sg_add_component(d, id, Component{id + "_g", "Geometry", std::move(g)});
  hide_layer(layer, x);
  x.label = "Create Shapes from Text";
  return api::LayerList{{id}};
}

// masksFromTextGeometry.ts — contours → mask paths ordered and moded by nesting.

using Poly = std::vector<std::array<double, 2>>;

/// `flattenContour`: straight segments keep their start vertex, curves 8 samples.
Poly flatten_contour(const std::vector<GeoPt>& pts) {
  constexpr int kSteps = 8;
  Poly out;
  const std::size_t n = pts.size();
  for (std::size_t i = 0; i < n; ++i) {
    const GeoPt& a = pts[i];
    const GeoPt& b = pts[(i + 1) % n];
    // Exact comparison, as the TS: a handle sitting ON its vertex is a straight segment.
    if (a.outX == a.x && a.outY == a.y && b.inX == b.x && b.inY == b.y) {
      out.push_back({a.x, a.y});
      continue;
    }
    for (int s = 0; s < kSteps; ++s) {
      const double t = static_cast<double>(s) / kSteps;
      const double u = 1 - t;
      const double w0 = u * u * u;
      const double w1 = 3 * u * u * t;
      const double w2 = 3 * u * t * t;
      const double w3 = t * t * t;
      out.push_back({w0 * a.x + w1 * a.outX + w2 * b.inX + w3 * b.x, w0 * a.y + w1 * a.outY + w2 * b.inY + w3 * b.y});
    }
  }
  return out;
}

/// `polygonContains`: even-odd ray cast.
bool polygon_contains(const Poly& poly, double x, double y) {
  bool inside = false;
  const std::size_t n = poly.size();
  for (std::size_t i = 0, j = n - 1; i < n; j = i++) {
    const auto& [xi, yi] = poly[i];
    const auto& [xj, yj] = poly[j];
    if (((yi > y) != (yj > y)) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/// `polygonArea` (shoelace, absolute).
double polygon_area(const Poly& poly) {
  double a = 0;
  const std::size_t n = poly.size();
  for (std::size_t i = 0, j = n - 1; i < n; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return std::abs(a / 2);
}

/// `nestingDepths`: how many larger contours contain each one.
std::vector<int> nesting_depths(const std::vector<Poly>& polys) {
  std::vector<int> depths(polys.size(), 0);
  for (std::size_t i = 0; i < polys.size(); ++i) {
    const Poly& poly = polys[i];
    double px = poly.empty() ? 0 : poly[0][0];
    double py = poly.empty() ? 0 : poly[0][1];
    if (!poly.empty()) {
      double cx = 0;
      double cy = 0;
      for (const auto& p : poly) {
        cx += p[0];
        cy += p[1];
      }
      cx /= static_cast<double>(poly.size());
      cy /= static_cast<double>(poly.size());
      if (polygon_contains(poly, cx, cy)) {
        px = cx;
        py = cy;
      }
    }
    const double area = polygon_area(poly);
    for (std::size_t j = 0; j < polys.size(); ++j) {
      if (j != i && polygon_area(polys[j]) > area && polygon_contains(polys[j], px, py)) depths[i] += 1;
    }
  }
  return depths;
}

/// masksFromText.ts `buildMasksFromTextSolid`: a comp-sized solid in the text's
/// colour beside the text, one mask per glyph contour (outers Add, counters
/// Subtract, islands in counters Add), mapped text layer → comp → solid at the
/// playhead; the text hidden.
api::LayerList masks_from_text(const std::string& layer, HCtx& x) {
  Document& d = x.d;
  const TextOutlines o = outlines_of(layer, x);
  const std::string comp = comp_of_layer(d, layer).value_or("");
  const double seconds = flicks_to_seconds(x.time);
  const Node& text = *d.node(layer);
  const std::string fill = text_fill_of(text);
  api::CreateLayer create;
  create.comp = comp;
  create.kind = api::LayerKind::solid;
  create.name = text.name + " Outlines";
  create.parent = layer_parent_of(d, comp, layer);
  create.index = stack_index_of(d, comp, layer);
  const std::string id = handle(create, x).layer;
  // The solid's colour: Style fill and the fx fill (setFill {type: solid}).
  (void)sg_write_prop(d, id, id + "_s", "fill", Json::string(fill));
  Json paint = Json::object();
  paint.set("type", Json::string("solid"));
  paint.set("color", Json::string(fill));
  sg_set_fx(d, id, "fill", std::move(paint));
  // A group parent places the solid in the group's space: centre it on the comp through its world matrix.
  const motion::xf::Mat2D textM = world_2d_at(x.pc(), layer, seconds);
  const motion::xf::Mat2D solidM = world_2d_at(x.pc(), id, seconds);
  const double det = solidM.a * solidM.d - solidM.b * solidM.c;
  if (!std::isfinite(det) || std::abs(det) < 1e-12) fail(ErrorCode::invalid_argument, "the text's parent is scaled to nothing", {.layer = layer});
  const auto map = [&](double px, double py) {
    const double cx = textM.a * px + textM.c * py + textM.e;
    const double cy = textM.b * px + textM.d * py + textM.f;
    const double rx = cx - solidM.e;
    const double ry = cy - solidM.f;
    return std::array<double, 2>{(solidM.d * rx - solidM.c * ry) / det, (-solidM.b * rx + solidM.a * ry) / det};
  };
  struct Mapped {
    std::vector<GeoPt> points;
    Poly poly;
  };
  std::vector<Mapped> mapped;
  for (const GeoRun& r : o.runs) {
    if (r.points.size() < 3) continue;
    Mapped m;
    for (const GeoPt& p : r.points) {
      const auto v = map(p.x, p.y);
      const auto in = map(p.inX, p.inY);
      const auto out = map(p.outX, p.outY);
      m.points.push_back(GeoPt{v[0], v[1], in[0], in[1], out[0], out[1]});
    }
    m.poly = flatten_contour(m.points);
    if (polygon_area(m.poly) > 1e-6) mapped.push_back(std::move(m));
  }
  std::vector<Poly> polys;
  polys.reserve(mapped.size());
  for (const Mapped& m : mapped) polys.push_back(m.poly);
  const std::vector<int> depths = nesting_depths(polys);
  std::vector<std::size_t> order(mapped.size());
  for (std::size_t i = 0; i < order.size(); ++i) order[i] = i;
  std::stable_sort(order.begin(), order.end(), [&](std::size_t a, std::size_t b) { return depths[a] < depths[b]; });
  for (std::size_t n = 0; n < order.size(); ++n) {
    const Mapped& m = mapped[order[n]];
    const bool counter = depths[order[n]] % 2 == 1;
    api::AddMask add;
    add.layer = id;
    add.mode = counter ? api::MaskMode::subtract : api::MaskMode::add;
    add.name = std::string(counter ? "Counter " : "Glyph ") + std::to_string(n + 1);
    add.index = static_cast<std::uint32_t>(n);
    add.path.closed = true;
    for (const GeoPt& p : m.points) {
      add.path.vertices.insert(add.path.vertices.end(), {p.x, p.y});
      // Tangents relative to their vertex (the BezierPath form).
      add.path.in_tangents.insert(add.path.in_tangents.end(), {p.inX - p.x, p.inY - p.y});
      add.path.out_tangents.insert(add.path.out_tangents.end(), {p.outX - p.x, p.outY - p.y});
    }
    (void)handle(add, x);
  }
  hide_layer(layer, x);
  x.label = "Create Masks from Text";
  return api::LayerList{{id}};
}

// ── SVG → shapes / editable text ────────────────────────────────────────────

/// The SVG document a layer draws: an SVG layer's `svg` component (the
/// original markup, else the sanitized copy), or an SVG footage layer's
/// `data:` / file src. nullopt when the layer draws no SVG.
std::optional<std::string> svg_markup_of(const Node& n, HCtx& x) {
  if (const Component* c = n.comp("svg"); c != nullptr) {
    for (const char* k : {"sourceMarkup", "sanitizedMarkup"}) {
      if (c->props.at(k).is_string() && !c->props.at(k).str().empty()) return c->props.at(k).str();
    }
  }
  if (n.kind() != "svg") return std::nullopt;
  const Json& src = transform_props(n).at("src");
  if (!src.is_string() || src.str().empty()) return std::nullopt;
  const std::string& s = src.str();
  if (s.starts_with("data:")) {
    // data:image/svg+xml[;base64],… — percent-encoded or base64.
    const std::size_t comma = s.find(',');
    if (comma == std::string::npos) return std::nullopt;
    const std::string_view head(s.data(), comma);
    const std::string_view body(s.data() + comma + 1, s.size() - comma - 1);
    if (head.find(";base64") != std::string_view::npos) {
      std::optional<std::vector<std::uint8_t>> bytes = native_unbase64(body);
      if (!bytes) return std::nullopt;
      return std::string(bytes->begin(), bytes->end());
    }
    std::string out;
    for (std::size_t i = 0; i < body.size(); ++i) {
      const auto hex = [](char h) {
        if (h >= '0' && h <= '9') return h - '0';
        if (h >= 'a' && h <= 'f') return h - 'a' + 10;
        if (h >= 'A' && h <= 'F') return h - 'A' + 10;
        return -1;
      };
      if (body[i] == '%' && i + 2 < body.size() && hex(body[i + 1]) >= 0 && hex(body[i + 2]) >= 0) {
        out += static_cast<char>((hex(body[i + 1]) << 4) | hex(body[i + 2]));
        i += 2;
      } else {
        out += body[i];
      }
    }
    return out;
  }
  if (!x.ports.has_file_bytes()) return std::nullopt;
  std::string path = s;
  if (path.starts_with("local-file://")) path = path.substr(std::string_view("local-file://").size());
  const std::vector<std::uint8_t> bytes = x.ports.read_file_bytes(path);
  return std::string(bytes.begin(), bytes.end());
}

/// The group that stands in for an SVG layer: its transform, span, opacity
/// and keys, at its slot in the stack.
std::string svg_carrier(const std::string& layer, const std::string& comp, const std::string& name, HCtx& x) {
  Document& d = x.d;
  const Node& n = *d.node(layer);
  const Json tp = transform_props(n);
  const auto num = [&tp](std::string_view k, double fb) { return tp.at(k).is_finite_number() ? tp.at(k).num() : fb; };
  api::CreateLayer create;
  create.comp = comp;
  create.kind = api::LayerKind::group;
  create.name = name;
  create.parent = layer_parent_of(d, comp, layer);
  create.index = stack_index_of(d, comp, layer);
  const std::string g = handle(create, x).layer;
  const std::string tId = g + "_t";
  for (const char* k : {"x", "y", "rotation", "anchorX", "anchorY"}) (void)sg_write_prop(d, g, tId, k, Json::number(num(k, 0)));
  for (const char* k : {"scaleX", "scaleY"}) (void)sg_write_prop(d, g, tId, k, Json::number(num(k, 1)));
  (void)sg_write_prop(d, g, tId, "width", Json::number(num("width", 100)));
  (void)sg_write_prop(d, g, tId, "height", Json::number(num("height", 100)));
  double opacity = 100;
  for (const Component& c : n.components) {
    if (c.props.at("opacity").is_finite_number()) {
      opacity = c.props.at("opacity").num();
      break;
    }
  }
  if (const Component* s = d.node(g)->comp("Style"); s != nullptr) (void)sg_write_prop(d, g, s->id, "opacity", Json::number(opacity));
  else (void)sg_add_component(d, g, Component{g + "_s", "Style", [&] { Json o = Json::object(); o.set("opacity", Json::number(opacity)); return o; }()});
  if (const NodeAnim* a = d.anim(layer); a != nullptr) {
    d.set_anim(g, *a);
    remint_key_ids(x, g);
  }
  if (const auto bars = geoms_of(d, layer, comp); !bars.empty()) write_geoms(d, comp, g, bars);
  return g;
}

/// One SVG part as a layer of the group (sceneInsert.ts insertSvgShapeGroup's
/// per-part build), placed relative to the group: the viewport mapped onto the
/// SVG layer's box (kx, ky). Images are left out (they need a footage item).
std::optional<std::string> svg_part_layer(const SvgPart& part, const std::string& comp, const std::string& group,
                                          std::uint32_t index, double vw, double vh, double kx, double ky, HCtx& x) {
  Document& d = x.d;
  if (part.kind == SvgPart::Kind::image) return std::nullopt;
  const double k = std::sqrt(std::abs(kx * ky));
  const double relX = (part.centerX - vw / 2) * kx;
  const double relY = (part.centerY - vh / 2) * ky;
  api::CreateLayer create;
  create.comp = comp;
  create.kind = part.kind == SvgPart::Kind::text ? api::LayerKind::text : api::LayerKind::path;
  create.name = part.name;
  create.parent = group;
  create.index = index;
  const std::string id = handle(create, x).layer;
  const std::string tId = id + "_t";
  (void)sg_write_prop(d, id, tId, "x", Json::number(relX));
  (void)sg_write_prop(d, id, tId, "y", Json::number(relY));
  (void)sg_write_prop(d, id, tId, "width", Json::number(part.width * kx));
  (void)sg_write_prop(d, id, tId, "height", Json::number(part.height * ky));
  const double opacity = std::round(std::clamp(part.opacity, 0.0, 1.0) * 100);
  if (part.kind == SvgPart::Kind::text) {
    const Component* t = d.node(id)->comp("Text");
    if (t == nullptr) return id;
    const std::string cId = t->id;
    (void)sg_write_prop(d, id, cId, "content", Json::string(part.text));
    (void)sg_write_prop(d, id, cId, "fontSize", Json::number(part.fontSize * k));
    (void)sg_write_prop(d, id, cId, "fill", Json::string(part.fill != "transparent" ? part.fill : "#ffffff"));
    (void)sg_write_prop(d, id, cId, "opacity", Json::number(opacity));
    if (!part.fontFamily.empty()) (void)sg_write_prop(d, id, cId, "fontFamily", Json::string(part.fontFamily));
    if (!part.fontWeight.empty()) (void)sg_write_prop(d, id, cId, "fontWeight", Json::string(part.fontWeight));
    if (!part.fontStyle.empty()) (void)sg_write_prop(d, id, cId, "fontStyle", Json::string(part.fontStyle));
    return id;
  }
  (void)sg_write_prop(d, id, id + "_s", "opacity", Json::number(opacity));
  (void)sg_write_prop(d, id, id + "_s", "fill", Json::string(part.fill));
  Json runs = Json::array();
  for (const GeoRun& r : part.runs) {
    GeoRun scaled = r;
    for (GeoPt& p : scaled.points) {
      p = GeoPt{p.x * kx, p.y * ky, p.inX * kx, p.inY * ky, p.outX * kx, p.outY * ky};
    }
    runs.arr_mut().push_back(run_json(scaled));
  }
  Json g = Json::object();
  g.set("subpaths", std::move(runs));
  (void)sg_add_component(d, id, Component{id + "_g", "Geometry", std::move(g)});
  if (!part.fillPaint.is_undefined()) {
    Json fp = part.fillPaint;
    if (part.fillAboveStroke && !part.stroke.is_undefined()) fp.set("composite", Json::string("above"));
    sg_set_fx(d, id, "fill", std::move(fp));
  } else if (part.fillAboveStroke && !part.stroke.is_undefined() && part.fill != "transparent") {
    Json fp = Json::object();
    fp.set("type", Json::string("solid"));
    fp.set("color", Json::string(part.fill));
    fp.set("composite", Json::string("above"));
    sg_set_fx(d, id, "fill", std::move(fp));
  }
  if (!part.stroke.is_undefined()) {
    Json st = part.stroke;
    const double sk = part.nonScalingStroke ? 1 : k;
    st.set("width", Json::number(st.at("width").num() * sk));
    if (st.at("dash").is_array()) {
      Json dash = Json::array();
      for (const Json& v : st.at("dash").arr()) dash.arr_mut().push_back(Json::number(v.num() * sk));
      st.set("dash", std::move(dash));
    }
    if (st.at("dashOffset").is_number()) st.set("dashOffset", Json::number(st.at("dashOffset").num() * sk));
    sg_set_fx(d, id, "stroke", std::move(st));
  }
  return id;
}

struct SvgInput {
  SvgShapes shapes;
  std::string comp;
  double kx = 1, ky = 1;
};

SvgInput svg_input(const std::string& layer, HCtx& x) {
  Document& d = x.d;
  const Node& n = *d.node(layer);
  const std::optional<std::string> markup = svg_markup_of(n, x);
  if (!markup) fail(ErrorCode::invalid_argument, "the layer draws no SVG document", {.layer = layer});
  std::string why;
  std::optional<SvgShapes> shapes = x.geometry->svg_shapes(*markup, std::nullopt, why);
  if (!shapes) fail(ErrorCode::invalid_argument, "the SVG could not be converted: " + why, {.layer = layer});
  SvgInput in;
  in.comp = comp_of_layer(d, layer).value_or("");
  const Json& tp = transform_props(n);
  const double lw = tp.at("width").is_finite_number() ? tp.at("width").num() : shapes->width;
  const double lh = tp.at("height").is_finite_number() ? tp.at("height").num() : shapes->height;
  in.kx = shapes->width > 0 ? lw / shapes->width : 1;
  in.ky = shapes->height > 0 ? lh / shapes->height : 1;
  in.shapes = std::move(*shapes);
  return in;
}

/// Convert to Editable Shapes in the engine (svgConvert.ts buildSvgShapeGroup
/// + svgLayerActions' pasteLayers / deleteLayers): a group carrying the SVG
/// layer's transform, one shape / text layer per part in paint order, the
/// original markup retained on the group (Revert to Original SVG), the SVG
/// layer removed.
api::LayerList shapes_from_vector(const std::string& layer, HCtx& x) {
  Document& d = x.d;
  SvgInput in = svg_input(layer, x);
  std::size_t convertible = 0;
  for (const SvgPart& p : in.shapes.parts) convertible += p.kind == SvgPart::Kind::image ? 0 : 1;
  if (convertible == 0) fail(ErrorCode::invalid_argument, "the SVG has no vector paths or text to convert", {.layer = layer});
  const Node& n = *d.node(layer);
  const std::string name = n.name;
  std::optional<Component> retained;
  if (const Component* c = n.comp("svg"); c != nullptr) {
    Json props = c->props;
    props.erase("sanitizedMarkup");
    props.erase("__kind");
    retained = Component{"", "svg", std::move(props)};
  }
  const std::string group = svg_carrier(layer, in.comp, name, x);
  std::vector<std::string> out{group};
  const std::uint32_t top = stack_index_of(d, in.comp, group) + 1;
  for (const SvgPart& part : in.shapes.parts) {
    // Paint order: each later part is created in front of the ones before.
    if (auto id = svg_part_layer(part, in.comp, group, top, in.shapes.width, in.shapes.height, in.kx, in.ky, x)) out.push_back(*id);
  }
  if (retained) {
    retained->id = group + "_svgsrc";
    (void)sg_add_component(d, group, std::move(*retained));
  }
  api::DeleteLayers del;
  del.layers = {layer};
  (void)handle(del, x);
  x.label = "Convert SVG to Editable Shapes";
  return api::LayerList{out};
}

/// Convert to Editable Text (AE's, for an SVG's <text>): a group of text
/// layers over the SVG layer, one per <text> element, in place; the SVG layer
/// stays and stops drawing its own text (a `text { display: none }` rule on
/// its drawn markup — its retained original is untouched).
api::LayerList editable_text(const std::string& layer, HCtx& x) {
  Document& d = x.d;
  SvgInput in = svg_input(layer, x);
  std::vector<const SvgPart*> texts;
  for (const SvgPart& p : in.shapes.parts) {
    if (p.kind == SvgPart::Kind::text) texts.push_back(&p);
  }
  if (texts.empty()) fail(ErrorCode::invalid_argument, "the SVG has no text to make editable", {.layer = layer});
  const std::string name = d.node(layer)->name + " Text";
  const std::string group = svg_carrier(layer, in.comp, name, x);
  std::vector<std::string> out{group};
  const std::uint32_t top = stack_index_of(d, in.comp, group) + 1;
  for (const SvgPart* part : texts) {
    if (auto id = svg_part_layer(*part, in.comp, group, top, in.shapes.width, in.shapes.height, in.kx, in.ky, x)) out.push_back(*id);
  }
  // The SVG layer keeps its graphics and hides its own text.
  static constexpr std::string_view kHide = "<style>text { display: none !important; }</style>";
  const Node& n = *d.node(layer);
  if (const Component* c = n.comp("svg"); c != nullptr) {
    const std::string cid = c->id;
    const Json& san = c->props.at("sanitizedMarkup");
    std::string drawn = san.is_string() && !san.str().empty() ? san.str() : (c->props.at("sourceMarkup").is_string() ? c->props.at("sourceMarkup").str() : std::string());
    if (const std::size_t close = drawn.rfind("</svg>"); close != std::string::npos) drawn.insert(close, kHide);
    (void)sg_write_prop(d, layer, cid, "sanitizedMarkup", Json::string(std::move(drawn)));
  } else {
    fail(ErrorCode::unsupported, "an SVG footage layer's text cannot be hidden in place: convert it to editable shapes instead",
         {.layer = layer});
  }
  x.label = "Convert to Editable Text";
  return api::LayerList{out};
}

// ── Uncompose ───────────────────────────────────────────────────────────────

/// Move a layer's Position by (dx, dy): the static value and every key.
/// (A Position expression computes its own value and is left as it is.)
void offset_position(HCtx& x, const std::string& id, double dx, double dy) {
  Document& d = x.d;
  const Catalog cat = catalog_for(d, id);
  const PropBinding& pos = require_binding(cat, "transform/position");
  const std::array<double, 2> off{dx, dy};
  for (std::size_t i = 0; i < 2 && i < pos.members.size(); ++i) {
    const std::string& m = pos.members[i];
    if (const std::vector<Key>* keys = anim_track(d, id, m); keys != nullptr && !keys->empty()) {
      std::vector<Key> moved = *keys;
      for (Key& k : moved) k.value += off[i];
      anim_set_track(d, id, m, std::move(moved));
    }
  }
  if (const Component* t = d.node(id)->comp("Transform"); t != nullptr) {
    const std::string cid = t->id;
    const double px = t->props.at("x").is_finite_number() ? t->props.at("x").num() : 0;
    const double py = t->props.at("y").is_finite_number() ? t->props.at("y").num() : 0;
    (void)sg_write_prop(d, id, cid, "x", Json::number(px + dx));
    (void)sg_write_prop(d, id, cid, "y", Json::number(py + dy));
  }
}

/// Why a precomp layer cannot be flattened without changing the picture; "" = it can.
std::string uncompose_blocker(const Document& d, const Node& n, const api::LayerTiming& t) {
  if (!read_node_effects(n).empty()) return "it has effects (they apply to the composed picture)";
  if (const auto m = read_node_mask(n); m && m->at("paths").is_array() && !m->at("paths").arr().empty()) return "it has masks";
  if (is_3d_enabled(n)) return "it is a 3D layer";
  if (read_comp_collapse(n)) return "Collapse Transformations is on";
  if (t.time_remap_enabled || t.retime != api::RetimeMode::normal || t.freeze) return "it is time-remapped or frozen";
  if (std::abs(t.stretch - 1) > 1e-9 && std::abs(t.stretch - 100) > 1e-9) return "it is time-stretched";
  for (const Component& c : n.components) {
    if (c.props.at("opacity").is_finite_number() && c.props.at("opacity").num() != 100) return "its opacity is not 100%";
    if (c.props.at("blendMode").is_string() && c.props.at("blendMode").str() != "normal") return "it has a blend mode";
  }
  if (const NodeAnim* a = d.anim(n.id); a != nullptr && (a->tracks.contains("opacity") || a->exprs.contains("opacity"))) {
    return "its opacity is animated";
  }
  return "";
}

/// Precomp → layers: the composition's layers pasted into this one under a
/// null that carries the precomp layer's transform (its keys too), retimed by
/// the layer's start and trimmed to its span; the precomp layer removed (the
/// composition stays in the project). A layer whose picture depends on being
/// composed (effects, masks, 3D, collapse, retime, opacity, blend) is refused.
api::LayerList uncompose(const std::string& layer, HCtx& x) {
  Document& d = x.d;
  const Node& n = *d.node(layer);
  if (!is_precomp(n)) fail(ErrorCode::invalid_argument, "only a precomp layer can be uncomposed", {.layer = layer});
  const std::optional<std::string> inner = read_comp_ref(n);
  if (!inner || !is_comp_item(d, *inner)) fail(ErrorCode::not_found, "the precomp layer's composition is gone", {.layer = layer});
  const std::string outer = comp_of_layer(d, layer).value_or("");
  const api::LayerTiming timing = layer_timing(d, layer);
  if (const std::string why = uncompose_blocker(d, n, timing); !why.empty()) {
    fail(ErrorCode::unsupported, "the layer cannot be uncomposed without changing the picture: " + why, {.layer = layer});
  }
  const double fps = comp_fps(d, outer);
  if (std::abs(comp_fps(d, *inner) - fps) > 1e-9) {
    fail(ErrorCode::unsupported, "the precomp's frame rate differs from this composition's", {.layer = layer});
  }
  // Inner composition geometry.
  double iw = 1920;
  double ih = 1080;
  if (const Json* rec = d.comp(*inner); rec != nullptr && rec->at("width").is_number() && rec->at("height").is_number()) {
    iw = rec->at("width").num();
    ih = rec->at("height").num();
  }
  std::vector<std::string> tops = sg_child_order(d, *inner);
  std::reverse(tops.begin(), tops.end());  // front-first, the fragment order
  std::erase_if(tops, [&d](const std::string& id) { return d.node(id) == nullptr; });
  if (tops.empty()) fail(ErrorCode::invalid_argument, "the precomp's composition has no layers", {.layer = layer});
  const api::DocumentFragment frag = encode_fragment(x.pc(), tops);
  const std::string name = n.name;
  const Json tp = transform_props(n);
  const auto num = [&tp](std::string_view k, double fb) { return tp.at(k).is_finite_number() ? tp.at(k).num() : fb; };
  const std::vector<Geo> bars = geoms_of(d, layer, outer);
  const std::optional<NodeAnim> anim = d.anim(layer) != nullptr ? std::optional<NodeAnim>(*d.anim(layer)) : std::nullopt;

  // The carrier: a null with the precomp layer's transform and span.
  api::CreateLayer create;
  create.comp = outer;
  create.kind = api::LayerKind::null;
  create.name = name;
  create.parent = layer_parent_of(d, outer, layer);
  create.index = stack_index_of(d, outer, layer);
  const std::string carrier = handle(create, x).layer;
  const std::string tId = carrier + "_t";
  (void)sg_write_prop(d, carrier, tId, "x", Json::number(num("x", 0)));
  (void)sg_write_prop(d, carrier, tId, "y", Json::number(num("y", 0)));
  (void)sg_write_prop(d, carrier, tId, "rotation", Json::number(num("rotation", 0)));
  (void)sg_write_prop(d, carrier, tId, "scaleX", Json::number(num("scaleX", 1)));
  (void)sg_write_prop(d, carrier, tId, "scaleY", Json::number(num("scaleY", 1)));
  const double ax = num("anchorX", 0);
  const double ay = num("anchorY", 0);
  (void)sg_write_prop(d, carrier, tId, "anchorX", Json::number(ax));
  (void)sg_write_prop(d, carrier, tId, "anchorY", Json::number(ay));
  (void)sg_write_prop(d, carrier, tId, "width", Json::number(iw));
  (void)sg_write_prop(d, carrier, tId, "height", Json::number(ih));
  if (anim) {
    d.set_anim(carrier, anim);
    remint_key_ids(x, carrier);
  }
  if (!bars.empty()) write_geoms(d, outer, carrier, bars);

  // The layers, under the carrier, shifted by the layer's start and trimmed to its span.
  api::PasteLayers paste;
  paste.comp = outer;
  paste.fragment = frag;
  paste.parent = carrier;
  const std::vector<std::string> pasted = handle(paste, x).layers;
  // A child sits in its parent's centre-origin space; the inner layers'
  // positions are inner-comp pixels (top-left origin) and the composed picture
  // is drawn about the precomp layer's anchor: move each top-level layer (its
  // keys too) by −(centre + anchor).
  for (const std::string& id : pasted) {
    const Node* pn = d.node(id);
    if (pn != nullptr && pn->parent == carrier) offset_position(x, id, -(iw / 2 + ax), -(ih / 2 + ay));
  }
  const double shift = flicks_to_frames(timing.start_time, fps);
  const double spanIn = flicks_to_frames(timing.in_point, fps);
  const double spanOut = flicks_to_frames(timing.out_point, fps);
  std::vector<std::string> outside;
  for (const std::string& id : pasted) {
    std::vector<Geo> g = geoms_of(d, id, outer);
    std::vector<Geo> kept;
    for (Geo b : g) {
      b.start += shift;
      const double s = std::max(b.start, spanIn);
      const double e = std::min(b.start + b.duration, spanOut);
      if (e <= s) continue;
      b.sourceIn += s - b.start;
      b.duration = e - s;
      b.start = s;
      kept.push_back(b);
    }
    if (kept.empty()) outside.push_back(id);
    else write_geoms(d, outer, id, kept);
  }
  // A layer the precomp never showed is not brought out.
  std::erase_if(outside, [&d](const std::string& id) { return d.node(id) == nullptr; });
  if (!outside.empty()) {
    api::DeleteLayers drop;
    drop.layers = outside;
    (void)handle(drop, x);
  }
  api::DeleteLayers del;
  del.layers = {layer};
  (void)handle(del, x);
  x.label = "Uncompose";
  std::vector<std::string> out{carrier};
  for (const std::string& id : pasted) {
    if (d.node(id) != nullptr) out.push_back(id);
  }
  return api::LayerList{out};
}

}  // namespace

ResultOf<api::ConvertLayer> handle(const api::ConvertLayer& c, HCtx& x) {
  (void)require_layer(x.d, c.layer);
  require_geometry(x, std::string(api::to_string(c.conversion)));
  switch (c.conversion) {
    case api::LayerConversion::bake_transform: return bake_transform(c.layer, x);
    case api::LayerConversion::shapes_from_text: return shapes_from_text(c.layer, x);
    case api::LayerConversion::masks_from_text: return masks_from_text(c.layer, x);
    case api::LayerConversion::uncompose: return uncompose(c.layer, x);
    case api::LayerConversion::shapes_from_vector: return shapes_from_vector(c.layer, x);
    case api::LayerConversion::editable_text: return editable_text(c.layer, x);
    default: break;
  }
  fail(ErrorCode::unsupported, "'" + std::string(api::to_string(c.conversion)) +
                                   "' is not ported to the engine yet (the editor builds it: the SVG parser, "
                                   "a picture-preserving precomp flatten)",
       {.layer = c.layer});
}

ResultOf<api::SeparateLayer> handle(const api::SeparateLayer& c, HCtx& x) {
  Document& d = x.d;
  (void)require_layer(d, c.layer);
  require_geometry(x, "separateLayer");
  const Node& node = *d.node(c.layer);
  if (node.kind() != "shape") {
    fail(ErrorCode::unsupported, "only a shape layer's outline runs are separated in this engine", {.layer = c.layer});
  }
  const Component* g = node.comp("Geometry");
  const Json runs = g != nullptr ? g->props.at("subpaths") : Json();
  if (!runs.is_array() || runs.arr().size() < 2) {
    fail(ErrorCode::invalid_argument, "the layer's outline is one run: there is nothing to separate", {.layer = c.layer});
  }
  if (anim_is_data_animated(d, c.layer, kShapePathTrack)) {
    fail(ErrorCode::animated, "the layer's outline is animated; separate it before keying the path", {.layer = c.layer});
  }
  const std::string name = node.name;
  const std::size_t n = runs.arr().size();
  std::vector<std::string> parts;
  for (std::size_t i = 0; i < n; ++i) {
    api::DuplicateLayers dup;
    dup.layers = {c.layer};
    const std::string part = handle(dup, x).layers.at(0);
    const Component* pg = d.node(part)->comp("Geometry");
    if (pg == nullptr) fail(ErrorCode::internal, "the copy has no outline", {.layer = part});
    const std::string gid = pg->id;
    Json one = Json::array();
    one.arr_mut().push_back(runs.arr()[i]);
    (void)sg_write_prop(d, part, gid, "subpaths", one);
    d.node_mut(part).name = name + " " + std::to_string(i + 1);
    parts.push_back(part);
  }
  api::DeleteLayers del;
  del.layers = {c.layer};
  (void)handle(del, x);
  x.label = "Separate Layer";
  return api::LayerList{parts};
}

}  // namespace premation::doc
