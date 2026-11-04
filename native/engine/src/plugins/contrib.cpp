#include "contrib.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <deque>
#include <exception>
#include <utility>

#include "api_json.hpp"
#include "audio/external_audio.hpp"  // P7b: plugin footage's sound reaches the audio decoders (header-only)
#include "fail.hpp"
#include "host.hpp"
#include "log.hpp"

namespace premation::plugins {

// ── entries ──────────────────────────────────────────────────────────────

struct Contrib::Entry {
  char kind = 'c';  ///< 'c' command, 'i' importer, 'o' output module
  std::string plugin;
  std::string id;
  std::string name;
  PrCommandMainFn command = nullptr;
  PrImporterMainFn importer = nullptr;
  PrOutputMainFn output = nullptr;
  std::vector<std::string> extensions;  ///< importers
  [[nodiscard]] std::string key() const { return plugin + "/" + kind + "/" + id; }
};

struct Contrib::OpenFile {
  const Entry* entry = nullptr;  ///< owned by entries_ (bind / reset close a plugin's files before replacing them)
  std::string path;
  PrHandle data = 0;
  PrImportInfo info{};
  std::uint64_t lastUse = 0;
};

namespace {

std::string ext_of(std::string_view path) {
  const std::size_t dot = path.find_last_of('.');
  const std::size_t sep = path.find_last_of("/\\");
  if (dot == std::string_view::npos || (sep != std::string_view::npos && dot < sep)) return {};
  std::string e(path.substr(dot + 1));
  for (char& c : e) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return e;
}

std::string message_of(const char* msg, std::size_t cap) {
  const std::size_t n = strnlen(msg, cap);
  return std::string(msg, n);
}

api::EngineError engine_error(api::ErrorCode code, std::string message) {
  api::EngineError e;
  e.code = code;
  e.message = std::move(message);
  return e;
}

// ── the command callbacks (PrCommandSuite) ──────────────────────────────────

/// The invocation in flight on this thread (commands run on the core thread, one at a time).
struct CommandCall {
  doc::PluginCommandBridge* bridge = nullptr;
  /// SDK 1.4 (U1): PR_COMMAND_TOOL_EVENT's overlay (null in RUN).
  std::vector<doc::PluginToolItem>* toolItems = nullptr;
  std::deque<std::string> replies;  ///< host-owned result JSON, alive until RUN returns

  PrErr reply(std::string json, const char** out, std::uint32_t* len, PrErr code) {
    replies.push_back(std::move(json));
    if (out != nullptr) *out = replies.back().c_str();
    if (len != nullptr) *len = static_cast<std::uint32_t>(replies.back().size());
    return code;
  }
  PrErr fail(const api::EngineError& e, const char** out, std::uint32_t* len) {
    return reply(to_json(e), out, len, e.code == api::ErrorCode::not_found ? PR_ERR_NOT_FOUND : PR_ERR_INVALID_PARAM);
  }
};

thread_local CommandCall* t_call = nullptr;  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables): the call in flight

template <class Request, class Parse, class Run>
PrErr engine_call(PrHost* host, const char* json, const char** out, std::uint32_t* len, Parse parse, Run run) {
  CommandCall* c = t_call;
  if (host == nullptr || c == nullptr || c->bridge == nullptr) return PR_ERR_INVALID_CALLBACK;
  if (json == nullptr) return c->fail(engine_error(api::ErrorCode::invalid_argument, "no request"), out, len);
  std::string why;
  std::optional<Request> req = parse(std::string_view(json), why);
  if (!req) return c->fail(engine_error(api::ErrorCode::invalid_argument, why), out, len);
  // EngineFail / std::exception are caught HERE: no C++ exception crosses back into the plugin.
  std::optional<api::EngineError> failed;
  try {
    return c->reply(run(*c->bridge, *req), out, len, PR_ERR_NONE);
  } catch (const doc::EngineFail& f) {
    failed = f.error;
  } catch (const std::exception& e) {
    failed = engine_error(api::ErrorCode::internal, e.what());
  } catch (...) {
    failed = engine_error(api::ErrorCode::internal, "unknown error");
  }
  return c->fail(*failed, out, len);
}

PrErr PR_CALL cb_engine_query(PrHost* host, const char* json, const char** out, std::uint32_t* len) {
  return engine_call<api::Query>(host, json, out, len, query_from_json,
                                 [](doc::PluginCommandBridge& b, const api::Query& q) { return to_json(b.query(q)); });
}

PrErr PR_CALL cb_engine_command(PrHost* host, const char* json, const char** out, std::uint32_t* len) {
  return engine_call<api::Command>(host, json, out, len, command_from_json,
                                   [](doc::PluginCommandBridge& b, const api::Command& c) { return to_json(b.command(c)); });
}

PrErr PR_CALL cb_tool_draw(PrHost* host, std::uint32_t kind, const double* xy, std::uint32_t count, const float* rgba, double width) {
  CommandCall* c = t_call;
  if (host == nullptr || c == nullptr || c->toolItems == nullptr) return PR_ERR_INVALID_CALLBACK;
  const std::uint32_t want = kind == PR_TOOL_DRAW_CIRCLE ? 3 : kind == PR_TOOL_DRAW_DOT ? 2 : 4;
  if (kind > PR_TOOL_DRAW_DOT || xy == nullptr || count < want || count > 4096 || c->toolItems->size() >= 512) return PR_ERR_INVALID_PARAM;
  doc::PluginToolItem it;
  it.kind = kind;
  it.xy.assign(xy, xy + count);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic): the SDK's array
  if (!std::ranges::all_of(it.xy, [](double v) { return std::isfinite(v); })) return PR_ERR_INVALID_PARAM;
  if (rgba != nullptr) std::copy_n(rgba, 4, it.rgba.begin());
  it.width = std::isfinite(width) && width > 0 ? std::min(width, 64.0) : 1.0;
  c->toolItems->push_back(std::move(it));
  return PR_ERR_NONE;
}

