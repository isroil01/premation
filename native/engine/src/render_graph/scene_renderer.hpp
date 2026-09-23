// SceneRenderer — the render graph's façade (core/renderer/Renderer.ts): owns
// the Dawn device services and the graph, renders one RenderFrameFile into an
// offscreen surface and reads it back. Used by `premation-render` (the parity
// harness + bench) and, from D5, by the engine's render thread.
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "bit_depth.hpp"
#include "device.hpp"
#include "frame_scene.hpp"
#include "graph.hpp"

namespace premation::rg {

class ColorSystem;
class ExternalTextureSource;

struct RendererOptions {
  /// PCI vendor id to render on (0 = power preference decides).
  std::uint32_t vendorId = 0;
  bool highPerformance = true;
  /// E1: further device features to request when the adapter offers them
  /// (media::wanted_device_features — shared-surface import, multi-planar video formats).
  std::vector<wgpu::FeatureName> optionalFeatures;
};

/// A read-back frame: top-down RGBA8, PREMULTIPLIED (the golden-reference convention).
struct Frame {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::vector<std::uint8_t> rgba;
};

/// A graph target read back as float RGBA (premultiplied, working space), top-down.
struct TargetPixels {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  wgpu::TextureFormat format = wgpu::TextureFormat::Undefined;
  std::vector<float> rgba;
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

  /// Read back graph target `name` as the last frame left it (tests and tools:
  /// the float scene-color before the display encode). False when the last
  /// frame did not declare it.
  bool read_target(std::string_view name, TargetPixels& out, std::string& error);

  /// The intermediate precision the last frame rendered at (bit_depth.hpp).
  [[nodiscard]] IntermediatePrecision precision() const noexcept { return precision_; }
  /// This device filters and blends rgba32float (32-bit projects render at 32).
  [[nodiscard]] bool supports_float32() const noexcept { return float32_; }

  [[nodiscard]] const std::string& adapter() const noexcept { return adapter_; }
  [[nodiscard]] const std::string& backend() const noexcept { return backend_; }
  [[nodiscard]] Device& device() noexcept { return *dev_; }
  [[nodiscard]] RenderGraph& graph() noexcept { return *graph_; }
  [[nodiscard]] ColorSystem& color_system() noexcept { return *colorSystem_; }
  /// E1: where hashes with no blob resolve (the media system); nullptr = none.
  void set_external_textures(ExternalTextureSource* source) noexcept { external_ = source; }

 private:
  SceneRenderer() = default;
  std::unique_ptr<Device> dev_;
  std::unique_ptr<RenderGraph> graph_;
  std::unique_ptr<ColorSystem> colorSystem_;
  ExternalTextureSource* external_ = nullptr;
  wgpu::Texture surface_;
  wgpu::TextureView surfaceView_;
  std::uint32_t surfaceW_ = 0;
  std::uint32_t surfaceH_ = 0;
  bool float32_ = false;
  IntermediatePrecision precision_ = IntermediatePrecision::float16;
  /// The last frame's graph targets (moved out of its PassContext, so no copy).
  /// Pool entries touched this frame outlive the next 120 frames' GC.
  std::unordered_map<std::string, RenderTarget*> lastTargets_;
  std::string adapter_;
  std::string backend_;
};

}  // namespace premation::rg
