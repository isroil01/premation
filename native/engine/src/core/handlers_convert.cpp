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
#include "handlers_groups.hpp"
#include "handlers_layers.hpp"
#include "props.hpp"
#include "readmodel.hpp"
#include "scene.hpp"
#include "time_conv.hpp"
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

}  // namespace

ResultOf<api::ConvertLayer> handle(const api::ConvertLayer& c, HCtx& x) {
  (void)require_layer(x.d, c.layer);
  require_geometry(x, std::string(api::to_string(c.conversion)));
  switch (c.conversion) {
    case api::LayerConversion::bake_transform: return bake_transform(c.layer, x);
    case api::LayerConversion::shapes_from_text: return shapes_from_text(c.layer, x);
    case api::LayerConversion::masks_from_text: return masks_from_text(c.layer, x);
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
