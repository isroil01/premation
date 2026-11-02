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

#include <atomic>
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
#include <utility>
#include <vector>

#include "compositor.hpp"
#include "coverage_ledger.hpp"
#include "disk_cache.hpp"
#include "frame_cache.hpp"
#include "frame_ring.hpp"
#include "ram_cache.hpp"
#include "frame_scene.hpp"
#include "gpu.hpp"
#include "premation/protocol/frame_channel.hpp"

namespace premation::render {

/// D2w: draws a frame the engine's scene builder produced (core/frame_scene.hpp
/// `RenderJob::built`) into a slot through the render graph. Created and used
/// on the render thread only, on the render thread's device; implemented in
/// engine_frames (scene/engine_frames.cpp) so this library stays free of the
/// render graph, the rasters and the media code.
/// Footage frames a draw wanted but drew from a stand-in (or skipped): (media
/// source, frame). Opaque to the render thread — the drawer reads them back.
using MediaWants = std::vector<std::pair<std::uint32_t, std::int64_t>>;

class BuiltFrameDrawer {
 public:
  BuiltFrameDrawer() = default;
  virtual ~BuiltFrameDrawer() = default;
  BuiltFrameDrawer(const BuiltFrameDrawer&) = delete;
  BuiltFrameDrawer& operator=(const BuiltFrameDrawer&) = delete;
  BuiltFrameDrawer(BuiltFrameDrawer&&) = delete;
  BuiltFrameDrawer& operator=(BuiltFrameDrawer&&) = delete;

  /// Encode + submit the frame into `target` (RGBA8Unorm, width × height).
  /// The frame is the render thread's once submitted: a draw fills its texture
  /// refs in place (BuiltFrame::asBuilt) instead of copying it.
  virtual bool draw(BuiltFrame& frame, const wgpu::TextureView& target, std::uint32_t width,
                    std::uint32_t height, std::string& error) = 0;

  /// D4: the frame's content key for the frame cache (frame_cache.hpp) — equal
  /// keys draw identical pixels into a width × height slot. nullopt = do not cache.
  [[nodiscard]] virtual std::optional<std::uint64_t> content_key(const BuiltFrame& /*frame*/, std::uint32_t /*width*/,
                                                                 std::uint32_t /*height*/) const {
    return std::nullopt;
  }
  /// The frame's key in the disk cache (disk_cache.hpp): content_key salted
  /// with what a file on disk outlives — the engine build, the loaded plugins'
  /// versions, the footage files' modification stamps. nullopt = never on disk.
  [[nodiscard]] virtual std::optional<std::uint64_t> disk_key(const BuiltFrame& /*frame*/, std::uint32_t /*width*/,
                                                              std::uint32_t /*height*/) {
    return std::nullopt;
  }
  /// What a pre-build ALIAS in the disk cache is salted with (disk_cache.hpp
  /// store_alias): the part of disk_key's salt the pre-build key cannot see
  /// and that is the same for every frame — the engine build and the loaded
  /// plugins. 0 = no aliases. Render thread.
  [[nodiscard]] virtual std::uint64_t alias_salt() { return 0; }
  /// Whether `frame` reads footage files: their stamps are in its disk key
  /// only, so such a frame never gets an alias (a replaced file must be a miss).
  [[nodiscard]] virtual bool reads_files(const BuiltFrame& /*frame*/) const { return true; }
  /// D4: whether the frame `draw` just drew is final — false when footage on
  /// it was drawn from a nearest decoded frame (or skipped) instead of the exact one.
  [[nodiscard]] virtual bool last_frame_exact() const { return false; }
  /// RenderJob::exactMedia for the next draw: footage waits for its exact frame.
  virtual void set_exact_media(bool /*exact*/) {}
  /// P7: idle work (pipeline warm-up) — whether there is some, and one step of it.
  [[nodiscard]] virtual bool warm_pending() const { return false; }
  virtual bool warm_step() { return false; }
  /// The footage frames the last draw wanted but did not have (a paused
  /// viewport's seek still decoding) — taken, so the next draw starts empty.
  [[nodiscard]] virtual MediaWants take_media_wants() { return {}; }
  /// Whether every frame in `wants` is decoded now (or never will be).
  [[nodiscard]] virtual bool media_settled(const MediaWants& /*wants*/) { return true; }
  /// The slowest footage source's decode time per frame, ms (render stats `decodeMs`).
  [[nodiscard]] virtual double decode_ms() const { return 0; }
  /// GPU memory the drawer holds (render graph targets and textures, converted footage), bytes.
  [[nodiscard]] virtual std::uint64_t vram_bytes() { return 0; }
  /// Video-memory pressure: give back at least `bytes` the last frame did not
  /// use (render graph targets and textures). Between frames. Returns bytes freed.
  virtual std::uint64_t trim_vram(std::uint64_t /*bytes*/) { return 0; }
  /// Sample the next frame drawn per root-level layer (gpu_profiler.hpp).
  virtual void profile_next_frame() {}
  /// A sample finished since the last call (taken: each is returned once).
  [[nodiscard]] virtual std::optional<LayerProfile> take_layer_profile() { return std::nullopt; }

