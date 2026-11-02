// The frame-key index (core/frame_keys.hpp) on long timelines: a layer's hash
// is kept as spans, not a word per frame, so a 30-minute comp with 200 layers
// and a 60-minute comp at 60 fps index inside the smallest budget; a key edit
// on one layer still reaches only the frames its neighbours decide; and the
// spans compress exactly what the dense per-frame evaluation says, edit after
// edit, on a comp with random keys, bars and stretches.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <memory>
#include <optional>
#include <random>
#include <string>
#include <utility>
#include <vector>

#include "core/frame_keys.hpp"
#include "session_harness.hpp"

using namespace premation;
using namespace premation::test;

namespace {

constexpr api::Time kSec = 705'600'000;

api::ItemId make_comp(Harness& h, std::uint32_t fps, double seconds) {
  api::CreateComposition c;
  c.settings.name = "Long";
  c.settings.width = 1920;
  c.settings.height = 1080;
  c.settings.frame_rate = api::Rational{fps, 1};
  c.settings.duration = static_cast<api::Time>(std::llround(seconds * static_cast<double>(kSec)));
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  return result_item(r);
}

api::LayerId make_layer(Harness& h, const api::ItemId& comp) {
  api::CreateLayer c;
  c.comp = comp;
  c.kind = api::LayerKind::solid;
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  return result_layer(r);
}

api::Time at(double seconds) { return static_cast<api::Time>(std::llround(seconds * static_cast<double>(kSec))); }

/// Linear keys on `prop` at `seconds`; a vec2 prop takes (v, 0), a scalar v.
void add_keys(Harness& h, const api::LayerId& layer, const std::string& prop, const std::vector<double>& seconds, bool vec) {
  api::AddKeyframes a;
  for (std::size_t i = 0; i < seconds.size(); ++i) {
    api::KeyframeInsert ins;
    ins.prop = {layer, prop};
    ins.time = at(seconds[i]);
    const double v = 10.0 * static_cast<double>(i);
    ins.value = vec ? vec2(v, 0) : scalar(v);
    ins.easing = api::Easing::linear;
    a.keys.push_back(std::move(ins));
  }
  REQUIRE(is_ok(h.run(cmd(a))));
}

api::Response set_prop(Harness& h, const api::LayerId& layer, const std::string& path, api::Value v, api::Time t) {
  api::SetProperty s;
  s.prop = {layer, path};
  s.value = std::move(v);
  s.time = t;
  return h.run(cmd(s));
}

/// A copy of a layer's animation as a change set part (null = none).
std::shared_ptr<doc::NodeAnim> snap_anim(const doc::Document& d, const std::string& id) {
  const doc::NodeAnim* a = d.anim(id);
  return a == nullptr ? nullptr : std::make_shared<doc::NodeAnim>(*a);
}

/// The change set a commit that touched only `id`'s animation records.
doc::ChangeSet anim_change(const std::shared_ptr<doc::NodeAnim>& before, const doc::Document& d, const std::string& id) {
  doc::ChangeSet cs;
  cs.before.anims[id] = before;
  cs.after.anims[id] = snap_anim(d, id);
  return cs;
}

/// The dense reference: a word per (layer, frame), summed per frame, keyed as
/// the index keys — what the spans must reproduce.
struct DenseReference {
  std::vector<std::string> layers;
  std::vector<std::vector<std::uint64_t>> rows;
  std::vector<std::uint64_t> total;

  void build(const doc::FrameKeyIndex& index, const doc::Document& d) {
    layers = index.indexed_layers();
    const auto frames = static_cast<std::size_t>(index.frames());
    rows.assign(layers.size(), std::vector<std::uint64_t>(frames, 0));
    total.assign(frames, 0);
    for (std::size_t i = 0; i < layers.size(); ++i) {
      for (std::size_t f = 0; f < frames; ++f) {
        const std::optional<std::uint64_t> h = index.layer_hash(d, layers[i], static_cast<std::int64_t>(f));
        REQUIRE(h.has_value());
        rows[i][f] = *h;
        total[f] += *h;
      }
    }
  }

