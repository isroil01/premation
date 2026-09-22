// premation/protocol/wire.hpp — the byte-level half of the engine API codec.
//
// The generated codec (generated/engine_api.cpp) is a list of calls into
// Writer and Reader. The encoding is the protobuf wire format written
// canonically (docs/ENGINE_API.md §9), byte-identical to
// packages/engine-api/src/wire.ts. No exceptions cross this API: every read
// returns bool, every decode returns Status.

#ifndef PREMATION_PROTOCOL_WIRE_HPP
#define PREMATION_PROTOCOL_WIRE_HPP

#include <bit>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace premation::wire {

enum class Status : std::uint8_t {
  ok = 0,
  truncated,          ///< input ended inside a field
  malformed,          ///< bad wire type / overlong varint
  missing_field,      ///< a required field was absent
  unknown_variant,    ///< a union carried no variant this build knows (newer peer)
  multiple_variants,  ///< a union carried more than one variant
  bad_enum,           ///< an enum number this build does not know
  bad_value,          ///< out-of-range integer, bool > 1
  bad_type,           ///< roundtrip_by_name: unknown message type name
};

[[nodiscard]] constexpr std::string_view to_string(Status s) noexcept {
  switch (s) {
    case Status::ok: return "ok";
    case Status::truncated: return "truncated";
    case Status::malformed: return "malformed";
    case Status::missing_field: return "missing_field";
    case Status::unknown_variant: return "unknown_variant";
    case Status::multiple_variants: return "multiple_variants";
    case Status::bad_enum: return "bad_enum";
    case Status::bad_value: return "bad_value";
    case Status::bad_type: return "bad_type";
  }
  return "unknown";
}

inline constexpr std::uint32_t kWireVarint = 0;
inline constexpr std::uint32_t kWireFixed64 = 1;
inline constexpr std::uint32_t kWireLen = 2;
inline constexpr std::uint32_t kWireFixed32 = 5;

class Writer {
 public:
  Writer() { buf_.reserve(256); }

  void clear() noexcept { buf_.clear(); }
  [[nodiscard]] std::span<const std::uint8_t> bytes() const noexcept { return buf_; }
  [[nodiscard]] std::vector<std::uint8_t> take() noexcept { return std::move(buf_); }

  void byte(std::uint8_t b) { buf_.push_back(b); }

  void varint(std::uint64_t v) {
    while (v >= 0x80U) {
      buf_.push_back(static_cast<std::uint8_t>((v & 0x7FU) | 0x80U));
      v >>= 7U;
    }
    buf_.push_back(static_cast<std::uint8_t>(v));
  }

  void svarint(std::int64_t v) {
    // zigzag: (v << 1) ^ (v >> 63), done on the unsigned bit pattern (no signed-shift UB).
    const auto u = static_cast<std::uint64_t>(v);
    varint((u << 1U) ^ (v < 0 ? ~std::uint64_t{0} : std::uint64_t{0}));
  }

  void boolean(bool b) { buf_.push_back(b ? std::uint8_t{1} : std::uint8_t{0}); }

  void f32(float x) {
    const auto u = std::bit_cast<std::uint32_t>(x);
    for (unsigned i = 0; i < 4; ++i) buf_.push_back(static_cast<std::uint8_t>(u >> (8U * i)));
  }

  void f64(double x) {
    const auto u = std::bit_cast<std::uint64_t>(x);
    for (unsigned i = 0; i < 8; ++i) buf_.push_back(static_cast<std::uint8_t>(u >> (8U * i)));
  }

  void str(std::string_view s) {
    varint(s.size());
    buf_.insert(buf_.end(), s.begin(), s.end());
  }

  void bytes(std::span<const std::uint8_t> b) {
    varint(b.size());
    buf_.insert(buf_.end(), b.begin(), b.end());
  }

  /// Start a length-delimited body: reserve one length byte, return the body start.
  [[nodiscard]] std::size_t begin_ld() {
    buf_.push_back(0);
    return buf_.size();
  }

  /// Finish a body begun at `start`: write its length, widening (and shifting) past 127 bytes.
  void end_ld(std::size_t start) {
    const std::size_t len = buf_.size() - start;
    if (len < 0x80U) {
      buf_[start - 1] = static_cast<std::uint8_t>(len);
      return;
    }
    std::uint8_t tmp[10];
    std::size_t n = 0;
    std::size_t v = len;
    while (v >= 0x80U) {
      tmp[n++] = static_cast<std::uint8_t>((v & 0x7FU) | 0x80U);
      v >>= 7U;
    }
    tmp[n++] = static_cast<std::uint8_t>(v);
    const auto at = static_cast<std::ptrdiff_t>(start - 1);
    buf_.erase(buf_.begin() + at);
    buf_.insert(buf_.begin() + at, tmp, tmp + n);
  }

