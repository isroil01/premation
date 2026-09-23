// motion_transform — the golden parity gate against the TypeScript transform,
// parenting and camera math (golden_transform.inc, written by running the
// TypeScript: native/tests/gen_golden_transform.ts). Every output double is
// compared by bits; a secondary count reports rows within 1e-12 relative.

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <bit>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <span>
#include <string>
#include <vector>

#include "motion/motion_transform.h"
#include "transform.hpp"

namespace {

namespace xf = motion::xf;

double at(std::span<const double> v, std::size_t i) { return v[i]; }

xf::Mat2D m2(std::span<const double> v, std::size_t o) {
  return {.a = v[o], .b = v[o + 1], .c = v[o + 2], .d = v[o + 3], .e = v[o + 4], .f = v[o + 5]};
}
xf::Mat4 m4(std::span<const double> v, std::size_t o) {
  xf::Mat4 m{};
  for (std::size_t i = 0; i < 16; ++i) m[i] = v[o + i];
  return m;
}
xf::Node3DTransform n3(std::span<const double> v, std::size_t o) {
  return {.x = v[o], .y = v[o + 1], .z = v[o + 2], .rotation_x = v[o + 3], .rotation_y = v[o + 4],
          .rotation_z = v[o + 5], .orientation_x = v[o + 6], .orientation_y = v[o + 7], .orientation_z = v[o + 8],
          .scale_x = v[o + 9], .scale_y = v[o + 10], .scale_z = v[o + 11], .anchor_x = v[o + 12],
          .anchor_y = v[o + 13], .anchor_z = v[o + 14]};
}
xf::Camera cam(std::span<const double> v, std::size_t o) {
  xf::Camera c{.position = {v[o], v[o + 1], v[o + 2]}, .focal_length = v[o + 3], .principal = {v[o + 4], v[o + 5]},
               .orientation = std::nullopt};
  if (v[o + 6] != 0) {
    c.orientation = xf::Orientation{.yaw = v[o + 8], .pitch = v[o + 9], .roll = std::nullopt};
    if (v[o + 7] != 0) c.orientation->roll = v[o + 10];
  }
  return c;
}
void put(std::vector<double>& o, const xf::Mat2D& m) { o.insert(o.end(), {m.a, m.b, m.c, m.d, m.e, m.f}); }
void put(std::vector<double>& o, const xf::Mat4& m) { o.insert(o.end(), m.begin(), m.end()); }
void put(std::vector<double>& o, const xf::Local2D& l) { o.insert(o.end(), {l.x, l.y, l.rotation, l.scale_x, l.scale_y}); }
void put(std::vector<double>& o, const xf::Camera& c) {
  const bool has = c.orientation.has_value();
  o.insert(o.end(), {c.position.x, c.position.y, c.position.z, c.focal_length, c.principal.x, c.principal.y,
                     has ? 1.0 : 0.0, has && c.orientation->roll ? 1.0 : 0.0, has ? c.orientation->yaw : 0.0,
                     has ? c.orientation->pitch : 0.0, has && c.orientation->roll ? *c.orientation->roll : 0.0});
}
std::optional<xf::OrthoView> view_of(double v) {
  if (v < 0) return std::nullopt;
  return static_cast<xf::OrthoView>(static_cast<int>(v));
}

/// Compute the C++ outputs for one golden row.
std::vector<double> compute(int kind, std::span<const double> in) {
  std::vector<double> o;
  switch (kind) {
    case 1: {  // COMPOSE2D
      put(o, xf::compose(xf::Parts2D{.position = {in[0], in[1]}, .rotation = in[2], .scale = {in[3], in[4]},
                                     .skew = {in[5], in[6]}, .anchor = {in[7], in[8]}}));
      break;
    }
    case 2: {  // DECOMPOSE2D
      const xf::Decomposed2D d = xf::decompose(m2(in, 0));
      o = {d.position.x, d.position.y, d.rotation, d.scale.x, d.scale.y};
      break;
    }
    case 3: put(o, xf::matrix_to_local(m2(in, 0))); break;
    case 4: put(o, xf::invert(m2(in, 0))); break;
    case 5: {  // SCENE2D
      const auto n = static_cast<std::size_t>(in[0]);
      std::vector<xf::Node2D> nodes(n);
      for (std::size_t i = 0; i < n; ++i) {
        const std::size_t b = 1 + i * 7;
        if (in[b] != 0) {
          nodes[i].local = xf::Local2D{.x = in[b + 2], .y = in[b + 3], .rotation = in[b + 4], .scale_x = in[b + 5],
                                       .scale_y = in[b + 6]};
        }
        nodes[i].parent = static_cast<std::int32_t>(in[b + 1]);
      }
      std::vector<xf::Mat2D> w(n);
      REQUIRE(xf::world_matrices_2d(nodes, w));
      for (std::size_t i = 0; i < n; ++i) {
        put(o, w[i]);
        put(o, xf::matrix_to_local(w[i]));
      }
      break;
    }
    case 6: put(o, xf::local_under_parent(m2(in, 0), m2(in, 6))); break;
    case 7: put(o, xf::compose_node_3d(n3(in, 0))); break;
    case 8: {  // SCENE3D
      const auto n = static_cast<std::size_t>(in[0]);
      const auto index = static_cast<std::size_t>(in[1]);
      std::vector<xf::Node3D> nodes(n);
      for (std::size_t i = 0; i < n; ++i) {
        const std::size_t b = 2 + i * 24;
        nodes[i].parent = static_cast<std::int32_t>(in[b]);
        nodes[i].is_3d = in[b + 1] != 0;
        if (in[b + 2] != 0) nodes[i].local3d = n3(in, b + 3);
        nodes[i].world2d = m2(in, b + 18);
      }
      const auto m = xf::parent_world_3d(nodes, index);
      o.push_back(m ? 1 : 0);
      put(o, m.value_or(xf::Mat4{}));
      break;
    }
    case 9: {  // INVERT4
      const auto m = xf::invert(m4(in, 0));
      o.push_back(m ? 1 : 0);
      put(o, m.value_or(xf::Mat4{}));
      break;
    }
    case 10: {
      const xf::Vec3 q = xf::transform_point(m4(in, 0), {in[16], in[17], in[18]});
      o = {q.x, q.y, q.z};
      break;
    }
    case 11: {
      const xf::Vec3 q = xf::transform_vector(m4(in, 0), {in[16], in[17], in[18]});
      o = {q.x, q.y, q.z};
      break;
    }
    case 12: {  // CAMERA
      const auto mask = static_cast<std::uint32_t>(in[2]);
      const auto get = [&](std::size_t j) -> std::optional<double> {
        if ((mask & (1U << j)) == 0U) return std::nullopt;
        return in[3 + j];
      };
      const xf::CameraProps p{.x = get(0), .y = get(1), .z = get(2), .focal_length = get(3), .orbit_yaw = get(4),
                              .orbit_pitch = get(5), .poi_x = get(6), .poi_y = get(7), .poi_z = get(8),
                              .orientation_x = get(9), .orientation_y = get(10), .orientation_z = get(11)};
      xf::LiftFn lift;
      const xf::Mat4 lm = m4(in, 16);
      if (in[15] != 0) lift = [&lm](xf::Vec3 q) { return xf::transform_point(lm, q); };
      put(o, xf::camera_from_props(p, in[0], in[1], lift));
      break;
    }
    case 13: {  // PROJECT
      const xf::Projected r = xf::project_point({in[11], in[12], in[13]}, cam(in, 0));
      o = {r.x, r.y, r.scale, r.depth, r.clipped ? 1.0 : 0.0};
      break;
    }
    case 14: {
      put(o, xf::camera_view_matrix(cam(in, 0)));
      put(o, xf::camera_projection_matrix(cam(in, 0)));
      break;
    }
    case 15: {  // UNPROJECT
      const xf::Ray ray = xf::unproject_screen_ray(in[11], in[12], cam(in, 0), view_of(in[15]), in[13], in[14]);
      o = {ray.origin.x, ray.origin.y, ray.origin.z, ray.direction.x, ray.direction.y, ray.direction.z};
      break;
    }
    case 16: {
      const xf::Ray ray{.origin = {in[0], in[1], in[2]}, .direction = {in[3], in[4], in[5]}};
      const auto hit = xf::intersect_ray_plane(ray, {in[6], in[7], in[8]}, {in[9], in[10], in[11]});
      o = hit ? std::vector<double>{1, hit->x, hit->y, hit->z} : std::vector<double>{0, 0, 0, 0};
      break;
    }
    case 17: {
      const xf::Orientation l = xf::look_at_orientation({in[0], in[1], in[2]}, {in[3], in[4], in[5]});
      o = {l.yaw, l.pitch};
      break;
    }
    case 18: {
      const xf::Orbited r = xf::orbit_camera({in[0], in[1], in[2]}, {in[3], in[4], in[5]}, in[6], in[7]);
      o = {r.position.x, r.position.y, r.position.z, r.orientation.yaw, r.orientation.pitch};
      break;
    }
    case 19: o = {xf::focal_length_for_fov(in[0], in[1])}; break;
    case 20: o = {xf::fov_for_focal_length(in[0], in[1])}; break;
    case 21: {
      const xf::Projected r = xf::project_ortho({in[0], in[1], in[2]}, *view_of(in[3]), in[4], in[5]);
      o = {r.x, r.y, r.scale, r.depth};
      break;
    }
    case 22: {
      const xf::OrthoMatrices m = xf::ortho_camera_matrices(*view_of(in[0]), in[1], in[2]);
      put(o, m.view);
      put(o, m.projection);
      break;
    }
    case 23: {  // SPACE3D
      const xf::LayerSpace3D s(m4(in, 0), cam(in, 16), in[27], in[28]);
      const xf::Vec3 tw = s.to_world({in[29], in[30]});
      const xf::Vec2 tc = s.to_comp({in[29], in[30]});
      const xf::Vec2 fc = s.from_comp({in[31], in[32]});
      const xf::Vec2 fw = s.from_world({in[33], in[34], in[35]});
      o = {tw.x, tw.y, tw.z, tc.x, tc.y, fc.x, fc.y, fw.x, fw.y};
      break;
    }
    case 24: {  // AFFINE3D
      std::optional<xf::Mat4> parent;
      if (in[15] != 0) parent = m4(in, 16);
      const xf::Affine3D a = xf::layer_affine_3d(n3(in, 0), parent, cam(in, 32));
      o.assign(a.matrix.begin(), a.matrix.end());
      o.insert(o.end(), {a.origin.x, a.origin.y, a.origin.scale, a.origin.depth, a.origin.clipped ? 1.0 : 0.0});
      put(o, a.world);
      o.insert(o.end(), {a.sx, a.sy, a.rotation_deg});
      break;
    }
    case 25: put(o, xf::default_camera(in[0], in[1], in[2])); break;
    case 26: put(o, xf::multiply(m4(in, 0), m4(in, 16))); break;
    case 27: put(o, xf::multiply(m2(in, 0), m2(in, 6))); break;
    default: break;
  }
  return o;
}

bool same(double a, double b) {
  if (std::isnan(a) && std::isnan(b)) return true;
  return std::bit_cast<std::uint64_t>(a) == std::bit_cast<std::uint64_t>(b);
}

}  // namespace

