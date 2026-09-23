// Helpers shared by the edit handlers — src/core/engine/handlers/common.ts and
// doc.ts's `require*` validators.
#pragma once

#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "engine_ctx.hpp"
#include "fail.hpp"
#include "scene.hpp"
#include "timeline.hpp"
#include "variant_util.hpp"

namespace premation::doc {

/// Anchors the `handle` overload set (the dispatcher's lookup needs the name
/// to exist even before every family has handlers). Never called.
struct NoCommand {};
void handle(const NoCommand&, HCtx&);

/// `requireLayer`: the node, or notFound (a comp root is not a layer).
const Node& require_layer(const Document& d, std::string_view id);
/// `requireComp`.
void require_comp(const Document& d, std::string_view id);
/// `requireItem`.
ItemRef require_item(const Document& d, std::string_view id);
/// `checkTime` — API times are integer flicks already; kept for parity of call sites.
inline void check_time(api::Time /*t*/, std::string_view /*what*/ = "time") {}

/// `ensureTimeline(comp)`: build it now (journaled, inside the command).
void ensure_timeline(Document& d, std::string_view comp);
/// `requireLayersInOneComp(ids)` → their shared composition.
std::string require_layers_in_one_comp(const Document& d, const std::vector<std::string>& ids);
/// `remintKeyIds(layer)`: every stable key id a copied layer carries gets a fresh one.
void remint_key_ids(HCtx& x, std::string_view layer);
/// `moveInStack(comp, ids, toIndex)`.
/// `ignore`: layers that do not count toward `toIndex` (pasteLayers: the pasted tops' own descendants).
void move_in_stack(Document& d, std::string_view comp, const std::vector<std::string>& ids, std::size_t toIndex,
                   const std::set<std::string>* ignore = nullptr);

/// `Math.round` of a flicks value in frames (`flicksToFrames`) at the comp's rate.
[[nodiscard]] double comp_frames(const Document& d, std::string_view comp, api::Time flicks);

}  // namespace premation::doc
