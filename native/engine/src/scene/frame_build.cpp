#include "frame_build.hpp"
#include "paint_port.hpp"
#include "text_port.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <functional>
#include <limits>
#include <numbers>
#include <utility>

#include "bake_chain.hpp"
#include "effects_port.hpp"
#include "lut_port.hpp"
#include "jsmath.hpp"
#include "misc_port.hpp"
#include "readers.hpp"
#include "scene_math.hpp"
#include "light_wash.hpp"
#include "threed_frame.hpp"
#include "precomp_frame.hpp"

namespace premation::scene {
namespace {

constexpr double kMaxGlyphPad = 512;
/// The raster tier ladder below Continuous Rasterization (VectorRasterizer.ts).
constexpr std::array<double, 4> kTiers = {0.5, 1, 2, 4};
/// The GPU max texture size the TS provider reports (WebGPU on the gate's adapters).
constexpr double kDeviceMax = 16384;

double resolution_tier(double scale) {
  if (!(scale > 0) || std::isnan(scale)) return 1;
  for (const double t : kTiers) {
    if (scale <= t) return t;
  }
  return kTiers.back();
}

/// CONTINUOUS_RESOLUTION_TIERS / DEFAULT_MAX_RASTER_PIXELS (VectorRasterizer.ts).
constexpr std::array<double, 8> kContinuousTiers = {0.5, 1, 2, 4, 8, 16, 32, 64};
constexpr double kMaxRasterPixels = 16.0 * 1024 * 1024;

/// VectorRasterizer.ts `continuousResolutionTier(scale, boxW, boxH, 64, deviceMax)`
/// (with `maxContinuousTier` inlined).
double continuous_resolution_tier(double scale, double boxW, double boxH) {
  if (!(scale > 0) || std::isnan(scale)) return 1;
  const double w = std::max(1.0, boxW != 0 && !std::isnan(boxW) ? boxW : 1);
  const double h = std::max(1.0, boxH != 0 && !std::isnan(boxH) ? boxH : 1);
  double best = kContinuousTiers.front();
  for (const double t : kContinuousTiers) {
    if (w * t > kDeviceMax || h * t > kDeviceMax) break;
    if (w * t * h * t > kMaxRasterPixels) break;
    best = t;
  }
  const double limit = std::min(best, kContinuousTiers.back());
  double chosen = kContinuousTiers.front();
  for (const double t : kContinuousTiers) {
    chosen = t;
    if (scale <= t) break;
  }
  return std::min(chosen, std::max(kContinuousTiers.front(), limit));
}

/// AppTextureProvider.tierFor (Continuous Rasterization off: the clamped ladder up
/// to 4x, the bounded extended ladder past it).
double tier_for(double scale, double boxW, double boxH) {
  if (scale <= kTiers.back()) return resolution_tier(scale);
  return continuous_resolution_tier(scale, boxW, boxH);
}

float f32(double v) { return static_cast<float>(v); }

/// normalizeDeformedMesh: rig-space vertices (centred layer px) → the unit
/// quad the renderable's model spans (width/height + padding); uv and depth
/// as they are. Float32 like the TypeScript's Float32Array; little-endian bytes.
api::RenderDeformedMesh deformed_mesh_wire(const DeformedMeshData& m, double width, double height, double pad) {
  const double w = width + 2 * pad;
  const double h = height + 2 * pad;
  api::RenderDeformedMesh out;
  std::vector<float> v(m.vertices.size());
  for (std::size_t i = 0; i + 3 < m.vertices.size(); i += 4) {
    v[i] = f32(static_cast<double>(m.vertices[i]) / w + 0.5);
    v[i + 1] = f32(static_cast<double>(m.vertices[i + 1]) / h + 0.5);
    v[i + 2] = m.vertices[i + 2];
    v[i + 3] = m.vertices[i + 3];
  }
  out.vertices.resize(v.size() * sizeof(float));
  std::memcpy(out.vertices.data(), v.data(), out.vertices.size());
  out.triangles.resize(m.triangles.size() * sizeof(std::uint16_t));
  std::memcpy(out.triangles.data(), m.triangles.data(), out.triangles.size());
  if (m.depth) {
    std::vector<std::uint8_t> d(m.depth->size() * sizeof(float));
    std::memcpy(d.data(), m.depth->data(), d.size());
    out.depth = std::move(d);
  }
  return out;
}

Mat3 compose(double tx, double ty, double rad, double sx, double sy) {
  const double c = motion::js::cos(rad);
  const double s = motion::js::sin(rad);
  Mat3 m;
  m.m = {f32(c * sx), f32(s * sx), 0, f32(-s * sy), f32(c * sy), 0, f32(tx), f32(ty), 1};
  return m;
}
Mat3 translation(double tx, double ty) {
  Mat3 m;
  m.m[6] = f32(tx);
  m.m[7] = f32(ty);
  return m;
}
Mat3 scaling(double sx, double sy) {
  Mat3 m;
  m.m[0] = f32(sx);
  m.m[4] = f32(sy);
  return m;
}

/// composeSkewed: T · R(rotation) · Skew(axis) · Scale, 2×2 products in float64.
Mat3 compose_skewed(double tx, double ty, double rad, double sx, double sy, double skewDeg, double axisDeg) {
  using M2 = std::array<double, 4>;
  const auto mul = [](const M2& A, const M2& B) -> M2 {
    return {A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3]};
  };
  const auto rot = [](double r) -> M2 { return {motion::js::cos(r), motion::js::sin(r), -motion::js::sin(r), motion::js::cos(r)}; };
  const double axis = (axisDeg * std::numbers::pi) / 180;
  const double k = motion::js::tan((std::max(-89.5, std::min(89.5, skewDeg)) * std::numbers::pi) / 180);
  M2 m = rot(rad);
  m = mul(m, mul(rot(axis), mul(M2{1, 0, k, 1}, rot(-axis))));
  m = mul(m, M2{sx, 0, 0, sy});
  Mat3 o;
  o.m = {f32(m[0]), f32(m[1]), 0, f32(m[2]), f32(m[3]), 0, f32(tx), f32(ty), 1};
  return o;
}

struct Origin {
  double x, y;
};
Origin quad_origin(const RLayer& l, double pad) {
  const double W = l.width + 2 * pad;
  const double H = l.height + 2 * pad;
  return {-0.5 - (W > 0 ? l.anchorX / W : 0), -0.5 - (H > 0 ? l.anchorY / H : 0)};
}

Mat3 center_model(const RLayer& l) {
  const double rad = (l.rotation * std::numbers::pi) / 180;
  const double pad = raster_padding(l);
  const double w = (l.width + 2 * pad) * l.scaleX;
  const double h = (l.height + 2 * pad) * l.scaleY;
  const double skew = l.skew.value_or(0);
  const Mat3 base = skew == 0 ? compose(l.x, l.y, rad, w, h) : compose_skewed(l.x, l.y, rad, w, h, skew, l.skewAxis.value_or(0));
  const Origin o = quad_origin(l, pad);
  return mat3_mul(base, translation(o.x, o.y));
}

api::Rect bounds_of(const Mat3& mm) {
  const auto& m = mm.m;
  const std::array<std::array<double, 2>, 4> pts = {{
      {m[6], m[7]},
      {static_cast<double>(m[0]) + m[6], static_cast<double>(m[1]) + m[7]},
      {static_cast<double>(m[3]) + m[6], static_cast<double>(m[4]) + m[7]},
      {static_cast<double>(m[0]) + m[3] + m[6], static_cast<double>(m[1]) + m[4] + m[7]},
  }};
  constexpr double kInf = std::numeric_limits<double>::infinity();
  double minX = kInf, minY = kInf, maxX = -kInf, maxY = -kInf;
  for (const auto& p : pts) {
    minX = std::min(minX, p[0]);
    minY = std::min(minY, p[1]);
    maxX = std::max(maxX, p[0]);
    maxY = std::max(maxY, p[1]);
  }
  api::Rect r;
  r.x = minX;
  r.y = minY;
  r.width = maxX - minX;
  r.height = maxY - minY;
  return r;
}

std::vector<double> mat_wire(const Mat3& m) {
  std::vector<double> v(9);
  for (std::size_t i = 0; i < 9; ++i) v[i] = m.m[i];
  return v;
}

/// snapshotToFrameScene advancedBlendId (a wire format; never renumbered).
int advanced_blend_id(std::string_view mode) {
  static constexpr std::array<std::string_view, 36> kModes = {
      "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light",
      "difference", "exclusion", "hue", "saturation", "color", "luminosity", "linear-burn", "linear-dodge",
      "linear-light", "vivid-light", "pin-light", "hard-mix", "subtract", "divide", "classic-color-burn",
      "classic-color-dodge", "classic-difference", "darker-color", "lighter-color", "alpha-add", "luminescent-premul",
      "stencil-alpha", "stencil-luma", "silhouette-alpha", "silhouette-luma", "dissolve", "dancing-dissolve"};
  for (std::size_t i = 0; i < kModes.size(); ++i) {
    if (kModes[i] == mode) return static_cast<int>(i + 1);
  }
  return 0;
}

api::Color to_color(const Rgba& c) {
  api::Color o;
  o.r = c.r;
  o.g = c.g;
  o.b = c.b;
  o.a = c.a;
  return o;
}

bool stroke_renders(const Json& s) { return s.is_object() && s.at("width").is_number() && s.at("width").num() > 0; }

bool has_ordered_paint(const RLayer& l) {
  // vectorDraw.ts layerHasOrderedPaint: any paint that composites above or blends.
  const auto flagged = [](const Json& o) {
    return o.is_object() && ((o.at("composite").is_string() && o.at("composite").str() == "above") ||
                             (o.at("blendMode").is_string() && o.at("blendMode").str() != "normal"));
  };
  if (l.fillPaints.is_array() && !l.fillPaints.arr().empty()) {
    if (std::ranges::any_of(l.fillPaints.arr(), flagged)) return true;
  } else if (flagged(l.fillPaint)) {
    return true;
  }
  if (l.strokes.is_array() && !l.strokes.arr().empty()) return std::ranges::any_of(l.strokes.arr(), flagged);
  return flagged(l.stroke);
}

class Flattener {
 public:
  Flattener(double rasterScale, double fps) : rasterScale_(rasterScale), fps_(fps) {}
  /// `placement` = flattenLayers' placement3d: the 2D placement the camera these layers draw through carries.
  void flatten(const std::vector<RLayer>& layers, const Mat3& parent, double parentOpacity, std::vector<api::Renderable>& out,
               const Mat3* placement = nullptr);
  [[nodiscard]] std::vector<TextureRequest> take_textures() noexcept { return std::move(textures_); }
  [[nodiscard]] std::vector<std::pair<std::string, std::string>> take_unported() noexcept { return std::move(unported_); }

