#include "handlers_native.hpp"

#include <algorithm>
#include <variant>

#include "fail.hpp"
#include "fxstate.hpp"
#include "handlers_common.hpp"
#include "native_effects.hpp"
#include "props.hpp"
#include "scene.hpp"
#include "strutil.hpp"
#include "time_conv.hpp"

namespace premation::doc {

using api::ErrorCode;

namespace {
/// Anything but a native effect: the TypeScript engine's answer, word for word
/// (the cross-engine replay compares it).
[[noreturn]] void not_native() {
  fail(ErrorCode::unsupported,
       "effect action buttons belong to native SDK plugins (G1); the JavaScript plugin system is not ported (plan §5 G2)");
}
}  // namespace

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

void native_invoke_action(HCtx& x, const api::PropRef& group, const std::string& action) {
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
  const bool isButton = std::ranges::any_of(ne->actions, [&](const auto& a) { return a.first == action; });
  const bool isSupervised = action.starts_with("changed:") &&
                            std::ranges::find(ne->supervised, std::string_view(action).substr(8)) != ne->supervised.end();
  if (!isButton && !isSupervised) {
    fail(ErrorCode::not_found, "effect '" + type + "' has no action '" + action + "'", {.layer = group.layer, .path = group.path});
  }

  NativeActionRequest req;
  req.layer = group.layer;
  req.effectId = effectId;
  req.type = type;
  req.action = action;
  req.params = params_of(*e);
  req.timeSeconds = flicks_to_seconds(x.time);
  const std::string dataGroup = native_data_group(effectId);
  if (auto seq = native_read_plugin_data(node, dataGroup, kNativeSequenceKey)) req.sequence = std::move(*seq);
  for (const std::string& key : ne->arbitrary) {
    if (auto bytes = native_read_plugin_data(node, dataGroup, native_arb_key(key))) req.arb.emplace_back(key, std::move(*bytes));
  }

  const std::variant<NativeEdit, NativeFailure> result = NativeEffects::action(req);
  if (const auto* f = std::get_if<NativeFailure>(&result)) {
    fail(ErrorCode::internal, "plugin '" + ne->provider + "': " + f->message, {.layer = group.layer, .path = group.path});
  }
  const NativeEdit& edit = std::get<NativeEdit>(result);
  x.label = [&]() -> std::string {
    for (const auto& [name, label] : ne->actions) {
      if (name == action) return label;
    }
    return ne->def.label;
  }();

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
