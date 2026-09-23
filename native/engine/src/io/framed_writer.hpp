// One writer thread per outgoing pipe, so neither the document core nor the
// render thread ever blocks on a slow reader. Queued frames written
// back-to-back are coalesced into one write.
#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "blocking_queue.hpp"
#include "pipe_ffi.hpp"

namespace premation::io {

class FramedWriter {
 public:
  FramedWriter(Handle handle, std::string name);
  ~FramedWriter();
  FramedWriter(const FramedWriter&) = delete;
  FramedWriter& operator=(const FramedWriter&) = delete;
  FramedWriter(FramedWriter&&) = delete;
  FramedWriter& operator=(FramedWriter&&) = delete;

  void start();
  /// Queue already-framed bytes. False once the pipe broke or the writer closed.
  bool send(std::vector<std::uint8_t> framed);
  /// Stop accepting, write what is queued (up to `drain`), then stop. A reader
  /// that never drains cannot hang shutdown: the thread is detached after `drain`.
  void close(std::chrono::milliseconds drain);

  [[nodiscard]] std::size_t backlog_bytes() const noexcept { return backlog_.load(); }
  [[nodiscard]] bool broken() const noexcept { return broken_.load(); }
  [[nodiscard]] bool valid() const noexcept { return handle_.valid(); }
  /// close() gave up waiting and detached the thread. The owner must then end
  /// the process without destroying this writer (engine main uses std::_Exit).
  [[nodiscard]] bool detached() const noexcept { return detached_; }

 private:
  void run();

  Handle handle_;
  std::string name_;
  BlockingQueue<std::vector<std::uint8_t>> queue_;
  std::atomic<std::size_t> backlog_{0};
  std::atomic<bool> broken_{false};
  std::thread thread_;
  std::mutex doneMutex_;
  std::condition_variable doneCv_;
  bool done_ = false;
  bool detached_ = false;
};

}  // namespace premation::io
