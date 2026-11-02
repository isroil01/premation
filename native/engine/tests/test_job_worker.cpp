// The long-lived job worker (jobs/job_worker.cpp) over a fake worker process
// (job_worker_fake.cpp, the real worker loop with fake works): one process
// serves many calls, a kill or a crash fails the call in flight and the next
// call starts a fresh process, a hang times out, a newer preview of the same
// key drops an older one still waiting, cooperative cancel (the worker stops
// its work and lives on; a work deaf to it is killed after the grace) and idle
// shutdown. No model.
#include <catch2/catch_test_macros.hpp>

#include <atomic>
#include <chrono>
#include <optional>
#include <string>
#include <thread>

#include "fail.hpp"
#include "job_worker.hpp"
#include "json.hpp"

using namespace premation;
using namespace std::chrono_literals;

namespace {

class TestControl final : public jobs::JobControl {
 public:
  [[nodiscard]] bool cancelled() const noexcept override { return cancel.load(); }
  void progress(double /*fraction*/, std::string message) override {
    lastMessage = std::move(message);
    ++progressCount;
  }
  std::atomic<bool> cancel{false};
  std::string lastMessage;
  int progressCount = 0;
};

jobs::JobWorker::Options fake(std::chrono::milliseconds idle = std::chrono::minutes(3)) {
  jobs::JobWorker::Options o;
  o.exe = PREMATION_JOB_WORKER_FAKE;
  o.idle = idle;
  return o;
}

double served(const std::optional<std::string>& out) {
  REQUIRE(out);
  const std::optional<js::Json> j = js::parse(*out);
  REQUIRE(j);
  return j->at("served").num();
}

template <class Pred>
bool eventually(Pred pred, std::chrono::milliseconds within = 5s) {
  const auto until = std::chrono::steady_clock::now() + within;
  while (std::chrono::steady_clock::now() < until) {
    if (pred()) return true;
    std::this_thread::sleep_for(10ms);
  }
  return pred();
}

}  // namespace

TEST_CASE("job worker: one process serves every call, progress is relayed", "[job_worker]") {
  jobs::JobWorker w(fake());
  TestControl c;
  CHECK(served(w.run("count", "{}", c)) == 1);
  CHECK(served(w.run("count", "{}", c)) == 2);
  const std::optional<std::string> echo = w.run("echo", R"({"a":1})", c);
  REQUIRE(echo);
  CHECK(js::parse(*echo)->at("a").num() == 1);
  CHECK(c.lastMessage == "half");
  CHECK(w.starts() == 1);
}

TEST_CASE("job worker: a work's error is the call's, the worker keeps running", "[job_worker]") {
  jobs::JobWorker w(fake());
  TestControl c;
  CHECK_THROWS_AS((void)w.run("nope", "{}", c), doc::EngineFail);
  CHECK(served(w.run("count", "{}", c)) == 1);
  CHECK(w.starts() == 1);
}

TEST_CASE("job worker: killed between calls, the next call starts a fresh one", "[job_worker]") {
  jobs::JobWorker w(fake());
  TestControl c;
  CHECK(served(w.run("count", "{}", c)) == 1);
  w.kill_for_test();
  REQUIRE(eventually([&] { return !w.alive(); }));
  CHECK(served(w.run("count", "{}", c)) == 1);  // a new process counts from one
  CHECK(w.starts() == 2);
}

TEST_CASE("job worker: a crash fails the call in flight with words; the next call works", "[job_worker]") {
  jobs::JobWorker w(fake());
  TestControl c;
  CHECK(served(w.run("count", "{}", c)) == 1);
  try {
    (void)w.run("crash", "{}", c);
    FAIL("a crash must fail the call");
  } catch (const doc::EngineFail& f) {
    CHECK(f.error.code == api::ErrorCode::internal);
    CHECK(f.error.message.find("ended without an answer") != std::string::npos);
    CHECK(f.error.message.find("next try starts it again") != std::string::npos);
  }
  CHECK(served(w.run("count", "{}", c)) == 1);
  CHECK(w.starts() == 2);
}

