// Imported glTF models for the scene builder (D2w 3D leftovers) — a port of
// src/core/media/gltf.ts (parseGltf: GLB + embedded .gltf, strided and sparse
// accessors, normalized integers, generated normals / indices, the refusal of
// Draco / meshopt / other required extensions) and src/core/scene/modelMesh.ts
// (modelKeyForBytes, primitiveToEntry: the y/z flip into compositor space, the
// baked KHR_texture_transform, 16-bit indices when they fit, fill / PBR
// factors / map slots), byte for byte: every stored value goes through the
// same float32 rounding the TypeScript's typed arrays apply.
//
// The model registry is the engine's `modelHydrate`: a model layer's
// { modelKey, mesh, prim } resolves through the imported root's Model
// component, whose `glbData` data: URL is the document's copy of the file.
// Parsed once per model key (process-wide, like the TS session registry).
//
// Not here: images are kept as their file bytes (decoded by the texture stage).
// Skins and morph targets are carried on the entry / model (the deltas flipped
// into compositor space, the inverse binds conjugated); model_deform.cpp
// applies them per frame.
//
// Pinned by tests/data/gltf_model_parity.json (src/core/scene/modelCrossEngine.test.ts).
#pragma once

#include <array>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "model.hpp"

namespace premation::scene::gltf {

struct TextureTransform {
  std::array<double, 2> offset{0, 0};
  double rotation = 0;  ///< radians, clockwise about the UV origin
  std::array<double, 2> scale{1, 1};
  std::optional<double> texCoord;
};

struct TextureRef {
  std::size_t image = 0;
  double texCoord = 0;
  std::optional<TextureTransform> transform;
};

struct Material {
  std::string name;
  std::array<double, 4> baseColorFactor{1, 1, 1, 1};
  std::optional<TextureRef> baseColorTexture;  ///< its `image` is baseColorImage
  bool doubleSided = false;
  double metallicFactor = 1;
  double roughnessFactor = 1;
  std::optional<TextureRef> normalTexture;
  double normalScale = 1;
  std::optional<TextureRef> metallicRoughnessTexture;
  std::optional<TextureRef> occlusionTexture;
  double occlusionStrength = 1;
  std::optional<TextureRef> emissiveTexture;
  std::array<double, 3> emissiveFactor{0, 0, 0};
  double emissiveStrength = 1;
  /// AE parity 4.7: alphaMode (OPAQUE | MASK | BLEND) + alphaCutoff, and the
  /// KHR_materials_* the import maps onto Material Options.
  std::string alphaMode = "OPAQUE";
  double alphaCutoff = 0.5;
  bool unlit = false;
  double transmission = 0;
  double ior = 1.5;
};

struct Image {
  std::vector<std::uint8_t> bytes;
  std::string mimeType;
};

struct Primitive {
  std::vector<float> positions;
  std::vector<float> normals;
  std::optional<std::vector<float>> uvs;
  std::vector<std::uint32_t> indices;
  std::optional<double> material;  ///< may name no material (then the spec default)
  std::optional<std::vector<float>> joints, weights;
  /// COLOR_0 as rgba per vertex (a VEC3 stream gets alpha 1) — AE parity 4.7.
  std::optional<std::vector<float>> colors;
  struct Target {
    std::optional<std::vector<float>> positions, normals;
  };
  std::vector<Target> targets;
};

struct Mesh {
  std::string name;
  std::vector<Primitive> primitives;  ///< TRIANGLES with a POSITION only (others skipped)
  std::vector<double> weights;
};

struct Skin {
  std::vector<double> joints;  ///< glTF node indices (`sk.joints ?? []`; a non-number reads NaN)
  std::optional<std::vector<float>> inverseBindMatrices;  ///< 16 floats per joint, glTF space
};

struct Parsed {
  std::vector<Mesh> meshes;
  std::vector<Material> materials;
  std::vector<Image> images;
  std::size_t skins = 0;
  std::vector<Skin> skinList;  ///< GltfSkin[], parallel to `skins`
};

/// parseGltf: nullopt + the TypeScript's error message when the file is refused.
[[nodiscard]] std::optional<Parsed> parse(std::span<const std::uint8_t> bytes, std::string& error);

/// modelKeyForBytes: `gltf-<fnv1a32 hex8>-<length>`.
[[nodiscard]] std::string model_key_for_bytes(std::span<const std::uint8_t> bytes);

/// ModelPrimitiveEntry — `textureUrl` / `maps` as IMAGE indices (the TS mints a
/// URL per image; the engine decodes the image bytes it names instead).
struct Entry {
  std::vector<float> vertices;  ///< x y z nx ny nz u v
  std::vector<std::uint32_t> indices;
  bool index16 = true;  ///< Uint16Array when the vertex count fits
  std::string key;      ///< `<modelKey>:m<mesh>p<prim>`
  std::array<double, 6> bbox{};  ///< minX minY minZ maxX maxY maxZ
  std::string fill;              ///< #rrggbbaa of the base colour factor
  std::optional<std::size_t> textureImage;
  bool doubleSided = false;
  double metallic = 0;
  double roughness = 0.5;
  struct Maps {
    std::optional<std::size_t> normal, metallicRoughness, occlusion, emissive;
  } maps;
  double normalScale = 1;
  double occlusionStrength = 1;
  std::array<double, 3> emissive{0, 0, 0};
  std::optional<std::array<double, 5>> uvTransform;  ///< offsetX offsetY scaleX scaleY rotation
  bool skinned = false;
  /// skinData: joints as u16 (ToUint16), weights renormalized to sum 1 — set when `skinned`.
  std::vector<std::uint16_t> skinJoints;
  std::vector<float> skinWeights;
  std::size_t morphTargets = 0;
  /// morphTargets' deltas, y/z flipped like the base attributes (flipYZTriples).
  struct MorphTarget {
    std::optional<std::vector<float>> positions, normals;
  };
  std::vector<MorphTarget> morphTargetData;
  std::vector<double> morphDefaults;
  /// AE parity 4.7: per-vertex colours (rgba, linear; empty = none) and the
  /// material's alpha mode — `opaque` / `mask:<cutoff>` / `blend` — the base
  /// texture's alpha is read through (image_src's suffix).
  std::vector<float> colors;
  std::string alphaMode = "opaque";
};

/// ModelSkin: joint node indices + inverse binds conjugated into compositor space (F·B·F).
struct ModelSkin {
  std::vector<double> joints;
  std::vector<float> invBind;  ///< 16 per joint
};

/// conjugateGltfMatrix(m, offset): each element × sign(row)·sign(col), -0 → 0.
[[nodiscard]] std::array<double, 16> conjugate_gltf_matrix(std::span<const float> m, std::size_t offset);

/// primitiveToEntry; nullopt when (mesh, prim) names no primitive.
[[nodiscard]] std::optional<Entry> primitive_to_entry(const Parsed& p, std::string_view modelKey, std::size_t mesh, std::size_t prim);

/// One registered model: the parse, its entries by `mesh:prim`, or why it failed.
struct Model {
  std::string key;
  std::optional<Parsed> parsed;
  std::map<std::pair<std::size_t, std::size_t>, Entry> entries;
  std::vector<ModelSkin> skins;
  std::string error;
};

/// The model `modelKey` from the document (an imported root's Model component
/// carrying `glbData`), parsed once per key. Null when the document holds no
/// source for it (`why` says so); a model whose file is refused is returned
/// with its `error` set.
[[nodiscard]] std::shared_ptr<const Model> model_for(const doc::Document& d, std::string_view modelKey, std::string& why);
/// The registered model (texture stage: `gltf:` texture sources), or null.
[[nodiscard]] std::shared_ptr<const Model> registered_model(std::string_view modelKey);
/// Register `bytes` under `modelKey` (tests; the document path goes through model_for).
std::shared_ptr<const Model> register_model(std::string_view modelKey, std::span<const std::uint8_t> bytes);
void clear_models();

/// The texture source a model image is fed from: `gltf:<modelKey>#<image>`.
[[nodiscard]] std::string image_src(std::string_view modelKey, std::size_t image);
/// The same with the material's alpha mode (Entry::alphaMode): `@opaque` drops
/// the texture's alpha, `@mask:<cutoff>` thresholds it, blend keeps it (no suffix).
[[nodiscard]] std::string image_src(std::string_view modelKey, std::size_t image, std::string_view alphaMode);
/// The alpha-mode suffix of a `gltf:` source ('' = none).
[[nodiscard]] std::string image_src_alpha(std::string_view src);
/// Parse `gltf:<modelKey>#<image>`.
[[nodiscard]] std::optional<std::pair<std::string, std::size_t>> parse_image_src(std::string_view src);

}  // namespace premation::scene::gltf
