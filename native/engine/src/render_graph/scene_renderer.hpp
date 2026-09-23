// SceneRenderer — the render graph's façade (core/renderer/Renderer.ts): owns
// the Dawn device services and the graph, renders one RenderFrameFile into an
// offscreen surface and reads it back. Used by `premation-render` (the parity
// harness + bench) and, from D5, by the engine's render thread.
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "device.hpp"
#include "frame_scene.hpp"
#include "graph.hpp"

namespace premation::rg {

struct RendererOptions {
  /// PCI vendor id to render on (0 = power preference decides).
  std::uint32_t vendorId = 0;
  bool highPerformance = true;
};

/// A read-back frame: top-down RGBA8, PREMULTIPLIED (the golden-reference convention).
struct Frame {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::vector<std::uint8_t> rgba;
};

struct FrameStats {
  double encodeMs = 0;   // CPU: graph execution + encoding
  double gpuMs = 0;      // submit → GPU idle (wall clock; measurement only)
  std::size_t collected = 0;
  std::vector<GraphDiagnostic> diagnostics;
  std::string gpuError;  // first uncaptured Dawn error during the frame, if any
};

class SceneRenderer {
 public:
  static std::unique_ptr<SceneRenderer> create(const RendererOptions& options, std::string& error);
  ~SceneRenderer();
  SceneRenderer(const SceneRenderer&) = delete;
  SceneRenderer& operator=(const SceneRenderer&) = delete;
  SceneRenderer(SceneRenderer&&) = delete;
  SceneRenderer& operator=(SceneRenderer&&) = delete;

  /// Render `file`. `readback` false skips the copy (bench). False only on a device-level failure.
  bool render(const api::RenderFrameFile& file, Frame* readback, FrameStats& stats, std::string& error);

  [[nodiscard]] const std::string& adapter() const noexcept { return adapter_; }
  [[nodiscard]] const std::string& backend() const noexcept { return backend_; }
  [[nodiscard]] Device& device() noexcept { return *dev_; }
  [[nodiscard]] RenderGraph& graph() noexcept { return *graph_; }

 private:
  SceneRenderer() = default;
  std::unique_ptr<Device> dev_;
  std::unique_ptr<RenderGraph> graph_;
  wgpu::Texture surface_;
  wgpu::TextureView surfaceView_;
  std::uint32_t surfaceW_ = 0;
  std::uint32_t surfaceH_ = 0;
  std::string adapter_;
  std::string backend_;
};

}  // namespace premation::rg
