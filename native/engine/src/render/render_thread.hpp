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
#include "frame_cache.hpp"
#include "frame_ring.hpp"
#include "frame_scene.hpp"
#include "gpu.hpp"
#include "premation/protocol/frame_channel.hpp"

namespace premation::render {

/// D2w: draws a frame the engine's scene builder produced (core/frame_scene.hpp
/// `RenderJob::built`) into a slot through the render graph. Created and used
/// on the render thread only, on the render thread's device; implemented in
/// engine_frames (scene/engine_frames.cpp) so this library stays free of the
/// render graph, the rasters and the media code.
class BuiltFrameDrawer {
 public:
  BuiltFrameDrawer() = default;
  virtual ~BuiltFrameDrawer() = default;
  BuiltFrameDrawer(const BuiltFrameDrawer&) = delete;
  BuiltFrameDrawer& operator=(const BuiltFrameDrawer&) = delete;
  BuiltFrameDrawer(BuiltFrameDrawer&&) = delete;
  BuiltFrameDrawer& operator=(BuiltFrameDrawer&&) = delete;

  /// Encode + submit the frame into `target` (RGBA8Unorm, width × height).
  virtual bool draw(const BuiltFrame& frame, const wgpu::TextureView& target, std::uint32_t width,
                    std::uint32_t height, std::string& error) = 0;

  /// D4: the frame's content key for the frame cache (frame_cache.hpp) — equal
  /// keys draw identical pixels into a width × height slot. nullopt = do not cache.
  [[nodiscard]] virtual std::optional<std::uint64_t> content_key(const BuiltFrame& /*frame*/, std::uint32_t /*width*/,
                                                                 std::uint32_t /*height*/) const {
    return std::nullopt;
  }
  /// D4: whether the frame `draw` just drew is final — false while footage on
  /// it may show a nearest decoded frame instead of the exact one.
  [[nodiscard]] virtual bool last_frame_exact() const { return false; }
};

/// RenderOptions::frameCacheBytes: size the cache from the adapter (frame_cache.hpp).
inline constexpr std::size_t kFrameCacheAuto = static_cast<std::size_t>(-1);

struct RenderOptions {
  std::uint32_t slots = 3;
  /// D4 frame cache budget in bytes; kFrameCacheAuto = default_frame_cache_budget, 0 = off.
  std::size_t frameCacheBytes = kFrameCacheAuto;
  /// Makes the drawer for built frames on the render thread's device (null = C2's quads only).
  std::function<std::unique_ptr<BuiltFrameDrawer>(const Gpu& gpu, std::string& error)> makeDrawer;
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
  /// D4: the frame cache's counters (zeros when the cache is off).
  [[nodiscard]] FrameCacheStats cache_stats() const;

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
  std::unique_ptr<BuiltFrameDrawer> drawer_;
  std::unique_ptr<FrameCache> cache_;
  std::unique_ptr<SlotSet> slots_;
  std::vector<std::unique_ptr<SlotSet>> retired_;
  std::uint32_t generation_ = 0;
  FrameRing ring_;

  // Counters (m_).
  RenderCounters counters_;
  FrameCacheStats cacheStats_;
  std::uint64_t windowFrames_ = 0;
  double windowGpuMs_ = 0;
  std::chrono::steady_clock::time_point windowStart_ = std::chrono::steady_clock::now();
  std::string adapter_;
  std::string backend_;
  bool sharedCapable_ = false;
};

}  // namespace premation::render
