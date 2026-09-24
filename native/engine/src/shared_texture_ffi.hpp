// Route C: a ring of GPU textures shared with Electron by NT handle.
//
// Each slot is a D3D11 texture (RGBA8, SHARED | SHARED_NTHANDLE, no keyed
// mutex — what Electron's sharedTexture expects for `rgba`) created on the
// same adapter as the Dawn device, imported into Dawn as SharedTextureMemory,
// and duplicated into the Electron main process so it can call
// sharedTexture.importSharedTexture({ handle: { ntHandle } }).
#pragma once

#include <webgpu/webgpu_cpp.h>

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "gpu.hpp"

namespace premation::shared {

struct Slot {
  wgpu::SharedTextureMemory memory;
  wgpu::Texture texture;
  wgpu::TextureView view;
  std::uint64_t remoteHandle = 0;  // valid in the Electron main process
  bool free = true;
  bool copyable = false;  // CopySrc + CopyDst allowed (the D4 frame cache needs both)
};

class SharedTexturePool {
 public:
  SharedTexturePool();
  ~SharedTexturePool();
  SharedTexturePool(const SharedTexturePool&) = delete;
  SharedTexturePool& operator=(const SharedTexturePool&) = delete;
  SharedTexturePool(SharedTexturePool&&) = delete;
  SharedTexturePool& operator=(SharedTexturePool&&) = delete;

  bool init(const Gpu& gpu, std::uint32_t width, std::uint32_t height, std::uint32_t count, std::uint32_t targetPid,
            std::string& error);

  std::vector<Slot>& slots() { return slots_; }

  // Bracket GPU writes to a slot (Dawn's shared-memory access rules).
  bool begin_access(Slot& slot);
  bool end_access(Slot& slot);

  // Close the host's copies of the slot handles (DuplicateHandle with
  // DUPLICATE_CLOSE_SOURCE into the host process). The engine owns their
  // lifetime: the host imports them and must never close them itself, or a
  // recycled handle value could be closed here. Called when a retired ring's
  // grace period is over; without it every resize would leak three textures in
  // Electron main.
  void close_remote_handles();

 private:
  struct Native;  // D3D11 device + textures + local handles (RAII, in the .cpp)
  std::unique_ptr<Native> native_;
  std::vector<Slot> slots_;
};

}  // namespace premation::shared
