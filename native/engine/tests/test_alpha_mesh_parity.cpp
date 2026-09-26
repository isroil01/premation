// Image-alpha puppet mesh parity (tests/data/alpha_mesh_parity.json, frozen
// from the TypeScript engine's alphaMeshCrossEngine.test.ts): the coverage mask
// of each image, the traced outline regions, buildAlphaOutlineGeometry, and the
// rest mesh buildRestMesh builds from the mask (grid + silhouette) — float for
// float. PARITY_REBLESS=1 writes the C++ answers instead (parity_rebless.hpp).
#include <catch2/catch_test_macros.hpp>

#include <map>
#include <string>
#include <vector>

#include "alpha_mesh.hpp"
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