  /// Re-rows one layer after an edit: the frames whose word changed.
  std::vector<std::int64_t> rerow(const doc::FrameKeyIndex& index, const doc::Document& d, const std::string& layer) {
    const auto i = static_cast<std::size_t>(std::find(layers.begin(), layers.end(), layer) - layers.begin());
    REQUIRE(i < layers.size());
    std::vector<std::int64_t> changed;
    for (std::size_t f = 0; f < rows[i].size(); ++f) {
      const std::uint64_t h = index.layer_hash(d, layer, static_cast<std::int64_t>(f)).value();
      if (h == rows[i][f]) continue;
      total[f] += h - rows[i][f];
      rows[i][f] = h;
      changed.push_back(static_cast<std::int64_t>(f));
    }
    return changed;
  }

  void check_keys(const doc::FrameKeyIndex& index) const {
    for (std::size_t f = 0; f < total.size(); ++f) {
      const std::uint64_t expected = doc::FrameKeyIndex::key_of(index.static_hash(), total[f], static_cast<std::int64_t>(f));
      if (expected != index.key(static_cast<std::int64_t>(f))) {
        CAPTURE(f);
        REQUIRE(expected == index.key(static_cast<std::int64_t>(f)));
      }
    }
  }
};

std::vector<std::int64_t> range(std::int64_t first, std::int64_t end) {
  std::vector<std::int64_t> out;
  for (std::int64_t f = first; f < end; ++f) out.push_back(f);
  return out;
}

}  // namespace

