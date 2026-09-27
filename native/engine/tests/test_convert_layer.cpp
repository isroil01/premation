// convertLayer / separateLayer (core/handlers_convert.cpp) through the Session:
// without conversion geometry (the core-only engine) both answer `unsupported`
// as the TypeScript engine does; with a fake geometry (two square contours, the
// second inside the first — an "O") Create Shapes from Text makes one path
// layer of two runs beside the hidden text, Create Masks from Text a solid with
// an Add and a Subtract mask, Separate splits the runs into layers and Bake
// Transform keys a copy — each ONE undo entry that undo removes.

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <string>
#include <vector>

#include "core/convert_geometry.hpp"
#include "core/fxstate.hpp"
#include "session_harness.hpp"

using namespace premation;
using namespace premation::test;
using js::Json;
using Catch::Matchers::WithinAbs;

namespace {

constexpr api::Time kSec = 705'600'000;

doc::GeoRun square(double half) {
  doc::GeoRun r;
  for (const auto& [x, y] : std::vector<std::pair<double, double>>{{-half, -half}, {half, -half}, {half, half}, {-half, half}}) {
    r.points.push_back(doc::GeoPt{x, y, x, y, x, y});
  }
  return r;
}

class FakeGeometry final : public doc::ConvertGeometry {
 public:
  std::optional<doc::TextOutlines> text_outlines(const doc::GeoCtx& /*c*/, std::string_view /*layer*/, double /*s*/,
                                                 std::string& why) override {
    if (empty) {
      why = "fake: nothing";
      return std::nullopt;
    }
    doc::TextOutlines o;
    o.runs = {square(50), square(20)};
    o.width = 100;
    o.height = 100;
    return o;
  }
  std::optional<std::vector<doc::TextGlyphBox>> text_glyphs(const doc::GeoCtx& /*c*/, std::string_view /*layer*/,
                                                            double /*s*/, std::string& why) override {
    why = "fake";
    return std::nullopt;
  }
  std::optional<doc::SvgShapes> svg_shapes(std::string_view /*m*/, const std::optional<std::string>& /*f*/,
                                           std::string& why) override {
    why = "fake";
    return std::nullopt;
  }
  bool empty = false;
};

api::ItemId make_comp(Harness& h) {
  api::CreateComposition c;
  c.settings.name = "Test";
  c.settings.width = 640;
  c.settings.height = 360;
  c.settings.frame_rate = api::Rational{30, 1};
  c.settings.duration = 2 * kSec;
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

std::size_t history_len(Harness& h) {
  const auto r = h.ask(qry(api::GetHistory{}));
  return std::get<api::HistoryState>(std::get<api::QueryResult>(r.outcome.v).v).entries.size();
}

api::Response convert(Harness& h, const api::LayerId& layer, api::LayerConversion k) {
  api::ConvertLayer c;
  c.layer = layer;
  c.conversion = k;
  return h.run(cmd(c));
}

std::string undo_label(Harness& h) {
  const auto r = h.run(cmd(api::Undo{}));
  REQUIRE(is_ok(r));
  return result_as<api::HistoryStep>(r).label;
}

}  // namespace

TEST_CASE("convertLayer / separateLayer: unsupported without conversion geometry", "[convert]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto text = make_layer(h, comp, api::LayerKind::text);
  const std::size_t entries = history_len(h);
  CHECK(is_error(convert(h, text, api::LayerConversion::shapes_from_text), api::ErrorCode::unsupported));
  CHECK(is_error(convert(h, text, api::LayerConversion::bake_transform), api::ErrorCode::unsupported));
  CHECK(is_error(h.run(cmd(api::SeparateLayer{text})), api::ErrorCode::unsupported));
  CHECK(is_error(convert(h, "nope", api::LayerConversion::bake_transform), api::ErrorCode::not_found));
  CHECK(history_len(h) == entries);
}

TEST_CASE("convertLayer shapesFromText: a path layer of the runs, the text hidden, one entry", "[convert]") {
  Harness h;
  FakeGeometry geo;
  h.session.set_convert_geometry(&geo);
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto text = make_layer(h, comp, api::LayerKind::text);
  const std::size_t entries = history_len(h);

  const auto r = convert(h, text, api::LayerConversion::shapes_from_text);
  REQUIRE(is_ok(r));
  const auto made = result_as<api::LayerList>(r).layers;
  REQUIRE(made.size() == 1);
  CHECK(history_len(h) == entries + 1);
  const doc::Document& d = h.session.document();
  const doc::Node* shape = d.node(made[0]);
  REQUIRE(shape != nullptr);
  CHECK(shape->name == "Text Outlines (traced)");
  const doc::Component* g = shape->comp("Geometry");
  REQUIRE(g != nullptr);
  REQUIRE(g->props.at("subpaths").is_array());
  CHECK(g->props.at("subpaths").arr().size() == 2);
  CHECK(shape->comp("Transform")->props.at("shapeType").str() == "path");
  CHECK_THAT(shape->comp("Transform")->props.at("width").num(), WithinAbs(100, 1e-9));
  CHECK_FALSE(d.node(text)->visible);
  // Just above the text in the stack.
  CHECK(d.node(shape->parent.value())->children.back() == made[0]);

  CHECK(undo_label(h) == "Create Shapes from Text");
  CHECK(h.session.document().node(made[0]) == nullptr);
  CHECK(h.session.document().node(text)->visible);

  // A non-text layer and an unoutlinable text are refused, nothing written.
  const auto solid = make_layer(h, comp, api::LayerKind::solid);
  const std::size_t before = history_len(h);
  CHECK(is_error(convert(h, solid, api::LayerConversion::shapes_from_text), api::ErrorCode::invalid_argument));
  geo.empty = true;
  CHECK(is_error(convert(h, text, api::LayerConversion::masks_from_text), api::ErrorCode::unsupported));
  CHECK(history_len(h) == before);
}

TEST_CASE("convertLayer masksFromText: a solid with an Add glyph and a Subtract counter", "[convert]") {
  Harness h;
  FakeGeometry geo;
  h.session.set_convert_geometry(&geo);
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto text = make_layer(h, comp, api::LayerKind::text);
  const auto r = convert(h, text, api::LayerConversion::masks_from_text);
  REQUIRE(is_ok(r));
  const auto made = result_as<api::LayerList>(r).layers;
  REQUIRE(made.size() == 1);
  const doc::Document& d = h.session.document();
  const auto masks = doc::read_node_mask(*d.node(made[0]));
  REQUIRE(masks.has_value());
  const auto& paths = masks->at("paths").arr();
  REQUIRE(paths.size() == 2);
  CHECK(paths[0].at("mode").str() == "add");
  CHECK(paths[0].at("name").str() == "Glyph 1");
  CHECK(paths[1].at("mode").str() == "subtract");
  CHECK(paths[1].at("name").str() == "Counter 2");
  // The text sits at the comp centre unrotated, the solid too: layer spaces coincide.
  const Json& p0 = paths[0].at("points").arr()[0];
  CHECK_THAT(p0.at("x").num(), WithinAbs(-50, 1e-6));
  CHECK_THAT(p0.at("y").num(), WithinAbs(-50, 1e-6));
  CHECK_FALSE(d.node(text)->visible);
  CHECK(undo_label(h) == "Create Masks from Text");
  CHECK(h.session.document().node(made[0]) == nullptr);
}

TEST_CASE("separateLayer: one shape layer per run, the original removed, one entry", "[convert]") {
  Harness h;
  FakeGeometry geo;
  h.session.set_convert_geometry(&geo);
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto text = make_layer(h, comp, api::LayerKind::text);
  const auto shapes = convert(h, text, api::LayerConversion::shapes_from_text);
  REQUIRE(is_ok(shapes));
  const auto shape = result_as<api::LayerList>(shapes).layers.at(0);
  const std::size_t entries = history_len(h);

  const auto r = h.run(cmd(api::SeparateLayer{shape}));
  REQUIRE(is_ok(r));
  const auto parts = result_as<api::LayerList>(r).layers;
  REQUIRE(parts.size() == 2);
  CHECK(history_len(h) == entries + 1);
  const doc::Document& d = h.session.document();
  CHECK(d.node(shape) == nullptr);
  for (const auto& p : parts) {
    REQUIRE(d.node(p) != nullptr);
    CHECK(d.node(p)->comp("Geometry")->props.at("subpaths").arr().size() == 1);
  }
  CHECK(d.node(parts[0])->name == "Text Outlines (traced) 1");
  CHECK(undo_label(h) == "Separate Layer");
  CHECK(h.session.document().node(shape) != nullptr);

  // One run: nothing to separate. A text layer: not a shape.
  const auto one = h.run(cmd(api::SeparateLayer{shape}));
  CHECK(is_ok(one));
  const auto again = result_as<api::LayerList>(one).layers;
  REQUIRE(again.size() == 2);
  CHECK(is_error(h.run(cmd(api::SeparateLayer{again[0]})), api::ErrorCode::invalid_argument));
  CHECK(is_error(h.run(cmd(api::SeparateLayer{text})), api::ErrorCode::unsupported));
}

TEST_CASE("convertLayer bakeTransform: a keyed copy, out of its parent, one entry", "[convert]") {
  Harness h;
  FakeGeometry geo;
  h.session.set_convert_geometry(&geo);
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto parent = make_layer(h, comp, api::LayerKind::null);
  const auto child = make_layer(h, comp, api::LayerKind::solid);
  api::SetParent sp;
  sp.layers = {child};
  sp.parent = parent;
  sp.keep_world_transform = true;
  REQUIRE(is_ok(h.run(cmd(sp))));
  const std::size_t entries = history_len(h);

  const auto r = convert(h, child, api::LayerConversion::bake_transform);
  REQUIRE(is_ok(r));
  const auto made = result_as<api::LayerList>(r).layers;
  REQUIRE(made.size() == 1);
  CHECK(history_len(h) == entries + 1);
  const doc::Document& d = h.session.document();
  const doc::Node* copy = d.node(made[0]);
  REQUIRE(copy != nullptr);
  CHECK(copy->parent == std::optional<std::string>(comp));
  CHECK(copy->name.ends_with("(baked)"));
  CHECK(undo_label(h) == "Bake Transform");
  CHECK(h.session.document().node(made[0]) == nullptr);
}