TEST_CASE("job worker: a hang times out, is killed, and the next call works", "[job_worker]") {
  jobs::JobWorker w(fake());
  TestControl c;
  jobs::WorkerCall quick;
  quick.timeout = 300ms;
  const auto t0 = std::chrono::steady_clock::now();
  try {
    (void)w.run("sleep", R"({"ms":5000})", c, quick);
    FAIL("a hang must time out");
  } catch (const doc::EngineFail& f) {
    CHECK(f.error.message.find("stopped answering") != std::string::npos);
  }
  CHECK(std::chrono::steady_clock::now() - t0 < 3s);
  CHECK(served(w.run("count", "{}", c)) == 1);
  CHECK(w.starts() == 2);
}

TEST_CASE("job worker: progress lines keep a long call alive past the timeout", "[job_worker]") {
  jobs::JobWorker w(fake());
  TestControl c;
  jobs::WorkerCall call;
  call.timeout = 400ms;
  const std::optional<std::string> out = w.run("tick", R"({"n":10})", c, call);  // 1 s of work, never 400 ms silent
  REQUIRE(out);
  CHECK(c.progressCount > 0);
  CHECK(w.starts() == 1);
}

TEST_CASE("job worker: a cancel reaches the work in flight, which stops; the worker survives", "[job_worker]") {
  jobs::JobWorker w(fake());
  TestControl c;
  jobs::WorkerCall call;
  call.killOnCancel = true;  // a walk: still no kill when the work honours the cancel
  REQUIRE(served(w.run("count", "{}", c)) == 1);
  std::optional<std::string> out{"unset"};
  const auto t0 = std::chrono::steady_clock::now();
  std::thread a([&] { out = w.run("sleep", R"({"ms":5000})", c, call); });
  std::this_thread::sleep_for(300ms);
  c.cancel = true;
  a.join();
  CHECK(std::chrono::steady_clock::now() - t0 < 2500ms);
  CHECK_FALSE(out);
  TestControl c2;
  CHECK(served(w.run("count", "{}", c2)) == 3);  // the same process: the sleep counted too
  CHECK(w.starts() == 1);
}

TEST_CASE("job worker: a cancelled hover (no killOnCancel) stops early too, model kept", "[job_worker]") {
  jobs::JobWorker w(fake());
  TestControl c;
  std::optional<std::string> out{"unset"};
  const auto t0 = std::chrono::steady_clock::now();
  std::thread a([&] { out = w.run("tick", R"({"n":30})", c); });  // 3 s of ticks
  std::this_thread::sleep_for(350ms);
  c.cancel = true;
  a.join();
  CHECK(std::chrono::steady_clock::now() - t0 < 2000ms);
  CHECK_FALSE(out);
  CHECK(w.alive());
  CHECK(w.starts() == 1);
}

TEST_CASE("job worker: killOnCancel kills a work that ignores its cancel after the grace", "[job_worker]") {
  jobs::JobWorker w(fake());
  TestControl c;
  jobs::WorkerCall call;
  call.killOnCancel = true;
  call.cancelGrace = 300ms;
  std::optional<std::string> out{"unset"};
  const auto t0 = std::chrono::steady_clock::now();
  std::thread a([&] { out = w.run("hang", R"({"ms":5000})", c, call); });
  std::this_thread::sleep_for(200ms);
  c.cancel = true;
  a.join();
  const auto took = std::chrono::steady_clock::now() - t0;
  CHECK(took >= 450ms);  // waited the grace
  CHECK(took < 2500ms);
  CHECK_FALSE(out);
  TestControl c2;
  CHECK(served(w.run("count", "{}", c2)) == 1);  // a fresh process
  CHECK(w.starts() == 2);
}


