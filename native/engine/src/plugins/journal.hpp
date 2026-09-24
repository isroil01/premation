// The plugin crash journal (G1): what survives the engine process dying
// inside a plugin.
//
// A small file mapped into memory. Before every selector call the host writes
// "plugin P is in command C" into a slot; after the call it clears the slot.
// Writes to a mapped view land in the OS file cache, so they survive the
// process being killed — by abort(), exit(), heap corruption the guard cannot
// see, or the watchdog ending a hung engine. The next engine start opens the
// journal, finds the slots still set, and QUARANTINES those plugins (After
// Effects' "this plugin crashed last time — disable it?"): they are listed but
// not loaded until the user re-enables them (setPluginEnabled).
//
// The mapping is OS FFI (journal_ffi.cpp). Cost per call: two stores into
// mapped memory, no syscall.
#pragma once

#include <atomic>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace premation::plugins {

struct QuarantineEntry {
  std::string pluginId;
  std::string reason;
};

class CrashJournal {
 public:
  static constexpr std::size_t kSlots = 64;
  static constexpr std::size_t kQuarantine = 32;
  static constexpr std::size_t kIdBytes = 120;
  static constexpr std::size_t kReasonBytes = 136;

  /// Open (creating) the journal at `file`. What the previous process left in
  /// its slots moves into the quarantine list. nullptr + `error` on failure.
  static std::unique_ptr<CrashJournal> open(const std::filesystem::path& file, std::string& error);
  ~CrashJournal();
  CrashJournal(const CrashJournal&) = delete;
  CrashJournal& operator=(const CrashJournal&) = delete;
  CrashJournal(CrashJournal&&) = delete;
  CrashJournal& operator=(CrashJournal&&) = delete;

  /// Mark a call in flight; returns the slot (or -1 when all are busy — the call
  /// then runs unjournaled).
  int enter(std::string_view pluginId, std::int32_t cmd) noexcept;
  void leave(int slot) noexcept;

  [[nodiscard]] std::vector<QuarantineEntry> quarantined() const;
  [[nodiscard]] bool is_quarantined(std::string_view pluginId) const;
  void quarantine(std::string_view pluginId, std::string_view reason) noexcept;
  void release(std::string_view pluginId) noexcept;

 private:
  CrashJournal() = default;
  struct Mapping;
  std::unique_ptr<Mapping> map_;
  std::atomic<std::uint64_t> busy_{0};  ///< slot bitmap (the in-memory allocator; the file holds the content)
};

/// The engine's C-selector names, for journal reasons and layer errors.
[[nodiscard]] std::string_view command_name(std::int32_t cmd) noexcept;

}  // namespace premation::plugins
