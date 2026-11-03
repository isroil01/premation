#include "host.hpp"

#include <algorithm>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
#include <thread>

#include "asset_image.hpp"
#include "fxstate.hpp"
#include "journal.hpp"
#include "json.hpp"
#include "log.hpp"
#include "manifest.hpp"
#include "transform.hpp"
#include "module.hpp"
#include "presets.hpp"
#include "values.hpp"
#include "workers.hpp"
#include "contrib.hpp"
#include "fx_wire.hpp"     // SDK 1.2: decode_overlay_scene
#include "scene_eval.hpp"  // SDK 1.2: overlay_scene

namespace fs = std::filesystem;
using premation::plugins::CheckoutRequest;
using premation::plugins::CheckoutSource;
using premation::plugins::ParamSpec;
using premation::plugins::ParamUi;
using premation::plugins::PluginHost;

namespace premation::plugins {
/// One call's PrParamDefs and what their pointers point into besides the specs and values:
/// the GRADIENT stops decoded to linear light (the document keeps them sRGB-encoded).
struct ParamDefs {
  std::vector<PrParamDef> defs;
  std::vector<std::vector<double>> owned;  ///< moved with the struct: the inner buffers stay put
};
}  // namespace premation::plugins

// ── the per-call context the SDK hands back to every callback ─────────────
// (declared `typedef struct PrHost PrHost` in pr_types.h: global namespace)
struct PrHost {
  PluginHost* host = nullptr;
  PrCmd cmd = PR_CMD_ABOUT;
  /// The watchdog slot of a P7 call (command, importer, output module), whose
  /// progress() restarts its clock; -1 for every other selector.
  int progressSlot = -1;
  // PARAMS_SETUP
  std::vector<ParamSpec>* declared = nullptr;
  std::vector<std::string> groups;
  std::string setupError;
  // SMART_PRE_RENDER
  std::vector<CheckoutRequest>* checkouts = nullptr;
  std::uint32_t numParams = 0;
  // SMART_RENDER / SMART_RENDER_GPU
  CheckoutSource* source = nullptr;
  // USER_CHANGED_PARAM / UPDATE_PARAMS_UI
  std::vector<std::pair<std::uint32_t, std::array<double, 4>>>* writes = nullptr;
  std::vector<std::pair<std::uint32_t, std::vector<std::uint8_t>>>* arbWrites = nullptr;
  std::vector<ParamUi>* ui = nullptr;
  const std::vector<ParamSpec>* params = nullptr;
  /// Handles created during a render selector: disposed when it returns.
  std::vector<PrHandle> scoped;
  bool renderSelector = false;
  /// SDK 1.1 — DRAW_OVERLAY's draw list.
  std::vector<premation::doc::NativeOverlayItem>* overlay = nullptr;
  /// SDK 1.2 — overlay_set_space: the space of the overlay items that follow (PR_OVERLAY_SPACE_*).
  std::uint32_t overlaySpace = PR_OVERLAY_SPACE_LAYER;
  /// SDK 1.2 — DRAW_OVERLAY / OVERLAY_DRAG carry the comp camera & co. (the scene callbacks answer).
  bool overlayScene = false;
  /// SDK 1.1 — the render selector's inputs and effect (get_comp_camera, …).
  const premation::plugins::RenderInputs* inputs = nullptr;
  /// SDK 1.1 — get_asset_bytes: each FILE param's bytes, read once per call (iterate workers may ask too).
  std::mutex assetMutex;
  std::map<std::uint32_t, std::vector<std::uint8_t>> assetBytes;
  std::uint32_t outFlags = 0;
  /// iterate(): a job crashed on a worker (the instance is disabled like a crash on the caller).
  premation::plugins::Fault iterateFault;
  std::atomic<bool> iterateStop{false};
  // ── SDK 1.2 ──
  /// SMART_PRE_RENDER: checkout_time requests (nullptr = not collected: the call ignores them).
  std::vector<premation::plugins::TimeRequest>* times = nullptr;
  /// The effect the render selector runs (checkout_param builds its PrParamDefs).
  const premation::plugins::EffectSpec* effect = nullptr;
  /// checkout_param: the defs built per sample (index into inputs->samples; SIZE_MAX = the frame) —
  /// alive until the selector returns. Guarded by assetMutex (iterate workers may ask too).
  std::map<std::size_t, premation::plugins::ParamDefs> sampleDefs;
  /// get_asset_image / _gpu / get_asset_sibling_bytes: what the call handed out, alive until it returns.
  std::map<std::uint32_t, std::shared_ptr<const premation::plugins::AssetImage>> assetImages;
  std::map<std::uint32_t, PrWorld> assetWorlds;
  std::map<std::pair<std::uint32_t, std::string>, std::vector<std::uint8_t>> siblingBytes;
};

namespace premation::plugins {
namespace {

// ── colour params: the document's sRGB-encoded 0..1 ↔ the plugin's linear light ──
// The IEC 61966-2-1 transfer the built-in effects decode their colours with
// (scene/effects_spatial_c.cpp `s2l`, render_graph/rg_math.hpp srgb_to_linear):
// every world a plugin sees is linear working space, and so are its colours
// (After Effects delivers PF_ADD_COLOR values in the project's working space).
double srgb_to_linear(double c) noexcept { return c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4); }
double linear_to_srgb(double c) noexcept {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * std::pow(std::max(c, 0.0), 1 / 2.4) - 0.055;
}

// ── host memory handles ─────────────────────────────────────────────────

class HandleTable {
 public:
  PrHandle make(std::size_t size) {
    const std::scoped_lock lock(mutex_);
    const PrHandle h = next_++;
    blocks_[h].assign(size, 0);
    return h;
  }
  void* lock(PrHandle h) {
    const std::scoped_lock lock(mutex_);
    const auto it = blocks_.find(h);
    return it == blocks_.end() ? nullptr : it->second.data();
  }
  std::size_t size(PrHandle h) {
    const std::scoped_lock lock(mutex_);
    const auto it = blocks_.find(h);
    return it == blocks_.end() ? 0 : it->second.size();
  }
  bool resize(PrHandle h, std::size_t size) {
    const std::scoped_lock lock(mutex_);
    const auto it = blocks_.find(h);
    if (it == blocks_.end()) return false;
    it->second.resize(size, 0);
    return true;
  }
  void dispose(PrHandle h) {
    const std::scoped_lock lock(mutex_);
    blocks_.erase(h);
  }
  std::vector<std::uint8_t> bytes(PrHandle h) {
    const std::scoped_lock lock(mutex_);
    const auto it = blocks_.find(h);
    return it == blocks_.end() ? std::vector<std::uint8_t>{} : it->second;
  }
  PrHandle from(const std::vector<std::uint8_t>& data) {
    const std::scoped_lock lock(mutex_);
    const PrHandle h = next_++;
    blocks_[h] = data;
    return h;
  }

 private:
  std::mutex mutex_;
  std::unordered_map<PrHandle, std::vector<std::uint8_t>> blocks_;  // node-based: data() is stable across rehash
  PrHandle next_ = 1;
};

std::uint64_t fnv1a(const std::vector<std::uint8_t>& bytes) {
  std::uint64_t h = 1469598103934665603ULL;
  for (const std::uint8_t b : bytes) {
    h ^= b;
    h *= 1099511628211ULL;
  }
  return h ^ bytes.size();
}

}  // namespace

// ── one loaded plugin module ─────────────────────────────────────────────

struct Plugin {
  Manifest manifest;
  fs::path dir;
  fs::path binary;
  std::unique_ptr<DynamicLibrary> lib;
  /// The module's PremationPluginInfo (alive while `lib` is mapped): a failed reload binds the P7
  /// entry points back to it.
  const PrPluginInfo* info = nullptr;
  PluginStatus status = PluginStatus::failed;
  std::string error;
  /// SDK 1.2: the presets the bundle ships (manifest `presets`, presets/*.json).
  std::vector<PresetSpec> presets;
  std::vector<std::unique_ptr<EffectSpec>> effects;
  /// Serialises every selector except the render ones of THREADED_RENDER effects.
  std::recursive_mutex serial;
  bool gpu = false;
  bool userDisabled = false;
  /// Disabled at start and never loaded: enabling it loads the bundle.
  bool deferred = false;
};

/// A plugin record replaced by a reload or a retry. Kept for the life of the process, its module
/// pinned: effect specs, instances and GPU data may still point into it.
void retire(std::unique_ptr<Plugin> p) {
  static std::mutex mutex;
  static std::vector<std::unique_ptr<Plugin>> retired;  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables): never freed on purpose
  const std::scoped_lock lock(mutex);
  retired.push_back(std::move(p));
}

struct Instance {
  std::shared_mutex mutex;  ///< shared: render; exclusive: (re)setup
  const EffectSpec* effect = nullptr;
  PrHandle sequence = 0;
  std::uint64_t flatHash = 0;
  bool built = false;
  std::atomic<std::uint64_t> lastFrame{0};
  std::atomic<std::int32_t> layerW{0};
  std::atomic<std::int32_t> layerH{0};
};

/// An instance held for one render: alive (shared ownership) and its sequence data read-locked.
struct InstanceLease {
  std::shared_ptr<Instance> inst;                 // declared first: destroyed after the lock
  std::shared_lock<std::shared_mutex> lock;
  [[nodiscard]] PrHandle sequence() const noexcept { return inst ? inst->sequence : 0; }
  explicit operator bool() const noexcept { return inst != nullptr; }
};

// ── the watchdog ──────────────────────────────────────────────────────────

class Watchdog {
 public:
  static constexpr std::size_t kSlots = 64;
  Watchdog(std::chrono::milliseconds timeout, std::function<void(std::size_t slot)> onHang)
      : timeout_(timeout), onHang_(std::move(onHang)) {
    if (timeout_.count() > 0) thread_ = std::thread([this] { loop(); });
  }
  ~Watchdog() {
    {
      const std::scoped_lock lock(mutex_);
      quit_ = true;
    }
    cv_.notify_all();
    if (thread_.joinable()) thread_.join();
  }
  Watchdog(const Watchdog&) = delete;
  Watchdog& operator=(const Watchdog&) = delete;
  Watchdog(Watchdog&&) = delete;
  Watchdog& operator=(Watchdog&&) = delete;

  struct Slot {
    std::atomic<std::int64_t> start{0};  ///< steady ns; 0 = free
    std::atomic<bool> hung{false};
    std::string plugin;  ///< written by the owner before `start`, read by the watchdog after
    std::int32_t cmd = 0;
  };

  int enter(const std::string& plugin, std::int32_t cmd) {
    if (timeout_.count() <= 0) return -1;
    for (std::size_t i = 0; i < kSlots; ++i) {
      bool expected = false;
      if (claimed_.at(i).compare_exchange_strong(expected, true, std::memory_order_acquire)) {
        Slot& s = slots_.at(i);
        s.plugin = plugin;
        s.cmd = cmd;
        s.hung.store(false, std::memory_order_relaxed);
        s.start.store(now_ns(), std::memory_order_release);
        return static_cast<int>(i);
      }
    }
    return -1;
  }
  /// The call in `slot` reported progress: its clock restarts (a call already
  /// declared hung stays hung — the engine is ending).
  void touch(int slot) {
    if (slot < 0) return;
    Slot& s = slots_.at(static_cast<std::size_t>(slot));
    if (s.start.load(std::memory_order_acquire) == 0 || s.hung.load(std::memory_order_acquire)) return;
    s.start.store(now_ns(), std::memory_order_release);
  }
  /// True when the call was declared hung while it ran.
  bool leave(int slot) {
    if (slot < 0) return false;
    Slot& s = slots_.at(static_cast<std::size_t>(slot));
    s.start.store(0, std::memory_order_release);
    const bool hung = s.hung.load(std::memory_order_acquire);
    claimed_.at(static_cast<std::size_t>(slot)).store(false, std::memory_order_release);
    return hung;
  }
  [[nodiscard]] const Slot& slot(std::size_t i) const { return slots_.at(i); }

 private:
  static std::int64_t now_ns() {
    // Supervision only — never a rendering input (CLAUDE.md determinism).
    return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
  }
  void loop() {
    std::unique_lock lock(mutex_);
    while (!quit_) {
      cv_.wait_for(lock, std::chrono::milliseconds(25));
      if (quit_) return;
      const std::int64_t now = now_ns();
      const std::int64_t limit = std::chrono::duration_cast<std::chrono::nanoseconds>(timeout_).count();
      for (std::size_t i = 0; i < kSlots; ++i) {
        Slot& s = slots_.at(i);
        const std::int64_t start = s.start.load(std::memory_order_acquire);
        if (start == 0 || now - start < limit || s.hung.load(std::memory_order_relaxed)) continue;
        s.hung.store(true, std::memory_order_release);
        lock.unlock();
        onHang_(i);
        lock.lock();
      }
    }
  }

  std::chrono::milliseconds timeout_;
  std::function<void(std::size_t)> onHang_;
  std::array<std::atomic<bool>, kSlots> claimed_{};
  std::array<Slot, kSlots> slots_{};
  std::mutex mutex_;
  std::condition_variable cv_;
  bool quit_ = false;
  std::thread thread_;
};

// ── Impl ─────────────────────────────────────────────────────────────────

namespace {
std::atomic<PluginHost*> g_active{nullptr};  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables): the engine's one attached host
}

struct PluginHost::Impl {
  explicit Impl(PluginHost& owner, HostOptions o) : self(owner), options(std::move(o)) {}
  PluginHost& self;
  HostOptions options;
  std::unique_ptr<CrashJournal> journal;
  std::unique_ptr<WorkerPool> pool;
  std::unique_ptr<Watchdog> watchdog;
  HandleTable handles;
  PrHostSuite suite{};

  mutable std::shared_mutex pluginsMutex;
  std::vector<std::unique_ptr<Plugin>> plugins;
  std::unordered_map<std::string, EffectSpec*> effects;  ///< match name → spec
  std::unordered_map<const EffectSpec*, Plugin*> ownerOf;

  std::mutex instancesMutex;
  /// shared_ptr: the table and every in-flight render (InstanceLease) own an
  /// instance together, so collecting an idle one never frees it under a render.
  std::unordered_map<std::string, std::shared_ptr<Instance>> instances;

  mutable std::mutex failuresMutex;
  std::map<std::string, InstanceFailure> failures;  ///< instance → why it is disabled

  // ── SDK 1.4 (T) simulations ──
  struct SimMemo {
    std::uint64_t inputsKey = 0;
    std::int64_t step = 0;
    /// chain[k]: a hash of every input of frames 0..k — what state k is a function of.
    std::vector<std::uint64_t> chain;
  };
  struct SimKept {
    std::uint64_t chain = 0;
    std::vector<std::uint8_t> bytes;
    std::uint64_t lastUse = 0;
  };
  mutable std::mutex simMutex;
  std::map<std::string, SimMemo, std::less<>> simMemo;                // instance → its frames' input chain
  std::map<std::pair<std::string, std::int64_t>, SimKept> simKept;  // (instance, frame) → state
  std::size_t simBytes = 0;
  std::size_t simBudget = std::size_t{256} << 20U;
  std::uint64_t simClock = 0;
  SimStats simStats;
  void sim_evict();

  std::mutex gpuMutex;
  std::map<std::pair<const EffectSpec*, std::uint32_t>, PrHandle> gpuData;
  std::map<std::pair<const EffectSpec*, std::uint32_t>, std::string> gpuFailed;

  // ── plumbing ──
  Plugin* plugin_of(const EffectSpec* e) const {
    const auto it = ownerOf.find(e);
    return it == ownerOf.end() ? nullptr : it->second;
  }

  struct Frame {
    PrEffectMainFn fn = nullptr;
    PrCmd cmd = 0;
    const PrInData* in = nullptr;
    PrOutData* out = nullptr;
    PrParamDef* const* params = nullptr;
    PrWorld* output = nullptr;
    void* extra = nullptr;
    PrErr result = PR_ERR_NONE;
    bool threw = false;
  };

  static void trampoline(void* p) {
    auto* f = static_cast<Frame*>(p);
    try {
      f->result = f->fn(f->cmd, f->in, f->out, f->params, f->output, f->extra);
    } catch (...) {  // a C++ exception must not cross the C ABI; it counts as a crash
      f->threw = true;
    }
  }

  /// One selector call, fully guarded: journal slot, watchdog slot, fault guard.
  CallResult invoke(const std::string& pluginId, PrEffectMainFn fn, PrCmd cmd, const PrInData* in, PrOutData* out,
                    PrParamDef* const* params, PrWorld* output, void* extra) {
    Frame f;
    f.fn = fn;
    f.cmd = cmd;
    f.in = in;
    f.out = out;
    f.params = params;
    f.output = output;
    f.extra = extra;
    const int js = journal ? journal->enter(pluginId, cmd) : -1;
    const int ws = watchdog ? watchdog->enter(pluginId, cmd) : -1;
    Fault fault = guarded_call(&Impl::trampoline, &f);
    const bool hung = watchdog ? watchdog->leave(ws) : false;
    if (journal) journal->leave(js);
    CallResult r;
    if (!fault && f.threw) fault = {FaultKind::cpp_exception, 0};
    if (!fault && hung) fault = {FaultKind::hang, 0};
    if (fault) {
      r.fault = fault;
      r.message = std::string(to_string(fault.kind)) + " in " + std::string(command_name(cmd));
      return r;
    }
    r.ok = f.result == PR_ERR_NONE;
    if (!r.ok) {
      const std::size_t n = strnlen(out->return_msg, sizeof(out->return_msg));
      r.message = n > 0 ? std::string(out->return_msg, n)
                        : std::string(command_name(cmd)) + " returned error " + std::to_string(f.result);
    }
    return r;
  }

  static void reset_out(PrOutData& out, PrHandle global, PrHandle sequence) {
    out = PrOutData{};
    out.struct_size = sizeof(PrOutData);
    out.global_data = global;
    out.sequence_data = sequence;
  }

  PrInData base_in(PrHost& ctx, const EffectSpec& e) const {
    PrInData in{};
    in.struct_size = sizeof(PrInData);
    in.host_sdk_version = PR_SDK_VERSION;
    in.host = &suite;
    in.host_ref = &ctx;
    in.match_name = e.matchName.c_str();
    in.num_params = static_cast<std::uint32_t>(e.params.size() + 1);
    in.time_scale = PR_TIME_SCALE;
    in.frame_rate = 30;
    in.project_bit_depth = 16;
    in.quality = PR_QUALITY_HIGH;
    in.global_data = e.globalData;
    in.pixel_scale_x = 1;
    in.pixel_scale_y = 1;
    in.layer_to_world[0] = 1;
    in.layer_to_world[4] = 1;
    in.layer_to_world[8] = 1;
    return in;
  }

  void record_failure(const RenderInputs& in, const EffectSpec& e, const std::string& message) {
    const std::scoped_lock lock(failuresMutex);
    failures[in.instance] = InstanceFailure{in.instance, in.layerId, e.pluginId, e.matchName, message};
  }

  /// A fault quarantines the whole plugin when it hung (its thread may still run) or
  /// happened outside rendering; a render fault disables just the instance.
  void on_fault(Plugin& p, const EffectSpec* e, const RenderInputs* in, const CallResult& r) {
    PREMATION_LOG(error, "plugin_fault").kv("plugin", p.manifest.id).kv("what", r.message);
    if (r.fault.kind == FaultKind::hang) {
      p.status = PluginStatus::quarantined;
      p.error = "hung: " + r.message;
      if (journal) journal->quarantine(p.manifest.id, p.error);
      doc::NativeEffects::set_available(p.manifest.id, false);
      if (p.lib) p.lib->pin();
    }
    if (in != nullptr && e != nullptr) record_failure(*in, *e, "plugin '" + p.manifest.id + "' crashed (" + r.message + "); the effect is disabled on this layer");
    if (p.lib) p.lib->pin();  // never unmap code a crashed plugin may still be running
  }

