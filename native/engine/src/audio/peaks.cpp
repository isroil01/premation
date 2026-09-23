#include "peaks.hpp"

#include <algorithm>
#include <cmath>
#include <utility>

namespace premation::audio {

namespace {

struct Acc {
  float mn = 0, mx = 0;
  double sumSq = 0;
  std::uint64_t n = 0;
  void add(float v) noexcept {
    if (n == 0) {
      mn = mx = v;
    } else {
      mn = std::min(mn, v);
      mx = std::max(mx, v);
    }
    sumSq += static_cast<double>(v) * static_cast<double>(v);
    ++n;
  }
  void add(const PeakPyramid::Bucket& b) noexcept {
    if (b.n == 0) return;
    if (n == 0) {
      mn = b.mn;
      mx = b.mx;
    } else {
      mn = std::min(mn, b.mn);
      mx = std::max(mx, b.mx);
    }
    sumSq += b.sumSq;
    n += b.n;
  }
};

/// Sample `i` of pyramid channel `c` (c == nch → the mono mix, computed as
/// waveform.ts mixToMono: the double sum over channels / count, as float).
float sample(const SourceData& s, int c, std::int64_t i) noexcept {
  const int nch = s.channels();
  if (c < nch) return s.at(c, i);
  double sum = 0;
  for (int k = 0; k < nch; ++k) sum += s.at(k, i);
  return static_cast<float>(sum / nch);
}

}  // namespace

WaveformPeaksResult query_peaks(const SourceData& src, double fromSec, double durationSec, std::uint32_t buckets,
                                bool monoMix) {
  WaveformPeaksResult r;
  const int nch = src.channels();
  const std::vector<int> chans = monoMix ? std::vector<int>{nch} : [&] {
    std::vector<int> v;
    v.reserve(static_cast<std::size_t>(nch));
    for (int c = 0; c < nch; ++c) v.push_back(c);
    return v;
  }();
  r.channels = static_cast<std::uint32_t>(chans.size());
  const std::uint32_t nb = std::max<std::uint32_t>(1, buckets);
  r.buckets = nb;
  r.peaks.assign(static_cast<std::size_t>(nb) * chans.size() * 2, 0.0F);
  r.rms.assign(nb, 0.0F);

  const double sr = src.sample_rate();
  const std::int64_t avail = src.frames_ready();
  const auto from = std::clamp<std::int64_t>(static_cast<std::int64_t>(std::floor(fromSec * sr)), 0, avail);
  const auto to = std::clamp<std::int64_t>(static_cast<std::int64_t>(std::floor((fromSec + durationSec) * sr)), from, avail);
  const std::int64_t len = to - from;
  if (len <= 0) return r;
  const double per = static_cast<double>(len) / nb;

  src.with_peaks([&](const PeakPyramid& pyr) {
    // The coarsest level whose buckets are ≤ per/64 frames: whole pyramid
    // buckets cover a requested bucket, only ~3 % of its frames are read.
    std::size_t level = 0;
    bool usePyramid = per >= static_cast<double>(PeakPyramid::kBase) * 8;
    if (usePyramid) {
      while (level + 1 < pyr.levels() && static_cast<double>(pyr.bucket_frames(level + 1)) * 64 <= per) ++level;
    }
    for (std::uint32_t b = 0; b < nb; ++b) {
      const std::int64_t s = from + static_cast<std::int64_t>(std::floor(b * per));
      const std::int64_t e =
          std::min(to, from + std::max(s - from + 1, static_cast<std::int64_t>(std::floor((b + 1) * per))));
      for (std::size_t k = 0; k < chans.size(); ++k) {
        const int c = chans[k];
        Acc acc;
        if (usePyramid) {
          const auto bf = static_cast<std::int64_t>(pyr.bucket_frames(level));
          const std::int64_t firstFull = (s + bf - 1) / bf;
          const std::int64_t lastFull = e / bf;  // exclusive
          const auto& lv = pyr.level(level, c);
          if (firstFull < lastFull && std::cmp_less_equal(lastFull, lv.size())) {
            for (std::int64_t i = s; i < firstFull * bf; ++i) acc.add(sample(src, c, i));
            for (std::int64_t q = firstFull; q < lastFull; ++q) acc.add(lv[static_cast<std::size_t>(q)]);
            for (std::int64_t i = lastFull * bf; i < e; ++i) acc.add(sample(src, c, i));
          } else {
            for (std::int64_t i = s; i < e; ++i) acc.add(sample(src, c, i));
          }
        } else {
          for (std::int64_t i = s; i < e; ++i) acc.add(sample(src, c, i));
        }
        const std::size_t o = (static_cast<std::size_t>(b) * chans.size() + k) * 2;
        r.peaks[o] = acc.mn;
        r.peaks[o + 1] = acc.mx;
        if (k == 0 && acc.n > 0) r.rms[b] = static_cast<float>(std::sqrt(acc.sumSq / static_cast<double>(acc.n)));
      }
    }
    return 0;
  });
  return r;
}

std::vector<float> ts_envelope(const WaveformPeaksResult& r) {
  std::vector<float> out(r.buckets, 0.0F);
  for (std::uint32_t b = 0; b < r.buckets; ++b) {
    const std::size_t o = static_cast<std::size_t>(b) * r.channels * 2;
    const float p = std::max(std::fabs(r.peaks[o]), std::fabs(r.peaks[o + 1]));
    out[b] = p > 1 ? 1 : p;
  }
  return out;
}

}  // namespace premation::audio
