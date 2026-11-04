#include "core/aep/aep_plan.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <string_view>

#include "catalog_data.hpp"
#include "core/aep/aep_ease.hpp"
#include "core/aep/aep_effects.hpp"
#include "jsmath.hpp"

namespace premation::doc::aep {

namespace {

double clamp255(double v) { return std::max(0.0, std::min(255.0, motion::js::round(v))); }

/// An AE colour ([r, g, b, a] in 0–1) as `#rrggbb`.
std::string color_hex(const std::vector<double>& rgba) {
  if (rgba.size() < 3) return "#000000";
  return hex_color(rgba[0] * 255, rgba[1] * 255, rgba[2] * 255);
}

/// A layer's source: a piece of footage or a composition.
struct Source {
  const AepFootage* footage = nullptr;
  const AepComp* comp = nullptr;
  [[nodiscard]] double width() const { return footage != nullptr ? footage->width : comp->width; }
  [[nodiscard]] double height() const { return footage != nullptr ? footage->height : comp->height; }
  [[nodiscard]] const std::string& name() const { return footage != nullptr ? footage->name : comp->name; }
  [[nodiscard]] std::uint32_t id() const { return footage != nullptr ? footage->id : comp->id; }
};

std::string layer_kind(const AepLayer& layer, const Source* source) {
  if (layer.kind == LayerKind::camera) return "camera";
  if (layer.kind == LayerKind::light) return "light";
  if (layer.kind == LayerKind::text) return "text";
  // A shape layer whose contents could not be converted (plan_shape decides; a path layer otherwise).
  if (layer.kind == LayerKind::shape) return "group";
  if (layer.adjustment) return "adjustment";
  if (layer.nullLayer) return "null";
  if (source == nullptr) return "null";
  if (source->comp != nullptr) return "comp";
  const AepFootage& f = *source->footage;
  if (f.footageKind == "solid") return "solid";
  if (f.width == 0 && f.height == 0 && f.hasAudio) return "audio";
  return f.isStill ? "image" : "video";
}

/// AE's blending-mode label → this editor's mode id ("Soft Light" → "soft-light").
std::string blend_mode_id(const std::string& label) {
  std::string lower;
  for (const char c0 : label) {
    const char c = c0 >= 'A' && c0 <= 'Z' ? static_cast<char>(c0 - 'A' + 'a') : c0;
    if (c == '&') lower += "and";
    else lower.push_back(c);
  }
  std::string out;
  bool dash = false;
  for (const char c : lower) {
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
      if (dash && !out.empty()) out.push_back('-');
      dash = false;
      out.push_back(c);
    } else {
      dash = true;
    }
  }
  return out;
}

/// A scale-and-shift `v ↦ v·a + b` (every transform the planner uses is one).
struct Affine {
  double a = 1;
  double b = 0;
  /// `v / 100` is not `v * 0.01` in floating point: the TS divides, so this does too.
  double divisor = 1;
  [[nodiscard]] double operator()(double v) const { return (divisor != 1 ? v / divisor : v) * a + b; }
};

struct PlanContext {
  const AepComp& comp;
  const AepLayer& layer;
  double width;
  double height;
  std::vector<std::string>& warnings;
  PlanSummary& summary;
  /// AE layer space → this editor's centre-origin layer space: what is added to an AE anchor
  /// (and a mask vertex). −size/2 for a sized layer, 0 for text, −(outline centre) for a shape.
  double shiftX = 0;
  double shiftY = 0;
};

// ── Paths (masks and shape contents) ─────────────────────────────────────

/// A 2-D affine map `p ↦ M·p + t` (AE group transforms compose into one).
struct Affine2 {
  double a = 1, b = 0, c = 0, d = 1, tx = 0, ty = 0;
  [[nodiscard]] std::pair<double, double> apply(double x, double y) const { return {a * x + c * y + tx, b * x + d * y + ty}; }
  /// this ∘ o: `o` first.
  [[nodiscard]] Affine2 then(const Affine2& o) const {
    return {a * o.a + c * o.b, b * o.a + d * o.b, a * o.c + c * o.d, b * o.c + d * o.d, a * o.tx + c * o.ty + tx,
            b * o.tx + d * o.ty + ty};
  }
};

/// An AE outline (tangents relative) → this editor's points (handles absolute), mapped by `m`.
std::vector<PlannedMaskPoint> outline_points(const AepShape& s, const Affine2& m) {
  std::vector<PlannedMaskPoint> out;
  out.reserve(s.vertices.size());
  for (const AepShapeVertex& v : s.vertices) {
    const auto [x, y] = m.apply(v.x, v.y);
    const auto [ix, iy] = m.apply(v.x + v.inX, v.y + v.inY);
    const auto [ox, oy] = m.apply(v.x + v.outX, v.y + v.outY);
    out.push_back({x, y, ix, iy, ox, oy});
  }
  return out;
}

double first_or(const std::vector<double>& v, double fb) { return v.empty() ? fb : v[0]; }

/// AE path keyframes carry an ease but no value to measure speed against: a zero speed is
/// AE's Easy Ease (flat handle), any other speed a straight handle of the same influence.
std::vector<PlannedPathKey> outline_keys(const std::vector<AepKeyframe>& keyframes, const Affine2& m) {
  std::vector<PlannedPathKey> out;
  for (std::size_t i = 0; i < keyframes.size(); ++i) {
    const AepKeyframe& kf = keyframes[i];
    if (!kf.shape || kf.shape->vertices.empty()) return {};  // a key without an outline: not animatable here
    const AepKeyframe* next = i + 1 < keyframes.size() ? &keyframes[i + 1] : nullptr;
    PlannedPathKey k;
    k.t = kf.time;
    k.points = outline_points(*kf.shape, m);
    if (kf.outInterp == Interp::hold) {
      k.easing = api::Easing::hold;
    } else if (next != nullptr && !(kf.outInterp == Interp::linear && next->inInterp == Interp::linear)) {
      k.easing = api::Easing::bezier;
      const double x1 = std::clamp(first_or(kf.outInfluence, 1.0 / 3), 0.0, 1.0);
      const double x2 = 1 - std::clamp(first_or(next->inInfluence, 1.0 / 3), 0.0, 1.0);
      const double y1 = first_or(kf.outSpeed, 0) == 0 ? 0 : x1;
      const double y2 = first_or(next->inSpeed, 0) == 0 ? 1 : x2;
      k.bezier = std::array<double, 4>{x1, y1, x2, y2};
    }
    out.push_back(std::move(k));
  }
  return out;
}

/// AE's four-point bezier circle constant.
constexpr double kKappa = 0.5522847498307936;

/// A rectangle contour (AE: clockwise from the top-right corner, rounded corners when `r` > 0).
AepShape rect_shape(double cx, double cy, double w, double h, double r) {
  const double hw = std::abs(w) / 2;
  const double hh = std::abs(h) / 2;
  r = std::clamp(r, 0.0, std::min(hw, hh));
  AepShape s;
  if (r <= 0) {
    s.vertices = {{cx + hw, cy - hh}, {cx + hw, cy + hh}, {cx - hw, cy + hh}, {cx - hw, cy - hh}};
    return s;
  }
  const double k = r * kKappa;
  // Each corner: the vertex leaving the straight edge, then the one entering the next edge.
  s.vertices = {
      {cx + hw - r, cy - hh, 0, 0, k, 0}, {cx + hw, cy - hh + r, 0, -k, 0, 0},
      {cx + hw, cy + hh - r, 0, 0, 0, k}, {cx + hw - r, cy + hh, k, 0, 0, 0},
      {cx - hw + r, cy + hh, 0, 0, -k, 0}, {cx - hw, cy + hh - r, 0, k, 0, 0},
      {cx - hw, cy - hh + r, 0, 0, 0, -k}, {cx - hw + r, cy - hh, -k, 0, 0, 0},
  };
  return s;
}

/// An ellipse contour (AE: four vertices, clockwise from the top).
AepShape ellipse_shape(double cx, double cy, double w, double h) {
  const double rx = std::abs(w) / 2;
  const double ry = std::abs(h) / 2;
  const double kx = rx * kKappa;
  const double ky = ry * kKappa;
  AepShape s;
  s.vertices = {
      {cx, cy - ry, -kx, 0, kx, 0},
      {cx + rx, cy, 0, -ky, 0, ky},
      {cx, cy + ry, kx, 0, -kx, 0},
      {cx - rx, cy, 0, ky, 0, -ky},
  };
  return s;
}

/// `vec(p, i, fb)`: dimension `i` of a property's (first) value.
double vec(const AepProp* p, std::size_t i, double fb) {
  if (p == nullptr) return fb;
  const std::vector<double>& v = !p->value.empty() ? p->value : (!p->keyframes.empty() ? p->keyframes[0].value : p->value);
  return i < v.size() ? v[i] : fb;
}

bool keyed(const AepProp* p) { return p != nullptr && !p->keyframes.empty(); }

struct ShapeWalk {
  PlannedShape& out;
  /// Per run: its fill (`#rrggbb` + opacity), and whether a stroke reached it.
  std::vector<std::optional<std::pair<std::string, double>>> runFill;
  std::vector<bool> runStroked;
  std::vector<std::string> unsupported;
  std::vector<std::string> notes;
  bool strokesDiffer = false;
  bool fillOrderSet = false;
};

void note_once(std::vector<std::string>& list, const std::string& what) {
  if (std::find(list.begin(), list.end(), what) == list.end()) list.push_back(what);
}

std::string ae_cap(double v) { return v == 2 ? "round" : v == 3 ? "square" : "butt"; }
std::string ae_join(double v) { return v == 2 ? "round" : v == 3 ? "bevel" : "miter"; }

/// One `ADBE Vectors Group` / `ADBE Root Vectors Group`, AE's Contents order: a Fill or Stroke
/// paints the paths ABOVE it in the same group (nested groups included). Returns the runs it made.
std::vector<std::size_t> walk_contents(const AepProp& contents, const Affine2& m, double groupOpacity, ShapeWalk& w) {
  std::vector<std::size_t> made;
  std::optional<std::size_t> fillAt, strokeAt;
  for (std::size_t idx = 0; idx < contents.children.size(); ++idx) {
    const AepProp& item = contents.children[idx];
    const std::string& mn = item.matchName;
    const std::string label = item.name ? *item.name : mn;
    if (mn == "ADBE Vector Group") {
      const AepProp* xf = find_group(&item, "ADBE Vector Transform Group");
      const AepProp* anchor = find_leaf(xf, "ADBE Vector Anchor");
      const AepProp* pos = find_leaf(xf, "ADBE Vector Position");
      const AepProp* scale = find_leaf(xf, "ADBE Vector Scale");
      const AepProp* rot = find_leaf(xf, "ADBE Vector Rotation");
      const AepProp* skew = find_leaf(xf, "ADBE Vector Skew");
      const AepProp* opacity = find_leaf(xf, "ADBE Vector Group Opacity");
      if (keyed(anchor) || keyed(pos) || keyed(scale) || keyed(rot) || keyed(opacity)) {
        note_once(w.notes, "\"" + label + "\" has an animated group transform; its first value was used");
      }
      if (skew != nullptr && vec(skew, 0, 0) != 0) note_once(w.unsupported, "group skew");
      const double sx = vec(scale, 0, 100) / 100;
      const double sy = vec(scale, 1, 100) / 100;
      const double rad = vec(rot, 0, 0) * 3.141592653589793 / 180;
      const double cs = std::cos(rad);
      const double sn = std::sin(rad);
      // p ↦ position + R·S·(p − anchor)
      Affine2 g{cs * sx, sn * sx, -sn * sy, cs * sy, 0, 0};
      const auto [ax, ay] = g.apply(vec(anchor, 0, 0), vec(anchor, 1, 0));
      g.tx = vec(pos, 0, 0) - ax;
      g.ty = vec(pos, 1, 0) - ay;
      const AepProp* inner = find_group(&item, "ADBE Vectors Group");
      if (inner == nullptr) continue;
      const std::vector<std::size_t> sub = walk_contents(*inner, m.then(g), groupOpacity * vec(opacity, 0, 100) / 100, w);
      made.insert(made.end(), sub.begin(), sub.end());
      continue;
    }
    std::optional<AepShape> outline;
    std::vector<AepKeyframe> keys;
    if (mn == "ADBE Vector Shape - Group") {
      const AepProp* path = find_leaf(&item, "ADBE Vector Shape");
      if (path != nullptr && path->shape) {
        outline = path->shape;
        keys = path->keyframes;
      }
    } else if (mn == "ADBE Vector Shape - Rect") {
      const AepProp* size = find_leaf(&item, "ADBE Vector Rect Size");
      const AepProp* pos = find_leaf(&item, "ADBE Vector Rect Position");
      const AepProp* round = find_leaf(&item, "ADBE Vector Rect Roundness");
      if (keyed(size) || keyed(pos) || keyed(round)) note_once(w.notes, "\"" + label + "\" is an animated rectangle; its first size was used");
      outline = rect_shape(vec(pos, 0, 0), vec(pos, 1, 0), vec(size, 0, 100), vec(size, 1, 100), vec(round, 0, 0));
    } else if (mn == "ADBE Vector Shape - Ellipse") {
      const AepProp* size = find_leaf(&item, "ADBE Vector Ellipse Size");
      const AepProp* pos = find_leaf(&item, "ADBE Vector Ellipse Position");
      if (keyed(size) || keyed(pos)) note_once(w.notes, "\"" + label + "\" is an animated ellipse; its first size was used");
      outline = ellipse_shape(vec(pos, 0, 0), vec(pos, 1, 0), vec(size, 0, 100), vec(size, 1, 100));
    } else if (mn == "ADBE Vector Graphic - Fill") {
      const AepProp* color = find_leaf(&item, "ADBE Vector Fill Color");
      const AepProp* opacity = find_leaf(&item, "ADBE Vector Fill Opacity");
      const AepProp* rule = find_leaf(&item, "ADBE Vector Fill Rule");
      if (keyed(color) || keyed(opacity)) note_once(w.notes, "\"" + label + "\" has an animated fill; its first value was used");
      if (rule != nullptr && vec(rule, 0, 1) == 2) note_once(w.unsupported, "Even-Odd fill rule");
      const std::string hex = color != nullptr ? color_hex(color->value.empty() && keyed(color) ? color->keyframes[0].value : color->value)
                                               : "#ff0000";
      const double op = std::clamp(vec(opacity, 0, 100) / 100, 0.0, 1.0) * groupOpacity;
      for (const std::size_t r : made) {
        if (!w.runFill[r]) w.runFill[r] = std::make_pair(hex, op);
      }
      if (!fillAt) fillAt = idx;
      continue;
    } else if (mn == "ADBE Vector Graphic - Stroke") {
      const AepProp* color = find_leaf(&item, "ADBE Vector Stroke Color");
      const AepProp* opacity = find_leaf(&item, "ADBE Vector Stroke Opacity");
      const AepProp* width = find_leaf(&item, "ADBE Vector Stroke Width");
      if (keyed(color) || keyed(opacity) || keyed(width)) note_once(w.notes, "\"" + label + "\" has an animated stroke; its first value was used");
      const AepProp* dashes = find_group(&item, "ADBE Vector Stroke Dashes");
      if (dashes != nullptr && !dashes->children.empty()) note_once(w.unsupported, "stroke dashes");
      PlannedShape::Stroke s;
      s.color = color != nullptr ? color_hex(color->value.empty() && keyed(color) ? color->keyframes[0].value : color->value) : "#ffffff";
      s.opacity = std::clamp(vec(opacity, 0, 100) / 100, 0.0, 1.0) * groupOpacity;
      // A group scale scales the stroke too (the geometric mean, for a non-uniform one).
      s.width = std::max(0.0, vec(width, 0, 2)) * std::sqrt(std::abs(m.a * m.d - m.b * m.c));
      s.cap = ae_cap(vec(find_leaf(&item, "ADBE Vector Stroke Line Cap"), 0, 1));
      s.join = ae_join(vec(find_leaf(&item, "ADBE Vector Stroke Line Join"), 0, 1));
      s.miterLimit = std::max(1.0, vec(find_leaf(&item, "ADBE Vector Stroke Miter Limit"), 0, 4));
      bool any = false;
      for (const std::size_t r : made) {
        if (!w.runStroked[r]) {
          w.runStroked[r] = true;
          any = true;
        }
      }
      if (any) {
        if (!w.out.stroke) w.out.stroke = s;
        else if (w.out.stroke->color != s.color || w.out.stroke->width != s.width) w.strokesDiffer = true;
      }
      if (!strokeAt) strokeAt = idx;
      continue;
    } else if (mn == "ADBE Vector Filter - Merge") {
      continue;  // contours of one layer are subpaths of one outline here already
    } else if (mn.starts_with("ADBE Vector")) {
      note_once(w.unsupported, label);
      continue;
    } else {
      continue;
    }
    if (!outline || outline->vertices.empty()) continue;
    PlannedRun run;
    run.closed = outline->closed;
    run.points = outline_points(*outline, m);
    if (keys.size() > 1) run.keys = outline_keys(keys, m);
    w.out.runs.push_back(std::move(run));
    w.runFill.emplace_back();
    w.runStroked.push_back(false);
    made.push_back(w.out.runs.size() - 1);
  }
  if (!w.fillOrderSet && fillAt && strokeAt) {
    w.out.fillAboveStroke = *fillAt < *strokeAt;
    w.fillOrderSet = true;
  }
  return made;
}

/// An AE shape layer's Contents → one path outline, or nullopt when nothing drawable came across.
std::optional<PlannedShape> plan_shape(const AepLayer& layer, std::vector<std::string>& warnings) {
  const AepProp* root = find_group(&layer.properties, "ADBE Root Vectors Group");
  if (root == nullptr) return std::nullopt;
  PlannedShape shape;
  ShapeWalk w{shape, {}, {}, {}, {}, false, false};
  (void)walk_contents(*root, Affine2{}, 1.0, w);
  const std::string who = "\"" + layer.name + "\"";
  for (const std::string& n : w.notes) warnings.push_back(n);
  if (!w.unsupported.empty()) {
    std::string list;
    for (std::size_t i = 0; i < w.unsupported.size(); ++i) list += (i > 0 ? ", " : "") + w.unsupported[i];
    warnings.push_back(who + " uses shape features this editor does not convert yet (" + list + "); they were left out");
  }
  if (shape.runs.empty()) return std::nullopt;
  if (w.strokesDiffer) warnings.push_back(who + " strokes its paths differently; the first stroke was applied to all of them");
  if (shape.stroke && std::find(w.runStroked.begin(), w.runStroked.end(), false) != w.runStroked.end()) {
    warnings.push_back(who + " strokes only some of its paths; the stroke was applied to all of them");
  }
  // One fill for the layer when every filled run agrees; per-run paint otherwise.
  std::optional<std::pair<std::string, double>> common;
  bool uniform = true;
  for (const auto& f : w.runFill) {
    if (!f) {
      uniform = false;
      continue;
    }
    if (!common) common = f;
    else if (*common != *f) uniform = false;
  }
  if (common && uniform) {
    shape.fill = common->first;
    shape.fillOpacity = common->second;
  } else if (common) {
    for (const auto& f : w.runFill) shape.runFills.push_back(f ? f->first : std::string("transparent"));
    shape.fillOpacity = common->second;
  }
  // AE draws the top of the Contents list last: the first run ends up on top here.
  std::reverse(shape.runs.begin(), shape.runs.end());
  std::reverse(shape.runFills.begin(), shape.runFills.end());
  // Centre the outline (every key included) on the layer: AE's layer origin is wherever (0, 0) is.
  constexpr double kInf = std::numeric_limits<double>::infinity();
  double minX = kInf, minY = kInf, maxX = -kInf, maxY = -kInf;
  const auto grow = [&](const std::vector<PlannedMaskPoint>& pts) {
    for (const PlannedMaskPoint& p : pts) {
      for (const double x : {p.x, p.inX, p.outX}) {
        minX = std::min(minX, x);
        maxX = std::max(maxX, x);
      }
      for (const double y : {p.y, p.inY, p.outY}) {
        minY = std::min(minY, y);
        maxY = std::max(maxY, y);
      }
    }
  };
  for (const PlannedRun& r : shape.runs) {
    grow(r.points);
    for (const PlannedPathKey& k : r.keys) grow(k.points);
  }
  if (!(minX <= maxX && minY <= maxY)) return std::nullopt;
  shape.cx = (minX + maxX) / 2;
  shape.cy = (minY + maxY) / 2;
  shape.width = std::max(1.0, maxX - minX);
  shape.height = std::max(1.0, maxY - minY);
  const auto shift = [&](std::vector<PlannedMaskPoint>& pts) {
    for (PlannedMaskPoint& p : pts) {
      p.x -= shape.cx;
      p.inX -= shape.cx;
      p.outX -= shape.cx;
      p.y -= shape.cy;
      p.inY -= shape.cy;
      p.outY -= shape.cy;
    }
  };
  for (PlannedRun& r : shape.runs) {
    shift(r.points);
    for (PlannedPathKey& k : r.keys) shift(k.points);
  }
  return shape;
}

// ── Expressions ──────────────────────────────────────────────────────────

/// AE transform match name → this editor's API path (and the member of a separated dimension).
std::optional<std::pair<std::string, std::optional<std::uint32_t>>> transform_path(std::string_view mn) {
  if (mn == "ADBE Position") return std::make_pair(std::string("transform/position"), std::optional<std::uint32_t>());
  if (mn == "ADBE Position_0") return std::make_pair(std::string("transform/position"), std::optional<std::uint32_t>(0));
  if (mn == "ADBE Position_1") return std::make_pair(std::string("transform/position"), std::optional<std::uint32_t>(1));
  if (mn == "ADBE Position_2") return std::make_pair(std::string("transform/position"), std::optional<std::uint32_t>(2));
  if (mn == "ADBE Anchor Point") return std::make_pair(std::string("transform/anchorPoint"), std::optional<std::uint32_t>());
  if (mn == "ADBE Scale") return std::make_pair(std::string("transform/scale"), std::optional<std::uint32_t>());
  if (mn == "ADBE Rotate Z") return std::make_pair(std::string("transform/rotation"), std::optional<std::uint32_t>());
  if (mn == "ADBE Rotate X") return std::make_pair(std::string("transform/xRotation"), std::optional<std::uint32_t>());
  if (mn == "ADBE Rotate Y") return std::make_pair(std::string("transform/yRotation"), std::optional<std::uint32_t>());
  if (mn == "ADBE Opacity") return std::make_pair(std::string("transform/opacity"), std::optional<std::uint32_t>());
  if (mn == "ADBE Orientation") return std::make_pair(std::string("transform/orientation"), std::optional<std::uint32_t>());
  return std::nullopt;
}

void plan_transform_expressions(const AepLayer& layer, PlannedLayer& out) {
  const AepProp* group = find_group(&layer.properties, "ADBE Transform Group");
  if (group == nullptr) return;
  for (const AepProp& p : group->children) {
    if (p.isGroup || !p.expression) continue;
    const auto target = transform_path(p.matchName);
    if (!target) continue;
    out.layerExpressions.push_back(PlannedExpression{target->first, *p.expression, p.expressionEnabled, target->second});
  }
}

void set_prop(std::vector<std::pair<std::string, double>>& props, const std::string& key, double v) {
  for (auto& [k, val] : props) {
    if (k == key) {
      val = v;
      return;
    }
  }
  props.emplace_back(key, v);
}

void plan_transform(const PlanContext& ctx, PlannedLayer& out) {
  const AepProp* group = find_group(&ctx.layer.properties, "ADBE Transform Group");
  // `fallback` is in THIS editor's units: what the property is when the file does not mention it.
  auto take = [&](std::string_view matchName, std::size_t dim, const std::string& prop, double fallback, Affine tf = {}) {
    const AepProp* source = find_leaf(group, matchName);
    if (source == nullptr) {
      set_prop(out.staticProps, prop, fallback);
      return;
    }
    const std::optional<double> raw = dim < source->value.size() ? std::optional<double>(source->value[dim]) : std::nullopt;
    double value = raw ? tf(*raw) : fallback;
    if (!source->keyframes.empty()) {
      const double zero = tf(0);
      const double one = tf(1);
      ConvertOptions opts;
      opts.scale = one - zero;
      opts.offset = zero;
      out.tracks.push_back({prop, to_keyframe_track(source->keyframes, dim, opts)});
      const std::vector<double>& first = source->keyframes[0].value;
      value = tf(dim < first.size() ? first[dim] : raw.value_or(fallback));
    }
    set_prop(out.staticProps, prop, value);
  };

  const AepProp* separated = find_leaf(group, "ADBE Position_0");
  const bool useSeparated = separated != nullptr && !separated->keyframes.empty();
  if (useSeparated) {
    take("ADBE Position_0", 0, "x", ctx.comp.width / 2);
    take("ADBE Position_1", 0, "y", ctx.comp.height / 2);
    take("ADBE Position_2", 0, "z", 0);
  } else {
    take("ADBE Position", 0, "x", ctx.comp.width / 2);
    take("ADBE Position", 1, "y", ctx.comp.height / 2);
    take("ADBE Position", 2, "z", 0);
  }
  // Anchor: AE's top-left origin → this editor's centre origin. Text has no box in AE: its anchor
  // is relative to the text origin, which the Text `textAnchor: "alignment"` reproduces here.
  take("ADBE Anchor Point", 0, "anchorX", 0, Affine{1, ctx.shiftX, 1});
  take("ADBE Anchor Point", 1, "anchorY", 0, Affine{1, ctx.shiftY, 1});
  take("ADBE Scale", 0, "scaleX", 1, Affine{1, 0, 100});
  take("ADBE Scale", 1, "scaleY", 1, Affine{1, 0, 100});
  take("ADBE Rotate Z", 0, "rotation", 0);
  take("ADBE Rotate X", 0, "rotationX", 0);
  take("ADBE Rotate Y", 0, "rotationY", 0);
  take("ADBE Opacity", 0, "opacity", 100);

  // Orientation carries over as the resting facing it means here too.
  if (const AepProp* orientation = find_leaf(group, "ADBE Orientation")) {
    if (std::any_of(orientation->value.begin(), orientation->value.end(), [](double v) { return v != 0; })) {
      auto at = [&](std::size_t i) { return i < orientation->value.size() ? orientation->value[i] : 0.0; };
      set_prop(out.staticProps, "orientationX", at(0));
      set_prop(out.staticProps, "orientationY", at(1));
      set_prop(out.staticProps, "orientationZ", at(2));
    }
  }
  if (!ctx.layer.threeD) {
    // A 2-D AE layer has no depth: a z or x-rotation would quietly promote it to 3-D here.
    const auto depth = [](const std::string& k) { return k == "z" || k == "rotationX" || k == "rotationY"; };
    std::erase_if(out.staticProps, [&](const auto& p) { return depth(p.first); });
    std::erase_if(out.tracks, [&](const PlannedTrack& t) { return depth(t.prop); });
  }
}

/// Camera program D4: a camera layer's options 1:1. AE keeps a camera's Point
/// of Interest in its Anchor Point (comp px, no centre shift) and its Camera
/// Options in their own group; X / Y / Z Rotation turn the camera on the spot
/// (this editor's orientationX / Y / Z, added to the Orientation).
void plan_camera(const PlanContext& ctx, PlannedLayer& out) {
  // A camera has no anchor, scale, opacity or 2D rotation of its own here.
  const auto notCamera = [](const std::string& k) {
    return k == "anchorX" || k == "anchorY" || k == "scaleX" || k == "scaleY" || k == "opacity" || k == "rotation" ||
           k == "rotationX" || k == "rotationY";
  };
  std::erase_if(out.staticProps, [&](const auto& p) { return notCamera(p.first); });
  std::erase_if(out.tracks, [&](const PlannedTrack& t) { return notCamera(t.prop); });

  const AepProp* xf = find_group(&ctx.layer.properties, "ADBE Transform Group");
  const AepProp* options = find_group(&ctx.layer.properties, "ADBE Camera Options Group");
  const auto take = [&](const AepProp* group, std::string_view matchName, std::size_t dim, const std::string& prop,
                        double offset, double scale, bool always) {
    const AepProp* source = find_leaf(group, matchName);
    if (source == nullptr) return;
    double value = dim < source->value.size() ? source->value[dim] * scale + offset : offset;
    if (!source->keyframes.empty()) {
      ConvertOptions opts;
      opts.scale = scale;
      opts.offset = offset;
      out.tracks.push_back({prop, to_keyframe_track(source->keyframes, dim, opts)});
      const std::vector<double>& first = source->keyframes[0].value;
      if (dim < first.size()) value = first[dim] * scale + offset;
    } else if (!always && value == offset) {
      return;  // AE's default: nothing stored
    }
    set_prop(out.staticProps, prop, value);
  };
  // A camera is 3D in AE whatever its 3D switch says: keep its depth.
  if (!ctx.layer.threeD) {
    const AepProp* sep = find_leaf(xf, "ADBE Position_0");
    if (sep != nullptr && !sep->keyframes.empty()) {
      take(xf, "ADBE Position_2", 0, "z", 0, 1, true);
    } else {
      take(xf, "ADBE Position", 2, "z", 0, 1, true);
    }
  }
  // Two-node: AE's auto-orient "towards Point of Interest".
  if (ctx.layer.autoOrient == 2) {
    take(xf, "ADBE Anchor Point", 0, "poiX", 0, 1, true);
    take(xf, "ADBE Anchor Point", 1, "poiY", 0, 1, true);
    take(xf, "ADBE Anchor Point", 2, "poiZ", 0, 1, true);
  }
  double ori[3] = {0, 0, 0};
  for (const auto& [k, v] : out.staticProps) {
    if (k == "orientationX") ori[0] = v;
    if (k == "orientationY") ori[1] = v;
    if (k == "orientationZ") ori[2] = v;
  }
  take(xf, "ADBE Rotate X", 0, "orientationX", ori[0], 1, false);
  take(xf, "ADBE Rotate Y", 0, "orientationY", ori[1], 1, false);
  take(xf, "ADBE Rotate Z", 0, "orientationZ", ori[2], 1, false);
  if (options == nullptr) return;
  take(options, "ADBE Camera Zoom", 0, "focalLength", 0, 1, true);
  const AepProp* dof = find_leaf(options, "ADBE Camera Depth of Field");
  const bool dofOn = dof != nullptr && ((!dof->value.empty() && dof->value[0] != 0) || !dof->keyframes.empty());
  if (dofOn) {
    take(options, "ADBE Camera Focus Distance", 0, "focusDistance", 0, 1, true);
    take(options, "ADBE Camera Aperture", 0, "dofAperture", 0, 1, true);
    // AE's Blur Level is a percentage of the physical blur (100 %); this
    // editor's Blur Level is px of the legacy ramp — 100 % reads as 10 px.
    take(options, "ADBE Camera Blur Level", 0, "dofStrength", 0, 0.1, true);
    take(options, "ADBE Iris Rotation", 0, "irisRotation", 0, 1, false);
    take(options, "ADBE Iris Roundness", 0, "irisRoundness", 0, 1, false);
    take(options, "ADBE Iris Aspect Ratio", 0, "irisAspect", 0, 1, false);
    take(options, "ADBE Iris Diffraction Fringe", 0, "diffractionFringe", 0, 1, false);
    take(options, "ADBE Iris Highlight Gain", 0, "highlightGain", 0, 1, false);
    take(options, "ADBE Iris Highlight Threshold", 0, "highlightThreshold", 0, 1, false);
    take(options, "ADBE Iris Hightlight Saturation", 0, "highlightSaturation", 0, 1, false);
  }
}

void plan_masks(const PlanContext& ctx, PlannedLayer& out) {
  for (const AepMask& mask : ctx.layer.masks) {
    if (!mask.shape || mask.shape->vertices.empty()) continue;
    const AepProp* feather = find_leaf(&mask.properties, "ADBE Mask Feather");
    const AepProp* opacity = find_leaf(&mask.properties, "ADBE Mask Opacity");
    const AepProp* expansion = find_leaf(&mask.properties, "ADBE Mask Offset");
    PlannedMask m;
    m.name = mask.name;
    m.mode = mask.mode;
    m.inverted = mask.inverted;
    m.locked = mask.locked;
    m.color = {mask.color[0], mask.color[1], mask.color[2]};
    m.closed = mask.shape->closed;
    // AE layer space → centre origin (a text layer's masks are relative to its text origin, no shift).
    // AE stores tangents as offsets; this editor stores the handle positions.
    const Affine2 toLayer{1, 0, 0, 1, ctx.shiftX, ctx.shiftY};
    m.points = outline_points(*mask.shape, toLayer);
    const AepProp* path = nullptr;
    for (const AepProp& c : mask.properties.children) {
      if (!c.isGroup && c.shape) {
        path = &c;
        break;
      }
    }
    if (path != nullptr && path->keyframes.size() > 1) {
      m.keys = outline_keys(path->keyframes, toLayer);
      if (m.keys.empty()) ctx.warnings.push_back("\"" + mask.name + "\" has an animated outline whose keys could not be read; the first shape was imported");
    }
    // AE's feather is 2-D; this editor's is one diameter (the horizontal stands for both).
    m.feather = scalar_of(feather, 0);
    m.opacity = (opacity != nullptr ? scalar_of(opacity, 100) : 100) / 100;
    m.expansion = scalar_of(expansion, 0);
    out.masks.push_back(std::move(m));
    ctx.summary.masks += 1;
  }
}

void put_param(PlannedEffect& e, const std::string& key, js::Json v) {
  for (auto& [k, val] : e.params) {
    if (k == key) {
      val = std::move(v);
      return;
    }
  }
  e.params.emplace_back(key, std::move(v));
}

/// The AE parameter labelled `label` (normalised), from its `pard`.
const AepProp* ae_param(const AepProp& effect, std::string_view label) {
  for (const AepProp& c : effect.children) {
    if (!c.isGroup && c.name && normalize_label(*c.name) == label) return &c;
  }
  return nullptr;
}

/// `key` ← the AE parameter labelled `label` as `v·scale + offset`, keyframes included. An absent
/// parameter is at AE's default, `fallback` (in AE's units); nullopt leaves ours at its default.
void take_param(PlannedEffect& e, const AepProp& effect, std::string_view label, const std::string& key, double scale,
                double offset, std::optional<double> fallback = std::nullopt) {
  const AepProp* p = ae_param(effect, label);
  const std::optional<double> raw = p != nullptr && !p->value.empty() ? std::optional<double>(p->value[0]) : fallback;
  if (!raw) return;
  put_param(e, key, js::Json::number(*raw * scale + offset));
  std::erase_if(e.tracks, [&](const PlannedTrack& t) { return t.prop == key; });
  if (p != nullptr && !p->keyframes.empty()) {
    ConvertOptions opts;
    opts.scale = scale;
    opts.offset = offset;
    e.tracks.push_back({key, to_keyframe_track(p->keyframes, 0, opts)});
  }
}

/// Where AE stores a parameter in other units or another convention than the effect it maps to.
/// Matching by label carries the number across; this makes it mean the same thing.
void convert_ae_units(const AepProp& effect, PlannedEffect& e) {
  if (e.type == "drop-shadow") {
    // Opacity is 0–255 in the file; Direction is clockwise from up (ours: from +x).
    take_param(e, effect, "opacity", "opacity", 100.0 / 255, 0);
    take_param(e, effect, "direction", "angle", 1, -90);
  } else if (e.type == "fast-box-blur") {
    // AE's popups count from 1 (Horizontal and Vertical, Horizontal, Vertical); ours from 0.
    take_param(e, effect, "blurdimensions", "dimensions", 1, -1);
  } else if (e.type == "noise") {
    take_param(e, effect, "amountofnoise", "amount", 1, 0);
    // "Use Color Noise" (on by default) is the inverse of Monochrome.
    const AepProp* color = ae_param(effect, "noisetype");
    const bool colorNoise = color == nullptr || color->value.empty() || color->value[0] != 0;
    put_param(e, "monochrome", js::Json::boolean(!colorNoise));
  } else if (e.type == "vr-glow") {
    // AE Glow: threshold 0–255, intensity a multiplier, Original Colors unless "A & B Colors".
    take_param(e, effect, "glowthreshold", "threshold", 100.0 / 255, 0, 153);
    take_param(e, effect, "glowradius", "radius", 1, 0, 10);
    take_param(e, effect, "glowintensity", "brightness", 100, 0, 1);
    const AepProp* colors = ae_param(effect, "glowcolors");
    const AepProp* colorA = ae_param(effect, "colora");
    if (colors != nullptr && !colors->value.empty() && colors->value[0] == 2) {
      put_param(e, "tintEnable", js::Json::boolean(true));
      put_param(e, "tint", js::Json::string(colorA != nullptr ? color_hex(colorA->value) : "#ffffff"));
    }
  } else if (e.type == "add-grain") {
    // AE's Intensity is a multiplier (1 = its default grain, our 30 %); Saturation 0–1 (default 1:
    // colour grain), ours 0–100 % (default mono).
    take_param(e, effect, "intensity", "intensity", 30, 0, 1);
    if (const auto it = std::find_if(e.params.begin(), e.params.end(), [](const auto& p) { return p.first == "intensity"; });
        it != e.params.end() && it->second.is_number()) {
      it->second = js::Json::number(std::min(100.0, it->second.num()));
    }
    take_param(e, effect, "saturation", "saturation", 100, 0, 1);
  } else if (e.type == "gradient-ramp") {
    // Start/End Color, and the direction from Start of Ramp to End of Ramp (already pixels).
    const AepProp* a = ae_param(effect, "startcolor");
    const AepProp* b = ae_param(effect, "endcolor");
    put_param(e, "colorA", js::Json::string(a != nullptr ? color_hex(a->value) : "#000000"));
    put_param(e, "colorB", js::Json::string(b != nullptr ? color_hex(b->value) : "#ffffff"));
    const AepProp* from = ae_param(effect, "startoframp");
    const AepProp* to = ae_param(effect, "endoframp");
    if (from != nullptr && to != nullptr && from->value.size() >= 2 && to->value.size() >= 2) {
      const double dx = to->value[0] - from->value[0];
      const double dy = to->value[1] - from->value[1];
      if (dx != 0 || dy != 0) put_param(e, "angle", js::Json::number(std::atan2(dy, dx) * 180 / 3.141592653589793));
    } else {
      put_param(e, "angle", js::Json::number(90));  // AE's default: top to bottom
    }
    take_param(e, effect, "blendwithoriginal", "blend", -1, 100);
  }
}

void plan_effects(const PlanContext& ctx, PlannedLayer& out) {
  const AepProp* parade = find_group(&ctx.layer.properties, "ADBE Effect Parade");
  if (parade == nullptr) return;
  for (const AepProp& entry : parade->children) {
    if (!entry.isGroup) continue;
    std::vector<AeParam> declared;
    for (const AepProp& c : entry.children) {
      if (!c.isGroup) declared.push_back(AeParam{c.matchName, c.name, c.controlType});
    }
    const std::vector<MappedEffect> mapped = map_effect(entry.matchName, declared);
    if (mapped.empty()) {
      const std::string label = entry.name && !entry.name->empty() ? *entry.name : entry.matchName;
      auto& um = ctx.summary.unmappedEffects;
      if (std::find(um.begin(), um.end(), label) == um.end()) um.push_back(label);
      continue;
    }
    for (const MappedEffect& target : mapped) {
      PlannedEffect e;
      e.type = target.type;
      const EffectDef* def = registry().effect(target.type);
      auto setParam = [&](const std::string& key, js::Json v) {
        for (auto& [k, val] : e.params) {
          if (k == key) {
            val = std::move(v);
            return;
          }
        }
        e.params.emplace_back(key, std::move(v));
      };
      for (const auto& [key, aeName] : target.params) {
        const AepProp* prop = find_leaf(&entry, aeName);
        if (prop == nullptr) continue;
        if (prop->isColor) {
          setParam(key, js::Json::string(color_hex(prop->value)));
          continue;
        }
        // A colour or a group heading never feeds a number (and a number never a colour).
        if (def != nullptr) {
          const auto pd = std::find_if(def->params.begin(), def->params.end(), [&](const EffectParamDef& d) { return d.key == key; });
          if (pd != def->params.end() && pd->type == "color") continue;
        }
        setParam(key, js::Json::number(prop->value.empty() ? 0 : prop->value[0]));
        if (!prop->keyframes.empty()) e.tracks.push_back({key, to_keyframe_track(prop->keyframes, 0)});
        if (prop->expression) e.expressions.emplace_back(key, PlannedExpression{"", *prop->expression, prop->expressionEnabled, {}});
      }
      // A point is one AE parameter and two of ours (the reader already made it pixels).
      for (const auto& [base, pt] : target.points) {
        const AepProp* prop = find_leaf(&entry, pt.from);
        if (prop == nullptr) continue;
        setParam(pt.keyX, js::Json::number(!prop->value.empty() ? prop->value[0] : 0));
        setParam(pt.keyY, js::Json::number(prop->value.size() > 1 ? prop->value[1] : 0));
        if (!prop->keyframes.empty()) {
          e.tracks.push_back({pt.keyX, to_keyframe_track(prop->keyframes, 0)});
          e.tracks.push_back({pt.keyY, to_keyframe_track(prop->keyframes, 1)});
        }
        // Each half of the point runs the AE expression on its own number (loopOut, wiggle… work per value).
        if (prop->expression) {
          e.expressions.emplace_back(pt.keyX, PlannedExpression{"", *prop->expression, prop->expressionEnabled, {}});
          e.expressions.emplace_back(pt.keyY, PlannedExpression{"", *prop->expression, prop->expressionEnabled, {}, false});
        }
      }
      convert_ae_units(entry, e);
      e.defaultsOnly = target.defaultsOnly && e.params.empty();
      out.effects.push_back(std::move(e));
      ctx.summary.effects += 1;
    }
  }
}

void collect_expressions(const AepProp& group, const std::string& path, std::vector<PlannedLayer::Expression>& out) {
  for (const AepProp& child : group.children) {
    const std::string& label = child.name ? *child.name : child.matchName;
    const std::string here = path.empty() ? label : path + " \xE2\x96\xB8 " + label;
    if (child.isGroup) collect_expressions(child, here, out);
    else if (child.expression) out.push_back({here, *child.expression});
  }
}

PlannedLayer plan_layer(const AepLayer& layer, const AepComp& comp, const std::map<std::uint32_t, Source>& sources,
                        std::vector<std::string>& warnings, PlanSummary& summary) {
  const auto it = sources.find(layer.sourceId);
  const Source* source = it != sources.end() ? &it->second : nullptr;
  const double w = source != nullptr && source->width() != 0 ? source->width() : comp.width;
  const double h = source != nullptr && source->height() != 0 ? source->height() : comp.height;
  PlanContext ctx{comp, layer, w, h, warnings, summary, -w / 2, -h / 2};

  PlannedLayer out;
  out.uid = std::to_string(comp.id) + ":" + std::to_string(layer.id);
  // A layer AE never renamed shows its source's name.
  out.name = !layer.name.empty() ? layer.name
             : source != nullptr && !source->name().empty() ? source->name()
                                                             : "Layer " + std::to_string(layer.index);
  out.kind = layer_kind(layer, source);
  // Text has no box in AE: its anchor is relative to the text origin, which `textAnchor: "alignment"` reproduces.
  if (layer.kind == LayerKind::text) ctx.shiftX = ctx.shiftY = 0;
  if (layer.kind == LayerKind::shape) {
    if (std::optional<PlannedShape> shape = plan_shape(layer, warnings)) {
      // AE's shape layer origin is wherever its contents' (0, 0) is; here the outline is centred.
      ctx.shiftX = -shape->cx;
      ctx.shiftY = -shape->cy;
      out.kind = "path";
      out.shape = std::move(shape);
    } else {
      warnings.push_back("\"" + out.name + "\" is a shape layer with nothing this editor can draw yet; it came across as an empty group");
    }
  }
  if (layer.parentId != 0) out.parentUid = std::to_string(comp.id) + ":" + std::to_string(layer.parentId);
  if (source != nullptr) out.source = PlannedLayer::Source{source->comp != nullptr, source->id()};
  plan_transform(ctx, out);
  if (layer.kind == LayerKind::camera) plan_camera(ctx, out);
  else plan_transform_expressions(layer, out);
  collect_expressions(layer.properties, "", out.expressions);
  summary.expressions += static_cast<std::uint32_t>(out.expressions.size());

  const AepProp* textProp = find_leaf(find_group(&layer.properties, "ADBE Text Properties"), "ADBE Text Document");
  if (textProp != nullptr && textProp->text) {
    out.text = textProp->text;
    if (textProp->text->styleRuns > 1) {
      warnings.push_back("\"" + layer.name + "\" mixes character styles; the first one was applied to the whole layer");
    }
  }
  out.timing = {layer.inPoint, layer.outPoint, layer.startTime, layer.stretch};
  out.flags = {layer.enabled, layer.solo,  layer.shy,        layer.locked,          layer.threeD,
               layer.adjustment, layer.guide, layer.motionBlur, layer.collapseTransformation};
  out.blendMode = blend_mode_id(layer.blendingMode);
  out.label = layer.label;
  if (layer.trackMatte != "none") {
    PlannedLayer::Matte m;
    m.mode = layer.trackMatte.starts_with("luma") ? "luma" : "alpha";
    m.inverted = layer.trackMatte.ends_with("-inverted");
    // AE 23+ names the matte layer; before that it is "the layer directly above" (the applier resolves it).
    if (layer.matteLayerId != 0) m.sourceUid = std::to_string(comp.id) + ":" + std::to_string(layer.matteLayerId);
    out.matte = std::move(m);
  }
  plan_masks(ctx, out);
  plan_effects(ctx, out);
  if (source != nullptr && source->footage != nullptr && source->footage->solidColor) {
    const auto& c = *source->footage->solidColor;
    out.solidColor = hex_color(c.r * 255, c.g * 255, c.b * 255);
  }
  return out;
}

}  // namespace

