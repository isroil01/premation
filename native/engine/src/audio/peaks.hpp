// Waveform queries over a source's peak pyramid — the engine-API shape
// (80_queries.eapi `WaveformPeaks`: interleaved min/max per bucket per
// channel + RMS per bucket), answered EXACTLY: bucket edges fall where the
// TS `computePeaks` puts them (floor(b·per) … max(start+1, floor((b+1)·per))),
// the whole pyramid buckets inside a bucket come from the pyramid and only
// the partial edges are read from the samples.
#pragma once

#include <cstdint>
#include <vector>

#include "source_store.hpp"

namespace premation::audio {

struct WaveformPeaksResult {
  /// For bucket b, channel c: peaks[(b·channels + c)·2] = min, [+1] = max.
  std::vector<float> peaks;
  std::uint32_t channels = 0;
  std::uint32_t buckets = 0;
  /// RMS per bucket (of the mono mix when `monoMix`, else of channel 0).
  std::vector<float> rms;
};

/// Peaks of source frames covering [fromSec, fromSec + durationSec) — the
/// SOURCE window a clip bar shows (waveform.ts `peaksInRange`). `monoMix`
/// returns one channel: the mono average the TS envelope is drawn from.
[[nodiscard]] WaveformPeaksResult query_peaks(const SourceData& src, double fromSec, double durationSec,
                                              std::uint32_t buckets, bool monoMix);

/// The TS consumer's envelope (AudioEngine `WaveformPeaks.peaks`): per bucket
/// max(|min|, |max|) of the mono mix, clamped to 1. `r` must be monoMix.
[[nodiscard]] std::vector<float> ts_envelope(const WaveformPeaksResult& r);

}  // namespace premation::audio
