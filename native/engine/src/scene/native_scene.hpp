// The engine's own frame, end to end (D2w): document + composition + time +
// viewport → a RenderFrameFile the render graph draws, with every texture it
// names as a TextureRequest for SceneTextures. The same struct the TS harness
// exports (engine-api 96_render.eapi), built in process and never serialized.
#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "frame_build.hpp"
#include "snapshot_build.hpp"

namespace premation::scene {

/// The viewport a frame is drawn through (RenderView's camera + surface).
struct ViewSpec {
  double cssWidth = 1, cssHeight = 1, dpr = 1;
  /// Camera2D: world point at the viewport centre, screen px per world unit.
  double centerX = 0, centerY = 0, zoom = 1;
  /// Clip draws to the comp rect (AE's comp panel; the TS backend's frameClip).
  bool clipToComp = true;
  api::Color clear{};  // transparent void
  api::RenderTextureFormat surfaceFormat = api::RenderTextureFormat::bgra8unorm;
  /// An export frame's output module colour space (RenderSettings.outputColorSpace); '' = the viewer.
  std::string outputColorSpace;
  /// The viewer's channel (View ▸ Show Channel); exports leave it rgb.
  api::ChannelView channel = api::ChannelView::rgb;
  /// E4: the frame is drawn on a GPU device, so a layer the TypeScript bakes on
  /// the CPU runs its stack on the render graph's chain when it can
  /// (effects_port.hpp gpu_effect_route). Off = the TypeScript's bake rule,
  /// byte for byte (the parity gate, CPU-only callers).
  bool gpuEffects = false;
};

/// E4: whether the engine's own frames take the GPU effect route — on, unless
/// the process was started with PREMATION_CPU_BAKE=1 (read once: the CPU bake
/// is the reference, for A/B against the golden scenes in the app).
[[nodiscard]] bool engine_gpu_effects() noexcept;

/// Set RLayer::gpuEffects on every layer of `layers` (and of the precomps they
/// hold) that gpu_effect_route accepts. Returns how many were routed.
std::size_t mark_gpu_effect_layers(std::vector<RLayer>& layers);

/// offlineRenderer.ts `exportView(outW, outH, comp)` as a camera: the comp fitted
/// (contain) and centred in an out × out surface — what the harness and export draw through.
[[nodiscard]] ViewSpec export_view(double outW, double outH, double compW, double compH);

struct NativeFrame {
  api::RenderFrameFile file;
  std::vector<TextureRequest> textures;
  /// snapshot.layerErrors + everything flattening reported unported.
  std::vector<LayerError> errors;
  double snapshotMs = 0;
  double sceneMs = 0;
};

/// What an export changes about the composition it renders (offlineRenderer.ts
/// `exportComp` + the job's `transparent`).
struct CompOverrides {
  /// A DELIVERED frame: guide layers dropped (exportComp's `forExport`).
  bool forExport = false;
  /// The job's alpha choice (`req.transparent ?? comp.transparent`); nullopt = the comp's.
  std::optional<bool> transparent;
  /// A viewport's 3D view (with_viewport_view: a camera view or a custom view's
  /// camera); nullopt = the comp's own active camera.
  std::optional<std::string> camera3dMode;
  std::optional<motion::xf::Camera> customViewCamera;
};

/// The file half of build_native_frame: `snap` flattened (build_frame_scene)
/// and wrapped in `view`, with the document's colour settings; the comp clip
/// is clipWidth × clipHeight comp px. Also a frame that is not a composition's
/// (a footage item's thumbnail: one layer in a snapshot of its own).
[[nodiscard]] NativeFrame native_frame_of(const doc::Document& d, Snapshot snap, const ViewSpec& view, double clipWidth,
                                          double clipHeight, const std::string& sceneId = {}, std::int64_t frame = 0);

/// Build one frame. `motionBlur` false = the harness's no-blur scenes (buildSnapshot
/// gets no config); true = the document's own motion-blur settings.
[[nodiscard]] NativeFrame build_native_frame(const BuildContext& c, std::string_view comp, double t, const ViewSpec& view,
                                             bool motionBlur, const std::string& sceneId = {}, std::int64_t frame = 0,
                                             const CompOverrides& overrides = {});

}  // namespace premation::scene
