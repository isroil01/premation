// E2 audio engine — the value types every part of src/audio shares.
//
// The mix model is the TypeScript one (src/core/audio): a composition's sound
// is a flat list of VOICES (AudioEngine.ts `AudioLayerState` — one per clip
// bar, per time-remap segment, per nested-comp placement), each read from a
// decoded source, run through its layer's effect chain, then level (dB) and
// pan, summed on a master bus. The document side (D1b) builds the voice list;
// this module renders it. See docs/NATIVE_CORE_PLAN.md §5 E2 and
// native/README.md "Audio".
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "param_curve.hpp"

namespace premation::audio {

/// Web Audio's render quantum. k-rate parameters hold for one quantum, the
/// compressor's detector runs in 32-frame divisions of it, and every quantum
/// boundary sits at an absolute comp-frame multiple of this — which is what
/// makes a render independent of the device's callback size.
inline constexpr int kQuantum = 128;

/// The engine's mix format. Float32 planar internally; `channels` is 1 or 2.
struct MixFormat {
  int sampleRate = 48000;
  int channels = 2;
};

class SourceData;  // conformed (decoded + resampled) audio, source_store.hpp

// ── Effects (audioEffects.ts `AudioEffect`) ─────────────────────────────────

enum class EffectType : std::uint8_t {
  parametricEq,
  bassTreble,
  highLowPass,
  delay,
  reverb,
  flangeChorus,
  tone,
  modulator,
  stereoMixer,
  compressor,
  distortion,
  deEsser,
  backwards,
  plugin,  // a plugin's declared chain (pluginAudioGraph.ts)
};

enum class Wave : std::uint8_t { sine, triangle, sawtooth, square, whiteNoise };
enum class DistortionShape : std::uint8_t { softClip, hardClip, saturation1, saturation2, tube, fuzz };
enum class BiquadType : std::uint8_t { lowpass, highpass, bandpass, lowshelf, highshelf, peaking, notch, allpass };
enum class Oversample : std::uint8_t { none, x2, x4 };

/// One setting of a plugin chain node: a number, a parameter reference, or
/// absent (the node's own default).
struct PluginSetting {
  enum class Kind : std::uint8_t { absent, number, param };
  Kind kind = Kind::absent;
  double number = 0;
  std::string param;
};

/// audioEffectSchema.ts `PluginAudioNode`.
struct PluginNodeSpec {
  enum class Kind : std::uint8_t { biquad, gain, delay, panner, compressor, waveshaper };
  Kind kind = Kind::gain;
  BiquadType biquad = BiquadType::peaking;
  /// frequency / Q / gain / detune / delayTime / pan / threshold / knee / ratio / attack / release.
  std::vector<std::pair<std::string, PluginSetting>> set;
  std::vector<float> curve;  // waveshaper
};

/// A plugin contribution's declared chain + its params' defaults and maxima.
struct PluginChain {
  std::vector<PluginNodeSpec> nodes;
  std::vector<std::pair<std::string, double>> defaults;
  std::vector<std::pair<std::string, double>> maxima;
};

struct EffectSpec {
  /// Stable effect id: keyframes are scoped to it, and it seeds the reverb IR
  /// and the noise generator (hashId in audioEffects.ts).
  std::string id;
  EffectType type = EffectType::parametricEq;
  bool enabled = true;
  /// Static parameter values by key (audioEffects.ts AUDIO_EFFECT_DEFS keys).
  std::vector<std::pair<std::string, double>> params;
  /// Keyframed parameters by key (`audiofx.<id>.<key>` tracks).
  std::vector<std::pair<std::string, ParamCurve>> curves;
  bool lowpass = false;  // High-Low Pass `mode`
  bool hasWave = false;  // `wave` present (absent = sine; Tone's noise needs it set)
  Wave wave = Wave::sine;
  DistortionShape shape = DistortionShape::softClip;
  std::vector<std::string> flags;  // swapChannels, invertPhase, stereoVoices, sibilanceOnly
  std::shared_ptr<const PluginChain> plugin;  // type == plugin

  [[nodiscard]] bool has_flag(const std::string& f) const noexcept;
};

// ── Voices (AudioEngine.ts `AudioLayerState`) ───────────────────────────────

struct Voice {
  /// Voice identity (clip id, `::r<i>` retime segment, nested placement id).
  std::string id;
  std::string nodeId;
  std::uint64_t source = 0;
  /// The conformed source (resolved by AudioSystem when a program is built).
  std::shared_ptr<const SourceData> data;
  /// Comp time the bar starts at (seconds).
  double startSec = 0;
  /// Source offset at the bar's start (seconds).
  double inSec = 0;
  /// `outSec − inSec` is the bar's WALL length (the TS voice convention);
  /// `outSec <= 0` means "to the end of the source".
  double outSec = 0;
  /// Varispeed: source seconds per comp second (pitch follows, as Web Audio's
  /// `playbackRate`). Clamped to ≥ 0.01 like every TS reader.
  double playbackRate = 1;
  /// Layer-time reverse or the Backwards effect: the window plays backwards.
  bool reverse = false;
  /// Footage loop: read the source modulo its length (TS audio does not loop;
  /// the document sets this only when a looped layer should keep sounding).
  bool loop = false;
  bool muted = false;
  /// Level in dB (keyframed or static; ≤ −60 dB is silence).
  ParamCurve levelDb = ParamCurve::constant(0);
  /// Pan percent −100 … +100. `panner` false = no panner node at all (a
  /// centred, unanimated voice), exactly as `voicePanner` decides.
  ParamCurve pan = ParamCurve::constant(0);
  bool panner = false;
  std::vector<EffectSpec> effects;
};

/// The master bus: gain, mute, and a look-ahead brick-wall limiter.
struct MasterSettings {
  double gainDb = 0;
  bool muted = false;
  bool limiter = false;
  double limiterCeilingDb = -0.3;
  double limiterReleaseMs = 80;
};

/// Everything the mixer renders: the voice list + mix settings. Immutable
/// once built; swapped as a whole (shared_ptr<const Program>).
struct Program {
  MixFormat format;
  std::vector<Voice> voices;
  MasterSettings master;
  /// Automation control grid, in frames at absolute comp-frame multiples:
  /// every keyframed parameter is sampled on it and interpolated linearly
  /// per sample in between. 128 = one render quantum (375 Hz at 48 kHz);
  /// the TS schedules ramps at 50 Hz (960 frames), which the parity tests use.
  int controlPeriod = kQuantum;
  std::uint64_t revision = 0;
};

using ProgramPtr = std::shared_ptr<const Program>;

}  // namespace premation::audio
