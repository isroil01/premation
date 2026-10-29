#include "docexpr.hpp"

#include <cmath>
#include <cstdlib>
#include <functional>

#include "catalog_data.hpp"
#include "controls.hpp"
#include "fxstate.hpp"
#include "props.hpp"
#include "scene.hpp"
#include "transform.hpp"
#include "worldxf.hpp"

namespace premation::doc {
namespace ex = motion::expr;

std::u16string to_u16(std::string_view s) { return ex::utf8_to_utf16(s); }
std::string to_u8(std::u16string_view s) { return ex::utf16_to_utf8(s); }

namespace {

/// `defaultSceneGraph.traverse` (every node, insertion order), first with `name`.
std::optional<std::string> node_by_name(const Document& d, std::string_view name) {
  for (const auto& [id, n] : d.nodes()) {
    if (n->name == name) return id;
  }
  return std::nullopt;
}

const Json* comp_record(const Document& d, const EditorView& v) {
  // useCompositionStore.comp(): the active tab's composition.
  if (const Json* c = d.comp(v.tabComp)) return c;
  for (const auto& [id, c] : d.comps()) return c.get();
  return nullptr;
}

double rec_num(const Json* rec, std::string_view key, double fb) {
  if (rec == nullptr) return fb;
  const Json& v = rec->at(key);
  return v.is_number() ? v.num() : fb;
}

}  // namespace

std::optional<double> DocExprEnv::base_value(std::string_view node, std::string_view prop) const {
  const Node* n = d_.node(node);
  if (n == nullptr) return std::nullopt;
  const Component* t = n->comp("Transform");
  if (t != nullptr) {
    const Json& v = t->props.at(prop);
    if (v.is_number()) return v.num();
  }
  for (const Component& c : n->components) {
    if (&c == t) continue;
    const Json& v = c.props.at(prop);
    if (v.is_number()) return v.num();
  }
  return std::nullopt;
}

std::optional<std::string> DocExprEnv::resolve_layer(std::u16string_view name) const {
  if (!cache_.scoped()) return node_by_name(d_, to_u8(name));
  // One evaluation: every name indexed once (the first node with it wins, as node_by_name).
  auto& names = cache_.memo(*this).layerNames;
  if (!names) {
    names.emplace();
    names->reserve(d_.nodes().size());
    for (const auto& [id, n] : d_.nodes()) names->try_emplace(n->name, id);
  }
  const auto it = names->find(to_u8(name));
  if (it == names->end()) return std::nullopt;
  return it->second;
}

ex::CompInfo DocExprEnv::comp_info() const {
  const Json* c = comp_record(d_, view_);
  ex::CompInfo info;
  info.width = rec_num(c, "width", 1920);
  info.height = rec_num(c, "height", 1080);
  info.duration = rec_num(c, "durationSeconds", 10);
  info.fps = rec_num(c, "fps", 30);
  info.num_layers = static_cast<double>(d_.nodes().size());
  return info;
}

ex::LayerInfo DocExprEnv::layer_info(std::string_view node) const {
  const Json* c = comp_record(d_, view_);
  const Node* n = d_.node(node);
  ex::LayerInfo info;
  info.name = to_u16(n != nullptr ? std::string_view(n->name) : std::string_view("Layer"));
  const Component* t = n != nullptr ? n->comp("Transform") : nullptr;
  const Json& w = t != nullptr ? t->props.at("width") : Json::null();
  const Json& h = t != nullptr ? t->props.at("height") : Json::null();
  info.width = w.is_number() ? w.num() : rec_num(c, "width", 1920);
  info.height = h.is_number() ? h.num() : rec_num(c, "height", 1080);
  return info;
}

double DocExprEnv::ctrl(std::u16string_view name, double t) const {
  const std::u16string key(name);
  if (resolving_.contains(key)) return 0;  // a control referencing itself resolves to 0
  const std::string prop = "ctrl_" + to_u8(name);
  resolving_.insert(key);
  double out = 0;
  // flattenScene: roots in node order, each subtree depth-first (child order).
  std::function<bool(const Node&)> walk = [&](const Node& n) -> bool {
    if (const Component* tc = n.comp("Transform")) {
      const Json& base = tc->props.at(prop);
      if (base.is_number()) {
        out = anim_sample(d_, *this, cache_, n.id, prop, t).value_or(base.num());
        return true;
      }
    }
    for (const auto& c : n.children) {
      if (const Node* child = d_.node(c)) {
        if (walk(*child)) return true;
      }
    }
    return false;
  };
  for (const auto& [id, n] : d_.nodes()) {
    if (n->parent) continue;
    if (walk(*n)) break;
  }
  resolving_.erase(key);
  return out;
}

std::optional<ex::SourceRect> DocExprEnv::source_rect(std::string_view node, double /*t*/, bool /*extents*/) const {
  const Node* n = d_.node(node);
  if (n == nullptr) return std::nullopt;
  // Text is measured by the renderer's shaper (measureTextNodeBoxes) — not in
  // the document core; it reports the Transform box like every other kind.
  const Component* tr = n->comp("Transform");
  const Json& w = tr != nullptr ? tr->props.at("width") : Json::null();
  const Json& h = tr != nullptr ? tr->props.at("height") : Json::null();
  if (!w.is_number() || !h.is_number()) return std::nullopt;
  return ex::SourceRect{-h.num() / 2, -w.num() / 2, w.num(), h.num()};
}

std::vector<ex::MarkerData> DocExprEnv::markers(std::string_view node, ex::MarkerScope scope) const {
  std::vector<ex::MarkerData> out;
  const Timeline* active = d_.timeline(view_.tabComp);
  const double fps = active != nullptr ? active->fps : 30;
  auto push = [&](const TMarker& m, double time) {
    ex::MarkerData md;
    md.time = time;
    md.duration = m.duration / fps;
    md.name = to_u16(m.name.empty() ? std::string_view("Marker") : std::string_view(m.name));
    md.comment = to_u16(m.comment);
    out.push_back(std::move(md));
  };
  if (scope == ex::MarkerScope::kComp) {
    if (active != nullptr) {
      for (const TMarker& m : active->markers) push(m, m.frame / fps);
    }
    return out;
  }
  const auto bars = tl_bars_for_node(d_, view_, node);
  const double offset = bars.empty() ? 0.0 : bars.front()->clip.start / fps;
  for (const Bar* b : bars) {
    for (const TMarker& m : b->markers) push(m, m.frame / fps + offset);
  }
  return out;
}

std::optional<std::string> DocExprEnv::space_node(std::string_view self, const std::u16string* name) const {
  if (name == nullptr) return std::string(self);
  // resolveLayerRef: `#<id>` resolves directly, else by name.
  if (!name->empty() && (*name)[0] == u'#') {
    const std::string id = to_u8(std::u16string_view(*name).substr(1));
    if (d_.node(id) != nullptr) return id;
    return std::nullopt;
  }
  return node_by_name(d_, to_u8(*name));
}

bool DocExprEnv::space_exists(std::string_view self, const std::u16string* name, double t) const {
  const auto id = space_node(self, name);
  return id && space_at(*id, t).has_value();
}

std::optional<LayerSpace> DocExprEnv::space_at(const std::string& id, double t) const {
  // Providers.tsx: layerSpaceAt(node, t, {width, height} of the active comp).
  const Json* c = comp_record(d_, view_);
  return layer_space_at(SpaceCtx{d_, view_, *this, cache_}, id, t, rec_num(c, "width", 1920), rec_num(c, "height", 1080));
}

std::array<double, 3> DocExprEnv::space_convert(std::string_view self, const std::u16string* name, double t,
                                                ex::SpaceOp op, std::array<double, 3> p) const {
  const auto id = space_node(self, name);
  if (!id) return p;
  const auto space = space_at(*id, t);
  if (!space) return p;
  // layerSpace.ts: the 2D affine or the 3D matrix + camera (projection, ray/plane).
  return std::visit(
      [&](const auto& sp) -> std::array<double, 3> {
        switch (op) {
          case ex::SpaceOp::kToComp: {
            const auto q = sp.to_comp({p[0], p[1]});
            return {q.x, q.y, p[2]};
          }
          case ex::SpaceOp::kFromComp: {
            const auto q = sp.from_comp({p[0], p[1]});
            return {q.x, q.y, p[2]};
          }
          case ex::SpaceOp::kToWorld: {
            const auto q = sp.to_world({p[0], p[1]});
            return {q.x, q.y, q.z};
          }
          case ex::SpaceOp::kFromWorld: {
            const auto q = sp.from_world({p[0], p[1], p[2]});
            return {q.x, q.y, 0};
          }
        }
        return p;
      },
      *space);
}

// ── Cameras and lights (camera program D6) ──────────────────────────────

std::optional<double> DocExprEnv::prop_default(std::string_view node, std::string_view prop) const {
  const Node* n = d_.node(node);
  if (n == nullptr) return std::nullopt;
  const Json* c = comp_record(d_, view_);
  const double w = rec_num(c, "width", 1920);
  const double h = rec_num(c, "height", 1080);
  const std::string kind = n->kind();
  // A camera's Zoom: camera3d.ts defaultFocalLength (a 39.6° horizontal view).
  const double focal = w / 2 / std::tan(39.6 * 3.141592653589793 / 360);
  if (prop == "x" || prop == "y") {
    if (const auto g = read_geometry_local(*n)) return prop == "x" ? g->x : g->y;
    return prop == "x" ? w / 2 : h / 2;
  }
  if (kind == "camera") {
    if (prop == "focalLength") return focal;
    if (prop == "z") return -base_value(node, "focalLength").value_or(focal);
  }
  if (kind == "camera" || kind == "light") {
    // AE reads a Point of Interest even on a one-node device: the comp centre.
    if (prop == "poiX") return w / 2;
    if (prop == "poiY") return h / 2;
    if (prop == "poiZ") return 0.0;
  }
  if (kind == "light") {
    if (prop == "intensity") return 100.0;
    if (prop == "lightCone") return 90.0;
    if (prop == "lightConeFeather") return 50.0;
    if (prop == "shadowDarkness") return 100.0;
    if (prop == "shadowDiffusion") return 0.0;
    if (prop == "radius") return 500.0;
    if (prop == "falloffDistance") return 500.0;
  }
  return std::nullopt;
}

std::optional<std::array<double, 4>> DocExprEnv::color_at(std::string_view node, std::string_view prop, double t) const {
  const Node* n = d_.node(node);
  if (n == nullptr) return std::nullopt;
  std::array<double, 4> rgba{1, 1, 1, 1};
  for (const Component& comp : n->components) {
    const Json& v = comp.props.at(prop);
    if (!v.is_string()) continue;
    std::string_view s = v.str();
    if (!s.empty() && s.front() == '#') s.remove_prefix(1);
    const auto hex = [&](std::size_t i) {
      const std::string part(s.substr(i, 2));
      char* end = nullptr;
      const long x = std::strtol(part.c_str(), &end, 16);
      return end == part.c_str() + 2 ? static_cast<double>(x) / 255 : 1.0;
    };
    if (s.size() >= 6) rgba = {hex(0), hex(2), hex(4), s.size() >= 8 ? hex(6) : 1.0};
  }
  // A keyed colour rides `<prop>_r/_g/_b/_a` (0..1).
  const std::string base(prop);
  const std::array<const char*, 4> ch = {"_r", "_g", "_b", "_a"};
  for (std::size_t i = 0; i < 4; ++i) {
    if (const auto v = anim_sample(d_, *this, cache_, node, base + ch.at(i), t)) rgba.at(i) = *v;
  }
  return rgba;
}

std::optional<std::string> DocExprEnv::active_camera(double /*t*/) const {
  // camera3d.ts viewCameraNode, as the expression provider reads it: the LAST
  // visible camera of the active composition in flattenScene order.
  const Node* found = nullptr;
  std::set<std::string> seen;
  std::function<void(const Node&)> walk = [&](const Node& n) {
    if (!seen.insert(n.id).second) return;
    if (n.kind() == "camera" && n.visible) found = &n;
    for (const auto& ch : n.children) {
      const Node* child = d_.node(ch);
      // Nested compositions keep their own cameras.
      if (child != nullptr && !(child->kind() == "group" && d_.comp(child->id) != nullptr)) walk(*child);
    }
  };
  if (const Node* root = d_.node(view_.tabComp)) {
    walk(*root);
  } else {
    for (const auto& [id, n] : d_.nodes()) {
      if (!n->parent) walk(*n);
    }
  }
  if (found == nullptr) return std::nullopt;
  return found->id;
}

std::optional<ex::SourceTextSample> DocExprEnv::source_text(std::string_view node, double t) const {
  const Node* n = d_.node(node);
  if (n == nullptr) return std::nullopt;
  const Component* text = n->comp("Text");
  if (text == nullptr) return std::nullopt;
  ex::SourceTextSample s;
  std::string content = text->props.at("content").is_string() ? text->props.at("content").str() : "";
  if (const DataTrack* tr = anim_data_track(d_, node, "text.source")) {
    if (auto v = sample_data_track(*tr, t); v && v->is_string()) content = v->str();
  }
  s.text = to_u16(content);
  const Json& family = text->props.at("fontFamily");
  if (family.is_string()) s.style.font_family = to_u16(family.str());
  return s;
}

std::optional<PathAt> DocExprEnv::path(std::string_view node, bool mask, const std::string* name, double t) const {
  const Node* n = d_.node(node);
  if (n == nullptr) return std::nullopt;
  if (mask) {
    // The mask as it is at t (readers.cpp read_node_mask_at): its shape keyframes, else the static mask.
    const std::vector<Json> anim = read_node_mask_anim(*n);
    std::optional<Json> m = anim.empty() ? read_node_mask(*n) : interpolate_mask(anim, t);
    if (!m || !m->at("paths").is_array()) return std::nullopt;
    const auto& paths = m->at("paths").arr();
    // mask("Mask 1") by name, mask(1) by 1-based index, no argument = the first.
    const Json* hit = nullptr;
    for (std::size_t i = 0; i < paths.size() && hit == nullptr; ++i) {
      const Json& p = paths[i];
      if (name == nullptr) {
        hit = &p;
        break;
      }
      const std::string own = p.at("name").is_string() ? p.at("name").str() : "Mask " + std::to_string(i + 1);
      if (own == *name || (p.at("id").is_string() && p.at("id").str() == *name)) hit = &p;
    }
    if (hit == nullptr && name != nullptr) {
      char* end = nullptr;
      const double idx = std::strtod(name->c_str(), &end);
      if (end != name->c_str() && *end == '\0' && idx >= 1 && idx <= static_cast<double>(paths.size()) &&
          idx == std::floor(idx)) {
        hit = &paths[static_cast<std::size_t>(idx) - 1];
      }
    }
    if (hit == nullptr || !hit->at("id").is_string()) return std::nullopt;
    const bool closed = !hit->at("closed").is_bool() || hit->at("closed").b();
    return PathAt{path_sample_of_points(hit->at("points"), closed), "mask." + hit->at("id").str() + ".path"};
  }
  // A shape's Path: its animated outline, else the static points (a Premation shape draws one path).
  const Component* g = n->comp("Geometry");
  const bool closed = shape_closed(*n);
  if (const DataTrack* tr = anim_data_track(d_, node, std::string(kShapePathTrack))) {
    if (auto v = sample_data_track(*tr, t); v && v->is_array() && !v->arr().empty()) {
      return PathAt{path_sample_of_points(*v, closed), std::string(kShapePathTrack)};
    }
  }
  if (g == nullptr) return std::nullopt;
  const Json& pts = g->props.at("points");
  if (pts.is_array() && !pts.arr().empty()) return PathAt{path_sample_of_points(pts, closed), std::string(kShapePathTrack)};
  const Json& sub = g->props.at("subpaths");
  if (sub.is_array() && !sub.arr().empty()) {
    return PathAt{path_sample_of_points(sub.arr()[0].at("points"), closed), std::string(kShapePathTrack)};
  }
  return std::nullopt;
}

// ── AE-style rigs (docs/EXPRESSION_LANGUAGE.md) ──────────────────────────

namespace {

bool same_name(std::string_view a, std::string_view b) {
  if (a.size() != b.size()) return false;
  for (std::size_t i = 0; i < a.size(); ++i) {
    const char x = a[i];
    const char y = b[i];
    const char lx = (x >= 'A' && x <= 'Z') ? static_cast<char>(x + 32) : x;
    const char ly = (y >= 'A' && y <= 'Z') ? static_cast<char>(y + 32) : y;
    if (lx != ly) return false;
  }
  return true;
}

/// `effect("Name")` on the layer: an expression control (by its name), else
/// an effect instance (by its own name, its definition's label, or its match
/// name) — case-insensitively, as AE users type them.
struct EffectHit {
  const LayerControl* control = nullptr;
  std::optional<Json> effect;
  const EffectDef* def = nullptr;
};

EffectHit find_effect(const Node& n, const std::vector<LayerControl>& controls, std::string_view name) {
  EffectHit hit;
  for (const LayerControl& c : controls) {
    if (same_name(c.name, name)) {
      hit.control = &c;
      return hit;
    }
  }
  for (Json& e : read_node_effects(n)) {
    const std::string type = e.at("type").is_string() ? e.at("type").str() : std::string();
    const EffectDef* def = registry().effect(type);
    const Json& own = e.at("name");
    const bool match = (own.is_string() && same_name(own.str(), name)) || (def != nullptr && same_name(def->label, name)) ||
                       same_name(type, name);
    if (!match) continue;
    hit.effect = std::move(e);
    hit.def = def;
    return hit;
  }
  return hit;
}

}  // namespace

std::optional<ex::LayerFacts> DocExprEnv::layer_facts(std::string_view node, double t) const {
  if (cache_.scoped()) {
    auto& facts = cache_.memo(*this).facts;
    if (const auto it = facts.find(std::string(node)); it != facts.end()) return it->second;
    std::optional<ex::LayerFacts> f = layer_facts_of(node, t);
    facts.emplace(std::string(node), f);
    return f;
  }
  return layer_facts_of(node, t);
}

std::optional<ex::LayerFacts> DocExprEnv::layer_facts_of(std::string_view node, double /*t*/) const {
  const Node* n = d_.node(node);
  if (n == nullptr) return std::nullopt;
  ex::LayerFacts f;
  f.enabled = n->visible;
  f.name = to_u16(n->name);
  f.out_point = rec_num(comp_record(d_, view_), "durationSeconds", 10);
  if (const auto comp = comp_of_layer(d_, node)) {
    const Timeline* tl = d_.timeline(*comp);
    const double fps = tl != nullptr && tl->fps > 0 ? tl->fps : 30;
    if (tl != nullptr) f.out_point = tl->duration / fps;
    const auto bars = bars_of(d_, node, *comp);
    if (!bars.empty()) {
      f.in_point = bars.front()->clip.start / fps;
      f.out_point = bars.back()->clip.end() / fps;
    }
    const std::vector<std::string> ids = layer_ids_of_comp(d_, *comp);
    for (std::size_t i = 0; i < ids.size(); ++i) {
      if (ids[i] == node) {
        f.index = static_cast<double>(i + 1);
        break;
      }
    }
  }
  if (const auto p = api_parent_of(d_, node)) f.parent = to_u16(*p);
  return f;
}

std::optional<std::string> DocExprEnv::layer_by_index(std::string_view self, double index) const {
  const auto comp = comp_of_layer(d_, self);
  if (!comp || !(index >= 1) || std::floor(index) != index) return std::nullopt;
  const std::vector<std::string> ids = layer_ids_of_comp(d_, *comp);
  const auto i = static_cast<std::size_t>(index);
  if (i > ids.size()) return std::nullopt;
  return ids[i - 1];
}

bool DocExprEnv::effect_exists(std::string_view node, std::string_view effect) const {
  return effect_state(node, effect).first;
}

std::pair<bool, bool> DocExprEnv::effect_state(std::string_view node, std::string_view effect) const {
  // {exists, enabled}: effect("X") asks both on every call.
  const auto find = [&]() -> std::pair<bool, bool> {
    const Node* n = d_.node(node);
    if (n == nullptr) return {false, true};
    const EffectHit hit = find_effect(*n, read_controls(*n), effect);
    if (!hit.effect) return {hit.control != nullptr, true};  // an expression control has no switch of its own
    const Json& en = hit.effect->at("enabled");
    return {true, !(en.is_bool() && !en.b())};
  };
  if (!cache_.scoped()) return find();
  std::string key;
  key.append(node).push_back('\x1f');
  key.append(effect);
  auto& effects = cache_.memo(*this).effects;
  if (const auto it = effects.find(key); it != effects.end()) return it->second;
  const std::pair<bool, bool> out = find();
  effects.emplace(std::move(key), out);
  return out;
}

std::optional<std::vector<ExprEnv::EffectMember>> DocExprEnv::effect_param_members(std::string_view node,
                                                                                   std::string_view effect,
                                                                                   const std::string* param,
                                                                                   double index) const {
  if (!cache_.scoped()) return effect_param_members_of(node, effect, param, index);
  // One evaluation: effect("X")("P") resolves once (read_controls, the effect
  // list and the parameter scan), then every read is a lookup.
  std::string key;
  key.append(node).push_back('\x1f');
  key.append(effect).push_back('\x1f');
  if (param != nullptr) key.append(*param);
  else key.append("#").append(std::to_string(index));
  auto& members = cache_.memo(*this).members;
  if (const auto it = members.find(key); it != members.end()) return it->second;
  auto out = effect_param_members_of(node, effect, param, index);
  members.emplace(std::move(key), out);
  return out;
}

std::optional<std::vector<ExprEnv::EffectMember>> DocExprEnv::effect_param_members_of(std::string_view node,
                                                                                      std::string_view effect,
                                                                                      const std::string* param,
                                                                                      double index) const {
  const Node* n = d_.node(node);
  if (n == nullptr) return std::nullopt;
  const std::vector<LayerControl> controls = read_controls(*n);
  const EffectHit hit = find_effect(*n, controls, effect);
  std::vector<EffectMember> out;
  if (hit.control != nullptr) {
    // A control has one value: `("Slider")`, `("Point")`, `("Color")`… or (1).
    const ControlSpec& spec = *hit.control->spec;
    const bool wanted = param == nullptr ? index == 1
                                         : same_name(*param, spec.propName) || same_name(*param, spec.param) ||
                                               same_name(*param, spec.propMatchName);
    if (!wanted) return std::nullopt;
    const std::vector<std::string> members = control_members(*hit.control);
    const bool colour = spec.valueType == api::ValueType::color;
    for (std::size_t i = 0; i < members.size(); ++i) {
      // A colour control stores 0–255 channels; AE reads 0..1.
      out.push_back({.key = members[i], .scale = colour && i < 3 ? 1.0 / 255.0 : 1.0, .offset = 0});
    }
    // AE's colour is [r, g, b, a]; the control keeps no alpha (opaque).
    if (colour && members.size() == 3) out.push_back({.key = {}, .scale = 1, .offset = 1});
    return out;
  }
  if (!hit.effect || hit.def == nullptr) return std::nullopt;
  const EffectParamDef* pd = nullptr;
  if (param != nullptr) {
    for (const EffectParamDef& p : hit.def->params) {
      if (same_name(p.label, *param) || same_name(p.key, *param)) {
        pd = &p;
        break;
      }
    }
  } else if (index >= 1 && std::floor(index) == index && static_cast<std::size_t>(index) <= hit.def->params.size()) {
    pd = &hit.def->params[static_cast<std::size_t>(index) - 1];
  }
  if (pd == nullptr) return std::nullopt;
  const std::string id = hit.effect->at("id").is_string() ? hit.effect->at("id").str() : std::string("undefined");
  const std::string base = "effect." + id + "." + pd->key;
  if (pd->type == "number" || pd->type == "checkbox" || pd->type == "enum") {
    out.push_back({.key = base, .scale = 1});
    return out;
  }
  if (pd->type == "color") {
    for (const char* ch : {"_r", "_g", "_b", "_a"}) out.push_back({.key = base + ch, .scale = 1});
    return out;
  }
  return std::nullopt;  // a curve, layer, text or file parameter has no number to read
}

std::optional<double> DocExprEnv::static_value(std::string_view node, std::string_view prop) const {
  if (!cache_.scoped()) return read_static_property_value(d_, node, prop);
  std::string key;
  key.append(node).push_back('\x1f');
  key.append(prop);
  auto& statics = cache_.memo(*this).statics;
  if (const auto it = statics.find(key); it != statics.end()) return it->second;
  const std::optional<double> v = read_static_property_value(d_, node, prop);
  statics.emplace(std::move(key), v);
  return v;
}

// ── AE property objects (2026-10-21) ─────────────────────────────────────

bool DocExprEnv::effect_enabled(std::string_view node, std::string_view effect) const {
  return effect_state(node, effect).second;
}

namespace {

ex::CompFacts comp_facts_of(const Document& d, const std::string& id, const Json& rec) {
  ex::CompFacts f;
  f.info.width = rec_num(&rec, "width", 1920);
  f.info.height = rec_num(&rec, "height", 1080);
  f.info.duration = rec_num(&rec, "durationSeconds", 10);
  f.info.fps = rec_num(&rec, "fps", 30);
  f.info.num_layers = static_cast<double>(layer_ids_of_comp(d, id).size());
  const Json& name = rec.at("name");
  f.name = to_u16(name.is_string() ? std::string_view(name.str()) : std::string_view(id));
  return f;
}

/// A composition by its name (AE: exact), else nullopt.
std::optional<std::string> comp_by_name(const Document& d, std::string_view name) {
  for (const auto& [id, rec] : d.comps()) {
    const Json& n = rec->at("name");
    if (n.is_string() && n.str() == name) return id;
  }
  return std::nullopt;
}

}  // namespace

std::optional<ex::CompFacts> DocExprEnv::comp_facts(std::string_view self, const std::string* name) const {
  std::optional<std::string> id;
  if (name != nullptr) {
    id = comp_by_name(d_, *name);
  } else {
    id = comp_of_layer(d_, self);
    if (!id) id = view_.tabComp;
  }
  if (!id) return std::nullopt;
  const Json* rec = d_.comp(*id);
  if (rec == nullptr) return std::nullopt;
  return comp_facts_of(d_, *id, *rec);
}

std::optional<std::string> DocExprEnv::comp_layer(const std::string& comp, const std::string* name, double index) const {
  const std::optional<std::string> id = comp_by_name(d_, comp);
  if (!id) return std::nullopt;
  const std::vector<std::string> ids = layer_ids_of_comp(d_, *id);
  if (name != nullptr) {
    for (const std::string& l : ids) {
      const Node* n = d_.node(l);
      if (n != nullptr && n->name == *name) return l;
    }
    return std::nullopt;
  }
  if (!(index >= 1) || std::floor(index) != index || static_cast<std::size_t>(index) > ids.size()) return std::nullopt;
  return ids[static_cast<std::size_t>(index) - 1];
}

}  // namespace premation::doc
