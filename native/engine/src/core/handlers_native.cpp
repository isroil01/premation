#include "handlers_native.hpp"

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <map>
#include <mutex>
#include <system_error>
#include <tuple>
#include <variant>

#include "anim.hpp"
#include "collect_files.hpp"
#include "fail.hpp"
#include "fxstate.hpp"
#include "handlers_common.hpp"
#include "jsmath.hpp"
#include "jobs/job_inputs.hpp"
#include "native_effects.hpp"
#include "props.hpp"
#include "scene.hpp"
#include "strutil.hpp"
#include "time_conv.hpp"
#include "worldxf.hpp"

namespace premation::doc {

using api::ErrorCode;

namespace {
/// Anything but a native effect: the TypeScript engine's answer, word for word
/// (the cross-engine replay compares it).
[[noreturn]] void not_native() {
  fail(ErrorCode::unsupported,
       "effect action buttons belong to native SDK plugins (G1); the JavaScript plugin system is not ported (plan §5 G2)");
}
/// What the host needs about one native effect instance: its static params,
/// the document's flat sequence data and arbitrary-data params.
NativeActionRequest request_for(const Document& d, const Node& node, const std::string& layer, const std::string& effectId,
                                const Json& e, const NativeEffect& ne, api::Time time) {
  NativeActionRequest req;
  req.layer = layer;
  req.effectId = effectId;
  req.type = ne.def.type;
  req.params = params_of(e);
  req.timeSeconds = flicks_to_seconds(time);
  req.layerTimeSeconds = native_layer_clock(d, EditorView{}, layer, req.timeSeconds).layer_time(req.timeSeconds);
  const std::string dataGroup = native_data_group(effectId);
  if (auto seq = native_read_plugin_data(node, dataGroup, kNativeSequenceKey)) req.sequence = std::move(*seq);
  for (const std::string& key : ne.arbitrary) {
    if (auto bytes = native_read_plugin_data(node, dataGroup, native_arb_key(key))) req.arb.emplace_back(key, std::move(*bytes));
  }
  for (const auto& [key, types] : ne.files) {  // SDK 1.1 FILE params, as files
    const Json& v = req.params.at(key);
    req.files.push_back(native_file_of(d, key, v.is_string() ? std::string_view(v.str()) : std::string_view()));
  }
  return req;
}
}  // namespace

NativeActionRequest::File native_file_of(const Document& d, std::string_view key, std::string_view item) {
  NativeActionRequest::File f;
  f.key = std::string(key);
  f.item = std::string(item);
  if (item.empty()) return f;
  const Json* a = find_asset(d, item);
  if (a == nullptr) {
    f.missing = true;  // the item was removed: what it named is gone
    return f;
  }
  f.name = a->at("name").is_string() ? a->at("name").str() : std::string(item);
  // The live source first (a local-file URL / path), then a collected item laid out under its
  // name (an export's snapshot: its blobs are absolute paths), then the recorded path.
  for (const char* field : {"src", "collected", "path"}) {
    if (std::string_view(field) == "collected") {
      if (!a->at("collected").is_object()) continue;
      if (auto laid = materialize_collected(*a, "")) {
        f.path = std::move(*laid);
        return f;
      }
      continue;
    }
    if (!a->at(field).is_string()) continue;
    std::string p = jobs::resolve_footage_path(a->at(field).str(), "");
    if (p.empty()) continue;
    std::error_code ec;
    if (std::filesystem::is_regular_file(std::filesystem::path(std::u8string(p.begin(), p.end())), ec)) {
      f.path = std::move(p);
      return f;
    }
  }
  f.missing = true;
  return f;
}

std::vector<std::string> builtin_file_params(std::string_view type) {
  std::vector<std::string> out;
  if (const EffectDef* def = registry().effect(type); def != nullptr) {
    for (const EffectParamDef& p : def->params) {
      if (p.type == "file") out.push_back(p.key);
    }
  }
  return out;
}

bool native_effects_use_item(const Node& node, std::string_view item) {
  if (item.empty()) return false;
  for (const Json& e : read_node_effects(node)) {
    const std::string type = e.at("type").is_string() ? e.at("type").str() : std::string();
    const NativeEffect* ne = NativeEffects::find(type);
    if (ne == nullptr) {  // a builtin's FILE param (Image Fill's picture) holds a project item the same way
      const std::vector<std::string> keys = builtin_file_params(type);
      if (!keys.empty()) {
        const Json params = params_of(e);
        for (const std::string& key : keys) {
          if (params.at(key).is_string() && params.at(key).str() == item) return true;
        }
      }
      continue;
    }
    if (ne->files.empty()) continue;
    const Json params = params_of(e);
    for (const auto& [key, types] : ne->files) {
      if (params.at(key).is_string() && params.at(key).str() == item) return true;
    }
  }
  return false;
}

double NativeLayerClock::layer_time(double compSeconds) const {
  double x = compSeconds;
  if (hasClip) x = (sourceIn + (compSeconds * fps - clipStart)) / fps;
  return cfg ? remap_time(x, *cfg, spanStart, spanEnd) : x;
}

double NativeLayerClock::comp_time(double layerSeconds) const {
  if (cfg && cfg->freeze) return atComp + (layerSeconds - atLayer);
  double x = layerSeconds;
  if (cfg) {
    const double stretch = cfg->stretch > 0 ? cfg->stretch : 100;
    double s = layerSeconds;
    if (cfg->reverse) s = spanStart + spanEnd - s;
    x = spanStart + (s - spanStart) * (stretch / 100);
  }
  return hasClip ? (x * fps - sourceIn + clipStart) / fps : x;
}

NativeLayerClock native_layer_clock(const Document& d, const EditorView& v, std::string_view layer, double compSeconds) {
  NativeLayerClock c;
  c.fps = tl_fps_for_node(d, v, layer);
  if (!(c.fps > 0)) c.fps = 30;
  // Governing clips: the node's own, else an enclosing plain GROUP's (comp_to_keyframe_time's rule).
  std::vector<const Bar*> clips = tl_bars_for_node(d, v, layer);
  if (clips.empty()) {
    const Node* n = d.node(layer);
    for (int depth = 0; depth < 32 && n != nullptr; ++depth) {
      if (!n->parent) break;
      const Node* parent = d.node(*n->parent);
      if (parent == nullptr || is_precomp(*parent) || parent->kind() != "group") break;
      clips = tl_bars_for_node(d, v, parent->id);
      if (!clips.empty()) break;
      n = parent;
    }
  }
  const double frame = motion::js::round(compSeconds * c.fps);
  for (const Bar* b : clips) {
    if (b->active_at(frame)) {
      c.hasClip = true;
      c.clipStart = b->clip.start;
      c.sourceIn = b->clip.sourceIn;
      break;
    }
  }
  if (const Node* n = d.node(layer)) {
    if (auto cfg = read_node_layer_time(*n)) {
      const auto span = anim_time_span(d, layer);
      c.spanStart = span ? span->start : 0;
      c.spanEnd = span ? span->end : 1;
      c.cfg = std::move(cfg);
    }
  }
  c.atComp = compSeconds;
  c.atLayer = c.layer_time(compSeconds);
  return c;
}

NativeActionRequest native_request(const Document& d, const Node& node, const std::string& layer, const std::string& effectId,
                                   const Json& e, const NativeEffect& ne, api::Time time) {
  return request_for(d, node, layer, effectId, e, ne, time);
}

namespace {
/// The frame each layer's last measured overlay draw used: a drag (no text measurer in a
/// command) maps a text layer's pointer the way the viewer drew its handle.
std::mutex g_frameMutex;                                    // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)
std::map<std::string, NativeLayerFrame, std::less<>> g_frames;  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)
}  // namespace

