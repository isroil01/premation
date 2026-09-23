// E2 audio core: DSP primitives against their definitions, the mixer's gain /
// pan / trim / varispeed / reverse math against the TS formulas, automation,
// peaks (exact against waveform.ts computePeaks), voice building, and the
// determinism contract (offline render bit-identical run to run and to the
// realtime path, whatever the device's callback size).
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <memory>
#include <numeric>
#include <random>
#include <vector>

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "audio_types.hpp"
#include "automation.hpp"
#include "dsp_convolver.hpp"
#include "dsp_dynamics.hpp"
#include "dsp_filters.hpp"
#include "dsp_osc.hpp"
#include "effects.hpp"
#include "mixer.hpp"
#include "peaks.hpp"
#include "realtime.hpp"
#include "source_store.hpp"
#include "voice_build.hpp"

using namespace premation::audio;  // NOLINT(google-build-using-namespace)

namespace {

constexpr double kSr = 48000;

std::vector<float> sine(std::size_t n, double hz, double amp = 0.5, double sr = kSr) {
  std::vector<float> v(n);
  for (std::size_t i = 0; i < n; ++i) {
    v[i] = static_cast<float>(amp * std::sin(2 * 3.141592653589793 * hz * static_cast<double>(i) / sr));
  }
  return v;
}

std::vector<float> ramp(std::size_t n) {
  std::vector<float> v(n);
  for (std::size_t i = 0; i < n; ++i) v[i] = static_cast<float>(i) / static_cast<float>(n);
  return v;
}

std::vector<float> noise(std::size_t n, std::uint32_t seed, float amp = 0.3F) {
  std::mt19937 g(seed);
  std::uniform_real_distribution<float> d(-amp, amp);
  std::vector<float> v(n);
  for (auto& x : v) x = d(g);
  return v;
}

std::shared_ptr<SourceData> src_of(std::vector<std::vector<float>> planes) {
  return SourceData::from_planes(planes, kSr);
}

Voice voice_of(std::shared_ptr<SourceData> s, double start = 0, double in = 0, double out = 0) {
  Voice v;
  v.id = "v";
  v.nodeId = "n";
  v.data = std::move(s);
  v.startSec = start;
  v.inSec = in;
  v.outSec = out;
  return v;
}

ProgramPtr program_of(std::vector<Voice> voices, int control = kQuantum, int channels = 2) {
  auto p = std::make_shared<Program>();
  p->format.sampleRate = static_cast<int>(kSr);
  p->format.channels = channels;
  p->voices = std::move(voices);
  p->controlPeriod = control;
  return p;
}

motion_keyframe kf(double t, double v) {
  motion_keyframe k{};
  k.t = t;
  k.value = v;
  k.easing = MOTION_EASING_LINEAR;
  return k;
}

}  // namespace

// ── DSP primitives ──────────────────────────────────────────────────────────

