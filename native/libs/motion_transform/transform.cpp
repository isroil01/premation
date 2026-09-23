// motion_transform — see transform.hpp. Each function names the TypeScript it
// mirrors; the arithmetic is transcribed in the same order (JavaScript
// evaluates `a * b * c` as `(a * b) * c` and so does C++), and every
// transcendental goes through motion_jsmath.

#include "transform.hpp"

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <utility>
#include <span>
#include <vector>

#include "jsmath.hpp"

namespace motion::xf {
namespace {

namespace js = motion::js;

double hypot2(double a, double b) noexcept {
  const std::array<double, 2> v{a, b};
  return js::hypot(v);
}
double hypot3(double a, double b, double c) noexcept {
  const std::array<double, 3> v{a, b, c};
  return js::hypot(v);
}
double js_max(double a, double b) noexcept {
  const std::array<double, 2> v{a, b};
  return js::max_of(v);
}
double js_min(double a, double b) noexcept {
  const std::array<double, 2> v{a, b};
  return js::min_of(v);
}
bool finite(double d) noexcept { return d - d == 0; }

}  // namespace

// ── matrix.ts ───────────────────────────────────────────────────────────────

Mat2D multiply(const Mat2D& m, const Mat2D& n) noexcept {
  return {.a = m.a * n.a + m.c * n.b,
          .b = m.b * n.a + m.d * n.b,
          .c = m.a * n.c + m.c * n.d,
          .d = m.b * n.c + m.d * n.d,
          .e = m.a * n.e + m.c * n.f + m.e,
          .f = m.b * n.e + m.d * n.f + m.f};
}

Vec2 transform_point(const Mat2D& m, Vec2 p) noexcept {
  return {m.a * p.x + m.c * p.y + m.e, m.b * p.x + m.d * p.y + m.f};
}

Mat2D invert(const Mat2D& m) noexcept {
  const double det = m.a * m.d - m.b * m.c;
  if (det == 0 || !finite(det)) return {};
  const double id = 1 / det;
  return {.a = m.d * id,
          .b = -m.b * id,
          .c = -m.c * id,
          .d = m.a * id,
          .e = (m.c * m.f - m.d * m.e) * id,
          .f = (m.b * m.e - m.a * m.f) * id};
}

Mat2D compose(const Parts2D& t) noexcept {
  const double cos = js::cos(t.rotation);
  const double sin = js::sin(t.rotation);
  const double sx = t.scale.x;
  const double sy = t.scale.y;
  const double tan_x = js::tan(t.skew.x);
  const double tan_y = js::tan(t.skew.y);
  const double ra = cos;
  const double rb = sin;
  const double rc = -sin;
  const double rd = cos;
  const double ka = 1 * sx;
  const double kb = tan_y * sx;
  const double kc = tan_x * sy;
  const double kd = 1 * sy;
  const double a = ra * ka + rc * kb;
  const double b = rb * ka + rd * kb;
  const double c = ra * kc + rc * kd;
  const double d = rb * kc + rd * kd;
  return {.a = a,
          .b = b,
          .c = c,
          .d = d,
          .e = t.position.x - (a * t.anchor.x + c * t.anchor.y),
          .f = t.position.y - (b * t.anchor.x + d * t.anchor.y)};
}

Decomposed2D decompose(const Mat2D& m) noexcept {
  const double scale_x = hypot2(m.a, m.b);
  const double rotation = js::atan2(m.b, m.a);
  const double cos = js::cos(rotation);
  const double sin = js::sin(rotation);
  const double scale_y = m.d * cos - m.c * sin;
  return {.position = {m.e, m.f}, .rotation = rotation, .scale = {scale_x, scale_y}};
}

// ── matrix4.ts ──────────────────────────────────────────────────────────────

Mat4 multiply(const Mat4& a, const Mat4& b) noexcept {
  Mat4 out{};
  for (std::size_t c = 0; c < 4; ++c) {
    const std::size_t k = c * 4;
    for (std::size_t r = 0; r < 4; ++r) {
      out[k + r] = a[r] * b[k] + a[4 + r] * b[k + 1] + a[8 + r] * b[k + 2] + a[12 + r] * b[k + 3];
    }
  }
  return out;
}

Vec3 transform_point(const Mat4& m, Vec3 p) noexcept {
  const double x = m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12];
  const double y = m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13];
  const double z = m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14];
  const double w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
  if (w != 0 && w != 1) return {x / w, y / w, z / w};
  return {x, y, z};
}

