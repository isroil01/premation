// Rigging program, stream C1 (rig_mesh.cpp, alpha_mesh.cpp):
//   R1  the value-keyed caches hand back bit-identical meshes (a hit == a miss);
//   R2  image coverage is cut from the alpha by traceAccuracy / alphaThreshold;
//   R3  a pin binds barycentrically: its point lands exactly where it is dragged,
//       and one pin's harmonic weight is 1 over its whole component;
//   R4  the IK/FK track blends the chain 0..1; preserveVolume (dual quaternion)
//       keeps a 50/50 vertex at its distance from the joint where linear
//       blending pinches it.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <bit>
#include <cmath>
#include <cstdint>
#include <map>
#include <memory>
#include <numbers>
#include <string>
#include <vector>

#include "alpha_mesh.hpp"
#include "json.hpp"
#include "rig_mesh.hpp"

using Catch::Approx;
using premation::js::Json;
namespace sc = premation::scene;

namespace {

/// A hand-made animation: scalar tracks and pin position tracks by path.
struct Tracks {
  std::map<std::string, double> scalars;
  std::map<std::string, std::array<double, 2>> points;

  [[nodiscard]] sc::RigSampler sampler() const {
    sc::RigSampler s;
    s.sample = [this](std::string_view path, double) -> std::optional<double> {
      const auto it = scalars.find(std::string(path));
      return it == scalars.end() ? std::nullopt : std::optional<double>(it->second);
    };
    s.sampleData = [this](std::string_view path, double) -> std::optional<Json> {
      const auto it = points.find(std::string(path));
      if (it == points.end()) return std::nullopt;
      Json p = Json::object();
      p.set("x", Json::number(it->second[0]));
      p.set("y", Json::number(it->second[1]));
      Json::Array a;
      a.push_back(std::move(p));
      return Json::array(std::move(a));
    };
    return s;
  }
};

Json fx_of(const char* puppet, const char* skeleton) {
  Json fx = Json::object();
  if (puppet != nullptr) fx.set("puppet", *premation::js::parse(puppet));
  if (skeleton != nullptr) fx.set("skeleton", *premation::js::parse(skeleton));
  return fx;
}

sc::RigInputs inputs(const Json& fx, double w, double h) {
  sc::RigInputs in;
  in.fx = &fx;
  in.width = w;
  in.height = h;
  return in;
}

bool bit_equal(const std::vector<float>& a, const std::vector<float>& b) {
  if (a.size() != b.size()) return false;
  for (std::size_t i = 0; i < a.size(); ++i) {
    if (std::bit_cast<std::uint32_t>(a[i]) != std::bit_cast<std::uint32_t>(b[i])) return false;
  }
  return true;
}

constexpr const char* kPuppet =
    R"({"pins":[{"id":"a","x":-60,"y":-20,"kind":"advanced"},{"id":"b","x":60,"y":20,"kind":"advanced","stiffness":2},)"
    R"({"id":"c","x":0,"y":-40,"kind":"bend","rotation":25},{"id":"d","x":-50,"y":40,"kind":"overlap","overlap":30}],)"
    R"("meshDensity":10,"solver":"arap"})";
constexpr const char* kSkeleton =
    R"({"bones":[{"id":"b1","parentId":null,"length":60,"x":-60,"y":0,"rotation":0},)"
    R"({"id":"b2","parentId":"b1","length":60,"x":60,"y":0,"rotation":0}],)"
    R"("ikTargets":[{"boneId":"b2","x":40,"y":30,"chainLength":2}]})";

}  // namespace

