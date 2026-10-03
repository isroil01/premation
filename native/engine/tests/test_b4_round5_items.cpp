// B4 round 5 (ENGINE_API.md §15.14): the item / layer facts the UI read around
// the API — ItemInfo.mediaUrl, LayerInfo.caption / multicamAngle,
// getDocumentColors, getCaptionCues, mapLayerTime, getSourceSize,
// checkPrecompose, getMemberKeyframes{includeData} and the template slot
// fields. Semantics are the TypeScript engine's
// (src/core/engine/__tests__/itemFactsQueries.test.ts pins the same cases).

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <functional>
#include <string>
#include <variant>
#include <vector>

#include "docio.hpp"
#include "json.hpp"
#include "session_harness.hpp"

using namespace premation;
using namespace premation::test;

namespace {

constexpr api::Time kSec = 705'600'000;

api::ItemId make_comp(Harness& h, const std::string& name = "Test", std::uint32_t w = 1920, std::uint32_t hgt = 1080) {
  api::CreateComposition c;
  c.settings.name = name;
  c.settings.width = w;
  c.settings.height = hgt;
  c.settings.frame_rate = api::Rational{30, 1};
  c.settings.duration = 10 * kSec;
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  return result_item(r);
}

api::LayerId make_layer(Harness& h, const api::ItemId& comp, api::LayerKind kind, std::optional<api::ItemId> source = std::nullopt) {
  api::CreateLayer c;
  c.comp = comp;
  c.kind = kind;
  c.source = std::move(source);
  const auto r = h.run(cmd(c));
  if (!is_ok(r)) FAIL(std::get<api::EngineError>(r.outcome.v).message);
  return result_layer(r);
}

api::ItemId import_clip(Harness& h, std::string path) {
  api::ImportFiles imp;
  imp.files = {api::ImportFile{std::move(path), false, {}, {}, false}};
  const auto r = h.run(cmd(imp));
  REQUIRE(is_ok(r));
  return result_as<api::ItemList>(r).items.at(0);
}

template <class R, class Q>
R ask_ok(Harness& h, Q q) {
  const auto r = h.ask(qry(std::move(q)));
  if (!is_ok(r)) FAIL(std::get<api::EngineError>(r.outcome.v).message);
  return std::get<R>(std::get<api::QueryResult>(r.outcome.v).v);
}

api::LayerInfo layer_info(Harness& h, const api::LayerId& id) { return ask_ok<api::LayerDetails>(h, api::GetLayers{{id}}).layers.at(0); }

/// Copy `layer`, let `edit` change its stored node (the fragment's `row`), paste the result into `comp`.
api::LayerId paste_edited(Harness& h, const api::ItemId& comp, const api::LayerId& layer, const std::function<void(js::Json&)>& edit) {
  api::CopyLayers copy;
  copy.layers = {layer};
  const auto frag = ask_ok<api::DocumentFragment>(h, copy);
  auto doc = js::parse(std::string(frag.data.begin(), frag.data.end()));
  REQUIRE(doc.has_value());
  js::Json* layers = doc->find_mut("layers");
  REQUIRE(layers != nullptr);
  js::Json* row = layers->arr_mut().at(0).find_mut("row");
  REQUIRE(row != nullptr);
  edit(*row);
  const std::string text = js::stringify(*doc);
  api::PasteLayers p;
  p.comp = comp;
  p.fragment = frag;
  p.fragment.data.assign(text.begin(), text.end());
  const auto r = h.run(cmd(p));
  if (!is_ok(r)) FAIL(std::get<api::EngineError>(r.outcome.v).message);
  return result_as<api::LayerList>(r).layers.at(0);
}

}  // namespace

TEST_CASE("ItemInfo.mediaUrl: a footage item's stored source reference; none on a composition", "[b4r5][items]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto clip = import_clip(h, "C:/m/clip.mp4");
  const auto items = ask_ok<api::ItemDetails>(h, api::GetItems{{clip, comp}}).items;
  REQUIRE(items.size() == 2);
  CHECK(items[0].media_url == std::optional<std::string>("blob:fake/" + clip));
  CHECK_FALSE(items[1].media_url.has_value());
}