std::optional<Mat4> invert(const Mat4& m) noexcept {
  Mat4 out{};
  const bool affine = m[3] == 0 && m[7] == 0 && m[11] == 0 && m[15] == 1;
  if (affine) {
    const double a = m[0], b = m[1], c = m[2];
    const double d = m[4], e = m[5], f = m[6];
    const double g = m[8], h = m[9], i = m[10];
    const double A = e * i - f * h;
    const double B = f * g - d * i;
    const double C = d * h - e * g;
    const double det = a * A + b * B + c * C;
    if (det == 0 || !finite(det)) return std::nullopt;  // `!det` is also true for NaN
    const double inv = 1 / det;
    const double i0 = A * inv;
    const double i1 = (c * h - b * i) * inv;
    const double i2 = (b * f - c * e) * inv;
    const double i4 = B * inv;
    const double i5 = (a * i - c * g) * inv;
    const double i6 = (c * d - a * f) * inv;
    const double i8 = C * inv;
    const double i9 = (b * g - a * h) * inv;
    const double i10 = (a * e - b * d) * inv;
    const double tx = m[12], ty = m[13], tz = m[14];
    out = {i0, i1, i2, 0, i4, i5, i6, 0, i8, i9, i10, 0,
           -(i0 * tx + i4 * ty + i8 * tz) + 0,  // + 0 turns -0 into +0
           -(i1 * tx + i5 * ty + i9 * tz) + 0,
           -(i2 * tx + i6 * ty + i10 * tz) + 0,
           1};
    return out;
  }
  const double n0 = m[0], n1 = m[1], n2 = m[2], n3 = m[3], n4 = m[4], n5 = m[5], n6 = m[6], n7 = m[7];
  const double n8 = m[8], n9 = m[9], n10 = m[10], n11 = m[11], n12 = m[12], n13 = m[13], n14 = m[14], n15 = m[15];
  const double s0 = n0 * n5 - n1 * n4;
  const double s1 = n0 * n6 - n2 * n4;
  const double s2 = n0 * n7 - n3 * n4;
  const double s3 = n1 * n6 - n2 * n5;
  const double s4 = n1 * n7 - n3 * n5;
  const double s5 = n2 * n7 - n3 * n6;
  const double c5 = n10 * n15 - n11 * n14;
  const double c4 = n9 * n15 - n11 * n13;
  const double c3 = n9 * n14 - n10 * n13;
  const double c2 = n8 * n15 - n11 * n12;
  const double c1 = n8 * n14 - n10 * n12;
  const double c0 = n8 * n13 - n9 * n12;
  const double det = s0 * c5 - s1 * c4 + s2 * c3 + s3 * c2 - s4 * c1 + s5 * c0;
  if (det == 0 || !finite(det)) return std::nullopt;
  const double v = 1 / det;
  out[0] = (n5 * c5 - n6 * c4 + n7 * c3) * v;
  out[1] = (-n1 * c5 + n2 * c4 - n3 * c3) * v;
  out[2] = (n13 * s5 - n14 * s4 + n15 * s3) * v;
  out[3] = (-n9 * s5 + n10 * s4 - n11 * s3) * v;
  out[4] = (-n4 * c5 + n6 * c2 - n7 * c1) * v;
  out[5] = (n0 * c5 - n2 * c2 + n3 * c1) * v;
  out[6] = (-n12 * s5 + n14 * s2 - n15 * s1) * v;
  out[7] = (n8 * s5 - n10 * s2 + n11 * s1) * v;
  out[8] = (n4 * c4 - n5 * c2 + n7 * c0) * v;
  out[9] = (-n0 * c4 + n1 * c2 - n3 * c0) * v;
  out[10] = (n12 * s4 - n13 * s2 + n15 * s0) * v;
  out[11] = (-n8 * s4 + n9 * s2 - n11 * s0) * v;
  out[12] = (-n4 * c3 + n5 * c1 - n6 * c0) * v;
  out[13] = (n0 * c3 - n1 * c1 + n2 * c0) * v;
  out[14] = (-n12 * s3 + n13 * s1 - n14 * s0) * v;
  out[15] = (n8 * s3 - n9 * s1 + n10 * s0) * v;
  return out;
}

