// premation/protocol/pixel_channel.hpp — the route-A pixel stream (fd 5).
//
// docs/VIEWPORT_ROUTE.md kept route A (frame copy) as the fallback for where
// shared textures do not work: Linux today, macOS without the host bridge, a
// failed import. Its pixels never travel on the command pipe or the frame
// channel — a 33 MB frame would queue every Release and Pong behind it — but on
// their own one-way pipe, the engine's fd 5 (engine → host), negotiated by the
// `frames.copy` Hello/Welcome capability.
//
// The slot protocol is unchanged: FrameSlots (shared = false) announces the
// ring, and for every copied frame the engine writes ONE pixel message here
// and then the usual FrameReady on fd 3. The two pipes are not ordered with
// respect to each other, so the host pairs them by (generation, slot) — a slot
// is not reused before the host's FrameRelease, so the pair is unambiguous.
// The slot stays the host's until it releases it, which is what bounds the
// memory in flight (at most one frame per slot).
//
// Framing: the command pipe's 4-byte little-endian length, then a fixed
// 32-byte little-endian header, then height × bytesPerRow bytes of RGBA8
// (unpremultiplied as drawn, top row first). Not a schema type: the payload is
// raw pixels, and a codec pass over 8–33 MB per frame would cost a copy.
//
//   offset  size  field
//        0     4  magic 'PXF1' (0x31465850 little-endian)
//        4     4  generation
//        8     4  slot
//       12     4  width
//       16     4  height
//       20     4  bytesPerRow (≥ width × 4)
//       24     4  format (0 = rgba8unorm, as FrameSlots.format)
//       28     4  reserved (0)
//
// The TypeScript twin is electron/pixelChannel.ts.

#ifndef PREMATION_PROTOCOL_PIXEL_CHANNEL_HPP
#define PREMATION_PROTOCOL_PIXEL_CHANNEL_HPP

#include <cstddef>
#include <cstdint>
#include <span>

namespace premation::pixels {

inline constexpr std::uint32_t kMagic = 0x31465850U;  // "PXF1"
inline constexpr std::size_t kHeaderBytes = 32;
/// Largest payload either side accepts: an 8K RGBA8 frame plus the header.
inline constexpr std::size_t kMaxPayload = kHeaderBytes + std::size_t{7680} * 4320 * 4;

struct Header {
  std::uint32_t generation = 0;
  std::uint32_t slot = 0;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::uint32_t bytesPerRow = 0;
  std::uint32_t format = 0;
};

namespace detail {
inline void put_u32(std::span<std::uint8_t> out, std::size_t at, std::uint32_t v) {
  out[at] = static_cast<std::uint8_t>(v & 0xFFU);
  out[at + 1] = static_cast<std::uint8_t>((v >> 8U) & 0xFFU);
  out[at + 2] = static_cast<std::uint8_t>((v >> 16U) & 0xFFU);
  out[at + 3] = static_cast<std::uint8_t>((v >> 24U) & 0xFFU);
}
inline std::uint32_t get_u32(std::span<const std::uint8_t> in, std::size_t at) {
  return std::uint32_t{in[at]} | (std::uint32_t{in[at + 1]} << 8U) | (std::uint32_t{in[at + 2]} << 16U) |
         (std::uint32_t{in[at + 3]} << 24U);
}
}  // namespace detail

/// Bytes of pixel data a header promises.
[[nodiscard]] inline std::size_t pixel_bytes(const Header& h) {
  return static_cast<std::size_t>(h.bytesPerRow) * static_cast<std::size_t>(h.height);
}

/// Write the 32-byte header into `out` (at least kHeaderBytes long).
inline void encode_header(const Header& h, std::span<std::uint8_t> out) {
  detail::put_u32(out, 0, kMagic);
  detail::put_u32(out, 4, h.generation);
  detail::put_u32(out, 8, h.slot);
  detail::put_u32(out, 12, h.width);
  detail::put_u32(out, 16, h.height);
  detail::put_u32(out, 20, h.bytesPerRow);
  detail::put_u32(out, 24, h.format);
  detail::put_u32(out, 28, 0);
}

/// Parse a whole payload (header + pixels). False when it is not a
/// well-formed pixel message: short, wrong magic, rows narrower than the
/// width, or a pixel count that does not match the bytes present.
[[nodiscard]] inline bool decode_header(std::span<const std::uint8_t> payload, Header& out) {
  if (payload.size() < kHeaderBytes || payload.size() > kMaxPayload) return false;
  if (detail::get_u32(payload, 0) != kMagic) return false;
  out.generation = detail::get_u32(payload, 4);
  out.slot = detail::get_u32(payload, 8);
  out.width = detail::get_u32(payload, 12);
  out.height = detail::get_u32(payload, 16);
  out.bytesPerRow = detail::get_u32(payload, 20);
  out.format = detail::get_u32(payload, 24);
  if (out.width == 0 || out.height == 0) return false;
  if (static_cast<std::uint64_t>(out.bytesPerRow) < static_cast<std::uint64_t>(out.width) * 4U) return false;
  return payload.size() - kHeaderBytes == pixel_bytes(out);
}

}  // namespace premation::pixels

#endif  // PREMATION_PROTOCOL_PIXEL_CHANNEL_HPP
