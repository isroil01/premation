// Layers family, part 2 — src/core/engine/handlers/layers.ts: switches, source
// replacement, grouping, copy/paste fragments and the conversions the
// TypeScript engine refuses.
#include <algorithm>
#include <cmath>
#include <functional>
#include <set>

#include "anim_json.hpp"
#include "catalog_data.hpp"
#include "fxstate.hpp"
#include "handlers_layers.hpp"
#include "layer_clone.hpp"
#include "parenting.hpp"
#include "readmodel.hpp"
#include "time_conv.hpp"

namespace premation::doc {

using api::ErrorCode;

namespace {

constexpr std::uint32_t kFragmentVersion = 1;

bool layer_flag_available(const Node& n, std::string_view flag) {
  if (!n.parent) return false;
  if (flag == "threeD") return can_be_3d(n);
  if (flag == "collapse") return !collapse_switch_kind(n).empty();
  const std::string kind = n.kind();
  if (flag == "frameBlend") return kind == "video" || is_precomp(n);
  if (flag == "quality") {
    return !(kind == "null" || kind == "camera" || kind == "light" || kind == "audio" || kind == "group") || is_precomp(n);
  }
  return true;
}

void update_node_layer_time_frame_blend(Document& d, const std::string& id, const std::string& frameBlend) {
  LayerTime next = get_node_layer_time(*d.node(id));
  next.frameBlend = frameBlend;
  next = normalize_layer_time(layer_time_json(next));
  const bool clear = is_identity_time(next) && next.frameBlend == "none";
  sg_set_fx(d, id, "time", clear ? Json() : layer_time_json(next));
}

const Json* active_comp_record(const Document& d, const EditorView& v) {
  if (const Json* c = d.comp(v.tabComp)) return c;
  for (const auto& [id, c] : d.comps()) return c.get();
  return nullptr;
}

/// transformWrite.ts `writeTransformProps` for width/height (no autokey preference in the engine).
void write_transform_props(HCtx& x, const std::string& node, const std::vector<std::pair<std::string, double>>& writes) {
  Document& d = x.d;
  const Node* n = d.node(node);
  if (n == nullptr || n->locked) return;
  const Component* t = n->comp("Transform");
  if (t == nullptr) return;
  const std::string tid = t->id;
  const double lt = comp_to_keyframe_time(d, x.view, node, x.view.tabTime);
  std::vector<std::pair<std::string, double>> keyed;
  for (const auto& [prop, value] : writes) {
    if (!std::isfinite(value)) continue;
    // writesAsKeyframe: the prop (or its x/y / scale sibling group) already has a track.
    std::vector<std::string> group = {prop};
    if (prop == "x" || prop == "y") group = {"x", "y"};
    else if (prop == "scaleX" || prop == "scaleY") group = {"scaleX", "scaleY", "scale"};
    else if (prop == "anchorX" || prop == "anchorY") group = {"anchorX", "anchorY"};
    const bool asKey = std::any_of(group.begin(), group.end(), [&](const std::string& p) { return anim_track(d, node, p) != nullptr; });
    if (asKey) keyed.emplace_back(prop, value);
    (void)sg_write_prop(d, node, tid, prop, Json::number(value));
  }
  for (const auto& [prop, value] : keyed) anim_set_keyframe(d, node, prop, lt, value);
}

Json node_row_json(const Node& n) {
  Json o = Json::object();
  o.set("id", Json::string(n.id));
  o.set("name", Json::string(n.name));
  Json ch = Json::array();
  for (const auto& c : n.children) ch.arr_mut().push_back(Json::string(c));
  o.set("children", std::move(ch));
  o.set("parent", n.parent ? Json::string(*n.parent) : Json::null());
  const ViewTransform vt = view_transform(n);
  Json pos = Json::object();
  pos.set("x", Json::number(vt.x));
  pos.set("y", Json::number(vt.y));
  Json scale = Json::object();
  scale.set("x", Json::number(1));
  scale.set("y", Json::number(1));
  Json tr = Json::object();
  tr.set("position", std::move(pos));
  tr.set("rotation", Json::number(vt.rotation));
  tr.set("scale", std::move(scale));
  o.set("transform", std::move(tr));
  Json comps = Json::array();
  for (const Component& c : n.components) {
    Json cj = Json::object();
    cj.set("id", Json::string(c.id));
    cj.set("type", Json::string(c.type));
    cj.set("props", c.props);
    comps.arr_mut().push_back(std::move(cj));
  }
  o.set("components", std::move(comps));
  o.set("visible", Json::boolean(n.visible));
  o.set("locked", Json::boolean(n.locked));
  o.set("solo", Json::boolean(n.solo));
  if (n.shy) o.set("shy", Json::boolean(true));
  if (n.color) o.set("color", Json::string(*n.color));
  return o;
}

struct FragmentLayer {
  Json row;
  std::optional<NodeAnim> anim;
  std::vector<Clip> bars;
};

std::vector<FragmentLayer> decode_fragment(const api::DocumentFragment& f) {
  if (f.version != kFragmentVersion) fail(ErrorCode::unsupported, "fragment version " + std::to_string(f.version) + " is not understood");
  const std::string text(f.data.begin(), f.data.end());
  const auto data = js::parse(text);
  if (!data || !data->is_object()) fail(ErrorCode::decode, "the fragment is not a copyLayers payload");
  const Json& layers = data->at("layers");
  if (!layers.is_array() || layers.arr().empty()) fail(ErrorCode::invalid_argument, "the fragment holds no layers");
  std::vector<FragmentLayer> out;
  for (const Json& l : layers.arr()) {
    FragmentLayer fl;
    fl.row = l.at("row");
    if (!fl.row.is_object() || !fl.row.at("id").is_string()) fail(ErrorCode::decode, "the fragment is not a copyLayers payload");
    if (l.at("anim").is_object()) {
      fl.anim = anim_from_json(l.at("anim"));
      // A fragment is client bytes: keys arrive in whatever order it states.
      // copyLayers always writes them in time order, so sorting (stably)
      // changes nothing for a real fragment and keeps a crafted one from
      // storing a track the sampler cannot read (found by engine_fuzz; the
      // TypeScript restoreNode stores it as given).
      for (auto& entry : fl.anim->tracks) {
        std::stable_sort(entry.second.begin(), entry.second.end(), [](const Key& a, const Key& b) { return a.t < b.t; });
      }
    }
    if (l.at("bars").is_array()) {
      for (const Json& b : l.at("bars").arr()) {
        Clip c;
        c.start = b.at("start").num();
        c.duration = b.at("duration").num();
        c.sourceIn = b.at("sourceIn").num();
        if (b.at("sourceDuration").is_number()) c.sourceDuration = b.at("sourceDuration").num();
        fl.bars.push_back(c);
      }
    }
    out.push_back(std::move(fl));
  }
  return out;
}

}  // namespace

void set_3d_enabled(HCtx& x, const std::string& node, bool on) {
  Document& d = x.d;
  const Node* n = d.node(node);
  if (n == nullptr) return;
  const Component* t = n->comp("Transform");
  if (t == nullptr) return;
  const std::string tid = t->id;
  const Json before = t->props;
  if (on && is_solid_node(*n)) {
    const Json* comp = active_comp_record(d, x.view);
    const double w = comp != nullptr && comp->at("width").is_number() ? comp->at("width").num() : 1920;
    const double h = comp != nullptr && comp->at("height").is_number() ? comp->at("height").num() : 1080;
    const std::pair<const char*, double> seed[] = {{"x", w / 2}, {"y", h / 2},       {"width", w},  {"height", h},
                                                   {"anchorX", w / 2}, {"anchorY", h / 2}, {"rotation", 0}, {"scaleX", 1},
                                                   {"scaleY", 1}};
    for (const auto& [prop, value] : seed) (void)sg_write_prop(d, node, tid, prop, Json::number(value));
  }
  if (on && d.node(node)->comp("Transform")->props.at("acceptsLights").is_undefined()) {
    (void)sg_write_prop(d, node, tid, "acceptsLights", Json::boolean(true));
  }
  for (const char* p : {"z", "rotationX", "rotationY"}) {
    (void)sg_write_prop(d, node, tid, p, on ? (before.at(p).is_number() ? before.at(p) : Json::number(0)) : Json());
  }
  if (!on) {
    for (const char* p : {"z", "rotationX", "rotationY"}) {
      if (anim_is_animated(d, node, p)) anim_remove_track(d, node, p);
    }
  }
}

ResultOf<api::SetLayerSwitches> handle(const api::SetLayerSwitches& c, HCtx& x) {
  Document& d = x.d;
  (void)require_layers_in_one_comp(d, c.layers);
  const api::LayerSwitchesPatch& p = c.patch;
  for (const auto& id : c.layers) {
    const Node& n = *d.node(id);
    if (p.three_d && *p.three_d && !layer_flag_available(n, "threeD")) fail(ErrorCode::invalid_argument, "layer '" + id + "' cannot be 3D", {.layer = id});
    if (p.collapse && collapse_switch_kind(n).empty() && *p.collapse) {
      fail(ErrorCode::invalid_argument, "layer '" + id + "' has no collapse/continuous-rasterize switch", {.layer = id});
    }
    if (p.frame_blend && *p.frame_blend != api::FrameBlend::off && !layer_flag_available(n, "frameBlend")) {
      fail(ErrorCode::invalid_argument, "layer '" + id + "' has no frames to blend", {.layer = id});
    }
    if (p.quality && !layer_flag_available(n, "quality") && *p.quality != api::LayerQuality::best) {
      fail(ErrorCode::invalid_argument, "layer '" + id + "' has no quality switch", {.layer = id});
    }
    if (p.auto_orient && *p.auto_orient == api::AutoOrient::towards_point_of_interest) {
      fail(ErrorCode::unsupported, "Orient Towards Point of Interest is a camera/light option the TypeScript engine does not have");
    }
    if (p.label && *p.label > 0 && !label_color_of(*p.label)) fail(ErrorCode::out_of_range, "label " + std::to_string(*p.label) + " does not exist");
  }
  x.label = "Layer Switches";
  for (const auto& id : c.layers) {
    {
      Node& n = d.node_mut(id);
      if (p.visible) n.visible = *p.visible;
      if (p.solo) n.solo = *p.solo;
      if (p.locked) n.locked = *p.locked;
      if (p.shy) n.shy = *p.shy;
      if (p.label) n.color = label_color_of(*p.label);
    }
    const Node& n = *d.node(id);
    if (p.audio_enabled) {
      const std::string kind = n.kind();
      const Component* comp = kind == "audio" ? n.comp("Audio") : kind == "video" ? n.comp("Transform") : nullptr;
      if (comp != nullptr) {
        const std::string cid = comp->id;
        (void)sg_write_prop(d, id, cid, kind == "audio" ? "__muted" : "audioMuted", *p.audio_enabled ? Json() : Json::boolean(true));
      }
    }
    if (p.collapse) {
      const std::string kind = collapse_switch_kind(*d.node(id));
      if (kind == "collapse") sg_set_fx(d, id, "collapseTransforms", *p.collapse ? Json::boolean(true) : Json());
      else if (kind == "raster") sg_set_fx(d, id, "continuousRasterize", *p.collapse ? Json::boolean(true) : Json());
    }
    if (p.quality) {
      sg_set_fx(d, id, "quality", *p.quality == api::LayerQuality::best ? Json() : Json::string(std::string(api::to_string(*p.quality))));
    }
    if (p.effects_enabled) sg_set_fx(d, id, "fxEnabled", *p.effects_enabled ? Json() : Json::boolean(false));
    if (p.motion_blur) sg_set_fx(d, id, "motionBlur", *p.motion_blur ? Json::boolean(true) : Json());
    if (p.adjustment) sg_set_fx(d, id, "isAdjustment", *p.adjustment ? Json::boolean(true) : Json());
    if (p.three_d) set_3d_enabled(x, id, *p.three_d);
    if (p.guide) sg_set_fx(d, id, "guide", *p.guide ? Json::boolean(true) : Json());
    if (p.frame_blend) {
      update_node_layer_time_frame_blend(d, id, *p.frame_blend == api::FrameBlend::frame_mix     ? "mix"
                                                : *p.frame_blend == api::FrameBlend::pixel_motion ? "pixelMotion"
                                                                                                  : "none");
    }
    if (p.auto_orient) {
      if (*p.auto_orient == api::AutoOrient::off) {
        sg_set_fx(d, id, "autoOrient", Json());
      } else {
        sg_set_fx(d, id, "autoOrient", Json::boolean(true));
        if (*p.auto_orient == api::AutoOrient::towards_camera) sg_set_fx(d, id, "autoOrient", Json::string("camera"));
      }
    }
    if (p.preserve_transparency) sg_set_fx(d, id, "preserveTransparency", *p.preserve_transparency ? Json::boolean(true) : Json());
  }
  return {};
}

ResultOf<api::ReplaceLayerSource> handle(const api::ReplaceLayerSource& c, HCtx& x) {
  Document& d = x.d;
  const Node& node = require_layer(d, c.layer);
  const std::string comp = comp_of_layer(d, c.layer).value_or("");
  const bool isComp = read_comp_ref(node).has_value();
  const Json* asset = nullptr;
  if (isComp) {
    if (!is_comp_item(d, c.source)) fail(ErrorCode::not_found, "no composition '" + c.source + "'", {.item = c.source});
    if (would_create_comp_cycle(d, comp, c.source)) fail(ErrorCode::cycle, "that composition already contains this one");
  } else {
    const std::string kind = node.kind();
    if (kind != "image" && kind != "video" && kind != "audio" && kind != "svg") {
      fail(ErrorCode::invalid_argument, "only footage and precomp layers have a source", {.layer = c.layer});
    }
    asset = find_asset(d, c.source);
    if (asset == nullptr) fail(ErrorCode::not_found, "no footage item '" + c.source + "'", {.item = c.source});
  }
  x.label = "Replace Layer Source";
  const Node& n = *d.node(c.layer);
  const Component* fx = n.comp("fx");
  const Component* t = n.comp("Transform");
  const std::optional<std::string> fxId = fx != nullptr ? std::optional<std::string>(fx->id) : std::nullopt;
  const std::optional<std::string> tId = t != nullptr ? std::optional<std::string>(t->id) : std::nullopt;
  if (isComp) {
    if (fxId) (void)sg_write_prop(d, c.layer, *fxId, "__compRef", Json::string(c.source));
    if (!c.keep_size && tId) {
      const Json& s = *d.comp(c.source);
      write_transform_props(x, c.layer, {{"width", s.at("width").num()}, {"height", s.at("height").num()}});
    }
    return {};
  }
  const Json a = *asset;
  if (const Component* audio = n.comp("Audio")) {
    const std::string aid = audio->id;
    (void)sg_write_prop(d, c.layer, aid, "__assetId", a.at("id"));
    (void)sg_write_prop(d, c.layer, aid, "__src", a.at("src"));
  } else if (tId) {
    (void)sg_write_prop(d, c.layer, *tId, "assetId", a.at("id"));
    (void)sg_write_prop(d, c.layer, *tId, "src", a.at("src"));
    if (!c.keep_size) {
      const Json& md = a.at("metadata");
      const Json& par = a.at("interpret").at("par");
      const double w = md.at("width").is_undefined() || md.at("width").is_null() ? 400.0 : md.at("width").num();
      const double h = md.at("height").is_undefined() || md.at("height").is_null() ? 400.0 : md.at("height").num();
      const double pr = par.is_undefined() || par.is_null() ? 1.0 : par.num();
      write_transform_props(x, c.layer, {{"width", motion::js::round(w * pr)}, {"height", h}});
    }
  }
  return {};
}

ResultOf<api::GroupLayers> handle(const api::GroupLayers& c, HCtx& x) {
  Document& d = x.d;
  const std::string comp = require_layers_in_one_comp(d, c.layers);
  const std::string parent = *d.node(c.layers[0])->parent;
  for (const auto& id : c.layers) {
    if (d.node(id)->parent != parent) fail(ErrorCode::invalid_argument, "grouped layers must share a parent", {.layer = id});
  }
  const std::string id = x.mint_id("group_");
  const Json* settings = d.comp(comp);
  if (settings == nullptr) fail(ErrorCode::not_found, "no composition '" + comp + "'", {.item = comp});
  const Json rec = *settings;
  x.label = "Group Layers";
  const std::vector<std::string> order = sg_child_order(d, parent);
  const std::set<std::string> members(c.layers.begin(), c.layers.end());
  std::ptrdiff_t front = -1;
  for (const auto& l : c.layers) {
    const auto it = std::find(order.begin(), order.end(), l);
    front = std::max(front, it == order.end() ? std::ptrdiff_t{-1} : it - order.begin());
  }
  FactoryInput fi;
  fi.kind = api::LayerKind::group;
  fi.id = id;
  fi.name = c.name.empty() ? std::string("Group") : c.name;
  fi.comp = &rec;
  Node node = make_layer_node(fi);
  node.parent = parent;
  sg_add_child(d, parent, std::move(node));
  std::vector<std::string> kids;
  for (const auto& k : sg_child_order(d, parent)) {
    if (k != id) kids.push_back(k);
  }
  std::size_t slot = 0;
  for (std::size_t i = 0; i < kids.size(); ++i) {
    if (static_cast<std::ptrdiff_t>(i) <= front && !members.contains(kids[i])) ++slot;
  }
  kids.insert(kids.begin() + static_cast<std::ptrdiff_t>(slot), id);
  (void)sg_set_child_order(d, parent, kids);
  const PCtx pc = x.pc();
  for (const auto& m : order) {
    if (members.contains(m)) set_parent_preserving_world(pc, m, id);
  }
  tl_sync_from_scene(d, comp);
  return api::LayerRef{id};
}

ResultOf<api::UngroupLayer> handle(const api::UngroupLayer& c, HCtx& x) {
  Document& d = x.d;
  const Node& node = require_layer(d, c.group);
  if (node.kind() != "group") fail(ErrorCode::invalid_argument, "'" + c.group + "' is not a group layer", {.layer = c.group});
  const std::string comp = comp_of_layer(d, c.group).value_or("");
  x.label = "Ungroup";
  const std::string parent = *node.parent;
  const std::vector<std::string> members = sg_child_order(d, c.group);
  const PCtx pc = x.pc();
  for (const auto& m : members) set_parent_preserving_world(pc, m, parent);
  std::vector<std::string> kids;
  for (const auto& k : sg_child_order(d, parent)) {
    if (std::find(members.begin(), members.end(), k) == members.end()) kids.push_back(k);
  }
  const auto it = std::find(kids.begin(), kids.end(), c.group);
  const std::ptrdiff_t at = it == kids.end() ? 0 : it - kids.begin();
  kids.insert(kids.begin() + at, members.begin(), members.end());
  (void)sg_set_child_order(d, parent, kids);
  (void)delete_layer_node(d, c.group);
  tl_sync_from_scene(d, comp);
  api::LayerList out;
  out.layers.assign(members.rbegin(), members.rend());
  return out;
}

api::DocumentFragment encode_fragment(const PCtx& c, const std::vector<std::string>& layers) {
  const Document& d = c.d;
  Json out = Json::array();
  std::function<void(const std::string&)> visit = [&](const std::string& id) {
    const Node* n = d.node(id);
    if (n == nullptr) return;
    Json l = Json::object();
    l.set("row", node_row_json(*n));
    const NodeAnim* a = d.anim(id);
    l.set("anim", a != nullptr ? anim_to_json(*a, id) : Json::null());
    Json bars = Json::array();
    const auto comp = comp_of_layer(d, id);
    if (comp) {
      for (const Bar* b : bars_of(d, id, *comp)) {
        Json bj = Json::object();
        bj.set("start", Json::number(b->clip.start));
        bj.set("duration", Json::number(b->clip.duration));
        bj.set("sourceIn", Json::number(b->clip.sourceIn));
        bj.set("sourceDuration", b->clip.sourceDuration ? Json::number(*b->clip.sourceDuration) : Json::null());
        bars.arr_mut().push_back(std::move(bj));
      }
    }
    l.set("bars", std::move(bars));
    out.arr_mut().push_back(std::move(l));
    const auto kids = sg_child_order(d, id);
    for (auto it = kids.rbegin(); it != kids.rend(); ++it) {
      if (std::find(layers.begin(), layers.end(), *it) == layers.end()) visit(*it);
    }
  };
  for (const auto& id : layers) visit(id);
  Json data = Json::object();
  data.set("layers", std::move(out));
  const std::string text = js::stringify(data);
  api::DocumentFragment f;
  f.version = kFragmentVersion;
  f.data.assign(text.begin(), text.end());
  return f;
}

ResultOf<api::PasteLayers> handle(const api::PasteLayers& c, HCtx& x) {
  Document& d = x.d;
  require_comp(d, c.comp);
  const std::vector<FragmentLayer> frag = decode_fragment(c.fragment);
  const std::size_t count = layer_ids_of_comp(d, c.comp).size();
  if (c.index && *c.index > count) fail(ErrorCode::out_of_range, "index " + std::to_string(*c.index) + " is past the " + std::to_string(count) + " layers");
  for (const auto& l : frag) {
    if (l.row.at("components").is_array()) {
      for (const Json& comp : l.row.at("components").arr()) {
        const Json& ref = comp.at("props").at("__compRef");
        if (ref.is_string() && ref.str() == c.comp) fail(ErrorCode::cycle, "a pasted precomp layer would contain its own composition");
      }
    }
  }
  std::vector<std::pair<std::string, std::string>> idMap;
  auto mapped = [&](const std::string& old) -> std::optional<std::string> {
    for (const auto& [a, b] : idMap) {
      if (a == old) return b;
    }
    return std::nullopt;
  };
  for (const auto& l : frag) idMap.emplace_back(l.row.at("id").str(), x.mint_id("layer_"));
  x.label = "Paste " + plural(frag.size(), "Layer");
  const double fps = comp_fps(d, c.comp);
  double minIn = std::numeric_limits<double>::infinity();
  for (const auto& l : frag) minIn = std::min(minIn, l.bars.empty() ? 0.0 : l.bars[0].start);
  const double shift = c.time ? flicks_to_frames(*c.time, fps) - (std::isfinite(minIn) ? minIn : 0.0) : 0.0;
  for (const auto& l : frag) {
    const std::string id = *mapped(l.row.at("id").str());
    const Json& rp = l.row.at("parent");
    const std::string parent = rp.is_string() && mapped(rp.str()) ? *mapped(rp.str()) : c.comp;
    Node row;
    row.id = id;
    row.name = l.row.at("name").is_string() ? l.row.at("name").str() : id;
    row.parent = parent;
    row.visible = !(l.row.at("visible").is_bool() && !l.row.at("visible").b());
    row.locked = l.row.at("locked").is_bool() && l.row.at("locked").b();
    row.solo = l.row.at("solo").is_bool() && l.row.at("solo").b();
    row.shy = l.row.at("shy").is_bool() && l.row.at("shy").b();
    if (l.row.at("color").is_string()) row.color = l.row.at("color").str();
    if (l.row.at("components").is_array()) {
      for (const Json& comp : l.row.at("components").arr()) {
        const std::string type = comp.at("type").is_string() ? comp.at("type").str() : "";
        row.components.push_back(Component{id + "_" + type, type, comp.at("props").is_object() ? comp.at("props") : Json::object()});
      }
    }
    sg_add_child(d, parent, std::move(row));
    if (l.anim) d.set_anim(id, *l.anim);
    remint_key_ids(x, id);
  }
  tl_sync_from_scene(d, c.comp);
  for (const auto& l : frag) {
    if (l.bars.empty()) continue;
    std::vector<Geo> g = l.bars;
    for (Geo& b : g) b.start += shift;
    write_geoms(d, c.comp, *mapped(l.row.at("id").str()), g);
  }
  std::vector<std::string> tops;
  for (const auto& l : frag) {
    const Json& rp = l.row.at("parent");
    if (!rp.is_string() || !mapped(rp.str())) tops.push_back(*mapped(l.row.at("id").str()));
  }
  if (!tops.empty()) move_in_stack(d, c.comp, tops, c.index.value_or(0));
  api::LayerList out;
  for (const auto& l : frag) out.layers.push_back(*mapped(l.row.at("id").str()));
  return out;
}

ResultOf<api::DuplicateLayers> handle(const api::DuplicateLayers& c, HCtx& x) {
  Document& d = x.d;
  const std::string comp = require_layers_in_one_comp(d, c.layers);
  std::vector<std::string> newIds;
  for (std::size_t i = 0; i < c.layers.size(); ++i) newIds.push_back(x.mint_id("layer_"));
  x.label = "Duplicate " + plural(c.layers.size(), "Layer");
  for (std::size_t i = 0; i < c.layers.size(); ++i) {
    const std::string& src = c.layers[i];
    const std::string& id = newIds[i];
    if (!clone_layer_node(d, src, id)) fail(ErrorCode::internal, "could not duplicate '" + src + "'", {.layer = src});
    const Node srcNode = *d.node(src);
    {
      Node& copy = d.node_mut(id);
      if (srcNode.solo) copy.solo = true;
      if (srcNode.shy) copy.shy = true;
      if (srcNode.color) copy.color = srcNode.color;
      if (!srcNode.name.empty()) copy.name = srcNode.name;
    }
    remint_key_ids(x, id);
    tl_sync_from_scene(d, comp);
    write_geoms(d, comp, id, geoms_of(d, src, comp));
  }
  return api::LayerList{newIds};
}

ResultOf<api::ConvertLayer> handle(const api::ConvertLayer& c, HCtx& x) {
  (void)require_layer(x.d, c.layer);
  fail(ErrorCode::unsupported, "'" + std::string(api::to_string(c.conversion)) +
                                   "' needs font outlines / evaluation the TypeScript engine only offers through editor dialogs "
                                   "today; it moves into the engine with E3");
}

ResultOf<api::SeparateLayer> handle(const api::SeparateLayer& c, HCtx& x) {
  (void)require_layer(x.d, c.layer);
  fail(ErrorCode::unsupported, "Separate (break apart) is not implemented by the TypeScript engine");
}

ResultOf<api::AutoTrace> handle(const api::AutoTrace& c, HCtx& x) {
  (void)require_layer(x.d, c.layer);
  fail(ErrorCode::unsupported, "Auto-trace reads rendered pixels; in the TypeScript engine it runs from the editor (a job in phase E)");
}

}  // namespace premation::doc
