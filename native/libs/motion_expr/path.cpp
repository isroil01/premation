// AE path properties in expressions: a mask's Mask Path and a shape's Path.
//
//   value / thisProperty on a path property, mask("Mask 1").maskPath,
//   content("Path 1").path, thisComp.layer("A").mask("M").maskPath — a path
//   object with AE's methods:
//     points(t = time), inTangents(t), outTangents(t)  arrays of [x, y]
//                                                       (tangents relative to their vertex)
//     isClosed()
//     pointOnPath(p = 0.5, t), tangentOnPath(p, t),     at fraction p of the path's
//     normalOnPath(p, t)                                ARC LENGTH, as AE measures it
//     createPath(...)                                   (also a method, as in AE)
//   createPath(points = [], inTangents = [], outTangents = [], isClosed = true)
//
// A path object is a plain object (fn = kCreatePath marks it) whose `elems`
// hold its points / in / out arrays and its closed flag; one read from a layer
// keeps where it came from (`bound` layer, `aux` 1 mask / 2 shape, `arg` the
// mask name) so `points(t)` at another time asks the host for that time.

#include <algorithm>
#include <cmath>
#include <optional>
#include <vector>

#include "interp.hpp"
#include "ops.hpp"

namespace motion::expr::detail {
namespace {

constexpr std::uint8_t kFromMask = 1;
constexpr std::uint8_t kFromShape = 2;
/// Samples per cubic segment for the arc-length table.
constexpr int kArcSamples = 48;

using Pt = std::array<double, 2>;

bool is_path_object(const Value& v) {
  return v.tag == Tag::kObject && v.o->kind == ObjKind::kPlain && v.o->fn == Fn::kCreatePath && v.o->elems.size() == 4;
}

/// An array of [x, y] pairs (the AE shape of points / tangents); nullopt when it is not one.
std::optional<std::vector<Pt>> pairs_of(const Value& v) {
  const Value a = unwrap_prop(v);
  if (!is_array(a)) return std::nullopt;
  std::vector<Pt> out;
  out.reserve(a.o->elems.size());
  for (const Value& e : a.o->elems) {
    const Value p = unwrap_prop(e);
    if (!is_array(p) || p.o->elems.size() < 2) return std::nullopt;
    const double x = to_number(unwrap_prop(p.o->elems[0]));
    const double y = to_number(unwrap_prop(p.o->elems[1]));
    if (!std::isfinite(x) || !std::isfinite(y)) return std::nullopt;
    out.push_back({x, y});
  }
  return out;
}

Pt cubic(const Pt& p0, const Pt& c0, const Pt& c1, const Pt& p1, double t) {
  const double u = 1 - t;
  const double a = u * u * u;
  const double b = 3 * u * u * t;
  const double c = 3 * u * t * t;
  const double d = t * t * t;
  return {a * p0[0] + b * c0[0] + c * c1[0] + d * p1[0], a * p0[1] + b * c0[1] + c * c1[1] + d * p1[1]};
}

Pt cubic_d(const Pt& p0, const Pt& c0, const Pt& c1, const Pt& p1, double t) {
  const double u = 1 - t;
  return {3 * u * u * (c0[0] - p0[0]) + 6 * u * t * (c1[0] - c0[0]) + 3 * t * t * (p1[0] - c1[0]),
          3 * u * u * (c0[1] - p0[1]) + 6 * u * t * (c1[1] - c0[1]) + 3 * t * t * (p1[1] - c1[1])};
}

struct Segment {
  Pt p0, c0, c1, p1;
};

std::vector<Segment> segments_of(const PathSample& s) {
  std::vector<Segment> out;
  const std::size_t n = s.points.size();
  if (n < 2) return out;
  const auto tan = [](const std::vector<Pt>& v, std::size_t i) { return i < v.size() ? v[i] : Pt{0, 0}; };
  const std::size_t count = s.closed ? n : n - 1;
  for (std::size_t i = 0; i < count; ++i) {
    const std::size_t j = (i + 1) % n;
    const Pt& a = s.points[i];
    const Pt& b = s.points[j];
    const Pt o = tan(s.out_tangents, i);
    const Pt in = tan(s.in_tangents, j);
    out.push_back({a, {a[0] + o[0], a[1] + o[1]}, {b[0] + in[0], b[1] + in[1]}, b});
  }
  return out;
}

/// The point and unit tangent at fraction `p` (0..1) of the path's arc length.
struct OnPath {
  Pt point{0, 0};
  Pt tangent{1, 0};
};

OnPath on_path(const PathSample& s, double p) {
  OnPath r;
  if (s.points.empty()) return r;
  const std::vector<Segment> segs = segments_of(s);
  if (segs.empty()) {
    r.point = s.points.front();
    return r;
  }
  // Cumulative chord lengths of a fine polyline per segment.
  std::vector<double> lens;
  lens.reserve(segs.size() * kArcSamples + 1);
  lens.push_back(0);
  for (const Segment& g : segs) {
    Pt prev = g.p0;
    for (int k = 1; k <= kArcSamples; ++k) {
      const Pt q = cubic(g.p0, g.c0, g.c1, g.p1, static_cast<double>(k) / kArcSamples);
      lens.push_back(lens.back() + std::hypot(q[0] - prev[0], q[1] - prev[1]));
      prev = q;
    }
  }
  const double total = lens.back();
  const double target = std::clamp(p, 0.0, 1.0) * total;
  std::size_t i = static_cast<std::size_t>(std::upper_bound(lens.begin(), lens.end(), target) - lens.begin());
  i = std::clamp<std::size_t>(i, 1, lens.size() - 1);
  const double span = lens[i] - lens[i - 1];
  const double f = span > 0 ? (target - lens[i - 1]) / span : 0;
  const std::size_t sample = i - 1;
  const std::size_t seg = std::min(sample / kArcSamples, segs.size() - 1);
  const double t = (static_cast<double>(sample - seg * kArcSamples) + f) / kArcSamples;
  const Segment& g = segs[seg];
  r.point = cubic(g.p0, g.c0, g.c1, g.p1, t);
  Pt d = cubic_d(g.p0, g.c0, g.c1, g.p1, t);
  double len = std::hypot(d[0], d[1]);
  if (len < 1e-12) {  // a cusp / zero handle: the chord's direction
    d = {g.p1[0] - g.p0[0], g.p1[1] - g.p0[1]};
    len = std::hypot(d[0], d[1]);
  }
  if (len > 1e-12) r.tangent = {d[0] / len, d[1] / len};
  return r;
}

}  // namespace

Value Interp::make_path(PathSample sample, const Value& layer, std::uint8_t source, const Value& name) {
  Obj* o = arena_.obj(ObjKind::kPlain);
  o->fn = Fn::kCreatePath;  // marks a path object (is_path_object)
  o->aux = source;
  o->bound = layer;
  o->arg = name;
  const auto list = [&](const std::vector<Pt>& v) {
    std::vector<Value> e;
    e.reserve(v.size());
    for (const Pt& p : v) e.push_back(array({Value::number(p[0]), Value::number(p[1])}));
    return array(std::move(e));
  };
  // Tangent lists as long as the points (a missing tangent is [0, 0]).
  const std::size_t n = sample.points.size();
  sample.in_tangents.resize(n, {0, 0});
  sample.out_tangents.resize(n, {0, 0});
  o->elems = {list(sample.points), list(sample.in_tangents), list(sample.out_tangents), Value::boolean(sample.closed)};
  const Value self = Value::object(o);
  o->props = {
      {.key = KeyId::k_points, .value = bound_fn(Fn::kPathPoints, self)},
      {.key = KeyId::k_inTangents, .value = bound_fn(Fn::kPathInTangents, self)},
      {.key = KeyId::k_outTangents, .value = bound_fn(Fn::kPathOutTangents, self)},
      {.key = KeyId::k_isClosed, .value = bound_fn(Fn::kPathIsClosed, self)},
      {.key = KeyId::k_pointOnPath, .value = bound_fn(Fn::kPathPointOnPath, self)},
      {.key = KeyId::k_tangentOnPath, .value = bound_fn(Fn::kPathTangentOnPath, self)},
      {.key = KeyId::k_normalOnPath, .value = bound_fn(Fn::kPathNormalOnPath, self)},
      {.key = KeyId::k_createPath, .value = fn_value(Fn::kCreatePath)},
  };
  return self;
}

Value Interp::create_path(Args a) {
  // AE: createPath(points = [[0,0], [100,0], [100,100], [0,100]], inTangents = [], outTangents = [], is_closed = true).
  PathSample s;
  if (a.size() == 0 || a[0].is_undefined()) {
    s.points = {{0, 0}, {100, 0}, {100, 100}, {0, 100}};
  } else {
    auto pts = pairs_of(a[0]);
    if (!pts) throw_eval(u"createPath: points must be an array of [x, y] pairs.");
    s.points = std::move(*pts);
  }
  for (const std::size_t i : {std::size_t{1}, std::size_t{2}}) {
    if (a[i].is_nullish()) continue;
    auto t = pairs_of(a[i]);
    if (!t) throw_eval(i == 1 ? Str(u"createPath: inTangents must be an array of [x, y] pairs.")
                              : Str(u"createPath: outTangents must be an array of [x, y] pairs."));
    if (!t->empty() && t->size() != s.points.size()) {
      throw_eval(Str(i == 1 ? u"createPath: inTangents" : u"createPath: outTangents") +
                 u" must have one [x, y] per point (or be empty).");
    }
    (i == 1 ? s.in_tangents : s.out_tangents) = std::move(*t);
  }
  s.closed = a[3].is_undefined() ? true : truthy(unwrap_prop(a[3]));
  return make_path(std::move(s), Value::null(), 0, Value{});
}

Value Interp::path_method(Fn fn, Obj& self, Args a) {
  // The path at another time: a layer's path asks the host; a built one is the same at every time.
  const auto sample_of = [&](const Obj& o) {
    PathSample s;
    s.points = *pairs_of(o.elems[0]);
    s.in_tangents = *pairs_of(o.elems[1]);
    s.out_tangents = *pairs_of(o.elems[2]);
    s.closed = o.elems[3].b;
    return s;
  };
  const Value timeArg = fn == Fn::kPathPoints || fn == Fn::kPathInTangents || fn == Fn::kPathOutTangents || fn == Fn::kPathIsClosed
                            ? a[0]
                            : a[1];
  PathSample s = sample_of(self);
  if (!timeArg.is_nullish() && self.aux != 0 && ctx_.host != nullptr) {
    const double t = to_number(unwrap_prop(timeArg));
    if (std::isfinite(t) && t != ctx_.time) {
      const bool self_layer = self.bound.is_null();
      Str layer;
      if (!self_layer) layer = to_string(self.bound);
      Str name;
      const bool named = self.arg.is_string();
      if (named) name = *self.arg.s;
      if (auto other = ctx_.host->path_at(self_layer ? nullptr : &layer, self.aux == kFromMask, named ? &name : nullptr, t)) {
        s = std::move(*other);
      }
    }
  }
  const auto list = [&](const std::vector<Pt>& v, std::size_t n) {
    std::vector<Value> e;
    e.reserve(n);
    for (std::size_t i = 0; i < n; ++i) {
      const Pt q = i < v.size() ? v[i] : Pt{0, 0};
      e.push_back(array({Value::number(q[0]), Value::number(q[1])}));
    }
    return array(std::move(e));
  };
  switch (fn) {
    case Fn::kPathPoints: return list(s.points, s.points.size());
    case Fn::kPathInTangents: return list(s.in_tangents, s.points.size());
    case Fn::kPathOutTangents: return list(s.out_tangents, s.points.size());
    case Fn::kPathIsClosed: return Value::boolean(s.closed);
    default: break;
  }
  const double p = a[0].is_undefined() ? 0.5 : to_number(unwrap_prop(a[0]));
  if (!std::isfinite(p)) throw_eval(u"pointOnPath: the percentage must be a number from 0 to 1.");
  const OnPath at = on_path(s, p);
  switch (fn) {
    case Fn::kPathPointOnPath: return array({Value::number(at.point[0]), Value::number(at.point[1])});
    case Fn::kPathTangentOnPath: return array({Value::number(at.tangent[0]), Value::number(at.tangent[1])});
    // AE's normal is the tangent turned a quarter turn: outward on a clockwise (screen) path.
    default: return array({Value::number(at.tangent[1]), Value::number(-at.tangent[0])});
  }
}

Value Interp::layer_mask(const Value& layer, const Value& name) {
  // AE: mask("Mask 1") by name, or mask(1) by index (the host resolves both through the name text).
  Obj* o = arena_.obj(ObjKind::kPlain);
  o->bound = layer;
  o->aux = kFromMask;
  o->arg = name.is_undefined() ? Value{} : str(to_string(unwrap_prop(name)));
  o->props = {
      {.key = KeyId::k_name, .value = o->arg},
      {.key = KeyId::k_maskPath, .value = {}, .lazy = Lazy::kPathOf},
  };
  return Value::object(o);
}

Value Interp::layer_content(const Value& layer, const Value& name) {
  // A Premation shape layer draws ONE path: content("Shape 1").content("Path 1").path reads it,
  // whichever names lead there (AE's own group names are kept as written).
  Obj* o = arena_.obj(ObjKind::kPlain);
  o->bound = layer;
  o->aux = kFromShape;
  o->arg = name.is_undefined() ? Value{} : str(to_string(unwrap_prop(name)));
  o->props = {
      {.key = KeyId::k_name, .value = o->arg},
      {.key = KeyId::k_path, .value = {}, .lazy = Lazy::kPathOf},
      {.key = KeyId::k_content, .value = bound_fn(Fn::kLayerContent, layer)},
  };
  return Value::object(o);
}

Value Interp::path_of(Obj& holder) {
  const bool mask = holder.aux == kFromMask;
  const bool self_layer = holder.bound.is_null();
  Str layer;
  if (!self_layer) layer = to_string(holder.bound);
  Str name;
  const bool named = mask && holder.arg.is_string();
  if (named) name = *holder.arg.s;
  std::optional<PathSample> s;
  if (ctx_.host != nullptr) s = ctx_.host->path_at(self_layer ? nullptr : &layer, mask, named ? &name : nullptr, ctx_.time);
  if (!s) {
    if (mask) throw_eval(named ? u"mask(“" + name + u"”): the layer has no mask of that name."
                               : Str(u"mask(): the layer has no mask."));
    throw_eval(u"content(...).path: the layer draws no path (a shape layer with a Path).");
  }
  return make_path(std::move(*s), holder.bound, holder.aux, holder.arg);
}

/// `runPath`'s coercion: the returned value must be a path object.
std::optional<PathSample> path_sample_of(const Value& v) {
  const Value u = unwrap_prop(v);
  if (!is_path_object(u)) return std::nullopt;
  const Obj& o = *u.o;
  auto points = pairs_of(o.elems[0]);
  auto in = pairs_of(o.elems[1]);
  auto out = pairs_of(o.elems[2]);
  if (!points || !in || !out) return std::nullopt;  // is_path_object checked these; said again for the reader
  PathSample s;
  s.points = std::move(*points);
  s.in_tangents = std::move(*in);
  s.out_tangents = std::move(*out);
  s.closed = o.elems[3].b;
  return s;
}

}  // namespace motion::expr::detail
