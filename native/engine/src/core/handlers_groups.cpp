#include "handlers_groups.hpp"

#include <algorithm>
#include <cmath>
#include <map>
#include <numbers>
#include <set>
#include <type_traits>

#include "anim_json.hpp"
#include "catalog_data.hpp"
#include "controls.hpp"
#include "fxstate.hpp"
#include "handlers_items.hpp"
#include "handlers_layers.hpp"
#include "handlers_native.hpp"
#include "plugin_props.hpp"
#include "jsmath.hpp"
#include "rig.hpp"
#include "strutil.hpp"

namespace premation::doc {

using api::ErrorCode;

namespace {

// ── small JavaScript helpers ─────────────────────────────────────────────

Json obj() { return Json::object(); }
Json str(std::string s) { return Json::string(std::move(s)); }

/// JavaScript truthiness.
bool truthy(const Json& v) {
  switch (v.kind()) {
    case Json::Kind::undefined:
    case Json::Kind::null: return false;
    case Json::Kind::boolean: return v.b();
    case Json::Kind::number: return v.num() != 0 && !std::isnan(v.num());
    case Json::Kind::string: return !v.str().empty();
    default: return true;
  }
}

bool id_is(const Json& o, std::string_view id) { return o.at("id").is_string() && o.at("id").str() == id; }

/// `String.prototype.trim() === ''` (ASCII and the common Unicode spaces).
bool blank_js(std::string_view s) {
  std::size_t i = 0;
  while (i < s.size()) {
    const auto c = static_cast<unsigned char>(s[i]);
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v') {
      ++i;
      continue;
    }
    if (c == 0xC2 && i + 1 < s.size() && static_cast<unsigned char>(s[i + 1]) == 0xA0) {
      i += 2;
      continue;
    }
    if (c == 0xEF && i + 2 < s.size() && static_cast<unsigned char>(s[i + 1]) == 0xBB &&
        static_cast<unsigned char>(s[i + 2]) == 0xBF) {
      i += 3;
      continue;
    }
    if (c == 0xE3 && i + 2 < s.size() && static_cast<unsigned char>(s[i + 1]) == 0x80 &&
        static_cast<unsigned char>(s[i + 2]) == 0x80) {
      i += 3;
      continue;
    }
    if (c == 0xE2 && i + 2 < s.size()) {
      const auto b1 = static_cast<unsigned char>(s[i + 1]);
      const auto b2 = static_cast<unsigned char>(s[i + 2]);
      // U+2000–U+200A, U+2028, U+2029, U+202F, U+205F
      if ((b1 == 0x80 && (b2 <= 0x8A || b2 == 0xA8 || b2 == 0xA9 || b2 == 0xAF)) || (b1 == 0x81 && b2 == 0x9F)) {
        i += 3;
        continue;
      }
    }
    return false;
  }
  return true;
}

/// `move(list, from, to)`: splice out `from`, splice back in at `to` (clamped).
template <class T>
std::vector<T> move_item(const std::vector<T>& list, int from, std::size_t to) {
  std::vector<T> out = list;
  if (out.empty()) return out;
  // splice(-1, 1) removes the last element.
  const std::size_t f = from < 0 ? out.size() - 1 : static_cast<std::size_t>(from);
  if (f >= out.size()) return out;
  T x = out[f];
  out.erase(out.begin() + static_cast<std::ptrdiff_t>(f));
  const std::size_t at = std::min(to, out.size());
  out.insert(out.begin() + static_cast<std::ptrdiff_t>(at), std::move(x));
  return out;
}

template <class T>
void insert_at(std::vector<T>& v, std::size_t at, T x) {
  at = std::min(at, v.size());
  v.insert(v.begin() + static_cast<std::ptrdiff_t>(at), std::move(x));
}

int index_of_id(const std::vector<Json>& list, std::string_view id) {
  for (std::size_t i = 0; i < list.size(); ++i) {
    if (id_is(list[i], id)) return static_cast<int>(i);
  }
  return -1;
}

std::vector<Json> arr_of(const Json& v) { return v.is_array() ? v.arr() : std::vector<Json>{}; }

// ── animation snapshots (AnimationEngine snapshotNode / restoreNode) ─────

/// `restoreNode(id, snap)`: empty tracks, blank expressions and empty data
/// tracks are dropped; nothing left clears the node's animation.
void restore_node(Document& d, std::string_view layer, NodeAnim a) {
  NodeAnim out;
  for (auto& [k, v] : a.tracks) {
    if (!v.empty()) out.tracks.set(k, std::move(v));
  }
  for (auto& [k, v] : a.exprs) {
    if (!blank_js(v.src)) out.exprs.set(k, std::move(v));
  }
  for (auto& [k, v] : a.data) {
    if (!v.keys.empty()) out.data.set(k, std::move(v));
  }
  if (out.empty()) d.set_anim(layer, std::nullopt);
  else d.set_anim(layer, std::move(out));
}

/// `snapshotNode(id)` (nullopt when the node has no animation).
std::optional<NodeAnim> snapshot_node(const Document& d, std::string_view layer) {
  const NodeAnim* a = d.anim(layer);
  if (a == nullptr || a->empty()) return std::nullopt;
  return *a;
}

bool matches_prefix(std::string_view prop, std::string_view prefix) {
  // `effect.<id>` alone is a legacy primary-param track; `effect.<id>.<p>` the rest.
  if (prefix.ends_with('.')) return prop.starts_with(prefix);
  return prop == prefix || (prop.starts_with(prefix) && prop.size() > prefix.size() && prop[prefix.size()] == '.');
}

/// `moveGroupTracks(layer, prefix, to)`: drop (to = nullopt) or rename a group's tracks.
void move_group_tracks(Document& d, std::string_view layer, std::string_view prefix,
                       const std::optional<std::string>& to) {
  auto snap = snapshot_node(d, layer);
  if (!snap) return;
  auto pick = [&](const auto& section) {
    std::remove_cvref_t<decltype(section)> keep;
    std::remove_cvref_t<decltype(section)> moved;
    for (const auto& [k, v] : section) {
      if (matches_prefix(k, prefix)) {
        if (to) moved.set(*to + k.substr(prefix.size()), v);
      } else {
        keep.set(k, v);
      }
    }
    for (const auto& [k, v] : moved) keep.set(k, v);
    return keep;
  };
  NodeAnim next;
  next.tracks = pick(snap->tracks);
  next.exprs = pick(snap->exprs);
  next.data = pick(snap->data);
  restore_node(d, layer, std::move(next));
}

/// controlProps.ts `remapTracks`: rename (or drop, nullopt) EXACT keyframe tracks /
/// expressions / data tracks of a layer; renamed ones move to the end.
void remap_tracks(Document& d, std::string_view layer, const std::map<std::string, std::optional<std::string>, std::less<>>& map) {
  auto snap = snapshot_node(d, layer);
  if (!snap) return;
  auto pick = [&](const auto& section) {
    std::remove_cvref_t<decltype(section)> keep;
    std::remove_cvref_t<decltype(section)> moved;
    for (const auto& [k, v] : section) {
      const auto it = map.find(k);
      if (it == map.end()) {
        keep.set(k, v);
      } else if (it->second) {
        moved.set(*it->second, v);
      }
    }
    for (const auto& [k, v] : moved) keep.set(k, v);
    return keep;
  };
  NodeAnim next;
  next.tracks = pick(snap->tracks);
  next.exprs = pick(snap->exprs);
  next.data = pick(snap->data);
  restore_node(d, layer, std::move(next));
}

/// The live Transform component id of a layer (controls live there).
std::string transform_id(const Document& d, std::string_view layer) { return d.node(layer)->comp("Transform")->id; }

/// A control name the API accepts: trimmed, non-empty, no '/'.
std::string valid_control_name(const std::string& raw) {
  std::string name = js_trim(raw);
  if (name.empty() || name.find('/') != std::string::npos) {
    fail(ErrorCode::invalid_argument, "'" + raw + "' is not a control name (empty, or contains '/')");
  }
  return name;
}

/// Refuse a name another control of the layer — or any of its stored keys — already uses.
void require_free_control_name(const Node& node, const ControlSpec& spec, const std::string& name) {
  const Json& props = node.comp("Transform")->props;
  bool clash = false;
  for (const LayerControl& c : read_controls(node)) clash = clash || c.name == name;
  for (const std::string& sfx : spec.components) clash = clash || !props.at(std::string(kControlPrefix) + name + sfx).is_undefined();
  clash = clash || !props.at(std::string(kControlKindPrefix) + name).is_undefined();
  if (clash) {
    fail(ErrorCode::conflict, "layer '" + node.id + "' already has a control named '" + name + "'",
         {.layer = node.id, .path = control_group_path(name)});
  }
}

/// Remove a control: its numbers, its kind marker, and every key / expression on its numbers.
void remove_control(Document& d, const std::string& layer, const LayerControl& c) {
  const std::string tid = transform_id(d, layer);
  std::map<std::string, std::optional<std::string>, std::less<>> map;
  for (const std::string& m : control_members(c)) {
    (void)sg_write_prop(d, layer, tid, m, Json());
    map.emplace(m, std::nullopt);
  }
  (void)sg_write_prop(d, layer, tid, std::string(kControlKindPrefix) + c.name, Json());
  remap_tracks(d, layer, map);
}

/// Rename a control (validated by the caller): numbers, marker, keys and expressions follow the name.
void rename_control(Document& d, const std::string& layer, const LayerControl& c, const std::string& name) {
  auto move_prop = [&](const std::string& from, const std::string& to) {
    const std::string tid = transform_id(d, layer);
    const Json v = d.node(layer)->comp("Transform")->props.at(from);
    if (v.is_undefined()) return;
    (void)sg_write_prop(d, layer, tid, to, v);
    (void)sg_write_prop(d, layer, tid, from, Json());
  };
  std::map<std::string, std::optional<std::string>, std::less<>> map;
  for (const std::string& sfx : c.spec->components) {
    const std::string from = std::string(kControlPrefix) + c.name + sfx;
    const std::string to = std::string(kControlPrefix) + name + sfx;
    map.emplace(from, to);
    move_prop(from, to);
  }
  move_prop(std::string(kControlKindPrefix) + c.name, std::string(kControlKindPrefix) + name);
  remap_tracks(d, layer, map);
}

/// `copyGroupTracks(layer, prefix, to, toLayer, ctx)`: keyframe ids re-minted.
void copy_group_tracks(HCtx& x, std::string_view layer, std::string_view prefix, std::string_view to,
                       std::string_view toLayer) {
  Document& d = x.d;
  auto snap = snapshot_node(d, layer);
  if (!snap) return;
  NodeAnim target = snapshot_node(d, toLayer).value_or(NodeAnim{});
  std::map<std::string, std::string> byOld;
  auto remint = [&](const std::string& id) {
    const auto it = byOld.find(id);
    std::string f = it != byOld.end() ? it->second : x.mint_key_id();
    byOld[id] = f;
    return f;
  };
  for (const auto& [k, kfs] : snap->tracks) {
    if (!matches_prefix(k, prefix)) continue;
    std::vector<Key> keys = kfs;
    for (Key& kf : keys) {
      if (kf.id && !kf.id->empty()) kf.id = remint(*kf.id);
    }
    target.tracks.set(std::string(to) + k.substr(prefix.size()), std::move(keys));
  }
  for (const auto& [k, ex] : snap->exprs) {
    if (matches_prefix(k, prefix)) target.exprs.set(std::string(to) + k.substr(prefix.size()), ex);
  }
  for (const auto& [k, dt] : snap->data) {
    if (!matches_prefix(k, prefix)) continue;
    DataTrack t = dt;
    for (DataKey& kf : t.keys) {
      if (kf.id && !kf.id->empty()) kf.id = remint(*kf.id);
    }
    target.data.set(std::string(to) + k.substr(prefix.size()), std::move(t));
  }
  restore_node(d, toLayer, std::move(target));
}

// ── group state writers ───────────────────────────────────────────────────

using PathsFn = std::function<std::vector<Json>(std::vector<Json>)>;

/// groups.ts `writeMasks(layer, fn)`: the static mask and every shape keyframe.
void write_masks(Document& d, std::string_view layer, const PathsFn& fn) {
  const Node* n = d.node(layer);
  const std::optional<Json> m = read_node_mask(*n);
  std::vector<Json> paths = fn(m ? arr_of(m->at("paths")) : std::vector<Json>{});
  if (paths.empty()) {
    sg_set_fx(d, layer, "mask", Json());
  } else {
    Json mask = obj();
    mask.set("paths", Json::array(std::move(paths)));
    sg_set_fx(d, layer, "mask", std::move(mask));
  }
  const std::vector<Json> anim = read_node_mask_anim(*d.node(layer));
  if (!anim.empty()) {
    std::vector<Json> next;
    next.reserve(anim.size());
    for (const Json& k : anim) {
      Json e = k;
      Json mk = obj();
      mk.set("paths", Json::array(fn(arr_of(k.at("mask").at("paths")))));
      e.set("mask", std::move(mk));
      next.push_back(std::move(e));
    }
    set_mask_anim(d, layer, std::move(next));
  }
}

using AnimsFn = std::function<std::vector<Json>(std::vector<Json>)>;

/// groups.ts `withAnimators(layer, fn)` → `writeAnimatorData` (normalized).
void with_animators(Document& d, std::string_view layer, const AnimsFn& fn) {
  std::vector<Json> next = fn(read_animator_data(*d.node(layer)));
  for (Json& a : next) a = normalize_animator(a);
  write_animators(d, layer, std::move(next));
}

Json with_name(const Json& o, const std::optional<std::string>& name) {
  Json out = o;
  if (!name) out.erase("name");
  else out.set("name", str(*name));
  return out;
}

bool has_text(const Node& n) { return n.comp("Text") != nullptr; }

const Node& text_node_or_fail(const Document& d, const std::string& layer) {
  const Node& n = require_layer(d, layer);
  if (!has_text(n)) fail(ErrorCode::invalid_argument, "layer '" + layer + "' is not a text layer", {.layer = layer});
  return n;
}

// ── group addressing ──────────────────────────────────────────────────────

/// rig: a puppet / skeleton group (rig.hpp). control: an expression control `effects/ctrl_<name>` (controls.hpp).
enum class GK : std::uint8_t { effect, mask, animator, selector, style, pathop, rig, control, plugin };

struct GroupRef {
  GK kind = GK::effect;
  std::string layer;
  std::string id;
  std::string animator;  ///< selector: its animator's id
  int animIndex = -1;    ///< selector
  int index = 0;         ///< animator / selector index (`'index' in r`)
  std::optional<RigGroupRef> rig;  ///< GK::rig
  std::optional<LayerControl> control;  ///< GK::control (id = `ctrl_<name>`)
  std::string path;    ///< GK::plugin: plugin/<slug>/<panel> (id = the component TYPE)
  std::string prefix;  ///< GK::plugin: its params' track prefix
  [[nodiscard]] bool has_index() const { return kind == GK::animator || kind == GK::selector; }
};

GroupRef gref(GK kind, const std::string& layer, const std::string& id, const std::string& animator = {}) {
  GroupRef r;
  r.kind = kind;
  r.layer = layer;
  r.id = id;
  r.animator = animator;
  return r;
}

bool style_present(const Document& d, std::string_view layer, std::string_view key) {
  const Node* n = d.node(layer);
  if (n == nullptr) return false;
  return truthy(get_node_layer_styles(*n).at(key));
}

GroupRef resolve_group(const Document& d, const api::PropRef& ref) {
  const Node& node = require_layer(d, ref.layer);
  const std::vector<std::string> seg = split(ref.path, '/');
  auto nf = [&]() -> void {
    fail(ErrorCode::not_found, "layer '" + ref.layer + "' has no group '" + ref.path + "'",
         {.layer = ref.layer, .path = ref.path});
  };
  auto at = [&](std::size_t i) -> std::string { return i < seg.size() ? seg[i] : std::string(); };
  const bool has1 = seg.size() > 1;
  if (auto rig = resolve_rig_group(node, ref.layer, ref.path)) {
    GroupRef r = gref(GK::rig, ref.layer, rig_group_path(*rig));
    r.rig = std::move(rig);
    return r;
  }
  if (auto control = resolve_control(node, ref.path)) {
    GroupRef r = gref(GK::control, ref.layer, seg[1]);
    r.control = std::move(control);
    return r;
  }
  if (auto panel = parse_panel_group_path(ref.path)) {
    if (node.comp(panel->type) == nullptr) nf();
    GroupRef r = gref(GK::plugin, ref.layer, panel->type);
    r.path = ref.path;
    r.prefix = std::string(kPluginPanelTrackPrefix) + panel->slug + "." + panel->panel + ".";
    return r;
  }
  if (seg[0] == "effects" && seg.size() == 2) {
    if (find_by_id(read_node_effects(node), seg[1]) == nullptr) nf();
    return gref(GK::effect, ref.layer, seg[1]);
  }
  if (seg[0] == "masks" && seg.size() == 2) {
    const auto m = read_node_mask(node);
    if (!m || mask_path_by_id(*m, seg[1]) == nullptr) nf();
    return gref(GK::mask, ref.layer, seg[1]);
  }
  if (seg[0] == "text" && has1 && seg[1] == "animators" && seg.size() == 3) {
    const int index = index_of_id(read_animator_data(node), seg[2]);
    if (index < 0) nf();
    GroupRef r = gref(GK::animator, ref.layer, seg[2]);
    r.index = index;
    return r;
  }
  if (seg[0] == "text" && has1 && seg[1] == "animators" && seg.size() > 3 && at(3) == "selectors" && seg.size() == 5) {
    const std::vector<Json> data = read_animator_data(node);
    const int animIndex = index_of_id(data, seg[2]);
    const int index =
        animIndex < 0 ? -1 : index_of_id(arr_of(data[static_cast<std::size_t>(animIndex)].at("selectors")), seg[4]);
    if (index < 0) nf();
    GroupRef r = gref(GK::selector, ref.layer, seg[4], seg[2]);
    r.animIndex = animIndex;
    r.index = index;
    return r;
  }
  if (seg[0] == "styles" && seg.size() == 2) {
    if (!truthy(get_node_layer_styles(node).at(seg[1]))) nf();
    return gref(GK::style, ref.layer, seg[1]);
  }
  if (seg[0] == "contents" && seg.size() == 2) {
    if (index_of_id(read_path_ops(node), seg[1]) < 0) nf();
    return gref(GK::pathop, ref.layer, seg[1]);
  }
  nf();
  return {};
}

std::string group_path(const GroupRef& g) {
  switch (g.kind) {
    case GK::effect: return "effects/" + g.id;
    case GK::mask: return "masks/" + g.id;
    case GK::animator: return "text/animators/" + g.id;
    case GK::selector: return "text/animators/" + g.animator + "/selectors/" + g.id;
    case GK::style: return "styles/" + g.id;
    case GK::pathop: return "contents/" + g.id;
    case GK::rig: return rig_group_path(*g.rig);
    case GK::control: return "effects/" + g.id;
    case GK::plugin: return g.path;
  }
  return {};
}

/// Track-name prefix a group's scalar tracks live under (nullopt = index-addressed text animators).
/// A layer style's tracks: Glass keys `glass.<param>` (glassResolve.ts), the rest their compiled effect's.
std::string style_track_prefix(const std::string& style) {
  return style == "glass" ? std::string("glass.") : "effect.layerstyle:" + style + ".";
}

std::optional<std::string> track_prefix(const GroupRef& g) {
  switch (g.kind) {
    case GK::effect: return "effect." + g.id;
    case GK::mask: return "mask." + g.id + ".";
    case GK::style: return style_track_prefix(g.id);
    case GK::pathop: return "pathop." + g.id + ".";
    case GK::plugin: return g.prefix;
    default: return std::nullopt;
  }
}

// ── defaults ──────────────────────────────────────────────────────────────

/// textAnimators.ts `defaultAnimator()` with the engine's ids.
Json default_animator(const std::string& id, const std::string& selId) {
  const Json& base = registry().animators.at("defaultAnimator");
  Json a = obj();
  a.set("id", str(id));
  for (const auto& m : base.obj()) {
    if (m.key == "selectors") {
      Json sels = Json::array();
      for (std::size_t i = 0; i < m.value.arr().size(); ++i) {
        Json s = default_selector("range");
        s.set("id", str(selId));
        sels.arr_mut().push_back(std::move(s));
      }
      a.set("selectors", std::move(sels));
    } else {
      a.set(m.key, m.value);
    }
  }
  return a;
}

/// pathOps.ts `defaultPathOpOf(type)` without its id (`{...proto, id}` puts the id first).
Json path_op_proto(const std::string& type, const std::string& id) {
  Json out = obj();
  out.set("id", str(id));
  if (type == "none") {
    out.set("type", str("none"));
    out.set("amount", Json::number(0));
    out.set("detail", Json::number(0));
    return out;
  }
  const Json& entry = registry().pathOps.at(type);
  const Json* def = entry.is_object() && entry.at("default").is_object() ? &entry.at("default") : nullptr;
  if (def == nullptr) {
    // `{ ...defaultPathOp(), type }`
    def = &registry().pathOps.at("zigzag").at("default");
    for (const auto& m : def->obj()) out.set(m.key, m.value);
    out.set("type", str(type));
    return out;
  }
  for (const auto& m : def->obj()) out.set(m.key, m.value);
  return out;
}

std::optional<std::string> selector_kind(std::string_view matchName) {
  if (matchName == "ADBE Text Selector") return "range";
  if (matchName == "ADBE Text Wiggly Selector") return "wiggly";
  if (matchName == "ADBE Text Expressible Selector") return "expression";
  return std::nullopt;
}

bool is_selectors_parent(std::string_view parent) {
  // /^text\/animators\/[^/]+\/selectors$/
  constexpr std::string_view kHead = "text/animators/";
  constexpr std::string_view kTail = "/selectors";
  if (!parent.starts_with(kHead) || !parent.ends_with(kTail)) return false;
  if (parent.size() <= kHead.size() + kTail.size()) return false;
  const std::string_view mid = parent.substr(kHead.size(), parent.size() - kHead.size() - kTail.size());
  return mid.find('/') == std::string_view::npos;
}

void write_inits(Document& d, const std::string& layer, const std::string& prefix,
                 const std::vector<api::PropertyInit>& inits) {
  if (inits.empty()) return;
  const Catalog cat = catalog_for(d, layer);
  for (const auto& p : inits) write_static(d, layer, require_binding(cat, prefix + p.path), p.value);
}

// ── remove / enable / copy ────────────────────────────────────────────────

void remove_group(Document& d, const GroupRef& r) {
  switch (r.kind) {
    case GK::plugin:
      // The panel's values and every key / expression of its params.
      (void)sg_remove_component(d, r.layer, r.id);
      move_group_tracks(d, r.layer, r.prefix, std::nullopt);
      return;
    case GK::rig:
      remove_rig_group(d, *r.rig);
      return;
    case GK::control:
      remove_control(d, r.layer, *r.control);
      return;
    case GK::effect: {
      std::vector<Json> list = get_node_effects(d, r.layer);
      std::erase_if(list, [&](const Json& e) { return id_is(e, r.id); });
      write_node_effects(d, r.layer, std::move(list));
      move_group_tracks(d, r.layer, *track_prefix(r), std::nullopt);
      return;
    }
    case GK::mask:
      write_masks(d, r.layer, [&](std::vector<Json> paths) {
        std::erase_if(paths, [&](const Json& p) { return id_is(p, r.id); });
        return paths;
      });
      move_group_tracks(d, r.layer, *track_prefix(r), std::nullopt);
      return;
    case GK::style: {
      Json styles = get_node_layer_styles(*d.node(r.layer));
      styles.erase(r.id);
      set_layer_styles(d, r.layer, styles);
      move_group_tracks(d, r.layer, *track_prefix(r), std::nullopt);
      return;
    }
    case GK::pathop: {
      std::vector<Json> ops = read_path_ops(*d.node(r.layer));
      std::erase_if(ops, [&](const Json& o) { return id_is(o, r.id); });
      set_path_ops(d, r.layer, ops);
      move_group_tracks(d, r.layer, *track_prefix(r), std::nullopt);
      return;
    }
    case GK::animator: {
      const int idx = index_of_id(read_animator_data(*d.node(r.layer)), r.id);
      rekey_text_animator_tracks(d, r.layer, [idx](int i) -> std::optional<int> {
        if (i == idx) return std::nullopt;
        return i > idx ? i - 1 : i;
      });
      with_animators(d, r.layer, [&](std::vector<Json> list) {
        std::erase_if(list, [&](const Json& a) { return id_is(a, r.id); });
        return list;
      });
      return;
    }
    case GK::selector: {
      const std::vector<Json> data = read_animator_data(*d.node(r.layer));
      const int ai = index_of_id(data, r.animator);
      const std::vector<Json> sels = ai >= 0 ? arr_of(data[static_cast<std::size_t>(ai)].at("selectors")) : std::vector<Json>{};
      const int si = index_of_id(sels, r.id);
      if (sels.size() <= 1) fail(ErrorCode::invalid_argument, "an animator keeps at least one selector");
      rekey_text_animator_tracks(
          d, r.layer, [](int i) -> std::optional<int> { return i; },
          [ai, si](int a, int j) -> std::optional<int> {
            if (a != ai) return j;
            if (j == si) return std::nullopt;
            return j > si ? j - 1 : j;
          });
      with_animators(d, r.layer, [&](std::vector<Json> list) {
        for (std::size_t i = 0; i < list.size(); ++i) {
          if (static_cast<int>(i) != ai) continue;
          std::vector<Json> s = arr_of(list[i].at("selectors"));
          std::erase_if(s, [&](const Json& x) { return id_is(x, r.id); });
          list[i].set("selectors", Json::array(std::move(s)));
        }
        return list;
      });
      return;
    }
  }
}

void set_enabled(Document& d, const GroupRef& r, bool on) {
  switch (r.kind) {
    case GK::rig:
      set_rig_group_enabled(d, *r.rig, on);
      return;
    case GK::control:
      fail(ErrorCode::unsupported, "an expression control has no enable switch");
    case GK::plugin:
      fail(ErrorCode::unsupported, "a plugin panel has no enable switch (the plugin itself is enabled in the Plugins panel)");
    case GK::effect: {
      std::vector<Json> list = get_node_effects(d, r.layer);
      for (Json& e : list) {
        if (!id_is(e, r.id)) continue;
        e.erase("enabled");
        if (!on) e.set("enabled", Json::boolean(false));
      }
      write_node_effects(d, r.layer, std::move(list));
      return;
    }
    case GK::mask:
      // A mask has no enable bit of its own: off is mode None, remembering the mode it had.
      write_masks(d, r.layer, [&](std::vector<Json> paths) {
        for (Json& p : paths) {
          if (!id_is(p, r.id)) continue;
          const Json mode = p.at("mode");
          const bool none = mode.is_string() && mode.str() == "none";
          if (!on && !none) {
            p.set("__prevMode", mode);
            p.set("mode", str("none"));
          } else if (on && none) {
            const Json prev = p.at("__prevMode");
            p.erase("__prevMode");
            p.set("mode", nn(prev, str("add")));
          }
        }
        return paths;
      });
      return;
    case GK::style: {
      Json styles = get_node_layer_styles(*d.node(r.layer));
      Json s = spread(styles.at(r.id), Json());
      s.set("enabled", Json::boolean(on));
      styles.set(r.id, std::move(s));
      set_layer_styles(d, r.layer, styles);
      return;
    }
    case GK::pathop: {
      std::vector<Json> ops = read_path_ops(*d.node(r.layer));
      for (Json& o : ops) {
        if (id_is(o, r.id)) o.set("enabled", Json::boolean(on));
      }
      set_path_ops(d, r.layer, ops);
      return;
    }
    case GK::animator:
      with_animators(d, r.layer, [&](std::vector<Json> list) {
        for (Json& a : list) {
          if (id_is(a, r.id)) a.set("enabled", Json::boolean(on));
        }
        return list;
      });
      return;
    case GK::selector:
      with_animators(d, r.layer, [&](std::vector<Json> list) {
        for (std::size_t i = 0; i < list.size(); ++i) {
          if (static_cast<int>(i) != r.animIndex) continue;
          std::vector<Json> s = arr_of(list[i].at("selectors"));
          for (Json& x : s) {
            if (id_is(x, r.id)) x.set("enabled", Json::boolean(on));
          }
          list[i].set("selectors", Json::array(std::move(s)));
        }
        return list;
      });
      return;
  }
}

std::string mint_for(HCtx& x, const GroupRef& r, const std::string& layer) {
  Document& d = x.d;
  switch (r.kind) {
    case GK::effect:
      return x.mint_group_id("fx_", [&](const std::string& id) { return find_by_id(get_node_effects(d, layer), id) != nullptr; });
    case GK::mask:
      return x.mint_group_id("mask_", [&](const std::string& id) {
        const auto m = read_node_mask(*d.node(layer));
        return m && mask_path_by_id(*m, id) != nullptr;
      });
    case GK::pathop:
      return x.mint_group_id("op_", [&](const std::string& id) { return index_of_id(read_path_ops(*d.node(layer)), id) >= 0; });
    case GK::animator: return x.mint_group_id("anim_", [](const std::string&) { return false; });
    case GK::selector: return x.mint_group_id("sel_", [](const std::string&) { return false; });
    case GK::style: return r.id;
    case GK::rig: fail(ErrorCode::unsupported, "rig groups cannot be copied");
    case GK::control: fail(ErrorCode::unsupported, "expression controls cannot be copied");
    case GK::plugin: fail(ErrorCode::unsupported, "plugin panels cannot be copied");
  }
  return {};
}

/// Copy one group onto `to` (same layer = duplicate right after the original). Returns the new path.
std::string copy_group(HCtx& x, const GroupRef& r, const std::string& to, const std::string& newId, bool afterOriginal) {
  Document& d = x.d;
  switch (r.kind) {
    case GK::effect: {
      Json src = *find_by_id(get_node_effects(d, r.layer), r.id);
      std::vector<Json> list = get_node_effects(d, to);
      const std::size_t at = afterOriginal ? static_cast<std::size_t>(index_of_id(list, r.id) + 1) : list.size();
      src.set("id", str(newId));
      insert_at(list, at, std::move(src));
      write_node_effects(d, to, std::move(list));
      copy_group_tracks(x, r.layer, "effect." + r.id, "effect." + newId, to);
      return "effects/" + newId;
    }
    case GK::mask: {
      Json src = *mask_path_by_id(*read_node_mask(*d.node(r.layer)), r.id);
      src.set("id", str(newId));
      write_masks(d, to, [&](std::vector<Json> paths) {
        const std::size_t at = afterOriginal ? static_cast<std::size_t>(index_of_id(paths, r.id) + 1) : paths.size();
        insert_at(paths, at, src);
        return paths;
      });
      copy_group_tracks(x, r.layer, "mask." + r.id + ".", "mask." + newId + ".", to);
      return "masks/" + newId;
    }
    case GK::style: {
      const Json src = get_node_layer_styles(*d.node(r.layer)).at(r.id);
      Json styles = get_node_layer_styles(*d.node(to));
      styles.set(r.id, src);
      set_layer_styles(d, to, styles);
      const std::string p = style_track_prefix(r.id);
      copy_group_tracks(x, r.layer, p, p, to);
      return "styles/" + r.id;
    }
    case GK::pathop: {
      const std::vector<Json> srcOps = read_path_ops(*d.node(r.layer));
      Json src = srcOps[static_cast<std::size_t>(index_of_id(srcOps, r.id))];
      std::vector<Json> ops = read_path_ops(*d.node(to));
      const std::size_t at = afterOriginal ? static_cast<std::size_t>(index_of_id(ops, r.id) + 1) : ops.size();
      src.set("id", str(newId));
      insert_at(ops, at, std::move(src));
      set_path_ops(d, to, ops);
      copy_group_tracks(x, r.layer, "pathop." + r.id + ".", "pathop." + newId + ".", to);
      return "contents/" + newId;
    }
    case GK::animator: {
      const std::vector<Json> data = read_animator_data(*d.node(r.layer));
      const int idx = index_of_id(data, r.id);
      const int at = idx + 1;
      Json copy = data[static_cast<std::size_t>(idx)];
      copy.set("id", str(newId));
      Json sels = Json::array();
      for (const Json& s : arr_of(data[static_cast<std::size_t>(idx)].at("selectors"))) {
        Json c = s;
        c.set("id", str(x.mint_group_id("sel_", [](const std::string&) { return false; })));
        sels.arr_mut().push_back(std::move(c));
      }
      copy.set("selectors", std::move(sels));
      rekey_text_animator_tracks(d, r.layer, [at](int i) -> std::optional<int> { return i >= at ? i + 1 : i; });
      // Copy the original's tracks into the new slot.
      if (auto snap = snapshot_node(d, r.layer)) {
        const std::string from = "ta." + std::to_string(idx) + ".";
        const std::string dest = "ta." + std::to_string(at) + ".";
        auto add = [&](auto& section) {
          const auto entries = section.entries();
          for (const auto& [k, v] : entries) {
            // /^ta\.(\d+)\.(.+)$/ with Number(m[1]) === idx
            const auto ref = parse_animator_track(k);
            if (!ref || ref->anim != idx) continue;
            const std::size_t dot = k.find('.', 3);
            if (dot == std::string::npos || dot + 1 >= k.size()) continue;
            section.set(dest + k.substr(dot + 1), v);
          }
        };
        add(snap->tracks);
        add(snap->exprs);
        restore_node(d, r.layer, std::move(*snap));
      }
      with_animators(d, r.layer, [&](std::vector<Json> list) {
        insert_at(list, static_cast<std::size_t>(at), copy);
        return list;
      });
      return "text/animators/" + newId;
    }
    case GK::selector: fail(ErrorCode::unsupported, "duplicate the animator to copy its selectors");
    case GK::rig: fail(ErrorCode::unsupported, "rig groups cannot be copied");
    case GK::control: fail(ErrorCode::unsupported, "expression controls cannot be copied");
    case GK::plugin: fail(ErrorCode::unsupported, "plugin panels cannot be copied");
  }
  return {};
}

// ── presets (animationPresets.ts) ────────────────────────────────────────

struct PresetKey {
  double t = 0;
  double value = 0;
  std::optional<api::Easing> easing;
  std::optional<std::array<double, 4>> bezier;
};

struct PresetTrack {
  std::string prop;
  std::vector<PresetKey> keys;
  bool relative = false;
  std::optional<std::string> unit;
};

std::vector<PresetTrack> preset_tracks(const Json& preset) {
  std::vector<PresetTrack> out;
  for (const Json& t : arr_of(preset.at("tracks"))) {
    PresetTrack pt;
    pt.prop = t.at("prop").str();
    pt.relative = truthy(t.at("relative"));
    if (t.at("unit").is_string()) pt.unit = t.at("unit").str();
    for (const Json& k : arr_of(t.at("keyframes"))) {
      PresetKey pk;
      pk.t = k.at("t").num();
      pk.value = k.at("value").num();
      if (k.at("easing").is_string()) pk.easing = easing_from_string(k.at("easing").str());
      const Json& bz = k.at("bezier");
      if (bz.is_array() && bz.arr().size() == 4) {
        pk.bezier = std::array<double, 4>{bz.arr()[0].num(), bz.arr()[1].num(), bz.arr()[2].num(), bz.arr()[3].num()};
      }
      pt.keys.push_back(pk);
    }
    out.push_back(std::move(pt));
  }
  return out;
}

struct PresetContext {
  double compWidth = 1920;
  double compHeight = 1080;
  double layerWidth = 400;
  double layerHeight = 200;
  double fontSize = 48;
  double layerDuration = 2;
};

std::optional<double> node_number(const Document& d, std::string_view layer, std::string_view key) {
  const Node* n = d.node(layer);
  if (n == nullptr) return std::nullopt;
  for (const Component& c : n->components) {
    const Json& v = c.props.at(key);
    if (v.is_finite_number()) return v.num();
  }
  return std::nullopt;
}

/// presetContext.ts `presetContextFor(nodeId)`.
PresetContext preset_context_for(const HCtx& x, std::string_view layer) {
  PresetContext c;
  const Json* comp = x.d.comp(x.view.tabComp);
  auto cnum = [&](std::string_view k) -> std::optional<double> {
    if (comp == nullptr) return std::nullopt;
    const Json& v = comp->at(k);
    if (v.is_undefined() || v.is_null()) return std::nullopt;
    return v.num();
  };
  c.compWidth = cnum("width").value_or(1920);
  c.compHeight = cnum("height").value_or(1080);
  c.layerWidth = node_number(x.d, layer, "width").value_or(400);
  c.layerHeight = node_number(x.d, layer, "height").value_or(200);
  c.fontSize = node_number(x.d, layer, "fontSize").value_or(48);
  if (auto v = node_number(x.d, layer, "durationSeconds")) c.layerDuration = *v;
  else c.layerDuration = cnum("durationSeconds").value_or(2);
  return c;
}

double unit_scale(const std::optional<std::string>& unit, const PresetContext& c) {
  if (!unit) return 1;
  if (*unit == "compW") return c.compWidth;
  if (*unit == "compH") return c.compHeight;
  if (*unit == "compMin") return std::min(c.compWidth, c.compHeight);
  if (*unit == "layerW") return c.layerWidth;
  if (*unit == "layerH") return c.layerHeight;
  if (*unit == "fontSize") return c.fontSize;
  return 1;
}

/// `nodeBaseValue(nodeId, prop, atTime)`: sampled animation first, then the base scene prop.
std::optional<double> node_base_value(HCtx& x, std::string_view layer, std::string_view prop, double atTime) {
  if (auto s = anim_sample(x.d, x.expr, x.cache, layer, prop, atTime)) return s;
  const Node* n = x.d.node(layer);
  if (n == nullptr) return std::nullopt;
  for (const Component& c : n->components) {
    const Json& v = c.props.at(prop);
    if (v.is_number()) return v.num();
  }
  return std::nullopt;
}

/// AnimationEngine.setBezier(node, prop, t, bezier) (continuous defaults on).
void set_bezier(Document& d, std::string_view layer, std::string_view prop, double t, const std::array<double, 4>& bz) {
  const auto* cur = anim_track(d, layer, prop);
  if (cur == nullptr) return;
  const auto it = std::find_if(cur->begin(), cur->end(), [t](const Key& k) { return k.t == t; });
  if (it == cur->end()) return;
  const auto pos = static_cast<std::size_t>(it - cur->begin());
  std::vector<Key>* track = d.anim_mut(layer).tracks.find(prop);
  Key& k = (*track)[pos];
  k.easing = api::Easing::bezier;
  k.bezier = bz;
  if (!k.continuous) k.continuous = true;
}

/// `applyPresetTracks(nodeId, tracks, atTime, engine, timeUnit)`.
void apply_preset_tracks(HCtx& x, const std::string& layer, const std::vector<PresetTrack>& tracks, double atTime,
                         const std::optional<std::string>& timeUnit) {
  Document& d = x.d;
  const PresetContext ctx = preset_context_for(x, layer);
  std::vector<PresetTrack> resolved = tracks;
  for (PresetTrack& t : resolved) {
    const double s = unit_scale(t.unit, ctx);
    for (PresetKey& k : t.keys) {
      if (timeUnit && *timeUnit == "duration") k.t = k.t * std::max(0.0001, ctx.layerDuration);
      k.value = k.value * s;
    }
  }
  for (PresetTrack& t : resolved) {
    if (!t.relative) continue;
    double base = 0;
    if (auto b = node_base_value(x, layer, t.prop, atTime)) {
      base = *b;
    } else if (t.prop == "scale") {
      base = 1;
    } else if (t.prop == "opacity") {
      base = 100;
    }
    for (PresetKey& k : t.keys) k.value = base + k.value;
  }
  const bool uses3D = std::any_of(tracks.begin(), tracks.end(), [](const PresetTrack& t) {
    return t.prop == "z" || t.prop == "rotationX" || t.prop == "rotationY";
  });
  if (uses3D) {
    const Node* n = d.node(layer);
    if (n != nullptr) {
      const std::string kind = n->kind();
      if (kind != "camera" && kind != "light" && !is_3d_enabled(*n)) set_3d_enabled(x, layer, true);
    }
  }
  for (const PresetTrack& t : resolved) {
    for (const PresetKey& k : t.keys) {
      const double at = k.t + atTime;
      anim_set_keyframe(d, layer, t.prop, at, k.value, k.easing);
      if (k.bezier) set_bezier(d, layer, t.prop, at, *k.bezier);
    }
  }
}

// graphemes.ts `splitGraphemes` (code points; CR LF, combining marks, variation
// selectors and ZWJ sequences join — enough for the reveal-fit count).
std::vector<std::u32string> split_graphemes(std::string_view s) {
  std::vector<char32_t> cps;
  for (std::size_t i = 0; i < s.size();) {
    const auto c = static_cast<unsigned char>(s[i]);
    char32_t cp = c;
    std::size_t len = 1;
    if (c >= 0xF0 && i + 3 < s.size()) {
      cp = ((c & 0x07U) << 18) | ((static_cast<unsigned char>(s[i + 1]) & 0x3FU) << 12) |
           ((static_cast<unsigned char>(s[i + 2]) & 0x3FU) << 6) | (static_cast<unsigned char>(s[i + 3]) & 0x3FU);
      len = 4;
    } else if (c >= 0xE0 && i + 2 < s.size()) {
      cp = ((c & 0x0FU) << 12) | ((static_cast<unsigned char>(s[i + 1]) & 0x3FU) << 6) |
           (static_cast<unsigned char>(s[i + 2]) & 0x3FU);
      len = 3;
    } else if (c >= 0xC0 && i + 1 < s.size()) {
      cp = ((c & 0x1FU) << 6) | (static_cast<unsigned char>(s[i + 1]) & 0x3FU);
      len = 2;
    }
    cps.push_back(cp);
    i += len;
  }
  auto extend = [](char32_t c) {
    return (c >= 0x300 && c <= 0x36F) || (c >= 0xFE00 && c <= 0xFE0F) || c == 0x200D || (c >= 0x1F3FB && c <= 0x1F3FF);
  };
  std::vector<std::u32string> out;
  for (std::size_t i = 0; i < cps.size(); ++i) {
    const char32_t c = cps[i];
    if (!out.empty()) {
      const std::u32string& last = out.back();
      const char32_t prev = last.back();
      const bool join = (prev == U'\r' && c == U'\n' && last.size() == 1) ||
                        (prev != U'\r' && prev != U'\n' && (extend(c) || prev == 0x200D));
      if (join) {
        out.back().push_back(c);
        continue;
      }
    }
    out.emplace_back(1, c);
  }
  return out;
}

bool js_space(const std::u32string& g) {
  if (g.size() != 1) return false;
  const char32_t c = g[0];
  return c == U' ' || c == U'\t' || c == U'\n' || c == U'\r' || c == 0x0B || c == 0x0C || c == 0xA0 || c == 0x1680 ||
         (c >= 0x2000 && c <= 0x200A) || c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x3000 ||
         c == 0xFEFF;
}

/// textSelectors.ts `unitPositions(text, basedOn).count`.
double unit_count(std::string_view text, std::string_view basedOn) {
  const auto chars = split_graphemes(text);
  if (basedOn == "characters") return static_cast<double>(chars.size());
  if (basedOn == "charactersExcludingSpaces") {
    double n = 0;
    for (const auto& c : chars) {
      if (!js_space(c)) n += 1;
    }
    return n;
  }
  if (basedOn == "lines") {
    double n = 0;
    for (const auto& c : chars) {
      if (c.size() == 1 && c[0] == U'\n') n += 1;
    }
    return n + 1;
  }
  int wordIdx = -1;
  bool prevSpace = true;
  for (const auto& c : chars) {
    const bool space = js_space(c);
    if (!space && prevSpace) ++wordIdx;
    prevSpace = space;
  }
  return wordIdx < 0 ? std::max(1.0, static_cast<double>(chars.size())) : static_cast<double>(wordIdx + 1);
}

/// `fitRevealSweeps(preset, tracks, text)`.
std::vector<PresetTrack> fit_reveal_sweeps(const Json& preset, std::vector<PresetTrack> tracks,
                                           const std::optional<std::string>& text) {
  const Json& animators = preset.at("animators");
  if (!animators.is_array() || animators.arr().empty() || !text || text->empty()) return tracks;
  for (PresetTrack& t : tracks) {
    // /^ta\.(\d+)\.(start|end)$/
    if (!t.prop.starts_with("ta.")) continue;
    const std::size_t dot = t.prop.find('.', 3);
    if (dot == std::string::npos) continue;
    const auto idx = parse_index(std::string_view(t.prop).substr(3, dot - 3));
    const std::string param = t.prop.substr(dot + 1);
    if (!idx || (param != "start" && param != "end")) continue;
    const auto ai = static_cast<std::size_t>(*idx);
    if (ai >= animators.arr().size()) continue;
    const Json& sels = animators.arr()[ai].at("selectors");
    if (!sels.is_array() || sels.arr().empty()) continue;
    const Json& sel = sels.arr()[0];
    if (!(sel.at("kind").is_string() && sel.at("kind").str() == "range")) continue;
    const double count = unit_count(*text, sel.at("basedOn").is_string() ? sel.at("basedOn").str() : "");
    if (count <= 0) continue;
    const double halfEdge = sel.at("smoothness").num() / count / 2;
    const double from = -halfEdge - 2;
    const double to = 100 + halfEdge + 2;
    if (t.keys.empty()) continue;  // Math.min() of nothing = Infinity → span NaN → unchanged values (NaN math aside)
    double lo = t.keys[0].value;
    double hi = t.keys[0].value;
    for (const PresetKey& k : t.keys) {
      lo = std::min(lo, k.value);
      hi = std::max(hi, k.value);
    }
    const double span = hi - lo;
    if (span == 0) continue;
    for (PresetKey& k : t.keys) k.value = from + ((k.value - lo) / span) * (to - from);
  }
  return tracks;
}

/// `reindexAnimatorTracks(tracks, shift)`.
void reindex_animator_tracks(std::vector<PresetTrack>& tracks, int shift) {
  if (shift == 0) return;
  for (PresetTrack& t : tracks) {
    // /^ta\.(\d+)\.(.*)$/
    if (!t.prop.starts_with("ta.")) continue;
    const std::size_t dot = t.prop.find('.', 3);
    if (dot == std::string::npos) continue;
    const auto idx = parse_index(std::string_view(t.prop).substr(3, dot - 3));
    if (!idx) continue;
    t.prop = "ta." + std::to_string(*idx + shift) + "." + t.prop.substr(dot + 1);
  }
}

constexpr std::string_view kPresetAnimPrefix = "anim_preset_";
constexpr std::string_view kPresetFxPrefix = "pfx_preset_";

/// `installAnimators(nodeId, animators)` → the first installed index (placeholder ids).
int install_animators(Document& d, const std::string& layer, const Json& animators) {
  const Node* n = d.node(layer);
  if (n == nullptr || !has_text(*n)) return -1;
  std::vector<Json> list = read_animator_data(*n);
  const std::size_t existing = list.size();
  std::size_t i = 0;
  for (const Json& a : animators.arr()) {
    // The preset literal carries its id FIRST (`{...defaultAnimator(), ...}`).
    Json s = obj();
    s.set("id", str(std::string(kPresetAnimPrefix) + std::to_string(existing + i)));
    for (const auto& m : a.obj()) s.set(m.key, m.value);
    if (a.at("selectors").is_array()) {
      Json sels = Json::array();
      std::size_t j = 0;
      for (const Json& sel : a.at("selectors").arr()) {
        Json c = sel;
        c.set("id", str("sel_preset_" + std::to_string(i) + "_" + std::to_string(j)));
        sels.arr_mut().push_back(std::move(c));
        ++j;
      }
      s.set("selectors", std::move(sels));
    }
    list.push_back(std::move(s));
    ++i;
  }
  for (Json& a : list) a = normalize_animator(a);
  write_animators(d, layer, std::move(list));
  return static_cast<int>(existing);
}

/// `installEffects(nodeId, effects)` → preset id → installed (placeholder) id.
std::map<std::string, std::string> install_effects(Document& d, const std::string& layer, const Json& effects) {
  std::vector<Json> list = get_node_effects(d, layer);
  std::map<std::string, std::string> mapping;
  std::size_t i = 0;
  for (const Json& e : effects.arr()) {
    const std::string realId = std::string(kPresetFxPrefix) + std::to_string(i);
    mapping[e.at("id").str()] = realId;
    Json fx = obj();
    fx.set("id", str(realId));
    fx.set("type", e.at("type"));
    fx.set("params", e.at("params").is_undefined() || e.at("params").is_null() ? obj() : e.at("params"));
    list.push_back(std::move(fx));
    ++i;
  }
  write_node_effects(d, layer, std::move(list));
  return mapping;
}

/// `remapEffectTracks(tracks, mapping)`.
void remap_effect_tracks(std::vector<PresetTrack>& tracks, const std::map<std::string, std::string>& mapping) {
  if (mapping.empty()) return;
  for (PresetTrack& t : tracks) {
    // /^effect\.([^.]+)\.(.*)$/
    if (!t.prop.starts_with("effect.")) continue;
    const std::size_t dot = t.prop.find('.', 7);
    if (dot == std::string::npos || dot == 7) continue;
    const auto it = mapping.find(t.prop.substr(7, dot - 7));
    if (it == mapping.end()) continue;
    t.prop = "effect." + it->second + "." + t.prop.substr(dot + 1);
  }
}

std::optional<std::string> node_text(const Document& d, std::string_view layer) {
  const Node* n = d.node(layer);
  if (n == nullptr) return std::nullopt;
  const Component* t = n->comp("Text");
  if (t == nullptr) return std::nullopt;
  const Json& v = t->props.at("content");
  return v.is_string() ? std::optional<std::string>(v.str()) : std::nullopt;
}

/// cameraPresets.ts `applyDollyZoom`.
bool apply_dolly_zoom(HCtx& x, const std::string& layer, double atTime) {
  const Node* n = x.d.node(layer);
  if (n == nullptr || n->kind() != "camera") return false;
  const PresetContext ctx = preset_context_for(x, layer);
  // camera3d.ts defaultFocalLength(width) = focalLengthForFov(width, 39.6)
  const double fov = std::max(1.0, std::min(179.0, 39.6)) * (std::numbers::pi / 180);
  const double defaultFocal = ctx.compWidth / 2 / motion::js::tan(fov / 2);
  const double f0 = node_base_value(x, layer, "focalLength", atTime).value_or(defaultFocal);
  const double z0 = node_base_value(x, layer, "z", atTime).value_or(-f0);
  const double d0 = std::max(1.0, -z0);
  constexpr double kDuration = 3;
  constexpr int kSamples = 5;
  constexpr double kSqueeze = 0.4;
  for (int i = 0; i < kSamples; ++i) {
    const double u = static_cast<double>(i) / (kSamples - 1);
    const double s = u * u * (3 - 2 * u);
    const double dd = d0 * (1 - kSqueeze * s);
    anim_set_keyframe(x.d, layer, "z", atTime + u * kDuration, -dd);
    anim_set_keyframe(x.d, layer, "focalLength", atTime + u * kDuration, (f0 * dd) / d0);
  }
  return true;
}

/// animationPresets.ts `applyPreset(preset, nodeId, atTime)`.
bool apply_preset(HCtx& x, const Json& preset, const std::string& layer, double atTime) {
  Document& d = x.d;
  if (preset.at("requires").is_string() && preset.at("requires").str() == "camera") {
    const Node* n = d.node(layer);
    if (n == nullptr || n->kind() != "camera") return false;
  }
  if (truthy(preset.at("hasApplyFn"))) {
    if (preset.at("name").str() == "Dolly Zoom (Vertigo)") return apply_dolly_zoom(x, layer, atTime);
    fail(ErrorCode::unsupported, "preset '" + preset.at("name").str() + "' is code this engine has not ported");
  }
  std::vector<PresetTrack> tracks = preset_tracks(preset);
  const Json& animators = preset.at("animators");
  if (animators.is_array() && !animators.arr().empty()) {
    const Node* n = d.node(layer);
    if (n == nullptr || !has_text(*n)) return false;
    const int shift = install_animators(d, layer, animators);
    if (shift < 0) return false;
    tracks = fit_reveal_sweeps(preset, std::move(tracks), node_text(d, layer));
    reindex_animator_tracks(tracks, shift);
  }
  const Json& effects = preset.at("effects");
  if (effects.is_array() && !effects.arr().empty()) remap_effect_tracks(tracks, install_effects(d, layer, effects));
  if (!tracks.empty()) {
    const Json& tu = preset.at("timeUnit");
    apply_preset_tracks(x, layer, tracks, atTime, tu.is_string() ? std::optional<std::string>(tu.str()) : std::nullopt);
  }
  const Json& exprs = preset.at("expressions");
  if (exprs.is_array() && !exprs.arr().empty()) {
    for (const Json& e : exprs.arr()) {
      const std::string prop = e.at("prop").str();
      const ExprState* cur = anim_expr(d, layer, prop);
      anim_set_expr_state(d, layer, prop, ExprState{e.at("expr").str(), cur != nullptr ? cur->enabled : true});
    }
  }
  return true;
}

std::string track_name(int anim, std::optional<int> sel, const std::string& param) {
  const std::string a = "ta." + std::to_string(anim) + ".";
  if (!sel) return a + param;
  if (*sel == 0) {
    if (param == "start" || param == "end" || param == "offset") return a + param;
    if (param == "wigglesPerSecond") return a + "wiggleFreq";
  }
  return a + "s" + std::to_string(*sel) + "." + param;
}

std::vector<std::string> ids_of(const std::vector<Json>& list) {
  std::vector<std::string> out;
  for (const Json& e : list) out.push_back(e.at("id").is_string() ? e.at("id").str() : std::string());
  return out;
}

}  // namespace

