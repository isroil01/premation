// The audio master clock and the transport.
//
// A/V drift (the E2 exit, docs/NATIVE_CORE_PLAN.md §5): a simulated device
// whose crystal runs off the CPU clock (±200 ppm), consuming in WASAPI-sized
// 10 ms chunks, calling back late by a random 0–3 ms, plays for ten minutes
// while a Session-style video clock (60 Hz ticks, k = floor(mediaElapsed ·
// fps)) picks frames from RealtimeEngine::playhead. At every tick the frame on
// screen is compared with the sample actually at the speaker: the error must
// stay within one frame. The same run paced by the wall clock (today's
// Session) is checked to FAIL — proof the test can see drift.
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <random>
#include <vector>

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "clock.hpp"
#include "mixer.hpp"
#include "realtime.hpp"
#include "source_store.hpp"

using namespace premation::audio;  // NOLINT(google-build-using-namespace)

namespace {

constexpr double kSr = 48000;

struct DriftResult {
  // Frames between the frame on screen and the frame whose sound is at the
  // speaker (floor(heard · fps)): the E2 exit metric.
  std::int64_t maxFrameDiffAudio = 0;
  std::int64_t maxFrameDiffWall = 0;
  // The continuous clock error (playhead − heard), seconds.
  double minClockErr = 1e9, maxClockErr = -1e9;
  double firstMinuteErr = 0, lastMinuteErr = 0;  // means
  double finalWallErr = 0;                       // wall-clock pacing, end of run
  std::uint64_t ticks = 0;
};

/// Ten simulated minutes. `ppm` = device crystal vs CPU clock; `fps` = comp.
DriftResult simulate(double ppm, double fps, double minutes, std::uint32_t seed) {
  const MixFormat fmt{static_cast<int>(kSr), 2};
  RealtimeEngine rt(fmt);
  auto prog = std::make_shared<Program>();
  prog->format = fmt;
  rt.install(std::make_unique<RenderPlan>(prog));

  std::mt19937 g(seed);
  std::uniform_real_distribution<double> late(0.0, 0.003);   // callback scheduling jitter
  std::uniform_real_distribution<double> vjit(0.0, 0.002);   // video tick jitter
  const double devRate = kSr * (1 + ppm * 1e-6);              // frames per CPU second
  const std::int64_t period = 480;                            // 10 ms
  const std::int64_t bufferFrames = 3 * period;               // WASAPI-like depth
  const double dacLatencySec = 0.0;                           // beyond the buffer (not observable here)

  // Consumed frames at CPU time t (the hardware), quantised to the device's
  // own period as WASAPI's padding is.
  auto consumed = [&](double t) { return std::max(0.0, t * devRate); };
  auto consumedQ = [&](double t) {
    return static_cast<std::int64_t>(std::floor(consumed(t) / static_cast<double>(period))) * period;
  };

  std::vector<float> buf(static_cast<std::size_t>(period) * 2);
  std::int64_t written = 0;
  // Prime the buffer (start-up) at t = 0.
  const double playAt = 0.5;  // play command issued at 0.5 s
  bool playSent = false;
  std::int64_t playDeviceFrame = -1;
  double wallPlayT = 0;
  DriftResult res;
  std::uint64_t firstN = 0;
  std::uint64_t lastN = 0;

  const double end = minutes * 60 + playAt;
  double nextVideo = playAt + 0.1;
  // The next callback fires when the buffer has room for a period.
  auto next_callback_time = [&]() {
    // Room when written − consumed ≤ bufferFrames − period.
    const double needConsumed = static_cast<double>(written - (bufferFrames - period));
    return std::max(0.0, needConsumed / devRate);
  };
  double tcb = 0;
  while (true) {
    tcb = std::max(tcb, next_callback_time()) + late(g);
    // Video ticks that happen before this callback.
    while (nextVideo < tcb && nextVideo < end) {
      const ClockReading r = rt.playhead(nextVideo);
      // The sample at the speaker: consumed hardware frame − DAC latency,
      // mapped through the play segment (media frame = device frame − start).
      const double heardDevice = consumed(nextVideo) - dacLatencySec * devRate;
      const double heardMedia = (heardDevice - static_cast<double>(playDeviceFrame)) / kSr;
      if (playDeviceFrame >= 0 && r.locked && r.playing && heardMedia > 0.2) {
        const auto heardFrame = static_cast<std::int64_t>(std::floor(heardMedia * fps));
        const auto k = static_cast<std::int64_t>(std::floor(r.mediaElapsedSec * fps + 1e-9));
        // Today's Session: frames paced by the wall clock since play.
        const double wall = nextVideo - wallPlayT;
        const auto kw = static_cast<std::int64_t>(std::floor(wall * fps + 1e-9));
        res.maxFrameDiffAudio = std::max(res.maxFrameDiffAudio, std::abs(k - heardFrame));
        res.maxFrameDiffWall = std::max(res.maxFrameDiffWall, std::abs(kw - heardFrame));
        const double e = r.mediaElapsedSec - heardMedia;
        res.minClockErr = std::min(res.minClockErr, e);
        res.maxClockErr = std::max(res.maxClockErr, e);
        const double sinceStart = heardMedia;
        if (sinceStart < 60) {
          res.firstMinuteErr += e;
          ++firstN;
        }
        if (sinceStart > minutes * 60 - 60) {
          res.lastMinuteErr += e;
          ++lastN;
        }
        res.finalWallErr = wall - heardMedia;
        ++res.ticks;
      }
      nextVideo += 1.0 / 60 + vjit(g) - 0.001;
    }
    if (tcb >= end) break;
    if (!playSent && tcb >= playAt) {
      rt.play(0, 1, LoopMode::loop, 0, INT64_MAX);
      playSent = true;
      playDeviceFrame = written;  // applied at the start of this callback
      wallPlayT = tcb;
    }
    const std::int64_t played = std::min(written, consumedQ(tcb));
    rt.process(buf.data(), static_cast<std::uint32_t>(period), written, tcb, played);
    written += period;
  }
  if (firstN > 0) res.firstMinuteErr /= static_cast<double>(firstN);
  if (lastN > 0) res.lastMinuteErr /= static_cast<double>(lastN);
  return res;
}

}  // namespace