  /// getThumbnail: draw `frame` offscreen at width × height and encode it
  /// (StillImage). False (with `error`) when it cannot.
  virtual bool draw_still(BuiltFrame& /*frame*/, std::uint32_t /*width*/, std::uint32_t /*height*/,
                          StillImage& /*out*/, std::string& error) {
    error = "this drawer cannot draw stills";
    return false;
  }
  /// readPixels: `region` of `frame` (drawn for a width × height slot) in
  /// working space — the frame is drawn again offscreen, then read.
  virtual bool read_working(BuiltFrame& /*frame*/, std::uint32_t /*width*/, std::uint32_t /*height*/,
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
  /// The disk cache takes frames that draw slower than this (ms); negative =
  /// measured (RenderThread::worth_disk), 0 = every exact frame (tests).
  double diskCacheMinDrawMs = -1;
  /// The RAM tier's size limit (render/ram_cache.hpp) until setCacheBudget
  /// says otherwise; 0 = sized from the machine (auto_ram_budget).
  std::uint64_t ramCacheBytes = 0;
  bool highPerformance = false;
  /// Dawn's blob cache folder (gpu.hpp create_gpu): compiled shaders and
  /// pipeline state kept across launches. Empty = compile every launch.
  std::string shaderCacheDir;
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
  [[nodiscard]] bool job_pending(std::uint32_t viewport) const override;
  void note_dropped(std::uint32_t viewport, std::uint32_t skipped, std::uint32_t clockJumped) override;
  void configure(const ViewportConfig& config) override;
  void set_shared(bool shared) override;
  [[nodiscard]] bool shared_supported() const override;
  void set_copy(bool copy) override;
  [[nodiscard]] bool copy_supported() const override;
  [[nodiscard]] RenderCounters counters() const override;
  [[nodiscard]] PortCounters port_counters(std::uint32_t viewport) const override;
  void set_filling(bool filling) override { filling_.store(filling, std::memory_order_relaxed); }
  [[nodiscard]] bool slots_copyable() const override { return slotsCopyable_.load(std::memory_order_relaxed); }
  [[nodiscard]] std::string adapter() const override;
  [[nodiscard]] std::string backend() const override;
  /// D4: the frame cache's counters (zeros when the cache is off).
  [[nodiscard]] FrameCacheStats cache_stats() const;
  [[nodiscard]] CacheCoverageSnap cache_coverage() const override;
  void request_layer_profile() override;
  [[nodiscard]] std::optional<LayerProfile> layer_profile() const override;
  void publish_coverage_now() override;
  void purge_frame_cache() override;
  void configure_disk_cache(const std::string& folder, std::uint64_t bytes) override;
  void purge_disk_cache() override;
  void configure_ram_cache(std::uint64_t bytes) override;
  /// Cached playback without a build (coverage_ledger.hpp): the pre-build map
  /// the core thread asks, the revision steps the bars carry over, and the
  /// viewports whose cached job found no tier holding it.
  [[nodiscard]] std::optional<CachedKeys> cached_frame(std::uint64_t key) const override;
  void note_frames_changed(FrameRevision rev) override;
  [[nodiscard]] std::vector<std::uint32_t> take_build_requests() override;
  /// The disk cache's counters.
  [[nodiscard]] DiskCacheStats disk_stats() const { return disk_->stats(); }
  /// The RAM tier's counters (as of the last frame).
  [[nodiscard]] RamCacheStats ram_stats() const;
  /// Run on the render thread between frames (below).
  [[nodiscard]] std::future<StillImage> render_still(std::shared_ptr<BuiltFrame> frame, std::uint32_t width,
                                                     std::uint32_t height) override;
  [[nodiscard]] std::future<WorkingPixels> read_pixels(std::uint32_t viewport, PixelRegion region) override;
  [[nodiscard]] std::future<WorkingPixels> read_frame(std::shared_ptr<BuiltFrame> frame, std::uint32_t width,
                                                      std::uint32_t height) override;

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
    std::uint64_t rendered = 0;             // m_: FrameReady announced for this viewport (port_counters)
    std::uint64_t standIn = 0;              // m_: of those, drawn with a stand-in
    /// shared_ptr: release() (the frame-channel reader thread) holds it past
    /// m_ while the render thread may retire the port.
    std::shared_ptr<FrameRing> ring = std::make_shared<FrameRing>();
    // Render-thread only.
    std::unique_ptr<SlotSet> slots;
    /// The job drawn last, drawn again on a recovered device (and read by readPixels).
    std::optional<RenderJob> lastJob;
    /// The content key of the frame this viewport shows now (0 = none / unkeyed):
    /// pinned in every tier while it is shown (ProtectedRange::pinned), so a
    /// store for another view never evicts it and this view never blinks.
    std::uint64_t lastKey = 0;
    /// Paused footage drawn from a stand-in: the frames still decoding. The
    /// last job is drawn again once they are (polled every kSettlePoll), so a
    /// seek always ends on its exact frame — AE's "the frame resolves".
    MediaWants settling;
    std::chrono::steady_clock::time_point settleAt{};
    std::uint32_t settleTries = 0;
  };
  static constexpr std::chrono::milliseconds kSettlePoll{12};
  static constexpr std::uint32_t kMaxSettleTries = 2500;  // ~30 s of polling, then the stand-in stays
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
  /// render() without its exception barrier (the body; the slot joins inflight_ last).
  void render_guarded(Port& port, RenderJob& job, std::uint32_t slot, const ViewportConfig& config);
  /// Idle render-ahead (RenderJob::prefetch): draw the job into a scratch
  /// target (comp-space or slot-sized), store it in the tiers, announce
  /// nothing. Exception barrier included. Render thread.
  void render_prefetch(RenderJob& job);
  struct InFlight;
  /// Where a frame's pixels go: the slot, or a comp-space texture (comp_target).
  struct FrameTarget {
    const wgpu::Texture* texture = nullptr;
    const wgpu::TextureView* view = nullptr;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
  };
  /// serve_or_draw's answer.
  struct Served {
    bool drawn = false;   ///< the target holds the frame (served from a tier or drawn)
    bool missing = false; ///< a cached job (no build) that no tier holds any more: the session was asked to build it
    std::optional<std::uint64_t> key;  ///< the frame's content key, when it has one
    /// The texture holding the frame's pixels: the target, or the VRAM cache's
    /// own texture when a hit was not copied (`copyHit` false) — valid until the next store.
    const wgpu::Texture* source = nullptr;
  };
  /// The cache tiers around one frame: served from VRAM / RAM / disk when a
  /// tier holds its content key, else drawn by the drawer into `target` and
  /// stored. `copyHit` false leaves a VRAM hit in the cache's texture (the
  /// caller copies a region of it). Fills `f` (draw time, disk read-back,
  /// VRAM key). Render thread.
  Served serve_or_draw(RenderJob& job, const FrameTarget& target, bool copyable, bool copyHit, InFlight& f);
  /// Comp-space present: the slot cleared to the frame's border colour where
  /// the comp does not reach, and the comp-space texture copied in at its
  /// integer offset (no resampling). Render thread.
  void present_comp_space(const CompSpaceFrame& cs, const wgpu::Texture& source, const wgpu::Texture& slot,
                          const wgpu::TextureView& slotView, std::uint32_t width, std::uint32_t height);
  /// A reusable comp-space render target of this size (a few sizes kept: one per open view's scale).
  struct CompTarget {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    wgpu::Texture texture;
    wgpu::TextureView view;
    std::uint64_t lastUse = 0;
  };
  [[nodiscard]] FrameTarget comp_target(std::uint32_t width, std::uint32_t height);
  std::vector<CompTarget> compTargets_;  // render thread only
  std::uint64_t compTargetUse_ = 0;
  static constexpr std::size_t kCompTargetsKept = 4;
  /// Render thread only: every open viewport's current frame key (Port::lastKey)
  /// re-pinned in the RAM and VRAM tiers' protection (ProtectedRange::pinned).
  void apply_pins();
  /// A viewport's current frame changed to `key`: pin it (and unpin the one before).
  void note_view_key(Port& port, std::uint64_t key);
  /// P5: a frame submitted to the GPU, announced (FrameReady) once its work is
  /// done — the render thread does not wait for it, so the next frame's CPU
  /// work (rasters, encoding) overlaps this frame's GPU work.
  /// A job's frame size in a slot set: its preview-resolution size (RenderJob::contentWidth), at most the slot's.
  [[nodiscard]] static std::pair<std::uint32_t, std::uint32_t> content_size(const RenderJob& job, const SlotSet& set) noexcept;
  struct InFlight {
    std::uint32_t contentWidth = 0;  ///< drawn into the slot's corner at this size (preview resolution); 0 = the whole slot
    std::uint32_t contentHeight = 0;
    Port* port = nullptr;
    std::uint32_t generation = 0;
    std::uint32_t slot = 0;
    bool copy = false;
    wgpu::Future done{};
    std::chrono::steady_clock::time_point t0{};
    api::FrameReady ready;
    std::vector<api::FrameGeometry> geometry;
    /// The drawn frame read back for the disk cache (null = not written).
    wgpu::Buffer diskBuffer;
    std::uint64_t diskKey = 0;
    std::uint32_t diskRow = 0;  // bytes per row in diskBuffer (256-aligned)
    /// Drawn by the drawer (not a VRAM or disk copy): its time is a draw cost.
    bool drawn = false;
    /// RenderJob::buildMs: the CPU half of the frame's cost (the GPU half is timed here).
    double buildMs = 0;
    /// Drawn while playing with footage from a nearest decoded frame (RenderCounters::inexact).
    bool inexact = false;
    /// Drawn with any stand-in, playing or not (RenderCounters::standIn).
    bool standIn = false;
    /// Served from a cache tier (VRAM, RAM, disk) instead of drawn.
    bool cached = false;
    /// The frame's VRAM cache key when it was stored there: its draw time is filled in once known.
    std::optional<std::uint64_t> vramKey;
    /// An exact frame kept in VRAM with no read-back queued: its keys, so it
    /// can still go to disk once its own draw time says it is worth it.
    std::optional<std::pair<std::uint64_t, std::uint64_t>> lateDisk;  // {VRAM key, disk key}
    /// The frame's own pixel size (the comp-space texture's, or the slot's): what the tiers hold.
    std::uint32_t frameWidth = 0;
    std::uint32_t frameHeight = 0;
    /// RenderJob::prefetch: no slot, no FrameReady; counted in RenderCounters::prefetched when done.
    bool prefetch = false;
  };
  /// A frame on its way to the disk cache from its VRAM copy (queue_late_spill).
  struct Spill {
    wgpu::Buffer buffer;
    wgpu::Future done{};
    std::uint64_t diskKey = 0;
    std::uint32_t row = 0;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
  };
  /// Announce finished frames, oldest first (submission order); `block` waits
  /// for the oldest one. Render thread only. Returns how many were finished.
  std::size_t complete_frames(bool block);
  /// Every frame in flight finished (before slots change, queries, teardown).
  void complete_all();
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
  /// m_: the render-ahead jobs waiting their turn, oldest first (the session's
  /// prefetch workers build several side by side); past kPrefetchQueue the oldest is answered as a drop.
  std::deque<RenderJob> prefetch_;
  static constexpr std::size_t kPrefetchQueue = 4;
  /// Every open viewport's slots take copies (FrameSink::slots_copyable); recomputed by rebuild.
  std::atomic<bool> slotsCopyable_{true};
  /// Query work for the render thread (render_still, read_pixels), run
  /// between frames in arrival order; drained (answered) on stop.
  std::deque<std::function<void()>> tasks_;

