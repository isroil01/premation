// hitTest over a built frame (D2w): what the frame of a composition draws
// under a comp point, from the geometry the render graph is handed — each
// renderable's model matrix maps the unit square onto its quad in comp pixels
// (frame_build.cpp; a corner pin or a 3D card's homography is already in it).
//
// The test is the drawn QUAD, not the drawn alpha (the editor's HitTester
// without a local shape: the oriented box): a point inside a layer's box hits
// it even where its pixels are transparent. Meshes, extrusions, glTF models
// and generators, whose quad is not their silhouette, are hit by their
// bounds. Adjustment layers and track-matte sources draw nothing of their own
// and are never hit; a quad with no area (a plane seen edge-on) is not hit.
#pragma once

#include <string>
#include <vector>

#include "engine_api.hpp"

namespace premation::scene {

/// The ids of the renderables of `scene` whose quad contains (x, y) in comp
/// pixels, topmost first (the scene lists them back to front). Nested
/// (non-collapsed) precomp children are not tested: their precomp is.
[[nodiscard]] std::vector<std::string> hit_renderables(const api::RenderFrameScene& scene, double x, double y);

/// Whether `r`'s quad contains (x, y) — the unit square through its model
/// matrix (projective when the matrix is), bounds for meshes / generators.
[[nodiscard]] bool renderable_contains(const api::Renderable& r, double x, double y);

}  // namespace premation::scene