 private:
  std::vector<TextureRequest> textures_;
  std::vector<std::pair<std::string, std::string>> unported_;
  api::Renderable layer_to_renderable(const RLayer& l, const Mat3& parent, double parentOpacity, const Mat3* placement);
  api::Renderable precomp_to_renderable(const RLayer& l, const Mat3& parent, double parentOpacity, const Mat3* placement);
  std::optional<api::Renderable> adjustment_to_renderable(const RLayer& l);
  void feed(const RLayer& l);
  static bool needs_isolation(const RLayer& l);
  double rasterScale_;
  double fps_;
};

bool Flattener::needs_isolation(const RLayer& l) {
  if (!l.precompLayers || l.precompLayers->empty()) return false;
  if (l.precompScene3d) return true;  // its own 3D scope
  if (l.motionSamples.size() > 1) return true;
  if (l.quad3d) return true;  // a 3D comp card draws from a flat offscreen
  if (l.blend != "normal") return true;
  if (l.mask.is_object() && !l.mask.at("paths").arr().empty()) return true;
  if (l.paint.is_object() && !l.paint.at("strokes").arr().empty()) return true;
  if (l.matte && l.matteSourceId) return true;
  if (l.isMatteSource) return true;
  if (!l.effects.empty()) return true;
  const auto visible = std::ranges::count_if(*l.precompLayers, [](const RLayer& c) { return c.visible; });
  if (l.opacity < 1 && visible > 1) return true;
  std::function<bool(const std::vector<RLayer>&)> anyAdj = [&](const std::vector<RLayer>& ls) {
    return std::ranges::any_of(ls, [&](const RLayer& c) { return c.isAdjustment || (c.precompLayers && anyAdj(*c.precompLayers)); });
  };
  return anyAdj(*l.precompLayers);
}

Json layer_json(const RLayer& l, std::string_view kind) {
  Json o = Json::object();
  o.set("id", Json::string(l.id));
  o.set("kind", Json::string(std::string(kind)));
  o.set("blend", Json::string(l.blend));
  if (l.mask.is_object()) o.set("mask", l.mask);
  if (l.sourceTime) o.set("sourceTime", Json::number(*l.sourceTime));
  o.set("x", Json::number(l.x));
  o.set("y", Json::number(l.y));
  o.set("rotation", Json::number(l.rotation));
  o.set("scaleX", Json::number(l.scaleX));
  o.set("scaleY", Json::number(l.scaleY));
  o.set("depth", Json::number(l.depth));
  o.set("opacity", Json::number(l.opacity));
  o.set("width", Json::number(l.width));
  o.set("height", Json::number(l.height));
  if (l.fill) o.set("fill", Json::string(*l.fill));
  if (!l.fillPaint.is_undefined()) o.set("fillPaint", l.fillPaint);
  if (!l.fillPaints.is_undefined()) o.set("fillPaints", l.fillPaints);
  if (!l.stroke.is_undefined()) o.set("stroke", l.stroke);
  if (!l.strokes.is_undefined()) o.set("strokes", l.strokes);
  if (l.color) o.set("color", Json::string(*l.color));
  o.set("visible", Json::boolean(l.visible));
  o.set("primitive", Json::string(l.primitive));
  o.set("cornerRadius", Json::number(l.cornerRadius));
  if (l.cornerRadii) {
    Json a = Json::array();
    for (const double v : *l.cornerRadii) a.arr_mut().push_back(Json::number(v));
    o.set("cornerRadii", std::move(a));
  }
  if (l.cornerRadiusScale) {
    Json a = Json::array();
    for (const double v : *l.cornerRadiusScale) a.arr_mut().push_back(Json::number(v));
    o.set("cornerRadiusScale", std::move(a));
  }
  if (!l.pathPoints.is_undefined()) o.set("pathPoints", l.pathPoints);
  if (!l.subpaths.is_undefined()) o.set("subpaths", l.subpaths);
  if (l.pathOpen) o.set("pathOpen", Json::boolean(true));
  if (!l.effects.empty()) {
    Json a = Json::array();
    for (const Json& e : l.effects) a.arr_mut().push_back(e);
    o.set("effects", std::move(a));
  }
  if (l.fillOpacity) o.set("fillOpacity", Json::number(*l.fillOpacity));
  if (!l.paint.is_undefined()) o.set("paint", l.paint);
  o.set("__baked", Json::boolean(layer_is_baked(l)));
  o.set("__deviceMax", Json::number(kDeviceMax));
  return o;
}

Json text_spec(const RLayer& l) {
  Json o = Json::object();
  o.set("text", Json::string(l.text.value_or("Text")));
  o.set("fontSize", Json::number(l.fontSize));
  o.set("color", Json::string(l.fill.value_or("#ffffff")));
  o.set("width", Json::number(l.width));
  o.set("height", Json::number(l.height));
  o.set("scaleX", Json::number(l.scaleX));
  o.set("scaleY", Json::number(l.scaleY));
  const auto setS = [&o](const char* k, const std::optional<std::string>& v) {
    if (v) o.set(k, Json::string(*v));
  };
  const auto setN = [&o](const char* k, const std::optional<double>& v) {
    if (v) o.set(k, Json::number(*v));
  };
  setS("fontFamily", l.fontFamily);
  setS("fontWeight", l.fontWeight);
  setN("fontWidth", l.fontWidth);
  setN("fontSlant", l.fontSlant);
  setS("fontStyle", l.fontStyle);
  setS("align", l.align);
  setN("letterSpacing", l.letterSpacing);
  setN("lineHeight", l.lineHeight);
  setN("paragraphSpacing", l.paragraphSpacing);
  if (l.strokeOverFill) o.set("strokeOverFill", Json::boolean(*l.strokeOverFill));
  setS("textTransform", l.textTransform);
  setS("fontVariant", l.fontVariant);
  setS("verticalAlign", l.verticalAlign);
  setN("verticalScale", l.verticalScale);
  setN("horizontalScale", l.horizontalScale);
  setN("baselineShift", l.baselineShift);
  setS("textStroke", l.textStroke);
  setN("textStrokeWidth", l.textStrokeWidth);
  if (!l.textExtras.is_undefined()) o.set("textExtras", l.textExtras);
  if (!l.runs.is_undefined()) o.set("runs", l.runs);
  if (!l.glyphs.is_undefined()) o.set("glyphs", l.glyphs);
  if (!l.textPath.is_undefined()) o.set("textPath", l.textPath);
  if (!l.fontAxes.is_undefined()) o.set("fontAxes", l.fontAxes);
  if (l.fillPaint.is_object() && l.fillPaint.at("type").is_string() && l.fillPaint.at("type").str() != "solid") {
    o.set("fillPaint", l.fillPaint);
  }
  if (!l.textStrokePaint.is_undefined()) o.set("strokePaint", l.textStrokePaint);
  if (!l.effects.empty()) {
    Json a = Json::array();
    for (const Json& e : l.effects) a.arr_mut().push_back(e);
    o.set("effects", std::move(a));
  }
  if (l.mask.is_object()) o.set("mask", l.mask);
  if (l.fillOpacity) o.set("fillOpacity", Json::number(*l.fillOpacity));  // TextSpec.fillOpacity (the bake's fade)
  o.set("kind", Json::string("text"));
  o.set("__baked",Json::boolean(layer_is_baked(l)));  // text_spec is only built for text layers
  o.set("__deviceMax", Json::number(kDeviceMax));
  return o;
}

void Flattener::feed(const RLayer& l) {
  // MotionRendererBackend's per-layer texture feed (the keys layerToRenderable names).
  const double layerScale = std::max({1.0, std::abs(l.scaleX != 0 ? l.scaleX : 1), std::abs(l.scaleY != 0 ? l.scaleY : 1)});
  const double effective = rasterScale_ * layerScale;
  const double tier = tier_for(effective, l.width, l.height);
  if (l.extrudedMesh && l.extrudedMesh->paint) {
    // An extrusion's gradient plate: the layer box filled edge to edge with the
    // fill paint, a plain rect through the path rasteriser (MotionRendererBackend 0a).
    const ExtrudedMeshData::Paint& p = *l.extrudedMesh->paint;
    RLayer plate;
    plate.id = p.key;
    plate.width = p.width;
    plate.height = p.height;
    plate.fill = p.fill;
    plate.fillPaint = p.fillPaint;
    TextureRequest r;
    r.key = p.key;
    r.kind = TexKind::path;
    r.spec = layer_json(plate, "path");
    r.resolutionScale = tier_for(rasterScale_, p.width, p.height);
    r.padding = raster_padding(plate);
    r.layerId = l.id;
    textures_.push_back(std::move(r));
  }
  if (l.kind == LayerKind::image || l.kind == LayerKind::video) {
    TextureRequest r;
    r.key = "asset:" + l.id;
    r.kind = TexKind::media;
    r.src = l.src.value_or("");
    r.sourceTime = l.sourceTime.value_or(0);
    r.video = l.kind == LayerKind::video;
    r.premultiplied = l.premultipliedSource;
    r.fill = l.fill;
    r.compFps = fps_;
    r.layerId = l.id;
    textures_.push_back(std::move(r));
  } else if (l.kind == LayerKind::text) {
    TextureRequest r;
    r.key = "text:" + l.id;
    r.kind = TexKind::text;
    r.spec = text_spec(l);
    r.resolutionScale = tier;
    r.padding = raster_padding(l);
    r.layerId = l.id;
    textures_.push_back(std::move(r));
  } else if (!(l.precompLayers && !l.precompLayers->empty()) && needs_shape_raster(l)) {
    TextureRequest r;
    r.key = "path:" + l.id;
    r.kind = TexKind::path;
    r.spec = layer_json(l, "path");
    r.resolutionScale = tier;
    r.padding = raster_padding(l);
    r.layerId = l.id;
    textures_.push_back(std::move(r));
  }
  if (l.mask.is_object() && !l.mask.at("paths").arr().empty()) {
    TextureRequest r;
    r.key = "mask:" + l.id;
    r.kind = TexKind::mask;
    r.spec = layer_json(l, "mask");
    r.layerId = l.id;
    textures_.push_back(std::move(r));
  }
  append_lut_textures(l, textures_);  // lut:<id> / cubelut:<id> (lut_port.cpp)
}

api::Renderable Flattener::layer_to_renderable(const RLayer& l, const Mat3& parent, double parentOpacity,
                                                const Mat3* placement) {
  const double pad = raster_padding(l);
  const int adv = advanced_blend_id(l.blend);
  Mat3 model;
  if (l.matrix) {
    const auto& mm = *l.matrix;
    model.m = {f32(mm[0]), f32(mm[1]), 0, f32(mm[2]), f32(mm[3]), 0, f32(mm[4]), f32(mm[5]), 1};
    const Origin o = quad_origin(l, pad);
    model = mat3_mul(model, mat3_mul(scaling(l.width + 2 * pad, l.height + 2 * pad), translation(o.x, o.y)));
    model = mat3_mul(parent, model);
  } else {
    model = mat3_mul(parent, center_model(l));
  }
  const double opacity = parentOpacity * l.opacity;
  const bool custom = needs_shape_raster(l);
  api::RenderableKind kind = api::RenderableKind::rect;
  if (custom || l.kind == LayerKind::image) kind = api::RenderableKind::image;
  else if (l.kind == LayerKind::text) kind = api::RenderableKind::text;
  else if (l.kind == LayerKind::video) kind = api::RenderableKind::video;
  api::Renderable r;
  r.id = l.id;
  r.kind = kind;
  // motion samples
  if (l.motionSamples.size() > 1) {
    const Origin so = quad_origin(l, pad);
    for (const MotionSample& s : l.motionSamples) {
      const double rad = (s.rotation * std::numbers::pi) / 180;
      const double w = (l.width + 2 * pad) * s.scaleX;
      const double h = (l.height + 2 * pad) * s.scaleY;
      Mat3 m;
      if (s.matrix) {  // 3D samples carry their own projected affine (no parent: the TS applies none)
        const auto& sm = *s.matrix;
        m.m = {f32(sm[0]), f32(sm[1]), 0, f32(sm[2]), f32(sm[3]), 0, f32(sm[4]), f32(sm[5]), 1};
        m = mat3_mul(m, mat3_mul(scaling(l.width + 2 * pad, l.height + 2 * pad), translation(so.x, so.y)));
      } else {
        m = mat3_mul(parent, mat3_mul(compose(s.x, s.y, rad, w, h), translation(so.x, so.y)));
      }
      api::RenderMotionSample ms;
      ms.model_matrix = mat_wire(m);
      ms.opacity = s.opacity;
      r.motion_samples.push_back(std::move(ms));
    }
  }
  r.model_matrix = mat_wire(model);
  r.bounds = bounds_of(model);
  r.opacity = opacity;
  r.blend = adv > 0 ? api::RenderBlendMode::normal : (l.blend == "add" ? api::RenderBlendMode::add : api::RenderBlendMode::normal);
  if (adv > 0) r.advanced_blend = adv;
  r.preserve_transparency = l.preserveTransparency;
  if (l.backdropBlur && *l.backdropBlur > 0) r.backdrop_blur = *l.backdropBlur;
  if (l.glass) r.glass = to_renderable_glass(*l.glass);
  if (l.draft) r.sampling = api::RenderSampling::nearest;
  const bool textured = kind == api::RenderableKind::image || kind == api::RenderableKind::video || kind == api::RenderableKind::text;
  const bool baked = layer_is_baked(l);
  if (textured) {
    r.color = to_color({1, 1, 1, 1});
  } else {
    // gradedSolidColor: layer.fill (else a solid paint's colour), graded by the colour matrix.
    std::string rep = "#000000";
    if (l.fill) rep = *l.fill;
    else if (l.fillPaint.is_object() && l.fillPaint.at("type").str() == "solid") rep = l.fillPaint.at("color").str();
    Rgba c = color_from_hex(rep);
    if (!l.effects.empty()) {
      const ColorMatrix cm = effect_color_matrix(l.effects);
      const auto rgb = grade_uniform_lut(l, apply_color_matrix(cm, {c.r, c.g, c.b}));  // gradeUniformColor
      c = {rgb[0], rgb[1], rgb[2], c.a};
    }
    r.color = to_color(c);
  }
  if (custom) r.texture_key = "path:" + l.id;
  if (!custom && (kind == api::RenderableKind::image || kind == api::RenderableKind::video)) r.texture_key = "asset:" + l.id;
  if (l.uvRect) {
    api::Rect u;
    u.x = (*l.uvRect)[0];
    u.y = (*l.uvRect)[1];
    u.width = (*l.uvRect)[2];
    u.height = (*l.uvRect)[3];
    r.uv_rect = u;
  }
  if (kind == api::RenderableKind::text) r.texture_key = "text:" + l.id;
  if (!baked && l.mask.is_object() && !l.mask.at("paths").arr().empty()) r.mask_texture_key = "mask:" + l.id;
  if (!baked && textured && has_lut_effect(l)) r.lut_texture_key = "lut:" + l.id;
  if (l.matte && l.matteSourceId) {
    api::RenderMatte m;
    m.mode = l.matte->luma ? api::RenderMatteMode::luma : api::RenderMatteMode::alpha;
    m.inverted = l.matte->inverted;
    m.source_id = *l.matteSourceId;
    r.matte = m;
  }
  if (textured) {
    if (!baked && !l.effects.empty()) {
      const ColorMatrix cm = effect_color_matrix(l.effects);
      if (!cm.identity) {
        api::RenderColorMatrix wm;
        wm.m.assign(cm.m.begin(), cm.m.end());
        wm.offset.assign(cm.offset.begin(), cm.offset.end());
        r.color_matrix = wm;
      }
    }
  } else {
    // sdfFor(layer).
    if (l.kind == LayerKind::shape && l.primitive != "path" && !l.flatFacet) {  // a facet: no SDF edge coverage
      api::RenderSdf sdf;
      sdf.width = l.width;
      sdf.height = l.height;
      if (l.primitive == "ellipse") {
        sdf.shape = api::RenderSdfShape::ellipse;
        sdf.radius_px = 0;
      } else {
        double scaleK = 1;
        if (l.cornerRadiusScale) {
          const auto& cs = *l.cornerRadiusScale;
          if (std::abs(cs[0] - cs[1]) <= 1e-6) scaleK = 1 / (cs[0] > 1e-6 ? cs[0] : 1);
        }
        sdf.shape = api::RenderSdfShape::rounded;
        if (l.cornerRadii) {
          const auto& rr = *l.cornerRadii;
          sdf.radius_px = (rr[0] == rr[1] && rr[1] == rr[2] && rr[2] == rr[3]) ? rr[0] * scaleK : 0;
        } else {
          sdf.radius_px = l.cornerRadius * scaleK;
        }
      }
      r.sdf = sdf;
    }
  }
  r.effects = extract_spatial_effects(l, baked);
  if (l.deformedMesh) r.deformed_mesh = deformed_mesh_wire(*l.deformedMesh, l.width, l.height, pad);
  // Shape / text bakes run on their raster (bake_chain.cpp); footage bakes
  // (AppTextureProvider setImage / setVideo) are not ported yet.
  if (baked && (l.kind == LayerKind::image || l.kind == LayerKind::video)) {
    unported_.emplace_back(l.id, "CPU-baked effect chain on footage (E4)");
  }
  apply_three_d(l, parent, r, placement);  // threeD / castsShadow / Accepts-Lights routing (threed_frame.cpp)
  return r;
}

api::Renderable Flattener::precomp_to_renderable(const RLayer& l, const Mat3& parent, double parentOpacity,
                                                  const Mat3* placement) {
  // A 3D comp CARD (`quad3d`) draws its comp flat through a homography onto the
  // projected corners; a degenerate quad falls back to the screen-space container.
  const std::optional<Mat3> cardModel = l.quad3d ? square_to_quad(*l.quad3d) : std::nullopt;
  // precompChildParent(layer, parentMatrix) (identity inside a card).
  const double rad = (l.rotation * std::numbers::pi) / 180;
  const Mat3 tOrigin = translation(-l.width / 2 - l.anchorX, -l.height / 2 - l.anchorY);
  const Mat3 childParent =
      cardModel ? Mat3::identity() : mat3_mul(parent, mat3_mul(compose(l.x, l.y, rad, l.scaleX, l.scaleY), tOrigin));
  api::Renderable r;
  std::vector<api::Renderable> inner;
  // A sealed comp with its own 3D frame draws through its own camera, which carries
  // `childParent`; a card's children are drawn in the card, not the scene.
  const Mat3* innerPlacement = l.precompScene3d ? &childParent : cardModel ? nullptr : placement;
  if (l.precompLayers) flatten(*l.precompLayers, childParent, 1, inner, innerPlacement);  // callers pass only precomps with layers
  const Mat3 model = cardModel ? mat3_mul(parent, *cardModel) : mat3_mul(parent, center_model(l));
  const int adv = advanced_blend_id(l.blend);
  r.id = l.id;
  r.kind = api::RenderableKind::image;
  r.model_matrix = mat_wire(model);
  r.bounds = bounds_of(model);
  if (cardModel) {  // the AABB of the four projected corners
    constexpr double kInf = std::numeric_limits<double>::infinity();
    double minX = kInf, minY = kInf, maxX = -kInf, maxY = -kInf;
    for (std::size_t i = 0; i < 8; i += 2) {
      const auto& p = parent.m;
      const double qx = (*l.quad3d)[i];
      const double qy = (*l.quad3d)[i + 1];
      // Mat3.transformPoint: float32 matrix entries, float64 arithmetic.
      const double x = static_cast<double>(p[0]) * qx + static_cast<double>(p[3]) * qy + p[6];
      const double y = static_cast<double>(p[1]) * qx + static_cast<double>(p[4]) * qy + p[7];
      minX = std::min(minX, x);
      minY = std::min(minY, y);
      maxX = std::max(maxX, x);
      maxY = std::max(maxY, y);
    }
    r.bounds.x = minX;
    r.bounds.y = minY;
    r.bounds.width = maxX - minX;
    r.bounds.height = maxY - minY;
  }
  r.opacity = parentOpacity * l.opacity;
  r.blend = adv > 0 ? api::RenderBlendMode::normal : (l.blend == "add" ? api::RenderBlendMode::add : api::RenderBlendMode::normal);
  if (adv > 0) r.advanced_blend = adv;
  r.preserve_transparency = l.preserveTransparency;
  if (l.backdropBlur && *l.backdropBlur > 0) r.backdrop_blur = *l.backdropBlur;
  if (l.glass) r.glass = to_renderable_glass(*l.glass);
  // Accepts Lights on a 3D card: the per-quad gain as the tint.
  r.color = l.lighting ? to_color({(*l.lighting)[0], (*l.lighting)[1], (*l.lighting)[2], 1}) : to_color({1, 1, 1, 1});
  r.texture_key = "precomp:" + l.id;
  if (l.mask.is_object() && !l.mask.at("paths").arr().empty()) {
    r.mask_texture_key = "mask:" + l.id;  // fed with the layer (feed)
  }
  if (l.matte && l.matteSourceId) {
    api::RenderMatte m;
    m.mode = l.matte->luma ? api::RenderMatteMode::luma : api::RenderMatteMode::alpha;
    m.inverted = l.matte->inverted;
    m.source_id = *l.matteSourceId;
    r.matte = m;
  }
  if (l.isMatteSource) r.matte_source = true;
  if (!l.effects.empty()) {
    const ColorMatrix cm = effect_color_matrix(l.effects);
    if (!cm.identity) {
      api::RenderColorMatrix wm;
      wm.m.assign(cm.m.begin(), cm.m.end());
      wm.offset.assign(cm.offset.begin(), cm.offset.end());
      r.color_matrix = wm;
    }
  }
  r.effects = extract_spatial_effects(l, false);
  r.precomp = precomp_frame(l, childParent, cardModel.has_value());  // precompCamera3d / flat (precomp_frame.cpp)
  r.precomp_children = std::move(inner);
  if (l.motionSamples.size() > 1) {
    const double pad = raster_padding(l);
    const Origin so = quad_origin(l, pad);
    for (const MotionSample& s : l.motionSamples) {
      if (cardModel && s.quad) {  // a 3D card's sample is its own perspective quad
        if (const auto sq = square_to_quad(*s.quad)) {
          api::RenderMotionSample ms;
          ms.model_matrix = mat_wire(mat3_mul(parent, *sq));
          ms.opacity = parentOpacity * s.opacity;
          r.motion_samples.push_back(std::move(ms));
          continue;
        }
      }
      const double srad = (s.rotation * std::numbers::pi) / 180;
      const double w = (l.width + 2 * pad) * s.scaleX;
      const double h = (l.height + 2 * pad) * s.scaleY;
      const Mat3 m = mat3_mul(compose(s.x, s.y, srad, w, h), translation(so.x, so.y));
      api::RenderMotionSample ms;
      ms.model_matrix = mat_wire(mat3_mul(parent, m));
      ms.opacity = parentOpacity * s.opacity;
      r.motion_samples.push_back(std::move(ms));
    }
  }
  return r;
}

std::optional<api::Renderable> Flattener::adjustment_to_renderable(const RLayer& l) {
  const ColorMatrix cm = l.effects.empty() ? ColorMatrix{} : effect_color_matrix(l.effects);
  const bool lut = has_lut_effect(l);
  std::vector<api::RenderEffect> spatial = extract_spatial_effects(l, false);
  if (cm.identity && !lut && spatial.empty()) return std::nullopt;
  api::Renderable r;
  r.id = l.id;
  r.kind = api::RenderableKind::group;
  r.model_matrix = mat_wire(Mat3::identity());
  r.bounds.x = 0;
  r.bounds.y = 0;
  r.bounds.width = 1;
  r.bounds.height = 1;
  r.opacity = 1;
  r.blend = api::RenderBlendMode::normal;
  api::RenderAdjustment adj;
  if (!cm.identity) {
    api::RenderColorMatrix wm;
    wm.m.assign(cm.m.begin(), cm.m.end());
    wm.offset.assign(cm.offset.begin(), cm.offset.end());
    adj.color_matrix = wm;
  }
  if (lut) {
    adj.lut_texture_key = "lut:" + l.id;
  }
  r.adjustment = adj;
  r.effects = std::move(spatial);
  return r;
}

void Flattener::flatten(const std::vector<RLayer>& layers, const Mat3& parent, double parentOpacity,
                        std::vector<api::Renderable>& out, const Mat3* placement) {
  for (const RLayer& l : layers) {
    const std::size_t mark = out.size();
    try {
      if (!l.visible) continue;
      feed(l);
      if (l.isMatteSource) {
        api::Renderable src = l.precompLayers && !l.precompLayers->empty() && needs_isolation(l)
                                  ? precomp_to_renderable(l, parent, parentOpacity, placement)
                                  : layer_to_renderable(l, parent, parentOpacity, placement);
        src.matte_source = true;
        out.push_back(std::move(src));
        continue;
      }
      if (l.isAdjustment) {
        if (auto adj = adjustment_to_renderable(l)) out.push_back(std::move(*adj));
        continue;
      }
      if (l.light) {  // a light's screen-blended glow quad
        out.push_back(light_to_renderable(l, parent, parentOpacity));
        TextureRequest tr;  // AppTextureProvider rasterizeLight (light_wash.cpp)
        tr.key = "light:" + l.id;
        tr.kind = TexKind::light;
        tr.spec = light_wash_spec(*l.light);
        tr.layerId = l.id;
        textures_.push_back(std::move(tr));
        continue;
      }
      if (l.precompLayers && !l.precompLayers->empty()) {
        if (needs_isolation(l)) {
          out.push_back(precomp_to_renderable(l, parent, parentOpacity, placement));
          continue;
        }
        const double rad = (l.rotation * std::numbers::pi) / 180;
        const Mat3 tOrigin = translation(-l.width / 2 - l.anchorX, -l.height / 2 - l.anchorY);
        const Mat3 childParent = mat3_mul(parent, mat3_mul(compose(l.x, l.y, rad, l.scaleX, l.scaleY), tOrigin));
        flatten(*l.precompLayers, childParent, parentOpacity * l.opacity, out, placement);
      } else {
        out.push_back(layer_to_renderable(l, parent, parentOpacity, placement));
      }
    } catch (const std::exception& e) {
      out.resize(mark);
      unported_.emplace_back(l.id, std::string("scene: ") + e.what());
    }
  }
}

}  // namespace

