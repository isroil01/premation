// Extrusion fallback geometry parity (tests/data/extrusion_faces_parity.json,
// frozen from the TypeScript engine's extrusionFacesCrossEngine.test.ts):
// extrusionGeometry's faces (order, suffix, role, size, every matrix element),
// the emitted bevel, faceKindOf, and clampBevel. PARITY_REBLESS=1 writes the
// C++ answers instead (parity_rebless.hpp).
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cmath>
#include <cstddef>
#include <string>
#include <utility>

#include "extrusion_faces.hpp"
#include "json.hpp"
#include "parity_rebless.hpp"

namespace ex = premation::scene::extrude;
using premation::js::Json;

TEST_CASE("extrusion faces parity: the fallback body equals the editor's", "[scene][extrusion][parity]") {
  premation::test::JsonFixture fx("extrusion_faces_parity.json");
  REQUIRE(fx.ok());
  for (Json& c : fx.root().find_mut("cases")->arr_mut()) {
    ex::Options o;
    const Json& jo = c.at("opts");
    if (jo.at("bevel").is_number()) o.bevel = jo.at("bevel").num();
    if (jo.at("cornerRadius").is_number()) o.cornerRadius = jo.at("cornerRadius").num();
    if (jo.at("wallSegments").is_number()) o.wallSegments = jo.at("wallSegments").num();
    const double segments = c.at("segments").is_number() ? c.at("segments").num() : ex::kEllipseWallSegments;
    const ex::Geometry g =
        ex::extrusion_geometry(c.at("w").num(), c.at("h").num(), c.at("d").num(), c.at("shape").str() == "ellipse", segments, o);
    CHECK(fx.answer(c, "bevel", Json::number(g.bevel)));
    Json::Array faces;
    for (const ex::Face& face : g.faces) {
      Json::Array m;
      for (std::size_t k = 0; k < 16; ++k) m.push_back(Json::number(static_cast<double>(face.m[k])));
      faces.push_back(Json::object(Json::Object{{"m", Json::array(std::move(m))},
                                                {"w", Json::number(face.w)},
                                                {"h", Json::number(face.h)},
                                                {"role", Json::string(face.back ? "back" : "wall")},
                                                {"suffix", Json::string(face.suffix)},
                                                {"kind", Json::string(std::string(ex::face_kind_of(face)))}}));
    }
    if (fx.reblessing()) {
      CHECK(fx.answer(c, "faces", Json::array(std::move(faces))));
    } else {
      auto& want = c.find_mut("faces")->arr_mut();
      REQUIRE(want.size() == faces.size());
      for (std::size_t i = 0; i < faces.size(); ++i) {
        INFO(g.faces[i].suffix);
        CHECK(fx.answer(want[i], std::move(faces[i])));
      }
    }
  }
  for (Json& b : fx.root().find_mut("bevels")->arr_mut()) {
    // JSON has no NaN: a NaN request travels as null.
    const double req = b.at("b").is_number() ? b.at("b").num() : std::nan("");
    CHECK(fx.answer(b, "out", Json::number(ex::clamp_bevel(b.at("w").num(), b.at("h").num(), b.at("d").num(), req))));
  }
  REQUIRE(fx.finish());
}

TEST_CASE("extrusion faces: per-corner radii survive the fallback", "[scene][extrusion]") {
  // Equal per-corner radii trace exactly the uniform outline.
  ex::Options uniform;
  uniform.cornerRadius = 12;
  ex::Options perCorner;
  perCorner.cornerRadii = std::array<double, 4>{12, 12, 12, 12};
  const ex::Geometry a = ex::extrusion_geometry(200, 100, 30, false, ex::kEllipseWallSegments, uniform);
  const ex::Geometry b = ex::extrusion_geometry(200, 100, 30, false, ex::kEllipseWallSegments, perCorner);
  REQUIRE(a.faces.size() == b.faces.size());
  for (std::size_t i = 0; i < a.faces.size(); ++i) CHECK(a.faces[i].m == b.faces[i].m);

  // Only the bottom-right corner rounded: one arc of walls, three sharp corners.
  ex::Options one;
  one.cornerRadii = std::array<double, 4>{0, 0, 20, 0};
  const ex::Geometry g = ex::extrusion_geometry(200, 100, 30, false, ex::kEllipseWallSegments, one);
  // back + 3 straight-corner points + (segments + 1) arc points → as many walls as outline edges.
  const std::size_t outline = 3 + (ex::kRoundedCornerSegments + 1);
  CHECK(g.faces.size() == 1 + outline);
  // TL and TR stay sharp: the top wall runs the full 200 px width.
  bool sharp = false;
  for (const ex::Face& f : g.faces) {
    if (!f.back && std::abs(f.w - 200) < 1e-6 && std::abs(f.m[13] + 50) < 1e-6) sharp = true;
  }
  CHECK(sharp);
}