Vec3 transform_vector(const Mat4& m, Vec3 v) noexcept {
  const double x = m[0] * v.x + m[4] * v.y + m[8] * v.z;
  const double y = m[1] * v.x + m[5] * v.y + m[9] * v.z;
  const double z = m[2] * v.x + m[6] * v.y + m[10] * v.z;
  double len = hypot3(x, y, z);
  if (len == 0 || std::isnan(len)) len = 1;  // `|| 1`
  return {x / len, y / len, z / len};
}

Mat4 compose(const Parts3D& t) noexcept {
  const double cx = js::cos(t.rotation.x), sx = js::sin(t.rotation.x);
  const double cy = js::cos(t.rotation.y), sy = js::sin(t.rotation.y);
  const double cz = js::cos(t.rotation.z), sz = js::sin(t.rotation.z);
  const double r00 = cz * cy;
  const double r01 = cz * sy * sx - sz * cx;
  const double r02 = cz * sy * cx + sz * sx;
  const double r10 = sz * cy;
  const double r11 = sz * sy * sx + cz * cx;
  const double r12 = sz * sy * cx - cz * sx;
  const double r20 = -sy;
  const double r21 = cy * sx;
  const double r22 = cy * cx;
  const double kx = t.scale.x, ky = t.scale.y, kz = t.scale.z;
  const double l00 = r00 * kx, l01 = r01 * ky, l02 = r02 * kz;
  const double l10 = r10 * kx, l11 = r11 * ky, l12 = r12 * kz;
  const double l20 = r20 * kx, l21 = r21 * ky, l22 = r22 * kz;
  const double ax = t.anchor.x, ay = t.anchor.y, az = t.anchor.z;
  return {l00, l10, l20, 0, l01, l11, l21, 0, l02, l12, l22, 0,
          t.position.x - (l00 * ax + l01 * ay + l02 * az),
          t.position.y - (l10 * ax + l11 * ay + l12 * az),
          t.position.z - (l20 * ax + l21 * ay + l22 * az),
          1};
}

Mat4 from_mat2d(const Mat2D& m) noexcept { return {m.a, m.b, 0, 0, m.c, m.d, 0, 0, 0, 0, 1, 0, m.e, m.f, 0, 1}; }

Mat2D to_mat2d(const Mat4& m) noexcept { return {.a = m[0], .b = m[1], .c = m[4], .d = m[5], .e = m[12], .f = m[13]}; }

// ── worldTransform.ts ───────────────────────────────────────────────────────

Mat2D local_matrix(const Local2D& l) noexcept {
  return compose(Parts2D{.position = {l.x, l.y},
                         .rotation = l.rotation * kDeg,
                         .scale = {l.scale_x, l.scale_y},
                         .skew = {0, 0},
                         .anchor = {0, 0}});
}

Local2D matrix_to_local(const Mat2D& m) noexcept {
  const Decomposed2D d = decompose(m);
  return {.x = d.position.x, .y = d.position.y, .rotation = d.rotation / kDeg, .scale_x = d.scale.x, .scale_y = d.scale.y};
}

Local2D local_under_parent(const Mat2D& child_world, const Mat2D& parent_world) noexcept {
  return matrix_to_local(multiply(invert(parent_world), child_world));
}

