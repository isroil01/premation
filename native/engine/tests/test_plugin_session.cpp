// Native plugins through the engine API (G1): what the UI does, over the real
// protocol (session_harness.hpp encodes every request and decodes every reply).
// The host is attached to the document registry exactly as premation-engine
// attaches it at start.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <optional>
#include <filesystem>
#include <string>
#include <vector>

#include "anim.hpp"
#include "host.hpp"
#include "native_effects.hpp"
#include "session_harness.hpp"
#include "values.hpp"

using namespace premation;
using namespace premation::test;
namespace pl = premation::plugins;

namespace {

constexpr const char* kRings = "com.premation.samples.rings";
constexpr const char* kRipple = "com.premation.samples.ripple";

pl::HostOptions attached() {
  pl::HostOptions o;
  o.searchPaths = {std::filesystem::path(PREMATION_PLUGIN_BUNDLES)};
  o.threads = 2;
  o.attachToDocument = true;
  return o;
}

template <class T>
T query(Harness& h, api::Query q) {
  const auto r = h.ask(std::move(q));
  REQUIRE(is_ok(r));
  return std::get<T>(std::get<api::QueryResult>(r.outcome.v).v);
}

api::LayerId solid(Harness& h) {
  api::CreateComposition c;
  c.settings.name = "Plugins";
  c.settings.width = 320;
  c.settings.height = 180;
  c.settings.frame_rate = api::Rational{30, 1};
  c.settings.duration = 705'600'000LL * 2;
  const auto rc = h.run(cmd(c));
  REQUIRE(is_ok(rc));
  api::CreateLayer l;
  l.comp = result_item(rc);
  l.kind = api::LayerKind::solid;
  const auto rl = h.run(cmd(l));
  REQUIRE(is_ok(rl));
  return result_layer(rl);
}

/// The instance's flat sequence data as the document stores it (base64), or "".
std::string stored_sequence(Harness& h, const api::LayerId& layer, const std::string& effectPath) {
  const doc::Node* n = h.session.document().node(layer);
  REQUIRE(n != nullptr);
  const auto& v = n->fx().at("pluginData").at(effectPath).at("sequence");
  return v.is_string() ? v.str() : std::string();
}

}  // namespace

TEST_CASE("plugins in the session: list, add, act, UI state, undo", "[plugins][session]") {
  pl::PluginHost host(attached());
  host.scan();
  Harness h;
  (void)h.hello();

  // listPlugins: what the plugin manager shows.
  const auto list = query<api::PluginList>(h, qry(api::ListPlugins{}));
  for (const char* id : {"com.premation.samples.rings", "com.premation.samples.ripple", "com.premation.samples.checkout"}) {
    const auto it = std::ranges::find_if(list.plugins, [&](const api::PluginInfo& p) { return p.id == id; });
    REQUIRE(it != list.plugins.end());
    CHECK(it->status == api::PluginStatus::loaded);
    CHECK_FALSE(it->effects.empty());
  }

  // listEffects: plugin effects sit in the catalog beside the builtins, provider = the plugin.
  api::ListEffects le;
  const auto catalog = query<api::EffectCatalog>(h, qry(le));
  const auto rings = std::ranges::find_if(catalog.effects, [](const api::EffectInfo& e) { return e.match_name == kRings; });
  REQUIRE(rings != catalog.effects.end());
  CHECK(rings->provider == "com.premation.samples.rings");

  const api::LayerId layer = solid(h);
  api::AddEffect add;
  add.layers = {layer};
  add.effect = kRings;
  const auto ra = h.run(cmd(add));
  REQUIRE(is_ok(ra));
  const std::string fxPath = result_as<api::GroupList>(ra).groups.at(0);
  // O3: the instance records its plugin's version.
  {
    const doc::Node* n = h.session.document().node(layer);
    REQUIRE(n != nullptr);
    const std::vector<js::Json> fx = doc::read_node_effects(*n);
    REQUIRE_FALSE(fx.empty());
    REQUIRE(fx.back().at("pluginVersion").is_string());
    CHECK(fx.back().at("pluginVersion").str() == "1.0.0");
  }
  // addEffect stored the instance's initial sequence data (SEQUENCE_SETUP → FLATTEN) in the document.
  const std::string initial = stored_sequence(h, layer, fxPath);
  REQUIRE_FALSE(initial.empty());

  // getEffectUi: the Inspector's param state.
  api::GetEffectUi ui;
  ui.layer = layer;
  ui.effect = fxPath;
  const auto state = query<api::EffectUi>(h, qry(ui));
  const auto shuffle = std::ranges::find_if(state.params, [](const api::EffectParamUi& p) { return p.key == "p8"; });
  REQUIRE(shuffle != state.params.end());
  CHECK(shuffle->name == "Shuffle Palette");
  CHECK(shuffle->enabled);

  // The Shuffle Palette button: one undoable entry that rewrites the sequence data.
  api::InvokeEffectAction act;
  act.group = {layer, fxPath};
  act.action = "p8";
  const auto rv = h.run(cmd(act));
  REQUIRE(is_ok(rv));
  const std::string shuffled = stored_sequence(h, layer, fxPath);
  CHECK(shuffled != initial);
  const auto hist = query<api::HistoryState>(h, qry(api::GetHistory{}));
  REQUIRE_FALSE(hist.entries.empty());
  CHECK(hist.entries.at(hist.position - 1).label == "Shuffle Palette");
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  CHECK(stored_sequence(h, layer, fxPath) == initial);
  REQUIRE(is_ok(h.run(cmd(api::Redo{}))));
  CHECK(stored_sequence(h, layer, fxPath) == shuffled);

  // A button the effect does not have, and a builtin effect's "action", are refused.
  act.action = "p99";
  CHECK(is_error(h.run(cmd(act)), api::ErrorCode::not_found));

  // A disabled plugin's effect cannot be added (existing instances keep resolving).
  api::SetPluginEnabled off;
  off.plugin = "com.premation.samples.ripple";
  off.enabled = false;
  REQUIRE(is_ok(h.run(cmd(off))));
  add.effect = kRipple;
  CHECK(is_error(h.run(cmd(add)), api::ErrorCode::not_found));
  off.enabled = true;
  REQUIRE(is_ok(h.run(cmd(off))));
  CHECK(is_ok(h.run(cmd(add))));
  api::SetPluginEnabled nope;
  nope.plugin = "com.example.missing";
  nope.enabled = true;
  CHECK(is_error(h.run(cmd(nope)), api::ErrorCode::not_found));
}

