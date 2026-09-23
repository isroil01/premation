// motion_transform — layer transforms, parenting and the camera, ported from
// the TypeScript engine bit for bit.
//
//   Mat2D / Mat4 math   packages/scene/src/utils/matrix.ts, matrix4.ts
//   layer TRS + parents src/core/scene/worldTransform.ts (2D chain),
//                       src/core/scene/nodeMatrix.ts (3D compose, parentWorld3d)
//   camera              packages/scene/src/utils/project3d.ts,
//                       src/core/scene/camera3d.ts (cameraFromNode)
//   layer spaces        src/core/scene/layerSpace.ts (toComp/fromComp/…)
//   3D layer affine     src/core/rendering/buildSnapshot.ts `affineAt`
//
// All of it is float64 in the TypeScript (no Float32Array, no Math.fround on
// these paths; Float32 only appears later in packages/renderer's Mat3/Mat4,
// i.e. on the GPU side, which D2 owns). Every function keeps the TypeScript's
// operation order and calls motion_jsmath for sin/cos/tan/atan/atan2/hypot —
// V8's fdlibm — so the result is the same double, which native/tests/
// golden_transform.inc (written by running the TypeScript) checks exactly.
//
// Layouts match the TypeScript: Mat2D is {a, b, c, d, e, f} (canvas order,
// x' = a·x + c·y + e), Mat4 is 16 doubles COLUMN-major (index = col·4 + row,
// translation in 12/13/14). `multiply(m, n)` is m·n: n applies first.

#ifndef MOTION_TRANSFORM_TRANSFORM_HPP
#define MOTION_TRANSFORM_TRANSFORM_HPP

#include <array>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <numbers>
#include <optional>
#include <span>
#include <string_view>
#include <vector>

namespace motion::xf {

/// `Math.PI / 180`, the TypeScript's DEG (a correctly rounded division both sides).
inline constexpr double kDeg = std::numbers::pi / 180;

struct Vec2 {
  double x = 0;
  double y = 0;
};
struct Vec3 {
  double x = 0;
  double y = 0;
  double z = 0;
};

struct Mat2D {
  double a = 1, b = 0, c = 0, d = 1, e = 0, f = 0;
};
using Mat4 = std::array<double, 16>;

inline constexpr Mat4 kIdentity4 = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};

// ── matrix.ts ───────────────────────────────────────────────────────────────

[[nodiscard]] Mat2D multiply(const Mat2D& m, const Mat2D& n) noexcept;
[[nodiscard]] Vec2 transform_point(const Mat2D& m, Vec2 p) noexcept;
/// Identity when the determinant is 0 or not finite (as the TypeScript).
[[nodiscard]] Mat2D invert(const Mat2D& m) noexcept;

struct Parts2D {
  Vec2 position;
  double rotation = 0;  // radians
  Vec2 scale{1, 1};
  Vec2 skew;  // radians
  Vec2 anchor;
};
/// T · R · Skew · S · T(-anchor).
[[nodiscard]] Mat2D compose(const Parts2D& t) noexcept;

struct Decomposed2D {
  Vec2 position;
  double rotation = 0;  // radians
  Vec2 scale;
};
[[nodiscard]] Decomposed2D decompose(const Mat2D& m) noexcept;

// ── matrix4.ts ──────────────────────────────────────────────────────────────

[[nodiscard]] Mat4 multiply(const Mat4& a, const Mat4& b) noexcept;
/// Divides by w unless w is 0 or 1 (as the TypeScript).
[[nodiscard]] Vec3 transform_point(const Mat4& m, Vec3 p) noexcept;
/// Affine closed form when the bottom row is (0,0,0,1), else the cofactor
/// inverse. nullopt when singular or not finite.
[[nodiscard]] std::optional<Mat4> invert(const Mat4& m) noexcept;
/// Direction only, normalised (a zero vector stays zero).
[[nodiscard]] Vec3 transform_vector(const Mat4& m, Vec3 v) noexcept;

struct Parts3D {
  Vec3 position;
  Vec3 rotation;  // radians; applied X first, then Y, then Z (M = Rz·Ry·Rx)
  Vec3 scale{1, 1, 1};
  Vec3 anchor;
};
/// T(pos) · Rz · Ry · Rx · S · T(-anchor).
[[nodiscard]] Mat4 compose(const Parts3D& t) noexcept;
[[nodiscard]] Mat4 from_mat2d(const Mat2D& m) noexcept;
[[nodiscard]] Mat2D to_mat2d(const Mat4& m) noexcept;

// ── worldTransform.ts: the 2D layer chain ───────────────────────────────────

