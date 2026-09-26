// Cross-engine 3D parity (tests/data/threed_parity.json, frozen from the
// TypeScript engine's threeDCrossEngine.test.ts): the snapshot's pure 3D
// readers and shading — depth of field, Material Options, light props,
// falloff, per-quad Lambert, the shader lights — must give the editor's
// doubles bit for bit. PARITY_REBLESS=1 writes the C++ answers instead
// (parity_rebless.hpp).
//
// The TEST_CASEs share the fixture: each loads it, answers only its own
// sections and writes it back, so a re-bless of any subset (or of all of them,
// one after the other) leaves one complete, consistent file.
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "camera3d_port.hpp"
#include "env_light.hpp"
#include "json.hpp"
#include "lights3d.hpp"
#include "parity_rebless.hpp"

namespace sc = premation::scene;
using premation::js::Json;
using premation::test::JsonFixture;
using premation::test::json_numbers;

namespace {

std::optional<double> opt(const Json& o, std::string_view k) {
  return o.at(k).is_number() ? std::optional<double>(o.at(k).num()) : std::nullopt;
}

/// fx.answer(holder, key, got), naming both values when they differ (compare
/// mode). JSON number equality is exact — bit for bit but for -0 == 0 (JSON
/// cannot carry -0 or NaN, and the fixture holds neither).
void answer(JsonFixture& fx, Json& holder, std::string_view key, Json got) {
  if (!fx.reblessing() && !(holder.at(key) == got)) {
    FAIL_CHECK(std::string(key) << ":\n  fixture " << premation::js::stringify(holder.at(key)) << "\n  C++     "
                                << premation::js::stringify(got));
    return;
  }
  (void)fx.answer(holder, key, std::move(got));
}

/// A JSON object in the TypeScript's key order; `opt` members are present only
/// when set (the TypeScript's conditional spreads / optional keys).
class Obj {
 public:
  Obj& put(std::string key, Json v) {
    o_.push_back({std::move(key), std::move(v)});
    return *this;
  }
  Obj& num(std::string key, double v) { return put(std::move(key), Json::number(v)); }
  Obj& str(std::string key, std::string v) { return put(std::move(key), Json::string(std::move(v))); }
  Obj& flag(std::string key, bool v) { return put(std::move(key), Json::boolean(v)); }
  Obj& opt(std::string key, const std::optional<double>& v) {
    if (v) num(std::move(key), *v);
    return *this;
  }
  [[nodiscard]] Json json() { return Json::object(std::move(o_)); }