TEST_CASE("plugins in the session: no host — an empty list and builtin effect UIs", "[plugins][session]") {
  doc::NativeEffects::clear_handlers();
  Harness h;
  (void)h.hello();
  CHECK(query<api::PluginList>(h, qry(api::ListPlugins{})).plugins.empty());
  const api::LayerId layer = solid(h);
  api::AddEffect add;
  add.layers = {layer};
  add.effect = "glow";
  const auto ra = h.run(cmd(add));
  REQUIRE(is_ok(ra));
  api::GetEffectUi ui;
  ui.layer = layer;
  ui.effect = result_as<api::GroupList>(ra).groups.at(0);
  const auto state = query<api::EffectUi>(h, qry(ui));
  REQUIRE_FALSE(state.params.empty());
  CHECK(std::ranges::all_of(state.params, [](const api::EffectParamUi& p) { return p.enabled && !p.hidden; }));
  ui.effect = "effects/nope";
  CHECK(is_error(h.ask(qry(ui)), api::ErrorCode::not_found));
}

TEST_CASE("plugins in the session: colours round-trip through linear light (SDK 1.2)", "[plugins][session][color]") {
  // A COLOR param reaches the plugin decoded to linear light and a set_param_value of it is encoded
  // back: rings' Swap Colors writes what it read, so each document colour must be exactly the
  // other's afterwards — an identity round trip, not a gamma drift.
  pl::PluginHost host(attached());
  host.scan();
  Harness h;
  (void)h.hello();
  const api::LayerId layer = solid(h);
  api::AddEffect add;
  add.layers = {layer};
  add.effect = kRings;
  const auto ra = h.run(cmd(add));
  REQUIRE(is_ok(ra));
  const std::string fxPath = result_as<api::GroupList>(ra).groups.at(0);
  const auto set = [&](const char* key, double r, double g, double b) {
    api::SetProperty sp;
    sp.prop = {layer, fxPath + "/" + key};
    sp.value = doc::v_color(r, g, b, 1);
    REQUIRE(is_ok(h.run(cmd(sp))));
  };
  const auto get = [&](const char* key) {
    api::GetPropertyValues q;
    q.props = {{layer, fxPath + "/" + key}};
    q.time = 0;
    const auto v = query<api::PropertyValues>(h, qry(q));
    REQUIRE(v.values.size() == 1);
    return std::get<api::Color>(v.values[0].value.v);
  };
  set("p5", 0.8, 0.4, 0.2);       // #cc6633
  set("p6", 0.1, 0.5, 0.9);       // #1a80e6
  const api::Color a0 = get("p5");
  const api::Color b0 = get("p6");
  api::InvokeEffectAction act;
  act.group = {layer, fxPath};
  act.action = "p10";  // Swap Colors (hidden, supervised)
  REQUIRE(is_ok(h.run(cmd(act))));
  const api::Color a1 = get("p5");
  const api::Color b1 = get("p6");
  CHECK(a1.r == b0.r);
  CHECK(a1.g == b0.g);
  CHECK(a1.b == b0.b);
  CHECK(b1.r == a0.r);
  CHECK(b1.g == a0.g);
  CHECK(b1.b == a0.b);
  // And back: still exact.
  REQUIRE(is_ok(h.run(cmd(act))));
  const api::Color a2 = get("p5");
  CHECK(a2.r == a0.r);
  CHECK(a2.g == a0.g);
  CHECK(a2.b == a0.b);
}