TEST_CASE("biquad: cookbook responses at DC, the corner and Nyquist", "[audio][dsp]") {
  auto mag = [](const dsp::BiquadCoefs& c, double w) {
    // |H(e^{jw})| for b0 + b1 z^-1 + b2 z^-2 over 1 + a1 z^-1 + a2 z^-2.
    const double cr = c.b0 + c.b1 * std::cos(w) + c.b2 * std::cos(2 * w);
    const double ci = -(c.b1 * std::sin(w) + c.b2 * std::sin(2 * w));
    const double dr = 1 + c.a1 * std::cos(w) + c.a2 * std::cos(2 * w);
    const double di = -(c.a1 * std::sin(w) + c.a2 * std::sin(2 * w));
    return std::sqrt((cr * cr + ci * ci) / (dr * dr + di * di));
  };
  const double pi = 3.141592653589793;
  const auto lp = dsp::biquad_coefs(BiquadType::lowpass, kSr, 1000, 0, 0, 0);  // Q in dB: 0 dB resonance
  CHECK(mag(lp, 0) == Catch::Approx(1).epsilon(1e-12));
  CHECK(mag(lp, pi) < 1e-9);
  CHECK(mag(lp, 2 * pi * 1000 / kSr) == Catch::Approx(1.0).epsilon(1e-9));  // 0 dB peak at the corner
  const auto pk = dsp::biquad_coefs(BiquadType::peaking, kSr, 2000, 1, 6, 0);
  CHECK(20 * std::log10(mag(pk, 2 * pi * 2000 / kSr)) == Catch::Approx(6).epsilon(1e-9));
  CHECK(mag(pk, 0) == Catch::Approx(1).epsilon(1e-9));
  const auto ls = dsp::biquad_coefs(BiquadType::lowshelf, kSr, 320, 1, -12, 0);
  CHECK(20 * std::log10(mag(ls, 0)) == Catch::Approx(-12).epsilon(1e-9));
  const auto hs = dsp::biquad_coefs(BiquadType::highshelf, kSr, 3200, 1, 9, 0);
  CHECK(20 * std::log10(mag(hs, pi)) == Catch::Approx(9).epsilon(1e-9));
  // Detune: +1200 cents doubles the frequency.
  const auto a = dsp::biquad_coefs(BiquadType::bandpass, kSr, 1000, 2, 0, 1200);
  const auto b = dsp::biquad_coefs(BiquadType::bandpass, kSr, 2000, 2, 0, 0);
  CHECK(a.b0 == Catch::Approx(b.b0).epsilon(1e-12));
  CHECK(a.a1 == Catch::Approx(b.a1).epsilon(1e-12));
  // Edge cases of the spec: lowpass at Nyquist is a wire, bandpass at 0 is silence.
  const auto lpN = dsp::biquad_coefs(BiquadType::lowpass, kSr, kSr / 2, 0, 0, 0);
  CHECK(lpN.b0 == 1);
  CHECK(lpN.a1 == 0);
  const auto bp0 = dsp::biquad_coefs(BiquadType::bandpass, kSr, 0, 1, 0, 0);
  CHECK(bp0.b0 == 0);
}

TEST_CASE("delay line: integer and fractional delays, zero delay is a wire", "[audio][dsp]") {
  dsp::DelayLine d(1.0, kSr);
  std::vector<float> out;
  for (int i = 0; i < 20; ++i) out.push_back(d.process(i == 3 ? 1.0F : 0.0F, 5));
  CHECK(out[8] == 1.0F);
  CHECK(std::count(out.begin(), out.end(), 0.0F) == 19);
  dsp::DelayLine f(1.0, kSr);
  std::vector<float> o2;
  for (int i = 0; i < 20; ++i) o2.push_back(f.process(i == 3 ? 1.0F : 0.0F, 5.25));
  CHECK(o2[8] == Catch::Approx(0.75));
  CHECK(o2[9] == Catch::Approx(0.25));
  dsp::DelayLine z(1.0, kSr);
  CHECK(z.process(0.5F, 0) == 0.5F);
}

TEST_CASE("stereo panner: the spec's equal-power law, mono and stereo input", "[audio][dsp]") {
  float l = 0;
  float r = 0;
  dsp::pan_mono(1.0F, 0, l, r);
  CHECK(l == Catch::Approx(std::sqrt(0.5)));
  CHECK(r == Catch::Approx(std::sqrt(0.5)));
  dsp::pan_mono(1.0F, -1, l, r);
  CHECK(l == Catch::Approx(1));
  CHECK(std::fabs(r) < 1e-7);
  // Stereo, pan ≤ 0: L = inL + inR·cos(x), R = inR·sin(x), x = (p + 1)·π/2.
  dsp::pan_stereo(0.5F, 0.25F, -0.5, l, r);
  const double x = 0.5 * 3.141592653589793 / 2;
  CHECK(l == Catch::Approx(0.5 + 0.25 * std::cos(x)));
  CHECK(r == Catch::Approx(0.25 * std::sin(x)));
  // Centre on stereo input is a wire.
  dsp::pan_stereo(0.5F, 0.25F, 0, l, r);
  CHECK(l == Catch::Approx(0.5 + 0.25 * std::cos(3.141592653589793 / 2)).margin(1e-7));
  CHECK(r == Catch::Approx(0.25));
}

