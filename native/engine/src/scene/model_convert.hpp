// AE parity 4.7 — the 3D model importer's normalizer: any model the editor
// accepts becomes ONE plain glTF 2.0 binary that the renderer's own reader
// (gltf_model.cpp) and the editor's import layout both take as is.
//
//   .glb / .gltf   repacked: sidecar buffers and images resolved from the file
//                  set and embedded; meshopt-compressed buffer views
//                  (EXT_/KHR_meshopt_compression, the vendored meshoptimizer
//                  decoder — meshopt_ffi.cpp), Draco geometry (KHR_draco_mesh_compression, the
//                  vcpkg Draco decoder — draco_ffi.cpp) and quantized
//                  attributes (KHR_mesh_quantization) decoded to plain floats;
//                  KTX2 / Basis textures (KHR_texture_basisu, vcpkg libktx —
//                  ktx_ffi.cpp) transcoded to PNG. Every other part of the
//                  file (nodes, skins, morph targets, animations, materials and
//                  their KHR_materials_* extensions) is kept.
//   .obj (+ .mtl)  meshes per object / group and material, MTL colours,
//                  textures (map_Kd / map_Ke / map_Bump), dissolve.
//   .fbx           through the vendored ufbx (model_fbx_ffi.cpp): the node hierarchy, meshes
//                  (triangulated, per material), materials and textures.
//                  Skins and animation are not converted (reported).
//   .usda / .usdz  an ASCII USD reader (Xform / Mesh / GeomSubset-free
//                  meshes, xformOps, UsdPreviewSurface + UsdUVTexture). A
//                  binary crate (.usdc, or a .usdz holding one) is refused
//                  with a message naming the alternatives.
//
// Pure: bytes in, bytes out (the job, kind_model_import.cpp, does the IO).
// Deterministic: no clock, no randomness; the same input gives the same GLB.
#pragma once

#include <array>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace premation::scene::modelio {

/// A refusal carrying the message the editor shows (thrown by every loader).
struct ConvertError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

/// One file the importer was handed: where it was (for relative references) and its bytes.
struct SourceFile {
  std::string path;  ///< forward or back slashes; only the relative structure matters
  std::vector<std::uint8_t> bytes;
};

/// The model plus the files it references, looked up the way a .gltf / .obj
/// names them: by path relative to the model's directory, then by bare name
/// (case-insensitive), as the editor's sidecar resolution does.
class FileSet {
 public:
  explicit FileSet(std::span<const SourceFile> files) : files_(files) {}
  [[nodiscard]] const SourceFile& model() const;
  /// The file `uri` names relative to the model (URL-decoded); nullptr when absent.
  [[nodiscard]] const SourceFile* find(std::string_view uri) const;

 private:
  std::span<const SourceFile> files_;
};

// ── the in-memory scene the non-glTF loaders build ──────────────────────────

/// An embedded picture (PNG / JPEG bytes as found, or a transcoded PNG).
struct TextureDef {
  std::vector<std::uint8_t> bytes;
  std::string mimeType = "image/png";
};

struct MaterialDef {
  std::string name;
  std::array<double, 4> baseColor{1, 1, 1, 1};  ///< linear
  int baseColorTexture = -1;
  double metallic = 0;
  double roughness = 0.5;
  std::array<double, 3> emissive{0, 0, 0};
  int emissiveTexture = -1;
  int normalTexture = -1;
  bool doubleSided = false;
  std::string alphaMode = "OPAQUE";  ///< OPAQUE | MASK | BLEND
  double alphaCutoff = 0.5;
  double transmission = 0;  ///< KHR_materials_transmission
  double ior = 1.5;         ///< KHR_materials_ior (1.5 = not written)
  bool unlit = false;       ///< KHR_materials_unlit
};

/// One triangle list. Attributes are per vertex, glTF axes (Y up, metres).
struct PrimitiveDef {
  std::vector<float> positions;  ///< xyz
  std::vector<float> normals;    ///< xyz, or empty (the reader generates them)
  std::vector<float> uvs;        ///< uv (glTF: v down), or empty
  std::vector<float> colors;     ///< rgba linear, or empty
  std::vector<std::uint32_t> indices;
  int material = -1;
};

struct MeshDef {
  std::string name;
  std::vector<PrimitiveDef> primitives;
};