double raster_padding(const RLayer& l) {
  double pad = bake::baked_effect_spread(l);  // bakedEffectSpread (bake_chain.cpp)
  // Non-shape: the bleed widened by the glyph / text-path escape (text_port.cpp).
  if (l.kind != LayerKind::shape) return text_raster_padding(l, pad);
  std::vector<const Json*> strokes;
  if (l.strokes.is_array() && !l.strokes.arr().empty()) {
    for (const Json& s : l.strokes.arr()) strokes.push_back(&s);
  } else if (l.stroke.is_object()) {
    strokes.push_back(&l.stroke);
  }
  double overshoot = 0;
  for (const Json* s : strokes) {
    if (!s->is_object() || !(s->at("width").num() > 0)) continue;
    const std::string align = s->at("align").is_string() ? s->at("align").str() : "center";
    if (align == "inside") continue;
    const double width = s->at("width").num();
    const double band = align == "outside" ? width * 2 : width;
    const double miter = s->at("join").is_string() && s->at("join").str() == "miter" && l.primitive == "path"
                             ? (band / 2) * std::max(1.0, s->at("miterLimit").is_number() ? s->at("miterLimit").num() : 4.0)
                             : 0;
    const Json& w = s->at("wave");
    const bool identityWave = !w.is_object() || w.at("amount").num() == 0 || w.at("wavelength").num() <= 0;
    const double waveReach = identityWave ? 0 : std::abs(w.at("amount").num());
    overshoot = std::max(overshoot, std::max(band, miter) + waveReach);
  }
  if (overshoot > pad) pad = overshoot;
  // The path's own escape from the w×h box (every run, handles included).
  std::vector<const Json*> runs;
  if (l.subpaths.is_array() && !l.subpaths.arr().empty()) {
    for (const Json& r : l.subpaths.arr()) runs.push_back(&r.at("points"));
  } else if (l.pathPoints.is_array() && !l.pathPoints.arr().empty()) {
    runs.push_back(&l.pathPoints);
  }
  if (!runs.empty()) {
    const double hw = l.width / 2;
    const double hh = l.height / 2;
    double escape = 0;
    for (const Json* run : runs) {
      if (!run->is_array()) continue;
      for (const Json& p : run->arr()) {
        const auto v = [&p](const char* k, const char* fb) {
          const Json& x = p.at(k);
          return x.is_undefined() || x.is_null() ? p.at(fb).num() : x.num();
        };
        for (const double x : {p.at("x").num(), v("inX", "x"), v("outX", "x")}) escape = std::max(escape, std::abs(x) - hw);
        for (const double y : {p.at("y").num(), v("inY", "y"), v("outY", "y")}) escape = std::max(escape, std::abs(y) - hh);
      }
    }
    if (escape > 0) {
      const double total = std::min(kMaxGlyphPad, escape + overshoot);
      if (total > pad) pad = total;
    }
  }
  pad = std::max(pad, paint_pad(l.paint));  // paintReach (paint_port.cpp)
  return pad > 0 ? std::min(kMaxGlyphPad, std::ceil(pad + 1)) : 0;
}

