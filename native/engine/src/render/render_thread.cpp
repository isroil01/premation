#include "render_thread.hpp"

#include <algorithm>
#include <cstring>
#include <span>
#include <string>
#include <utility>

#include "log.hpp"
#include "overlay_geometry.hpp"
#include "os_ffi.hpp"
#include "premation/protocol/framing.hpp"
#include "premation/protocol/pixel_channel.hpp"

#if defined(PREMATION_SHARED_TEXTURE)
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
  /// Route A: every frame is read back into `readback[slot]` and sent on fd 5.
  bool copy = false;
  std::vector<wgpu::Buffer> readback;
  std::uint32_t readbackRow = 0;  // bytes per row in `readback` (256-aligned, WebGPU's copy rule)
  /// Every slot allows copies in and out (the D4 frame cache).
  bool copyable = true;
  std::vector<wgpu::Texture> textures;  // every slot's texture (offscreen, or the shared slot's own)
  std::vector<wgpu::TextureView> views;
#if defined(PREMATION_SHARED_TEXTURE)
  std::unique_ptr<shared::SharedTexturePool> pool;
#endif
  SteadyClock::time_point retiredAt{};

  SlotSet() = default;
  ~SlotSet() {
#if defined(PREMATION_SHARED_TEXTURE)
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
}

void RenderThread::release(std::uint32_t generation, std::uint32_t slot) {
  // Frame-pipeline trace: the host handed a slot back (the ring's pace).
  PREMATION_LOG(debug, "ft_release").kv("slot", slot);
  std::shared_ptr<FrameRing> ring;
  {
    const std::lock_guard<std::mutex> lock(m_);
    for (const auto& [id, port] : ports_) {
      if (port->ring->generation() == generation) {
        ring = port->ring;
        break;
      }
    }
  }
  // Outside m_: the ring's release hook takes m_ to wake the render thread.
  if (ring) (void)ring->release(generation, slot);
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
    const auto it = ports_.find(job.viewport);
    if (job.prefetch) {
      // Idle render-ahead: one waits at a time, drawn when no viewport has a
      // frame to draw (run). Replaced or orphaned = answered, as a drop.
      if (prefetch_ || it == ports_.end() || !it->second->config.open) ++counters_.prefetched;
      if (it == ports_.end() || !it->second->config.open) return;
      prefetch_ = std::move(job);
      cv_.notify_all();
      return;
    }
    if (it == ports_.end() || !it->second->config.open) {
      ++counters_.dropped;  // its viewport closed meanwhile: nowhere to show it
      if (job.cachedKey) ++counters_.cacheDropped;
      return;
    }
    Port& p = *it->second;
    if (p.pending) {
      ++counters_.dropped;  // superseded before it started: the newest frame wins
      if (p.pending->playing) ++p.droppedPending;  // a frame of playback lost (an edit's is not)
      if (p.pending->cachedKey) ++counters_.cacheDropped;
    }
    p.droppedPending += job.clockDropped;
    // Frame-pipeline trace (debug level): a job reaching the render thread.
    PREMATION_LOG(debug, "ft_submit").kv("rev", static_cast<std::uint64_t>(job.revision))
        .kv("free", p.ring ? p.ring->any_free() : false);
    p.pending = std::move(job);
  }
  cv_.notify_all();
}

bool RenderThread::job_pending(std::uint32_t viewport) const {
  const std::lock_guard<std::mutex> lock(m_);
  const auto it = ports_.find(viewport);
  return it != ports_.end() && it->second->pending.has_value();
}

void RenderThread::note_dropped(std::uint32_t viewport, std::uint32_t skipped, std::uint32_t clockJumped) {
  const std::lock_guard<std::mutex> lock(m_);
  const auto it = ports_.find(viewport);
  if (it == ports_.end()) return;
  it->second->droppedPending += skipped + clockJumped;
  counters_.dropped += skipped;
}

void RenderThread::configure(const ViewportConfig& config) {
  {
    const std::lock_guard<std::mutex> lock(m_);
    auto it = ports_.find(config.viewport);
    if (it == ports_.end()) {
      if (!config.open) return;  // closing a viewport this thread never had
      auto port = std::make_unique<Port>();
      port->ring->on_release([this] {
        const std::lock_guard<std::mutex> relock(m_);
        cv_.notify_all();
      });
      it = ports_.emplace(config.viewport, std::move(port)).first;
      it->second->config = config;
      it->second->dirty = true;
    } else {
      Port& p = *it->second;
      if (config == p.config) return;
      const bool ring = ring_config_changed(p.config, config);
      p.config = config;
      // D5: a camera-only change keeps the ring (ring_config_changed).
      if (!ring) return;
      p.dirty = true;
      if (!config.open) p.pending.reset();
    }
  }
  cv_.notify_all();
}

void RenderThread::set_shared(bool shared) {
  {
    const std::lock_guard<std::mutex> lock(m_);
    if (shared_ == shared) return;
    shared_ = shared;
    for (auto& [id, p] : ports_) p->dirty = true;
  }
  cv_.notify_all();
}

bool RenderThread::shared_supported() const {
  const std::lock_guard<std::mutex> lock(m_);
  return sharedCapable_;
}

void RenderThread::set_copy(bool copy) {
  {
    const std::lock_guard<std::mutex> lock(m_);
    const bool want = copy && static_cast<bool>(options_.sendPixels);
    if (copy_ == want) return;
    copy_ = want;
    for (auto& [id, p] : ports_) p->dirty = true;
  }
  cv_.notify_all();
}

bool RenderThread::copy_supported() const { return static_cast<bool>(options_.sendPixels); }

void RenderThread::request_layer_profile() {
  profileWanted_.store(true, std::memory_order_release);
  cv_.notify_one();
}

std::optional<LayerProfile> RenderThread::layer_profile() const {
  const std::lock_guard<std::mutex> lock(m_);
  return layerProfile_;
}

RenderCounters RenderThread::counters() const {
  const std::lock_guard<std::mutex> lock(m_);
  return counters_;
}