std::optional<NativeLayerFrame> native_layer_frame(const SpaceCtx& c, TextQueries* text, const std::string& layer, double seconds) {
  std::optional<LayerGeometry> g;
  try {
    g = layer_geometry_at(c, text, layer, seconds);
  } catch (const EngineFail&) {
    g = std::nullopt;  // a text layer with no measurer here
  }
  if (!g) {
    const std::scoped_lock lock(g_frameMutex);
    const auto it = g_frames.find(layer);
    if (it == g_frames.end() || c.d.node(layer) == nullptr) return std::nullopt;
    return it->second;
  }
  NativeLayerFrame f;
  f.width = g->width;
  f.height = g->height;
  f.ox = g->offsetX - g->width / 2;
  f.oy = g->offsetY - g->height / 2;
  if (const Node* n = c.d.node(layer); n != nullptr && !is_3d_enabled(*n)) {
    if (const auto local = local_3d_at(c, *n, seconds)) {
      f.ox -= local->anchor_x;
      f.oy -= local->anchor_y;
    }
  }
  if (text != nullptr) {
    const std::scoped_lock lock(g_frameMutex);
    if (g_frames.size() > 4096) g_frames.clear();
    g_frames.insert_or_assign(layer, f);
  }
  return f;
}

void native_use_layer_frame(NativeActionRequest& req, const std::optional<NativeLayerFrame>& frame) {
  if (frame && frame->width > 0 && frame->height > 0) req.layerSize = std::make_pair(frame->width, frame->height);
}

