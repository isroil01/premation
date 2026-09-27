#include "queries.hpp"

#include <algorithm>
#include <array>
#include <unordered_map>
#include <cmath>
#include <set>
#include <string>
#include <tuple>
#include <utility>

#include "anim_json.hpp"
#include "catalog_data.hpp"
#include "controls.hpp"
#include "docexpr.hpp"
#include "docio.hpp"
#include "fail.hpp"
#include "fxstate.hpp"
#include "handlers_common.hpp"
#include "handlers_layers.hpp"
#include "handlers_native.hpp"
#include "layer_geometry.hpp"
#include "native_effects.hpp"
#include "presets_capture.hpp"
#include "readmodel.hpp"
#include "rig.hpp"
#include "scene.hpp"
#include "scene/session_hooks.hpp"
#include "strutil.hpp"
#include "time_conv.hpp"
#include "variant_util.hpp"
#include "worldxf.hpp"

namespace premation::doc {
namespace {

using api::ErrorCode;

api::ValueType param_value_type(const std::string& t) {
  if (t == "number") return api::ValueType::scalar;
  if (t == "color") return api::ValueType::color;
  if (t == "checkbox") return api::ValueType::bool_;
  if (t == "enum") return api::ValueType::choice;
  if (t == "layer") return api::ValueType::layer;
  if (t == "maskPath") return api::ValueType::string;
  return api::ValueType::json;
}

std::string lower(std::string s) {
  for (char& c : s) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return s;
}

std::vector<double> nums_of(const api::Value& v) { return numbers_loose(v); }

/// `^${parent.replace(/\*/g, '[^/]+')}$` against `path`.
bool pattern_match(std::string_view pattern, std::string_view path) {
  const std::vector<std::string> p = split(pattern, '/');
  const std::vector<std::string> s = split(path, '/');
  if (p.size() != s.size()) return false;
  for (std::size_t i = 0; i < p.size(); ++i) {
    if (p[i] == "*") {
      if (s[i].empty()) return false;
      continue;
    }
    if (p[i] != s[i]) return false;
  }
  return true;
}

struct GroupType {
  std::string parent;
  std::string matchName;
  std::string displayName;
  std::string category;
};

std::vector<GroupType> group_types() {
  std::vector<GroupType> out = {
      {"text/animators", "ADBE Text Animator", "Animator", "text"},
      {"text/animators/*/selectors", "ADBE Text Selector", "Range Selector", "text"},
      {"text/animators/*/selectors", "ADBE Text Wiggly Selector", "Wiggly Selector", "text"},
      {"text/animators/*/selectors", "ADBE Text Expressible Selector", "Expression Selector", "text"},
  };
  for (const auto& m : registry().layerStyles.at("defaults").obj()) {
    out.push_back({"styles", "style:" + m.key, m.key, "styles"});
  }
  for (const auto& t : rig_group_types()) out.push_back({t.parent, t.matchName, t.displayName, "rig"});
  for (const ControlSpec& s : control_specs()) out.push_back({"effects", s.matchName, s.label, "controls"});
  for (const char* t : {"zigzag", "roundCorners", "pucker", "twist", "offset", "roughen", "trim", "repeater", "wiggleTransform"}) {
    out.push_back({"contents", std::string("pathop:") + t, t, "contents"});
  }
  return out;
}

/// getWaveform's source: the media file a layer or an item sounds from.
struct SoundSource {
  std::string src;       // '' = no sound (answered as channels = 0)
  bool silent = false;   // the asset says it has no audio track
};

std::string str_prop(const Json& props, std::string_view key) {
  const Json& v = props.at(key);
  return v.is_string() ? v.str() : std::string();
}

/// A footage / audio asset's sound (its `src`; an image or a video without an
/// audio track has none).
SoundSource asset_sound(const Json& asset) {
  SoundSource s;
  s.src = str_prop(asset, "src");
  const std::string type = str_prop(asset, "type");
  const Json& md = asset.at("metadata");
  const bool noTrack = md.at("hasAudioTrack").is_bool() && !md.at("hasAudioTrack").b();
  if (type == "image" || (type != "audio" && noTrack)) s.silent = true;
  return s;
}

/// The source a layer's sound comes from, resolved as the audio program's
/// voice builder does (engine_frames.cpp audio_voices / video_voices): an
/// audio layer's Audio component (`__assetId` → the asset's src, else `__src`),
/// a footage layer's asset. Any other layer has no sound of its own.
SoundSource layer_sound(const Document& d, const std::string& layer) {
  const Node& n = require_layer(d, layer);
  const std::string kind = n.kind();
  if (kind == "audio") {
    const Component* a = n.comp("Audio");
    if (a == nullptr) return {};
    SoundSource s;
    s.src = str_prop(a->props, "__src");
    const std::string assetId = str_prop(a->props, "__assetId");
    if (!assetId.empty()) {
      if (const Json* asset = find_asset(d, assetId); asset != nullptr && !str_prop(*asset, "src").empty()) {
        s.src = str_prop(*asset, "src");
      }
    }
    return s;
  }
  if (kind == "video") {
    std::string assetId;
    std::string rawSrc;
    for (const Component& comp : n.components) {
      if (!str_prop(comp.props, "assetId").empty()) assetId = str_prop(comp.props, "assetId");
      if (!str_prop(comp.props, "__assetId").empty()) assetId = str_prop(comp.props, "__assetId");
      if (!str_prop(comp.props, "src").empty()) rawSrc = str_prop(comp.props, "src");
    }
    const Json* asset = assetId.empty() ? nullptr : find_asset(d, assetId);
    if (asset == nullptr) return SoundSource{rawSrc, false};
    SoundSource s = asset_sound(*asset);
    if (s.src.empty()) s.src = rawSrc;
    return s;
  }
  fail(ErrorCode::invalid_argument, "layer '" + layer + "' has no sound of its own (an audio or footage layer)", {.layer = layer});
}

/// hitTest: every id the frame of `comp` can name → the layer of `comp` it
/// belongs to. A layer names itself; a collapsed precomp's children draw in
/// `comp`'s frame under their own ids, which belong to the precomp layer
/// (through any depth of collapsed nesting).
std::unordered_map<std::string, std::string> hit_owners(const Document& d, const std::string& comp) {
  constexpr std::size_t kMaxDepth = 16;
  std::unordered_map<std::string, std::string> owner;
  struct Pending {
    std::string comp;
    std::string outer;  // the layer of `comp` everything under here belongs to
    std::size_t depth;
  };
  std::vector<Pending> todo;
  std::set<std::string> seen;  // a comp nested twice maps to the first owner (emplace keeps it)
  for (const std::string& id : layer_ids_of_comp(d, comp)) {
    owner.emplace(id, id);
    if (const Node* n = d.node(id)) {
      if (auto ref = read_comp_ref(*n)) todo.push_back({std::move(*ref), id, 1});
    }
  }
  while (!todo.empty()) {
    Pending p = std::move(todo.back());
    todo.pop_back();
    if (p.depth > kMaxDepth || p.comp == comp || !seen.insert(p.comp + "|" + p.outer).second) continue;
    for (const std::string& id : layer_ids_of_comp(d, p.comp)) {
      owner.emplace(id, p.outer);
      if (const Node* n = d.node(id)) {
        if (auto ref = read_comp_ref(*n)) todo.push_back({std::move(*ref), p.outer, p.depth + 1});
      }
    }
  }
  return owner;
}

/// getThumbnail: the default and the largest long side.
constexpr std::uint32_t kDefaultThumbnail = 256;
constexpr std::uint32_t kMaxThumbnail = 4096;

/// A still of srcW × srcH with its long side at most `maxSize` (never enlarged).
std::pair<std::uint32_t, std::uint32_t> fit_still(double srcW, double srcH, std::uint32_t maxSize) {
  const double s = std::min(1.0, static_cast<double>(maxSize) / std::max(srcW, srcH));
  const auto side = [&](double v) { return static_cast<std::uint32_t>(std::clamp(std::round(v * s), 1.0, static_cast<double>(maxSize))); };
  return {side(srcW), side(srcH)};
}

/// readPixels reads at most this many pixels (a 256 × 256 region).
constexpr std::uint64_t kMaxReadPixels = 256ULL * 256ULL;

/// A still's or a pixel read's hook answer that is not `ready` → the error.
[[noreturn]] void fail_hook(HookAnswer a, const std::string& error, std::string_view what) {
  switch (a) {
    case HookAnswer::unsupported:
      fail(ErrorCode::unsupported, error.empty() ? std::string(what) + " needs the engine's renderer" : error);
    case HookAnswer::pending:
      fail(ErrorCode::busy, error.empty() ? std::string(what) + ": not ready yet, ask again" : error);
    case HookAnswer::ready:
    case HookAnswer::failed:
      break;
  }
  fail(ErrorCode::internal, error.empty() ? std::string(what) + " failed" : error);
}

/// getWaveform buckets: enough for a clip bar across an 8K-wide timeline.
constexpr std::uint32_t kMaxWaveformBuckets = 1U << 16U;

}  // namespace

api::EffectInfo effect_info(const EffectDef& def) {
  api::EffectInfo e;
  e.match_name = def.type;
  e.display_name = def.label;
  e.category = "";
  e.gpu = def.gpuOnly;
  const std::size_t dot = def.type.find('.');
  e.provider = dot != std::string::npos ? def.type.substr(0, dot) : "builtin";
  for (const EffectParamDef& p : def.params) {
    if (p.type == "resolved") continue;
    api::EffectParamInfo pi;
    pi.name = p.label;
    pi.match_name = p.key;
    pi.value_type = param_value_type(p.type);
    pi.animatable = p.type == "number" || p.type == "color";
    if (p.def.is_number()) pi.default_value = v_scalar(p.def.num());
    pi.min_ = p.min;
    pi.max_ = p.max;
    for (const auto& o : p.options) pi.choices.push_back(o.label);
    pi.unit = p.unit.value_or("");
    pi.group = p.group.value_or("");
    e.params.push_back(std::move(pi));
  }
  e.supports_float = false;
  e.audio = false;
  return e;
}

namespace {

/// The overridden keys of a Source Text result's style, by their TypeScript
/// names in `SourceTextStyleOverrides` declaration order
/// (src/core/engine/sourceTextPreview.ts SOURCE_TEXT_STYLE_KEYS).
std::vector<std::string> source_text_style_keys(const motion::expr::SourceTextStyleOverrides& s) {
  std::vector<std::string> out;
  const auto add = [&out](bool present, const char* name) {
    if (present) out.emplace_back(name);
  };
  add(s.font_family.has_value(), "fontFamily");
  add(s.font_size.has_value(), "fontSize");
  add(s.font_weight.has_value(), "fontWeight");
  add(s.font_style.has_value(), "fontStyle");
  add(s.fill.has_value(), "fill");
  add(s.apply_fill.has_value(), "applyFill");
  add(s.stroke.has_value(), "stroke");
  add(s.stroke_width.has_value(), "strokeWidth");
  add(s.apply_stroke.has_value(), "applyStroke");
  add(s.tracking.has_value(), "tracking");
  add(s.leading.has_value(), "leading");
  add(s.baseline_shift.has_value(), "baselineShift");
  add(s.horizontal_scale.has_value(), "horizontalScale");
  add(s.vertical_scale.has_value(), "verticalScale");
  add(s.text_transform.has_value(), "textTransform");
  add(s.font_variant.has_value(), "fontVariant");
  add(s.align.has_value(), "align");
  add(s.first_line_indent.has_value(), "firstLineIndent");
  add(s.left_indent.has_value(), "leftIndent");
  add(s.right_indent.has_value(), "rightIndent");
  add(s.space_before.has_value(), "spaceBefore");
  add(s.space_after.has_value(), "spaceAfter");
  add(s.direction.has_value(), "direction");
  add(s.leading_type.has_value(), "leadingType");
  return out;
}

/// evaluateExpression's answer for a draft Source Text expression (SourceTextPreview).
api::SourceTextPreview source_text_preview(const motion::expr::SourceTextResult& r) {
  api::SourceTextPreview p;
  p.text = to_u8(r.text);
  p.style_keys = source_text_style_keys(r.style);
  p.ranges = static_cast<std::uint32_t>(r.ranges.size());
  for (const auto& range : r.ranges) {
    for (auto& k : source_text_style_keys(range.style)) {
      if (std::find(p.range_keys.begin(), p.range_keys.end(), k) == p.range_keys.end()) p.range_keys.push_back(std::move(k));
    }
  }
  return p;
}

struct Q {
  QCtx& c;
  const PCtx& pc;
  Document& d;

