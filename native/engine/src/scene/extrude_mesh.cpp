#include "extrude_mesh.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <numbers>
#include <utility>

#include "jsmath.hpp"

namespace premation::scene::mesh {
namespace {

namespace jm = motion::js;

constexpr double kPi = std::numbers::pi;
constexpr double kInf = std::numeric_limits<double>::infinity();

double hyp2(double a, double b) noexcept {
  const std::array<double, 2> v{a, b};
  return jm::hypot(std::span<const double>(v));
}
double hyp3(double a, double b, double c) noexcept {
  const std::array<double, 3> v{a, b, c};
  return jm::hypot(std::span<const double>(v));
}
double jmin(double a, double b) noexcept {
  const std::array<double, 2> v{a, b};
  return jm::min_of(std::span<const double>(v));
}
double jmin3(double a, double b, double c) noexcept {
  const std::array<double, 3> v{a, b, c};
  return jm::min_of(std::span<const double>(v));
}
double jmax(double a, double b) noexcept {
  const std::array<double, 2> v{a, b};
  return jm::max_of(std::span<const double>(v));
}
/// `v || 1`.
double or_one(double v) noexcept { return v == 0 || std::isnan(v) ? 1 : v; }

double cross(double ax, double ay, double bx, double by) noexcept { return (ax * by) - (ay * bx); }

/// Strictly inside the triangle (points ON an edge or AT a corner are outside).
bool strictly_inside(Pt2 p, Pt2 a, Pt2 b, Pt2 c) noexcept {
  const double d1 = cross(b.x - a.x, b.y - a.y, p.x - a.x, p.y - a.y);
  const double d2 = cross(c.x - b.x, c.y - b.y, p.x - b.x, p.y - b.y);
  const double d3 = cross(a.x - c.x, a.y - c.y, p.x - c.x, p.y - c.y);
  return (d1 > 0 && d2 > 0 && d3 > 0) || (d1 < 0 && d2 < 0 && d3 < 0);
}

bool same_point(Pt2 a, Pt2 b) noexcept { return a.x == b.x && a.y == b.y; }

std::size_t wrap(std::size_t i, std::size_t n) noexcept { return i % n; }
std::size_t prev_of(std::size_t i, std::size_t n) noexcept { return (i + n - 1) % n; }

// ── polygonTriangulate.ts bridgeHole ─────────────────────────────────────
std::vector<std::uint32_t> bridge_hole(const std::vector<Pt2>& verts, const std::vector<std::uint32_t>& outer,
                                       const std::vector<std::uint32_t>& hole) {
  std::size_t mi = 0;
  for (std::size_t i = 1; i < hole.size(); ++i) {
    if (verts[hole[i]].x > verts[hole[mi]].x) mi = i;
  }
  const Pt2 M = verts[hole[mi]];

  double bestT = kInf;
  std::ptrdiff_t bestEdge = -1;
  std::optional<Pt2> bestPt;
  const std::size_t on = outer.size();
  for (std::size_t i = 0; i < on; ++i) {
    const Pt2 P = verts[outer[i]];
    const Pt2 Q = verts[outer[wrap(i + 1, on)]];
    if (!(P.y <= M.y && Q.y > M.y)) continue;
    const double t = (M.y - P.y) / (Q.y - P.y);
    const double x = P.x + (t * (Q.x - P.x));
    if (x < M.x) continue;
    const double dist = x - M.x;
    if (dist < bestT) {
      bestT = dist;
      bestEdge = static_cast<std::ptrdiff_t>(i);
      bestPt = Pt2{x, M.y};
    }
  }
  if (bestEdge < 0 || !bestPt) return outer;

  const auto ia = static_cast<std::size_t>(bestEdge);
  const std::size_t ib = wrap(ia + 1, on);
  std::size_t cand = verts[outer[ia]].x > verts[outer[ib]].x ? ia : ib;
  const Pt2 Pc = verts[outer[cand]];
  if (!same_point(Pc, *bestPt)) {
    double bestAngle = kInf;
    double bestDist = kInf;
    for (std::size_t i = 0; i < on; ++i) {
      if (i == cand) continue;
      const Pt2 R = verts[outer[i]];
      if (R.x < M.x || R.x > Pc.x) continue;
      if (!strictly_inside(R, M, *bestPt, Pc) && !(R.y == M.y && R.x > M.x && R.x < Pc.x)) continue;
      const Pt2 prev = verts[outer[prev_of(i, on)]];
      const Pt2 next = verts[outer[wrap(i + 1, on)]];
      if (cross(R.x - prev.x, R.y - prev.y, next.x - R.x, next.y - R.y) > 0) continue;
      const double dx = R.x - M.x;
      const double dy = std::abs(R.y - M.y);
      const double angle = jm::atan2(dy, dx);
      const double dist = (dx * dx) + (dy * dy);
      if (angle < bestAngle || (angle == bestAngle && dist < bestDist)) {
        bestAngle = angle;
        bestDist = dist;
        cand = i;
      }
    }
  }

  std::vector<std::uint32_t> merged;
  merged.reserve(on + hole.size() + 2);
  for (std::size_t i = 0; i <= cand; ++i) merged.push_back(outer[i]);
  for (std::size_t k = 0; k <= hole.size(); ++k) merged.push_back(hole[wrap(mi + k, hole.size())]);
  for (std::size_t i = cand; i < on; ++i) merged.push_back(outer[i]);
  return merged;
}

/// polygonTriangulate.ts earClipRing.
std::vector<std::uint32_t> ear_clip_ring(const std::vector<Pt2>& verts, std::vector<std::uint32_t> ring) {
  std::vector<std::uint32_t> tris;
  const std::size_t n0 = ring.size();
  if (n0 < 3) return tris;

  const auto isConvex = [&](std::size_t i) {
    const std::size_t n = ring.size();
    const Pt2 a = verts[ring[prev_of(i, n)]];
    const Pt2 b = verts[ring[i]];
    const Pt2 c = verts[ring[wrap(i + 1, n)]];
    return cross(b.x - a.x, b.y - a.y, c.x - b.x, c.y - b.y) > 0;
  };

  std::size_t guard = 0;
  const std::size_t limit = (n0 * n0) + 64;
  std::size_t i = 0;
  while (ring.size() > 3 && guard++ < limit) {
    const std::size_t n = ring.size();
    const std::uint32_t ia = ring[prev_of(i, n)];
    const std::uint32_t ib = ring[i];
    const std::uint32_t ic = ring[wrap(i + 1, n)];
    const Pt2 a = verts[ia];
    const Pt2 b = verts[ib];
    const Pt2 c = verts[ic];
    const double twice = cross(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y);
    if (same_point(a, c) || (std::abs(twice) < 1e-9 && !same_point(a, b))) {
      ring.erase(ring.begin() + static_cast<std::ptrdiff_t>(i));
      if (i >= ring.size()) i = 0;
      guard = 0;
      continue;
    }
    bool ear = isConvex(i);
    if (ear) {
      for (std::size_t j = 0; j < n; ++j) {
        const std::uint32_t ij = ring[j];
        if (ij == ia || ij == ib || ij == ic) continue;
        const Pt2 p = verts[ij];
        if (same_point(p, a) || same_point(p, b) || same_point(p, c)) continue;
        if (strictly_inside(p, a, b, c)) {
          ear = false;
          break;
        }
      }
    }
    if (ear) {
      if (std::abs(cross(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y)) > 1e-9) {
        tris.push_back(ia);
        tris.push_back(ib);
        tris.push_back(ic);
      }
      ring.erase(ring.begin() + static_cast<std::ptrdiff_t>(i));
      if (i >= ring.size()) i = 0;
      guard = 0;
    } else {
      i = wrap(i + 1, n);
    }
  }
  if (ring.size() == 3) {
    const Pt2 a = verts[ring[0]];
    const Pt2 b = verts[ring[1]];
    const Pt2 c = verts[ring[2]];
    if (std::abs(cross(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y)) > 1e-9) {
      tris.push_back(ring[0]);
      tris.push_back(ring[1]);
      tris.push_back(ring[2]);
    }
  }
  return tris;
}

// ── extrudeMesh.ts ────────────────────────────────────────────────────────

struct Corner {
  double x = 0;
  double y = 0;
  double nx = 0;
  double ny = 0;
  double ix = 0;
  double iy = 0;
};

struct PreparedRing {
  std::vector<Corner> corners;
  std::vector<std::size_t> edgeStart;
  std::vector<std::size_t> edgeEnd;
  std::vector<Pt2> outline;
  std::vector<Pt2> inset;
  bool hole = false;
  double bevel = 0;
};

constexpr double kInsetShare = 0.3;

std::optional<PreparedRing> prepare_ring(std::span<const Pt2> pts, bool hole, double bevel, double smoothCos) {
  std::vector<Pt2> ring = dedupe_ring(pts);
  const std::size_t n = ring.size();
  if (n < 3) return std::nullopt;
  const double area = signed_area(ring);
  if ((area < 0) != hole) std::ranges::reverse(ring);
  const double ringArea = signed_area(ring);

  std::vector<Pt2> en(n);
  for (std::size_t i = 0; i < n; ++i) {
    const Pt2 a = ring[i];
    const Pt2 b = ring[wrap(i + 1, n)];
    const double dx = b.x - a.x;
    const double dy = b.y - a.y;
    const double len = or_one(hyp2(dx, dy));
    en[i] = {dy / len, -dx / len};
  }

  std::vector<Pt2> outline = ring;

  std::vector<double> clearance(n, kInf);
  if (bevel > 0) {
    std::vector<double> arc(n + 1);
    arc[0] = 0;
    for (std::size_t i = 0; i < n; ++i) {
      const Pt2 a = ring[i];
      const Pt2 b = ring[wrap(i + 1, n)];
      arc[i + 1] = arc[i] + hyp2(b.x - a.x, b.y - a.y);
    }
    const double total = arc[n];
    const double reach = bevel * 4;
    for (std::size_t i = 0; i < n; ++i) {
      const Pt2 a = ring[i];
      for (std::size_t j = i + 2; j < n; ++j) {
        const Pt2 b = ring[j];
        const double dx = b.x - a.x;
        const double dy = b.y - a.y;
        if (std::abs(dx) > reach || std::abs(dy) > reach) continue;
        const double d = hyp2(dx, dy);
        if (d >= reach) continue;
        const double along = jmin(arc[j] - arc[i], total - (arc[j] - arc[i]));
        if (along < d * 3) continue;
        if (d < clearance[i]) clearance[i] = d;
        if (d < clearance[j]) clearance[j] = d;
      }
    }
  }

  const auto rayLimit = [&](std::size_t i, double dirX, double dirY) {
    const Pt2 p = ring[i];
    double best = kInf;
    for (std::size_t j = 0; j < n; ++j) {
      if (j == i || j == prev_of(i, n)) continue;
      const Pt2 a = ring[j];
      const Pt2 b = ring[wrap(j + 1, n)];
      const double ex = b.x - a.x;
      const double ey = b.y - a.y;
      const double den = (dirX * ey) - (dirY * ex);
      if (std::abs(den) < 1e-9) continue;
      const double wx = a.x - p.x;
      const double wy = a.y - p.y;
      const double t = ((wx * ey) - (wy * ex)) / den;
      const double u = ((wx * dirY) - (wy * dirX)) / den;
      if (t > 1e-6 && u >= -1e-9 && u <= 1 + 1e-9 && t < best) best = t;
    }
    return best;
  };

  const auto insetAt = [&](double b) {
    std::vector<Pt2> out(n);
    for (std::size_t i = 0; i < n; ++i) {
      const Pt2 p = ring[i];
      const Pt2 nPrev = en[prev_of(i, n)];
      const Pt2 nNext = en[i];
      double bx = nPrev.x + nNext.x;
      double by = nPrev.y + nNext.y;
      const double bl = hyp2(bx, by);
      const double cap = clearance[i] * kInsetShare;
      if (bl < 1e-6) {
        const double d = jmin3(b, cap, rayLimit(i, -nNext.x, -nNext.y) * kInsetShare);
        out[i] = {p.x - (nNext.x * d), p.y - (nNext.y * d)};
      } else {
        bx /= bl;
        by /= bl;
        const double cosHalf = jmax(0.35, (bx * nNext.x) + (by * nNext.y));
        const double d = jmin3(b / cosHalf, cap, rayLimit(i, -bx, -by) * kInsetShare);
        out[i] = {p.x - (bx * d), p.y - (by * d)};
      }
    }
    // Swallowtails.
    for (int pass = 0; pass < 8; ++pass) {
      bool changed = false;
      for (std::size_t i = 0; i < n; ++i) {
        const std::size_t j = wrap(i + 1, n);
        const double ex = ring[j].x - ring[i].x;
        const double ey = ring[j].y - ring[i].y;
        const double fx = out[j].x - out[i].x;
        const double fy = out[j].y - out[i].y;
        if ((ex * fx) + (ey * fy) >= 0) continue;
        const double mx = (out[i].x + out[j].x) / 2;
        const double my = (out[i].y + out[j].y) / 2;
        out[i] = {mx, my};
        out[j] = {mx, my};
        changed = true;
      }
      if (!changed) break;
    }
    // Crossing inset edges: collapse the shorter side of each loop.
    for (int iter = 0; iter < 24; ++iter) {
      bool found = false;
      std::size_t hs = 0;
      std::size_t ht = 0;
      Pt2 P;
      for (std::size_t s = 0; s < n && !found; ++s) {
        const Pt2 a1 = out[s];
        const Pt2 a2 = out[wrap(s + 1, n)];
        const double ax = a2.x - a1.x;
        const double ay = a2.y - a1.y;
        if ((ax * ax) + (ay * ay) < 1e-12) continue;
        for (std::size_t t = s + 2; t < n; ++t) {
          if (s == 0 && t == n - 1) continue;
          const Pt2 b1 = out[t];
          const Pt2 b2 = out[wrap(t + 1, n)];
          const double bx = b2.x - b1.x;
          const double by = b2.y - b1.y;
          if ((bx * bx) + (by * by) < 1e-12) continue;
          const double den = (ax * by) - (ay * bx);
          if (std::abs(den) < 1e-12) continue;
          const double wx = b1.x - a1.x;
          const double wy = b1.y - a1.y;
          const double u = ((wx * by) - (wy * bx)) / den;
          const double v = ((wx * ay) - (wy * ax)) / den;
          if (u <= 1e-9 || u >= 1 - 1e-9 || v <= 1e-9 || v >= 1 - 1e-9) continue;
          hs = s;
          ht = t;
          P = {a1.x + (ax * u), a1.y + (ay * u)};
          found = true;
          break;
        }
      }
      if (!found) break;
      const std::size_t span = ht - hs;
      if (span <= n - span) {
        for (std::size_t k = hs + 1; k <= ht; ++k) out[k] = P;
      } else {
        for (std::size_t k = ht + 1; k < n; ++k) out[k] = P;
        for (std::size_t k = 0; k <= hs; ++k) out[k] = P;
      }
    }
    return out;
  };

  double effective = bevel;
  std::vector<Pt2> inset = insetAt(effective);
  for (int tries = 0; tries < 3 && effective > 0; ++tries) {
    const double a = signed_area(inset);
    const bool shrunk = std::abs(a) < std::abs(ringArea) * 0.05;
    const bool flipped = a != 0 && jm::sign(a) != jm::sign(ringArea);
    const bool grewWildly = !hole && std::abs(a) > std::abs(ringArea) * 1.05;
    if (!flipped && !shrunk && !grewWildly) break;
    effective /= 2;
    if (effective <= 0.25) {
      effective = 0;
      inset = outline;
    } else {
      inset = insetAt(effective);
    }
  }

  PreparedRing pr;
  pr.edgeStart.resize(n);
  pr.edgeEnd.resize(n);
  pr.corners.reserve(n * 2);
  for (std::size_t i = 0; i < n; ++i) {
    const Pt2 p = ring[i];
    const Pt2 nPrev = en[prev_of(i, n)];
    const Pt2 nNext = en[i];
    double bx = nPrev.x + nNext.x;
    double by = nPrev.y + nNext.y;
    const double bl = hyp2(bx, by);
    if (bl >= 1e-6) {
      bx /= bl;
      by /= bl;
    }
    const double ix = inset[i].x;
    const double iy = inset[i].y;
    const double cosA = (nPrev.x * nNext.x) + (nPrev.y * nNext.y);
    if (cosA >= smoothCos && bl >= 1e-6) {
      pr.corners.push_back({p.x, p.y, bx, by, ix, iy});
      pr.edgeEnd[prev_of(i, n)] = pr.corners.size() - 1;
      pr.edgeStart[i] = pr.corners.size() - 1;
    } else {
      pr.corners.push_back({p.x, p.y, nPrev.x, nPrev.y, ix, iy});
      pr.edgeEnd[prev_of(i, n)] = pr.corners.size() - 1;
      pr.corners.push_back({p.x, p.y, nNext.x, nNext.y, ix, iy});
      pr.edgeStart[i] = pr.corners.size() - 1;
    }
  }
  pr.outline = std::move(outline);
  pr.inset = std::move(inset);
  pr.hole = hole;
  return pr;
}

struct Profile {
  double u = 0;
  double v = 0;
  double du = 0;
  double dv = 0;
};

Profile profile_at(BevelProfile style, double t) {
  if (style == BevelProfile::convex) {
    const double th = t * kPi / 2;
    return {1 - jm::sin(th), 1 - jm::cos(th), -jm::cos(th), jm::sin(th)};
  }
  if (style == BevelProfile::concave) {
    const double th = t * kPi / 2;
    return {jm::cos(th), jm::sin(th), -jm::sin(th), jm::cos(th)};
  }
  return {1 - t, t, -1, 1};
}

class MeshBuilder {
 public:
  explicit MeshBuilder(Box uv) : uv_(uv) {}

