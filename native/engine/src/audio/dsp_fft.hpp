// Radix-2 complex FFT (iterative Cooley–Tukey, precomputed twiddles and
// bit-reversal). Deterministic: the same size and input give the same bits on
// every run and platform (no FMA: -ffp-contract=off). Used by the partitioned
// convolver (reverb) and to build the oscillators' band-limited tables.
#pragma once

#include <complex>
#include <cstddef>
#include <vector>

namespace premation::audio::dsp {

template <class T>
class Fft {
 public:
  Fft() = default;
  explicit Fft(std::size_t n);
  [[nodiscard]] std::size_t size() const noexcept { return n_; }
  /// In place. `inverse` uses +i twiddles and does NOT scale by 1/n.
  void transform(std::complex<T>* data, bool inverse) const noexcept;

 private:
  std::size_t n_ = 0;
  std::vector<std::complex<T>> tw_;  // e^{-2πik/n}, k < n/2
  std::vector<std::size_t> rev_;
};

extern template class Fft<float>;
extern template class Fft<double>;

}  // namespace premation::audio::dsp
