// Cross-engine height displacement parity (tests/data/height_displacement_parity.json,
// frozen from the TypeScript engine's heightDisplacementCrossEngine.test.ts):
// the C++ displace_mesh over the same mesh, field, amount and subdivision count
// must give displacedMeshFor's key, vertices and indices byte for byte.
// Primitive meshes are rebuilt from their `prim:` key (primitive_mesh.cpp); the
// others come from the fixture. Row 0 is the primitive-displaced-sphere golden.
// PARITY_REBLESS=1 writes the C++ answers instead (parity_rebless.hpp); the
// fields, meshes, amounts and subdivision counts are inputs and stay.
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "height_displacement.hpp"
#include "json.hpp"
#include "parity_rebless.hpp"
#include "primitive_mesh.hpp"

namespace sc = premation::scene;
using premation::js::Json;

namespace {

template <class T>
std::string fnv1a64(const std::vector<T>& v) {
  std::vector<std::uint8_t> bytes(v.size() * sizeof(T));
  std::memcpy(bytes.data(), v.data(), bytes.size());
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

TEST_CASE("height displacement parity: displaced meshes equal the editor's", "[scene][displacement][parity]") {
  premation::test::JsonFixture fx("height_displacement_parity.json");
  REQUIRE(fx.ok());

  std::map<std::string, sc::HeightField> fields;
  for (const Json::Member& m : fx.root().at("fields").obj()) {
    const std::string& name = m.key;
    const Json& jf = m.value;
    sc::HeightField hf;
    hf.width = static_cast<std::uint32_t>(jf.at("width").num());
    hf.height = static_cast<std::uint32_t>(jf.at("height").num());
    for (const Json& d : jf.at("data").arr()) hf.data.push_back(static_cast<float>(d.num()));
    REQUIRE(hf.data.size() == std::size_t{hf.width} * hf.height);
    fields.emplace(name, std::move(hf));
  }

  auto& rows = fx.root().find_mut("rows")->arr_mut();
  REQUIRE(rows.size() >= 9);
  std::size_t checked = 0;
  for (Json& row : rows) {
    const std::string mesh = row.at("mesh").str();
    INFO(mesh << " × " << row.at("field").str() << " amount " << row.at("amount").num() << " subdivisions "
              << row.at("subdivisions").num());
    std::vector<float> vertices;
    std::vector<std::uint32_t> indices;
    std::string meshKey;
    if (row.at("prim").b()) {
      const auto pm = sc::primitive_mesh_for_key(mesh);
      REQUIRE(pm.has_value());
      vertices = pm->vertices;
      indices = pm->indices;
      meshKey = pm->key;
    } else {
      for (const Json& v : row.at("vertices").arr()) vertices.push_back(static_cast<float>(v.num()));
      for (const Json& i : row.at("indices").arr()) indices.push_back(static_cast<std::uint32_t>(i.num()));
      meshKey = "mesh:" + mesh;
    }
    const std::string field = row.at("field").str();
    REQUIRE(fields.count(field) == 1);
    const double amount = row.at("amount").num();
    const double subs = row.at("subdivisions").num();
    const sc::DisplacedMesh d = sc::displace_mesh(vertices, indices, fields.at(field), amount, subs);
    CHECK(fx.answer(row, "key", Json::string(sc::displaced_mesh_key(meshKey, field, amount, subs))));
    CHECK(fx.answer(row, "vertexCount", Json::number(static_cast<double>(d.vertices.size() / 8))));
    CHECK(fx.answer(row, "indexCount", Json::number(static_cast<double>(d.indices.size()))));
    CHECK(fx.answer(row, "verticesFnv", Json::string(fnv1a64(d.vertices))));
    CHECK(fx.answer(row, "indicesFnv", Json::string(fnv1a64(d.indices))));
    CHECK(fx.answer(row, "triangleScale", Json::number(static_cast<double>(d.triangleScale))));
    ++checked;
  }
  CHECK(checked == rows.size());
  REQUIRE(fx.finish());
}

TEST_CASE("height displacement: sample_height clamps and interpolates like the TypeScript", "[scene][displacement]") {
  sc::HeightField f;
  f.width = 2;
  f.height = 2;
  f.data = {0, 1, 0.5F, 0.25F};
  CHECK(sc::sample_height(f, -1, -1) == 0);
  CHECK(sc::sample_height(f, 2, 0) == 1);
  CHECK(sc::sample_height(f, 1, 1) == 0.25);
  CHECK(sc::sample_height(f, 0.5, 0) == 0.5);
  // Zero amount displaces nothing (vertices are only re-normalised).
  const std::vector<float> v{0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, -1, 1, 0, 0, 1, 0, 0, 0, -1, 0, 1};
  const std::vector<std::uint32_t> idx{0, 1, 2};
  const sc::DisplacedMesh d = sc::displace_mesh(v, idx, f, 0, 0);
  CHECK(d.vertices == v);
  CHECK(d.triangleScale == 1);
}
