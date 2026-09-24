// Parametric 3D primitives — src/core/geometry/primitiveMesh.ts (the
// generators) and src/core/scene/primitiveLayer.ts (the key, the interleave,
// the index width), ported call for call with V8's Math (motion::js) so the
// bytes equal the TypeScript's.
//
// A primitive layer's `extrudedMesh` is named by its key, `prim:<type>:…`
// (primitiveKey); the key carries every input, so a mesh is rebuilt from the
// key alone — what premation-scene --mesh-check does against the exported
// FrameScenes. GPU-free (engine_scene_core).
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "engine_api.hpp"

namespace premation::scene {

/// De-interleaved surface (PrimitiveGeometry): xyz / xyz / uv per vertex, CCW triangles.
struct PrimitiveGeometry {
  std::vector<float> positions;
  std::vector<float> normals;
  std::vector<float> uvs;
  std::vector<std::uint32_t> indices;
};

[[nodiscard]] PrimitiveGeometry sphere_mesh(double radius, double widthSegments = 32, double heightSegments = 16);
[[nodiscard]] PrimitiveGeometry cylinder_mesh(double radiusTop, double radiusBottom, double height, double radialSegments = 32,
                                              bool capped = true);
[[nodiscard]] PrimitiveGeometry torus_mesh(double radius, double tube, double radialSegments = 16, double tubularSegments = 48);
[[nodiscard]] PrimitiveGeometry box_mesh(double width, double height, double depth);
[[nodiscard]] PrimitiveGeometry capsule_mesh(double radius, double height, double radialSegments = 32, double capSegments = 8);

/// A primitive layer's renderer-ready mesh (primitiveLayer.ts buildCached + primitiveEntryFor).
struct PrimitiveMesh {
  std::string key;
  /// 8 floats per vertex: position, normal, uv.
  std::vector<float> vertices;
  std::vector<std::uint32_t> indices;
  /// 16-bit indices when every vertex index fits (the TypeScript's Uint16Array).
  bool index16 = true;
  /// An uncapped cylinder / cone: its inside is visible, so it lights two-sided.
  bool doubleSided = false;
};

/// The mesh a `prim:…` key names; nullopt for a malformed or unknown key.
[[nodiscard]] std::optional<PrimitiveMesh> primitive_mesh_for_key(std::string_view key);

/// The FrameScene carrier's geometry half (key, bytes, index format, the one
/// range — `front` when double-sided, else `side` — covering every index).
void primitive_mesh_to_api(const PrimitiveMesh& m, api::RenderExtrudedMesh& out);

}  // namespace premation::scene
