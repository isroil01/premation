// A FrameSink without a GPU: the same slot ring and frame-channel messages as
// the render thread, with "rendering" being instantaneous. Used by
// `premation-engine --no-gpu` (protocol work and CI machines with no adapter),
// by the session tests and by the protocol fuzzer — so ring exhaustion, stale
// releases and a host that never releases are exercised without Dawn.
#pragma once

#include <functional>
#include <future>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <unordered_set>
#include <utility>
#include <vector>

#include "frame_scene.hpp"
#include "overlay_geometry.hpp"
#include "premation/protocol/frame_channel.hpp"
#include "render/coverage_ledger.hpp"
#include "render/frame_ring.hpp"

namespace premation {

class SimulatedSink final : public FrameSink {
 public:
  using SendFrames = std::function<void(const frames::Message&)>;

  explicit SimulatedSink(SendFrames send, std::uint32_t slots = 3) : send_(std::move(send)), slots_(slots) {}

  void submit(RenderJob job) override {
    const std::lock_guard<std::mutex> lock(m_);
    ++submitted_;
    lastScene_ = job.scene;
    const auto it = ports_.find(job.viewport);
    if (job.prefetch) {
      // Idle render-ahead: stored (held, learned, on the bars), never presented, answered at once.
      if (it != ports_.end() && it->second->config.open && contentKeyOf && !job.cachedKey) {
        if (const std::optional<std::uint64_t> key = contentKeyOf(job)) {
          held.insert(*key);
          if (job.prebuildKey) prebuild.learn(*job.prebuildKey, CachedKeys{.content = *key, .disk = 0});
          if (job.recordCoverage) ledger.note(job, CachedKeys{.content = *key, .disk = 0}, prebuild, held_pred());
        }
      }
      ++counters_.prefetched;
      ++prefetched_;
      return;
    }
    if (it == ports_.end() || !it->second->config.open) {
      ++counters_.dropped;  // no such viewport (closed meanwhile): nowhere to put it
      if (job.cachedKey) ++counters_.cacheDropped;
      return;
    }
    // The cache tiers, simulated: a content key is "held" once a built frame
    // with it was submitted (tests evict by erasing from `held`). A cached
    // job (no build) is presented when its key is held, else it is a miss the
    // session answers with a build — as the render thread does.
    if (job.cachedKey) {
      if (!held.contains(*job.cachedKey)) {
        ++counters_.cacheMissed;
        if (job.prebuildKey) prebuild.forget(*job.prebuildKey);
        buildWanted_.push_back(job.viewport);
        return;
      }
      ++counters_.cacheServed;
      if (job.recordCoverage) ledger.note(job, CachedKeys{*job.cachedKey, job.cachedDiskKey}, prebuild, held_pred());
    } else if (contentKeyOf) {
      if (const std::optional<std::uint64_t> key = contentKeyOf(job)) {
        held.insert(*key);
        if (job.prebuildKey) prebuild.learn(*job.prebuildKey, CachedKeys{*key, 0});
        if (job.recordCoverage) ledger.note(job, CachedKeys{*key, 0}, prebuild, held_pred());
      }
    }
    Port& p = *it->second;
    if (p.pending) {
      ++counters_.dropped;
      if (p.pending->playing) ++p.droppedPending;  // as RenderThread::submit: only playback frames are drops
      if (p.pending->cachedKey) ++counters_.cacheDropped;
    }
    p.droppedPending += job.clockDropped;
    p.pending = std::move(job);
    pump_locked(p);
  }

  [[nodiscard]] bool job_pending(std::uint32_t viewport) const override {
    const std::lock_guard<std::mutex> lock(m_);
    const auto it = ports_.find(viewport);
    return it != ports_.end() && it->second->pending.has_value();
  }
  void note_dropped(std::uint32_t viewport, std::uint32_t skipped, std::uint32_t clockJumped) override {
    const std::lock_guard<std::mutex> lock(m_);
    const auto it = ports_.find(viewport);
    if (it == ports_.end()) return;
    it->second->droppedPending += skipped + clockJumped;
    counters_.dropped += skipped;
  }

