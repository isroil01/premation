// The scene graph over doc::Document — src/core/scene/SceneGraph.ts, the
// addressing helpers of src/core/engine/doc.ts, and the small scene readers
// the engine uses everywhere (sceneDerive, compInstance, precomp, threeD
// reads, the transform getter). Same names, same rules; the TypeScript they
// port is cited per function.
#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "model.hpp"
#include "transform.hpp"

namespace premation::doc {

// ── SceneGraph.ts ─────────────────────────────────────────────────────────

/// `KIND_TO_ENGINE_TYPE[kind] ?? 'null'` — the default node name.
[[nodiscard]] std::string engine_type_of_kind(std::string_view kind);

/// `addNode`: ignored when the id exists.
void sg_add_node(Document& d, Node n);
/// `addChild(parentId, node)`.
void sg_add_child(Document& d, const std::string& parentId, Node n);
/// `removeNode`: unlinks from the parent's children, removes the subtree.
void sg_remove_node(Document& d, std::string_view id);
[[nodiscard]] std::vector<std::string> sg_child_order(const Document& d, std::string_view id);
/// `setChildOrder`: false unless `next` is a permutation of the children.
bool sg_set_child_order(Document& d, std::string_view id, const std::vector<std::string>& next);
/// `setParent(child, newParent, {preserveWorld})` — static-base compensation.
void sg_set_parent(Document& d, const std::string& childId, const std::optional<std::string>& newParentId,
                   bool preserveWorld);
/// `writeProp(node, componentId, prop, value)`; false when no such component.
bool sg_write_prop(Document& d, std::string_view nodeId, std::string_view componentId, std::string_view prop,
                   Json value);
/// `setFx(node, key, value)` — the `fx` component created on demand (`<id>_fx`).
void sg_set_fx(Document& d, std::string_view nodeId, std::string_view key, Json value);
/// `addComponent` (replaces the same type, appended at the end).
bool sg_add_component(Document& d, std::string_view nodeId, Component c);
bool sg_remove_component(Document& d, std::string_view nodeId, std::string_view type);
void sg_set_local_transform(Document& d, std::string_view nodeId, double x, double y, double rotation,
                            std::optional<double> scaleX, std::optional<double> scaleY);
void sg_set_separate_dimensions(Document& d, std::string_view nodeId, bool on);

/// `node.transform` (the AppNodeView getter): x/y/rotation from the LAST
/// component carrying each as a number.
struct ViewTransform {
  double x = 0;
  double y = 0;
  double rotation = 0;
};
[[nodiscard]] ViewTransform view_transform(const Node& n);
/// `getLocalTransform` / `baseLocal`.
[[nodiscard]] motion::xf::Local2D base_local(const Node& n);

// ── sceneDerive / precomp / compInstance / threeD reads ──────────────────

[[nodiscard]] std::optional<std::string> read_shape_type(const Node& n);
[[nodiscard]] bool is_solid_node(const Node& n);
[[nodiscard]] bool is_precomp(const Node& n);
[[nodiscard]] std::optional<std::string> read_comp_ref(const Node& n);
[[nodiscard]] bool read_comp_collapse(const Node& n);
[[nodiscard]] bool is_3d_enabled(const Node& n);
[[nodiscard]] bool can_be_3d(const Node& n);
/// The props of the Transform component (an empty object when absent).
[[nodiscard]] const Json& transform_props(const Node& n);

// ── doc.ts: addressing ────────────────────────────────────────────────────

[[nodiscard]] bool is_comp_item(const Document& d, std::string_view id);
/// Composition item ids in the store's order.
[[nodiscard]] std::vector<std::string> comp_item_ids(const Document& d);
/// `enclosingCompRootOf` (parenting.ts).
[[nodiscard]] std::optional<std::string> enclosing_comp_root_of(const Document& d, std::string_view id);
/// The composition a layer belongs to, or nullopt when `id` is not a layer.
[[nodiscard]] std::optional<std::string> comp_of_layer(const Document& d, std::string_view id);
/// Top of the stack first: depth-first, front-most sibling first, never through a precomp.
[[nodiscard]] std::vector<std::string> layer_ids_of_comp(const Document& d, std::string_view comp);
/// The API parent: the tree parent unless that is the comp root.
[[nodiscard]] std::optional<std::string> api_parent_of(const Document& d, std::string_view id);
[[nodiscard]] api::LayerKind layer_kind_of(const Node& n);
[[nodiscard]] std::optional<std::string> layer_source_of(const Node& n);
[[nodiscard]] bool id_taken(const Document& d, std::string_view id);
[[nodiscard]] std::vector<std::string> layers_using_item(const Document& d, std::string_view item);
[[nodiscard]] const Json* find_asset(const Document& d, std::string_view id);
[[nodiscard]] const Folder* find_folder(const Document& d, std::string_view id);

enum class ItemRefKind : std::uint8_t { composition, footage, folder };
struct ItemRef {
  ItemRefKind kind = ItemRefKind::composition;
  std::string id;
};
[[nodiscard]] std::optional<ItemRef> resolve_item(const Document& d, std::string_view id);

/// A node's parent chain contains `ancestor`.
[[nodiscard]] bool is_descendant(const Document& d, std::string_view ancestor, std::string_view nodeId);

}  // namespace premation::doc
