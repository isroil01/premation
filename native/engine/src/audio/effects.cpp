#include "effects.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <numbers>
#include <cmath>
#include <map>
#include <mutex>
#include <string>
#include <tuple>
#include <utility>

#include "dsp_convolver.hpp"
#include "dsp_dynamics.hpp"
#include "dsp_filters.hpp"
#include "dsp_osc.hpp"
#include "jsmath.hpp"

namespace premation::audio {

namespace {

using dsp::BiquadCoefs;
using dsp::BiquadState;
using std::size_t;

constexpr size_t kN = kQuantum;
constexpr double kMaxDelaySec = 5;     // audioEffects.ts MAX_DELAY_SEC
constexpr double kFmBaseSec = 0.004;   // FM_BASE_SEC
constexpr double kBassShelfHz = 320;
constexpr double kTrebleShelfHz = 3200;

double clampTo(double v, double lo, double hi) { return std::min(hi, std::max(lo, v)); }
/// audioEffects.ts's local dbToGain (no −60 floor): 10 ** (db / 20).
double fx_db_to_gain(double db) { return motion::js::pow(10, db / 20); }

// ── AUDIO_EFFECT_DEFS (keys + defaults, in the TS order) ─────────────────────

constexpr std::array kEqDefs{ParamDef{"frequency", 1000}, ParamDef{"gain", 0},  ParamDef{"q", 1},
                             ParamDef{"frequency2", 3000}, ParamDef{"gain2", 0}, ParamDef{"q2", 1},
                             ParamDef{"frequency3", 8000}, ParamDef{"gain3", 0}, ParamDef{"q3", 1}};
constexpr std::array kBassTrebleDefs{ParamDef{"bass", 0}, ParamDef{"treble", 0}};
constexpr std::array kHighLowDefs{ParamDef{"cutoff", 1000}, ParamDef{"q", 0.707}};
constexpr std::array kDelayDefs{ParamDef{"time", 0.25}, ParamDef{"feedback", 30}, ParamDef{"mix", 40}};
constexpr std::array kReverbDefs{ParamDef{"decay", 1.8}, ParamDef{"preDelay", 20}, ParamDef{"mix", 20},
                                 ParamDef{"diffusion", 70}, ParamDef{"brightness", 50}};
constexpr std::array kFlangeDefs{ParamDef{"separation", 3}, ParamDef{"depth", 50}, ParamDef{"rate", 0.4},
                                 ParamDef{"feedback", 0},   ParamDef{"mix", 50},   ParamDef{"voices", 1},
                                 ParamDef{"phase", 90}};
constexpr std::array kToneDefs{ParamDef{"frequency", 440}, ParamDef{"frequency2", 0}, ParamDef{"frequency3", 0},
                               ParamDef{"frequency4", 0},   ParamDef{"frequency5", 0}, ParamDef{"level", -12}};
constexpr std::array kModulatorDefs{ParamDef{"rate", 30}, ParamDef{"depth", 50}, ParamDef{"fmDepth", 0}};
constexpr std::array kStereoMixerDefs{ParamDef{"leftLevel", 100}, ParamDef{"rightLevel", 100},
                                      ParamDef{"leftPan", -100}, ParamDef{"rightPan", 100}};
constexpr std::array kCompressorDefs{ParamDef{"threshold", -16}, ParamDef{"ratio", 3},     ParamDef{"knee", 15},
                                     ParamDef{"attack", 6},      ParamDef{"release", 440}, ParamDef{"makeupGain", 0},
                                     ParamDef{"outputLimit", 0}};
constexpr std::array kDistortionDefs{ParamDef{"drive", 25}, ParamDef{"gain", 25}, ParamDef{"mix", 100},
                                     ParamDef{"volume", 11}, ParamDef{"resolution", 16}};
constexpr std::array kDeEsserDefs{ParamDef{"threshold", -20}, ParamDef{"frequency", 7000},
                                  ParamDef{"bandwidth", 3000}, ParamDef{"attack", 1}, ParamDef{"release", 50}};

// ── Node helpers ────────────────────────────────────────────────────────────

/// GainNode: out = in × gain (a-rate).
struct GainNode {
  Bound g;
  std::array<float, kN> v{};
  void apply(const QuantumClock& q, const float* in, float* out) noexcept {
    if (g.fill(q, v.data(), kN)) {
      const float c = v[0];
      for (size_t i = 0; i < kN; ++i) out[i] = in[i] * c;
    } else {
      for (size_t i = 0; i < kN; ++i) out[i] = in[i] * v[i];
    }
  }
  void apply(const QuantumClock& q, Block& b) noexcept {
    const bool constant = g.fill(q, v.data(), kN);
    for (int c = 0; c < b.channels; ++c) {
      float* x = b.c(c);
      if (constant) {
        const float k = v[0];
        for (size_t i = 0; i < kN; ++i) x[i] *= k;
      } else {
        for (size_t i = 0; i < kN; ++i) x[i] *= v[i];
      }
    }
  }
};

/// BiquadFilterNode (a-rate frequency / Q / gain / detune).
struct BiquadNode {
  BiquadType type = BiquadType::peaking;
  Bound freq, q, gain, detune{0.0F};
  std::array<BiquadState, 2> st{};
  std::array<float, kN> f{}, qv{}, gv{}, dv{};
  double sr = 48000;

  void reset() noexcept { st = {}; }
  void process(const QuantumClock& clk, Block& b) noexcept {
    const bool cf = freq.fill(clk, f.data(), kN);
    const bool cq = q.fill(clk, qv.data(), kN);
    const bool cg = gain.fill(clk, gv.data(), kN);
    const bool cd = detune.fill(clk, dv.data(), kN);
    if (cf && cq && cg && cd) {
      const BiquadCoefs co = dsp::biquad_coefs(type, sr, f[0], qv[0], gv[0], dv[0]);
      for (int c = 0; c < b.channels; ++c) dsp::biquad_run(co, st[static_cast<size_t>(c)], b.c(c), b.c(c), kN);
      return;
    }
    for (size_t i = 0; i < kN; ++i) {
      const BiquadCoefs co = dsp::biquad_coefs(type, sr, cf ? f[0] : f[i], cq ? qv[0] : qv[i], cg ? gv[0] : gv[i],
                                               cd ? dv[0] : dv[i]);
      for (int c = 0; c < b.channels; ++c) b.c(c)[i] = dsp::biquad_tick(co, st[static_cast<size_t>(c)], b.c(c)[i]);
    }
  }
};

/// A generator's audible window: it starts and stops with the voice.
struct GenWindow {
  std::int64_t start = 0;
  std::int64_t end = INT64_MAX;
  [[nodiscard]] bool on(std::int64_t frame) const noexcept { return frame >= start && frame < end; }
};

/// OscillatorNode with an a-rate frequency and a static detune.
struct OscNode {
  dsp::Oscillator osc;
  Bound freq;
  double detune = 0;  // cents
  std::array<float, kN> fv{};

