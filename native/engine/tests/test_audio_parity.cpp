// E2 parity: the C++ mixer against the TypeScript offline mix.
//
// tests/data/audio_parity.bin is written by gen_audio_parity.mjs, which runs
// the REAL src/core/audio/audioMixdown.ts `mixdownBuffer` in Electron's
// Chromium (OfflineAudioContext) over 36 scenes — gain, pan (mono and stereo
// laws), keyframed level and pan, trims, overlaps, varispeed, reverse, an
// export window that starts mid-voice, and every built-in audio effect incl.
// keyframed effect parameters and a chain. The C++ rebuilds each scene's
// sources bit for bit (motion_jsmath's V8 sin, the same integer xorshift),
// renders it with render_offline, and compares per sample.
//
// Tolerances are stated per scene (max |error| over both channels, and the
// signal-to-error ratio): exact-arithmetic scenes are held to float rounding;
// DSP whose Chromium implementation differs in internals (band-limited
// oscillator tables, Lagrange-interpolated LFOs, FFT reverb, the half-band
// oversamplers) to an SNR floor. The table prints on every run.
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include "effects.hpp"
#include "jsmath.hpp"
#include "mixer.hpp"
#include "source_store.hpp"

using namespace premation::audio;  // NOLINT(google-build-using-namespace)

