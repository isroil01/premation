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
};

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

/// Build one frame. `motionBlur` false = the harness's no-blur scenes (buildSnapshot
/// gets no config); true = the document's own motion-blur settings.
[[nodiscard]] NativeFrame build_native_frame(const BuildContext& c, std::string_view comp, double t, const ViewSpec& view,
                                             bool motionBlur, const std::string& sceneId = {}, std::int64_t frame = 0);

}  // namespace premation::scene
