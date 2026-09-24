#include "engine_process.hpp"

#include <array>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <memory>
#include <string_view>
#include <thread>
#include <utility>
#include <variant>
#include <vector>

#include "core/blocking_queue.hpp"
#include "core/session.hpp"
#include "core/simulated_sink.hpp"
#include "io/framed_writer.hpp"
#include "io/pipe_ffi.hpp"
#include "os_ffi.hpp"
#include "plugins/host.hpp"
#include "premation/protocol/framing.hpp"

#if defined(PREMATION_HAVE_SCENE)
#include "scene/engine_frames.hpp"
#endif

namespace premation {
namespace {

using Clock = std::chrono::steady_clock;

struct CoreItem {
  enum class Kind : std::uint8_t { frame, ping, disconnect, framing_error, fatal };
  Kind kind = Kind::frame;
  std::vector<std::uint8_t> bytes;
  std::uint64_t nonce = 0;
  std::string message;
};

class ProcessOutbox final : public Outbox {
 public:
  ProcessOutbox(io::FramedWriter& command, io::FramedWriter& frames) : command_(command), frames_(frames) {}

  void send(const api::EngineMessage& message) override {
    wire::Writer w;
    api::encode(w, message);
    std::vector<std::uint8_t> framed;
    framed.reserve(w.bytes().size() + framing::kHeaderBytes);
    framing::append_frame(framed, w.bytes());
    (void)command_.send(std::move(framed));
  }

  void send_frames(const frames::Message& message) override {
    // Render thread and core thread both send here; the writer queue is the
    // only shared state and is itself thread-safe.
    std::vector<std::uint8_t> payload;
    frames::encode(message, payload);
    std::vector<std::uint8_t> framed;
    framed.reserve(payload.size() + framing::kHeaderBytes);
    framing::append_frame(framed, payload);
    (void)frames_.send(std::move(framed));
  }

  [[nodiscard]] std::size_t backlog_bytes() const override { return command_.backlog_bytes(); }

