// The rest of `extractSpatialEffects` (src/core/rendering/snapshotToFrameScene.ts):
// every GPU effect kind beyond the eight effects_port.cpp writes itself (blur,
// glow, drop-shadow, gradient-ramp, fill, stroke, sharpen, noise), each ported
// branch for branch into its FrameScene chain entry (api::RenderEffect, the
// frameSceneExport.ts `effectToWire` encoding — see FxWriter).
#pragma once

#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "engine_api.hpp"
#include "scene_types.hpp"

namespace premation::scene {

/// True when `extract_more_spatial` writes this effect type.
[[nodiscard]] bool is_more_spatial(std::string_view type);

/// Append the chain entries of one ENABLED effect `e` whose type
/// `is_more_spatial`; `params` is `paramsOf(e)` (declared defaults ← legacy
/// amount ← stored params). Returns false when the type is not handled here.
bool extract_more_spatial(const Json& e, const Json& params, const RLayer& layer, std::vector<api::RenderEffect>& out);

// The parts (effects_spatial_a.cpp, effects_spatial_b.cpp, effects_spatial_c.cpp), same contract.
[[nodiscard]] bool spatial_a_handles(std::string_view type);
bool spatial_a(const Json& e, const Json& params, const RLayer& layer, std::vector<api::RenderEffect>& out);
[[nodiscard]] bool spatial_b_handles(std::string_view type);
bool spatial_b(const Json& e, const Json& params, const RLayer& layer, std::vector<api::RenderEffect>& out);
[[nodiscard]] bool spatial_c_handles(std::string_view type);
bool spatial_c(const Json& e, const Json& params, const RLayer& layer, std::vector<api::RenderEffect>& out);
/// Program X (effects_spatial_x.cpp): the deep effects, each an `fx-graph` entry.
[[nodiscard]] bool spatial_x_handles(std::string_view type);
bool spatial_x(const Json& e, const Json& params, const RLayer& layer, std::vector<api::RenderEffect>& out);
/// Program X: a texture a deep effect reads — a raster of one mask path
/// (`mask` = {paths: [...]}) or a table of floats (`floats`, when `mask` is not
/// an object), or a still picture (`src`, when set: the layer's Object Matte
/// frame), under the key its fx-graph entry names.
struct DeepFxTexture {
  std::string key;
  Json mask;
  std::vector<float> floats;
  std::string src;
  /// The layer's subjects this matte is made of (with their live edge), when `src` is a subject matte.
  std::vector<SubjectPart> parts;
};
/// Program X batch 8: an enabled effect on the layer reads its own Object
/// Matte (setLayerMatte's `alphaMatte`) AS A MATTE — Selective Color (AI) with
/// no Matte Layer. The matte frame is then a texture of that effect
/// (`RLayer::objectMatteSrc`), and the layer is not cut out by it.
[[nodiscard]] bool reads_own_object_matte(const RLayer& l);
/// An effect's Apply to (Compositing Options, `subjectScope`): 0 the whole layer, 1 inside its subject, 2 outside it (effects_port.cpp).
[[nodiscard]] int subject_scope_of(const Json& e);
/// Background fill: the subject's area painted with the background colour around it
/// (normalized convolution through its Object Matte frame), put before a blur Applied To
/// the Background so no subject colour bleeds into it. `l.objectMatteSrc` must be set.
[[nodiscard]] api::RenderEffect subject_fill_entry(const RLayer& l, std::span<const std::string> ids = {});
/// The texture key the layer's Object Matte frame is fed under: all its shown subjects
/// (`ids` empty), or those subjects alone ("fxmatte:<layer>~<id>+<id>").
[[nodiscard]] std::string object_matte_key(std::string_view layerId, std::span<const std::string> ids = {});
/// The layer's shown subjects among `ids` (all of them when `ids` is empty), in panel order.
[[nodiscard]] std::vector<SubjectPart> subject_parts(const RLayer& l, std::span<const std::string> ids = {});
/// The subject an effect is Applied To (Compositing Options `subjectId`): one id, or none = all of them.
[[nodiscard]] std::vector<std::string> effect_subject_ids(const Json& e);
/// A map layer id `<layer>#subject` (or `<layer>#subject~<id>+<id>`): that layer's subject matte
/// (object_matte_key) drawn through its placement, not its rendered pixels (Behind Subject's Set Matte, map_layer).
inline constexpr std::string_view kSubjectMapSuffix = "#subject";
/// Image Fill: the param the snapshot resolves its project item into (the file on disk, absent
/// when none is chosen or the item is missing), the document's own params never holding a path.
inline constexpr std::string_view kImageFillFile = "__file";
/// That file, or "".
[[nodiscard]] std::string image_fill_file(const Json& e);
/// The texture key the file is fed under: one texture however many effects read it, and a
/// relinked item is a new key.
[[nodiscard]] std::string image_fill_key(std::string_view file);
/// The textures the layer's deep effects read this frame (frame_build.cpp).
[[nodiscard]] std::vector<DeepFxTexture> deep_effect_textures(const RLayer& l);
/// Program X: a deep effect whose pixels move with the layer clock (`time`).
[[nodiscard]] bool deep_effect_follows_clock(std::string_view type);

}  // namespace premation::scene