/// A layer's local 2D transform (degrees). Anchor is applied at draw time in
/// the TypeScript, not here.
struct Local2D {
  double x = 0;
  double y = 0;
  double rotation = 0;  // degrees
  double scale_x = 1;
  double scale_y = 1;
};
[[nodiscard]] Mat2D local_matrix(const Local2D& l) noexcept;
[[nodiscard]] Local2D matrix_to_local(const Mat2D& m) noexcept;
/// `localUnderParent(childWorld, parentWorld)`.
[[nodiscard]] Local2D local_under_parent(const Mat2D& child_world, const Mat2D& parent_world) noexcept;

/// One node of a flat layer array. `parent` is an index into the same array,
/// or -1. `local` absent means identity (the TypeScript's `localOf → null`).
struct Node2D {
  std::optional<Local2D> local;
  std::int32_t parent = -1;
};

/// `worldMatrixOf` for every node: world = parentWorld · local. Iterative
/// (a 10 000-deep chain uses no stack) and O(n).
///
/// Parent cycles, as worldTransform.ts: every node ON a cycle is a root (its
/// world is its local matrix) and nodes parented into the cycle compose onto
/// it — a rule of the graph alone, so it matches the TypeScript whatever order
/// that resolves nodes in. When `on_cycle` is non-empty (it must then hold
/// `nodes.size()` entries) each node gets 1 if it is on a cycle, else 0 — the
/// TypeScript's `onCycle(nodeId)` calls. Returns false only for a caller bug:
/// `out` or a non-empty `on_cycle` shorter than `nodes`, or a parent index
/// out of range (`out` is then unspecified).
[[nodiscard]] bool world_matrices_2d(std::span<const Node2D> nodes, std::span<Mat2D> out,
                                     std::span<std::uint8_t> on_cycle = {});

// ── nodeMatrix.ts: 3D layers and mixed 2D/3D parent chains ─────────────────

struct Node3DTransform {
  double x = 0, y = 0, z = 0;
  double rotation_x = 0, rotation_y = 0, rotation_z = 0;           // degrees
  double orientation_x = 0, orientation_y = 0, orientation_z = 0;  // degrees
  double scale_x = 1, scale_y = 1, scale_z = 1;
  double anchor_x = 0, anchor_y = 0, anchor_z = 0;
};
/// `composeNodeWorld3d`: orientation and rotation SUM per axis before the
/// degrees→radians conversion, then compose(...).
[[nodiscard]] Mat4 compose_node_3d(const Node3DTransform& v) noexcept;

/// What `parentWorld3d`'s resolvers answer for one node.
struct Node3D {
  std::int32_t parent = -1;
  bool is_3d = false;
  std::optional<Node3DTransform> local3d;  // read when is_3d
  Mat2D world2d;                           // read when !is_3d (already a WORLD matrix)
};

/// `parentWorld3d(nodeId)`: the accumulated 3D world of node `i`'s PARENT
/// chain, or nullopt when no ancestor is 3D (or there is no parent). A 2D
/// ancestor REPLACES the accumulator with its world matrix; a cycle stops the
/// walk (the TypeScript's `seen` set).
[[nodiscard]] std::optional<Mat4> parent_world_3d(std::span<const Node3D> nodes, std::size_t i);

// ── project3d.ts: the camera ────────────────────────────────────────────────

struct Orientation {
  double yaw = 0;    // degrees
  double pitch = 0;  // degrees
  std::optional<double> roll;
};

struct Camera {
  Vec3 position;
  double focal_length = 0;
  Vec2 principal;
  std::optional<Orientation> orientation;
};

struct Projected {
  double x = 0;
  double y = 0;
  double scale = 0;
  double depth = 0;
  bool clipped = false;
};

inline constexpr double kPerspectiveNear = 1;
inline constexpr double kPerspectiveFar = 100000;
inline constexpr double kOrthoDepthRange = 50000;

[[nodiscard]] double focal_length_for_fov(double width, double fov_deg) noexcept;
[[nodiscard]] double fov_for_focal_length(double width, double focal_length) noexcept;
[[nodiscard]] Camera default_camera(double width, double height, double fov_deg = 39.6) noexcept;
[[nodiscard]] Projected project_point(Vec3 p, const Camera& cam) noexcept;
[[nodiscard]] Mat4 camera_view_matrix(const Camera& cam) noexcept;
[[nodiscard]] Mat4 camera_projection_matrix(const Camera& cam) noexcept;

