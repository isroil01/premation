// Mask vertex sampling — src/core/tracking/maskVertexSampling.ts, ported
// operation for operation: which vertices of a mask the tracker follows (at
// most `cap`, evenly spaced by arc length), and how every other vertex rides
// its two nearest tracked neighbours along the path. Within the cap it is the
// identity (every vertex its own slot, in path order). Pure.
#pragma once

#include <cstddef>
#include <vector>

namespace premation::jobs::masksample {

struct Pt {
  double x = 0;
  double y = 0;
};

struct SamplablePath {
  std::vector<Pt> points;
  /// Closed loops wrap: the last vertex neighbours the first.
  bool closed = true;
};

/// How an UNTRACKED vertex derives its delta: slots `a` → `b`, parameter `w`.
struct VertexBlend {
  int a = 0;
  int b = 0;
  double w = 0;
};

struct VertexSampling {
  /// Flat vertex index (paths concatenated, in order) tracked by each slot.
  std::vector<int> tracked;
  /// Per flat vertex: its slot, or -1 when it is interpolated.
  std::vector<int> slotOf;
  /// Per flat vertex: the blend that moves it.
  std::vector<VertexBlend> blend;
  int total = 0;
};

/// MAX_TRACKED_VERTICES.
inline constexpr int kMaxTrackedVertices = 64;

/// `sampleMaskVertices`. Throws EngineFail (invalidArgument) when more paths than `cap` cannot share it.
[[nodiscard]] VertexSampling sample_mask_vertices(const std::vector<SamplablePath>& paths, int cap = kMaxTrackedVertices);

/// `blendVertexDeltas`.
[[nodiscard]] std::vector<Pt> blend_vertex_deltas(const VertexSampling& s, const std::vector<Pt>& slotDeltas);

}  // namespace premation::jobs::masksample
