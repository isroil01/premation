// B3 expression controls as API property groups (controls.cpp,
// handlers_groups.cpp) — the same contracts as
// src/core/engine/__tests__/expressionControls.test.ts: `effects/ctrl_<name>`
// with one value property bound to the stored `ctrl_<name><suffix>` numbers,
// ctrl() reading what the API writes, typed refusals, exact undo.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <string>
#include <vector>

#include "core/anim.hpp"
#include "invariants.hpp"
#include "session_harness.hpp"

using namespace premation;
using namespace premation::test;

namespace {

constexpr api::Time kSec = 705'600'000;

struct Controls {
  Harness h;
  api::ItemId comp;

  Controls() {
    (void)h.hello();
    api::CreateComposition c;
    c.settings.name = "Controls";
    c.settings.width = 640;
    c.settings.height = 360;
    c.settings.frame_rate = api::Rational{30, 1};
    c.settings.duration = 10 * kSec;
    comp = result_item(h.run(cmd(c)));
  }

  api::LayerId solid() {
    api::CreateLayer l;
    l.comp = comp;
    l.kind = api::LayerKind::solid;
    return result_layer(h.run(cmd(l)));
  }

  api::Response add(const api::LayerId& layer, const std::string& matchName, std::optional<std::string> name = std::nullopt,
                    std::vector<api::PropertyInit> init = {}) {
    api::AddPropertyGroup a;
    a.layer = layer;
    a.parent = "effects";
    a.match_name = matchName;
    a.name = std::move(name);
    a.init = std::move(init);
    return h.run(cmd(a));
  }
  std::string add_ok(const api::LayerId& layer, const std::string& matchName, std::optional<std::string> name = std::nullopt,
                     std::vector<api::PropertyInit> init = {}) {
    const auto r = add(layer, matchName, std::move(name), std::move(init));
    REQUIRE(is_ok(r));
    return result_as<api::GroupList>(r).groups.at(0);
  }

  template <class T>
  T query(api::Query q) {
    const auto r = h.ask(std::move(q));
    REQUIRE(is_ok(r));
    return result_as<T>(std::get<api::QueryResult>(r.outcome.v));
  }
  api::Value value(const api::LayerId& layer, const std::string& path, api::Time t = 0, bool evaluated = false) {
    api::GetPropertyValues q;
    q.props = {api::PropRef{layer, path}};
    q.time = t;
    q.evaluated = evaluated;
    return query<api::PropertyValues>(qry(q)).values.at(0).value;
  }
  std::vector<api::PropertyInfo> tree(const api::LayerId& layer) {
    api::GetPropertyTree t;
    t.layer = layer;
    return query<api::PropertyTree>(qry(t)).nodes;
  }
  const api::PropertyInfo* find(const std::vector<api::PropertyInfo>& nodes, const std::string& path) {
    for (const auto& n : nodes) {
      if (n.path == path) return &n;
    }
    return nullptr;
  }
  [[nodiscard]] const js::Json& transform(const api::LayerId& layer, const std::string& key) const {
    return h.session.document().node(layer)->comp("Transform")->props.at(key);
  }
  /// The command fails with `code` and changes nothing.
  void refused(api::Command c, api::ErrorCode code) {
    const auto before = state_of(h.session.document());
    REQUIRE(is_error(h.run(std::move(c)), code));
    REQUIRE(state_of(h.session.document()) == before);
  }
};

double scalar_of(const api::Value& v) { return std::get<double>(v.v); }

}  // namespace

TEST_CASE("controls: listGroupTypes lists the eight controls under effects", "[controls]") {
  Controls x;
  const auto l = x.solid();
  const auto types = x.query<api::GroupTypeList>(qry(api::ListGroupTypes{l, "effects"})).types;
  std::vector<std::string> got;
  for (const auto& t : types) {
    if (t.category == "controls") got.push_back(t.match_name + "|" + t.display_name);
  }
  REQUIRE(got == std::vector<std::string>{
                     "ADBE Slider Control|Slider Control", "ADBE Angle Control|Angle Control", "ADBE Point Control|Point Control",
                     "ADBE Point3D Control|3D Point Control",
                     "ADBE Color Control|Color Control", "ADBE Checkbox Control|Checkbox Control",
                     "ADBE Dropdown Control|Dropdown Menu Control", "ADBE Layer Control|Layer Control"});
  for (const auto& t : x.query<api::GroupTypeList>(qry(api::ListGroupTypes{l, "contents"})).types) REQUIRE(t.category != "controls");
}

