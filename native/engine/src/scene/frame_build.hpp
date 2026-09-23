// snapshotToFrameScene (src/core/rendering/snapshotToFrameScene.ts) for the
// scene builder: a Snapshot → the wire FrameScene (engine-api 96_render.eapi)
// the render graph draws, plus what each texture key it names must hold —
// the drawable a text / path / mask raster is painted from (the drawable the
// TS Canvas2DVectorRasterizer received, MotionRendererBackend's feed), or the
// footage frame a media key shows. Keys are the TypeScript's own
// (`path:<id>`, `text:<id>`, `mask:<id>`, `asset:<id>`), so a structural diff
// against the TS-exported FrameScene lines up renderable for renderable.
#pragma once

#include <string>
#include <vector>

#include "engine_api.hpp"
#include "scene_types.hpp"

namespace premation::scene {

enum class TexKind : std::uint8_t { text, path, mask, media };

struct TextureRequest {
  std::string key;
  TexKind kind = TexKind::path;
  /// Rasters: the drawable (TextSpec / RenderLayer / mask spec) as JSON.
  Json spec;
  double resolutionScale = 1;
  double padding = 0;
  /// Media: the source path / URL, the time in the source (seconds), video vs still.
  std::string src;
  double sourceTime = 0;
  bool video = false;
  bool premultiplied = false;
  /// The composition's frame rate (the frame-blend grid's last fallback).
  double compFps = 30;
  /// The layer this texture belongs to (diagnostics).
  std::string layerId;
};

struct FrameBuild {
  api::RenderFrameScene scene;
  std::vector<TextureRequest> textures;
  /// Features met while flattening that the port does not produce (layer id, what).
  std::vector<std::pair<std::string, std::string>> unported;
};

/// `snapshotToFrameScene(snapshot)` + the texture feed. `rasterScale` is the
/// comp→device scale (view scale × DPR) the TS provider rasterises at.
[[nodiscard]] FrameBuild build_frame_scene(const Snapshot& s, double rasterScale);

/// `rasterPadding(layer)` (vectorDraw.ts) for the ported layer shapes.
[[nodiscard]] double raster_padding(const RLayer& l);
/// `needsShapeRaster(layer)`.
[[nodiscard]] bool needs_shape_raster(const RLayer& l);

}  // namespace premation::scene
