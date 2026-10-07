// Content-Aware Fill, AE parity step 3.7: the fill the job runs.
//
// content_aware.hpp is the single-scale PatchMatch ported from the TS engine
// (kept for its tests and as the per-level solver's reference); this file adds
// what After Effects' panel has:
//
//   - multi-scale PatchMatch with patch voting (coarse-to-fine, the
//     nearest-neighbour field upsampled between levels), so large holes get
//     structure from the coarse levels and texture from the fine ones;
//   - holes from the mask's Béziers (tangents, expansion, add / subtract,
//     inverted), not from its vertices as a straight polygon;
//   - fill modes: Object (synthesis + temporal propagation), Surface
//     (temporal propagation, the rest a smooth membrane — no synthesis) and
//     Edge Blend (each frame a membrane from the hole's edge, no temporal);
//   - lighting correction (off / subtle / moderate / strong): the boundary
//     mismatch between the fill and the frame is spread across the hole as a
//     smooth offset, scaled by the strength;
//   - reference frames: a clean plate the user painted for a frame fills that
//     frame's hole and anchors propagation;
//   - sequences of any length: the job feeds windows of frames, each carrying
//     the previous window's last filled frame as an anchor.
//
// Pictures are straight RGBA8, rows top-down; holes one byte per pixel
// (non-zero = fill). Pure and deterministic (seeded PRNG, no wall clock).
#pragma once

#include <cstdint>
#include <optional>
#include <span>
#include <vector>

namespace premation::jobs::caf {

enum class FillMode : std::uint8_t { object, surface, edgeBlend };
enum class Lighting : std::uint8_t { off, subtle, moderate, strong };

/// Strength of a lighting setting (0 … 1).
[[nodiscard]] double lighting_strength(Lighting l) noexcept;

struct BezierPt {
  double x = 0;
  double y = 0;
  double inX = 0;
  double inY = 0;
  double outX = 0;
  double outY = 0;
};

/// One mask path, already in picture pixels.
struct HolePath {
  std::vector<BezierPt> points;
  bool closed = true;
  /// Grow (+) or shrink (−) the hole, in picture pixels.
  double expansion = 0;
  /// A `subtract` mask cuts its area out of the hole.
  bool subtract = false;
  bool inverted = false;
};

/// The path's outline as a polyline (16 samples a segment), expansion applied
/// to the anchors and handles along the averaged normal (mask.ts).
[[nodiscard]] std::vector<std::pair<double, double>> flatten_path(const HolePath& path, int samplesPerSegment = 16);

/// The hole of a set of paths: added paths unioned, subtracted ones removed;
/// an inverted path counts its outside. Returns the hole pixel count.
int raster_hole_paths(std::span<std::uint8_t> hole, int width, int height, std::span<const HolePath> paths);

/// Grow (radius > 0) the hole by a square structuring element; no-op at 0.
void dilate_hole(std::span<std::uint8_t> hole, int width, int height, int radius);

struct MultiscaleOptions {
  int patchHalf = 3;
  /// PatchMatch iterations at the coarsest level, and at every finer one.
  int coarseIterations = 6;
  int fineIterations = 3;
  /// Stop building the pyramid when the short side is at most this.
  int minSide = 24;
  std::uint32_t seed = 0x9e3779b9u;
};

/// Multi-scale PatchMatch with voting. Fills `rgba` where the hole is set.
/// Returns the hole count (0 when there is nothing to fill or copy from).
int inpaint_multiscale(std::span<std::uint8_t> rgba, int width, int height, std::span<const std::uint8_t> hole,
                       const MultiscaleOptions& opts = {});

/// Membrane fill: the hole is the smooth (harmonic) interpolation of its
/// edge (Edge Blend). Coarse-to-fine Jacobi, deterministic. Returns the hole count.
int edge_blend_fill(std::span<std::uint8_t> rgba, int width, int height, std::span<const std::uint8_t> hole);

/// Lighting correction: measure, on the pixels just outside the hole, how far
/// the fill's continuation (the inner ring) is from the frame, and add the
/// harmonic interpolation of that difference across the hole × `strength`.
void correct_lighting(std::span<std::uint8_t> rgba, int width, int height, std::span<const std::uint8_t> hole, double strength);

/// Warp `from` (fully filled) into `to`'s hole by dense flow; clears the hole
/// where it wrote. Returns the pixels written.
int warp_into_hole(std::span<const std::uint8_t> from, std::span<std::uint8_t> to, int width, int height,
                   std::span<std::uint8_t> hole);

struct SequenceOptions {
  FillMode mode = FillMode::object;
  Lighting lighting = Lighting::off;
  MultiscaleOptions synthesis;
};

struct SequenceFrame {
  std::vector<std::uint8_t> rgba;
  /// The hole to fill; cleared as the frame fills.
  std::vector<std::uint8_t> hole;
  /// A clean plate for this frame (same size), or empty.
  std::vector<std::uint8_t> reference;
  /// Already filled (an anchor carried from the previous window): never changed.
  bool anchor = false;
};

struct SequenceStats {
  int synthesized = 0;
  int propagated = 0;
  int blended = 0;
  int fromReference = 0;
};

/// Fill a window of frames. Frames with a reference (or `anchor`) are the
/// sources; Object synthesises the first frame when there is none. Then flow
/// carries fills forward and backward; what is left is synthesised (Object)
/// or blended (Surface). Edge Blend blends every frame on its own. Lighting
/// correction runs last on every non-anchor frame against its original hole.
SequenceStats fill_sequence(std::vector<SequenceFrame>& frames, int width, int height, const SequenceOptions& opts);

}  // namespace premation::jobs::caf
