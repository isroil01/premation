#include "dsp_osc.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <numbers>
#include <cmath>
#include <complex>
#include <map>
#include <mutex>
#include <utility>

#include "dsp_fft.hpp"

namespace premation::audio::dsp {

// ── JavaScript integer conversions ──────────────────────────────────────────

std::uint32_t js_to_uint32(double v) noexcept {
  if (!std::isfinite(v)) return 0;
  const double t = std::trunc(v);
  double m = std::fmod(t, 4294967296.0);  // exact
  if (m < 0) m += 4294967296.0;
  return static_cast<std::uint32_t>(m);
}

std::int32_t js_to_int32(double v) noexcept {
  const std::uint32_t u = js_to_uint32(v);
  return static_cast<std::int32_t>(u);  // two's complement reinterpretation (C++20)
}

std::uint32_t hash_id(std::string_view utf8) noexcept {
  // Decode UTF-8 to UTF-16 code units, as `charCodeAt` walks them.
  std::uint32_t h = 2166136261U;
  auto mix = [&h](std::uint32_t unit) noexcept {
    h ^= unit;
    h = h * 16777619U;  // Math.imul: the low 32 bits of the product
  };
  std::size_t i = 0;
  const std::size_t n = utf8.size();
  while (i < n) {
    const auto c = static_cast<unsigned char>(utf8[i]);
    std::uint32_t cp = c;
    std::size_t len = 1;
    if (c >= 0xF0) {
      len = 4;
      cp = c & 0x07U;
    } else if (c >= 0xE0) {
      len = 3;
      cp = c & 0x0FU;
    } else if (c >= 0xC0) {
      len = 2;
      cp = c & 0x1FU;
    }
    if (i + len > n) {
      len = 1;
      cp = c;
    } else {
      for (std::size_t k = 1; k < len; ++k) cp = (cp << 6U) | (static_cast<unsigned char>(utf8[i + k]) & 0x3FU);
    }
    if (cp >= 0x10000) {
      const std::uint32_t v = cp - 0x10000;
      mix(0xD800U + (v >> 10U));
      mix(0xDC00U + (v & 0x3FFU));
    } else {
      mix(cp);
    }
    i += len;
  }
  return h;
}

std::vector<float> noise_buffer(double sampleRate, std::uint32_t seed) {
  // audioEffects.ts noiseBuffer, operation for operation in doubles.
  const auto n = static_cast<std::size_t>(std::max(1.0, std::round(sampleRate)));
  std::vector<float> data(n);
  const auto s = static_cast<double>(seed);
  for (std::size_t i = 0; i < n; ++i) {
    double h = static_cast<double>(i + 1) * 374761393.0 + s * 2246822519.0;
    // `(h ^ (h >>> 13))`: ToInt32(h) ^ ToUint32(h) >>> 13, an int32 — the same
    // 32 bits as the unsigned XOR, reinterpreted.
    const std::uint32_t a = js_to_uint32(h);
    h = static_cast<double>(std::bit_cast<std::int32_t>(a ^ (a >> 13U))) * 1274126177.0;
    const std::uint32_t b2 = js_to_uint32(h);
    const std::uint32_t u = b2 ^ (b2 >> 16U);  // `>>> 0` of the int32 XOR
    data[i] = static_cast<float>((static_cast<double>(u) / 4294967296.0) * 2 - 1);
  }
  return data;
}

// ── PeriodicWave (Chromium modules/webaudio/periodic_wave.cc) ───────────────

namespace {
std::size_t wave_size(double sampleRate) noexcept {
  if (sampleRate <= 24000) return 2048;
  return sampleRate <= 88200 ? 4096 : 16384;
}
}  // namespace

PeriodicWave::PeriodicWave(Wave shape, double sampleRate)
    : size_(wave_size(sampleRate)),
      ranges_(static_cast<std::size_t>(std::lround(3 * std::log2(static_cast<double>(size_))))),
      centsPerRange_(1200.0F / 3.0F),
      lowestFundamental_(static_cast<float>(sampleRate / static_cast<double>(size_))),
      rateScale_(static_cast<double>(size_) / sampleRate) {

  const std::size_t half = size_ / 2;
  // Fourier sine coefficients, float as Chromium computes them.
  std::vector<float> b(half, 0.0F);
  constexpr float kPiF = std::numbers::pi_v<float>;
  for (std::size_t n = 1; n < half; ++n) {
    const float piFactor = 2 / (static_cast<float>(n) * kPiF);
    float v = 0;
    switch (shape) {
      case Wave::sine:
      case Wave::whiteNoise:
        v = n == 1 ? 1.0F : 0.0F;
        break;
      case Wave::square:
        v = piFactor * ((n & 1U) != 0 ? 2.0F : 0.0F);
        break;
      case Wave::sawtooth:
        v = piFactor * ((n & 1U) != 0 ? 1.0F : -1.0F);
        break;
      case Wave::triangle:
        v = (n & 1U) != 0 ? 4 * (piFactor * piFactor) * ((((n - 1) >> 1U) & 1U) != 0 ? -1.0F : 1.0F) : 0.0F;
        break;
    }
    b[n] = v;
  }

  const Fft<double> fft(size_);
  std::vector<std::complex<double>> buf(size_);
  float normalization = 1;
  tables_.resize(ranges_);
  for (std::size_t r = 0; r < ranges_; ++r) {
    const float centsToCull = static_cast<float>(r) * centsPerRange_;
    const float culling = std::pow(2.0F, -centsToCull / 1200);
    const auto partials = static_cast<std::size_t>(culling * static_cast<float>(half));
    const std::size_t keep = std::min(half, partials + 1);
    // x[k] = Σ b_n sin(2πnk/N): X[n] = -i·b_n·N/2, X[N-n] = conj; inverse
    // transform without 1/N gives Σ (X e^{+iθ}) = N·Σ b_n sin θ... scaled out
    // by the normalisation below, exactly as Chromium's table is.
    std::ranges::fill(buf, std::complex<double>{});
    for (std::size_t n = 1; n < keep; ++n) {
      const double bn = b[n];
      buf[n] = {0, -0.5 * bn};
      buf[size_ - n] = {0, 0.5 * bn};
    }
    fft.transform(buf.data(), true);
    std::vector<float> table(size_);
    for (std::size_t k = 0; k < size_; ++k) table[k] = static_cast<float>(buf[k].real());
    if (r == 0) {
      float mx = 0;
      for (const float v : table) mx = std::max(mx, std::fabs(v));
      if (mx != 0) normalization = 1.0F / mx;
    }
    for (float& v : table) v *= normalization;
    tables_[r] = std::move(table);
  }
}

void PeriodicWave::tables_for(float fundamental, const float*& lower, const float*& higher,
                              float& tableInterp) const noexcept {
  fundamental = std::fabs(fundamental);
  const float ratio = fundamental > 0 ? fundamental / lowestFundamental_ : 0.5F;
  const float centsAbove = std::log2(ratio) * 1200;
  float pitchRange = 1 + centsAbove / centsPerRange_;
  pitchRange = std::max(pitchRange, 0.0F);
  pitchRange = std::min(pitchRange, static_cast<float>(ranges_ - 1));
  const auto r1 = static_cast<std::size_t>(pitchRange);
  const std::size_t r2 = r1 < ranges_ - 1 ? r1 + 1 : r1;
  lower = tables_[r2].data();
  higher = tables_[r1].data();
  tableInterp = pitchRange - static_cast<float>(r1);
}

std::shared_ptr<const PeriodicWave> periodic_wave(Wave shape, double sampleRate) {
  static std::mutex mu;
  static std::map<std::pair<int, double>, std::shared_ptr<const PeriodicWave>> cache;
  const std::scoped_lock lock(mu);
  const std::pair<int, double> key{static_cast<int>(shape == Wave::whiteNoise ? Wave::sine : shape), sampleRate};
  auto it = cache.find(key);
  if (it != cache.end()) return it->second;
  auto w = std::make_shared<const PeriodicWave>(shape == Wave::whiteNoise ? Wave::sine : shape, sampleRate);
  cache.emplace(key, w);
  return w;
}

// ── Oscillator ──────────────────────────────────────────────────────────────

Oscillator::Oscillator(std::shared_ptr<const PeriodicWave> wave) : wave_(std::move(wave)) {}

void Oscillator::skip(double frames, double frequency) noexcept {
  if (!wave_) return;
  const auto size = static_cast<double>(wave_->size());
  const double incr = frequency * wave_->rate_scale();
  const double v = index_ + frames * incr;
  index_ = v - std::floor(v / size) * size;
}

float Oscillator::tick(double frequency) noexcept {
  if (!wave_) return 0;
  const float* lower = nullptr;
  const float* higher = nullptr;
  float tableInterp = 0;
  wave_->tables_for(static_cast<float>(frequency), lower, higher, tableInterp);
  const std::size_t size = wave_->size();
  const std::size_t mask = size - 1;
  const auto readIndex = static_cast<std::size_t>(index_) & mask;
  const std::size_t readIndex2 = (readIndex + 1) & mask;
  const auto f = static_cast<float>(index_ - std::floor(index_));
  const float higherS = (1 - f) * higher[readIndex] + f * higher[readIndex2];
  const float lowerS = (1 - f) * lower[readIndex] + f * lower[readIndex2];
  const float out = (1 - tableInterp) * higherS + tableInterp * lowerS;
  const double incr = frequency * wave_->rate_scale();
  const auto fsize = static_cast<double>(size);
  index_ += incr;
  index_ -= std::floor(index_ / fsize) * fsize;
  return out;
}

}  // namespace premation::audio::dsp
