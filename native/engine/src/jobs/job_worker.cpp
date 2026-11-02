#include "job_worker.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <utility>

#include "child_process.hpp"
#include "fail.hpp"
#include "json.hpp"
#include "log.hpp"
#include "os_ffi.hpp"

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;
using js::Json;

/// One worker process and what its reader thread learnt.
struct JobWorker::Proc {
  std::unique_ptr<exporter::ChildProcess> child;
  std::thread reader;
  std::filesystem::path startFile;
  std::string logPath;
  std::optional<std::string> plugins;
  /// The stream ended (exit, crash or kill).
  bool dead = false;
  /// The request in flight (0 = none) and its answer so far.
  std::uint64_t inflight = 0;
  bool answered = false;
  std::optional<std::string> result;
  std::optional<api::EngineError> error;
  bool hasProgress = false;
  double fraction = 0;
  std::string message;
};

namespace {

std::filesystem::path worker_start_file() {
  static std::atomic<std::uint64_t> seq{0};
  const auto dir = std::filesystem::temp_directory_path() / "premation-jobs";
  std::error_code ec;
  std::filesystem::create_directories(dir, ec);
  const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
  return dir / ("worker-" + std::to_string(stamp) + "-" + std::to_string(++seq) + ".json");
}

}  // namespace

JobWorker::JobWorker(Options o) : opt_(std::move(o)), lastUse_(std::chrono::steady_clock::now()) {
  idler_ = std::thread([this] { idle_loop(); });
}

JobWorker::~JobWorker() {
  std::unique_ptr<Proc> p;
  {
    const std::lock_guard<std::mutex> lock(mu_);
    stopping_ = true;
    p = std::move(proc_);
  }
  cv_.notify_all();
  if (idler_.joinable()) idler_.join();
  if (p) stop_proc(std::move(p), /*kill=*/true);
}

std::uint64_t JobWorker::starts() const {
  const std::lock_guard<std::mutex> lock(mu_);
  return starts_;
}

bool JobWorker::alive() const {
  const std::lock_guard<std::mutex> lock(mu_);
  return proc_ && !proc_->dead;
}

void JobWorker::kill_for_test() {
  const std::lock_guard<std::mutex> lock(mu_);
  if (proc_ && proc_->child) proc_->child->kill();
}

void JobWorker::stop_proc(std::unique_ptr<Proc> p, bool kill) {
  if (!p) return;
  if (kill) p->child->kill();
  // Closing stdin ends the worker's loop; finish waits for its exit.
  (void)p->child->finish();
  if (p->reader.joinable()) p->reader.join();
  std::error_code ec;
  std::filesystem::remove(p->startFile, ec);
}

void JobWorker::reader_loop(Proc* p) {
  std::string buffer;
  std::array<std::uint8_t, 16384> chunk{};
  for (;;) {
    const long n = p->child->read_stdout(chunk);
    if (n <= 0) break;
    buffer.append(reinterpret_cast<const char*>(chunk.data()), static_cast<std::size_t>(n));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
    for (std::size_t nl = buffer.find('\n'); nl != std::string::npos; nl = buffer.find('\n')) {
      const std::optional<Json> ev = js::parse(std::string_view(buffer).substr(0, nl));
      buffer.erase(0, nl + 1);
      if (!ev || !ev->is_object() || !ev->at("ev").is_string() || !ev->at("id").is_number()) continue;  // stray output
      const auto id = static_cast<std::uint64_t>(ev->at("id").num());
      const std::string kind = ev->at("ev").str();
      {
        const std::lock_guard<std::mutex> lock(mu_);
        if (id != p->inflight || p->answered) continue;  // an answer nobody waits for
        if (kind == "progress") {
          p->hasProgress = true;
          p->fraction = ev->at("fraction").is_number() ? ev->at("fraction").num() : 0;
          p->message = ev->at("message").is_string() ? ev->at("message").str() : std::string();
        } else if (kind == "result") {
          p->result = js::stringify(ev->at("result"));
          p->answered = true;
        } else if (kind == "cancelled") {
          // The work stopped at its cancel check: no result, no error (run() returns nullopt).
          p->answered = true;
        } else if (kind == "error") {
          api::EngineError e;
          e.code = child_detail::code_named(ev->at("code").is_string() ? ev->at("code").str() : "");
          e.message = ev->at("message").is_string() ? ev->at("message").str() : "the job failed";
          p->error = std::move(e);
          p->answered = true;
        }
      }
      cv_.notify_all();
    }
  }
  {
    const std::lock_guard<std::mutex> lock(mu_);
    p->dead = true;
  }
  cv_.notify_all();
}