TEST_CASE("controls: a slider — add, key the value, ctrl() reads it, remove, undo is exact", "[controls]") {
  Controls x;
  const auto l = x.solid();
  const auto target = x.solid();
  const auto before = state_of(x.h.session.document());
  const std::string g = x.add_ok(l, "ADBE Slider Control");
  REQUIRE(g == "effects/ctrl_Slider 1");
  // Stored exactly as the legacy helper stored it.
  REQUIRE(x.transform(l, "ctrl_Slider 1").num() == 50);
  REQUIRE(x.transform(l, "ctrlkind_Slider 1").str() == "slider");
  REQUIRE(scalar_of(x.value(l, g + "/slider")) == 50);

  const auto nodes = x.tree(l);
  const auto* grp = x.find(nodes, g);
  REQUIRE(grp != nullptr);
  REQUIRE(grp->name == "Slider 1");
  REQUIRE(grp->match_name == "ADBE Slider Control");
  REQUIRE(grp->kind == api::PropertyKind::group);
  REQUIRE(grp->children == std::vector<std::string>{g + "/slider"});
  const auto* val = x.find(nodes, g + "/slider");
  REQUIRE(val != nullptr);
  REQUIRE(val->name == "Slider");
  REQUIRE(val->match_name == "ADBE Slider Control-0001");
  REQUIRE(val->value_type == api::ValueType::scalar);
  REQUIRE(val->animatable);
  const auto& fxKids = x.find(nodes, "effects")->children;
  REQUIRE(std::find(fxKids.begin(), fxKids.end(), g) != fxKids.end());

  // Keys land on the stored number's track; an expression reads it through ctrl().
  api::AddKeyframes a;
  for (const auto& [t, v] : std::vector<std::pair<api::Time, double>>{{0, 10}, {kSec, 30}}) {
    api::KeyframeInsert k;
    k.prop = {l, g + "/slider"};
    k.time = t;
    k.value = scalar(v);
    a.keys.push_back(std::move(k));
  }
  REQUIRE(is_ok(x.h.run(cmd(a))));
  const auto* keys = doc::anim_track(x.h.session.document(), l, "ctrl_Slider 1");
  REQUIRE(keys != nullptr);
  REQUIRE(keys->size() == 2);
  REQUIRE(keys->at(1).value == 30);
  api::SetExpression e;
  e.prop = {target, "transform/rotation"};
  e.source = "ctrl('Slider 1') * 2";
  e.enabled = true;
  REQUIRE(is_ok(x.h.run(cmd(e))));
  REQUIRE(scalar_of(x.value(target, "transform/rotation", kSec / 2, true)) == Catch::Approx(40));

  // Remove: the numbers, the marker and the keys go; the expression now reads 0.
  REQUIRE(is_ok(x.h.run(cmd(api::RemovePropertyGroups{{api::PropRef{l, g}}}))));
  REQUIRE(x.transform(l, "ctrl_Slider 1").is_undefined());
  REQUIRE(x.transform(l, "ctrlkind_Slider 1").is_undefined());
  REQUIRE(doc::anim_track(x.h.session.document(), l, "ctrl_Slider 1") == nullptr);
  REQUIRE(x.find(x.tree(l), g) == nullptr);
  REQUIRE(scalar_of(x.value(target, "transform/rotation", kSec / 2, true)) == 0);

  for (int i = 0; i < 4; ++i) REQUIRE(is_ok(x.h.run(cmd(api::Undo{}))));
  REQUIRE(state_of(x.h.session.document()) == before);
}

