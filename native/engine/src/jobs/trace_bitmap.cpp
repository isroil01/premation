#include "trace_bitmap.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <utility>

namespace premation::jobs::trace {

namespace {

using Mask = std::vector<std::uint8_t>;

/// Binary mask with a one-pixel border so neighbour lookups never bounds-check.
Mask to_mask(std::span<const std::uint8_t> src, std::uint32_t w, std::uint32_t h, std::uint32_t stride,
             double threshold) {
  const std::size_t mw = static_cast<std::size_t>(w) + 2;
  Mask mask(mw * (static_cast<std::size_t>(h) + 2), 0);
  for (std::size_t y = 0; y < h; ++y) {
    for (std::size_t x = 0; x < w; ++x) {
      const std::uint8_t v = src[(y * w + x) * stride + (stride - 1)];
      if (static_cast<double>(v) >= threshold) mask[(y + 1) * mw + (x + 1)] = 1;
    }
  }
  return mask;
}

// Directions: 0 = +x, 1 = +y, 2 = −x, 3 = −y.
constexpr std::array<int, 4> kDx{1, 0, -1, 0};
constexpr std::array<int, 4> kDy{0, 1, 0, -1};

/// For a walker at corner (cx, cy) heading `dir`, the pixel just ahead on its
/// RIGHT and on its LEFT, as corner-relative offsets (traceBitmap.ts AHEAD).
struct Ahead {
  int rx, ry, lx, ly;
};
constexpr std::array<Ahead, 4> kAhead{{
    {0, 0, 0, -1},    // +x: right = below the edge, left = above
    {-1, 0, 0, 0},    // +y: right = left of the edge
    {-1, -1, -1, 0},  // −x
    {0, -1, -1, -1},  // −y
}};

std::size_t at(std::ptrdiff_t mw, std::ptrdiff_t px, std::ptrdiff_t py) noexcept {
  return static_cast<std::size_t>(py * mw + px);
}

/// traceBitmap.ts `followEdges`: square tracing along the crack boundary with
/// the inside kept on the right hand. Vertices on the grid (mask coordinates).
std::vector<TracePoint> follow_edges(const Mask& mask, std::ptrdiff_t mw, std::ptrdiff_t startX, std::ptrdiff_t startY,
                                     int startDir, Mask& visited) {
  auto inside = [&](std::ptrdiff_t px, std::ptrdiff_t py) {
    const std::size_t i = at(mw, px, py);
    return i < mask.size() && mask[i] == 1;
  };
  std::vector<TracePoint> pts;
  std::ptrdiff_t cx = startX;
  std::ptrdiff_t cy = startY;
  int dir = startDir;
  std::int64_t guard = static_cast<std::int64_t>(mw) * mw * 4;
  bool first = true;
  do {
    const Ahead& ahead = kAhead[static_cast<std::size_t>(dir)];
    const bool r = inside(cx + ahead.rx, cy + ahead.ry);
    const bool l = inside(cx + ahead.lx, cy + ahead.ly);
    const int before = dir;
    if (r && !l) {
      // straight on
    } else if (r && l) {
      dir = (dir + 3) & 3;  // concave corner: turn left
    } else {
      dir = (dir + 1) & 3;  // convex corner (or a diagonal touch): turn right
    }
    if (first || dir != before) pts.push_back({static_cast<double>(cx), static_cast<double>(cy)});
    first = false;
    const Ahead& a = kAhead[static_cast<std::size_t>(dir)];
    const std::size_t vi = at(mw, cx + a.rx, cy + a.ry);
    if (vi < visited.size()) visited[vi] = 1;
    cx += kDx[static_cast<std::size_t>(dir)];
    cy += kDy[static_cast<std::size_t>(dir)];
  } while ((cx != startX || cy != startY) && --guard > 0);
  return pts;
}

double perp_dist(const TracePoint& p, const TracePoint& a, const TracePoint& b) noexcept {
  const double dx = b.x - a.x;
  const double dy = b.y - a.y;
  const double len2 = dx * dx + dy * dy;
  if (len2 == 0) return std::hypot(p.x - a.x, p.y - a.y);
  const double t = std::max(0.0, std::min(1.0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return std::hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/// traceBitmap.ts `rdpOpen` without the recursion (a long ring would recurse
/// once per vertex on a worker thread's small stack). The recursive version's
/// output is its leaves in left-to-right order, each leaf's first point
/// dropped after the first (the `out.pop()` between the halves); a stack that
/// visits the left half first produces exactly that.
void rdp_open(std::span<const TracePoint> pts, double eps, std::vector<TracePoint>& out) {
  if (pts.size() < 3) {
    out.insert(out.end(), pts.begin(), pts.end());
    return;
  }
  std::vector<std::pair<std::size_t, std::size_t>> stack;
  stack.emplace_back(0, pts.size() - 1);
  bool firstLeaf = true;
  auto emit = [&](std::size_t lo, std::size_t hi, bool all) {
    // A leaf pushes all its points (fewer than 3) or its two ends.
    std::vector<TracePoint> leaf;
    if (all) {
      for (std::size_t i = lo; i <= hi; ++i) leaf.push_back(pts[i]);
    } else {
      leaf.push_back(pts[lo]);
      leaf.push_back(pts[hi]);
    }
    const std::size_t from = firstLeaf ? 0 : 1;
    firstLeaf = false;
    out.insert(out.end(), leaf.begin() + static_cast<std::ptrdiff_t>(from), leaf.end());
  };
  while (!stack.empty()) {
    const auto [lo, hi] = stack.back();
    stack.pop_back();
    if (hi - lo + 1 < 3) {
      emit(lo, hi, true);
      continue;
    }
    double maxD = 0;
    std::size_t idx = 0;
    for (std::size_t i = lo + 1; i < hi; ++i) {
      const double d = perp_dist(pts[i], pts[lo], pts[hi]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > eps) {
      stack.emplace_back(idx, hi);  // right half after the left
      stack.emplace_back(lo, idx);
    } else {
      emit(lo, hi, false);
    }
  }
}

}  // namespace

double signed_area(std::span<const TracePoint> pts) noexcept {
  double a = 0;
  const std::size_t n = pts.size();
  for (std::size_t i = 0; i < n; ++i) {
    const TracePoint& p = pts[i];
    const TracePoint& q = pts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

std::vector<TracePoint> simplify_ring(std::span<const TracePoint> pts, double eps) {
  if (eps <= 0 || pts.size() <= 4) return {pts.begin(), pts.end()};
  std::size_t far = 0;
  double farD = -1;
  for (std::size_t i = 1; i < pts.size(); ++i) {
    const double d = std::hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  std::vector<TracePoint> half2(pts.begin() + static_cast<std::ptrdiff_t>(far), pts.end());
  half2.push_back(pts[0]);
  std::vector<TracePoint> out;
  rdp_open(pts.subspan(0, far + 1), eps, out);
  if (!out.empty()) out.pop_back();
  rdp_open(half2, eps, out);
  if (!out.empty()) out.pop_back();  // the repeated start
  // Drop collinear survivors the split may have left at the seams.
  std::vector<TracePoint> kept;
  const std::size_t n = out.size();
  for (std::size_t i = 0; i < n; ++i) {
    const TracePoint& a = out[(i + n - 1) % n];
    const TracePoint& b = out[(i + 1) % n];
    if (perp_dist(out[i], a, b) > 1e-6) kept.push_back(out[i]);
  }
  return kept;
}

std::vector<TracedContour> trace_bitmap(std::span<const std::uint8_t> src, std::uint32_t w, std::uint32_t h,
                                        std::uint32_t stride, const TraceOptions& opts) {
  std::vector<TracedContour> out;
  if (w == 0 || h == 0 || stride == 0 || src.size() < static_cast<std::size_t>(w) * h * stride) return out;
  const auto mw = static_cast<std::ptrdiff_t>(w) + 2;
  const Mask mask = to_mask(src, w, h, stride, opts.threshold);
  Mask visitedOuter(mask.size(), 0);
  Mask visitedHole(mask.size(), 0);
  auto to_image = [](std::vector<TracePoint> pts) {
    for (TracePoint& p : pts) {
      p.x -= 1;
      p.y -= 1;
    }
    return pts;
  };
  const auto H = static_cast<std::ptrdiff_t>(h);
  const auto W = static_cast<std::ptrdiff_t>(w);
  for (std::ptrdiff_t py = 1; py <= H; ++py) {
    for (std::ptrdiff_t px = 1; px <= W; ++px) {
      const std::size_t i = at(mw, px, py);
      const bool here = mask[i] == 1;
      const bool left = mask[i - 1] == 1;
      if (here && !left && visitedOuter[i] == 0 && visitedHole[i] == 0) {
        // Outer border: from the pixel's top-left corner heading +x.
        std::vector<TracePoint> ring = to_image(follow_edges(mask, mw, px, py, 0, visitedOuter));
        visitedOuter[i] = 1;
        if (std::abs(signed_area(ring)) < opts.minArea) continue;
        out.push_back({simplify_ring(ring, opts.tolerance), false});
      } else if (!here && left && visitedHole[i - 1] == 0) {
        // Hole border: heading +y down the edge keeps the inside (west) on the right.
        std::vector<TracePoint> ring = to_image(follow_edges(mask, mw, px, py, 1, visitedHole));
        visitedHole[i - 1] = 1;
        const double area = signed_area(ring);
        if (std::abs(area) < opts.minArea) continue;
        // The region's outside traced from this seed comes back clockwise-positive: not a hole.
        if (area > 0) continue;
        out.push_back({simplify_ring(ring, opts.tolerance), true});
      }
    }
  }
  return out;
}

bool parse_channel(std::string_view s, Channel& out) noexcept {
  if (s.empty() || s == "alpha") {
    out = Channel::alpha;
  } else if (s == "luminance" || s == "luma") {
    out = Channel::luminance;
  } else if (s == "red") {
    out = Channel::red;
  } else if (s == "green") {
    out = Channel::green;
  } else if (s == "blue") {
    out = Channel::blue;
  } else {
    return false;
  }
  return true;
}

std::vector<std::uint8_t> channel_plane(const RgbaImage& img, Channel ch, bool invert) {
  const std::size_t n = static_cast<std::size_t>(img.width) * img.height;
  std::vector<std::uint8_t> out(n, 0);
  if (img.rgba.size() < n * 4) return out;
  auto premul = [](std::uint32_t v, std::uint32_t a) { return (v * a + 127U) / 255U; };
  for (std::size_t i = 0; i < n; ++i) {
    const std::uint32_t r = img.rgba[i * 4];
    const std::uint32_t g = img.rgba[i * 4 + 1];
    const std::uint32_t b = img.rgba[i * 4 + 2];
    const std::uint32_t a = img.rgba[i * 4 + 3];
    std::uint32_t v = 0;
    switch (ch) {
      case Channel::alpha: v = a; break;
      case Channel::luminance: v = premul((2126U * r + 7152U * g + 722U * b + 5000U) / 10000U, a); break;
      case Channel::red: v = premul(r, a); break;
      case Channel::green: v = premul(g, a); break;
      case Channel::blue: v = premul(b, a); break;
    }
    if (invert) v = 255U - v;
    out[i] = static_cast<std::uint8_t>(v);
  }
  return out;
}

std::vector<std::uint8_t> box_blur(std::span<const std::uint8_t> plane, std::uint32_t w, std::uint32_t h,
                                   double radius) {
  std::vector<std::uint8_t> out(plane.begin(), plane.end());
  const double rr = std::isfinite(radius) ? std::floor(radius + 0.5) : 0.0;
  const std::size_t n = static_cast<std::size_t>(w) * h;
  if (rr <= 0 || w == 0 || h == 0 || plane.size() < n) return out;
  const auto r = static_cast<std::ptrdiff_t>(std::min(rr, 4096.0));
  const auto W = static_cast<std::ptrdiff_t>(w);
  const auto H = static_cast<std::ptrdiff_t>(h);
  auto avg = [](std::uint32_t sum, std::uint32_t cnt) { return static_cast<std::uint8_t>((sum + cnt / 2U) / cnt); };
  std::vector<std::uint8_t> tmp(n, 0);
  for (std::ptrdiff_t y = 0; y < H; ++y) {
    const std::uint8_t* row = plane.data() + y * W;
    std::uint32_t sum = 0;
    std::ptrdiff_t lo = 0;
    std::ptrdiff_t hi = -1;  // window [lo, hi] currently summed
    for (std::ptrdiff_t x = 0; x < W; ++x) {
      const std::ptrdiff_t wantLo = std::max<std::ptrdiff_t>(0, x - r);
      const std::ptrdiff_t wantHi = std::min<std::ptrdiff_t>(W - 1, x + r);
      while (hi < wantHi) sum += row[++hi];
      while (lo < wantLo) sum -= row[lo++];
      tmp[static_cast<std::size_t>(y * W + x)] = avg(sum, static_cast<std::uint32_t>(hi - lo + 1));
    }
  }
  for (std::ptrdiff_t x = 0; x < W; ++x) {
    std::uint32_t sum = 0;
    std::ptrdiff_t lo = 0;
    std::ptrdiff_t hi = -1;
    for (std::ptrdiff_t y = 0; y < H; ++y) {
      const std::ptrdiff_t wantLo = std::max<std::ptrdiff_t>(0, y - r);
      const std::ptrdiff_t wantHi = std::min<std::ptrdiff_t>(H - 1, y + r);
      while (hi < wantHi) sum += tmp[static_cast<std::size_t>((++hi) * W + x)];
      while (lo < wantLo) sum -= tmp[static_cast<std::size_t>((lo++) * W + x)];
      out[static_cast<std::size_t>(y * W + x)] = avg(sum, static_cast<std::uint32_t>(hi - lo + 1));
    }
  }
  return out;
}

std::vector<MaskRing> auto_trace_rings(std::span<const std::uint8_t> plane, std::uint32_t pw, std::uint32_t ph,
                                       double layerW, double layerH, const AutoTraceParams& params) {
  std::vector<MaskRing> rings;
  if (pw == 0 || ph == 0) return rings;
  // The plane may be smaller than the layer (a scaled-down decode); map back to layer units.
  const double sx = layerW / pw;
  const double sy = layerH / ph;
  TraceOptions opts;
  opts.threshold = params.threshold;
  opts.tolerance = params.tolerance;
  opts.minArea = params.minArea / (sx * sy);
  const std::vector<TracedContour> contours = trace_bitmap(plane, pw, ph, 1, opts);
  auto to_ring = [&](const TracedContour& c) {
    std::vector<TracePoint> pts;
    pts.reserve(c.points.size());
    for (const TracePoint& p : c.points) pts.push_back({p.x * sx - layerW / 2, p.y * sy - layerH / 2});
    return simplify_ring(pts, 0.25);
  };
  for (const bool hole : {false, true}) {
    for (const TracedContour& c : contours) {
      if (c.points.size() < 3 || c.hole != hole) continue;
      rings.push_back({to_ring(c), hole});
    }
  }
  return rings;
}

std::vector<MaskRing> comp_rings_to_layer(std::vector<MaskRing> rings, double compW, double compH, const std::array<double, 6>& m) {
  const double det = m[0] * m[3] - m[1] * m[2];
  if (!std::isfinite(det) || std::abs(det) < 1e-12) return {};
  // Matrix.invert: [a b c d e f] -> the inverse affine.
  const double ia = m[3] / det;
  const double ib = -m[1] / det;
  const double ic = -m[2] / det;
  const double id = m[0] / det;
  const double ie = (m[2] * m[5] - m[3] * m[4]) / det;
  const double iff = (m[1] * m[4] - m[0] * m[5]) / det;
  for (MaskRing& r : rings) {
    for (TracePoint& p : r.points) {
      const double x = p.x + compW / 2;
      const double y = p.y + compH / 2;
      p = TracePoint{ia * x + ic * y + ie, ib * x + id * y + iff};
    }
  }
  return rings;
}

}  // namespace premation::jobs::trace
