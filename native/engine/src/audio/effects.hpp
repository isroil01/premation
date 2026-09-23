// Per-layer audio effect chains — audioEffects.ts `connectAudioEffects`, node
// for node: every effect is built from the same primitives (biquads, delay
// lines, oscillators, gains, panners, a convolver, a compressor, a wave
// shaper) wired in the same topology, with every parameter bound the way
// `bind` binds it (static, or a ramp over the keyframed keys it watches).
// Channel counts follow Web Audio's mixing rules (a mono voice stays mono
// until a node makes it stereo — the reverb, the compressor, a splitter, a
// panner on stereo input), because the panner law differs for mono and
// stereo input and the parity depends on it.
//
// Everything is allocated when a chain is built (on the control thread);
// `process` runs one render quantum and never allocates.
#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <vector>

#include "audio_types.hpp"
#include "automation.hpp"

namespace premation::audio {

/// One render quantum of a voice's signal, 1 or 2 channels.
struct Block {
  int channels = 1;
  std::array<std::array<float, kQuantum>, 2> ch{};
  [[nodiscard]] float* c(int i) noexcept { return ch[static_cast<std::size_t>(i)].data(); }
  [[nodiscard]] const float* c(int i) const noexcept { return ch[static_cast<std::size_t>(i)].data(); }
  /// Web Audio "speakers" up-mix: mono → L = R = M.
  void upmix() noexcept {
    if (channels == 1) {
      ch[1] = ch[0];
      channels = 2;
    }
  }
  void zero(int nch) noexcept {
    channels = nch;
    for (auto& a : ch) a.fill(0);
  }
};

/// Where a chain (re)starts: the first comp frame it runs, and the voice's
/// audible window. Generators (Tone, the LFOs) start and stop with the voice
/// and anchor their phase at its first frame, so a tone sounds the same
/// whether playback began at the bar or inside it.
struct Anchor {
  std::int64_t frame0 = 0;
  double sampleRate = 48000;
  std::int64_t startFrame = 0;
  std::int64_t endFrame = INT64_MAX;
};

class Effect {
 public:
  Effect() = default;
  virtual ~Effect() = default;
  Effect(const Effect&) = delete;
  Effect& operator=(const Effect&) = delete;
  Effect(Effect&&) = delete;
  Effect& operator=(Effect&&) = delete;
  /// Clear all state (no allocation: runs on the audio thread at a seek).
  virtual void reset(const Anchor& a) noexcept = 0;
  virtual void process(Block& io, const QuantumClock& q) noexcept = 0;
};

class EffectChain {
 public:
  EffectChain() = default;
  EffectChain(const std::vector<EffectSpec>& specs, double sampleRate);
  [[nodiscard]] bool empty() const noexcept { return fx_.empty(); }
  void reset(const Anchor& a) noexcept;
  void process(Block& io, const QuantumClock& q) noexcept;

 private:
  std::vector<std::unique_ptr<Effect>> fx_;
};

// ── Pure helpers, exported for tests ────────────────────────────────────────

/// audioEffects.ts `distortionCurve` (2048 points), bit-for-bit.
[[nodiscard]] std::vector<float> distortion_curve(DistortionShape shape, double drivePercent, int bits);

/// audioEffects.ts `impulseResponse`: two channels, pre-delay + decay.
struct StereoIr {
  std::vector<float> l, r;
};
[[nodiscard]] std::shared_ptr<const StereoIr> reverb_ir(double sampleRate, double decaySec, double preDelaySec,
                                                        std::uint32_t seed, double diffusion, double brightness);

/// True when a chain reverses its source (hasBackwards).
[[nodiscard]] bool has_backwards(const std::vector<EffectSpec>& specs) noexcept;

}  // namespace premation::audio