TEST_CASE("convolver: partitioned result equals direct convolution", "[audio][dsp]") {
  const std::vector<float> ir = noise(9000, 7, 0.1F);  // head + tail stages
  const std::vector<float> x = noise(16384, 11, 0.5F);
  auto k = std::make_shared<const dsp::ConvolverKernel>(std::span<const float>(ir));
  dsp::Convolver conv(k);
  std::vector<float> y(x.size());
  for (std::size_t i = 0; i < x.size(); i += 128) conv.process(x.data() + i, y.data() + i);
  double maxErr = 0;
  for (std::size_t n = 0; n < x.size(); n += 97) {
    double ref = 0;
    for (std::size_t j = 0; j < ir.size() && j <= n; ++j) ref += static_cast<double>(ir[j]) * x[n - j];
    maxErr = std::max(maxErr, std::fabs(ref - y[n]));
  }
  INFO("max |partitioned − direct| = " << maxErr);
  CHECK(maxErr < 2e-5);
}

TEST_CASE("oscillator: band-limited sine is a sine; square has odd harmonics only", "[audio][dsp]") {
  auto w = dsp::periodic_wave(Wave::sine, kSr);
  dsp::Oscillator o(w);
  double maxErr = 0;
  for (int i = 0; i < 4800; ++i) {
    const double ref = std::sin(2 * 3.141592653589793 * 440 * i / kSr);
    maxErr = std::max(maxErr, std::fabs(ref - o.tick(440)));
  }
  CHECK(maxErr < 2e-5);
  auto sq = dsp::periodic_wave(Wave::square, kSr);
  dsp::Oscillator s(sq);
  double peak = 0;
  for (int i = 0; i < 48000; ++i) peak = std::max(peak, static_cast<double>(std::fabs(s.tick(100))));
  // Normalised to the full-band table's peak; at 100 Hz a band-limited table
  // with fewer partials (less Gibbs overshoot) is read, so the peak is < 1.
  CHECK(peak > 0.9);
  CHECK(peak <= 1.0);
}

TEST_CASE("compressor: steady reduction above threshold, transparent below", "[audio][dsp]") {
  dsp::Compressor c(kSr, 2);
  dsp::CompressorParams p;  // DynamicsCompressorNode defaults: −24 dB, knee 30, ratio 12
  const std::vector<float> loud = sine(48000, 1000, 0.9);
  std::vector<float> outL(loud.size()), outR(loud.size());
  for (std::size_t i = 0; i < loud.size(); i += 32) {
    std::array<const float*, 2> in{loud.data() + i, loud.data() + i};
    std::array<float*, 2> out{outL.data() + i, outR.data() + i};
    c.process_division(in.data(), out.data(), 32, p);
  }
  float pk = 0;
  for (std::size_t i = 40000; i < outL.size(); ++i) pk = std::max(pk, std::fabs(outL[i]));
  CHECK(pk < 0.9F);  // compressed (makeup gain included)
  CHECK(c.reduction_db() < -3);
}

TEST_CASE("limiter: never exceeds the ceiling, delays by its look-ahead", "[audio][dsp]") {
  dsp::Limiter lim(kSr, 2, -1.0, 50, 72);
  std::vector<float> l = sine(48000, 200, 1.6);
  std::vector<float> r = l;
  std::array<float*, 2> io{l.data(), r.data()};
  for (std::size_t i = 0; i < l.size(); i += 128) {
    std::array<float*, 2> blk{io[0] + i, io[1] + i};
    lim.process(blk.data(), 128);
  }
  const float ceiling = static_cast<float>(std::pow(10, -1.0 / 20));
  float pk = 0;
  for (const float v : l) pk = std::max(pk, std::fabs(v));
  CHECK(pk <= ceiling * 1.0000001F);
  CHECK(lim.latency() == 72);
}

