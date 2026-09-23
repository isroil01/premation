// FIELD properties (G1) — src/core/engine/fields.ts: the static values a layer
// carries outside its keyframe tracks, addressed as ordinary API properties.
//
//   text/<key>                                 Text component fields (textFields.ts TEXT_FIELDS)
//   text/styleRuns                             the per-character style runs (json)
//   text/pathOptions/path                      Path Options ▸ Path: one of the layer's masks ('' = none)
//   text/animators/<a>/props/<key>             animator fields, and the optional Fill / Stroke Color
//   text/animators/<a>/selectors/<s>/<key>     selector fields (kind switched in place, Based On, …)
//   layer/fill                                 the layer's own solid fill colour (keyed through fill_r/_g/_b/_a)
//
// Plus the numeric bindings the block owns: an animator's Blur Y (always
// addressable; unset = linked to, and read as, Blur X) and the registered font
// axes text/axes/wght|wdth|slnt (members fontWeight / fontWidth / fontSlant).
// The field SPECS are the TypeScript table, generated into the catalog data
// (`registry().fields`).
#pragma once

#include <functional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "model.hpp"
#include "props.hpp"

namespace premation::doc {

/// fields.ts `addFieldBindings`: this block's bindings, in their fixed order.
void add_field_bindings(const Node& node, std::string_view layerId, const std::vector<Json>& animators,
                        const std::function<void(PropBinding)>& add,
                        const std::function<bool(std::string_view)>& has);

/// The static value of a `field` / `layerFill` binding.
[[nodiscard]] api::Value read_field(const Node& node, const PropBinding& b);
/// Write a `field` / `layerFill` binding (type-checked; typeMismatch / outOfRange / notFound).
void write_field(Document& d, std::string_view layer, const PropBinding& b, const api::Value& value);

/// Drop every track, expression and data track named in `props` (fields.ts `dropTrackProps`).
void drop_track_props(Document& d, std::string_view layer, const std::set<std::string>& props);

/// The field spec (a TEXT_FIELDS / ANIMATOR_FIELDS / … entry) for a binding, or nullptr.
[[nodiscard]] const Json* field_spec(const FieldRef& f);

}  // namespace premation::doc