  void init() { osc = dsp::Oscillator(osc_wave_); }
  void reset(const Anchor& a) noexcept {
    osc.reset();
    // Anchor the phase at the voice's first frame: the tone at a frame is the
    // same whether playback began at the bar or inside it.
    if (a.frame0 > a.startFrame) {
      const QuantumClock c{a.sampleRate, a.frame0, kQuantum};
      osc.skip(static_cast<double>(a.frame0 - a.startFrame), detuned(freq.at_start(c)));
    }
  }
  [[nodiscard]] double detuned(float f) const noexcept {
    // Chromium: frequency * exp2(detune / 1200), in float.
    if (detune == 0) return f;
    return static_cast<double>(f * std::exp2(static_cast<float>(detune) / 1200.0F));
  }
  /// Fills `out` with the oscillator over the quantum (zeros outside `win`).
  void run(const QuantumClock& clk, const GenWindow& win, float* out) noexcept {
    freq.fill(clk, fv.data(), kN);
    const bool constant = !freq.animated();
    for (size_t i = 0; i < kN; ++i) {
      const std::int64_t frame = clk.frame0 + static_cast<std::int64_t>(i);
      if (!win.on(frame)) {
        out[i] = 0;
        continue;
      }
      out[i] = osc.tick(detuned(constant ? fv[0] : fv[i]));
    }
  }
  std::shared_ptr<const dsp::PeriodicWave> osc_wave_;
};

/// out += in, up-mixing a mono `in` into a stereo `out`.
void sum_into(Block& out, const Block& in) noexcept {
  if (in.channels == 1 && out.channels == 2) {
    for (int c = 0; c < 2; ++c) {
      float* o = out.c(c);
      const float* x = in.c(0);
      for (size_t i = 0; i < kN; ++i) o[i] += x[i];
    }
    return;
  }
  for (int c = 0; c < in.channels; ++c) {
    float* o = out.c(c);
    const float* x = in.c(c);
    for (size_t i = 0; i < kN; ++i) o[i] += x[i];
  }
}

/// Wave for a control LFO: White Noise falls back to a sine (lfoType).
Wave lfo_wave(const EffectSpec& fx) { return fx.hasWave && fx.wave != Wave::whiteNoise ? fx.wave : Wave::sine; }

// ── The effects ─────────────────────────────────────────────────────────────

class ParametricEq final : public Effect {
 public:
  ParametricEq(const EffectSpec& fx, double sr) : p_(fx, kEqDefs) {
    static constexpr std::array<std::array<const char*, 3>, 3> kBands{{{"frequency", "gain", "q"},
                                                                       {"frequency2", "gain2", "q2"},
                                                                       {"frequency3", "gain3", "q3"}}};
    for (size_t b = 0; b < 3; ++b) {
      const size_t fk = p_.idx(kBands[b][0]);
      const size_t gk = p_.idx(kBands[b][1]);
      const size_t qk = p_.idx(kBands[b][2]);
      auto& n = bands_[b];
      n.type = BiquadType::peaking;
      n.sr = sr;
      n.freq = Bound(&p_, {fk}, [fk](const double* v) { return clampTo(v[fk], 20, 20000); });
      n.gain = Bound(&p_, {gk}, [gk](const double* v) { return v[gk]; });
      // The spec rejects Q <= 0; clamped inside the derivation (every point).
      n.q = Bound(&p_, {qk}, [qk](const double* v) { return std::max(0.0001, v[qk]); });
    }
  }
  void reset(const Anchor& /*a*/) noexcept override {
    for (auto& b : bands_) b.reset();
  }
  void process(Block& io, const QuantumClock& q) noexcept override {
    for (auto& b : bands_) b.process(q, io);
  }

 private:
  FxParams p_;
  std::array<BiquadNode, 3> bands_;
};

class BassTreble final : public Effect {
 public:
  BassTreble(const EffectSpec& fx, double sr) : p_(fx, kBassTrebleDefs) {
    const size_t bk = p_.idx("bass");
    const size_t tk = p_.idx("treble");
    low_.type = BiquadType::lowshelf;
    low_.sr = sr;
    low_.freq = Bound(static_cast<float>(kBassShelfHz));
    low_.q = Bound(1.0F);
    low_.gain = Bound(&p_, {bk}, [bk](const double* v) { return v[bk]; });
    high_.type = BiquadType::highshelf;
    high_.sr = sr;
    high_.freq = Bound(static_cast<float>(kTrebleShelfHz));
    high_.q = Bound(1.0F);
    high_.gain = Bound(&p_, {tk}, [tk](const double* v) { return v[tk]; });
  }
  void reset(const Anchor& /*a*/) noexcept override {
    low_.reset();
    high_.reset();
  }
  void process(Block& io, const QuantumClock& q) noexcept override {
    low_.process(q, io);
    high_.process(q, io);
  }

 private:
  FxParams p_;
  BiquadNode low_, high_;
};

class HighLowPass final : public Effect {
 public:
  HighLowPass(const EffectSpec& fx, double sr) : p_(fx, kHighLowDefs) {
    const size_t ck = p_.idx("cutoff");
    const size_t qk = p_.idx("q");
    f_.type = fx.lowpass ? BiquadType::lowpass : BiquadType::highpass;
    f_.sr = sr;
    f_.freq = Bound(&p_, {ck}, [ck](const double* v) { return v[ck]; });
    f_.q = Bound(&p_, {qk}, [qk](const double* v) { return std::max(0.0001, v[qk]); });
    f_.gain = Bound(0.0F);
  }
  void reset(const Anchor& /*a*/) noexcept override { f_.reset(); }
  void process(Block& io, const QuantumClock& q) noexcept override { f_.process(q, io); }

