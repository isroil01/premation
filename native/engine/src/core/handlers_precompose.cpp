// precompose — src/core/engine/handlers/comps.ts `precompose` over
// src/core/composition/precompose.ts `precomposeNow` (Move all attributes /
// Leave all attributes).
#include <algorithm>
#include <cctype>
#include <cmath>
#include <functional>
#include <set>

#include "fxstate.hpp"
#include "time_conv.hpp"
#include "handlers_comps.hpp"
#include "parenting.hpp"
#include "readmodel.hpp"

namespace premation::doc {

namespace {

/// `id.replace(/[^\w-]/g, '_')` — the scope sanitizeSvg is given.
std::string svg_scope_of(std::string_view id) {
  std::string out(id);
  for (char& c : out) {
    const auto u = static_cast<unsigned char>(c);
    if (!(std::isalnum(u) != 0 || c == '_' || c == '-')) c = '_';
  }
  return out;
}

/// The ids the SOURCE markup declares (svgSanitize.ts collectIds, read off the
/// text: `id="…"` / `id='…'` attributes), in document order.
std::vector<std::string> svg_source_ids(std::string_view src) {
  std::vector<std::string> out;
  for (std::size_t i = src.find("id"); i != std::string_view::npos; i = src.find("id", i + 2)) {
    const bool bounded = i == 0 || std::isspace(static_cast<unsigned char>(src[i - 1])) != 0;
    if (!bounded) continue;
    std::size_t j = i + 2;
    while (j < src.size() && std::isspace(static_cast<unsigned char>(src[j])) != 0) ++j;
    if (j >= src.size() || src[j] != '=') continue;
    ++j;
    while (j < src.size() && std::isspace(static_cast<unsigned char>(src[j])) != 0) ++j;
    if (j >= src.size() || (src[j] != '"' && src[j] != '\'')) continue;
    const char q = src[j];
    const std::size_t end = src.find(q, j + 1);
    if (end == std::string_view::npos) break;
    if (end > j + 1) out.emplace_back(src.substr(j + 1, end - j - 1));
  }
  return out;
}

/// The scope the stored sanitized markup was made under: the `<scope>` of the
/// first `id="<scope>__<sourceId>"` it holds.
std::optional<std::string> svg_markup_scope(std::string_view markup, const std::vector<std::string>& ids) {
  for (const std::string& id : ids) {
    const std::string tail = "__" + id;
    for (const char q : {'"', '\''}) {
      const std::string needle = std::string("id=") + q;
      for (std::size_t i = markup.find(needle); i != std::string_view::npos; i = markup.find(needle, i + 1)) {
        const std::size_t start = i + needle.size();
        const std::size_t end = markup.find(q, start);
        if (end == std::string_view::npos) break;
        const std::string_view value = markup.substr(start, end - start);
        if (value.size() > tail.size() && value.ends_with(tail)) return std::string(value.substr(0, value.size() - tail.size()));
      }
    }
  }
  return std::nullopt;
}

/// precompose.ts sanitizes the SVG SOURCE again under the content's id. The
/// sanitizer (DOMPurify over a DOM) is the editor's; its output depends on the
/// scope only through the names scopeSvgIds writes (`<scope>__<id>` in ids,
/// `#…` / `url(#…)` references, CSS selectors and SMIL `<id>.` sync-bases), so
/// the engine re-scopes the markup it already holds: every `<old>__` that
/// starts a scoped name becomes `<new>__`. The same bytes as the editor's
/// re-sanitize, for markup the current policy produced.
std::string rescope_svg_markup(const std::string& markup, std::string_view source, const std::string& newScope) {
  const auto ids = svg_source_ids(source);
  if (ids.empty()) return markup;
  const auto old = svg_markup_scope(markup, ids);
  if (!old || *old == newScope) return markup;
  const std::string from = *old + "__";
  const std::string to = newScope + "__";
  std::string out;
  out.reserve(markup.size() + 16);
  std::size_t pos = 0;
  for (std::size_t i = markup.find(from); i != std::string::npos; i = markup.find(from, i + 1)) {
    const char before = i == 0 ? '\0' : markup[i - 1];
    // A scoped name starts after an attribute quote, `#`, or a SMIL separator.
    const bool starts = before == '"' || before == '\'' || before == '#' || before == ';' || before == '+' ||
                        std::isspace(static_cast<unsigned char>(before)) != 0;
    if (!starts) continue;
    out.append(markup, pos, i - pos);
    out += to;
    pos = i + from.size();
  }
  out.append(markup, pos, std::string::npos);
  return out;
}

/// svgLayer.ts makeSvgComponent's props for the precomp's content (precompose.ts).
Json content_svg_props(const Json& sp, const std::string& contentId, double layerW, double layerH, const std::string& nodeName) {
  const std::string sourceMarkup = sp.at("sourceMarkup").is_string() ? sp.at("sourceMarkup").str() : std::string();
  const std::string stored = sp.at("sanitizedMarkup").is_string() ? sp.at("sanitizedMarkup").str() : std::string();
  const std::string sanitized = sourceMarkup.empty() ? stored : rescope_svg_markup(stored, sourceMarkup, svg_scope_of(contentId));
  const auto num_or_zero = [](const Json& v) { return v.is_number() && std::isfinite(v.num()) ? v.num() : 0.0; };
  const double iw = num_or_zero(sp.at("intrinsicWidth"));
  const double ih = num_or_zero(sp.at("intrinsicHeight"));
  Json p = Json::object();
  p.set("sourceMarkup", Json::string(sourceMarkup));
  p.set("sanitizedMarkup", Json::string(sanitized));
  p.set("sanitizePolicy", Json::number(2));  // SVG_SANITIZE_POLICY_VERSION
  p.set("intrinsicWidth", Json::number(iw != 0 ? iw : layerW));
  p.set("intrinsicHeight", Json::number(ih != 0 ? ih : layerH));
  const Json& vb = sp.at("viewBox");
  p.set("viewBox", vb.is_undefined() ? Json::null() : vb);
  p.set("capabilities", sp.at("capabilities"));
  p.set("fileName", sp.at("fileName").is_undefined() || sp.at("fileName").is_null() ? Json::string(nodeName)
                                                                                     : (sp.at("fileName").is_string() ? sp.at("fileName") : Json::string(sp.at("fileName").is_number() ? js::number_to_string(sp.at("fileName").num()) : js::stringify(sp.at("fileName")))));
  if (sp.at("livePlayback").is_bool() && sp.at("livePlayback").b()) p.set("livePlayback", Json::boolean(true));
  return p;
}

}  // namespace


using api::ErrorCode;

namespace {

bool has_ancestor_in(const Document& d, const std::string& id, const std::set<std::string>& set) {
  const Node* n = d.node(id);
  std::optional<std::string> parent = n != nullptr ? n->parent : std::nullopt;
  for (int guard = 0; parent && guard < 256; ++guard) {
    if (set.contains(*parent)) return true;
    const Node* p = d.node(*parent);
    parent = p != nullptr ? p->parent : std::nullopt;
  }
  return false;
}

/// `precomposeTargets(ids)` — hosted in the ACTIVE tab's composition.
std::vector<std::string> precompose_targets(const Document& d, const EditorView& v, const std::vector<std::string>& ids) {
  const std::string host = v.tabComp;
  if (d.node(host) == nullptr) return {};
  std::set<std::string> wanted;
  for (const auto& id : ids) {
    if (id != host && d.node(id) != nullptr) wanted.insert(id);
  }
  std::vector<std::string> out;
  std::function<void(const std::string&)> walk = [&](const std::string& id) {
    if (wanted.contains(id) && !has_ancestor_in(d, id, wanted)) out.push_back(id);
    const Node* n = d.node(id);
    if (n == nullptr) return;
    for (const auto& c : n->children) {
      if (d.node(c) != nullptr) walk(c);
    }
  };
  walk(host);
  return out;
}

std::string default_precomp_name(const Document& d) {
  std::set<std::string> taken;
  for (const auto& [id, c] : d.comps()) {
    std::string s = c->at("name").is_string() ? c->at("name").str() : "";
    while (!s.empty() && s.front() == ' ') s.erase(0, 1);
    while (!s.empty() && s.back() == ' ') s.pop_back();
    for (char& ch : s) {
      if (ch >= 'A' && ch <= 'Z') ch = static_cast<char>(ch - 'A' + 'a');
    }
    taken.insert(s);
  }
  int n = 1;
  while (taken.contains("pre-comp " + std::to_string(n))) ++n;
  return "Pre-comp " + std::to_string(n);
}

Json host_settings(const Document& d, const std::string& host) {
  Json base = Json::object();
  base.set("width", Json::number(1920));
  base.set("height", Json::number(1080));
  base.set("fps", Json::number(30));
  base.set("durationSeconds", Json::number(10));
  base.set("background", Json::string("#101014"));
  base.set("transparent", Json::boolean(false));
  base.set("startFrame", Json::number(0));
  const Json* c = d.comp(host);
  return c != nullptr ? spread(base, *c) : base;
}

/// compositionOps.ts `addCompositionRecord(init)` (createComp + root node).
void add_composition_record(Document& d, const std::string& id, const Json& init) {
  Json rec = Json::object();
  rec.set("name", Json::string("Composition"));
  rec.set("width", Json::number(1920));
  rec.set("height", Json::number(1080));
  rec.set("fps", Json::number(30));
  rec.set("durationSeconds", Json::number(10));
  rec.set("background", Json::string("#101014"));
  rec.set("transparent", Json::boolean(false));
  rec.set("startFrame", Json::number(0));
  rec = spread(rec, init);
  rec.set("id", Json::string(id));
  d.comp_mut(id) = rec;
  Node root;
  root.id = id;
  root.name = init.at("name").is_string() ? init.at("name").str() : "Composition";
  Json p = Json::object();
  p.set("__kind", Json::string("group"));
  root.components.push_back(Component{id + "_meta", "group", std::move(p)});
  sg_add_node(d, std::move(root));
}

Node make_instance_node(const std::string& id, const std::string& name, const std::string& refComp, double x, double y,
                        double w, double h) {
  Node n;
  n.id = id;
  n.name = name;
  Json t = Json::object();
  t.set("__kind", Json::string("comp"));
  t.set("x", Json::number(x));
  t.set("y", Json::number(y));
  t.set("rotation", Json::number(0));
  t.set("scaleX", Json::number(1));
  t.set("scaleY", Json::number(1));
  t.set("anchorX", Json::number(0));
  t.set("anchorY", Json::number(0));
  t.set("width", Json::number(w));
  t.set("height", Json::number(h));
  Json s = Json::object();
  s.set("opacity", Json::number(100));
  s.set("fill", Json::string("#3b8276"));
  Json fx = Json::object();
  fx.set("precomp", Json::boolean(true));
  fx.set("__compRef", Json::string(refComp));
  n.components = {Component{id + "_t", "Transform", std::move(t)}, Component{id + "_s", "Style", std::move(s)},
                  Component{id + "_fx", "fx", std::move(fx)}};
  return n;
}

void place_in_stack(Document& d, const std::string& parent, const std::string& instance, std::size_t slot) {
  std::vector<std::string> order;
  for (const auto& id : sg_child_order(d, parent)) {
    if (id != instance) order.push_back(id);
  }
  order.insert(order.begin() + static_cast<std::ptrdiff_t>(std::min(slot, order.size())), instance);
  (void)sg_set_child_order(d, parent, order);
}

std::vector<std::string> subtree_ids(const Document& d, const std::vector<std::string>& roots) {
  std::vector<std::string> out;
  std::function<void(const std::string&)> walk = [&](const std::string& id) {
    out.push_back(id);
    const Node* n = d.node(id);
    if (n == nullptr) return;
    for (const auto& c : n->children) {
      if (d.node(c) != nullptr) walk(c);
    }
  };
  for (const auto& r : roots) walk(r);
  return out;
}

struct Mint {
  std::string compId;
  std::string instanceId;
  std::string contentId;
};

std::pair<std::string, std::string> move_all_attributes(HCtx& x, const std::vector<std::string>& targets,
                                                        const std::string& hostId, const std::string& name,
                                                        bool adjustDuration, const Mint& mint) {
  Document& d = x.d;
  const Json host = host_settings(d, hostId);
  const std::string front = targets.back();
  const std::string anchorParent = d.node(front)->parent.value_or(hostId);
  const std::set<std::string> moved(targets.begin(), targets.end());
  const std::vector<std::string> orderBefore = sg_child_order(d, anchorParent);
  const auto fit = std::find(orderBefore.begin(), orderBefore.end(), front);
  const std::ptrdiff_t frontIdx = fit == orderBefore.end() ? -1 : fit - orderBefore.begin();
  std::size_t slot = 0;
  for (std::ptrdiff_t i = 0; i < std::max<std::ptrdiff_t>(0, frontIdx); ++i) {
    if (!moved.contains(orderBefore[static_cast<std::size_t>(i)])) ++slot;
  }
  double spanStart = std::numeric_limits<double>::infinity();
  double spanEnd = -std::numeric_limits<double>::infinity();
  if (adjustDuration) {
    for (const auto& id : targets) {
      for (const Bar* b : tl_bars_for_node(d, x.view, id)) {
        spanStart = std::min(spanStart, b->clip.start);
        spanEnd = std::max(spanEnd, b->clip.start + b->clip.duration);
      }
    }
  }
  const bool span = adjustDuration && std::isfinite(spanStart) && spanEnd > spanStart;
  const double fps = host.at("fps").num();
  Json init = Json::object();
  init.set("name", Json::string(name));
  init.set("width", host.at("width"));
  init.set("height", host.at("height"));
  init.set("fps", host.at("fps"));
  init.set("durationSeconds", span ? Json::number((spanEnd - spanStart) / fps) : host.at("durationSeconds"));
  init.set("background", host.at("background"));
  init.set("transparent", host.at("transparent"));
  if (!host.at("pixelAspect").is_undefined()) init.set("pixelAspect", host.at("pixelAspect"));
  add_composition_record(d, mint.compId, init);
  const std::string compId = mint.compId;

  // transferClips(subtreeIds(targets), compId), grouped by owning timeline.
  std::vector<std::pair<std::string, std::vector<std::string>>> byOwner;
  for (const auto& id : subtree_ids(d, targets)) {
    const std::string owner = tl_comp_id_for_node(d, x.view, id);
    auto it = std::find_if(byOwner.begin(), byOwner.end(), [&](const auto& e) { return e.first == owner; });
    if (it == byOwner.end()) byOwner.emplace_back(owner, std::vector<std::string>{id});
    else it->second.push_back(id);
  }
  for (const auto& [owner, list] : byOwner) tl_transfer_node_clips(d, list, owner, compId);
  const PCtx pc = x.pc();
  for (const auto& id : targets) set_parent_preserving_world(pc, id, compId);

  const double w = host.at("width").num();
  const double h = host.at("height").num();
  Node instance = make_instance_node(mint.instanceId, name, compId, w / 2, h / 2, w, h);
  sg_add_child(d, hostId, std::move(instance));
  if (anchorParent != hostId) set_parent_preserving_world(pc, mint.instanceId, anchorParent);
  place_in_stack(d, anchorParent, mint.instanceId, slot);
  tl_sync_from_scene(d, compId);
  tl_sync_from_scene(d, hostId);
  if (span) {
    if (tl_ensure(d, compId)) {
      Timeline& inner = d.timeline_mut(compId);
      // Timeline.setLayerStart: whole frames, never before frame 0, a locked bar stays.
      for (Bar& b : inner.bars) {
        if (!b.locked) b.clip.start = std::max(0.0, motion::js::round(b.clip.start - spanStart));
      }
    }
    const auto bars = tl_bars_for_node(d, x.view, mint.instanceId);
    if (!bars.empty() && tl_ensure(d, hostId)) {
      const std::string barId = bars[0]->id;
      Timeline& outer = d.timeline_mut(hostId);
      for (Bar& b : outer.bars) {
        if (b.id == barId && !b.locked) b.clip.start = std::max(0.0, motion::js::round(spanStart));
      }
    }
  }
  return {compId, mint.instanceId};
}

std::optional<std::string> leave_unavailable(const Document& d, const std::vector<std::string>& targets) {
  if (targets.size() != 1) return "Only available when a single layer is selected.";
  const Node* node = d.node(targets[0]);
  if (node == nullptr) return "Only available when a single layer is selected.";
  const std::string kind = node->kind();
  const bool splittable = kind == "image" || kind == "video" || kind == "svg" || (kind == "shape" && is_solid_node(*node));
  if (!splittable) return "not splittable";
  const Json& t = transform_props(*node);
  const double w = t.at("width").is_number() ? t.at("width").num() : std::nan("");
  const double h = t.at("height").is_number() ? t.at("height").num() : std::nan("");
  if (!(w > 0 && h > 0)) return "no size";
  if (!node->children.empty()) return "children";
  if (is_3d_enabled(*node)) return "3D";
  for (const char* k : {"puppet", "skeleton", "cornerPin"}) {
    if (!node->fx().at(k).is_undefined()) return "deformer";
  }
  if (read_node_layer_time(*node)) return "time";
  return std::nullopt;
}

bool is_content_track(std::string_view prop) {
  return prop == "fill" || prop.starts_with("fill_") || prop.starts_with("fill.") || prop == "path.points";
}

std::pair<std::string, std::string> leave_all_attributes(HCtx& x, const std::string& layerId, const std::string& hostId,
                                                         const std::string& name, const Mint& mint) {
  Document& d = x.d;
  const Node node = *d.node(layerId);
  const Json host = host_settings(d, hostId);
  const std::string kind = node.kind();
  const Component* transform = node.comp("Transform");
  const Component* style = node.comp("Style");
  const Component* svg = node.comp("svg");
  const Json tp = transform != nullptr ? transform->props : Json::object();
  const Json fxProps = node.fx();
  const double layerW = tp.at("width").num();
  const double layerH = tp.at("height").num();
  const double width = std::max(1.0, motion::js::round(layerW));
  const double height = std::max(1.0, motion::js::round(layerH));
  const double fps = host.at("fps").num();
  const auto sourceFrames = media_source_frames(d, node, fps);
  Json init = Json::object();
  init.set("name", Json::string(name));
  init.set("width", Json::number(width));
  init.set("height", Json::number(height));
  init.set("fps", host.at("fps"));
  init.set("durationSeconds", sourceFrames ? Json::number(*sourceFrames / fps) : host.at("durationSeconds"));
  init.set("background", host.at("background"));
  init.set("transparent", host.at("transparent"));
  add_composition_record(d, mint.compId, init);
  const std::string compId = mint.compId;
  const std::string contentId = mint.contentId;
  auto pick = [](const Json& from, std::initializer_list<const char*> keys) {
    Json out = Json::object();
    for (const char* k : keys) {
      if (!from.at(k).is_undefined()) out.set(k, from.at(k));
    }
    return out;
  };
  const Json contentFx = pick(fxProps, {"solid", "fill", "fills", "sequence", "continuousRasterize"});
  const Json styleProps = style != nullptr ? style->props : Json::object();
  Json ct = Json::object();
  ct.set("__kind", Json::string(kind));
  ct.set("x", Json::number(width / 2));
  ct.set("y", Json::number(height / 2));
  ct.set("rotation", Json::number(0));
  ct.set("scaleX", Json::number(1));
  ct.set("scaleY", Json::number(1));
  ct.set("anchorX", Json::number(0));
  ct.set("anchorY", Json::number(0));
  ct.set("width", Json::number(layerW));
  ct.set("height", Json::number(layerH));
  ct = spread(ct, pick(tp, {"src", "assetId", "audioMuted"}));
  Json cs = Json::object();
  cs.set("opacity", Json::number(100));
  if (!styleProps.at("fill").is_undefined()) cs.set("fill", styleProps.at("fill"));
  Node content;
  content.id = contentId;
  content.name = node.name;
  content.parent = compId;
  content.components = {Component{contentId + "_t", "Transform", std::move(ct)}, Component{contentId + "_s", "Style", std::move(cs)}};
  if (!contentFx.obj().empty()) content.components.push_back(Component{contentId + "_fx", "fx", contentFx});
  // An SVG layer: its markup is scoped to the node holding it, so the content's
  // copy is re-scoped to the content's id (precompose.ts re-sanitises).
  if (svg != nullptr) {
    content.components.push_back(Component{contentId + "_svg", "svg", content_svg_props(svg->props, contentId, layerW, layerH, node.name)});
  }
  sg_add_child(d, compId, std::move(content));

  if (const NodeAnim* a = d.anim(layerId)) {
    const NodeAnim snap = *a;
    for (const auto& [prop, keys] : snap.tracks) {
      if (!is_content_track(prop)) continue;
      anim_set_keyframes(d, contentId, prop, keys);
      anim_remove_track(d, layerId, prop);
    }
    for (const auto& [prop, t] : snap.data) {
      if (!is_content_track(prop)) continue;
      anim_set_data_track(d, contentId, prop, t);
      anim_set_data_track(d, layerId, prop, std::nullopt);
    }
    for (const auto& [prop, e] : snap.exprs) {
      if (!is_content_track(prop)) continue;
      anim_set_expr_state(d, contentId, prop, e);
      anim_set_expr_state(d, layerId, prop, std::nullopt);
    }
  }
  if (transform != nullptr) {
    const std::string tid = transform->id;
    (void)sg_write_prop(d, layerId, tid, "__kind", Json::string("comp"));
    for (const char* k : {"src", "assetId", "audioMuted"}) (void)sg_write_prop(d, layerId, tid, k, Json());
  }
  if (style != nullptr && !styleProps.at("fill").is_undefined()) (void)sg_write_prop(d, layerId, style->id, "fill", Json());
  for (const char* k : {"solid", "fill", "fills", "sequence", "continuousRasterize"}) sg_set_fx(d, layerId, k, Json());
  if (svg != nullptr) (void)sg_remove_component(d, layerId, "svg");
  sg_set_fx(d, layerId, "precomp", Json::boolean(true));
  sg_set_fx(d, layerId, "__compRef", Json::string(compId));
  d.node_mut(layerId).name = name;
  tl_sync_from_scene(d, compId);
  tl_sync_from_scene(d, hostId);
  return {compId, layerId};
}

}  // namespace

ResultOf<api::Precompose> handle(const api::Precompose& c, HCtx& x) {
  Document& d = x.d;
  require_comp(d, c.comp);
  const std::string comp = require_layers_in_one_comp(d, c.layers);
  if (comp != c.comp) fail(ErrorCode::invalid_argument, "the layers are not in that composition");
  const bool leave = c.mode == api::PrecomposeMode::leave_attributes;
  if (leave && c.layers.size() != 1) fail(ErrorCode::invalid_argument, "Leave all attributes needs exactly one layer");
  Mint mint;
  mint.compId = x.mint_id("comp_");
  mint.instanceId = x.mint_id("layer_");
  mint.contentId = x.mint_id("layer_");
  ensure_timeline(d, c.comp);
  x.label = "Pre-compose";
  const std::vector<std::string> targets = precompose_targets(d, x.view, c.layers);
  auto refuse = [&]() {
    fail(ErrorCode::invalid_argument, leave ? "this layer cannot be pre-composed leaving its attributes" : "nothing to pre-compose");
  };
  if (targets.empty()) refuse();
  std::string name = c.name;
  const auto first = name.find_first_not_of(" \t\n\r\f\v");
  name = first == std::string::npos ? std::string() : name.substr(first, name.find_last_not_of(" \t\n\r\f\v") - first + 1);
  if (name.empty()) name = default_precomp_name(d);
  std::pair<std::string, std::string> r;
  if (leave) {
    if (leave_unavailable(d, targets)) refuse();
    r = leave_all_attributes(x, targets[0], c.comp, name, mint);
  } else {
    r = move_all_attributes(x, targets, c.comp, name, c.adjust_duration, mint);
  }
  return api::PrecomposeResult{r.first, r.second};
}

}  // namespace premation::doc
