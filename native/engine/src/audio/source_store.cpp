#include "source_store.hpp"

#include <algorithm>
#include <cmath>
#include <utility>

namespace premation::audio {

// ── PeakPyramid ─────────────────────────────────────────────────────────────

PeakPyramid::PeakPyramid(int channels) : channels_(channels) {
  levels_.emplace_back(static_cast<std::size_t>(channels) + 1);
  partial_.assign(static_cast<std::size_t>(channels) + 1, Bucket{});
}

std::size_t PeakPyramid::bucket_frames(std::size_t l) const noexcept {
  std::size_t f = kBase;
  for (std::size_t i = 0; i < l; ++i) f *= kFold;
  return f;
}

namespace {

void add_sample(PeakPyramid::Bucket& b, float v) noexcept {
  if (b.n == 0) {
    b.mn = v;
    b.mx = v;
  } else {
    b.mn = std::min(b.mn, v);
    b.mx = std::max(b.mx, v);
  }
  b.sumSq += static_cast<double>(v) * static_cast<double>(v);
  ++b.n;
}

PeakPyramid::Bucket merge(const PeakPyramid::Bucket& a, const PeakPyramid::Bucket& b) noexcept {
  if (a.n == 0) return b;
  if (b.n == 0) return a;
  return {std::min(a.mn, b.mn), std::max(a.mx, b.mx), a.sumSq + b.sumSq, a.n + b.n};
}

}  // namespace

void PeakPyramid::append(const float* const* planes, std::size_t n) {
  const auto nch = static_cast<std::size_t>(channels_);
  for (std::size_t i = 0; i < n; ++i) {
    double mono = 0;
    for (std::size_t c = 0; c < nch; ++c) {
      add_sample(partial_[c], planes[c][i]);
      mono += planes[c][i];
    }
    add_sample(partial_[nch], static_cast<float>(mono / static_cast<double>(nch)));
    if (partial_[0].n == kBase) {
      for (std::size_t c = 0; c <= nch; ++c) {
        levels_[0][c].push_back(partial_[c]);
        partial_[c] = Bucket{};
      }
      fold_up(0);
    }
  }
}

void PeakPyramid::fold_up(std::size_t from) {
  // When a level gains a complete group of kFold buckets, the level above
  // gains one.
  for (std::size_t l = from;; ++l) {
    const std::size_t count = levels_[l][0].size();
    if (count == 0 || count % kFold != 0) return;
    if (l + 1 >= levels_.size()) levels_.emplace_back(static_cast<std::size_t>(channels_) + 1);
    for (std::size_t c = 0; c <= static_cast<std::size_t>(channels_); ++c) {
      Bucket m;
      for (std::size_t k = count - kFold; k < count; ++k) m = merge(m, levels_[l][c][k]);
      levels_[l + 1][c].push_back(m);
    }
  }
}

void PeakPyramid::finish() {
  const auto nch = static_cast<std::size_t>(channels_);
  if (partial_[0].n != 0) {
    for (std::size_t c = 0; c <= nch; ++c) {
      levels_[0][c].push_back(partial_[c]);
      partial_[c] = Bucket{};
    }
  }
  // Rebuild the upper levels including their trailing partial groups (while
  // conforming, only complete groups were folded).
  levels_.resize(1);
  for (std::size_t l = 0; levels_[l][0].size() > 1; ++l) {
    levels_.emplace_back(nch + 1);
    const std::size_t count = levels_[l][0].size();
    for (std::size_t c = 0; c <= nch; ++c) {
      auto& up = levels_[l + 1][c];
      for (std::size_t k = 0; k < count; k += kFold) {
        Bucket m;
        for (std::size_t j = k; j < std::min(count, k + kFold); ++j) m = merge(m, levels_[l][c][j]);
        up.push_back(m);
      }
    }
  }
}

// ── SourceData ──────────────────────────────────────────────────────────────

SourceData::SourceData(int channels, double sampleRate, std::int64_t maxFrames)
    : channels_(std::clamp(channels, 1, 2)),
      sampleRate_(sampleRate),
      capacity_(static_cast<std::size_t>(std::max<std::int64_t>(maxFrames, 1) + static_cast<std::int64_t>(kChunk) - 1) /
                kChunk),
      chunks_(capacity_),
      peaks_(channels_) {
  for (std::size_t i = 0; i < capacity_; ++i) chunks_[i].store(nullptr, std::memory_order_relaxed);
}

SourceData::~SourceData() = default;

std::shared_ptr<SourceData> SourceData::from_planes(const std::vector<std::vector<float>>& planes, double sampleRate) {
  const std::size_t n = planes.empty() ? 0 : planes[0].size();
  auto s = std::make_shared<SourceData>(static_cast<int>(planes.size()), sampleRate, static_cast<std::int64_t>(n));
  std::vector<const float*> p;
  p.reserve(planes.size());
  for (const auto& v : planes) p.push_back(v.data());
  s->append(p.data(), n);
  s->finish();
  return s;
}

bool SourceData::append(const float* const* planes, std::size_t n) {
  const auto nch = static_cast<std::size_t>(channels_);
  auto pos = static_cast<std::size_t>(ready_.load(std::memory_order_relaxed));
  std::size_t done = 0;
  bool ok = true;
  while (done < n) {
    const std::size_t ci = pos >> kChunkShift;
    if (ci >= capacity_) {
      ok = false;
      break;
    }
    float* chunk = chunks_[ci].load(std::memory_order_relaxed);
    if (chunk == nullptr) {
      owned_.emplace_back(nch * kChunk, 0.0F);
      chunk = owned_.back().data();
      chunks_[ci].store(chunk, std::memory_order_relaxed);
    }
    const std::size_t off = pos & (kChunk - 1);
    const std::size_t take = std::min(n - done, kChunk - off);
    for (std::size_t c = 0; c < nch; ++c) std::copy_n(planes[c] + done, take, chunk + c * kChunk + off);
    pos += take;
    done += take;
  }
  {
    std::vector<const float*> p(nch);
    for (std::size_t c = 0; c < nch; ++c) p[c] = planes[c];
    const std::scoped_lock lock(peakMu_);
    peaks_.append(p.data(), done);
  }
  {
    const std::scoped_lock lock(mu_);
    ready_.store(static_cast<std::int64_t>(pos), std::memory_order_release);
  }
  cv_.notify_all();
  return ok;
}

void SourceData::finish() {
  {
    const std::scoped_lock lock(peakMu_);
    peaks_.finish();
  }
  {
    const std::scoped_lock lock(mu_);
    complete_.store(true, std::memory_order_release);
  }
  cv_.notify_all();
}

void SourceData::fail(std::string message) {
  {
    const std::scoped_lock lock(mu_);
    error_ = std::move(message);
    failed_.store(true, std::memory_order_release);
    complete_.store(true, std::memory_order_release);
  }
  cv_.notify_all();
}

std::string SourceData::error() const {
  const std::scoped_lock lock(mu_);
  return error_;
}

bool SourceData::wait_for(std::int64_t frames) const {
  std::unique_lock<std::mutex> lock(mu_);
  cv_.wait(lock, [&] {
    return complete_.load(std::memory_order_acquire) || ready_.load(std::memory_order_acquire) >= frames;
  });
  return ready_.load(std::memory_order_acquire) >= frames;
}

void SourceData::read(int ch, std::int64_t from, float* out, std::size_t n) const noexcept {
  for (std::size_t i = 0; i < n; ++i) out[i] = at(ch, from + static_cast<std::int64_t>(i));
}

std::size_t SourceData::bytes() const noexcept {
  const auto chunks = (static_cast<std::size_t>(ready_.load(std::memory_order_acquire)) + kChunk - 1) / kChunk;
  return chunks * kChunk * static_cast<std::size_t>(channels_) * sizeof(float);
}

}  // namespace premation::audio
