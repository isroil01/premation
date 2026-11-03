// What every pass is handed (RenderPassContext + RenderServices in the TS graph).
#pragma once

#include <algorithm>
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

class ColorSystem;
class NativeEffectHost;  // effect_chain.hpp (G1)
class FxCache;           // fx_cache.hpp (E4)
struct SceneCache3D;     // scene_cache3d.hpp (E5)
struct EffectStats;      // effect_stats.hpp (E4)

/// E1: textures another engine system owns (the media system's decoded video
/// frames), named by the RenderTextureRef.hash a frame carries with no blob.
/// Called on the render thread, during the frame; an empty TexRef = not
/// available (the draw is skipped, as for an unresolved key). TexRef.id must be
/// stable per texture object and must not collide with Device ids (use the
/// high bit).
class ExternalTextureSource {
 public:
  ExternalTextureSource() = default;
  virtual ~ExternalTextureSource() = default;
  ExternalTextureSource(const ExternalTextureSource&) = delete;
  ExternalTextureSource& operator=(const ExternalTextureSource&) = delete;
  ExternalTextureSource(ExternalTextureSource&&) = delete;
  ExternalTextureSource& operator=(ExternalTextureSource&&) = delete;
  [[nodiscard]] virtual TexRef external_texture(std::string_view hash) = 0;
  /// The same picture with a full mip chain (a 3D layer seen at a steep angle
  /// samples it minified: without mips a 1 px stroke breaks into dots). The
  /// default has none to offer.
  /// `fp`: the quad it is drawn over — the chain is built as deep as that
  /// draw samples (Device::mip_texture, mip_levels_needed).
  [[nodiscard]] virtual TexRef external_texture_mipmapped(std::string_view hash, const MipFootprint& fp = {}) {
    (void)fp;
    return external_texture(hash);
  }
};

/// Viewport + Camera2D (viewport/Viewport.ts, camera/Camera2D.ts).
struct ViewportState {
  double cssWidth = 1, cssHeight = 1, dpr = 1;
  double centerX = 0, centerY = 0, zoom = 1;
  std::uint32_t pixelWidth = 1, pixelHeight = 1;
  Mat3 viewProjection;
  Rect visibleWorldRect;
  /// The transport is playing (SceneRenderer::set_playing): a 2D layer's effect
  /// chain is drawn on a whole pixel and composited through the fraction, so a
  /// layer in motion reuses its chain every frame (composition_pass.cpp P8b).
  /// Paused, the layer is drawn at its own phase: exact, never resampled.
  bool playing = false;

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
  /// AE parity 4.8: the scope's fog; 4.3: its shadow catcher.
  const api::RenderFog* fog = nullptr;
  const api::RenderShadowCatcher* shadowCatcher = nullptr;
  /// Every renderable of the scope (the comp's, or a sealed precomp's
  /// children): shadow casters are drawn from all of them, across runs (AE
  /// parity 4.3), not only from the run being rendered.
  const std::vector<api::Renderable>* all = nullptr;
  static Scope3D of(const api::RenderFrameScene& s);
};

// A per-frame VIEW over the renderer's state (RenderPassContext in the TS graph):
// built on the stack by SceneRenderer::render, handed to each pass by reference,
// never copied, stored or assigned — so reference members are the honest type.
// NOLINTBEGIN(cppcoreguidelines-avoid-const-or-ref-data-members)
struct PassContext {
  Device& dev;
  const api::RenderFrameFile& file;
  const TextureTable& textures;
  /// Mutable for one reason: P8b's ViewShift moves it for a layer's draw and chain, and puts it back.
  ViewportState& viewport;
  ColorPipeline color;
  /// Graph targets resolved this frame (name → target), filled ON DEMAND by
  /// `target()` from `specs` (E3): a target no pass touches this frame — the
  /// precomp MSAA pairs of a comp without precomps, the DOF pair of a comp
  /// without DOF — is never allocated. Mutable for that one reason. Absent from
  /// `specs` = the surface (or an undeclared name).
  mutable TargetMap targets;
  /// E3: every target the graph declares this frame, in the precision the
  /// project asked for (scene_renderer.cpp resolveTargets).
  struct TargetSpec {
    std::uint32_t width = 1;
    std::uint32_t height = 1;
    wgpu::TextureFormat format = wgpu::TextureFormat::RGBA16Float;
    std::uint32_t samples = 1;
    bool depth = false;
  };
  std::unordered_map<std::string, TargetSpec, KeyHash, std::equal_to<>> specs;
  wgpu::TextureView surfaceView;
  wgpu::TextureFormat surfaceFormat = wgpu::TextureFormat::BGRA8Unorm;
  std::optional<std::array<std::uint32_t, 4>> surfaceScissor;
  /// EffectPass.activeColorTarget.
  std::string activeColorTarget;
  std::vector<GraphDiagnostic>& diagnostics;
  // NOLINTEND(cppcoreguidelines-avoid-const-or-ref-data-members)
  /// Scratch uniform floats (reused).
  std::vector<float> scratch;
  /// The current 3D scope (see Scope3D).
  Scope3D scope;
  /// D3 colour management for this frame (nullptr / inactive = today's pipeline).
  ColorSystem* colorSystem = nullptr;
  /// E1: engine-produced textures (nullptr = only the frame file's blobs).
  ExternalTextureSource* external = nullptr;
  /// G1: the native plugin host's render glue (nullptr = `native-plugin` entries pass through).
  NativeEffectHost* nativeFx = nullptr;
  /// E4: distance fields kept across frames (nullptr = rebuilt every frame).
  FxCache* fxCache = nullptr;
  /// E5: shadow maps, SSAO and planar reflections kept across runs and frames
  /// (nullptr = rebuilt every run).
  SceneCache3D* cache3d = nullptr;
  /// E8: the frame asks for the ground grid (scene.groundGrid) and it is not
  /// drawn yet; `groundGridRun` = the 3D run being rendered is the frame's last
  /// one, so it draws the grid against its depth (threed.cpp). Both are set by
  /// the composition pass (root scope only).
  bool groundGridPending = false;
  bool groundGridRun = false;
  /// E4: where the chain records the path each entry took (nullptr = not recorded).
  EffectStats* effectStats = nullptr;
  /// E4: strokes and spreads from alpha distance fields (fx_distance.hpp);
  /// off = the reference STROKE_MATERIAL disc scan (the TS renderer's pixels).
  bool fxFields = false;
  /// Grow bounds (fx_bounds.hpp): screen-space effect chains scissor their passes to their reach.
  bool fxBounds = true;
  /// E1: a 3D surface's effect chain runs in a layer-sized buffer (its footprint
  /// at comp scale, threed.cpp surface_texels) instead of a viewport-sized one.
  /// Off = the viewport-sized chain the golden references were drawn with (the
  /// engine turns it on; the parity harness leaves it off).
  bool fxLayerBuffers = false;
  /// The scissor (x, y, w, h) of the effect-chain entry being drawn, for passes
  /// into viewport-sized targets; set and cleared by run_effects_chain.
  std::optional<std::array<std::uint32_t, 4>> fxScissor = std::nullopt;

