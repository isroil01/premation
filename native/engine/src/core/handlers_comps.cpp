#include "handlers_comps.hpp"

#include <algorithm>
#include <cmath>
#include <functional>
#include <map>
#include <set>

#include "fxstate.hpp"
#include "handlers_layers.hpp"
#include "props.hpp"
#include "readmodel.hpp"
#include "time_conv.hpp"

namespace premation::doc {

using api::ErrorCode;

namespace {

Json default_comp_record() {
  Json r = Json::object();
  r.set("width", Json::number(1920));
  r.set("height", Json::number(1080));
  r.set("fps", Json::number(30));
  r.set("durationSeconds", Json::number(10));
  r.set("background", Json::string("#101014"));
  r.set("transparent", Json::boolean(false));
  r.set("startFrame", Json::number(0));
  return r;
}

double rational_to_fps(const api::Rational& r) {
  if (!(r.num > 0) || !(r.den > 0)) fail(ErrorCode::invalid_argument, "frame rate must be positive");
  return static_cast<double>(r.num) / static_cast<double>(r.den);
}

bool blank(std::string_view s) {
  return std::all_of(s.begin(), s.end(), [](char ch) { return ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' || ch == '\f' || ch == '\v'; });
}

/// comps.ts `patchToStore(p)`: validated store fields (undefined = delete).
Json patch_to_store(const api::CompSettingsPatch& p) {
  Json out = Json::object();
  if (p.name) {
    if (blank(*p.name)) fail(ErrorCode::invalid_argument, "a composition name cannot be empty");
    out.set("name", Json::string(*p.name));
  }
  if (p.width) {
    if (!(*p.width >= 4 && *p.width <= 30000)) fail(ErrorCode::out_of_range, "width must be 4…30000");
    out.set("width", Json::number(*p.width));
  }
  if (p.height) {
    if (!(*p.height >= 4 && *p.height <= 30000)) fail(ErrorCode::out_of_range, "height must be 4…30000");
    out.set("height", Json::number(*p.height));
  }
  if (p.pixel_aspect) {
    if (!(*p.pixel_aspect > 0)) fail(ErrorCode::out_of_range, "pixel aspect must be positive");
    out.set("pixelAspect", Json::number(*p.pixel_aspect));
  }
  if (p.frame_rate) {
    const double fps = rational_to_fps(*p.frame_rate);
    if (!(fps >= 1 && fps <= 999)) fail(ErrorCode::out_of_range, "frame rate must be 1…999");
    out.set("fps", Json::number(fps));
  }
  if (p.duration) {
    if (*p.duration <= 0) fail(ErrorCode::out_of_range, "duration must be positive");
    out.set("durationSeconds", Json::number(flicks_to_seconds(*p.duration)));
  }
  if (p.background) {
    const api::Color& c = *p.background;
    out.set("background", Json::string(channels_to_color(c.r, c.g, c.b, c.a)));
  }
  if (p.background_gradient) {
    fail(ErrorCode::unsupported, "gradient backgrounds are set through the Composition Settings dialog until B3 types FillPaint");
  }
  if (p.clear_background_gradient && *p.clear_background_gradient) out.set("backgroundPaint", Json());
  if (p.transparent) out.set("transparent", Json::boolean(*p.transparent));
  if (p.renderer3d) out.set("renderer3d", Json::string(std::string(api::to_string(*p.renderer3d))));
  if (p.global_light_angle) out.set("globalLightAngle", Json::number(*p.global_light_angle));
  if (p.global_light_altitude) {
    if (!(*p.global_light_altitude >= 0 && *p.global_light_altitude <= 90)) {
      fail(ErrorCode::out_of_range, "global light altitude must be 0…90");
    }
    out.set("globalLightAltitude", Json::number(*p.global_light_altitude));
  }
  if (p.drop_frame) out.set("dropFrame", Json::boolean(*p.drop_frame));
  if (p.preserve_frame_rate) out.set("preserveFrameRate", Json::boolean(*p.preserve_frame_rate));
  if (p.preserve_resolution) out.set("preserveResolution", Json::boolean(*p.preserve_resolution));
  if (p.world) {
    auto w = js::parse(*p.world);
    if (!w) fail(ErrorCode::invalid_argument, "world must be JSON");
    for (const char* k : {"defaultEnvPreset", "groundLevel", "showSkyBackdrop", "ssao"}) {
      if (w->is_object() && w->has(k)) out.set(k, w->at(k));
    }
  }
  return out;
}

Node comp_root_node(const std::string& id, const std::string& name) {
  Node n;
  n.id = id;
  n.name = name;
  Json p = Json::object();
  p.set("__kind", Json::string("group"));
  n.components.push_back(Component{id + "_meta", "group", std::move(p)});
  return n;
}

const Json* find_asset_record(const Document& d, const std::string& id) {
  for (const Json& a : d.items().assets) {
    if (a.at("id").is_string() && a.at("id").str() == id) return &a;
  }
  return nullptr;
}

api::LayerKind footage_kind(const Json& a) {
  const std::string t = a.at("type").is_string() ? a.at("type").str() : "";
  return t == "audio" ? api::LayerKind::audio : t == "video" ? api::LayerKind::video : api::LayerKind::image;
}

double num_or_null(const Json& v, double fb) { return v.is_undefined() || v.is_null() ? fb : v.num(); }

/// Deep copy of a composition's layers into `newComp` (fresh ids), animation and bars included.
void copy_comp_contents(HCtx& x, const std::string& src, const std::string& newComp,
                        const std::map<std::string, std::string>& refMap) {
  Document& d = x.d;
  std::vector<std::pair<std::string, std::string>> idMap{{src, newComp}};
  std::function<void(const std::string&, const std::string&)> walk = [&](const std::string& parentOld,
                                                                         const std::string& parentNew) {
    for (const auto& childOld : sg_child_order(d, parentOld)) {
      const Node* n = d.node(childOld);
      if (n == nullptr) continue;
      const std::string id = x.mint_id("layer_");
      idMap.emplace_back(childOld, id);
      const auto ref = read_comp_ref(*n);
      Node row;
      row.id = id;
      row.name = n->name;
      row.parent = parentNew;
      row.visible = n->visible;
      row.locked = n->locked;
      row.solo = n->solo;
      row.shy = n->shy;
      row.color = n->color;
      for (const Component& comp : n->components) {
        Json props = comp.props;
        if (ref && props.at("__compRef").is_string() && props.at("__compRef").str() == *ref) {
          const auto it = refMap.find(*ref);
          if (it != refMap.end()) props.set("__compRef", Json::string(it->second));
        }
        row.components.push_back(Component{id + "_" + comp.type, comp.type, std::move(props)});
      }
      const NodeAnim* a = d.anim(childOld);
      std::optional<NodeAnim> snap = a != nullptr ? std::optional<NodeAnim>(*a) : std::nullopt;
      sg_add_child(d, parentNew, std::move(row));
      if (snap) d.set_anim(id, std::move(*snap));
      remint_key_ids(x, id);
      walk(childOld, id);
    }
  };
  walk(src, newComp);
  tl_sync_from_scene(d, newComp);
  for (const auto& [oldId, newId] : idMap) {
    if (oldId == src) continue;
    const auto g = geoms_of(d, oldId, src);
    if (!g.empty()) write_geoms(d, newComp, newId, g);
  }
  const Timeline* from = d.timeline(src);
  if (from != nullptr && d.timeline(newComp) != nullptr) {
    const std::optional<FrameRange> wa = from->workArea;
    const std::vector<TMarker> markers = from->markers;
    std::vector<TMarker> copies;
    for (const TMarker& m : markers) {
      TMarker c = m;
      c.id = x.mint_marker_id();
      copies.push_back(std::move(c));
    }
    Timeline& to = d.timeline_mut(newComp);
    to.workArea = wa;
    for (auto& m : copies) markers_insert(to.markers, std::move(m));
  }
}

void nested_comps(const Document& d, const std::string& comp, std::vector<std::string>& seen) {
  for (const auto& id : layer_ids_of_comp(d, comp)) {
    const auto ref = read_comp_ref(*d.node(id));
    if (ref && std::find(seen.begin(), seen.end(), *ref) == seen.end() && is_comp_item(d, *ref)) {
      seen.push_back(*ref);
      nested_comps(d, *ref, seen);
    }
  }
}

}  // namespace

void create_comp_record(Document& d, const std::string& id, const Json& fields) {
  Json rec = default_comp_record();
  rec.set("name", Json::string("Composition"));
  rec = spread(rec, fields);
  rec.set("id", Json::string(id));
  d.comp_mut(id) = rec;
  sg_add_node(d, comp_root_node(id, rec.at("name").is_string() ? rec.at("name").str() : "Composition"));
  ensure_timeline(d, id);
}

void apply_comp_fields(Document& d, const std::string& comp, const Json& fields, std::optional<api::Time> startTimecode) {
  Json next = spread(*d.comp(comp), fields);
  if (startTimecode) next.set("startFrame", Json::number(flicks_to_frames(*startTimecode, next.at("fps").num())));
  for (const auto& m : fields.obj()) {
    if (m.value.is_undefined()) next.erase(m.key);
  }
  d.comp_mut(comp) = next;
  if (fields.has("name") && fields.at("name").is_string()) d.node_mut(comp).name = fields.at("name").str();
  if (!tl_ensure(d, comp)) return;
  Timeline& t = d.timeline_mut(comp);
  if (fields.at("fps").is_number() && t.fps != fields.at("fps").num()) tl_set_frame_rate(t, fields.at("fps").num());
  const double frames = std::max(1.0, motion::js::round(next.at("durationSeconds").num() * next.at("fps").num()));
  if (t.duration != frames) tl_set_duration(t, frames);
  if (t.loop) t.loop = t.workArea ? *t.workArea : FrameRange{0, t.duration};
}

void set_work_area(Document& d, const std::string& comp, api::Time startFlicks, api::Time durationFlicks) {
  const double fps = comp_fps(d, comp);
  if (!tl_ensure(d, comp)) return;
  const double tdur = d.timeline(comp)->duration;
  const double start = std::max(0.0, flicks_to_frames(startFlicks, fps));
  const double end = std::min(tdur, flicks_to_frames(startFlicks + durationFlicks, fps));
  if (end <= start) fail(ErrorCode::out_of_range, "the work area must lie inside the composition");
  Timeline& t = d.timeline_mut(comp);
  t.workArea = FrameRange{start, end - start};
  if (t.loop) t.loop = FrameRange{start, end - start};
}

ResultOf<api::CreateComposition> handle(const api::CreateComposition& c, HCtx& x) {
  Document& d = x.d;
  Json fields = patch_to_store(c.settings);
  if (c.folder && find_folder(d, *c.folder) == nullptr) fail(ErrorCode::not_found, "no folder '" + *c.folder + "'", {.item = *c.folder});
  std::vector<Json> assets;
  for (const auto& id : c.from_items) {
    const Json* a = find_asset_record(d, id);
    if (a == nullptr) fail(ErrorCode::not_found, "no footage item '" + id + "'", {.item = id});
    assets.push_back(*a);
  }
  if (!assets.empty()) {
    const Json& first = assets[0];
    const Json& md = first.at("metadata");
    const double par = num_or_null(first.at("interpret").at("par"), 1);
    if (!fields.has("width") && md.at("width").is_number() && md.at("width").num() != 0) {
      fields.set("width", Json::number(motion::js::round(md.at("width").num() * par)));
    }
    if (!fields.has("height") && md.at("height").is_number() && md.at("height").num() != 0) fields.set("height", md.at("height"));
    if (!fields.has("fps") && md.at("fps").is_number() && md.at("fps").num() != 0) fields.set("fps", md.at("fps"));
    if (!fields.has("durationSeconds") && md.at("duration").is_number() && md.at("duration").num() != 0) {
      fields.set("durationSeconds", md.at("duration"));
    }
    if (!fields.has("name")) fields.set("name", first.at("name"));
  }
  if (c.folder) fields.set("folderId", Json::string(*c.folder));
  const std::string id = x.mint_id("comp_");
  std::vector<std::string> layerIds;
  for (std::size_t i = 0; i < assets.size(); ++i) layerIds.push_back(x.mint_id("layer_"));
  x.label = "New Composition";
  create_comp_record(d, id, fields);
  const Json settings = *d.comp(id);
  for (std::size_t i = 0; i < assets.size(); ++i) {
    FactoryInput fi;
    fi.kind = footage_kind(assets[i]);
    fi.id = layerIds[i];
    fi.comp = &settings;
    fi.asset = &assets[i];
    Node node = make_layer_node(fi);
    sg_add_child(d, id, std::move(node));
  }
  tl_sync_from_scene(d, id);
  return api::ItemRef{id};
}

ResultOf<api::DuplicateComposition> handle(const api::DuplicateComposition& c, HCtx& x) {
  Document& d = x.d;
  require_comp(d, c.comp);
  const Json src = *d.comp(c.comp);
  std::vector<std::string> nested;
  if (c.deep) nested_comps(d, c.comp, nested);
  const std::string newId = x.mint_id("comp_");
  std::vector<std::string> nestedIds;
  for (std::size_t i = 0; i < nested.size(); ++i) nestedIds.push_back(x.mint_id("comp_"));
  x.label = "Duplicate Composition";
  std::map<std::string, std::string> refMap;
  for (std::size_t i = 0; i < nested.size(); ++i) refMap.emplace(nested[i], nestedIds[i]);
  auto name2 = [](const Json& rec) {
    const Json& n = rec.at("name");
    return (n.is_string() ? n.str() : js::stringify(n)) + " 2";
  };
  for (auto it = nested.rbegin(); it != nested.rend(); ++it) {
    Json s = *d.comp(*it);
    s.erase("id");
    s.set("name", Json::string(name2(*d.comp(*it))));
    create_comp_record(d, refMap.at(*it), s);
    copy_comp_contents(x, *it, refMap.at(*it), refMap);
  }
  Json rest = src;
  rest.erase("id");
  rest.erase("pristine");
  rest.set("name", Json::string(name2(src)));
  create_comp_record(d, newId, rest);
  copy_comp_contents(x, c.comp, newId, refMap);
  return api::ItemRef{newId};
}

ResultOf<api::SetCompositionSettings> handle(const api::SetCompositionSettings& c, HCtx& x) {
  Document& d = x.d;
  require_comp(d, c.comp);
  const Json fields = patch_to_store(c.patch);
  ensure_timeline(d, c.comp);
  x.label = "Composition Settings";
  Json clean = fields;
  const Json* cur = d.comp(c.comp);
  if (!fields.has("pristine") && cur != nullptr && cur->at("pristine").is_bool() && cur->at("pristine").b()) {
    clean.set("pristine", Json());
  }
  apply_comp_fields(d, c.comp, clean, c.patch.start_timecode);
  if (c.patch.work_area) set_work_area(d, c.comp, c.patch.work_area->start, c.patch.work_area->duration);
  if (c.patch.motion_blur) {
    const api::MotionBlurSettings& mb = *c.patch.motion_blur;
    MotionBlur& m = d.motion_blur_mut();
    m.shutterAngle = mb.shutter_angle;
    m.shutterPhase = mb.shutter_phase;
    m.samples = mb.samples_per_frame;
    m.adaptiveSampleLimit = mb.adaptive_sample_limit;
    if (mb.enabled) m.enabled = *mb.enabled;
  }
  return {};
}

ResultOf<api::SetWorkArea> handle(const api::SetWorkArea& c, HCtx& x) {
  Document& d = x.d;
  require_comp(d, c.comp);
  if (c.range.duration <= 0 || c.range.start < 0) {
    fail(ErrorCode::out_of_range, "the work area must be a positive range inside the composition");
  }
  ensure_timeline(d, c.comp);
  x.label = "Work Area";
  set_work_area(d, c.comp, c.range.start, c.range.duration);
  return {};
}

ResultOf<api::TrimCompToWorkArea> handle(const api::TrimCompToWorkArea& c, HCtx& x) {
  Document& d = x.d;
  require_comp(d, c.comp);
  ensure_timeline(d, c.comp);
  const Timeline* t = d.timeline(c.comp);
  if (t == nullptr || !t->workArea) fail(ErrorCode::invalid_argument, "the composition has no work area");
  const FrameRange wa = *t->workArea;
  x.label = "Trim Comp to Work Area";
  const double fps = comp_fps(d, c.comp);
  for (const auto& id : layer_ids_of_comp(d, c.comp)) {
    std::vector<Geo> g = geoms_of(d, id, c.comp);
    if (g.empty()) continue;
    for (Geo& b : g) b.start -= wa.start;
    write_geoms(d, c.comp, id, g);
  }
  {
    Timeline& tm = d.timeline_mut(c.comp);
    for (TMarker& m : tm.markers) m.frame -= wa.start;
    markers_reindex(tm.markers);
  }
  Json f = Json::object();
  f.set("durationSeconds", Json::number(wa.duration / fps));
  apply_comp_fields(d, c.comp, f);
  Timeline& tm = d.timeline_mut(c.comp);
  tm.workArea.reset();
  if (tm.loop) tm.loop = FrameRange{0, tm.duration};
  return {};
}

ResultOf<api::CropComposition> handle(const api::CropComposition& c, HCtx& x) {
  Document& d = x.d;
  require_comp(d, c.comp);
  const api::Rect& r = c.region;
  if (!(r.width >= 4 && r.height >= 4)) fail(ErrorCode::out_of_range, "the region must be at least 4×4");
  const std::vector<std::string> tops = sg_child_order(d, c.comp);
  x.label = "Crop Composition";
  Json f = Json::object();
  f.set("width", Json::number(motion::js::round(r.width)));
  f.set("height", Json::number(motion::js::round(r.height)));
  apply_comp_fields(d, c.comp, f);
  for (const auto& id : tops) {
    for (const auto& [axis, delta] : {std::pair<const char*, double>{"x", -r.x}, std::pair<const char*, double>{"y", -r.y}}) {
      if (auto v = read_static_property_value(d, id, axis)) (void)write_static_property_value(d, id, axis, *v + delta);
      if (const auto* kfs = anim_track(d, id, axis)) {
        std::vector<Key> next = *kfs;
        for (Key& k : next) k.value += delta;
        anim_set_track(d, id, axis, std::move(next));
      }
    }
  }
  return {};
}

ResultOf<api::AssembleComposition> handle(const api::AssembleComposition& c, HCtx& x) {
  Document& d = x.d;
  if (c.items.empty()) fail(ErrorCode::invalid_argument, "no items given");
  std::vector<Json> assets;
  for (const auto& id : c.items) {
    const Json* a = find_asset_record(d, id);
    if (a == nullptr) fail(ErrorCode::not_found, "no footage item '" + id + "'", {.item = id});
    assets.push_back(*a);
  }
  const Json& first = assets[0];
  const Json& fmd = first.at("metadata");
  const double fps = fmd.at("fps").is_number() && fmd.at("fps").num() > 0 ? fmd.at("fps").num() : 30.0;
  std::vector<double> clipFrames;
  for (const Json& a : assets) {
    clipFrames.push_back(std::max(1.0, motion::js::round(num_or_null(a.at("metadata").at("duration"), 5) * fps)));
  }
  const double overlap = flicks_to_frames(c.overlap, fps);
  double total = 0;
  for (const double f : clipFrames) total += f;
  total -= overlap * static_cast<double>(assets.size() - 1);
  const std::string id = x.mint_id("comp_");
  std::vector<std::string> layerIds;
  for (std::size_t i = 0; i < assets.size(); ++i) layerIds.push_back(x.mint_id("layer_"));
  x.label = "Assemble Composition";
  Json fields = Json::object();
  fields.set("name", c.name.empty() ? first.at("name") : Json::string(c.name));
  fields.set("width", Json::number(motion::js::round(num_or_null(fmd.at("width"), 1920) * num_or_null(first.at("interpret").at("par"), 1))));
  fields.set("height", Json::number(num_or_null(fmd.at("height"), 1080)));
  fields.set("fps", Json::number(fps));
  fields.set("durationSeconds", Json::number(std::max(1.0, total) / fps));
  create_comp_record(d, id, fields);
  const Json settings = *d.comp(id);
  for (std::size_t i = 0; i < assets.size(); ++i) {
    FactoryInput fi;
    fi.kind = footage_kind(assets[i]);
    fi.id = layerIds[i];
    fi.comp = &settings;
    fi.asset = &assets[i];
    sg_add_child(d, id, make_layer_node(fi));
  }
  tl_sync_from_scene(d, id);
  double at = 0;
  for (std::size_t i = 0; i < assets.size(); ++i) {
    const auto g = geoms_of(d, layerIds[i], id);
    if (!g.empty()) {
      Geo n = g[0];
      n.start = at;
      n.duration = clipFrames[i];
      n.sourceIn = 0;
      write_geoms(d, id, layerIds[i], {n});
    }
    at += clipFrames[i] - overlap;
  }
  return api::ItemRef{id};
}

}  // namespace premation::doc
