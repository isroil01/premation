#include "alpha_contours.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <unordered_map>
#include <utility>

#include "jsmath.hpp"

namespace premation::effects {

namespace {

namespace mjs = motion::js;

double clamp_d(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }

}  // namespace

/// extractAlphaContours: marching squares over the alpha plane, chained into loops.
std::vector<AlphaContour> extract_alpha_contours(const std::vector<std::uint8_t>& alpha, int w, int h, double threshold) {
  if (w <= 0 || h <= 0) return {};
  const auto s = [&](int x, int y) -> double {
    if (x < 0 || y < 0 || x >= w || y >= h) return 0;
    return alpha[static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x)];
  };
  const auto crossing = [threshold](double a, double b) {
    const double d = b - a;
    if (d == 0) return 0.5;
    return clamp_d((threshold - a) / d, 0, 1);
  };
  enum Side : std::uint8_t { T, R, B, L };
  using Seg = std::pair<Side, Side>;
  static const std::array<std::vector<Seg>, 16> kCases{{
      {}, {{B, L}}, {{R, B}}, {{R, L}}, {{T, R}}, {}, {{T, B}}, {{T, L}},
      {{L, T}}, {{B, T}}, {}, {{R, T}}, {{L, R}}, {{B, R}}, {{L, B}}, {},
  }};
  const auto key = [](const AlphaPt& p) { return std::pair<double, double>{mjs::round(p.x * 1e6), mjs::round(p.y * 1e6)}; };
  struct S {
    AlphaPt a, b;
  };
  std::vector<S> segs;
  // vegas.ts keys endpoints by the string of their rounded µpx coordinates; a
  // hash of the two rounded doubles (−0 folded into +0, as the string does)
  // groups the same points. Lookups only: the per-key lists keep insertion order.
  struct KeyHash {
    std::size_t operator()(const std::pair<double, double>& k) const noexcept {
      const auto a = std::bit_cast<std::uint64_t>(k.first + 0.0);
      const auto b = std::bit_cast<std::uint64_t>(k.second + 0.0);
      return static_cast<std::size_t>(a * 0x9E3779B97F4A7C15ULL ^ (b + 0x632BE59BD9B4E019ULL + (a << 6U) + (a >> 2U)));
    }
  };
  struct KeyEq {
    bool operator()(const std::pair<double, double>& x, const std::pair<double, double>& y) const noexcept {
      return x.first == y.first && x.second == y.second;
    }
  };
  std::unordered_map<std::pair<double, double>, std::vector<std::size_t>, KeyHash, KeyEq> by_start;
  for (int cy = -1; cy < h; ++cy) {
    for (int cx = -1; cx < w; ++cx) {
      const double tl = s(cx, cy);
      const double tr = s(cx + 1, cy);
      const double br = s(cx + 1, cy + 1);
      const double bl = s(cx, cy + 1);
      const int bits = (tl >= threshold ? 8 : 0) | (tr >= threshold ? 4 : 0) | (br >= threshold ? 2 : 0) | (bl >= threshold ? 1 : 0);
      if (bits == 0 || bits == 15) continue;
      const std::array<AlphaPt, 4> pts{AlphaPt{cx + crossing(tl, tr), static_cast<double>(cy)}, AlphaPt{cx + 1.0, cy + crossing(tr, br)},
                                   AlphaPt{cx + crossing(bl, br), cy + 1.0}, AlphaPt{static_cast<double>(cx), cy + crossing(tl, bl)}};
      std::vector<Seg> cell;
      if (bits == 5 || bits == 10) {
        const bool centre = (tl + tr + br + bl) / 4 >= threshold;
        if (bits == 5) cell = centre ? std::vector<Seg>{{T, L}, {B, R}} : std::vector<Seg>{{T, R}, {B, L}};
        else cell = centre ? std::vector<Seg>{{R, T}, {L, B}} : std::vector<Seg>{{L, T}, {R, B}};
      } else {
        cell = kCases[static_cast<std::size_t>(bits)];
      }
      for (const auto& [a, b] : cell) {
        by_start[key(pts[a])].push_back(segs.size());
        segs.push_back({pts[a], pts[b]});
      }
    }
  }
  std::vector<AlphaContour> contours;
  std::vector<bool> consumed(segs.size(), false);
  const auto next_from = [&](const std::pair<double, double>& k) -> long {
    const auto it = by_start.find(k);
    if (it == by_start.end()) return -1;
    for (const std::size_t i : it->second) {
      if (!consumed[i]) return static_cast<long>(i);
    }
    return -1;
  };
  for (std::size_t start = 0; start < segs.size(); ++start) {
    if (consumed[start]) continue;
    AlphaContour loop;
    long i = static_cast<long>(start);
    while (i >= 0 && !consumed[static_cast<std::size_t>(i)]) {
      const auto u = static_cast<std::size_t>(i);
      consumed[u] = true;
      loop.push_back(segs[u].a);
      i = next_from(key(segs[u].b));
    }
    if (loop.size() >= 3) {
      std::size_t best = 0;
      for (std::size_t k = 1; k < loop.size(); ++k) {
        if (loop[k].y < loop[best].y || (loop[k].y == loop[best].y && loop[k].x < loop[best].x)) best = k;
      }
      if (best != 0) std::rotate(loop.begin(), loop.begin() + static_cast<long>(best), loop.end());
      contours.push_back(std::move(loop));
    }
  }
  return contours;
}

}  // namespace premation::effects
