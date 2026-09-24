// paintRaster.ts + paintDabs.ts, ported call for call (see paint_raster.hpp).
// Every Canvas2D call and property write happens in the TS's order with the
// TS's values, so a recorded TS call log and this port's log are the same
// program (tests/test_paint_raster.cpp checks that against
// src/core/paint/paintRasterCrossEngine.test.ts).

#include "paint_raster.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <list>
#include <map>
#include <memory>
#include <string_view>
#include <utility>

#include "numconv.hpp"
#include "paint_common.hpp"

namespace premation::raster {
namespace {

const double kNaN = std::numeric_limits<double>::quiet_NaN();
constexpr double kDeg = kJsPi / 180;
constexpr std::size_t kStampCacheMax = 128;
constexpr std::size_t kMaxDabs = 200'000;

using json::Value;

// ── the stroke model (PaintStroke; absent fields as the TS reads them) ──────

std::optional<double> opt_num(const Value& v) { return v.is_number() ? std::optional<double>(v.num()) : std::nullopt; }
/// A string field; nullopt when absent / not a string.
std::optional<std::string> opt_str(const Value& v) { return v.is_string() ? std::optional<std::string>(v.str()) : std::nullopt; }
/// JS truthiness of an optional string (absent or '' = false).
bool truthy(const std::optional<std::string>& s) { return s.has_value() && !s->empty(); }

struct Xf {
  std::optional<double> anchorX, anchorY, x, y, scale, rotation;
};

struct Dynamics {
  std::optional<std::string> size, angle, roundness, opacity, flow;
  std::optional<double> minSize;
};

struct Stroke {
  std::string id;
  std::vector<PaintPoint> points;
  std::string color;
  double size = kNaN, opacity = kNaN, hardness = kNaN;
  std::string mode;
  std::optional<double> cloneOffsetX, cloneOffsetY, start, end, angle, roundness, spacing, flow;
  std::optional<std::string> channels, blend, eraseMode, eraseTargetId, cloneSourceId;
  std::optional<double> cloneTime;
  /// Per-point arrays: present (JS-truthy, even empty) or absent.
  std::optional<std::vector<double>> pressure, tiltX, tiltY;
  std::optional<Dynamics> dynamics;
  std::optional<Xf> transform;
};

std::optional<std::vector<double>> num_array(const Value& v) {
  if (!v.is_array()) return std::nullopt;
  std::vector<double> out;
  out.reserve(v.size());
  for (const auto& e : v.items()) out.push_back(e.is_number() ? e.num() : kNaN);
  return out;
}

Stroke read_stroke(const Value& v) {
  Stroke s;
  s.id = v["id"].str_or("");
  for (const auto& p : v["points"].items()) s.points.push_back({p["x"].num(kNaN), p["y"].num(kNaN)});
  s.color = v["color"].str_or("");
  s.size = v["size"].num(kNaN);
  s.opacity = v["opacity"].num(kNaN);
  s.hardness = v["hardness"].num(kNaN);
  s.mode = v["mode"].str_or("");
  s.cloneOffsetX = opt_num(v["cloneOffsetX"]);
  s.cloneOffsetY = opt_num(v["cloneOffsetY"]);
  s.start = opt_num(v["start"]);
  s.end = opt_num(v["end"]);
  s.angle = opt_num(v["angle"]);
  s.roundness = opt_num(v["roundness"]);
  s.spacing = opt_num(v["spacing"]);
  s.flow = opt_num(v["flow"]);
  s.channels = opt_str(v["channels"]);
  s.blend = opt_str(v["blend"]);
  s.eraseMode = opt_str(v["eraseMode"]);
  s.eraseTargetId = opt_str(v["eraseTargetId"]);
  s.cloneSourceId = opt_str(v["cloneSourceId"]);
  s.cloneTime = opt_num(v["cloneTime"]);
  s.pressure = num_array(v["pressure"]);
  s.tiltX = num_array(v["tiltX"]);
  s.tiltY = num_array(v["tiltY"]);
  if (v["dynamics"].is_object()) {
    const Value& d = v["dynamics"];
    s.dynamics = Dynamics{opt_str(d["size"]), opt_str(d["angle"]), opt_str(d["roundness"]), opt_str(d["opacity"]),
                          opt_str(d["flow"]), opt_num(d["minSize"])};
  }
  if (v["transform"].is_object()) {
    const Value& t = v["transform"];
    s.transform = Xf{opt_num(t["anchorX"]), opt_num(t["anchorY"]), opt_num(t["x"]),
                     opt_num(t["y"]),       opt_num(t["scale"]),   opt_num(t["rotation"])};
  }
  return s;
}

double clamp_js(double v) { return std::max(0.0, std::min(1.0, v)); }  // Math.max(0, Math.min(1, v)) for non-NaN v
double value(const std::optional<double>& v) { return v.value_or(kNaN); }  // `undefined` in arithmetic

// ── paintDabs.ts ─────────────────────────────────────────────────────────────

std::vector<double> arc_lengths(const std::vector<PaintPoint>& points) {
  std::vector<double> s(points.size(), 0.0);
  for (std::size_t i = 1; i < points.size(); ++i) {
    s[i] = s[i - 1] + js_hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return s;
}

struct At {
  double x, y, u;
};

At point_at_length(const std::vector<PaintPoint>& points, const std::vector<double>& s, double d) {
  const std::size_t n = points.size();
  if (n == 1 || d <= 0) return {points[0].x, points[0].y, 0};
  const double total = s[n - 1];
  if (d >= total) return {points[n - 1].x, points[n - 1].y, static_cast<double>(n - 1)};
  std::size_t lo = 0;
  std::size_t hi = n - 1;
  while (hi - lo > 1) {
    const std::size_t mid = (lo + hi) >> 1U;
    if (s[mid] <= d) lo = mid;
    else hi = mid;
  }
  const double seg = s[hi] - s[lo];
  const double f = seg > 0 ? (d - s[lo]) / seg : 0;
  const PaintPoint& a = points[lo];
  const PaintPoint& b = points[hi];
  return {a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, static_cast<double>(lo) + f};
}

double sample_attr(const std::optional<std::vector<double>>& values, double u, double fallback) {
  if (!values || values->empty()) return fallback;
  const double i = std::floor(u);
  const double f = u - i;
  const auto last = static_cast<double>(values->size() - 1);
  const auto at = [&](double k) {
    const double v = (*values)[static_cast<std::size_t>(std::min(last, std::max(0.0, k)))];
    return std::isnan(v) ? fallback : v;  // `?? fallback` (a non-number entry)
  };
  const double a = at(i);
  const double b = at(i + 1);
  return a + (b - a) * f;
}

struct Tip {
  double angle, roundness;
};
Tip tilt_to_tip(double tiltX, double tiltY) {
  const double lean = std::min(90.0, js_hypot(tiltX, tiltY));
  return {lean > 0.5 ? js_atan2(tiltY, tiltX) / kDeg : 0, std::max(0.1, 1 - lean / 90)};
}

double dyn_factor(const std::optional<std::string>& src, double pressure, double tiltRound) {
  if (src == "pressure") return pressure;
  if (src == "tilt") return tiltRound;
  return 1;
}

bool dyn_on(const std::optional<std::string>& v) { return truthy(v) && *v != "off"; }

std::vector<Dab> dabs_of(const Stroke& stroke, double minStep) {
  const auto& pts = stroke.points;
  std::vector<Dab> out;
  if (pts.empty() || stroke.size <= 0) return out;
  const auto s = arc_lengths(pts);
  const double total = s[pts.size() - 1];
  const double start = clamp_js(stroke.start.value_or(0));
  const double end = clamp_js(stroke.end.value_or(1));
  if (end < start || (end == start && pts.size() > 1 && total > 0)) return out;
  const double d0 = start * total;
  const double d1 = end * total;
  const double spacing = stroke.spacing.value_or(0.25);
  const std::optional<Dynamics>& dyn = stroke.dynamics;
  const double minSize = clamp_js(dyn && dyn->minSize ? *dyn->minSize : 0);
  const double baseAngle = stroke.angle.value_or(0);
  const double baseRound = stroke.roundness.value_or(1);
  const double flow = stroke.flow.value_or(1);
  const bool tilted = stroke.tiltX.has_value() || stroke.tiltY.has_value();

  const auto dabAt = [&](double d) {
    const At p = point_at_length(pts, s, d);
    const double pressure = clamp_js(sample_attr(stroke.pressure, p.u, 1));
    const Tip tip = tilted ? tilt_to_tip(sample_attr(stroke.tiltX, p.u, 0), sample_attr(stroke.tiltY, p.u, 0)) : Tip{0, 1};
    const double sizeF = dyn && dyn_on(dyn->size) ? minSize + (1 - minSize) * dyn_factor(dyn->size, pressure, tip.roundness) : 1;
    const double angle = dyn && dyn->angle == "tilt"       ? baseAngle + tip.angle
                         : dyn && dyn->angle == "pressure" ? baseAngle + pressure * 360
                                                           : baseAngle;
    const double roundness =
        dyn && dyn_on(dyn->roundness) ? std::max(0.01, baseRound * dyn_factor(dyn->roundness, pressure, tip.roundness)) : baseRound;
    const std::optional<std::string> none;
    const double alpha = flow * dyn_factor(dyn ? dyn->opacity : none, pressure, tip.roundness) *
                         dyn_factor(dyn ? dyn->flow : none, pressure, tip.roundness);
    out.push_back({p.x, p.y, stroke.size * sizeF, angle, roundness, alpha});
  };

  if (pts.size() == 1 || total == 0) {
    dabAt(0);
    return out;
  }
  const double step = std::max(minStep, spacing * stroke.size);
  double d = d0;
  while (d < d1 && out.size() < kMaxDabs) {
    dabAt(d);
    d += step;
  }
  dabAt(d1);
  return out;
}

bool has_stroke_transform(const std::optional<Xf>& t) {
  return t && (t->anchorX != t->x || t->anchorY != t->y || t->scale != std::optional<double>(100) ||
               t->rotation != std::optional<double>(0));
}

Affine transform_matrix(const Xf& t) {
  const double k = value(t.scale) / 100;
  const double r = value(t.rotation) * kDeg;
  const double cos = js_cos(r) * k;
  const double sin = js_sin(r) * k;
  const double ax = value(t.anchorX);
  const double ay = value(t.anchorY);
  return {cos, sin, -sin, cos, value(t.x) - (cos * ax - sin * ay), value(t.y) - (sin * ax + cos * ay)};
}

bool uses_dabs(const Stroke& s) {
  if (s.spacing) return true;
  if (s.roundness.value_or(1) < 1 || s.flow.value_or(1) < 1) return true;
  const auto& d = s.dynamics;
  const bool dynOn = d && (dyn_on(d->size) || dyn_on(d->angle) || dyn_on(d->roundness) || dyn_on(d->opacity) || dyn_on(d->flow));
  return dynOn && (s.pressure || s.tiltX || s.tiltY);
}

// ── paintRaster.ts ───────────────────────────────────────────────────────────

double blur_sigma(const Stroke& s) { return s.hardness < 1 ? ((1 - s.hardness) * s.size) / 3 : 0; }

/// paintBlurFilter: 'none' or blur(σ·k px) — the canvas filter is in device px.
css::Filter blur_filter(const Stroke& s, double k) {
  const double sigma = blur_sigma(s);
  return sigma > 0 ? css::Filter{sigma * k} : css::Filter{};
}

double device_scale_of(const Canvas2D& ctx) {
  const Mat2D m = ctx.getTransform();
  const double k = std::sqrt(std::abs(m.a * m.d - m.b * m.c));
  return std::isfinite(k) && k > 0 ? k : 1;
}

/// JS `x || fallback` for a number.
double or_else(double x, double fallback) { return x == 0 || std::isnan(x) ? fallback : x; }

void set_color(Canvas2D& c, bool fill, std::string_view css) {
  // An unparseable colour is ignored by the canvas (the previous style stays).
  if (const auto st = color_style(css)) {
    if (fill) c.setFillStyle(*st);
    else c.setStrokeStyle(*st);
  }
}

Affine matrix_of(const Canvas2D& ctx) {
  const Mat2D m = ctx.getTransform();
  return {m.a, m.b, m.c, m.d, m.e, m.f};
}

/// a ∘ b (apply b first).
Affine mul(const Affine& a, const Affine& b) {
  return {a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3],
          a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]};
}

Affine stroke_device_matrix(const Affine& ctxM, const Stroke& s) {
  return has_stroke_transform(s.transform) ? mul(ctxM, transform_matrix(*s.transform)) : ctxM;
}

bool is_direct_stroke(const Stroke& s) {
  if (uses_dabs(s)) return false;
  if (s.start.value_or(0) > 0 || s.end.value_or(1) < 1) return false;
  if (has_stroke_transform(s.transform)) return false;
  if (truthy(s.channels) && *s.channels != "rgba") return false;
  if (truthy(s.blend) && *s.blend != "normal") return false;
  if (s.mode == "clone" && (truthy(s.cloneSourceId) || s.cloneTime)) return false;
  if (s.mode == "erase" && s.eraseMode == "lastStroke") return false;
  return true;
}

/// blendOp: AE Mode → canvas composite operation.
std::string blend_op(const std::optional<std::string>& blend) {
  if (!truthy(blend) || *blend == "normal") return "source-over";
  if (*blend == "add") return "lighter";
  return *blend;
}

double luminance(const std::string& hex) {
  std::string_view h = hex;
  if (!h.empty() && h[0] == '#') h.remove_prefix(1);
  if (h.size() < 6) return 1;
  int n = 0;
  for (std::size_t i = 0; i < 6; ++i) {
    const char c = h[i];
    int v = -1;
    if (c >= '0' && c <= '9') v = c - '0';
    else if (c >= 'a' && c <= 'f') v = c - 'a' + 10;
    else if (c >= 'A' && c <= 'F') v = c - 'A' + 10;
    if (v < 0) return 1;
    n = n * 16 + v;
  }
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

std::string num(double v) { return motion::js::number_to_string(v); }

/// One drawPaint pass: the TS's module-level scratch canvases and tip stamps,
/// scoped to the pass here (a raster may run on any worker thread).
class Pass {
 public:
  explicit Pass(Canvas2D& root) : root_(root) {}

  void draw(const Value& paint);

 private:
  struct Buffer {
    Canvas2D* ctx;
    double x, y, w, h;
  };
  struct Bounds {
    double x, y, w, h;
  };

  Canvas2D* scratch(const std::string& role, double w, double h);
  Canvas2D* stamp(double diameterPx, double hardness, double roundness, double angleDeg);
  void render_strokes(const std::vector<Stroke>& strokes, Canvas2D* source);
  void draw_direct(Canvas2D& ctx, const Stroke& s, double k);
  void draw_clone_stroke(Canvas2D& ctx, const Stroke& s, Canvas2D* source, double k);
  void draw_coverage(Canvas2D& bctx, const Stroke& s, const Affine& M, double bx, double by);
  std::optional<Buffer> stroke_buffer(Canvas2D& target, const Stroke& s, double k, Canvas2D* source,
                                      const std::vector<const Stroke*>* erasers);
  bool fill_clone(Canvas2D& bctx, const Stroke& s, const Affine& m, const Bounds& b, Canvas2D* source);
  void composite(Canvas2D& dest, const Buffer& buf, const Stroke& s);

  Canvas2D& root_;
  std::map<std::string, std::unique_ptr<Canvas2D>> scratch_;
  std::list<std::pair<std::string, std::unique_ptr<Canvas2D>>> stamps_;  // LRU: front = oldest
  std::vector<std::unique_ptr<Canvas2D>> owned_;                          // snapshots, paint layer
};

/// traceStroke: a dab for a single point, else the polyline.
void trace_stroke(Canvas2D& ctx, const std::vector<PaintPoint>& points, double size) {
  ctx.beginPath();
  if (points.size() == 1) {
    const PaintPoint& p = points[0];
    ctx.setFillStyle(ctx.strokeStyle());
    ctx.arc(p.x, p.y, size / 2, 0, kJsPi * 2, false);
    ctx.fill(FillRule::nonzero);
    return;
  }
  ctx.moveTo(points[0].x, points[0].y);
  for (std::size_t i = 1; i < points.size(); ++i) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();
}

std::unique_ptr<Canvas2D> snapshot_of(Canvas2D& ctx) {
  auto snap = ctx.create_canvas(ctx.width(), ctx.height());
  const double w = ctx.width();
  const double h = ctx.height();
  snap->drawImage(ctx, 0, 0, w, h, 0, 0, w, h);
  return snap;
}

void draw_image_at(Canvas2D& dst, const Canvas2D& src, double dx, double dy) {
  const double w = src.width();
  const double h = src.height();
  dst.drawImage(src, 0, 0, w, h, dx, dy, w, h);
}

Canvas2D* Pass::scratch(const std::string& role, double w, double h) {
  auto& c = scratch_[role];
  if (!c || c->width() < w || c->height() < h) {
    const double cw = std::max(w, c ? static_cast<double>(c->width()) : 0.0);
    const double ch = std::max(h, c ? static_cast<double>(c->height()) : 0.0);
    c = root_.create_canvas(static_cast<std::uint32_t>(cw), static_cast<std::uint32_t>(ch));
  }
  Canvas2D& ctx = *c;
  ctx.setTransform({});
  (void)ctx.setGlobalCompositeOperation("source-over");
  ctx.setGlobalAlpha(1);
  ctx.setFilter(css::Filter{});
  ctx.clearRect(0, 0, w, h);
  return &ctx;
}

Canvas2D* Pass::stamp(double diameterPx, double hardness, double roundness, double angleDeg) {
  // dabStampKey: quantised parameters.
  const double d = diameterPx < 8 ? std::max(1.0, js_round(diameterPx * 4) / 4) : js_round(diameterPx);
  const double h = js_round(clamp_js(hardness) * 100) / 100;
  const double r = js_round(std::max(0.01, std::min(1.0, roundness)) * 100) / 100;
  const double a = r >= 1 ? 0 : std::fmod(std::fmod(js_round(angleDeg), 180) + 180, 180);
  const std::string key = num(d) + "|" + num(h) + "|" + num(r) + "|" + num(a);
  for (auto it = stamps_.begin(); it != stamps_.end(); ++it) {
    if (it->first == key) {
      stamps_.splice(stamps_.end(), stamps_, it);  // LRU touch
      return stamps_.back().second.get();
    }
  }
  const double size = std::ceil(d) + 2;
  auto c = root_.create_canvas(static_cast<std::uint32_t>(size), static_cast<std::uint32_t>(size));
  Canvas2D& sc = *c;
  sc.translate(size / 2, size / 2);
  sc.rotate(a * kDeg);
  sc.scale(1, r);
  sc.beginPath();
  sc.arc(0, 0, d / 2, 0, kJsPi * 2, false);
  if (h >= 0.999) {
    set_color(sc, true, "#fff");
  } else {
    // Solid core to Hardness, then a smoothstep falloff to the rim.
    auto g = std::make_shared<Gradient>();
    g->kind = Gradient::Kind::radial;
    g->p = {0, 0, 0, 0, 0, d / 2};
    const auto ramp = [h](double f) { return h + (1 - h) * f; };
    const auto stop = [&g](double offset, std::string_view css) {
      if (const auto col = css::parse_color(css)) g->add_stop(offset, *col);
    };
    stop(0, "rgba(255,255,255,1)");
    stop(ramp(0), "rgba(255,255,255,1)");
    stop(ramp(0.25), "rgba(255,255,255,0.844)");
    stop(ramp(0.5), "rgba(255,255,255,0.5)");
    stop(ramp(0.75), "rgba(255,255,255,0.156)");
    stop(1, "rgba(255,255,255,0)");
    Style st;
    st.kind = Style::Kind::gradient;
    st.gradient = std::move(g);
    sc.setFillStyle(st);
  }
  sc.fill(FillRule::nonzero);
  stamps_.emplace_back(key, std::move(c));
  Canvas2D* out = stamps_.back().second.get();
  if (stamps_.size() > kStampCacheMax) stamps_.pop_front();
  return out;
}

void Pass::draw(const Value& paint) {
  std::vector<Stroke> strokes;
  for (const auto& s : paint["strokes"].items()) strokes.push_back(read_stroke(s));
  const bool onTransparent = paint["onTransparent"].truthy();
  if (strokes.empty() && !onTransparent) return;
  const bool selfClone = std::ranges::any_of(strokes, [](const Stroke& s) { return s.mode == "clone" && !truthy(s.cloneSourceId); });
  Canvas2D* source = nullptr;
  if (selfClone || onTransparent) {
    owned_.push_back(snapshot_of(root_));
    source = owned_.back().get();
  }
  if (onTransparent) {
    // Paint On Transparent: the layer's own pixels leave the picture.
    root_.save();
    root_.setTransform({});
    (void)root_.setGlobalCompositeOperation("source-over");
    root_.clearRect(0, 0, root_.width(), root_.height());
    root_.restore();
  }
  render_strokes(strokes, source);
}

void Pass::render_strokes(const std::vector<Stroke>& strokes, Canvas2D* source) {
  Canvas2D& ctx = root_;
  const double k = device_scale_of(ctx);

  // Last Stroke Only erasers cut their target inside its own buffer.
  std::map<std::string, std::size_t> index;
  for (std::size_t i = 0; i < strokes.size(); ++i) index[strokes[i].id] = i;
  std::map<std::string, std::vector<const Stroke*>> targeted;
  for (std::size_t i = 0; i < strokes.size(); ++i) {
    const Stroke& s = strokes[i];
    if (s.mode != "erase" || s.eraseMode != "lastStroke" || !truthy(s.eraseTargetId)) continue;
    const auto ti = index.find(*s.eraseTargetId);
    if (ti == index.end() || ti->second >= i) continue;
    targeted[*s.eraseTargetId].push_back(&s);
  }

  // Paint Only erasers need the paint kept apart from the layer's source.
  const bool paintOnly = std::ranges::any_of(strokes, [](const Stroke& s) { return s.mode == "erase" && s.eraseMode == "paintOnly"; });
  Canvas2D* pctx = &ctx;
  Canvas2D* paintCanvas = nullptr;
  if (paintOnly) {
    owned_.push_back(ctx.create_canvas(ctx.width(), ctx.height()));
    paintCanvas = owned_.back().get();
    pctx = paintCanvas;
    pctx->setTransform(ctx.getTransform());
  }

  ctx.save();
  for (const Stroke& s : strokes) {
    if (s.points.empty() || s.size <= 0 || s.opacity <= 0) continue;
    if (s.mode == "erase" && s.eraseMode == "lastStroke") continue;
    const auto er = targeted.find(s.id);
    const std::vector<const Stroke*>* erasers = er != targeted.end() ? &er->second : nullptr;
    // Channel-restricted paint edits the layer's own channels, not the paint layer.
    Canvas2D& dest = s.mode == "erase" ? (s.eraseMode == "paintOnly" ? *pctx : ctx)
                     : truthy(s.channels) && *s.channels != "rgba" ? ctx
                                                                    : *pctx;
    const bool both = s.mode == "erase" && s.eraseMode != "paintOnly" && pctx != &ctx;

    if (is_direct_stroke(s) && erasers == nullptr) {
      if (s.mode == "clone") {
        draw_clone_stroke(dest, s, source, k);
        continue;
      }
      draw_direct(dest, s, k);
      if (both) draw_direct(*pctx, s, k);
      continue;
    }
    const auto buf = stroke_buffer(ctx, s, k, source, erasers);
    if (!buf) continue;
    composite(dest, *buf, s);
    if (both) composite(*pctx, *buf, s);
  }
  ctx.setFilter(css::Filter{});
  ctx.restore();

  if (paintCanvas != nullptr) {
    ctx.save();
    ctx.setTransform({});
    (void)ctx.setGlobalCompositeOperation("source-over");
    ctx.setGlobalAlpha(1);
    ctx.setFilter(css::Filter{});
    draw_image_at(ctx, *paintCanvas, 0, 0);
    ctx.restore();
  }
}

void Pass::draw_direct(Canvas2D& ctx, const Stroke& s, double k) {
  (void)ctx.setGlobalCompositeOperation(s.mode == "erase" ? "destination-out" : "source-over");
  ctx.setGlobalAlpha(clamp_js(s.opacity));
  set_color(ctx, false, s.mode == "erase" ? "#000" : s.color);
  ctx.setLineWidth(s.size);
  ctx.setLineCap(LineCap::round);
  ctx.setLineJoin(LineJoin::round);
  ctx.setFilter(blur_filter(s, k));
  trace_stroke(ctx, s.points, s.size);
}

void Pass::draw_clone_stroke(Canvas2D& ctx, const Stroke& s, Canvas2D* source, double k) {
  if (source == nullptr) return;
  const Mat2D m = ctx.getTransform();
  const double ox = s.cloneOffsetX.value_or(0);
  const double oy = s.cloneOffsetY.value_or(0);
  const double devX = m.a * ox + m.c * oy;
  const double devY = m.b * ox + m.d * oy;
  const std::uint32_t w = ctx.width();
  const std::uint32_t h = ctx.height();

  // Stroke-shaped alpha mask, drawn under the SAME transform.
  const auto mask = ctx.create_canvas(w, h);
  Canvas2D& mc = *mask;
  mc.setTransform(m);
  set_color(mc, false, "#fff");
  mc.setLineWidth(s.size);
  mc.setLineCap(LineCap::round);
  mc.setLineJoin(LineJoin::round);
  mc.setFilter(blur_filter(s, k));
  trace_stroke(mc, s.points, s.size);

  // Shifted content, clipped to the mask.
  const auto fill = ctx.create_canvas(w, h);
  Canvas2D& fc = *fill;
  draw_image_at(fc, *source, -devX, -devY);
  (void)fc.setGlobalCompositeOperation("destination-in");
  draw_image_at(fc, mc, 0, 0);

  ctx.save();
  ctx.setTransform({});
  (void)ctx.setGlobalCompositeOperation("source-over");
  ctx.setGlobalAlpha(clamp_js(s.opacity));
  ctx.setFilter(css::Filter{});
  draw_image_at(ctx, fc, 0, 0);
  ctx.restore();
}

void Pass::draw_coverage(Canvas2D& bctx, const Stroke& s, const Affine& M, double bx, double by) {
  const double kk = or_else(std::sqrt(std::abs(M[0] * M[3] - M[1] * M[2])), 1);
  if (uses_dabs(s)) {
    const double rot = js_atan2(M[1], M[0]) / kDeg;
    // A local step of half a device pixel at most — finer adds nothing.
    for (const Dab& d : dabs_of(s, 0.5 / kk)) {
      const double px = d.size * kk;
      if (px <= 0 || d.alpha <= 0) continue;
      Canvas2D* st = stamp(px, s.hardness, d.roundness, d.angle + rot);
      // A tip under a device pixel lays down its AREA's worth, not a whole pixel.
      bctx.setGlobalAlpha(clamp_js(d.alpha * (px < 1 ? px * px : 1)));
      const double x = M[0] * d.x + M[2] * d.y + M[4] - bx;
      const double y = M[1] * d.x + M[3] * d.y + M[5] - by;
      draw_image_at(bctx, *st, x - st->width() / 2.0, y - st->height() / 2.0);
    }
    bctx.setGlobalAlpha(1);
    return;
  }
  const auto pts = trim_polyline(s.points, s.start.value_or(0), s.end.value_or(1));
  if (!pts) return;
  bctx.save();
  bctx.setTransform({M[0], M[1], M[2], M[3], M[4] - bx, M[5] - by});
  set_color(bctx, false, "#fff");
  bctx.setLineWidth(s.size);
  bctx.setLineCap(LineCap::round);
  bctx.setLineJoin(LineJoin::round);
  bctx.setFilter(blur_filter(s, kk));
  trace_stroke(bctx, *pts, s.size);
  bctx.restore();
}

std::optional<Pass::Buffer> Pass::stroke_buffer(Canvas2D& target, const Stroke& s, double k, Canvas2D* source,
                                                const std::vector<const Stroke*>* erasers) {
  const Affine m = matrix_of(target);
  const Affine M = stroke_device_matrix(m, s);
  const double kk = or_else(std::sqrt(std::abs(M[0] * M[3] - M[1] * M[2])), k);
  // deviceBounds: the stroke's coverage, clipped to the canvas.
  double minX = std::numeric_limits<double>::infinity();
  double minY = minX;
  double maxX = -minX;
  double maxY = -minX;
  for (const PaintPoint& p : s.points) {
    const double x = M[0] * p.x + M[2] * p.y + M[4];
    const double y = M[1] * p.x + M[3] * p.y + M[5];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const double reach = (s.size / 2 + 3 * blur_sigma(s)) * kk + 2;
  const double x0 = std::max(0.0, std::floor(minX - reach));
  const double y0 = std::max(0.0, std::floor(minY - reach));
  const double x1 = std::min(static_cast<double>(target.width()), std::ceil(maxX + reach));
  const double y1 = std::min(static_cast<double>(target.height()), std::ceil(maxY + reach));
  if (!(x1 > x0 && y1 > y0)) return std::nullopt;
  const Bounds b{x0, y0, x1 - x0, y1 - y0};

  Canvas2D* bctx = scratch("stroke", b.w, b.h);
  draw_coverage(*bctx, s, M, b.x, b.y);

  if (erasers != nullptr) {
    for (const Stroke* e : *erasers) {
      Canvas2D* ectx = scratch("eraser", b.w, b.h);
      draw_coverage(*ectx, *e, stroke_device_matrix(m, *e), b.x, b.y);
      (void)bctx->setGlobalCompositeOperation("destination-out");
      bctx->setGlobalAlpha(clamp_js(e->opacity));
      bctx->drawImage(*ectx, 0, 0, b.w, b.h, 0, 0, b.w, b.h);
      bctx->setGlobalAlpha(1);
    }
  }

  if (s.mode != "erase") {
    (void)bctx->setGlobalCompositeOperation("source-in");
    if (s.mode == "paint") {
      set_color(*bctx, true, s.color);
      bctx->fillRect(0, 0, b.w, b.h);
    } else if (!fill_clone(*bctx, s, m, b, source)) {
      return std::nullopt;
    }
    (void)bctx->setGlobalCompositeOperation("source-over");
  }
  return Buffer{bctx, b.x, b.y, b.w, b.h};
}

bool Pass::fill_clone(Canvas2D& bctx, const Stroke& s, const Affine& m, const Bounds& b, Canvas2D* source) {
  // No host clone source in a raster (PaintEnv absent): another layer draws
  // nothing, this layer at another time samples its current pixels.
  if (truthy(s.cloneSourceId) || source == nullptr) return false;
  const double ox = s.cloneOffsetX.value_or(0);
  const double oy = s.cloneOffsetY.value_or(0);
  const double devX = m[0] * ox + m[2] * oy;
  const double devY = m[1] * ox + m[3] * oy;
  draw_image_at(bctx, *source, -(b.x + devX), -(b.y + devY));
  return true;
}

void Pass::composite(Canvas2D& dest, const Buffer& buf, const Stroke& s) {
  const double opacity = clamp_js(s.opacity);
  dest.save();
  dest.setTransform({});
  dest.setFilter(css::Filter{});
  const auto draw = [&] { dest.drawImage(*buf.ctx, 0, 0, buf.w, buf.h, buf.x, buf.y, buf.w, buf.h); };
  if (s.mode == "erase") {
    (void)dest.setGlobalCompositeOperation("destination-out");
    dest.setGlobalAlpha(opacity);
    draw();
  } else if (s.channels == "alpha") {
    // Alpha only: the brush's luminance is the alpha it paints toward.
    const double cut = opacity * (1 - (s.mode == "clone" ? 1 : luminance(s.color)));
    if (cut > 0) {
      (void)dest.setGlobalCompositeOperation("destination-out");
      dest.setGlobalAlpha(cut);
      draw();
    }
  } else if (s.channels == "rgb") {
    // Colour only, the layer's alpha untouched.
    const std::string op = blend_op(s.blend);
    if (op == "source-over") {
      (void)dest.setGlobalCompositeOperation("source-atop");
      dest.setGlobalAlpha(opacity);
      draw();
    } else {
      Canvas2D* tctx = scratch("tmp", buf.w, buf.h);
      tctx->drawImage(dest, buf.x, buf.y, buf.w, buf.h, 0, 0, buf.w, buf.h);
      (void)tctx->setGlobalCompositeOperation(op);
      tctx->setGlobalAlpha(opacity);
      tctx->drawImage(*buf.ctx, 0, 0, buf.w, buf.h, 0, 0, buf.w, buf.h);
      (void)dest.setGlobalCompositeOperation("source-atop");
      dest.setGlobalAlpha(1);
      dest.drawImage(*tctx, 0, 0, buf.w, buf.h, buf.x, buf.y, buf.w, buf.h);
    }
  } else {
    (void)dest.setGlobalCompositeOperation(blend_op(s.blend));
    dest.setGlobalAlpha(opacity);
    draw();
  }
  dest.restore();
}

}  // namespace

bool has_paint_strokes(const json::Value& paint) {
  return paint.is_object() && paint["strokes"].is_array() && (paint["strokes"].size() > 0 || (paint["onTransparent"].is_bool() && paint["onTransparent"].truthy()));
}

void draw_paint(Canvas2D& ctx, const json::Value& paint) {
  if (!paint.is_object()) return;
  Pass pass(ctx);
  pass.draw(paint);
}

std::vector<Dab> stroke_dabs(const json::Value& stroke, double minStep) { return dabs_of(read_stroke(stroke), minStep); }

std::optional<std::vector<PaintPoint>> trim_polyline(const std::vector<PaintPoint>& points, double start, double end) {
  if (points.empty()) return std::nullopt;
  const double a = clamp_js(start);
  const double b = clamp_js(end);
  if (b < a || (b == a && points.size() > 1)) return std::nullopt;
  if (a <= 0 && b >= 1) return points;
  if (points.size() == 1) return points;
  const auto s = arc_lengths(points);
  const double total = s[points.size() - 1];
  const double da = a * total;
  const double db = b * total;
  std::vector<PaintPoint> out;
  const At pa = point_at_length(points, s, da);
  out.push_back({pa.x, pa.y});
  for (std::size_t i = 1; i + 1 < points.size(); ++i) {
    if (s[i] > da && s[i] < db) out.push_back(points[i]);
  }
  const At pb = point_at_length(points, s, db);
  out.push_back({pb.x, pb.y});
  return out;
}

Affine stroke_transform_matrix(const json::Value& t) {
  return transform_matrix(Xf{opt_num(t["anchorX"]), opt_num(t["anchorY"]), opt_num(t["x"]), opt_num(t["y"]), opt_num(t["scale"]),
                             opt_num(t["rotation"])});
}

double paint_reach(const json::Value& paint) {
  if (!has_paint_strokes(paint)) return 0;
  double reach = 0;
  for (const auto& v : paint["strokes"].items()) {
    const Stroke s = read_stroke(v);
    double r = s.size / 2 + 3 * blur_sigma(s);
    if (has_stroke_transform(s.transform)) {
      r *= std::abs(value(s.transform->scale)) / 100;
      // transformShift: max distance the transform moves a corner of the stroke's bounds.
      double shift = 0;
      if (!s.points.empty()) {
        double minX = std::numeric_limits<double>::infinity();
        double minY = minX;
        double maxX = -minX;
        double maxY = -minX;
        for (const auto& p : s.points) {
          minX = std::min(minX, p.x);
          minY = std::min(minY, p.y);
          maxX = std::max(maxX, p.x);
          maxY = std::max(maxY, p.y);
        }
        const Affine m = transform_matrix(*s.transform);
        for (const auto& [x, y] : std::array<std::pair<double, double>, 4>{{{minX, minY}, {maxX, minY}, {minX, maxY}, {maxX, maxY}}}) {
          shift = std::max(shift, js_hypot(m[0] * x + m[2] * y + m[4] - x, m[1] * x + m[3] * y + m[5] - y));
        }
      }
      r += shift;
    }
    if (r > reach) reach = r;
  }
  return reach;
}

}  // namespace premation::raster