TEST_CASE("controls: every kind — value types, members, auto names, init, refusals", "[controls]") {
  Controls x;
  const auto l = x.solid();
  const std::vector<std::string> made{
      x.add_ok(l, "ADBE Point Control"),    x.add_ok(l, "ADBE Color Control"), x.add_ok(l, "ADBE Checkbox Control"),
      x.add_ok(l, "ADBE Dropdown Control"), x.add_ok(l, "ADBE Layer Control"), x.add_ok(l, "ADBE Angle Control")};
  REQUIRE(made == std::vector<std::string>{"effects/ctrl_Point 1", "effects/ctrl_Color 1", "effects/ctrl_Checkbox 1",
                                           "effects/ctrl_Dropdown 1", "effects/ctrl_Layer 1", "effects/ctrl_Angle 1"});
  REQUIRE(x.value(l, made[0] + "/point") == doc::v_vec2(0, 0));
  // A colour control's channels are its stored numbers (0–255, what ctrl('Color 1.r') returns).
  REQUIRE(x.value(l, made[1] + "/color") == doc::v_color(255, 255, 255, 1));
  REQUIRE(scalar_of(x.value(l, made[3] + "/menu")) == 0);

  api::SetProperty sp;
  sp.prop = {l, made[0] + "/point"};
  sp.value = doc::v_vec2(3, 4);
  REQUIRE(is_ok(x.h.run(cmd(sp))));
  sp.prop = {l, made[1] + "/color"};
  sp.value = doc::v_color(10, 20, 30, 1);
  REQUIRE(is_ok(x.h.run(cmd(sp))));
  REQUIRE(x.transform(l, "ctrl_Point 1.x").num() == 3);
  REQUIRE(x.transform(l, "ctrl_Point 1.y").num() == 4);
  REQUIRE(x.transform(l, "ctrl_Color 1.b").num() == 30);

  // Auto names are global (nextControlName); an explicit name + init.
  const auto other = x.solid();
  REQUIRE(x.add_ok(other, "ADBE Point Control") == "effects/ctrl_Point 2");
  const std::string speed = x.add_ok(other, "ADBE Slider Control", " Speed ", {api::PropertyInit{"slider", scalar(7)}});
  REQUIRE(speed == "effects/ctrl_Speed");
  REQUIRE(x.transform(other, "ctrl_Speed").num() == 7);

  // Refusals change nothing.
  auto addc = [&](std::optional<std::string> name, std::optional<std::uint32_t> index = std::nullopt) {
    api::AddPropertyGroup a;
    a.layer = other;
    a.parent = "effects";
    a.match_name = "ADBE Slider Control";
    a.name = std::move(name);
    a.index = index;
    return cmd(a);
  };
  x.refused(addc("Speed"), api::ErrorCode::conflict);
  x.refused(addc("a/b"), api::ErrorCode::invalid_argument);
  x.refused(addc(std::nullopt, 0), api::ErrorCode::unsupported);
  x.refused(cmd(api::SetGroupEnabled{{api::PropRef{other, speed}}, false}), api::ErrorCode::unsupported);
  x.refused(cmd(api::DuplicatePropertyGroups{{api::PropRef{other, speed}}}), api::ErrorCode::unsupported);
  x.refused(cmd(api::MovePropertyGroup{api::PropRef{other, speed}, 0}), api::ErrorCode::unsupported);
  x.refused(cmd(api::RemovePropertyGroups{{api::PropRef{other, "effects/ctrl_Nope"}}}), api::ErrorCode::not_found);
}

TEST_CASE("controls: rename moves the numbers, the marker, keys and expressions; undo is exact", "[controls]") {
  Controls x;
  const auto l = x.solid();
  const std::string g = x.add_ok(l, "ADBE Point Control");
  api::AddKeyframes a;
  api::KeyframeInsert k;
  k.prop = {l, g + "/point"};
  k.time = 0;
  k.value = doc::v_vec2(1, 2);
  a.keys.push_back(std::move(k));
  REQUIRE(is_ok(x.h.run(cmd(a))));
  api::SetExpression e;
  e.prop = {l, g + "/point"};
  e.source = "[time, time]";
  e.enabled = true;
  REQUIRE(is_ok(x.h.run(cmd(e))));
  const auto before = state_of(x.h.session.document());
  REQUIRE(is_ok(x.h.run(cmd(api::RenamePropertyGroup{api::PropRef{l, g}, "Aim"}))));
  REQUIRE(x.transform(l, "ctrl_Aim.x").num() == 0);
  REQUIRE(x.transform(l, "ctrlkind_Aim").str() == "point");
  REQUIRE(x.transform(l, "ctrl_Point 1.x").is_undefined());
  const auto* keys = doc::anim_track(x.h.session.document(), l, "ctrl_Aim.y");
  REQUIRE(keys != nullptr);
  REQUIRE(keys->at(0).value == 2);
  const auto nodes = x.tree(l);
  REQUIRE(x.find(nodes, "effects/ctrl_Aim")->name == "Aim");
  REQUIRE(x.find(nodes, "effects/ctrl_Aim")->match_name == "ADBE Point Control");
  REQUIRE(x.find(nodes, "effects/ctrl_Aim/point")->expression == "[time, time]");
  x.refused(cmd(api::RenamePropertyGroup{api::PropRef{l, "effects/ctrl_Aim"}, ""}), api::ErrorCode::invalid_argument);
  REQUIRE(is_ok(x.h.run(cmd(api::Undo{}))));
  REQUIRE(state_of(x.h.session.document()) == before);
}