  /// Each viewport has its own ring (a generation unique across viewports); a
  /// closed viewport announces an empty ring and is forgotten.
  void configure(const ViewportConfig& config) override {
    const std::lock_guard<std::mutex> lock(m_);
    auto it = ports_.find(config.viewport);
    if (it == ports_.end()) {
      if (!config.open) return;
      it = ports_.emplace(config.viewport, std::make_unique<Port>()).first;
    }
    Port& p = *it->second;
    lastConfig_ = config;
    p.config = config;
    p.generation = ++generation_;
    const std::uint32_t count = config.open ? slots_ : 0;
    p.ring.reset(p.generation, count);
    api::FrameSlots s;
    s.generation = p.generation;
    s.viewport = config.viewport;
    s.width = config.width;
    s.height = config.height;
    s.handles.assign(count, 0);
    if (send_) send_(frames::Message{.v = std::move(s)});
    if (!config.open) ports_.erase(it);
  }

  void set_shared(bool) override {}
  [[nodiscard]] bool shared_supported() const override { return false; }
  [[nodiscard]] RenderCounters counters() const override {
    const std::lock_guard<std::mutex> lock(m_);
    return counters_;
  }
  /// The simulation announces every job it gets: one viewport's share is the whole.
  [[nodiscard]] PortCounters port_counters(std::uint32_t /*viewport*/) const override {
    const std::lock_guard<std::mutex> lock(m_);
    return PortCounters{counters_.rendered, counters_.standIn};
  }

  // ── the simulated cache tiers (render/coverage_ledger.hpp) ──
  /// Tests: the content key a submitted BUILT job's frame has (null = never cached).
  std::function<std::optional<std::uint64_t>(const RenderJob&)> contentKeyOf;
  /// Content keys a tier "holds" (every built frame's, until a test erases it).
  std::unordered_set<std::uint64_t> held;
  render::PrebuildMap prebuild;
  render::CoverageLedger ledger;  // under m_
  [[nodiscard]] std::optional<CachedKeys> cached_frame(std::uint64_t key) const override { return prebuild.find(key); }
  void note_frames_changed(FrameRevision rev) override {
    const std::lock_guard<std::mutex> lock(m_);
    ledger.note_revision(std::move(rev));
  }
  [[nodiscard]] std::vector<std::uint32_t> take_build_requests() override {
    const std::lock_guard<std::mutex> lock(m_);
    std::vector<std::uint32_t> out;
    out.swap(buildWanted_);
    return out;
  }
  /// The bars: the current scope's frames of every viewport whose key is still held.
  [[nodiscard]] CacheCoverageSnap cache_coverage() const override {
    const std::lock_guard<std::mutex> lock(m_);
    std::vector<std::int64_t> frames;
    for (const auto& [viewport, scopes] : ledger.viewports()) {
      if (scopes.empty()) continue;
      for (const auto& [frame, keys] : scopes.front().frames) {
        if (held.contains(keys.content)) frames.push_back(frame);
      }
    }
    CacheCoverageSnap snap;
    snap.ram = coalesce_frame_indices(std::move(frames));
    return snap;
  }
  void purge_frame_cache() override {
    const std::lock_guard<std::mutex> lock(m_);
    held.clear();
    prebuild.clear();
  }
  /// Tests: what a render thread would have measured (VRAM, the last slot-size switch).
  void set_counters(const RenderCounters& c) {
    const std::lock_guard<std::mutex> lock(m_);
    counters_ = c;
  }
  [[nodiscard]] std::string adapter() const override { return "none (simulated)"; }
  [[nodiscard]] std::string backend() const override { return "none"; }