// ── rekeyTextAnimatorTracks ──────────────────────────────────────────────

void rekey_text_animator_tracks(Document& d, std::string_view layer,
                                const std::function<std::optional<int>(int)>& mapAnim,
                                const std::function<std::optional<int>(int, int)>& mapSel) {
  auto snap = snapshot_node(d, layer);
  if (!snap) return;
  bool changed = false;
  auto remap = [&](const auto& section) {
    std::remove_cvref_t<decltype(section)> out;
    for (const auto& [prop, v] : section) {
      const auto ref = parse_animator_track(prop);
      if (!ref) {
        out.set(prop, v);
        continue;
      }
      const std::optional<int> anim = mapAnim(ref->anim);
      std::optional<int> sel;
      if (ref->sel) sel = mapSel ? mapSel(ref->anim, *ref->sel) : ref->sel;
      if (!anim || (ref->sel && !sel)) {
        changed = true;
        continue;
      }
      const std::string name = track_name(*anim, sel, ref->param);
      if (name != prop) changed = true;
      out.set(name, v);
    }
    return out;
  };
  NodeAnim next;
  next.tracks = remap(snap->tracks);
  next.exprs = remap(snap->exprs);
  next.data = remap(snap->data);
  if (changed) restore_node(d, layer, std::move(next));
}

