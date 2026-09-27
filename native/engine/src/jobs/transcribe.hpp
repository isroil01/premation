// The pure half of the transcribe job (kind_transcribe.cpp): the mixdown made
// speech-sized (captions/speechAudio.ts), the provider request
// (electron/aiProxy.ts transcribeAudio) and its answer read back
// (parseWhisperSegments / parseWhisperWords, captionFormat.ts deoverlap).
#pragma once

#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace premation::jobs::speech {

/// speechAudio.ts SPEECH_SAMPLE_RATE.
inline constexpr int kSampleRate = 16000;
/// aiProxy.ts MAX_TRANSCRIBE_BYTES (the provider's upload limit).
inline constexpr std::size_t kMaxUploadBytes = 25U * 1024U * 1024U;
/// captionFormat.ts MIN_CUE_SECONDS.
inline constexpr double kMinCueSeconds = 1.0 / 30.0;
/// aiProxy.ts: the one endpoint and model (whisper-1 is the model that times segments).
inline constexpr std::string_view kOpenAiEndpoint = "https://api.openai.com/v1/audio/transcriptions";
inline constexpr std::string_view kModel = "whisper-1";

/// speechAudio.ts toMono: every channel averaged into one (Float32 storage).
[[nodiscard]] std::vector<float> to_mono(const std::vector<std::vector<float>>& channels);
/// speechAudio.ts resampleLinear (the same output length and blend).
[[nodiscard]] std::vector<float> resample_linear(const std::vector<float>& samples, double fromRate, double toRate);

struct Pcm {
  std::vector<std::vector<float>> channels;
  int sampleRate = 0;
};
/// A 16-bit PCM RIFF/WAVE (the export's audio.wav) back to float samples. nullopt when not one.
[[nodiscard]] std::optional<Pcm> read_wav16(std::span<const std::uint8_t> bytes);

/// A BCP-47-ish language hint as aiProxy.ts accepts it (/^[a-z]{2,8}(-[A-Za-z0-9]{2,8})?$/).
[[nodiscard]] bool valid_language(std::string_view lang);

/// The multipart/form-data body aiProxy.ts sends: file, model, response_format
/// verbose_json, both timestamp granularities, and the language when valid.
[[nodiscard]] std::vector<std::uint8_t> multipart_body(std::string_view boundary, std::span<const std::uint8_t> wav,
                                                       std::string_view filename, std::string_view language);

struct Span {
  double start = 0;
  double end = 0;
  std::string text;
};
struct Transcript {
  std::vector<Span> cues;
  std::vector<Span> words;
  std::string language;
};

/// A `verbose_json` answer: nullopt when it has no `segments` array (the
/// provider answered something else). Blank segments / words are dropped.
[[nodiscard]] std::optional<Transcript> parse_whisper(std::string_view json);

/// captionFormat.ts deoverlap: sorted by start, each cue ends by the next's
/// start, cues shorter than kMinCueSeconds dropped.
[[nodiscard]] std::vector<Span> deoverlap(std::vector<Span> cues);

/// aiProxy.ts codeForStatus: auth / rate_limit / overloaded / provider_error.
[[nodiscard]] std::string code_for_status(int status);

/// The job summary: {"cues":[{start,end,text}],"words":[…],"language":S}.
[[nodiscard]] std::string summary_json(const Transcript& t);

}  // namespace premation::jobs::speech
