// Image-alpha puppet meshing (D1 render-side gap: "rigs on image layers") —
// src/core/rig/puppet.ts `coverageMaskFromImageData` / `coverageCovered` and
// src/core/rig/alphaMesh.ts (`alphaOutlineRegions`, `densityToSpacing`,
// `buildAlphaOutlineGeometry`: marching squares → Douglas–Peucker → miter
// offset → boundary resampling + hex Steiner lattice → Bowyer–Watson, clipped
// back to the region), line for line.
//
// An image layer's rest mesh is culled by (grid mode) or traced from
// (silhouette mode) a 64² alpha coverage grid of its decoded bitmap. Pure; the
// decode (imageAlphaCoverage.ts: the bitmap drawn into ≤64² and read back) is
// the caller's. Pinned by tests/data/alpha_mesh_parity.json
// (alphaMeshCrossEngine.test.ts).
#pragma once

#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <vector>

#include "extrude_mesh.hpp"

namespace premation::scene::rig {

/// PuppetCoverageMask: row-major (row 0 = top) 1 / 0 cells + the cache identity.
struct CoverageMask {
  int cols = 0, rows = 0;
  std::vector<std::uint8_t> cells;
  std::string key;
};

/// imageAlphaCoverage.ts COVERAGE_SAMPLES / ALPHA_THRESHOLD.
inline constexpr int kCoverageSamples = 64;
inline constexpr int kCoverageAlphaThreshold = 12;

/// `coverageMaskFromImageData({data, width, height}, {maxSamples, alphaThreshold})`.
[[nodiscard]] CoverageMask coverage_mask_from_image_data(std::span<const std::uint8_t> rgba, int width, int height,
                                                         double maxSamples = kCoverageSamples,
                                                         double alphaThreshold = kCoverageAlphaThreshold);

/// `coverageCovered(mask, x, y, width, height)` (layer-centred local space).
[[nodiscard]] bool coverage_covered(const CoverageMask& mask, double x, double y, double width, double height);

/// alphaMesh.ts AlphaRegion.
struct AlphaRegion {
  std::vector<mesh::Pt2> outer;
  std::vector<std::vector<mesh::Pt2>> holes;
};
/// `alphaOutlineRegions(mask, width, height, expansion)`.
[[nodiscard]] std::vector<AlphaRegion> alpha_outline_regions(const CoverageMask& mask, double width, double height,
                                                             double expansion = 0);
/// `densityToSpacing(width, height, density)`.
[[nodiscard]] double density_to_spacing(double width, double height, double density);

/// AlphaMeshGeometry: x, y, u, v per vertex (float32) and uint16 triangles.
struct AlphaMeshGeometry {
  std::vector<float> vertices;
  std::vector<std::uint16_t> triangles;
  std::size_t numVertices = 0;
};
/// `buildAlphaOutlineGeometry(width, height, pad, density, expansion, mask)`; nullopt = fall back to the grid.
[[nodiscard]] std::optional<AlphaMeshGeometry> build_alpha_outline_geometry(double width, double height, double pad, double density,
                                                                            double expansion, const CoverageMask& mask);

}  // namespace premation::scene::rig
