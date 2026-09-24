// Structural outline edits (B3) — src/core/engine/handlers/paths.ts:
// `editPathTopology` replays a vertex split / removal, Set First Vertex,
// Reverse Path Direction, Continue Path and the Closed switch on EVERY state
// of a mask's or a shape layer's outline; `setShapeOutline` stores the Knife's
// runs. The replay ports packages/workspace/src/math/pathTopology.ts in the
// same arithmetic order (bit-identical under -ffp-contract=off).
#include "handlers_paths.hpp"

#include <cmath>
#include <optional>
#include <set>

#include "fxstate.hpp"
#include "props.hpp"

namespace premation::doc {

using api::ErrorCode;

namespace {

/// pathTopology.ts `PathTopologyEdit`, validated.
struct TopologyEdit {
  api::PathTopologyKind kind = api::PathTopologyKind::insert;
  std::uint32_t segment = 0;
  double u = 0;
  std::vector<std::uint32_t> indices;
  Json points;  ///< extend: the run, as stored points
  bool atStart = false;
};

TopologyEdit topology_edit(const api::PathTopologyOp& op) {
  TopologyEdit e;
  e.kind = op.kind;
  switch (op.kind) {
    case api::PathTopologyKind::insert:
      if (!(std::isfinite(op.u) && op.u > 0 && op.u < 1)) fail(ErrorCode::invalid_argument, "insert: u must be strictly inside (0, 1)");
      e.segment = op.segment;
      e.u = op.u;
      break;
    case api::PathTopologyKind::remove:
      if (op.indices.empty()) fail(ErrorCode::invalid_argument, "remove: no vertices given");
      e.indices = op.indices;
      break;
    case api::PathTopologyKind::first_vertex:
      if (op.indices.size() != 1) fail(ErrorCode::invalid_argument, "firstVertex: give exactly one vertex");
      e.indices = op.indices;
      break;
    case api::PathTopologyKind::reverse: break;
    case api::PathTopologyKind::extend: {
      if (!op.points || op.points->vertices.size() < 2) fail(ErrorCode::invalid_argument, "extend: no points given");
      api::BezierPath plain = *op.points;
      plain.feather_points.clear();
      e.points = bezier_to_points(plain, nullptr);
      for (Json& p : e.points.arr_mut()) p.erase("feather");
      e.atStart = op.at_start;
      break;
    }
  }
  return e;
}

std::string label_of(const api::PathTopologyOp& op) {
  switch (op.kind) {
    case api::PathTopologyKind::insert: return "Add Vertex";
    case api::PathTopologyKind::remove: return op.indices.size() > 1 ? "Delete Vertices" : "Delete Vertex";
    case api::PathTopologyKind::first_vertex: return "Set First Vertex";
    case api::PathTopologyKind::reverse: return "Reverse Path Direction";
    case api::PathTopologyKind::extend: return "Continue Path";
  }
  return "Edit Path";
}

double num(const Json& p, std::string_view k) { return p.at(k).num(); }

/// `withHandles`: a stored vertex with both handles (a data key may omit them — a corner).
Json with_handles(const Json& p) {
  Json q = p;
  for (const auto& [k, axis] : {std::pair{"inX", "x"}, std::pair{"inY", "y"}, std::pair{"outX", "x"}, std::pair{"outY", "y"}}) {
    if (p.at(k).is_undefined() || p.at(k).is_null()) q.set(k, p.at(axis));
  }
  return q;
}

std::size_t segment_count(std::size_t n, bool closed) {
  if (n < 2) return 0;
  return closed ? n : n - 1;
}

/// pathTopology.ts `splitSegment` (de Casteljau; the drawn curve is unchanged).
std::optional<Json> split_segment(const Json& points, std::uint32_t segment, double u, bool closed) {
  const auto& pts = points.arr();
  const std::size_t n = pts.size();
  if (segment >= segment_count(n, closed)) return std::nullopt;
  if (!(u > 0 && u < 1)) return std::nullopt;
  const std::size_t ai = segment;
  const std::size_t bi = (static_cast<std::size_t>(segment) + 1) % n;
  const Json& a = pts[ai];
  const Json& b = pts[bi];
  struct V {
    double x, y;
  };
  auto mix = [](V p, V q, double t) { return V{p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t}; };
  const V p0{num(a, "x"), num(a, "y")};
  const V p1{num(a, "outX"), num(a, "outY")};
  const V p2{num(b, "inX"), num(b, "inY")};
  const V p3{num(b, "x"), num(b, "y")};
  const V q0 = mix(p0, p1, u);
  const V q1 = mix(p1, p2, u);
  const V q2 = mix(p2, p3, u);
  const V r0 = mix(q0, q1, u);
  const V r1 = mix(q1, q2, u);
  const V s = mix(r0, r1, u);
  Json out = points;
  auto& o = out.arr_mut();
  o[ai].set("outX", Json::number(q0.x));
  o[ai].set("outY", Json::number(q0.y));
  o[bi].set("inX", Json::number(q2.x));
  o[bi].set("inY", Json::number(q2.y));
  Json mid = Json::object();
  mid.set("x", Json::number(s.x));
  mid.set("y", Json::number(s.y));
  mid.set("inX", Json::number(r0.x));
  mid.set("inY", Json::number(r0.y));
  mid.set("outX", Json::number(r1.x));
  mid.set("outY", Json::number(r1.y));
  o.insert(o.begin() + static_cast<std::ptrdiff_t>(segment) + 1, std::move(mid));
  return out;
}

/// `deleteVertices`: null when a vertex is missing or fewer than 2 would stay.
std::optional<Json> delete_vertices(const Json& points, const std::vector<std::uint32_t>& indices) {
  const std::set<std::uint32_t> drop(indices.begin(), indices.end());
  const auto& pts = points.arr();
  if (drop.empty()) return std::nullopt;
  for (const std::uint32_t i : drop) {
    if (i >= pts.size()) return std::nullopt;
  }
  if (pts.size() - drop.size() < 2) return std::nullopt;
  Json out = Json::array();
  for (std::size_t i = 0; i < pts.size(); ++i) {
    if (!drop.contains(static_cast<std::uint32_t>(i))) out.arr_mut().push_back(pts[i]);
  }
  return out;
}

/// `reversePath`: order reversed, each vertex's handles swapped.
Json reverse_path(const Json& points) {
  Json out = Json::array();
  const auto& pts = points.arr();
  for (auto it = pts.rbegin(); it != pts.rend(); ++it) {
    Json q = *it;
    q.set("inX", it->at("outX"));
    q.set("inY", it->at("outY"));
    q.set("outX", it->at("inX"));
    q.set("outY", it->at("inY"));
    out.arr_mut().push_back(std::move(q));
  }
  return out;
}

/// `setFirstVertex`: closed rotates; open only from an end (the last reverses).
std::optional<Json> set_first_vertex(const Json& points, std::uint32_t index, bool closed) {
  const auto& pts = points.arr();
  const std::size_t n = pts.size();
  if (index >= n) return std::nullopt;
  if (closed) {
    Json out = Json::array();
    for (std::size_t i = 0; i < n; ++i) out.arr_mut().push_back(pts[(index + i) % n]);
    return out;
  }
  if (index == 0) return points;
  if (index == n - 1) return reverse_path(points);
  return std::nullopt;
}

/// `applyPathTopology`: null when the edit does not apply to this outline.
std::optional<Json> apply_topology(const Json& points, const TopologyEdit& e, bool closed) {
  switch (e.kind) {
    case api::PathTopologyKind::insert: return split_segment(points, e.segment, e.u, closed);
    case api::PathTopologyKind::remove: return delete_vertices(points, e.indices);
    case api::PathTopologyKind::first_vertex: return set_first_vertex(points, e.indices[0], closed);
    case api::PathTopologyKind::reverse: return reverse_path(points);
    case api::PathTopologyKind::extend: {
      Json out = Json::array();
      auto& o = out.arr_mut();
      const auto& base = points.arr();
      const auto& extra = e.points.arr();
      if (e.atStart) {
        o.insert(o.end(), extra.begin(), extra.end());
        o.insert(o.end(), base.begin(), base.end());
      } else {
        o.insert(o.end(), base.begin(), base.end());
        o.insert(o.end(), extra.begin(), extra.end());
      }
      return out;
    }
  }
  return std::nullopt;
}

}  // namespace

ResultOf<api::EditPathTopology> handle(const api::EditPathTopology& c, HCtx& x) {
  const std::string layer = c.prop.layer;
  (void)require_layer(x.d, layer);
  const Catalog cat = catalog_for(x.d, layer);
  const PropBinding b = require_binding(cat, c.prop.path);
  if (b.special != Special::maskPath && b.special != Special::shapePath) {
    fail(ErrorCode::invalid_argument, "'" + b.path + "' is not an outline", {.layer = layer, .path = b.path});
  }
  if (!c.op && !c.closed) fail(ErrorCode::invalid_argument, "editPathTopology needs an op, closed, or both", {.layer = layer, .path = b.path});
  const std::optional<TopologyEdit> edit = c.op ? std::optional<TopologyEdit>(topology_edit(*c.op)) : std::nullopt;
  const std::optional<bool> closed = c.closed;
  const Node& node = *x.d.node(layer);
  std::size_t applied = 0;
  auto replay = [&](const Json& points, bool isClosed) -> std::optional<Json> {
    if (!edit) return std::nullopt;
    Json full = Json::array();
    for (const Json& p : points.arr()) full.arr_mut().push_back(with_handles(p));
    std::optional<Json> next = apply_topology(full, *edit, isClosed);
    if (next) ++applied;
    return next;
  };
  if (b.special == Special::maskPath) {
    const std::string maskId = *b.maskId;
    auto map_mask = [&](const Json& m) {
      Json paths = Json::array();
      for (const Json& p : m.at("paths").arr()) {
        if (!(p.at("id").is_string() && p.at("id").str() == maskId)) {
          paths.arr_mut().push_back(p);
          continue;
        }
        Json q = p;
        const bool pClosed = p.at("closed").is_bool() && p.at("closed").b();
        if (auto pts = replay(p.at("points").is_array() ? p.at("points") : Json::array(), pClosed)) q.set("points", std::move(*pts));
        if (closed) q.set("closed", Json::boolean(*closed));
        paths.arr_mut().push_back(std::move(q));
      }
      Json out = Json::object();
      out.set("paths", std::move(paths));
      return out;
    };
    std::optional<Json> stat = read_node_mask(node);
    Json empty = Json::object();
    empty.set("paths", Json::array());
    const Json nextStatic = map_mask(stat && stat->is_object() ? *stat : empty);
    const std::vector<Json> anim = read_node_mask_anim(node);
    std::vector<Json> nextAnim;
    for (const Json& k : anim) {
      Json e = k;
      e.set("mask", map_mask(k.at("mask")));
      nextAnim.push_back(std::move(e));
    }
    if (edit && applied == 0) {
      fail(ErrorCode::invalid_argument, "the " + std::string(api::to_string(c.op->kind)) + " edit applies to no state of '" + b.path + "'",
           {.layer = layer, .path = b.path});
    }
    sg_set_fx(x.d, layer, "mask", nextStatic);
    if (!anim.empty()) set_mask_anim(x.d, layer, std::move(nextAnim));
  } else {
    const Component* g = node.comp("Geometry");
    if (g == nullptr) fail(ErrorCode::not_found, "layer '" + layer + "' has no outline", {.layer = layer, .path = b.path});
    const std::string gid = g->id;
    const bool isClosed = shape_closed(node);
    const Json* stat = as_points(g->props.at("points"));
    const std::optional<Json> nextStatic = stat != nullptr ? replay(*stat, isClosed) : std::nullopt;
    const DataTrack* track = anim_data_track(x.d, layer, kShapePathTrack);
    std::optional<DataTrack> nextTrack;
    if (track != nullptr) {
      DataTrack t = *track;
      bool changed = false;
      for (DataKey& k : t.keys) {
        const Json* pts = as_points(k.value);
        std::optional<Json> next = pts != nullptr ? replay(*pts, isClosed) : std::nullopt;
        if (!next) continue;
        changed = true;
        k.value = std::move(*next);
      }
      if (changed) nextTrack = std::move(t);
    }
    if (edit && applied == 0) {
      fail(ErrorCode::invalid_argument, "the " + std::string(api::to_string(c.op->kind)) + " edit applies to no state of '" + b.path + "'",
           {.layer = layer, .path = b.path});
    }
    if (nextStatic) (void)sg_write_prop(x.d, layer, gid, "points", *nextStatic);
    if (nextTrack) anim_set_data_track(x.d, layer, kShapePathTrack, std::move(nextTrack));
    if (closed) write_shape_closed(x.d, layer, *closed);
  }
  x.label = c.op ? label_of(*c.op) : "Closed";
  return {};
}

ResultOf<api::SetShapeOutline> handle(const api::SetShapeOutline& c, HCtx& x) {
  const std::string layer = c.layer;
  (void)require_layer(x.d, layer);
  const Node& node = *x.d.node(layer);
  if (node.kind() != "shape") fail(ErrorCode::invalid_argument, "layer '" + layer + "' is not a shape layer", {.layer = layer});
  if (c.runs.empty()) fail(ErrorCode::invalid_argument, "setShapeOutline needs at least one run", {.layer = layer});
  for (const api::BezierPath& r : c.runs) {
    if (r.vertices.size() < 4) fail(ErrorCode::invalid_argument, "every run needs at least 2 vertices", {.layer = layer});
  }
  if (anim_is_data_animated(x.d, layer, kShapePathTrack)) {
    fail(ErrorCode::animated, "layer '" + layer + "' has an animated outline; its keys would win over the runs",
         {.layer = layer, .path = "layer/path.points"});
  }
  Json subpaths = Json::array();
  for (const api::BezierPath& r : c.runs) {
    Json run = Json::object();
    run.set("points", shape_points(r, nullptr, "layer/path.points"));
    run.set("open", Json::boolean(!r.closed));
    subpaths.arr_mut().push_back(std::move(run));
  }
  if (const Component* g = node.comp("Geometry")) {
    const std::string gid = g->id;
    const bool hadPoints = !g->props.at("points").is_undefined();
    (void)sg_write_prop(x.d, layer, gid, "subpaths", subpaths);
    // `points` and `subpaths` are exclusive (raster/subpaths.ts): the flat run goes.
    if (hadPoints) (void)sg_write_prop(x.d, layer, gid, "points", Json());
  } else {
    Json props = Json::object();
    props.set("subpaths", std::move(subpaths));
    (void)sg_add_component(x.d, layer, Component{layer + "_g", "Geometry", std::move(props)});
  }
  if (const Component* t = x.d.node(layer)->comp("Transform")) {
    const std::string tid = t->id;
    (void)sg_write_prop(x.d, layer, tid, "shapeType", Json::string("path"));
  }
  x.label = "Set Shape Outline";
  return {};
}

}  // namespace premation::doc
