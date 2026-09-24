// Cross-engine primitive parity (tests/data/primitive_parity.json, written by
// src/core/scene/primitiveCrossEngine.test.ts): every `prim:…` key rebuilt by
// the C++ port from the key alone must give the editor's mesh byte for byte —
// the interleaved vertex bytes and the index bytes hash to the same FNV-1a 64,
// with the same counts, index width and draw-range role.
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "json.hpp"
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
  std::ifstream f(std::string(PREMATION_ENGINE_TEST_DATA) + "/primitive_parity.json", std::ios::binary);
  REQUIRE(f.good());
  std::stringstream ss;
  ss << f.rdbuf();
  const auto fixture = premation::js::parse(ss.str());
  REQUIRE(fixture.has_value());
  const auto& rows = fixture->at("rows").arr();
  REQUIRE(rows.size() >= 14);
  for (const Json& row : rows) {
    const std::string key = row.at("key").str();
    INFO(key);
    const std::optional<sc::PrimitiveMesh> m = sc::primitive_mesh_for_key(key);
    REQUIRE(m.has_value());
    premation::api::RenderExtrudedMesh api;
    sc::primitive_mesh_to_api(*m, api);
    CHECK(api.key == key);
    CHECK(m->vertices.size() / 8 == static_cast<std::size_t>(row.at("vertexCount").num()));
    CHECK(m->indices.size() == static_cast<std::size_t>(row.at("indexCount").num()));
    CHECK((api.index_format == premation::api::RenderIndexFormat::uint32) == row.at("index32").b());
    REQUIRE(api.ranges.size() == 1);
    CHECK(premation::api::to_string(api.ranges[0].role) == row.at("role").str());
    CHECK(api.ranges[0].count == m->indices.size());
    CHECK(fnv1a64(api.vertices) == row.at("verticesFnv").str());
    CHECK(fnv1a64(api.indices) == row.at("indicesFnv").str());
  }
  CHECK_FALSE(sc::primitive_mesh_for_key("prim:dodecahedron:1:2").has_value());
  CHECK_FALSE(sc::primitive_mesh_for_key("prim:sphere:x:32:16").has_value());
  CHECK_FALSE(sc::primitive_mesh_for_key("extrude:rect:1").has_value());
}
