#include "core/aep/aep_effects.hpp"

#include <map>

#include "catalog_data.hpp"

namespace premation::doc::aep {

namespace {

/// AE match name → this editor's effect (aepEffects.ts EFFECT_BY_MATCH_NAME, entry for entry).
const std::map<std::string, std::string, std::less<>>& effect_table() {
  static const std::map<std::string, std::string, std::less<>> kTable = {
    {"ADBE Gaussian Blur 2", "gaussian-blur"},
    {"ADBE Gaussian Blur", "gaussian-blur"},
    {"ADBE Box Blur2", "fast-box-blur"},
    {"ADBE Fast Blur", "fast-box-blur"},
    {"ADBE Motion Blur", "directional-blur"},
    {"ADBE Radial Blur", "radial-blur"},
    {"ADBE Channel Blur", "channel-blur"},
    {"ADBE Compound Blur", "compound-blur"},
    {"ADBE Bilateral", "bilateral-blur"},
    {"ADBE Smart Blur", "smart-blur"},
    {"ADBE Camera Lens Blur", "camera-lens-blur"},
    {"ADBE Sharpen", "sharpen"},
    {"ADBE Unsharp Mask2", "unsharp-mask"},
    {"CC Cross Blur", "cross-blur"},
    {"CC Radial Blur", "radial-blur"},
    {"CC Radial Fast Blur", "radial-fast-blur"},
    {"CC Vector Blur", "vector-blur"},
    {"ADBE Glo2", "glow"},
    {"ADBE Drop Shadow", "drop-shadow"},
    {"ADBE Radial Shadow", "radial-shadow"},
    {"ADBE Bevel Alpha", "bevel-alpha"},
    {"ADBE Bevel Edges", "bevel-edges"},
    {"ADBE Emboss", "emboss"},
    {"ADBE Color Emboss", "color-emboss"},
    {"ADBE Find Edges", "find-edges"},
    {"ADBE Mosaic", "mosaic"},
    {"ADBE Posterize", "posterize"},
    {"ADBE Threshold2", "threshold"},
    {"ADBE Roughen Edges", "roughen-edges"},
    {"ADBE Scatter", "scatter"},
    {"ADBE Brush Strokes", "brush-strokes"},
    {"ADBE Cartoon", "cartoon"},
    {"ADBE Strobe Light", "strobe-light"},
    {"ADBE Texturize", "texturize"},
    {"ADBE MotionTile", "motion-tile"},
    {"ADBE Motion Tile", "motion-tile"},
    {"CC Glass", "glass"},
    {"CC HexTile", "hex-tile"},
    {"CC Kaleida", "kaleidoscope"},
    {"CC Threads", "threads"},
    {"CC Plastic", "plastic"},
    {"CC RepeTile", "cc-repetile"},
    {"CC Tiler", "cc-tiler"},
    {"CC Burn Film", "burn-film"},
    {"CC Vignette", "vignette"},
    {"ADBE Brightness & Contrast 2", "brightness"},
    {"ADBE Easy Levels2", "levels"},
    {"ADBE Pro Levels2", "levels"},
    {"ADBE CurvesCustom", "curves"},
    {"ADBE HUE SATURATION", "hue-saturation"},
    {"ADBE Tint", "tint"},
    {"ADBE Tritone", "tritone"},
    {"ADBE Exposure2", "exposure"},
    {"ADBE Vibrance", "vibrance"},
    {"ADBE Colorama", "colorama"},
    {"ADBE SelectiveColor", "selective-color"},
    {"ADBE Shadow/Highlight", "shadow-highlight"},
    {"ADBE PhotoFilter", "photo-filter"},
    {"ADBE Black&White", "black-and-white"},
    {"ADBE ChannelMixer", "channel-mixer"},
    {"ADBE Shift Channels", "shift-channels"},
    {"ADBE Color Balance 2", "color-balance"},
    {"ADBE Color Balance (HLS)", "color-balance"},
    {"ADBE Gamma/Pedestal/Gain2", "gamma-pedestal-gain"},
    {"ADBE Apply Color LUT2", "apply-color-lut"},
    {"ADBE Change Color", "change-color"},
    {"ADBE Change To Color", "change-to-color"},
    {"ADBE Leave Color", "leave-color"},
    {"ADBE Equalize", "equalize"},
    {"ADBE AutoLevels", "auto-levels"},
    {"ADBE AutoContrast", "auto-contrast"},
    {"ADBE AutoColor", "auto-color"},
    {"ADBE Invert", "invert"},
    {"ADBE Broadcast Colors", "broadcast-colors"},
    {"ADBE Lumetri", "lumetri"},
    {"APC Lumetri", "lumetri"},
    {"CC Toner", "toner"},
    {"CC Color Offset", "color-offset"},
    {"ADBE Noise HLS", "noise-hls"},
    {"ADBE Threshold RGB", "threshold-rgb"},
    {"ADBE Cineon Converter2", "cineon-converter"},
    {"ADBE Fill", "fill"},
    {"ADBE Ramp", "gradient-ramp"},
    {"ADBE 4ColorGradient", "four-color-gradient"},
    {"ADBE Stroke", "stroke"},
    {"ADBE Laser", "beam"},
    {"ADBE Lightning 2", "lightning"},
    {"ADBE Radio Waves", "radio-waves"},
    {"ADBE Lens Flare", "lens-flare"},
    {"ADBE Checkerboard", "checkerboard"},
    {"ADBE Grid", "grid"},
    {"ADBE Cell Pattern", "cell-pattern"},
    {"ADBE Vegas", "vegas"},
    {"ADBE Write-on", "write-on"},
    {"ADBE Scribble Fill", "scribble"},
    {"ADBE Circle", "circle"},
    {"ADBE Ellipse", "ellipse"},
    {"ADBE Fractal", "fractal"},
    {"ADBE Fractal Noise", "fractal-noise"},
    {"ADBE Turbulent Noise", "turbulent-noise"},
    {"ADBE Noise2", "noise"},
    {"ADBE Noise", "noise"},
    {"ADBE Noise Alpha2", "noise-alpha"},
    {"ADBE Grain Add", "add-grain"},
    {"ADBE Median", "median"},
    {"ADBE Dust & Scratches", "dust-scratches"},
    {"CC Light Rays", "light-rays"},
    {"CC Light Sweep", "light-sweep"},
    {"CC Light Burst 2.5", "light-burst"},
    {"CC Star Burst", "star-burst"},
    {"CC Snowfall", "snowfall"},
    {"CC Rainfall", "rainfall"},
    {"CC Drizzle", "drizzle"},
    {"CC Particle World", "particle-systems"},
    {"CC Bubbles", "cc-bubbles"},
    {"ADBE Displacement Map", "displacement-map"},
    {"ADBE Turbulent Displace", "turbulent-displace"},
    {"ADBE Wave Warp", "wave-warp"},
    {"ADBE Bulge", "bulge"},
    {"ADBE Twirl", "twirl"},
    {"ADBE Spherize", "spherize"},
    {"ADBE Corner Pin", "corner-pin"},
    {"ADBE BezMesh", "bezier-warp"},
    {"ADBE Mesh Warp", "mesh-warp"},
    {"ADBE Liquify", "liquify"},
    {"ADBE Mirror", "mirror"},
    {"ADBE Offset", "offset"},
    {"ADBE Polar Coordinates", "polar-coordinates"},
    {"ADBE Optics Compensation", "optics-compensation"},
    {"ADBE Ripple", "ripple"},
    {"ADBE Magnify", "magnify"},
    {"ADBE Warp", "warp"},
    {"ADBE Geometry2", "transform"},
    {"ADBE Rolling Shutter", "rolling-shutter"},
    {"ADBE Bend It", "bend"},
    {"CC Flo Motion", "flo-motion"},
    {"CC Lens", "lens"},
    {"CC Griddler", "griddler"},
    {"CC Page Turn", "page-turn"},
    {"CC Split", "split"},
    {"CC Slant", "slant"},
    {"CC Smear", "smear"},
    {"CC Ball Action", "ball-action"},
    {"CC Pixel Polly", "pixel-polly"},
    {"CC Twister", "twister"},
    {"CC Scatterize", "cc-scatterize"},
    {"CC Sphere", "sphere"},
    {"CC Cylinder", "cylinder"},
    {"CC Composite", "cc-composite"},
    {"CC Spotlight", "spotlight"},
    {"Keylight", "keylight"},
    {"ADBE Keylight", "keylight"},
    {"ADBE Linear Color Key2", "linear-color-key"},
    {"ADBE Color Key", "color-key"},
    {"ADBE Color Range", "color-range"},
    {"ADBE Extract", "extract"},
    {"ADBE Spill Suppressor", "spill-suppressor"},
    {"ADBE Simple Choker", "simple-choker"},
    {"ADBE Matte Choker", "matte-choker"},
    {"ADBE Set Matte3", "set-matte"},
    {"ADBE Luma Key", "luma-key"},
    {"ADBE Color Difference Key", "color-difference-key"},
    {"ADBE Minimax", "minimax"},
    {"ADBE Alpha Levels2", "alpha-levels"},
    {"ADBE Solid Composite", "solid-composite"},
    {"ADBE Channel Combiner", "channel-combiner"},
    {"ADBE Remove Color Matting", "remove-color-matting"},
    {"ADBE Arithmetic", "arithmetic"},
    {"ADBE Linear Wipe", "linear-wipe"},
    {"ADBE Radial Wipe", "radial-wipe"},
    {"ADBE Venetian Blinds", "venetian-blinds"},
    {"ADBE Gradient Wipe", "gradient-wipe"},
    {"ADBE Card Wipe", "card-wipe"},
    {"ADBE Card Dance", "card-dance"},
    {"ADBE Block Dissolve", "block-dissolve"},
    {"ADBE Iris Wipe", "iris-wipe"},
    {"CC Glass Wipe", "glass-wipe"},
    {"CC Image Wipe", "image-wipe"},
    {"CC Scale Wipe", "scale-wipe"},
    {"CC Radial ScaleWipe", "radial-scale-wipe"},
    {"CC Light Wipe", "light-wipe"},
    {"CC Line Sweep", "line-sweep"},
    {"CC Grid Wipe", "grid-wipe"},
    {"CC Ripple Pulse", "ripple-pulse"},
    {"ADBE Echo", "echo"},
    {"ADBE Posterize Time", "posterize-time"},
    {"ADBE Force Motion Blur", "force-motion-blur"},
    {"ADBE WideTime", "wide-time"},
    {"ADBE NUMBERS2", "numbers"},
    {"ADBE Timecode", "timecode"},
    {"ADBE AUD SPECTRUM", "audio-spectrum"},
    {"ADBE AUD WAVEFORM", "audio-waveform"},
  };
  return kTable;
}

/// AE effects that need a SECOND effect of ours (Brightness & Contrast → brightness + contrast).
std::optional<std::string> companion_of(std::string_view matchName) {
  if (matchName == "ADBE Brightness & Contrast 2") return std::string("contrast");
  return std::nullopt;
}

/// Where the two products call one thing by two names (normalised labels).
std::optional<std::string_view> label_synonym(std::string_view label) {
  static const std::map<std::string_view, std::string_view, std::less<>> kSynonyms = {
      {"sharpenamount", "amount"},     {"amounttotint", "amount"},      {"glowradius", "radius"},
      {"glowintensity", "intensity"},  {"glowthreshold", "spread"},     {"shadowcolor", "color"},
      {"blurlength", "length"},        {"transitioncompletion", "completion"}, {"mapblackto", "mapblack"},
      {"mapwhiteto", "mapwhite"},      {"level", "levels"},             {"bulgeheight", "height"},
      {"twirlradius", "radius"},       {"reflectionangle", "angle"},    {"waveheight", "amplitude"},
      {"wavewidth", "frequency"},      {"ripplephase", "phase"},        {"displacement", "amount"},
      {"blurradius", "blurradius"},
  };
  const auto it = kSynonyms.find(label);
  if (it == kSynonyms.end()) return std::nullopt;
  return it->second;
}

/// AE point labels whose components feed a `…X` / `…Y` pair here.
std::optional<std::string_view> point_target(std::string_view label) {
  static const std::map<std::string_view, std::string_view, std::less<>> kTargets = {
      {"center", "center"},         {"bulgecenter", "center"},      {"twirlcenter", "center"},
      {"centerofsphere", "center"}, {"centerofripple", "center"},   {"reflectioncenter", "center"},
      {"shiftcenterto", "shift"},
  };
  const auto it = kTargets.find(label);
  if (it == kTargets.end()) return std::nullopt;
  return it->second;
}

constexpr int kControlType2dPoint = 6;

template <class V>
void put(std::vector<std::pair<std::string, V>>& list, const std::string& key, V value) {
  for (auto& [k, v] : list) {
    if (k == key) {
      v = std::move(value);
      return;
    }
  }
  list.emplace_back(key, std::move(value));
}

}  // namespace

std::string normalize_label(std::string_view label) {
  std::string out;
  for (const char c0 : label) {
    const char c = c0 >= 'A' && c0 <= 'Z' ? static_cast<char>(c0 - 'A' + 'a') : c0;
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) out.push_back(c);
  }
  return out;
}

