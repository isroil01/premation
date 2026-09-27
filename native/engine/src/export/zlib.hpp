// F1: the two zlib calls the image-sequence writers need — the shared
// core/deflate_ffi.cpp (the document core reads DEFLATE zip entries with it too).
#pragma once

#include <cstdint>
#include <span>
#include <vector>

#include "deflate.hpp"

namespace premation::exporter {

/// CRC-32 (IEEE 802.3), continuing from `crc` — PNG chunks and ZIP entries.
[[nodiscard]] inline std::uint32_t crc32(std::span<const std::uint8_t> data, std::uint32_t crc = 0) noexcept {
  return zlib::crc32(data, crc);
}

/// A zlib stream (RFC 1950) of `data` at `level` into `out`. False when zlib fails.
inline bool zlib_compress(std::span<const std::uint8_t> data, int level, std::vector<std::uint8_t>& out) {
  return zlib::zlib_compress(data, level, out);
}

}  // namespace premation::exporter