  // ── discovery + loading ──
  /// Load the bundle at `dir` and list it. With `replacing` (reload): load it beside that plugin
  /// and swap it in only once it is fully set up; otherwise the old one stays and `why` says why.
  /// The plugin record, or nullptr (already known, or a failed reload).
  Plugin* load_bundle(const fs::path& dir, Plugin* replacing = nullptr, std::string* why = nullptr);
  Plugin* swap_in(std::unique_ptr<Plugin> fresh, Plugin& old, std::string* why);
  /// Developer Mode: copy the plugin's binary and the shared libraries beside it under
  /// options.shadowDir and return the copy to load ('' + `err` on failure). Core thread only.
  fs::path shadow_copy(const Plugin& p, std::string& err);
  std::uint64_t shadowGeneration = 0;
  std::set<std::string, std::less<>> shadowCleaned;
  /// Why a bundle requiring an entitlement may not load ('' when it may, or needs none).
  [[nodiscard]] std::string entitlement_lock(const Manifest& man) const;
  bool setup_effect(Plugin& p, EffectSpec& e);
  void register_document(const Plugin& p);
  // ── instances ──
  /// The instance for `in`, set up for its flat sequence data, held SHARED for
  /// the render (lock order everywhere: instancesMutex → Instance::mutex → Plugin::serial).
  /// Empty when setup failed (`r` says why).
  InstanceLease instance_for(const RenderInputs& in, const EffectSpec& e, Plugin& p, CallResult& r);
  bool ensure_setup(Instance& inst, const RenderInputs& in, const EffectSpec& e, Plugin& p, std::uint64_t hash, CallResult& r);
  void setdown(Instance& inst, Plugin& p);
  // ── params ──
  /// `values` (SDK 1.2 checkout_param): a sample's values instead of `in.values`.
  /// COLOR values and GRADIENT stops reach the plugin in linear light (the working space), decoded
  /// from the document's sRGB-encoded 0..1 — what the built-in effects do with theirs.
  ParamDefs param_defs(const EffectSpec& e, const RenderInputs& in, std::vector<PrParamDef*>& ptrs,
                       const std::vector<ParamValue>* values = nullptr) const;
  void fill_in_data(PrInData& d, const RenderInputs& in) const;
  CallResult call_render(Plugin& p, EffectSpec& e, const RenderInputs& in, PrHost& ctx, PrCmd cmd, PrWorld* output,
                         void* extra, PrHandle sequence);
};

// ── the callback suite ───────────────────────────────────────────────────

namespace {

PluginHost::Impl& impl_of(PrHost* h) { return h->host->impl(); }

PrHandle PR_CALL cb_handle_new(PrHost* h, std::size_t size) {
  if (h == nullptr) return 0;
  const PrHandle x = impl_of(h).handles.make(size);
  if (h->renderSelector) h->scoped.push_back(x);
  return x;
}
void* PR_CALL cb_handle_lock(PrHost* h, PrHandle x) { return h == nullptr ? nullptr : impl_of(h).handles.lock(x); }
std::size_t PR_CALL cb_handle_size(PrHost* h, PrHandle x) { return h == nullptr ? 0 : impl_of(h).handles.size(x); }
PrErr PR_CALL cb_handle_resize(PrHost* h, PrHandle x, std::size_t size) {
  return h != nullptr && impl_of(h).handles.resize(x, size) ? PR_ERR_NONE : PR_ERR_NOT_FOUND;
}
void PR_CALL cb_handle_dispose(PrHost* h, PrHandle x) {
  if (h != nullptr) impl_of(h).handles.dispose(x);
}

PrErr PR_CALL cb_add_param(PrHost* h, const PrParamDef* def) {
  if (h == nullptr || h->cmd != PR_CMD_PARAMS_SETUP || h->declared == nullptr) return PR_ERR_INVALID_CALLBACK;
  if (def == nullptr || def->struct_size < offsetof(PrParamDef, layer_id)) return PR_ERR_INVALID_PARAM;
  // Copy everything out of the plugin's struct before touching host state.
  ParamSpec s;
  s.type = def->type;
  s.id = def->id;
  s.flags = def->flags;
  s.name = def->name != nullptr ? std::string(def->name) : std::string();
  for (std::size_t i = 0; i < 4; ++i) s.def.at(i) = def->value[i];  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
  s.validMin = def->valid_min;
  s.validMax = def->valid_max;
  s.sliderMin = def->slider_min;
  s.sliderMax = def->slider_max;
  s.precision = def->precision;
  // SDK 1.2: the tooltip, from a module whose struct has the field (bounded: one line, not a manual).
  if (def->struct_size >= offsetof(PrParamDef, description) + sizeof(def->description) && def->description != nullptr) {
    s.description = std::string(def->description, strnlen(def->description, 1024));
  }
  if (def->type == PR_PARAM_POPUP && def->popup_choices != nullptr) {
    std::string all(def->popup_choices);
    std::size_t start = 0;
    for (;;) {
      const std::size_t bar = all.find('|', start);
      s.choices.push_back(all.substr(start, bar == std::string::npos ? std::string::npos : bar - start));
      if (bar == std::string::npos) break;
      start = bar + 1;
    }
  }
  const auto fail_with = [&](std::string why) {
    if (h->setupError.empty()) h->setupError = std::move(why);
    return PR_ERR_INVALID_PARAM;
  };
  if (s.type < PR_PARAM_LAYER || s.type > PR_PARAM_CUSTOM_UI) return fail_with("param '" + s.name + "': unknown type");
  if (s.type == PR_PARAM_CUSTOM_UI) {
    // SDK 1.3: no value of its own; value[0] is the box's height (0 = the default).
    s.def[0] = s.def[0] <= 0 || !std::isfinite(s.def[0]) ? 120.0 : std::clamp(s.def[0], 24.0, 600.0);
  }
  if (s.type >= PR_PARAM_STRING) {
    // SDK 1.1 types: their defaults live in the fields a 1.0 struct does not have.
    if (def->struct_size < offsetof(PrParamDef, file_missing) + sizeof(def->file_missing)) {
      return fail_with("param '" + s.name + "': a STRING / CURVE / GRADIENT / FILE param needs SDK 1.1");
    }
    s.flags |= PR_PARAM_FLAG_CANNOT_ANIMATE;
    if (def->text != nullptr) s.text = def->text;
    if (def->file_types != nullptr) s.fileTypes = def->file_types;
    // Defaults through the document's own reading (clamped, sorted, bounded).
    if (s.type == PR_PARAM_CURVE) {
      js::Json::Array pts;
      for (std::uint32_t i = 0; def->curve != nullptr && i < def->curve_count && i < 256; ++i) {
        pts.push_back(js::Json::array({js::Json::number(def->curve[2 * i] * 255), js::Json::number(def->curve[2 * i + 1] * 255)}));  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      }
      s.curve = doc::native_curve(js::Json::array(std::move(pts)));
    }
    if (s.type == PR_PARAM_GRADIENT) {
      js::Json::Array stops;
      for (std::uint32_t i = 0; def->gradient != nullptr && i < def->gradient_count && i < 256; ++i) {
        js::Json::Array st;
        for (std::uint32_t k = 0; k < 5; ++k) st.push_back(js::Json::number(def->gradient[5 * i + k]));  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
        stops.push_back(js::Json::array(std::move(st)));
      }
      s.gradient = doc::native_gradient(js::Json::array(std::move(stops)));
    }
  }
  if (s.type == PR_PARAM_GROUP_END) {
    if (h->groups.empty()) return fail_with("GROUP_END without a GROUP_START");
    h->groups.pop_back();
  }
  if (s.id == 0) return fail_with("param '" + s.name + "': id 0 (ids start at 1)");
  for (const ParamSpec& other : *h->declared) {
    if (other.id == s.id) return fail_with("param id " + std::to_string(s.id) + " declared twice");
  }
  if (s.type == PR_PARAM_POPUP && (s.choices.empty() || s.choices.size() > PR_MAX_POPUP_CHOICES)) {
    return fail_with("popup '" + s.name + "': 1–64 choices");
  }
  s.key = "p" + std::to_string(s.id);
  for (std::size_t i = 0; i < h->groups.size(); ++i) s.group += (i > 0 ? " / " : "") + h->groups[i];
  if (s.type == PR_PARAM_GROUP_START) h->groups.push_back(s.name);
  h->declared->push_back(std::move(s));
  return PR_ERR_NONE;
}

PrErr PR_CALL cb_checkout_layer(PrHost* h, std::uint32_t paramIndex, std::uint32_t checkoutId, std::int64_t time, PrRect* rect) {
  if (h == nullptr || h->cmd != PR_CMD_SMART_PRE_RENDER || h->checkouts == nullptr) return PR_ERR_INVALID_CALLBACK;
  if (paramIndex >= h->numParams) return PR_ERR_INVALID_PARAM;
  if (paramIndex != 0 && (h->params == nullptr || h->params->at(paramIndex - 1).type != PR_PARAM_LAYER)) return PR_ERR_INVALID_PARAM;
  for (CheckoutRequest& c : *h->checkouts) {
    if (c.id == checkoutId) {  // a repeated id replaces the earlier request
      c = {checkoutId, paramIndex, time};
      return PR_ERR_NONE;
    }
  }
  if (h->checkouts->size() >= 64) return PR_ERR_OUT_OF_MEMORY;
  h->checkouts->push_back({checkoutId, paramIndex, time});
  if (rect != nullptr) *rect = PrRect{};  // full-frame worlds (G1): the glue knows the size
  return PR_ERR_NONE;
}

// ── SDK 1.1: the comp camera, lights and layer transforms (pr_scene.h) ──────

/// Copy what fits of `src` into a caller struct whose first field is its `struct_size`.
template <typename T>
PrErr copy_sized(T* dst, const T& src) {
  if (dst == nullptr) return PR_ERR_INVALID_PARAM;
  const std::uint32_t size = dst->struct_size;
  if (size < sizeof(std::uint32_t)) return PR_ERR_INVALID_PARAM;
  std::memcpy(reinterpret_cast<unsigned char*>(dst) + sizeof(std::uint32_t),  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): sized C struct
              reinterpret_cast<const unsigned char*>(&src) + sizeof(std::uint32_t),  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
              std::min<std::size_t>(size, sizeof(T)) - sizeof(std::uint32_t));
  return PR_ERR_NONE;
}

/// SDK 1.2: the sample of `in` at layer time `time` that carries `bit` (samples are sorted by time).
const TimeSample* find_sample(const RenderInputs& in, std::int64_t time, std::uint32_t bit) {
  const auto it = std::ranges::lower_bound(in.samples, time, {}, &TimeSample::time);
  if (it == in.samples.end() || it->time != time || (it->what & bit) == 0) return nullptr;
  return &*it;
}

/// Shared gate: a render selector and the effect declared `flag`; then the frame's own time
/// (`*sample` nullptr) or, SDK 1.2, a time it checked out with `bit` (`*sample` set).
/// Any other time: PR_ERR_NOT_FOUND.
PrErr scene_gate(PrHost* h, std::uint32_t flag, std::uint32_t bit, std::int64_t time, const TimeSample** sample) {
  *sample = nullptr;
  // SDK 1.2: DRAW_OVERLAY / OVERLAY_DRAG read the scene at the viewer's time (the request carried it).
  const bool overlay = h != nullptr && h->overlayScene && (h->cmd == PR_CMD_DRAW_OVERLAY || h->cmd == PR_CMD_OVERLAY_DRAG);
  if (h == nullptr || (!h->renderSelector && !overlay) || h->inputs == nullptr) return PR_ERR_INVALID_CALLBACK;
  if ((h->outFlags & flag) == 0) return PR_ERR_INVALID_CALLBACK;
  if (time == h->inputs->layerTime || time == h->inputs->compTime) return PR_ERR_NONE;
  if (overlay) return PR_ERR_NOT_FOUND;  // no checked-out times outside a render
  *sample = find_sample(*h->inputs, time, bit);
  return *sample != nullptr ? PR_ERR_NONE : PR_ERR_NOT_FOUND;
}

/// A rigid view matrix's inverse (rotation transposed, translation back-rotated).
std::array<double, 16> rigid_inverse(const std::array<double, 16>& v) {
  std::array<double, 16> w{};
  for (std::size_t c = 0; c < 3; ++c) {
    for (std::size_t r = 0; r < 3; ++r) w.at(c * 4 + r) = v.at(r * 4 + c);
  }
  for (std::size_t r = 0; r < 3; ++r) {
    w.at(12 + r) = -(w.at(r) * v.at(12) + w.at(4 + r) * v.at(13) + w.at(8 + r) * v.at(14));
  }
  w.at(15) = 1;
  return w;
}

PrErr PR_CALL cb_get_comp_camera(PrHost* h, std::int64_t time, PrCamera* out) {
  const TimeSample* sample = nullptr;
  if (const PrErr e = scene_gate(h, PR_OUT_FLAG_USES_CAMERA, PR_SAMPLE_CAMERA, time, &sample); e != PR_ERR_NONE) return e;
  const RenderInputs& in = *h->inputs;
  const std::optional<SceneCamera>& source = sample != nullptr ? sample->camera : in.camera;
  const double w = in.compW > 0 ? in.compW : static_cast<double>(in.worldW);
  const double ht = in.compH > 0 ? in.compH : static_cast<double>(in.worldH);
  SceneCamera cam;
  if (source && source->hasCamera) {
    cam = *source;
  } else {
    // The comp's default view: After Effects' default camera, centred on the comp.
    const motion::xf::Camera def = motion::xf::default_camera(w, ht);
    cam.view = motion::xf::camera_view_matrix(def);
    cam.projection = motion::xf::camera_projection_matrix(def);
    cam.eye = {def.position.x, def.position.y, def.position.z};
    cam.zoom = def.focal_length;
    cam.focusDistance = def.focal_length;
  }
  PrCamera c{};
  c.struct_size = sizeof(PrCamera);
  c.has_camera = source && source->hasCamera ? 1 : 0;
  c.orthographic = cam.orthographic ? 1 : 0;
  c.dof_enabled = cam.dofEnabled ? 1 : 0;
  const std::array<double, 16> world = rigid_inverse(cam.view);
  std::copy(world.begin(), world.end(), std::begin(c.world));
  std::copy(cam.view.begin(), cam.view.end(), std::begin(c.view));
  std::copy(cam.projection.begin(), cam.projection.end(), std::begin(c.projection));
  std::copy(cam.eye.begin(), cam.eye.end(), std::begin(c.position));
  c.zoom = cam.zoom > 0 ? cam.zoom : cam.projection[5];
  c.fov_y = c.zoom > 0 ? 2 * std::atan(ht / 2 / c.zoom) : 0;
  c.film_width = w;
  c.film_height = ht;
  c.focus_distance = cam.focusDistance;
  c.aperture = cam.aperture;
  return copy_sized(out, c);
}

PrErr PR_CALL cb_get_comp_lights(PrHost* h, std::int64_t time, PrLight* out, std::uint32_t capacity, std::uint32_t* count) {
  const TimeSample* sample = nullptr;
  if (const PrErr e = scene_gate(h, PR_OUT_FLAG_USES_LIGHTS, PR_SAMPLE_LIGHTS, time, &sample); e != PR_ERR_NONE) return e;
  if (count == nullptr || (capacity > 0 && out == nullptr)) return PR_ERR_INVALID_PARAM;
  const std::vector<SceneLight> none;
  const std::optional<std::vector<SceneLight>>& source = sample != nullptr ? sample->lights : h->inputs->lights;
  const std::vector<SceneLight>& lights = source ? *source : none;
  const auto n = static_cast<std::uint32_t>(std::min<std::size_t>(lights.size(), PR_MAX_LIGHTS));
  *count = n;
  // The caller's array is laid out at ITS struct size (the first element's struct_size).
  const std::uint32_t stride = capacity > 0 ? out->struct_size : 0;
  if (capacity > 0 && stride < sizeof(std::uint32_t)) return PR_ERR_INVALID_PARAM;
  for (std::uint32_t i = 0; i < std::min(n, capacity); ++i) {
    const SceneLight& s = lights[i];
    PrLight l{};
    l.struct_size = sizeof(PrLight);
    l.type = s.type;
    std::copy(s.color.begin(), s.color.end(), std::begin(l.color));
    l.intensity = s.intensity;
    std::copy(s.position.begin(), s.position.end(), std::begin(l.position));
    std::copy(s.direction.begin(), s.direction.end(), std::begin(l.direction));
    l.cone_angle = s.coneAngle;
    l.cone_feather = s.coneFeather;
    l.falloff = s.falloff;
    l.falloff_distance = s.falloffDistance;
    l.casts_shadows = s.castsShadows ? 1 : 0;
    l.shadow_darkness = s.shadowDarkness;
    l.shadow_diffusion = s.shadowDiffusion;
    auto* slot = reinterpret_cast<PrLight*>(reinterpret_cast<unsigned char*>(out) + std::size_t{i} * stride);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): the caller's sized array
    slot->struct_size = stride;
    if (const PrErr e = copy_sized(slot, l); e != PR_ERR_NONE) return e;
  }
  return PR_ERR_NONE;
}

PrErr PR_CALL cb_get_layer_transform(PrHost* h, std::uint32_t paramIndex, std::int64_t time, double* out) {
  const TimeSample* sample = nullptr;
  if (const PrErr e = scene_gate(h, PR_OUT_FLAG_USES_LAYER_TRANSFORMS, PR_SAMPLE_LAYER_TRANSFORMS, time, &sample); e != PR_ERR_NONE) {
    return e;
  }
  if (out == nullptr || paramIndex == 0 || paramIndex > h->inputs->values.size()) return PR_ERR_INVALID_PARAM;
  if (h->params == nullptr || h->params->at(paramIndex - 1).type != PR_PARAM_LAYER) return PR_ERR_INVALID_PARAM;
  const auto& ms = sample != nullptr ? sample->layerMatrices : h->inputs->layerMatrices;
  if (paramIndex - 1 >= ms.size() || !ms[paramIndex - 1]) return PR_ERR_NOT_FOUND;
  std::copy(ms[paramIndex - 1]->begin(), ms[paramIndex - 1]->end(), out);
  return PR_ERR_NONE;
}

// ── SDK 1.1: a FILE param's asset ───────────────────────────────────────────

constexpr std::uint64_t kMaxAssetBytes = std::uint64_t{512} * 1024 * 1024;

/// The FILE param at `paramIndex` with a file on disk, or the error.
PrErr asset_param(PrHost* h, std::uint32_t paramIndex, const ParamValue** out) {
  if (h == nullptr || h->inputs == nullptr || h->params == nullptr) return PR_ERR_INVALID_CALLBACK;
  if (paramIndex == 0 || paramIndex > h->params->size() || h->params->at(paramIndex - 1).type != PR_PARAM_FILE) {
    return PR_ERR_INVALID_PARAM;
  }
  if (paramIndex > h->inputs->values.size()) return PR_ERR_NOT_FOUND;
  const ParamValue& v = h->inputs->values[paramIndex - 1];
  if (v.fileItem.empty() || v.fileMissing || v.filePath.empty()) return PR_ERR_NOT_FOUND;
  *out = &v;
  return PR_ERR_NONE;
}

PrErr PR_CALL cb_get_asset_path(PrHost* h, std::uint32_t paramIndex, char* buf, std::uint32_t capacity, std::uint32_t* outLen) {
  const ParamValue* v = nullptr;
  if (const PrErr e = asset_param(h, paramIndex, &v); e != PR_ERR_NONE) return e;
  const auto n = static_cast<std::uint32_t>(v->filePath.size());
  if (outLen != nullptr) *outLen = n;
  if (buf == nullptr || capacity < n + 1) return PR_ERR_OUT_OF_MEMORY;
  std::memcpy(buf, v->filePath.data(), n);
  buf[n] = '\0';  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  return PR_ERR_NONE;
}

PrErr PR_CALL cb_get_asset_bytes(PrHost* h, std::uint32_t paramIndex, const std::uint8_t** data, std::uint64_t* size) {
  const ParamValue* v = nullptr;
  if (const PrErr e = asset_param(h, paramIndex, &v); e != PR_ERR_NONE) return e;
  if (data == nullptr || size == nullptr) return PR_ERR_INVALID_PARAM;
  const std::scoped_lock lock(h->assetMutex);
  auto it = h->assetBytes.find(paramIndex);
  if (it == h->assetBytes.end()) {
    std::error_code ec;
    const fs::path p(std::u8string(v->filePath.begin(), v->filePath.end()));
    const std::uintmax_t n = fs::file_size(p, ec);
    if (ec) return PR_ERR_NOT_FOUND;
    if (n > kMaxAssetBytes) return PR_ERR_OUT_OF_MEMORY;
    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(n));
    std::ifstream f(p, std::ios::binary);
    if (!f || !f.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(n))) return PR_ERR_NOT_FOUND;  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): bytes
    it = h->assetBytes.emplace(paramIndex, std::move(bytes)).first;
  }
  *data = it->second.data();
  *size = it->second.size();
  return PR_ERR_NONE;
}

// ── SDK 1.2: other times (checkout_time / checkout_param) ──────────────────

