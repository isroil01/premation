// libFuzzer entry point for the engine's protocol surface.
//
// Input layout: byte 0 selects how the rest is delivered —
//   even  as a raw command-pipe byte STREAM (length-prefixed frames, any split)
//   odd   as a sequence of [u16 length][payload] frames handed straight to
//         Session::on_frame (reaches the decoder with fewer wasted bytes)
// Every 8th frame also advances the synthetic clock by a data-dependent step
// and releases slots, so the transport/ring paths are reached. Half of the
// inputs start with a valid Hello, so the fuzzer explores the open session,
// not only the handshake. Trailing bytes are also fed to the frame-channel
// decoder. After each step the document invariants are checked and every
// message the engine sent must decode; a violation traps.
//
// Build: engine_fuzz (clang only; see CMakeLists). Run:
//   engine_fuzz -max_total_time=300 -max_len=4096 -rss_limit_mb=2048 corpus/

#include <csignal>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <cstdint>
#include <memory>
#include <string>

#include "invariants.hpp"
#include "session_harness.hpp"

using namespace premation;
using namespace premation::test;

namespace {

[[noreturn]] void violated() { __builtin_trap(); }

// std::terminate / abort() would end the process without libFuzzer saving the
// input (it does not catch SIGABRT on Windows): turn both into a trap it reports.
[[noreturn]] void on_terminate() { __builtin_trap(); }
extern "C" void on_abort(int /*sig*/) { __builtin_trap(); }
const bool kHandlers = [] {
  std::set_terminate(on_terminate);
  (void)std::signal(SIGABRT, on_abort);
  return true;
}();

void check(Harness& h) {
  if (h.decodeFailures != 0) violated();
  std::string why;
  if (!document_consistent(h.session.document(), why)) violated();
  h.messages.clear();
  h.frameMsgs.clear();
  h.wireLog.clear();
}

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, std::size_t size) {
  if (size == 0) return 0;
  // PREMATION_FUZZ_LAST=<file>: keep the input being run, for a death libFuzzer
  // cannot report (a process exit without a signal it handles).
  static const char* const last = std::getenv("PREMATION_FUZZ_LAST");  // NOLINT(concurrency-mt-unsafe): read once
  if (last != nullptr) {
    if (std::FILE* f = std::fopen(last, "wb")) {  // NOLINT(cppcoreguidelines-owning-memory): closed right below
      (void)std::fwrite(data, 1, size, f);
      (void)std::fclose(f);
    }
  }
  auto h = std::make_unique<Harness>(3);
  const std::uint8_t mode = data[0];
  if ((mode & 2U) == 0) (void)h->hello();
  const std::span<const std::uint8_t> rest(data + 1, size - 1);
  std::size_t steps = 0;
  auto after_frame = [&](std::uint8_t salt) {
    if ((++steps & 7U) == 0) {
      h->advance(std::chrono::microseconds(static_cast<std::int64_t>(salt) * 3000));
      if ((salt & 1U) != 0) h->release_all();
    }
    check(*h);
  };
  if ((mode & 1U) == 0) {
    framing::Decoder d(1U << 20U);
    d.feed(rest);
    std::span<const std::uint8_t> payload;
    while (d.next(payload)) {
      h->session.on_frame(payload, h->now);
      after_frame(payload.empty() ? 0 : payload[0]);
    }
  } else {
    std::size_t at = 0;
    while (at + 2 <= rest.size()) {
      const std::size_t len = static_cast<std::size_t>(rest[at]) | (static_cast<std::size_t>(rest[at + 1]) << 8U);
      at += 2;
      const std::size_t take = std::min(len, rest.size() - at);
      const auto payload = rest.subspan(at, take);
      at += take;
      h->session.on_frame(payload, h->now);
      after_frame(take > 0 ? payload[0] : 0);
    }
  }
  frames::Message m;
  (void)frames::decode(rest, m);
  h->session.on_disconnect();
  check(*h);
  return 0;
}