 private:
  Json::Object o_;
};

Json xyz(const std::array<double, 3>& v) { return Obj().num("x", v[0]).num("y", v[1]).num("z", v[2]).json(); }

/// DofConfig as camera3d.ts builds it (readNodeDof's key order).
Json dof_json(const sc::DofConfig& d) {
  return Obj()
      .num("strength", d.strength)
      .num("focus", d.focus)
      .num("aperture", d.aperture)
      .opt("focalLength", d.focalLength)
      .opt("fStop", d.fStop)
      .opt("irisBlades", d.irisBlades)
      .opt("irisRoundness", d.irisRoundness)
      .opt("highlightGain", d.highlightGain)
      .opt("irisRotation", d.irisRotation)
      .opt("irisAspect", d.irisAspect)
      .opt("highlightThreshold", d.highlightThreshold)
      .opt("highlightSaturation", d.highlightSaturation)
      .opt("diffractionFringe", d.diffractionFringe)
      .json();
}

Json iris_json(const sc::IrisParams& i) {
  return Obj()
      .opt("blades", i.blades)
      .opt("roundness", i.roundness)
      .opt("highlightGain", i.highlightGain)
      .opt("rotationDeg", i.rotationDeg)
      .opt("aspect", i.aspect)
      .opt("highlightThreshold", i.highlightThreshold)
      .opt("highlightSaturation", i.highlightSaturation)
      .opt("fringe", i.fringe)
      .json();
}

/// material.ts readNodeMaterial's object (no height map among the inputs).
Json material_json(const sc::Material& m) {
  return Obj()
      .flag("castsShadows", m.castsShadows)
      .str("castsShadowsMode", m.castsShadowsMode)
      .str("acceptsShadowsMode", m.acceptsShadowsMode)
      .flag("shadowOnly", m.shadowOnly)
      .flag("acceptsLights", m.acceptsLights)
      .flag("acceptsShadows", m.acceptsShadows)
      .num("lightTransmission", m.lightTransmission)
      .num("ambient", m.ambient)
      .num("diffuse", m.diffuse)
      .num("metal", m.metal)
      .num("specular", m.specular)
      .num("shininess", m.shininess)
      .str("shading", m.shading)
      .num("roughness", m.roughness)
      .num("toonBands", m.toonBands)
      .num("displacement", m.displacement)
      .num("displacementSubdivisions", m.displacementSubdivisions)
      .num("reflectionIntensity", m.reflectionIntensity)
      .num("reflectionSharpness", m.reflectionSharpness)
      .num("reflectionRolloff", m.reflectionRolloff)
      .num("transparency", m.transparency)
      .num("transparencyRolloff", m.transparencyRolloff)
      .num("ior", m.ior)
      .json();
}

/// light.ts readNodeLight's object.
Json light_json(const sc::LightProps& l) {
  return Obj()
      .str("type", l.type)
      .str("color", l.color)
      .num("intensity", l.intensity)
      .num("radius", l.radius)
      .num("angle", l.angle)
      .num("cone", l.cone)
      .num("coneFeather", l.coneFeather)
      .str("falloff", l.falloff)
      .num("falloffDistance", l.falloffDistance)
      .flag("shadows", l.shadows)
      .flag("glow", l.glow)
      .num("shadowDarkness", l.shadowDarkness)
      .num("shadowDiffusion", l.shadowDiffusion)
      .flag("shadowMap", l.shadowMap)
      .num("shadowMapSize", l.shadowMapSize)
      .num("shadowBias", l.shadowBias)
      .num("shadowSoftness", l.shadowSoftness)
      .put("poi", l.poi ? xyz(*l.poi) : Json::null())
      .put("envPreset", l.envPreset)
      .num("envRotation", l.envRotation)
      .num("envReflections", l.envReflections)
      .json();
}

/// lightShading.ts toShaderLights' entry (the shadow keys only when set).
Json shader_json(const premation::api::RenderLight3D& g) {
  Obj o;
  o.str("type", std::string(premation::api::to_string(g.type)))
      .put("color", Obj().num("r", g.color.at(0)).num("g", g.color.at(1)).num("b", g.color.at(2)).json())
      .num("gain", g.gain)
      .num("x", g.x)
      .num("y", g.y)
      .num("z", g.z)
      .num("radius", g.radius)
      .num("aimX", g.aim_x)
      .num("aimY", g.aim_y)
      .num("aimZ", g.aim_z)
      .num("halfConeRad", g.half_cone_rad)
      .num("coneFeatherRad", g.cone_feather_rad)
      .num("falloffMode", g.falloff_mode)
      .num("falloffDistance", g.falloff_distance);
  if (g.shadow_map.value_or(false)) o.flag("shadowMap", true);
  return o.opt("shadowMapSize", g.shadow_map_size)
      .opt("shadowBias", g.shadow_bias)
      .opt("shadowSoftness", g.shadow_softness)
      .opt("shadowDarkness", g.shadow_darkness)
      .json();
}

std::string fnv1a64(const std::vector<std::uint8_t>& bytes) {
  std::uint64_t h = 0xcbf29ce484222325ULL;
  for (const std::uint8_t b : bytes) {
    h ^= b;
    h *= 0x100000001b3ULL;
  }
  std::array<char, 17> hex{};
  std::snprintf(hex.data(), hex.size(), "%016llx", static_cast<unsigned long long>(h));  // NOLINT(cppcoreguidelines-pro-type-vararg)
  return std::string(hex.data());
}

sc::DofConfig dof_of(const Json& d) {
  sc::DofConfig c;
  c.strength = d.at("strength").num();
  c.focus = d.at("focus").num();
  c.aperture = d.at("aperture").num();
  c.focalLength = opt(d, "focalLength");
  c.fStop = opt(d, "fStop");
  c.irisBlades = opt(d, "irisBlades");
  c.irisRoundness = opt(d, "irisRoundness");
  c.highlightGain = opt(d, "highlightGain");
  c.irisRotation = opt(d, "irisRotation");
  c.irisAspect = opt(d, "irisAspect");
  c.highlightThreshold = opt(d, "highlightThreshold");
  c.highlightSaturation = opt(d, "highlightSaturation");
  c.diffractionFringe = opt(d, "diffractionFringe");
  return c;
}

premation::doc::Node node_of(const std::string& kind, const Json& props, const Json& style) {
  premation::doc::Node n;
  n.id = "n";
  n.name = "n";
  premation::doc::Component t;
  t.id = "t";
  t.type = "Transform";
  t.props = Json::object();
  t.props.set("__kind", Json::string(kind));
  for (const auto& m : props.obj()) t.props.set(m.key, m.value);
  n.components.push_back(std::move(t));
  if (style.is_object()) {
    premation::doc::Component s;
    s.id = "s";
    s.type = "Style";
    s.props = style;
    n.components.push_back(std::move(s));
  }
  return n;
}

sc::SceneLight scene_light_of(const Json& o) {
  sc::SceneLight l;
  l.type = o.at("type").str();
  l.color = o.at("color").str();
  l.intensity = o.at("intensity").num();
  l.radius = o.at("radius").num();
  l.angle = o.at("angle").num();
  l.cone = o.at("cone").num();
  l.shadows = o.at("shadows").b();
  l.coneFeather = opt(o, "coneFeather");
  if (o.at("falloff").is_string()) l.falloff = o.at("falloff").str();
  l.falloffDistance = opt(o, "falloffDistance");
  if (o.at("poi").is_object()) l.poi = std::array<double, 3>{o.at("poi").at("x").num(), o.at("poi").at("y").num(), o.at("poi").at("z").num()};
  if (o.at("shadowMap").is_bool()) l.shadowMap = o.at("shadowMap").b();
  l.shadowMapSize = opt(o, "shadowMapSize");
  l.shadowBias = opt(o, "shadowBias");
  l.shadowSoftness = opt(o, "shadowSoftness");
  l.shadowDarkness = opt(o, "shadowDarkness");
  l.x = o.at("x").num();
  l.y = o.at("y").num();
  l.z = o.at("z").num();
  return l;
}

}  // namespace