TEST_CASE("frame keys: a 30-minute comp with 200 layers indexes, and a key edit on one layer reaches only the frames its neighbours decide",
          "[keys][long]") {
  Harness h(64);
  (void)h.hello();
  const api::ItemId comp = make_comp(h, 30, 1800.0);
  std::vector<api::LayerId> layers;
  for (int i = 0; i < 200; ++i) layers.push_back(make_layer(h, comp));
  // The first 20 move: a key every 60 s (31 keys); the rest are still.
  std::vector<double> every60;
  for (int k = 0; k <= 30; ++k) every60.push_back(60.0 * k);
  for (int i = 0; i < 20; ++i) add_keys(h, layers[static_cast<std::size_t>(i)], "transform/position", every60, true);

  doc::FrameKeyIndex index;
  index.set_budget_bytes(doc::FrameKeyIndex::kMinBudgetBytes);
  REQUIRE(index.rebuild(h.session.document(), h.session.view(), comp, ""));
  REQUIRE(index.indexed());
  REQUIRE(index.frames() == 54'000);
  // Dense would be 200 × 54,000 words = 86 MB (past the old 32 MB cap). Spans:
  // the total's 432 KB plus a span per still layer and a handful per key.
  CHECK(index.bytes() < std::size_t{2} << 20U);
  CHECK(index.span_count(layers[199]) == 1);
  CHECK(index.span_count(layers[0]) >= 30);
  CHECK(index.span_count(layers[0]) <= 200);
  for (const std::int64_t f : std::vector<std::int64_t>{0, 1, 17'999, 18'000, 53'999}) CHECK(index.key(f) != 0);
  CHECK(index.key(54'000) == 0);

  // Edit the key at 600 s (frame 18,000) of layer 0: the frames that read it
  // are those whose key range reaches it — from two keys before (480 s) to two
  // keys after (720 s), a frame of reach and three of blur either side.
  const std::uint64_t before100 = index.key(100);
  const std::uint64_t before18000 = index.key(18'000);
  const std::uint64_t before30000 = index.key(30'000);
  const auto snapshot = snap_anim(h.session.document(), layers[0]);
  REQUIRE(is_ok(set_prop(h, layers[0], "transform/position", vec2(999, 0), at(600.0))));
  const doc::ChangeSet cs = anim_change(snapshot, h.session.document(), layers[0]);
  const doc::FrameKeyIndex::Delta delta = index.update(h.session.document(), h.session.view(), cs, "");
  REQUIRE_FALSE(delta.all);
  REQUIRE_FALSE(delta.frames.empty());
  // One contiguous run; its edges within a frame of [14,396, 21,604) (the
  // reach test at the edge is a sum of seconds, and may round either way).
  CHECK(delta.frames == range(delta.frames.front(), delta.frames.back() + 1));
  CHECK(delta.frames.front() >= 14'395);
  CHECK(delta.frames.front() <= 14'397);
  CHECK(delta.frames.back() + 1 >= 21'603);
  CHECK(delta.frames.back() + 1 <= 21'605);
  CHECK(index.key(100) == before100);
  CHECK(index.key(30'000) == before30000);
  CHECK(index.key(18'000) != before18000);
  CHECK(index.indexed());

  // A still layer's edit (its anim is still empty) changes nothing.
  const auto still = snap_anim(h.session.document(), layers[150]);
  const doc::FrameKeyIndex::Delta none = index.update(h.session.document(), h.session.view(), anim_change(still, h.session.document(), layers[150]), "");
  REQUIRE_FALSE(none.all);
  CHECK(none.frames.empty());
}

TEST_CASE("frame keys: a 60-minute comp at 60 fps indexes inside the smallest budget", "[keys][long]") {
  Harness h(64);
  (void)h.hello();
  const api::ItemId comp = make_comp(h, 60, 3600.0);
  std::vector<api::LayerId> layers;
  for (int i = 0; i < 5; ++i) layers.push_back(make_layer(h, comp));
  std::vector<double> times;
  for (int k = 0; k < 10; ++k) times.push_back(300.0 * k);
  add_keys(h, layers[0], "transform/opacity", times, false);

  doc::FrameKeyIndex index;
  index.set_budget_bytes(doc::FrameKeyIndex::kMinBudgetBytes);
  REQUIRE(index.rebuild(h.session.document(), h.session.view(), comp, ""));
  REQUIRE(index.frames() == 216'000);
  CHECK(index.bytes() < std::size_t{4} << 20U);  // the dense total: 216,000 × 8 = 1.7 MB
  CHECK(index.key(0) != 0);
  CHECK(index.key(215'999) != 0);
  CHECK(index.key(216'000) == 0);
  CHECK(index.key(0) != index.key(1));

  // Past the budget the comp is not indexed, and the comp's name stays (no retry per frame).
  doc::FrameKeyIndex small;
  small.set_budget_bytes(std::size_t{1} << 20U);
  CHECK_FALSE(small.rebuild(h.session.document(), h.session.view(), comp, ""));
  CHECK_FALSE(small.indexed());
  CHECK(small.comp() == comp);
  CHECK(small.key(0) == 0);
  CHECK(small.bytes() == 0);

  // The budget rule: 1 % of RAM inside [32 MB, 512 MB]; unknown RAM is the floor.
  CHECK(doc::FrameKeyIndex::budget_for(0) == doc::FrameKeyIndex::kMinBudgetBytes);
  CHECK(doc::FrameKeyIndex::budget_for(std::uint64_t{8} << 30U) == (std::size_t{8} << 30U) / 100U);
  CHECK(doc::FrameKeyIndex::budget_for(std::uint64_t{1} << 30U) == doc::FrameKeyIndex::kMinBudgetBytes);
  CHECK(doc::FrameKeyIndex::budget_for(std::uint64_t{1} << 40U) == doc::FrameKeyIndex::kMaxBudgetBytes);
}

TEST_CASE("frame keys: the spans give every frame the key the dense per-frame evaluation gives, through random edits", "[keys][long]") {
  Harness h(64);
  (void)h.hello();
  const api::ItemId comp = make_comp(h, 30, 20.0);
  std::mt19937 rng(7);
  std::uniform_real_distribution<double> secs(0.0, 20.0);
  std::uniform_int_distribution<int> keyCount(0, 8);
  std::uniform_int_distribution<int> coin(0, 9);
  std::vector<api::LayerId> layers;
  for (int i = 0; i < 10; ++i) {
    const api::LayerId l = make_layer(h, comp);
    layers.push_back(l);
    for (const auto& [prop, vec] : {std::pair{std::string("transform/position"), true}, std::pair{std::string("transform/opacity"), false}}) {
      std::vector<double> times;
      const int n = keyCount(rng);
      for (int k = 0; k < n; ++k) times.push_back(std::round(secs(rng) * 30.0) / 30.0);
      std::sort(times.begin(), times.end());
      times.erase(std::unique(times.begin(), times.end()), times.end());
      if (!times.empty()) add_keys(h, l, prop, times, vec);
    }
    if (coin(rng) < 4) {
      api::SetLayerTiming timing;
      api::LayerTimingPatch p;
      p.layer = l;
      p.in_point = at(1.0 + static_cast<double>(coin(rng)) * 0.4);
      p.out_point = at(10.0 + static_cast<double>(coin(rng)) * 0.9);
      p.start_time = at(static_cast<double>(coin(rng)) * 0.3);
      timing.items.push_back(p);
      REQUIRE(is_ok(h.run(cmd(timing))));
    }
    if (coin(rng) < 3) {
      api::TimeStretchLayers stretch;
      stretch.layers = {l};
      stretch.stretch = coin(rng) < 5 ? 2.0 : 0.5;
      REQUIRE(is_ok(h.run(cmd(stretch))));
    }
  }

  doc::FrameKeyIndex index;
  REQUIRE(index.rebuild(h.session.document(), h.session.view(), comp, ""));
  REQUIRE(index.frames() == 600);
  DenseReference dense;
  dense.build(index, h.session.document());
  REQUIRE(dense.layers.size() == 10);
  dense.check_keys(index);

  // Random edits: a key's value on a layer that has one, then the index's
  // delta is the dense diff and every key agrees again.
  int edits = 0;
  for (int step = 0; step < 40 && edits < 20; ++step) {
    const api::LayerId& l = layers[static_cast<std::size_t>(coin(rng))];
    const doc::NodeAnim* a = h.session.document().anim(l);
    if (a == nullptr || a->tracks.empty()) continue;
    std::vector<std::pair<std::string, double>> keys;
    for (const auto& [prop, track] : a->tracks) {
      for (const doc::Key& k : track) keys.emplace_back(prop, k.t);
    }
    if (keys.empty()) continue;
    const auto& [prop, t] = keys[static_cast<std::size_t>(rng() % keys.size())];
    const double v = 1000.0 + static_cast<double>(step);
    const auto snapshot = snap_anim(h.session.document(), l);
    // `t` is the key's LAYER time; setProperty takes comp time. On a shifted or
    // stretched layer that time can fall outside the comp or the layer, and the
    // engine refuses the edit (correctly): such a pick is skipped, not counted.
    // Stored tracks are member names ("x", "y", "opacity"); the command takes the property path.
    const bool member = prop == "x" || prop == "y";
    const std::string path = member ? "transform/position" : prop == "opacity" ? "transform/opacity" : prop;
    const api::Response r = set_prop(h, l, path, member ? vec2(v, 0) : scalar(prop == "opacity" ? 50.0 + step : v), at(t));
    if (!is_ok(r)) {
      UNSCOPED_INFO("refused " << prop << " at " << t << ": " << std::get<api::EngineError>(r.outcome.v).message);
      continue;
    }
    ++edits;
    const doc::FrameKeyIndex::Delta delta =
        index.update(h.session.document(), h.session.view(), anim_change(snapshot, h.session.document(), l), "");
    REQUIRE(index.indexed());
    const std::vector<std::int64_t> expected = dense.rerow(index, h.session.document(), l);
    CAPTURE(step, l, prop, t);
    if (expected.size() >= 600) {
      CHECK(delta.all);
    } else {
      REQUIRE_FALSE(delta.all);
      CHECK(delta.frames == expected);
    }
    dense.check_keys(index);
  }
  REQUIRE(edits >= 10);

  // From scratch again: the same document gives the same keys.
  doc::FrameKeyIndex again;
  REQUIRE(again.rebuild(h.session.document(), h.session.view(), comp, ""));
  for (std::int64_t f = 0; f < 600; ++f) REQUIRE(again.key(f) == index.key(f));
}

TEST_CASE("hash_json walks the value with the stringify rules", "[frame-keys]") {
  const auto h = [](std::string_view text) { return doc::frame_keys::hash_json(*js::parse(text)); };
  const auto with = [](js::Json o, const char* key, js::Json v) {
    o.set(key, std::move(v));
    return doc::frame_keys::hash_json(o);
  };
  // Equal values hash alike; any change of a value, key, order or type changes the hash.
  CHECK(h(R"({"a":1,"b":[1,2,{"c":"x"}]})") == h(R"({"a":1,"b":[1,2,{"c":"x"}]})"));
  CHECK(h(R"({"a":1})") != h(R"({"a":2})"));
  CHECK(h(R"({"a":1})") != h(R"({"b":1})"));
  CHECK(h(R"({"a":1,"b":2})") != h(R"({"b":2,"a":1})"));
  CHECK(h(R"([1,2])") != h(R"([2,1])"));
  CHECK(h(R"({"a":"1"})") != h(R"({"a":1})"));
  CHECK(h(R"([[1],[]])") != h(R"([[],[1]])"));
  CHECK(h(R"({"a":0})") == h(R"({"a":-0})"));
  // What stringify drops or prints as null hashes so too.
  const js::Json base = *js::parse(R"({"a":1})");
  CHECK(with(base, "u", js::Json()) == h(R"({"a":1})"));
  CHECK(with(base, "n", js::Json::number(std::nan(""))) == h(R"({"a":1,"n":null})"));
  js::Json arr = js::Json::array();
  arr.arr_mut().emplace_back();
  CHECK(doc::frame_keys::hash_json(arr) == h("[null]"));
}

TEST_CASE("frame keys: a static edit re-keys only the frames its layer draws; a non-rendering edit re-keys none", "[keys]") {
  Harness h(64);
  (void)h.hello();
  const api::ItemId comp = make_comp(h, 30, 10.0);
  const api::LayerId trimmed = make_layer(h, comp);
  const api::LayerId full = make_layer(h, comp);
  api::SetLayerTiming timing;
  api::LayerTimingPatch patch;
  patch.layer = trimmed;
  patch.in_point = at(2.0);
  patch.out_point = at(4.0);
  timing.items.push_back(patch);
  REQUIRE(is_ok(h.run(cmd(timing))));

  doc::FrameKeyIndex index;
  REQUIRE(index.rebuild(h.session.document(), h.session.view(), comp, ""));
  REQUIRE(index.indexed());
  const std::uint64_t before0 = index.key(0);
  const std::uint64_t before90 = index.key(90);
  const std::uint64_t before200 = index.key(200);

  // Opacity of the layer that draws from 2 s to 4 s: frames 60..119, plus the motion-blur window.
  const doc::Document& d = h.session.document();
  const auto node = std::make_shared<doc::Node>(*d.node(trimmed));
  REQUIRE(is_ok(set_prop(h, trimmed, "transform/opacity", scalar(50), 0)));
  doc::ChangeSet cs;
  cs.before.nodes[trimmed] = node;
  cs.after.nodes[trimmed] = std::make_shared<doc::Node>(*h.session.document().node(trimmed));
  cs.before.anims[trimmed] = snap_anim(h.session.document(), trimmed);
  cs.after.anims[trimmed] = snap_anim(h.session.document(), trimmed);
  const doc::FrameKeyIndex::Delta delta = index.update(h.session.document(), h.session.view(), cs, "");
  REQUIRE_FALSE(delta.all);
  REQUIRE_FALSE(delta.frames.empty());
  CHECK(delta.frames.front() >= 50);
  CHECK(delta.frames.back() <= 130);
  CHECK(index.key(0) == before0);
  CHECK(index.key(200) == before200);
  CHECK(index.key(90) != before90);

  // The guides part changed (they never draw): nothing to re-render.
  doc::ChangeSet guides;
  guides.before.guides = std::make_shared<js::Json>(js::Json::object());
  guides.after.guides = std::make_shared<js::Json>(js::Json::object());
  const doc::FrameKeyIndex::Delta none = index.update(h.session.document(), h.session.view(), guides, "");
  REQUIRE_FALSE(none.all);
  CHECK(none.frames.empty());
  (void)full;
}