  // Render-thread-only state.
  std::deque<InFlight> inflight_;  // P5: submitted, not yet announced
  bool lastJobPlaying_ = false;    // the last job drawn was playback (RenderJob::playing): no warm-up
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
  /// FrameSink::set_filling: a cache fill is running (worth_disk says yes to every frame).
  std::atomic<bool> filling_{false};
  /// An integrated GPU's frame-cache budget comes out of system memory — the
  /// same memory the RAM tier is sized from (manage_ram_budget takes it off).
  std::uint64_t sharedVramBudget_ = 0;
  FrameCacheStats cacheStats_;
  /// The OS's video-memory budget for this process, read live (relieve_gpu_pressure).
  /// Null where the OS does not say (render thread only).
  std::unique_ptr<GpuMemoryProbe> gpuProbe_;
  /// The frame cache's budget as configured: pressure lowers the live one, and it grows back to this.
  std::size_t vramCacheBase_ = 0;
  /// getRenderStats profileLayers: arm the drawer's profiler before the next draw.
  std::atomic<bool> profileWanted_{false};
  /// The newest per-layer sample (m_).
  std::optional<LayerProfile> layerProfile_;
  std::chrono::steady_clock::time_point lastGpuProbe_{};
  wgpu::Texture onionTex_;
  wgpu::TextureView onionView_;
  std::uint32_t onionW_ = 0;
  std::uint32_t onionH_ = 0;
  void composite_onion(const RenderJob& job, const wgpu::TextureView& slot, std::uint32_t width, std::uint32_t height);
  /// Render thread only: `job`'s frame is cached as `key` (VRAM / RAM) and, when
  /// not 0, `diskKey` (disk) — under its viewport's scope (RenderJob::cacheScope).
  void note_coverage(const RenderJob& job, std::uint64_t key, std::uint64_t diskKey);
  void publish_coverage();
  /// Publish now unless it was done in the last kCoverageEvery (the timeline samples at 10 Hz).
  void publish_coverage_soon();
  static constexpr std::chrono::milliseconds kCoverageEvery{50};
  bool coverageStale_ = false;
  std::chrono::steady_clock::time_point coveragePublishedAt_{};
  /// Render thread only — the bars (coverage_ledger.hpp): per viewport, per
  /// cache scope, frame index → keys. A frame counts while a tier still holds it.
  CoverageLedger ledger_;
  /// Pre-build key → the keys its build produced (any thread; the core thread asks).
  PrebuildMap prebuild_;
  /// BuiltFrameDrawer::alias_salt as of the last frame drawn (0 until one is):
  /// read by `cached_frame` on the core thread to find a frame an earlier
  /// session left on disk.
  std::atomic<std::uint64_t> aliasSalt_{0};
  /// m_: revision steps from the core thread, taken into the ledger by the render thread before each frame.
  std::deque<FrameRevision> revisionsIn_;
  /// m_: viewports owed a built frame (a cached job no tier held; a pixel read of a cached frame).
  std::vector<std::uint32_t> buildWanted_;
  void take_revisions();
  void want_build(std::uint32_t viewport);
  /// Whether a tier (VRAM, RAM, disk) still holds the frame with these keys.
  [[nodiscard]] bool tier_holds(const CachedKeys& keys) const;