  /// E1/E2: 3D surfaces resolved so far this frame (threed.cpp) — each keeps
  /// its chain result in a target of its own, named by this count.
  std::uint32_t surfaceFx = 0;

  /// Gamma blending (ColorPipeline::gammaBlend): the comp targets a list is
  /// compositing into right now. They hold sRGB-encoded premultiplied colour,
  /// so draw_into draws into them through each shader's gamma-out variant, and
  /// whoever reads one decodes it (composition_pass.cpp). A handful at most:
  /// the nesting depth of precomps being drawn.
  std::vector<std::string> gammaTargets{};
  [[nodiscard]] bool gamma_target(std::string_view name) const {
    return std::ranges::find(gammaTargets, name) != gammaTargets.end();
  }

  /// ctx.target(name): nullptr = the surface (or an undeclared name). A
  /// declared target is allocated (from the device pool) on its first use.
  [[nodiscard]] RenderTarget* target(std::string_view name) const;
  /// The declared descriptor of `name` this frame, or nullptr (never allocates).
  [[nodiscard]] const TargetSpec* spec(std::string_view name) const {
    const auto it = specs.find(name);
    return it == specs.end() ? nullptr : &it->second;
  }
  [[nodiscard]] Packer packer() { return Packer(scratch, color); }
  /// A sampled blob by key, uploaded on first use.
  [[nodiscard]] TexRef texture(std::string_view key);
  /// texture(), mipmapped where the source can be (3D quads: trilinear +
  /// anisotropic sampling keeps thin strokes whole when minified). A colour-
  /// managed texture keeps its single-level working-space conversion.
  /// `fp`: the device-px quad it is drawn over; the chain is built as deep as
  /// that draw samples (TexRef::mipLevels; sample it with linear_clamp_levels).
  [[nodiscard]] TexRef texture_mipmapped(std::string_view key, const MipFootprint& fp = {});
  /// Whether `key` resolved to real (ready) pixels when the frame was captured.
  [[nodiscard]] bool texture_ready(std::string_view key) const { return textures.resolve(key).ready; }
  [[nodiscard]] SamplerRef linear_clamp() { return dev.sampler("linear-clamp", wgpu::FilterMode::Linear, wgpu::AddressMode::ClampToEdge); }
  /// Trilinear with 16× anisotropy — for 3D quads over mipmapped textures (texture_mipmapped).
  [[nodiscard]] SamplerRef linear_clamp_aniso() {
    return dev.sampler("linear-clamp-aniso16", wgpu::FilterMode::Linear, wgpu::AddressMode::ClampToEdge, 16);
  }
  /// Linear clamp-to-edge that never reads past level `levels - 1` (a lazily
  /// built chain, TexRef::mipLevels: 0 or 1 = level 0 only); 16× anisotropic
  /// when `aniso` and there is a chain.
  [[nodiscard]] SamplerRef linear_clamp_levels(std::uint32_t levels, bool aniso);
  [[nodiscard]] SamplerRef nearest_clamp() { return dev.sampler("nearest-clamp", wgpu::FilterMode::Nearest, wgpu::AddressMode::ClampToEdge); }
  [[nodiscard]] SamplerRef linear_repeat() { return dev.sampler("linear-repeat", wgpu::FilterMode::Linear, wgpu::AddressMode::Repeat); }

  /// beginViewportPass + execute + end, in one: draw `cmds` into `name` (cleared when `clear`).
  void draw_into(std::string_view name, const Commands& cmds, bool clear, const Color& clearColor = Color::transparent());
  /// Same with an explicit viewport size (beginSizedPass).
  void draw_into_sized(std::string_view name, const Commands& cmds, bool clear, std::uint32_t w, std::uint32_t h);
};

}  // namespace premation::rg
