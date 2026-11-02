// What the document core hands the render thread: an EVALUATED frame, as plain
// data. The render thread never sees the document, so the core can keep
// editing while a frame is on the GPU, and a frame is a pure function of
// (document revision, comp time) — no clock, no RNG (CLAUDE.md determinism).
#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
#include <cstdint>
#include <future>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "engine_api.hpp"
#include "json.hpp"

namespace premation {

/// One filled quad: the unit square [0,1]² mapped into comp pixels by
/// x' = a·u + c·v + e, y' = b·u + d·v + f (y down), filled with `color`
/// (straight sRGB-encoded RGB, alpha already multiplied by the layer opacity).
struct DrawQuad {
  std::array<float, 6> affine{};  // a b c d e f
  std::array<float, 4> color{};
  bool operator==(const DrawQuad&) const = default;
};

struct FrameScene {
  std::uint32_t compWidth = 0;
  std::uint32_t compHeight = 0;
  std::array<float, 4> background{0.0F, 0.0F, 0.0F, 1.0F};  // straight sRGB
  std::vector<DrawQuad> quads;  // back to front
  bool operator==(const FrameScene&) const = default;
};

/// D2w: a frame the engine's scene builder produced from its own document
/// (scene/built_frame.hpp) — opaque here; the render thread draws it through
/// the render graph instead of the C2 quad compositor.
struct BuiltFrame;

/// Thrown out of a frame build whose cancel flag rose: an edit is waiting for
/// the build lock, and the frame being built describes a document that is
/// about to change, so finishing it would only make the edit wait. Not a
/// std::exception on purpose — the builder's per-layer isolation catches
/// std::exception and continues; this must reach the build worker, which
/// drops the task and asks for a fresh frame once the edit has landed.
struct BuildCancelled {};

/// A composition viewport frame drawn in COMP space: the comp rectangle alone,
/// at the view's own scale (the same pixels the slot would show — nothing is
/// resampled), in a texture of `width` × `height` whose pixel (0, 0) lands on
/// slot pixel (`slotX`, `slotY`). The present is an integer-offset copy, so a
/// pane resize or a pan that keeps the scale and the sub-pixel phase of the
/// comp origin is the same cached frame: the cache scope and the content key
/// name THIS texture, not the slot.
struct CompSpaceFrame {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::int32_t slotX = 0;  ///< where texture pixel (0, 0) lands in the slot (may be negative: the view is zoomed in)
  std::int32_t slotY = 0;
  double zoom = 1;        ///< comp px → CSS px (ViewSpec::zoom)
  double dpr = 1;         ///< CSS px → texture px: the device pixel ratio × the preview scale (ViewSpec::dpr)
  double phaseX = 0;      ///< the comp origin inside texture pixel (0, 0), [0, 1) in texture px, quantised to 1/256
  double phaseY = 0;
  /// A resolution TIER (item 6, docs/AUDIT_2026-11-02_RENDER_SCENE.md): a view
  /// scale that is not a power of two draws the comp at the next power of two
  /// above it (zoom = the tier, dpr 1, phase 0) and the present scales it into
  /// the slot by `present` (< 1) at the fractional `originX`, `originY` (slot
  /// px). Every zoom inside one tier, and every pan, shares the cached frame;
  /// a ladder zoom (100 %, 50 %, 200 %…) is the exact copy above. 1 = a copy.
  double present = 1;
  double originX = 0;
  double originY = 0;
  bool operator==(const CompSpaceFrame&) const = default;
};

struct RenderJob {
  FrameScene scene;
  // shared_ptr: handed core thread → render thread exactly once and destroyed
  // wherever the job dies (including translation units that see only the
  // forward declaration above) — shared_ptr type-erases the deleter.
  std::shared_ptr<BuiltFrame> built;
  std::uint32_t viewport = 0;
  std::int64_t frame = 0;
  std::int64_t time = 0;       // flicks
  std::uint64_t revision = 0;
  /// Frames the clock skipped before this one (reported with the frame).
  std::uint32_t clockDropped = 0;
  /// Cache Work Area: footage on this frame is drawn from its exact decoded
  /// frame (waiting for it), never a nearest stand-in, so the frame can be
  /// stored — the fill is not real time; playback reads what it stored.
  bool exactMedia = false;
  /// Built while the transport played: superseded before it drew, it is a
  /// dropped frame (FrameReady.dropped of the next one). A paused edit
  /// superseded by the next edit is not — no frame of playback was lost.
  bool playing = false;
  /// What building this frame cost on the CPU, ms (the document evaluated, the
  /// scene and its rasters planned); 0 for a cached job. A frame's real cost is
  /// this plus its GPU draw: a 600-layer comp builds in 60+ ms and draws in 3,
  /// and judged by the draw alone it never looked worth a disk file.
  double buildMs = 0;
  /// Drawn while an edit gesture is open (a drag, a scrub of a value) and the
  /// transport is not playing: a state that is never shown again, one per
  /// pointer move. Drawn and presented, but kept in no cache tier — storing it
  /// filled VRAM with throwaway frames, then paid a full-frame GPU read-back
  /// per move to push each evicted one into RAM (gigabytes over a few drags).
  bool transient = false;
  /// B4 round 2: the viewport's overlays subscribed (setOverlayGeometry): the sink sends `geometry` as
  /// FrameGeometry messages right before this frame's FrameReady (even when empty).
  bool geometrySubscribed = false;
  std::vector<api::OverlayLayerGeometry> geometry;
  /// B4 round 5: the subscribed views' cameras at this frame (FrameGeometry.views).
  std::vector<api::OverlayView> views;
  /// Record this frame in the viewport cache coverage (the timeline bars).
  /// Composition viewports only: a Layer-panel or held-time viewport draws a
  /// different picture at the same clock frame.
  bool recordCoverage = false;
  /// The cache scope: the composition plus the document revision and the
  /// viewport's view state this frame was built for (Session::cache_scope).
  /// Coverage is kept per scope, so the bars show what is cached for what the
  /// viewport shows NOW — not frames of another comp or of the document before
  /// an edit (those stay cached under their content keys and come back on a hit).
  std::uint64_t cacheScope = 0;
  /// The play range (work area, custom range or the whole comp), frame
  /// indices inclusive: the RAM tier never evicts its frames of this scope to
  /// make room (render/ram_cache.hpp ProtectedRange).
  std::int64_t rangeFirst = 0;
  std::int64_t rangeLast = -1;
  /// The frame's PRE-BUILD key (render/coverage_ledger.hpp prebuild_key: the
  /// viewport's view and the document's key for this frame, core/frame_keys.hpp),
  /// when the session could derive one. The render thread learns which content
  /// key a build of it produced, so the next job with this key needs no build.
  /// Absent = never learned (a Layer view, a held time, inputs outside the document).
  std::optional<std::uint64_t> prebuildKey;
  /// Built nothing: the session found `prebuildKey` in the sink's map, so
  /// `cachedKey` names a frame a cache tier holds (`cachedDiskKey` its disk
  /// key, 0 = none) and the job carries no built frame and no scene. The
  /// render thread presents it without a build or a draw; when no tier has it
  /// after all, it forgets the entry and asks the session for a built frame
  /// (FrameSink::take_build_requests) — never a blank slot.
  std::optional<std::uint64_t> cachedKey;
  std::uint64_t cachedDiskKey = 0;
  /// Ghosts composited over the live frame after it is drawn (onion skins).
  /// The live frame is what the cache stores; the ghosts are not.
  struct OnionGhost {
    std::shared_ptr<BuiltFrame> built;
    float opacity = 0;
    float tintR = 0;
    float tintG = 0;
    float tintB = 0;
    float tintStrength = 0;
  };
  std::vector<OnionGhost> onion;
  /// Comp-space caching (comp_space_frame): the frame is drawn into (or served
  /// from a tier as) a comp-space texture of this geometry and copied into the
  /// slot. Absent = slot space. Set by the Session with the port's per-frame copy.
  std::optional<CompSpaceFrame> compSpace;
  /// Preview resolution (Full / Half / Third / Quarter): the frame's own size,
  /// the viewport's pixels at that scale. The slots stay the viewport's full
  /// size (a resolution switch no longer rebuilds the ring); a smaller frame
  /// lands in the slot's top-left corner and FrameReady.contentWidth / Height
  /// tell the page which part to scale up. 0 = the slot's size.
  std::uint32_t contentWidth = 0;
  std::uint32_t contentHeight = 0;
  /// Idle render-ahead (Session::idle_prefetch): the frame is drawn and stored in
  /// the cache tiers (coverage recorded) but never presented — no slot, no
  /// FrameReady, the playhead stays where it is. Answered through
  /// RenderCounters::prefetched (drawn, stored or not, or dropped).
  bool prefetch = false;
};

/// The keys a cache tier holds a frame under: its content key
/// (render/frame_cache.hpp) and its disk key (render/disk_cache.hpp; 0 = never on disk).
struct CachedKeys {
  std::uint64_t content = 0;
  std::uint64_t disk = 0;
  bool operator==(const CachedKeys&) const = default;
};

/// One step of the document revision as the session saw it: which frames of
/// the active composition the edit could have changed (core/frame_keys.hpp),
/// so the coverage bars keep the rest (render/coverage_ledger.hpp) — and the
/// changed frames' new document keys, so a frame the cache still holds under
/// its new key (an undo) comes back to the bar at once.
struct FrameRevision {
  std::uint32_t fromRev = 0;  ///< Session::cache_scope's revision words
  std::uint32_t toRev = 0;
  bool all = true;                   ///< every frame changed (or the session cannot tell)
  std::vector<std::int64_t> frames;  ///< the changed frames, sorted, when !all
  std::vector<std::uint64_t> keys;   ///< their new document frame keys (parallel to `frames`); empty = unknown
};

/// getCacheCoverage: which composition frames the viewport frame cache holds.
/// Ranges are frame indices, end exclusive. The session turns them into comp time.
struct CacheCoverageSnap {
  std::vector<std::pair<std::int64_t, std::int64_t>> ram;
  /// Frames whose pixels are in the disk cache (render/disk_cache.hpp), [start, end).
  std::vector<std::pair<std::int64_t, std::int64_t>> disk;
  std::uint64_t ramBytes = 0;
  std::uint64_t diskBytes = 0;
  /// The tiers' budgets and the VRAM tier on its own (getRenderStats, the Cache & Memory panel).
  /// `ramBytes` above is VRAM + RAM together (what the timeline's green bar holds).
  std::uint64_t ramBudget = 0;
  std::uint64_t vramBytes = 0;
  std::uint64_t vramBudget = 0;
  std::uint64_t diskBudget = 0;
  /// The disk tier's measured read cost, ms per megapixel (0 = not measured yet).
  double diskReadMsPerMp = 0;
};

/// Adjacent frame indices become half-open ranges [start, end).
[[nodiscard]] inline std::vector<std::pair<std::int64_t, std::int64_t>> coalesce_frame_indices(
    std::vector<std::int64_t> frames) {
  std::sort(frames.begin(), frames.end());
  frames.erase(std::unique(frames.begin(), frames.end()), frames.end());
  std::vector<std::pair<std::int64_t, std::int64_t>> out;
  if (frames.empty()) return out;
  std::int64_t start = frames.front();
  std::int64_t prev = start;
  for (std::size_t i = 1; i < frames.size(); ++i) {
    if (frames[i] == prev + 1) {
      prev = frames[i];
      continue;
    }
    out.emplace_back(start, prev + 1);
    start = prev = frames[i];
  }
  out.emplace_back(start, prev + 1);
  return out;
}

/// setViewport `customView`: a custom 3D view (customViews.ts CustomViewParams)
/// — the eye starts `distance` behind the point of interest along −z, orbits
/// by yaw / pitch (degrees) and looks at it. Absent distance = 1.2 × the comp's
/// default focal length; absent poi = the comp centre on z = 0.
struct CustomViewParams {
  double yaw = 0;
  double pitch = 0;
  std::optional<double> distance;
  std::optional<std::array<double, 3>> poi;
  bool operator==(const CustomViewParams&) const = default;
};

/// setViewerLut: the viewer LUT every viewport's frames are graded with — the
/// stored `.cube` table (cubeLut.ts StoredLut) and its intensity 0..1.
struct ViewerLut {
  js::Json table;
  double intensity = 1;
};

/// A viewport's output: slot textures of width × height physical pixels.
struct ViewportConfig {
  std::uint32_t viewport = 0;
  std::uint32_t width = 0;   // physical px (CSS px × DPR)
  std::uint32_t height = 0;
  /// Preview resolution (full 1, half 0.5, third, quarter): the comp is
  /// rendered at this fraction and scaled up into the slot.
  double resolution = 1.0;
  /// setViewport `channel` (View ▸ Show Channel): applied on the final blit.
  api::ChannelView channel = api::ChannelView::rgb;
  bool open = false;
  /// D5: the page's view of the comp — screen CSS px per comp px, and the comp
  /// point at the viewport's centre (snapshotToFrameScene viewToCamera). zoom ≤ 0
  /// = fit the comp into the viewport (export_view).
  double zoom = 0.0;
  double panX = 0.0;
  double panY = 0.0;
  /// CSS px per physical px of the slot (the slot is width × height physical px).
  double devicePixelRatio = 1.0;
  /// setViewport `view`: the 3D view this viewport renders — 'active' (the
  /// composition's camera), an axis view (front, back, left, right, top,
  /// bottom), `camera:<layer>` or 'custom' (SnapshotComp.camera3dMode; baked
  /// into each job like the zoom, never a ring change).
  std::string view = "active";
  /// With view = 'custom': the view's own camera replaces the scene camera.
  std::optional<CustomViewParams> customView;
  /// setViewport `layer`: the Layer panel — this one layer alone, untransformed
  /// at its source size (BuildContext::layerView); '' = the composition.
  std::string layer;
  /// setViewport `layerRenderEffects`: false shows the untouched source.
  bool layerRenderEffects = true;
  /// setViewport `transparencyGrid`, with `layer`: a checkerboard behind the
  /// layer's own bounds, so what is transparent in it reads as transparent
  /// (frames reach the host opaque — it cannot draw one under them).
  bool layerTransparencyGrid = false;
  /// setViewport `layerAlphaView`, with `layer`: '' (the layer as it is), 'alpha', 'boundary' or 'overlay'.
  std::string layerAlphaView;
  /// setViewport `layerAlphaOverlayColor` / `layerAlphaOverlayOpacity`: the
  /// Alpha Overlay tint (`#rrggbb`) and its opacity 0..1.
  std::string layerAlphaOverlayColor = "#ff3df5";
  double layerAlphaOverlayOpacity = 0.5;
  /// setViewport `time`: a held comp time this viewport renders at (the Layer
  /// panel's own ruler); absent = the session clock.
  std::optional<api::Time> time;
  /// setViewport `layerSourceTime`: with `layer`, the layer's source time at the held time.
  std::optional<api::Time> layerSourceTime;
  /// setViewportHiddenLayers: layers this viewport's frames do not draw (the
  /// text layer being edited in place). Filled per frame by the Session; never
  /// part of a surface's stored config.
  std::vector<std::string> hiddenLayers;
  /// setViewportFocus: Focus Mode's working set. Non-empty = every layer not in
  /// it draws as a dim reference. Filled per frame by the Session, like
  /// `hiddenLayers`.
  std::vector<std::string> focusLayers;
  /// setViewport `onion`. Absent = off. Playback ignores it (ghosts are for a
  /// still playhead). Not a ring change.
  std::optional<api::OnionSkin> onion;
  /// setViewport `subjectView`: one layer's subject shown as overlay / black / white / alpha / boundary (BuildContext::subjectView).
  std::optional<api::SubjectView> subjectView;
  /// setPreviewQuality `draft3d` (AE's Draft 3D): lights, shadows, depth of field
  /// and camera motion off in this viewport's frames (SnapshotComp.draft3d).
  bool draft3d = false;
  /// setPreviewQuality `motionBlur`: false skips the motion-blur samples in
  /// this viewport's frames (Preview ▸ Draft Quality); exports keep them.
  bool previewMotionBlur = true;
  /// setViewport `exposure`: stops, on the final blit (RenderView.exposure).
  double exposure = 0;
  /// setViewport `transparencyGrid` on a composition view: a checkerboard
  /// where the comp is transparent, in place of its background colour.
  bool transparencyGrid = false;
  /// setViewport `clipToComp` (absent = true): false is the Extended Viewer —
  /// layers draw outside the composition's rectangle over the pasteboard
  /// colour (engine_frames.cpp). A layer view is never clipped.
  bool clipToComp = true;
  /// setViewport `groundGrid` (absent = false): the engine draws the 3D ground
  /// grid into this viewport's frames (E8). Never on a layer view or a ghost.
  bool groundGrid = false;
  /// setViewport `regionOfInterest` (comp px): draws are clipped to it.
  std::optional<api::Rect> regionOfInterest;
  /// setViewerLut, filled per frame by the Session like `hiddenLayers`.
  /// shared_ptr: one read-only table shared by every viewport's frame job on
  /// the render thread, instead of a copy of a 33³ table per frame.
  std::shared_ptr<const ViewerLut> viewerLut;
  /// setUseProxies, filled per frame by the Session like `viewerLut` (and only
  /// while some item has an enabled proxy): footage decodes from its proxy.
  /// Part of the cache view (same_cache_view), never of a surface's stored config.
  bool useProxies = false;
  /// Build this frame with a transparent background (an onion ghost). Never
  /// stored on a surface — only the copy handed to the frame builder.
  bool ghost = false;
  /// Comp-space caching (comp_space_frame below): this frame is drawn as the
  /// composition's own pixels at the view's scale, and presented into the slot
  /// by a copy. Filled per frame by the Session (never on a surface's stored
  /// config); absent = the frame is drawn straight into the slot, zoom and pan
  /// baked in (a Layer view, a ghost, the Extended Viewer, a channel view…).
  std::optional<CompSpaceFrame> compSpace;
  bool operator==(const ViewportConfig&) const = default;
};


/// D5: does going from `a` to `b` need a new slot ring? Only the slot
/// geometry does (which viewport, its physical size, open/closed, the preview
/// resolution). The camera (zoom / pan / DPR at the same physical size) is
/// baked into each job by the frame builder, so a hand-tool drag or a wheel
/// zoom — a setViewport per pointer move — must not re-create the shared
/// textures (and drop every frame in flight) 60 times a second.
/// The preview resolution as a pixel scale (0.1 … 1); anything unset or odd is full.
[[nodiscard]] inline double preview_scale(double resolution) {
  return resolution > 0 && resolution < 1 ? std::max(0.1, resolution) : 1.0;
}

/// The slot size a viewport's frames are drawn into: its physical size at the preview resolution.
[[nodiscard]] inline std::uint32_t preview_pixels(std::uint32_t physical, double resolution) {
  const double scaled = std::round(static_cast<double>(physical) * preview_scale(resolution));
  return physical == 0 ? 0U : static_cast<std::uint32_t>(std::max(1.0, scaled));
}

/// Whether the slots must be rebuilt. Not for a preview-resolution switch: the
/// slots are the viewport's full size and a reduced frame takes their corner
/// (RenderJob::contentWidth) — that rebuild was the 0.3–1.7 s stall that kept
/// adaptive resolution off during playback.
[[nodiscard]] inline bool ring_config_changed(const ViewportConfig& a, const ViewportConfig& b) {
  return a.viewport != b.viewport || a.width != b.width || a.height != b.height || a.open != b.open;
}

/// The comp-space frame a composition viewport `port` draws a `compW` × `compH`
/// composition as, or nullopt when the frame must be drawn in slot space: a
/// Layer view or a held time (another picture), a ghost, the Extended Viewer
/// (layers outside the comp rect), a region of interest, the ground grid, a
/// channel view or a viewer LUT (the slot's border colour would differ from
/// black), or a comp-space texture far larger than the slot (zoomed well in —
/// drawing the whole comp would cost more than the slot it fills).
/// The phase is the sub-pixel position of the comp origin in the slot, quantised
/// to 1/256 px so that pans by whole pixels (or floating-point noise in the
/// page's camera) share one frame; the picture moves by at most 1/512 px.
[[nodiscard]] inline std::optional<CompSpaceFrame> comp_space_frame(const ViewportConfig& port, double compW, double compH) {
  if (!port.layer.empty() || port.time || port.ghost || !port.clipToComp || port.groundGrid || port.regionOfInterest ||
      port.channel != api::ChannelView::rgb || port.viewerLut || port.width == 0 || port.height == 0 || !(compW >= 1) ||
      !(compH >= 1)) {
    return std::nullopt;
  }
  const double res = preview_scale(port.resolution);
  const auto slotW = static_cast<double>(preview_pixels(port.width, port.resolution));
  const auto slotH = static_cast<double>(preview_pixels(port.height, port.resolution));
  // The slot's camera, as engine_frames builds it (export_view, or the page's own).
  double zoom = 0;
  double dpr = 1;
  double originX = 0;  // the comp origin in slot px
  double originY = 0;
  if (port.zoom > 0) {
    const double pageDpr = port.devicePixelRatio > 0 ? port.devicePixelRatio : 1.0;
    const double cssW = std::max(1.0, static_cast<double>(port.width) / pageDpr);
    const double cssH = std::max(1.0, static_cast<double>(port.height) / pageDpr);
    zoom = port.zoom;
    dpr = pageDpr * res;
    originX = ((0 - port.panX) * zoom + cssW / 2) * dpr;
    originY = ((0 - port.panY) * zoom + cssH / 2) * dpr;
  } else {
    // export_view: the comp contain-fitted and centred in the slot.
    zoom = std::min(slotW / compW, slotH / compH);
    dpr = 1;
    originX = (slotW - compW * zoom) / 2;
    originY = (slotH - compH * zoom) / 2;
  }
  if (!(zoom > 0) || !std::isfinite(zoom) || !std::isfinite(originX) || !std::isfinite(originY)) return std::nullopt;
  const auto split = [](double origin, std::int32_t& whole, double& phase) {
    const double w = std::floor(origin);
    double p = std::round((origin - w) * 256.0) / 256.0;
    double wi = w;
    if (p >= 1.0) {
      p = 0;
      wi += 1;
    }
    if (std::abs(wi) > 1e9) return false;
    whole = static_cast<std::int32_t>(wi);
    phase = p;
    return true;
  };
  CompSpaceFrame cs;
  const double scale = zoom * dpr;
  constexpr double kMaxSide = 8192;  // Dawn's default maxTextureDimension2D
  // Off the power-of-two ladder: the comp at the next tier up, scaled into the slot.
  const double exactTier = std::exp2(std::round(std::log2(scale)));
  if (std::abs(scale / exactTier - 1) > 1e-3) {
    const double tier = std::exp2(std::ceil(std::log2(scale)));
    const double tw = std::ceil(compW * tier - 1e-6);
    const double th = std::ceil(compH * tier - 1e-6);
    if (!(tw >= 1) || !(th >= 1) || tw > kMaxSide || th > kMaxSide) return std::nullopt;
    // Never more than the comp at 100 % (zoomed out), nor than four slots (zoomed in).
    if (tier > 1 && tw * th > 4.0 * slotW * slotH) return std::nullopt;
    cs.width = static_cast<std::uint32_t>(tw);
    cs.height = static_cast<std::uint32_t>(th);
    cs.zoom = tier;
    cs.dpr = 1;
    cs.present = scale / tier;
    cs.originX = originX;
    cs.originY = originY;
    cs.slotX = static_cast<std::int32_t>(std::floor(std::clamp(originX, -1e9, 1e9)));
    cs.slotY = static_cast<std::int32_t>(std::floor(std::clamp(originY, -1e9, 1e9)));
    return cs;
  }
  if (!split(originX, cs.slotX, cs.phaseX) || !split(originY, cs.slotY, cs.phaseY)) return std::nullopt;
  // The texture covers the comp rect and the partial pixels at its edges (1e-6: a
  // comp edge that lands on a pixel boundary within noise adds no empty column).
  const double w = std::ceil(cs.phaseX + compW * scale - 1e-6);
  const double h = std::ceil(cs.phaseY + compH * scale - 1e-6);
  if (!(w >= 1) || !(h >= 1) || w > kMaxSide || h > kMaxSide) return std::nullopt;
  // Zoomed well in: the comp would cost more than twice the slot to draw. Slot space.
  if (w * h > 2.0 * slotW * slotH) return std::nullopt;
  cs.width = static_cast<std::uint32_t>(w);
  cs.height = static_cast<std::uint32_t>(h);
  cs.zoom = zoom;
  cs.dpr = dpr;
  return cs;
}

/// How the engine's media or render side answered a query the document core
/// cannot answer from document data (session_hooks.hpp, FrameSink).
enum class HookAnswer : std::uint8_t {
  unsupported,  ///< this build has no such system (the query answers `unsupported`)
  pending,      ///< not ready yet — a source still decoding (`busy`, ask again)
  ready,        ///< answered
  failed,       ///< tried and failed (`internal`, with why)
  /// Owed by another thread (the render thread's still or pixel read): the
  /// request's response waits for it off the core thread (Session::poll_deferred)
  /// instead of the core thread waiting on it — a query never holds the
  /// document core, so edits, playback and the heartbeat go on meanwhile.
  deferred,
};

/// FrameSink::port_counters: one viewport's frames.
struct PortCounters {
  std::uint64_t rendered = 0;  // FrameReady announced for this viewport
  std::uint64_t standIn = 0;   // of those, drawn with a footage stand-in (not stored)
};

struct RenderCounters {
  std::uint64_t rendered = 0;
  std::uint64_t dropped = 0;     // ring full or superseded before rendering
  double gpuFrameMs = 0;         // mean over the last second
  double fps = 0;                // delivered frames per second, last second
  double decodeMs = 0;           // the slowest footage source's decode time per frame (EMA)
  std::uint64_t vramBytes = 0;   // render graph targets + textures, converted footage, the frame cache
  /// A2: the last slot-SIZE switch (a preview-resolution / pane-size rebuild):
  /// when (epoch µs, 0 = never) and how long the rebuild took (ms).
  double slotSwitchEpochUs = 0;
  double slotSwitchMs = 0;
  /// Playback frames shown with footage from a nearest decoded frame (decode
  /// fell behind): not the real frame, and never cached. A looping play that
  /// had any fills the range at the wrap, as one that dropped frames does.
  std::uint64_t inexact = 0;
  /// Every frame drawn with a stand-in for its footage (a nearest decoded frame,
  /// a GPU error), playing or not: drawn, never stored. A cache fill re-draws
  /// such a frame instead of moving past it.
  std::uint64_t standIn = 0;
  /// Of the frames shown in the last second, the share served from a cache
  /// tier (VRAM, RAM or disk) instead of drawn (RenderStats.cacheHitRate).
  double cacheHitRate = 0;
  /// Jobs the session submitted without a build (RenderJob::cachedKey): presented
  /// from a tier, found in no tier after all (the session builds them), or
  /// dropped before they were looked at. The session polls these to know when
  /// every such job has been answered.
  std::uint64_t cacheServed = 0;
  std::uint64_t cacheMissed = 0;
  std::uint64_t cacheDropped = 0;
  /// Idle render-ahead jobs (RenderJob::prefetch) answered: drawn (stored or
  /// not), or dropped. The session submits one at a time and waits for this.
  std::uint64_t prefetched = 0;
  /// Video memory as the OS sees it (RenderThread::relieve_gpu_pressure; 0 =
  /// the OS does not say): this process's budget, what it holds, the adapter's
  /// size, and the bytes given back under pressure since the engine started.
  std::uint64_t gpuBudgetBytes = 0;
  std::uint64_t gpuUsedBytes = 0;
  std::uint64_t gpuTotalBytes = 0;
  std::uint64_t gpuTrimmedBytes = 0;
};

/// A sampled frame's GPU time per root-level layer (render_graph/gpu_profiler.hpp),
/// handed from the drawer to the session (RenderStats.layerCosts).
struct LayerProfile {
  struct Layer {
    std::string id;
    api::LayerCostKind kind = api::LayerCostKind::layer;
    double gpuMs = 0;
    std::uint32_t passes = 0;
  };
  std::vector<Layer> layers;  ///< heaviest first
  double totalMs = 0;
  /// When the sampled frame was drawn (steady clock, µs since its epoch).
  double drawnUs = 0;
};

/// getThumbnail: a frame the render thread drew offscreen and encoded.
struct StillImage {
  HookAnswer answer = HookAnswer::unsupported;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::string format;  // "png": straight-alpha 8-bit RGBA, sRGB-tagged
  std::vector<std::uint8_t> data;
  std::string error;   // why not, when answer != ready
};

/// readPixels: a region of the frame a viewport shows, in working space (the
/// float scene colour before the display transform and the viewer LUT),
/// straight alpha, top-down rows.
struct WorkingPixels {
  HookAnswer answer = HookAnswer::unsupported;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::vector<float> rgba;
  std::string error;
};

/// A slot-pixel rectangle (top-left origin), already clamped to the slot.
struct PixelRegion {
  std::uint32_t x = 0;
  std::uint32_t y = 0;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
};

template <class T>
[[nodiscard]] std::future<T> ready_future(T value) {
  std::promise<T> p;
  p.set_value(std::move(value));
  return p.get_future();
}

/// The render side as the document core sees it. Implemented by the render
/// thread (render/render_thread.cpp) and by a null sink in tests and fuzzing.
class FrameSink {
 public:
  FrameSink() = default;
  virtual ~FrameSink() = default;
  FrameSink(const FrameSink&) = delete;
  FrameSink& operator=(const FrameSink&) = delete;
  FrameSink(FrameSink&&) = delete;
  FrameSink& operator=(FrameSink&&) = delete;

