// B3z worker C (ENGINE_API.md §15.9) — ports of:
//   src/core/paint/strokeValues.ts     the stroke rows' static seam (a stroke track ⇄ its stack entry)
//   src/core/engine/strokeStack.ts     `layer/strokes` (json field) and `removeStroke`
//   src/core/engine/fillStops.ts       `layer/fillStops` (Gradient Fill ▸ Colors, a gradient Value)
//   src/core/engine/pointOfInterest.ts `transform/orientTowardsPointOfInterest`
//   src/core/engine/latentProps.ts     the LATENT numeric bindings (latentPropSpecs.ts)
#pragma once

#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "model.hpp"
#include "props.hpp"

namespace premation::doc {

// ── the stroke stack ─────────────────────────────────────────────────────
/// stroke.ts `normalizeStroke`.
[[nodiscard]] Json normalize_shape_stroke(const Json& v);
/// stroke.ts `readNodeStrokes`: the stack (normalised, disabled included), else [fx.stroke].
[[nodiscard]] std::vector<Json> node_strokes(const Node& n);
/// stroke.ts `storeNodeStrokes`: normalised; the stack kept only when > 1; strokes[0] mirrored.
void store_node_strokes(Document& d, std::string_view layer, const std::vector<Json>& strokes);

/// The stroke-stack entry a stroke track names on this layer (strokeTracks.ts), or nullopt —
/// a text layer's primary names (`strokeWidth`, `stroke_r`…) are its Text component's.
struct StrokeTrackHit {
  std::size_t index = 0;
  std::string param;
  std::string channel;  ///< "" or "_r"/"_g"/"_b"/"_a"
  Json stroke;          ///< the normalised entry
};
[[nodiscard]] std::optional<StrokeTrackHit> stroke_track_hit(const Node& n, std::string_view prop);
/// strokeValues.ts `readStrokeParam` (+ a colour channel of the entry's colour).
[[nodiscard]] std::optional<double> read_stroke_track(const Node& n, const StrokeTrackHit& h);
/// strokeValues.ts `withStrokeParam` + store: false when the stroke cannot take it.
bool write_stroke_track(Document& d, std::string_view layer, const StrokeTrackHit& h, double value);
/// A colour base (`stroke`, `stroke.<i>.color`) backed by a stack entry: its index, or nullopt.
[[nodiscard]] std::optional<std::size_t> stroke_color_index(const Node& n, const std::string& base);
[[nodiscard]] std::string stroke_color_at(const Node& n, std::size_t index);
void set_stroke_color_at(Document& d, std::string_view layer, std::size_t index, const std::string& hex);

/// `layer/strokes` — presence, read, write (drops the tracks of lost tail strokes / dash slots).
[[nodiscard]] bool has_stroke_host(const Node& n, bool paintHost);
[[nodiscard]] api::Value read_stroke_stack(const Node& n);
void write_stroke_stack(Document& d, std::string_view layer, const std::string& path, const api::Value& value);
/// `removeStroke` — validates now (outOfRange), returns the apply step.
[[nodiscard]] std::function<void()> plan_remove_stroke(Document& d, std::string_view layer, double index);

// ── Gradient Fill ▸ Colors ───────────────────────────────────────────────
[[nodiscard]] std::optional<PropBinding> fill_stops_binding(const Document& d, const Node& n, std::string_view layer);
[[nodiscard]] api::Value read_fill_stops_static(const Node& n);
void write_fill_stops_static(Document& d, std::string_view layer, const PropBinding& b, const api::Value& value);
[[nodiscard]] api::Value fill_stops_key_to_api(const Node& n, const Json& v);
[[nodiscard]] Json api_to_fill_stops_key(const PropBinding& b, const api::Value& value);
[[nodiscard]] bool has_gradient_fill(const Node& n);

// ── Orient Towards Point of Interest ─────────────────────────────────────
inline constexpr std::string_view kPoiPath = "transform/orientTowardsPointOfInterest";
[[nodiscard]] api::Value read_point_of_interest(const Node& n);
void write_point_of_interest(Document& d, std::string_view layer, const api::Value& value);

// ── latent numeric bindings ──────────────────────────────────────────────
struct LatentMember {
  std::string member;
  std::vector<std::string> home;
};
[[nodiscard]] std::vector<LatentMember> latent_members(const Node& n);

}  // namespace premation::doc
