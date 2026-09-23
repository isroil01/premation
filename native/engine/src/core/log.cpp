#include "log.hpp"

#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <mutex>

namespace premation::log {
namespace {

std::atomic<Level> g_min{Level::info};

std::mutex& out_mutex() {
  static std::mutex m;
  return m;
}

const auto g_start = std::chrono::steady_clock::now();

const char* level_name(Level l) {
  switch (l) {
    case Level::debug: return "debug";
    case Level::info: return "info";
    case Level::warn: return "warn";
    case Level::error: return "error";
  }
  return "info";
}

void append_escaped(std::string& out, std::string_view s) {
  for (const char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20U) {
          std::array<char, 8> hex{};
          std::snprintf(hex.data(), hex.size(), "\\u%04x", static_cast<unsigned>(static_cast<unsigned char>(c)));
          out += hex.data();
        } else {
          out += c;
        }
    }
  }
}

}  // namespace

void set_min_level(Level level) noexcept { g_min.store(level); }
bool enabled(Level level) noexcept { return level >= g_min.load(); }

Line::Line(Level level, std::string_view event) : on_(enabled(level)) {
  if (!on_) return;
  const double t = std::chrono::duration<double>(std::chrono::steady_clock::now() - g_start).count();
  std::array<char, 48> head{};
  std::snprintf(head.data(), head.size(), "{\"t\":%.3f,\"lvl\":\"%s\",\"ev\":\"", t, level_name(level));
  buf_.reserve(160);
  buf_ += head.data();
  append_escaped(buf_, event);
  buf_ += '"';
}

Line::~Line() {
  if (!on_) return;
  buf_ += "}\n";
  const std::lock_guard<std::mutex> lock(out_mutex());
  std::fwrite(buf_.data(), 1, buf_.size(), stderr);
  std::fflush(stderr);
}

void Line::key(std::string_view k) {
  buf_ += ",\"";
  append_escaped(buf_, k);
  buf_ += "\":";
}

Line& Line::kv(std::string_view k, std::string_view value) {
  if (!on_) return *this;
  key(k);
  buf_ += '"';
  append_escaped(buf_, value);
  buf_ += '"';
  return *this;
}

Line& Line::kv(std::string_view k, std::int64_t value) {
  if (!on_) return *this;
  key(k);
  buf_ += std::to_string(value);
  return *this;
}

Line& Line::kv(std::string_view k, std::uint64_t value) {
  if (!on_) return *this;
  key(k);
  buf_ += std::to_string(value);
  return *this;
}

Line& Line::kv(std::string_view k, double value) {
  if (!on_) return *this;
  key(k);
  if (!std::isfinite(value)) {
    buf_ += "null";
    return *this;
  }
  std::array<char, 32> num{};
  std::snprintf(num.data(), num.size(), "%.4g", value);
  buf_ += num.data();
  return *this;
}

Line& Line::kv(std::string_view k, bool value) {
  if (!on_) return *this;
  key(k);
  buf_ += value ? "true" : "false";
  return *this;
}

}  // namespace premation::log