  std::uint32_t vertex(double x, double y, double z, double nx, double ny, double nz) {
    const double nl = or_one(hyp3(nx, ny, nz));
    verts_.insert(verts_.end(), {x, y, z, nx / nl, ny / nl, nz / nl, (x - uv_.x) / uv_.width, (y - uv_.y) / uv_.height});
    return count_++;
  }

  void tri(MeshRole role, std::uint32_t a, std::uint32_t b, std::uint32_t c) {
    const auto& v = verts_;
    const std::size_t A = a * kMeshVertexFloats;
    const std::size_t B = b * kMeshVertexFloats;
    const std::size_t C = c * kMeshVertexFloats;
    const double e1x = v[B] - v[A];
    const double e1y = v[B + 1] - v[A + 1];
    const double e1z = v[B + 2] - v[A + 2];
    const double e2x = v[C] - v[A];
    const double e2y = v[C + 1] - v[A + 1];
    const double e2z = v[C + 2] - v[A + 2];
    const double gx = (e1y * e2z) - (e1z * e2y);
    const double gy = (e1z * e2x) - (e1x * e2z);
    const double gz = (e1x * e2y) - (e1y * e2x);
    if (gx == 0 && gy == 0 && gz == 0) return;
    const double nx = v[A + 3] + v[B + 3] + v[C + 3];
    const double ny = v[A + 4] + v[B + 4] + v[C + 4];
    const double nz = v[A + 5] + v[B + 5] + v[C + 5];
    auto& out = byRole_[static_cast<std::size_t>(role)];
    if ((gx * nx) + (gy * ny) + (gz * nz) >= 0) {
      out.insert(out.end(), {a, b, c});
    } else {
      out.insert(out.end(), {a, c, b});
    }
  }

