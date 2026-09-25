// polygon-clipping 0.15.7 (Martinez–Rueda sweep, mfogel) ported line for line,
// with the pieces its output depends on: splaytree 3.2.3 (w8r) — the event
// queue's comparator LINKS coincident points as a side effect, so the tree's
// exact sequence of comparisons is part of the result — and robust-predicates'
// orient2d (Shewchuk). The TypeScript's live Merge Paths (mergePaths.ts
// booleanPolygons) and Offset Paths' non-convex cleanup run this library, so the
// C++ must reproduce its rings bit for bit, start point and winding included.
//
// Geometry is GeoJSON-shaped: a ring is a closed list of [x, y] pairs (the
// output repeats its first point last), a polygon is its exterior ring then its
// holes, a multipolygon a list of polygons. Failures the JavaScript throws
// (a ring it cannot close, a runaway queue) throw std::runtime_error here.
#pragma once

#include <array>
#include <vector>

namespace premation::scene::pc {

using Pair = std::array<double, 2>;
using Ring = std::vector<Pair>;
using Polygon = std::vector<Ring>;
using MultiPolygon = std::vector<Polygon>;

enum class OpType : std::uint8_t { union_, intersection, xor_, difference };

/// `polygonClipping.<op>(subject, ...clipping)`.
[[nodiscard]] MultiPolygon run(OpType type, const MultiPolygon& subject, const std::vector<MultiPolygon>& clipping);

/// robust-predicates `orient2d(ax, ay, bx, by, cx, cy)` (the exact sign).
[[nodiscard]] double orient2d(double ax, double ay, double bx, double by, double cx, double cy);

}  // namespace premation::scene::pc