  /// Newest job wins: a job not yet started when a newer one arrives is dropped.
  virtual void submit(RenderJob job) = 0;
  /// Whether `viewport` still holds a submitted job that has not started
  /// (playback back-pressure: the session skips building a frame it would supersede).
  [[nodiscard]] virtual bool job_pending(std::uint32_t /*viewport*/) const { return false; }
  /// A clock frame the session did not build for `viewport` because its job was
  /// pending (`skipped`, counted like a superseded job), with the frames the
  /// clock jumped before it (`clockJumped`, the session counts those): both
  /// reported with the viewport's next FrameReady, as a superseded job's are.
  virtual void note_dropped(std::uint32_t /*viewport*/, std::uint32_t /*skipped*/, std::uint32_t /*clockJumped*/) {}
  virtual void configure(const ViewportConfig& config) = 0;
  /// Use shared (cross-process) slot textures. Called once, from Hello.
  virtual void set_shared(bool shared) = 0;
  [[nodiscard]] virtual bool shared_supported() const = 0;
  /// Route A: read each frame back and write it to the pixel stream (fd 5,
  /// pixel_channel.hpp) before its FrameReady — for hosts that cannot import
  /// shared textures. Called once, from Hello, and only when not shared.
  virtual void set_copy(bool /*copy*/) {}
  [[nodiscard]] virtual bool copy_supported() const { return false; }
  [[nodiscard]] virtual RenderCounters counters() const = 0;
  /// One viewport's share of the counters: frames announced for it and how
  /// many of those drew with a stand-in. The cache fill waits on ITS viewport's
  /// frame — the global `rendered` moved whenever any viewport (a pop-out, a
  /// 2-up pane, the Layer panel) finished one, and the fill then submitted its
  /// next frame over a job of its own still queued, leaving holes in the bar.
  [[nodiscard]] virtual PortCounters port_counters(std::uint32_t /*viewport*/) const { return {}; }
  /// A cache fill is running (transport state `caching`): every frame it
  /// draws is stored — the disk tier takes the ones RAM refuses whatever
  /// they cost to draw (a fill that drops cheap frames leaves a gap the next
  /// pass renders again). Any thread.
  virtual void set_filling(bool /*filling*/) {}
  /// Whether every open viewport's slots accept texture copies in and out
  /// (comp-space frames are presented by a copy; a slot that cannot take one
  /// is drawn in slot space). Any thread.
  [[nodiscard]] virtual bool slots_copyable() const { return true; }
  /// Viewport frame-cache coverage (zeros when there is no cache).
  [[nodiscard]] virtual CacheCoverageSnap cache_coverage() const { return {}; }
  /// Sample the GPU time of the next frame drawn, per root-level layer (getRenderStats profileLayers).
  virtual void request_layer_profile() {}
  /// The newest finished sample (nullopt: none yet, or no GPU profiler).
  [[nodiscard]] virtual std::optional<LayerProfile> layer_profile() const { return std::nullopt; }
  /// Publish the coverage now rather than at its next throttled update: a
  /// cache fill just finished and the bar (and getCacheCoverage) must show it.
  virtual void publish_coverage_now() {}
  /// Drop the viewport frame cache (Purge RAM). The next frames fill it again.
  virtual void purge_frame_cache() {}
  /// setCacheBudget: the disk cache's folder (UTF-8) and size limit in bytes;
  /// "" or 0 turns it off (its files stay). Any thread.
  virtual void configure_disk_cache(const std::string& /*folder*/, std::uint64_t /*bytes*/) {}
  /// Purge Disk Cache: forget the disk cache's frames and delete its files.
  virtual void purge_disk_cache() {}
  /// setCacheBudget `ramMegabytes`: the RAM tier's size limit in bytes
  /// (render/ram_cache.hpp); 0 = sized from the machine. Any thread.
  virtual void configure_ram_cache(std::uint64_t /*bytes*/) {}
  /// The keys a build of the frame with pre-build key `key` produced, when the
  /// sink learned them and a tier may still hold the frame (render/coverage_ledger.hpp
  /// PrebuildMap). The session then submits the job without building it. Any thread.
  [[nodiscard]] virtual std::optional<CachedKeys> cached_frame(std::uint64_t /*key*/) const { return std::nullopt; }
  /// A document revision step: which frames of the active composition it could
  /// have changed. The coverage bars keep the other frames. Core thread, in revision order.
  virtual void note_frames_changed(FrameRevision /*rev*/) {}
  /// Viewports whose last job the sink could not present from a tier (a cached
  /// job whose frame was evicted meanwhile; a pixel read of a frame it has no
  /// build of): the session builds their current frame. Taken, so each is
  /// answered once. Any thread.
  [[nodiscard]] virtual std::vector<std::uint32_t> take_build_requests() { return {}; }
  [[nodiscard]] virtual std::string adapter() const = 0;
  [[nodiscard]] virtual std::string backend() const = 0;

