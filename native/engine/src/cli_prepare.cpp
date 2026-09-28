#include "cli_prepare.hpp"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <utility>
#include <variant>
#include <vector>

#include "core/json.hpp"
#include "core/session.hpp"
#include "core/simulated_sink.hpp"
#include "os_ffi.hpp"
#include "premation/protocol/framing.hpp"

#if defined(PREMATION_HAVE_JOBS)
#include "jobs/child_job.hpp"
#include "jobs/job_kinds.hpp"
#include "jobs/media_input.hpp"
#endif

namespace premation::cli {
namespace {

using js::Json;
using Clock = Session::Clock;

constexpr int kOk = 0;
constexpr int kFailed = 1;
constexpr int kUsage = 64;

void emit(const Json& j) {
  const std::string line = js::stringify(j) + "\n";
  std::fwrite(line.data(), 1, line.size(), stdout);
  std::fflush(stdout);
}

int fail_with(const std::string& message) {
  Json j = Json::object();
  j.set("ev", Json::string("error"));
  j.set("message", Json::string(message));
  emit(j);
  return kFailed;
}

/// The Session's client, in process: every response captured by seq.
class Client final : public Outbox {
 public:
  explicit Client(SessionOptions options)
      : sink_([](const frames::Message&) {}, 3), session_(*this, sink_, std::move(options)) {}

  void send(const api::EngineMessage& m) override {
    if (const auto* r = std::get_if<api::Response>(&m.v)) responses_.push_back(*r);
  }
  void send_frames(const frames::Message&) override {}
  [[nodiscard]] std::size_t backlog_bytes() const override { return 0; }

  Session& session() noexcept { return session_; }

  void hello() {
    api::EngineMessage m;
    m.v = api::Hello{api::kProtocolMajor, api::kProtocolMinor, "premation-cli", "1", {}};
    session_.on_message(std::move(m), Clock::now());
    session_.tick(Clock::now());
  }

  api::Response submit(api::RequestBody body) {
    api::Request req;
    req.seq = ++seq_;
    req.body = std::move(body);
    api::EngineMessage m;
    m.v = std::move(req);
    session_.on_message(std::move(m), Clock::now());
    session_.tick(Clock::now());
    for (auto it = responses_.rbegin(); it != responses_.rend(); ++it) {
      if (it->seq == seq_) return *it;
    }
    api::Response none;
    api::EngineError e;
    e.message = "the engine did not answer";
    none.outcome.v = e;
    return none;
  }

  api::Response run(api::Command c) {
    api::RequestBody b;
    b.v = std::move(c);
    return submit(std::move(b));
  }
  api::Response ask(api::Query q) {
    api::RequestBody b;
    b.v = std::move(q);
    return submit(std::move(b));
  }

  void pump() { session_.tick(Clock::now()); }

