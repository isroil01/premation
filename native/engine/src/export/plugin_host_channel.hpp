// SDK 1.4 (X): a premation-plugin-host child as the plugin host's out-of-process channel
// (plugins::OopChannel) — spawned with ChildProcess (stdin / stdout pipes; on Windows the child
// dies with the engine), one request at a time, killed when a reply takes longer than the call's
// timeout. The PluginHost restarts a dead child on its next call.
#pragma once

#include <filesystem>
#include <memory>
#include <string>

#include "host.hpp"

namespace premation::exporter {

/// `exe --bundle <bundle>` as a channel; nullptr + `error` when it cannot start.
[[nodiscard]] std::unique_ptr<plugins::OopChannel> spawn_plugin_host(const std::filesystem::path& exe, const std::filesystem::path& bundle,
                                                                     const std::filesystem::path& logFile, std::string& error);

}  // namespace premation::exporter