std::optional<std::string> effect_for_match_name(std::string_view matchName) {
  const auto& t = effect_table();
  const auto it = t.find(matchName);
  if (it == t.end()) return std::nullopt;
  return it->second;
}

std::vector<MappedEffect> map_effect(std::string_view matchName, const std::vector<AeParam>& params) {
  const std::optional<std::string> primary = effect_for_match_name(matchName);
  if (!primary) return {};
  const EffectDef* def = registry().effect(*primary);
  // `new Map(defs.map(...))`: a later duplicate wins.
  std::map<std::string, std::string, std::less<>> byKey;
  std::map<std::string, std::string, std::less<>> byLabel;
  if (def != nullptr) {
    for (const EffectParamDef& p : def->params) {
      byKey.insert_or_assign(normalize_label(p.key), p.key);
      byLabel.insert_or_assign(normalize_label(p.label), p.key);
    }
  }
  auto lookup = [](const std::map<std::string, std::string, std::less<>>& m, std::string_view k) -> std::optional<std::string> {
    const auto it = m.find(k);
    if (it == m.end()) return std::nullopt;
    return it->second;
  };
  MappedEffect out;
  out.type = *primary;
  for (const AeParam& param : params) {
    const std::string label = normalize_label(param.label.value_or(""));
    if (label.empty()) continue;
    if (param.controlType == kControlType2dPoint) {
      const std::string base(point_target(label).value_or(label));
      const auto keyX = lookup(byKey, base + "x");
      const auto keyY = lookup(byKey, base + "y");
      if (keyX && keyY) put(out.points, base, MappedPoint{*keyX, *keyY, param.matchName});
      continue;
    }
    // Most specific first: our key spelling, our label, then the synonym table.
    std::optional<std::string> key = lookup(byKey, label);
    if (!key) key = lookup(byLabel, label);
    if (!key) {
      if (const auto syn = label_synonym(label)) {
        key = lookup(byKey, *syn);
        if (!key) key = lookup(byLabel, *syn);
      }
    }
    if (key) put(out.params, *key, param.matchName);
  }
  out.defaultsOnly = out.params.empty() && out.points.empty();
  std::vector<MappedEffect> result{std::move(out)};
  if (const auto companion = companion_of(matchName)) {
    MappedEffect c;
    c.type = *companion;
    c.defaultsOnly = true;
    result.push_back(std::move(c));
  }
  return result;
}

}  // namespace premation::doc::aep
