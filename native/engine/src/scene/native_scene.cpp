#include "native_scene.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <optional>
#include <string>
#include <utility>
#include <cstdlib>
#include <string_view>

#include "color_settings.hpp"
#include "anim.hpp"
#include "item_facts.hpp"
#include "props.hpp"
#include "effects_port.hpp"
#include "raster_source.hpp"

namespace premation::scene {

namespace {

/// The texel size a request will be uploaded at, when the builder already knows
/// it: rasters (raster_source.cpp sizes them from the spec) and builder-made
/// pixels. nullopt = sized by its content (footage, light washes, particles).
std::optional<std::pair<double, double>> planned_texture_size(const TextureRequest& r) {
  switch (r.kind) {
    case TexKind::pixels: return std::pair<double, double>{static_cast<double>(r.pxWidth), static_cast<double>(r.pxHeight)};
    case TexKind::text:
    case TexKind::path:
    case TexKind::overlay: {
      const Json& dm = r.spec.at("__deviceMax");
      const raster::RasterCanvasSize z =
          raster::raster_canvas_size(r.spec.at("width").num(), r.spec.at("height").num(), r.resolutionScale, r.padding,
                                     r.spec.at("__baked").b(), dm.is_number() ? dm.num() : texture_dimension_limit());
      return std::pair<double, double>{static_cast<double>(z.width), static_cast<double>(z.height)};
    }
    default: return std::nullopt;
  }
}

/// A texture the GPU cannot hold fails its layer, never the frame (CLAUDE.md
/// reliability): a request planned over the device's 2D limit is dropped and
/// recorded on the frame's layer errors — its renderable finds no texture and
/// draws nothing. Content-sized textures are checked when prepared
/// (SceneTextures::prepare) and when uploaded (rg::Device::texture).
void drop_oversize_textures(NativeFrame& nf) {
  const double limit = texture_dimension_limit();
  std::erase_if(nf.textures, [&](const TextureRequest& r) {
    const auto size = planned_texture_size(r);
    if (!size || (size->first <= limit && size->second <= limit)) return false;
    nf.errors.push_back({r.layerId, "", "texture",
                         "the layer's texture would be " + std::to_string(static_cast<long long>(size->first)) + "x" +
                             std::to_string(static_cast<long long>(size->second)) + " px, over the GPU limit of " +
                             std::to_string(static_cast<long long>(limit)) + " px; the layer is skipped"});
    return true;
  });
}

}  // namespace

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

bool svg_display_scale_on() noexcept {
  static const bool on = [] {
    const char* v = std::getenv("PREMATION_SVG_INTRINSIC");  // NOLINT(concurrency-mt-unsafe): read once, before any thread sets it
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

/// P11: layers whose effect stack still bakes on the CPU (Skia, per frame) and
/// why the GPU route refused them — a cliff in playback cost a user cannot
/// see otherwise (one Plexus in a stack sends the whole stack to the CPU).
static void note_cpu_effect_layers(const std::vector<RLayer>& layers, std::vector<LayerError>& out) {
  for (const RLayer& l : layers) {
    if (l.precompLayers) {
      note_cpu_effect_layers(*l.precompLayers, out);
      continue;  // a container's chain is the container's own
    }
    if (l.gpuEffects || !layer_is_baked(l) || l.effects.empty()) continue;
    const char* why = gpu_effect_route_blocker(l);
    out.push_back({l.id, "", "cpu-effects",
                   std::string("effects render on the CPU (slow in playback): ") + (why != nullptr ? why : "not routed to the GPU")});
  }
}

NativeFrame native_frame_of(const doc::Document& d, Snapshot snap, const ViewSpec& view, double clipWidth,
                            double clipHeight, const std::string& sceneId, std::int64_t frame) {
  using Clock = std::chrono::steady_clock;
  NativeFrame nf;
  const auto t1 = Clock::now();
  const double rasterScale = view.zoom * view.dpr;
  if (view.gpuEffects) (void)mark_gpu_effect_layers(snap.layers);  // E4: before anything reads layer_is_baked
  FrameBuild fb = build_frame_scene(snap, rasterScale, view.svgDisplayScale);
  const auto t2 = Clock::now();
  nf.sceneMs = std::chrono::duration<double, std::milli>(t2 - t1).count();
  nf.errors = std::move(snap.layerErrors);
  for (auto& [id, what] : fb.unported) nf.errors.push_back({id, "", "unported", std::move(what)});
  if (view.gpuEffects) note_cpu_effect_layers(snap.layers, nf.errors);

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
  drop_oversize_textures(nf);
  return nf;
}

namespace {

/// One `expression` layer error per failing property: the message is the
/// expression's own, prefixed `Line N: ` when its position is known; `path`
/// is the property's API path (the Timeline matches its row by layer + path).
void append_expression_errors(const doc::Document& d, const std::vector<doc::ExprRuntimeError>& errs,
                              std::vector<LayerError>& out) {
  for (const doc::ExprRuntimeError& e : errs) {
    std::string path;
    try {
      const doc::Catalog cat = doc::catalog_for(d, e.node);
      if (const doc::PropBinding* b = cat.by_member(e.prop)) {
        path = b->path;
      } else {
        for (const doc::PropBinding& binding : cat.props) {
          if (binding.dataTrack && *binding.dataTrack == e.prop) {
            path = binding.path;
            break;
          }
        }
      }
    } catch (const std::exception&) {
      path.clear();  // a node outside the catalogue (not a layer): reported without a path
    }
    if (path.empty()) path = e.prop;
    const bool dup = std::any_of(out.begin(), out.end(), [&](const LayerError& x) {
      return x.stage == "expression" && x.layerId == e.node && x.path == path;
    });
    if (dup) continue;  // the other members of a vector failed the same way
    const doc::Node* n = d.node(e.node);
    std::string msg = e.line > 0 ? "Line " + std::to_string(e.line) + ": " + e.message : e.message;
    out.push_back(LayerError{e.node, n != nullptr ? n->name : std::string(), "expression", std::move(msg), std::move(path)});
  }
}

}  // namespace

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
  if (overrides.transparencyGridCell > 0) sc.transparencyGridCell = overrides.transparencyGridCell;
  std::optional<MotionBlurCfg> mb;
  if (motionBlur) mb = motion_blur_of(c.d, comp);
  // Expressions that fail while the frame evaluates fall back to their
  // pre-expression value; the frame reports each (stage `expression`).
  doc::ExprErrorCapture capture(c.cache);
  // One frame reads one unchanging document: its expression reads are memoised.
  const doc::ExprEvalScope evalScope(c.cache);
  Snapshot snap = build_snapshot(c, sc, t, mb);
  const std::vector<doc::ExprRuntimeError> exprErrors = capture.take();
  const double snapshotMs = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
  NativeFrame nf = native_frame_of(c.d, std::move(snap), view, sc.width, sc.height, sceneId, frame);
  append_expression_errors(c.d, exprErrors, nf.errors);
  nf.snapshotMs = snapshotMs;
  if (view.groundGrid && nf.file.scene.camera3d) {
    // E8: the viewport's ground grid — the floor at the comp's Ground Level
    // (World ▸ Ground level, comp height + level), centred under the comp.
    double groundLevel = 0;
    if (const js::Json* rec = c.d.comp(comp); rec != nullptr) {
      const js::Json& gl = rec->at("groundLevel");
      if (gl.is_number() && std::isfinite(gl.num())) groundLevel = gl.num();
    }
    api::RenderGroundGrid gg;
    gg.y = sc.height + groundLevel;
    gg.center_x = sc.width / 2;
    gg.center_z = 0;
    nf.file.scene.ground_grid = gg;
  }
  return nf;
}

void layer_pixels_context(BuildContext& c, std::string_view layer, bool postEffect) {
  // The Layer panel's walk: the layer alone, placed untransformed at the comp's centre.
  c.layerView = BuildContext::LayerView{std::string(layer), postEffect, std::nullopt};
  c.isolateLayer.clear();
  c.isolateAlso.clear();
  c.hiddenLayers.clear();
  c.focusLayers.clear();
  c.useProxies = false;
}

LayerPixelsFrame build_layer_pixels_frame(const BuildContext& c, std::string_view comp, std::string_view layer, double t,
                                          const ViewSpec& view) {
  const SnapshotComp sc = snapshot_comp_of(c.d, comp);
  const double compW = std::max(1.0, sc.width);
  const double compH = std::max(1.0, sc.height);
  // Layer space as the expression host has it (DocExprEnv::layer_info, which
  // fromComp / toComp map through): the layer's box. Without one, a precomp's
  // or footage's own size; text and shapes without a box, the comp's (AE).
  double w = 0;
  double h = 0;
  const doc::Node* n = c.d.node(layer);
  if (n != nullptr) {
    for (const doc::Component& part : n->components) {
      if (part.type != "Transform") continue;
      const Json& bw = part.props.at("width");
      const Json& bh = part.props.at("height");
      if (bw.is_number() && bh.is_number() && bw.num() > 0 && bh.num() > 0) {
        w = bw.num();
        h = bh.num();
      }
    }
  }
  if (!(w > 0 && h > 0) && n != nullptr && n->kind() != "shape" && n->kind() != "text") {
    for (const api::LayerSourceSize& z : doc::source_sizes(c.d, {std::string(layer)})) {
      w = z.width;
      h = z.height;
    }
  }
  if (!(w > 0 && h > 0)) {
    w = compW;
    h = compH;
  }
  LayerPixelsFrame out;
  out.boxWidth = w;
  out.boxHeight = h;
  out.scale = std::min(1.0, static_cast<double>(kSampleImageMaxSide) / std::max(w, h));
  out.width = static_cast<std::uint32_t>(std::max(1.0, std::round(w * out.scale)));
  out.height = static_cast<std::uint32_t>(std::max(1.0, std::round(h * out.scale)));
  ViewSpec& vs = out.view;
  vs = view;
  vs.cssWidth = out.width;
  vs.cssHeight = out.height;
  vs.dpr = 1;
  // The layer's box (w × h world units, centred on the comp's centre) fills the surface.
  vs.zoom = static_cast<double>(out.width) / w;
  vs.centerX = compW / 2;
  vs.centerY = compH / 2;
  vs.clipToComp = false;
  vs.clear = api::Color{0, 0, 0, 0};
  vs.surfaceFormat = api::RenderTextureFormat::rgba8unorm;
  vs.channel = api::ChannelView::rgb;
  vs.exposure = 0;
  vs.regionOfInterest.reset();
  vs.groundGrid = false;
  CompOverrides ov;
  ov.transparent = true;
  ov.camera3dMode = "active";
  // No motion blur: AE samples the layer's pixels at the one time asked.
  out.nf = build_native_frame(c, comp, t, vs, false, {}, 0, ov);
  return out;
}

}  // namespace premation::scene
