// motion_transform — the C ABI (include/motion/motion_transform.h).

#include "motion/motion_transform.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string_view>
#include <vector>

#include "transform.hpp"

namespace {

namespace xf = motion::xf;

void set_error(motion_error* err, std::string_view msg) noexcept {
  if (err == nullptr) return;
  const std::span<char> buf(err->message);
  const std::size_t n = msg.size() < buf.size() - 1 ? msg.size() : buf.size() - 1;
  for (std::size_t i = 0; i < n; ++i) buf[i] = msg[i];
  buf[n] = '\0';
}

xf::Node3DTransform to_cpp(const motion_node3d_transform& v) noexcept {
  return {.x = v.x, .y = v.y, .z = v.z, .rotation_x = v.rotation_x, .rotation_y = v.rotation_y,
          .rotation_z = v.rotation_z, .orientation_x = v.orientation_x, .orientation_y = v.orientation_y,
          .orientation_z = v.orientation_z, .scale_x = v.scale_x, .scale_y = v.scale_y, .scale_z = v.scale_z,
          .anchor_x = v.anchor_x, .anchor_y = v.anchor_y, .anchor_z = v.anchor_z};
}
xf::Mat2D to_cpp(const motion_mat2d& m) noexcept { return {.a = m.a, .b = m.b, .c = m.c, .d = m.d, .e = m.e, .f = m.f}; }

void write4(const xf::Mat4& m, double* out) noexcept {
  const std::span<double, 16> o(out, 16);
  for (std::size_t i = 0; i < 16; ++i) o[i] = m[i];
}

xf::Camera to_cpp(const motion_camera& c) noexcept {
  xf::Camera out{.position = {c.position[0], c.position[1], c.position[2]},
                 .focal_length = c.focal_length,
                 .principal = {c.principal[0], c.principal[1]},
                 .orientation = std::nullopt};
  if (c.has_orientation != 0) {
    out.orientation = xf::Orientation{.yaw = c.yaw, .pitch = c.pitch, .roll = std::nullopt};
    if (c.has_roll != 0) out.orientation->roll = c.roll;
  }
  return out;
}

void to_c(const xf::Camera& c, motion_camera* out) noexcept {
  *out = motion_camera{};
  out->position[0] = c.position.x;
  out->position[1] = c.position.y;
  out->position[2] = c.position.z;
  out->focal_length = c.focal_length;
  out->principal[0] = c.principal.x;
  out->principal[1] = c.principal.y;
  if (c.orientation) {
    out->has_orientation = 1;
    out->yaw = c.orientation->yaw;
    out->pitch = c.orientation->pitch;
    if (c.orientation->roll) {
      out->has_roll = 1;
      out->roll = *c.orientation->roll;
    }
  }
}

}  // namespace

