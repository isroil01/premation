#include "core/aep/riff.hpp"

#include <algorithm>
#include <bit>
#include <cstring>

#include "fail.hpp"

namespace premation::doc::aep {

namespace {

/// Deeper than any real project; a cycle-free file cannot need more.
constexpr int kMaxDepth = 64;
/// A 500 MB project of nothing but empty chunks would still stop here.
constexpr std::size_t kMaxChunks = 4'000'000;

std::string ascii4(Bytes bytes, std::size_t at) {
  std::string s(4, ' ');
  for (std::size_t i = 0; i < 4; ++i) s[i] = static_cast<char>(bytes[at + i]);
  return s;
}

std::uint32_t be32(Bytes bytes, std::size_t at) {
  return (std::uint32_t{bytes[at]} << 24U) | (std::uint32_t{bytes[at + 1]} << 16U) | (std::uint32_t{bytes[at + 2]} << 8U) |
         std::uint32_t{bytes[at + 3]};
}

/// `btdk` is a list by shape but COS text by content: kept whole.
bool opaque_list_type(std::string_view t) { return t == "btdk"; }

void read_chunks(Bytes bytes, std::size_t start, std::size_t end, int depth, std::size_t& budget, std::vector<Chunk>& out) {
  std::size_t p = start;
  while (p + 8 <= end) {
    const std::string id = ascii4(bytes, p);
    const std::size_t size = be32(bytes, p + 4);
    const std::size_t bodyStart = p + 8;
    // A size past the parent's end: damaged, or not really RIFX. Clamp rather
    // than throw — everything read so far is still good.
    const std::size_t bodyEnd = std::min(bodyStart + size, end);
    if ((budget += 1) > kMaxChunks) {
      fail(api::ErrorCode::decode, "project has an implausible number of chunks — refusing to continue");
    }
    Chunk c;
    c.id = id;
    if ((id == "LIST" || id == "RIFX") && bodyEnd - bodyStart >= 4) {
      c.listType = ascii4(bytes, bodyStart);
      if (opaque_list_type(c.listType) || depth >= kMaxDepth) {
        c.hasBody = true;
        c.body = bytes.subspan(bodyStart + 4, bodyEnd - bodyStart - 4);
      } else {
        c.hasChildren = true;
        read_chunks(bytes, bodyStart + 4, bodyEnd, depth + 1, budget, c.children);
      }
    } else if (is_container_chunk_id(id) && depth < kMaxDepth) {
      c.hasChildren = true;
      read_chunks(bytes, bodyStart, bodyEnd, depth + 1, budget, c.children);
    } else {
      c.hasBody = true;
      c.body = bytes.subspan(bodyStart, bodyEnd - bodyStart);
    }
    out.push_back(std::move(c));
    // The pad byte is not counted in the declared size.
    const std::size_t next = bodyStart + size + (size & 1U);
    if (next <= p) break;  // cannot happen with size_t arithmetic on 32-bit sizes, but never loop
    p = next;
  }
}

/// Bytes of the UTF-8 sequence starting at `i`, 0 when it is not a valid one.
std::size_t utf8_seq(Bytes b, std::size_t i) {
  const unsigned c0 = b[i];
  if (c0 < 0x80) return 1;
  auto cont = [&](std::size_t k) { return i + k < b.size() && (b[i + k] & 0xC0U) == 0x80U; };
  if (c0 >= 0xC2 && c0 <= 0xDF) return cont(1) ? 2 : 0;
  if (c0 >= 0xE0 && c0 <= 0xEF) {
    if (!cont(1) || !cont(2)) return 0;
    const unsigned c1 = b[i + 1];
    if (c0 == 0xE0 && c1 < 0xA0) return 0;
    if (c0 == 0xED && c1 >= 0xA0) return 0;  // surrogates
    return 3;
  }
  if (c0 >= 0xF0 && c0 <= 0xF4) {
    if (!cont(1) || !cont(2) || !cont(3)) return 0;
    const unsigned c1 = b[i + 1];
    if (c0 == 0xF0 && c1 < 0x90) return 0;
    if (c0 == 0xF4 && c1 >= 0x90) return 0;
    return 4;
  }
  return 0;
}

}  // namespace

bool is_container_chunk_id(std::string_view id) noexcept {
  return id == "fnam" || id == "pdnm" || id == "RCom" || id == "tdsn" || id == "vfdn";
}

ChunkTree parse_rifx(Bytes bytes) {
  if (bytes.size() < 12) fail(api::ErrorCode::decode, "file is too short to be an After Effects project");
  const std::string magic = ascii4(bytes, 0);
  if (magic != "RIFX") {
    // `RIFF` is the little-endian cousin — a WAV or an AVI, not a project.
    const std::string hint = magic == "RIFF" ? " (this looks like a RIFF media file, not a project)" : "";
    std::string shown;
    for (const char ch : magic) shown.push_back(static_cast<unsigned char>(ch) >= 0x20 && static_cast<unsigned char>(ch) < 0x7F ? ch : '?');
    fail(api::ErrorCode::decode, "not an After Effects project: expected \"RIFX\", found \"" + shown + "\"" + hint);
  }
  const std::size_t declared = be32(bytes, 4);
  const std::string form = ascii4(bytes, 8);
  if (form != "Egg!") {
    std::string shown;
    for (const char ch : form) shown.push_back(static_cast<unsigned char>(ch) >= 0x20 && static_cast<unsigned char>(ch) < 0x7F ? ch : '?');
    fail(api::ErrorCode::decode, "not an After Effects project: unexpected form type \"" + shown + "\"");
  }
  // The declared size excludes the 8-byte header; AE appends an XMP packet
  // after the tree, which trusting the declaration keeps out.
  const std::size_t end = std::min(bytes.size(), 8 + declared);
  ChunkTree tree;
  tree.root.id = "RIFX";
  tree.root.listType = "Egg!";
  tree.root.hasChildren = true;
  std::size_t budget = 0;
  read_chunks(bytes, 12, end, 1, budget, tree.root.children);
  return tree;
}

const Chunk* find_chunk(const Chunk* parent, std::string_view id) noexcept {
  if (parent == nullptr) return nullptr;
  for (const Chunk& c : parent->children) {
    if (c.id == id) return &c;
  }
  return nullptr;
}

const Chunk* find_list(const Chunk* parent, std::string_view listType) noexcept {
  if (parent == nullptr || listType.empty()) return nullptr;
  for (const Chunk& c : parent->children) {
    if (c.listType == listType) return &c;
  }
  return nullptr;
}

std::vector<const Chunk*> find_lists(const Chunk* parent, std::string_view listType) {
  std::vector<const Chunk*> out;
  if (parent == nullptr || listType.empty()) return out;
  for (const Chunk& c : parent->children) {
    if (c.listType == listType) out.push_back(&c);
  }
  return out;
}

std::string decode_utf8(Bytes bytes) {
  std::string out;
  out.reserve(bytes.size());
  std::size_t i = 0;
  while (i < bytes.size()) {
    const std::size_t n = utf8_seq(bytes, i);
    if (n == 0) {
      out += "\xEF\xBF\xBD";
      ++i;
      continue;
    }
    for (std::size_t k = 0; k < n; ++k) out.push_back(static_cast<char>(bytes[i + k]));
    i += n;
  }
  return out;
}

std::string chunk_text(const Chunk* chunk) {
  if (chunk == nullptr || !chunk->hasBody || chunk->body.empty()) return {};
  const Bytes b = chunk->body;
  const auto nul = std::find(b.begin(), b.end(), std::uint8_t{0});
  return decode_utf8(b.first(static_cast<std::size_t>(nul - b.begin())));
}

std::uint32_t Reader::u8(std::size_t at) const noexcept { return has(at, 1) ? bytes_[at] : 0U; }
std::uint32_t Reader::u16(std::size_t at) const noexcept {
  return has(at, 2) ? (std::uint32_t{bytes_[at]} << 8U) | std::uint32_t{bytes_[at + 1]} : 0U;
}
std::uint32_t Reader::u32(std::size_t at) const noexcept { return has(at, 4) ? be32(bytes_, at) : 0U; }
std::int32_t Reader::i32(std::size_t at) const noexcept { return static_cast<std::int32_t>(u32(at)); }
double Reader::f32(std::size_t at) const noexcept {
  if (!has(at, 4)) return 0;
  return static_cast<double>(std::bit_cast<float>(be32(bytes_, at)));
}
double Reader::f64(std::size_t at, bool littleEndian) const noexcept {
  if (!has(at, 8)) return 0;
  std::uint64_t v = 0;
  for (std::size_t i = 0; i < 8; ++i) {
    const std::size_t k = littleEndian ? at + 7 - i : at + i;
    v = (v << 8U) | std::uint64_t{bytes_[k]};
  }
  return std::bit_cast<double>(v);
}
std::vector<double> Reader::f64s(std::size_t at, std::size_t count, bool littleEndian) const {
  std::vector<double> out;
  out.reserve(count);
  for (std::size_t i = 0; i < count; ++i) out.push_back(f64(at + i * 8, littleEndian));
  return out;
}
std::string Reader::str(std::size_t at, std::size_t size) const {
  if (!has(at, 1)) return {};
  const Bytes slice = bytes_.subspan(at, std::min(size, bytes_.size() - at));
  const auto nul = std::find(slice.begin(), slice.end(), std::uint8_t{0});
  return decode_utf8(slice.first(static_cast<std::size_t>(nul - slice.begin())));
}
std::string Reader::fourcc(std::size_t at) const { return has(at, 4) ? ascii4(bytes_, at) : std::string(); }

}  // namespace premation::doc::aep
