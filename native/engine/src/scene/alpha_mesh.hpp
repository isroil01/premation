// Image-alpha puppet meshing (D1 render-side gap: "rigs on image layers") —
// src/core/rig/puppet.ts `coverageMaskFromImageData` / `coverageCovered` and
// src/core/rig/alphaMesh.ts (`alphaOutlineRegions`, `densityToSpacing`,
// `buildAlphaOutlineGeometry`: marching squares → Douglas–Peucker → miter
// offset → boundary resampling + hex Steiner lattice → Bowyer–Watson, clipped
// back to the region), line for line.
//
// An image layer's rest mesh is culled by (grid mode) or traced from
// (silhouette mode) an alpha coverage grid of its decoded bitmap. Pure; the
// decode (rig_coverage.cpp) is the caller's.
//
// Two mask builders:
//   coverage_mask_from_image_data  the TypeScript's 64²/max-alpha mask, kept for
//                                  tests/data/alpha_mesh_parity.json;
//   coverage_mask_from_alpha       what the engine uses (R2, 2026-11-02): the
//                                  decoded alpha (`AlphaPlane`, ≤ 1024 px on its
//                                  long side) cut into cells of ~coverage_cell_px
//                                  (traceAccuracy) px up to 512 across, a cell kept
//                                  when at least kCoverageMinFill of its area has
//                                  alpha ≥ alphaThreshold. The mask carries its
//                                  plane so a layer's own trace settings re-derive
//                                  it (rig_mesh.cpp, cached by value).
#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <vector>

#include "extrude_mesh.hpp"

namespace premation::scene::rig {

/// A decoded image's alpha, box-reduced to at most kCoverageSourceMax on its long side.
struct AlphaPlane {
  int width = 0, height = 0;
  std::vector<std::uint8_t> alpha;  ///< row-major, row 0 = top
  std::string key;                  ///< value digest (dims + bytes)
};

/// PuppetCoverageMask: row-major (row 0 = top) 1 / 0 cells + the cache identity.
struct CoverageMask {
  int cols = 0, rows = 0;
  std::vector<std::uint8_t> cells;
  std::string key;
  /// The alpha this mask was cut from (null: a legacy / synthetic mask — no re-derivation).
  std::shared_ptr<const AlphaPlane> source;
};

/// imageAlphaCoverage.ts COVERAGE_SAMPLES / ALPHA_THRESHOLD (the legacy mask).
inline constexpr int kCoverageSamples = 64;
inline constexpr int kCoverageAlphaThreshold = 12;

/// The mesh settings of a rig that shape an image layer's coverage
/// (`traceAccuracy`, `alphaThreshold` on `fx.puppet` / `fx.skeleton`).
inline constexpr double kTraceAccuracyDefault = 60;  ///< 0–100 → coverage_cell_px 16 … 2 px
inline constexpr double kAlphaThresholdDefault = 32; ///< 0–255: a pixel counts as covered at or above it
inline constexpr int kCoverageSourceMax = 1024;      ///< the alpha plane's long side
inline constexpr int kCoverageMaxCells = 512;        ///< cells across the long side, at most
inline constexpr double kCoverageMinFill = 0.35;     ///< the share of a cell's area that must be covered
struct CoverageSettings {
  double traceAccuracy = kTraceAccuracyDefault;
  double alphaThreshold = kAlphaThresholdDefault;
};

/// The alpha of `rgba` (straight or premultiplied — only alpha is read), reduced to ≤ kCoverageSourceMax.
[[nodiscard]] std::shared_ptr<const AlphaPlane> alpha_plane_from_rgba(std::span<const std::uint8_t> rgba, int width, int height);
/// Cell size in source pixels for a trace accuracy: 16 px at 0, ~4.6 px at 60, 2 px at 100.
[[nodiscard]] double coverage_cell_px(double traceAccuracy);
/// The engine's mask: `plane` cut into cells by `s` (see the header comment).
[[nodiscard]] CoverageMask coverage_mask_from_alpha(std::shared_ptr<const AlphaPlane> plane, const CoverageSettings& s);

/// `coverageMaskFromImageData({data, width, height}, {maxSamples, alphaThreshold})` — the legacy mask.
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
