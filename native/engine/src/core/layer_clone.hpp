// Clone one layer's scene node — src/core/scene/cloneLayerNode.ts and
// src/core/animation/cloneNodeAnimation.ts (`copyNodeAnimation`).
//
// Shared by the operations that turn one layer into two INDEPENDENT layers:
// split and work-area lift/extract (layer time), duplicate (layers).
#pragma once

#include <string_view>

#include "model.hpp"

namespace premation::doc {

/// `cloneLayerNode(sourceId, newId)`: deep-clone the node as `newId` (component
/// ids `<newId>_<type>`, same name / visibility / lock; NOT solo, shy or label
/// colour, and no children), inserted directly above the original in its
/// parent's child list, carrying the original's whole animation (keyframes
/// with their ids as they are — callers re-mint — data tracks, expressions).
/// False when the source is missing or a root, or `newId` is taken.
bool clone_layer_node(Document& d, std::string_view sourceId, std::string_view newId);

/// `copyNodeAnimation(fromId, toId)`: every track (setKeyframes), data track
/// and expression of `fromId` written onto `toId`.
void copy_node_animation(Document& d, std::string_view fromId, std::string_view toId);

}  // namespace premation::doc
