// Image-alpha puppet mesh parity (tests/data/alpha_mesh_parity.json, frozen
// from the TypeScript engine's alphaMeshCrossEngine.test.ts): the coverage mask
// of each image, the traced outline regions, buildAlphaOutlineGeometry, and the
// rest mesh buildRestMesh builds from the mask (grid + silhouette) — float for
// float. PARITY_REBLESS=1 writes the C++ answers instead (parity_rebless.hpp).
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <map>
#include <string>
#include <vector>

#include "alpha_mesh.hpp"
#include "extrude_mesh.hpp"
#include "json.hpp"
#include "native_effects.hpp"
#include "parity_rebless.hpp"
#include "rig_mesh.hpp"

namespace sc = premation::scene;
using premation::js::Json;
using premation::test::json_numbers;

namespace {

/// A ring as the TypeScript flattened it: `ring.flatMap((p) => [p.x, p.y])`.
Json flat_ring(const std::vector<sc::mesh::Pt2>& ring) {
  Json::Array a;
  a.reserve(ring.size() * 2);
  for (const sc::mesh::Pt2& p : ring) {
    a.push_back(Json::number(p.x));
    a.push_back(Json::number(p.y));
  }
  return Json::array(std::move(a));
}

/// `regions.map((r) => ({ outer, holes }))`.
Json regions_json(const std::vector<sc::rig::AlphaRegion>& regions) {
  Json::Array out;
  for (const sc::rig::AlphaRegion& r : regions) {
    Json o = Json::object();
    o.set("outer", flat_ring(r.outer));
    Json::Array holes;
    for (const auto& h : r.holes) holes.push_back(flat_ring(h));
    o.set("holes", Json::array(std::move(holes)));
    out.push_back(std::move(o));
  }
  return Json::array(std::move(out));
}

}  // namespace

TEST_CASE("alpha mesh parity: coverage, outline and rest mesh equal the editor's", "[scene][rig][alphamesh][parity]") {
  premation::test::JsonFixture fx("alpha_mesh_parity.json");
  REQUIRE(fx.ok());

  std::map<std::string, sc::rig::CoverageMask, std::less<>> masks;
  for (auto& m : fx.root().find_mut("masks")->obj_mut()) {
    INFO(m.key);
    const auto rgba = premation::doc::native_unbase64(m.value.at("rgba").str());
    REQUIRE(rgba.has_value());
    sc::rig::CoverageMask mask = sc::rig::coverage_mask_from_image_data(
        *rgba, static_cast<int>(m.value.at("w").num()), static_cast<int>(m.value.at("h").num()));
    CHECK(fx.answer(m.value, "cols", Json::number(static_cast<double>(mask.cols))));
    CHECK(fx.answer(m.value, "rows", Json::number(static_cast<double>(mask.rows))));
    CHECK(fx.answer(m.value, "cells", json_numbers(mask.cells)));
    CHECK(fx.answer(m.value, "key", Json::string(mask.key)));
    masks.emplace(m.key, std::move(mask));
  }

  for (Json& c : fx.root().find_mut("cases")->arr_mut()) {
    const std::string image = c.at("image").str();
    INFO(image);
    const sc::rig::CoverageMask& mask = masks.at(image);
    const double lw = c.at("lw").num();
    const double lh = c.at("lh").num();
    const double pad = c.at("pad").num();
    const Json rig = c.at("rig");
    const double density = rig.at("meshDensity").is_number() ? rig.at("meshDensity").num() : 22;
    const double expansion = rig.at("meshExpansion").is_number() ? rig.at("meshExpansion").num() : 0;

    const std::vector<sc::rig::AlphaRegion> regions = sc::rig::alpha_outline_regions(mask, lw, lh, expansion);
    CHECK(fx.answer(c, "regions", regions_json(regions)));

    const auto geom = sc::rig::build_alpha_outline_geometry(lw, lh, pad, density, expansion, mask);
    Json geom_json = Json::null();
    if (geom) {
      geom_json = Json::object();
      geom_json.set("vertices", json_numbers(geom->vertices));
      geom_json.set("triangles", json_numbers(geom->triangles));
      geom_json.set("numVertices", Json::number(static_cast<double>(geom->numVertices)));
    }
    CHECK(fx.answer(c, "geom", std::move(geom_json)));

    // buildRestMesh through the rig block's own resolution (puppet settings, the mask).
    Json props = Json::object();
    props.set("puppet", rig);
    sc::RigInputs in;
    in.fx = &props;
    in.width = lw;
    in.height = lh;
    in.pad = pad;
    in.coverage = &mask;
    const auto rest = sc::rest_mesh_for(in);
    REQUIRE(rest.has_value());
    // rest.layout is not exposed by rest_mesh_for: it stays as the fixture has it.
    Json* rest_json = c.find_mut("rest");
    REQUIRE(rest_json != nullptr);
    CHECK(fx.answer(*rest_json, "vertices", json_numbers(rest->vertices)));
    CHECK(fx.answer(*rest_json, "triangles", json_numbers(rest->triangles)));
  }
  REQUIRE(fx.finish());
}

