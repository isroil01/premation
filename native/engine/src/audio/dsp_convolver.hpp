// ConvolverNode: zero-latency partitioned convolution in two stages —
//   head  IR[0, 4096)   uniformly partitioned overlap-save, 128-frame blocks
//                       (one render quantum: output for a quantum is ready
//                       when its input is)
//   tail  IR[4096, …)   2048-frame blocks, computed once per 2048 input frames
//                       and due two blocks later (the 4096-frame offset is the
//                       slack), so a 10 s reverb costs ~260 complex MACs/sample
// The sum equals direct convolution to float rounding (the parity gate checks
// it against Chromium's ReverbConvolver).
//
// The IR's partition spectra (ConvolverKernel) are immutable and shared by
// every voice using the same impulse; a Convolver is one stream's state.
#pragma once

#include <complex>
#include <cstddef>
#include <memory>
#include <span>
#include <vector>

#include "dsp_fft.hpp"

namespace premation::audio::dsp {

class ConvolverKernel {
 public:
  static constexpr std::size_t kBlock = 128;
  static constexpr std::size_t kHead = 4096;
  static constexpr std::size_t kTailBlock = 2048;

  explicit ConvolverKernel(std::span<const float> ir);

  struct Stage {
    std::size_t block = 0;
    Fft<float> fft;
    std::vector<std::vector<std::complex<float>>> h;  // partition spectra (2·block bins)
  };
  Stage head;
  Stage tail;
  bool hasTail = false;
};

class Convolver {
 public:
  Convolver() = default;
  explicit Convolver(std::shared_ptr<const ConvolverKernel> kernel);
  void reset() noexcept;
  /// Exactly ConvolverKernel::kBlock frames.
  void process(const float* in, float* out) noexcept;

 private:
  struct StageState {
    std::vector<std::vector<std::complex<float>>> fdl;  // input spectra, ring
    std::size_t fdlPos = 0;
    std::vector<float> input;  // last 2·block input samples
    std::vector<std::complex<float>> work;
    std::vector<std::complex<float>> acc;
  };
  static void init(StageState& s, const ConvolverKernel::Stage& k);
  static void run(StageState& s, const ConvolverKernel::Stage& k, float* out) noexcept;

  std::shared_ptr<const ConvolverKernel> k_;
  StageState head_;
  StageState tail_;
  std::vector<float> tailIn_;
  std::size_t tailFill_ = 0;
  std::vector<std::vector<float>> tailOut_;  // ring of 4 output blocks
  std::size_t frames_ = 0;
};

}  // namespace premation::audio::dsp
