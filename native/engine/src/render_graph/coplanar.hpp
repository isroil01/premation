// Coplanar 3D layers stack in layer order, as in After Effects.
//
// A depth buffer compares each layer's own interpolated depth, so two layers
// on one plane (a card on a panel, a 2.5D comp with everything at z = 0) tie
// to within rounding and fight pixel by pixel in a pattern that moves every
// frame: the upper layer blinks in and out (renderArtifacts.bench.test.ts,
// 47 000 px of a 135 000 px card lost on one frame). AE draws such layers in
// stacking order. Two halves here:
//
//   coplanar_clusters  the scene's depth sort (threed_port.cpp) keeps every
//                      cluster of coplanar, overlapping layers together and in
//                      stack order, so the upper layer's anti-aliased edge
//                      blends over the lower one instead of the background;
//   coplanar_levels    the renderer (threed.cpp) lifts each level of a
//                      cluster towards the camera by kCoplanarDepthStep of its
//                      depth, so the upper layer wins the depth test.
//
// Only layers that overlap get a level, so a hundred unrelated layers at
// z = 0 never pile up an offset against the rest of the scene.
#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <numeric>
#include <span>
#include <unordered_map>
#include <utility>
#include <vector>

namespace premation::rg {

/// One level's lift, as a fraction of the depth (the renderer's depth is
/// reversed float: about 1e-7 of the distance is its noise, so this is ~30×
/// that and 0.01 px at a typical 2 700 px camera distance).
inline constexpr double kCoplanarDepthStep = 1.0 / 262144.0;
/// Levels beyond this share the top one (a stack that deep fights again, and the lift stays under 0.1 %).
inline constexpr std::uint32_t kCoplanarMaxLevel = 255;
/// Planes closer than this (px) are one plane.
inline constexpr double kCoplanarTolerancePx = 0.01;
/// Overlap slack (px): edges that touch still blend into each other.
inline constexpr double kCoplanarOverlapPx = 0.5;

/// A layer's unit-quad model: column-major 4×4 mapping [0,1]² at z = 0 to world.
using QuadModel = std::array<double, 16>;

/// A planar layer's plane and world box, from its unit-quad model. `ok` false =
/// degenerate or not given.
struct CoplanarPlane {
  std::array<double, 3> n{};
  double d = 0;
  std::array<double, 3> lo{}, hi{};
  bool ok = false;
};

inline CoplanarPlane coplanar_plane(const QuadModel* model) {
  CoplanarPlane p;
  if (model == nullptr) return p;
  const QuadModel& m = *model;
  const std::array<double, 3> ax{m[0], m[1], m[2]};
  const std::array<double, 3> ay{m[4], m[5], m[6]};
  const std::array<double, 3> o{m[12], m[13], m[14]};
  std::array<double, 3> n{ax[1] * ay[2] - ax[2] * ay[1], ax[2] * ay[0] - ax[0] * ay[2], ax[0] * ay[1] - ax[1] * ay[0]};
  const double len = std::hypot(n[0], n[1], n[2]);
  if (!(len > 1e-12) || !std::isfinite(len) || m[15] == 0) return p;
  for (double& c : n) c /= len;
  // One sign per plane: a layer seen from behind is still on it.
  const std::size_t big = std::abs(n[0]) >= std::abs(n[1]) && std::abs(n[0]) >= std::abs(n[2]) ? 0 : std::abs(n[1]) >= std::abs(n[2]) ? 1 : 2;
  if (n[big] < 0) {
    for (double& c : n) c = -c;
  }
  p.n = n;
  p.d = n[0] * o[0] + n[1] * o[1] + n[2] * o[2];
  for (std::size_t k = 0; k < 3; ++k) {
    const double a = o.at(k), b = o.at(k) + ax.at(k), c = o.at(k) + ay.at(k), e = o.at(k) + ax.at(k) + ay.at(k);
    p.lo.at(k) = std::min({a, b, c, e});
    p.hi.at(k) = std::max({a, b, c, e});
  }
  p.ok = std::isfinite(p.d);
  return p;
}

namespace coplanar_detail {

/// Pairs (i, j), i < j, of quads that share a plane and whose boxes overlap.
/// Bucketed by plane, then swept along x: O(n log n + pairs), so ten thousand
/// layers on one plane stay cheap unless they all overlap.
inline std::vector<std::pair<std::uint32_t, std::uint32_t>> overlapping_pairs(const std::vector<CoplanarPlane>& planes) {
  struct Key {
    std::int64_t a, b, c, d;
    bool operator==(const Key&) const = default;
  };
  struct Hash {
    std::size_t operator()(const Key& k) const noexcept {
      std::uint64_t h = 1469598103934665603ULL;
      for (const std::int64_t v : {k.a, k.b, k.c, k.d}) h = (h ^ static_cast<std::uint64_t>(v)) * 1099511628211ULL;
      return static_cast<std::size_t>(h);
    }
  };
  std::unordered_map<Key, std::vector<std::uint32_t>, Hash> buckets;
  for (std::uint32_t i = 0; i < planes.size(); ++i) {
    const CoplanarPlane& p = planes[i];
    if (!p.ok) continue;
    const Key k{std::llround(p.n[0] * 1e6), std::llround(p.n[1] * 1e6), std::llround(p.n[2] * 1e6), std::llround(p.d / kCoplanarTolerancePx)};
    buckets[k].push_back(i);
  }
  std::vector<std::pair<std::uint32_t, std::uint32_t>> out;
  // A pathological stack (thousands of full-frame layers on one plane) stops
  // adding pairs here rather than spending the frame on them.
  constexpr std::size_t kMaxPairs = 1U << 20U;
  for (auto& [key, ids] : buckets) {
    if (ids.size() < 2) continue;
    std::ranges::sort(ids, [&](std::uint32_t a, std::uint32_t b) { return planes[a].lo[0] < planes[b].lo[0]; });
    std::vector<std::uint32_t> active;
    for (const std::uint32_t i : ids) {
      const CoplanarPlane& p = planes[i];
      std::erase_if(active, [&](std::uint32_t j) { return planes[j].hi[0] + kCoplanarOverlapPx < p.lo[0]; });
      for (const std::uint32_t j : active) {
        const CoplanarPlane& q = planes[j];
        if (p.lo[1] > q.hi[1] + kCoplanarOverlapPx || q.lo[1] > p.hi[1] + kCoplanarOverlapPx) continue;
        if (p.lo[2] > q.hi[2] + kCoplanarOverlapPx || q.lo[2] > p.hi[2] + kCoplanarOverlapPx) continue;
        if (std::abs(p.d - q.d) > kCoplanarTolerancePx) continue;
        if (out.size() >= kMaxPairs) return out;
        out.emplace_back(std::min(i, j), std::max(i, j));
      }
      active.push_back(i);
    }
  }
  return out;
}

}  // namespace coplanar_detail

/// For quads in draw order (null = not a planar quad): each one's level — 0
/// for a quad over no earlier coplanar quad, else one above the highest
/// earlier coplanar quad it overlaps (at most kCoplanarMaxLevel).
inline std::vector<std::uint32_t> coplanar_levels(std::span<const QuadModel* const> models) {
  std::vector<CoplanarPlane> planes;
  planes.reserve(models.size());
  for (const QuadModel* m : models) planes.push_back(coplanar_plane(m));
  std::vector<std::uint32_t> level(models.size(), 0);
  auto pairs = coplanar_detail::overlapping_pairs(planes);
  if (pairs.empty()) return level;
  // By the later quad, so every earlier quad's level is final when it is read.
  std::ranges::sort(pairs, [](const auto& a, const auto& b) { return a.second != b.second ? a.second < b.second : a.first < b.first; });
  for (const auto& [i, j] : pairs) level[j] = std::max(level[j], std::min(kCoplanarMaxLevel, level[i] + 1));
  return level;
}

/// Cluster ids for quads (null = not planar): quads that share a plane and
/// overlap, directly or through others, share the id of the cluster's first
/// quad; every other quad's id is its own index.
inline std::vector<std::size_t> coplanar_clusters(std::span<const QuadModel* const> models) {
  std::vector<CoplanarPlane> planes;
  planes.reserve(models.size());
  for (const QuadModel* m : models) planes.push_back(coplanar_plane(m));
  std::vector<std::size_t> parent(models.size());
  std::iota(parent.begin(), parent.end(), std::size_t{0});
  const auto find = [&](std::size_t x) {
    while (parent[x] != x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (const auto& [i, j] : coplanar_detail::overlapping_pairs(planes)) {
    const std::size_t a = find(i);
    const std::size_t b = find(j);
    if (a != b) parent[std::max(a, b)] = std::min(a, b);
  }
  for (std::size_t i = 0; i < parent.size(); ++i) parent[i] = find(i);
  return parent;
}

}  // namespace premation::rg