// ── handlers ─────────────────────────────────────────────────────────────

ResultOf<api::AddEffect> handle(const api::AddEffect& c, HCtx& x) {
  Document& d = x.d;
  if (c.layers.empty()) fail(ErrorCode::invalid_argument, "no layers given");
  const EffectDef* def = registry().effect(c.effect);
  if (def == nullptr) {
    Json detail = obj();
    detail.set("effect", str(c.effect));
    fail(ErrorCode::not_found, "no effect '" + c.effect + "'", {.detail = js::stringify(detail)});
  }
  native_check_addable(c.effect);  // G1: a disabled / failed plugin's effect
  std::vector<std::string> ids;
  for (const auto& layer : c.layers) {
    (void)require_layer(d, layer);
    const std::size_t count = get_node_effects(d, layer).size();
    if (c.index && *c.index > count) {
      fail(ErrorCode::out_of_range,
           "index " + std::to_string(*c.index) + " is past the " + std::to_string(count) + " effects of '" + layer + "'",
           {.layer = layer});
    }
    ids.push_back(x.mint_group_id("fx_", [&](const std::string& id) { return find_by_id(get_node_effects(d, layer), id) != nullptr; }));
  }
  x.label = def->label;
  for (std::size_t i = 0; i < c.layers.size(); ++i) {
    const std::string& layer = c.layers[i];
    std::vector<Json> effects = get_node_effects(d, layer);
    const std::size_t at = c.index ? *c.index : effects.size();
    Json e = obj();
    e.set("id", str(ids[i]));
    e.set("type", str(c.effect));
    e.set("params", new_instance_params_of(*def));
    insert_at(effects, at, std::move(e));
    write_node_effects(d, layer, std::move(effects));
    write_inits(d, layer, "effects/" + ids[i] + "/", c.params);
    native_effect_added(d, layer, ids[i], c.effect);  // G1: a plugin instance's initial sequence data
  }
  api::GroupList out;
  for (const auto& id : ids) out.groups.push_back("effects/" + id);
  return out;
}

