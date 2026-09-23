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
};
[[nodiscard]] Node make_layer_node(const FactoryInput& in);
/// compInstance.ts `wouldCreateCompCycle(host, ref)`.
[[nodiscard]] bool would_create_comp_cycle(const Document& d, std::string_view hostComp, std::string_view refComp);

ResultOf<api::CreateLayer> handle(const api::CreateLayer& c, HCtx& x);
ResultOf<api::DeleteLayers> handle(const api::DeleteLayers& c, HCtx& x);
ResultOf<api::ReorderLayers> handle(const api::ReorderLayers& c, HCtx& x);
ResultOf<api::RenameLayer> handle(const api::RenameLayer& c, HCtx& x);
ResultOf<api::SetLayerComment> handle(const api::SetLayerComment& c, HCtx& x);
ResultOf<api::SetBlendMode> handle(const api::SetBlendMode& c, HCtx& x);
ResultOf<api::SetTrackMatte> handle(const api::SetTrackMatte& c, HCtx& x);
ResultOf<api::SetParent> handle(const api::SetParent& c, HCtx& x);
// handlers_layers2.cpp
ResultOf<api::SetLayerSwitches> handle(const api::SetLayerSwitches& c, HCtx& x);
ResultOf<api::ReplaceLayerSource> handle(const api::ReplaceLayerSource& c, HCtx& x);
ResultOf<api::GroupLayers> handle(const api::GroupLayers& c, HCtx& x);
ResultOf<api::UngroupLayer> handle(const api::UngroupLayer& c, HCtx& x);
ResultOf<api::PasteLayers> handle(const api::PasteLayers& c, HCtx& x);
ResultOf<api::DuplicateLayers> handle(const api::DuplicateLayers& c, HCtx& x);
ResultOf<api::ConvertLayer> handle(const api::ConvertLayer& c, HCtx& x);
ResultOf<api::SeparateLayer> handle(const api::SeparateLayer& c, HCtx& x);
ResultOf<api::AutoTrace> handle(const api::AutoTrace& c, HCtx& x);
/// threeD.ts `set3DEnabled(node, on)` (solids seed from the ACTIVE comp's size).
void set_3d_enabled(HCtx& x, const std::string& node, bool on);

/// layers.ts `encodeFragment(layers)` — the copyLayers payload pasteLayers reads.
[[nodiscard]] api::DocumentFragment encode_fragment(const PCtx& c, const std::vector<std::string>& layers);

}  // namespace premation::doc
