// Property metadata — src/core/inspector/propertyMeta.ts `resolvePropertyMeta`:
// the static table (generated, catalog_data.inc) plus the resolver families for
// id-scoped paths (effect params, masks, path operators, text animators,
// strokes 2+, paint, colour channels, light options…), in the TypeScript's
// resolver order. Only the fields the engine API reads are carried.
#pragma once

#include <optional>
#include <string>
#include <string_view>

#include "model.hpp"

namespace premation::doc {

struct PropertyMeta {
  std::string label;
  std::string group;
  std::string type;
  std::string unit;
  std::optional<double> min;
  std::optional<double> max;
  Json defaultValue = Json::null();  ///< number | string | bool | null
  bool keyframeable = true;
  std::optional<double> displayScale;
};

/// `resolvePropertyMeta(path, nodeId?)` — always an entry (title-cased fallback).
/// `node` is the layer asking (nullptr = no node context).
[[nodiscard]] PropertyMeta resolve_property_meta(std::string_view path, const Node* node);
/// `hasPropertyMeta(path, nodeId?)`: described by the table or a resolver.
[[nodiscard]] bool has_property_meta(std::string_view path, const Node* node);

/// strokeTracks.ts: the track path of `param` on stroke `index`.
[[nodiscard]] std::string stroke_track_path(std::size_t index, std::string_view param);
struct StrokeTrackRef {
  std::size_t index = 0;
  std::string param;
  std::string channel;  ///< "" or "_r"/"_g"/"_b"/"_a"
};
[[nodiscard]] std::optional<StrokeTrackRef> parse_stroke_track_path(std::string_view path);

}  // namespace premation::doc
