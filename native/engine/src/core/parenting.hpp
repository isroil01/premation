// Parenting and layer deletion — src/core/scene/parenting.ts and
// deleteLayerNode.ts over the document. Parenting is nesting in this engine
// (a child layer is a child node); keeping the world transform compensates the
// child's position/rotation/scale (and their keyframes) at the ACTIVE TAB's
// playhead, exactly as the editor does.
#pragma once

#include <optional>
#include <string>
#include <string_view>

#include "props.hpp"

namespace premation::doc {

/// `canReparent(child, newParent)`.
[[nodiscard]] bool can_reparent(const Document& d, std::string_view child, const std::optional<std::string>& newParent);
/// `setParentPreservingWorld(child, target)`.
void set_parent_preserving_world(const PCtx& c, const std::string& child, const std::string& target);
/// Character rig: make `child` a part of the character `group` following `bone` (nullopt = no bone: it stays in the
/// group and follows the group alone), keeping its world transform at the active tab's playhead. The caller has
/// checked the group, the bone and that the move cannot cycle.
void bind_to_bone_preserving_world(const PCtx& c, const std::string& child, const std::string& group,
                                   const std::optional<std::string>& bone);
/// `reparentNode(child, newParent, {preserveWorld, jump, time})`; false when refused.
/// `jumpAt` (comp seconds) = Parent & Link JUMP (ignored when un-parenting).
bool reparent_node(const PCtx& c, const std::string& child, const std::optional<std::string>& newParent, bool preserveWorld,
                   std::optional<double> jumpAt = std::nullopt);
/// `deleteLayerNode(id)`: the node, its subtree and their animation; false for a root or a locked layer.
bool delete_layer_node(Document& d, std::string_view id);

}  // namespace premation::doc
