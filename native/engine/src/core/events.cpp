#include "events.hpp"

#include <algorithm>
#include <iterator>
#include <cmath>
#include <limits>
#include <set>
#include <type_traits>
#include <variant>

#include "fail.hpp"
#include "readmodel.hpp"
#include "scene.hpp"
#include "variant_util.hpp"

namespace premation::doc {
namespace {

/// events.ts compares JSON.stringify(info): NaN and null print alike, so a
/// NaN value is "the same" as the NaN it was (C++ == says NaN != NaN).
bool same_info(const api::PropertyInfo& a, const api::PropertyInfo& b) {
  if (a == b) return true;
  api::PropertyInfo x = a;
  api::PropertyInfo y = b;
  for (api::PropertyInfo* i : {&x, &y}) {
    if (!i->value) continue;
    std::visit(
        [](auto& v) {
          using T = std::decay_t<decltype(v)>;
          const auto z = [](double& d) {
            if (std::isnan(d)) d = std::numeric_limits<double>::lowest();
          };
          if constexpr (std::is_same_v<T, double>) z(v);
          else if constexpr (std::is_same_v<T, api::Vec2>) { z(v.x); z(v.y); }
          else if constexpr (std::is_same_v<T, api::Vec3>) { z(v.x); z(v.y); z(v.z); }
          else if constexpr (std::is_same_v<T, api::Vec4>) { z(v.x); z(v.y); z(v.z); z(v.w); }
          else if constexpr (std::is_same_v<T, api::Color>) { z(v.r); z(v.g); z(v.b); z(v.a); }
        },
        i->value->v);
  }
  return x == y;
}

/// A timeline's clip geometry per node (captureClipGeometry: bars grouped by sourceId, track order).
std::map<std::string, std::vector<Clip>> geometry_of(const Timeline* t) {
  std::map<std::string, std::vector<Clip>> out;
  if (t == nullptr) return out;
  for (const Bar& b : t->bars) {
    if (b.sourceId) out[*b.sourceId].push_back(b.clip);
  }
  return out;
}

std::map<std::string, std::vector<TMarker>> layer_markers_of(const Timeline* t) {
  std::map<std::string, std::vector<TMarker>> out;
  if (t == nullptr) return out;
  for (const Bar& b : t->bars) {
    if (!b.markers.empty()) out[b.id] = b.markers;
  }
  return out;
}

/// The TS `tl:<comp>` part changed: rate, duration, ranges, comp markers, layer markers, bar order.
bool timeline_facts_differ(const Timeline* a, const Timeline* b) {
  if ((a == nullptr) != (b == nullptr)) return true;
  if (a == nullptr) return false;
  if (a->fps != b->fps || a->duration != b->duration || !(a->workArea == b->workArea) || !(a->loop == b->loop) ||
      !(a->markers == b->markers)) {
    return true;
  }
  if (layer_markers_of(a) != layer_markers_of(b)) return true;
  if (a->bars.size() != b->bars.size()) return true;
  for (std::size_t i = 0; i < a->bars.size(); ++i) {
    if (a->bars[i].id != b->bars[i].id) return true;
  }
  return false;
}

/// Node id of a bar id `clip:<node>` / `clip:<node>:<n>`.
std::optional<std::string> node_of_bar(const std::string& bar) {
  if (!bar.starts_with("clip:")) return std::nullopt;
  std::string rest = bar.substr(5);
  const std::size_t colon = rest.rfind(':');
  if (colon != std::string::npos) {
    bool digits = colon + 1 < rest.size();
    for (std::size_t i = colon + 1; i < rest.size(); ++i) {
      if (rest[i] < '0' || rest[i] > '9') digits = false;
    }
    if (digits) rest.resize(colon);
  }
  return rest;
}

}  // namespace

std::vector<api::Event> EventBuilder::build(const ChangeSet& changes, const PCtx& c) {
  const Document& d = c.d;
  const Parts& before = changes.before;
  const Parts& after = changes.after;
  std::vector<api::Event> events;
  std::vector<std::string> touched;  // insertion-ordered set
  auto touch = [&](const std::string& id) {
    if (std::find(touched.begin(), touched.end(), id) == touched.end()) touched.push_back(id);
  };
  std::vector<std::pair<std::string, std::vector<std::string>>> removedByComp;
  std::vector<std::string> orderComps;
  auto add_order = [&](const std::string& comp) {
    if (std::find(orderComps.begin(), orderComps.end(), comp) == orderComps.end()) orderComps.push_back(comp);
  };
  std::vector<std::string> compsChanged;
  auto add_comp = [&](const std::string& comp) {
    if (std::find(compsChanged.begin(), compsChanged.end(), comp) == compsChanged.end()) compsChanged.push_back(comp);
  };
  std::vector<std::string> markerComps;
  bool itemsDirty = false;
  const bool projectDirty = before.project.has_value();
  const bool rqDirty = before.rq.has_value();
  const bool allComps = before.mb.has_value();
  std::set<std::string> geometryComps;  // a TS `clips:<comp>` changed
  std::set<std::string> factComps;      // a TS `tl:<comp>` changed

  auto before_node = [&](const std::string& id) -> const Node* {
    const auto it = before.nodes.find(id);
    return it != before.nodes.end() ? it->second.get() : nullptr;
  };
  auto comp_of_removed = [&](const std::string& id) -> std::optional<std::string> {
    const Node* cur = before_node(id);
    std::set<std::string> seen;
    while (cur != nullptr && cur->parent && !seen.contains(cur->id)) {
      seen.insert(cur->id);
      const std::string p = *cur->parent;
      if (is_comp_item(d, p) || before.comps.contains(p)) return p;
      const Node* live = d.node(p);
      cur = live != nullptr ? live : before_node(p);
    }
    return std::nullopt;
  };

  for (const auto& [id, bptr] : before.nodes) {
    const Node* live = d.node(id);
    if (live != nullptr && !live->parent) {
      if (is_comp_item(d, id)) add_order(id);
      continue;
    }
    if (live != nullptr) {
      touch(id);
      const Node* b = bptr.get();
      const auto comp = comp_of_layer(d, id);
      if (comp && (b == nullptr || b->parent != live->parent || b->children != live->children)) add_order(*comp);
      if (b == nullptr && comp) add_order(*comp);
    } else if (bptr) {
      if (const auto comp = comp_of_removed(id)) {
        auto it = std::find_if(removedByComp.begin(), removedByComp.end(), [&](const auto& e) { return e.first == *comp; });
        if (it == removedByComp.end()) {
          removedByComp.emplace_back(*comp, std::vector<std::string>{});
          it = std::prev(removedByComp.end());
        }
        it->second.push_back(id);
        add_order(*comp);
      }
      forget(id);
    }
  }
  for (const auto& [id, v] : before.anims) {
    const Node* live = d.node(id);
    if (live != nullptr && live->parent) touch(id);
  }
  for (const auto& [comp, bptr] : before.timelines) {
    const auto ait = after.timelines.find(comp);
    const Timeline* bt = bptr.get();
    const Timeline* at = ait != after.timelines.end() ? ait->second.get() : nullptr;
    // clips:<comp>
    const auto bg = geometry_of(bt);
    const auto ag = geometry_of(at);
    std::set<std::string> nodes;
    for (const auto& [k, v] : bg) nodes.insert(k);
    for (const auto& [k, v] : ag) nodes.insert(k);
    bool geomChanged = false;
    for (const auto& nodeId : nodes) {
      const auto x = bg.find(nodeId);
      const auto y = ag.find(nodeId);
      const bool same = (x == bg.end()) == (y == ag.end()) && (x == bg.end() || x->second == y->second);
      if (same) continue;
      geomChanged = true;
      const Node* live = d.node(nodeId);
      if (live != nullptr && live->parent) {
        touch(nodeId);
        drop_keys(nodeId);  // comp times of its keys moved with the bar
      }
    }
    if (geomChanged) geometryComps.insert(comp);
    // tl:<comp>
    if (!timeline_facts_differ(bt, at)) continue;
    factComps.insert(comp);
    if (is_comp_item(d, comp)) add_comp(comp);
    const std::vector<TMarker> none;
    if (!((bt != nullptr ? bt->markers : none) == (at != nullptr ? at->markers : none))) {
      if (std::find(markerComps.begin(), markerComps.end(), comp) == markerComps.end()) markerComps.push_back(comp);
    }
    const auto bl = layer_markers_of(bt);
    const auto al = layer_markers_of(at);
    std::set<std::string> bars;
    for (const auto& [k, v] : bl) bars.insert(k);
    for (const auto& [k, v] : al) bars.insert(k);
    for (const auto& bar : bars) {
      const auto x = bl.find(bar);
      const auto y = al.find(bar);
      if ((x == bl.end()) == (y == al.end()) && (x == bl.end() || x->second == y->second)) continue;
      const auto nodeId = node_of_bar(bar);
      if (!nodeId) continue;
      const Node* live = d.node(*nodeId);
      if (live != nullptr && live->parent) touch(*nodeId);
    }
  }
  for (const auto& [id, v] : before.comps) {
    if (is_comp_item(d, id)) add_comp(id);
    itemsDirty = true;
  }
  if (before.items) itemsDirty = true;

  // Items (compositions, footage, folders).
  if (itemsDirty) {
    std::vector<std::pair<std::string, api::ItemInfo>> beforeItems;
    std::vector<std::pair<std::string, api::ItemInfo>> afterItems;
    auto put = [](std::vector<std::pair<std::string, api::ItemInfo>>& list, const std::string& id, api::ItemInfo info) {
      for (auto& e : list) {
        if (e.first == id) {
          e.second = std::move(info);
          return;
        }
      }
      list.emplace_back(id, std::move(info));
    };
    if (before.items && *before.items) {
      for (const Folder& f : (*before.items)->folders) put(beforeItems, f.id, folder_info(f));
      for (const Json& a : (*before.items)->assets) put(beforeItems, a.at("id").str(), footage_info(a));
    }
    for (const auto& [id, v] : before.comps) {
      if (v) {
        api::ItemInfo stub;
        stub.id = id;
        stub.name = "\x01stub";  // never equal to a real record (TS compares `{id}` to the full info)
        put(beforeItems, id, stub);
      }
    }
    if (after.items && *after.items) {
      for (const Folder& f : (*after.items)->folders) put(afterItems, f.id, folder_info(f));
      for (const Json& a : (*after.items)->assets) put(afterItems, a.at("id").str(), footage_info(a));
    }
    for (const auto& [id, v] : before.comps) {
      if (is_comp_item(d, id)) put(afterItems, id, comp_item_info(d, id));
    }
    std::vector<api::ItemInfo> upserts;
    std::vector<std::string> removed;
    for (const auto& [id, info] : afterItems) {
      const auto prev = std::find_if(beforeItems.begin(), beforeItems.end(), [&](const auto& e) { return e.first == id; });
      if (prev == beforeItems.end() || !(prev->second == info)) upserts.push_back(info);
    }
    for (const auto& [id, info] : beforeItems) {
      const bool inAfter = std::any_of(afterItems.begin(), afterItems.end(), [&](const auto& e) { return e.first == id; });
      if (!inAfter && !is_comp_item(d, id)) removed.push_back(id);
    }
    for (const auto& [id, v] : before.comps) {
      if (v && !is_comp_item(d, id) && std::find(removed.begin(), removed.end(), id) == removed.end()) removed.push_back(id);
    }
    if (!upserts.empty()) events.push_back(make_event(api::ItemsChangedEvent{std::move(upserts)}));
    if (!removed.empty()) events.push_back(make_event(api::ItemsRemovedEvent{std::move(removed)}));
  }

  if (projectDirty) events.push_back(make_event(api::ProjectSettingsChangedEvent{d.project()}));

  if (allComps) {
    for (const auto& [id, np] : d.nodes()) {
      if (!np->parent && is_comp_item(d, id)) add_comp(id);
    }
  }
  for (const auto& comp : compsChanged) {
    if (is_comp_item(d, comp)) events.push_back(make_event(api::CompositionChangedEvent{comp, comp_settings(d, comp)}));
  }
  for (auto& [comp, layers] : removedByComp) events.push_back(make_event(api::LayersRemovedEvent{comp, layers}));

  std::vector<std::string> headerIds;
  for (const auto& id : touched) {
    const Node* n = d.node(id);
    if (n != nullptr && n->parent) headerIds.push_back(id);
  }
  if (!headerIds.empty()) {
    api::LayersChangedEvent e;
    for (const auto& id : headerIds) e.layers.push_back(layer_info(d, id));
    events.push_back(make_event(std::move(e)));
  }
  for (const auto& comp : orderComps) {
    if (is_comp_item(d, comp)) events.push_back(make_event(api::LayerOrderChangedEvent{comp, layer_ids_of_comp(d, comp)}));
  }
  std::vector<api::KeyframeSet> keyframeSetsOut;
  for (const auto& id : headerIds) {
    layer_properties(c, id, events);
    layer_keyframes(c, id, keyframeSetsOut);
  }
  if (!keyframeSetsOut.empty()) events.push_back(make_event(api::KeyframesChangedEvent{std::move(keyframeSetsOut)}));

  for (const auto& comp : markerComps) {
    if (is_comp_item(d, comp)) {
      events.push_back(make_event(api::MarkersChangedEvent{api::MarkerOwner{comp, std::nullopt}, comp_markers(d, comp)}));
    }
  }
  for (const auto& id : headerIds) {
    const auto comp = comp_of_layer(d, id);
    if (!comp) continue;
    if (factComps.contains(*comp) || geometryComps.contains(*comp)) {
      events.push_back(make_event(api::MarkersChangedEvent{api::MarkerOwner{*comp, id}, layer_markers(d, id)}));
    }
  }
  if (rqDirty) events.push_back(make_event(api::RenderQueueChangedEvent{d.render_queue()}));
  // B3z: the transition records (events.ts `tx`): every comp whose list changed, sorted.
  if (before.tx && after.tx && *before.tx && *after.tx) {
    const Json& b = **before.tx;
    const Json& a = **after.tx;
    std::set<std::string> comps;
    if (b.is_object()) {
      for (const auto& m : b.obj()) comps.insert(m.key);
    }
    if (a.is_object()) {
      for (const auto& m : a.obj()) comps.insert(m.key);
    }
    const auto listOf = [](const Json& v) { return v.is_undefined() || v.is_null() ? std::string("[]") : stringify(v); };
    for (const auto& comp : comps) {
      if (listOf(b.at(comp)) == listOf(a.at(comp))) continue;
      if (is_comp_item(d, comp)) events.push_back(make_event(api::TransitionsChangedEvent{comp, transitions_of(d, comp)}));
    }
  }
  return events;
}

void EventBuilder::layer_properties(const PCtx& c, const std::string& layer, std::vector<api::Event>& events) {
  Catalog cat;
  try {
    cat = catalog_for(c.d, layer);
  } catch (const EngineFail&) {
    return;
  }
  const bool known = props_.contains(layer);
  PropCache cache = known ? props_[layer] : PropCache{};
  std::vector<api::PropertyInfo> changedInfos;
  std::set<std::string> seenProps;
  for (const PropBinding& b : cat.props) {
    api::PropertyInfo info = property_info(c, layer, cat, b);
    seenProps.insert(b.path);
    const auto it = cache.infos.find(b.path);
    if (it == cache.infos.end() || !same_info(it->second, info)) {
      cache.infos.insert_or_assign(b.path, info);
      changedInfos.push_back(std::move(info));
    }
  }
  std::vector<std::pair<std::string, std::vector<std::string>>> parents;
  parents.emplace_back("", cat.roots);
  for (const auto& [path, g] : cat.groups) parents.emplace_back(path, g.children);
  std::set<std::string> seenGroups;
  for (const auto& [parent, children] : parents) {
    const std::string key = "#children:" + parent;
    std::string sig;
    for (const auto& ch : children) sig += ch + "\x1f";
    const GroupBinding* g = parent.empty() ? nullptr : cat.groups.find(parent);
    sig += (g == nullptr || g->enabled) ? "|1|" : "|0|";
    sig += g != nullptr ? g->name : "";
    seenGroups.insert(key);
    const auto it = cache.groups.find(key);
    if (it != cache.groups.end() && it->second == sig) continue;
    const bool hadBefore = it != cache.groups.end();
    cache.groups.insert_or_assign(key, sig);
    if (!hadBefore && !parent.empty() && !known) continue;
    api::PropertyGroupsChangedEvent e;
    e.layer = layer;
    e.parent = parent;
    for (const auto& ch : children) {
      if (cat.groups.contains(ch)) e.children.push_back(group_info(cat, ch));
      else if (const PropBinding* b = cat.find(ch)) e.children.push_back(property_info(c, layer, cat, *b));
    }
    events.push_back(make_event(std::move(e)));
  }
  std::erase_if(cache.infos, [&](const auto& e) { return !seenProps.contains(e.first); });
  std::erase_if(cache.groups, [&](const auto& e) { return !seenGroups.contains(e.first); });
  props_.insert_or_assign(layer, std::move(cache));
  if (!changedInfos.empty()) events.push_back(make_event(api::PropertiesChangedEvent{layer, std::move(changedInfos)}));
}

void EventBuilder::layer_keyframes(const PCtx& c, const std::string& layer, std::vector<api::KeyframeSet>& out) {
  std::vector<api::KeyframeSet> sets;
  try {
    const Catalog cat = catalog_for(c.d, layer);
    sets = keyframe_sets(c, layer, cat);
  } catch (const EngineFail&) {
    return;
  }
  auto& cache = keys_[layer];
  std::set<std::string> live;
  for (auto& s : sets) {
    live.insert(s.prop.path);
    const auto it = cache.find(s.prop.path);
    if (it == cache.end() || !(it->second == s.keyframes)) {
      cache.insert_or_assign(s.prop.path, s.keyframes);
      out.push_back(std::move(s));
    }
  }
  for (auto it = cache.begin(); it != cache.end();) {
    if (live.contains(it->first)) {
      ++it;
      continue;
    }
    out.push_back(api::KeyframeSet{api::PropRef{layer, it->first}, {}});
    it = cache.erase(it);
  }
  // Reported before the cache row was dropped and not animated now: empty too.
  if (const auto d = dropped_.find(layer); d != dropped_.end()) {
    for (const auto& path : d->second) {
      if (!live.contains(path)) out.push_back(api::KeyframeSet{api::PropRef{layer, path}, {}});
    }
    dropped_.erase(d);
  }
}

}  // namespace premation::doc
