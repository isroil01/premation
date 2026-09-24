#include "queries.hpp"

#include <algorithm>
#include <unordered_map>
#include <cmath>
#include <set>

#include "catalog_data.hpp"
#include "docexpr.hpp"
#include "fail.hpp"
#include "fxstate.hpp"
#include "handlers_common.hpp"
#include "handlers_layers.hpp"
#include "native_effects.hpp"
#include "readmodel.hpp"
#include "rig.hpp"
#include "scene.hpp"
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
  for (const char* t : {"zigzag", "roundCorners", "pucker", "twist", "offset", "roughen", "trim", "repeater", "wiggleTransform"}) {
    out.push_back({"contents", std::string("pathop:") + t, t, "contents"});
  }
  return out;
}

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
        double sum = 0;
        for (std::size_t j = 0; j < n2.size(); ++j) sum += (n2[j] - nums[j]) * (n2[j] - nums[j]);
        s.speeds.push_back(std::sqrt(sum) / dt);
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
  api::QueryResult operator()(const api::GetWaveform&) const {
    fail(ErrorCode::unsupported, "waveform peaks are computed by the editor's audio engine until audio moves into the engine (E2)");
  }
  api::QueryResult operator()(const api::ListFonts&) const {
    // The TypeScript engine lists the page's loaded font faces; the engine
    // process has no font catalogue until text moves into it (D/E).
    return query_result_for<api::ListFonts>(api::FontList{});
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
  api::QueryResult operator()(const api::GetThumbnail&) const {
    fail(ErrorCode::unsupported, "thumbnails are rendered by the editor until the engine owns rendering (D2)");
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
  api::QueryResult operator()(const api::GetCapabilities&) const {
    return query_result_for<api::GetCapabilities>(c.capabilities());
  }
  api::QueryResult operator()(const api::HitTest&) const {
    fail(ErrorCode::unsupported, "'hitTest' needs the renderer's geometry/pixels; the TypeScript engine answers it in the editor until D2");
  }
  api::QueryResult operator()(const api::GetLayerBounds&) const {
    fail(ErrorCode::unsupported, "'getLayerBounds' needs the renderer's geometry/pixels; the TypeScript engine answers it in the editor until D2");
  }
  api::QueryResult operator()(const api::GetTextLayout&) const {
    fail(ErrorCode::unsupported, "'getTextLayout' needs the renderer's geometry/pixels; the TypeScript engine answers it in the editor until D2");
  }
  api::QueryResult operator()(const api::ReadPixels&) const {
    fail(ErrorCode::unsupported, "'readPixels' needs the renderer's geometry/pixels; the TypeScript engine answers it in the editor until D2");
  }
  api::QueryResult operator()(const api::GetLayerTransforms& q) const {
    api::LayerTransformList out;
    for (const auto& id : q.layers) {
      (void)require_layer(d, id);
      const auto m = world_2d_at(pc, id, flicks_to_seconds(q.time));
      api::LayerTransform t;
      t.layer = id;
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
    if (b.members.empty()) fail(ErrorCode::unsupported, "'" + b.path + "' is not numeric", {.path = b.path});
    const auto r = anim_preview_expression(d, pc.expr, pc.cache, q.prop.layer, b.members[0], q.source,
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
    return query_result_for<api::GetLayerErrors>(api::LayerErrorList{});
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
