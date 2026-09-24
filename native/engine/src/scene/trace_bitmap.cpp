// src/core/geometry/traceBitmap.ts, call for call (see extrude_mesh.hpp).
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <numbers>
#include <span>
#include <vector>

#include "extrude_mesh.hpp"
#include "jsmath.hpp"

namespace premation::scene::mesh {
namespace {

namespace jm = motion::js;

double hyp2(double a, double b) noexcept {
  const std::array<double, 2> v{a, b};
  return jm::hypot(std::span<const double>(v));
}

struct Ahead {
  int rx;
  int ry;
  int lx;
  int ly;
};
constexpr std::array<int, 4> kDX{1, 0, -1, 0};
constexpr std::array<int, 4> kDY{0, 1, 0, -1};
constexpr std::array<Ahead, 4> kAhead{{
    {0, 0, 0, -1},
    {-1, 0, 0, 0},
    {-1, -1, -1, 0},
    {0, -1, -1, -1},
}};

std::vector<std::uint8_t> to_mask(std::span<const std::uint8_t> src, int w, int h, int stride, double threshold) {
  const int mw = w + 2;
  std::vector<std::uint8_t> mask(static_cast<std::size_t>(mw) * static_cast<std::size_t>(h + 2));
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const auto at = (static_cast<std::size_t>((y * w) + x) * static_cast<std::size_t>(stride)) + static_cast<std::size_t>(stride - 1);
      if (static_cast<double>(src[at]) >= threshold) mask[static_cast<std::size_t>(((y + 1) * mw) + (x + 1))] = 1;
    }
  }
  return mask;
}

std::vector<Pt2> follow_edges(const std::vector<std::uint8_t>& mask, int mw, int startX, int startY, int startDir,
                              std::vector<std::uint8_t>& visited) {
  const auto inside = [&](int px, int py) { return mask[static_cast<std::size_t>((py * mw) + px)] == 1; };
  std::vector<Pt2> pts;
  int cx = startX;
  int cy = startY;
  int dir = startDir;
  long long guard = static_cast<long long>(mw) * mw * 4;
  bool first = true;
  do {
    const Ahead& ahead = kAhead[static_cast<std::size_t>(dir)];
    const bool R = inside(cx + ahead.rx, cy + ahead.ry);
    const bool L = inside(cx + ahead.lx, cy + ahead.ly);
    const int before = dir;
    if (R && !L) {
      // straight on
    } else if (R && L) {
      dir = (dir + 3) & 3;
    } else {
      dir = (dir + 1) & 3;
    }
    if (first || dir != before) pts.push_back({static_cast<double>(cx), static_cast<double>(cy)});
    first = false;
    const Ahead& a = kAhead[static_cast<std::size_t>(dir)];
    visited[static_cast<std::size_t>(((cy + a.ry) * mw) + (cx + a.rx))] = 1;
    cx += kDX[static_cast<std::size_t>(dir)];
    cy += kDY[static_cast<std::size_t>(dir)];
  } while ((cx != startX || cy != startY) && --guard > 0);
  return pts;
}

double trace_area(std::span<const Pt2> pts) noexcept {
  double a = 0;
  const std::size_t n = pts.size();
  for (std::size_t i = 0; i < n; ++i) {
    const Pt2 p = pts[i];
    const Pt2 q = pts[(i + 1) % n];
    a += (p.x * q.y) - (q.x * p.y);
  }
  return a / 2;
}

double perp_dist(Pt2 p, Pt2 a, Pt2 b) noexcept {
  const double dx = b.x - a.x;
  const double dy = b.y - a.y;
  const double len2 = (dx * dx) + (dy * dy);
  if (len2 == 0) return hyp2(p.x - a.x, p.y - a.y);
  const std::array<double, 2> inner{0.0, (((p.x - a.x) * dx) + ((p.y - a.y) * dy)) / len2};
  const double lo = jm::max_of(std::span<const double>(inner));
  const std::array<double, 2> outer{1.0, lo};
  const double t = jm::min_of(std::span<const double>(outer));
  return hyp2(p.x - (a.x + (t * dx)), p.y - (a.y + (t * dy)));
}

void rdp_open(std::span<const Pt2> pts, double eps, std::vector<Pt2>& out) {
  if (pts.size() < 3) {
    for (const Pt2& p : pts) out.push_back(p);
    return;
  }
  double maxD = 0;
  std::size_t idx = 0;
  const Pt2 a = pts.front();
  const Pt2 b = pts.back();
  for (std::size_t i = 1; i + 1 < pts.size(); ++i) {
    const double d = perp_dist(pts[i], a, b);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD > eps) {
    rdp_open(pts.subspan(0, idx + 1), eps, out);
    out.pop_back();
    rdp_open(pts.subspan(idx), eps, out);
  } else {
    out.push_back(a);
    out.push_back(b);
  }
}

}  // namespace

