#include "merge_paths.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <numbers>
#include <vector>

#include "jsmath.hpp"
#include "path_ops.hpp"
#include "polygon_clipping.hpp"

namespace premation::scene {
namespace {

namespace mjs = motion::js;

struct LiveBoolean {
  pc::OpType op = pc::OpType::union_;
  std::vector<std::string> sources;
};

std::optional<LiveBoolean> read_live_boolean(const doc::Node& n) {
  const doc::Component* fx = n.comp("fx");
  if (fx == nullptr) return std::nullopt;
  const Json& op = fx->props.at("booleanOp");
  const Json& sources = fx->props.at("booleanSources");
  if (!op.is_string()) return std::nullopt;
  LiveBoolean lb;
  const std::string& o = op.str();
  if (o == "union") lb.op = pc::OpType::union_;
  else if (o == "subtract") lb.op = pc::OpType::difference;
  else if (o == "intersect") lb.op = pc::OpType::intersection;
  else if (o == "exclude") lb.op = pc::OpType::xor_;
  else return std::nullopt;
  if (!sources.is_array() || sources.arr().size() < 2) return std::nullopt;
  for (const Json& s : sources.arr()) {
    if (s.is_string() && !s.str().empty()) lb.sources.push_back(s.str());
  }
  if (lb.sources.size() < 2) return std::nullopt;
  return lb;
}

struct BPt {
  double x, y, inX, inY, outX, outY;
};

/// A BezierPt as the TS reads it: a missing handle is `undefined`, which the
/// flattening treats as curved and samples as NaN — kept NaN here.
std::vector<BPt> read_bezier(const Json& pts) {
  std::vector<BPt> out;
  constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
  const auto n = [](const Json& o, std::string_view k) { return o.at(k).is_number() ? o.at(k).num() : kNaN; };
  for (const Json& p : pts.arr()) out.push_back({n(p, "x"), n(p, "y"), n(p, "inX"), n(p, "inY"), n(p, "outX"), n(p, "outY")});
  return out;
}

pc::Pair cubic_at(const BPt& a, const BPt& b, double t) {
  const double u = 1 - t;
  const double w0 = u * u * u;
  const double w1 = 3 * u * u * t;
  const double w2 = 3 * u * t * t;
  const double w3 = t * t * t;
  return {w0 * a.x + w1 * a.outX + w2 * b.inX + w3 * b.x, w0 * a.y + w1 * a.outY + w2 * b.inY + w3 * b.y};
}

/// mergePaths.ts flattenOutline(pts, 8, open).
std::vector<pc::Pair> flatten_outline(const std::vector<BPt>& pts, bool open) {
  const std::size_t n = pts.size();
  std::vector<pc::Pair> out;
  if (n < 2) {
    for (const BPt& p : pts) out.push_back({p.x, p.y});
    return out;
  }
  const std::size_t segments = open ? n - 1 : n;
  for (std::size_t i = 0; i < segments; ++i) {
    const BPt& a = pts[i];
    const BPt& b = pts[(i + 1) % n];
    out.push_back({a.x, a.y});
    const bool curved = a.outX != a.x || a.outY != a.y || b.inX != b.x || b.inY != b.y;
    if (curved) {
      for (int s = 1; s < 8; ++s) out.push_back(cubic_at(a, b, s / 8.0));
    }
  }
  if (open) out.push_back({pts[n - 1].x, pts[n - 1].y});
  return out;
}

}  // namespace

/// nodeWorldOutline(node, sample, pathSample).
std::optional<WorldOutline> node_world_outline(const doc::Node& n, const std::string& id, const OperandReader& r) {
  if (n.kind() != "shape") return std::nullopt;
  const doc::Component* t = n.comp("Transform");
  if (t == nullptr) return std::nullopt;
  const Json& p = t->props;
  const motion::xf::Local2D w = r.world(id);
  const Values& m = r.values(id);
  const auto num = [&p](std::string_view k, double fb) { return p.at(k).is_number() ? p.at(k).num() : fb; };
  const double x = w.x;
  const double y = w.y;
  const double width = m.get("width").value_or(num("width", 100));
  const double height = m.get("height").value_or(num("height", 100));
  const double rot = (w.rotation * std::numbers::pi) / 180;
  const double sx = w.scale_x;
  const double sy = w.scale_y;
  WorldOutline o;
  const doc::Component* geom = n.comp("Geometry");
  const Json live = r.pathPoints(id);
  if (live.is_array() && live.arr().size() >= 3) {
    o.points = flatten_outline(read_bezier(live), false);
  } else if (geom != nullptr && geom->props.at("points").is_array() && geom->props.at("points").arr().size() >= 2) {
    o.closed = !(geom->props.at("open").is_bool() && geom->props.at("open").b());
    o.points = flatten_outline(read_bezier(geom->props.at("points")), !o.closed);
  } else {
    const std::string shapeType = p.at("shapeType").is_string() ? p.at("shapeType").str() : "rect";
    const auto corner = [&](const char* key) -> std::optional<double> {
      if (const auto live = m.get(key); live && std::isfinite(*live)) return std::max(0.0, *live);
      const Json& v = p.at(key);
      return v.is_number() && std::isfinite(v.num()) ? std::optional<double>(std::max(0.0, v.num())) : std::nullopt;
    };
    const Radii radii = clamp_corner_radii(width, height,
                                           resolve_corner_radii(corner("cornerRadius"), corner("cornerRadiusTL"), corner("cornerRadiusTR"),
                                                                corner("cornerRadiusBR"), corner("cornerRadiusBL")));
    o.points = shape_outline_points(shapeType == "ellipse" ? "ellipse" : "rect", width, height, 32, 0, radii,
                                    std::array<double, 2>{std::abs(sx), std::abs(sy)});
  }
  if (o.points.size() < 2) return std::nullopt;
  const double c = mjs::cos(rot);
  const double s = mjs::sin(rot);
  for (pc::Pair& q : o.points) {
    const double lx = q[0] * sx;
    const double ly = q[1] * sy;
    q = {x + lx * c - ly * s, y + lx * s + ly * c};
  }
  return o;
}

namespace {

Json local_bezier(const pc::Ring& ring, double cx, double cy) {
  Json out = Json::array();
  for (const pc::Pair& q : ring) {
    const double lx = q[0] - cx;
    const double ly = q[1] - cy;
    Json o = Json::object();
    o.set("x", Json::number(lx));
    o.set("y", Json::number(ly));
    o.set("inX", Json::number(lx));
    o.set("inY", Json::number(ly));
    o.set("outX", Json::number(lx));
    o.set("outY", Json::number(ly));
    out.arr_mut().push_back(std::move(o));
  }
  return out;
}

}  // namespace

bool has_live_boolean(const doc::Node& n) { return read_live_boolean(n).has_value(); }

std::optional<LiveBooleanResult> evaluate_live_boolean(const doc::Node& result, const OperandReader& r) {
  const std::optional<LiveBoolean> cfg = read_live_boolean(result);
  if (!cfg) return std::nullopt;
  std::vector<pc::Polygon> polys;
  for (const std::string& id : cfg->sources) {
    const doc::Node* n = r.node(id);
    if (n == nullptr) continue;
    // nodeWorldPolygon: a closed outline of ≥ 3 points, as a closed GeoJSON ring.
    const std::optional<WorldOutline> o = node_world_outline(*n, id, r);
    if (!o || !o->closed || o->points.size() < 3) continue;
    pc::Ring ring = o->points;
    ring.push_back(ring.front());
    polys.push_back(pc::Polygon{std::move(ring)});
  }
  if (polys.size() < 2) return std::nullopt;
  std::vector<pc::MultiPolygon> rest;
  for (std::size_t i = 1; i < polys.size(); ++i) rest.push_back(pc::MultiPolygon{polys[i]});
  const pc::MultiPolygon multi = pc::run(cfg->op, pc::MultiPolygon{polys[0]}, rest);
  // collectClosedRings: every ring, the GeoJSON closing vertex dropped, ≥ 3 points.
  std::vector<pc::Ring> rings;
  for (const pc::Polygon& poly : multi) {
    for (const pc::Ring& ring : poly) {
      pc::Ring open = ring;
      if (open.size() > 1 && open.front()[0] == open.back()[0] && open.front()[1] == open.back()[1]) open.pop_back();
      if (open.size() >= 3) rings.push_back(std::move(open));
    }
  }
  if (rings.empty()) return std::nullopt;
  constexpr double kInf = std::numeric_limits<double>::infinity();
  double minX = kInf, minY = kInf, maxX = -kInf, maxY = -kInf;
  for (const pc::Ring& ring : rings) {
    for (const auto& [px, py] : ring) {
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
  }
  LiveBooleanResult out;
  out.cx = (minX + maxX) / 2;
  out.cy = (minY + maxY) / 2;
  out.width = std::max(1.0, maxX - minX);
  out.height = std::max(1.0, maxY - minY);
  out.points = local_bezier(rings[0], out.cx, out.cy);
  if (rings.size() > 1) {
    Json subs = Json::array();
    for (const pc::Ring& ring : rings) {
      Json sp = Json::object();
      sp.set("points", local_bezier(ring, out.cx, out.cy));
      sp.set("open", Json::boolean(false));
      subs.arr_mut().push_back(std::move(sp));
    }
    out.subpaths = std::move(subs);
  }
  return out;
}

}  // namespace premation::scene