namespace {

constexpr int kSr = 48000;
constexpr int kSrcFrames = 24000;

struct ParityFile {
  std::string scenes;
  std::map<std::string, std::vector<std::vector<float>>> planes;
};

std::uint32_t rd32(const std::vector<char>& b, std::size_t& o) {
  std::uint32_t v = 0;
  std::memcpy(&v, b.data() + o, 4);
  o += 4;
  return v;
}

bool load(ParityFile& f) {
  std::ifstream in(PREMATION_AUDIO_PARITY, std::ios::binary);
  if (!in) return false;
  const std::vector<char> b((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  if (b.size() < 4 || std::memcmp(b.data(), "PAP1", 4) != 0) return false;
  std::size_t o = 4;
  while (o + 12 <= b.size()) {
    const std::uint32_t nl = rd32(b, o);
    const std::string name(b.data() + o, nl);
    o += nl;
    const std::uint32_t kind = rd32(b, o);
    const std::uint32_t len = rd32(b, o);
    if (kind == 1) {
      f.scenes.assign(b.data() + o, len);
    } else {
      std::size_t p = o;
      const std::uint32_t ch = rd32(b, p);
      const std::uint32_t frames = rd32(b, p);
      std::vector<std::vector<float>> planes(ch, std::vector<float>(frames));
      for (std::uint32_t c = 0; c < ch; ++c) {
        std::memcpy(planes[c].data(), b.data() + p, static_cast<std::size_t>(frames) * 4);
        p += static_cast<std::size_t>(frames) * 4;
      }
      f.planes.emplace(name, std::move(planes));
    }
    o += len;
  }
  return true;
}

// ── Sources, rebuilt exactly as gen_audio_parity_entry.ts makes them ────────

std::vector<std::vector<float>> make_source(const std::string& name) {
  const double pi = 3.141592653589793;
  if (name == "tone") {
    std::vector<float> l(kSrcFrames), r(kSrcFrames);
    for (int i = 0; i < kSrcFrames; ++i) {
      l[static_cast<std::size_t>(i)] = static_cast<float>(0.5 * motion::js::sin(2 * pi * 440 * i / kSr));
      r[static_cast<std::size_t>(i)] = static_cast<float>(0.4 * motion::js::sin(2 * pi * 660 * i / kSr) +
                                                          0.1 * motion::js::sin(2 * pi * 3000 * i / kSr));
    }
    return {l, r};
  }
  if (name == "mono") {
    std::vector<float> m(kSrcFrames);
    for (int i = 0; i < kSrcFrames; ++i) {
      m[static_cast<std::size_t>(i)] = static_cast<float>(0.6 * motion::js::sin(2 * pi * 220 * i / kSr) *
                                                          (0.5 + 0.5 * motion::js::sin(2 * pi * 3 * i / kSr)));
    }
    return {m};
  }
  const std::uint32_t seed = name == "noise" ? 0x9e3779b9U : 0x1234567U;
  const double amp = name == "noise" ? 0.4 : 0.9;
  std::uint32_t x = seed;
  auto next = [&]() {
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    return static_cast<float>((static_cast<double>(x) / 4294967296.0) * 2 * amp - amp);
  };
  std::vector<float> l(kSrcFrames), r(kSrcFrames);
  for (int i = 0; i < kSrcFrames; ++i) {
    l[static_cast<std::size_t>(i)] = next();
    r[static_cast<std::size_t>(i)] = next();
  }
  return {l, r};
}

// ── Scene text → Program ────────────────────────────────────────────────────

std::map<std::string, std::string> fields(const std::string& line) {
  std::map<std::string, std::string> m;
  std::istringstream ss(line);
  std::string tok;
  ss >> tok;  // the record type
  while (ss >> tok) {
    const auto eq = tok.find('=');
    if (eq != std::string::npos) m[tok.substr(0, eq)] = tok.substr(eq + 1);
  }
  return m;
}

std::vector<std::string> split(const std::string& s, char sep) {
  std::vector<std::string> out;
  std::string cur;
  for (const char c : s) {
    if (c == sep) {
      out.push_back(cur);
      cur.clear();
    } else {
      cur += c;
    }
  }
  if (!cur.empty()) out.push_back(cur);
  return out;
}

std::vector<motion_keyframe> keyframes(const std::string& s) {
  std::vector<motion_keyframe> k;
  for (const auto& pair : split(s, ';')) {
    const auto tv = split(pair, ',');
    if (tv.size() != 2) continue;
    motion_keyframe f{};
    f.t = std::stod(tv[0]);
    f.value = std::stod(tv[1]);
    f.easing = MOTION_EASING_LINEAR;
    k.push_back(f);
  }
  return k;
}

EffectType effect_type(const std::string& t) {
  static const std::map<std::string, EffectType> m{
      {"parametric-eq", EffectType::parametricEq}, {"bass-treble", EffectType::bassTreble},
      {"high-low-pass", EffectType::highLowPass},  {"delay", EffectType::delay},
      {"reverb", EffectType::reverb},              {"flange-chorus", EffectType::flangeChorus},
      {"tone", EffectType::tone},                  {"modulator", EffectType::modulator},
      {"stereo-mixer", EffectType::stereoMixer},   {"compressor", EffectType::compressor},
      {"distortion", EffectType::distortion},      {"de-esser", EffectType::deEsser},
      {"backwards", EffectType::backwards}};
  return m.at(t);
}

struct Scene {
  std::string name;
  double start = 0;
  int frames = 0;
  ProgramPtr program;
};

std::vector<Scene> parse(const std::string& text, std::map<std::string, std::shared_ptr<SourceData>>& sources) {
  std::vector<Scene> scenes;
  std::istringstream in(text);
  std::string line;
  std::shared_ptr<Program> prog;
  Scene cur;
  while (std::getline(in, line)) {
    const auto f = fields(line);
    if (line.rfind("scene ", 0) == 0) {
      cur = Scene{};
      std::istringstream ss(line);
      std::string kw;
      ss >> kw >> cur.name;
      cur.start = std::stod(f.at("start"));
      cur.frames = std::stoi(f.at("frames"));
      prog = std::make_shared<Program>();
      prog->format = {kSr, 2};
      prog->controlPeriod = 960;  // the TS ramps at 50 Hz
    } else if (line.rfind("voice ", 0) == 0) {
      Voice v;
      v.id = f.at("id");
      v.nodeId = cur.name + ":" + v.id;
      const std::string src = f.at("src");
      if (!sources.count(src)) sources[src] = SourceData::from_planes(make_source(src), kSr);
      v.data = sources[src];
      v.startSec = std::stod(f.at("start"));
      v.inSec = std::stod(f.at("in"));
      v.outSec = std::stod(f.at("out"));
      v.playbackRate = std::stod(f.at("rate"));
      v.reverse = f.at("reverse") == "1";
      const double level = std::stod(f.at("level"));
      const auto lk = keyframes(f.count("levelkf") ? f.at("levelkf") : "");
      v.levelDb = lk.empty() ? ParamCurve::constant(level) : ParamCurve::keyframes(lk, level);
      const double pan = std::stod(f.at("pan"));
      const auto pk = keyframes(f.count("pankf") ? f.at("pankf") : "");
      v.pan = pk.empty() ? ParamCurve::constant(pan) : ParamCurve::keyframes(pk, pan);
      v.panner = !pk.empty() || pan != 0;
      prog->voices.push_back(std::move(v));
    } else if (line.rfind("fx ", 0) == 0) {
      EffectSpec fx;
      fx.id = f.at("id");
      fx.type = effect_type(f.at("type"));
      fx.lowpass = f.at("mode") == "lowpass";
      const std::string wave = f.at("wave");
      if (wave != "-") {
        fx.hasWave = true;
        fx.wave = wave == "square" ? Wave::square
                  : wave == "sawtooth" ? Wave::sawtooth
                  : wave == "triangle" ? Wave::triangle
                  : wave == "white-noise" ? Wave::whiteNoise
                                          : Wave::sine;
      }
      const std::string curve = f.at("curve");
      fx.shape = curve == "hard-clip" ? DistortionShape::hardClip
                 : curve == "saturation-1" ? DistortionShape::saturation1
                 : curve == "saturation-2" ? DistortionShape::saturation2
                 : curve == "tube" ? DistortionShape::tube
                 : curve == "fuzz" ? DistortionShape::fuzz
                                   : DistortionShape::softClip;
      if (f.at("flags") != "-") fx.flags = split(f.at("flags"), '|');
      if (f.at("params") != "-") {
        for (const auto& kv : split(f.at("params"), ',')) {
          const auto p = kv.find(':');
          fx.params.emplace_back(kv.substr(0, p), std::stod(kv.substr(p + 1)));
        }
      }
      if (f.at("kf") != "-") {
        for (const auto& item : split(f.at("kf"), '|')) {
          const auto at = item.find('@');
          fx.curves.emplace_back(item.substr(0, at), ParamCurve::keyframes(keyframes(item.substr(at + 1)), 0));
        }
      }
      prog->voices.back().effects.push_back(std::move(fx));
    } else if (line == "end") {
      cur.program = prog;
      scenes.push_back(cur);
    }
  }
  return scenes;
}

struct Tol {
  double maxAbs;   // max |C++ − TS| over both channels
  double minSnrDb; // signal / error power
};

/// Stated tolerances. Scenes not listed are held to float rounding.
Tol tolerance(const std::string& scene) {
  // Measured 2026-09-23 against Electron 44 / Chromium 152; each bound is a
  // few times the measured error.
  static const std::map<std::string, Tol> t{
      // IIR filters: coefficient trig and the per-sample a-rate path differ in
      // the last bits (the platform libm vs Chromium's for sin/cos/pow).
      {"eq", {1e-5, 105}},
      {"bass_treble", {1e-5, 100}},
      {"lowpass", {1e-5, 110}},
      {"highpass", {1e-5, 115}},
      {"fx_automation", {1e-4, 85}},
      {"chain_order", {1e-5, 115}},
      // Convolution: FFT partitions vs Chromium's ReverbConvolver.
      {"reverb", {1e-5, 115}},
      {"reverb_long", {2e-5, 115}},
      // Oscillators: Chromium's PeriodicWave reads its tables with 3/5-point
      // Lagrange interpolation at low frequencies (LFOs); linear here. The
      // flanger's feedback loop amplifies the LFO's difference most.
      {"flange", {1e-2, 40}},
      {"chorus", {1e-3, 65}},
      {"tone_sine", {1e-5, 100}},
      {"tone_square", {1e-4, 100}},
      {"modulator_fm", {2e-4, 90}},
      // Wave shaper, 4× oversampled: the curve's slope (fuzz: ×61 at 0)
      // magnifies float rounding in the half-band filters.
      {"distortion_soft", {2e-3, 75}},
      {"distortion_tube_crush", {3e-3, 65}},
      {"distortion_fuzz_mix", {2e-2, 45}},
  };

  auto it = t.find(scene);
  return it != t.end() ? it->second : Tol{1e-6, 120};
}

}  // namespace

TEST_CASE("parity: C++ mix vs the TypeScript offline mix (Chromium Web Audio)", "[audio][parity]") {
  ParityFile file;
  if (!load(file)) {
    WARN("tests/data/audio_parity.bin missing — run: node native/engine/tests/gen_audio_parity.mjs");
    return;
  }
  std::map<std::string, std::shared_ptr<SourceData>> sources;
  const auto scenes = parse(file.scenes, sources);
  REQUIRE(scenes.size() >= 30);
  std::printf("\n%-24s %12s %10s   %s\n", "scene", "max|err|", "SNR dB", "tolerance");
  for (const Scene& s : scenes) {
    const auto& ts = file.planes.at("out:" + s.name);
    const auto cpp = render_offline(s.program, std::llround(s.start * kSr), s.frames);
    double maxErr = 0;
    double sig = 0;
    double err = 0;
    for (std::size_t c = 0; c < 2; ++c) {
      for (std::size_t i = 0; i < static_cast<std::size_t>(s.frames); ++i) {
        const double a = ts[c][i];
        const double b = cpp[c][i];
        maxErr = std::max(maxErr, std::fabs(a - b));
        sig += a * a;
        err += (a - b) * (a - b);
      }
    }
    const double snr = err > 0 ? 10 * std::log10(sig / err) : 999;
    // PARITY_DUMP=<scene>[:from] prints both engines' samples around a spot.
    if (const char* dump = std::getenv("PARITY_DUMP"); dump != nullptr && s.name == std::string(dump).substr(0, std::string(dump).find(':'))) {
      const std::string d(dump);
      const std::size_t from = d.find(':') == std::string::npos ? 0 : std::stoul(d.substr(d.find(':') + 1));
      for (std::size_t i = from; i < from + 48 && i < static_cast<std::size_t>(s.frames); ++i) {
        std::printf("  %6zu  ts % .7f % .7f   cpp % .7f % .7f\n", i, ts[0][i], ts[1][i], cpp[0][i], cpp[1][i]);
      }
    }
    const Tol tol = tolerance(s.name);
    std::printf("%-24s %12.3g %10.1f   <= %.0e, >= %.0f dB\n", s.name.c_str(), maxErr, snr, tol.maxAbs, tol.minSnrDb);
    INFO("scene " << s.name << ": max |err| " << maxErr << ", SNR " << snr << " dB");
    CHECK(maxErr <= tol.maxAbs);
    CHECK(snr >= tol.minSnrDb);
  }
}

TEST_CASE("parity: distortion curves are bit-identical to audioEffects.ts", "[audio][parity]") {
  ParityFile file;
  if (!load(file)) return;
  const std::map<std::string, DistortionShape> shapes{
      {"soft-clip", DistortionShape::softClip}, {"hard-clip", DistortionShape::hardClip},
      {"saturation-1", DistortionShape::saturation1}, {"saturation-2", DistortionShape::saturation2},
      {"tube", DistortionShape::tube}, {"fuzz", DistortionShape::fuzz}};
  for (const auto& [name, shape] : shapes) {
    for (const auto& [drive, bits] : std::vector<std::pair<int, int>>{{60, 16}, {35, 5}}) {
      const auto& ts = file.planes.at("curve:" + name + ":" + std::to_string(drive) + ":" + std::to_string(bits));
      const auto cpp = distortion_curve(shape, drive, bits);
      INFO(name << " drive " << drive << " bits " << bits);
      CHECK(cpp == ts[0]);
    }
  }
}