api::EffectUi native_effect_ui(const Document& d, const std::string& layer, const std::string& path, api::Time time) {
  const Node& node = require_layer(d, layer);
  const std::vector<std::string> seg = split(path, '/');
  const std::vector<Json> effects = read_node_effects(node);
  const Json* e = seg.size() == 2 && seg[0] == "effects" ? find_by_id(effects, seg[1]) : nullptr;
  if (e == nullptr) fail(ErrorCode::not_found, "no effect '" + path + "'", {.layer = layer, .path = path});
  const std::string type = e->at("type").is_string() ? e->at("type").str() : "";
  const NativeEffect* ne = NativeEffects::find(type);
  if (ne == nullptr) {
    // A builtin effect: every param enabled and visible under its catalog name (the TypeScript engine's answer).
    api::EffectUi out;
    if (const EffectDef* def = registry().effect(type)) {
      for (const auto& p : def->params) {
        if (p.type == "resolved") continue;
        out.params.push_back(api::EffectParamUi{p.key, p.label, true, false});
      }
    }
    return out;
  }
  NativeActionRequest req = request_for(d, node, layer, seg[1], *e, *ne, time);
  const auto r = NativeEffects::params_ui(req);
  if (const auto* f = std::get_if<NativeFailure>(&r)) {
    fail(ErrorCode::internal, "plugin '" + ne->provider + "': " + f->message, {.layer = layer, .path = path});
  }
  api::EffectUi out;
  out.params = std::get<std::vector<api::EffectParamUi>>(r);
  out.plugin = ne->provider;
  out.panel = ne->panel;
  // What a panel reads besides the params (SDK 1.1): the document's plugin data, as the plugin sees it.
  if (!req.sequence.empty()) out.data.push_back(api::PluginDataEntry{std::string(kNativeSequenceKey), std::move(req.sequence)});
  for (auto& [key, bytes] : req.arb) out.data.push_back(api::PluginDataEntry{key, std::move(bytes)});
  return out;
}

void native_check_addable(std::string_view type) {
  if (NativeEffects::find(type) != nullptr && !NativeEffects::available(type)) {
    fail(ErrorCode::not_found, "the plugin that provides '" + std::string(type) + "' is disabled or failed to load");
  }
}

void native_write_plugin_data(Document& d, std::string_view layer, std::string_view group, std::string_view key,
                              const std::vector<std::uint8_t>& bytes) {
  const Node* n = d.node(layer);
  if (n == nullptr) return;
  const Json& curJ = n->fx().at("pluginData");
  Json cur = curJ.is_undefined() || curJ.is_null() ? Json::object() : curJ;
  const Json& g = cur.at(group);
  Json grp = spread(Json::object(), g.is_object() ? g : Json::object());
  if (bytes.empty()) grp.erase(key);
  else grp.set(key, Json::string(native_base64(bytes)));
  if (!grp.obj().empty()) cur.set(group, std::move(grp));
  else cur.erase(group);
  sg_set_fx(d, layer, "pluginData", cur.is_object() && !cur.obj().empty() ? cur : Json());
}

std::optional<std::vector<std::uint8_t>> native_read_plugin_data(const Node& n, std::string_view group, std::string_view key) {
  const Json& v = n.fx().at("pluginData").at(group).at(key);
  if (!v.is_string()) return std::nullopt;
  return native_unbase64(v.str());
}

