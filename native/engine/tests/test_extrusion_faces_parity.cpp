// Extrusion fallback geometry parity (tests/data/extrusion_faces_parity.json,
// written by src/core/scene/extrusionFacesCrossEngine.test.ts):
// extrusionGeometry's faces (order, suffix, role, size, every matrix element),
// the emitted bevel, faceKindOf, and clampBevel.
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <fstream>
#include <sstream>
#include <string>

#include "extrusion_faces.hpp"
#include "json.hpp"

namespace ex = premation::scene::extrude;
using premation::js::Json;

TEST_CASE("extrusion faces parity: the fallback body equals the editor's", "[scene][extrusion][parity]") {
  std::ifstream f(std::string(PREMATION_ENGINE_TEST_DATA) + "/extrusion_faces_parity.json", std::ios::binary);
  if (!f.good()) {
    WARN("extrusion_faces_parity.json not generated yet (GEN_NATIVE_EXTFACES=1 npx jest extrusionFacesCrossEngine)");
    return;
  }
  std::stringstream ss;
  ss << f.rdbuf();
  const auto fixture = premation::js::parse(ss.str());
  REQUIRE(fixture.has_value());
  for (const Json& c : fixture->at("cases").arr()) {
    ex::Options o;
    const Json& jo = c.at("opts");
    if (jo.at("bevel").is_number()) o.bevel = jo.at("bevel").num();
    if (jo.at("cornerRadius").is_number()) o.cornerRadius = jo.at("cornerRadius").num();
    if (jo.at("wallSegments").is_number()) o.wallSegments = jo.at("wallSegments").num();
    const double segments = c.at("segments").is_number() ? c.at("segments").num() : ex::kEllipseWallSegments;
    const ex::Geometry g =
        ex::extrusion_geometry(c.at("w").num(), c.at("h").num(), c.at("d").num(), c.at("shape").str() == "ellipse", segments, o);
    CHECK(g.bevel == c.at("bevel").num());
    const auto& want = c.at("faces").arr();
    REQUIRE(g.faces.size() == want.size());
    for (std::size_t i = 0; i < want.size(); ++i) {
      const ex::Face& face = g.faces[i];
      INFO(face.suffix);
      CHECK(face.suffix == want[i].at("suffix").str());
      CHECK(face.back == (want[i].at("role").str() == "back"));
      CHECK(ex::face_kind_of(face) == want[i].at("kind").str());
      CHECK(face.w == want[i].at("w").num());
      CHECK(face.h == want[i].at("h").num());
      for (std::size_t k = 0; k < 16; ++k) CHECK(face.m[k] == want[i].at("m").arr()[k].num());
    }
  }
  for (const Json& b : fixture->at("bevels").arr()) {
    const double req = b.at("b").is_number() ? b.at("b").num() : std::nan("");
    CHECK(ex::clamp_bevel(b.at("w").num(), b.at("h").num(), b.at("d").num(), req) == b.at("out").num());
  }
}
