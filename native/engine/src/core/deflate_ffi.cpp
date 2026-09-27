#include "deflate.hpp"

#include <zlib.h>

#include <algorithm>
#include <limits>

namespace premation::zlib {
namespace {

constexpr std::size_t kMaxChunk = std::numeric_limits<uInt>::max();

/// deflate(`windowBits`) of the whole input, in chunks zlib's 32-bit counters can hold.
bool deflate_all(std::span<const std::uint8_t> data, int level, int windowBits, std::vector<std::uint8_t>& out) {
  z_stream z{};
  if (deflateInit2(&z, level, Z_DEFLATED, windowBits, 8, Z_DEFAULT_STRATEGY) != Z_OK) return false;
  out.assign(static_cast<std::size_t>(deflateBound(&z, static_cast<uLong>(std::min(data.size(), kMaxChunk)))) + 64, 0);
  std::size_t in = 0;
  std::size_t produced = 0;
  int r = Z_OK;
  for (;;) {
    if (z.avail_in == 0 && in < data.size()) {
      const std::size_t take = std::min(kMaxChunk, data.size() - in);
      // NOLINTNEXTLINE(cppcoreguidelines-pro-type-const-cast): zlib's input is never written
      z.next_in = const_cast<Bytef*>(data.data() + in);
      z.avail_in = static_cast<uInt>(take);
      in += take;
    }
    if (out.size() - produced < 1024) out.resize(std::max(out.size() * 2, produced + 65536));
    const std::size_t room = std::min(kMaxChunk, out.size() - produced);
    z.next_out = out.data() + produced;
    z.avail_out = static_cast<uInt>(room);
    r = deflate(&z, in == data.size() ? Z_FINISH : Z_NO_FLUSH);
    produced += room - z.avail_out;
    if (r == Z_STREAM_END) break;
    if (r != Z_OK && r != Z_BUF_ERROR) break;  // Z_BUF_ERROR: no progress this call; the next one has room/input
  }
  deflateEnd(&z);
  out.resize(produced);
  return r == Z_STREAM_END;
}

}  // namespace

std::uint32_t crc32(std::span<const std::uint8_t> data, std::uint32_t crc) noexcept {
  uLong c = crc;
  for (std::size_t i = 0; i < data.size(); i += kMaxChunk) {
    const std::size_t n = std::min(kMaxChunk, data.size() - i);
    c = ::crc32(c, data.subspan(i, n).data(), static_cast<uInt>(n));
  }
  return static_cast<std::uint32_t>(c);
}

bool zlib_compress(std::span<const std::uint8_t> data, int level, std::vector<std::uint8_t>& out) {
  return deflate_all(data, level, MAX_WBITS, out);
}

bool deflate_raw(std::span<const std::uint8_t> data, int level, std::vector<std::uint8_t>& out) {
  return deflate_all(data, level, -MAX_WBITS, out);
}

bool inflate_raw(std::span<const std::uint8_t> data, std::size_t size, std::vector<std::uint8_t>& out) {
  z_stream z{};
  if (inflateInit2(&z, -MAX_WBITS) != Z_OK) return false;
  // One spare byte: a stream that writes into it is longer than it declared.
  out.assign(size + 1, 0);
  std::size_t in = 0;
  std::size_t produced = 0;
  bool ok = false;
  for (;;) {
    if (z.avail_in == 0 && in < data.size()) {
      const std::size_t take = std::min(kMaxChunk, data.size() - in);
      // NOLINTNEXTLINE(cppcoreguidelines-pro-type-const-cast): zlib's input is never written
      z.next_in = const_cast<Bytef*>(data.data() + in);
      z.avail_in = static_cast<uInt>(take);
      in += take;
    }
    const std::size_t room = std::min(kMaxChunk, out.size() - produced);
    if (room == 0) break;  // longer than declared
    z.next_out = out.data() + produced;
    z.avail_out = static_cast<uInt>(room);
    const int r = inflate(&z, Z_NO_FLUSH);
    produced += room - z.avail_out;
    if (r == Z_STREAM_END) {
      ok = produced == size;
      break;
    }
    if (r == Z_BUF_ERROR && z.avail_in == 0 && in == data.size()) break;  // truncated
    if (r != Z_OK && r != Z_BUF_ERROR) break;                             // damaged
  }
  inflateEnd(&z);
  if (!ok) return false;
  out.resize(size);
  return true;
}

}  // namespace premation::zlib