TEST_CASE("job worker: latest wins — a newer call of a key drops the older one still waiting", "[job_worker]") {
  jobs::JobWorker w(fake());
  TestControl c;
  REQUIRE(served(w.run("count", "{}", c)) == 1);  // started, so the timing below is the calls'
  jobs::WorkerCall keyed;
  keyed.supersedeKey = "objectMattePreview:layer_1";
  std::optional<std::string> busy;
  std::optional<std::string> older{"unset"};
  std::optional<std::string> newer;
  std::optional<std::string> other{"unset"};
  TestControl c1, c2, c3, c4;
  std::thread a([&] { busy = w.run("sleep", R"({"ms":600})", c1); });
  std::this_thread::sleep_for(150ms);
  std::thread b([&] { older = w.run("echo", R"({"n":1})", c2, keyed); });
  std::this_thread::sleep_for(100ms);
  std::thread d([&] { other = w.run("echo", R"({"n":9})", c4); });  // no key: never dropped
  std::this_thread::sleep_for(100ms);
  std::thread e([&] { newer = w.run("echo", R"({"n":2})", c3, keyed); });
  a.join();
  b.join();
  d.join();
  e.join();
  CHECK(busy);
  CHECK_FALSE(older);  // superseded while it waited
  REQUIRE(newer);
  CHECK(js::parse(*newer)->at("n").num() == 2);
  REQUIRE(other);
  CHECK(js::parse(*other)->at("n").num() == 9);
  CHECK(w.starts() == 1);
}

TEST_CASE("job worker: a generation claimed at submission is dropped once a newer one is claimed", "[job_worker]") {
  // The engine claims a preview's generation when the job is submitted (it may wait in the
  // JobRunner's queue before it reaches the worker): an older one then never runs.
  jobs::JobWorker w(fake());
  TestControl c;
  jobs::WorkerCall older;
  older.supersedeKey = "objectMattePreview:layer_2";
  older.generation = jobs::claim_generation(older.supersedeKey);
  jobs::WorkerCall newer = older;
  newer.generation = jobs::claim_generation(newer.supersedeKey);
  CHECK_FALSE(w.run("count", "{}", c, older));
  CHECK(w.starts() == 0);  // dropped before anything started
  CHECK(served(w.run("count", "{}", c, newer)) == 1);
}

TEST_CASE("job worker: a call cancelled while it waits returns at once", "[job_worker]") {
  jobs::JobWorker w(fake());
  TestControl c1, c2;
  std::optional<std::string> waiting{"unset"};
  std::thread a([&] { (void)w.run("sleep", R"({"ms":800})", c1); });
  std::this_thread::sleep_for(150ms);
  std::thread b([&] { waiting = w.run("count", "{}", c2); });
  std::this_thread::sleep_for(100ms);
  const auto t0 = std::chrono::steady_clock::now();
  c2.cancel = true;
  b.join();
  CHECK(std::chrono::steady_clock::now() - t0 < 400ms);
  CHECK_FALSE(waiting);
  a.join();
}

TEST_CASE("job worker: idle, the worker is shut down; the next call starts it again", "[job_worker]") {
  jobs::JobWorker w(fake(300ms));
  TestControl c;
  CHECK(served(w.run("count", "{}", c)) == 1);
  CHECK(w.alive());
  REQUIRE(eventually([&] { return !w.alive(); }, 4s));
  CHECK(served(w.run("count", "{}", c)) == 1);
  CHECK(w.starts() == 2);
}

TEST_CASE("job worker: the batch lane lets go of its models first", "[job_worker]") {
  CHECK(jobs::lane_idle(jobs::WorkerLane::interactive) == std::chrono::minutes(3));
  CHECK(jobs::lane_idle(jobs::WorkerLane::batch) == jobs::kBatchLaneIdle);
  CHECK(jobs::kBatchLaneIdle < jobs::lane_idle(jobs::WorkerLane::interactive));
}
