// What the document core hands the render thread: an EVALUATED frame, as plain
// data. The render thread never sees the document, so the core can keep
// editing while a frame is on the GPU, and a frame is a pure function of
// (document revision, comp time) — no clock, no RNG (CLAUDE.md determinism).
#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace premation {

/// One filled quad: the unit square [0,1]² mapped into comp pixels by
/// x' = a·u + c·v + e, y' = b·u + d·v + f (y down), filled with `color`
/// (straight sRGB-encoded RGB, alpha already multiplied by the layer opacity).
struct DrawQuad {
  std::array<float, 6> affine{};  // a b c d e f
  std::array<float, 4> color{};
  bool operator==(const DrawQuad&) const = default;
};

struct FrameScene {
  std::uint32_t compWidth = 0;
  std::uint32_t compHeight = 0;
  std::array<float, 4> background{0.0F, 0.0F, 0.0F, 1.0F};  // straight sRGB
  std::vector<DrawQuad> quads;  // back to front
  bool operator==(const FrameScene&) const = default;
};

/// D2w: a frame the engine's scene builder produced from its own document
/// (scene/built_frame.hpp) — opaque here; the render thread draws it through
/// the render graph instead of the C2 quad compositor.
struct BuiltFrame;

struct RenderJob {
  FrameScene scene;
  // shared_ptr: handed core thread → render thread exactly once and destroyed
  // wherever the job dies (including translation units that see only the
  // forward declaration above) — shared_ptr type-erases the deleter.
  std::shared_ptr<BuiltFrame> built;
  std::uint32_t viewport = 0;
  std::int64_t frame = 0;
  std::int64_t time = 0;       // flicks
  std::uint64_t revision = 0;
  /// Frames the clock skipped before this one (reported with the frame).
  std::uint32_t clockDropped = 0;
};

/// A viewport's output: slot textures of width × height physical pixels.
struct ViewportConfig {
  std::uint32_t viewport = 0;
  std::uint32_t width = 0;   // physical px (CSS px × DPR)
  std::uint32_t height = 0;
  /// Preview resolution (full 1, half 0.5, third, quarter): the comp is
  /// rendered at this fraction and scaled up into the slot.
  double resolution = 1.0;
  bool open = false;
  /// D5: the page's view of the comp — screen CSS px per comp px, and the comp
  /// point at the viewport's centre (snapshotToFrameScene viewToCamera). zoom ≤ 0
  /// = fit the comp into the viewport (export_view).
  double zoom = 0.0;
  double panX = 0.0;
  double panY = 0.0;
  /// CSS px per physical px of the slot (the slot is width × height physical px).
  double devicePixelRatio = 1.0;
  bool operator==(const ViewportConfig&) const = default;
};

/// D5: does going from `a` to `b` need a new slot ring? Only the slot
/// geometry does (which viewport, its physical size, open/closed, the preview
/// resolution). The camera (zoom / pan / DPR at the same physical size) is
/// baked into each job by the frame builder, so a hand-tool drag or a wheel
/// zoom — a setViewport per pointer move — must not re-create the shared
/// textures (and drop every frame in flight) 60 times a second.
[[nodiscard]] inline bool ring_config_changed(const ViewportConfig& a, const ViewportConfig& b) {
  return a.viewport != b.viewport || a.width != b.width || a.height != b.height || a.open != b.open ||
         a.resolution != b.resolution;
}

struct RenderCounters {
  std::uint64_t rendered = 0;
  std::uint64_t dropped = 0;     // ring full or superseded before rendering
  double gpuFrameMs = 0;         // mean over the last second
  double fps = 0;                // delivered frames per second, last second
};

/// The render side as the document core sees it. Implemented by the render
/// thread (render/render_thread.cpp) and by a null sink in tests and fuzzing.
class FrameSink {
 public:
  FrameSink() = default;
  virtual ~FrameSink() = default;
  FrameSink(const FrameSink&) = delete;
  FrameSink& operator=(const FrameSink&) = delete;
  FrameSink(FrameSink&&) = delete;
  FrameSink& operator=(FrameSink&&) = delete;

  /// Newest job wins: a job not yet started when a newer one arrives is dropped.
  virtual void submit(RenderJob job) = 0;
  virtual void configure(const ViewportConfig& config) = 0;
  /// Use shared (cross-process) slot textures. Called once, from Hello.
  virtual void set_shared(bool shared) = 0;
  [[nodiscard]] virtual bool shared_supported() const = 0;
  [[nodiscard]] virtual RenderCounters counters() const = 0;
  [[nodiscard]] virtual std::string adapter() const = 0;
  [[nodiscard]] virtual std::string backend() const = 0;
};

}  // namespace premation