 private:
  FxParams p_;
  BiquadNode f_;
};

class Delay final : public Effect {
 public:
  Delay(const EffectSpec& fx, double sr) : p_(fx, kDelayDefs), sr_(sr) {
    const size_t tk = p_.idx("time");
    const size_t fk = p_.idx("feedback");
    const size_t mk = p_.idx("mix");
    time_ = Bound(&p_, {tk}, [tk](const double* v) { return clampTo(v[tk], 0, kMaxDelaySec); });
    fb_ = Bound(&p_, {fk}, [fk](const double* v) { return clampTo(v[fk] / 100, 0, 0.95); });
    dry_ = Bound(&p_, {mk}, [mk](const double* v) { return 1 - clampTo(v[mk] / 100, 0, 1); });
    wet_ = Bound(&p_, {mk}, [mk](const double* v) { return clampTo(v[mk] / 100, 0, 1); });
    for (auto& l : lines_) l = dsp::DelayLine(kMaxDelaySec, sr);
  }
  void reset(const Anchor& /*a*/) noexcept override {
    for (auto& l : lines_) l.clear();
    for (auto& p : prev_) p.fill(0);
  }
  void process(Block& io, const QuantumClock& q) noexcept override {
    time_.fill(q, t_.data(), kN);
    const bool ct = !time_.animated();
    fb_.fill(q, f_.data(), kN);
    const bool cf = !fb_.animated();
    dry_.fill(q, d_.data(), kN);
    const bool cd = !dry_.animated();
    wet_.fill(q, w_.data(), kN);
    const bool cw = !wet_.animated();
    for (int c = 0; c < io.channels; ++c) {
      auto& line = lines_[static_cast<size_t>(c)];
      auto& prev = prev_[static_cast<size_t>(c)];
      float* x = io.c(c);
      for (size_t i = 0; i < kN; ++i) {
        // The feedback cycle: Chromium's pull model hands the feedback gain
        // the delay's output from the PREVIOUS render quantum, so the loop
        // is delayTime + 128 frames (measured: 100-frame delay → echoes
        // 228 frames apart).
        const float fbOut = prev[i] * (cf ? f_[0] : f_[i]);
        const float dly = line.process(x[i] + fbOut, static_cast<double>(ct ? t_[0] : t_[i]) * sr_);
        prev[i] = dly;
        const float dryOut = x[i] * (cd ? d_[0] : d_[i]);
        const float wetOut = dly * (cw ? w_[0] : w_[i]);
        x[i] = dryOut + wetOut;
      }
    }
  }

 private:
  FxParams p_;
  double sr_;
  Bound time_, fb_, dry_, wet_;
  std::array<dsp::DelayLine, 2> lines_;
  std::array<std::array<float, kN>, 2> prev_{};  // last quantum's delay output
  std::array<float, kN> t_{}, f_{}, d_{}, w_{};
};

// Shared IR + kernel cache (process-wide; built on the control thread).
struct IrKey {
  double sr, decay, pre;
  std::uint32_t seed;
  double diffusion, brightness;
  auto operator<=>(const IrKey&) const = default;
};
struct IrEntry {
  std::shared_ptr<const StereoIr> ir;
  std::shared_ptr<const dsp::ConvolverKernel> kl, kr;
};
IrEntry cached_ir(const IrKey& key) {
  static std::mutex mu;
  static std::map<IrKey, IrEntry> cache;
  {
    const std::scoped_lock lock(mu);
    auto it = cache.find(key);
    if (it != cache.end()) return it->second;
  }
  IrEntry e;
  e.ir = reverb_ir(key.sr, key.decay, key.pre, key.seed, key.diffusion, key.brightness);
  e.kl = std::make_shared<const dsp::ConvolverKernel>(std::span<const float>(e.ir->l));
  e.kr = std::make_shared<const dsp::ConvolverKernel>(std::span<const float>(e.ir->r));
  const std::scoped_lock lock(mu);
  // Bounded: a project sweeping reverb settings must not grow this forever.
  if (cache.size() > 32) cache.clear();
  cache.emplace(key, e);
  return e;
}

class Reverb final : public Effect {
 public:
  Reverb(const EffectSpec& fx, double sr) : p_(fx, kReverbDefs) {
    const double decay = clampTo(p_.statik(p_.idx("decay")), 0.1, 10);
    const double preMs = clampTo(p_.statik(p_.idx("preDelay")), 0, 200);
    const double diffusion = clampTo(p_.statik(p_.idx("diffusion")), 0, 100) / 100;
    const double brightness = clampTo(p_.statik(p_.idx("brightness")), 0, 100) / 100;
    const IrEntry e = cached_ir({sr, decay, preMs / 1000, dsp::hash_id(fx.id), diffusion, brightness});
    convL_ = dsp::Convolver(e.kl);
    convR_ = dsp::Convolver(e.kr);
    const size_t mk = p_.idx("mix");
    dry_.g = Bound(&p_, {mk}, [mk](const double* v) { return 1 - clampTo(v[mk] / 100, 0, 1); });
    wet_.g = Bound(&p_, {mk}, [mk](const double* v) { return clampTo(v[mk] / 100, 0, 1); });
  }
  void reset(const Anchor& /*a*/) noexcept override {
    convL_.reset();
    convR_.reset();
  }
  void process(Block& io, const QuantumClock& q) noexcept override {
    // Wet: a stereo IR makes a stereo output from mono or stereo input.
    wet_blk_.channels = 2;
    convL_.process(io.c(0), wet_blk_.c(0));
    convR_.process(io.c(io.channels > 1 ? 1 : 0), wet_blk_.c(1));
    wet_.apply(q, wet_blk_);
    dry_.apply(q, io);
    io.upmix();
    // sum = dry + wet (dry connected first).
    for (int c = 0; c < 2; ++c) {
      float* o = io.c(c);
      const float* w = wet_blk_.c(c);
      for (size_t i = 0; i < kN; ++i) o[i] = o[i] + w[i];
    }
  }