namespace {

/// The area the triangles of a vertex list (x, y, u, v per vertex) cover.
double triangles_area(const std::vector<double>& v, const std::vector<double>& tris) {
  double a = 0;
  for (std::size_t t = 0; t + 2 < tris.size(); t += 3) {
    const auto at = [&](std::size_t k, std::size_t c) { return v[(static_cast<std::size_t>(tris[t + k]) * 4) + c]; };
    a += std::abs(((at(1, 0) - at(0, 0)) * (at(2, 1) - at(0, 1))) - ((at(2, 0) - at(0, 0)) * (at(1, 1) - at(0, 1)))) / 2;
  }
  return a;
}

}  // namespace

TEST_CASE("alpha mesh: the outline mesh covers every traced region — no part of the picture is left out", "[scene][rig][alphamesh]") {
  // The puppet bug: triangles bridging a narrow gap (an arm beside the body) were
  // rejected and nothing replaced them, so a straight-edged piece of the picture
  // went undrawn. The mesh must now cover its regions, or fall back to the grid.
  premation::test::JsonFixture fx("alpha_mesh_parity.json");
  REQUIRE(fx.ok());
  std::map<std::string, sc::rig::CoverageMask, std::less<>> masks;
  for (auto& m : fx.root().find_mut("masks")->obj_mut()) {
    const auto rgba = premation::doc::native_unbase64(m.value.at("rgba").str());
    REQUIRE(rgba.has_value());
    masks.emplace(m.key, sc::rig::coverage_mask_from_image_data(*rgba, static_cast<int>(m.value.at("w").num()),
                                                                static_cast<int>(m.value.at("h").num())));
  }
  for (Json& c : fx.root().find_mut("cases")->arr_mut()) {
    const std::string image = c.at("image").str();
    INFO(image);
    const double lw = c.at("lw").num();
    const double lh = c.at("lh").num();
    const Json rig = c.at("rig");
    const double density = rig.at("meshDensity").is_number() ? rig.at("meshDensity").num() : 22;
    const double expansion = rig.at("meshExpansion").is_number() ? rig.at("meshExpansion").num() : 0;
    const sc::rig::CoverageMask& mask = masks.at(image);
    double regionArea = 0;
    for (const sc::rig::AlphaRegion& r : sc::rig::alpha_outline_regions(mask, lw, lh, expansion)) {
      regionArea += std::abs(sc::mesh::signed_area(r.outer));
      for (const auto& h : r.holes) regionArea -= std::abs(sc::mesh::signed_area(h));
    }
    const auto geom = sc::rig::build_alpha_outline_geometry(lw, lh, c.at("pad").num(), density, expansion, mask);
    if (!geom || regionArea <= 0) continue;  // the grid fallback covers the box
    const std::vector<double> verts(geom->vertices.begin(), geom->vertices.end());
    const std::vector<double> tris(geom->triangles.begin(), geom->triangles.end());
    const double covered = triangles_area(verts, tris) / regionArea;
    // What the frozen TypeScript-era answer covered, for the record.
    const Json& old = c.at("geom");
    if (old.is_object()) {
      std::vector<double> ov;
      std::vector<double> ot;
      for (const Json& n : old.at("vertices").arr()) ov.push_back(n.num());
      for (const Json& n : old.at("triangles").arr()) ot.push_back(n.num());
      WARN(image << ": the mesh covers " << covered * 100 << "% of its region (the earlier mesh " << triangles_area(ov, ot) / regionArea * 100 << "%)");
    }
    CHECK(covered >= 0.97);
  }
}
