#include "bone_link.hpp"

#include <cmath>

#include "anim.hpp"
#include "timeline.hpp"

namespace premation::doc {

namespace {

namespace sk = scene::skel;

motion::xf::Mat2D to_xf(const sk::Mat2D& m) { return {m[0], m[1], m[2], m[3], m[4], m[5]}; }

bool has_bone(const js::Json& skel, std::string_view bone) {
  for (const js::Json& b : skel.at("bones").arr()) {
    if (b.at("id").is_string() && b.at("id").str() == bone) return true;
  }
  return false;
}

}  // namespace

const js::Json* character_skeleton(const Node& group) {
  if (group.kind() != "group") return nullptr;
  const js::Json& skel = group.fx().at("skeleton");
  if (!skel.is_object() || !skel.at("bones").is_array() || skel.at("bones").arr().empty()) return nullptr;
  return &skel;
}

const std::string* bound_bone(const Document& d, const Node& part) {
  const js::Json& pb = part.fx().at("parentBone");
  if (!pb.is_string() || pb.str().empty() || !part.parent) return nullptr;
  const Node* group = d.node(*part.parent);
  if (group == nullptr) return nullptr;
  const js::Json* skel = character_skeleton(*group);
  if (skel == nullptr || !has_bone(*skel, pb.str())) return nullptr;
  return &pb.str();
}

std::optional<CharacterPose> character_pose(const Node& group, double rigT, const scene::RigSampler& anim) {
  const js::Json* skel = character_skeleton(group);
  if (skel == nullptr) return std::nullopt;
  const sk::Skeleton s = sk::read_skeleton(*skel);
  const std::vector<sk::Bone> posed =
      sk::apply_ik(sk::resolve_live_bones(s.bones, rigT, anim), sk::active_ik_targets(sk::resolve_ik_goals(*skel, rigT, anim)));
  const sk::WorldMap pose = sk::compute_world(posed);
  const sk::WorldMap bind = sk::compute_world(s.bind);
  CharacterPose out;
  for (const sk::Bone& pb : posed) {
    const auto p = pose.find(pb.id);
    const auto b = bind.find(pb.id);
    if (p == pose.end() || b == bind.end()) continue;
    // pose · S(stretch along the bone) · bind⁻¹: the part rides the bone and, on a stretched IK limb, lengthens with it.
    const sk::Mat2D stretched = sk::mul(p->second, sk::Mat2D{pb.stretch, 0, 0, 1, 0, 0});
    out.links.insert_or_assign(pb.id, to_xf(sk::mul(stretched, sk::invert(b->second))));
  }
  return out;
}

std::optional<motion::xf::Mat2D> bone_link(const Node& group, std::string_view bone, double rigT,
                                           const scene::RigSampler& anim) {
  const std::optional<CharacterPose> pose = character_pose(group, rigT, anim);
  if (!pose) return std::nullopt;
  const auto it = pose->links.find(std::string(bone));
  if (it == pose->links.end()) return std::nullopt;
  return it->second;
}

std::optional<motion::xf::Mat2D> bone_link_at(const Document& d, const EditorView& view, const ExprEnv& expr,
                                              ExprCache& cache, const Node& part, double seconds) {
  const std::string* bone = bound_bone(d, part);
  if (bone == nullptr) return std::nullopt;
  const std::string groupId = *part.parent;
  const Node& group = *d.node(groupId);
  const double rigT = comp_to_keyframe_time(d, view, groupId, seconds);
  scene::RigSampler s;
  s.sample = [&d, &expr, &cache, &groupId](std::string_view path, double t) {
    return anim_sample(d, expr, cache, groupId, path, t);
  };
  s.sampleData = [](std::string_view, double) -> std::optional<js::Json> { return std::nullopt; };
  return bone_link(group, *bone, rigT, s);
}

std::optional<motion::xf::Mat2D> bone_link_static(const Document& d, const Node& part) {
  const std::string* bone = bound_bone(d, part);
  if (bone == nullptr) return std::nullopt;
  scene::RigSampler s;
  s.sample = [](std::string_view, double) -> std::optional<double> { return std::nullopt; };
  s.sampleData = [](std::string_view, double) -> std::optional<js::Json> { return std::nullopt; };
  return bone_link(*d.node(*part.parent), *bone, 0, s);
}

}  // namespace premation::doc
