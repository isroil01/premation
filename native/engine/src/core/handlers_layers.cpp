#include "handlers_layers.hpp"

#include <algorithm>
#include <cmath>
#include <functional>
#include <set>

#include "catalog_data.hpp"
#include "fxstate.hpp"
#include "parenting.hpp"
#include "readmodel.hpp"
#include "time_conv.hpp"
#include "transform.hpp"

namespace premation::doc {

using api::ErrorCode;

namespace {

Json obj() { return Json::object(); }

double rec_num(const Json* rec, std::string_view key, double fb) {
  if (rec == nullptr) return fb;
  const Json& v = rec->at(key);
  return v.is_undefined() || v.is_null() ? fb : v.num();
}

std::string kind_word(api::LayerKind k) { return std::string(api::to_string(k)); }

std::optional<std::string> default_name(api::LayerKind k) {
  switch (k) {
    case api::LayerKind::null: return "Null";
    case api::LayerKind::solid: return "Solid";
    case api::LayerKind::shape: return "Shape Layer";
    case api::LayerKind::rectangle: return "Rectangle";
    case api::LayerKind::ellipse: return "Ellipse";
    case api::LayerKind::polygon: return "Polygon";
    case api::LayerKind::path: return "Path";
    case api::LayerKind::text: return "Text";
    case api::LayerKind::camera: return "Camera";
    case api::LayerKind::light: return "Light";
    case api::LayerKind::group: return "Group";
    case api::LayerKind::particle: return "Particles";
    case api::LayerKind::model3d: return "3D Box";
    case api::LayerKind::adjustment: return "Adjustment Layer";
    default: return std::nullopt;
  }
}

const Json* comp_record_or_fail(const Document& d, const std::string& comp) {
  const Json* c = d.comp(comp);
  if (c == nullptr) fail(ErrorCode::not_found, "no composition '" + comp + "'", {.item = comp});
  return c;
}

const Json* find_asset_record(const Document& d, const std::string& id) {
  for (const Json& a : d.items().assets) {
    if (a.at("id").is_string() && a.at("id").str() == id) return &a;
  }
  return nullptr;
}

}  // namespace

// ── layerFactory.ts ─────────────────────────────────────────────────────────

Node make_layer_node(const FactoryInput& in) {
  const Json* comp = in.comp;
  const double cw = rec_num(comp, "width", 1920);
  const double ch = rec_num(comp, "height", 1080);
  const double cx = cw / 2;
  const double cy = ch / 2;
  const std::string& id = in.id;
  std::string name;
  if (in.name) name = *in.name;
  else if (in.asset != nullptr && in.asset->at("name").is_string()) name = in.asset->at("name").str();
  else if (in.refComp != nullptr && in.refComp->at("name").is_string()) name = in.refComp->at("name").str();
  else name = default_name(in.kind).value_or(kind_word(in.kind));

  auto transform = [&](std::string_view sceneKind, const std::vector<std::pair<std::string, Json>>& extra) {
    Json p = obj();
    p.set("__kind", Json::string(std::string(sceneKind)));
    p.set("x", Json::number(cx));
    p.set("y", Json::number(cy));
    p.set("rotation", Json::number(0));
    p.set("scaleX", Json::number(1));
    p.set("scaleY", Json::number(1));
    p.set("anchorX", Json::number(0));
    p.set("anchorY", Json::number(0));
    for (const auto& [k, v] : extra) p.set(k, v);
    return Component{id + "_t", "Transform", std::move(p)};
  };
  auto style = [&](const std::vector<std::pair<std::string, Json>>& props) {
    Json p = obj();
    for (const auto& [k, v] : props) p.set(k, v);
    return Component{id + "_s", "Style", std::move(p)};
  };
  auto N = [](double v) { return Json::number(v); };
  auto S = [](std::string v) { return Json::string(std::move(v)); };
  auto B = [](bool v) { return Json::boolean(v); };

  Node node;
  node.id = id;
  node.name = name;
  switch (in.kind) {
    case api::LayerKind::null:
      node.components = {transform("null", {{"width", N(100)}, {"height", N(100)}})};
      break;
    case api::LayerKind::solid:
    case api::LayerKind::adjustment: {
      const bool solid = in.kind == api::LayerKind::solid;
      Json fill = obj();
      fill.set("type", S("solid"));
      fill.set("color", S(solid ? "#4f7ea8" : "rgba(255,255,255,0)"));
      Json fx = obj();
      fx.set("solid", B(true));
      fx.set("fill", std::move(fill));
      if (!solid) fx.set("isAdjustment", B(true));
      node.components = {transform(solid ? "shape" : "adjustment", {{"width", N(cw)}, {"height", N(ch)}}),
                         style({{"opacity", N(100)}, {"fill", S(solid ? "#4f7ea8" : "rgba(255,255,255,0)")}}),
                         Component{id + "_fx", "fx", std::move(fx)}};
      break;
    }
    case api::LayerKind::shape:
    case api::LayerKind::rectangle:
    case api::LayerKind::ellipse:
    case api::LayerKind::polygon: {
      const char* st = in.kind == api::LayerKind::ellipse ? "ellipse" : in.kind == api::LayerKind::polygon ? "polygon" : "rect";
      node.components = {transform("shape", {{"width", N(280)}, {"height", N(280)}, {"shapeType", S(st)}}),
                         style({{"opacity", N(100)}, {"fill", S("#3b8276")}})};
      break;
    }
    case api::LayerKind::path: {
      Json g = obj();
      g.set("points", Json::array());
      node.components = {transform("shape", {{"width", N(1)}, {"height", N(1)}}),
                         style({{"opacity", N(100)}, {"fill", S("#3b8276")}}), Component{id + "_g", "Geometry", std::move(g)}};
      break;
    }
    case api::LayerKind::text: {
      Json t = obj();
      t.set("content", S(in.name ? *in.name : "Text"));
      t.set("fontSize", registry().factory.at("textSize"));
      t.set("opacity", N(100));
      node.components = {transform("text", {}), Component{id + "_c", "Text", std::move(t)}};
      break;
    }
    case api::LayerKind::camera: {
      const motion::xf::Camera cam = motion::xf::default_camera(cw, ch);
      node.components = {transform("camera", {{"width", N(100)},
                                              {"height", N(100)},
                                              {"x", N(cam.position.x)},
                                              {"y", N(cam.position.y)},
                                              {"z", N(-cam.focal_length)},
                                              {"focalLength", N(cam.focal_length)}}),
                         style({{"opacity", N(100)}})};
      break;
    }
    case api::LayerKind::light:
      node.components = {transform("light", {{"width", N(100)},
                                             {"height", N(100)},
                                             {"z", N(-motion::js::round(cw * 0.2315))},
                                             {"intensity", N(100)},
                                             {"radius", N(motion::js::round(std::max(cw, ch) * 0.45))},
                                             {"falloff", S("none")},
                                             {"castShadows", B(true)}}),
                         style({{"opacity", N(100)}, {"fill", S("#fff3c0")}})};
      break;
    case api::LayerKind::group: {
      Json g = obj();
      g.set("__kind", S("group"));
      node.components = {transform("group", {{"width", N(280)}, {"height", N(280)}}), Component{id + "_m", "group", std::move(g)}};
      break;
    }
    case api::LayerKind::particle: {
      Json p = registry().factory.at("particle");
      p.set("emitterWidth", N(400));
      p.set("emitterHeight", N(400));
      Json fx = obj();
      fx.set("particle", std::move(p));
      node.components = {transform("particle", {{"width", N(400)}, {"height", N(400)}}), style({{"opacity", N(100)}}),
                         Component{id + "_fx", "fx", std::move(fx)}};
      break;
    }
    case api::LayerKind::model3d: {
      const Json& prim = registry().factory.at("primitive");
      Component pc{id + "_prim", prim.at("type").str(), prim.at("props")};
      node.components = {transform("shape", {{"width", N(240)},
                                             {"height", N(240)},
                                             {"z", N(0)},
                                             {"rotationX", N(0)},
                                             {"rotationY", N(0)},
                                             {"primitiveType", S("box")},
                                             {"castsShadows", B(true)},
                                             {"acceptsLights", B(true)}}),
                         style({{"opacity", N(100)}, {"fill", S("#3b8276")}}), std::move(pc)};
      break;
    }
    case api::LayerKind::image:
    case api::LayerKind::video:
    case api::LayerKind::svg:
    case api::LayerKind::sequence: {
      const Json* a = in.asset;
      if (a == nullptr) fail(ErrorCode::invalid_argument, "a " + kind_word(in.kind) + " layer needs a footage source");
      const Json& interp = a->at("interpret");
      const double par = interp.at("par").is_undefined() || interp.at("par").is_null() ? 1.0 : interp.at("par").num();
      const Json& md = a->at("metadata");
      const double mw = md.at("width").is_undefined() || md.at("width").is_null() ? 400.0 : md.at("width").num();
      const double mh = md.at("height").is_undefined() || md.at("height").is_null() ? 400.0 : md.at("height").num();
      const char* sk = in.kind == api::LayerKind::video ? "video" : in.kind == api::LayerKind::svg ? "svg" : "image";
      node.components = {transform(sk, {{"width", N(motion::js::round(mw * par))}, {"height", N(mh)}, {"src", a->at("src")},
                                        {"assetId", a->at("id")}}),
                         style({{"opacity", N(100)}})};
      break;
    }
    case api::LayerKind::audio: {
      const Json* a = in.asset;
      if (a == nullptr) fail(ErrorCode::invalid_argument, "an audio layer needs a footage source");
      const Json& md = a->at("metadata");
      const double dur = md.at("duration").is_undefined() || md.at("duration").is_null() ? 0.0 : md.at("duration").num();
      Json p = obj();
      p.set("__assetId", a->at("id"));
      p.set("__src", a->at("src"));
      p.set("__level", N(100));
      p.set("__start", N(0));
      p.set("__in", N(0));
      p.set("__out", N(dur));
      p.set("__duration", N(dur));
      p.set("__muted", B(false));
      node.components = {transform("audio", {{"width", N(100)}, {"height", N(100)}}), Component{id + "_a", "Audio", std::move(p)}};
      break;
    }
    case api::LayerKind::precomp: {
      if (in.refComp == nullptr || !in.refCompId) fail(ErrorCode::invalid_argument, "a precomp layer needs a composition source");
      Json fx = obj();
      fx.set("precomp", B(true));
      fx.set("__compRef", S(*in.refCompId));
      node.components = {transform("comp", {{"width", N(rec_num(in.refComp, "width", 0))}, {"height", N(rec_num(in.refComp, "height", 0))}}),
                         style({{"opacity", N(100)}}), Component{id + "_fx", "fx", std::move(fx)}};
      break;
    }
    default:
      fail(ErrorCode::unsupported, "creating a '" + kind_word(in.kind) +
                                       "' layer through the engine API is not supported by the TypeScript engine (plugin/component "
                                       "layers are created by their plugin)");
  }
  return node;
}

bool would_create_comp_cycle(const Document& d, std::string_view hostComp, std::string_view refComp) {
  if (hostComp == refComp) return true;
  std::set<std::string, std::less<>> seen;
  std::function<bool(const std::string&)> reaches = [&](const std::string& compId) -> bool {
    if (compId == hostComp) return true;
    if (seen.contains(compId)) return false;
    seen.insert(compId);
    const Node* root = d.node(compId);
    if (root == nullptr) return false;
    bool found = false;
    std::function<void(const Node&)> walk = [&](const Node& n) {
      if (found) return;
      if (auto ref = read_comp_ref(n)) {
        if (reaches(*ref)) {
          found = true;
          return;
        }
      }
      for (const auto& c : n.children) {
        if (const Node* cn = d.node(c)) walk(*cn);
      }
    };
    walk(*root);
    return found;
  };
  return reaches(std::string(refComp));
}

// ── handlers ────────────────────────────────────────────────────────────────

ResultOf<api::CreateLayer> handle(const api::CreateLayer& c, HCtx& x) {
  Document& d = x.d;
  require_comp(d, c.comp);
  const Json settings = *comp_record_or_fail(d, c.comp);
  if (c.in_point && c.out_point && *c.out_point <= *c.in_point) fail(ErrorCode::invalid_argument, "outPoint must be after inPoint");
  const Json* asset = nullptr;
  const api::LayerKind k = c.kind;
  if (k == api::LayerKind::image || k == api::LayerKind::video || k == api::LayerKind::audio || k == api::LayerKind::svg ||
      k == api::LayerKind::sequence) {
    if (!c.source) fail(ErrorCode::invalid_argument, "a " + kind_word(k) + " layer needs a source item");
    asset = find_asset_record(d, *c.source);
    if (asset == nullptr) fail(ErrorCode::not_found, "no footage item '" + *c.source + "'", {.item = *c.source});
  }
  std::optional<Json> refComp;
  if (k == api::LayerKind::precomp) {
    if (!c.source || !is_comp_item(d, *c.source)) {
      fail(ErrorCode::not_found, "no composition '" + c.source.value_or("") + "'", {.item = c.source});
    }
    if (would_create_comp_cycle(d, c.comp, *c.source)) fail(ErrorCode::cycle, "that composition already contains this one");
    refComp = *comp_record_or_fail(d, *c.source);
  }
  const std::string parentId = c.parent ? *c.parent : c.comp;
  if (c.parent) {
    (void)require_layer(d, *c.parent);
    if (comp_of_layer(d, *c.parent) != c.comp) {
      fail(ErrorCode::invalid_argument, "the parent must be a layer of the same composition", {.layer = *c.parent});
    }
  }
  const std::size_t count = layer_ids_of_comp(d, c.comp).size();
  if (c.index && *c.index > count) {
    fail(ErrorCode::out_of_range, "index " + std::to_string(*c.index) + " is past the " + std::to_string(count) + " layers of the composition");
  }
  const std::string id = x.mint_id("layer_");
  const Json assetCopy = asset != nullptr ? *asset : Json();
  FactoryInput fi;
  fi.kind = k;
  fi.id = id;
  fi.name = c.name;
  fi.comp = &settings;
  fi.asset = asset != nullptr ? &assetCopy : nullptr;
  fi.refCompId = k == api::LayerKind::precomp ? c.source : std::nullopt;
  fi.refComp = refComp ? &*refComp : nullptr;
  Node node = make_layer_node(fi);
  ensure_timeline(d, c.comp);
  std::string kw = kind_word(k);
  if (!kw.empty()) kw[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(kw[0])));
  x.label = "New " + kw + " Layer";
  // apply
  node.parent = parentId;
  sg_add_child(d, parentId, std::move(node));
  tl_sync_from_scene(d, c.comp);
  move_in_stack(d, c.comp, {id}, c.index.value_or(0));
  if (c.in_point || c.out_point || c.start_time) {
    const double fps = comp_fps(d, c.comp);
    const auto geoms = geoms_of(d, id, c.comp);
    if (!geoms.empty()) {
      const Geo cur = geoms[0];
      const double start = c.in_point ? flicks_to_frames(*c.in_point, fps) : cur.start;
      const double end = c.out_point ? flicks_to_frames(*c.out_point, fps) : cur.start + cur.duration;
      const double origin = c.start_time ? flicks_to_frames(*c.start_time, fps) : start - cur.sourceIn;
      Geo g = cur;
      g.start = start;
      g.duration = std::max(1.0, end - start);
      g.sourceIn = std::max(0.0, start - origin);
      write_geoms(d, c.comp, id, {g});
    }
  }
  if (!c.init.empty()) {
    const Catalog cat = catalog_for(d, id);
    for (const api::PropertyInit& init : c.init) write_static(d, id, require_binding(cat, init.path), init.value);
  }
  return api::LayerRef{id};
}

