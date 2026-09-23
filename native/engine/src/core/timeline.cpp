#include "timeline.hpp"

#include <algorithm>
#include <cmath>
#include <set>
#include <unordered_map>
#include <unordered_set>

#include "anim.hpp"
#include "jsmath.hpp"
#include "scene.hpp"

namespace premation::doc {
namespace {

double comp_number(const Json* rec, std::string_view key, double fallback) {
  if (rec == nullptr) return fallback;
  const auto v = rec->number_at(key);
  return v ? *v : fallback;
}

/// `seedBarId(timeline, nodeId)`: `clip:<id>`, then `:<n>` for taken ids.
std::string seed_bar_id(const std::unordered_set<std::string>& ids, const std::string& nodeId) {
  const std::string base = "clip:" + nodeId;
  const auto taken = [&ids](const std::string& id) { return ids.contains(id); };
  if (!taken(base)) return base;
  for (int n = 1;; ++n) {
    std::string c = base + ":" + std::to_string(n);
    if (!taken(c)) return c;
  }
}

std::string seed_bar_id(const Timeline& t, const std::string& nodeId) {
  std::unordered_set<std::string> ids;
  for (const Bar& b : t.bars) ids.insert(b.id);
  return seed_bar_id(ids, nodeId);
}

/// The scene nodes a comp's track mirrors: every descendant, not through groups.
bool is_group_node(const Node& n) {
  for (const auto& c : n.components) {
    const Json* k = c.props.find("__kind");
    if (k != nullptr && k->is_string()) return k->str() == "group";
  }
  return false;
}

void collect_nodes(const Document& d, std::string_view parent, std::vector<const Node*>& out,
                   std::unordered_set<std::string_view>& guard) {
  const Node* p = d.node(parent);
  if (p == nullptr) return;
  for (const auto& cid : p->children) {
    const Node* n = d.node(cid);
    if (n == nullptr) continue;
    out.push_back(n);
    if (!n->children.empty() && !is_group_node(*n) && guard.insert(n->id).second) collect_nodes(d, n->id, out, guard);
  }
}

}  // namespace

std::optional<double> media_source_frames(const Document& d, const Node& n, double fps) {
  const std::string kind = n.kind();
  if (kind == "audio") {
    const Component* a = n.comp("Audio");
    const auto sec = a != nullptr ? a->props.number_at("__duration") : std::nullopt;
    if (sec && *sec > 0) return std::max(1.0, motion::js::round(*sec * fps));
    return std::nullopt;
  }
  if (kind == "image" || kind == "svg") return std::nullopt;
  std::optional<double> durationSec;
  double loopCount = 1;
  if (kind == "comp") {
    const auto ref = read_comp_ref(n);
    if (!ref) return std::nullopt;
    const Json* c = d.comp(*ref);
    if (c == nullptr) return std::nullopt;
    const double dur = comp_number(c, "durationSeconds", 0);
    if (dur > 0) durationSec = dur;
  } else if (kind == "video") {
    std::optional<std::string> assetId;
    for (const auto& c : n.components) {
      const Json& a = c.props.at("assetId");
      if (a.is_string() && !a.str().empty()) assetId = a.str();
      const Json& b = c.props.at("__assetId");
      if (b.is_string() && !b.str().empty()) assetId = b.str();
    }
    if (!assetId) return std::nullopt;
    const Json* asset = find_asset(d, *assetId);
    if (asset == nullptr) return std::nullopt;
    const auto dur = asset->at("metadata").number_at("duration");
    if (dur && *dur > 0) durationSec = dur;
    const auto loops = asset->at("interpret").number_at("loopCount");
    loopCount = loops ? *loops : 1;
  } else {
    return std::nullopt;
  }
  if (!durationSec) return std::nullopt;
  if (loopCount == 0) return std::nullopt;
  return std::max(1.0, motion::js::round(*durationSec * loopCount * fps));
}

bool tl_ensure(Document& d, std::string_view comp) {
  if (d.timeline(comp) != nullptr) return true;
  const Json* rec = d.comp(comp);
  if (rec == nullptr) return false;
  Timeline& t = d.timeline_mut(comp);
  const double fps = comp_number(rec, "fps", 30);
  t.fps = fps;
  t.duration = std::max(1.0, motion::js::round(comp_number(rec, "durationSeconds", 10) * fps));
  t.loop = FrameRange{0, t.duration};
  tl_sync_from_scene(d, comp);
  return true;
}

namespace {

/// A comp's track nodes (`collect_nodes`) and their ids.
struct TrackNodes {
  std::vector<const Node*> nodes;
  std::unordered_set<std::string_view> ids;
};

TrackNodes track_nodes(const Document& d, std::string_view comp) {
  TrackNodes t;
  std::unordered_set<std::string_view> guard;
  collect_nodes(d, comp, t.nodes, guard);
  for (const Node* n : t.nodes) t.ids.insert(n->id);
  return t;
}

bool bar_current(const Document& d, const Bar& b, const Node& n, double fps) {
  return b.name == n.name && b.enabled == n.visible && b.locked == n.locked &&
         (b.clip.sourceDuration || !media_source_frames(d, n, fps));
}

void refresh_bar(const Document& d, Bar& b, const Node& n, double fps) {
  b.name = n.name;
  b.enabled = n.visible;
  b.locked = n.locked;
  if (!b.clip.sourceDuration) {
    if (const auto late = media_source_frames(d, n, fps)) b.clip.sourceDuration = late;
  }
}

Bar new_bar(const Document& d, const Node& n, const Timeline& t, const std::unordered_set<std::string>& taken) {
  const auto src = media_source_frames(d, n, t.fps);
  Bar b;
  b.id = seed_bar_id(taken, n.id);
  b.name = n.name;
  b.sourceId = n.id;
  b.enabled = n.visible;
  b.locked = n.locked;
  b.clip.start = 0;
  b.clip.duration = std::max(0.0, src ? std::min(t.duration, *src) : t.duration);
  b.clip.sourceIn = 0;
  b.clip.sourceDuration = src;
  return b;
}

/// Would the full `syncFromScene` change this timeline? (read-only)
bool full_in_sync(const Document& d, std::string_view comp, const TrackNodes& tn) {
  const Timeline& cur = *d.timeline(comp);
  std::unordered_map<std::string_view, const Node*> byId;
  for (const Node* n : tn.nodes) byId.emplace(n->id, n);
  std::unordered_set<std::string_view> covered;
  for (const Bar& b : cur.bars) {
    if (!b.sourceId) continue;
    const auto it = byId.find(*b.sourceId);
    if (it == byId.end() || !bar_current(d, b, *it->second, cur.fps)) return false;
    covered.insert(*b.sourceId);
  }
  return covered.size() == byId.size();
}

/// TimelineController.syncFromScene(comp): the whole track.
void sync_full(Document& d, std::string_view comp) {
  const TrackNodes tn = track_nodes(d, comp);
  if (full_in_sync(d, comp, tn)) return;
  // Edit in place: timeline_mut copies on write once per transaction.
  Timeline& next = d.timeline_mut(comp);
  // Views into next.bars: it is not resized until the scan is over.
  std::unordered_map<std::string_view, std::vector<std::size_t>> bySource;
  for (std::size_t i = 0; i < next.bars.size(); ++i) {
    if (next.bars[i].sourceId) bySource[*next.bars[i].sourceId].push_back(i);
  }
  std::unordered_set<std::string> barIds;
  for (const Bar& x : next.bars) barIds.insert(x.id);
  std::vector<Bar> added;
  for (const Node* n : tn.nodes) {
    const auto hit = bySource.find(n->id);
    if (hit != bySource.end()) {
      for (const std::size_t i : hit->second) refresh_bar(d, next.bars[i], *n, next.fps);
      continue;
    }
    added.push_back(new_bar(d, *n, next, barIds));
    barIds.insert(added.back().id);
  }
  // New bars follow the existing ones, in track order (as TS appends them).
  std::erase_if(next.bars, [&tn](const Bar& b) { return b.sourceId && !tn.ids.contains(*b.sourceId); });
  for (Bar& b : added) next.bars.push_back(std::move(b));
}

/// The comp whose track shows `n` (collect_nodes' membership: every ancestor
/// below the comp root is a non-group), or nullopt.
std::optional<std::string_view> track_comp_of(const Document& d, const Node& n) {
  const Node* cur = &n;
  for (std::size_t guard = 0; cur->parent && guard < 100000; ++guard) {
    const Node* p = d.node(*cur->parent);
    if (p == nullptr) return std::nullopt;
    if (!p->parent) return std::string_view(p->id);
    if (is_group_node(*p)) return std::nullopt;
    cur = p;
  }
  return std::nullopt;
}

void subtree(const Document& d, const Node& n, std::vector<const Node*>& out, std::unordered_set<std::string_view>& seen) {
  if (!seen.insert(n.id).second) return;
  out.push_back(&n);
  for (const auto& c : n.children) {
    if (const Node* k = d.node(c)) subtree(d, *k, out, seen);
  }
}

}  // namespace

bool tl_in_sync(const Document& d, std::string_view comp) {
  if (d.timeline(comp) == nullptr) return true;
  return full_in_sync(d, comp, track_nodes(d, comp));
}

void tl_sync_from_scene(Document& d, std::string_view comp) {
  const Timeline* t = d.timeline(comp);
  if (t == nullptr) return;
  if (d.tl_all_dirty() || t->bars.empty()) {
    sync_full(d, comp);
    return;
  }
  // Only nodes written since the last reconcile (and what hangs under them)
  // can have stale bars; the result equals the full sync (checked by
  // tests/invariants.hpp `timelines_in_sync` after every stress/fuzz step).
  std::vector<const Node*> touched;
  std::unordered_set<std::string_view> seen;
  std::unordered_set<std::string_view> gone;  // ids no longer on this track
  for (const auto& id : d.tl_touched()) {
    const Node* n = d.node(id);
    if (n == nullptr) {
      gone.insert(id);
      continue;
    }
    if (!n->parent) continue;  // a comp root: child ORDER does not move bars
    subtree(d, *n, touched, seen);
  }
  std::vector<const Node*> members;
  for (const Node* n : touched) {
    const auto c = track_comp_of(d, *n);
    if (c && *c == comp) members.push_back(n);
    else gone.insert(n->id);
  }
  // Read-only first: what would change?
  std::unordered_map<std::string_view, std::vector<std::size_t>> bySource;
  for (std::size_t i = 0; i < t->bars.size(); ++i) {
    if (t->bars[i].sourceId) bySource[*t->bars[i].sourceId].push_back(i);
  }
  bool dirty = false;
  std::size_t fresh = 0;
  for (const Node* n : members) {
    const auto hit = bySource.find(n->id);
    if (hit == bySource.end()) {
      ++fresh;
      dirty = true;
      continue;
    }
    for (const std::size_t i : hit->second) {
      if (!bar_current(d, t->bars[i], *n, t->fps)) dirty = true;
    }
  }
  for (const auto& id : gone) {
    if (bySource.contains(id)) dirty = true;
  }
  if (!dirty) return;
  // Several new bars: their order is the track order — the full sync knows it.
  if (fresh > 1) {
    sync_full(d, comp);
    return;
  }
  Timeline& next = d.timeline_mut(comp);
  std::optional<Bar> added;
  for (const Node* n : members) {
    bool any = false;
    for (Bar& b : next.bars) {
      if (!b.sourceId || *b.sourceId != n->id) continue;
      any = true;
      refresh_bar(d, b, *n, next.fps);
    }
    if (!any) {
      std::unordered_set<std::string> barIds;
      for (const Bar& x : next.bars) barIds.insert(x.id);
      added = new_bar(d, *n, next, barIds);
    }
  }
  std::erase_if(next.bars, [&gone](const Bar& b) { return b.sourceId && gone.contains(*b.sourceId); });
  if (added) next.bars.push_back(std::move(*added));
}

void tl_sync_all(Document& d) {
  if (!d.tl_all_dirty() && d.tl_touched().empty()) return;
  for (const auto& id : d.timelines().keys()) tl_sync_from_scene(d, id);
  d.tl_mark_clean();
}

std::string tl_owner_comp(const Document& d, const EditorView& v, std::string_view node) {
  const Node* n = d.node(node);
  if (n != nullptr && n->parent && d.timeline(*n->parent) != nullptr) return *n->parent;
  return v.tabComp;
}

namespace {

/// TlReadScope's state: the depth, and per timeline VERSION (entities are
/// immutable while a read scope is open) its bars grouped by source id.
struct BarIndex {
  int depth = 0;
  std::unordered_map<const Timeline*, std::unordered_map<std::string, std::vector<const Bar*>>> byTimeline;
};
thread_local BarIndex g_barIndex;

const std::unordered_map<std::string, std::vector<const Bar*>>& bar_index_of(const Timeline& t) {
  auto [it, fresh] = g_barIndex.byTimeline.try_emplace(&t);
  if (fresh) {
    for (const Bar& b : t.bars) {
      if (b.sourceId) it->second[*b.sourceId].push_back(&b);
    }
    for (auto& [id, list] : it->second) {
      std::stable_sort(list.begin(), list.end(), [](const Bar* a, const Bar* b) { return a->clip.start < b->clip.start; });
    }
  }
  return it->second;
}

}  // namespace

TlReadScope::TlReadScope() { ++g_barIndex.depth; }
TlReadScope::~TlReadScope() {
  if (--g_barIndex.depth == 0) g_barIndex.byTimeline.clear();
}

std::vector<const Bar*> tl_bars_for_node(const Document& d, const EditorView& v, std::string_view node) {
  std::vector<const Bar*> out;
  const Timeline* t = d.timeline(tl_owner_comp(d, v, node));
  if (t == nullptr) return out;
  if (g_barIndex.depth > 0) {
    const auto& idx = bar_index_of(*t);
    const auto it = idx.find(std::string(node));
    if (it != idx.end()) out = it->second;
    return out;
  }
  for (const Bar& b : t->bars) {
    if (b.sourceId && *b.sourceId == node) out.push_back(&b);
  }
  std::stable_sort(out.begin(), out.end(), [](const Bar* a, const Bar* b) { return a->clip.start < b->clip.start; });
  return out;
}

double tl_fps_for_node(const Document& d, const EditorView& v, std::string_view node) {
  const Timeline* t = d.timeline(tl_owner_comp(d, v, node));
  return t != nullptr ? t->fps : 30;
}

double tl_duration_for_node(const Document& d, const EditorView& v, std::string_view node) {
  const Timeline* t = d.timeline(tl_owner_comp(d, v, node));
  return t != nullptr ? t->duration : 300;
}

std::vector<const Bar*> bars_of(const Document& d, std::string_view layer, std::string_view comp) {
  std::vector<const Bar*> out;
  const Timeline* t = d.timeline(comp);
  if (t == nullptr) return out;
  for (const Bar& b : t->bars) {
    if (b.sourceId && *b.sourceId == layer) out.push_back(&b);
  }
  std::stable_sort(out.begin(), out.end(), [](const Bar* a, const Bar* b) { return a->clip.start < b->clip.start; });
  return out;
}

std::vector<Geo> geoms_of(const Document& d, std::string_view layer, std::string_view comp) {
  std::vector<Geo> out;
  for (const Bar* b : bars_of(d, layer, comp)) out.push_back(b->clip);
  return out;
}

void write_geoms(Document& d, std::string_view comp, std::string_view layer, const std::vector<Geo>& want) {
  tl_sync_all(d);
  if (!tl_ensure(d, comp)) return;
  const Timeline& cur = *d.timeline(comp);
  Timeline next = cur;
  std::vector<std::size_t> have;
  for (std::size_t i = 0; i < next.bars.size(); ++i) {
    if (next.bars[i].sourceId && *next.bars[i].sourceId == layer) have.push_back(i);
  }
  std::stable_sort(have.begin(), have.end(),
                   [&next](std::size_t a, std::size_t b) { return next.bars[a].clip.start < next.bars[b].clip.start; });
  const std::size_t shared = std::min(have.size(), want.size());
  for (std::size_t i = 0; i < shared; ++i) {
    Clip g = want[i];
    g.duration = std::max(0.0, g.duration);
    next.bars[have[i]].clip = g;
  }
  if (want.size() < have.size()) {
    std::set<std::size_t> drop(have.begin() + static_cast<std::ptrdiff_t>(want.size()), have.end());
    std::vector<Bar> kept;
    for (std::size_t i = 0; i < next.bars.size(); ++i) {
      if (!drop.contains(i)) kept.push_back(std::move(next.bars[i]));
    }
    next.bars = std::move(kept);
  } else if (want.size() > have.size()) {
    const Node* n = d.node(layer);
    if (n != nullptr) {
      for (std::size_t i = have.size(); i < want.size(); ++i) {
        Bar b;
        b.id = seed_bar_id(next, std::string(layer));
        b.name = n->name;
        b.sourceId = std::string(layer);
        b.enabled = n->visible;
        b.locked = n->locked;
        b.clip = want[i];
        b.clip.duration = std::max(0.0, b.clip.duration);
        next.bars.push_back(std::move(b));
      }
    }
  }
  if (!(next == cur)) d.timeline_mut(comp) = std::move(next);
}

// ── layerTime.ts ─────────────────────────────────────────────────────────

LayerTime normalize_layer_time(const Json& v) {
  LayerTime t;
  const auto stretch = v.number_at("stretch");
  t.stretch = stretch && std::isfinite(*stretch) ? std::max(1.0, std::min(1000.0, *stretch)) : 100;
  t.reverse = v.bool_at("reverse").value_or(false);
  t.freeze = v.bool_at("freeze").value_or(false);
  const auto ft = v.number_at("freezeTime");
  t.freezeTime = ft && std::isfinite(*ft) ? *ft : 0;
  const auto fb = v.string_at("frameBlend");
  t.frameBlend = fb && (*fb == "mix" || *fb == "pixelMotion") ? *fb : "none";
  return t;
}

bool is_identity_time(const LayerTime& t) noexcept { return !t.freeze && !t.reverse && t.stretch == 100; }

std::optional<LayerTime> read_node_layer_time(const Node& n) {
  const Component* fx = n.comp("fx");
  if (fx == nullptr || fx->props.at("time").is_undefined()) return std::nullopt;
  const LayerTime cfg = normalize_layer_time(fx->props.at("time"));
  if (is_identity_time(cfg) && cfg.frameBlend == "none") return std::nullopt;
  return cfg;
}

LayerTime get_node_layer_time(const Node& n) {
  const Component* fx = n.comp("fx");
  if (fx != nullptr && !fx->props.at("time").is_undefined()) return normalize_layer_time(fx->props.at("time"));
  return LayerTime{};
}

Json layer_time_json(const LayerTime& t) {
  Json o = Json::object();
  o.set("stretch", Json::number(t.stretch));
  o.set("reverse", Json::boolean(t.reverse));
  o.set("freeze", Json::boolean(t.freeze));
  o.set("freezeTime", Json::number(t.freezeTime));
  o.set("frameBlend", Json::string(t.frameBlend));
  return o;
}

double remap_time(double t, const LayerTime& cfg, double spanStart, double spanEnd) {
  if (cfg.freeze) return cfg.freezeTime;
  const double stretch = cfg.stretch > 0 ? cfg.stretch : 100;
  double s = spanStart + (t - spanStart) * (100 / stretch);
  if (cfg.reverse) s = spanStart + spanEnd - s;
  return s;
}

// ── the keyframe axis ────────────────────────────────────────────────────

double comp_to_keyframe_time(const Document& d, const EditorView& v, std::string_view node, double compTime,
                             std::string_view prop) {
  // Responsive time (templates) and animated precomp-ancestor remaps: neither
  // exists in documents the engine API builds (no template comps; precomp
  // COMPOSITIONS are separate roots, not ancestor groups).
  const double fps = tl_fps_for_node(d, v, node);
  double time = compTime;
  if (prop == "timeRemap" || prop == "precompTime") return time;
  const double frame = motion::js::round(time * fps);
  // Governing clips: the node's own, else an enclosing plain GROUP's.
  std::vector<const Bar*> clips = tl_bars_for_node(d, v, node);
  if (clips.empty()) {
    const Node* n = d.node(node);
    for (int depth = 0; depth < 32 && n != nullptr; ++depth) {
      if (!n->parent) break;
      const Node* parent = d.node(*n->parent);
      if (parent == nullptr) break;
      if (is_precomp(*parent) || parent->kind() != "group") break;
      clips = tl_bars_for_node(d, v, parent->id);
      if (!clips.empty()) break;
      n = parent;
    }
  }
  for (const Bar* b : clips) {
    if (b->active_at(frame)) {
      time = b->clip.source_frame_at(frame) / fps;
      break;
    }
  }
  const Node* n = d.node(node);
  if (n != nullptr) {
    if (const auto cfg = read_node_layer_time(*n)) {
      const auto span = anim_time_span(d, node);
      time = remap_time(time, *cfg, span ? span->start : 0, span ? span->end : 1);
    }
  }
  return time;
}

double keyframe_to_comp_time(const Document& d, const EditorView& v, std::string_view node, double keyTime,
                             std::string_view prop) {
  const double fps = tl_fps_for_node(d, v, node);
  if (prop == "timeRemap" || prop == "precompTime") return keyTime;
  double t = keyTime;
  const Node* n = d.node(node);
  if (n != nullptr) {
    const auto cfg = read_node_layer_time(*n);
    if (cfg && !cfg->freeze) {
      const auto sp = anim_time_span(d, node);
      const double start = sp ? sp->start : 0;
      const double end = sp ? sp->end : 1;
      const double stretch = cfg->stretch > 0 ? cfg->stretch : 100;
      double s = t;
      if (cfg->reverse) s = start + end - s;
      t = start + (s - start) * (stretch / 100);
    }
  }
  std::vector<const Bar*> clips = tl_bars_for_node(d, v, node);
  if (clips.empty() && n != nullptr) {
    const Node* cur = n;
    for (int depth = 0; depth < 32 && cur != nullptr; ++depth) {
      if (!cur->parent) break;
      const Node* parent = d.node(*cur->parent);
      if (parent == nullptr) break;
      if (is_precomp(*parent) || parent->kind() != "group") break;
      clips = tl_bars_for_node(d, v, parent->id);
      if (!clips.empty()) break;
      cur = parent;
    }
  }
  if (!clips.empty()) {
    const double sourceFrame = motion::js::round(t * fps);
    std::optional<double> best;
    double bestDist = std::numeric_limits<double>::infinity();
    for (const Bar* l : clips) {
      const double compFrame = l->clip.start + (sourceFrame - l->clip.sourceIn);
      if (l->active_at(compFrame)) {
        best = compFrame;
        break;
      }
      const double clamped = std::max(l->clip.start, std::min(l->clip.end() - 1, compFrame));
      const double dist = std::fabs(compFrame - clamped);
      if (dist < bestDist) {
        bestDist = dist;
        best = clamped;
      }
    }
    if (best) t = *best / fps;
  }
  return t;
}

// ── markers / timeline ops ───────────────────────────────────────────────

void markers_insert(std::vector<TMarker>& list, TMarker m) {
  const auto it = std::lower_bound(list.begin(), list.end(), m.frame,
                                   [](const TMarker& x, double f) { return x.frame < f; });
  list.insert(it, std::move(m));
}

void markers_reindex(std::vector<TMarker>& list) {
  std::stable_sort(list.begin(), list.end(), [](const TMarker& a, const TMarker& b) { return a.frame < b.frame; });
}

void tl_set_frame_rate(Timeline& t, double fps) {
  if (fps == t.fps) return;
  const double from = t.fps;
  const auto conv = [from, fps](double f) { return (f / from) * fps; };
  for (Bar& b : t.bars) {
    b.clip.start = conv(b.clip.start);
    b.clip.duration = conv(b.clip.duration);
    b.clip.sourceIn = conv(b.clip.sourceIn);
    if (b.clip.sourceDuration) b.clip.sourceDuration = conv(*b.clip.sourceDuration);
    for (TMarker& m : b.markers) m.frame = conv(m.frame);
    markers_reindex(b.markers);
  }
  for (TMarker& m : t.markers) m.frame = conv(m.frame);
  markers_reindex(t.markers);
  t.duration = motion::js::round(conv(t.duration));
  if (t.loop) t.loop = FrameRange{conv(t.loop->start), conv(t.loop->duration)};
  if (t.workArea) t.workArea = FrameRange{conv(t.workArea->start), conv(t.workArea->duration)};
  t.fps = fps;
}

void tl_set_duration(Timeline& t, double frames) {
  const double next = std::max(0.0, motion::js::round(frames));
  t.duration = next;
}

std::string tl_comp_id_for_node(const Document& d, const EditorView& v, std::string_view node) {
  const Node* n = d.node(node);
  if (n != nullptr && n->parent && d.timeline(*n->parent) != nullptr) return *n->parent;
  return v.tabComp;
}

void tl_transfer_node_clips(Document& d, const std::vector<std::string>& nodeIds, std::string_view from,
                            std::string_view to) {
  const Timeline* src = d.timeline(from);
  if (src == nullptr) return;
  if (d.timeline(to) == nullptr && !tl_ensure(d, to)) return;
  const std::set<std::string, std::less<>> wanted(nodeIds.begin(), nodeIds.end());
  std::vector<Bar> moving;
  for (const Bar& b : src->bars) {
    if (b.sourceId && wanted.contains(*b.sourceId)) moving.push_back(b);
  }
  if (moving.empty()) return;
  {
    Timeline& dst = d.timeline_mut(to);
    std::erase_if(dst.bars, [&](const Bar& b) { return b.sourceId && wanted.contains(*b.sourceId); });
    for (Bar b : moving) {
      b.id = seed_bar_id(dst, *b.sourceId);
      for (TMarker& m : b.markers) m.ownerId = b.id;
      dst.bars.push_back(std::move(b));
    }
  }
  Timeline& s = d.timeline_mut(from);
  std::erase_if(s.bars, [&](const Bar& b) { return b.sourceId && wanted.contains(*b.sourceId); });
}

}  // namespace premation::doc
