// Cross-engine 3D parity (tests/data/threed_parity.json, written by
// src/core/scene/threeDCrossEngine.test.ts): the snapshot's pure 3D readers and
// shading — depth of field, Material Options, light props, falloff, per-quad
// Lambert, the shader lights — must give the editor's doubles bit for bit.
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstring>
#include <fstream>
#include <optional>
#include <sstream>
#include <string>

#include "camera3d_port.hpp"
#include "env_light.hpp"
#include "json.hpp"
#include "lights3d.hpp"

namespace sc = premation::scene;
using premation::js::Json;

namespace {

Json load() {
  std::ifstream f(std::string(PREMATION_ENGINE_TEST_DATA) + "/threed_parity.json", std::ios::binary);
  REQUIRE(f.good());
  std::stringstream ss;
  ss << f.rdbuf();
  auto j = premation::js::parse(ss.str());
  REQUIRE(j.has_value());
  return *j;
}

/// Bit equality (JSON cannot carry -0 or NaN, and the fixture holds neither).
bool same(double a, double b) { return std::memcmp(&a, &b, sizeof a) == 0 || (a == 0 && b == 0); }

std::optional<double> opt(const Json& o, std::string_view k) {
  return o.at(k).is_number() ? std::optional<double>(o.at(k).num()) : std::nullopt;
}

void check_opt(const std::optional<double>& mine, const Json& o, std::string_view k) {
  INFO(std::string(k));
  REQUIRE(mine.has_value() == o.at(k).is_number());
  if (mine) CHECK(same(*mine, o.at(k).num()));
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
  const Json fx = load();
  const Json::Array& depths = fx.at("depths").arr();
  const Json::Array& planarIn = fx.at("planarInputs").arr();
  REQUIRE(fx.at("dof").arr().size() >= 8);
  for (const Json& row : fx.at("dof").arr()) {
    const sc::DofConfig d = dof_of(row.at("dof"));
    for (std::size_t i = 0; i < depths.size(); ++i) {
      INFO("depth " << depths[i].num());
      CHECK(same(sc::dof_blur_px(depths[i].num(), d), row.at("blur").arr()[i].num()));
    }
    const sc::IrisParams iris = sc::dof_iris_params(d);
    const Json& ti = row.at("iris");
    check_opt(iris.blades, ti, "blades");
    check_opt(iris.roundness, ti, "roundness");
    check_opt(iris.highlightGain, ti, "highlightGain");
    check_opt(iris.rotationDeg, ti, "rotationDeg");
    check_opt(iris.aspect, ti, "aspect");
    check_opt(iris.highlightThreshold, ti, "highlightThreshold");
    check_opt(iris.highlightSaturation, ti, "highlightSaturation");
    check_opt(iris.fringe, ti, "fringe");
    for (std::size_t p = 0; p < planarIn.size(); ++p) {
      const Json::Array& c = planarIn[p].arr();
      const auto plan = sc::plan_dof_coc_corners({c[0].num(), c[1].num(), c[2].num(), c[3].num()}, d);
      const Json& want = row.at("planar").arr()[p];
      REQUIRE(plan.has_value() == want.is_object());
      if (!plan) continue;
      for (std::size_t k = 0; k < 4; ++k) CHECK(same(plan->corners[k], want.at("corners").arr()[k].num()));
      CHECK(same(plan->maxPx, want.at("maxPx").num()));
    }
  }
  for (const Json& row : fx.at("dofNodes").arr()) {
    const auto n = node_of("camera", row.at("props"), Json());
    const auto d = sc::read_node_dof(n, row.at("width").num(), row.at("height").num(), {});
    REQUIRE(d.has_value() == row.at("dof").is_object());
    if (!d) continue;
    const Json& w = row.at("dof");
    CHECK(same(d->strength, w.at("strength").num()));
    CHECK(same(d->focus, w.at("focus").num()));
    CHECK(same(d->aperture, w.at("aperture").num()));
    check_opt(d->focalLength, w, "focalLength");
    check_opt(d->fStop, w, "fStop");
    check_opt(d->irisBlades, w, "irisBlades");
    check_opt(d->irisRoundness, w, "irisRoundness");
    check_opt(d->highlightGain, w, "highlightGain");
    check_opt(d->irisRotation, w, "irisRotation");
    check_opt(d->irisAspect, w, "irisAspect");
    check_opt(d->highlightThreshold, w, "highlightThreshold");
    check_opt(d->highlightSaturation, w, "highlightSaturation");
    check_opt(d->diffractionFringe, w, "diffractionFringe");
  }
}

TEST_CASE("3D parity: Material Options", "[scene][threed][parity]") {
  const Json fx = load();
  for (const Json& row : fx.at("materials").arr()) {
    const sc::Material m = sc::read_node_material(node_of("shape", row.at("props"), Json()));
    const Json& w = row.at("material");
    CHECK(m.castsShadows == w.at("castsShadows").b());
    CHECK(m.castsShadowsMode == w.at("castsShadowsMode").str());
    CHECK(m.acceptsShadowsMode == w.at("acceptsShadowsMode").str());
    CHECK(m.shadowOnly == w.at("shadowOnly").b());
    CHECK(m.acceptsLights == w.at("acceptsLights").b());
    CHECK(m.acceptsShadows == w.at("acceptsShadows").b());
    CHECK(m.shading == w.at("shading").str());
    for (const auto& [k, v] : std::initializer_list<std::pair<const char*, double>>{
             {"lightTransmission", m.lightTransmission}, {"ambient", m.ambient}, {"diffuse", m.diffuse}, {"metal", m.metal},
             {"specular", m.specular}, {"shininess", m.shininess}, {"roughness", m.roughness}, {"toonBands", m.toonBands},
             {"displacement", m.displacement}, {"displacementSubdivisions", m.displacementSubdivisions},
             {"reflectionIntensity", m.reflectionIntensity}, {"reflectionSharpness", m.reflectionSharpness},
             {"reflectionRolloff", m.reflectionRolloff}, {"transparency", m.transparency},
             {"transparencyRolloff", m.transparencyRolloff}, {"ior", m.ior}}) {
      INFO(k);
      CHECK(same(v, w.at(k).num()));
    }
  }
}

TEST_CASE("3D parity: light props and falloff", "[scene][threed][parity]") {
  const Json fx = load();
  for (const Json& row : fx.at("lights").arr()) {
    const sc::LightProps l = sc::read_node_light(node_of("light", row.at("props"), row.at("style")));
    const Json& w = row.at("light");
    CHECK(l.type == w.at("type").str());
    CHECK(l.color == w.at("color").str());
    CHECK(l.falloff == w.at("falloff").str());
    CHECK(l.shadows == w.at("shadows").b());
    CHECK(l.glow == w.at("glow").b());
    CHECK(l.shadowMap == w.at("shadowMap").b());
    CHECK(l.envPreset.str() == w.at("envPreset").str());
    for (const auto& [k, v] : std::initializer_list<std::pair<const char*, double>>{
             {"intensity", l.intensity}, {"radius", l.radius}, {"angle", l.angle}, {"cone", l.cone}, {"coneFeather", l.coneFeather},
             {"falloffDistance", l.falloffDistance}, {"shadowDarkness", l.shadowDarkness}, {"shadowDiffusion", l.shadowDiffusion},
             {"shadowMapSize", l.shadowMapSize}, {"shadowBias", l.shadowBias}, {"shadowSoftness", l.shadowSoftness},
             {"envRotation", l.envRotation}, {"envReflections", l.envReflections}}) {
      INFO(k);
      CHECK(same(v, w.at(k).num()));
    }
    REQUIRE(l.poi.has_value() == w.at("poi").is_object());
    if (l.poi) {
      CHECK(same((*l.poi)[0], w.at("poi").at("x").num()));
      CHECK(same((*l.poi)[1], w.at("poi").at("y").num()));
      CHECK(same((*l.poi)[2], w.at("poi").at("z").num()));
    }
  }
  const Json::Array& dist = fx.at("distances").arr();
  for (const Json& row : fx.at("falloff").arr()) {
    const Json& l = row.at("light");
    const std::optional<std::string> falloff = l.at("falloff").is_string() ? std::optional<std::string>(l.at("falloff").str()) : std::nullopt;
    const double radius = l.at("radius").num();
    const std::optional<double> fd = opt(l, "falloffDistance");
    for (std::size_t i = 0; i < dist.size(); ++i) {
      INFO("distance " << dist[i].num());
      CHECK(same(sc::light_falloff_at(dist[i].num(), falloff, radius, fd), row.at("falloffAt").arr()[i].num()));
      CHECK(same(sc::light_attenuation_at(dist[i].num(), falloff, radius, fd), row.at("attenuationAt").arr()[i].num()));
    }
    CHECK(same(sc::light_reach(falloff, radius, fd), row.at("reach").num()));
  }
}

TEST_CASE("3D parity: per-quad shading and shader lights", "[scene][threed][parity]") {
  const Json fx = load();
  const Json::Array& surfaces = fx.at("surfaces").arr();
  const Json::Array& responses = fx.at("responses").arr();
  for (const Json& row : fx.at("shading").arr()) {
    std::vector<sc::SceneLight> set;
    for (const Json& o : row.at("lights").arr()) set.push_back(scene_light_of(o));
    std::size_t k = 0;
    for (const Json& s : surfaces) {
      const std::array<double, 3> normal{s.at("normal").arr()[0].num(), s.at("normal").arr()[1].num(), s.at("normal").arr()[2].num()};
      const std::array<double, 3> pos{s.at("pos").at("x").num(), s.at("pos").at("y").num(), s.at("pos").at("z").num()};
      for (const Json& m : responses) {
        for (const bool oneSided : {false, true}) {
          const auto got = sc::shade_layer(normal, pos, set, m.is_object() ? opt(m, "ambient") : std::nullopt,
                                           m.is_object() ? opt(m, "diffuse") : std::nullopt, oneSided);
          const Json& want = row.at("shade").arr()[k++];
          REQUIRE(got.has_value() == want.is_array());
          if (!got) continue;
          for (std::size_t c = 0; c < 3; ++c) CHECK(same((*got)[c], want.arr()[c].num()));
        }
      }
    }
    const auto shader = sc::to_shader_lights(set);
    const Json::Array& want = row.at("shader").arr();
    REQUIRE(shader.size() == want.size());
    for (std::size_t i = 0; i < shader.size(); ++i) {
      const auto& g = shader[i];
      const Json& w = want[i];
      CHECK(premation::api::to_string(g.type) == w.at("type").str());
      CHECK(same(g.color[0], w.at("color").at("r").num()));
      CHECK(same(g.color[1], w.at("color").at("g").num()));
      CHECK(same(g.color[2], w.at("color").at("b").num()));
      for (const auto& [key, v] : std::initializer_list<std::pair<const char*, double>>{
               {"gain", g.gain}, {"x", g.x}, {"y", g.y}, {"z", g.z}, {"radius", g.radius}, {"aimX", g.aim_x}, {"aimY", g.aim_y},
               {"aimZ", g.aim_z}, {"halfConeRad", g.half_cone_rad}, {"coneFeatherRad", g.cone_feather_rad},
               {"falloffMode", g.falloff_mode}, {"falloffDistance", g.falloff_distance}}) {
        INFO(key);
        CHECK(same(v, w.at(key).num()));
      }
      CHECK(g.shadow_map.value_or(false) == (w.at("shadowMap").is_bool() && w.at("shadowMap").b()));
      check_opt(g.shadow_map_size, w, "shadowMapSize");
      check_opt(g.shadow_bias, w, "shadowBias");
      check_opt(g.shadow_softness, w, "shadowSoftness");
      check_opt(g.shadow_darkness, w, "shadowDarkness");
    }
    const Json::Array& aims = row.at("aims").arr();
    for (std::size_t i = 0; i < set.size(); ++i) {
      const auto a = sc::light_aim_3d(set[i]);
      REQUIRE(a.has_value() == aims[i].at("aim").is_array());
      if (!a) continue;
      for (std::size_t c = 0; c < 3; ++c) CHECK(same((*a)[c], aims[i].at("aim").arr()[c].num()));
      const auto deg = sc::aim_to_comp_angle_deg(*a);
      REQUIRE(deg.has_value() == aims[i].at("compDeg").is_number());
      if (deg) CHECK(same(*deg, aims[i].at("compDeg").num()));
    }
  }
}

TEST_CASE("3D parity: environment light rig", "[scene][threed][parity]") {
  const Json fx = load();
  for (const Json& row : fx.at("sh").arr()) {
    const auto sh = sc::preset_sh(row.at("id").str());
    INFO(row.at("id").str());
    for (std::size_t k = 0; k < 27; ++k) CHECK(same(static_cast<double>(sh[k]), row.at("sh").arr()[k].num()));
  }
  REQUIRE(fx.at("env").arr().size() >= 16);
  for (const Json& row : fx.at("env").arr()) {
    INFO(row.at("sky").str() << " " << row.at("intensity").num() << " " << row.at("rotation").num());
    const auto rig = sc::environment_rig_for(row.at("sky").str(), row.at("intensity").num(), row.at("rotation").num());
    REQUIRE(rig.has_value());
    const Json::Array& want = row.at("rig").arr();
    REQUIRE(rig->size() == want.size());
    for (std::size_t i = 0; i < want.size(); ++i) {
      CHECK((*rig)[i].ambient == (want[i].at("kind").str() == "ambient"));
      CHECK((*rig)[i].color == want[i].at("color").str());
      CHECK(same((*rig)[i].intensity, want[i].at("intensity").num()));
      if (!(*rig)[i].ambient) {
        CHECK(same((*rig)[i].from[0], want[i].at("from").at("x").num()));
        CHECK(same((*rig)[i].from[1], want[i].at("from").at("y").num()));
        CHECK(same((*rig)[i].from[2], want[i].at("from").at("z").num()));
      }
    }
  }
}