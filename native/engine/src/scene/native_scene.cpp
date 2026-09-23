#include "native_scene.hpp"

#include <chrono>

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

NativeFrame build_native_frame(const BuildContext& c, std::string_view comp, double t, const ViewSpec& view,
                               bool motionBlur, const std::string& sceneId, std::int64_t frame) {
  using Clock = std::chrono::steady_clock;
  NativeFrame nf;
  const auto t0 = Clock::now();
  const SnapshotComp sc = snapshot_comp_of(c.d, comp);
  std::optional<MotionBlurCfg> mb;
  if (motionBlur) mb = motion_blur_of(c.d, comp);
  Snapshot snap = build_snapshot(c, sc, t, mb);
  const auto t1 = Clock::now();
  const double rasterScale = view.zoom * view.dpr;
  FrameBuild fb = build_frame_scene(snap, rasterScale);
  const auto t2 = Clock::now();
  nf.snapshotMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
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
    api::Rect clip;
    clip.x = toScreen(0, view.centerX, view.cssWidth);
    clip.y = toScreen(0, view.centerY, view.cssHeight);
    clip.width = sc.width * view.zoom * view.dpr;
    clip.height = sc.height * view.zoom * view.dpr;
    v.frame_clip = clip;
  }
  v.overlays_active = false;
  const doc::ColorMgmt& cm = c.d.color();
  v.working_space = cm.workingSpace == "aces-cg" ? api::RenderWorkingSpace::aces_cg : api::RenderWorkingSpace::srgb_linear;
  v.display_transform = cm.displayTransform == "aces" ? api::RenderDisplayTransform::aces
                        : cm.displayTransform == "pq"  ? api::RenderDisplayTransform::pq
                        : cm.displayTransform == "hlg" ? api::RenderDisplayTransform::hlg
                                                       : api::RenderDisplayTransform::srgb;
  v.bit_depth = cm.bitDepth == 32 ? 32 : 16;
  v.float16_textures = true;
  v.float32_textures = true;
  v.surface_format = view.surfaceFormat;
  v.viewer_lut_active = false;
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

}  // namespace premation::scene
