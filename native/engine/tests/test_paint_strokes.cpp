// B3 paint-stroke commands (handlers_strokes.cpp) — the same contracts as
// src/core/engine/__tests__/paintStrokes.test.ts: what each command does, its
// typed refusals (nothing changes), and exact undo.

#include <catch2/catch_test_macros.hpp>

#include <string>
#include <vector>

#include "core/anim.hpp"
#include "core/fxstate.hpp"
#include "invariants.hpp"
#include "session_harness.hpp"

using namespace premation;
using namespace premation::test;

namespace {

constexpr api::Time kSec = 705'600'000;
const std::string kPts = R"([{"x":0,"y":0},{"x":10,"y":0}])";

struct Paint {
  Harness h;
  api::LayerId layer;

  Paint() {
    (void)h.hello();
    api::CreateComposition c;
    c.settings.name = "Paint";
    c.settings.width = 640;
    c.settings.height = 360;
    c.settings.frame_rate = api::Rational{30, 1};
    c.settings.duration = 10 * kSec;
    const auto comp = result_item(h.run(cmd(c)));
    api::CreateLayer l;
    l.comp = comp;
    l.kind = api::LayerKind::solid;
    layer = result_layer(h.run(cmd(l)));
  }

  api::Response add(const std::string& stroke, std::vector<api::PaintKeyInit> keys = {}) {
    return h.run(cmd(api::AddPaintStroke{layer, stroke, std::move(keys)}));
  }
  std::string add_ok(const std::string& stroke, std::vector<api::PaintKeyInit> keys = {}) {
    const auto r = add(stroke, std::move(keys));
    REQUIRE(is_ok(r));
    return result_as<api::PaintStrokeId>(r).stroke;
  }
  [[nodiscard]] std::vector<js::Json> strokes() const {
    return doc::read_node_paint(*h.session.document().node(layer)).value_or(std::vector<js::Json>{});
  }
  [[nodiscard]] const doc::Node& node() const { return *h.session.document().node(layer); }
  /// The command fails with `code` and changes nothing.
  void refused(api::Command c, api::ErrorCode code) {
    const auto before = state_of(h.session.document());
    REQUIRE(is_error(h.run(std::move(c)), code));
    REQUIRE(state_of(h.session.document()) == before);
  }
};

}  // namespace

