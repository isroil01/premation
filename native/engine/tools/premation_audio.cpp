// premation-audio — the E2 audio engine's bench, device smoke test and
// render tool.
//
//   premation-audio bench [--seconds S]
//       Offline mix throughput per effect and for busy mixes: × realtime and
//       µs per 128-frame quantum (one core).
//   premation-audio smoke [--seconds S] [--period-ms P]
//       Plays a generated tone mix on the DEFAULT OUTPUT DEVICE through the
//       realtime engine and measures the device clock against the wall clock:
//       callback cadence, the device's real rate (ppm vs nominal, by least
//       squares over frames-played vs time), buffer depth / latency, and the
//       playhead's smoothness (monotonic, residual jitter).
//   premation-audio render <input> <out.wav> [--level dB] [--seconds S]
//       Conform a file and render it through the offline mixer to a WAV.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "audio_system.hpp"
#include "device.hpp"
#include "mixer.hpp"
#include "realtime.hpp"
#include "source_store.hpp"

using namespace premation::audio;  // NOLINT(google-build-using-namespace)

namespace {

constexpr int kSr = 48000;

double arg_num(int argc, char** argv, const char* name, double fallback) {
  for (int i = 0; i + 1 < argc; ++i) {
    if (std::strcmp(argv[i], name) == 0) return std::atof(argv[i + 1]);
  }
  return fallback;
}

std::shared_ptr<SourceData> gen_source(int kind, double seconds) {
  const auto n = static_cast<std::size_t>(seconds * kSr);
  std::vector<std::vector<float>> p(2, std::vector<float>(n));
  std::uint32_t x = 0x12345U + static_cast<std::uint32_t>(kind);
  for (std::size_t i = 0; i < n; ++i) {
    const double t = static_cast<double>(i) / kSr;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    const double r = (static_cast<double>(x) / 4294967296.0) * 2 - 1;
    switch (kind) {
      case 0:
        p[0][i] = static_cast<float>(0.25 * std::sin(2 * 3.141592653589793 * 440 * t));
        p[1][i] = static_cast<float>(0.25 * std::sin(2 * 3.141592653589793 * 660 * t));
        break;
      case 1:
        p[0][i] = static_cast<float>(0.15 * r);
        p[1][i] = static_cast<float>(0.15 * r);
        break;
      default:
        p[0][i] = static_cast<float>(0.2 * std::sin(2 * 3.141592653589793 * 220 * t) * (0.5 + 0.5 * std::sin(2 * 3.141592653589793 * 2 * t)));
        p[1][i] = p[0][i];
        break;
    }
  }
  return SourceData::from_planes(p, kSr);
}

EffectSpec fx(const char* id, EffectType t, std::vector<std::pair<std::string, double>> params = {}) {
  EffectSpec e;
  e.id = id;
  e.type = t;
  e.params = std::move(params);
  return e;
}

void write_wav(const std::string& path, const std::vector<std::vector<float>>& planes, int sr) {
  const auto ch = static_cast<std::uint16_t>(planes.size());
  const auto frames = static_cast<std::uint32_t>(planes.empty() ? 0 : planes[0].size());
  std::ofstream f(path, std::ios::binary);
  auto u32 = [&](std::uint32_t v) { f.write(reinterpret_cast<const char*>(&v), 4); };  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  auto u16 = [&](std::uint16_t v) { f.write(reinterpret_cast<const char*>(&v), 2); };  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::uint32_t data = frames * ch * 2;
  f.write("RIFF", 4);
  u32(36 + data);
  f.write("WAVEfmt ", 8);
  u32(16);
  u16(1);
  u16(ch);
  u32(static_cast<std::uint32_t>(sr));
  u32(static_cast<std::uint32_t>(sr) * ch * 2);
  u16(static_cast<std::uint16_t>(ch * 2));
  u16(16);
  f.write("data", 4);
  u32(data);
  for (std::uint32_t i = 0; i < frames; ++i) {
    for (std::uint16_t c = 0; c < ch; ++c) {
      const float s = std::max(-1.0F, std::min(1.0F, planes[c][i]));
      u16(static_cast<std::uint16_t>(static_cast<std::int16_t>(s < 0 ? s * 32768.0F : s * 32767.0F)));
    }
  }
}

int bench(double seconds) {
  const auto src = gen_source(1, seconds + 1);
  const auto frames = static_cast<std::int64_t>(seconds * kSr);
  struct Row {
    const char* name;
    std::vector<EffectSpec> fx;
    int voices;
  };
  const std::vector<Row> rows{
      {"1 voice, no effects", {}, 1},
      {"parametric-eq (3 bands)", {fx("e", EffectType::parametricEq, {{"gain", 6}, {"gain2", -4}, {"gain3", 3}})}, 1},
      {"bass-treble", {fx("b", EffectType::bassTreble, {{"bass", 6}})}, 1},
      {"delay", {fx("d", EffectType::delay)}, 1},
      {"reverb 1.8 s", {fx("r", EffectType::reverb)}, 1},
      {"reverb 10 s", {fx("r10", EffectType::reverb, {{"decay", 10}})}, 1},
      {"flange-chorus 4 voices", {fx("f", EffectType::flangeChorus, {{"voices", 4}})}, 1},
      {"tone (2 oscillators)", {fx("t", EffectType::tone, {{"frequency2", 660}})}, 1},
      {"modulator + FM", {fx("m", EffectType::modulator, {{"fmDepth", 40}})}, 1},
      {"stereo-mixer", {fx("s", EffectType::stereoMixer)}, 1},
      {"compressor + limiter", {fx("c", EffectType::compressor, {{"outputLimit", -3}})}, 1},
      {"distortion (4x oversampled)", {fx("x", EffectType::distortion)}, 1},
      {"de-esser", {fx("z", EffectType::deEsser)}, 1},
      {"32 voices, no effects", {}, 32},
      {"32 voices, EQ + compressor", {fx("e", EffectType::parametricEq, {{"gain", 6}}), fx("c", EffectType::compressor)}, 32},
      {"8 voices, EQ + comp + reverb", {fx("e", EffectType::parametricEq, {{"gain", 6}}), fx("c", EffectType::compressor), fx("r", EffectType::reverb)}, 8},
  };
  std::printf("%-32s %12s %14s\n", "case (48 kHz stereo)", "x realtime", "us / quantum");
  for (const Row& r : rows) {
    auto p = std::make_shared<Program>();
    p->format = {kSr, 2};
    for (int v = 0; v < r.voices; ++v) {
      Voice voice;
      voice.id = "v" + std::to_string(v);
      voice.data = src;
      voice.outSec = seconds;
      voice.levelDb = ParamCurve::constant(-12);
      voice.effects = r.fx;
      p->voices.push_back(voice);
    }
    const auto t0 = std::chrono::steady_clock::now();
    const auto out = render_offline(p, 0, frames);
    const double dt = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    const double quanta = static_cast<double>(frames) / kQuantum;
    std::printf("%-32s %12.1f %14.2f\n", r.name, seconds / dt, dt * 1e6 / quanta);
    if (out.empty()) return 1;
  }
  return 0;
}

int smoke(double seconds, int periodMs) {
  const MixFormat fmt{kSr, 2};
  RealtimeEngine rt(fmt);
  auto p = std::make_shared<Program>();
  p->format = fmt;
  const double len = seconds + 2;
  Voice a;
  a.id = "tone";
  a.data = gen_source(0, len);
  a.outSec = len;
  a.levelDb = ParamCurve::constant(-6);
  Voice b;
  b.id = "pad";
  b.data = gen_source(2, len);
  b.outSec = len;
  b.effects = {fx("rv", EffectType::reverb, {{"decay", 1.2}, {"mix", 30}})};
  b.panner = true;
  b.pan = ParamCurve::constant(-40);
  Voice c;
  c.id = "hiss";
  c.data = gen_source(1, len);
  c.outSec = len;
  c.levelDb = ParamCurve::constant(-24);
  c.effects = {fx("eq", EffectType::highLowPass, {{"cutoff", 4000}}), fx("cmp", EffectType::compressor)};
  p->voices = {a, b, c};
  p->master.limiter = true;
  rt.install(std::make_unique<RenderPlan>(p));

  struct Cb {
    double t;
    std::int64_t written, played;
    std::uint32_t frames;
    double renderUs;
  };
  std::vector<Cb> cbs;
  cbs.reserve(static_cast<std::size_t>(seconds * 2000) + 1000);
  std::atomic<std::size_t> count{0};
  std::string error;
  auto dev = open_default_device(
      DeviceOptions{kSr, 2, periodMs},
      [&](float* out, std::uint32_t frames, std::int64_t written, double t, std::int64_t played) {
        const auto t0 = SteadyClock::now();
        rt.process(out, frames, written, t, played);
        const double us = std::chrono::duration<double, std::micro>(SteadyClock::now() - t0).count();
        const std::size_t k = count.load(std::memory_order_relaxed);
        if (k < cbs.capacity()) {
          cbs.push_back({t, written, played, frames, us});
          count.store(k + 1, std::memory_order_release);
        }
      },
      error);
  if (!dev) {
    std::printf("no output device: %s\n", error.c_str());
    return 2;
  }
  const DeviceInfo& info = dev->info();
  std::printf("device: %s via %s — callback rate %d Hz, device rate %d Hz, %d ch, period %d x %d frames, "
              "reported depth %.1f frames (%.2f ms)\n",
              info.name.c_str(), info.backend.c_str(), info.sampleRate, info.deviceRate, info.channels,
              info.periodFrames, info.periods, info.latencyFrames, info.latencyFrames * 1000.0 / kSr);
  if (!dev->start(error)) {
    std::printf("start failed: %s\n", error.c_str());
    return 2;
  }
  rt.play(0, 1, LoopMode::loop, 0, INT64_MAX);
  struct Sample {
    double wall;
    ClockReading r;
  };
  std::vector<Sample> heads;
  const auto start = SteadyClock::now();
  while (std::chrono::duration<double>(SteadyClock::now() - start).count() < seconds) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    const double now = steady_seconds(SteadyClock::now());
    heads.push_back({now, rt.playhead(now)});
  }
  dev->stop();
  const std::size_t n = count.load(std::memory_order_acquire);
  if (n < 10) {
    std::printf("only %zu callbacks\n", n);
    return 3;
  }
  // Callback cadence.
  std::uint32_t fmin = UINT32_MAX, fmax = 0;
  double imean = 0, imax = 0, rmax = 0, rsum = 0;
  double depthMin = 1e9, depthMax = 0, depthSum = 0;
  for (std::size_t i = 0; i < n; ++i) {
    fmin = std::min(fmin, cbs[i].frames);
    fmax = std::max(fmax, cbs[i].frames);
    rmax = std::max(rmax, cbs[i].renderUs);
    rsum += cbs[i].renderUs;
    const auto depth = static_cast<double>(cbs[i].written - cbs[i].played);
    depthMin = std::min(depthMin, depth);
    depthMax = std::max(depthMax, depth);
    depthSum += depth;
    if (i > 0) {
      const double d = cbs[i].t - cbs[i - 1].t;
      imean += d;
      imax = std::max(imax, d);
    }
  }
  imean /= static_cast<double>(n - 1);
  // Device rate: least squares of frames played vs wall time, skipping the
  // first second (start-up), in ppm against the nominal rate.
  const std::size_t from = std::min(n / 4, static_cast<std::size_t>(1.0 / std::max(1e-3, imean)));
  double st = 0, sp = 0, stt = 0, stp = 0;
  const double t0 = cbs[from].t;
  const auto p0 = static_cast<double>(cbs[from].played);
  for (std::size_t i = from; i < n; ++i) {
    const double x = cbs[i].t - t0;
    const double y = static_cast<double>(cbs[i].played) - p0;
    st += x;
    sp += y;
    stt += x * x;
    stp += x * y;
  }
  const auto m = static_cast<double>(n - from);
  const double slope = (m * stp - st * sp) / (m * stt - st * st);
  const double ppm = (slope / kSr - 1) * 1e6;
  // Playhead: while playing and locked, compSec vs wall — monotonic, rate, jitter.
  std::vector<std::pair<double, double>> ph;
  for (const Sample& s : heads) {
    if (s.r.playing && s.r.locked) ph.emplace_back(s.wall, s.r.compSec);
  }
  std::size_t backwards = 0;
  for (std::size_t i = 1; i < ph.size(); ++i) backwards += ph[i].second < ph[i - 1].second ? 1 : 0;
  double fitA = 0, fitB = 0, maxRes = 0, ssRes = 0;
  if (ph.size() > 2) {
    double sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const auto& [x, y] : ph) {
      sx += x - ph[0].first;
      sy += y;
      sxx += (x - ph[0].first) * (x - ph[0].first);
      sxy += (x - ph[0].first) * y;
    }
    const auto k = static_cast<double>(ph.size());
    fitB = (k * sxy - sx * sy) / (k * sxx - sx * sx);
    fitA = (sy - fitB * sx) / k;
    for (const auto& [x, y] : ph) {
      const double r = y - (fitA + fitB * (x - ph[0].first));
      maxRes = std::max(maxRes, std::fabs(r));
      ssRes += r * r;
    }
    ssRes = std::sqrt(ssRes / k);
  }
  const ClockReading last = heads.back().r;
  std::printf("callbacks: %zu, frames/callback %u..%u, interval mean %.3f ms max %.3f ms, render mean %.1f us max %.1f us\n",
              n, fmin, fmax, imean * 1000, imax * 1000, rsum / static_cast<double>(n), rmax);
  std::printf("device clock vs wall: %.1f ppm (%.3f frames/s measured over %.2f s)\n", ppm, slope,
              cbs[n - 1].t - t0);
  std::printf("buffer depth (written - played): min %.0f, mean %.0f, max %.0f frames = %.2f / %.2f / %.2f ms\n",
              depthMin, depthSum / static_cast<double>(n), depthMax, depthMin * 1000 / kSr,
              depthSum / static_cast<double>(n) * 1000 / kSr, depthMax * 1000 / kSr);
  std::printf("playhead: %zu reads, %zu backwards steps, rate vs wall %.6f (%+.1f ppm), residual jitter rms %.3f ms max %.3f ms\n",
              ph.size(), backwards, fitB, (fitB - 1) * 1e6, ssRes * 1000, maxRes * 1000);
  std::printf("final playhead %.4f s (media elapsed %.4f s) after %.3f s wall; underruns %llu\n", last.compSec,
              last.mediaElapsedSec, seconds, static_cast<unsigned long long>(rt.underruns()));
  return backwards == 0 ? 0 : 4;
}

