// A decoded video frame as the rest of the engine sees it: plane pointers for a
// CPU frame, or an opaque GPU surface for a hardware frame that stayed on the
// GPU. The storage (an AVFrame reference, a D3D11 texture) lives behind this
// interface in the *_ffi.cpp files.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "media_types.hpp"

namespace premation::media {

/// The texel format of a decoded frame, in the terms the GPU conversion needs.
struct FrameFormat {
  Layout layout = Layout::planarYuv;
  /// Significant bits per sample (8, 10, 12, 16).
  std::uint8_t bitDepth = 8;
  /// Bytes per stored sample (1 or 2).
  std::uint8_t bytesPerSample = 1;
  /// Bits the value is shifted left inside its storage word (P010 = 6: MSB-aligned).
  std::uint8_t storageShift = 0;
  std::uint8_t chromaShiftX = 1;
  std::uint8_t chromaShiftY = 1;
  bool hasAlpha = false;
  Matrix matrix = Matrix::bt709;  // resolved (never unspecified)
  Range range = Range::limited;   // resolved
  friend bool operator==(const FrameFormat&, const FrameFormat&) = default;
};

/// One plane of a CPU frame. `components` = samples per texel (1; 2 for
/// interleaved UV; 4 for packed RGBA). Rows top-down, `stride` bytes apart.
struct Plane {
  const std::uint8_t* data = nullptr;
  std::size_t stride = 0;
  std::uint32_t width = 0;   // texels
  std::uint32_t height = 0;  // rows
  std::uint8_t components = 1;
};

/// Opaque GPU-resident frame (platform-specific; see d3d11_ffi.hpp).
class GpuSurface {
 public:
  GpuSurface() = default;
  virtual ~GpuSurface() = default;
  GpuSurface(const GpuSurface&) = delete;
  GpuSurface& operator=(const GpuSurface&) = delete;
  GpuSurface(GpuSurface&&) = delete;
  GpuSurface& operator=(GpuSurface&&) = delete;
};

class DecodedFrame {
 public:
  DecodedFrame() = default;
  virtual ~DecodedFrame() = default;
  DecodedFrame(const DecodedFrame&) = delete;
  DecodedFrame& operator=(const DecodedFrame&) = delete;
  DecodedFrame(DecodedFrame&&) = delete;
  DecodedFrame& operator=(DecodedFrame&&) = delete;

  FrameFormat format;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  /// Presentation index in the stream's FrameIndex, and the decoder's pts.
  std::int64_t index = 0;
  std::int64_t pts = 0;
  /// CPU planes (Y U V A / Y UV / G B R A / RGBA), `planeCount` of them. Empty for a GPU frame.
  std::array<Plane, 4> planes{};
  std::uint8_t planeCount = 0;
  /// Non-null for a frame that stayed on the GPU (zero-copy route).
  GpuSurface* gpu = nullptr;
  /// Where it came from (for stats and the bench).
  DecodePath path = DecodePath::software;
  /// Memory it pins: CPU bytes (planes) or GPU bytes (surface).
  std::size_t cpuBytes = 0;
  std::size_t gpuBytes = 0;
};

}  // namespace premation::media