TEST_CASE("rig cache: a hit gives the bytes a miss gives", "[scene][rig][cache]") {
  const Json fx = fx_of(kPuppet, kSkeleton);
  Tracks tr;
  tr.points["puppet.b.position"] = {75, 35};
  tr.scalars["puppet.a.rotation"] = 12;
  const sc::RigSampler anim = tr.sampler();
  const sc::RigInputs in = inputs(fx, 200, 120);

  sc::rig_cache_clear();
  const sc::RigResult cold = sc::build_rig_mesh(in, anim);
  REQUIRE(cold.warnings.empty());
  REQUIRE(cold.mesh.has_value());
  const sc::RigCacheStats afterCold = sc::rig_cache_stats();
  CHECK(afterCold.entries >= 3);  // rest, driver rest, ARAP factor(s), bone binding
  CHECK(afterCold.misses >= 3);

  const sc::RigResult warm = sc::build_rig_mesh(in, anim);
  const sc::RigCacheStats afterWarm = sc::rig_cache_stats();
  CHECK(afterWarm.hits > afterCold.hits);
  CHECK(afterWarm.misses == afterCold.misses);
  CHECK(afterWarm.entries == afterCold.entries);
  REQUIRE(warm.mesh.has_value());
  CHECK(bit_equal(cold.mesh->vertices, warm.mesh->vertices));
  CHECK(cold.mesh->triangles == warm.mesh->triangles);
  REQUIRE(cold.mesh->depth.has_value());
  REQUIRE(warm.mesh->depth.has_value());
  CHECK(bit_equal(*cold.mesh->depth, *warm.mesh->depth));

  // The overlay model shares the caches: no new entries, the same vertices.
  std::vector<std::string> warnings;
  const auto model = sc::build_rig_model(in, anim, false, false, warnings);
  REQUIRE(model.has_value());
  CHECK(sc::rig_cache_stats().entries == afterCold.entries);
  CHECK(bit_equal(model->vertices(), cold.mesh->vertices));

  // Cleared, rebuilt from nothing: still the same bytes.
  sc::rig_cache_clear();
  const sc::RigResult again = sc::build_rig_mesh(in, anim);
  REQUIRE(again.mesh.has_value());
  CHECK(bit_equal(again.mesh->vertices, cold.mesh->vertices));
}

TEST_CASE("rig pins: a pin binds to its triangle and lands where it is dragged", "[scene][rig][pins]") {
  // Density 4 on 100 × 100: cells of 25 px; the pins sit inside cells, not on vertices.
  for (const char* solver : {"lbs", "arap"}) {
    const std::string puppet = std::string(R"({"pins":[{"id":"p","x":-10,"y":5},{"id":"q","x":30,"y":-30}],"meshDensity":4,"solver":")") + solver + "\"}";
    const Json fx = fx_of(puppet.c_str(), nullptr);
    Tracks tr;
    tr.points["puppet.p.position"] = {-10 + 7, 5 - 3};
    tr.points["puppet.q.position"] = {30, -30};
    std::vector<std::string> warnings;
    const auto model = sc::build_rig_model(inputs(fx, 100, 100), tr.sampler(), false, false, warnings);
    REQUIRE(model.has_value());
    INFO(solver);
    REQUIRE(model->pins().size() == 2);
    // The dragged point of the solved mesh maps back to the pin's rest point.
    const auto back = model->rest_from_deformed(-3, 2);
    REQUIRE(back.has_value());
    CHECK((*back)[0] == Approx(-10).margin(1e-3));
    CHECK((*back)[1] == Approx(5).margin(1e-3));
    const auto still = model->rest_from_deformed(30, -30);
    REQUIRE(still.has_value());
    CHECK((*still)[0] == Approx(30).margin(1e-3));
    CHECK((*still)[1] == Approx(-30).margin(1e-3));
  }
}

TEST_CASE("rig pins: one pin's harmonic weight is 1 everywhere — the mesh translates rigidly", "[scene][rig][pins]") {
  const Json fx = fx_of(R"({"pins":[{"id":"p","x":12,"y":-7}],"meshDensity":8,"solver":"lbs"})", nullptr);
  Tracks tr;
  tr.points["puppet.p.position"] = {12 + 5, -7 + 9};
  const sc::RigInputs in = inputs(fx, 160, 90);
  const auto rest = sc::rest_mesh_for(in);
  REQUIRE(rest.has_value());
  const sc::RigResult r = sc::build_rig_mesh(in, tr.sampler());
  REQUIRE(r.mesh.has_value());
  REQUIRE(r.mesh->vertices.size() == rest->vertices.size());
  for (std::size_t i = 0; i + 3 < rest->vertices.size(); i += 4) {
    CHECK(r.mesh->vertices[i] == Approx(rest->vertices[i] + 5).margin(1e-3));
    CHECK(r.mesh->vertices[i + 1] == Approx(rest->vertices[i + 1] + 9).margin(1e-3));
  }
}