TEST_CASE("LayerInfo.caption, getCaptionCues: tagged top-level text layers as cues, trimmed, by start", "[b4r5][items]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto text = make_layer(h, comp, api::LayerKind::text);
  const auto cap = paste_edited(h, comp, text, [](js::Json& row) {
    js::Json tag = js::Json::object();
    tag.set("id", js::Json::string("capc"));
    js::Json props = js::Json::object();
    props.set("__caption", js::Json::boolean(true));
    props.set("content", js::Json::string("  Hello there  "));
    tag.set("props", std::move(props));
    tag.set("type", js::Json::string("captionTag"));
    auto& comps = row.find_mut("components")->arr_mut();
    comps.insert(comps.begin(), std::move(tag));
  });
  api::SetLayerTiming st;
  st.items = {api::LayerTimingPatch{cap, 2 * kSec, 3 * kSec, std::nullopt, std::nullopt}};
  REQUIRE(is_ok(h.run(cmd(st))));
  CHECK(layer_info(h, cap).caption == std::optional<bool>(true));
  CHECK_FALSE(layer_info(h, text).caption.has_value());
  const auto cues = ask_ok<api::CaptionCues>(h, api::GetCaptionCues{comp}).cues;
  REQUIRE(cues.size() == 1);
  CHECK(cues[0].layer == cap);
  CHECK(cues[0].start == 2 * kSec);
  CHECK(cues[0].end == 3 * kSec);
  CHECK(cues[0].text == "Hello there");
  const auto bad = h.ask(qry(api::GetCaptionCues{"nope"}));
  CHECK(is_error(bad, api::ErrorCode::not_found));
}

TEST_CASE("setCaptions: one timed caption layer per cue, replacing the old ones, one undo entry", "[p4][captions]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h, "Caps", 640, 360);
  const auto plain = make_layer(h, comp, api::LayerKind::text);
  api::SetCaptions sc;
  sc.comp = comp;
  sc.cues = {api::CaptionInput{1 * kSec, 2 * kSec, "Hello"}, api::CaptionInput{3 * kSec, 4 * kSec, "Two\nlines"}};
  const auto made = h.run(cmd(sc));
  REQUIRE(is_ok(made));
  CHECK(result_as<api::LayerList>(made).layers.size() == 2);
  auto cues = ask_ok<api::CaptionCues>(h, api::GetCaptionCues{comp}).cues;
  REQUIRE(cues.size() == 2);
  CHECK(cues[0].text == "Hello");
  CHECK(cues[0].start == 1 * kSec);
  CHECK(cues[0].end == 2 * kSec);
  CHECK(cues[1].text == "Two\nlines");
  CHECK(cues[1].start == 3 * kSec);
  CHECK(layer_info(h, cues[0].layer).kind == api::LayerKind::text);

  // Again: the captions are replaced, the plain text layer is kept.
  api::SetCaptions again;
  again.comp = comp;
  again.cues = {api::CaptionInput{5 * kSec, 6 * kSec, "Only"}};
  REQUIRE(is_ok(h.run(cmd(again))));
  cues = ask_ok<api::CaptionCues>(h, api::GetCaptionCues{comp}).cues;
  REQUIRE(cues.size() == 1);
  CHECK(cues[0].text == "Only");
  CHECK(layer_info(h, plain).kind == api::LayerKind::text);

  // One entry: undo brings the first two back.
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  cues = ask_ok<api::CaptionCues>(h, api::GetCaptionCues{comp}).cues;
  CHECK(cues.size() == 2);

  api::SetCaptions bad;
  bad.comp = comp;
  bad.cues = {api::CaptionInput{2 * kSec, 1 * kSec, "Backwards"}};
  CHECK(is_error(h.run(cmd(bad)), api::ErrorCode::invalid_argument));
}

TEST_CASE("LayerInfo.multicamAngle: the Transform tag of a video layer", "[b4r5][items]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto clip = import_clip(h, "C:/m/clip.mp4");
  const auto video = make_layer(h, comp, api::LayerKind::video, clip);
  const auto angle = paste_edited(h, comp, video, [](js::Json& row) {
    for (js::Json& c : row.find_mut("components")->arr_mut()) {
      if (c.at("type").is_string() && c.at("type").str() == "Transform") c.find_mut("props")->set("__multicamAngle", js::Json::number(2));
    }
  });
  CHECK(layer_info(h, angle).multicam_angle == std::optional<std::uint32_t>(2));
  CHECK_FALSE(layer_info(h, video).multicam_angle.has_value());
}

