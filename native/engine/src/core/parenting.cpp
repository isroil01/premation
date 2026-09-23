#include "parenting.hpp"

#include <cmath>
#include <set>
#include <vector>

#include "scene.hpp"
#include "worldxf.hpp"

namespace premation::doc {
namespace {

constexpr std::string_view kCompRoot = "comp_root";
constexpr double kEps = 1e-9;

void offset_track(Document& d, const std::string& node, std::string_view prop, double add, double mul = 1) {
  const auto* kfs = anim_track(d, node, prop);
  if (kfs == nullptr || kfs->empty()) return;
  std::vector<Key> next = *kfs;
  for (Key& k : next) {
    k.value = k.value * mul + add;
    if (k.si) k.si = *k.si * mul;
    if (k.so) k.so = *k.so * mul;
  }
  anim_set_track(d, node, prop, std::move(next));
}

motion::xf::Local2D base_local_of(const Node& n) { return base_local(n); }

void compensate_reparent(const PCtx& c, const std::string& child, const std::string& target,
                         const motion::xf::Mat2D& worldBefore) {
  Document& d = c.d;
  const Node* node = d.node(child);
  if (node == nullptr) return;
  const double time = c.view.tabTime;
  const motion::xf::Mat2D parentWorld =
      d.node(target) != nullptr ? world_2d_at(c, target, time) : motion::xf::Mat2D{1, 0, 0, 1, 0, 0};
  const motion::xf::Local2D want = motion::xf::local_under_parent(worldBefore, parentWorld);
  const motion::xf::Local2D have = local_transform_at(c, child, time).value_or(base_local_of(*node));
  const double dx = want.x - have.x;
  const double dy = want.y - have.y;
  const double dRot = want.rotation - have.rotation;
  const double kx = std::abs(have.scale_x) > kEps ? want.scale_x / have.scale_x : 1;
  const double ky = std::abs(have.scale_y) > kEps ? want.scale_y / have.scale_y : 1;

  if (const Component* comp = node->comp_with_number("x")) {
    const std::string cid = comp->id;
    const Json p = comp->props;
    auto base = [&](std::string_view k, double dflt) { return p.at(k).is_number() ? p.at(k).num() : dflt; };
    (void)sg_write_prop(d, child, cid, "x", Json::number(base("x", 0) + dx));
    (void)sg_write_prop(d, child, cid, "y", Json::number(base("y", 0) + dy));
    if (std::abs(dRot) > kEps) (void)sg_write_prop(d, child, cid, "rotation", Json::number(base("rotation", 0) + dRot));
    if (std::abs(kx - 1) > kEps || std::abs(ky - 1) > kEps) {
      const bool uniformOnly = p.at("scale").is_number() && p.at("scaleX").is_undefined() && p.at("scaleY").is_undefined() &&
                               std::abs(kx - ky) < kEps;
      if (uniformOnly) {
        (void)sg_write_prop(d, child, cid, "scale", Json::number(p.at("scale").num() * kx));
      } else {
        const double uniform = p.at("scale").is_number() ? p.at("scale").num() : 1;
        (void)sg_write_prop(d, child, cid, "scaleX", Json::number(base("scaleX", uniform) * kx));
        (void)sg_write_prop(d, child, cid, "scaleY", Json::number(base("scaleY", uniform) * ky));
      }
    }
  }
  if (std::abs(dx) > kEps) offset_track(d, child, "x", dx);
  if (std::abs(dy) > kEps) offset_track(d, child, "y", dy);
  if (std::abs(dRot) > kEps) offset_track(d, child, "rotation", dRot);
  if (std::abs(kx - 1) > kEps) offset_track(d, child, "scaleX", 0, kx);
  if (std::abs(ky - 1) > kEps) offset_track(d, child, "scaleY", 0, ky);
  if (std::abs(kx - 1) > kEps && std::abs(kx - ky) < kEps) offset_track(d, child, "scale", 0, kx);
}

}  // namespace

bool can_reparent(const Document& d, std::string_view child, const std::optional<std::string>& newParent) {
  if (child == kCompRoot) return false;
  if (!newParent) return true;
  if (*newParent == child) return false;
  if (d.node(*newParent) == nullptr) return false;
  if (is_descendant(d, child, *newParent)) return false;
  const auto home = enclosing_comp_root_of(d, child);
  if (*newParent == home || *newParent == kCompRoot) return home && *newParent == *home;
  return home.has_value() && home == enclosing_comp_root_of(d, *newParent);
}

void set_parent_preserving_world(const PCtx& c, const std::string& child, const std::string& target) {
  const Node* n = c.d.node(child);
  const std::optional<std::string> from = n != nullptr ? n->parent : std::nullopt;
  const bool moves = from != target && !(!from && target == kCompRoot);
  std::optional<motion::xf::Mat2D> worldBefore;
  if (moves) worldBefore = world_2d_at(c, child, c.view.tabTime);
  sg_set_parent(c.d, child, target, false);
  if (worldBefore) compensate_reparent(c, child, target, *worldBefore);
}

bool reparent_node(const PCtx& c, const std::string& child, const std::optional<std::string>& newParent,
                   bool preserveWorld, std::optional<double> jumpAt) {
  if (!can_reparent(c.d, child, newParent)) return false;
  const std::string target = newParent ? *newParent : enclosing_comp_root_of(c.d, child).value_or(std::string(kCompRoot));
  if (jumpAt && newParent) {
    // parenting.ts jumpToParent: relink uncompensated, then Position → 0,0 in the
    // parent's space at `jumpAt`; an animated Position is re-based rigidly.
    sg_set_parent(c.d, child, target, false);
    const Node* node = c.d.node(child);
    if (node == nullptr) return true;
    const motion::xf::Local2D have = local_transform_at(c, child, *jumpAt).value_or(base_local_of(*node));
    const double dx = -have.x;
    const double dy = -have.y;
    if (const Component* comp = node->comp_with_number("x")) {
      const std::string cid = comp->id;
      const Json p = comp->props;
      (void)sg_write_prop(c.d, child, cid, "x", Json::number(p.at("x").num() + dx));
      (void)sg_write_prop(c.d, child, cid, "y", Json::number((p.at("y").is_number() ? p.at("y").num() : 0) + dy));
    }
    if (std::abs(dx) > kEps) offset_track(c.d, child, "x", dx);
    if (std::abs(dy) > kEps) offset_track(c.d, child, "y", dy);
    return true;
  }
  if (preserveWorld) set_parent_preserving_world(c, child, target);
  else sg_set_parent(c.d, child, target, false);
  return true;
}

bool delete_layer_node(Document& d, std::string_view id) {
  const Node* node = d.node(id);
  if (node == nullptr || node->locked || !node->parent) return false;
  std::vector<std::string> stack{std::string(id)};
  while (!stack.empty()) {
    const std::string n = stack.back();
    stack.pop_back();
    d.set_anim(n, std::nullopt);
    if (const Node* nn = d.node(n)) {
      for (const auto& c : nn->children) {
        if (d.node(c) != nullptr) stack.push_back(c);
      }
    }
  }
  sg_remove_node(d, id);
  return true;
}

}  // namespace premation::doc
