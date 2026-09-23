#include "docexpr.hpp"

#include <cmath>

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
  return node_by_name(d_, to_u8(name));
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

}  // namespace premation::doc