namespace {

/// 200 × 100 RGBA: a solid bar on the left (x < 90) and a faint one (alpha 20) on the right (x ≥ 110).
std::vector<std::uint8_t> two_bars() {
  std::vector<std::uint8_t> rgba(200 * 100 * 4, 0);
  for (int y = 0; y < 100; ++y) {
    for (int x = 0; x < 200; ++x) {
      const std::size_t o = (static_cast<std::size_t>(y) * 200 + static_cast<std::size_t>(x)) * 4;
      if (x < 90) rgba[o + 3] = 255;
      else if (x >= 110) rgba[o + 3] = 20;
    }
  }
  return rgba;
}

bool cell_at(const sc::rig::CoverageMask& m, double u, double v) {
  const int c = std::min(m.cols - 1, static_cast<int>(u * m.cols));
  const int r = std::min(m.rows - 1, static_cast<int>(v * m.rows));
  return m.cells[static_cast<std::size_t>(r) * static_cast<std::size_t>(m.cols) + static_cast<std::size_t>(c)] != 0;
}

}  // namespace

TEST_CASE("rig coverage: traceAccuracy sizes the cells, alphaThreshold decides what counts", "[scene][rig][coverage]") {
  CHECK(sc::rig::coverage_cell_px(0) == Approx(16));
  CHECK(sc::rig::coverage_cell_px(100) == Approx(2));
  CHECK(sc::rig::coverage_cell_px(60) == Approx(4.59).margin(0.01));

  const std::vector<std::uint8_t> rgba = two_bars();
  const auto plane = sc::rig::alpha_plane_from_rgba(rgba, 200, 100);
  REQUIRE(plane);
  CHECK(plane->width == 200);
  CHECK(plane->height == 100);

  const sc::rig::CoverageMask base = sc::rig::coverage_mask_from_alpha(plane, sc::rig::CoverageSettings{});
  CHECK(base.cols == 44);  // 200 / 4.59
  CHECK(base.rows == 22);
  CHECK(base.source == plane);
  CHECK(cell_at(base, 0.2, 0.5));        // the solid bar
  CHECK_FALSE(cell_at(base, 0.5, 0.5));  // the 20 px gap stays a gap
  CHECK_FALSE(cell_at(base, 0.8, 0.5));  // alpha 20 < 32

  sc::rig::CoverageSettings faint;
  faint.alphaThreshold = 10;
  const sc::rig::CoverageMask low = sc::rig::coverage_mask_from_alpha(plane, faint);
  CHECK(cell_at(low, 0.8, 0.5));
  CHECK(low.key != base.key);

  sc::rig::CoverageSettings coarse;
  coarse.traceAccuracy = 0;
  const sc::rig::CoverageMask big = sc::rig::coverage_mask_from_alpha(plane, coarse);
  CHECK(big.cols == 13);  // 200 / 16
  CHECK(big.rows == 6);

  // Through the rig: the layer's own alphaThreshold re-cuts the mask it was handed.
  const Json dflt = fx_of(R"({"pins":[{"id":"p","x":-60,"y":0}],"meshDensity":20})", nullptr);
  const Json lowThr = fx_of(R"({"pins":[{"id":"p","x":-60,"y":0}],"meshDensity":20,"alphaThreshold":10})", nullptr);
  sc::RigInputs in = inputs(dflt, 200, 100);
  in.coverage = &base;
  const auto meshDefault = sc::rest_mesh_for(in);
  in.fx = &lowThr;
  const auto meshLow = sc::rest_mesh_for(in);
  REQUIRE(meshDefault.has_value());
  REQUIRE(meshLow.has_value());
  const auto maxX = [](const sc::RestMeshView& m) {
    float mx = -1e9F;
    for (std::size_t i = 0; i + 3 < m.vertices.size(); i += 4) mx = std::max(mx, m.vertices[i]);
    return mx;
  };
  CHECK(maxX(*meshDefault) < 10);   // the faint bar is not meshed (x ≥ 10 in layer space)
  CHECK(maxX(*meshLow) > 40);       // at threshold 10 it is
  CHECK(meshLow->vertices.size() > meshDefault->vertices.size());
}