 private:
  std::vector<std::uint8_t> buf_;
};

class Reader {
 public:
  Reader() = default;
  explicit Reader(std::span<const std::uint8_t> b) noexcept : data_(b) {}

  [[nodiscard]] bool at_end() const noexcept { return pos_ >= data_.size(); }
  [[nodiscard]] std::size_t position() const noexcept { return pos_; }

  [[nodiscard]] bool varint(std::uint64_t& out) noexcept {
    std::uint64_t result = 0;
    for (unsigned shift = 0; shift < 70U; shift += 7U) {
      if (pos_ >= data_.size()) return false;
      const std::uint8_t b = data_[pos_++];
      if (shift == 63U && b > 1U) return false;  // would overflow 64 bits
      result |= static_cast<std::uint64_t>(b & 0x7FU) << shift;
      if (b < 0x80U) {
        out = result;
        return true;
      }
    }
    return false;
  }

  [[nodiscard]] bool svarint(std::int64_t& out) noexcept {
    std::uint64_t z = 0;
    if (!varint(z)) return false;
    out = static_cast<std::int64_t>((z >> 1U) ^ (~(z & 1U) + 1U));
    return true;
  }

  [[nodiscard]] bool u32(std::uint32_t& out) noexcept {
    std::uint64_t v = 0;
    if (!varint(v) || v > std::numeric_limits<std::uint32_t>::max()) return false;
    out = static_cast<std::uint32_t>(v);
    return true;
  }

  [[nodiscard]] bool i32(std::int32_t& out) noexcept {
    std::int64_t v = 0;
    if (!svarint(v) || v < std::numeric_limits<std::int32_t>::min() || v > std::numeric_limits<std::int32_t>::max()) return false;
    out = static_cast<std::int32_t>(v);
    return true;
  }

  [[nodiscard]] bool boolean(bool& out) noexcept {
    std::uint64_t v = 0;
    if (!varint(v) || v > 1U) return false;
    out = v == 1U;
    return true;
  }

  [[nodiscard]] bool f32(float& out) noexcept {
    if (data_.size() - pos_ < 4U || pos_ > data_.size()) return false;
    std::uint32_t u = 0;
    for (unsigned i = 0; i < 4; ++i) u |= static_cast<std::uint32_t>(data_[pos_ + i]) << (8U * i);
    pos_ += 4;
    out = std::bit_cast<float>(u);
    return true;
  }

  [[nodiscard]] bool f64(double& out) noexcept {
    if (data_.size() - pos_ < 8U || pos_ > data_.size()) return false;
    std::uint64_t u = 0;
    for (unsigned i = 0; i < 8; ++i) u |= static_cast<std::uint64_t>(data_[pos_ + i]) << (8U * i);
    pos_ += 8;
    out = std::bit_cast<double>(u);
    return true;
  }

  /// A sub-reader over the next length-delimited body; advances past it.
  [[nodiscard]] bool ld(Reader& sub) noexcept {
    std::uint64_t len = 0;
    if (!varint(len) || len > data_.size() - pos_) return false;
    const auto n = static_cast<std::size_t>(len);
    sub = Reader(data_.subspan(pos_, n));
    pos_ += n;
    return true;
  }

  [[nodiscard]] bool str(std::string& out) {
    Reader sub;
    if (!ld(sub)) return false;
    out.assign(reinterpret_cast<const char*>(sub.data_.data()), sub.data_.size());  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): bytes → chars
    return true;
  }

  [[nodiscard]] bool bytes(std::vector<std::uint8_t>& out) {
    Reader sub;
    if (!ld(sub)) return false;
    out.assign(sub.data_.begin(), sub.data_.end());
    return true;
  }

  /// Skip an unknown field (forward compatibility) given its full key.
  [[nodiscard]] bool skip(std::uint64_t key) noexcept {
    switch (static_cast<std::uint32_t>(key & 7U)) {
      case kWireVarint: {
        std::uint64_t v = 0;
        return varint(v);
      }
      case kWireFixed64:
        if (data_.size() - pos_ < 8U) return false;
        pos_ += 8;
        return true;
      case kWireLen: {
        Reader sub;
        return ld(sub);
      }
      case kWireFixed32:
        if (data_.size() - pos_ < 4U) return false;
        pos_ += 4;
        return true;
      default:
        return false;
    }
  }

 private:
  std::span<const std::uint8_t> data_;
  std::size_t pos_ = 0;
};

}  // namespace premation::wire

#endif  // PREMATION_PROTOCOL_WIRE_HPP