std::vector<Pt2> simplify_ring(std::span<const Pt2> pts, double eps) {
  if (eps <= 0 || pts.size() <= 4) return {pts.begin(), pts.end()};
  std::size_t far = 0;
  double farD = -1;
  for (std::size_t i = 1; i < pts.size(); ++i) {
    const double d = hyp2(pts[i].x - pts[0].x, pts[i].y - pts[0].y);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const std::vector<Pt2> half1(pts.begin(), pts.begin() + static_cast<std::ptrdiff_t>(far + 1));
  std::vector<Pt2> half2(pts.begin() + static_cast<std::ptrdiff_t>(far), pts.end());
  half2.push_back(pts[0]);
  std::vector<Pt2> out;
  rdp_open(half1, eps, out);
  out.pop_back();
  rdp_open(half2, eps, out);
  out.pop_back();
  std::vector<Pt2> kept;
  const std::size_t n = out.size();
  for (std::size_t i = 0; i < n; ++i) {
    const Pt2 a = out[(i + n - 1) % n];
    const Pt2 b = out[(i + 1) % n];
    if (perp_dist(out[i], a, b) > 1e-6) kept.push_back(out[i]);
  }
  return kept;
}

std::vector<TracedContour> trace_bitmap(std::span<const std::uint8_t> src, int w, int h, int stride, const TraceOptions& opts) {
  const int mw = w + 2;
  const std::vector<std::uint8_t> mask = to_mask(src, w, h, stride, opts.threshold);
  std::vector<std::uint8_t> visitedOuter(mask.size());
  std::vector<std::uint8_t> visitedHole(mask.size());
  std::vector<TracedContour> out;
  const auto at = [&](int x, int y) { return static_cast<std::size_t>((y * mw) + x); };
  for (int py = 1; py <= h; ++py) {
    for (int px = 1; px <= w; ++px) {
      const bool here = mask[at(px, py)] == 1;
      const bool left = mask[at(px - 1, py)] == 1;
      if (here && !left && visitedOuter[at(px, py)] == 0 && visitedHole[at(px, py)] == 0) {
        std::vector<Pt2> ring = follow_edges(mask, mw, px, py, 0, visitedOuter);
        visitedOuter[at(px, py)] = 1;
        for (Pt2& p : ring) p = {p.x - 1, p.y - 1};
        if (std::abs(trace_area(ring)) < opts.minArea) continue;
        out.push_back({simplify_ring(ring, opts.tolerance), false});
      } else if (!here && left && visitedHole[at(px - 1, py)] == 0) {
        std::vector<Pt2> ring = follow_edges(mask, mw, px, py, 1, visitedHole);
        visitedHole[at(px - 1, py)] = 1;
        for (Pt2& p : ring) p = {p.x - 1, p.y - 1};
        const double area = trace_area(ring);
        if (std::abs(area) < opts.minArea) continue;
        if (area > 0) continue;
        out.push_back({simplify_ring(ring, opts.tolerance), true});
      }
    }
  }
  return out;
}

std::vector<BezPt> smooth_contour(std::span<const Pt2> pts, double tension, std::optional<double> cornerAngleDeg) {
  const std::size_t n = pts.size();
  const double k = tension / 3;
  std::vector<BezPt> out;
  out.reserve(n);
  if (!cornerAngleDeg) {
    for (std::size_t i = 0; i < n; ++i) {
      const Pt2 p = pts[i];
      const Pt2 prev = pts[(i + n - 1) % n];
      const Pt2 next = pts[(i + 1) % n];
      const double tx = (next.x - prev.x) * k;
      const double ty = (next.y - prev.y) * k;
      out.push_back({p.x, p.y, p.x - tx, p.y - ty, p.x + tx, p.y + ty});
    }
    return out;
  }
  const double cosCorner = jm::cos(*cornerAngleDeg * std::numbers::pi / 180);
  const std::array<double, 2> fv{1.0 / 3, k * 2};
  const double f = jm::min_of(std::span<const double>(fv));
  for (std::size_t i = 0; i < n; ++i) {
    const Pt2 p = pts[i];
    const Pt2 prev = pts[(i + n - 1) % n];
    const Pt2 next = pts[(i + 1) % n];
    const double ax = p.x - prev.x;
    const double ay = p.y - prev.y;
    const double bx = next.x - p.x;
    const double by = next.y - p.y;
    const double la = hyp2(ax, ay);
    const double lb = hyp2(bx, by);
    const BezPt sharp{p.x, p.y, p.x, p.y, p.x, p.y};
    if (la < 1e-6 || lb < 1e-6) {
      out.push_back(sharp);
      continue;
    }
    if (((ax * bx) + (ay * by)) / (la * lb) <= cosCorner) {
      out.push_back(sharp);
      continue;
    }
    const double cx = next.x - prev.x;
    const double cy = next.y - prev.y;
    double lc = hyp2(cx, cy);
    if (lc == 0 || std::isnan(lc)) lc = 1;
    const double ux = cx / lc;
    const double uy = cy / lc;
    out.push_back({p.x, p.y, p.x - (ux * la * f), p.y - (uy * la * f), p.x + (ux * lb * f), p.y + (uy * lb * f)});
  }
  return out;
}

}  // namespace premation::scene::mesh
