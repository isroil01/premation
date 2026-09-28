// B4 round 5, slice C (ENGINE_API.md §15.14): text and stored values —
// PropertyInfo.stored, grapheme-indexed `text/styleRuns` reads (legacy
// code-point runs migrated), CSS rgb() / rgba() colours read as colour values,
// a legacy `strokeOverFill` read as its Fill and Stroke order, and
// `model/targetNames`. Semantics are the TypeScript engine's:
// src/core/engine/__tests__/b4Round5Text.test.ts restores the same document and
// pins the same answers. The glyph boxes (getTextLayout.glyphs) need fonts:
// tests/test_b4_round5_text_glyphs.cpp (engine_scene_tests).

#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <string>
#include <variant>
#include <vector>

#include "fxstate.hpp"
#include "session_harness.hpp"

using namespace premation;
using namespace premation::test;

namespace {

// B4R5_TEXT_DOC (b4Round5Text.test.ts). The emoji + skin tone is ONE grapheme,
// two code points; the runs carry no `__runsIndex` (code-point indexed).
const std::string kDoc = std::string(R"json({
  "version":"1.9.0",
  "scene":{"version":"1.0.0","nodes":[
    {"id":"comp_root","name":"Composition 1","parent":null,"children":["t1","s1","m1"],"visible":true,"locked":false,
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[{"id":"comp_root_meta","type":"group","props":{"__kind":"group"}}]},
    {"id":"t1","name":"t1","parent":"comp_root","children":[],"visible":true,"locked":false,
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":"t1_t","type":"Transform","props":{"__kind":"text","x":100,"y":100,"rotation":0,"scaleX":100,"scaleY":100}},
       {"id":"t1_s","type":"Style","props":{"opacity":100,"fill":"rgba(255, 0, 0, 0.5)"}},
       {"id":"t1_x","type":"Text","props":{"content":"a)json") +
                        "\xF0\x9F\x91\x8D\xF0\x9F\x8F\xBD" + R"json(b","fontSize":48,"fontFamily":"Arial","strokeOverFill":true,
         "__runs":[{"start":1,"end":3,"style":{"fill":"#ff0000"}},{"start":"x","end":2,"style":{}}]}}]},
    {"id":"s1","name":"s1","parent":"comp_root","children":[],"visible":true,"locked":false,
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":"s1_t","type":"Transform","props":{"__kind":"shape","x":100,"y":100,"rotation":0,"scaleX":100,"scaleY":100}},
       {"id":"s1_s","type":"Style","props":{"opacity":100,"fill":"rgb(0 128 255 / 50%)","cornerRadius":12,"cornerRadiusTL":4}}]},
    {"id":"m1","name":"m1","parent":"comp_root","children":[],"visible":true,"locked":false,
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":"m1_t","type":"Transform","props":{"__kind":"shape","x":100,"y":100,"rotation":0,"scaleX":100,"scaleY":100}},
       {"id":"m1_m","type":"Model","props":{"morphNames":["jawOpen","","smile"]}}]}
  ]},
  "animation":{"tracks":{},"data":{},"expressions":{}},
  "comps":{"comp_root":{"id":"comp_root","name":"comp_root","width":1920,"height":1080,"fps":30,"durationSeconds":10,"background":"#101014"}},
  "motionBlur":{"enabled":false,"shutterAngle":180,"shutterPhase":-90,"samples":8,"adaptiveSampleLimit":128},
  "openTabs":{"tabOrder":["tab1"],"activeTabId":"tab1","tabs":{"tab1":{"id":"tab1","compositionId":"comp_root","breadcrumbPath":["comp_root"],"title":"comp_root","time":0,"frame":0}}}
})json";

void restore(Harness& h) {
  api::RestoreDocument r;
  r.document.assign(kDoc.begin(), kDoc.end());
  REQUIRE(is_ok(h.run(cmd(r))));
}

std::vector<api::PropertyInfo> tree(Harness& h, const std::string& layer) {
  api::GetPropertyTree q;
  q.layer = layer;
  const auto r = h.ask(qry(q));
  REQUIRE(is_ok(r));
  return std::get<api::PropertyTree>(std::get<api::QueryResult>(r.outcome.v).v).nodes;
}

const api::PropertyInfo* by_path(const std::vector<api::PropertyInfo>& nodes, const std::string& path) {
  for (const auto& n : nodes) {
    if (n.path == path) return &n;
  }
  return nullptr;
}

const api::PropertyInfo* by_match(const std::vector<api::PropertyInfo>& nodes, const std::string& match) {
  for (const auto& n : nodes) {
    if (n.match_name == match && n.kind == api::PropertyKind::property) return &n;
  }
  return nullptr;
}

std::optional<bool> stored_of(const api::PropertyInfo* p) { return p != nullptr ? p->stored : std::nullopt; }

