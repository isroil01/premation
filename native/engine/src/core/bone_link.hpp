// Character rig, Tier 1: a part layer that follows a bone of its character.
//
// A character is a group layer whose fx carries a skeleton (fx.skeleton, the
// same JSON a single-layer bone rig uses). A part is a child of that group whose
// fx carries `parentBone: "<boneId>"`. Every parent-chain walker inserts the
// bone's LINK between the group and the part:
//
//   world(part) = world(group) · link · local(part),   link = pose · stretch · bind⁻¹
//
// The group's bones live in the group's CHILD space (the space its children's
// x / y are in), not in its box: a group's box is the union of its children and
// moves with them. At the bind pose the link is the identity, so binding never
// moves a part.
#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>

#include "model.hpp"
#include "skeleton_pose.hpp"
#include "transform.hpp"

namespace premation::doc {

struct EditorView;
class ExprEnv;
class ExprCache;

/// The bone `part` follows: its fx `parentBone` when the scene parent is a group whose skeleton has that bone;
/// nullptr otherwise (not bound, or the binding points at nothing — the part then follows the group alone).
[[nodiscard]] const std::string* bound_bone(const Document& d, const Node& part);

/// The group's skeleton (fx.skeleton with at least one bone), or nullptr.
[[nodiscard]] const js::Json* character_skeleton(const Node& group);

/// A character's skeleton solved at one time: every bone's link (pose · stretch · bind⁻¹). A walker that places
/// several parts of one character at one time solves it once (snapshot_build.cpp Walk).
struct CharacterPose {
  std::unordered_map<std::string, motion::xf::Mat2D> links;
};
/// The character `group`'s pose at its keyframe-axis time `rigT`, its tracks read through `anim`; nullopt when
/// `group` is not a character.
[[nodiscard]] std::optional<CharacterPose> character_pose(const Node& group, double rigT, const scene::RigSampler& anim);

/// The link of `bone` of the character `group` (character_pose for one bone). nullopt when there is no such bone.
[[nodiscard]] std::optional<motion::xf::Mat2D> bone_link(const Node& group, std::string_view bone, double rigT,
                                                         const scene::RigSampler& anim);

/// `part`'s link at comp `seconds`, the document's animation (expressions included) driving the bones.
/// nullopt when `part` is not bound.
[[nodiscard]] std::optional<motion::xf::Mat2D> bone_link_at(const Document& d, const EditorView& view,
                                                            const ExprEnv& expr, ExprCache& cache, const Node& part,
                                                            double seconds);

/// `part`'s link from the stored (unanimated) skeleton — what world_matrix_static composes.
[[nodiscard]] std::optional<motion::xf::Mat2D> bone_link_static(const Document& d, const Node& part);

}  // namespace premation::doc