PrErr PR_CALL cb_checkout_time(PrHost* h, std::int64_t time, std::uint32_t what) {
  if (h == nullptr || h->cmd != PR_CMD_SMART_PRE_RENDER) return PR_ERR_INVALID_CALLBACK;
  if ((h->outFlags & PR_OUT_FLAG_SAMPLES_TIME) == 0) return PR_ERR_INVALID_CALLBACK;
  if ((what & ~std::uint32_t{PR_SAMPLE_ALL | PR_SAMPLE_SCENE_DEPTH}) != 0 || what == 0) return PR_ERR_INVALID_PARAM;
  if (h->times == nullptr) return PR_ERR_NONE;  // a render-time pre-render: the frame already carries the samples
  for (TimeRequest& r : *h->times) {
    if (r.time == time) {
      r.what |= what;
      return PR_ERR_NONE;
    }
  }
  if (h->times->size() >= PR_MAX_TIME_SAMPLES) return PR_ERR_OUT_OF_MEMORY;
  h->times->push_back({time, what});
  return PR_ERR_NONE;
}

PrErr PR_CALL cb_checkout_param(PrHost* h, std::uint32_t paramIndex, std::int64_t time, PrParamDef* out) {
  if (h == nullptr || !h->renderSelector || h->inputs == nullptr || h->effect == nullptr) return PR_ERR_INVALID_CALLBACK;
  if (out == nullptr || out->struct_size < sizeof(std::uint32_t)) return PR_ERR_INVALID_PARAM;
  if (paramIndex == 0 || paramIndex > h->effect->params.size()) return PR_ERR_INVALID_PARAM;
  const RenderInputs& in = *h->inputs;
  std::size_t slot = SIZE_MAX;
  const std::vector<ParamValue>* values = &in.values;
  if (time != in.layerTime) {
    const TimeSample* s = find_sample(in, time, PR_SAMPLE_PARAMS);
    if (s == nullptr || s->values.size() != h->effect->params.size()) return PR_ERR_NOT_FOUND;
    slot = static_cast<std::size_t>(s - in.samples.data());
    values = &s->values;
  }
  const std::scoped_lock lock(h->assetMutex);
  auto it = h->sampleDefs.find(slot);
  if (it == h->sampleDefs.end()) {
    std::vector<PrParamDef*> ptrs;
    it = h->sampleDefs.emplace(slot, impl_of(h).param_defs(*h->effect, in, ptrs, values)).first;
  }
  return copy_sized(out, it->second.defs.at(paramIndex));
}

// ── SDK 1.2: a FILE param's image and the files beside it ───────────────────

PrErr PR_CALL cb_get_asset_image(PrHost* h, std::uint32_t paramIndex, PrWorld** world) {
  const ParamValue* v = nullptr;
  if (const PrErr e = asset_param(h, paramIndex, &v); e != PR_ERR_NONE) return e;
  if (world == nullptr) return PR_ERR_INVALID_PARAM;
  const std::scoped_lock lock(h->assetMutex);
  if (const auto it = h->assetWorlds.find(paramIndex); it != h->assetWorlds.end()) {
    *world = &it->second;
    return PR_ERR_NONE;
  }
  std::string key;
  std::string why;
  bool unsupported = false;
  const fs::path p(std::u8string(v->filePath.begin(), v->filePath.end()));
  std::shared_ptr<const AssetImage> img = load_asset_image(p, key, why, unsupported);
  if (!img) {
    PREMATION_LOG(warn, "plugin_asset_image").kv("file", v->filePath).kv("why", why);
    return unsupported ? PR_ERR_UNSUPPORTED : PR_ERR_NOT_FOUND;
  }
  PrWorld w{};
  w.struct_size = sizeof(PrWorld);
  w.width = img->width;
  w.height = img->height;
  w.row_bytes = img->width * 16;
  w.format = PR_PIXEL_FORMAT_RGBA32F;
  w.data = const_cast<float*>(img->rgba.data());  // NOLINT(cppcoreguidelines-pro-type-const-cast): PrWorld is a C struct; the plugin must not write an asset
  h->assetImages[paramIndex] = std::move(img);
  *world = &h->assetWorlds.emplace(paramIndex, w).first->second;
  return PR_ERR_NONE;
}

PrErr PR_CALL cb_get_asset_image_gpu(PrHost* h, std::uint32_t paramIndex, const PrGpuWorld** world) {
  if (h == nullptr || h->cmd != PR_CMD_SMART_RENDER_GPU || h->source == nullptr) return PR_ERR_INVALID_CALLBACK;
  const ParamValue* v = nullptr;
  if (const PrErr e = asset_param(h, paramIndex, &v); e != PR_ERR_NONE) return e;
  if (world == nullptr) return PR_ERR_INVALID_PARAM;
  std::string key;
  std::string why;
  bool unsupported = false;
  const fs::path p(std::u8string(v->filePath.begin(), v->filePath.end()));
  std::shared_ptr<const AssetImage> img = load_asset_image(p, key, why, unsupported);
  if (!img) return unsupported ? PR_ERR_UNSUPPORTED : PR_ERR_NOT_FOUND;
  const std::scoped_lock lock(h->assetMutex);
  const PrGpuWorld* g = h->source->gpu_asset(key, *img);
  if (g == nullptr) return PR_ERR_UNSUPPORTED;
  h->assetImages[paramIndex] = std::move(img);
  *world = g;
  return PR_ERR_NONE;
}

PrErr PR_CALL cb_get_asset_sibling_bytes(PrHost* h, std::uint32_t paramIndex, const char* relative, const std::uint8_t** data,
                                         std::uint64_t* size) {
  const ParamValue* v = nullptr;
  if (const PrErr e = asset_param(h, paramIndex, &v); e != PR_ERR_NONE) return e;
  if (relative == nullptr || data == nullptr || size == nullptr) return PR_ERR_INVALID_PARAM;
  const std::string rel(relative);
  const std::scoped_lock lock(h->assetMutex);
  const auto key = std::make_pair(paramIndex, rel);
  auto it = h->siblingBytes.find(key);
  if (it == h->siblingBytes.end()) {
    fs::path file;
    std::string why;
    const fs::path asset(std::u8string(v->filePath.begin(), v->filePath.end()));
    if (!resolve_sibling(asset, rel, file, why)) return PR_ERR_INVALID_PARAM;
    std::error_code ec;
    const std::uintmax_t n = fs::file_size(file, ec);
    if (ec) return PR_ERR_NOT_FOUND;
    if (n > kMaxAssetBytes) return PR_ERR_OUT_OF_MEMORY;
    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(n));
    std::ifstream f(file, std::ios::binary);
    if (!f || !f.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(n))) return PR_ERR_NOT_FOUND;  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): bytes
    it = h->siblingBytes.emplace(key, std::move(bytes)).first;
  }
  *data = it->second.data();
  *size = it->second.size();
  return PR_ERR_NONE;
}

// ── SDK 1.2 (S6): the depth of the comp's other 3D layers ───────────────────

PrErr scene_depth_gate(PrHost* h, bool gpu) {
  if (h == nullptr || h->source == nullptr || !h->renderSelector) return PR_ERR_INVALID_CALLBACK;
  if (gpu ? h->cmd != PR_CMD_SMART_RENDER_GPU : h->cmd != PR_CMD_SMART_RENDER && h->cmd != PR_CMD_RENDER) return PR_ERR_INVALID_CALLBACK;
  if ((h->outFlags & PR_OUT_FLAG_USES_SCENE_DEPTH) == 0) return PR_ERR_INVALID_CALLBACK;
  return PR_ERR_NONE;
}

PrErr PR_CALL cb_checkout_scene_depth_gpu(PrHost* h, const PrGpuWorld** world) {
  if (world == nullptr) return PR_ERR_INVALID_PARAM;
  *world = nullptr;
  if (const PrErr e = scene_depth_gate(h, true); e != PR_ERR_NONE) return e;
  const std::scoped_lock lock(h->assetMutex);  // the source renders on first ask: one at a time
  *world = h->source->gpu_scene_depth();
  return *world != nullptr ? PR_ERR_NONE : PR_ERR_UNSUPPORTED;
}

PrErr PR_CALL cb_checkout_scene_depth(PrHost* h, PrWorld** world) {
  if (world == nullptr) return PR_ERR_INVALID_PARAM;
  *world = nullptr;
  if (const PrErr e = scene_depth_gate(h, false); e != PR_ERR_NONE) return e;
  const std::scoped_lock lock(h->assetMutex);
  *world = h->source->cpu_scene_depth();
  return *world != nullptr ? PR_ERR_NONE : PR_ERR_UNSUPPORTED;
}

/// SDK 1.2: the frame's time, or a time checked out with PR_SAMPLE_SCENE_DEPTH (`*sample`).
PrErr scene_depth_time(PrHost* h, std::int64_t time, const TimeSample** sample) {
  *sample = nullptr;
  if (time == h->inputs->layerTime) return PR_ERR_NONE;
  *sample = find_sample(*h->inputs, time, PR_SAMPLE_SCENE_DEPTH);
  return *sample != nullptr && (*sample)->depth ? PR_ERR_NONE : PR_ERR_NOT_FOUND;
}

PrErr PR_CALL cb_checkout_scene_depth_gpu_at(PrHost* h, std::int64_t time, const PrGpuWorld** world) {
  if (world == nullptr) return PR_ERR_INVALID_PARAM;
  *world = nullptr;
  if (const PrErr e = scene_depth_gate(h, true); e != PR_ERR_NONE) return e;
  if (h->inputs == nullptr) return PR_ERR_INVALID_CALLBACK;
  const TimeSample* sample = nullptr;
  if (const PrErr e = scene_depth_time(h, time, &sample); e != PR_ERR_NONE) return e;
  const std::scoped_lock lock(h->assetMutex);
  *world = sample != nullptr ? h->source->gpu_scene_depth_at(*sample) : h->source->gpu_scene_depth();
  return *world != nullptr ? PR_ERR_NONE : PR_ERR_UNSUPPORTED;
}

PrErr PR_CALL cb_checkout_scene_depth_at(PrHost* h, std::int64_t time, PrWorld** world) {
  if (world == nullptr) return PR_ERR_INVALID_PARAM;
  *world = nullptr;
  if (const PrErr e = scene_depth_gate(h, false); e != PR_ERR_NONE) return e;
  if (h->inputs == nullptr) return PR_ERR_INVALID_CALLBACK;
  const TimeSample* sample = nullptr;
  if (const PrErr e = scene_depth_time(h, time, &sample); e != PR_ERR_NONE) return e;
  const std::scoped_lock lock(h->assetMutex);
  *world = sample != nullptr ? h->source->cpu_scene_depth_at(*sample) : h->source->cpu_scene_depth();
  return *world != nullptr ? PR_ERR_NONE : PR_ERR_UNSUPPORTED;
}

// ── SDK 1.1: the viewer overlay's draw list (DRAW_OVERLAY) ─────────────────

// The overlay crosses the frame channel with every frame: small by construction. A path's
// points fit one geometry record (overlay_geometry.cpp packs items whole).
constexpr std::size_t kMaxOverlayItems = 256;
constexpr std::size_t kMaxOverlayPoints = 2048;
constexpr std::uint32_t kMaxOverlayPathPoints = 192;

PrErr overlay_push(PrHost* h, doc::NativeOverlayItem item) {
  // SDK 1.3: an Effect Controls box (DRAW_PARAM_UI) takes the same draw list, in box px.
  if (h == nullptr || (h->cmd != PR_CMD_DRAW_OVERLAY && h->cmd != PR_CMD_DRAW_PARAM_UI) || h->overlay == nullptr) {
    return PR_ERR_INVALID_CALLBACK;
  }
  if (h->overlay->size() >= kMaxOverlayItems) return PR_ERR_OUT_OF_MEMORY;
  item.space = h->cmd == PR_CMD_DRAW_OVERLAY ? h->overlaySpace : PR_OVERLAY_SPACE_LAYER;  // SDK 1.2: layer px or comp px
  std::size_t points = item.points.size() / 2;
  for (const auto& i : *h->overlay) points += i.points.size() / 2;
  if (points > kMaxOverlayPoints) return PR_ERR_OUT_OF_MEMORY;
  for (const double v : item.points) {
    if (!std::isfinite(v)) return PR_ERR_INVALID_PARAM;
  }
  h->overlay->push_back(std::move(item));
  return PR_ERR_NONE;
}

std::vector<double> rgba_of(const float* rgba) {
  if (rgba == nullptr) return {};
  return {rgba[0], rgba[1], rgba[2], rgba[3]};  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic): the SDK's 4-float colour
}

PrErr PR_CALL cb_overlay_line(PrHost* h, double x0, double y0, double x1, double y1, const float* rgba) {
  doc::NativeOverlayItem i;
  i.kind = "line";
  i.points = {x0, y0, x1, y1};
  i.color = rgba_of(rgba);
  return overlay_push(h, std::move(i));
}

PrErr PR_CALL cb_overlay_path(PrHost* h, const double* xy, std::uint32_t count, std::int32_t closed, const float* rgba) {
  if (xy == nullptr || count < 2 || count > kMaxOverlayPathPoints) return PR_ERR_INVALID_PARAM;
  doc::NativeOverlayItem i;
  i.kind = "path";
  i.points.assign(xy, xy + std::size_t{count} * 2);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic): the SDK's xy array
  i.closed = closed != 0;
  i.color = rgba_of(rgba);
  return overlay_push(h, std::move(i));
}

PrErr PR_CALL cb_overlay_handle(PrHost* h, std::uint32_t id, double x, double y, std::uint32_t shape) {
  doc::NativeOverlayItem i;
  i.kind = "handle";
  i.points = {x, y};
  i.handle = id;
  i.shape = shape <= PR_OVERLAY_HANDLE_CROSSHAIR ? shape : PR_OVERLAY_HANDLE_SQUARE;
  return overlay_push(h, std::move(i));
}

// ── SDK 1.3: an Effect Controls box's fills and labels (DRAW_PARAM_UI only) ──

constexpr std::size_t kMaxUiTextBytes = 256;

PrErr PR_CALL cb_ui_fill(PrHost* h, const double* xy, std::uint32_t count, const float* rgba) {
  if (h == nullptr || h->cmd != PR_CMD_DRAW_PARAM_UI) return PR_ERR_INVALID_CALLBACK;
  if (xy == nullptr || count < 3 || count > kMaxOverlayPathPoints) return PR_ERR_INVALID_PARAM;
  doc::NativeOverlayItem i;
  i.kind = "fill";
  i.points.assign(xy, xy + std::size_t{count} * 2);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic): the SDK's xy array
  i.closed = true;
  i.color = rgba_of(rgba);
  return overlay_push(h, std::move(i));
}

// SDK 1.4 (T): a STATEFUL effect's state for this frame, during its render selectors.
PrErr PR_CALL cb_get_sim_state(PrHost* h, const void** data, std::uint32_t* size) {
  if (h == nullptr || data == nullptr || size == nullptr || h->inputs == nullptr) return PR_ERR_INVALID_CALLBACK;
  if (h->cmd != PR_CMD_SMART_RENDER && h->cmd != PR_CMD_SMART_RENDER_GPU) return PR_ERR_INVALID_CALLBACK;
  if (!h->inputs->simState) return PR_ERR_NOT_FOUND;
  *data = h->inputs->simState->data();
  *size = static_cast<std::uint32_t>(h->inputs->simState->size());
  return PR_ERR_NONE;
}

PrErr PR_CALL cb_ui_text(PrHost* h, double x, double y, const char* utf8, double size, std::uint32_t align, const float* rgba) {
  if (h == nullptr || h->cmd != PR_CMD_DRAW_PARAM_UI) return PR_ERR_INVALID_CALLBACK;
  if (utf8 == nullptr || !std::isfinite(size)) return PR_ERR_INVALID_PARAM;
  doc::NativeOverlayItem i;
  i.kind = "text";
  i.points = {x, y};
  i.text = std::string(utf8, strnlen(utf8, kMaxUiTextBytes));
  i.size = std::clamp(size, 6.0, 48.0);
  i.align = align <= PR_UI_TEXT_RIGHT ? align : PR_UI_TEXT_LEFT;
  i.color = rgba_of(rgba);
  return overlay_push(h, std::move(i));
}

PrErr PR_CALL cb_overlay_set_space(PrHost* h, std::uint32_t space) {
  if (h == nullptr || h->cmd != PR_CMD_DRAW_OVERLAY || h->overlay == nullptr) return PR_ERR_INVALID_CALLBACK;
  if (space != PR_OVERLAY_SPACE_LAYER && space != PR_OVERLAY_SPACE_COMP) return PR_ERR_INVALID_PARAM;
  h->overlaySpace = space;
  return PR_ERR_NONE;
}

PrErr PR_CALL cb_checkout_layer_pixels(PrHost* h, std::uint32_t checkoutId, PrWorld** world) {
  if (h == nullptr || h->cmd != PR_CMD_SMART_RENDER || h->source == nullptr || world == nullptr) return PR_ERR_INVALID_CALLBACK;
  *world = h->source->cpu_checkout(checkoutId);
  return PR_ERR_NONE;
}

PrErr PR_CALL cb_checkout_output(PrHost* h, PrWorld** world) {
  if (h == nullptr || h->cmd != PR_CMD_SMART_RENDER || h->source == nullptr || world == nullptr) return PR_ERR_INVALID_CALLBACK;
  *world = h->source->cpu_output();
  return PR_ERR_NONE;
}

PrErr PR_CALL cb_checkout_layer_gpu(PrHost* h, std::uint32_t checkoutId, const PrGpuWorld** world) {
  if (h == nullptr || h->cmd != PR_CMD_SMART_RENDER_GPU || h->source == nullptr || world == nullptr) return PR_ERR_INVALID_CALLBACK;
  *world = h->source->gpu_checkout(checkoutId);
  return PR_ERR_NONE;
}

PrErr PR_CALL cb_set_param_ui(PrHost* h, std::uint32_t index, std::uint32_t flags, const char* name) {
  if (h == nullptr || h->ui == nullptr || (h->cmd != PR_CMD_UPDATE_PARAMS_UI && h->cmd != PR_CMD_USER_CHANGED_PARAM)) {
    return PR_ERR_INVALID_CALLBACK;
  }
  if (index == 0 || index > h->ui->size()) return PR_ERR_INVALID_PARAM;
  ParamUi& u = h->ui->at(index - 1);
  u.enabled = (flags & PR_PARAM_UI_DISABLED) == 0;
  u.hidden = (flags & PR_PARAM_UI_HIDDEN) != 0;
  if (name != nullptr) u.name = name;
  return PR_ERR_NONE;
}

/// The selectors that edit: a supervised change / button, a viewer handle's drag, SDK 1.3 a box handle's.
bool writing_cmd(PrCmd cmd) noexcept {
  return cmd == PR_CMD_USER_CHANGED_PARAM || cmd == PR_CMD_OVERLAY_DRAG || cmd == PR_CMD_PARAM_UI_DRAG;
}

