// premation/protocol/frame_channel.hpp — the engine's second pipe: frame
// slots and the heartbeat.
//
// docs/VIEWPORT_ROUTE.md (C1) decided that pixels never travel over the command
// pipe: the engine renders into a ring of shared GPU textures and only announces
// "frame ready in slot N"; the host releases a slot when Chromium has finished
// with it; a full ring drops a frame and never blocks. Those messages, plus the
// supervisor's ping/pong, travel on a SEPARATE pipe pair (the child's fd 3 out,
// fd 4 in) so that a large query result never delays a frame announcement or a
// slot release, and a stalled document core is detectable (pong is answered by
// the core thread).
//
// The MESSAGES are schema types — packages/engine-api/schema/95_frames.eapi,
// family "FrameChannel", generated into engine_api.hpp as
// api::FrameChannelMessage { FrameSlots | FrameReady | FramePong | FrameRelease
// | FramePing } (Electron main uses the generated TypeScript twin,
// electron/generated/frameChannel.ts). This header only adds the channel's
// limits and payload helpers; nothing here is hand-encoded.
//
// Framing: the command pipe's 4-byte little-endian length (framing.hpp) + one
// encoded FrameChannelMessage.

#ifndef PREMATION_PROTOCOL_FRAME_CHANNEL_HPP
#define PREMATION_PROTOCOL_FRAME_CHANNEL_HPP

#include <cstdint>
#include <span>
#include <vector>

#include "engine_api.hpp"
#include "premation/protocol/wire.hpp"

namespace premation::frames {

using Message = api::FrameChannelMessage;

/// Largest frame-channel payload either side accepts (a FrameSlots with 16
/// handles is well under 200 bytes).
inline constexpr std::uint32_t kMaxPayload = 4096;
/// Most slots one ring announces (FrameSlots.handles).
inline constexpr std::uint32_t kMaxSlots = 16;

/// Encode one message's payload (without the length prefix) into `out` (replaced).
inline void encode(const Message& m, std::vector<std::uint8_t>& out) {
  wire::Writer w;
  api::encode(w, m);
  out = w.take();
}

/// Decode one payload. Never throws; `out` is only meaningful on Status::ok.
/// An unknown variant (a newer peer) is `unknown_variant` — callers skip it.
[[nodiscard]] inline wire::Status decode(std::span<const std::uint8_t> payload, Message& out) {
  wire::Reader r(payload);
  const wire::Status st = api::decode(r, out);
  if (st != wire::Status::ok) return st;
  if (const auto* s = std::get_if<api::FrameSlots>(&out.v); s != nullptr && s->handles.size() > kMaxSlots) {
    return wire::Status::bad_value;
  }
  return wire::Status::ok;
}

}  // namespace premation::frames

#endif  // PREMATION_PROTOCOL_FRAME_CHANNEL_HPP
