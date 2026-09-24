#include "host.hpp"

#include <algorithm>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <thread>

#include "fxstate.hpp"
#include "journal.hpp"
#include "json.hpp"
#include "log.hpp"
#include "manifest.hpp"
#include "module.hpp"
#include "values.hpp"
#include "workers.hpp"

namespace fs = std::filesystem;
using premation::plugins::CheckoutRequest;
using premation::plugins::CheckoutSource;
using premation::plugins::ParamSpec;
using premation::plugins::ParamUi;
using premation::plugins::PluginHost;

// ── the per-call context the SDK hands back to every callback ─────────────
// (declared `typedef struct PrHost PrHost` in pr_types.h: global namespace)
struct PrHost {
  PluginHost* host = nullptr;
  PrCmd cmd = PR_CMD_ABOUT;
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
  /// iterate(): a job crashed on a worker (the instance is disabled like a crash on the caller).
  premation::plugins::Fault iterateFault;
  std::atomic<bool> iterateStop{false};
};

namespace premation::plugins {
namespace {

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
  PluginStatus status = PluginStatus::failed;
  std::string error;
  std::vector<std::unique_ptr<EffectSpec>> effects;
  /// Serialises every selector except the render ones of THREADED_RENDER effects.
  std::recursive_mutex serial;
  bool gpu = false;
  bool userDisabled = false;
};

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
  void load_bundle(const fs::path& dir);
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
  std::vector<PrParamDef> param_defs(const EffectSpec& e, const RenderInputs& in, std::vector<PrParamDef*>& ptrs) const;
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
  if (s.type < PR_PARAM_LAYER || s.type > PR_PARAM_BUTTON) return fail_with("param '" + s.name + "': unknown type");
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

PrErr PR_CALL cb_set_param_value(PrHost* h, std::uint32_t index, const double* value, std::uint32_t count) {
  if (h == nullptr || h->cmd != PR_CMD_USER_CHANGED_PARAM || h->writes == nullptr || h->params == nullptr) return PR_ERR_INVALID_CALLBACK;
  if (index == 0 || index > h->params->size() || value == nullptr || count == 0 || count > 4) return PR_ERR_INVALID_PARAM;
  std::array<double, 4> v{};
  for (std::uint32_t i = 0; i < count; ++i) v.at(i) = value[i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  h->writes->emplace_back(index, v);
  return PR_ERR_NONE;
}

PrErr PR_CALL cb_set_arb_data(PrHost* h, std::uint32_t index, const std::uint8_t* data, std::uint32_t size) {
  if (h == nullptr || h->cmd != PR_CMD_USER_CHANGED_PARAM || h->arbWrites == nullptr || h->params == nullptr) return PR_ERR_INVALID_CALLBACK;
  if (index == 0 || index > h->params->size() || h->params->at(index - 1).type != PR_PARAM_ARBITRARY_DATA) return PR_ERR_INVALID_PARAM;
  if (size > 256U * 1024U) return PR_ERR_OUT_OF_MEMORY;  // setPluginData's per-key limit
  std::vector<std::uint8_t> bytes;
  if (data != nullptr) bytes.assign(data, data + size);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  h->arbWrites->emplace_back(index, std::move(bytes));
  return PR_ERR_NONE;
}

std::int32_t PR_CALL cb_abort_requested(PrHost* /*h*/) { return 0; }
void PR_CALL cb_progress(PrHost* /*h*/, double /*fraction*/) {}
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
  }
}

PluginHost::~PluginHost() {
  Impl& m = *impl_;
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
    default: return "failed";
  }
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