std::vector<double> color_of(const api::PropertyInfo* p) {
  if (p == nullptr || !p->value || p->value->kind() != doc::VK::color) return {};
  const api::Color& c = doc::get<doc::VK::color>(*p->value);
  return {c.r, c.g, c.b, c.a};
}

std::string json_of(const api::PropertyInfo* p) {
  if (p == nullptr || !p->value || p->value->kind() != doc::VK::json) return "<none>";
  return doc::get<doc::VK::json>(*p->value);
}

}  // namespace

TEST_CASE("PropertyInfo.stored: explicit static values say so; unset means the default applies", "[b4r5][text]") {
  Harness h;
  (void)h.hello();
  restore(h);
  const auto t = tree(h, "t1");
  CHECK(stored_of(by_path(t, "text/fontFamily")) == std::optional<bool>(true));
  CHECK(stored_of(by_match(t, "fontSize")) == std::optional<bool>(true));
  CHECK_FALSE(stored_of(by_match(t, "lineHeight")).has_value());
  CHECK_FALSE(stored_of(by_path(t, "text/align")).has_value());
  CHECK(stored_of(by_path(t, "layer/fill")) == std::optional<bool>(true));
  CHECK(stored_of(by_path(t, "text/sourceText")) == std::optional<bool>(true));
  CHECK(stored_of(by_path(t, "text/styleRuns")) == std::optional<bool>(true));
  for (const auto& n : t) {
    if (n.kind != api::PropertyKind::property) CHECK_FALSE(n.stored.has_value());
  }
  const auto s = tree(h, "s1");
  CHECK(stored_of(by_match(s, "cornerRadius")) == std::optional<bool>(true));
  CHECK(stored_of(by_match(s, "cornerRadiusTL")) == std::optional<bool>(true));
  const api::PropertyInfo* tr = by_match(s, "cornerRadiusTR");
  REQUIRE(tr != nullptr);
  CHECK_FALSE(tr->stored.has_value());
  CHECK_FALSE(stored_of(by_path(s, "layer/cornersLinked")).has_value());
  // A write stores it.
  api::SetProperty sp;
  sp.prop = {"s1", tr->path};
  sp.value = scalar(6);
  REQUIRE(is_ok(h.run(cmd(sp))));
  CHECK(stored_of(by_path(tree(h, "s1"), tr->path)) == std::optional<bool>(true));
}

TEST_CASE("text/styleRuns reads grapheme-indexed: legacy code-point runs migrated, malformed runs dropped", "[b4r5][text]") {
  Harness h;
  (void)h.hello();
  restore(h);
  CHECK(json_of(by_path(tree(h, "t1"), "text/styleRuns")) == R"([{"start":1,"end":2,"style":{"fill":"#ff0000"}}])");
}

TEST_CASE("CSS rgb() / rgba() colours read as colour values", "[b4r5][text]") {
  Harness h;
  (void)h.hello();
  restore(h);
  CHECK(color_of(by_path(tree(h, "t1"), "layer/fill")) == std::vector<double>{1, 0, 0, 0.5});
  CHECK(color_of(by_path(tree(h, "s1"), "layer/fill")) == std::vector<double>{0, 128.0 / 255, 1, 0.5});
  // fields.ts cssRgbChannels, case for case.
  CHECK(doc::css_rgb_channels("RGBA(10%, 300, -4, 2)") == std::optional<std::array<double, 4>>({std::round(25.5) / 255, 1, 0, 1}));
  CHECK(doc::css_rgb_channels(" rgb(1.5e2 .5 +7) ") == std::optional<std::array<double, 4>>({150.0 / 255, 1.0 / 255, 7.0 / 255, 1}));
  for (const char* bad : {"rgb(1, 2)", "rgb(1,2,3,4,5)", "rgb(1px, 2, 3)", "rgb(1, 2, 3", "hsl(1, 2%, 3%)", "#ff0000", "rgb(., 2, 3)"}) {
    INFO(bad);
    CHECK_FALSE(doc::css_rgb_channels(bad).has_value());
  }
}

TEST_CASE("a legacy strokeOverFill switch reads as its Fill and Stroke order", "[b4r5][text]") {
  Harness h;
  (void)h.hello();
  restore(h);
  const auto t = tree(h, "t1");
  const api::PropertyInfo* order = by_path(t, "text/strokeOrder");
  REQUIRE(order != nullptr);
  REQUIRE(order->value.has_value());
  CHECK(doc::get<doc::VK::choice>(*order->value) == "stroke-over-fill");
  CHECK(order->stored == std::optional<bool>(true));
}

TEST_CASE("model/targetNames: the stored blend-shape names", "[b4r5][text]") {
  Harness h;
  (void)h.hello();
  restore(h);
  const auto m = tree(h, "m1");
  CHECK(json_of(by_path(m, "model/targetNames")) == R"(["jawOpen","","smile"])");
  CHECK(stored_of(by_path(m, "model/targetNames")) == std::optional<bool>(true));
  CHECK(by_path(tree(h, "t1"), "model/targetNames") == nullptr);
}
