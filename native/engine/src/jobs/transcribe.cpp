#include "transcribe.hpp"

#include <algorithm>
#include <cmath>
#include <string>

#include "job_inputs.hpp"
#include "json.hpp"

namespace premation::jobs::speech {

std::vector<float> to_mono(const std::vector<std::vector<float>>& channels) {
  if (channels.empty()) return {};
  const std::size_t n = channels.front().size();
  std::vector<float> out(n, 0.0F);
  for (const std::vector<float>& ch : channels) {
    for (std::size_t i = 0; i < n; ++i) {
      // Float32Array storage: each running sum is rounded to float, as the TS.
      out[i] = static_cast<float>(static_cast<double>(out[i]) + static_cast<double>(i < ch.size() ? ch[i] : 0.0F));
    }
  }
  if (channels.size() > 1) {
    const auto k = static_cast<double>(channels.size());
    for (float& v : out) v = static_cast<float>(static_cast<double>(v) / k);
  }
  return out;
}

std::vector<float> resample_linear(const std::vector<float>& samples, double fromRate, double toRate) {
  if (fromRate == toRate || samples.empty()) return samples;
  const double ratio = fromRate / toRate;
  const auto outLength = static_cast<std::size_t>(std::max(1.0, std::floor(static_cast<double>(samples.size()) / ratio)));
  std::vector<float> out(outLength);
  for (std::size_t i = 0; i < outLength; ++i) {
    const double position = static_cast<double>(i) * ratio;
    const double index = std::floor(position);
    const double frac = position - index;
    const auto k = static_cast<std::size_t>(index);
    const double a = k < samples.size() ? static_cast<double>(samples[k]) : 0.0;
    const double b = k + 1 < samples.size() ? static_cast<double>(samples[k + 1]) : a;
    out[i] = static_cast<float>(a + (b - a) * frac);
  }
  return out;
}

namespace {

std::uint32_t u32_at(std::span<const std::uint8_t> b, std::size_t at) {
  return static_cast<std::uint32_t>(b[at]) | (static_cast<std::uint32_t>(b[at + 1]) << 8U) |
         (static_cast<std::uint32_t>(b[at + 2]) << 16U) | (static_cast<std::uint32_t>(b[at + 3]) << 24U);
}
std::uint16_t u16_at(std::span<const std::uint8_t> b, std::size_t at) {
  return static_cast<std::uint16_t>(static_cast<std::uint32_t>(b[at]) | (static_cast<std::uint32_t>(b[at + 1]) << 8U));
}
bool tag_at(std::span<const std::uint8_t> b, std::size_t at, std::string_view tag) {
  if (at + 4 > b.size()) return false;
  for (std::size_t i = 0; i < 4; ++i) {
    if (b[at + i] != static_cast<std::uint8_t>(tag[i])) return false;
  }
  return true;
}

std::string trim(std::string_view s) {
  const auto ws = [](unsigned char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; };
  std::size_t a = 0;
  std::size_t b = s.size();
  while (a < b && ws(static_cast<unsigned char>(s[a]))) ++a;
  while (b > a && ws(static_cast<unsigned char>(s[b - 1]))) --b;
  return std::string(s.substr(a, b - a));
}

void append(std::vector<std::uint8_t>& out, std::string_view s) { out.insert(out.end(), s.begin(), s.end()); }

void field(std::vector<std::uint8_t>& out, std::string_view boundary, std::string_view name, std::string_view value) {
  append(out, "--");
  append(out, boundary);
  append(out, "\r\nContent-Disposition: form-data; name=\"");
  append(out, name);
  append(out, "\"\r\n\r\n");
  append(out, value);
  append(out, "\r\n");
}

bool safe_filename(std::string_view f) {
  if (f.empty() || f.size() > 128) return false;
  return std::all_of(f.begin(), f.end(), [](char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_';
  });
}

}  // namespace

std::optional<Pcm> read_wav16(std::span<const std::uint8_t> bytes) {
  if (bytes.size() < 12 || !tag_at(bytes, 0, "RIFF") || !tag_at(bytes, 8, "WAVE")) return std::nullopt;
  std::size_t at = 12;
  int channels = 0;
  int rate = 0;
  int bits = 0;
  while (at + 8 <= bytes.size()) {
    const std::uint32_t size = u32_at(bytes, at + 4);
    const std::size_t body = at + 8;
    if (body + size > bytes.size()) return std::nullopt;
    if (tag_at(bytes, at, "fmt ")) {
      if (size < 16 || u16_at(bytes, body) != 1) return std::nullopt;  // PCM only
      channels = u16_at(bytes, body + 2);
      rate = static_cast<int>(u32_at(bytes, body + 4));
      bits = u16_at(bytes, body + 14);
    } else if (tag_at(bytes, at, "data")) {
      if (channels <= 0 || rate <= 0 || bits != 16) return std::nullopt;
      const auto nch = static_cast<std::size_t>(channels);
      const std::size_t frames = size / (2 * nch);
      Pcm pcm;
      pcm.sampleRate = rate;
      pcm.channels.assign(nch, std::vector<float>(frames));
      for (std::size_t i = 0; i < frames; ++i) {
        for (std::size_t c = 0; c < nch; ++c) {
          const auto v = static_cast<std::int16_t>(u16_at(bytes, body + (i * nch + c) * 2));
          pcm.channels[c][i] = static_cast<float>(v < 0 ? v / 32768.0 : v / 32767.0);
        }
      }
      return pcm;
    }
    at = body + size + (size & 1U);
  }
  return std::nullopt;
}

bool valid_language(std::string_view lang) {
  const auto lower = [](char c) { return c >= 'a' && c <= 'z'; };
  const auto alnum = [](char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'); };
  const std::size_t dash = lang.find('-');
  const std::string_view head = lang.substr(0, dash);
  if (head.size() < 2 || head.size() > 8 || !std::all_of(head.begin(), head.end(), lower)) return false;
  if (dash == std::string_view::npos) return true;
  const std::string_view tail = lang.substr(dash + 1);
  return tail.size() >= 2 && tail.size() <= 8 && std::all_of(tail.begin(), tail.end(), alnum);
}

std::vector<std::uint8_t> multipart_body(std::string_view boundary, std::span<const std::uint8_t> wav, std::string_view filename,
                                         std::string_view language) {
  std::vector<std::uint8_t> out;
  out.reserve(wav.size() + 1024);
  append(out, "--");
  append(out, boundary);
  append(out, "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"");
  append(out, safe_filename(filename) ? filename : std::string_view("audio.wav"));
  append(out, "\"\r\nContent-Type: audio/wav\r\n\r\n");
  out.insert(out.end(), wav.begin(), wav.end());
  append(out, "\r\n");
  field(out, boundary, "model", kModel);
  field(out, boundary, "response_format", "verbose_json");
  // Both granularities: segments are the captions, words the transcript chips
  // (asking for `word` alone would return no segments at all).
  field(out, boundary, "timestamp_granularities[]", "segment");
  field(out, boundary, "timestamp_granularities[]", "word");
  if (!language.empty() && valid_language(language)) field(out, boundary, "language", language);
  append(out, "--");
  append(out, boundary);
  append(out, "--\r\n");
  return out;
}

std::optional<Transcript> parse_whisper(std::string_view text) {
  const std::optional<js::Json> j = js::parse(text);
  if (!j || !j->is_object() || !j->at("segments").is_array()) return std::nullopt;
  Transcript t;
  for (const js::Json& seg : j->at("segments").arr()) {
    if (!seg.at("start").is_number() || !seg.at("end").is_number() || !seg.at("text").is_string()) continue;
    std::string s = trim(seg.at("text").str());
    if (s.empty()) continue;
    t.cues.push_back(Span{seg.at("start").num(), seg.at("end").num(), std::move(s)});
  }
  if (j->at("words").is_array()) {
    for (const js::Json& w : j->at("words").arr()) {
      const js::Json& token = w.at("word").is_string() ? w.at("word") : w.at("text");
      if (!w.at("start").is_number() || !w.at("end").is_number() || !token.is_string()) continue;
      std::string s = trim(token.str());
      if (s.empty()) continue;
      const double start = w.at("start").num();
      t.words.push_back(Span{start, std::max(start, w.at("end").num()), std::move(s)});
    }
  }
  if (j->at("language").is_string()) t.language = j->at("language").str();
  return t;
}

std::vector<Span> deoverlap(std::vector<Span> cues) {
  std::stable_sort(cues.begin(), cues.end(), [](const Span& a, const Span& b) { return a.start < b.start; });
  std::vector<Span> out;
  for (std::size_t i = 0; i < cues.size(); ++i) {
    Span cue = cues[i];
    const double end = i + 1 < cues.size() ? std::min(cue.end, cues[i + 1].start) : cue.end;
    if (end - cue.start < kMinCueSeconds) continue;
    cue.end = end;
    out.push_back(std::move(cue));
  }
  return out;
}

std::string code_for_status(int status) {
  if (status == 401 || status == 403) return "auth";
  if (status == 429) return "rate_limit";
  if (status >= 500) return "overloaded";
  return "provider_error";
}

std::string summary_json(const Transcript& t) {
  const auto list = [](const std::vector<Span>& spans) {
    std::string s = "[";
    for (std::size_t i = 0; i < spans.size(); ++i) {
      if (i != 0) s += ",";
      s += "{\"start\":" + json_number(spans[i].start) + ",\"end\":" + json_number(spans[i].end) +
           ",\"text\":" + json_string(spans[i].text) + "}";
    }
    return s + "]";
  };
  std::string s = "{\"cues\":" + list(t.cues) + ",\"words\":" + list(t.words);
  if (!t.language.empty()) s += ",\"language\":" + json_string(t.language);
  return s + "}";
}

}  // namespace premation::jobs::speech
