// The replay corpus: every request the cross-engine test (crossEngine.test.ts)
// sent to the C++ engine, per session, as encoded EngineMessage{request}
// bytes — regenerated with
//   PREMATION_DUMP_REPLAY=native/engine/tests/data/replay_corpus.bin npx jest src/core/engine/__tests__/crossEngine.test.ts
// Format, little-endian: u32 session count; per session u32 request count;
// per request u32 byte length + the bytes.
#pragma once

#include <cstdint>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

namespace premation::test {

using ReplaySession = std::vector<std::vector<std::uint8_t>>;

#ifndef PREMATION_ENGINE_TEST_DATA
#define PREMATION_ENGINE_TEST_DATA "."
#endif

inline std::vector<ReplaySession> load_replay_corpus(const std::string& path = PREMATION_ENGINE_TEST_DATA "/replay_corpus.bin") {
  std::ifstream f(path, std::ios::binary);
  const std::vector<std::uint8_t> bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  std::size_t at = 0;
  auto u32 = [&](std::uint32_t& out) {
    if (at + 4 > bytes.size()) return false;
    out = static_cast<std::uint32_t>(bytes[at]) | (static_cast<std::uint32_t>(bytes[at + 1]) << 8U) |
          (static_cast<std::uint32_t>(bytes[at + 2]) << 16U) | (static_cast<std::uint32_t>(bytes[at + 3]) << 24U);
    at += 4;
    return true;
  };
  std::vector<ReplaySession> out;
  std::uint32_t sessions = 0;
  if (!u32(sessions)) return out;
  for (std::uint32_t s = 0; s < sessions; ++s) {
    std::uint32_t n = 0;
    if (!u32(n)) return {};
    ReplaySession session;
    for (std::uint32_t i = 0; i < n; ++i) {
      std::uint32_t len = 0;
      if (!u32(len) || at + len > bytes.size()) return {};
      session.emplace_back(bytes.begin() + static_cast<std::ptrdiff_t>(at), bytes.begin() + static_cast<std::ptrdiff_t>(at + len));
      at += len;
    }
    out.push_back(std::move(session));
  }
  return out;
}

}  // namespace premation::test
