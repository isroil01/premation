// Bitmap → outlines: the port of src/core/geometry/traceBitmap.ts (the
// tracer) and of the per-frame half of src/core/effects/autoTrace.ts (ring
// layout: outer rings first, then holes, pulled into layer space and
// simplified again). Pure: no ffmpeg, no document — tests/test_jobs_trace.cpp
// feeds it synthetic planes.
//
// The algorithm (see traceBitmap.ts for the long form): threshold to a binary
// mask with a one-pixel border; raster-scan for outer borders (outside→inside
// with the pixel unvisited) and hole borders (inside→outside); walk each
// border along pixel EDGES with the inside on the walker's right, emitting a
// vertex wherever the heading changes; drop rings under `minArea`; simplify
// each ring with Ramer–Douglas–Peucker split at the vertex farthest from the
// first. Coordinates are image pixels, (0,0) the top-left corner of the
// top-left pixel.
#pragma once

#include <cstdint>
#include <span>
#include <string_view>
#include <vector>

#include "media_input.hpp"

namespace premation::jobs::trace {

struct TracePoint {
  double x = 0;
  double y = 0;
  bool operator==(const TracePoint&) const = default;
};

struct TracedContour {
  std::vector<TracePoint> points;
  /// True for an inner border (the region's hole), false for an outer one.
  bool hole = false;
};

struct TraceOptions {
  /// 0…255 value at or above which a pixel is "inside" (traceBitmap.ts default 128).
  double threshold = 128;
  /// RDP tolerance in pixels. 0 keeps every edge vertex.
  double tolerance = 1;
  /// Drop contours with less area (pixels²) than this.
  double minArea = 4;
};

/// Signed area (shoelace); positive = clockwise in y-down image space.
[[nodiscard]] double signed_area(std::span<const TracePoint> pts) noexcept;

/// Simplify a closed ring (traceBitmap.ts `simplifyRing`): split at the vertex
/// farthest from the first, RDP each half, drop collinear survivors.
[[nodiscard]] std::vector<TracePoint> simplify_ring(std::span<const TracePoint> pts, double eps);

/// Trace every region of an 8-bit plane (traceBitmap.ts `traceBitmap`). The
/// value is read from the LAST byte of each `stride`-byte pixel (1: a plane,
/// 4: RGBA alpha). `src` holds at least w·h·stride bytes.
[[nodiscard]] std::vector<TracedContour> trace_bitmap(std::span<const std::uint8_t> src, std::uint32_t w,
                                                      std::uint32_t h, std::uint32_t stride, const TraceOptions& opts);

// ── Auto-trace (autoTrace.ts) ──────────────────────────────────────────

enum class Channel : std::uint8_t { alpha, luminance, red, green, blue };

/// `alpha`, `luminance`, `red`, `green`, `blue` ('' = alpha). False for anything else.
[[nodiscard]] bool parse_channel(std::string_view s, Channel& out) noexcept;

/// One 8-bit plane from a straight-RGBA frame. The colour channels are read
/// as the layer draws over transparency — premultiplied by alpha (autoTrace.ts
/// traced the layer rendered alone on a transparent comp, so an invisible
/// pixel never reads as bright). Luminance is Rec. 709. `invert` = 255 − v.
[[nodiscard]] std::vector<std::uint8_t> channel_plane(const RgbaImage& img, Channel ch, bool invert);

/// Box blur of a plane with integer radius round(`radius`) (0 = unchanged),
/// horizontal then vertical, each window clipped to the image and averaged
/// over the pixels it covers, rounded half up. Deterministic integer maths.
[[nodiscard]] std::vector<std::uint8_t> box_blur(std::span<const std::uint8_t> plane, std::uint32_t w, std::uint32_t h,
                                                 double radius);

struct AutoTraceParams {
  /// 0…255 (the job's 0…1 × 255).
  double threshold = 128;
  /// autoTrace.ts default 1.5 (layer pixels, applied in plane pixels as traceBitmap's tolerance).
  double tolerance = 1.5;
  /// Layer pixels² (autoTrace.ts default 16).
  double minArea = 16;
};

/// A mask ring in LAYER space: centred on the layer (x ∈ [−w/2, w/2]), unscaled.
struct MaskRing {
  std::vector<TracePoint> points;
  bool hole = false;
};

/// Trace one frame's plane (plane pixels `pw`×`ph`) into the mask rings
/// autoTrace.ts writes: contours of ≥ 3 points, outer rings first then holes
/// (each group in trace order), mapped plane → layer pixels (× layerW / pw,
/// × layerH / ph) → centred layer space, then simplified again at 0.25.
[[nodiscard]] std::vector<MaskRing> auto_trace_rings(std::span<const std::uint8_t> plane, std::uint32_t pw,
                                                     std::uint32_t ph, double layerW, double layerH,
                                                     const AutoTraceParams& params);

}  // namespace premation::jobs::trace