TEST_CASE("TS ports: distortion curve shapes and the white-noise hash", "[audio][dsp]") {
  const auto soft0 = distortion_curve(DistortionShape::softClip, 0, 16);
  CHECK(soft0.front() == -1.0F);
  CHECK(soft0.back() == 1.0F);
  CHECK(soft0[1023] == Catch::Approx(-1.0 / 2047).margin(1e-7));  // a wire at zero drive
  const auto crushed = distortion_curve(DistortionShape::hardClip, 50, 2);
  for (const float v : crushed) {
    const float q = (v + 1) / 2 * 3;
    CHECK(std::fabs(q - std::round(q)) < 1e-5F);  // 2 bits → 4 levels
  }
  const auto n = dsp::noise_buffer(kSr, 12345);
  REQUIRE(n.size() == 48000);
  for (const float v : n) CHECK((v >= -1 && v < 1));
  // Seeded: the same seed, the same buffer.
  CHECK(dsp::noise_buffer(kSr, 12345) == n);
  CHECK(dsp::hash_id("") == 2166136261U);
}

// ── Mixer ───────────────────────────────────────────────────────────────────

TEST_CASE("mixer: level dB → gain (−60 floor), mono up-mix, trims, sums", "[audio][mixer]") {
  const auto s = src_of({std::vector<float>(48000, 0.5F)});
  Voice v = voice_of(s, 0, 0, 1);
  v.levelDb = ParamCurve::constant(-6);
  auto out = render_offline(program_of({v}), 0, 256);
  const float g = static_cast<float>(std::pow(10.0, -6.0 / 20));
  CHECK(out[0][10] == 0.5F * g);
  CHECK(out[1][10] == 0.5F * g);
  CHECK(level_db_to_gain(-60) == 0);
  CHECK(level_db_to_gain(-59.9) > 0);
  v.levelDb = ParamCurve::constant(-60);
  CHECK(render_offline(program_of({v}), 0, 256)[0][10] == 0);
  // Two voices sum; a muted one contributes nothing.
  Voice a = voice_of(s, 0, 0, 1);
  Voice b = voice_of(s, 0, 0, 1);
  Voice m = voice_of(s, 0, 0, 1);
  m.muted = true;
  out = render_offline(program_of({a, b, m}), 0, 256);
  CHECK(out[0][100] == 1.0F);
}

TEST_CASE("mixer: bar timing and source offsets are sample exact", "[audio][mixer]") {
  const auto s = src_of({ramp(48000)});
  // Bar at 0.5 s, reading from 0.25 s of the source, 0.1 s long.
  Voice v = voice_of(s, 0.5, 0.25, 0.35);
  auto out = render_offline(program_of({v}), 0, 48000);
  CHECK(out[0][23999] == 0);
  CHECK(out[0][24000] == s->at(0, 12000));
  CHECK(out[0][24000 + 4799] == s->at(0, 12000 + 4799));
  CHECK(out[0][24000 + 4800] == 0);  // the bar ended
  // Rendering a window that starts inside the bar gives the same samples.
  auto mid = render_offline(program_of({v}), 25000, 1000);
  for (int i = 0; i < 1000; ++i) CHECK(mid[0][static_cast<std::size_t>(i)] == out[0][static_cast<std::size_t>(25000 + i)]);
}

TEST_CASE("mixer: varispeed reads rate × comp time with linear interpolation", "[audio][mixer]") {
  const auto s = src_of({ramp(48000)});
  Voice v = voice_of(s, 0, 0, 0.5);
  v.playbackRate = 0.5;
  auto out = render_offline(program_of({v}), 0, 2000);
  // Frame n reads source position n·0.5: the midpoint of two ramp samples.
  CHECK(out[0][101] == static_cast<float>(0.5 * s->at(0, 50) + 0.5 * s->at(0, 51)));
  CHECK(out[0][100] == s->at(0, 50));
  v.playbackRate = 2;
  out = render_offline(program_of({v}), 0, 2000);
  CHECK(out[0][300] == s->at(0, 600));
}

TEST_CASE("mixer: reverse plays the bar's source window backwards", "[audio][mixer]") {
  const auto s = src_of({ramp(4800)});
  // Bar of 0.05 s reading source [0.01, 0.06): reversed, frame 0 hears sample
  // 2879 (the window's last), frame k hears 2879 − k.
  Voice v = voice_of(s, 0, 0.01, 0.06);
  v.reverse = true;
  auto out = render_offline(program_of({v}), 0, 2400);
  CHECK(out[0][0] == s->at(0, 2879));
  CHECK(out[0][100] == s->at(0, 2779));
  CHECK(out[0][2399] == s->at(0, 480));
}

