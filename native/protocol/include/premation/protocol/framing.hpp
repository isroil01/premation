// premation/protocol/framing.hpp — how EngineMessages travel on a byte stream.
//
// docs/ENGINE_API.md §9 / schema 10_envelope.eapi: on the engine pipe every
// EngineMessage is framed as a 4-byte little-endian length followed by the
// encoded message. This header is the stream half of that rule, shared by the
// engine process (native/engine) and its tests; electron/engineFraming.ts is
// the TypeScript twin.
//
// No exceptions, no allocation beyond the reassembly buffer. A length above
// the configured maximum is unrecoverable (the stream has lost its framing),
// so the decoder latches `Error::oversize` and yields nothing more.

#ifndef PREMATION_PROTOCOL_FRAMING_HPP
#define PREMATION_PROTOCOL_FRAMING_HPP

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <span>
#include <vector>

namespace premation::framing {

/// Largest frame either side accepts. A full 2,000-layer document with every
/// property and keyframe is ~3.6 MB (ENGINE_API.md §9.3); 64 MiB leaves an
/// order of magnitude of headroom and still refuses a garbage length before it
/// can become a multi-gigabyte allocation.
inline constexpr std::uint32_t kDefaultMaxFrame = 64U * 1024U * 1024U;

inline constexpr std::size_t kHeaderBytes = 4;

/// Append `payload` to `out` as one frame.
inline void append_frame(std::vector<std::uint8_t>& out, std::span<const std::uint8_t> payload) {
  const auto n = static_cast<std::uint32_t>(payload.size());
  out.push_back(static_cast<std::uint8_t>(n & 0xFFU));
  out.push_back(static_cast<std::uint8_t>((n >> 8U) & 0xFFU));
  out.push_back(static_cast<std::uint8_t>((n >> 16U) & 0xFFU));
  out.push_back(static_cast<std::uint8_t>((n >> 24U) & 0xFFU));
  out.insert(out.end(), payload.begin(), payload.end());
}

/// Incremental reassembly of frames from arbitrary chunks.
class Decoder {
 public:
  enum class Error : std::uint8_t { none = 0, oversize };

  explicit Decoder(std::uint32_t maxFrame = kDefaultMaxFrame) noexcept : max_(maxFrame) {}

  /// Feed bytes. Call `next` until it returns false after every feed.
  void feed(std::span<const std::uint8_t> bytes) {
    if (error_ != Error::none) return;
    compact();
    buf_.insert(buf_.end(), bytes.begin(), bytes.end());
  }

  /// The next complete frame's payload, valid until the next feed/next call.
  [[nodiscard]] bool next(std::span<const std::uint8_t>& payload) noexcept {
    if (error_ != Error::none) return false;
    const std::size_t avail = buf_.size() - head_;
    if (avail < kHeaderBytes) return false;
    const std::uint8_t* p = buf_.data() + head_;
    const std::uint32_t n = static_cast<std::uint32_t>(p[0]) | (static_cast<std::uint32_t>(p[1]) << 8U) |
                            (static_cast<std::uint32_t>(p[2]) << 16U) | (static_cast<std::uint32_t>(p[3]) << 24U);
    if (n > max_) {
      error_ = Error::oversize;
      return false;
    }
    if (avail - kHeaderBytes < n) return false;
    payload = std::span<const std::uint8_t>(p + kHeaderBytes, n);
    head_ += kHeaderBytes + n;
    return true;
  }

  [[nodiscard]] Error error() const noexcept { return error_; }
  /// Bytes received but not yet returned as a frame (a truncated tail at EOF).
  [[nodiscard]] std::size_t pending() const noexcept { return buf_.size() - head_; }

 private:
  void compact() {
    if (head_ == 0) return;
    const std::size_t rest = buf_.size() - head_;
    if (rest > 0) std::memmove(buf_.data(), buf_.data() + head_, rest);
    buf_.resize(rest);
    head_ = 0;
  }

  std::vector<std::uint8_t> buf_;
  std::size_t head_ = 0;
  std::uint32_t max_;
  Error error_ = Error::none;
};

}  // namespace premation::framing

#endif  // PREMATION_PROTOCOL_FRAMING_HPP