TEST_CASE("3D parity: depth of field", "[scene][threed][parity]") {
  JsonFixture fx("threed_parity.json");
  REQUIRE(fx.ok());
  const Json::Array depths = fx.root().at("depths").arr();
  const Json::Array planarIn = fx.root().at("planarInputs").arr();
  auto& dofRows = fx.root().find_mut("dof")->arr_mut();
  REQUIRE(dofRows.size() >= 8);
  for (Json& row : dofRows) {
    const sc::DofConfig d = dof_of(row.at("dof"));
    Json::Array blur;
    for (const Json& z : depths) blur.push_back(Json::number(sc::dof_blur_px(z.num(), d)));
    answer(fx, row, "blur", Json::array(std::move(blur)));
    answer(fx, row, "iris", iris_json(sc::dof_iris_params(d)));
    Json::Array planar;
    for (const Json& corners : planarIn) {
      const Json::Array& c = corners.arr();
      const auto plan = sc::plan_dof_coc_corners({c[0].num(), c[1].num(), c[2].num(), c[3].num()}, d);
      planar.push_back(plan ? Obj().put("corners", json_numbers(plan->corners)).num("maxPx", plan->maxPx).json() : Json::null());
    }
    answer(fx, row, "planar", Json::array(std::move(planar)));
  }
  for (Json& row : fx.root().find_mut("dofNodes")->arr_mut()) {
    const auto n = node_of("camera", row.at("props"), Json());
    const auto d = sc::read_node_dof(n, row.at("width").num(), row.at("height").num(), {});
    answer(fx, row, "dof", d ? dof_json(*d) : Json::null());
  }
  REQUIRE(fx.finish());
}

TEST_CASE("3D parity: Material Options", "[scene][threed][parity]") {
  JsonFixture fx("threed_parity.json");
  REQUIRE(fx.ok());
  for (Json& row : fx.root().find_mut("materials")->arr_mut()) {
    answer(fx, row, "material", material_json(sc::read_node_material(node_of("shape", row.at("props"), Json()))));
  }
  REQUIRE(fx.finish());
}

TEST_CASE("3D parity: light props and falloff", "[scene][threed][parity]") {
  JsonFixture fx("threed_parity.json");
  REQUIRE(fx.ok());
  for (Json& row : fx.root().find_mut("lights")->arr_mut()) {
    answer(fx, row, "light", light_json(sc::read_node_light(node_of("light", row.at("props"), row.at("style")))));
  }
  const Json::Array dist = fx.root().at("distances").arr();
  for (Json& row : fx.root().find_mut("falloff")->arr_mut()) {
    const Json& l = row.at("light");
    const std::optional<std::string> falloff = l.at("falloff").is_string() ? std::optional<std::string>(l.at("falloff").str()) : std::nullopt;
    const double radius = l.at("radius").num();
    const std::optional<double> fd = opt(l, "falloffDistance");
    Json::Array falloffAt;
    Json::Array attenuationAt;
    for (const Json& x : dist) {
      falloffAt.push_back(Json::number(sc::light_falloff_at(x.num(), falloff, radius, fd)));
      attenuationAt.push_back(Json::number(sc::light_attenuation_at(x.num(), falloff, radius, fd)));
    }
    answer(fx, row, "falloffAt", Json::array(std::move(falloffAt)));
    answer(fx, row, "attenuationAt", Json::array(std::move(attenuationAt)));
    answer(fx, row, "reach", Json::number(sc::light_reach(falloff, radius, fd)));
  }
  REQUIRE(fx.finish());
}