TEST_CASE("controls: the property tree is the TypeScript engine's (order, kinds, types, units)", "[controls]") {
  // Captured from the TypeScript engine for the same edits (a solid; blur; slider,
  // point, colour controls; blur again): controls follow the effect stack.
  Controls x;
  const auto l = x.solid();
  api::AddEffect fx;
  fx.layers = {l};
  fx.effect = "blur";
  REQUIRE(is_ok(x.h.run(cmd(fx))));
  for (const char* m : {"ADBE Slider Control", "ADBE Point Control", "ADBE Color Control"}) (void)x.add_ok(l, m);
  REQUIRE(is_ok(x.h.run(cmd(fx))));
  std::vector<std::string> rows;
  std::vector<std::string> all;
  for (const auto& n : x.tree(l)) {
    all.push_back(n.path);
    if (!n.path.starts_with("effects")) continue;
    std::string kids;
    for (const auto& c : n.children) kids += (kids.empty() ? "" : ",") + c;
    rows.push_back(n.path + "|" + std::string(api::to_string(n.kind)) + "|" + std::string(api::to_string(n.value_type)) + "|" +
                   n.unit + "|" + kids);
  }
  REQUIRE(rows == std::vector<std::string>{
                      "effects|indexedGroup|none||effects/fx_1,effects/fx_2,effects/ctrl_Slider 1,effects/ctrl_Point 1,effects/ctrl_Color 1",
                      "effects/fx_1|group|none||effects/fx_1/amount,effects/fx_1/compositing",
                      "effects/fx_1/amount|property|scalar|px|",
                      "effects/fx_1/compositing|group|none||effects/fx_1/compositing/opacity,effects/fx_1/compositing/mask,effects/fx_1/compositing/label,effects/fx_1/compositing/subject,effects/fx_1/compositing/subjectId",
                      "effects/fx_1/compositing/opacity|property|scalar|%|",
                      "effects/fx_1/compositing/mask|property|string||",
                      "effects/fx_1/compositing/label|property|string||", "effects/fx_1/compositing/subject|property|string||",
      "effects/fx_1/compositing/subjectId|property|string||",
                      "effects/fx_2|group|none||effects/fx_2/amount,effects/fx_2/compositing",
                      "effects/fx_2/amount|property|scalar|px|",
                      "effects/fx_2/compositing|group|none||effects/fx_2/compositing/opacity,effects/fx_2/compositing/mask,effects/fx_2/compositing/label,effects/fx_2/compositing/subject,effects/fx_2/compositing/subjectId",
                      "effects/fx_2/compositing/opacity|property|scalar|%|",
                      "effects/fx_2/compositing/mask|property|string||",
                      "effects/fx_2/compositing/label|property|string||", "effects/fx_2/compositing/subject|property|string||",
      "effects/fx_2/compositing/subjectId|property|string||",
                      "effects/ctrl_Slider 1|group|none||effects/ctrl_Slider 1/slider",
                      "effects/ctrl_Slider 1/slider|property|scalar||",
                      "effects/ctrl_Point 1|group|none||effects/ctrl_Point 1/point",
                      "effects/ctrl_Point 1/point|property|vec2|px|",
                      "effects/ctrl_Color 1|group|none||effects/ctrl_Color 1/color",
                      "effects/ctrl_Color 1/color|property|color||",
                  });
  // No stored control number is addressed anywhere else (the old `layer/ctrl_…` rows).
  for (const auto& p : all) REQUIRE_FALSE((p.find("ctrl_") != std::string::npos && !p.starts_with("effects/ctrl_")));
}

