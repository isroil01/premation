#include "audio_analysis.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <limits>
#include <numbers>
#include <string>

#include "jsmath.hpp"
#include "numconv.hpp"

namespace premation::jobs::audio_analysis {

namespace {

constexpr double kPi = std::numbers::pi;

double hypot2(double a, double b) {
  const std::array<double, 2> v{a, b};
  return motion::js::hypot(v);
}

double clamp01(double v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/// `Number(x.toFixed(d))`.
double fixed(double x, int d) { return std::strtod(motion::js::to_fixed(x, d).c_str(), nullptr); }

/// silenceRemoval.ts windowDb.
double window_db(std::span<const float> samples, std::size_t from, std::size_t to) {
  double sum = 0;
  const double n = static_cast<double>(std::max<std::size_t>(1, to - from));
  for (std::size_t i = from; i < to; ++i) {
    const double v = i < samples.size() ? samples[i] : 0.0;
    sum += v * v;
  }
  return 20 * motion::js::log10(std::sqrt(sum / n) + 1e-9);
}

}  // namespace

// ── silences ────────────────────────────────────────────────────────────────

std::vector<SilenceRange> detect_silences(std::span<const float> samples, double sampleRate, const SilenceOptions& opts) {
  std::vector<SilenceRange> out;
  if (sampleRate <= 0 || samples.empty()) return out;
  const double thresholdDb = opts.thresholdDb;
  const double minSilenceMs = std::max(0.0, opts.minSilenceMs);
  const double paddingMs = std::max(0.0, opts.paddingMs);
  const double windowMs = std::max(1.0, opts.windowMs);
  const auto hop = static_cast<std::size_t>(std::max(1.0, motion::js::round((windowMs / 1000) * sampleRate)));
  const std::size_t windows = (samples.size() + hop - 1) / hop;
  const double minSec = minSilenceMs / 1000;
  const double padSec = paddingMs / 1000;
  const double totalSec = static_cast<double>(samples.size()) / sampleRate;
  std::int64_t runStart = -1;
  const auto closeRun = [&](std::size_t endWindow) {
    if (runStart < 0) return;
    const double startSec = static_cast<double>(static_cast<std::size_t>(runStart) * hop) / sampleRate;
    const double endSec = std::min(totalSec, static_cast<double>(endWindow * hop) / sampleRate);
    runStart = -1;
    if (endSec - startSec < minSec) return;
    const double a = startSec + padSec;
    const double b = endSec - padSec;
    if (b - a <= 0) return;
    out.push_back(SilenceRange{a, b});
  };
  for (std::size_t w = 0; w < windows; ++w) {
    const std::size_t from = w * hop;
    const bool quiet = window_db(samples, from, std::min(samples.size(), from + hop)) <= thresholdDb;
    if (quiet) {
      if (runStart < 0) runStart = static_cast<std::int64_t>(w);
      continue;
    }
    closeRun(w);
  }
  closeRun(windows);
  return out;
}

std::vector<CompInterval> ranges_to_comp_intervals(std::span<const ClipTiming> timings, std::span<const SilenceRange> ranges) {
  std::vector<CompInterval> out;
  for (const ClipTiming& t : timings) {
    const double barLen = std::max(0.0, t.outSec - t.inSec);
    if (barLen <= 0) continue;
    for (const SilenceRange& r : ranges) {
      const double from = std::max(r.startSec, t.inSec);
      const double to = std::min(r.endSec, t.outSec);
      if (to <= from) continue;
      out.push_back(CompInterval{t.startSec + (from - t.inSec), t.startSec + (to - t.inSec)});
    }
  }
  return merge_intervals(std::move(out));
}

std::vector<CompInterval> merge_intervals(std::vector<CompInterval> intervals) {
  std::vector<CompInterval> sorted;
  for (const CompInterval& i : intervals) {
    if (i.end > i.start) sorted.push_back(i);
  }
  std::stable_sort(sorted.begin(), sorted.end(), [](const CompInterval& a, const CompInterval& b) { return a.start < b.start; });
  std::vector<CompInterval> out;
  for (const CompInterval& iv : sorted) {
    if (!out.empty() && iv.start <= out.back().end + 1e-9) {
      if (iv.end > out.back().end) out.back().end = iv.end;
      continue;
    }
    out.push_back(iv);
  }
  return out;
}

// ── amplitude envelope ─────────────────────────────────────────────────────

std::vector<double> amplitude_envelope(const std::vector<std::vector<float>>& channels, double sampleRate, double fps,
                                       Channel channel) {
  const std::size_t length = channels.empty() ? 0 : channels.front().size();
  if (fps <= 0 || length == 0 || sampleRate <= 0) return {};
  const double duration = static_cast<double>(length) / sampleRate;
  const auto frames = static_cast<std::size_t>(std::max(1.0, std::ceil(duration * fps)));
  const auto spf = static_cast<std::size_t>(std::max(1.0, std::floor(sampleRate / fps)));
  std::vector<const std::vector<float>*> use;
  if (channels.size() <= 1 || channel == Channel::left) {
    use.push_back(&channels.front());
  } else if (channel == Channel::right) {
    use.push_back(&channels[std::min<std::size_t>(1, channels.size() - 1)]);
  } else {
    for (const auto& c : channels) use.push_back(&c);
  }
  std::vector<double> raw(frames, 0.0);
  for (std::size_t f = 0; f < frames; ++f) {
    const std::size_t start = f * spf;
    const std::size_t end = std::min(length, start + spf);
    double sum = 0;
    double n = 0;
    for (const auto* ch : use) {
      for (std::size_t i = start; i < end; ++i) {
        const double v = (*ch)[i];
        sum += v * v;
        n += 1;
      }
    }
    raw[f] = n > 0 ? std::sqrt(sum / n) : 0;
  }
  double peak = 0;
  for (const double v : raw) {
    if (v > peak) peak = v;
  }
  std::vector<double> out(raw.size(), 0.0);
  if (peak <= 0) return out;
  for (std::size_t i = 0; i < raw.size(); ++i) out[i] = motion::js::round((raw[i] / peak) * 1000) / 10;
  return out;
}

std::vector<PlannedKey> thin_envelope(std::span<const double> env, double minDelta) {
  std::vector<PlannedKey> out;
  if (env.empty()) return out;
  out.push_back(PlannedKey{0, env[0]});
  double last = env[0];
  for (std::size_t f = 1; f + 1 < env.size(); ++f) {
    if (std::abs(env[f] - last) >= minDelta) {
      out.push_back(PlannedKey{static_cast<std::int64_t>(f), env[f]});
      last = env[f];
    }
  }
  if (env.size() > 1) out.push_back(PlannedKey{static_cast<std::int64_t>(env.size() - 1), env.back()});
  return out;
}

std::vector<double> smooth_envelope(std::span<const double> env, double window) {
  const auto w = static_cast<std::int64_t>(std::max(1.0, std::floor(window)));
  if (w <= 1 || env.empty()) return {env.begin(), env.end()};
  const std::int64_t half = w / 2;
  const auto len = static_cast<std::int64_t>(env.size());
  std::vector<double> out(env.size(), 0.0);
  double sum = 0;
  std::int64_t lo = 0;
  std::int64_t hi = -1;
  for (std::int64_t i = 0; i < len; ++i) {
    const std::int64_t wantLo = std::max<std::int64_t>(0, i - half);
    const std::int64_t wantHi = std::min(len - 1, i + half);
    while (hi < wantHi) sum += env[static_cast<std::size_t>(++hi)];
    while (lo < wantLo) sum -= env[static_cast<std::size_t>(lo++)];
    out[static_cast<std::size_t>(i)] = sum / static_cast<double>(hi - lo + 1);
  }
  return out;
}

std::vector<PlannedKey> plan_audio_keyframes(std::span<const double> env, const KeyframeOptions& opts) {
  if (env.empty()) return {};
  std::vector<double> scaled = smooth_envelope(env, opts.smoothing);
  const double gain = std::isfinite(opts.gain) ? opts.gain : 1;
  if (gain != 1) {
    for (double& v : scaled) v = std::min(100.0, std::max(0.0, v * gain));
  }
  const auto step = static_cast<std::size_t>(std::max(1.0, std::floor(opts.frameStep)));
  std::vector<std::int64_t> sampledFrames;
  std::vector<double> sampled;
  for (std::size_t f = 0; f < scaled.size(); f += step) {
    sampledFrames.push_back(static_cast<std::int64_t>(f));
    sampled.push_back(scaled[f]);
  }
  const auto lastFrame = static_cast<std::int64_t>(scaled.size()) - 1;
  if (lastFrame >= 0 && sampledFrames.back() != lastFrame) {
    sampledFrames.push_back(lastFrame);
    sampled.push_back(scaled.back());
  }
  std::vector<PlannedKey> out;
  for (const PlannedKey& k : thin_envelope(sampled, std::max(0.0, opts.minDelta))) {
    out.push_back(PlannedKey{sampledFrames[static_cast<std::size_t>(k.frame)], motion::js::round(k.value * 10) / 10});
  }
  return out;
}

// ── beat grid ──────────────────────────────────────────────────────────────

void fft_in_place(std::span<float> re, std::span<float> im) {
  const std::size_t n = re.size();
  if (n <= 1) return;
  for (std::size_t i = 1, j = 0; i < n; ++i) {
    std::size_t bit = n >> 1U;
    for (; (j & bit) != 0; bit >>= 1U) j ^= bit;
    j ^= bit;
    if (i < j) {
      std::swap(re[i], re[j]);
      std::swap(im[i], im[j]);
    }
  }
  for (std::size_t len = 2; len <= n; len <<= 1U) {
    const double ang = (-2 * kPi) / static_cast<double>(len);
    const double wr = motion::js::cos(ang);
    const double wi = motion::js::sin(ang);
    const std::size_t halfLen = len / 2;
    for (std::size_t i = 0; i < n; i += len) {
      double cr = 1;
      double ci = 0;
      for (std::size_t k = 0; k < halfLen; ++k) {
        const double ar = re[i + k];
        const double ai = im[i + k];
        const double br = re[i + k + halfLen];
        const double bi = im[i + k + halfLen];
        const double tr = br * cr - bi * ci;
        const double ti = br * ci + bi * cr;
        re[i + k] = static_cast<float>(ar + tr);
        im[i + k] = static_cast<float>(ai + ti);
        re[i + k + halfLen] = static_cast<float>(ar - tr);
        im[i + k + halfLen] = static_cast<float>(ai - ti);
        const double ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

namespace {

std::vector<float> downmix(const std::vector<std::vector<float>>& channels) {
  if (channels.size() == 1) return channels.front();
  const std::size_t n = channels.empty() ? 0 : channels.front().size();
  std::vector<float> out(n, 0.0F);
  for (const auto& ch : channels) {
    for (std::size_t i = 0; i < n; ++i) {
      out[i] = static_cast<float>(static_cast<double>(out[i]) + (i < ch.size() ? static_cast<double>(ch[i]) : 0.0));
    }
  }
  const double scale = 1.0 / static_cast<double>(channels.size());
  for (float& v : out) v = static_cast<float>(static_cast<double>(v) * scale);
  return out;
}

std::vector<float> onset_envelope(const std::vector<float>& mono, std::size_t hop, std::size_t frame) {
  const std::size_t bins = frame / 2;
  const std::size_t frames = mono.size() >= frame ? (mono.size() - frame) / hop + 1 : 0;
  std::vector<float> envelope(frames, 0.0F);
  std::vector<float> win(frame);
  for (std::size_t i = 0; i < frame; ++i) {
    win[i] = static_cast<float>(0.5 - 0.5 * motion::js::cos((2 * kPi * static_cast<double>(i)) / static_cast<double>(frame - 1)));
  }
  std::vector<float> re(frame);
  std::vector<float> im(frame);
  std::vector<float> prev(bins, 0.0F);
  std::vector<float> mag(bins, 0.0F);
  for (std::size_t f = 0; f < frames; ++f) {
    const std::size_t start = f * hop;
    for (std::size_t i = 0; i < frame; ++i) {
      const double s = start + i < mono.size() ? static_cast<double>(mono[start + i]) : 0.0;
      re[i] = static_cast<float>(s * static_cast<double>(win[i]));
      im[i] = 0;
    }
    fft_in_place(re, im);
    double flux = 0;
    for (std::size_t b = 0; b < bins; ++b) {
      const double m = hypot2(re[b], im[b]);
      mag[b] = static_cast<float>(m);
      const double d = m - static_cast<double>(prev[b]);
      if (d > 0) flux += d;
    }
    envelope[f] = static_cast<float>(flux);
    prev.swap(mag);
  }
  return envelope;
}

double median(const std::vector<float>& values, std::int64_t from, std::int64_t to) {
  const std::int64_t lo = std::max<std::int64_t>(0, from);
  const std::int64_t hi = std::min<std::int64_t>(static_cast<std::int64_t>(values.size()), to);
  if (hi <= lo) return 0;
  std::vector<double> slice(values.begin() + lo, values.begin() + hi);
  std::sort(slice.begin(), slice.end());
  const std::size_t mid = slice.size() >> 1U;
  return (slice.size() % 2) != 0 ? slice[mid] : (slice[mid - 1] + slice[mid]) / 2;
}

std::vector<double> pick_onsets(const std::vector<float>& envelope, double hz, double sensitivity) {
  const auto half = static_cast<std::int64_t>(std::max(2.0, motion::js::round(hz * 0.4)));
  double peak = 0;
  for (const float v : envelope) {
    if (v > peak) peak = v;
  }
  const double floor = peak * 0.005;
  const auto minGapFrames = static_cast<double>(std::max(1.0, motion::js::round(hz * 0.05)));
  std::vector<double> out;
  double last = -std::numeric_limits<double>::infinity();
  for (std::size_t i = 1; i + 1 < envelope.size(); ++i) {
    const double v = envelope[i];
    if (v <= envelope[i - 1] || v < envelope[i + 1]) continue;
    const auto ii = static_cast<std::int64_t>(i);
    const double thresh = median(envelope, ii - half, ii + half) * sensitivity;
    if (v < thresh || v <= 0 || v < floor) continue;
    if (static_cast<double>(i) - last < minGapFrames) continue;
    out.push_back(static_cast<double>(i) / hz);
    last = static_cast<double>(i);
  }
  return out;
}

struct Tempo {
  double bpm = 0;
  double confidence = 0;
  std::int64_t lagFrames = 0;
};

Tempo estimate_tempo(const std::vector<float>& envelope, double hz, double minBpm, double maxBpm) {
  const auto len = static_cast<std::int64_t>(envelope.size());
  const auto minLag = static_cast<std::int64_t>(std::max(1.0, std::floor((60 / maxBpm) * hz)));
  const std::int64_t maxLag = std::min(len - 1, static_cast<std::int64_t>(std::ceil((60 / minBpm) * hz)));
  if (maxLag <= minLag) return {};
  double mean = 0;
  for (const float v : envelope) mean += v;
  mean /= static_cast<double>(std::max<std::int64_t>(1, len));
  double variance = 0;
  for (const float v : envelope) {
    const double d = v - mean;
    variance += d * d;
  }
  variance /= static_cast<double>(std::max<std::int64_t>(1, len));
  const double relative = mean > 0 ? std::sqrt(variance) / mean : 0;
  if (variance <= 0 || relative < 0.25) return {};
  std::vector<double> scores;
  std::int64_t bestLag = 0;
  double bestScore = -std::numeric_limits<double>::infinity();
  for (std::int64_t lag = minLag; lag <= maxLag; ++lag) {
    double sum = 0;
    const std::int64_t n = len - lag;
    for (std::int64_t i = 0; i < n; ++i) {
      sum += (envelope[static_cast<std::size_t>(i)] - mean) * (envelope[static_cast<std::size_t>(i + lag)] - mean);
    }
    const double score = sum / static_cast<double>(std::max<std::int64_t>(1, n));
    scores.push_back(score);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  double total = 0;
  for (const double s : scores) total += s;
  const double avg = total / static_cast<double>(std::max<std::size_t>(1, scores.size()));
  const double hiS = *std::max_element(scores.begin(), scores.end());
  const double loS = *std::min_element(scores.begin(), scores.end());
  const double spread = hiS - loS;
  const double prominence = spread > 0 ? std::max(0.0, std::min(1.0, (bestScore - avg) / spread)) : 0;
  const double strength = std::max(0.0, std::min(1.0, bestScore / variance));
  const double confidence = prominence * strength;
  const double bpm = bestLag > 0 ? (60 * hz) / static_cast<double>(bestLag) : 0;
  return Tempo{fixed(bpm, 2), fixed(confidence, 3), bestLag};
}

std::int64_t estimate_phase(const std::vector<float>& envelope, std::int64_t lag) {
  if (lag <= 0) return 0;
  std::int64_t bestOffset = 0;
  double bestSum = -std::numeric_limits<double>::infinity();
  for (std::int64_t offset = 0; offset < lag; ++offset) {
    double sum = 0;
    for (auto i = static_cast<std::size_t>(offset); i < envelope.size(); i += static_cast<std::size_t>(lag)) sum += envelope[i];
    if (sum > bestSum) {
      bestSum = sum;
      bestOffset = offset;
    }
  }
  return bestOffset;
}

}  // namespace

BeatAnalysis analyse_beats(const std::vector<std::vector<float>>& channels, double sampleRate) {
  constexpr std::size_t kHop = 512;
  constexpr std::size_t kFrame = 1024;
  constexpr double kMinBpm = 60;
  constexpr double kMaxBpm = 190;
  constexpr double kSensitivity = 2.2;
  BeatAnalysis a;
  if (channels.empty()) return a;
  const std::vector<float> mono = downmix(channels);
  a.durationSec = sampleRate > 0 ? static_cast<double>(mono.size()) / sampleRate : 0;
  if (mono.size() < kFrame * 2 || sampleRate <= 0) return a;
  const std::vector<float> envelope = onset_envelope(mono, kHop, kFrame);
  const double hz = sampleRate / static_cast<double>(kHop);
  a.onsets = pick_onsets(envelope, hz, kSensitivity);
  const Tempo tempo = estimate_tempo(envelope, hz, kMinBpm, kMaxBpm);
  if (tempo.lagFrames > 0 && tempo.bpm > 0) {
    const std::int64_t phase = estimate_phase(envelope, tempo.lagFrames);
    for (std::int64_t f = phase; f < static_cast<std::int64_t>(envelope.size()); f += tempo.lagFrames) {
      a.beats.push_back(static_cast<double>(f) / hz);
    }
  }
  a.bpm = tempo.bpm;
  a.tempoConfidence = tempo.confidence;
  return a;
}

// ── the detector ───────────────────────────────────────────────────────────

std::vector<float> align_samples_to_range(std::span<const float> channel, double sampleRate, std::span<const ClipTiming> timings,
                                          double startSec, double endSec) {
  const auto length = static_cast<std::size_t>(std::max(0.0, std::ceil((endSec - startSec) * sampleRate)));
  std::vector<float> out(length, 0.0F);
  if (length == 0) return out;
  std::vector<ClipTiming> spans(timings.begin(), timings.end());
  if (spans.empty()) spans.push_back(ClipTiming{0, 0, static_cast<double>(channel.size()) / sampleRate});
  for (const ClipTiming& t : spans) {
    const double barLen = std::max(0.0, t.outSec - t.inSec);
    if (barLen <= 0) continue;
    const double from = std::max(startSec, t.startSec);
    const double to = std::min(endSec, t.startSec + barLen);
    if (to <= from) continue;
    const auto first = static_cast<std::int64_t>(std::floor((from - startSec) * sampleRate));
    const auto count = static_cast<std::int64_t>(std::ceil((to - from) * sampleRate));
    const double srcBase = (t.inSec + (from - t.startSec)) * sampleRate;
    for (std::int64_t i = 0; i < count; ++i) {
      const std::int64_t di = first + i;
      if (di < 0 || di >= static_cast<std::int64_t>(length)) continue;
      const auto si = static_cast<std::int64_t>(motion::js::round(srcBase + static_cast<double>(i)));
      if (si < 0 || si >= static_cast<std::int64_t>(channel.size())) continue;
      out[static_cast<std::size_t>(di)] = channel[static_cast<std::size_t>(si)];
    }
  }
  return out;
}

std::vector<float> raw_detector_envelope(std::span<const float> samples, double sampleRate, double fps) {
  return detector_envelope(samples, sampleRate, fps, DetectorOptions{});
}

namespace {
/// audioDriver.ts poleCoeff: `1 - exp(-1/(τ·fps))`, 1 for a zero time constant.
double pole_coeff(double ms, double fps) {
  if (!std::isfinite(ms) || ms <= 0 || fps <= 0) return 1;
  const double frames = (ms / 1000) * fps;
  if (frames <= 0) return 1;
  return 1 - motion::js::exp(-1 / frames);
}
}  // namespace

std::vector<float> detector_envelope(std::span<const float> samples, double sampleRate, double fps, const DetectorOptions& o) {
  if (fps <= 0 || sampleRate <= 0 || samples.empty()) return {};
  constexpr std::size_t n = 1024;  // DRIVER_FFT_SIZE
  const double spf = std::max(1.0, sampleRate / fps);
  const auto frames = static_cast<std::size_t>(std::max(1.0, std::ceil(static_cast<double>(samples.size()) / spf)));
  std::vector<float> hann(n);
  for (std::size_t i = 0; i < n; ++i) {
    hann[i] = static_cast<float>(0.5 * (1 - motion::js::cos((2 * kPi * static_cast<double>(i)) / static_cast<double>(n - 1))));
  }
  std::vector<float> re(n);
  std::vector<float> im(n);
  std::vector<float> out(frames, 0.0F);
  // bandRange + windowBandAmplitude's bins (DC never included).
  const double lo = std::max(0.0, std::isfinite(o.lo) ? o.lo : 0.0);
  const double hi = std::max(lo + 1, std::isfinite(o.hi) ? o.hi : lo + 1);
  const double nyquist = sampleRate / 2;
  const double bins = static_cast<double>(n / 2);
  const double f0 = std::max(0.0, std::min(nyquist, lo));
  const double f1 = std::max(f0, std::min(nyquist, hi));
  const auto i0 = static_cast<std::size_t>(std::max(1.0, std::min(bins - 1, std::floor((f0 / nyquist) * bins))));
  const auto i1 = static_cast<std::size_t>(std::max(static_cast<double>(i0 + 1), std::min(bins, std::ceil((f1 / nyquist) * bins))));
  const double gate = clamp01(std::isfinite(o.gate) ? o.gate : 0);
  const double aA = pole_coeff(o.attackMs, fps);
  const double aR = pole_coeff(o.releaseMs, fps);
  double y = 0;
  for (std::size_t f = 0; f < frames; ++f) {
    const auto start = static_cast<std::size_t>(std::floor(static_cast<double>(f) * spf));
    const std::size_t take = start < samples.size() ? std::min(n, samples.size() - start) : 0;
    for (std::size_t i = 0; i < take; ++i) {
      re[i] = static_cast<float>(static_cast<double>(samples[start + i]) * static_cast<double>(hann[i]));
    }
    for (std::size_t i = take; i < n; ++i) re[i] = 0;
    std::fill(im.begin(), im.end(), 0.0F);
    fft_in_place(re, im);
    double power = 0;
    for (std::size_t i = i0; i < i1; ++i) {
      const double mag = hypot2(re[i], im[i]);
      const double amp = (4 * mag) / static_cast<double>(n);
      power += amp * amp;
    }
    const double amp = std::sqrt(power);
    const double db = 20 * motion::js::log10(amp + 1e-6);
    double x = clamp01((db + 60) / 60);
    if (gate > 0 && x < gate) x = 0;
    y = y + (x - y) * (x > y ? aA : aR);
    out[f] = static_cast<float>(clamp01(y));
  }
  if (o.normalize) {
    double peak = 0;
    for (const float v : out) peak = std::max(peak, static_cast<double>(v));
    if (peak > 0) {
      for (float& v : out) v = static_cast<float>(clamp01(static_cast<double>(v) / peak));
    }
  }
  return out;
}

// ── ducking / gate ─────────────────────────────────────────────────────────

double env_to_db(double x) noexcept { return (x <= 0 ? 0 : x > 1 ? 1 : x) * 60 - 60; }

std::vector<float> duck_levels(std::span<const float> sidechain, const DuckingParams& p, double fps) {
  std::vector<float> out(sidechain.size(), 0.0F);
  if (sidechain.empty()) return out;
  const double rate = fps > 0 ? fps : 30;
  const double duckDb = std::min(0.0, p.duckDb);
  const double holdFrames = std::max(0.0, motion::js::round((p.holdMs / 1000) * rate));
  const double attackFrames = std::max(1.0, motion::js::round((p.attackMs / 1000) * rate));
  const double releaseFrames = std::max(1.0, motion::js::round((p.releaseMs / 1000) * rate));
  const double depth = std::abs(duckDb);
  const double attackStep = depth / attackFrames;
  const double releaseStep = depth / releaseFrames;
  double heldFor = holdFrames;
  double gain = 0;
  for (std::size_t f = 0; f < sidechain.size(); ++f) {
    const bool present = env_to_db(sidechain[f]) >= p.thresholdDb;
    if (present) heldFor = 0;
    else heldFor += 1;
    const double target = present || heldFor <= holdFrames ? duckDb : 0;
    if (gain > target) gain = std::max(target, gain - attackStep);
    else if (gain < target) gain = std::min(target, gain + releaseStep);
    out[f] = static_cast<float>(gain);
  }
  return out;
}

std::vector<float> gate_levels(std::span<const float> env, const GateParams& p, double fps) {
  std::vector<float> out(env.size(), 0.0F);
  if (env.empty()) return out;
  const double rate = fps > 0 ? fps : 30;
  const double rangeDb = std::min(0.0, p.rangeDb);
  const double holdFrames = std::max(0.0, motion::js::round((p.holdMs / 1000) * rate));
  const double attackFrames = std::max(1.0, motion::js::round((p.attackMs / 1000) * rate));
  const double releaseFrames = std::max(1.0, motion::js::round((p.releaseMs / 1000) * rate));
  const double depth = std::abs(rangeDb);
  const double openStep = depth / attackFrames;
  const double closeStep = depth / releaseFrames;
  double heldFor = holdFrames + 1;
  double gain = rangeDb;
  for (std::size_t f = 0; f < env.size(); ++f) {
    const bool above = env_to_db(env[f]) >= p.thresholdDb;
    if (above) heldFor = 0;
    else heldFor += 1;
    const double target = above || heldFor <= holdFrames ? 0 : rangeDb;
    if (gain < target) gain = std::min(target, gain + openStep);
    else if (gain > target) gain = std::max(target, gain - closeStep);
    out[f] = static_cast<float>(gain);
  }
  return out;
}

std::vector<std::size_t> thin_levels(std::span<const float> values, double tolDb) {
  const std::size_t n = values.size();
  std::vector<std::size_t> keep;
  if (n == 0) return keep;
  if (n <= 2) {
    for (std::size_t i = 0; i < n; ++i) keep.push_back(i);
    return keep;
  }
  keep.push_back(0);
  for (std::size_t i = 1; i + 1 < n; ++i) {
    const std::size_t k = keep.back();
    const double prev = values[k];
    const double here = values[i];
    const double next = values[i + 1];
    const auto span = static_cast<double>(i + 1 - k);
    const double interpolated = prev + ((next - prev) * static_cast<double>(i - k)) / span;
    if (std::abs(here - interpolated) > tolDb) keep.push_back(i);
  }
  keep.push_back(n - 1);
  return keep;
}

}  // namespace premation::jobs::audio_analysis