TEST_CASE("3D parity: per-quad shading and shader lights", "[scene][threed][parity]") {
  JsonFixture fx("threed_parity.json");
  REQUIRE(fx.ok());
  const Json::Array surfaces = fx.root().at("surfaces").arr();
  const Json::Array responses = fx.root().at("responses").arr();
  for (Json& row : fx.root().find_mut("shading")->arr_mut()) {
    std::vector<sc::SceneLight> set;
    for (const Json& o : row.at("lights").arr()) set.push_back(scene_light_of(o));
    Json::Array shade;
    for (const Json& s : surfaces) {
      const std::array<double, 3> normal{s.at("normal").arr()[0].num(), s.at("normal").arr()[1].num(), s.at("normal").arr()[2].num()};
      const std::array<double, 3> pos{s.at("pos").at("x").num(), s.at("pos").at("y").num(), s.at("pos").at("z").num()};
      for (const Json& m : responses) {
        for (const bool oneSided : {false, true}) {
          const auto got = sc::shade_layer(normal, pos, set, m.is_object() ? opt(m, "ambient") : std::nullopt,
                                           m.is_object() ? opt(m, "diffuse") : std::nullopt, oneSided);
          shade.push_back(got ? json_numbers(*got) : Json::null());
        }
      }
    }
    answer(fx, row, "shade", Json::array(std::move(shade)));
    Json::Array shader;
    for (const auto& g : sc::to_shader_lights(set)) shader.push_back(shader_json(g));
    answer(fx, row, "shader", Json::array(std::move(shader)));
    Json::Array aims;
    for (const sc::SceneLight& l : set) {
      const auto a = sc::light_aim_3d(l);
      const auto deg = a ? sc::aim_to_comp_angle_deg(*a) : std::nullopt;
      aims.push_back(Obj().put("aim", a ? json_numbers(*a) : Json::null()).put("compDeg", deg ? Json::number(*deg) : Json::null()).json());
    }
    answer(fx, row, "aims", Json::array(std::move(aims)));
  }
  REQUIRE(fx.finish());
}

TEST_CASE("3D parity: environment reflection atlas", "[scene][threed][parity]") {
  JsonFixture fx("threed_parity.json");
  REQUIRE(fx.ok());
  auto& rows = fx.root().find_mut("specular")->arr_mut();
  REQUIRE(rows.size() == 3);
  for (Json& row : rows) {
    INFO(row.at("sky").str());
    const auto m = sc::environment_specular_map(row.at("sky").str());
    REQUIRE(m.has_value());
    answer(fx, row, "id", Json::string(m->id));
    answer(fx, row, "width", Json::number(m->width));
    answer(fx, row, "height", Json::number(m->height));
    answer(fx, row, "levels", Json::number(m->levels));
    answer(fx, row, "scale", Json::number(m->scale));
    answer(fx, row, "dataFnv", Json::string(fnv1a64(m->data)));
  }
  REQUIRE(fx.finish());
}

TEST_CASE("3D parity: environment light rig", "[scene][threed][parity]") {
  JsonFixture fx("threed_parity.json");
  REQUIRE(fx.ok());
  for (Json& row : fx.root().find_mut("sh")->arr_mut()) {
    INFO(row.at("id").str());
    answer(fx, row, "sh", json_numbers(sc::preset_sh(row.at("id").str())));
  }
  auto& envRows = fx.root().find_mut("env")->arr_mut();
  REQUIRE(envRows.size() >= 16);
  for (Json& row : envRows) {
    INFO(row.at("sky").str() << " " << row.at("intensity").num() << " " << row.at("rotation").num());
    const auto rig = sc::environment_rig_for(row.at("sky").str(), row.at("intensity").num(), row.at("rotation").num());
    REQUIRE(rig.has_value());
    Json::Array got;
    for (const sc::EnvRigLight& l : *rig) {
      Obj o;
      o.str("kind", l.ambient ? "ambient" : "parallel").str("color", l.color).num("intensity", l.intensity);
      if (!l.ambient) o.put("from", xyz(l.from));
      got.push_back(o.json());
    }
    answer(fx, row, "rig", Json::array(std::move(got)));
  }
  REQUIRE(fx.finish());
}
