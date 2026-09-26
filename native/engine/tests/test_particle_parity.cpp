// D2w time/comp: the particle field (scene/particle_port.cpp) against
// particleRender.ts drawParticleField. The C++ paint on a recording Canvas2D must
// issue the TypeScript's Canvas2D program op for op — the closed-form and the
// frame-stepping emitters, trails, bursts, streaks, every shape and the plexus
// (tests/data/particle_parity.json, frozen from the TypeScript engine's
// particleFieldCrossEngine.test.ts; PARITY_REBLESS=1 writes the C++ answers
// instead (parity_rebless.hpp)).
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <memory>
#include <string>

#include "json.hpp"
#include "parity_rebless.hpp"
#include "particle_port.hpp"
#include "recording_canvas.hpp"

namespace sc = premation::scene;
namespace js = premation::js;
namespace raster = premation::raster;

TEST_CASE("particles: the C++ field issues particleRender.ts's Canvas2D program", "[scene][particles][parity]") {
  premation::test::JsonFixture fx("particle_parity.json");
  REQUIRE(fx.ok());
  js::Json::Array& cases = fx.root().find_mut("cases")->arr_mut();
  REQUIRE(cases.size() >= 11);
  for (js::Json& c : cases) {
    const std::string name = c.at("name").str();
    INFO(name);
    const auto w = static_cast<std::uint32_t>(c.at("pxW").num());
    const auto h = static_cast<std::uint32_t>(c.at("pxH").num());
    auto rec = std::make_shared<raster::test::Recording>();
    raster::test::RecordingCanvas oc(rec, w, h);
    sc::paint_particle_field(oc, c.at("spec"));
    const auto& got = rec->ops;
    js::Json::Array got_json;
    got_json.reserve(got.size());
    for (const auto& op : got) got_json.push_back(js::Json::string(op));
    if (fx.answer(c, "ops", js::Json::array(std::move(got_json)))) continue;
    const js::Json::Array& want = c.at("ops").arr();
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
  REQUIRE(fx.finish());
}
