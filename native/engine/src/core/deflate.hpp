// zlib — the one library the document core and the export writers share for
// CRC-32 and DEFLATE (PNG IDAT, portable-zip entries). Every zlib call lives in
// deflate_ffi.cpp (CLAUDE.md: FFI only in *_ffi.cpp).
#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

namespace premation::zlib {

/// CRC-32 (IEEE 802.3), continuing from `crc` — PNG chunks and ZIP entries.
[[nodiscard]] std::uint32_t crc32(std::span<const std::uint8_t> data, std::uint32_t crc = 0) noexcept;

/// A zlib stream (RFC 1950) of `data` at `level` into `out`. False when zlib fails.
bool zlib_compress(std::span<const std::uint8_t> data, int level, std::vector<std::uint8_t>& out);

/// Raw DEFLATE (RFC 1951, no header) — a ZIP entry with method 8 — of `data` at `level`.
bool deflate_raw(std::span<const std::uint8_t> data, int level, std::vector<std::uint8_t>& out);

/// Inflate a raw DEFLATE stream whose uncompressed size is `size` (a ZIP
/// entry's central-directory size). False — `out` unspecified — when the
/// stream is damaged, ends early, or would produce more than `size` bytes
/// (a lying header never grows memory past what it declared).
bool inflate_raw(std::span<const std::uint8_t> data, std::size_t size, std::vector<std::uint8_t>& out);

}  // namespace premation::zlib
