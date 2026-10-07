#include "track_feature.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <numbers>
#include <vector>

namespace premation::jobs::feature {

namespace {

using tracking::LumaPlane;

/// Window half-sizes offered to `suggest_feature_half`, smallest first.
constexpr std::array<int, 5> kScaleLadder = {6, 8, 10, 13, 16};
/// Candidate window half-size while scanning (before scale selection).
constexpr int kScanHalf = 8;
/// Grid step between scanned candidate centres.
constexpr int kScanStride = 4;
/// Strength-ranked candidates that pay for a distinctness probe.
constexpr std::size_t kShortlist = 8;
/// Window half-size used to localise a shortlisted candidate.
constexpr int kRefineHalf = 4;
/// Below this the region is flat or edge-only.
constexpr double kMinStrength = 1e-5;
/// Distinctness floor: a tiled floor is ranked last, not erased.
constexpr double kMinDistinctness = 0.05;

// planTrack constants (autoTrack.ts).
constexpr int kProbeSearchHalf = 96;
constexpr int kAmbiguousProbeHalf = 24;
constexpr double kCorroborationTolerance = 0.4;
constexpr double kCorroborationFloorPx = 1;
constexpr int kMinSearchHalf = 8;
constexpr int kMaxSearchHalf = 64;
constexpr int kFallbackSearchHalf = 20;
constexpr double kAmbiguousBelow = 0.5;
constexpr double kCompanionReach = 0.18;
constexpr double kCompanionMinSeparation = 0.4;

std::size_t uz(int v) noexcept { return static_cast<std::size_t>(v); }

double at(const LumaPlane& p, int x, int y) noexcept {
  const int cx = std::clamp(x, 0, p.width - 1);
  const int cy = std::clamp(y, 0, p.height - 1);
  return static_cast<double>(p.data[uz(cy * p.width + cx)]);
}

std::optional<Region> clamp_region(Region r, const LumaPlane& p, int margin) {
  const Region out{std::max(margin, r.x0), std::max(margin, r.y0), std::min(p.width - 1 - margin, r.x1),
                   std::min(p.height - 1 - margin, r.y1)};
  if (out.x1 < out.x0 || out.y1 < out.y0) return std::nullopt;
  return out;
}

Region region_around(double cx, double cy, double r) {
  return {static_cast<int>(std::floor(cx - r)), static_cast<int>(std::floor(cy - r)), static_cast<int>(std::ceil(cx + r)),
          static_cast<int>(std::ceil(cy + r))};
}

double min_eigen(double a, double b, double c) noexcept {
  const double trace = a + c;
  const double gap = std::sqrt((a - c) * (a - c) + 4 * b * b);
  return (trace - gap) * 0.5;
}

/// Strength for every candidate centre on a stride grid inside `region`
/// (structure tensor over the region plus a `half` halo, integral images).
std::vector<Candidate> scan_region(const LumaPlane& plane, Region region, int half, int stride) {
  const int bx = region.x0 - half - 1;
  const int by = region.y0 - half - 1;
  const int bw = region.x1 - region.x0 + 2 * half + 3;
  const int bh = region.y1 - region.y0 + 2 * half + 3;
  const int iw = bw + 1;
  const int ih = bh + 1;
  std::vector<double> sxx(uz(iw * ih), 0.0);
  std::vector<double> sxy(uz(iw * ih), 0.0);
  std::vector<double> syy(uz(iw * ih), 0.0);
  for (int j = 0; j < bh; ++j) {
    const int py = by + j;
    double rxx = 0;
    double rxy = 0;
    double ryy = 0;
    for (int i = 0; i < bw; ++i) {
      const int px = bx + i;
      const double dx = (at(plane, px + 1, py) - at(plane, px - 1, py)) * 0.5;
      const double dy = (at(plane, px, py + 1) - at(plane, px, py - 1)) * 0.5;
      rxx += dx * dx;
      rxy += dx * dy;
      ryy += dy * dy;
      const std::size_t o = uz((j + 1) * iw + (i + 1));
      const std::size_t up = uz(j * iw + (i + 1));
      sxx[o] = sxx[up] + rxx;
      sxy[o] = sxy[up] + rxy;
      syy[o] = syy[up] + ryy;
    }
  }
  auto window = [&](const std::vector<double>& s, int i0, int j0, int i1, int j1) {
    return s[uz((j1 + 1) * iw + (i1 + 1))] - s[uz(j0 * iw + (i1 + 1))] - s[uz((j1 + 1) * iw + i0)] + s[uz(j0 * iw + i0)];
  };
  const double area = static_cast<double>((2 * half + 1) * (2 * half + 1));
  std::vector<Candidate> out;
  for (int y = region.y0; y <= region.y1; y += stride) {
    for (int x = region.x0; x <= region.x1; x += stride) {
      const int i0 = x - half - bx;
      const int j0 = y - half - by;
      const int i1 = i0 + 2 * half;
      const int j1 = j0 + 2 * half;
      const double s = min_eigen(window(sxx, i0, j0, i1, j1) / area, window(sxy, i0, j0, i1, j1) / area,
                                 window(syy, i0, j0, i1, j1) / area);
      if (s > kMinStrength) out.push_back({static_cast<double>(x), static_cast<double>(y), s, 1, s});
    }
  }
  return out;
}

/// Strength-ranked, spatially separated survivors.
std::vector<Candidate> suppress(std::vector<Candidate> c, double minSpacing, std::size_t keep) {
  std::stable_sort(c.begin(), c.end(), [](const Candidate& p, const Candidate& q) { return p.strength > q.strength; });
  std::vector<Candidate> chosen;
  const double sq = minSpacing * minSpacing;
  for (const Candidate& k : c) {
    if (chosen.size() >= keep) break;
    const bool clear = std::none_of(chosen.begin(), chosen.end(), [&](const Candidate& o) {
      return (o.x - k.x) * (o.x - k.x) + (o.y - k.y) * (o.y - k.y) < sq;
    });
    if (clear) chosen.push_back(k);
  }
  return chosen;
}

/// Move a candidate onto the corner with a Gaussian-weighted tensor (a box
/// window's response is flat-topped around a corner).
Candidate refine(const LumaPlane& plane, Candidate cand, int reach) {
  const int cx = static_cast<int>(std::lround(cand.x));
  const int cy = static_cast<int>(std::lround(cand.y));
  const int lo = kRefineHalf + 1;
  if (cx - reach - lo < 0 || cy - reach - lo < 0 || cx + reach + lo >= plane.width || cy + reach + lo >= plane.height) return cand;
  std::array<double, 2 * kRefineHalf + 1> w{};
  const double sigma = kRefineHalf / 2.0;
  for (int d = -kRefineHalf; d <= kRefineHalf; ++d) w[uz(d + kRefineHalf)] = std::exp(-(d * d) / (2 * sigma * sigma));
  double best = -1;
  for (int y = cy - reach; y <= cy + reach; ++y) {
    for (int x = cx - reach; x <= cx + reach; ++x) {
      double a = 0;
      double b = 0;
      double c = 0;
      for (int j = -kRefineHalf; j <= kRefineHalf; ++j) {
        const double wy = w[uz(j + kRefineHalf)];
        for (int i = -kRefineHalf; i <= kRefineHalf; ++i) {
          const int px = x + i;
          const int py = y + j;
          const double dx = (at(plane, px + 1, py) - at(plane, px - 1, py)) * 0.5;
          const double dy = (at(plane, px, py + 1) - at(plane, px, py - 1)) * 0.5;
          const double weight = wy * w[uz(i + kRefineHalf)];
          a += weight * dx * dx;
          b += weight * dx * dy;
          c += weight * dy * dy;
        }
      }
      const double s = min_eigen(a, b, c);
      if (s > best) {
        best = s;
        cand.x = x;
        cand.y = y;
      }
    }
  }
  // The coarse strength stays the ranking value (one scale for every candidate).
  return cand;
}

/// How far the feature moves per frame, believed only when the two-frame
/// displacement is about twice the one-frame one (a rival sits at a fixed
/// offset, not a fixed velocity).
std::optional<double> measure_motion(const LumaPlane& anchor, std::span<const LumaPlane> probes, const Candidate& f, int featureHalf,
                                     int searchHalf) {
  const std::vector<float> patch = tracking::extract_patch(anchor, f.x, f.y, featureHalf);
  if (patch.empty()) return std::nullopt;
  auto displacement = [&](std::size_t i) -> std::optional<double> {
    if (i >= probes.size()) return std::nullopt;
    const auto m = tracking::match_patch(patch, featureHalf, probes[i], f.x, f.y, searchHalf);
    if (!m || m->confidence < 0.6) return std::nullopt;
    return std::hypot(m->x - f.x, m->y - f.y);
  };
  const auto d1 = displacement(0);
  if (!d1) return std::nullopt;
  const auto d2 = displacement(1);
  if (!d2) return probes.size() > 1 ? std::nullopt : d1;
  const double tolerance = std::max(kCorroborationFloorPx, kCorroborationTolerance * *d1);
  return std::abs(*d2 / 2 - *d1) <= tolerance ? d1 : std::nullopt;
}

std::optional<Candidate> pick_companion(const LumaPlane& plane, const Candidate& primary) {
  const double reach = std::max(60.0, std::round(std::min(plane.width, plane.height) * kCompanionReach));
  const double minSep = reach * kCompanionMinSeparation;
  const auto tile = static_cast<int>(std::max(48.0, std::round(reach / 2)));
  const std::vector<Candidate> cands = pick_features(plane, 6, 24, tile, region_around(primary.x, primary.y, reach));
  for (const Candidate& c : cands) {
    if (std::hypot(c.x - primary.x, c.y - primary.y) >= minSep) return c;
  }
  return std::nullopt;
}

}  // namespace

double distinctness_at(const LumaPlane& plane, double x, double y, int half, double radius) {
  const std::vector<float> ref = tracking::extract_patch(plane, x, y, half);
  if (ref.empty()) return 0;
  const double inner = 2.0 * half + 2;
  if (radius <= inner) return 1;
  double rival = -1;
  constexpr int kRings = 3;
  for (int r = 0; r < kRings; ++r) {
    const double dist = inner + (radius - inner) * r / (kRings - 1);
    const int steps = std::max(8, static_cast<int>(std::lround(2 * std::numbers::pi * dist / std::max(4, half))));
    for (int s = 0; s < steps; ++s) {
      const double a = 2 * std::numbers::pi * s / steps;
      const std::vector<float> cand = tracking::extract_patch(plane, x + dist * std::cos(a), y + dist * std::sin(a), half);
      if (cand.empty()) continue;
      rival = std::max(rival, tracking::ncc(ref, cand));
    }
  }
  // Only positive rivals are confusable.
  return std::clamp(1 - std::max(0.0, rival), kMinDistinctness, 1.0);
}

int suggest_feature_half(const LumaPlane& plane, double x, double y) {
  const int cx = static_cast<int>(std::lround(x));
  const int cy = static_cast<int>(std::lround(y));
  std::array<double, kScaleLadder.size()> strengths{};
  double best = 0;
  for (std::size_t i = 0; i < kScaleLadder.size(); ++i) {
    const int half = kScaleLadder[i];
    const auto r = clamp_region({cx, cy, cx, cy}, plane, half + 2);
    if (!r) continue;
    const std::vector<Candidate> c = scan_region(plane, *r, half, 1);
    strengths[i] = c.empty() ? 0 : c.front().strength;
    best = std::max(best, strengths[i]);
  }
  if (best <= 0) return kScanHalf;
  for (std::size_t i = 0; i < kScaleLadder.size(); ++i) {
    if (strengths[i] >= best * 0.75) return kScaleLadder[i];
  }
  return kScaleLadder.back();
}

std::optional<Candidate> pick_feature(const LumaPlane& plane, const PickOptions& opts) {
  if (plane.width <= 0 || plane.height <= 0) return std::nullopt;
  const double shortSide = std::min(plane.width, plane.height);
  const double radius = opts.radius.value_or(std::max(48.0, std::round(shortSide * 0.12)));
  const tracking::Pt hint = opts.hint.value_or(tracking::Pt{plane.width / 2.0, plane.height / 2.0});
  const auto region = clamp_region(region_around(hint.x, hint.y, radius), plane, opts.margin);
  if (!region) return std::nullopt;
  const std::vector<Candidate> scanned = scan_region(plane, *region, kScanHalf, kScanStride);
  if (scanned.empty()) return std::nullopt;
  // Proximity bias, Gaussian at σ = radius / 2.
  const double sigmaSq = 2 * (radius / 2) * (radius / 2);
  std::optional<Candidate> best;
  for (const Candidate& coarse : suppress(scanned, kScanHalf * 2.0, kShortlist)) {
    Candidate c = refine(plane, coarse, kScanHalf);
    c.distinctness = distinctness_at(plane, c.x, c.y, kScanHalf, radius);
    const double dSq = (c.x - hint.x) * (c.x - hint.x) + (c.y - hint.y) * (c.y - hint.y);
    c.score = c.strength * c.distinctness * std::exp(-dSq / sigmaSq);
    if (!best || c.score > best->score) best = c;
  }
  if (best && best->score > 0) return best;
  return std::nullopt;
}

std::vector<Candidate> pick_features(const LumaPlane& plane, int count, int margin, int tile, std::optional<Region> within) {
  if (count <= 0 || plane.width <= 0 || plane.height <= 0 || tile <= 0) return {};
  const auto bounds = clamp_region(within.value_or(Region{0, 0, plane.width - 1, plane.height - 1}), plane, margin);
  if (!bounds) return {};
  std::vector<Candidate> perTile;
  for (int ty = bounds->y0; ty <= bounds->y1; ty += tile) {
    for (int tx = bounds->x0; tx <= bounds->x1; tx += tile) {
      const auto r = clamp_region({tx, ty, std::min(tx + tile - 1, bounds->x1), std::min(ty + tile - 1, bounds->y1)}, plane, margin);
      if (!r) continue;
      const std::vector<Candidate> top = suppress(scan_region(plane, *r, kScanHalf, kScanStride), kScanHalf * 2.0, 1);
      if (!top.empty()) perTile.push_back(top.front());
    }
  }
  std::stable_sort(perTile.begin(), perTile.end(), [](const Candidate& p, const Candidate& q) { return p.strength > q.strength; });
  if (perTile.size() > static_cast<std::size_t>(count) * 2) perTile.resize(static_cast<std::size_t>(count) * 2);
  std::vector<Candidate> out;
  for (const Candidate& coarse : perTile) {
    Candidate c = refine(plane, coarse, kScanHalf);
    c.distinctness = distinctness_at(plane, c.x, c.y, kScanHalf, tile / 2.0);
    c.score = c.strength * c.distinctness;
    if (c.score > 0) out.push_back(c);
  }
  std::stable_sort(out.begin(), out.end(), [](const Candidate& p, const Candidate& q) { return p.score > q.score; });
  if (out.size() > static_cast<std::size_t>(count)) out.resize(static_cast<std::size_t>(count));
  return out;
}

std::optional<Plan> plan_track(const LumaPlane& anchor, std::span<const LumaPlane> probes, const PickOptions& opts) {
  const std::optional<Candidate> f = pick_feature(anchor, opts);
  if (!f) return std::nullopt;
  Plan plan;
  plan.feature = *f;
  plan.x = f->x;
  plan.y = f->y;
  plan.featureHalf = suggest_feature_half(anchor, f->x, f->y);
  // Ambiguous features get a tighter window, and a narrower motion probe, so
  // the rival that made them ambiguous stays outside it.
  const bool ambiguous = f->distinctness < kAmbiguousBelow;
  plan.motionPerFrame = measure_motion(anchor, probes, *f, plan.featureHalf, ambiguous ? kAmbiguousProbeHalf : kProbeSearchHalf);
  const int search = plan.motionPerFrame
                         ? static_cast<int>(std::lround(*plan.motionPerFrame * (ambiguous ? 1.5 : 2.5))) + (ambiguous ? 4 : 8)
                         : kFallbackSearchHalf;
  plan.searchHalf = std::clamp(search, kMinSearchHalf, kMaxSearchHalf);
  plan.companion = pick_companion(anchor, *f);
  return plan;
}

}  // namespace premation::jobs::feature
