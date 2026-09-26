// E2 parity: the C++ mixer against the TypeScript offline mix.
//
// tests/data/audio_parity.bin is frozen from the TypeScript engine: its
// generator ran the REAL src/core/audio/audioMixdown.ts `mixdownBuffer` in
// Electron's Chromium (OfflineAudioContext) over 36 scenes — gain, pan (mono
// and stereo laws), keyframed level and pan, trims, overlaps, varispeed,
// reverse, an export window that starts mid-voice, and every built-in audio
// effect incl. keyframed effect parameters and a chain. The file carries the
// scene descriptions (the "scenes" section), each scene's mix ("out:<scene>")
// and the distortion curves ("curve:<shape>:<drive>:<bits>"). The C++ rebuilds
// each scene's sources bit for bit (motion_jsmath's V8 sin, the same integer
// xorshift), renders it with render_offline, and compares per sample.
//
// Tolerances are stated per scene (max |error| over both channels, and the
// signal-to-error ratio): exact-arithmetic scenes are held to float rounding;
// DSP whose Chromium implementation differs in internals (band-limited
// oscillator tables, Lagrange-interpolated LFOs, FFT reverb, the half-band
// oversamplers) to an SNR floor. The table prints on every run.
//
// PARITY_REBLESS=1 writes the C++ answers instead (parity_rebless.hpp): the
// mixes and curves are replaced in the same binary layout, the scene text and
// the section order are kept. Each TEST_CASE re-reads the file and replaces
// only its own sections, so running both (or either) leaves one consistent file.
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
#include <memory>
#include <span>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include "effects.hpp"
#include "jsmath.hpp"
#include "mixer.hpp"
#include "parity_rebless.hpp"
#include "source_store.hpp"

using namespace premation::audio;  // NOLINT(google-build-using-namespace)

namespace {

constexpr int kSr = 48000;
constexpr int kSrcFrames = 24000;

/// A section of audio_parity.bin: [u32 nameLen][name][u32 kind][u32 len][payload]
/// (little-endian; kind 1 = the scene text, 2 = planes).
struct Section {
  std::string name;
  std::uint32_t kind = 0;
  std::vector<char> payload;
};

struct ParityFile {
  std::string scenes;
  std::map<std::string, std::vector<std::vector<float>>> planes;
  std::vector<Section> sections;  ///< every section, raw and in file order (re-bless)
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
    f.sections.push_back(Section{name, kind, std::vector<char>(b.data() + o, b.data() + o + len)});
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

// ── Re-bless: the same layout, written back ─────────────────────────────────

void put32(std::vector<char>& b, std::uint32_t v) {
  std::array<char, 4> raw{};
  std::memcpy(raw.data(), &v, 4);
  b.insert(b.end(), raw.begin(), raw.end());
}

/// A kind-2 payload: [u32 channels][u32 frames] then each plane's float32s
/// (`p[i] ?? 0` past a plane's end, as the generator wrote them).
std::vector<char> planes_payload(const std::vector<std::vector<float>>& planes, std::size_t frames) {
  std::vector<char> out;
  out.reserve(8 + (planes.size() * frames * 4));
  put32(out, static_cast<std::uint32_t>(planes.size()));
  put32(out, static_cast<std::uint32_t>(frames));
  for (const auto& p : planes) {
    for (std::size_t i = 0; i < frames; ++i) {
      const float v = i < p.size() ? p[i] : 0.0F;
      std::array<char, 4> raw{};
      std::memcpy(raw.data(), &v, 4);
      out.insert(out.end(), raw.begin(), raw.end());
    }
  }
  return out;
}

std::vector<char> serialize(const ParityFile& f) {
  std::vector<char> b{'P', 'A', 'P', '1'};
  for (const Section& s : f.sections) {
    put32(b, static_cast<std::uint32_t>(s.name.size()));
    b.insert(b.end(), s.name.begin(), s.name.end());
    put32(b, s.kind);
    put32(b, static_cast<std::uint32_t>(s.payload.size()));
    b.insert(b.end(), s.payload.begin(), s.payload.end());
  }
  return b;
}

/// Re-read the file, replace the named plane sections with `got` (each
/// `{planes, frames}`), and write it back. False when a name is not in the file
/// or the write failed.
bool rebless_planes(const std::map<std::string, std::pair<std::vector<std::vector<float>>, std::size_t>>& got) {
  ParityFile f;
  if (!load(f)) return false;
  std::size_t replaced = 0;
  for (Section& s : f.sections) {
    const auto it = got.find(s.name);
    if (it == got.end() || s.kind != 2) continue;
    s.payload = planes_payload(it->second.first, it->second.second);
    ++replaced;
  }
  if (replaced != got.size()) return false;
  const std::vector<char> bytes = serialize(f);
  return premation::test::write_fixture_file(PREMATION_AUDIO_PARITY, bytes);
}

// ── Sources, rebuilt exactly as the TypeScript generator made them ──────────

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
  REQUIRE(load(file));
  const bool rebless = premation::test::parity_rebless();
  std::map<std::string, std::pair<std::vector<std::vector<float>>, std::size_t>> reblessed;
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
    if (rebless) {
      // The generator wrote both channels of the scene's window.
      std::vector<std::vector<float>> planes(cpp.begin(), cpp.begin() + 2);
      reblessed.emplace("out:" + s.name, std::make_pair(std::move(planes), static_cast<std::size_t>(s.frames)));
      continue;
    }
    INFO("scene " << s.name << ": max |err| " << maxErr << ", SNR " << snr << " dB");
    CHECK(maxErr <= tol.maxAbs);
    CHECK(snr >= tol.minSnrDb);
  }
  if (rebless) REQUIRE(rebless_planes(reblessed));
}

TEST_CASE("parity: distortion curves are bit-identical to audioEffects.ts", "[audio][parity]") {
  ParityFile file;
  REQUIRE(load(file));
  const bool rebless = premation::test::parity_rebless();
  std::map<std::string, std::pair<std::vector<std::vector<float>>, std::size_t>> reblessed;
  const std::map<std::string, DistortionShape> shapes{
      {"soft-clip", DistortionShape::softClip}, {"hard-clip", DistortionShape::hardClip},
      {"saturation-1", DistortionShape::saturation1}, {"saturation-2", DistortionShape::saturation2},
      {"tube", DistortionShape::tube}, {"fuzz", DistortionShape::fuzz}};
  for (const auto& [name, shape] : shapes) {
    for (const auto& [drive, bits] : std::vector<std::pair<int, int>>{{60, 16}, {35, 5}}) {
      const std::string key = "curve:" + name + ":" + std::to_string(drive) + ":" + std::to_string(bits);
      const auto& ts = file.planes.at(key);
      auto cpp = distortion_curve(shape, drive, bits);
      if (rebless) {
        const std::size_t n = cpp.size();
        reblessed.emplace(key, std::make_pair(std::vector<std::vector<float>>{std::move(cpp)}, n));
        continue;
      }
      INFO(name << " drive " << drive << " bits " << bits);
      CHECK(cpp == ts[0]);
    }
  }
  if (rebless) REQUIRE(rebless_planes(reblessed));
}
