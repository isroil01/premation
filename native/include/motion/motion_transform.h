/*
 * Premation native core — motion_transform: layer transforms, parenting and
 * the camera.
 *
 * The C ABI over the port of the TypeScript transform math (matrix.ts,
 * matrix4.ts, project3d.ts, worldTransform.ts, nodeMatrix.ts, camera3d.ts).
 * Results are the TypeScript's, bit for bit (native/tests/golden_transform.inc,
 * written by running the TypeScript). All math is float64.
 *
 * Layouts: motion_mat2d is {a, b, c, d, e, f} (x' = a·x + c·y + e,
 * y' = b·x + d·y + f). 4×4 matrices are 16 doubles COLUMN-major
 * (index = col·4 + row; translation in 12, 13, 14). Angles in the structs
 * are DEGREES, as the document stores them.
 */

#ifndef MOTION_TRANSFORM_H
#define MOTION_TRANSFORM_H

// NOLINTBEGIN(modernize-use-using, modernize-deprecated-headers, modernize-macro-to-enum, modernize-redundant-void-arg, modernize-avoid-c-arrays, cppcoreguidelines-avoid-c-arrays, cppcoreguidelines-macro-usage, performance-enum-size, cppcoreguidelines-use-enum-class)

#include <stddef.h>
#include <stdint.h>

#include "motion_abi.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct motion_mat2d {
  double a, b, c, d, e, f;
} motion_mat2d;

/** A layer's local 2D transform (anchor is applied at draw time, not here). */
typedef struct motion_local2d {
  double x, y;
  double rotation; /**< degrees */
  double scale_x, scale_y;
} motion_local2d;

typedef struct motion_node2d {
  motion_local2d local;
  int32_t has_local; /**< 0: identity (no transform component) */
  int32_t parent;    /**< index into the same array, or -1 */
} motion_node2d;

/** World matrices of a flat layer array: world = parentWorld · local.
 *  Linear time, no recursion.
 *
 *  A parent CYCLE is not an error: every node on it is drawn as a root (its
 *  world is its local matrix), nodes parented into it compose onto it, and
 *  `on_cycle` (may be NULL; else `count` entries) gets 1 for each node on a
 *  cycle and 0 for the rest — the TypeScript `worldMatrixOf` rule and its
 *  `onCycle` report. INVALID_ARG for an out-of-range parent index (out then
 *  unspecified). (`on_cycle` was added within ABI 0.2, before 0.2 shipped.) */
MOTION_API motion_status motion_transform_world_2d(const motion_node2d* nodes, size_t count, motion_mat2d* out,
                                                   uint8_t* on_cycle, motion_error* err);

typedef struct motion_node3d_transform {
  double x, y, z;
  double rotation_x, rotation_y, rotation_z;          /**< degrees */
  double orientation_x, orientation_y, orientation_z; /**< degrees */
  double scale_x, scale_y, scale_z;
  double anchor_x, anchor_y, anchor_z;
} motion_node3d_transform;

/** composeNodeWorld3d: T · Rz · Ry · Rx · S · T(-anchor), rotation + orientation per axis. */
MOTION_API void motion_transform_compose_3d(const motion_node3d_transform* v, double out[16]);

typedef struct motion_node3d {
  int32_t parent; /**< index, or -1 */
  int32_t is_3d;
  int32_t has_local; /**< read when is_3d */
  int32_t reserved;
  motion_node3d_transform local;
  motion_mat2d world2d; /**< read when !is_3d: that node's 2D WORLD matrix */
} motion_node3d;

/** parentWorld3d(nodes[index]): writes the parent chain's 3D world into out and
 *  *has = 1, or *has = 0 when no ancestor is 3D. */
MOTION_API motion_status motion_transform_parent_world_3d(const motion_node3d* nodes, size_t count, size_t index,
                                                          double out[16], int32_t* has, motion_error* err);

typedef struct motion_camera {
  double position[3];
  double focal_length; /**< pixels (AE zoom) */
  double principal[2];
  int32_t has_orientation;
  int32_t has_roll;
  double yaw, pitch, roll; /**< degrees */
} motion_camera;

/** Presence bits of motion_camera_props.values[i] (bit i). */
typedef enum motion_camera_prop {
  MOTION_CAM_X = 0,
  MOTION_CAM_Y = 1,
  MOTION_CAM_Z = 2,
  MOTION_CAM_FOCAL_LENGTH = 3,
  MOTION_CAM_ORBIT_YAW = 4,
  MOTION_CAM_ORBIT_PITCH = 5,
  MOTION_CAM_POI_X = 6,
  MOTION_CAM_POI_Y = 7,
  MOTION_CAM_POI_Z = 8,
  MOTION_CAM_ORIENTATION_X = 9,
  MOTION_CAM_ORIENTATION_Y = 10,
  MOTION_CAM_ORIENTATION_Z = 11,
  MOTION_CAM_PROP_COUNT_ = 12
} motion_camera_prop;

typedef struct motion_camera_props {
  uint32_t present; /**< bit (1 << motion_camera_prop) */
  uint32_t reserved;
  double values[MOTION_CAM_PROP_COUNT_];
} motion_camera_props;

/** cameraFromNode. `lift` (may be NULL) is the camera layer's parent world
 *  4×4, applied to its position and point of interest. */
MOTION_API void motion_transform_camera_from_props(const motion_camera_props* props, double width, double height,
                                                   const double* lift, motion_camera* out);

/** defaultCamera(width, height, fov_deg); fov 39.6 is the TypeScript default. */
MOTION_API void motion_transform_default_camera(double width, double height, double fov_deg, motion_camera* out);

/** projectPoint: out = {x, y, scale, depth}; returns 1 when clipped (behind the near plane). */
MOTION_API int32_t motion_transform_project(const motion_camera* cam, const double p[3], double out[4]);

/** cameraViewMatrix and cameraProjectionMatrix (either output may be NULL). */
MOTION_API void motion_transform_camera_matrices(const motion_camera* cam, double view[16], double projection[16]);

#ifdef __cplusplus
} /* extern "C" */
#endif

// NOLINTEND(modernize-use-using, modernize-deprecated-headers, modernize-macro-to-enum, modernize-redundant-void-arg, modernize-avoid-c-arrays, cppcoreguidelines-avoid-c-arrays, cppcoreguidelines-macro-usage, performance-enum-size, cppcoreguidelines-use-enum-class)

#endif /* MOTION_TRANSFORM_H */
