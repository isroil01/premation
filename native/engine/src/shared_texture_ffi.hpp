// Route C: a ring of GPU textures shared with Electron (docs/VIEWPORT_ROUTE.md).
//
// One header, one implementation per OS (CMake picks it; PREMATION_SHARED_TEXTURE
// is defined where one exists):
//
//   Windows  shared_texture_ffi.cpp      D3D11 texture (RGBA8, SHARED | SHARED_NTHANDLE,
//                                        no keyed mutex — what Electron's sharedTexture
//                                        expects for `rgba`) on the Dawn device's adapter,
//                                        imported as SharedTextureMemoryDXGISharedHandle;
//                                        the NT handle is duplicated into Electron main,
//                                        which imports it as `handle: { ntHandle }`.
//   macOS    shared_texture_ffi_mac.cpp  IOSurface ('RGBA', global) imported as
//                                        SharedTextureMemoryIOSurface, access bracketed
//                                        by SharedFence (MTLSharedEvent) fences; the
//                                        IOSurfaceID is announced, and Electron main
//                                        (electron/ioSurfaceBridge.ts) looks it up into a
//                                        process-local IOSurfaceRef for `handle: { ioSurface }`.
//   Linux    shared_texture_ffi_linux.cpp  (only where CMake finds GBM — PREMATION_DMABUF)
//                                        LINEAR ABGR8888 GBM buffers on the render node of
//                                        Chromium's GPU, imported as SharedTextureMemoryDmaBuf,
//                                        access bracketed by SyncFD fences; the dmabuf fd
//                                        numbers are announced with each plane's stride /
//                                        offset / size, Electron main duplicates them with
//                                        pidfd_getfd (host bridge) for `handle: { nativePixmap }`.
//                                        UNVERIFIED: written without a Linux GPU box.
//
// The protocol is the same everywhere: FrameSlots announces one `remoteHandle`
// per slot, FrameReady names a slot whose GPU work is complete, FrameRelease
// gives it back.
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
  /// What FrameSlots announces for this slot: an NT handle valid in the Electron
  /// main process (Windows), or the IOSurface's global IOSurfaceID (macOS).
  std::uint64_t remoteHandle = 0;
  bool free = true;
  bool copyable = false;  // CopySrc + CopyDst allowed (the D4 frame cache needs both)
  /// Linux dmabuf: the single plane's layout (FrameSlots strides / offsets / sizes); 0 elsewhere.
  std::uint32_t stride = 0;
  std::uint32_t offset = 0;
  std::uint64_t planeSize = 0;
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
  /// Linux dmabuf: the DRM format modifier of every slot (FrameSlots.modifier); 0 elsewhere.
  [[nodiscard]] std::uint64_t modifier() const noexcept { return modifier_; }

  // Bracket GPU writes to a slot (Dawn's shared-memory access rules). On macOS
  // the fences the previous EndAccess exported are waited on (on the GPU) by
  // the next BeginAccess of the same slot.
  bool begin_access(Slot& slot);
  bool end_access(Slot& slot);

  // Windows: close the host's copies of the slot handles (DuplicateHandle with
  // DUPLICATE_CLOSE_SOURCE into the host process). The engine owns their
  // lifetime: the host imports them and must never close them itself, or a
  // recycled handle value could be closed here. Called when a retired ring's
  // grace period is over; without it every resize would leak three textures in
  // Electron main.
  // macOS: nothing to close — an IOSurfaceID is a name, not a handle; the host
  // holds its own IOSurfaceLookup references and drops them when the ring is
  // replaced. Only the announced ids are forgotten.
  void close_remote_handles();

 private:
  struct Native;  // the OS objects behind the slots (RAII, in the per-OS .cpp)
  std::unique_ptr<Native> native_;
  std::vector<Slot> slots_;
  std::uint64_t modifier_ = 0;
};

}  // namespace premation::shared