  /// The RAM tier (AE's RAM cache). Outlives device losses: it holds no GPU objects.
  RamFrameCache ram_;
  /// m_: the RAM budget setCacheBudget asked for (0 = auto); the render thread applies it.
  std::uint64_t ramBudgetAsked_ = 0;
  bool ramBudgetDirty_ = true;
  /// Render thread only: the budget in force before memory pressure (auto or asked).
  std::uint64_t ramBudgetTarget_ = 0;
  std::chrono::steady_clock::time_point memoryCheckedAt_{};
  /// Apply a new RAM budget, and shrink it while the machine is short of memory (checked at most once a second).
  void manage_ram_budget(bool force);
  /// Render thread only: the play range of the latest coverage job (the RAM tier keeps its frames).
  ProtectedRange protect_;
  /// A frame the VRAM cache evicted, on its way into the RAM tier (or, when that
  /// is full of the range being played, to the disk tier) from a read-back.
  struct Victim {
    wgpu::Buffer buffer;
    wgpu::Future done{};
    std::uint64_t key = 0;
    std::uint32_t row = 0;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    FrameMeta meta;
    /// The RAM tier would not keep it: the read-back is for the disk tier only.
    bool diskOnly = false;
  };
  /// Render thread only: submitted victims, oldest first; and those encoded
  /// into the store being built (their `done` is set once it is submitted).
  std::deque<Victim> victims_;
  std::vector<Victim> victimsEncoding_;
  static constexpr std::size_t kMaxVictims = 6;
  /// VRAM eviction hook (FrameCache::EvictHook): read the frame back for the lower tiers when they want it.
  void on_vram_evict(const FrameCache::Evicted& ev, wgpu::CommandEncoder& encoder);
  /// Store `source` in the VRAM cache as `key`, its evictions read back for the RAM tier.
  void store_vram(std::uint64_t key, const wgpu::Texture& source, std::uint32_t width, std::uint32_t height,
                  const FrameMeta& meta);
  /// Video-memory pressure, about once a second between frames: read the OS
  /// budget; past kGpuHigh of it, shrink the frame cache (its frames demote to
  /// the RAM tier, nothing re-renders) and then give back targets and textures
  /// the last frame did not use, until the process is under the line again.
  /// Below kGpuLow the frame cache grows back toward vramCacheBase_. Pixels
  /// never change: no isolated precomp or effect falls back under pressure.
  void relieve_gpu_pressure();
  /// Resize the VRAM tier, its evictions read back for the RAM tier (as store_vram's).
  void resize_vram_cache(std::size_t budget);
  /// Hand finished victim read-backs to the RAM (or disk) tier; `block` waits for the oldest.
  void drain_victims(bool block);
  /// A key whose read-back is still in flight: wait for it (true = it was one).
  bool settle_victim(std::uint64_t key);
  /// Frames the RAM tier evicted: the slow ones not on disk yet go to the disk tier.
  void spill_ram_evictions(std::vector<RamFrame>& evicted);
  /// A frame in no other tier that the disk writer refused at its hard cap
  /// (DiskCache::StoreResult::refused): kept here and offered again once the
  /// writers catch up, instead of being lost. Bounded by kMaxDiskRetryBytes;
  /// past it the oldest go (counted in the disk stats as dropped by the caller).
  struct DiskRetry {
    std::uint64_t key = 0;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::vector<std::uint8_t> rgba;
  };
  std::deque<DiskRetry> diskRetry_;
  std::size_t diskRetryBytes_ = 0;
  static constexpr std::size_t kMaxDiskRetryBytes = std::size_t{1} << 30U;  // 1 GiB
  /// Hand `rgba` to the disk tier; a refusal parks it in diskRetry_.
  void offer_disk(std::uint64_t key, std::uint32_t width, std::uint32_t height, std::vector<std::uint8_t>& rgba);
  /// Offer the parked frames again, oldest first, until the writer refuses.
  void retry_disk();
  /// Encode a copy of `source` into a pooled read-back buffer (onto `encoder`); `row` = its bytes per row.
  wgpu::Buffer encode_readback(const wgpu::Texture& source, std::uint32_t width, std::uint32_t height,
                               std::uint32_t& row, wgpu::CommandEncoder& encoder);
  /// A mapped read-back's rows, tightly packed (false = the map failed). The buffer goes back to the pool.
  bool take_readback(wgpu::Buffer buffer, std::uint32_t row, std::uint32_t width, std::uint32_t height,
                     std::vector<std::uint8_t>& out);
  RamCacheStats ramStats_;  // m_

