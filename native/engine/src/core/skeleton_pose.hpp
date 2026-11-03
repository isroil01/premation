// The skeleton's pose without a mesh: bones, FK (compute_world), IK (two-bone,
// FABRIK, the IK/FK blend), the stored bind pose and the live bone / IK-goal
// sampling. Moved out of scene/rig_mesh.cpp (2026-11-03, character rig) so the
// transform walkers in engine_core can follow a bone — a part layer bound to a
// bone of its character (bone_link.hpp) — and rig_mesh.cpp keeps using it.
#pragma once

#include <array>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "json.hpp"

namespace premation::scene {

/// The animation reads the rig needs (AnimationEngine.sample / sampleData on the layer's node).
struct RigSampler {
  std::function<std::optional<double>(std::string_view path, double t)> sample;
  std::function<std::optional<js::Json>(std::string_view path, double t)> sampleData;
};

/// One stored IK goal, live at the time.
struct RigIkOut {
  std::string bone;
  bool enabled = true;
  double x = 0, y = 0;
  std::optional<std::array<double, 2>> pole;
  std::optional<double> chainLength;
  std::string mode;  ///< 'ik' | 'fk'
  /// IK weight 0..1 (read into IkTarget::blend; 0 = the goal is skipped).
  double blend = 1;
  /// The stored `stretch` (max length ratio) and `softness` (px); 0 = off.
  double stretch = 0;
  double softness = 0;
};

namespace skel {

using js::Json;

struct V2 {
  double x = 0, y = 0;
};

using Mat2D = std::array<double, 6>;

constexpr Mat2D kIdentity = {1, 0, 0, 1, 0, 0};

struct Bone {
  std::string id;
  std::string parentId;  ///< "" = root (the TS truthiness test)
  double length = 0, x = 0, y = 0, rotation = 0;
  std::optional<double> scaleX, scaleY, influenceRadius;
  /// How far an IK goal's `stretch` lengthened the bone (1 = not stretched): its length, its children's offset
  /// along it and a bound part (bone_link.cpp) all scale by it. Not part of the world matrix.
  double stretch = 1;
};

using WorldMap = std::unordered_map<std::string, Mat2D>;

struct TwoBone {
  double angle1, angle2;
};

struct IkTarget {
  std::string boneId;
  double x = 0, y = 0;
  std::optional<double> chainLength;
  std::optional<V2> pole;
  /// R4: the IK/FK blend — 1 = the solved pose, 0 = the FK pose, between = a
  /// linear blend of the chain's local rotations (the `ikMode.<bone>` track).
  double blend = 1;
  /// Character rig, Tier 1 (two-bone chains): the most a limb may lengthen to reach (ratio; ≤ 1 = never) and the
  /// soft-IK distance in px (0 = the joint snaps straight at full reach).
  double stretch = 0;
  double softness = 0;
  /// The pole, or nullptr without one.
  [[nodiscard]] const V2* pole_point() const noexcept { return pole.has_value() ? &*pole : nullptr; }
};

struct Skeleton {
  std::vector<Bone> bones;
  std::vector<Bone> bind;  ///< bindPoseBones(skel)
  const Json* weightPaint = nullptr;
  /// R4: `preserveVolume: 'on'` — dual-quaternion blending instead of linear.
  bool dualQuaternion = false;
};

[[nodiscard]] Mat2D from_trs(double x, double y, double rotation, double scaleX, double scaleY);
[[nodiscard]] Mat2D mul(const Mat2D& m1, const Mat2D& m2);
[[nodiscard]] V2 apply(const Mat2D& m, double x, double y);
[[nodiscard]] Mat2D invert(const Mat2D& m);
[[nodiscard]] Bone read_bone(const Json& b);
/// computeWorldTransforms: parent-first, memoised; a cycle resolves to identity.
[[nodiscard]] WorldMap compute_world(const std::vector<Bone>& bones);
[[nodiscard]] V2 bone_tip(const Mat2D& w, double length);
[[nodiscard]] V2 bone_root(const Mat2D& w);
[[nodiscard]] TwoBone solve_two_bone(V2 root, double l1, double l2, V2 target, bool bendPositive);
[[nodiscard]] V2 constrain(V2 point, V2 anchor, double len);
[[nodiscard]] std::vector<V2> solve_fabrik(const std::vector<V2>& joints, const std::vector<double>& lengths, V2 target);
[[nodiscard]] std::vector<double> angles_from_joints(const std::vector<V2>& joints);
/// ikChainIds: the target bone and its ancestors, root-first. Indices into `bones` (last id wins).
[[nodiscard]] std::vector<std::size_t> ik_chain(const std::vector<Bone>& bones, const std::string& targetBoneId, double chainLength);
[[nodiscard]] std::vector<Bone> apply_ik(const std::vector<Bone>& bones, const std::vector<IkTarget>& targets);
[[nodiscard]] Skeleton read_skeleton(const Json& skel);
/// The IK/FK blend of a goal at `t`: the `ikMode.<bone>` track clamped to 0..1
/// when it is keyed, else the stored mode ('fk' = 0; anything else = 1).
[[nodiscard]] double ik_blend_of(const Json& stored, const std::string& boneId, double t, const RigSampler& anim);
/// Every stored IK goal with resolveIkTargets' sampling and its blend (enabled or not).
[[nodiscard]] std::vector<RigIkOut> resolve_ik_goals(const Json& skel, double t, const RigSampler& anim);
/// resolveActiveIkTargets: the enabled goals with any IK share, as solver targets.
[[nodiscard]] std::vector<IkTarget> active_ik_targets(const std::vector<RigIkOut>& goals);
/// resolveLiveBones.
[[nodiscard]] std::vector<Bone> resolve_live_bones(const std::vector<Bone>& bones, double t, const RigSampler& anim);

}  // namespace skel
}  // namespace premation::scene
