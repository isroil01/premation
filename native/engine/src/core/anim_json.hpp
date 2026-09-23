// NodeAnim ⇄ the TypeScript `NodeAnimSnapshot` JSON (packages/animation
// snapshotNode / restoreNode): `{tracks: {prop: Keyframe[]}, expressions:
// {prop: {src, enabled}}, data: {prop: {nodeId, prop, kind, keyframes}}}`.
// Used by the project document (docio) and copy/paste fragments. Keyframe
// objects are written in one canonical key order (t, value, id, easing, bezier,
// continuous, roving, spatialInterp, si, so, label); readers accept any order.
#pragma once

#include <optional>
#include <string_view>

#include "model.hpp"

namespace premation::doc {

[[nodiscard]] Json key_to_json(const Key& k);
[[nodiscard]] std::optional<Key> key_from_json(const Json& j);
[[nodiscard]] Json data_key_to_json(const DataKey& k);
[[nodiscard]] std::optional<DataKey> data_key_from_json(const Json& j);

/// `snapshotNode(id)` shape for one node (`nodeId` fills the data tracks' field).
[[nodiscard]] Json anim_to_json(const NodeAnim& a, std::string_view nodeId);
/// `restoreNode(id, snap)` input → NodeAnim (malformed entries are skipped).
[[nodiscard]] NodeAnim anim_from_json(const Json& snap);

/// api::Easing ⇄ the TypeScript EasingKind / SpatialInterp spellings.
[[nodiscard]] std::optional<api::Easing> easing_from_string(std::string_view s);
[[nodiscard]] std::string_view easing_to_string(api::Easing e);
[[nodiscard]] std::optional<api::SpatialInterp> spatial_from_string(std::string_view s);
[[nodiscard]] std::string_view spatial_to_string(api::SpatialInterp s);

}  // namespace premation::doc