void native_effect_added(Document& d, std::string_view layer, std::string_view effectId, std::string_view type) {
  if (NativeEffects::find(type) == nullptr) return;
  const auto seq = NativeEffects::created(type);
  if (seq && !seq->empty()) native_write_plugin_data(d, layer, native_data_group(effectId), kNativeSequenceKey, *seq);
}

void native_invoke_action(HCtx& x, const api::PropRef& group, const std::string& action, const std::string& payload) {
  Document& d = x.d;
  const Node& node = require_layer(d, group.layer);
  const std::vector<std::string> seg = split(group.path, '/');
  if (seg.size() != 2 || seg[0] != "effects") not_native();
  const std::string& effectId = seg[1];
  const std::vector<Json> effects = read_node_effects(node);
  const Json* e = find_by_id(effects, effectId);
  if (e == nullptr) not_native();
  const std::string type = e->at("type").is_string() ? e->at("type").str() : "";
  const NativeEffect* ne = NativeEffects::find(type);
  if (ne == nullptr) not_native();
  const bool isButton = std::ranges::any_of(ne->actions, [&](const auto& a) { return a.key == action; });
  const bool isSupervised = action.starts_with("changed:") &&
                            std::ranges::find(ne->supervised, std::string_view(action).substr(8)) != ne->supervised.end();
  if (!isButton && !isSupervised) {
    fail(ErrorCode::not_found, "effect '" + type + "' has no action '" + action + "'", {.layer = group.layer, .path = group.path});
  }

  // A panel's payload is data for one button press, not a document: bounded like setPluginData's bytes.
  constexpr std::size_t kMaxPayload = 64 * 1024;
  if (payload.size() > kMaxPayload) {
    fail(ErrorCode::invalid_argument, "the action payload is over 64 KiB", {.layer = group.layer, .path = group.path});
  }
  NativeActionRequest req = request_for(d, node, group.layer, effectId, *e, *ne, x.time);
  req.action = action;
  req.payload = payload;

  const std::variant<NativeEdit, NativeFailure> result = NativeEffects::action(req);
  if (const auto* f = std::get_if<NativeFailure>(&result)) {
    fail(ErrorCode::internal, "plugin '" + ne->provider + "': " + f->message, {.layer = group.layer, .path = group.path});
  }
  x.label = [&]() -> std::string {
    for (const NativeAction& a : ne->actions) {
      if (a.key == action) return a.label;
    }
    return ne->def.label;
  }();
  apply_native_edit(x, group, effectId, std::get<NativeEdit>(result));
}

void native_overlay_drag(HCtx& x, const api::DragEffectOverlay& c) {
  const api::PropRef& group = c.group;
  Document& d = x.d;
  const Node& node = require_layer(d, group.layer);
  const std::vector<std::string> seg = split(group.path, '/');
  const std::vector<Json> effects = read_node_effects(node);  // owns what `e` points into
  const Json* e = seg.size() == 2 && seg[0] == "effects" ? find_by_id(effects, seg[1]) : nullptr;
  const std::string type = e != nullptr && e->at("type").is_string() ? e->at("type").str() : "";
  const NativeEffect* ne = NativeEffects::find(type);
  if (e == nullptr || ne == nullptr || !ne->overlay) {
    fail(ErrorCode::not_found, "no plugin effect with a viewer overlay at '" + group.path + "'", {.layer = group.layer, .path = group.path});
  }
  NativeActionRequest req = native_request(d, node, group.layer, seg[1], *e, *ne, x.time);
  const SpaceCtx sc{d, x.view, x.expr, x.cache};
  NativeEffects::fill_scene(sc, req);  // SDK 1.2: the comp camera & co. at the drag's time
  // A layer-space handle's pointer arrives in the layer's local space (the overlay push's
  // frame); the plugin takes layer px, sized as the document places the layer.
  const std::optional<NativeLayerFrame> frame = native_layer_frame(sc, nullptr, group.layer, flicks_to_seconds(x.time));
  native_use_layer_frame(req, frame);
  NativeOverlayDrag drag;
  drag.handle = c.handle;
  drag.phase = static_cast<std::int32_t>(std::min<std::uint32_t>(c.phase, 2));
  drag.x = c.x;
  drag.y = c.y;
  drag.startX = c.start_x;
  drag.startY = c.start_y;
  if (c.space == 0 && frame) {
    std::tie(drag.x, drag.y) = frame->to_layer_px(c.x, c.y);
    std::tie(drag.startX, drag.startY) = frame->to_layer_px(c.start_x, c.start_y);
  }
  drag.space = c.space;  // SDK 1.2: the handle's space (layer px or comp px)
  const std::variant<NativeEdit, NativeFailure> result = NativeEffects::overlay_drag(req, drag);
  if (const auto* f = std::get_if<NativeFailure>(&result)) {
    fail(ErrorCode::internal, "plugin '" + ne->provider + "': " + f->message, {.layer = group.layer, .path = group.path});
  }
  x.label = ne->def.label;
  apply_native_edit(x, group, seg[1], std::get<NativeEdit>(result));
}