 private:
  SimulatedSink sink_;
  Session session_;
  std::vector<api::Response> responses_;
  api::Seq seq_ = 0;
};

template <class T>
api::Command command(T x) {
  api::Command c;
  c.v = std::move(x);
  return c;
}
template <class T>
api::Query query(T x) {
  api::Query q;
  q.v = std::move(x);
  return q;
}

/// The error message of a failed response, or nullopt.
std::optional<std::string> error_of(const api::Response& r) {
  if (const auto* e = std::get_if<api::EngineError>(&r.outcome.v)) return e->message.empty() ? std::string("engine error") : e->message;
  return std::nullopt;
}

/// resolveComposition (export_job.cpp): id, exact name, case-insensitive name; none = the first non-pristine comp.
std::string resolve_comp(const doc::Document& d, const std::string& sel) {
  const auto lower = [](std::string s) {
    for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
  };
  if (!sel.empty()) {
    if (d.comp(sel) != nullptr) return sel;
    for (const auto& id : d.comps().keys()) {
      const Json* r = d.comp(id);
      if (r != nullptr && r->at("name").is_string() && r->at("name").str() == sel) return id;
    }
    const std::string l = lower(sel);
    for (const auto& id : d.comps().keys()) {
      const Json* r = d.comp(id);
      if (r != nullptr && r->at("name").is_string() && lower(r->at("name").str()) == l) return id;
    }
    return {};
  }
  for (const auto& id : d.comps().keys()) {
    const Json* r = d.comp(id);
    if (r != nullptr && !r->at("pristine").b()) return id;
  }
  return d.comps().empty() ? std::string() : d.comps().keys().front();
}

double num_or(const Json& o, std::string_view key, double fallback) {
  const Json& v = o.at(key);
  return v.is_number() && std::isfinite(v.num()) ? v.num() : fallback;
}

/// Run a job to its end (applied when `apply`); its JobInfo, or an error message.
std::variant<api::JobInfo, std::string> run_job(Client& c, api::StartJob start) {
  const api::Response started = c.run(command(std::move(start)));
  if (auto e = error_of(started)) return *e;
  std::string id;
  if (const auto* cr = std::get_if<api::CommandResult>(&started.outcome.v)) {
    std::visit([&](const auto& x) {
      if constexpr (std::is_same_v<std::decay_t<decltype(x)>, api::JobRef>) id = x.job;
    }, cr->v);
  }
  if (id.empty()) return std::string("the job did not start");
  for (;;) {
    std::this_thread::sleep_for(std::chrono::milliseconds(25));
    c.pump();
    const api::Response r = c.ask(query(api::GetJobs{}));
    if (auto e = error_of(r)) return *e;
    const auto* qr = std::get_if<api::QueryResult>(&r.outcome.v);
    const auto* list = qr != nullptr ? std::get_if<api::JobList>(&qr->v) : nullptr;
    if (list == nullptr) return std::string("getJobs answered something else");
    for (const api::JobInfo& j : list->jobs) {
      if (j.id != id) continue;
      const bool live = j.status == api::JobStatus::queued || j.status == api::JobStatus::running;
      const bool held = j.status == api::JobStatus::done && !j.applied && j.result.empty();
      if (live || held) break;
      if (j.status == api::JobStatus::done) return j;
      return j.message.empty() ? std::string(j.status == api::JobStatus::cancelled ? "the job was cancelled" : "the job failed") : j.message;
    }
  }
}

}  // namespace

int run_prepare(const std::string& jobPath) {
  std::optional<Json> job;
  {
    std::ifstream in(std::filesystem::path(std::u8string(jobPath.begin(), jobPath.end())), std::ios::binary);
    std::ostringstream ss;
    ss << in.rdbuf();
    job = in ? js::parse(ss.str()) : std::nullopt;
  }
  if (!job || !job->is_object() || !job->at("projectPath").is_string()) {
    (void)fail_with("the prepare job file could not be read");
    return kUsage;
  }
  const std::string projectPath = job->at("projectPath").str();

  SessionOptions options;
#if defined(PREMATION_HAVE_JOBS)
  options.mediaProbe = [](const std::string& path, js::Json& facts, std::string& error) {
    return jobs::probe_media(path, facts, error);
  };
  jobs::set_child_executable(os::executable_path());
  jobs::set_ffmpeg_executable(os::env_var("PREMATION_FFMPEG").value_or(""));
  jobs::register_child_works();
  const std::unique_ptr<jobs::JobKinds> kinds = jobs::make_job_kinds();
#endif
  Client c(std::move(options));
#if defined(PREMATION_HAVE_JOBS)
  c.session().set_job_kinds(kinds.get());
#endif
  c.hello();

  if (auto e = error_of(c.run(command(api::OpenProject{projectPath})))) return fail_with("Could not open the project: " + *e);
  const doc::Document& d = c.session().document();

  if (job->at("listComps").b()) {
    Json list = Json::array();
    for (const auto& id : d.comps().keys()) {
      const Json* r = d.comp(id);
      if (r == nullptr) continue;
      Json o = Json::object();
      o.set("id", Json::string(id));
      o.set("name", Json::string(r->at("name").is_string() ? r->at("name").str() : id));
      o.set("width", Json::number(num_or(*r, "width", 0)));
      o.set("height", Json::number(num_or(*r, "height", 0)));
      o.set("fps", Json::number(num_or(*r, "fps", 0)));
      o.set("durationSeconds", Json::number(num_or(*r, "durationSeconds", 0)));
      o.set("pristine", Json::boolean(r->at("pristine").b()));
      list.arr_mut().push_back(std::move(o));
    }
    Json j = Json::object();
    j.set("ev", Json::string("comps"));
    j.set("comps", std::move(list));
    emit(j);
  }

  const std::string selector = job->at("comp").is_string() ? job->at("comp").str() : std::string();
  std::string compId = resolve_comp(d, selector);
  const bool needsComp = job->at("reframe").is_object() || job->at("transcribe").is_object();
  if (needsComp && compId.empty()) {
    return fail_with(selector.empty() ? "This project has no compositions." : "Composition \"" + selector + "\" not found.");
  }

  if (job->at("transcribe").is_object()) {
    const Json& t = job->at("transcribe");
    api::TranscribeJob tj;
    tj.comp = compId;
    tj.language = t.at("language").is_string() ? t.at("language").str() : std::string();
    tj.provider = t.at("provider").is_string() ? t.at("provider").str() : std::string("openai");
    if (t.at("credential").is_string()) tj.credential = t.at("credential").str();
    api::StartJob sj;
    sj.job.v = std::move(tj);
    sj.apply = false;
    auto out = run_job(c, std::move(sj));
    if (auto* e = std::get_if<std::string>(&out)) return fail_with(*e);
    const std::optional<Json> summary = js::parse(std::get<api::JobInfo>(out).result);
    Json j = Json::object();
    j.set("ev", Json::string("cues"));
    j.set("cues", summary && summary->at("cues").is_array() ? summary->at("cues") : Json::array());
    const Json* rec = d.comp(compId);
    j.set("compName", Json::string(rec != nullptr && rec->at("name").is_string() ? rec->at("name").str() : compId));
    emit(j);
  }

  if (job->at("reframe").is_object()) {
    const double ratio = num_or(job->at("reframe"), "ratio", 0);
    if (!(ratio > 0)) return fail_with("reframe: the aspect ratio must be positive");
    const Json* rec = d.comp(compId);
    const double w = rec != nullptr ? num_or(*rec, "width", 1920) : 1920;
    const double h = rec != nullptr ? num_or(*rec, "height", 1080) : 1080;
    // autoReframe.ts targetSizeFor: the shorter edge is kept, even dimensions.
    const double shortEdge = std::min(w, h);
    double tw = ratio >= 1 ? std::round(shortEdge * ratio) : shortEdge;
    double th = ratio >= 1 ? shortEdge : std::round(shortEdge / ratio);
    tw -= std::fmod(tw, 2.0);
    th -= std::fmod(th, 2.0);
    api::AutoReframeJob rj;
    rj.comp = compId;
    rj.width = static_cast<std::uint32_t>(std::max(2.0, tw));
    rj.height = static_cast<std::uint32_t>(std::max(2.0, th));
    api::StartJob sj;
    sj.job.v = rj;
    sj.apply = true;
    auto out = run_job(c, std::move(sj));
    if (auto* e = std::get_if<std::string>(&out)) return fail_with("Auto-reframe failed: " + *e);
    const std::optional<Json> summary = js::parse(std::get<api::JobInfo>(out).result);
    if (!summary || !summary->at("comp").is_string()) return fail_with("Auto-reframe made no composition");
    compId = summary->at("comp").str();
    Json j = Json::object();
    j.set("ev", Json::string("reframed"));
    j.set("comp", Json::string(compId));
    j.set("width", Json::number(static_cast<double>(rj.width)));
    j.set("height", Json::number(static_cast<double>(rj.height)));
    emit(j);
  }

  if (job->at("saveTo").is_string()) {
    api::SaveProject save;
    save.path = job->at("saveTo").str();
    save.copy = true;
    if (auto e = error_of(c.run(command(std::move(save))))) return fail_with("Could not write the prepared project: " + *e);
    Json j = Json::object();
    j.set("ev", Json::string("saved"));
    j.set("path", Json::string(job->at("saveTo").str()));
    emit(j);
  }

  Json j = Json::object();
  j.set("ev", Json::string("done"));
  j.set("comp", Json::string(compId));
  emit(j);
  return kOk;
}

}  // namespace premation::cli
