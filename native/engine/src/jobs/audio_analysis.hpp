// Audio analysis for engine jobs — ports of the page's pure audio maths:
//
//   silences          src/core/audio/silenceRemoval.ts (detectSilences,
//                     rangesToCompIntervals, mergeIntervals)
//   amplitude track   src/core/audio/audioKeyframes.ts (amplitudeEnvelope,
//                     smoothEnvelope, thinEnvelope, planAudioKeyframes)
//   beat grid         packages/audio/src/analyse.ts (spectral flux, adaptive
//                     onsets, autocorrelation tempo, phase)
//   detector          src/core/audio/audioDriver.ts (analyseAudioEnvelope,
//                     alignSamplesToRange)
//   ducking / gate    src/core/audio/ducking.ts (duckLevels, thinLevels),
//                     src/core/audio/audioGate.ts (gateLevels)
//
// The TypeScript is the reference: Float32Array storage is float here, the
// arithmetic between stores is double (JavaScript's), transcendental functions
// are V8's (motion::js — fdlibm), so the same samples give the same numbers.
// Pure: samples in, numbers out; no decode, no document.
#pragma once

#include <cstdint>
#include <span>
#include <vector>

namespace premation::jobs::audio_analysis {

// ── silences ──
struct SilenceRange {
  double startSec = 0;
  double endSec = 0;
};
struct SilenceOptions {
  double thresholdDb = -40;
  double minSilenceMs = 400;
  double paddingMs = 80;
  double windowMs = 10;
};
[[nodiscard]] std::vector<SilenceRange> detect_silences(std::span<const float> samples, double sampleRate,
                                                        const SilenceOptions& opts);
struct ClipTiming {
  double startSec = 0;
  double inSec = 0;
  double outSec = 0;
};
struct CompInterval {
  double start = 0;
  double end = 0;
};
[[nodiscard]] std::vector<CompInterval> ranges_to_comp_intervals(std::span<const ClipTiming> timings,
                                                                 std::span<const SilenceRange> ranges);
[[nodiscard]] std::vector<CompInterval> merge_intervals(std::vector<CompInterval> intervals);

// ── amplitude envelope (Convert Audio to Keyframes) ──
enum class Channel : std::uint8_t { both, left, right };
/// Per-frame RMS normalised to 0–100 against its own peak, 0.1 steps (amplitudeEnvelope).
[[nodiscard]] std::vector<double> amplitude_envelope(const std::vector<std::vector<float>>& channels, double sampleRate,
                                                     double fps, Channel channel);
struct KeyframeOptions {
  double frameStep = 1;
  double minDelta = 2;
  double smoothing = 1;
  double gain = 1;
};
struct PlannedKey {
  std::int64_t frame = 0;
  double value = 0;
};
[[nodiscard]] std::vector<double> smooth_envelope(std::span<const double> env, double window);
[[nodiscard]] std::vector<PlannedKey> thin_envelope(std::span<const double> env, double minDelta);
[[nodiscard]] std::vector<PlannedKey> plan_audio_keyframes(std::span<const double> env, const KeyframeOptions& opts);

// ── beat grid (@motion/audio analyseAudio) ──
struct BeatAnalysis {
  double bpm = 0;
  double tempoConfidence = 0;
  std::vector<double> beats;   ///< seconds from the start of the buffer
  std::vector<double> onsets;
  double durationSec = 0;
};
[[nodiscard]] BeatAnalysis analyse_beats(const std::vector<std::vector<float>>& channels, double sampleRate);
/// The in-place radix-2 FFT of analyse.ts (float storage, double arithmetic).
void fft_in_place(std::span<float> re, std::span<float> im);

// ── the detector (audioDriver.ts) ──
/// `alignSamplesToRange`: the source's samples laid out on composition time over [startSec, endSec).
[[nodiscard]] std::vector<float> align_samples_to_range(std::span<const float> channel, double sampleRate,
                                                        std::span<const ClipTiming> timings, double startSec,
                                                        double endSec);
/// `analyseAudioEnvelope` with band 'full', no attack/release/gate, normalize false: 0..1 on a −60…0 dB scale per frame.
[[nodiscard]] std::vector<float> raw_detector_envelope(std::span<const float> samples, double sampleRate, double fps);
/// audioDriver.ts EnvelopeOptions: the band in Hz, one-pole attack / release (ms), the gate floor (0..1), normalise to the peak.
struct DetectorOptions {
  double lo = 20, hi = 20000;
  double attackMs = 0, releaseMs = 0;
  double gate = 0;
  bool normalize = false;
};
/// `analyseAudioEnvelope`: detector → gate → attack/release → normalise, 0..1 per frame.
[[nodiscard]] std::vector<float> detector_envelope(std::span<const float> samples, double sampleRate, double fps, const DetectorOptions& o);

// ── ducking / gate ──
struct DuckingParams {
  double duckDb = -12;
  double thresholdDb = -30;
  double attackMs = 60;
  double releaseMs = 400;
  double holdMs = 200;
};
struct GateParams {
  double thresholdDb = -60;
  double attackMs = 10;
  double holdMs = 40;
  double releaseMs = 220;
  double rangeDb = -60;
};
[[nodiscard]] double env_to_db(double x) noexcept;
[[nodiscard]] std::vector<float> duck_levels(std::span<const float> sidechain, const DuckingParams& p, double fps);
[[nodiscard]] std::vector<float> gate_levels(std::span<const float> env, const GateParams& p, double fps);
[[nodiscard]] std::vector<std::size_t> thin_levels(std::span<const float> values, double tolDb = 0.05);
/// audioParams.ts MIN_LEVEL_DB.
inline constexpr double kMinLevelDb = -60;

}  // namespace premation::jobs::audio_analysis