PrErr PR_CALL cb_set_param_value(PrHost* h, std::uint32_t index, const double* value, std::uint32_t count) {
  if (h == nullptr || !writing_cmd(h->cmd) || h->writes == nullptr || h->params == nullptr) return PR_ERR_INVALID_CALLBACK;
  if (index == 0 || index > h->params->size() || value == nullptr || count == 0 || count > 4) return PR_ERR_INVALID_PARAM;
  if (h->params->at(index - 1).type == PR_PARAM_CUSTOM_UI) return PR_ERR_INVALID_PARAM;  // a box has no value
  std::array<double, 4> v{};
  for (std::uint32_t i = 0; i < count; ++i) v.at(i) = value[i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  h->writes->emplace_back(index, v);
  return PR_ERR_NONE;
}

PrErr PR_CALL cb_set_arb_data(PrHost* h, std::uint32_t index, const std::uint8_t* data, std::uint32_t size) {
  if (h == nullptr || !writing_cmd(h->cmd) || h->arbWrites == nullptr || h->params == nullptr) return PR_ERR_INVALID_CALLBACK;
  if (index == 0 || index > h->params->size() || h->params->at(index - 1).type != PR_PARAM_ARBITRARY_DATA) return PR_ERR_INVALID_PARAM;
  if (size > 256U * 1024U) return PR_ERR_OUT_OF_MEMORY;  // setPluginData's per-key limit
  std::vector<std::uint8_t> bytes;
  if (data != nullptr) bytes.assign(data, data + size);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  h->arbWrites->emplace_back(index, std::move(bytes));
  return PR_ERR_NONE;
}

std::int32_t PR_CALL cb_abort_requested(PrHost* /*h*/) { return 0; }
/// docs/PLUGIN_SDK.md "The watchdog": progress in a P7 call is proof of life —
/// it restarts that call's watchdog clock and the engine's core busy clock.
/// Render and setup selectors are not extended.
void PR_CALL cb_progress(PrHost* h, double /*fraction*/) {
  if (h == nullptr || h->host == nullptr || h->progressSlot < 0) return;
  PluginHost::Impl& m = impl_of(h);
  if (m.watchdog) m.watchdog->touch(h->progressSlot);
  if (m.options.onProgress) m.options.onProgress();
}
void PR_CALL cb_log(PrHost* h, std::int32_t level, const char* message) {
  const std::string m = message != nullptr ? std::string(message) : std::string();
  const std::string cmd(command_name(h != nullptr ? h->cmd : -1));
  if (level >= PR_LOG_ERROR) {
    PREMATION_LOG(error, "plugin_log").kv("cmd", cmd).kv("message", m);
  } else if (level >= PR_LOG_WARN) {
    PREMATION_LOG(warn, "plugin_log").kv("cmd", cmd).kv("message", m);
  } else {
    PREMATION_LOG(info, "plugin_log").kv("cmd", cmd).kv("message", m);
  }
}

struct IterateJob {
  PrHost* host;
  PrIterateFn fn;
  void* refcon;
  int count;
  std::atomic<PrErr> err{PR_ERR_NONE};
  std::mutex faultMutex;
};

struct ItemCall {
  IterateJob* job;
  int thread;
  int index;
  PrErr result;
  bool threw;
};

void item_trampoline(void* p) {
  auto* c = static_cast<ItemCall*>(p);
  try {
    c->result = c->job->fn(c->job->refcon, c->thread, c->index, c->job->count);
  } catch (...) {
    c->threw = true;
  }
}

void iterate_item(void* ctx, int thread, int index) {
  auto* job = static_cast<IterateJob*>(ctx);
  ItemCall call{job, thread, index, PR_ERR_NONE, false};
  Fault f = guarded_call(&item_trampoline, &call);
  if (!f && call.threw) f = {FaultKind::cpp_exception, 0};
  if (f) {
    const std::scoped_lock lock(job->faultMutex);
    if (!job->host->iterateFault) job->host->iterateFault = f;
    job->host->iterateStop.store(true, std::memory_order_relaxed);
    return;
  }
  if (call.result != PR_ERR_NONE) {
    PrErr expected = PR_ERR_NONE;
    job->err.compare_exchange_strong(expected, call.result);
    job->host->iterateStop.store(true, std::memory_order_relaxed);
  }
}

PrErr PR_CALL cb_iterate(PrHost* h, std::int32_t count, void* refcon, PrIterateFn fn) {
  if (h == nullptr || fn == nullptr) return PR_ERR_INVALID_CALLBACK;
  if (count <= 0) return PR_ERR_NONE;
  IterateJob job{.host = h, .fn = fn, .refcon = refcon, .count = count, .err = {}, .faultMutex = {}};
  h->iterateStop.store(false, std::memory_order_relaxed);
  impl_of(h).pool->run(count, &iterate_item, &job, &h->iterateStop);
  if (h->iterateFault) return PR_ERR_INTERNAL;
  return job.err.load();
}

std::int32_t PR_CALL cb_iterate_threads(PrHost* h) { return h == nullptr ? 1 : impl_of(h).pool->width(); }

}  // namespace

// ── construction ─────────────────────────────────────────────────────────

PluginHost::PluginHost(HostOptions options) : impl_(std::make_unique<Impl>(*this, std::move(options))) {
  Impl& m = *impl_;
  contrib_ = std::make_unique<Contrib>(*this);  // P7
  PrHostSuite& s = m.suite;
  s.struct_size = sizeof(PrHostSuite);
  s.handle_new = &cb_handle_new;
  s.handle_lock = &cb_handle_lock;
  s.handle_size = &cb_handle_size;
  s.handle_resize = &cb_handle_resize;
  s.handle_dispose = &cb_handle_dispose;
  s.add_param = &cb_add_param;
  s.checkout_layer = &cb_checkout_layer;
  s.checkout_layer_pixels = &cb_checkout_layer_pixels;
  s.checkout_output = &cb_checkout_output;
  s.checkout_layer_gpu = &cb_checkout_layer_gpu;
  s.set_param_ui = &cb_set_param_ui;
  s.set_param_value = &cb_set_param_value;
  s.set_arb_data = &cb_set_arb_data;
  s.abort_requested = &cb_abort_requested;
  s.progress = &cb_progress;
  s.log = &cb_log;
  s.iterate = &cb_iterate;
  s.iterate_threads = &cb_iterate_threads;
  s.get_comp_camera = &cb_get_comp_camera;
  s.get_comp_lights = &cb_get_comp_lights;
  s.get_layer_transform = &cb_get_layer_transform;
  s.overlay_line = &cb_overlay_line;
  s.overlay_path = &cb_overlay_path;
  s.overlay_handle = &cb_overlay_handle;
  s.get_asset_path = &cb_get_asset_path;
  s.get_asset_bytes = &cb_get_asset_bytes;
  s.checkout_time = &cb_checkout_time;  // SDK 1.2
  s.checkout_param = &cb_checkout_param;
  s.get_asset_image = &cb_get_asset_image;
  s.get_asset_image_gpu = &cb_get_asset_image_gpu;
  s.get_asset_sibling_bytes = &cb_get_asset_sibling_bytes;
  s.checkout_scene_depth_gpu = &cb_checkout_scene_depth_gpu;  // SDK 1.2 (S6)
  s.checkout_scene_depth = &cb_checkout_scene_depth;
  s.overlay_set_space = &cb_overlay_set_space;  // SDK 1.2: overlay space
  s.checkout_scene_depth_gpu_at = &cb_checkout_scene_depth_gpu_at;  // SDK 1.2: scene depth at a sample
  s.checkout_scene_depth_at = &cb_checkout_scene_depth_at;
  s.ui_fill = &cb_ui_fill;  // SDK 1.3: Effect Controls boxes
  s.ui_text = &cb_ui_text;
  s.get_sim_state = &cb_get_sim_state;  // SDK 1.4

  int threads = m.options.threads;
  if (threads <= 0) threads = std::clamp(static_cast<int>(std::thread::hardware_concurrency()) - 1, 0, 16);
  m.pool = std::make_unique<WorkerPool>(threads);

  if (!m.options.journal.empty()) {
    std::string err;
    m.journal = CrashJournal::open(m.options.journal, err);
    if (!m.journal) {
      PREMATION_LOG(warn, "plugin_journal").kv("error", err);
    }
  }
  if (!m.options.onHang) {
    m.options.onHang = [](const std::string& plugin, std::string_view cmd) {
      // The hung call cannot be stopped from outside its thread: end the engine;
      // the supervisor restarts it and the journal keeps the plugin quarantined.
      PREMATION_LOG(error, "plugin_hang_fatal").kv("plugin", plugin).kv("cmd", std::string(cmd));
      std::fflush(nullptr);
      std::_Exit(86);
    };
  }
  m.watchdog = std::make_unique<Watchdog>(m.options.watchdog, [this](std::size_t slot) {
    Impl& im = *impl_;
    const Watchdog::Slot& s = im.watchdog->slot(slot);
    if (im.journal) im.journal->quarantine(s.plugin, "hung in " + std::string(command_name(s.cmd)));
    im.options.onHang(s.plugin, command_name(s.cmd));
  });

  if (m.options.attachToDocument) {
    g_active.store(this, std::memory_order_release);
    doc::NativeEffects::set_handlers(
        [this](std::string_view type) { return initial_sequence(type); },
        [this](const doc::NativeActionRequest& r) { return user_changed(r); },
        [this](std::string_view plugin, bool enabled) { return set_enabled(plugin, enabled); });
    doc::NativeEffects::set_query_handlers([this] { return plugin_infos(); },
                                           [this](const doc::NativeActionRequest& r) { return params_ui_for(r); });
    doc::NativeEffects::set_rescan_handler([this] {
      (void)scan();
      return plugin_infos();
    });
    doc::NativeEffects::set_reload_handler([this](std::string_view plugin, std::string& why) { return reload(plugin, why); });
    contrib_->attach();  // P7: runPluginCommand, listPluginCommands, plugin importers
    doc::NativeEffects::set_overlay_handlers([this](const doc::NativeActionRequest& r) { return draw_overlay(r); },
                                             [this](const doc::NativeActionRequest& r, const doc::NativeOverlayDrag& d) {
                                               return overlay_drag(r, d);
                                             });
    // SDK 1.2: what an overlay call may read of the scene, evaluated for what the effect declared.
    doc::NativeEffects::set_scene_handler([this](const doc::SpaceCtx& sc, doc::NativeActionRequest& r) {
      if (const EffectSpec* e = effect(r.type)) overlay_scene(sc, *e, r);
    });
    // SDK 1.2: Collect Files asks which files beside a FILE param's asset the effect reads.
    doc::NativeEffects::set_asset_files_handler(
        [this](const doc::NativeActionRequest& r, std::string_view key) { return asset_files_for(r, key); });
  }
}

PluginHost::~PluginHost() {
  Impl& m = *impl_;
  contrib_->shutdown();  // P7: CLOSE open importer files while the modules are set up
  if (m.options.attachToDocument) {
    PluginHost* self = this;
    if (g_active.compare_exchange_strong(self, nullptr)) doc::NativeEffects::clear_handlers();
  }
  // Instances first (SEQUENCE_SETDOWN), then GPU data, then GLOBAL_SETDOWN.
  {
    const std::scoped_lock lock(m.instancesMutex);
    for (auto& [key, inst] : m.instances) {
      if (Plugin* p = m.plugin_of(inst->effect); p != nullptr && p->status == PluginStatus::loaded) m.setdown(*inst, *p);
    }
    m.instances.clear();
  }
  std::vector<std::uint32_t> devices;
  {
    const std::scoped_lock lock(m.gpuMutex);
    for (const auto& [k, h] : m.gpuData) devices.push_back(k.second);
  }
  for (const std::uint32_t d : devices) gpu_device_gone(d);
  for (auto& p : m.plugins) {
    if (p->status != PluginStatus::loaded && p->status != PluginStatus::disabled) continue;
    const std::scoped_lock lock(p->serial);
    for (auto& e : p->effects) {
      if (!e->ready) continue;
      PrHost ctx;
      ctx.host = this;
      ctx.cmd = PR_CMD_GLOBAL_SETDOWN;
      PrInData in = m.base_in(ctx, *e);
      PrOutData out{};
      Impl::reset_out(out, e->globalData, 0);
      (void)m.invoke(p->manifest.id, e->main, PR_CMD_GLOBAL_SETDOWN, &in, &out, nullptr, nullptr, nullptr);
    }
    doc::NativeEffects::set_available(p->manifest.id, false);
  }
  m.watchdog.reset();
}

PluginHost* PluginHost::active() noexcept { return g_active.load(std::memory_order_acquire); }

std::string_view to_string(PluginStatus s) noexcept {
  switch (s) {
    case PluginStatus::loaded: return "loaded";
    case PluginStatus::disabled: return "disabled";
    case PluginStatus::quarantined: return "quarantined";
    case PluginStatus::revoked: return "revoked";
    case PluginStatus::locked: return "locked";
    default: return "failed";
  }
}

std::map<std::string, std::string, std::less<>> read_revoked_file(const fs::path& file) {
  std::map<std::string, std::string, std::less<>> out;
  std::ifstream f(file, std::ios::binary);
  if (!f) {
    PREMATION_LOG(warn, "plugin_revocations_unreadable").kv("file", file.string());
    return out;
  }
  std::stringstream ss;
  ss << f.rdbuf();
  const auto parsed = js::parse(ss.str());
  if (!parsed || !parsed->at("revoked").is_array()) {
    PREMATION_LOG(warn, "plugin_revocations_malformed").kv("file", file.string());
    return out;
  }
  for (const js::Json& e : parsed->at("revoked").arr()) {
    if (!e.at("id").is_string() || e.at("id").str().empty()) continue;
    out[e.at("id").str()] = e.at("reason").is_string() ? e.at("reason").str() : std::string();
  }
  return out;
}

// ── discovery + loading ──────────────────────────────────────────────────

std::vector<PluginRecord> PluginHost::scan() {
  Impl& m = *impl_;
  std::vector<fs::path> bundles;
  for (const fs::path& root : m.options.searchPaths) {
    std::error_code ec;
    if (fs::exists(root / std::string(kManifestFile), ec)) {
      bundles.push_back(root);
      continue;
    }
    if (!fs::is_directory(root, ec)) continue;
    std::vector<fs::path> found;
    for (const auto& entry : fs::directory_iterator(root, ec)) {
      if (entry.is_directory(ec) && fs::exists(entry.path() / std::string(kManifestFile), ec)) found.push_back(entry.path());
    }
    std::ranges::sort(found);  // deterministic load order
    bundles.insert(bundles.end(), found.begin(), found.end());
  }
  for (const fs::path& b : bundles) m.load_bundle(b);
  return plugins();
}

std::string PluginHost::Impl::entitlement_lock(const Manifest& man) const {
  if (man.entitlement.empty()) return {};
  std::string why;
  const std::optional<Entitlement> e = read_entitlement(options.entitlement, options.operatorKey, why);
  const std::int64_t now = options.nowMs ? options.nowMs()
                                         : std::chrono::duration_cast<std::chrono::milliseconds>(
                                               std::chrono::system_clock::now().time_since_epoch())
                                               .count();
  return entitlement_problem(e, why, man.entitlement, now);
}

fs::path PluginHost::Impl::shadow_copy(const Plugin& p, std::string& err) {
  std::error_code ec;
  const fs::path root = options.shadowDir / p.manifest.id;
  // Copies an earlier engine left behind; a copy this process still has loaded is locked and stays.
  if (shadowCleaned.insert(p.manifest.id).second) fs::remove_all(root, ec);
  // A folder that survived the clean-up holds a copy something still has loaded: never reuse it.
  fs::path dst;
  do {
    dst = root / std::to_string(++shadowGeneration);
  } while (fs::exists(dst, ec));
  fs::create_directories(dst, ec);
  if (ec) {
    err = "cannot create the shadow folder " + dst.string() + ": " + ec.message();
    return {};
  }
  const auto copy = [&](const fs::path& from) {
    fs::copy_file(from, dst / from.filename(), fs::copy_options::overwrite_existing, ec);
    if (ec) err = "cannot copy " + from.string() + " to the shadow folder: " + ec.message();
    return !ec;
  };
  if (!copy(p.binary)) return {};
  // The libraries the binary links against are looked up beside it: they move with it.
  for (const auto& entry : fs::directory_iterator(p.binary.parent_path(), ec)) {
    const fs::path& f = entry.path();
    const std::string ext = f.extension().string();
    if (f == p.binary || !entry.is_regular_file(ec) || (ext != ".dll" && ext != ".so" && ext != ".dylib")) continue;
    if (!copy(f)) return {};
  }
  return dst / p.binary.filename();
}

Plugin* PluginHost::Impl::load_bundle(const fs::path& dir, Plugin* replacing, std::string* reloadWhy) {
  auto p = std::make_unique<Plugin>();
  p->dir = dir;
  std::string text;
  {
    std::ifstream f(dir / std::string(kManifestFile), std::ios::binary);
    std::stringstream ss;
    ss << f.rdbuf();
    text = ss.str();
  }
  std::string err;
  auto man = parse_manifest(text, platform_keys(), err);
  if (!man) {
    p->manifest.id = dir.filename().string();
    p->manifest.name = p->manifest.id;
    p->status = PluginStatus::failed;
    p->error = "manifest: " + err;
  } else {
    p->manifest = std::move(*man);
    // SDK 1.2 presets: read with the manifest; a bad one is skipped and logged, never fatal.
    std::vector<std::string> effectNames;
    for (const ManifestEffect& me : p->manifest.effects) effectNames.push_back(me.matchName);
    std::vector<std::string> problems;
    p->presets = read_presets(dir, text, effectNames, problems);
    for (const std::string& why : problems) PREMATION_LOG(warn, "plugin_preset").kv("plugin", p->manifest.id).kv("why", why);
  }
  {
    const std::shared_lock lock(pluginsMutex);
    for (const auto& q : plugins) {
      if (q->manifest.id == p->manifest.id && q.get() != replacing) return nullptr;  // already known (rescans keep what is loaded)
    }
  }
  if (replacing != nullptr && !man) {
    if (reloadWhy != nullptr) *reloadWhy = p->error;
    return nullptr;
  }
  if (replacing != nullptr && p->manifest.id != replacing->manifest.id) {
    if (reloadWhy != nullptr) *reloadWhy = "the manifest's id is now '" + p->manifest.id + "' (was '" + replacing->manifest.id + "')";
    return nullptr;
  }
  // P7: commands, importers, output modules and panels are listed from the manifest, loaded or not.
  if (p->status != PluginStatus::failed || p->error.empty()) self.contrib().note_manifest(p->manifest.id, dir, p->manifest);
  const std::string id = p->manifest.id;
  if (p->status == PluginStatus::failed && !p->error.empty()) {
    // stays failed (manifest)
  } else if (const auto rv = options.revoked.find(id); rv != options.revoked.end()) {
    p->status = PluginStatus::revoked;
    p->error = rv->second.empty() ? std::string("revoked by the plugin registry") : "revoked: " + rv->second;
  } else if (std::string locked = entitlement_lock(p->manifest); !locked.empty()) {
    // Premation Cloud: no valid entitlement token — listed, never loaded. Its
    // effects stay unregistered, so a project using them takes the
    // missing-plugin path (values kept, pass-through, a layerErrors entry).
    p->status = PluginStatus::locked;
    p->error = std::move(locked);
    if (options.attachToDocument) doc::NativeEffects::set_locked(id, true);
  } else if (std::ranges::find(options.disabled, id) != options.disabled.end()) {
    // Disabled by the user: listed, not loaded (no code of it runs).
    p->status = PluginStatus::disabled;
    p->userDisabled = true;
    p->deferred = true;
  } else if (journal && journal->is_quarantined(id)) {
    p->status = PluginStatus::quarantined;
    for (const QuarantineEntry& q : journal->quarantined()) {
      if (q.pluginId == id) p->error = q.reason;
    }
  } else if (std::string why; !sdk_compatible(p->manifest.sdkMajor, p->manifest.sdkMinor, why)) {
    p->status = PluginStatus::failed;
    p->error = why;
  } else {
    p->binary = dir / p->manifest.binary;
    const fs::path loadFrom = options.shadowDir.empty() ? p->binary : shadow_copy(*p, err);
    if (!loadFrom.empty()) p->lib = DynamicLibrary::open(loadFrom, err);
    if (!p->lib) {
      p->status = PluginStatus::failed;
      p->error = err;
    } else {
      auto info_fn = reinterpret_cast<PrPluginInfoFn>(p->lib->symbol(PR_PLUGIN_INFO_SYMBOL));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): the exported entry
      const PrPluginInfo* info = nullptr;
      if (info_fn == nullptr) {
        p->status = PluginStatus::failed;
        p->error = std::string("the binary does not export ") + PR_PLUGIN_INFO_SYMBOL;
      } else {
        struct InfoCall {
          PrPluginInfoFn fn;
          const PrPluginInfo* out;
        } call{info_fn, nullptr};
        const Fault f = guarded_call([](void* c) { auto* x = static_cast<InfoCall*>(c); x->out = x->fn(); }, &call);
        info = call.out;
        std::string binaryWhy;
        if (f) {
          p->status = PluginStatus::failed;
          p->error = std::string(to_string(f.kind)) + " in " + PR_PLUGIN_INFO_SYMBOL;
          p->lib->pin();
        } else if (info == nullptr || info->struct_size < offsetof(PrPluginInfo, command_count) || info->plugin_id == nullptr) {
          p->status = PluginStatus::failed;
          p->error = "PremationPluginInfo returned no valid info";
        } else if (std::string(info->plugin_id) != id) {
          p->status = PluginStatus::failed;
          p->error = "the binary says it is '" + std::string(info->plugin_id) + "', the manifest '" + id + "'";
        } else if (!sdk_compatible(PR_SDK_VERSION_MAJOR_OF(info->sdk_version), PR_SDK_VERSION_MINOR_OF(info->sdk_version), binaryWhy)) {
          p->status = PluginStatus::failed;
          p->error = "binary " + binaryWhy;
        } else if (std::string contribWhy = self.contrib().bind(id, *info); !contribWhy.empty()) {
          p->status = PluginStatus::failed;  // P7: a manifest command / importer / output module without its entry point
          p->error = std::move(contribWhy);
        } else {
          p->status = PluginStatus::loaded;
          p->info = info;
          for (const ManifestEffect& me : p->manifest.effects) {
            PrEffectMainFn main = nullptr;
            for (std::uint32_t i = 0; i < info->effect_count && info->effects != nullptr; ++i) {
              const PrEffectEntry& en = info->effects[i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
              if (en.match_name != nullptr && me.matchName == en.match_name) main = en.main;
            }
            if (main == nullptr) {
              p->status = PluginStatus::failed;
              p->error = "the binary has no entry point for '" + me.matchName + "'";
              break;
            }
            auto e = std::make_unique<EffectSpec>();
            e->matchName = me.matchName;
            e->name = me.name;
            e->category = me.category;
            e->pluginId = id;
            e->main = main;
            p->effects.push_back(std::move(e));
          }
        }
      }
    }
  }
  Plugin* raw = p.get();
  {
    const std::unique_lock lock(pluginsMutex);
    if (replacing == nullptr) plugins.push_back(std::move(p));  // a reload is listed by swap_in, once it is set up
    for (auto& e : raw->effects) ownerOf[e.get()] = raw;
  }
  if (raw->status == PluginStatus::loaded) {
    const std::scoped_lock serial(raw->serial);
    for (auto& e : raw->effects) {
      if (!setup_effect(*raw, *e)) {
        raw->status = PluginStatus::failed;
        break;
      }
    }
  }
  // SDK 1.4: each layer type is drawn by one of the bundle's GENERATOR effects.
  if (raw->status == PluginStatus::loaded) {
    for (const ManifestLayerType& lt : raw->manifest.layerTypes) {
      const auto e = std::ranges::find_if(raw->effects, [&](const auto& x) { return x->matchName == lt.effect; });
      if (e == raw->effects.end() || !(*e)->has(PR_OUT_FLAG_GENERATOR)) {
        raw->status = PluginStatus::failed;
        raw->error = "layer type '" + lt.id + "': effect '" + lt.effect + "' is not a generator (PR_OUT_FLAG_GENERATOR)";
        break;
      }
    }
  }
  if (replacing != nullptr) return swap_in(std::move(p), *replacing, reloadWhy);
  if (raw->status == PluginStatus::loaded) {
    {
      const std::unique_lock lock(pluginsMutex);
      for (auto& e : raw->effects) {
        effects[e->matchName] = e.get();
        raw->gpu = raw->gpu || e->has(PR_OUT_FLAG_GPU_RENDER);
      }
    }
    if (options.attachToDocument) register_document(*raw);
    PREMATION_LOG(info, "plugin_loaded").kv("plugin", id).kv("effects", raw->effects.size());
  } else {
    PREMATION_LOG(warn, "plugin_not_loaded").kv("plugin", id).kv("status", std::string(to_string(raw->status))).kv("error", raw->error);
  }
  return raw;
}

