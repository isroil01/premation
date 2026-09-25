// D2w time/comp: the particle field (scene/particle_port.cpp) against
// particleRender.ts drawParticleField. The C++ paint on a recording Canvas2D must
// issue the TypeScript's Canvas2D program op for op — the closed-form and the
// frame-stepping emitters, trails, bursts, streaks, every shape and the plexus
// (tests/data/particle_parity.json, written by
// src/core/particles/particleFieldCrossEngine.test.ts).
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>

#include "json.hpp"
#include "particle_port.hpp"
#include "recording_canvas.hpp"

namespace sc = premation::scene;
namespace js = premation::js;
namespace raster = premation::raster;

TEST_CASE("particles: the C++ field issues particleRender.ts's Canvas2D program", "[scene][particles][parity]") {
  std::ifstream in(std::string(PREMATION_ENGINE_TEST_DATA) + "/particle_parity.json", std::ios::binary);
  REQUIRE(in.good());
  std::stringstream ss;
  ss << in.rdbuf();
  const auto fx = js::parse(ss.str());
  REQUIRE(fx.has_value());
  const js::Json::Array& cases = fx->at("cases").arr();
  REQUIRE(cases.size() >= 11);
  for (const js::Json& c : cases) {
    const std::string name = c.at("name").str();
    INFO(name);
    const auto w = static_cast<std::uint32_t>(c.at("pxW").num());
    const auto h = static_cast<std::uint32_t>(c.at("pxH").num());
    auto rec = std::make_shared<raster::test::Recording>();
    raster::test::RecordingCanvas oc(rec, w, h);
    sc::paint_particle_field(oc, c.at("spec"));
    const js::Json::Array& want = c.at("ops").arr();
    const auto& got = rec->ops;
    std::size_t first = std::min(want.size(), got.size());
    for (std::size_t i = 0; i < std::min(want.size(), got.size()); ++i) {
      if (want[i].str() != got[i]) {
        first = i;
        break;
      }
    }
    INFO("ops: got " << got.size() << " want " << want.size() << "; first difference at " << first);
    if (first < std::min(want.size(), got.size())) {
      INFO("want " << want[first].str() << "\n got " << got[first]);
      CHECK(false);
    }
    CHECK(got.size() == want.size());
  }
}
