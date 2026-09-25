// Corner Pin parity (tests/data/corner_pin_parity.json, written by
// src/core/scene/cornerPinCrossEngine.test.ts): readNodeCornerPin's verdict on
// every stored pin, and for the usable ones squareToQuad, the projective render
// model and the pinned bounds of resolveCornerPin — float for float.
#include <catch2/catch_test_macros.hpp>

#include <fstream>
#include <sstream>
#include <string>

#include "corner_pin.hpp"
#include "json.hpp"
#include "model.hpp"

namespace sc = premation::scene;
namespace doc = premation::doc;
using premation::js::Json;

TEST_CASE("corner pin parity: read, homography, render model and bounds equal the editor's", "[scene][cornerpin][parity]") {
  std::ifstream f(std::string(PREMATION_ENGINE_TEST_DATA) + "/corner_pin_parity.json", std::ios::binary);
  REQUIRE(f.good());
  std::stringstream ss;
  ss << f.rdbuf();
  const auto fixture = premation::js::parse(ss.str());
  REQUIRE(fixture.has_value());
  std::size_t usable = 0;
  for (const Json& row : fixture->at("rows").arr()) {
    doc::Node n;
    n.id = "n";
    doc::Component fx;
    fx.id = "n_fx";
    fx.type = "fx";
    fx.props.set("cornerPin", row.at("pin"));
    n.components.push_back(fx);
    const auto pin = sc::read_node_corner_pin(n);
    if (row.at("read").is_null()) {
      CHECK_FALSE(pin.has_value());
      continue;
    }
    REQUIRE(pin.has_value());
    for (std::size_t i = 0; i < 8; ++i) CHECK(pin->at(i) == row.at("read").arr()[i].num());
    const auto h = sc::square_to_quad(*pin);
    REQUIRE(h.has_value());
    for (std::size_t i = 0; i < 9; ++i) CHECK(static_cast<double>(h->m.at(i)) == row.at("homography").arr()[i].num());
    for (const Json& res : row.at("resolved").arr()) {
      sc::Mat3 model;
      for (std::size_t i = 0; i < 9; ++i) model.m.at(i) = static_cast<float>(res.at("model").arr()[i].num());
      const auto r = sc::resolve_corner_pin(pin, model);
      REQUIRE(r.has_value());
      for (std::size_t i = 0; i < 9; ++i) CHECK(static_cast<double>(r->renderModel.m.at(i)) == res.at("renderModel").arr()[i].num());
      CHECK(r->bounds.x == res.at("bounds").arr()[0].num());
      CHECK(r->bounds.y == res.at("bounds").arr()[1].num());
      CHECK(r->bounds.width == res.at("bounds").arr()[2].num());
      CHECK(r->bounds.height == res.at("bounds").arr()[3].num());
      // The frame hook folds the same into a renderable (and marks it pinned).
      premation::api::Renderable rr;
      rr.model_matrix.assign(model.m.begin(), model.m.end());
      premation::api::RenderMotionSample ms;
      ms.model_matrix.assign(model.m.begin(), model.m.end());
      rr.motion_samples.push_back(ms);
      sc::apply_corner_pin(pin, model, rr);
      for (std::size_t i = 0; i < 9; ++i) {
        CHECK(rr.model_matrix.at(i) == res.at("renderModel").arr()[i].num());
        CHECK(rr.motion_samples[0].model_matrix.at(i) == res.at("renderModel").arr()[i].num());
      }
      CHECK(rr.corner_pin.size() == 8);
    }
    ++usable;
  }
  CHECK(usable >= 4);
}