ResultOf<api::DeleteLayers> handle(const api::DeleteLayers& c, HCtx& x) {
  Document& d = x.d;
  (void)require_layers_in_one_comp(d, c.layers);
  for (const auto& id : c.layers) {
    const Node* n = d.node(id);
    if (n != nullptr && n->locked) fail(ErrorCode::locked, "layer '" + id + "' is locked", {.layer = id});
  }
  x.label = "Delete " + plural(c.layers.size(), "Layer");
  const std::set<std::string> doomed(c.layers.begin(), c.layers.end());
  const PCtx pc = x.pc();
  for (const auto& id : c.layers) {
    // orphanChildren: children not themselves removed keep their world transform.
    const Node* n = d.node(id);
    if (n == nullptr) continue;
    const std::optional<std::string> target = n->parent ? n->parent : comp_of_layer(d, id);
    for (const auto& child : sg_child_order(d, id)) {
      if (doomed.contains(child) || !target) continue;
      set_parent_preserving_world(pc, child, *target);
    }
  }
  for (const auto& id : c.layers) {
    if (d.node(id) == nullptr) continue;
    if (!delete_layer_node(d, id)) fail(ErrorCode::internal, "could not delete '" + id + "'", {.layer = id});
  }
  return {};
}

ResultOf<api::ReorderLayers> handle(const api::ReorderLayers& c, HCtx& x) {
  Document& d = x.d;
  require_comp(d, c.comp);
  const std::string comp = require_layers_in_one_comp(d, c.layers);
  if (comp != c.comp) fail(ErrorCode::invalid_argument, "the layers are not in that composition");
  const std::size_t count = layer_ids_of_comp(d, c.comp).size();
  if (c.to_index > count) fail(ErrorCode::out_of_range, "toIndex " + std::to_string(c.to_index) + " is past the " + std::to_string(count) + " layers");
  const std::optional<std::string> parent = d.node(c.layers[0])->parent;
  for (const auto& id : c.layers) {
    if (d.node(id)->parent != parent) {
      fail(ErrorCode::invalid_argument, "layers moved together must share a parent (parenting is nesting in this engine)", {.layer = id});
    }
  }
  x.label = "Reorder Layers";
  move_in_stack(d, c.comp, c.layers, c.to_index);
  return {};
}

