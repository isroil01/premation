// Engine jobs' pure halves: the audio analyses (audio_analysis.hpp — ports of
// silenceRemoval.ts, audioKeyframes.ts, @motion/audio analyse.ts,
// audioDriver.ts, ducking.ts, audioGate.ts), Scene Edit Detection
// (scene_detect.hpp — sceneEditDetect.ts) and the render's ffmpeg command line
// (encode_args.hpp — ffmpegEncodeArgs.ts), on synthetic inputs whose answers
// are known.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <numbers>
#include <string>
#include <vector>

#include "jobs/audio_analysis.hpp"
#include "jobs/encode_args.hpp"
#include "jobs/media_input.hpp"
#include "jobs/scene_detect.hpp"

using namespace premation::jobs;
namespace aa = premation::jobs::audio_analysis;
using Catch::Approx;

namespace {

std::vector<float> tone(double seconds, double rate, double amp, double hz = 440) {
  const auto n = static_cast<std::size_t>(seconds * rate);
  std::vector<float> v(n);
  for (std::size_t i = 0; i < n; ++i) {
    v[i] = static_cast<float>(amp * std::sin(2 * std::numbers::pi * hz * static_cast<double>(i) / rate));
  }
  return v;
}

std::vector<float> concat(std::initializer_list<std::vector<float>> parts) {
  std::vector<float> out;
  for (const auto& p : parts) out.insert(out.end(), p.begin(), p.end());
  return out;
}

}  // namespace

TEST_CASE("silences: a quiet second between two tones, padding taken off after the length test", "[jobs][audio]") {
  const double rate = 48000;
  const auto s = concat({tone(1, rate, 0.5), std::vector<float>(48000, 0.0F), tone(1, rate, 0.5)});
  const auto r = aa::detect_silences(s, rate, aa::SilenceOptions{});
  REQUIRE(r.size() == 1);
  CHECK(r[0].startSec == Approx(1.08).margin(0.011));
  CHECK(r[0].endSec == Approx(1.92).margin(0.011));
  // Shorter than minSilenceMs: kept.
  aa::SilenceOptions longer;
  longer.minSilenceMs = 1500;
  CHECK(aa::detect_silences(s, rate, longer).empty());
}

TEST_CASE("silences map onto the composition through the bar, merged", "[jobs][audio]") {
  const std::vector<aa::ClipTiming> bars{{2.0, 0.5, 3.0}};
  const std::vector<aa::SilenceRange> ranges{{0.0, 1.0}, {1.0, 1.5}, {2.8, 4.0}};
  const auto iv = aa::ranges_to_comp_intervals(bars, ranges);
  REQUIRE(iv.size() == 2);
  CHECK(iv[0].start == Approx(2.0));  // source 0.5 plays at comp 2
  CHECK(iv[0].end == Approx(3.0));    // 0.5…1.0 and 1.0…1.5 merged
  CHECK(iv[1].start == Approx(4.3));
  CHECK(iv[1].end == Approx(4.5));    // trimmed at the bar's out
}

TEST_CASE("amplitude envelope: per-frame RMS to 0–100, thinned to a hand-editable track", "[jobs][audio]") {
  const double rate = 48000;
  const std::vector<std::vector<float>> ch{concat({tone(1, rate, 0.25), tone(1, rate, 0.5)})};
  const auto env = aa::amplitude_envelope(ch, rate, 30, aa::Channel::both);
  REQUIRE(env.size() == 60);
  CHECK(env[10] == Approx(50).margin(1));
  CHECK(env[45] == Approx(100).margin(1));
  const auto keys = aa::plan_audio_keyframes(env, aa::KeyframeOptions{});
  REQUIRE(keys.size() >= 3);
  CHECK(keys.front().frame == 0);
  CHECK(keys.back().frame == 59);
  CHECK(aa::smooth_envelope(std::vector<double>{0, 3, 0}, 3)[1] == Approx(1));
}

TEST_CASE("beats: a click train at 120 BPM is found at 120 BPM, 0.5 s apart", "[jobs][audio]") {
  const double rate = 44100;
  std::vector<float> clicks(static_cast<std::size_t>(rate * 12), 0.0F);
  for (std::size_t beat = 0; beat < 24; ++beat) {
    const auto at = static_cast<std::size_t>(static_cast<double>(beat) * 0.5 * rate);
    for (std::size_t i = 0; i < 256 && at + i < clicks.size(); ++i) {
      clicks[at + i] = static_cast<float>(0.9 * std::exp(-static_cast<double>(i) / 40.0) * std::sin(static_cast<double>(i) * 0.7));
    }
  }
  const aa::BeatAnalysis a = aa::analyse_beats({clicks}, rate);
  CHECK(a.bpm == Approx(120).margin(3));
  REQUIRE(a.beats.size() >= 20);
  CHECK(a.beats[5] - a.beats[4] == Approx(0.5).margin(0.03));
  CHECK_FALSE(a.onsets.empty());
  // Silence has no tempo (the variance gate), not 190 BPM.
  CHECK(aa::analyse_beats({std::vector<float>(44100 * 4, 0.0F)}, rate).bpm == 0);
}