TEST_CASE("plugins in the session: a curve / gradient param keyframes as one value (SDK 1.4 E3)", "[plugins][session][compound]") {
  pl::PluginHost host(attached());
  host.scan();
  host.publish_expression_functions();
  Harness h;
  (void)h.hello();
  const api::LayerId layer = solid(h);
  api::AddEffect add;
  add.layers = {layer};
  add.effect = "com.premation.samples.grademap";
  const auto ra = h.run(cmd(add));
  REQUIRE(is_ok(ra));
  const std::string fxPath = result_as<api::GroupList>(ra).groups.at(0);
  const std::string effectId = fxPath.substr(fxPath.rfind('/') + 1);

  // Two keys of the Gradient (p3), the first eased by the mathfns plugin's compound interpolator.
  api::AddKeyframes a;
  api::KeyframeInsert k0;
  k0.prop = {layer, fxPath + "/p3"};
  k0.time = 0;
  k0.value = doc::v_json("[[0,0,0,0,1],[1,1,1,1,1]]");
  k0.interpolator = "com.premation.samples.mathfns:smoothblend";
  api::KeyframeInsert k1 = k0;
  k1.time = 705'600'000LL;  // 1 s
  k1.value = doc::v_json("[[0.5,0,0,0,1],[1,1,1,1,1]]");
  k1.interpolator.reset();
  a.keys = {k0, k1};
  REQUIRE(is_ok(h.run(cmd(a))));

  const doc::DataTrack* tr = doc::anim_data_track(h.session.document(), layer, doc::compound_param_track(effectId, "p3"));
  REQUIRE(tr != nullptr);
  CHECK(tr->kind == "numbers");
  REQUIRE(tr->keys.size() == 2);
  CHECK(tr->keys[0].interp == std::optional<std::string>("com.premation.samples.mathfns:smoothblend"));

  // getKeyframes reports the interpolator; the halfway value is the plugin's smoothstep blend.
  api::GetKeyframes gk;
  gk.props = {{layer, fxPath + "/p3"}};
  const auto kr = h.ask(qry(gk));
  REQUIRE(is_ok(kr));
  const api::KeyframeSets keys = result_as<api::KeyframeSets>(std::get<api::QueryResult>(kr.outcome.v));
  REQUIRE_FALSE(keys.sets.empty());
  REQUIRE(keys.sets[0].keyframes.size() == 2);
  CHECK(keys.sets[0].keyframes[0].interpolator == std::optional<std::string>("com.premation.samples.mathfns:smoothblend"));
  const auto at = doc::sample_data_track(*tr, 0.25);
  REQUIRE(at.has_value());
  CHECK(std::abs(at->arr()[0].arr()[0].num() - 0.5 * 0.15625) < 1e-12);  // smoothstep(0.25) = 0.15625

  // Undo takes both keys away.
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  CHECK(doc::anim_data_track(h.session.document(), layer, doc::compound_param_track(effectId, "p3")) == nullptr);
}

