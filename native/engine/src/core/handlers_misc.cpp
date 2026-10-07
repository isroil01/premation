#include "handlers_misc.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <string_view>
#include <vector>
#include <utility>

#include "anim_json.hpp"
#include "bundle_io.hpp"
#include "core/aep/aep_apply.hpp"
#include "core/aep/aep_plan.hpp"
#include "core/aep/aep_read.hpp"
#include "docio.hpp"
#include "fxstate.hpp"
#include "jsmath.hpp"
#include "handlers_items.hpp"
#include "handlers_layers.hpp"
#include "readmodel.hpp"
#include "scene.hpp"
#include "time_conv.hpp"

namespace premation::doc {

using api::ErrorCode;

namespace {

std::string to_base64(const std::vector<std::uint8_t>& bytes) {
  static constexpr char kAlphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve(((bytes.size() + 2) / 3) * 4);
  std::size_t i = 0;
  for (; i + 2 < bytes.size(); i += 3) {
    const std::uint32_t n = (std::uint32_t{bytes[i]} << 16U) | (std::uint32_t{bytes[i + 1]} << 8U) | bytes[i + 2];
    out.push_back(kAlphabet[(n >> 18U) & 63U]);
    out.push_back(kAlphabet[(n >> 12U) & 63U]);
    out.push_back(kAlphabet[(n >> 6U) & 63U]);
    out.push_back(kAlphabet[n & 63U]);
  }
  const std::size_t rest = bytes.size() - i;
  if (rest == 1) {
    const std::uint32_t n = std::uint32_t{bytes[i]} << 16U;
    out.push_back(kAlphabet[(n >> 18U) & 63U]);
    out.push_back(kAlphabet[(n >> 12U) & 63U]);
    out += "==";
  } else if (rest == 2) {
    const std::uint32_t n = (std::uint32_t{bytes[i]} << 16U) | (std::uint32_t{bytes[i + 1]} << 8U);
    out.push_back(kAlphabet[(n >> 18U) & 63U]);
    out.push_back(kAlphabet[(n >> 12U) & 63U]);
    out.push_back(kAlphabet[(n >> 6U) & 63U]);
    out.push_back('=');
  }
  return out;
}

bool ends_with_motion(std::string_view p) {
  constexpr std::string_view ext = ".motion";
  if (p.size() < ext.size()) return false;
  for (std::size_t i = 0; i < ext.size(); ++i) {
    char ch = p[p.size() - ext.size() + i];
    if (ch >= 'A' && ch <= 'Z') ch = static_cast<char>(ch - 'A' + 'a');
    if (ch != ext[i]) return false;
  }
  return true;
}

/// `cmd.path.replace(/^.*[\\/]/, '').replace(/\.motion$/i, '')`.
std::string folder_name_of(std::string_view path) {
  const std::size_t slash = path.find_last_of("/\\");
  std::string_view base = slash == std::string_view::npos ? path : path.substr(slash + 1);
  if (ends_with_motion(base)) base.remove_suffix(7);
  if (is_mogrt_path(base)) base.remove_suffix(base.ends_with(".zip") || base.ends_with(".ZIP") ? 10 : 6);
  return std::string(base);
}

Json default_import_comp(const Json& name) {
  Json r = Json::object();
  r.set("width", Json::number(1920));
  r.set("height", Json::number(1080));
  r.set("fps", Json::number(30));
  r.set("durationSeconds", Json::number(10));
  r.set("background", Json::string("#101014"));
  r.set("transparent", Json::boolean(false));
  r.set("startFrame", Json::number(0));
  r.set("name", name);
  return r;
}

const Json& nullish_or(const Json& v, const Json& fb) { return v.is_undefined() || v.is_null() ? fb : v; }

}  // namespace

ResultOf<api::RestoreDocument> handle(const api::RestoreDocument& c, HCtx& x) {
  // misc.ts restoreDocument (B3z): a saved / cloud version restored as ONE
  // undoable entry — parsed and migrated before anything changes, loaded as
  // openProject loads (docio.cpp restore_document) into a scratch document
  // seeded with this one, then written back as parts inside the transaction.
  Document& d = x.d;
  const std::string text(c.document.begin(), c.document.end());
  std::optional<Json> parsed = js::parse(text);
  if (!parsed) fail(ErrorCode::decode, "the document is not a .motion project (malformed JSON)");
  if (!parsed->is_object()) fail(ErrorCode::decode, "the document is not a .motion project");
  Json doc;
  std::optional<api::EngineError> failed;
  try {
    doc = migrate_document(std::move(*parsed));
  } catch (const EngineFail& e) {
    failed = e.error;
  }
  if (failed) fail(ErrorCode::unsupported, "this engine cannot read that document: " + failed->message);
  x.label = c.label && !c.label->empty() ? *c.label : std::string("Restore Version");
  Document scratch;
  scratch.apply(d.capture_all());
  scratch.extras_mut() = d.extras();
  EditorView view;
  const RestoreResult restored = restore_document(scratch, view, doc, d.items().assets);
  // Recovering an unsaved session into a fresh project: its files are named by
  // path only, and are read again where they still are (docio.hpp).
  (void)relink_missing_footage(scratch, x.ports, {}, restored.missing);
  Parts target = scratch.capture_all();
  // What the version does not have is gone ("present key, empty pointer").
  for (const auto& [id, n] : d.nodes()) {
    if (!target.nodes.contains(id)) target.nodes.emplace(id, nullptr);
  }
  for (const auto& [id, a] : d.anims()) {
    if (!target.anims.contains(id)) target.anims.emplace(id, nullptr);
  }
  for (const auto& [id, cr] : d.comps()) {
    if (!target.comps.contains(id)) target.comps.emplace(id, nullptr);
  }
  for (const auto& [id, t] : d.timelines()) {
    if (!target.timelines.contains(id)) target.timelines.emplace(id, nullptr);
  }
  d.apply(target);
  // Plugin storage follows the version; not journaled (no command edits it).
  d.extras_mut() = scratch.extras();
  return {};
}

ResultOf<api::SetGuides> handle(const api::SetGuides& c, HCtx& x) {
  Document& d = x.d;
  const std::optional<Json> patch = js::parse(c.patch);
  if (!patch) fail(ErrorCode::decode, "the guides patch is not JSON");
  if (!patch->is_object()) fail(ErrorCode::invalid_argument, "the guides patch must be a JSON object");
  Json merged = d.guides();
  for (const auto& m : patch->obj()) merged.set(m.key, m.value);
  Json next = restore_guides(d.guides(), merged);
  d.guides_mut() = std::move(next);
  return {};
}

ResultOf<api::SetSwatches> handle(const api::SetSwatches& c, HCtx& x) {
  Json list = Json::array();
  for (std::size_t i = 0; i < c.swatches.size(); ++i) {
    const api::Swatch& s = c.swatches[i];
    if (!canonical_hex(Json::string(s.hex))) fail(ErrorCode::invalid_argument, "swatch " + std::to_string(i) + " is not a hex colour");
    Json o = Json::object();
    o.set("id", Json::string(s.id));
    o.set("name", Json::string(s.name));
    o.set("hex", Json::string(s.hex));
    list.arr_mut().push_back(std::move(o));
  }
  x.d.swatches_mut() = normalize_swatches(list);
  return {};
}

ResultOf<api::SetMaterials> handle(const api::SetMaterials& c, HCtx& x) {
  Json list = Json::array();
  for (std::size_t i = 0; i < c.materials.size(); ++i) {
    const api::LibraryMaterial& m = c.materials[i];
    std::optional<Json> params = js::parse(m.params);
    if (!params || !params->is_object()) {
      fail(ErrorCode::invalid_argument, "material " + std::to_string(i) + " params are not a JSON object");
    }
    Json o = Json::object();
    o.set("id", Json::string(m.id));
    o.set("name", Json::string(m.name));
    o.set("params", std::move(*params));
    o.set("swatch", Json::string(m.swatch));
    list.arr_mut().push_back(std::move(o));
  }
  x.d.materials_mut() = normalize_materials(list);
  return {};
}

ResultOf<api::SetMotionBlur> handle(const api::SetMotionBlur& c, HCtx& x) {
  const api::MotionBlurPatch& p = c.patch;
  const bool finite = (!p.shutter_angle || std::isfinite(*p.shutter_angle)) && (!p.shutter_phase || std::isfinite(*p.shutter_phase));
  if (!finite) fail(ErrorCode::invalid_argument, "shutter angle and phase must be finite");
  x.label = "Motion Blur";
  apply_motion_blur_patch(x.d, p);
  return {};
}

ResultOf<api::SetColorManagement> handle(const api::SetColorManagement& c, HCtx& x) {
  const api::ColorManagementPatch& p = c.patch;
  if (p.bit_depth && *p.bit_depth != 16 && *p.bit_depth != 32) fail(ErrorCode::invalid_argument, "the bit depth is 16 or 32");
  x.label = "Color Management";
  ColorMgmt& cm = x.d.color_mut();
  if (p.working_space) cm.workingSpace = *p.working_space == api::RenderWorkingSpace::aces_cg ? "aces-cg" : "srgb-linear";
  if (p.display_transform) {
    switch (*p.display_transform) {
      case api::RenderDisplayTransform::aces: cm.displayTransform = "aces"; break;
      case api::RenderDisplayTransform::pq: cm.displayTransform = "pq"; break;
      case api::RenderDisplayTransform::hlg: cm.displayTransform = "hlg"; break;
      case api::RenderDisplayTransform::srgb: cm.displayTransform = "srgb"; break;
    }
  }
  if (p.bit_depth) cm.bitDepth = *p.bit_depth == 32 ? 32 : 16;
  return {};
}

ResultOf<api::SetProjectSettings> handle(const api::SetProjectSettings& c, HCtx& x) {
  Document& d = x.d;
  const api::ProjectSettingsPatch& p = c.patch;
  if (p.frames_start_at && *p.frames_start_at > 1) fail(ErrorCode::out_of_range, "frames start at 0 or 1");
  if (p.audio_sample_rate && !(*p.audio_sample_rate >= 8000 && *p.audio_sample_rate <= 192000)) {
    fail(ErrorCode::out_of_range, "sample rate must be 8000…192000");
  }
  x.label = "Project Settings";
  api::ProjectSettings& s = d.project_mut();
  if (p.bit_depth) s.bit_depth = *p.bit_depth;
  if (p.working_space) s.working_space = *p.working_space;
  if (p.linear_blending) s.linear_blending = *p.linear_blending;
  if (p.ocio_config) s.ocio_config = *p.ocio_config;
  if (p.time_display) s.time_display = *p.time_display;
  if (p.expression_engine) s.expression_engine = *p.expression_engine;
  if (p.frames_start_at) s.frames_start_at = *p.frames_start_at;
  if (p.audio_sample_rate) s.audio_sample_rate = *p.audio_sample_rate;
  // Mirror what today's renderer can honour into colour management.
  const bool ws = p.working_space && (*p.working_space == api::ColorWorkingSpace::srgb_linear ||
                                      *p.working_space == api::ColorWorkingSpace::acescg);
  if (ws || p.bit_depth) {
    ColorMgmt& cm = d.color_mut();
    if (p.working_space == api::ColorWorkingSpace::srgb_linear) cm.workingSpace = "srgb-linear";
    if (p.working_space == api::ColorWorkingSpace::acescg) cm.workingSpace = "aces-cg";
    if (p.bit_depth == api::BitDepth::f32) cm.bitDepth = 32;
    if (p.bit_depth == api::BitDepth::u16 || p.bit_depth == api::BitDepth::u8) cm.bitDepth = 16;
  }
  return {};
}

namespace {

/// importProject of an After Effects project (core/aep/aep_apply.hpp; docs/AFTER_EFFECTS_IMPORT.md).
api::ImportProjectResult import_aep_project(const api::ImportProject& c, HCtx& x) {
  if (!x.ports.has_file_bytes()) fail(ErrorCode::unsupported, "no file port is attached to this engine");
  if (c.folder && !c.folder->empty() && find_folder(x.d, *c.folder) == nullptr) {
    fail(ErrorCode::not_found, "no folder '" + *c.folder + "'", {.item = *c.folder});
  }
  x.label = "Import After Effects Project";
  const std::vector<std::uint8_t> bytes = x.ports.read_file_bytes(c.path);
  const aep::ChunkTree tree = aep::parse_aep_bytes(bytes);
  const aep::AepProject project = aep::read_aep_project(tree.root);
  if (project.comps.empty()) {
    fail(ErrorCode::decode,
         "That After Effects project has no compositions in it. Only its footage list could be read, so there is nothing to open.");
  }
  const aep::AepImportPlan plan = aep::plan_aep_import(project);
  // The folder is named after the file: `.../Promo.aep` → "Promo".
  std::string name = folder_name_of(c.path);
  const std::size_t dot = name.find_last_of('.');
  if (dot != std::string::npos && aep::is_aep_path(name)) name.resize(dot);
  if (name.empty()) name = "After Effects Project";
  aep::AepApplyResult applied = aep::apply_aep_plan(x, plan, name, c.folder && !c.folder->empty() ? c.folder : std::nullopt);
  api::ImportProjectResult out;
  out.items = std::move(applied.items);
  out.warnings = std::move(applied.warnings);
  out.missing_footage = std::move(applied.missingFootage);
  out.open_comp = std::move(applied.openComp);
  api::AepImportSummary s;
  s.comps = plan.summary.comps;
  s.layers = plan.summary.layers;
  s.keyframes = plan.summary.keyframes;
  s.effects = plan.summary.effects;
  s.masks = plan.summary.masks;
  s.expressions = plan.summary.expressions;
  s.unmapped_effects = plan.summary.unmappedEffects;
  s.ae_version = plan.aeVersion.value_or("");
  out.summary = std::move(s);
  return out;
}

}  // namespace

ResultOf<api::ImportProject> handle(const api::ImportProject& c, HCtx& x) {
  Document& d = x.d;
  if (aep::is_aep_path(c.path)) return import_aep_project(c, x);
  if (!x.ports.has_projects()) fail(ErrorCode::unsupported, "no project file port is attached to this engine");
  if (!ends_with_motion(c.path) && !is_mogrt_path(c.path)) {
    fail(ErrorCode::unsupported, "only .motion, .mogrt, .aep and .aepx projects can be imported");
  }
  if (c.folder && !c.folder->empty() && find_folder(d, *c.folder) == nullptr) {
    fail(ErrorCode::not_found, "no folder '" + *c.folder + "'", {.item = *c.folder});
  }
  const std::string folderId = x.mint_id("folder_");
  x.label = "Import Project";
  Json doc;
  // Re-thrown outside the handler (a throw inside a catch crashes clang-cl ASan).
  std::optional<api::EngineError> failed;
  try {
    doc = migrate_document(x.ports.read_project(c.path));
  } catch (const EngineFail& e) {
    failed = e.error;
  }
  if (failed) {
    if (failed->code == ErrorCode::io) throw EngineFail{std::move(*failed)};
    fail(ErrorCode::io, "could not read '" + c.path + "': " + failed->message);
  }

  const Json& nodesJ = doc.at("scene").at("nodes");
  const Json::Array noNodes;
  const Json::Array& nodes = nodesJ.is_array() ? nodesJ.arr() : noNodes;
  std::vector<std::pair<std::string, std::string>> idMap;
  auto mapped = [&idMap](const std::string& old) -> std::optional<std::string> {
    for (const auto& [o, n] : idMap) {
      if (o == old) return n;
    }
    return std::nullopt;
  };
  for (const Json& n : nodes) {
    const std::string oldId = n.at("id").is_string() ? n.at("id").str() : "";
    const bool hasParent = n.at("parent").is_string() && !n.at("parent").str().empty();
    const std::string fresh = x.mint_id(hasParent ? "layer_" : "comp_");
    bool dup = false;
    for (auto& [o, nw] : idMap) {
      if (o == oldId) {
        nw = fresh;  // Map.set on an existing key keeps its position
        dup = true;
      }
    }
    if (!dup) idMap.emplace_back(oldId, fresh);
  }
  std::vector<std::string> created;
  {
    Folder f;
    f.id = folderId;
    f.name = folder_name_of(c.path);
    f.parentId = c.folder;
    d.items_mut().folders.push_back(std::move(f));
  }
  created.push_back(folderId);
  for (const Json& n : nodes) {
    const std::string oldId = n.at("id").is_string() ? n.at("id").str() : "";
    const std::string id = *mapped(oldId);
    Json row = n;
    row.set("id", Json::string(id));
    const bool hasParent = n.at("parent").is_string() && !n.at("parent").str().empty();
    if (hasParent) {
      const auto p = mapped(n.at("parent").str());
      row.set("parent", p ? Json::string(*p) : Json::null());
    } else {
      row.set("parent", Json::null());
    }
    if (n.at("children").is_array()) {
      Json kids = Json::array();
      for (const Json& ch : n.at("children").arr()) {
        const auto m = ch.is_string() ? mapped(ch.str()) : std::nullopt;
        kids.arr_mut().push_back(m ? Json::string(*m) : ch);
      }
      row.set("children", std::move(kids));
    }
    if (n.at("components").is_array()) {
      Json comps = Json::array();
      for (const Json& comp : n.at("components").arr()) {
        Json props = comp.at("props").is_object() ? comp.at("props") : Json::object();
        if (props.at("__compRef").is_string()) {
          if (const auto m = mapped(props.at("__compRef").str())) props.set("__compRef", Json::string(*m));
        }
        Json cj = comp;
        const std::string type = comp.at("type").is_string() ? comp.at("type").str() : "undefined";
        cj.set("id", Json::string(id + "_" + type));
        cj.set("props", std::move(props));
        comps.arr_mut().push_back(std::move(cj));
      }
      row.set("components", std::move(comps));
    }
    sg_add_node(d, node_from_json(row));
    if (!hasParent) {
      const Json& src = doc.at("comps").at(oldId);
      const bool hasSrc = src.is_object();
      const Json nodeName = nullish_or(n.at("name"), Json::string("Composition"));
      Json rec = hasSrc ? src : default_import_comp(nodeName);
      rec.set("id", Json::string(id));
      rec.set("name", hasSrc ? nullish_or(src.at("name"), nodeName) : nodeName);
      rec.set("folderId", Json::string(folderId));
      d.comp_mut(id) = std::move(rec);
      created.push_back(id);
    }
  }
  const Json& anim = doc.at("animation");
  for (const auto& [oldId, newId] : idMap) {
    const Json& tracks = anim.at("tracks").at(oldId);
    const Json& exprs = anim.at("expressions").at(oldId);
    const Json& data = anim.at("data").at(oldId);
    const auto absent = [](const Json& v) { return v.is_undefined() || v.is_null(); };
    if (absent(tracks) && absent(exprs) && absent(data)) continue;
    Json snap = Json::object();
    snap.set("tracks", absent(tracks) ? Json::object() : tracks);
    snap.set("expressions", absent(exprs) ? Json::object() : exprs);
    snap.set("data", absent(data) ? Json::object() : data);
    NodeAnim a = anim_from_json(snap);
    // restoreNode drops blank expressions.
    NodeAnim clean;
    clean.tracks = a.tracks;
    clean.data = a.data;
    for (const auto& [prop, e] : a.exprs) {
      if (!js_trim(e.src).empty()) clean.exprs.set(prop, e);
    }
    d.set_anim(newId, clean.empty() ? std::nullopt : std::optional<NodeAnim>(std::move(clean)));
    remint_key_ids(x, newId);
  }
  for (const auto& id : created) {
    if (d.comp(id) != nullptr) (void)tl_ensure(d, id);
  }
  api::ImportProjectResult out;
  out.items = std::move(created);
  return out;
}

ResultOf<api::ApplyJobResult> handle(const api::ApplyJobResult& c, HCtx& /*x*/) {
  fail(ErrorCode::not_found, "no finished job '" + c.job + "' (jobs run in the editor until phase E/F)");
}

ResultOf<api::SetPluginData> handle(const api::SetPluginData& c, HCtx& x) {
  Document& d = x.d;
  (void)require_layer(d, c.layer);
  if (c.key.empty()) fail(ErrorCode::invalid_argument, "a plugin data key is required");
  if (c.data.size() > std::size_t{256} * 1024) fail(ErrorCode::out_of_range, "plugin data is limited to 256 KB per key");
  x.label = "Plugin Data";
  const Json& curJ = d.node(c.layer)->fx().at("pluginData");
  Json cur = curJ.is_undefined() || curJ.is_null() ? Json::object() : curJ;
  const Json& g = cur.at(c.group);
  Json group = spread(Json::object(), g.is_object() ? g : Json::object());
  if (c.data.empty()) group.erase(c.key);
  else group.set(c.key, Json::string(to_base64(c.data)));
  if (!group.obj().empty()) cur.set(c.group, std::move(group));
  else cur.erase(c.group);
  sg_set_fx(d, c.layer, "pluginData", cur.is_object() && !cur.obj().empty() ? cur : Json());
  return {};
}

/// The content-aware fill record (contentAwareFillVideo.ts `fx.contentAwareFill`):
/// `{frames: [{t, dataUrl}]}`, `t` on the layer's keyframe axis (the renderer
/// shows the frame nearest the layer's time), `dataUrl` the picture's src.
ResultOf<api::SetEssentialProp> handle(const api::SetEssentialProp& c, HCtx& x) {
  Document& d = x.d;
  require_comp(d, c.comp);
  (void)require_layer(d, c.layer);
  if (c.layer == c.comp || comp_of_layer(d, c.layer) != std::optional<std::string>(c.comp)) {
    fail(ErrorCode::invalid_argument, "'" + c.layer + "' is not a layer of '" + c.comp + "'", {.layer = c.layer});
  }
  // compInstanceOverrides.ts OVERRIDE_PROP_KINDS.
  static constexpr std::array<std::string_view, 9> kOverridable = {"x", "y", "rotation", "scaleX", "scaleY", "opacity", "text", "fill", "color"};
  if (std::find(kOverridable.begin(), kOverridable.end(), c.prop) == kOverridable.end()) {
    fail(ErrorCode::invalid_argument, "'" + c.prop + "' cannot be an Essential Property");
  }
  x.label = c.promoted ? "Add to Essential Properties" : "Remove from Essential Properties";
  const Node* root = d.node(c.comp);
  if (root == nullptr || root->components.empty()) return {};
  // setEssentialProp: the root's first component's `__essentialProps`, a sorted set of `<layer>/<prop>` keys.
  std::vector<std::string> keys;
  const Json& cur = root->components.front().props.at("__essentialProps");
  if (cur.is_array()) {
    for (const Json& k : cur.arr()) {
      if (k.is_string()) keys.push_back(k.str());
    }
  }
  const std::string key = c.layer + "/" + c.prop;
  std::erase(keys, key);
  if (c.promoted) keys.push_back(key);
  std::sort(keys.begin(), keys.end());
  keys.erase(std::unique(keys.begin(), keys.end()), keys.end());
  Json next = Json::array();
  for (const std::string& k : keys) next.arr_mut().push_back(Json::string(k));
  d.node_mut(c.comp).components.front().props.set("__essentialProps", std::move(next));
  return {};
}

ResultOf<api::SetContentAwareFill> handle(const api::SetContentAwareFill& c, HCtx& x) {
  Document& d = x.d;
  (void)require_layer(d, c.layer);
  x.label = "Content-Aware Fill";
  if (c.frames.empty()) {
    sg_set_fx(d, c.layer, "contentAwareFill", Json());
    return {};
  }
  Json frames = Json::array();
  for (std::size_t i = 0; i < c.frames.size(); ++i) {
    const api::ContentAwareFillFrame& f = c.frames[i];
    if (f.src.empty()) fail(ErrorCode::invalid_argument, "fill frame " + std::to_string(i) + " has no picture");
    Json fr = Json::object();
    fr.set("t", Json::number(comp_to_keyframe_time(d, x.view, c.layer, flicks_to_seconds(f.time))));
    fr.set("dataUrl", Json::string(f.src));
    frames.arr_mut().push_back(std::move(fr));
  }
  Json record = Json::object();
  record.set("frames", std::move(frames));
  sg_set_fx(d, c.layer, "contentAwareFill", std::move(record));
  return {};
}

// ── saved trackers (AE parity 3.6) ──────────────────────────────────────
//
// `fx.trackers`: [{name, mode, kind, sourceWidth, sourceHeight, points:
// [{feature:[x,y,w,h], search:[…], attach:[x,y], samples:[[t,x,y,c,coasted]…]}]}],
// `t` on the layer's own time axis (keyframe time), so moving or retiming the
// layer keeps the track on its frames.

namespace {

Json rect_json(const api::Rect& r) {
  Json a = Json::array();
  for (const double v : {r.x, r.y, r.width, r.height}) a.arr_mut().push_back(Json::number(v));
  return a;
}

api::Rect rect_of(const Json& j) {
  api::Rect r;
  if (j.is_array() && j.arr().size() == 4) {
    r.x = j.arr()[0].is_number() ? j.arr()[0].num() : 0;
    r.y = j.arr()[1].is_number() ? j.arr()[1].num() : 0;
    r.width = j.arr()[2].is_number() ? j.arr()[2].num() : 0;
    r.height = j.arr()[3].is_number() ? j.arr()[3].num() : 0;
  }
  return r;
}

double num_at(const Json& a, std::size_t i) {
  return a.is_array() && i < a.arr().size() && a.arr()[i].is_number() ? a.arr()[i].num() : 0;
}

bool finite_rect(const api::Rect& r) {
  return std::isfinite(r.x) && std::isfinite(r.y) && std::isfinite(r.width) && std::isfinite(r.height);
}

}  // namespace

ResultOf<api::SetLayerTrackers> handle(const api::SetLayerTrackers& c, HCtx& x) {
  Document& d = x.d;
  (void)require_layer(d, c.layer);
  x.label = "Save Tracker";
  if (c.trackers.empty()) {
    sg_set_fx(d, c.layer, "trackers", Json());
    return {};
  }
  Json list = Json::array();
  for (std::size_t ti = 0; ti < c.trackers.size(); ++ti) {
    const api::TrackerData& t = c.trackers[ti];
    if (!std::isfinite(t.source_width) || !std::isfinite(t.source_height) || t.source_width < 0 || t.source_height < 0) {
      fail(ErrorCode::invalid_argument, "tracker " + std::to_string(ti) + ": the source size must be finite and ≥ 0");
    }
    Json tj = Json::object();
    tj.set("name", Json::string(t.name));
    tj.set("mode", Json::string(t.mode));
    tj.set("kind", Json::number(static_cast<double>(static_cast<std::uint32_t>(t.kind))));
    tj.set("sourceWidth", Json::number(t.source_width));
    tj.set("sourceHeight", Json::number(t.source_height));
    Json points = Json::array();
    for (std::size_t pi = 0; pi < t.points.size(); ++pi) {
      const api::TrackerPointData& p = t.points[pi];
      if (!finite_rect(p.feature) || !finite_rect(p.search) || !std::isfinite(p.attach.x) || !std::isfinite(p.attach.y)) {
        fail(ErrorCode::invalid_argument, "tracker " + std::to_string(ti) + " point " + std::to_string(pi) + " is not finite");
      }
      Json pj = Json::object();
      pj.set("feature", rect_json(p.feature));
      pj.set("search", rect_json(p.search));
      Json attach = Json::array();
      attach.arr_mut().push_back(Json::number(p.attach.x));
      attach.arr_mut().push_back(Json::number(p.attach.y));
      pj.set("attach", std::move(attach));
      Json samples = Json::array();
      for (const api::TrackSampleRow& s : p.samples) {
        if (!std::isfinite(s.x) || !std::isfinite(s.y) || !std::isfinite(s.confidence)) continue;
        Json row = Json::array();
        row.arr_mut().push_back(Json::number(comp_to_keyframe_time(d, x.view, c.layer, flicks_to_seconds(s.time))));
        row.arr_mut().push_back(Json::number(s.x));
        row.arr_mut().push_back(Json::number(s.y));
        row.arr_mut().push_back(Json::number(s.confidence));
        row.arr_mut().push_back(Json::number(s.coasted ? 1 : 0));
        samples.arr_mut().push_back(std::move(row));
      }
      pj.set("samples", std::move(samples));
      points.arr_mut().push_back(std::move(pj));
    }
    tj.set("points", std::move(points));
    list.arr_mut().push_back(std::move(tj));
  }
  sg_set_fx(d, c.layer, "trackers", std::move(list));
  return {};
}

api::LayerTrackers layer_trackers(const Document& d, const EditorView& view, std::string_view layer) {
  const Node& n = require_layer(d, std::string(layer));
  api::LayerTrackers out;
  const Json& list = n.fx().at("trackers");
  if (!list.is_array()) return out;
  for (const Json& tj : list.arr()) {
    if (!tj.is_object()) continue;
    api::TrackerData t;
    t.name = tj.at("name").is_string() ? tj.at("name").str() : std::string("Tracker");
    t.mode = tj.at("mode").is_string() ? tj.at("mode").str() : std::string();
    if (tj.at("kind").is_number() && tj.at("kind").num() >= 0) {
      api::TrackKind k{};
      if (api::from_u32(static_cast<std::uint32_t>(tj.at("kind").num()), k)) t.kind = k;
    }
    t.source_width = tj.at("sourceWidth").is_number() ? tj.at("sourceWidth").num() : 0;
    t.source_height = tj.at("sourceHeight").is_number() ? tj.at("sourceHeight").num() : 0;
    if (tj.at("points").is_array()) {
      for (const Json& pj : tj.at("points").arr()) {
        api::TrackerPointData p;
        p.feature = rect_of(pj.at("feature"));
        p.search = rect_of(pj.at("search"));
        p.attach = api::Vec2{num_at(pj.at("attach"), 0), num_at(pj.at("attach"), 1)};
        if (pj.at("samples").is_array()) {
          for (const Json& row : pj.at("samples").arr()) {
            api::TrackSampleRow s;
            s.time = seconds_to_flicks(keyframe_to_comp_time(d, view, std::string(layer), num_at(row, 0)));
            s.x = num_at(row, 1);
            s.y = num_at(row, 2);
            s.confidence = num_at(row, 3);
            s.coasted = num_at(row, 4) != 0;
            p.samples.push_back(s);
          }
        }
        t.points.push_back(std::move(p));
      }
    }
    out.trackers.push_back(std::move(t));
  }
  return out;
}

// ── camera solve and per-frame matte (AE parity 3.5 / 3.2) ──────────────

namespace {

Json vec3_json(const api::Vec3& v) {
  Json a = Json::array();
  for (const double c : {v.x, v.y, v.z}) a.arr_mut().push_back(Json::number(c));
  return a;
}
api::Vec3 vec3_of(const Json& a) { return api::Vec3{num_at(a, 0), num_at(a, 1), num_at(a, 2)}; }
Json nums_json(const std::vector<double>& v) {
  Json a = Json::array();
  for (const double c : v) a.arr_mut().push_back(Json::number(std::isfinite(c) ? c : 0));
  return a;
}
std::vector<double> nums_of(const Json& a) {
  std::vector<double> out;
  if (!a.is_array()) return out;
  for (const Json& v : a.arr()) out.push_back(v.is_number() ? v.num() : 0);
  return out;
}
bool finite3(const api::Vec3& v) { return std::isfinite(v.x) && std::isfinite(v.y) && std::isfinite(v.z); }

}  // namespace

ResultOf<api::SetCameraSolve> handle(const api::SetCameraSolve& c, HCtx& x) {
  Document& d = x.d;
  (void)require_layer(d, c.layer);
  x.label = "Camera Solve";
  if (!c.solve) {
    sg_set_fx(d, c.layer, "cameraSolve", Json());
    return {};
  }
  const api::CameraSolveData& s = *c.solve;
  if (!(s.focal > 0) || !std::isfinite(s.focal)) fail(ErrorCode::invalid_argument, "the solve's focal length must be > 0");
  if (s.world_rotation.size() != 9) fail(ErrorCode::invalid_argument, "worldRotation is a 3×3 matrix (9 numbers)");
  if (!finite3(s.world_origin) || !finite3(s.world_centroid) || !std::isfinite(s.world_scale)) {
    fail(ErrorCode::invalid_argument, "the solve's world mapping is not finite");
  }
  Json j = Json::object();
  j.set("camera", Json::string(s.camera));
  j.set("focal", Json::number(s.focal));
  j.set("sourceWidth", Json::number(s.source_width));
  j.set("sourceHeight", Json::number(s.source_height));
  Json frames = Json::array();
  for (const api::CameraSolveFrame& f : s.frames) {
    if (f.rotation.size() != 9 || !finite3(f.center)) fail(ErrorCode::invalid_argument, "a solve frame needs a 3×3 rotation and a finite centre");
    Json fj = Json::object();
    fj.set("t", Json::number(comp_to_keyframe_time(d, x.view, c.layer, flicks_to_seconds(f.time))));
    fj.set("r", nums_json(f.rotation));
    fj.set("c", vec3_json(f.center));
    frames.arr_mut().push_back(std::move(fj));
  }
  j.set("frames", std::move(frames));
  Json pts = Json::array();
  for (const api::Vec3& p : s.points) pts.arr_mut().push_back(vec3_json(p));
  j.set("points", std::move(pts));
  j.set("pointErrors", nums_json(s.point_errors));
  j.set("worldOrigin", vec3_json(s.world_origin));
  j.set("worldScale", Json::number(s.world_scale));
  j.set("worldRotation", nums_json(s.world_rotation));
  j.set("worldCentroid", vec3_json(s.world_centroid));
  sg_set_fx(d, c.layer, "cameraSolve", std::move(j));
  return {};
}

std::optional<api::CameraSolveData> camera_solve_of(const Document& d, const EditorView& view, std::string_view layer) {
  const Node& n = require_layer(d, std::string(layer));
  const Json& j = n.fx().at("cameraSolve");
  if (!j.is_object()) return std::nullopt;
  api::CameraSolveData s;
  s.camera = j.at("camera").is_string() ? j.at("camera").str() : std::string();
  s.focal = j.at("focal").is_number() ? j.at("focal").num() : 0;
  s.source_width = j.at("sourceWidth").is_number() ? j.at("sourceWidth").num() : 0;
  s.source_height = j.at("sourceHeight").is_number() ? j.at("sourceHeight").num() : 0;
  if (j.at("frames").is_array()) {
    for (const Json& fj : j.at("frames").arr()) {
      api::CameraSolveFrame f;
      f.time = seconds_to_flicks(keyframe_to_comp_time(d, view, std::string(layer), fj.at("t").is_number() ? fj.at("t").num() : 0));
      f.rotation = nums_of(fj.at("r"));
      f.center = vec3_of(fj.at("c"));
      s.frames.push_back(std::move(f));
    }
  }
  if (j.at("points").is_array()) {
    for (const Json& p : j.at("points").arr()) s.points.push_back(vec3_of(p));
  }
  s.point_errors = nums_of(j.at("pointErrors"));
  s.world_origin = vec3_of(j.at("worldOrigin"));
  s.world_scale = j.at("worldScale").is_number() ? j.at("worldScale").num() : 1;
  s.world_rotation = nums_of(j.at("worldRotation"));
  if (s.world_rotation.size() != 9) s.world_rotation = {1, 0, 0, 0, 1, 0, 0, 0, 1};
  s.world_centroid = vec3_of(j.at("worldCentroid"));
  return s;
}

ResultOf<api::SetLayerMatte> handle(const api::SetLayerMatte& c, HCtx& x) {
  Document& d = x.d;
  (void)require_layer(d, c.layer);
  x.label = "Object Matte";
  if (c.frames.empty()) {
    sg_set_fx(d, c.layer, "alphaMatte", Json());
    return {};
  }
  Json frames = Json::array();
  for (std::size_t i = 0; i < c.frames.size(); ++i) {
    const api::ContentAwareFillFrame& f = c.frames[i];
    if (f.src.empty()) fail(ErrorCode::invalid_argument, "matte frame " + std::to_string(i) + " has no picture");
    Json fr = Json::object();
    fr.set("t", Json::number(comp_to_keyframe_time(d, x.view, c.layer, flicks_to_seconds(f.time))));
    fr.set("src", Json::string(f.src));
    frames.arr_mut().push_back(std::move(fr));
  }
  Json record = Json::object();
  record.set("frames", std::move(frames));
  sg_set_fx(d, c.layer, "alphaMatte", std::move(record));
  return {};
}

namespace {
bool is_caption_node(const Node& n) {
  for (const Component& c : n.components) {
    const Json& v = c.props.at("__caption");
    if (v.is_bool() && v.b()) return true;
  }
  return false;
}
double style_num(const Json& s, std::string_view key, double fallback) {
  const Json& v = s.at(key);
  return v.is_number() && std::isfinite(v.num()) ? v.num() : fallback;
}
}  // namespace

/// captionLayers.ts makeCaptionNode + captionEditCommands, as one edit.
ResultOf<api::SetCaptions> handle(const api::SetCaptions& c, HCtx& x) {
  Document& d = x.d;
  require_comp(d, c.comp);
  x.label = "Add " + std::to_string(c.cues.size()) + (c.cues.size() == 1 ? " caption" : " captions");
  Json style = Json::object();
  if (c.style && !c.style->empty()) {
    std::optional<Json> parsed = js::parse(*c.style);
    if (!parsed || !parsed->is_object()) fail(ErrorCode::invalid_argument, "style must be a JSON object");
    style = std::move(*parsed);
  }
  const double sizeRatio = style_num(style, "fontSizeRatio", 0.05);
  const double weight = style_num(style, "fontWeight", 700);
  const double marginRatio = style_num(style, "bottomMarginRatio", 0.1);
  const std::string fill = style.at("fill").is_string() ? style.at("fill").str() : std::string("#ffffff");
  for (std::size_t i = 0; i < c.cues.size(); ++i) {
    if (c.cues[i].end <= c.cues[i].start) fail(ErrorCode::invalid_argument, "caption " + std::to_string(i + 1) + " ends before it starts");
  }

  // Replacing, not adding: a second import over the first would be doubled text.
  std::vector<std::string> old;
  if (const Node* root = d.node(c.comp)) {
    for (const std::string& id : root->children) {
      if (const Node* n = d.node(id); n != nullptr && is_caption_node(*n)) old.push_back(id);
    }
  }
  if (!old.empty()) {
    api::DeleteLayers del;
    del.layers = old;
    (void)handle(del, x);
  }

  const api::CompSettings cs = comp_settings(d, c.comp);
  const double w = cs.width;
  const double h = cs.height;
  const double fontSize = std::max(8.0, motion::js::round(h * sizeRatio));
  api::LayerList out;
  for (std::size_t i = 0; i < c.cues.size(); ++i) {
    const api::CaptionInput& cue = c.cues[i];
    std::size_t lines = 1;
    for (const char ch : cue.text) lines += ch == '\n' ? 1 : 0;
    const std::string firstLine = cue.text.substr(0, cue.text.find('\n'));
    api::CreateLayer cl;
    cl.comp = c.comp;
    cl.kind = api::LayerKind::text;
    cl.name = firstLine.empty() ? "Caption " + std::to_string(i + 1) : firstLine.substr(0, 40);
    cl.index = static_cast<std::uint32_t>(i);
    cl.in_point = cue.start;
    cl.out_point = cue.end;
    const std::string id = handle(cl, x).layer;
    const Node& n = require_layer(d, id);
    std::string tid;
    std::string cid;
    for (const Component& comp : n.components) {
      if (comp.type == "Transform") tid = comp.id;
      if (comp.type == "Text") cid = comp.id;
    }
    if (tid.empty() || cid.empty()) fail(ErrorCode::internal, "a text layer without its Transform / Text");
    (void)sg_write_prop(d, id, tid, "x", Json::number(motion::js::round(w / 2)));
    // Anchored off the bottom, lifted by the lines it has.
    (void)sg_write_prop(d, id, tid, "y", Json::number(motion::js::round(h - h * marginRatio - fontSize * static_cast<double>(lines - 1))));
    (void)sg_write_prop(d, id, tid, "width", Json::number(motion::js::round(w * 0.8)));
    (void)sg_write_prop(d, id, cid, "content", Json::string(cue.text));
    (void)sg_write_prop(d, id, cid, "fontSize", Json::number(fontSize));
    (void)sg_write_prop(d, id, cid, "fontWeight", Json::number(weight));
    (void)sg_write_prop(d, id, cid, "fill", Json::string(fill));
    (void)sg_write_prop(d, id, cid, "align", Json::string("center"));
    (void)sg_write_prop(d, id, cid, "__caption", Json::boolean(true));
    out.layers.push_back(id);
  }
  return out;
}

}  // namespace premation::doc