// ── Camera program D6: camera / light expressions (AE semantics) ────────────

#include "docexpr.hpp"
#include "docio.hpp"

using Catch::Approx;

namespace {

const char* kD6Project = R"json({"version":"1.9.0","scene":{"version":"1.0.0","nodes":[
  {"id":"comp_root","name":"C","parent":null,"children":["cam","key","card","flat"],"visible":true,"locked":false,
   "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},"components":[{"id":"comp_root_meta","type":"group","props":{"__kind":"group"}}]},
  {"id":"cam","name":"Camera 1","parent":"comp_root","children":[],"visible":true,"locked":false,"transform":{"position":{"x":240,"y":180},"rotation":0,"scale":{"x":1,"y":1}},
   "components":[{"id":"cam_t","type":"Transform","props":{"__kind":"camera","x":240,"y":180,"rotation":0,"z":-900,"focalLength":1000,"dofStrength":12,"dofAperture":60,"focusDistance":850}}]},
  {"id":"key","name":"Key Light","parent":"comp_root","children":[],"visible":true,"locked":false,"transform":{"position":{"x":120,"y":70},"rotation":0,"scale":{"x":1,"y":1}},
   "components":[{"id":"key_t","type":"Transform","props":{"__kind":"light","x":120,"y":70,"rotation":0,"z":-300,"lightType":"spot","intensity":110,"lightCone":60}},{"id":"key_s","type":"Style","props":{"opacity":100,"fill":"#ff8000"}}]},
  {"id":"card","name":"Card","parent":"comp_root","children":[],"visible":true,"locked":false,"transform":{"position":{"x":240,"y":180},"rotation":0,"scale":{"x":1,"y":1}},
   "components":[{"id":"card_t","type":"Transform","props":{"__kind":"shape","x":240,"y":180,"rotation":0,"width":200,"height":120,"z":0,"rotationY":20}},
     {"id":"card_s","type":"Style","props":{"opacity":100,"fill":"#c9a05a"}}]},
  {"id":"flat","name":"Flat","parent":"comp_root","children":[],"visible":true,"locked":false,"transform":{"position":{"x":100,"y":100},"rotation":0,"scale":{"x":2,"y":2}},
   "components":[{"id":"flat_t","type":"Transform","props":{"__kind":"shape","x":100,"y":100,"rotation":0,"scaleX":2,"scaleY":2,"width":50,"height":50}},
     {"id":"flat_s","type":"Style","props":{"opacity":100,"fill":"#ffffff"}}]}]},
  "animation":{"tracks":{},"data":{},"expressions":{}},
  "comps":{"comp_root":{"id":"comp_root","name":"C","width":480,"height":360,"fps":30,"durationSeconds":10,"background":"#101014"}}})json";

struct ExprDoc {
  doc::Document d;
  doc::EditorView view;
  doc::ExprCache cache;
  ExprDoc() {
    const auto json = premation::js::parse(kD6Project);
    REQUIRE(json.has_value());
    (void)doc::restore_document(d, view, *json, {});
  }
  /// `src` as an expression on `node`.`prop`, evaluated at `t`.
  double eval(const std::string& node, const std::string& prop, const std::string& src, double t = 0) {
    doc::anim_set_expr_state(d, node, prop, doc::ExprState{src, true, std::nullopt});
    doc::DocExprEnv env(d, view, cache);
    const auto v = doc::anim_sample(d, env, cache, node, prop, t);
    REQUIRE(v.has_value());
    return *v;
  }
};

}  // namespace

