#include "kernel_dispatch.hpp"

#include <algorithm>
#include <array>
#include <string>

namespace premation::effects {

namespace {

constexpr std::array<std::string_view, 81> kPorted{
    "gaussian-blur",   "fast-box-blur",   "radial-blur",   "channel-blur",    "unsharp-mask",     "sharpen",
    "noise",           "add-grain",       "turbulent-noise", "median",        "minimax",          "simple-choker",
    "mosaic",          "find-edges",      "emboss",        "vibrance",        "bilateral-blur",   "smart-blur",
    "camera-lens-blur", "photo-filter",   "black-and-white", "tritone",       "threshold",        "selective-color",
    "shadow-highlight", "colorama",        "keylight",        "linear-color-key", "luma-key",     "shift-channels",
    "color-key",       "color-range",     "extract",       "spill-suppressor", "matte-choker",     "bulge",
    "spherize",        "twirl",           "corner-pin",    "polar-coordinates", "mirror",          "offset",
    "optics-compensation", "mesh-warp",   "liquify",       "equalize",        "auto-levels",      "auto-contrast",
    "auto-color",      "change-color",    "change-to-color", "leave-color",   "toner",            "venetian-blinds",
    "gradient-wipe",   "card-wipe",       "radial-wipe",   "block-dissolve",  "alpha-levels",     "solid-composite",
    "channel-combiner", "remove-color-matting", "cartoon",   "brush-strokes",   "strobe-light",     "color-emboss",
    "halftone",        "kaleidoscope",    "vignette",      "burn-film",       "iris-wipe",        "light-wipe",
    "line-sweep",      "grid-wipe",       "dust-scratches", "noise-alpha",    "wave-warp",        "turbulent-displace",
    "curl-noise",      "roughen-edges",   "scatter",
};

}  // namespace

std::span<const std::string_view> ported_kernels() noexcept { return kPorted; }

bool run_kernel(std::string_view type, const KernelArgs& a, RgbaView img, ThreadPool* pool) {
  const auto b = [&](std::string_view k, bool def) { return a(k, def ? 1 : 0) != 0; };
  const auto key = [&] { return Rgb{a("keyR", 0), a("keyG", 255), a("keyB", 0)}; };
  // An RGB triple stored as <name>R / <name>G / <name>B.
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
  if (type == "gaussian-blur" || type == "fast-box-blur") {
    // applyGaussianBlur fixes iterations at 3; Fast Box Blur exposes it.
    blur_rgba(img, a("radius", 0), blur_dims(a("dimensions", 0)),
              type == "gaussian-blur" ? 3 : a("iterations", 1), b("repeatEdge", true), pool);
  } else if (type == "radial-blur") {
    radial_blur(img, a("amount", 0), a("centerX", img.w / 2.0), a("centerY", img.h / 2.0), a("zoom", 0) != 0,
                a("quality", 8), pool);
  } else if (type == "channel-blur") {
    channel_blur(img, a("red", 0), a("green", 0), a("blue", 0), a("alpha", 0), blur_dims(a("dimensions", 0)),
                 b("repeatEdge", true), pool);
  } else if (type == "unsharp-mask") {
    unsharp_mask(img, a("amount", 0), a("radius", 0), a("threshold", 0), pool);
  } else if (type == "sharpen") {
    sharpen(img, a("amount", 0), pool);
  } else if (type == "noise") {
    add_noise(img, a("amount", 0), a("evolution", 0), b("mono", true), pool);
  } else if (type == "add-grain") {
    add_grain(img, a("intensity", 0), a("size", 1), a("saturation", 0), a("seed", 0), pool);
  } else if (type == "turbulent-noise") {
    turbulent_noise(img, a("scale", 100), a("complexity", 4), a("evolution", 0), a("contrast", 100),
                    a("brightness", 0), b("invert", false), pool);
  } else if (type == "median") {
    median(img, a("radius", 0), pool);
  } else if (type == "minimax") {
    minimax(img, minimax_op(a("op", 0)), a("radius", 0), minimax_channel(a("channel", 0)),
            blur_dims(a("direction", 0)), pool);
  } else if (type == "simple-choker") {
    simple_choker(img, a("chokePx", 0), pool);
  } else if (type == "mosaic") {
    mosaic(img, a("hBlocks", 10), a("vBlocks", 10), b("sharpColors", false), pool);
  } else if (type == "find-edges") {
    find_edges(img, b("invert", true), pool);
  } else if (type == "emboss") {
    emboss(img, a("angleDeg", 45), a("relief", 1), a("contrast", 100), a("blend", 0), pool);
  } else if (type == "vibrance") {
    vibrance(img, a("vibrance", 0), a("saturation", 0), pool);
  } else if (type == "bilateral-blur") {
    bilateral_blur(img, a("radius", 0), a("colorSigma", 30), b("preserveAlpha", false), pool);
  } else if (type == "smart-blur") {
    smart_blur(img, a("radius", 0), a("threshold", 0), a("mode", 0), pool);
  } else if (type == "camera-lens-blur") {
    camera_lens_blur(img, a("radius", 0), a("blades", 0), a("rotation", 0), a("gain", 1), a("threshold", 100), pool);
  } else if (type == "photo-filter") {
    photo_filter(img, a("filterR", 255), a("filterG", 128), a("filterB", 0), a("density", 25),
                 b("preserveLuminosity", true), pool);
  } else if (type == "black-and-white") {
    const BwWeights wts{a("reds", 0.4), a("yellows", 0.6), a("greens", 0.4), a("cyans", 0.6), a("blues", 0.2),
                        a("magentas", 0.8)};
    const std::array<double, 3> tint{a("tintR", 0), a("tintG", 0), a("tintB", 0)};
    black_and_white(img, wts, b("useTint", false) ? &tint : nullptr, pool);
  } else if (type == "tritone") {
    tritone(img, {a("shadowsR", 0), a("shadowsG", 0), a("shadowsB", 0)},
            {a("midtonesR", 128), a("midtonesG", 128), a("midtonesB", 128)},
            {a("highlightsR", 255), a("highlightsG", 255), a("highlightsB", 255)}, a("blend", 0), pool);
  } else if (type == "threshold") {
    threshold(img, a("level", 128), pool);
  } else if (type == "selective-color") {
    selective_color(img, selective_range(a("range", 0)), a("cyan", 0), a("magenta", 0), a("yellow", 0), a("black", 0),
                    b("relative", true), pool);
  } else if (type == "shadow-highlight") {
    shadow_highlight(img, a("shadowAmount", 0), a("highlightAmount", 0), a("radius", 0), a("tonalWidth", 50), pool);
  } else if (type == "colorama") {
    // applyColorama: Math.max(0, Math.min(len - 1, Math.round(palette))).
    const int idx = static_cast<int>(std::max(0.0, std::min(4.0, js::round(a("palette", 0)))));
    colorama(img, idx, a("phaseShift", 0), a("cycleRepetitions", 1), a("blendWithOriginal", 0), pool);
  } else if (type == "keylight") {
    keylight(img,
             KeylightParams{{a("keyR", 0), a("keyG", 255), a("keyB", 0)}, a("balance", 0.5), a("gain", 1),
                            a("clipBlack", 0), a("clipWhite", 1), a("despill", 0.5), a("choke", 0), a("matteSoftness", 0)},
             pool);
  } else if (type == "linear-color-key") {
    linear_color_key(img, key(), a("matchOn", 0), a("tolerance", 10), a("softness", 0), b("keepMatched", false), pool);
  } else if (type == "luma-key") {
    luma_key(img, a("keyType", 0), a("threshold", 128), a("tolerance", 0), a("softness", 0), pool);
  } else if (type == "shift-channels") {
    shift_channels(img, a("alphaFrom", 0), a("redFrom", 1), a("greenFrom", 2), a("blueFrom", 3), pool);
  } else if (type == "color-key") {
    color_key(img, key(), a("tolerance", 10), a("edgeSoftness", 0), pool);
  } else if (type == "color-range") {
    color_range(img, key(), a("space", 0), a("minTol", 0), a("maxTol", 20), a("lumaWeight", 50), pool);
  } else if (type == "extract") {
    extract_matte(img, a("channel", 0), a("black", 0), a("white", 255), a("blackSoft", 0), a("whiteSoft", 0),
                  b("invert", false), pool);
  } else if (type == "spill-suppressor") {
    spill_suppressor(img, key(), a("amount", 50), b("preserveLuma", true), pool);
  } else if (type == "matte-choker") {
    matte_choker(img, a("spread", 0), a("choke", 0), a("softness", 0), a("iterations", 1), pool);
  } else if (type == "bulge") {
    bulge(img, a("centerX", img.w / 2.0), a("centerY", img.h / 2.0), a("radius", 50), a("height", 50), pool);
  } else if (type == "spherize") {
    spherize(img, a("centerX", img.w / 2.0), a("centerY", img.h / 2.0), a("radius", 50), a("amount", 50), pool);
  } else if (type == "twirl") {
    twirl(img, a("centerX", img.w / 2.0), a("centerY", img.h / 2.0), a("radius", 50), a("angle", 90), pool);
  } else if (type == "corner-pin") {
    const std::array<double, 8> c{a("tlx", 0), a("tly", 0), a("trx", img.w), a("try", 0),
                                  a("brx", img.w), a("bry", img.h), a("blx", 0), a("bly", img.h)};
    corner_pin(img, c, pool);
  } else if (type == "polar-coordinates") {
    polar_coordinates(img, a("interpolation", 100), a("conversion", 0) >= 1, pool);
  } else if (type == "mirror") {
    mirror(img, a("centerX", img.w / 2.0), a("centerY", img.h / 2.0), a("angle", 0), pool);
  } else if (type == "offset") {
    offset(img, a("shiftX", img.w / 2.0), a("shiftY", img.h / 2.0), a("blend", 0), pool);
  } else if (type == "optics-compensation") {
    optics_compensation(img, a("fov", 0), b("reverse", false), a("centerX", 0), a("centerY", 0), pool);
  } else if (type == "mesh-warp") {
    std::array<Pt2, 16> o{};
    static constexpr std::array<std::string_view, 16> kX{"mx0", "mx1", "mx2",  "mx3",  "mx4",  "mx5",  "mx6",  "mx7",
                                                         "mx8", "mx9", "mx10", "mx11", "mx12", "mx13", "mx14", "mx15"};
    static constexpr std::array<std::string_view, 16> kY{"my0", "my1", "my2",  "my3",  "my4",  "my5",  "my6",  "my7",
                                                         "my8", "my9", "my10", "my11", "my12", "my13", "my14", "my15"};
    for (std::size_t i = 0; i < 16; ++i) o[i] = Pt2{a(kX[i], 0), a(kY[i], 0)};
    mesh_warp(img, o, pool);
  } else if (type == "liquify") {
    liquify(img, a("centerX", img.w / 2.0), a("centerY", img.h / 2.0), a("radius", 50), a("pushX", 0), a("pushY", 0),
            a("twirl", 0), a("pinch", 0), pool);
  } else if (type == "equalize") {
    equalize(img, a("mode", 0), a("amount", 100), a("blend", 0), pool);
  } else if (type == "auto-levels") {
    auto_levels(img, a("blackClip", 0.1), a("whiteClip", 0.1), a("blend", 0), pool);
  } else if (type == "auto-contrast") {
    auto_contrast(img, a("blackClip", 0.1), a("whiteClip", 0.1), a("blend", 0), pool);
  } else if (type == "auto-color") {
    auto_color(img, a("blackClip", 0.1), a("whiteClip", 0.1), a("snapNeutral", 0), a("blend", 0), pool);
  } else if (type == "change-color") {
    change_color(img, rgb("target", {255, 0, 0}), a("hueTol", 15), a("satTol", 50), a("lightTol", 50), a("softness", 20),
                 a("hueShift", 0), a("satScale", 0), a("lightScale", 0), b("invert", false), pool);
  } else if (type == "change-to-color") {
    change_to_color(img, rgb("from", {255, 0, 0}), rgb("to", {0, 0, 255}), a("hueTol", 15), a("satTol", 50),
                    a("lightTol", 50), a("softness", 20), b("preserveLightness", true), pool);
  } else if (type == "leave-color") {
    leave_color(img, rgb("target", {255, 0, 0}), a("tolerance", 15), a("softness", 20), a("amount", 100), pool);
  } else if (type == "toner") {
    toner(img,
          {rgb("black", {0, 0, 0}), rgb("shadows", {60, 40, 90}), rgb("midtones", {140, 120, 100}),
           rgb("highlights", {220, 210, 180}), rgb("white", {255, 255, 255})},
          a("blend", 0), pool);
  } else if (type == "venetian-blinds") {
    venetian_blinds(img, a("completion", 0), a("direction", 0), a("width", 20), a("feather", 0), pool);
  } else if (type == "gradient-wipe") {
    gradient_wipe(img, a("completion", 0), a("softness", 0), b("invert", false), pool);
  } else if (type == "card-wipe") {
    card_wipe(img, a("completion", 0), a("rows", 4), a("columns", 6), a("flipOrder", 0), pool);
  } else if (type == "radial-wipe") {
    radial_wipe(img, a("completion", 0), a("startAngle", 0), a("direction", 0), a("centerX", img.w / 2.0),
                a("centerY", img.h / 2.0), a("feather", 0), pool);
  } else if (type == "block-dissolve") {
    block_dissolve(img, a("completion", 0), a("blockWidth", 8), a("blockHeight", 8), a("feather", 0), a("seed", 0), pool);
  } else if (type == "alpha-levels") {
    alpha_levels(img, a("inBlack", 0), a("inWhite", 255), a("gamma", 1), a("outBlack", 0), a("outWhite", 255), pool);
  } else if (type == "solid-composite") {
    solid_composite(img, rgb("color", {255, 255, 255}), a("sourceOpacity", 100), a("solidOpacity", 100), a("mode", 0),
                    pool);
  } else if (type == "channel-combiner") {
    channel_combiner(img, a("mode", 0), pool);
  } else if (type == "remove-color-matting") {
    remove_color_matting(img, rgb("bg", {0, 0, 0}), a("threshold", 0), a("amount", 100), pool);
  } else if (type == "cartoon") {
    cartoon(img, a("smoothness", 3), a("levels", 6), a("edgeThreshold", 40), a("edgeWidth", 1), a("edgeOpacity", 100),
            pool);
  } else if (type == "brush-strokes") {
    brush_strokes(img, a("direction", 45), a("length", 8), a("randomness", 30), a("cellSize", 6), a("density", 100),
                  pool);
  } else if (type == "strobe-light") {
    strobe_light(img, a("time", 0), a("period", 0.5), a("duty", 50), a("operation", 0), rgb("color", {255, 255, 255}),
                 a("intensity", 100), pool);
  } else if (type == "color-emboss") {
    color_emboss(img, a("direction", 45), a("relief", 2), a("contrast", 100), a("blendWithOriginal", 0), pool);
  } else if (type == "halftone") {
    halftone(img, a("cellSize", 8), a("angle", 45), a("contrast", 100), rgb("ink", {0, 0, 0}),
             rgb("paper", {255, 255, 255}), b("colorize", false), a("blendWithOriginal", 0), pool);
  } else if (type == "kaleidoscope") {
    kaleidoscope(img, a("segments", 6), a("centerX", 0), a("centerY", 0), a("rotation", 0), a("sourceAngle", 0),
                 a("zoom", 100), pool);
  } else if (type == "vignette") {
    vignette(img, a("amount", 50), a("size", 50), a("feather", 50), a("roundness", 100), a("centerX", 0),
             a("centerY", 0), pool);
  } else if (type == "burn-film") {
    burn_film(img, a("burn", 0), a("centerX", 0), a("centerY", 0), rgb("burnColor", {0, 0, 0}),
              rgb("charColor", {60, 30, 10}), a("randomness", 50), a("seed", 0), pool);
  } else if (type == "iris-wipe") {
    iris_wipe(img, a("completion", 0), a("centerX", 0), a("centerY", 0), a("points", 6), a("rotation", 0),
              a("innerRadius", 0), b("useInnerRadius", false), a("feather", 0), b("invert", false), pool);
  } else if (type == "light-wipe") {
    light_wipe(img, a("completion", 0), a("shape", 0), a("angle", 0), a("centerX", 0), a("centerY", 0), a("width", 40),
               rgb("color", {255, 255, 255}), a("intensity", 100), a("feather", 0), pool);
  } else if (type == "line-sweep") {
    line_sweep(img, a("completion", 0), a("lineCount", 8), a("angle", 0), a("stagger", 50), a("feather", 0),
               b("invert", false), pool);
  } else if (type == "grid-wipe") {
    grid_wipe(img, a("completion", 0), a("columns", 8), a("rows", 6), a("shape", 0), a("random", 50), a("feather", 0),
              b("invert", false), pool);
  } else if (type == "dust-scratches") {
    dust_and_scratches(img, a("radius", 2), a("threshold", 20), pool);
  } else if (type == "noise-alpha") {
    noise_alpha(img, a("amount", 50), b("uniform", true), a("seed", 0), a("phase", 0), b("clipResult", true), pool);
  } else if (type == "wave-warp") {
    wave_warp(img, a("waveHeight", 10), a("waveWidth", 40), a("direction", 90), a("phase", 0), pool);
  } else if (type == "turbulent-displace") {
    turbulent_displace(img, a("amount", 20), a("size", 40), a("complexity", 3), a("evolution", 0), pool);
  } else if (type == "curl-noise") {
    curl_noise(img, a("amount", 20), a("size", 40), a("complexity", 3), a("evolution", 0), pool);
  } else if (type == "roughen-edges") {
    roughen_edges(img, a("border", 8), a("scale", 100), a("complexity", 3), a("evolution", 0), a("seed", 0),
                  a("edgeSharpness", 0), pool);
  } else if (type == "scatter") {
    scatter(img, a("amount", 5), a("grain", 0), a("seed", 0), a("evolution", 0), pool);
  } else {
    return false;
  }
  return true;
}

}  // namespace premation::effects
