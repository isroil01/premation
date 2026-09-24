#include "camera3d_port.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

#include "jsmath.hpp"
#include "numconv.hpp"

namespace premation::scene {

using js::Json;

double fixed_num(double x, int digits) { return motion::js::string_to_number(motion::js::to_fixed(x, digits)); }

double dof_blur_px(double depth, const DofConfig& dof) {
  if (!dof.fStop) {
    const double defocus = std::abs(depth - dof.focus) / std::max(1.0, dof.focus);
    return std::min(dof.strength, defocus * dof.aperture);
  }
  const double f = std::max(1e-6, dof.focalLength.value_or(dof.focus));
  const double S = dof.focus;
  const double N = std::max(1e-6, *dof.fStop);
  if (!(S > f) || !(depth > 0) || !std::isfinite(depth)) return dof.strength;
  const double A = f / N;
  const double coc = (A * f * std::abs(depth - S)) / (depth * (S - f));
  if (!std::isfinite(coc)) return dof.strength;
  return std::min(dof.strength, coc);
}

IrisParams dof_iris_params(const DofConfig& dof) {
  IrisParams out;
  if (!dof.irisBlades || *dof.irisBlades < 3) return out;
  const double blades = *dof.irisBlades;
  const double rotation = dof.irisRotation.value_or(0);
  const double aspect = std::max(0.05, std::min(20.0, dof.irisAspect.value_or(1)));
  const double threshold = std::max(0.0, std::min(1.0, dof.highlightThreshold.value_or(0)));
  const double saturation = std::max(0.0, dof.highlightSaturation.value_or(0));
  const double fringe = std::max(0.0, std::min(1.0, dof.diffractionFringe.value_or(0)));
  out.blades = std::max(3.0, std::min(11.0, motion::js::round(blades)));
  out.roundness = std::max(0.0, std::min(1.0, dof.irisRoundness.value_or(0.65)));
  out.highlightGain = std::max(0.0, dof.highlightGain.value_or(0));
  if (rotation != 0) out.rotationDeg = rotation;
  if (aspect != 1) out.aspect = aspect;
  if (threshold > 0) out.highlightThreshold = threshold;
  if (saturation > 0) out.highlightSaturation = saturation;
  if (fringe > 0) out.fringe = fringe;
  return out;
}

std::optional<DofConfig> read_node_dof(const doc::Node& node, double width, double height, const PropSample& sample) {
  std::optional<double> strength, focus, focal, aperture, fStop, irisBlades, irisRoundness, highlightGain, irisRotation,
      irisAspect, highlightThreshold, highlightSaturation, diffractionFringe;
  const auto num = [](const Json& v) -> std::optional<double> {
    return v.is_number() ? std::optional<double>(v.num()) : std::nullopt;
  };
  for (const doc::Component& c : node.components) {
    const Json& p = c.props;
    if (auto v = num(p.at("dofStrength"))) strength = v;
    if (auto v = num(p.at("focusDistance"))) focus = v;
    if (auto v = num(p.at("focalLength"))) focal = v;
    if (auto v = num(p.at("dofAperture"))) aperture = v;
    if (auto v = num(p.at("fStop"))) fStop = v;
    if (auto v = num(p.at("irisBlades"))) irisBlades = v;
    if (auto v = num(p.at("irisRoundness"))) irisRoundness = v;
    if (auto v = num(p.at("highlightGain"))) highlightGain = v;
    if (auto v = num(p.at("irisRotation"))) irisRotation = v;
    if (auto v = num(p.at("irisAspect"))) irisAspect = v;
    if (auto v = num(p.at("highlightThreshold"))) highlightThreshold = v;
    if (auto v = num(p.at("highlightSaturation"))) highlightSaturation = v;
    if (auto v = num(p.at("diffractionFringe"))) diffractionFringe = v;
  }
  const auto s = [&sample](std::string_view k, std::optional<double>& into) {
    if (!sample) return;
    if (const auto v = sample(k)) into = v;
  };
  s("dofStrength", strength);
  s("focusDistance", focus);
  s("focalLength", focal);
  s("dofAperture", aperture);
  s("fStop", fStop);
  s("irisBlades", irisBlades);
  s("irisRoundness", irisRoundness);
  s("highlightGain", highlightGain);
  s("irisRotation", irisRotation);
  s("irisAspect", irisAspect);
  s("highlightThreshold", highlightThreshold);
  s("highlightSaturation", highlightSaturation);
  s("diffractionFringe", diffractionFringe);
  // `!strength || strength <= 0` (0 and NaN are falsy).
  if (!strength || *strength == 0 || std::isnan(*strength) || *strength <= 0) return std::nullopt;
  const double lens = focal.value_or(motion::xf::default_camera(width, height).focal_length);
  DofConfig d;
  d.strength = *strength;
  d.focus = focus.value_or(lens);
  d.aperture = aperture.value_or(*strength);
  d.focalLength = lens;
  if (fStop && *fStop > 0) d.fStop = fStop;
  if (irisBlades && *irisBlades >= 3) d.irisBlades = irisBlades;
  if (irisRoundness) d.irisRoundness = irisRoundness;
  if (highlightGain && *highlightGain > 0) d.highlightGain = highlightGain;
  if (irisRotation && *irisRotation != 0) d.irisRotation = irisRotation;
  if (irisAspect && *irisAspect > 0 && *irisAspect != 1) d.irisAspect = irisAspect;
  if (highlightThreshold && *highlightThreshold > 0) d.highlightThreshold = highlightThreshold;
  if (highlightSaturation && *highlightSaturation > 0) d.highlightSaturation = highlightSaturation;
  if (diffractionFringe && *diffractionFringe > 0) d.diffractionFringe = diffractionFringe;
  return d;
}

namespace {

/// The iris extras both DOF effect forms append, in the TypeScript's key order.
void set_iris(Json& params, const IrisParams& iris) {
  if (iris.blades) params.set("blades", Json::number(*iris.blades));
  if (iris.roundness) params.set("roundness", Json::number(*iris.roundness));
  if (iris.highlightGain && *iris.highlightGain > 0) params.set("highlightGain", Json::number(*iris.highlightGain));
  if (iris.rotationDeg) params.set("irisRotation", Json::number(*iris.rotationDeg));
  if (iris.aspect) params.set("irisAspect", Json::number(*iris.aspect));
  if (iris.highlightThreshold) params.set("highlightThreshold", Json::number(*iris.highlightThreshold));
  if (iris.highlightSaturation) params.set("highlightSaturation", Json::number(*iris.highlightSaturation));
  if (iris.fringe) params.set("diffractionFringe", Json::number(*iris.fringe));
}

}  // namespace

Json dof_effect(double depth, const DofConfig& dof) {
  const double blur = dof_blur_px(depth, dof);
  if (blur < 0.3) return {};
  Json params = Json::object();
  params.set("amount", Json::number(fixed_num(blur, 1)));
  set_iris(params, dof_iris_params(dof));
  Json e = Json::object();
  e.set("id", Json::string("dof"));
  e.set("type", Json::string("blur"));
  e.set("params", std::move(params));
  return e;
}

std::optional<std::array<double, 4>> layer_corner_depths(const motion::xf::Mat4& w, double width, double height,
                                                         const ProjectFn& project) {
  const double hw = width / 2;
  const double hh = height / 2;
  const std::array<std::array<double, 2>, 4> locals = {{{-hw, -hh}, {hw, -hh}, {hw, hh}, {-hw, hh}}};
  std::array<double, 4> out{};
  for (std::size_t i = 0; i < 4; ++i) {
    const double lx = locals[i][0];
    const double ly = locals[i][1];
    const double x = w[0] * lx + w[4] * ly + w[12];
    const double y = w[1] * lx + w[5] * ly + w[13];
    const double z = w[2] * lx + w[6] * ly + w[14];
    const motion::xf::Projected p = project({x, y, z});
    if (p.clipped) return std::nullopt;
    out[i] = p.depth;
  }
  return out;
}

std::optional<PlanarCoc> plan_dof_coc_corners(const std::array<double, 4>& cornerDepths, const DofConfig& dof) {
  PlanarCoc out;
  for (std::size_t i = 0; i < 4; ++i) out.corners[i] = fixed_num(dof_blur_px(cornerDepths[i], dof), 2);
  // Math.max / Math.min over four finite-or-NaN numbers.
  double maxPx = -std::numeric_limits<double>::infinity();
  double minPx = std::numeric_limits<double>::infinity();
  bool nan = false;
  for (const double c : out.corners) {
    if (std::isnan(c)) nan = true;
    maxPx = std::max(maxPx, c);
    minPx = std::min(minPx, c);
  }
  if (nan) {
    // Math.max/min propagate NaN, both guards below compare false, and
    // Number(NaN.toFixed(1)) is NaN — the TypeScript returns the plan.
    out.maxPx = std::numeric_limits<double>::quiet_NaN();
    return out;
  }
  if (maxPx - minPx < 1.25) return std::nullopt;
  if (maxPx < 0.3) return std::nullopt;
  out.maxPx = fixed_num(maxPx, 1);
  return out;
}

Json planar_dof_effect(const PlanarCoc& planar, const DofConfig& dof) {
  Json params = Json::object();
  params.set("amount", Json::number(planar.maxPx));
  params.set("coc0", Json::number(planar.corners[0]));
  params.set("coc1", Json::number(planar.corners[1]));
  params.set("coc2", Json::number(planar.corners[2]));
  params.set("coc3", Json::number(planar.corners[3]));
  set_iris(params, dof_iris_params(dof));
  Json e = Json::object();
  e.set("id", Json::string("dof"));
  e.set("type", Json::string("blur"));
  e.set("params", std::move(params));
  return e;
}

namespace {

double pct(const Json& v, double fallback) {
  return v.is_number() ? std::max(0.0, std::min(100.0, v.num())) : fallback;
}

std::string shadow_mode(const Json& v) {
  if ((v.is_string() && v.str() == "only") || (v.is_number() && v.num() == 2)) return "only";
  if ((v.is_bool() && !v.b()) || (v.is_string() && v.str() == "off") || (v.is_number() && v.num() == 0)) return "off";
  if (v.is_number()) {
    if (v.num() >= 1.5) return "only";
    if (v.num() >= 0.5) return "on";
    return "off";
  }
  return "on";
}

bool accepts_lights_flag(const Json& v) {
  if (v.is_number()) return v.num() > 0.5;
  return v.is_bool() && v.b();
}

}  // namespace

Material read_node_material(const doc::Node& n, const AnimatedLookup& animated) {
  static constexpr std::array<std::string_view, 17> kAnimatable = {
      "ambient",      "diffuse",           "specular",            "shininess",           "metal",
      "lightTransmission", "roughness",    "acceptsLights",       "castsShadows",        "acceptsShadows",
      "displacement", "reflectionIntensity", "reflectionSharpness", "reflectionRolloff", "transparency",
      "transparencyRolloff", "ior"};
  const doc::Component* t = n.comp("Transform");
  const Json empty = Json::object();
  Json p = t != nullptr && t->props.is_object() ? t->props : empty;
  if (animated) {
    for (const std::string_view k : kAnimatable) {
      if (const auto v = animated(k)) p.set(std::string(k), Json::number(*v));
    }
  }
  Material m;
  m.castsShadowsMode = shadow_mode(p.at("castsShadows"));
  m.acceptsShadowsMode = shadow_mode(p.at("acceptsShadows"));
  m.castsShadows = m.castsShadowsMode != "off";
  m.shadowOnly = m.castsShadowsMode == "only" || m.acceptsShadowsMode == "only";
  m.acceptsLights = accepts_lights_flag(p.at("acceptsLights"));
  m.acceptsShadows = m.acceptsShadowsMode != "off";
  m.lightTransmission = pct(p.at("lightTransmission"), 0);
  m.ambient = pct(p.at("ambient"), 100);
  m.diffuse = pct(p.at("diffuse"), 50);
  m.metal = pct(p.at("metal"), 0);
  m.specular = pct(p.at("specular"), 0);
  m.shininess = p.at("shininess").is_number() ? std::max(1.0, p.at("shininess").num()) : 32;
  const Json& sm = p.at("shadingModel");
  m.shading = sm.is_string() && sm.str() == "pbr" ? "pbr" : sm.is_string() && sm.str() == "toon" ? "toon" : "phong";
  m.roughness = pct(p.at("roughness"), 50);
  m.toonBands = p.at("toonBands").is_number() ? std::max(2.0, std::min(8.0, motion::js::round(p.at("toonBands").num()))) : 3;
  if (p.at("heightMapAssetId").is_string() && !p.at("heightMapAssetId").str().empty()) m.heightMapAssetId = p.at("heightMapAssetId").str();
  if (p.at("heightMapSrc").is_string() && !p.at("heightMapSrc").str().empty()) m.heightMapSrc = p.at("heightMapSrc").str();
  const Json& disp = p.at("displacement");
  m.displacement = disp.is_number() && std::isfinite(disp.num()) ? std::max(-2000.0, std::min(2000.0, disp.num())) : 0;
  m.displacementSubdivisions =
      p.at("displacementSubdiv").is_number() ? std::max(0.0, std::min(3.0, motion::js::round(p.at("displacementSubdiv").num()))) : 0;
  m.reflectionIntensity = pct(p.at("reflectionIntensity"), 100);
  m.reflectionSharpness = pct(p.at("reflectionSharpness"), 0);
  m.reflectionRolloff = pct(p.at("reflectionRolloff"), 0);
  m.transparency = pct(p.at("transparency"), 0);
  m.transparencyRolloff = pct(p.at("transparencyRolloff"), 0);
  const Json& ior = p.at("ior");
  m.ior = ior.is_number() && std::isfinite(ior.num()) ? std::max(1.0, std::min(4.0, ior.num())) : 1.52;
  return m;
}

}  // namespace premation::scene
