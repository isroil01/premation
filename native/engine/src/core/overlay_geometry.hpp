// The frame-synchronous overlay geometry push (B4 round 2, ENGINE_API.md
// §15.12, docs/TS_ENGINE_REMOVAL.md "Gaps"): `setOverlayGeometry` subscribes a
// viewport; every frame the core builds for it carries, evaluated at the
// frame's own time and revision, the geometry the page's overlays draw —
// world matrices, drawn boxes, motion paths, text boxes — and the render
// thread (or the simulated sink) sends it as FrameGeometry messages right
// before the frame's FrameReady. The document is read here, on the core
// thread, never on the render thread. The TypeScript twin (the in-page
// renderer's producer) is src/core/engine/overlayGeometry.ts.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "engine_api.hpp"
#include "props.hpp"

namespace premation {
class TextQueries;  // scene/session_hooks.hpp
}

namespace premation::doc {

/// One viewport's subscription (setOverlayGeometry). No layers = none.
struct OverlaySubscription {
  std::uint32_t viewport = 0;
  std::vector<std::string> layers;
  std::vector<api::OverlayKind> kinds;
  /// B4 round 5: per-overlay layer × kind requests (a layer gets the union of the kinds naming it).
  std::vector<api::OverlayRequest> groups;
  /// B4 round 5: the view modes whose cameras each frame carries (FrameGeometry.views).
  std::vector<std::string> views;
  /// B4 round 5: the rig overlay's focus (setOverlayGeometry `rig`; the records are filled by Session through RigQueries).
  std::optional<api::OverlayRigOptions> rig;
  [[nodiscard]] bool active() const noexcept {
    if (!layers.empty() && !kinds.empty()) return true;
    if (!views.empty()) return true;
    for (const api::OverlayRequest& g : groups) {
      if (!g.layers.empty() && !g.kinds.empty()) return true;
    }
    return false;
  }
  [[nodiscard]] bool wants(api::OverlayKind k) const;
};

/// B4 round 5: each subscribed layer with the kinds it gets, in order — `layers` (× `kinds`) first, then each
/// group's layers not listed yet (overlayGeometry.ts `subscribedLayerKinds`).
[[nodiscard]] std::vector<std::pair<std::string, std::vector<api::OverlayKind>>> subscribed_layer_kinds(
    const OverlaySubscription& sub);

/// B4 round 5: the subscribed views' cameras at comp time `time` in composition `comp` (the viewport's), in
/// subscription order (overlayScene3d.ts `viewOf`). No composition = none.
[[nodiscard]] std::vector<api::OverlayView> overlay_views(const PCtx& pc, const OverlaySubscription& sub,
                                                        const std::optional<std::string>& comp, api::Time time);

/// B4 round 5: one layer's scene3d record at comp `seconds` (overlayScene3d.ts `scene3dOf`); nullopt when it is not a
/// camera, a light or a 3D-enabled layer that can be 3D.
[[nodiscard]] std::optional<api::OverlayScene3D> scene3d_of(const PCtx& pc, const std::string& layer, double seconds);

/// At most this many points on a motion path (the frame channel's 4 KiB payload cap).
inline constexpr std::uint32_t kOverlayPathPoints = 128;

/// The subscribed layers' geometry at comp time `time` (flicks), in the
/// subscription's layer order; a layer that is gone, or has no canvas box for
/// `bounds`, is left out of that kind. `text` null = no text boxes / text
/// bounds (the headless engine): those fields stay empty.
[[nodiscard]] std::vector<api::OverlayLayerGeometry> overlay_geometry(const PCtx& pc, TextQueries* text,
                                                                     const OverlaySubscription& sub, api::Time time);

/// Pack `layers` into FrameGeometry messages whose encoded payload stays under
/// the frame channel's cap: records are split by field when one would not fit
/// alone (a long motion path is thinned). `last` is set on the final message;
/// an empty `layers` still yields one (empty, last) message so the host knows
/// the frame had none.
/// B4 round 5: `views` ride the first message.
[[nodiscard]] std::vector<api::FrameGeometry> pack_frame_geometry(std::uint32_t viewport, std::uint32_t generation,
                                                                 std::int64_t frame, api::Time time, api::Revision revision,
                                                                 std::vector<api::OverlayLayerGeometry> layers,
                                                                 std::vector<api::OverlayView> views = {});

}  // namespace premation::doc
