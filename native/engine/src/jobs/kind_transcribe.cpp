// Job kind `transcribe` — captions/transcribe.ts transcribeCompositionDetailed
// + electron/aiProxy.ts transcribeAudio, in the engine.
//
// Owner decision (2026-09-28): the engine calls the user's speech provider
// with a key Electron MAIN hands over per job. Main holds the key (the OS
// keystore) and writes it into this job's `credential` as the startJob
// request passes through it (electron/engineHost.ts); the page never sees it.
// Here the key lives only in this job's closure until the one request is
// sent, and is never logged, persisted or put in a summary (the Session drops
// it from its own log: session.cpp).
//
// The work: the composition's sound over the range mixed by a child engine
// (`--export` audio-only: the export's offline mix — levels, trims, mutes),
// made 16 kHz mono, POSTed to OpenAI's whisper-1 (the one provider with timed
// segments), the answer read back into cues + words in composition seconds.
// Nothing is written to the document: the caption commands build layers from
// the summary.
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <memory>
#include <random>
#include <string>
#include <utility>
#include <vector>

#include "child_export.hpp"
#include "fail.hpp"
#include "http_post.hpp"
#include "job_inputs.hpp"
#include "job_kinds.hpp"
#include "model.hpp"
#include "transcribe.hpp"
#include "wav_write.hpp"

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;
namespace fs = std::filesystem;

namespace {

struct Request {
  std::string comp;
  std::string compName;
  double fps = 30;
  double startSec = 0;
  double endSec = 0;
  std::string language;
  std::string credential;
  std::string projectJson;
};

class TranscribeResult final : public JobResult {
 public:
  explicit TranscribeResult(speech::Transcript t) : t_(std::move(t)) {}
  [[nodiscard]] std::string summary_json() const override { return speech::summary_json(t_); }
  [[nodiscard]] std::string label() const override { return "Transcribe"; }
  [[nodiscard]] bool has_edits() const override { return false; }
  void apply(JobApply& /*a*/) const override {}