enum class OrthoView : std::uint8_t { kFront, kBack, kLeft, kRight, kTop, kBottom };
[[nodiscard]] Projected project_ortho(Vec3 p, OrthoView view, double width, double height) noexcept;
struct OrthoMatrices {
  Mat4 view;
  Mat4 projection;
};
[[nodiscard]] OrthoMatrices ortho_camera_matrices(OrthoView view, double width, double height) noexcept;

[[nodiscard]] Orientation look_at_orientation(Vec3 eye, Vec3 target) noexcept;
struct Orbited {
  Vec3 position;
  Orientation orientation;
};
[[nodiscard]] Orbited orbit_camera(Vec3 base_position, Vec3 poi, double yaw, double pitch) noexcept;

struct Ray {
  Vec3 origin;
  Vec3 direction;
};
[[nodiscard]] Ray unproject_screen_ray(double sx, double sy, const Camera& cam,
                                       std::optional<OrthoView> ortho = std::nullopt, double width = 1920,
                                       double height = 1080) noexcept;
[[nodiscard]] std::optional<Vec3> intersect_ray_plane(const Ray& ray, Vec3 plane_point, Vec3 plane_normal) noexcept;

// ── camera3d.ts: a camera layer → Camera ────────────────────────────────────

/// A camera node's geometry props (keyframed value, else static prop; absent =
/// nullopt), as `cameraFromNode` reads them.
struct CameraProps {
  std::optional<double> x, y, z, focal_length, orbit_yaw, orbit_pitch, poi_x, poi_y, poi_z;
  std::optional<double> orientation_x, orientation_y, orientation_z;
};
/// Lifts a point through the camera layer's parent chain (`worldOf`);
/// empty = identity.
using LiftFn = std::function<Vec3(Vec3)>;
[[nodiscard]] Camera camera_from_props(const CameraProps& p, double width, double height, const LiftFn& lift = {});

// ── layerSpace.ts: toComp / fromComp / toWorld / fromWorld ─────────────────

/// A 2D layer: the composition is the world plane.
struct LayerSpace2D {
  Mat2D world;
  Mat2D inverse;
  explicit LayerSpace2D(const Mat2D& w) : world(w), inverse(invert(w)) {}
  [[nodiscard]] Vec2 to_comp(Vec2 p) const noexcept { return transform_point(world, p); }
  [[nodiscard]] Vec2 from_comp(Vec2 p) const noexcept { return transform_point(inverse, p); }
  [[nodiscard]] Vec3 to_world(Vec2 p) const noexcept;
  [[nodiscard]] Vec2 from_world(Vec3 p) const noexcept { return from_comp({p.x, p.y}); }
};

/// A 3D layer (`m` = its world incl. parents) seen through `camera`.
struct LayerSpace3D {
  Mat4 m;
  std::optional<Mat4> inverse;
  Camera camera;
  double comp_width = 1920;
  double comp_height = 1080;
  Vec3 plane_point;
  Vec3 plane_normal;  // m·(0,0,1) − m·(0,0,0), NOT normalised (as the TypeScript)
  LayerSpace3D(const Mat4& world, const Camera& cam, double width, double height);
  [[nodiscard]] Vec3 to_world(Vec2 p) const noexcept;
  [[nodiscard]] Vec2 from_world(Vec3 p) const noexcept;
  [[nodiscard]] Vec2 to_comp(Vec2 p) const noexcept;
  /// Ray/plane; [0, 0] when the ray misses (as the TypeScript).
  [[nodiscard]] Vec2 from_comp(Vec2 p) const noexcept;
};

// ── buildSnapshot.ts `affineAt`: a 3D layer's screen-space affine ──────────

struct Affine3D {
  std::array<double, 6> matrix{};  // [X.x−O.x, X.y−O.y, Y.x−O.x, Y.y−O.y, O.x, O.y]
  Projected origin;                // O (clipped ⇒ the renderer drops the layer)
  Mat4 world{};                    // M
  double sx = 0;                   // hypot(m[0], m[1])
  double sy = 0;                   // hypot(m[2], m[3])
  double rotation_deg = 0;         // atan2(m[1], m[0]) / DEG
};
/// `affineAt`: L = compose(pos, (rot + orientation)·DEG, scale, anchor {0,0,anchorZ}),
/// M = parent3d ? parent3d·L : L, projected at the origin and the unit axes.
[[nodiscard]] Affine3D layer_affine_3d(const Node3DTransform& v, const std::optional<Mat4>& parent3d,
                                       const Camera& camera) noexcept;

}  // namespace motion::xf

#endif  // MOTION_TRANSFORM_TRANSFORM_HPP