ResultOf<api::AddMask> handle(const api::AddMask& c, HCtx& x) {
  Document& d = x.d;
  const Node& node = require_layer(d, c.layer);
  const auto m = read_node_mask(node);
  const std::size_t count = m ? m->at("paths").arr().size() : 0;
  if (c.index && *c.index > count) {
    fail(ErrorCode::out_of_range, "index " + std::to_string(*c.index) + " is past the " + std::to_string(count) + " masks");
  }
  Json points = bezier_to_points(c.path, nullptr);
  const std::string id = x.mint_group_id("mask_", [&](const std::string& v) {
    const auto mm = read_node_mask(*d.node(c.layer));
    return mm && mask_path_by_id(*mm, v) != nullptr;
  });
  Json mask = obj();
  mask.set("id", str(id));
  mask.set("mode", str(std::string(api::to_string(c.mode))));
  mask.set("closed", Json::boolean(c.path.closed));
  mask.set("points", std::move(points));
  mask.set("feather", Json::number(0));
  mask.set("opacity", Json::number(1));
  mask.set("expansion", Json::number(0));
  mask.set("inverted", Json::boolean(c.inverted));
  if (c.name && !c.name->empty()) mask.set("name", str(*c.name));
  x.label = "New Mask";
  write_masks(d, c.layer, [&](std::vector<Json> paths) {
    insert_at(paths, c.index ? *c.index : paths.size(), mask);
    return paths;
  });
  api::GroupList out;
  out.groups.push_back("masks/" + id);
  return out;
}

