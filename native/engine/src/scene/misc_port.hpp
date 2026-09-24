// Feature families the D2w "misc" port adds to the scene builder, each a
// port of its TypeScript twin (cited per function):
//
//   glass_port.cpp   resolveGlass (effects/glassResolve.ts) +
//                    toRenderableGlass (rendering/snapshotToFrameScene.ts)
//   retime_port.cpp  retime.ts: hasRetime, pickRetimeBar, retimeClipOf,
//                    retimedChainTime (Speed % integral / Frame Number)
#pragma once

#include <optional>
#include <string_view>
#include <vector>

#include "anim.hpp"
#include "engine_api.hpp"
#include "model.hpp"
#include "readers.hpp"
#include "scene_types.hpp"

namespace premation::scene {

// ── retime (src/core/animation/retime.ts) ────────────────────────────────

/// What the retime reads of the document (the snapshot's own sampling context).
struct RetimeReader {
  const doc::Document& d;
  const doc::ExprEnv& expr;
  doc::ExprCache& cache;
};
/// RetimeClip: clip-axis minus comp time, and the bar's in-point (seconds).
struct RetimeClip {
  double offsetSec = 0;
  double inSec = 0;
};
/// `hasRetime(anim, id)`.
[[nodiscard]] bool has_retime(const doc::Document& d, std::string_view node);
/// `pickRetimeBar(bars, frame)`: the bar live at `frame`, else the nearest (null when none).
[[nodiscard]] const doc::Bar* pick_retime_bar(const std::vector<const doc::Bar*>& bars, double frame);
/// `retimeClipOf(bar, fps)`.
[[nodiscard]] std::optional<RetimeClip> retime_clip_of(const doc::Bar* bar, double fps);
/// `retimedChainTime(anim, id, t, clip)`: nullopt when the layer is not retimed.
[[nodiscard]] std::optional<double> retimed_chain_time(const RetimeReader& r, std::string_view node, double t,
                                                       const std::optional<RetimeClip>& clip);

/// `resolveGlass(style, av, globalLightAngle)`: nullopt when the style is
/// absent or not enabled.
[[nodiscard]] std::optional<ResolvedGlass> resolve_glass(const Json& style, const Values& av, double globalLightAngle);

/// `toRenderableGlass(g)`: hex → Color, degrees → radians.
[[nodiscard]] api::RenderGlass to_renderable_glass(const ResolvedGlass& g);

}  // namespace premation::scene
