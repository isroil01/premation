// glTF morph targets and skinning (D2w 3D leftovers) — src/core/scene/modelMorph.ts
// (readMorphWeights, morphVertices, morphTag, morphedMeshFor) and
// src/core/scene/modelSkinning.ts (jointLayerMapFor, poseHash, skinVertices,
// skinnedMeshFor), line for line, with the typed arrays' float32 stores.
//
// Morph, then skin (the glTF order): the morphed vertices are the skinning base
// and their weight tag is folded into the pose hash. Both deformations swap in
// new vertices under a weight- / pose-hashed buffer key; an unresolvable skin
// pose (a joint layer missing, a degenerate layer matrix) returns nothing, and
// the caller draws the morphed or rigid bind pose — as the TypeScript.
//
// The TypeScript memoizes the last blend / pose per layer; the memo only skips
// recomputing the same bytes, so it is not ported.
//
// Pinned by tests/data/model_deform_parity.json (modelDeformCrossEngine.test.ts).
#pragma once

#include <functional>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "gltf_model.hpp"
#include "model.hpp"
#include "readers.hpp"
#include "transform.hpp"

namespace premation::scene::gltf {

/// `readMorphWeights(node, animated, targetCount)`: animated track ∥ Transform
/// prop ∥ 0 per `morph<i>`; nullopt when every weight is zero.
[[nodiscard]] std::optional<std::vector<double>> read_morph_weights(const doc::Node& n, const Values* animated,
                                                                    std::size_t targetCount);
/// `morphVertices(base, targets, weights)`.
[[nodiscard]] std::vector<float> morph_vertices(const std::vector<float>& base, const std::vector<Entry::MorphTarget>& targets,
                                                const std::vector<double>& weights);
/// `morphTag(weights)`: FNV-1a over the 1/4096-quantized weights, base 36.
[[nodiscard]] std::string morph_tag(const std::vector<double>& weights);

struct Deformed {
  std::string key;
  std::vector<float> vertices;
  std::string tag;  ///< the morph tag (morphed meshes only)
};

/// `morphedMeshFor(node, entry, animated)`: key `<entry.key>:mo-<tag>`, or
/// nullopt when nothing morphs.
[[nodiscard]] std::optional<Deformed> morphed_mesh_for(const doc::Node& n, const Entry& entry, const Values* animated);

/// `SkinResolvers` (buildSnapshot's): the flattened nodes, `parentOf`, and a
/// joint layer's composed world matrix at the frame's time.
struct SkinResolvers {
  std::function<const doc::Node*(const std::string&)> node;
  std::function<std::optional<std::string>(const std::string&)> parentOf;
  std::function<std::optional<motion::xf::Mat4>(const std::string&)> jointWorld;
};
/// Per-snapshot `jointMapCache` (instance root id → glTF node → layer id, or none).
using JointMapCache = std::map<std::string, std::optional<std::map<double, std::string>>, std::less<>>;

/// `jointLayerMapFor(meshNodeId, modelKey, r, cache)`.
[[nodiscard]] const std::map<double, std::string>* joint_layer_map_for(const std::string& meshNodeId, std::string_view modelKey,
                                                                      const SkinResolvers& r, JointMapCache& cache);
/// `poseHash(mats)` (float32 matrices).
[[nodiscard]] std::string pose_hash(const std::vector<float>& mats);
/// `skinVertices(src, skinData, mats)`.
[[nodiscard]] std::vector<float> skin_vertices(const std::vector<float>& src, const std::vector<std::uint16_t>& joints,
                                               const std::vector<float>& weights, const std::vector<float>& mats);

/// `skinnedMeshFor(meshNode, ref, entry, layerWorld, r, cache, morphedBase)`:
/// key `<entry.key>:sk-<poseHash>[~<morphTag>]`, or nullopt (no skin, a joint
/// that does not resolve, a singular layer matrix).
[[nodiscard]] std::optional<Deformed> skinned_mesh_for(const doc::Node& meshNode, std::string_view modelKey,
                                                       std::optional<double> skinIndex, const Entry& entry,
                                                       const std::vector<ModelSkin>& skins, const motion::xf::Mat4& layerWorld,
                                                       const SkinResolvers& r, JointMapCache& cache,
                                                       const Deformed* morphedBase);

}  // namespace premation::scene::gltf