ResultOf<api::AddPropertyGroup> handle(const api::AddPropertyGroup& c, HCtx& x) {
  Document& d = x.d;
  const Node& node0 = require_layer(d, c.layer);
  const std::string layer = c.layer;
  const std::string& parent = c.parent;
  std::function<std::string()> run;
  const auto selKind = selector_kind(c.match_name);
  if (parent == "text/animators" && c.match_name == "ADBE Text Animator") {
    (void)text_node_or_fail(d, layer);
    const std::size_t count = read_animator_data(node0).size();
    const std::size_t at = c.index ? *c.index : count;
    if (at > count) fail(ErrorCode::out_of_range, "index " + std::to_string(at) + " is past the " + std::to_string(count) + " animators");
    const std::string id = x.mint_group_id("anim_", [&](const std::string& v) {
      return index_of_id(read_animator_data(*d.node(layer)), v) >= 0;
    });
    const std::string selId = x.mint_group_id("sel_", [](const std::string&) { return false; });
    run = [&, at, id, selId]() {
      Json a = default_animator(id, selId);
      if (c.name && !c.name->empty()) a.set("name", str(*c.name));
      // Animators after the insert point move up one slot, and their tracks with them.
      const int ati = static_cast<int>(at);
      rekey_text_animator_tracks(d, layer, [ati](int i) -> std::optional<int> { return i >= ati ? i + 1 : i; });
      with_animators(d, layer, [&](std::vector<Json> list) {
        insert_at(list, at, a);
        return list;
      });
      return "text/animators/" + id;
    };
  } else if (is_selectors_parent(parent) && selKind) {
    (void)text_node_or_fail(d, layer);
    const std::string aid = split(parent, '/')[2];
    const std::vector<Json> data = read_animator_data(node0);
    const int ai = index_of_id(data, aid);
    if (ai < 0) fail(ErrorCode::not_found, "no animator '" + aid + "'", {.layer = layer, .path = parent});
    const std::size_t count = arr_of(data[static_cast<std::size_t>(ai)].at("selectors")).size();
    const std::size_t at = c.index ? *c.index : count;
    if (at > count) fail(ErrorCode::out_of_range, "index " + std::to_string(at) + " is past the " + std::to_string(count) + " selectors");
    const std::string id = x.mint_group_id("sel_", [](const std::string&) { return false; });
    const std::string kind = *selKind;
    run = [&, ai, at, id, aid, kind]() {
      Json s = default_selector(kind);
      s.set("id", str(id));
      const int ati = static_cast<int>(at);
      rekey_text_animator_tracks(
          d, layer, [](int i) -> std::optional<int> { return i; },
          [ai, ati](int a, int j) -> std::optional<int> { return a == ai && j >= ati ? j + 1 : j; });
      with_animators(d, layer, [&](std::vector<Json> list) {
        const auto i = static_cast<std::size_t>(ai);
        if (i < list.size()) {
          std::vector<Json> sels = arr_of(list[i].at("selectors"));
          insert_at(sels, at, s);
          list[i].set("selectors", Json::array(std::move(sels)));
        }
        return list;
      });
      return "text/animators/" + aid + "/selectors/" + id;
    };
  } else if (parent == "styles" && c.match_name.starts_with("style:")) {
    const std::string key = c.match_name.substr(6);
    const Json* make = registry().layerStyles.at("defaults").find(key);
    if (make == nullptr) fail(ErrorCode::not_found, "no layer style '" + key + "'");
    if (style_present(d, layer, key)) fail(ErrorCode::conflict, "layer '" + layer + "' already has a " + key + " style", {.layer = layer});
    const Json proto = *make;
    run = [&, key, proto]() {
      Json styles = get_node_layer_styles(*d.node(layer));
      Json on = obj();
      on.set("enabled", Json::boolean(true));
      styles.set(key, spread(proto, on));
      set_layer_styles(d, layer, styles);
      return "styles/" + key;
    };
  } else if (parent == "contents" && c.match_name.starts_with("pathop:")) {
    const std::string type = c.match_name.substr(7);
    const std::vector<Json> ops = read_path_ops(node0);
    const std::size_t at = c.index ? *c.index : ops.size();
    if (at > ops.size()) fail(ErrorCode::out_of_range, "index " + std::to_string(at) + " is past the " + std::to_string(ops.size()) + " operators");
    const std::string id = x.mint_group_id("op_", [&](const std::string& v) { return index_of_id(ops, v) >= 0; });
    run = [&, type, at, id]() {
      std::vector<Json> next = read_path_ops(*d.node(layer));
      insert_at(next, at, path_op_proto(type, id));
      set_path_ops(d, layer, next);
      return "contents/" + id;
    };
  } else if (const ControlSpec* spec = parent == "effects" ? control_spec_for_match_name(c.match_name) : nullptr) {
    // B3: an expression control (controls.hpp): named by `name`, else the next
    // free "Slider 1"-style name; `init` writes its value.
    if (node0.comp("Transform") == nullptr) {
      fail(ErrorCode::invalid_argument, "layer '" + layer + "' has no Transform to hold an expression control", {.layer = layer});
    }
    if (c.index) fail(ErrorCode::unsupported, "expression controls are appended; they have no index", {.layer = layer, .path = "effects"});
    const std::string name = c.name && !js_trim(*c.name).empty() ? valid_control_name(*c.name) : next_free_control_name(d, *spec);
    require_free_control_name(node0, *spec, name);
    run = [&d, layer, spec, name]() {
      const std::string tid = transform_id(d, layer);
      for (std::size_t i = 0; i < spec->components.size(); ++i) {
        const double v = i < spec->defaults.size() ? spec->defaults[i] : 0.0;
        (void)sg_write_prop(d, layer, tid, std::string(kControlPrefix) + name + spec->components[i], Json::number(v));
      }
      (void)sg_write_prop(d, layer, tid, std::string(kControlKindPrefix) + name, Json::string(spec->kind));
      return control_group_path(name);
    };
  } else if (parent == "plugin" && panel_group_for_match_name(c.match_name)) {
    // B3z: a contributed plugin panel's params, seeded WHOLE from `init` (the
    // client holds the panel's declared defaults — the engine has no schema).
    const std::string path = *panel_group_for_match_name(c.match_name);
    const PanelGroup panel = *parse_panel_group_path(path);
    for (const Component& comp : node0.components) {
      if (comp.type == panel.type || comp.id == panel.id) {
        fail(ErrorCode::conflict, "layer '" + layer + "' already has '" + path + "'", {.layer = layer, .path = path});
      }
    }
    Json props = panel_init_props(c.init);
    x.label = "Add " + c.match_name;
    (void)sg_add_component(d, layer, Component{panel.id, panel.type, std::move(props)});
    api::GroupList out;
    out.groups.push_back(path);
    return out;
  } else if (auto rigPlan = plan_rig_add(d, layer, parent, c.match_name, c.index, c.name, c.init,
                                           [&x](std::string_view prefix, const std::function<bool(const std::string&)>& taken) {
                                             return x.mint_group_id(prefix, taken);
                                           })) {
    // Rig groups write their own init (a new group's values, no bind-pose capture).
    x.label = "Add " + c.match_name;
    rigPlan->run();
    api::GroupList out;
    out.groups.push_back(rigPlan->path);
    return out;
  } else {
    fail(ErrorCode::unsupported,
         "'" + c.match_name + "' under '" + parent + "' is not a group this engine can add (listGroupTypes lists what it can)",
         {.path = parent});
  }
  x.label = "Add " + c.match_name;
  const std::string path = run();
  write_inits(d, layer, path + "/", c.init);
  api::GroupList out;
  out.groups.push_back(path);
  return out;
}

