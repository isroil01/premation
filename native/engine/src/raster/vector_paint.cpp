#include "vector_paint.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
#include <ranges>

#include "paint_common.hpp"
#include "paint_raster.hpp"

namespace premation::raster {
namespace {

using json::Value;

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

struct Pt {
  double x = 0, y = 0;
};
struct BPt {
  double x = 0, y = 0, inX = 0, inY = 0, outX = 0, outY = 0;
};
struct Run {
  std::vector<BPt> points;
  bool open = false;
  const Value* paint = nullptr;  // SubpathPaint {fill?, stroke?, opacity?}
};

std::vector<BPt> read_points(const Value& arr) {
  std::vector<BPt> out;
  out.reserve(arr.size());
  for (const auto& p : arr.items()) {
    out.push_back({p["x"].num(kNaN), p["y"].num(kNaN), p["inX"].num(kNaN), p["inY"].num(kNaN), p["outX"].num(kNaN),
                   p["outY"].num(kNaN)});
  }
  return out;
}

/// subpaths.ts layerSubpaths.
std::vector<Run> layer_subpaths(const Value& layer) {
  std::vector<Run> runs;
  const Value& subs = layer["subpaths"];
  if (subs.is_array() && subs.size() > 0) {
    for (const auto& s : subs.items()) {
      Run r;
      r.points = read_points(s["points"]);
      r.open = s["open"].is_bool() && s["open"].truthy();
      if (s["paint"].is_object()) r.paint = &s["paint"];
      runs.push_back(std::move(r));
    }
    return runs;
  }
  const Value& pts = layer["pathPoints"];
  if (pts.is_array() && pts.size() > 0) {
    Run r;
    r.points = read_points(pts);
    r.open = layer["pathOpen"].is_bool() && layer["pathOpen"].truthy();
    runs.push_back(std::move(r));
  }
  return runs;
}

void trace_run(Canvas2D& ctx, const Run& run) {
  const auto& pts = run.points;
  if (pts.empty()) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  const std::size_t lastSeg = run.open ? pts.size() - 1 : pts.size();
  for (std::size_t i = 0; i < lastSeg; ++i) {
    const BPt& curr = pts[i];
    const BPt& next = pts[(i + 1) % pts.size()];
    ctx.bezierCurveTo(curr.outX, curr.outY, next.inX, next.inY, next.x, next.y);
  }
  if (!run.open) ctx.closePath();
}

// ── strokes ──────────────────────────────────────────────────────────────────

struct Stroke {
  const Value* v = nullptr;
  [[nodiscard]] double width() const { return (*v)["width"].num(kNaN); }
  [[nodiscard]] std::string_view align() const { return (*v)["align"].str_or(""); }
};

std::string_view blend_op(std::string_view mode) {
  static constexpr auto kMap = std::to_array<std::pair<std::string_view, std::string_view>>({
      {"normal", "source-over"}, {"darken", "darken"}, {"multiply", "multiply"}, {"color-burn", "color-burn"},
      {"add", "lighter"}, {"lighten", "lighten"}, {"screen", "screen"}, {"color-dodge", "color-dodge"},
      {"overlay", "overlay"}, {"soft-light", "soft-light"}, {"hard-light", "hard-light"}, {"difference", "difference"},
      {"exclusion", "exclusion"}, {"hue", "hue"}, {"saturation", "saturation"}, {"color", "color"},
      {"luminosity", "luminosity"},
  });
  for (const auto& [k, op] : kMap) {
    if (k == mode) return op;
  }
  return "source-over";
}

void set_fill(Canvas2D& ctx, const std::optional<Style>& s) {
  if (s) ctx.setFillStyle(*s);
}
void set_stroke(Canvas2D& ctx, const std::optional<Style>& s) {
  if (s) ctx.setStrokeStyle(*s);
}

/// fillStyleFor: a gradient paint, or the solid fallback string.
std::optional<Style> fill_style_for(const Value* paint, std::string_view fallback, double w, double h) {
  const auto p = paint != nullptr ? read_fill_paint(*paint) : std::nullopt;
  if (!p || p->type == FillPaint::Type::solid) return color_style(fallback);
  return make_canvas_gradient(*p, w, h);
}

/// strokeGradientFor — AE's Start/End gradient stroke geometry.
Style stroke_gradient_for(const FillPaint& paint, const Value& g, double w, double h) {
  const double sx = (g["startX"].num(kNaN) - 0.5) * w;
  const double sy = (g["startY"].num(kNaN) - 0.5) * h;
  const double ex = (g["endX"].num(kNaN) - 0.5) * w;
  const double ey = (g["endY"].num(kNaN) - 0.5) * h;
  auto grad = std::make_shared<Gradient>();
  if (paint.type == FillPaint::Type::linear) {
    grad->kind = Gradient::Kind::linear;
    grad->p[0] = sx; grad->p[1] = sy; grad->p[2] = ex; grad->p[3] = ey;
  } else {
    const double r = std::max(1e-3, js_hypot(ex - sx, ey - sy));
    const double hl = std::max(-0.99, std::min(0.99, g["highlightLength"].num(0)));
    const double ang = js_atan2(ey - sy, ex - sx) + (g["highlightAngle"].num(0) * kJsPi) / 180;
    grad->kind = Gradient::Kind::radial;
    grad->p[0] = sx + js_cos(ang) * hl * r;
    grad->p[1] = sy + js_sin(ang) * hl * r;
    grad->p[2] = 0;
    grad->p[3] = sx; grad->p[4] = sy; grad->p[5] = r;
  }
  for (const auto& s : gradient_stops(paint)) grad->add_stop(s.offset, s.color);
  Style st;
  st.kind = Style::Kind::gradient;
  st.gradient = std::move(grad);
  return st;
}

std::optional<Style> stroke_paint_style(const Value& stroke, double w, double h) {
  const auto p = read_fill_paint(stroke["paint"]);
  if (p && p->type != FillPaint::Type::solid) {
    if (stroke["gradient"].is_object()) return stroke_gradient_for(*p, stroke["gradient"], w, h);
    return fill_style_for(&stroke["paint"], stroke["color"].str_or(""), w, h);
  }
  if (p && p->type == FillPaint::Type::solid) return color_style(p->color);
  return color_style(stroke["color"].str_or(""));
}

std::optional<LineCap> cap_of(std::string_view s) {
  if (s == "butt") return LineCap::butt;
  if (s == "round") return LineCap::round;
  if (s == "square") return LineCap::square;
  return std::nullopt;
}
std::optional<LineJoin> join_of(std::string_view s) {
  if (s == "miter") return LineJoin::miter;
  if (s == "round") return LineJoin::round;
  if (s == "bevel") return LineJoin::bevel;
  return std::nullopt;
}

void apply_stroke_style(Canvas2D& ctx, const Value& stroke, double widthOverride, double w, double h) {
  const double opRaw = stroke["opacity"].num(kNaN);
  const double opacity = std::isfinite(opRaw) ? opRaw : 1;
  ctx.setGlobalAlpha(ctx.globalAlpha() * clamp01(opacity));
  set_stroke(ctx, stroke_paint_style(stroke, w, h));
  ctx.setLineWidth(widthOverride);
  if (const auto c = cap_of(stroke["cap"].str_or(""))) ctx.setLineCap(*c);
  if (const auto j = join_of(stroke["join"].str_or(""))) ctx.setLineJoin(*j);
  ctx.setMiterLimit(stroke["miterLimit"].is_number() ? stroke["miterLimit"].num() : 4);
  std::vector<double> dash;
  for (const auto& d : stroke["dash"].items()) dash.push_back(d.num(kNaN));
  ctx.setLineDash(dash);
  ctx.setLineDashOffset(stroke["dashOffset"].is_number() ? stroke["dashOffset"].num() : 0);
}

template <typename Trace>
void stroke_shape(Canvas2D& ctx, const Value& stroke, const Trace& trace, double w, double h) {
  const double width = stroke["width"].num(kNaN);
  if (width <= 0) return;
  ctx.save();
  const std::string_view align = stroke["align"].str_or("");
  if (align != "center") {
    trace();
    if (align == "inside") {
      ctx.clip(FillRule::nonzero);
    } else {
      ctx.rect(-1e5, -1e5, 2e5, 2e5);
      ctx.clip(FillRule::evenodd);
    }
    apply_stroke_style(ctx, stroke, width * 2, w, h);
  } else {
    apply_stroke_style(ctx, stroke, width, w, h);
  }
  trace();
  ctx.stroke();
  ctx.setLineDash({});
  ctx.setLineDashOffset(0);
  ctx.restore();
}

// ── profiled (taper / wave) strokes ──────────────────────────────────────────

struct Taper {
  double startLength = 0, endLength = 0, startWidth = 1, endWidth = 1, startEase = 0, endEase = 0;
  bool pixels = false;
};
struct Wave {
  double amount = 0, wavelength = 0, phase = 0;
  bool cycles = false;
};

std::optional<Taper> read_taper(const Value& v) {
  if (!v.is_object()) return std::nullopt;
  Taper t{v["startLength"].num(kNaN), v["endLength"].num(kNaN), v["startWidth"].num(kNaN), v["endWidth"].num(kNaN),
          v["startEase"].num(kNaN), v["endEase"].num(kNaN), v["lengthUnits"].str_or("") == "pixels"};
  return t;
}
std::optional<Wave> read_wave(const Value& v) {
  if (!v.is_object()) return std::nullopt;
  return Wave{v["amount"].num(kNaN), v["wavelength"].num(kNaN), v["phase"].num(kNaN), v["units"].str_or("") == "cycles"};
}
bool identity_taper(const std::optional<Taper>& t) {
  if (!t) return true;
  const bool noRamp = t->startLength <= 0 && t->endLength <= 0;
  const bool full = t->startWidth == 1 && t->endWidth == 1;
  return noRamp || full;
}
bool identity_wave(const std::optional<Wave>& w) { return !w || w->amount == 0 || w->wavelength <= 0; }

double ease_ramp(double u, double ease) {
  const double x = u < 0 ? 0 : u > 1 ? 1 : u;
  const double e = ease < -1 ? -1 : ease > 1 ? 1 : ease;
  if (e == 0 || !std::isfinite(e)) return x;
  const double target = e > 0 ? std::sqrt(std::max(0.0, 1 - (1 - x) * (1 - x))) : x * x;
  return x + (target - x) * std::fabs(e);
}
Taper taper_for_length(const Taper& t, double total) {
  if (!t.pixels) return t;
  const double tot = total > 0 ? total : 1;
  const auto frac = [tot](double px) { return std::max(0.0, std::min(1.0, px / tot)); };
  return {frac(t.startLength), frac(t.endLength), t.startWidth, t.endWidth, t.startEase, t.endEase, false};
}
Wave wave_for_length(const Wave& w, double total) {
  if (!w.cycles) return w;
  const double c = w.wavelength;
  return {w.amount, c > 0 && total > 0 ? total / c : 0, w.phase, false};
}
double taper_factor_at(const Taper& t, double s) {
  if (identity_taper(t)) return 1;
  const double x = s < 0 ? 0 : s > 1 ? 1 : s;
  double factor = 1;
  if (t.startLength > 0 && x < t.startLength) {
    const double u = ease_ramp(x / t.startLength, t.startEase);
    factor = std::min(factor, t.startWidth + (1 - t.startWidth) * u);
  }
  if (t.endLength > 0 && x > 1 - t.endLength) {
    const double u = ease_ramp((1 - x) / t.endLength, t.endEase);
    factor = std::min(factor, t.endWidth + (1 - t.endWidth) * u);
  }
  return factor < 0 ? 0 : factor;
}
double wave_offset_at(const Wave& w, double arc) {
  if (identity_wave(w)) return 0;
  const double phaseRad = (w.phase * kJsPi) / 180;
  return w.amount * js_sin((2 * kJsPi * arc) / w.wavelength + phaseRad);
}

constexpr int kAdaptive = -1;
constexpr int kWavePerSeg = 64;
constexpr double kWaveSamplesPerPeriod = 12;
constexpr int kCapArcSteps = 16;
constexpr int kJoinArcSteps = 10;
const double kJoinCornerAngle = (40 * kJsPi) / 180;
constexpr double kEllipseKappa = 0.5522847498307936;

Pt cubic_at(const BPt& a, const BPt& b, double t) {
  const double u = 1 - t;
  const double w0 = u * u * u;
  const double w1 = 3 * u * u * t;
  const double w2 = 3 * u * t * t;
  const double w3 = t * t * t;
  return {w0 * a.x + w1 * a.outX + w2 * b.inX + w3 * b.x, w0 * a.y + w1 * a.outY + w2 * b.inY + w3 * b.y};
}
int adaptive_steps(const BPt& a, const BPt& b) {
  const double len = js_hypot(a.outX - a.x, a.outY - a.y) + js_hypot(b.inX - a.outX, b.inY - a.outY) +
                     js_hypot(b.x - b.inX, b.y - b.inY);
  const double steps = std::ceil(len / 2.5);
  return static_cast<int>(std::max(8.0, std::min(160.0, steps)));
}
std::vector<Pt> flatten_outline(const std::vector<BPt>& pts, int perSeg, bool open) {
  const std::size_t n = pts.size();
  std::vector<Pt> out;
  if (n < 2) {
    for (const auto& p : pts) out.push_back({p.x, p.y});
    return out;
  }
  const std::size_t segments = open ? n - 1 : n;
  for (std::size_t i = 0; i < segments; ++i) {
    const BPt& a = pts[i];
    const BPt& b = pts[(i + 1) % n];
    out.push_back({a.x, a.y});
    const bool curved = a.outX != a.x || a.outY != a.y || b.inX != b.x || b.inY != b.y;
    if (curved) {
      const int steps = perSeg == kAdaptive ? adaptive_steps(a, b) : perSeg;
      for (int s = 1; s < steps; ++s) out.push_back(cubic_at(a, b, static_cast<double>(s) / steps));
    }
  }
  if (open) out.push_back({pts[n - 1].x, pts[n - 1].y});
  return out;
}

double polyline_length(const std::vector<Pt>& p) {
  double len = 0;
  for (std::size_t i = 1; i < p.size(); ++i) len += js_hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
  return len;
}

std::vector<Pt> densify_for_wave(const std::vector<Pt>& poly, const std::optional<Wave>& wave) {
  if (!wave.has_value() || identity_wave(wave) || poly.size() < 2) return poly;
  const double maxSpan = wave->wavelength / kWaveSamplesPerPeriod;
  if (!(maxSpan > 0)) return poly;
  std::vector<Pt> out{poly[0]};
  for (std::size_t i = 1; i < poly.size(); ++i) {
    const Pt& a = poly[i - 1];
    const Pt& b = poly[i];
    const double steps = std::ceil(js_hypot(b.x - a.x, b.y - a.y) / maxSpan);
    for (int k = 1; k <= static_cast<int>(steps); ++k) {
      const double u = k / steps;
      out.push_back({a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u});
    }
  }
  return out;
}

struct Sides {
  std::vector<Pt> left, right;
};
template <typename F>
Sides offset_along_normals(const std::vector<Pt>& points, const F& distanceAt) {
  const std::size_t n = points.size();
  Sides s;
  if (n < 2) return s;
  for (std::size_t i = 0; i < n; ++i) {
    const Pt& prev = points[i == 0 ? 0 : i - 1];
    const Pt& next = points[std::min(n - 1, i + 1)];
    const double tx = next.x - prev.x;
    const double ty = next.y - prev.y;
    double len = js_hypot(tx, ty);
    if (len == 0 || std::isnan(len)) len = 1;  // `|| 1`
    const double nx = -ty / len;
    const double ny = tx / len;
    const double d = distanceAt(i);
    const Pt& p = points[i];
    s.left.push_back({p.x + nx * d, p.y + ny * d});
    s.right.push_back({p.x - nx * d, p.y - ny * d});
  }
  return s;
}

std::vector<std::pair<double, double>> dash_spans(double total, const std::vector<double>& dash, double offset) {
  std::vector<double> pattern;
  for (const double nn : dash) {
    if (std::isfinite(nn) && nn >= 0) pattern.push_back(nn);
  }
  if (pattern.empty()) return {{0, total}};
  std::vector<double> p = pattern;
  if (p.size() % 2 == 1) p.insert(p.end(), pattern.begin(), pattern.end());
  double period = 0;
  for (const double x : p) period += x;
  if (period <= 0) return {{0, total}};
  std::vector<std::pair<double, double>> spans;
  double cursor = -period + std::fmod(std::fmod(-offset, period) + period, period);
  std::size_t idx = 0;
  int guard = 0;
  while (cursor < total && guard++ < 100000) {
    const double len = p[idx % p.size()];
    const bool on = idx % 2 == 0;
    const double end = cursor + len;
    if (on && end > 0 && cursor < total) spans.emplace_back(std::max(0.0, cursor), std::min(total, end));
    cursor = end;
    ++idx;
  }
  return spans;
}

struct Piece {
  std::vector<Pt> pts;
  std::vector<double> at;
};
Piece sub_polyline(const std::vector<Pt>& pts, const std::vector<double>& arc, double s0, double s1) {
  Piece out;
  const auto lerpAt = [&](std::size_t i, double f) {
    const Pt& a = pts[i];
    const Pt& b = pts[std::min(pts.size() - 1, i + 1)];
    out.pts.push_back({a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f});
    out.at.push_back(static_cast<double>(i) + f);
  };
  for (std::size_t i = 0; i + 1 < pts.size(); ++i) {
    const double a0 = arc[i];
    const double a1 = arc[i + 1];
    if (a1 <= s0 || a0 >= s1) continue;
    double seg = a1 - a0;
    if (seg == 0 || std::isnan(seg)) seg = 1;
    if (out.pts.empty()) lerpAt(i, std::max(0.0, (s0 - a0) / seg));
    const double endF = std::min(1.0, (s1 - a0) / seg);
    if (endF >= 1) {
      out.pts.push_back(pts[i + 1]);
      out.at.push_back(static_cast<double>(i + 1));
    } else {
      lerpAt(i, endF);
    }
  }
  return out;
}

std::optional<Pt> unit_from(const Pt& a, const Pt& b) {
  const double dx = b.x - a.x;
  const double dy = b.y - a.y;
  const double len = js_hypot(dx, dy);
  if (len > 0) return Pt{dx / len, dy / len};
  return std::nullopt;
}

std::vector<Pt> cap_points(const Pt& c, const Pt& leaving, const Pt& arriving, const Pt& outward, std::string_view cap) {
  const double r = js_hypot(leaving.x - c.x, leaving.y - c.y);
  if (!(r > 0)) return {};
  if (cap == "square") {
    return {{leaving.x + outward.x * r, leaving.y + outward.y * r}, {arriving.x + outward.x * r, arriving.y + outward.y * r}};
  }
  const double a0 = js_atan2(leaving.y - c.y, leaving.x - c.x);
  std::vector<Pt> out;
  for (int s = 1; s < kCapArcSteps; ++s) {
    const double a = a0 - (kJsPi * s) / kCapArcSteps;
    out.push_back({c.x + js_cos(a) * r, c.y + js_sin(a) * r});
  }
  return out;
}

template <typename F>
Sides ribbon_sides_with_joins(const std::vector<Pt>& pts, const F& halfAt, std::string_view join, double miterLimit, bool closed) {
  Sides base = offset_along_normals(pts, halfAt);
  const std::size_t n = pts.size();
  if (n < 3) return base;
  Sides out;
  const auto segNormal = [&](std::size_t i) -> std::optional<Pt> {
    const auto d = unit_from(pts[i], pts[i + 1]);
    if (!d) return std::nullopt;
    return Pt{-d->y, d->x};
  };
  const bool seam = closed && n >= 4 && js_hypot(pts[0].x - pts[n - 1].x, pts[0].y - pts[n - 1].y) < 1e-6;
  const auto seamSides = [&](std::size_t i) {
    const Pt& p = pts[i];
    const double tx = pts[1].x - pts[n - 2].x;
    const double ty = pts[1].y - pts[n - 2].y;
    double len = js_hypot(tx, ty);
    if (len == 0 || std::isnan(len)) len = 1;
    const double d = halfAt(i);
    const double nx = (-ty / len) * d;
    const double ny = (tx / len) * d;
    return std::make_pair(Pt{p.x + nx, p.y + ny}, Pt{p.x - nx, p.y - ny});
  };
  for (std::size_t i = 0; i < n; ++i) {
    const bool atSeam = seam && (i == 0 || i == n - 1);
    const std::optional<Pt> nPrev = i > 0 ? segNormal(i - 1) : atSeam ? segNormal(n - 2) : std::nullopt;
    const std::optional<Pt> nNext = i < n - 1 ? segNormal(i) : atSeam ? segNormal(0) : std::nullopt;
    if (!nPrev || !nNext) {
      out.left.push_back(base.left[i]);
      out.right.push_back(base.right[i]);
      continue;
    }
    const double cross = nPrev->x * nNext->y - nPrev->y * nNext->x;
    const double dot = nPrev->x * nNext->x + nPrev->y * nNext->y;
    const double turn = js_atan2(cross, dot);
    if (std::fabs(turn) < kJoinCornerAngle) {
      if (atSeam) {
        const auto s = seamSides(i);
        out.left.push_back(s.first);
        out.right.push_back(s.second);
      } else {
        out.left.push_back(base.left[i]);
        out.right.push_back(base.right[i]);
      }
      continue;
    }
    const Pt& p = pts[i];
    const double h = halfAt(i);
    const bool outerIsLeft = turn < 0;
    const double sign = outerIsLeft ? 1 : -1;
    const Pt a{p.x + nPrev->x * h * sign, p.y + nPrev->y * h * sign};
    const Pt b{p.x + nNext->x * h * sign, p.y + nNext->y * h * sign};
    std::vector<Pt> outer{a};
    if (join == "round") {
      const double a0 = js_atan2(a.y - p.y, a.x - p.x);
      for (int s = 1; s < kJoinArcSteps; ++s) {
        const double ang = a0 + (turn * s) / kJoinArcSteps;
        outer.push_back({p.x + js_cos(ang) * h, p.y + js_sin(ang) * h});
      }
    } else if (join == "miter") {
      const double half = std::fabs(turn) / 2;
      const double ratio = 1 / std::max(1e-6, js_cos(half));
      if (ratio <= miterLimit) {
        const double bx = a.x - p.x + (b.x - p.x);
        const double by = a.y - p.y + (b.y - p.y);
        const double bl = js_hypot(bx, by);
        if (bl > 1e-9) outer.push_back({p.x + (bx / bl) * h * ratio, p.y + (by / bl) * h * ratio});
      }
    }
    outer.push_back(b);
    const std::vector<Pt> outerPts = atSeam && i == 0 ? std::vector<Pt>{b} : outer;
    const auto inner = atSeam ? seamSides(i) : std::make_pair(base.left[i], base.right[i]);
    if (outerIsLeft) {
      out.left.insert(out.left.end(), outerPts.begin(), outerPts.end());
      out.right.push_back(inner.second);
    } else {
      out.right.insert(out.right.end(), outerPts.begin(), outerPts.end());
      out.left.push_back(inner.first);
    }
  }
  return out;
}

std::vector<Pt> closed_ribbon(const Sides& s) {
  if (s.left.empty()) return {};
  std::vector<Pt> out = s.left;
  out.insert(out.end(), s.right.rbegin(), s.right.rend());
  return out;
}

std::vector<Pt> capped_ribbon(const std::vector<Pt>& pts, const Sides& sides, std::string_view cap) {
  const std::size_t n = sides.left.size();
  if (cap == "butt" || n < 2) return closed_ribbon(sides);
  const std::size_t last = n - 1;
  const auto outFar = unit_from(pts[last - 1], pts[last]);
  const auto outNear = unit_from(pts[1], pts[0]);
  if (!outFar || !outNear) return closed_ribbon(sides);
  std::vector<Pt> out = sides.left;
  const auto c1 = cap_points(pts[last], sides.left[last], sides.right[last], *outFar, cap);
  out.insert(out.end(), c1.begin(), c1.end());
  out.insert(out.end(), sides.right.rbegin(), sides.right.rend());
  const auto c2 = cap_points(pts[0], sides.right[0], sides.left[0], *outNear, cap);
  out.insert(out.end(), c2.begin(), c2.end());
  return out;
}

void round_rect(Canvas2D& ctx, double x, double y, double w, double h, std::array<double, 4> raw, std::array<double, 2> axisScale);

void shape_path(Canvas2D& ctx, const Value& layer, const std::vector<Run>& runs) {
  const double w = layer["width"].num(kNaN);
  const double h = layer["height"].num(kNaN);
  const std::string_view prim = layer["primitive"].str_or("");
  if (prim == "ellipse") {
    ctx.beginPath();
    ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, kJsPi * 2, false);
  } else if (prim == "path" && !runs.empty()) {
    ctx.beginPath();
    for (const auto& r : runs) trace_run(ctx, r);
  } else {
    std::array<double, 4> radii{};
    if (layer["cornerRadii"].is_array()) {
      for (std::size_t i = 0; i < 4; ++i) radii.at(i) = layer["cornerRadii"][i].num(0);
    } else {
      const double r = layer["cornerRadius"].num(0);
      radii = {r, r, r, r};
    }
    std::array<double, 2> as{1, 1};
    if (layer["cornerRadiusScale"].is_array()) as = {layer["cornerRadiusScale"][0].num(1), layer["cornerRadiusScale"][1].num(1)};
    round_rect(ctx, -w / 2, -h / 2, w, h, radii, as);
  }
}

void round_rect(Canvas2D& ctx, double x, double y, double w, double h, std::array<double, 4> raw, std::array<double, 2> axisScale) {
  const double kx = axisScale[0] > 1e-6 ? 1 / axisScale[0] : 1;
  const double ky = axisScale[1] > 1e-6 ? 1 / axisScale[1] : 1;
  const auto scale = [](double a, double b, double k, double limit) {
    const double sum = (a + b) * k;
    if (sum <= limit || sum <= 1e-6) return 1.0;
    return limit / sum;
  };
  double tl = std::max(0.0, raw[0]);
  double tr = std::max(0.0, raw[1]);
  double br = std::max(0.0, raw[2]);
  double bl = std::max(0.0, raw[3]);
  const double s = std::min({scale(tl, tr, kx, w), scale(tr, br, ky, h), scale(br, bl, kx, w), scale(bl, tl, ky, h), 1.0});
  tl *= s; tr *= s; br *= s; bl *= s;
  const auto ax = [kx](double v) { return v * kx; };
  const auto ay = [ky](double v) { return v * ky; };
  const auto visible = [&](double v) { return ax(v) > 0.5 || ay(v) > 0.5; };
  ctx.beginPath();
  if (!visible(tl) && !visible(tr) && !visible(br) && !visible(bl)) {
    ctx.rect(x, y, w, h);
    return;
  }
  const bool isotropic = std::fabs(kx - ky) < 1e-9;
  const auto corner = [&](double v, double cx, double cy, double a0, double cornerX, double cornerY, double toX, double toY) {
    if (isotropic) ctx.arcTo(cornerX, cornerY, toX, toY, ax(v));
    else ctx.ellipse(cx, cy, ax(v), ay(v), 0, a0, a0 + kJsPi / 2, false);
  };
  const double halfPi = kJsPi / 2;
  ctx.moveTo(x + ax(tl), y);
  ctx.lineTo(x + w - ax(tr), y);
  if (visible(tr)) corner(tr, x + w - ax(tr), y + ay(tr), -halfPi, x + w, y, x + w, y + ay(tr));
  else ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - ay(br));
  if (visible(br)) corner(br, x + w - ax(br), y + h - ay(br), 0, x + w, y + h, x + w - ax(br), y + h);
  else ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + ax(bl), y + h);
  if (visible(bl)) corner(bl, x + ax(bl), y + h - ay(bl), halfPi, x, y + h, x, y + h - ay(bl));
  else ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + ay(tl));
  if (visible(tl)) corner(tl, x + ax(tl), y + ay(tl), kJsPi, x, y, x + ax(tl), y);
  else ctx.lineTo(x, y);
  ctx.closePath();
}

