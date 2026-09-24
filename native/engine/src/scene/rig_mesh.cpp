#include "rig_mesh.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <map>
#include <numbers>
#include <set>
#include <string>
#include <unordered_map>
#include <utility>

#include "jsmath.hpp"

namespace premation::scene {
namespace {

namespace mjs = motion::js;

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
constexpr double kInf = std::numeric_limits<double>::infinity();
/// `const DEG_TO_RAD = Math.PI / 180` (puppet.ts, arap.ts, bendPins.ts).
constexpr double kDegToRad = std::numbers::pi / 180;

// ── V8 Math helpers (NaN propagation and ±0 exactly as JavaScript) ─────────────

double jmax(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return kNaN;
  if (a == b) return std::signbit(a) ? b : a;
  return a > b ? a : b;
}
double jmin(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return kNaN;
  if (a == b) return std::signbit(a) ? a : b;
  return a < b ? a : b;
}
double hypot2(double a, double b) {
  const std::array<double, 2> v{a, b};
  return mjs::hypot(v);
}
float f32(double v) { return static_cast<float>(v); }

/// A JSON number, else NaN (what JavaScript arithmetic makes of a missing field).
double jn(const Json& v) { return v.is_number() ? v.num() : kNaN; }
/// `typeof v === 'number' ? v : undefined` — null and absent read as absent.
std::optional<double> jopt(const Json& v) { return v.is_number() ? std::optional<double>(v.num()) : std::nullopt; }
/// A property key as JavaScript would spell it.
std::string jkey(const Json& v) {
  if (v.is_string()) return v.str();
  if (v.is_number()) return js::number_to_string(v.num());
  if (v.is_null()) return "null";
  if (v.is_bool()) return v.b() ? "true" : "false";
  return "undefined";
}

/// Canonical array-index key ("0", "17"; not "01", "-1", "1.5") — JavaScript
/// enumerates these first, ascending, before the string keys in insertion order.
std::optional<std::uint32_t> array_index_key(std::string_view k) {
  if (k.empty() || k.size() > 10) return std::nullopt;
  if (k.size() > 1 && k[0] == '0') return std::nullopt;
  std::uint64_t v = 0;
  for (const char c : k) {
    if (c < '0' || c > '9') return std::nullopt;
    v = v * 10 + static_cast<std::uint64_t>(c - '0');
  }
  if (v >= 0xFFFFFFFFULL) return std::nullopt;
  return static_cast<std::uint32_t>(v);
}
/// `Object.keys(o)` over an insertion-ordered key list.
std::vector<std::string> js_key_order(const std::vector<std::string>& keys) {
  std::vector<std::pair<std::uint32_t, std::string>> idx;
  std::vector<std::string> rest;
  for (const std::string& k : keys) {
    if (const auto i = array_index_key(k)) idx.emplace_back(*i, k);
    else rest.push_back(k);
  }
  std::ranges::sort(idx, [](const auto& a, const auto& b) { return a.first < b.first; });
  std::vector<std::string> out;
  out.reserve(keys.size());
  for (auto& [i, k] : idx) out.push_back(std::move(k));
  for (std::string& k : rest) out.push_back(std::move(k));
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Puppet data (puppet.ts PuppetPin / DeformPin / PuppetRig / DeformedMesh)
// ═══════════════════════════════════════════════════════════════════════════

struct StoredPin {
  std::string id;
  double x = 0, y = 0;
  std::string kind;  ///< "" = absent (advanced)
  std::optional<std::array<double, 2>> position;
  std::optional<double> rotation, stiffness, scale, overlap, overlapExtent;
};

struct DeformPin {
  std::string id;
  double x = 0, y = 0;
  std::string kind;
  std::optional<double> rotation, stiffness, scale, overlap, overlapExtent;
};

struct MeshRig {
  std::vector<StoredPin> pins;
  Json density;    ///< meshDensity (as stored)
  Json expansion;  ///< meshExpansion (as stored)
  bool silhouette = false;
};

struct RestMesh {
  std::vector<float> v;  ///< x, y, u, v
  std::vector<std::uint16_t> tris;
  std::unordered_map<std::string, std::array<double, 2>> pinRest;
  /// weights: pinId → column. `keys` keeps the object's insertion order.
  std::unordered_map<std::string, std::vector<float>> weights;
  std::vector<std::string> keys;
  std::unordered_map<std::string, std::size_t> pinVertex;

  [[nodiscard]] std::size_t n() const noexcept { return v.size() / 4; }
  [[nodiscard]] const std::vector<float>* col(const std::string& id) const {
    const auto it = weights.find(id);
    return it == weights.end() ? nullptr : &it->second;
  }
  void set_col(const std::string& id, std::vector<float> w) {
    if (!weights.contains(id)) keys.push_back(id);
    weights[id] = std::move(w);
  }
};

StoredPin read_pin(const Json& p) {
  StoredPin s;
  s.id = jkey(p.at("id"));
  s.x = jn(p.at("x"));
  s.y = jn(p.at("y"));
  if (p.at("kind").is_string()) s.kind = p.at("kind").str();
  const Json& pos = p.at("position");
  // `pin.position ? pin.position : null` — any object (fields read as numbers).
  if (pos.is_object()) s.position = std::array<double, 2>{jn(pos.at("x")), jn(pos.at("y"))};
  s.rotation = jopt(p.at("rotation"));
  s.stiffness = jopt(p.at("stiffness"));
  s.scale = jopt(p.at("scale"));
  s.overlap = jopt(p.at("overlap"));
  s.overlapExtent = jopt(p.at("overlapExtent"));
  return s;
}

// ── mesh.ts ────────────────────────────────────────────────────────────────

struct V2 {
  double x = 0, y = 0;
};
using Tri = std::array<std::uint32_t, 3>;

double polygon_area(const std::vector<V2>& poly) {
  double a = 0;
  for (std::size_t i = 0; i < poly.size(); ++i) {
    const V2& p = poly[i];
    const V2& q = poly[(i + 1) % poly.size()];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

double cross(double ax, double ay, double bx, double by) { return ax * by - ay * bx; }

bool point_in_triangle(const V2& p, const V2& a, const V2& b, const V2& c) {
  const double d1 = cross(p.x - a.x, p.y - a.y, b.x - a.x, b.y - a.y);
  const double d2 = cross(p.x - b.x, p.y - b.y, c.x - b.x, c.y - b.y);
  const double d3 = cross(p.x - c.x, p.y - c.y, a.x - c.x, a.y - c.y);
  const bool hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const bool hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

std::vector<Tri> ear_clip(const std::vector<V2>& polygon) {
  const std::size_t n = polygon.size();
  if (n < 3) return {};
  std::vector<std::uint32_t> idx(n);
  for (std::size_t i = 0; i < n; ++i) idx[i] = static_cast<std::uint32_t>(i);
  if (polygon_area(polygon) < 0) std::ranges::reverse(idx);
  std::vector<Tri> tris;
  std::size_t guard = 0;
  const std::size_t maxGuard = n * n + 16;
  while (idx.size() > 3 && guard++ < maxGuard) {
    bool clipped = false;
    const std::size_t len = idx.size();
    for (std::size_t i = 0; i < len; ++i) {
      const std::uint32_t ia = idx[(i + len - 1) % len];
      const std::uint32_t ib = idx[i];
      const std::uint32_t ic = idx[(i + 1) % len];
      const V2& a = polygon[ia];
      const V2& b = polygon[ib];
      const V2& c = polygon[ic];
      if (cross(b.x - a.x, b.y - a.y, c.x - b.x, c.y - b.y) <= 0) continue;
      bool contains = false;
      for (const std::uint32_t ij : idx) {
        if (ij == ia || ij == ib || ij == ic) continue;
        if (point_in_triangle(polygon[ij], a, b, c)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;
      tris.push_back({ia, ib, ic});
      idx.erase(idx.begin() + static_cast<std::ptrdiff_t>(i));
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.size() == 3) tris.push_back({idx[0], idx[1], idx[2]});
  return tris;
}

struct PolyMesh {
  std::vector<V2> vertices;
  std::vector<Tri> triangles;
};

PolyMesh subdivide(const PolyMesh& mesh, int iterations) {
  PolyMesh m = mesh;
  for (int it = 0; it < iterations; ++it) {
    std::vector<V2> vertices = m.vertices;
    std::map<std::pair<std::uint32_t, std::uint32_t>, std::uint32_t> midCache;
    const auto mid = [&](std::uint32_t a, std::uint32_t b) -> std::uint32_t {
      const auto key = a < b ? std::pair{a, b} : std::pair{b, a};
      if (const auto f = midCache.find(key); f != midCache.end()) return f->second;
      const V2 va = vertices[a];
      const V2 vb = vertices[b];
      const auto i = static_cast<std::uint32_t>(vertices.size());
      vertices.push_back({(va.x + vb.x) / 2, (va.y + vb.y) / 2});
      midCache.emplace(key, i);
      return i;
    };
    std::vector<Tri> triangles;
    triangles.reserve(m.triangles.size() * 4);
    for (const Tri& t : m.triangles) {
      const std::uint32_t ab = mid(t[0], t[1]);
      const std::uint32_t bc = mid(t[1], t[2]);
      const std::uint32_t ca = mid(t[2], t[0]);
      triangles.push_back({t[0], ab, ca});
      triangles.push_back({ab, t[1], bc});
      triangles.push_back({ca, bc, t[2]});
      triangles.push_back({ab, bc, ca});
    }
    m = PolyMesh{std::move(vertices), std::move(triangles)};
  }
  return m;
}

// ── puppet.ts: rest mesh ───────────────────────────────────────────────────

bool point_in_polygon(double px, double py, const std::vector<V2>& poly) {
  bool inside = false;
  for (std::size_t i = 0, j = poly.size() - 1; i < poly.size(); j = i++) {
    const V2& a = poly[i];
    const V2& b = poly[j];
    if ((a.y > py) != (b.y > py) && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

void normalize_weight_columns(RestMesh& m, const std::vector<std::string>& pinIds, std::size_t numVertices,
                              const std::vector<std::uint8_t>* uniformWhere) {
  if (pinIds.empty()) return;
  for (std::size_t i = 0; i < numVertices; ++i) {
    double sum = 0;
    for (const std::string& id : pinIds) {
      if (const auto* w = m.col(id)) sum += i < w->size() ? static_cast<double>((*w)[i]) : 0;
    }
    if (sum > 0) {
      for (const std::string& id : pinIds) {
        const auto it = m.weights.find(id);
        if (it == m.weights.end() || i >= it->second.size()) continue;
        it->second[i] = f32(static_cast<double>(it->second[i]) / sum);
      }
    } else if (uniformWhere != nullptr && (*uniformWhere)[i] != 0) {
      const double uniform = 1.0 / static_cast<double>(pinIds.size());
      for (const std::string& id : pinIds) {
        const auto it = m.weights.find(id);
        if (it == m.weights.end() || i >= it->second.size()) continue;
        it->second[i] = f32(uniform);
      }
    }
  }
}

RestMesh finish_rest_mesh(std::vector<float> vertices, std::vector<std::uint16_t> triangles, std::size_t numVertices,
                          const std::vector<StoredPin>& pins) {
  RestMesh m;
  m.v = std::move(vertices);
  m.tris = std::move(triangles);
  std::vector<std::size_t> pinList;
  for (const StoredPin& pin : pins) {
    m.pinRest[pin.id] = {pin.x, pin.y};
    double minDist = kInf;
    std::size_t bestIdx = 0;
    for (std::size_t i = 0; i < numVertices; ++i) {
      const double vx = m.v[i * 4 + 0];
      const double vy = m.v[i * 4 + 1];
      const double dist = hypot2(vx - pin.x, vy - pin.y);
      if (dist < minDist) {
        minDist = dist;
        bestIdx = i;
      }
    }
    m.pinVertex[pin.id] = bestIdx;
    pinList.push_back(bestIdx);
  }

  std::vector<std::vector<std::uint32_t>> neighbors(numVertices);
  const auto link = [&neighbors](std::uint32_t a, std::uint32_t b) {
    auto& na = neighbors[a];
    if (std::ranges::find(na, b) == na.end()) na.push_back(b);
  };
  for (std::size_t i = 0; i + 2 < m.tris.size(); i += 3) {
    const std::uint32_t a = m.tris[i];
    const std::uint32_t b = m.tris[i + 1];
    const std::uint32_t c = m.tris[i + 2];
    link(a, b);
    link(b, a);
    link(b, c);
    link(c, b);
    link(c, a);
    link(a, c);
  }

  std::vector<std::uint8_t> locked(numVertices, 0);
  for (const std::size_t k : pinList) locked[k] = 1;
  for (const StoredPin& pin : pins) {
    const std::size_t targetIdx = m.pinVertex[pin.id];
    std::vector<float> W(numVertices, 0.0F);
    if (numVertices > 0) W[targetIdx] = 1.0F;
    for (int iter = 0; iter < 150; ++iter) {
      std::vector<float> nextW(numVertices, 0.0F);
      if (numVertices > 0) nextW[targetIdx] = 1.0F;
      for (const std::size_t vk : pinList) {
        if (vk != targetIdx) nextW[vk] = 0.0F;
      }
      for (std::size_t i = 0; i < numVertices; ++i) {
        if (locked[i] != 0) continue;
        const auto& nb = neighbors[i];
        if (nb.empty()) continue;
        double sum = 0;
        for (const std::uint32_t k : nb) sum += static_cast<double>(W[k]);
        nextW[i] = f32(sum / static_cast<double>(nb.size()));
      }
      W = std::move(nextW);
    }
    m.set_col(pin.id, std::move(W));
  }
  std::vector<std::string> ids;
  ids.reserve(pins.size());
  for (const StoredPin& p : pins) ids.push_back(p.id);
  normalize_weight_columns(m, ids, numVertices, nullptr);
  return m;
}

/// buildSilhouetteMesh — nullopt when the outline cannot be triangulated.
std::optional<RestMesh> build_silhouette_mesh(double width, double height, double pad, const MeshRig& rig,
                                              const std::vector<V2>& silhouette) {
  const std::vector<V2> poly = silhouette;
  const double minArea = jmax(1, width * height * 1e-4);
  if (std::abs(polygon_area(poly)) < minArea) return std::nullopt;
  const std::vector<Tri> tris = ear_clip(poly);
  if (tris.empty()) return std::nullopt;
  // `rig.meshDensity ?? 15` — fractional values only move the round thresholds.
  const double dRaw = rig.density.is_number() ? rig.density.num() : 15;
  const double density = jmax(2, jmin(50, dRaw));
  const int rounds = density < 8 ? 0 : density < 18 ? 1 : density < 32 ? 2 : 3;
  PolyMesh mesh = subdivide({poly, tris}, rounds);
  if (mesh.vertices.size() > 65535) {
    mesh = subdivide({poly, tris}, std::max(0, rounds - 1));
    if (mesh.vertices.size() > 65535) return std::nullopt;
  }
  const std::size_t numVertices = mesh.vertices.size();
  std::vector<float> vertices(numVertices * 4);
  const double halfW = width / 2;
  const double halfH = height / 2;
  for (std::size_t i = 0; i < numVertices; ++i) {
    const V2& v = mesh.vertices[i];
    vertices[i * 4 + 0] = f32(v.x);
    vertices[i * 4 + 1] = f32(v.y);
    vertices[i * 4 + 2] = f32((v.x + halfW + pad) / (width + 2 * pad));
    vertices[i * 4 + 3] = f32((v.y + halfH + pad) / (height + 2 * pad));
  }
  std::vector<std::uint16_t> triangles;
  triangles.reserve(mesh.triangles.size() * 3);
  for (const Tri& t : mesh.triangles) {
    for (const std::uint32_t k : t) triangles.push_back(static_cast<std::uint16_t>(k));
  }
  return finish_rest_mesh(std::move(vertices), std::move(triangles), numVertices, rig.pins);
}

/// buildRestMesh (no alpha coverage mask: image layers are reported by the caller).
/// `gridCells` is the clamped integer grid density; nullopt (a fractional density)
/// returns nullopt when the grid is needed — the TS indexes a typed array at
/// fractional offsets there, which this port does not imitate.
std::optional<RestMesh> build_rest_mesh(double width, double height, double pad, const MeshRig& rig,
                                        const std::optional<std::vector<V2>>& silhouette, std::optional<int> gridCells,
                                        double expansion) {
  if (rig.silhouette && silhouette && silhouette->size() >= 3) {
    if (auto built = build_silhouette_mesh(width, height, pad, rig, *silhouette)) return built;
  }
  if (!gridCells) return std::nullopt;
  const int cols = *gridCells;
  const int rows = *gridCells;
  const double halfW = width / 2;
  const double halfH = height / 2;
  const double Xmin = -halfW - pad - expansion;
  const double Xmax = halfW + pad + expansion;
  const double Ymin = -halfH - pad - expansion;
  const double Ymax = halfH + pad + expansion;
  const auto ucols = static_cast<std::size_t>(cols);
  const auto urows = static_cast<std::size_t>(rows);
  const std::size_t gridVerts = (ucols + 1) * (urows + 1);

  std::vector<float> gridPos(gridVerts * 4);
  std::size_t idx = 0;
  for (int r = 0; r <= rows; ++r) {
    const double fy = static_cast<double>(r) / static_cast<double>(rows);
    const double y = Ymin + fy * (Ymax - Ymin);
    for (int c = 0; c <= cols; ++c) {
      const double fx = static_cast<double>(c) / static_cast<double>(cols);
      const double x = Xmin + fx * (Xmax - Xmin);
      const double u = (x + halfW + pad) / (width + 2 * pad);
      const double v = (y + halfH + pad) / (height + 2 * pad);
      gridPos[idx * 4 + 0] = f32(x);
      gridPos[idx * 4 + 1] = f32(y);
      gridPos[idx * 4 + 2] = f32(u);
      gridPos[idx * 4 + 3] = f32(v);
      ++idx;
    }
  }

  const std::size_t cellCount = ucols * urows;
  std::optional<std::vector<std::uint8_t>> keepCell;
  if (silhouette && silhouette->size() >= 3) {
    const std::vector<V2>& poly = *silhouette;
    const auto covered = [&poly](double x, double y) { return point_in_polygon(x, y, poly); };
    std::vector<std::uint8_t> inside(gridVerts);
    for (std::size_t i = 0; i < gridVerts; ++i) inside[i] = covered(gridPos[i * 4 + 0], gridPos[i * 4 + 1]) ? 1 : 0;
    // Polygon silhouettes keep the single centre probe (subX = subY = 1).
    std::vector<std::uint8_t> kept(cellCount, 0);
    bool anyKept = false;
    for (std::size_t r = 0; r < urows; ++r) {
      for (std::size_t c = 0; c < ucols; ++c) {
        const std::size_t i0 = r * (ucols + 1) + c;
        const std::size_t i1 = i0 + 1;
        const std::size_t i2 = i0 + (ucols + 1);
        const std::size_t i3 = i2 + 1;
        bool keep = inside[i0] != 0 || inside[i1] != 0 || inside[i2] != 0 || inside[i3] != 0;
        if (!keep) {
          const double x0 = gridPos[i0 * 4 + 0];
          const double y0 = gridPos[i0 * 4 + 1];
          const double cw = static_cast<double>(gridPos[i3 * 4 + 0]) - x0;
          const double ch = static_cast<double>(gridPos[i3 * 4 + 1]) - y0;
          const double py = y0 + ((0 + 0.5) / 1) * ch;
          const double px = x0 + ((0 + 0.5) / 1) * cw;
          if (covered(px, py)) keep = true;
        }
        if (keep) {
          kept[r * ucols + c] = 1;
          anyKept = true;
        }
      }
    }
    if (anyKept) {
      if (expansion > 0) {
        std::vector<std::uint8_t> dilated(cellCount, 0);
        for (std::size_t r = 0; r < urows; ++r) {
          for (std::size_t c = 0; c < ucols; ++c) {
            if (kept[r * ucols + c] == 0) continue;
            for (int dr = -1; dr <= 1; ++dr) {
              for (int dc = -1; dc <= 1; ++dc) {
                const auto rr = static_cast<std::ptrdiff_t>(r) + dr;
                const auto cc = static_cast<std::ptrdiff_t>(c) + dc;
                if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) {
                  dilated[static_cast<std::size_t>(rr) * ucols + static_cast<std::size_t>(cc)] = 1;
                }
              }
            }
          }
        }
        keepCell = std::move(dilated);
      } else {
        keepCell = std::move(kept);
      }
    }
  }

  std::vector<float> vertices;
  std::vector<std::uint16_t> triangles;
  std::size_t numVertices = 0;
  const auto corner = [ucols](std::size_t r, std::size_t c) { return r * (ucols + 1) + c; };
  if (keepCell) {
    std::vector<std::int32_t> remap(gridVerts, -1);
    std::int32_t next = 0;
    std::size_t keptCells = 0;
    for (std::size_t r = 0; r < urows; ++r) {
      for (std::size_t c = 0; c < ucols; ++c) {
        if ((*keepCell)[r * ucols + c] == 0) continue;
        ++keptCells;
        for (const std::size_t g : {corner(r, c), corner(r, c + 1), corner(r + 1, c), corner(r + 1, c + 1)}) {
          if (remap[g] < 0) remap[g] = next++;
        }
      }
    }
    numVertices = static_cast<std::size_t>(next);
    vertices.assign(numVertices * 4, 0.0F);
    for (std::size_t g = 0; g < gridVerts; ++g) {
      const std::int32_t k = remap[g];
      if (k < 0) continue;
      const auto n = static_cast<std::size_t>(k);
      for (std::size_t q = 0; q < 4; ++q) vertices[n * 4 + q] = gridPos[g * 4 + q];
    }
    triangles.reserve(keptCells * 6);
    for (std::size_t r = 0; r < urows; ++r) {
      for (std::size_t c = 0; c < ucols; ++c) {
        if ((*keepCell)[r * ucols + c] == 0) continue;
        const auto i0 = static_cast<std::uint16_t>(remap[corner(r, c)]);
        const auto i1 = static_cast<std::uint16_t>(remap[corner(r, c + 1)]);
        const auto i2 = static_cast<std::uint16_t>(remap[corner(r + 1, c)]);
        const auto i3 = static_cast<std::uint16_t>(remap[corner(r + 1, c + 1)]);
        triangles.insert(triangles.end(), {i0, i1, i2, i1, i3, i2});
      }
    }
  } else {
    numVertices = gridVerts;
    vertices = std::move(gridPos);
    triangles.reserve(cellCount * 6);
    for (std::size_t r = 0; r < urows; ++r) {
      for (std::size_t c = 0; c < ucols; ++c) {
        const auto i0 = static_cast<std::uint16_t>(corner(r, c));
        const auto i1 = static_cast<std::uint16_t>(corner(r, c + 1));
        const auto i2 = static_cast<std::uint16_t>(corner(r + 1, c));
        const auto i3 = static_cast<std::uint16_t>(corner(r + 1, c + 1));
        triangles.insert(triangles.end(), {i0, i1, i2, i1, i3, i2});
      }
    }
  }
  return finish_rest_mesh(std::move(vertices), std::move(triangles), numVertices, rig.pins);
}

// ── puppet.ts: deformation ─────────────────────────────────────────────────

std::vector<DeformPin> clamp_pin_rotations(const std::vector<DeformPin>& pins, std::optional<double> maxRotationDeg) {
  if (!maxRotationDeg || !std::isfinite(*maxRotationDeg)) return pins;
  const double lim = std::abs(*maxRotationDeg);
  bool needs = false;
  for (const DeformPin& p : pins) {
    if (std::abs(p.rotation.value_or(0)) > lim) {
      needs = true;
      break;
    }
  }
  if (!needs) return pins;
  std::vector<DeformPin> out = pins;
  for (DeformPin& p : out) {
    const double r = p.rotation.value_or(0);
    if (!(std::abs(r) <= lim)) p.rotation = r < 0 ? -lim : lim;
  }
  return out;
}

std::vector<float> deform_lbs(const std::vector<DeformPin>& pins, const RestMesh& rest) {
  const std::vector<float>& rv = rest.v;
  const std::size_t numVertices = rest.n();
  std::vector<float> out(rv.size());
  const std::size_t n = pins.size();
  std::vector<const std::vector<float>*> weightCols(n, nullptr);
  std::vector<double> restX(n), restY(n), dX(n), dY(n), cosR(n, 0), sinR(n, 0), stiffExp(n);
  std::vector<std::uint8_t> rotated(n, 0);
  bool hasStiffness = false;
  for (std::size_t p = 0; p < n; ++p) {
    const DeformPin& pin = pins[p];
    weightCols[p] = rest.col(pin.id);
    const auto rit = rest.pinRest.find(pin.id);
    const bool haveRest = rit != rest.pinRest.end();
    restX[p] = haveRest ? rit->second[0] : pin.x;
    restY[p] = haveRest ? rit->second[1] : pin.y;
    dX[p] = haveRest ? pin.x - rit->second[0] : 0;
    dY[p] = haveRest ? pin.y - rit->second[1] : 0;
    const double rot = pin.rotation.value_or(0);
    const double scl = pin.scale.value_or(1);
    if ((rot != 0 || scl != 1) && haveRest) {
      rotated[p] = 1;
      cosR[p] = mjs::cos(rot * kDegToRad) * scl;
      sinR[p] = mjs::sin(rot * kDegToRad) * scl;
    }
    const double s = jmax(0, pin.stiffness.value_or(0));
    stiffExp[p] = 1 + s;
    if (s > 0) hasStiffness = true;
  }
  std::vector<double> w(n);
  const auto base_w = [&](std::size_t p, std::size_t i) -> double {
    const auto* c = weightCols[p];
    return c != nullptr && i < c->size() ? static_cast<double>((*c)[i]) : 0.0;
  };
  for (std::size_t i = 0; i < numVertices; ++i) {
    const double vx = rv[i * 4 + 0];
    const double vy = rv[i * 4 + 1];
    if (hasStiffness) {
      double sum = 0;
      for (std::size_t p = 0; p < n; ++p) {
        const double base = base_w(p, i);
        const double sharp = base > 0 ? mjs::pow(base, stiffExp[p]) : 0;
        w[p] = sharp;
        sum += sharp;
      }
      if (sum > 1e-12) {
        for (std::size_t p = 0; p < n; ++p) w[p] = w[p] / sum;
      } else {
        for (std::size_t p = 0; p < n; ++p) w[p] = base_w(p, i);
      }
    } else {
      for (std::size_t p = 0; p < n; ++p) w[p] = base_w(p, i);
    }
    double dispX = 0;
    double dispY = 0;
    for (std::size_t p = 0; p < n; ++p) {
      const double wp = w[p];
      if (wp > 0 && weightCols[p] != nullptr) {
        if (rotated[p] != 0) {
          const double relX = vx - restX[p];
          const double relY = vy - restY[p];
          const double tx = cosR[p] * relX - sinR[p] * relY + restX[p] + dX[p] - vx;
          const double ty = sinR[p] * relX + cosR[p] * relY + restY[p] + dY[p] - vy;
          dispX += wp * tx;
          dispY += wp * ty;
        } else {
          dispX += wp * dX[p];
          dispY += wp * dY[p];
        }
      }
    }
    out[i * 4 + 0] = f32(vx + dispX);
    out[i * 4 + 1] = f32(vy + dispY);
    out[i * 4 + 2] = rv[i * 4 + 2];
    out[i * 4 + 3] = rv[i * 4 + 3];
  }
  return out;
}

// ── arap.ts ────────────────────────────────────────────────────────────────

constexpr int kOuterIterations = 4;
constexpr int kGsSweeps = 64;
constexpr std::size_t kDenseMax = 1200;
constexpr double kStiffK = 6.0;
constexpr std::size_t kStiffDenseMax = 512;
constexpr double kCotMin = 1e-3;
constexpr double kCotMax = 1e3;
constexpr double kDiagEps = 1e-9;

struct ArapTopology {
  std::size_t n = 0;
  std::vector<std::int32_t> nbrIdx;
  std::vector<double> nbrW;
  std::vector<std::int32_t> off;
  std::vector<double> diag;
  std::vector<std::int32_t> comp;
  std::size_t compCount = 0;
  std::vector<double> restX, restY;
};

double cot_angle(double ax, double ay, double bx, double by, double cx, double cy) {
  const double ux = bx - ax, uy = by - ay;
  const double vx = cx - ax, vy = cy - ay;
  const double dot = ux * vx + uy * vy;
  const double crs = ux * vy - uy * vx;
  const double area2 = std::abs(crs);
  if (area2 < 1e-12) return kNaN;
  const double cot = dot / area2;
  if (!std::isfinite(cot)) return kNaN;
  return jmax(-kCotMax, jmin(kCotMax, cot));
}

ArapTopology build_topology(const RestMesh& mesh) {
  ArapTopology t;
  const std::size_t n = mesh.n();
  t.n = n;
  t.restX.resize(n);
  t.restY.resize(n);
  for (std::size_t i = 0; i < n; ++i) {
    t.restX[i] = mesh.v[i * 4 + 0];
    t.restY[i] = mesh.v[i * 4 + 1];
  }
  // Insertion-ordered edge map (key = lo*n + hi), as the TypeScript Map.
  std::unordered_map<std::uint64_t, std::size_t> edgeAt;
  std::vector<std::pair<std::uint64_t, double>> edges;
  const auto addEdge = [&](std::uint32_t a, std::uint32_t b, double w) {
    const std::uint64_t lo = std::min(a, b);
    const std::uint64_t hi = std::max(a, b);
    const std::uint64_t key = lo * n + hi;
    const auto [it, fresh] = edgeAt.try_emplace(key, edges.size());
    if (fresh) edges.emplace_back(key, 0.0 + w);
    else edges[it->second].second = edges[it->second].second + w;
  };
  const auto& tris = mesh.tris;
  for (std::size_t k = 0; k + 2 < tris.size(); k += 3) {
    const std::uint32_t a = tris[k];
    const std::uint32_t b = tris[k + 1];
    const std::uint32_t c = tris[k + 2];
    const double ax = t.restX[a], ay = t.restY[a];
    const double bx = t.restX[b], by = t.restY[b];
    const double cx = t.restX[c], cy = t.restY[c];
    const double cotA = cot_angle(ax, ay, bx, by, cx, cy);
    const double cotB = cot_angle(bx, by, ax, ay, cx, cy);
    const double cotC = cot_angle(cx, cy, ax, ay, bx, by);
    if (!std::isfinite(cotA) || !std::isfinite(cotB) || !std::isfinite(cotC)) {
      addEdge(b, c, 0.5);
      addEdge(a, c, 0.5);
      addEdge(a, b, 0.5);
      continue;
    }
    addEdge(b, c, 0.5 * jmax(kCotMin, cotA));
    addEdge(a, c, 0.5 * jmax(kCotMin, cotB));
    addEdge(a, b, 0.5 * jmax(kCotMin, cotC));
  }
  struct Nb {
    std::uint64_t j;
    double w;
  };
  std::vector<std::vector<Nb>> lists(n);
  for (const auto& [key, w] : edges) {
    const std::uint64_t lo = key / n;
    const std::uint64_t hi = key - lo * n;
    lists[lo].push_back({hi, w});
    lists[hi].push_back({lo, w});
  }
  std::size_t total = 0;
  for (auto& l : lists) {
    std::ranges::stable_sort(l, [](const Nb& p, const Nb& q) { return p.j < q.j; });
    total += l.size();
  }
  t.off.assign(n + 1, 0);
  t.nbrIdx.resize(total);
  t.nbrW.resize(total);
  t.diag.assign(n, 0);
  std::size_t cursor = 0;
  for (std::size_t i = 0; i < n; ++i) {
    t.off[i] = static_cast<std::int32_t>(cursor);
    double d = 0;
    for (const Nb& e : lists[i]) {
      t.nbrIdx[cursor] = static_cast<std::int32_t>(e.j);
      t.nbrW[cursor] = e.w;
      d += e.w;
      ++cursor;
    }
    t.diag[i] = d;
  }
  t.off[n] = static_cast<std::int32_t>(cursor);
  // Connected components: BFS in ascending seed order.
  t.comp.assign(n, -1);
  std::vector<std::size_t> queue(n);
  for (std::size_t seed = 0; seed < n; ++seed) {
    if (t.comp[seed] != -1) continue;
    const auto id = static_cast<std::int32_t>(t.compCount++);
    t.comp[seed] = id;
    std::size_t head = 0;
    std::size_t tail = 0;
    queue[tail++] = seed;
    while (head < tail) {
      const std::size_t i = queue[head++];
      for (auto k = static_cast<std::size_t>(t.off[i]); k < static_cast<std::size_t>(t.off[i + 1]); ++k) {
        const auto j = static_cast<std::size_t>(t.nbrIdx[k]);
        if (t.comp[j] == -1) {
          t.comp[j] = id;
          queue[tail++] = j;
        }
      }
    }
  }
  return t;
}

bool cholesky_factor(std::vector<double>& A, std::size_t m) {
  for (std::size_t j = 0; j < m; ++j) {
    double sum = A[j * m + j];
    for (std::size_t k = 0; k < j; ++k) {
      const double ljk = A[j * m + k];
      sum -= ljk * ljk;
    }
    if (sum <= 1e-12) return false;
    const double ljj = std::sqrt(sum);
    A[j * m + j] = ljj;
    for (std::size_t i = j + 1; i < m; ++i) {
      double s = A[i * m + j];
      for (std::size_t k = 0; k < j; ++k) s -= A[i * m + k] * A[j * m + k];
      A[i * m + j] = s / ljj;
      A[j * m + i] = 0;
    }
  }
  return true;
}

void cholesky_solve(const std::vector<double>& L, std::size_t m, const std::vector<double>& b, std::vector<double>& x) {
  for (std::size_t i = 0; i < m; ++i) {
    double s = b[i];
    const std::size_t base = i * m;
    for (std::size_t k = 0; k < i; ++k) s -= L[base + k] * x[k];
    x[i] = s / L[base + i];
  }
  for (std::size_t ii = m; ii-- > 0;) {
    double s = x[ii];
    for (std::size_t k = ii + 1; k < m; ++k) s -= L[k * m + ii] * x[k];
    x[ii] = s / L[ii * m + ii];
  }
}

struct ReducedFactor {
  std::size_t m = 0;
  std::vector<std::size_t> freeOf;
  std::vector<std::int64_t> compactOf;
  std::optional<std::vector<double>> L;
};

ReducedFactor reduced_factor(const ArapTopology& topo, const std::vector<std::uint8_t>& pinnedFlag, const std::vector<double>& effDiag,
                             const std::vector<double>& effNbrW, std::size_t denseCap) {
  const std::size_t n = topo.n;
  std::vector<std::uint8_t> compHasPin(topo.compCount, 0);
  for (std::size_t i = 0; i < n; ++i) {
    if (pinnedFlag[i] != 0) compHasPin[static_cast<std::size_t>(topo.comp[i])] = 1;
  }
  ReducedFactor f;
  f.compactOf.assign(n, -1);
  for (std::size_t i = 0; i < n; ++i) {
    if (pinnedFlag[i] == 0 && topo.diag[i] > kDiagEps && compHasPin[static_cast<std::size_t>(topo.comp[i])] != 0) {
      f.compactOf[i] = static_cast<std::int64_t>(f.m++);
    }
  }
  f.freeOf.assign(f.m, 0);
  for (std::size_t i = 0; i < n; ++i) {
    if (f.compactOf[i] >= 0) f.freeOf[static_cast<std::size_t>(f.compactOf[i])] = i;
  }
  const std::size_t m = f.m;
  if (m > 0 && m <= denseCap) {
    std::vector<double> A(m * m, 0.0);
    for (std::size_t p = 0; p < m; ++p) {
      const std::size_t i = f.freeOf[p];
      A[p * m + p] = effDiag[i];
      for (auto k = static_cast<std::size_t>(topo.off[i]); k < static_cast<std::size_t>(topo.off[i + 1]); ++k) {
        const std::int64_t q = f.compactOf[static_cast<std::size_t>(topo.nbrIdx[k])];
        if (q >= 0) {
          const std::size_t at = p * m + static_cast<std::size_t>(q);
          A[at] = A[at] - effNbrW[k];
        }
      }
    }
    if (cholesky_factor(A, m)) f.L = std::move(A);
  }
  return f;
}

struct ArapHandles {
  std::vector<std::uint8_t> pinnedFlag;
  std::vector<double> targetX, targetY, cos, sin;
  std::size_t distinct = 0;
};

ArapHandles resolve_pinned_vertices(const std::vector<DeformPin>& pins, const RestMesh& rest, std::size_t n) {
  ArapHandles h;
  h.pinnedFlag.assign(n, 0);
  h.targetX.assign(n, 0);
  h.targetY.assign(n, 0);
  h.cos.assign(n, 0);
  h.sin.assign(n, 0);
  for (const DeformPin& pin : pins) {
    const auto* col = rest.col(pin.id);
    if (col == nullptr || col->size() < n) continue;
    const auto bit = rest.pinVertex.find(pin.id);
    const bool haveBound = bit != rest.pinVertex.end() && bit->second < n;
    std::size_t best = haveBound ? bit->second : 0;
    double bestW = haveBound ? static_cast<double>((*col)[best]) : -kInf;
    for (std::size_t i = 0; i < n; ++i) {
      const double w = (*col)[i];
      if (w > bestW) {
        bestW = w;
        best = i;
      }
    }
    if (h.pinnedFlag[best] == 0) ++h.distinct;
    h.pinnedFlag[best] = 1;
    const auto ait = rest.pinRest.find(pin.id);
    const double vx = rest.v[best * 4 + 0];
    const double vy = rest.v[best * 4 + 1];
    const double rx = ait != rest.pinRest.end() ? ait->second[0] : pin.x;
    const double ry = ait != rest.pinRest.end() ? ait->second[1] : pin.y;
    h.targetX[best] = vx + (pin.x - rx);
    h.targetY[best] = vy + (pin.y - ry);
    const double rot = pin.rotation.value_or(0) * kDegToRad;
    const double scl = pin.scale.value_or(1);
    h.cos[best] = mjs::cos(rot) * scl;
    h.sin[best] = mjs::sin(rot) * scl;
  }
  return h;
}

std::vector<float> deform_arap_with_handles(const std::vector<DeformPin>& pins, const RestMesh& rest, const ArapHandles& handles,
                                            const std::vector<float>& warmStart, std::optional<double> maxRotationDeg) {
  const std::size_t n = rest.n();
  if (n == 0) return warmStart;
  if (handles.distinct < 2) return warmStart;
  const ArapTopology topo = build_topology(rest);

  bool hasStiffness = false;
  for (const DeformPin& pin : pins) {
    if (jmax(0, pin.stiffness.value_or(0)) > 0 && rest.col(pin.id) != nullptr) {
      hasStiffness = true;
      break;
    }
  }
  std::vector<double> sNbrW;
  std::vector<double> sDiag;
  std::size_t denseCap = kDenseMax;
  if (hasStiffness) {
    std::vector<double> sVert(n, 0.0);
    for (const DeformPin& pin : pins) {
      const double s = jmax(0, pin.stiffness.value_or(0));
      if (!(s > 0)) continue;
      const auto* col = rest.col(pin.id);
      if (col == nullptr || col->size() < n) continue;
      for (std::size_t i = 0; i < n; ++i) sVert[i] = sVert[i] + static_cast<double>((*col)[i]) * s;
    }
    sNbrW.assign(topo.nbrW.size(), 0.0);
    sDiag.assign(n, 0.0);
    for (std::size_t i = 0; i < n; ++i) {
      const double si = sVert[i];
      double d = 0;
      for (auto k = static_cast<std::size_t>(topo.off[i]); k < static_cast<std::size_t>(topo.off[i + 1]); ++k) {
        const auto j = static_cast<std::size_t>(topo.nbrIdx[k]);
        const double fct = 1 + kStiffK * 0.5 * (si + sVert[j]);
        const double w = topo.nbrW[k] * fct;
        sNbrW[k] = w;
        d += w;
      }
      sDiag[i] = d;
    }
    denseCap = kStiffDenseMax;
  }
  const std::vector<double>& effNbrW = hasStiffness ? sNbrW : topo.nbrW;
  const std::vector<double>& effDiag = hasStiffness ? sDiag : topo.diag;
  const ReducedFactor factor = reduced_factor(topo, handles.pinnedFlag, effDiag, effNbrW, denseCap);
  const std::size_t m = factor.m;

  std::vector<double> x(n);
  std::vector<double> y(n);
  for (std::size_t i = 0; i < n; ++i) {
    if (handles.pinnedFlag[i] != 0) {
      x[i] = handles.targetX[i];
      y[i] = handles.targetY[i];
    } else {
      x[i] = warmStart[i * 4 + 0];
      y[i] = warmStart[i * 4 + 1];
    }
  }
  const std::optional<double> rotLimit = maxRotationDeg && std::isfinite(*maxRotationDeg)
                                             ? std::optional<double>(std::abs(*maxRotationDeg) * kDegToRad)
                                             : std::nullopt;
  std::vector<double> cosV(n, 0.0);
  std::vector<double> sinV(n, 0.0);
  std::vector<double> bx;
  std::vector<double> by;
  std::vector<double> sx;
  std::vector<double> sy;
  if (factor.L) {
    bx.assign(m, 0.0);
    by.assign(m, 0.0);
    sx.assign(m, 0.0);
    sy.assign(m, 0.0);
  }
  const auto& off = topo.off;
  const auto& nbrIdx = topo.nbrIdx;
  for (int outer = 0; outer < kOuterIterations; ++outer) {
    // Local step.
    for (std::size_t i = 0; i < n; ++i) {
      if (handles.pinnedFlag[i] != 0) {
        cosV[i] = handles.cos[i];
        sinV[i] = handles.sin[i];
        continue;
      }
      double s00 = 0, s01 = 0, s10 = 0, s11 = 0;
      for (auto k = static_cast<std::size_t>(off[i]); k < static_cast<std::size_t>(off[i + 1]); ++k) {
        const auto j = static_cast<std::size_t>(nbrIdx[k]);
        const double w = effNbrW[k];
        const double ex = topo.restX[i] - topo.restX[j];
        const double ey = topo.restY[i] - topo.restY[j];
        const double epx = x[i] - x[j];
        const double epy = y[i] - y[j];
        s00 += w * ex * epx;
        s01 += w * ex * epy;
        s10 += w * ey * epx;
        s11 += w * ey * epy;
      }
      double theta = mjs::atan2(s01 - s10, s00 + s11);
      if (rotLimit) {
        if (theta > *rotLimit) theta = *rotLimit;
        else if (theta < -*rotLimit) theta = -*rotLimit;
      }
      cosV[i] = mjs::cos(theta);
      sinV[i] = mjs::sin(theta);
    }
    // Global step.
    if (factor.L) {
      for (std::size_t p = 0; p < m; ++p) {
        const std::size_t i = factor.freeOf[p];
        double rbx = 0;
        double rby = 0;
        const double ci = cosV[i];
        const double si = sinV[i];
        for (auto k = static_cast<std::size_t>(off[i]); k < static_cast<std::size_t>(off[i + 1]); ++k) {
          const auto j = static_cast<std::size_t>(nbrIdx[k]);
          const double w = effNbrW[k];
          const double ex = topo.restX[i] - topo.restX[j];
          const double ey = topo.restY[i] - topo.restY[j];
          const double cs = ci + cosV[j];
          const double sn = si + sinV[j];
          rbx += w * 0.5 * (cs * ex - sn * ey);
          rby += w * 0.5 * (sn * ex + cs * ey);
          if (factor.compactOf[j] < 0) {
            rbx += w * x[j];
            rby += w * y[j];
          }
        }
        bx[p] = rbx;
        by[p] = rby;
      }
      cholesky_solve(*factor.L, m, bx, sx);
      cholesky_solve(*factor.L, m, by, sy);
      for (std::size_t p = 0; p < m; ++p) {
        const std::size_t i = factor.freeOf[p];
        x[i] = sx[p];
        y[i] = sy[p];
      }
    } else {
      for (int sweep = 0; sweep < kGsSweeps; ++sweep) {
        for (std::size_t i = 0; i < n; ++i) {
          if (handles.pinnedFlag[i] != 0 || factor.compactOf[i] < 0) continue;
          const double d = effDiag[i];
          double accX = 0;
          double accY = 0;
          const double ci = cosV[i];
          const double si = sinV[i];
          for (auto k = static_cast<std::size_t>(off[i]); k < static_cast<std::size_t>(off[i + 1]); ++k) {
            const auto j = static_cast<std::size_t>(nbrIdx[k]);
            const double w = effNbrW[k];
            const double ex = topo.restX[i] - topo.restX[j];
            const double ey = topo.restY[i] - topo.restY[j];
            const double cs = ci + cosV[j];
            const double sn = si + sinV[j];
            accX += w * (x[j] + 0.5 * (cs * ex - sn * ey));
            accY += w * (y[j] + 0.5 * (sn * ex + cs * ey));
          }
          x[i] = accX / d;
          y[i] = accY / d;
        }
      }
    }
  }
  std::vector<float> out(rest.v.size());
  for (std::size_t i = 0; i < n; ++i) {
    if (!std::isfinite(x[i]) || !std::isfinite(y[i])) return warmStart;
    out[i * 4 + 0] = f32(x[i]);
    out[i * 4 + 1] = f32(y[i]);
    out[i * 4 + 2] = rest.v[i * 4 + 2];
    out[i * 4 + 3] = rest.v[i * 4 + 3];
  }
  return out;
}

std::vector<float> deform_arap(const std::vector<DeformPin>& pins, const RestMesh& rest, const std::vector<float>& lbs,
                               std::optional<double> maxRotationDeg) {
  const std::size_t n = rest.n();
  if (n == 0) return lbs;
  const ArapHandles h = resolve_pinned_vertices(pins, rest, n);
  return deform_arap_with_handles(pins, rest, h, lbs, maxRotationDeg);
}

// ── bendPins.ts ────────────────────────────────────────────────────────────

/// Harmonic weight at or above which a vertex belongs to a bend pin's rigid core.
constexpr double kBendRegionWeight = 0.8;

std::vector<float> solve_deform(const std::vector<DeformPin>& pins, const RestMesh& rest, bool lbsSolver,
                                std::optional<double> maxRotationDeg) {
  const std::vector<DeformPin> clamped = clamp_pin_rotations(pins, maxRotationDeg);
  std::vector<float> lbs = deform_lbs(clamped, rest);
  if (lbsSolver) return lbs;
  return deform_arap(clamped, rest, lbs, maxRotationDeg);
}

RestMesh driver_rest_mesh(const RestMesh& rest, const std::vector<DeformPin>& bends) {
  std::set<std::string> bendIds;
  for (const DeformPin& b : bends) bendIds.insert(b.id);
  RestMesh view;
  view.v = rest.v;
  view.tris = rest.tris;
  view.pinRest = rest.pinRest;
  view.pinVertex = rest.pinVertex;
  std::vector<std::string> driverIds;
  const std::vector<std::string> keys = js_key_order(rest.keys);
  for (const std::string& id : keys) {
    if (bendIds.contains(id)) continue;
    view.set_col(id, *rest.col(id));
    driverIds.push_back(id);
  }
  const std::size_t n = rest.n();
  std::vector<std::uint8_t> hadInfluence(n, 0);
  for (const std::string& id : keys) {
    const auto& col = *rest.col(id);
    for (std::size_t i = 0; i < n; ++i) {
      if (i < col.size() && col[i] > 0) hadInfluence[i] = 1;
    }
  }
  normalize_weight_columns(view, driverIds, n, &hadInfluence);
  return view;
}

std::vector<float> apply_bend_pins(const std::vector<float>& base, const std::vector<DeformPin>& bends, const RestMesh& rest,
                                   std::optional<double> maxRotationDeg) {
  const std::vector<DeformPin> clamped = clamp_pin_rotations(bends, maxRotationDeg);
  std::optional<std::vector<float>> out;
  const std::size_t n = rest.n();
  for (const DeformPin& pin : clamped) {
    const double rotDeg = pin.rotation.value_or(0);
    const double scale = pin.scale.value_or(1);
    if (rotDeg == 0 && scale == 1) continue;
    const auto* col = rest.col(pin.id);
    const auto kit = rest.pinVertex.find(pin.id);
    if (col == nullptr || kit == rest.pinVertex.end()) continue;
    const std::size_t k = kit->second;
    if (!out) out = base;
    std::vector<float>& o = *out;
    const double cx = o[k * 4 + 0];
    const double cy = o[k * 4 + 1];
    const double rad = rotDeg * kDegToRad;
    const double c = mjs::cos(rad) * scale;
    const double s = mjs::sin(rad) * scale;
    const double stiffExp = 1 + jmax(0, pin.stiffness.value_or(0));
    for (std::size_t i = 0; i < n; ++i) {
      double w = i < col->size() ? static_cast<double>((*col)[i]) : 0;
      if (w <= 0) continue;
      if (stiffExp != 1) w = mjs::pow(w, stiffExp);
      const double vx = o[i * 4 + 0];
      const double vy = o[i * 4 + 1];
      const double relX = vx - cx;
      const double relY = vy - cy;
      const double tx = c * relX - s * relY + cx;
      const double ty = s * relX + c * relY + cy;
      o[i * 4 + 0] = f32(vx + w * (tx - vx));
      o[i * 4 + 1] = f32(vy + w * (ty - vy));
    }
  }
  return out ? std::move(*out) : base;
}

std::vector<float> apply_bend_pins_arap(const std::vector<float>& base, const std::vector<DeformPin>& drivers,
                                        const std::vector<DeformPin>& bends, const RestMesh& rest, const RestMesh& driverMesh,
                                        std::optional<double> maxRotationDeg) {
  const std::vector<DeformPin> clamped = clamp_pin_rotations(bends, maxRotationDeg);
  const std::size_t n = rest.n();
  std::vector<float> out = base;
  for (const DeformPin& pin : clamped) {
    const double rotDeg = pin.rotation.value_or(0);
    const double scale = pin.scale.value_or(1);
    if (rotDeg == 0 && scale == 1) continue;
    const auto* col = rest.col(pin.id);
    const auto kit = rest.pinVertex.find(pin.id);
    if (col == nullptr || kit == rest.pinVertex.end()) continue;
    const std::size_t k = kit->second;
    const double cx = out[k * 4 + 0];
    const double cy = out[k * 4 + 1];
    const double rad = rotDeg * kDegToRad;
    const double c = mjs::cos(rad) * scale;
    const double s = mjs::sin(rad) * scale;
    ArapHandles handles = resolve_pinned_vertices(drivers, driverMesh, n);
    std::size_t added = 0;
    for (std::size_t i = 0; i < n; ++i) {
      if (handles.pinnedFlag[i] != 0) continue;
      const double w = i < col->size() ? static_cast<double>((*col)[i]) : 0;
      if (i != k && w < kBendRegionWeight) continue;
      const double relX = static_cast<double>(out[i * 4 + 0]) - cx;
      const double relY = static_cast<double>(out[i * 4 + 1]) - cy;
      handles.pinnedFlag[i] = 1;
      handles.targetX[i] = c * relX - s * relY + cx;
      handles.targetY[i] = s * relX + c * relY + cy;
      handles.cos[i] = c;
      handles.sin[i] = s;
      ++added;
    }
    if (added == 0) continue;
    handles.distinct += added;
    const std::vector<float> warm = apply_bend_pins(out, {pin}, rest, maxRotationDeg);
    out = deform_arap_with_handles(drivers, driverMesh, handles, warm, maxRotationDeg);
  }
  return out;
}

/// `deform(pins, restMesh, solver, maxRotationDeg)`.
std::vector<float> deform(const std::vector<DeformPin>& pins, const RestMesh& rest, bool lbsSolver,
                          std::optional<double> maxRotationDeg) {
  bool hasBend = false;
  for (const DeformPin& p : pins) {
    if (p.kind == "bend") {
      hasBend = true;
      break;
    }
  }
  std::vector<DeformPin> drivers;
  std::vector<DeformPin> bends;
  if (hasBend) {
    for (const DeformPin& p : pins) (p.kind == "bend" ? bends : drivers).push_back(p);
  }
  if (!hasBend || drivers.empty()) return solve_deform(pins, rest, lbsSolver, maxRotationDeg);
  const RestMesh driverMesh = driver_rest_mesh(rest, bends);
  const std::vector<float> base = solve_deform(drivers, driverMesh, lbsSolver, maxRotationDeg);
  return lbsSolver ? apply_bend_pins(base, bends, rest, maxRotationDeg)
                   : apply_bend_pins_arap(base, drivers, bends, rest, driverMesh, maxRotationDeg);
}

std::optional<std::vector<float>> overlap_depth_field(const std::vector<DeformPin>& pins, const RestMesh& rest) {
  bool any = false;
  for (const DeformPin& p : pins) {
    if (p.overlap.value_or(0) != 0 && rest.col(p.id) != nullptr) {
      any = true;
      break;
    }
  }
  if (!any) return std::nullopt;
  const std::size_t n = rest.n();
  std::vector<float> depth(n, 0.0F);
  std::vector<float> total(n, 0.0F);
  for (const DeformPin& pin : pins) {
    const double o = pin.overlap.value_or(0);
    if (o == 0) continue;
    const auto* col = rest.col(pin.id);
    if (col == nullptr || col->size() < n) continue;
    const double extent = jmax(0.05, pin.overlapExtent.value_or(1));
    const double ex = 1 / extent;
    for (std::size_t i = 0; i < n; ++i) {
      const double w = (*col)[i];
      if (w <= 0) continue;
      const double wf = extent == 1 ? w : mjs::pow(w, ex);
      depth[i] = f32(static_cast<double>(depth[i]) + wf * o);
      total[i] = f32(static_cast<double>(total[i]) + wf);
    }
  }
  for (std::size_t i = 0; i < n; ++i) {
    if (static_cast<double>(total[i]) > 1e-12) depth[i] = f32(static_cast<double>(depth[i]) / static_cast<double>(total[i]));
  }
  return depth;
}

std::vector<std::uint16_t> sort_triangles_by_depth(const std::vector<std::uint16_t>& tris, const std::vector<float>& depth) {
  const std::size_t triCount = tris.size() / 3;
  std::vector<std::size_t> order(triCount);
  std::vector<double> key(triCount);
  for (std::size_t t = 0; t < triCount; ++t) {
    order[t] = t;
    key[t] = (static_cast<double>(depth[tris[t * 3]]) + static_cast<double>(depth[tris[t * 3 + 1]]) +
              static_cast<double>(depth[tris[t * 3 + 2]])) /
             3;
  }
  // `(key[a] - key[b]) || (a - b)`: a total order, so any sort gives the TS result.
  std::ranges::sort(order, [&key](std::size_t a, std::size_t b) {
    const double d = key[a] - key[b];
    if (d != 0 && !std::isnan(d)) return d < 0;
    return a < b;
  });
  std::vector<std::uint16_t> out(tris.size());
  for (std::size_t i = 0; i < triCount; ++i) {
    const std::size_t t = order[i];
    out[i * 3] = tris[t * 3];
    out[i * 3 + 1] = tris[t * 3 + 1];
    out[i * 3 + 2] = tris[t * 3 + 2];
  }
  return out;
}

/// resolveLivePins.
std::vector<DeformPin> resolve_live_pins(const std::vector<StoredPin>& pins, double t, const RigSampler& anim) {
  std::vector<DeformPin> out;
  out.reserve(pins.size());
  for (const StoredPin& pin : pins) {
    const bool bend = pin.kind == "bend";
    const bool stat = !bend && pin.position.has_value();
    DeformPin d;
    d.id = pin.id;
    d.x = stat ? (*pin.position)[0] : pin.x;
    d.y = stat ? (*pin.position)[1] : pin.y;
    if (!bend) {
      if (const auto live = anim.sampleData("puppet." + pin.id + ".position", t)) {
        if (live->is_array() && !live->arr().empty() && live->arr()[0].is_object() && live->arr()[0].has("x")) {
          d.x = jn(live->arr()[0].at("x"));
          d.y = jn(live->arr()[0].at("y"));
        }
      }
    }
    d.kind = pin.kind;
    const auto scalar = [&](const char* prop, std::optional<double> fb) {
      const auto v = anim.sample("puppet." + pin.id + "." + prop, t);
      return v ? v : fb;
    };
    d.rotation = scalar("rotation", pin.rotation);
    d.stiffness = scalar("stiffness", pin.stiffness);
    d.scale = scalar("scale", pin.scale);
    d.overlap = scalar("overlap", pin.overlap);
    d.overlapExtent = pin.overlapExtent;
    out.push_back(std::move(d));
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Skeleton (skeleton.ts, mat2d.ts, ik.ts, rigDeform.ts, geodesicWeights.ts …)
// ═══════════════════════════════════════════════════════════════════════════

using Mat2D = std::array<double, 6>;
constexpr Mat2D kIdentity = {1, 0, 0, 1, 0, 0};

Mat2D from_trs(double x, double y, double rotation, double scaleX, double scaleY) {
  const double c = mjs::cos(rotation);
  const double s = mjs::sin(rotation);
  return {c * scaleX, s * scaleX, -s * scaleY, c * scaleY, x, y};
}
Mat2D mul(const Mat2D& m1, const Mat2D& m2) {
  const auto [a1, b1, c1, d1, e1, f1] = m1;
  const auto [a2, b2, c2, d2, e2, f2] = m2;
  return {a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2, a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1};
}
V2 apply(const Mat2D& m, double x, double y) { return {m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]}; }
Mat2D invert(const Mat2D& m) {
  const auto [a, b, c, d, e, f] = m;
  const double det = a * d - b * c;
  if (std::abs(det) < 1e-12) return kIdentity;
  const double id = 1 / det;
  const double na = d * id;
  const double nb = -b * id;
  const double nc = -c * id;
  const double nd = a * id;
  return {na, nb, nc, nd, -(na * e + nc * f), -(nb * e + nd * f)};
}

struct Bone {
  std::string id;
  std::string parentId;  ///< "" = root (the TS truthiness test)
  double length = 0, x = 0, y = 0, rotation = 0;
  std::optional<double> scaleX, scaleY, influenceRadius;
};

Bone read_bone(const Json& b) {
  Bone o;
  o.id = jkey(b.at("id"));
  if (b.at("parentId").is_string()) o.parentId = b.at("parentId").str();
  o.length = jn(b.at("length"));
  o.x = jn(b.at("x"));
  o.y = jn(b.at("y"));
  o.rotation = jn(b.at("rotation"));
  o.scaleX = jopt(b.at("scaleX"));
  o.scaleY = jopt(b.at("scaleY"));
  o.influenceRadius = jopt(b.at("influenceRadius"));
  return o;
}

using WorldMap = std::unordered_map<std::string, Mat2D>;

/// computeWorldTransforms: parent-first, memoised; a cycle resolves to identity.
WorldMap compute_world(const std::vector<Bone>& bones) {
  std::unordered_map<std::string, const Bone*> byId;
  for (const Bone& b : bones) byId[b.id] = &b;
  WorldMap world;
  std::set<std::string> visiting;
  const auto resolve = [&](const auto& self, const std::string& id) -> Mat2D {
    if (const auto it = world.find(id); it != world.end()) return it->second;
    const auto bit = byId.find(id);
    if (bit == byId.end() || visiting.contains(id)) return kIdentity;
    const Bone& b = *bit->second;
    visiting.insert(id);
    const Mat2D local = from_trs(b.x, b.y, b.rotation, b.scaleX.value_or(1), b.scaleY.value_or(1));
    const Mat2D m = !b.parentId.empty() ? mul(self(self, b.parentId), local) : local;
    visiting.erase(id);
    world[id] = m;
    return m;
  };
  for (const Bone& b : bones) (void)resolve(resolve, b.id);
  return world;
}

V2 bone_tip(const Mat2D& w, double length) { return apply(w, length, 0); }
V2 bone_root(const Mat2D& w) { return apply(w, 0, 0); }

// ── ik.ts ──

struct TwoBone {
  double angle1, angle2;
};
TwoBone solve_two_bone(V2 root, double l1, double l2, V2 target, bool bendPositive) {
  const double dx = target.x - root.x;
  const double dy = target.y - root.y;
  const double rawDist = hypot2(dx, dy);
  const double reach = l1 + l2;
  const double minReach = std::abs(l1 - l2);
  const double dist = jmax(minReach + 1e-6, jmin(rawDist, reach - 1e-6));
  const double targetAngle = mjs::atan2(dy, dx);
  const double cosA1 = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist);
  const double a1 = mjs::acos(jmax(-1, jmin(1, cosA1)));
  const double cosA2 = (l1 * l1 + l2 * l2 - dist * dist) / (2 * l1 * l2);
  const double a2 = mjs::acos(jmax(-1, jmin(1, cosA2)));
  const double sign = bendPositive ? 1 : -1;
  const double angle1 = targetAngle - sign * a1;
  const double angle2 = angle1 + sign * (std::numbers::pi - a2);
  return {angle1, angle2};
}

V2 constrain(V2 point, V2 anchor, double len) {
  const double dx = point.x - anchor.x;
  const double dy = point.y - anchor.y;
  double d = hypot2(dx, dy);
  if (d == 0 || std::isnan(d)) d = 1e-9;  // `|| 1e-9`
  const double s = len / d;
  return {anchor.x + dx * s, anchor.y + dy * s};
}

std::vector<V2> solve_fabrik(const std::vector<V2>& joints, const std::vector<double>& lengths, V2 target) {
  constexpr int kIterations = 12;
  constexpr double kTolerance = 0.25;
  const std::size_t n = joints.size();
  std::vector<V2> p = joints;
  if (n < 2) return p;
  const V2 root = p[0];
  double total = 0;
  for (const double l : lengths) total = total + l;
  const double rootToTarget = hypot2(target.x - root.x, target.y - root.y);
  if (rootToTarget > total) {
    for (std::size_t i = 0; i + 1 < n; ++i) p[i + 1] = constrain(target, p[i], lengths[i]);
    return p;
  }
  for (int iter = 0; iter < kIterations; ++iter) {
    p[n - 1] = target;
    for (std::size_t i = n - 1; i-- > 0;) p[i] = constrain(p[i], p[i + 1], lengths[i]);
    p[0] = root;
    for (std::size_t i = 1; i < n; ++i) p[i] = constrain(p[i], p[i - 1], lengths[i - 1]);
    const V2 end = p[n - 1];
    if (hypot2(end.x - target.x, end.y - target.y) < kTolerance) break;
  }
  return p;
}

std::vector<double> angles_from_joints(const std::vector<V2>& joints) {
  std::vector<double> out;
  for (std::size_t i = 0; i + 1 < joints.size(); ++i) {
    out.push_back(mjs::atan2(joints[i + 1].y - joints[i].y, joints[i + 1].x - joints[i].x));
  }
  return out;
}

struct IkTarget {
  std::string boneId;
  double x = 0, y = 0;
  std::optional<double> chainLength;
  std::optional<V2> pole;
};

/// ikChainIds: the target bone and its ancestors, root-first. Indices into `bones` (last id wins).
std::vector<std::size_t> ik_chain(const std::vector<Bone>& bones, const std::string& targetBoneId, double chainLength) {
  std::unordered_map<std::string, std::size_t> byId;
  for (std::size_t i = 0; i < bones.size(); ++i) byId[bones[i].id] = i;
  const double maxD = jmax(1, jmin(8, std::floor(chainLength)));
  std::vector<std::size_t> chain;
  std::set<std::string> seen;
  auto cur = byId.find(targetBoneId);
  while (cur != byId.end() && static_cast<double>(chain.size()) < maxD && !seen.contains(bones[cur->second].id)) {
    const Bone& b = bones[cur->second];
    seen.insert(b.id);
    chain.insert(chain.begin(), cur->second);
    cur = !b.parentId.empty() ? byId.find(b.parentId) : byId.end();
  }
  return chain;
}

std::vector<Bone> apply_ik(const std::vector<Bone>& bones, const std::vector<IkTarget>& targets) {
  std::vector<Bone> out = bones;
  if (targets.empty() || out.empty()) return out;
  std::unordered_map<std::string, std::size_t> byId;
  for (std::size_t i = 0; i < out.size(); ++i) byId[out[i].id] = i;
  for (const IkTarget& t : targets) {
    const auto endIt = byId.find(t.boneId);
    if (endIt == byId.end()) continue;
    const std::vector<std::size_t> chain = ik_chain(out, t.boneId, t.chainLength.value_or(2));
    if (chain.empty()) continue;
    const Bone& end = out[endIt->second];
    const WorldMap world = compute_world(out);
    std::vector<V2> joints;
    for (const std::size_t ci : chain) joints.push_back(bone_root(world.at(out[ci].id)));
    joints.push_back(bone_tip(world.at(end.id), end.length));
    std::vector<double> lengths;
    bool degenerate = false;
    for (std::size_t i = 0; i + 1 < joints.size(); ++i) {
      const double l = hypot2(joints[i + 1].x - joints[i].x, joints[i + 1].y - joints[i].y);
      if (l < 1e-6) degenerate = true;
      lengths.push_back(l);
    }
    if (degenerate) continue;
    const V2 target{t.x, t.y};
    const std::vector<double> currentAngles = angles_from_joints(joints);
    std::vector<double> solved;
    if (chain.size() == 1) {
      solved = {mjs::atan2(target.y - joints[0].y, target.x - joints[0].x)};
    } else if (chain.size() == 2) {
      const V2 j0 = joints[0];
      const V2 j1 = joints[1];
      const V2 j2 = joints[2];
      bool bendPositive = false;
      if (t.pole) {
        const double ax = target.x - j0.x;
        const double ay = target.y - j0.y;
        bendPositive = ax * (t.pole->y - j0.y) - ay * (t.pole->x - j0.x) >= 0;
      } else {
        bendPositive = (j1.x - j0.x) * (j2.y - j1.y) - (j1.y - j0.y) * (j2.x - j1.x) >= 0;
      }
      const TwoBone sol = solve_two_bone(j0, lengths[0], lengths[1], target, bendPositive);
      solved = {sol.angle1, sol.angle2};
    } else {
      solved = angles_from_joints(solve_fabrik(joints, lengths, target));
    }
    double cumulative = 0;
    for (std::size_t i = 0; i < chain.size(); ++i) {
      const double delta = solved[i] - (currentAngles[i] + cumulative);
      out[chain[i]].rotation += delta;
      cumulative += delta;
    }
  }
  return out;
}

// ── skinning ──

struct VertexWeight {
  std::string boneId;
  double weight = 0;
};
struct Segment {
  std::string id;
  V2 a, b;
  std::optional<double> radius;
};

double distance_to_segment(V2 p, V2 a, V2 b) {
  const double abx = b.x - a.x;
  const double aby = b.y - a.y;
  const double len2 = abx * abx + aby * aby;
  if (len2 < 1e-12) return hypot2(p.x - a.x, p.y - a.y);
  double t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = jmax(0, jmin(1, t));
  return hypot2(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

std::vector<VertexWeight> normalize_weights(const std::vector<VertexWeight>& weights, std::size_t maxInfluences = 4,
                                            double epsilon = 1e-4) {
  std::vector<VertexWeight> kept;
  for (const VertexWeight& w : weights) {
    if (w.weight > epsilon) kept.push_back(w);
  }
  std::ranges::stable_sort(kept, [](const VertexWeight& a, const VertexWeight& b) { return b.weight - a.weight < 0; });
  if (kept.size() > maxInfluences) kept.resize(maxInfluences);
  double sum = 0;
  for (const VertexWeight& w : kept) sum = sum + w.weight;
  if (sum == 0) return {};
  for (VertexWeight& w : kept) w.weight = w.weight / sum;
  return kept;
}

struct EdgeGraph {
  std::vector<std::size_t> off;
  std::vector<std::size_t> nbrIdx;
  std::vector<double> nbrLen;
  double meanEdge = 0;
};

EdgeGraph build_edge_graph(const RestMesh& mesh) {
  const std::size_t n = mesh.n();
  std::unordered_map<std::uint64_t, std::size_t> seen;
  std::vector<std::pair<std::uint64_t, double>> edges;
  const auto addEdge = [&](std::uint32_t a, std::uint32_t b) {
    const std::uint64_t lo = std::min(a, b);
    const std::uint64_t hi = std::max(a, b);
    const std::uint64_t key = lo * n + hi;
    if (!seen.try_emplace(key, edges.size()).second) return;
    const double dx = static_cast<double>(mesh.v[lo * 4 + 0]) - static_cast<double>(mesh.v[hi * 4 + 0]);
    const double dy = static_cast<double>(mesh.v[lo * 4 + 1]) - static_cast<double>(mesh.v[hi * 4 + 1]);
    edges.emplace_back(key, hypot2(dx, dy));
  };
  for (std::size_t t = 0; t + 2 < mesh.tris.size(); t += 3) {
    const std::uint32_t a = mesh.tris[t];
    const std::uint32_t b = mesh.tris[t + 1];
    const std::uint32_t c = mesh.tris[t + 2];
    addEdge(a, b);
    addEdge(b, c);
    addEdge(a, c);
  }
  EdgeGraph g;
  std::vector<std::size_t> degree(n, 0);
  double lenSum = 0;
  for (const auto& [key, len] : edges) {
    const std::uint64_t lo = key / n;
    const std::uint64_t hi = key - lo * n;
    ++degree[lo];
    ++degree[hi];
    lenSum += len;
  }
  g.off.assign(n + 1, 0);
  for (std::size_t i = 0; i < n; ++i) g.off[i + 1] = g.off[i] + degree[i];
  g.nbrIdx.assign(g.off[n], 0);
  g.nbrLen.assign(g.off[n], 0);
  std::vector<std::size_t> cursor(g.off.begin(), g.off.begin() + static_cast<std::ptrdiff_t>(n));
  for (const auto& [key, len] : edges) {
    const std::uint64_t lo = key / n;
    const std::uint64_t hi = key - lo * n;
    g.nbrIdx[cursor[lo]] = hi;
    g.nbrLen[cursor[lo]] = len;
    ++cursor[lo];
    g.nbrIdx[cursor[hi]] = lo;
    g.nbrLen[cursor[hi]] = len;
    ++cursor[hi];
  }
  g.meanEdge = !edges.empty() ? lenSum / static_cast<double>(edges.size()) : 0;
  return g;
}

/// geodesicWeights.ts MinHeap — (dist, vertex) with the vertex id as tie-break.
class MinHeap {
 public:
  [[nodiscard]] std::size_t size() const noexcept { return d_.size(); }
  void push(double dist, std::size_t vert) {
    d_.push_back(dist);
    v_.push_back(vert);
    std::size_t i = d_.size() - 1;
    while (i > 0) {
      const std::size_t p = (i - 1) >> 1;
      if (d_[p] < d_[i] || (d_[p] == d_[i] && v_[p] <= v_[i])) break;
      std::swap(d_[p], d_[i]);
      std::swap(v_[p], v_[i]);
      i = p;
    }
  }
  std::pair<double, std::size_t> pop() {
    const std::pair<double, std::size_t> top{d_[0], v_[0]};
    const double ld = d_.back();
    const std::size_t lv = v_.back();
    d_.pop_back();
    v_.pop_back();
    if (!d_.empty()) {
      d_[0] = ld;
      v_[0] = lv;
      std::size_t i = 0;
      for (;;) {
        const std::size_t l = i * 2 + 1;
        const std::size_t r = l + 1;
        std::size_t m = i;
        if (l < d_.size() && (d_[l] < d_[m] || (d_[l] == d_[m] && v_[l] < v_[m]))) m = l;
        if (r < d_.size() && (d_[r] < d_[m] || (d_[r] == d_[m] && v_[r] < v_[m]))) m = r;
        if (m == i) break;
        std::swap(d_[m], d_[i]);
        std::swap(v_[m], v_[i]);
        i = m;
      }
    }
    return top;
  }

 private:
  std::vector<double> d_;
  std::vector<std::size_t> v_;
};

std::vector<double> geodesic_distance(const RestMesh& mesh, const EdgeGraph& g, const Segment& seg) {
  const std::size_t n = mesh.n();
  std::vector<double> dist(n, kInf);
  if (n == 0) return dist;
  double minD = kInf;
  std::vector<double> d0(n);
  for (std::size_t i = 0; i < n; ++i) {
    const double d = distance_to_segment({mesh.v[i * 4 + 0], mesh.v[i * 4 + 1]}, seg.a, seg.b);
    d0[i] = d;
    if (d < minD) minD = d;
  }
  const double band = minD + jmax(1.5 * g.meanEdge, 1e-6);
  MinHeap heap;
  for (std::size_t i = 0; i < n; ++i) {
    if (d0[i] <= band) {
      dist[i] = d0[i];
      heap.push(d0[i], i);
    }
  }
  while (heap.size() > 0) {
    const auto [d, i] = heap.pop();
    if (d > dist[i]) continue;
    for (std::size_t k = g.off[i]; k < g.off[i + 1]; ++k) {
      const std::size_t j = g.nbrIdx[k];
      const double nd = d + g.nbrLen[k];
      if (nd < dist[j]) {
        dist[j] = nd;
        heap.push(nd, j);
      }
    }
  }
  return dist;
}

constexpr double kReachFade = 0.25;

double reach_fade(double dist, std::optional<double> radius) {
  if (!radius || !std::isfinite(*radius) || *radius <= 0) return 1;
  if (dist >= *radius) return 0;
  const double inner = *radius * (1 - kReachFade);
  if (dist <= inner) return 1;
  const double s = (*radius - dist) / (*radius - inner);
  return s * s * (3 - 2 * s);
}

std::vector<VertexWeight> partition_weights(const std::vector<double>& distances, const std::vector<Segment>& segments, double band) {
  double dMin = kInf;
  for (const double d : distances) {
    if (d < dMin) dMin = d;
  }
  if (!std::isfinite(dMin)) return {};
  const double width = jmax(band, 1e-6);
  std::vector<VertexWeight> raw;
  for (std::size_t b = 0; b < segments.size(); ++b) {
    const double d = distances[b];
    if (!std::isfinite(d)) continue;
    const double t = (d - dMin) / width;
    if (t >= 1) continue;
    const double share = mjs::pow(1 - t, 3);
    const double fade = reach_fade(d, segments[b].radius);
    if (fade <= 0) continue;
    raw.push_back({segments[b].id, share * fade});
  }
  if (raw.empty()) return {};
  std::vector<VertexWeight> split = normalize_weights(raw);
  double bound = 0;
  for (const VertexWeight& w : raw) {
    if (w.weight > bound) bound = w.weight;
  }
  if (bound >= 1) return split;
  for (VertexWeight& w : split) w.weight = w.weight * bound;
  return split;
}

double seam_band(double meanEdge, const std::vector<Segment>& segments) {
  double lenSum = 0;
  for (const Segment& s : segments) lenSum += hypot2(s.b.x - s.a.x, s.b.y - s.a.y);
  const double meanBone = !segments.empty() ? lenSum / static_cast<double>(segments.size()) : 0;
  return jmax(jmax(1.5 * meanEdge, 0.18 * meanBone), 1e-6);
}

std::vector<std::vector<VertexWeight>> geodesic_auto_weights(const RestMesh& mesh, const std::vector<Segment>& segments) {
  const std::size_t n = mesh.n();
  const EdgeGraph g = build_edge_graph(mesh);
  std::vector<std::vector<double>> perBone;
  perBone.reserve(segments.size());
  for (const Segment& s : segments) perBone.push_back(geodesic_distance(mesh, g, s));
  const double band = seam_band(g.meanEdge, segments);
  std::vector<std::vector<VertexWeight>> out(n);
  std::vector<double> dist(segments.size());
  for (std::size_t i = 0; i < n; ++i) {
    for (std::size_t b = 0; b < segments.size(); ++b) dist[b] = perBone[b][i];
    out[i] = partition_weights(dist, segments, band);
  }
  return out;
}

/// applyWeightPaint (weightPaint.ts) for one vertex.
std::vector<VertexWeight> apply_weight_paint(const std::vector<VertexWeight>& autoW, std::size_t vertexIndex, const Json& bones) {
  std::vector<std::string> keys;
  for (const auto& mbr : bones.obj()) keys.push_back(mbr.key);
  std::vector<std::pair<std::string, double>> painted;
  const std::string vkey = std::to_string(vertexIndex);
  for (const std::string& boneId : js_key_order(keys)) {
    const Json& per = bones.at(boneId);
    if (!per.is_object()) continue;
    const Json* v = per.find(vkey);
    if (v == nullptr || v->is_undefined()) continue;
    const auto existing = std::ranges::find_if(painted, [&](const auto& p) { return p.first == boneId; });
    if (existing != painted.end()) existing->second = jn(*v);
    else painted.emplace_back(boneId, jn(*v));
  }
  if (painted.empty()) return autoW;
  double paintedTotal = 0;
  for (const auto& p : painted) paintedTotal = paintedTotal + p.second;
  std::vector<VertexWeight> merged;
  std::vector<VertexWeight> autoUnpainted;
  for (const VertexWeight& w : autoW) {
    if (std::ranges::none_of(painted, [&](const auto& p) { return p.first == w.boneId; })) autoUnpainted.push_back(w);
  }
  double autoRest = 0;
  for (const VertexWeight& w : autoUnpainted) autoRest = autoRest + w.weight;
  const double remaining = jmax(0, 1 - paintedTotal);
  for (const auto& [boneId, weight] : painted) merged.push_back({boneId, weight});
  if (autoRest > 1e-9 && remaining > 1e-9) {
    for (const VertexWeight& w : autoUnpainted) merged.push_back({w.boneId, (w.weight / autoRest) * remaining});
  }
  return normalize_weights(merged);
}

struct Skeleton {
  std::vector<Bone> bones;
  std::vector<Bone> bind;  ///< bindPoseBones(skel)
  std::vector<IkTarget> ikTargets;
  const Json* weightPaint = nullptr;
};

constexpr double kFullyBound = 1 - 1e-6;

std::vector<float> skin_rig_vertices(const std::vector<std::vector<VertexWeight>>& weights, const WorldMap& poseWorld,
                                     const WorldMap& bindInverse, const std::vector<float>& source) {
  const std::size_t numVerts = source.size() / 4;
  std::vector<float> out(source.size());
  static const std::vector<VertexWeight> kNone;
  for (std::size_t i = 0; i < numVerts; ++i) {
    const double vx = source[i * 4 + 0];
    const double vy = source[i * 4 + 1];
    const auto& ws = i < weights.size() ? weights[i] : kNone;
    double px = 0;
    double py = 0;
    double total = 0;
    for (const VertexWeight& w : ws) {
      if (w.weight == 0) continue;
      const auto pose = poseWorld.find(w.boneId);
      const auto bind = bindInverse.find(w.boneId);
      if (pose == poseWorld.end() || bind == bindInverse.end()) continue;
      const V2 p = apply(mul(pose->second, bind->second), vx, vy);
      px += p.x * w.weight;
      py += p.y * w.weight;
      total += w.weight;
    }
    double ox = vx;
    double oy = vy;
    if (total != 0) {
      if (total >= kFullyBound) {
        ox = px / total;
        oy = py / total;
      } else {
        const double rest = 1 - total;
        ox = px + rest * vx;
        oy = py + rest * vy;
      }
    }
    out[i * 4 + 0] = f32(ox);
    out[i * 4 + 1] = f32(oy);
    out[i * 4 + 2] = source[i * 4 + 2];
    out[i * 4 + 3] = source[i * 4 + 3];
  }
  return out;
}

Skeleton read_skeleton(const Json& skel) {
  Skeleton s;
  for (const Json& b : skel.at("bones").arr()) s.bones.push_back(read_bone(b));
  // bindPoseBones: structure from the live bone, pose channels from the stored bind.
  const Json& bind = skel.at("bindPose");
  if (bind.is_array() && !bind.arr().empty()) {
    std::unordered_map<std::string, const Json*> byId;
    for (const Json& b : bind.arr()) byId[jkey(b.at("id"))] = &b;
    for (const Bone& b : s.bones) {
      Bone o = b;
      if (const auto it = byId.find(b.id); it != byId.end()) {
        const Json& r = *it->second;
        o.x = jn(r.at("x"));
        o.y = jn(r.at("y"));
        o.rotation = jn(r.at("rotation"));
        if (!r.at("scaleX").is_undefined()) o.scaleX = jopt(r.at("scaleX"));
        if (!r.at("scaleY").is_undefined()) o.scaleY = jopt(r.at("scaleY"));
      }
      s.bind.push_back(std::move(o));
    }
  } else {
    s.bind = s.bones;
  }
  if (skel.at("weightPaint").is_object()) s.weightPaint = &skel.at("weightPaint");
  return s;
}

/// resolveActiveIkTargets (enabled targets, live positions/poles, IK mode applied).
std::vector<IkTarget> resolve_active_ik_targets(const Json& skel, double t, const RigSampler& anim) {
  std::vector<IkTarget> out;
  const Json& list = skel.at("ikTargets");
  if (!list.is_array()) return out;
  std::unordered_map<std::string, const Json*> byId;
  for (const Json& tg : list.arr()) byId[jkey(tg.at("boneId"))] = &tg;
  const auto num = [](const std::optional<double>& v) { return v && std::isfinite(*v); };
  for (const Json& tg : list.arr()) {
    if (tg.at("enabled").is_bool() && !tg.at("enabled").b()) continue;
    const std::string boneId = jkey(tg.at("boneId"));
    const auto liveX = anim.sample("ikTarget." + boneId + ".x", t);
    const auto liveY = anim.sample("ikTarget." + boneId + ".y", t);
    const auto poleX = anim.sample("ikPole." + boneId + ".x", t);
    const auto poleY = anim.sample("ikPole." + boneId + ".y", t);
    IkTarget r;
    r.boneId = boneId;
    r.x = num(liveX) ? *liveX : jn(tg.at("x"));
    r.y = num(liveY) ? *liveY : jn(tg.at("y"));
    r.chainLength = jopt(tg.at("chainLength"));
    const Json& storedPole = tg.at("pole");
    if (num(poleX) || num(poleY)) {
      r.pole = V2{num(poleX) ? *poleX : (storedPole.at("x").is_number() ? storedPole.at("x").num() : 0),
                  num(poleY) ? *poleY : (storedPole.at("y").is_number() ? storedPole.at("y").num() : 0)};
    } else if (storedPole.is_object()) {
      r.pole = V2{jn(storedPole.at("x")), jn(storedPole.at("y"))};
    }
    // chainModeOf: the track (thresholded at 0.5) wins over the stored mode ('ik' default).
    const Json* stored = byId.at(boneId);
    if (stored != nullptr) {
      const auto sampled = anim.sample("ikMode." + boneId, t);
      std::string mode;
      if (sampled && std::isfinite(*sampled)) mode = *sampled >= 0.5 ? "ik" : "fk";
      else if (stored->at("ikMode").is_string()) mode = stored->at("ikMode").str();
      else if (stored->at("ikMode").is_undefined() || stored->at("ikMode").is_null()) mode = "ik";
      if (mode != "ik") continue;
    }
    out.push_back(std::move(r));
  }
  return out;
}

/// resolveLiveBones.
std::vector<Bone> resolve_live_bones(const std::vector<Bone>& bones, double t, const RigSampler& anim) {
  std::vector<Bone> out;
  out.reserve(bones.size());
  for (const Bone& b : bones) {
    const auto numberOr = [&](const char* ch, double fb) {
      const auto v = anim.sample("bone." + b.id + "." + ch, t);
      return v && std::isfinite(*v) ? *v : fb;
    };
    Bone o = b;
    o.rotation = numberOr("rotation", b.rotation);
    o.x = numberOr("x", b.x);
    o.y = numberOr("y", b.y);
    o.scaleX = numberOr("scaleX", b.scaleX.value_or(1));
    o.scaleY = numberOr("scaleY", b.scaleY.value_or(1));
    out.push_back(std::move(o));
  }
  return out;
}

}  // namespace

bool rig_present(const Json& fx) {
  const Json& p = fx.at("puppet");
  const Json& s = fx.at("skeleton");
  return (p.is_object() && p.at("pins").is_array() && !p.at("pins").arr().empty()) ||
         (s.is_object() && s.at("bones").is_array() && !s.at("bones").arr().empty());
}

RigResult build_rig_mesh(const RigInputs& in, const RigSampler& anim) {
  RigResult res;
  const Json& fx = *in.fx;
  const Json& puppet = fx.at("puppet");
  const Json& skel = fx.at("skeleton");
  const bool hasPuppet = puppet.is_object() && puppet.at("pins").is_array() && !puppet.at("pins").arr().empty();
  const bool hasSkel = skel.is_object() && skel.at("bones").is_array() && !skel.at("bones").arr().empty();
  if (!hasPuppet && !hasSkel) return res;

  // The shared rest mesh: puppet settings win; a skeleton-only layer reads its own.
  MeshRig rig;
  const Json& meshSrc = hasPuppet ? puppet : skel;
  if (hasPuppet) {
    for (const Json& p : puppet.at("pins").arr()) rig.pins.push_back(read_pin(p));
  }
  rig.density = meshSrc.at("meshDensity");
  rig.expansion = meshSrc.at("meshExpansion");
  rig.silhouette = meshSrc.at("meshMode").is_string() && meshSrc.at("meshMode").str() == "silhouette";

  // `rig.meshDensity ?? 22` / `rig.meshExpansion ?? 0`: integer grid densities only
  // (a fractional density makes the TS index a typed array at fractional offsets).
  double density = 22;
  if (rig.density.is_number()) density = rig.density.num();
  else if (!rig.density.is_undefined() && !rig.density.is_null()) res.unported.emplace_back("non-numeric rig mesh density");
  double expansion = 0;
  if (rig.expansion.is_number()) expansion = rig.expansion.num();
  else if (!rig.expansion.is_undefined() && !rig.expansion.is_null()) res.unported.emplace_back("non-numeric rig mesh expansion");
  if (!res.unported.empty()) return res;
  const double gridD = jmax(2, jmin(50, density));
  const std::optional<int> cells = std::floor(gridD) == gridD ? std::optional<int>(static_cast<int>(gridD)) : std::nullopt;

  // silhouetteFromPathPoints → resolvePuppetSilhouette: a closed path of ≥ 3 points.
  std::optional<std::vector<V2>> silhouette;
  if (!in.pathOpen && in.pathPoints != nullptr && in.pathPoints->is_array() && in.pathPoints->arr().size() >= 3) {
    std::vector<V2> pts;
    for (const Json& p : in.pathPoints->arr()) pts.push_back({jn(p.at("x")), jn(p.at("y"))});
    silhouette = std::move(pts);
  }

  std::optional<RestMesh> built = build_rest_mesh(in.width, in.height, in.pad, rig, silhouette, cells, expansion);
  if (!built) {
    res.unported.emplace_back("fractional rig mesh density (grid mesh)");
    return res;
  }
  const RestMesh& rest = *built;
  std::vector<float> deformed = rest.v;
  std::optional<std::vector<float>> overlapDepth;

  if (hasPuppet) {
    const std::vector<DeformPin> live = resolve_live_pins(rig.pins, in.rigT, anim);
    const bool lbs = puppet.at("solver").is_string() && puppet.at("solver").str() == "lbs";
    const std::optional<double> maxRot = jopt(puppet.at("maxRotationDeg"));
    deformed = deform(live, rest, lbs, maxRot);
    overlapDepth = overlap_depth_field(live, rest);
  }

  if (hasSkel) {
    const Skeleton sk = read_skeleton(skel);
    const std::vector<Bone> animated = resolve_live_bones(sk.bones, in.rigT, anim);
    const std::vector<IkTarget> ik = resolve_active_ik_targets(skel, in.rigT, anim);
    const std::vector<Bone> posed = apply_ik(animated, ik);
    const WorldMap poseWorld = compute_world(posed);
    // getSkeletonBinding: bind to the rest pose, weights by geodesic partition (+ paint).
    const WorldMap bindWorld = compute_world(sk.bind);
    WorldMap bindInverse;
    for (const auto& [id, m] : bindWorld) bindInverse[id] = invert(m);
    std::vector<Segment> segments;
    for (const Bone& b : sk.bind) {
      const auto it = bindWorld.find(b.id);
      if (it == bindWorld.end()) continue;
      segments.push_back({b.id, bone_root(it->second), bone_tip(it->second, b.length), b.influenceRadius});
    }
    std::vector<std::vector<VertexWeight>> weights = geodesic_auto_weights(rest, segments);
    if (sk.weightPaint != nullptr) {
      const Json& vc = sk.weightPaint->at("vertexCount");
      const bool matches = vc.is_number() && vc.num() == static_cast<double>(rest.n());
      if (matches && sk.weightPaint->at("bones").is_object()) {
        for (std::size_t i = 0; i < weights.size(); ++i) weights[i] = apply_weight_paint(weights[i], i, sk.weightPaint->at("bones"));
      } else if (matches) {
        res.unported.emplace_back("skeleton weight paint without a bones map");
        return res;
      }
    }
    deformed = skin_rig_vertices(weights, poseWorld, bindInverse, deformed);
  }

  DeformedMeshData out;
  out.vertices = std::move(deformed);
  out.triangles = overlapDepth ? sort_triangles_by_depth(rest.tris, *overlapDepth) : rest.tris;
  out.depth = std::move(overlapDepth);
  res.mesh = std::move(out);
  return res;
}

}  // namespace premation::scene
