// The render thread: owns the Dawn device, the compositor and the frame-slot
// ring. The document core hands it evaluated frames (FrameSink::submit); it
// renders the newest one into a free slot and announces it on the frame
// channel. It never blocks the core: submit replaces a job that has not
// started, and a full ring (every slot still with Chromium) holds the newest
// job until a slot comes back — older ones are dropped and counted.
#pragma once

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include "compositor.hpp"
#include "frame_ring.hpp"
#include "frame_scene.hpp"
#include "gpu.hpp"
#include "premation/protocol/frame_channel.hpp"

namespace premation::render {

struct RenderOptions {
  std::uint32_t slots = 3;
  std::uint32_t hostPid = 0;     // Electron main; shared handles are duplicated into it
  std::uint32_t vendorId = 0;    // Chromium's GPU (PCI vendor id); 0 = power preference decides
  bool highPerformance = false;
};

class RenderThread final : public FrameSink {
 public:
  using SendFrames = std::function<void(const frames::Message&)>;
  using OnFatal = std::function<void(const std::string&)>;

  RenderThread(RenderOptions options, SendFrames send, OnFatal onFatal);
  ~RenderThread() override;
  RenderThread(const RenderThread&) = delete;
  RenderThread& operator=(const RenderThread&) = delete;
  RenderThread(RenderThread&&) = delete;
  RenderThread& operator=(RenderThread&&) = delete;

  /// Create the device on the render thread; false (with `error`) when no GPU.
  bool start(std::string& error);
  void stop();

  /// Frame-channel Release (any thread).
  void release(std::uint32_t generation, std::uint32_t slot) { ring_.release(generation, slot); }

  // FrameSink
  void submit(RenderJob job) override;
  void configure(const ViewportConfig& config) override;
  void set_shared(bool shared) override;
  [[nodiscard]] bool shared_supported() const override;
  [[nodiscard]] RenderCounters counters() const override;
  [[nodiscard]] std::string adapter() const override;
  [[nodiscard]] std::string backend() const override;

 private:
  struct SlotSet;
  void run(std::promise<std::string>& ready);
  void rebuild(const ViewportConfig& config, bool shared);
  void render(RenderJob& job, std::uint32_t slot, const ViewportConfig& config);
  void collect_retired(std::chrono::steady_clock::time_point now);

  RenderOptions options_;
  SendFrames send_;
  OnFatal onFatal_;

  std::thread thread_;
  mutable std::mutex m_;
  std::condition_variable cv_;
  bool quit_ = false;
  bool configDirty_ = false;
  ViewportConfig config_;
  bool shared_ = false;
  std::optional<RenderJob> pending_;
  std::uint32_t droppedPending_ = 0;  // superseded + clock-skipped since the last FrameReady

  // Render-thread-only state.
  std::optional<Gpu> gpu_;
  std::unique_ptr<Compositor> compositor_;
  std::unique_ptr<SlotSet> slots_;
  std::vector<std::unique_ptr<SlotSet>> retired_;
  std::uint32_t generation_ = 0;
  FrameRing ring_;

  // Counters (m_).
  RenderCounters counters_;
  std::uint64_t windowFrames_ = 0;
  double windowGpuMs_ = 0;
  std::chrono::steady_clock::time_point windowStart_ = std::chrono::steady_clock::now();
  std::string adapter_;
  std::string backend_;
  bool sharedCapable_ = false;
};

}  // namespace premation::render
