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
  /// The viewer's exposure in stops (RenderView.exposure); exports leave it 0.
  double exposure = 0;
  /// The viewer's region of interest (comp px): the comp clip shrinks to it.
  std::optional<api::Rect> regionOfInterest;
  /// E4: the frame is drawn on a GPU device, so a layer the TypeScript bakes on
  /// the CPU runs its stack on the render graph's chain when it can
  /// (effects_port.hpp gpu_effect_route). Off = the TypeScript's bake rule,
  /// byte for byte (the parity gate, CPU-only callers).
  bool gpuEffects = false;
  /// E4: SVG sources rasterise at the size they are displayed (DPR × layer
  /// scale × camera magnification, quantised, capped; frame_build.hpp
  /// TextureRequest::svgDisplayLong). Off = rasterizeSvg's own size, byte for
  /// byte (the parity gate).
  bool svgDisplayScale = false;
  /// E8: draw the composition's ground grid (RenderFrameScene.groundGrid) —
  /// the viewport's frames only; exports, thumbnails and the cache leave it off.
  bool groundGrid = false;
};

/// E4: whether the engine's own frames take the GPU effect route — on, unless
/// the process was started with PREMATION_CPU_BAKE=1 (read once: the CPU bake
/// is the reference, for A/B against the golden scenes in the app).
[[nodiscard]] bool engine_gpu_effects() noexcept;

/// 3D perf E4: whether the engine's own frames rasterise SVG sources at their
/// displayed size — on, unless the process was started with
/// PREMATION_SVG_INTRINSIC=1 (read once; the intrinsic raster is the reference
/// for A/B against the golden scenes in the app).
[[nodiscard]] bool svg_display_scale_on() noexcept;

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
  /// SDK 1.4 (T4): a plugin simulation was still catching up — the frame is not final.
  bool simPending = false;
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
  /// A viewport's Draft 3D and transparency grid (with_viewport_view).
  bool draft3d = false;
  bool transparencyGrid = false;
  /// The grid's cell in comp px (≈ 16 screen px at the view's zoom); 0 = 16.
  double transparencyGridCell = 0;
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

/// The longest side a layer is drawn at for `sampleImage` (a larger one is
/// drawn smaller and sampled through LayerPixels::scale).
inline constexpr std::uint32_t kSampleImageMaxSide = 2048;

/// `sampleImage`: `layer` (of `comp`) alone in its own space at `t` — the
/// Layer panel's frame (BuildContext::LayerView): untransformed, over
/// transparency, with its masks and effects when `postEffect`, else its
/// untouched source — drawn width × height (its source size, or the comp's
/// for a layer without one, scaled by `scale` to fit kSampleImageMaxSide).
/// `view` carries the caller's device flags (gpuEffects, svgDisplayScale).
struct LayerPixelsFrame {
  NativeFrame nf;
  /// The view it was drawn through (what finish_native_frame is given).
  ViewSpec view;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  double scale = 1;
  /// The layer's box it shows, layer units.
  double boxWidth = 0;
  double boxHeight = 0;
};
/// `c` as build_layer_pixels_frame walks it (the Layer panel's walk of `layer`).
void layer_pixels_context(BuildContext& c, std::string_view layer, bool postEffect);
/// `c` is the context layer_pixels_context made.
[[nodiscard]] LayerPixelsFrame build_layer_pixels_frame(const BuildContext& c, std::string_view comp, std::string_view layer,
                                                        double t, const ViewSpec& view);

}  // namespace premation::scene
