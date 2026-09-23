#include "dsp_dynamics.hpp"

#include <algorithm>
#include <cmath>

namespace premation::audio::dsp {

namespace {

constexpr float kPiOverTwoF = 1.57079632679489661923F;
// Chromium audio_utilities: DecibelsToLinear / LinearToDecibels in float.
float db_to_linear(float db) noexcept { return std::pow(10.0F, 0.05F * db); }
float linear_to_db(float lin) noexcept { return 20 * std::log10(lin); }
float time_constant_k(float tc, double sampleRate) noexcept {
  return static_cast<float>(1 - std::exp(-1 / (sampleRate * static_cast<double>(tc))));
}

// The spec's fixed values (DynamicsCompressor::Process in Chromium).
constexpr float kPreDelaySec = 0.006F;
constexpr float kReleaseZone1 = 0.09F, kReleaseZone2 = 0.16F, kReleaseZone3 = 0.42F, kReleaseZone4 = 0.98F;
constexpr std::size_t kDivision = 32;

}  // namespace

Compressor::Compressor(double sampleRate, std::size_t channels)
    : sampleRate_(sampleRate),
      channels_(channels),
      preDelay_(channels),
      meteringReleaseK_(time_constant_k(0.325F, sampleRate)) {
  for (auto& b : preDelay_) b.fill(0);
}

void Compressor::reset() noexcept {
  for (auto& b : preDelay_) b.fill(0);
  readIdx_ = 0;
  writeIdx_ = 256;
  lastPreDelayFrames_ = 256;
  detectorAverage_ = 0;
  compressorGain_ = 1;
  meteringGain_ = 1;
  maxAttackCompressionDiffDb_ = -1;
}

float Compressor::knee_curve(float x, float k) const noexcept {
  if (x < linearThreshold_) return x;
  return linearThreshold_ + (1 - static_cast<float>(std::exp(static_cast<double>(-k * (x - linearThreshold_))))) / k;
}

float Compressor::saturate(float x, float k) const noexcept {
  if (x < kneeThreshold_) return knee_curve(x, k);
  const float xDb = linear_to_db(x);
  const float yDb = ykneeThresholdDb_ + slope_ * (xDb - kneeThresholdDb_);
  return db_to_linear(yDb);
}

float Compressor::slope_at(float x, float k) const noexcept {
  // Chromium KAtSlope's inner step: db_x is the threshold + knee in dB (not
  // re-derived from x), x2 = x · 1.001 in double.
  if (x < linearThreshold_) return 1;
  const float xDb = dbThreshold_ + dbKnee_;
  const auto x2 = static_cast<float>(static_cast<double>(x) * 1.001);
  const float x2Db = linear_to_db(x2);
  const float yDb = linear_to_db(knee_curve(x, k));
  const float y2Db = linear_to_db(knee_curve(x2, k));
  return (y2Db - yDb) / (x2Db - xDb);
}

float Compressor::k_at_slope(float desiredSlope) const noexcept {
  const float xDb = dbThreshold_ + dbKnee_;
  const float x = db_to_linear(xDb);
  float minK = 0.1F;
  float maxK = 10000;
  float k = 5;
  for (int i = 0; i < 15; ++i) {
    const float slope = slope_at(x, k);

    if (slope < desiredSlope) {
      maxK = k;
    } else {
      minK = k;
    }
    k = std::sqrt(minK * maxK);
  }
  return k;
}

float Compressor::update_static_curve(float dbThreshold, float dbKnee, float ratio) noexcept {
  if (dbThreshold != dbThreshold_ || dbKnee != dbKnee_ || ratio != ratio_) {
    dbThreshold_ = dbThreshold;
    linearThreshold_ = db_to_linear(dbThreshold);
    dbKnee_ = dbKnee;
    ratio_ = ratio;
    slope_ = 1 / ratio_;
    const float k = k_at_slope(1 / ratio_);
    kneeThresholdDb_ = dbThreshold + dbKnee;
    kneeThreshold_ = db_to_linear(kneeThresholdDb_);
    ykneeThresholdDb_ = linear_to_db(knee_curve(kneeThreshold_, k));
    k_ = k;
  }
  return k_;
}

void Compressor::process_division(const float* const* in, float* const* out, std::size_t n,
                                  const CompressorParams& p) noexcept {
  // The AudioParams' nominal ranges.
  const float dbThreshold = std::clamp(p.thresholdDb, -100.0F, 0.0F);
  const float dbKnee = std::clamp(p.kneeDb, 0.0F, 40.0F);
  const float ratio = std::clamp(p.ratio, 1.0F, 20.0F);
  const float attackTime = std::clamp(p.attackSec, 0.0F, 1.0F);
  const float releaseTime = std::clamp(p.releaseSec, 0.0F, 1.0F);
  const auto sr = static_cast<float>(sampleRate_);

  const float k = update_static_curve(dbThreshold, dbKnee, ratio);
  // Makeup gain (Chromium: fdlibm::powf(1 / Saturate(1, k), 0.6f)).
  const float masterLinearGain = std::pow(1 / saturate(1, k), 0.6F);

  const float attackFrames = std::max(0.001F, attackTime) * sr;
  const float releaseFrames = sr * releaseTime;
  const float satReleaseFrames = 0.0025F * sr;

  // The release polynomial: each coefficient is release_frames × a constant
  // folded from the four release zones (Chromium's kABase … kEBase).
  constexpr float kABase = 0.9999999999999998F * kReleaseZone1 + 1.8432219684323923e-16F * kReleaseZone2 -
                           1.9373394351676423e-16F * kReleaseZone3 + 8.824516011816245e-18F * kReleaseZone4;
  constexpr float kBBase = -1.5788320352845888F * kReleaseZone1 + 2.3305837032074286F * kReleaseZone2 -
                           0.9141194204840429F * kReleaseZone3 + 0.1623677525612032F * kReleaseZone4;
  constexpr float kCBase = 0.5334142869106424F * kReleaseZone1 - 1.272736789213631F * kReleaseZone2 +
                           0.9258856042207512F * kReleaseZone3 - 0.18656310191776226F * kReleaseZone4;
  constexpr float kDBase = 0.08783463138207234F * kReleaseZone1 - 0.1694162967925622F * kReleaseZone2 +
                           0.08588057951595272F * kReleaseZone3 - 0.00429891410546283F * kReleaseZone4;
  constexpr float kEBase = -0.042416883008123074F * kReleaseZone1 + 0.1115693827987602F * kReleaseZone2 -
                           0.09764676325265872F * kReleaseZone3 + 0.028494263462021576F * kReleaseZone4;
  const float kA = releaseFrames * kABase;
  const float kB = releaseFrames * kBBase;
  const float kC = releaseFrames * kCBase;
  const float kD = releaseFrames * kDBase;
  const float kE = releaseFrames * kEBase;

  // SetPreDelayTime (fixed 6 ms).
  {
    auto preDelayFrames = static_cast<std::size_t>(kPreDelaySec * sr);
    if (preDelayFrames > kMaxPreDelay - 1) preDelayFrames = kMaxPreDelay - 1;
    if (lastPreDelayFrames_ != preDelayFrames) {
      lastPreDelayFrames_ = preDelayFrames;
      for (auto& b : preDelay_) b.fill(0);
      readIdx_ = 0;
      writeIdx_ = preDelayFrames;
    }
  }

  if (std::isnan(detectorAverage_) || std::isinf(detectorAverage_)) detectorAverage_ = 1;
  const float desiredGain = detectorAverage_;
  const float scaledDesiredGain = std::asin(desiredGain) / kPiOverTwoF;
  float envelopeRate = 0;
  const bool isReleasing = scaledDesiredGain > compressorGain_;
  float compressionDiffDb = 0;
  if (scaledDesiredGain == 0) {
    compressionDiffDb = isReleasing ? -1.0F : 1.0F;
  } else {
    compressionDiffDb = linear_to_db(compressorGain_ / scaledDesiredGain);
  }
  if (isReleasing) {
    maxAttackCompressionDiffDb_ = -1;
    if (std::isnan(compressionDiffDb) || std::isinf(compressionDiffDb)) compressionDiffDb = -1;
    float x = compressionDiffDb;
    x = std::clamp(x, -12.0F, 0.0F);
    x = 0.25F * (x + 12);
    const float x2 = x * x;
    const float x3 = x2 * x;
    const float x4 = x2 * x2;
    const float relFrames = kA + kB * x + kC * x2 + kD * x3 + kE * x4;
    constexpr float kSpacingDb = 5;
    const float dbPerFrame = kSpacingDb / relFrames;
    envelopeRate = db_to_linear(dbPerFrame);
  } else {
    if (std::isnan(compressionDiffDb) || std::isinf(compressionDiffDb)) compressionDiffDb = 1;
    if (maxAttackCompressionDiffDb_ == -1 || maxAttackCompressionDiffDb_ < compressionDiffDb) {
      maxAttackCompressionDiffDb_ = compressionDiffDb;
    }
    const float effAttenDiffDb = std::max(0.5F, maxAttackCompressionDiffDb_);
    const float x = 0.25F / effAttenDiffDb;
    envelopeRate = 1 - std::pow(x, 1 / attackFrames);
  }

  std::size_t readIdx = readIdx_;
  std::size_t writeIdx = writeIdx_;
  float detectorAverage = detectorAverage_;
  float compressorGain = compressorGain_;
  const std::size_t frames = std::min(n, kDivision);
  for (std::size_t i = 0; i < frames; ++i) {
    float compressorInput = 0;
    for (std::size_t c = 0; c < channels_; ++c) {
      const float s = in[c][i];
      preDelay_[c][writeIdx] = s;
      const float a = s > 0 ? s : -s;
      if (compressorInput < a) compressorInput = a;
    }
    const float absInput = compressorInput > 0 ? compressorInput : -compressorInput;
    const float shapedInput = saturate(absInput, k);
    const float attenuation = absInput <= 0.0001F ? 1 : shapedInput / absInput;
    float attenuationDb = -linear_to_db(attenuation);
    attenuationDb = std::max(2.0F, attenuationDb);
    const float dbPerFrame = attenuationDb / satReleaseFrames;
    const float satReleaseRate = db_to_linear(dbPerFrame) - 1;
    const bool isRelease = attenuation > detectorAverage;
    const float rate = isRelease ? satReleaseRate : 1;
    detectorAverage += (attenuation - detectorAverage) * rate;
    detectorAverage = std::min(1.0F, detectorAverage);
    if (std::isnan(detectorAverage) || std::isinf(detectorAverage)) detectorAverage = 1;
    if (envelopeRate < 1) {
      compressorGain += (scaledDesiredGain - compressorGain) * envelopeRate;
    } else {
      compressorGain *= envelopeRate;
      compressorGain = std::min(1.0F, compressorGain);
    }
    const auto postWarp = static_cast<float>(std::sin(static_cast<double>(kPiOverTwoF * compressorGain)));

    const float totalGain = masterLinearGain * postWarp;  // dry 0, wet 1
    const float dbRealGain = 20 * std::log10(postWarp);
    if (dbRealGain < meteringGain_) {
      meteringGain_ = dbRealGain;
    } else {
      meteringGain_ += (dbRealGain - meteringGain_) * meteringReleaseK_;
    }
    for (std::size_t c = 0; c < channels_; ++c) out[c][i] = preDelay_[c][readIdx] * totalGain;
    readIdx = (readIdx + 1) & kMask;
    writeIdx = (writeIdx + 1) & kMask;
  }
  readIdx_ = readIdx;
  writeIdx_ = writeIdx;
  detectorAverage_ = detectorAverage;
  compressorGain_ = compressorGain;
}

// ── Limiter ─────────────────────────────────────────────────────────────────

Limiter::Limiter(double sampleRate, std::size_t channels, double ceilingDb, double releaseMs, std::size_t lookahead)
    : channels_(channels),
      lookahead_(lookahead),
      ceiling_(static_cast<float>(std::pow(10.0, ceilingDb / 20))),
      releaseCoef_(static_cast<float>(1 - std::exp(-1 / (sampleRate * std::max(1.0, releaseMs) / 1000)))),
      delay_(channels, std::vector<float>(lookahead + 1, 0.0F)),
      target_(lookahead + 1, 1.0F),
      mins_(lookahead + 1, 1.0F),
      minSum_(static_cast<double>(lookahead + 1)) {}

void Limiter::reset() noexcept {
  for (auto& d : delay_) std::ranges::fill(d, 0.0F);
  std::ranges::fill(target_, 1.0F);
  std::ranges::fill(mins_, 1.0F);
  minSum_ = static_cast<double>(lookahead_ + 1);
  gain_ = 1;
  pos_ = 0;
}

float Limiter::gain_reduction_db() const noexcept { return gain_ >= 1 ? 0 : 20 * std::log10(gain_); }

void Limiter::process(float* const* io, std::size_t n) noexcept {
  const std::size_t w = lookahead_ + 1;
  for (std::size_t i = 0; i < n; ++i) {
    float peak = 0;
    for (std::size_t c = 0; c < channels_; ++c) peak = std::max(peak, std::fabs(io[c][i]));
    const float t = peak > ceiling_ ? ceiling_ / peak : 1.0F;
    target_[pos_] = t;
    // Sliding minimum of the targets over the window (the look-ahead + now).
    float m = 1;
    for (const float v : target_) m = std::min(m, v);
    minSum_ += static_cast<double>(m) - static_cast<double>(mins_[pos_]);
    mins_[pos_] = m;
    // Boxcar over the window: ramps the gain down across the look-ahead so a
    // peak arrives already attenuated, without a step.
    auto a = static_cast<float>(minSum_ / static_cast<double>(w));
    a = std::min(a, m);  // exactly safe whatever the running sum's rounding
    if (a < gain_) {
      gain_ = a;
    } else {
      gain_ += (a - gain_) * releaseCoef_;
    }
    // Output the sample that entered `lookahead` frames ago.
    const std::size_t readPos = (pos_ + 1) % w;
    for (std::size_t c = 0; c < channels_; ++c) {
      auto& d = delay_[c];
      d[pos_] = io[c][i];
      io[c][i] = d[readPos] * gain_;
    }
    pos_ = readPos;
  }
}

}  // namespace premation::audio::dsp