TEST_CASE("transforms, parenting and camera match the TypeScript bit for bit", "[transform][golden]") {
  int rows = 0;
  int bad = 0;
  long long values = 0;
  long long within_rel = 0;
  std::map<int, int> bad_kinds;
  static constexpr std::uint64_t kData[] = {  // NOLINT(cppcoreguidelines-avoid-c-arrays)
#define MOTION_XF_DATA
#include "golden_transform.inc"
#undef MOTION_XF_DATA
  };
  const std::span<const std::uint64_t> data(kData);
  const auto check = [&](int kind, std::size_t offset, std::size_t nin, std::size_t total) {
    ++rows;
    std::vector<double> all(total);
    for (std::size_t i = 0; i < total; ++i) all[i] = std::bit_cast<double>(data[offset + i]);
    const std::span<const double> in(all.data(), nin);
    const std::span<const double> want(all.data() + nin, all.size() - nin);
    const std::vector<double> got = compute(kind, in);
    bool ok = got.size() == want.size();
    for (std::size_t i = 0; ok && i < want.size(); ++i) {
      ++values;
      const double w = at(want, i);
      if (same(got[i], w) || std::fabs(got[i] - w) <= 1e-12 * std::fabs(w)) ++within_rel;
      if (!same(got[i], w)) {
        ok = false;
        if (bad_kinds[kind] < 3) {
          UNSCOPED_INFO("kind " << kind << " output[" << i << "] got " << got[i] << " want " << w);
        }
      }
    }
    if (!ok) {
      ++bad;
      ++bad_kinds[kind];
    }
  };
#define MOTION_XF(kind, offset, nin, total) check(kind, offset, nin, total);
#include "golden_transform.inc"
#undef MOTION_XF
  INFO("rows " << rows << ", mismatched rows " << bad << ", values " << values << ", within 1e-12 rel " << within_rel);
  CHECK(rows >= 300);
  CHECK(bad == 0);
}

