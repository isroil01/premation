#include "dsp_filters.hpp"

#include <algorithm>
#include <cfloat>
#include <cmath>
#include <utility>

namespace premation::audio::dsp {

// ── Biquad (Chromium platform/audio/biquad.cc, the spec's formulas) ─────────

namespace {

BiquadCoefs normalized(double b0, double b1, double b2, double a0, double a1, double a2) noexcept {
  const double inv = 1.0 / a0;
  return {b0 * inv, b1 * inv, b2 * inv, a1 * inv, a2 * inv};
}

BiquadCoefs lowpass(double cutoff, double resonanceDb) noexcept {
  cutoff = std::clamp(cutoff, 0.0, 1.0);
  if (cutoff == 1) return normalized(1, 0, 0, 1, 0, 0);
  if (cutoff > 0) {
    const double g = std::pow(10.0, -0.05 * resonanceDb);
    const double w0 = kPi * cutoff;
    const double cosW0 = std::cos(w0);
    const double alpha = 0.5 * std::sin(w0) * g;
    const double b1 = 1.0 - cosW0;
    const double b0 = 0.5 * b1;
    return normalized(b0, b1, b0, 1.0 + alpha, -2.0 * cosW0, 1.0 - alpha);
  }
  return normalized(0, 0, 0, 1, 0, 0);
}

BiquadCoefs highpass(double cutoff, double resonanceDb) noexcept {
  cutoff = std::clamp(cutoff, 0.0, 1.0);
  if (cutoff == 1) return normalized(0, 0, 0, 1, 0, 0);
  if (cutoff > 0) {
    const double g = std::pow(10.0, -0.05 * resonanceDb);
    const double w0 = kPi * cutoff;
    const double cosW0 = std::cos(w0);
    const double alpha = 0.5 * std::sin(w0) * g;
    const double b1 = -1.0 - cosW0;
    const double b0 = -0.5 * b1;
    return normalized(b0, b1, b0, 1.0 + alpha, -2.0 * cosW0, 1.0 - alpha);
  }
  return normalized(1, 0, 0, 1, 0, 0);
}

BiquadCoefs shelf(bool low, double frequency, double dbGain) noexcept {
  frequency = std::clamp(frequency, 0.0, 1.0);
  const double a = std::pow(10.0, dbGain / 40);
  if (frequency == 1) return low ? normalized(a * a, 0, 0, 1, 0, 0) : normalized(1, 0, 0, 1, 0, 0);
  if (frequency > 0) {
    const double w0 = kPi * frequency;
    const double s = 1;
    const double alpha = 0.5 * std::sin(w0) * std::sqrt((a + 1 / a) * (1 / s - 1) + 2);
    const double k = std::cos(w0);
    const double k2 = 2 * std::sqrt(a) * alpha;
    const double ap = a + 1;
    const double am = a - 1;
    if (low) {
      return normalized(a * (ap - am * k + k2), 2 * a * (am - ap * k), a * (ap - am * k - k2), ap + am * k + k2,
                        -2 * (am + ap * k), ap + am * k - k2);
    }
    return normalized(a * (ap + am * k + k2), -2 * a * (am + ap * k), a * (ap + am * k - k2), ap - am * k + k2,
                      2 * (am - ap * k), ap - am * k - k2);
  }
  return low ? normalized(1, 0, 0, 1, 0, 0) : normalized(a * a, 0, 0, 1, 0, 0);
}

BiquadCoefs peaking(double frequency, double q, double dbGain) noexcept {
  frequency = std::clamp(frequency, 0.0, 1.0);
  q = std::max(0.0, q);
  const double a = std::pow(10.0, dbGain / 40);
  if (frequency > 0 && frequency < 1) {
    if (q > 0) {
      const double w0 = kPi * frequency;
      const double alpha = std::sin(w0) / (2 * q);
      const double k = std::cos(w0);
      return normalized(1 + alpha * a, -2 * k, 1 - alpha * a, 1 + alpha / a, -2 * k, 1 - alpha / a);
    }
    return normalized(a * a, 0, 0, 1, 0, 0);
  }
  return normalized(1, 0, 0, 1, 0, 0);
}

BiquadCoefs bandpass(double frequency, double q) noexcept {
  frequency = std::max(0.0, frequency);
  q = std::max(0.0, q);
  if (frequency > 0 && frequency < 1) {
    if (q > 0) {
      const double w0 = kPi * frequency;
      const double alpha = std::sin(w0) / (2 * q);
      const double k = std::cos(w0);
      return normalized(alpha, 0, -alpha, 1 + alpha, -2 * k, 1 - alpha);
    }
    return normalized(1, 0, 0, 1, 0, 0);
  }
  return normalized(0, 0, 0, 1, 0, 0);
}

BiquadCoefs notch(double frequency, double q) noexcept {
  frequency = std::max(0.0, frequency);
  q = std::max(0.0, q);
  if (frequency > 0 && frequency < 1) {
    if (q > 0) {
      const double w0 = kPi * frequency;
      const double alpha = std::sin(w0) / (2 * q);
      const double k = std::cos(w0);
      return normalized(1, -2 * k, 1, 1 + alpha, -2 * k, 1 - alpha);
    }
    return normalized(0, 0, 0, 1, 0, 0);
  }
  return normalized(1, 0, 0, 1, 0, 0);
}

BiquadCoefs allpass(double frequency, double q) noexcept {
  frequency = std::max(0.0, frequency);
  q = std::max(0.0, q);
  if (frequency > 0 && frequency < 1) {
    if (q > 0) {
      const double w0 = kPi * frequency;
      const double alpha = std::sin(w0) / (2 * q);
      const double k = std::cos(w0);
      return normalized(1 - alpha, -2 * k, 1 + alpha, 1 + alpha, -2 * k, 1 - alpha);
    }
    return normalized(-1, 0, 0, 1, 0, 0);
  }
  return normalized(1, 0, 0, 1, 0, 0);
}

}  // namespace

BiquadCoefs biquad_coefs(BiquadType type, double sampleRate, double frequency, double q, double gainDb,
                         double detuneCents) noexcept {
  const double nyquist = sampleRate / 2;
  // The AudioParam's nominal range [0, nyquist] clamps the value itself.
  const double f = std::clamp(std::isfinite(frequency) ? frequency : 0.0, 0.0, nyquist);
  double nf = f / nyquist;
  if (detuneCents != 0 && std::isfinite(detuneCents)) nf *= std::exp2(detuneCents / 1200);
  if (!std::isfinite(q)) q = 0;
  if (!std::isfinite(gainDb)) gainDb = 0;
  switch (type) {
    case BiquadType::lowpass:
      return lowpass(nf, q);
    case BiquadType::highpass:
      return highpass(nf, q);
    case BiquadType::bandpass:
      return bandpass(nf, q);
    case BiquadType::lowshelf:
      return shelf(true, nf, gainDb);
    case BiquadType::highshelf:
      return shelf(false, nf, gainDb);
    case BiquadType::peaking:
      return peaking(nf, q, gainDb);
    case BiquadType::notch:
      return notch(nf, q);
    case BiquadType::allpass:
      return allpass(nf, q);
  }
  return {};
}

float biquad_tick(const BiquadCoefs& c, BiquadState& s, float in) noexcept {
  const double x = in;
  // Chromium keeps the output state at float precision (`float y = …`).
  const auto y = static_cast<float>(c.b0 * x + c.b1 * s.x1 + c.b2 * s.x2 - c.a1 * s.y1 - c.a2 * s.y2);
  s.x2 = s.x1;
  s.x1 = x;
  s.y2 = s.y1;
  s.y1 = y;
  return y;
}

void biquad_run(const BiquadCoefs& c, BiquadState& s, const float* in, float* out, std::size_t n) noexcept {
  for (std::size_t i = 0; i < n; ++i) out[i] = biquad_tick(c, s, in[i]);
  // Chromium: no stream of subnormals once the input is silent.
  if (s.x1 == 0 && s.x2 == 0 && (s.y1 != 0 || s.y2 != 0) && std::fabs(s.y1) < FLT_MIN && std::fabs(s.y2) < FLT_MIN) {
    s.y1 = s.y2 = 0;
    for (std::size_t i = n; i-- > 0;) {
      if (std::fabs(out[i]) < FLT_MIN) {
        out[i] = 0;
      } else {
        break;
      }
    }
  }
}

// ── DelayLine ───────────────────────────────────────────────────────────────

DelayLine::DelayLine(double maxDelaySec, double sampleRate)
    : maxFrames_(std::max(0.0, maxDelaySec) * sampleRate) {
  buf_.assign(static_cast<std::size_t>(std::ceil(maxFrames_)) + 2 + kQuantum, 0.0F);
}

float DelayLine::read(double delayFrames) const noexcept {
  const std::size_t len = buf_.size();
  const double d = std::clamp(delayFrames, 0.0, maxFrames_);
  double pos = static_cast<double>(write_) + static_cast<double>(len) - d;
  if (pos >= static_cast<double>(len)) pos -= static_cast<double>(len);
  auto i1 = static_cast<std::size_t>(pos);
  if (i1 >= len) i1 = len - 1;
  const std::size_t i2 = (i1 + 1) % len;
  const double f = pos - static_cast<double>(i1);
  return static_cast<float>((1.0 - f) * static_cast<double>(buf_[i1]) + f * static_cast<double>(buf_[i2]));
}

void DelayLine::write(float in) noexcept {
  buf_[write_] = in;
  write_ = (write_ + 1) % buf_.size();
}

void DelayLine::clear() noexcept {
  std::ranges::fill(buf_, 0.0F);
  write_ = 0;
}

float DelayLine::process(float in, double delayFrames) noexcept {
  // Chromium writes the input first, so a zero delay is a wire.
  const std::size_t len = buf_.size();
  const std::size_t w = write_;
  buf_[w] = in;
  write_ = (w + 1) % len;
  const double d = std::clamp(delayFrames, 0.0, maxFrames_);
  double pos = static_cast<double>(w) + static_cast<double>(len) - d;
  if (pos >= static_cast<double>(len)) pos -= static_cast<double>(len);
  auto i1 = static_cast<std::size_t>(pos);
  if (i1 >= len) i1 = len - 1;
  const std::size_t i2 = (i1 + 1) % len;
  const double f = pos - static_cast<double>(i1);
  return static_cast<float>((1.0 - f) * static_cast<double>(buf_[i1]) + f * static_cast<double>(buf_[i2]));
}

// ── Up / down samplers (Chromium platform/audio/up_sampler.cc, down_sampler.cc) ─

namespace {

constexpr std::size_t kKernel = 128;  // Chromium kDefaultKernelSize

// Blackman window parameters (both samplers).
constexpr double kAlpha = 0.16;
constexpr double kA0 = 0.5 * (1.0 - kAlpha);
constexpr double kA1 = 0.5;
constexpr double kA2 = 0.5 * kAlpha;

}  // namespace

UpSampler2x::UpSampler2x(std::size_t maxBlock) : kernel_(kKernel), hist_(kKernel - 1, 0.0F), maxBlock_(maxBlock) {
  const auto n = static_cast<double>(kKernel);
  const double half = n / 2;
  const double sub = -0.5;
  for (std::size_t i = 0; i < kKernel; ++i) {
    const double s = kPi * (static_cast<double>(i) - half - sub);
    const double sinc = s == 0 ? 1.0 : std::sin(s) / s;
    const double x = (static_cast<double>(i) - sub) / n;
    const double window = kA0 - kA1 * std::cos(2 * kPi * x) + kA2 * std::cos(2 * kPi * 2.0 * x);
    kernel_[i] = static_cast<double>(static_cast<float>(sinc * window));
  }
  scratch_.assign(kKernel - 1 + maxBlock_, 0.0F);
}

void UpSampler2x::reset() noexcept { std::ranges::fill(hist_, 0.0F); }

void UpSampler2x::process(const float* in, float* out, std::size_t n) noexcept {
  // buf = [previous kKernel-1 inputs | this block]; x[i - j] = buf[kKernel-1 + i - j].
  float* buf = scratch_.data();
  std::ranges::copy(hist_, buf);
  std::copy(in, in + n, buf + (kKernel - 1));
  const std::size_t base = kKernel - 1;
  const std::size_t half = kKernel / 2;
  for (std::size_t i = 0; i < n; ++i) {
    out[2 * i] = buf[base + i - half];
    float sum = 0;
    for (std::size_t j = 0; j < kKernel; ++j) sum += buf[base + i - j] * static_cast<float>(kernel_[j]);
    out[2 * i + 1] = sum;
  }
  std::copy(buf + n, buf + n + (kKernel - 1), hist_.begin());
}

DownSampler2x::DownSampler2x(std::size_t maxBlock) : kernel_(kKernel / 2), maxBlock_(maxBlock) {
  const auto n = static_cast<double>(kKernel);
  const double half = n / 2;
  const double scale = 0.5;
  for (std::size_t i = 1; i < kKernel; i += 2) {
    const double s = scale * kPi * (static_cast<double>(i) - half);
    double sinc = s == 0 ? 1.0 : std::sin(s) / s;
    sinc *= scale;
    const double x = static_cast<double>(i) / n;
    const double window = kA0 - kA1 * std::cos(2 * kPi * x) + kA2 * std::cos(2 * kPi * 2.0 * x);
    kernel_[(i - 1) / 2] = static_cast<double>(static_cast<float>(sinc * window));
  }
  // History at the 2× rate: kKernel samples covers both the odd-sample
  // convolution (63 odd samples back) and the centre tap (64 back).
  hist_.assign(2 * kKernel, 0.0F);
  scratch_.assign(2 * kKernel + maxBlock_, 0.0F);
}

void DownSampler2x::reset() noexcept { std::ranges::fill(hist_, 0.0F); }

void DownSampler2x::process(const float* in, float* out, std::size_t n) noexcept {
  const std::size_t h = hist_.size();
  float* buf = scratch_.data();
  std::ranges::copy(hist_, buf);
  std::copy(in, in + n, buf + h);
  const std::size_t m = n / 2;
  const std::size_t taps = kernel_.size();
  const std::size_t half = kKernel / 2;
  for (std::size_t i = 0; i < m; ++i) {
    // odd[k] = x2[2k - 1]; convolve odd with the reduced kernel.
    float sum = 0;
    for (std::size_t j = 0; j < taps; ++j) {
      const std::size_t idx = h + 2 * i - 2 * j - 1;  // x2[2(i-j) - 1]
      sum += buf[idx] * static_cast<float>(kernel_[j]);
    }
    out[i] = static_cast<float>(static_cast<double>(sum) + 0.5 * static_cast<double>(buf[h + 2 * i - half]));
  }
  std::copy(buf + n, buf + n + h, hist_.begin());
}

WaveShaper::WaveShaper(std::vector<float> curve, Oversample os, std::size_t maxBlock)
    : curve_(std::move(curve)), os_(os) {
  if (os_ == Oversample::x2) {
    up_.emplace_back(maxBlock);
    down_.emplace_back(2 * maxBlock);
  } else if (os_ == Oversample::x4) {
    up_.emplace_back(maxBlock);
    up_.emplace_back(2 * maxBlock);
    down_.emplace_back(4 * maxBlock);
    down_.emplace_back(2 * maxBlock);
  }
  a_.assign(4 * maxBlock, 0.0F);
  b_.assign(4 * maxBlock, 0.0F);
  if (os_ != Oversample::none) lag_.assign(os_ == Oversample::x2 ? 32 : 48, 0.0F);
}

void WaveShaper::delay_out(float* out, std::size_t n) noexcept {
  const std::size_t len = lag_.size();
  for (std::size_t i = 0; i < n; ++i) {
    const float v = lag_[lagPos_];
    lag_[lagPos_] = out[i];
    out[i] = v;
    lagPos_ = (lagPos_ + 1) % len;
  }
}

void WaveShaper::reset() noexcept {
  for (auto& u : up_) u.reset();
  for (auto& d : down_) d.reset();
  std::ranges::fill(lag_, 0.0F);
  lagPos_ = 0;
}

void WaveShaper::shape(float* x, std::size_t n) const noexcept {
  const std::size_t len = curve_.size();
  if (len < 2) return;  // no curve: a wire (Chromium passes the input through)
  const auto last = static_cast<double>(len - 1);
  for (std::size_t i = 0; i < n; ++i) {
    const double v = 0.5 * (static_cast<double>(x[i]) + 1) * last;
    double y = 0;
    if (v < 0) {
      y = curve_[0];
    } else if (v >= last) {
      y = curve_[len - 1];
    } else {
      const double fi = std::floor(v);
      const auto i1 = static_cast<std::size_t>(fi);
      const double f = v - fi;
      y = (1 - f) * static_cast<double>(curve_[i1]) + f * static_cast<double>(curve_[i1 + 1]);
    }
    x[i] = static_cast<float>(y);
  }
}

void WaveShaper::process(const float* in, float* out, std::size_t n) noexcept {
  switch (os_) {
    case Oversample::none:
      std::copy(in, in + n, out);
      shape(out, n);
      return;
    case Oversample::x2:
      up_[0].process(in, a_.data(), n);
      shape(a_.data(), 2 * n);
      down_[0].process(a_.data(), out, 2 * n);
      delay_out(out, n);
      return;
    case Oversample::x4:
      up_[0].process(in, a_.data(), n);
      up_[1].process(a_.data(), b_.data(), 2 * n);
      shape(b_.data(), 4 * n);
      down_[0].process(b_.data(), a_.data(), 4 * n);
      down_[1].process(a_.data(), out, 2 * n);
      delay_out(out, n);
      return;

  }
}

}  // namespace premation::audio::dsp