  void quad(MeshRole role, std::uint32_t a, std::uint32_t b, std::uint32_t c, std::uint32_t d) {
    tri(role, a, b, c);
    tri(role, a, c, d);
  }

  [[nodiscard]] std::uint32_t count() const noexcept { return count_; }

  ExtrudedMesh finish(double bevel) {
    ExtrudedMesh m;
    m.vertices.resize(verts_.size());
    for (std::size_t i = 0; i < verts_.size(); ++i) m.vertices[i] = static_cast<float>(verts_[i]);
    m.vertexCount = count_;
    m.index32 = count_ > 65535;
    for (const MeshRole role : {MeshRole::back, MeshRole::side, MeshRole::bevel, MeshRole::front}) {
      const auto& list = byRole_[static_cast<std::size_t>(role)];
      if (list.empty()) continue;
      m.ranges.push_back({role, static_cast<std::uint32_t>(m.indices.size()), static_cast<std::uint32_t>(list.size())});
      m.indices.insert(m.indices.end(), list.begin(), list.end());
    }
    m.bevel = bevel;
    return m;
  }

 private:
  Box uv_;
  std::vector<double> verts_;
  std::uint32_t count_ = 0;
  std::array<std::vector<std::uint32_t>, 4> byRole_;
};

Box bounds_of(std::span<const Ring> rings) {
  double x0 = kInf;
  double y0 = kInf;
  double x1 = -kInf;
  double y1 = -kInf;
  for (const Ring& r : rings) {
    for (const Pt2& p : r.points) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
  }
  if (!std::isfinite(x0)) return {0, 0, 1, 1};
  return {x0, y0, jmax(1e-6, x1 - x0), jmax(1e-6, y1 - y0)};
}

bool point_in_ring_eo(Pt2 p, std::span<const Pt2> ring) noexcept { return point_in_ring(p, ring); }

}  // namespace

// ── polygonTriangulate.ts ─────────────────────────────────────────────────

double signed_area(std::span<const Pt2> pts) noexcept {
  double a = 0;
  const std::size_t n = pts.size();
  for (std::size_t i = 0, j = n - 1; i < n; j = i++) a += (pts[j].x * pts[i].y) - (pts[i].x * pts[j].y);
  return a / 2;
}

std::vector<Pt2> dedupe_ring(std::span<const Pt2> pts, double eps) {
  std::vector<Pt2> out;
  out.reserve(pts.size());
  for (const Pt2& p : pts) {
    if (!out.empty()) {
      const Pt2& last = out.back();
      if (std::abs(last.x - p.x) < eps && std::abs(last.y - p.y) < eps) continue;
    }
    out.push_back(p);
  }
  if (out.size() > 1) {
    const Pt2 f = out.front();
    const Pt2 l = out.back();
    if (std::abs(f.x - l.x) < eps && std::abs(f.y - l.y) < eps) out.pop_back();
  }
  return out;
}

Triangulation triangulate_rings(std::span<const Pt2> outer, std::span<const std::vector<Pt2>> holes) {
  Triangulation res;
  std::vector<Pt2>& verts = res.vertices;
  std::vector<Pt2> outerPts = dedupe_ring(outer);
  if (outerPts.size() < 3) return {};
  if (signed_area(outerPts) < 0) std::ranges::reverse(outerPts);
  std::vector<std::uint32_t> outerIdx;
  for (const Pt2& p : outerPts) {
    outerIdx.push_back(static_cast<std::uint32_t>(verts.size()));
    verts.push_back(p);
  }
  std::vector<std::vector<std::uint32_t>> holeIdx;
  for (const auto& h : holes) {
    std::vector<Pt2> pts = dedupe_ring(h);
    if (pts.size() < 3) continue;
    if (signed_area(pts) > 0) std::ranges::reverse(pts);
    std::vector<std::uint32_t> idx;
    for (const Pt2& p : pts) {
      idx.push_back(static_cast<std::uint32_t>(verts.size()));
      verts.push_back(p);
    }
    holeIdx.push_back(std::move(idx));
  }
  const auto maxX = [&](const std::vector<std::uint32_t>& h) {
    double m = -kInf;
    for (const std::uint32_t i : h) m = jmax(m, verts[i].x);
    return m;
  };
  // Array.prototype.sort is stable; comparator (a, b) => bx - ax.
  std::ranges::stable_sort(holeIdx, [&](const auto& a, const auto& b) { return maxX(b) - maxX(a) < 0; });

  std::vector<std::uint32_t> ring = std::move(outerIdx);
  for (const auto& h : holeIdx) ring = bridge_hole(verts, ring, h);
  res.triangles = ear_clip_ring(verts, std::move(ring));
  return res;
}

bool point_in_ring(Pt2 p, std::span<const Pt2> ring) noexcept {
  bool inside = false;
  const std::size_t n = ring.size();
  for (std::size_t i = 0, j = n - 1; i < n; j = i++) {
    const Pt2 a = ring[i];
    const Pt2 b = ring[j];
    if ((a.y > p.y) != (b.y > p.y) && p.x < (((b.x - a.x) * (p.y - a.y)) / (b.y - a.y)) + a.x) inside = !inside;
  }
  return inside;
}

std::vector<RingGroup> group_rings(std::span<const Ring> rings) {
  struct Outer {
    const Ring* ring;
    std::vector<std::vector<Pt2>> holes;
    double area;
  };
  std::vector<Outer> outers;
  for (const Ring& r : rings) {
    if (!r.hole && r.points.size() >= 3) outers.push_back({&r, {}, std::abs(signed_area(r.points))});
  }
  for (const Ring& h : rings) {
    if (!h.hole || h.points.size() < 3) continue;
    const Pt2 p = h.points[0];
    Outer* best = nullptr;
    for (Outer& o : outers) {
      if (point_in_ring(p, o.ring->points) && (best == nullptr || o.area < best->area)) best = &o;
    }
    if (best != nullptr) best->holes.push_back(h.points);
  }
  std::vector<RingGroup> out;
  out.reserve(outers.size());
  for (Outer& o : outers) out.push_back({o.ring->points, std::move(o.holes)});
  return out;
}

// ── extrudeMesh.ts ────────────────────────────────────────────────────────

double clamp_mesh_bevel(std::span<const Ring> rings, double depth, double bevel) {
  if (!(bevel > 0)) return 0;
  double thinnest = kInf;
  for (const Ring& r : rings) {
    const std::vector<Pt2> pts = dedupe_ring(r.points);
    if (pts.size() < 3) continue;
    double per = 0;
    for (std::size_t i = 0; i < pts.size(); ++i) {
      const Pt2 a = pts[i];
      const Pt2 b = pts[wrap(i + 1, pts.size())];
      per += hyp2(b.x - a.x, b.y - a.y);
    }
    if (per <= 0) continue;
    thinnest = jmin(thinnest, std::abs(signed_area(pts)) / per);
  }
  if (!std::isfinite(thinnest)) return 0;
  return jmax(0, jmin3(bevel, depth / 2, thinnest * 0.8));
}

std::optional<ExtrudedMesh> extrude_outline(std::span<const Ring> rings, const ExtrudeOptions& opts) {
  const double depth = jmax(0, opts.depth);
  if (depth <= 0) return std::nullopt;
  const double bevel = clamp_mesh_bevel(rings, depth, opts.bevel);
  const BevelProfile style = opts.bevelStyle;
  const std::uint32_t segs =
      style == BevelProfile::angular
          ? 1U
          : static_cast<std::uint32_t>(jmax(1, jmin(16, std::floor(opts.bevelSegments.value_or(4)))));
  const double smoothCos = jm::cos(opts.smoothAngleDeg * (kPi / 180));
  const Box uvBox = opts.uvBox ? *opts.uvBox : bounds_of(rings);
  const bool frontBevel = opts.frontBevel;
  const double holeScale = jmax(0, jmin(1, opts.holeBevelScale));

  std::vector<PreparedRing> prepared;
  for (const Ring& r : rings) {
    const double rb = r.hole ? bevel * holeScale : bevel;
    auto p = prepare_ring(r.points, r.hole, rb, smoothCos);
    if (p) {
      p->bevel = rb;
      prepared.push_back(std::move(*p));
    }
  }
  if (prepared.empty()) return std::nullopt;

  MeshBuilder mb(uvBox);

  // ── Walls ──
  for (const PreparedRing& ring : prepared) {
    const double zWall0 = frontBevel ? ring.bevel : 0;
    const double zWall1 = depth - ring.bevel;
    if (zWall1 - zWall0 > 1e-6) {
      const std::uint32_t base0 = mb.count();
      for (const Corner& c : ring.corners) mb.vertex(c.x, c.y, zWall0, c.nx, c.ny, 0);
      const std::uint32_t base1 = mb.count();
      for (const Corner& c : ring.corners) mb.vertex(c.x, c.y, zWall1, c.nx, c.ny, 0);
      for (std::size_t i = 0; i < ring.edgeStart.size(); ++i) {
        const auto s = static_cast<std::uint32_t>(ring.edgeStart[i]);
        const auto e = static_cast<std::uint32_t>(ring.edgeEnd[i]);
        mb.quad(MeshRole::side, base0 + s, base0 + e, base1 + e, base1 + s);
      }
    }
  }

  // ── Bevels ──
  if (bevel > 0) {
    const std::vector<bool> fronts = frontBevel ? std::vector<bool>{true, false} : std::vector<bool>{false};
    for (const bool front : fronts) {
      for (const PreparedRing& ring : prepared) {
        const double rbev = ring.bevel;
        if (!(rbev > 0)) continue;
        std::vector<std::uint32_t> rows;
        for (std::uint32_t k = 0; k <= segs; ++k) {
          const double t = static_cast<double>(k) / static_cast<double>(segs);
          const Profile pr = profile_at(style, t);
          rows.push_back(mb.count());
          for (const Corner& c : ring.corners) {
            const double x = c.x + ((c.ix - c.x) * pr.u);
            const double y = c.y + ((c.iy - c.y) * pr.u);
            const double z = front ? rbev * pr.v : depth - (rbev * pr.v);
            const double nz = front ? pr.du : -pr.du;
            mb.vertex(x, y, z, c.nx * pr.dv, c.ny * pr.dv, nz);
          }
        }
        for (std::uint32_t k = 0; k < segs; ++k) {
          const std::uint32_t r0 = rows[k];
          const std::uint32_t r1 = rows[k + 1];
          for (std::size_t i = 0; i < ring.edgeStart.size(); ++i) {
            const auto s = static_cast<std::uint32_t>(ring.edgeStart[i]);
            const auto e = static_cast<std::uint32_t>(ring.edgeEnd[i]);
            mb.quad(MeshRole::bevel, r0 + s, r0 + e, r1 + e, r1 + s);
          }
        }
      }
    }
  }

  // ── Caps ──
  const auto capGroups = [&](bool bevelled) {
    std::vector<Ring> rs;
    rs.reserve(prepared.size());
    for (const PreparedRing& r : prepared) rs.push_back({bevelled && r.bevel > 0 ? r.inset : r.outline, r.hole});
    return group_rings(rs);
  };
  const auto emitCap = [&](MeshRole role) {
    const double z = role == MeshRole::front ? 0 : depth;
    const double nz = role == MeshRole::front ? -1 : 1;
    for (const RingGroup& g : capGroups(role == MeshRole::back || frontBevel)) {
      const Triangulation tr = triangulate_rings(g.outer, g.holes);
      if (tr.triangles.empty()) continue;
      const std::uint32_t base = mb.count();
      for (const Pt2& p : tr.vertices) mb.vertex(p.x, p.y, z, 0, 0, nz);
      for (std::size_t i = 0; i + 2 < tr.triangles.size(); i += 3) {
        mb.tri(role, base + tr.triangles[i], base + tr.triangles[i + 1], base + tr.triangles[i + 2]);
      }
    }
  };
  if (opts.backCap) emitCap(MeshRole::back);
  if (opts.frontCap) emitCap(MeshRole::front);

  if (mb.count() == 0) return std::nullopt;
  return mb.finish(frontBevel ? bevel : 0);
}

std::vector<Ring> rect_outline(double width, double height, std::array<double, 4> radii, int segmentsPer90) {
  const double hw = width / 2;
  const double hh = height / 2;
  const double maxR = jmin(hw, hh);
  std::array<double, 4> rr{};
  for (std::size_t i = 0; i < 4; ++i) rr[i] = jmax(0, jmin(radii[i], maxR));
  struct C {
    double cx;
    double cy;
    double a0;
    double r;
  };
  const std::array<C, 4> corners{{
      {-hw + rr[0], -hh + rr[0], kPi, rr[0]},
      {hw - rr[1], -hh + rr[1], -kPi / 2, rr[1]},
      {hw - rr[2], hh - rr[2], 0, rr[2]},
      {-hw + rr[3], hh - rr[3], kPi / 2, rr[3]},
  }};
  std::vector<Pt2> pts;
  for (const C& c : corners) {
    if (c.r <= 0) {
      pts.push_back({c.cx, c.cy});
      continue;
    }
    const auto n = static_cast<int>(jmax(2, jm::round(segmentsPer90 * jmin(1, (c.r / 6) + 0.25))));
    for (int i = 0; i <= n; ++i) {
      const double a = c.a0 + ((static_cast<double>(i) / n) * (kPi / 2));
      pts.push_back({c.cx + (jm::cos(a) * c.r), c.cy + (jm::sin(a) * c.r)});
    }
  }
  std::vector<Ring> out;
  out.push_back({std::move(pts), false});
  return out;
}

std::vector<Ring> ellipse_outline(double width, double height, std::optional<int> segments) {
  const int n = segments ? *segments : static_cast<int>(jmax(24, jmin(128, jm::round(jmax(width, height) / 3))));
  std::vector<Pt2> pts;
  pts.reserve(static_cast<std::size_t>(n));
  for (int i = 0; i < n; ++i) {
    const double a = (static_cast<double>(i) / n) * kPi * 2;
    pts.push_back({jm::cos(a) * width / 2, jm::sin(a) * height / 2});
  }
  std::vector<Ring> out;
  out.push_back({std::move(pts), false});
  return out;
}

std::vector<Ring> bezier_runs_to_rings(std::span<const BezRun> runs, double tolerance) {
  std::vector<std::vector<Pt2>> flat;
  for (const BezRun& run : runs) {
    if (run.open) continue;
    const std::size_t n = run.points.size();
    if (n < 3) continue;
    std::vector<Pt2> out;
    for (std::size_t i = 0; i < n; ++i) {
      const BezPt& A = run.points[i];
      const BezPt& B = run.points[wrap(i + 1, n)];
      const double c0x = A.outX;
      const double c0y = A.outY;
      const double c1x = B.inX;
      const double c1y = B.inY;
      const bool straight = c0x == A.x && c0y == A.y && c1x == B.x && c1y == B.y;
      if (straight) {
        out.push_back({A.x, A.y});
        continue;
      }
      const double len = hyp2(c0x - A.x, c0y - A.y) + hyp2(c1x - c0x, c1y - c0y) + hyp2(B.x - c1x, B.y - c1y);
      const auto segs = static_cast<int>(jmax(2, jmin(64, std::ceil(std::sqrt(len / tolerance) * 1.2))));
      for (int k = 0; k < segs; ++k) {
        const double t = static_cast<double>(k) / segs;
        const double mt = 1 - t;
        const double x = (mt * mt * mt * A.x) + (3 * mt * mt * t * c0x) + (3 * mt * t * t * c1x) + (t * t * t * B.x);
        const double y = (mt * mt * mt * A.y) + (3 * mt * mt * t * c0y) + (3 * mt * t * t * c1y) + (t * t * t * B.y);
        out.push_back({x, y});
      }
    }
    std::vector<Pt2> d = dedupe_ring(out);
    if (d.size() >= 3 && std::abs(signed_area(d)) > 1e-3) flat.push_back(std::move(d));
  }
  std::vector<Ring> rings;
  rings.reserve(flat.size());
  for (std::size_t r = 0; r < flat.size(); ++r) {
    const Pt2 p = flat[r][0];
    int inside = 0;
    for (std::size_t o = 0; o < flat.size(); ++o) {
      if (o == r) continue;
      if (point_in_ring_eo(p, flat[o])) ++inside;
    }
    rings.push_back({flat[r], inside % 2 == 1});
  }
  return rings;
}

}  // namespace premation::scene::mesh
