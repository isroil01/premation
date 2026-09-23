#include "evaluate.hpp"

#include <algorithm>
#include <cmath>
#include <numbers>

namespace premation::eval {
namespace {

double seconds(api::Time t) { return static_cast<double>(t) / static_cast<double>(doc::kFlicksPerSecond); }

std::uint32_t spatial_bits(api::SpatialInterp s) {
  // api::SpatialInterp and motion_spatial share numbering (legacy == unset).
  return (static_cast<std::uint32_t>(s) << MOTION_KF_SPATIAL_SHIFT) & MOTION_KF_SPATIAL_MASK;
}

const doc::Property* prop_of(const doc::Layer& layer, std::string_view path) {
  const auto it = layer.props.find(path);
  return it == layer.props.end() ? nullptr : &it->second;
}

float to_float(double v) { return static_cast<float>(v); }

}  // namespace

std::int32_t to_motion_easing(api::Easing e) noexcept {
  switch (e) {
    case api::Easing::linear: return MOTION_EASING_LINEAR;
    case api::Easing::hold: return MOTION_EASING_HOLD;
    case api::Easing::bezier: return MOTION_EASING_BEZIER;
    case api::Easing::ease: return MOTION_EASING_EASE;
    case api::Easing::ease_in: return MOTION_EASING_EASE_IN;
    case api::Easing::ease_out: return MOTION_EASING_EASE_OUT;
    case api::Easing::ease_in_out: return MOTION_EASING_EASE_IN_OUT;
    case api::Easing::step: return MOTION_EASING_STEP;
    case api::Easing::auto_bezier: return MOTION_EASING_AUTO_BEZIER;
    case api::Easing::continuous_bezier: return MOTION_EASING_CONTINUOUS_BEZIER;
  }
  return MOTION_EASING_LINEAR;
}

std::size_t components_at(const doc::Property& prop, api::Time t, Scratch& scratch, std::span<double, 4> out) {
  if (prop.keys.empty()) return doc::components(prop.value, out);
  std::array<double, 4> first{};
  const std::size_t n = doc::components(prop.keys.front().value, first);
  if (n == 0) return 0;
  // `track` is reused across calls: after warm-up (the largest key count seen)
  // this path does not allocate, which keeps the per-frame scene build
  // allocation-free on the core thread (CLAUDE.md performance discipline).
  scratch.track.resize(prop.keys.size());
  const double ts = seconds(t);
  for (std::size_t c = 0; c < n; ++c) {
    for (std::size_t i = 0; i < prop.keys.size(); ++i) {
      const api::Keyframe& k = prop.keys[i];
      std::array<double, 4> v{};
      (void)doc::components(k.value, v);
      motion_keyframe& m = scratch.track[i];
      m = motion_keyframe{};
      m.t = seconds(k.time);
      m.value = v[c];
      m.easing = to_motion_easing(k.easing);
      m.flags = spatial_bits(k.spatial_interp);
      if (k.bezier) {
        m.flags |= MOTION_KF_HAS_BEZIER;
        m.c0 = k.bezier->x1;
        m.c1 = k.bezier->y1;
        m.c2 = k.bezier->x2;
        m.c3 = k.bezier->y2;
      }
      if (c < k.spatial_in.size()) {
        m.flags |= MOTION_KF_HAS_SI;
        m.si = k.spatial_in[c];
      }
      if (c < k.spatial_out.size()) {
        m.flags |= MOTION_KF_HAS_SO;
        m.so = k.spatial_out[c];
      }
    }
    double sample = 0;
    if (motion_eval_sample_scalar(scratch.track.data(), scratch.track.size(), ts, &sample, nullptr) != MOTION_OK) {
      // Only reachable with a NaN the command layer refused to store; never
      // blank the frame over it — hold the first key's value.
      sample = first[c];
    }
    out[c] = sample;
  }
  return n;
}

api::Value value_at(const doc::Property& prop, api::Time t, Scratch& scratch) {
  if (prop.keys.empty()) return prop.value;
  std::array<double, 4> c{};
  const std::size_t n = components_at(prop, t, scratch, c);
  if (n == 0) return prop.keys.front().value;  // non-numeric: hold (none in C2's catalog)
  return doc::from_components(prop.type, std::span<const double>(c.data(), n));
}

std::array<double, 6> layer_matrix(const doc::Layer& layer, api::Time t, Scratch& scratch) {
  std::array<double, 4> anchor{};
  std::array<double, 4> position{};
  std::array<double, 4> scale{100.0, 100.0, 0.0, 0.0};
  std::array<double, 4> rotation{};
  if (const auto* p = prop_of(layer, "transform/anchorPoint")) (void)components_at(*p, t, scratch, anchor);
  if (const auto* p = prop_of(layer, "transform/position")) (void)components_at(*p, t, scratch, position);
  if (const auto* p = prop_of(layer, "transform/scale")) (void)components_at(*p, t, scratch, scale);
  if (const auto* p = prop_of(layer, "transform/rotation")) (void)components_at(*p, t, scratch, rotation);
  const double rad = rotation[0] * std::numbers::pi / 180.0;
  const double cs = std::cos(rad);
  const double sn = std::sin(rad);
  const double sx = scale[0] / 100.0;
  const double sy = scale[1] / 100.0;
  // M = T(pos) · R · S · T(−anchor); y is down, positive rotation is clockwise
  // on screen (AE).
  const double a = cs * sx;
  const double b = sn * sx;
  const double c = -sn * sy;
  const double d = cs * sy;
  const double e = position[0] - (a * anchor[0] + c * anchor[1]);
  const double f = position[1] - (b * anchor[0] + d * anchor[1]);
  return {a, b, c, d, e, f};
}

void build_scene(const doc::Document& document, const doc::Comp& comp, api::Time t, Scratch& scratch,
                 FrameScene& out) {
  out.compWidth = comp.settings.width;
  out.compHeight = comp.settings.height;
  const api::Color& bg = comp.settings.background;
  out.background = {to_float(bg.r), to_float(bg.g), to_float(bg.b), comp.settings.transparent ? 0.0F : 1.0F};
  out.quads.clear();
  // Stack order is top first; draw back to front.
  for (auto it = comp.layers.rbegin(); it != comp.layers.rend(); ++it) {
    const doc::Layer* layer = document.layer(*it);
    if (layer == nullptr || !doc::kind_renders(layer->kind) || !layer->switches.visible) continue;
    if (t < layer->timing.in_point || t >= layer->timing.out_point) continue;
    std::array<double, 4> opacity{100.0, 0, 0, 0};
    std::array<double, 4> color{0.5, 0.5, 0.5, 1.0};
    std::array<double, 4> size{0, 0, 0, 0};
    if (const auto* p = prop_of(*layer, "transform/opacity")) (void)components_at(*p, t, scratch, opacity);
    if (const auto* p = prop_of(*layer, "layer/color")) (void)components_at(*p, t, scratch, color);
    if (const auto* p = prop_of(*layer, "layer/size")) (void)components_at(*p, t, scratch, size);
    const double alpha = std::clamp(opacity[0] / 100.0, 0.0, 1.0) * std::clamp(color[3], 0.0, 1.0);
    if (alpha <= 0.0 || size[0] <= 0.0 || size[1] <= 0.0) continue;
    const auto m = layer_matrix(*layer, t, scratch);
    // Unit square → layer pixels (centre-origin: u ↦ (u − ½)·size) → comp pixels.
    DrawQuad q;
    const double ax = m[0] * size[0];
    const double bx = m[1] * size[0];
    const double cy = m[2] * size[1];
    const double dy = m[3] * size[1];
    q.affine = {to_float(ax), to_float(bx), to_float(cy), to_float(dy), to_float(m[4] - 0.5 * (ax + cy)),
                to_float(m[5] - 0.5 * (bx + dy))};
    q.color = {to_float(std::clamp(color[0], 0.0, 1.0)), to_float(std::clamp(color[1], 0.0, 1.0)),
               to_float(std::clamp(color[2], 0.0, 1.0)), to_float(alpha)};
    out.quads.push_back(q);
  }
}

}  // namespace premation::eval