ResultOf<api::RemovePropertyGroups> handle(const api::RemovePropertyGroups& c, HCtx& x) {
  Document& d = x.d;
  if (c.groups.empty()) fail(ErrorCode::invalid_argument, "no groups given");
  std::vector<GroupRef> refs;
  for (const auto& g : c.groups) refs.push_back(resolve_group(d, g));
  // Remove text animators/selectors highest index first so earlier indices stay valid.
  std::stable_sort(refs.begin(), refs.end(), [](const GroupRef& a, const GroupRef& b) {
    return (a.has_index() ? a.index : 0) > (b.has_index() ? b.index : 0);
  });
  x.label = "Remove " + plural(refs.size(), "Group");
  for (const auto& r : refs) remove_group(d, r);
  return {};
}

ResultOf<api::MovePropertyGroup> handle(const api::MovePropertyGroup& c, HCtx& x) {
  Document& d = x.d;
  const GroupRef r = resolve_group(d, c.group);
  x.label = "Move Group";
  const std::size_t to = c.to_index;
  const Node& node = *d.node(r.layer);
  switch (r.kind) {
    case GK::effect: {
      const std::vector<Json> list = get_node_effects(d, r.layer);
      if (to >= list.size()) fail(ErrorCode::out_of_range, "toIndex past the end");
      write_node_effects(d, r.layer, move_item(list, index_of_id(list, r.id), to));
      break;
    }
    case GK::mask: {
      const auto m = read_node_mask(node);
      const std::size_t n = m ? m->at("paths").arr().size() : 0;
      if (to >= n) fail(ErrorCode::out_of_range, "toIndex past the end");
      write_masks(d, r.layer, [&](std::vector<Json> paths) { return move_item(paths, index_of_id(paths, r.id), to); });
      break;
    }
    case GK::pathop: {
      const std::vector<Json> ops = read_path_ops(node);
      if (to >= ops.size()) fail(ErrorCode::out_of_range, "toIndex past the end");
      set_path_ops(d, r.layer, move_item(ops, index_of_id(ops, r.id), to));
      break;
    }
    case GK::animator: {
      const std::size_t n = read_animator_data(node).size();
      if (to >= n) fail(ErrorCode::out_of_range, "toIndex past the end");
      std::vector<int> order(n);
      for (std::size_t i = 0; i < n; ++i) order[i] = static_cast<int>(i);
      order = move_item(order, r.index, to);
      rekey_text_animator_tracks(d, r.layer, [&order](int i) -> std::optional<int> {
        const auto it = std::find(order.begin(), order.end(), i);
        return it == order.end() ? -1 : static_cast<int>(it - order.begin());
      });
      with_animators(d, r.layer, [&](std::vector<Json> list) { return move_item(list, r.index, to); });
      break;
    }
    case GK::selector: {
      const std::vector<Json> data = read_animator_data(node);
      const std::size_t n = arr_of(data[static_cast<std::size_t>(r.animIndex)].at("selectors")).size();
      if (to >= n) fail(ErrorCode::out_of_range, "toIndex past the end");
      std::vector<int> order(n);
      for (std::size_t i = 0; i < n; ++i) order[i] = static_cast<int>(i);
      order = move_item(order, r.index, to);
      const int ai = r.animIndex;
      rekey_text_animator_tracks(
          d, r.layer, [](int i) -> std::optional<int> { return i; },
          [&order, ai](int a, int j) -> std::optional<int> {
            if (a != ai) return j;
            const auto it = std::find(order.begin(), order.end(), j);
            return it == order.end() ? -1 : static_cast<int>(it - order.begin());
          });
      with_animators(d, r.layer, [&](std::vector<Json> list) {
        for (std::size_t i = 0; i < list.size(); ++i) {
          if (static_cast<int>(i) != ai) continue;
          list[i].set("selectors", Json::array(move_item(arr_of(list[i].at("selectors")), r.index, to)));
        }
        return list;
      });
      break;
    }
    case GK::style: fail(ErrorCode::unsupported, "layer styles have a fixed order");
    case GK::rig: move_rig_group(d, *r.rig, to); break;
    case GK::control: fail(ErrorCode::unsupported, "expression controls keep the order they were added in");
    case GK::plugin: fail(ErrorCode::unsupported, "plugin panels have no order");
  }
  return {};
}

