// Extrusion meshes for the render snapshot — src/core/scene/extrusionMesh.ts:
// the layer's outline (rect / rounded rect / ellipse / path / TRACED text) and
// the extruded solid built from it (extrude_mesh.hpp), cached by the same keys
// the TypeScript mints (the FrameScene carries the key; the renderer caches GPU
// buffers under it).
//
// Text is traced exactly as `traceTextSpec` does it: the layer's text painted by
// the SAME painter as its texture (E3 paint_text_in_box, white, at 4x — 2x for
// animated glyphs), thresholded at 128, border-followed, simplified, smoothed
// into Béziers and flattened.
#pragma once

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "extrude_mesh.hpp"
#include "scene_types.hpp"

namespace premation::raster {
struct CanvasOptions;
}

namespace premation::scene {

struct ExtrusionOutline {
  std::string key;
  // shared_ptr: the outline cache and the frames built from it share one
  // immutable ring set (a traced title is re-used every frame, never copied).
  std::shared_ptr<const std::vector<mesh::Ring>> rings;
};

/// `extrusionOutlineFor(layer, node, width, height)`. Nullopt when the layer
/// cannot be outlined (no text to trace, no closed path, no fonts for text) —
/// the caller falls back exactly as the TypeScript does.
[[nodiscard]] std::optional<ExtrusionOutline> extrusion_outline_for(const RLayer& layer, double width, double height,
                                                                    const raster::CanvasOptions* canvas);

struct ExtrusionMeshRequest {
  double depth = 0;
  double bevel = 0;
  mesh::BevelProfile bevelStyle = mesh::BevelProfile::angular;
  bool frontCap = false;
  bool frontBevel = true;
  double holeBevelScale = 1;
};

struct KeyedMesh {
  std::string key;
  // shared_ptr: cached across frames and read by every frame that draws it.
  std::shared_ptr<const mesh::ExtrudedMesh> mesh;
};

/// `extrusionMeshFor(outline, width, height, req)`.
[[nodiscard]] std::optional<KeyedMesh> extrusion_mesh_for(const ExtrusionOutline& outline, double width, double height,
                                                          const ExtrusionMeshRequest& req);

/// The profile name as the key spells it ('angular' | 'concave' | 'convex').
[[nodiscard]] const char* bevel_profile_name(mesh::BevelProfile p) noexcept;
[[nodiscard]] mesh::BevelProfile bevel_profile_of(std::string_view s) noexcept;

/// The traced text rings for a paint spec (traceTextSpec + bezierRunsToRings(…, 0.5)),
/// the spec being the TS TextPaintSpec as JSON. Empty when nothing traces.
[[nodiscard]] std::vector<mesh::Ring> trace_text_rings(const Json& spec, double width, double height, int oversample,
                                                       const raster::CanvasOptions& canvas);

/// `traceTextSpec(spec)` at its default 4x: the smoothed closed runs in layer
/// space, cached by the spec's key. Empty when nothing traces.
[[nodiscard]] std::shared_ptr<const std::vector<mesh::BezRun>> trace_text_runs(const Json& spec, const raster::CanvasOptions& canvas);

/// The FrameScene carrier's geometry half: vertices / indices as their
/// little-endian bytes (Float32Array / Uint16Array | Uint32Array), the index
/// format and the ranges' role / first / count (colour, gain and texture are
/// the snapshot's, set by the caller).
void mesh_to_api(const std::string& key, const mesh::ExtrudedMesh& m, api::RenderExtrudedMesh& out);
[[nodiscard]] api::RenderMeshRole api_role(mesh::MeshRole r) noexcept;

/// Drop both caches (fonts changed; tests).
void clear_extrusion_mesh_caches();

}  // namespace premation::scene