 private:
  FxParams p_;
  dsp::Convolver convL_, convR_;
  GainNode dry_, wet_;
  Block wet_blk_;
};

class FlangeChorus final : public Effect {
 public:
  FlangeChorus(const EffectSpec& fx, double sr) : p_(fx, kFlangeDefs), sr_(sr) {
    const size_t sk = p_.idx("separation");
    const size_t dk = p_.idx("depth");
    const size_t rk = p_.idx("rate");
    const size_t fk = p_.idx("feedback");
    const size_t mk = p_.idx("mix");
    auto baseOf = [sk](const double* v) { return clampTo(v[sk], 0.1, 40) / 1000; };
    voices_ = static_cast<size_t>(std::max(1.0, std::min(8.0, motion::js::round(p_.statik(p_.idx("voices"))))));
    const double phaseDeg = clampTo(p_.statik(p_.idx("phase")), 0, 360);
    stereo_ = fx.has_flag("stereoVoices") && voices_ > 1;
    const auto wave = dsp::periodic_wave(lfo_wave(fx), sr);
    vs_.resize(voices_);
    for (size_t v = 0; v < voices_; ++v) {
      auto& s = vs_[v];
      const double spread = 1 + static_cast<double>(v) * 0.5;
      s.delayTime = Bound(&p_, {sk}, [baseOf, spread](const double* x) {
        return clampTo(baseOf(x) * spread, 0, kMaxDelaySec);
      });
      s.lfo.freq = Bound(&p_, {rk}, [rk](const double* x) { return clampTo(x[rk], 0.05, 10); });
      s.lfo.osc_wave_ = wave;
      s.lfo.init();
      if (v > 0) s.lfo.detune = (phaseDeg / 360) * static_cast<double>(v) * 12;
      s.depth = Bound(&p_, {sk, dk}, [baseOf, spread, dk](const double* x) {
        return baseOf(x) * spread * 0.5 * clampTo(x[dk] / 100, 0, 1);
      });
      for (auto& l : s.lines) l = dsp::DelayLine(kMaxDelaySec, sr);
      s.pan = v % 2 == 0 ? -0.7 : 0.7;
    }
    fb_ = Bound(&p_, {fk}, [fk](const double* x) { return clampTo(x[fk] / 100, -0.95, 0.95); });
    voiceGain_ = static_cast<float>(1.0 / static_cast<double>(voices_));
    const float sign = fx.has_flag("invertPhase") ? -1.0F : 1.0F;
    dry_.g = Bound(&p_, {mk}, [mk](const double* x) { return 1 - clampTo(x[mk] / 100, 0, 1); });
    wet_.g = Bound(&p_, {mk}, [mk, sign](const double* x) {
      return static_cast<double>(sign) * clampTo(x[mk] / 100, 0, 1);
    });
  }
  void reset(const Anchor& a) noexcept override {
    for (auto& s : vs_) {
      for (auto& l : s.lines) l.clear();
      for (auto& p : s.prev) p.fill(0);
      s.lfo.reset(a);
    }
    win_ = {a.startFrame, a.endFrame};
  }
  void process(Block& io, const QuantumClock& q) noexcept override {
    const int inCh = io.channels;
    wetSum_.zero(stereo_ ? 2 : inCh);
    fb_.fill(q, fbv_.data(), kN);
    const bool cfb = !fb_.animated();
    const GenWindow win = win_;
    for (size_t v = 0; v < voices_; ++v) {
      auto& s = vs_[v];
      s.delayTime.fill(q, dt_.data(), kN);
      const bool cdt = !s.delayTime.animated();
      s.depth.fill(q, dp_.data(), kN);
      const bool cdp = !s.depth.animated();
      s.lfo.run(q, win, lfo_.data());
      voice_.channels = inCh;
      for (int c = 0; c < inCh; ++c) {
        auto& line = s.lines[static_cast<size_t>(c)];
        const float* x = io.c(c);
        float* y = voice_.c(c);
        for (size_t i = 0; i < kN; ++i) {
          // delayTime = scheduled value + LFO × depth, clamped to the
          // AudioParam's range [0, maxDelayTime].
          const float param = (cdt ? dt_[0] : dt_[i]) + lfo_[i] * (cdp ? dp_[0] : dp_[i]);
          const double frames = clampTo(static_cast<double>(param), 0, kMaxDelaySec) * sr_;
          if (v == 0) {
            // Voice 0 carries the feedback loop, fed the previous quantum's
            // output (see Delay).
            auto& prev = s.prev[static_cast<size_t>(c)];
            const float dly = line.process(x[i] + prev[i] * (cfb ? fbv_[0] : fbv_[i]), frames);
            prev[i] = dly;
            y[i] = dly;
          } else {
            y[i] = line.process(x[i], frames);
          }
        }
        for (size_t i = 0; i < kN; ++i) y[i] *= voiceGain_;
      }
      if (stereo_) {
        panned_.channels = 2;
        for (size_t i = 0; i < kN; ++i) {
          float l = 0;
          float r = 0;
          if (inCh == 1) {
            dsp::pan_mono(voice_.c(0)[i], s.pan, l, r);
          } else {
            dsp::pan_stereo(voice_.c(0)[i], voice_.c(1)[i], s.pan, l, r);
          }
          panned_.c(0)[i] = l;
          panned_.c(1)[i] = r;
        }
        sum_into(wetSum_, panned_);
      } else {
        sum_into(wetSum_, voice_);
      }
    }
    wet_.apply(q, wetSum_);
    dry_.apply(q, io);
    if (wetSum_.channels == 2) io.upmix();
    sum_into(io, wetSum_);
  }

 private:
  struct VoiceState {
    Bound delayTime, depth;
    OscNode lfo;
    std::array<dsp::DelayLine, 2> lines;
    std::array<std::array<float, kN>, 2> prev{};
    double pan = 0;

  };
  FxParams p_;
  double sr_;
  size_t voices_ = 1;
  bool stereo_ = false;
  std::vector<VoiceState> vs_;
  Bound fb_;
  float voiceGain_ = 1;
  GainNode dry_, wet_;
  Block wetSum_, voice_, panned_;
  std::array<float, kN> fbv_{}, dt_{}, dp_{}, lfo_{};
  GenWindow win_;
};

class Tone final : public Effect {
 public:
  Tone(const EffectSpec& fx, double sr) : p_(fx, kToneDefs) {
    const size_t lk = p_.idx("level");
    amp_.g = Bound(&p_, {lk}, [lk](const double* v) { return fx_db_to_gain(clampTo(v[lk], -60, 0)); });
    if (fx.hasWave && fx.wave == Wave::whiteNoise) {
      noise_ = dsp::noise_buffer(sr, dsp::hash_id(fx.id));
    } else {
      static constexpr std::array<const char*, 5> kKeys{"frequency", "frequency2", "frequency3", "frequency4",
                                                       "frequency5"};
      const auto wave = dsp::periodic_wave(lfo_wave(fx), sr);
      for (const char* key : kKeys) {
        const size_t k = p_.idx(key);
        if (!(p_.statik(k) >= 20)) continue;  // 0 Hz = this tone is off (AE)
        OscNode o;
        o.osc_wave_ = wave;
        o.init();
        o.freq = Bound(&p_, {k}, [k](const double* v) { return clampTo(v[k], 20, 20000); });
        oscs_.push_back(std::move(o));
      }
      share_ = oscs_.empty() ? 1.0F : static_cast<float>(1.0 / static_cast<double>(oscs_.size()));
    }
  }
  void reset(const Anchor& a) noexcept override {
    for (auto& o : oscs_) o.reset(a);
    win_ = {a.startFrame, a.endFrame};
  }
  void process(Block& io, const QuantumClock& q) noexcept override {
    ampIn_.zero(1);
    const GenWindow win = win_;
    float* a = ampIn_.c(0);
    if (!noise_.empty()) {
      const auto len = static_cast<std::int64_t>(noise_.size());
      for (size_t i = 0; i < kN; ++i) {
        const std::int64_t frame = q.frame0 + static_cast<std::int64_t>(i);
        a[i] = win.on(frame) ? noise_[static_cast<size_t>((frame - win.start) % len)] : 0.0F;
      }
    } else {
      for (auto& o : oscs_) {
        o.run(q, win, tmp_.data());
        for (size_t i = 0; i < kN; ++i) a[i] += tmp_[i] * share_;
      }
    }
    amp_.apply(q, ampIn_);
    sum_into(io, ampIn_);
  }