bool world_matrices_2d(std::span<const Node2D> nodes, std::span<Mat2D> out) {
  const std::size_t n = nodes.size();
  if (out.size() < n) return false;
  // 0 = not yet, 1 = on the current walk, 2 = done.
  std::vector<std::uint8_t> state(n, 0);
  std::vector<std::size_t> path;
  for (std::size_t start = 0; start < n; ++start) {
    if (state[start] == 2) continue;
    // Walk up to a finished ancestor (or a root), then fill top-down: the
    // TypeScript's recursion `multiply(worldMatrixOf(parent), local)` unrolled.
    path.clear();
    std::size_t i = start;
    for (;;) {
      if (state[i] == 1) return false;  // cycle
      state[i] = 1;
      path.push_back(i);
      const std::int32_t p = nodes[i].parent;
      if (p < 0) break;
      if (std::cmp_greater_equal(p, n)) return false;
      if (state[static_cast<std::size_t>(p)] == 2) break;
      i = static_cast<std::size_t>(p);
    }
    for (std::size_t k = path.size(); k-- > 0;) {
      const std::size_t id = path[k];
      const Node2D& node = nodes[id];
      const Mat2D lm = node.local ? local_matrix(*node.local) : Mat2D{};
      out[id] = node.parent >= 0 ? multiply(out[static_cast<std::size_t>(node.parent)], lm) : lm;
      state[id] = 2;
    }
  }
  return true;
}

// ── nodeMatrix.ts ───────────────────────────────────────────────────────────

Mat4 compose_node_3d(const Node3DTransform& v) noexcept {
  return compose(Parts3D{.position = {v.x, v.y, v.z},
                         .rotation = {(v.rotation_x + v.orientation_x) * kDeg,
                                      (v.rotation_y + v.orientation_y) * kDeg,
                                      (v.rotation_z + v.orientation_z) * kDeg},
                         .scale = {v.scale_x, v.scale_y, v.scale_z},
                         .anchor = {v.anchor_x, v.anchor_y, v.anchor_z}});
}

std::optional<Mat4> parent_world_3d(std::span<const Node3D> nodes, std::size_t i) {
  const std::size_t n = nodes.size();
  if (i >= n) return std::nullopt;
  const std::int32_t parent = nodes[i].parent;
  if (parent < 0 || std::cmp_greater_equal(parent, n)) return std::nullopt;
  std::vector<bool> seen(n, false);
  seen[i] = true;
  bool any_3d = false;
  std::vector<std::size_t> chain;
  for (std::int32_t id = parent; id >= 0 && std::cmp_less(id, n) && !seen[static_cast<std::size_t>(id)];
       id = nodes[static_cast<std::size_t>(id)].parent) {
    const auto u = static_cast<std::size_t>(id);
    seen[u] = true;
    chain.push_back(u);
    if (nodes[u].is_3d) any_3d = true;
  }
  if (!any_3d) return std::nullopt;
  std::optional<Mat4> acc;
  for (std::size_t k = chain.size(); k-- > 0;) {
    const Node3D& node = nodes[chain[k]];
    if (!node.is_3d) {
      acc = from_mat2d(node.world2d);
      continue;
    }
    if (!node.local3d) continue;
    const Mat4 own = compose_node_3d(*node.local3d);
    acc = acc ? multiply(*acc, own) : own;
  }
  return acc;
}

// ── project3d.ts ────────────────────────────────────────────────────────────

double focal_length_for_fov(double width, double fov_deg) noexcept {
  const double fov = js_max(1, js_min(179, fov_deg)) * kDeg;
  return width / 2 / js::tan(fov / 2);
}

double fov_for_focal_length(double width, double focal_length) noexcept {
  return (2 * js::atan(width / 2 / js_max(1e-6, focal_length)) * 180) / std::numbers::pi;
}

Camera default_camera(double width, double height, double fov_deg) noexcept {
  const double f = focal_length_for_fov(width, fov_deg);
  return {.position = {width / 2, height / 2, -f}, .focal_length = f, .principal = {width / 2, height / 2}, .orientation = std::nullopt};
}