std::string hex_color(double r, double g, double b) {
  static constexpr char kHex[] = "0123456789abcdef";
  std::string out = "#";
  for (const double c : {r, g, b}) {
    const auto v = static_cast<unsigned>(clamp255(std::isfinite(c) ? c : 0));
    out.push_back(kHex[v >> 4U]);
    out.push_back(kHex[v & 15U]);
  }
  return out;
}

AepImportPlan plan_aep_import(const AepProject& project) {
  AepImportPlan plan;
  plan.warnings = project.warnings;
  plan.aeVersion = project.aeVersion;
  plan.summary.comps = static_cast<std::uint32_t>(project.comps.size());

  std::map<std::uint32_t, Source> sources;
  for (const AepItemRef& item : project.items) {
    if (item.kind == ItemKind::footage) sources.insert_or_assign(item.id, Source{&project.footage[item.index], nullptr});
    else if (item.kind == ItemKind::comp) sources.insert_or_assign(item.id, Source{nullptr, &project.comps[item.index]});
  }

  for (const AepComp& comp : project.comps) {
    PlannedComp pc;
    for (const AepLayer& layer : comp.layers) pc.layers.push_back(plan_layer(layer, comp, sources, plan.warnings, plan.summary));
    // AE switches a track matte's video off; this editor never draws a matte source as a plain
    // layer but only builds one whose eye is on, so the source comes across switched on.
    for (std::size_t i = 0; i < pc.layers.size(); ++i) {
      const auto& matte = pc.layers[i].matte;
      if (!matte) continue;
      const std::optional<std::string> sourceUid = matte->sourceUid ? matte->sourceUid
                                                   : i > 0 ? std::optional<std::string>(pc.layers[i - 1].uid)
                                                           : std::nullopt;
      for (PlannedLayer& source : pc.layers) {
        if (sourceUid && source.uid == *sourceUid) source.flags.enabled = true;
      }
    }
    plan.summary.layers += static_cast<std::uint32_t>(pc.layers.size());
    // Counted from the tracks that survived (a 2-D layer's dropped z track is not a keyframe).
    for (const PlannedLayer& l : pc.layers) {
      for (const PlannedTrack& t : l.tracks) plan.summary.keyframes += static_cast<std::uint32_t>(t.keyframes.size());
      for (const PlannedEffect& e : l.effects) {
        for (const PlannedTrack& t : e.tracks) plan.summary.keyframes += static_cast<std::uint32_t>(t.keyframes.size());
      }
      for (const PlannedMask& m : l.masks) plan.summary.keyframes += static_cast<std::uint32_t>(m.keys.size());
      if (l.shape) {
        for (const PlannedRun& r : l.shape->runs) plan.summary.keyframes += static_cast<std::uint32_t>(r.keys.size());
      }
    }
    pc.aepId = comp.id;
    pc.name = !comp.name.empty() ? comp.name : "Composition";
    pc.width = comp.width;
    pc.height = comp.height;
    pc.fps = comp.fps;
    pc.durationSeconds = comp.durationSeconds;
    pc.background = hex_color(comp.background.r, comp.background.g, comp.background.b);
    pc.folder = comp.folder;
    pc.motionBlur = comp.motionBlur;
    pc.shutterAngle = comp.shutterAngle;
    pc.shutterPhase = comp.shutterPhase;
    pc.samplesPerFrame = comp.motionBlurSamplesPerFrame;
    pc.workAreaStart = comp.workAreaStart;
    // AE's open-ended work area means "to the end of the comp".
    pc.workAreaEnd = std::isfinite(comp.workAreaEnd) ? comp.workAreaEnd : comp.durationSeconds;
    plan.comps.push_back(std::move(pc));
  }

  for (const AepFootage& item : project.footage) {
    PlannedFootage f;
    f.aepId = item.id;
    f.name = !item.name.empty() ? item.name : "Footage";
    f.kind = item.footageKind;
    f.path = item.path;
    f.width = item.width;
    f.height = item.height;
    f.durationSeconds = item.durationSeconds;
    f.frameRate = item.frameRate;
    f.isStill = item.isStill;
    f.hasAudio = item.hasAudio;
    f.missingAtSave = item.missingAtSave;
    if (item.solidColor) f.solidColor = hex_color(item.solidColor->r * 255, item.solidColor->g * 255, item.solidColor->b * 255);
    f.folder = item.folder;
    plan.footage.push_back(std::move(f));
  }

  const std::size_t n = plan.summary.unmappedEffects.size();
  if (n > 0) {
    std::string names;
    for (std::size_t i = 0; i < n; ++i) names += (i > 0 ? ", " : "") + plan.summary.unmappedEffects[i];
    plan.warnings.push_back(std::to_string(n) + (n == 1 ? " effect had no equivalent here and was skipped: "
                                                        : " effects had no equivalent here and were skipped: ") +
                            names);
  }
  return plan;
}

std::optional<std::size_t> main_comp(const AepImportPlan& plan) {
  std::set<std::uint32_t> used;
  for (const PlannedComp& c : plan.comps) {
    for (const PlannedLayer& l : c.layers) {
      if (l.source && l.source->comp) used.insert(l.source->aepId);
    }
  }
  std::vector<std::size_t> candidates;
  for (std::size_t i = 0; i < plan.comps.size(); ++i) {
    if (!used.contains(plan.comps[i].aepId)) candidates.push_back(i);
  }
  if (candidates.empty()) {
    for (std::size_t i = 0; i < plan.comps.size(); ++i) candidates.push_back(i);
  }
  if (candidates.empty()) return std::nullopt;
  std::stable_sort(candidates.begin(), candidates.end(), [&](std::size_t a, std::size_t b) {
    const PlannedComp& ca = plan.comps[a];
    const PlannedComp& cb = plan.comps[b];
    if (ca.durationSeconds != cb.durationSeconds) return ca.durationSeconds > cb.durationSeconds;
    return ca.width > cb.width;
  });
  return candidates[0];
}

}  // namespace premation::doc::aep
