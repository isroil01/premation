#include "height_displacement.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <limits>
#include <unordered_map>

#include "jsmath.hpp"
#include "numconv.hpp"

namespace premation::scene {
namespace {

constexpr std::size_t S = kDisplaceStride;

/// Math.min(3, Math.max(0, Math.floor(times))) — NaN stays NaN (no passes).
double clamp_subdivisions(double times) {
  const double f = std::floor(times);
  if (std::isnan(f)) return f;
  return std::min(static_cast<double>(kMaxDisplacementSubdivisions), std::max(0.0, f));
}

/// Math.round: the closest integer, ties toward +∞ (exact for every double).
double js_round(double x) {
  if (!std::isfinite(x)) return x;
  const double r = std::floor(x);
  return x - r >= 0.5 ? r + 1 : r;
}

/// A rounded key component as the bits of its string form's identity:
/// ±0 → "0", every NaN → "NaN" (one canonical pattern), else the double itself.
std::uint64_t key_bits(double x) {
  if (x == 0) return 0;
  if (std::isnan(x)) return 0x7ff8000000000000ULL;
  return std::bit_cast<std::uint64_t>(x);
}

struct KeyHash {
  std::size_t operator()(const std::array<std::uint64_t, 6>& k) const noexcept {
    std::uint64_t h = 0xcbf29ce484222325ULL;
    for (const std::uint64_t v : k) {
      h ^= v;
      h *= 0x100000001b3ULL;
    }
    return static_cast<std::size_t>(h);
  }
};

}  // namespace

double sample_height(const HeightField& f, double u, double v) {
  const double fx = std::max(0.0, std::min(1.0, u)) * (static_cast<double>(f.width) - 1);
  const double fy = std::max(0.0, std::min(1.0, v)) * (static_cast<double>(f.height) - 1);
  const double x0 = std::floor(fx);
  const double y0 = std::floor(fy);
  const double x1 = std::min(static_cast<double>(f.width) - 1, x0 + 1);
  const double y1 = std::min(static_cast<double>(f.height) - 1, y0 + 1);
  const double tx = fx - x0;
  const double ty = fy - y0;
  const auto at = [&f](double x, double y) -> double {
    const auto i = static_cast<std::size_t>(y * static_cast<double>(f.width) + x);
    return i < f.data.size() ? static_cast<double>(f.data[i]) : std::numeric_limits<double>::quiet_NaN();
  };
  const double a = at(x0, y0);
  const double b = at(x1, y0);
  const double c = at(x0, y1);
  const double d = at(x1, y1);
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

DisplacedMesh subdivide_mesh(std::span<const float> vertices, std::span<const std::uint32_t> indices, double times) {
  DisplacedMesh out;
  out.vertices.assign(vertices.begin(), vertices.end());
  out.indices.assign(indices.begin(), indices.end());
  const double passes = clamp_subdivisions(times);
  for (int pass = 0; static_cast<double>(pass) < passes; ++pass) {  // NaN: no pass
    std::vector<float>& verts = out.vertices;
    const std::vector<std::uint32_t> idx = std::move(out.indices);
    const std::size_t count = verts.size() / S;
    auto next = static_cast<std::uint32_t>(count);
    std::unordered_map<std::uint64_t, std::uint32_t> midOf;
    midOf.reserve(idx.size());
    const auto mid = [&](std::uint32_t a, std::uint32_t b) -> std::uint32_t {
      const std::uint32_t lo = std::min(a, b);
      const std::uint32_t hi = std::max(a, b);
      const std::uint64_t k = (std::uint64_t{lo} << 32U) | hi;
      if (const auto it = midOf.find(k); it != midOf.end()) return it->second;
      const std::size_t oa = std::size_t{a} * S;
      const std::size_t ob = std::size_t{b} * S;
      for (std::size_t c = 0; c < S; ++c) {
        // (verts[a] + verts[b]) · 0.5 in double, stored once as float32.
        verts.push_back(static_cast<float>((static_cast<double>(verts[oa + c]) + static_cast<double>(verts[ob + c])) * 0.5));
      }
      midOf.emplace(k, next);
      return next++;
    };
    std::vector<std::uint32_t> nidx(idx.size() * 4, 0);
    for (std::size_t t = 0; t + 2 < idx.size(); t += 3) {
      const std::uint32_t a = idx[t];
      const std::uint32_t b = idx[t + 1];
      const std::uint32_t c = idx[t + 2];
      const std::uint32_t ab = mid(a, b);
      const std::uint32_t bc = mid(b, c);
      const std::uint32_t ca = mid(c, a);
      const std::size_t o = t * 4;
      nidx[o] = a;
      nidx[o + 1] = ab;
      nidx[o + 2] = ca;
      nidx[o + 3] = ab;
      nidx[o + 4] = b;
      nidx[o + 5] = bc;
      nidx[o + 6] = ca;
      nidx[o + 7] = bc;
      nidx[o + 8] = c;
      nidx[o + 9] = ab;
      nidx[o + 10] = bc;
      nidx[o + 11] = ca;
    }
    out.indices = std::move(nidx);
  }
  return out;
}

std::vector<std::int32_t> position_groups(std::span<const float> vertices) {
  const std::size_t count = vertices.size() / S;
  std::vector<std::int32_t> groups(count);
  std::unordered_map<std::array<std::uint64_t, 6>, std::int32_t, KeyHash> byPos;
  byPos.reserve(count);
  std::int32_t next = 0;
  for (std::size_t i = 0; i < count; ++i) {
    const std::size_t o = i * S;
    const auto r = [&](std::size_t c, double k) { return key_bits(js_round(static_cast<double>(vertices[o + c]) * k)); };
    const std::array<std::uint64_t, 6> key{r(0, 1e4), r(1, 1e4), r(2, 1e4), r(3, 100), r(4, 100), r(5, 100)};
    const auto [it, fresh] = byPos.try_emplace(key, next);
    if (fresh) ++next;
    groups[i] = it->second;
  }
  return groups;
}

void recompute_normals(std::span<float> vertices, std::span<const std::uint32_t> indices, std::span<const std::int32_t> groups) {
  const std::size_t count = vertices.size() / S;
  std::vector<std::int32_t> own;
  if (groups.empty()) {
    own = position_groups(vertices);
    groups = own;
  }
  std::vector<float> acc(count * 3, 0.0F);  // a Float32Array: every += rounds to float
  const auto v = [&](std::size_t i) { return static_cast<double>(vertices[i]); };
  for (std::size_t t = 0; t + 2 < indices.size(); t += 3) {
    const std::size_t a = std::size_t{indices[t]} * S;
    const std::size_t b = std::size_t{indices[t + 1]} * S;
    const std::size_t c = std::size_t{indices[t + 2]} * S;
    const double abx = v(b) - v(a);
    const double aby = v(b + 1) - v(a + 1);
    const double abz = v(b + 2) - v(a + 2);
    const double acx = v(c) - v(a);
    const double acy = v(c + 1) - v(a + 1);
    const double acz = v(c + 2) - v(a + 2);
    const double nx = aby * acz - abz * acy;
    const double ny = abz * acx - abx * acz;
    const double nz = abx * acy - aby * acx;
    for (const std::uint32_t vi : {indices[t], indices[t + 1], indices[t + 2]}) {
      const auto g = static_cast<std::size_t>(groups[vi]);
      acc[g * 3] = static_cast<float>(static_cast<double>(acc[g * 3]) + nx);
      acc[g * 3 + 1] = static_cast<float>(static_cast<double>(acc[g * 3 + 1]) + ny);
      acc[g * 3 + 2] = static_cast<float>(static_cast<double>(acc[g * 3 + 2]) + nz);
    }
  }
  for (std::size_t i = 0; i < count; ++i) {
    const auto g = static_cast<std::size_t>(groups[i]);
    const double x = acc[g * 3];
    const double y = acc[g * 3 + 1];
    const double z = acc[g * 3 + 2];
    const std::array<double, 3> xyz{x, y, z};
    const double len = motion::js::hypot(xyz);
    if (len <= 1e-12) continue;
    const std::size_t o = i * S + 3;
    // Keep the winding's sense: flip if the recomputed normal opposes the authored one.
    const double dot = x * v(o) + y * v(o + 1) + z * v(o + 2);
    const double s = (dot < 0 ? -1.0 : 1.0) / len;
    vertices[o] = static_cast<float>(x * s);
    vertices[o + 1] = static_cast<float>(y * s);
    vertices[o + 2] = static_cast<float>(z * s);
  }
}

DisplacedMesh displace_mesh(std::span<const float> vertices, std::span<const std::uint32_t> indices, const HeightField& field,
                            double amountPx, double subdivisions) {
  const double subs = clamp_subdivisions(subdivisions);
  DisplacedMesh sub = subdivide_mesh(vertices, indices, subs);
  std::vector<float>& v = sub.vertices;
  const std::size_t count = v.size() / S;
  // One height per POSITION (the mean over the vertices sharing it).
  const std::vector<std::int32_t> groups = position_groups(v);
  std::vector<double> sum(count, 0.0);
  std::vector<std::uint32_t> n(count, 0);
  for (std::size_t i = 0; i < count; ++i) {
    const std::size_t o = i * S;
    const auto g = static_cast<std::size_t>(groups[i]);
    sum[g] = sum[g] + sample_height(field, static_cast<double>(v[o + 6]), static_cast<double>(v[o + 7]));
    n[g] = n[g] + 1;
  }
  for (std::size_t i = 0; i < count; ++i) {
    const std::size_t o = i * S;
    const auto g = static_cast<std::size_t>(groups[i]);
    const double d = (sum[g] / static_cast<double>(n[g]) - 0.5) * amountPx;
    v[o] = static_cast<float>(static_cast<double>(v[o]) + static_cast<double>(v[o + 3]) * d);
    v[o + 1] = static_cast<float>(static_cast<double>(v[o + 1]) + static_cast<double>(v[o + 4]) * d);
    v[o + 2] = static_cast<float>(static_cast<double>(v[o + 2]) + static_cast<double>(v[o + 5]) * d);
  }
  recompute_normals(v, sub.indices, groups);
  sub.triangleScale = std::pow(4.0, subs);
  return sub;
}

std::string displaced_mesh_key(std::string_view meshKey, std::string_view fieldKey, double amountPx, double subdivisions) {
  std::string k(meshKey);
  k += "|disp:";
  k += fieldKey;
  k += ':';
  k += motion::js::to_fixed(amountPx, 3);
  k += ':';
  k += motion::js::number_to_string(subdivisions);
  return k;
}

}  // namespace premation::scene
