#include "handlers_layertime.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <optional>
#include <set>
#include <utility>

#include "anim.hpp"
#include "anim_json.hpp"
#include "catalog_data.hpp"
#include "fxstate.hpp"
#include "jsmath.hpp"
#include "scene.hpp"
#include "layer_clone.hpp"
#include "parenting.hpp"
#include "readmodel.hpp"
#include "time_conv.hpp"

namespace premation::doc {

using api::ErrorCode;

namespace {

constexpr std::string_view kSpeedProp = "timeSpeed";
constexpr std::string_view kRemapProp = "timeRemap";
constexpr std::string_view kLegacyRemapProp = "precompTime";
constexpr std::array<std::string_view, 3> kRetimeProps = {kSpeedProp, kRemapProp, kLegacyRemapProp};

// ── bar geometry (layerTime.ts) ─────────────────────────────────────────────

struct Span {
  double in = 0;
  double out = 0;
};

Span span(const std::vector<Geo>& g) { return Span{g.front().start, g.back().start + g.back().duration}; }

std::vector<Geo> bars_or_fail(const Document& d, const std::string& layer, std::string_view comp) {
  std::vector<Geo> g = geoms_of(d, layer, comp);
  if (g.empty()) {
    fail(ErrorCode::invalid_argument, "layer '" + layer + "' has no timeline bar (a group member follows its group's bar)",
         {.layer = layer});
  }
  return g;
}

void valid_bar(const std::string& layer, const Geo& g) {
  if (g.duration < 1) fail(ErrorCode::out_of_range, "layer '" + layer + "' would be shorter than one frame", {.layer = layer});
  // B3z: an UNBOUNDED source may start before its frame 0 (AE: a text/shape/solid in point before its start time).
  if (g.sourceIn < 0 && g.sourceDuration) {
    fail(ErrorCode::out_of_range, "layer '" + layer + "' would start before its source", {.layer = layer});
  }
  if (g.sourceDuration && g.sourceIn + g.duration > *g.sourceDuration) {
    fail(ErrorCode::out_of_range, "layer '" + layer + "' would run past the end of its footage", {.layer = layer});
  }
}

std::vector<Geo> shift(std::vector<Geo> g, double delta) {
  for (Geo& b : g) b.start = b.start + delta;
  return g;
}

std::vector<Geo> trim_in(std::vector<Geo> g, double to, bool keepPlace = false) {
  Geo& first = g.front();
  const double dd = to - first.start;
  first.sourceIn = first.sourceIn + dd;
  first.duration = first.duration - dd;
  if (!keepPlace) first.start = to;
  return g;
}

std::vector<Geo> trim_out(std::vector<Geo> g, double to) {
  Geo& last = g.back();
  last.duration = to - last.start;
  return g;
}

/// Every other layer of the comp whose in point is at/after `from` (ripple set).
std::vector<std::string> later_layers(const Document& d, std::string_view comp, double from,
                                      const std::set<std::string, std::less<>>& exclude) {
  std::vector<std::string> out;
  for (const auto& id : layer_ids_of_comp(d, comp)) {
    if (exclude.contains(id)) continue;
    const auto g = geoms_of(d, id, comp);
    if (!g.empty() && g.front().start >= from) out.push_back(id);
  }
  return out;
}

double frames_of(const Document& d, std::string_view comp, api::Time t) { return flicks_to_frames(t, comp_fps(d, comp)); }

/// stamp.ts over these nodes, in THIS order (the TS scope's order), so ids
/// minted for keys a helper wrote without one match the TypeScript's.
void stamp_nodes(HCtx& x, const std::vector<std::string>& ids) {
  for (const auto& id : ids) {
    const NodeAnim* a = x.d.anim(id);
    if (a == nullptr) continue;
    bool missing = false;
    for (const auto& [prop, keys] : a->tracks) {
      for (const Key& k : keys) missing = missing || !k.id;
    }
    for (const auto& [prop, t] : a->data) {
      for (const DataKey& k : t.keys) missing = missing || !k.id;
    }
    if (!missing) continue;
    NodeAnim snap = *a;
    for (auto& [prop, keys] : snap.tracks) {
      for (Key& k : keys) {
        if (!k.id) k.id = x.mint_key_id();
      }
    }
    for (auto& [prop, t] : snap.data) {
      for (DataKey& k : t.keys) {
        if (!k.id) k.id = x.mint_key_id();
      }
    }
    x.d.set_anim(id, std::move(snap));
  }
}

// ── retime.ts ───────────────────────────────────────────────────────────────

struct RetimeClip {
  double offsetSec = 0;
  double inSec = 0;
};

struct BarInfo {
  double fps = 30;
  double inSec = 0;
  double outSec = 0;
  RetimeClip clip;
};

double clamp_speed_percent(double v) {
  if (!std::isfinite(v)) return 100;
  return std::max(-1000.0, std::min(1000.0, v));
}

/// retimeCommands.ts `retimeBarInfo` (the parts setRetimeMode reads).
std::optional<BarInfo> retime_bar_info(const HCtx& x, std::string_view node) {
  const auto bars = tl_bars_for_node(x.d, x.view, node);
  if (bars.empty()) return std::nullopt;
  double fps = tl_fps_for_node(x.d, x.view, node);
  if (!(fps != 0 && !std::isnan(fps))) fps = 30;
  const Bar* first = bars.front();
  double end = first->clip.end();
  for (const Bar* b : bars) {
    if (b->clip.start < first->clip.start) first = b;
    end = std::max(end, b->clip.end());
  }
  BarInfo info;
  info.fps = fps;
  info.inSec = first->clip.start / fps;
  info.outSec = end / fps;
  info.clip = RetimeClip{(first->clip.sourceIn - first->clip.start) / fps, first->clip.start / fps};
  return info;
}

constexpr int kEasedPanels = 64;

struct Segment {
  double t0 = 0;
  double t1 = 0;
  double v0 = 0;
  double v1 = 0;
  enum class Kind : std::uint8_t { hold, linear, sampled } kind = Kind::linear;
  std::vector<double> cum;
  std::vector<double> vals;
};

struct SpeedTable {
  double firstT = 0;
  double firstV = 0;
  double lastT = 0;
  double lastV = 0;
  std::vector<Segment> segments;
  std::vector<double> startCum;
};

bool is_hold(const std::optional<api::Easing>& e) {
  return e && (*e == api::Easing::step || *e == api::Easing::hold);
}

std::optional<SpeedTable> table_for(const HCtx& x, std::string_view node) {
  const auto* track = anim_track(x.d, node, kSpeedProp);
  if (track == nullptr || track->empty()) return std::nullopt;
  std::vector<Key> sorted = *track;
  std::stable_sort(sorted.begin(), sorted.end(), [](const Key& a, const Key& b) { return a.t < b.t; });
  SpeedTable table;
  double cum = 0;
  for (std::size_t i = 0; i + 1 < sorted.size(); ++i) {
    const Key& a = sorted[i];
    const Key& b = sorted[i + 1];
    const double len = b.t - a.t;
    if (!(len > 0)) continue;
    const double v0 = a.value / 100;
    const double v1 = b.value / 100;
    table.startCum.push_back(cum);
    Segment s;
    s.t0 = a.t;
    s.t1 = b.t;
    s.v0 = v0;
    s.v1 = v1;
    if (is_hold(a.easing)) {
      s.kind = Segment::Kind::hold;
      cum += v0 * len;
    } else if (a.easing && *a.easing == api::Easing::linear && !a.so && !b.si) {
      s.kind = Segment::Kind::linear;
      cum += ((v0 + v1) / 2) * len;
    } else {
      s.kind = Segment::Kind::sampled;
      constexpr std::size_t kP = kEasedPanels;
      s.vals.assign(kP + 1, 0);
      s.cum.assign(kP + 1, 0);
      for (std::size_t j = 0; j <= kP; ++j) {
        const double t = a.t + (len * static_cast<double>(j)) / kEasedPanels;
        double v = 0;
        if (j == 0) v = a.value;
        else if (j == kP) v = b.value;
        else v = anim_sample(x.d, x.expr, x.cache, node, kSpeedProp, t).value_or(a.value);
        s.vals[j] = v / 100;
      }
      const double h = len / kEasedPanels;
      for (std::size_t j = 1; j <= kP; ++j) s.cum[j] = s.cum[j - 1] + ((s.vals[j - 1] + s.vals[j]) / 2) * h;
      cum += s.cum[kEasedPanels];
    }
    table.segments.push_back(std::move(s));
  }
  table.firstT = sorted.front().t;
  table.firstV = sorted.front().value / 100;
  table.lastT = sorted.back().t;
  table.lastV = sorted.back().value / 100;
  return table;
}

double segment_integral(const Segment& s, double xx) {
  const double dd = xx - s.t0;
  if (dd <= 0) return 0;
  const double len = s.t1 - s.t0;
  if (s.kind == Segment::Kind::hold) return s.v0 * dd;
  if (s.kind == Segment::Kind::linear) return s.v0 * dd + ((s.v1 - s.v0) * dd * dd) / (2 * len);
  const double h = len / kEasedPanels;
  const double jj = std::min(static_cast<double>(kEasedPanels - 1), std::floor(dd / h));
  const auto j = static_cast<std::size_t>(jj);
  const double into = dd - jj * h;
  const double va = s.vals[j];
  const double vb = s.vals[j + 1];
  return s.cum[j] + va * into + ((vb - va) * into * into) / (2 * h);
}

double cumulative_at(const SpeedTable& t, double xx) {
  if (xx <= t.firstT) return (xx - t.firstT) * t.firstV;
  const auto& segs = t.segments;
  if (segs.empty() || xx >= t.lastT) {
    const double total = segs.empty() ? 0 : t.startCum[segs.size() - 1] + segment_integral(segs.back(), segs.back().t1);
    return total + (xx - t.lastT) * t.lastV;
  }
  for (std::size_t i = 0; i < segs.size(); ++i) {
    const Segment& s = segs[i];
    if (xx <= s.t1) return t.startCum[i] + segment_integral(s, std::max(s.t0, xx));
  }
  return 0;
}

double speed_advance(const HCtx& x, std::string_view node, double a, double b) {
  const auto table = table_for(x, node);
  if (!table) return b - a;
  return cumulative_at(*table, b) - cumulative_at(*table, a);
}

std::optional<double> retimed_chain_time(const HCtx& x, std::string_view node, double t, const RetimeClip* clip) {
  if (anim_is_animated(x.d, node, kSpeedProp)) {
    const double off = clip != nullptr ? clip->offsetSec : 0;
    const double uIn = clip != nullptr ? clip->inSec + off : 0;
    const double source = uIn + speed_advance(x, node, uIn, t + off);
    return source - off;
  }
  if (anim_is_animated(x.d, node, kRemapProp)) return anim_sample(x.d, x.expr, x.cache, node, kRemapProp, t);
  if (anim_is_animated(x.d, node, kLegacyRemapProp)) return anim_sample(x.d, x.expr, x.cache, node, kLegacyRemapProp, t);
  return std::nullopt;
}

double retimed_source_seconds(const HCtx& x, std::string_view node, double t, const std::optional<BarInfo>& bar) {
  const double off = bar ? bar->clip.offsetSec : 0;
  const auto chain = retimed_chain_time(x, node, t, bar ? &bar->clip : nullptr);
  return chain.value_or(t) + off;
}

// ── retimeCommands.ts ───────────────────────────────────────────────────────

std::array<double, 4> ramp_bezier(double v0, double v1) {
  const double sum = v0 + v1;
  if (std::fabs(sum) < 1e-12) return {1.0 / 3, 1.0 / 3, 2.0 / 3, 2.0 / 3};
  const double a = (2 * v0) / sum;
  const double b = (v1 - v0) / sum;
  return {1.0 / 3, a / 3, 2.0 / 3, (b + 2 * a) / 3};
}

/// `new Set(...)` then numeric sort.
void add_unique(std::vector<double>& s, double v) {
  if (std::find(s.begin(), s.end(), v) == s.end()) s.push_back(v);
}

Key make_key(double t, double value, api::Easing e) {
  Key k;
  k.t = t;
  k.value = value;
  k.easing = e;
  return k;
}

std::vector<Key> bake_speed_to_remap(const HCtx& x, std::string_view node, const std::optional<BarInfo>& bar) {
  const double inSec = bar ? bar->inSec : 0;
  const double outSec = bar ? bar->outSec : inSec + 1;
  const double off = bar ? bar->clip.offsetSec : 0;
  std::vector<Key> keys;
  if (const auto* tr = anim_track(x.d, node, kSpeedProp)) keys = *tr;
  std::stable_sort(keys.begin(), keys.end(), [](const Key& a, const Key& b) { return a.t < b.t; });
  std::vector<double> bounds{inSec};
  add_unique(bounds, outSec);
  for (const Key& k : keys) {
    const double t = k.t - off;
    if (t > inSec && t < outSec) add_unique(bounds, t);
  }
  std::vector<double> times = bounds;
  std::stable_sort(times.begin(), times.end());
  const RetimeClip* clip = bar ? &bar->clip : nullptr;
  const auto chainAt = [&](double t) { return retimed_chain_time(x, node, t, clip).value_or(t); };
  const auto speedOf = [&](double t) {
    return anim_sample(x.d, x.expr, x.cache, node, kSpeedProp, t + off).value_or(100) / 100;
  };
  const auto easingOf = [&](double t) -> std::optional<api::Easing> {
    const Key* found = nullptr;
    for (const Key& k : keys) {
      if (k.t - off <= t + 1e-9) found = &k;
    }
    if (found != nullptr && found->easing) return found->easing;
    return keys.empty() ? std::nullopt : keys.front().easing;
  };
  std::vector<Key> out;
  const auto push = [&](double t, double v0, double v1) {
    Key k = make_key(t, chainAt(t), api::Easing::bezier);
    k.bezier = ramp_bezier(v0, v1);
    out.push_back(std::move(k));
  };
  for (std::size_t i = 0; i + 1 < times.size(); ++i) {
    const double a = times[i];
    const double b = times[i + 1];
    const auto easing = easingOf(a);
    if (is_hold(easing)) {
      push(a, speedOf(a), speedOf(a));
    } else if (easing && *easing == api::Easing::linear) {
      push(a, speedOf(a), speedOf(b - 1e-9));
    } else {
      constexpr int kBakeSubdivisions = 8;
      for (int j = 0; j < kBakeSubdivisions; ++j) {
        const double s0 = a + ((b - a) * j) / kBakeSubdivisions;
        const double s1 = a + ((b - a) * (j + 1)) / kBakeSubdivisions;
        push(s0, speedOf(s0), speedOf(s1));
      }
    }
  }
  const double last = times.back();
  out.push_back(make_key(last, chainAt(last), api::Easing::linear));
  for (std::size_t i = 0; i + 1 < out.size(); ++i) {
    Key& k = out[i];
    if (std::fabs(out[i + 1].value - k.value) < 1e-9 && k.easing == api::Easing::bezier) {
      k.bezier.reset();
      k.easing = api::Easing::linear;
    }
  }
  return out;
}

std::vector<Key> bake_remap_to_speed(const HCtx& x, std::string_view node, const std::optional<BarInfo>& bar) {
  const double inSec = bar ? bar->inSec : 0;
  const double outSec = bar ? bar->outSec : inSec + 1;
  std::vector<Key> remap;
  if (const auto* tr = anim_track(x.d, node, kRemapProp)) remap = *tr;
  std::vector<double> bounds{inSec};
  add_unique(bounds, outSec);
  for (const Key& k : remap) {
    if (k.t > inSec && k.t < outSec) {
      add_unique(bounds, k.t);
      const bool shaped = !(k.easing && (*k.easing == api::Easing::linear || is_hold(k.easing)));
      if (shaped) {
        const auto next = std::find_if(remap.begin(), remap.end(), [&k](const Key& n) { return n.t > k.t; });
        if (next != remap.end()) {
          for (int j = 1; j < 4; ++j) add_unique(bounds, k.t + ((std::min(next->t, outSec) - k.t) * j) / 4);
        }
      }
    }
  }
  std::vector<double> times;
  for (const double t : bounds) {
    if (t >= inSec && t <= outSec) times.push_back(t);
  }
  std::stable_sort(times.begin(), times.end());
  std::vector<Key> out;
  for (std::size_t i = 0; i + 1 < times.size(); ++i) {
    const double a = times[i];
    const double b = times[i + 1];
    const double slope = (retimed_source_seconds(x, node, b, bar) - retimed_source_seconds(x, node, a, bar)) / (b - a);
    out.push_back(make_key(comp_to_keyframe_time(x.d, x.view, node, a),
                           motion::js::round(clamp_speed_percent(slope * 100) * 10) / 10, api::Easing::step));
  }
  if (out.empty()) out.push_back(make_key(comp_to_keyframe_time(x.d, x.view, node, inSec), 100, api::Easing::linear));
  return out;
}

void remove_retime_tracks(Document& d, std::string_view node) {
  for (const auto prop : kRetimeProps) anim_remove_track(d, node, prop);
}

}  // namespace

// ── shared helpers ──────────────────────────────────────────────────────────

void update_node_layer_time(Document& d, std::string_view node, const std::function<void(LayerTime&)>& patch) {
  const Node* n = d.node(node);
  LayerTime cur = n != nullptr ? get_node_layer_time(*n) : LayerTime{};
  patch(cur);
  const LayerTime next = normalize_layer_time(layer_time_json(cur));
  const bool clear = is_identity_time(next) && next.frameBlend == "none";
  sg_set_fx(d, node, "time", clear ? Json() : layer_time_json(next));
}

void set_retime_mode(HCtx& x, const std::vector<std::string>& ids, api::RetimeMode mode) {
  Document& d = x.d;
  for (const auto& id : ids) {
    const api::RetimeMode from = read_retime_mode(d, id);
    if (from == mode) continue;
    const auto bar = retime_bar_info(x, id);
    if (mode == api::RetimeMode::normal) {
      remove_retime_tracks(d, id);
      continue;
    }
    if (mode == api::RetimeMode::speed) {
      std::vector<Key> keys;
      if (from == api::RetimeMode::frames) {
        keys = bake_remap_to_speed(x, id, bar);
      } else {
        keys.push_back(make_key(comp_to_keyframe_time(d, x.view, id, bar ? bar->inSec : 0), 100, api::Easing::linear));
      }
      remove_retime_tracks(d, id);
      anim_set_keyframes(d, id, kSpeedProp, keys);
      continue;
    }
    std::vector<Key> keys;
    if (from == api::RetimeMode::speed) {
      keys = bake_speed_to_remap(x, id, bar);
    } else {
      const double inSec = bar ? bar->inSec : 0;
      const double outSec = bar ? bar->outSec : 1;
      const double fps = bar ? bar->fps : 30;
      for (const double t : {inSec, std::max(outSec - 1 / fps, inSec + 1 / fps)}) {
        keys.push_back(make_key(comp_to_keyframe_time(d, x.view, id, t, kRemapProp), t, api::Easing::linear));
      }
    }
    remove_retime_tracks(d, id);
    anim_set_keyframes(d, id, kRemapProp, keys);
  }
}

// ── handlers ────────────────────────────────────────────────────────────────

ResultOf<api::SetLayerTiming> handle(const api::SetLayerTiming& c, HCtx& x) {
  Document& d = x.d;
  if (c.items.empty()) fail(ErrorCode::invalid_argument, "no layers given");
  struct Plan {
    std::string layer;
    std::string comp;
    std::optional<std::vector<Geo>> geo;
    std::optional<double> stretch;
  };
  std::vector<Plan> plans;
  for (const auto& it : c.items) {
    (void)require_layer(d, it.layer);
    const std::string comp = *comp_of_layer(d, it.layer);
    ensure_timeline(d, comp);
    const double fps = comp_fps(d, comp);
    std::optional<std::vector<Geo>> geo;
    if (it.in_point || it.out_point || it.start_time) {
      std::vector<Geo> g = bars_or_fail(d, it.layer, comp);
      if (it.start_time) {
        const double cur = g.front().start - g.front().sourceIn;
        g = shift(std::move(g), flicks_to_frames(*it.start_time, fps) - cur);
      }
      if (it.in_point) g = trim_in(std::move(g), flicks_to_frames(*it.in_point, fps));
      if (it.out_point) g = trim_out(std::move(g), flicks_to_frames(*it.out_point, fps));
      for (const Geo& b : g) valid_bar(it.layer, b);
      geo = std::move(g);
    }
    if (it.stretch) {
      const double pct = std::fabs(*it.stretch) * 100;
      if (!(pct >= 1 && pct <= 1000)) fail(ErrorCode::out_of_range, "stretch must be within ±0.01…±10 and not 0", {.layer = it.layer});
    }
    plans.push_back(Plan{it.layer, comp, std::move(geo), it.stretch});
  }
  x.label = "Layer Timing";
  for (const Plan& p : plans) {
    if (p.geo) write_geoms(d, p.comp, p.layer, *p.geo);
    if (p.stretch) {
      const double s = *p.stretch;
      update_node_layer_time(d, p.layer, [s](LayerTime& t) {
        t.stretch = std::fabs(s) * 100;
        t.reverse = s < 0;
      });
    }
  }
  return {};
}

ResultOf<api::MoveLayersInTime> handle(const api::MoveLayersInTime& c, HCtx& x) {
  Document& d = x.d;
  const std::string comp = require_layers_in_one_comp(d, c.layers);
  const double dd = frames_of(d, comp, c.delta);
  ensure_timeline(d, comp);
  const std::set<std::string, std::less<>> moved(c.layers.begin(), c.layers.end());
  double maxOut = -std::numeric_limits<double>::infinity();
  for (const auto& id : c.layers) maxOut = std::max(maxOut, span(bars_or_fail(d, id, comp)).out);
  std::vector<std::string> all = c.layers;
  if (c.ripple) {
    for (auto& id : later_layers(d, comp, maxOut, moved)) all.push_back(std::move(id));
  }
  x.label = "Move " + plural(c.layers.size(), "Layer");
  for (const auto& id : all) write_geoms(d, comp, id, shift(geoms_of(d, id, comp), dd));
  return {};
}

ResultOf<api::TrimLayers> handle(const api::TrimLayers& c, HCtx& x) {
  Document& d = x.d;
  const std::string comp = require_layers_in_one_comp(d, c.layers);
  const double to = frames_of(d, comp, c.time);
  ensure_timeline(d, comp);
  std::vector<std::pair<std::string, std::vector<Geo>>> next;
  double rippleDelta = 0;
  double rippleFrom = std::numeric_limits<double>::infinity();
  for (const auto& id : c.layers) {
    std::vector<Geo> g = bars_or_fail(d, id, comp);
    const Span s = span(g);
    std::vector<Geo> n;
    if (c.edge == api::Edge::in) {
      n = trim_in(g, to, c.ripple);
      if (c.ripple) rippleDelta = -(to - s.in);
    } else {
      n = trim_out(g, to);
      if (c.ripple) rippleDelta = to - s.out;
    }
    rippleFrom = std::min(rippleFrom, s.out);
    for (const Geo& b : n) valid_bar(id, b);
    next.emplace_back(id, std::move(n));
  }
  std::vector<std::string> ripple;
  if (c.ripple) ripple = later_layers(d, comp, rippleFrom, std::set<std::string, std::less<>>(c.layers.begin(), c.layers.end()));
  x.label = c.edge == api::Edge::in ? "Trim In" : "Trim Out";
  for (const auto& [id, g] : next) write_geoms(d, comp, id, g);
  for (const auto& id : ripple) write_geoms(d, comp, id, shift(geoms_of(d, id, comp), rippleDelta));
  return {};
}

ResultOf<api::SlipLayers> handle(const api::SlipLayers& c, HCtx& x) {
  Document& d = x.d;
  const std::string comp = require_layers_in_one_comp(d, c.layers);
  const double dd = frames_of(d, comp, c.delta);
  ensure_timeline(d, comp);
  std::vector<std::pair<std::string, std::vector<Geo>>> next;
  for (const auto& id : c.layers) {
    std::vector<Geo> g = bars_or_fail(d, id, comp);
    for (Geo& b : g) b.sourceIn = b.sourceIn + dd;
    for (const Geo& b : g) valid_bar(id, b);
    next.emplace_back(id, std::move(g));
  }
  x.label = "Slip";
  for (const auto& [id, g] : next) write_geoms(d, comp, id, g);
  return {};
}

ResultOf<api::SlideLayer> handle(const api::SlideLayer& c, HCtx& x) {
  Document& d = x.d;
  (void)require_layer(d, c.layer);
  const std::string comp = *comp_of_layer(d, c.layer);
  const double dd = frames_of(d, comp, c.delta);
  ensure_timeline(d, comp);
  const std::vector<Geo> g = bars_or_fail(d, c.layer, comp);
  const Span s = span(g);
  std::optional<std::string> before;
  std::optional<std::string> after;
  for (const auto& id : layer_ids_of_comp(d, comp)) {
    if (id == c.layer) continue;
    const auto o = geoms_of(d, id, comp);
    if (o.empty()) continue;
    if (!before && span(o).out == s.in) before = id;
    if (!after && span(o).in == s.out) after = id;
  }
  std::vector<std::pair<std::string, std::vector<Geo>>> plan;
  const auto put = [&plan](const std::string& id, std::vector<Geo> v) {
    for (auto& [k, val] : plan) {
      if (k == id) {
        val = std::move(v);
        return;
      }
    }
    plan.emplace_back(id, std::move(v));
  };
  put(c.layer, shift(g, dd));
  if (before) put(*before, trim_out(geoms_of(d, *before, comp), s.in + dd));
  if (after) put(*after, trim_in(geoms_of(d, *after, comp), s.out + dd));
  for (const auto& [id, v] : plan) {
    for (const Geo& b : v) valid_bar(id, b);
  }
  x.label = "Slide";
  for (const auto& [id, v] : plan) write_geoms(d, comp, id, v);
  return {};
}

ResultOf<api::RollEdit> handle(const api::RollEdit& c, HCtx& x) {
  Document& d = x.d;
  const std::string comp = require_layers_in_one_comp(d, {c.left, c.right});
  const double dd = frames_of(d, comp, c.delta);
  ensure_timeline(d, comp);
  const auto l = bars_or_fail(d, c.left, comp);
  const auto r = bars_or_fail(d, c.right, comp);
  if (span(l).out != span(r).in) fail(ErrorCode::invalid_argument, "roll needs two layers that share a cut (left out = right in)");
  const auto nl = trim_out(l, span(l).out + dd);
  const auto nr = trim_in(r, span(r).in + dd);
  for (const Geo& b : nl) valid_bar(c.left, b);
  for (const Geo& b : nr) valid_bar(c.right, b);
  x.label = "Roll Edit";
  write_geoms(d, comp, c.left, nl);
  write_geoms(d, comp, c.right, nr);
  return {};
}

ResultOf<api::SplitLayers> handle(const api::SplitLayers& c, HCtx& x) {
  Document& d = x.d;
  const std::string comp = require_layers_in_one_comp(d, c.layers);
  const double t = frames_of(d, comp, c.time);
  ensure_timeline(d, comp);
  struct Work {
    std::string id;
    std::string newId;
    std::vector<Geo> left;
    std::vector<Geo> right;
  };
  std::vector<Work> work;
  for (const auto& id : c.layers) {
    const auto g = bars_or_fail(d, id, comp);
    std::size_t i = 0;
    while (i < g.size() && !(g[i].start < t && t < g[i].start + g[i].duration)) ++i;
    if (i == g.size()) continue;  // AE: a layer the time does not cut is left alone
    const Geo& b = g[i];
    Geo leftBar = b;
    leftBar.duration = t - b.start;
    Geo rightBar = b;
    rightBar.start = t;
    rightBar.sourceIn = b.sourceIn + (t - b.start);
    rightBar.duration = b.start + b.duration - t;
    Work w{id, x.mint_id("layer_"), {}, {}};
    w.left.assign(g.begin(), g.begin() + static_cast<std::ptrdiff_t>(i));
    w.left.push_back(leftBar);
    w.right.push_back(rightBar);
    w.right.insert(w.right.end(), g.begin() + static_cast<std::ptrdiff_t>(i + 1), g.end());
    work.push_back(std::move(w));
  }
  x.label = "Split Layer";
  api::LayerList out;
  for (const Work& w : work) {
    if (!clone_layer_node(d, w.id, w.newId)) fail(ErrorCode::internal, "could not split '" + w.id + "'", {.layer = w.id});
    const Node src = *d.node(w.id);
    if (src.solo) d.node_mut(w.newId).solo = true;
    if (src.shy) d.node_mut(w.newId).shy = true;
    if (src.color && !src.color->empty()) d.node_mut(w.newId).color = src.color;
    remint_key_ids(x, w.newId);
    tl_sync_from_scene(d, comp);
    write_geoms(d, comp, w.id, w.left);
    write_geoms(d, comp, w.newId, w.right);
  }
  for (const Work& w : work) out.layers.push_back(w.newId);
  return out;
}

ResultOf<api::RippleDeleteLayers> handle(const api::RippleDeleteLayers& c, HCtx& x) {
  Document& d = x.d;
  const std::string comp = require_layers_in_one_comp(d, c.layers);
  for (const auto& id : c.layers) {
    const Node* n = d.node(id);
    if (n != nullptr && n->locked) fail(ErrorCode::locked, "layer '" + id + "' is locked", {.layer = id});
  }
  ensure_timeline(d, comp);
  std::vector<Span> gaps;
  for (const auto& id : c.layers) {
    const auto g = geoms_of(d, id, comp);
    if (!g.empty()) gaps.push_back(span(g));
  }
  std::stable_sort(gaps.begin(), gaps.end(), [](const Span& a, const Span& b) { return a.in < b.in; });
  std::vector<Span> uni;
  for (const Span& s : gaps) {
    if (!uni.empty() && s.in <= uni.back().out) uni.back().out = std::max(uni.back().out, s.out);
    else uni.push_back(s);
  }
  x.label = "Ripple Delete " + plural(c.layers.size(), "Layer");
  const std::set<std::string, std::less<>> doomed(c.layers.begin(), c.layers.end());
  for (const auto& id : c.layers) {
    const Node* node = d.node(id);
    if (node == nullptr) continue;
    const std::string target = *node->parent;
    for (const auto& ch : sg_child_order(d, id)) {
      if (!doomed.contains(ch)) sg_set_parent(d, ch, target, true);
    }
    (void)delete_layer_node(d, id);
  }
  for (const auto& id : layer_ids_of_comp(d, comp)) {
    const auto g = geoms_of(d, id, comp);
    if (g.empty()) continue;
    const double at = g.front().start;
    double dd = 0;
    for (const Span& u : uni) {
      if (u.out <= at) dd += u.out - u.in;
    }
    if (dd > 0) write_geoms(d, comp, id, shift(g, -dd));
  }
  return {};
}

ResultOf<api::EditWorkArea> handle(const api::EditWorkArea& c, HCtx& x) {
  Document& d = x.d;
  require_comp(d, c.comp);
  ensure_timeline(d, c.comp);
  const Timeline& tl = *d.timeline(c.comp);
  const FrameRange wa = tl.workArea.value_or(FrameRange{0, tl.duration});
  const double s = wa.start;
  const double e = wa.start + wa.duration;
  std::vector<std::string> ids;
  if (!c.layers.empty()) {
    ids = c.layers;
  } else {
    for (const auto& id : layer_ids_of_comp(d, c.comp)) {
      if (!geoms_of(d, id, c.comp).empty()) ids.push_back(id);
    }
  }
  if (!c.layers.empty() && require_layers_in_one_comp(d, c.layers) != c.comp) {
    fail(ErrorCode::invalid_argument, "the layers are not in that composition");
  }
  const bool extract = c.edit == api::WorkAreaEdit::extract;
  std::vector<std::pair<std::string, std::string>> newIds;
  for (const auto& id : ids) {
    const auto g = geoms_of(d, id, c.comp);
    if (g.empty()) continue;
    const Span sp = span(g);
    if (sp.in < s && sp.out > e) newIds.emplace_back(id, x.mint_id("layer_"));
  }
  x.label = extract ? "Extract Work Area" : "Lift Work Area";
  const double width = e - s;
  for (const auto& id : ids) {
    const auto g = geoms_of(d, id, c.comp);
    if (g.empty()) continue;
    const Span sp = span(g);
    if (sp.out <= s) continue;
    if (sp.in >= e) {
      if (extract) write_geoms(d, c.comp, id, shift(g, -width));
      continue;
    }
    if (sp.in >= s && sp.out <= e) {
      (void)delete_layer_node(d, id);
      // The scene change resyncs the timeline (the editor's SceneGraphChanged listener).
      tl_sync_from_scene(d, c.comp);
      continue;
    }
    if (sp.in < s && sp.out > e) {
      std::string newId;
      for (const auto& [k, v] : newIds) {
        if (k == id) newId = v;
      }
      (void)clone_layer_node(d, id, newId);
      remint_key_ids(x, newId);
      tl_sync_from_scene(d, c.comp);
      const auto right = trim_in(g, e);
      write_geoms(d, c.comp, id, trim_out(g, s));
      write_geoms(d, c.comp, newId, extract ? shift(right, -width) : right);
      continue;
    }
    if (sp.in < s) {
      write_geoms(d, c.comp, id, trim_out(g, s));
    } else {
      const auto r = trim_in(g, e);
      write_geoms(d, c.comp, id, extract ? shift(r, -width) : r);
    }
  }
  api::LayerList out;
  for (const auto& [k, v] : newIds) out.layers.push_back(v);
  return out;
}

ResultOf<api::InsertGap> handle(const api::InsertGap& c, HCtx& x) {
  Document& d = x.d;
  require_comp(d, c.comp);
  if (c.duration <= 0) fail(ErrorCode::out_of_range, "the gap must be longer than zero");
  const double fps = comp_fps(d, c.comp);
  const double at = flicks_to_frames(c.time, fps);
  const double dd = flicks_to_frames(c.duration, fps);
  ensure_timeline(d, c.comp);
  const auto ids = later_layers(d, c.comp, at, {});
  x.label = "Insert Gap";
  for (const auto& id : ids) write_geoms(d, c.comp, id, shift(geoms_of(d, id, c.comp), dd));
  return {};
}

ResultOf<api::TimeReverseLayers> handle(const api::TimeReverseLayers& c, HCtx& x) {
  (void)require_layers_in_one_comp(x.d, c.layers);
  x.label = "Time-Reverse Layer";
  for (const auto& id : c.layers) {
    update_node_layer_time(x.d, id, [](LayerTime& t) { t.reverse = !t.reverse; });
  }
  return {};
}

ResultOf<api::SetTimeRemap> handle(const api::SetTimeRemap& c, HCtx& x) {
  (void)require_layer(x.d, c.layer);
  x.label = c.enabled ? "Enable Time Remapping" : "Disable Time Remapping";
  const api::RetimeMode mode = read_retime_mode(x.d, c.layer);
  if (c.enabled && mode != api::RetimeMode::frames) set_retime_mode(x, {c.layer}, api::RetimeMode::frames);
  if (!c.enabled) {
    if (mode == api::RetimeMode::frames) set_retime_mode(x, {c.layer}, api::RetimeMode::normal);
    else anim_remove_track(x.d, c.layer, kRemapProp);
  }
  return {};
}

ResultOf<api::FreezeFrame> handle(const api::FreezeFrame& c, HCtx& x) {
  Document& d = x.d;
  (void)require_layer(d, c.layer);
  const std::string comp = *comp_of_layer(d, c.layer);
  ensure_timeline(d, comp);
  const double fps = comp_fps(d, comp);
  double at = 0;
  if (c.last_frame || !c.time) {
    const auto g = geoms_of(d, c.layer, comp);
    const double outFrame = !g.empty() ? span(g).out - 1 : comp_duration_frames(d, comp) - 1;
    at = comp_to_keyframe_time(d, x.view, c.layer, outFrame / fps);
  } else {
    at = comp_to_keyframe_time(d, x.view, c.layer, flicks_to_seconds(*c.time));
  }
  x.label = "Freeze Frame";
  update_node_layer_time(d, c.layer, [at](LayerTime& t) {
    t.freeze = true;
    t.freezeTime = at;
  });
  return {};
}

ResultOf<api::SetRetime> handle(const api::SetRetime& c, HCtx& x) {
  Document& d = x.d;
  (void)require_layer(d, c.layer);
  const std::string comp = *comp_of_layer(d, c.layer);
  if (c.speed && c.mode != api::RetimeMode::speed) fail(ErrorCode::invalid_argument, "speed is only valid with mode speed");
  if (c.speed && !std::isfinite(*c.speed)) fail(ErrorCode::invalid_argument, "speed must be finite");
  ensure_timeline(d, comp);
  x.label = "Retime";
  set_retime_mode(x, {c.layer}, c.mode);
  if (c.mode == api::RetimeMode::speed && c.speed) {
    const auto* keys = anim_track(d, c.layer, kSpeedProp);
    Key k = keys != nullptr && !keys->empty() ? keys->front() : make_key(0, 0, api::Easing::linear);
    k.value = clamp_speed_percent(*c.speed);
    anim_set_keyframes(d, c.layer, kSpeedProp, {k});
  }
  return {};
}

ResultOf<api::SequenceLayers> handle(const api::SequenceLayers& c, HCtx& x) {
  Document& d = x.d;
  const std::string comp = require_layers_in_one_comp(d, c.layers);
  const double fps = comp_fps(d, comp);
  const double ov = flicks_to_frames(c.overlap, fps);
  ensure_timeline(d, comp);
  for (const auto& id : c.layers) (void)bars_or_fail(d, id, comp);
  x.label = "Sequence Layers";
  struct Pair {
    std::string out;
    std::string inn;
    double start = 0;
    double end = 0;
  };
  std::optional<double> prevOut;
  std::vector<Pair> pairs;
  for (std::size_t i = 0; i < c.layers.size(); ++i) {
    const std::string& id = c.layers[i];
    const auto g = geoms_of(d, id, comp);
    if (prevOut) {
      const double start = *prevOut - ov;
      const auto moved = shift(g, start - g.front().start);
      write_geoms(d, comp, id, moved);
      if (c.crossfade && ov > 0) pairs.push_back(Pair{c.layers[i - 1], id, start, *prevOut});
      prevOut = span(moved).out;
    } else {
      prevOut = span(g).out;
    }
  }
  for (const Pair& p : pairs) {
    const double t0 = p.start / fps;
    const double t1 = p.end / fps;
    const double o0 = comp_to_keyframe_time(d, x.view, p.out, t0);
    // B3z: t1 is the outgoing bar's EXCLUSIVE end (no clip covers it): the last
    // frame inside, one frame on (transitions.ts kfTime).
    const double o1 = comp_to_keyframe_time(d, x.view, p.out, (p.end - 1) / fps) + 1 / fps;
    const double i0 = comp_to_keyframe_time(d, x.view, p.inn, t0);
    const double i1 = comp_to_keyframe_time(d, x.view, p.inn, t1);
    anim_set_keyframe(d, p.out, "opacity", o0, 100);
    anim_set_keyframe(d, p.out, "opacity", o1, 0);
    anim_set_keyframe(d, p.inn, "opacity", i0, 0);
    anim_set_keyframe(d, p.inn, "opacity", i1, 100);
  }
  // stampMissingKeyIds in the command's scope order (layersScope(cmd.layers)).
  stamp_nodes(x, c.layers);
  return {};
}

// ── B3z: unfreeze, Time Stretch, time-range ripple delete, key shifts ───────
// (layerTime.ts, core/animation/timeStretch.ts)

namespace {

double js_round(double v) { return motion::js::round(v); }

double clamp_stretch(double percent) { return std::max(1.0, std::min(1000.0, js_round(percent))); }

double clamp_signed_stretch(double percent) {
  if (!std::isfinite(percent) || js_round(percent) == 0) return 100;
  return percent < 0 ? -clamp_stretch(-percent) : clamp_stretch(percent);
}

bool is_retimable(const Node& n) {
  const std::string k = n.kind();
  return k == "video" || k == "audio" || is_precomp(n);
}

double read_baked_stretch(const Node& n) {
  const Json& v = n.fx().at("bakedStretch");
  return v.is_number() && std::isfinite(v.num()) && v.num() != 0 ? v.num() : 100;
}

enum class Hold : std::uint8_t { in, current, out };

double hold_frame_of(const std::vector<Geo>& g, Hold hold, std::optional<api::Time> time, double fps) {
  double s = g.front().start;
  double e = g.front().start + g.front().duration;
  for (const Geo& b : g) {
    s = std::min(s, b.start);
    e = std::max(e, b.start + b.duration);
  }
  if (hold == Hold::in) return s;
  if (hold == Hold::out) return e;
  return time ? flicks_to_frames(*time, fps) : 0;
}

/// timeStretch.ts `stretchClipGeometry`.
Geo stretch_clip_geometry(const Geo& clip, double oldS, double newS, double H, double fps, double a, bool bounded) {
  const double r = newS / (oldS > 0 ? oldS : 100);
  if (!std::isfinite(r) || r <= 0 || r == 1) return clip;
  Geo out = clip;
  out.duration = std::max(1.0, js_round(clip.duration * r));
  out.start = std::max(0.0, js_round(H - (H - clip.start) * r));
  const double c0 = (clip.sourceIn + H - clip.start) / fps;
  double sourceIn = js_round(fps * (a + (c0 - a) * r) - H + out.start);
  if (bounded) sourceIn = std::max(0.0, sourceIn);
  out.sourceIn = sourceIn;
  return out;
}

struct StretchPlan {
  std::vector<Geo> bars;
  double keyScale = 1;
  double keyOffset = 0;
  double S = 0;
  double E = 0;
  double H = 0;
  double ra = 1;
  double shift = 0;
  bool reversed = false;
  [[nodiscard]] double place(double f) const {
    const double G = H + (f - H) * ra + shift;
    return reversed ? S + E - G : G;
  }
};

/// timeStretch.ts `bakeStretchGeometry`.
std::optional<StretchPlan> bake_stretch_geometry(const std::vector<Geo>& bars, double factor, double H, double fps) {
  if (bars.empty() || !std::isfinite(factor) || factor == 0 || !(fps > 0)) return std::nullopt;
  StretchPlan p;
  p.H = H;
  if (factor == 1) {
    p.bars = bars;
    return p;
  }
  p.ra = std::abs(factor);
  p.reversed = factor < 0;
  std::vector<std::pair<double, double>> scaled;
  for (const Geo& b : bars) scaled.emplace_back(js_round(H + (b.start - H) * p.ra), std::max(1.0, js_round(b.duration * p.ra)));
  double minStart = scaled.front().first;
  for (const auto& s : scaled) minStart = std::min(minStart, s.first);
  p.shift = std::max(0.0, -minStart);
  for (auto& s : scaled) s.first += p.shift;
  p.S = scaled.front().first;
  p.E = scaled.front().first + scaled.front().second;
  for (const auto& s : scaled) {
    p.S = std::min(p.S, s.first);
    p.E = std::max(p.E, s.first + s.second);
  }
  std::vector<double> starts;
  for (const auto& s : scaled) starts.push_back(p.reversed ? p.S + p.E - (s.first + s.second) : s.first);
  std::size_t pi = 0;
  for (std::size_t i = 0; i < bars.size(); ++i) {
    if (bars[i].start < bars[pi].start) pi = i;
  }
  const Geo& primary = bars[pi];
  const double alpha = p.place(primary.start - primary.sourceIn) - starts[pi] + primary.sourceIn;
  for (std::size_t i = 0; i < bars.size(); ++i) {
    Geo g = bars[i];
    g.start = starts[i];
    g.duration = scaled[i].second;
    if (i != pi) g.sourceIn = js_round(starts[i] - (p.place(bars[i].start - bars[i].sourceIn) - alpha));
    p.bars.push_back(g);
  }
  p.keyScale = p.reversed ? -p.ra : p.ra;
  p.keyOffset = alpha / fps;
  return p;
}

std::optional<api::Easing> mirror_easing(std::optional<api::Easing> e) {
  if (e == api::Easing::ease_in) return api::Easing::ease_out;
  if (e == api::Easing::ease_out) return api::Easing::ease_in;
  return e;
}

std::array<double, 4> mirror_bezier(const std::array<double, 4>& b) { return {1 - b[2], 1 - b[3], 1 - b[0], 1 - b[1]}; }

template <class K>
std::vector<K> moved_keys(const std::vector<K>& keys, double scale, double offset) {
  std::vector<K> moved = keys;
  std::stable_sort(moved.begin(), moved.end(), [](const K& a, const K& b) { return a.t < b.t; });
  for (K& k : moved) k.t = offset + scale * k.t;
  std::stable_sort(moved.begin(), moved.end(), [](const K& a, const K& b) { return a.t < b.t; });
  return moved;
}

/// timeStretch.ts `retimeKeys` on scalar keys.
std::vector<Key> retime_keys(const std::vector<Key>& keys, double scale, double offset) {
  std::vector<Key> moved = moved_keys(keys, scale, offset);
  if (scale >= 0) return moved;
  std::vector<Key> out;
  for (std::size_t j = 0; j < moved.size(); ++j) {
    Key k = moved[j];
    k.si = moved[j].so;
    k.so = moved[j].si;
    if (j + 1 < moved.size()) {
      const Key& owner = moved[j + 1];
      k.easing = mirror_easing(owner.easing);
      k.bezier = owner.bezier ? std::optional<std::array<double, 4>>(mirror_bezier(*owner.bezier)) : std::nullopt;
      k.continuous = owner.continuous;
    }
    out.push_back(std::move(k));
  }
  return out;
}

/// …on data keys (no `continuous` in the model).
std::vector<DataKey> retime_data_keys(const std::vector<DataKey>& keys, double scale, double offset) {
  std::vector<DataKey> moved = moved_keys(keys, scale, offset);
  if (scale >= 0) return moved;
  std::vector<DataKey> out;
  for (std::size_t j = 0; j < moved.size(); ++j) {
    DataKey k = moved[j];
    k.si = moved[j].so;
    k.so = moved[j].si;
    if (j + 1 < moved.size()) {
      const DataKey& owner = moved[j + 1];
      k.easing = mirror_easing(owner.easing);
      k.bezier = owner.bezier ? std::optional<std::array<double, 4>>(mirror_bezier(*owner.bezier)) : std::nullopt;
    }
    out.push_back(std::move(k));
  }
  return out;
}

/// …on the whole-mask shape keys (plain objects, in the TypeScript's key order).
std::vector<Json> retime_json_keys(const std::vector<Json>& keys, double scale, double offset) {
  std::vector<Json> moved = keys;
  const auto tOf = [](const Json& k) { return k.at("t").is_number() ? k.at("t").num() : std::nan(""); };
  const auto byT = [&](const Json& a, const Json& b) { return tOf(a) < tOf(b); };
  std::stable_sort(moved.begin(), moved.end(), byT);
  for (Json& k : moved) k.set("t", Json::number(offset + scale * tOf(k)));
  std::stable_sort(moved.begin(), moved.end(), byT);
  if (scale >= 0) return moved;
  std::vector<Json> out;
  for (std::size_t j = 0; j < moved.size(); ++j) {
    const Json& src = moved[j];
    Json o = src;
    o.erase("si");
    o.erase("so");
    if (!src.at("so").is_undefined()) o.set("si", src.at("so"));
    if (!src.at("si").is_undefined()) o.set("so", src.at("si"));
    if (j + 1 < moved.size()) {
      const Json& owner = moved[j + 1];
      o.erase("easing");
      o.erase("bezier");
      o.erase("continuous");
      if (owner.at("easing").is_string()) {
        const std::string& e = owner.at("easing").str();
        o.set("easing", Json::string(e == "easeIn" ? "easeOut" : e == "easeOut" ? "easeIn" : e));
      }
      if (owner.at("bezier").is_array() && owner.at("bezier").arr().size() == 4) {
        const auto& b = owner.at("bezier").arr();
        Json m = Json::array();
        for (const double v : {1 - b[2].num(), 1 - b[3].num(), 1 - b[0].num(), 1 - b[1].num()}) m.arr_mut().push_back(Json::number(v));
        o.set("bezier", std::move(m));
      }
      if (!owner.at("continuous").is_undefined()) o.set("continuous", owner.at("continuous"));
    }
    out.push_back(std::move(o));
  }
  return out;
}

/// timeStretch.ts `retimeLayerKeyframes`: every keyed track but the retime
/// ones, every data track, and the whole-mask shape keys.
void retime_layer_keyframes(Document& d, const std::string& node, double scale, double offset) {
  if (scale == 1 && offset == 0) return;
  if (const NodeAnim* a = d.anim(node)) {
    const NodeAnim snap = *a;
    for (const auto& [prop, keys] : snap.tracks) {
      if (keys.empty()) continue;
      if (std::find(kRetimeProps.begin(), kRetimeProps.end(), prop) != kRetimeProps.end()) continue;
      anim_set_track(d, node, prop, retime_keys(keys, scale, offset));
    }
    for (const auto& [prop, t] : snap.data) {
      if (t.keys.empty()) continue;
      DataTrack next = t;
      next.keys = retime_data_keys(t.keys, scale, offset);
      anim_set_data_track(d, node, prop, std::move(next));
    }
  }
  if (const Node* n = d.node(node)) {
    const std::vector<Json> mk = read_node_mask_anim(*n);
    if (!mk.empty()) set_mask_anim(d, node, retime_json_keys(mk, scale, offset));
  }
}

/// layerTime.ts `moveMarkersWith`.
template <class Place>
void move_markers_with(Document& d, const std::string& layer, const std::string& comp, double anchorBefore,
                       const Place& place, double scale, bool reversed) {
  const auto bars = bars_of(d, layer, comp);
  const double anchorAfter = !bars.empty() ? bars.front()->clip.start : anchorBefore;
  std::vector<std::string> ids;
  for (const Bar* b : bars) {
    if (!b->markers.empty()) ids.push_back(b->id);
  }
  if (ids.empty()) return;
  Timeline& t = d.timeline_mut(comp);
  for (const auto& id : ids) {
    for (Bar& b : t.bars) {
      if (b.id != id) continue;
      for (TMarker& m : b.markers) {
        const double from = anchorBefore + m.frame;
        const double start = reversed ? place(from + m.duration) : place(from);
        m.frame = std::max(0.0, js_round(start) - anchorAfter);
        m.duration = std::max(0.0, js_round(m.duration * std::abs(scale)));
      }
      markers_reindex(b.markers);
    }
  }
}

void footage_stretch(Document& d, const std::string& id, const std::string& comp, double stretch, Hold hold,
                     std::optional<api::Time> time) {
  const Node* n = d.node(id);
  if (n == nullptr || n->locked) return;
  const double old = get_node_layer_time(*n).stretch;
  if (old == stretch) return;
  const auto g = geoms_of(d, id, comp);
  if (!g.empty()) {
    const double fps = comp_fps(d, comp);
    const double H = hold_frame_of(g, hold, time, fps);
    const auto ts = anim_time_span(d, id);
    const double a = ts ? ts->start : 0;
    const double r = stretch / (old > 0 ? old : 100);
    const double anchor = g.front().start;
    std::vector<Geo> next;
    for (const Geo& b : g) next.push_back(stretch_clip_geometry(b, old, stretch, H, fps, a, b.sourceDuration.has_value()));
    const double s = next.front().start - (H - (H - g.front().start) * r);
    write_geoms(d, comp, id, next);
    move_markers_with(d, id, comp, anchor, [&](double f) { return H + (f - H) * r + s; }, r, false);
  }
  update_node_layer_time(d, id, [stretch](LayerTime& t) { t.stretch = stretch; });
}

void bake_stretch(Document& d, const std::string& id, const std::string& comp, double target, Hold hold,
                  std::optional<api::Time> time) {
  const Node* n = d.node(id);
  if (n == nullptr || n->locked) return;
  const double factor = target / read_baked_stretch(*n);
  if (!std::isfinite(factor) || factor == 0 || factor == 1) return;
  const auto g = geoms_of(d, id, comp);
  if (g.empty()) return;
  const double fps = comp_fps(d, comp);
  const double H = hold_frame_of(g, hold, time, fps);
  const auto plan = bake_stretch_geometry(g, factor, H, fps);
  if (!plan) return;
  const double anchor = g.front().start;
  write_geoms(d, comp, id, plan->bars);
  move_markers_with(d, id, comp, anchor, [&](double f) { return plan->place(f); }, factor, factor < 0);
  retime_layer_keyframes(d, id, plan->keyScale, plan->keyOffset);
  sg_set_fx(d, id, "bakedStretch", target == 100 ? Json() : Json::number(target));
}

}  // namespace

ResultOf<api::UnfreezeLayers> handle(const api::UnfreezeLayers& c, HCtx& x) {
  Document& d = x.d;
  if (c.layers.empty()) fail(ErrorCode::invalid_argument, "no layers given");
  const std::set<std::string, std::less<>> uniq(c.layers.begin(), c.layers.end());
  if (uniq.size() != c.layers.size()) fail(ErrorCode::invalid_argument, "a layer is listed twice");
  for (const auto& id : c.layers) {
    (void)require_layer(d, id);
    ensure_timeline(d, *comp_of_layer(d, id));
  }
  x.label = "Unfreeze Frame";
  for (const auto& id : c.layers) {
    if (get_node_layer_time(*d.node(id)).freeze) update_node_layer_time(d, id, [](LayerTime& t) { t.freeze = false; });
  }
  return {};
}

ResultOf<api::TimeStretchLayers> handle(const api::TimeStretchLayers& c, HCtx& x) {
  Document& d = x.d;
  if (c.layers.empty()) fail(ErrorCode::invalid_argument, "no layers given");
  const std::set<std::string, std::less<>> uniq(c.layers.begin(), c.layers.end());
  if (uniq.size() != c.layers.size()) fail(ErrorCode::invalid_argument, "a layer is listed twice");
  const double whole = std::isfinite(c.stretch) ? js_round(std::abs(c.stretch) * 100) : 0;
  if (!(whole >= 1 && whole <= 1000)) fail(ErrorCode::out_of_range, "stretch must be within ±0.01…±10 and not 0");
  if (c.hold == api::StretchHold::current_frame && !c.time) {
    fail(ErrorCode::invalid_argument, "holding the current frame needs a time");
  }
  const double pct = clamp_signed_stretch(c.stretch * 100);
  const Hold hold = c.hold == api::StretchHold::in_point    ? Hold::in
                    : c.hold == api::StretchHold::out_point ? Hold::out
                                                            : Hold::current;
  struct P {
    std::string id;
    std::string comp;
    bool footage = false;
  };
  std::vector<P> plans;
  for (const auto& id : c.layers) {
    const Node& n = require_layer(d, id);
    const std::string comp = *comp_of_layer(d, id);
    const bool footage = is_retimable(n);
    if (footage && pct < 0) {
      fail(ErrorCode::out_of_range, "footage cannot take a negative stretch (reverse it with Time-Reverse Layer)", {.layer = id});
    }
    plans.push_back(P{id, comp, footage});
    ensure_timeline(d, comp);
  }
  x.label = "Time Stretch";
  for (const P& p : plans) {
    if (!p.footage) bake_stretch(d, p.id, p.comp, pct, hold, c.time);
  }
  for (const P& p : plans) {
    if (p.footage) footage_stretch(d, p.id, p.comp, clamp_stretch(pct), hold, c.time);
  }
  std::vector<std::string> ids;
  for (const P& p : plans) ids.push_back(p.id);
  stamp_nodes(x, ids);
  return {};
}

ResultOf<api::RippleDeleteRange> handle(const api::RippleDeleteRange& c, HCtx& x) {
  Document& d = x.d;
  require_comp(d, c.comp);
  if (c.range.duration <= 0 || c.range.start < 0) fail(ErrorCode::out_of_range, "the range must be a positive span of the composition");
  if (!c.layers.empty() && require_layers_in_one_comp(d, c.layers) != c.comp) {
    fail(ErrorCode::invalid_argument, "the layers are not in that composition");
  }
  ensure_timeline(d, c.comp);
  const double fps = comp_fps(d, c.comp);
  const double s = flicks_to_frames(c.range.start, fps);
  const double e = flicks_to_frames(c.range.start + c.range.duration, fps);
  const std::set<std::string, std::less<>> only(c.layers.begin(), c.layers.end());
  const auto cuttable = [&](const std::string& id) {
    const Node* n = d.node(id);
    return n != nullptr && !n->locked && (only.empty() || only.contains(id));
  };
  std::vector<std::pair<std::string, std::string>> newIds;
  if (e > s) {
    for (const auto& id : layer_ids_of_comp(d, c.comp)) {
      const auto g = geoms_of(d, id, c.comp);
      if (g.empty() || !cuttable(id)) continue;
      const Span sp = span(g);
      if (sp.in < s && sp.out > e) newIds.emplace_back(id, x.mint_id("layer_"));
    }
  }
  x.label = "Delete Time Range";
  api::LayerList out;
  if (e <= s) return out;
  for (const auto& id : layer_ids_of_comp(d, c.comp)) {
    if (d.node(id) == nullptr) continue;
    const auto g = geoms_of(d, id, c.comp);
    if (g.empty() || !cuttable(id)) continue;
    const Span sp = span(g);
    if (sp.out <= s || sp.in >= e) continue;
    if (sp.in >= s && sp.out <= e) {
      (void)delete_layer_node(d, id);
      tl_sync_from_scene(d, c.comp);
      continue;
    }
    if (sp.in < s && sp.out > e) {
      std::string newId;
      for (const auto& [k, v] : newIds) {
        if (k == id) newId = v;
      }
      (void)clone_layer_node(d, id, newId);
      remint_key_ids(x, newId);
      tl_sync_from_scene(d, c.comp);
      write_geoms(d, c.comp, id, trim_out(g, s));
      write_geoms(d, c.comp, newId, trim_in(g, e));
      continue;
    }
    if (sp.in < s) write_geoms(d, c.comp, id, trim_out(g, s));
    else write_geoms(d, c.comp, id, trim_in(g, e));
  }
  const double width = e - s;
  for (const auto& id : layer_ids_of_comp(d, c.comp)) {
    const Node* n = d.node(id);
    if (n == nullptr || n->locked) continue;
    const auto g = geoms_of(d, id, c.comp);
    if (g.empty() || g.front().start < e) continue;
    write_geoms(d, c.comp, id, shift(g, -width));
  }
  for (const auto& [k, v] : newIds) out.layers.push_back(v);
  return out;
}

ResultOf<api::ShiftLayerKeyframes> handle(const api::ShiftLayerKeyframes& c, HCtx& x) {
  Document& d = x.d;
  if (c.items.empty()) fail(ErrorCode::invalid_argument, "no layers given");
  std::set<std::string, std::less<>> seen;
  for (const auto& it : c.items) {
    (void)require_layer(d, it.layer);
    if (seen.contains(it.layer)) fail(ErrorCode::invalid_argument, "a layer is listed twice", {.layer = it.layer});
    seen.insert(it.layer);
  }
  x.label = "Shift Keyframes";
  for (const auto& it : c.items) {
    const double dt = flicks_to_seconds(it.delta);
    if (dt != 0) retime_layer_keyframes(d, it.layer, 1, dt);
  }
  return {};
}

// ── B3z: cut transitions — src/core/engine/handlers/transitions.ts ──────────

namespace {

std::string kind_str(api::TransitionKind k) {
  switch (k) {
    case api::TransitionKind::dip_to_black: return "dipToBlack";
    case api::TransitionKind::dip_to_white: return "dipToWhite";
    case api::TransitionKind::wipe: return "wipe";
    case api::TransitionKind::cross_dissolve: break;
  }
  return "crossDissolve";
}

std::string align_str(api::TransitionAlignment a) {
  switch (a) {
    case api::TransitionAlignment::start_at_cut: return "startAtCut";
    case api::TransitionAlignment::end_at_cut: return "endAtCut";
    case api::TransitionAlignment::centred: break;
  }
  return "centred";
}

std::string label_of_kind(const Json& kind) {
  const std::string k = kind.is_string() ? kind.str() : "";
  if (k == "crossDissolve") return "Cross Dissolve";
  if (k == "dipToBlack") return "Dip to Black";
  if (k == "dipToWhite") return "Dip to White";
  if (k == "wipe") return "Wipe";
  return "Transition";
}

/// A string field of a record, "" when absent (the TS reads it as undefined).
std::string rstr(const Json& rec, std::string_view k) { return rec.at(k).is_string() ? rec.at(k).str() : std::string(); }

bool tx_overlaps(const std::string& kind) { return kind == "crossDissolve" || kind == "wipe"; }

struct Region {
  double before = 0;
  double after = 0;
};

Region tx_region(double durationFrames, const std::string& alignment) {
  const double n = std::max(1.0, js_round(durationFrames));
  if (alignment == "startAtCut") return {0, n};
  if (alignment == "endAtCut") return {n, 0};
  const double before = std::floor(n / 2);
  return {before, n - before};
}

std::string fx_id(const Json& rec, char side) { return "tx_" + rstr(rec, "id") + "_" + std::string(1, side); }

std::string effect_prop(const std::string& fx, std::string_view key) { return "effect." + fx + "." + std::string(key); }

std::vector<std::pair<std::string, std::string>> tx_props(const Json& rec) {
  const std::string kind = rstr(rec, "kind");
  const std::string L = rstr(rec, "leftNodeId");
  const std::string R = rstr(rec, "rightNodeId");
  if (kind == "dipToWhite") return {{L, effect_prop(fx_id(rec, 'l'), "opacity")}, {R, effect_prop(fx_id(rec, 'r'), "opacity")}};
  if (kind == "wipe") return {{R, effect_prop(fx_id(rec, 'r'), "completion")}};
  return {{L, "opacity"}, {R, "opacity"}};
}

struct CutPair {
  std::vector<Geo> left;
  std::vector<Geo> right;
  std::size_t li = 0;
  std::size_t ri = 0;
};

std::optional<CutPair> cut_pair(const Document& d, const std::string& comp, const std::string& left, const std::string& right) {
  if (left == right) return std::nullopt;
  const auto lefts = geoms_of(d, left, comp);
  const auto rights = geoms_of(d, right, comp);
  std::optional<CutPair> best;
  double bestGap = std::numeric_limits<double>::infinity();
  for (std::size_t li = 0; li < lefts.size(); ++li) {
    for (std::size_t ri = 0; ri < rights.size(); ++ri) {
      const double gap = std::abs(lefts[li].start + lefts[li].duration - rights[ri].start);
      if (gap > 1 || gap >= bestGap) continue;
      best = CutPair{lefts, rights, li, ri};
      bestGap = gap;
    }
  }
  return best;
}

/// JavaScript's `${n}` for a frame count.
std::string js_num(double v) { return stringify(Json::number(v)); }
std::string frames_text(double n) { return n == 1 ? "1 frame" : js_num(n) + " frames"; }

CutPair tx_check(const Document& d, const std::string& comp, const Json& rec) {
  const std::string L = rstr(rec, "leftNodeId");
  const std::string R = rstr(rec, "rightNodeId");
  auto pair = cut_pair(d, comp, L, R);
  if (!pair) fail(ErrorCode::invalid_argument, "Those two layers no longer meet at a cut.");
  const Node* ln = d.node(L);
  const Node* rn = d.node(R);
  if ((ln != nullptr && ln->locked) || (rn != nullptr && rn->locked)) fail(ErrorCode::locked, "One of the two layers is locked.");
  const std::string kind = rstr(rec, "kind");
  if (!tx_overlaps(kind)) return *pair;
  const Geo& l = pair->left[pair->li];
  const Geo& r = pair->right[pair->ri];
  const double inf = std::numeric_limits<double>::infinity();
  const double leftTail = !l.sourceDuration ? inf : std::max(0.0, *l.sourceDuration - (l.sourceIn + l.duration));
  const double rightHead = std::min(!r.sourceDuration ? inf : std::max(0.0, r.sourceIn), r.start);
  const double frames = rec.at("durationFrames").is_number() ? rec.at("durationFrames").num() : 0;
  const Region rg = tx_region(frames, rstr(rec, "alignment"));
  const std::string label = label_of_kind(rec.at("kind"));
  const std::string n = frames_text(js_round(frames));
  if (rg.after > leftTail) {
    fail(ErrorCode::out_of_range, "Not enough handle for a " + n + " " + label + ": the outgoing clip has " + frames_text(leftTail) +
                                      " of source after its out-point and needs " + frames_text(rg.after) +
                                      ". Trim it shorter, shorten the transition, or align it to end at the cut.");
  }
  if (rg.before > rightHead) {
    fail(ErrorCode::out_of_range, "Not enough handle for a " + n + " " + label + ": the incoming clip has " + frames_text(rightHead) +
                                      " of source before its in-point and needs " + frames_text(rg.before) +
                                      ". Trim it shorter, shorten the transition, or align it to start at the cut.");
  }
  return *pair;
}

Json clip_json(const Geo& g) {
  Json o = Json::object();
  o.set("start", Json::number(g.start));
  o.set("duration", Json::number(g.duration));
  o.set("sourceIn", Json::number(g.sourceIn));
  o.set("sourceDuration", g.sourceDuration ? Json::number(*g.sourceDuration) : Json::null());
  return o;
}

Json capture_before(const Document& d, const std::string& comp, const Json& rec) {
  const std::vector<std::string> nodes{rstr(rec, "leftNodeId"), rstr(rec, "rightNodeId")};
  Json bars = Json::array();
  for (const auto& nodeId : nodes) {
    const auto g = geoms_of(d, nodeId, comp);
    for (std::size_t i = 0; i < g.size(); ++i) {
      Json b = Json::object();
      b.set("nodeId", Json::string(nodeId));
      b.set("index", Json::number(static_cast<double>(i)));
      b.set("clip", clip_json(g[i]));
      bars.arr_mut().push_back(std::move(b));
    }
  }
  Json tracks = Json::array();
  for (const auto& [nodeId, prop] : tx_props(rec)) {
    Json t = Json::object();
    t.set("nodeId", Json::string(nodeId));
    t.set("prop", Json::string(prop));
    Json keys = Json::array();
    if (const auto* kfs = anim_track(d, nodeId, prop)) {
      for (const Key& k : *kfs) keys.arr_mut().push_back(key_to_json(k));
    }
    t.set("keyframes", std::move(keys));
    tracks.arr_mut().push_back(std::move(t));
  }
  Json effects = Json::array();
  for (const auto& nodeId : nodes) {
    Json e = Json::object();
    e.set("nodeId", Json::string(nodeId));
    Json stack = Json::array();
    for (Json& fx : get_node_effects(d, nodeId)) stack.arr_mut().push_back(std::move(fx));
    e.set("stack", std::move(stack));
    effects.arr_mut().push_back(std::move(e));
  }
  Json snap = Json::object();
  snap.set("bars", std::move(bars));
  snap.set("tracks", std::move(tracks));
  snap.set("effects", std::move(effects));
  return snap;
}

Geo tx_trim_end(Geo g, double newEnd) {
  double end = std::max(newEnd, g.start + 1);
  if (g.sourceDuration) end = std::min(end, g.start + (*g.sourceDuration - g.sourceIn));
  g.duration = end - g.start;
  return g;
}

Geo tx_trim_start(Geo g, double newStart) {
  const double tail = g.start + g.duration;
  double start = std::min(newStart, tail - 1);
  if (g.sourceDuration) start = std::max(start, g.start - g.sourceIn);
  const double delta = start - g.start;
  g.start = start;
  g.duration = tail - start;
  g.sourceIn = g.sourceIn + delta;
  return g;
}

void tx_add_effect(Document& d, const std::string& node, std::string_view type, const std::string& id) {
  const EffectDef* def = registry().effect(type);
  if (def == nullptr) return;
  std::vector<Json> effects = get_node_effects(d, node);
  // effects.ts addEffect: the requested id unless taken (a transition's ids are unique).
  Json e = Json::object();
  e.set("id", Json::string(id));
  e.set("type", Json::string(std::string(type)));
  e.set("params", new_instance_params_of(*def));
  effects.push_back(std::move(e));
  write_node_effects(d, node, std::move(effects));
}

/// `materialize(comp, rec)`: returns the record with its `before` snapshot.
Json tx_materialize(HCtx& x, const std::string& comp, const Json& rec) {
  Document& d = x.d;
  const CutPair pair = tx_check(d, comp, rec);
  const double fps = comp_fps(d, comp);
  const double cutFrame = pair.left[pair.li].start + pair.left[pair.li].duration;
  const double frames = rec.at("durationFrames").is_number() ? rec.at("durationFrames").num() : 0;
  const Region rg = tx_region(frames, rstr(rec, "alignment"));
  Json snapshot = capture_before(d, comp, rec);
  const double startFrame = cutFrame - rg.before;
  const double endFrame = cutFrame + rg.after;
  const std::string L = rstr(rec, "leftNodeId");
  const std::string R = rstr(rec, "rightNodeId");
  const std::string kind = rstr(rec, "kind");
  if (tx_overlaps(kind)) {
    auto left = pair.left;
    auto right = pair.right;
    if (rg.after > 0) left[pair.li] = tx_trim_end(left[pair.li], left[pair.li].start + left[pair.li].duration + rg.after);
    if (rg.before > 0) right[pair.ri] = tx_trim_start(right[pair.ri], right[pair.ri].start - rg.before);
    write_geoms(d, comp, L, left);
    write_geoms(d, comp, R, right);
  }
  const auto key = [&](const std::string& node, const std::string& prop, double frame, double value, bool atEnd) {
    const double t = atEnd ? comp_to_keyframe_time(d, x.view, node, (frame - 1) / fps) + 1 / fps
                           : comp_to_keyframe_time(d, x.view, node, frame / fps);
    anim_set_keyframe(d, node, prop, t, value);
  };
  if (kind == "dipToBlack") {
    if (rg.before > 0) {
      key(L, "opacity", startFrame, 100, false);
      key(L, "opacity", cutFrame, 0, true);
    }
    if (rg.after > 0) {
      key(R, "opacity", cutFrame, 0, false);
      key(R, "opacity", endFrame, 100, false);
    }
  } else if (kind == "dipToWhite") {
    const std::string lf = fx_id(rec, 'l');
    const std::string rf = fx_id(rec, 'r');
    if (rg.before > 0) {
      tx_add_effect(d, L, "fill", lf);
      update_effect_param(d, L, lf, "color", Json::string("#ffffff"));
      update_effect_param(d, L, lf, "opacity", Json::number(0));
    }
    if (rg.after > 0) {
      tx_add_effect(d, R, "fill", rf);
      update_effect_param(d, R, rf, "color", Json::string("#ffffff"));
      update_effect_param(d, R, rf, "opacity", Json::number(0));
    }
    if (rg.before > 0) {
      key(L, effect_prop(lf, "opacity"), startFrame, 0, false);
      key(L, effect_prop(lf, "opacity"), cutFrame, 100, true);
    }
    if (rg.after > 0) {
      key(R, effect_prop(rf, "opacity"), cutFrame, 100, false);
      key(R, effect_prop(rf, "opacity"), endFrame, 0, false);
    }
  } else if (kind == "wipe") {
    const std::string rf = fx_id(rec, 'r');
    tx_add_effect(d, R, "linear-wipe", rf);
    update_effect_param(d, R, rf, "completion", Json::number(100));
    key(R, effect_prop(rf, "completion"), startFrame, 100, false);
    key(R, effect_prop(rf, "completion"), endFrame, 0, false);
  } else if (kind == "crossDissolve") {
    key(L, "opacity", startFrame, 100, false);
    key(L, "opacity", endFrame, 0, true);
    key(R, "opacity", startFrame, 0, false);
    key(R, "opacity", endFrame, 100, false);
  }
  Json out = rec;
  out.erase("before");
  out.set("before", std::move(snapshot));
  return out;
}

/// `dematerialize(comp, rec)`: effects, then tracks, then bars.
void tx_dematerialize(Document& d, const std::string& comp, const Json& rec) {
  const Json& snap = rec.at("before");
  if (!snap.is_object()) return;
  if (snap.at("effects").is_array()) {
    for (const Json& e : snap.at("effects").arr()) {
      const std::string node = rstr(e, "nodeId");
      if (d.node(node) == nullptr) continue;
      std::vector<Json> stack;
      if (e.at("stack").is_array()) stack = e.at("stack").arr();
      write_node_effects(d, node, std::move(stack));
    }
  }
  if (snap.at("tracks").is_array()) {
    for (const Json& t : snap.at("tracks").arr()) {
      const std::string node = rstr(t, "nodeId");
      if (d.node(node) == nullptr) continue;
      std::vector<Key> keys;
      if (t.at("keyframes").is_array()) {
        for (const Json& k : t.at("keyframes").arr()) {
          if (auto kk = key_from_json(k)) keys.push_back(std::move(*kk));
        }
      }
      anim_set_track(d, node, rstr(t, "prop"), std::move(keys));
    }
  }
  if (snap.at("bars").is_array()) {
    std::vector<std::pair<std::string, std::vector<Geo>>> byNode;
    for (const Json& b : snap.at("bars").arr()) {
      const std::string node = rstr(b, "nodeId");
      if (d.node(node) == nullptr) continue;
      auto it = std::find_if(byNode.begin(), byNode.end(), [&](const auto& p) { return p.first == node; });
      if (it == byNode.end()) {
        byNode.emplace_back(node, geoms_of(d, node, comp));
        it = std::prev(byNode.end());
      }
      const double idx = b.at("index").is_number() ? b.at("index").num() : -1;
      if (!(idx >= 0) || idx >= static_cast<double>(it->second.size())) continue;
      const Json& c = b.at("clip");
      Geo& g = it->second[static_cast<std::size_t>(idx)];
      g.start = c.at("start").num();
      g.duration = c.at("duration").num();
      g.sourceIn = c.at("sourceIn").num();
      g.sourceDuration = c.at("sourceDuration").is_number() ? std::optional<double>(c.at("sourceDuration").num()) : std::nullopt;
    }
    for (const auto& [node, geoms] : byNode) write_geoms(d, comp, node, geoms);
  }
}

struct Found {
  std::string comp;
  Json rec;
};

std::optional<Found> find_tx(const Document& d, const std::string& id) {
  const Json& all = d.transitions();
  if (!all.is_object()) return std::nullopt;
  for (const auto& m : all.obj()) {
    if (!m.value.is_array()) continue;
    for (const Json& rec : m.value.arr()) {
      if (rec.at("id").is_string() && rec.at("id").str() == id) return Found{m.key, rec};
    }
  }
  return std::nullopt;
}

Found require_tx(const Document& d, const std::string& id) {
  auto f = find_tx(d, id);
  if (!f) fail(ErrorCode::not_found, "no transition '" + id + "'");
  return *f;
}

/// transitionStore `put(comp, rec)`: replace by id in place, else append; the comp key appended when new.
void tx_put(Document& d, const std::string& comp, Json rec) {
  Json& all = d.transitions_mut();
  Json list = all.at(comp).is_array() ? all.at(comp) : Json::array();
  bool replaced = false;
  for (Json& t : list.arr_mut()) {
    if (t.at("id").is_string() && t.at("id").str() == rstr(rec, "id")) {
      t = rec;
      replaced = true;
    }
  }
  if (!replaced) list.arr_mut().push_back(std::move(rec));
  all.set(comp, std::move(list));
}

/// transitionStore `drop(comp, id)` (the comp key is kept, possibly empty).
void tx_drop(Document& d, const std::string& comp, const std::string& id) {
  Json& all = d.transitions_mut();
  Json list = Json::array();
  if (all.at(comp).is_array()) {
    for (const Json& t : all.at(comp).arr()) {
      if (!(t.at("id").is_string() && t.at("id").str() == id)) list.arr_mut().push_back(t);
    }
  }
  all.set(comp, std::move(list));
}

double tx_frames(const Document& d, const std::string& comp, api::Time flicks) {
  const double f = flicks_to_frames(flicks, comp_fps(d, comp));
  if (!std::isfinite(f) || f < 1) fail(ErrorCode::out_of_range, "a transition lasts at least one frame");
  return std::max(1.0, js_round(f));
}

}  // namespace

ResultOf<api::AddTransition> handle(const api::AddTransition& c, HCtx& x) {
  Document& d = x.d;
  const std::string comp = require_layers_in_one_comp(d, {c.left, c.right});
  const double frames = tx_frames(d, comp, c.duration);
  std::optional<Json> existing;
  if (d.transitions().at(comp).is_array()) {
    for (const Json& t : d.transitions().at(comp).arr()) {
      if (rstr(t, "leftNodeId") == c.left && rstr(t, "rightNodeId") == c.right) {
        existing = t;
        break;
      }
    }
  }
  const std::string id = x.mint_group_id("tx_", [&](const std::string& v) { return find_tx(d, v).has_value(); });
  ensure_timeline(d, comp);
  Json draft = Json::object();
  draft.set("id", Json::string(id));
  draft.set("leftNodeId", Json::string(c.left));
  draft.set("rightNodeId", Json::string(c.right));
  draft.set("kind", Json::string(kind_str(c.kind)));
  draft.set("durationFrames", Json::number(frames));
  draft.set("alignment", Json::string(align_str(c.alignment)));
  x.label = "Add " + label_of_kind(draft.at("kind"));
  if (existing) {
    tx_dematerialize(d, comp, *existing);
    tx_drop(d, comp, rstr(*existing, "id"));
  }
  tx_put(d, comp, tx_materialize(x, comp, draft));
  stamp_nodes(x, {c.left, c.right});
  return api::TransitionRef{id};
}

ResultOf<api::SetTransition> handle(const api::SetTransition& c, HCtx& x) {
  Document& d = x.d;
  const Found f = require_tx(d, c.transition);
  const std::string L = rstr(f.rec, "leftNodeId");
  const std::string R = rstr(f.rec, "rightNodeId");
  const auto lc = comp_of_layer(d, L);
  if (!lc || *lc != f.comp) fail(ErrorCode::invalid_argument, "Those two layers no longer meet at a cut.");
  (void)require_layer(d, R);
  Json next = f.rec;
  if (c.kind) next.set("kind", Json::string(kind_str(*c.kind)));
  if (c.duration) next.set("durationFrames", Json::number(tx_frames(d, f.comp, *c.duration)));
  if (c.alignment) next.set("alignment", Json::string(align_str(*c.alignment)));
  next.erase("before");
  ensure_timeline(d, f.comp);
  x.label = "Change " + label_of_kind(next.at("kind"));
  tx_dematerialize(d, f.comp, f.rec);
  tx_put(d, f.comp, tx_materialize(x, f.comp, next));
  stamp_nodes(x, {L, R});
  return {};
}

ResultOf<api::RemoveTransitions> handle(const api::RemoveTransitions& c, HCtx& x) {
  Document& d = x.d;
  if (c.transitions.empty()) fail(ErrorCode::invalid_argument, "no transitions given");
  const std::set<std::string, std::less<>> uniq(c.transitions.begin(), c.transitions.end());
  if (uniq.size() != c.transitions.size()) fail(ErrorCode::invalid_argument, "a transition is listed twice");
  std::vector<Found> found;
  for (const auto& id : c.transitions) found.push_back(require_tx(d, id));
  for (const Found& f : found) {
    if (!is_comp_item(d, f.comp)) fail(ErrorCode::not_found, "no composition '" + f.comp + "'");
    ensure_timeline(d, f.comp);
  }
  x.label = found.size() == 1 ? "Remove " + label_of_kind(found.front().rec.at("kind"))
                              : "Remove " + std::to_string(found.size()) + " Transitions";
  // Newest first (store order): a later snapshot was taken over an earlier one's output.
  const auto pos = [&](const Found& f) {
    const Json& list = d.transitions().at(f.comp);
    if (!list.is_array()) return -1.0;
    for (std::size_t i = 0; i < list.arr().size(); ++i) {
      if (rstr(list.arr()[i], "id") == rstr(f.rec, "id")) return static_cast<double>(i);
    }
    return -1.0;
  };
  std::vector<std::pair<double, std::size_t>> order;
  for (std::size_t i = 0; i < found.size(); ++i) order.emplace_back(pos(found[i]), i);
  std::stable_sort(order.begin(), order.end(), [](const auto& a, const auto& b) { return a.first > b.first; });
  for (const auto& [p, i] : order) {
    tx_dematerialize(d, found[i].comp, found[i].rec);
    tx_drop(d, found[i].comp, rstr(found[i].rec, "id"));
  }
  return {};
}

}  // namespace premation::doc