void native_param_ui_drag(HCtx& x, const api::DragEffectParamUi& c) {
  const api::PropRef& group = c.group;
  Document& d = x.d;
  const Node& node = require_layer(d, group.layer);
  const std::vector<std::string> seg = split(group.path, '/');
  const std::vector<Json> effects = read_node_effects(node);  // owns what `e` points into
  const Json* e = seg.size() == 2 && seg[0] == "effects" ? find_by_id(effects, seg[1]) : nullptr;
  const std::string type = e != nullptr && e->at("type").is_string() ? e->at("type").str() : "";
  const NativeEffect* ne = NativeEffects::find(type);
  const auto box = ne != nullptr ? std::ranges::find(ne->customUis, c.key, &NativeCustomUi::key) : std::vector<NativeCustomUi>::const_iterator{};
  if (e == nullptr || ne == nullptr || box == ne->customUis.end()) {
    fail(ErrorCode::not_found, "no plugin custom UI '" + c.key + "' at '" + group.path + "'", {.layer = group.layer, .path = group.path});
  }
  for (const double v : {c.x, c.y, c.start_x, c.start_y, c.width}) {
    if (!std::isfinite(v)) fail(ErrorCode::invalid_argument, "the pointer must be finite", {.layer = group.layer, .path = group.path});
  }
  NativeActionRequest req = native_request(d, node, group.layer, seg[1], *e, *ne, x.time);
  req.paramUi = NativeParamUiTarget{c.key, std::clamp(c.width, 16.0, 4096.0), box->height};
  NativeOverlayDrag drag;
  drag.handle = c.handle;
  drag.phase = static_cast<std::int32_t>(std::min<std::uint32_t>(c.phase, 2));
  drag.x = c.x;
  drag.y = c.y;
  drag.startX = c.start_x;
  drag.startY = c.start_y;
  const std::variant<NativeEdit, NativeFailure> result = NativeEffects::overlay_drag(req, drag);
  if (const auto* f = std::get_if<NativeFailure>(&result)) {
    fail(ErrorCode::internal, "plugin '" + ne->provider + "': " + f->message, {.layer = group.layer, .path = group.path});
  }
  x.label = box->label.empty() ? ne->def.label : ne->def.label + ": " + box->label;
  apply_native_edit(x, group, seg[1], std::get<NativeEdit>(result));
}

void apply_native_edit(HCtx& x, const api::PropRef& group, const std::string& effectId, const NativeEdit& edit) {
  Document& d = x.d;
  const std::string dataGroup = native_data_group(effectId);
  if (!edit.params.empty()) {
    const PCtx pc = x.pc();
    for (const auto& [key, value] : edit.params) {
      const Catalog cat = catalog_for(d, group.layer);
      const PropBinding& b = require_binding(cat, "effects/" + effectId + "/" + key);
      if (is_animated(d, group.layer, b)) {
        KeyWrite w;
        w.t = flicks_to_key_time(pc, group.layer, b, x.time);
        w.id = x.mint_key_id();
        w.value = value;
        put_keys(pc, group.layer, b, {w});
      } else {
        write_static(d, group.layer, b, value);
      }
    }
  }
  if (edit.sequence) native_write_plugin_data(d, group.layer, dataGroup, kNativeSequenceKey, *edit.sequence);
  for (const auto& [key, bytes] : edit.arb) native_write_plugin_data(d, group.layer, dataGroup, native_arb_key(key), bytes);
}

}  // namespace premation::doc
