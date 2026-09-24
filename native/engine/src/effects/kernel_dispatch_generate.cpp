// E4 second batch: effect type + the TS kernel's argument names → kernel, for
// the path / paint effects, the generators and the round-seven kernels. Array
// arguments (packed mask paths, brush trails, LUT tables) come through
// `lists`; see kernel_dispatch.hpp. The TS twin of this table is
// src/core/effects/__testHelpers__/nativeKernels.ts.
#include <array>
#include <string>
#include <vector>

#include "kernel_dispatch.hpp"

namespace premation::effects {

namespace {

constexpr std::array<std::string_view, 19> kGenerate{
    "path-stroke", "scribble",     "write-on",          "star-burst",  "snowfall",        "rainfall",
    "light-burst", "cc-tiler",     "ripple-pulse",      "radial-scale-wipe", "glass-wipe", "image-wipe",
    "particle-systems", "cc-bubbles", "bezier-warp",    "cell-pattern", "apply-color-lut", "deep-glow",
    "beam-path",
};

}  // namespace

std::span<const std::string_view> generate_kernels() noexcept { return kGenerate; }

bool run_generate_kernel(std::string_view type, const KernelArgs& a, const KernelLists& lists, RgbaView img,
                         ThreadPool* pool) {
  const auto b = [&](std::string_view k, bool def) { return a(k, def ? 1 : 0) != 0; };
  const auto rgb = [&](std::string_view name, Rgb def) {
    std::string k(name);
    const std::size_t n = k.size();
    k += 'R';
    const double r = a(k, def.r);
    k[n] = 'G';
    const double g = a(k, def.g);
    k[n] = 'B';
    return Rgb{r, g, a(k, def.b)};
  };
  const auto masks = [&] {
    const std::vector<double> meta = lists("maskPathsMeta");
    const std::vector<double> xy = lists("maskPathsXY");
    return unpack_mask_paths(meta, xy, img.w, img.h);
  };
  if (type == "path-stroke") {
    const PathStrokeOptions o{rgb("color", {255, 255, 255}), a("brushSize", 10), a("hardness", 75),
                              a("opacity", 100),              a("start", 0),       a("end", 100),
                              a("spacing", 15),               a("paintStyle", 0),  b("sequential", false)};
    path_stroke(img, pick_mask_paths(masks(), b("allMasks", false), a("pathMaskIndex", 0)), o, pool);
  } else if (type == "scribble") {
    ScribbleOptions o;
    o.mode = a("mode", 0);
    o.fill_type = a("fillType", 0);
    o.edge_width = a("edgeWidth", 10);
    o.end_cap = a("endCap", 1);
    o.join = a("join", 1);
    o.miter_limit = a("miterLimit", 4);
    o.rgb = rgb("color", {255, 255, 255});
    o.opacity = a("opacity", 100);
    o.angle = a("angle", 45);
    o.stroke_width = a("strokeWidth", 2);
    o.curviness = a("curviness", 50);
    o.curviness_variation = a("curvinessVariation", 0);
    o.spacing = a("spacing", 5);
    o.spacing_variation = a("spacingVariation", 0);
    o.path_overlap = a("pathOverlap", 0);
    o.path_overlap_variation = a("pathOverlapVariation", 0);
    o.start = a("start", 0);
    o.end = a("end", 100);
    o.sequential = b("sequential", true);
    o.seed = a("seed", 0);
    o.wiggle_state = a("wiggleState", 0);
    o.smooth_wiggle = b("smoothWiggle", false);
    o.composite = a("composite", 0);
    const std::vector<MaskPolyline> all = masks();
    scribble(img, all, pick_mask_paths(all, false, a("pathMaskIndex", 0)), o, pool);
  } else if (type == "write-on" && js::round(a("mode", 0)) != 0) {
    // Classic Line / Path: a resolved mask polyline switches the geometry.
    const std::vector<double> flat = lists("pathPoints");
    if (flat.size() >= 4) {
      write_on_path(img, flat, a("completion", 100), a("brushSize", 8), rgb("color", {255, 255, 255}), a("taper", 0),
                    pool);
    } else {
      write_on_line(img, a("startX", -100), a("startY", 0), a("endX", 100), a("endY", 0), a("completion", 100),
                    a("brushSize", 8), rgb("color", {255, 255, 255}), a("wobble", 0), a("taper", 0), pool);
    }
  } else if (type == "write-on") {
    WriteOnTrail trail{lists("brushTrailXY"), lists("brushTrailSize"), lists("brushTrailAttr"), b("filled", false)};
    WriteOnBrushOptions o;
    o.brush_x = a("brushX", 0);
    o.brush_y = a("brushY", 0);
    o.rgb = rgb("color", {255, 255, 255});
    o.size = a("size", 8);
    o.hardness = a("hardness", 75);
    o.opacity = a("opacity", 100);
    o.paint_time_props = a("paintTimeProps", 0);
    o.brush_time_props = a("brushTimeProps", 0);
    o.paint_style = a("paintStyle", 0);
    write_on_brush(img, trail, o, pool);
  } else if (type == "star-burst") {
    star_burst(img, a("phase", 0), a("amount", 50), a("size", 2), rgb("color", {255, 255, 255}), a("blend", 0),
               a("seed", 0), pool);
  } else if (type == "snowfall") {
    snowfall(img, a("amount", 50), a("size", 2), a("evolution", 0), a("wind", 0), a("opacity", 100),
             rgb("color", {255, 255, 255}), a("seed", 0), pool);
  } else if (type == "rainfall") {
    rainfall(img, a("amount", 50), a("length", 20), a("angle", 10), a("evolution", 0), a("opacity", 60),
             rgb("color", {207, 230, 255}), a("seed", 0), pool);
  } else if (type == "light-burst") {
    light_burst(img, a("centerX", 0), a("centerY", 0), a("intensity", 100), a("rayLength", 50), pool);
  } else if (type == "cc-tiler") {
    cc_tiler(img, a("scale", 100), a("centerX", 0), a("centerY", 0), a("blendWithOriginal", 0), pool);
  } else if (type == "ripple-pulse") {
    ripple_pulse(img, a("centerX", 0), a("centerY", 0), a("pulseRadius", 0), a("amplitude", 40), a("width", 60),
                 b("renderBump", true), pool);
  } else if (type == "radial-scale-wipe") {
    radial_scale_wipe(img, a("completion", 0), a("centerX", 0), a("centerY", 0), b("reverse", false), pool);
  } else if (type == "glass-wipe") {
    glass_wipe(img, a("completion", 0), a("displacement", 40), a("softness", 30), pool);
  } else if (type == "image-wipe") {
    image_wipe(img, a("completion", 0), a("borderSoftness", 20), a("gradientChannel", 0), b("invertGradient", false),
               pool);
  } else if (type == "particle-systems") {
    ParticleOptions o;
    o.birth_rate = a("birthRate", 10);
    o.longevity = a("longevity", 2);
    o.producer_x = a("producerX", 0);
    o.producer_y = a("producerY", 0);
    o.producer_radius_x = a("producerRadiusX", 5);
    o.producer_radius_y = a("producerRadiusY", 5);
    o.animation = a("animation", 0);
    o.direction = a("direction", 0);
    o.spread = a("spread", 30);
    o.velocity = a("velocity", 50);
    o.velocity_variation = a("velocityVariation", 20);
    o.gravity = a("gravity", 0);
    o.resistance = a("resistance", 0);
    o.birth_size = a("birthSize", 4);
    o.death_size = a("deathSize", 1);
    o.size_variation = a("sizeVariation", 0);
    o.birth = rgb("birth", {255, 226, 122});
    o.death = rgb("death", {255, 59, 0});
    o.opacity = a("opacity", 100);
    o.blend = a("blend", 0);
    o.seed = a("seed", 0);
    particle_systems(img, a("time", 0), o, pool);
  } else if (type == "cc-bubbles") {
    BubbleOptions o;
    o.amount = a("bubbleAmount", 100);
    o.speed = a("bubbleSpeed", 300);
    o.wobble_amplitude = a("wobbleAmplitude", 10);
    o.wobble_frequency = a("wobbleFrequency", 2);
    o.size = a("bubbleSize", 12);
    o.size_variation = a("sizeVariation", 40);
    o.shading = a("shading", 0);
    o.color = rgb("color", {255, 255, 255});
    o.opacity = a("opacity", 80);
    o.evolution = a("evolution", 0);
    o.seed = a("seed", 1);
    bubbles(img, o, pool);
  } else if (type == "bezier-warp") {
    // The rest configuration plus the effect's twelve offsets (applyBezierWarp).
    static constexpr std::array<std::string_view, 12> kNames{
        "topLeft", "top1",    "top2",       "topRight", "right1", "right2",
        "bottomRight", "bottom1", "bottom2", "bottomLeft", "left1", "left2"};
    std::array<Pt2, 12> pts = bezier_warp_rest(img.w, img.h);
    for (std::size_t i = 0; i < 12; ++i) {
      const std::string k(kNames[i]);
      pts[i].x = pts[i].x + a(k + "X", 0);
      pts[i].y = pts[i].y + a(k + "Y", 0);
    }
    bezier_warp(img, pts, pool);
  } else if (type == "cell-pattern") {
    cell_pattern(img, a("size", 40), a("evolution", 0), a("contrast", 100), b("invert", false), b("membrane", false),
                 pool);
  } else if (type == "apply-color-lut") {
    const std::vector<double> data = lists("lut");
    const std::vector<double> dmin = lists("domainMin");
    const std::vector<double> dmax = lists("domainMax");
    apply_color_lut(img, a("size", 0), a("size1d", 0), data, dmin, dmax, a("intensity", 1), pool);
  } else if (type == "deep-glow") {
    DeepGlowSettings s;
    s.radius = a("radius", 20);
    s.gain = a("gain", 1);
    s.threshold = a("threshold", 0);
    s.aspect_x = a("aspectX", 1);
    s.aspect_y = a("aspectY", 1);
    s.chroma = rgb("chroma", {1, 1, 1});
    s.tint = rgb("tint", {1, 1, 1});
    s.tint_amount = a("tintAmount", 0);
    s.glow_only = b("glowOnly", false);
    s.dither = b("dither", true);
    s.octaves = a("octaves", 6);
    deep_glow(img, s, pool);
  } else if (type == "beam-path") {
    BeamPathOptions o;
    o.start_x = a("startX", -100);
    o.start_y = a("startY", 0);
    o.end_x = a("endX", 100);
    o.end_y = a("endY", 0);
    o.core_width = a("coreWidth", 6);
    o.core_softness = a("coreSoftness", 0.3);
    o.core_color = rgb("coreColor", {1, 1, 1});
    o.glow_color = rgb("glowColor", {0.05, 0.4, 1});
    o.glow_spread = a("glowSpread", 8);
    o.glow_intensity = a("glowIntensity", 1);
    o.glow_exponent = a("glowExponent", 2);
    o.start = a("start", 0);
    o.end = a("end", 1);
    o.start_size = a("startSize", 1);
    o.end_size = a("endSize", 1);
    o.distortion = a("distortion", 0);
    o.distortion_scale = a("distortionScale", 40);
    o.evolution = a("evolution", 0);
    o.composite = a("composite", 0);
    o.flicker = a("flicker", 1);
    const std::vector<double> flat = lists("pathPoints");
    beam_path(img, flat, o, pool);
  } else {
    return false;
  }
  return true;
}

}  // namespace premation::effects
