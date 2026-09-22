// The prototype's transport to the Electron host.
//
//   stdout  binary messages: a 64-byte MessageHeader + payload
//   stdin   text commands, one per line ("rect x y w h", "ping <epoch_us>", ...)
//   stderr  human-readable log
//
// This is NOT the C2 protocol (that is native/protocol + docs/ENGINE_API.md);
// it is the smallest thing that lets C1 measure the three display routes.
#pragma once

#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <span>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace premation {

enum class MessageType : std::uint32_t {
  Frame = 1,       // payload = width*height*4 RGBA8 bytes (route A)
  Json = 2,        // payload = UTF-8 JSON (hello, stats)
  SlotReady = 3,   // no payload; `slot` names a shared texture (route C)
  Presented = 4,   // no payload; a frame reached the swapchain (route B)
};

// Little-endian, 64 bytes, read by proto-host/main.cjs.
struct MessageHeader {
  std::uint32_t magic = 0x4D524650U;  // "PFRM"
  MessageType type = MessageType::Json;
  std::uint32_t payloadBytes = 0;
  std::uint32_t frameIndex = 0;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::uint32_t slot = 0;
  std::uint32_t reserved = 0;
  double tRenderStartUs = 0;  // engine began encoding this frame
  double tRenderDoneUs = 0;   // GPU finished (readback mapped / work done / Present returned)
  double tCmdUs = 0;          // page timestamp of the newest command this frame reflects, 0 = none
  double tSendUs = 0;         // handed to the pipe
};
static_assert(sizeof(MessageHeader) == 64);

class Wire {
 public:
  Wire();
  ~Wire();
  Wire(const Wire&) = delete;
  Wire& operator=(const Wire&) = delete;
  Wire(Wire&&) = delete;
  Wire& operator=(Wire&&) = delete;

  // Route A: offer a frame. Copies `pixels` into the writer's single slot and
  // returns true, or returns false (frame dropped) while the previous frame is
  // still going down the pipe — the engine never blocks on a slow consumer.
  bool offer_frame(const MessageHeader& header, std::span<const std::uint8_t> pixels);

  // Small messages (JSON, SlotReady, Presented); queued, never dropped.
  void send(MessageHeader header, std::string_view payload = {});
  void send_json(std::string_view json);

  // Commands received since the last call.
  std::vector<std::string> take_commands();
  bool stdin_closed() const;

 private:
  void writer_loop();

  mutable std::mutex mutex_;
  std::condition_variable wake_;
  bool stop_ = false;
  bool frameReady_ = false;
  bool writing_ = false;
  MessageHeader frameHeader_{};
  std::vector<std::uint8_t> frame_;
  std::deque<std::vector<std::uint8_t>> small_;

  // Commands from stdin. shared_ptr (not unique_ptr) on purpose: the detached
  // stdin reader thread co-owns it and can outlive this Wire at shutdown.
  struct Inbox {
    std::mutex mutex;
    std::vector<std::string> commands;
    bool closed = false;
  };
  std::shared_ptr<Inbox> inbox_ = std::make_shared<Inbox>();

  std::thread writer_;
};

}  // namespace premation
