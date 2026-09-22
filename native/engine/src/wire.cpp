#include "wire.hpp"

#include <cstring>
#include <iostream>

#include "os_ffi.hpp"

namespace premation {

Wire::Wire() {
  writer_ = std::thread([this] { writer_loop(); });
  // The stdin reader blocks in getline with no portable way to interrupt it,
  // so it is detached and co-owns the inbox. EOF on stdin means the host
  // died — the engine then shuts itself down.
  std::thread([inbox = inbox_] {
    std::string line;
    while (std::getline(std::cin, line)) {
      if (!line.empty() && line.back() == '\r') line.pop_back();
      const std::scoped_lock lock(inbox->mutex);
      inbox->commands.push_back(line);
    }
    const std::scoped_lock lock(inbox->mutex);
    inbox->closed = true;
  }).detach();
}

Wire::~Wire() {
  {
    const std::scoped_lock lock(mutex_);
    stop_ = true;
  }
  wake_.notify_all();
  writer_.join();
}

bool Wire::offer_frame(const MessageHeader& header, std::span<const std::uint8_t> pixels) {
  {
    const std::scoped_lock lock(mutex_);
    if (frameReady_ || writing_) return false;
    // Sized once per resolution; no per-frame allocation after the first.
    frame_.resize(pixels.size());
    std::memcpy(frame_.data(), pixels.data(), pixels.size());
    frameHeader_ = header;
    frameHeader_.type = MessageType::Frame;
    frameHeader_.payloadBytes = static_cast<std::uint32_t>(pixels.size());
    frameReady_ = true;
  }
  wake_.notify_one();
  return true;
}

void Wire::send(MessageHeader header, std::string_view payload) {
  header.payloadBytes = static_cast<std::uint32_t>(payload.size());
  std::vector<std::uint8_t> msg(sizeof(MessageHeader) + payload.size());
  std::memcpy(msg.data(), &header, sizeof(MessageHeader));
  if (!payload.empty()) std::memcpy(msg.data() + sizeof(MessageHeader), payload.data(), payload.size());
  {
    const std::scoped_lock lock(mutex_);
    small_.push_back(std::move(msg));
  }
  wake_.notify_one();
}

void Wire::send_json(std::string_view json) {
  MessageHeader h{};
  h.type = MessageType::Json;
  send(h, json);
}

std::vector<std::string> Wire::take_commands() {
  const std::scoped_lock lock(inbox_->mutex);
  std::vector<std::string> out;
  out.swap(inbox_->commands);
  return out;
}

bool Wire::stdin_closed() const {
  const std::scoped_lock lock(inbox_->mutex);
  return inbox_->closed;
}

void Wire::writer_loop() {
  std::unique_lock lock(mutex_);
  for (;;) {
    wake_.wait(lock, [this] { return stop_ || frameReady_ || !small_.empty(); });
    if (stop_) return;
    std::deque<std::vector<std::uint8_t>> small;
    small.swap(small_);
    const bool haveFrame = frameReady_;
    if (haveFrame) {
      frameReady_ = false;
      writing_ = true;
    }
    lock.unlock();
    // `frame_` is ours while writing_ is set: offer_frame refuses to touch it.
    for (const auto& m : small) (void)os::write_stdout(m.data(), m.size());
    if (haveFrame) {
      frameHeader_.tSendUs = os::epoch_us();
      (void)os::write_stdout(&frameHeader_, sizeof(MessageHeader));
      (void)os::write_stdout(frame_.data(), frame_.size());
    }
    lock.lock();
    writing_ = false;
  }
}

}  // namespace premation
