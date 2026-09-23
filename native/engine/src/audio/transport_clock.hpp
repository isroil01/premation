// The seam between the engine's transport (core/session.cpp, owned by D1b)
// and the audio master clock. The Session paces playback from
// `elapsed = now − playBase_` on the wall clock today; with an audio clock it
// asks this interface instead, so the frame it shows is the one whose sound is
// at the speaker:
//
//   start_playback(now, from)  → clock.play(fromSec, rate, loop, range)
//   stop_playback / pause      → clock.pause()
//   seek_to(t) (scrub or not)  → clock.seek(sec, scrub)
//   tick(now):
//     if (auto e = clock.media_elapsed(now)) k = floor(*e · compFps + 1e-9);
//     else                                   k = floor(wallElapsed · compFps · |rate| + 1e-9);
//
// `media_elapsed` counts media seconds since play began (× rate, across loop
// wraps), exactly the quantity the Session's step counter integrates, so its
// loop / ping-pong folding and dropped-frame accounting stay as they are.
// It returns nullopt until the device clock has locked (the first ~8
// callbacks) and when no audio device runs — the wall clock then paces, as
// today. The audio thread loops at the same range ends as the Session
// ([first · frameDur, (last + 1) · frameDur)), so both fold identically.
#pragma once

#include <chrono>
#include <cmath>
#include <optional>

#include "audio_system.hpp"

namespace premation {

class TransportClock {
 public:
  TransportClock() = default;
  virtual ~TransportClock() = default;
  TransportClock(const TransportClock&) = delete;
  TransportClock& operator=(const TransportClock&) = delete;
  TransportClock(TransportClock&&) = delete;
  TransportClock& operator=(TransportClock&&) = delete;

  virtual void play(double fromSec, double rate, audio::LoopMode loop, double rangeStartSec, double rangeEndSec) = 0;
  virtual void pause() = 0;
  virtual void seek(double sec, bool scrub) = 0;
  [[nodiscard]] virtual std::optional<double> media_elapsed(std::chrono::steady_clock::time_point now) const = 0;
  /// Comp seconds of the sample at the speaker (the viewport / E1 playhead).
  [[nodiscard]] virtual std::optional<double> comp_time(std::chrono::steady_clock::time_point now) const = 0;
};

/// The AudioSystem as the transport's master clock.
class AudioTransportClock final : public TransportClock {
 public:
  explicit AudioTransportClock(audio::AudioSystem& audio) : audio_(audio) {}
  void play(double fromSec, double rate, audio::LoopMode loop, double rangeStartSec, double rangeEndSec) override {
    audio_.play(fromSec, rate, loop, rangeStartSec, rangeEndSec);
  }
  void pause() override { audio_.pause(); }
  void seek(double sec, bool scrub) override { audio_.seek(sec, scrub); }
  [[nodiscard]] std::optional<double> media_elapsed(std::chrono::steady_clock::time_point now) const override {
    const audio::ClockReading r = audio_.playhead(now);
    if (!r.locked || !r.playing) return std::nullopt;
    return r.mediaElapsedSec;
  }
  [[nodiscard]] std::optional<double> comp_time(std::chrono::steady_clock::time_point now) const override {
    const audio::ClockReading r = audio_.playhead(now);
    if (!r.locked) return std::nullopt;
    return r.compSec;
  }

 private:
  audio::AudioSystem& audio_;
};

}  // namespace premation