void JobWorker::ensure_proc_locked(std::unique_lock<std::mutex>& lk, const std::optional<std::string>& plugins) {
  if (proc_ && !proc_->dead && proc_->plugins == plugins) return;
  std::unique_ptr<Proc> old = std::move(proc_);
  if (old) {
    lk.unlock();
    stop_proc(std::move(old), /*kill=*/true);
    lk.lock();
  }
  auto p = std::make_unique<Proc>();
  p->plugins = plugins;
  p->startFile = worker_start_file();
  {
    Json start = Json::object();
    if (plugins) {
      if (std::optional<Json> pj = js::parse(*plugins)) start.set("plugins", std::move(*pj));
    }
    std::ofstream f(p->startFile, std::ios::binary | std::ios::trunc);
    f << js::stringify(start);
    if (!f) fail(ErrorCode::io, "could not write the job worker's start file '" + p->startFile.string() + "'");
  }
  p->logPath = p->startFile.string() + ".log";
  std::vector<std::string> args = opt_.args;
  args.push_back(p->startFile.string());
  std::string error;
  p->child = exporter::ChildProcess::spawn(opt_.exe, args, p->logPath, error, /*captureStdout=*/true);
  if (!p->child) fail(ErrorCode::internal, "could not start the job worker: " + error);
  ++starts_;
  Proc* raw = p.get();
  p->reader = std::thread([this, raw] { reader_loop(raw); });
  proc_ = std::move(p);
  PREMATION_LOG(info, "job_worker_started").kv("log", proc_->logPath);
}