Projected project_point(Vec3 p, const Camera& cam) noexcept {
  const double yaw = cam.orientation ? cam.orientation->yaw : 0;
  const double pitch = cam.orientation ? cam.orientation->pitch : 0;
  const double roll = cam.orientation ? cam.orientation->roll.value_or(0) : 0;
  if (yaw != 0 || pitch != 0 || roll != 0) {
    double vx = p.x - cam.position.x;
    double vy = p.y - cam.position.y;
    double vz = p.z - cam.position.z;
    const double cy = js::cos(-yaw * kDeg);
    const double sy = js::sin(-yaw * kDeg);
    const double x1 = cy * vx + sy * vz;
    const double z1 = -sy * vx + cy * vz;
    vx = x1;
    vz = z1;
    const double cx = js::cos(-pitch * kDeg);
    const double sx = js::sin(-pitch * kDeg);
    const double y1 = cx * vy - sx * vz;
    const double z2 = sx * vy + cx * vz;
    vy = y1;
    vz = z2;
    if (roll != 0) {
      const double cz = js::cos(-roll * kDeg);
      const double sz = js::sin(-roll * kDeg);
      const double rx = cz * vx - sz * vy;
      vy = sz * vx + cz * vy;
      vx = rx;
    }
    const double clamped = vz < kPerspectiveNear ? kPerspectiveNear : vz;
    const double scale = cam.focal_length / clamped;
    return {.x = cam.principal.x + vx * scale,
            .y = cam.principal.y + vy * scale,
            .scale = scale,
            .depth = clamped,
            .clipped = vz < kPerspectiveNear};
  }
  const double dist = p.z - cam.position.z;
  const double clamped = dist < kPerspectiveNear ? kPerspectiveNear : dist;
  const double scale = cam.focal_length / clamped;
  return {.x = cam.principal.x + (p.x - cam.position.x) * scale,
          .y = cam.principal.y + (p.y - cam.position.y) * scale,
          .scale = scale,
          .depth = clamped,
          .clipped = dist < kPerspectiveNear};
}

Mat4 camera_view_matrix(const Camera& cam) noexcept {
  const double yaw = (cam.orientation ? cam.orientation->yaw : 0) * kDeg;
  const double pitch = (cam.orientation ? cam.orientation->pitch : 0) * kDeg;
  const double cy = js::cos(-yaw), sy = js::sin(-yaw);
  const double cx = js::cos(-pitch), sx = js::sin(-pitch);
  double r00 = cy, r01 = 0, r02 = sy;
  double r10 = -sx * -sy, r11 = cx, r12 = -sx * cy;
  const double r20 = cx * -sy, r21 = sx, r22 = cx * cy;
  const double roll = (cam.orientation ? cam.orientation->roll.value_or(0) : 0) * kDeg;
  if (roll != 0) {
    const double cz = js::cos(-roll);
    const double sz = js::sin(-roll);
    const double n00 = cz * r00 - sz * r10, n01 = cz * r01 - sz * r11, n02 = cz * r02 - sz * r12;
    const double n10 = sz * r00 + cz * r10, n11 = sz * r01 + cz * r11, n12 = sz * r02 + cz * r12;
    r00 = n00;
    r01 = n01;
    r02 = n02;
    r10 = n10;
    r11 = n11;
    r12 = n12;
  }
  const double ex = cam.position.x, ey = cam.position.y, ez = cam.position.z;
  return {r00, r10, r20, 0, r01, r11, r21, 0, r02, r12, r22, 0,
          -(r00 * ex + r01 * ey + r02 * ez), -(r10 * ex + r11 * ey + r12 * ez), -(r20 * ex + r21 * ey + r22 * ez), 1};
}

Mat4 camera_projection_matrix(const Camera& cam) noexcept {
  const double f = cam.focal_length;
  const double n = kPerspectiveNear;
  const double fr = kPerspectiveFar;
  const double a = fr / (fr - n);
  const double b = (-fr * n) / (fr - n);
  return {f, 0, 0, 0, 0, f, 0, 0, cam.principal.x, cam.principal.y, a, 1, 0, 0, b, 0};
}

