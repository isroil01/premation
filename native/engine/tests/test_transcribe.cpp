// The transcribe job's pure half (jobs/transcribe.hpp) against the TypeScript
// it replaces: speechAudio.ts (toMono, resampleLinear), aiProxy.ts (the
// multipart body, parseWhisperSegments / parseWhisperWords, codeForStatus),
// captionFormat.ts deoverlap.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <string>
#include <vector>

#include "transcribe.hpp"

namespace sp = premation::jobs::speech;

namespace {

std::vector<std::uint8_t> wav16(const std::vector<std::int16_t>& interleaved, int channels, int rate) {
  std::vector<std::uint8_t> out;
  const auto u32 = [&](std::uint32_t v) {
    for (int i = 0; i < 4; ++i) out.push_back(static_cast<std::uint8_t>(v >> (8 * i)));
  };
  const auto u16 = [&](std::uint32_t v) {
    out.push_back(static_cast<std::uint8_t>(v));
    out.push_back(static_cast<std::uint8_t>(v >> 8U));
  };
  const auto tag = [&](const char* t) { out.insert(out.end(), t, t + 4); };  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  const auto data = static_cast<std::uint32_t>(interleaved.size() * 2);
  tag("RIFF");
  u32(36 + data);
  tag("WAVE");
  tag("fmt ");
  u32(16);
  u16(1);
  u16(static_cast<std::uint32_t>(channels));
  u32(static_cast<std::uint32_t>(rate));
  u32(static_cast<std::uint32_t>(rate * channels * 2));
  u16(static_cast<std::uint32_t>(channels * 2));
  u16(16);
  tag("data");
  u32(data);
  for (const std::int16_t v : interleaved) u16(static_cast<std::uint16_t>(v));
  return out;
}

}  // namespace

TEST_CASE("speech: mono is the channel average", "[transcribe]") {
  const std::vector<float> m = sp::to_mono({{1.0F, 0.5F, -1.0F}, {0.0F, 0.5F, 1.0F}});
  REQUIRE(m.size() == 3);
  CHECK(m[0] == 0.5F);
  CHECK(m[1] == 0.5F);
  CHECK(m[2] == 0.0F);
  CHECK(sp::to_mono({}).empty());
}

TEST_CASE("speech: resampleLinear keeps the TS length and blend", "[transcribe]") {
  // 48 kHz → 16 kHz: floor(n / 3) samples, each the input at 3i.
  std::vector<float> in(10);
  for (std::size_t i = 0; i < in.size(); ++i) in[i] = static_cast<float>(i);
  const std::vector<float> out = sp::resample_linear(in, 48000, 16000);
  REQUIRE(out.size() == 3);
  CHECK(out[1] == 3.0F);
  CHECK(out[2] == 6.0F);
  // Upsampling 2×: the half-way samples blend, the last holds (no read past the end).
  const std::vector<float> up = sp::resample_linear({0.0F, 1.0F}, 8000, 16000);
  REQUIRE(up.size() == 4);
  CHECK(up[1] == 0.5F);
  CHECK(up[3] == 1.0F);
  CHECK(sp::resample_linear(in, 16000, 16000) == in);
}

TEST_CASE("speech: a 16-bit WAV reads back to the samples written", "[transcribe]") {
  const auto bytes = wav16({0, 32767, -32768, 16384}, 2, 48000);
  const auto pcm = sp::read_wav16(bytes);
  REQUIRE(pcm);
  CHECK(pcm->sampleRate == 48000);
  REQUIRE(pcm->channels.size() == 2);
  REQUIRE(pcm->channels[0].size() == 2);
  CHECK(pcm->channels[0][0] == 0.0F);
  CHECK(pcm->channels[1][0] == 1.0F);
  CHECK(pcm->channels[0][1] == -1.0F);
  CHECK(pcm->channels[1][1] == Catch::Approx(0.5).margin(1e-4));
  const std::vector<std::uint8_t> junk{1, 2, 3};
  CHECK_FALSE(sp::read_wav16(junk));
}