TEST_CASE("D6: thisComp.activeCamera and cameraOption read the camera's options", "[expr][camera][d6]") {
  ExprDoc x;
  CHECK(x.eval("card", "opacity", "thisComp.activeCamera.cameraOption.zoom") == Approx(1000));
  CHECK(x.eval("card", "opacity", "thisComp.layer('Camera 1').cameraOption.focusDistance") == Approx(850));
  CHECK(x.eval("card", "opacity", "thisComp.layer('Camera 1').cameraOption.aperture") == Approx(60));
  CHECK(x.eval("card", "opacity", "thisComp.layer('Camera 1').cameraOption.blurLevel") == Approx(12));
  CHECK(x.eval("card", "opacity", "thisComp.layer('Camera 1').cameraOption.depthOfField") == Approx(1));
  CHECK(x.eval("card", "opacity", "thisComp.activeCamera.cameraOption['ADBE Camera Zoom']") == Approx(1000));
  CHECK(x.eval("card", "opacity", "thisComp.activeCamera.position[2]") == Approx(-900));
  // A one-node camera's Point of Interest reads the comp centre (AE reads one regardless).
  CHECK(x.eval("card", "opacity", "thisComp.activeCamera.pointOfInterest[0]") == Approx(240));
  CHECK(x.eval("card", "opacity", "thisComp.activeCamera.pointOfInterest[1]") == Approx(180));
  // The camera's own expressions see themselves through thisLayer.
  CHECK(x.eval("cam", "focusDistance", "thisLayer.cameraOption.zoom / 2") == Approx(500));
}

TEST_CASE("D6: lightOption reads a light's options and colour", "[expr][light][d6]") {
  ExprDoc x;
  CHECK(x.eval("card", "opacity", "thisComp.layer('Key Light').lightOption.intensity") == Approx(110));
  CHECK(x.eval("card", "opacity", "thisComp.layer('Key Light').lightOption.coneAngle") == Approx(60));
  CHECK(x.eval("card", "opacity", "thisComp.layer('Key Light').lightOption['ADBE Light Intensity']") == Approx(110));
  CHECK(x.eval("card", "opacity", "thisComp.layer('Key Light').lightOption.color[0]") == Approx(1));
  CHECK(x.eval("card", "opacity", "thisComp.layer('Key Light').lightOption.color[1]") == Approx(128.0 / 255));
  CHECK(x.eval("card", "opacity", "thisComp.layer('Key Light').lightOption.color[2]") == Approx(0));
}

TEST_CASE("D6: lookAt aims a camera; orientation results land by axis", "[expr][camera][d6]") {
  ExprDoc x;
  // Y Rotation (pan) toward +x+z: 45°; X Rotation (tilt) toward up (−y): 45°.
  CHECK(x.eval("cam", "orientationY", "lookAt([0, 0, 0], [100, 0, 100])") == Approx(45));
  CHECK(x.eval("cam", "orientationX", "lookAt([0, 0, 0], [0, -100, 100])") == Approx(45));
  CHECK(x.eval("cam", "orientationZ", "lookAt([0, 0, 0], [0, -100, 100])") == Approx(0));
  // A vector on Point of Interest Y / Z takes its own component, as on Position.
  CHECK(x.eval("cam", "poiY", "[1, 2, 3]") == Approx(2));
  CHECK(x.eval("cam", "poiZ", "[1, 2, 3]") == Approx(3));
  // The camera made to look at the card through lookAt faces it: pan 0 straight ahead.
  CHECK(x.eval("cam", "orientationY", "lookAt(thisLayer.position, thisComp.layer('Card').position)") == Approx(0));
}

TEST_CASE("D6: toCompVec drops the translation; fromCompToSurface inverts toComp on a 3D layer", "[expr][space][d6]") {
  ExprDoc x;
  // A 2D layer scaled 2×: a 10 px layer vector is 20 comp px, wherever the layer sits.
  CHECK(x.eval("flat", "opacity", "thisLayer.toCompVec([10, 0])[0]") == Approx(20));
  CHECK(x.eval("flat", "opacity", "thisLayer.toCompVec([0, 0])[1]") == Approx(0));
  // A 3D layer: the surface point under a comp point is where toComp put it.
  CHECK(x.eval("card", "opacity", "thisLayer.fromCompToSurface(thisLayer.toComp([30, 40]))[0]") == Approx(30).margin(1e-6));
  CHECK(x.eval("card", "opacity", "thisLayer.fromCompToSurface(thisLayer.toComp([30, 40]))[1]") == Approx(40).margin(1e-6));
}
