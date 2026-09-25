// F1: the export's audio mix as the WAV the Chromium path stages
// (audioMixdown.ts `encodeWav`): RIFF/WAVE PCM, ≤ 2 channels, 16-bit,
// samples clamped to [−1, 1] and scaled by 0x8000 below zero, 0x7fff above,
// then truncated toward zero (DataView.setInt16's ToInt16) — byte for byte.
#pragma once

#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <vector>

namespace premation::exporter {

/// The WAV bytes. Pure; tested against encodeWav's arithmetic.
[[nodiscard]] inline std::vector<std::uint8_t> encode_wav16(const std::vector<std::vector<float>>& channels, int sampleRate) {
  const std::size_t nch = std::min<std::size_t>(2, channels.size());
  const std::size_t frames = nch == 0 ? 0 : channels[0].size();
  const std::uint32_t blockAlign = static_cast<std::uint32_t>(nch * 2);
  const auto dataSize = static_cast<std::uint32_t>(frames * blockAlign);
  std::vector<std::uint8_t> out;
  out.reserve(44 + dataSize);
  const auto str = [&](const char* s) {
    for (int i = 0; i < 4; ++i) out.push_back(static_cast<std::uint8_t>(s[i]));  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  };
  const auto u32 = [&](std::uint32_t v) {
    for (int i = 0; i < 4; ++i) out.push_back(static_cast<std::uint8_t>(v >> (8 * i)));
  };
  const auto u16 = [&](std::uint32_t v) {
    out.push_back(static_cast<std::uint8_t>(v));
    out.push_back(static_cast<std::uint8_t>(v >> 8U));
  };
  const auto rate = static_cast<std::uint32_t>(sampleRate);
  str("RIFF");
  u32(36 + dataSize);
  str("WAVE");
  str("fmt ");
  u32(16);
  u16(1);
  u16(static_cast<std::uint32_t>(nch));
  u32(rate);
  u32(rate * blockAlign);
  u16(blockAlign);
  u16(16);
  str("data");
  u32(dataSize);
  for (std::size_t i = 0; i < frames; ++i) {
    for (std::size_t c = 0; c < nch; ++c) {
      const float raw = i < channels[c].size() ? channels[c][i] : 0.0F;
      // Float32Array → double, then Math.max/min and the scale in double (JS numbers).
      const double s = std::max(-1.0, std::min(1.0, static_cast<double>(raw)));
      const double scaled = s < 0 ? s * 32768.0 : s * 32767.0;
      const auto v = static_cast<std::int16_t>(static_cast<std::int32_t>(scaled));  // ToInt16: truncate toward zero
      u16(static_cast<std::uint16_t>(v));
    }
  }
  return out;
}

inline bool write_wav16(const std::filesystem::path& p, const std::vector<std::vector<float>>& channels, int sampleRate) {
  const std::vector<std::uint8_t> bytes = encode_wav16(channels, sampleRate);
  std::ofstream out(p, std::ios::binary | std::ios::trunc);
  out.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  return static_cast<bool>(out);
}

}  // namespace premation::exporter
