// Grow bounds for the effect chain (see fx_bounds.hpp). Each reach mirrors the
// branch of effect_chain.cpp that draws the entry and cites the WGSL whose
// taps it is read from; an entry type missing here has no known reach.
#include "fx_bounds.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <string_view>
#include <utility>

namespace premation::rg {
namespace {

/// The second texel of a fractional (bilinear) tap, and one to spare.
constexpr double kTapSlack = 2;
/// More octaves than any authored Deep Glow (its UI stops at 8): not measured.
constexpr double kMaxDeepGlowOctaves = 64;

PxBox grow(const PxBox& b, double x, double y) { return {b.x0 - x, b.y0 - y, b.x1 + x, b.y1 + y}; }
PxBox shift(const PxBox& b, double dx, double dy) { return {b.x0 + dx, b.y0 + dy, b.x1 + dx, b.y1 + dy}; }
PxBox unite(const PxBox& a, const PxBox& b) {
  return {std::min(a.x0, b.x0), std::min(a.y0, b.y0), std::max(a.x1, b.x1), std::max(a.y1, b.y1)};
}
bool has_nan(const PxBox& b) { return std::isnan(b.x0) || std::isnan(b.y0) || std::isnan(b.x1) || std::isnan(b.y1); }

FxReach same(const PxBox& in) { return {in, in}; }
FxReach spread(const PxBox& in, double x, double y) {
  const PxBox g = grow(in, x, y);
  return {g, g};
}

/// blur.wgsl: taps max(1, 2.5σ / 30) texels apart, ⌈3.5σ / spacing⌉ a side (one
/// bilinear fetch per pair of neighbours at spacing 1, never past the pair's
/// outer tap) — the last one under 3.5σ + spacing out; the slack holds its
/// fractional second texel. σ <= 0 samples the centre only.
double blur_reach(double sigma) { return sigma > 0 ? 3.5 * sigma + std::max(1.0, sigma * 2.5 / 30) + kTapSlack : 0; }

/// Every number the entry carries is finite. A NaN radius reaches the shaders
/// as NaN weights over the whole frame: such an entry is not measured.
bool finite_params(const api::RenderEffect& e) {
  return std::ranges::all_of(e.params, [](const api::RenderEffectParam& p) {
    return std::isfinite(p.number) && std::ranges::all_of(p.numbers, [](double v) { return std::isfinite(v); });
  });
}

std::optional<FxReach> reach_of(const Fx& fx, std::string_view t, const PxBox& in, const FxBoundsView& view) {
  if (t == "blur" || t == "glow" || t == "drop-shadow") {
    const double radiusPx = fx.num("radiusPx");
    const double rPx = t == "glow" ? radiusPx * 1.15 : radiusPx;
    const double spreadPx = t == "blur" ? 0 : fx.num("spreadPx");
    // The spread: sdf-dilate.wgsl lights a texel within spread + 1 of an inside
    // texel's centre; stroke.wgsl's alpha dilation scans a disc of the spread.
    const double dilate = spreadPx > 0 ? spreadPx + 1 + kTapSlack : 0;
    double blur = blur_reach(rPx);
    // The glow's wide pass at 2.2 × the radius (drawn when the pool has a third free target).
    if (t == "glow" && rPx >= 6) blur = std::max(blur, blur_reach(rPx * 2.2));
    // The dilated, blurred silhouette; blur and glow lay it with the contents.
    const PxBox halo = grow(in, dilate + blur, dilate + blur);
    if (t != "drop-shadow") return FxReach{halo, halo};
    // The shadow is that silhouette moved by the offset (world units), sampled at
    // a fractional texel offset, under the contents.
    const PxBox shadow = grow(shift(halo, fx.num("offsetX") * view.pxPerWorldX, fx.num("offsetY") * view.pxPerWorldY), 1, 1);
    const PxBox out = unite(in, shadow);
    return FxReach{unite(halo, out), out};
  }
  if (t == "gaussian-blur" || t == "fast-box-blur") {
    // dims 1: horizontal only, 2: vertical only (blur.wgsl along one axis each).
    const double dims = fx.num("dims");
    const double r = blur_reach(fx.num("radiusPx"));
    return spread(in, dims != 2 ? r : 0, dims != 1 ? r : 0);
  }
  if (t == "deep-glow") {
    // deep-glow-blur.wgsl: 33 taps a whole `step` apart, once per axis and
    // octave; each octave blurs the one before, so the reaches add up. With no
    // third free pool target the chain runs one octave: the larger of the two.
    const double octaves = fx.num("octaves");
    if (octaves > kMaxDeepGlowOctaves) return std::nullopt;
    const auto chroma = fx.nums("chroma");
    const auto aspect = fx.nums("aspect");
    const double maxChroma = chroma.size() > 2 ? std::max({chroma[0], chroma[1], chroma[2]}) : 1;
    const double ax = aspect.size() > 1 ? aspect[0] : 1;
    const double ay = aspect.size() > 1 ? aspect[1] : 1;
    double rx = 0;
    double ry = 0;
    for (const double k : {octaves, 1.0}) {
      double sx = 0;
      double sy = 0;
      for (const DeepGlowOctave& o : deep_glow_octaves(fx.num("radiusPx"), k)) {
        sx += 16 * deep_glow_step(o.delta * ax * maxChroma);
        sy += 16 * deep_glow_step(o.delta * ay * maxChroma);
      }
      rx = std::max(rx, sx);
      ry = std::max(ry, sy);
    }
    return spread(in, rx + kTapSlack, ry + kTapSlack);
  }
  // Per-texel entries whose result is zero wherever their input is: the fill
  // fade and silhouette copy, textured-srgb-grade / lut-textured-linear /
  // fill / gradient-ramp / fractal-noise (all × the input's alpha), noise.wgsl
  // (returns a transparent texel unchanged).
  if (t == "fill-opacity" || t == "color-matrix" || t == "channel-lut" || t == "fill" || t == "noise" || t == "gradient-ramp" ||
      t == "fractal-noise") {
    return same(in);
  }
  // sharpen.wgsl: the four neighbours one texel out (its alpha stays, its colour
  // goes negative beside an edge — a non-zero texel).
  if (t == "sharpen") return spread(in, 1 + kTapSlack, 1 + kTapSlack);
  if (t == "stroke") {
    // stroke-sdf.wgsl lights a texel within width + 1 of an inside texel's centre;
    // stroke.wgsl scans a disc of the width (at most 64 texels).
    const double w = std::max(0.0, fx.num("widthPx")) + 1 + kTapSlack;
    return spread(in, w, w);
  }
  if (t == "inner-shadow" || t == "inner-glow" || t == "satin" || t == "bevel" || t == "cartoon") {
    // A Gaussian copy of the layer (blur.wgsl, sigmaPx), then interior-style /
    // satin / bevel / cartoon / style-fill.wgsl, which return the input texel
    // wherever the layer (or its fill-opacity silhouette) has no alpha.
    const double b = blur_reach(fx.num("sigmaPx"));
    return FxReach{grow(in, b, b), in};
  }
  // Program E (effects_spatial_c.cpp): `reachPx` 0 = a per-pixel effect whose
  // result is transparent wherever its input is. A reach past the input is in
  // layer px, which this view does not convert: not measured.
  if (fx.has("reachPx") && fx.num("reachPx") == 0) return same(in);
  return std::nullopt;
}

}  // namespace

std::optional<FxReach> fx_reach(const api::RenderEffect& e, const PxBox& in, const FxBoundsView& view) {
  if (!finite_params(e)) return std::nullopt;
  const Fx fx(e);
  std::optional<FxReach> r = reach_of(fx, fx.type(), in, view);
  if (r && (has_nan(r->passes) || has_nan(r->out))) return std::nullopt;
  return r;
}

std::optional<PxBox> content_box(const api::Renderable& r, const Mat3& viewProjection, double width, double height) {
  // emitLayerTexture draws a deformed mesh's own vertices, which may leave the quad.
  if (r.deformed_mesh) return std::nullopt;
  constexpr double kInf = std::numeric_limits<double>::infinity();
  PxBox box{kInf, kInf, -kInf, -kInf};
  bool bounded = true;
  const auto add = [&](const std::vector<double>& model) {
    const Mat3 m = mul(viewProjection, mat3_of(model));  // the mvp the content draw uploads
    for (const auto& [u, v] : std::array<std::pair<double, double>, 4>{{{0, 0}, {1, 0}, {0, 1}, {1, 1}}}) {
      const double x = m[0] * u + m[3] * v + m[6];
      const double y = m[1] * u + m[4] * v + m[7];
      const double w = m[2] * u + m[5] * v + m[8];
      // The vertex stage's clip w: a corner at or behind the eye has no bounded image.
      if (!(w > 1e-9)) {
        bounded = false;
        return;
      }
      const double px = (x / w + 1) * 0.5 * width;
      const double py = (1 - y / w) * 0.5 * height;
      box = {std::min(box.x0, px), std::min(box.y0, py), std::max(box.x1, px), std::max(box.y1, py)};
    }
  };
  add(r.model_matrix);
  for (const auto& s : r.motion_samples) add(s.model_matrix);
  if (!bounded || !std::isfinite(box.x0) || !std::isfinite(box.y0) || !std::isfinite(box.x1) || !std::isfinite(box.y1)) {
    return std::nullopt;
  }
  // Whole texels, plus one each side for the float32 corners the GPU rasterizes.
  return PxBox{std::floor(box.x0) - 1, std::floor(box.y0) - 1, std::ceil(box.x1) + 1, std::ceil(box.y1) + 1};
}

std::array<std::uint32_t, 4> scissor_of(const PxBox& b, std::uint32_t width, std::uint32_t height) {
  // NaN and anything below 0 clamp to 0, anything past the buffer to its edge.
  const auto edge = [](double v, std::uint32_t limit) -> std::uint32_t {
    if (!(v > 0)) return 0;
    if (v >= limit) return limit;
    return static_cast<std::uint32_t>(v);
  };
  const std::uint32_t x0 = edge(std::floor(b.x0), width);
  const std::uint32_t y0 = edge(std::floor(b.y0), height);
  const std::uint32_t x1 = edge(std::ceil(b.x1), width);
  const std::uint32_t y1 = edge(std::ceil(b.y1), height);
  return {x0, y0, x1 > x0 ? x1 - x0 : 0, y1 > y0 ? y1 - y0 : 0};
}

std::vector<DeepGlowOctave> deep_glow_octaves(double radius, double octaves) {
  const int k = std::max(1, static_cast<int>(std::floor(octaves + 0.5)));
  std::vector<DeepGlowOctave> out;
  double prev = 0;
  for (int i = 0; i < k; ++i) {
    const double sigma = radius / std::pow(2.0, k - 1 - i);
    out.push_back({sigma, std::sqrt(std::max(0.0, sigma * sigma - prev * prev))});
    prev = sigma;
  }
  return out;
}

double deep_glow_step(double sigma) { return std::max(1.0, std::ceil((4 * sigma) / 16)); }

}  // namespace premation::rg
