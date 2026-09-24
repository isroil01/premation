// Cross-engine extrusion parity (tests/data/extrude_parity.json, written by
// src/core/geometry/extrudeCrossEngine.test.ts): every recipe — rect, rounded
// rect, ellipse, Bézier runs with a hole, a traced bitmap — × extrusion options
// through the C++ port must give the editor's mesh: same counts, ranges and
// clamped bevel, and the same FNV-1a 64 over the exact vertex / index bytes.
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "extrude_mesh.hpp"
#include "json.hpp"

namespace m = premation::scene::mesh;
using premation::js::Json;

namespace {

std::string fnv1a64(const std::uint8_t* p, std::size_t n) {
  std::uint64_t h = 0xcbf29ce484222325ULL;
  for (std::size_t i = 0; i < n; ++i) {
    h ^= p[i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    h *= 0x100000001b3ULL;
  }
  std::array<char, 17> out{};
  std::snprintf(out.data(), out.size(), "%016llx", static_cast<unsigned long long>(h));  // NOLINT(cppcoreguidelines-pro-type-vararg)
  return std::string(out.data());
}

std::vector<m::Ring> rings_of(const Json& o) {
  const std::string kind = o.at("kind").str();
  if (kind == "rect") {
    const auto& r = o.at("radii").arr();
    return m::rect_outline(o.at("width").num(), o.at("height").num(), {r[0].num(), r[1].num(), r[2].num(), r[3].num()},
                           static_cast<int>(o.at("segmentsPer90").num()));
  }
  if (kind == "ellipse") {
    std::optional<int> seg;
    if (o.at("segments").is_number()) seg = static_cast<int>(o.at("segments").num());
    return m::ellipse_outline(o.at("width").num(), o.at("height").num(), seg);
  }
  if (kind == "runs") {
    std::vector<m::BezRun> runs;
    for (const Json& r : o.at("runs").arr()) {
      m::BezRun run;
      run.open = r.at("open").b();
      for (const Json& p : r.at("points").arr()) {
        const auto& a = p.arr();
        run.points.push_back({a[0].num(), a[1].num(), a[2].num(), a[3].num(), a[4].num(), a[5].num()});
      }
      runs.push_back(std::move(run));
    }
    return m::bezier_runs_to_rings(runs, o.at("tolerance").num());
  }
  // bitmap
  std::vector<std::uint8_t> alpha;
  for (const Json& v : o.at("alpha").arr()) alpha.push_back(static_cast<std::uint8_t>(v.num()));
  m::TraceOptions to;
  to.threshold = o.at("threshold").num();
  to.tolerance = o.at("tolerance").num();
  to.minArea = o.at("minArea").num();
  std::vector<m::Ring> rings;
  for (m::TracedContour& c : m::trace_bitmap(alpha, static_cast<int>(o.at("width").num()), static_cast<int>(o.at("height").num()), 1, to)) {
    rings.push_back({std::move(c.points), c.hole});
  }
  return rings;
}

m::ExtrudeOptions options_of(const Json& j) {
  m::ExtrudeOptions o;
  o.depth = j.at("depth").num();
  if (j.at("bevel").is_number()) o.bevel = j.at("bevel").num();
  if (j.at("bevelStyle").is_string()) {
    const std::string s = j.at("bevelStyle").str();
    o.bevelStyle = s == "concave" ? m::BevelProfile::concave : s == "convex" ? m::BevelProfile::convex : m::BevelProfile::angular;
  }
  if (j.at("bevelSegments").is_number()) o.bevelSegments = j.at("bevelSegments").num();
  if (j.at("smoothAngleDeg").is_number()) o.smoothAngleDeg = j.at("smoothAngleDeg").num();
  if (j.at("frontCap").is_bool()) o.frontCap = j.at("frontCap").b();
  if (j.at("frontBevel").is_bool()) o.frontBevel = j.at("frontBevel").b();
  if (j.at("holeBevelScale").is_number()) o.holeBevelScale = j.at("holeBevelScale").num();
  if (j.at("backCap").is_bool()) o.backCap = j.at("backCap").b();
  if (j.at("uvBox").is_object()) {
    const Json& b = j.at("uvBox");
    o.uvBox = m::Box{b.at("x").num(), b.at("y").num(), b.at("width").num(), b.at("height").num()};
  }
  return o;
}

const char* role_name(m::MeshRole r) {
  switch (r) {
    case m::MeshRole::back: return "back";
    case m::MeshRole::side: return "side";
    case m::MeshRole::bevel: return "bevel";
    default: return "front";
  }
}

}  // namespace

TEST_CASE("extrusion parity: the C++ port builds the editor's extruded meshes", "[scene][extrude][parity]") {
  std::ifstream f(std::string(PREMATION_ENGINE_TEST_DATA) + "/extrude_parity.json", std::ios::binary);
  REQUIRE(f.good());
  std::stringstream ss;
  ss << f.rdbuf();
  const auto fixture = premation::js::parse(ss.str());
  REQUIRE(fixture.has_value());
  const auto& rows = fixture->at("rows").arr();
  REQUIRE(rows.size() >= 9);
  for (const Json& row : rows) {
    INFO(row.at("name").str());
    const std::vector<m::Ring> rings = rings_of(row.at("outline"));
    const std::optional<m::ExtrudedMesh> mesh = m::extrude_outline(rings, options_of(row.at("opts")));
    const Json& want = row.at("mesh");
    REQUIRE(mesh.has_value() == want.is_object());
    if (!mesh) continue;
    CHECK(mesh->vertexCount == static_cast<std::uint32_t>(want.at("vertexCount").num()));
    CHECK(mesh->indices.size() == static_cast<std::size_t>(want.at("indexCount").num()));
    CHECK(mesh->index32 == want.at("index32").b());
    CHECK(mesh->bevel == want.at("bevel").num());
    const auto& wr = want.at("ranges").arr();
    REQUIRE(mesh->ranges.size() == wr.size());
    for (std::size_t i = 0; i < wr.size(); ++i) {
      CHECK(std::string(role_name(mesh->ranges[i].role)) == wr[i].at("role").str());
      CHECK(mesh->ranges[i].first == static_cast<std::uint32_t>(wr[i].at("first").num()));
      CHECK(mesh->ranges[i].count == static_cast<std::uint32_t>(wr[i].at("count").num()));
    }
    CHECK(fnv1a64(reinterpret_cast<const std::uint8_t*>(mesh->vertices.data()), mesh->vertices.size() * sizeof(float)) ==  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
          want.at("verticesFnv").str());
    std::vector<std::uint8_t> idx;
    if (mesh->index32) {
      idx.resize(mesh->indices.size() * 4);
      std::memcpy(idx.data(), mesh->indices.data(), idx.size());
    } else {
      idx.resize(mesh->indices.size() * 2);
      for (std::size_t i = 0; i < mesh->indices.size(); ++i) {
        const auto v = static_cast<std::uint16_t>(mesh->indices[i]);
        std::memcpy(idx.data() + i * 2, &v, 2);
      }
    }
    CHECK(fnv1a64(idx.data(), idx.size()) == want.at("indicesFnv").str());
  }
}