void report(const char* label, double ppm, double fps, const DriftResult& r) {
  std::printf("%s ppm %+6.0f @ %2.0f fps: %llu ticks, frame diff audio-clocked max %lld, wall-clocked max %lld; "
              "clock error %.2f..%.2f ms, first-minute mean %.3f ms, last-minute mean %.3f ms (drift %.3f ms); "
              "wall pacing error at 10 min %.1f ms\n",
              label, ppm, fps, static_cast<unsigned long long>(r.ticks), static_cast<long long>(r.maxFrameDiffAudio),
              static_cast<long long>(r.maxFrameDiffWall), r.minClockErr * 1000, r.maxClockErr * 1000,
              r.firstMinuteErr * 1000, r.lastMinuteErr * 1000, (r.lastMinuteErr - r.firstMinuteErr) * 1000,
              r.finalWallErr * 1000);
}

TEST_CASE("A/V drift: audio-clocked video stays within one frame over 10 minutes", "[audio][clock][drift]") {
  for (const double ppm : {-200.0, -50.0, 0.0, 80.0, 200.0}) {
    const DriftResult r = simulate(ppm, 30, 10, 42 + static_cast<std::uint32_t>(ppm + 1000));
    report("drift", ppm, 30, r);
    CHECK(r.ticks > 30'000);
    CHECK(r.maxFrameDiffAudio <= 1);
    // No drift: the clock's error does not grow over the ten minutes …
    CHECK(std::fabs(r.lastMinuteErr - r.firstMinuteErr) < 0.001);
    // … and stays inside one device period (the played-frame measure's
    // granularity) plus callback jitter.
    CHECK(r.maxClockErr - r.minClockErr < 0.012);
    // The wall-clocked Session drifts past a frame at these crystal errors.
    if (std::fabs(ppm) >= 200) CHECK(r.maxFrameDiffWall > 1);
  }
}

TEST_CASE("A/V drift at 60 fps, 200 ppm: still within one frame", "[audio][clock][drift]") {
  const DriftResult r = simulate(200, 60, 10, 7);
  report("drift", 200, 60, r);
  CHECK(r.maxFrameDiffAudio <= 1);
  CHECK(std::fabs(r.lastMinuteErr - r.firstMinuteErr) < 0.001);
}

TEST_CASE("DLL: locks to the device rate through jitter", "[audio][clock]") {
  DeviceClock c(kSr);
  std::mt19937 g(1);
  std::uniform_real_distribution<double> j(0, 0.002);
  const double rate = kSr * (1 + 150e-6);
  for (int k = 0; k < 3000; ++k) {
    const std::int64_t frame = static_cast<std::int64_t>(k) * 480;
    c.on_callback(frame, static_cast<double>(frame) / rate + j(g));
  }
  CHECK(c.locked());
  // ±2 ms of callback jitter against 10 ms periods: the loop's rate estimate
  // wanders by tens of ppm (its phase — what the playhead uses — by µs).
  CHECK(c.frames_per_second() == Catch::Approx(rate).epsilon(60e-6));

}

namespace {

/// Drives a RealtimeEngine with fixed 256-frame callbacks; returns the output (L).
struct Driver {
  RealtimeEngine rt;
  std::int64_t written = 0;
  std::vector<float> out;
  explicit Driver(const MixFormat& f) : rt(f) {}
  void run(std::int64_t frames) {
    std::vector<float> b(512);
    for (std::int64_t i = 0; i < frames; i += 256) {
      rt.process(b.data(), 256, written, static_cast<double>(written) / kSr, written);
      for (std::size_t k = 0; k < 256; ++k) out.push_back(b[k * 2]);
      written += 256;
    }
  }
};

ProgramPtr loud_sine() {
  std::vector<float> s(480000);
  for (std::size_t i = 0; i < s.size(); ++i) s[i] = static_cast<float>(0.9 * std::sin(2 * 3.141592653589793 * 997 * static_cast<double>(i) / kSr));
  auto data = SourceData::from_planes({s}, kSr);
  auto p = std::make_shared<Program>();
  p->format = {static_cast<int>(kSr), 2};
  Voice v;
  v.id = "s";
  v.data = data;
  v.outSec = 10;
  p->voices.push_back(v);
  return p;
}

double max_step(const std::vector<float>& x, std::size_t from, std::size_t to) {
  double m = 0;
  for (std::size_t i = std::max<std::size_t>(from, 1); i < std::min(to, x.size()); ++i) {
    m = std::max(m, static_cast<double>(std::fabs(x[i] - x[i - 1])));
  }
  return m;
}

}  // namespace

TEST_CASE("transport: pause, seek and loop wrap are click-free", "[audio][transport]") {
  // A 997 Hz sine at 0.9 moves at most 0.9·2π·997/48000 ≈ 0.117 per sample; a
  // hard cut jumps up to 0.9. Every discontinuity must stay near the former.
  const double natural = 0.9 * 2 * 3.141592653589793 * 997 / kSr;
  Driver d({static_cast<int>(kSr), 2});
  d.rt.install(std::make_unique<RenderPlan>(loud_sine()));
  d.rt.play(0, 1, LoopMode::loop, 0, 24000 + 77);  // an awkward loop point
  d.run(48000);
  d.rt.seek(123457, false);
  d.run(4800);
  d.rt.pause();
  d.run(4800);
  CHECK(max_step(d.out, 0, d.out.size()) < natural * 1.6);
  // After the pause's fade, silence.
  for (std::size_t i = d.out.size() - 2000; i < d.out.size(); ++i) CHECK(d.out[i] == 0);
}

TEST_CASE("transport: scrubbing while stopped plays one short grain", "[audio][transport]") {
  Driver d({static_cast<int>(kSr), 2});
  d.rt.install(std::make_unique<RenderPlan>(loud_sine()));
  d.run(1024);
  d.rt.seek(96000, true);
  d.run(9600);
  std::size_t audible = 0;
  for (const float v : d.out) audible += std::fabs(v) > 1e-4F ? 1 : 0;
  // 60 ms grain + the 5 ms fade-out, minus the sine's zero crossings.
  CHECK(audible > 2400);
  CHECK(audible < 3400);
  CHECK(d.out.back() == 0);
}

TEST_CASE("transport: the playhead reports the loop's wrap", "[audio][transport]") {
  Driver d({static_cast<int>(kSr), 2});
  d.rt.install(std::make_unique<RenderPlan>(loud_sine()));
  d.rt.play(0, 1, LoopMode::loop, 0, 48000);
  d.run(48000 * 3 / 2);  // 1.5 s through a 1 s loop
  const ClockReading r = d.rt.playhead(static_cast<double>(d.written) / kSr);
  CHECK(r.playing);
  CHECK(r.compSec == Catch::Approx(0.5).margin(0.02));
  CHECK(r.mediaElapsedSec == Catch::Approx(1.5).margin(0.02));
}
