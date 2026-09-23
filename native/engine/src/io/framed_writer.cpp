#include "framed_writer.hpp"

#include <utility>

#include "log.hpp"

namespace premation::io {

FramedWriter::FramedWriter(Handle handle, std::string name) : handle_(handle), name_(std::move(name)) {}

FramedWriter::~FramedWriter() { close(std::chrono::milliseconds(0)); }

void FramedWriter::start() {
  if (!handle_.valid()) return;
  thread_ = std::thread([this] { run(); });
}

bool FramedWriter::send(std::vector<std::uint8_t> framed) {
  if (!handle_.valid() || broken_.load()) return false;
  const std::size_t n = framed.size();
  backlog_.fetch_add(n);
  if (!queue_.push(std::move(framed))) {
    backlog_.fetch_sub(n);
    return false;
  }
  return true;
}

void FramedWriter::run() {
  std::vector<std::uint8_t> batch;
  for (;;) {
    auto first = queue_.pop_until(std::nullopt);
    if (!first) break;  // closed and drained
    batch = std::move(*first);
    // Coalesce whatever else is already queued (bounded, so one huge backlog
    // does not become one huge write).
    constexpr std::size_t kCoalesce = 256U * 1024U;
    while (batch.size() < kCoalesce) {
      auto more = queue_.try_pop();
      if (!more) break;
      batch.insert(batch.end(), more->begin(), more->end());
    }
    const std::size_t n = batch.size();
    if (!broken_.load() && !write_all(handle_, batch)) {
      broken_.store(true);
      PREMATION_LOG(warn, "pipe_broken").kv("pipe", name_);
    }
    backlog_.fetch_sub(n);
  }
  {
    const std::lock_guard<std::mutex> lock(doneMutex_);
    done_ = true;
  }
  doneCv_.notify_all();
}

void FramedWriter::close(std::chrono::milliseconds drain) {
  queue_.close();
  if (!thread_.joinable()) return;
  std::unique_lock<std::mutex> lock(doneMutex_);
  if (doneCv_.wait_for(lock, drain, [this] { return done_; })) {
    lock.unlock();
    thread_.join();
  } else {
    // Blocked in a write nobody reads: let process exit reclaim it.
    lock.unlock();
    thread_.detach();
    detached_ = true;
  }
}

}  // namespace premation::io
