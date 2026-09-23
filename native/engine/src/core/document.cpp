#include "document.hpp"

#include <array>
#include <cmath>
#include <utility>

namespace premation::doc {
namespace {

using VT = api::ValueType;

// After Effects units (ENGINE_API.md §3.5): pixels, percent (scale, opacity),
// degrees. The TypeScript engine stores scale as a multiplier and converts at
// its seam (src/core/engine/props.ts apiUnitFactor); opacity and rotation are
// stored in these units by both. Layer space is centre-origin in both engines:
// anchorPoint (0,0) is the middle of the layer's box (AE measures from the
// top-left; the UI may show that by adding size/2).
constexpr std::array<PropertySpec, 7> kFilled = {{
    {"transform/anchorPoint", "Anchor Point", "ADBE Anchor Point", "px", VT::vec2, true, 2, {}, {}},
    {"transform/position", "Position", "ADBE Position", "px", VT::vec2, true, 2, {}, {}},
    {"transform/scale", "Scale", "ADBE Scale", "%", VT::vec2, true, 2, {}, {}},
    {"transform/rotation", "Rotation", "ADBE Rotate Z", "deg", VT::scalar, true, 1, {}, {}},
    {"transform/opacity", "Opacity", "ADBE Opacity", "%", VT::scalar, true, 1, 0.0, 100.0},
    {"layer/color", "Color", "ADBE Solid Color", "", VT::color, true, 4, {}, {}},
    {"layer/size", "Size", "ADBE Solid Size", "px", VT::vec2, false, 2, 1.0, 30000.0},
}};

constexpr std::array<PropertySpec, 5> kTransformOnly = {{
    kFilled[0], kFilled[1], kFilled[2], kFilled[3], kFilled[4],
}};

std::array<double, 2> default_size(api::LayerKind kind, const Comp& comp) {
  const double w = static_cast<double>(comp.settings.width);
  const double h = static_cast<double>(comp.settings.height);
  switch (kind) {
    case api::LayerKind::solid: return {w, h};
    case api::LayerKind::shape:
    case api::LayerKind::rectangle: return {std::round(w / 4.0), std::round(h / 4.0)};
    default: return {100.0, 100.0};
  }
}

}  // namespace

std::span<const PropertySpec> catalog_for(api::LayerKind kind) noexcept {
  switch (kind) {
    case api::LayerKind::solid:
    case api::LayerKind::shape:
    case api::LayerKind::rectangle: return kFilled;
    case api::LayerKind::null: return kTransformOnly;
    default: return {};
  }
}

const PropertySpec* find_spec(api::LayerKind kind, std::string_view path) noexcept {
  for (const PropertySpec& s : catalog_for(kind)) {
    if (s.path == path) return &s;
  }
  return nullptr;
}

bool kind_supported(api::LayerKind kind) noexcept { return !catalog_for(kind).empty(); }

bool kind_renders(api::LayerKind kind) noexcept {
  return kind == api::LayerKind::solid || kind == api::LayerKind::shape || kind == api::LayerKind::rectangle;
}

Comp* Document::comp(std::string_view id) {
  const auto it = comps.find(id);
  return it == comps.end() ? nullptr : &it->second;
}
const Comp* Document::comp(std::string_view id) const {
  const auto it = comps.find(id);
  return it == comps.end() ? nullptr : &it->second;
}
Layer* Document::layer(std::string_view id) {
  const auto it = layers.find(id);
  return it == layers.end() ? nullptr : &it->second;
}
const Layer* Document::layer(std::string_view id) const {
  const auto it = layers.find(id);
  return it == layers.end() ? nullptr : &it->second;
}

api::ValueType value_type_of(const api::Value& v) noexcept {
  // The generated union's alternatives are declared in ValueType order.
  return static_cast<api::ValueType>(v.v.index());
}

api::Value make_scalar(double x) {
  api::Value v;
  v.v.emplace<3>(x);
  return v;
}

api::Value make_vec2(double x, double y) {
  api::Value v;
  v.v.emplace<4>(api::Vec2{x, y});
  return v;
}

api::Value make_color(double r, double g, double b, double a) {
  api::Value v;
  v.v.emplace<7>(api::Color{r, g, b, a});
  return v;
}

std::size_t components(const api::Value& v, std::span<double, 4> out) noexcept {
  switch (v.v.index()) {
    case 3: out[0] = std::get<3>(v.v); return 1;
    case 4: {
      const auto& p = std::get<4>(v.v);
      out[0] = p.x;
      out[1] = p.y;
      return 2;
    }
    case 5: {
      const auto& p = std::get<5>(v.v);
      out[0] = p.x;
      out[1] = p.y;
      out[2] = p.z;
      return 3;
    }
    case 6: {
      const auto& p = std::get<6>(v.v);
      out[0] = p.x;
      out[1] = p.y;
      out[2] = p.z;
      out[3] = p.w;
      return 4;
    }
    case 7: {
      const auto& p = std::get<7>(v.v);
      out[0] = p.r;
      out[1] = p.g;
      out[2] = p.b;
      out[3] = p.a;
      return 4;
    }
    default: return 0;
  }
}

api::Value from_components(api::ValueType type, std::span<const double> c) {
  const auto at = [&c](std::size_t i) { return i < c.size() ? c[i] : 0.0; };
  api::Value v;
  switch (type) {
    case VT::scalar: v.v.emplace<3>(at(0)); break;
    case VT::vec2: v.v.emplace<4>(api::Vec2{at(0), at(1)}); break;
    case VT::vec3: v.v.emplace<5>(api::Vec3{at(0), at(1), at(2)}); break;
    case VT::vec4: v.v.emplace<6>(api::Vec4{at(0), at(1), at(2), at(3)}); break;
    case VT::color: v.v.emplace<7>(api::Color{at(0), at(1), at(2), at(3)}); break;
    default: break;
  }
  return v;
}

bool all_finite(const api::Value& v) noexcept {
  std::array<double, 4> c{};
  const std::size_t n = components(v, c);
  for (std::size_t i = 0; i < n; ++i) {
    if (!std::isfinite(c[i])) return false;
  }
  return true;
}

double fps_of(const api::Rational& r) noexcept {
  if (r.num == 0 || r.den == 0) return 0.0;
  return static_cast<double>(r.num) / static_cast<double>(r.den);
}

api::Time frame_duration(const api::Rational& r) noexcept {
  if (r.num == 0 || r.den == 0) return 0;
  return (kFlicksPerSecond * static_cast<api::Time>(r.den)) / static_cast<api::Time>(r.num);
}

api::CompSettings default_comp_settings() {
  api::CompSettings s;
  s.name = "Comp 1";
  s.width = 1920;
  s.height = 1080;
  s.pixel_aspect = 1.0;
  s.frame_rate = api::Rational{30, 1};
  s.duration = 10 * kFlicksPerSecond;
  s.background = api::Color{0.0, 0.0, 0.0, 1.0};
  s.work_area = api::TimeRange{0, s.duration};
  s.motion_blur = api::MotionBlurSettings{180.0, -90.0, 16, 128};
  return s;
}

api::Value default_value(const PropertySpec& spec, const Comp& comp) {
  // Only called with specs of the layer's own kind; the size is looked up by
  // the caller for the anchor (see make_layer).
  const std::string_view p = spec.path;
  if (p == "transform/position") {
    return make_vec2(static_cast<double>(comp.settings.width) / 2.0, static_cast<double>(comp.settings.height) / 2.0);
  }
  if (p == "transform/scale") return make_vec2(100.0, 100.0);
  if (p == "transform/rotation") return make_scalar(0.0);
  if (p == "transform/opacity") return make_scalar(100.0);
  if (p == "layer/color") return make_color(0.5, 0.5, 0.5, 1.0);
  return from_components(spec.type, {});
}

Layer make_layer(api::LayerKind kind, const Comp& comp, std::string id, std::string name) {
  Layer l;
  l.id = std::move(id);
  l.comp = comp.id;
  l.kind = kind;
  l.name = std::move(name);
  l.timing.in_point = 0;
  l.timing.out_point = comp.settings.duration;
  l.timing.start_time = 0;
  l.timing.stretch = 1.0;
  l.switches.visible = true;
  l.switches.effects_enabled = true;
  l.switches.audio_enabled = false;
  const auto size = default_size(kind, comp);
  for (const PropertySpec& spec : catalog_for(kind)) {
    Property prop;
    prop.type = spec.type;
    if (spec.path == "transform/anchorPoint") {
      // Layer space is CENTRE-origin (ENGINE_API.md §3.5): (0,0) is the middle
      // of the layer's box, so the default anchor is the centre for every kind
      // and stays there whatever `layer/size` becomes.
      prop.value = make_vec2(0.0, 0.0);
    } else if (spec.path == "layer/size") {
      prop.value = make_vec2(size[0], size[1]);
    } else if (spec.path == "layer/color" && kind != api::LayerKind::solid) {
      prop.value = make_color(0.2, 0.6, 1.0, 1.0);
    } else {
      prop.value = default_value(spec, comp);
    }
    l.props.emplace(std::string(spec.path), std::move(prop));
  }
  return l;
}

api::LayerInfo layer_info(const Layer& layer) {
  api::LayerInfo info;
  info.id = layer.id;
  info.comp = layer.comp;
  info.kind = layer.kind;
  info.name = layer.name;
  info.switches = layer.switches;
  info.timing = layer.timing;
  info.has_video = kind_renders(layer.kind);
  return info;
}

api::ItemInfo comp_item_info(const Comp& comp) {
  api::ItemInfo info;
  info.id = comp.id;
  info.kind = api::ItemKind::composition;
  info.name = comp.settings.name;
  return info;
}

api::CompInfo comp_info(const Comp& comp) {
  api::CompInfo info;
  info.id = comp.id;
  info.settings = comp.settings;
  info.layers = comp.layers;
  return info;
}

api::PropertyInfo property_info(const Layer& layer, const std::string& path, const Property& prop, api::Value value) {
  api::PropertyInfo info;
  info.path = path;
  info.kind = api::PropertyKind::property;
  info.value_type = prop.type;
  info.animated = !prop.keys.empty();
  info.enabled = true;
  info.keyframe_count = static_cast<std::uint32_t>(prop.keys.size());
  info.value = std::move(value);
  if (const PropertySpec* spec = find_spec(layer.kind, path)) {
    info.name = std::string(spec->name);
    info.match_name = std::string(spec->matchName);
    info.unit = std::string(spec->unit);
    info.animatable = spec->animatable;
    info.dimensions = spec->dimensions;
    info.min_ = spec->min;
    info.max_ = spec->max;
  }
  return info;
}

api::KeyframeSet keyframe_set(const Layer& layer, const std::string& path, const Property& prop) {
  api::KeyframeSet set;
  set.prop = api::PropRef{layer.id, path};
  set.keyframes = prop.keys;
  return set;
}

}  // namespace premation::doc
