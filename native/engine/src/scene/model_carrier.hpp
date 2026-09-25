// An imported glTF model's mesh carrier (buildSnapshot's `modelMeshLayer`,
// D2w 3D leftovers) — the pieces threed_port's model branch and the frame
// build's texture feed share:
//
//   model_entry_to_api      the entry's key / vertex / index bytes (16-bit
//                           indices when they fit, as the TS Uint16Array)
//   model_pbr_maps          `extrudedMesh.pbr`: the map keys the adapter names
//                           (`pbrmap:<layerId>:n|m|o|e`) and what feeds them
//   append_model_map_textures   the frame build's feed for those keys
//                           (MotionRendererBackend 0: setImage(key, src, _, false))
//   model_image_pixels      a `gltf:<modelKey>#<image>` source decoded to
//                           RGBA8 for the texture stage (the base colour and maps)
#pragma once

#include <string>
#include <string_view>
#include <vector>

#include "engine_api.hpp"
#include "frame_build.hpp"
#include "gltf_model.hpp"
#include "image_decode.hpp"
#include "scene_types.hpp"

namespace premation::scene {

void model_entry_to_api(const gltf::Entry& e, api::RenderExtrudedMesh& out);

/// Sets `data.geometry.pbr` and `data.mapSources` when the entry carries a map
/// or an emissive colour (absent otherwise: the draw keeps the narrow pipeline).
void model_pbr_maps(const gltf::Entry& e, std::string_view modelKey, const std::string& layerId, ExtrudedMeshData& data);

/// TextureRequests for a layer's model maps (none for other layers).
void append_model_map_textures(const RLayer& l, std::vector<TextureRequest>& out);

/// Decode a `gltf:` source's image from the registered model. False + why.
[[nodiscard]] bool model_image_pixels(std::string_view src, DecodedImage& out, std::string& why);

}  // namespace premation::scene
