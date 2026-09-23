// The engine's document — C2's minimal subset of docs/ENGINE_API.md §3–§4:
// compositions, and solid / shape / rectangle / null layers with a transform,
// opacity, colour and size, each property static or keyframed.
//
// Plain value types. The document core thread is the only thread that ever
// touches a Document (session.cpp); the render thread receives an evaluated
// FrameScene, never the document.
//
// Ids are minted here and never reused within a document: undo restores the
// SAME id (§3.1). They are opaque strings to the UI ("L7", "C1", "K12").
#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "engine_api.hpp"

namespace premation::doc {

namespace api = premation::api;

/// Static description of one property a layer kind has.
struct PropertySpec {
  std::string_view path;
  std::string_view name;
  std::string_view matchName;
  std::string_view unit;
  api::ValueType type = api::ValueType::scalar;
  bool animatable = true;
  std::uint32_t dimensions = 1;
  std::optional<double> min;
  std::optional<double> max;
};

/// The properties a layer of `kind` carries, in display order. Empty for kinds
/// C2 does not implement (createLayer answers `unsupported` for those).
[[nodiscard]] std::span<const PropertySpec> catalog_for(api::LayerKind kind) noexcept;
[[nodiscard]] const PropertySpec* find_spec(api::LayerKind kind, std::string_view path) noexcept;
[[nodiscard]] bool kind_supported(api::LayerKind kind) noexcept;
/// Kinds that draw a filled quad (null layers draw nothing).
[[nodiscard]] bool kind_renders(api::LayerKind kind) noexcept;

struct Property {
  api::ValueType type = api::ValueType::scalar;
  api::Value value;                  ///< the static value (used when `keys` is empty)
  std::vector<api::Keyframe> keys;   ///< sorted by time, unique times
  bool operator==(const Property&) const = default;
};

struct Layer {
  api::LayerId id;
  api::ItemId comp;
  api::LayerKind kind = api::LayerKind::solid;
  std::string name;
  api::LayerTiming timing;
  api::LayerSwitches switches;
  std::map<std::string, Property, std::less<>> props;
  bool operator==(const Layer&) const = default;
};

struct Comp {
  api::ItemId id;
  api::CompSettings settings;
  std::vector<api::LayerId> layers;  ///< stack order, top first
  bool operator==(const Comp&) const = default;
};

struct Document {
  std::map<api::ItemId, Comp, std::less<>> comps;
  std::vector<api::ItemId> itemOrder;  ///< project panel order
  std::map<api::LayerId, Layer, std::less<>> layers;
  // Id counters. Deliberately NOT restored by undo: an id, once minted, is
  // never handed out again in this document.
  std::uint64_t nextComp = 1;
  std::uint64_t nextLayer = 1;
  std::uint64_t nextKey = 1;

  [[nodiscard]] Comp* comp(std::string_view id);
  [[nodiscard]] const Comp* comp(std::string_view id) const;
  [[nodiscard]] Layer* layer(std::string_view id);
  [[nodiscard]] const Layer* layer(std::string_view id) const;

  std::string mint_comp_id() { return "C" + std::to_string(nextComp++); }
  std::string mint_layer_id() { return "L" + std::to_string(nextLayer++); }
  std::string mint_key_id() { return "K" + std::to_string(nextKey++); }
};

// ── Values ─────────────────────────────────────────────────────────────────

[[nodiscard]] api::ValueType value_type_of(const api::Value& v) noexcept;
[[nodiscard]] api::Value make_scalar(double x);
[[nodiscard]] api::Value make_vec2(double x, double y);
[[nodiscard]] api::Value make_color(double r, double g, double b, double a);
/// Components of a numeric value (scalar 1, vec2 2, vec3 3, vec4/color 4); empty otherwise.
[[nodiscard]] std::size_t components(const api::Value& v, std::span<double, 4> out) noexcept;
/// Rebuild a value of `type` from components.
[[nodiscard]] api::Value from_components(api::ValueType type, std::span<const double> c);
[[nodiscard]] bool all_finite(const api::Value& v) noexcept;

// ── Defaults ───────────────────────────────────────────────────────────────

[[nodiscard]] api::CompSettings default_comp_settings();
/// A new layer of `kind` in `comp`, every property at its default.
[[nodiscard]] Layer make_layer(api::LayerKind kind, const Comp& comp, std::string id, std::string name);
[[nodiscard]] api::Value default_value(const PropertySpec& spec, const Comp& comp);

// ── Records for the protocol ───────────────────────────────────────────────

[[nodiscard]] api::LayerInfo layer_info(const Layer& layer);
[[nodiscard]] api::ItemInfo comp_item_info(const Comp& comp);
[[nodiscard]] api::CompInfo comp_info(const Comp& comp);
/// `value` is the value to report (static, or evaluated at the caller's time).
[[nodiscard]] api::PropertyInfo property_info(const Layer& layer, const std::string& path, const Property& prop,
                                              api::Value value);
[[nodiscard]] api::KeyframeSet keyframe_set(const Layer& layer, const std::string& path, const Property& prop);

/// Frames per second as a double; 0 when the rate is invalid.
[[nodiscard]] double fps_of(const api::Rational& r) noexcept;
/// Flicks per frame, rounded down (exact for every standard and NTSC rate).
[[nodiscard]] api::Time frame_duration(const api::Rational& r) noexcept;

inline constexpr api::Time kFlicksPerSecond = 705'600'000;

}  // namespace premation::doc
