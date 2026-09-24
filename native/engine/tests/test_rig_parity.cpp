// Cross-engine rig parity (tests/data/rig_parity.json, written by
// src/core/rig/rigCrossEngine.test.ts): for each rigged layer, the C++ engine
// opens the SAME .motion document the TypeScript captured and runs the rig
// block through snapshot_build's own entry point (build_rig_mesh_for), with
// the inputs buildSnapshot handed its rig block. Every vertex, index and depth
// value must equal the TypeScript's `layer.deformedMesh`, bit for bit.
#include <catch2/catch_test_macros.hpp>

#include <bit>
#include <cstdint>
#include <fstream>
#include <sstream>
#include <string>

#include "anim.hpp"
#include "docexpr.hpp"
#include "docio.hpp"
#include "json.hpp"
#include "model.hpp"
#include "rig_bridge.hpp"
#include "timeline.hpp"

using premation::js::Json;
namespace doc = premation::doc;
namespace sc = premation::scene;

namespace {

Json load_fixture() {
  std::ifstream f(std::string(PREMATION_ENGINE_TEST_DATA) + "/rig_parity.json", std::ios::binary);
  REQUIRE(f.good());
  std::stringstream ss;
  ss << f.rdbuf();
  auto j = premation::js::parse(ss.str());
  REQUIRE(j.has_value());
  return std::move(*j);
}

/// First differing index of two float32 lists given as the TS numbers (-1 = equal).
long first_float_mismatch(const std::vector<float>& got, const Json& want) {
  const auto& a = want.arr();
  if (a.size() != got.size()) return static_cast<long>(std::min(a.size(), got.size()));
  for (std::size_t i = 0; i < a.size(); ++i) {
    if (std::bit_cast<std::uint32_t>(static_cast<float>(a[i].num())) != std::bit_cast<std::uint32_t>(got[i])) return static_cast<long>(i);
  }
  return -1;
}

}  // namespace

TEST_CASE("rig parity: the C++ rig block reproduces buildSnapshot's deformed meshes", "[scene][rig][parity]") {
  const Json fixture = load_fixture();
  const auto& cases = fixture.at("cases").arr();
  REQUIRE(cases.size() >= 7);
  std::size_t samples = 0;
  for (const Json& c : cases) {
    const std::string name = c.at("name").str();
    const std::string node = c.at("node").str();
    INFO(name);
    doc::Document d;
    doc::EditorView view;
    (void)doc::restore_document(d, view, c.at("document"), {});
    const doc::Node* n = d.node(node);
    REQUIRE(n != nullptr);
    doc::ExprCache cache;
    const doc::DocExprEnv env(d, view, cache);
    for (const Json& s : c.at("samples").arr()) {
      INFO("t = " << s.at("t").num());
      sc::RigInputs in;
      in.fx = &n->fx();
      in.width = s.at("width").num();
      in.height = s.at("height").num();
      in.pad = s.at("pad").num();
      in.pathPoints = s.at("pathPoints").is_array() ? &s.at("pathPoints") : nullptr;
      in.pathOpen = s.at("pathOpen").b();
      in.rigT = s.at("rigT").num();
      const sc::RigResult r = sc::build_rig_mesh_for(d, env, cache, node, in);
      INFO("unported: " << (r.unported.empty() ? std::string("-") : r.unported.front()));
      REQUIRE(r.unported.empty());
      REQUIRE(r.mesh.has_value());
      CHECK(first_float_mismatch(r.mesh->vertices, s.at("vertices")) == -1);
      const auto& tri = s.at("triangles").arr();
      REQUIRE(tri.size() == r.mesh->triangles.size());
      bool trisEqual = true;
      for (std::size_t i = 0; i < tri.size(); ++i) trisEqual = trisEqual && static_cast<std::uint16_t>(tri[i].num()) == r.mesh->triangles[i];
      CHECK(trisEqual);
      CHECK(s.at("depth").is_array() == r.mesh->depth.has_value());
      if (r.mesh->depth && s.at("depth").is_array()) CHECK(first_float_mismatch(*r.mesh->depth, s.at("depth")) == -1);
      ++samples;
    }
  }
  CHECK(samples >= 13);
}