Run primitive_run(const Value& layer, std::vector<std::string>& unsupported) {
  const double w = layer["width"].num(kNaN);
  const double h = layer["height"].num(kNaN);
  Run r;
  if (layer["primitive"].str_or("") == "ellipse") {
    const double rx = w / 2;
    const double ry = h / 2;
    const double kx = rx * kEllipseKappa;
    const double ky = ry * kEllipseKappa;
    r.points = {{rx, 0, rx, -ky, rx, ky}, {0, ry, kx, ry, -kx, ry}, {-rx, 0, -rx, ky, -rx, -ky}, {0, -ry, -kx, -ry, kx, -ry}};
    return r;
  }
  const bool rounded = (layer["cornerRadius"].num(0) > 0) || layer["cornerRadii"].is_array();
  if (rounded) unsupported.emplace_back("profiled stroke on a rounded rect (pathOps rectOutline)");
  r.points = {{-w / 2, -h / 2, -w / 2, -h / 2, -w / 2, -h / 2}, {w / 2, -h / 2, w / 2, -h / 2, w / 2, -h / 2},
              {w / 2, h / 2, w / 2, h / 2, w / 2, h / 2}, {-w / 2, h / 2, -w / 2, h / 2, -w / 2, h / 2}};
  return r;
}

bool stroke_shape_profiled(Canvas2D& ctx, const Value& stroke, const Value& layer, double w, double h,
                           const std::vector<Run>* runsOverride, const std::vector<Run>& layerRuns,
                           std::vector<std::string>& unsupported) {
  const double width = stroke["width"].num(kNaN);
  if (width <= 0) return false;
  const auto taper = read_taper(stroke["taper"]);
  const auto wave = read_wave(stroke["wave"]);
  if (identity_taper(taper) && identity_wave(wave)) return false;
  std::vector<Run> runs;
  if (runsOverride != nullptr) runs = *runsOverride;
  else if (layer["primitive"].str_or("") == "path") runs = layerRuns;
  else runs = {primitive_run(layer, unsupported)};
  if (runs.empty()) return false;

  ctx.save();
  ctx.setGlobalAlpha(ctx.globalAlpha() * std::max(0.0, std::min(1.0, stroke["opacity"].num(kNaN))));
  const bool aligned = stroke["align"].str_or("") != "center";
  if (aligned) {
    if (runsOverride != nullptr) {
      ctx.beginPath();
      for (const auto& r : *runsOverride) trace_run(ctx, r);
    } else {
      shape_path(ctx, layer, layerRuns);
    }
    if (stroke["align"].str_or("") == "inside") {
      ctx.clip(FillRule::nonzero);
    } else {
      ctx.rect(-1e5, -1e5, 2e5, 2e5);
      ctx.clip(FillRule::evenodd);
    }
  }
  const double effectiveWidth = aligned ? width * 2 : width;
  set_fill(ctx, stroke_paint_style(stroke, w, h));
  const std::string_view cap = stroke["cap"].str_or("");
  const std::string_view join = stroke["join"].str_or("");
  const double miter = std::max(1.0, stroke["miterLimit"].is_number() ? stroke["miterLimit"].num() : 4);
  std::vector<double> dash;
  for (const auto& d : stroke["dash"].items()) dash.push_back(d.num(kNaN));
  bool drew = false;
  for (const auto& run : runs) {
    const bool open = run.open;
    const int perSeg = identity_wave(wave) ? kAdaptive : kWavePerSeg;
    std::vector<Pt> flat = flatten_outline(run.points, perSeg, open);
    if (!open && flat.size() > 1) flat.push_back(flat[0]);
    std::optional<Wave> runWave = wave;
    if (wave && wave->cycles) runWave = wave_for_length(*wave, polyline_length(flat));
    const std::vector<Pt> poly = densify_for_wave(flat, runWave);
    if (poly.size() < 2) continue;
    std::vector<double> arc{0};
    for (std::size_t i = 1; i < poly.size(); ++i) arc.push_back(arc[i - 1] + js_hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y));
    double total = arc.back();
    if (total == 0 || std::isnan(total)) total = 1;
    std::optional<Taper> runTaper = taper;
    if (taper) runTaper = taper_for_length(*taper, total);
    const std::vector<Pt> centre = identity_wave(runWave)
                                       ? poly
                                       : offset_along_normals(poly, [&](std::size_t i) { return wave_offset_at(*runWave, arc[i]); }).left;
    const bool dashed = !dash.empty();
    const auto spans = dashed ? dash_spans(total, dash, stroke["dashOffset"].num(0)) : std::vector<std::pair<double, double>>{{0, total}};
    const std::string_view spanCap = open || dashed ? cap : std::string_view("butt");
    const auto halfWidthAt = [&](std::size_t i) {
      const double factor = runTaper ? taper_factor_at(*runTaper, arc[i] / total) : 1;
      return (effectiveWidth * factor) / 2;
    };
    for (const auto& [s0, s1] : spans) {
      const Piece piece = sub_polyline(centre, arc, s0, s1);
      if (piece.pts.size() < 2) continue;
      const auto widthOf = [&](std::size_t i) {
        const double a = piece.at[i];
        const auto last = static_cast<double>(arc.size() - 1);
        const auto lo = static_cast<std::size_t>(std::max(0.0, std::min(last, std::floor(a))));
        const auto hi = static_cast<std::size_t>(std::max(0.0, std::min(last, std::ceil(a))));
        const double f = a - static_cast<double>(lo);
        return halfWidthAt(lo) * (1 - f) + halfWidthAt(hi) * f;
      };
      const Sides sides = ribbon_sides_with_joins(piece.pts, widthOf, join, miter, !open && !dashed);
      const std::vector<Pt> ring = capped_ribbon(piece.pts, sides, spanCap);
      if (ring.size() < 3) continue;
      ctx.beginPath();
      ctx.moveTo(ring[0].x, ring[0].y);
      for (std::size_t i = 1; i < ring.size(); ++i) ctx.lineTo(ring[i].x, ring[i].y);
      ctx.closePath();
      ctx.fill(FillRule::nonzero);
      drew = true;
    }
  }
  ctx.restore();
  return drew;
}

