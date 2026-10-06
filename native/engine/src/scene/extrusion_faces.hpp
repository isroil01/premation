// The extrusion FALLBACK geometry (D2w 3D leftovers) — src/core/scene/extrusion.ts
// `extrusionGeometry` / `clampBevel`, line for line: the flat face planes a 3D
// layer's body is drawn with when the mesh path cannot produce one (a rect or
// ellipse under a spatial effect or an interior layer style: back cap, walls,
// optional 45° chamfer rings; a rounded rect's outline ring; an ellipse's chord
// ring). Each face's matrix maps its own centred w×h plane into the layer's
// centred frame (Matrix4Math.compose, T · Rz · Ry · Rx).
//
// The slice-stack constants for text / complex paths with no traceable outline
// live here too. Pure; pinned by tests/data/extrusion_faces_parity.json
// (extrusionFacesCrossEngine.test.ts).
#pragma once

#include <array>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "transform.hpp"

namespace premation::scene::extrude {

inline constexpr double kWallGain = 0.72;             ///< EXTRUSION_WALL_GAIN
inline constexpr double kBackGain = 0.55;             ///< EXTRUSION_BACK_GAIN
inline constexpr int kEllipseWallSegments = 20;       ///< ELLIPSE_WALL_SEGMENTS
inline constexpr int kGradientWallSegments = 20;      ///< GRADIENT_WALL_SEGMENTS
inline constexpr double kSeamOverlap = 0.25;          ///< SEAM_OVERLAP
inline constexpr int kRoundedCornerSegments = 6;      ///< ROUNDED_CORNER_SEGMENTS
inline constexpr double kSliceStepPx = 1.5;           ///< EXTRUSION_SLICE_STEP_PX
inline constexpr int kMaxSlices = 400;                ///< MAX_EXTRUSION_SLICES

struct Face {
  motion::xf::Mat4 m{};  ///< face-local centred px → layer-local centred px
  double w = 0, h = 0;
  bool back = false;     ///< role 'back' (else 'wall')
  std::string suffix;    ///< back, r l t b, r0…, w0…, cfr… / cbr…
};

struct Geometry {
  std::vector<Face> faces;
  double bevel = 0;  ///< the chamfer actually emitted (clamped; 0 = none)
};

struct Options {
  double bevel = 0;
  double cornerRadius = 0;
  /// Per-corner radii TL, TR, BR, BL; when set they win over `cornerRadius`.
  std::optional<std::array<double, 4>> cornerRadii;
  double wallSegments = 1;
};

/// `clampBevel(w, h, d, bevel)`.
[[nodiscard]] double clamp_bevel(double w, double h, double d, double bevel);

/// `extrusionGeometry(w, h, d, shape, segments, opts)`; `ellipse` false = 'rect'.
[[nodiscard]] Geometry extrusion_geometry(double w, double h, double d, bool ellipse, double segments = kEllipseWallSegments,
                                          const Options& opts = {});

/// faceMaterials.ts `faceKindOf(role, suffix)`: back / bevel (a `c…` chamfer) / side.
[[nodiscard]] std::string_view face_kind_of(const Face& f);

}  // namespace premation::scene::extrude
