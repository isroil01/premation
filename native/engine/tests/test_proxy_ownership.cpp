// Proxy ownership (src/core/engine/proxyOwnership.ts, proxySubtree.test.ts):
// an edit whose origin is not `plugin` that changes an existing layer marked
// `__ownedByPlugin` clears the mark on every owned layer under its proxy
// layer, inside the same command — one undo entry, undo re-attaches. A
// plugin's own write never detaches.

#include <catch2/catch_test_macros.hpp>

#include <string>
#include <utility>

#include "session_harness.hpp"

using namespace premation;
using namespace premation::test;

namespace {

constexpr api::Time kSec = 705'600'000;

api::Response run_as(Harness& h, api::Command c, api::Origin origin) {
  api::Request req;
  req.seq = ++h.seq;
  req.origin = origin;
  req.body.v = std::move(c);
  api::EngineMessage m;
  m.v = std::move(req);
  const std::size_t before = h.messages.size();
  h.feed(m);
  for (std::size_t i = before; i < h.messages.size(); ++i) {
    if (h.messages[i].kind() != api::EngineMessage::Kind::response) continue;
    const auto& r = std::get<api::Response>(h.messages[i].v);
    if (r.seq == h.seq) return r;
  }
  return {};
}

bool owned(Harness& h, const api::LayerId& id) {
  const doc::Node* n = h.session.document().node(id);
  REQUIRE(n != nullptr);
  for (const auto& c : n->components) {
    if (c.props.at("__ownedByPlugin").is_string()) return true;
  }
  return false;
}

struct Proxy {
  api::ItemId comp;
  api::LayerId layer;
  api::LayerId a;
  api::LayerId b;
};

/// A null "proxy layer" with two generated shape children pasted by the plugin (marked owned).
Proxy make_proxy(Harness& h) {
  api::CreateComposition cc;
  cc.settings.name = "Proxy";
  cc.settings.width = 1920;
  cc.settings.height = 1080;
  cc.settings.frame_rate = api::Rational{30, 1};
  cc.settings.duration = 10 * kSec;
  const auto rc = h.run(cmd(cc));
  REQUIRE(is_ok(rc));
  Proxy p;
  p.comp = result_item(rc);
  auto make = [&](api::LayerKind kind) {
    api::CreateLayer c;
    c.comp = p.comp;
    c.kind = kind;
    const auto r = h.run(cmd(c));
    REQUIRE(is_ok(r));
    return result_layer(r);
  };
  p.layer = make(api::LayerKind::null);
  const auto seed = make(api::LayerKind::shape);
  api::CopyLayers q;
  q.layers = {seed};
  const auto res = h.ask(qry(q));
  REQUIRE(is_ok(res));
  api::DocumentFragment frag = std::get<api::DocumentFragment>(std::get<api::QueryResult>(res.outcome.v).v);
  std::string text(frag.data.begin(), frag.data.end());
  const auto t = text.find("\"Transform\"");
  REQUIRE(t != std::string::npos);
  const std::string props = "\"props\":{";
  const auto at = text.find(props, t);
  REQUIRE(at != std::string::npos);
  text.insert(at + props.size(), "\"__ownedByPlugin\":\"studio.acme.lab\",");
  frag.data.assign(text.begin(), text.end());
  api::DeleteLayers del;
  del.layers = {seed};
  REQUIRE(is_ok(h.run(cmd(del))));
  auto paste = [&]() {
    api::PasteLayers pl;
    pl.comp = p.comp;
    pl.fragment = frag;
    pl.parent = p.layer;
    const auto r = run_as(h, cmd(pl), api::Origin::plugin);
    REQUIRE(is_ok(r));
    return result_as<api::LayerList>(r).layers.at(0);
  };
  p.a = paste();
  p.b = paste();
  REQUIRE(owned(h, p.a));
  REQUIRE(owned(h, p.b));
  return p;
}

api::Command rename(const api::LayerId& id, std::string name) {
  api::RenameLayer r;
  r.layer = id;
  r.name = std::move(name);
  return cmd(r);
}

}  // namespace

TEST_CASE("a user edit of a generated child detaches the whole proxy subtree, in the same command") {
  Harness h;
  h.hello();
  const Proxy p = make_proxy(h);
  const auto entries = [&]() {
    const auto r = h.ask(qry(api::GetHistory{}));
    REQUIRE(is_ok(r));
    return std::get<api::HistoryState>(std::get<api::QueryResult>(r.outcome.v).v).entries.size();
  };
  const std::size_t before = entries();
  REQUIRE(is_ok(h.run(rename(p.a, "Mine"))));
  CHECK_FALSE(owned(h, p.a));
  CHECK_FALSE(owned(h, p.b));  // the sibling too: never half-owned
  CHECK(entries() == before + 1);
  // Written null (as the TypeScript does), not removed.
  CHECK(h.session.document().node(p.b)->comp("Transform")->props.at("__ownedByPlugin").is_null());
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  CHECK(owned(h, p.a));
  CHECK(owned(h, p.b));
}

TEST_CASE("a plugin's own write and an edit of the proxy layer itself do not detach") {
  Harness h;
  h.hello();
  const Proxy p = make_proxy(h);
  REQUIRE(is_ok(run_as(h, rename(p.a, "By the plugin"), api::Origin::plugin)));
  CHECK(owned(h, p.a));
  CHECK(owned(h, p.b));
  REQUIRE(is_ok(h.run(rename(p.layer, "The proxy layer"))));
  CHECK(owned(h, p.a));
  CHECK(owned(h, p.b));
}
