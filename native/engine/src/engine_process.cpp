#include "engine_process.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <functional>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <variant>
#include <vector>

#include "core/blocking_queue.hpp"
#include "core/joining_thread.hpp"
#include "core/session.hpp"
#include "core/simulated_sink.hpp"
#if defined(PREMATION_ENGINE_HEADLESS)
#include "scene/rig_overlay.hpp"
#endif
#include "io/framed_writer.hpp"
#include "io/pipe_ffi.hpp"
#include "os_ffi.hpp"
#include "plugins/host.hpp"
#include "raster/font_catalog.hpp"
#include "premation/protocol/framing.hpp"

#if defined(PREMATION_HAVE_SCENE)
#include "scene/engine_frames.hpp"
#endif
#if defined(PREMATION_HAVE_JOBS)
#include <iostream>

#include "jobs/child_job.hpp"
#include "jobs/job_worker.hpp"
#include "plugins/contrib.hpp"  // P7b: importers_off, for a child job's plugin set
#include "jobs/job_kinds.hpp"
#include "jobs/media_input.hpp"
#include "live/live_host.hpp"
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

/// The newest heartbeat the host sent (frames_reader writes it, the watchdog
/// reads it): its nonce and WHEN it arrived. Shared, because the reader thread
/// is detached and may outlive run_engine's frame.
struct PingState {
  std::atomic<std::uint64_t> nonce{0};
  std::atomic<Clock::rep> arrivedAt{0};  // Clock ticks since epoch; written before `nonce`
};
using PingSlot = std::shared_ptr<PingState>;

template <class ReleaseFn>
void frames_reader(io::Handle in, BlockingQueue<CoreItem>& queue, PingSlot pings, ReleaseFn release) {
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
        pings->arrivedAt.store(Clock::now().time_since_epoch().count(), std::memory_order_relaxed);
        pings->nonce.store(p->nonce, std::memory_order_release);
        (void)queue.push(CoreItem{CoreItem::Kind::ping, {}, p->nonce, {}});
      }
    }
    if (decoder.error() != framing::Decoder::Error::none) {
      PREMATION_LOG(error, "frame_channel_framing_error");
      return;
    }
  }
}

/// What the core thread is doing, for the watchdog — and the engine's proof
/// of life while it is doing it.
///
/// The heartbeat (FramePing, one a second) is answered by the core thread
/// between items, so a pong proves the core drains its queue. But a ping sits
/// in the same FIFO as the work: a core thread inside ONE long item (a heavy
/// comp's first frame build, a batch of hundreds of edits) answered nothing
/// for as long as the item took, and the supervisor's 5 s window called that a
/// hang and killed a healthy engine — the page replayed its command log, asked
/// the same work again, and the restart looped. Liveness is not idleness: this
/// thread answers the pings the core has not reached once the core has been on
/// its item for kAnswerPingsAfter, saying what it is on and for how long
/// (FramePong.busy / busyMs). The supervisor keeps such an engine alive and
/// only gives up on an item that outlasts its stuck budget (a real deadlock).
///
/// The same silence came from MANY short items: a burst of edits (an MCP
/// build, the page's follow-up queries) each under kAnswerPingsAfter kept
/// the core busy for seconds while the ping waited behind them in the FIFO;
/// no item was ever "deep", so nothing answered, and the supervisor killed a
/// healthy engine that was simply working through its queue. So a ping is
/// also answered by its own AGE (PingState.arrivedAt): one that has waited
/// kAnswerPingsAfter is answered from here whatever the core is on.
///
/// It also logs a slow item (core_slow at its end, core_busy while it lasts),
/// so the log says what a stalled core thread was stuck in.
class CoreWatchdog {
 public:
  static constexpr auto kBusyAfter = std::chrono::milliseconds(2000);
  /// A ping unanswered this long into an item is answered from here. Shorter
  /// than kBusyAfter: the host must never see a silence it could mistake for a
  /// hang, whatever it sets its window to.
  static constexpr auto kAnswerPingsAfter = std::chrono::milliseconds(750);

  using SendFrames = std::function<void(const frames::Message&)>;

