#include "scene_build.hpp"

#include <algorithm>
#include <cmath>
#include <numbers>

#include "fxstate.hpp"
#include "readmodel.hpp"
#include "scene.hpp"
#include "time_conv.hpp"

namespace premation::doc {
namespace {

float to_float(double v) { return static_cast<float>(v); }

double sampled(const PCtx& c, const Node& n, std::string_view prop, double t, double fallback) {
  if (anim_is_animated(c.d, n.id, prop) || anim_has_expr(c.d, n.id, prop)) {
    if (auto v = anim_sample(c.d, c.expr, c.cache, n.id, prop, t)) return *v;
  }
  if (const Component* comp = n.comp_with_number(prop)) return comp->props.at(prop).num();
  return fallback;
}

/// The layer's fill colour: Style.fill, else fx.fill.color (hex), else a neutral grey.
std::array<double, 4> fill_of(const Node& n) {
  if (const Component* s = n.comp("Style")) {
    const Json& f = s->props.at("fill");
    if (f.is_string() && is_hex_color(f.str())) return parse_color_channels(f.str());
  }
  const Json& fill = n.fx().at("fill");
  if (fill.is_object() && fill.at("color").is_string() && is_hex_color(fill.at("color").str())) {
    return parse_color_channels(fill.at("color").str());
  }
  return {0.5, 0.5, 0.5, 1.0};
}

}  // namespace

void build_frame_scene(const PCtx& c, std::string_view comp, api::Time t, FrameScene& out) {
  const Document& d = c.d;
  const api::CompSettings s = comp_settings(d, comp);
  out.compWidth = s.width;
  out.compHeight = s.height;
  out.background = {to_float(s.background.r), to_float(s.background.g), to_float(s.background.b),
                    s.transparent ? 0.0F : 1.0F};
  out.quads.clear();
  const double fps = comp_fps(d, comp);
  const double frame = std::floor(flicks_to_seconds(t) * fps + 1e-9);
  const std::vector<std::string> stack = layer_ids_of_comp(d, comp);  // front first
  for (auto it = stack.rbegin(); it != stack.rend(); ++it) {
    const Node* n = d.node(*it);
    if (n == nullptr || !n->visible) continue;
    const std::string kind = n->kind();
    if (kind != "shape") continue;  // solids and rectangles (the C2 compositor draws quads)
    const auto bars = bars_of(d, n->id, comp);
    bool active = bars.empty();
    for (const Bar* b : bars) {
      if (b->active_at(frame)) active = true;
    }
    if (!active) continue;
    const double kt = comp_to_keyframe_time(d, c.view, n->id, flicks_to_seconds(t));
    const double w = sampled(c, *n, "width", kt, 0);
    const double h = sampled(c, *n, "height", kt, 0);
    const double opacity = sampled(c, *n, "opacity", kt, 100);
    const auto col = fill_of(*n);
    const double alpha = std::clamp(opacity / 100.0, 0.0, 1.0) * std::clamp(col[3], 0.0, 1.0);
    if (alpha <= 0.0 || w <= 0.0 || h <= 0.0) continue;
    const double x = sampled(c, *n, "x", kt, view_transform(*n).x);
    const double y = sampled(c, *n, "y", kt, view_transform(*n).y);
    const double rot = sampled(c, *n, "rotation", kt, 0);
    const double sx = sampled(c, *n, "scaleX", kt, 1);
    const double sy = sampled(c, *n, "scaleY", kt, 1);
    const double ax = sampled(c, *n, "anchorX", kt, 0);
    const double ay = sampled(c, *n, "anchorY", kt, 0);
    const double rad = rot * std::numbers::pi / 180.0;
    const double cs = std::cos(rad);
    const double sn = std::sin(rad);
    // M = T(pos) · R · S · T(−anchor), layer space centre-origin.
    const double a = cs * sx;
    const double b = sn * sx;
    const double cc = -sn * sy;
    const double dd = cs * sy;
    const double e = x - (a * ax + cc * ay);
    const double f = y - (b * ax + dd * ay);
    DrawQuad q;
    const double qa = a * w;
    const double qb = b * w;
    const double qc = cc * h;
    const double qd = dd * h;
    q.affine = {to_float(qa), to_float(qb), to_float(qc), to_float(qd), to_float(e - 0.5 * (qa + qc)),
                to_float(f - 0.5 * (qb + qd))};
    q.color = {to_float(std::clamp(col[0], 0.0, 1.0)), to_float(std::clamp(col[1], 0.0, 1.0)),
               to_float(std::clamp(col[2], 0.0, 1.0)), to_float(alpha)};
    out.quads.push_back(q);
  }
}

}  // namespace premation::doc