Plugin* PluginHost::Impl::swap_in(std::unique_ptr<Plugin> fresh, Plugin& old, std::string* why) {
  Plugin* raw = fresh.get();
  const std::string id = raw->manifest.id;
  if (raw->status != PluginStatus::loaded) {
    if (why != nullptr) *why = raw->error.empty() ? "the new build " + std::string(to_string(raw->status)) : raw->error;
    // It may have bound its P7 entry points before failing: point them back at the old module.
    if (old.status == PluginStatus::loaded && old.info != nullptr) (void)self.contrib().bind(id, *old.info);
    if (raw->lib) raw->lib->pin();
    retire(std::move(fresh));
    PREMATION_LOG(warn, "plugin_reload_failed").kv("plugin", id).kv("error", why != nullptr ? *why : std::string());
    return nullptr;
  }
  {
    const std::unique_lock lock(pluginsMutex);
    for (auto& e : old.effects) effects.erase(e->matchName);
    for (auto& e : raw->effects) {
      effects[e->matchName] = e.get();
      raw->gpu = raw->gpu || e->has(PR_OUT_FLAG_GPU_RENDER);
    }
    for (auto& slot : plugins) {
      if (slot.get() == &old) {
        std::swap(slot, fresh);  // `fresh` now owns the old record
        break;
      }
    }
  }
  // Renders that resolved the old specs may still be running in its code, and instances and GPU
  // data keyed by them set down through it later: the old module is never unmapped.
  if (old.lib) old.lib->pin();
  {
    const std::scoped_lock lock(failuresMutex);
    std::erase_if(failures, [&](const auto& kv) { return kv.second.pluginId == id; });
  }
  self.contrib().reset(id);
  if (options.attachToDocument) {
    register_document(*raw);
    doc::NativeEffects::set_available(id, true);
  }
  // Idle instances of the old module are set down now; one a render holds is replaced (and set
  // down) by its next render, which sees a different spec under its key (instance_for).
  {
    const std::scoped_lock lock(instancesMutex);
    for (auto it = instances.begin(); it != instances.end();) {
      Instance& inst = *it->second;
      if (plugin_of(inst.effect) != &old) {
        ++it;
        continue;
      }
      std::unique_lock w(inst.mutex, std::try_to_lock);
      if (!w.owns_lock()) {
        ++it;
        continue;
      }
      setdown(inst, old);
      w.unlock();
      it = instances.erase(it);
    }
  }
  retire(std::move(fresh));
  PREMATION_LOG(info, "plugin_reloaded").kv("plugin", id).kv("effects", raw->effects.size());
  return raw;
}

bool PluginHost::reload(std::string_view pluginId, std::string& why) {
  Impl& m = *impl_;
  Plugin* p = nullptr;
  {
    const std::shared_lock lock(m.pluginsMutex);
    for (const auto& q : m.plugins) {
      if (q->manifest.id == pluginId) p = q.get();
    }
  }
  if (p == nullptr) {
    why = "no plugin '" + std::string(pluginId) + "'";
    return false;
  }
  if (p->status == PluginStatus::revoked || p->status == PluginStatus::locked) {
    why = "plugin '" + p->manifest.id + "' is " + std::string(to_string(p->status));
    return false;
  }
  if (p->userDisabled) {
    why = "plugin '" + p->manifest.id + "' is disabled; enable it first";
    return false;
  }
  // A reload is the author trying again: a quarantine from the last build does not hold the new one.
  if (m.journal) m.journal->release(pluginId);
  return m.load_bundle(p->dir, p, &why) != nullptr;
}

bool PluginHost::Impl::setup_effect(Plugin& p, EffectSpec& e) {
  // GLOBAL_SETUP
  {
    PrHost ctx;
    ctx.host = &self;
    ctx.cmd = PR_CMD_GLOBAL_SETUP;
    PrInData in = base_in(ctx, e);
    PrOutData out{};
    reset_out(out, 0, 0);
    const CallResult r = invoke(p.manifest.id, e.main, PR_CMD_GLOBAL_SETUP, &in, &out, nullptr, nullptr, nullptr);
    if (!r.ok) {
      p.error = "'" + e.matchName + "' GLOBAL_SETUP: " + r.message;
      if (r.fault && p.lib) p.lib->pin();
      return false;
    }
    e.outFlags = out.out_flags;
    e.version = out.my_version;
    e.globalData = out.global_data;
  }
  // PARAMS_SETUP
  {
    PrHost ctx;
    ctx.host = &self;
    ctx.cmd = PR_CMD_PARAMS_SETUP;
    ctx.declared = &e.params;
    PrInData in = base_in(ctx, e);
    in.global_data = e.globalData;
    PrOutData out{};
    reset_out(out, e.globalData, 0);
    const CallResult r = invoke(p.manifest.id, e.main, PR_CMD_PARAMS_SETUP, &in, &out, nullptr, nullptr, nullptr);
    if (!r.ok || !ctx.setupError.empty()) {
      p.error = "'" + e.matchName + "' PARAMS_SETUP: " + (ctx.setupError.empty() ? r.message : ctx.setupError);
      if (r.fault && p.lib) p.lib->pin();
      return false;
    }
    if (!ctx.groups.empty()) {
      p.error = "'" + e.matchName + "' PARAMS_SETUP: a GROUP_START without its GROUP_END";
      return false;
    }
    e.globalData = out.global_data;
  }
  // ABOUT (text only; a failure is not fatal)
  {
    PrHost ctx;
    ctx.host = &self;
    ctx.cmd = PR_CMD_ABOUT;
    PrInData in = base_in(ctx, e);
    PrOutData out{};
    reset_out(out, e.globalData, 0);
    const CallResult r = invoke(p.manifest.id, e.main, PR_CMD_ABOUT, &in, &out, nullptr, nullptr, nullptr);
    if (r.ok) e.about = std::string(out.return_msg, strnlen(out.return_msg, sizeof(out.return_msg)));
    else if (r.fault) {
      p.error = "'" + e.matchName + "' ABOUT: " + r.message;
      if (p.lib) p.lib->pin();
      return false;
    }
  }
  e.ready = true;
  return true;
}

namespace {

std::string hex2(double v) {
  const int n = static_cast<int>(std::lround(std::clamp(v, 0.0, 1.0) * 255));
  std::array<char, 3> b{};
  std::snprintf(b.data(), b.size(), "%02x", n);
  return {b.data(), 2};
}

/// SDK 1.1: a bundle's panel is `ui/index.html` (the editor serves `ui/` as `plugin-ui://<id>/`).
bool has_panel(const fs::path& dir) {
  std::error_code ec;
  return fs::is_regular_file(dir / "ui" / "index.html", ec);
}

std::string hex_color(const std::array<double, 4>& c) {
  std::string s = "#" + hex2(c[0]) + hex2(c[1]) + hex2(c[2]);
  if (c[3] < 1) s += hex2(c[3]);
  return s;
}

}  // namespace

void PluginHost::Impl::register_document(const Plugin& p) {
  for (const ManifestLayerType& lt : p.manifest.layerTypes) {
    doc::NativeEffects::add_layer_type({p.manifest.id + ":" + lt.id, lt.name, lt.effect, lt.category, p.manifest.id});
  }
  for (const auto& e : p.effects) {
    doc::NativeEffect ne;
    ne.def.type = e->matchName;
    ne.def.label = e->name;
    ne.provider = p.manifest.id;
    ne.category = e->category;
    ne.gpu = e->has(PR_OUT_FLAG_GPU_RENDER);
    ne.supportsFloat = e->has(PR_OUT_FLAG_FLOAT_COLOR_AWARE);
    ne.generator = e->has(PR_OUT_FLAG_GENERATOR);
    ne.overlay = e->has(PR_OUT_FLAG_CUSTOM_OVERLAY);
    ne.panel = has_panel(p.dir);
    ne.about = e->about;
    for (const ParamSpec& s : e->params) {
      doc::EffectParamDef d;
      d.key = s.key;
      d.label = s.name;
      if (!s.group.empty()) d.group = s.group;
      d.fixed = (s.flags & PR_PARAM_FLAG_CANNOT_ANIMATE) != 0;
      d.description = s.description;
      if ((s.flags & PR_PARAM_FLAG_SUPERVISE) != 0 && s.type != PR_PARAM_BUTTON) ne.supervised.push_back(s.key);
      switch (s.type) {
        case PR_PARAM_SLIDER:
        case PR_PARAM_FLOAT_SLIDER:
        case PR_PARAM_ANGLE:
          d.type = "number";
          d.def = js::Json::number(s.def[0]);
          if (s.type == PR_PARAM_ANGLE) d.unit = "°";
          if (s.validMax > s.validMin) {
            d.min = s.validMin;
            d.max = s.validMax;
          }
          d.precision = s.type == PR_PARAM_SLIDER ? 0 : s.precision;
          ne.def.params.push_back(std::move(d));
          break;
        case PR_PARAM_POINT:
        case PR_PARAM_POINT_3D: {
          // A point is its axes as numbers (the document's convention for effect
          // points: offsets from the layer centre, layer px): p<id>X, p<id>Y (, p<id>Z).
          const char* axes = s.type == PR_PARAM_POINT_3D ? "XYZ" : "XY";
          for (std::size_t i = 0; axes[i] != '\0'; ++i) {  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
            doc::EffectParamDef a;
            a.key = s.key + axes[i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
            a.label = s.name + " " + axes[i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
            a.type = "number";
            a.unit = "px";
            a.def = js::Json::number(s.def.at(i));
            if (!s.group.empty()) a.group = s.group;
            a.fixed = d.fixed;
            a.description = d.description;
            ne.def.params.push_back(std::move(a));
          }
          break;
        }
        case PR_PARAM_COLOR:
          d.type = "color";
          d.def = js::Json::string(hex_color(s.def));
          ne.def.params.push_back(std::move(d));
          break;
        case PR_PARAM_POPUP:
          d.type = "enum";
          for (std::size_t i = 0; i < s.choices.size(); ++i) d.options.push_back({static_cast<double>(i + 1), s.choices[i]});
          d.def = js::Json::number(std::clamp(std::round(s.def[0]), 1.0, static_cast<double>(s.choices.size())));
          ne.def.params.push_back(std::move(d));
          break;
        case PR_PARAM_CHECKBOX:
          d.type = "checkbox";
          d.def = js::Json::boolean(s.def[0] != 0);
          ne.def.params.push_back(std::move(d));
          break;
        case PR_PARAM_LAYER:
          d.type = "layer";
          d.def = js::Json::string("");
          ne.def.params.push_back(std::move(d));
          break;
        case PR_PARAM_PATH:
          d.type = "maskPath";
          d.def = js::Json::string("");
          ne.def.params.push_back(std::move(d));
          break;
        case PR_PARAM_ARBITRARY_DATA: ne.arbitrary.push_back(s.key); break;
        case PR_PARAM_BUTTON:
          ne.actions.push_back({s.key, s.name, s.group, static_cast<std::uint32_t>(ne.def.params.size())});
          break;
        case PR_PARAM_CUSTOM_UI: {  // SDK 1.3: a box the plugin draws, placed like a button
          const auto at = static_cast<std::uint32_t>(ne.def.params.size());
          const auto before = static_cast<std::uint32_t>(std::ranges::count(ne.actions, at, &doc::NativeAction::at));
          ne.customUis.push_back({s.key, s.name, s.group, at, s.def[0], s.description, before});
          break;
        }
        // SDK 1.1 — static values: a string, the Curves effect's point list, stops, a project item.
        case PR_PARAM_STRING:
          d.type = "text";
          d.def = js::Json::string(s.text);
          ne.def.params.push_back(std::move(d));
          break;
        case PR_PARAM_CURVE:
          d.type = "curve";
          d.def = doc::native_curve_json(s.curve);
          ne.def.params.push_back(std::move(d));
          break;
        case PR_PARAM_GRADIENT:
          d.type = "gradient";
          d.def = doc::native_gradient_json(s.gradient);
          ne.def.params.push_back(std::move(d));
          break;
        case PR_PARAM_FILE:
          d.type = "file";
          d.def = js::Json::string("");
          ne.files.emplace_back(s.key, s.fileTypes);
          ne.def.params.push_back(std::move(d));
          break;
        case PR_PARAM_GROUP_START:
          // Its params carry the path in `group`; the card also needs the group's key (hiding it
          // through set_param_ui hides the whole group) and whether it opens twirled up.
          ne.groups.push_back({s.group.empty() ? s.name : s.group + " / " + s.name, s.key, (s.flags & PR_PARAM_FLAG_START_COLLAPSED) != 0,
                               s.description});
          break;
        default: break;  // GROUP_END: the next param's `group` already says it
      }
    }
    doc::NativeEffects::add(std::move(ne));
  }
  doc::NativeEffects::set_available(p.manifest.id, true);
}

std::vector<PluginRecord> PluginHost::plugins() const {
  const Impl& m = *impl_;
  const std::shared_lock lock(m.pluginsMutex);
  std::vector<PluginRecord> out;
  for (const auto& p : m.plugins) {
    PluginRecord r;
    r.id = p->manifest.id;
    r.name = p->manifest.name;
    r.version = p->manifest.version;
    r.vendor = p->manifest.vendor;
    r.sdk = std::to_string(p->manifest.sdkMajor) + "." + std::to_string(p->manifest.sdkMinor);
    r.path = p->dir.string();
    r.status = p->status;
    r.error = p->error;
    for (const auto& e : p->effects) r.effects.push_back(e->matchName);
    if (r.effects.empty()) {
      for (const ManifestEffect& me : p->manifest.effects) r.effects.push_back(me.matchName);
    }
    r.gpu = p->gpu;
    r.panel = has_panel(p->dir);
    if (std::error_code ec; !p->manifest.icon.empty() && fs::is_regular_file(p->dir / fs::path(p->manifest.icon), ec)) r.icon = p->manifest.icon;
    r.panelTitle = p->manifest.panelTitle;
    out.push_back(std::move(r));
  }
  return out;
}

bool PluginHost::set_enabled(std::string_view pluginId, bool enabled) {
  Impl& m = *impl_;
  Plugin* p = nullptr;
  {
    const std::shared_lock lock(m.pluginsMutex);
    for (const auto& q : m.plugins) {
      if (q->manifest.id == pluginId) p = q.get();
    }
  }
  if (p == nullptr) return false;
  if (p->status == PluginStatus::revoked) return true;  // listed revoked; never runs
  if (p->status == PluginStatus::locked) return true;   // needs an entitlement; a new token takes a restart
  if (!enabled) {
    p->userDisabled = true;
    if (p->status == PluginStatus::loaded) p->status = PluginStatus::disabled;
    doc::NativeEffects::set_available(pluginId, false);
    return true;
  }
  p->userDisabled = false;
  contrib_->reset(p->manifest.id);  // P7: re-arm crashed commands / importers
  {
    const std::scoped_lock lock(m.failuresMutex);
    std::erase_if(m.failures, [&](const auto& kv) { return kv.second.pluginId == pluginId; });
  }
  if (p->status == PluginStatus::disabled && !p->deferred) {
    p->status = PluginStatus::loaded;
    doc::NativeEffects::set_available(pluginId, true);
    return true;
  }
  if (p->status == PluginStatus::quarantined || p->status == PluginStatus::failed || p->deferred) {
    // The user asks to try again (or turns on a plugin disabled at start):
    // forget the quarantine and the start-up disable, and reload the bundle.
    if (m.journal) m.journal->release(pluginId);
    std::erase(m.options.disabled, std::string(pluginId));
    const fs::path dir = p->dir;
    {
      const std::unique_lock lock(m.pluginsMutex);
      for (auto& e : p->effects) m.effects.erase(e->matchName);
      // A module that faulted stays mapped (pinned); the record is replaced.
      for (auto it = m.plugins.begin(); it != m.plugins.end(); ++it) {
        if (it->get() == p) {
          if ((*it)->lib) (*it)->lib->pin();
          // Effect specs stay alive (documents may hold `const EffectSpec*` via instances).
          static std::vector<std::unique_ptr<Plugin>> retired;  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables): never freed on purpose
          retired.push_back(std::move(*it));
          m.plugins.erase(it);
          break;
        }
      }
    }
    m.load_bundle(dir);
  }
  return true;
}

const EffectSpec* PluginHost::effect(std::string_view matchName) const {
  const Impl& m = *impl_;
  const std::shared_lock lock(m.pluginsMutex);
  const auto it = m.effects.find(std::string(matchName));
  return it == m.effects.end() ? nullptr : it->second;
}

// ── instances + sequence data ─────────────────────────────────────────────

void PluginHost::Impl::setdown(Instance& inst, Plugin& p) {
  if (!inst.built || inst.sequence == 0 || inst.effect == nullptr) {
    inst.built = false;
    return;
  }
  const std::scoped_lock serial(p.serial);
  PrHost ctx;
  ctx.host = &self;
  ctx.cmd = PR_CMD_SEQUENCE_SETDOWN;
  PrInData in = base_in(ctx, *inst.effect);
  in.sequence_data = inst.sequence;
  PrOutData out{};
  reset_out(out, inst.effect->globalData, inst.sequence);
  const CallResult r = invoke(p.manifest.id, inst.effect->main, PR_CMD_SEQUENCE_SETDOWN, &in, &out, nullptr, nullptr, nullptr);
  if (r.fault) on_fault(p, inst.effect, nullptr, r);
  handles.dispose(inst.sequence);  // whatever the plugin forgot
  inst.sequence = 0;
  inst.built = false;
}

bool PluginHost::Impl::ensure_setup(Instance& inst, const RenderInputs& in, const EffectSpec& e, Plugin& p, std::uint64_t hash,
                                    CallResult& r) {
  const std::unique_lock write(inst.mutex);
  if (inst.built && inst.flatHash == hash) return true;
  setdown(inst, p);
  const std::scoped_lock serial(p.serial);
  PrHost ctx;
  ctx.host = &self;
  const PrCmd cmd = in.sequence.empty() ? PR_CMD_SEQUENCE_SETUP : PR_CMD_SEQUENCE_RESETUP;
  ctx.cmd = cmd;
  PrInData d = base_in(ctx, e);
  fill_in_data(d, in);
  const PrHandle flat = in.sequence.empty() ? 0 : handles.from(in.sequence);
  d.sequence_data = flat;
  PrOutData out{};
  reset_out(out, e.globalData, flat);
  r = invoke(p.manifest.id, e.main, cmd, &d, &out, nullptr, nullptr, nullptr);
  if (!r.ok) {
    if (flat != 0 && out.sequence_data != flat) handles.dispose(flat);
    if (out.sequence_data != 0) handles.dispose(out.sequence_data);
    return false;
  }
  if (flat != 0 && out.sequence_data != flat) handles.dispose(flat);  // the plugin replaced the flat copy
  inst.sequence = out.sequence_data;
  inst.flatHash = hash;
  inst.built = true;
  return true;
}

InstanceLease PluginHost::Impl::instance_for(const RenderInputs& in, const EffectSpec& e, Plugin& p, CallResult& r) {
  std::shared_ptr<Instance> inst;
  std::shared_ptr<Instance> replaced;
  {
    const std::scoped_lock lock(instancesMutex);
    auto& slot = instances[in.instance];
    if (!slot || slot->effect != &e) {
      replaced = std::move(slot);  // another effect under the same key (a plugin reload): set down below
      slot = std::make_shared<Instance>();
      slot->effect = &e;
    }
    inst = slot;
  }
  if (replaced && replaced->effect != nullptr) {
    if (Plugin* old = plugin_of(replaced->effect)) {
      const std::unique_lock w(replaced->mutex);
      setdown(*replaced, *old);
    }
  }
  inst->lastFrame.store(self.frame_.load(std::memory_order_relaxed), std::memory_order_relaxed);
  inst->layerW.store(in.layerW, std::memory_order_relaxed);
  inst->layerH.store(in.layerH, std::memory_order_relaxed);
  if (!e.has(PR_OUT_FLAG_SEQUENCE_DATA)) {
    InstanceLease lease{inst, std::shared_lock(inst->mutex)};
    return lease;
  }
  const std::uint64_t h = fnv1a(in.sequence);
  // Another thread may rebuild the instance for a different document state
  // between setup and the shared lock: re-check under the lock.
  for (int attempt = 0; attempt < 8; ++attempt) {
    {
      std::shared_lock read(inst->mutex);
      if (inst->built && inst->flatHash == h) return InstanceLease{inst, std::move(read)};
    }
    if (!ensure_setup(*inst, in, e, p, h, r)) return {};
  }
  r.message = "sequence data changed under the render too often";
  return {};
}

std::optional<std::vector<std::uint8_t>> PluginHost::initial_sequence(std::string_view matchName) {
  Impl& m = *impl_;
  EffectSpec* e = nullptr;
  {
    const std::shared_lock lock(m.pluginsMutex);
    const auto it = m.effects.find(std::string(matchName));
    if (it != m.effects.end()) e = it->second;
  }
  if (e == nullptr || !e->has(PR_OUT_FLAG_SEQUENCE_DATA)) return std::nullopt;
  Plugin* p = m.plugin_of(e);
  if (p == nullptr || p->status != PluginStatus::loaded) return std::nullopt;
  const std::scoped_lock serial(p->serial);
  PrHost ctx;
  ctx.host = this;
  ctx.cmd = PR_CMD_SEQUENCE_SETUP;
  PrInData in = m.base_in(ctx, *e);
  PrOutData out{};
  Impl::reset_out(out, e->globalData, 0);
  CallResult r = m.invoke(p->manifest.id, e->main, PR_CMD_SEQUENCE_SETUP, &in, &out, nullptr, nullptr, nullptr);
  if (!r.ok) {
    if (r.fault) m.on_fault(*p, e, nullptr, r);
    return std::nullopt;
  }
  const PrHandle live = out.sequence_data;
  ctx.cmd = PR_CMD_SEQUENCE_FLATTEN;
  in.sequence_data = live;
  Impl::reset_out(out, e->globalData, live);
  r = m.invoke(p->manifest.id, e->main, PR_CMD_SEQUENCE_FLATTEN, &in, &out, nullptr, nullptr, nullptr);
  std::optional<std::vector<std::uint8_t>> bytes;
  if (r.ok) bytes = m.handles.bytes(out.sequence_data);
  const PrHandle flat = out.sequence_data;
  ctx.cmd = PR_CMD_SEQUENCE_SETDOWN;
  in.sequence_data = live;
  Impl::reset_out(out, e->globalData, live);
  (void)m.invoke(p->manifest.id, e->main, PR_CMD_SEQUENCE_SETDOWN, &in, &out, nullptr, nullptr, nullptr);
  m.handles.dispose(live);
  if (flat != live) m.handles.dispose(flat);
  return bytes;
}

void PluginHost::collect_instances(std::uint64_t idleFrames) {
  Impl& m = *impl_;
  const std::uint64_t now = frame_.load(std::memory_order_relaxed);
  const std::scoped_lock lock(m.instancesMutex);
  for (auto it = m.instances.begin(); it != m.instances.end();) {
    Instance& inst = *it->second;  // a lease may still hold it: erasing only drops the table's share
    if (now - inst.lastFrame.load(std::memory_order_relaxed) > idleFrames) {
      // try_lock: an instance a render holds right now is not idle.
      std::unique_lock w(inst.mutex, std::try_to_lock);
      if (!w.owns_lock()) {
        ++it;
        continue;
      }
      if (Plugin* p = m.plugin_of(inst.effect); p != nullptr && p->status == PluginStatus::loaded) m.setdown(inst, *p);
      w.unlock();
      it = m.instances.erase(it);
    } else {
      ++it;
    }
  }
}

// ── params ───────────────────────────────────────────────────────────────

void PluginHost::Impl::fill_in_data(PrInData& d, const RenderInputs& in) const {
  d.current_time = in.layerTime;
  d.comp_time = in.compTime;
  d.time_step = in.timeStep;
  d.frame_rate = in.fps;
  d.width = in.layerW;
  d.height = in.layerH;
  d.world_width = in.worldW;
  d.world_height = in.worldH;
  for (std::size_t i = 0; i < 9; ++i) d.layer_to_world[i] = in.layerToWorld.at(i);  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
  d.pixel_scale_x = std::hypot(in.layerToWorld[0], in.layerToWorld[3]);
  d.pixel_scale_y = std::hypot(in.layerToWorld[1], in.layerToWorld[4]);
  d.project_bit_depth = in.projectBits;
  d.quality = in.draft ? PR_QUALITY_DRAFT : PR_QUALITY_HIGH;
  d.instance_key = in.instance.c_str();
  // SDK 1.2.
  d.layer_start = in.layerStart;
  d.comp_width = in.compW;
  d.comp_height = in.compH;
  d.layer_is_3d = in.layer3d ? 1 : 0;
  d.motion_blur = in.motionBlur ? 1 : 0;
  d.shutter_angle = in.shutterAngle;
  d.shutter_phase = in.shutterPhase;
  d.motion_blur_samples = in.motionBlurSamples;
  for (std::size_t i = 0; i < 9; ++i) d.comp_to_world[i] = in.compToWorld.at(i);  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
}

ParamDefs PluginHost::Impl::param_defs(const EffectSpec& e, const RenderInputs& in, std::vector<PrParamDef*>& ptrs,
                                       const std::vector<ParamValue>* values) const {
  const std::vector<ParamValue>& vals = values != nullptr ? *values : in.values;
  ParamDefs out;
  std::vector<PrParamDef>& defs = out.defs;
  defs.resize(e.params.size() + 1);
  std::size_t gradients = 0;
  for (const ParamSpec& s : e.params) gradients += s.type == PR_PARAM_GRADIENT ? 1 : 0;
  out.owned.reserve(gradients);
  PrParamDef& input = defs[0];
  input.struct_size = sizeof(PrParamDef);
  input.type = PR_PARAM_LAYER;
  input.name = "Input";
  input.layer_id = in.layerId.c_str();
  for (std::size_t i = 0; i < e.params.size(); ++i) {
    const ParamSpec& s = e.params[i];
    PrParamDef& d = defs[i + 1];
    d.struct_size = sizeof(PrParamDef);
    d.type = s.type;
    d.id = s.id;
    d.flags = s.flags;
    d.name = s.name.c_str();
    d.valid_min = s.validMin;
    d.valid_max = s.validMax;
    d.slider_min = s.sliderMin;
    d.slider_max = s.sliderMax;
    d.precision = s.precision;
    const ParamValue* v = i < vals.size() ? &vals[i] : nullptr;
    for (std::size_t k = 0; k < 4; ++k) d.value[k] = v != nullptr ? v->v.at(k) : s.def.at(k);  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
    if (s.type == PR_PARAM_POINT || s.type == PR_PARAM_POINT_3D) {
      // The document stores centre offsets; the plugin sees layer px from the top-left (AE).
      d.value[0] += in.layerW / 2.0;
      d.value[1] += in.layerH / 2.0;
    }
    if ((s.type == PR_PARAM_SLIDER || s.type == PR_PARAM_FLOAT_SLIDER || s.type == PR_PARAM_ANGLE) && s.validMax > s.validMin) {
      d.value[0] = std::clamp(d.value[0], s.validMin, s.validMax);
    }
    if (s.type == PR_PARAM_SLIDER) d.value[0] = std::round(d.value[0]);
    if (s.type == PR_PARAM_COLOR) {
      for (std::size_t k = 0; k < 3; ++k) d.value[k] = srgb_to_linear(d.value[k]);  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index): alpha stays as is
    }
    if (v != nullptr) {
      if (s.type == PR_PARAM_LAYER) d.layer_id = v->layer.empty() ? nullptr : v->layer.c_str();
      if (s.type == PR_PARAM_PATH && !v->path.empty()) {
        d.path = v->path.data();
        d.path_count = static_cast<std::uint32_t>(v->path.size() / 6);
        d.path_closed = v->pathClosed ? 1 : 0;
      }
      if (s.type == PR_PARAM_ARBITRARY_DATA && !v->arb.empty()) {
        d.arb_data = v->arb.data();
        d.arb_size = static_cast<std::uint32_t>(v->arb.size());
      }
    }
    // SDK 1.1: the value, else the declared default (the spec outlives the call).
    switch (s.type) {
      case PR_PARAM_STRING: d.text = v != nullptr ? v->text.c_str() : s.text.c_str(); break;
      case PR_PARAM_CURVE: {
        const std::vector<double>& c = v != nullptr && v->curve.size() >= 4 ? v->curve : s.curve;
        d.curve = c.data();
        d.curve_count = static_cast<std::uint32_t>(c.size() / 2);
        break;
      }
      case PR_PARAM_GRADIENT: {
        const std::vector<double>& g = v != nullptr && v->gradient.size() >= 5 ? v->gradient : s.gradient;
        std::vector<double>& lin = out.owned.emplace_back(g);
        for (std::size_t at = 0; at + 5 <= lin.size(); at += 5) {
          for (std::size_t k = 1; k <= 3; ++k) lin[at + k] = srgb_to_linear(lin[at + k]);  // position, r, g, b, a: the colour only
        }
        d.gradient = lin.data();
        d.gradient_count = static_cast<std::uint32_t>(lin.size() / 5);
        break;
      }
      case PR_PARAM_FILE:
        d.file_types = s.fileTypes.c_str();
        if (v != nullptr && !v->fileItem.empty()) {
          d.file_name = v->fileName.c_str();
          d.file_missing = v->fileMissing || v->filePath.empty() ? 1 : 0;
        }
        break;
      default: break;
    }
  }
  ptrs.resize(defs.size());
  for (std::size_t i = 0; i < defs.size(); ++i) ptrs[i] = &defs[i];
  return out;
}

