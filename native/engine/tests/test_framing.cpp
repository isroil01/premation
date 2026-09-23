// The byte-stream half of the protocol: length-prefixed framing and the frame
// channel codec (native/protocol/include/premation/protocol/{framing,frame_channel}.hpp).

#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <vector>

#include "premation/protocol/frame_channel.hpp"
#include "premation/protocol/framing.hpp"

using namespace premation;

TEST_CASE("framing: frames survive any chunking", "[framing]") {
  std::vector<std::uint8_t> stream;
  const std::vector<std::vector<std::uint8_t>> payloads = {{}, {1}, {1, 2, 3}, std::vector<std::uint8_t>(300, 7)};
  for (const auto& p : payloads) framing::append_frame(stream, p);
  for (std::size_t chunk = 1; chunk <= stream.size(); ++chunk) {
    framing::Decoder d;
    std::vector<std::vector<std::uint8_t>> got;
    for (std::size_t i = 0; i < stream.size(); i += chunk) {
      const std::size_t n = std::min(chunk, stream.size() - i);
      d.feed(std::span<const std::uint8_t>(stream.data() + i, n));
      std::span<const std::uint8_t> out;
      while (d.next(out)) got.emplace_back(out.begin(), out.end());
    }
    REQUIRE(got == payloads);
    REQUIRE(d.pending() == 0);
  }
}

TEST_CASE("framing: an oversize length latches an error and yields nothing more", "[framing]") {
  framing::Decoder d(16);
  const std::vector<std::uint8_t> bad = {17, 0, 0, 0, 1, 2, 3};
  d.feed(bad);
  std::span<const std::uint8_t> out;
  REQUIRE_FALSE(d.next(out));
  REQUIRE(d.error() == framing::Decoder::Error::oversize);
  std::vector<std::uint8_t> good;
  framing::append_frame(good, std::vector<std::uint8_t>{1});
  d.feed(good);
  REQUIRE_FALSE(d.next(out));
}

TEST_CASE("frame channel: every message round-trips and every truncation is refused", "[frames]") {
  frames::Slots slots;
  slots.generation = 7;
  slots.viewport = 1;
  slots.width = 1920;
  slots.height = 1080;
  slots.shared = true;
  slots.handles = {0x1234, 0xFFFFFFFFFFFFULL, 42};
  frames::FrameReady ready{3, 2, 1, 5, -9, 123456789012LL, 99, 1.5, 2.5, 640, 360};
  const std::vector<frames::Message> all = {
      slots, ready, frames::Pong{77, 12, true, 3}, frames::Release{7, 2}, frames::Ping{0xDEADBEEFULL}};
  for (const auto& m : all) {
    std::vector<std::uint8_t> bytes;
    frames::encode(m, bytes);
    frames::Message back;
    REQUIRE(frames::decode(bytes, back) == frames::Status::ok);
    REQUIRE(back == m);
    for (std::size_t n = 0; n < bytes.size(); ++n) {
      frames::Message cut;
      const auto st = frames::decode(std::span<const std::uint8_t>(bytes.data(), n), cut);
      REQUIRE(st != frames::Status::ok);
    }
    // A newer peer may append fields: extra bytes are ignored.
    bytes.push_back(0xAB);
    REQUIRE(frames::decode(bytes, back) == frames::Status::ok);
    REQUIRE(back == m);
  }
}

TEST_CASE("frame channel: unknown types are skipped, bad values refused", "[frames]") {
  frames::Message m;
  const std::vector<std::uint8_t> unknown = {200, 1, 2};
  REQUIRE(frames::decode(unknown, m) == frames::Status::ok);
  REQUIRE(std::holds_alternative<frames::Unknown>(m));
  std::vector<std::uint8_t> slots;
  frames::encode(frames::Slots{}, slots);
  slots[18] = 2;  // [0] type, [1..16] four u32, [17] format, [18] shared (0/1), [19] count
  REQUIRE(frames::decode(slots, m) == frames::Status::bad_value);
  frames::encode(frames::Slots{}, slots);
  slots[19] = frames::kMaxSlots + 1;  // count
  REQUIRE(frames::decode(slots, m) == frames::Status::bad_value);
}