ResultOf<api::DuplicatePropertyGroups> handle(const api::DuplicatePropertyGroups& c, HCtx& x) {
  Document& d = x.d;
  if (c.groups.empty()) fail(ErrorCode::invalid_argument, "no groups given");
  std::vector<GroupRef> refs;
  for (const auto& g : c.groups) refs.push_back(resolve_group(d, g));
  for (const auto& r : refs) {
    if (r.kind == GK::style) fail(ErrorCode::unsupported, "a layer has at most one style of each kind");
  }
  for (const auto& r : refs) {
    if (r.kind == GK::rig) fail(ErrorCode::unsupported, "rig groups are duplicated by adding a new pin / bone in this engine");
  }
  for (const auto& r : refs) {
    if (r.kind == GK::plugin) fail(ErrorCode::unsupported, "a layer has at most one of each plugin panel");
  }
  for (const auto& r : refs) {
    if (r.kind == GK::control) fail(ErrorCode::unsupported, "expression controls are added by name with addPropertyGroup");
  }
  std::vector<std::string> newIds;
  for (const auto& r : refs) newIds.push_back(mint_for(x, r, r.layer));
  x.label = "Duplicate " + plural(refs.size(), "Group");
  api::GroupList out;
  for (std::size_t i = 0; i < refs.size(); ++i) out.groups.push_back(copy_group(x, refs[i], refs[i].layer, newIds[i], true));
  return out;
}

ResultOf<api::SetGroupEnabled> handle(const api::SetGroupEnabled& c, HCtx& x) {
  Document& d = x.d;
  if (c.groups.empty()) fail(ErrorCode::invalid_argument, "no groups given");
  std::vector<GroupRef> refs;
  for (const auto& g : c.groups) refs.push_back(resolve_group(d, g));
  for (const auto& r : refs) {
    if (r.kind == GK::plugin) {
      fail(ErrorCode::unsupported, "a plugin panel has no enable switch (the plugin itself is enabled in the Plugins panel)");
    }
  }
  for (const auto& r : refs) {
    if (r.kind == GK::control) fail(ErrorCode::unsupported, "an expression control has no enable switch");
  }
  x.label = c.enabled ? "Enable" : "Disable";
  for (const auto& r : refs) set_enabled(d, r, c.enabled);
  return {};
}

ResultOf<api::RenamePropertyGroup> handle(const api::RenamePropertyGroup& c, HCtx& x) {
  Document& d = x.d;
  const GroupRef r = resolve_group(d, c.group);
  if (r.kind == GK::style || r.kind == GK::pathop) {
    fail(ErrorCode::unsupported, "'" + group_path(r) + "' cannot be renamed in this engine");
  }
  if (r.kind == GK::plugin) fail(ErrorCode::unsupported, "'" + group_path(r) + "' cannot be renamed");
  if (r.kind == GK::rig && r.rig->kind != "pin" && r.rig->kind != "bone" && r.rig->kind != "controller") {
    fail(ErrorCode::unsupported, "'" + group_path(r) + "' cannot be renamed");
  }
  // An expression control's name is its `ctrl('<name>')` key and its path id: the path follows the name.
  if (r.kind == GK::control) {
    const std::string name = valid_control_name(c.name);
    if (name != r.control->name) require_free_control_name(*d.node(r.layer), *r.control->spec, name);
    x.label = "Rename Group";
    if (name != r.control->name) rename_control(d, r.layer, *r.control, name);
    return {};
  }
  x.label = "Rename Group";
  if (r.kind == GK::rig) {
    rename_rig_group(d, *r.rig, c.name);
    return {};
  }
  const std::optional<std::string> name = blank_js(c.name) ? std::nullopt : std::optional<std::string>(c.name);
  if (r.kind == GK::effect) {
    std::vector<Json> list = get_node_effects(d, r.layer);
    for (Json& e : list) {
      if (id_is(e, r.id)) e = with_name(e, name);
    }
    write_node_effects(d, r.layer, std::move(list));
  } else if (r.kind == GK::mask) {
    write_masks(d, r.layer, [&](std::vector<Json> paths) {
      for (Json& p : paths) {
        if (id_is(p, r.id)) p = with_name(p, name);
      }
      return paths;
    });
  } else if (r.kind == GK::animator) {
    with_animators(d, r.layer, [&](std::vector<Json> list) {
      for (Json& a : list) {
        if (id_is(a, r.id)) a = with_name(a, name);
      }
      return list;
    });
  } else {
    with_animators(d, r.layer, [&](std::vector<Json> list) {
      for (std::size_t i = 0; i < list.size(); ++i) {
        if (static_cast<int>(i) != r.animIndex) continue;
        std::vector<Json> s = arr_of(list[i].at("selectors"));
        for (Json& sel : s) {
          if (id_is(sel, r.id)) sel = with_name(sel, name);
        }
        list[i].set("selectors", Json::array(std::move(s)));
      }
      return list;
    });
  }
  return {};
}

