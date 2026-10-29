// snapshotToFrameScene (src/core/rendering/snapshotToFrameScene.ts) for the
// scene builder: a Snapshot → the wire FrameScene (engine-api 96_render.eapi)
// the render graph draws, plus what each texture key it names must hold —
// the drawable a text / path / mask raster is painted from (the drawable the
// TS Canvas2DVectorRasterizer received, MotionRendererBackend's feed), or the
// footage frame a media key shows. Keys are the TypeScript's own
// (`path:<id>`, `text:<id>`, `mask:<id>`, `asset:<id>`), so a structural diff
// against the TS-exported FrameScene lines up renderable for renderable.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "engine_api.hpp"
#include "scene_types.hpp"

namespace premation::scene {

/// light: a light's glow wash (light_wash.cpp). pixels: a texture the builder
/// computes itself (a colour-LUT strip), uploaded as given.
/// particles: a particle emitter's field (particle_port.cpp).
/// contours: E4's GPU Vegas — the alpha contours of another raster of the same
/// frame (spec.source, its key) as a data texture (effects/contour_texture.hpp).
/// `overlay`: E4 round 2 — a drawn Canvas2D-only effect painted alone at the
/// layer raster's size (spec {effect, width, height, __deviceMax}).
enum class TexKind : std::uint8_t { text, path, mask, media, light, pixels, particles, contours, overlay };

struct TextureRequest {
  std::string key;
  TexKind kind = TexKind::path;
  /// Rasters: the drawable (TextSpec / RenderLayer / mask spec) as JSON.
  Json spec;
  double resolutionScale = 1;
  double padding = 0;
  /// Media: the source path / URL, the time in the source (seconds), video vs still.
  std::string src;
  /// Use Proxies: `src` is the item's proxy and this is the original, which the
  /// texture feed decodes instead when the proxy does not open (said, never a
  /// blank layer). Empty = `src` is the original.
  std::string fallbackSrc;
  double sourceTime = 0;
  bool video = false;
  bool premultiplied = false;
  /// Interpret Footage > Color > Assign Profile (RLayer::colorProfile); absent = the file's tags.
  std::optional<api::RenderColorSpace> colorProfile;
  /// The layer's fill: an SVG source is recoloured with it (AppTextureProvider.rasterizeSvg).
  std::optional<std::string> fill;
  /// E4: an SVG source's DISPLAYED long edge in screen texels — the layer box's
  /// long edge × screen px per layer px (view zoom × DPR × the layer's scale,
  /// or its projected size under the 3D camera). The texture feed quantises
  /// it to a raster step. 0 = rasterize at rasterizeSvg's own size (the parity
  /// harness, ViewSpec::svgDisplayScale off).
  double svgDisplayLong = 0;
  /// The composition's frame rate (the frame-blend grid's last fallback).
  double compFps = 30;
  /// Footage: Interpret Footage ▸ Remove Pulldown (3:2 phase 0–4, the frames
  /// woven back from fields) or ▸ Fields ('u' / 'l' = the field kept, the other
  /// rebuilt; 0 = progressive) — RLayer pulldownSource / fieldsSource.
  std::optional<int> pulldownPhase;
  char fields = 0;
  /// Pixel Motion (`vfm:`): the flow-warped in-between of the frame at
  /// sourceTime and the frame at blendTime, at blendWeight toward the second.
  bool pixelMotion = false;
  double blendTime = 0;
  double blendWeight = 0;
  /// Footage with a CPU-baked effect chain (layer_is_baked): `spec` is the
  /// bake {effects, width, height, fillOpacity?, mask?}; a video bakes at
  /// min(native, layer box × bakeTargetScale), a still at the view's bake tier
  /// (`resolutionScale`) × 1.5 — AppTextureProvider setVideoBaked / setImage.
  bool bake = false;
  double bakeTargetScale = 0;
  /// Pixels: straight RGBA8 rows (alpha 255 for the LUT strips), pxWidth × pxHeight.
  std::vector<std::uint8_t> pixels;
  std::uint32_t pxWidth = 0;
  std::uint32_t pxHeight = 0;
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
/// `svgDisplayScale` (E4): SVG sources ask for their displayed size
/// (TextureRequest::svgDisplayLong); off = rasterizeSvg's own size.
[[nodiscard]] FrameBuild build_frame_scene(const Snapshot& s, double rasterScale, bool svgDisplayScale = false);

/// The largest 2D texture rasters are planned against (VectorRasterizer.ts
/// deviceMax): 16384 — the TS provider's figure, and what the engine's devices
/// ask for (render_graph/device_limits.hpp) — until a render device reports a
/// smaller limit. Process-wide because every frame builder in the process
/// draws on that one device; the renderer that made it sets it.
[[nodiscard]] double texture_dimension_limit() noexcept;
void set_texture_dimension_limit(std::uint32_t px) noexcept;

/// `rasterPadding(layer)` (vectorDraw.ts) for the ported layer shapes.
[[nodiscard]] double raster_padding(const RLayer& l);
/// `needsShapeRaster(layer)`.
[[nodiscard]] bool needs_shape_raster(const RLayer& l);
/// needs_shape_raster without its last reason, a CPU-baked effect stack: what
/// the layer's CONTENT needs, the same before and after the GPU route takes the
/// stack (`gpuEffects` unbakes the layer, so needs_shape_raster changes then).
[[nodiscard]] bool shape_content_needs_raster(const RLayer& l);

}  // namespace premation::scene
