// Image-alpha puppet mesh parity (tests/data/alpha_mesh_parity.json, written by
// src/core/rig/alphaMeshCrossEngine.test.ts): the coverage mask of each image,
// the traced outline regions, buildAlphaOutlineGeometry, and the rest mesh
// buildRestMesh builds from the mask (grid + silhouette) — float for float.
#include <catch2/catch_test_macros.hpp>

#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

#include "alpha_mesh.hpp"
#include "json.hpp"
#include "native_effects.hpp"
#include "rig_mesh.hpp"

namespace sc = premation::scene;
using premation::js::Json;

namespace {

template <typename T>
void check_numbers(const Json& want, const std::vector<T>& got) {
  REQUIRE(want.arr().size() == got.size());
  for (std::size_t i = 0; i < got.size(); ++i) CHECK(static_cast<double>(got[i]) == want.arr()[i].num());
}

void check_ring(const Json& want, const std::vector<sc::mesh::Pt2>& got) {
  REQUIRE(want.arr().size() == got.size() * 2);
  for (std::size_t i = 0; i < got.size(); ++i) {
    CHECK(got[i].x == want.arr()[i * 2].num());
    CHECK(got[i].y == want.arr()[(i * 2) + 1].num());
  }
}

}  // namespace

TEST_CASE("alpha mesh parity: coverage, outline and rest mesh equal the editor's", "[scene][rig][alphamesh][parity]") {
  std::ifstream f(std::string(PREMATION_ENGINE_TEST_DATA) + "/alpha_mesh_parity.json", std::ios::binary);
  if (!f.good()) {
    WARN("alpha_mesh_parity.json not generated yet (GEN_NATIVE_ALPHAMESH=1 npx jest alphaMeshCrossEngine)");
    return;
  }
  std::stringstream ss;
  ss << f.rdbuf();
  const auto fixture = premation::js::parse(ss.str());
  REQUIRE(fixture.has_value());

  std::map<std::string, sc::rig::CoverageMask, std::less<>> masks;
  for (const auto& m : fixture->at("masks").obj()) {
    INFO(m.key);
    const auto rgba = premation::doc::native_unbase64(m.value.at("rgba").str());
    REQUIRE(rgba.has_value());
    sc::rig::CoverageMask mask = sc::rig::coverage_mask_from_image_data(
        *rgba, static_cast<int>(m.value.at("w").num()), static_cast<int>(m.value.at("h").num()));
    CHECK(mask.cols == static_cast<int>(m.value.at("cols").num()));
    CHECK(mask.rows == static_cast<int>(m.value.at("rows").num()));
    CHECK(mask.key == m.value.at("key").str());
    check_numbers(m.value.at("cells"), mask.cells);
    masks.emplace(m.key, std::move(mask));
  }

  for (const Json& c : fixture->at("cases").arr()) {
    const std::string image = c.at("image").str();
    INFO(image);
    const sc::rig::CoverageMask& mask = masks.at(image);
    const double lw = c.at("lw").num();
    const double lh = c.at("lh").num();
    const double pad = c.at("pad").num();
    const Json& rig = c.at("rig");
    const double density = rig.at("meshDensity").is_number() ? rig.at("meshDensity").num() : 22;
    const double expansion = rig.at("meshExpansion").is_number() ? rig.at("meshExpansion").num() : 0;

    const std::vector<sc::rig::AlphaRegion> regions = sc::rig::alpha_outline_regions(mask, lw, lh, expansion);
    REQUIRE(regions.size() == c.at("regions").arr().size());
    for (std::size_t i = 0; i < regions.size(); ++i) {
      const Json& wr = c.at("regions").arr()[i];
      check_ring(wr.at("outer"), regions[i].outer);
      REQUIRE(regions[i].holes.size() == wr.at("holes").arr().size());
      for (std::size_t k = 0; k < regions[i].holes.size(); ++k) check_ring(wr.at("holes").arr()[k], regions[i].holes[k]);
    }

    const auto geom = sc::rig::build_alpha_outline_geometry(lw, lh, pad, density, expansion, mask);
    REQUIRE(geom.has_value() == c.at("geom").is_object());
    if (geom) {
      CHECK(static_cast<double>(geom->numVertices) == c.at("geom").at("numVertices").num());
      check_numbers(c.at("geom").at("vertices"), geom->vertices);
      check_numbers(c.at("geom").at("triangles"), geom->triangles);
    }

    // buildRestMesh through the rig block's own resolution (puppet settings, the mask).
    Json fx = Json::object();
    fx.set("puppet", rig);
    sc::RigInputs in;
    in.fx = &fx;
    in.width = lw;
    in.height = lh;
    in.pad = pad;
    in.coverage = &mask;
    const auto rest = sc::rest_mesh_for(in);
    REQUIRE(rest.has_value());
    check_numbers(c.at("rest").at("vertices"), rest->vertices);
    check_numbers(c.at("rest").at("triangles"), rest->triangles);
  }
}
