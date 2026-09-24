#include "media_system.hpp"

#include <algorithm>
#include <exception>

#include "core/log.hpp"

namespace premation::media {

using Clock = std::chrono::steady_clock;

struct MediaSystem::Source {
  SourceId id = 0;
  std::string path;
  MediaInfo info;

  mutable std::mutex mu;
  std::condition_variable wake;
  std::shared_ptr<const FrameIndex> index;
  bool ready = false;
  bool failed = false;
  bool closing = false;
  // latest lane: one pending target (replaced, never queued) + its generation
  std::int64_t latest = -1;
  std::atomic<std::uint64_t> generation{0};
  // exact lane: FIFO
  std::deque<std::int64_t> exact;
  // playback
  std::int64_t playhead = -1;
  int direction = 0;
  Clock::time_point lastDelivery = Clock::now();
  SourceStats stats;
  std::thread worker;
  // Background exact-index scan (long-GOP streams the container can't index).
  std::thread scanner;
  std::atomic<bool> stopScan{false};
  std::optional<FrameIndex> scanned;  // under mu, taken by the worker
};


namespace {
void stop_source(std::shared_ptr<MediaSystem::Source>& s) {
  {
    const std::scoped_lock lock(s->mu);
    s->closing = true;
    s->generation.fetch_add(1);
  }
  s->stopScan.store(true);
  s->wake.notify_all();
  if (s->worker.joinable()) s->worker.join();
  if (s->scanner.joinable()) s->scanner.join();
}
}  // namespace

MediaSystem::MediaSystem(MediaConfig config) : config_(std::move(config)), cache_(config_.cpuCacheBytes, config_.gpuCacheBytes) {}

MediaSystem::~MediaSystem() {
  try {
    shutdown();
  } catch (...) {
    // A join that throws (std::system_error) leaves a thread we cannot account
    // for: the engine process must not continue in that state.
    std::terminate();
  }
}

void MediaSystem::shutdown() {
  std::unordered_map<SourceId, std::shared_ptr<Source>> all;
  {
    const std::scoped_lock lock(mu_);
    all.swap(sources_);
  }
  for (auto& [id, s] : all) {
    {
      const std::scoped_lock lock(s->mu);
      s->closing = true;
      s->generation.fetch_add(1);
    }
    s->stopScan.store(true);
    s->wake.notify_all();
  }
  for (auto& [id, s] : all) stop_source(s);
  cache_.clear();  // frames (and their GPU surfaces) before the HwContext goes
}

std::optional<SourceId> MediaSystem::open(const std::string& path, std::string& error) {
  auto s = std::make_shared<Source>();
  FrameIndex idx;
  if (!VideoDecoder::probe(path, s->info, idx, error)) return std::nullopt;
  s->path = path;
  s->index = std::make_shared<const FrameIndex>(std::move(idx));
  {
    const std::scoped_lock lock(mu_);
    s->id = next_++;
    sources_.emplace(s->id, s);
  }
  s->worker = std::thread([this, s] {
    try {
      run(*s);
    } catch (const std::exception& e) {
      // One bad source never takes the engine down (CLAUDE.md reliability):
      // it fails, its requests resolve to nothing, the rest keep decoding.
      {
        const std::scoped_lock lock(s->mu);
        s->failed = true;
        s->stats.error = std::string("decoder thread: ") + e.what();
      }
      signal();
    }
  });
  return s->id;
}

void MediaSystem::close(SourceId id) {
  std::shared_ptr<Source> s;
  {
    const std::scoped_lock lock(mu_);
    const auto it = sources_.find(id);
    if (it == sources_.end()) return;
    s = it->second;
    sources_.erase(it);
  }
  stop_source(s);
  cache_.drop_source(id);
}

std::shared_ptr<MediaSystem::Source> MediaSystem::find(SourceId id) const {
  const std::scoped_lock lock(mu_);
  const auto it = sources_.find(id);
  return it == sources_.end() ? nullptr : it->second;
}

bool MediaSystem::info(SourceId id, MediaInfo& out) const {
  const auto s = find(id);
  if (!s) return false;
  const std::scoped_lock lock(s->mu);
  out = s->info;
  return true;
}

std::shared_ptr<const FrameIndex> MediaSystem::index(SourceId id) const {
  const auto s = find(id);
  if (!s) return nullptr;
  const std::scoped_lock lock(s->mu);
  return s->index;
}

bool MediaSystem::wait_ready(SourceId id, std::chrono::milliseconds timeout) {
  const auto s = find(id);
  if (!s) return false;
  std::unique_lock lock(doneMu_);
  const bool ok = done_.wait_for(lock, timeout, [&] {
    const std::scoped_lock sl(s->mu);
    return s->ready || s->failed;
  });
  const std::scoped_lock sl(s->mu);
  return ok && s->ready;
}

FramePtr MediaSystem::cached(SourceId id, std::int64_t frame) { return cache_.get(id, frame); }

FramePtr MediaSystem::nearest(SourceId id, std::int64_t frame) const { return cache_.nearest(id, frame); }

FramePtr MediaSystem::request(SourceId id, std::int64_t frame, Lane lane) {
  if (FramePtr hit = cache_.get(id, frame)) return hit;
  const auto s = find(id);
  if (!s) return nullptr;
  {
    const std::scoped_lock lock(s->mu);
    if (s->failed) return nullptr;
    frame = s->index ? s->index->clamp(frame) : frame;
    if (lane == Lane::latest) {
      if (s->latest == frame) return nullptr;  // already the pending target
      if (s->latest >= 0) ++s->stats.superseded;
      s->latest = frame;
      s->generation.fetch_add(1);
    } else {
      if (std::find(s->exact.begin(), s->exact.end(), frame) == s->exact.end()) s->exact.push_back(frame);
    }
  }
  s->wake.notify_one();
  return nullptr;
}

FramePtr MediaSystem::wait(SourceId id, std::int64_t frame, Lane lane, std::chrono::milliseconds timeout) {
  const auto s = find(id);
  if (!s) return nullptr;
  {
    const std::scoped_lock lock(s->mu);
    if (s->index) frame = s->index->clamp(frame);
  }
  if (FramePtr hit = request(id, frame, lane)) return hit;
  const auto deadline = Clock::now() + timeout;
  std::unique_lock lock(doneMu_);
  FramePtr out;
  done_.wait_until(lock, deadline, [&] {
    if (cache_.contains(id, frame)) return true;
    const std::scoped_lock sl(s->mu);
    return s->failed || s->closing;
  });
  lock.unlock();
  return cache_.get(id, frame);
}

void MediaSystem::playhead(SourceId id, std::int64_t frame, int direction) {
  const auto s = find(id);
  if (!s) return;
  {
    const std::scoped_lock lock(s->mu);
    s->playhead = frame;
    s->direction = direction > 0 ? 1 : (direction < 0 ? -1 : 0);
  }
  s->wake.notify_one();
}

SourceStats MediaSystem::stats(SourceId id) const {
  const auto s = find(id);
  if (!s) return {};
  const std::scoped_lock lock(s->mu);
  return s->stats;
}

void MediaSystem::note_fallback(Source& s, const std::string& why) {
  // Under s.mu. Once per source: the clip stays in software from here.
  s.stats.hwFallback = why;
  PREMATION_LOG(warn, "media_hw_fallback").kv("source", s.id).kv("path", s.path).kv("reason", why);
}

void MediaSystem::signal() {
  // Take the waiters' mutex so a waiter between its predicate check and its
  // sleep cannot miss this notification.
  { const std::scoped_lock lock(doneMu_); }
  done_.notify_all();
}

// ── the worker ──────────────────────────────────────────────────────────────

void MediaSystem::run(Source& s) {
  DecoderOptions opt;
  opt.hw = config_.hw;
  opt.hwContext = config_.hwContext;
  opt.keepOnGpu = config_.keepOnGpu;
  opt.threads = config_.decodeThreads;
  opt.keepHighBitOnGpu = config_.keepHighBitOnGpu;
  opt.failHwAtFrame = config_.failHwAtFrame;
  opt.scanIndex = false;  // scanned in the background below
  std::string error;
  std::unique_ptr<VideoDecoder> dec = VideoDecoder::open(s.path, opt, error);
  std::string openFallback;
  if (!dec && opt.hw == HwPolicy::automatic && opt.hwContext) {
    // A hardware open failure is never fatal in automatic mode.
    openFallback = std::string(to_string(hw_path(*opt.hwContext))) + ": open: " + error;
    opt.hw = HwPolicy::softwareOnly;
    dec = VideoDecoder::open(s.path, opt, error);
  }
  {
    const std::scoped_lock lock(s.mu);
    if (!dec) {
      s.failed = true;
      s.stats.error = error;
    } else {
      s.ready = true;
      s.stats.ready = true;
      s.stats.path = dec->path();
      if (!openFallback.empty()) note_fallback(s, openFallback);
      // The decoder's index can be exact where the probe's was constant-rate
      // (a scanned long-GOP stream). Frame numbers only move for VFR content;
      // drop anything cached under the old numbering then.
      const auto& fresh = dec->index();
      const bool moved = !s.index || s.index->size() != fresh.size() ||
                         (fresh.size() > 0 && s.index->time_us(fresh.size() - 1) != fresh.time_us(fresh.size() - 1));
      s.index = std::make_shared<const FrameIndex>(fresh);
      s.info = dec->info();
      if (moved) cache_.drop_source(s.id);
    }
  }
  signal();
  if (!dec) return;
  if (config_.scanIndex && !dec->index().exact() && dec->info().video) {
    const std::string path = s.path;
    const int stream = dec->info().video->streamIndex;
    // NOLINTNEXTLINE(bugprone-exception-escape): the body is one try/catch(...); the analysis still counts the closure's destructor
    s.scanner = std::thread([&s, path, stream] {
      try {
        const auto t0 = Clock::now();
        FrameIndex fi;
        std::string err;
        if (!scan_index(path, stream, fi, err, &s.stopScan)) return;
        {
          const std::scoped_lock lock(s.mu);
          s.scanned = std::move(fi);
          s.stats.indexScanMs = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
        }
        s.wake.notify_all();
      } catch (...) {  // NOLINT(bugprone-empty-catch): out of memory scanning — the source keeps its constant-rate index
      }
    });
  }

  for (;;) {
    std::int64_t target = -1;
    Lane lane = Lane::latest;
    bool readahead = false;
    {
      std::unique_lock lock(s.mu);
      s.wake.wait(lock, [&] {
        if (s.closing || s.scanned) return true;
        if (s.latest >= 0 || !s.exact.empty()) return true;
        return s.direction != 0 && s.playhead >= 0;
      });
      if (s.closing) return;
      if (s.scanned) {
        // The exact index replaces the constant-rate one. Frame numbers only
        // move for variable-rate content; drop what was cached under the old numbering then.
        const FrameIndex& old = *s.index;
        FrameIndex fresh = std::move(*s.scanned);
        s.scanned.reset();
        bool moved = old.size() != fresh.size();
        for (std::int64_t i = 0; i < fresh.size() && !moved; i += std::max<std::int64_t>(1, fresh.size() / 64)) {
          moved = old.pts(i) != fresh.pts(i);
        }
        s.index = std::make_shared<const FrameIndex>(fresh);
        dec->set_index(std::move(fresh));
        s.info.video->exactIndex = true;
        s.info.video->frameCount = s.index->size();
        if (moved) cache_.drop_source(s.id);
        continue;
      }
      const FrameIndex& idx = *s.index;
      if (s.latest >= 0) {
        target = s.latest;
        s.latest = -1;
        lane = Lane::latest;
        if (cache_.contains(s.id, target)) continue;
      } else if (!s.exact.empty()) {
        target = s.exact.front();
        s.exact.pop_front();
        lane = Lane::exact;
        if (cache_.contains(s.id, target)) continue;
      } else {
        // Readahead: the first missing frame within the window. The window is
        // capped by half of what the cache holds of frames this size.
        int window = std::max(1, config_.readahead);
        if (const FramePtr any = cache_.nearest(s.id, s.playhead); any) {
          const std::size_t bytes = std::max<std::size_t>(1, any->cpuBytes + any->gpuBytes);
          const std::size_t budget = any->gpuBytes > 0 ? config_.gpuCacheBytes : config_.cpuCacheBytes;
          window = std::clamp(static_cast<int>(budget / bytes / 2), 1, window);
        }
        for (int k = 1; k <= window; ++k) {
          const std::int64_t f = s.playhead + static_cast<std::int64_t>(k) * s.direction;
          if (f < 0 || f >= idx.size()) break;
          if (!cache_.contains(s.id, f)) {
            target = f;
            break;
          }
        }
        if (target < 0) {
          // Window full: sleep until a new hint or request arrives.
          const std::int64_t ph = s.playhead;
          const int dir = s.direction;
          s.wake.wait(lock, [&] { return s.closing || s.latest >= 0 || !s.exact.empty() || s.playhead != ph || s.direction != dir; });
          continue;
        }
        readahead = true;
        lane = Lane::latest;
      }
    }
    if (!decode_to(s, *dec, target, lane, readahead)) continue;
  }
}

bool MediaSystem::decode_to(Source& s, VideoDecoder& dec, std::int64_t target, Lane lane, bool readahead) {
  std::shared_ptr<const FrameIndex> idxRef;
  {
    const std::scoped_lock lock(s.mu);
    idxRef = s.index;
  }
  const FrameIndex& idx = *idxRef;
  std::string error;
  // Continue the running decode when the target is ahead in the same GOP (or
  // simply next in a sequential walk); otherwise seek to its keyframe. An
  // intra-only stream (ProRes, DNxHR) seeks unless the target IS the next
  // frame: a seek there is an index lookup, while decoding through a skipped
  // frame costs a whole frame — so a scrub decodes exactly one frame.
  const std::int64_t pos = dec.position();
  const bool intra = dec.info().video && dec.info().video->intraOnly;
  const bool reachable = pos >= 0 && pos <= target &&
                         (intra ? pos == target : (idx.gop_of(pos) == idx.gop_of(target) || target - pos <= 2));
  if (!reachable) {
    if (!dec.seek(target, error)) {
      const std::scoped_lock lock(s.mu);
      s.stats.error = error;
      return true;
    }
    const std::scoped_lock lock(s.mu);
    ++s.stats.seeks;
  }
  std::uint64_t gen = s.generation.load();
  const bool cancellable = lane == Lane::latest;
  for (;;) {
    FramePtr f;
    const auto t0 = Clock::now();
    const DecodeStatus st = dec.next(f, error, cancellable ? &s.generation : nullptr, gen);
    const double ms = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
    if (st == DecodeStatus::frame) {
      const std::int64_t got = f->index;
      const DecodePath via = f->path;
      cache_.put(s.id, got, std::move(f));
      {
        const std::scoped_lock lock(s.mu);
        s.stats.path = via;  // a hardware decoder may hand a stream back to software (refused, or failed mid-stream)
        if (s.stats.hwFallback.empty() && !dec.hw_fallback().empty()) note_fallback(s, dec.hw_fallback());
        ++s.stats.framesDecoded;
        s.stats.msPerFrame = s.stats.msPerFrame == 0 ? ms : s.stats.msPerFrame * 0.8 + ms * 0.2;
        // Metadata the first frames revealed (HDR10 SEI).
        if (s.info.video && dec.info().video && (s.info.video->color.mastering.has_value() != dec.info().video->color.mastering.has_value() ||
                                                 s.info.video->color.contentLight.has_value() != dec.info().video->color.contentLight.has_value())) {
          s.info.video->color = dec.info().video->color;
        }
        if (got >= target) s.lastDelivery = Clock::now();
      }
      signal();
      if (got >= target) return true;  // (got > target: the target frame is missing from the stream)
      continue;
    }
    if (st == DecodeStatus::eof || st == DecodeStatus::error) {
      {
        const std::scoped_lock lock(s.mu);
        if (st == DecodeStatus::error) s.stats.error = error;
      }
      // Cache holds whatever was decoded; a missing target resolves to nothing
      // (callers fall back to nearest()). Force a seek next time.
      std::string ignored;
      (void)dec.seek(target, ignored);
      signal();
      return true;
    }
    // cancelled: a newer request arrived. Decide keep / retarget / abandon.
    std::unique_lock lock(s.mu);
    gen = s.generation.load();
    if (s.closing) return false;
    if (lane == Lane::latest && s.latest >= 0) {
      const std::int64_t next = s.latest;
      const std::int64_t at = std::max<std::int64_t>(dec.position(), 0);
      if (readahead) {
        // A scrub request always beats readahead.
        ++s.stats.abandoned;
        return false;
      }
      if (next >= at && idx.gop_of(next) == idx.gop_of(target)) {
        // Further along the same GOP: absorb it.
        s.latest = -1;
        target = next;
        ++s.stats.retargets;
        continue;
      }
      const double remainingMs = static_cast<double>(std::max<std::int64_t>(1, target - at + 1)) * s.stats.msPerFrame;
      const double starvedMs = std::chrono::duration<double, std::milli>(Clock::now() - s.lastDelivery).count();
      if (remainingMs <= config_.keepInFlightMs || starvedMs >= config_.starvationMs) {
        ++s.stats.kept;
        // Finish this one (uncancellable from here), then the worker takes `latest`.
        lock.unlock();
        for (;;) {
          FramePtr g;
          const DecodeStatus st2 = dec.next(g, error);
          if (st2 != DecodeStatus::frame) break;
          const std::int64_t got = g->index;
          cache_.put(s.id, got, std::move(g));
          {
            const std::scoped_lock l2(s.mu);
            ++s.stats.framesDecoded;
            if (got >= target) s.lastDelivery = Clock::now();
          }
          signal();
          if (got >= target) break;
        }
        return true;
      }
      ++s.stats.abandoned;
      return false;
    }
    // Not a latest request (an exact one, a playhead move): keep going.
  }
}

}  // namespace premation::media