// ── ordered paint stack ─────────────────────────────────────────────────────

struct PaintOp {
  bool isFill = true;
  const Value* fill = nullptr;    // FillPaint JSON or null
  const Value* stroke = nullptr;  // Stroke JSON
};

bool flagged(const Value* o) {
  if (o == nullptr || !o->is_object()) return false;
  const std::string_view bm = (*o)["blendMode"].str_or("");
  return (*o)["composite"].str_or("") == "above" || ((*o).has("blendMode") && !(*o)["blendMode"].is_null() && bm != "normal");
}

bool has_ordered_paint(const std::vector<const Value*>& fills, const std::vector<const Value*>& strokes) {
  return std::ranges::any_of(fills, flagged) || std::ranges::any_of(strokes, flagged);
}

std::vector<PaintOp> paint_render_order(const std::vector<const Value*>& fills, const std::vector<const Value*>& strokes) {
  std::vector<PaintOp> list;
  list.reserve(strokes.size() + fills.size());
  for (const Value* s : std::views::reverse(strokes)) list.push_back({false, nullptr, s});
  for (const Value* f : std::views::reverse(fills)) list.push_back({true, f, nullptr});
  std::vector<std::size_t> z;  // indices into list
  for (std::size_t j = 0; j < list.size(); ++j) {
    if (j == 0) { z.push_back(0); continue; }
    const auto at = static_cast<std::size_t>(std::ranges::find(z, j - 1) - z.begin());
    const Value* opts = list[j].isFill ? list[j].fill : list[j].stroke;
    const bool above = opts != nullptr && (*opts)["composite"].str_or("") == "above";
    z.insert(z.begin() + static_cast<std::ptrdiff_t>(above ? at + 1 : at), j);
  }
  std::vector<PaintOp> out;
  out.reserve(z.size());
  for (const std::size_t i : z) out.push_back(list[i]);
  return out;
}

}  // namespace

