// Edit handlers: Layers — src/core/engine/handlers/layers.ts and layerFactory.ts.
//
// Each handler: `ResultOf<api::Cmd> handle(const api::Cmd&, HCtx&)` — validate
// (throw EngineFail), then mutate the document through its journaled writers.
// The dispatcher (session.cpp) finds a handler by overload resolution; a
// command with no `handle` overload answers `unsupported`.
#pragma once

#include "handlers_common.hpp"

namespace premation::doc {

/// layerFactory.ts `makeLayerNode`: the new layer's node (not yet in the graph).
struct FactoryInput {
  api::LayerKind kind = api::LayerKind::null;
  std::string id;
  std::optional<std::string> name;
  const Json* comp = nullptr;   ///< the composition record (projectStore.comps[comp])
  const Json* asset = nullptr;  ///< footage record for image/video/audio/svg/sequence
  std::optional<std::string> refCompId;
  const Json* refComp = nullptr;  ///< the referenced composition record (precomp)
  /// SDK 1.4 (L1), kind=generator: the plugin layer type "<pluginId>:<id>" (fx.pluginLayer).
  std::string pluginLayerType;
};
/// SDK 1.4: a plugin layer's own effect — the type's generator, whose params are the layer's properties.
inline constexpr std::string_view kPluginLayerEffectId = "layer";
[[nodiscard]] Node make_layer_node(const FactoryInput& in);
/// compInstance.ts `wouldCreateCompCycle(host, ref)`.
[[nodiscard]] bool would_create_comp_cycle(const Document& d, std::string_view hostComp, std::string_view refComp);

ResultOf<api::CreateLayer> handle(const api::CreateLayer& c, HCtx& x);
ResultOf<api::DeleteLayers> handle(const api::DeleteLayers& c, HCtx& x);
ResultOf<api::ReorderLayers> handle(const api::ReorderLayers& c, HCtx& x);
ResultOf<api::RenameLayer> handle(const api::RenameLayer& c, HCtx& x);
ResultOf<api::SetLayerComment> handle(const api::SetLayerComment& c, HCtx& x);
ResultOf<api::SetPinnedProperties> handle(const api::SetPinnedProperties& c, HCtx& x);
ResultOf<api::SetBlendMode> handle(const api::SetBlendMode& c, HCtx& x);
ResultOf<api::SetTrackMatte> handle(const api::SetTrackMatte& c, HCtx& x);
ResultOf<api::SetParent> handle(const api::SetParent& c, HCtx& x);
// handlers_layers2.cpp
ResultOf<api::SetLayerSwitches> handle(const api::SetLayerSwitches& c, HCtx& x);
ResultOf<api::ReplaceLayerSource> handle(const api::ReplaceLayerSource& c, HCtx& x);
ResultOf<api::GroupLayers> handle(const api::GroupLayers& c, HCtx& x);
ResultOf<api::UngroupLayer> handle(const api::UngroupLayer& c, HCtx& x);
// Character rig (handlers_character.cpp).
ResultOf<api::BindToBone> handle(const api::BindToBone& c, HCtx& x);
ResultOf<api::CreateCharacter> handle(const api::CreateCharacter& c, HCtx& x);
/// Detach (keeping world at the playhead, keyframes re-based) every part of character `group` bound to `bone` or
/// to one of its descendant bones (every bound part when `bone` is empty) — what deleting that bone, or the whole
/// skeleton, does first.
void release_bone_parts(const PCtx& c, const std::string& group, const std::string& bone);
ResultOf<api::PasteLayers> handle(const api::PasteLayers& c, HCtx& x);
ResultOf<api::DuplicateLayers> handle(const api::DuplicateLayers& c, HCtx& x);
ResultOf<api::ConvertLayer> handle(const api::ConvertLayer& c, HCtx& x);
/// B4 round 8: Live Merge Paths (handlers_convert.cpp).
ResultOf<api::CreateLiveMerge> handle(const api::CreateLiveMerge& c, HCtx& x);
ResultOf<api::SeparateLayer> handle(const api::SeparateLayer& c, HCtx& x);
ResultOf<api::AutoTrace> handle(const api::AutoTrace& c, HCtx& x);
/// threeD.ts `set3DEnabled(node, on)` (solids seed from the ACTIVE comp's size).
void set_3d_enabled(HCtx& x, const std::string& node, bool on);

/// layers.ts `encodeFragment(layers)` — the copyLayers payload pasteLayers reads.
[[nodiscard]] api::DocumentFragment encode_fragment(const PCtx& c, const std::vector<std::string>& layers);

}  // namespace premation::doc
