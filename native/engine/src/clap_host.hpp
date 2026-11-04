// SDK 1.4 (A): a CLAP audio-plugin host — premation-plugin-host's mode for a `.clap` file. CLAP
// plugins run out of process only, like OpenFX (row A1 on X): the engine asks the child to
// describe them (their params) and to process blocks of interleaved float audio.
//
// Hosted: the plugin factory, activate / start_processing / process on stereo or mono float32
// audio (one input and one output port), the params extension (count, info, values; values set by
// CLAP_EVENT_PARAM_VALUE at the block's start). Not hosted (yet): note ports and MIDI, the GUI
// extension (a plugin's own editor window), state save / load, latency reporting, 64-bit audio.
#pragma once

#include <cstdint>
#include <filesystem>
#include <memory>
#include <span>
#include <string>
#include <utility>
#include <vector>

namespace premation::plugins::clap {

/// An audio_process request / reply (oop Kind::audio_process).
struct ProcessRequest {
  std::string pluginId;  ///< the CLAP descriptor id
  std::string instance;  ///< keeps the plugin's state between blocks (a layer's effect)
  double sampleRate = 48000;
  std::uint32_t channels = 2;
  std::vector<float> interleaved;  ///< frames × channels
  std::vector<std::pair<std::uint32_t, double>> params;  ///< (param id, value) at the block's start
  bool reset = false;  ///< a seek: clear the plugin's state first
};

struct ProcessReply {
  bool ok = false;
  std::string message;
  std::vector<float> interleaved;
};

[[nodiscard]] std::vector<std::uint8_t> encode(const ProcessRequest& r);
[[nodiscard]] bool decode(std::span<const std::uint8_t> in, ProcessRequest& r);
[[nodiscard]] std::vector<std::uint8_t> encode(const ProcessReply& r);
[[nodiscard]] bool decode(std::span<const std::uint8_t> in, ProcessReply& r);

#if defined(PREMATION_HAVE_CLAP)
class Host {
 public:
  Host();
  ~Host();
  Host(const Host&) = delete;
  Host& operator=(const Host&) = delete;
  Host(Host&&) = delete;
  Host& operator=(Host&&) = delete;

  bool load(const std::filesystem::path& file, std::string& error);
  /// {"audio": [{id, name, vendor, features, params: [{id, name, min, max, default}]}]} or {"error"}.
  [[nodiscard]] std::string describe_json() const;
  ProcessReply process(const ProcessRequest& req);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
#endif

}  // namespace premation::plugins::clap