 private:
  FxParams p_;
  GainNode amp_;
  std::vector<OscNode> oscs_;
  std::vector<float> noise_;
  float share_ = 1;
  Block ampIn_;
  std::array<float, kN> tmp_{};
  GenWindow win_;
};

class Modulator final : public Effect {
 public:
  Modulator(const EffectSpec& fx, double sr) : p_(fx, kModulatorDefs), sr_(sr) {
    const size_t rk = p_.idx("rate");
    const size_t dk = p_.idx("depth");
    const size_t fk = p_.idx("fmDepth");
    base_ = Bound(&p_, {dk}, [dk](const double* v) { return 1 - clampTo(v[dk] / 100, 0, 1); });
    lfoDepth_ = Bound(&p_, {dk}, [dk](const double* v) { return clampTo(v[dk] / 100, 0, 1); });
    const auto wave = dsp::periodic_wave(lfo_wave(fx), sr);
    lfo_.osc_wave_ = wave;
    lfo_.init();
    lfo_.freq = Bound(&p_, {rk}, [rk](const double* v) { return clampTo(v[rk], 0.1, 5000); });
    const double fm = clampTo(p_.statik(fk), 0, 100) / 100;
    fm_ = fm > 0 || p_.animated(fk);
    if (fm_) {
      fmLfo_.osc_wave_ = wave;
      fmLfo_.init();
      fmLfo_.freq = Bound(&p_, {rk}, [rk](const double* v) { return clampTo(v[rk], 0.1, 5000); });
      fmGain_ = Bound(&p_, {fk}, [fk](const double* v) { return kFmBaseSec * 0.9 * clampTo(v[fk] / 100, 0, 1); });
      for (auto& l : vib_) l = dsp::DelayLine(kFmBaseSec * 2, sr);
    }
  }
  void reset(const Anchor& a) noexcept override {
    lfo_.reset(a);
    if (fm_) {
      fmLfo_.reset(a);
      for (auto& l : vib_) l.clear();
    }
    win_ = {a.startFrame, a.endFrame};
  }
  void process(Block& io, const QuantumClock& q) noexcept override {
    const GenWindow win = win_;
    base_.fill(q, bv_.data(), kN);
    const bool cb = !base_.animated();
    lfoDepth_.fill(q, dv_.data(), kN);
    const bool cd = !lfoDepth_.animated();
    lfo_.run(q, win, lv_.data());
    for (size_t i = 0; i < kN; ++i) {
      // The gain AudioParam: intrinsic value + connected input (a-rate).
      const float lfoOut = lv_[i] * (cd ? dv_[0] : dv_[i]);
      g_[i] = (cb ? bv_[0] : bv_[i]) + lfoOut;
    }
    for (int c = 0; c < io.channels; ++c) {
      float* x = io.c(c);
      for (size_t i = 0; i < kN; ++i) x[i] *= g_[i];
    }
    if (!fm_) return;
    fmLfo_.run(q, win, lv_.data());
    fmGain_.fill(q, dv_.data(), kN);
    const bool cg = !fmGain_.animated();
    for (int c = 0; c < io.channels; ++c) {
      auto& line = vib_[static_cast<size_t>(c)];
      float* x = io.c(c);
      for (size_t i = 0; i < kN; ++i) {
        const float param = static_cast<float>(kFmBaseSec) + lv_[i] * (cg ? dv_[0] : dv_[i]);
        const double frames = clampTo(static_cast<double>(param), 0, kFmBaseSec * 2) * sr_;
        x[i] = line.process(x[i], frames);
      }
    }
  }

 private:
  FxParams p_;
  double sr_;
  Bound base_, lfoDepth_, fmGain_;
  OscNode lfo_, fmLfo_;
  bool fm_ = false;
  std::array<dsp::DelayLine, 2> vib_;
  std::array<float, kN> bv_{}, dv_{}, lv_{}, g_{};
  GenWindow win_;
};

class StereoMixer final : public Effect {
 public:
  StereoMixer(const EffectSpec& fx, double /*sr*/) : p_(fx, kStereoMixerDefs) {
    const size_t ll = p_.idx("leftLevel");
    const size_t rl = p_.idx("rightLevel");
    const size_t lp = p_.idx("leftPan");
    const size_t rp = p_.idx("rightPan");
    auto leg = [this](size_t levelKey, size_t panKey, bool left) {
      GainNode n;
      n.g = Bound(&p_, {levelKey, panKey}, [levelKey, panKey, left](const double* v) {
        const double level = v[levelKey] / 100;
        const double pan = v[panKey] / 100;
        const double a = (clampTo(pan, -1, 1) + 1) / 2 * (std::numbers::pi / 2);
        return clampTo(level, 0, 2) * (left ? motion::js::cos(a) : motion::js::sin(a));
      });
      return n;
    };
    ll_ = leg(ll, lp, true);
    lr_ = leg(ll, lp, false);
    rl_ = leg(rl, rp, true);
    rr_ = leg(rl, rp, false);
    invert_ = fx.has_flag("invertPhase");
  }
  void reset(const Anchor& /*a*/) noexcept override {}
  void process(Block& io, const QuantumClock& q) noexcept override {
    io.upmix();  // ChannelSplitter(2) is explicit-stereo
    const float* inL = io.c(0);
    const float* inR = io.c(1);
    ll_.apply(q, inL, a_.data());
    rl_.apply(q, inR, b_.data());
    lr_.apply(q, inL, c_.data());
    rr_.apply(q, inR, d_.data());
    float* outL = io.c(0);
    float* outR = io.c(1);
    for (size_t i = 0; i < kN; ++i) {
      outL[i] = a_[i] + b_[i];
      outR[i] = c_[i] + d_[i];
    }
    if (invert_) {
      for (int c = 0; c < 2; ++c) {
        float* x = io.c(c);
        for (size_t i = 0; i < kN; ++i) x[i] *= -1.0F;
      }
    }
  }

