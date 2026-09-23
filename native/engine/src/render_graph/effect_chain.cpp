// CompositionPass.runEffectsChain, ported. Branch order, target choice (f0/f1/
// f2 from the free pool), skip rules and the Effect-Opacity blend-back are the
// TS function's; the one-row-per-field effects are a data table here where the
// TS has one `else if` each — the rows are the same values in the same slots.
#include "effect_chain.hpp"

#include "passes.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <memory>
#include <cmath>
#include <numbers>
#include <string>
#include <unordered_map>

namespace premation::rg {
namespace {

// ── the packFxBlock table ────────────────────────────────────────────────────
//
// Each effect: its material and its param rows, four terms per row. A term is a
// literal ("0"), a field ("cx" — a boolean field packs as 1/0, exactly the TS
// `x ? 1 : 0`), or an element of a numeric field ("colA[0]", "stops[12]|1"
// = default 1 when absent).

struct Term {
  std::string name;
  double literal = 0;
  int index = -1;
  double def = 0;
  bool isLiteral = false;
};

/// What follows the rows in the block: packFxBlock's fxBox (the default), nothing
/// (the round-six colour packers), or fxBox + the working-space `color` param
/// (packPerspective / packSpotlight).
enum class Tail : std::uint8_t { box, none, boxColor };

struct FxEntry {
  Mat material;
  std::vector<std::array<Term, 4>> rows;
  Tail tail = Tail::box;
};

Term parse_term(std::string_view t) {
  Term out;
  double v = 0;
  const auto r = std::from_chars(std::to_address(t.begin()), std::to_address(t.end()), v);
  if (r.ec == std::errc() && r.ptr == std::to_address(t.end())) {
    out.isLiteral = true;
    out.literal = v;
    return out;
  }
  std::string_view name = t;
  const std::size_t bar = name.find('|');
  if (bar != std::string_view::npos) {
    const std::string_view d = name.substr(bar + 1);
    std::from_chars(std::to_address(d.begin()), std::to_address(d.end()), out.def);
    name = name.substr(0, bar);
  }
  const std::size_t br = name.find('[');
  if (br != std::string_view::npos) {
    int idx = 0;
    const std::string_view inner = name.substr(br + 1, name.size() - br - 2);
    std::from_chars(std::to_address(inner.begin()), std::to_address(inner.end()), idx);
    out.index = idx;
    name = name.substr(0, br);
  }
  out.name = std::string(name);
  return out;
}

FxEntry entry(Mat m, std::initializer_list<std::string_view> rows, Tail tail = Tail::box) {
  FxEntry e{m, {}, tail};
  for (const std::string_view row : rows) {
    std::array<Term, 4> terms{};
    std::size_t i = 0;
    std::size_t pos = 0;
    while (i < 4 && pos < row.size()) {
      while (pos < row.size() && row[pos] == ' ') ++pos;
      std::size_t end = row.find(' ', pos);
      if (end == std::string_view::npos) end = row.size();
      terms.at(i++) = parse_term(row.substr(pos, end - pos));
      pos = end;
    }
    while (i < 4) terms.at(i++).isLiteral = true;
    e.rows.push_back(terms);
  }
  return e;
}

const std::unordered_map<std::string, FxEntry>& fx_table() {
  static const std::unordered_map<std::string, FxEntry> table = [] {
    std::unordered_map<std::string, FxEntry> t;
    // Round six waves 2–3 (CompositionPass.ts, same rows).
    t.emplace("mirror", entry(Mat::MIRROR_MATERIAL, {"cx cy nx ny", "lw lh 0 0"}));
    t.emplace("offset", entry(Mat::OFFSET_MATERIAL, {"tx ty keep 0", "lw lh 0 0"}));
    t.emplace("bulge", entry(Mat::BULGE_MATERIAL, {"cx cy radius amount", "lw lh 0 0"}));
    t.emplace("twirl", entry(Mat::TWIRL_MATERIAL, {"cx cy radius maxAngle", "lw lh 0 0"}));
    t.emplace("spherize", entry(Mat::SPHERIZE_MATERIAL, {"cx cy radius amount", "lw lh 0 0"}));
    t.emplace("kaleidoscope", entry(Mat::KALEIDOSCOPE_MATERIAL, {"cx cy rot srcA", "seg scale lw lh"}));
    t.emplace("ripple", entry(Mat::RIPPLE_MATERIAL, {"cx cy radius amplitude", "frequency phase decay lw", "lh 0 0 0"}));
    t.emplace("chromatic-aberration",
              entry(Mat::CHROMATIC_ABERRATION_MATERIAL, {"amount linear lvx lvy", "falloffExp cx cy maxR", "lw lh 0 0"}));
    t.emplace("magnify", entry(Mat::MAGNIFY_MATERIAL, {"cx cy radius scale", "square feather lw lh"}));
    t.emplace("mosaic", entry(Mat::MOSAIC_MATERIAL, {"cols rows sharp 0", "lw lh 0 0"}));
    t.emplace("radial-blur", entry(Mat::RADIAL_BLUR_MATERIAL, {"cx cy amount zoom", "lw lh steps 0"}));
    t.emplace("corner-pin", entry(Mat::CORNER_PIN_MATERIAL, {"m[0] m[1] m[2] m[3]", "m[4] m[5] m[6] m[7]", "m[8] lw lh 0"}));
    t.emplace("transform", entry(Mat::TRANSFORM_FX_MATERIAL, {"px py scale rot", "opacity lw lh 0"}));
    t.emplace("linear-color-key", entry(Mat::LINEAR_COLOR_KEY_MATERIAL, {"kr kg kb mode", "tol soft keep keyHue", "keyLum 0 0 0"}));
    t.emplace("luma-key", entry(Mat::LUMA_KEY_MATERIAL, {"keyType cut tol soft"}));
    t.emplace("color-key", entry(Mat::COLOR_KEY_MATERIAL, {"kr kg kb tol", "soft 0 0 0"}));
    t.emplace("color-range", entry(Mat::COLOR_RANGE_MATERIAL, {"ky ku kv mode", "lo hi wl 0"}));
    t.emplace("extract", entry(Mat::EXTRACT_MATERIAL, {"channel black white blackSoft", "whiteSoft invert 0 0"}));
    t.emplace("spill-suppressor", entry(Mat::SPILL_SUPPRESSOR_MATERIAL, {"keyHue strength preserveLuma 0"}));
    t.emplace("wave-warp", entry(Mat::WAVE_WARP_MATERIAL, {"dx dy k phase", "height lw lh 0"}));
    t.emplace("directional-blur", entry(Mat::DIRECTIONAL_BLUR_MATERIAL, {"dx dy length steps", "lw lh 0 0"}));
    t.emplace("linear-wipe", entry(Mat::LINEAR_WIPE_MATERIAL, {"gx gy pos soft", "lw lh full 0"}));
    t.emplace("shift-channels", entry(Mat::SHIFT_CHANNELS_MATERIAL, {"a r g b"}));
    t.emplace("alpha-levels", entry(Mat::ALPHA_LEVELS_MATERIAL, {"inBlack span invGamma outBlack", "outWhite 0 0 0"}));
    t.emplace("solid-composite", entry(Mat::SOLID_COMPOSITE_MATERIAL, {"cr cg cb so", "co mode 0 0"}));
    t.emplace("channel-combiner", entry(Mat::CHANNEL_COMBINER_MATERIAL, {"mode 0 0 0"}));
    t.emplace("remove-color-matting", entry(Mat::REMOVE_COLOR_MATTING_MATERIAL, {"br bg bb floor", "strength 0 0 0"}));
    t.emplace("change-color",
              entry(Mat::CHANGE_COLOR_MATERIAL, {"th ts tl hT", "sT lT soft hueShift", "satScale lightScale invert 0"}));
    t.emplace("change-to-color",
              entry(Mat::CHANGE_TO_COLOR_MATERIAL, {"fh fs fl hT", "sT lT soft preserve", "dh ds dl 0"}));
    t.emplace("leave-color", entry(Mat::LEAVE_COLOR_MATERIAL, {"th tol soft strength"}));
    t.emplace("toner", entry(Mat::TONER_MATERIAL, {"stops[0] stops[1] stops[2] k", "stops[3] stops[4] stops[5] 0",
                                                   "stops[6] stops[7] stops[8] 0", "stops[9] stops[10] stops[11] 0",
                                                   "stops[12]|1 stops[13]|1 stops[14]|1 0"}));
    t.emplace("venetian-blinds", entry(Mat::VENETIAN_BLINDS_MATERIAL, {"cos sin pitch half", "soft lw lh full"}));
    t.emplace("radial-wipe", entry(Mat::RADIAL_WIPE_MATERIAL, {"cx cy start swept", "dir soft lw lh"}));
    t.emplace("iris-wipe",
              entry(Mat::IRIS_WIPE_MATERIAL, {"cx cy outer inner", "points rot feath useInner", "invert lw lh 0"}));
    t.emplace("line-sweep", entry(Mat::LINE_SWEEP_MATERIAL, {"nx ny n stag", "feath t invert 0", "lw lh 0 0"}));
    t.emplace("checkerboard", entry(Mat::CHECKERBOARD_MATERIAL, {"sizeW sizeH startX startY", "colA[0] colA[1] colA[2] opacity",
                                                                 "colB[0] colB[1] colB[2] 0", "lw lh 0 0"}));
    t.emplace("grid", entry(Mat::GRID_MATERIAL, {"pitchX pitchY offX offY", "thickness snap opacity 0",
                                                 "color[0] color[1] color[2] 0", "lw lh 0 0"}));
    t.emplace("four-color-gradient", entry(Mat::FOUR_COLOR_GRADIENT_MATERIAL, {"tl[0] tl[1] tl[2] blend", "tr[0] tr[1] tr[2] 0",
                                                                               "bl[0] bl[1] bl[2] 0", "br[0] br[1] br[2] 0",
                                                                               "lw lh 0 0"}));
    t.emplace("circle", entry(Mat::CIRCLE_MATERIAL, {"cx cy radius feather", "thickness opacity invert composite",
                                                     "color[0] color[1] color[2] 0", "lw lh 0 0"}));
    t.emplace("ellipse", entry(Mat::ELLIPSE_MATERIAL, {"cx cy rx ry", "rot thickness softness opacity",
                                                       "color[0] color[1] color[2] composite", "lw lh 0 0"}));
    t.emplace("find-edges", entry(Mat::FIND_EDGES_MATERIAL, {"invert blend 0 0", "lw lh 0 0"}));
    t.emplace("emboss", entry(Mat::EMBOSS_MATERIAL, {"dx dy k keep", "lw lh 0 0"}));
    t.emplace("color-emboss", entry(Mat::COLOR_EMBOSS_MATERIAL, {"ox oy k blend", "lw lh 0 0"}));
    t.emplace("halftone", entry(Mat::HALFTONE_MATERIAL, {"cell ca sa k", "inkR inkG inkB colorize", "paperR paperG paperB blend",
                                                         "lw lh 0 0"}));
    // Round eleven (roundElevenFx.ts).
    t.emplace("polar-coordinates", entry(Mat::POLAR_COORDINATES_FX_MATERIAL, {"lw lh t conv"}));
    t.emplace("optics-compensation", entry(Mat::OPTICS_COMPENSATION_FX_MATERIAL, {"lw lh k reverse", "cx cy norm 0"}));
    t.emplace("warp", entry(Mat::WARP_FX_MATERIAL, {"lw lh style bend", "h v vert 0"}));
    t.emplace("page-turn", entry(Mat::PAGE_TURN_FX_MATERIAL, {"lw lh nx ny", "foldAt rad backA shade"}));
    t.emplace("split", entry(Mat::SPLIT_FX_MATERIAL, {"lw lh nx ny", "cx cy half 0"}));
    t.emplace("slant", entry(Mat::SLANT_FX_MATERIAL, {"lw lh slant vert", "anchor 0 0 0"}));
    t.emplace("smear", entry(Mat::SMEAR_FX_MATERIAL, {"lw lh fx fy", "vx vy radius el"}));
    t.emplace("rolling-shutter", entry(Mat::ROLLING_SHUTTER_FX_MATERIAL, {"lw lh sweep wobble", "flip vertical 0 0"}));
    t.emplace("flo-motion", entry(Mat::FLO_MOTION_FX_MATERIAL, {"lw lh k1x k1y", "k1a k2x k2y k2a", "twoSigma2 reachOverSigma 0 0"}));
    t.emplace("lens", entry(Mat::LENS_FX_MATERIAL, {"lw lh cx cy", "ballR pull 0 0"}));
    t.emplace("griddler", entry(Mat::GRIDDLER_FX_MATERIAL, {"lw lh tile sx", "sy cosR sinR 0"}));
    t.emplace("ball-action", entry(Mat::BALL_ACTION_FX_MATERIAL, {"lw lh g R", "jit seed 0 0"}));
    t.emplace("drizzle", entry(Mat::DRIZZLE_FX_MATERIAL, {"lw lh n spread", "bandW freq evolution seed", "amp 0 0 0"}));
    t.emplace("jaws", entry(Mat::JAWS_FX_MATERIAL, {"lw lh ux uy", "sep tw th 0"}));
    t.emplace("pixel-polly", entry(Mat::PIXEL_POLLY_FX_MATERIAL, {"lw lh t cell", "fx fy maxFly grav", "spin seed fade cols"}));
    t.emplace("twister", entry(Mat::TWISTER_FX_MATERIAL, {"lw lh t axisY", "twist 0 0 0"}));
    t.emplace("card-dance", entry(Mat::CARD_DANCE_FX_MATERIAL, {"lw lh rows cols", "amt rot phase maxOff"}));
    t.emplace("unmult", entry(Mat::UNMULT_FX_MATERIAL, {"thresh boost 0 0"}));
    t.emplace("cc-composite", entry(Mat::CC_COMPOSITE_FX_MATERIAL, {"mix mode rgbOnly 0"}));
    t.emplace("cc-scatterize", entry(Mat::CC_SCATTERIZE_FX_MATERIAL, {"lw lh amt twist", "windX windY seed 0"}));
    t.emplace("radial-fast-blur", entry(Mat::RADIAL_FAST_BLUR_FX_MATERIAL, {"lw lh cx cy", "amt mode 0 0"}));
    t.emplace("scale-wipe", entry(Mat::SCALE_WIPE_FX_MATERIAL, {"lw lh cx cy", "ux uy wipeEdge stretch", "maxDist 0 0 0"}));
    t.emplace("texturize", entry(Mat::TEXTURIZE_FX_MATERIAL, {"lw lh pattern gain", "lx ly s 0"}));
    t.emplace("threads", entry(Mat::THREADS_FX_MATERIAL, {"lw lh th period", "dk 0 0 0"}));
    t.emplace("hex-tile", entry(Mat::HEX_TILE_FX_MATERIAL, {"lw lh R bd"}));
    // Round six colour ports + the Perspective / Channel families (own packers, same rows).
    t.emplace("vignette", entry(Mat::VIGNETTE_MATERIAL, {"amount inner feather roundness", "cx cy aspect 0"}));
    t.emplace("black-and-white", entry(Mat::BLACK_AND_WHITE_MATERIAL, {"reds yellows greens cyans", "blues magentas tintOn tintH",
                                                                      "tintS 0 0 0"}, Tail::none));
    t.emplace("tritone", entry(Mat::TRITONE_MATERIAL, {"sr sg sb blend", "mr mg mb 0", "hr hg hb 0"}, Tail::none));
    t.emplace("photo-filter", entry(Mat::PHOTO_FILTER_MATERIAL, {"r g b density", "preserveLuminosity 0 0 0"}, Tail::none));
    t.emplace("threshold", entry(Mat::THRESHOLD_MATERIAL, {"level 0 0 0"}, Tail::none));
    t.emplace("vibrance", entry(Mat::VIBRANCE_MATERIAL, {"vibrance saturation 0 0"}, Tail::none));
    t.emplace("arithmetic", entry(Mat::ARITHMETIC_MATERIAL, {"operator r g b", "clip 0 0 0"}, Tail::none));
    t.emplace("bend", entry(Mat::BEND_MATERIAL, {"angleRad style aspect holdOutside", "topX topY baseX baseY"}));
    t.emplace("sphere", entry(Mat::SPHERE_MATERIAL, {"radius rotXRad rotYRad shading", "aspect rotZRad 0 0"}, Tail::boxColor));
    t.emplace("cylinder", entry(Mat::CYLINDER_MATERIAL, {"radius rotRad shading 0", "0 0 0 0"}, Tail::boxColor));
    t.emplace("spotlight", entry(Mat::SPOTLIGHT_MATERIAL, {"fromX fromY toX toY", "coneHalfRad softness intensity ambient",
                                                          "aspect lightOnly reach 0"}, Tail::boxColor));
    return t;
  }();
  return table;
}

/// Rounds twelve + fifteen single-pass effects: the entry's `p` rows verbatim.
const std::unordered_map<std::string, Mat>& p_table() {
  static const std::unordered_map<std::string, Mat> t = {
      {"turbulent-displace", Mat::TURBULENT_DISPLACE_FX_MATERIAL}, {"curl-noise", Mat::CURL_NOISE_FX_MATERIAL},
      {"roughen-edges", Mat::ROUGHEN_EDGES_FX_MATERIAL}, {"scatter", Mat::SCATTER_FX_MATERIAL},
      {"colorama", Mat::COLORAMA_FX_MATERIAL}, {"selective-color", Mat::SELECTIVE_COLOR_FX_MATERIAL},
      {"turbulent-noise", Mat::TURBULENT_NOISE_FX_MATERIAL}, {"add-grain", Mat::ADD_GRAIN_FX_MATERIAL},
      {"median", Mat::MEDIAN_FX_MATERIAL}, {"dust-scratches", Mat::MEDIAN_FX_MATERIAL},
      {"block-dissolve", Mat::BLOCK_DISSOLVE_FX_MATERIAL}, {"gradient-wipe", Mat::GRADIENT_WIPE_FX_MATERIAL},
      {"card-wipe", Mat::CARD_WIPE_FX_MATERIAL}, {"strobe-light", Mat::STROBE_LIGHT_FX_MATERIAL},
      {"burn-film", Mat::BURN_FILM_FX_MATERIAL}, {"light-wipe", Mat::LIGHT_WIPE_FX_MATERIAL},
      {"grid-wipe", Mat::GRID_WIPE_FX_MATERIAL}, {"noise-alpha", Mat::NOISE_ALPHA_FX_MATERIAL},
      {"brush-strokes", Mat::BRUSH_STROKES_FX_MATERIAL}, {"bilateral-blur", Mat::BILATERAL_BLUR_FX_MATERIAL},
      {"smart-blur", Mat::SMART_BLUR_FX_MATERIAL}, {"camera-lens-blur", Mat::CAMERA_LENS_BLUR_FX_MATERIAL},
      {"mesh-warp", Mat::MESH_WARP_FX_MATERIAL}, {"liquify", Mat::LIQUIFY_FX_MATERIAL},
      {"bezier-warp", Mat::BEZIER_WARP_FX_MATERIAL}, {"cell-pattern", Mat::CELL_PATTERN_FX_MATERIAL},
      {"radio-waves", Mat::RADIO_WAVES_FX_MATERIAL}, {"light-burst", Mat::LIGHT_BURST_FX_MATERIAL},
      {"write-on", Mat::WRITE_ON_FX_MATERIAL}, {"star-burst", Mat::STAR_BURST_FX_MATERIAL},
      {"snowfall", Mat::SNOWFALL_FX_MATERIAL}, {"rainfall", Mat::RAINFALL_FX_MATERIAL},
      {"beam-path", Mat::BEAM_PATH_FX_MATERIAL},
      // round fifteen
      {"cc-tiler", Mat::CC_TILER_FX_MATERIAL}, {"ripple-pulse", Mat::RIPPLE_PULSE_FX_MATERIAL},
      {"radial-scale-wipe", Mat::RADIAL_SCALE_WIPE_FX_MATERIAL}, {"glass-wipe", Mat::GLASS_WIPE_FX_MATERIAL},
      {"image-wipe", Mat::IMAGE_WIPE_FX_MATERIAL}, {"color-difference-key", Mat::COLOR_DIFFERENCE_KEY_FX_MATERIAL},
      {"wire-removal", Mat::WIRE_REMOVAL_FX_MATERIAL}, {"broadcast-colors", Mat::BROADCAST_COLORS_FX_MATERIAL},
      {"noise-hls", Mat::NOISE_HLS_FX_MATERIAL}, {"block-load", Mat::BLOCK_LOAD_FX_MATERIAL},
      {"kernel", Mat::KERNEL_FX_MATERIAL}, {"3d-glasses", Mat::GLASSES_3D_FX_MATERIAL},
      {"fractal", Mat::FRACTAL_FX_MATERIAL}, {"particle-systems", Mat::PARTICLE_SYSTEMS_FX_MATERIAL},
      {"cc-bubbles", Mat::BUBBLES_FX_MATERIAL},
  };
  return t;
}

/// Rounds twelve + thirteen two-texture effects: layer + a Gaussian copy at binding 3.
const std::unordered_map<std::string, Mat>& field_table() {
  static const std::unordered_map<std::string, Mat> t = {
      {"cartoon", Mat::CARTOON_FX_MATERIAL}, {"inner-shadow", Mat::INTERIOR_STYLE_FX_MATERIAL},
      {"inner-glow", Mat::INTERIOR_STYLE_FX_MATERIAL}, {"satin", Mat::SATIN_FX_MATERIAL}, {"bevel", Mat::BEVEL_FX_MATERIAL}};
  return t;
}

double term_value(const Fx& fx, const Term& t) {
  if (t.isLiteral) return t.literal;
  if (t.index >= 0) return fx.at(t.name, static_cast<std::size_t>(t.index), t.def);
  return fx.num(t.name, t.def);
}

std::vector<Vec4> p_rows(const Fx& fx) {
  std::vector<Vec4> rows;
  const auto p = fx.nums("p");
  for (std::size_t i = 0; i + 3 < p.size(); i += 4) rows.push_back({p[i], p[i + 1], p[i + 2], p[i + 3]});
  return rows;
}

/// deepGlowKernel.ts.
struct Octave {
  double sigma, delta;
};
std::vector<Octave> deep_glow_octaves(double radius, double octaves) {
  const int k = std::max(1, static_cast<int>(std::floor(octaves + 0.5)));
  std::vector<Octave> out;
  double prev = 0;
  for (int i = 0; i < k; ++i) {
    const double sigma = radius / std::pow(2.0, k - 1 - i);
    out.push_back({sigma, std::sqrt(std::max(0.0, sigma * sigma - prev * prev))});
    prev = sigma;
  }
  return out;
}
double deep_glow_step(double sigma) { return std::max(1.0, std::ceil((4 * sigma) / 16)); }
double deep_glow_inv(double sigma) { return sigma <= 1e-3 ? 1e12 : 1 / (2 * sigma * sigma); }

/// renderableBox: where a renderable sits in the viewport, as a [0,1] rect.
Rect renderable_box(const PassContext& ctx, const api::Renderable* r) {
  const Rect v = ctx.viewport.visibleWorldRect;
  if (r == nullptr || v.width <= 0 || v.height <= 0) return {0, 0, 1, 1};
  return {(r->bounds.x - v.x) / v.width, (r->bounds.y - v.y) / v.height, r->bounds.width / v.width,
          r->bounds.height / v.height};
}

/// rampPoints (WebGPU: V is not flipped).
std::array<double, 4> ramp_points(double angleDeg, const Rect& box, double w, double h) {
  const double a = angleDeg * std::numbers::pi / 180;
  const double dx = std::cos(a);
  const double dy = std::sin(a);
  const double wPx = box.width * w;
  const double hPx = box.height * h;
  const double half = (std::abs(dx) * wPx + std::abs(dy) * hPx) / 2;
  const double cx = (box.x + box.width / 2) * w;
  const double cy = (box.y + box.height / 2) * h;
  return {(cx - dx * half) / w, (cy - dy * half) / h, (cx + dx * half) / w, (cy + dy * half) / h};
}

bool known_single(std::string_view t) {
  static constexpr auto kSpecial = std::to_array<std::string_view>({"gradient-ramp", "fractal-noise", "displacement-map", "compound-blur",
                                         "set-matte",     "motion-tile",   "fill",             "stroke",
                                         "sharpen",       "noise",         "apply-color-lut", "bevel-alpha",
                                         "bevel-edges",   "beam",          "light-sweep",      "lens-flare",
                                         "light-rays",   "keylight",      "simple-choker",    "matte-choker",
                                         "channel-blur", "minimax",       "cross-blur",       "unsharp-mask",
                                         "shadow-highlight", "equalize", "auto-levels",     "auto-contrast",
                                         "auto-color",   "plastic",       "glass",            "vector-blur",
                                         "radial-shadow", "plugin"});
  return std::ranges::find(kSpecial, t) != kSpecial.end();
}

}  // namespace

bool effect_ported(const api::RenderEffect& e, std::string& why) {
  const std::string& t = e.type;
  const Fx fx(e);
  if (t == "blur") {
    if (fx.num("blades") >= 3) { why = "effect blur (polygonal bokeh)"; return false; }
    if (fx.has("cocCorners")) { why = "effect blur (planar CoC)"; return false; }
    return true;
  }
  if (t == "glow" || t == "drop-shadow" || t == "deep-glow" || t == "gaussian-blur" || t == "fast-box-blur") return true;
  if (fx_table().count(t) != 0 || p_table().count(t) != 0 || field_table().count(t) != 0 || known_single(t)) return true;
  why = "effect " + t;
  return false;
}

ChainResult run_effects_chain(PassContext& ctx, const std::vector<api::RenderEffect>& effects, TexRef input,
                              std::span<const std::string_view> pool, const ById& byId, std::string_view selfId,
                              MapLayerSource& maps, const FxSpace* space) {
  const ViewportState& vp = ctx.viewport;
  const Rect targetUv{0, 0, 1, 1};
  const Mat3 mvp = screen_mvp();
  const double kx = space != nullptr ? space->pxToTexelX : 1;
  const double ky = space != nullptr ? space->pxToTexelY : 1;
  const auto self = byId.find(selfId);
  const Rect fxBox = space != nullptr ? space->box : renderable_box(ctx, self == byId.end() ? nullptr : self->second);
  const double pw = vp.pixelWidth;
  const double ph = vp.pixelHeight;
  const bool poolHasMatte = std::ranges::find(pool, kMatteTarget) != pool.end();

  TexRef curTex = std::move(input);
  std::string_view curName = pool[0];
  auto texOf = [&](std::string_view n) { return ctx.target(n)->tex(); };
  auto one = [&](Mat m, std::span<const float> u, const TexRef& tex, Blend blend = Blend::normal) -> Commands {
    Commands c;
    DrawItem& it = c.add(m, blend, u);
    it.texture = tex;
    it.sampler = ctx.linear_clamp();
    return c;
  };
  auto blurPass = [&](const TexRef& src, std::string_view dest, double dirX, double dirY, double radius) -> TexRef {
    const Commands c = one(Mat::BLUR_MATERIAL, pack_blur(ctx.packer(), mvp, targetUv, dirX, dirY, radius), src);
    ctx.draw_into(dest, c, true);
    return texOf(dest);
  };

  struct BlendBack {
    TexRef tex;
    std::string_view name;
    double amount;
  };
  std::optional<BlendBack> blendBack;
  auto land = [&] {
    if (!blendBack) return;
    const BlendBack b = *blendBack;
    blendBack.reset();
    if (b.name == curName) return;
    std::string_view dest;
    for (const auto n : pool) {
      if (n != b.name && n != curName) { dest = n; break; }
    }
    if (dest.empty()) return;
    const std::array<Vec4, 1> rows{{{b.amount, 0, 0, 0}}};
    Commands c = one(Mat::EFFECT_OPACITY_FX_MATERIAL, pack_fx_block(ctx.packer(), mvp, targetUv, rows, fxBox), curTex);
    c.last().mask = b.tex;
    ctx.draw_into(dest, c, true);
    curTex = texOf(dest);
    curName = dest;
  };

  for (const auto& e : effects) {
    land();
    const Fx fx(e);
    const std::string_view type = fx.type();
    const double radiusPx = fx.num("radiusPx");
    if ((type == "blur" || type == "glow") && radiusPx <= 0 && (type != "glow" || fx.num("spreadPx") <= 0)) continue;
    if (type == "drop-shadow" && radiusPx <= 0 && fx.num("spreadPx") <= 0 && std::abs(fx.num("offsetX")) < 0.01 &&
        std::abs(fx.num("offsetY")) < 0.01) continue;
    if (type == "sharpen" && std::abs(fx.num("amount")) < 0.0001) continue;
    if ((type == "gaussian-blur" || type == "fast-box-blur") && radiusPx <= 0) continue;
    if (type == "noise" && std::abs(fx.num("amount")) < 0.0001) continue;
    if (type == "spotlight" && fx.num("ambient") >= 0.999 && std::abs(fx.num("intensity")) < 0.0001) continue;

    std::vector<std::string_view> free;
    for (const auto n : pool) {
      if (n != curName) free.push_back(n);
    }
    if (free.size() < 2) continue;
    const std::string_view f0 = free[0];
    const std::string_view f1 = free[1];
    const std::string_view f2 = free.size() > 2 ? free[2] : std::string_view{};
    if (fx.has("effectOpacity") && fx.num("effectOpacity") < 1 && type != "plugin") {
      blendBack = BlendBack{curTex, curName, std::max(0.0, fx.num("effectOpacity"))};
    }

    if (type == "blur" || type == "glow" || type == "drop-shadow") {
      const double rPx = type == "glow" ? radiusPx * 1.15 : radiusPx;
      const double spreadPx = type == "blur" ? 0 : fx.num("spreadPx");
      TexRef blurred = curTex;
      TexRef wide;
      TexRef blurSrc = curTex;
      if (spreadPx > 0) {
        const std::string_view dilateDest = f2.empty() ? f0 : f2;
        const Commands d = one(Mat::STROKE_MATERIAL,
                               pack_stroke(ctx.packer(), mvp, targetUv, Color::white(), spreadPx * ((kx + ky) * 0.5), kx / pw,
                                           ky / ph, 3),
                               curTex);
        ctx.draw_into(dilateDest, d, true);
        blurSrc = texOf(dilateDest);
      }
      if (rPx > 0) {
        const TexRef h = blurPass(blurSrc, f1, 1.0 / pw, 0, rPx * kx);
        blurred = blurPass(h, f0, 0, 1.0 / ph, rPx * ky);
        if (type == "glow" && !f2.empty() && rPx >= 6) {
          const double wideR = rPx * 2.2;
          const TexRef wh = blurPass(blurSrc, f1, 1.0 / pw, 0, wideR * kx);
          wide = blurPass(wh, f2, 0, 1.0 / ph, wideR * ky);
        }
      } else if (spreadPx > 0) {
        blurred = blurSrc;
      }
      Commands comp;
      if (type == "blur") {
        emit_textured(ctx, comp, mvp, Color::white(), 1, Blend::normal, blurred, ctx.linear_clamp(), targetUv, kIdentityColor, true);
      } else if (type == "glow") {
        Color gc{120.0 / 255, 180.0 / 255, 1, 0.9};
        (void)fx.color("color", gc);
        if (wide) emit_silhouette(ctx, comp, mvp, gc, 0.4, Blend::screen, wide, ctx.linear_clamp(), targetUv);
        emit_silhouette(ctx, comp, mvp, gc, 1, Blend::screen, blurred, ctx.linear_clamp(), targetUv);
        emit_textured(ctx, comp, mvp, Color::white(), 1, Blend::normal, curTex, ctx.linear_clamp(), targetUv, kIdentityColor, true);
      } else {
        const Rect v = vp.visibleWorldRect;
        const Mat3 shadowMvp =
            space != nullptr
                ? mul(mvp, model_from_rect({fx.num("offsetX") * kx / pw, fx.num("offsetY") * ky / ph, 1, 1}))
                : mvp_for(vp, model_from_rect({v.x + fx.num("offsetX"), v.y + fx.num("offsetY"), v.width, v.height}));
        Color sc{0, 0, 0, 0.55};
        (void)fx.color("color", sc);
        emit_silhouette(ctx, comp, shadowMvp, sc, 1, Blend::normal, blurred, ctx.linear_clamp(), targetUv);
        emit_textured(ctx, comp, mvp, Color::white(), 1, Blend::normal, curTex, ctx.linear_clamp(), targetUv, kIdentityColor, true);
      }
      ctx.draw_into(f1, comp, true);
      curTex = texOf(f1);
      curName = f1;
      continue;
    }

    if (type == "deep-glow") {
      const auto octs = deep_glow_octaves(radiusPx, f2.empty() ? 1 : fx.num("octaves"));
      const double weight = 1.0 / static_cast<double>(octs.size());
      const auto chroma = fx.nums("chroma");
      const auto aspect = fx.nums("aspect");
      const double c0 = chroma.size() > 2 ? chroma[0] : 1, c1 = chroma.size() > 2 ? chroma[1] : 1, c2 = chroma.size() > 2 ? chroma[2] : 1;
      const double maxChroma = std::max({c0, c1, c2});
      auto dg = [&](const TexRef& src, std::string_view dest, double dirX, double dirY, double sigma, bool first) {
        const double step = deep_glow_step(sigma * maxChroma);
        const std::array<Vec4, 2> rows{{{dirX * step / pw, dirY * step / ph, step, first ? fx.num("threshold") : 0},
                                        {deep_glow_inv(sigma * c0), deep_glow_inv(sigma * c1), deep_glow_inv(sigma * c2), first ? 1.0 : 0.0}}};
        const Commands c = one(Mat::DEEP_GLOW_BLUR_FX_MATERIAL, pack_fx_block(ctx.packer(), mvp, targetUv, rows, fxBox), src);
        ctx.draw_into(dest, c, true);
        return texOf(dest);
      };
      TexRef level = curTex;
      TexRef acc;
      for (std::size_t k = 0; k < octs.size(); ++k) {
        const double d = octs[k].delta;
        const TexRef h = dg(level, f1, 1, 0, d * (aspect.size() > 1 ? aspect[0] : 1) * kx, k == 0);
        level = dg(h, f0, 0, 1, d * (aspect.size() > 1 ? aspect[1] : 1) * ky, false);
        if (!f2.empty()) {
          const std::array<Vec4, 1> rows{{{weight, 0, 0, 0}}};
          const Commands c = one(Mat::DEEP_GLOW_ACC_FX_MATERIAL, pack_fx_block(ctx.packer(), mvp, targetUv, rows, fxBox), level, Blend::add);
          ctx.draw_into(f2, c, k == 0);
          acc = texOf(f2);
        } else {
          acc = level;
        }
      }
      if (acc) {
        const auto tint = fx.nums("tint");
        const std::array<Vec4, 2> rows{{{fx.num("gain"), tint.size() > 2 ? tint[0] : 1, tint.size() > 2 ? tint[1] : 1, tint.size() > 2 ? tint[2] : 1},
                                        {fx.num("tintAmount"), fx.flag("glowOnly") ? 1.0 : 0.0, fx.flag("dither") ? pw : 0.0, ph}}};
        Commands c = one(Mat::DEEP_GLOW_COMPOSITE_FX_MATERIAL, pack_fx_block(ctx.packer(), mvp, targetUv, rows, fxBox), curTex);
        c.last().mask = acc;
        ctx.draw_into(f1, c, true);
        curTex = texOf(f1);
        curName = f1;
      }
      continue;
    }

    if (type == "gaussian-blur" || type == "fast-box-blur") {
      TexRef src = curTex;
      std::string_view outName;
      const double dims = fx.num("dims");
      if (dims != 2) {
        src = blurPass(src, f1, 1.0 / pw, 0, radiusPx * kx);
        outName = f1;
      }
      if (dims != 1) {
        src = blurPass(src, f0, 0, 1.0 / ph, radiusPx * ky);
        outName = f0;
      }
      if (!outName.empty()) {
        curTex = src;
        curName = outName;
      }
      continue;
    }

    // A run of separable passes, each reading the chain's current texture and
    // writing whichever of f0/f1 is not its source (matte morphology, round ten).
    TexRef src = curTex;
    std::string_view srcName = curName;
    const auto pass2 = [&](Mat m, std::span<const Vec4> rows) {
      const std::string_view dest = srcName == f0 ? f1 : f0;
      const Commands c = one(m, pack_fx_block(ctx.packer(), mvp, targetUv, rows, fxBox), src);
      ctx.draw_into(dest, c, true);
      src = texOf(dest);
      srcName = dest;
    };
    const auto settle = [&] {
      if (srcName != curName) {
        curTex = src;
        curName = srcName;
      }
    };
    if (type == "keylight" || type == "simple-choker" || type == "matte-choker") {
      const double lw = fx.num("lw");
      const double lh = fx.num("lh");
      const auto morph = [&](double radius, bool erode, double border) {
        const double r = std::min(50.0, std::floor(radius + 0.5));
        if (r <= 0) return;
        const std::array<Vec4, 2> h{{{1, 0, r, erode ? 1.0 : 0.0}, {lw, lh, border, 0}}};
        pass2(Mat::ALPHA_MORPH_MATERIAL, h);
        const std::array<Vec4, 2> v{{{0, 1, r, erode ? 1.0 : 0.0}, {lw, lh, border, 0}}};
        pass2(Mat::ALPHA_MORPH_MATERIAL, v);
      };
      const auto box = [&](double radius) {
        const double r = std::min(50.0, std::floor(radius + 0.5));
        if (r <= 0) return;
        const std::array<Vec4, 2> h{{{1, 0, r, 0}, {lw, lh, 2, 0}}};
        pass2(Mat::ALPHA_BOX_MATERIAL, h);
        const std::array<Vec4, 2> v{{{0, 1, r, 0}, {lw, lh, 2, 0}}};
        pass2(Mat::ALPHA_BOX_MATERIAL, v);
      };
      if (type == "keylight") {
        const std::array<Vec4, 3> rows{{{fx.num("kr"), fx.num("kg"), fx.num("kb"), fx.num("balance")},
                                        {fx.num("gain"), fx.num("clipBlack"), fx.num("clipWhite"), fx.num("despill")},
                                        {fx.num("p"), fx.num("a"), fx.num("b"), fx.num("denom")}}};
        pass2(Mat::KEYLIGHT_MATERIAL, rows);
        const double choke = fx.num("chokePx");
        if (choke != 0) morph(std::abs(choke), choke > 0, 0);
        if (fx.num("softPx") > 0) box(fx.num("softPx"));
      } else if (type == "simple-choker") {
        morph(fx.num("radius"), fx.flag("erode"), 1);
      } else {
        const int iterations = static_cast<int>(fx.num("iterations"));
        for (int i = 0; i < iterations; ++i) {
          if (fx.num("spread") > 0) morph(fx.num("spread"), false, 2);
          if (fx.num("softness") > 0) box(fx.num("softness"));
          if (fx.num("choke") > 0) morph(fx.num("choke"), true, 2);
        }
      }
      settle();
      continue;
    }
    if (type == "channel-blur" || type == "minimax" || type == "cross-blur") {
      const double lw = fx.num("lw");
      const double lh = fx.num("lh");
      if (type == "channel-blur") {
        const double r0 = std::min(128.0, fx.num("r")), r1 = std::min(128.0, fx.num("g")), r2 = std::min(128.0, fx.num("b")),
                     r3 = std::min(128.0, fx.num("a"));
        const double rep = fx.flag("repeatEdge") ? 1 : 0;
        if (fx.num("dims") != 2) {
          const std::array<Vec4, 3> rows{{{1, 0, r0, r1}, {r2, r3, rep, 0}, {lw, lh, 0, 0}}};
          pass2(Mat::CHANNEL_BOX_MATERIAL, rows);
        }
        if (fx.num("dims") != 1) {
          const std::array<Vec4, 3> rows{{{0, 1, r0, r1}, {r2, r3, rep, 0}, {lw, lh, 0, 0}}};
          pass2(Mat::CHANNEL_BOX_MATERIAL, rows);
        }
      } else if (type == "cross-blur") {
        const double rep = fx.flag("repeatEdge") ? 1 : 0;
        const double rx = std::min(128.0, fx.num("rx"));
        const double ry = std::min(128.0, fx.num("ry"));
        if (rx > 0) {
          const std::array<Vec4, 3> rows{{{1, 0, rx, rx}, {rx, rx, rep, 0}, {lw, lh, 0, 0}}};
          pass2(Mat::CHANNEL_BOX_MATERIAL, rows);
        }
        if (ry > 0) {
          const std::array<Vec4, 3> rows{{{0, 1, ry, ry}, {ry, ry, rep, 0}, {lw, lh, 0, 0}}};
          pass2(Mat::CHANNEL_BOX_MATERIAL, rows);
        }
      } else {
        const double r = std::min(100.0, fx.num("radius"));
        const double dir = fx.num("dir");
        const auto sep = [&](bool takeMax) {
          if (dir != 2) {
            const std::array<Vec4, 2> rows{{{1, 0, r, takeMax ? 1.0 : 0.0}, {lw, lh, fx.num("mask"), 0}}};
            pass2(Mat::MINMAX_MATERIAL, rows);
          }
          if (dir != 1) {
            const std::array<Vec4, 2> rows{{{0, 1, r, takeMax ? 1.0 : 0.0}, {lw, lh, fx.num("mask"), 0}}};
            pass2(Mat::MINMAX_MATERIAL, rows);
          }
        };
        const double op = fx.num("op");
        if (op == 0) sep(true);
        else if (op == 1) sep(false);
        else if (op == 2) { sep(true); sep(false); }
        else { sep(false); sep(true); }
      }
      settle();
      continue;
    }
    if (type == "unsharp-mask" || type == "shadow-highlight") {
      const TexRef h = blurPass(curTex, f1, 1.0 / pw, 0, fx.num("sigmaPx") * kx);
      const TexRef blurred = blurPass(h, f0, 0, 1.0 / ph, fx.num("sigmaPx") * ky);
      const std::array<Vec4, 1> rows{{type == "unsharp-mask" ? Vec4{fx.num("amount"), fx.num("threshold"), 0, 0}
                                                             : Vec4{fx.num("shadow"), fx.num("highlight"), fx.num("invWidth"), 0}}};
      Commands c = one(type == "unsharp-mask" ? Mat::UNSHARP_MASK_MATERIAL : Mat::SHADOW_HIGHLIGHT_MATERIAL,
                       pack_fx_block(ctx.packer(), mvp, targetUv, rows, fxBox), curTex);
      c.last().mask = blurred;
      ctx.draw_into(f1, c, true);
      curTex = texOf(f1);
      curName = f1;
      continue;
    }
    if (type == "equalize" || type == "auto-levels" || type == "auto-contrast" || type == "auto-color") {
      const std::array<Vec4, 1> hr{{{fx.num("lw"), fx.num("lh"), 44, 0}}};
      const Commands hc = one(Mat::FX_HISTOGRAM_FX_MATERIAL, pack_fx_block(ctx.packer(), mvp, targetUv, hr, fxBox), curTex);
      ctx.draw_into_sized(kFxHist, hc, true, 256, 1);
      const auto rows = p_rows(fx);
      const Commands tc = one(Mat::FX_AUTO_TABLE_FX_MATERIAL, pack_fx_block(ctx.packer(), mvp, targetUv, rows, fxBox), texOf(kFxHist));
      ctx.draw_into_sized(kFxLut, tc, true, 256, 1);
      const std::array<Vec4, 1> ar{{{0, 0, 0, 0}}};
      Commands ac = one(Mat::FX_AUTO_APPLY_FX_MATERIAL, pack_fx_block(ctx.packer(), mvp, targetUv, ar, fxBox), curTex);
      ac.last().mask = texOf(kFxLut);
      ctx.draw_into(f0, ac, true);
      curTex = texOf(f0);
      curName = f0;
      continue;
    }
    if (type == "plastic" || type == "glass" || type == "vector-blur" || type == "radial-shadow") {
      TexRef ref = curTex;
      std::string_view refName = curName;
      const double sigma = fx.num("sigmaPx");
      const auto gaussian = [&](const TexRef& s) {
        const TexRef h = blurPass(s, f1, 1.0 / pw, 0, sigma * kx);
        return blurPass(h, f0, 0, 1.0 / ph, sigma * ky);
      };
      if (type == "radial-shadow") {
        const std::array<Vec4, 2> pr{{{fx.num("lw"), fx.num("lh"), fx.num("lx"), fx.num("ly")}, {fx.num("proj"), 0, 0, 0}}};
        const Commands pc = one(Mat::RADIAL_SHADOW_PROJECT_FX_MATERIAL, pack_fx_block(ctx.packer(), mvp, targetUv, pr, fxBox), curTex);
        ctx.draw_into(f0, pc, true);
        ref = texOf(f0);
        refName = f0;
        if (sigma > 0) ref = gaussian(ref);
      } else if (sigma > 0) {
        ref = gaussian(curTex);
        refName = f0;
      }
      const std::string_view dest = refName == f1 ? f0 : f1;
      std::array<Vec4, 2> rows{};
      Mat m = Mat::RADIAL_SHADOW_FX_MATERIAL;
      if (type == "plastic") {
        rows = {{{fx.num("lw"), fx.num("lh"), fx.num("bump"), fx.num("gain")}, {fx.at("l", 0), fx.at("l", 1), fx.at("l", 2), fx.num("specGain")}}};
        m = Mat::PLASTIC_FX_MATERIAL;
      } else if (type == "glass") {
        rows = {{{fx.num("lw"), fx.num("lh"), fx.num("dispK"), fx.num("hgt")}, {fx.num("lx"), fx.num("ly"), fx.num("gain"), fx.num("shine")}}};
        m = Mat::GLASS_FX_MATERIAL;
      } else if (type == "vector-blur") {
        rows = {{{fx.num("lw"), fx.num("lh"), fx.num("amount"), fx.num("K")}, {fx.num("cosR"), fx.num("sinR"), fx.num("step"), 0}}};
        m = Mat::VECTOR_BLUR_FX_MATERIAL;
      } else {
        rows = {{{fx.at("color", 0), fx.at("color", 1), fx.at("color", 2), fx.num("op")}, {fx.flag("shadowOnly") ? 1.0 : 0.0, 0, 0, 0}}};
      }
      Commands c = one(m, pack_fx_block(ctx.packer(), mvp, targetUv, rows, fxBox), curTex);
      c.last().mask = ref;
      ctx.draw_into(dest, c, true);
      curTex = texOf(dest);
      curName = dest;
      continue;
    }

    if (const auto fit = field_table().find(std::string(type)); fit != field_table().end()) {
      TexRef ref = curTex;
      std::string_view refName = curName;
      const double sigma = fx.num("sigmaPx");
      if (sigma > 0) {
        const TexRef h = blurPass(curTex, f1, 1.0 / pw, 0, sigma * kx);
        ref = blurPass(h, f0, 0, 1.0 / ph, sigma * ky);
        refName = f0;
      }
      const std::string_view dest = refName == f1 ? f0 : f1;
      const auto rows = p_rows(fx);
      Commands c = one(fit->second, pack_fx_block(ctx.packer(), mvp, targetUv, rows, fxBox), curTex);
      c.last().mask = ref;
      ctx.draw_into(dest, c, true);
      curTex = texOf(dest);
      curName = dest;
      continue;
    }

    // Single-pass effects: cur → f0.
    Commands cmds;
    auto add = [&](Mat m, std::span<const float> u, const SamplerRef& smp) -> DrawItem& {
      DrawItem& it = cmds.add(m, Blend::normal, u);
      it.texture = curTex;
      it.sampler = smp;
      return it;
    };
    if (const auto t = fx_table().find(std::string(type)); t != fx_table().end()) {
      std::vector<Vec4> rows;
      for (const auto& row : t->second.rows) {
        rows.push_back({term_value(fx, row[0]), term_value(fx, row[1]), term_value(fx, row[2]), term_value(fx, row[3])});
      }
      Packer pk = ctx.packer();
      pk.mat3(mvp).rect(targetUv);
      for (const Vec4& row : rows) pk.vec4(row);
      if (t->second.tail != Tail::none) pk.rect(fxBox);
      if (t->second.tail == Tail::boxColor) {
        Color c{1, 1, 1, 1};
        (void)fx.color("color", c);
        pk.working_rgba(c);
      }
      add(t->second.material, pk.span(), ctx.linear_clamp());
    } else if (type == "bevel-alpha" || type == "bevel-edges") {
      const double lr = fx.num("lightRad");
      Color c{1, 1, 1, 1};
      (void)fx.color("color", c);
      Packer pk = ctx.packer();
      pk.mat3(mvp).rect(targetUv).vec4(fx.num("thickness"), std::cos(lr), std::sin(lr), fx.num("intensity"));
      pk.vec4(1 / pw, 1 / ph, 0, 0).rect(fxBox).working_rgba(c);
      add(type == "bevel-alpha" ? Mat::BEVEL_ALPHA_MATERIAL : Mat::BEVEL_EDGES_MATERIAL, pk.span(), ctx.linear_clamp());
    } else if (type == "beam") {
      const double bx0 = fxBox.x + fx.num("startX") * fxBox.width;
      const double by0 = fxBox.y + fx.num("startY") * fxBox.height;
      const double bx1 = fxBox.x + fx.num("endX") * fxBox.width;
      const double by1 = fxBox.y + fx.num("endY") * fxBox.height;
      const double len = fx.num("length");
      const double t0 = std::max(0.0, len - 0.35);
      const double k = (kx / pw + ky / ph) / 2;
      const double coreR = std::max(0.5, fx.num("thickness")) * 0.5 * k;
      Color c{1, 1, 1, 1};
      (void)fx.color("color", c);
      Packer pk = ctx.packer();
      pk.mat3(mvp).rect(targetUv).vec4(bx0 + (bx1 - bx0) * t0, by0 + (by1 - by0) * t0, bx0 + (bx1 - bx0) * len, by0 + (by1 - by0) * len);
      pk.vec4(coreR, coreR * (1 + fx.num("softness") * 3), k, 0).working_rgba(c);
      add(Mat::BEAM_MATERIAL, pk.span(), ctx.linear_clamp());
    } else if (type == "light-sweep") {
      if (fx.num("intensity") > 0 && fx.num("sweepWidth") > 0) {
        const double rad = fx.num("angle") * std::numbers::pi / 180;
        const double cs = std::cos(rad);
        const double sn = std::sin(rad);
        const double span = std::abs(fxBox.width * cs) + std::abs(fxBox.height * sn);
        const double cx = fxBox.x + fxBox.width * 0.5 + cs * (fx.num("position") - 0.5) * span;
        const double cy = fxBox.y + fxBox.height * 0.5 + sn * (fx.num("position") - 0.5) * span;
        const double k = (kx / pw + ky / ph) / 2;
        const double half = std::max(0.5, fx.num("sweepWidth")) * 0.5 * k;
        Color c{1, 1, 1, 1};
        (void)fx.color("color", c);
        Packer pk = ctx.packer();
        pk.mat3(mvp).rect(targetUv).vec4(cx - cs * half, cy - sn * half, cx + cs * half, cy + sn * half);
        pk.vec4(fx.num("softness"), fx.num("intensity"), fx.num("composite"), 0).working_rgba(c);
        add(Mat::LIGHT_SWEEP_MATERIAL, pk.span(), ctx.linear_clamp());
      }
    } else if (type == "lens-flare") {
      if (fx.num("brightness") > 0) {
        const double midX = fxBox.x + fxBox.width * 0.5;
        const double midY = fxBox.y + fxBox.height * 0.5;
        const double cx = midX + fx.num("centerX") * (kx / pw);
        const double cy = midY + fx.num("centerY") * (ky / ph);
        const double span = std::max(fxBox.width, fxBox.height);
        const double coreR = span * 0.06 * fx.num("scale");
        const double haloR = span * 0.35 * fx.num("scale");
        Color c{1, 1, 1, 1};
        (void)fx.color("color", c);
        Packer pk = ctx.packer();
        pk.mat3(mvp).rect(targetUv).vec4(cx, cy, midX, midY);
        pk.vec4(fx.num("brightness"), coreR, haloR, std::max(coreR * 0.12, 1e-6)).working_rgba(c);
        add(Mat::LENS_FLARE_MATERIAL, pk.span(), ctx.linear_clamp());
      }
    } else if (type == "light-rays") {
      if (fx.num("opacity") > 0 && fx.num("rayLength") > 0) {
        const double kxUv = kx / pw;
        const double kyUv = ky / ph;
        const double k = (kxUv + kyUv) / 2;
        const double cx = fxBox.x + fxBox.width * 0.5 + fx.num("centerX") * kxUv;
        const double cy = fxBox.y + fxBox.height * 0.5 + fx.num("centerY") * kyUv;
        const double sp = fx.num("spread");
        const double arc = sp > 1e-5 ? sp * std::numbers::pi * 2 : std::numbers::pi * 2;
        Color c{1, 1, 1, 1};
        (void)fx.color("color", c);
        Packer pk = ctx.packer();
        pk.mat3(mvp).rect(targetUv).vec4(cx, cy, fx.num("rayLength") * k, std::min(128.0, fx.num("rayCount")));
        pk.vec4(fx.num("opacity"), fx.num("falloff"), fx.num("rotation"), arc);
        pk.vec4(fx.num("seed"), fx.num("composite"), 0, 0).working_rgba(c);
        add(Mat::LIGHT_RAYS_MATERIAL, pk.span(), ctx.linear_clamp());
      }
    } else if (type == "plugin") {
      // A plugin effect is just another material: the host-validated WGSL the
      // frame carries, the layout its manifest implies, and packPluginEffect.
      const std::string_view shaderName = fx.text("shader");
      const api::RenderShaderSource* source = nullptr;
      for (const auto& s : ctx.file.shaders) {
        if (s.name == shaderName) source = &s;
      }
      if (source != nullptr) {
        const bool readsMap = fx.flag("readsMap");
        const bool readsOrigin = fx.flag("readsOrigin");
        const auto extraIds = [&] {
          std::vector<std::string_view> ids;
          if (const auto* pe = fx.find("extraLayerIds"); pe != nullptr) {
            for (const auto& id : pe->texts) {
              if (ids.size() < 3) ids.emplace_back(id);
            }
          }
          return ids;
        }();
        std::vector<LayoutEntry> layout = {{0, BindingType::uniform, kStageVertex | kStageFragment},
                                           {1, BindingType::texture, kStageFragment},
                                           {2, BindingType::sampler, kStageFragment}};
        if (readsMap) layout.push_back({3, BindingType::texture, kStageFragment});
        if (readsOrigin) layout.push_back({4, BindingType::texture, kStageFragment});
        for (std::uint32_t i = 0; i < extraIds.size(); ++i) layout.push_back({5 + i, BindingType::texture, kStageFragment});
        const Mat m = ctx.dev.dynamic_material(source->name, source->wgsl, layout);
        const double scale = fx.num("passScale", 1);
        if (fx.flag("capturesOrigin")) {
          Commands oc;
          emit_textured(ctx, oc, mvp, Color::white(), 1, Blend::normal, curTex, ctx.linear_clamp(), targetUv, kIdentityColor, true);
          ctx.draw_into(kPluginOrigin, oc, true);
        }
        TexRef mapTex = readsMap && !poolHasMatte ? maps.map_layer(ctx, byId, fx.text("mapLayerId"), selfId) : TexRef{};
        if (!mapTex) mapTex = curTex;
        // packPluginEffect: the plugin's params with the host header written over them.
        const auto params = fx.nums("params");
        constexpr std::size_t kPass = 16;
        std::vector<float> block(std::max<std::size_t>(params.size(), kPass + 20), 0.0F);
        for (std::size_t i = 0; i < params.size(); ++i) block[i] = f32(params[i]);
        Packer hp = ctx.packer();
        hp.mat3(mvp).rect(targetUv);
        const auto head = hp.span();
        std::ranges::copy(head, block.begin());
        const double tw = std::max(1.0, std::floor(pw * scale));
        const double th = std::max(1.0, std::floor(ph * scale));
        const auto host = [&](std::string_view k, double def) { return fx.num(std::string("hostInputs.") + std::string(k), def); };
        const std::array<double, 20> pass = {tw > 0 ? 1 / tw : 0, th > 0 ? 1 / th : 0, scale, fx.num("passIndex", 0),
                                             host("compWidth", 0), host("compHeight", 0), host("layerWidth", 0),
                                             host("layerHeight", 0), host("time", 0), host("compTime", 0), host("frame", 0),
                                             host("fps", 0), host("pixelScale", 1), host("downsample", 1), host("seed", 0), 0,
                                             targetUv.x + fxBox.x * targetUv.width, targetUv.y + fxBox.y * targetUv.height,
                                             fxBox.width * targetUv.width, fxBox.height * targetUv.height};
        for (std::size_t i = 0; i < pass.size(); ++i) block[kPass + i] = f32(pass.at(i));
        DrawItem& it = add(m, block, ctx.linear_clamp());
        if (readsMap) it.mask = mapTex;
        if (readsOrigin) it.origin = texOf(kPluginOrigin);
        for (std::uint32_t i = 0; i < extraIds.size(); ++i) {
          TexRef layerTex = !poolHasMatte ? maps.map_layer(ctx, byId, extraIds[i], selfId) : TexRef{};
          it.bind(5 + i, layerTex ? layerTex : curTex);
        }
        if (scale == 0.5 || scale == 0.25) {
          const std::string_view a = scale == 0.5 ? "plugin-half1" : "plugin-quarter1";
          const std::string_view b = scale == 0.5 ? "plugin-half2" : "plugin-quarter2";
          const std::string_view dest = a == curName ? b : a;
          ctx.draw_into_sized(dest, cmds, true, static_cast<std::uint32_t>(tw), static_cast<std::uint32_t>(th));
          curTex = texOf(dest);
          curName = dest;
          continue;
        }
      }
    } else if (const auto p = p_table().find(std::string(type)); p != p_table().end()) {
      const auto rows = p_rows(fx);
      add(p->second, pack_fx_block(ctx.packer(), mvp, targetUv, rows, fxBox), ctx.linear_clamp());
    } else if (type == "gradient-ramp") {
      Color a = Color::white();
      Color b{0, 0, 0, 1};
      (void)fx.color("colorA", a);
      (void)fx.color("colorB", b);
      const auto pts = ramp_points(fx.num("angle", 90), fxBox, pw, ph);
      Packer pk = ctx.packer();
      pk.mat3(mvp).rect(targetUv).vec4(a.r, a.g, a.b, a.a).vec4(b.r, b.g, b.b, b.a).vec4(0, 0, 0, 0).vec4(0, 0, 0, 0);
      pk.vec4(pts[0], pts[1], pts[2], pts[3]).vec4(fx.num("blend"), 0, 0, 0);
      add(Mat::GRADIENT_RAMP_MATERIAL, pk.span(), ctx.linear_clamp());
    } else if (type == "fractal-noise") {
      Packer pk = ctx.packer();
      add(Mat::FRACTAL_NOISE_MATERIAL, pk.mat3(mvp).rect(targetUv).vec4(fx.num("scale"), 0, 0, 4).span(), ctx.linear_clamp());
    } else if (type == "displacement-map") {
      TexRef map = poolHasMatte ? TexRef{} : maps.map_layer(ctx, byId, fx.text("mapLayerId"), selfId);
      if (!map) map = curTex;
      Packer pk = ctx.packer();
      add(Mat::DISPLACEMENT_MAP_MATERIAL,
          pk.mat3(mvp).rect(targetUv).vec4(fx.num("amount") * kx / pw, fx.num("amount") * ky / ph, 0, 0).span(),
          ctx.linear_clamp())
          .mask = map;
    } else if (type == "compound-blur") {
      TexRef map = poolHasMatte ? TexRef{} : maps.map_layer(ctx, byId, fx.text("mapLayerId"), selfId);
      if (!map) map = curTex;
      Packer pk = ctx.packer();
      add(Mat::COMPOUND_BLUR_MATERIAL,
          pk.mat3(mvp).rect(targetUv).vec4(fx.num("maxRadiusPx") * kx, fx.flag("invert") ? 1 : 0, 1 / pw, 1 / ph).span(),
          ctx.linear_clamp())
          .mask = map;
    } else if (type == "set-matte") {
      const TexRef matte = poolHasMatte ? TexRef{} : maps.map_layer(ctx, byId, fx.text("matteLayerId"), selfId);
      if (matte) {
        Packer pk = ctx.packer();
        add(Mat::SET_MATTE_MATERIAL,
            pk.mat3(mvp).rect(targetUv).vec4(fx.flag("useLuminance") ? 1 : 0, fx.flag("invert") ? 1 : 0, 0, 0).span(),
            ctx.linear_clamp())
            .mask = matte;
      }
    } else if (type == "apply-color-lut") {
      const TexRef strip = ctx.texture(fx.text("lutTextureKey"));
      if (strip) {
        Packer pk = ctx.packer();
        pk.mat3(mvp).rect(targetUv).vec4(fx.flag("is1d") ? -fx.num("size") : fx.num("size"), fx.num("intensity"),
                                         fx.num("domainMin"), fx.num("domainMax"));
        add(Mat::APPLY_COLOR_LUT_MATERIAL, pk.span(), ctx.linear_clamp()).mask = strip;
      }
    } else if (type == "motion-tile") {
      Packer pk = ctx.packer();
      add(Mat::MOTION_TILE_MATERIAL, pk.mat3(mvp).rect(targetUv).vec4(fx.num("scale"), fx.num("scale"), 0, 0).span(),
          ctx.linear_repeat());
    } else if (type == "fill") {
      Color c{0, 0, 0, 1};
      (void)fx.color("color", c);
      add(Mat::FILL_MATERIAL, pack_fill(ctx.packer(), mvp, targetUv, c), ctx.linear_clamp());
    } else if (type == "stroke") {
      Color c{0, 0, 0, 1};
      (void)fx.color("color", c);
      add(Mat::STROKE_MATERIAL,
          pack_stroke(ctx.packer(), mvp, targetUv, c, fx.num("widthPx"), kx / pw, ky / ph, fx.num("position", 0)),
          ctx.linear_clamp());
    } else if (type == "sharpen") {
      add(Mat::SHARPEN_MATERIAL, pack_sharpen(ctx.packer(), mvp, targetUv, 1 / pw, 1 / ph, fx.num("amount")), ctx.linear_clamp());
    } else if (type == "noise") {
      Packer pk = ctx.packer();
      pk.mat3(mvp).rect(targetUv).vec4(fx.num("amount"), fx.num("evolution"), fx.flag("monochrome") ? 1 : 0, 0);
      pk.vec4(std::max(1.0, pw), std::max(1.0, ph), 0, 0);
      add(Mat::NOISE_MATERIAL, pk.span(), ctx.linear_clamp());
    }
    if (cmds.empty()) continue;
    ctx.draw_into(f0, cmds, true);
    curTex = texOf(f0);
    curName = f0;
  }
  land();
  return {curTex, curName};
}

}  // namespace premation::rg
