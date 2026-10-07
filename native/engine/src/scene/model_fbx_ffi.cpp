// .fbx → SceneModel through the vendored ufbx (model_convert.hpp, AE parity 4.7).
//
// The scene is converted to glTF's axes (right-handed, Y up) and metres by
// ufbx itself; nodes keep their local TRS; every mesh is triangulated and
// split per material part; materials read ufbx's PBR view (which maps the
// classic FBX Lambert / Phong slots onto it); textures come from the file's
// embedded content, else from the selection by relative path / file name.
// Skins, blend shapes and animation are not converted — reported, so the
// user knows what a .glb export would keep.
#include <algorithm>
#include <cmath>
#include <map>
#include <string>

#include "model_convert.hpp"
#include "ufbx.h"

namespace premation::scene::modelio {
namespace {

std::string str(const ufbx_string& s) { return {s.data, s.length}; }

std::string mime_of(const std::vector<std::uint8_t>& b) {
  if (b.size() >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return "image/jpeg";
  if (b.size() >= 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F') return "image/webp";
  return "image/png";
}

bool is_web_image(const std::vector<std::uint8_t>& b) {
  if (b.size() >= 8 && b[0] == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') return true;
  if (b.size() >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return true;
  return b.size() >= 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F';
}

struct Converter {
  const FileSet& files;
  SceneModel scene;
  std::map<const ufbx_texture*, int> textureIndex;
  std::map<const ufbx_material*, int> materialIndex;
  std::map<const ufbx_mesh*, int> meshIndex;

  int texture(const ufbx_texture* t) {
    if (t == nullptr) return -1;
    if (const auto it = textureIndex.find(t); it != textureIndex.end()) return it->second;
    std::vector<std::uint8_t> bytes;
    if (t->content.size > 0) {
      const auto* p = static_cast<const std::uint8_t*>(t->content.data);
      bytes.assign(p, p + t->content.size);
    } else {
      for (const ufbx_string* name : {&t->relative_filename, &t->filename}) {
        if (name->length == 0) continue;
        if (const SourceFile* f = files.find(str(*name))) {
          bytes = f->bytes;
          break;
        }
      }
    }
    int index = -1;
    if (bytes.empty()) {
      scene.warnings.push_back("texture “" + str(t->relative_filename.length > 0 ? t->relative_filename : t->filename) +
                               "” was not in the selection");
    } else if (!is_web_image(bytes)) {
      scene.warnings.push_back("texture “" + str(t->name) + "” is not PNG / JPEG / WebP and was left out");
    } else {
      TextureDef td;
      td.bytes = std::move(bytes);
      td.mimeType = mime_of(td.bytes);
      scene.textures.push_back(std::move(td));
      index = static_cast<int>(scene.textures.size()) - 1;
    }
    textureIndex.emplace(t, index);
    return index;
  }

  int material(const ufbx_material* m) {
    if (m == nullptr) return -1;
    if (const auto it = materialIndex.find(m); it != materialIndex.end()) return it->second;
    MaterialDef md;
    md.name = str(m->name);
    const ufbx_material_pbr_maps& p = m->pbr;
    if (p.base_color.has_value) {
      const double f = p.base_factor.has_value ? p.base_factor.value_real : 1.0;
      md.baseColor = {p.base_color.value_vec4.x * f, p.base_color.value_vec4.y * f, p.base_color.value_vec4.z * f, 1};
    }
    md.baseColorTexture = texture(p.base_color.texture);
    if (p.metalness.has_value) md.metallic = std::clamp(static_cast<double>(p.metalness.value_real), 0.0, 1.0);
    if (p.roughness.has_value) md.roughness = std::clamp(static_cast<double>(p.roughness.value_real), 0.0, 1.0);
    if (p.emission_color.has_value) {
      const double f = p.emission_factor.has_value ? p.emission_factor.value_real : 1.0;
      md.emissive = {p.emission_color.value_vec4.x * f, p.emission_color.value_vec4.y * f, p.emission_color.value_vec4.z * f};
    }
    md.emissiveTexture = texture(p.emission_color.texture);
    md.normalTexture = texture(p.normal_map.texture != nullptr ? p.normal_map.texture : m->fbx.normal_map.texture);
    if (p.opacity.has_value && p.opacity.value_real < 0.999) {
      md.baseColor[3] = std::clamp(static_cast<double>(p.opacity.value_real), 0.0, 1.0);
      md.alphaMode = "BLEND";
    }
    if (p.transmission_factor.has_value && p.transmission_factor.value_real > 0) {
      md.transmission = std::clamp(static_cast<double>(p.transmission_factor.value_real), 0.0, 1.0);
    }
    if (p.specular_ior.has_value && p.specular_ior.value_real >= 1) md.ior = std::min(4.0, static_cast<double>(p.specular_ior.value_real));
    scene.materials.push_back(std::move(md));
    const int i = static_cast<int>(scene.materials.size()) - 1;
    materialIndex.emplace(m, i);
    return i;
  }

  int mesh(const ufbx_mesh* m) {
    if (const auto it = meshIndex.find(m); it != meshIndex.end()) return it->second;
    MeshDef md;
    md.name = str(m->name);
    std::vector<std::uint32_t> tri(m->max_face_triangles * 3);
    const bool hasUv = m->vertex_uv.exists;
    const bool hasNormal = m->vertex_normal.exists;
    const bool hasColor = m->vertex_color.exists;
    const auto emit_part = [&](const ufbx_uint32_list& faceIndices, int mat) {
      PrimitiveDef p;
      p.material = mat;
      for (std::size_t k = 0; k < faceIndices.count; ++k) {
        const ufbx_face face = m->faces.data[faceIndices.data[k]];
        if (face.num_indices < 3) continue;
        const std::uint32_t n = ufbx_triangulate_face(tri.data(), tri.size(), m, face);
        for (std::uint32_t c = 0; c < n * 3; ++c) {
          const std::uint32_t ix = tri[c];
          const ufbx_vec3 pos = ufbx_get_vertex_vec3(&m->vertex_position, ix);
          p.positions.insert(p.positions.end(), {static_cast<float>(pos.x), static_cast<float>(pos.y), static_cast<float>(pos.z)});
          if (hasNormal) {
            const ufbx_vec3 nr = ufbx_get_vertex_vec3(&m->vertex_normal, ix);
            p.normals.insert(p.normals.end(), {static_cast<float>(nr.x), static_cast<float>(nr.y), static_cast<float>(nr.z)});
          }
          if (hasUv) {
            const ufbx_vec2 uv = ufbx_get_vertex_vec2(&m->vertex_uv, ix);
            p.uvs.insert(p.uvs.end(), {static_cast<float>(uv.x), static_cast<float>(1.0 - uv.y)});  // FBX v up → glTF v down
          }
          if (hasColor) {
            const ufbx_vec4 cl = ufbx_get_vertex_vec4(&m->vertex_color, ix);
            p.colors.insert(p.colors.end(), {static_cast<float>(cl.x), static_cast<float>(cl.y), static_cast<float>(cl.z), static_cast<float>(cl.w)});
          }
          p.indices.push_back(static_cast<std::uint32_t>(p.indices.size()));
        }
      }
      if (!p.indices.empty()) md.primitives.push_back(std::move(p));
    };
    if (m->material_parts.count > 0) {
      for (std::size_t i = 0; i < m->material_parts.count; ++i) {
        const ufbx_mesh_part& part = m->material_parts.data[i];
        const ufbx_material* mat = part.index < m->materials.count ? m->materials.data[part.index] : nullptr;
        emit_part(part.face_indices, material(mat));
      }
    } else {
      std::vector<std::uint32_t> all(m->faces.count);
      for (std::size_t i = 0; i < all.size(); ++i) all[i] = static_cast<std::uint32_t>(i);
      emit_part(ufbx_uint32_list{all.data(), all.size()}, -1);
    }
    scene.meshes.push_back(std::move(md));
    const int i = static_cast<int>(scene.meshes.size()) - 1;
    meshIndex.emplace(m, i);
    return i;
  }

  int node(const ufbx_node* n) {
    NodeDef nd;
    nd.name = str(n->name);
    const ufbx_transform& t = n->local_transform;
    nd.translation = {t.translation.x, t.translation.y, t.translation.z};
    nd.rotation = {t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w};
    nd.scale = {t.scale.x, t.scale.y, t.scale.z};
    // A mesh's geometry transform (pivot offsets) is baked by ufbx when asked; here it is identity or folded below.
    if (n->mesh != nullptr) nd.mesh = mesh(n->mesh);
    scene.nodes.push_back(std::move(nd));
    const int self = static_cast<int>(scene.nodes.size()) - 1;
    for (std::size_t i = 0; i < n->children.count; ++i) {
      const int c = node(n->children.data[i]);
      scene.nodes[static_cast<std::size_t>(self)].children.push_back(c);
    }
    return self;
  }
};

}  // namespace

SceneModel load_fbx(const FileSet& files) {
  const SourceFile& f = files.model();
  ufbx_load_opts opts{};
  opts.target_axes = ufbx_axes_right_handed_y_up;
  opts.target_unit_meters = 1.0;
  opts.space_conversion = UFBX_SPACE_CONVERSION_MODIFY_GEOMETRY;
  opts.generate_missing_normals = true;
  // Geometry transforms (FBX pivots) folded into helper nodes, so every node's TRS stays plain.
  opts.geometry_transform_handling = UFBX_GEOMETRY_TRANSFORM_HANDLING_HELPER_NODES;
  ufbx_error error{};
  ufbx_scene* sc = ufbx_load_memory(f.bytes.data(), f.bytes.size(), &opts, &error);
  if (sc == nullptr) {
    std::string msg(512, '\0');
    msg.resize(ufbx_format_error(msg.data(), msg.size(), &error));
    throw ConvertError("The .fbx does not load: " + msg);
  }
  Converter cv{files, {}, {}, {}, {}};
  try {
    const ufbx_node* root = sc->root_node;
    for (std::size_t i = 0; root != nullptr && i < root->children.count; ++i) cv.scene.roots.push_back(cv.node(root->children.data[i]));
    if (sc->skin_deformers.count > 0) cv.scene.warnings.push_back("skinning was not converted (the meshes import in their bind pose)");
    if (sc->blend_deformers.count > 0) cv.scene.warnings.push_back("blend shapes were not converted");
    bool animated = false;
    for (std::size_t i = 0; i < sc->anim_stacks.count; ++i) animated = animated || sc->anim_stacks.data[i]->layers.count > 0;
    if (animated) cv.scene.warnings.push_back("animation was not converted — export the model as .glb to keep it");
  } catch (...) {
    ufbx_free_scene(sc);
    throw;
  }
  ufbx_free_scene(sc);
  return std::move(cv.scene);
}

}  // namespace premation::scene::modelio