void paint_path_layer(Canvas2D& ctx, const Value& layer, std::vector<std::string>& unsupported) {
  const double w = layer["width"].num(kNaN);
  const double h = layer["height"].num(kNaN);
  const std::string fillFallback = layer["fill"].is_string() ? layer["fill"].str() : std::string("undefined");
  const std::vector<Run> runs = layer_subpaths(layer);

  std::vector<const Value*> strokeStack;
  if (layer["strokes"].is_array() && layer["strokes"].size() > 0) {
    for (const auto& s : layer["strokes"].items()) strokeStack.push_back(&s);
  } else if (layer["stroke"].is_object()) {
    strokeStack.push_back(&layer["stroke"]);
  }
  const auto layerFillPaint = [&]() -> const Value* { return layer["fillPaint"].is_object() ? &layer["fillPaint"] : nullptr; };

  const auto stroke_one = [&](const Value& s, const std::vector<Run>* sub, const auto& trace) {
    if (stroke_shape_profiled(ctx, s, layer, w, h, sub, runs, unsupported)) return;
    stroke_shape(ctx, s, trace, w, h);
  };

  // subpathBatches: only for a path whose runs carry their own paint.
  const bool batched = layer["primitive"].str_or("") == "path" && !runs.empty() &&
                       std::ranges::any_of(runs, [](const Run& r) { return r.paint != nullptr; });
  if (batched) {
    struct Batch {
      std::vector<Run> runs;
      const Value* paint = nullptr;
    };
    std::vector<Batch> batches;
    Batch plain;
    for (const auto& r : runs) {
      if (r.paint == nullptr) plain.runs.push_back(r);
    }
    if (!plain.runs.empty()) batches.push_back(std::move(plain));
    for (const auto& r : runs) {
      if (r.paint != nullptr) batches.push_back({{r}, r.paint});
    }
    for (const auto& batch : batches) {
      const auto trace = [&] {
        ctx.beginPath();
        for (const auto& r : batch.runs) trace_run(ctx, r);
      };
      ctx.save();
      const double alpha = batch.paint != nullptr ? (*batch.paint)["opacity"].num(1) : 1;
      if (alpha < 1) ctx.setGlobalAlpha(ctx.globalAlpha() * alpha);
      const Value* batchFill = batch.paint != nullptr && (*batch.paint)["fill"].is_object() ? &(*batch.paint)["fill"] : layerFillPaint();
      std::vector<const Value*> batchStrokes;
      if (batch.paint != nullptr && (*batch.paint)["stroke"].is_object()) batchStrokes.push_back(&(*batch.paint)["stroke"]);
      else batchStrokes = strokeStack;
      if (has_ordered_paint({batchFill}, batchStrokes)) {
        for (const auto& op : paint_render_order({batchFill}, batchStrokes)) {
          ctx.save();
          const Value* o = op.isFill ? op.fill : op.stroke;
          (void)ctx.setGlobalCompositeOperation(blend_op(o != nullptr ? (*o)["blendMode"].str_or("") : ""));
          if (op.isFill) {
            trace();
            set_fill(ctx, fill_style_for(op.fill, fillFallback, w, h));
            ctx.fill(FillRule::nonzero);
          } else {
            stroke_one(*op.stroke, &batch.runs, trace);
          }
          ctx.restore();
        }
        ctx.restore();
        continue;
      }
      trace();
      set_fill(ctx, fill_style_for(batchFill, fillFallback, w, h));
      ctx.fill(FillRule::nonzero);
      for (const Value* s : batchStrokes) stroke_one(*s, &batch.runs, trace);
      ctx.restore();
    }
  } else {
    std::vector<const Value*> fills;
    if (layer["fillPaints"].is_array() && layer["fillPaints"].size() > 0) {
      for (const auto& f : layer["fillPaints"].items()) fills.push_back(&f);
    } else {
      fills.push_back(layerFillPaint());
    }
    const auto trace = [&] { shape_path(ctx, layer, runs); };
    if (has_ordered_paint(fills, strokeStack)) {
      for (const auto& op : paint_render_order(fills, strokeStack)) {
        ctx.save();
        const Value* o = op.isFill ? op.fill : op.stroke;
        (void)ctx.setGlobalCompositeOperation(blend_op(o != nullptr ? (*o)["blendMode"].str_or("") : ""));
        if (op.isFill) {
          trace();
          set_fill(ctx, fill_style_for(op.fill, fillFallback, w, h));
          ctx.fill(FillRule::nonzero);
        } else {
          stroke_one(*op.stroke, nullptr, trace);
        }
        ctx.restore();
      }
    } else {
      trace();
      for (const Value* f : fills) {
        set_fill(ctx, fill_style_for(f, fillFallback, w, h));
        ctx.fill(FillRule::nonzero);
      }
      for (const Value* s : strokeStack) stroke_one(*s, nullptr, trace);
    }
  }
  // The layer's paint over its content, in the centred local transform
  // (Canvas2DVectorRasterizer.drawPaint → paintRaster.ts drawPaint).
  if (has_paint_strokes(layer["paint"])) draw_paint(ctx, layer["paint"]);
}

}  // namespace premation::raster
