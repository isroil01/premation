#include "native_effects.hpp"

#include <array>
#include <deque>
#include <memory>
#include <mutex>
#include <shared_mutex>
#include <unordered_map>

namespace premation::doc {
namespace {

struct Entry {
  NativeEffect effect;
  bool available = true;
};

/// Heterogeneous lookup: Registry::effect() resolves a string_view without allocating.
struct TypeHash {
  using is_transparent = void;
  std::size_t operator()(std::string_view s) const noexcept { return std::hash<std::string_view>{}(s); }
};

struct State {
  std::shared_mutex mutex;
  /// Never erased: a `const EffectDef*` handed out stays valid for the process.
  std::deque<std::unique_ptr<Entry>> entries;
  /// type → newest entry.
  std::unordered_map<std::string, Entry*, TypeHash, std::equal_to<>> byType;
  std::vector<std::string> order;  ///< types in first-registration order
  std::mutex handlerMutex;
  NativeEffects::CreatedFn created;
  NativeEffects::ActionFn action;
  NativeEffects::EnabledFn enabled;
};

State& state() {
  static State s;  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables): the process-wide registry
  return s;
}

}  // namespace

void NativeEffects::add(NativeEffect e) {
  State& s = state();
  const std::unique_lock lock(s.mutex);
  auto entry = std::make_unique<Entry>();
  entry->effect = std::move(e);
  const std::string type = entry->effect.def.type;
  if (!s.byType.contains(type)) s.order.push_back(type);
  s.byType.insert_or_assign(type, entry.get());
  s.entries.push_back(std::move(entry));
}

const NativeEffect* NativeEffects::find(std::string_view type) noexcept {
  State& s = state();
  const std::shared_lock lock(s.mutex);
  if (s.byType.empty()) return nullptr;
  const auto it = s.byType.find(type);
  return it == s.byType.end() ? nullptr : &it->second->effect;
}

std::vector<const NativeEffect*> NativeEffects::list() {
  State& s = state();
  const std::shared_lock lock(s.mutex);
  std::vector<const NativeEffect*> out;
  for (const std::string& t : s.order) {
    const Entry* e = s.byType.at(t);
    if (e->available) out.push_back(&e->effect);
  }
  return out;
}

void NativeEffects::set_available(std::string_view provider, bool available) {
  State& s = state();
  const std::unique_lock lock(s.mutex);
  for (auto& [type, e] : s.byType) {
    if (e->effect.provider == provider) e->available = available;
  }
}

bool NativeEffects::available(std::string_view type) noexcept {
  State& s = state();
  const std::shared_lock lock(s.mutex);
  const auto it = s.byType.find(type);
  return it != s.byType.end() && it->second->available;
}

void NativeEffects::set_handlers(CreatedFn created, ActionFn action, EnabledFn enabled) {
  State& s = state();
  const std::scoped_lock lock(s.handlerMutex);
  s.created = std::move(created);
  s.action = std::move(action);
  s.enabled = std::move(enabled);
}

void NativeEffects::clear_handlers() { set_handlers({}, {}, {}); }

std::optional<std::vector<std::uint8_t>> NativeEffects::created(std::string_view type) {
  State& s = state();
  CreatedFn fn;
  {
    const std::scoped_lock lock(s.handlerMutex);
    fn = s.created;
  }
  return fn ? fn(type) : std::nullopt;
}

std::variant<NativeEdit, NativeFailure> NativeEffects::action(const NativeActionRequest& r) {
  State& s = state();
  ActionFn fn;
  {
    const std::scoped_lock lock(s.handlerMutex);
    fn = s.action;
  }
  if (!fn) return NativeFailure{"no native plugin host is attached to this engine"};
  return fn(r);
}

bool NativeEffects::set_enabled(std::string_view plugin, bool enabled) {
  State& s = state();
  EnabledFn fn;
  {
    const std::scoped_lock lock(s.handlerMutex);
    fn = s.enabled;
  }
  return fn ? fn(plugin, enabled) : false;
}

std::string native_data_group(std::string_view effectId) { return "effects/" + std::string(effectId); }

std::string native_arb_key(std::string_view paramKey) { return "arb:" + std::string(paramKey); }

std::string native_base64(const std::vector<std::uint8_t>& bytes) {
  static constexpr std::string_view kAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve((bytes.size() + 2) / 3 * 4);
  std::size_t i = 0;
  for (; i + 2 < bytes.size(); i += 3) {
    const std::uint32_t v = (std::uint32_t{bytes[i]} << 16U) | (std::uint32_t{bytes[i + 1]} << 8U) | bytes[i + 2];
    out += kAlphabet[(v >> 18U) & 63U];
    out += kAlphabet[(v >> 12U) & 63U];
    out += kAlphabet[(v >> 6U) & 63U];
    out += kAlphabet[v & 63U];
  }
  if (i + 1 == bytes.size()) {
    const std::uint32_t v = std::uint32_t{bytes[i]} << 16U;
    out += kAlphabet[(v >> 18U) & 63U];
    out += kAlphabet[(v >> 12U) & 63U];
    out += "==";
  } else if (i + 2 == bytes.size()) {
    const std::uint32_t v = (std::uint32_t{bytes[i]} << 16U) | (std::uint32_t{bytes[i + 1]} << 8U);
    out += kAlphabet[(v >> 18U) & 63U];
    out += kAlphabet[(v >> 12U) & 63U];
    out += kAlphabet[(v >> 6U) & 63U];
    out += '=';
  }
  return out;
}

std::optional<std::vector<std::uint8_t>> native_unbase64(std::string_view text) {
  const auto value = [](char c) -> int {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
  };
  while (!text.empty() && text.back() == '=') text.remove_suffix(1);
  std::vector<std::uint8_t> out;
  out.reserve(text.size() * 3 / 4);
  std::uint32_t acc = 0;
  int bits = 0;
  for (const char c : text) {
    const int v = value(c);
    if (v < 0) return std::nullopt;
    acc = (acc << 6U) | static_cast<std::uint32_t>(v);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<std::uint8_t>((acc >> static_cast<unsigned>(bits)) & 0xFFU));
    }
  }
  return out;
}

}  // namespace premation::doc
