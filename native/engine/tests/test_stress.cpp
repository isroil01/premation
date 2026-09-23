// Deterministic protocol stress (docs/NATIVE_CORE_PLAN.md §6: every protocol
// message type is fuzzed). Seeded random traffic — valid requests over the
// whole command set, corrupted and truncated messages, random frames, random
// stream chunking, clock jumps, bogus and real slot releases — into a Session.
// After every step: nothing crashed, every message the engine sent decodes,
// revisions never go backwards, and the document is structurally sound.
//
// PREMATION_STRESS_ITERATIONS overrides the step count (default 20,000; the
// sanitizer runs use more). The libFuzzer twin is fuzz_protocol.cpp.

#include <catch2/catch_test_macros.hpp>

#include <cstdlib>
#include <memory>

#include "invariants.hpp"
#include "random_requests.hpp"

using namespace premation;
using namespace premation::test;

namespace {

std::uint64_t iterations() {
  if (const char* env = std::getenv("PREMATION_STRESS_ITERATIONS")) {  // NOLINT(concurrency-mt-unsafe): test setup
    const auto n = std::strtoull(env, nullptr, 10);
    if (n > 0) return n;
  }
  return 20'000;
}

std::unique_ptr<Harness> fresh() {
  auto h = std::make_unique<Harness>(3);
  (void)h->hello();
  return h;
}

}  // namespace

TEST_CASE("stress: random and corrupted traffic never crashes or corrupts the document", "[stress]") {
  RandomTraffic rt(0xC2C2C2C2ULL);
  auto h = fresh();
  api::Revision lastRev = 0;
  std::uint64_t sessions = 1;
  std::uint64_t errors = 0;
  std::uint64_t frames = 0;
  const std::uint64_t n = iterations();
  for (std::uint64_t i = 0; i < n; ++i) {
    const auto dice = rt.u(100);
    if (dice < 60) {
      wire::Writer w;
      api::encode(w, rt.message(++h->seq));
      std::vector<std::uint8_t> bytes(w.bytes().begin(), w.bytes().end());
      if (rt.coin(0.25)) rt.mutate(bytes);
      h->session.on_frame(bytes, h->now);
    } else if (dice < 68) {
      std::vector<std::uint8_t> junk(rt.u(64));
      for (auto& b : junk) b = static_cast<std::uint8_t>(rt.u(256));
      h->session.on_frame(junk, h->now);
    } else if (dice < 78) {
      // Stream level: several framed messages, arbitrary chunking.
      std::vector<std::uint8_t> stream;
      const auto count = rt.u(4) + 1;
      for (std::uint64_t k = 0; k < count; ++k) {
        wire::Writer w;
        api::encode(w, rt.message(++h->seq));
        framing::append_frame(stream, w.bytes());
      }
      if (rt.coin(0.1)) rt.mutate(stream);
      framing::Decoder d(1U << 20U);
      std::size_t at = 0;
      while (at < stream.size()) {
        const std::size_t take = std::min<std::size_t>(stream.size() - at, rt.u(40) + 1);
        d.feed(std::span<const std::uint8_t>(stream.data() + at, take));
        at += take;
        std::span<const std::uint8_t> payload;
        while (d.next(payload)) h->session.on_frame(payload, h->now);
      }
    } else if (dice < 88) {
      h->advance(std::chrono::microseconds(rt.u(200'000)));
      if (rt.coin(0.7)) h->release_all();
    } else if (dice < 95) {
      std::vector<std::uint8_t> junk(rt.u(40));
      for (auto& b : junk) b = static_cast<std::uint8_t>(rt.u(256));
      frames::Message m;
      (void)frames::decode(junk, m);
      h->sink.release(static_cast<std::uint32_t>(rt.u(5)), static_cast<std::uint32_t>(rt.u(5)));
    } else {
      h->session.on_ping(rt.u(1000), 0);
    }

    REQUIRE(h->decodeFailures == 0);
    std::string why;
    if (!document_consistent(h->session.document(), why)) FAIL(why);
    REQUIRE(h->session.revision() >= lastRev);
    lastRev = h->session.revision();
    for (const auto& m : h->messages) {
      if (m.kind() == api::EngineMessage::Kind::response &&
          std::get<api::Response>(m.v).outcome.kind() == api::Outcome::Kind::error) {
        ++errors;
      }
    }
    frames += h->frames_ready().size();
    h->messages.clear();
    h->frameMsgs.clear();
    h->wireLog.clear();
    if (h->session.finished()) {  // a corrupted message decoded as Goodbye, or a protocol error
      h = fresh();
      lastRev = 0;
      ++sessions;
    }
  }
  INFO("sessions " << sessions << ", error responses " << errors << ", frames " << frames);
  REQUIRE(sessions >= 1);
  REQUIRE(errors > 0);  // the traffic really does reach the error paths
  REQUIRE(frames > 0);  // … and the render path
}
