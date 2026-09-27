// imageAlphaCoverage.ts for the C++ document (D1: rigs on image layers): an
// image layer's bitmap decoded, drawn into a ≤64² canvas, read back and turned
// into the puppet coverage mask (alpha_mesh.cpp coverage_mask_from_image_data).
// Cached per key + file stamp (the TS caches by asset id or src); a decode that
// fails is remembered and yields no mask — the bbox grid, as the TypeScript's
// `failed` set does. An SVG is drawn by the C++ SVG renderer (svg_layer.cpp,
// the texture feed's rasterizeSvg) where the TS decodes it through an <img>;
// a relative path resolves against the project folder (`mediaBase`, as the
// texture feed does). A source the engine cannot reach — a session blob: /
// remote URL, a relative path with no project folder — is reported by the caller.
#pragma once

#include <filesystem>
#include <memory>
#include <string>
#include <string_view>

#include "alpha_mesh.hpp"

namespace premation::scene {

struct CoverageLookup {
  std::shared_ptr<const rig::CoverageMask> mask;  ///< null = the bbox grid
  std::string unreachable;                         ///< non-empty: the source is not in the document
};

/// `getImageCoverageMask(key, src)` (key = assetId ?? src); relative paths
/// resolve against `mediaBase` ('' = none: reported unreachable).
[[nodiscard]] CoverageLookup image_coverage_mask(std::string_view key, std::string_view src,
                                                 const std::filesystem::path& mediaBase = {});

}  // namespace premation::scene
