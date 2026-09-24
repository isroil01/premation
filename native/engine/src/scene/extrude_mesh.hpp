// Outline → extruded triangle mesh, and the outlines it sweeps — the TypeScript
// it ports, call for call:
//
//   extrude_outline / clamp_mesh_bevel / rect_outline / ellipse_outline /
//   bezier_runs_to_rings        src/core/geometry/extrudeMesh.ts
//   triangulate_rings / group_rings / signed_area / dedupe_ring
//                               src/core/geometry/polygonTriangulate.ts
//   trace_bitmap / smooth_contour
//                               src/core/geometry/traceBitmap.ts
//
// Float64 throughout with V8 Math (motion::js) wherever the TypeScript calls
// Math.*; the vertex buffer rounds to float32 once, at the end, exactly where
// the TypeScript builds its Float32Array — so the bytes are the TypeScript's.
#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <span>
#include <vector>

namespace premation::scene::mesh {

struct Pt2 {
  double x = 0;
  double y = 0;
};

struct Ring {
  std::vector<Pt2> points;
  bool hole = false;
};

enum class MeshRole : std::uint8_t { back, side, bevel, front };
enum class BevelProfile : std::uint8_t { angular, concave, convex };

struct Box {
  double x = 0;
  double y = 0;
  double width = 1;
  double height = 1;
};

struct ExtrudeOptions {
  double depth = 0;
  double bevel = 0;
  BevelProfile bevelStyle = BevelProfile::angular;
  std::optional<double> bevelSegments;
  double smoothAngleDeg = 35;
  bool frontCap = false;
  bool frontBevel = true;
  double holeBevelScale = 1;
  bool backCap = true;
  std::optional<Box> uvBox;
};

struct MeshRange {
  MeshRole role = MeshRole::back;
  std::uint32_t first = 0;
  std::uint32_t count = 0;
};

/// Interleaved x y z nx ny nz u v (8 floats, 32 bytes per vertex).
struct ExtrudedMesh {
  std::vector<float> vertices;
  std::uint32_t vertexCount = 0;
  std::vector<std::uint32_t> indices;
  /// Uint32Array in the TypeScript (vertexCount > 65535); Uint16Array otherwise.
  bool index32 = false;
  std::vector<MeshRange> ranges;
  /// Bevel actually applied (after clamping), px.
  double bevel = 0;
};

inline constexpr std::size_t kMeshVertexFloats = 8;

// ── polygonTriangulate.ts ─────────────────────────────────────────────────
[[nodiscard]] double signed_area(std::span<const Pt2> pts) noexcept;
[[nodiscard]] std::vector<Pt2> dedupe_ring(std::span<const Pt2> pts, double eps = 1e-6);
struct Triangulation {
  std::vector<Pt2> vertices;
  std::vector<std::uint32_t> triangles;
};
[[nodiscard]] Triangulation triangulate_rings(std::span<const Pt2> outer, std::span<const std::vector<Pt2>> holes);
struct RingGroup {
  std::vector<Pt2> outer;
  std::vector<std::vector<Pt2>> holes;
};
[[nodiscard]] std::vector<RingGroup> group_rings(std::span<const Ring> rings);
[[nodiscard]] bool point_in_ring(Pt2 p, std::span<const Pt2> ring) noexcept;

// ── extrudeMesh.ts ────────────────────────────────────────────────────────
[[nodiscard]] double clamp_mesh_bevel(std::span<const Ring> rings, double depth, double bevel);
[[nodiscard]] std::optional<ExtrudedMesh> extrude_outline(std::span<const Ring> rings, const ExtrudeOptions& opts);
/// Per-corner radii TL→TR→BR→BL.
[[nodiscard]] std::vector<Ring> rect_outline(double width, double height, std::array<double, 4> radii, int segmentsPer90 = 8);
[[nodiscard]] std::vector<Ring> ellipse_outline(double width, double height, std::optional<int> segments = std::nullopt);

/// A Bézier vertex with ABSOLUTE in / out handles.
struct BezPt {
  double x = 0;
  double y = 0;
  double inX = 0;
  double inY = 0;
  double outX = 0;
  double outY = 0;
};
struct BezRun {
  std::vector<BezPt> points;
  bool open = false;
};
[[nodiscard]] std::vector<Ring> bezier_runs_to_rings(std::span<const BezRun> runs, double tolerance = 0.75);

// ── traceBitmap.ts ────────────────────────────────────────────────────────
struct TracedContour {
  std::vector<Pt2> points;
  bool hole = false;
};
struct TraceOptions {
  double threshold = 128;
  double tolerance = 1;
  double minArea = 4;
};
/// `stride` bytes per pixel; the value is the LAST byte of each pixel.
[[nodiscard]] std::vector<TracedContour> trace_bitmap(std::span<const std::uint8_t> src, int w, int h, int stride,
                                                      const TraceOptions& opts);
[[nodiscard]] std::vector<Pt2> simplify_ring(std::span<const Pt2> pts, double eps);
/// smoothContour with a corner angle (the TYPE form).
[[nodiscard]] std::vector<BezPt> smooth_contour(std::span<const Pt2> pts, double tension, std::optional<double> cornerAngleDeg);

}  // namespace premation::scene::mesh
