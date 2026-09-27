// Engine jobs through the Session (jobs/job_api.hpp, session_jobs.cpp):
// startJob / cancelJob / applyJobResult / getJobs, progress and finished
// events, the result applied as ONE undoable entry through commands, a
// failing apply changing nothing, a cancelled job applying nothing — with a
// fake job kind, so no decode is involved.

#include <catch2/catch_test_macros.hpp>

#include <atomic>
#include <chrono>
#include <thread>

#include "core/fail.hpp"
#include "invariants.hpp"
#include "jobs/job_runner.hpp"
#include "session_harness.hpp"

using namespace premation;
using namespace premation::test;

namespace {

constexpr api::Time kSec = 705'600'000;

/// Renames `layer` to `name` when applied; its work waits for `release` when `gated`.
class RenameResult final : public jobs::JobResult {
 public:
  RenameResult(std::string layer, std::string name) : layer_(std::move(layer)), name_(std::move(name)) {}
  [[nodiscard]] std::string summary_json() const override { return R"({"renamed":1})"; }
  [[nodiscard]] std::string label() const override { return "Fake Job"; }
  void apply(jobs::JobApply& a) const override {
    api::Command c;
    c.v = api::RenameLayer{layer_, name_};
    (void)a.run(c);
  }

 private:
  std::string layer_;
  std::string name_;
};

struct FakeKinds final : jobs::JobKinds {
  std::atomic<bool> release{true};
  std::atomic<int> started{0};
  jobs::PreparedJob prepare(const api::JobSpec& spec, const jobs::JobDocContext& ctx) override {
    const auto* s = std::get_if<api::SceneDetectJob>(&spec.v);
    if (s == nullptr) doc::fail(api::ErrorCode::unsupported, "fake: sceneDetect only");
    if (ctx.doc.node(s->layer) == nullptr) doc::fail(api::ErrorCode::not_found, "no layer '" + s->layer + "'");
    const std::string layer = s->layer;
    const bool split = s->split_layers;  // the fake's "fail on apply" switch: renames a layer that does not exist
    return jobs::PreparedJob{"sceneDetect", [this, layer, split](jobs::JobControl& control) -> std::unique_ptr<jobs::JobResult> {
                               ++started;
                               for (int i = 0; i < 2000 && !release.load(); ++i) {
                                 if (control.cancelled()) return nullptr;
                                 std::this_thread::sleep_for(std::chrono::milliseconds(1));
                               }
                               if (control.cancelled()) return nullptr;
                               control.progress(0.5, "halfway");
                               return std::make_unique<RenameResult>(split ? std::string("no_such_layer") : layer, "Tracked");
                             }};
  }
};

api::ItemId make_comp(Harness& h) {
  api::CreateComposition c;
  c.settings.name = "Test";
  c.settings.width = 640;
  c.settings.height = 360;
  c.settings.frame_rate = api::Rational{30, 1};
  c.settings.duration = 10 * kSec;
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  return result_item(r);
}

api::LayerId make_layer(Harness& h, const api::ItemId& comp) {
  api::CreateLayer c;
  c.comp = comp;
  c.kind = api::LayerKind::solid;
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  return result_layer(r);
}

api::StartJob start(const api::LayerId& layer, bool apply, bool failApply = false) {
  api::SceneDetectJob s;
  s.layer = layer;
  s.split_layers = failApply;
  api::StartJob j;
  j.job.v = s;
  j.apply = apply;
  return j;
}

api::JobInfo job_info(Harness& h, const std::string& id) {
  const auto r = h.ask(qry(api::GetJobs{}));
  REQUIRE(is_ok(r));
  const auto& list = std::get<api::JobList>(std::get<api::QueryResult>(r.outcome.v).v);
  for (const auto& j : list.jobs) {
    if (j.id == id) return j;
  }
  FAIL("no job " << id);
  return {};
}

/// Tick the session (real time passes for the worker) until the job is finished.
api::JobInfo wait_finished(Harness& h, const std::string& id) {
  for (int i = 0; i < 5000; ++i) {
    h.advance(std::chrono::milliseconds(60));
    const api::JobInfo j = job_info(h, id);
    const bool live = j.status == api::JobStatus::queued || j.status == api::JobStatus::running;
    const bool held = j.status == api::JobStatus::done && !j.applied && j.result.empty();
    if (!live && !held) return j;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  FAIL("job " << id << " did not finish");
  return {};
}

std::string layer_name(Harness& h, const api::LayerId& layer) {
  api::GetLayers q;
  q.layers = {layer};
  const auto r = h.ask(qry(q));
  REQUIRE(is_ok(r));
  return std::get<api::LayerDetails>(std::get<api::QueryResult>(r.outcome.v).v).layers.at(0).name;
}

std::size_t history_len(Harness& h) {
  const auto r = h.ask(qry(api::GetHistory{}));
  return std::get<api::HistoryState>(std::get<api::QueryResult>(r.outcome.v).v).entries.size();
}

template <class E>
std::vector<E> events_since(Harness& h, std::size_t mark) {
  std::vector<E> out;
  for (const auto& b : h.batches_since(mark)) {
    for (const auto& e : b.events) {
      if (const auto* x = std::get_if<E>(&e.v)) out.push_back(*x);
    }
  }
  return out;
}

}  // namespace

TEST_CASE("jobs: without job kinds startJob is unsupported", "[jobs]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  CHECK(is_error(h.run(cmd(start(layer, true))), api::ErrorCode::unsupported));
  CHECK(is_error(h.run(cmd(api::CancelJob{"job_1"})), api::ErrorCode::not_found));
}

TEST_CASE("jobs: a finished job's result is ONE undoable entry written through commands", "[jobs]") {
  FakeKinds kinds;  // before the harness: its runner's workers read `kinds` until the harness joins them
  Harness h;
  h.session.set_job_kinds(&kinds);
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  const std::string before = layer_name(h, layer);
  const std::size_t entries = history_len(h);
  const std::size_t mark = h.messages.size();
  const auto r = h.run(cmd(start(layer, true)));
  REQUIRE(is_ok(r));
  const std::string id = result_as<api::JobRef>(r).job;
  CHECK(id == "job_1");
  const api::JobInfo done = wait_finished(h, id);
  CHECK(done.status == api::JobStatus::done);
  CHECK(done.applied);
  CHECK(done.kind == "sceneDetect");
  CHECK(done.result == R"({"renamed":1})");
  CHECK(layer_name(h, layer) == "Tracked");
  CHECK(history_len(h) == entries + 1);
  CHECK_FALSE(events_since<api::JobProgressEvent>(h, mark).empty());
  const auto finished = events_since<api::JobFinishedEvent>(h, mark);
  REQUIRE_FALSE(finished.empty());
  CHECK(finished.back().job.status == api::JobStatus::done);
  CHECK_FALSE(finished.back().error.has_value());
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  CHECK(layer_name(h, layer) == before);
}

TEST_CASE("jobs: apply=false holds the result for applyJobResult", "[jobs]") {
  FakeKinds kinds;  // before the harness: its runner's workers read `kinds` until the harness joins them
  Harness h;
  h.session.set_job_kinds(&kinds);
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  const std::string id = result_as<api::JobRef>(h.run(cmd(start(layer, false)))).job;
  const api::JobInfo held = wait_finished(h, id);
  CHECK(held.status == api::JobStatus::done);
  CHECK_FALSE(held.applied);
  CHECK(layer_name(h, layer) != "Tracked");
  REQUIRE(is_ok(h.run(cmd(api::ApplyJobResult{id}))));
  CHECK(layer_name(h, layer) == "Tracked");
  CHECK(job_info(h, id).applied);
  // Once only.
  CHECK(is_error(h.run(cmd(api::ApplyJobResult{id})), api::ErrorCode::invalid_argument));
  CHECK(is_error(h.run(cmd(api::ApplyJobResult{"job_99"})), api::ErrorCode::not_found));
}

/// The LogRecords the session sent since message index `mark`.
static std::vector<api::LogRecord> log_records_since(Harness& h, std::size_t mark) {
  std::vector<api::LogRecord> out;
  for (std::size_t i = mark; i < h.messages.size(); ++i) {
    if (h.messages[i].kind() == api::EngineMessage::Kind::log_record) out.push_back(std::get<api::LogRecord>(h.messages[i].v));
  }
  return out;
}

static bool is_rename_batch(const api::LogRecord& rec, const std::string& name) {
  if (rec.request.body.kind() != api::RequestBody::Kind::batch) return false;
  const auto& b = std::get<api::CommandBatch>(rec.request.body.v);
  if (b.commands.size() != 1) return false;
  const auto* r = std::get_if<api::RenameLayer>(&b.commands.front().v);
  return r != nullptr && r->name == name;
}

TEST_CASE("jobs: an applied result is sent as a log record of its commands", "[jobs][log]") {
  Harness h;
  FakeKinds kinds;
  h.session.set_job_kinds(&kinds);
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  const std::size_t mark = h.messages.size();
  const std::string id = result_as<api::JobRef>(h.run(cmd(start(layer, true)))).job;
  (void)wait_finished(h, id);
  const auto recs = log_records_since(h, mark);
  REQUIRE(recs.size() == 1);
  CHECK(recs.front().job == id);
  CHECK(recs.front().request.origin == api::Origin::engine);
  CHECK(is_rename_batch(recs.front(), "Tracked"));
}

TEST_CASE("jobs: applyJobResult is logged as the job's commands", "[jobs][log]") {
  Harness h;
  FakeKinds kinds;
  h.session.set_job_kinds(&kinds);
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  const std::string id = result_as<api::JobRef>(h.run(cmd(start(layer, false)))).job;
  (void)wait_finished(h, id);
  const std::size_t mark = h.messages.size();
  REQUIRE(is_ok(h.run(cmd(api::ApplyJobResult{id}))));
  const auto recs = log_records_since(h, mark);
  REQUIRE(recs.size() == 1);
  CHECK(recs.front().job == id);
  CHECK(is_rename_batch(recs.front(), "Tracked"));
  // A failed apply (already applied) sends nothing.
  const std::size_t mark2 = h.messages.size();
  CHECK(is_error(h.run(cmd(api::ApplyJobResult{id})), api::ErrorCode::invalid_argument));
  CHECK(log_records_since(h, mark2).empty());
}

TEST_CASE("jobs: cancel stops a running job and nothing is applied", "[jobs]") {
  FakeKinds kinds;  // before the harness: its runner's workers read `kinds` until the harness joins them
  Harness h;
  kinds.release = false;
  h.session.set_job_kinds(&kinds);
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  const std::size_t entries = history_len(h);
  const std::string id = result_as<api::JobRef>(h.run(cmd(start(layer, true)))).job;
  for (int i = 0; i < 2000 && kinds.started.load() == 0; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(1));
  REQUIRE(is_ok(h.run(cmd(api::CancelJob{id}))));
  const api::JobInfo j = wait_finished(h, id);
  CHECK(j.status == api::JobStatus::cancelled);
  CHECK(history_len(h) == entries);
  CHECK(layer_name(h, layer) != "Tracked");
}

TEST_CASE("jobs: a result whose commands fail changes nothing and fails the job", "[jobs]") {
  FakeKinds kinds;  // before the harness: its runner's workers read `kinds` until the harness joins them
  Harness h;
  h.session.set_job_kinds(&kinds);
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  const DocState before = state_of(h.session.document());
  const std::size_t mark = h.messages.size();
  const std::string id = result_as<api::JobRef>(h.run(cmd(start(layer, true, true)))).job;
  const api::JobInfo j = wait_finished(h, id);
  CHECK(j.status == api::JobStatus::failed);
  CHECK(state_of(h.session.document()) == before);
  const auto finished = events_since<api::JobFinishedEvent>(h, mark);
  REQUIRE_FALSE(finished.empty());
  REQUIRE(finished.back().error.has_value());
  CHECK(finished.back().error->code == api::ErrorCode::not_found);
}

TEST_CASE("jobs: prepare refusals answer startJob and queue nothing; a new project drops jobs", "[jobs]") {
  FakeKinds kinds;  // before the harness: its runner's workers read `kinds` until the harness joins them
  Harness h;
  kinds.release = false;
  h.session.set_job_kinds(&kinds);
  (void)h.hello();
  CHECK(is_error(h.run(cmd(start("layer_missing", true))), api::ErrorCode::not_found));
  api::StartJob other;
  other.job.v = api::ProxyJob{};
  CHECK(is_error(h.run(cmd(other)), api::ErrorCode::unsupported));
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  (void)h.run(cmd(start(layer, true)));
  REQUIRE(is_ok(h.run(cmd(api::NewProject{}))));
  const auto r = h.ask(qry(api::GetJobs{}));
  CHECK(std::get<api::JobList>(std::get<api::QueryResult>(r.outcome.v).v).jobs.empty());
  kinds.release = true;
}

TEST_CASE("job runner: progress collapses to the latest, updates keep their order", "[jobs]") {
  jobs::JobRunner runner(1);
  std::atomic<bool> go{false};
  runner.submit("a", [&go](jobs::JobControl& c) -> std::unique_ptr<jobs::JobResult> {
    while (!go.load()) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    c.progress(0.25, "one");
    c.progress(0.75, "two");
    return std::make_unique<RenameResult>("l", "n");
  });
  go = true;
  std::vector<jobs::JobUpdate> all;
  for (int i = 0; i < 5000 && (all.empty() || all.back().kind != jobs::JobUpdate::Kind::finished); ++i) {
    for (auto& u : runner.drain()) all.push_back(std::move(u));
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  REQUIRE_FALSE(all.empty());
  CHECK(all.front().kind == jobs::JobUpdate::Kind::started);
  CHECK(all.back().kind == jobs::JobUpdate::Kind::finished);
  REQUIRE(all.back().result != nullptr);
  CHECK(runner.live() == 0);
}