ResultOf<api::RenameLayer> handle(const api::RenameLayer& c, HCtx& x) {
  (void)require_layer(x.d, c.layer);
  const bool blank = std::all_of(c.name.begin(), c.name.end(), [](char ch) {
    return ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' || ch == '\f' || ch == '\v';
  });
  if (blank) fail(ErrorCode::invalid_argument, "a layer name cannot be empty");
  x.label = "Rename Layer";
  x.d.node_mut(c.layer).name = c.name;
  return {};
}

ResultOf<api::SetLayerComment> handle(const api::SetLayerComment& c, HCtx& x) {
  (void)require_layer(x.d, c.layer);
  x.label = "Layer Comment";
  sg_set_fx(x.d, c.layer, "comment", c.comment.empty() ? Json() : Json::string(c.comment));
  return {};
}

ResultOf<api::SetBlendMode> handle(const api::SetBlendMode& c, HCtx& x) {
  (void)require_layers_in_one_comp(x.d, c.layers);
  const std::string mode(api::to_string(c.mode));
  const auto& valid = registry().blendModes;
  if (std::find(valid.begin(), valid.end(), mode) == valid.end()) {
    fail(ErrorCode::unsupported, "blend mode '" + mode + "' is not implemented by the TypeScript renderer");
  }
  x.label = "Blending Mode";
  for (const auto& id : c.layers) sg_set_fx(x.d, id, "blendMode", Json::string(mode));
  return {};
}