 private:
  FxParams p_;
  GainNode ll_, lr_, rl_, rr_;
  bool invert_ = false;
  std::array<float, kN> a_{}, b_{}, c_{}, d_{};
};

/// DynamicsCompressorNode: k-rate params, 4 divisions of 32 per quantum,
/// stereo output (a mono input is duplicated, as Chromium does).
struct CompressorNode {
  dsp::Compressor comp;
  Bound threshold, knee, ratio, attack, release;
  double sr = 48000;
  void init() { comp = dsp::Compressor(sr, 2); }
  void reset() noexcept { comp.reset(); }
  void process(const QuantumClock& q, Block& io) noexcept {
    const dsp::CompressorParams p{threshold.at_start(q), knee.at_start(q), ratio.at_start(q), attack.at_start(q),
                                  release.at_start(q)};
    io.upmix();
    for (size_t d = 0; d < kN; d += 32) {
      std::array<const float*, 2> in{io.c(0) + d, io.c(1) + d};
      std::array<float*, 2> out{io.c(0) + d, io.c(1) + d};
      comp.process_division(in.data(), out.data(), 32, p);
    }
  }
};

class CompressorFx final : public Effect {
 public:
  CompressorFx(const EffectSpec& fx, double sr) : p_(fx, kCompressorDefs) {
    const size_t tk = p_.idx("threshold");
    const size_t rk = p_.idx("ratio");
    const size_t kk = p_.idx("knee");
    const size_t ak = p_.idx("attack");
    const size_t rel = p_.idx("release");
    const size_t mk = p_.idx("makeupGain");
    const size_t ok = p_.idx("outputLimit");
    comp_.sr = sr;
    comp_.threshold = Bound(&p_, {tk}, [tk](const double* v) { return clampTo(v[tk], -100, 0); });
    comp_.ratio = Bound(&p_, {rk}, [rk](const double* v) { return clampTo(v[rk], 1, 20); });
    comp_.knee = Bound(&p_, {kk}, [kk](const double* v) { return clampTo(v[kk], 0, 40); });
    comp_.attack = Bound(&p_, {ak}, [ak](const double* v) { return clampTo(v[ak] / 1000, 0, 1); });
    comp_.release = Bound(&p_, {rel}, [rel](const double* v) { return clampTo(v[rel] / 1000, 0, 1); });
    makeup_.g = Bound(&p_, {mk}, [mk](const double* v) { return fx_db_to_gain(clampTo(v[mk], -30, 30)); });
    limit_ = p_.statik(ok) < 0 || p_.animated(ok);
    if (limit_) {
      lim_.sr = sr;
      lim_.threshold = Bound(&p_, {ok}, [ok](const double* v) { return clampTo(v[ok], -100, 0); });
      lim_.ratio = Bound(20.0F);
      lim_.knee = Bound(0.0F);
      lim_.attack = Bound(0.001F);
      lim_.release = Bound(0.05F);
      lim_.init();
    }
    comp_.init();
  }
  void reset(const Anchor& /*a*/) noexcept override {
    comp_.reset();
    if (limit_) lim_.reset();
  }
  void process(Block& io, const QuantumClock& q) noexcept override {
    comp_.process(q, io);
    makeup_.apply(q, io);
    if (limit_) lim_.process(q, io);
  }

 private:
  FxParams p_;
  CompressorNode comp_, lim_;
  GainNode makeup_;
  bool limit_ = false;
};

class Distortion final : public Effect {
 public:
  Distortion(const EffectSpec& fx, double /*sr*/) : p_(fx, kDistortionDefs) {
    const double drive = clampTo(p_.statik(p_.idx("drive")), 0, 100);
    const int bits = static_cast<int>(motion::js::round(clampTo(p_.statik(p_.idx("resolution")), 1, 16)));
    const std::vector<float> curve = distortion_curve(fx.shape, drive, bits);
    for (auto& s : shapers_) s = dsp::WaveShaper(curve, Oversample::x4, kN);
    const size_t gk = p_.idx("gain");
    const size_t vk = p_.idx("volume");
    const size_t mk = p_.idx("mix");
    pre_.g = Bound(&p_, {gk}, [gk](const double* v) { return clampTo(v[gk], 0, 300) / 25; });
    post_.g = Bound(&p_, {vk}, [vk](const double* v) { return clampTo(v[vk], 0, 100) / 11; });
    dry_.g = Bound(&p_, {mk}, [mk](const double* v) { return 1 - clampTo(v[mk] / 100, 0, 1); });
    wet_.g = Bound(&p_, {mk}, [mk](const double* v) { return clampTo(v[mk] / 100, 0, 1); });
    curve_ = curve;
  }
  void reset(const Anchor& /*a*/) noexcept override {
    for (auto& s : shapers_) s.reset();
  }
  void process(Block& io, const QuantumClock& q) noexcept override {
    wetB_ = io;
    pre_.apply(q, wetB_);
    for (int c = 0; c < wetB_.channels; ++c) {
      shapers_[static_cast<size_t>(c)].process(wetB_.c(c), tmp_.data(), kN);
      std::ranges::copy(tmp_, wetB_.c(c));
    }
    post_.apply(q, wetB_);
    wet_.apply(q, wetB_);
    dry_.apply(q, io);
    for (int c = 0; c < io.channels; ++c) {
      float* o = io.c(c);
      const float* w = wetB_.c(c);
      for (size_t i = 0; i < kN; ++i) o[i] = o[i] + w[i];
    }
  }

 private:
  FxParams p_;
  std::vector<float> curve_;
  std::array<dsp::WaveShaper, 2> shapers_;
  GainNode pre_, post_, dry_, wet_;
  Block wetB_;
  std::array<float, kN> tmp_{};
};

class DeEsser final : public Effect {
 public:
  DeEsser(const EffectSpec& fx, double sr) : p_(fx, kDeEsserDefs) {
    const size_t fk = p_.idx("frequency");
    const size_t bk = p_.idx("bandwidth");
    const size_t tk = p_.idx("threshold");
    const size_t ak = p_.idx("attack");
    const size_t rk = p_.idx("release");
    band_.type = BiquadType::bandpass;
    band_.sr = sr;
    band_.freq = Bound(&p_, {fk}, [fk](const double* v) { return clampTo(v[fk], 200, 20000); });
    band_.q = Bound(&p_, {fk, bk}, [fk, bk](const double* v) {
      return clampTo(v[fk] / std::max(100.0, v[bk]), 0.1, 40);
    });
    band_.gain = Bound(0.0F);
    squash_.sr = sr;
    squash_.threshold = Bound(&p_, {tk}, [tk](const double* v) { return clampTo(v[tk], -100, 0); });
    squash_.attack = Bound(&p_, {ak}, [ak](const double* v) { return clampTo(v[ak] / 1000, 0, 1); });
    squash_.release = Bound(&p_, {rk}, [rk](const double* v) { return clampTo(v[rk] / 1000, 0, 1); });
    squash_.ratio = Bound(8.0F);
    squash_.knee = Bound(3.0F);
    squash_.init();
    sibilanceOnly_ = fx.has_flag("sibilanceOnly");
  }
  void reset(const Anchor& /*a*/) noexcept override {
    band_.reset();
    squash_.reset();
  }
  void process(Block& io, const QuantumClock& q) noexcept override {
    bandB_ = io;
    band_.process(q, bandB_);
    sq_ = bandB_;
    squash_.process(q, sq_);  // stereo out
    // sum inputs in connection order: squash, node, invert(band).
    if (!sibilanceOnly_) {
      Block x = io;
      if (x.channels == 1) x.upmix();
      Block inv = bandB_;
      if (inv.channels == 1) inv.upmix();
      for (int c = 0; c < 2; ++c) {
        float* s = sq_.c(c);
        const float* a = x.c(c);
        const float* b = inv.c(c);
        for (size_t i = 0; i < kN; ++i) s[i] = (s[i] + a[i]) + b[i] * -1.0F;
      }
    }
    io = sq_;
  }

