// Document media sources as file paths, GPU-free (media_paths.cpp): shared by
// the texture feed (scene_textures.hpp) and the model registry (gltf_model.cpp).
#pragma once

#include <string>
#include <string_view>

namespace premation::scene {

/// A document media `src` as a file path: `file://` and the desktop app's
/// `local-file://` URLs decoded; anything else returned unchanged.
[[nodiscard]] std::string file_url_path(std::string_view src);

}  // namespace premation::scene