  CoreWatchdog(PingSlot pings, SendFrames send)
      : pings_(std::move(pings)), send_(std::move(send)), thread_([this] { run(); }) {}
  // Stop first; the thread (declared last) is joined when the members go.
  ~CoreWatchdog() { stop_.store(true, std::memory_order_release); }
  CoreWatchdog(const CoreWatchdog&) = delete;
  CoreWatchdog& operator=(const CoreWatchdog&) = delete;
  CoreWatchdog(CoreWatchdog&&) = delete;
  CoreWatchdog& operator=(CoreWatchdog&&) = delete;

  /// The core thread starts on `what` (a request's description, `tick`, …)
  /// at document `revision`, `playing` or not (what a pong sent from here says).
  void begin(std::string what, std::uint64_t revision, bool playing) {
    {
      const std::scoped_lock lock(mu_);
      what_ = std::move(what);
    }
    revision_.store(revision, std::memory_order_relaxed);
    playing_.store(playing, std::memory_order_relaxed);
    since_.store(Clock::now().time_since_epoch().count(), std::memory_order_release);
  }
  /// A request names itself once decoded (SessionOptions::activity).
  void name(std::string what) {
    const std::scoped_lock lock(mu_);
    what_ = std::move(what);
  }
  /// The item reported progress (a plugin command's progress(), PLUGIN_SDK.md
  /// "The watchdog"): it is alive, so its busy clock restarts — the supervisor
  /// judges `stuckMs` by the time since the last report, not since the start.
  void progress() {
    Clock::rep since = since_.load(std::memory_order_acquire);
    if (since != 0) (void)since_.compare_exchange_strong(since, Clock::now().time_since_epoch().count(), std::memory_order_acq_rel);
  }
  /// The core thread is back waiting on its queue.
  void end() {
    const Clock::rep since = since_.exchange(0, std::memory_order_acq_rel);
    if (since == 0) return;
    const auto took = Clock::now() - Clock::time_point(Clock::duration(since));
    if (took >= kBusyAfter) {
      PREMATION_LOG(warn, "core_slow")
          .kv("what", current())
          .kv("ms", static_cast<std::int64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(took).count()));
    }
  }

 private:
  [[nodiscard]] std::string current() {
    const std::scoped_lock lock(mu_);
    return what_;
  }
  void run() {
    Clock::rep reported = 0;  // the busy episode already reported (its start)
    auto nextReport = Clock::time_point{};
    while (!stop_.load(std::memory_order_acquire)) {
      std::this_thread::sleep_for(std::chrono::milliseconds(250));
      const Clock::rep since = since_.load(std::memory_order_acquire);
      const auto now = Clock::now();
      const auto start = Clock::time_point(Clock::duration(since));
      const auto busy = since == 0 ? Clock::duration::zero() : now - start;
      answer_pings(now, busy);
      if (since == 0) continue;
      if (busy < kBusyAfter) continue;
      if (since == reported && now < nextReport) continue;
      reported = since;
      nextReport = now + kBusyAfter;
      PREMATION_LOG(warn, "core_busy")
          .kv("what", current())
          .kv("ms", static_cast<std::int64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(now - start).count()));
    }
  }

  /// The host's newest ping, answered from here when the core is deep in an
  /// item (`busy`, zero between items) or when the ping itself has waited
  /// kAnswerPingsAfter behind a queue of shorter items.
  void answer_pings(Clock::time_point now, Clock::duration busy) {
    if (!pings_) return;
    const std::uint64_t nonce = pings_->nonce.load(std::memory_order_acquire);
    if (nonce == 0 || nonce == answered_) return;
    const auto arrived = Clock::time_point(Clock::duration(pings_->arrivedAt.load(std::memory_order_relaxed)));
    const auto age = now - arrived;
    if (busy < kAnswerPingsAfter && age < kAnswerPingsAfter) return;
    answered_ = nonce;
    api::FramePong pong;
    pong.nonce = nonce;
    pong.revision = revision_.load(std::memory_order_relaxed);
    pong.playing = playing_.load(std::memory_order_relaxed);
    pong.queued = 0;
    pong.busy_ms = static_cast<std::uint32_t>(
        std::min<std::int64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(busy).count(), UINT32_MAX));
    pong.busy = current();
    send_(frames::Message{.v = std::move(pong)});
  }

  PingSlot pings_;
  SendFrames send_;
  std::uint64_t answered_ = 0;  // watchdog thread only
  std::mutex mu_;
  std::string what_;
  std::atomic<std::uint64_t> revision_{0};
  std::atomic<bool> playing_{false};
  std::atomic<Clock::rep> since_{0};  // 0 = idle
  std::atomic<bool> stop_{false};
  // Not std::jthread: Apple's libc++ gates it behind -fexperimental-library
  // (core/joining_thread.hpp). Last: joined before the members it reads go.
  JoiningThread thread_;
};

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
      .kv("pixelStream", pipes.pixelsOut.valid())
      .kv("noGpu", options.noGpu)
      .kv("hostPid", options.render.hostPid)
      .kv("gpuVendor", options.render.vendorId);

  io::FramedWriter commandOut(pipes.commandOut, "command");
  io::FramedWriter framesOut(pipes.framesOut, "frames");
  // Route A's pixel stream (fd 5): only when the host opened it.
  io::FramedWriter pixelsOut(pipes.pixelsOut, "pixels");
  commandOut.start();
  framesOut.start();
  if (pixelsOut.valid()) pixelsOut.start();
  ProcessOutbox outbox(commandOut, framesOut);
  BlockingQueue<CoreItem> queue;
  const auto sendFrames = [&outbox](const frames::Message& m) { outbox.send_frames(m); };
  const PingSlot pings = std::make_shared<PingState>();

  // G1: the native plugin host. Declared before the render thread and the
  // session so it outlives both (the render glue and the document reach it
  // through PluginHost::active()). Absent when no plugin folder is configured.
  // A plugin command's progress() reaches the core watchdog (declared below,
  // after the host is made): set once it exists, cleared before it goes.
  std::function<void()> coreProgress;
  std::unique_ptr<plugins::PluginHost> pluginHost;
  std::vector<std::string> pluginFolders = options.pluginPaths;  // P7b: also a child job's (child_job.hpp)
  {
    if (const std::optional<std::string> env = os::env_var("PREMATION_PLUGIN_PATH")) {
      std::string_view rest = *env;
      while (!rest.empty()) {
        const std::size_t cut = rest.find(';');
        if (cut != 0) pluginFolders.emplace_back(rest.substr(0, cut));
        if (cut == std::string_view::npos) break;
        rest.remove_prefix(cut + 1);
      }
    }
    if (!pluginFolders.empty()) {
      plugins::HostOptions ho;
      ho.searchPaths.assign(pluginFolders.begin(), pluginFolders.end());
      ho.journal = options.pluginJournal;
      ho.disabled = options.pluginDisabled;
      if (!options.pluginRevoked.empty()) ho.revoked = plugins::read_revoked_file(options.pluginRevoked);
      ho.entitlement = options.pluginEntitlement;
      ho.onProgress = [&coreProgress] {
        if (coreProgress) coreProgress();
      };
      pluginHost = std::make_unique<plugins::PluginHost>(std::move(ho));
      const std::vector<plugins::PluginRecord> recs = pluginHost->scan();
      PREMATION_LOG(info, "plugins_scanned").kv("count", static_cast<std::uint64_t>(recs.size()));
    }
  }
