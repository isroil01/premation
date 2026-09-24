// B3 paths (src/core/engine/__tests__/pathsB3.test.ts): a shape layer's
// `layer/path.points` path value, BezierPath.vertexStates, the RotoBezier
// switches, a light's latent Point of Interest, `editPathTopology` and
// `setShapeOutline` — each one exact undo / redo, same semantics as the
// TypeScript engine.

#include <catch2/catch_test_macros.hpp>

#include <string>

#include "invariants.hpp"
#include "session_harness.hpp"

using namespace premation;
using namespace premation::test;
using premation::doc::Json;

namespace {

constexpr api::Time kSec = 705'600'000;

api::ItemId make_comp(Harness& h) {
  api::CreateComposition c;
  c.settings.name = "Paths";
  c.settings.width = 1920;
  c.settings.height = 1080;
  c.settings.frame_rate = api::Rational{30, 1};
  c.settings.duration = 10 * kSec;
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  return result_item(r);
}

api::LayerId make_layer(Harness& h, const api::ItemId& comp, api::LayerKind kind) {
  api::CreateLayer c;
  c.comp = comp;
  c.kind = kind;
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  return result_layer(r);
}

api::BezierPath tri(double k, bool closed = true) {
  api::BezierPath b;
  b.vertices = {0, -k, k, k, -k, k};
  b.in_tangents = {0, 0, 0, 0, 0, 0};
  b.out_tangents = {0, 0, 0, 0, 0, 0};
  b.closed = closed;
  return b;
}

api::Value path_value(api::BezierPath b) {
  api::Value v;
  v.v = std::move(b);
  return v;
}

/// A drawn path layer: a `path` layer whose Geometry holds the Pen's points
/// (copied out and pasted back with the points written into the fragment).
api::LayerId drawn_path(Harness& h, const api::ItemId& comp) {
  const auto seed = make_layer(h, comp, api::LayerKind::path);
  api::CopyLayers q;
  q.layers = {seed};
  const auto res = h.ask(qry(q));
  REQUIRE(is_ok(res));
  api::DocumentFragment frag = std::get<api::DocumentFragment>(std::get<api::QueryResult>(res.outcome.v).v);
  std::string text(frag.data.begin(), frag.data.end());
  const std::string empty = "\"points\":[]";
  const auto at = text.find(empty);
  REQUIRE(at != std::string::npos);
  text.replace(at, empty.size(),
               R"("points":[{"x":0,"y":-10,"inX":0,"inY":-10,"outX":0,"outY":-10},)"
               R"({"x":10,"y":10,"inX":10,"inY":10,"outX":10,"outY":10},)"
               R"({"x":-10,"y":10,"inX":-10,"inY":10,"outX":-10,"outY":10}])");
  frag.data.assign(text.begin(), text.end());
  api::PasteLayers p;
  p.comp = comp;
  p.fragment = frag;
  const auto pr = h.run(cmd(p));
  REQUIRE(is_ok(pr));
  return result_as<api::LayerList>(pr).layers.at(0);
}

const Json& geometry(Harness& h, const api::LayerId& id) { return h.session.document().node(id)->comp("Geometry")->props; }

/// Run, then check an exact undo and a redo that lands on the same document.
void exact(Harness& h, const api::Command& c) {
  const DocState before = state_of(h.session.document());
  const auto r = h.run(c);
  INFO((is_ok(r) ? std::string("ok") : std::string(api::to_string(std::get<api::EngineError>(r.outcome.v).code))));
  REQUIRE(is_ok(r));
  const DocState after = state_of(h.session.document());
  REQUIRE_FALSE(after == before);
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  INFO(first_difference(state_of(h.session.document()), before));
  REQUIRE(state_of(h.session.document()) == before);
  REQUIRE(is_ok(h.run(cmd(api::Redo{}))));
  REQUIRE(state_of(h.session.document()) == after);
}

void refused(Harness& h, const api::Command& c, api::ErrorCode code) {
  const DocState before = state_of(h.session.document());
  REQUIRE(is_error(h.run(c), code));
  REQUIRE(state_of(h.session.document()) == before);
}

api::Command set_prop(const api::LayerId& layer, const std::string& path, api::Value v, std::optional<api::Time> t = std::nullopt) {
  api::SetProperty s;
  s.prop = {layer, path};
  s.value = std::move(v);
  s.time = t;
  return cmd(s);
}

}  // namespace

TEST_CASE("paths: a shape's outline is a path value with each vertex's editing state", "[session][paths]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto d = drawn_path(h, comp);
  api::BezierPath b = tri(20, false);
  b.vertex_states = {api::PathVertexState{1, true, 0.5}};
  exact(h, set_prop(d, "layer/path.points", path_value(b)));
  const Json& p1 = geometry(h, d).at("points").arr()[1];
  CHECK(p1.at("x").num() == 20);
  CHECK(p1.at("broken").b());
  CHECK(p1.at("tension").num() == 0.5);
  CHECK(geometry(h, d).at("open").b());
  // An empty list keeps the states by index; a feather or a bad tension is refused.
  REQUIRE(is_ok(h.run(set_prop(d, "layer/path.points", path_value(tri(30, false))))));
  CHECK(geometry(h, d).at("points").arr()[1].at("broken").b());
  api::BezierPath feathered = tri(30, false);
  feathered.feather_points = {api::FeatherPoint{0, 0, 4, 0}};
  refused(h, set_prop(d, "layer/path.points", path_value(feathered)), api::ErrorCode::unsupported);
  api::BezierPath tense = tri(30, false);
  tense.vertex_states = {api::PathVertexState{0, false, 2.0}};
  refused(h, set_prop(d, "layer/path.points", path_value(tense)), api::ErrorCode::out_of_range);

  // The stopwatch keys path.points; a key's closed state is the whole outline's.
  api::SetAnimated on;
  on.prop = {d, "layer/path.points"};
  on.animated = true;
  on.time = 0;
  exact(h, cmd(on));
  exact(h, set_prop(d, "layer/path.points", path_value(tri(40, true)), kSec));
  CHECK_FALSE(geometry(h, d).at("open").b());
  api::SetAnimated off = on;
  off.animated = false;
  off.time = kSec;
  exact(h, cmd(off));
  CHECK(geometry(h, d).at("points").arr()[1].at("x").num() == 40);
}