PrPixelFormat PluginHost::world_format(const EffectSpec& e, std::uint32_t projectBits) noexcept {
  if (projectBits >= 32 && e.has(PR_OUT_FLAG_FLOAT_COLOR_AWARE)) return PR_PIXEL_FORMAT_RGBA32F;
  if (projectBits >= 16 && (e.has(PR_OUT_FLAG_DEEP_COLOR_AWARE) || e.has(PR_OUT_FLAG_FLOAT_COLOR_AWARE))) {
    return e.has(PR_OUT_FLAG_DEEP_COLOR_AWARE) ? PR_PIXEL_FORMAT_RGBA16 : PR_PIXEL_FORMAT_RGBA32F;
  }
  return PR_PIXEL_FORMAT_RGBA8;
}

bool PluginHost::instance_disabled(std::string_view instance, std::string* why) const {
  const Impl& m = *impl_;
  const std::scoped_lock lock(m.failuresMutex);
  const auto it = m.failures.find(std::string(instance));
  if (it == m.failures.end()) return false;
  if (why != nullptr) *why = it->second.message;
  return true;
}

std::vector<InstanceFailure> PluginHost::failures() const {
  const Impl& m = *impl_;
  const std::scoped_lock lock(m.failuresMutex);
  std::vector<InstanceFailure> out;
  out.reserve(m.failures.size());
  for (const auto& [k, f] : m.failures) out.push_back(f);
  return out;
}

// ── render selectors ─────────────────────────────────────────────────────

namespace {
/// Resolve the effect + plugin for a render call; false (with `r` filled) when it must not run.
bool resolve(PluginHost& host, PluginHost::Impl& m, const RenderInputs& in, EffectSpec*& e, Plugin*& p, CallResult& r) {
  {
    const std::shared_lock lock(m.pluginsMutex);
    const auto it = m.effects.find(in.matchName);
    e = it == m.effects.end() ? nullptr : it->second;
  }
  p = e != nullptr ? m.plugin_of(e) : nullptr;
  if (e == nullptr || p == nullptr) {
    r.skipped = true;
    r.message = "no loaded plugin provides '" + in.matchName + "'";
    return false;
  }
  if (p->status != PluginStatus::loaded) {
    r.skipped = true;
    r.message = "plugin '" + p->manifest.id + "' is " + std::string(to_string(p->status)) + (p->error.empty() ? "" : ": " + p->error);
    return false;
  }
  if (std::string why; host.instance_disabled(in.instance, &why)) {
    r.skipped = true;
    r.message = why;
    return false;
  }
  return true;
}

/// The render-selector lock: exclusive per plugin unless the effect is thread-safe.
class RenderLock {
 public:
  RenderLock(Plugin& p, const EffectSpec& e) : lock_(p.serial, std::defer_lock) {
    if (!e.has(PR_OUT_FLAG_THREADED_RENDER)) lock_.lock();
  }

 private:
  std::unique_lock<std::recursive_mutex> lock_;
};
}  // namespace

CallResult PluginHost::Impl::call_render(Plugin& p, EffectSpec& e, const RenderInputs& in, PrHost& ctx, PrCmd cmd, PrWorld* output,
                                         void* extra, PrHandle sequence) {
  std::vector<PrParamDef*> ptrs;
  ParamDefs defs = param_defs(e, in, ptrs);
  PrInData d = base_in(ctx, e);
  fill_in_data(d, in);
  ctx.cmd = cmd;
  ctx.renderSelector = true;
  ctx.inputs = &in;
  ctx.effect = &e;
  ctx.outFlags = e.outFlags;
  ctx.numParams = d.num_params;
  ctx.params = &e.params;
  d.sequence_data = sequence;
  PrOutData out{};
  reset_out(out, e.globalData, d.sequence_data);
  CallResult r = invoke(p.manifest.id, e.main, cmd, &d, &out, ptrs.data(), output, extra);
  if (!r.fault && ctx.iterateFault) {
    r.ok = false;
    r.fault = ctx.iterateFault;
    r.message = std::string(to_string(ctx.iterateFault.kind)) + " in " + std::string(command_name(cmd)) + " (a worker job)";
  }
  // SDK 1.4: a SIM_STEP's new state outlives the call (sim_state reads it, then disposes it).
  const PrHandle keep = cmd == PR_CMD_SIM_STEP && extra != nullptr ? static_cast<const PrSimStepExtra*>(extra)->state_out : 0;
  for (const PrHandle h : ctx.scoped) {
    if (h != keep) handles.dispose(h);
  }
  ctx.scoped.clear();
  if (r.fault) on_fault(p, &e, &in, r);
  return r;
}

CallResult PluginHost::pre_render(const RenderInputs& in, std::vector<CheckoutRequest>& out, PreRenderInfo* info) {
  Impl& m = *impl_;
  CallResult r;
  EffectSpec* e = nullptr;
  Plugin* p = nullptr;
  out.clear();
  if (info != nullptr) {
    info->times.clear();
    info->request = info->result = PrRect{0, 0, in.worldW, in.worldH};
  }
  if (!resolve(*this, m, in, e, p, r)) return r;
  if (!e->has(PR_OUT_FLAG_SMART_RENDER)) {
    // A non-smart effect reads its input at the current time, nothing else.
    if (!e->has(PR_OUT_FLAG_GENERATOR)) out.push_back({0, 0, in.layerTime});
    r.ok = true;
    return r;
  }
  const InstanceLease lease = m.instance_for(in, *e, *p, r);
  if (!lease) {
    if (r.fault) m.on_fault(*p, e, &in, r);
    return r;
  }
  const RenderLock lock(*p, *e);
  PrHost ctx;
  ctx.host = this;
  ctx.checkouts = &out;
  if (info != nullptr) {
    info->times.clear();
    ctx.times = &info->times;
  }
  PrPreRenderExtra x{};
  x.struct_size = sizeof(PrPreRenderExtra);
  x.request_rect = {0, 0, in.worldW, in.worldH};
  x.result_rect = x.request_rect;
  r = m.call_render(*p, *e, in, ctx, PR_CMD_SMART_PRE_RENDER, nullptr, &x, lease.sequence());
  if (info != nullptr) {
    info->request = x.request_rect;
    info->result = x.result_rect;
  }
  if (x.pre_render_data != 0) m.handles.dispose(x.pre_render_data);  // G1: pre-render data is per call (see PLUGIN_SDK.md)
  return r;
}

CallResult PluginHost::render_cpu(const RenderInputs& in, CheckoutSource& io, PrPixelFormat /*format*/) {
  Impl& m = *impl_;
  CallResult r;
  EffectSpec* e = nullptr;
  Plugin* p = nullptr;
  if (!resolve(*this, m, in, e, p, r)) return r;
  const InstanceLease lease = m.instance_for(in, *e, *p, r);
  if (!lease) {
    if (r.fault) m.on_fault(*p, e, &in, r);
    return r;
  }
  const RenderLock lock(*p, *e);
  PrHost ctx;
  ctx.host = this;
  ctx.source = &io;
  if (e->has(PR_OUT_FLAG_SMART_RENDER)) {
    // Pre-render again on this thread: its data handle belongs to this render.
    std::vector<CheckoutRequest> reqs;
    PrHost pre;
    pre.host = this;
    pre.checkouts = &reqs;
    PrPreRenderExtra px{};
    px.struct_size = sizeof(PrPreRenderExtra);
    px.request_rect = {0, 0, in.worldW, in.worldH};
    px.result_rect = px.request_rect;
    r = m.call_render(*p, *e, in, pre, PR_CMD_SMART_PRE_RENDER, nullptr, &px, lease.sequence());
    if (!r.ok) return r;
    PrSmartRenderExtra x{};
    x.struct_size = sizeof(PrSmartRenderExtra);
    x.pre_render_data = px.pre_render_data;
    r = m.call_render(*p, *e, in, ctx, PR_CMD_SMART_RENDER, nullptr, &x, lease.sequence());
    if (px.pre_render_data != 0) m.handles.dispose(px.pre_render_data);
    return r;
  }
  // Non-smart: FRAME_SETUP, RENDER (params[0]->world = the input), FRAME_SETDOWN.
  PrWorld* input = io.cpu_checkout(0);
  PrWorld* output = io.cpu_output();
  r = m.call_render(*p, *e, in, ctx, PR_CMD_FRAME_SETUP, output, nullptr, lease.sequence());
  if (!r.ok) return r;
  {
    std::vector<PrParamDef*> ptrs;
    ParamDefs defs = m.param_defs(*e, in, ptrs);
    defs.defs[0].world = input;
    PrInData d = m.base_in(ctx, *e);
    m.fill_in_data(d, in);
    ctx.cmd = PR_CMD_RENDER;
    ctx.renderSelector = true;
    ctx.inputs = &in;
    ctx.effect = e;
    ctx.outFlags = e->outFlags;
    ctx.numParams = d.num_params;
    ctx.params = &e->params;
    d.sequence_data = lease.sequence();
    PrOutData out{};
    Impl::reset_out(out, e->globalData, d.sequence_data);
    r = m.invoke(p->manifest.id, e->main, PR_CMD_RENDER, &d, &out, ptrs.data(), output, nullptr);
    if (!r.fault && ctx.iterateFault) {
      r.ok = false;
      r.fault = ctx.iterateFault;
      r.message = std::string(to_string(ctx.iterateFault.kind)) + " in RENDER (a worker job)";
    }
    for (const PrHandle h : ctx.scoped) m.handles.dispose(h);
    ctx.scoped.clear();
    if (r.fault) {
      m.on_fault(*p, e, &in, r);
      return r;
    }
  }
  const CallResult down = m.call_render(*p, *e, in, ctx, PR_CMD_FRAME_SETDOWN, output, nullptr, lease.sequence());
  if (!down.ok && r.ok) return down;
  return r;
}