  /// The disk tier (AE's Disk Cache). Outlives device losses: it holds no GPU objects.
  std::unique_ptr<DiskCache> disk_ = std::make_unique<DiskCache>();
  /// Disk hit: the file's pixels into the slot. False = a miss after all.
  bool load_from_disk(std::uint64_t diskKey, std::uint32_t width, std::uint32_t height, const wgpu::Texture& target);
  /// Encode and submit a copy of `source` into a read-back buffer (pooled); `row` = its bytes per row.
  wgpu::Buffer encode_disk_readback(const wgpu::Texture& source, std::uint32_t width, std::uint32_t height,
                                    std::uint32_t& row);
  /// Encode a copy of the drawn slot into a read-back buffer for the disk cache (onto `f`).
  void queue_disk_readback(InFlight& f, std::uint64_t diskKey, const wgpu::Texture& source, std::uint32_t width,
                           std::uint32_t height);
  /// A finished frame's read-back pixels to the disk cache's writer; the buffer back to the pool.
  void spill_to_disk(InFlight& f, std::uint32_t width, std::uint32_t height);
  /// A read-back buffer whose copy is done → the disk cache's writer (`diskKey` is reserved).
  void write_disk_readback(wgpu::Buffer buffer, std::uint32_t row, std::uint64_t diskKey, std::uint32_t width,
                           std::uint32_t height);
  /// A frame that drew slowly with no read-back queued (the prediction said
  /// fast — a first frame, a spike): read it back from its VRAM copy.
  void queue_late_spill(std::uint64_t key, std::uint64_t diskKey, std::uint32_t width, std::uint32_t height);
  /// Hand finished late spills to the writer; `block` waits for the oldest.
  void drain_spills(bool block);
  /// A frame dropped before its pixels reached the writer: give up its disk reservation.
  void abandon_disk(InFlight& f);
  /// Every read-back in flight (frames and late spills) given up.
  void abandon_all_disk();
  /// Render thread only: late spills submitted, oldest first.
  std::deque<Spill> spills_;
  /// Late spills in flight past this: wait for the oldest (each holds a frame-sized buffer).
  static constexpr std::size_t kMaxSpills = 4;
  /// Render thread only: a disk hit's pixels (reused: a frame is megabytes).
  std::vector<std::uint8_t> diskScratch_;
  /// Render thread only: read-back buffers for the disk cache, reused while the slot size holds.
  std::vector<wgpu::Buffer> diskSpare_;
  std::uint64_t diskSpareSize_ = 0;
  /// Render thread only: frames were handed to the writer since the last publish.
  bool diskCoverageStale_ = false;
  /// Render thread only — AE writes only frames that are slow to render: a
  /// frame goes to disk when drawing it costs clearly more than reading it
  /// back would (worth_disk). Both sides are measured: each drawn frame's own
  /// cost (render start → GPU done), decided once it is done, and the disk
  /// read cost per megapixel (file read + decode + upload), as a moving
  /// average seeded by the disk cache's own measured read (DiskCache::read_ms_per_mp).
  /// The running averages below only pick frames to read back eagerly, from
  /// the slot; a frame they miss still goes, late, from its VRAM copy.
  double drawMsAvg_ = 0;
  double lastDrawMs_ = 0;
  double diskReadMsPerMp_ = 2.0;  // ~4 ms for a 1080p hit on an NVMe SSD (read, strip decode, upload), until one is measured
  /// diskReadMsPerMp_ is a measurement (a hit, or the cache's seed), not the guess above.
  bool diskReadMeasured_ = false;
  /// The guess replaced by the disk cache's measured read (+ the upload, which the cache cannot time).
  void seed_disk_read_cost();
  [[nodiscard]] bool worth_disk(double drawMs, std::uint32_t width, std::uint32_t height) const;
  CacheCoverageSnap coverage_;
  std::uint64_t windowFrames_ = 0;
  std::uint64_t windowCached_ = 0;
  double windowGpuMs_ = 0;
  std::chrono::steady_clock::time_point windowStart_ = std::chrono::steady_clock::now();
  std::string adapter_;
  std::string backend_;
  bool sharedCapable_ = false;
};

}  // namespace premation::render