TEST_CASE("paint: addPaintStroke appends a normalised stroke with a minted id and its keys", "[paint]") {
  Paint p;
  const auto before = state_of(p.h.session.document());
  const auto a = p.add_ok(R"({"points":[{"x":0,"y":0},{"x":10,"y":0}],"size":8,"opacity":2,"mode":"erase","eraseMode":"paintOnly"})");
  const auto b = p.add_ok(R"({"points":)" + kPts + "}", {{"end", 0.5, 0}, {"end", 1, 100}});
  REQUIRE(a == "pstroke_1");
  REQUIRE(b == "pstroke_2");
  REQUIRE(js::stringify(p.strokes().at(0)) ==
          R"({"id":"pstroke_1","points":[{"x":0,"y":0},{"x":10,"y":0}],"color":"#ffffff","size":8,"opacity":1,"hardness":1,"mode":"erase","eraseMode":"paintOnly"})");
  const auto* keys = doc::anim_track(p.h.session.document(), p.layer, "paint." + b + ".end");
  REQUIRE(keys != nullptr);
  REQUIRE(keys->size() == 2);
  REQUIRE(keys->at(0).t == 0.5);
  REQUIRE(keys->at(1).value == 100);
  REQUIRE(is_ok(p.h.run(cmd(api::Undo{}))));
  REQUIRE(is_ok(p.h.run(cmd(api::Undo{}))));
  REQUIRE(state_of(p.h.session.document()) == before);
}

TEST_CASE("paint: addPaintStroke refuses ids, bad points, bad json and unknown params", "[paint]") {
  Paint p;
  const auto add = [&](std::string stroke, std::vector<api::PaintKeyInit> keys = {}) {
    return cmd(api::AddPaintStroke{p.layer, std::move(stroke), std::move(keys)});
  };
  p.refused(add(R"({"id":"x","points":)" + kPts + "}"), api::ErrorCode::invalid_argument);
  p.refused(add(R"({"points":[]})"), api::ErrorCode::invalid_argument);
  p.refused(add(R"({"points":[{"x":0}]})"), api::ErrorCode::invalid_argument);
  p.refused(add("{points"), api::ErrorCode::invalid_argument);
  p.refused(add("[1]"), api::ErrorCode::invalid_argument);
  p.refused(add(R"({"points":)" + kPts + "}", {{"path", 0, 1}}), api::ErrorCode::invalid_argument);
  p.refused(cmd(api::AddPaintStroke{"nope", R"({"points":)" + kPts + "}", {}}), api::ErrorCode::not_found);
}

TEST_CASE("paint: updatePaintStroke merges, null clears, renormalises", "[paint]") {
  Paint p;
  const auto id = p.add_ok(R"({"points":)" + kPts + R"(,"pressure":[0.5,1]})");
  REQUIRE(is_ok(p.h.run(cmd(api::UpdatePaintStroke{p.layer, id, R"({"visible":false,"hardness":-3})"}))));
  REQUIRE(p.strokes().at(0).at("visible").is_bool());
  REQUIRE(p.strokes().at(0).at("hardness").num() == 0);
  REQUIRE(p.strokes().at(0).at("pressure").is_array());
  REQUIRE(is_ok(p.h.run(cmd(api::UpdatePaintStroke{p.layer, id, R"({"visible":null,"pressure":null})"}))));
  REQUIRE(p.strokes().at(0).at("visible").is_undefined());
  REQUIRE(p.strokes().at(0).at("pressure").is_undefined());
  p.refused(cmd(api::UpdatePaintStroke{p.layer, "nope", "{}"}), api::ErrorCode::not_found);
  p.refused(cmd(api::UpdatePaintStroke{p.layer, id, R"({"id":"y"})"}), api::ErrorCode::invalid_argument);
  p.refused(cmd(api::UpdatePaintStroke{p.layer, id, R"({"points":null})"}), api::ErrorCode::invalid_argument);
}

TEST_CASE("paint: removePaintStrokes drops the strokes and their tracks; undo is exact", "[paint]") {
  Paint p;
  const auto a = p.add_ok(R"({"points":)" + kPts + "}", {{"end", 0, 0}, {"end", 1, 100}});
  const auto b = p.add_ok(R"({"points":)" + kPts + "}", {{"opacity", 0, 50}, {"opacity", 1, 60}});
  REQUIRE(is_ok(p.h.run(cmd(api::SetPaintPathAnimated{p.layer, a, true, 0}))));
  const auto before = state_of(p.h.session.document());
  REQUIRE(is_ok(p.h.run(cmd(api::RemovePaintStrokes{p.layer, {a}}))));
  REQUIRE(p.strokes().size() == 1);
  REQUIRE(p.strokes().at(0).at("id").str() == b);
  const auto& d = p.h.session.document();
  REQUIRE(doc::anim_track(d, p.layer, "paint." + a + ".end") == nullptr);
  REQUIRE_FALSE(doc::anim_is_data_animated(d, p.layer, "paint." + a + ".path"));
  REQUIRE(doc::anim_track(d, p.layer, "paint." + b + ".opacity")->size() == 2);
  REQUIRE(is_ok(p.h.run(cmd(api::Undo{}))));
  REQUIRE(state_of(p.h.session.document()) == before);
  p.refused(cmd(api::RemovePaintStrokes{p.layer, {a, "nope"}}), api::ErrorCode::not_found);
  p.refused(cmd(api::RemovePaintStrokes{p.layer, {}}), api::ErrorCode::invalid_argument);
}

TEST_CASE("paint: Paint on Transparent", "[paint]") {
  Paint p;
  p.refused(cmd(api::SetPaintOnTransparent{{p.layer}, true}), api::ErrorCode::not_found);
  (void)p.add_ok(R"({"points":)" + kPts + "}");
  REQUIRE(is_ok(p.h.run(cmd(api::SetPaintOnTransparent{{p.layer}, true}))));
  REQUIRE(doc::paint_on_transparent(p.node()));
  REQUIRE(is_ok(p.h.run(cmd(api::SetPaintOnTransparent{{p.layer}, false}))));
  REQUIRE_FALSE(doc::paint_on_transparent(p.node()));
}

TEST_CASE("paint: the Path — static replace, stopwatch, keyed replace, OFF", "[paint]") {
  Paint p;
  const auto id = p.add_ok(R"({"points":)" + kPts + R"(,"pressure":[0.5,1],"tiltX":[1,2]})");
  REQUIRE(is_ok(p.h.run(cmd(api::SetPaintStrokePath{p.layer, id, R"([{"x":5,"y":5}])", 0}))));
  REQUIRE(js::stringify(p.strokes().at(0).at("points")) == R"([{"x":5,"y":5}])");
  REQUIRE(p.strokes().at(0).at("pressure").is_undefined());
  REQUIRE(p.strokes().at(0).at("tiltX").is_undefined());

  const std::string track = "paint." + id + ".path";
  REQUIRE(is_ok(p.h.run(cmd(api::SetPaintPathAnimated{p.layer, id, true, 0}))));
  REQUIRE(is_ok(p.h.run(cmd(api::SetPaintPathAnimated{p.layer, id, true, kSec}))));
  REQUIRE(doc::anim_data_track(p.h.session.document(), p.layer, track)->keys.size() == 1);
  REQUIRE(is_ok(p.h.run(cmd(api::SetPaintStrokePath{p.layer, id, R"([{"x":7,"y":7}])", kSec}))));
  const auto* t = doc::anim_data_track(p.h.session.document(), p.layer, track);
  REQUIRE(t->kind == "points");
  REQUIRE(t->keys.size() == 2);
  REQUIRE(js::stringify(t->keys.at(1).value) == R"([{"x":7,"y":7}])");
  REQUIRE(js::stringify(p.strokes().at(0).at("points")) == R"([{"x":5,"y":5}])");

  const auto before = state_of(p.h.session.document());
  REQUIRE(is_ok(p.h.run(cmd(api::SetPaintPathAnimated{p.layer, id, false, 0}))));
  REQUIRE_FALSE(doc::anim_is_data_animated(p.h.session.document(), p.layer, track));
  REQUIRE(is_ok(p.h.run(cmd(api::Undo{}))));
  REQUIRE(state_of(p.h.session.document()) == before);

  p.refused(cmd(api::SetPaintStrokePath{p.layer, id, "[]", 0}), api::ErrorCode::invalid_argument);
  p.refused(cmd(api::SetPaintStrokePath{p.layer, "nope", kPts, 0}), api::ErrorCode::not_found);
  p.refused(cmd(api::SetPaintPathAnimated{p.layer, "nope", true, 0}), api::ErrorCode::not_found);
}
