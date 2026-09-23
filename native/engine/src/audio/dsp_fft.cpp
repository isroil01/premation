#include "dsp_fft.hpp"

#include <cmath>
#include <utility>

namespace premation::audio::dsp {

template <class T>
Fft<T>::Fft(std::size_t n) : n_(n), tw_(n / 2), rev_(n) {
  constexpr double kTwoPi = 6.28318530717958647692;
  for (std::size_t k = 0; k < n / 2; ++k) {
    const double a = -kTwoPi * static_cast<double>(k) / static_cast<double>(n);
    tw_[k] = {static_cast<T>(std::cos(a)), static_cast<T>(std::sin(a))};
  }
  std::size_t bits = 0;
  while ((std::size_t{1} << bits) < n) ++bits;
  for (std::size_t i = 0; i < n; ++i) {
    std::size_t r = 0;
    for (std::size_t b = 0; b < bits; ++b) {
      if ((i >> b) & 1U) r |= std::size_t{1} << (bits - 1 - b);
    }
    rev_[i] = r;
  }
}

template <class T>
void Fft<T>::transform(std::complex<T>* data, bool inverse) const noexcept {
  const std::size_t n = n_;
  for (std::size_t i = 0; i < n; ++i) {
    const std::size_t r = rev_[i];
    if (i < r) std::swap(data[i], data[r]);
  }
  for (std::size_t len = 2; len <= n; len <<= 1U) {
    const std::size_t half = len / 2;
    const std::size_t step = n / len;
    for (std::size_t i = 0; i < n; i += len) {
      for (std::size_t j = 0; j < half; ++j) {
        std::complex<T> w = tw_[j * step];
        if (inverse) w = std::conj(w);
        const std::complex<T> a = data[i + j];
        const std::complex<T> b = data[i + j + half];
        // Written out so no platform's complex multiply (with its NaN/inf
        // recovery path) changes the bits.
        const T br = b.real() * w.real() - b.imag() * w.imag();
        const T bi = b.real() * w.imag() + b.imag() * w.real();
        data[i + j] = {a.real() + br, a.imag() + bi};
        data[i + j + half] = {a.real() - br, a.imag() - bi};
      }
    }
  }
}

template class Fft<float>;
template class Fft<double>;

}  // namespace premation::audio::dsp