 private:
  FxParams p_;
  BiquadNode band_;
  CompressorNode squash_;
  bool sibilanceOnly_ = false;
  Block bandB_, sq_;
};

class Backwards final : public Effect {
 public:
  explicit Backwards(const EffectSpec& fx) : swap_(fx.has_flag("swapChannels")) {}
  void reset(const Anchor& /*a*/) noexcept override {}
  void process(Block& io, const QuantumClock& /*q*/) noexcept override {
    if (!swap_) return;
    io.upmix();
    std::swap(io.ch[0], io.ch[1]);
  }

 private:
  bool swap_;
};

/// A plugin's declared chain (pluginAudioGraph.ts `buildNode`).
class PluginFx final : public Effect {
 public:
  PluginFx(const EffectSpec& fx, double sr) : sr_(sr) {
    const auto& chain = *fx.plugin;
    std::vector<ParamDef> defs;
    defs.reserve(chain.defaults.size());
    for (const auto& [k, v] : chain.defaults) defs.push_back({k, v});
    p_ = FxParams(fx, defs);
    for (const auto& spec : chain.nodes) {
      Node n;
      n.kind = spec.kind;
      auto bind = [&](const char* name, float fallback) {
        for (const auto& [key, s] : spec.set) {
          if (key != name) continue;
          if (s.kind == PluginSetting::Kind::number) return Bound(static_cast<float>(s.number));
          if (s.kind == PluginSetting::Kind::param) {
            const size_t k = p_.idx(s.param);
            if (k >= p_.size()) return Bound(fallback);
            return Bound(&p_, {k}, [k](const double* v) { return v[k]; });
          }
        }
        return Bound(fallback);
      };
      auto ceiling = [&](const char* name, double whenAbsent) {
        for (const auto& [key, s] : spec.set) {
          if (key != name) continue;
          if (s.kind == PluginSetting::Kind::number) return s.number;
          if (s.kind == PluginSetting::Kind::param) {
            for (const auto& [mk, mv] : chain.maxima) {
              if (mk == s.param) return mv;
            }
          }
        }
        return whenAbsent;
      };
      switch (spec.kind) {
        case PluginNodeSpec::Kind::biquad:
          n.biquad.type = spec.biquad;
          n.biquad.sr = sr;
          n.biquad.freq = bind("frequency", 1000);
          n.biquad.q = bind("Q", 1);
          n.biquad.gain = bind("gain", 0);
          n.biquad.detune = bind("detune", 0);
          break;
        case PluginNodeSpec::Kind::gain:
          n.gain.g = bind("gain", 1);
          break;
        case PluginNodeSpec::Kind::delay:
          n.maxDelay = std::min(kMaxDelaySec, std::max(ceiling("delayTime", 0), 0.001));
          n.delayTime = bind("delayTime", 0);
          for (auto& l : n.lines) l = dsp::DelayLine(n.maxDelay, sr);
          break;
        case PluginNodeSpec::Kind::panner:
          n.pan = bind("pan", 0);
          break;
        case PluginNodeSpec::Kind::compressor:
          n.comp.sr = sr;
          n.comp.threshold = bind("threshold", -24);
          n.comp.knee = bind("knee", 30);
          n.comp.ratio = bind("ratio", 12);
          n.comp.attack = bind("attack", 0.003F);
          n.comp.release = bind("release", 0.25F);
          n.comp.init();
          break;
        case PluginNodeSpec::Kind::waveshaper:
          n.curve = spec.curve.size() >= 2 ? spec.curve : std::vector<float>{};
          for (auto& s : n.shapers) s = dsp::WaveShaper(n.curve, Oversample::x2, kN);
          break;
      }
      nodes_.push_back(std::move(n));
    }
  }
  void reset(const Anchor& /*a*/) noexcept override {
    for (auto& n : nodes_) {
      n.biquad.reset();
      for (auto& l : n.lines) l.clear();
      if (n.kind == PluginNodeSpec::Kind::compressor) n.comp.reset();
      for (auto& s : n.shapers) s.reset();
    }
  }
  void process(Block& io, const QuantumClock& q) noexcept override {
    for (auto& n : nodes_) {
      switch (n.kind) {
        case PluginNodeSpec::Kind::biquad:
          n.biquad.process(q, io);
          break;
        case PluginNodeSpec::Kind::gain:
          n.gain.apply(q, io);
          break;
        case PluginNodeSpec::Kind::delay: {
          n.delayTime.fill(q, v_.data(), kN);
          const bool c0 = !n.delayTime.animated();
          for (int c = 0; c < io.channels; ++c) {
            float* x = io.c(c);
            auto& line = n.lines[static_cast<size_t>(c)];
            for (size_t i = 0; i < kN; ++i) {
              x[i] = line.process(x[i], clampTo(static_cast<double>(c0 ? v_[0] : v_[i]), 0, n.maxDelay) * sr_);
            }
          }
          break;
        }
        case PluginNodeSpec::Kind::panner: {
          n.pan.fill(q, v_.data(), kN);
          const bool c0 = !n.pan.animated();
          const int inCh = io.channels;
          for (size_t i = 0; i < kN; ++i) {
            float l = 0;
            float r = 0;
            const double p = c0 ? v_[0] : v_[i];
            if (inCh == 1) {
              dsp::pan_mono(io.c(0)[i], p, l, r);
            } else {
              dsp::pan_stereo(io.c(0)[i], io.c(1)[i], p, l, r);
            }
            io.c(0)[i] = l;
            io.c(1)[i] = r;
          }
          io.channels = 2;
          break;
        }
        case PluginNodeSpec::Kind::compressor:
          n.comp.process(q, io);
          break;
        case PluginNodeSpec::Kind::waveshaper:
          for (int c = 0; c < io.channels; ++c) {
            n.shapers[static_cast<size_t>(c)].process(io.c(c), v_.data(), kN);
            std::ranges::copy(v_, io.c(c));
          }
          break;
      }
    }
  }

