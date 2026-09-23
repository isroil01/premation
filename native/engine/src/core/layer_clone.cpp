#include "layer_clone.hpp"

#include <algorithm>
#include <string>
#include <vector>

#include "anim.hpp"
#include "scene.hpp"

namespace premation::doc {

namespace {

/// cloneLayerNode.ts `placeAfter(parent, anchor, moving)`.
void place_after(Document& d, const std::string& parentId, std::string_view anchorId, const std::string& movingId) {
  std::vector<std::string> kids = sg_child_order(d, parentId);
  const auto from = std::find(kids.begin(), kids.end(), movingId);
  if (from == kids.end()) return;
  kids.erase(from);
  const auto anchor = std::find(kids.begin(), kids.end(), anchorId);
  kids.insert(anchor == kids.end() ? kids.end() : anchor + 1, movingId);
  (void)sg_set_child_order(d, parentId, kids);
}

}  // namespace

void copy_node_animation(Document& d, std::string_view fromId, std::string_view toId) {
  const NodeAnim* src = d.anim(fromId);
  if (src == nullptr) return;
  const NodeAnim snap = *src;  // snapshotNodeAnimation: frozen before any write
  for (const auto& [prop, keys] : snap.tracks) anim_set_keyframes(d, toId, prop, keys);
  for (const auto& [prop, track] : snap.data) anim_set_data_track(d, toId, prop, track);
  for (const auto& [prop, st] : snap.exprs) anim_set_expr_state(d, toId, prop, st);
}

bool clone_layer_node(Document& d, std::string_view sourceId, std::string_view newId) {
  const Node* original = d.node(sourceId);
  if (original == nullptr || !original->parent) return false;
  if (d.node(newId) != nullptr) return false;
  const std::string parent = *original->parent;

  Node clone;
  clone.id = std::string(newId);
  clone.name = original->name;
  clone.visible = original->visible;
  clone.locked = original->locked;
  for (const Component& c : original->components) {
    clone.components.push_back(Component{std::string(newId) + "_" + c.type, c.type, c.props});
  }
  sg_add_child(d, parent, std::move(clone));
  place_after(d, parent, sourceId, std::string(newId));
  copy_node_animation(d, sourceId, newId);
  return true;
}

}  // namespace premation::doc
