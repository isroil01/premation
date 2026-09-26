// Corner Pin parity (tests/data/corner_pin_parity.json, frozen from the
// TypeScript engine's cornerPinCrossEngine.test.ts): readNodeCornerPin's
// verdict on every stored pin, and for the usable ones squareToQuad, the
// projective render model and the pinned bounds of resolveCornerPin — float for
// float. PARITY_REBLESS=1 writes the C++ answers instead (parity_rebless.hpp).
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <string>

#include "corner_pin.hpp"
#include "json.hpp"
#include "model.hpp"
#include "parity_rebless.hpp"

namespace sc = premation::scene;
namespace doc = premation::doc;
using premation::js::Json;
using premation::test::json_numbers;

TEST_CASE("corner pin parity: read, homography, render model and bounds equal the editor's", "[scene][cornerpin][parity]") {
  premation::test::JsonFixture fx("corner_pin_parity.json");
  REQUIRE(fx.ok());
  std::size_t usable = 0;
  for (Json& row : fx.root().find_mut("rows")->arr_mut()) {
    doc::Node n;
    n.id = "n";
    doc::Component comp;
    comp.id = "n_fx";
    comp.type = "fx";
    comp.props.set("cornerPin", row.at("pin"));
    n.components.push_back(comp);
    const auto pin = sc::read_node_corner_pin(n);
    CHECK(fx.answer(row, "read", pin ? json_numbers(*pin) : Json::null()));
    if (!pin) continue;
    const auto h = sc::square_to_quad(*pin);
    REQUIRE(h.has_value());
    CHECK(fx.answer(row, "homography", json_numbers(h->m)));
    for (Json& res : row.find_mut("resolved")->arr_mut()) {
      sc::Mat3 model;
      for (std::size_t i = 0; i < 9; ++i) model.m.at(i) = static_cast<float>(res.at("model").arr()[i].num());
      const auto r = sc::resolve_corner_pin(pin, model);
      REQUIRE(r.has_value());
      CHECK(fx.answer(res, "renderModel", json_numbers(r->renderModel.m)));
      CHECK(fx.answer(res, "bounds", json_numbers(std::array{r->bounds.x, r->bounds.y, r->bounds.width, r->bounds.height})));
      // The frame hook folds the same into a renderable (and marks it pinned).
      premation::api::Renderable rr;
      rr.model_matrix.assign(model.m.begin(), model.m.end());
      premation::api::RenderMotionSample ms;
      ms.model_matrix.assign(model.m.begin(), model.m.end());
      rr.motion_samples.push_back(ms);
      sc::apply_corner_pin(pin, model, rr);
      for (std::size_t i = 0; i < 9; ++i) {
        CHECK(rr.model_matrix.at(i) == static_cast<double>(r->renderModel.m.at(i)));
        CHECK(rr.motion_samples[0].model_matrix.at(i) == static_cast<double>(r->renderModel.m.at(i)));
      }
      CHECK(rr.corner_pin.size() == 8);
    }
    ++usable;
  }
  CHECK(usable >= 4);
  REQUIRE(fx.finish());
}