#if !defined(PREMATION_ENGINE_HEADLESS)
  std::unique_ptr<render::RenderThread> gpuSink;
#endif
  std::unique_ptr<SimulatedSink> simSink;
  FrameSink* sink = nullptr;
#if !defined(PREMATION_ENGINE_HEADLESS)
  render::RenderOptions renderOptions = options.render;
  if (pixelsOut.valid()) {
    renderOptions.sendPixels = [&pixelsOut](std::vector<std::uint8_t> framed) {
      return pixelsOut.send(std::move(framed));
    };
  }
#endif
#if defined(PREMATION_HAVE_SCENE)
  // D2w: the viewport draws the engine's own document through the render
  // graph (scene/engine_frames.hpp). PREMATION_ENGINE_SCENE=0 keeps C2's quads.
  // --no-gpu simulates the FRAMES only: the frame builder still runs, so text
  // layout, fonts, the rig and the conversions answer as in the shipped engine
  // (the UI suites and CI run this way). Its frames go to the simulated sink.
  const bool useScene = os::env_var("PREMATION_ENGINE_SCENE").value_or("1") != "0";
  scene::EngineFramesOptions sceneOptions;
  sceneOptions.fontsManifest = os::env_var("PREMATION_FONTS_MANIFEST").value_or("");
  std::unique_ptr<FrameBuilder> frameBuilder;
  std::unique_ptr<MediaClock> mediaClock;
  if (useScene && options.noGpu) {
    frameBuilder = scene::make_frame_builder(sceneOptions);
  } else if (useScene) {
    renderOptions.makeDrawer = scene::make_drawer_factory(sceneOptions);
    frameBuilder = scene::make_frame_builder(sceneOptions);
    // E2: the document's sound, and the audio clock pacing playback.
    // PREMATION_AUDIO_DEVICE=null plays through the steady-clock NullDevice.
    std::string audioError;
    mediaClock = scene::make_media_clock(os::env_var("PREMATION_AUDIO_DEVICE").value_or("") != "null", audioError);
    frameBuilder->bind_audio(mediaClock.get());
  }
  // convertLayer's text outlines come from the frame builder's fonts
  // (Session::handler_ctx). Without the scene (PREMATION_ENGINE_SCENE=0) the
  // conversions answer `unsupported`.