const PrCommandSuite kCommandSuite = {sizeof(PrCommandSuite), &cb_engine_query, &cb_engine_command, &cb_tool_draw};

// ── pixels ──────────────────────────────────────────────────────────────

/// A world's pixel (x, y) as straight float RGBA (8 / 16-bit normalised; 32-bit as stored).
void read_px(const PrWorld& w, std::int32_t x, std::int32_t y, float* o) {
  const auto* row = static_cast<const std::uint8_t*>(w.data) + static_cast<std::ptrdiff_t>(y) * w.row_bytes;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  switch (w.format) {
    case PR_PIXEL_FORMAT_RGBA32F: std::memcpy(o, row + static_cast<std::size_t>(x) * 16, 16); return;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    case PR_PIXEL_FORMAT_RGBA16: {
      std::uint16_t v[4];  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays)
      std::memcpy(v, row + static_cast<std::size_t>(x) * 8, 8);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      for (int i = 0; i < 4; ++i) o[i] = static_cast<float>(v[i]) / 65535.0F;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic, cppcoreguidelines-pro-bounds-constant-array-index)
      return;
    }
    default: {
      const std::uint8_t* p = row + static_cast<std::size_t>(x) * 4;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      for (int i = 0; i < 4; ++i) o[i] = static_cast<float>(p[i]) / 255.0F;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      return;
    }
  }
}

constexpr std::int32_t kMaxImportEdge = 16384;
constexpr std::size_t kMaxOpenFiles = 16;

}  // namespace

// ── Contrib ──────────────────────────────────────────────────────────────

Contrib::Contrib(PluginHost& host) : host_(host) {}

Contrib::~Contrib() { detach(); }

void Contrib::shutdown() {
  detach();
  const std::scoped_lock lock(mutex_);
  close_files({});
}

void Contrib::note_manifest(const std::string& pluginId, const std::filesystem::path& dir, const Manifest& m) {
  const std::scoped_lock lock(mutex_);
  manifests_[pluginId] = m;
  dirs_[pluginId] = dir;
  bool any = false;
  for (const auto& [id, man] : manifests_) any = any || !man.importers.empty();
  if (attached_) doc::NativeImporters::set_any(any);
}

