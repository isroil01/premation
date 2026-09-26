// The byte-stream half of the protocol: length-prefixed framing, the frame
// channel codec and the route-A pixel header
// (native/protocol/include/premation/protocol/{framing,frame_channel,pixel_channel}.hpp).

#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <vector>

#include "premation/protocol/frame_channel.hpp"
#include "premation/protocol/framing.hpp"
#include "premation/protocol/pixel_channel.hpp"

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
  // The messages are schema types (95_frames.eapi); these are the generated codec.
  api::FrameSlots slots;
  slots.generation = 7;
  slots.viewport = 1;
  slots.width = 1920;
  slots.height = 1080;
  slots.shared = true;
  slots.handles = {0x1234, 0xFFFFFFFFFFFFULL, 42};
  api::FrameReady ready{3, 2, 1, 5, -9, 123456789012LL, 99, 1.5, 2.5, 640, 360};
  const std::vector<frames::Message> all = {
      frames::Message{.v = slots},
      frames::Message{.v = ready},
      frames::Message{.v = api::FramePong{77, 12, true, 3}},
      frames::Message{.v = api::FrameRelease{7, 2}},
      frames::Message{.v = api::FramePing{0xDEADBEEFULL}},
  };
  for (const auto& m : all) {
    std::vector<std::uint8_t> bytes;
    frames::encode(m, bytes);
    REQUIRE(bytes.size() <= frames::kMaxPayload);
    frames::Message back;
    REQUIRE(frames::decode(bytes, back) == wire::Status::ok);
    REQUIRE(back == m);
    for (std::size_t n = 0; n < bytes.size(); ++n) {
      frames::Message cut;
      const auto st = frames::decode(std::span<const std::uint8_t>(bytes.data(), n), cut);
      REQUIRE(st != wire::Status::ok);
    }
    // A newer peer may add fields: an unknown field (#30, varint) is skipped.
    bytes.push_back(0xF0);
    bytes.push_back(0x01);
    bytes.push_back(0x05);
    REQUIRE(frames::decode(bytes, back) == wire::Status::ok);
    REQUIRE(back == m);
  }
}

TEST_CASE("frame channel: unknown variants are reported, too many slots refused", "[frames]") {
  frames::Message m;
  // Variant #31 (a newer peer's message), empty body.
  const std::vector<std::uint8_t> unknown = {0xFA, 0x01, 0x00};
  REQUIRE(frames::decode(unknown, m) == wire::Status::unknown_variant);
  api::FrameSlots s;
  s.handles.assign(frames::kMaxSlots + 1, 4);
  std::vector<std::uint8_t> bytes;
  frames::encode(frames::Message{.v = s}, bytes);
  REQUIRE(frames::decode(bytes, m) == wire::Status::bad_value);
}
TEST_CASE("pixel channel: a header round-trips and pins its byte layout", "[pixels]") {
  pixels::Header h;
  h.generation = 7;
  h.slot = 2;
  h.width = 3;
  h.height = 2;
  h.bytesPerRow = 12;
  std::vector<std::uint8_t> payload(pixels::kHeaderBytes + pixels::pixel_bytes(h), 0xAB);
  pixels::encode_header(h, payload);
  // 'PXF1' little-endian, then generation 7 — the layout electron/pixelChannel.ts reads.
  REQUIRE(payload[0] == 'P');
  REQUIRE(payload[1] == 'X');
  REQUIRE(payload[2] == 'F');
  REQUIRE(payload[3] == '1');
  REQUIRE(payload[4] == 7);
  REQUIRE(payload[20] == 12);
  pixels::Header back;
  REQUIRE(pixels::decode_header(payload, back));
  CHECK(back.generation == 7);
  CHECK(back.slot == 2);
  CHECK(back.width == 3);
  CHECK(back.height == 2);
  CHECK(back.bytesPerRow == 12);
  CHECK(back.format == 0);
}

TEST_CASE("pixel channel: malformed payloads are refused", "[pixels]") {
  pixels::Header h;
  h.width = 4;
  h.height = 4;
  h.bytesPerRow = 16;
  std::vector<std::uint8_t> payload(pixels::kHeaderBytes + pixels::pixel_bytes(h));
  pixels::encode_header(h, payload);
  pixels::Header out;
  REQUIRE(pixels::decode_header(payload, out));
  std::vector<std::uint8_t> shortBody(payload.begin(), payload.end() - 1);
  CHECK_FALSE(pixels::decode_header(shortBody, out));
  std::vector<std::uint8_t> shortHeader(payload.begin(), payload.begin() + 16);
  CHECK_FALSE(pixels::decode_header(shortHeader, out));
  std::vector<std::uint8_t> badMagic = payload;
  badMagic[0] = 'Q';
  CHECK_FALSE(pixels::decode_header(badMagic, out));
  pixels::Header narrow = h;
  narrow.bytesPerRow = 8;  // rows narrower than width × 4
  std::vector<std::uint8_t> narrowRows(pixels::kHeaderBytes + pixels::pixel_bytes(narrow));
  pixels::encode_header(narrow, narrowRows);
  CHECK_FALSE(pixels::decode_header(narrowRows, out));
}