CallResult PluginHost::render_gpu(const RenderInputs& in, CheckoutSource& io, const PrGpuDeviceInfo& device, void* encoder,
                                  const PrGpuWorld& input, const PrGpuWorld& output) {
  Impl& m = *impl_;
  CallResult r;
  EffectSpec* e = nullptr;
  Plugin* p = nullptr;
  if (!resolve(*this, m, in, e, p, r)) return r;
  if (!e->has(PR_OUT_FLAG_GPU_RENDER)) {
    r.skipped = true;
    r.message = "not a GPU effect";
    return r;
  }
  const auto key = std::make_pair(static_cast<const EffectSpec*>(e), device.device_index);
  PrHandle gpuData = 0;
  {
    const std::scoped_lock lock(m.gpuMutex);
    if (const auto f = m.gpuFailed.find(key); f != m.gpuFailed.end()) {
      r.skipped = true;
      r.message = f->second;
      return r;
    }
    if (const auto it = m.gpuData.find(key); it != m.gpuData.end()) gpuData = it->second;
  }
  if (gpuData == 0) {
    const std::scoped_lock serial(p->serial);
    PrHost ctx;
    ctx.host = this;
    ctx.cmd = PR_CMD_GPU_DEVICE_SETUP;
    PrInData d = m.base_in(ctx, *e);
    PrOutData out{};
    Impl::reset_out(out, e->globalData, 0);
    PrGpuDeviceSetupExtra x{};
    x.struct_size = sizeof(PrGpuDeviceSetupExtra);
    x.device = &device;
    const CallResult s = m.invoke(p->manifest.id, e->main, PR_CMD_GPU_DEVICE_SETUP, &d, &out, nullptr, nullptr, &x);
    const std::scoped_lock lock(m.gpuMutex);
    if (!s.ok || x.gpu_data == 0) {
      m.gpuFailed[key] = "GPU_DEVICE_SETUP: " + (s.ok ? std::string("no gpu_data") : s.message);
      if (s.fault) m.on_fault(*p, e, nullptr, s);
      r.skipped = true;
      r.message = m.gpuFailed[key];
      return r;
    }
    m.gpuData[key] = x.gpu_data;
    gpuData = x.gpu_data;
  }
  const InstanceLease lease = m.instance_for(in, *e, *p, r);
  if (!lease) {
    if (r.fault) m.on_fault(*p, e, &in, r);
    return r;
  }
  const RenderLock lock(*p, *e);
  std::vector<CheckoutRequest> reqs;
  PrHost pre;
  pre.host = this;
  pre.checkouts = &reqs;
  PrPreRenderExtra px{};
  px.struct_size = sizeof(PrPreRenderExtra);
  px.request_rect = {0, 0, in.worldW, in.worldH};
  px.result_rect = px.request_rect;
  if (e->has(PR_OUT_FLAG_SMART_RENDER)) {
    r = m.call_render(*p, *e, in, pre, PR_CMD_SMART_PRE_RENDER, nullptr, &px, lease.sequence());
    if (!r.ok) return r;
  }
  PrHost ctx;
  ctx.host = this;
  ctx.source = &io;
  PrSmartRenderGpuExtra x{};
  x.struct_size = sizeof(PrSmartRenderGpuExtra);
  x.device = &device;
  x.gpu_data = gpuData;
  x.wgpu_command_encoder = encoder;
  x.input = &input;
  x.output = &output;
  x.pre_render_data = px.pre_render_data;
  r = m.call_render(*p, *e, in, ctx, PR_CMD_SMART_RENDER_GPU, nullptr, &x, lease.sequence());
  if (px.pre_render_data != 0) m.handles.dispose(px.pre_render_data);
  return r;
}

namespace {

constexpr std::size_t kMaxSimStateBytes = std::size_t{64} << 20U;

std::uint64_t mix64(std::uint64_t h, std::uint64_t v) {
  h ^= v + 0x9e3779b97f4a7c15ULL + (h << 6U) + (h >> 2U);
  return h;
}
std::uint64_t mix_bytes(std::uint64_t h, const void* data, std::size_t n) {
  const auto* b = static_cast<const std::uint8_t*>(data);
  for (std::size_t i = 0; i < n; ++i) h = (h ^ b[i]) * 1099511628211ULL;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  return h;
}
std::uint64_t mix_str(std::uint64_t h, std::string_view s) { return mix_bytes(mix64(h, s.size()), s.data(), s.size()); }
template <class T>
std::uint64_t mix_vec(std::uint64_t h, const std::vector<T>& v) {
  return mix_bytes(mix64(h, v.size()), v.data(), v.size() * sizeof(T));
}

/// What one frame's step reads: every param value and the instance's sequence data.
std::uint64_t inputs_hash(const RenderInputs& in) {
  std::uint64_t h = 14695981039346656037ULL;
  for (const ParamValue& v : in.values) {
    h = mix_bytes(h, v.v.data(), sizeof(double) * v.v.size());
    h = mix_str(h, v.layer);
    h = mix_vec(h, v.path);
    h = mix64(h, v.pathClosed ? 1 : 0);
    h = mix_vec(h, v.arb);
    h = mix_str(h, v.text);
    h = mix_vec(h, v.curve);
    h = mix_vec(h, v.gradient);
    h = mix_str(h, v.fileItem);
  }
  h = mix_vec(h, in.sequence);
  return mix64(h, static_cast<std::uint64_t>(in.layerW) << 32U | static_cast<std::uint32_t>(in.layerH));
}

}  // namespace

void PluginHost::Impl::sim_evict() {
  while (simBytes > simBudget && !simKept.empty()) {
    auto oldest = simKept.begin();
    for (auto it = simKept.begin(); it != simKept.end(); ++it) {
      if (it->second.lastUse < oldest->second.lastUse) oldest = it;
    }
    simBytes -= oldest->second.bytes.size();
    simKept.erase(oldest);
  }
}

std::optional<std::vector<std::uint8_t>> PluginHost::sim_state(const SimRequest& q, std::string& why) {
  Impl& m = *impl_;
  CallResult r;
  EffectSpec* e = nullptr;
  Plugin* p = nullptr;
  if (!resolve(*this, m, q.base, e, p, r)) {
    why = r.message;
    return std::nullopt;
  }
  if (!e->has(PR_OUT_FLAG_STATEFUL)) {
    why = "not a simulation (PR_OUT_FLAG_STATEFUL)";
    return std::nullopt;
  }
  if (!q.inputsAt || q.step <= 0) {
    why = "no frame step";
    return std::nullopt;
  }
  const std::string& instance = q.base.instance;
  const std::int64_t frame = std::max<std::int64_t>(0, q.frame);
  // One simulation steps at a time: a step reads the state the one before it made.
  const std::scoped_lock lock(m.simMutex);
  Impl::SimMemo& memo = m.simMemo[instance];
  if (q.inputsKey == 0 || memo.inputsKey != q.inputsKey || memo.step != q.step) {
    memo.chain.clear();
    memo.inputsKey = q.inputsKey;
    memo.step = q.step;
  }
  const auto seed = static_cast<std::uint32_t>(mix_str(14695981039346656037ULL, instance));
  while (static_cast<std::int64_t>(memo.chain.size()) <= frame) {
    const auto k = static_cast<std::int64_t>(memo.chain.size());
    const std::uint64_t prev = k == 0 ? mix64(seed, static_cast<std::uint64_t>(q.step)) : memo.chain.back();
    memo.chain.push_back(mix64(prev, inputs_hash(q.inputsAt(k))));
  }
  // The newest kept state whose inputs, and every earlier frame's, are still the same.
  std::int64_t from = frame;
  for (; from >= 0; --from) {
    const auto it = m.simKept.find({instance, from});
    if (it != m.simKept.end() && it->second.chain == memo.chain[static_cast<std::size_t>(from)]) break;
  }
  std::vector<std::uint8_t> state;
  if (from >= 0) {
    Impl::SimKept& kept = m.simKept.at({instance, from});
    kept.lastUse = ++m.simClock;
    state = kept.bytes;
    if (from == frame) {
      ++m.simStats.cacheHits;
      return state;
    }
  }
  for (std::int64_t k = from + 1; k <= frame; ++k) {
    RenderInputs in = q.inputsAt(k);
    in.layerTime = k * q.step;
    const InstanceLease lease = m.instance_for(in, *e, *p, r);
    if (!lease) {
      if (r.fault) m.on_fault(*p, e, &in, r);
      why = r.message;
      return std::nullopt;
    }
    PrSimStepExtra x{};
    x.struct_size = sizeof(PrSimStepExtra);
    x.state_in = k == 0 ? nullptr : state.data();
    x.state_in_size = k == 0 ? 0 : static_cast<std::uint32_t>(state.size());
    x.frame = k;
    x.dt = static_cast<double>(q.step) / static_cast<double>(PR_TIME_SCALE);
    x.seed = seed;
    PrHost ctx;
    ctx.host = this;
    {
      const RenderLock rl(*p, *e);
      r = m.call_render(*p, *e, in, ctx, PR_CMD_SIM_STEP, nullptr, &x, lease.sequence());
    }
    if (!r.ok) {
      if (x.state_out != 0) m.handles.dispose(x.state_out);
      why = r.message;
      return std::nullopt;
    }
    if (x.state_out != 0) {
      std::vector<std::uint8_t> out = m.handles.bytes(x.state_out);
      m.handles.dispose(x.state_out);
      if (out.size() > kMaxSimStateBytes) {
        why = "the simulation state is over 64 MB";
        return std::nullopt;
      }
      state = std::move(out);
    } else if (k == 0) {
      state.clear();
    }
    ++m.simStats.steps;
    Impl::SimKept& kept = m.simKept[{instance, k}];
    m.simBytes -= kept.bytes.size();
    kept.chain = memo.chain[static_cast<std::size_t>(k)];
    kept.bytes = state;
    kept.lastUse = ++m.simClock;
    m.simBytes += kept.bytes.size();
  }
  m.sim_evict();
  m.simStats.bytes = m.simBytes;
  return state;
}

SimStats PluginHost::sim_stats() const {
  const Impl& m = *impl_;
  const std::scoped_lock lock(m.simMutex);
  SimStats s = m.simStats;
  s.bytes = m.simBytes;
  return s;
}

void PluginHost::set_sim_budget(std::size_t bytes) {
  Impl& m = *impl_;
  const std::scoped_lock lock(m.simMutex);
  m.simBudget = bytes;
  m.sim_evict();
}

void PluginHost::gpu_device_gone(std::uint32_t deviceIndex) {
  Impl& m = *impl_;
  std::vector<std::pair<const EffectSpec*, PrHandle>> todo;
  {
    const std::scoped_lock lock(m.gpuMutex);
    for (auto it = m.gpuData.begin(); it != m.gpuData.end();) {
      if (it->first.second == deviceIndex) {
        todo.emplace_back(it->first.first, it->second);
        it = m.gpuData.erase(it);
      } else {
        ++it;
      }
    }
    std::erase_if(m.gpuFailed, [&](const auto& kv) { return kv.first.second == deviceIndex; });
  }
  for (const auto& [e, h] : todo) {
    Plugin* p = m.plugin_of(e);
    if (p == nullptr || p->status == PluginStatus::quarantined) continue;
    const std::scoped_lock serial(p->serial);
    PrHost ctx;
    ctx.host = this;
    ctx.cmd = PR_CMD_GPU_DEVICE_SETDOWN;
    PrInData d = m.base_in(ctx, *e);
    PrOutData out{};
    Impl::reset_out(out, e->globalData, 0);
    PrGpuDeviceInfo info{};
    info.struct_size = sizeof(PrGpuDeviceInfo);
    info.device_index = deviceIndex;
    PrGpuDeviceSetupExtra x{};
    x.struct_size = sizeof(PrGpuDeviceSetupExtra);
    x.device = &info;
    x.gpu_data = h;
    const CallResult r = m.invoke(p->manifest.id, e->main, PR_CMD_GPU_DEVICE_SETDOWN, &d, &out, nullptr, nullptr, &x);
    if (r.fault) m.on_fault(*p, e, nullptr, r);
    m.handles.dispose(h);
  }
}

// ── document-side selectors ──────────────────────────────────────────────

namespace {

/// The document's static params → the render inputs' values (USER_CHANGED_PARAM / UPDATE_PARAMS_UI).
std::vector<ParamValue> values_from_json(const EffectSpec& e, const js::Json& params) {
  std::vector<ParamValue> out(e.params.size());
  for (std::size_t i = 0; i < e.params.size(); ++i) {
    const ParamSpec& s = e.params[i];
    ParamValue& v = out[i];
    v.v = s.def;
    const auto num = [&](const std::string& k, double def) {
      const js::Json& j = params.at(k);
      return j.is_number() ? j.num() : j.is_bool() ? (j.b() ? 1.0 : 0.0) : def;
    };
    switch (s.type) {
      case PR_PARAM_POINT:
      case PR_PARAM_POINT_3D:
        v.v[0] = num(s.key + "X", s.def[0]);
        v.v[1] = num(s.key + "Y", s.def[1]);
        v.v[2] = num(s.key + "Z", s.def[2]);
        break;
      case PR_PARAM_COLOR: {
        const js::Json& c = params.at(s.key);
        if (c.is_string()) {
          const auto ch = doc::parse_color_channels(c.str());
          for (std::size_t k = 0; k < 4; ++k) v.v.at(k) = ch.at(k);
        }
        break;
      }
      case PR_PARAM_LAYER: v.layer = params.at(s.key).is_string() ? params.at(s.key).str() : ""; break;
      case PR_PARAM_STRING: v.text = params.at(s.key).is_string() ? params.at(s.key).str() : s.text; break;
      case PR_PARAM_CURVE: v.curve = params.at(s.key).is_array() ? doc::native_curve(params.at(s.key)) : s.curve; break;
      case PR_PARAM_GRADIENT: v.gradient = params.at(s.key).is_array() ? doc::native_gradient(params.at(s.key)) : s.gradient; break;
      case PR_PARAM_FILE: break;  // the request's resolved files (instance_call)
      default: v.v[0] = num(s.key, s.def[0]); break;
    }
  }
  return out;
}

}  // namespace

std::variant<doc::NativeEdit, doc::NativeFailure> PluginHost::user_changed(const doc::NativeActionRequest& req) {
  Impl& m = *impl_;
  EffectSpec* e = nullptr;
  {
    const std::shared_lock lock(m.pluginsMutex);
    const auto it = m.effects.find(req.type);
    if (it != m.effects.end()) e = it->second;
  }
  Plugin* p = e != nullptr ? m.plugin_of(e) : nullptr;
  if (e == nullptr || p == nullptr || p->status != PluginStatus::loaded) {
    return doc::NativeFailure{"the plugin that provides '" + req.type + "' is not loaded"};
  }
  const std::string key = req.action.starts_with("changed:") ? req.action.substr(8) : req.action;
  std::uint32_t index = 0;
  for (std::size_t i = 0; i < e->params.size(); ++i) {
    const std::string& k = e->params[i].key;
    if (k == key || ((e->params[i].type == PR_PARAM_POINT || e->params[i].type == PR_PARAM_POINT_3D) && key.starts_with(k) &&
                     key.size() == k.size() + 1)) {
      index = static_cast<std::uint32_t>(i + 1);
    }
  }
  if (index == 0) return doc::NativeFailure{"no parameter '" + key + "'"};
  PrUserChangedParamExtra x{};
  x.struct_size = sizeof(PrUserChangedParamExtra);
  x.param_index = index;
  if (!req.payload.empty()) {  // SDK 1.1: a panel's data for the button
    x.payload = reinterpret_cast<const std::uint8_t*>(req.payload.data());  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): bytes of the string
    x.payload_size = static_cast<std::uint32_t>(req.payload.size());
  }
  return instance_call(req, PR_CMD_USER_CHANGED_PARAM, index, &x, nullptr);
}

/// SDK 1.3: the 1-based index of PR_PARAM_CUSTOM_UI param `key` of effect `type`, 0 when there is none.
std::uint32_t PluginHost::custom_ui_index(const std::string& type, const std::string& key) const {
  const Impl& m = *impl_;
  const std::shared_lock lock(m.pluginsMutex);
  const auto it = m.effects.find(type);
  if (it == m.effects.end()) return 0;
  const std::vector<ParamSpec>& params = it->second->params;
  for (std::size_t i = 0; i < params.size(); ++i) {
    if (params[i].key == key && params[i].type == PR_PARAM_CUSTOM_UI) return static_cast<std::uint32_t>(i + 1);
  }
  return 0;
}

std::variant<std::vector<doc::NativeOverlayItem>, doc::NativeFailure> PluginHost::draw_overlay(const doc::NativeActionRequest& req) {
  std::vector<doc::NativeOverlayItem> items;
  if (req.paramUi) {  // SDK 1.3: an Effect Controls box
    PrParamUiExtra u{};
    u.struct_size = sizeof(PrParamUiExtra);
    u.param_index = custom_ui_index(req.type, req.paramUi->key);
    if (u.param_index == 0) return doc::NativeFailure{"'" + req.type + "' has no custom UI '" + req.paramUi->key + "'"};
    u.width = req.paramUi->width;
    u.height = req.paramUi->height;
    auto r = instance_call(req, PR_CMD_DRAW_PARAM_UI, u.param_index, &u, &items);
    if (auto* f = std::get_if<doc::NativeFailure>(&r)) return std::move(*f);
    return items;
  }
  PrOverlayExtra x{};
  x.struct_size = sizeof(PrOverlayExtra);
  x.comp_width = req.scene ? req.scene->compW : 0;  // SDK 1.2: the space of comp-space items
  x.comp_height = req.scene ? req.scene->compH : 0;
  auto r = instance_call(req, PR_CMD_DRAW_OVERLAY, 0, &x, &items);
  if (auto* f = std::get_if<doc::NativeFailure>(&r)) return std::move(*f);
  return items;
}

std::variant<doc::NativeEdit, doc::NativeFailure> PluginHost::overlay_drag(const doc::NativeActionRequest& req,
                                                                           const doc::NativeOverlayDrag& d) {
  if (req.paramUi) {  // SDK 1.3: a handle in an Effect Controls box
    PrParamUiDragExtra u{};
    u.struct_size = sizeof(PrParamUiDragExtra);
    u.param_index = custom_ui_index(req.type, req.paramUi->key);
    if (u.param_index == 0) return doc::NativeFailure{"'" + req.type + "' has no custom UI '" + req.paramUi->key + "'"};
    u.handle_id = d.handle;
    u.phase = d.phase;
    u.x = d.x;
    u.y = d.y;
    u.start_x = d.startX;
    u.start_y = d.startY;
    u.width = req.paramUi->width;
    u.height = req.paramUi->height;
    return instance_call(req, PR_CMD_PARAM_UI_DRAG, u.param_index, &u, nullptr);
  }
  PrOverlayDragExtra x{};
  x.struct_size = sizeof(PrOverlayDragExtra);
  x.handle_id = d.handle;
  x.phase = d.phase;
  x.x = d.x;
  x.y = d.y;
  x.start_x = d.startX;
  x.start_y = d.startY;
  x.space = d.space == PR_OVERLAY_SPACE_COMP ? PR_OVERLAY_SPACE_COMP : PR_OVERLAY_SPACE_LAYER;  // SDK 1.2
  return instance_call(req, PR_CMD_OVERLAY_DRAG, 0, &x, nullptr);
}