#endif
#if defined(PREMATION_ENGINE_HEADLESS)
  // No Dawn in this build: frames are always simulated (as --no-gpu).
  simSink = std::make_unique<SimulatedSink>(sendFrames, options.render.slots);
  sink = simSink.get();
#else
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
#endif

  // Readers block in ReadFile/read with no portable way to interrupt them; at
  // shutdown they are detached and die with the process (they touch only the
  // queue and the sinks, which outlive them until exit).
  std::thread(command_reader, pipes.commandIn, std::ref(queue)).detach();
  if (pipes.framesIn.valid()) {
#if !defined(PREMATION_ENGINE_HEADLESS)
    if (gpuSink) {
      render::RenderThread* r = gpuSink.get();
      std::thread([in = pipes.framesIn, &queue, pings, r] {
        frames_reader(in, queue, pings, [r](std::uint32_t g, std::uint32_t s) { r->release(g, s); });
      }).detach();
    } else
#endif
    {
      SimulatedSink* r = simSink.get();
      std::thread([in = pipes.framesIn, &queue, pings, r] {
        frames_reader(in, queue, pings, [r](std::uint32_t g, std::uint32_t s) { r->release(g, s); });
      }).detach();
    }
  }

  SessionOptions sessionOptions;
  sessionOptions.engineVersion = kEngineVersion;
  // listFonts: the installed fonts (CoreText / DirectWrite / fontconfig), enumerated
  // on the first query, not at start-up.
  sessionOptions.systemFonts = [](const std::string& query) {
    api::FontList list;
    for (const raster::CatalogFace& f : raster::find_system_fonts(query)) {
      api::FontInfo info;
      info.family = f.family;
      info.style = f.style;
      info.post_script_name = f.postScriptName;
      info.weight = f.weight;
      info.italic = f.italic;
      info.scripts = f.scripts;
      info.path = f.path;
      for (const raster::CatalogAxis& a : f.axes) {
        info.variable_axes.push_back(api::FontAxisInfo{a.tag, a.name, a.min, a.max, a.defaultValue});
      }
      list.fonts.push_back(std::move(info));
    }
    return list;
  };
  // refreshFonts: a font installed or removed while the engine runs (the cheap
  // OS list check; the full re-read only on a change).
  sessionOptions.refreshSystemFonts = [] { return raster::refresh_system_fonts(); };
  // importBytes caches bytes as files where main says (PREMATION_SESSION_FOOTAGE,
  // <userData>/session-footage): the engine's document never holds a blob: URL.
  sessionOptions.footageDir = os::env_var("PREMATION_SESSION_FOOTAGE").value_or("");
  // Idle render-ahead (Session::idle_prefetch) is on unless PREMATION_IDLE_PREFETCH=0.
  sessionOptions.idlePrefetch = os::env_var("PREMATION_IDLE_PREFETCH").value_or("1") != "0";
  sessionOptions.hostMemory = [] {
    const os::MemoryStatus machine = os::memory_status();
    return SessionOptions::HostMemory{os::process_memory_bytes(), machine.physicalBytes, machine.availableBytes};
  };
  sessionOptions.testPorts = options.testPorts;
  sessionOptions.testPortsDir = options.testPortsDir;
  CoreWatchdog watchdog(pings, sendFrames);
  sessionOptions.activity = [&watchdog](std::string what) { watchdog.name(std::move(what)); };
  coreProgress = [&watchdog] { watchdog.progress(); };
  struct ForgetWatchdog {
    std::function<void()>* hook;
    explicit ForgetWatchdog(std::function<void()>& h) : hook(&h) {}
    ForgetWatchdog(const ForgetWatchdog&) = delete;
    ForgetWatchdog& operator=(const ForgetWatchdog&) = delete;
    ForgetWatchdog(ForgetWatchdog&&) = delete;
    ForgetWatchdog& operator=(ForgetWatchdog&&) = delete;
    ~ForgetWatchdog() { *hook = nullptr; }
  } const forgetWatchdog{coreProgress};