std::string Contrib::bind(const std::string& pluginId, const PrPluginInfo& info) {
  const std::scoped_lock lock(mutex_);
  const auto mit = manifests_.find(pluginId);
  if (mit == manifests_.end()) return {};
  const Manifest& m = mit->second;
  // The SDK 1.2 fields exist only when the module's struct reaches them.
  const bool has12 = info.struct_size >= offsetof(PrPluginInfo, output_modules) + sizeof(info.output_modules);
  std::vector<std::unique_ptr<Entry>> bound;
  const auto need = [&](std::string_view what) {
    return "the manifest lists " + std::string(what) + " but the binary has no SDK 1.2 entries (PrPluginInfo.struct_size)";
  };
  if (!has12 && (!m.commands.empty() || !m.importers.empty() || !m.outputModules.empty())) {
    return need(!m.commands.empty() ? "commands" : !m.importers.empty() ? "importers" : "output modules");
  }
  for (const ManifestCommand& c : m.commands) {
    PrCommandMainFn fn = nullptr;
    for (std::uint32_t i = 0; has12 && i < info.command_count && info.commands != nullptr; ++i) {
      const PrCommandEntry& en = info.commands[i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      if (en.id != nullptr && c.id == en.id) fn = en.main;
    }
    if (fn == nullptr) return "the binary has no entry point for command '" + c.id + "'";
    auto e = std::make_unique<Entry>();
    e->kind = 'c';
    e->plugin = pluginId;
    e->id = c.id;
    e->name = c.name;
    e->command = fn;
    bound.push_back(std::move(e));
  }
  for (const ManifestImporter& c : m.importers) {
    PrImporterMainFn fn = nullptr;
    for (std::uint32_t i = 0; has12 && i < info.importer_count && info.importers != nullptr; ++i) {
      const PrImporterEntry& en = info.importers[i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      if (en.id != nullptr && c.id == en.id) fn = en.main;
    }
    if (fn == nullptr) return "the binary has no entry point for importer '" + c.id + "'";
    auto e = std::make_unique<Entry>();
    e->kind = 'i';
    e->plugin = pluginId;
    e->id = c.id;
    e->name = c.name;
    e->importer = fn;
    e->extensions = c.extensions;
    bound.push_back(std::move(e));
  }
  for (const ManifestOutputModule& c : m.outputModules) {
    PrOutputMainFn fn = nullptr;
    for (std::uint32_t i = 0; has12 && i < info.output_module_count && info.output_modules != nullptr; ++i) {
      const PrOutputModuleEntry& en = info.output_modules[i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      if (en.id != nullptr && c.id == en.id) fn = en.main;
    }
    if (fn == nullptr) return "the binary has no entry point for output module '" + c.id + "'";
    auto e = std::make_unique<Entry>();
    e->kind = 'o';
    e->plugin = pluginId;
    e->id = c.id;
    e->name = c.name;
    e->output = fn;
    bound.push_back(std::move(e));
  }
  // A reload replaces the plugin's entries (open files of the old module are closed first).
  close_files(pluginId);
  std::erase_if(entries_, [&](const auto& kv) { return kv.second->plugin == pluginId; });
  for (auto& e : bound) {
    const std::string k = e->key();
    entries_[k] = std::move(e);
  }
  return {};
}

void Contrib::reset(const std::string& pluginId) {
  const std::scoped_lock lock(mutex_);
  close_files(pluginId);
  const std::string prefix = pluginId + "/";
  std::erase_if(crashed_, [&](const std::string& k) { return k.starts_with(prefix); });
  std::erase_if(crashWhy_, [&](const auto& kv) { return kv.first.starts_with(prefix); });
}

void Contrib::attach() {
  {
    const std::scoped_lock lock(mutex_);
    attached_ = true;
  }
  doc::NativeCommands::set_tool_event_handler([this](const doc::PluginCommandRequest& r) { return tool_event(r); });  // SDK 1.4 (U1)
  doc::NativeCommands::set_handlers([this] { return commands(); },
                                    [this](const doc::PluginCommandRequest& r, doc::PluginCommandBridge& b) { return run(r, b); });
  doc::NativeImporters::set_handlers([this](std::string_view path) { return claims(path); },
                                     [this](const std::string& path, js::Json& facts, std::string& error) { return probe(path, facts, error); },
                                     [this](const std::string& path, double seconds, doc::NativeImage& out, std::string& error) {
                                       return read_frame(path, seconds, out, error);
                                     },
                                     [this](std::string_view path) { return refusal(path); });
  // The sound of plugin footage: the playback mixer, the export mix and the audio jobs
  // read it through the audio decoders (audio_decode_ffi.cpp), which ask these first.
  audio::ExternalAudio::set_handlers(
      [this](std::string_view path) { return claims(path); },
      [this](const std::string& path, audio::ExternalAudioFormat& out, std::string& error) {
        std::uint32_t rate = 0;
        std::uint32_t channels = 0;
        std::int64_t frames = 0;
        if (!audio_format(path, rate, channels, frames, out.codec, error)) return false;
        out.sampleRate = static_cast<int>(rate);
        out.channels = static_cast<int>(channels);
        out.frames = frames;
        return true;
      },
      [this](const std::string& path, std::int64_t start, std::uint32_t frames, std::vector<float>& interleaved, std::string& error) {
        std::uint32_t channels = 0;
        return read_audio(path, start, frames, interleaved, channels, error);
      });
  const std::scoped_lock lock(mutex_);
  bool any = false;
  for (const auto& [id, man] : manifests_) any = any || !man.importers.empty();
  doc::NativeImporters::set_any(any);
}

void Contrib::detach() {
  bool was = false;
  {
    const std::scoped_lock lock(mutex_);
    was = attached_;
    attached_ = false;
  }
  if (!was) return;
  doc::NativeCommands::clear_handlers();
  doc::NativeImporters::clear_handlers();
  audio::ExternalAudio::clear_handlers();  // waits for reads in flight
}

bool Contrib::loaded(const std::string& pluginId) const {
  for (const PluginRecord& r : host_.plugins()) {
    if (r.id == pluginId) return r.status == PluginStatus::loaded;
  }
  return false;
}

std::vector<api::PluginCommandInfo> Contrib::commands() const {
  std::vector<PluginRecord> records = host_.plugins();
  const std::scoped_lock lock(mutex_);
  std::vector<api::PluginCommandInfo> out;
  for (const PluginRecord& r : records) {  // load order
    const auto mit = manifests_.find(r.id);
    if (mit == manifests_.end()) continue;
    for (const ManifestCommand& c : mit->second.commands) {
      api::PluginCommandInfo i;
      i.plugin = r.id;
      i.id = c.id;
      i.name = c.name;
      i.menu = c.menu;
      const std::string key = r.id + "/c/" + c.id;
      const bool bound = entries_.contains(key);
      if (r.status != PluginStatus::loaded) {
        i.error = "plugin '" + r.id + "' is " + std::string(to_string(r.status));
      } else if (crashed_.contains(key)) {
        const auto w = crashWhy_.find(key);
        i.error = w != crashWhy_.end() ? w->second : "it crashed";
      } else if (!bound) {
        i.error = "not loaded";
      }
      i.enabled = i.error.empty();
      out.push_back(std::move(i));
    }
  }
  return out;
}

void Contrib::fill(api::PluginInfo& info) const {
  const std::vector<api::PluginCommandInfo> all = commands();
  const std::scoped_lock lock(mutex_);
  const auto mit = manifests_.find(info.id);
  if (mit == manifests_.end()) return;
  const Manifest& m = mit->second;
  for (const api::PluginCommandInfo& c : all) {
    if (c.plugin == info.id) info.commands.push_back(c);
  }
  for (const ManifestImporter& c : m.importers) info.importers.push_back(api::PluginImporterInfo{c.id, c.name, c.extensions});
  for (const ManifestOutputModule& c : m.outputModules) {
    api::PluginOutputModuleInfo o;
    o.id = c.id;
    o.name = c.name;
    o.extension = c.extension;
    for (const ManifestOutputOption& op : c.options) {
      api::PluginOutputOption x;
      x.id = op.id;
      x.name = op.name;
      x.type = op.type;
      x.choices = op.choices;
      x.default_value = op.def;
      x.min_ = op.min;
      x.max_ = op.max;
      o.options.push_back(std::move(x));
    }
    info.output_modules.push_back(std::move(o));
  }
  for (const ManifestPanel& p : m.panels) info.panels.push_back(api::PluginPanelInfo{p.id, p.name, p.page});
}

// ── commands ─────────────────────────────────────────────────────────────

std::variant<doc::PluginCommandOutcome, api::EngineError> Contrib::run(const doc::PluginCommandRequest& r,
                                                                        doc::PluginCommandBridge& bridge) {
  const std::string key = r.plugin + "/c/" + r.command;
  PrCommandMainFn fn = nullptr;
  std::string name;
  {
    const std::scoped_lock lock(mutex_);
    const auto it = entries_.find(key);
    if (it == entries_.end()) {
      const auto mit = manifests_.find(r.plugin);
      const bool listed = mit != manifests_.end() && std::ranges::any_of(mit->second.commands, [&](const ManifestCommand& c) { return c.id == r.command; });
      return engine_error(api::ErrorCode::not_found, listed ? "plugin '" + r.plugin + "' is not loaded" : "no plugin command '" + r.plugin + "/" + r.command + "'");
    }
    if (crashed_.contains(key)) {
      const auto w = crashWhy_.find(key);
      return engine_error(api::ErrorCode::not_found, w != crashWhy_.end() ? w->second : "the command crashed this session");
    }
    fn = it->second->command;
    name = it->second->name;
  }
  if (!loaded(r.plugin)) return engine_error(api::ErrorCode::not_found, "plugin '" + r.plugin + "' is not loaded");

  std::vector<const char*> layers;
  layers.reserve(r.layers.size());
  for (const std::string& l : r.layers) layers.push_back(l.c_str());
  struct Call {
    PrCommandMainFn fn;
    PrCommandContext ctx;
    PrCommandOut out;
    PrErr result;
  } call{};
  call.fn = fn;
  call.ctx.struct_size = sizeof(PrCommandContext);
  call.ctx.host_sdk_version = PR_SDK_VERSION;
  call.ctx.engine = &kCommandSuite;
  call.ctx.command_id = r.command.c_str();
  call.ctx.comp_id = r.comp.c_str();
  call.ctx.selected_layers = layers.empty() ? nullptr : layers.data();
  call.ctx.selected_layer_count = static_cast<std::uint32_t>(layers.size());
  call.ctx.time = r.time;
  call.ctx.frame_rate = r.fps;
  call.ctx.args_json = r.args.c_str();
  call.out.struct_size = sizeof(PrCommandOut);

  CommandCall state;
  state.bridge = &bridge;
  CommandCall* const outer = t_call;
  t_call = &state;
  const CallResult res = host_.call_guarded(
      r.plugin, kJournalCommandRun,
      [](void* p, PrHost* h, const PrHostSuite* s) {
        auto* c = static_cast<Call*>(p);
        c->ctx.host = s;
        c->ctx.host_ref = h;
        c->result = c->fn(PR_COMMAND_RUN, &c->ctx, &c->out);
      },
      &call);
  t_call = outer;

  if (res.fault) {
    const std::string why = "plugin '" + r.plugin + "' crashed in '" + name + "' (" + res.message +
                            "); nothing was changed, and the command is off until the plugin is enabled again";
    {
      const std::scoped_lock lock(mutex_);
      crashed_.insert(key);
      crashWhy_[key] = why;
    }
    return engine_error(api::ErrorCode::internal, why);
  }
  if (res.skipped) return engine_error(api::ErrorCode::not_found, res.message);
  if (call.result != PR_ERR_NONE) {
    std::string msg = message_of(call.out.return_msg, sizeof(call.out.return_msg));
    if (msg.empty()) msg = "returned error " + std::to_string(call.result);
    return engine_error(api::ErrorCode::internal, "'" + name + "': " + msg);
  }
  return doc::PluginCommandOutcome{name, message_of(call.out.return_msg, sizeof(call.out.return_msg))};
}

std::variant<doc::PluginToolFeedback, api::EngineError> Contrib::tool_event(const doc::PluginCommandRequest& r) {
  const std::string key = r.plugin + "/c/" + r.command;
  PrCommandMainFn fn = nullptr;
  {
    const std::scoped_lock lock(mutex_);
    const auto it = entries_.find(key);
    if (it == entries_.end() || crashed_.contains(key)) return engine_error(api::ErrorCode::not_found, "no plugin command '" + r.plugin + "/" + r.command + "'");
    fn = it->second->command;
  }
  if (!loaded(r.plugin)) return engine_error(api::ErrorCode::not_found, "plugin '" + r.plugin + "' is not loaded");
  struct Call {
    PrCommandMainFn fn;
    PrCommandContext ctx;
    PrCommandOut out;
    PrErr result;
  } call{};
  call.fn = fn;
  call.ctx.struct_size = sizeof(PrCommandContext);
  call.ctx.host_sdk_version = PR_SDK_VERSION;
  call.ctx.engine = &kCommandSuite;
  call.ctx.command_id = r.command.c_str();
  call.ctx.comp_id = r.comp.c_str();
  call.ctx.time = r.time;
  call.ctx.frame_rate = r.fps;
  call.ctx.args_json = r.args.c_str();
  call.out.struct_size = sizeof(PrCommandOut);
  std::vector<doc::PluginToolItem> items;
  CommandCall state;  // no bridge: engine_query / engine_command refuse (an event never edits)
  state.toolItems = &items;
  CommandCall* const outer = t_call;
  t_call = &state;
  const CallResult res = host_.call_guarded(
      r.plugin, kJournalCommandRun,
      [](void* p, PrHost* h, const PrHostSuite* s) {
        auto* c = static_cast<Call*>(p);
        c->ctx.host = s;
        c->ctx.host_ref = h;
        c->result = c->fn(PR_COMMAND_TOOL_EVENT, &c->ctx, &c->out);
      },
      &call);
  t_call = outer;
  if (res.fault) {
    const std::scoped_lock lock(mutex_);
    crashed_.insert(key);
    crashWhy_[key] = "plugin '" + r.plugin + "' crashed in a tool event (" + res.message + ")";
    return engine_error(api::ErrorCode::internal, crashWhy_[key]);
  }
  if (res.skipped) return engine_error(api::ErrorCode::not_found, res.message);
  doc::PluginToolFeedback fb;
  // A tool built before SDK 1.4 answers the unknown selector with an error: it draws nothing.
  if (call.result == PR_ERR_NONE) {
    fb.items = std::move(items);
    fb.message = message_of(call.out.return_msg, sizeof(call.out.return_msg));
  }
  return fb;
}

// ── importers ────────────────────────────────────────────────────────────

const Contrib::Entry* Contrib::importer_for(std::string_view path, std::string& why) const {
  const std::string ext = ext_of(path);
  if (ext.empty()) return nullptr;
  for (const auto& [k, e] : entries_) {
    if (e->kind != 'i' || std::ranges::find(e->extensions, ext) == e->extensions.end()) continue;
    if (crashed_.contains(k)) {
      const auto w = crashWhy_.find(k);
      why = w != crashWhy_.end() ? w->second : "the importer crashed";
      return e.get();
    }
    return e.get();
  }
  return nullptr;
}

bool Contrib::claims(std::string_view path) const {
  const std::string ext = ext_of(path);
  if (ext.empty()) return false;
  std::string plugin;
  {
    const std::scoped_lock lock(mutex_);
    std::string why;
    const Entry* e = importer_for(path, why);
    if (e == nullptr) return false;
    plugin = e->plugin;
  }
  return loaded(plugin);
}

std::string Contrib::refusal(std::string_view path) const {
  const std::string ext = ext_of(path);
  if (ext.empty()) return {};
  const std::vector<PluginRecord> records = host_.plugins();
  const std::scoped_lock lock(mutex_);
  std::string why;
  for (const PluginRecord& r : records) {  // load order
    const auto mit = manifests_.find(r.id);
    if (mit == manifests_.end()) continue;
    for (const ManifestImporter& c : mit->second.importers) {
      if (std::ranges::find(c.extensions, ext) == c.extensions.end()) continue;
      if (r.status == PluginStatus::loaded) return {};  // it reads the file (or says why not itself)
      if (why.empty()) why = "plugin '" + r.id + "' is " + std::string(to_string(r.status)) + (r.error.empty() ? "" : " (" + r.error + ")");
    }
  }
  return why;
}

std::set<std::string, std::less<>> Contrib::importers_off() const {
  const std::scoped_lock lock(mutex_);
  std::set<std::string, std::less<>> out;
  for (const std::string& k : crashed_) {
    const auto e = entries_.find(k);
    if (e != entries_.end() && e->second->kind == 'i') out.insert(e->second->plugin);
  }
  return out;
}

bool Contrib::call_import(const Entry& e, PrIoCmd cmd, PrImportCall& c, std::string& error) {
  struct Call {
    PrImporterMainFn fn;
    PrIoCmd cmd;
    PrImportCall* c;
    PrErr result;
  } call{e.importer, cmd, &c, PR_ERR_NONE};
  c.struct_size = sizeof(PrImportCall);
  c.host_sdk_version = PR_SDK_VERSION;
  c.importer_id = e.id.c_str();
  const CallResult res = host_.call_guarded(
      e.plugin, kJournalImportBase + cmd,
      [](void* p, PrHost* h, const PrHostSuite* s) {
        auto* x = static_cast<Call*>(p);
        x->c->host = s;
        x->c->host_ref = h;
        x->result = x->fn(x->cmd, x->c);
      },
      &call);
  if (res.fault) {
    const std::string why = "plugin '" + e.plugin + "' crashed (" + res.message + "); its importer is off until the plugin is enabled again";
    crashed_.insert(e.key());
    crashWhy_[e.key()] = why;
    // Its open files hold state of a module that faulted: drop them without calling it again.
    std::erase_if(files_, [&](const auto& kv) { return kv.second->entry->plugin == e.plugin; });
    error = why;
    return false;
  }
  if (res.skipped) {
    error = res.message;
    return false;
  }
  if (call.result != PR_ERR_NONE) {
    error = message_of(c.return_msg, sizeof(c.return_msg));
    if (error.empty()) error = "error " + std::to_string(call.result);
    return false;
  }
  return true;
}

bool Contrib::probe(const std::string& path, js::Json& facts, std::string& error) {
  const std::scoped_lock lock(mutex_);
  std::string why;
  const Entry* e = importer_for(path, why);
  if (e == nullptr || !why.empty()) {
    error = why.empty() ? "no plugin imports '" + ext_of(path) + "' files" : why;
    return false;
  }
  if (!loaded(e->plugin)) {
    error = "plugin '" + e->plugin + "' is not loaded";
    return false;
  }
  PrImportInfo info{};
  info.struct_size = sizeof(PrImportInfo);
  PrImportCall c{};
  c.path = path.c_str();
  c.info = &info;
  std::string err;
  if (!call_import(*e, PR_IMPORT_PROBE, c, err)) {
    error = "plugin failed to read '" + path + "': " + err;
    return false;
  }
  if (info.width < 0 || info.height < 0 || info.width > kMaxImportEdge || info.height > kMaxImportEdge ||
      (info.width == 0) != (info.height == 0) || (info.width == 0 && info.has_audio == 0)) {
    error = "plugin failed to read '" + path + "': it reported no picture and no sound";
    return false;
  }
  const bool moving = info.frame_rate > 0 && info.duration > 0;
  const double seconds = static_cast<double>(info.duration) / PR_TIME_SCALE;
  js::Json md = js::Json::object();
  md.set("width", js::Json::number(info.width));
  md.set("height", js::Json::number(info.height));
  md.set("duration", js::Json::number(moving || info.width == 0 ? seconds : 0));
  if (moving) md.set("fps", js::Json::number(info.frame_rate));
  md.set("hasAudioTrack", js::Json::boolean(info.has_audio != 0));
  md.set("hasAlpha", js::Json::boolean(info.has_alpha != 0));
  const std::string codec = message_of(info.codec, sizeof(info.codec));
  md.set("codec", js::Json::string(codec.empty() ? e->name : codec));
  md.set("importer", js::Json::string(e->plugin + "/" + e->id));
  facts = js::Json::object();
  facts.set("type", js::Json::string(info.width == 0 ? "audio" : moving ? "video" : "image"));
  facts.set("metadata", std::move(md));
  return true;
}

Contrib::OpenFile* Contrib::open_file(const Entry& e, const std::string& path, std::string& error) {
  std::error_code ec;
  const auto stamp = std::filesystem::last_write_time(std::filesystem::path(std::u8string(path.begin(), path.end())), ec);
  // libc++ (macOS) counts file_time_type in __int128, which no std::to_string
  // overload takes (v1.0.0's macOS build failed on it). A cache key only needs
  // "changed or not", so 64 bits of ticks is plenty.
  const long long ticks = ec ? 0LL : static_cast<long long>(stamp.time_since_epoch().count());
  const std::string key = path + "|" + std::to_string(ticks);
  if (const auto it = files_.find(key); it != files_.end()) {
    it->second->lastUse = ++fileTick_;
    return it->second.get();
  }
  if (files_.size() >= kMaxOpenFiles) {  // close the least recently used
    auto oldest = files_.begin();
    for (auto it = files_.begin(); it != files_.end(); ++it) {
      if (it->second->lastUse < oldest->second->lastUse) oldest = it;
    }
    const std::string old = oldest->first;
    close_files(old);
  }
  auto f = std::make_unique<OpenFile>();
  f->entry = &e;
  f->path = path;
  f->info.struct_size = sizeof(PrImportInfo);
  PrImportCall c{};
  c.path = path.c_str();
  c.info = &f->info;
  if (!call_import(e, PR_IMPORT_PROBE, c, error)) return nullptr;
  // A picture within the size limit, or (0 × 0) sound only.
  const bool soundOnly = f->info.width == 0 && f->info.height == 0 && f->info.has_audio != 0;
  if (!soundOnly && (f->info.width <= 0 || f->info.height <= 0 || f->info.width > kMaxImportEdge || f->info.height > kMaxImportEdge)) {
    error = "it reported no picture";
    return nullptr;
  }
  PrImportCall o{};
  o.path = path.c_str();
  o.info = &f->info;
  if (!call_import(e, PR_IMPORT_OPEN, o, error)) return nullptr;
  f->data = o.file_data;
  f->lastUse = ++fileTick_;
  OpenFile* raw = f.get();
  files_[key] = std::move(f);
  return raw;
}

void Contrib::close_files(std::string_view selector) {
  // `selector`: "" = all, a plugin id = that plugin's, a files_ key = that one. Taken out of
  // files_ first: a CLOSE that crashes erases the plugin's other files (call_import).
  std::vector<std::unique_ptr<OpenFile>> closing;
  for (auto it = files_.begin(); it != files_.end();) {
    const bool match = selector.empty() || it->first == selector || (it->second->entry != nullptr && it->second->entry->plugin == selector);
    if (match) {
      closing.push_back(std::move(it->second));
      it = files_.erase(it);
    } else {
      ++it;
    }
  }
  for (const auto& f : closing) {
    if (f->entry == nullptr || crashed_.contains(f->entry->key()) || !loaded(f->entry->plugin)) continue;
    PrImportCall c{};
    c.path = f->path.c_str();
    c.info = &f->info;
    c.file_data = f->data;
    std::string ignored;
    (void)call_import(*f->entry, PR_IMPORT_CLOSE, c, ignored);
  }
}

bool Contrib::read_frame(const std::string& path, double seconds, doc::NativeImage& out, std::string& error) {
  const std::scoped_lock lock(mutex_);
  std::string why;
  const Entry* e = importer_for(path, why);
  if (e == nullptr || !why.empty() || !loaded(e->plugin)) {
    error = !why.empty() ? why : "no loaded plugin imports this file";
    return false;
  }
  OpenFile* f = open_file(*e, path, error);
  if (f == nullptr) return false;
  const PrImportInfo info = f->info;
  if (info.width <= 0 || info.height <= 0) {
    error = "it reported no picture";
    return false;
  }
  const PrPixelFormat fmt = info.pixel_format == PR_PIXEL_FORMAT_RGBA16 || info.pixel_format == PR_PIXEL_FORMAT_RGBA32F
                                ? info.pixel_format
                                : PR_PIXEL_FORMAT_RGBA8;
  const std::int32_t bpp = pr_bytes_per_pixel(fmt);
  std::vector<std::uint8_t> pixels(static_cast<std::size_t>(info.width) * static_cast<std::size_t>(info.height) * static_cast<std::size_t>(bpp));
  PrWorld w{};
  w.struct_size = sizeof(PrWorld);
  w.width = info.width;
  w.height = info.height;
  w.row_bytes = info.width * bpp;
  w.format = fmt;
  w.data = pixels.data();
  PrImportCall c{};
  c.path = path.c_str();
  c.info = &f->info;
  c.file_data = f->data;
  // A still ignores the time; a moving file's time is clamped into its duration.
  const double t = info.duration > 0 ? std::clamp(seconds, 0.0, static_cast<double>(info.duration) / PR_TIME_SCALE) : 0.0;
  c.time = static_cast<std::int64_t>(std::llround(t * PR_TIME_SCALE));
  c.frame = &w;
  if (!call_import(*e, PR_IMPORT_READ_FRAME, c, error)) return false;
  out.width = static_cast<std::uint32_t>(info.width);
  out.height = static_cast<std::uint32_t>(info.height);
  out.linear = info.linear != 0;
  out.rgba.resize(static_cast<std::size_t>(info.width) * static_cast<std::size_t>(info.height) * 4);
  for (std::int32_t y = 0; y < info.height; ++y) {
    for (std::int32_t x = 0; x < info.width; ++x) {
      float* o = &out.rgba[(static_cast<std::size_t>(y) * static_cast<std::size_t>(info.width) + static_cast<std::size_t>(x)) * 4];
      read_px(w, x, y, o);
      if (info.has_alpha == 0) o[3] = 1;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    }
  }
  return true;
}

bool Contrib::read_audio(const std::string& path, std::int64_t start, std::uint32_t frames, std::vector<float>& out,
                         std::uint32_t& channels, std::string& error) {
  const std::scoped_lock lock(mutex_);
  std::string why;
  const Entry* e = importer_for(path, why);
  if (e == nullptr || !why.empty() || !loaded(e->plugin)) {
    error = !why.empty() ? why : "no loaded plugin imports this file";
    return false;
  }
  OpenFile* f = open_file(*e, path, error);
  if (f == nullptr) return false;
  if (f->info.has_audio == 0 || f->info.audio_channels == 0 || f->info.audio_channels > 64) {
    error = "the file has no sound";
    return false;
  }
  channels = f->info.audio_channels;
  out.assign(static_cast<std::size_t>(frames) * channels, 0.0F);
  PrImportCall c{};
  c.path = path.c_str();
  c.info = &f->info;
  c.file_data = f->data;
  c.audio_start = start;
  c.audio_frames = frames;
  c.audio = out.data();
  if (!call_import(*e, PR_IMPORT_READ_AUDIO, c, error)) return false;
  out.resize(static_cast<std::size_t>(std::min(c.audio_frames_read, frames)) * channels);
  return true;
}

bool Contrib::audio_format(const std::string& path, std::uint32_t& rate, std::uint32_t& channels, std::int64_t& frames,
                           std::string& codec, std::string& error) {
  const std::scoped_lock lock(mutex_);
  std::string why;
  const Entry* e = importer_for(path, why);
  if (e == nullptr || !why.empty() || !loaded(e->plugin)) {
    error = !why.empty() ? why : "no loaded plugin imports this file";
    return false;
  }
  OpenFile* f = open_file(*e, path, error);
  if (f == nullptr) {
    error = "plugin failed to read '" + path + "': " + error;
    return false;
  }
  rate = 0;
  channels = 0;
  frames = 0;
  codec = message_of(f->info.codec, sizeof(f->info.codec));
  if (f->info.has_audio == 0) return true;  // no sound: a silent source
  if (f->info.audio_channels == 0 || f->info.audio_channels > 64 || f->info.audio_sample_rate < 1000 ||
      f->info.audio_sample_rate > 768000 || f->info.audio_frames < 0) {
    error = "plugin failed to read '" + path + "': it reported an unusable sound format";
    return false;
  }
  rate = f->info.audio_sample_rate;
  channels = f->info.audio_channels;
  frames = f->info.audio_frames;
  return true;
}

// ── output modules ───────────────────────────────────────────────────────

void export_frame_to_float(std::span<const std::uint8_t> rgba, int depth, std::vector<float>& out) {
  if (depth == 16) {
    out.resize(rgba.size() / 2);
    for (std::size_t i = 0; i < out.size(); ++i) {
      const auto v = static_cast<std::uint16_t>(rgba[2 * i] | (rgba[2 * i + 1] << 8U));  // little-endian
      out[i] = static_cast<float>(v) / 65535.0F;
    }
    return;
  }
  out.resize(rgba.size());
  for (std::size_t i = 0; i < out.size(); ++i) out[i] = static_cast<float>(rgba[i]) / 255.0F;
}

void interleave_audio(const std::vector<std::vector<float>>& channels, std::vector<float>& out) {
  const std::size_t n = channels.empty() ? 0 : channels.front().size();
  out.assign(n * channels.size(), 0.0F);
  for (std::size_t c = 0; c < channels.size(); ++c) {
    for (std::size_t i = 0; i < n && i < channels[c].size(); ++i) out[i * channels.size() + c] = channels[c][i];
  }
}

std::unique_ptr<OutputJob> Contrib::output_job(std::string_view format, std::string& error) {
  if (!format.starts_with("plugin:")) {
    error = "not a plugin output module: '" + std::string(format) + "'";
    return nullptr;
  }
  const std::string_view rest = format.substr(7);
  const std::size_t slash = rest.find('/');
  if (slash == std::string_view::npos) {
    error = "a plugin format is plugin:<plugin id>/<module id>";
    return nullptr;
  }
  const std::string plugin(rest.substr(0, slash));
  const std::string id(rest.substr(slash + 1));
  PrOutputMainFn fn = nullptr;
  {
    const std::scoped_lock lock(mutex_);
    const auto it = entries_.find(plugin + "/o/" + id);
    if (it != entries_.end()) fn = it->second->output;
  }
  if (fn == nullptr || !loaded(plugin)) {
    error = "no loaded plugin provides the output module '" + std::string(format) + "'";
    return nullptr;
  }
  return std::make_unique<OutputJob>(host_, plugin, id, fn);
}

std::string Contrib::output_options(std::string_view format, std::string_view userJson) const {
  const std::size_t slash = format.find('/');
  if (!format.starts_with("plugin:") || slash == std::string_view::npos) return "{}";
  const std::string plugin(format.substr(7, slash - 7));
  const std::string id(format.substr(slash + 1));
  const auto user = js::parse(userJson);
  js::Json out = js::Json::object();
  const std::scoped_lock lock(mutex_);
  const auto mit = manifests_.find(plugin);
  if (mit == manifests_.end()) return "{}";
  for (const ManifestOutputModule& m : mit->second.outputModules) {
    if (m.id != id) continue;
    for (const ManifestOutputOption& op : m.options) {
      double v = op.def;
      if (user && user->is_object()) {
        const js::Json& u = user->at(op.id);
        if (u.is_number() && std::isfinite(u.num())) v = u.num();
        if (u.is_bool()) v = u.b() ? 1 : 0;
      }
      if (op.min) v = std::max(v, *op.min);
      if (op.max) v = std::min(v, *op.max);
      if (op.type == "popup") v = std::clamp(std::round(v), 1.0, static_cast<double>(op.choices.size()));
      if (op.type == "checkbox") {
        out.set(op.id, js::Json::boolean(v != 0));
      } else {
        out.set(op.id, js::Json::number(v));
      }
    }
  }
  return js::stringify(out);
}

OutputJob::OutputJob(PluginHost& host, std::string pluginId, std::string moduleId, PrOutputMainFn main)
    : host_(host), plugin_(std::move(pluginId)), module_(std::move(moduleId)), main_(main) {}

OutputJob::~OutputJob() {
  if (begun_ && !ended_) {
    std::string ignored;
    (void)finish(true, ignored);
  }
}

bool OutputJob::call(PrIoCmd cmd, PrOutputCall& c, std::string& error) {
  struct Call {
    PrOutputMainFn fn;
    PrIoCmd cmd;
    PrOutputCall* c;
    PrErr result;
  } call{main_, cmd, &c, PR_ERR_NONE};
  c.struct_size = sizeof(PrOutputCall);
  c.host_sdk_version = PR_SDK_VERSION;
  c.module_id = module_.c_str();
  c.width = params_.width;
  c.height = params_.height;
  c.frame_rate = params_.fps;
  c.frame_count = params_.frameCount;
  c.audio_sample_rate = params_.audioRate;
  c.audio_channels = params_.audioChannels;
  c.path = params_.path.c_str();
  c.options_json = params_.optionsJson.c_str();
  c.job_data = jobData_;
  const CallResult res = host_.call_guarded(
      plugin_, kJournalOutputBase + cmd,
      [](void* p, PrHost* h, const PrHostSuite* s) {
        auto* x = static_cast<Call*>(p);
        x->c->host = s;
        x->c->host_ref = h;
        x->result = x->fn(x->cmd, x->c);
      },
      &call);
  if (res.fault) {
    error = "the output module of plugin '" + plugin_ + "' crashed (" + res.message + ")";
    ended_ = true;  // never call a module that faulted again
    return false;
  }
  if (res.skipped) {
    error = res.message;
    return false;
  }
  if (cmd == PR_OUTPUT_BEGIN) jobData_ = c.job_data;
  if (call.result != PR_ERR_NONE) {
    error = message_of(c.return_msg, sizeof(c.return_msg));
    if (error.empty()) error = "the output module returned error " + std::to_string(call.result);
    return false;
  }
  return true;
}

bool OutputJob::begin(const OutputParams& p, std::string& error) {
  params_ = p;
  if (p.width <= 0 || p.height <= 0) {
    error = "no frame size";
    return false;
  }
  PrOutputCall c{};
  begun_ = call(PR_OUTPUT_BEGIN, c, error);
  if (!begun_) ended_ = true;
  return begun_;
}

bool OutputJob::write_frame(std::int64_t index, std::int64_t time, const float* rgba, std::string& error) {
  if (!begun_ || ended_) {
    error = "the output module is not running";
    return false;
  }
  PrWorld w{};
  w.struct_size = sizeof(PrWorld);
  w.width = params_.width;
  w.height = params_.height;
  w.row_bytes = params_.width * 16;
  w.format = PR_PIXEL_FORMAT_RGBA32F;
  w.data = const_cast<float*>(rgba);  // NOLINT(cppcoreguidelines-pro-type-const-cast): the call's `frame` is const PrWorld*
  PrOutputCall c{};
  c.frame_index = index;
  c.time = time;
  c.frame = &w;
  return call(PR_OUTPUT_WRITE_FRAME, c, error);
}

bool OutputJob::write_audio(const float* samples, std::uint32_t frames, std::string& error) {
  if (!begun_ || ended_) {
    error = "the output module is not running";
    return false;
  }
  if (params_.audioChannels == 0) return true;
  PrOutputCall c{};
  c.audio = samples;
  c.audio_frames = frames;
  return call(PR_OUTPUT_WRITE_AUDIO, c, error);
}

bool OutputJob::finish(bool cancelled, std::string& error) {
  if (!begun_ || ended_) return false;
  PrOutputCall c{};
  c.cancelled = cancelled ? 1 : 0;
  const bool ok = call(PR_OUTPUT_END, c, error);
  ended_ = true;
  return ok;
}

}  // namespace premation::plugins
