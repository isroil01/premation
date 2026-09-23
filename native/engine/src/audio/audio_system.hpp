// AudioSystem — the engine's audio (E2), one per engine process:
//
//   sources     open_source(path): probe now, conform (decode + resample to
//               the mix format) on a worker pool; peaks built in the same pass
//   program     set_program(voices…): a RenderPlan built here (control thread)
//               and handed to the audio thread, which cross-fades into it
//   transport   play / pause / seek / scrub; the audio clock is the MASTER:
//               playhead(now) is the comp time of the sample at the speaker
//   export      render(program, range): the same mixer, offline, sample-exact
//   device      miniaudio (WASAPI / Core Audio / ALSA) or the steady-clock
//               NullDevice; the callback runs RealtimeEngine::process
//
// Integration for the document core (D1b) and the transport: see
// native/README.md "Audio (E2)" and core_clock.hpp.
#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "audio_decode.hpp"
#include "audio_types.hpp"
#include "clock.hpp"
#include "device.hpp"
#include "mixer.hpp"
#include "peaks.hpp"
#include "realtime.hpp"
#include "source_store.hpp"

namespace premation::audio {

enum class SourceState : std::uint8_t { unknown, conforming, ready, silent, failed };

struct AudioSystemOptions {
  MixFormat format;
  int conformThreads = 2;
  /// Prefer the real output device; false (or none present) = NullDevice.
  bool useDevice = true;
  int periodMs = 10;
};

class AudioSystem {
 public:
  explicit AudioSystem(AudioSystemOptions options = {});
  ~AudioSystem();
  AudioSystem(const AudioSystem&) = delete;
  AudioSystem& operator=(const AudioSystem&) = delete;
  AudioSystem(AudioSystem&&) = delete;
  AudioSystem& operator=(AudioSystem&&) = delete;

  [[nodiscard]] const MixFormat& format() const noexcept { return opt_.format; }

  // ── sources ──
  /// Probe `path` and start conforming it. Returns the source id (stable for
  /// the path); 0 on a file that cannot be opened (`error` set). A file with
  /// no audio track returns an id whose state is `silent`.
  std::uint64_t open_source(const std::string& path, std::string& error);
  /// A source made from samples (generated audio, tests).
  std::uint64_t add_source(std::shared_ptr<SourceData> data);
  [[nodiscard]] SourcePtr source(std::uint64_t id) const;
  [[nodiscard]] SourceState state(std::uint64_t id) const;
  [[nodiscard]] AudioStreamInfo info(std::uint64_t id) const;

  // ── program ──
  /// Resolve every voice's source and hand the program to the audio thread.
  void set_program(Program program);
  [[nodiscard]] ProgramPtr program() const;

  // ── transport (seconds, comp time) ──
  void play(double fromSec, double rate, LoopMode loop, double rangeStartSec, double rangeEndSec);
  void pause();
  void seek(double sec, bool scrub);
  void set_preview(bool muted, double volume, bool scrubAudio);
  [[nodiscard]] ClockReading playhead(SteadyClock::time_point now) const noexcept;
  [[nodiscard]] MeterLevels meter() const noexcept { return engine_.meter(); }

  // ── device ──
  bool start_device(std::string& error);
  void stop_device();
  [[nodiscard]] DeviceInfo device_info() const;

  // ── export + queries ──
  /// Sample-exact offline mix of [startSec, startSec + frames/rate).
  [[nodiscard]] std::vector<std::vector<float>> render(const Program& program, double startSec,
                                                       std::int64_t frames) const;
  [[nodiscard]] WaveformPeaksResult peaks(std::uint64_t id, double fromSec, double durationSec,
                                          std::uint32_t buckets, bool monoMix) const;

  /// The realtime core, for tests and tools that drive it without a device.
  [[nodiscard]] RealtimeEngine& engine() noexcept { return engine_; }

 private:
  struct Entry {
    std::string path;
    AudioStreamInfo info;
    std::shared_ptr<SourceData> data;
    SourceState state = SourceState::unknown;
  };
  void worker();
  [[nodiscard]] Program resolve(Program p) const;

  AudioSystemOptions opt_;
  RealtimeEngine engine_;
  mutable std::mutex mu_;
  std::map<std::uint64_t, Entry> sources_;
  std::map<std::string, std::uint64_t> byPath_;
  std::uint64_t nextId_ = 1;
  ProgramPtr program_;
  // Conform jobs.
  std::deque<std::uint64_t> jobs_;
  std::condition_variable jobCv_;
  std::atomic<bool> stopping_{false};
  std::vector<std::thread> workers_;
  // Device.
  std::unique_ptr<AudioDevice> device_;
};

}  // namespace premation::audio
