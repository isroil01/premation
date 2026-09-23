// A frame the scene builder produced on the core thread for the render thread:
// the RenderFrameFile (FrameScene + view + small blobs) and the texture feed
// its keys resolve through (scene_textures.hpp).
#pragma once

#include <cstdint>
#include <vector>

#include "engine_api.hpp"
#include "frame_build.hpp"

namespace premation {

struct BuiltFrame {
  api::RenderFrameFile file;
  std::vector<scene::TextureRequest> textures;
  /// Transport playing: footage decodes ahead of the playhead.
  bool playing = false;
  double buildMs = 0;
  /// Font families the document's text names (the render thread's FontSet
  /// loads new ones before rasterising — FontSet is filled before shaping).
  std::vector<std::string> fontFamilies;
};

}  // namespace premation