struct NodeDef {
  std::string name;
  std::array<double, 3> translation{0, 0, 0};
  std::array<double, 4> rotation{0, 0, 0, 1};  ///< quaternion xyzw
  std::array<double, 3> scale{1, 1, 1};
  int mesh = -1;
  std::vector<int> children;
};

struct SceneModel {
  std::vector<NodeDef> nodes;
  std::vector<int> roots;
  std::vector<MeshDef> meshes;
  std::vector<MaterialDef> materials;
  std::vector<TextureDef> textures;
  std::vector<std::string> warnings;
};

struct ConvertResult {
  std::vector<std::uint8_t> glb;
  std::vector<std::string> warnings;
};

/// Normalize `files[0]` (with the rest as its sidecars) into a plain GLB.
[[nodiscard]] ConvertResult convert_model(std::span<const SourceFile> files);

/// The pieces, for tests.
[[nodiscard]] std::vector<std::uint8_t> write_glb(const SceneModel& scene);
[[nodiscard]] ConvertResult repack_gltf(const FileSet& files);
[[nodiscard]] SceneModel load_obj(const FileSet& files);
[[nodiscard]] SceneModel load_usda(std::string_view text, const FileSet& files, std::string_view baseDir);
[[nodiscard]] SceneModel load_usdz(const FileSet& files);
[[nodiscard]] SceneModel load_fbx(const FileSet& files);

/// A file the importer could not read or write (the job reports it as `io`).
struct ModelIoError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

/// What `import_model_files` wrote.
struct ImportedModel {
  std::filesystem::path glb;
  std::string name;
  std::vector<std::string> warnings;  ///< de-duplicated
};

/// The modelImport job's work (kind_model_import.cpp): read `files` (the model
/// first, then its sidecars), convert, and write `<folder>/<name>.glb` —
/// temp file + rename, under a free name ("name 2.glb", …) so an earlier
/// import is never overwritten. `name` empty = the model's stem; characters
/// the OS refuses in a file name become '_'. Nullopt when `cancelled` said so
/// between steps. Throws ConvertError (not a model / refused) or ModelIoError.
[[nodiscard]] std::optional<ImportedModel> import_model_files(std::span<const std::string> files, const std::filesystem::path& folder,
                                                              std::string name,
                                                              const std::function<void(double, const std::string&)>& progress,
                                                              const std::function<bool()>& cancelled);

/// The model formats the importer takes, by extension (lower case, with the dot).
[[nodiscard]] bool is_model_extension(std::string_view ext);

/// EXT_ / KHR_meshopt_compression: decode one buffer view (`mode` ATTRIBUTES | TRIANGLES | INDICES, `filter`
/// NONE | OCTAHEDRAL | QUATERNION | EXPONENTIAL | COLOR) into `count × stride` bytes (meshopt_ffi.cpp, vendored).
[[nodiscard]] bool decode_meshopt(std::span<const std::uint8_t> src, std::size_t count, std::size_t stride, std::string_view mode,
                                  std::string_view filter, std::vector<std::uint8_t>& out);

// ── optional codecs (vcpkg; draco_ffi.cpp / ktx_ffi.cpp) ────────────────────

/// One decoded Draco primitive: attributes by Draco unique id, as floats.
struct DracoMesh {
  struct Attribute {
    std::uint32_t uniqueId = 0;
    int components = 0;
    std::vector<float> values;
  };
  std::vector<Attribute> attributes;
  std::vector<std::uint32_t> indices;
  std::uint32_t vertexCount = 0;
};
/// Whether this build carries the Draco decoder.
[[nodiscard]] bool draco_available() noexcept;
/// Decode a KHR_draco_mesh_compression buffer view. False + error on failure.
[[nodiscard]] bool decode_draco(std::span<const std::uint8_t> bytes, DracoMesh& out, std::string& error);

/// Whether this build carries the KTX2 / Basis transcoder.
[[nodiscard]] bool ktx_available() noexcept;
/// Transcode a KTX2 image to straight RGBA8, rows top-down. False + error on failure.
[[nodiscard]] bool decode_ktx2(std::span<const std::uint8_t> bytes, std::vector<std::uint8_t>& rgba, std::uint32_t& width,
                               std::uint32_t& height, std::string& error);

}  // namespace premation::scene::modelio