  /// Tests: what render_still / read_pixels answer (unset = no renderer, the
  /// FrameSink defaults). Called on the caller's thread.
  std::function<StillImage(std::uint32_t width, std::uint32_t height)> onStill;
  std::function<WorkingPixels(std::uint32_t viewport, PixelRegion region)> onReadPixels;
  /// Tests: a render thread that answers LATER (the future the test resolves
  /// itself). Wins over onStill when set.
  std::function<std::future<StillImage>(std::uint32_t width, std::uint32_t height)> onStillLater;
  [[nodiscard]] std::future<StillImage> render_still(std::shared_ptr<BuiltFrame> frame, std::uint32_t width,
                                                     std::uint32_t height) override {
    if (onStillLater) return onStillLater(width, height);
    if (!onStill) return FrameSink::render_still(std::move(frame), width, height);
    return ready_future(onStill(width, height));
  }
  [[nodiscard]] std::future<WorkingPixels> read_pixels(std::uint32_t viewport, PixelRegion region) override {
    if (!onReadPixels) return FrameSink::read_pixels(viewport, region);
    return ready_future(onReadPixels(viewport, region));
  }
  /// Tests: what read_frame answers (sampleImage's draws), with the frame it was given.
  std::function<WorkingPixels(const BuiltFrame& frame, std::uint32_t width, std::uint32_t height)> onReadFrame;
  [[nodiscard]] std::future<WorkingPixels> read_frame(std::shared_ptr<BuiltFrame> frame, std::uint32_t width,
                                                      std::uint32_t height) override {
    if (!onReadFrame || !frame) return FrameSink::read_frame(std::move(frame), width, height);
    return ready_future(onReadFrame(*frame, width, height));
  }

  void release(std::uint32_t generation, std::uint32_t slot) {
    const std::lock_guard<std::mutex> lock(m_);
    for (auto& [id, p] : ports_) {
      if (p->generation == generation) {
        if (p->ring.release(generation, slot)) pump_locked(*p);
        return;
      }
    }
  }

  [[nodiscard]] std::uint64_t submitted() const {
    const std::lock_guard<std::mutex> lock(m_);
    return submitted_;
  }
  /// Tests: idle render-ahead jobs (RenderJob::prefetch) this sink took.
  [[nodiscard]] std::uint64_t prefetched() const {
    const std::scoped_lock lock(m_);
    return prefetched_;
  }
  [[nodiscard]] FrameScene last_scene() const {
    const std::lock_guard<std::mutex> lock(m_);
    return lastScene_;
  }
  /// The config last given to configure (any viewport).
  [[nodiscard]] ViewportConfig config() const {
    const std::lock_guard<std::mutex> lock(m_);
    return lastConfig_;
  }
  /// The config of one open viewport (a default, closed one when there is none).
  [[nodiscard]] ViewportConfig config(std::uint32_t viewport) const {
    const std::lock_guard<std::mutex> lock(m_);
    const auto it = ports_.find(viewport);
    return it == ports_.end() ? ViewportConfig{} : it->second->config;
  }

 private:
  struct Port {
    ViewportConfig config;
    std::uint32_t generation = 0;
    render::FrameRing ring;
    std::optional<RenderJob> pending;
    std::uint32_t droppedPending = 0;
  };

  void pump_locked(Port& p) {
    if (!p.pending || !p.config.open) return;
    const auto slot = p.ring.acquire();
    if (!slot) return;  // ring full: keep the newest job until a release
    api::FrameReady f;
    f.generation = p.generation;
    f.slot = *slot;
    f.viewport = p.pending->viewport;
    f.dropped = p.droppedPending;
    f.frame = p.pending->frame;
    f.time = p.pending->time;
    f.revision = p.pending->revision;
    f.width = p.config.width;
    f.height = p.config.height;
    p.droppedPending = 0;
    // B4 round 2: the overlays' geometry first, as the render thread sends it.
    if (p.pending->geometrySubscribed && send_) {
      for (api::FrameGeometry& g : doc::pack_frame_geometry(f.viewport, f.generation, f.frame, f.time, f.revision,
                                                            std::move(p.pending->geometry), std::move(p.pending->views))) {
        send_(frames::Message{.v = std::move(g)});
      }
    }
    p.pending.reset();
    ++counters_.rendered;
    if (send_) send_(frames::Message{.v = f});
  }

  [[nodiscard]] render::CoverageLedger::Held held_pred() const {
    return [this](const CachedKeys& k) { return held.contains(k.content); };
  }
  std::vector<std::uint32_t> buildWanted_;  // m_

  SendFrames send_;
  std::uint32_t slots_;
  mutable std::mutex m_;
  /// unique_ptr: FrameRing holds a mutex (not movable).
  std::map<std::uint32_t, std::unique_ptr<Port>> ports_;
  std::uint32_t generation_ = 0;
  ViewportConfig lastConfig_;
  RenderCounters counters_;
  std::uint64_t submitted_ = 0;
  std::uint64_t prefetched_ = 0;
  FrameScene lastScene_;
};

}  // namespace premation
