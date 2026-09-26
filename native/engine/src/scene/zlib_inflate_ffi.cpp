// zlib inflate for the EXR reader (exr_read.hpp) — the one FFI call into zlib
// the scene library makes.
#include <zlib.h>

#include <limits>

#include "exr_read.hpp"

namespace premation::scene::exr {

Inflate zlib_inflate() {
  return [](std::span<const std::uint8_t> in, std::size_t expected, std::vector<std::uint8_t>& out) {
    if (in.size() > std::numeric_limits<uInt>::max() || expected > std::numeric_limits<uInt>::max()) return false;
    out.assign(expected, 0);
    z_stream zs{};
    if (inflateInit(&zs) != Z_OK) return false;
    // zlib's API takes a non-const input pointer; it never writes through it.
    zs.next_in = const_cast<Bytef*>(in.data());  // NOLINT(cppcoreguidelines-pro-type-const-cast)
    zs.avail_in = static_cast<uInt>(in.size());
    zs.next_out = out.data();
    zs.avail_out = static_cast<uInt>(expected);
    const int rc = inflate(&zs, Z_FINISH);
    const std::size_t produced = expected - zs.avail_out;
    inflateEnd(&zs);
    if (rc != Z_STREAM_END && !(rc == Z_BUF_ERROR && produced == expected) && !(rc == Z_OK && produced == expected)) return false;
    out.resize(produced);
    return true;
  };
}

}  // namespace premation::scene::exr