TEST_CASE("mixer: open-ended voice plays to the source's end; loop wraps", "[audio][mixer]") {
  const auto s = src_of({std::vector<float>(1000, 0.25F)});
  Voice v = voice_of(s, 0, 0, 0);  // outSec 0 = to the end of the file
  auto out = render_offline(program_of({v}), 0, 2000);
  CHECK(out[0][999] == 0.25F);
  CHECK(out[0][1000] == 0);
  Voice l = voice_of(src_of({ramp(1000)}), 0, 0, 2000.0 / kSr);
  l.loop = true;
  out = render_offline(program_of({l}), 0, 2000);
  CHECK(out[0][1500] == out[0][500]);
}

TEST_CASE("mixer: pan law on mono and stereo voices", "[audio][mixer]") {
  const auto mono = src_of({std::vector<float>(4800, 0.5F)});
  Voice v = voice_of(mono, 0, 0, 0.1);
  v.panner = true;
  v.pan = ParamCurve::constant(100);  // hard right
  auto out = render_offline(program_of({v}), 0, 256);
  CHECK(std::fabs(out[0][10]) < 1e-7F);
  CHECK(out[1][10] == Catch::Approx(0.5));
  const auto st = src_of({std::vector<float>(4800, 0.5F), std::vector<float>(4800, 0.25F)});
  Voice w = voice_of(st, 0, 0, 0.1);
  w.panner = true;
  w.pan = ParamCurve::constant(-100);  // hard left: L = inL + inR, R = 0
  out = render_offline(program_of({w}), 0, 256);
  CHECK(out[0][10] == Catch::Approx(0.75));
  CHECK(std::fabs(out[1][10]) < 1e-7F);
}

TEST_CASE("automation: keyframed level is sampled on the grid and ramped per sample", "[audio][mixer]") {
  const auto s = src_of({std::vector<float>(48000, 1.0F)});
  Voice v = voice_of(s, 0, 0, 1);
  v.levelDb = ParamCurve::keyframes({kf(0, 0), kf(1, -20)}, 0);
  auto out = render_offline(program_of({v}, 960), 0, 48000);
  // Grid points (every 960 frames) carry the curve's value exactly…
  for (int g = 0; g < 50; ++g) {
    const double db = -20.0 * g * 960 / 48000;
    CHECK(out[0][static_cast<std::size_t>(g * 960)] == static_cast<float>(std::pow(10.0, db / 20)));
  }
  // …and samples between them are the linear ramp of the two gains.
  const auto g0 = static_cast<double>(static_cast<float>(std::pow(10.0, -20.0 * 960 / 48000 / 20)));
  const auto g1 = static_cast<double>(static_cast<float>(std::pow(10.0, -20.0 * 1920 / 48000 / 20)));
  CHECK(out[0][960 + 480] == static_cast<float>(g0 + (g1 - g0) * 0.5));
  // Monotonic and click-free.
  for (std::size_t i = 1; i < 48000; ++i) CHECK(out[0][i] <= out[0][i - 1]);
}

