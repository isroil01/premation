// Composition instances for the scene builder (D2w time / comp,
// docs/NATIVE_CORE_PLAN.md): a composition placed as a LAYER of another.
//
//   compInstance.ts            expandCompInstances (COLLAPSED instances splice
//                              render-only clones of the referenced comp into the
//                              host walk), readCompRef / isCompInstanceRoot
//   compInstanceOverrides.ts   Essential Properties: readInstanceOverrides,
//                              overriddenPropsFor, applyOverridesToComponents
//   buildSnapshot.ts           nestedCompLayers (a SEALED instance is its own
//                              recursive pass: its camera, its 3D sort, its size),
//                              prefixLayerIds, buildPrecompContainer's instance
//                              frame (size, crop mask, anchor, 2D motion samples,
//                              the 3D card)
//
// The walk (snapshot_build.cpp) owns the document reads; it calls these at the
// points the TypeScript does. Clones are real doc::Node values owned by
// `WalkNodes`, so every reader that takes a node takes a clone unchanged; the
// ANIMATION of a clone is its source node's (`WalkNodes::src`).
#pragma once

#include <array>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "model.hpp"
#include "readers.hpp"
#include "scene_types.hpp"
#include "snapshot_build.hpp"

namespace premation::scene {

/// Nesting cap for recursive composition rendering (MAX_COMP_DEPTH / MAX_INSTANCE_DEPTH).
inline constexpr std::size_t kMaxCompDepth = 8;

/// An instance's Essential Properties: `<origNodeId>/<prop>` → value (validated).
using InstanceOverrides = std::map<std::string, Json, std::less<>>;

/// `readInstanceOverrides(node)`.
[[nodiscard]] InstanceOverrides read_comp_overrides(const doc::Node& n);

/// cloner.ts `CloneTransform`: where one clone sits relative to the cloner layer.
struct CloneOffset {
  int index = 0;
  double x = 0, y = 0, rotation = 0, scaleX = 1, scaleY = 1;
  double opacity = 100;   ///< 0..100
  double timeOffset = 0;  ///< seconds this clone's animation runs behind
};

/// The nodes one snapshot walks: the flattened composition with its COLLAPSED
/// instances expanded inline and the pass's own overrides applied.
struct WalkNodes {
  std::vector<const doc::Node*> nodes;
  /// Clones and override-patched copies (stable addresses).
  std::vector<std::unique_ptr<doc::Node>> owned;
  /// clone id → the original node id (`__instanceSource`).
  std::unordered_map<std::string, std::string> source;
  /// Clones directly under an instance (`__compInstanceRoot`): a transform barrier.
  std::unordered_set<std::string> instanceRoots;
  /// `__overriddenProps` per walked id.
  std::unordered_map<std::string, std::set<std::string, std::less<>>> overridden;
  /// A cloner clone ROOT's offset (`__cloneOffset`, cloner_port.cpp).
  std::unordered_map<std::string, CloneOffset> cloneOffsets;

  /// `srcId(id)`: the node whose animation and clip bars a walked id samples.
  [[nodiscard]] const std::string& src(const std::string& id) const {
    const auto it = source.find(id);
    return it == source.end() ? id : it->second;
  }
  [[nodiscard]] bool is_overridden(const std::string& id, std::string_view prop) const {
    if (overridden.empty()) return false;
    const auto it = overridden.find(id);
    return it != overridden.end() && it->second.contains(prop);
  }
  [[nodiscard]] bool instance_root(const std::string& id) const { return instanceRoots.contains(id); }
};

/// `expandCompInstances(graph, flat, activeRoot, readCompCollapse, compSizeOf)`
/// then `applyOwnOverrides` (the sealed pass's `comp.compOverrides`).
[[nodiscard]] WalkNodes expand_walk_nodes(const doc::Document& d, const std::vector<const doc::Node*>& flat,
                                          const std::string& activeRoot, const InstanceOverrides& own);

/// `compSizeOf(ref)`: the referenced composition record's size.
[[nodiscard]] std::optional<std::pair<double, double>> comp_size_of(const doc::Document& d, std::string_view ref);

/// `prefixLayerIds(layers, prefix)`.
void prefix_layer_ids(std::vector<RLayer>& layers, const std::string& prefix);

/// `nestedCompLayers(node, ref)`'s result.
struct NestedComp {
  std::vector<RLayer> layers;  ///< prefixed with `<instanceId>::`
  std::optional<PrecompScene3D> scene3d;
  std::vector<LayerError> errors;  ///< the nested pass's, re-keyed under the instance
};

/// `nestedCompLayers(node, ref)`: the referenced comp through its own recursive
/// pass at `nestedTime`. Null past the cycle / depth guard or for a dangling ref.
/// `hostFps` is the walk's frame rate (the TypeScript reads one timeline rate).
[[nodiscard]] std::optional<NestedComp> nested_comp_layers(const BuildContext& c, const SnapshotComp& host, double hostFps,
                                                           const doc::Node& instance, const std::string& ref,
                                                           double nestedTime,
                                                           const std::optional<MotionBlurCfg>& motionBlur);

/// The instance-only part of `buildPrecompContainer`: the frame crop appended to
/// the authored mask (`<id>::frame`, intersect when a mask exists).
[[nodiscard]] Json instance_frame_mask(const Json& authored, const std::string& id, double w, double h);

/// A 2D comp layer's motion samples (`sampleMotion` mapped onto the world pose):
/// the walk's own samples re-expressed relative to its local pose.
struct LocalPose {
  double x = 0, y = 0, rotation = 0, scaleX = 1, scaleY = 1;
};
[[nodiscard]] std::vector<MotionSample> instance_world_samples(const std::vector<MotionSample>& local, const LocalPose& now,
                                                               const motion::xf::Local2D& world);

}  // namespace premation::scene
