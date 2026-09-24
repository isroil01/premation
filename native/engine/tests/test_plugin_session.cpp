// Native plugins through the engine API (G1): what the UI does, over the real
// protocol (session_harness.hpp encodes every request and decodes every reply).
// The host is attached to the document registry exactly as premation-engine
// attaches it at start.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <filesystem>
#include <string>
#include <vector>

#include "host.hpp"
#include "native_effects.hpp"
#include "session_harness.hpp"

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