TEST_CASE("getSourceSize: footage (x pixel aspect), a placed composition, the per-kind default; none for a null", "[b4r5][items]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto inner = make_comp(h, "Inner", 800, 600);
  const auto clip = import_clip(h, "C:/m/clip.mp4");
  const auto video = make_layer(h, comp, api::LayerKind::video, clip);
  const auto text = make_layer(h, comp, api::LayerKind::text);
  const auto nul = make_layer(h, comp, api::LayerKind::null);
  const auto pre = make_layer(h, comp, api::LayerKind::precomp, inner);
  const auto sizes = ask_ok<api::SourceSizes>(h, api::GetSourceSize{{video, text, nul, pre, "nope"}}).sizes;
  REQUIRE(sizes.size() == 3);
  CHECK((sizes[0].layer == video && sizes[0].width == 640 && sizes[0].height == 360));
  CHECK((sizes[1].layer == text && sizes[1].width == 320 && sizes[1].height == 80));
  CHECK((sizes[2].layer == pre && sizes[2].width == 800 && sizes[2].height == 600));
  api::SetInterpretation si;
  si.items = {clip};
  si.patch.pixel_aspect = 2;
  REQUIRE(is_ok(h.run(cmd(si))));
  const auto wide = ask_ok<api::SourceSizes>(h, api::GetSourceSize{{video}}).sizes;
  REQUIRE(wide.size() == 1);
  CHECK(wide[0].width == 1280);
  CHECK(wide[0].height == 360);
}

TEST_CASE("mapLayerTime: through a placed composition's start time; one to one elsewhere; no outward answer once remapped", "[b4r5][items]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto inner = make_comp(h, "Inner", 800, 600);
  const auto pre = make_layer(h, comp, api::LayerKind::precomp, inner);
  const auto text = make_layer(h, comp, api::LayerKind::text);
  api::SetLayerTiming st;
  st.items = {api::LayerTimingPatch{pre, std::nullopt, std::nullopt, kSec, std::nullopt}};
  REQUIRE(is_ok(h.run(cmd(st))));
  const auto map = [&](const api::LayerId& l, api::Time t, bool outward) {
    return ask_ok<api::MappedTime>(h, api::MapLayerTime{l, t, outward, std::nullopt}).time;
  };
  CHECK(map(pre, 3 * kSec, false) == std::optional<api::Time>(2 * kSec));
  CHECK(map(pre, 2 * kSec, true) == std::optional<api::Time>(3 * kSec));
  CHECK(map(text, 3 * kSec, false) == std::optional<api::Time>(3 * kSec));
  REQUIRE(is_ok(h.run(cmd(api::SetTimeRemap{pre, true}))));
  CHECK_FALSE(map(pre, 2 * kSec, true).has_value());
  CHECK(is_error(h.ask(qry(api::MapLayerTime{"nope", 0, false, std::nullopt})), api::ErrorCode::not_found));
}

TEST_CASE("mapLayerTime keyframeAxis: the layer's own keyframe axis follows its start, both ways", "[block3][items]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto text = make_layer(h, comp, api::LayerKind::text);
  api::SetLayerTiming st;
  st.items = {api::LayerTimingPatch{text, std::nullopt, std::nullopt, kSec, std::nullopt}};
  REQUIRE(is_ok(h.run(cmd(st))));
  api::MapLayerTime q{text, 3 * kSec, false, true};
  CHECK(ask_ok<api::MappedTime>(h, q).time == std::optional<api::Time>(2 * kSec));
  q.outward = true;
  q.time = 2 * kSec;
  CHECK(ask_ok<api::MappedTime>(h, q).time == std::optional<api::Time>(3 * kSec));
  q.layer = "nope";
  q.outward = false;
  CHECK(is_error(h.ask(qry(q)), api::ErrorCode::not_found));
}

TEST_CASE("checkPrecompose: the Leave All Attributes refusal, message for message", "[b4r5][items]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto clip = import_clip(h, "C:/m/clip.mp4");
  const auto video = make_layer(h, comp, api::LayerKind::video, clip);
  const auto text = make_layer(h, comp, api::LayerKind::text);
  const auto reason = [&](std::vector<api::LayerId> layers) {
    return ask_ok<api::PrecomposeCheck>(h, api::CheckPrecompose{comp, std::move(layers)}).leave_attributes_reason;
  };
  CHECK(reason({text}) == "Not available for text layers — their content is not a separate source.");
  CHECK(reason({text, video}) == "Only available when a single layer is selected.");
  CHECK(reason({video}).empty());
}

TEST_CASE("getDocumentColors: fills then strokes per layer, canonical, first seen, limited", "[b4r5][items]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto fill = [&](const api::LayerId& layer, double r, double g, double b, double a) {
    api::SetProperty sp;
    sp.prop = {layer, "layer/fill"};
    sp.value = doc::v_color(r, g, b, a);
    REQUIRE(is_ok(h.run(cmd(sp))));
  };
  fill(make_layer(h, comp, api::LayerKind::solid), 1, 0, 0, 1);
  const auto colors = [&](std::uint32_t limit) { return ask_ok<api::DocumentColors>(h, api::GetDocumentColors{limit}).colors; };
  CHECK(colors(0) == std::vector<std::string>{"#ff0000"});
  fill(make_layer(h, comp, api::LayerKind::solid), 1, 0, 0, 1);
  fill(make_layer(h, comp, api::LayerKind::solid), 0, 0, 1, 0.5);
  auto three = colors(0);
  const auto first = three.at(0);
  std::sort(three.begin(), three.end());
  CHECK(three == std::vector<std::string>{"#0000ff80", "#ff0000"});
  CHECK(colors(1) == std::vector<std::string>{first});
}

