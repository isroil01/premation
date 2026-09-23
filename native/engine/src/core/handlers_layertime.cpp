#include "handlers_layertime.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <optional>
#include <set>
#include <utility>

#include "anim.hpp"
#include "jsmath.hpp"
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
  if (g.sourceIn < 0) fail(ErrorCode::out_of_range, "layer '" + layer + "' would start before its source", {.layer = layer});
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
    const double o1 = comp_to_keyframe_time(d, x.view, p.out, t1);
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

}  // namespace premation::doc
