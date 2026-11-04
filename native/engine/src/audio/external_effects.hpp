// SDK 1.4 (A): audio effects the engine's mixer does not implement itself — CLAP plugins, run in
// their premation-plugin-host by the plugin host (src/plugins/host.cpp installs the handler when it
// attaches; without a host nothing processes and a CLAP effect passes its signal through).
//
// Header-only (one registry per process, a function-local static), like external_audio.hpp: the
// audio library does not link the plugin host. A call holds the registry's shared lock for its
// duration, so clear() (the host going away) waits for calls in flight and none starts after it.
#pragma once

#include <cstdint>
#include <functional>
#include <mutex>
#include <shared_mutex>
#include <string>
#include <utility>
#include <vector>

namespace premation::audio {

class ExternalEffects {
 public:
  /// One block of interleaved float audio (1 or 2 channels) through `clapId`, with param (id, value)
  /// pairs at the block's start; `instance` keeps the plugin's state between blocks, `reset` clears
  /// it. False = leave the audio as it was.
  using ProcessFn = std::function<bool(const std::string& clapId, const std::string& instance, double sampleRate, std::uint32_t channels,
                                       std::vector<float>& interleaved, const std::vector<std::pair<std::uint32_t, double>>& params,
                                       bool reset)>;

  static void set(ProcessFn fn) {
    Registry& r = reg();
    const std::unique_lock lock(r.mutex);
    r.process = std::move(fn);
  }
  static void clear() {
    Registry& r = reg();
    const std::unique_lock lock(r.mutex);
    r.process = nullptr;
  }
  [[nodiscard]] static bool process(const std::string& clapId, const std::string& instance, double sampleRate, std::uint32_t channels,
                                    std::vector<float>& interleaved, const std::vector<std::pair<std::uint32_t, double>>& params, bool reset) {
    Registry& r = reg();
    const std::shared_lock lock(r.mutex);
    return r.process && r.process(clapId, instance, sampleRate, channels, interleaved, params, reset);
  }

 private:
  struct Registry {
    std::shared_mutex mutex;
    ProcessFn process;
  };
  static Registry& reg() {
    static Registry r;  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables): the process-wide handler
    return r;
  }
};

}  // namespace premation::audio