bool needs_shape_raster(const RLayer& l) {
  if (l.kind != LayerKind::shape) return false;
  if (l.deformedMesh) return true;
  if (l.primitive == "path") return true;
  if (l.fillPaint.is_object() && l.fillPaint.at("type").str() != "solid") return true;
  if (l.fillPaints.is_array()) {
    for (const Json& p : l.fillPaints.arr()) {
      if (p.at("type").is_string() && p.at("type").str() != "solid") return true;
    }
  }
  if (stroke_renders(l.stroke)) return true;
  if (l.strokes.is_array()) {
    for (const Json& s : l.strokes.arr()) {
      if (stroke_renders(s)) return true;
    }
  }
  if (has_ordered_paint(l)) return true;
  if (l.mask.is_object() && !l.mask.at("paths").arr().empty()) return true;
  if (l.paint.is_object() && !l.paint.at("strokes").arr().empty()) return true;
  if (l.cornerRadii) {
    const auto& r = *l.cornerRadii;
    if (!(r[0] == r[1] && r[1] == r[2] && r[2] == r[3])) return true;
  }
  if (l.cornerRadiusScale && std::abs((*l.cornerRadiusScale)[0] - (*l.cornerRadiusScale)[1]) > 1e-6) {
    const double biggest = l.cornerRadii ? std::max({(*l.cornerRadii)[0], (*l.cornerRadii)[1], (*l.cornerRadii)[2], (*l.cornerRadii)[3]})
                                         : l.cornerRadius;
    if (biggest > 0) return true;
  }
  return layer_is_baked(l);
}

