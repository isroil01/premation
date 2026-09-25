#include "model_carrier.hpp"

#include <bit>
#include <cstring>

namespace premation::scene {

void model_entry_to_api(const gltf::Entry& e, api::RenderExtrudedMesh& out) {
  static_assert(std::endian::native == std::endian::little, "FrameScene mesh bytes are little-endian");
  out.key = e.key;
  out.vertices.resize(e.vertices.size() * sizeof(float));
  std::memcpy(out.vertices.data(), e.vertices.data(), out.vertices.size());
  if (e.index16) {
    out.index_format = api::RenderIndexFormat::uint16;
    out.indices.resize(e.indices.size() * sizeof(std::uint16_t));
    for (std::size_t i = 0; i < e.indices.size(); ++i) {
      const auto v = static_cast<std::uint16_t>(e.indices[i]);
      std::memcpy(out.indices.data() + (i * 2), &v, 2);
    }
  } else {
    out.index_format = api::RenderIndexFormat::uint32;
    out.indices.resize(e.indices.size() * sizeof(std::uint32_t));
    std::memcpy(out.indices.data(), e.indices.data(), out.indices.size());
  }
  out.ranges.clear();
}

void model_pbr_maps(const gltf::Entry& e, std::string_view modelKey, const std::string& layerId, ExtrudedMeshData& data) {
  const bool emissive = e.emissive[0] != 0 || e.emissive[1] != 0 || e.emissive[2] != 0;
  if (!e.maps.normal && !e.maps.metallicRoughness && !e.maps.occlusion && !e.maps.emissive && !emissive) return;
  api::RenderPbrMaps p;
  const auto slot = [&](const std::optional<std::size_t>& image, char suffix, std::optional<std::string>& key) {
    if (!image) return;
    key = "pbrmap:" + layerId + ":" + suffix;
    data.mapSources.emplace_back(*key, gltf::image_src(modelKey, *image));
  };
  slot(e.maps.normal, 'n', p.normal_key);
  slot(e.maps.metallicRoughness, 'm', p.metallic_roughness_key);
  slot(e.maps.occlusion, 'o', p.occlusion_key);
  slot(e.maps.emissive, 'e', p.emissive_key);
  p.normal_scale = e.normalScale;
  p.occlusion_strength = e.occlusionStrength;
  p.emissive.assign(e.emissive.begin(), e.emissive.end());
  data.geometry.pbr = std::move(p);
}

void append_model_map_textures(const RLayer& l, std::vector<TextureRequest>& out) {
  if (!l.extrudedMesh) return;
  for (const auto& [key, src] : l.extrudedMesh->mapSources) {
    TextureRequest r;
    r.key = key;
    r.kind = TexKind::media;
    r.src = src;
    r.premultiplied = false;  // setImage(key, src, undefined, false): data maps
    r.layerId = l.id;
    out.push_back(std::move(r));
  }
}

bool model_image_pixels(std::string_view src, DecodedImage& out, std::string& why) {
  const auto ref = gltf::parse_image_src(src);
  if (!ref) {
    why = "not a model image source";
    return false;
  }
  const auto model = gltf::registered_model(ref->first);
  if (!model || !model->parsed) {
    why = "model " + ref->first + " is not registered";
    return false;
  }
  if (ref->second >= model->parsed->images.size()) {
    why = "model " + ref->first + " has no image " + std::to_string(ref->second);
    return false;
  }
  return decode_image_bytes(model->parsed->images[ref->second].bytes, out, why);
}

}  // namespace premation::scene