std::optional<std::string> JobWorker::run(const std::string& work, const std::string& inputJson, JobControl& control,
                                          const WorkerCall& call) {
  const std::optional<Json> input = js::parse(inputJson);
  if (!input) fail(ErrorCode::internal, "the worker job input is not JSON");
  const std::optional<std::string> plugins = opt_.plugins ? opt_.plugins() : std::nullopt;

  // Latest wins: a call of a key whose generation is no longer the newest never runs.
  const std::uint64_t generation =
      call.supersedeKey.empty() ? 0 : (call.generation != 0 ? call.generation : claim_generation(call.supersedeKey));
  auto superseded = [](const Waiter& w) { return !w.key.empty() && !is_latest(w.key, w.generation); };

  std::unique_lock<std::mutex> lk(mu_);
  const std::uint64_t ticket = ++tickets_;
  queue_.push_back(Waiter{ticket, call.supersedeKey, generation});
  cv_.notify_all();
  auto mine = [&]() -> std::deque<Waiter>::iterator {
    for (auto it = queue_.begin(); it != queue_.end(); ++it)
      if (it->ticket == ticket) return it;
    return queue_.end();
  };
  // Wait for the turn: the first live waiter, with nothing in flight.
  for (;;) {
    const auto it = mine();
    if (superseded(*it) || control.cancelled()) {
      queue_.erase(it);
      cv_.notify_all();
      return std::nullopt;
    }
    auto first = queue_.begin();
    while (first != queue_.end() && superseded(*first)) ++first;
    if (!busy_ && !stopping_ && first == it) break;
    cv_.wait_for(lk, std::chrono::milliseconds(25));  // cancellation and supersession are polled
  }
  queue_.erase(mine());
  busy_ = true;
  struct Release {
    JobWorker* w;
    std::unique_lock<std::mutex>& lk;
    ~Release() {
      if (!lk.owns_lock()) lk.lock();
      w->busy_ = false;
      w->lastUse_ = std::chrono::steady_clock::now();
      if (w->proc_) w->proc_->inflight = 0;
      w->cv_.notify_all();
    }
  } release{this, lk};

  ensure_proc_locked(lk, plugins);
  Proc* p = proc_.get();
  const std::uint64_t id = ++requestIds_;
  p->inflight = id;
  p->answered = false;
  p->result.reset();
  p->error.reset();
  p->hasProgress = false;
  Json req = Json::object();
  req.set("id", Json::number(static_cast<double>(id)));
  req.set("work", Json::string(work));
  req.set("input", *input);
  lk.unlock();
  const bool wrote = write_line(p, js::stringify(req));
  lk.lock();

  // The timeout is a silence: every progress line from the worker moves the deadline (a long walk reports per frame).
  auto deadline = std::chrono::steady_clock::now() + call.timeout;
  bool timedOut = false;
  bool cancelKill = false;
  // A cancel is sent once; a killOnCancel call then gives the worker `cancelGrace` to answer.
  bool cancelSent = false;
  std::optional<std::chrono::steady_clock::time_point> cancelDeadline;
  while (wrote && !p->answered && !p->dead) {
    const auto now = std::chrono::steady_clock::now();
    if (now >= deadline) {
      timedOut = true;
      break;
    }
    if (cancelDeadline && now >= *cancelDeadline) {
      cancelKill = true;
      break;
    }
    if (!cancelSent && control.cancelled()) {
      cancelSent = true;
      Json c = Json::object();
      c.set("id", Json::number(static_cast<double>(id)));
      c.set("cancel", Json::boolean(true));
      lk.unlock();
      const bool sent = write_line(p, js::stringify(c));
      lk.lock();
      if (!sent || call.killOnCancel) cancelDeadline = std::chrono::steady_clock::now() + (sent ? call.cancelGrace : std::chrono::milliseconds(0));
      continue;
    }
    if (p->hasProgress) {
      p->hasProgress = false;
      deadline = std::chrono::steady_clock::now() + call.timeout;
      const double f = p->fraction;
      std::string m = p->message;
      lk.unlock();
      control.progress(f, std::move(m));
      lk.lock();
      continue;
    }
    auto until = std::min(deadline, std::chrono::steady_clock::now() + std::chrono::milliseconds(100));
    if (cancelDeadline) until = std::min(until, *cancelDeadline);
    cv_.wait_until(lk, until);
  }
  if (p->answered) {
    if (p->hasProgress) {
      // A progress line read together with the answer: still relayed.
      p->hasProgress = false;
      const double f = p->fraction;
      std::string m = p->message;
      lk.unlock();
      control.progress(f, std::move(m));
      lk.lock();
    }
    if (control.cancelled()) return std::nullopt;
    if (p->error) throw doc::EngineFail{std::move(*p->error)};
    // `cancelled` without a cancel of ours (the worker stopped on its own): nothing to hand back.
    return std::move(p->result);
  }
  // A crash, a hang or a dead pipe: this call fails, the next one starts afresh.
  const std::string log = p->logPath;
  std::unique_ptr<Proc> gone = std::move(proc_);
  lk.unlock();
  stop_proc(std::move(gone), /*kill=*/true);
  lk.lock();
  if (cancelKill || control.cancelled()) return std::nullopt;
  PREMATION_LOG(warn, "job_worker_failed").kv("work", work).kv("timeout", timedOut).kv("log", log);
  if (timedOut) {
    fail(ErrorCode::internal, "the " + work + " model process stopped answering after " +
                                  std::to_string(call.timeout.count() / 1000) +
                                  " s and was stopped; the next try starts it again (the engine kept running — log: " + log + ")");
  }
  fail(ErrorCode::internal, "the " + work +
                                " model process ended without an answer; the next try starts it again (the engine kept running — log: " +
                                log + ")");
}

