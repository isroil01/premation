#include "native_contrib.hpp"

#include <atomic>
#include <map>
#include <mutex>
#include <shared_mutex>
#include <utility>

namespace premation::doc {
namespace {

struct Registry {
  std::shared_mutex mutex;
  NativeCommands::ListFn list;
  NativeCommands::RunFn run;
  NativeCommands::ToolEventFn toolEvent;  // SDK 1.4 (U1)
  NativeImporters::ClaimFn claim;
  NativeImporters::ProbeFn probe;
  NativeImporters::FrameFn frame;
  NativeImporters::RefuseFn refuse;
  std::atomic<bool> anyImporter{false};
  std::mutex failMutex;
  std::map<std::string, std::string, std::less<>> failures;
};

Registry& reg() {
  static Registry r;  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables): the process's one registry
  return r;
}

}  // namespace

void NativeCommands::set_handlers(ListFn list, RunFn run) {
  const std::unique_lock lock(reg().mutex);
  reg().list = std::move(list);
  reg().run = std::move(run);
}

void NativeCommands::clear_handlers() {
  const std::unique_lock lock(reg().mutex);
  reg().list = nullptr;
  reg().run = nullptr;
  reg().toolEvent = nullptr;
}

void NativeCommands::set_tool_event_handler(ToolEventFn fn) {
  const std::unique_lock lock(reg().mutex);
  reg().toolEvent = std::move(fn);
}

std::variant<PluginToolFeedback, api::EngineError> NativeCommands::tool_event(const PluginCommandRequest& r) {
  ToolEventFn fn;
  {
    const std::shared_lock lock(reg().mutex);
    fn = reg().toolEvent;
  }
  if (!fn) {
    api::EngineError e;
    e.code = api::ErrorCode::not_found;
    e.message = "no plugin host";
    return e;
  }
  return fn(r);
}

std::vector<api::PluginCommandInfo> NativeCommands::list() {
  ListFn fn;
  {
    const std::shared_lock lock(reg().mutex);
    fn = reg().list;
  }
  return fn ? fn() : std::vector<api::PluginCommandInfo>{};
}

std::variant<PluginCommandOutcome, api::EngineError> NativeCommands::run(const PluginCommandRequest& r, PluginCommandBridge& bridge) {
  RunFn fn;
  {
    const std::shared_lock lock(reg().mutex);
    fn = reg().run;
  }
  if (!fn) {
    api::EngineError e;
    e.code = api::ErrorCode::not_found;
    e.message = "no plugin command '" + r.plugin + "/" + r.command + "' (no plugin host)";
    return e;
  }
  return fn(r, bridge);
}

void NativeImporters::set_handlers(ClaimFn claim, ProbeFn probe, FrameFn frame, RefuseFn refuse) {
  const std::unique_lock lock(reg().mutex);
  reg().claim = std::move(claim);
  reg().probe = std::move(probe);
  reg().frame = std::move(frame);
  reg().refuse = std::move(refuse);
}

void NativeImporters::clear_handlers() {
  const std::unique_lock lock(reg().mutex);
  reg().claim = nullptr;
  reg().probe = nullptr;
  reg().frame = nullptr;
  reg().refuse = nullptr;
  reg().anyImporter.store(false);
}

bool NativeImporters::claims(std::string_view path) {
  ClaimFn fn;
  {
    const std::shared_lock lock(reg().mutex);
    fn = reg().claim;
  }
  return fn && fn(path);
}

std::string NativeImporters::refusal(std::string_view path) {
  RefuseFn fn;
  {
    const std::shared_lock lock(reg().mutex);
    fn = reg().refuse;
  }
  return fn ? fn(path) : std::string();
}

void NativeImporters::set_any(bool any) { reg().anyImporter.store(any, std::memory_order_release); }
bool NativeImporters::any() { return reg().anyImporter.load(std::memory_order_acquire); }

bool NativeImporters::probe(const std::string& path, js::Json& facts, std::string& error) {
  ProbeFn fn;
  {
    const std::shared_lock lock(reg().mutex);
    fn = reg().probe;
  }
  if (!fn) {
    error = "no plugin importer";
    return false;
  }
  return fn(path, facts, error);
}

bool NativeImporters::read_frame(const std::string& path, double seconds, NativeImage& out, std::string& error) {
  FrameFn fn;
  {
    const std::shared_lock lock(reg().mutex);
    fn = reg().frame;
  }
  if (!fn) {
    error = "no plugin importer";
    return false;
  }
  return fn(path, seconds, out, error);
}

void NativeImporters::set_failure(const std::string& path, std::string message) {
  const std::scoped_lock lock(reg().failMutex);
  reg().failures[path] = std::move(message);
}

void NativeImporters::clear_failure(const std::string& path) {
  const std::scoped_lock lock(reg().failMutex);
  reg().failures.erase(path);
}

std::optional<std::string> NativeImporters::failure(const std::string& path) {
  const std::scoped_lock lock(reg().failMutex);
  const auto it = reg().failures.find(path);
  if (it == reg().failures.end()) return std::nullopt;
  return it->second;
}

}  // namespace premation::doc
