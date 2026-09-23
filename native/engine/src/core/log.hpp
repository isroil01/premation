// Structured engine log: one JSON object per line on stderr.
//
//   {"t":12.345,"lvl":"info","ev":"welcome","client":"premation-ui"}
//
// stderr is the log and nothing else (stdout carries the protocol, fd 3 the
// frame channel). EngineSupervisor reads these lines, keeps a ring of the last
// ones for crash reports and forwards them to the app log. `t` is seconds
// since process start on the monotonic clock — measurement only.
#pragma once

#include <cstdint>
#include <string>
#include <string_view>

namespace premation::log {

enum class Level : std::uint8_t { debug = 0, info, warn, error };

void set_min_level(Level level) noexcept;
[[nodiscard]] bool enabled(Level level) noexcept;

/// Builds one line; written (atomically w.r.t. other lines) when destroyed.
class Line {
 public:
  Line(Level level, std::string_view event);
  ~Line();
  Line(const Line&) = delete;
  Line& operator=(const Line&) = delete;
  Line(Line&&) = delete;
  Line& operator=(Line&&) = delete;

  Line& kv(std::string_view key, std::string_view value);
  Line& kv(std::string_view key, const char* value) { return kv(key, std::string_view(value)); }
  Line& kv(std::string_view key, const std::string& value) { return kv(key, std::string_view(value)); }
  Line& kv(std::string_view key, std::int64_t value);
  Line& kv(std::string_view key, std::uint64_t value);
  Line& kv(std::string_view key, std::int32_t value) { return kv(key, static_cast<std::int64_t>(value)); }
  Line& kv(std::string_view key, std::uint32_t value) { return kv(key, static_cast<std::uint64_t>(value)); }
  Line& kv(std::string_view key, double value);
  Line& kv(std::string_view key, bool value);

 private:
  void key(std::string_view k);
  bool on_;
  std::string buf_;
};

inline Line info(std::string_view event) { return Line(Level::info, event); }

}  // namespace premation::log

// Usage: PREMATION_LOG(info, "welcome").kv("client", name);
// The macro skips building the line when the level is filtered out.
#define PREMATION_LOG(level, event)                                      \
  if (!::premation::log::enabled(::premation::log::Level::level)) {      \
  } else                                                                 \
    ::premation::log::Line(::premation::log::Level::level, event)