 private:
  struct Node {
    PluginNodeSpec::Kind kind = PluginNodeSpec::Kind::gain;
    BiquadNode biquad;
    GainNode gain;
    Bound delayTime, pan;
    double maxDelay = 0.001;
    std::array<dsp::DelayLine, 2> lines;
    CompressorNode comp;
    std::vector<float> curve;
    std::array<dsp::WaveShaper, 2> shapers;
  };
  FxParams p_;
  double sr_;
  std::vector<Node> nodes_;
  std::array<float, kN> v_{};
};

}  // namespace

bool EffectSpec::has_flag(const std::string& f) const noexcept {
  return std::ranges::find(flags, f) != flags.end();
}

bool has_backwards(const std::vector<EffectSpec>& specs) noexcept {
  return std::ranges::any_of(specs, [](const EffectSpec& s) { return s.type == EffectType::backwards && s.enabled; });
}

std::vector<float> distortion_curve(DistortionShape shape, double drivePercent, int bits) {
  constexpr std::size_t kSamples = 2048;
  std::vector<float> curve(kSamples);
  const double d = std::max(0.0, std::min(100.0, drivePercent)) / 100;
  const double k = 1 + d * d * 60;
  const double levels = bits >= 16 ? 0 : motion::js::pow(2, std::max(1, std::min(16, bits))) - 1;
  for (std::size_t i = 0; i < kSamples; ++i) {
    const double x = (static_cast<double>(i) / static_cast<double>(kSamples - 1)) * 2 - 1;
    double y = 0;
    switch (shape) {
      case DistortionShape::hardClip:
        y = std::max(-1.0, std::min(1.0, x * (1 + d * 9)));
        break;
      case DistortionShape::saturation1:
        y = motion::js::tanh(x * k * 0.5);
        break;
      case DistortionShape::saturation2:
        y = motion::js::sign(x) * (1 - motion::js::exp(-std::fabs(x) * k * 0.6));
        break;
      case DistortionShape::tube:
        y = x >= 0 ? motion::js::tanh(x * k * 0.5) : motion::js::tanh(x * k * 0.3) * 0.85;
        break;
      case DistortionShape::fuzz: {
        const double t = motion::js::tanh(x * (1 + d * 200));
        y = t * 0.9 + motion::js::sign(x) * 0.1 * d;
        break;
      }
      case DistortionShape::softClip:
        y = d == 0 ? x : motion::js::atan(x * k) / motion::js::atan(k);
        break;
    }
    if (levels > 0) y = motion::js::round(((y + 1) / 2) * levels) / levels * 2 - 1;
    curve[i] = static_cast<float>(std::max(-1.0, std::min(1.0, y)));
  }
  return curve;
}

std::shared_ptr<const StereoIr> reverb_ir(double sampleRate, double decaySec, double preDelaySec, std::uint32_t seed,
                                          double diffusion, double brightness) {
  // audioEffects.ts impulseResponse, operation for operation.
  const double rate = sampleRate;
  const auto pre = static_cast<std::size_t>(std::max(0.0, motion::js::round(preDelaySec * rate)));
  const auto tail = static_cast<std::size_t>(std::max(1.0, motion::js::round(decaySec * rate)));
  auto out = std::make_shared<StereoIr>();
  out->l.assign(pre + tail, 0.0F);
  out->r.assign(pre + tail, 0.0F);
  const double d = std::max(0.0, std::min(1.0, diffusion));
  const auto tailD = static_cast<double>(tail);
  const auto buildup = static_cast<std::size_t>(std::max(1.0, motion::js::round(tailD * 0.35 * (1 - d))));
  const double b = std::max(0.0, std::min(1.0, brightness));
  const auto s = static_cast<double>(seed);
  for (int ch = 0; ch < 2; ++ch) {
    auto& data = ch == 0 ? out->l : out->r;
    double lp = 0;
    for (std::size_t i = 0; i < tail; ++i) {
      double h = static_cast<double>(i + 1) * 374761393.0 + static_cast<double>(ch) * 668265263.0 + s * 2246822519.0;
      // `(h ^ (h >>> 13)) * …` as the same 32 bits, unsigned (see noise_buffer).
      const std::uint32_t a0 = motion::js::to_uint32(h);
      h = static_cast<double>(std::bit_cast<std::int32_t>(a0 ^ (a0 >> 13U))) * 1274126177.0;
      const std::uint32_t hu = motion::js::to_uint32(h);
      const std::uint32_t u = hu ^ (hu >> 16U);
      const double noise = (static_cast<double>(u) / 4294967296.0) * 2 - 1;
      const double t = static_cast<double>(i) / tailD;
      const double coeff = 0.15 + 0.8 * b * (1 - t * 0.6);
      lp += (noise - lp) * std::max(0.02, std::min(1.0, coeff));
      double density = 1;
      if (i < buildup) {
        const double ramp = static_cast<double>(i) / static_cast<double>(buildup);
        const double keep = static_cast<double>((hu >> 8U) & 0xffU) / 255;
        density = keep < 0.15 + 0.85 * ramp ? 1 : 0;
      }
      data[pre + i] = static_cast<float>(lp * density * motion::js::pow(10, (-3 * static_cast<double>(i)) / tailD));
    }
  }
  return out;
}

EffectChain::EffectChain(const std::vector<EffectSpec>& specs, double sampleRate) {
  for (const auto& fx : specs) {
    if (!fx.enabled) continue;
    std::unique_ptr<Effect> e;
    switch (fx.type) {
      case EffectType::parametricEq:
        e = std::make_unique<ParametricEq>(fx, sampleRate);
        break;
      case EffectType::bassTreble:
        e = std::make_unique<BassTreble>(fx, sampleRate);
        break;
      case EffectType::highLowPass:
        e = std::make_unique<HighLowPass>(fx, sampleRate);
        break;
      case EffectType::delay:
        e = std::make_unique<Delay>(fx, sampleRate);
        break;
      case EffectType::reverb:
        e = std::make_unique<Reverb>(fx, sampleRate);
        break;
      case EffectType::flangeChorus:
        e = std::make_unique<FlangeChorus>(fx, sampleRate);
        break;
      case EffectType::tone:
        e = std::make_unique<Tone>(fx, sampleRate);
        break;
      case EffectType::modulator:
        e = std::make_unique<Modulator>(fx, sampleRate);
        break;
      case EffectType::stereoMixer:
        e = std::make_unique<StereoMixer>(fx, sampleRate);
        break;
      case EffectType::compressor:
        e = std::make_unique<CompressorFx>(fx, sampleRate);
        break;
      case EffectType::distortion:
        e = std::make_unique<Distortion>(fx, sampleRate);
        break;
      case EffectType::deEsser:
        e = std::make_unique<DeEsser>(fx, sampleRate);
        break;
      case EffectType::backwards:
        e = std::make_unique<Backwards>(fx);
        break;
      case EffectType::plugin:
        // An uninstalled / undeclared plugin passes the signal through.
        if (fx.plugin) e = std::make_unique<PluginFx>(fx, sampleRate);
        break;
    }
    if (e) fx_.push_back(std::move(e));
  }
}

void EffectChain::reset(const Anchor& a) noexcept {
  for (auto& e : fx_) e->reset(a);
}


void EffectChain::process(Block& io, const QuantumClock& q) noexcept {
  for (auto& e : fx_) e->process(io, q);
}

}  // namespace premation::audio