TEST_CASE("rig IK: the ikMode track blends FK and IK 0..1", "[scene][rig][ik]") {
  const Json fx = fx_of(nullptr, kSkeleton);
  const auto posed = [&](double mode) {
    Tracks tr;
    tr.scalars["ikMode.b2"] = mode;
    std::vector<std::string> warnings;
    const auto model = sc::build_rig_model(inputs(fx, 200, 120), tr.sampler(), false, false, warnings);
    REQUIRE(model.has_value());
    REQUIRE(model->bones().size() == 2);
    REQUIRE(model->ik().size() == 1);
    return std::array<double, 3>{model->bones()[0].posedRotation, model->bones()[1].posedRotation, model->ik()[0].blend};
  };
  const auto full = posed(1);
  const auto none = posed(0);
  const auto half = posed(0.5);
  CHECK(full[2] == 1);
  CHECK(none[2] == 0);
  CHECK(half[2] == 0.5);
  CHECK(std::abs(full[0]) > 0.05);
  CHECK(none[0] == 0);
  CHECK(none[1] == 0);
  CHECK(half[0] == Approx(full[0] / 2).margin(1e-9));
  CHECK(half[1] == Approx(full[1] / 2).margin(1e-9));
}

TEST_CASE("rig skinning: preserveVolume keeps a joint vertex at its radius", "[scene][rig][skin]") {
  // 100 × 40 at density 2: vertex 7 is (0, 20), right above the joint of b1 → b2 at (0, 0);
  // painted half and half. b2 turns 90°: linear blending averages (0, 20) with (-20, 0).
  const auto skel = [](const char* preserve) {
    return std::string(R"({"bones":[{"id":"b1","parentId":null,"length":50,"x":-50,"y":0,"rotation":0},)"
                       R"({"id":"b2","parentId":"b1","length":50,"x":50,"y":0,"rotation":0}],"ikTargets":[],"meshDensity":2,)"
                       R"("weightPaint":{"vertexCount":9,"bones":{"b1":{"7":0.5},"b2":{"7":0.5}}},"preserveVolume":")") +
           preserve + "\"}";
  };
  const auto vertex7 = [&](const char* preserve) {
    const std::string s = skel(preserve);
    const Json fx = fx_of(nullptr, s.c_str());
    Tracks tr;
    tr.scalars["bone.b2.rotation"] = std::numbers::pi / 2;
    sc::RigInputs in = inputs(fx, 100, 40);
    const sc::RigResult r = sc::build_rig_mesh(in, tr.sampler());
    REQUIRE(r.warnings.empty());
    REQUIRE(r.mesh.has_value());
    REQUIRE(r.mesh->vertices.size() == 9 * 4);
    return std::array<double, 2>{r.mesh->vertices[7 * 4], r.mesh->vertices[7 * 4 + 1]};
  };
  const auto linear = vertex7("off");
  const auto dq = vertex7("on");
  CHECK(linear[0] == Approx(-10).margin(1e-3));
  CHECK(linear[1] == Approx(10).margin(1e-3));
  CHECK(std::hypot(linear[0], linear[1]) == Approx(std::sqrt(200.0)).margin(1e-3));
  CHECK(std::hypot(dq[0], dq[1]) == Approx(20).margin(1e-3));
  CHECK(dq[0] == Approx(-20 * std::sin(std::numbers::pi / 4)).margin(1e-3));
  CHECK(dq[1] == Approx(20 * std::cos(std::numbers::pi / 4)).margin(1e-3));
}