TEST_CASE("detector, ducking and the gate: linear ramps that reach their depth exactly", "[jobs][audio]") {
  // Sidechain: loud (0 dBFS ⇒ 1) for frames 10…29.
  std::vector<float> side(60, 0.0F);
  for (int f = 10; f < 30; ++f) side[static_cast<std::size_t>(f)] = 1.0F;
  aa::DuckingParams p;
  const auto duck = aa::duck_levels(side, p, 30);
  CHECK(duck[9] == Approx(0));
  CHECK(duck[12] == Approx(-12));  // attack 60 ms = 2 frames at 30 fps
  CHECK(duck[29] == Approx(-12));
  CHECK(duck[59] == Approx(0));    // released after hold + release
  aa::GateParams g;
  g.thresholdDb = -30;
  const auto gate = aa::gate_levels(side, g, 30);
  CHECK(gate[0] == Approx(-60));   // starts closed
  CHECK(gate[15] == Approx(0));    // opened by the loud frames
  const auto keep = aa::thin_levels(duck);
  CHECK(keep.front() == 0);
  CHECK(keep.back() == duck.size() - 1);
  CHECK(keep.size() < duck.size());
  CHECK(aa::env_to_db(1) == 0);
  CHECK(aa::env_to_db(0) == -60);
  // The detector of a full-scale sine sits near the top of the −60…0 dB scale.
  const auto env = aa::raw_detector_envelope(tone(1, 48000, 1.0), 48000, 30);
  REQUIRE(env.size() == 30);
  CHECK(env[10] > 0.9F);
  // alignSamplesToRange: a bar at comp 1 s playing from source 0 lays the samples one second in.
  const std::vector<float> src(48000, 0.5F);
  const std::vector<aa::ClipTiming> bar{{1.0, 0.0, 1.0}};
  const auto aligned = aa::align_samples_to_range(src, 48000, bar, 0.0, 2.0);
  REQUIRE(aligned.size() == 96000);
  CHECK(aligned[1000] == 0.0F);
  CHECK(aligned[50000] == 0.5F);
}

TEST_CASE("scene detection: a hard cut is the first frame of the new shot", "[jobs][scene]") {
  auto plane = [](float v) {
    LumaImage p;
    p.width = 32;
    p.height = 18;
    p.bytes = true;
    p.data.assign(32 * 18, v);
    // A little texture so ordinary frames differ a little.
    for (std::size_t i = 0; i < p.data.size(); i += 7) p.data[i] = v + 3;
    return p;
  };
  scene_detect::Options o;
  const auto w = scene_detect::walk(
      0, 59, o,
      [&](std::int64_t i, LumaImage& out) {
        out = plane(i < 30 ? 40.0F : 200.0F);
        return true;
      },
      [](double) { return true; });
  REQUIRE(w.cuts.size() == 1);
  CHECK(w.cuts[0] == 30);
  CHECK(w.dissolveCuts.empty());
  CHECK(w.distances.size() == 59);
  // Two spikes inside one minimum shot keep the stronger (a flash frame).
  const std::vector<double> d{0.01, 0.01, 0.01, 0.8, 1.2, 0.01, 0.01, 0.01, 0.01, 0.01};
  const auto cuts = scene_detect::cuts_from_distances(d, o);
  REQUIRE(cuts.size() == 1);
  CHECK(cuts[0] == 5);
}

TEST_CASE("encode args: the export supervisor's command lines", "[jobs][render]") {
  encode::Options o;
  o.format = "mp4";
  o.videoInput = encode::raw_video_input(1920, 1080, 29.97, false);
  o.frame = encode::Options::Frame{1920, 1080, 29.97};
  o.audio = "/w/audio.wav";
  o.tagSrgb = true;
  o.out = "/w/out.mp4";
  const std::vector<std::string> mp4 = encode::build_encode_args(o);
  const std::vector<std::string> want{
      "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-video_size", "1920x1080", "-framerate", "30000/1001", "-i", "pipe:0",
      "-i", "/w/audio.wav", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-maxrate", "19886653", "-bufsize", "39773306",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-vf",
      "setparams=color_primaries=bt709:color_trc=iec61966-2-1,scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:a", "aac", "-b:a", "192k",
      "-shortest", "/w/out.mp4"};
  CHECK(mp4 == want);
  o.format = "mov";
  o.audio.reset();
  o.videoInput = encode::raw_video_input(640, 360, 25, true);
  o.out = "/w/out.mov";
  const auto mov = encode::build_encode_args(o);
  CHECK(mov[4] == "rgba64le");
  CHECK(std::find(mov.begin(), mov.end(), "yuva444p10le") != mov.end());
  CHECK(encode::ffmpeg_rate(24) == "24");
  CHECK(encode::ffmpeg_rate(23.976) == "24000/1001");
}
