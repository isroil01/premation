// Cross-engine rig parity (tests/data/rig_parity.json, frozen from the
// TypeScript engine's rigCrossEngine.test.ts): for each rigged layer, the C++
// engine opens the SAME .motion document the TypeScript captured and runs the
// rig block through snapshot_build's own entry point (build_rig_mesh_for), with
// the inputs buildSnapshot handed its rig block. Every vertex, index and depth
// value must equal the TypeScript's `layer.deformedMesh`, bit for bit.
// PARITY_REBLESS=1 writes the C++ answers instead (parity_rebless.hpp).
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <bit>
#include <cstdint>
#include <string>
#include <vector>

#include "anim.hpp"
#include "docexpr.hpp"
#include "docio.hpp"
#include "json.hpp"
#include "model.hpp"
#include "parity_rebless.hpp"
#include "rig_bridge.hpp"
#include "timeline.hpp"

using premation::js::Json;
using premation::test::json_numbers;
namespace doc = premation::doc;
namespace sc = premation::scene;

namespace {

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
  premation::test::JsonFixture fx("rig_parity.json");
  REQUIRE(fx.ok());
  auto& cases = fx.root().find_mut("cases")->arr_mut();
  REQUIRE(cases.size() >= 7);
  std::size_t samples = 0;
  for (Json& c : cases) {
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
    for (Json& s : c.find_mut("samples")->arr_mut()) {
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
      {
        INFO("first vertex mismatch: " << first_float_mismatch(r.mesh->vertices, s.at("vertices")));
        CHECK(fx.answer(s, "vertices", json_numbers(r.mesh->vertices)));
      }
      CHECK(fx.answer(s, "triangles", json_numbers(r.mesh->triangles)));
      // `depth` is present only when the mesh has one (`...(m.depth ? { depth } : {})`).
      if (r.mesh->depth) {
        INFO("first depth mismatch: " << first_float_mismatch(*r.mesh->depth, s.at("depth")));
        CHECK(fx.answer(s, "depth", json_numbers(*r.mesh->depth)));
      } else if (fx.reblessing()) {
        s.erase("depth");
      } else {
        CHECK_FALSE(s.has("depth"));
      }
      ++samples;
    }
  }
  CHECK(samples >= 13);
  REQUIRE(fx.finish());
}
