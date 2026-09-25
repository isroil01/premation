#include "path_ops.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstdint>
#include <map>
#include <numbers>
#include <optional>
#include <span>
#include <string>
#include <utility>
#include <vector>

#include "fxstate.hpp"
#include "jsmath.hpp"
#include "scene_math.hpp"

namespace premation::scene {
namespace {

namespace jm = motion::js;

constexpr double kPi = std::numbers::pi;
constexpr double kNaN = jm::kNaN;

// ── JavaScript Math over two numbers (NaN-propagating, -0 < +0) ──────────
double jmax(double a, double b) noexcept {
  const std::array<double, 2> v{a, b};
  return jm::max_of(std::span<const double>(v));
}
double jmin(double a, double b) noexcept {
  const std::array<double, 2> v{a, b};
  return jm::min_of(std::span<const double>(v));
}
double jmin3(double a, double b, double c) noexcept {
  const std::array<double, 3> v{a, b, c};
  return jm::min_of(std::span<const double>(v));
}
/// `v || 1` for a number.
double or_one(double v) noexcept { return v == 0 || std::isnan(v) ? 1 : v; }

struct Pt {
  double x = 0;
  double y = 0;
};
using Poly = std::vector<Pt>;

/// PolyRun (pathOps.ts).
struct Run {
  Poly pts;
  bool closed = true;
  std::optional<double> opacity;
  std::optional<double> strokeScale;
};

/// Set when an operator reaches geometry outside the port (polygon-clipping's
/// union inside Offset Paths' cleanup).
struct Ctx {
  bool unported = false;
};

// ── the resolved operator (resolveOne) ───────────────────────────────────
struct Op {
  std::string id;
  std::string type;
  double amount = 0, detail = 0, wigglesPerSecond = 0, seed = 0, correlation = 0;
  double wiggleRotation = 0, wiggleScale = 0;
  std::string lineJoin = "miter";
  double miterLimit = 4, start = 0, end = 100, offset = 0;
  bool individually = false;
  double copies = 1, offsetX = 0, offsetY = 0, offsetRotation = 0, offsetScale = 1, offsetOpacity = 1;
  double anchorX = 0, anchorY = 0;
  bool below = false;
};

// ── trimPath.ts ──────────────────────────────────────────────────────────
using Seg = std::array<double, 2>;

std::vector<Seg> trim_segments(double startPct, double endPct, double offsetPct) {
  const double lo = jmin(startPct, endPct);
  const double hi = jmax(startPct, endPct);
  const double s = lo / 100;
  const double e = hi / 100;
  const double o = offsetPct / 100;
  const double len = e - s;
  if (len <= 0) return {};
  if (len >= 1) return {Seg{0, 1}};
  const double a = std::fmod(std::fmod(s + o, 1.0) + 1, 1.0);
  const double b = a + len;
  if (b <= 1) return {Seg{a, b}};
  return {Seg{a, 1}, Seg{0, b - 1}};
}

bool is_full(const std::vector<Seg>& segs) noexcept {
  return segs.size() == 1 && segs[0][0] == 0 && segs[0][1] == 1;
}

double seg_total(const Poly& pts, bool closed) {
  const std::size_t n = pts.size();
  if (n == 0) return 0;
  const std::size_t count = closed ? n : n - 1;
  double total = 0;
  for (std::size_t i = 0; i < count; ++i) {
    const Pt& a = pts[i];
    const Pt& b = pts[(i + 1) % n];
    total += hypot2(b.x - a.x, b.y - a.y);
  }
  return total;
}

Pt point_at_length(const Poly& pts, bool closed, double len) {
  const std::size_t n = pts.size();
  const std::size_t count = closed ? n : n - 1;
  double acc = 0;
  for (std::size_t i = 0; i < count; ++i) {
    const Pt& a = pts[i];
    const Pt& b = pts[(i + 1) % n];
    const double d = hypot2(b.x - a.x, b.y - a.y);
    if (acc + d >= len) {
      const double t = d > 0 ? (len - acc) / d : 0;
      return {a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t};
    }
    acc += d;
  }
  return pts[closed ? 0 : n - 1];
}

std::vector<Poly> trim_polyline(const Poly& pts, bool closed, const std::vector<Seg>& segments) {
  if (pts.size() < 2) return {};
  const double total = seg_total(pts, closed);
  if (total <= 0) return {};
  const std::size_t n = pts.size();
  const std::size_t count = closed ? n : n - 1;
  std::vector<Poly> out;
  for (const Seg& sg : segments) {
    const double startLen = sg[0] * total;
    const double endLen = sg[1] * total;
    if (endLen <= startLen) continue;
    Poly sub{point_at_length(pts, closed, startLen)};
    double acc = 0;
    for (std::size_t i = 0; i < count; ++i) {
      const Pt& b = pts[(i + 1) % n];
      acc += hypot2(b.x - pts[i].x, b.y - pts[i].y);
      if (acc > startLen && acc < endLen) sub.push_back(b);
    }
    sub.push_back(point_at_length(pts, closed, endLen));
    out.push_back(std::move(sub));
  }
  return out;
}

// ── mergePaths.ts flattenOutline (ADAPTIVE) ──────────────────────────────
struct BPt {
  double x = 0, y = 0, inX = 0, inY = 0, outX = 0, outY = 0;
};

double num_nan(const Json& o, std::string_view k) {
  const Json& v = o.at(k);
  return v.is_number() ? v.num() : kNaN;
}

std::vector<BPt> read_bezier(const Json& pts) {
  std::vector<BPt> out;
  if (!pts.is_array()) return out;
  out.reserve(pts.arr().size());
  for (const Json& p : pts.arr()) {
    out.push_back({num_nan(p, "x"), num_nan(p, "y"), num_nan(p, "inX"), num_nan(p, "inY"), num_nan(p, "outX"),
                   num_nan(p, "outY")});
  }
  return out;
}

Pt cubic_at(const BPt& a, const BPt& b, double t) {
  const double u = 1 - t;
  const double w0 = u * u * u;
  const double w1 = 3 * u * u * t;
  const double w2 = 3 * u * t * t;
  const double w3 = t * t * t;
  return {w0 * a.x + w1 * a.outX + w2 * b.inX + w3 * b.x, w0 * a.y + w1 * a.outY + w2 * b.inY + w3 * b.y};
}

double adaptive_steps(const BPt& a, const BPt& b) {
  const double len = hypot2(a.outX - a.x, a.outY - a.y) + hypot2(b.inX - a.outX, b.inY - a.outY) +
                     hypot2(b.x - b.inX, b.y - b.inY);
  const double steps = std::ceil(len / 2.5);
  return jmax(8, jmin(160, steps));
}

Poly flatten_outline(const std::vector<BPt>& pts, bool open) {
  const std::size_t n = pts.size();
  Poly out;
  if (n < 2) {
    for (const BPt& p : pts) out.push_back({p.x, p.y});
    return out;
  }
  const std::size_t segments = open ? n - 1 : n;
  for (std::size_t i = 0; i < segments; ++i) {
    const BPt& a = pts[i];
    const BPt& b = pts[(i + 1) % n];
    out.push_back({a.x, a.y});
    // `!==` — NaN handles count as curved, exactly as undefined ones do in JS.
    const bool curved = a.outX != a.x || a.outY != a.y || b.inX != b.x || b.inY != b.y;
    if (curved) {
      const double steps = adaptive_steps(a, b);
      for (double s = 1; s < steps; ++s) out.push_back(cubic_at(a, b, s / steps));
    }
  }
  if (open) out.push_back({pts[n - 1].x, pts[n - 1].y});
  return out;
}

// ── extrudeMesh.ts rectOutline ───────────────────────────────────────────
Poly rect_outline(double width, double height, const std::array<double, 4>& radii, double segmentsPer90) {
  const double hw = width / 2;
  const double hh = height / 2;
  const double maxR = jmin(hw, hh);
  std::array<double, 4> rr{};
  for (std::size_t i = 0; i < 4; ++i) rr[i] = jmax(0, jmin(radii[i], maxR));
  struct Corner {
    double cx, cy, a0, r;
  };
  const std::array<Corner, 4> corners{
      Corner{-hw + rr[0], -hh + rr[0], kPi, rr[0]},
      Corner{hw - rr[1], -hh + rr[1], -kPi / 2, rr[1]},
      Corner{hw - rr[2], hh - rr[2], 0, rr[2]},
      Corner{-hw + rr[3], hh - rr[3], kPi / 2, rr[3]},
  };
  Poly pts;
  for (const Corner& c : corners) {
    if (c.r <= 0) {
      pts.push_back({c.cx, c.cy});
      continue;
    }
    const double n = jmax(2, jm::round(segmentsPer90 * jmin(1, c.r / 6 + 0.25)));
    for (double i = 0; i <= n; ++i) {
      const double a = c.a0 + (i / n) * (kPi / 2);
      pts.push_back({c.cx + jm::cos(a) * c.r, c.cy + jm::sin(a) * c.r});
    }
  }
  return pts;
}

Poly densify_closed(const Poly& pts, double maxLen) {
  if (!(maxLen > 0)) return pts;
  Poly out;
  const std::size_t n = pts.size();
  for (std::size_t i = 0; i < n; ++i) {
    const Pt& a = pts[i];
    const Pt& b = pts[(i + 1) % n];
    const double segs = jmax(1, std::ceil(hypot2(b.x - a.x, b.y - a.y) / maxLen));
    for (double s = 0; s < segs; ++s) {
      const double t = s / segs;
      out.push_back({a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t});
    }
  }
  return out;
}

/// pathOps.ts shapeOutline. `radii` absent = no rounding.
Poly shape_outline(const std::string& primitive, double w, double h, double ellipseSteps, double subdivide,
                   const std::optional<std::array<double, 4>>& radii,
                   const std::optional<std::array<double, 2>>& axisScale) {
  if (primitive == "ellipse") {
    Poly pts;
    for (double i = 0; i < ellipseSteps; ++i) {
      const double a = (i / ellipseSteps) * kPi * 2;
      pts.push_back({jm::cos(a) * (w / 2), jm::sin(a) * (h / 2)});
    }
    return pts;
  }
  if (radii && ((*radii)[0] > 0 || (*radii)[1] > 0 || (*radii)[2] > 0 || (*radii)[3] > 0)) {
    const std::array<double, 4>& rr = *radii;
    const double kx = axisScale && (*axisScale)[0] > 1e-6 ? (*axisScale)[0] : 1;
    const double ky = axisScale && (*axisScale)[1] > 1e-6 ? (*axisScale)[1] : 1;
    const std::array<double, 4> rv{rr[0], rr[1], rr[2], rr[3]};
    const double maxR = jm::max_of(std::span<const double>(rv));
    const double arcSteps = jmax(12, jmin(96, std::ceil((maxR * kPi * 0.5) / 2.5)));
    const Poly ring = rect_outline(w * kx, h * ky, rr, arcSteps);
    Poly pts;
    for (const Pt& p : ring) {
      const Pt q{p.x / kx, p.y / ky};
      if (pts.empty() || hypot2(q.x - pts.back().x, q.y - pts.back().y) > 1e-6) pts.push_back(q);
    }
    if (pts.size() > 1) {
      const Pt& first = pts.front();
      const Pt& last = pts.back();
      if (hypot2(first.x - last.x, first.y - last.y) <= 1e-6) pts.pop_back();
    }
    if (subdivide <= 0) return pts;
    return densify_closed(pts, jmax(w, h) / (subdivide + 1));
  }
  const std::array<Pt, 4> corners{Pt{-w / 2, -h / 2}, Pt{w / 2, -h / 2}, Pt{w / 2, h / 2}, Pt{-w / 2, h / 2}};
  if (subdivide <= 0) return {corners.begin(), corners.end()};
  Poly out;
  for (std::size_t i = 0; i < corners.size(); ++i) {
    const Pt& a = corners[i];
    const Pt& b = corners[(i + 1) % corners.size()];
    for (double s = 0; s < subdivide + 1; ++s) {
      const double t = s / (subdivide + 1);
      out.push_back({a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t});
    }
  }
  return out;
}

// ── the per-point operators ──────────────────────────────────────────────
Poly zigzag(const Poly& pts, bool closed, double amplitude, double segments) {
  const double seg = jmax(1, std::floor(segments));
  const std::size_t n = pts.size();
  if (n < 2) return pts;
  const std::size_t count = closed ? n : n - 1;
  Poly out;
  for (std::size_t i = 0; i < count; ++i) {
    const Pt& a = pts[i];
    const Pt& b = pts[(i + 1) % n];
    const double dx = b.x - a.x;
    const double dy = b.y - a.y;
    const double len = or_one(hypot2(dx, dy));
    const double nx = -dy / len;
    const double ny = dx / len;
    out.push_back(a);
    for (double s = 1; s < seg; ++s) {
      const double t = s / seg;
      const double off = amplitude * (std::fmod(s, 2.0) == 1 ? 1 : -1);
      out.push_back({a.x + dx * t + nx * off, a.y + dy * t + ny * off});
    }
  }
  if (!closed) out.push_back(pts[n - 1]);
  return out;
}

Poly round_corners(const Poly& pts, bool closed, double radius, double steps) {
  const std::size_t n = pts.size();
  if (n < 3 || radius <= 0) return pts;
  const double st = jmax(1, std::floor(steps));
  Poly out;
  for (std::size_t i = 0; i < n; ++i) {
    const Pt& cur = pts[i];
    if (!closed && (i == 0 || i == n - 1)) {
      out.push_back(cur);
      continue;
    }
    const Pt& prev = pts[(i + n - 1) % n];
    const Pt& next = pts[(i + 1) % n];
    const double v1x = prev.x - cur.x;
    const double v1y = prev.y - cur.y;
    const double v2x = next.x - cur.x;
    const double v2y = next.y - cur.y;
    const double l1 = or_one(hypot2(v1x, v1y));
    const double l2 = or_one(hypot2(v2x, v2y));
    const double d = jmin3(radius, l1 / 2, l2 / 2);
    const Pt p1{cur.x + (v1x / l1) * d, cur.y + (v1y / l1) * d};
    const Pt p2{cur.x + (v2x / l2) * d, cur.y + (v2y / l2) * d};
    out.push_back(p1);
    for (double s = 1; s < st; ++s) {
      const double t = s / st;
      const double mt = 1 - t;
      out.push_back({mt * mt * p1.x + 2 * mt * t * cur.x + t * t * p2.x, mt * mt * p1.y + 2 * mt * t * cur.y + t * t * p2.y});
    }
    out.push_back(p2);
  }
  return out;
}

Pt centroid(const Poly& pts) {
  double x = 0;
  double y = 0;
  for (const Pt& p : pts) {
    x += p.x;
    y += p.y;
  }
  const double n = pts.empty() ? 1 : static_cast<double>(pts.size());
  return {x / n, y / n};
}

Poly pucker_bloat(const Poly& pts, double amountPct) {
  if (pts.size() < 3) return pts;
  const Pt c = centroid(pts);
  const double f = 1 + amountPct / 100;
  Poly out;
  out.reserve(pts.size());
  for (const Pt& p : pts) out.push_back({c.x + (p.x - c.x) * f, c.y + (p.y - c.y) * f});
  return out;
}

Poly twist(const Poly& pts, double angleDeg) {
  if (pts.size() < 3) return pts;
  const Pt c = centroid(pts);
  double maxD = 0;
  for (const Pt& p : pts) {
    const double d = hypot2(p.x - c.x, p.y - c.y);
    if (d > maxD) maxD = d;
  }
  if (maxD == 0) return pts;
  Poly out;
  out.reserve(pts.size());
  for (const Pt& p : pts) {
    const double dx = p.x - c.x;
    const double dy = p.y - c.y;
    const double a = (angleDeg * kDeg) * (hypot2(dx, dy) / maxD);
    const double cs = jm::cos(a);
    const double sn = jm::sin(a);
    out.push_back({c.x + dx * cs - dy * sn, c.y + dx * sn + dy * cs});
  }
  return out;
}

// ── Offset Paths ─────────────────────────────────────────────────────────
Poly dedupe_points(const Poly& pts, bool closed) {
  Poly out;
  for (const Pt& p : pts) {
    if (!out.empty() && std::fabs(out.back().x - p.x) < 1e-9 && std::fabs(out.back().y - p.y) < 1e-9) continue;
    out.push_back(p);
  }
  if (closed && out.size() > 1) {
    const Pt& a = out.front();
    const Pt& b = out.back();
    if (std::fabs(a.x - b.x) < 1e-9 && std::fabs(a.y - b.y) < 1e-9) out.pop_back();
  }
  return out;
}

double signed_area(const Poly& ring) {
  double a = 0;
  const std::size_t n = ring.size();
  for (std::size_t i = 0; i < n; ++i) {
    const Pt& p = ring[i];
    const Pt& q = ring[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

std::optional<Pt> line_intersect(const Pt& p1, const Pt& d1, const Pt& p2, const Pt& d2) {
  const double denom = d1.x * d2.y - d1.y * d2.x;
  if (std::fabs(denom) < 1e-12) return std::nullopt;
  const double t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / denom;
  return Pt{p1.x + d1.x * t, p1.y + d1.y * t};
}

Poly offset_with_joins(const Poly& src, bool closed, double amount, const std::string& join, double miterLimit) {
  const std::size_t n = src.size();
  const std::size_t edgeCount = closed ? n : n - 1;
  std::vector<Pt> dirs;
  std::vector<Pt> norms;
  for (std::size_t i = 0; i < edgeCount; ++i) {
    const Pt& a = src[i];
    const Pt& b = src[(i + 1) % n];
    const double dx = b.x - a.x;
    const double dy = b.y - a.y;
    const double len = or_one(hypot2(dx, dy));
    dirs.push_back({dx / len, dy / len});
    norms.push_back({-dy / len, dx / len});
  }
  Poly out;
  const auto joinAt = [&](const Pt& v, std::size_t e0, std::size_t e1) {
    const Pt& n0 = norms[e0];
    const Pt& n1 = norms[e1];
    const Pt& d0 = dirs[e0];
    const Pt& d1 = dirs[e1];
    const Pt p1{v.x + n0.x * amount, v.y + n0.y * amount};
    const Pt p2{v.x + n1.x * amount, v.y + n1.y * amount};
    const double cross = d0.x * d1.y - d0.y * d1.x;
    if (std::fabs(cross) < 1e-12) {
      out.push_back(p1);
      if (hypot2(p2.x - p1.x, p2.y - p1.y) > 1e-9) out.push_back(p2);
      return;
    }
    const bool gap = cross * amount < 0;
    if (!gap) {
      if (const auto ix = line_intersect(p1, d0, p2, d1)) {
        out.push_back(*ix);
      } else {
        out.push_back(p1);
        out.push_back(p2);
      }
      return;
    }
    if (join == "miter") {
      const auto ix = line_intersect(p1, d0, p2, d1);
      if (ix && hypot2(ix->x - v.x, ix->y - v.y) <= miterLimit * std::fabs(amount)) {
        out.push_back(*ix);
        return;
      }
      out.push_back(p1);
      out.push_back(p2);
      return;
    }
    if (join == "round") {
      const double r = std::fabs(amount);
      const double a1 = jm::atan2(p1.y - v.y, p1.x - v.x);
      const double a2 = jm::atan2(p2.y - v.y, p2.x - v.x);
      double delta = a2 - a1;
      while (delta > kPi) delta -= kPi * 2;
      while (delta < -kPi) delta += kPi * 2;
      const double steps = jmax(2, jmin(64, std::ceil((std::fabs(delta) * r) / 2.5)));
      for (double s = 0; s <= steps; ++s) {
        const double a = a1 + (delta * s) / steps;
        out.push_back({v.x + jm::cos(a) * r, v.y + jm::sin(a) * r});
      }
      return;
    }
    out.push_back(p1);
    out.push_back(p2);
  };
  if (closed) {
    for (std::size_t i = 0; i < n; ++i) joinAt(src[i], (i + edgeCount - 1) % edgeCount, i);
  } else {
    out.push_back({src[0].x + norms[0].x * amount, src[0].y + norms[0].y * amount});
    for (std::size_t i = 1; i + 1 < n; ++i) joinAt(src[i], i - 1, i);
    const Pt& lastN = norms[edgeCount - 1];
    out.push_back({src[n - 1].x + lastN.x * amount, src[n - 1].y + lastN.y * amount});
  }
  return out;
}

struct Hit {
  double x, y, t, u;
};

std::optional<Hit> proper_seg_intersect(const Pt& a, const Pt& b, const Pt& c, const Pt& d) {
  const double rx = b.x - a.x;
  const double ry = b.y - a.y;
  const double sx = d.x - c.x;
  const double sy = d.y - c.y;
  const double denom = rx * sy - ry * sx;
  if (std::fabs(denom) < 1e-12) return std::nullopt;
  const double t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / denom;
  const double u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / denom;
  constexpr double e = 1e-9;
  if (t <= e || t >= 1 - e || u <= e || u >= 1 - e) return std::nullopt;
  return Hit{a.x + rx * t, a.y + ry * t, t, u};
}

std::vector<Poly> split_ring_at_self_intersections(const Poly& ring) {
  const std::size_t n = ring.size();
  struct Ins {
    double t, x, y;
  };
  std::vector<std::vector<Ins>> inserts(n);
  bool any = false;
  for (std::size_t i = 0; i < n; ++i) {
    const Pt& a = ring[i];
    const Pt& b = ring[(i + 1) % n];
    for (std::size_t j = i + 2; j < n; ++j) {
      if (i == 0 && j == n - 1) continue;
      const Pt& c = ring[j];
      const Pt& d = ring[(j + 1) % n];
      if (jmax(a.x, b.x) < jmin(c.x, d.x) || jmax(c.x, d.x) < jmin(a.x, b.x) || jmax(a.y, b.y) < jmin(c.y, d.y) ||
          jmax(c.y, d.y) < jmin(a.y, b.y)) {
        continue;
      }
      const auto hit = proper_seg_intersect(a, b, c, d);
      if (!hit) continue;
      inserts[i].push_back({hit->t, hit->x, hit->y});
      inserts[j].push_back({hit->u, hit->x, hit->y});
      any = true;
    }
  }
  if (!any) return {ring};
  Poly seq;
  for (std::size_t i = 0; i < n; ++i) {
    seq.push_back(ring[i]);
    auto& ins = inserts[i];
    std::ranges::stable_sort(ins, [](const Ins& p, const Ins& q) { return p.t < q.t; });
    for (const Ins& e : ins) seq.push_back({e.x, e.y});
  }
  std::vector<Poly> loops;
  Poly stack;
  // `${Math.round(x·1e6)}:${Math.round(y·1e6)}` — keyed on the rounded pair
  // (a map compare treats -0 and 0 as one key, as the string does).
  using Key = std::pair<double, double>;
  std::map<Key, std::size_t> index;
  const auto key = [](const Pt& p) { return Key{jm::round(p.x * 1e6), jm::round(p.y * 1e6)}; };
  for (const Pt& p : seq) {
    const Key k = key(p);
    const auto it = index.find(k);
    if (it != index.end()) {
      const std::size_t at = it->second;
      Poly loop(stack.begin() + static_cast<std::ptrdiff_t>(at), stack.end());
      stack.resize(at);
      for (const Pt& q : loop) index.erase(key(q));
      if (loop.size() >= 3) loops.push_back(std::move(loop));
    }
    index[k] = stack.size();
    stack.push_back(p);
  }
  if (stack.size() >= 3) loops.push_back(std::move(stack));
  return loops;
}

std::vector<Poly> clean_closed_offset(Poly ring, const Poly& src, Ctx& ctx) {
  const std::size_t n = src.size();
  bool sawPos = false;
  bool sawNeg = false;
  for (std::size_t i = 0; i < n; ++i) {
    const Pt& a = src[i];
    const Pt& b = src[(i + 1) % n];
    const Pt& c = src[(i + 2) % n];
    const double cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cr > 1e-9) sawPos = true;
    else if (cr < -1e-9) sawNeg = true;
  }
  if (!(sawPos && sawNeg)) {
    const double a1 = signed_area(ring);
    if (std::fabs(a1) < 1e-6) return {};
    if (ring.size() == n) {
      for (std::size_t i = 0; i < n; ++i) {
        const Pt& sa = src[i];
        const Pt& sb = src[(i + 1) % n];
        const Pt& ra = ring[i];
        const Pt& rb = ring[(i + 1) % n];
        if ((sb.x - sa.x) * (rb.x - ra.x) + (sb.y - sa.y) * (rb.y - ra.y) < 0) return {};
      }
    } else if (signed_area(src) * a1 < 0) {
      return {};
    }
    return {std::move(ring)};
  }
  const int want = signed_area(src) >= 0 ? 1 : -1;
  std::vector<Poly> kept;
  for (Poly& l : split_ring_at_self_intersections(ring)) {
    const double a = signed_area(l);
    if (std::fabs(a) > 1e-6 && (a >= 0 ? 1 : -1) == want) kept.push_back(std::move(l));
  }
  if (kept.size() <= 1) return kept;
  // Several overlapping loops go through polygon-clipping's union (Martinez)
  // in the TypeScript — outside the port.
  ctx.unported = true;
  return kept;
}

std::vector<Poly> offset_path_runs(const Poly& pts, bool closed, double amount, const std::string& join,
                                   double miterLimit, Ctx& ctx) {
  if (pts.size() < 2 || amount == 0) return {pts};
  const Poly src = dedupe_points(pts, closed);
  if (src.size() < 2) return {pts};
  Poly ring = offset_with_joins(src, closed, amount, join, jmax(1, miterLimit));
  if (!closed || ring.size() < 3) {
    if (ring.size() > 1) return {std::move(ring)};
    return {};
  }
  return clean_closed_offset(std::move(ring), src, ctx);
}

// ── temporal noise (Roughen / Wiggle Transform) ──────────────────────────
class TemporalNoise {
 public:
  TemporalNoise(double phase, double seed) : seed_(seed), k0_(std::floor(phase)) {
    const double frac = phase - k0_;
    smooth_ = frac * frac * (3 - 2 * frac);
  }
  [[nodiscard]] double operator()(double i, double ch) const {
    if (smooth_ == 0) return hash(i, k0_, ch);
    return hash(i, k0_, ch) + (hash(i, k0_ + 1, ch) - hash(i, k0_, ch)) * smooth_;
  }

 private:
  [[nodiscard]] double hash(double i, double k, double ch) const {
    const double h0 = (i + 1) * 374761393.0 + k * 668265263.0 + seed_ * 2246822519.0 + ch * 2654435761.0;
    const std::uint32_t u0 = jm::to_uint32(h0);
    const std::uint32_t x0 = u0 ^ (u0 >> 13U);
    const double h1 = static_cast<double>(std::bit_cast<std::int32_t>(x0)) * 1274126177.0;
    const std::uint32_t u1 = jm::to_uint32(h1);
    const std::uint32_t x1 = u1 ^ (u1 >> 16U);
    return (static_cast<double>(x1) / 4294967296.0) * 2 - 1;
  }
  double seed_;
  double k0_;
  double smooth_ = 0;
};

Poly roughen(const Poly& pts, bool closed, double amount, double detail, double phase, double seed, double correlation) {
  const std::size_t n = pts.size();
  if (n < 2 || amount == 0) return pts;
  const double sub = jmax(1, jmin(10, jm::round(detail)));
  Poly dense;
  const std::size_t segs = closed ? n : n - 1;
  for (std::size_t i = 0; i < segs; ++i) {
    const Pt& a = pts[i];
    const Pt& b = pts[(i + 1) % n];
    for (double s = 0; s < sub; ++s) {
      const double t = s / sub;
      dense.push_back({a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t});
    }
  }
  if (!closed) dense.push_back(pts[n - 1]);
  const std::size_t m = dense.size();
  const TemporalNoise rnd(phase, seed);
  const double c = jmax(0, jmin(100, correlation)) / 100;
  const double sharedMag = rnd(-1, 0);
  const double sharedAng = rnd(-1, 1);
  const auto disp = [&](double i, double ch) {
    if (c == 0) return rnd(i, ch);
    const double own = rnd(i, ch);
    return own + ((ch == 0 ? sharedMag : sharedAng) - own) * c;
  };
  Poly out;
  out.reserve(m);
  for (std::size_t i = 0; i < m; ++i) {
    const Pt& p = dense[i];
    const Pt& prev = dense[(i + m - 1) % m];
    const Pt& next = dense[(i + 1) % m];
    const double dx = next.x - prev.x;
    const double dy = next.y - prev.y;
    const double len = or_one(hypot2(dx, dy));
    const double nx = -dy / len;
    const double ny = dx / len;
    const auto fi = static_cast<double>(i);
    const double mag = amount * disp(fi, 0);
    const double ang = disp(fi, 1) * kPi;
    const double cs = jm::cos(ang);
    const double sn = jm::sin(ang);
    out.push_back({p.x + (nx * cs - ny * sn) * mag, p.y + (nx * sn + ny * cs) * mag});
  }
  return out;
}

Poly apply_path_op(const Poly& pts, bool closed, const Op& op, double timeSec) {
  if (op.type == "zigzag") return zigzag(pts, closed, op.amount, op.detail);
  if (op.type == "roundCorners") return round_corners(pts, closed, op.amount, op.detail);
  if (op.type == "pucker") return pucker_bloat(pts, op.amount);
  if (op.type == "twist") return twist(pts, op.amount);
  if (op.type == "roughen") {
    return roughen(pts, closed, op.amount, op.detail, timeSec * op.wigglesPerSecond, op.seed, op.correlation);
  }
  return pts;
}

// ── chain-level operators ────────────────────────────────────────────────
std::vector<Run> apply_trim_individually(const std::vector<Run>& runs, const std::vector<Seg>& segs) {
  std::vector<double> lens;
  lens.reserve(runs.size());
  for (const Run& r : runs) lens.push_back(r.pts.size() < 2 ? 0 : seg_total(r.pts, r.closed));
  double total = 0;
  for (double l : lens) total += l;
  if (total <= 0) return {};
  std::vector<Run> out;
  for (const Seg& sg : segs) {
    const double startLen = sg[0] * total;
    const double endLen = sg[1] * total;
    if (endLen <= startLen) continue;
    double acc = 0;
    for (std::size_t i = 0; i < runs.size(); ++i) {
      const Run& run = runs[i];
      const double runLen = lens[i];
      const double runStart = acc;
      const double runEnd = acc + runLen;
      acc = runEnd;
      if (runLen <= 0) continue;
      const double a = jmax(startLen, runStart);
      const double b = jmin(endLen, runEnd);
      if (b <= a) continue;
      const double localLo = (a - runStart) / runLen;
      const double localHi = (b - runStart) / runLen;
      if (localLo <= 1e-9 && localHi >= 1 - 1e-9) {
        out.push_back(run);
        continue;
      }
      for (Poly& cut : trim_polyline(run.pts, run.closed, {Seg{localLo, localHi}})) {
        out.push_back({std::move(cut), false, run.opacity, run.strokeScale});
      }
    }
  }
  return out;
}

std::vector<Run> apply_trim(const std::vector<Run>& runs, const Op& op) {
  const std::vector<Seg> segs = trim_segments(op.start, op.end, op.offset);
  if (is_full(segs)) return runs;
  if (op.individually && runs.size() > 1) return apply_trim_individually(runs, segs);
  std::vector<Run> out;
  for (const Run& run : runs) {
    for (Poly& cut : trim_polyline(run.pts, run.closed, segs)) {
      out.push_back({std::move(cut), false, run.opacity, run.strokeScale});
    }
  }
  return out;
}

/// repeater.ts RepeaterCopy.
struct Rung {
  double dx = 0, dy = 0, drot = 0, scaleMul = 1, opacityMul = 1;
};

Rung ladder_at_integer(const Op& rep, double k) {
  double x = 0;
  double y = 0;
  double rot = 0;
  double scale = 1;
  double op = 1;
  const double steps = std::fabs(k);
  const bool fwd = !(k < 0);
  for (double i = 0; i < steps; ++i) {
    if (fwd) {
      rot += rep.offsetRotation;
      const double rad = rot * kDeg;
      x += rep.offsetX * jm::cos(rad) - rep.offsetY * jm::sin(rad);
      y += rep.offsetX * jm::sin(rad) + rep.offsetY * jm::cos(rad);
      scale *= rep.offsetScale;
      op *= rep.offsetOpacity;
    } else {
      const double rad = rot * kDeg;
      x -= rep.offsetX * jm::cos(rad) - rep.offsetY * jm::sin(rad);
      y -= rep.offsetX * jm::sin(rad) + rep.offsetY * jm::cos(rad);
      rot -= rep.offsetRotation;
      scale = rep.offsetScale == 0 ? 0 : scale / rep.offsetScale;
      op = rep.offsetOpacity == 0 ? 0 : op / rep.offsetOpacity;
    }
  }
  return {x, y, rot, scale, op};
}

Rung ladder_at(const Op& rep, double k) {
  const double lo = std::floor(k);
  const double f = k - lo;
  const Rung a = ladder_at_integer(rep, lo);
  if (f == 0) return a;
  const Rung b = ladder_at_integer(rep, lo + 1);
  const auto mix = [f](double u, double v) { return u + (v - u) * f; };
  return {mix(a.dx, b.dx), mix(a.dy, b.dy), mix(a.drot, b.drot), mix(a.scaleMul, b.scaleMul),
          mix(a.opacityMul, b.opacityMul)};
}

std::vector<Rung> repeater_copies(const Op& rep) {
  const double n = jmax(1, std::floor(rep.copies));
  const double start = rep.offset;
  const double ax = rep.anchorX;
  const double ay = rep.anchorY;
  std::vector<Rung> out;
  for (double i = 0; i < n; ++i) {
    Rung rung = ladder_at(rep, i + start);
    if (ax != 0 || ay != 0) {
      const double rad = rung.drot * kDeg;
      const double c = jm::cos(rad) * rung.scaleMul;
      const double s = jm::sin(rad) * rung.scaleMul;
      rung.dx += ax - (c * ax - s * ay);
      rung.dy += ay - (s * ax + c * ay);
    }
    out.push_back(rung);
  }
  if (rep.below) std::ranges::reverse(out);
  return out;
}

std::vector<Run> apply_repeater(const std::vector<Run>& runs, const Op& op) {
  std::vector<Run> out;
  for (const Rung& c : repeater_copies(op)) {
    const double rad = c.drot * kDeg;
    const double cs = jm::cos(rad) * c.scaleMul;
    const double sn = jm::sin(rad) * c.scaleMul;
    for (const Run& r : runs) {
      Run o;
      o.closed = r.closed;
      o.pts.reserve(r.pts.size());
      for (const Pt& p : r.pts) o.pts.push_back({p.x * cs - p.y * sn + c.dx, p.x * sn + p.y * cs + c.dy});
      o.opacity = r.opacity.value_or(1) * c.opacityMul;
      o.strokeScale = r.strokeScale.value_or(1) * c.scaleMul;
      out.push_back(std::move(o));
    }
  }
  return out;
}

std::vector<Run> apply_wiggle_transform(const std::vector<Run>& runs, const Op& op, double timeSec) {
  const double pos = jmax(0, op.amount);
  const double rotAmp = jmax(0, op.wiggleRotation);
  const double sclAmp = jmax(0, op.wiggleScale);
  const TemporalNoise rnd(timeSec * op.wigglesPerSecond, op.seed);
  const double c = jmax(0, jmin(100, op.correlation)) / 100;
  const auto nz = [&](double i, double ch) {
    const double own = rnd(i, ch);
    return c == 0 ? own : own + (rnd(-1, ch) - own) * c;
  };
  const double ax = op.anchorX;
  const double ay = op.anchorY;
  std::vector<Run> out;
  out.reserve(runs.size());
  for (std::size_t idx = 0; idx < runs.size(); ++idx) {
    const Run& r = runs[idx];
    const auto i = static_cast<double>(idx);
    const double dx = pos * nz(i, 0);
    const double dy = pos * nz(i, 1);
    const double ang = rotAmp * nz(i, 2) * kDeg;
    const double s = jmax(0, 1 + (sclAmp / 100) * nz(i, 3));
    const double cs = jm::cos(ang) * s;
    const double sn = jm::sin(ang) * s;
    Run o;
    o.closed = r.closed;
    o.pts.reserve(r.pts.size());
    for (const Pt& p : r.pts) {
      o.pts.push_back({(p.x - ax) * cs - (p.y - ay) * sn + ax + dx, (p.x - ax) * sn + (p.y - ay) * cs + ay + dy});
    }
    o.opacity = r.opacity;
    o.strokeScale = r.strokeScale.value_or(1) * s;
    out.push_back(std::move(o));
  }
  return out;
}

std::vector<Run> apply_path_op_chain(std::vector<Run> out, const std::vector<Op>& ops, double timeSec, Ctx& ctx) {
  for (const Op& op : ops) {
    if (op.type == "none") continue;
    if (op.type == "trim") {
      out = apply_trim(out, op);
      continue;
    }
    if (op.type == "repeater") {
      out = apply_repeater(out, op);
      continue;
    }
    if (op.type == "wiggleTransform") {
      out = apply_wiggle_transform(out, op, timeSec);
      continue;
    }
    if (op.type == "offset") {
      std::vector<Run> next;
      for (const Run& r : out) {
        for (Poly& pts : offset_path_runs(r.pts, r.closed, op.amount, op.lineJoin, op.miterLimit, ctx)) {
          if (pts.size() > 1) next.push_back({std::move(pts), r.closed, r.opacity, r.strokeScale});
        }
      }
      out = std::move(next);
      continue;
    }
    for (Run& r : out) r.pts = apply_path_op(r.pts, r.closed, op, timeSec);
  }
  return out;
}

// ── resolvePathOps ───────────────────────────────────────────────────────
Op resolve_one(const Json& o, const Values& av) {
  Op op;
  op.id = o.at("id").is_string() ? o.at("id").str() : std::string();
  op.type = o.at("type").is_string() ? o.at("type").str() : std::string("zigzag");
  const auto stored = [&](std::string_view k, double fb) { return o.at(k).is_number() ? o.at(k).num() : fb; };
  const auto v = [&](std::string_view param, double fb) {
    std::string path = "pathop.";
    path += op.id;
    path += '.';
    path += param;
    return av.get(path).value_or(fb);
  };
  op.amount = v("amount", stored("amount", 20));
  op.detail = v("detail", stored("detail", 4));
  op.wigglesPerSecond = jmax(0, v("wigglesPerSecond", stored("wigglesPerSecond", 0)));
  op.seed = stored("seed", 0);
  op.correlation = jmax(0, jmin(100, v("correlation", stored("correlation", 0))));
  op.wiggleRotation = jmax(0, v("wiggleRotation", stored("wiggleRotation", 0)));
  op.wiggleScale = jmax(0, v("wiggleScale", stored("wiggleScale", 0)));
  const Json& lj = o.at("lineJoin");
  op.lineJoin = lj.is_string() && (lj.str() == "round" || lj.str() == "bevel") ? lj.str() : std::string("miter");
  op.miterLimit = jmax(1, v("miterLimit", stored("miterLimit", 4)));
  op.start = v("start", stored("start", 0));
  op.end = v("end", stored("end", 100));
  op.offset = v("offset", stored("offset", 0));
  op.individually = o.at("trimMultipleShapes").is_string() && o.at("trimMultipleShapes").str() == "individually";
  op.copies = v("copies", stored("copies", 1));
  op.offsetX = v("offsetX", stored("offsetX", 0));
  op.offsetY = v("offsetY", stored("offsetY", 0));
  op.offsetRotation = v("offsetRotation", stored("offsetRotation", 0));
  op.offsetScale = v("offsetScale", stored("offsetScale", 1));
  op.offsetOpacity = v("offsetOpacity", stored("offsetOpacity", 1));
  op.anchorX = v("anchorX", stored("anchorX", 0));
  op.anchorY = v("anchorY", stored("anchorY", 0));
  op.below = o.at("composite").is_string() && o.at("composite").str() == "below";
  return op;
}

bool is_inert(const Op& op) {
  if (op.type == "none") return true;
  if (op.type == "trim") return is_full(trim_segments(op.start, op.end, op.offset));
  if (op.type == "repeater") return op.copies <= 1;
  if (op.type == "wiggleTransform") return op.amount <= 0 && op.wiggleRotation <= 0 && op.wiggleScale <= 0;
  return false;
}

Json corner_json(double x, double y) {
  Json p = Json::object();
  p.set("x", Json::number(x));
  p.set("y", Json::number(y));
  p.set("inX", Json::number(x));
  p.set("inY", Json::number(y));
  p.set("outX", Json::number(x));
  p.set("outY", Json::number(y));
  return p;
}

Json corners_json(const Poly& pts) {
  Json a = Json::array();
  a.arr_mut().reserve(pts.size());
  for (const Pt& p : pts) a.arr_mut().push_back(corner_json(p.x, p.y));
  return a;
}

/// buildSnapshot.ts runPaints: per-run paint, or nullopt when no run needs any.
std::optional<std::vector<Json>> run_paints(const std::vector<Run>& runs, const RLayer& layer) {
  const bool needs = std::ranges::any_of(
      runs, [](const Run& r) { return r.opacity.value_or(1) != 1 || r.strokeScale.value_or(1) != 1; });
  if (!needs) return std::nullopt;
  const Json* sole = nullptr;
  if (layer.strokes.is_array() && !layer.strokes.arr().empty()) {
    if (layer.strokes.arr().size() == 1) sole = &layer.strokes.arr()[0];
  } else if (!layer.stroke.is_undefined() && !layer.stroke.is_null()) {
    sole = &layer.stroke;
  }
  std::vector<Json> out;
  out.reserve(runs.size());
  for (const Run& r : runs) {
    const double opacity = r.opacity.value_or(1);
    const double ss = r.strokeScale.value_or(1);
    Json paint = Json::object();
    paint.set("opacity", Json::number(opacity));
    if (sole != nullptr && ss != 1) {
      Json stroke = *sole;
      const Json& w = sole->at("width");
      stroke.set("width", Json::number((w.is_number() ? w.num() : kNaN) * ss));
      paint.set("stroke", std::move(stroke));
    }
    out.push_back(std::move(paint));
  }
  return out;
}

}  // namespace

std::vector<std::array<double, 2>> shape_outline_points(const std::string& primitive, double w, double h, double ellipseSteps,
                                                     double subdivide, const std::optional<std::array<double, 4>>& radii,
                                                     const std::optional<std::array<double, 2>>& axisScale) {
  std::vector<std::array<double, 2>> out;
  for (const Pt& p : shape_outline(primitive, w, h, ellipseSteps, subdivide, radii, axisScale)) out.push_back({p.x, p.y});
  return out;
}

GeometryStatus apply_path_ops(const doc::Node& n, const Values& a, double layerTime, RLayer& layer) {
  std::vector<Op> ops;
  for (const Json& raw : doc::read_path_ops(n)) {
    Op op = resolve_one(raw, a);
    if (!is_inert(op)) ops.push_back(std::move(op));
  }
  if (ops.empty()) return GeometryStatus::none;

  const bool dense = std::ranges::any_of(ops, [](const Op& o) { return o.type == "pucker" || o.type == "twist"; });
  std::vector<Run> seed;
  if (layer.subpaths.is_array() && !layer.subpaths.arr().empty()) {
    for (const Json& sp : layer.subpaths.arr()) {
      const bool open = sp.at("open").is_bool() && sp.at("open").b();
      seed.push_back({flatten_outline(read_bezier(sp.at("points")), open), !open, std::nullopt, std::nullopt});
    }
  } else {
    Poly base;
    if (layer.pathPoints.is_array() && layer.pathPoints.arr().size() > 1) {
      base = flatten_outline(read_bezier(layer.pathPoints), layer.pathOpen);
    } else {
      // `layer.cornerRadii ?? layer.cornerRadius` (a number rounds all four).
      std::optional<std::array<double, 4>> radii = layer.cornerRadii;
      if (!radii) radii = std::array<double, 4>{layer.cornerRadius, layer.cornerRadius, layer.cornerRadius, layer.cornerRadius};
      base = shape_outline(layer.primitive, layer.width, layer.height, 48, dense ? 8 : 0, radii, layer.cornerRadiusScale);
    }
    seed.push_back({std::move(base), !layer.pathOpen, std::nullopt, std::nullopt});
  }

  Ctx ctx;
  std::vector<Run> chained = apply_path_op_chain(std::move(seed), ops, layerTime, ctx);
  if (ctx.unported) return GeometryStatus::unported;
  std::vector<Run> runs;
  for (Run& r : chained) {
    if (r.pts.size() > 1) runs.push_back(std::move(r));
  }

  const auto paints = run_paints(runs, layer);
  if (runs.empty()) {
    layer.visible = false;
  } else if (runs.size() == 1 && runs[0].closed && !paints) {
    layer.pathPoints = corners_json(runs[0].pts);
    layer.subpaths = Json();
    layer.primitive = "path";
  } else {
    Json subs = Json::array();
    for (std::size_t i = 0; i < runs.size(); ++i) {
      Json sp = Json::object();
      sp.set("points", corners_json(runs[i].pts));
      sp.set("open", Json::boolean(!runs[i].closed));
      if (paints) sp.set("paint", (*paints)[i]);
      subs.arr_mut().push_back(std::move(sp));
    }
    layer.subpaths = std::move(subs);
    layer.pathPoints = Json();
    layer.pathOpen = false;
    layer.primitive = "path";
  }

  layer.cornerRadius = 0;
  layer.cornerRadii.reset();
  layer.cornerRadiusScale.reset();

  if (!runs.empty() && std::ranges::any_of(ops, [](const Op& o) { return o.type == "repeater"; })) {
    double halfW = 0;
    double halfH = 0;
    for (const Run& r : runs) {
      for (const Pt& p : r.pts) {
        if (std::fabs(p.x) > halfW) halfW = std::fabs(p.x);
        if (std::fabs(p.y) > halfH) halfH = std::fabs(p.y);
      }
    }
    if (halfW * 2 > layer.width) layer.width = halfW * 2;
    if (halfH * 2 > layer.height) layer.height = halfH * 2;
  }
  return GeometryStatus::applied;
}

GeometryStatus apply_polystar(const doc::Node& n, const Values& a, Json& pathPoints, double& layerW, double& layerH) {
  const std::optional<Json> cfg = doc::read_node_polystar(n);
  if (!cfg) return GeometryStatus::none;
  const auto v = [&](std::string_view param) {
    std::string path = "polystar.";
    path += param;
    return a.get(path).value_or(cfg->at(param).num());
  };
  const bool star = cfg->at("starType").is_string() && cfg->at("starType").str() == "star";
  // resolvePolystar
  const double points = jmax(3, jm::round(v("points")));
  const double rotation = v("rotation");
  const double outerRadius = jmax(0, v("outerRadius"));
  const double innerRadius = jmax(0, v("innerRadius"));
  const double outerRoundness = v("outerRoundness");
  const double innerRoundness = v("innerRoundness");
  // polystarOutline
  const double cnt = jmax(3, jm::round(points));
  const double total = star ? cnt * 2 : cnt;
  const double step = (kPi * 2) / total;
  const double start = (rotation - 90) * kDeg;
  Json out = Json::array();
  for (double i = 0; i < total; ++i) {
    const bool outer = !star || std::fmod(i, 2.0) == 0;
    const double r = outer ? outerRadius : innerRadius;
    const double pct = (outer ? outerRoundness : innerRoundness) / 100;
    const double ang = start + i * step;
    const double x = jm::cos(ang) * r;
    const double y = jm::sin(ang) * r;
    const double tx = -jm::sin(ang);
    const double ty = jm::cos(ang);
    const double hl = (kPi * r * pct) / (2 * cnt);
    Json p = Json::object();
    p.set("x", Json::number(x));
    p.set("y", Json::number(y));
    p.set("inX", Json::number(x - tx * hl));
    p.set("inY", Json::number(y - ty * hl));
    p.set("outX", Json::number(x + tx * hl));
    p.set("outY", Json::number(y + ty * hl));
    out.arr_mut().push_back(std::move(p));
  }
  pathPoints = std::move(out);
  const double reach = jmax(1, jmax(outerRadius, star ? innerRadius : 0));
  layerW = reach * 2;
  layerH = reach * 2;
  return GeometryStatus::applied;
}

}  // namespace premation::scene
