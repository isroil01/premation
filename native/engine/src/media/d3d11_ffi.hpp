// Windows: the D3D11 device hardware decode runs on, and the pool of shared
// surfaces a decoded frame is copied into so Dawn (D3D12) can read it with no
// CPU copy.
//
// Why a copy at all: ffmpeg's D3D11VA decoder writes into a texture ARRAY it
// owns and recycles (a fixed pool of ~20 slices); Dawn can only import a
// standalone 2D texture opened from a shared NT handle. So each decoded slice
// is copied GPU→GPU (CopySubresourceRegion, both planes at once) into a pooled
// NV12 / P010 texture created SHARED_NTHANDLE | SHARED_KEYEDMUTEX, and the
// decoder slice is released immediately — holding decoder slices in a cache
// would starve the decoder. 4K NV12 is 12 MB of VRAM bandwidth, ~0.1 ms.
//
// Synchronisation is the keyed mutex (key 0) on both sides: this side
// AcquireSync(0) → copy → ReleaseSync(0); Dawn's SharedTextureMemory with
// useKeyedMutex acquires/releases key 0 in BeginAccess/EndAccess. A pooled
// surface is only rewritten after the frame holding it was evicted and every
// reader dropped it.
//
// Every D3D11 call made here and every call ffmpeg makes on the device go
// through ONE mutex (Device::lock), installed as AVD3D11VADeviceContext.lock,
// because several decode threads share the device's immediate context.
#pragma once

#include <cstdint>
#include <memory>
#include <mutex>
#include <string>

#include "decoded_frame.hpp"

namespace premation::media::d3d11 {

enum class SurfaceFormat : std::uint8_t { nv12, p010, p016, y210, y410, ayuv };

/// What the GPU side needs to import a surface into Dawn.
struct SurfaceInfo {
  void* sharedHandle = nullptr;  // NT handle, owned by the surface (valid while it lives)
  std::uint64_t id = 0;          // stable for the pool slot: Dawn imports are cached by it
  SurfaceFormat format = SurfaceFormat::nv12;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
};

class Device {
 public:
  /// A video-capable D3D11 device on the adapter with `luid` (0 = the default adapter).
  static std::unique_ptr<Device> create(std::uint64_t luid, std::string& error);
  ~Device();
  Device(const Device&) = delete;
  Device& operator=(const Device&) = delete;
  Device(Device&&) = delete;
  Device& operator=(Device&&) = delete;

  /// ID3D11Device* (borrowed) — handed to ffmpeg's AVD3D11VADeviceContext.
  [[nodiscard]] void* native_device() const noexcept;
  /// ID3D11DeviceContext* (borrowed).
  [[nodiscard]] void* native_context() const noexcept;
  [[nodiscard]] const std::string& adapter_name() const noexcept;
  [[nodiscard]] std::uint32_t vendor_id() const noexcept;
  [[nodiscard]] std::uint64_t luid() const noexcept;

  /// The device lock (see the header comment).
  void lock() { mu_.lock(); }
  void unlock() { mu_.unlock(); }

  /// Copy slice `slice` of the decoder texture `srcTexture` (ID3D11Texture2D*,
  /// NV12 / P010 / …) into a pooled shared surface. Takes the device lock.
  /// nullptr (with `error`) when the format can't be shared or the pool is at `maxSurfaces`.
  std::unique_ptr<GpuSurface> copy_slice(void* srcTexture, unsigned slice, std::uint32_t width, std::uint32_t height,
                                         std::string& error);
  void set_max_surfaces(std::size_t n) noexcept;
  [[nodiscard]] std::size_t surfaces_alive() const noexcept;
  [[nodiscard]] std::size_t surface_bytes(SurfaceFormat f, std::uint32_t w, std::uint32_t h) const noexcept;

  struct Impl;

 private:
  explicit Device(std::unique_ptr<Impl> impl);
  std::unique_ptr<Impl> impl_;
  std::mutex mu_;
};

/// The import description of a surface made by copy_slice; nullptr for any other GpuSurface.
[[nodiscard]] const SurfaceInfo* surface_info(const GpuSurface* s) noexcept;

}  // namespace premation::media::d3d11