#if defined(PREMATION_HAVE_JOBS)
  // importFiles / importBytes / relink: the jobs' decoders probe the file (ffmpeg + the OS still codec).
  sessionOptions.mediaProbe = [](const std::string& path, js::Json& facts, std::string& error) {
    return jobs::probe_media(path, facts, error);
  };
#endif
#if defined(PREMATION_ENGINE_HEADLESS)
  // Tests and CI only (never shipped): no frame builder, but the rig is
  // GPU- and raster-free (engine_scene_core) — getRigPose and the overlay's
  // rig answer as in the shipped engine. No media hooks: an image layer's
  // mesh falls back to its box grid.
  scene::DocRigQueries headlessRig;
#endif
#if defined(PREMATION_HAVE_JOBS)
  // Live performance input (live/live_host.hpp): its child process is started
  // from this executable. Declared before the session, so it outlives it.
  const std::unique_ptr<LivePort> liveInput = live::make_live_host(os::executable_path());
#endif
  Session session(outbox, *sink, sessionOptions);
#if defined(PREMATION_ENGINE_HEADLESS)
  session.set_rig_queries(&headlessRig);
#endif
#if defined(PREMATION_HAVE_JOBS)
  session.set_live_input(liveInput.get());
#endif
#if defined(PREMATION_HAVE_SCENE)
  session.set_frame_builder(frameBuilder.get());
  session.set_media_clock(mediaClock.get());
#endif
#if defined(PREMATION_HAVE_JOBS)
  // Engine jobs (jobs/job_api.hpp). The kinds are only read by `prepare` on
  // this thread (a running job's work owns copies of its inputs); a
  // model-loading job's work runs in a child of this executable (`--job`),
  // proxies and renders use the export's ffmpeg.
  jobs::set_child_executable(os::executable_path());
  // P7b: a child job reads plugin footage through a plugin host of its own, started
  // from this engine's folders with every plugin this engine does not run right now
  // listed disabled (child_job.hpp). Reset before the host goes away.
  struct ChildPluginsReset {
    ChildPluginsReset() = default;
    ~ChildPluginsReset() { jobs::set_child_plugins({}); }
    ChildPluginsReset(const ChildPluginsReset&) = delete;
    ChildPluginsReset& operator=(const ChildPluginsReset&) = delete;
    ChildPluginsReset(ChildPluginsReset&&) = delete;
    ChildPluginsReset& operator=(ChildPluginsReset&&) = delete;
  } const childPluginsReset;
  if (pluginHost) {
    jobs::set_child_plugins([host = pluginHost.get(), folders = pluginFolders, revoked = options.pluginRevoked,
                             entitlement = options.pluginEntitlement] {
      jobs::ChildPlugins cp;
      cp.paths = folders;
      const std::set<std::string, std::less<>> off = host->contrib().importers_off();
      for (const plugins::PluginRecord& r : host->plugins()) {
        if (r.status != plugins::PluginStatus::loaded || off.contains(r.id)) cp.disabled.push_back(r.id);
      }
      cp.revoked = revoked;
      cp.entitlement = entitlement;
      return cp;
    });
  }
  jobs::set_ffmpeg_executable(os::env_var("PREMATION_FFMPEG").value_or(""));
  jobs::register_child_works();
  const std::unique_ptr<jobs::JobKinds> jobKinds = jobs::make_job_kinds();
  session.set_job_kinds(jobKinds.get());
