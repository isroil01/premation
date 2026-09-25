// Image (`asset:<id>`) environment skies from the C++ document (D2w 3D
// leftovers) — environmentImage.ts `ensureEnvironmentSh` for the engine: the
// sky's image asset decoded, drawn into a canvas at most 1024 px wide
// (Chromium's drawImage + getImageData, the C++ Canvas2D), resampled to the
// 256×128 linear equirect (`resampleEquirect`), projected onto SH9 and
// prefiltered into the reflection atlas (env_light.cpp, pinned by
// tests/data/env_asset_parity.json).
//
// What the TypeScript does with a sky it cannot load is mirrored: an empty
// asset id and a non-image asset fall back to the default 'studio' preset
// (null, `why` empty). What only the engine cannot do is reported (`why` set):
// an asset the document does not list, a source that is not in the document
// (blob:, a relative path with no project folder), an EXR (the TS projects its
// float planes, which the engine does not decode yet).
#pragma once

#include <array>
#include <memory>
#include <string>
#include <string_view>

#include "env_light.hpp"
#include "model.hpp"

namespace premation::scene {

struct EnvAsset {
  std::array<float, 27> sh{};
  EnvSpecularMap specular;
};

[[nodiscard]] std::shared_ptr<const EnvAsset> environment_asset(const doc::Document& d, std::string_view sky, std::string& why);

/// Drop the decoded skies (tests).
void clear_environment_assets();

}  // namespace premation::scene
