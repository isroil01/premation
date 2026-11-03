// A frame the scene builder produced on the core thread for the render thread:
// the RenderFrameFile (FrameScene + view + small blobs) and the texture feed
// its keys resolve through (scene_textures.hpp).
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "core/frame_scene.hpp"
#include "engine_api.hpp"
#include "frame_build.hpp"

namespace premation {

struct BuiltFrame {
  /// Comp-space caching (frame_scene.hpp CompSpaceFrame): the frame was built
  /// for a comp-space texture of this geometry, not for the slot. Absent = slot space.
  std::optional<CompSpaceFrame> compSpace;
  api::RenderFrameFile file;
  std::vector<scene::TextureRequest> textures;
  /// Transport playing: footage decodes ahead of the playhead.
  bool playing = false;
  /// SDK 1.4 (T4): a plugin simulation was still catching up when this was built: never final,
  /// drawn again until it is.
  bool simPending = false;
  double buildMs = 0;
  /// Font families the document's text names (the render thread's FontSet
  /// loads new ones before rasterising — FontSet is filled before shaping).
  std::vector<std::string> fontFamilies;
  /// P7: every effect type the DOCUMENT uses (not only this frame's), so the
  /// render thread compiles their pipelines while idle — before an effect's
  /// first appearance mid-playback would stall that frame on the compile.
  std::vector<std::string> effectTypes;
  /// Where relative media paths resolve (FrameBuilder::set_media_base; the
  /// render thread's texture feed follows it). '' = none.
  std::string mediaBase;
  /// P6: the frame's content hash (everything but the slot size), computed by
  /// the build on the core thread — the render thread's frame-cache key mixes
  /// the slot size into it instead of encoding the file again. Absent = the
  /// drawer hashes the frame itself.
  std::optional<std::uint64_t> contentHash;
  /// P6: the render thread draws `file` in place (a per-draw copy of the
  /// scene, its meshes and blobs cost as much as the draw's CPU work). What a
  /// draw changes is put back first: the texture refs the build made (the
  /// feed's are appended per draw) and the view as built (a resize in flight
  /// draws it at the slot's size). Render thread only, set on the first draw.
  struct AsBuilt {
    std::size_t textureRefs = 0;
    double cssWidth = 0;
    double cssHeight = 0;
    double devicePixelRatio = 0;
  };
  std::optional<AsBuilt> asBuilt;
};

}  // namespace premation