TEST_CASE("determinism: offline renders are bit-identical, and equal the realtime path", "[audio][determinism]") {
  const auto s1 = src_of({noise(96000, 3), noise(96000, 4)});
  const auto s2 = src_of({sine(96000, 330, 0.4)});
  Voice a = voice_of(s1, 0, 0, 2);
  EffectSpec eq;
  eq.id = "eq1";
  eq.type = EffectType::parametricEq;
  eq.params = {{"frequency", 800}, {"gain", 9}, {"q", 2}};
  EffectSpec rv;
  rv.id = "rv1";
  rv.type = EffectType::reverb;
  rv.params = {{"decay", 0.5}, {"mix", 35}};
  a.effects = {eq, rv};
  a.levelDb = ParamCurve::keyframes({kf(0, -12), kf(1.5, 0)}, 0);
  Voice b = voice_of(s2, 0.3, 0.1, 1.9);
  EffectSpec fl;
  fl.id = "fl1";
  fl.type = EffectType::flangeChorus;
  fl.params = {{"voices", 3}, {"mix", 60}};
  EffectSpec cp;
  cp.id = "cp1";
  cp.type = EffectType::compressor;
  cp.params = {{"threshold", -30}, {"outputLimit", -3}};
  b.effects = {fl, cp};
  b.panner = true;
  b.pan = ParamCurve::keyframes({kf(0, -80), kf(2, 80)}, 0);
  auto prog = program_of({a, b});
  const auto r1 = render_offline(prog, 0, 96000);
  const auto r2 = render_offline(prog, 0, 96000);
  REQUIRE(r1 == r2);

  // Realtime: the same program through RealtimeEngine with ragged callback
  // sizes. After play's 5 ms fade-in, every sample equals the offline mix.
  RealtimeEngine rt(prog->format);
  rt.install(std::make_unique<RenderPlan>(prog));
  rt.play(0, 1, LoopMode::loop, 0, 1'000'000);
  std::mt19937 g(5);
  std::uniform_int_distribution<int> sizes(1, 1024);
  std::vector<float> inter;
  std::int64_t written = 0;
  while (written < 96000) {
    const int n = sizes(g);
    std::vector<float> buf(static_cast<std::size_t>(n) * 2);
    rt.process(buf.data(), static_cast<std::uint32_t>(n), written, static_cast<double>(written) / kSr, written);
    inter.insert(inter.end(), buf.begin(), buf.end());
    written += n;
  }
  std::size_t mismatches = 0;
  for (std::size_t i = 240; i < 96000; ++i) {
    if (inter[i * 2] != r1[0][i] || inter[i * 2 + 1] != r1[1][i]) ++mismatches;
  }
  CHECK(mismatches == 0);
}

TEST_CASE("effects: every built-in type renders finite, bounded audio", "[audio][effects]") {
  const auto s = src_of({sine(48000, 220, 0.5), sine(48000, 330, 0.5)});
  const std::vector<EffectType> types{EffectType::parametricEq, EffectType::bassTreble,   EffectType::highLowPass,
                                      EffectType::delay,        EffectType::reverb,       EffectType::flangeChorus,
                                      EffectType::tone,         EffectType::modulator,    EffectType::stereoMixer,
                                      EffectType::compressor,   EffectType::distortion,   EffectType::deEsser,
                                      EffectType::backwards};
  for (const EffectType t : types) {
    Voice v = voice_of(s, 0, 0, 1);
    EffectSpec fx;
    fx.id = "fx";
    fx.type = t;
    fx.flags = {"swapChannels", "stereoVoices"};
    v.effects = {fx};
    const auto out = render_offline(program_of({v}), 0, 48000);
    bool finite = true;
    float pk = 0;
    for (const auto& ch : out) {
      for (const float x : ch) {
        finite = finite && std::isfinite(x);
        pk = std::max(pk, std::fabs(x));
      }
    }
    INFO("effect " << static_cast<int>(t) << " peak " << pk);
    CHECK(finite);
    // The reverb's IR is generated un-normalised (as the TS does, normalize =
    // false), so a coherent tone through its default 1.8 s tail gets loud.
    CHECK(pk < 50.0F);
    CHECK(pk > 1e-4F);
  }
}

// ── Peaks ───────────────────────────────────────────────────────────────────