int render(const std::string& in, const std::string& out, double levelDb, double seconds) {
  AudioSystem sys(AudioSystemOptions{{kSr, 2}, 2, false, 10});
  std::string error;
  const std::uint64_t id = sys.open_source(in, error);
  if (id == 0) {
    std::printf("open: %s\n", error.c_str());
    return 1;
  }
  const SourcePtr s = sys.source(id);
  if (!s) {
    std::printf("no audio in %s\n", in.c_str());
    return 1;
  }
  s->wait_for(INT64_MAX);
  Program p;
  Voice v;
  v.id = "v";
  v.source = id;
  v.levelDb = ParamCurve::constant(levelDb);
  p.voices.push_back(v);
  const double dur = seconds > 0 ? seconds : static_cast<double>(s->total_frames()) / kSr;
  const auto t0 = std::chrono::steady_clock::now();
  const auto planes = sys.render(p, 0, static_cast<std::int64_t>(dur * kSr));
  const double dt = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  write_wav(out, planes, kSr);
  std::printf("rendered %.2f s in %.3f s → %s\n", dur, dt, out.c_str());
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::printf("usage: premation-audio bench|smoke|render …\n");
    return 1;
  }
  const std::string cmd = argv[1];
  if (cmd == "bench") return bench(arg_num(argc, argv, "--seconds", 10));
  if (cmd == "smoke") return smoke(arg_num(argc, argv, "--seconds", 5), static_cast<int>(arg_num(argc, argv, "--period-ms", 10)));
  if (cmd == "render" && argc >= 4) {
    return render(argv[2], argv[3], arg_num(argc, argv, "--level", 0), arg_num(argc, argv, "--seconds", 0));
  }
  std::printf("usage: premation-audio bench|smoke|render …\n");
  return 1;
}