 private:
  speech::Transcript t_;
};

/// A transcription failure with aiProxy.ts's code in `detail` ({"code":…}).
[[noreturn]] void fail_code(ErrorCode code, const std::string& aiCode, std::string message) {
  fail(code, std::move(message), {.detail = "{\"code\":" + json_string(aiCode) + "}"});
}

/// The provider URL: OpenAI's, or a LOCAL test server named by
/// PREMATION_TRANSCRIBE_URL (http://127.0.0.1… / http://localhost… only, so
/// the variable cannot send a key anywhere else).
std::string endpoint() {
  const char* v = std::getenv("PREMATION_TRANSCRIBE_URL");  // NOLINT(concurrency-mt-unsafe): read-only, set before start
  if (v != nullptr) {
    const std::string s(v);
    if (s.starts_with("http://127.0.0.1:") || s.starts_with("http://localhost:")) return s;
  }
  return std::string(speech::kOpenAiEndpoint);
}

std::string boundary() {
  std::random_device rd;
  std::string b = "----premation";
  for (int i = 0; i < 4; ++i) b += std::to_string(rd());
  return b;
}

/// Overwrite then release a secret's bytes (best effort: the allocator may have copies from growth).
void wipe(std::string& s) {
  std::fill(s.begin(), s.end(), '\0');
  s.clear();
  s.shrink_to_fit();
}

std::unique_ptr<JobResult> run(Request req, JobControl& control) {
  // ── the mixdown ──
  TempTree tree("premation-transcribe");
  const fs::path project = tree.path / "project.motion";
  {
    std::ofstream f(project, std::ios::binary | std::ios::trunc);
    f << req.projectJson;
    if (!f) fail(ErrorCode::io, "cannot write the transcription snapshot");
  }
  req.projectJson.clear();
  const auto startFrame = static_cast<std::int64_t>(std::floor(req.startSec * req.fps + 1e-6));
  const auto endFrame = std::max(startFrame, static_cast<std::int64_t>(std::ceil(req.endSec * req.fps - 1e-6)) - 1);
  js::Json job = js::Json::object();
  job.set("projectPath", js::Json::string(project.string()));
  job.set("workDir", js::Json::string(tree.path.string()));
  job.set("comp", js::Json::string(req.comp));
  job.set("startFrame", js::Json::number(static_cast<double>(startFrame)));
  job.set("endFrame", js::Json::number(static_cast<double>(endFrame)));
  job.set("audioOnly", js::Json::boolean(true));
  job.set("buildThreads", js::Json::number(1));
  control.progress(0.02, "Mixing " + req.compName);
  const std::optional<js::Json> pre = run_child_export(job, tree.path, control, "Mixing " + req.compName, 0.02, 0.3);
  if (!pre) return nullptr;
  if (!pre->at("audio").is_string()) {
    fail_code(ErrorCode::invalid_argument, "silent",
              "This composition has no audible sound in that range — check the layers are unmuted and inside the work area.");
  }
  std::vector<std::uint8_t> wavIn;
  {
    std::ifstream f(fs::path(pre->at("audio").str()), std::ios::binary);
    wavIn.assign(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
  }
  const std::optional<speech::Pcm> pcm = speech::read_wav16(wavIn);
  if (!pcm || pcm->channels.empty() || pcm->channels.front().empty()) {
    fail_code(ErrorCode::invalid_argument, "silent",
              "This composition has no audible sound in that range — check the layers are unmuted and inside the work area.");
  }
  const std::vector<float> mono = speech::resample_linear(speech::to_mono(pcm->channels), pcm->sampleRate, speech::kSampleRate);
  const std::vector<std::uint8_t> wav = exporter::encode_wav16({mono}, speech::kSampleRate);
  if (wav.size() > speech::kMaxUploadBytes) {
    fail_code(ErrorCode::out_of_range, "bad_request",
              "That is " + std::to_string(static_cast<int>(std::lround(static_cast<double>(wav.size()) / (1024.0 * 1024.0)))) +
                  " MB of audio; the limit is 25 MB (about 13 minutes). Set a work area over the part you want captioned and try again.");
  }
  if (control.cancelled()) return nullptr;

  // ── the provider ──
  control.progress(0.35, "Transcribing");
  const std::string b = boundary();
  const std::vector<std::uint8_t> body = speech::multipart_body(b, wav, "composition.wav", req.language);
  HttpPost post;
  post.url = endpoint();
  post.headers.emplace_back("Authorization", "Bearer " + req.credential);
  post.headers.emplace_back("Content-Type", "multipart/form-data; boundary=" + b);
  post.body = body;
  wipe(req.credential);
  HttpResponse res;
  std::string httpError;
  const bool answered = http_post(post, res, httpError, [&control] { return control.cancelled(); });
  wipe(post.headers.front().second);
  if (control.cancelled()) return nullptr;
  if (!answered) {
    fail_code(ErrorCode::io, "network",
              http_available() ? "Could not reach OpenAI. Check your connection and try again." : httpError);
  }
  if (res.status < 200 || res.status >= 300) {
    const std::string text = res.body.substr(0, 400);
    fail_code(ErrorCode::io, speech::code_for_status(res.status),
              text.empty() ? "OpenAI refused the transcription (" + std::to_string(res.status) + ")." : text);
  }
  control.progress(0.95, "Reading the transcript");
  std::optional<speech::Transcript> t = speech::parse_whisper(res.body);
  if (!t) fail_code(ErrorCode::decode, "provider_error", "OpenAI returned a transcription with no timed segments.");
  if (t->cues.empty()) fail_code(ErrorCode::invalid_argument, "empty", "No speech was found in that audio.");
  // Times come back relative to the AUDIO, which started at the range start.
  const double base = static_cast<double>(startFrame) / req.fps;
  for (speech::Span& c : t->cues) {
    c.start += base;
    c.end += base;
  }
  for (speech::Span& w : t->words) {
    w.start += base;
    w.end += base;
  }
  t->cues = speech::deoverlap(std::move(t->cues));
  control.progress(1, "Done");
  return std::make_unique<TranscribeResult>(std::move(*t));
}

}  // namespace

PreparedJob prepare_transcribe(const api::TranscribeJob& spec, const JobDocContext& ctx) {
  if (spec.create_captions) {
    fail(ErrorCode::invalid_argument, "the transcribe job returns the transcript; caption layers are made from it by the caption commands");
  }
  const std::string provider = spec.provider.empty() ? std::string("openai") : spec.provider;
  if (provider != "openai") {
    fail_code(ErrorCode::invalid_argument, "unsupported",
              provider == "anthropic"
                  ? "Anthropic has no speech-to-text API. Connect an OpenAI key in Settings → Assistant to generate captions."
                  : "Gemini returns transcripts without timings, which cannot become captions. "
                    "Connect an OpenAI key in Settings → Assistant to generate captions.");
  }
  if (!spec.credential || spec.credential->empty()) {
    fail_code(ErrorCode::invalid_argument, "no_key", "No OpenAI API key is connected. Add one in Settings → Assistant.");
  }
  if (!spec.comp || spec.comp->empty()) {
    fail(ErrorCode::invalid_argument, "transcribe takes a composition (`comp`); a single layer's sound is not isolated yet");
  }
  const doc::Json* rec = ctx.doc.comp(*spec.comp);
  if (rec == nullptr) fail(ErrorCode::not_found, "There is no composition to transcribe.", {.item = *spec.comp});
  if (!spec.language.empty() && !speech::valid_language(spec.language)) {
    fail(ErrorCode::invalid_argument, "'" + spec.language + "' is not a language code");
  }
  Request req;
  req.comp = *spec.comp;
  req.compName = rec->at("name").is_string() ? rec->at("name").str() : *spec.comp;
  req.fps = rec->at("fps").is_number() && rec->at("fps").num() > 0 ? rec->at("fps").num() : 30;
  const double duration = rec->at("durationSeconds").is_number() ? rec->at("durationSeconds").num() : 0;
  req.startSec = 0;
  req.endSec = duration;
  if (spec.range) {
    req.startSec = seconds_of(spec.range->start);
    req.endSec = req.startSec + seconds_of(spec.range->duration);
  }
  if (!(req.endSec > req.startSec)) {
    fail_code(ErrorCode::invalid_argument, "bad_request", "That time range is empty, so there is no audio in it.");
  }
  req.language = spec.language;
  req.credential = *spec.credential;
  req.projectJson = snapshot_project_json(ctx.doc, ctx.bundleRoot);
  return PreparedJob{"transcribe", [req = std::move(req)](JobControl& control) mutable -> std::unique_ptr<JobResult> {
                       return run(std::move(req), control);
                     }};
}

}  // namespace premation::jobs
