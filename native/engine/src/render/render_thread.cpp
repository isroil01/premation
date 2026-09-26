#include "render_thread.hpp"

#include <algorithm>
#include <string>
#include <utility>

#include "log.hpp"
#include "os_ffi.hpp"

#ifdef _WIN32
#include "shared_texture_ffi.hpp"
#endif

namespace premation::render {
namespace {

using SteadyClock = std::chrono::steady_clock;

/// How long a replaced ring stays alive: long enough for the host to have
/// imported (and Chromium to have finished sampling) anything announced from
/// it before the resize.
constexpr auto kRetireGrace = std::chrono::seconds(2);

}  // namespace

struct RenderThread::SlotSet {
  std::uint32_t generation = 0;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  bool shared = false;
  /// Every slot allows copies in and out (the D4 frame cache).
  bool copyable = true;
  std::vector<wgpu::Texture> textures;  // every slot's texture (offscreen, or the shared slot's own)
  std::vector<wgpu::TextureView> views;
#ifdef _WIN32
  std::unique_ptr<shared::SharedTexturePool> pool;
#endif
  SteadyClock::time_point retiredAt{};

  SlotSet() = default;
  ~SlotSet() {
#ifdef _WIN32
    if (pool) pool->close_remote_handles();
#endif
  }
  SlotSet(const SlotSet&) = delete;
  SlotSet& operator=(const SlotSet&) = delete;
  SlotSet(SlotSet&&) = delete;
  SlotSet& operator=(SlotSet&&) = delete;
};

RenderThread::RenderThread(RenderOptions options, SendFrames send, OnFatal onFatal)
    : options_(options), send_(std::move(send)), onFatal_(std::move(onFatal)) {
  options_.slots = std::clamp<std::uint32_t>(options_.slots, 2, frames::kMaxSlots);
  ring_.on_release([this] {
    const std::lock_guard<std::mutex> lock(m_);
    cv_.notify_all();
  });
}

RenderThread::~RenderThread() { stop(); }

bool RenderThread::start(std::string& error) {
  std::promise<std::string> ready;
  std::future<std::string> result = ready.get_future();
  // The promise moves into the thread: set_value may still be unwinding when
  // get() returns here, so it must not live in this frame.
  thread_ = std::thread([this, p = std::move(ready)]() mutable { run(p); });
  error = result.get();
  if (!error.empty()) {
    thread_.join();
    return false;
  }
  return true;
}

void RenderThread::stop() {
  {
    const std::lock_guard<std::mutex> lock(m_);
    quit_ = true;
  }
  cv_.notify_all();
  if (thread_.joinable()) thread_.join();
}

void RenderThread::submit(RenderJob job) {
  {
    const std::lock_guard<std::mutex> lock(m_);
    if (pending_) {
      ++counters_.dropped;  // superseded before it started: the newest frame wins
      ++droppedPending_;
    }
    droppedPending_ += job.clockDropped;
    pending_ = std::move(job);
  }
  cv_.notify_all();
}

void RenderThread::configure(const ViewportConfig& config) {
  {
    const std::lock_guard<std::mutex> lock(m_);
    if (config == config_) return;
    const bool ring = ring_config_changed(config_, config);
    config_ = config;
    // D5: a camera-only change keeps the ring (ring_config_changed).
    if (!ring) return;
    configDirty_ = true;
  }
  cv_.notify_all();
}

void RenderThread::set_shared(bool shared) {
  {
    const std::lock_guard<std::mutex> lock(m_);
    if (shared_ == shared) return;
    shared_ = shared;
    configDirty_ = true;
  }
  cv_.notify_all();
}

bool RenderThread::shared_supported() const {
  const std::lock_guard<std::mutex> lock(m_);
  return sharedCapable_;
}

RenderCounters RenderThread::counters() const {
  const std::lock_guard<std::mutex> lock(m_);
  return counters_;
}

std::string RenderThread::adapter() const {
  const std::lock_guard<std::mutex> lock(m_);
  return adapter_;
}

std::string RenderThread::backend() const {
  const std::lock_guard<std::mutex> lock(m_);
  return backend_;
}

FrameCacheStats RenderThread::cache_stats() const {
  const std::lock_guard<std::mutex> lock(m_);
  return cacheStats_;
}

std::string RenderThread::open_gpu() {
#ifdef _WIN32
  const bool wantShared = options_.hostPid != 0;
#else
  const bool wantShared = false;
#endif
  gpu_ = create_gpu(wantShared, options_.highPerformance, options_.vendorId);
  if (!gpu_) return "no GPU adapter / device (Dawn)";
  compositor_ = std::make_unique<Compositor>();
  if (!compositor_->init(*gpu_)) return "compositor pipelines failed to build";
  if (options_.makeDrawer) {
    // D2w: the render graph over the engine's own document. A drawer that
    // cannot start leaves C2's quad compositor in charge (logged, not fatal).
    std::string error;
    drawer_ = options_.makeDrawer(*gpu_, error);
    if (!drawer_) {
      PREMATION_LOG(warn, "scene_drawer_failed").kv("error", error);
    }
  }
  if (drawer_ && options_.frameCacheBytes != 0) {
    // D4: only built frames have content keys; C2's quads are never cached.
    std::size_t budget = options_.frameCacheBytes;
    if (budget == kFrameCacheAuto) {
      wgpu::AdapterInfo info{};
      gpu_->adapter.GetInfo(&info);
      budget = default_frame_cache_budget(info.vendorID, info.deviceID);
    }
    cache_ = std::make_unique<FrameCache>(gpu_->device, budget);
    PREMATION_LOG(info, "frame_cache").kv("budgetMB", static_cast<double>(budget) / (1024.0 * 1024.0));
  }
  PREMATION_LOG(info, "gpu_ready")
      .kv("adapter", gpu_->adapterName)
      .kv("backend", gpu_->backend)
      .kv("sharedTexture", gpu_->sharedTextureCapable)
      .kv("slots", options_.slots);
  const std::lock_guard<std::mutex> lock(m_);
  adapter_ = gpu_->adapterName;
  backend_ = gpu_->backend;
  sharedCapable_ = wantShared && gpu_->sharedTextureCapable;
  return {};
}

void RenderThread::close_gpu() {
  if (gpu_) wait_idle(*gpu_);
  slots_.reset();
  retired_.clear();
  cache_.reset();
  drawer_.reset();
  compositor_.reset();
  gpu_.reset();
}

bool RenderThread::recover_device() {
  ++lossesSinceFrame_;
  PREMATION_LOG(error, "device_lost").kv("losses", lossesSinceFrame_);
  close_gpu();
  if (lossesSinceFrame_ > kMaxDeviceRecoveries) return false;
  if (std::string error = open_gpu(); !error.empty()) {
    PREMATION_LOG(error, "device_recovery_failed").kv("error", error);
    close_gpu();
    return false;
  }
  return true;
}

void RenderThread::run(std::promise<std::string>& ready) {
  if (std::string error = open_gpu(); !error.empty()) {
    close_gpu();
    ready.set_value(std::move(error));
    return;
  }
  ready.set_value({});

  std::unique_lock<std::mutex> lock(m_);
  for (;;) {
    cv_.wait_for(lock, std::chrono::milliseconds(500), [this] {
      return quit_ || configDirty_ || !tasks_.empty() || (pending_ && config_.open && slots_ && ring_.any_free());
    });
    if (quit_) break;
    if (gpu_->device_lost()) {
      lock.unlock();
      const bool recovered = recover_device();
      if (!recovered && onFatal_) onFatal_("GPU device lost");
      lock.lock();
      if (!recovered) break;
      // New slots (a new generation the host imports), and the last frame
      // again unless a newer one is waiting: the viewport is never left blank.
      configDirty_ = true;
      if (!pending_) std::swap(pending_, lastJob_);
      continue;
    }
    const auto now = SteadyClock::now();
    if (!retired_.empty()) {
      lock.unlock();
      collect_retired(now);
      lock.lock();
    }
    if (configDirty_) {
      configDirty_ = false;
      const ViewportConfig config = config_;
      const bool shared = shared_;
      lock.unlock();
      rebuild(config, shared);
      lock.lock();
      continue;
    }
    if (!tasks_.empty()) {
      // Queries between frames: a still or a pixel read never waits behind a
      // playing viewport for more than the frame in hand.
      run_tasks(lock);
      continue;
    }
    if (!pending_ || !config_.open || !slots_) continue;
    const std::optional<std::uint32_t> slot = ring_.acquire();
    if (!slot) continue;  // every slot is with the host: keep the newest job until one returns
    RenderJob job = std::move(*pending_);
    pending_.reset();
    job.clockDropped = droppedPending_;
    droppedPending_ = 0;
    const ViewportConfig config = config_;
    lock.unlock();
    render(job, *slot, config);
    lastJob_ = std::move(job);
    lock.lock();
  }
  // Queries still queued are dropped: their futures report a broken promise,
  // which the core answers as an internal error (the engine is stopping).
  tasks_.clear();
  lock.unlock();
  // Tear down on this thread, which created everything.
  close_gpu();
}

void RenderThread::post(std::function<void()> task) {
  {
    const std::lock_guard<std::mutex> lock(m_);
    if (quit_) return;  // the task (and its promise) is dropped: a broken promise
    tasks_.push_back(std::move(task));
  }
  cv_.notify_all();
}

void RenderThread::run_tasks(std::unique_lock<std::mutex>& lock) {
  while (!tasks_.empty()) {
    std::function<void()> task = std::move(tasks_.front());
    tasks_.pop_front();
    lock.unlock();
    task();
    lock.lock();
  }
}

std::future<StillImage> RenderThread::render_still(std::shared_ptr<BuiltFrame> frame, std::uint32_t width,
                                                   std::uint32_t height) {
  // shared_ptr: std::function needs a copyable closure; the promise is set
  // exactly once, on the render thread, and read through its future.
  auto promise = std::make_shared<std::promise<StillImage>>();
  std::future<StillImage> result = promise->get_future();
  post([this, promise, frame = std::move(frame), width, height] {
    StillImage out;
    if (!frame || !drawer_) {
      out.answer = HookAnswer::unsupported;
      out.error = frame ? "the render graph did not start on this GPU (C2 quads only)" : "no frame to draw";
    } else if (width == 0 || height == 0) {
      out.answer = HookAnswer::failed;
      out.error = "an empty still";
    } else {
      std::string error;
      if (drawer_->draw_still(*frame, width, height, out, error)) {
        out.answer = HookAnswer::ready;
      } else {
        out = StillImage{};
        out.answer = HookAnswer::failed;
        out.error = std::move(error);
        PREMATION_LOG(warn, "still_failed").kv("error", out.error);
      }
    }
    promise->set_value(std::move(out));
  });
  return result;
}

std::future<WorkingPixels> RenderThread::read_pixels(std::uint32_t viewport, PixelRegion region) {
  // shared_ptr: as render_still.
  auto promise = std::make_shared<std::promise<WorkingPixels>>();
  std::future<WorkingPixels> result = promise->get_future();
  post([this, promise, viewport, region] {
    WorkingPixels out;
    if (!lastJob_ || lastJob_->viewport != viewport || !slots_) {
      out.answer = HookAnswer::pending;
      out.error = "viewport " + std::to_string(viewport) + " has shown no frame yet";
    } else if (!lastJob_->built || !drawer_) {
      out.answer = HookAnswer::unsupported;
      out.error = "the viewport shows C2 quads: there is no working-space frame to read";
    } else {
      // The ring may have been rebuilt since the core clamped the region.
      PixelRegion r = region;
      r.x = std::min(r.x, slots_->width);
      r.y = std::min(r.y, slots_->height);
      r.width = std::min(r.width, slots_->width - r.x);
      r.height = std::min(r.height, slots_->height - r.y);
      std::string error;
      if (r.width == 0 || r.height == 0) {
        out.answer = HookAnswer::failed;
        out.error = "the region is outside the viewport";
      } else if (drawer_->read_working(*lastJob_->built, slots_->width, slots_->height, r, out, error)) {
        out.answer = HookAnswer::ready;
      } else {
        out = WorkingPixels{};
        out.answer = HookAnswer::failed;
        out.error = std::move(error);
        PREMATION_LOG(warn, "read_pixels_failed").kv("error", out.error);
      }
    }
    promise->set_value(std::move(out));
  });
  return result;
}

void RenderThread::rebuild(const ViewportConfig& config, bool shared) {
  auto next = std::make_unique<SlotSet>();
  next->generation = ++generation_;
  next->width = config.width;
  next->height = config.height;
  api::FrameSlots announce;
  announce.generation = next->generation;
  announce.viewport = config.viewport;
  announce.width = config.width;
  announce.height = config.height;
  std::uint32_t count = 0;
  if (config.open && config.width > 0 && config.height > 0) {
    count = options_.slots;
#ifdef _WIN32
    if (shared) {
      auto pool = std::make_unique<shared::SharedTexturePool>();
      std::string error;
      if (pool->init(*gpu_, config.width, config.height, count, options_.hostPid, error)) {
        next->shared = true;
        for (auto& s : pool->slots()) {
          next->views.push_back(s.view);
          next->textures.push_back(s.texture);
          next->copyable = next->copyable && s.copyable;
          announce.handles.push_back(s.remoteHandle);
        }
        next->pool = std::move(pool);
      } else {
        pool->close_remote_handles();  // the ones duplicated before the failure
        PREMATION_LOG(warn, "shared_slots_failed").kv("error", error);
      }
    }
#else
    (void)shared;
#endif
    if (!next->shared) {
      for (std::uint32_t i = 0; i < count; ++i) {
        wgpu::TextureDescriptor td{};
        td.size = {config.width, config.height, 1};
        td.format = wgpu::TextureFormat::RGBA8Unorm;
        // CopyDst: a frame-cache hit is copied in; CopySrc: a drawn frame is copied out to the cache.
        td.usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::CopySrc | wgpu::TextureUsage::CopyDst;
        wgpu::Texture t = gpu_->device.CreateTexture(&td);
        next->views.push_back(t.CreateView());
        next->textures.push_back(std::move(t));
        announce.handles.push_back(0);
      }
    }
  }
  announce.shared = next->shared;
  if (slots_) {
    slots_->retiredAt = SteadyClock::now();
    retired_.push_back(std::move(slots_));
  }
  slots_ = std::move(next);
  ring_.reset(slots_->generation, count);
  PREMATION_LOG(info, "slots")
      .kv("generation", slots_->generation)
      .kv("width", config.width)
      .kv("height", config.height)
      .kv("count", count)
      .kv("shared", slots_->shared);
  if (send_) send_(frames::Message{.v = std::move(announce)});
  const std::lock_guard<std::mutex> lock(m_);
  cv_.notify_all();
}

void RenderThread::collect_retired(SteadyClock::time_point now) {
  std::erase_if(retired_, [now](const std::unique_ptr<SlotSet>& s) { return now - s->retiredAt >= kRetireGrace; });
}

void RenderThread::render(RenderJob& job, std::uint32_t slot, const ViewportConfig& config) {
  SlotSet& set = *slots_;
  const double startUs = os::epoch_us();
  const auto t0 = SteadyClock::now();
#ifdef _WIN32
  shared::Slot* shared = set.pool ? &set.pool->slots()[slot] : nullptr;
  if (shared != nullptr && !set.pool->begin_access(*shared)) {
    PREMATION_LOG(error, "begin_access_failed").kv("slot", slot);
    ring_.unacquire(slot);
    return;
  }
#endif
  bool drawn = false;
  if (job.built && drawer_) {
    const wgpu::Texture& slotTexture = set.textures[slot];
    std::optional<std::uint64_t> key;
    if (cache_ && set.copyable) key = drawer_->content_key(*job.built, set.width, set.height);
    if (key) {
      // D4: the same content was drawn before — a copy instead of the frame.
      wgpu::CommandEncoder enc = gpu_->device.CreateCommandEncoder();
      if (cache_->copy_to(*key, set.width, set.height, slotTexture, enc)) {
        const wgpu::CommandBuffer cb = enc.Finish();
        gpu_->queue.Submit(1, &cb);
        drawn = true;
      }
    }
    if (!drawn) {
      std::string error;
      drawn = drawer_->draw(*job.built, set.views[slot], set.width, set.height, error);
      if (!drawn) {
        PREMATION_LOG(error, "scene_draw_failed").kv("error", error).kv("frame", job.frame);
      } else if (key && drawer_->last_frame_exact()) {
        wgpu::CommandEncoder enc = gpu_->device.CreateCommandEncoder();
        cache_->store(*key, set.width, set.height, slotTexture, enc);
        const wgpu::CommandBuffer cb = enc.Finish();
        gpu_->queue.Submit(1, &cb);
      }
    }
  }
  if (!drawn) {
    // C2's quads (a built frame that failed to draw has none: the slot clears to black).
    wgpu::CommandEncoder enc = gpu_->device.CreateCommandEncoder();
    compositor_->encode(enc, job.scene, set.views[slot], set.width, set.height, config.resolution);
    const wgpu::CommandBuffer cb = enc.Finish();
    gpu_->queue.Submit(1, &cb);
  }
#ifdef _WIN32
  if (shared != nullptr) (void)set.pool->end_access(*shared);
#endif
  // Electron's rgba sharedTexture import takes no fence, so a frame is
  // complete on the GPU before its slot is announced (docs/VIEWPORT_ROUTE.md,
  // implication 6). The ring keeps throughput; this costs latency only.
  wait_idle(*gpu_);
  if (gpu_->device_lost()) {
    // The slot holds nothing: never announced; the loop recovers and draws the job again.
    ring_.unacquire(slot);
    return;
  }
  lossesSinceFrame_ = 0;
  const double doneUs = os::epoch_us();
  const double gpuMs = std::chrono::duration<double, std::milli>(SteadyClock::now() - t0).count();

  api::FrameReady ready;
  ready.generation = set.generation;
  ready.slot = slot;
  ready.viewport = job.viewport;
  ready.dropped = job.clockDropped;
  ready.frame = job.frame;
  ready.time = job.time;
  ready.revision = job.revision;
  ready.render_start_us = startUs;
  ready.render_done_us = doneUs;
  ready.width = set.width;
  ready.height = set.height;
  if (send_) send_(frames::Message{.v = ready});

  const std::lock_guard<std::mutex> lock(m_);
  if (cache_) cacheStats_ = cache_->stats();
  ++counters_.rendered;
  ++windowFrames_;
  windowGpuMs_ += gpuMs;
  const auto now = SteadyClock::now();
  const double secs = std::chrono::duration<double>(now - windowStart_).count();
  if (secs >= 1.0) {
    counters_.fps = static_cast<double>(windowFrames_) / secs;
    counters_.gpuFrameMs = windowGpuMs_ / static_cast<double>(std::max<std::uint64_t>(windowFrames_, 1));
    windowFrames_ = 0;
    windowGpuMs_ = 0;
    windowStart_ = now;
  }
}

}  // namespace premation::render