bool JobWorker::write_line(Proc* p, std::string line) {
  line.push_back('\n');
  return p->child->write(
      std::span<const std::uint8_t>(reinterpret_cast<const std::uint8_t*>(line.data()), line.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
}

void JobWorker::idle_loop() {
  std::unique_lock<std::mutex> lk(mu_);
  while (!stopping_) {
    cv_.wait_for(lk, std::chrono::milliseconds(500));
    if (stopping_) break;
    if (!proc_ || busy_ || !queue_.empty()) continue;
    if (!proc_->dead && std::chrono::steady_clock::now() - lastUse_ < opt_.idle) continue;
    // Idle (or already dead): close it, so the model is not held for nothing.
    std::unique_ptr<Proc> p = std::move(proc_);
    lk.unlock();
    stop_proc(std::move(p), /*kill=*/false);
    lk.lock();
  }
}

// ── latest-wins generations ──────────────────────────────────────────────

namespace {

struct Generations {
  std::mutex mu;
  std::uint64_t next = 0;
  std::map<std::string, std::uint64_t, std::less<>> newest;  // one entry per key (a layer): small
};

Generations& generations() {
  static Generations g;  // process-wide: jobs of one key may run on any runner thread
  return g;
}

}  // namespace

std::uint64_t claim_generation(const std::string& key) {
  Generations& g = generations();
  const std::lock_guard<std::mutex> lock(g.mu);
  const std::uint64_t gen = ++g.next;
  g.newest.insert_or_assign(key, gen);
  return gen;
}

bool is_latest(const std::string& key, std::uint64_t generation) {
  Generations& g = generations();
  const std::lock_guard<std::mutex> lock(g.mu);
  const auto it = g.newest.find(key);
  return it == g.newest.end() || it->second == generation;
}

// ── the engine's worker ──────────────────────────────────────────────────

namespace {

std::chrono::milliseconds idle_from_env() {
  if (const std::optional<std::string> s = os::env_var("PREMATION_JOB_WORKER_IDLE_MS"); s && !s->empty()) {
    try {
      return std::chrono::milliseconds(std::stoll(*s));
    } catch (const std::exception&) {
    }
  }
  return std::chrono::minutes(3);
}

/// The in-process fallback's control: the caller's, as is.
class Forward final : public JobControl {
 public:
  explicit Forward(JobControl& parent) : parent_(parent) {}
  [[nodiscard]] bool cancelled() const noexcept override { return parent_.cancelled(); }
  void progress(double fraction, std::string message) override { parent_.progress(fraction, std::move(message)); }

 private:
  JobControl& parent_;
};

}  // namespace

std::optional<std::string> run_in_worker(const std::string& work, const std::string& inputJson, JobControl& control, const WorkerCall& call) {
  const std::string exe = child_executable();
  if (exe.empty()) {
    // No executable known (tests, tools): the same work in-process, as run_child does.
    const ChildWork fn = child_detail::find_work(work);
    if (!fn) fail(ErrorCode::internal, "no child work '" + work + "'");
    Forward fwd(control);
    std::string out = fn(inputJson, fwd);
    if (control.cancelled()) return std::nullopt;
    return out;
  }
  if (const std::optional<std::string> off = os::env_var("PREMATION_JOB_WORKER"); off && *off == "0") return run_child(work, inputJson, control);
  // The process-wide workers, one per lane (job_worker.hpp "lanes": the batch
  // lane's walks never queue a hover behind them, at the price of a second
  // process holding its own copy of the models while both are warm). They die
  // with the engine (the destructor kills them, and the OS job object kills
  // them when the engine crashes).
  const auto options = [&exe] {
    JobWorker::Options o;
    o.exe = exe;
    o.idle = idle_from_env();
    o.plugins = [] { return child_detail::current_plugins(); };
    return o;
  };
  static JobWorker interactive(options());
  static JobWorker batch(options());
  JobWorker& worker = call.lane == WorkerLane::batch ? batch : interactive;
  return worker.run(work, inputJson, control, call);
}

// ── the worker process ───────────────────────────────────────────────────

namespace {

/// What the worker's stdin thread hands the work loop: requests in order, and
/// the ids whose cancel arrived before their request was taken up. The request
/// in flight has its own flag, read by WorkerControl::cancelled() without a lock.
struct WorkerInbox {
  std::mutex mu;
  std::condition_variable cv;
  std::deque<Json> requests;
  std::vector<std::uint64_t> cancelledAhead;  // a few at most: a cancel of a queued request
  bool closed = false;
  std::atomic<std::uint64_t> inflight{0};
  std::atomic<bool> inflightCancelled{false};
};

class WorkerControl final : public JobControl {
 public:
  WorkerControl(std::ostream& out, double id, const std::atomic<bool>& cancelled) : out_(out), id_(id), cancelled_(cancelled) {}
  [[nodiscard]] bool cancelled() const noexcept override { return cancelled_.load(std::memory_order_relaxed); }
  void progress(double fraction, std::string message) override {
    Json o = Json::object();
    o.set("id", Json::number(id_));
    o.set("ev", Json::string("progress"));
    o.set("fraction", Json::number(fraction));
    o.set("message", Json::string(std::move(message)));
    out_ << js::stringify(o) << '\n' << std::flush;
  }

 private:
  std::ostream& out_;
  double id_;
  const std::atomic<bool>& cancelled_;
};

/// The stdin thread: every line is a request (queued) or a cancel (flagged).
void worker_inbox_loop(std::istream& in, WorkerInbox& inbox) {
  std::string line;
  while (std::getline(in, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty()) continue;
    std::optional<Json> req = js::parse(line);
    if (!req || !req->is_object() || !req->at("id").is_number()) continue;
    const auto id = static_cast<std::uint64_t>(req->at("id").num());
    const std::lock_guard<std::mutex> lock(inbox.mu);
    if (req->at("cancel").is_bool() && req->at("cancel").b()) {
      if (inbox.inflight.load() == id) {
        inbox.inflightCancelled.store(true);
      } else {
        // Still queued (or never seen): the loop answers it `cancelled` when it reaches it.
        inbox.cancelledAhead.push_back(id);
      }
    } else {
      inbox.requests.push_back(std::move(*req));
    }
    inbox.cv.notify_all();
  }
  const std::lock_guard<std::mutex> lock(inbox.mu);
  inbox.closed = true;
  inbox.cv.notify_all();
}

}  // namespace

int worker_main(const std::string& startFile, std::istream& in, std::ostream& out, const ChildPluginStarter& startPlugins) {
  std::unique_ptr<ChildPluginScope> plugins;
  {
    std::ifstream f(startFile, std::ios::binary);
    std::stringstream ss;
    ss << f.rdbuf();
    if (const std::optional<Json> start = js::parse(ss.str()); start && start->is_object() && start->at("plugins").is_object() && startPlugins) {
      const ChildPlugins cp = child_detail::plugins_from(js::stringify(start->at("plugins")));
      if (!cp.paths.empty()) plugins = startPlugins(cp);
    }
  }
  auto answer = [&out](double id, const char* ev, Json body) {
    body.set("id", Json::number(id));
    body.set("ev", Json::string(ev));
    out << js::stringify(body) << '\n' << std::flush;
  };
  WorkerInbox inbox;
  std::thread reader([&in, &inbox] { worker_inbox_loop(in, inbox); });
  for (;;) {
    Json req;
    bool cancelledAhead = false;
    {
      std::unique_lock<std::mutex> lk(inbox.mu);
      inbox.cv.wait(lk, [&] { return inbox.closed || !inbox.requests.empty(); });
      if (inbox.requests.empty()) break;  // stdin closed and nothing left: exit
      req = std::move(inbox.requests.front());
      inbox.requests.pop_front();
      const auto id = static_cast<std::uint64_t>(req.at("id").num());
      const auto it = std::find(inbox.cancelledAhead.begin(), inbox.cancelledAhead.end(), id);
      if (it != inbox.cancelledAhead.end()) {
        inbox.cancelledAhead.erase(it);
        cancelledAhead = true;
      }
      inbox.inflightCancelled.store(cancelledAhead);
      inbox.inflight.store(id);
    }
    const double id = req.at("id").num();
    if (cancelledAhead) {
      answer(id, "cancelled", Json::object());
      continue;
    }
    Json err = Json::object();
    if (!req.at("work").is_string()) {
      err.set("code", Json::string("invalidArgument"));
      err.set("message", Json::string("not a worker request"));
      answer(id, "error", std::move(err));
      continue;
    }
    const ChildWork work = child_detail::find_work(req.at("work").str());
    if (!work) {
      err.set("code", Json::string("unsupported"));
      err.set("message", Json::string("no job work '" + req.at("work").str() + "' in this engine build"));
      answer(id, "error", std::move(err));
      continue;
    }
    WorkerControl control(out, id, inbox.inflightCancelled);
    std::optional<api::EngineError> failed;
    std::string result;
    try {
      result = work(js::stringify(req.at("input")), control);
    } catch (const doc::EngineFail& f) {
      failed = f.error;
    } catch (const std::exception& e) {
      api::EngineError e2;
      e2.code = ErrorCode::internal;
      e2.message = e.what();
      failed = std::move(e2);
    }
    inbox.inflight.store(0);
    if (control.cancelled()) {
      // Stopped at a cancel check (or finished just after one): the parent discards it either way.
      answer(id, "cancelled", Json::object());
      continue;
    }
    if (failed) {
      err.set("code", Json::string(child_detail::code_name(failed->code)));
      err.set("message", Json::string(failed->message));
      answer(id, "error", std::move(err));
      continue;
    }
    Json body = Json::object();
    const std::optional<Json> parsed = js::parse(result);
    body.set("result", parsed ? *parsed : Json::object());
    answer(id, "result", std::move(body));
  }
  if (reader.joinable()) reader.join();
  return 0;
}

}  // namespace premation::jobs