#endif
  int exitCode = kExitOk;
  bool running = true;
  while (running && !session.finished()) {
    std::optional<CoreItem> item = queue.pop_until(session.next_deadline());
    const auto now = Clock::now();
    if (item) {
      switch (item->kind) {
        case CoreItem::Kind::frame:
          watchdog.begin("message", session.revision(), session.playing());
          session.on_frame(item->bytes, now);
          watchdog.end();
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
    watchdog.begin(session.playing() ? "tick (playing)" : "tick", session.revision(), session.playing());
    session.tick(now);
    watchdog.end();
    // The 1 ms scheduler timer while frames must flow steadily: playback, and
    // an open UI gesture (a drag renders a frame per pointer step — without
    // this it is quantised to Windows' 15.6 ms tick, ~45 fps and uneven).
    os::high_resolution_timer(session.playing() || session.gesture_open());
  }
  os::high_resolution_timer(false);
  PREMATION_LOG(info, "shutdown").kv("exitCode", exitCode).kv("revision", session.revision());

#if !defined(PREMATION_ENGINE_HEADLESS)
  if (gpuSink) gpuSink->stop();
#endif
  commandOut.close(std::chrono::milliseconds(500));
  framesOut.close(std::chrono::milliseconds(200));
  if (pixelsOut.valid()) pixelsOut.close(std::chrono::milliseconds(200));
  if (commandOut.detached() || framesOut.detached() || pixelsOut.detached()) {
    // A writer is stuck in a write nobody will read; destroying it would free
    // memory its thread still uses. End here without unwinding.
    std::_Exit(exitCode);
  }
  return exitCode;
}

#if defined(PREMATION_HAVE_JOBS)
namespace {

/// A child job's plugin host (child_job.hpp ChildPluginScope).
class ChildPluginHost final : public jobs::ChildPluginScope {
 public:
  explicit ChildPluginHost(std::unique_ptr<plugins::PluginHost> host) : host_(std::move(host)) {}

 private:
  std::unique_ptr<plugins::PluginHost> host_;
};

}  // namespace

int run_live_child(const std::string& settingsFile) { return live::live_main(settingsFile); }

namespace {

/// As the export process starts its host (export_job.cpp): the engine's folders, disabled set,
/// revocations and entitlement — no crash journal (a crash here fails the job, not the engine).
std::unique_ptr<jobs::ChildPluginScope> start_child_plugins(const jobs::ChildPlugins& cp) {
  plugins::HostOptions ho;
  ho.searchPaths.assign(cp.paths.begin(), cp.paths.end());
  ho.disabled = cp.disabled;
  if (!cp.revoked.empty()) ho.revoked = plugins::read_revoked_file(cp.revoked);
  ho.entitlement = cp.entitlement;
  auto host = std::make_unique<plugins::PluginHost>(std::move(ho));
  const std::vector<plugins::PluginRecord> recs = host->scan();
  PREMATION_LOG(info, "job_plugins").kv("count", static_cast<std::uint64_t>(recs.size()));
  return std::make_unique<ChildPluginHost>(std::move(host));
}

}  // namespace

int run_job_child(const std::string& jobFile) { return jobs::child_main(jobFile, start_child_plugins); }

int run_job_worker(const std::string& startFile) {
  jobs::register_child_works();
  return jobs::worker_main(startFile, std::cin, std::cout, start_child_plugins);
}
#endif

}  // namespace premation