namespace {

using Axis3 = std::array<double, 3>;
struct Basis {
  Axis3 right;
  Axis3 down;
};
Basis ortho_basis(OrthoView v) noexcept {
  switch (v) {
    case OrthoView::kFront: return {{1, 0, 0}, {0, 1, 0}};
    case OrthoView::kBack: return {{-1, 0, 0}, {0, 1, 0}};
    case OrthoView::kLeft: return {{0, 0, -1}, {0, 1, 0}};
    case OrthoView::kRight: return {{0, 0, 1}, {0, 1, 0}};
    case OrthoView::kTop: return {{1, 0, 0}, {0, 0, -1}};
    case OrthoView::kBottom: return {{1, 0, 0}, {0, 0, 1}};
  }
  return {{1, 0, 0}, {0, 1, 0}};
}
double dot3(const Axis3& a, double x, double y, double z) noexcept { return a[0] * x + a[1] * y + a[2] * z; }
Axis3 cross3(const Axis3& a, const Axis3& b) noexcept {
  return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
}

}  // namespace

Projected project_ortho(Vec3 p, OrthoView view, double width, double height) noexcept {
  const Basis b = ortho_basis(view);
  const double cx = width / 2;
  const double cy = height / 2;
  const double dx = p.x - cx;
  const double dy = p.y - cy;
  const double dz = p.z;
  const Axis3 into = cross3(b.right, b.down);
  return {.x = cx + dot3(b.right, dx, dy, dz), .y = cy + dot3(b.down, dx, dy, dz), .scale = 1, .depth = dot3(into, dx, dy, dz), .clipped = false};
}

OrthoMatrices ortho_camera_matrices(OrthoView view, double width, double height) noexcept {
  const Basis bs = ortho_basis(view);
  const Axis3& right = bs.right;
  const Axis3& down = bs.down;
  const Axis3 into = cross3(right, down);
  const double cx = width / 2;
  const double cy = height / 2;
  const Mat4 V = {right[0], down[0], into[0], 0, right[1], down[1], into[1], 0, right[2], down[2], into[2], 0,
                  -(right[0] * cx + right[1] * cy), -(down[0] * cx + down[1] * cy), -(into[0] * cx + into[1] * cy), 1};
  const double R = kOrthoDepthRange;
  const Mat4 P = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 / (2 * R), 0, cx, cy, 0.5, 1};
  return {.view = V, .projection = P};
}

Orientation look_at_orientation(Vec3 eye, Vec3 target) noexcept {
  const double dx = target.x - eye.x;
  const double dy = target.y - eye.y;
  const double dz = target.z - eye.z;
  const double h = hypot2(dx, dz);
  const double yaw = js::atan2(dx, dz) / kDeg + 0;
  const double pitch = js::atan2(-dy, h) / kDeg + 0;
  return {.yaw = yaw, .pitch = pitch, .roll = std::nullopt};
}

Orbited orbit_camera(Vec3 base, Vec3 poi, double yaw, double pitch) noexcept {
  if (yaw == 0 && pitch == 0) return {.position = base, .orientation = {.yaw = 0, .pitch = 0, .roll = std::nullopt}};
  const double ox = base.x - poi.x;
  const double oy = base.y - poi.y;
  const double oz = base.z - poi.z;
  const double cx = js::cos(pitch * kDeg);
  const double sx = js::sin(pitch * kDeg);
  const double y1 = cx * oy - sx * oz;
  const double z1 = sx * oy + cx * oz;
  const double cy = js::cos(yaw * kDeg);
  const double sy = js::sin(yaw * kDeg);
  const double x2 = cy * ox + sy * z1;
  const double z2 = -sy * ox + cy * z1;
  return {.position = {poi.x + x2, poi.y + y1, poi.z + z2}, .orientation = {.yaw = yaw, .pitch = pitch, .roll = std::nullopt}};
}

