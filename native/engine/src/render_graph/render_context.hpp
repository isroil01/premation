// What every pass is handed (RenderPassContext + RenderServices in the TS graph).
#pragma once

#include <array>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "device.hpp"
#include "frame_scene.hpp"
#include "graph.hpp"
#include "uniforms.hpp"

namespace premation::rg {

/// Viewport + Camera2D (viewport/Viewport.ts, camera/Camera2D.ts).
struct ViewportState {
  double cssWidth = 1, cssHeight = 1, dpr = 1;
  double centerX = 0, centerY = 0, zoom = 1;
  std::uint32_t pixelWidth = 1, pixelHeight = 1;
  Mat3 viewProjection;
  Rect visibleWorldRect;

  static ViewportState from(const api::RenderView& v) noexcept;
};

/// mvpFor(viewport, model).
inline Mat3 mvp_for(const ViewportState& vp, const Mat3& model) noexcept { return mul(vp.viewProjection, model); }

/// The 3D frame depth groups draw under (FrameScene camera3d / lights3d /
/// envMap / ssao). A sealed precomp swaps in its own for its subtree.
struct Scope3D {
  const api::RenderCamera3D* camera3d = nullptr;
  const std::vector<api::RenderLight3D>* lights3d = nullptr;
  const api::RenderEnvMap* env_map = nullptr;
  bool ssao = false;
  static Scope3D of(const api::RenderFrameScene& s);
};

struct PassContext {
  Device& dev;
  const api::RenderFrameFile& file;
  const TextureTable& textures;
  const ViewportState& viewport;
  ColorPipeline color;
  /// Graph targets resolved this frame (name → target). Absent = surface.
  std::unordered_map<std::string, RenderTarget*> targets;
  wgpu::TextureView surfaceView;
  wgpu::TextureFormat surfaceFormat = wgpu::TextureFormat::BGRA8Unorm;
  std::optional<std::array<std::uint32_t, 4>> surfaceScissor;
  /// EffectPass.activeColorTarget.
  std::string activeColorTarget;
  std::vector<GraphDiagnostic>& diagnostics;
  /// Scratch uniform floats (reused).
  std::vector<float> scratch;
  /// The current 3D scope (see Scope3D).
  Scope3D scope;

  /// ctx.target(name): nullptr = the surface (or an undeclared name).
  [[nodiscard]] RenderTarget* target(std::string_view name) const {
    const auto it = targets.find(std::string(name));
    return it == targets.end() ? nullptr : it->second;
  }
  [[nodiscard]] Packer packer() { return Packer(scratch, color); }
  /// A sampled blob by key, uploaded on first use.
  [[nodiscard]] TexRef texture(std::string_view key);
  /// Whether `key` resolved to real (ready) pixels when the frame was captured.
  [[nodiscard]] bool texture_ready(std::string_view key) const { return textures.resolve(key).ready; }
  [[nodiscard]] SamplerRef linear_clamp() { return dev.sampler("linear-clamp", wgpu::FilterMode::Linear, wgpu::AddressMode::ClampToEdge); }
  [[nodiscard]] SamplerRef nearest_clamp() { return dev.sampler("nearest-clamp", wgpu::FilterMode::Nearest, wgpu::AddressMode::ClampToEdge); }
  [[nodiscard]] SamplerRef linear_repeat() { return dev.sampler("linear-repeat", wgpu::FilterMode::Linear, wgpu::AddressMode::Repeat); }

  /// beginViewportPass + execute + end, in one: draw `cmds` into `name` (cleared when `clear`).
  void draw_into(std::string_view name, const Commands& cmds, bool clear, const Color& clearColor = Color::transparent());
  /// Same with an explicit viewport size (beginSizedPass).
  void draw_into_sized(std::string_view name, const Commands& cmds, bool clear, std::uint32_t w, std::uint32_t h);
};

}  // namespace premation::rg
