#include "zip_write.hpp"

#include <algorithm>
#include <limits>

#include "zlib.hpp"

namespace premation::exporter {
namespace {

constexpr std::uint32_t kMax32 = std::numeric_limits<std::uint32_t>::max();
constexpr std::uint16_t kMax16 = std::numeric_limits<std::uint16_t>::max();

void u16(std::vector<std::uint8_t>& b, std::uint64_t v) {
  for (unsigned s = 0; s < 16; s += 8) b.push_back(static_cast<std::uint8_t>(v >> s));
}
void u32(std::vector<std::uint8_t>& b, std::uint64_t v) {
  for (unsigned s = 0; s < 32; s += 8) b.push_back(static_cast<std::uint8_t>(v >> s));
}
void u64(std::vector<std::uint8_t>& b, std::uint64_t v) {
  for (unsigned s = 0; s < 64; s += 8) b.push_back(static_cast<std::uint8_t>(v >> s));
}

}  // namespace

bool ZipWriter::open(const std::filesystem::path& path) {
  out_.open(path, std::ios::binary | std::ios::trunc);
  offset_ = 0;
  records_.clear();
  return static_cast<bool>(out_);
}

void ZipWriter::write(const std::vector<std::uint8_t>& bytes) {
  out_.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  offset_ += bytes.size();
}

bool ZipWriter::add(std::string_view name, std::span<const std::uint8_t> data) {
  if (data.size() >= kMax32) return false;
  Record r{std::string(name), crc32(data), static_cast<std::uint32_t>(data.size()), offset_};
  std::vector<std::uint8_t> h;
  u32(h, 0x04034b50);
  u16(h, 20);  // version needed
  u16(h, 0);   // flags
  u16(h, 0);   // STORE
  u16(h, 0);   // time
  u16(h, 0);   // date
  u32(h, r.crc);
  u32(h, r.size);
  u32(h, r.size);
  u16(h, name.size());
  u16(h, 0);
  h.insert(h.end(), name.begin(), name.end());
  write(h);
  out_.write(reinterpret_cast<const char*>(data.data()), static_cast<std::streamsize>(data.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  offset_ += data.size();
  records_.push_back(std::move(r));
  return static_cast<bool>(out_);
}

bool ZipWriter::finish() {
  const std::uint64_t cdOffset = offset_;
  for (const Record& r : records_) {
    const bool far = r.offset >= kMax32;
    std::vector<std::uint8_t> c;
    u32(c, 0x02014b50);
    u16(c, far ? 45 : 20);  // version made by
    u16(c, far ? 45 : 20);  // version needed
    u16(c, 0);
    u16(c, 0);
    u16(c, 0);
    u16(c, 0);
    u32(c, r.crc);
    u32(c, r.size);
    u32(c, r.size);
    u16(c, r.name.size());
    u16(c, far ? 12 : 0);  // extra
    u16(c, 0);             // comment
    u16(c, 0);             // disk
    u16(c, 0);             // internal attributes
    u32(c, 0);             // external attributes
    u32(c, far ? kMax32 : r.offset);
    c.insert(c.end(), r.name.begin(), r.name.end());
    if (far) {
      u16(c, 0x0001);  // ZIP64 extended information
      u16(c, 8);
      u64(c, r.offset);
    }
    write(c);
  }
  const std::uint64_t cdSize = offset_ - cdOffset;
  const std::uint64_t count = records_.size();
  std::vector<std::uint8_t> e;
  if (count >= kMax16 || cdOffset >= kMax32 || cdSize >= kMax32) {
    const std::uint64_t eocd64 = offset_;
    u32(e, 0x06064b50);
    u64(e, 44);
    u16(e, 45);
    u16(e, 45);
    u32(e, 0);
    u32(e, 0);
    u64(e, count);
    u64(e, count);
    u64(e, cdSize);
    u64(e, cdOffset);
    u32(e, 0x07064b50);
    u32(e, 0);
    u64(e, eocd64);
    u32(e, 1);
  }
  u32(e, 0x06054b50);
  u16(e, 0);
  u16(e, 0);
  u16(e, std::min<std::uint64_t>(count, kMax16));
  u16(e, std::min<std::uint64_t>(count, kMax16));
  u32(e, std::min<std::uint64_t>(cdSize, kMax32));
  u32(e, std::min<std::uint64_t>(cdOffset, kMax32));
  u16(e, 0);
  write(e);
  out_.close();
  return !out_.fail();
}

}  // namespace premation::exporter