TEST_CASE("audio effect params are keyframeable layer properties (SDK 1.4 A2)", "[plugins][session][audiofx]") {
  Harness h;
  (void)h.hello();
  api::CreateComposition outer;
  outer.settings.name = "Host";
  outer.settings.width = 64;
  outer.settings.height = 64;
  outer.settings.frame_rate = api::Rational{30, 1};
  outer.settings.duration = 705'600'000LL * 2;
  const auto ro = h.run(cmd(outer));
  REQUIRE(is_ok(ro));
  api::CreateComposition inner;
  inner.settings.name = "Inner";
  inner.settings.width = 64;
  inner.settings.height = 64;
  inner.settings.frame_rate = api::Rational{30, 1};
  inner.settings.duration = 705'600'000LL * 2;
  const auto ri = h.run(cmd(inner));
  REQUIRE(is_ok(ri));
  api::CreateLayer pre;
  pre.comp = result_item(ro);
  pre.kind = api::LayerKind::precomp;
  pre.source = result_item(ri);
  const auto rp = h.run(cmd(pre));
  REQUIRE(is_ok(rp));
  const api::LayerId layer = result_layer(rp);

  api::SetProperty chain;
  chain.prop = {layer, "audio/effects"};
  chain.value = doc::v_json(R"([{"id":"fx1","type":"stereo-mixer","params":{"leftLevel":100,"leftPan":0}},{"id":"fx2","type":"clap:com.premation.samples.clapgain","params":{"p1":-6}}])");
  REQUIRE(is_ok(h.run(cmd(chain))));
  // Every numeric param is a property, built-in and CLAP alike.
  api::GetPropertyTree tree;
  tree.layer = layer;
  tree.path = "audio";
  tree.depth = 8;
  const auto rt = h.ask(qry(tree));
  REQUIRE(is_ok(rt));
  const auto& nodes = result_as<api::PropertyTree>(std::get<api::QueryResult>(rt.outcome.v)).nodes;
  const auto has = [&](std::string_view path) { return std::ranges::any_of(nodes, [&](const api::PropertyInfo& p) { return p.path == path; }); };
  CHECK(has("audio/fx/fx1/leftLevel"));
  CHECK(has("audio/fx/fx2/p1"));
  // A static write lands in the chain's json.
  api::SetProperty level;
  level.prop = {layer, "audio/fx/fx1/leftLevel"};
  level.value = doc::v_scalar(50);
  REQUIRE(is_ok(h.run(cmd(level))));
  const auto& stored = h.session.document().node(layer)->fx().at("audioEffects");
  REQUIRE(stored.is_array());
  CHECK(stored.arr()[0].at("params").at("leftLevel").num() == 50);
  // Keyframes go on the track the mixer reads.
  api::AddKeyframes a;
  for (const auto& [t, v] : std::vector<std::pair<api::Time, double>>{{0, 0.0}, {705'600'000LL, 100.0}}) {
    api::KeyframeInsert k;
    k.prop = {layer, "audio/fx/fx2/p1"};
    k.time = t;
    k.value = doc::v_scalar(v);
    a.keys.push_back(std::move(k));
  }
  REQUIRE(is_ok(h.run(cmd(a))));
  CHECK(doc::anim_track(h.session.document(), layer, "audiofx.fx2.p1") != nullptr);
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  CHECK(doc::anim_track(h.session.document(), layer, "audiofx.fx2.p1") == nullptr);
}

TEST_CASE("setPluginIsolation pins where a plugin runs (SDK 1.4 X2)", "[plugins][session][isolation]") {
  pl::PluginHost host(attached());
  host.scan();
  Harness h;
  (void)h.hello();
  const auto info = [&](const char* id) {
    const auto list = query<api::PluginList>(h, qry(api::ListPlugins{})).plugins;
    const auto it = std::ranges::find_if(list, [&](const api::PluginInfo& p) { return p.id == id; });
    REQUIRE(it != list.end());
    return *it;
  };
  CHECK(info(kRings).isolation == "engine");
  CHECK(info(kRings).isolation_pin.empty());
  api::SetPluginIsolation pin;
  pin.plugin = kRings;
  pin.mode = "engine";
  REQUIRE(is_ok(h.run(cmd(pin))));
  CHECK(info(kRings).isolation_pin == "engine");
  CHECK(info(kRings).status == api::PluginStatus::loaded);
  // "auto" (or anything else) clears the pin.
  pin.mode = "auto";
  REQUIRE(is_ok(h.run(cmd(pin))));
  CHECK(info(kRings).isolation_pin.empty());
  pin.plugin = "com.example.missing";
  CHECK(is_error(h.run(cmd(pin)), api::ErrorCode::not_found));
}
