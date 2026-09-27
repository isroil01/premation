// Cross-engine primitive parity (tests/data/primitive_parity.json, frozen from
// the TypeScript engine's primitiveCrossEngine.test.ts): every `prim:…` key
// rebuilt by the C++ port from the key alone must give the editor's mesh byte
// for byte — the interleaved vertex bytes and the index bytes hash to the same
// FNV-1a 64, with the same counts, index width and draw-range role.
// PARITY_REBLESS=1 writes the C++ answers instead (parity_rebless.hpp).
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "json.hpp"
#include "parity_rebless.hpp"
#include "primitive_mesh.hpp"

namespace sc = premation::scene;
using premation::js::Json;

namespace {

std::string fnv1a64(const std::vector<std::uint8_t>& bytes) {
  std::uint64_t h = 0xcbf29ce484222325ULL;
  for (const std::uint8_t b : bytes) {
    h ^= b;
    h *= 0x100000001b3ULL;
  }
  std::array<char, 17> out{};
  std::snprintf(out.data(), out.size(), "%016llx", static_cast<unsigned long long>(h));  // NOLINT(cppcoreguidelines-pro-type-vararg)
  return std::string(out.data());
}

}  // namespace

TEST_CASE("primitive parity: meshes rebuilt from their keys equal the editor's", "[scene][primitive][parity]") {
  premation::test::JsonFixture fx("primitive_parity.json");
  REQUIRE(fx.ok());
  auto& rows = fx.root().find_mut("rows")->arr_mut();
  REQUIRE(rows.size() >= 14);
  for (Json& row : rows) {
    const std::string key = row.at("key").str();
    INFO(key);
    const std::optional<sc::PrimitiveMesh> m = sc::primitive_mesh_for_key(key);
    REQUIRE(m.has_value());
    premation::api::RenderExtrudedMesh api;
    sc::primitive_mesh_to_api(*m, api);
    CHECK(api.key == key);
    CHECK(fx.answer(row, "vertexCount", Json::number(static_cast<double>(m->vertices.size() / 8))));
    CHECK(fx.answer(row, "indexCount", Json::number(static_cast<double>(m->indices.size()))));
    CHECK(fx.answer(row, "verticesFnv", Json::string(fnv1a64(api.vertices))));
    CHECK(fx.answer(row, "indicesFnv", Json::string(fnv1a64(api.indices))));
    CHECK(fx.answer(row, "index32", Json::boolean(api.index_format == premation::api::RenderIndexFormat::uint32)));
    REQUIRE(api.ranges.size() == 1);
    CHECK(fx.answer(row, "role", Json::string(std::string(premation::api::to_string(api.ranges[0].role)))));
    CHECK(api.ranges[0].count == m->indices.size());
  }
  REQUIRE(fx.finish());
  CHECK_FALSE(sc::primitive_mesh_for_key("prim:dodecahedron:1:2").has_value());
  CHECK_FALSE(sc::primitive_mesh_for_key("prim:sphere:x:32:16").has_value());
  CHECK_FALSE(sc::primitive_mesh_for_key("extrude:rect:1").has_value());
}