std::variant<doc::NativeEdit, doc::NativeFailure> PluginHost::instance_call(const doc::NativeActionRequest& req, std::int32_t cmd,
                                                                            std::uint32_t /*paramIndex*/, void* extra,
                                                                            std::vector<doc::NativeOverlayItem>* draw) {
  Impl& m = *impl_;
  EffectSpec* e = nullptr;
  {
    const std::shared_lock lock(m.pluginsMutex);
    const auto it = m.effects.find(req.type);
    if (it != m.effects.end()) e = it->second;
  }
  Plugin* p = e != nullptr ? m.plugin_of(e) : nullptr;
  if (e == nullptr || p == nullptr || p->status != PluginStatus::loaded) {
    return doc::NativeFailure{"the plugin that provides '" + req.type + "' is not loaded"};
  }
  if ((cmd == PR_CMD_DRAW_OVERLAY || cmd == PR_CMD_OVERLAY_DRAG) && !e->has(PR_OUT_FLAG_CUSTOM_OVERLAY)) {
    return doc::NativeFailure{"'" + req.type + "' draws no overlay"};
  }

  RenderInputs in;
  in.matchName = e->matchName;
  in.instance = req.layer + "/" + req.effectId;
  in.layerId = req.layer;
  in.sequence = req.sequence;
  in.values = values_from_json(*e, req.params);
  for (auto& [k, bytes] : req.arb) {
    for (std::size_t i = 0; i < e->params.size(); ++i) {
      if (e->params[i].key == k) in.values[i].arb = bytes;
    }
  }
  for (const auto& f : req.files) {  // SDK 1.1 FILE params, resolved by the document
    for (std::size_t i = 0; i < e->params.size(); ++i) {
      if (e->params[i].key != f.key) continue;
      in.values[i].fileItem = f.item;
      in.values[i].filePath = f.path;
      in.values[i].fileName = f.name;
      in.values[i].fileMissing = f.missing;
    }
  }
  in.compTime = static_cast<std::int64_t>(std::llround(req.timeSeconds * PR_TIME_SCALE));
  // SDK 1.2: the layer's own time (start offset, stretch, remap), as the render gets it.
  in.layerTime = req.layerTimeSeconds ? static_cast<std::int64_t>(std::llround(*req.layerTimeSeconds * PR_TIME_SCALE)) : in.compTime;
  {
    const std::scoped_lock lock(m.instancesMutex);
    if (const auto it = m.instances.find(in.instance); it != m.instances.end()) {
      in.layerW = it->second->layerW.load(std::memory_order_relaxed);
      in.layerH = it->second->layerH.load(std::memory_order_relaxed);
    }
  }
  if (req.layerSize) {  // an overlay call: the layer as the document places it (rendered or not)
    in.layerW = static_cast<std::int32_t>(std::lround(req.layerSize->first));
    in.layerH = static_cast<std::int32_t>(std::lround(req.layerSize->second));
  }
  // SDK 1.2: an overlay call reads the comp camera / lights / LAYER matrices the request carries.
  const bool overlayScene = req.scene.has_value() && (cmd == PR_CMD_DRAW_OVERLAY || cmd == PR_CMD_OVERLAY_DRAG);
  if (overlayScene) decode_overlay_scene(*req.scene, *e, in);

  const std::scoped_lock serial(p->serial);
  // A private instance built from the document's flat data: the action's result
  // is what the document stores, never state only this process has.
  PrHost ctx;
  ctx.host = this;
  PrInData d = m.base_in(ctx, *e);
  m.fill_in_data(d, in);
  PrHandle live = 0;
  if (e->has(PR_OUT_FLAG_SEQUENCE_DATA)) {
    const PrCmd setupCmd = in.sequence.empty() ? PR_CMD_SEQUENCE_SETUP : PR_CMD_SEQUENCE_RESETUP;
    ctx.cmd = setupCmd;
    const PrHandle flat = in.sequence.empty() ? 0 : m.handles.from(in.sequence);
    d.sequence_data = flat;
    PrOutData out{};
    Impl::reset_out(out, e->globalData, flat);
    const CallResult r = m.invoke(p->manifest.id, e->main, setupCmd, &d, &out, nullptr, nullptr, nullptr);
    if (flat != 0 && out.sequence_data != flat) m.handles.dispose(flat);
    if (!r.ok) {
      if (r.fault) m.on_fault(*p, e, nullptr, r);
      return doc::NativeFailure{r.message};
    }
    live = out.sequence_data;
  }
  std::vector<std::pair<std::uint32_t, std::array<double, 4>>> writes;
  std::vector<std::pair<std::uint32_t, std::vector<std::uint8_t>>> arbWrites;
  std::vector<ParamUi> ui(e->params.size());
  for (std::size_t i = 0; i < e->params.size(); ++i) ui[i] = {e->params[i].key, e->params[i].name, true, (e->params[i].flags & PR_PARAM_FLAG_HIDDEN) != 0};
  ctx.cmd = cmd;
  ctx.writes = &writes;
  ctx.arbWrites = &arbWrites;
  ctx.ui = &ui;
  ctx.params = &e->params;
  ctx.numParams = d.num_params;
  ctx.overlay = draw;
  ctx.inputs = &in;  // SDK 1.1 asset callbacks; SDK 1.2: the scene callbacks in an overlay call (overlayScene)
  ctx.effect = e;
  ctx.outFlags = e->outFlags;
  ctx.overlayScene = overlayScene;
  std::vector<PrParamDef*> ptrs;
  ParamDefs defs = m.param_defs(*e, in, ptrs);
  d.sequence_data = live;
  PrOutData out{};
  Impl::reset_out(out, e->globalData, live);
  if (cmd == PR_CMD_DRAW_OVERLAY) {
    // The overlay is drawn in the layer's own px.
    auto* ox = static_cast<PrOverlayExtra*>(extra);
    ox->layer_width = in.layerW;
    ox->layer_height = in.layerH;
  }
  CallResult r = m.invoke(p->manifest.id, e->main, cmd, &d, &out, ptrs.data(), nullptr, extra);
  if (r.ok && out.sequence_data != 0) live = out.sequence_data;

  doc::NativeEdit edit;
  // DRAW_OVERLAY / DRAW_PARAM_UI read; only an edit flattens what the plugin changed.
  if (r.ok && cmd != PR_CMD_DRAW_OVERLAY && cmd != PR_CMD_DRAW_PARAM_UI && e->has(PR_OUT_FLAG_SEQUENCE_DATA)) {
    ctx.cmd = PR_CMD_SEQUENCE_FLATTEN;
    d.sequence_data = live;
    Impl::reset_out(out, e->globalData, live);
    const CallResult f = m.invoke(p->manifest.id, e->main, PR_CMD_SEQUENCE_FLATTEN, &d, &out, nullptr, nullptr, nullptr);
    if (f.ok) {
      std::vector<std::uint8_t> bytes = m.handles.bytes(out.sequence_data);
      if (out.sequence_data != live) m.handles.dispose(out.sequence_data);
      if (bytes != req.sequence) edit.sequence = std::move(bytes);
    } else {
      r = f;
    }
  }
  if (live != 0) {
    ctx.cmd = PR_CMD_SEQUENCE_SETDOWN;
    d.sequence_data = live;
    Impl::reset_out(out, e->globalData, live);
    (void)m.invoke(p->manifest.id, e->main, PR_CMD_SEQUENCE_SETDOWN, &d, &out, nullptr, nullptr, nullptr);
    m.handles.dispose(live);
  }
  if (!r.ok) {
    if (r.fault) m.on_fault(*p, e, nullptr, r);
    return doc::NativeFailure{r.message};
  }
  for (const auto& [i, v] : writes) {
    const ParamSpec& s = e->params.at(i - 1);
    switch (s.type) {
      case PR_PARAM_POINT:
      case PR_PARAM_POINT_3D:
        edit.params.emplace_back(s.key + "X", doc::v_scalar(v[0] - in.layerW / 2.0));
        edit.params.emplace_back(s.key + "Y", doc::v_scalar(v[1] - in.layerH / 2.0));
        if (s.type == PR_PARAM_POINT_3D) edit.params.emplace_back(s.key + "Z", doc::v_scalar(v[2]));
        break;
      case PR_PARAM_COLOR:  // the plugin writes linear light (what it reads); the document keeps sRGB-encoded 0..1
        edit.params.emplace_back(s.key, doc::v_color(linear_to_srgb(v[0]), linear_to_srgb(v[1]), linear_to_srgb(v[2]), v[3]));
        break;
      case PR_PARAM_CHECKBOX: edit.params.emplace_back(s.key, doc::v_bool(v[0] != 0)); break;
      case PR_PARAM_POPUP: {
        const auto c = static_cast<std::size_t>(std::clamp(std::round(v[0]), 1.0, static_cast<double>(s.choices.size())));
        edit.params.emplace_back(s.key, doc::v_choice(s.choices.at(c - 1)));
        break;
      }
      case PR_PARAM_SLIDER:
      case PR_PARAM_FLOAT_SLIDER:
      case PR_PARAM_ANGLE: edit.params.emplace_back(s.key, doc::v_scalar(v[0])); break;
      default: break;
    }
  }
  for (auto& [i, bytes] : arbWrites) edit.arb.emplace_back(e->params.at(i - 1).key, std::move(bytes));
  return edit;
}

namespace {
/// SDK 1.2: a loaded plugin's presets, their values checked against its effects' params.
std::vector<api::PluginPresetInfo> presets_of(const PluginHost::Impl& m, std::string_view pluginId) {
  std::vector<api::PluginPresetInfo> out;
  const std::shared_lock lock(m.pluginsMutex);
  for (const auto& p : m.plugins) {
    if (p->manifest.id != pluginId || p->status != PluginStatus::loaded) continue;
    for (const PresetSpec& ps : p->presets) {
      for (const auto& e : p->effects) {
        if (e->matchName != ps.effect) continue;
        api::PluginPresetInfo info;
        info.name = ps.name;
        info.effect = ps.effect;
        info.values = preset_values(ps, *e);
        info.category = ps.category;
        out.push_back(std::move(info));
      }
    }
  }
  return out;
}
}  // namespace

std::vector<api::PluginInfo> PluginHost::plugin_infos() const {
  std::vector<api::PluginInfo> out;
  for (PluginRecord& r : plugins()) {
    api::PluginInfo i;
    i.id = std::move(r.id);
    i.name = std::move(r.name);
    i.version = std::move(r.version);
    i.vendor = std::move(r.vendor);
    i.sdk = std::move(r.sdk);
    i.presets = presets_of(*impl_, i.id);  // SDK 1.2
    switch (r.status) {
      case PluginStatus::loaded: i.status = api::PluginStatus::loaded; break;
      case PluginStatus::disabled: i.status = api::PluginStatus::disabled; break;
      case PluginStatus::quarantined: i.status = api::PluginStatus::quarantined; break;
      case PluginStatus::revoked: i.status = api::PluginStatus::revoked; break;
      case PluginStatus::locked: i.status = api::PluginStatus::locked; break;
      default: i.status = api::PluginStatus::failed; break;
    }
    i.error = std::move(r.error);
    i.effects = std::move(r.effects);
    i.gpu = r.gpu;
    i.panel = r.panel;
    if (!r.icon.empty()) i.icon = std::move(r.icon);
    if (!r.panelTitle.empty()) i.panel_title = std::move(r.panelTitle);
    contrib_->fill(i);  // P7: commands, importers, output modules, panels
    if (i.status == api::PluginStatus::loaded) {  // SDK 1.4: layer types of a loaded plugin
      const std::shared_lock lock(impl_->pluginsMutex);
      for (const auto& p : impl_->plugins) {
        if (p->manifest.id != i.id) continue;
        for (const ManifestLayerType& lt : p->manifest.layerTypes) {
          i.layer_types.push_back(api::PluginLayerTypeInfo{p->manifest.id + ":" + lt.id, lt.name, lt.effect, lt.category});
        }
      }
    }
    out.push_back(std::move(i));
  }
  return out;
}

std::variant<std::vector<api::EffectParamUi>, doc::NativeFailure> PluginHost::params_ui_for(const doc::NativeActionRequest& req) {
  const EffectSpec* e = effect(req.type);
  if (e == nullptr) return doc::NativeFailure{"the plugin that provides '" + req.type + "' is not loaded"};
  RenderInputs in;
  in.matchName = e->matchName;
  in.instance = req.layer + "/" + req.effectId;
  in.layerId = req.layer;
  in.sequence = req.sequence;
  in.values = values_from_json(*e, req.params);
  for (const auto& [k, bytes] : req.arb) {
    for (std::size_t i = 0; i < e->params.size(); ++i) {
      if (e->params[i].key == k) in.values[i].arb = bytes;
    }
  }
  in.compTime = static_cast<std::int64_t>(std::llround(req.timeSeconds * PR_TIME_SCALE));
  // SDK 1.2: the layer's own time (start offset, stretch, remap), as the render gets it.
  in.layerTime = req.layerTimeSeconds ? static_cast<std::int64_t>(std::llround(*req.layerTimeSeconds * PR_TIME_SCALE)) : in.compTime;
  {
    Impl& m = *impl_;
    const std::scoped_lock lock(m.instancesMutex);
    if (const auto it = m.instances.find(in.instance); it != m.instances.end()) {
      in.layerW = it->second->layerW.load(std::memory_order_relaxed);
      in.layerH = it->second->layerH.load(std::memory_order_relaxed);
    }
  }
  auto r = params_ui(in);
  if (auto* why = std::get_if<std::string>(&r)) return doc::NativeFailure{std::move(*why)};
  std::vector<api::EffectParamUi> out;
  for (ParamUi& u : std::get<std::vector<ParamUi>>(r)) {
    const ParamSpec* s = nullptr;
    for (const ParamSpec& ps : e->params) {
      if (ps.key == u.key) s = &ps;
    }
    // Group delimiters and buttons are not properties: the Inspector asks about params it draws.
    if (s != nullptr && (s->type == PR_PARAM_GROUP_END)) continue;
    out.push_back(api::EffectParamUi{std::move(u.key), std::move(u.name), u.enabled, u.hidden});
  }
  return out;
}

namespace {

/// PrListAssetFilesExtra::add_file: one relative path, as get_asset_sibling_bytes takes it.
PrErr PR_CALL cb_add_asset_file(void* refcon, const char* relative) {
  if (refcon == nullptr || relative == nullptr) return PR_ERR_INVALID_PARAM;
  auto& out = *static_cast<std::vector<std::string>*>(refcon);
  std::string rel(relative);
  std::ranges::replace(rel, '\\', '/');
  const bool bad = rel.empty() || rel.size() > 1024 || rel.front() == '/' || rel.find(':') != std::string::npos ||
                   rel == ".." || rel.starts_with("../") || rel.ends_with("/..") || rel.find("/../") != std::string::npos;
  if (bad) return PR_ERR_INVALID_PARAM;
  if (out.size() >= 4096) return PR_ERR_OUT_OF_MEMORY;
  if (std::ranges::find(out, rel) == out.end()) out.push_back(std::move(rel));
  return PR_ERR_NONE;
}

}  // namespace

std::variant<std::vector<std::string>, doc::NativeFailure> PluginHost::asset_files_for(const doc::NativeActionRequest& req,
                                                                                         std::string_view key) {
  Impl& m = *impl_;
  const EffectSpec* e = effect(req.type);
  Plugin* p = e != nullptr ? m.plugin_of(e) : nullptr;
  if (e == nullptr || p == nullptr || p->status != PluginStatus::loaded) return std::vector<std::string>{};
  if (p->manifest.sdkMajor == 1 && p->manifest.sdkMinor < 2) return std::vector<std::string>{};  // the selector is SDK 1.2
  std::uint32_t index = 0;
  for (std::size_t i = 0; i < e->params.size(); ++i) {
    if (e->params[i].key == key && e->params[i].type == PR_PARAM_FILE) index = static_cast<std::uint32_t>(i + 1);
  }
  std::string assetPath;
  for (const auto& f : req.files) {
    if (f.key == key) assetPath = f.path;
  }
  if (index == 0 || assetPath.empty()) return std::vector<std::string>{};
  RenderInputs in;
  in.matchName = e->matchName;
  in.layerId = req.layer;
  in.values = values_from_json(*e, req.params);
  for (const auto& f : req.files) {
    for (std::size_t i = 0; i < e->params.size(); ++i) {
      if (e->params[i].key != f.key) continue;
      in.values[i].fileItem = f.item;
      in.values[i].filePath = f.path;
      in.values[i].fileName = f.name;
      in.values[i].fileMissing = f.missing;
    }
  }
  const std::scoped_lock serial(p->serial);
  PrHost ctx;
  ctx.host = this;
  ctx.cmd = PR_CMD_LIST_ASSET_FILES;
  ctx.params = &e->params;
  PrInData d = m.base_in(ctx, *e);
  m.fill_in_data(d, in);
  ctx.numParams = d.num_params;
  std::vector<PrParamDef*> ptrs;
  ParamDefs defs = m.param_defs(*e, in, ptrs);
  std::vector<std::string> files;
  PrListAssetFilesExtra x{};
  x.struct_size = sizeof(PrListAssetFilesExtra);
  x.param_index = index;
  x.asset_path = assetPath.c_str();
  x.refcon = &files;
  x.add_file = &cb_add_asset_file;
  PrOutData out{};
  Impl::reset_out(out, e->globalData, 0);
  const CallResult r = m.invoke(p->manifest.id, e->main, PR_CMD_LIST_ASSET_FILES, &d, &out, ptrs.data(), nullptr, &x);
  if (r.fault) m.on_fault(*p, e, nullptr, r);
  if (!r.ok) return doc::NativeFailure{r.message};
  return files;
}

std::variant<std::vector<ParamUi>, std::string> PluginHost::params_ui(const RenderInputs& in) {
  Impl& m = *impl_;
  const EffectSpec* e = effect(in.matchName);
  Plugin* p = e != nullptr ? m.plugin_of(e) : nullptr;
  if (e == nullptr || p == nullptr) return std::string("no loaded plugin provides '" + in.matchName + "'");
  std::vector<ParamUi> ui(e->params.size());
  for (std::size_t i = 0; i < e->params.size(); ++i) {
    const ParamSpec& s = e->params[i];
    ui[i] = {s.key, s.name, (s.flags & PR_PARAM_FLAG_DISABLED) == 0, (s.flags & PR_PARAM_FLAG_HIDDEN) != 0};
  }
  if (!e->has(PR_OUT_FLAG_SEND_UPDATE_PARAMS_UI) || p->status != PluginStatus::loaded) return ui;
  const std::scoped_lock serial(p->serial);
  PrHost ctx;
  ctx.host = this;
  ctx.cmd = PR_CMD_UPDATE_PARAMS_UI;
  ctx.ui = &ui;
  ctx.params = &e->params;
  PrInData d = m.base_in(ctx, *e);
  m.fill_in_data(d, in);
  ctx.numParams = d.num_params;
  std::vector<PrParamDef*> ptrs;
  ParamDefs defs = m.param_defs(*e, in, ptrs);
  PrOutData out{};
  Impl::reset_out(out, e->globalData, 0);
  const CallResult r = m.invoke(p->manifest.id, e->main, PR_CMD_UPDATE_PARAMS_UI, &d, &out, ptrs.data(), nullptr, nullptr);
  if (r.fault) m.on_fault(*p, e, nullptr, r);
  if (!r.ok) return r.message;
  return ui;
}

// ── P7: guarded calls for commands, importers and output modules (contrib.cpp) ──

CallResult PluginHost::call_guarded(std::string_view pluginId, std::int32_t journalCmd, GuardedFn fn, void* ctx) {
  Impl& m = *impl_;
  CallResult r;
  Plugin* p = nullptr;
  {
    const std::shared_lock lock(m.pluginsMutex);
    for (const auto& q : m.plugins) {
      if (q->manifest.id == pluginId) p = q.get();
    }
  }
  if (p == nullptr || p->status != PluginStatus::loaded) {
    r.skipped = true;
    r.message = "plugin '" + std::string(pluginId) + "' is " + (p == nullptr ? std::string("not installed") : std::string(to_string(p->status)));
    return r;
  }
  const std::scoped_lock serial(p->serial);
  PrHost host;
  host.host = this;
  host.cmd = journalCmd;
  struct Call {
    GuardedFn fn;
    void* ctx;
    PrHost* host;
    const PrHostSuite* suite;
    bool threw;
  } call{fn, ctx, &host, &m.suite, false};
  const int js = m.journal ? m.journal->enter(p->manifest.id, journalCmd) : -1;
  const int ws = m.watchdog ? m.watchdog->enter(p->manifest.id, journalCmd) : -1;
  host.progressSlot = ws;
  Fault fault = guarded_call(
      [](void* x) {
        auto* c = static_cast<Call*>(x);
        try {
          c->fn(c->ctx, c->host, c->suite);
        } catch (...) {  // a C++ exception must not cross the C ABI; it counts as a crash
          c->threw = true;
        }
      },
      &call);
  const bool hung = m.watchdog ? m.watchdog->leave(ws) : false;
  if (m.journal) m.journal->leave(js);
  if (!fault && call.threw) fault = {FaultKind::cpp_exception, 0};
  if (!fault && host.iterateFault) fault = host.iterateFault;
  if (!fault && hung) fault = {FaultKind::hang, 0};
  if (fault) {
    r.fault = fault;
    r.message = std::string(to_string(fault.kind)) + " in " + std::string(command_name(journalCmd));
    m.on_fault(*p, nullptr, nullptr, r);
    return r;
  }
  r.ok = true;
  return r;
}

}  // namespace premation::plugins
