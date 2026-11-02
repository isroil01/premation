// extractSpatialEffects, part X: the deep effects of docs/PROGRAM_DEEP_EFFECTS.md
// (Program X, 2026-10-19). Each is an `fx-graph` chain entry — a list of passes
// over named slots (render_graph/fx_graph.hpp) drawn with fxx-*.wgsl shaders —
// written here from the effect's controls. Lengths are layer px (the graph
// scales them with the layer and the viewer); colours are linear light unless
// named display. A point control is an offset from the layer's centre.
#include <algorithm>
#include <array>
#include <cmath>
#include <string>
#include <string_view>
#include <vector>

#include "deep_fx_params.hpp"
#include "deep_fx_scene.hpp"
#include "effects_port.hpp"
#include "effects_spatial.hpp"
#include "fx_graph_writer.hpp"
#include "fxstate.hpp"
#include "text_port.hpp"

namespace premation::scene {
namespace {

using namespace deepfx;  // NOLINT(google-build-using-namespace): the packers' vocabulary
using fxg::Graph;
using fxg::Rows;
using Out = std::vector<api::RenderEffect>;

constexpr auto kHandled = std::to_array<std::string_view>({
    // Batch 1 — light, paint, analysis.
    "lens-bloom",
    "shine",
    "image-flares",
    "painterly",
    "watercolor",
    "ink-outline",
    "detail-upscale",
    "paint-bucket",
    // Batch 2 — other layers & masks.
    "light-wrap",
    "refraction",
    "compound-arithmetic",
    "color-link",
    "inner-outer-key",
    "energy-saber",
    "ps-arbitrary-map",
    "edge-rays",
    // Batch 3 — the immersive (VR) suite.
    "vr-blur",
    "vr-chromatic-aberrations",
    "vr-converter",
    "vr-denoise",
    "vr-fractal-noise",
    "vr-glow",
    "vr-plane-to-sphere",
    "vr-sharpen",
    // Batch 4 — camera, lights, depth.
    "volumetric-lights",
    "relight",
    "volumetric-clouds",
    "starfield",
    "cc-environment",
    "ocean",
    "aurora",
    "stroke-3d",
    // Batch 5 — time (X1).
    "timewarp",
    "pixel-motion-blur",
    "time-displacement",
    "time-difference",
    "time-blend",
    "light-trails",
    "datamosh",
    "temporal-denoise",
    // Batch 6 - simulation (X2) and closed-form particle systems.
    "fluid-ink",
    "reaction-diffusion",
    "crystal-growth",
    "mr-mercury",
    "foam",
    "hair",
    "rain-on-glass",
    "particle-world",
    // Batch 7 - analysis & transitions.
    "warp-stabilizer",
    "match-grain",
    "color-stabilizer",
    "camera-shake-deblur",
    "burn-dissolve",
    "liquid-morph",
    "bend-it",
    "bender",
    // Batch 8 - on an Object Matte.
    "matte-stroke",
    "selective-color-ai",
    "object-matte",
    // Stream D - liquid & glass.
    "goo",
});

/// The deep effects whose pixels move with the layer clock (`time`) — kept as
/// small as effects.ts TIME_DEPENDENT (a member re-renders every frame).
constexpr auto kClock =
    std::to_array<std::string_view>({"energy-saber", "volumetric-clouds", "starfield", "ocean", "aurora", "timewarp", "datamosh", "fluid-ink",
                                     "reaction-diffusion", "crystal-growth", "mr-mercury", "foam", "rain-on-glass", "particle-world", "match-grain"});

struct Box {
  double lw;
  double lh;
};

/// A highlight threshold control (a fraction, 0..4) as linear light: up to
/// 100 % it is a display brightness, past it an HDR (32-bit) level.
double threshold_lin(double f) {
  const double t = clampd(f, 0, 4);
  return t <= 1 ? s2l(t) : t;
}

// ── Lens Bloom ────────────────────────────────────────────────────────────────
// Prefilter at half resolution (13-tap Karis-weighted downsample + soft-knee
// threshold), a quarter-resolution base, five progressively blurred levels
// accumulated (tent upsample) into a float target, then composited with dirt.
api::RenderEffect lens_bloom(const Params& P, Box b) {
  Graph g("lens-bloom", b.lw, b.lh);
  const double thr = threshold_lin(P.pct("threshold"));
  const double knee = clampd(P.pct("knee"), 0, 1);
  const double clampMax = std::max(1.0, P.pct("clamp"));
  const V3 tint = P.l3("tint", {1, 1, 1});
  g.pass("fxx-bloom-pre", fxg::H0, {fxg::IN, -1, -1, -1},
         Rows().r(thr, knee, clampMax, clampd(P.pct("saturation"), 0, 2)).c3(tint));
  g.pass("fxx-bloom-down", fxg::Q0, {fxg::H0, -1, -1, -1}, Rows());
  const double radius = std::max(1.0, P.n("radius"));
  const double ana = clampd(P.n("anamorphic") / 100, -1, 1);
  const double ax = std::pow(2.0, 2 * ana);
  const double ay = std::pow(2.0, -2 * ana);
  const double bias = clampd(P.n("spread") / 100, -1, 1);
  constexpr int kLevels = 6;  // the half-resolution core + five quarter levels
  std::array<double, kLevels> w{};
  double sum = 0;
  for (int k = 0; k < kLevels; ++k) {
    w.at(static_cast<std::size_t>(k)) = std::pow(2.0, bias * 1.5 * (k - (kLevels - 1) / 2.0));
    sum += w.at(static_cast<std::size_t>(k));
  }
  const double gain = std::max(0.0, P.pct("intensity"));
  // Level 0: the half-resolution core (crisp highlights), sigma R/48.
  {
    const double s = std::max(1.5, radius / 48);
    g.blurxy(fxg::H0, fxg::H0, s * ax, s * ay, fxg::H1);
    const double k = w[0] / sum * gain;
    g.pass("fxx-bloom-acc", fxg::X0, {fxg::H0, -1, -1, -1}, Rows().r(k, k, k, 0), fxg::kReplace);
  }
  double prev = 0;
  for (int k = 1; k < kLevels; ++k) {
    const double sigma = radius / std::pow(2.0, kLevels - 1 - k);
    const double delta = std::sqrt(std::max(0.0, sigma * sigma - prev * prev));
    prev = sigma;
    g.blurxy(fxg::Q0, fxg::Q0, delta * ax, delta * ay, fxg::Q1);
    const double wk = w.at(static_cast<std::size_t>(k)) / sum * gain;
    g.pass("fxx-bloom-acc", fxg::X0, {fxg::Q0, -1, -1, -1}, Rows().r(wk, wk, wk, 0), fxg::kAdd, fxg::kKeep);
  }
  const std::string dirt = P.layer("dirtLayer");
  if (!dirt.empty()) g.map(0, dirt);
  g.pass("fxx-bloom-comp", fxg::A, {fxg::IN, fxg::X0, dirt.empty() ? fxg::IN : fxg::MAP, -1},
         Rows().r(P.e("mode"), std::max(0.0, P.pct("dirtAmount")), dirt.empty() ? 0.0 : 1.0, 0));
  return g.done(fxg::A);
}

// ── Shine ─────────────────────────────────────────────────────────────────────
// Source light (threshold × angular shimmer) at half resolution, then three
// radial passes of eight taps each toward the source point — the offsets of
// the three compose to 512 evenly spaced taps along every ray — then colorize
// by ray intensity and composite.
api::RenderEffect shine(const Params& P, Box b) {
  Graph g("shine", b.lw, b.lh);
  const double sx = b.lw / 2 + P.n("sourceX");
  const double sy = b.lh / 2 + P.n("sourceY");
  const double phase = P.n("shimmerPhase") / 360;
  g.pass("fxx-shine-src", fxg::H0, {fxg::IN, -1, -1, -1},
         Rows()
             .r(sx, sy, clampd(P.pct("threshold"), 0, 1), std::max(0.001, P.pct("thresholdSoftness")))
             .r(clampd(P.pct("shimmerAmount"), 0, 1), std::max(1.0, P.n("shimmerDetail")), phase, P.e("seed"))
             .r(P.e("baseOn"), 0, 0, 0));
  const double len = clampd(P.pct("rayLength"), 0, 1) * 0.98;
  const double decay = clampd(P.pct("decay"), 0, 1) * 6;
  const std::array<double, 3> scales{len, len / 8, len / 64};
  const std::array<int, 4> pp{fxg::H0, fxg::H1, fxg::H0, fxg::H1};
  for (std::size_t k = 0; k < 3; ++k) {
    g.pass("fxx-shine-ray", pp.at(k + 1), {pp.at(k), -1, -1, -1}, Rows().r(sx, sy, scales.at(k), decay));
  }
  // The ramp: 5 stops (display colour, position); the presets are fixed ramps.
  std::array<V3, 5> stops{P.u3("shadows"), P.u3("midLow"), P.u3("midtones"), P.u3("midHigh"), P.u3("highlights")};
  const int cz = P.e("colorize");
  if (cz == 2) stops = {P.u3("shadows"), P.u3("shadows"), P.u3("midtones"), P.u3("highlights"), P.u3("highlights")};
  if (cz == 4) stops = {V3{0.08, 0, 0}, V3{0.55, 0.05, 0}, V3{1, 0.35, 0}, V3{1, 0.75, 0.2}, V3{1, 1, 0.85}};
  if (cz == 5) stops = {V3{0.02, 0, 0.12}, V3{0.1, 0.05, 0.6}, V3{0.2, 0.45, 1}, V3{0.6, 0.85, 1}, V3{1, 1, 1}};
  if (cz == 6) stops = {V3{0.05, 0.12, 0.1}, V3{0.1, 0.45, 0.4}, V3{0.45, 0.85, 0.75}, V3{0.85, 1, 0.95}, V3{1, 1, 1}};
  if (cz == 1) stops = {P.u3("highlights"), P.u3("highlights"), P.u3("highlights"), P.u3("highlights"), P.u3("highlights")};
  Rows rows;
  rows.r(cz, std::max(0.0, P.n("boostLight")), clampd(P.pct("shineOpacity"), 0, 1), clampd(P.pct("sourceOpacity"), 0, 1));
  rows.r(P.e("mode"), clampd(P.pct("edgeThickness"), 0.01, 1), 0, 0);
  for (std::size_t k = 0; k < 5; ++k) rows.c3(stops.at(k), static_cast<double>(k) / 4);
  g.pass("fxx-shine-comp", fxg::A, {fxg::IN, fxg::H1, -1, -1}, rows);
  return g.done(fxg::A);
}

// ── Image Flares ──────────────────────────────────────────────────────────────
api::RenderEffect image_flares(const Params& P, Box b) {
  Graph g("image-flares", b.lw, b.lh);
  const double thr = threshold_lin(P.pct("threshold"));
  g.pass("fxx-flare-pre", fxg::H0, {fxg::IN, -1, -1, -1}, Rows().r(thr, 0.25, 64, 0));
  const double cx = 0.5 + P.n("centerX") / b.lw;
  const double cy = 0.5 + P.n("centerY") / b.lh;
  g.pass("fxx-flare-ghost", fxg::H1, {fxg::H0, -1, -1, -1},
         Rows()
             .r(std::clamp(static_cast<double>(P.e("ghosts")), 0.0, 12.0), clampd(P.pct("dispersal"), 0.01, 1), clampd(P.pct("ghostSize"), 0.01, 3),
                clampd(P.pct("chroma"), 0, 2))
             .r(std::max(0.0, P.pct("halo")), clampd(P.pct("haloWidth"), 0.01, 1), clampd(P.pct("rainbow"), 0, 1), 0)
             .r(cx, cy, 0, 0));
  const double soft = std::max(0.5, P.n("softness"));
  g.blur(fxg::H1, fxg::H1, soft, fxg::H0);
  const std::string dirt = P.layer("dirtLayer");
  if (!dirt.empty()) g.map(0, dirt);
  g.pass("fxx-flare-comp", fxg::A, {fxg::IN, fxg::H1, dirt.empty() ? fxg::IN : fxg::MAP, -1},
         Rows()
             .r(P.e("mode"), std::max(0.0, P.pct("intensity")), dirt.empty() ? 0.0 : std::max(0.0, P.pct("dirtAmount")), 0)
             .r(std::max(0.0, P.pct("starburst")), std::max(2.0, static_cast<double>(P.e("starPoints"))), cx, cy));
  return g.done(fxg::A);
}

// ── Painterly (anisotropic Kuwahara) ──────────────────────────────────────────
api::RenderEffect painterly(const Params& P, Box b) {
  Graph g("painterly", b.lw, b.lh);
  g.pass("fxx-tensor", fxg::X0, {fxg::IN, -1, -1, -1}, Rows());
  const double smooth = std::max(0.0, P.n("flowSmoothing"));
  if (smooth > 0) g.blur(fxg::X0, fxg::X0, smooth, fxg::X1);
  g.pass("fxx-kuwahara", fxg::A, {fxg::IN, fxg::X0, -1, -1},
         Rows()
             .r(std::max(1.0, P.n("brushSize")), std::max(0.01, P.pct("anisotropy")), clampd(P.n("sharpness"), 1, 18), static_cast<double>(std::max(0, P.e("levels"))))
             .r(clampd(P.pct("saturation"), 0, 3), clampd(P.pct("detail"), 0, 1), clampd(P.pct("blend"), 0, 1), 0));
  return g.done(fxg::A);
}

// ── Watercolor ────────────────────────────────────────────────────────────────
api::RenderEffect watercolor(const Params& P, Box b) {
  Graph g("watercolor", b.lw, b.lh);
  const double abst = std::max(0.0, P.n("abstraction"));
  int abstracted = fxg::IN;
  if (abst > 0) {
    g.pass("fxx-bilateral", fxg::X0, {fxg::IN, -1, -1, -1}, Rows().r(abst, 0.18, 0, 0));
    abstracted = fxg::X0;
  }
  g.blur(fxg::X1, abstracted, std::max(0.5, P.n("bleed")), fxg::X2);
  const V3 paper = P.u3("paperColor", {0.965, 0.945, 0.902});
  g.pass("fxx-watercolor", fxg::A, {abstracted, fxg::X1, fxg::IN, -1},
         Rows()
             .r(clampd(P.pct("wetness"), 0, 1), std::max(0.0, P.pct("edgeDarkening")), std::max(0.0, P.pct("pigment")), std::max(2.0, P.n("pigmentScale")))
             .r(std::max(0.0, P.pct("granulation")), std::max(0.0, P.n("tremor")), std::max(0.0, P.pct("paper")), std::max(0.5, P.n("paperScale")))
             .c3(paper, P.on("onPaper") ? 1.0 : 0.0)
             .r(P.e("seed"), 0, 0, 0));
  return g.done(fxg::A);
}

// ── Ink & Toon (XDoG) ─────────────────────────────────────────────────────────
api::RenderEffect ink_outline(const Params& P, Box b) {
  Graph g("ink-outline", b.lw, b.lh);
  const double smooth = std::max(0.0, P.n("smoothing"));
  int fill = fxg::IN;
  if (smooth > 0) {
    g.pass("fxx-bilateral", fxg::X0, {fxg::IN, -1, -1, -1}, Rows().r(smooth, 0.12, 0, 0));
    fill = fxg::X0;
  }
  const double s = std::max(0.3, P.n("lineWeight"));
  g.blur(fxg::X1, fxg::IN, s, fxg::A);
  g.blur(fxg::X2, fxg::IN, s * 1.6, fxg::A);
  const V3 line = P.l3("lineColor", {0.08, 0.08, 0.08});
  g.pass("fxx-toon", fxg::B, {fill, fxg::X1, fxg::X2, fxg::IN},
         Rows()
             .r(std::max(1.0, P.n("lineSharpness")), P.pct("lineThreshold") * 0.2, clampd(P.pct("detail"), 0.5, 1), clampd(P.pct("lineOpacity"), 0, 1))
             .c3(line, clampd(P.pct("fillOpacity"), 0, 1))
             .r(std::max(2.0, static_cast<double>(P.e("levels"))), clampd(P.pct("saturation"), 0, 3), clampd(P.pct("halftone"), 0, 1), std::max(2.0, P.n("halftoneSize")))
             .r(P.rad("halftoneAngle"), 0, 0, 0));
  return g.done(fxg::B);
}

// ── Detail-preserving Upscale ─────────────────────────────────────────────────
api::RenderEffect detail_upscale(const Params& P, Box b) {
  Graph g("detail-upscale", b.lw, b.lh);
  const double scale = clampd(P.pct("scale"), 1, 10);
  int src = fxg::IN;
  if (P.pct("reduceNoise") > 0) {
    g.pass("fxx-bilateral", fxg::X0, {fxg::IN, -1, -1, -1}, Rows().r(1.5, 0.02 + 0.2 * clampd(P.pct("reduceNoise"), 0, 1), 0, 0));
    src = fxg::X0;
  }
  g.pass("fxx-upscale", fxg::X1, {src, -1, -1, -1}, Rows().r(scale, P.e("alpha"), 0, 0));
  const double detail = clampd(P.pct("detail"), 0, 1);
  if (detail <= 0) return g.done(fxg::X1);
  g.blur(fxg::X2, fxg::X1, 0.45 * scale, fxg::A);
  g.pass("fxx-upscale-detail", fxg::B, {fxg::X1, fxg::X2, -1, -1}, Rows().r(detail, 0, 0, 0));
  return g.done(fxg::B);
}

// ── Paint Bucket ──────────────────────────────────────────────────────────────
// Mask + seed at quarter resolution, connected by alternating row / column
// sweeps (each lights a masked texel that reaches a filled one along the row
// within 48 texels), then the full-resolution matte, its edge, the fill.
api::RenderEffect paint_bucket(const Params& P, Box b) {
  Graph g("paint-bucket", b.lw, b.lh);
  const double fx = b.lw / 2 + P.n("fillPointX");
  const double fy = b.lh / 2 + P.n("fillPointY");
  const double tol = clampd(P.pct("tolerance"), 0, 1);
  const Rows sel = Rows().r(fx, fy, tol, P.e("selector"));
  g.pass("fxx-bucket-seed", fxg::Q0, {fxg::IN, -1, -1, -1}, sel);
  constexpr int kSweeps = 24;
  int cur = fxg::Q0;
  for (int k = 0; k < kSweeps; ++k) {
    const int next = cur == fxg::Q0 ? fxg::Q1 : fxg::Q0;
    g.pass("fxx-bucket-sweep", next, {cur, -1, -1, -1}, Rows().r(k % 2, 48, 0, 0));
    cur = next;
  }
  g.pass("fxx-bucket-matte", fxg::X0, {fxg::IN, cur, -1, -1}, Rows().r(fx, fy, tol, P.e("selector")).r(P.on("invert") ? 1 : 0, 0, 0, 0));
  const int mode = P.e("strokeMode");
  const double width = std::max(0.0, P.n("strokeWidth"));
  const double sigma = mode == 0 ? 0.6 : mode == 1 ? std::max(0.5, P.n("feather")) : std::max(0.5, width * 0.5);
  g.blur(fxg::X1, fxg::X0, sigma, fxg::X2);
  const V3 c = P.l3("color", {0.8, 0.2, 0.15});
  g.pass("fxx-bucket-comp", fxg::A, {fxg::IN, fxg::X1, fxg::X0, -1},
         Rows().r(mode, width, P.on("viewThreshold") ? 1 : 0, P.e("blending")).c3(c, clampd(P.pct("opacity"), 0, 1)));
  return g.done(fxg::A);
}

// ── Batch 2: other layers & masks ────────────────────────────────────────────

/// What a packer may read besides its controls: the effect (its id keys its
/// textures) and the layer (its masks).
struct Ctx {
  const Json& e;
  const RLayer& l;
};

std::string effect_id(const Json& e) { return e.at("id").is_string() ? e.at("id").str() : std::string(); }

/// The layer mask path a maskPath control names; `firstWhenEmpty`: an empty
/// control means the layer's first mask (AE's "Mask 1"). Null = none.
const Json* mask_path(const RLayer& l, const Params& P, std::string_view key, bool firstWhenEmpty) {
  if (!l.mask.is_object() || !l.mask.at("paths").is_array()) return nullptr;
  const std::string id = P.layer(key);
  for (const Json& m : l.mask.at("paths").arr()) {
    if (id.empty() && firstWhenEmpty) return &m;
    if (!id.empty() && m.at("id").is_string() && m.at("id").str() == id) return &m;
  }
  return nullptr;
}

std::string data_key(const Ctx& c, std::string_view what) {
  std::string k = "fxdata:";
  k += c.l.id;
  k += ':';
  k += effect_id(c.e);
  k += ':';
  k += what;
  return k;
}

api::RenderEffect light_wrap(const Params& P, Box b) {
  Graph g("light-wrap", b.lw, b.lh);
  const std::string bg = P.layer("backgroundLayer");
  if (!bg.empty()) g.map(0, bg);
  g.blur(fxg::X0, bg.empty() ? fxg::IN : fxg::MAP, std::max(0.0, P.n("backgroundBlur")), fxg::X1);
  g.blur(fxg::X1, fxg::IN, std::max(0.5, P.n("wrapWidth") * 0.5), fxg::A);
  g.pass("fxx-lightwrap", fxg::B, {fxg::IN, fxg::X0, fxg::X1, -1},
         Rows().r(std::max(0.0, P.pct("intensity")), clampd(P.n("lumaBias") / 100, -1, 1), P.e("mode"), P.on("wrapOnly") ? 1 : 0)
             .r(bg.empty() ? 0 : 1, 0, 0, 0));
  return g.done(fxg::B);
}

api::RenderEffect refraction(const Params& P, Box b) {
  Graph g("refraction", b.lw, b.lh);
  const std::string hl = P.layer("heightLayer");
  if (!hl.empty()) g.map(0, hl);
  g.pass("fxx-height", fxg::X0, {hl.empty() ? fxg::IN : fxg::MAP, -1, -1, -1}, Rows().r(P.e("heightSource"), P.on("invertHeight") ? 1 : 0, 0, 0));
  if (P.n("smoothness") > 0) g.blur(fxg::X0, fxg::X0, P.n("smoothness"), fxg::X1);
  // Stream D: Source: Backdrop — the picture refracted is the scene under the
  // layer (its own height still shapes the surface), cut by the layer's alpha.
  const bool fromBackdrop = P.e("source") == 1;
  if (fromBackdrop) g.backdrop();
  int src = fromBackdrop ? fxg::BACKDROP : fxg::IN;
  if (P.n("frost") > 0) {
    g.blur(fxg::X1, src, P.n("frost"), fxg::A);
    src = fxg::X1;
  }
  const double az = P.rad("lightAngle");
  const double el = clampd(P.rad("lightElevation"), 0, kPi / 2);
  g.pass("fxx-refract", fxg::B, {fxg::IN, fxg::X0, src, -1},
         Rows()
             .r(std::max(0.0, P.n("depth")), clampd(P.n("ior"), 1, 3), std::max(0.0, P.pct("dispersion")), std::max(0.0, P.pct("specular")))
             .r(std::cos(az) * std::cos(el), std::sin(az) * std::cos(el), std::sin(el), std::max(1.0, P.n("shininess")))
             .r(fromBackdrop ? 1 : 0, 0, 0, 0));
  return g.done(fxg::B);
}

// ── Goo (stream D L3, 2026-11-02) ─────────────────────────────────────────────
// The metaball / "gooey" filter as an engine effect: the layer blurred, its
// alpha thresholded (soft) so nearby shapes fuse into one blob, then the blob
// shaded from its alpha distance field (op 4): a dome normal — flat inside,
// sideways at the edge, over `dome` px — lit by a direction, with a Blinn
// highlight and a Fresnel rim in the highlight colour. Colour is the blurred
// layer's own (merged blobs blend) or a tint. On a precomp of many blobs or,
// with L1, on a masked adjustment layer over the scene.
api::RenderEffect goo(const Params& P, Box b) {
  Graph g("goo", b.lw, b.lh);
  const double blur = std::max(0.0, P.n("blur"));
  int src = fxg::IN;
  if (blur > 0) {
    g.blur(fxg::X0, fxg::IN, blur, fxg::X1);
    src = fxg::X0;
  }
  g.pass("fxx-goo-shape", fxg::A, {src, fxg::IN, -1, -1},
         Rows().r(clampd(P.pct("threshold"), 0.01, 1), clampd(P.pct("softness"), 0, 1), P.e("color"), 0).c3(P.l3("tint", {0.03, 0.55, 1})));
  const double dome = P.n("dome") > 0 ? P.n("dome") : std::max(4.0, blur);
  g.field(fxg::X1, fxg::A, dome + 2);
  const double az = P.rad("lightAngle");
  const double el = clampd(P.rad("lightElevation"), 0, kPi / 2);
  g.pass("fxx-goo-shade", fxg::B, {fxg::A, fxg::X1, -1, -1},
         Rows()
             .r(dome, std::max(0.0, P.pct("shine")), std::max(1.0, P.n("shininess")), std::max(0.0, P.pct("rim")))
             .r(std::cos(az) * std::cos(el), std::sin(az) * std::cos(el), std::sin(el), clampd(P.pct("ambient"), 0, 2))
             .c3(P.l3("highlight", {1, 1, 1})));
  // The blurred alpha (blur.wgsl: taps to 3.5 sigma) is all that can light a
  // texel past the input; the field and the shading stay inside the shape.
  g.measured();
  return g.done(fxg::B, blur > 0 ? blur * 3.5 + 3 : 0.0);
}

api::RenderEffect compound_arithmetic(const Params& P, Box b) {
  Graph g("compound-arithmetic", b.lw, b.lh);
  const std::string second = P.layer("secondLayer");
  if (!second.empty()) g.map(0, second);
  g.pass("fxx-compound", fxg::A, {fxg::IN, second.empty() ? fxg::IN : fxg::MAP, -1, -1},
         Rows().r(P.e("operator"), P.e("channels"), P.e("overflow"), clampd(P.pct("blend"), 0, 1)));
  return g.done(fxg::A, 0.0);
}

api::RenderEffect color_link(const Params& P, Box b) {
  Graph g("color-link", b.lw, b.lh);
  const std::string src = P.layer("sourceLayer");
  if (!src.empty()) g.map(0, src);
  const int sample = P.e("sample");
  // 256 columns × 64 rows of taps reduced to a strip, the strip to one colour
  // (at quarter resolution, where every texel holds the same answer).
  g.pass("fxx-colorlink-strip", fxg::STRIP, {src.empty() ? fxg::IN : fxg::MAP, -1, -1, -1}, Rows().r(sample, 0, 0, 0));
  g.pass("fxx-colorlink-reduce", fxg::Q0, {fxg::STRIP, -1, -1, -1}, Rows().r(sample, 0, 0, 0));
  g.pass("fxx-colorlink", fxg::A, {fxg::IN, fxg::Q0, -1, -1},
         Rows().r(sample, P.on("stencilAlpha") ? 1 : 0, clampd(P.pct("opacity"), 0, 1), P.e("blending")));
  return g.done(fxg::A);
}

api::RenderEffect inner_outer_key(const Params& P, Box b, const Ctx& c) {
  Graph g("inner-outer-key", b.lw, b.lh);
  const Json* fg = mask_path(c.l, P, "foregroundMask", true);
  const Json* bg = mask_path(c.l, P, "backgroundMask", false);
  if (fg != nullptr) g.mask(0, scope_mask_key(c.l.id, fg->at("id").is_string() ? fg->at("id").str() : ""));
  const bool two = bg != nullptr && bg != fg;
  if (two) g.mask(1, scope_mask_key(c.l.id, bg->at("id").is_string() ? bg->at("id").str() : ""));
  const double radius = std::max(1.0, P.n("highlightRadius"));
  // The zone: r = surely foreground, g = surely background.
  if (two) {
    g.pass("fxx-iokey-zone", fxg::X2, {fxg::MASK0, fxg::MASK1, -1, -1}, Rows().r(1, 0, 0, 0));
  } else {
    g.blur(fxg::X3, fxg::MASK0, radius * 0.5, fxg::A);
    g.pass("fxx-iokey-zone", fxg::X2, {fxg::X3, fxg::X3, -1, -1}, Rows().r(0, 0, 0, 0));
  }
  // Local foreground / background colours: normalized convolution of the sure zones.
  const double reach = std::max(2.0, P.n("colorReach"));
  g.pass("fxx-iokey-prep", fxg::X0, {fxg::IN, fxg::X2, -1, -1}, Rows().r(0, 0, 0, 0));
  g.blur(fxg::X0, fxg::X0, reach, fxg::A);
  g.pass("fxx-iokey-prep", fxg::X1, {fxg::IN, fxg::X2, -1, -1}, Rows().r(1, 0, 0, 0));
  g.blur(fxg::X1, fxg::X1, reach, fxg::A);
  g.pass("fxx-iokey", fxg::B, {fxg::IN, fxg::X0, fxg::X1, fxg::X2},
         Rows().r(clampd(P.pct("edgeThreshold"), 0, 0.99), P.on("invert") ? 1 : 0, clampd(P.pct("blend"), 0, 1), 0));
  const double feather = std::max(0.0, P.n("edgeFeather"));
  if (feather <= 0) return g.done(fxg::B);
  g.blur(fxg::X3, fxg::B, feather, fxg::A);
  g.pass("fxx-alpha-from", fxg::C, {fxg::B, fxg::X3, -1, -1}, Rows());
  return g.done(fxg::C);
}

api::RenderEffect energy_saber(const Params& P, Box b, const Ctx& c) {
  Graph g("energy-saber", b.lw, b.lh);
  const bool alphaCore = P.e("coreType") == 1;
  const double t = P.n("time");
  if (!alphaCore) g.data(data_key(c, "path"));
  const double start = clampd(P.pct("startOffset"), 0, 1);
  const double end = clampd(P.pct("endOffset"), 0, 1);
  g.pass("fxx-saber-core", fxg::X0, {fxg::IN, alphaCore ? fxg::IN : fxg::DATA, -1, -1},
         Rows()
             .r(alphaCore ? 1 : 0, std::max(0.0, P.n("coreSize")), clampd(P.pct("coreSoftness"), 0, 1), P.e("seed"))
             .r(std::min(start, end), std::max(start, end), P.pct("offset"), 0)
             .r(std::max(0.0, P.n("distortion")), std::max(1.0, P.n("distortionScale")), t * P.n("distortionSpeed"), 0)
             .r(clampd(P.pct("flicker"), 0, 1), t * P.n("flickerSpeed"), 0, 0));
  // The glow: the core spread through a pyramid (as Lens Bloom), its shape
  // from Glow Spread (the widest level) and Glow Bias (tight vs wide).
  g.copy(fxg::H0, fxg::X0);
  g.pass("fxx-bloom-down", fxg::Q0, {fxg::H0, -1, -1, -1}, Rows());
  const double spread = std::max(4.0, P.pct("glowSpread") * 120);
  const double bias = clampd(P.n("glowBias") / 100, -1, 1);
  constexpr int kLevels = 5;
  std::array<double, kLevels> w{};
  double sum = 0;
  for (int k = 0; k < kLevels; ++k) {
    w.at(static_cast<std::size_t>(k)) = std::pow(2.0, bias * 1.5 * (k - (kLevels - 1) / 2.0));
    sum += w.at(static_cast<std::size_t>(k));
  }
  const double gain = std::max(0.0, P.pct("glowIntensity")) * 4;
  g.blur(fxg::H0, fxg::H0, std::max(1.0, spread / 32), fxg::H1);
  g.pass("fxx-bloom-acc", fxg::X1, {fxg::H0, -1, -1, -1}, Rows().r(w[0] / sum * gain, w[0] / sum * gain, w[0] / sum * gain, 0));
  double prev = 0;
  for (int k = 1; k < kLevels; ++k) {
    const double sigma = spread / std::pow(2.0, kLevels - 1 - k);
    const double delta = std::sqrt(std::max(0.0, sigma * sigma - prev * prev));
    prev = sigma;
    g.blur(fxg::Q0, fxg::Q0, delta, fxg::Q1);
    const double wk = w.at(static_cast<std::size_t>(k)) / sum * gain;
    g.pass("fxx-bloom-acc", fxg::X1, {fxg::Q0, -1, -1, -1}, Rows().r(wk, wk, wk, 0), fxg::kAdd, fxg::kKeep);
  }
  g.pass("fxx-saber-comp", fxg::A, {fxg::IN, fxg::X0, fxg::X1, -1},
         Rows().c3(P.l3("coreColor", {1, 1, 1}), P.e("composite")).c3(P.l3("glowColor", {0.03, 0.26, 1}), 0));
  return g.done(fxg::A);
}

api::RenderEffect ps_arbitrary_map(const Params& P, Box b, const Ctx& c) {
  Graph g("ps-arbitrary-map", b.lw, b.lh);
  g.data(data_key(c, "map"));
  double phase = P.n("phase") / 360;
  phase -= std::floor(phase);
  g.pass("fxx-arbitrary-map", fxg::A, {fxg::IN, fxg::DATA, -1, -1}, Rows().r(phase, P.on("applyToAlpha") ? 1 : 0, 0, 0));
  return g.done(fxg::A, 0.0);
}

api::RenderEffect edge_rays(const Params& P, Box b) {
  Graph g("edge-rays", b.lw, b.lh);
  const double sx = b.lw / 2 + P.n("centerX");
  const double sy = b.lh / 2 + P.n("centerY");
  const bool tint = P.e("colorMode") == 1;
  g.pass("fxx-edgerays-src", fxg::H0, {fxg::IN, -1, -1, -1},
         Rows()
             .r(sx, sy, std::max(0.5, P.n("edgeWidth")), clampd(P.pct("threshold"), 0, 1))
             .r(clampd(P.pct("shimmerAmount"), 0, 1), std::max(1.0, P.n("shimmerDetail")), P.n("shimmerPhase") / 360, P.e("seed"))
             .c3(tint ? P.l3("tint", {1, 0.65, 0.2}) : V3{-1, -1, -1}, P.e("edgeSource")));
  const double len = clampd(P.pct("rayLength"), 0, 1) * 0.98;
  const double decay = clampd(P.pct("falloff"), 0, 1) * 6;
  const std::array<double, 3> scales{len, len / 8, len / 64};
  const std::array<int, 4> pp{fxg::H0, fxg::H1, fxg::H0, fxg::H1};
  for (std::size_t k = 0; k < 3; ++k) g.pass("fxx-shine-ray", pp.at(k + 1), {pp.at(k), -1, -1, -1}, Rows().r(sx, sy, scales.at(k), decay));
  g.pass("fxx-shine-comp", fxg::A, {fxg::IN, fxg::H1, -1, -1}, Rows().r(0, std::max(0.0, P.n("intensity")), 1, 1).r(P.e("mode"), 1, 0, 0));
  return g.done(fxg::A);
}

// ── Batch 3: the immersive (VR) suite ─────────────────────────────────────────

/// A sphere rotation from pan (about y), tilt (about x) and roll (about z), as
/// three rows: d' = R d, R = Rz(roll) Rx(tilt) Ry(pan).
std::array<V3, 3> sphere_rotation(double pan, double tilt, double roll) {
  const double cp = std::cos(pan), sp = std::sin(pan);
  const double ct = std::cos(tilt), st = std::sin(tilt);
  const double cr = std::cos(roll), sr = std::sin(roll);
  const std::array<V3, 3> ry{V3{cp, 0, sp}, V3{0, 1, 0}, V3{-sp, 0, cp}};
  const std::array<V3, 3> rx{V3{1, 0, 0}, V3{0, ct, -st}, V3{0, st, ct}};
  const std::array<V3, 3> rz{V3{cr, -sr, 0}, V3{sr, cr, 0}, V3{0, 0, 1}};
  const auto mul = [](const std::array<V3, 3>& a, const std::array<V3, 3>& b) {
    std::array<V3, 3> r{};
    for (std::size_t i = 0; i < 3; ++i) {
      for (std::size_t j = 0; j < 3; ++j) r.at(i).at(j) = a.at(i)[0] * b[0].at(j) + a.at(i)[1] * b[1].at(j) + a.at(i)[2] * b[2].at(j);
    }
    return r;
  };
  return mul(rz, mul(rx, ry));
}

/// A spherical Gaussian: along the latitude rows (widened by 1 / cos latitude),
/// then along the meridians.
void vr_blur_into(Graph& g, int out, int in, int tmp, int layout, double sigma, bool repeatEdges) {
  g.pass("fxx-vr-blur", tmp, {in, -1, -1, -1}, Rows().r(layout, sigma, 0, repeatEdges ? 1 : 0));
  g.pass("fxx-vr-blur", out, {tmp, -1, -1, -1}, Rows().r(layout, sigma, 1, repeatEdges ? 1 : 0));
}

api::RenderEffect vr_blur(const Params& P, Box b) {
  Graph g("vr-blur", b.lw, b.lh);
  vr_blur_into(g, fxg::A, fxg::IN, fxg::X0, P.e("frameLayout"), std::max(0.0, P.n("blurriness")), P.on("repeatEdges"));
  return g.done(fxg::A);
}

api::RenderEffect vr_chromatic(const Params& P, Box b) {
  Graph g("vr-chromatic-aberrations", b.lw, b.lh);
  const double k = kPi / 180 * 0.25;  // an aberration unit: a quarter degree on the sphere
  g.pass("fxx-vr-ca", fxg::A, {fxg::IN, -1, -1, -1},
         Rows().r(P.e("frameLayout"), P.n("red") * k, P.n("green") * k, P.n("blue") * k).r(P.rad("centerPan"), P.rad("centerTilt"), clampd(P.pct("falloff"), 0, 1), P.on("reverseFalloff") ? 1 : 0));
  return g.done(fxg::A);
}

api::RenderEffect vr_converter(const Params& P, Box b) {
  Graph g("vr-converter", b.lw, b.lh);
  const auto r = sphere_rotation(P.rad("pan"), P.rad("tilt"), P.rad("roll"));
  g.pass("fxx-vr-convert", fxg::A, {fxg::IN, -1, -1, -1},
         Rows().r(P.e("sourceLayout"), P.e("outputLayout"), clampd(P.rad("fov"), 0.05, 3.0), P.on("seamless") ? 1 : 0).c3(r[0]).c3(r[1]).c3(r[2]));
  return g.done(fxg::A);
}

api::RenderEffect vr_denoise(const Params& P, Box b) {
  Graph g("vr-denoise", b.lw, b.lh);
  g.pass("fxx-vr-denoise", fxg::A, {fxg::IN, -1, -1, -1},
         Rows().r(P.e("frameLayout"), std::max(0.001, P.pct("noiseLevel") * 0.25), clampd(P.n("searchRadius"), 1, 20), clampd(P.pct("detail"), 0, 1)));
  return g.done(fxg::A);
}

api::RenderEffect vr_fractal_noise(const Params& P, Box b) {
  Graph g("vr-fractal-noise", b.lw, b.lh);
  const auto r = sphere_rotation(P.rad("pan"), P.rad("tilt"), 0);
  g.pass("fxx-vr-noise", fxg::A, {fxg::IN, -1, -1, -1},
         Rows()
             .r(P.e("frameLayout"), P.e("fractalType"), P.on("invert") ? 1 : 0, std::max(0.0, P.pct("contrast")))
             .r(P.n("brightness") / 100, clampd(P.pct("scale"), 0.01, 20), clampd(P.n("complexity"), 1, 10), P.n("evolution") / 360)
             .r(P.e("seed"), clampd(P.pct("opacity"), 0, 1), P.e("blending"), 0)
             .c3(r[0])
             .c3(r[1])
             .c3(r[2]));
  return g.done(fxg::A, 0.0);
}

api::RenderEffect vr_glow(const Params& P, Box b) {
  Graph g("vr-glow", b.lw, b.lh);
  const int layout = P.e("frameLayout");
  g.pass("fxx-flare-pre", fxg::H0, {fxg::IN, -1, -1, -1}, Rows().r(s2l(clampd(P.pct("threshold"), 0, 1)), 0.3, 64, 0));
  const double radius = std::max(1.0, P.n("radius"));
  const std::array<double, 3> sig{radius * 0.25, radius * 0.5, radius};
  for (std::size_t k = 0; k < 3; ++k) {
    vr_blur_into(g, fxg::Q0, fxg::H0, fxg::H1, layout, sig.at(k), true);
    const double w = 1.0 / 3.0;
    g.pass("fxx-bloom-acc", fxg::X0, {fxg::Q0, -1, -1, -1}, Rows().r(w, w, w, 0), k == 0 ? fxg::kReplace : fxg::kAdd, k == 0 ? 0U : fxg::kKeep);
  }
  const V3 tint = P.on("tintEnable") ? P.l3("tint", {1, 1, 1}) : V3{1, 1, 1};
  g.pass("fxx-vr-glow-comp", fxg::A, {fxg::IN, fxg::X0, -1, -1},
         Rows().r(std::max(0.0, P.pct("brightness")) * 2, clampd(P.pct("saturation"), 0, 2), 0, 0).c3(tint));
  return g.done(fxg::A);
}

api::RenderEffect vr_plane_to_sphere(const Params& P, Box b) {
  Graph g("vr-plane-to-sphere", b.lw, b.lh);
  // The inverse rotation (its transpose): output direction → plane space.
  const auto r = sphere_rotation(P.rad("pan"), P.rad("tilt"), P.rad("roll"));
  g.pass("fxx-vr-plane", fxg::A, {fxg::IN, -1, -1, -1},
         Rows()
             .r(std::tan(clampd(P.rad("fov"), 0.01, 3.1) / 2), std::max(0.01, P.pct("aspect")), clampd(P.pct("feather"), 0, 0.5), 0)
             .r(r[0][0], r[1][0], r[2][0])
             .r(r[0][1], r[1][1], r[2][1])
             .r(r[0][2], r[1][2], r[2][2]));
  return g.done(fxg::A);
}

api::RenderEffect vr_sharpen(const Params& P, Box b) {
  Graph g("vr-sharpen", b.lw, b.lh);
  vr_blur_into(g, fxg::X1, fxg::IN, fxg::X0, P.e("frameLayout"), std::max(0.3, P.n("radius")), true);
  g.pass("fxx-vr-sharpen", fxg::A, {fxg::IN, fxg::X1, -1, -1}, Rows().r(std::max(0.0, P.pct("amount")), clampd(P.pct("threshold"), 0, 1), 0, 0));
  return g.done(fxg::A);
}

// ── Batch 4: camera, lights, depth ────────────────────────────────────────────
// Each reads the scene table (DATA: camera then lights, scene_data below).

api::RenderEffect volumetric_lights(const Params& P, Box b, const Ctx& c) {
  Graph g("volumetric-lights", b.lw, b.lh);
  g.data(data_key(c, "scene"));
  const bool shadows = P.on("shadows");
  g.pass("fxx-vol-lights", fxg::H0, {fxg::IN, fxg::DATA, -1, -1},
         Rows()
             .r(std::max(0.0, P.pct("density")), clampd(P.pct("scattering"), -0.95, 0.95), std::max(100.0, P.n("maxDistance")), clampd(P.pct("noise"), 0, 1))
             .r(std::max(10.0, P.n("noiseScale")), P.n("evolution") / 360, clampd(P.n("quality"), 8, 96), P.e("seed"))
             .r(shadows ? 1 : 0, 0, 0, 0),
         fxg::kReplace, fxg::kDepth);
  g.blur(fxg::H0, fxg::H0, 1.5, fxg::H1);
  g.pass("fxx-light-comp", fxg::A, {fxg::IN, fxg::H0, -1, -1}, Rows().c3(P.l3("tint", {1, 1, 1}), std::max(0.0, P.pct("intensity"))).r(P.e("mode"), 0, 0, 0));
  return g.done(fxg::A);
}

api::RenderEffect relight(const Params& P, Box b, const Ctx& c) {
  Graph g("relight", b.lw, b.lh);
  g.data(data_key(c, "scene"));
  const int from = P.e("normalsFrom");
  const std::string nl = P.layer("normalLayer");
  int heightSrc = fxg::IN;
  if (from == 2 && !nl.empty()) {
    g.map(0, nl);
    heightSrc = fxg::MAP;
  }
  // Height (or the normal map itself) smoothed into X0.
  g.pass("fxx-height", fxg::X0, {heightSrc, -1, -1, -1}, Rows().r(from == 1 ? 1 : 0, 0, 0, 0));
  if (from != 2 && P.n("smoothness") > 0) g.blur(fxg::X0, fxg::X0, P.n("smoothness"), fxg::X1);
  const double az = P.rad("lightAngle");
  const double el = clampd(P.rad("lightElevation"), 0, kPi / 2);
  g.pass("fxx-relight", fxg::A, {fxg::IN, fxg::DATA, from == 2 && !nl.empty() ? fxg::MAP : fxg::X0, -1},
         Rows()
             .r(from == 2 && !nl.empty() ? 1 : 0, std::max(0.0, P.n("depth")), std::max(0.0, P.pct("diffuse")), clampd(P.pct("wrap"), 0, 1))
             .r(std::max(0.0, P.pct("specular")), std::max(1.0, P.n("shininess")), clampd(P.pct("ambient"), 0, 1), P.e("fallbackType"))
             .r(std::cos(az) * std::cos(el), std::sin(az) * std::cos(el), -std::sin(el), 0)
             .c3(P.l3("lightColor", {1, 1, 1})));
  return g.done(fxg::A, 0.0);
}

api::RenderEffect volumetric_clouds(const Params& P, Box b, const Ctx& c) {
  Graph g("volumetric-clouds", b.lw, b.lh);
  g.data(data_key(c, "scene"));
  const double t = P.n("time");
  const double wd = P.rad("windDirection");
  const double ws = P.n("windSpeed") * t;
  const double az = P.rad("sunAzimuth");
  const double el = P.rad("sunElevation");
  g.pass("fxx-clouds", fxg::H0, {fxg::IN, fxg::DATA, -1, -1},
         Rows()
             .r(clampd(P.pct("coverage"), 0, 1), std::max(0.0, P.pct("density")), P.n("altitude"), std::max(10.0, P.n("thickness")))
             .r(std::max(10.0, P.n("scale")), clampd(P.n("detail"), 1, 8), std::cos(wd) * ws, std::sin(wd) * ws)
             .r(std::cos(el) * std::sin(az), -std::sin(el), std::cos(el) * std::cos(az), P.on("useLight") ? 1 : 0)
             .c3(P.l3("sunColor", {1, 0.95, 0.86}), clampd(P.n("quality"), 12, 128))
             .c3(P.l3("skyColor", {0.27, 0.45, 0.8}), P.e("seed"))
             .r(t * 0.02, 0, 0, 0));
  g.pass("fxx-sky-comp", fxg::A, {fxg::IN, fxg::H0, -1, -1}, Rows().r(P.e("composite"), 0, 0, 0));
  return g.done(fxg::A);
}

api::RenderEffect starfield(const Params& P, Box b, const Ctx& c) {
  Graph g("starfield", b.lw, b.lh);
  g.data(data_key(c, "scene"));
  g.pass("fxx-starfield", fxg::B, {fxg::IN, fxg::DATA, -1, -1},
         Rows()
             .r(std::max(0.0, P.pct("density")), std::max(0.2, P.n("starSize")), std::max(0.0, P.pct("brightness")), clampd(P.pct("colorVariation"), 0, 1))
             .r(clampd(P.pct("twinkle"), 0, 1), P.n("time"), std::max(500.0, P.n("depthRange")), P.e("seed"))
             .r(std::max(0.0, P.pct("nebula")), std::max(100.0, P.n("nebulaScale")), 0, 0)
             .c3(P.l3("nebulaColor1", {0.1, 0.02, 0.24}))
             .c3(P.l3("nebulaColor2", {0.01, 0.16, 0.36})));
  g.pass("fxx-sky-comp", fxg::A, {fxg::IN, fxg::B, -1, -1}, Rows().r(P.e("composite") == 0 ? 1 : P.e("composite") == 1 ? 0 : 2, 0, 0, 0));
  return g.done(fxg::A);
}

api::RenderEffect cc_environment(const Params& P, Box b, const Ctx& c) {
  Graph g("cc-environment", b.lw, b.lh);
  g.data(data_key(c, "scene"));
  const std::string env = P.layer("environment");
  if (!env.empty()) g.map(0, env);
  int envSlot = env.empty() ? fxg::IN : fxg::MAP;
  if (P.n("filter") > 0) {
    g.blur(fxg::X1, envSlot, P.n("filter"), fxg::X2);
    envSlot = fxg::X1;
  }
  g.pass("fxx-height", fxg::X0, {fxg::IN, -1, -1, -1}, Rows().r(0, 0, 0, 0));
  g.pass("fxx-environment", fxg::A, {fxg::IN, fxg::DATA, envSlot, fxg::X0},
         Rows().r(P.e("mapping"), P.rad("horizontalOffset"), std::max(0.0, P.n("bump")), clampd(P.pct("reflectivity"), 0, 1)).r(clampd(P.pct("fresnel"), 0, 1), env.empty() ? 0 : 1, 0, 0));
  return g.done(fxg::A, 0.0);
}

api::RenderEffect ocean(const Params& P, Box b, const Ctx& c) {
  Graph g("ocean", b.lw, b.lh);
  g.data(data_key(c, "scene"));
  const double az = P.rad("sunAzimuth");
  const double el = P.rad("sunElevation");
  const double wd = P.rad("windDirection");
  g.pass("fxx-ocean", fxg::B, {fxg::IN, fxg::DATA, -1, -1},
         Rows()
             .r(P.n("seaLevel"), std::max(0.0, P.n("waveHeight")), std::max(10.0, P.n("waveLength")), clampd(P.pct("choppiness"), 0, 1))
             .r(std::cos(wd), std::sin(wd), P.n("time") * P.n("speed"), P.e("seed"))
             .c3(P.l3("deepColor", {0.004, 0.02, 0.05}), clampd(P.pct("foam"), 0, 2))
             .c3(P.l3("shallowColor", {0.015, 0.16, 0.2}), std::max(100.0, P.n("fogDistance")))
             .c3(P.l3("skyTop", {0.025, 0.1, 0.33}), P.on("showSky") ? 1 : 0)
             .c3(P.l3("skyHorizon", {0.58, 0.72, 0.84}))
             .c3(P.l3("sunColor", {1, 0.87, 0.63}))
             .r(std::cos(el) * std::sin(az), -std::sin(el), std::cos(el) * std::cos(az), 0));
  g.pass("fxx-sky-comp", fxg::A, {fxg::IN, fxg::B, -1, -1}, Rows().r(0, 0, 0, 0));
  return g.done(fxg::A);
}

api::RenderEffect aurora(const Params& P, Box b, const Ctx& c) {
  Graph g("aurora", b.lw, b.lh);
  g.data(data_key(c, "scene"));
  g.pass("fxx-aurora", fxg::H0, {fxg::IN, fxg::DATA, -1, -1},
         Rows()
             .r(std::max(0.0, P.pct("intensity")), P.n("altitude"), std::max(100.0, P.n("height")), std::max(50.0, P.n("scale")))
             .r(P.n("time") * P.n("speed"), clampd(P.n("quality"), 12, 96), P.e("seed"), std::max(0.0, P.pct("stars")))
             .c3(P.l3("lowColor", {0.04, 1, 0.33}))
             .c3(P.l3("highColor", {0.45, 0.07, 1})));
  g.pass("fxx-sky-comp", fxg::A, {fxg::IN, fxg::H0, -1, -1}, Rows().r(P.e("composite") == 0 ? 1 : P.e("composite") == 1 ? 0 : 2, 0, 0, 0));
  return g.done(fxg::A);
}

api::RenderEffect stroke_3d(const Params& P, Box b, const Ctx& c) {
  Graph g("stroke-3d", b.lw, b.lh);
  g.data(data_key(c, "stroke"));
  g.pass("fxx-stroke3d", fxg::A, {fxg::IN, fxg::DATA, -1, -1},
         Rows()
             .c3(P.l3("color", {0.5, 0.83, 1}), clampd(P.pct("feather"), 0, 1))
             .r(clampd(P.pct("start"), 0, 1), clampd(P.pct("end"), 0, 1), P.pct("offset"), P.on("loop") ? 1 : 0)
             .r(clampd(P.pct("taperStart"), 0, 1), clampd(P.pct("taperEnd"), 0, 1), P.on("depthFade") ? 1 : 0, P.e("composite")));
  return g.done(fxg::A);
}

// ── Batch 5: time (X1) ────────────────────────────────────────────────────────

double fps_of(const Params& P) { return P.n("__fps") > 0 ? P.n("__fps") : 30.0; }

/// Timewarp's source instant in frames: Speed × layer time, or the Source Frame.
double timewarp_frame(const Params& P) {
  const double fps = fps_of(P);
  return P.e("adjustBy") == 1 ? P.n("sourceFrame") : P.n("time") * P.pct("speed") * fps;
}

/// GPU optical flow from slot `a` to slot `b` (pyramidal Lucas-Kanade: quarter
/// resolution from rest, refined at half), smoothed; the flow (buffer uv) in H1.
void flow_into(Graph& g, int a, int b, double detail) {
  const double iters = 3 + std::round(clampd(detail, 0, 1) * 3);
  g.pass("fxx-flow-luma", fxg::Q0, {a, b, -1, -1}, Rows());
  g.pass("fxx-flow-lk", fxg::Q1, {fxg::Q0, fxg::Q0, -1, -1}, Rows().r(iters, 0, 2, 0));
  g.pass("fxx-flow-luma", fxg::H0, {a, b, -1, -1}, Rows());
  g.pass("fxx-flow-lk", fxg::H1, {fxg::H0, fxg::Q1, -1, -1}, Rows().r(iters, 1, 2, 0));
  g.blur(fxg::H1, fxg::H1, 2.0 + (1 - clampd(detail, 0, 1)) * 4, fxg::H0);
}

api::RenderEffect timewarp(const Params& P, Box b, const Ctx& c) {
  Graph g("timewarp", b.lw, b.lh);
  const std::string id = effect_id(c.e);
  const int method = P.e("method");
  const double f = timewarp_frame(P);
  const double w = f - std::floor(f + 1e-6);
  g.tap(0, time_tap_id(c.l.id, id, 0));
  if (method == 0 || w < 1e-4) return g.pass("fxx-copy", fxg::A, {fxg::TAP0, -1, -1, -1}, Rows()).done(fxg::A);
  g.tap(1, time_tap_id(c.l.id, id, 1));
  if (method == 2) flow_into(g, fxg::TAP0, fxg::TAP1, P.pct("vectorDetail"));
  const double speed = P.e("adjustBy") == 1 ? 0 : std::abs(P.pct("speed"));
  g.pass("fxx-timewarp", fxg::A, {fxg::TAP0, fxg::TAP1, method == 2 ? fxg::H1 : fxg::TAP0, -1},
         Rows().r(w, method, P.on("motionBlur") ? clampd(P.n("shutterAngle") / 360, 0, 2) * speed : 0, clampd(P.n("shutterSamples"), 2, 32)));
  return g.done(fxg::A);
}

api::RenderEffect pixel_motion_blur(const Params& P, Box b, const Ctx& c) {
  Graph g("pixel-motion-blur", b.lw, b.lh);
  const std::string id = effect_id(c.e);
  g.tap(0, time_tap_id(c.l.id, id, 0));
  g.tap(1, time_tap_id(c.l.id, id, 1));
  flow_into(g, fxg::TAP0, fxg::TAP1, P.pct("vectorDetail"));
  // The flow spans two frames (before → after): half of it is a frame's motion.
  g.pass("fxx-pmb", fxg::A, {fxg::IN, fxg::H1, -1, -1}, Rows().r(clampd(P.n("shutterAngle") / 360, 0, 2) * 0.5, clampd(P.n("shutterSamples"), 2, 64), 0, 0));
  return g.done(fxg::A);
}

api::RenderEffect time_displacement(const Params& P, Box b, const Ctx& c) {
  Graph g("time-displacement", b.lw, b.lh);
  const std::string id = effect_id(c.e);
  const std::string map = P.layer("mapLayer");
  if (!map.empty()) g.map(0, map);
  for (int k = 0; k < 4; ++k) g.tap(k, time_tap_id(c.l.id, id, static_cast<std::size_t>(k)));
  const double maxT = P.n("maxDisplacement");
  const double res = std::max(1.0, P.n("timeResolution"));
  // The offset as a fraction of the maximum, quantised to the time resolution.
  const double step = maxT != 0 ? 1 / (res * std::abs(maxT)) : 0;
  const double smooth = P.on("smooth") ? 1 : 0;
  // Negative half (taps −max, −max/2 and now), then the positive (+max/2, +max).
  // No map layer: the layer's own luminance (AE's default).
  g.pass("fxx-timedisp", fxg::X0, {map.empty() ? fxg::IN : fxg::MAP, fxg::TAP0, fxg::TAP1, fxg::IN}, Rows().r(0, step, smooth, 1));
  g.pass("fxx-timedisp", fxg::A, {map.empty() ? fxg::IN : fxg::MAP, fxg::X0, fxg::TAP2, fxg::TAP3}, Rows().r(1, step, smooth, 1));
  return g.done(fxg::A);
}

api::RenderEffect time_difference(const Params& P, Box b, const Ctx& c) {
  Graph g("time-difference", b.lw, b.lh);
  g.tap(0, time_tap_id(c.l.id, effect_id(c.e), 0));
  g.pass("fxx-timediff", fxg::A, {fxg::IN, fxg::TAP0, -1, -1}, Rows().r(std::max(0.0, P.pct("contrast")), P.on("absolute") ? 1 : 0, P.e("alphaChannel"), 0));
  return g.done(fxg::A, 0.0);
}

api::RenderEffect time_blend(const Params& P, Box b, const Ctx& c) {
  Graph g("time-blend", b.lw, b.lh);
  const std::string id = effect_id(c.e);
  for (int k = 0; k < 4; ++k) g.tap(k, time_tap_id(c.l.id, id, static_cast<std::size_t>(k)));
  const Rows r = Rows().r(P.e("transfer"), clampd(P.pct("accumulation"), 0, 1), 0, 0);
  // Oldest first: the three older frames folded into X0, then the newest and the layer.
  g.pass("fxx-timeblend", fxg::X0, {fxg::TAP3, fxg::TAP2, fxg::TAP1, -1}, r);
  g.pass("fxx-timeblend", fxg::A, {fxg::X0, fxg::TAP0, fxg::IN, -1}, r);
  return g.done(fxg::A);
}

api::RenderEffect light_trails(const Params& P, Box b, const Ctx& c) {
  Graph g("light-trails", b.lw, b.lh);
  const std::string id = effect_id(c.e);
  for (int k = 0; k < 4; ++k) g.tap(k, time_tap_id(c.l.id, id, static_cast<std::size_t>(k)));
  const V3 head = P.l3("headColor", {1, 0.9, 0.55});
  const V3 tail = P.l3("tailColor", {1, 0.05, 0.2});
  const double thr = s2l(clampd(P.pct("threshold"), 0, 1));
  const double decay = clampd(P.pct("decay"), 0, 1);
  // Each pass lights three taps (their age 1..4 of 4 gives the colour and the fade).
  g.pass("fxx-trails", fxg::X0, {fxg::TAP1, fxg::TAP2, fxg::TAP3, -1}, Rows().r(thr, decay, 2, 0).c3(head).c3(tail));
  g.pass("fxx-trails-comp", fxg::A, {fxg::IN, fxg::TAP0, fxg::X0, -1},
         Rows().r(thr, decay, std::max(0.0, P.pct("intensity")), P.e("mode")).c3(head).c3(tail));
  return g.done(fxg::A);
}

api::RenderEffect datamosh(const Params& P, Box b, const Ctx& c) {
  Graph g("datamosh", b.lw, b.lh);
  const std::string id = effect_id(c.e);
  g.tap(0, time_tap_id(c.l.id, id, 0));
  g.tap(1, time_tap_id(c.l.id, id, 1));
  flow_into(g, fxg::TAP1, fxg::IN, 0.4);
  const double elapsed = std::max(0.0, (P.n("time") - P.n("holdTime")) * fps_of(P));
  g.pass("fxx-datamosh", fxg::A, {fxg::IN, fxg::TAP0, fxg::H1, -1},
         Rows().r(std::max(2.0, P.n("blockSize")), std::max(0.0, P.pct("intensity")) * std::min(elapsed, 60.0), clampd(P.pct("bleed"), 0, 1), clampd(P.pct("threshold"), 0, 1)));
  return g.done(fxg::A);
}

api::RenderEffect temporal_denoise(const Params& P, Box b, const Ctx& c) {
  Graph g("temporal-denoise", b.lw, b.lh);
  const std::string id = effect_id(c.e);
  g.tap(0, time_tap_id(c.l.id, id, 0));
  g.tap(1, time_tap_id(c.l.id, id, 1));
  flow_into(g, fxg::IN, fxg::TAP0, 0.7);
  g.copy(fxg::X0, fxg::H1);
  flow_into(g, fxg::IN, fxg::TAP1, 0.7);
  g.pass("fxx-flow-pack", fxg::X1, {fxg::X0, fxg::H1, -1, -1}, Rows());
  g.pass("fxx-tdenoise", fxg::A, {fxg::IN, fxg::TAP0, fxg::TAP1, fxg::X1}, Rows().r(clampd(P.pct("strength"), 0, 1), clampd(P.pct("detail"), 0, 1), 0, 0));
  const double spatial = clampd(P.pct("spatial"), 0, 1);
  if (spatial <= 0) return g.done(fxg::A);
  g.pass("fxx-bilateral", fxg::B, {fxg::A, -1, -1, -1}, Rows().r(1.5 + spatial * 2, 0.02 + spatial * 0.1, 0, 0));
  return g.done(fxg::B);
}

// ── Batch 6: simulation (X2) and closed-form particle systems ─────────────────

/// FNV-1a over the controls a simulation starts from (not its clock).
void hash_json(const Json& v, std::uint64_t& h) {
  const auto mix = [&](const void* p, std::size_t n) {
    const auto* b = static_cast<const unsigned char*>(p);
    for (std::size_t i = 0; i < n; ++i) {
      h ^= b[i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic): a byte walk
      h *= 1099511628211ULL;
    }
  };
  if (v.is_number()) {
    const double d = v.num();
    mix(&d, sizeof d);
  } else if (v.is_string()) {
    mix(v.str().data(), v.str().size());
  } else if (v.is_bool()) {
    const unsigned char c = v.b() ? 1 : 2;
    mix(&c, 1);
  } else if (v.is_array()) {
    for (const Json& e : v.arr()) hash_json(e, h);
  } else if (v.is_object()) {
    for (const auto& m : v.obj()) {
      if (m.key == "time" || m.key == "followCompTime" || m.key.starts_with("__")) continue;
      mix(m.key.data(), m.key.size());
      hash_json(m.value, h);
    }
  }
}
double sim_hash(const Params& P, const RLayer& l) {
  std::uint64_t h = 1469598103934665603ULL;
  hash_json(P.p, h);
  const double box[2] = {l.width, l.height};  // NOLINT(cppcoreguidelines-avoid-c-arrays): two values hashed as bytes
  hash_json(Json::number(box[0]), h);
  hash_json(Json::number(box[1]), h);
  return static_cast<double>(h >> 11U);  // exact in a double
}

/// A simulation over the layer box: `longSide` cells on its longer side.
Graph::Sim sim_of(const Params& P, Box b, const Ctx& c, double longSide, double sub, std::vector<double> state) {
  Graph::Sim s;
  s.key = "sim:" + c.l.id + ":" + effect_id(c.e);
  const double aspect = b.lw / b.lh;
  s.w = aspect >= 1 ? longSide : std::max(8.0, std::round(longSide * aspect));
  s.h = aspect >= 1 ? std::max(8.0, std::round(longSide / aspect)) : longSide;
  s.fps = fps_of(P);
  s.frame = std::max(0.0, std::floor((P.n("time") - P.n("startTime")) * s.fps + 1e-6));
  s.hash = sim_hash(P, c.l);
  s.sub = std::clamp(sub, 1.0, 64.0);
  s.every = 30;
  s.state = std::move(state);
  return s;
}

api::RenderEffect fluid_ink(const Params& P, Box b, const Ctx& c) {
  Graph g("fluid-ink", b.lw, b.lh);
  static constexpr std::array<double, 4> kRes{192, 320, 448, 640};
  g.tap(0, time_tap_id(c.l.id, effect_id(c.e), 0));
  g.sim(sim_of(P, b, c, kRes.at(static_cast<std::size_t>(std::clamp(P.e("resolution"), 0, 3))), 2, {0, 2, 5, 7}));
  const int S0 = fxg::SIM0;
  g.init_program();
  g.pass("fxx-sim-capture", S0 + 7, {fxg::TAP0, -1, -1, -1}, Rows());
  g.pass("fxx-fluid-init", S0 + 5, {S0 + 7, -1, -1, -1}, Rows().r(clampd(P.pct("dye"), 0, 2), 0, 0, 0));
  g.pass("fxx-sim-clear", S0, {fxg::IN, -1, -1, -1}, Rows());
  g.pass("fxx-sim-clear", S0 + 2, {fxg::IN, -1, -1, -1}, Rows());
  g.step_program();
  const double speed = clampd(P.n("speed"), 0.1, 8);
  const double pa = P.rad("pushAngle");
  g.pass("fxx-fluid-curl", S0 + 4, {S0, -1, -1, -1}, Rows());
  g.pass("fxx-fluid-force", S0 + 1, {S0, S0 + 4, S0 + 7, -1},
         Rows()
             .r(std::cos(pa) * P.n("pushSpeed"), std::sin(pa) * P.n("pushSpeed"), clampd(P.pct("emission"), 0, 2), std::max(0.0, P.pct("turbulence")))
             .r(std::max(5.0, P.n("turbulenceScale")), std::max(0.0, P.pct("vorticity")), clampd(P.pct("viscosity"), 0, 1), speed)
             .r(P.e("seed"), 0, 0, 0));
  g.pass("fxx-fluid-advect", S0, {S0 + 1, S0 + 1, -1, -1}, Rows().r(speed, 0, 0, 0));
  g.pass("fxx-fluid-div", S0 + 4, {S0, -1, -1, -1}, Rows());
  const int iters = std::clamp(P.e("pressureIterations"), 8, 80) / 2;
  for (int i = 0; i < iters; ++i) {
    g.pass("fxx-fluid-jacobi", S0 + 3, {S0 + 2, S0 + 4, -1, -1}, Rows());
    g.pass("fxx-fluid-jacobi", S0 + 2, {S0 + 3, S0 + 4, -1, -1}, Rows());
  }
  g.pass("fxx-fluid-project", S0 + 1, {S0, S0 + 2, -1, -1}, Rows());
  g.copy(S0, S0 + 1);
  g.pass("fxx-fluid-dye", S0 + 6, {S0 + 5, S0, S0 + 7, -1}, Rows().r(speed, clampd(P.pct("emission"), 0, 2), clampd(P.pct("dissipation"), 0, 1), 0));
  g.copy(S0 + 5, S0 + 6);
  g.graph_program();
  g.pass("fxx-fluid-render", fxg::A, {fxg::IN, S0 + 5, -1, -1}, Rows().c3(P.l3("tint", {0.02, 0.15, 1}), P.e("colorMode")).r(P.e("composite"), 0, 0, 0));
  return g.done(fxg::A);
}

api::RenderEffect reaction_diffusion(const Params& P, Box b, const Ctx& c) {
  Graph g("reaction-diffusion", b.lw, b.lh);
  static constexpr std::array<double, 4> kRes{256, 384, 512, 768};
  // Pearson's classes (Gray-Scott feed / kill).
  static constexpr std::array<std::array<double, 2>, 6> kPreset{{{0, 0}, {0.0545, 0.062}, {0.0367, 0.0649}, {0.029, 0.057}, {0.035, 0.065}, {0.078, 0.061}}};
  const int preset = std::clamp(P.e("preset"), 0, 5);
  const double f = preset == 0 ? P.n("feed") : kPreset.at(static_cast<std::size_t>(preset))[0];
  const double k = preset == 0 ? P.n("kill") : kPreset.at(static_cast<std::size_t>(preset))[1];
  g.tap(0, time_tap_id(c.l.id, effect_id(c.e), 0));
  const double steps = clampd(P.n("speed"), 1, 200);
  g.sim(sim_of(P, b, c, kRes.at(static_cast<std::size_t>(std::clamp(P.e("resolution"), 0, 3))), std::ceil(steps / 2), {0, 7}));
  const int S0 = fxg::SIM0;
  g.init_program();
  g.pass("fxx-sim-capture", S0 + 7, {fxg::TAP0, -1, -1, -1}, Rows());
  g.pass("fxx-rd-init", S0, {S0 + 7, -1, -1, -1}, Rows().r(P.e("seedFrom"), P.e("seed"), 0, 0));
  g.step_program();
  const Rows r = Rows().r(f, k, clampd(P.n("diffusionA"), 0.1, 2), clampd(P.n("diffusionB"), 0.05, 1.5)).r(clampd(P.pct("feedMap"), 0, 1), 0, 0, 0);
  g.pass("fxx-rd-step", S0 + 1, {S0, S0 + 7, -1, -1}, r);
  g.pass("fxx-rd-step", S0, {S0 + 1, S0 + 7, -1, -1}, r);
  g.graph_program();
  g.pass("fxx-rd-render", fxg::A, {fxg::IN, S0, -1, -1},
         Rows().c3(P.l3("colorA", {0.007, 0.012, 0.024}), clampd(P.pct("sharpness"), 0, 1)).c3(P.l3("colorB", {0.89, 0.81, 0.62}), P.e("composite")));
  return g.done(fxg::A);
}

api::RenderEffect crystal_growth(const Params& P, Box b, const Ctx& c) {
  Graph g("crystal-growth", b.lw, b.lh);
  static constexpr std::array<double, 4> kRes{256, 384, 512, 768};
  g.tap(0, time_tap_id(c.l.id, effect_id(c.e), 0));
  g.sim(sim_of(P, b, c, kRes.at(static_cast<std::size_t>(std::clamp(P.e("resolution"), 0, 3))), clampd(P.n("speed"), 1, 64), {0, 7}));
  const int S0 = fxg::SIM0;
  g.init_program();
  g.pass("fxx-sim-capture", S0 + 7, {fxg::TAP0, -1, -1, -1}, Rows());
  g.pass("fxx-xtal-init", S0, {S0 + 7, -1, -1, -1}, Rows());
  g.step_program();
  g.pass("fxx-xtal-aux", S0 + 2, {S0, -1, -1, -1}, Rows().r(clampd(P.pct("anisotropy"), 0, 1) * 0.08, std::round(clampd(P.n("symmetry"), 2, 12)), P.rad("angle"), 0));
  g.pass("fxx-xtal-step", S0 + 1, {S0, S0 + 2, -1, -1}, Rows().r(clampd(P.n("latentHeat"), 0.8, 3), clampd(P.pct("noise"), 0, 1), P.e("seed"), 0));
  g.copy(S0, S0 + 1);
  g.graph_program();
  g.pass("fxx-xtal-render", fxg::A, {fxg::IN, S0, -1, -1}, Rows().c3(P.l3("color", {0.6, 0.8, 1}), std::max(0.0, P.pct("glow"))).r(P.e("composite"), 0, 0, 0));
  return g.done(fxg::A);
}

api::RenderEffect mr_mercury(const Params& P, Box b) {
  Graph g("mr-mercury", b.lw, b.lh);
  const double dir = P.rad("direction");
  const double life = clampd(P.n("longevity"), 0.1, 30);
  const double rate = clampd(P.n("birthRate"), 0.5, 400);
  g.pass("fxx-mercury", fxg::A, {fxg::IN, -1, -1, -1},
         Rows()
             .r(b.lw / 2 + P.n("producerX"), b.lh / 2 + P.n("producerY"), std::max(0.0, P.n("radiusX")), std::max(0.0, P.n("radiusY")))
             .r(std::cos(dir), std::sin(dir), clampd(P.pct("spread"), 0, 1), std::max(0.0, P.n("velocity")))
             .r(rate, life, P.n("gravity"), std::max(0.0, P.pct("resistance")))
             .r(std::max(0.0, P.pct("turbulence")), std::max(1.0, P.n("birthSize")), std::max(0.0, P.n("deathSize")), std::max(0.01, P.pct("influence")))
             .r(P.n("time"), P.e("seed"), P.e("colorFrom"), P.e("composite"))
             .c3(P.l3("color", {0.53, 0.58, 0.63}), P.rad("lightAngle"))
             .r(std::max(0.0, P.pct("specular")), clampd(P.pct("reflection"), 0, 1), std::min(320.0, std::ceil(rate * life)), 0));
  return g.done(fxg::A);
}

api::RenderEffect foam(const Params& P, Box b) {
  Graph g("foam", b.lw, b.lh);
  const double wd = P.rad("windDirection");
  const double life = clampd(P.n("lifespan"), 0.2, 30);
  const double rate = clampd(P.n("birthRate"), 0.5, 200);
  g.pass("fxx-foam", fxg::A, {fxg::IN, -1, -1, -1},
         Rows()
             .r(b.lw / 2 + P.n("producerX"), b.lh / 2 + P.n("producerY"), std::max(0.0, P.n("producerWidth")), std::max(0.0, P.n("producerHeight")))
             .r(rate, life, std::max(2.0, P.n("bubbleSize")), clampd(P.pct("sizeVariance"), 0, 1))
             .r(std::max(0.0, P.pct("growth")), P.n("riseSpeed"), std::cos(wd) * P.n("windSpeed"), std::sin(wd) * P.n("windSpeed"))
             .r(std::max(0.0, P.pct("wobble")), std::max(0.0, P.pct("iridescence")), std::max(0.0, P.pct("reflection")), clampd(P.pct("opacity"), 0, 1))
             .r(P.n("time"), P.e("seed"), P.e("composite"), std::min(320.0, std::ceil(rate * life))));
  return g.done(fxg::A);
}

api::RenderEffect hair(const Params& P, Box b) {
  Graph g("hair", b.lw, b.lh);
  const double ang = P.rad("hairAngle");
  g.pass("fxx-hair", fxg::A, {fxg::IN, -1, -1, -1},
         Rows()
             .r(std::max(1.0, P.n("length")), clampd(P.pct("lengthVariance"), 0, 1), std::max(0.2, P.n("thickness")), std::max(1.5, P.n("density")))
             .r(std::cos(ang), std::sin(ang), clampd(P.pct("directionVariance"), 0, 1), P.pct("weight"))
             .r(std::max(0.0, P.pct("curl")), P.pct("wind"), P.rad("windPhase"), P.e("seed"))
             .c3(P.l3("color", {0.04, 0.017, 0.006}), P.e("colorFrom"))
             .r(P.rad("lightAngle"), std::max(0.0, P.pct("specular")), P.on("keepLayer") ? 1 : 0, 0));
  return g.done(fxg::A);
}

api::RenderEffect rain_on_glass(const Params& P, Box b) {
  Graph g("rain-on-glass", b.lw, b.lh);
  g.blur(fxg::X0, fxg::IN, std::max(0.5, P.n("fogBlur")), fxg::X1);
  g.pass("fxx-rain", fxg::A, {fxg::IN, fxg::X0, -1, -1},
         Rows()
             .r(std::max(0.0, P.pct("amount")), std::max(2.0, P.n("dropSize")), P.n("time") * P.n("speed"), clampd(P.pct("trails"), 0, 1))
             .r(clampd(P.pct("fog"), 0, 1), std::max(0.0, P.pct("refraction")), std::max(0.0, P.pct("highlight")), P.e("seed")));
  return g.done(fxg::A);
}

api::RenderEffect particle_world(const Params& P, Box b, const Ctx& c) {
  Graph g("particle-world", b.lw, b.lh);
  g.data(data_key(c, "particles"));
  g.pass("fxx-particles", fxg::A, {fxg::IN, fxg::DATA, -1, -1}, Rows().r(P.e("particleType"), P.e("composite"), 0, 0));
  return g.done(fxg::A);
}

// ── Batch 7: analysis & transitions ───────────────────────────────────────────

api::RenderEffect warp_stabilizer(const Params& P, Box b, const Ctx& c) {
  Graph g("warp-stabilizer", b.lw, b.lh);
  const std::string id = effect_id(c.e);
  for (int k = 0; k < 4; ++k) g.tap(k, time_tap_id(c.l.id, id, static_cast<std::size_t>(k)));
  // Each neighbour: the flow from this frame to it, fitted with one transform
  // (written to its own strip texel k).
  for (int k = 0; k < 4; ++k) {
    flow_into(g, fxg::IN, fxg::TAP0 + k, P.pct("vectorDetail"));
    g.pass("fxx-stab-fit", fxg::STRIP, {fxg::H1, -1, -1, -1}, Rows().r(k, P.e("method"), 0, 0), fxg::kReplace, k == 0 ? 0U : fxg::kKeep);
  }
  g.pass("fxx-stab-apply", fxg::A, {fxg::IN, fxg::STRIP, -1, -1},
         Rows().r(clampd(P.pct("strength"), 0, 1), P.e("framing"), clampd(P.pct("maxScale"), 1, 2), 0));
  return g.done(fxg::A);
}

api::RenderEffect match_grain(const Params& P, Box b) {
  Graph g("match-grain", b.lw, b.lh);
  const std::string src = P.layer("sourceLayer");
  if (!src.empty()) g.map(0, src);
  const int s = src.empty() ? fxg::IN : fxg::MAP;
  // The source's grain (its high-pass deviation per channel) and the layer's own.
  g.blur(fxg::X0, s, 1.5, fxg::X1);
  g.pass("fxx-grain-stats", fxg::STRIP, {s, fxg::X0, -1, -1}, Rows());
  g.pass("fxx-grain-reduce", fxg::Q0, {fxg::STRIP, -1, -1, -1}, Rows());
  g.blur(fxg::X2, fxg::IN, 1.5, fxg::X1);
  g.pass("fxx-grain-stats", fxg::STRIP, {fxg::IN, fxg::X2, -1, -1}, Rows());
  g.pass("fxx-grain-reduce", fxg::Q1, {fxg::STRIP, -1, -1, -1}, Rows());
  const double frame = P.on("animate") ? std::floor(P.n("time") * fps_of(P) + 1e-6) : 0;
  g.pass("fxx-grain-apply", fxg::A, {fxg::IN, fxg::Q0, fxg::Q1, -1},
         Rows()
             .r(std::max(0.0, P.pct("intensity")), std::max(0.3, P.n("size")), clampd(P.pct("softness"), 0, 1), clampd(P.n("aspect"), 0.25, 4))
             .r(P.on("compensate") ? 1 : 0, P.on("monochrome") ? 1 : 0, clampd(P.pct("saturation"), 0, 2), frame + P.e("seed") * 7919)
             .r(std::max(0.0, P.pct("shadows")), std::max(0.0, P.pct("midtones")), std::max(0.0, P.pct("highlights")), 0));
  return g.done(fxg::A, 0.0);
}

api::RenderEffect color_stabilizer(const Params& P, Box b, const Ctx& c) {
  Graph g("color-stabilizer", b.lw, b.lh);
  g.tap(0, time_tap_id(c.l.id, effect_id(c.e), 0));
  const double cx = b.lw / 2;
  const double cy = b.lh / 2;
  g.pass("fxx-colorstab-sample", fxg::STRIP, {fxg::IN, fxg::TAP0, -1, -1},
         Rows()
             .r(cx + P.n("blackPointX"), cy + P.n("blackPointY"), cx + P.n("midPointX"), cy + P.n("midPointY"))
             .r(cx + P.n("whitePointX"), cy + P.n("whitePointY"), std::max(1.0, P.n("sampleSize")), 0));
  g.pass("fxx-colorstab-apply", fxg::A, {fxg::IN, fxg::STRIP, -1, -1}, Rows().r(P.e("stabilize"), 0, 0, 0));
  return g.done(fxg::A, 0.0);
}

api::RenderEffect camera_shake_deblur(const Params& P, Box b, const Ctx& c) {
  Graph g("camera-shake-deblur", b.lw, b.lh);
  const std::string id = effect_id(c.e);
  g.tap(0, time_tap_id(c.l.id, id, 0));
  g.tap(1, time_tap_id(c.l.id, id, 1));
  flow_into(g, fxg::IN, fxg::TAP0, P.pct("detail"));
  g.copy(fxg::X0, fxg::H1);
  flow_into(g, fxg::IN, fxg::TAP1, P.pct("detail"));
  g.pass("fxx-flow-pack", fxg::X1, {fxg::X0, fxg::H1, -1, -1}, Rows());
  g.pass("fxx-deblur", fxg::A, {fxg::IN, fxg::TAP0, fxg::TAP1, fxg::X1}, Rows().r(clampd(P.pct("blurriness"), 0, 1), std::max(2.0, P.n("sampleSize")), 0, 0));
  return g.done(fxg::A);
}

api::RenderEffect burn_dissolve(const Params& P, Box b) {
  Graph g("burn-dissolve", b.lw, b.lh);
  const double dir = P.rad("direction");
  const Rows r = Rows()
                     .r(clampd(P.pct("completion"), 0, 1), std::max(4.0, P.n("scale")), std::max(0.0, P.pct("warp")), clampd(P.pct("directionality"), 0, 1))
                     .r(std::cos(dir), std::sin(dir), std::max(0.5, P.n("edgeWidth")), std::max(0.0, P.n("charWidth")))
                     .c3(P.l3("emberColor", {1, 0.42, 0.06}), P.e("seed"))
                     .c3(P.l3("hotColor", {1, 0.9, 0.55}), std::max(0.0, P.pct("glow")))
                     .c3(P.l3("charColor", {0.01, 0.004, 0.002}), 0);
  g.pass("fxx-burn", fxg::X0, {fxg::IN, -1, -1, -1}, Rows(r).r(1, 0, 0, 0));
  g.blur(fxg::X1, fxg::X0, std::max(1.0, P.n("glowRadius")), fxg::X2);
  g.pass("fxx-burn", fxg::A, {fxg::IN, fxg::X1, -1, -1}, Rows(r).r(0, 0, 0, 0));
  return g.done(fxg::A);
}

api::RenderEffect liquid_morph(const Params& P, Box b) {
  Graph g("liquid-morph", b.lw, b.lh);
  const std::string target = P.layer("targetLayer");
  if (!target.empty()) g.map(0, target);
  const double fa = P.rad("flowAngle");
  g.pass("fxx-liquid", fxg::A, {fxg::IN, target.empty() ? fxg::IN : fxg::MAP, -1, -1},
         Rows()
             .r(clampd(P.pct("completion"), 0, 1), std::max(0.0, P.n("distortion")), std::max(4.0, P.n("scale")), std::max(0.0, P.pct("chroma")))
             .r(clampd(P.pct("softness"), 0.01, 1), std::cos(fa), std::sin(fa), target.empty() ? 0 : 1)
             .r(P.e("seed"), 0, 0, 0));
  return g.done(fxg::A);
}

api::RenderEffect bend_it(const Params& P, Box b) {
  Graph g("bend-it", b.lw, b.lh);
  const double cx = b.lw / 2;
  const double cy = b.lh / 2;
  g.pass("fxx-bendit", fxg::A, {fxg::IN, -1, -1, -1},
         Rows().r(cx + P.n("startX"), cy + P.n("startY"), cx + P.n("endX"), cy + P.n("endY")).r(P.rad("bend"), P.e("prestart"), 0, 0));
  return g.done(fxg::A);
}

api::RenderEffect bender(const Params& P, Box b) {
  Graph g("bender", b.lw, b.lh);
  const double cx = b.lw / 2;
  const double cy = b.lh / 2;
  g.pass("fxx-bender", fxg::A, {fxg::IN, -1, -1, -1},
         Rows().r(cx + P.n("topX"), cy + P.n("topY"), cx + P.n("baseX"), cy + P.n("baseY")).r(P.n("amount"), P.e("style"), P.on("adjustToDistance") ? 1 : 0, 0));
  return g.done(fxg::A);
}

// ── data tables ───────────────────────────────────────────────────────────────

/// A curve control (`[[x, y], …]` in 0..255) as 256 outputs in 0..1, linear or
/// a Catmull-Rom spline through the points (clamped).
std::array<double, 256> curve_table(const Json& v, bool smooth) {
  std::vector<std::pair<double, double>> pts;
  if (v.is_array()) {
    for (const Json& p : v.arr()) {
      if (p.is_array() && p.arr().size() >= 2 && p.arr()[0].is_number() && p.arr()[1].is_number()) {
        pts.emplace_back(clampd(p.arr()[0].num(), 0, 255), clampd(p.arr()[1].num(), 0, 255));
      }
    }
  }
  std::ranges::sort(pts);
  if (pts.empty()) pts = {{0, 0}, {255, 255}};
  if (pts.size() == 1) pts.emplace_back(255, pts[0].second);
  std::array<double, 256> out{};
  for (int i = 0; i < 256; ++i) {
    const auto x = static_cast<double>(i);
    std::size_t k = 0;
    while (k + 2 < pts.size() && pts[k + 1].first < x) ++k;
    const auto& a = pts[k];
    const auto& b2 = pts[k + 1];
    double y = 0;
    if (x <= pts.front().first) y = pts.front().second;
    else if (x >= pts.back().first) y = pts.back().second;
    else {
      const double span = std::max(1e-9, b2.first - a.first);
      const double u = clampd((x - a.first) / span, 0, 1);
      if (!smooth) {
        y = a.second + (b2.second - a.second) * u;
      } else {
        const auto& p0 = k > 0 ? pts[k - 1] : a;
        const auto& p3 = k + 2 < pts.size() ? pts[k + 2] : b2;
        const double m1 = (b2.second - p0.second) / std::max(1e-9, b2.first - p0.first) * span;
        const double m2 = (p3.second - a.second) / std::max(1e-9, p3.first - a.first) * span;
        const double u2 = u * u;
        const double u3 = u2 * u;
        y = (2 * u3 - 3 * u2 + 1) * a.second + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * b2.second + (u3 - u2) * m2;
      }
    }
    out.at(static_cast<std::size_t>(i)) = clampd(y / 255, 0, 1);
  }
  return out;
}

/// PS Arbitrary Map: the master map, then red / green / blue (4 × 256 floats:
/// R, G, B, and the master alone for alpha).
std::vector<float> arbitrary_map_data(const Params& P) {
  const bool smooth = P.e("interpolation") == 1;
  const auto master = curve_table(P.raw("masterMap"), smooth);
  const std::array<std::array<double, 256>, 3> ch{curve_table(P.raw("redMap"), smooth), curve_table(P.raw("greenMap"), smooth),
                                                  curve_table(P.raw("blueMap"), smooth)};
  std::vector<float> out(1024);
  const auto lookup = [](const std::array<double, 256>& t, double v) {
    const double x = clampd(v, 0, 1) * 255;
    const auto i = static_cast<std::size_t>(std::floor(x));
    const std::size_t j = std::min<std::size_t>(255, i + 1);
    return t.at(i) + (t.at(j) - t.at(i)) * (x - static_cast<double>(i));
  };
  for (std::size_t c = 0; c < 3; ++c) {
    for (std::size_t i = 0; i < 256; ++i) out[c * 256 + i] = static_cast<float>(lookup(ch.at(c), master.at(i)));
  }
  for (std::size_t i = 0; i < 256; ++i) out[768 + i] = static_cast<float>(master.at(i));
  return out;
}

/// Energy Saber's path: [n, closed, total length, 0] then (x, y, cumulative
/// length) per point, layer px (at most 1000 points).
std::vector<float> saber_path_data(const Json& path) {
  const Json flat = flatten_mask_path(path, 24);
  std::vector<std::array<double, 2>> pts;
  if (flat.at("pts").is_array()) {
    for (const Json& p : flat.at("pts").arr()) pts.push_back({p.at("x").is_number() ? p.at("x").num() : 0, p.at("y").is_number() ? p.at("y").num() : 0});
  }
  const bool closed = flat.at("closed").is_bool() && flat.at("closed").b();
  if (closed && pts.size() > 2) pts.push_back(pts.front());
  constexpr std::size_t kMax = 1000;
  if (pts.size() > kMax) {
    std::vector<std::array<double, 2>> d;
    for (std::size_t i = 0; i < kMax; ++i) d.push_back(pts[i * (pts.size() - 1) / (kMax - 1)]);
    pts = std::move(d);
  }
  std::vector<float> out{static_cast<float>(pts.size()), closed ? 1.0F : 0.0F, 0, 0};
  double len = 0;
  for (std::size_t i = 0; i < pts.size(); ++i) {
    if (i > 0) len += std::hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    out.insert(out.end(), {static_cast<float>(pts[i][0]), static_cast<float>(pts[i][1]), static_cast<float>(len)});
  }
  out[2] = static_cast<float>(len);
  return out;
}

/// The scene table of a 3D-aware effect: its `__camera` (17 numbers; AE's
/// default 1920 x 1080 camera if absent) then the light count and `__lights`
/// (16 numbers each) — deep_fx_scene.hpp.
std::vector<float> scene_data(const Params& P) {
  std::vector<float> out;
  const Json& cam = P.raw("__camera");
  if (cam.is_array() && cam.arr().size() >= 17) {
    for (const Json& v : cam.arr()) out.push_back(static_cast<float>(v.is_number() ? v.num() : 0));
    out.resize(17);
  } else {
    const motion::xf::Camera d = motion::xf::default_camera(1920, 1080);
    out = {static_cast<float>(d.position.x), static_cast<float>(d.position.y), static_cast<float>(d.position.z), static_cast<float>(d.focal_length),
           static_cast<float>(d.principal.x), static_cast<float>(d.principal.y), 1, 0, 0, 0, 1, 0, 0, 0, 1, 1920, 1080};
  }
  const Json& lights = P.raw("__lights");
  const std::size_t n = lights.is_array() ? std::min<std::size_t>(8, lights.arr().size() / 16) : 0;
  out.push_back(static_cast<float>(n));
  for (std::size_t i = 0; i < n * 16; ++i) {
    const Json& v = lights.arr()[i];
    out.push_back(static_cast<float>(v.is_number() ? v.num() : 0));
  }
  return out;
}

/// 3D Stroke's projected copies: [copies, points, 0, 0], then per copy (far to
/// near) [opacity, max thickness scale, bbox x0 y0 x1 y1 (comp px), 0, 0] and
/// per point [screen x, y, thickness scale (f / z), path fraction 0..1].
std::vector<float> stroke3d_data(const Params& P, const RLayer& l, const Json& path) {
  const Json flat = flatten_mask_path(path, 16);
  std::vector<std::array<double, 2>> pts;
  if (flat.at("pts").is_array()) {
    for (const Json& p : flat.at("pts").arr()) pts.push_back({p.at("x").is_number() ? p.at("x").num() : 0, p.at("y").is_number() ? p.at("y").num() : 0});
  }
  if (flat.at("closed").is_bool() && flat.at("closed").b() && pts.size() > 2) pts.push_back(pts.front());
  constexpr std::size_t kMax = 256;
  if (pts.size() > kMax) {
    std::vector<std::array<double, 2>> d;
    for (std::size_t i = 0; i < kMax; ++i) d.push_back(pts[i * (pts.size() - 1) / (kMax - 1)]);
    pts = std::move(d);
  }
  if (pts.size() < 2) return {};
  // Layer px → comp px (the layer's box about its position; a 2D layer unrotated).
  const double lw = std::max(1.0, l.width);
  const double lh = std::max(1.0, l.height);
  std::vector<double> frac(pts.size(), 0);
  double len = 0;
  for (std::size_t i = 1; i < pts.size(); ++i) {
    len += std::hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    frac[i] = len;
  }
  for (double& f : frac) f = len > 0 ? f / len : 0;
  double cx = 0, cy = 0;
  for (const auto& p : pts) {
    cx += p[0];
    cy += p[1];
  }
  cx /= static_cast<double>(pts.size());
  cy /= static_cast<double>(pts.size());
  const std::vector<float> scene = scene_data(P);
  const double ex = scene[0], ey = scene[1], ez = scene[2], f = scene[3], ppx = scene[4], ppy = scene[5];
  const std::array<double, 9> r{scene[6], scene[7], scene[8], scene[9], scene[10], scene[11], scene[12], scene[13], scene[14]};
  const bool rep = P.on("repeater");
  const int copies = rep ? std::clamp(P.e("instances"), 1, 16) : 1;
  struct Copy {
    double opacity, depth, maxScale;
    std::array<double, 4> box;
    std::vector<std::array<double, 4>> pts;
  };
  std::vector<Copy> list;
  for (int k = 0; k < copies; ++k) {
    const double kk = static_cast<double>(k);
    const double sc = std::pow(clampd(P.pct("scaleStep"), 0.01, 4), kk);
    const auto rot = sphere_rotation(P.rad("rotateY") * kk, P.rad("rotateX") * kk, P.rad("rotateZ") * kk);
    Copy cp{std::pow(1 - clampd(P.pct("opacityFade"), 0, 1), kk), 0, 0, {1e18, 1e18, -1e18, -1e18}, {}};
    double depthSum = 0;
    for (std::size_t i = 0; i < pts.size(); ++i) {
      const V3 local{(pts[i][0] - cx) * sc, (pts[i][1] - cy) * sc, 0};
      V3 w{};
      for (std::size_t a = 0; a < 3; ++a) w.at(a) = rot.at(a)[0] * local[0] + rot.at(a)[1] * local[1] + rot.at(a)[2] * local[2];
      const double wx = w[0] + cx - lw / 2 + l.x;
      const double wy = w[1] + cy - lh / 2 + l.y;
      const double wz = w[2] + P.n("zDisplace") * kk;
      const double vx = r[0] * (wx - ex) + r[1] * (wy - ey) + r[2] * (wz - ez);
      const double vy = r[3] * (wx - ex) + r[4] * (wy - ey) + r[5] * (wz - ez);
      const double vz = std::max(1.0, r[6] * (wx - ex) + r[7] * (wy - ey) + r[8] * (wz - ez));
      const double s = f / vz;
      const double sx = ppx + vx * s;
      const double sy = ppy + vy * s;
      cp.pts.push_back({sx, sy, s, frac[i]});
      cp.maxScale = std::max(cp.maxScale, s);
      cp.box = {std::min(cp.box[0], sx), std::min(cp.box[1], sy), std::max(cp.box[2], sx), std::max(cp.box[3], sy)};
      depthSum += vz;
    }
    cp.depth = depthSum / static_cast<double>(pts.size());
    list.push_back(std::move(cp));
  }
  std::ranges::stable_sort(list, [](const Copy& a, const Copy& c2) { return a.depth > c2.depth; });
  std::vector<float> out{static_cast<float>(list.size()), static_cast<float>(pts.size()), 0, 0};
  double nearest = 1e18, farthest = 0;
  for (const Copy& cp : list) {
    nearest = std::min(nearest, cp.depth);
    farthest = std::max(farthest, cp.depth);
  }
  out[2] = static_cast<float>(nearest);
  out[3] = static_cast<float>(farthest);
  for (const Copy& cp : list) {
    out.insert(out.end(), {static_cast<float>(cp.opacity), static_cast<float>(cp.maxScale), static_cast<float>(cp.box[0]), static_cast<float>(cp.box[1]),
                           static_cast<float>(cp.box[2]), static_cast<float>(cp.box[3]), static_cast<float>(cp.depth), 0});
    for (const auto& p : cp.pts) out.insert(out.end(), {static_cast<float>(p[0]), static_cast<float>(p[1]), static_cast<float>(p[2]), static_cast<float>(p[3])});
  }
  // The stroke's thickness rides in the header's slot the shader reads per point.
  out.push_back(static_cast<float>(std::max(0.1, P.n("thickness"))));
  return out;
}

/// A deterministic hash of (i, salt) to [0, 1).
double h01(double i, double salt) {
  std::uint64_t x = static_cast<std::uint64_t>(static_cast<std::int64_t>(std::floor(i))) * 0x9E3779B97F4A7C15ULL;
  x ^= static_cast<std::uint64_t>(static_cast<std::int64_t>(std::floor(salt * 1000))) * 0xC2B2AE3D27D4EB4FULL;
  x ^= x >> 31U;
  x *= 0xBF58476D1CE4E5B9ULL;
  x ^= x >> 27U;
  x *= 0x94D049BB133111EBULL;
  x ^= x >> 31U;
  return static_cast<double>(x >> 11U) / 9007199254740992.0;
}

/// CC Particle World's particles this frame, in closed form (each a pure
/// function of its index and the time), projected through the comp camera,
/// sorted far to near and binned into 32 px screen tiles:
/// [tiles x, tiles y, tile size, particle base] · per tile [offset, count]
/// (into the index list) · the index list · per particle 12 numbers
/// [x, y, radius px, depth, r, g, b, opacity, previous x, y, 0, 0] (comp px).
std::vector<float> particle_world_data(const Params& P, const RLayer& l) {
  const std::vector<float> scene = scene_data(P);
  const double ex = scene[0], ey = scene[1], ez = scene[2], f = scene[3], ppx = scene[4], ppy = scene[5];
  const std::array<double, 9> r{scene[6], scene[7], scene[8], scene[9], scene[10], scene[11], scene[12], scene[13], scene[14]};
  const double compW = std::max(1.0, static_cast<double>(scene[15]));
  const double compH = std::max(1.0, static_cast<double>(scene[16]));
  const double t = P.n("time");
  const double fps = fps_of(P);
  const double rate = clampd(P.n("birthRate"), 1, 2000);
  const double life = clampd(P.n("longevity"), 0.1, 30);
  const double seedv = P.n("seed");
  const double res = std::max(0.0, P.pct("resistance")) * 2;
  const double grav = P.n("gravity");
  const double extra = std::max(0.0, P.pct("extra"));
  const int anim = P.e("animation");
  const double ax = P.rad("axisX");
  const double ay = P.rad("axisY");
  const V3 axis{std::cos(ay) * std::cos(ax), std::sin(ay), std::cos(ay) * std::sin(ax)};
  const V3 c0{l.x + P.n("producerX"), l.y + P.n("producerY"), P.n("producerZ")};
  const V3 bc = P.l3("birthColor", {1, 0.9, 0.4});
  const V3 dc = P.l3("deathColor", {1, 0.05, 0.01});
  const double bs = std::max(0.1, P.n("birthSize"));
  const double ds = std::max(0.0, P.n("deathSize"));
  const double sv = clampd(P.pct("sizeVariation"), 0, 1);
  const double maxA = clampd(P.pct("maxOpacity"), 0, 1);
  const double vel = std::max(0.0, P.n("velocity"));
  const auto project = [&](const V3& w) -> std::array<double, 3> {
    const double dx = w[0] - ex, dy = w[1] - ey, dz = w[2] - ez;
    const double vx = r[0] * dx + r[1] * dy + r[2] * dz;
    const double vy = r[3] * dx + r[4] * dy + r[5] * dz;
    const double vz = r[6] * dx + r[7] * dy + r[8] * dz;
    if (vz < 1) return {0, 0, -1};
    return {ppx + vx * f / vz, ppy + vy * f / vz, vz};
  };
  const auto positionAt = [&](double i, double tau) -> V3 {
    const double u1 = h01(i, seedv + 1), u2 = h01(i, seedv + 2), u3 = h01(i, seedv + 3);
    // Birth point: inside the producer's ellipsoid.
    const double th = u1 * 2 * kPi, ph = std::acos(2 * u2 - 1), rr = std::cbrt(u3);
    const V3 p0{c0[0] + P.n("radiusX") * rr * std::sin(ph) * std::cos(th), c0[1] + P.n("radiusY") * rr * std::cos(ph),
                c0[2] + P.n("radiusZ") * rr * std::sin(ph) * std::sin(th)};
    // Direction by the animation: all ways, along the axis, in a cone about it.
    const double v1 = h01(i, seedv + 4), v2 = h01(i, seedv + 5);
    const double vth = v1 * 2 * kPi, vph = std::acos(2 * v2 - 1);
    const V3 rnd{std::sin(vph) * std::cos(vth), std::cos(vph), std::sin(vph) * std::sin(vth)};
    V3 dir = rnd;
    if (anim == 1 || anim == 2) {
      const double spread = anim == 1 ? 0.15 : 0.55;
      dir = {axis[0] + rnd[0] * spread, axis[1] + rnd[1] * spread, axis[2] + rnd[2] * spread};
      const double n = std::max(1e-9, std::hypot(dir[0], dir[1], dir[2]));
      dir = {dir[0] / n, dir[1] / n, dir[2] / n};
    }
    const double speed = vel * (0.7 + 0.6 * h01(i, seedv + 6));
    const V3 v0{dir[0] * speed, dir[1] * speed, dir[2] * speed};
    V3 p{};
    if (res < 1e-4) {
      for (std::size_t a = 0; a < 3; ++a) p.at(a) = p0.at(a) + v0.at(a) * tau + (a == 1 ? 0.5 * grav * tau * tau : 0);
    } else {
      // Linear drag in closed form: v' = g - res v.
      const double e = 1 - std::exp(-res * tau);
      for (std::size_t a = 0; a < 3; ++a) {
        const double g = a == 1 ? grav : 0;
        p.at(a) = p0.at(a) + (v0.at(a) - g / res) * e / res + g * tau / res;
      }
    }
    // Extra: a smooth wander growing with age (Fractal Omni: stronger).
    const double w = extra * (anim == 3 ? 3 : 1) * 60 * tau;
    for (std::size_t a = 0; a < 3; ++a) {
      const auto fa = static_cast<double>(a);
      p.at(a) += w * std::sin(tau * (1.3 + h01(i, seedv + 7 + fa)) * 2.1 + h01(i, seedv + 11 + fa) * 6.28);
    }
    return p;
  };
  struct Part {
    std::array<double, 12> v;
  };
  std::vector<Part> parts;
  const auto n = static_cast<long long>(std::min(4000.0, std::ceil(rate * life)));
  const auto i0 = static_cast<long long>(std::floor((t - life) * rate));
  for (long long k = 0; k <= n; ++k) {
    const auto i = static_cast<double>(i0 + k);
    const double birth = i / rate;
    const double age = t - birth;
    if (birth < 0 || age < 0 || age >= life) continue;
    const double u = age / life;
    const auto s = project(positionAt(i, age));
    if (s[2] <= 0) continue;
    const auto sp = project(positionAt(i, std::max(0.0, age - 1 / fps)));
    const double size = (bs + (ds - bs) * u) * (1 - sv * h01(i, seedv + 9)) * f / s[2];
    const double a = maxA * std::min(1.0, u * 8) * std::min(1.0, (1 - u) * 4);
    Part q{};
    q.v = {s[0], s[1], std::max(0.3, size * 0.5), s[2], bc[0] + (dc[0] - bc[0]) * u, bc[1] + (dc[1] - bc[1]) * u, bc[2] + (dc[2] - bc[2]) * u, a,
           sp[2] > 0 ? sp[0] : s[0], sp[2] > 0 ? sp[1] : s[1], 0, 0};
    parts.push_back(q);
  }
  std::ranges::stable_sort(parts, [](const Part& a, const Part& b2) { return a.v[3] > b2.v[3]; });
  constexpr double kTile = 32;
  const auto tx = static_cast<std::size_t>(std::ceil(compW / kTile));
  const auto ty = static_cast<std::size_t>(std::ceil(compH / kTile));
  std::vector<std::vector<float>> bins(tx * ty);
  constexpr std::size_t kPerTile = 96;
  for (std::size_t pi = 0; pi < parts.size(); ++pi) {
    const auto& v = parts[pi].v;
    const double reach = v[2] * 2 + 2;
    const double x0 = std::min(v[0], v[8]) - reach, x1 = std::max(v[0], v[8]) + reach;
    const double y0 = std::min(v[1], v[9]) - reach, y1 = std::max(v[1], v[9]) + reach;
    if (x1 < 0 || y1 < 0 || x0 >= compW || y0 >= compH) continue;
    const auto cx0 = static_cast<std::size_t>(std::max(0.0, x0) / kTile);
    const auto cx1 = static_cast<std::size_t>(std::min(compW - 1, x1) / kTile);
    const auto cy0 = static_cast<std::size_t>(std::max(0.0, y0) / kTile);
    const auto cy1 = static_cast<std::size_t>(std::min(compH - 1, y1) / kTile);
    for (std::size_t yy = cy0; yy <= cy1 && yy < ty; ++yy) {
      for (std::size_t xx = cx0; xx <= cx1 && xx < tx; ++xx) {
        auto& b2 = bins[yy * tx + xx];
        if (b2.size() < kPerTile) b2.push_back(static_cast<float>(pi));
      }
    }
  }
  std::vector<float> out{static_cast<float>(tx), static_cast<float>(ty), static_cast<float>(kTile), 0};
  const std::size_t idxBase = 4 + bins.size() * 2;
  out.resize(idxBase, 0);
  std::size_t off = 0;
  for (std::size_t k = 0; k < bins.size(); ++k) {
    out[4 + k * 2] = static_cast<float>(off);
    out[4 + k * 2 + 1] = static_cast<float>(bins[k].size());
    off += bins[k].size();
  }
  for (const auto& b2 : bins) out.insert(out.end(), b2.begin(), b2.end());
  out[3] = static_cast<float>(out.size());
  for (const Part& q : parts) {
    for (const double x : q.v) out.push_back(static_cast<float>(x));
  }
  return out;
}

// ── Batch 8: on an Object Matte ───────────────────────────────────────────────

// Matte Stroke: the matte's distance field (the jump flood the Alpha Stroke
// style uses, fx_distance.hpp) → the stroke band (dashed by the contour's
// angle about the matte's centroid, a 256-column reduction) → its glow (a
// Gaussian of the band) → composited on the input, behind it (an outside
// stroke of the layer's own alpha) or alone.
api::RenderEffect matte_stroke(const Params& P, Box b, const Ctx& c) {
  Graph g("matte-stroke", b.lw, b.lh);
  const std::string matte = P.layer("matteLayerId");
  // No Matte Layer: the layer's subject (its Object Matte frame) when it has one — a stroke
  // around the person, not around the footage's rectangle — else the layer's own alpha.
  const bool subject = matte.empty() && c.l.objectMatteSrc.has_value();
  const bool own = matte.empty() && !subject;
  if (!matte.empty()) g.map(0, matte);
  if (subject) g.mask(0, object_matte_key(c.l.id, effect_subject_ids(c.e)));
  const int src = own ? fxg::IN : subject ? fxg::MASK0 : fxg::MAP;
  const double w = std::max(0.0, P.n("width"));
  const double soft = std::max(0.0, P.n("softness"));
  const int pos = std::clamp(P.e("position"), 0, 2);
  const double outward = pos == 0 ? w : pos == 1 ? w / 2 : 0;
  const double inward = pos == 0 ? 0 : pos == 1 ? w / 2 : w;
  g.field(fxg::X0, src, std::max(outward, inward) + soft + 2);
  const bool dashed = P.on("dashed");
  if (dashed) {
    g.pass("fxx-mstroke-strip", fxg::STRIP, {src, -1, -1, -1}, Rows());
    g.pass("fxx-mstroke-centroid", fxg::Q0, {fxg::STRIP, -1, -1, -1}, Rows());
  }
  // An outside stroke of the layer's own alpha runs on under the layer: no seam at its edge.
  const bool behind = own && pos == 0;
  g.pass("fxx-mstroke-band", fxg::X1, {fxg::X0, dashed ? fxg::Q0 : fxg::X0, -1, -1},
         Rows()
             .r(w, pos, soft, behind ? 1 : 0)
             .r(dashed ? 1 : 0, std::max(0.0, P.n("dashLength")), std::max(0.0, P.n("gapLength")), P.n("dashOffset")));
  const double glowAmount = std::max(0.0, P.pct("glowAmount"));
  const double glowRadius = std::max(0.0, P.n("glowRadius"));
  const bool glow = glowAmount > 0 && glowRadius > 0;
  if (glow) g.blur(fxg::X2, fxg::X1, glowRadius * 0.5, fxg::X3);
  const int composite = std::clamp(P.e("composite"), 0, 1);
  g.pass("fxx-mstroke-comp", fxg::A, {fxg::IN, fxg::X1, glow ? fxg::X2 : fxg::X1, -1},
         Rows().c3(P.l3("color", {1, 1, 1}), clampd(P.pct("opacity"), 0, 1)).r(glowAmount, composite, behind ? 1 : 0, glow ? 1 : 0));
  // How far past the matte it draws (layer px): the band, its ramp, the glow's 3.5 sigma.
  const double reach = outward + soft + 2 + (glow ? glowRadius * 1.75 + 2 : 0);
  return g.done(fxg::A, std::max(1.0, reach));
}

// Selective Color (AI): the matte (another layer's alpha, the layer's own
// Object Matte frame through its placement, or its alpha) → choked by its
// distance field → feathered by a Gaussian → a linear-light HSL / colorize
// correction mixed in through it (or its inverse). Per pixel of the input.
api::RenderEffect selective_color_ai(const Params& P, Box b, const Ctx& c) {
  Graph g("selective-color-ai", b.lw, b.lh);
  const std::string matte = P.layer("matteLayerId");
  int src = fxg::IN;
  if (!matte.empty()) {
    g.map(0, matte);
    src = fxg::MAP;
  } else if (c.l.objectMatteSrc) {
    g.mask(0, object_matte_key(c.l.id, effect_subject_ids(c.e)));
    src = fxg::MASK0;
  }
  const double choke = P.n("matteChoke");
  const bool choked = std::abs(choke) > 1e-3;
  if (choked) g.field(fxg::X0, src, std::abs(choke) + 2);
  g.pass("fxx-selcol-matte", fxg::X1, {src, choked ? fxg::X0 : src, -1, -1}, Rows().r(choke, choked ? 1 : 0, 0, 0));
  const double feather = std::max(0.0, P.n("matteFeather"));
  if (feather > 0) g.blur(fxg::X1, fxg::X1, feather * 0.5, fxg::X2);
  g.pass("fxx-selcol", fxg::A, {fxg::IN, fxg::X1, -1, -1},
         Rows()
             .r(P.rad("hue"), clampd(P.n("saturation") / 100, -1, 1), clampd(P.n("lightness") / 100, -1, 1), std::clamp(P.e("applyTo"), 0, 1))
             .r(P.on("colorize") ? 1 : 0, clampd(P.pct("colorizeAmount"), 0, 1), 0, 0)
             .c3(P.l3("colorizeColor", {1, 0.42, 0.1})));
  return g.done(fxg::A, 0.0);
}

// Object Matte (After Effects' Object Matte card): the layer cut by its own
// stored Object Matte frame (fed as a texture, as Selective Color (AI) reads
// it). Fine-tune: Shift Edge moves the edge along the matte's distance field
// (a percentage of the Feather, at least 10 px: + grows), Feather blurs it
// (Gaussian), Contrast steepens it; Invert keeps the background. The
// propagation controls (Quality, Edge Radius, Decontaminate, Motion Blur,
// Reduce Chatter, Render Refine Edge) were baked into the frames: they are
// read by the next propagation, not here. No frame: the chain keeps its input.
void object_matte(const Params& P, Box b, const Ctx& c, Out& out) {
  if (!c.l.objectMatteSrc) return;
  Graph g("object-matte", b.lw, b.lh);
  g.mask(0, object_matte_key(c.l.id), true);  // every shown subject; required: no frame texture → the layer shows uncut
  const int src = fxg::MASK0;
  const bool fine = P.on("fineTune");
  const double feather = fine ? std::max(0.0, P.n("feather")) : 0.0;
  const double shift = fine ? clampd(P.n("shiftEdge"), -100, 100) / 100 * std::max(10.0, feather) : 0.0;
  const bool shifted = std::abs(shift) > 1e-3;
  if (shifted) g.field(fxg::X0, src, std::abs(shift) + 2);
  g.pass("fxx-selcol-matte", fxg::X1, {src, shifted ? fxg::X0 : src, -1, -1}, Rows().r(-shift, shifted ? 1 : 0, 0, 0));
  if (feather > 0) g.blur(fxg::X1, fxg::X1, feather * 0.5, fxg::X2);
  const bool invert = P.on("invert");
  // Stream B1: the stored frame is coverage alone; the footage keeps its colour and the
  // card's Decontaminate unmixes the soft edge as it composites (fxx-omatte.wgsl). Inverted,
  // the background is the footage's, untouched.
  const double decontaminate = P.on("decontaminate") ? clampd(P.pct("decontaminationAmount"), 0, 1) : 0.0;
  g.pass("fxx-omatte", fxg::A, {fxg::IN, fxg::X1, src, -1}, Rows().r(fine ? clampd(P.pct("contrast"), 0, 1) : 0, invert ? 1 : 0, decontaminate, 0));
  out.push_back(g.done(fxg::A, 0.0));
}

bool pack(std::string_view t, const Params& P, Box b, const Ctx& c, Out& out) {
  if (t == "lens-bloom") out.push_back(lens_bloom(P, b));
  else if (t == "shine") out.push_back(shine(P, b));
  else if (t == "image-flares") out.push_back(image_flares(P, b));
  else if (t == "painterly") out.push_back(painterly(P, b));
  else if (t == "watercolor") out.push_back(watercolor(P, b));
  else if (t == "ink-outline") out.push_back(ink_outline(P, b));
  else if (t == "detail-upscale") out.push_back(detail_upscale(P, b));
  else if (t == "paint-bucket") out.push_back(paint_bucket(P, b));
  else if (t == "light-wrap") out.push_back(light_wrap(P, b));
  else if (t == "refraction") out.push_back(refraction(P, b));
  else if (t == "compound-arithmetic") out.push_back(compound_arithmetic(P, b));
  else if (t == "color-link") out.push_back(color_link(P, b));
  else if (t == "inner-outer-key") out.push_back(inner_outer_key(P, b, c));
  else if (t == "energy-saber") {
    // No path (and no layer-alpha core): nothing to draw — the chain keeps its input.
    if (P.e("coreType") != 1 && mask_path(c.l, P, "pathMask", true) == nullptr) return true;
    out.push_back(energy_saber(P, b, c));
  } else if (t == "ps-arbitrary-map") out.push_back(ps_arbitrary_map(P, b, c));
  else if (t == "edge-rays") out.push_back(edge_rays(P, b));
  else if (t == "vr-blur") out.push_back(vr_blur(P, b));
  else if (t == "vr-chromatic-aberrations") out.push_back(vr_chromatic(P, b));
  else if (t == "vr-converter") out.push_back(vr_converter(P, b));
  else if (t == "vr-denoise") out.push_back(vr_denoise(P, b));
  else if (t == "vr-fractal-noise") out.push_back(vr_fractal_noise(P, b));
  else if (t == "vr-glow") out.push_back(vr_glow(P, b));
  else if (t == "vr-plane-to-sphere") out.push_back(vr_plane_to_sphere(P, b));
  else if (t == "vr-sharpen") out.push_back(vr_sharpen(P, b));
  else if (t == "volumetric-lights") out.push_back(volumetric_lights(P, b, c));
  else if (t == "relight") out.push_back(relight(P, b, c));
  else if (t == "volumetric-clouds") out.push_back(volumetric_clouds(P, b, c));
  else if (t == "starfield") out.push_back(starfield(P, b, c));
  else if (t == "cc-environment") out.push_back(cc_environment(P, b, c));
  else if (t == "ocean") out.push_back(ocean(P, b, c));
  else if (t == "aurora") out.push_back(aurora(P, b, c));
  else if (t == "stroke-3d") {
    if (mask_path(c.l, P, "pathMask", true) == nullptr) return true;  // no path: nothing to stroke
    out.push_back(stroke_3d(P, b, c));
  } else if (t == "timewarp") out.push_back(timewarp(P, b, c));
  else if (t == "pixel-motion-blur") out.push_back(pixel_motion_blur(P, b, c));
  else if (t == "time-displacement") out.push_back(time_displacement(P, b, c));
  else if (t == "time-difference") out.push_back(time_difference(P, b, c));
  else if (t == "time-blend") out.push_back(time_blend(P, b, c));
  else if (t == "light-trails") out.push_back(light_trails(P, b, c));
  else if (t == "datamosh") out.push_back(datamosh(P, b, c));
  else if (t == "temporal-denoise") out.push_back(temporal_denoise(P, b, c));
  else if (t == "fluid-ink") out.push_back(fluid_ink(P, b, c));
  else if (t == "reaction-diffusion") out.push_back(reaction_diffusion(P, b, c));
  else if (t == "crystal-growth") out.push_back(crystal_growth(P, b, c));
  else if (t == "mr-mercury") out.push_back(mr_mercury(P, b));
  else if (t == "foam") out.push_back(foam(P, b));
  else if (t == "hair") out.push_back(hair(P, b));
  else if (t == "rain-on-glass") out.push_back(rain_on_glass(P, b));
  else if (t == "particle-world") out.push_back(particle_world(P, b, c));
  else if (t == "warp-stabilizer") out.push_back(warp_stabilizer(P, b, c));
  else if (t == "match-grain") out.push_back(match_grain(P, b));
  else if (t == "color-stabilizer") out.push_back(color_stabilizer(P, b, c));
  else if (t == "camera-shake-deblur") out.push_back(camera_shake_deblur(P, b, c));
  else if (t == "burn-dissolve") out.push_back(burn_dissolve(P, b));
  else if (t == "liquid-morph") out.push_back(liquid_morph(P, b));
  else if (t == "bend-it") out.push_back(bend_it(P, b));
  else if (t == "bender") out.push_back(bender(P, b));
  else if (t == "matte-stroke") out.push_back(matte_stroke(P, b, c));
  else if (t == "selective-color-ai") out.push_back(selective_color_ai(P, b, c));
  else if (t == "object-matte") object_matte(P, b, c, out);
  else if (t == "goo") out.push_back(goo(P, b));
  else return false;
  return true;
}

}  // namespace

bool spatial_x_handles(std::string_view type) { return std::ranges::find(kHandled, type) != kHandled.end(); }

bool deep_effect_follows_clock(std::string_view type) { return std::ranges::find(kClock, type) != kClock.end(); }

api::RenderEffect subject_fill_entry(const RLayer& l, std::span<const std::string> ids) {
  const Box b{std::max(1.0, l.width > 0 ? l.width : 1.0), std::max(1.0, l.height > 0 ? l.height : 1.0)};
  Graph g("subject-fill", b.lw, b.lh);
  g.mask(0, object_matte_key(l.id, ids));
  g.pass("fxx-sfill-pre", fxg::X0, {fxg::IN, fxg::MASK0, -1, -1}, Rows());
  // Wide enough to reach the background across a person's width (3 % of the layer's long side).
  g.blur(fxg::X1, fxg::X0, std::max(b.lw, b.lh) * 0.03, fxg::X2);
  g.pass("fxx-sfill-post", fxg::A, {fxg::IN, fxg::X1, fxg::MASK0, -1}, Rows());
  return g.done(fxg::A, 0.0);
}

bool spatial_x(const Json& e, const Json& params, const RLayer& layer, Out& out) {
  const Json& ty = e.at("type");
  if (!ty.is_string()) return false;
  const std::string_view t = ty.str();
  if (!spatial_x_handles(t)) return false;
  const Params P{params};
  const Box b{std::max(1.0, layer.width > 0 ? layer.width : 1.0), std::max(1.0, layer.height > 0 ? layer.height : 1.0)};
  return pack(t, P, b, Ctx{e, layer}, out);
}

std::vector<DeepFxTexture> deep_effect_textures(const RLayer& l) {
  std::vector<DeepFxTexture> out;
  const auto addMask = [&](const Json* path) {
    if (path == nullptr || !path->at("id").is_string()) return;
    std::string key = scope_mask_key(l.id, path->at("id").str());
    if (std::ranges::any_of(out, [&](const DeepFxTexture& d) { return d.key == key; })) return;
    // A raster of the one path, added (as the effect scopes are, effects_port.cpp).
    Json p = *path;
    p.set("mode", Json::string("add"));
    Json paths = Json::array();
    paths.arr_mut().push_back(std::move(p));
    DeepFxTexture d;
    d.key = std::move(key);
    d.mask = Json::object();
    d.mask.set("paths", std::move(paths));
    out.push_back(std::move(d));
  };
  // A subject matte (all the layer's shown subjects, or some): one texture per set, however many effects read it.
  const auto addSubject = [&](std::span<const std::string> ids) {
    std::string key = object_matte_key(l.id, ids);
    if (std::ranges::any_of(out, [&](const DeepFxTexture& d) { return d.key == key; })) return;
    std::vector<SubjectPart> parts = subject_parts(l, ids);
    if (parts.empty()) return;
    DeepFxTexture d;
    d.key = std::move(key);
    d.src = parts.front().src;
    d.parts = std::move(parts);
    out.push_back(std::move(d));
  };
  for (const Json& e : l.effects) {
    if (!effect_enabled(e) || !e.at("type").is_string()) continue;
    const std::string_view t = e.at("type").str();
    if (subject_scope_of(e) != 0 && l.objectMatteSrc) {
      // Any effect applied to the Subject / Background reads the layer's Object Matte frame as its scope.
      addSubject(effect_subject_ids(e));
    }
    if (t == "image-fill") {
      // The picture, as a still: frame_build requests it as media, so it decodes and colour-manages as a layer's would.
      if (std::string file = image_fill_file(e); !file.empty()) {
        DeepFxTexture d;
        d.key = image_fill_key(file);
        d.src = std::move(file);
        out.push_back(std::move(d));
      }
    }
    if (!spatial_x_handles(t)) continue;
    const Json params = doc::params_of(e);
    const Params P{params};
    const Ctx c{e, l};
    if (t == "inner-outer-key") {
      addMask(mask_path(l, P, "foregroundMask", true));
      addMask(mask_path(l, P, "backgroundMask", false));
    } else if (t == "energy-saber" && P.e("coreType") != 1) {
      if (const Json* path = mask_path(l, P, "pathMask", true)) out.push_back({data_key(c, "path"), Json(), saber_path_data(*path), {}, {}});
    } else if (t == "ps-arbitrary-map") {
      out.push_back({data_key(c, "map"), Json(), arbitrary_map_data(P), {}, {}});
    } else if (t == "particle-world") {
      out.push_back({data_key(c, "particles"), Json(), particle_world_data(P, l), {}, {}});
    } else if (t == "stroke-3d") {
      if (const Json* path = mask_path(l, P, "pathMask", true)) {
        std::vector<float> d = stroke3d_data(P, l, *path);
        if (!d.empty()) out.push_back({data_key(c, "stroke"), Json(), std::move(d), {}, {}});
      }
    } else if (((t == "selective-color-ai" && P.layer("matteLayerId").empty()) || (t == "matte-stroke" && P.layer("matteLayerId").empty()) ||
                t == "object-matte") &&
               l.objectMatteSrc) {
      // The layer's own Object Matte frame, read as a matte (one texture however many effects read it).
      addSubject(t == "object-matte" ? std::vector<std::string>{} : effect_subject_ids(e));
    } else if (deep_effect_reads_scene(t)) {
      out.push_back({data_key(c, "scene"), Json(), scene_data(P), {}, {}});
    }
  }
  return out;
}

bool reads_own_object_matte(const RLayer& l) {
  return std::ranges::any_of(l.effects, [](const Json& e) {
    if (!effect_enabled(e) || !e.at("type").is_string()) return false;
    if (e.at("type").str() == "object-matte" || subject_scope_of(e) != 0) return true;
    if (e.at("type").str() != "selective-color-ai" && e.at("type").str() != "matte-stroke") return false;
    const Json params = doc::params_of(e);
    return Params{params}.layer("matteLayerId").empty();
  });
}

std::string object_matte_key(std::string_view layerId, std::span<const std::string> ids) {
  std::string k = "fxmatte:";
  k += layerId;
  for (std::size_t i = 0; i < ids.size(); ++i) {
    k += i == 0 ? '~' : '+';
    k += ids[i];
  }
  return k;
}

std::vector<SubjectPart> subject_parts(const RLayer& l, std::span<const std::string> ids) {
  std::vector<SubjectPart> out;
  for (const SubjectPart& p : l.subjects)
    if (ids.empty() || std::ranges::find(ids, p.id) != ids.end()) out.push_back(p);
  return out;
}

std::vector<std::string> effect_subject_ids(const Json& e) {
  const Json& s = e.at("subjectId");
  if (s.is_string() && !s.str().empty()) return {s.str()};
  return {};
}

// ── the scene hand-off (deep_fx_scene.hpp) ────────────────────────────────────

bool deep_effect_reads_scene(std::string_view type) {
  static constexpr auto k = std::to_array<std::string_view>(
      {"volumetric-lights", "relight", "volumetric-clouds", "starfield", "cc-environment", "ocean", "aurora", "stroke-3d", "particle-world"});
  return std::ranges::find(k, type) != k.end();
}

void inject_deep_scene(std::vector<Json>& resolved, const std::optional<motion::xf::Camera>& camera, const std::vector<SceneLight>* lights,
                       double compWidth, double compHeight) {
  const bool wanted = std::ranges::any_of(resolved, [](const Json& e) {
    return e.at("type").is_string() && deep_effect_reads_scene(e.at("type").str()) && e.at("params").is_object();
  });
  if (!wanted) return;
  const motion::xf::Camera cam = camera ? *camera : motion::xf::default_camera(compWidth, compHeight);
  const motion::xf::Mat4 v = motion::xf::camera_view_matrix(cam);
  Json cj = Json::array();
  // The view matrix is column-major: row i of R is (v[i], v[4 + i], v[8 + i]).
  for (const double x : {cam.position.x, cam.position.y, cam.position.z, cam.focal_length, cam.principal.x, cam.principal.y, v[0], v[4], v[8], v[1],
                         v[5], v[9], v[2], v[6], v[10], compWidth, compHeight}) {
    cj.arr_mut().push_back(Json::number(x));
  }
  Json lj = Json::array();
  std::size_t count = 0;
  if (lights != nullptr) {
    for (const SceneLight& s : *lights) {
      if (s.fromEnv || count >= 8) continue;
      const double type = s.type == "ambient" ? 0 : s.type == "parallel" ? 1 : s.type == "spot" ? 3 : 2;
      V3 c3{1, 1, 1};
      {
        Json holder = Json::object();
        holder.set("c", Json::string(s.color));
        c3 = Params{holder}.l3("c", {1, 1, 1});
      }
      std::array<double, 3> aim{0, 0, 1};
      if (const auto a = light_aim_3d(s)) aim = *a;
      const double an = std::hypot(aim[0], aim[1], aim[2]);
      if (an > 0) aim = {aim[0] / an, aim[1] / an, aim[2] / an};
      const double falloff = !s.falloff || *s.falloff == "none" ? 0 : *s.falloff == "smooth" ? 1 : 2;
      for (const double x : {type, s.x, s.y, s.z, c3[0], c3[1], c3[2], s.intensity / 100, aim[0], aim[1], aim[2], s.cone * kPi / 360,
                             s.coneFeather.value_or(50) / 100, falloff, s.falloffDistance.value_or(s.radius), 0.0}) {
        lj.arr_mut().push_back(Json::number(x));
      }
      ++count;
    }
  }
  for (Json& e : resolved) {
    if (!e.at("type").is_string() || !deep_effect_reads_scene(e.at("type").str()) || !e.at("params").is_object()) continue;
    Json p = e.at("params");
    p.set("__camera", cj);
    p.set("__lights", lj);
    e.set("params", std::move(p));
  }
}

// ── Program X1: time taps (deep_fx_scene.hpp) ─────────────────────────────────

namespace {
constexpr auto kTemporal = std::to_array<std::string_view>(
    {"timewarp", "pixel-motion-blur", "time-displacement", "time-difference", "time-blend", "light-trails", "datamosh", "temporal-denoise",
     // X2 simulations: their clock (__fps) and the layer at their start time.
     "fluid-ink", "reaction-diffusion", "crystal-growth", "particle-world",
     // Batch 7: the frames around this one, and a reference frame.
     "warp-stabilizer", "color-stabilizer", "camera-shake-deblur", "match-grain"});
bool is_temporal_deep(std::string_view t) { return std::ranges::find(kTemporal, t) != kTemporal.end(); }
}  // namespace

void inject_deep_fps(std::vector<Json>& resolved, double fps, std::optional<double> layerTime) {
  for (Json& e : resolved) {
    if (!e.at("type").is_string() || !is_temporal_deep(e.at("type").str()) || !e.at("params").is_object()) continue;
    Json p = e.at("params");
    p.set("__fps", Json::number(fps > 0 ? fps : 30));
    if (layerTime) p.set("__time", Json::number(*layerTime));
    e.set("params", std::move(p));
  }
}

std::vector<double> deep_effect_time_offsets(const Json& effect) {
  if (!effect.at("type").is_string()) return {};
  const std::string_view t = effect.at("type").str();
  if (!is_temporal_deep(t)) return {};
  const Json params = doc::params_of(effect);
  const Params P{params};
  const double fps = fps_of(P);
  const double frame = 1 / fps;
  if (t == "timewarp") {
    const double f = timewarp_frame(P);
    const double f0 = std::floor(f + 1e-6);
    const double now = P.n("time");
    const double w = f - f0;
    if (P.e("method") == 0 || w < 1e-4) return {f0 / fps - now};
    return {f0 / fps - now, (f0 + 1) / fps - now};
  }
  if (t == "pixel-motion-blur" || t == "temporal-denoise") return {-frame, frame};
  if (t == "time-displacement") {
    const double m = P.n("maxDisplacement");
    return {-m, -m / 2, m / 2, m};
  }
  if (t == "time-difference") return {P.n("timeOffset")};
  if (t == "time-blend") {
    const double s = std::max(1.0, std::round(P.n("frameStep"))) * frame;
    return {-s, -2 * s, -3 * s, -4 * s};
  }
  if (t == "light-trails") {
    const double s = std::max(1.0, std::round(P.n("trailLength") / 4)) * frame;
    return {-s, -2 * s, -3 * s, -4 * s};
  }
  if (t == "datamosh") return {P.n("holdTime") - P.n("time"), -frame};
  if (t == "fluid-ink" || t == "reaction-diffusion" || t == "crystal-growth") return {P.n("startTime") - P.n("time")};
  if (t == "warp-stabilizer") {
    const double n = std::max(1.0, std::round(P.n("window")));
    const double h = std::max(1.0, std::round(n / 2));
    return {-n * frame, -h * frame, h * frame, n * frame};
  }
  if (t == "camera-shake-deblur") {
    const double n = std::clamp(std::round(P.n("neighbors")), 1.0, 3.0);
    return {-n * frame, n * frame};
  }
  if (t == "color-stabilizer") return {P.n("referenceTime") - P.n("__time")};
  return {};
}

std::string time_tap_id(std::string_view layerId, std::string_view effectId, std::size_t k) {
  std::string id(layerId);
  id += "__tt_";
  id += effectId;
  id += '_';
  id += std::to_string(k);
  return id;
}

std::vector<TimeTap> deep_time_taps(const RLayer& l) {
  std::vector<TimeTap> out;
  for (const Json& e : l.effects) {
    if (!effect_enabled(e)) continue;
    const std::vector<double> dts = deep_effect_time_offsets(e);
    const std::string eid = e.at("id").is_string() ? e.at("id").str() : std::string();
    for (std::size_t k = 0; k < dts.size() && k < 4; ++k) {
      if (!std::isfinite(dts[k])) continue;
      out.push_back({time_tap_id(l.id, eid, k), dts[k]});
    }
  }
  return out;
}

RLayer time_tap_layer(RLayer at, const RLayer& now, std::string id) {
  at.id = std::move(id);
  // Placed where the layer is now: its content is the other time's, its transform this frame's.
  at.x = now.x;
  at.y = now.y;
  at.rotation = now.rotation;
  at.scaleX = now.scaleX;
  at.scaleY = now.scaleY;
  at.anchorX = now.anchorX;
  at.anchorY = now.anchorY;
  at.matrix = now.matrix;
  at.depth = now.depth;
  at.world3d = now.world3d;
  at.quad3d = now.quad3d;
  at.cornerPin = now.cornerPin;
  at.skew = now.skew;
  at.skewAxis = now.skewAxis;
  at.opacity = 1;
  at.visible = true;
  // The source alone, hidden: drawn only when the effect chain reads it.
  at.effects.clear();
  at.fillOpacity.reset();
  at.motionSamples.clear();
  at.isMatteSource = true;
  at.matte.reset();
  at.matteSourceId.reset();
  at.isAdjustment = false;
  at.unported.clear();
  return at;
}

}  // namespace premation::scene