TEST_CASE("paths: mask RotoBezier, the Geometry fields and a light's Point of Interest", "[session][paths]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto a = make_layer(h, comp, api::LayerKind::solid);
  api::AddMask m;
  m.layer = a;
  m.path = tri(50);
  const auto mr = h.run(cmd(m));
  REQUIRE(is_ok(mr));
  const std::string maskPath = result_as<api::GroupList>(mr).groups.at(0);
  api::SetAnimated on;
  on.prop = {a, maskPath + "/path"};
  on.animated = true;
  on.time = 0;
  REQUIRE(is_ok(h.run(cmd(on))));
  REQUIRE(is_ok(h.run(set_prop(a, maskPath + "/path", path_value(tri(80)), kSec))));
  exact(h, set_prop(a, maskPath + "/rotoBezier", doc::v_bool(true)));

  const auto d = drawn_path(h, comp);
  exact(h, set_prop(d, "layer/pathRotoBezier", doc::v_bool(true)));
  CHECK(geometry(h, d).at("rotoBezier").b());
  exact(h, set_prop(d, "layer/pointBindings", doc::v_json(R"([{"index":0,"nullId":"x"}])")));

  const auto l = make_layer(h, comp, api::LayerKind::light);
  exact(h, set_prop(l, "light/poiX", scalar(320)));
}

TEST_CASE("paths: editPathTopology replays a structural edit on every state", "[session][paths]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto a = make_layer(h, comp, api::LayerKind::solid);
  api::AddMask m;
  m.layer = a;
  m.path = tri(50);
  const auto mr = h.run(cmd(m));
  REQUIRE(is_ok(mr));
  const api::PropRef mask{a, result_as<api::GroupList>(mr).groups.at(0) + "/path"};
  api::SetAnimated on;
  on.prop = mask;
  on.animated = true;
  on.time = 0;
  REQUIRE(is_ok(h.run(cmd(on))));
  REQUIRE(is_ok(h.run(set_prop(a, mask.path, path_value(tri(80)), kSec))));

  api::EditPathTopology split;
  split.prop = mask;
  split.op = api::PathTopologyOp{};
  split.op->kind = api::PathTopologyKind::insert;
  split.op->segment = 0;
  split.op->u = 0.5;
  exact(h, cmd(split));
  api::GetKeyframes gk;
  gk.props = {mask};
  const auto keys = h.ask(qry(gk));
  REQUIRE(is_ok(keys));
  for (const auto& k : std::get<api::KeyframeSets>(std::get<api::QueryResult>(keys.outcome.v).v).sets.at(0).keyframes) {
    CHECK(std::get<api::BezierPath>(k.value.v).vertices.size() == 8);
  }
  api::EditPathTopology open;
  open.prop = mask;
  open.closed = false;
  exact(h, cmd(open));

  // A shape: Set First Vertex + Continue Path, refusals.
  const auto d = drawn_path(h, comp);
  const api::PropRef shape{d, "layer/path.points"};
  api::EditPathTopology first;
  first.prop = shape;
  first.op = api::PathTopologyOp{};
  first.op->kind = api::PathTopologyKind::first_vertex;
  first.op->indices = {2};
  exact(h, cmd(first));
  CHECK(geometry(h, d).at("points").arr()[0].at("x").num() == -10);
  api::EditPathTopology extend;
  extend.prop = shape;
  extend.op = api::PathTopologyOp{};
  extend.op->kind = api::PathTopologyKind::extend;
  extend.op->points = tri(5, false);
  extend.closed = false;
  exact(h, cmd(extend));
  CHECK(geometry(h, d).at("points").arr().size() == 6);

  api::EditPathTopology bad = split;
  bad.prop = shape;
  bad.op->segment = 40;
  refused(h, cmd(bad), api::ErrorCode::invalid_argument);
  bad.op->segment = 0;
  bad.op->u = 1;
  refused(h, cmd(bad), api::ErrorCode::invalid_argument);
  api::EditPathTopology none;
  none.prop = shape;
  refused(h, cmd(none), api::ErrorCode::invalid_argument);
  api::EditPathTopology opacity;
  opacity.prop = {a, "transform/opacity"};
  opacity.closed = true;
  refused(h, cmd(opacity), api::ErrorCode::invalid_argument);
}

TEST_CASE("paths: setShapeOutline stores the Knife's runs", "[session][paths]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto d = drawn_path(h, comp);
  api::SetShapeOutline s;
  s.layer = d;
  s.runs = {tri(10, true), tri(4, false)};
  exact(h, cmd(s));
  CHECK(geometry(h, d).at("points").is_undefined());
  REQUIRE(geometry(h, d).at("subpaths").arr().size() == 2);
  CHECK(geometry(h, d).at("subpaths").arr()[1].at("open").b());
  const auto shape = make_layer(h, comp, api::LayerKind::shape);
  s.layer = shape;
  exact(h, cmd(s));  // a primitive gains a Geometry
  const auto text = make_layer(h, comp, api::LayerKind::text);
  s.layer = text;
  refused(h, cmd(s), api::ErrorCode::invalid_argument);
  s.layer = d;
  s.runs.clear();
  refused(h, cmd(s), api::ErrorCode::invalid_argument);
}