ResultOf<api::SetTrackMatte> handle(const api::SetTrackMatte& c, HCtx& x) {
  Document& d = x.d;
  (void)require_layer(d, c.layer);
  const api::TrackMatte& m = c.matte;
  if (m.mode != api::MatteMode::none) {
    if (!m.layer) fail(ErrorCode::invalid_argument, "a track matte needs a source layer (matte by reference)");
    (void)require_layer(d, *m.layer);
    if (*m.layer == c.layer) fail(ErrorCode::invalid_argument, "a layer cannot be its own matte");
    if (comp_of_layer(d, *m.layer) != comp_of_layer(d, c.layer)) {
      fail(ErrorCode::invalid_argument, "the matte must be in the same composition", {.layer = *m.layer});
    }
  }
  x.label = "Track Matte";
  if (m.mode == api::MatteMode::none) {
    sg_set_fx(d, c.layer, "matte", Json());
  } else {
    const bool luma = m.mode == api::MatteMode::luma || m.mode == api::MatteMode::luma_inverted;
    const bool inverted = m.mode == api::MatteMode::alpha_inverted || m.mode == api::MatteMode::luma_inverted;
    Json v = obj();
    v.set("mode", Json::string(luma ? "luma" : "alpha"));
    v.set("inverted", Json::boolean(inverted));
    v.set("sourceId", Json::string(*m.layer));
    sg_set_fx(d, c.layer, "matte", std::move(v));
  }
  return {};
}

ResultOf<api::SetParent> handle(const api::SetParent& c, HCtx& x) {
  Document& d = x.d;
  const std::string comp = require_layers_in_one_comp(d, c.layers);
  if (c.parent) {
    (void)require_layer(d, *c.parent);
    if (comp_of_layer(d, *c.parent) != comp) {
      fail(ErrorCode::invalid_argument, "parent and child must be in the same composition", {.layer = *c.parent});
    }
    for (const auto& id : c.layers) {
      if (!can_reparent(d, id, c.parent)) {
        fail(ErrorCode::cycle, "parenting '" + id + "' to '" + *c.parent + "' would create a cycle", {.layer = id});
      }
    }
  }
  x.label = c.parent ? "Parent" : "Unparent";
  const PCtx pc = x.pc();
  for (const auto& id : c.layers) {
    if (api_parent_of(d, id) == c.parent) continue;
    if (!reparent_node(pc, id, c.parent, c.keep_world_transform)) fail(ErrorCode::cycle, "could not parent '" + id + "'", {.layer = id});
  }
  return {};
}

}  // namespace premation::doc
