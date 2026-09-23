// The playback device. miniaudio (header-only, vcpkg `engine` feature) drives
// WASAPI on Windows, Core Audio on macOS, PulseAudio/ALSA on Linux; it is
// included only by device_ffi.cpp. `NullDevice` paces the same callback from a
// thread on the steady clock — headless runs, CI, and machines without an
// output — so the engine's clock path is identical with or without sound.
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <thread>

#include "clock.hpp"

namespace premation::audio {

struct DeviceInfo {
  std::string backend;  // "wasapi", "coreaudio", "pulseaudio", "alsa", "null"
  std::string name;
  int sampleRate = 48000;  // the rate the callback runs at (the mix rate)
  int deviceRate = 48000;  // the device's own rate (miniaudio converts)
  int channels = 2;
  int periodFrames = 0;
  int periods = 0;
  /// Frames between a callback's first frame and the speaker, as the backend
  /// reports it (buffer depth); feeds the playhead's latency compensation.
  double latencyFrames = 0;
};

/// Fill `frames` interleaved float frames. `writeFrame` = frames delivered
/// before this call; `t` = steady-clock seconds at the callback's start;
/// `playedFrame` = frames the hardware had consumed at `t` — measured where
/// the backend can say (WASAPI: written − GetCurrentPadding), else written −
/// the reported buffer depth. The master clock is built on `playedFrame`.
using DeviceCallback =
    std::function<void(float* out, std::uint32_t frames, std::int64_t writeFrame, double t, std::int64_t playedFrame)>;

class AudioDevice {
 public:
  AudioDevice() = default;
  virtual ~AudioDevice() = default;
  AudioDevice(const AudioDevice&) = delete;
  AudioDevice& operator=(const AudioDevice&) = delete;
  AudioDevice(AudioDevice&&) = delete;
  AudioDevice& operator=(AudioDevice&&) = delete;

  virtual bool start(std::string& error) = 0;
  virtual void stop() = 0;
  [[nodiscard]] virtual const DeviceInfo& info() const noexcept = 0;
};

struct DeviceOptions {
  int sampleRate = 48000;
  int channels = 2;
  /// Requested period (ms); 0 = the backend's low-latency default.
  int periodMs = 10;
};

/// The system's default output (miniaudio), or nullptr with `error`.
[[nodiscard]] std::unique_ptr<AudioDevice> open_default_device(const DeviceOptions& options, DeviceCallback cb,
                                                               std::string& error);

/// A device paced by the steady clock (no hardware). `ppm` skews its rate —
/// the drift tests' "crystal" — and `periodFrames` is its callback size.
class NullDevice final : public AudioDevice {
 public:
  NullDevice(const DeviceOptions& options, DeviceCallback cb, int periodFrames = 480);
  ~NullDevice() override;
  NullDevice(const NullDevice&) = delete;
  NullDevice& operator=(const NullDevice&) = delete;
  NullDevice(NullDevice&&) = delete;
  NullDevice& operator=(NullDevice&&) = delete;
  bool start(std::string& error) override;
  void stop() override;
  [[nodiscard]] const DeviceInfo& info() const noexcept override { return info_; }

 private:
  DeviceInfo info_;
  DeviceCallback cb_;
  std::atomic<bool> run_{false};
  std::thread thread_;
};

}  // namespace premation::audio