Ray unproject_screen_ray(double screen_x, double screen_y, const Camera& cam, std::optional<OrthoView> ortho,
                         double width, double height) noexcept {
  if (ortho) {
    const Basis b = ortho_basis(*ortho);
    const Axis3 into = cross3(b.right, b.down);
    const double cx = width / 2;
    const double cy = height / 2;
    const double dx = screen_x - cx;
    const double dy = screen_y - cy;
    return {.origin = {cx + b.right[0] * dx + b.down[0] * dy - into[0] * kOrthoDepthRange,
                       cy + b.right[1] * dx + b.down[1] * dy - into[1] * kOrthoDepthRange,
                       b.right[2] * dx + b.down[2] * dy - into[2] * kOrthoDepthRange},
            .direction = {into[0], into[1], into[2]}};
  }
  const double dx = (screen_x - cam.principal.x) / cam.focal_length;
  const double dy = (screen_y - cam.principal.y) / cam.focal_length;
  double vx = dx;
  double vy = dy;
  double vz = 1;
  const double yaw = (cam.orientation ? cam.orientation->yaw : 0) * kDeg;
  const double pitch = (cam.orientation ? cam.orientation->pitch : 0) * kDeg;
  const double roll = (cam.orientation ? cam.orientation->roll.value_or(0) : 0) * kDeg;
  if (yaw != 0 || pitch != 0 || roll != 0) {
    if (roll != 0) {
      const double cz = js::cos(roll), sz = js::sin(roll);
      const double rx = cz * vx - sz * vy;
      vy = sz * vx + cz * vy;
      vx = rx;
    }
    const double cx = js::cos(pitch), sx = js::sin(pitch);
    const double cy = js::cos(yaw), sy = js::sin(yaw);
    const double y1 = cx * vy - sx * vz;
    const double z1 = sx * vy + cx * vz;
    const double x2 = cy * vx + sy * z1;
    const double z2 = -sy * vx + cy * z1;
    vx = x2;
    vy = y1;
    vz = z2;
  }
  double len = hypot3(vx, vy, vz);
  if (len == 0 || std::isnan(len)) len = 1;
  return {.origin = cam.position, .direction = {vx / len, vy / len, vz / len}};
}

std::optional<Vec3> intersect_ray_plane(const Ray& ray, Vec3 pp, Vec3 pn) noexcept {
  const double denom = ray.direction.x * pn.x + ray.direction.y * pn.y + ray.direction.z * pn.z;
  if (std::fabs(denom) < 1e-6) return std::nullopt;
  const double num = (pp.x - ray.origin.x) * pn.x + (pp.y - ray.origin.y) * pn.y + (pp.z - ray.origin.z) * pn.z;
  const double t = num / denom;
  return Vec3{ray.origin.x + t * ray.direction.x, ray.origin.y + t * ray.direction.y, ray.origin.z + t * ray.direction.z};
}

// ── camera3d.ts ─────────────────────────────────────────────────────────────

Camera camera_from_props(const CameraProps& p, double width, double height, const LiftFn& lift) {
  const Camera def = default_camera(width, height);
  const double focal_length = p.focal_length.value_or(def.focal_length);
  const auto lifted = [&](Vec3 v) { return lift ? lift(v) : v; };
  const Vec3 base = lifted({p.x.value_or(def.position.x), p.y.value_or(def.position.y), p.z.value_or(-focal_length)});
  const double roll = p.orientation_z.value_or(0);
  const double ori_x = p.orientation_x.value_or(0);
  const double ori_y = p.orientation_y.value_or(0);
  const auto with_orientation = [&](const Orientation& o) {
    Orientation composed{.yaw = o.yaw + ori_y, .pitch = o.pitch + ori_x, .roll = std::nullopt};
    if (roll != 0) composed.roll = roll;
    return composed;
  };
  const auto non_zero = [](const Orientation& o) { return o.yaw != 0 || o.pitch != 0 || o.roll.value_or(0) != 0; };
  Camera out{.position = {}, .focal_length = focal_length, .principal = def.principal, .orientation = std::nullopt};
  if (p.poi_x || p.poi_y || p.poi_z) {
    const Vec3 poi = lifted({p.poi_x.value_or(def.principal.x), p.poi_y.value_or(def.principal.y), p.poi_z.value_or(0)});
    const Orbited orbited = orbit_camera(base, poi, p.orbit_yaw.value_or(0), p.orbit_pitch.value_or(0));
    const Orientation o = with_orientation(look_at_orientation(orbited.position, poi));
    out.position = orbited.position;
    if (non_zero(o)) out.orientation = o;
    return out;
  }
  const Orbited orbited =
      orbit_camera(base, {def.principal.x, def.principal.y, 0}, p.orbit_yaw.value_or(0), p.orbit_pitch.value_or(0));
  const Orientation o = with_orientation(orbited.orientation);
  out.position = orbited.position;
  if (non_zero(o)) out.orientation = o;
  return out;
}

