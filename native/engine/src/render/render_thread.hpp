// The render thread: owns the Dawn device, the compositor and one frame-slot
// ring PER VIEWPORT (the editor's viewport, a pop-out window's, a second view:
// each is its own engine surface with its own generation numbers). The
// document core hands it evaluated frames (FrameSink::submit, tagged with their
// viewport); it renders the newest one of a viewport into a free slot of that
// viewport's ring and announces it on the frame channel, taking viewports in
// turn. It never blocks the core: submit replaces a job that has not started,
// and a full ring (every slot still with Chromium) holds the newest job until
// a slot comes back — older ones are dropped and counted.
//
// Device loss (driver reset, TDR) is recovered in-process: everything built on
// the lost device is dropped (slots, frame cache, the drawer — and with it the
// render graph's resources and every native plugin's GPU data), a new device
// is created, new slots are announced (a new generation), and the last frame
// is drawn again. A frame drawn on the lost device is never announced. Only
// when no device can be had, or losses keep coming without a frame between
// (kMaxDeviceRecoveries), is the loss fatal: OnFatal, and the supervisor
// restarts the engine.
#pragma once

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <future>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
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

  /// getThumbnail: draw `frame` offscreen at width × height and encode it
  /// (StillImage). False (with `error`) when it cannot.
  virtual bool draw_still(const BuiltFrame& /*frame*/, std::uint32_t /*width*/, std::uint32_t /*height*/,
                          StillImage& /*out*/, std::string& error) {
    error = "this drawer cannot draw stills";
    return false;
  }
  /// readPixels: `region` of `frame` (drawn for a width × height slot) in
  /// working space — the frame is drawn again offscreen, then read.
  virtual bool read_working(const BuiltFrame& /*frame*/, std::uint32_t /*width*/, std::uint32_t /*height*/,
                            PixelRegion /*region*/, WorkingPixels& /*out*/, std::string& error) {
    error = "this drawer cannot read working-space pixels";
    return false;
  }
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
  /// Route A: queue one framed pixel message (premation/protocol/pixel_channel.hpp)
  /// on the pixel stream (fd 5); false once that pipe is gone. Unset = no
  /// pixel stream, so `frames.copy` is not offered.
  std::function<bool(std::vector<std::uint8_t>)> sendPixels;
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

  /// Frame-channel Release (any thread). Generations are unique across
  /// viewports, so the generation names the viewport's ring.
  void release(std::uint32_t generation, std::uint32_t slot);

  // FrameSink
  void submit(RenderJob job) override;
  void configure(const ViewportConfig& config) override;
  void set_shared(bool shared) override;
  [[nodiscard]] bool shared_supported() const override;
  void set_copy(bool copy) override;
  [[nodiscard]] bool copy_supported() const override;
  [[nodiscard]] RenderCounters counters() const override;
  [[nodiscard]] std::string adapter() const override;
  [[nodiscard]] std::string backend() const override;
  /// D4: the frame cache's counters (zeros when the cache is off).
  [[nodiscard]] FrameCacheStats cache_stats() const;
  [[nodiscard]] CacheCoverageSnap cache_coverage() const override;
  void purge_frame_cache() override;
  /// Run on the render thread between frames (below).
  [[nodiscard]] std::future<StillImage> render_still(std::shared_ptr<BuiltFrame> frame, std::uint32_t width,
                                                     std::uint32_t height) override;
  [[nodiscard]] std::future<WorkingPixels> read_pixels(std::uint32_t viewport, PixelRegion region) override;

 private:
  struct SlotSet;
  /// One viewport (C multi-viewport): its config, newest job, ring and slots.
  /// Created by configure (core thread, under m_); erased only by the render
  /// thread (under m_) once a closed viewport's ring has been retired, so a
  /// Port* the render thread took under the lock stays valid after it unlocks.
  struct Port {
    ViewportConfig config;                  // m_
    bool dirty = false;                     // m_: the ring must be rebuilt (size, open/closed, route)
    std::optional<RenderJob> pending;       // m_
    std::uint32_t droppedPending = 0;       // m_: superseded + clock-skipped since the last FrameReady
    /// shared_ptr: release() (the frame-channel reader thread) holds it past
    /// m_ while the render thread may retire the port.
    std::shared_ptr<FrameRing> ring = std::make_shared<FrameRing>();
    // Render-thread only.
    std::unique_ptr<SlotSet> slots;
    /// The job drawn last, drawn again on a recovered device (and read by readPixels).
    std::optional<RenderJob> lastJob;
  };
  static constexpr std::uint32_t kMaxDeviceRecoveries = 3;
  void run(std::promise<std::string>& ready);
  /// Device, compositor, drawer and frame cache; "" or why not.
  std::string open_gpu();
  /// Everything open_gpu and the slots built (idempotent).
  void close_gpu();
  /// After a loss: close, then open again. False = the loss is fatal.
  bool recover_device();
  void rebuild(Port& port, const ViewportConfig& config, bool shared, bool copy);
  /// Route A: the slot's read-back buffer → one pixel message. False = nothing sent.
  bool send_copy(SlotSet& set, std::uint32_t slot);
  void render(Port& port, RenderJob& job, std::uint32_t slot, const ViewportConfig& config);
  void collect_retired(std::chrono::steady_clock::time_point now);
  /// Queue `task` for the render thread (queries: stills, pixel reads).
  void post(std::function<void()> task);
  void run_tasks(std::unique_lock<std::mutex>& lock);
  /// Under m_: a viewport with a job and a free slot, round-robin after the last one served.
  Port* next_ready_locked();

  RenderOptions options_;
  SendFrames send_;
  OnFatal onFatal_;

  std::thread thread_;
  mutable std::mutex m_;
  std::condition_variable cv_;
  bool quit_ = false;
  bool shared_ = false;
  bool copy_ = false;
  /// Every viewport by id (m_ for the map; see Port for its fields).
  std::map<std::uint32_t, std::unique_ptr<Port>> ports_;
  std::uint32_t lastServed_ = 0;  // m_: the viewport rendered last (fair turns between viewports)
  /// Query work for the render thread (render_still, read_pixels), run
  /// between frames in arrival order; drained (answered) on stop.
  std::deque<std::function<void()>> tasks_;

  // Render-thread-only state.
  std::optional<Gpu> gpu_;
  std::unique_ptr<Compositor> compositor_;
  std::unique_ptr<BuiltFrameDrawer> drawer_;
  std::unique_ptr<FrameCache> cache_;
  std::vector<std::unique_ptr<SlotSet>> retired_;
  std::uint32_t generation_ = 0;  // unique across viewports
  std::uint32_t lossesSinceFrame_ = 0;
  bool pixelPipeGone_ = false;  // logged once

  // Counters (m_).
  RenderCounters counters_;
  FrameCacheStats cacheStats_;
  wgpu::Texture onionTex_;
  wgpu::TextureView onionView_;
  std::uint32_t onionW_ = 0;
  std::uint32_t onionH_ = 0;
  void composite_onion(const RenderJob& job, const wgpu::TextureView& slot, std::uint32_t width, std::uint32_t height);
  /// Render thread only.
  void note_coverage(std::int64_t frame, std::uint64_t key);
  void publish_coverage();
  /// Render thread only: frame index → content keys still worth counting.
  std::unordered_map<std::int64_t, std::vector<std::uint64_t>> covered_;
  CacheCoverageSnap coverage_;
  std::uint64_t windowFrames_ = 0;
  double windowGpuMs_ = 0;
  std::chrono::steady_clock::time_point windowStart_ = std::chrono::steady_clock::now();
  std::string adapter_;
  std::string backend_;
  bool sharedCapable_ = false;
};

}  // namespace premation::render
