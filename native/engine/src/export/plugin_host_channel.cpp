// SDK 1.4 (X): plugin_host_channel.hpp.
#include "plugin_host_channel.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <vector>

#include "child_process.hpp"
#include "oop_wire.hpp"

namespace premation::exporter {

namespace {

class ChildChannel final : public plugins::OopChannel {
 public:
  explicit ChildChannel(std::unique_ptr<ChildProcess> child) : child_(std::move(child)) {}
  ~ChildChannel() override {
    if (child_ && alive_) {
      std::vector<std::uint8_t> quit;
      plugins::oop::put_frame(quit, plugins::oop::Kind::quit, {});
      (void)child_->write(quit);
    }
    if (child_) child_->kill();
  }
  ChildChannel(const ChildChannel&) = delete;
  ChildChannel& operator=(const ChildChannel&) = delete;
  ChildChannel(ChildChannel&&) = delete;
  ChildChannel& operator=(ChildChannel&&) = delete;

  bool call(std::uint32_t kind, std::span<const std::uint8_t> payload, std::vector<std::uint8_t>& reply, std::uint32_t timeoutMs,
            std::string& error) override {
    const std::scoped_lock lock(mutex_);
    if (!alive_) {
      error = "the plugin host process has ended";
      return false;
    }
    std::vector<std::uint8_t> frame;
    plugins::oop::put_frame(frame, static_cast<plugins::oop::Kind>(kind), payload);
    // A reply that does not come in time is a hang: the child is killed (its read ends).
    bool replied = false;
    std::mutex m;
    std::condition_variable_any cv;
    bool timedOut = false;
    std::jthread watch([&](const std::stop_token& stop) {
      std::unique_lock w(m);
      if (!cv.wait_for(w, stop, std::chrono::milliseconds(timeoutMs), [&] { return replied; })) {
        if (stop.stop_requested()) return;
        timedOut = true;
        child_->kill();
      }
    });
    const auto finish = [&] {
      {
        const std::scoped_lock w(m);
        replied = true;
      }
      cv.notify_all();
      watch.request_stop();
      watch.join();
    };
    if (!child_->write(frame)) {
      finish();
      alive_ = false;
      error = "the plugin host process has ended";
      return false;
    }
    std::vector<std::uint8_t> header(8);
    const bool got = read_exact(header);
    plugins::oop::Kind k{};
    std::uint32_t length = 0;
    bool ok = got && plugins::oop::read_header(header, k, length) && k == plugins::oop::Kind::reply;
    if (ok) {
      reply.resize(length);
      ok = length == 0 || read_exact(reply);
    }
    finish();
    if (!ok) {
      alive_ = false;
      child_->kill();
      error = timedOut ? "the plugin did not answer within " + std::to_string(timeoutMs) + " ms (its process was ended)"
                       : "the plugin's process ended (a crash outside the guard: abort, heap corruption)";
      return false;
    }
    return true;
  }

  [[nodiscard]] bool alive() const override { return alive_; }

 private:
  bool read_exact(std::vector<std::uint8_t>& into) {
    std::size_t at = 0;
    while (at < into.size()) {
      const long n = child_->read_stdout(std::span(into).subspan(at));
      if (n <= 0) return false;
      at += static_cast<std::size_t>(n);
    }
    return true;
  }

  std::unique_ptr<ChildProcess> child_;
  std::mutex mutex_;
  std::atomic<bool> alive_{true};
};

}  // namespace

std::unique_ptr<plugins::OopChannel> spawn_plugin_host(const std::filesystem::path& exe, const std::filesystem::path& bundle,
                                                       const std::filesystem::path& logFile, std::string& error) {
  const auto u8 = [](const std::filesystem::path& p) {
    const std::u8string s = p.u8string();
    return std::string(s.begin(), s.end());
  };
  std::unique_ptr<ChildProcess> child = ChildProcess::spawn(u8(exe), {"--bundle", u8(bundle)}, u8(logFile), error, true);
  if (!child) return nullptr;
  return std::make_unique<ChildChannel>(std::move(child));
}

}  // namespace premation::exporter