// ── layerSpace.ts ───────────────────────────────────────────────────────────

Vec3 LayerSpace2D::to_world(Vec2 p) const noexcept {
  const Vec2 q = to_comp(p);
  return {q.x, q.y, 0};
}

LayerSpace3D::LayerSpace3D(const Mat4& world, const Camera& cam, double width, double height)
    : m(world), inverse(invert(world)), camera(cam), comp_width(width), comp_height(height) {
  plane_point = transform_point(m, {0, 0, 0});
  const Vec3 z_axis = transform_point(m, {0, 0, 1});
  plane_normal = {z_axis.x - plane_point.x, z_axis.y - plane_point.y, z_axis.z - plane_point.z};
}

Vec3 LayerSpace3D::to_world(Vec2 p) const noexcept { return transform_point(m, {p.x, p.y, 0}); }

Vec2 LayerSpace3D::from_world(Vec3 p) const noexcept {
  if (!inverse) return {p.x, p.y};
  const Vec3 q = transform_point(*inverse, p);
  return {q.x, q.y};
}

Vec2 LayerSpace3D::to_comp(Vec2 p) const noexcept {
  const Projected o = project_point(to_world(p), camera);
  return {o.x, o.y};
}

Vec2 LayerSpace3D::from_comp(Vec2 p) const noexcept {
  const Ray ray = unproject_screen_ray(p.x, p.y, camera, std::nullopt, comp_width, comp_height);
  const std::optional<Vec3> hit = intersect_ray_plane(ray, plane_point, plane_normal);
  return hit ? from_world(*hit) : Vec2{0, 0};
}

// ── buildSnapshot.ts affineAt ───────────────────────────────────────────────

Affine3D layer_affine_3d(const Node3DTransform& v, const std::optional<Mat4>& parent3d, const Camera& camera) noexcept {
  const Mat4 L = compose(Parts3D{.position = {v.x, v.y, v.z},
                                 .rotation = {(v.rotation_x + v.orientation_x) * kDeg,
                                              (v.rotation_y + v.orientation_y) * kDeg,
                                              (v.rotation_z + v.orientation_z) * kDeg},
                                 .scale = {v.scale_x, v.scale_y, v.scale_z},
                                 .anchor = {0, 0, v.anchor_z}});
  const Mat4 M = parent3d ? multiply(*parent3d, L) : L;
  const Projected O = project_point(transform_point(M, {0, 0, 0}), camera);
  const Projected X = project_point(transform_point(M, {1, 0, 0}), camera);
  const Projected Y = project_point(transform_point(M, {0, 1, 0}), camera);
  Affine3D out;
  out.matrix = {X.x - O.x, X.y - O.y, Y.x - O.x, Y.y - O.y, O.x, O.y};
  out.origin = O;
  out.world = M;
  out.sx = hypot2(out.matrix[0], out.matrix[1]);
  out.sy = hypot2(out.matrix[2], out.matrix[3]);
  out.rotation_deg = js::atan2(out.matrix[1], out.matrix[0]) / kDeg;
  return out;
}

}  // namespace motion::xf
