#include "lights3d.hpp"

#include <algorithm>
#include <cmath>
#include <numbers>

#include "jsmath.hpp"
#include "readers.hpp"

namespace premation::scene {

using js::Json;

namespace {

constexpr double kDeg = std::numbers::pi / 180;
constexpr double kSqrt1_2 = 0.7071067811865476;  // Math.SQRT1_2

double hypot3(double a, double b, double c) {
  const std::array<double, 3> v{a, b, c};
  return motion::js::hypot(v);
}

std::string light_type(const std::string& v) {
  return v == "ambient" || v == "spot" || v == "parallel" || v == "environment" ? v : "point";
}

std::string light_falloff(const std::string& v) {
  return v == "smooth" || v == "inverse-square" || v == "legacy" ? v : "none";
}

bool is_environment_sky(const Json& v) {
  if (!v.is_string()) return false;
  const std::string& s = v.str();
  return s == "studio" || s == "sky" || s == "sunset" || s.starts_with("asset:");
}

bool on(const Json& v) { return (v.is_bool() && v.b()) || (v.is_number() && v.num() == 1); }

/// Full at the light, zero at `radius`, straight line between.
double legacy_ramp(double d, double radius) {
  if (radius <= 0) return 1;
  return d >= radius ? 0 : 1 - d / radius;
}

}  // namespace

LightProps read_node_light(const doc::Node& n) {
  LightProps lt;
  lt.envPreset = Json::string("studio");
  std::optional<double> poiX, poiY, poiZ;
  const auto num = [](const Json& v, double fb) { return v.is_number() ? v.num() : fb; };
  for (const doc::Component& c : n.components) {
    const Json& p = c.props;
    if (p.at("lightType").is_string()) lt.type = light_type(p.at("lightType").str());
    if (p.at("fill").is_string()) lt.color = p.at("fill").str();
    if (p.at("falloff").is_string()) lt.falloff = light_falloff(p.at("falloff").str());
    lt.intensity = num(p.at("intensity"), lt.intensity);
    lt.radius = num(p.at("radius"), lt.radius);
    lt.angle = num(p.at("lightAngle"), lt.angle);
    lt.cone = num(p.at("lightCone"), lt.cone);
    lt.coneFeather = num(p.at("lightConeFeather"), lt.coneFeather);
    lt.falloffDistance = num(p.at("falloffDistance"), lt.falloffDistance);
    lt.shadowDarkness = num(p.at("shadowDarkness"), lt.shadowDarkness);
    lt.shadowDiffusion = num(p.at("shadowDiffusion"), lt.shadowDiffusion);
    if (p.at("poiX").is_number()) poiX = p.at("poiX").num();
    if (p.at("poiY").is_number()) poiY = p.at("poiY").num();
    if (p.at("poiZ").is_number()) poiZ = p.at("poiZ").num();
    if (on(p.at("castShadows"))) lt.shadows = true;
    if (on(p.at("lightGlow"))) lt.glow = true;
    if (on(p.at("shadowMap"))) lt.shadowMap = true;
    lt.shadowMapSize = num(p.at("shadowMapSize"), lt.shadowMapSize);
    lt.shadowBias = num(p.at("shadowBias"), lt.shadowBias);
    lt.shadowSoftness = num(p.at("shadowSoftness"), lt.shadowSoftness);
    if (is_environment_sky(p.at("envPreset"))) lt.envPreset = p.at("envPreset");
    lt.envRotation = num(p.at("envRotation"), lt.envRotation);
    lt.envReflections = num(p.at("envReflections"), lt.envReflections);
  }
  if (poiX || poiY || poiZ) lt.poi = std::array<double, 3>{poiX.value_or(0), poiY.value_or(0), poiZ.value_or(0)};
  return lt;
}

SceneLight scene_light_of(const LightProps& lt) {
  SceneLight s;
  s.type = lt.type;
  s.color = lt.color;
  s.intensity = lt.intensity;
  s.radius = lt.radius;
  s.angle = lt.angle;
  s.cone = lt.cone;
  s.shadows = lt.shadows;
  s.coneFeather = lt.coneFeather;
  s.falloff = lt.falloff;
  s.falloffDistance = lt.falloffDistance;
  s.poi = lt.poi;
  s.shadowMap = lt.shadowMap;
  s.shadowMapSize = lt.shadowMapSize;
  s.shadowBias = lt.shadowBias;
  s.shadowSoftness = lt.shadowSoftness;
  s.shadowDarkness = lt.shadowDarkness;
  return s;
}

double light_falloff_at(double distance, const std::optional<std::string>& falloff, double radius,
                        const std::optional<double>& falloffDistance) {
  if (!falloff || *falloff == "none") return 1;
  const double d = std::max(0.0, distance);
  if (*falloff == "legacy") return legacy_ramp(d, radius);
  const double r = std::max(1.0, radius);
  if (d <= r) return 1;
  if (*falloff == "smooth") {
    const double span = std::max(1.0, falloffDistance.value_or(500));
    return std::max(0.0, 1 - (d - r) / span);
  }
  return (r * r) / (d * d);
}

double light_attenuation_at(double distance, const std::optional<std::string>& falloff, double radius,
                            const std::optional<double>& falloffDistance) {
  const double d = std::max(0.0, distance);
  if (!falloff || *falloff == "none" || *falloff == "legacy") return legacy_ramp(d, radius);
  return light_falloff_at(d, falloff, radius, falloffDistance);
}

double light_reach(const std::optional<std::string>& falloff, double radius, const std::optional<double>& falloffDistance) {
  const double r = std::max(1.0, radius);
  if (!falloff || *falloff == "none") return r;
  if (*falloff == "smooth") return r + std::max(1.0, falloffDistance.value_or(500));
  return r * 16;
}

std::optional<std::array<double, 3>> light_aim_3d(const SceneLight& l) {
  if (!l.poi) return std::nullopt;
  const double dx = (*l.poi)[0] - l.x;
  const double dy = (*l.poi)[1] - l.y;
  const double dz = (*l.poi)[2] - l.z;
  const double len = hypot3(dx, dy, dz);
  if (!(len > 1e-9)) return std::nullopt;
  return std::array<double, 3>{dx / len, dy / len, dz / len};
}

std::optional<double> aim_to_comp_angle_deg(const std::array<double, 3>& aim) {
  const std::array<double, 2> v{aim[0], aim[1]};
  if (motion::js::hypot(v) < 1e-9) return std::nullopt;
  return motion::js::atan2(aim[1], aim[0]) / kDeg;
}

std::array<double, 3> plane_normal_of(const std::array<double, 16>& w) {
  const double x = w[8];
  const double y = w[9];
  const double z = w[10];
  const double len = hypot3(x, y, z);
  if (len < 1e-9) return {0, 0, 1};
  return {x / len, y / len, z / len};
}

namespace {

double ndotl(double d, bool oneSided) { return oneSided ? std::max(d, 0.0) : std::abs(d); }
double clamp_gain(double v) { return std::min(4.0, std::max(0.0, v)); }

}  // namespace

std::optional<std::array<double, 3>> shade_layer(const std::array<double, 3>& normal, const std::array<double, 3>& pos,
                                                 const std::vector<SceneLight>& lights, std::optional<double> ambient,
                                                 std::optional<double> diffuse, bool oneSided) {
  if (lights.empty()) return std::nullopt;
  const double kAmbient = ambient.value_or(100) / 100;
  const double kDiffuse = diffuse.value_or(50) / 50;
  double r = 0;
  double g = 0;
  double b = 0;
  for (const SceneLight& light : lights) {
    const Rgba c = color_from_hex(light.color);
    const double gain = std::max(0.0, light.intensity / 100);
    if (gain <= 0) continue;
    if (light.type == "ambient") {
      r += c.r * gain * kAmbient;
      g += c.g * gain * kAmbient;
      b += c.b * gain * kAmbient;
      continue;
    }
    double lambert = 0;
    double atten = 1;
    if (light.type == "parallel") {
      const double dx = motion::js::cos(light.angle * kDeg);
      const double dy = motion::js::sin(light.angle * kDeg);
      const std::array<double, 3> L = light_aim_3d(light).value_or(std::array<double, 3>{dx * kSqrt1_2, dy * kSqrt1_2, -kSqrt1_2});
      lambert = ndotl(normal[0] * L[0] + normal[1] * L[1] + normal[2] * L[2], oneSided);
    } else {
      const double lx = light.x - pos[0];
      const double ly = light.y - pos[1];
      const double lz = light.z - pos[2];
      const double d = hypot3(lx, ly, lz);
      const double curve = light_falloff_at(d, light.falloff, light.radius, light.falloffDistance);
      if (curve <= 0.001) continue;
      atten = curve;
      const double inv = d < 1e-9 ? 0 : 1 / d;
      lambert = d < 1e-9 ? 1 : ndotl(normal[0] * lx * inv + normal[1] * ly * inv + normal[2] * lz * inv, oneSided);
      if (light.type == "spot" && d > 1e-9) {
        const std::array<double, 3> aim = light_aim_3d(light).value_or(
            std::array<double, 3>{motion::js::cos(light.angle * kDeg), motion::js::sin(light.angle * kDeg), 0});
        const double toLayerX = -lx * inv;
        const double toLayerY = -ly * inv;
        const double toLayerZ = -lz * inv;
        const double cosA = aim[0] * toLayerX + aim[1] * toLayerY + aim[2] * toLayerZ;
        const double half = std::max(1e-3, (light.cone / 2) * kDeg);
        const double ang = motion::js::acos(std::min(1.0, std::max(-1.0, cosA)));
        if (ang > half) continue;
        const double feather = half * (!light.coneFeather ? 0.2 : std::max(0.0, *light.coneFeather) / 100);
        if (feather > 1e-6 && ang > half - feather) {
          const double u = (half - ang) / feather;
          atten *= u * u * (3 - 2 * u);
        }
      }
    }
    const double k = gain * lambert * atten * kDiffuse;
    r += c.r * k;
    g += c.g * k;
    b += c.b * k;
  }
  return std::array<double, 3>{clamp_gain(r), clamp_gain(g), clamp_gain(b)};
}

std::vector<api::RenderLight3D> to_shader_lights(const std::vector<SceneLight>& lights) {
  std::vector<api::RenderLight3D> out;
  for (const SceneLight& light : lights) {
    if (light.type == "environment") continue;
    const double gain = std::max(0.0, light.intensity / 100);
    if (gain <= 0) continue;
    const Rgba c = color_from_hex(light.color);
    std::array<double, 3> aim{};
    if (const auto poi = light_aim_3d(light)) {
      aim = *poi;
    } else {
      const double dx = motion::js::cos(light.angle * kDeg);
      const double dy = motion::js::sin(light.angle * kDeg);
      aim = light.type == "parallel" ? std::array<double, 3>{dx * kSqrt1_2, dy * kSqrt1_2, -kSqrt1_2}
                                     : std::array<double, 3>{dx, dy, 0};
    }
    const double halfConeRad = std::max(1e-3, (light.cone / 2) * kDeg);
    const double featherPct = !light.coneFeather ? 0.2 : std::max(0.0, *light.coneFeather) / 100;
    api::RenderLight3D o;
    o.type = light.type == "ambient"    ? api::RenderLightType::ambient
             : light.type == "spot"     ? api::RenderLightType::spot
             : light.type == "parallel" ? api::RenderLightType::parallel
                                        : api::RenderLightType::point;
    o.color = {c.r, c.g, c.b};
    o.gain = gain;
    o.x = light.x;
    o.y = light.y;
    o.z = light.z;
    o.radius = light.radius;
    o.aim_x = aim[0];
    o.aim_y = aim[1];
    o.aim_z = aim[2];
    o.half_cone_rad = halfConeRad;
    o.cone_feather_rad = halfConeRad * featherPct;
    const std::string f = light.falloff.value_or("none");
    o.falloff_mode = f == "smooth" ? 1 : f == "inverse-square" ? 2 : f == "legacy" ? 3 : 0;
    o.falloff_distance = std::max(1.0, light.falloffDistance.value_or(500));
    if (light.shadowMap.value_or(false) && light.shadows) {
      o.shadow_map = true;
      if (light.shadowMapSize) o.shadow_map_size = light.shadowMapSize;
      if (light.shadowBias) o.shadow_bias = light.shadowBias;
      if (light.shadowSoftness) o.shadow_softness = light.shadowSoftness;
      if (light.shadowDarkness) o.shadow_darkness = *light.shadowDarkness / 100;
    }
    out.push_back(std::move(o));
  }
  return out;
}

}  // namespace premation::scene
