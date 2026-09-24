#include "primitive_mesh.hpp"

#include <array>
#include <bit>
#include <cmath>
#include <cstring>
#include <limits>

#include "jsmath.hpp"

namespace premation::scene {
namespace {

namespace mjs = motion::js;

constexpr double kTau = 3.141592653589793 * 2;  // Math.PI * 2
constexpr double kPi = 3.141592653589793;

/// segs(n, min, max = 512).
double segs(double n, double minV, double maxV = 512) {
  return std::max(minV, std::min(maxV, std::floor(std::isfinite(n) ? n : minV)));
}
double positive(double v, double fallback) { return std::isfinite(v) && v > 0 ? v : fallback; }
double non_negative(double v, double fallback) { return std::isfinite(v) && v >= 0 ? v : fallback; }

float f32(double v) { return static_cast<float>(v); }

/// pushRevolutionQuad.
void push_revolution_quad(std::vector<std::uint32_t>& out, std::uint32_t a, std::uint32_t b, std::uint32_t c, std::uint32_t d,
                          bool skipUpper, bool skipLower) {
  if (!skipUpper) out.insert(out.end(), {a, d, b});
  if (!skipLower) out.insert(out.end(), {b, d, c});
}

std::uint32_t u32(double v) { return static_cast<std::uint32_t>(v); }

}  // namespace

PrimitiveGeometry sphere_mesh(double radius, double widthSegments, double heightSegments) {
  const double r = positive(radius, 1);
  const double w = segs(widthSegments, 3);
  const double h = segs(heightSegments, 2);
  const auto cols = u32(w + 1);
  const auto rows = u32(h + 1);
  const std::size_t count = std::size_t{cols} * rows;
  PrimitiveGeometry g;
  g.positions.resize(count * 3);
  g.normals.resize(count * 3);
  g.uvs.resize(count * 2);
  for (std::uint32_t iy = 0; iy < rows; ++iy) {
    const double v = iy / h;
    const double theta = v * kPi;
    const double sinT = mjs::sin(theta);
    const double cosT = mjs::cos(theta);
    for (std::uint32_t ix = 0; ix < cols; ++ix) {
      const double u = ix / w;
      const double phi = u * kTau;
      const double nx = sinT * mjs::cos(phi);
      const double ny = 0 - cosT;
      const double nz = sinT * mjs::sin(phi);
      const std::size_t i = std::size_t{iy} * cols + ix;
      g.positions[i * 3] = f32(nx * r);
      g.positions[i * 3 + 1] = f32(ny * r);
      g.positions[i * 3 + 2] = f32(nz * r);
      g.normals[i * 3] = f32(nx);
      g.normals[i * 3 + 1] = f32(ny);
      g.normals[i * 3 + 2] = f32(nz);
      g.uvs[i * 2] = f32(u);
      g.uvs[i * 2 + 1] = f32(v);
    }
  }
  const auto W = u32(w);
  const auto H = u32(h);
  for (std::uint32_t iy = 0; iy < H; ++iy) {
    for (std::uint32_t ix = 0; ix < W; ++ix) {
      const std::uint32_t a = iy * cols + ix;
      push_revolution_quad(g.indices, a, a + 1, a + cols + 1, a + cols, iy == 0, iy == H - 1);
    }
  }
  return g;
}

PrimitiveGeometry cylinder_mesh(double radiusTop, double radiusBottom, double height, double radialSegments, bool capped) {
  const double rt = non_negative(radiusTop, 0);
  const double rb = non_negative(radiusBottom, 1);
  const double h = positive(height, 1);
  const double R = segs(radialSegments, 3);
  const auto Ru = u32(R);
  const std::uint32_t cols = Ru + 1;
  const double halfH = h / 2;
  const double dr = rb - rt;
  double slopeLen = mjs::hypot(std::array<double, 2>{h, dr});
  if (slopeLen == 0 || std::isnan(slopeLen)) slopeLen = 1;  // `|| 1`
  const double nRadial = h / slopeLen;
  const double nY = (0 - dr) / slopeLen;

  std::vector<double> pos;
  std::vector<double> nrm;
  std::vector<double> uv;
  PrimitiveGeometry g;
  const auto push_vertex = [&](double px, double py, double pz, double nx, double ny, double nz, double u, double v) {
    const auto i = static_cast<std::uint32_t>(pos.size() / 3);
    pos.insert(pos.end(), {px, py, pz});
    nrm.insert(nrm.end(), {nx, ny, nz});
    uv.insert(uv.end(), {u, v});
    return i;
  };

  for (int iy = 0; iy < 2; ++iy) {
    const double ringR = iy == 0 ? rt : rb;
    const double y = iy == 0 ? 0 - halfH : halfH;
    for (std::uint32_t ix = 0; ix < cols; ++ix) {
      const double u = ix / R;
      const double phi = u * kTau;
      const double cp = mjs::cos(phi);
      const double sp = mjs::sin(phi);
      (void)push_vertex(cp * ringR, y, sp * ringR, cp * nRadial, nY, sp * nRadial, u, iy);
    }
  }
  for (std::uint32_t ix = 0; ix < Ru; ++ix) {
    push_revolution_quad(g.indices, ix, ix + 1, ix + cols + 1, ix + cols, rt == 0, rb == 0);
  }
  if (capped) {
    for (int end = 0; end < 2; ++end) {
      const double ringR = end == 0 ? rt : rb;
      if (ringR <= 0) continue;
      const double y = end == 0 ? 0 - halfH : halfH;
      const double ny = end == 0 ? -1 : 1;
      const std::uint32_t centre = push_vertex(0, y, 0, 0, ny, 0, 0.5, 0.5);
      std::vector<std::uint32_t> ring;
      for (std::uint32_t ix = 0; ix < cols; ++ix) {
        const double phi = (ix / R) * kTau;
        const double cp = mjs::cos(phi);
        const double sp = mjs::sin(phi);
        ring.push_back(push_vertex(cp * ringR, y, sp * ringR, 0, ny, 0, 0.5 + cp * 0.5, 0.5 + sp * 0.5));
      }
      for (std::uint32_t ix = 0; ix < Ru; ++ix) {
        const std::uint32_t p0 = ring[ix];
        const std::uint32_t p1 = ring[ix + 1];
        if (end == 0) g.indices.insert(g.indices.end(), {centre, p0, p1});
        else g.indices.insert(g.indices.end(), {centre, p1, p0});
      }
    }
  }
  g.positions.reserve(pos.size());
  for (const double v : pos) g.positions.push_back(f32(v));
  for (const double v : nrm) g.normals.push_back(f32(v));
  for (const double v : uv) g.uvs.push_back(f32(v));
  return g;
}

PrimitiveGeometry torus_mesh(double radius, double tube, double radialSegments, double tubularSegments) {
  const double R = positive(radius, 1);
  const double t = positive(tube, R * 0.25);
  const double RS = segs(radialSegments, 3);
  const double TS = segs(tubularSegments, 3);
  const std::uint32_t cols = u32(RS) + 1;
  const std::uint32_t rows = u32(TS) + 1;
  const std::size_t count = std::size_t{cols} * rows;
  PrimitiveGeometry g;
  g.positions.resize(count * 3);
  g.normals.resize(count * 3);
  g.uvs.resize(count * 2);
  for (std::uint32_t j = 0; j < rows; ++j) {
    const double uu = j / TS;
    const double u = uu * kTau;
    const double cu = mjs::cos(u);
    const double su = mjs::sin(u);
    for (std::uint32_t i = 0; i < cols; ++i) {
      const double vv = i / RS;
      const double v = vv * kTau;
      const double cv = mjs::cos(v);
      const double sv = mjs::sin(v);
      const std::size_t k = std::size_t{j} * cols + i;
      g.positions[k * 3] = f32((R + t * cv) * cu);
      g.positions[k * 3 + 1] = f32((R + t * cv) * su);
      g.positions[k * 3 + 2] = f32(t * sv);
      g.normals[k * 3] = f32(cv * cu);
      g.normals[k * 3 + 1] = f32(cv * su);
      g.normals[k * 3 + 2] = f32(sv);
      g.uvs[k * 2] = f32(uu);
      g.uvs[k * 2 + 1] = f32(vv);
    }
  }
  for (std::uint32_t j = 0; j < u32(TS); ++j) {
    for (std::uint32_t i = 0; i < u32(RS); ++i) {
      const std::uint32_t a = j * cols + i;
      const std::uint32_t b = a + cols;
      const std::uint32_t d = a + 1;
      const std::uint32_t c = b + 1;
      g.indices.insert(g.indices.end(), {a, b, d, b, c, d});
    }
  }
  return g;
}

PrimitiveGeometry box_mesh(double width, double height, double depth) {
  const double hx = positive(width, 1) / 2;
  const double hy = positive(height, 1) / 2;
  const double hz = positive(depth, 1) / 2;
  struct Face {
    std::array<double, 3> o, t1, t2, n;
  };
  const std::array<Face, 6> faces{{
      {{hx, -hy, -hz}, {0, 2 * hy, 0}, {0, 0, 2 * hz}, {1, 0, 0}},
      {{-hx, -hy, -hz}, {0, 0, 2 * hz}, {0, 2 * hy, 0}, {-1, 0, 0}},
      {{-hx, hy, -hz}, {0, 0, 2 * hz}, {2 * hx, 0, 0}, {0, 1, 0}},
      {{-hx, -hy, -hz}, {2 * hx, 0, 0}, {0, 0, 2 * hz}, {0, -1, 0}},
      {{-hx, -hy, hz}, {2 * hx, 0, 0}, {0, 2 * hy, 0}, {0, 0, 1}},
      {{-hx, -hy, -hz}, {0, 2 * hy, 0}, {2 * hx, 0, 0}, {0, 0, -1}},
  }};
  constexpr std::array<std::array<double, 2>, 4> kCornerUv{{{0, 0}, {1, 0}, {1, 1}, {0, 1}}};
  PrimitiveGeometry g;
  g.positions.resize(24 * 3);
  g.normals.resize(24 * 3);
  g.uvs.resize(24 * 2);
  g.indices.resize(36);
  for (std::uint32_t fi = 0; fi < 6; ++fi) {
    const Face& f = faces.at(fi);
    const std::uint32_t base = fi * 4;
    for (std::uint32_t c = 0; c < 4; ++c) {
      const double a1 = c == 1 || c == 2 ? 1 : 0;
      const double a2 = c == 2 || c == 3 ? 1 : 0;
      const std::size_t i = base + c;
      for (std::size_t k = 0; k < 3; ++k) {
        g.positions[i * 3 + k] = f32(f.o.at(k) + f.t1.at(k) * a1 + f.t2.at(k) * a2);
        g.normals[i * 3 + k] = f32(f.n.at(k));
      }
      g.uvs[i * 2] = f32(kCornerUv.at(c)[0]);
      g.uvs[i * 2 + 1] = f32(kCornerUv.at(c)[1]);
    }
    const std::array<std::uint32_t, 6> tri{base, base + 1, base + 2, base, base + 2, base + 3};
    std::copy(tri.begin(), tri.end(), g.indices.begin() + static_cast<std::ptrdiff_t>(fi * 6));
  }
  return g;
}

PrimitiveGeometry capsule_mesh(double radius, double height, double radialSegments, double capSegments) {
  const double r = positive(radius, 1);
  const double h = non_negative(height, 0);
  const double R = segs(radialSegments, 3);
  const double C = segs(capSegments, 1);
  const std::uint32_t cols = u32(R) + 1;
  const std::uint32_t rows = 2 * (u32(C) + 1);
  const double halfH = h / 2;
  const std::size_t count = std::size_t{cols} * rows;
  PrimitiveGeometry g;
  g.positions.resize(count * 3);
  g.normals.resize(count * 3);
  g.uvs.resize(count * 2);
  for (std::uint32_t iy = 0; iy < rows; ++iy) {
    const bool top = iy <= u32(C);
    const double step = top ? iy : iy - (C + 1);
    const double theta = top ? (step / C) * (kPi / 2) : kPi / 2 + (step / C) * (kPi / 2);
    const double sinT = mjs::sin(theta);
    const double cosT = mjs::cos(theta);
    const double centreY = top ? 0 - halfH : halfH;
    for (std::uint32_t ix = 0; ix < cols; ++ix) {
      const double u = ix / R;
      const double phi = u * kTau;
      const double nx = sinT * mjs::cos(phi);
      const double ny = 0 - cosT;
      const double nz = sinT * mjs::sin(phi);
      const std::size_t i = std::size_t{iy} * cols + ix;
      g.positions[i * 3] = f32(nx * r);
      g.positions[i * 3 + 1] = f32(centreY + ny * r);
      g.positions[i * 3 + 2] = f32(nz * r);
      g.normals[i * 3] = f32(nx);
      g.normals[i * 3 + 1] = f32(ny);
      g.normals[i * 3 + 2] = f32(nz);
      g.uvs[i * 2] = f32(u);
      g.uvs[i * 2 + 1] = f32(static_cast<double>(iy) / (rows - 1));
    }
  }
  for (std::uint32_t iy = 0; iy + 1 < rows; ++iy) {
    for (std::uint32_t ix = 0; ix < u32(R); ++ix) {
      const std::uint32_t a = iy * cols + ix;
      push_revolution_quad(g.indices, a, a + 1, a + cols + 1, a + cols, iy == 0, iy == rows - 2);
    }
  }
  return g;
}

namespace {

/// `prim:<type>:a:b:…` → the numbers; nullopt when any field is not a number.
std::optional<std::vector<double>> fields(std::string_view rest) {
  std::vector<double> out;
  while (true) {
    const std::size_t cut = rest.find(':');
    const std::string part(rest.substr(0, cut));
    if (part.empty()) return std::nullopt;
    char* end = nullptr;
    const double v = std::strtod(part.c_str(), &end);
    if (end != part.c_str() + part.size()) return std::nullopt;
    out.push_back(v);
    if (cut == std::string_view::npos) break;
    rest.remove_prefix(cut + 1);
  }
  return out;
}

}  // namespace

std::optional<PrimitiveMesh> primitive_mesh_for_key(std::string_view key) {
  if (!key.starts_with("prim:")) return std::nullopt;
  std::string_view rest = key.substr(5);
  const std::size_t colon = rest.find(':');
  if (colon == std::string_view::npos) return std::nullopt;
  const std::string_view type = rest.substr(0, colon);
  const std::optional<std::vector<double>> f = fields(rest.substr(colon + 1));
  if (!f) return std::nullopt;
  const auto& a = *f;
  PrimitiveGeometry geo;
  bool doubleSided = false;
  // primitiveGeometry(spec), with each parameter as primitiveKey wrote it.
  if (type == "sphere" && a.size() == 3) {
    geo = sphere_mesh(a[0], a[1], a[2]);
  } else if (type == "cyl" && a.size() == 5) {
    geo = cylinder_mesh(a[0], a[1], a[2], a[3], a[4] != 0);
    doubleSided = a[4] == 0;
  } else if (type == "cone" && a.size() == 4) {
    geo = cylinder_mesh(0, a[0], a[1], a[2], a[3] != 0);
    doubleSided = a[3] == 0;
  } else if (type == "torus" && a.size() == 4) {
    geo = torus_mesh(a[0], a[1], a[2], a[3]);
  } else if (type == "capsule" && a.size() == 4) {
    geo = capsule_mesh(a[0], std::max(0.0, a[1] - 2 * a[0]), a[2], a[3]);
  } else if (type == "box" && a.size() == 3) {
    geo = box_mesh(a[0], a[1], a[2]);
  } else {
    return std::nullopt;
  }
  PrimitiveMesh m;
  m.key = std::string(key);
  m.doubleSided = doubleSided;
  const std::size_t vcount = geo.positions.size() / 3;
  m.vertices.resize(vcount * 8);
  for (std::size_t i = 0; i < vcount; ++i) {
    const std::size_t o = i * 8;
    m.vertices[o] = geo.positions[i * 3];
    m.vertices[o + 1] = geo.positions[i * 3 + 1];
    m.vertices[o + 2] = geo.positions[i * 3 + 2];
    m.vertices[o + 3] = geo.normals[i * 3];
    m.vertices[o + 4] = geo.normals[i * 3 + 1];
    m.vertices[o + 5] = geo.normals[i * 3 + 2];
    m.vertices[o + 6] = geo.uvs[i * 2];
    m.vertices[o + 7] = geo.uvs[i * 2 + 1];
  }
  m.indices = std::move(geo.indices);
  m.index16 = vcount <= 0xFFFF;
  return m;
}

void primitive_mesh_to_api(const PrimitiveMesh& m, api::RenderExtrudedMesh& out) {
  static_assert(std::endian::native == std::endian::little, "FrameScene mesh bytes are little-endian");
  out.key = m.key;
  out.vertices.resize(m.vertices.size() * sizeof(float));
  std::memcpy(out.vertices.data(), m.vertices.data(), out.vertices.size());
  if (m.index16) {
    out.index_format = api::RenderIndexFormat::uint16;
    out.indices.resize(m.indices.size() * sizeof(std::uint16_t));
    for (std::size_t i = 0; i < m.indices.size(); ++i) {
      const auto v = static_cast<std::uint16_t>(m.indices[i]);
      std::memcpy(out.indices.data() + (i * 2), &v, 2);
    }
  } else {
    out.index_format = api::RenderIndexFormat::uint32;
    out.indices.resize(m.indices.size() * sizeof(std::uint32_t));
    std::memcpy(out.indices.data(), m.indices.data(), out.indices.size());
  }
  out.ranges.clear();
  api::RenderMeshRange r;
  r.role = m.doubleSided ? api::RenderMeshRole::front : api::RenderMeshRole::side;
  r.first = 0;
  r.count = static_cast<std::uint32_t>(m.indices.size());
  out.ranges.push_back(std::move(r));
}

}  // namespace premation::scene