void PluginHost::Impl::load_bundle(const fs::path& dir) {
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
  auto man = parse_manifest(text, platform_key(), err);
  if (!man) {
    p->manifest.id = dir.filename().string();
    p->manifest.name = p->manifest.id;
    p->status = PluginStatus::failed;
    p->error = "manifest: " + err;
  } else {
    p->manifest = std::move(*man);
  }
  {
    const std::shared_lock lock(pluginsMutex);
    for (const auto& q : plugins) {
      if (q->manifest.id == p->manifest.id) return;  // already known (rescans keep what is loaded)
    }
  }
  const std::string id = p->manifest.id;
  if (p->status == PluginStatus::failed && !p->error.empty()) {
    // stays failed (manifest)
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
    p->lib = DynamicLibrary::open(p->binary, err);
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
        } else if (info == nullptr || info->struct_size < sizeof(PrPluginInfo) || info->plugin_id == nullptr) {
          p->status = PluginStatus::failed;
          p->error = "PremationPluginInfo returned no valid info";
        } else if (std::string(info->plugin_id) != id) {
          p->status = PluginStatus::failed;
          p->error = "the binary says it is '" + std::string(info->plugin_id) + "', the manifest '" + id + "'";
        } else if (!sdk_compatible(PR_SDK_VERSION_MAJOR_OF(info->sdk_version), PR_SDK_VERSION_MINOR_OF(info->sdk_version), binaryWhy)) {
          p->status = PluginStatus::failed;
          p->error = "binary " + binaryWhy;
        } else {
          p->status = PluginStatus::loaded;
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
    plugins.push_back(std::move(p));
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

std::string hex_color(const std::array<double, 4>& c) {
  std::string s = "#" + hex2(c[0]) + hex2(c[1]) + hex2(c[2]);
  if (c[3] < 1) s += hex2(c[3]);
  return s;
}

}  // namespace

void PluginHost::Impl::register_document(const Plugin& p) {
  for (const auto& e : p.effects) {
    doc::NativeEffect ne;
    ne.def.type = e->matchName;
    ne.def.label = e->name;
    ne.provider = p.manifest.id;
    ne.category = e->category;
    ne.gpu = e->has(PR_OUT_FLAG_GPU_RENDER);
    ne.supportsFloat = e->has(PR_OUT_FLAG_FLOAT_COLOR_AWARE);
    ne.generator = e->has(PR_OUT_FLAG_GENERATOR);
    for (const ParamSpec& s : e->params) {
      doc::EffectParamDef d;
      d.key = s.key;
      d.label = s.name;
      if (!s.group.empty()) d.group = s.group;
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
        case PR_PARAM_BUTTON: ne.actions.emplace_back(s.key, s.name); break;
        default: break;  // group markers are carried by `group`
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
  if (!enabled) {
    p->userDisabled = true;
    if (p->status == PluginStatus::loaded) p->status = PluginStatus::disabled;
    doc::NativeEffects::set_available(pluginId, false);
    return true;
  }
  p->userDisabled = false;
  {
    const std::scoped_lock lock(m.failuresMutex);
    std::erase_if(m.failures, [&](const auto& kv) { return kv.second.pluginId == pluginId; });
  }
  if (p->status == PluginStatus::disabled) {
    p->status = PluginStatus::loaded;
    doc::NativeEffects::set_available(pluginId, true);
    return true;
  }
  if (p->status == PluginStatus::quarantined || p->status == PluginStatus::failed) {
    // The user asks to try again: forget the quarantine and reload the bundle.
    if (m.journal) m.journal->release(pluginId);
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
}

std::vector<PrParamDef> PluginHost::Impl::param_defs(const EffectSpec& e, const RenderInputs& in,
                                                     std::vector<PrParamDef*>& ptrs) const {
  std::vector<PrParamDef> defs(e.params.size() + 1);
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
    const ParamValue* v = i < in.values.size() ? &in.values[i] : nullptr;
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
  }
  ptrs.resize(defs.size());
  for (std::size_t i = 0; i < defs.size(); ++i) ptrs[i] = &defs[i];
  return defs;
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
  std::vector<PrParamDef> defs = param_defs(e, in, ptrs);
  PrInData d = base_in(ctx, e);
  fill_in_data(d, in);
  ctx.cmd = cmd;
  ctx.renderSelector = true;
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
  for (const PrHandle h : ctx.scoped) handles.dispose(h);
  ctx.scoped.clear();
  if (r.fault) on_fault(p, &e, &in, r);
  return r;
}

CallResult PluginHost::pre_render(const RenderInputs& in, std::vector<CheckoutRequest>& out) {
  Impl& m = *impl_;
  CallResult r;
  EffectSpec* e = nullptr;
  Plugin* p = nullptr;
  out.clear();
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
  PrPreRenderExtra x{};
  x.struct_size = sizeof(PrPreRenderExtra);
  x.request_rect = {0, 0, in.worldW, in.worldH};
  x.result_rect = x.request_rect;
  r = m.call_render(*p, *e, in, ctx, PR_CMD_SMART_PRE_RENDER, nullptr, &x, lease.sequence());
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
    std::vector<PrParamDef> defs = m.param_defs(*e, in, ptrs);
    defs[0].world = input;
    PrInData d = m.base_in(ctx, *e);
    m.fill_in_data(d, in);
    ctx.cmd = PR_CMD_RENDER;
    ctx.renderSelector = true;
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
  in.compTime = static_cast<std::int64_t>(std::llround(req.timeSeconds * PR_TIME_SCALE));
  in.layerTime = in.compTime;
  {
    const std::scoped_lock lock(m.instancesMutex);
    if (const auto it = m.instances.find(in.instance); it != m.instances.end()) {
      in.layerW = it->second->layerW.load(std::memory_order_relaxed);
      in.layerH = it->second->layerH.load(std::memory_order_relaxed);
    }
  }

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
  ctx.cmd = PR_CMD_USER_CHANGED_PARAM;
  ctx.writes = &writes;
  ctx.arbWrites = &arbWrites;
  ctx.ui = &ui;
  ctx.params = &e->params;
  ctx.numParams = d.num_params;
  std::vector<PrParamDef*> ptrs;
  std::vector<PrParamDef> defs = m.param_defs(*e, in, ptrs);
  d.sequence_data = live;
  PrOutData out{};
  Impl::reset_out(out, e->globalData, live);
  PrUserChangedParamExtra x{};
  x.struct_size = sizeof(PrUserChangedParamExtra);
  x.param_index = index;
  CallResult r = m.invoke(p->manifest.id, e->main, PR_CMD_USER_CHANGED_PARAM, &d, &out, ptrs.data(), nullptr, &x);
  if (r.ok && out.sequence_data != 0) live = out.sequence_data;

  doc::NativeEdit edit;
  if (r.ok && e->has(PR_OUT_FLAG_SEQUENCE_DATA)) {
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
      case PR_PARAM_COLOR: edit.params.emplace_back(s.key, doc::v_color(v[0], v[1], v[2], v[3])); break;
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
  std::vector<PrParamDef> defs = m.param_defs(*e, in, ptrs);
  PrOutData out{};
  Impl::reset_out(out, e->globalData, 0);
  const CallResult r = m.invoke(p->manifest.id, e->main, PR_CMD_UPDATE_PARAMS_UI, &d, &out, ptrs.data(), nullptr, nullptr);
  if (r.fault) m.on_fault(*p, e, nullptr, r);
  if (!r.ok) return r.message;
  return ui;
}

}  // namespace premation::plugins