namespace {

struct CapturedEffect {
  Json effect;
  std::vector<std::pair<std::string, std::vector<Key>>> tracks;
};

/// groups.ts `capturedKey`: the fields the animation engine stores (key_from_json), a
/// bezier only when its first four entries are numbers.
Key captured_key(const Json& k) {
  auto key = key_from_json(k);
  if (!key || !std::isfinite(key->t) || !std::isfinite(key->value)) {
    fail(ErrorCode::invalid_argument, "a captured keyframe needs a finite t and value");
  }
  const Json& bz = k.at("bezier");
  bool okBezier = bz.is_array() && bz.arr().size() >= 4;
  for (std::size_t i = 0; okBezier && i < 4; ++i) okBezier = bz.arr()[i].is_finite_number();
  if (!okBezier) key->bezier.reset();
  if (key->label && !std::isfinite(*key->label)) key->label.reset();
  key->id.reset();
  return *key;
}

/// groups.ts `parseCapturedEffects`.
std::vector<CapturedEffect> parse_captured_effects(const std::string& json) {
  const auto v = js::parse(json);
  if (!v) fail(ErrorCode::invalid_argument, "effects: invalid json");
  if (!v->is_array() || v->arr().empty()) fail(ErrorCode::invalid_argument, "effects: a non-empty JSON array of captured effects is required");
  std::vector<CapturedEffect> out;
  for (const Json& it : v->arr()) {
    const Json& e = it.at("effect");
    if (!it.is_object() || !e.is_object() || !e.at("type").is_string() || e.at("type").str().empty()) {
      fail(ErrorCode::invalid_argument, "a captured effect is {effect: {type, …}, tracks: {…}}");
    }
    const Json& tr = it.at("tracks");
    if (!tr.is_undefined() && !tr.is_object()) fail(ErrorCode::invalid_argument, "the tracks of a captured effect is an object of keyframe arrays");
    CapturedEffect c{e, {}};
    if (tr.is_object()) {
      for (const auto& m : tr.obj()) {
        if (!m.value.is_array()) fail(ErrorCode::invalid_argument, "track '" + m.key + "' is not a keyframe array");
        if (m.value.arr().empty()) continue;
        std::vector<Key> keys;
        for (const Json& k : m.value.arr()) keys.push_back(captured_key(k));
        std::stable_sort(keys.begin(), keys.end(), [](const Key& a, const Key& b) { return a.t < b.t; });
        c.tracks.emplace_back(m.key, std::move(keys));
      }
    }
    out.push_back(std::move(c));
  }
  return out;
}

}  // namespace

ResultOf<api::PasteEffects> handle(const api::PasteEffects& c, HCtx& x) {
  Document& d = x.d;
  if (c.layers.empty()) fail(ErrorCode::invalid_argument, "no layers given");
  const std::vector<CapturedEffect> items = parse_captured_effects(c.effects);
  for (const auto& layer : c.layers) {
    (void)require_layer(d, layer);
    const std::size_t count = get_node_effects(d, layer).size();
    if (c.index && *c.index > count) {
      fail(ErrorCode::out_of_range,
           "index " + std::to_string(*c.index) + " is past the " + std::to_string(count) + " effects of '" + layer + "'",
           {.layer = layer});
    }
  }
  std::vector<std::vector<std::string>> ids;
  for (const auto& layer : c.layers) {
    std::vector<std::string> row;
    for (std::size_t i = 0; i < items.size(); ++i) {
      row.push_back(x.mint_group_id("fx_", [&](const std::string& id) { return find_by_id(get_node_effects(d, layer), id) != nullptr; }));
    }
    ids.push_back(std::move(row));
  }
  x.label = "Paste " + plural(items.size(), "Effect");
  api::GroupList out;
  for (std::size_t li = 0; li < c.layers.size(); ++li) {
    const std::string& layer = c.layers[li];
    std::vector<Json> effects = get_node_effects(d, layer);
    std::size_t at = c.index ? *c.index : effects.size();
    for (std::size_t i = 0; i < items.size(); ++i) {
      Json e = items[i].effect;
      e.set("id", str(ids[li][i]));
      insert_at(effects, at++, std::move(e));
    }
    write_node_effects(d, layer, std::move(effects));
    for (std::size_t i = 0; i < items.size(); ++i) {
      const std::string& id = ids[li][i];
      for (const auto& [suffix, keys] : items[i].tracks) {
        const std::string prop = suffix.empty() ? "effect." + id : "effect." + id + "." + suffix;
        std::vector<Key> fresh = keys;
        for (Key& k : fresh) k.id = x.mint_key_id();
        NodeAnim target = snapshot_node(d, layer).value_or(NodeAnim{});
        target.tracks.set(prop, std::move(fresh));
        restore_node(d, layer, std::move(target));
      }
      out.groups.push_back("effects/" + id);
    }
  }
  return out;
}

ResultOf<api::CopyPropertyGroups> handle(const api::CopyPropertyGroups& c, HCtx& x) {
  Document& d = x.d;
  if (c.groups.empty() || c.to_layers.empty()) fail(ErrorCode::invalid_argument, "groups and target layers are required");
  std::vector<GroupRef> refs;
  for (const auto& g : c.groups) refs.push_back(resolve_group(d, g));
  for (const auto& r : refs) {
    if (r.kind == GK::animator || r.kind == GK::selector) {
      fail(ErrorCode::unsupported, "text animators are copied with their layer in this engine");
    }
  }
  for (const auto& r : refs) {
    if (r.kind == GK::rig) fail(ErrorCode::unsupported, "a rig is copied whole through layer/puppet or layer/skeleton in this engine");
  }
  for (const auto& r : refs) {
    if (r.kind == GK::plugin) fail(ErrorCode::unsupported, "plugin panels are added to a layer with addPropertyGroup");
  }
  for (const auto& r : refs) {
    if (r.kind == GK::control) fail(ErrorCode::unsupported, "expression controls are added by name with addPropertyGroup");
  }
  for (const auto& l : c.to_layers) (void)require_layer(d, l);
  struct Plan {
    const GroupRef* r;
    std::string to;
    std::string newId;
  };
  std::vector<Plan> plans;
  for (const auto& to : c.to_layers) {
    for (const auto& r : refs) {
      if (r.kind == GK::style && style_present(d, to, r.id)) {
        fail(ErrorCode::conflict, "layer '" + to + "' already has a " + r.id + " style", {.layer = to});
      }
      plans.push_back(Plan{&r, to, mint_for(x, r, to)});
    }
  }
  x.label = "Paste " + plural(plans.size(), "Group");
  api::GroupList out;
  for (const auto& p : plans) out.groups.push_back(copy_group(x, *p.r, p.to, p.newId, false));
  return out;
}

ResultOf<api::ApplyPreset> handle(const api::ApplyPreset& c, HCtx& x) {
  Document& d = x.d;
  if (c.layers.empty()) fail(ErrorCode::invalid_argument, "no layers given");
  const Json* preset = nullptr;
  for (const Json& p : registry().presets.arr()) {
    if ((p.at("name").is_string() && p.at("name").str() == c.preset) ||
        (p.at("id").is_string() && p.at("id").str() == c.preset)) {
      preset = &p;
      break;
    }
  }
  if (preset == nullptr) fail(ErrorCode::not_found, "no preset '" + c.preset + "'");
  for (const auto& l : c.layers) (void)require_layer(d, l);
  const std::string name = preset->at("name").str();
  x.label = "Apply " + name;
  const double atTime = static_cast<double>(c.time) / static_cast<double>(kFlicksPerSecond);
  api::GroupList out;
  for (const auto& layer : c.layers) {
    const std::vector<std::string> beforeFxList = ids_of(get_node_effects(d, layer));
    const std::set<std::string> beforeFx(beforeFxList.begin(), beforeFxList.end());
    std::set<std::string> beforeAnim;
    bool beforeAnimUndefined = false;
    for (const Json& a : read_animator_data(*d.node(layer))) {
      if (a.at("id").is_string()) beforeAnim.insert(a.at("id").str());
      else beforeAnimUndefined = true;
    }
    // `time` is composition time; the preset's keys go on the layer's keyframe
    // axis (start offset, stretch, remap) — groups.ts applyPreset.
    const double layerTime = comp_to_keyframe_time(d, x.view, layer, atTime);
    if (!apply_preset(x, *preset, layer, layerTime)) {
      fail(ErrorCode::invalid_argument, "preset '" + name + "' does not apply to layer '" + layer + "'", {.layer = layer});
    }
    // The preset code mints clock-based ids; replace them with engine ids so replay is exact.
    for (const Json& e : get_node_effects(d, layer)) {
      const std::string eid = e.at("id").is_string() ? e.at("id").str() : std::string();
      if (beforeFx.contains(eid)) continue;
      const std::string id =
          x.mint_group_id("fx_", [&](const std::string& v) { return find_by_id(get_node_effects(d, layer), v) != nullptr; });
      move_group_tracks(d, layer, "effect." + eid, "effect." + id);
      std::vector<Json> list = get_node_effects(d, layer);
      for (Json& y : list) {
        if (id_is(y, eid)) y.set("id", str(id));
      }
      write_node_effects(d, layer, std::move(list));
      out.groups.push_back("effects/" + id);
    }
    with_animators(d, layer, [&](std::vector<Json> list) {
      for (Json& a : list) {
        const Json& aid = a.at("id");
        if (aid.is_string() ? beforeAnim.contains(aid.str()) : beforeAnimUndefined) continue;
        const std::string id = x.mint_group_id("anim_", [](const std::string&) { return false; });
        out.groups.push_back("text/animators/" + id);
        a.set("id", str(id));
        Json sels = Json::array();
        for (const Json& s : arr_of(a.at("selectors"))) {
          Json cs = s;
          cs.set("id", str(x.mint_group_id("sel_", [](const std::string&) { return false; })));
          sels.arr_mut().push_back(std::move(cs));
        }
        a.set("selectors", std::move(sels));
      }
      return list;
    });
  }
  return out;
}

ResultOf<api::InvokeEffectAction> handle(const api::InvokeEffectAction& c, HCtx& x) {
  (void)resolve_group(x.d, c.group);
  // G1: native SDK plugin effects (buttons, supervised params) — handlers_native.cpp.
  native_invoke_action(x, c.group, c.action);
  return {};
}

}  // namespace premation::doc
