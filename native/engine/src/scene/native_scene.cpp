#include "native_scene.hpp"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <string_view>

#include "color_settings.hpp"
#include "effects_port.hpp"

namespace premation::scene {

ViewSpec export_view(double outW, double outH, double compW, double compH) {
  // exportView: scale = min(outW/cw, outH/ch), centred; viewToCamera: zoom = scale,
  // center = (css/2 − offset) / scale.
  const double scale = std::min(outW / compW, outH / compH);
  const double offsetX = (outW - compW * scale) / 2;
  const double offsetY = (outH - compH * scale) / 2;
  ViewSpec v;
  v.cssWidth = outW;
  v.cssHeight = outH;
  v.dpr = 1;
  v.zoom = scale;
  v.centerX = (outW / 2 - offsetX) / scale;
  v.centerY = (outH / 2 - offsetY) / scale;
  return v;
}

bool engine_gpu_effects() noexcept {
  static const bool on = [] {
    const char* v = std::getenv("PREMATION_CPU_BAKE");  // NOLINT(concurrency-mt-unsafe): read once, before any thread sets it
    return v == nullptr || std::string_view(v).empty() || std::string_view(v) == "0";
  }();
  return on;
}

std::size_t mark_gpu_effect_layers(std::vector<RLayer>& layers) {
  std::size_t n = 0;
  for (RLayer& l : layers) {
    if (l.precompLayers) n += mark_gpu_effect_layers(*l.precompLayers);
    if (!l.gpuEffects && gpu_effect_route(l)) {
      l.gpuEffects = true;
      ++n;
    }
  }
  return n;
}

NativeFrame native_frame_of(const doc::Document& d, Snapshot snap, const ViewSpec& view, double clipWidth,
                            double clipHeight, const std::string& sceneId, std::int64_t frame) {
  using Clock = std::chrono::steady_clock;
  NativeFrame nf;
  const auto t1 = Clock::now();
  const double rasterScale = view.zoom * view.dpr;
  if (view.gpuEffects) (void)mark_gpu_effect_layers(snap.layers);  // E4: before anything reads layer_is_baked
  FrameBuild fb = build_frame_scene(snap, rasterScale);
  const auto t2 = Clock::now();
  nf.sceneMs = std::chrono::duration<double, std::milli>(t2 - t1).count();
  nf.errors = std::move(snap.layerErrors);
  for (auto& [id, what] : fb.unported) nf.errors.push_back({id, "", "unported", std::move(what)});

  api::RenderFrameFile& f = nf.file;
  f.format_version = 1;
  f.scene_id = sceneId;
  f.frame = frame;
  api::RenderView& v = f.view;
  v.css_width = view.cssWidth;
  v.css_height = view.cssHeight;
  v.device_pixel_ratio = view.dpr;
  v.camera_center_x = view.centerX;
  v.camera_center_y = view.centerY;
  v.camera_zoom = view.zoom;
  v.clear_color = view.clear;
  if (view.clipToComp) {
    const auto toScreen = [&](double world, double center, double css) { return ((world - center) * view.zoom + css / 2) * view.dpr; };
    // The comp rect, or the part of it inside the region of interest.
    double x0 = 0;
    double y0 = 0;
    double x1 = clipWidth;
    double y1 = clipHeight;
    if (view.regionOfInterest) {
      const api::Rect& r = *view.regionOfInterest;
      x0 = std::clamp(r.x, 0.0, clipWidth);
      y0 = std::clamp(r.y, 0.0, clipHeight);
      x1 = std::clamp(r.x + r.width, x0, clipWidth);
      y1 = std::clamp(r.y + r.height, y0, clipHeight);
    }
    api::Rect clip;
    clip.x = toScreen(x0, view.centerX, view.cssWidth);
    clip.y = toScreen(y0, view.centerY, view.cssHeight);
    clip.width = (x1 - x0) * view.zoom * view.dpr;
    clip.height = (y1 - y0) * view.zoom * view.dpr;
    v.frame_clip = clip;
  }
  v.overlays_active = false;
  const doc::ColorMgmt& cm = d.color();
  v.working_space = cm.workingSpace == "aces-cg" ? api::RenderWorkingSpace::aces_cg : api::RenderWorkingSpace::srgb_linear;
  v.display_transform = cm.displayTransform == "aces" ? api::RenderDisplayTransform::aces
                        : cm.displayTransform == "pq"  ? api::RenderDisplayTransform::pq
                        : cm.displayTransform == "hlg" ? api::RenderDisplayTransform::hlg
                                                       : api::RenderDisplayTransform::srgb;
  v.bit_depth = cm.bitDepth == 32 ? 32 : 16;
  // D3 colour management from the project's settings (absent = the TS pipeline);
  // textures are tagged with their interpretation by SceneTextures (set_color_managed).
  ColorManagementChoice cmc = color_management_of(d, view.outputColorSpace);
  v.color_management = std::move(cmc.management);
  if (!cmc.note.empty()) nf.errors.push_back({"", "", "color", std::move(cmc.note)});
  v.float16_textures = true;
  v.float32_textures = true;
  v.surface_format = view.surfaceFormat;
  v.viewer_lut_active = false;
  if (view.channel != api::ChannelView::rgb) v.channel = view.channel;
  if (view.exposure != 0) v.exposure = view.exposure;
  f.scene = std::move(fb.scene);
  // The 1×1 white every textured draw may fall back to (frameSceneExport's `texture:white`).
  {
    api::RenderBlob white;
    white.hash = "rgba8unorm:1x1:white";
    white.width = 1;
    white.height = 1;
    white.format = api::RenderTextureFormat::rgba8unorm;
    white.pixels = {255, 255, 255, 255};
    api::RenderTextureRef ref;
    ref.key = "texture:white";
    ref.hash = white.hash;
    f.textures.push_back(std::move(ref));
    f.blobs.push_back(std::move(white));
  }
  nf.textures = std::move(fb.textures);
  return nf;
}

NativeFrame build_native_frame(const BuildContext& c, std::string_view comp, double t, const ViewSpec& view,
                               bool motionBlur, const std::string& sceneId, std::int64_t frame,
                               const CompOverrides& overrides) {
  using Clock = std::chrono::steady_clock;
  const auto t0 = Clock::now();
  SnapshotComp sc = snapshot_comp_of(c.d, comp);
  if (overrides.forExport) sc.forExport = true;
  if (overrides.transparent) sc.transparent = *overrides.transparent;
  if (overrides.camera3dMode) sc.camera3dMode = *overrides.camera3dMode;
  if (overrides.customViewCamera) sc.customViewCamera = overrides.customViewCamera;
  if (overrides.draft3d) sc.draft3d = true;
  if (overrides.transparencyGrid) sc.transparencyGrid = true;
  std::optional<MotionBlurCfg> mb;
  if (motionBlur) mb = motion_blur_of(c.d, comp);
  Snapshot snap = build_snapshot(c, sc, t, mb);
  const double snapshotMs = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
  NativeFrame nf = native_frame_of(c.d, std::move(snap), view, sc.width, sc.height, sceneId, frame);
  nf.snapshotMs = snapshotMs;
  return nf;
}

}  // namespace premation::scene