TEST_CASE("canonical_hex: short forms, opaque alpha, non-hex", "[b4r5][items]") {
  CHECK(doc::canonical_hex(js::Json::string("#FFF")) == std::optional<std::string>("#ffffff"));
  CHECK(doc::canonical_hex(js::Json::string("ffffff")) == std::optional<std::string>("#ffffff"));
  CHECK(doc::canonical_hex(js::Json::string("#FFFFFFFF")) == std::optional<std::string>("#ffffff"));
  CHECK(doc::canonical_hex(js::Json::string("#11223380")) == std::optional<std::string>("#11223380"));
  CHECK_FALSE(doc::canonical_hex(js::Json::string("rgba(1, 2, 3, 0.5)")).has_value());
  CHECK_FALSE(doc::canonical_hex(js::Json::string("#12345")).has_value());
  CHECK_FALSE(doc::canonical_hex(js::Json::string("")).has_value());
  CHECK_FALSE(doc::canonical_hex(js::Json()).has_value());
}

TEST_CASE("getMemberKeyframes{includeData}: keyed data tracks after the scalar ones, flagged", "[b4r5][items]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto text = make_layer(h, comp, api::LayerKind::text);
  api::AddKeyframes add;
  for (const api::Time t : {api::Time{0}, kSec}) {
    api::KeyframeInsert k;
    k.prop = {text, "text/sourceText"};
    k.time = t;
    add.keys.push_back(k);
  }
  REQUIRE(is_ok(h.run(cmd(add))));
  api::GetMemberKeyframes q;
  q.layer = text;
  const auto plain = ask_ok<api::MemberTracks>(h, q).tracks;
  CHECK(std::none_of(plain.begin(), plain.end(), [](const api::MemberTrack& t) { return t.data.value_or(false); }));
  q.include_data = true;
  const auto all = ask_ok<api::MemberTracks>(h, q).tracks;
  std::vector<api::MemberTrack> data;
  std::copy_if(all.begin(), all.end(), std::back_inserter(data), [](const api::MemberTrack& t) { return t.data.value_or(false); });
  REQUIRE(data.size() == 1);
  CHECK(data[0].path == "text/sourceText");
  CHECK(data[0].count == 2);
  const auto keys = js::parse(data[0].keyframes);
  REQUIRE(keys.has_value());
  CHECK(keys->arr().size() == 2);
}

TEST_CASE("template slot fields: layer/slotFit, slotWidth, slotHeight on a layer that shows a source", "[b4r5][items]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto clip = import_clip(h, "C:/m/clip.mp4");
  const auto video = make_layer(h, comp, api::LayerKind::video, clip);
  const auto text = make_layer(h, comp, api::LayerKind::text);
  const auto value = [&](const std::string& path) {
    api::GetPropertyTree t;
    t.layer = video;
    t.path = path;
    t.depth = 1;
    const auto tree = ask_ok<api::PropertyTree>(h, t);
    REQUIRE_FALSE(tree.nodes.empty());
    REQUIRE(tree.nodes.front().value.has_value());
    return *tree.nodes.front().value;
  };
  CHECK(doc::get<doc::VK::choice>(value("layer/slotFit")) == "none");
  const auto set = [&](const api::LayerId& layer, const std::string& path, api::Value v) {
    api::SetProperty sp;
    sp.prop = {layer, path};
    sp.value = std::move(v);
    return h.run(cmd(sp));
  };
  REQUIRE(is_ok(set(video, "layer/slotFit", doc::v_choice("cover"))));
  REQUIRE(is_ok(set(video, "layer/slotWidth", doc::v_scalar(400))));
  REQUIRE(is_ok(set(video, "layer/slotHeight", doc::v_scalar(300))));
  CHECK(doc::get<doc::VK::choice>(value("layer/slotFit")) == "cover");
  CHECK(doc::get<doc::VK::scalar>(value("layer/slotWidth")) == 400);
  CHECK(doc::get<doc::VK::scalar>(value("layer/slotHeight")) == 300);
  CHECK_FALSE(is_ok(set(text, "layer/slotFit", doc::v_choice("cover"))));
}