 private:
  io::FramedWriter& command_;
  io::FramedWriter& frames_;
};

void command_reader(io::Handle in, BlockingQueue<CoreItem>& queue) {
  framing::Decoder decoder;
  std::vector<std::uint8_t> buf(64U * 1024U);
  for (;;) {
    const std::ptrdiff_t n = io::read_some(in, buf);
    if (n <= 0) {
      if (decoder.pending() > 0) {
        PREMATION_LOG(warn, "truncated_frame_at_eof").kv("bytes", static_cast<std::uint64_t>(decoder.pending()));
      }
      (void)queue.push(CoreItem{CoreItem::Kind::disconnect, {}, 0, n < 0 ? "read error" : "end of stream"});
      return;
    }
    decoder.feed(std::span<const std::uint8_t>(buf.data(), static_cast<std::size_t>(n)));
    std::span<const std::uint8_t> payload;
    while (decoder.next(payload)) {
      (void)queue.push(CoreItem{CoreItem::Kind::frame, {payload.begin(), payload.end()}, 0, {}});
    }
    if (decoder.error() != framing::Decoder::Error::none) {
      (void)queue.push(CoreItem{CoreItem::Kind::framing_error, {}, 0, "frame length above the maximum"});
      return;
    }
  }
}

template <class ReleaseFn>
void frames_reader(io::Handle in, BlockingQueue<CoreItem>& queue, ReleaseFn release) {
  framing::Decoder decoder(frames::kMaxPayload);
  std::array<std::uint8_t, 4096> buf{};
  for (;;) {
    const std::ptrdiff_t n = io::read_some(in, buf);
    if (n <= 0) return;  // the host closed the frame channel; the command pipe decides shutdown
    decoder.feed(std::span<const std::uint8_t>(buf.data(), static_cast<std::size_t>(n)));
    std::span<const std::uint8_t> payload;
    while (decoder.next(payload)) {
      frames::Message m;
      if (const wire::Status st = frames::decode(payload, m); st != wire::Status::ok) {
        if (st == wire::Status::unknown_variant) continue;  // a newer host's message: skip
        PREMATION_LOG(warn, "frame_channel_bad_message").kv("bytes", payload.size());
        continue;
      }
      if (const auto* r = std::get_if<api::FrameRelease>(&m.v)) {
        release(r->generation, r->slot);
      } else if (const auto* p = std::get_if<api::FramePing>(&m.v)) {
        (void)queue.push(CoreItem{CoreItem::Kind::ping, {}, p->nonce, {}});
      }
    }
    if (decoder.error() != framing::Decoder::Error::none) {
      PREMATION_LOG(error, "frame_channel_framing_error");
      return;
    }
  }
}

}  // namespace

int run_engine(const EngineOptions& options) {
  log::set_min_level(options.logLevel);
  io::Pipes pipes;
  std::string error;
  if (!io::claim_stdio(pipes, error)) {
    PREMATION_LOG(error, "stdio_unavailable").kv("error", error);
    return kExitCannotStart;
  }
  PREMATION_LOG(info, "start")
      .kv("version", kEngineVersion)
      .kv("frameChannel", pipes.framesOut.valid() && pipes.framesIn.valid())
      .kv("noGpu", options.noGpu)
      .kv("hostPid", options.render.hostPid)
      .kv("gpuVendor", options.render.vendorId);

  io::FramedWriter commandOut(pipes.commandOut, "command");
  io::FramedWriter framesOut(pipes.framesOut, "frames");
  commandOut.start();
  framesOut.start();
  ProcessOutbox outbox(commandOut, framesOut);
  BlockingQueue<CoreItem> queue;
  const auto sendFrames = [&outbox](const frames::Message& m) { outbox.send_frames(m); };

  // G1: the native plugin host. Declared before the render thread and the
  // session so it outlives both (the render glue and the document reach it
  // through PluginHost::active()). Absent when no plugin folder is configured.
  std::unique_ptr<plugins::PluginHost> pluginHost;
  {
    std::vector<std::filesystem::path> paths(options.pluginPaths.begin(), options.pluginPaths.end());
    if (const std::optional<std::string> env = os::env_var("PREMATION_PLUGIN_PATH")) {
      std::string_view rest = *env;
      while (!rest.empty()) {
        const std::size_t cut = rest.find(';');
        if (cut != 0) paths.emplace_back(std::string(rest.substr(0, cut)));
        if (cut == std::string_view::npos) break;
        rest.remove_prefix(cut + 1);
      }
    }
    if (!paths.empty()) {
      plugins::HostOptions ho;
      ho.searchPaths = std::move(paths);
      ho.journal = options.pluginJournal;
      pluginHost = std::make_unique<plugins::PluginHost>(std::move(ho));
      const std::vector<plugins::PluginRecord> recs = pluginHost->scan();
      PREMATION_LOG(info, "plugins_scanned").kv("count", static_cast<std::uint64_t>(recs.size()));
    }
  }
  std::unique_ptr<render::RenderThread> gpuSink;
  std::unique_ptr<SimulatedSink> simSink;
  FrameSink* sink = nullptr;
  render::RenderOptions renderOptions = options.render;
#if defined(PREMATION_HAVE_SCENE)
  // D2w: the viewport draws the engine's own document through the render
  // graph (scene/engine_frames.hpp). PREMATION_ENGINE_SCENE=0 keeps C2's quads.
  const bool useScene = !options.noGpu && os::env_var("PREMATION_ENGINE_SCENE").value_or("1") != "0";
  scene::EngineFramesOptions sceneOptions;
  sceneOptions.fontsManifest = os::env_var("PREMATION_FONTS_MANIFEST").value_or("");
  std::unique_ptr<FrameBuilder> frameBuilder;
  std::unique_ptr<MediaClock> mediaClock;
  if (useScene) {
    renderOptions.makeDrawer = scene::make_drawer_factory(sceneOptions);
    frameBuilder = scene::make_frame_builder(sceneOptions);
    // E2: the document's sound, and the audio clock pacing playback.
    // PREMATION_AUDIO_DEVICE=null plays through the steady-clock NullDevice.
    std::string audioError;
    mediaClock = scene::make_media_clock(os::env_var("PREMATION_AUDIO_DEVICE").value_or("") != "null", audioError);
  }
#endif
  if (options.noGpu) {
    simSink = std::make_unique<SimulatedSink>(sendFrames, options.render.slots);
    sink = simSink.get();
  } else {
    gpuSink = std::make_unique<render::RenderThread>(renderOptions, sendFrames, [&queue](const std::string& why) {
      (void)queue.push(CoreItem{CoreItem::Kind::fatal, {}, 0, why});
    });
    if (!gpuSink->start(error)) {
      PREMATION_LOG(error, "gpu_unavailable").kv("error", error);
      commandOut.close(std::chrono::milliseconds(200));
      framesOut.close(std::chrono::milliseconds(200));
      if (commandOut.detached() || framesOut.detached()) std::_Exit(kExitCannotStart);
      return kExitCannotStart;
    }
    sink = gpuSink.get();
  }

  // Readers block in ReadFile/read with no portable way to interrupt them; at
  // shutdown they are detached and die with the process (they touch only the
  // queue and the sinks, which outlive them until exit).
  std::thread(command_reader, pipes.commandIn, std::ref(queue)).detach();
  if (pipes.framesIn.valid()) {
    if (gpuSink) {
      render::RenderThread* r = gpuSink.get();
      std::thread([in = pipes.framesIn, &queue, r] {
        frames_reader(in, queue, [r](std::uint32_t g, std::uint32_t s) { r->release(g, s); });
      }).detach();
    } else {
      SimulatedSink* r = simSink.get();
      std::thread([in = pipes.framesIn, &queue, r] {
        frames_reader(in, queue, [r](std::uint32_t g, std::uint32_t s) { r->release(g, s); });
      }).detach();
    }
  }

  SessionOptions sessionOptions;
  sessionOptions.engineVersion = kEngineVersion;
  sessionOptions.testPorts = options.testPorts;
  sessionOptions.testPortsDir = options.testPortsDir;
  Session session(outbox, *sink, sessionOptions);
#if defined(PREMATION_HAVE_SCENE)
  session.set_frame_builder(frameBuilder.get());
  session.set_media_clock(mediaClock.get());
#endif
  int exitCode = kExitOk;
  bool running = true;
  while (running && !session.finished()) {
    std::optional<CoreItem> item = queue.pop_until(session.next_deadline());
    const auto now = Clock::now();
    if (item) {
      switch (item->kind) {
        case CoreItem::Kind::frame:
          session.on_frame(item->bytes, now);
          break;
        case CoreItem::Kind::ping:
          session.on_ping(item->nonce, static_cast<std::uint32_t>(queue.size()));
          break;
        case CoreItem::Kind::disconnect:
          PREMATION_LOG(info, "host_disconnected").kv("reason", item->message);
          session.on_disconnect();
          running = false;
          break;
        case CoreItem::Kind::framing_error:
          PREMATION_LOG(error, "framing_error").kv("reason", item->message);
          session.close(api::GoodbyeReason::protocol_error, item->message);
          exitCode = kExitFraming;
          running = false;
          break;
        case CoreItem::Kind::fatal:
          PREMATION_LOG(error, "fatal").kv("reason", item->message);
          session.close(api::GoodbyeReason::engine_shutdown, item->message);
          exitCode = kExitDeviceLost;
          running = false;
          break;
      }
    }
    session.tick(now);
    os::high_resolution_timer(session.playing());
  }
  os::high_resolution_timer(false);
  PREMATION_LOG(info, "shutdown").kv("exitCode", exitCode).kv("revision", session.revision());

  if (gpuSink) gpuSink->stop();
  commandOut.close(std::chrono::milliseconds(500));
  framesOut.close(std::chrono::milliseconds(200));
  if (commandOut.detached() || framesOut.detached()) {
    // A writer is stuck in a write nobody will read; destroying it would free
    // memory its thread still uses. End here without unwinding.
    std::_Exit(exitCode);
  }
  return exitCode;
}

}  // namespace premation
