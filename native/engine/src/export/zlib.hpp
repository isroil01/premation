// F1: the two zlib calls the image-sequence writers need (zlib_ffi.cpp).
#pragma once

#include <cstdint>
#include <span>
#include <vector>

namespace premation::exporter {

/// CRC-32 (IEEE 802.3), continuing from `crc` — PNG chunks and ZIP entries.
[[nodiscard]] std::uint32_t crc32(std::span<const std::uint8_t> data, std::uint32_t crc = 0) noexcept;

/// A zlib stream (RFC 1950) of `data` at `level` into `out`. False when zlib fails.
bool zlib_compress(std::span<const std::uint8_t> data, int level, std::vector<std::uint8_t>& out);

}  // namespace premation::exporter