  /// getThumbnail: draw `frame` (built for a width × height surface) offscreen
  /// and encode it. The future is ready once the render thread got to it,
  /// between viewport frames. Default: no renderer (`unsupported`).
  [[nodiscard]] virtual std::future<StillImage> render_still(std::shared_ptr<BuiltFrame> /*frame*/,
                                                             std::uint32_t /*width*/, std::uint32_t /*height*/) {
    StillImage out;
    out.error = "this engine has no renderer (--no-gpu)";
    return ready_future(std::move(out));
  }
  /// readPixels: `region` of the frame last drawn for `viewport`, in working
  /// space. Default: no renderer (`unsupported`).
  [[nodiscard]] virtual std::future<WorkingPixels> read_pixels(std::uint32_t /*viewport*/, PixelRegion /*region*/) {
    WorkingPixels out;
    out.error = "this engine has no renderer (--no-gpu)";
    return ready_future(std::move(out));
  }
  /// sampleImage: draw `frame` (built for a width × height surface) offscreen
  /// and read all of it in working space, straight (not premultiplied). Any
  /// thread; ready once the render thread got to it, between viewport frames.
  /// Default: no renderer (`unsupported`).
  [[nodiscard]] virtual std::future<WorkingPixels> read_frame(std::shared_ptr<BuiltFrame> /*frame*/, std::uint32_t /*width*/,
                                                              std::uint32_t /*height*/) {
    WorkingPixels out;
    out.error = "this engine has no renderer (--no-gpu)";
    return ready_future(std::move(out));
  }
};

}  // namespace premation
