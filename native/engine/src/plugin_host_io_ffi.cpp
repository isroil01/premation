// SDK 1.4 (X): binary stdio for premation-plugin-host (plugin_host_io_ffi.hpp).
#include "plugin_host_io_ffi.hpp"

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#else
#include <unistd.h>
#endif

namespace premation::plugins::oop::io {

void binary_stdio() noexcept {
#ifdef _WIN32
  (void)_setmode(0, _O_BINARY);
  (void)_setmode(1, _O_BINARY);
#endif
}

bool read_exact(std::span<std::uint8_t> into) noexcept {
  std::size_t at = 0;
  while (at < into.size()) {
    const std::size_t want = into.size() - at;
#ifdef _WIN32
    const int got = _read(0, into.data() + at, static_cast<unsigned>(want > 1U << 30 ? 1U << 30 : want));  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
#else
    const auto got = ::read(0, into.data() + at, want);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
#endif
    if (got <= 0) return false;
    at += static_cast<std::size_t>(got);
  }
  return true;
}

bool write_all(std::span<const std::uint8_t> bytes) noexcept {
  std::size_t at = 0;
  while (at < bytes.size()) {
    const std::size_t want = bytes.size() - at;
#ifdef _WIN32
    const int put = _write(1, bytes.data() + at, static_cast<unsigned>(want > 1U << 30 ? 1U << 30 : want));  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
#else
    const auto put = ::write(1, bytes.data() + at, want);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
#endif
    if (put <= 0) return false;
    at += static_cast<std::size_t>(put);
  }
  return true;
}

}  // namespace premation::plugins::oop::io
