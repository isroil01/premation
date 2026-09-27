// Rigid-body physics parity (tests/data/rigid_body_parity.json, frozen from the
// TypeScript engine's src/core/simulation/rigidBodyCrossEngine.test.ts): the
// solver, the seek cache and physicsPosesAt — every pose at every frame (asked
// in a hostile order) equal to the TypeScript's, bit for bit.
#include <catch2/catch_test_macros.hpp>

#include <map>
#include <string>
#include <vector>

#include "json.hpp"
#include "parity_rebless.hpp"
#include "rigid_body.hpp"

namespace ph = premation::scene::physics;
using premation::js::Json;

TEST_CASE("rigid-body physics parity: the poses equal the editor's", "[scene][physics][parity]") {
  premation::test::JsonFixture fx("rigid_body_parity.json");
  REQUIRE(fx.ok());
  std::size_t compared = 0;
  bool spun = false;
  for (const Json& row : fx.root().at("rows").arr()) {
    INFO(row.at("name").str());
    const Json& w = row.at("world");
    ph::World world;
    world.gravityX = w.at("gravityX").num();
    world.gravityY = w.at("gravityY").num();
    world.iterations = w.at("iterations").num();
    if (w.at("bounds").is_object()) {
      const Json& b = w.at("bounds");
      world.bounds = ph::Bounds{b.at("left").num(), b.at("top").num(), b.at("right").num(), b.at("bottom").num()};
    }
    std::vector<ph::BodySeed> seeds;
    for (const Json& s : row.at("seeds").arr()) {
      ph::BodySeed seed;
      seed.id = s.at("id").str();
      seed.x = s.at("x").num();
      seed.y = s.at("y").num();
      seed.rotation = s.at("rotation").num();
      seed.width = s.at("width").num();
      seed.height = s.at("height").num();
      const auto cfg = ph::read_physics(s.at("cfg"));
      REQUIRE(cfg.has_value());
      seed.cfg = *cfg;
      seeds.push_back(std::move(seed));
    }
    for (const Json& f : row.at("frames").arr()) {
      const double frame = f.at("frame").num();
      INFO("frame " << frame);
      const std::map<std::string, ph::Pose> got = ph::poses_at(seeds, world, row.at("fps").num(), frame);
      const auto& want = f.at("poses").arr();
      REQUIRE(got.size() == want.size());
      for (const Json& p : want) {
        const std::string id = p.at("id").str();
        INFO(id);
        const auto it = got.find(id);
        REQUIRE(it != got.end());
        CHECK(it->second.x == p.at("x").num());
        CHECK(it->second.y == p.at("y").num());
        CHECK(it->second.rotation.has_value() == p.at("rotation").is_number());
        if (it->second.rotation && p.at("rotation").is_number()) {
          CHECK(*it->second.rotation == p.at("rotation").num());
          spun = spun || *it->second.rotation != 0;
        }
        ++compared;
      }
    }
  }
  CHECK(compared > 50);
  CHECK(spun);
}
