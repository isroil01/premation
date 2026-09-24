// Retime for the scene builder: src/core/animation/retime.ts (hasRetime,
// pickRetimeBar, retimeClipOf, the Speed % integral, retimedChainTime), call
// for call. The engine's edit handlers carry their own copy of the integral
// (core/handlers_layertime.cpp, over the handler context); this one reads the
// document the snapshot reads.
#include <algorithm>
#include <cmath>
#include <limits>
#include <string_view>
#include <vector>

#include "anim.hpp"
#include "misc_port.hpp"

namespace premation::scene {
namespace {

constexpr std::string_view kSpeedProp = "timeSpeed";
constexpr std::string_view kRemapProp = "timeRemap";
constexpr std::string_view kLegacyRemapProp = "precompTime";
/// Panels per eased segment (EASED_PANELS).
constexpr int kEasedPanels = 64;

struct Segment {
  double t0 = 0, t1 = 0, v0 = 0, v1 = 0;
  enum class Kind : std::uint8_t { hold, linear, sampled } kind = Kind::linear;
  std::vector<double> cum;
  std::vector<double> vals;
};

struct SpeedTable {
  double firstT = 0, firstV = 0, lastT = 0, lastV = 0;
  std::vector<Segment> segments;
  std::vector<double> startCum;
};

bool is_hold(const std::optional<api::Easing>& e) { return e && (*e == api::Easing::step || *e == api::Easing::hold); }

/// buildTable (tableFor without the cache: the snapshot asks a handful of times).
std::optional<SpeedTable> table_for(const RetimeReader& r, std::string_view node) {
  const std::vector<doc::Key>* track = doc::anim_track(r.d, node, kSpeedProp);
  if (track == nullptr || track->empty()) return std::nullopt;
  std::vector<doc::Key> sorted = *track;
  std::stable_sort(sorted.begin(), sorted.end(), [](const doc::Key& a, const doc::Key& b) { return a.t < b.t; });
  SpeedTable table;
  double cum = 0;
  for (std::size_t i = 0; i + 1 < sorted.size(); ++i) {
    const doc::Key& a = sorted[i];
    const doc::Key& b = sorted[i + 1];
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
      constexpr auto kP = static_cast<std::size_t>(kEasedPanels);
      s.vals.assign(kP + 1, 0);
      s.cum.assign(kP + 1, 0);
      for (std::size_t j = 0; j <= kP; ++j) {
        const double t = a.t + (len * static_cast<double>(j)) / kEasedPanels;
        double v = 0;
        if (j == 0) v = a.value;
        else if (j == kP) v = b.value;
        else v = doc::anim_sample(r.d, r.expr, r.cache, node, kSpeedProp, t).value_or(a.value);
        s.vals[j] = v / 100;
      }
      const double h = len / kEasedPanels;
      for (std::size_t j = 1; j <= kP; ++j) s.cum[j] = s.cum[j - 1] + ((s.vals[j - 1] + s.vals[j]) / 2) * h;
      cum += s.cum[kP];
    }
    table.segments.push_back(std::move(s));
  }
  table.firstT = sorted.front().t;
  table.firstV = sorted.front().value / 100;
  table.lastT = sorted.back().t;
  table.lastV = sorted.back().value / 100;
  return table;
}

double segment_integral(const Segment& s, double x) {
  const double d = x - s.t0;
  if (d <= 0) return 0;
  const double len = s.t1 - s.t0;
  if (s.kind == Segment::Kind::hold) return s.v0 * d;
  if (s.kind == Segment::Kind::linear) return s.v0 * d + ((s.v1 - s.v0) * d * d) / (2 * len);
  const double h = len / kEasedPanels;
  const double jj = std::min(static_cast<double>(kEasedPanels - 1), std::floor(d / h));
  const auto j = static_cast<std::size_t>(jj);
  const double into = d - jj * h;
  const double va = s.vals[j];
  const double vb = s.vals[j + 1];
  return s.cum[j] + va * into + ((vb - va) * into * into) / (2 * h);
}

double cumulative_at(const SpeedTable& t, double x) {
  if (x <= t.firstT) return (x - t.firstT) * t.firstV;
  const auto& segs = t.segments;
  if (segs.empty() || x >= t.lastT) {
    const double total = segs.empty() ? 0 : t.startCum[segs.size() - 1] + segment_integral(segs.back(), segs.back().t1);
    return total + (x - t.lastT) * t.lastV;
  }
  for (std::size_t i = 0; i < segs.size(); ++i) {
    const Segment& s = segs[i];
    if (x <= s.t1) return t.startCum[i] + segment_integral(s, std::max(s.t0, x));
  }
  return 0;
}

double speed_advance(const RetimeReader& r, std::string_view node, double a, double b) {
  const auto table = table_for(r, node);
  if (!table) return b - a;
  return cumulative_at(*table, b) - cumulative_at(*table, a);
}

}  // namespace

bool has_retime(const doc::Document& d, std::string_view node) {
  return doc::anim_is_animated(d, node, kSpeedProp) || doc::anim_is_animated(d, node, kRemapProp) ||
         doc::anim_is_animated(d, node, kLegacyRemapProp);
}

const doc::Bar* pick_retime_bar(const std::vector<const doc::Bar*>& bars, double frame) {
  const doc::Bar* best = nullptr;
  double bestDist = std::numeric_limits<double>::infinity();
  for (const doc::Bar* b : bars) {
    const double start = b->clip.start;
    const double end = b->clip.end();
    if (frame >= start && frame < end) return b;
    const double dist = frame < start ? start - frame : frame - (end - 1);
    if (dist < bestDist) {
      bestDist = dist;
      best = b;
    }
  }
  return best;
}

std::optional<RetimeClip> retime_clip_of(const doc::Bar* bar, double fps) {
  if (bar == nullptr || !(fps > 0)) return std::nullopt;
  return RetimeClip{(bar->clip.sourceIn - bar->clip.start) / fps, bar->clip.start / fps};
}

std::optional<double> retimed_chain_time(const RetimeReader& r, std::string_view node, double t,
                                         const std::optional<RetimeClip>& clip) {
  if (doc::anim_is_animated(r.d, node, kSpeedProp)) {
    const double off = clip ? clip->offsetSec : 0;
    const double uIn = clip ? clip->inSec + off : 0;
    const double source = uIn + speed_advance(r, node, uIn, t + off);
    return source - off;
  }
  if (doc::anim_is_animated(r.d, node, kRemapProp)) return doc::anim_sample(r.d, r.expr, r.cache, node, kRemapProp, t);
  if (doc::anim_is_animated(r.d, node, kLegacyRemapProp)) {
    return doc::anim_sample(r.d, r.expr, r.cache, node, kLegacyRemapProp, t);
  }
  return std::nullopt;
}

}  // namespace premation::scene
