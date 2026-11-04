// SDK 1.4 (X): plugins out of process — the messages between premation-engine and a
// premation-plugin-host child (one child per plugin bundle).
//
// Frames on the child's stdin / stdout: u32 kind, u32 length (little endian), then `length`
// bytes. The engine sends one request and waits for its reply; the child answers in order.
//
//   describe  → JSON: the bundle's effects as the child loaded them (flags, params), or
//               {"error": "…"} when the plugin did not load there
//   render    → the render's inputs (RenderInputs: params, times, sizes, camera, lights,
//               channels) and the input texels → ok, fault, message, the output texels
//   quit      → (no reply) the child sets its plugin down and exits
//
// The plugin in the child runs inside an ordinary PluginHost — the same crash guard, watchdog and
// worker pool as in the engine — so authors see the same SDK. What needs the engine's document or
// GPU (checkouts at other times, scene depth, simulations, published channels, overlays, sequence
// data, custom UI) keeps a plugin in process (PluginHost::Impl::out_of_process_refusal).
#pragma once

#include <cstdint>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "cpu_render.hpp"
#include "host.hpp"

namespace premation::plugins::oop {

enum class Kind : std::uint32_t { describe = 1, render = 2, quit = 3, audio_process = 4 /* SDK 1.4 (A): clap_host.hpp */, reply = 100 };

/// The most bytes one frame carries (an 8K float world is ~530 MB; past this the effect is refused).
inline constexpr std::uint32_t kMaxFrame = 1U << 30;

void put_frame(std::vector<std::uint8_t>& out, Kind kind, std::span<const std::uint8_t> payload);
/// The frame header's kind and payload length (8 bytes).
bool read_header(std::span<const std::uint8_t> header, Kind& kind, std::uint32_t& length);

struct RenderRequest {
  /// Everything but `samples` and `simState` (an effect that needs them runs in process).
  RenderInputs in;
  TexelImage input;
};

struct RenderReply {
  bool ok = false;
  bool fault = false;
  std::string message;
  TexelImage output;
};

[[nodiscard]] std::vector<std::uint8_t> encode(const RenderRequest& r);
[[nodiscard]] bool decode(std::span<const std::uint8_t> in, RenderRequest& r);
[[nodiscard]] std::vector<std::uint8_t> encode(const RenderReply& r);
[[nodiscard]] bool decode(std::span<const std::uint8_t> in, RenderReply& r);

/// The child's effects as JSON (describe), and back into specs (main = nullptr: never called in
/// the engine).
[[nodiscard]] std::string specs_to_json(const std::vector<const EffectSpec*>& specs);
[[nodiscard]] bool specs_from_json(std::string_view json, std::vector<EffectSpec>& out, std::string& error);

}  // namespace premation::plugins::oop