TEST_CASE("peaks: pyramid queries equal waveform.ts computePeaks exactly", "[audio][peaks]") {
  const auto s = src_of({noise(300'000, 21, 0.9F), noise(300'000, 22, 0.7F)});
  // The TS envelope: mono = the float average, computePeaks over it.
  std::vector<float> mono(300'000);
  for (std::size_t i = 0; i < mono.size(); ++i) {
    mono[i] = static_cast<float>((static_cast<double>(s->at(0, static_cast<std::int64_t>(i))) +
                                  static_cast<double>(s->at(1, static_cast<std::int64_t>(i)))) / 2);
  }
  auto ts_peaks = [&](std::size_t from, std::size_t len, std::size_t buckets) {
    std::vector<float> out(buckets);
    const double per = static_cast<double>(len) / static_cast<double>(buckets);
    for (std::size_t b = 0; b < buckets; ++b) {
      const auto st = static_cast<std::size_t>(std::floor(static_cast<double>(b) * per));
      const std::size_t en = std::min(len, std::max(st + 1, static_cast<std::size_t>(std::floor(static_cast<double>(b + 1) * per))));
      float pk = 0;
      for (std::size_t i = st; i < en; ++i) pk = std::max(pk, std::fabs(mono[from + i]));
      out[b] = pk > 1 ? 1 : pk;
    }
    return out;
  };
  for (const auto& [fromF, lenF, buckets] : std::vector<std::tuple<std::size_t, std::size_t, std::uint32_t>>{
           {0, 300'000, 1024}, {12345, 200'000, 333}, {777, 4000, 100}, {0, 300'000, 7}}) {
    const auto r = query_peaks(*s, static_cast<double>(fromF) / kSr, static_cast<double>(lenF) / kSr, buckets, true);
    const auto env = ts_envelope(r);
    CHECK(env == ts_peaks(fromF, lenF, buckets));
  }
  // Per-channel min/max from the pyramid match a brute-force scan.
  const auto r = query_peaks(*s, 0, 300'000 / kSr, 64, false);
  REQUIRE(r.channels == 2);
  float mn = 1;
  float mx = -1;
  for (std::size_t i = 0; i < 300'000 / 64; ++i) {
    mn = std::min(mn, s->at(1, static_cast<std::int64_t>(i)));
    mx = std::max(mx, s->at(1, static_cast<std::int64_t>(i)));
  }
  CHECK(r.peaks[2] == mn);
  CHECK(r.peaks[3] == mx);
}

// ── Voice building ──────────────────────────────────────────────────────────

TEST_CASE("voice building: retime segments and nested placement follow the TS", "[audio][voices]") {
  ClipTiming bar{"c1", true, 1.0, 0.0, 2.0};
  // A linear remap at 2× → one segment, rate 2, from source 0.
  auto segs = retime_segments([](double t) { return (t - 1.0) * 2; }, bar, 30);
  REQUIRE(segs.size() == 1);
  CHECK(segs[0].rate == Catch::Approx(2));
  CHECK(segs[0].inSec == Catch::Approx(0));
  CHECK(segs[0].durationSec == Catch::Approx(2));
  // A freeze (hold) → silence.
  CHECK(retime_segments([](double) { return 3.0; }, bar, 30).empty());
  // Reverse at 1×. The TS merge keeps the FIRST sub-segment's inSec — for a
  // reverse run that is the upper end minus one frame (4.967), not the run's
  // lower end (3), so the reversed voice reads [4.97, 6.97) instead of [3, 5).
  // A TS bug, ported as is so both engines agree (see native/README.md
  // "Audio (E2)"; fix both sides together: take the LAST pair's b.s).
  segs = retime_segments([](double t) { return 5.0 - (t - 1.0); }, bar, 30);
  REQUIRE(segs.size() == 1);
  CHECK(segs[0].reverse);
  CHECK(segs[0].inSec == Catch::Approx(5.0 - 1.0 / 30));
  // Nested, plain instance: inner voice at inner 0.5 s, the bar shows inner
  // [1, 3) at host 10 s → host 10 s, reading 0.5 s into the inner voice.
  Voice inner;
  inner.id = "iv";
  inner.startSec = 0.5;
  inner.inSec = 0;
  inner.outSec = 2;
  inner.levelDb = ParamCurve::keyframes({kf(0, -6), kf(1, 0)}, -3);
  const auto placed = place_nested("inst", {inner}, {{"bar", true, 10, 1, 3}}, false, nullptr, 30, false);
  REQUIRE(placed.size() == 1);
  CHECK(placed[0].startSec == Catch::Approx(10));
  CHECK(placed[0].inSec == Catch::Approx(0.5));
  CHECK(placed[0].outSec - placed[0].inSec == Catch::Approx(1.5));
  CHECK_FALSE(placed[0].levelDb.animated());  // nested voices use their static level
  CHECK(placed[0].id == "inst::bar::iv");
}
