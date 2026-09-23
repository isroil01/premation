#include "dsp_convolver.hpp"

#include <algorithm>
#include <utility>

namespace premation::audio::dsp {

namespace {

void init_stage(ConvolverKernel::Stage& st, std::span<const float> ir, std::size_t blockSize) {
  st.block = blockSize;
  const std::size_t n = 2 * blockSize;
  st.fft = Fft<float>(n);
  const std::size_t parts = std::max<std::size_t>(1, (ir.size() + blockSize - 1) / blockSize);
  st.h.assign(parts, std::vector<std::complex<float>>(n));
  for (std::size_t p = 0; p < parts; ++p) {
    auto& spec = st.h[p];
    const std::size_t begin = p * blockSize;
    const std::size_t end = std::min(ir.size(), begin + blockSize);
    for (std::size_t i = begin; i < end; ++i) spec[i - begin] = {ir[i], 0.0F};
    st.fft.transform(spec.data(), false);
  }
}

}  // namespace

ConvolverKernel::ConvolverKernel(std::span<const float> ir) {
  init_stage(head, ir.subspan(0, std::min(ir.size(), kHead)), kBlock);
  if (ir.size() > kHead) {
    hasTail = true;
    init_stage(tail, ir.subspan(kHead), kTailBlock);
  }
}

void Convolver::init(StageState& s, const ConvolverKernel::Stage& k) {
  const std::size_t n = 2 * k.block;
  s.fdl.assign(k.h.size(), std::vector<std::complex<float>>(n));
  s.fdlPos = 0;
  s.input.assign(n, 0.0F);
  s.work.assign(n, {});
  s.acc.assign(n, {});
}

Convolver::Convolver(std::shared_ptr<const ConvolverKernel> kernel) : k_(std::move(kernel)) {
  init(head_, k_->head);
  if (k_->hasTail) {
    init(tail_, k_->tail);
    tailIn_.assign(ConvolverKernel::kTailBlock, 0.0F);
    tailOut_.assign(4, std::vector<float>(ConvolverKernel::kTailBlock, 0.0F));
  }
}

void Convolver::reset() noexcept {
  auto clear = [](StageState& s) {
    for (auto& f : s.fdl) std::ranges::fill(f, std::complex<float>{});
    s.fdlPos = 0;
    std::ranges::fill(s.input, 0.0F);
  };
  clear(head_);
  if (k_ && k_->hasTail) {
    clear(tail_);
    std::ranges::fill(tailIn_, 0.0F);
    for (auto& b : tailOut_) std::ranges::fill(b, 0.0F);
  }
  tailFill_ = 0;
  frames_ = 0;
}

void Convolver::run(StageState& s, const ConvolverKernel::Stage& k, float* out) noexcept {
  const std::size_t n = 2 * k.block;
  const std::size_t parts = k.h.size();
  auto& x = s.fdl[s.fdlPos];
  for (std::size_t i = 0; i < n; ++i) x[i] = {s.input[i], 0.0F};
  k.fft.transform(x.data(), false);
  std::ranges::fill(s.acc, std::complex<float>{});
  for (std::size_t p = 0; p < parts; ++p) {
    const auto& xs = s.fdl[(s.fdlPos + parts - p) % parts];
    const auto& hs = k.h[p];
    for (std::size_t i = 0; i < n; ++i) {
      const float re = xs[i].real() * hs[i].real() - xs[i].imag() * hs[i].imag();
      const float im = xs[i].real() * hs[i].imag() + xs[i].imag() * hs[i].real();
      s.acc[i] = {s.acc[i].real() + re, s.acc[i].imag() + im};
    }
  }
  s.fdlPos = (s.fdlPos + 1) % parts;
  std::ranges::copy(s.acc, s.work.begin());
  k.fft.transform(s.work.data(), true);
  const float scale = 1.0F / static_cast<float>(n);
  for (std::size_t i = 0; i < k.block; ++i) out[i] = s.work[k.block + i].real() * scale;
}

void Convolver::process(const float* in, float* out) noexcept {
  constexpr std::size_t kB = ConvolverKernel::kBlock;
  constexpr std::size_t kT = ConvolverKernel::kTailBlock;
  const auto kBd = static_cast<std::ptrdiff_t>(kB);
  std::copy(head_.input.begin() + kBd, head_.input.end(), head_.input.begin());
  std::copy(in, in + kB, head_.input.begin() + kBd);
  run(head_, k_->head, out);
  if (!k_->hasTail) {
    frames_ += kB;
    return;
  }
  // Tail contribution for these frames (computed ≥ one tail block earlier).
  const std::size_t blockIdx = frames_ / kT;
  const std::size_t off = frames_ % kT;
  auto& slot = tailOut_[blockIdx % tailOut_.size()];
  for (std::size_t i = 0; i < kB; ++i) out[i] += slot[off + i];
  if (off + kB == kT) std::ranges::fill(slot, 0.0F);
  std::copy(in, in + kB, tailIn_.begin() + static_cast<std::ptrdiff_t>(tailFill_));
  tailFill_ += kB;
  if (tailFill_ == kT) {
    const auto kTd = static_cast<std::ptrdiff_t>(kT);
    std::copy(tail_.input.begin() + kTd, tail_.input.end(), tail_.input.begin());
    std::ranges::copy(tailIn_, tail_.input.begin() + kTd);
    // IR offset 4096 = two tail blocks: due while the input's block + 2 plays.
    run(tail_, k_->tail, tailOut_[(blockIdx + 2) % tailOut_.size()].data());
    tailFill_ = 0;
  }
  frames_ += kB;
}

}  // namespace premation::audio::dsp
