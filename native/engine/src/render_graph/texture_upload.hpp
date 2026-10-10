// CPU pixels → a GPU texture, in bands of rows.
//
// Dawn stages each queue.WriteTexture in ONE upload buffer the size of the
// data, and a buffer over the device's maxBufferSize (256 MB unless the device
// asks for more) is a validation error: the write is dropped, the texture keeps
// its cleared texels and its layer draws nothing — with no error anywhere but
// stderr. A raster well inside the 2D texture limit crosses that size: a
// stacked-repeater lattice's 9000×5400 layer box was one 644 MB upload
// (2026-10-10). Bands keep every staging buffer small.
//
// A texture written in more than one band must be a RenderAttachment: the
// first band covers part of it, so Dawn zero-fills it first, and a texture it
// cannot render to is cleared from a staging buffer of its whole size.
#pragma once

#include <webgpu/webgpu_cpp.h>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <span>

namespace premation::rg {

/// The most one WriteTexture stages: a quarter of the WebGPU default maxBufferSize.
inline constexpr std::uint64_t kUploadBandBytes = std::uint64_t{64} << 20U;

/// Write `height` rows of `data` (`bytesPerRow` apart, `rowBytes` of texels each)
/// into mip level 0 of `texture` at (0, 0), at most `bandBytes` per WriteTexture.
/// `data` holds `bytesPerRow * (height - 1) + rowBytes` bytes or more.
inline void write_texture_rows(const wgpu::Queue& queue, const wgpu::Texture& texture, std::span<const std::uint8_t> data,
                               std::uint32_t bytesPerRow, std::uint32_t rowBytes, std::uint32_t width,
                               std::uint32_t height, std::uint64_t bandBytes = kUploadBandBytes) {
  if (width == 0 || height == 0 || bytesPerRow == 0 || bytesPerRow < rowBytes) return;
  if (data.size() < std::size_t{bytesPerRow} * (height - 1) + rowBytes) return;
  const auto bandRows = static_cast<std::uint32_t>(std::clamp<std::uint64_t>(bandBytes / bytesPerRow, 1, height));
  for (std::uint32_t y = 0; y < height; y += bandRows) {
    const std::uint32_t rows = std::min(bandRows, height - y);
    wgpu::TexelCopyTextureInfo dst{};
    dst.texture = texture;
    dst.origin = {0, y, 0};
    wgpu::TexelCopyBufferLayout layout{};
    layout.bytesPerRow = bytesPerRow;
    layout.rowsPerImage = rows;
    const wgpu::Extent3D size{width, rows, 1};
    const std::size_t bytes = std::size_t{bytesPerRow} * (rows - 1) + rowBytes;
    queue.WriteTexture(&dst, data.subspan(std::size_t{bytesPerRow} * y, bytes).data(), bytes, &layout, &size);
  }
}

}  // namespace premation::rg