FrameBuild build_frame_scene(const Snapshot& s, double rasterScale) {
  FrameBuild out;
  Flattener f(rasterScale, s.fps);
  std::vector<api::Renderable> renderables;
  f.flatten(s.layers, Mat3::identity(), 1, renderables);
  api::RenderFrameScene& sc = out.scene;
  sc.composition_id = "composition";
  sc.width = s.width;
  sc.height = s.height;
  sc.background = s.transparent ? to_color({0, 0, 0, 0}) : to_color(color_from_hex(s.background));
  const std::function<bool(const std::vector<RLayer>&)> anyEffects = [&](const std::vector<RLayer>& ls) {
    return std::ranges::any_of(ls, [&](const RLayer& l) { return !l.effects.empty() || (l.precompLayers && anyEffects(*l.precompLayers)); });
  };
  const bool adv = std::ranges::any_of(renderables, [](const api::Renderable& r) {
    return r.advanced_blend.value_or(0) > 0 || r.preserve_transparency;
  });
  const bool backdrop = std::ranges::any_of(renderables, [](const api::Renderable& r) { return r.backdrop_blur.value_or(0) > 0 || r.glass; });
  sc.has_effects = anyEffects(s.layers) || adv || backdrop;
  sc.dissolve_frame = motion::js::round(s.time * s.fps);
  sc.renderables = std::move(renderables);
  if (finish_frame_3d(s, sc)) sc.has_effects = true;  // 3D depth groups need the scene colour target
  out.textures = f.take_textures();
  out.unported = f.take_unported();
  return out;
}

}  // namespace premation::scene