TEST_CASE("speech: the language hint is validated as aiProxy does", "[transcribe]") {
  CHECK(sp::valid_language("en"));
  CHECK(sp::valid_language("pt-BR"));
  CHECK_FALSE(sp::valid_language("EN"));
  CHECK_FALSE(sp::valid_language("e"));
  CHECK_FALSE(sp::valid_language("en\r\nx"));
  CHECK_FALSE(sp::valid_language("en-"));
}

TEST_CASE("speech: the multipart body names every field once, both granularities", "[transcribe]") {
  const std::vector<std::uint8_t> wav{'R', 'I', 'F', 'F'};
  const auto body = sp::multipart_body("BOUND", wav, "composition.wav", "en");
  const std::string s(body.begin(), body.end());
  CHECK(s.starts_with("--BOUND\r\nContent-Disposition: form-data; name=\"file\"; filename=\"composition.wav\"\r\nContent-Type: audio/wav\r\n\r\nRIFF\r\n"));
  CHECK(s.find("name=\"model\"\r\n\r\nwhisper-1\r\n") != std::string::npos);
  CHECK(s.find("name=\"response_format\"\r\n\r\nverbose_json\r\n") != std::string::npos);
  CHECK(s.find("\r\n\r\nsegment\r\n") != std::string::npos);
  CHECK(s.find("\r\n\r\nword\r\n") != std::string::npos);
  CHECK(s.find("name=\"language\"\r\n\r\nen\r\n") != std::string::npos);
  CHECK(s.ends_with("--BOUND--\r\n"));
  // A bad language or filename is not sent.
  const auto bad = sp::multipart_body("B", wav, "../x\".wav", "EN\r\n");
  const std::string b(bad.begin(), bad.end());
  CHECK(b.find("language") == std::string::npos);
  CHECK(b.find("filename=\"audio.wav\"") != std::string::npos);
}

TEST_CASE("speech: verbose_json segments and words, blanks dropped", "[transcribe]") {
  const auto t = sp::parse_whisper(R"({"language":"english","segments":[
      {"start":0,"end":1.5,"text":"  Hello there. "},{"start":1.5,"end":2,"text":"   "},{"start":"x","end":3,"text":"bad"},
      {"start":2,"end":3.25,"text":"General Kenobi."}],
    "words":[{"start":0,"end":0.4,"word":" Hello"},{"start":0.5,"end":0.3,"text":"there"},{"start":1,"end":2,"word":" "}]})");
  REQUIRE(t);
  REQUIRE(t->cues.size() == 2);
  CHECK(t->cues[0].text == "Hello there.");
  CHECK(t->cues[1].start == 2);
  REQUIRE(t->words.size() == 2);
  CHECK(t->words[0].text == "Hello");
  CHECK(t->words[1].end == 0.5);  // end clamped to start
  CHECK(t->language == "english");
  CHECK_FALSE(sp::parse_whisper(R"({"text":"no segments"})"));
  CHECK_FALSE(sp::parse_whisper("not json"));
}

TEST_CASE("speech: deoverlap trims to the next start and drops slivers", "[transcribe]") {
  const auto out = sp::deoverlap({{2.0, 3.0, "b"}, {0.0, 2.2, "a"}, {3.0, 3.01, "sliver"}, {3.01, 4.0, "c"}});
  REQUIRE(out.size() == 3);
  CHECK(out[0].text == "a");
  CHECK(out[0].end == 2.0);
  CHECK(out[1].text == "b");
  CHECK(out[2].text == "c");
}

TEST_CASE("speech: provider status codes and the summary", "[transcribe]") {
  CHECK(sp::code_for_status(401) == "auth");
  CHECK(sp::code_for_status(403) == "auth");
  CHECK(sp::code_for_status(429) == "rate_limit");
  CHECK(sp::code_for_status(503) == "overloaded");
  CHECK(sp::code_for_status(400) == "provider_error");
  sp::Transcript t;
  t.cues.push_back({1, 2.5, "Hi \"you\""});
  t.language = "en";
  CHECK(sp::summary_json(t) == R"({"cues":[{"start":1,"end":2.5,"text":"Hi \"you\""}],"words":[],"language":"en"})");
}
