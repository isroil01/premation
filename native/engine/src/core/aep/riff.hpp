// RIFX — the container an After Effects project is written in (src/core/aep/riff.ts).
//
// An `.aep` is a big-endian RIFF file: `RIFX`, a u32 body size, the form type
// `Egg!`, then a tree of chunks. Every chunk is a 4-char id, a u32 big-endian
// body size, the body, and a pad byte when that size is odd. A `LIST` carries
// a 4-char list type at the front of its body and child chunks after it.
//
// This is ONLY the container: it does not know what `cdta` or `ldta` mean
// (aep_read.cpp does). The same tree also comes from the XML form (aepx.cpp).
//
// Bodies are views: a leaf's `body` points into the bytes the tree was parsed
// from (a RIFX file) or into the tree's own storage (an `.aepx`, whose bodies
// are decoded from hex). A `ChunkTree` must outlive every span taken from it,
// and a tree parsed from a RIFX buffer must not outlive that buffer.
//
// A malformed file fails, it never hangs: sizes are checked against the
// remaining bytes at every step, recursion is depth-capped, the chunk count is
// capped. The failure is an EngineFail with code `decode`.
#pragma once

#include <cstdint>
#include <deque>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace premation::doc::aep {

using Bytes = std::span<const std::uint8_t>;

struct Chunk {
  /// The 4-character id — `LIST` for containers, else e.g. `ldta`.
  std::string id;
  /// For `LIST`/`RIFX`: the 4-character list type (`Fold`, `Layr`, `Egg!`, …); empty otherwise.
  std::string listType;
  /// Leaf payload (a view — see the file comment). Meaningful when `hasBody`.
  Bytes body;
  bool hasBody = false;
  /// Child chunks, for lists that were descended into (and the wrapper chunks).
  std::vector<Chunk> children;
  bool hasChildren = false;
};

/// A parsed tree plus whatever storage its bodies point into.
struct ChunkTree {
  ChunkTree() = default;
  // Bodies point into `storage`: a copy would point into the original's.
  ChunkTree(const ChunkTree&) = delete;
  ChunkTree& operator=(const ChunkTree&) = delete;
  ChunkTree(ChunkTree&&) = default;  // a deque's elements keep their addresses when it moves
  ChunkTree& operator=(ChunkTree&&) = default;
  ~ChunkTree() = default;

  Chunk root;
  /// Decoded bodies (the `.aepx` hex, `<string>` text). A deque: elements never move.
  std::deque<std::vector<std::uint8_t>> storage;
};

/// Chunks that hold children WITHOUT being a `LIST` (an effect's `fnam`, a property's `tdsn`, …).
[[nodiscard]] bool is_container_chunk_id(std::string_view id) noexcept;

/// `parseRifx`: the root as `RIFX` / `Egg!`. Views `bytes` (keep it alive). Throws EngineFail(decode).
[[nodiscard]] ChunkTree parse_rifx(Bytes bytes);

// ── Tree navigation ─────────────────────────────────────────────────────

[[nodiscard]] const Chunk* find_chunk(const Chunk* parent, std::string_view id) noexcept;
[[nodiscard]] const Chunk* find_list(const Chunk* parent, std::string_view listType) noexcept;
[[nodiscard]] std::vector<const Chunk*> find_lists(const Chunk* parent, std::string_view listType);

// ── Body readers ────────────────────────────────────────────────────────

/// `decodeUtf8` (TextDecoder, non-fatal): the bytes as valid UTF-8, bad sequences → U+FFFD.
[[nodiscard]] std::string decode_utf8(Bytes bytes);
/// `chunkText`: the body as UTF-8 text, stopping at the first NUL ('' for none).
[[nodiscard]] std::string chunk_text(const Chunk* chunk);

/// A cursor over a chunk body: named big-endian fields; 0 past the end of a short body.
class Reader {
 public:
  explicit Reader(Bytes bytes) noexcept : bytes_(bytes) {}
  [[nodiscard]] std::size_t length() const noexcept { return bytes_.size(); }
  [[nodiscard]] bool has(std::size_t at, std::size_t size) const noexcept { return at + size <= bytes_.size() && at + size >= at; }
  [[nodiscard]] std::uint32_t u8(std::size_t at) const noexcept;
  [[nodiscard]] std::uint32_t u16(std::size_t at) const noexcept;
  [[nodiscard]] std::uint32_t u32(std::size_t at) const noexcept;
  [[nodiscard]] std::int32_t i32(std::size_t at) const noexcept;
  [[nodiscard]] double f32(std::size_t at) const noexcept;
  [[nodiscard]] double f64(std::size_t at, bool littleEndian = false) const noexcept;
  /// Bit `bit` of the byte at `at` (bit 0 = least significant).
  [[nodiscard]] bool bit(std::size_t at, unsigned bit) const noexcept { return ((u8(at) >> bit) & 1U) != 0; }
  [[nodiscard]] std::vector<double> f64s(std::size_t at, std::size_t count, bool littleEndian = false) const;
  /// A NUL-terminated UTF-8 string occupying `size` bytes from `at`.
  [[nodiscard]] std::string str(std::size_t at, std::size_t size) const;
  /// Four raw bytes as characters (a nested FourCC); '' past the end.
  [[nodiscard]] std::string fourcc(std::size_t at) const;

 private:
  Bytes bytes_;
};

/// A Reader over a chunk's body, or over nothing when the chunk is absent.
[[nodiscard]] inline Reader reader_for(const Chunk* chunk) noexcept {
  return Reader(chunk != nullptr && chunk->hasBody ? chunk->body : Bytes{});
}

/// AE's `dividend / divisor` rationals; a zero divisor reads as 0 (never Infinity).
[[nodiscard]] inline double ratio(double dividend, double divisor) noexcept { return divisor == 0 ? 0 : dividend / divisor; }

}  // namespace premation::doc::aep