TEST_CASE("world_matrices_2d refuses cycles and survives a 10 000-deep chain", "[transform]") {
  std::vector<xf::Node2D> nodes(3);
  nodes[0].parent = 2;
  nodes[1].parent = 0;
  nodes[2].parent = 1;
  std::vector<xf::Mat2D> out(3);
  CHECK_FALSE(xf::world_matrices_2d(nodes, out));
  nodes.assign(10000, {});
  for (std::size_t i = 1; i < nodes.size(); ++i) {
    nodes[i].parent = static_cast<std::int32_t>(i - 1);
    nodes[i].local = xf::Local2D{.x = 1, .y = 0, .rotation = 0, .scale_x = 1, .scale_y = 1};
  }
  out.resize(nodes.size());
  REQUIRE(xf::world_matrices_2d(nodes, out));
  CHECK(out.back().e == 9999);
}

TEST_CASE("the transform C ABI", "[transform][abi]") {
  std::array<motion_node2d, 2> nodes{};
  nodes[0] = {.local = {.x = 10, .y = 0, .rotation = 90, .scale_x = 2, .scale_y = 2}, .has_local = 1, .parent = -1};
  nodes[1] = {.local = {.x = 5, .y = 0, .rotation = 0, .scale_x = 1, .scale_y = 1}, .has_local = 1, .parent = 0};
  std::array<motion_mat2d, 2> w{};
  REQUIRE(motion_transform_world_2d(nodes.data(), nodes.size(), w.data(), nullptr) == MOTION_OK);
  CHECK(std::fabs(w[1].e - 10) < 1e-9);
  CHECK(std::fabs(w[1].f - 10) < 1e-9);
  nodes[0].parent = 1;
  CHECK(motion_transform_world_2d(nodes.data(), nodes.size(), w.data(), nullptr) == MOTION_INVALID_ARG);

  motion_camera c{};
  motion_transform_default_camera(1920, 1080, 39.6, &c);
  std::array<double, 3> p{960, 540, 0};
  std::array<double, 4> r{};
  CHECK(motion_transform_project(&c, p.data(), r.data()) == 0);
  CHECK(r[0] == 960);
  CHECK(r[2] == 1);  // the comp plane at z = 0 is at the default focal distance
  motion_camera_props props{};
  props.present = 1U << MOTION_CAM_ORBIT_YAW;
  props.values[MOTION_CAM_ORBIT_YAW] = 30;
  motion_transform_camera_from_props(&props, 1920, 1080, nullptr, &c);
  CHECK(c.has_orientation == 1);
  CHECK(c.yaw == 30);
  std::array<double, 16> view{};
  std::array<double, 16> proj{};
  motion_transform_camera_matrices(&c, view.data(), proj.data());
  CHECK(proj[11] == 1);
}