extern "C" {

motion_status motion_transform_world_2d(const motion_node2d* nodes, size_t count, motion_mat2d* out,
                                        uint8_t* on_cycle, motion_error* err) {
  if ((nodes == nullptr || out == nullptr) && count > 0) {
    set_error(err, "motion_transform_world_2d: NULL argument");
    return MOTION_INVALID_ARG;
  }
  try {
    const std::span<const motion_node2d> in(nodes, count);
    std::vector<xf::Node2D> n(count);
    for (std::size_t i = 0; i < count; ++i) {
      if (in[i].has_local != 0) {
        const motion_local2d& l = in[i].local;
        n[i].local = xf::Local2D{.x = l.x, .y = l.y, .rotation = l.rotation, .scale_x = l.scale_x, .scale_y = l.scale_y};
      }
      n[i].parent = in[i].parent;
    }
    std::vector<xf::Mat2D> w(count);
    const std::span<std::uint8_t> flags = on_cycle != nullptr ? std::span<std::uint8_t>(on_cycle, count)
                                                                : std::span<std::uint8_t>();
    if (!xf::world_matrices_2d(n, w, flags)) {
      set_error(err, "motion_transform_world_2d: parent index out of range");
      return MOTION_INVALID_ARG;
    }
    const std::span<motion_mat2d> o(out, count);
    for (std::size_t i = 0; i < count; ++i) o[i] = {w[i].a, w[i].b, w[i].c, w[i].d, w[i].e, w[i].f};
    return MOTION_OK;
  } catch (...) {
    set_error(err, "internal: unexpected exception in motion_transform_world_2d");
    return MOTION_INTERNAL;
  }
}

void motion_transform_compose_3d(const motion_node3d_transform* v, double out[16]) {
  if (v == nullptr || out == nullptr) return;
  write4(xf::compose_node_3d(to_cpp(*v)), out);
}

motion_status motion_transform_parent_world_3d(const motion_node3d* nodes, size_t count, size_t index, double out[16],
                                               int32_t* has, motion_error* err) {
  if (nodes == nullptr || out == nullptr || has == nullptr || index >= count) {
    set_error(err, "motion_transform_parent_world_3d: NULL argument or index out of range");
    return MOTION_INVALID_ARG;
  }
  try {
    const std::span<const motion_node3d> in(nodes, count);
    std::vector<xf::Node3D> n(count);
    for (std::size_t i = 0; i < count; ++i) {
      n[i].parent = in[i].parent;
      n[i].is_3d = in[i].is_3d != 0;
      if (in[i].has_local != 0) n[i].local3d = to_cpp(in[i].local);
      n[i].world2d = to_cpp(in[i].world2d);
    }
    const std::optional<xf::Mat4> m = xf::parent_world_3d(n, index);
    *has = m ? 1 : 0;
    if (m) write4(*m, out);
    return MOTION_OK;
  } catch (...) {
    set_error(err, "internal: unexpected exception in motion_transform_parent_world_3d");
    return MOTION_INTERNAL;
  }
}

void motion_transform_camera_from_props(const motion_camera_props* props, double width, double height,
                                        const double* lift, motion_camera* out) {
  if (props == nullptr || out == nullptr) return;
  const std::span<const double, MOTION_CAM_PROP_COUNT_> v(props->values);
  const auto get = [&](int i) -> std::optional<double> {
    if ((props->present & (1U << static_cast<unsigned>(i))) == 0U) return std::nullopt;
    return v[static_cast<std::size_t>(i)];
  };
  const xf::CameraProps p{.x = get(MOTION_CAM_X), .y = get(MOTION_CAM_Y), .z = get(MOTION_CAM_Z),
                          .focal_length = get(MOTION_CAM_FOCAL_LENGTH), .orbit_yaw = get(MOTION_CAM_ORBIT_YAW),
                          .orbit_pitch = get(MOTION_CAM_ORBIT_PITCH), .poi_x = get(MOTION_CAM_POI_X),
                          .poi_y = get(MOTION_CAM_POI_Y), .poi_z = get(MOTION_CAM_POI_Z),
                          .orientation_x = get(MOTION_CAM_ORIENTATION_X), .orientation_y = get(MOTION_CAM_ORIENTATION_Y),
                          .orientation_z = get(MOTION_CAM_ORIENTATION_Z)};
  xf::LiftFn fn;
  xf::Mat4 m{};
  if (lift != nullptr) {
    const std::span<const double, 16> l(lift, 16);
    for (std::size_t i = 0; i < 16; ++i) m[i] = l[i];
    fn = [&m](xf::Vec3 q) { return xf::transform_point(m, q); };
  }
  try {
    to_c(xf::camera_from_props(p, width, height, fn), out);
  } catch (...) {
    to_c(xf::default_camera(width, height), out);
  }
}

void motion_transform_default_camera(double width, double height, double fov_deg, motion_camera* out) {
  if (out != nullptr) to_c(xf::default_camera(width, height, fov_deg), out);
}

int32_t motion_transform_project(const motion_camera* cam, const double p[3], double out[4]) {
  if (cam == nullptr || p == nullptr || out == nullptr) return 0;
  const std::span<const double, 3> in(p, 3);
  const xf::Projected r = xf::project_point({in[0], in[1], in[2]}, to_cpp(*cam));
  const std::span<double, 4> o(out, 4);
  o[0] = r.x;
  o[1] = r.y;
  o[2] = r.scale;
  o[3] = r.depth;
  return r.clipped ? 1 : 0;
}

void motion_transform_camera_matrices(const motion_camera* cam, double view[16], double projection[16]) {
  if (cam == nullptr) return;
  const xf::Camera c = to_cpp(*cam);
  if (view != nullptr) write4(xf::camera_view_matrix(c), view);
  if (projection != nullptr) write4(xf::camera_projection_matrix(c), projection);
}

}  // extern "C"