  template <class T>
  api::QueryResult operator()(const T&) const {
    fail(ErrorCode::unsupported, "unknown query");
  }

  api::QueryResult operator()(const api::GetDocument& q) const {
    return query_result_for<api::GetDocument>(
        document_snapshot(pc, c.revision, c.projectPath, c.dirty, q.include_properties, q.include_keyframes));
  }
  api::QueryResult operator()(const api::ExportDocument& /*q*/) const {
    const std::string text = stringify(capture_document(d));
    return query_result_for<api::ExportDocument>(api::ExportedDocument{std::vector<std::uint8_t>(text.begin(), text.end())});
  }
  api::QueryResult operator()(const api::GetComposition& q) const {
    require_comp(d, q.comp);
    api::CompositionDetails det;
    det.comp = comp_info(d, q.comp);
    for (const auto& id : layer_ids_of_comp(d, q.comp)) det.layers.push_back(layer_info(d, id));
    return query_result_for<api::GetComposition>(std::move(det));
  }
  api::QueryResult operator()(const api::GetLayers& q) const {
    for (const auto& id : q.layers) (void)require_layer(d, id);
    api::LayerDetails det;
    for (const auto& id : q.layers) det.layers.push_back(layer_info(d, id));
    return query_result_for<api::GetLayers>(std::move(det));
  }
  api::QueryResult operator()(const api::GetPropertyTree& q) const {
    (void)require_layer(d, q.layer);
    const Catalog cat = catalog_for(d, q.layer);
    if (!q.path.empty() && !cat.groups.contains(q.path) && cat.find(q.path) == nullptr) {
      fail(ErrorCode::not_found, "no property '" + q.path + "'", {.layer = q.layer, .path = q.path});
    }
    std::vector<api::PropertyInfo> nodes = property_tree(pc, q.layer, cat, q.path, q.depth);
    if (q.time) {
      for (auto& n : nodes) {
        const PropBinding* b = cat.find(n.path);
        if (b != nullptr && n.animated) {
          if (auto v = value_at(pc, q.layer, *b, flicks_to_key_time(pc, q.layer, *b, *q.time))) n.value = std::move(*v);
        }
      }
    }
    return query_result_for<api::GetPropertyTree>(api::PropertyTree{q.layer, std::move(nodes)});
  }
  api::QueryResult operator()(const api::GetPropertyValues& q) const {
    api::PropertyValues out;
    out.values.reserve(q.props.size());
    for (const auto& p : q.props) {
      // One catalog per LAYER (a layer's five transform properties asked
      // together built its whole property tree five times), kept until the
      // next command.
      const Catalog& cat = query_catalog(c, p.layer);
      const PropBinding& b = require_binding(cat, p.path);
      const double t = flicks_to_key_time(pc, p.layer, b, q.time);
      api::Value value = is_animated(d, p.layer, b) ? value_at(pc, p.layer, b, t).value_or(read_static(d, p.layer, b))
                                                    : read_static(d, p.layer, b);
      if (q.evaluated && !b.members.empty() &&
          std::any_of(b.members.begin(), b.members.end(), [&](const std::string& m) { return anim_expr_enabled(d, p.layer, m); })) {
        std::vector<double> raw;
        for (const auto& m : b.members) raw.push_back(anim_sample(d, pc.expr, pc.cache, p.layer, m, t).value_or(0));
        const std::vector<double> n = to_api_nums(b, raw);
        if (b.valueType == api::ValueType::scalar) value = v_scalar(n[0]);
        else if (value.kind() == VK::vec2) value = v_vec2(n[0], n.size() > 1 ? n[1] : 0);
        else if (value.kind() == VK::vec3) value = v_vec3(n[0], n.size() > 1 ? n[1] : 0, n.size() > 2 ? n[2] : 0);
      }
      out.values.push_back(api::PropertyValue{p, std::move(value)});
    }
    return query_result_for<api::GetPropertyValues>(std::move(out));
  }
  api::QueryResult operator()(const api::SampleProperty& q) const {
    (void)require_layer(d, q.prop.layer);
    const Catalog cat = catalog_for(d, q.prop.layer);
    const PropBinding& b = require_binding(cat, q.prop.path);
    if (b.members.empty()) fail(ErrorCode::unsupported, "'" + b.path + "' is not numeric", {.path = b.path});
    if (q.samples < 2 || q.samples > 100000) fail(ErrorCode::out_of_range, "samples must be 2…100000");
    api::PropertySamples s;
    s.dimensions = static_cast<std::uint32_t>(b.members.size());
    for (std::uint32_t i = 0; i < q.samples; ++i) {
      const double step = motion::js::round(static_cast<double>(q.range.duration) * i / (q.samples - 1));
      const api::Time tf = q.range.start + static_cast<api::Time>(step);
      const double t = flicks_to_key_time(pc, q.prop.layer, b, tf);
      const std::vector<double> stat = nums_of(read_static(d, q.prop.layer, b));
      std::vector<double> nums;
      for (std::size_t m = 0; m < b.members.size(); ++m) {
        const auto sv = anim_sample(d, pc.expr, pc.cache, q.prop.layer, b.members[m], t);
        nums.push_back(sv ? *sv * (b.colorBase ? 1.0 : api_unit_factor(b.members[m])) : (m < stat.size() ? stat[m] : 0.0));
      }
      s.times.push_back(static_cast<double>(tf));
      s.values.insert(s.values.end(), nums.begin(), nums.end());
      if (q.speed) {
        const double dt = 1.0 / 240;
        std::vector<double> raw;
        for (const auto& m : b.members) raw.push_back(anim_sample(d, pc.expr, pc.cache, q.prop.layer, m, t + dt).value_or(0));
        const std::vector<double> n2 = to_api_nums(b, raw);
        // Math.hypot(...d) — V8's scaled hypot, not sqrt(Σd²) (they part in the last bit).
        std::vector<double> diff;
        for (std::size_t j = 0; j < n2.size(); ++j) diff.push_back(n2[j] - nums[j]);
        s.speeds.push_back(motion::js::hypot(diff) / dt);
      }
    }
    return query_result_for<api::SampleProperty>(std::move(s));
  }
  api::QueryResult operator()(const api::GetMotionPath& q) const {
    (void)require_layer(d, q.layer);
    if (q.samples < 2 || q.samples > 100000) fail(ErrorCode::out_of_range, "samples must be 2…100000");
    api::PropertySamples s;
    s.dimensions = 2;
    for (std::uint32_t i = 0; i < q.samples; ++i) {
      const double step = motion::js::round(static_cast<double>(q.range.duration) * i / (q.samples - 1));
      const api::Time tf = q.range.start + static_cast<api::Time>(step);
      const auto m = world_2d_at(pc, q.layer, flicks_to_seconds(tf));
      s.times.push_back(static_cast<double>(tf));
      s.values.push_back(m.e);
      s.values.push_back(m.f);
    }
    return query_result_for<api::GetMotionPath>(std::move(s));
  }
  api::QueryResult operator()(const api::GetKeyframes& q) const {
    api::KeyframeSets out;
    for (const auto& p : q.props) {
      (void)require_layer(d, p.layer);
      const Catalog cat = catalog_for(d, p.layer);
      const PropBinding& b = require_binding(cat, p.path);
      api::KeyframeSet set;
      set.prop = p;
      for (const KeyAt& k : read_keys(d, p.layer, b)) {
        api::Keyframe kf = key_at_to_api(pc, p.layer, b, k);
        if (q.range && !(kf.time >= q.range->start && kf.time < q.range->start + q.range->duration)) continue;
        set.keyframes.push_back(std::move(kf));
      }
      out.sets.push_back(std::move(set));
    }
    return query_result_for<api::GetKeyframes>(std::move(out));
  }
  api::QueryResult operator()(const api::CopyKeyframes& q) const {
    // B4: whole keys in API form, per property, in the order the ids first name them (queries.ts).
    std::unordered_map<std::string, std::vector<api::KeyframeSet>> layerSets;
    std::vector<api::KeyframeSet> picked;
    std::vector<std::set<std::string>> pickedIds;
    for (const std::string& id : q.keys) {
      const auto loc = c.keys.resolve(d, id);
      if (!loc || d.node(loc->layer) == nullptr) continue;
      auto it = layerSets.find(loc->layer);
      if (it == layerSets.end()) it = layerSets.emplace(loc->layer, keyframe_sets(pc, loc->layer, query_catalog(c, loc->layer))).first;
      for (const api::KeyframeSet& set : it->second) {
        const auto k = std::find_if(set.keyframes.begin(), set.keyframes.end(), [&](const api::Keyframe& x) { return x.id == id; });
        if (k == set.keyframes.end()) continue;
        auto at = std::find_if(picked.begin(), picked.end(), [&](const api::KeyframeSet& e) { return e.prop == set.prop; });
        if (at == picked.end()) {
          picked.push_back(api::KeyframeSet{set.prop, {}});
          pickedIds.emplace_back();
          at = picked.end() - 1;
        }
        auto& seen = pickedIds[static_cast<std::size_t>(at - picked.begin())];
        if (seen.insert(k->id).second) at->keyframes.push_back(*k);
        break;
      }
    }
    for (api::KeyframeSet& s : picked) {
      std::stable_sort(s.keyframes.begin(), s.keyframes.end(), [](const api::Keyframe& a, const api::Keyframe& b) { return a.time < b.time; });
    }
    api::KeyframeSets out;
    out.sets = std::move(picked);
    return query_result_for<api::CopyKeyframes>(std::move(out));
  }
  api::QueryResult operator()(const api::GetMemberKeyframes& q) const {
    // B4: AnimationEngine.animatedProps (keyed tracks, then expression-only), keys as stored (memberKeysQuery.ts).
    (void)require_layer(d, q.layer);
    const std::set<std::string> wanted(q.members.begin(), q.members.end());
    const Catalog& cat = query_catalog(c, q.layer);
    api::MemberTracks out;
    const NodeAnim* anim = d.anim(q.layer);
    if (anim == nullptr) return query_result_for<api::GetMemberKeyframes>(std::move(out));
    std::vector<std::string> members;
    for (const auto& [prop, keys] : anim->tracks) members.push_back(prop);
    for (const auto& [prop, st] : anim->exprs) {
      if (std::find(members.begin(), members.end(), prop) == members.end()) members.push_back(prop);
    }
    for (const std::string& member : members) {
      if (!wanted.empty() && !wanted.contains(member)) continue;
      api::MemberTrack t;
      t.member = member;
      if (const PropBinding* b = cat.by_member(member)) {
        t.path = b->path;
        const auto at = std::find(b->members.begin(), b->members.end(), member);
        t.index = static_cast<std::uint32_t>(at == b->members.end() ? 0 : at - b->members.begin());
      }
      Json list = Json::array();
      if (const std::vector<Key>* keys = anim->tracks.find(member)) {
        for (const Key& k : *keys) list.arr_mut().push_back(key_to_json(k));
        t.count = static_cast<std::uint32_t>(keys->size());
      }
      t.keyframes = stringify(list);
      t.has_expression = anim->exprs.contains(member);
      out.tracks.push_back(std::move(t));
    }
    return query_result_for<api::GetMemberKeyframes>(std::move(out));
  }
  api::QueryResult operator()(const api::CopyEffects& q) const {
    // B4: effectClipboard.ts captureEffect per picked effect, in stack order (queries.ts).
    (void)require_layer(d, q.layer);
    std::set<std::string> wanted;
    for (const std::string& p : q.effects) {
      const auto seg = split(p, '/');
      if (seg.size() == 2 && seg[0] == "effects" && !seg[1].empty()) wanted.insert(seg[1]);
    }
    const NodeAnim* anim = d.anim(q.layer);
    Json captures = Json::array();
    api::CopiedEffects out;
    for (const Json& e : get_node_effects(d, q.layer)) {
      const std::string id = e.at("id").is_string() ? e.at("id").str() : std::string{};
      if (!q.effects.empty() && !wanted.contains(id)) continue;
      const std::string prefix = "effect." + id + ".";
      Json tracks = Json::object();
      if (anim != nullptr) {
        for (const auto& [prop, keys] : anim->tracks) {
          if (!prop.starts_with(prefix) || keys.empty()) continue;
          Json list = Json::array();
          for (const Key& k : keys) list.arr_mut().push_back(key_to_json(k));
          tracks.set(prop.substr(prefix.size()), std::move(list));
        }
        // The legacy single-scalar track is `effect.<id>` with no param suffix.
        if (const std::vector<Key>* legacy = anim->tracks.find("effect." + id); legacy != nullptr && !legacy->empty()) {
          Json list = Json::array();
          for (const Key& k : *legacy) list.arr_mut().push_back(key_to_json(k));
          tracks.set("", std::move(list));
        }
      }
      Json cap = Json::object();
      cap.set("effect", e);
      cap.set("tracks", std::move(tracks));
      captures.arr_mut().push_back(std::move(cap));
      out.paths.push_back("effects/" + id);
    }
    out.effects = stringify(captures);
    return query_result_for<api::CopyEffects>(std::move(out));
  }
  api::QueryResult operator()(const api::GetSvgDocument& q) const {
    // B4: the `svg` component as stored (queries.ts / svgLayer.ts readSvgLayer).
    const Node& n = require_layer(d, q.layer);
    api::SvgDocument out;
    out.role = svg_role_of(n);
    out.capabilities = "{}";
    const Component* svgc = n.comp("svg");
    if (out.role == api::SvgRole::none || svgc == nullptr) return query_result_for<api::GetSvgDocument>(std::move(out));
    const Json& p = svgc->props;
    const auto str = [&p](std::string_view k) { return p.at(k).is_string() ? p.at(k).str() : std::string{}; };
    const auto num = [&p](std::string_view k, double dflt) { return p.at(k).is_finite_number() ? p.at(k).num() : dflt; };
    out.file_name = str("fileName").empty() ? std::string("untitled.svg") : str("fileName");
    out.intrinsic_width = num("intrinsicWidth", 512);
    out.intrinsic_height = num("intrinsicHeight", 512);
    const Json& vb = p.at("viewBox");
    if (vb.is_array() && vb.arr().size() == 4 &&
        std::all_of(vb.arr().begin(), vb.arr().end(), [](const Json& v) { return v.is_number(); })) {
      out.view_box = api::Rect{vb.arr()[0].num(), vb.arr()[1].num(), vb.arr()[2].num(), vb.arr()[3].num()};
    }
    out.capabilities = p.at("capabilities").is_object() ? stringify(p.at("capabilities")) : "{}";
    out.live_playback = p.at("livePlayback").is_bool() && p.at("livePlayback").b();
    out.sanitized_markup = str("sanitizedMarkup");
    out.source_markup = str("sourceMarkup").empty() ? out.sanitized_markup : str("sourceMarkup");
    out.sanitize_policy = static_cast<std::uint32_t>(std::max(0.0, std::round(num("sanitizePolicy", 0))));
    return query_result_for<api::GetSvgDocument>(std::move(out));
  }
  api::QueryResult operator()(const api::GetCryptomatte& q) const {
    if (!resolve_item(d, q.item)) fail(ErrorCode::not_found, "no item '" + q.item + "'", {.item = q.item});
    fail(ErrorCode::unsupported, "EXR Cryptomatte manifests are read by the editor's EXR decoder until media decode in the engine reads EXR");
  }
  api::QueryResult operator()(const api::GetMarkers& q) const {
    require_comp(d, q.owner.comp);
    std::vector<api::Marker> markers;
    if (q.owner.layer) {
      (void)require_layer(d, *q.owner.layer);
      markers = layer_markers(d, *q.owner.layer);
    } else {
      markers = comp_markers(d, q.owner.comp);
    }
    if (q.range) {
      std::erase_if(markers, [&](const api::Marker& m) {
        return !(m.time >= q.range->start && m.time < q.range->start + q.range->duration);
      });
    }
    return query_result_for<api::GetMarkers>(api::MarkerList{std::move(markers)});
  }
  api::QueryResult operator()(const api::CopyLayers& q) const {
    for (const auto& id : q.layers) (void)require_layer(d, id);
    return query_result_for<api::CopyLayers>(encode_fragment(pc, q.layers));
  }
  api::QueryResult operator()(const api::GetWaveform& q) const {
    if (q.layer.has_value() == q.item.has_value()) fail(ErrorCode::invalid_argument, "give a layer or an item");
    if (q.buckets == 0 || q.buckets > kMaxWaveformBuckets) {
      fail(ErrorCode::out_of_range, "buckets must be 1.." + std::to_string(kMaxWaveformBuckets));
    }
    if (q.range.start < 0 || q.range.duration < 0) fail(ErrorCode::out_of_range, "the range must not be negative");
    SoundSource s;
    if (q.layer) {
      s = layer_sound(d, *q.layer);
    } else {
      const Json* asset = find_asset(d, *q.item);
      if (asset == nullptr) {
        if (is_comp_item(d, *q.item)) {
          fail(ErrorCode::invalid_argument, "a composition has no waveform of its own; ask for a layer's", {.item = *q.item});
        }
        fail(ErrorCode::not_found, "no footage item '" + *q.item + "'", {.item = *q.item});
      }
      s = asset_sound(*asset);
    }
    // No sound: an empty answer (no channels), not an error — the bar draws flat.
    if (s.silent || s.src.empty()) return query_result_for<api::GetWaveform>(api::WaveformPeaks{});
    if (!c.waveform) fail(ErrorCode::unsupported, "this engine was built without audio (E2)");
    api::WaveformPeaks out;
    // The range is SOURCE time (the window a clip bar shows, waveform.ts
    // peaksInRange); duration 0 = to the end of the source.
    switch (c.waveform(s.src, flicks_to_seconds(q.range.start), flicks_to_seconds(q.range.duration), q.buckets, out)) {
      case HookAnswer::unsupported:
        fail(ErrorCode::unsupported, "this engine was built without audio (E2)");
      case HookAnswer::pending:
        fail(ErrorCode::busy, "the source is still decoding; ask again", {.detail = s.src});
      case HookAnswer::failed:
        fail(ErrorCode::decode, "the source's peaks could not be read", {.detail = s.src});
      case HookAnswer::ready:
        break;
    }
    return query_result_for<api::GetWaveform>(std::move(out));
  }
  api::QueryResult operator()(const api::ListFonts& q) const {
    // The installed fonts (CoreText / DirectWrite / fontconfig, the process's
    // font catalogue — raster/font_catalog.hpp). The test ports have none, so
    // replays stay deterministic across machines.
    return query_result_for<api::ListFonts>(c.fonts ? c.fonts(q.query) : api::FontList{});
  }
  api::QueryResult operator()(const api::GetItems& q) const {
    api::ItemDetails out;
    for (const auto& id : q.items) {
      auto info = item_info(d, id);
      if (!info) fail(ErrorCode::not_found, "no item '" + id + "'", {.item = id});
      out.items.push_back(std::move(*info));
    }
    return query_result_for<api::GetItems>(std::move(out));
  }
  api::QueryResult operator()(const api::GetThumbnail& q) const {
    if (q.item.has_value() == q.layer.has_value()) fail(ErrorCode::invalid_argument, "give an item or a layer");
    if (q.max_size > kMaxThumbnail) fail(ErrorCode::out_of_range, "maxSize must be at most " + std::to_string(kMaxThumbnail));
    if (q.time < 0) fail(ErrorCode::out_of_range, "the time must not be negative");
    const std::uint32_t maxSize = q.max_size == 0 ? kDefaultThumbnail : q.max_size;
    StillRequest r;
    double w = 0;
    double h = 0;
    if (q.layer) {
      (void)require_layer(d, *q.layer);
      const auto comp = comp_of_layer(d, *q.layer);
      if (!comp) fail(ErrorCode::not_found, "layer '" + *q.layer + "' is in no composition", {.layer = *q.layer});
      r.comp = *comp;
      r.isolateLayer = *q.layer;
      r.time = q.time;
      const api::CompSettings cs = comp_settings(d, *comp);
      w = cs.width;
      h = cs.height;
    } else if (is_comp_item(d, *q.item)) {
      r.comp = *q.item;
      r.time = q.time;
      const api::CompSettings cs = comp_settings(d, *q.item);
      w = cs.width;
      h = cs.height;
    } else if (const Json* asset = find_asset(d, *q.item)) {
      const std::string type = str_prop(*asset, "type");
      if (type == "audio") fail(ErrorCode::invalid_argument, "an audio item has no picture; ask getWaveform", {.item = *q.item});
      r.footageSrc = str_prop(*asset, "src");
      if (r.footageSrc.empty()) fail(ErrorCode::not_found, "the footage is missing", {.item = *q.item});
      r.video = type == "video";
      r.sourceSec = flicks_to_seconds(q.time);  // footage: SOURCE time
      const Json& md = asset->at("metadata");
      w = md.at("width").is_number() ? md.at("width").num() : 0;
      h = md.at("height").is_number() ? md.at("height").num() : 0;
      r.sourceWidth = w;
      r.sourceHeight = h;
    } else if (resolve_item(d, *q.item)) {
      fail(ErrorCode::invalid_argument, "a folder has no thumbnail", {.item = *q.item});
    } else {
      fail(ErrorCode::not_found, "no item '" + *q.item + "'", {.item = *q.item});
    }
    if (!(w >= 1) || !(h >= 1) || !std::isfinite(w) || !std::isfinite(h)) {
      fail(ErrorCode::decode, "the source's size is not known (not probed yet)", {.layer = q.layer, .item = q.item});
    }
    std::tie(r.width, r.height) = fit_still(w, h, maxSize);
    if (!c.still) fail(ErrorCode::unsupported, "getThumbnail needs the engine's renderer; this engine has none");
    StillImage img = c.still(r);
    if (img.answer != HookAnswer::ready) fail_hook(img.answer, img.error, "getThumbnail");
    return query_result_for<api::GetThumbnail>(api::Thumbnail{img.width, img.height, std::move(img.format), std::move(img.data)});
  }
  api::QueryResult operator()(const api::ListEffects& q) const {
    api::EffectCatalog out;
    for (const EffectDef& def : registry().effects) {
      api::EffectInfo e = effect_info(def);
      if (q.category.empty() || e.category == q.category) out.effects.push_back(std::move(e));
    }
    // G1: native SDK plugin effects, provider = the plugin id.
    for (const NativeEffect* ne : NativeEffects::list()) {
      api::EffectInfo e = effect_info(ne->def);
      e.category = ne->category;
      e.provider = ne->provider;
      e.gpu = ne->gpu;
      e.supports_float = ne->supportsFloat;
      if (q.category.empty() || e.category == q.category) out.effects.push_back(std::move(e));
    }
    return query_result_for<api::ListEffects>(std::move(out));
  }
  api::QueryResult operator()(const api::ListGroupTypes& q) const {
    const Node& n = require_layer(d, q.layer);
    const bool isText = n.comp("Text") != nullptr;
    api::GroupTypeList out;
    for (const GroupType& t : group_types()) {
      if (pattern_match(t.parent, q.parent) && (t.category != "text" || isText)) {
        out.types.push_back(api::GroupTypeInfo{t.matchName, t.displayName, t.category});
      }
    }
    if (q.parent == "effects") {
      for (const EffectDef& def : registry().effects) out.types.push_back(api::GroupTypeInfo{def.type, def.label, "effects"});
      for (const NativeEffect* ne : NativeEffects::list()) out.types.push_back(api::GroupTypeInfo{ne->def.type, ne->def.label, "effects"});
    }
    return query_result_for<api::ListGroupTypes>(std::move(out));
  }
  api::QueryResult operator()(const api::ListPresets& q) const {
    api::PresetList out;
    for (const Json& p : registry().presets.arr()) {
      const std::string name = p.at("name").is_string() ? p.at("name").str() : "";
      const std::string category = p.at("category").is_string() ? p.at("category").str() : "";
      const std::string folder = p.at("folder").is_string() ? p.at("folder").str() : "";
      if (!q.category.empty() && category != q.category && folder != q.category) continue;
      const bool hasFolder = !p.at("folder").is_undefined() && !p.at("folder").is_null();
      out.presets.push_back(api::PresetInfo{name, name, hasFolder ? folder : category,
                                            p.at("description").is_string() ? p.at("description").str() : ""});
    }
    return query_result_for<api::ListPresets>(std::move(out));
  }
  api::QueryResult operator()(const api::CapturePreset& q) const {
    // B4: Save as Preset — animationPresets.ts capturePresetBody against the layer's own comp (queries.ts).
    (void)require_layer(d, q.layer);
    api::CapturedPreset out;
    const auto body = capture_preset_body(d, q.layer);
    out.preset = body ? stringify(*body) : "{}";
    out.empty = !body;
    return query_result_for<api::CapturePreset>(std::move(out));
  }
  api::QueryResult operator()(const api::GetCapabilities&) const {
    return query_result_for<api::GetCapabilities>(c.capabilities());
  }
  api::QueryResult operator()(const api::ListPlugins&) const {
    // G1: the native SDK plugins this process hosts (none without a host).
    api::PluginList out;
    out.plugins = NativeEffects::plugins();
    return query_result_for<api::ListPlugins>(std::move(out));
  }
  api::QueryResult operator()(const api::GetEffectUi& q) const {
    api::EffectUi out;
    out.params = native_effect_ui(d, q.layer, q.effect, q.time.value_or(0));
    return query_result_for<api::GetEffectUi>(std::move(out));
  }
  api::QueryResult operator()(const api::HitTest& q) const {
    require_comp(d, q.comp);
    if (!std::isfinite(q.point.x) || !std::isfinite(q.point.y)) fail(ErrorCode::invalid_argument, "the point must be finite");
    std::vector<std::string> ids;
    if (!c.hitTest || !c.hitTest(q.comp, q.time, q.point, ids)) {
      fail(ErrorCode::unsupported, "'hitTest' needs the engine's frame builder (D2w); this engine has none");
    }
    const auto owner = hit_owners(d, q.comp);
    api::HitResult out;
    std::set<std::string> taken;
    for (std::string& id : ids) {
      // The walk names what one layer of this comp draws by prefixing its id
      // (comp_instance.cpp, cloner_port.cpp, frame_build.cpp): `layer::fb` (a
      // Frame Mix draw), `instance::inner` (a collapsed precomp's children),
      // `cloner~c3::child` (a cloner's copies) — each is that layer.
      if (const std::size_t sep = id.find("::"); sep != std::string::npos) id.resize(sep);
      if (const std::size_t sep = id.find("~c"); sep != std::string::npos) id.resize(sep);
      const auto it = owner.find(id);
      if (it == owner.end()) continue;  // a clone, a generated draw: no layer of this comp
      const Node* n = d.node(it->second);
      if (n == nullptr || (n->locked && !q.include_locked)) continue;
      if (!taken.insert(it->second).second) continue;
      out.layers.push_back(it->second);
      if (q.mode == api::HitMode::topmost) break;
    }
    return query_result_for<api::HitTest>(std::move(out));
  }
  api::QueryResult operator()(const api::GetLayerBounds& q) const {
    // B4 round 2: readGeometry's box at the time (core/layer_geometry.cpp; text through the text port),
    // in the layer's own space or through its 2D world chain (queries.ts / layerBoundsQuery.ts).
    if (q.space == api::BoundsSpace::viewport) {
      fail(ErrorCode::unsupported, "viewport-space bounds need the viewport's camera: the overlay geometry push (setOverlayGeometry) carries them");
    }
    if (q.include_effects) fail(ErrorCode::unsupported, "effect growth is not in layer bounds yet (includeEffects)");
    const double seconds = flicks_to_seconds(q.time);
    const SpaceCtx sc{d, pc.view, pc.expr, pc.cache};
    api::LayerBoundsList out;
    for (const auto& id : q.layers) {
      (void)require_layer(d, id);
      const auto g = layer_geometry_at(sc, c.text, id, seconds);
      if (!g) continue;  // no canvas box (audio, adjustment)
      const double l = g->offsetX - g->width / 2;
      const double t = g->offsetY - g->height / 2;
      const double r = l + g->width;
      const double b = t + g->height;
      std::array<double, 8> corners{l, t, r, t, r, b, l, b};
      if (q.space == api::BoundsSpace::comp) {
        const auto m = world_2d_at(pc, id, seconds);
        for (std::size_t i = 0; i < corners.size(); i += 2) {
          const double x = corners[i];
          const double y = corners[i + 1];
          corners[i] = m.a * x + m.c * y + m.e;
          corners[i + 1] = m.b * x + m.d * y + m.f;
        }
      }
      double minX = corners[0], maxX = corners[0], minY = corners[1], maxY = corners[1];
      for (std::size_t i = 2; i < corners.size(); i += 2) {
        minX = std::min(minX, corners[i]);
        maxX = std::max(maxX, corners[i]);
        minY = std::min(minY, corners[i + 1]);
        maxY = std::max(maxY, corners[i + 1]);
      }
      api::LayerBounds lb;
      lb.layer = id;
      lb.bounds = api::Rect{minX, minY, maxX - minX, maxY - minY};
      lb.corners.assign(corners.begin(), corners.end());
      out.bounds.push_back(std::move(lb));
    }
    return query_result_for<api::GetLayerBounds>(std::move(out));
  }
  api::QueryResult operator()(const api::GetTextLayout& q) const {
    // B4 round 2: measured by the text port on the frame builder's fonts (scene/text_query.cpp).
    const Node& n = require_layer(d, q.layer);
    if (n.comp("Text") == nullptr) fail(ErrorCode::invalid_argument, "layer '" + q.layer + "' is not a text layer", {.layer = q.layer});
    if (c.text == nullptr) fail(ErrorCode::unsupported, "text is measured with fonts, which this engine has none of (headless)");
    api::TextLayout out = c.text->text_layout(n, q.overrides ? &*q.overrides : nullptr);
    return query_result_for<api::GetTextLayout>(std::move(out));
  }
  api::QueryResult operator()(const api::ReadPixels& q) const {
    const api::Rect& g = q.region;
    if (!std::isfinite(g.x) || !std::isfinite(g.y) || !std::isfinite(g.width) || !std::isfinite(g.height) || g.width < 0 ||
        g.height < 0) {
      fail(ErrorCode::invalid_argument, "the region must be finite, with no negative size");
    }
    if (!c.viewportSlot || !c.readPixels) fail(ErrorCode::unsupported, "readPixels needs the engine's renderer; this engine has none");
    const auto slot = c.viewportSlot(q.viewport);
    if (!slot) fail(ErrorCode::not_found, "viewport " + std::to_string(q.viewport) + " is not open");
    // The region is in the slot's physical pixels (top-left origin), the pixels
    // it touches; an empty one is the pixel under its corner (a point sample).
    const double x0 = std::floor(g.x);
    const double y0 = std::floor(g.y);
    const double x1 = std::max(x0 + 1, std::ceil(g.x + g.width));
    const double y1 = std::max(y0 + 1, std::ceil(g.y + g.height));
    const double cx0 = std::max(0.0, x0);
    const double cy0 = std::max(0.0, y0);
    const double cx1 = std::min(static_cast<double>(slot->first), x1);
    const double cy1 = std::min(static_cast<double>(slot->second), y1);
    if (!(cx1 > cx0) || !(cy1 > cy0)) fail(ErrorCode::out_of_range, "the region is outside the viewport");
    const auto rw = static_cast<std::uint64_t>(cx1 - cx0);
    const auto rh = static_cast<std::uint64_t>(cy1 - cy0);
    if (rw * rh > kMaxReadPixels) {
      fail(ErrorCode::out_of_range, "read at most " + std::to_string(kMaxReadPixels) + " pixels at once");
    }
    const PixelRegion region{static_cast<std::uint32_t>(cx0), static_cast<std::uint32_t>(cy0), static_cast<std::uint32_t>(rw),
                             static_cast<std::uint32_t>(rh)};
    WorkingPixels px = c.readPixels(q.viewport, region);
    if (px.answer != HookAnswer::ready) fail_hook(px.answer, px.error, "readPixels");
    return query_result_for<api::ReadPixels>(api::PixelSamples{px.width, px.height, std::move(px.rgba)});
  }
  api::QueryResult operator()(const api::GetLayerTransforms& q) const {
    api::LayerTransformList out;
    for (const auto& id : q.layers) {
      (void)require_layer(d, id);
      const double seconds = flicks_to_seconds(q.time);
      api::LayerTransform t;
      t.layer = id;
      // A 3D layer (or a camera / light): its world 4x4, as toWorld reads it —
      // at the layer's comp size (compSizeOf ?? 1920x1080).
      double cw = 1920;
      double ch = 1080;
      if (const auto comp = comp_of_layer(d, id)) {
        if (const Json* rec = d.comp(*comp); rec != nullptr && rec->at("width").is_number() && rec->at("height").is_number()) {
          cw = rec->at("width").num();
          ch = rec->at("height").num();
        }
      }
      if (const auto m3 = world_3d_at(SpaceCtx{d, pc.view, pc.expr, pc.cache}, id, seconds, cw, ch)) {
        t.matrix.assign(m3->begin(), m3->end());
        t.anchor = api::Vec3{0, 0, 0};
        out.transforms.push_back(std::move(t));
        continue;
      }
      const auto m = world_2d_at(pc, id, seconds);
      t.matrix = {m.a, m.b, 0, 0, m.c, m.d, 0, 0, 0, 0, 1, 0, m.e, m.f, 0, 1};
      t.anchor = api::Vec3{0, 0, 0};
      out.transforms.push_back(std::move(t));
    }
    return query_result_for<api::GetLayerTransforms>(std::move(out));
  }
  api::QueryResult operator()(const api::EvaluateExpression& q) const {
    (void)require_layer(d, q.prop.layer);
    const Catalog cat = catalog_for(d, q.prop.layer);
    const PropBinding& b = require_binding(cat, q.prop.path);
    if (b.path == "text/sourceText") {
      // A draft Source Text expression: text + style overrides (B4, the editor preview).
      const auto tr = anim_preview_source_text(d, pc.expr, pc.cache, q.prop.layer, q.source,
                                               flicks_to_key_time(pc, q.prop.layer, b, q.time));
      api::ExpressionEvaluation out;
      if (tr.result) out.text = source_text_preview(*tr.result);
      if (tr.error && !tr.error->empty()) out.diagnostics.push_back(api::ExpressionDiagnostic{to_u8(*tr.error), 0, 0});
      return query_result_for<api::EvaluateExpression>(std::move(out));
    }
    if (b.members.empty()) fail(ErrorCode::unsupported, "'" + b.path + "' is not numeric", {.path = b.path});
    const std::uint32_t member = q.member.value_or(0);
    if (member >= b.members.size()) {
      fail(ErrorCode::out_of_range, "'" + b.path + "' has " + std::to_string(b.members.size()) + " member(s)",
           {.path = b.path});
    }
    const auto r = anim_preview_expression(d, pc.expr, pc.cache, q.prop.layer, b.members[member], q.source,
                                           flicks_to_key_time(pc, q.prop.layer, b, q.time));
    api::ExpressionEvaluation out;
    using K = motion::expr::Result::Kind;
    if (r.kind == K::kNumber) {
      out.value = v_scalar(r.number);
    } else if (r.kind == K::kVector) {
      const auto& v = r.vec;
      if (r.size == 2) out.value = v_vec2(v[0], v[1]);
      else out.value = v_vec3(r.size > 0 ? v[0] : 0, r.size > 1 ? v[1] : 0, r.size > 2 ? v[2] : 0);
    }
    if (r.error && !r.error->empty()) out.diagnostics.push_back(api::ExpressionDiagnostic{to_u8(*r.error), 0, 0});
    return query_result_for<api::EvaluateExpression>(std::move(out));
  }
  api::QueryResult operator()(const api::GetSearchFacts& q) const {
    std::vector<std::string> ids;
    if (!q.layers.empty()) {
      for (const auto& id : q.layers) {
        if (comp_of_layer(d, id)) ids.push_back(id);
      }
    } else {
      for (const auto& comp : comp_item_ids(d)) {
        for (auto& id : layer_ids_of_comp(d, comp)) ids.push_back(std::move(id));
      }
    }
    api::SearchFactsList out;
    out.layers.reserve(ids.size());
    for (const auto& id : ids) {
      api::LayerSearchFacts f;
      f.layer = id;
      const Json& fx = d.node(id)->fx().at("effects");
      if (fx.is_array()) {
        for (const Json& e : fx.arr()) {
          if (e.at("type").is_string()) f.effects.push_back(e.at("type").str());
        }
      }
      if (const NodeAnim* a = d.anim(id)) {
        for (const auto& [prop, st] : a->exprs) f.expressions.push_back(st.src);
      }
      out.layers.push_back(std::move(f));
    }
    return query_result_for<api::GetSearchFacts>(std::move(out));
  }
  api::QueryResult operator()(const api::FindLayers& q) const {
    std::vector<std::string> comps;
    if (q.comp) {
      require_comp(d, *q.comp);
      comps = {*q.comp};
    } else {
      comps = comp_item_ids(d);
    }
    const std::set<api::LayerKind> kinds(q.kinds.begin(), q.kinds.end());
    const std::string needle = lower(q.name);
    api::LayerList out;
    for (const auto& comp : comps) {
      for (const auto& id : layer_ids_of_comp(d, comp)) {
        const Node& n = *d.node(id);
        if (!needle.empty() && lower(n.name).find(needle) == std::string::npos) continue;
        if (!kinds.empty() && !kinds.contains(layer_kind_of(n))) continue;
        if (!q.effect.empty()) {
          const Json& fx = n.fx().at("effects");
          bool hit = false;
          if (fx.is_array()) {
            for (const Json& e : fx.arr()) {
              if (e.at("type").is_string() && e.at("type").str() == q.effect) hit = true;
            }
          }
          if (!hit) continue;
        }
        out.layers.push_back(id);
      }
    }
    return query_result_for<api::FindLayers>(std::move(out));
  }
  api::QueryResult operator()(const api::GetDependencies& q) const {
    api::Dependencies out;
    if (q.item) {
      if (!resolve_item(d, *q.item)) fail(ErrorCode::not_found, "no item '" + *q.item + "'", {.item = *q.item});
      for (const auto& [id, n] : d.nodes()) {
        if (n->parent && read_comp_ref(*n) == *q.item) out.used_by.push_back(api::PropRef{id, ""});
      }
      if (is_comp_item(d, *q.item)) {
        for (const auto& id : layer_ids_of_comp(d, *q.item)) {
          if (auto ref = read_comp_ref(*d.node(id))) out.items.push_back(*ref);
        }
      }
      return query_result_for<api::GetDependencies>(std::move(out));
    }
    if (!q.layer) fail(ErrorCode::invalid_argument, "give a layer or an item");
    (void)require_layer(d, *q.layer);
    // allExpressions(): every expression of every node, node order then prop order.
    for (const auto& [nodeId, a] : d.anims()) {
      for (const auto& [prop, e] : a->exprs) {
        std::vector<std::string> refs;
        const std::string& src = e.src;
        for (std::size_t pos = src.find("layer("); pos != std::string::npos; pos = src.find("layer(", pos + 1)) {
          std::size_t i = pos + 6;
          while (i < src.size() && (src[i] == ' ' || src[i] == '\t' || src[i] == '\n' || src[i] == '\r')) ++i;
          if (i >= src.size() || (src[i] != '\'' && src[i] != '"')) continue;
          ++i;
          if (i >= src.size() || src[i] != '#') continue;
          ++i;
          const std::size_t start = i;
          while (i < src.size() && src[i] != '\'' && src[i] != '"') ++i;
          if (i >= src.size() || i == start) continue;
          refs.push_back(src.substr(start, i - start));
        }
        if (nodeId == *q.layer) {
          for (const auto& r : refs) out.uses.push_back(api::PropRef{r, ""});
        }
        if (std::find(refs.begin(), refs.end(), *q.layer) != refs.end()) out.used_by.push_back(api::PropRef{nodeId, prop});
      }
    }
    if (auto ref = read_comp_ref(*d.node(*q.layer))) out.items.push_back(*ref);
    return query_result_for<api::GetDependencies>(std::move(out));
  }
  api::QueryResult operator()(const api::GetHistory&) const { return query_result_for<api::GetHistory>(c.history()); }
  api::QueryResult operator()(const api::GetRenderStats&) const {
    return query_result_for<api::GetRenderStats>(c.renderStats());
  }
  api::QueryResult operator()(const api::GetLayerErrors& q) const {
    if (q.comp) require_comp(d, *q.comp);
    // D5: the set the frame builder last announced (a UI that subscribed after
    // the `layerErrors` event can still ask); empty without a frame builder.
    api::LayerErrorList out;
    if (c.layerErrors) out.errors = c.layerErrors(q.comp.value_or(""));
    return query_result_for<api::GetLayerErrors>(std::move(out));
  }
  api::QueryResult operator()(const api::GetJobs&) const { return query_result_for<api::GetJobs>(api::JobList{}); }
  api::QueryResult operator()(const api::GetRenderQueue&) const {
    return query_result_for<api::GetRenderQueue>(api::RenderQueueState{d.render_queue()});
  }
  api::QueryResult operator()(const api::GetCommandLog& q) const {
    return query_result_for<api::GetCommandLog>(api::CommandLog{c.log(q.from_revision)});
  }
};

}  // namespace

const Catalog& query_catalog(QCtx& c, const std::string& layer) {
  (void)require_layer(c.pc.d, layer);
  if (c.catalogs == nullptr) {
    thread_local std::unordered_map<std::string, Catalog> local;
    local.clear();
    return local.emplace(layer, catalog_for(c.pc.d, layer)).first->second;
  }
  auto it = c.catalogs->find(layer);
  if (it == c.catalogs->end()) it = c.catalogs->emplace(layer, catalog_for(c.pc.d, layer)).first;
  return it->second;
}

api::QueryResult run_query(const api::Query& q, QCtx& c) {
  return std::visit(Q{c, c.pc, c.pc.d}, q.v);
}

}  // namespace premation::doc
