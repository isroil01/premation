// The extrusion / primitive / model mesh producers against the TypeScript's
// bytes: every `extrudedMesh` of the exported FrameScenes (<scenes>/<scene>/
// <frame>.pfs) is rebuilt by the C++ producers FROM ITS KEY ALONE (the key
// names the outline — rect size + radii, ellipse size, the text paint spec —
// and the depth / bevel / profile / cap flags) and compared exactly: index
// bytes, ranges, and the max |Δ| over the float32 vertices.
//
//   premation-scene --mesh-check <scenes> --fonts <fonts.json> [--only a,b]
#pragma once

#include <filesystem>
#include <set>
#include <string>

namespace premation::raster {
struct CanvasOptions;
}

namespace premation::scene {

/// Prints one line per mesh and a summary; returns 0 when every checked mesh is exact.
int mesh_check(const std::filesystem::path& scenes, const std::set<std::string>& only,
               const raster::CanvasOptions& canvas);

}  // namespace premation::scene
