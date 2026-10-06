#include "alpha_mesh.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <map>
#include <utility>
#include <variant>

#include "alpha_contours.hpp"
#include "jsmath.hpp"

namespace premation::scene::rig {

namespace {

namespace mjs = motion::js;
using mesh::Pt2;

constexpr std::size_t kMaxVertices = 65535;  // MAX_VERTICES
constexpr std::size_t kMaxPoints = 2600;     // MAX_POINTS
/// The share of a region its kept triangles must cover (a triangulation that
/// falls short would leave part of the picture undrawn).
constexpr double kMinRegionCoverage = 0.97;
constexpr double kMaskThreshold = 128;       // MASK_THRESHOLD
constexpr double kMiterLimit = 3;            // MITER_LIMIT
constexpr double kEdgeProbeInset = 0.05;     // EDGE_PROBE_INSET
constexpr double kInf = std::numeric_limits<double>::infinity();

double hyp(double a, double b) {
  const std::array<double, 2> v = {a, b};
  return mjs::hypot(v);
}

/// Douglas–Peucker on an OPEN chain (explicit stack; ties keep the lowest index).
std::vector<Pt2> simplify_chain(const std::vector<Pt2>& pts, double tol) {
  const std::size_t n = pts.size();
  if (n <= 2) return pts;
  std::vector<std::uint8_t> keep(n, 0);
  keep[0] = 1;
  keep[n - 1] = 1;
  std::vector<std::pair<std::size_t, std::size_t>> stack{{0, n - 1}};
  while (!stack.empty()) {
    const auto [lo, hi] = stack.back();
    stack.pop_back();
    if (hi - lo < 2) continue;
    const Pt2 a = pts[lo];
    const Pt2 b = pts[hi];
    const double dx = b.x - a.x;
    const double dy = b.y - a.y;
    const double len2 = (dx * dx) + (dy * dy);
    std::ptrdiff_t worst = -1;
    double worstD = tol;
    for (std::size_t i = lo + 1; i < hi; ++i) {
      const Pt2 p = pts[i];
      double d = 0;
      if (len2 < 1e-12) {
        d = hyp(p.x - a.x, p.y - a.y);
      } else {
        double t = (((p.x - a.x) * dx) + ((p.y - a.y) * dy)) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        d = hyp(p.x - (a.x + (dx * t)), p.y - (a.y + (dy * t)));
      }
      if (d > worstD) {
        worstD = d;
        worst = static_cast<std::ptrdiff_t>(i);
      }
    }
    if (worst < 0) continue;
    const auto w = static_cast<std::size_t>(worst);
    keep[w] = 1;
    stack.emplace_back(lo, w);
    stack.emplace_back(w, hi);
  }
  std::vector<Pt2> out;
  for (std::size_t i = 0; i < n; ++i) {
    if (keep[i] != 0) out.push_back(pts[i]);
  }
  return out;
}

/// Douglas–Peucker on a CLOSED ring, cut at vertex 0 and the vertex farthest from it.
std::vector<Pt2> simplify_ring(const std::vector<Pt2>& ring, double tol) {
  const std::size_t n = ring.size();
  if (n < 4 || tol <= 0) return ring;
  const Pt2 a = ring[0];
  std::size_t far = 1;
  double farD = -1;
  for (std::size_t i = 1; i < n; ++i) {
    const double d = hyp(ring[i].x - a.x, ring[i].y - a.y);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const std::vector<Pt2> first = simplify_chain(std::vector<Pt2>(ring.begin(), ring.begin() + static_cast<std::ptrdiff_t>(far + 1)), tol);
  std::vector<Pt2> tail(ring.begin() + static_cast<std::ptrdiff_t>(far), ring.end());
  tail.push_back(ring[0]);
  const std::vector<Pt2> second = simplify_chain(tail, tol);
  std::vector<Pt2> out(first.begin(), first.end() - 1);
  out.insert(out.end(), second.begin(), second.end() - 1);
  return out;
}

/// Drop consecutive duplicates (and a closing repeat of the first).
std::vector<Pt2> dedupe(const std::vector<Pt2>& ring, double eps) {
  std::vector<Pt2> out;
  for (const Pt2 p : ring) {
    if (!out.empty() && std::abs(out.back().x - p.x) < eps && std::abs(out.back().y - p.y) < eps) continue;
    out.push_back(p);
  }
  while (out.size() > 1) {
    const Pt2 f = out.front();
    const Pt2 l = out.back();
    if (std::abs(f.x - l.x) < eps && std::abs(f.y - l.y) < eps) {
      out.pop_back();
    } else {
      break;
    }
  }
  return out;
}

std::vector<Pt2> orient_positive(std::vector<Pt2> ring) {
  if (mesh::signed_area(ring) < 0) std::ranges::reverse(ring);
  return ring;
}

/// Miter offset of a positively oriented ring by `d` along its outward normals.
std::vector<Pt2> offset_ring(const std::vector<Pt2>& ring, double d) {
  const std::size_t n = ring.size();
  if (n < 3 || d == 0) return ring;
  std::vector<double> nx(n, 0);
  std::vector<double> ny(n, 0);
  for (std::size_t i = 0; i < n; ++i) {
    const Pt2 p = ring[i];
    const Pt2 q = ring[(i + 1) % n];
    const double ex = q.x - p.x;
    const double ey = q.y - p.y;
    const double len = hyp(ex, ey);
    if (len < 1e-9) continue;
    nx[i] = ey / len;
    ny[i] = -ex / len;
  }
  std::vector<Pt2> out;
  out.reserve(n);
  for (std::size_t i = 0; i < n; ++i) {
    const std::size_t prev = (i + n - 1) % n;
    double bx = nx[prev] + nx[i];
    double by = ny[prev] + ny[i];
    const double len = hyp(bx, by);
    if (len < 1e-9) {
      bx = nx[i];
      by = ny[i];
    } else {
      bx /= len;
      by /= len;
    }
    const double cos = (bx * nx[i]) + (by * ny[i]);
    const double scale = std::min(kMiterLimit, 1 / std::max(0.25, cos));
    out.push_back({ring[i].x + (bx * d * scale), ring[i].y + (by * d * scale)});
  }
  return out;
}

std::vector<Pt2> resample_ring(const std::vector<Pt2>& ring, double spacing) {
  std::vector<Pt2> out;
  const std::size_t n = ring.size();
  for (std::size_t i = 0; i < n; ++i) {
    const Pt2 a = ring[i];
    const Pt2 b = ring[(i + 1) % n];
    out.push_back(a);
    const double len = hyp(b.x - a.x, b.y - a.y);
    const double steps = std::floor(len / spacing);
    for (double k = 1; k <= steps; ++k) {
      const double t = k / (steps + 1);
      out.push_back({a.x + ((b.x - a.x) * t), a.y + ((b.y - a.y) * t)});
    }
  }
  return out;
}

double dist_sq_to_segment(double px, double py, double ax, double ay, double bx, double by) {
  const double dx = bx - ax;
  const double dy = by - ay;
  const double len2 = (dx * dx) + (dy * dy);
  double t = len2 < 1e-12 ? 0 : (((px - ax) * dx) + ((py - ay) * dy)) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const double qx = ax + (dx * t);
  const double qy = ay + (dy * t);
  return ((px - qx) * (px - qx)) + ((py - qy) * (py - qy));
}

Pt2 edge_probe(Pt2 a, Pt2 b, Pt2 centroid) {
  const double mx = (a.x + b.x) / 2;
  const double my = (a.y + b.y) / 2;
  return {mx + ((centroid.x - mx) * kEdgeProbeInset), my + ((centroid.y - my) * kEdgeProbeInset)};
}

bool inside_region(Pt2 p, const AlphaRegion& region) {
  if (!mesh::point_in_ring(p, region.outer)) return false;
  return std::ranges::none_of(region.holes, [p](const std::vector<Pt2>& h) { return mesh::point_in_ring(p, h); });
}

double cross2(double ax, double ay, double bx, double by, double cx, double cy) { return ((bx - ax) * (cy - ay)) - ((cx - ax) * (by - ay)); }

/// Bowyer–Watson; positively oriented index triples, or nullopt when insertion fails.
std::optional<std::vector<std::int32_t>> delaunay(const std::vector<double>& px, const std::vector<double>& py, std::size_t n) {
  if (n < 3) return std::nullopt;
  double minX = kInf, minY = kInf, maxX = -kInf, maxY = -kInf;
  for (std::size_t i = 0; i < n; ++i) {
    if (px[i] < minX) minX = px[i];
    if (px[i] > maxX) maxX = px[i];
    if (py[i] < minY) minY = py[i];
    if (py[i] > maxY) maxY = py[i];
  }
  const double span = std::max({maxX - minX, maxY - minY, 1e-6});
  const double cx = (minX + maxX) / 2;
  const double cy = (minY + maxY) / 2;
  const double R = span * 20;
  std::vector<double> X(px.begin(), px.begin() + static_cast<std::ptrdiff_t>(n));
  std::vector<double> Y(py.begin(), py.begin() + static_cast<std::ptrdiff_t>(n));
  X.push_back(cx - R);
  Y.push_back(cy - R);
  X.push_back(cx + R);
  Y.push_back(cy - R);
  X.push_back(cx);
  Y.push_back(cy + R);
  const auto N = static_cast<std::int64_t>(n);
  std::vector<std::int64_t> tri = {N, N + 1, N + 2};
  std::vector<bool> dead = {false};
  const auto at = [](const std::vector<double>& v, std::int64_t i) { return v[static_cast<std::size_t>(i)]; };
  if (cross2(X[n], Y[n], X[n + 1], Y[n + 1], X[n + 2], Y[n + 2]) < 0) {
    tri[1] = N + 2;
    tri[2] = N + 1;
  }
  const double eps = span * span * span * span * 1e-12;
  const auto in_circle = [&](std::int64_t a, std::int64_t b, std::int64_t c, std::int64_t d) {
    const double adx = at(X, a) - at(X, d);
    const double ady = at(Y, a) - at(Y, d);
    const double bdx = at(X, b) - at(X, d);
    const double bdy = at(Y, b) - at(Y, d);
    const double cdx = at(X, c) - at(X, d);
    const double cdy = at(Y, c) - at(Y, d);
    const double det = (((adx * adx) + (ady * ady)) * ((bdx * cdy) - (cdx * bdy))) -
                       (((bdx * bdx) + (bdy * bdy)) * ((adx * cdy) - (cdx * ady))) +
                       (((cdx * cdx) + (cdy * cdy)) * ((adx * bdy) - (bdx * ady)));
    return det > eps;
  };
  std::vector<std::size_t> badTris;
  std::vector<std::int64_t> edges;
  for (std::int64_t p = 0; p < N; ++p) {
    badTris.clear();
    for (std::size_t t = 0; t < dead.size(); ++t) {
      if (dead[t]) continue;
      if (in_circle(tri[t * 3], tri[(t * 3) + 1], tri[(t * 3) + 2], p)) badTris.push_back(t);
    }
    if (badTris.empty()) continue;  // exact duplicate / cocircular — skip it
    edges.clear();
    for (const std::size_t t : badTris) {
      for (std::size_t k = 0; k < 3; ++k) {
        const std::int64_t a = tri[(t * 3) + k];
        const std::int64_t b = tri[(t * 3) + ((k + 1) % 3)];
        std::ptrdiff_t dup = -1;
        for (std::size_t e = 0; e < edges.size(); e += 2) {
          if (edges[e] == b && edges[e + 1] == a) {
            dup = static_cast<std::ptrdiff_t>(e);
            break;
          }
        }
        if (dup >= 0) {
          edges[static_cast<std::size_t>(dup)] = -1;
          edges[static_cast<std::size_t>(dup) + 1] = -1;
        } else {
          edges.push_back(a);
          edges.push_back(b);
        }
      }
    }
    for (const std::size_t t : badTris) dead[t] = true;
    int added = 0;
    for (std::size_t e = 0; e < edges.size(); e += 2) {
      const std::int64_t a = edges[e];
      const std::int64_t b = edges[e + 1];
      if (a < 0) continue;
      if (std::abs(cross2(at(X, a), at(Y, a), at(X, b), at(Y, b), at(X, p), at(Y, p))) < 1e-12) continue;
      tri.push_back(a);
      tri.push_back(b);
      tri.push_back(p);
      dead.push_back(false);
      ++added;
    }
    if (added == 0) return std::nullopt;  // cavity collapsed — refuse rather than corrupt
  }
  std::vector<std::int32_t> out;
  for (std::size_t t = 0; t < dead.size(); ++t) {
    if (dead[t]) continue;
    const std::int64_t a = tri[t * 3];
    const std::int64_t b = tri[(t * 3) + 1];
    const std::int64_t c = tri[(t * 3) + 2];
    if (a >= N || b >= N || c >= N) continue;  // touches the super-triangle
    const auto ia = static_cast<std::int32_t>(a);
    const auto ib = static_cast<std::int32_t>(b);
    const auto ic = static_cast<std::int32_t>(c);
    if (cross2(at(X, a), at(Y, a), at(X, b), at(Y, b), at(X, c), at(Y, c)) > 0) {
      out.insert(out.end(), {ia, ib, ic});
    } else {
      out.insert(out.end(), {ia, ic, ib});
    }
  }
  if (out.size() < 3) return std::nullopt;
  return out;
}

struct Triangulated {
  std::vector<Pt2> pts;
  std::vector<std::int32_t> tris;
  /// The area the kept triangles cover (layer px²).
  double keptArea = 0;
};
struct OverBudget {};

/// The region's own area: its outline less its holes.
double region_area(const AlphaRegion& region) {
  double a = std::abs(mesh::signed_area(region.outer));
  for (const auto& h : region.holes) a -= std::abs(mesh::signed_area(h));
  return std::max(0.0, a);
}

/// triangulateRegion: boundary + hex lattice, Delaunay, clipped back to the region.
/// The boundary is sampled every `edge` px (≤ `spacing`, the lattice's): an
/// unconstrained Delaunay keeps the outline's own edges only where it is sampled
/// finely against the region's narrowest gaps. Sampled at the lattice spacing, the
/// triangles across a notch (the gap between an arm and the body) were rejected
/// and nothing took their place — a straight-edged piece of the picture went
/// undrawn. `keptArea` lets the caller see a region that still came out short.
std::variant<std::monostate, OverBudget, Triangulated> triangulate_region(const AlphaRegion& region, double spacing, double edge) {
  std::vector<const std::vector<Pt2>*> rings{&region.outer};
  for (const auto& h : region.holes) rings.push_back(&h);
  std::vector<Pt2> pts;
  for (const auto* r : rings) {
    const std::vector<Pt2> rs = resample_ring(*r, edge);
    pts.insert(pts.end(), rs.begin(), rs.end());
  }
  if (pts.size() < 3) return std::monostate{};
  double minX = kInf, minY = kInf, maxX = -kInf, maxY = -kInf;
  for (const Pt2 p : region.outer) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const double rowH = spacing * 0.866;
  const double clearance = spacing * 0.5;
  const double clearance2 = clearance * clearance;
  std::vector<double> segs;
  for (const auto* r : rings) {
    for (std::size_t i = 0; i < r->size(); ++i) {
      const Pt2 a = (*r)[i];
      const Pt2 b = (*r)[(i + 1) % r->size()];
      segs.insert(segs.end(), {a.x, a.y, b.x, b.y});
    }
  }
  int row = 0;
  for (double y = minY + (rowH * 0.5); y < maxY; y += rowH, ++row) {
    const double xOff = row % 2 == 0 ? 0 : spacing * 0.5;
    for (double x = minX + xOff + (spacing * 0.5); x < maxX; x += spacing) {
      const Pt2 p{x, y};
      if (!inside_region(p, region)) continue;
      bool ok = true;
      for (std::size_t s = 0; s < segs.size(); s += 4) {
        if (dist_sq_to_segment(x, y, segs[s], segs[s + 1], segs[s + 2], segs[s + 3]) < clearance2) {
          ok = false;
          break;
        }
      }
      if (ok) pts.push_back(p);
    }
  }
  const std::size_t n = pts.size();
  if (n < 3) return std::monostate{};
  if (n > kMaxPoints) return OverBudget{};
  std::vector<double> px(n);
  std::vector<double> py(n);
  for (std::size_t i = 0; i < n; ++i) {
    px[i] = pts[i].x;
    py[i] = pts[i].y;
  }
  const auto idx = delaunay(px, py, n);
  if (!idx) return std::monostate{};
  Triangulated out;
  const double minTriArea = spacing * spacing * 1e-3;
  for (std::size_t t = 0; t + 2 < idx->size(); t += 3) {
    const Pt2 a = pts[static_cast<std::size_t>((*idx)[t])];
    const Pt2 b = pts[static_cast<std::size_t>((*idx)[t + 1])];
    const Pt2 c = pts[static_cast<std::size_t>((*idx)[t + 2])];
    const double area = std::abs(cross2(a.x, a.y, b.x, b.y, c.x, c.y)) / 2;
    if (area < minTriArea) continue;
    const Pt2 centroid{(a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3};
    if (!inside_region(centroid, region)) continue;
    if (!inside_region(edge_probe(a, b, centroid), region)) continue;
    if (!inside_region(edge_probe(b, c, centroid), region)) continue;
    if (!inside_region(edge_probe(c, a, centroid), region)) continue;
    out.tris.insert(out.tris.end(), {(*idx)[t], (*idx)[t + 1], (*idx)[t + 2]});
    out.keptArea += area;
  }
  if (out.tris.size() < 3) return std::monostate{};
  out.pts = std::move(pts);
  return out;
}

}  // namespace

CoverageMask coverage_mask_from_image_data(std::span<const std::uint8_t> data, int width, int height, double maxSamplesIn,
                                           double alphaThresholdIn) {
  const int maxSamples = static_cast<int>(std::max(2.0, std::min(64.0, std::floor(maxSamplesIn))));
  const int threshold = static_cast<int>(std::max(1.0, std::min(255.0, std::floor(alphaThresholdIn))));
  const int W = std::max(1, width);
  const int H = std::max(1, height);
  CoverageMask m;
  m.cols = std::max(1, std::min(maxSamples, W));
  m.rows = std::max(1, std::min(maxSamples, H));
  const auto cols = static_cast<std::size_t>(m.cols);
  m.cells.assign(cols * static_cast<std::size_t>(m.rows), 0);
  constexpr int kSub = 8;  // at most 8×8 evenly spaced probes per cell
  for (int ry = 0; ry < m.rows; ++ry) {
    const int y0 = static_cast<int>(std::floor((static_cast<double>(ry) / m.rows) * H));
    const int y1 = std::max(y0 + 1, static_cast<int>(std::floor((static_cast<double>(ry + 1) / m.rows) * H)));
    const int stepY = std::max(1, static_cast<int>(std::floor(static_cast<double>(y1 - y0) / kSub)));
    for (int cx = 0; cx < m.cols; ++cx) {
      const int x0 = static_cast<int>(std::floor((static_cast<double>(cx) / m.cols) * W));
      const int x1 = std::max(x0 + 1, static_cast<int>(std::floor((static_cast<double>(cx + 1) / m.cols) * W)));
      const int stepX = std::max(1, static_cast<int>(std::floor(static_cast<double>(x1 - x0) / kSub)));
      int maxA = 0;
      for (int py = y0; py < y1 && maxA < threshold; py += stepY) {
        const auto rowBase = static_cast<std::size_t>(py) * static_cast<std::size_t>(W);
        for (int px = x0; px < x1; px += stepX) {
          const std::size_t o = ((rowBase + static_cast<std::size_t>(px)) * 4) + 3;
          if (o >= data.size()) continue;  // undefined > maxA is false
          const int a = data[o];
          if (a > maxA) {
            maxA = a;
            if (maxA >= threshold) break;
          }
        }
      }
      m.cells[(static_cast<std::size_t>(ry) * cols) + static_cast<std::size_t>(cx)] = maxA >= threshold ? 1 : 0;
    }
  }
  // FNV-1a over dims + threshold + cell bytes → stable cache identity.
  std::uint32_t h = 2166136261U;
  h = (h ^ static_cast<std::uint32_t>(m.cols)) * 16777619U;
  h = (h ^ static_cast<std::uint32_t>(m.rows)) * 16777619U;
  h = (h ^ static_cast<std::uint32_t>(threshold)) * 16777619U;
  for (const std::uint8_t c : m.cells) h = (h ^ c) * 16777619U;
  m.key = "cov" + std::to_string(m.cols) + "x" + std::to_string(m.rows) + ":" + std::to_string(h);
  return m;
}

bool coverage_covered(const CoverageMask& mask, double x, double y, double width, double height) {
  const double u = (x + (width / 2)) / width;
  const double v = (y + (height / 2)) / height;
  if (u < 0 || u >= 1 || v < 0 || v >= 1) return false;
  const int c = std::min(mask.cols - 1, std::max(0, static_cast<int>(std::floor(u * mask.cols))));
  const int r = std::min(mask.rows - 1, std::max(0, static_cast<int>(std::floor(v * mask.rows))));
  const std::size_t i = (static_cast<std::size_t>(r) * static_cast<std::size_t>(mask.cols)) + static_cast<std::size_t>(c);
  return i < mask.cells.size() && mask.cells[i] != 0;
}

std::vector<AlphaRegion> alpha_outline_regions(const CoverageMask& mask, double width, double height, double expansion) {
  const int cols = mask.cols;
  const int rows = mask.rows;
  if (cols < 1 || rows < 1 || width <= 0 || height <= 0) return {};
  if (mask.cells.size() < static_cast<std::size_t>(cols) * static_cast<std::size_t>(rows)) return {};
  std::vector<std::uint8_t> plane(static_cast<std::size_t>(cols) * static_cast<std::size_t>(rows));
  for (std::size_t i = 0; i < plane.size(); ++i) plane[i] = mask.cells[i] != 0 ? 255 : 0;
  const std::vector<effects::AlphaContour> contours = effects::extract_alpha_contours(plane, cols, rows, kMaskThreshold);
  if (contours.empty()) return {};

  const double cellW = width / cols;
  const double cellH = height / rows;
  const auto to_local = [&](const effects::AlphaPt& p) {
    return Pt2{(((p.x + 0.5) / cols) - 0.5) * width, (((p.y + 0.5) / rows) - 0.5) * height};
  };
  const double tol = std::max(0.25, std::min(cellW, cellH) * 0.5);
  const double eps = std::min(cellW, cellH) * 1e-3;
  const double minArea = std::max(1.0, width * height * 1e-4);

  struct Ring {
    std::vector<Pt2> points;
    double area = 0;
  };
  std::vector<Ring> rings;
  for (const effects::AlphaContour& c : contours) {
    std::vector<Pt2> mapped;
    mapped.reserve(c.size());
    for (const effects::AlphaPt& p : c) mapped.push_back(to_local(p));
    const std::vector<Pt2> local = dedupe(mapped, eps);
    if (local.size() < 3) continue;
    std::vector<Pt2> simple = dedupe(simplify_ring(local, tol), eps);
    if (simple.size() < 3) continue;
    const double area = mesh::signed_area(simple);
    if (std::abs(area) < minArea) continue;
    rings.push_back({std::move(simple), std::abs(area)});
  }
  if (rings.empty()) return {};

  // Containment depth decides outer vs hole (odd = hole).
  std::vector<int> depth(rings.size(), 0);
  for (std::size_t i = 0; i < rings.size(); ++i) {
    for (std::size_t j = 0; j < rings.size(); ++j) {
      if (i == j) continue;
      if (rings[j].area > rings[i].area && mesh::point_in_ring(rings[i].points[0], rings[j].points)) ++depth[i];
    }
  }
  std::vector<AlphaRegion> regions;
  std::vector<std::pair<std::size_t, std::size_t>> outerIndex;  // (ring, region), insertion order
  for (std::size_t i = 0; i < rings.size(); ++i) {
    if (depth[i] % 2 != 0) continue;
    outerIndex.emplace_back(i, regions.size());
    regions.push_back({orient_positive(rings[i].points), {}});
  }
  for (std::size_t i = 0; i < rings.size(); ++i) {
    if (depth[i] % 2 == 0) continue;
    std::ptrdiff_t best = -1;
    double bestArea = kInf;
    for (const auto& [j, ri] : outerIndex) {
      if (rings[j].area <= rings[i].area) continue;
      if (!mesh::point_in_ring(rings[i].points[0], rings[j].points)) continue;
      if (rings[j].area < bestArea) {
        bestArea = rings[j].area;
        best = static_cast<std::ptrdiff_t>(ri);
      }
    }
    if (best >= 0) regions[static_cast<std::size_t>(best)].holes.push_back(orient_positive(rings[i].points));
  }

  // Grow by Expansion PLUS the simplification tolerance (containment guarantee).
  const double grow = expansion + tol;
  if (grow != 0) {
    for (AlphaRegion& r : regions) {
      r.outer = dedupe(offset_ring(r.outer, grow), eps);
      std::vector<std::vector<Pt2>> holes;
      for (const auto& h : r.holes) {
        std::vector<Pt2> g = dedupe(offset_ring(h, -grow), eps);
        if (g.size() >= 3 && std::abs(mesh::signed_area(g)) >= minArea) holes.push_back(std::move(g));
      }
      r.holes = std::move(holes);
    }
  }
  std::erase_if(regions, [](const AlphaRegion& r) { return r.outer.size() < 3; });
  return regions;
}

double density_to_spacing(double width, double height, double density) {
  const double d = std::max(2.0, std::min(50.0, mjs::round(density)));
  return std::max(1.0, std::max(width, height) / d);
}

std::optional<AlphaMeshGeometry> build_alpha_outline_geometry(double width, double height, double pad, double density, double expansion,
                                                              const CoverageMask& mask) {
  const std::vector<AlphaRegion> regions = alpha_outline_regions(mask, width, height, expansion);
  if (regions.empty()) return std::nullopt;
  const double base = density_to_spacing(width, height, density);
  // The outline is sampled against the mask's own cells (the narrowest gap it can
  // hold is about one), never coarser than the lattice.
  const double cell = std::min(width / std::max(1, mask.cols), height / std::max(1, mask.rows));
  for (int attempt = 0; attempt < 4; ++attempt) {
    const double spacing = base * mjs::pow(1.6, attempt);
    const double edge = std::min(spacing, std::max(1.0, cell * 0.75));
    std::vector<Pt2> verts;
    std::vector<std::int32_t> tris;
    bool ok = true;
    for (const AlphaRegion& region : regions) {
      auto r = triangulate_region(region, spacing, edge);
      // A region whose triangles do not cover it would drop that part of the
      // picture: once more with the outline sampled twice as finely, then the
      // whole mesh falls back to the covered grid (resolve_rest_mesh).
      const double need = region_area(region) * kMinRegionCoverage;
      if (const auto* tr0 = std::get_if<Triangulated>(&r); tr0 != nullptr && tr0->keptArea < need) {
        r = triangulate_region(region, spacing, edge * 0.5);
        if (const auto* tr1 = std::get_if<Triangulated>(&r); tr1 != nullptr && tr1->keptArea < need) return std::nullopt;
      }
      if (std::holds_alternative<OverBudget>(r)) {
        ok = false;
        break;
      }
      if (std::holds_alternative<std::monostate>(r)) continue;  // a speck too small for this spacing
      const Triangulated& tr = std::get<Triangulated>(r);
      const auto offset = static_cast<std::int32_t>(verts.size());
      verts.insert(verts.end(), tr.pts.begin(), tr.pts.end());
      for (const std::int32_t i : tr.tris) tris.push_back(i + offset);
      if (verts.size() > kMaxVertices) {
        ok = false;
        break;
      }
    }
    if (!ok || tris.size() < 3) continue;
    std::vector<std::int32_t> remap(verts.size(), -1);
    std::int32_t next = 0;
    for (const std::int32_t i : tris) {
      if (remap[static_cast<std::size_t>(i)] < 0) remap[static_cast<std::size_t>(i)] = next++;
    }
    if (std::cmp_greater(next, kMaxVertices)) continue;
    AlphaMeshGeometry g;
    g.numVertices = static_cast<std::size_t>(next);
    g.vertices.assign(g.numVertices * 4, 0.0F);
    const double halfW = width / 2;
    const double halfH = height / 2;
    for (std::size_t i = 0; i < verts.size(); ++i) {
      const std::int32_t m = remap[i];
      if (m < 0) continue;
      const auto k = static_cast<std::size_t>(m);
      const Pt2 p = verts[i];
      g.vertices[(k * 4) + 0] = static_cast<float>(p.x);
      g.vertices[(k * 4) + 1] = static_cast<float>(p.y);
      g.vertices[(k * 4) + 2] = static_cast<float>((p.x + halfW + pad) / (width + (2 * pad)));
      g.vertices[(k * 4) + 3] = static_cast<float>((p.y + halfH + pad) / (height + (2 * pad)));
    }
    g.triangles.reserve(tris.size());
    for (const std::int32_t i : tris) g.triangles.push_back(static_cast<std::uint16_t>(remap[static_cast<std::size_t>(i)]));
    return g;
  }
  return std::nullopt;
}

}  // namespace premation::scene::rig
