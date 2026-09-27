#include "mask_sampling.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <iterator>
#include <numeric>
#include <string>

#include "fail.hpp"
#include "jsmath.hpp"

namespace premation::jobs::masksample {

namespace {

using std::size_t;

size_t uz(int v) noexcept { return static_cast<size_t>(std::max(0, v)); }

double hypot2(double a, double b) {
  const std::array<double, 2> v{a, b};
  return motion::js::hypot(v);
}

struct Arc {
  std::vector<double> s;
  double total = 0;
};

/// Cumulative chord length at each vertex; `total` includes the closing segment of a loop.
Arc arc_lengths(const SamplablePath& path) {
  const std::vector<Pt>& pts = path.points;
  Arc a;
  a.s.resize(pts.size());
  double acc = 0;
  for (size_t i = 0; i < pts.size(); ++i) {
    if (i > 0) acc += hypot2(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    a.s[i] = acc;
  }
  a.total = acc;
  if (path.closed && pts.size() > 1) a.total += hypot2(pts.front().x - pts.back().x, pts.front().y - pts.back().y);
  return a;
}

/// `pickByArcLength(path, n)`.
std::vector<int> pick_by_arc_length(const SamplablePath& path, int n) {
  const int len = static_cast<int>(path.points.size());
  std::vector<int> picks;
  if (n >= len) {
    for (int i = 0; i < len; ++i) picks.push_back(i);
    return picks;
  }
  if (n <= 0) return picks;
  const Arc a = arc_lengths(path);
  if (a.total <= 0) {
    for (int k = 0; k < n; ++k) {
      const int i = std::min(len - 1, static_cast<int>(motion::js::round(static_cast<double>(k) * len / n)));
      if (picks.empty() || i > picks.back()) picks.push_back(i);
    }
    return picks;
  }
  // An open path of one pick divides by zero: t = 0 · ∞ = NaN and the first vertex wins, as in the TS.
  const double step = path.closed ? a.total / n : a.total / (n - 1);
  int from = 0;
  for (int k = 0; k < n && from < len; ++k) {
    const double t = k * step;
    int best = from;
    double bestD = std::abs(a.s[uz(from)] - t);
    for (int i = from + 1; i < len; ++i) {
      const double d = std::abs(a.s[uz(i)] - t);
      if (d < bestD) {
        best = i;
        bestD = d;
      } else if (a.s[uz(i)] > t) {
        break;  // s is monotone: past the target it only gets worse
      }
    }
    picks.push_back(best);
    from = best + 1;
  }
  return picks;
}

/// `allocate(paths, cap)`.
std::vector<int> allocate(const std::vector<SamplablePath>& paths, int cap) {
  std::vector<int> lens;
  for (const SamplablePath& p : paths) lens.push_back(static_cast<int>(p.points.size()));
  std::vector<int> floor;
  for (size_t i = 0; i < paths.size(); ++i) floor.push_back(std::min(lens[i], paths[i].closed ? 3 : 2));
  const auto sum = [](const std::vector<int>& v) { return std::accumulate(v.begin(), v.end(), 0); };
  if (sum(floor) > cap) {
    for (size_t i = 0; i < paths.size(); ++i) floor[i] = std::min(lens[i], 1);
    if (sum(floor) > cap) {
      doc::fail(api::ErrorCode::invalid_argument, "The mask has " + std::to_string(paths.size()) + " paths — more than " +
                                                      std::to_string(cap) + " cannot be tracked at once.");
    }
  }
  const int total = sum(lens);
  int spare = cap - sum(floor);
  std::vector<int> out = floor;
  // Proportional share of the spare, capped by what each path can still take.
  std::vector<double> want;
  for (size_t i = 0; i < out.size(); ++i) {
    want.push_back(std::max(0.0, std::min(static_cast<double>(lens[i] - out[i]),
                                          (static_cast<double>(spare) * lens[i]) / total)));
  }
  std::vector<int> whole;
  for (const double w : want) whole.push_back(static_cast<int>(std::floor(w)));
  for (size_t i = 0; i < out.size(); ++i) {
    out[i] += whole[i];
    spare -= whole[i];
  }
  // Largest remainder for what is left, then any slack to whoever has room.
  struct Frac {
    size_t i;
    double frac;
  };
  std::vector<Frac> order;
  for (size_t i = 0; i < want.size(); ++i) order.push_back(Frac{i, want[i] - whole[i]});
  std::sort(order.begin(), order.end(), [](const Frac& p, const Frac& q) {
    if (q.frac != p.frac) return q.frac < p.frac;
    return p.i < q.i;
  });
  for (const Frac& f : order) {
    if (spare <= 0) break;
    if (out[f.i] < lens[f.i]) {
      out[f.i] += 1;
      spare -= 1;
    }
  }
  for (size_t i = 0; i < out.size() && spare > 0; ++i) {
    const int take = std::min(lens[i] - out[i], spare);
    out[i] += take;
    spare -= take;
  }
  return out;
}

int index_of(const std::vector<int>& v, int x) {
  const auto it = std::find(v.begin(), v.end(), x);
  return it == v.end() ? -1 : static_cast<int>(std::distance(v.begin(), it));
}

}  // namespace

VertexSampling sample_mask_vertices(const std::vector<SamplablePath>& paths, int cap) {
  VertexSampling out;
  for (const SamplablePath& p : paths) out.total += static_cast<int>(p.points.size());
  out.slotOf.assign(uz(out.total), -1);
  out.blend.assign(uz(out.total), VertexBlend{});
  std::vector<int> budgets;
  if (out.total <= cap) {
    for (const SamplablePath& p : paths) budgets.push_back(static_cast<int>(p.points.size()));
  } else {
    budgets = allocate(paths, cap);
  }
  int base = 0;
  for (size_t p = 0; p < paths.size(); ++p) {
    const SamplablePath& path = paths[p];
    const int len = static_cast<int>(path.points.size());
    const std::vector<int> picks = pick_by_arc_length(path, budgets[p]);
    std::vector<int> slots;
    for (const int i : picks) {
      out.slotOf[uz(base + i)] = static_cast<int>(out.tracked.size());
      slots.push_back(static_cast<int>(out.tracked.size()));
      out.tracked.push_back(base + i);
    }
    if (!picks.empty()) {
      const Arc arc = arc_lengths(path);
      const double L = arc.total;
      int prev = -1;  // index into picks of the last tracked vertex passed
      for (int i = 0; i < len; ++i) {
        const int slot = out.slotOf[uz(base + i)];
        if (slot >= 0) {
          prev = index_of(picks, i);
          out.blend[uz(base + i)] = VertexBlend{slot, slot, 0};
          continue;
        }
        const bool hasPrev = prev >= 0;
        const bool hasNext = prev + 1 < static_cast<int>(picks.size());
        int ia = 0;
        int ib = 0;
        if (hasPrev && hasNext) {
          ia = picks[uz(prev)];
          ib = picks[uz(prev + 1)];
        } else if (path.closed) {
          // Wrap: before the first pick and after the last the neighbours are last → first.
          ia = picks.back();
          ib = picks.front();
        } else {
          // Open path past its last (or before its first) tracked vertex: ride the nearest one.
          const int only = hasPrev ? picks[uz(prev)] : picks.front();
          const int s = slots[uz(index_of(picks, only))];
          out.blend[uz(base + i)] = VertexBlend{s, s, 0};
          continue;
        }
        double w = 0;
        if (ia != ib) {
          double d1 = arc.s[uz(i)] - arc.s[uz(ia)];
          double d2 = arc.s[uz(ib)] - arc.s[uz(i)];
          if (path.closed) {
            if (d1 < 0) d1 += L;
            if (d2 < 0) d2 += L;
          }
          const double span = d1 + d2;
          w = span > 0 ? d1 / span : 0;
        }
        out.blend[uz(base + i)] = VertexBlend{slots[uz(index_of(picks, ia))], slots[uz(index_of(picks, ib))], w};
      }
    }
    base += len;
  }
  return out;
}

std::vector<Pt> blend_vertex_deltas(const VertexSampling& s, const std::vector<Pt>& slotDeltas) {
  std::vector<Pt> out(uz(s.total));
  for (int v = 0; v < s.total; ++v) {
    const VertexBlend& b = s.blend[uz(v)];
    const Pt& da = slotDeltas[uz(b.a)];
    const Pt& db = slotDeltas[uz(b.b)];
    out[uz(v)] = b.w == 0 || b.a == b.b ? Pt{da.x, da.y} : Pt{da.x + (db.x - da.x) * b.w, da.y + (db.y - da.y) * b.w};
  }
  return out;
}

}  // namespace premation::jobs::masksample
