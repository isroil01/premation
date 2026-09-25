// Height displacement for 3D materials — a byte-identical port of
// src/core/scene/heightDisplacement.ts (plan B1; D2w 3D leftovers).
//
// A height FIELD (row-major luma 0..1) pushes every vertex of an interleaved
// mesh (x y z nx ny nz u v) along its normal by (h − 0.5) · amount, after
// optional midpoint subdivision (each triangle → 4, order-preserving), then
// recomputes area-weighted normals pooled over vertices that share a position
// (a UV sphere's seam column and pole fans move and shade as one point).
//
// Byte-identical means the TypeScript's number types are reproduced, not just
// its maths: subdivision midpoints in double rounded once to float32, the
// normal accumulator is a Float32Array (every += rounds to float), heights
// are summed in doubles, lengths through V8's Math.hypot, and the displaced
// indices are always 32-bit. Pinned by tests/data/height_displacement_parity.json
// (src/core/scene/heightDisplacementCrossEngine.test.ts).
//
// Pure: no I/O, no decode. The field itself comes from height_field.hpp.
#pragma once

#include <cstdint>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace premation::scene {

/// HeightField: `width × height` luma samples, row-major, 0..1.
struct HeightField {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::vector<float> data;
};

inline constexpr std::size_t kDisplaceStride = 8;          ///< MESH_STRIDE
inline constexpr int kMaxDisplacementSubdivisions = 3;     ///< MAX_DISPLACEMENT_SUBDIVISIONS

struct DisplacedMesh {
  std::vector<float> vertices;
  std::vector<std::uint32_t> indices;  ///< always 32-bit (the TypeScript returns a Uint32Array)
  double triangleScale = 1;            ///< 4^subdivisions: a carrier's ranges remap by this
};

/// sampleHeight: bilinear, uv clamped to [0, 1], uv = 1 is the last texel.
[[nodiscard]] double sample_height(const HeightField& f, double u, double v);

/// subdivideMesh: midpoint-subdivide `times` (floored, clamped to 0..3) passes.
[[nodiscard]] DisplacedMesh subdivide_mesh(std::span<const float> vertices, std::span<const std::uint32_t> indices, double times);

/// positionGroups: vertices sharing a position AND (to 1/100) a normal share a group id.
[[nodiscard]] std::vector<std::int32_t> position_groups(std::span<const float> vertices);

/// recomputeNormals (in place), pooled over `groups` (position_groups when empty).
void recompute_normals(std::span<float> vertices, std::span<const std::uint32_t> indices, std::span<const std::int32_t> groups = {});

/// displaceMesh: subdivide, displace along normals by (h − 0.5) · amountPx, recompute normals.
[[nodiscard]] DisplacedMesh displace_mesh(std::span<const float> vertices, std::span<const std::uint32_t> indices, const HeightField& field,
                                          double amountPx, double subdivisions);

/// displacedMeshFor's cache key: `<meshKey>|disp:<fieldKey>:<amount.toFixed(3)>:<subdivisions>`.
[[nodiscard]] std::string displaced_mesh_key(std::string_view meshKey, std::string_view fieldKey, double amountPx, double subdivisions);

}  // namespace premation::scene
