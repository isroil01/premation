#include "zlib.hpp"

#include <zlib.h>

#include <algorithm>
#include <limits>

namespace premation::exporter {

std::uint32_t crc32(std::span<const std::uint8_t> data, std::uint32_t crc) noexcept {
  uLong c = crc;
  constexpr std::size_t kMax = std::numeric_limits<uInt>::max();
  for (std::size_t i = 0; i < data.size(); i += kMax) {
    const std::size_t n = std::min(kMax, data.size() - i);
    c = ::crc32(c, data.subspan(i, n).data(), static_cast<uInt>(n));
  }
  return static_cast<std::uint32_t>(c);
}

bool zlib_compress(std::span<const std::uint8_t> data, int level, std::vector<std::uint8_t>& out) {
  z_stream z{};
  if (deflateInit(&z, level) != Z_OK) return false;
  out.resize(deflateBound(&z, static_cast<uLong>(data.size())));
  z.next_in = const_cast<Bytef*>(data.data());  // NOLINT(cppcoreguidelines-pro-type-const-cast): zlib's input is never written
  z.avail_in = static_cast<uInt>(data.size());
  z.next_out = out.data();
  z.avail_out = static_cast<uInt>(out.size());
  const int r = deflate(&z, Z_FINISH);
  out.resize(z.total_out);
  deflateEnd(&z);
  return r == Z_STREAM_END;
}

}  // namespace premation::exporter
