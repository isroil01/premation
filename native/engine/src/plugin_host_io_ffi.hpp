// SDK 1.4 (X): premation-plugin-host's stdin / stdout as binary byte streams (the OS calls live
// in plugin_host_io_ffi.cpp, CLAUDE.md: FFI only in *_ffi.cpp).
#pragma once

#include <cstdint>
#include <span>

namespace premation::plugins::oop::io {

/// Switch stdin / stdout to binary (no newline translation on Windows).
void binary_stdio() noexcept;
/// Fill `into` from stdin; false at end of stream or on an error.
bool read_exact(std::span<std::uint8_t> into) noexcept;
/// Write all of `bytes` to stdout; false when the reader is gone.
bool write_all(std::span<const std::uint8_t> bytes) noexcept;

}  // namespace premation::plugins::oop::io