PortCounters RenderThread::port_counters(std::uint32_t viewport) const {
  const std::lock_guard<std::mutex> lock(m_);
  const auto it = ports_.find(viewport);
  if (it == ports_.end()) return {};
  return PortCounters{it->second->rendered, it->second->standIn};
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

CacheCoverageSnap RenderThread::cache_coverage() const {
  const std::lock_guard<std::mutex> lock(m_);
  return coverage_;
}

void RenderThread::publish_coverage_now() {
  post([this] { publish_coverage(); });
}

void RenderThread::purge_frame_cache() {
  prebuild_.clear();  // nothing it names is held any more
  post([this] {
    if (cache_) cache_->clear();
    ram_.clear();
    // Read-backs in flight would land in the RAM tier after the purge.
    victims_.clear();
    publish_coverage();
  });
}

void RenderThread::note_frames_changed(FrameRevision rev) {
  const std::lock_guard<std::mutex> lock(m_);
  revisionsIn_.push_back(std::move(rev));
  if (revisionsIn_.size() > 2 * CoverageLedger::kRevisionsKept) revisionsIn_.pop_front();
}

std::vector<std::uint32_t> RenderThread::take_build_requests() {
  const std::lock_guard<std::mutex> lock(m_);
  std::vector<std::uint32_t> out;
  out.swap(buildWanted_);
  return out;
}

void RenderThread::take_revisions() {
  std::deque<FrameRevision> in;
  {
    const std::lock_guard<std::mutex> lock(m_);
    in.swap(revisionsIn_);
  }
  for (FrameRevision& r : in) ledger_.note_revision(std::move(r));
}

void RenderThread::want_build(std::uint32_t viewport) {
  const std::lock_guard<std::mutex> lock(m_);
  if (std::ranges::find(buildWanted_, viewport) == buildWanted_.end()) buildWanted_.push_back(viewport);
}

namespace {
/// A pre-build key salted for the disk cache's alias log (disk_cache.hpp store_alias).
std::uint64_t alias_key(std::uint64_t prebuild, std::uint64_t salt) noexcept {
  std::uint64_t x = prebuild ^ (salt * 0x9e3779b97f4a7c15ULL);
  x ^= x >> 31U;
  x *= 0xd6e8feb86659fd93ULL;
  x ^= x >> 32U;
  return x == 0 ? 1 : x;
}
}  // namespace

std::optional<CachedKeys> RenderThread::cached_frame(std::uint64_t key) const {
  if (std::optional<CachedKeys> hit = prebuild_.find(key)) return hit;
  // Not built in this session: a frame an earlier one left on disk, by its alias.
  const std::uint64_t salt = aliasSalt_.load(std::memory_order_relaxed);
  if (salt == 0) return std::nullopt;
  if (const auto a = disk_->find_alias(alias_key(key, salt))) return CachedKeys{a->first, a->second};
  return std::nullopt;
}

bool RenderThread::tier_holds(const CachedKeys& keys) const {
  if (cache_ && cache_->contains(keys.content)) return true;
  if (ram_.contains(keys.content)) return true;
  return keys.disk != 0 && disk_->contains(keys.disk);
}

void RenderThread::configure_ram_cache(std::uint64_t bytes) {
  {
    const std::lock_guard<std::mutex> lock(m_);
    ramBudgetAsked_ = bytes;
    ramBudgetDirty_ = true;
  }
  post([this] {
    manage_ram_budget(true);
    publish_coverage();
  });
}

RamCacheStats RenderThread::ram_stats() const {
  const std::lock_guard<std::mutex> lock(m_);
  return ramStats_;
}

void RenderThread::manage_ram_budget(bool force) {
  const auto now = SteadyClock::now();
  bool dirty = false;
  std::uint64_t asked = 0;
  {
    const std::lock_guard<std::mutex> lock(m_);
    dirty = ramBudgetDirty_;
    ramBudgetDirty_ = false;
    asked = ramBudgetAsked_;
  }
  if (!force && !dirty && now - memoryCheckedAt_ < std::chrono::seconds(1)) return;
  memoryCheckedAt_ = now;
  const os::MemoryStatus mem = os::memory_status();
  if (dirty || ramBudgetTarget_ == 0) {
    std::uint64_t target = asked != 0                    ? asked
                           : options_.ramCacheBytes != 0 ? options_.ramCacheBytes
                                                         : auto_ram_budget(mem.physicalBytes);
    if (asked == 0 && options_.ramCacheBytes == 0 && sharedVramBudget_ > 0) {
      // Sized from the machine: the integrated GPU's frame cache is in the same RAM.
      constexpr std::uint64_t kFloor = std::uint64_t{512} << 20U;
      target = target > sharedVramBudget_ + kFloor ? target - sharedVramBudget_ : kFloor;
    }
    if (target != ramBudgetTarget_) {
      ramBudgetTarget_ = target;
      PREMATION_LOG(info, "ram_cache")
          .kv("budgetMB", static_cast<double>(target) / (1024.0 * 1024.0))
          .kv("physicalMB", static_cast<double>(mem.physicalBytes) / (1024.0 * 1024.0));
    }
  }
  // Never push the machine into its page file: keep a reserve free for the
  // system and the other applications (AE's "RAM reserved for other
  // applications"). The tier may hold what it holds plus what is free beyond it.
  std::uint64_t budget = ramBudgetTarget_;
  if (mem.physicalBytes > 0 && mem.availableBytes > 0) {
    const std::uint64_t reserve = std::max<std::uint64_t>(std::uint64_t{1536} << 20U, mem.physicalBytes / 10);
    const std::uint64_t room = mem.availableBytes > reserve ? mem.availableBytes - reserve : 0;
    budget = std::min<std::uint64_t>(budget, ram_.bytes() + room);
  }
  if (budget != ram_.budget()) {
    std::vector<RamFrame> evicted;
    ram_.set_budget(static_cast<std::size_t>(budget), evicted);
    if (!evicted.empty()) {
      spill_ram_evictions(evicted);
      coverageStale_ = true;
    }
  }
}

void RenderThread::configure_disk_cache(const std::string& folder, std::uint64_t bytes) {
  disk_->configure(folder, bytes);
  post([this] {
    diskReadMeasured_ = false;  // another folder (another drive): its own read cost
    diskRetry_.clear();         // parked for the old folder
    diskRetryBytes_ = 0;
    publish_coverage();
  });
}

void RenderThread::purge_disk_cache() {
  disk_->purge();
  post([this] {
    diskRetry_.clear();  // a purge drops what was on its way too
    diskRetryBytes_ = 0;
    publish_coverage();
  });
}

bool RenderThread::load_from_disk(std::uint64_t diskKey, std::uint32_t width, std::uint32_t height,
                                  const wgpu::Texture& target) {
  const auto t0 = SteadyClock::now();
  if (!disk_->load(diskKey, width, height, diskScratch_)) return false;
  wgpu::TexelCopyTextureInfo dst{};
  dst.texture = target;
  wgpu::TexelCopyBufferLayout layout{};
  layout.bytesPerRow = width * 4U;
  layout.rowsPerImage = height;
  const wgpu::Extent3D size{width, height, 1};
  gpu_->queue.WriteTexture(&dst, diskScratch_.data(), diskScratch_.size(), &layout, &size);
  const double ms = std::chrono::duration<double, std::milli>(SteadyClock::now() - t0).count();
  const double mp = static_cast<double>(width) * static_cast<double>(height) / 1e6;
  if (mp > 0) {
    // The first hit replaces the guess outright; later ones (or hits after the cache's seed) average in.
    diskReadMsPerMp_ = diskReadMeasured_ ? 0.8 * diskReadMsPerMp_ + 0.2 * (ms / mp) : ms / mp;
    diskReadMeasured_ = true;
  }
  return true;
}

bool RenderThread::worth_disk(double drawMs, std::uint32_t width, std::uint32_t height) const {
  // A cache fill stores EVERY frame it draws: a cheap frame RAM refused (the
  // tier full of the range) would otherwise be in no tier at all, and the
  // range the user just cached plays with a hole where it was.
  if (filling_.load(std::memory_order_relaxed)) return true;
  if (options_.diskCacheMinDrawMs >= 0) return drawMs >= options_.diskCacheMinDrawMs;
  // A frame is worth a file when its draw costs half again what reading it
  // back would, plus a millisecond: a cheap comp never pays for disk at all.
  const double mp = static_cast<double>(width) * static_cast<double>(height) / 1e6;
  return drawMs > 1.5 * diskReadMsPerMp_ * mp + 1.0;
}

wgpu::Buffer RenderThread::encode_readback(const wgpu::Texture& source, std::uint32_t width, std::uint32_t height,
                                           std::uint32_t& row, wgpu::CommandEncoder& encoder) {
  row = (width * 4U + 255U) & ~255U;  // WebGPU's copy rule
  const std::uint64_t size = std::uint64_t{row} * height;
  if (diskSpareSize_ != size) {
    diskSpare_.clear();
    diskSpareSize_ = size;
  }
  wgpu::Buffer buffer;
  if (!diskSpare_.empty()) {
    buffer = std::move(diskSpare_.back());
    diskSpare_.pop_back();
  } else {
    wgpu::BufferDescriptor bd{};
    bd.size = size;
    bd.usage = wgpu::BufferUsage::MapRead | wgpu::BufferUsage::CopyDst;
    buffer = gpu_->device.CreateBuffer(&bd);
  }
  wgpu::TexelCopyTextureInfo src{};
  src.texture = source;
  wgpu::TexelCopyBufferInfo dst{};
  dst.buffer = buffer;
  dst.layout.bytesPerRow = row;
  dst.layout.rowsPerImage = height;
  const wgpu::Extent3D extent{width, height, 1};
  encoder.CopyTextureToBuffer(&src, &dst, &extent);
  return buffer;
}

wgpu::Buffer RenderThread::encode_disk_readback(const wgpu::Texture& source, std::uint32_t width, std::uint32_t height,
                                                std::uint32_t& row) {
  wgpu::CommandEncoder enc = gpu_->device.CreateCommandEncoder();
  wgpu::Buffer buffer = encode_readback(source, width, height, row, enc);
  const wgpu::CommandBuffer cb = enc.Finish();
  gpu_->queue.Submit(1, &cb);
  return buffer;
}

bool RenderThread::take_readback(wgpu::Buffer buffer, std::uint32_t row, std::uint32_t width, std::uint32_t height,
                                 std::vector<std::uint8_t>& out) {
  const std::uint64_t size = std::uint64_t{row} * height;
  bool mapped = false;
  // The copy is done (its future was waited for): the map is immediate.
  gpu_->instance.WaitAny(buffer.MapAsync(wgpu::MapMode::Read, 0, size, wgpu::CallbackMode::WaitAnyOnly,
                                         [&mapped](wgpu::MapAsyncStatus status, wgpu::StringView) {
                                           mapped = status == wgpu::MapAsyncStatus::Success;
                                         }),
                         UINT64_MAX);
  if (!mapped) return false;
  const auto* src = static_cast<const std::uint8_t*>(buffer.GetConstMappedRange(0, static_cast<std::size_t>(size)));
  if (src == nullptr) {
    buffer.Unmap();
    return false;
  }
  // One allocation per frame read back, on purpose: the RAM tier or the disk
  // writer owns the bytes from here (a frame is megabytes; the tiers bound how many exist).
  const std::size_t rowBytes = std::size_t{width} * 4U;
  out.resize(rowBytes * height);
  for (std::uint32_t y = 0; y < height; ++y) {
    std::memcpy(out.data() + rowBytes * y, src + std::size_t{row} * y, rowBytes);
  }
  buffer.Unmap();
  constexpr std::size_t kSpareBuffers = 6;
  if (diskSpareSize_ == size && diskSpare_.size() < kSpareBuffers) diskSpare_.push_back(std::move(buffer));
  return true;
}

void RenderThread::on_vram_evict(const FrameCache::Evicted& ev, wgpu::CommandEncoder& encoder) {
  if (ev.texture == nullptr || ram_.contains(ev.key)) return;
  const std::size_t bytes = std::size_t{ev.width} * ev.height * 4;
  const bool ramKeeps = ram_.would_keep(bytes, protect_);
  // The RAM tier full of the range being played: a slow frame still has the disk tier.
  const bool diskWants = !ramKeeps && ev.meta.diskKey != 0 && ev.meta.drawMs > 0 && disk_->enabled() &&
                         worth_disk(ev.meta.drawMs, ev.width, ev.height) && !disk_->contains(ev.meta.diskKey);
  if (!ramKeeps && !diskWants) return;
  // Bounded: each read-back holds a frame-sized buffer until it is drained.
  while (victims_.size() >= kMaxVictims) drain_victims(true);
  Victim v;
  v.buffer = encode_readback(*ev.texture, ev.width, ev.height, v.row, encoder);
  v.key = ev.key;
  v.width = ev.width;
  v.height = ev.height;
  v.meta = ev.meta;
  v.diskOnly = !ramKeeps;
  victimsEncoding_.push_back(std::move(v));
}

void RenderThread::store_vram(std::uint64_t key, const wgpu::Texture& source, std::uint32_t width, std::uint32_t height,
                              const FrameMeta& meta) {
  wgpu::CommandEncoder enc = gpu_->device.CreateCommandEncoder();
  cache_->store(key, width, height, source, enc, meta,
                [this](const FrameCache::Evicted& ev, wgpu::CommandEncoder& e) { on_vram_evict(ev, e); });
  const wgpu::CommandBuffer cb = enc.Finish();
  gpu_->queue.Submit(1, &cb);
  for (Victim& v : victimsEncoding_) {
    v.done = gpu_->queue.OnSubmittedWorkDone(wgpu::CallbackMode::WaitAnyOnly, [](wgpu::QueueWorkDoneStatus, wgpu::StringView) {});
    victims_.push_back(std::move(v));
  }
  victimsEncoding_.clear();
}

void RenderThread::resize_vram_cache(std::size_t budget) {
  wgpu::CommandEncoder enc = gpu_->device.CreateCommandEncoder();
  cache_->set_budget(budget, enc, [this](const FrameCache::Evicted& ev, wgpu::CommandEncoder& e) { on_vram_evict(ev, e); });
  const wgpu::CommandBuffer cb = enc.Finish();
  gpu_->queue.Submit(1, &cb);
  for (Victim& v : victimsEncoding_) {
    v.done = gpu_->queue.OnSubmittedWorkDone(wgpu::CallbackMode::WaitAnyOnly, [](wgpu::QueueWorkDoneStatus, wgpu::StringView) {});
    victims_.push_back(std::move(v));
  }
  victimsEncoding_.clear();
}

void RenderThread::relieve_gpu_pressure() {
  if (!gpuProbe_ || !gpu_ || gpu_->device_lost()) return;
  const std::optional<GpuMemoryReading> r = gpuProbe_->read();
  if (!r) return;
  // Past ~90 % of its budget the OS starts demoting this process's
  // allocations to system memory, and every pass that touches one crawls over
  // the bus (deepPrecomp half: 5 ms -> 21 ms with other apps holding 6-7 GB of
  // an 8 GB card, 2026-10-28). The engine gives memory back before that.
  constexpr std::uint64_t kGpuHigh = 90;
  constexpr std::uint64_t kGpuLow = 75;
  // The frame cache never goes below this under pressure: the frames on screen.
  constexpr std::size_t kVramCacheFloor = std::size_t{64} << 20U;
  const std::uint64_t high = r->budget / 100 * kGpuHigh;
  const std::uint64_t low = r->budget / 100 * kGpuLow;
  std::uint64_t trimmed = 0;
  if (r->used > high) {
    std::uint64_t over = r->used - high;
    if (cache_) {
      // The VRAM tier first: its frames move to the RAM tier, nothing is drawn again.
      const std::size_t held = cache_->stats().bytes;
      const std::size_t from = std::min(cache_->budget(), held);
      const std::size_t want = from > kVramCacheFloor + over ? from - static_cast<std::size_t>(over) : kVramCacheFloor;
      if (want < cache_->budget()) {
        resize_vram_cache(want);
        const std::size_t after = cache_->stats().bytes;
        const std::uint64_t freed = held > after ? held - after : 0;
        trimmed += freed;
        over = over > freed ? over - freed : 0;
      }
    }
    // Then what the render graph and the footage feed hold but did not use last frame.
    if (over > 0 && drawer_) trimmed += drawer_->trim_vram(over);
    if (trimmed > 0) {
      PREMATION_LOG(info, "gpu_pressure_trim")
          .kv("budgetMB", static_cast<double>(r->budget) / (1024.0 * 1024.0))
          .kv("usedMB", static_cast<double>(r->used) / (1024.0 * 1024.0))
          .kv("trimmedMB", static_cast<double>(trimmed) / (1024.0 * 1024.0));
    }
  } else if (r->used < low && cache_ && cache_->budget() < vramCacheBase_) {
    // Room again: half the headroom under the low line back to the tier, never past its configured size.
    const std::size_t grow = std::min(vramCacheBase_ - cache_->budget(), static_cast<std::size_t>((low - r->used) / 2));
    if (grow > 0) resize_vram_cache(cache_->budget() + grow);
  }
  const std::lock_guard<std::mutex> lock(m_);
  counters_.gpuBudgetBytes = r->budget;
  counters_.gpuUsedBytes = r->used;
  counters_.gpuTotalBytes = r->total;
  counters_.gpuTrimmedBytes += trimmed;
  if (cache_) cacheStats_ = cache_->stats();
}

void RenderThread::drain_victims(bool block) {
  while (!victims_.empty()) {
    const wgpu::WaitStatus st = gpu_->instance.WaitAny(victims_.front().done, block ? UINT64_MAX : 0);
    if (st == wgpu::WaitStatus::TimedOut) break;
    Victim v = std::move(victims_.front());
    victims_.pop_front();
    block = false;  // only the oldest is waited for
    if (st != wgpu::WaitStatus::Success || gpu_->device_lost()) continue;
    // shared_ptr: the RAM tier's frames are shared with uploads in flight (ram_cache.hpp RamFrame).
    auto rgba = std::make_shared<std::vector<std::uint8_t>>();
    if (!take_readback(std::move(v.buffer), v.row, v.width, v.height, *rgba)) continue;
    if (!v.diskOnly) {
      std::vector<RamFrame> evicted;
      const bool kept = ram_.store(v.key, RamFrame{rgba, v.width, v.height, v.meta.drawMs, v.meta.diskKey, v.meta.tag},
                                   protect_, evicted);
      spill_ram_evictions(evicted);
      if (kept) {
        coverageStale_ = true;
        continue;
      }
    }
    // Not kept in RAM (full of the range being played): a frame worth a file goes to disk.
    if (v.meta.diskKey != 0 && v.meta.drawMs > 0 && disk_->enabled() && worth_disk(v.meta.drawMs, v.width, v.height) &&
        !disk_->contains(v.meta.diskKey)) {
      offer_disk(v.meta.diskKey, v.width, v.height, *rgba);
    }
  }
  retry_disk();
}

void RenderThread::offer_disk(std::uint64_t key, std::uint32_t width, std::uint32_t height, std::vector<std::uint8_t>& rgba) {
  const StoreResult r = disk_->enqueue(key, width, height, rgba);
  if (r == StoreResult::queued || r == StoreResult::queuedBehind) {
    diskCoverageStale_ = true;
    return;
  }
  if (r != StoreResult::refused || rgba.empty()) return;  // skipped: on disk already, or not wanted
  // Refused at the writer's hard cap: this frame is in no other tier. Park it.
  diskRetryBytes_ += rgba.size();
  diskRetry_.push_back(DiskRetry{key, width, height, std::move(rgba)});
  while (diskRetryBytes_ > kMaxDiskRetryBytes && !diskRetry_.empty()) {
    diskRetryBytes_ -= diskRetry_.front().rgba.size();
    diskRetry_.pop_front();
  }
}

void RenderThread::retry_disk() {
  while (!diskRetry_.empty() && disk_->enabled()) {
    DiskRetry& d = diskRetry_.front();
    const std::size_t bytes = d.rgba.size();
    const StoreResult r = disk_->enqueue(d.key, d.width, d.height, d.rgba);
    if (r == StoreResult::refused) return;  // still behind: try again on the next drain
    if (r == StoreResult::queued || r == StoreResult::queuedBehind) diskCoverageStale_ = true;
    diskRetryBytes_ -= bytes;
    diskRetry_.pop_front();
  }
}

bool RenderThread::settle_victim(std::uint64_t key) {
  const auto pending = [this, key] {
    return std::ranges::any_of(victims_, [key](const Victim& v) { return v.key == key; });
  };
  if (!pending()) return false;
  while (pending()) drain_victims(true);
  return true;
}

void RenderThread::spill_ram_evictions(std::vector<RamFrame>& evicted) {
  for (RamFrame& f : evicted) {
    if (f.diskKey == 0 || f.rgba == nullptr || f.drawMs <= 0 || !disk_->enabled()) continue;
    if (!worth_disk(f.drawMs, f.width, f.height) || disk_->contains(f.diskKey)) continue;
    // Moved when nothing else holds the pixels (an upload in flight may).
    std::vector<std::uint8_t> bytes = f.rgba.use_count() == 1 ? std::move(*f.rgba) : *f.rgba;
    offer_disk(f.diskKey, f.width, f.height, bytes);  // refused at the cap: parked, not lost
  }
  evicted.clear();
}

void RenderThread::queue_disk_readback(InFlight& f, std::uint64_t diskKey, const wgpu::Texture& source,
                                       std::uint32_t width, std::uint32_t height) {
  f.diskBuffer = encode_disk_readback(source, width, height, f.diskRow);
  f.diskKey = diskKey;
}

void RenderThread::spill_to_disk(InFlight& f, std::uint32_t width, std::uint32_t height) {
  if (f.diskBuffer == nullptr) return;
  wgpu::Buffer buffer = std::move(f.diskBuffer);
  f.diskBuffer = nullptr;
  write_disk_readback(std::move(buffer), f.diskRow, f.diskKey, width, height);
}

void RenderThread::queue_late_spill(std::uint64_t key, std::uint64_t diskKey, std::uint32_t width, std::uint32_t height) {
  if (!cache_ || !disk_->reserve(diskKey)) return;
  // The frame's VRAM copy, not the slot: the slot is the host's now, and may
  // carry an onion ghost. Evicted already (a small cache, a long fill) = no file.
  const wgpu::Texture source = cache_->peek(key, width, height);
  if (source == nullptr) {
    disk_->release(diskKey);
    return;
  }
  Spill s;
  s.buffer = encode_disk_readback(source, width, height, s.row);
  s.done = gpu_->queue.OnSubmittedWorkDone(wgpu::CallbackMode::WaitAnyOnly, [](wgpu::QueueWorkDoneStatus, wgpu::StringView) {});
  s.diskKey = diskKey;
  s.width = width;
  s.height = height;
  spills_.push_back(std::move(s));
  if (spills_.size() > kMaxSpills) drain_spills(true);
}

void RenderThread::drain_spills(bool block) {
  while (!spills_.empty()) {
    Spill& s = spills_.front();
    const wgpu::WaitStatus st = gpu_->instance.WaitAny(s.done, block ? UINT64_MAX : 0);
    if (st == wgpu::WaitStatus::TimedOut) break;
    if (st == wgpu::WaitStatus::Success && !gpu_->device_lost()) {
      write_disk_readback(std::move(s.buffer), s.row, s.diskKey, s.width, s.height);
    } else {
      disk_->release(s.diskKey);
    }
    spills_.pop_front();
    block = false;  // only the oldest is waited for
  }
}

void RenderThread::write_disk_readback(wgpu::Buffer buffer, std::uint32_t row, std::uint64_t diskKey,
                                       std::uint32_t width, std::uint32_t height) {
  // The disk cache's writer thread owns the bytes until they are on disk, and
  // its queue bounds how many exist (DiskCache::kMaxQueuedBytes). A frame is
  // read back once — DiskCache::wants refuses one already on disk or queued.
  std::vector<std::uint8_t> rgba;
  if (!take_readback(std::move(buffer), row, width, height, rgba)) {
    disk_->release(diskKey);
    return;
  }
  if (disk_->store(diskKey, width, height, std::move(rgba))) diskCoverageStale_ = true;
}

void RenderThread::abandon_disk(InFlight& f) {
  if (f.diskBuffer == nullptr) return;
  f.diskBuffer = nullptr;
  disk_->release(f.diskKey);
}

void RenderThread::abandon_all_disk() {
  for (InFlight& f : inflight_) abandon_disk(f);
  for (const Spill& s : spills_) disk_->release(s.diskKey);
  spills_.clear();
}

void RenderThread::seed_disk_read_cost() {
  if (diskReadMeasured_) return;
  const double readMsPerMp = disk_->read_ms_per_mp();
  if (readMsPerMp <= 0) return;
  // The cache times a file's read + decode; the upload to the GPU (a
  // WriteTexture of the decoded pixels) comes on top of it here.
  constexpr double kUploadMsPerMp = 0.25;
  diskReadMsPerMp_ = readMsPerMp + kUploadMsPerMp;
  diskReadMeasured_ = true;
}

void RenderThread::note_coverage(const RenderJob& job, std::uint64_t key, std::uint64_t diskKey) {
  // The ledger carries a view's bar across a document revision frame by frame
  // (the session says which frames each step changed; a changed frame comes
  // back when the pre-build map knows its new key and a tier holds it).
  if (ledger_.note(job, CachedKeys{key, diskKey}, prebuild_, [this](const CachedKeys& k) { return tier_holds(k); })) {
    coverageStale_ = true;
  }
  publish_coverage_soon();
}

void RenderThread::publish_coverage_soon() {
  if (!coverageStale_ && !diskCoverageStale_) return;
  if (SteadyClock::now() - coveragePublishedAt_ < kCoverageEvery) return;
  publish_coverage();
}

void RenderThread::composite_onion(const RenderJob& job, const wgpu::TextureView& slot, std::uint32_t width,
                                   std::uint32_t height) {
  if (!drawer_ || width == 0 || height == 0) return;
  if (onionTex_ == nullptr || onionW_ != width || onionH_ != height) {
    wgpu::TextureDescriptor td{};
    td.size = {width, height, 1};
    td.format = wgpu::TextureFormat::RGBA8Unorm;
    td.usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::TextureBinding;
    onionTex_ = gpu_->device.CreateTexture(&td);
    onionView_ = onionTex_.CreateView();
    onionW_ = width;
    onionH_ = height;
  }
  for (const RenderJob::OnionGhost& ghost : job.onion) {
    if (!ghost.built) continue;
    std::string error;
    if (!drawer_->draw(*ghost.built, onionView_, width, height, error)) {
      PREMATION_LOG(error, "onion_draw_failed").kv("error", error);
      continue;
    }
    wgpu::CommandEncoder enc = gpu_->device.CreateCommandEncoder();
    compositor_->blend_over(enc, onionView_, slot, ghost.opacity, ghost.tintR, ghost.tintG, ghost.tintB, ghost.tintStrength);
    const wgpu::CommandBuffer cb = enc.Finish();
    gpu_->queue.Submit(1, &cb);
  }
}

void RenderThread::publish_coverage() {
  coverageStale_ = false;
  // Files still being written join the blue lane when they land: stay stale
  // until the writer is done, so the idle loop publishes again (a publish made
  // mid-write — the one at the end of a fill — used to leave the last frame out).
  diskCoverageStale_ = disk_->writing();
  coveragePublishedAt_ = SteadyClock::now();
  // Each viewport's current scope: the green bar is what VRAM or RAM holds,
  // the blue one what is on disk (a frame queued for writing joins once
  // written). A frame no tier holds any more is forgotten.
  std::vector<std::int64_t> ramFrames;
  std::vector<std::int64_t> diskFrames;
  std::vector<std::uint64_t> diskKeys;
  // Per disk key: its frame, and its scope when only the disk may still hold it (pruned if not).
  std::vector<std::pair<CoverageLedger::ScopeCover*, std::int64_t>> diskOf;
  for (auto& [viewport, scopes] : ledger_.viewports()) {
    if (scopes.empty()) continue;
    CoverageLedger::ScopeCover& cur = scopes.front();
    for (auto it = cur.frames.begin(); it != cur.frames.end();) {
      const std::uint64_t key = it->second.content;
      const std::uint64_t diskKey = it->second.disk;
      // A frame VRAM just evicted is on its way into RAM (a read-back in flight): still in memory.
      const bool inMemory = (cache_ != nullptr && cache_->contains(key)) || ram_.contains(key) ||
                            std::ranges::any_of(victims_, [key](const Victim& v) { return v.key == key && !v.diskOnly; });
      if (inMemory) ramFrames.push_back(it->first);
      if (diskKey != 0) {
        diskKeys.push_back(diskKey);
        diskOf.emplace_back(inMemory ? nullptr : &cur, it->first);
      } else if (!inMemory) {
        it = cur.frames.erase(it);
        continue;
      }
      ++it;
    }
  }
  std::vector<std::uint8_t> onDisk;
  disk_->presence(diskKeys, onDisk);
  for (std::size_t i = 0; i < diskKeys.size(); ++i) {
    if (onDisk[i] == 2) diskFrames.push_back(diskOf[i].second);
    if (onDisk[i] == 0 && diskOf[i].first != nullptr) diskOf[i].first->frames.erase(diskOf[i].second);
  }
  CacheCoverageSnap snap;
  snap.ram = coalesce_frame_indices(std::move(ramFrames));
  snap.ramBytes = (cache_ ? static_cast<std::uint64_t>(cache_->stats().bytes) : 0) + ram_.bytes();
  snap.disk = coalesce_frame_indices(std::move(diskFrames));
  snap.diskBytes = disk_->bytes();
  if (cache_) {
    const FrameCacheStats vram = cache_->stats();
    snap.vramBytes = static_cast<std::uint64_t>(vram.bytes);
    snap.vramBudget = static_cast<std::uint64_t>(vram.budget);
  }
  snap.ramBudget = static_cast<std::uint64_t>(ram_.budget());
  snap.diskBudget = disk_->budget();
  snap.diskReadMsPerMp = disk_->read_ms_per_mp();
  const std::lock_guard<std::mutex> lock(m_);
  if (snap.ramBudget == 0) {
    // Before the first frame the tier has no budget yet (manage_ram_budget
    // sizes it as frames arrive): report the one it is about to take.
    snap.ramBudget = ramBudgetTarget_ != 0         ? ramBudgetTarget_
                     : ramBudgetAsked_ != 0        ? ramBudgetAsked_
                     : options_.ramCacheBytes != 0 ? options_.ramCacheBytes
                                                   : auto_ram_budget(os::memory_status().physicalBytes);
  }
  coverage_ = std::move(snap);
  ramStats_ = ram_.stats();
}

std::string RenderThread::open_gpu() {
#if defined(PREMATION_SHARED_TEXTURE)
  // Windows (NT handles), macOS (IOSurfaces), Linux with GBM (dmabufs): a host to share with.
  const bool wantShared = options_.hostPid != 0;
#else
  const bool wantShared = false;  // Linux without GBM: no shared route — the route-A copy
#endif
  gpu_ = create_gpu(wantShared, options_.highPerformance, options_.vendorId, options_.shaderCacheDir);
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
  sharedVramBudget_ = 0;
  {
    wgpu::AdapterInfo info{};
    gpu_->adapter.GetInfo(&info);
    gpuProbe_ = GpuMemoryProbe::open(info.vendorID, info.deviceID);
  }
  if (drawer_ && options_.frameCacheBytes != 0) {
    // D4: only built frames have content keys; C2's quads are never cached.
    std::size_t budget = options_.frameCacheBytes;
    wgpu::AdapterInfo info{};
    gpu_->adapter.GetInfo(&info);
    if (budget == kFrameCacheAuto) budget = default_frame_cache_budget(info.vendorID, info.deviceID);
    // An integrated GPU (a ThinkPad's Intel HD, a Ryzen APU) has no memory of
    // its own: this budget is system RAM, counted against the RAM tier below.
    if (info.adapterType == wgpu::AdapterType::IntegratedGPU) sharedVramBudget_ = budget;
    cache_ = std::make_unique<FrameCache>(gpu_->device, budget);
    vramCacheBase_ = budget;
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
  {
    // Only the render thread touches `slots`; m_ guards the map against a
    // concurrent configure() inserting a viewport.
    const std::lock_guard<std::mutex> lock(m_);
    for (auto& [id, p] : ports_) p->slots.reset();
    coverage_ = {};
  }
  retired_.clear();
  // Buffers of this device; the RAM tier and the disk cache (files) carry on.
  for (const Spill& s : spills_) disk_->release(s.diskKey);
  spills_.clear();
  victims_.clear();
  victimsEncoding_.clear();
  diskSpare_.clear();
  diskSpareSize_ = 0;
  onionTex_ = nullptr;
  onionView_ = nullptr;
  onionW_ = 0;
  onionH_ = 0;
  compTargets_.clear();
  // The VRAM tier goes with the device: entries naming frames only it held
  // would miss (and heal) one by one — start over instead.
  prebuild_.clear();
  cache_.reset();
  gpuProbe_.reset();
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
  // Size the RAM tier and publish the (empty) snapshot now, not at the first
  // frame: getRenderStats reports the tiers' budgets from it (the Cache &
  // Memory panel), and with no frame yet there would be none.
  manage_ram_budget(true);
  publish_coverage();

  std::unique_lock<std::mutex> lock(m_);
  const auto anyDirty = [this] {
    return std::any_of(ports_.begin(), ports_.end(), [](const auto& e) { return e.second->dirty; });
  };
  // P7's warm-up is a synchronous pipeline compile: only in true idle time —
  // never while frames are on the GPU (their announcement would wait behind
  // it) nor while the transport plays (the next frame would).
  const auto canWarm = [this] { return inflight_.empty() && !lastJobPlaying_ && drawer_ && drawer_->warm_pending(); };
  // A step that holds this thread a second or more delays every query queued
  // behind it (render_query_late): the log says which step it was.
  const auto timed = [](const char* what, auto&& step) {
    const auto t0 = SteadyClock::now();
    step();
    const auto took = SteadyClock::now() - t0;
    if (took >= std::chrono::seconds(1)) {
      PREMATION_LOG(warn, "render_step_slow")
          .kv("what", what)
          .kv("ms", static_cast<std::int64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(took).count()));
    }
  };
  // Paused footage still decoding (Port::settling): the earliest poll, if any.
  const auto nextSettle = [this]() -> std::optional<SteadyClock::time_point> {
    std::optional<SteadyClock::time_point> at;
    for (const auto& [id, p] : ports_) {
      if (!p->settling.empty() && !p->pending && (!at || p->settleAt < *at)) at = p->settleAt;
    }
    return at;
  };
  const auto settleDue = [&nextSettle] {
    const auto at = nextSettle();
    return at && *at <= SteadyClock::now();
  };
  // Idle render-ahead: a prefetch job draws only when nothing is on the GPU and
  // no viewport has a frame waiting (under m_).
  const auto canPrefetch = [this] { return prefetch_.has_value() && inflight_.empty() && next_ready_locked() == nullptr; };
  const auto workReady = [this, &anyDirty, &canWarm, &settleDue, &canPrefetch] {
    return quit_ || anyDirty() || !tasks_.empty() || next_ready_locked() != nullptr || canWarm() || settleDue() || canPrefetch();
  };
  for (;;) {
    if (!inflight_.empty()) {
      // P5: frames on the GPU. With nothing else to do, wait for the oldest;
      // otherwise announce whatever finished and get on with the next frame.
      const bool idle = !workReady();
      lock.unlock();
      timed("complete_frames", [&] { (void)complete_frames(idle); });
      lock.lock();
      if (idle) continue;
    } else {
      // Sleep until work, or the next settle poll (paused footage still decoding).
      // Late disk spills or VRAM evictions in flight: look again shortly (a copy is a millisecond or two).
      const bool copies = !spills_.empty() || !victims_.empty();
      auto until = SteadyClock::now() + (copies ? std::chrono::milliseconds(2) : std::chrono::milliseconds(500));
      if (const auto at = nextSettle(); at && *at < until) until = *at;
      // Coverage held back by publish_coverage_soon's throttle: out at the next slot, not after a long sleep.
      if (coverageStale_ && coveragePublishedAt_ + kCoverageEvery < until) until = coveragePublishedAt_ + kCoverageEvery;
      cv_.wait_until(lock, until, workReady);
      if ((!spills_.empty() || !victims_.empty()) && !quit_ && !gpu_->device_lost()) {
        lock.unlock();
        timed("drain_spills", [&] {
          drain_spills(false);
          drain_victims(false);
        });
        lock.lock();
      }
    }
    if (quit_) break;
    if (gpu_->device_lost()) {
      abandon_all_disk();
      inflight_.clear();  // their slots are rebuilt with the device (a new generation)
      if (prefetch_) {    // the session asks again once it is idle
        prefetch_.reset();
        ++counters_.prefetched;
      }
      lock.unlock();
      const bool recovered = recover_device();
      if (!recovered && onFatal_) onFatal_("GPU device lost");
      lock.lock();
      if (!recovered) break;
      // New slots (a new generation the host imports) for every viewport, and
      // each one's last frame again unless a newer one is waiting: no viewport
      // is left blank.
      for (auto& [id, p] : ports_) {
        p->dirty = true;
        if (!p->pending) std::swap(p->pending, p->lastJob);
      }
      continue;
    }
    const auto now = SteadyClock::now();
    if (inflight_.empty() && now - lastGpuProbe_ >= std::chrono::seconds(1)) {
      // Between frames (nothing encoding): the pools can be trimmed safely.
      lastGpuProbe_ = now;
      lock.unlock();
      timed("gpu_pressure", [&] { relieve_gpu_pressure(); });
      lock.lock();
    }
    if (drawer_) {
      // The per-layer profile: arm before the next draw, collect what a sampled frame left.
      if (profileWanted_.exchange(false, std::memory_order_acq_rel)) drawer_->profile_next_frame();
      if (std::optional<LayerProfile> p = drawer_->take_layer_profile()) layerProfile_ = std::move(p);
    }
    if (!retired_.empty()) {
      lock.unlock();
      collect_retired(now);
      lock.lock();
    }
    if (anyDirty()) {
      // Frames in flight belong to the rings about to be replaced: announce them first.
      lock.unlock();
      timed("complete_all", [&] { complete_all(); });
      lock.lock();
      const bool shared = shared_;
      const bool copy = copy_;
      for (auto it = ports_.begin(); it != ports_.end();) {
        Port& p = *it->second;
        if (!p.dirty) {
          ++it;
          continue;
        }
        p.dirty = false;
        const ViewportConfig config = p.config;
        lock.unlock();
        timed("rebuild", [&] { rebuild(p, config, shared, copy); });  // a closed viewport: an empty ring, announced
        lock.lock();
        // Forget a viewport that is (still) closed once its ring is retired; its
        // late releases name a generation no ring has any more.
        if (!p.config.open && !p.dirty) {
          ledger_.forget_viewport(it->first);
          coverageStale_ = true;
          it = ports_.erase(it);
        } else {
          it = std::next(it);
        }
      }
      continue;
    }
    if (!tasks_.empty()) {
      // Queries between frames: a still or a pixel read never waits behind a
      // playing viewport for more than the frame in hand.
      lock.unlock();
      timed("complete_all", [&] { complete_all(); });
      lock.lock();
      run_tasks(lock);
      continue;
    }
    if (settleDue()) {
      // Poll the footage each due port waits on; once decoded, its last job again.
      for (auto& [id, p] : ports_) {
        if (p->settling.empty() || p->pending || p->settleAt > SteadyClock::now()) continue;
        ++p->settleTries;
        if (!p->lastJob || !p->config.open) {
          p->settling.clear();
        } else if (drawer_ && drawer_->media_settled(p->settling)) {
          p->settling.clear();
          p->pending = *p->lastJob;
          p->pending->clockDropped = 0;
        } else {
          p->settleAt = SteadyClock::now() + kSettlePoll;
        }
      }
    }
    Port* port = next_ready_locked();
    if (port == nullptr) {
      // Idle: frames the disk cache finished writing join the blue lane, and
      // frames read back into the RAM tier the green one (the last frames of a
      // fill would otherwise wait for the next frame drawn).
      if (diskCoverageStale_ || coverageStale_) {
        lock.unlock();
        publish_coverage();  // stays disk-stale while the writer works (publish_coverage)
        lock.lock();
      }
      // Idle: one step of the drawer's warm-up (P7), then look for work again —
      // a frame that arrives waits at most one pipeline compile.
      if (canWarm()) {
        lock.unlock();
        timed("warm_step", [&] { (void)drawer_->warm_step(); });
        lock.lock();
        continue;
      }
      // Idle: the session's render-ahead frame (RenderJob::prefetch), one at a
      // time, into the cache tiers — never a slot. A viewport's frame arriving
      // meanwhile waits for this one draw at most.
      if (canPrefetch()) {
        RenderJob job = std::move(*prefetch_);
        prefetch_.reset();
        lock.unlock();
        timed("prefetch", [&] { render_prefetch(job); });
        lock.lock();
      }
      continue;
    }
    const std::optional<std::uint32_t> slot = port->ring->acquire();
    if (!slot) {
      // Frame-pipeline trace: all slots with the host — production is gated on a release.
      PREMATION_LOG(debug, "ft_noslot").kv("rev", static_cast<std::uint64_t>(port->pending->revision));
      continue;  // every slot is with the host: keep the newest job until one returns
    }
    // Frame-pipeline trace: the job starts drawing (FrameReady carries start/done).
    PREMATION_LOG(debug, "ft_rstart").kv("rev", static_cast<std::uint64_t>(port->pending->revision)).kv("slot", *slot);
    RenderJob job = std::move(*port->pending);
    port->pending.reset();
    job.clockDropped = port->droppedPending;
    port->droppedPending = 0;
    lastJobPlaying_ = job.playing;
    lastServed_ = port->config.viewport;
    const ViewportConfig config = port->config;
    lock.unlock();
    timed("render", [&] { render(*port, job, *slot, config); });
    port->lastJob = std::move(job);
    lock.lock();
  }
  // Queries still queued are dropped: their futures report a broken promise,
  // which the core answers as an internal error (the engine is stopping).
  tasks_.clear();
  lock.unlock();
  if (gpu_ && !gpu_->device_lost()) complete_all();
  abandon_all_disk();
  inflight_.clear();
  // Tear down on this thread, which created everything.
  close_gpu();
}

RenderThread::Port* RenderThread::next_ready_locked() {
  // Round-robin: the first ready viewport after the one served last, wrapping.
  const auto ready = [](const Port& p) { return p.pending && p.config.open && p.slots && p.ring->any_free(); };
  for (auto it = ports_.upper_bound(lastServed_); it != ports_.end(); ++it) {
    if (ready(*it->second)) return it->second.get();
  }
  for (auto it = ports_.begin(); it != ports_.end() && it->first <= lastServed_; ++it) {
    if (ready(*it->second)) return it->second.get();
  }
  return nullptr;
}

void RenderThread::post(std::function<void()> task) {
  {
    const std::lock_guard<std::mutex> lock(m_);
    if (quit_) return;  // the task (and its promise) is dropped: a broken promise
    // A query the core gave up on (Session::kRenderQueryTimeout) says how late it ran.
    tasks_.emplace_back([task = std::move(task), posted = SteadyClock::now()] {
      const auto late = SteadyClock::now() - posted;
      if (late >= std::chrono::seconds(1)) {
        PREMATION_LOG(warn, "render_query_late")
            .kv("ms", static_cast<std::int64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(late).count()));
      }
      task();
    });
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
    Port* port = nullptr;
    {
      const std::lock_guard<std::mutex> lock(m_);
      if (const auto it = ports_.find(viewport); it != ports_.end()) port = it->second.get();
    }
    // Render thread: `port` stays valid (only this thread erases one).
    const SlotSet* slots = port != nullptr ? port->slots.get() : nullptr;
    const std::optional<RenderJob>* last = port != nullptr ? &port->lastJob : nullptr;
    if (last == nullptr || !*last || slots == nullptr) {
      out.answer = HookAnswer::pending;
      out.error = "viewport " + std::to_string(viewport) + " has shown no frame yet";
    } else if (!(*last)->built && (*last)->cachedKey) {
      // Presented from a cache tier without a build: ask the session for the
      // built frame (take_build_requests) and answer once it has drawn.
      want_build(viewport);
      out.answer = HookAnswer::pending;
      out.error = "viewport " + std::to_string(viewport) + " shows a cached frame: building it";
    } else if (!(*last)->built || !drawer_) {
      out.answer = HookAnswer::unsupported;
      out.error = "the viewport shows C2 quads: there is no working-space frame to read";
    } else {
      // The ring may have been rebuilt since the core clamped the region.
      PixelRegion r = region;
      r.x = std::min(r.x, slots->width);
      r.y = std::min(r.y, slots->height);
      r.width = std::min(r.width, slots->width - r.x);
      r.height = std::min(r.height, slots->height - r.y);
      std::string error;
      if (r.width == 0 || r.height == 0) {
        out.answer = HookAnswer::failed;
        out.error = "the region is outside the viewport";
      } else if (drawer_->read_working(*(*last)->built, slots->width, slots->height, r, out, error)) {
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

std::future<WorkingPixels> RenderThread::read_frame(std::shared_ptr<BuiltFrame> frame, std::uint32_t width,
                                                     std::uint32_t height) {
  // shared_ptr: as render_still.
  auto promise = std::make_shared<std::promise<WorkingPixels>>();
  std::future<WorkingPixels> result = promise->get_future();
  post([this, promise, frame = std::move(frame), width, height] {
    WorkingPixels out;
    std::string error;
    if (!frame || !drawer_) {
      out.answer = HookAnswer::unsupported;
      out.error = frame ? "the render graph did not start on this GPU (C2 quads only)" : "no frame to draw";
    } else if (width == 0 || height == 0) {
      out.answer = HookAnswer::failed;
      out.error = "an empty frame";
    } else if (drawer_->read_working(*frame, width, height, PixelRegion{0, 0, width, height}, out, error)) {
      out.answer = HookAnswer::ready;
    } else {
      out = WorkingPixels{};
      out.answer = HookAnswer::failed;
      out.error = std::move(error);
      PREMATION_LOG(warn, "read_frame_failed").kv("error", out.error);
    }
    promise->set_value(std::move(out));
  });
  return result;
}

void RenderThread::rebuild(Port& port, const ViewportConfig& config, bool shared, bool copy) {
  // The slots hold frames at the preview resolution (engine_frames build draws at dpr × it);
  // the page scales them up to the viewer.
  const std::uint32_t W = preview_pixels(config.width, config.resolution);
  const std::uint32_t H = preview_pixels(config.height, config.resolution);
  // A2: a slot-SIZE switch (preview resolution, pane size) is what the HUD reports.
  const bool sizeSwitch = port.slots && (port.slots->width != W || port.slots->height != H) && W > 0 && H > 0;
  const auto rebuildStart = SteadyClock::now();
  auto next = std::make_unique<SlotSet>();
  next->generation = ++generation_;
  next->width = W;
  next->height = H;
  api::FrameSlots announce;
  announce.generation = next->generation;
  announce.viewport = config.viewport;
  announce.width = W;
  announce.height = H;
  std::uint32_t count = 0;
  if (config.open && W > 0 && H > 0) {
    count = options_.slots;
#if defined(PREMATION_SHARED_TEXTURE)
    if (shared) {
      auto pool = std::make_unique<shared::SharedTexturePool>();
      std::string error;
      if (pool->init(*gpu_, W, H, count, options_.hostPid, error)) {
        next->shared = true;
        for (auto& s : pool->slots()) {
          next->views.push_back(s.view);
          next->textures.push_back(s.texture);
          next->copyable = next->copyable && s.copyable;
          announce.handles.push_back(s.remoteHandle);
          if (s.stride != 0) {  // Linux dmabuf: the plane layout the host imports with
            announce.strides.push_back(s.stride);
            announce.offsets.push_back(s.offset);
            announce.sizes.push_back(s.planeSize);
          }
        }
        announce.modifier = pool->modifier();
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
        td.size = {W, H, 1};
        td.format = wgpu::TextureFormat::RGBA8Unorm;
        // CopyDst: a frame-cache hit is copied in; CopySrc: a drawn frame is copied out to the cache.
        td.usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::CopySrc | wgpu::TextureUsage::CopyDst;
        wgpu::Texture t = gpu_->device.CreateTexture(&td);
        next->views.push_back(t.CreateView());
        next->textures.push_back(std::move(t));
        announce.handles.push_back(0);
      }
      if (copy) {
        // Route A: one read-back buffer per slot, so a slot's copy never waits
        // for another slot's map.
        next->copy = true;
        next->readbackRow = (W * 4U + 255U) & ~255U;
        for (std::uint32_t i = 0; i < count; ++i) {
          wgpu::BufferDescriptor bd{};
          bd.size = std::uint64_t{next->readbackRow} * H;
          bd.usage = wgpu::BufferUsage::MapRead | wgpu::BufferUsage::CopyDst;
          next->readback.push_back(gpu_->device.CreateBuffer(&bd));
        }
      }
    }
  }
  announce.shared = next->shared;
  if (port.slots) {
    port.slots->retiredAt = SteadyClock::now();
    retired_.push_back(std::move(port.slots));
  }
  port.slots = std::move(next);
  port.ring->reset(port.slots->generation, count);
  PREMATION_LOG(info, "slots")
      .kv("viewport", config.viewport)
      .kv("generation", port.slots->generation)
      .kv("width", W)
      .kv("height", H)
      .kv("count", count)
      .kv("shared", port.slots->shared)
      .kv("copy", port.slots->copy);
  if (send_) send_(frames::Message{.v = std::move(announce)});
  const std::lock_guard<std::mutex> lock(m_);
  // Comp-space frames are presented by a copy: offered only while every open slot takes one.
  bool allCopyable = true;
  for (const auto& [id, p] : ports_) {
    if (p->config.open && p->slots && !p->slots->copyable) allCopyable = false;
  }
  slotsCopyable_.store(allCopyable, std::memory_order_relaxed);
  if (sizeSwitch) {
    counters_.slotSwitchEpochUs = os::epoch_us();
    counters_.slotSwitchMs = std::chrono::duration<double, std::milli>(SteadyClock::now() - rebuildStart).count();
  }
  cv_.notify_all();
}

void RenderThread::collect_retired(SteadyClock::time_point now) {
  std::erase_if(retired_, [now](const std::unique_ptr<SlotSet>& s) { return now - s->retiredAt >= kRetireGrace; });
}

void RenderThread::render(Port& port, RenderJob& job, std::uint32_t slot, const ViewportConfig& config) {
  // The exception barrier of the render thread. Nothing above this frame
  // catches: a throw out of a draw (bad_alloc on a huge raster, a
  // system_error from the raster thread pool, an `.at()` in a port) went to
  // std::terminate and took the whole engine with it — one frame's failure
  // became "the engine crashed" and a command-log replay. One bad frame never
  // kills the editor (CLAUDE.md): it is logged, its slot goes back to the
  // ring, and the next job draws.
  try {
    render_guarded(port, job, slot, config);
    return;
  } catch (const std::exception& e) {
    PREMATION_LOG(error, "render_failed").kv("viewport", job.viewport).kv("frame", job.frame).kv("error", std::string(e.what()));
  } catch (...) {
    PREMATION_LOG(error, "render_failed").kv("viewport", job.viewport).kv("frame", job.frame).kv("error", "non-standard exception");
  }
  // The slot is handed to inflight_ as render_guarded's LAST step; a throw
  // before that leaves it acquired and never announced — give it back, or the
  // ring runs dry and the viewport freezes on its last picture.
  if (!port.slots) return;
  const bool handed = std::ranges::any_of(inflight_, [&](const InFlight& f) {
    return f.port == &port && f.slot == slot && f.generation == port.slots->generation;
  });
  if (handed) return;
#if defined(PREMATION_SHARED_TEXTURE)
  // end_access on a slot whose access never began is refused by the OS object
  // and reports false; the value is dropped either way.
  if (port.slots->pool) (void)port.slots->pool->end_access(port.slots->pool->slots()[slot]);
#endif
  port.ring->unacquire(slot);
}

void RenderThread::render_guarded(Port& port, RenderJob& job, std::uint32_t slot, const ViewportConfig& /*config*/) {
  SlotSet& set = *port.slots;
  FrameRing& ring = *port.ring;
  const double startUs = os::epoch_us();
  const auto t0 = SteadyClock::now();
#if defined(PREMATION_SHARED_TEXTURE)
  shared::Slot* shared = set.pool ? &set.pool->slots()[slot] : nullptr;
  if (shared != nullptr && !set.pool->begin_access(*shared)) {
    PREMATION_LOG(error, "begin_access_failed").kv("slot", slot);
    ring.unacquire(slot);
    return;
  }
#endif
  bool drawn = false;
  InFlight f;
  f.buildMs = job.buildMs;
  f.frameWidth = set.width;
  f.frameHeight = set.height;
  take_revisions();
  // A cached job (RenderJob::cachedKey): the session built nothing, the keys
  // name a frame a tier held when it asked. Presented from VRAM, RAM or disk
  // below; found in no tier after all, the session is asked for a built frame.
  const bool cachedJob = job.cachedKey.has_value() && !job.built;
  if ((job.built || cachedJob) && drawer_) {
    const wgpu::Texture& slotTexture = set.textures[slot];
    // Comp-space caching (frame_scene.hpp CompSpaceFrame): the frame is the
    // comp's own pixels in a texture of its own size, and the slot gets a copy
    // at an integer offset — so the tiers hold one frame across pane sizes
    // and pans. A slot that takes no copies draws in slot space.
    const CompSpaceFrame* cs = job.compSpace && set.copyable ? &*job.compSpace : nullptr;
    const FrameTarget target = cs != nullptr ? comp_target(cs->width, cs->height)
                                             : FrameTarget{.texture = &slotTexture, .view = &set.views[slot], .width = set.width, .height = set.height};
    f.frameWidth = target.width;
    f.frameHeight = target.height;
    const Served served = serve_or_draw(job, target, set.copyable, cs == nullptr, f);
    if (served.missing) {
      // No tier holds it any more (evicted, purged, a lost device): the slot
      // goes back and the session is asked for a built frame — never a blank one.
#if defined(PREMATION_SHARED_TEXTURE)
      if (shared != nullptr) (void)set.pool->end_access(*shared);
#endif
      ring.unacquire(slot);
      return;
    }
    drawn = served.drawn;
    if (drawn && cs != nullptr && served.source != nullptr) {
      present_comp_space(*cs, *served.source, slotTexture, set.views[slot], set.width, set.height);
    }
    if (drawn) note_view_key(port, served.key.value_or(0));
    if (drawn && !job.onion.empty() && compositor_) composite_onion(job, set.views[slot], set.width, set.height);
    // A paused frame whose footage came from a stand-in: wait for the decode, then draw it again.
    MediaWants wants = cachedJob ? MediaWants{} : drawer_->take_media_wants();
    if (job.playing || job.exactMedia || wants.empty()) {
      port.settling.clear();
      port.settleTries = 0;
    } else if (port.settleTries < kMaxSettleTries) {
      port.settling = std::move(wants);
      port.settleAt = SteadyClock::now() + kSettlePoll;
    } else {
      port.settling.clear();
    }
  }
  if (!drawn) {
    // C2's quads (a built frame that failed to draw has none: the slot clears to black).
    wgpu::CommandEncoder enc = gpu_->device.CreateCommandEncoder();
    // The slot is already at the preview resolution (rebuild): no second reduction.
    compositor_->encode(enc, job.scene, set.views[slot], set.width, set.height, 1.0);
    const wgpu::CommandBuffer cb = enc.Finish();
    gpu_->queue.Submit(1, &cb);
    note_view_key(port, 0);
  }
#if defined(PREMATION_SHARED_TEXTURE)
  if (shared != nullptr) (void)set.pool->end_access(*shared);
#endif
  if (set.copy) {
    // Route A: the drawn slot into its read-back buffer, in queue order after the draw.
    wgpu::CommandEncoder enc = gpu_->device.CreateCommandEncoder();
    wgpu::TexelCopyTextureInfo src{};
    src.texture = set.textures[slot];
    wgpu::TexelCopyBufferInfo dst{};
    dst.buffer = set.readback[slot];
    dst.layout.bytesPerRow = set.readbackRow;
    dst.layout.rowsPerImage = set.height;
    const wgpu::Extent3D size{set.width, set.height, 1};
    enc.CopyTextureToBuffer(&src, &dst, &size);
    const wgpu::CommandBuffer cb = enc.Finish();
    gpu_->queue.Submit(1, &cb);
  }
  // Electron's rgba sharedTexture import takes no fence, so a frame is
  // complete on the GPU before its slot is announced (docs/VIEWPORT_ROUTE.md,
  // implication 6). P5: the render thread does not wait for it here — the
  // completion is polled (complete_frames), and the next frame's CPU work
  // (rasters, encoding) runs while this one's GPU work does. Frames are still
  // announced in submission order, each only once its work is done.
  (void)ring;
  f.port = &port;
  f.generation = set.generation;
  f.slot = slot;
  f.copy = set.copy;
  f.t0 = t0;
  f.done = gpu_->queue.OnSubmittedWorkDone(wgpu::CallbackMode::WaitAnyOnly, [](wgpu::QueueWorkDoneStatus, wgpu::StringView) {});
  api::FrameReady& ready = f.ready;
  ready.generation = set.generation;
  ready.slot = slot;
  ready.viewport = job.viewport;
  ready.dropped = job.clockDropped;
  ready.frame = job.frame;
  ready.time = job.time;
  ready.revision = job.revision;
  ready.render_start_us = startUs;
  ready.width = set.width;
  ready.height = set.height;
  // B4 round 2: the overlays' geometry for this frame first (the host pairs it with the FrameReady that follows).
  if (job.geometrySubscribed) {
    // A job drawn again once its footage settles announces its geometry again: keep it.
    f.geometry = port.settling.empty()
                     ? doc::pack_frame_geometry(job.viewport, set.generation, job.frame, job.time, job.revision,
                                                std::move(job.geometry), std::move(job.views))
                     : doc::pack_frame_geometry(job.viewport, set.generation, job.frame, job.time, job.revision, job.geometry,
                                                job.views);
  }
  inflight_.push_back(std::move(f));
}

RenderThread::Served RenderThread::serve_or_draw(RenderJob& job, const FrameTarget& target, bool copyable, bool copyHit,
                                                 InFlight& f) {
  Served out;
  const bool cachedJob = job.cachedKey.has_value() && !job.built;
  if (!cachedJob) drawer_->set_exact_media(job.exactMedia);
  const wgpu::Texture& targetTexture = *target.texture;
  const std::uint32_t width = target.width;
  const std::uint32_t height = target.height;
  std::optional<std::uint64_t> key;
  std::optional<std::uint64_t> diskKey;
  if (cachedJob) {
    if (cache_ && copyable) key = job.cachedKey;
    if (key && job.cachedDiskKey != 0 && disk_->enabled()) diskKey = job.cachedDiskKey;
  } else if (cache_ && copyable && !job.transient) {
    // A transient frame (RenderJob::transient, mid-drag) gets no key: no tier stores it.
    key = drawer_->content_key(*job.built, width, height);
  }
  // Every frame the disk tier could hold is keyed (a hash of the content key
  // and the footage stamps, cached for seconds): whether one is worth a file
  // is known only once it has drawn — the first frame after an open, or the
  // one a new raster lands on, is the slow one a prediction never sees.
  // The prediction is the cheaper of the running average and the last drawn
  // frame: a slow first frame (pipelines compiling) must not make the next
  // ones pay for eager read-backs the real draw time then turns down.
  seed_disk_read_cost();
  // The RAM tier keeps the frames of the range this viewport plays (ram_cache.hpp),
  // and the frame every open view shows now (apply_pins).
  if (job.recordCoverage) protect_ = ProtectedRange{.scope = job.cacheScope, .first = job.rangeFirst, .last = job.rangeLast};
  apply_pins();
  manage_ram_budget(false);
  const FrameTag tag{.scope = job.recordCoverage ? job.cacheScope : 0, .frame = job.frame};
  const double predictedMs = std::min(drawMsAvg_, lastDrawMs_);
  if (!cachedJob && key && disk_->enabled()) diskKey = drawer_->disk_key(*job.built, width, height);
  if (disk_->enabled()) aliasSalt_.store(drawer_->alias_salt(), std::memory_order_relaxed);
  const std::uint64_t dk = diskKey.value_or(0);
  bool drawn = false;
  out.source = &targetTexture;
  if (key) {
    // D4: the same content was drawn before — a copy instead of the frame.
    if (const wgpu::Texture* hit = cache_->use(*key, width, height); hit != nullptr) {
      if (copyHit) {
        wgpu::CommandEncoder enc = gpu_->device.CreateCommandEncoder();
        wgpu::TexelCopyTextureInfo src{};
        src.texture = *hit;
        wgpu::TexelCopyTextureInfo dst{};
        dst.texture = targetTexture;
        const wgpu::Extent3D size{.width = width, .height = height, .depthOrArrayLayers = 1};
        enc.CopyTextureToTexture(&src, &dst, &size);
        const wgpu::CommandBuffer cb = enc.Finish();
        gpu_->queue.Submit(1, &cb);
      } else {
        out.source = hit;  // the caller copies the region it shows straight from the cache
      }
      drawn = true;
      if (FrameMeta* m = cache_->meta(*key)) {
        m->tag = tag;
        if (dk != 0) m->diskKey = dk;
      }
      if (job.recordCoverage) note_coverage(job, *key, dk);
    }
  }
  if (!drawn && key && (ram_.contains(*key) || settle_victim(*key))) {
    // The RAM tier: a frame VRAM evicted — one upload instead of the render.
    // Back into VRAM with it, so scrubbing over it again is a copy.
    if (const std::optional<RamFrame> hit = ram_.find(*key, width, height, tag)) {
      wgpu::TexelCopyTextureInfo dst{};
      dst.texture = targetTexture;
      wgpu::TexelCopyBufferLayout layout{};
      layout.bytesPerRow = width * 4U;
      layout.rowsPerImage = height;
      const wgpu::Extent3D size{.width = width, .height = height, .depthOrArrayLayers = 1};
      gpu_->queue.WriteTexture(&dst, hit->rgba->data(), hit->rgba->size(), &layout, &size);
      store_vram(*key, targetTexture, width, height, FrameMeta{.tag = tag, .drawMs = hit->drawMs, .diskKey = dk != 0 ? dk : hit->diskKey});
      drawn = true;
      if (job.recordCoverage) note_coverage(job, *key, dk);
    }
  }
  if (!drawn && diskKey && disk_->contains(*diskKey) && load_from_disk(*diskKey, width, height, targetTexture)) {
    // The disk tier: a frame VRAM evicted, or one drawn in an earlier
    // session — a file read instead of the render. Back into VRAM and RAM
    // with it, so the next pass over it is a copy again.
    store_vram(*key, targetTexture, width, height, FrameMeta{.tag = tag, .drawMs = 0, .diskKey = *diskKey});
    // The read pixels move into the RAM tier (WriteTexture took its copy); the scratch is refilled next time.
    std::vector<RamFrame> evicted;
    (void)ram_.store(*key,
                     RamFrame{.rgba = std::make_shared<std::vector<std::uint8_t>>(std::move(diskScratch_)),
                              .width = width,
                              .height = height,
                              .drawMs = 0,
                              .diskKey = *diskKey,
                              .tag = tag},
                     protect_, evicted);
    diskScratch_.clear();
    spill_ram_evictions(evicted);
    drawn = true;
    if (job.recordCoverage) note_coverage(job, *key, *diskKey);
  }
  if (!drawn && cachedJob) {
    // No tier holds it any more (evicted, purged, a lost device): forget the
    // entry and ask for a built frame.
    if (job.prebuildKey) prebuild_.forget(*job.prebuildKey);
    {
      const std::scoped_lock lock(m_);
      ++counters_.cacheMissed;
      if (std::ranges::find(buildWanted_, job.viewport) == buildWanted_.end()) buildWanted_.push_back(job.viewport);
    }
    out.missing = true;
    return out;
  }
  if (!drawn) {
    std::string error;
    drawn = drawer_->draw(*job.built, *target.view, width, height, error);
    f.drawn = drawn;
    if (!drawn) {
      PREMATION_LOG(error, "scene_draw_failed").kv("error", error).kv("frame", job.frame);
    } else if (!drawer_->last_frame_exact()) {
      // Footage from a nearest decoded frame (or a GPU error): shown, never cached.
      f.inexact = job.playing;
      f.standIn = true;
      key.reset();
    } else if (key) {
      store_vram(*key, targetTexture, width, height, FrameMeta{.tag = tag, .drawMs = 0, .diskKey = dk});
      f.vramKey = *key;
      // An exact frame not on disk yet, predicted slow: read it back now
      // (before any onion ghost lands on the slot) for the writer once the
      // GPU is done. Predicted fast: complete_frames decides on its real
      // draw time, and reads a slow one back from its VRAM copy.
      if (diskKey && worth_disk(predictedMs, width, height) && disk_->reserve(*diskKey)) {
        queue_disk_readback(f, *diskKey, targetTexture, width, height);
      } else if (diskKey && !disk_->contains(*diskKey)) {
        f.lateDisk = std::make_pair(*key, *diskKey);
      }
      if (job.recordCoverage) note_coverage(job, *key, dk);
    }
  }
  f.cached = drawn && !f.drawn;
  // The pre-build map learns the frame once a tier holds it (served from one,
  // or drawn exact and stored): the next job with this pre-build key skips the build.
  if (!cachedJob && key && job.prebuildKey && (f.cached || f.vramKey)) {
    prebuild_.learn(*job.prebuildKey, CachedKeys{.content = *key, .disk = dk});
    // And for the next session, when its frame is (or will be) a file and
    // nothing outside the document decides its pixels (no footage files).
    if (const std::uint64_t salt = aliasSalt_.load(std::memory_order_relaxed); salt != 0 && dk != 0 && !drawer_->reads_files(*job.built)) {
      disk_->store_alias(alias_key(*job.prebuildKey, salt), *key, dk);
    }
  }
  if (cachedJob && drawn) {
    const std::scoped_lock lock(m_);
    ++counters_.cacheServed;
  }
  out.drawn = drawn;
  out.key = key;
  return out;
}

void RenderThread::present_comp_space(const CompSpaceFrame& cs, const wgpu::Texture& source, const wgpu::Texture& slot,
                                      const wgpu::TextureView& slotView, std::uint32_t width, std::uint32_t height) {
  if (!gpu_) return;  // only reached from a render after init; nothing to present without a device
  // The part of the comp-space texture that lands inside the slot.
  const std::int64_t sx0 = std::max<std::int64_t>(0, -static_cast<std::int64_t>(cs.slotX));
  const std::int64_t sy0 = std::max<std::int64_t>(0, -static_cast<std::int64_t>(cs.slotY));
  const std::int64_t dx0 = std::max<std::int64_t>(0, cs.slotX);
  const std::int64_t dy0 = std::max<std::int64_t>(0, cs.slotY);
  const std::int64_t cw = std::min<std::int64_t>(static_cast<std::int64_t>(cs.width) - sx0, static_cast<std::int64_t>(width) - dx0);
  const std::int64_t ch = std::min<std::int64_t>(static_cast<std::int64_t>(cs.height) - sy0, static_cast<std::int64_t>(height) - dy0);
  const bool covers = dx0 == 0 && dy0 == 0 && std::cmp_greater_equal(cw, width) && std::cmp_greater_equal(ch, height);
  wgpu::CommandEncoder enc = gpu_->device.CreateCommandEncoder();
  if (!covers) {
    // Where the comp does not reach, the slot shows the frame's border: the
    // view's clear colour (opaque black) through the display encode — black.
    // comp_space_frame refuses the views whose border would differ (a channel
    // view, a viewer LUT, the Extended Viewer's pasteboard).
    wgpu::RenderPassColorAttachment att{};
    att.view = slotView;
    att.loadOp = wgpu::LoadOp::Clear;
    att.storeOp = wgpu::StoreOp::Store;
    att.clearValue = wgpu::Color{.r = 0.0, .g = 0.0, .b = 0.0, .a = 1.0};
    wgpu::RenderPassDescriptor rp{};
    rp.colorAttachmentCount = 1;
    rp.colorAttachments = &att;
    wgpu::RenderPassEncoder pass = enc.BeginRenderPass(&rp);
    pass.End();
  }
  if (cw > 0 && ch > 0) {
    wgpu::TexelCopyTextureInfo src{};
    src.texture = source;
    src.origin = wgpu::Origin3D{.x = static_cast<std::uint32_t>(sx0), .y = static_cast<std::uint32_t>(sy0), .z = 0};
    wgpu::TexelCopyTextureInfo dst{};
    dst.texture = slot;
    dst.origin = wgpu::Origin3D{.x = static_cast<std::uint32_t>(dx0), .y = static_cast<std::uint32_t>(dy0), .z = 0};
    const wgpu::Extent3D size{.width = static_cast<std::uint32_t>(cw), .height = static_cast<std::uint32_t>(ch), .depthOrArrayLayers = 1};
    enc.CopyTextureToTexture(&src, &dst, &size);
  }
  const wgpu::CommandBuffer cb = enc.Finish();
  gpu_->queue.Submit(1, &cb);
}

RenderThread::FrameTarget RenderThread::comp_target(std::uint32_t width, std::uint32_t height) {
  // Only reached from a render after init (`gpu_` set); an empty target says so to a caller that checks.
  if (!gpu_) return FrameTarget{};
  ++compTargetUse_;
  for (CompTarget& t : compTargets_) {
    if (t.width == width && t.height == height) {
      t.lastUse = compTargetUse_;
      return FrameTarget{.texture = &t.texture, .view = &t.view, .width = width, .height = height};
    }
  }
  // One texture per size in use (a view's scale); the least recently used goes
  // when more than a few sizes are live — never a texture per frame.
  if (compTargets_.size() >= kCompTargetsKept) {
    const auto oldest = std::ranges::min_element(compTargets_, {}, &CompTarget::lastUse);
    compTargets_.erase(oldest);
  }
  wgpu::TextureDescriptor td{};
  td.label = "comp-space";
  td.size = wgpu::Extent3D{.width = width, .height = height, .depthOrArrayLayers = 1};
  td.format = wgpu::TextureFormat::RGBA8Unorm;
  // RenderAttachment: drawn into; CopySrc: into the slot and the VRAM cache; CopyDst: a RAM or disk hit's upload.
  td.usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::CopySrc | wgpu::TextureUsage::CopyDst;
  CompTarget t;
  t.width = width;
  t.height = height;
  t.texture = gpu_->device.CreateTexture(&td);
  t.view = t.texture.CreateView();
  t.lastUse = compTargetUse_;
  compTargets_.push_back(std::move(t));
  return FrameTarget{.texture = &compTargets_.back().texture, .view = &compTargets_.back().view, .width = width, .height = height};
}

void RenderThread::apply_pins() {
  protect_.clear_pins();
  {
    // ports_ (the map) is the core thread's to grow; lastKey is this thread's.
    const std::scoped_lock lock(m_);
    for (const auto& [id, p] : ports_) {
      if (p->lastKey != 0 && p->config.open) protect_.pin(p->lastKey);
    }
  }
  if (cache_) cache_->set_pinned(protect_);
}

void RenderThread::note_view_key(Port& port, std::uint64_t key) {
  if (port.lastKey == key) return;
  port.lastKey = key;
  apply_pins();
}

void RenderThread::render_prefetch(RenderJob& job) {
  // Exception barrier, as render(): a failed prefetch is logged and answered, nothing else.
  const auto answer = [this] {
    const std::scoped_lock lock(m_);
    ++counters_.prefetched;
  };
  try {
    take_revisions();
    if (!job.built || job.cachedKey || !drawer_ || !cache_ || !gpu_) {
      answer();
      return;
    }
    Port* port = nullptr;
    {
      const std::scoped_lock lock(m_);
      if (const auto it = ports_.find(job.viewport); it != ports_.end()) port = it->second.get();
    }
    // Render thread: `port` stays valid (only this thread erases one). Its slots
    // say the slot size a slot-space frame is keyed by; without them, nothing to key.
    if (port == nullptr || !port->slots || port->slots->width == 0 || port->slots->height == 0 || !port->slots->copyable) {
      answer();
      return;
    }
    const auto t0 = SteadyClock::now();
    const FrameTarget target = job.compSpace ? comp_target(job.compSpace->width, job.compSpace->height)
                                             : comp_target(port->slots->width, port->slots->height);
    InFlight f;
    f.prefetch = true;
    f.buildMs = job.buildMs;
    f.frameWidth = target.width;
    f.frameHeight = target.height;
    f.t0 = t0;
    const Served served = serve_or_draw(job, target, true, true, f);
    if (!served.drawn) {
      abandon_disk(f);
      answer();
      return;
    }
    (void)drawer_->take_media_wants();  // a stand-in frame is not stored; the prefetch moves on
    f.done = gpu_->queue.OnSubmittedWorkDone(wgpu::CallbackMode::WaitAnyOnly, [](wgpu::QueueWorkDoneStatus, wgpu::StringView) {});
    inflight_.push_back(std::move(f));
  } catch (const std::exception& e) {
    PREMATION_LOG(error, "prefetch_failed").kv("frame", job.frame).kv("error", std::string(e.what()));
    answer();
  } catch (...) {
    PREMATION_LOG(error, "prefetch_failed").kv("frame", job.frame).kv("error", "non-standard exception");
    answer();
  }
}

std::size_t RenderThread::complete_frames(bool block) {
  std::size_t n = 0;
  while (!inflight_.empty()) {
    InFlight& f = inflight_.front();
    const wgpu::WaitStatus st = gpu_->instance.WaitAny(f.done, block && n == 0 ? UINT64_MAX : 0);
    if (st == wgpu::WaitStatus::TimedOut) break;
    if (f.prefetch) {
      // Idle render-ahead: no slot, nothing announced. The frame is in the
      // tiers already (serve_or_draw); only its disk read-back and its cost remain.
      const bool ok = st == wgpu::WaitStatus::Success && !gpu_->device_lost();
      if (ok) {
        const double costMs = std::chrono::duration<double, std::milli>(SteadyClock::now() - f.t0).count() + f.buildMs;
        if (f.drawn && f.vramKey && cache_) {
          if (FrameMeta* m = cache_->meta(*f.vramKey)) m->drawMs = costMs;
        }
        const bool worth = f.drawn && worth_disk(costMs, f.frameWidth, f.frameHeight);
        if (f.diskBuffer != nullptr) {
          if (worth) spill_to_disk(f, f.frameWidth, f.frameHeight);
          else abandon_disk(f);
        } else if (worth && f.lateDisk) {
          queue_late_spill(f.lateDisk->first, f.lateDisk->second, f.frameWidth, f.frameHeight);
        }
      } else {
        abandon_disk(f);
      }
      {
        const std::scoped_lock lock(m_);
        if (cache_) cacheStats_ = cache_->stats();
        ++counters_.prefetched;
      }
      inflight_.pop_front();
      ++n;
      continue;
    }
    FrameRing& ring = *f.port->ring;
    SlotSet* set = f.port->slots.get();
    const bool sameSet = set != nullptr && set->generation == f.generation;
    // A failed wait (the device went away under it) never announces the frame.
    if (st != wgpu::WaitStatus::Success || gpu_->device_lost() || !sameSet) {
      // The slot holds nothing: never announced; the loop recovers and draws the job again.
      if (sameSet) ring.unacquire(f.slot);
      abandon_disk(f);
      inflight_.pop_front();
      ++n;
      continue;
    }
    if (f.copy && !send_copy(*set, f.slot)) {
      // No pixels, no FrameReady: the host pairs the two and would wait for pixels forever.
      ring.unacquire(f.slot);
      abandon_disk(f);
      inflight_.pop_front();
      ++n;
      continue;
    }
    lossesSinceFrame_ = 0;
    f.ready.render_done_us = os::epoch_us();
    const double gpuMs = std::chrono::duration<double, std::milli>(SteadyClock::now() - f.t0).count();
    if (send_) {
      for (api::FrameGeometry& g : f.geometry) send_(frames::Message{.v = std::move(g)});
      send_(frames::Message{.v = f.ready});
    }
    // After the announcement: the viewer never waits for the disk cache.
    // What the frame cost to make: its build on the CPU plus its draw here.
    const double costMs = gpuMs + f.buildMs;
    if (f.drawn) {
      drawMsAvg_ = drawMsAvg_ == 0 ? costMs : 0.7 * drawMsAvg_ + 0.3 * costMs;
      lastDrawMs_ = costMs;
      // What the frame cost travels with it down the tiers (the disk tier takes only slow ones).
      if (f.vramKey && cache_) {
        if (FrameMeta* m = cache_->meta(*f.vramKey)) m->drawMs = costMs;
      }
    }
    // The frame's own size (a comp-space texture's, or the slot's): what the tiers hold.
    const std::uint32_t fw = f.frameWidth != 0 ? f.frameWidth : set->width;
    const std::uint32_t fh = f.frameHeight != 0 ? f.frameHeight : set->height;
    const bool worth = f.drawn && worth_disk(costMs, fw, fh);
    if (f.diskBuffer != nullptr) {
      if (worth) {
        spill_to_disk(f, fw, fh);
      } else {
        abandon_disk(f);  // this one drew fast after all: VRAM is enough for it
      }
    } else if (worth && f.lateDisk) {
      queue_late_spill(f.lateDisk->first, f.lateDisk->second, fw, fh);
    }
    {
      const std::lock_guard<std::mutex> lock(m_);
      if (cache_) cacheStats_ = cache_->stats();
      ++counters_.rendered;
      ++f.port->rendered;
      if (f.inexact) ++counters_.inexact;
      if (f.standIn) {
        ++counters_.standIn;
        ++f.port->standIn;
      }
      ++windowFrames_;
      if (f.cached) ++windowCached_;
      windowGpuMs_ += gpuMs;
      // A2: VRAM per frame (the device meter + held footage + the frame cache: a few integer reads).
      counters_.vramBytes = (drawer_ ? drawer_->vram_bytes() : 0) + cacheStats_.bytes;
      const auto now = SteadyClock::now();
      const double secs = std::chrono::duration<double>(now - windowStart_).count();
      if (secs >= 1.0) {
        if (drawer_) counters_.decodeMs = drawer_->decode_ms();
        counters_.fps = static_cast<double>(windowFrames_) / secs;
        counters_.gpuFrameMs = windowGpuMs_ / static_cast<double>(std::max<std::uint64_t>(windowFrames_, 1));
        counters_.cacheHitRate = static_cast<double>(windowCached_) / static_cast<double>(std::max<std::uint64_t>(windowFrames_, 1));
        windowFrames_ = 0;
        windowCached_ = 0;
        windowGpuMs_ = 0;
        windowStart_ = now;
      }
    }
    inflight_.pop_front();
    ++n;
  }
  if (!spills_.empty() && !gpu_->device_lost()) drain_spills(false);
  if (!victims_.empty() && !gpu_->device_lost()) drain_victims(false);
  return n;
}

void RenderThread::complete_all() {
  while (!inflight_.empty()) (void)complete_frames(true);
}

bool RenderThread::send_copy(SlotSet& set, std::uint32_t slot) {
  const wgpu::Buffer& buffer = set.readback[slot];
  const std::uint64_t size = std::uint64_t{set.readbackRow} * set.height;
  bool mapped = false;
  gpu_->instance.WaitAny(buffer.MapAsync(wgpu::MapMode::Read, 0, size, wgpu::CallbackMode::WaitAnyOnly,
                                         [&mapped](wgpu::MapAsyncStatus status, wgpu::StringView) {
                                           mapped = status == wgpu::MapAsyncStatus::Success;
                                         }),
                         UINT64_MAX);
  if (!mapped) {
    PREMATION_LOG(error, "copy_map_failed").kv("slot", slot);
    return false;
  }
  const auto* src = static_cast<const std::uint8_t*>(buffer.GetConstMappedRange(0, static_cast<std::size_t>(size)));
  if (src == nullptr) {
    buffer.Unmap();
    return false;
  }
  pixels::Header header;
  header.generation = set.generation;
  header.slot = slot;
  header.width = set.width;
  header.height = set.height;
  header.bytesPerRow = set.width * 4U;  // tightly packed on the wire (VideoFrame's default layout)
  const std::size_t payload = pixels::kHeaderBytes + pixels::pixel_bytes(header);
  // One allocation per copied frame, on purpose: the pipe writer thread owns
  // the bytes until they are written, and the ring bounds how many exist at
  // once (a slot is not drawn again before the host releases it). Route A is
  // the fallback path; the shared route allocates nothing per frame.
  std::vector<std::uint8_t> framed(framing::kHeaderBytes + payload);
  const auto length = static_cast<std::uint32_t>(payload);
  for (std::size_t i = 0; i < framing::kHeaderBytes; ++i) {
    framed[i] = static_cast<std::uint8_t>((length >> (8U * i)) & 0xFFU);
  }
  const std::span<std::uint8_t> out(framed);
  pixels::encode_header(header, out.subspan(framing::kHeaderBytes, pixels::kHeaderBytes));
  std::uint8_t* rows = framed.data() + framing::kHeaderBytes + pixels::kHeaderBytes;
  const std::size_t rowBytes = header.bytesPerRow;
  for (std::uint32_t y = 0; y < set.height; ++y) {
    std::memcpy(rows + static_cast<std::size_t>(y) * rowBytes, src + static_cast<std::size_t>(y) * set.readbackRow,
                rowBytes);
  }
  buffer.Unmap();
  if (!options_.sendPixels(std::move(framed))) {
    if (!pixelPipeGone_) {
      PREMATION_LOG(warn, "pixel_stream_closed");
    }
    pixelPipeGone_ = true;
    return false;
  }
  return true;
}

}  // namespace premation::render
