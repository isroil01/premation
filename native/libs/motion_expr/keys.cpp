// Name tables: property KeyIds (keys.def) and the global scope slots.

#include <algorithm>
#include <array>
#include <cstddef>
#include <string_view>
#include <utility>

#include "value.hpp"

namespace motion::expr::detail {
namespace {

constexpr std::array<std::u16string_view, static_cast<std::size_t>(KeyId::kCount_)> kKeyNames = {
    u"",
#define K(id) u## #id,         // NOLINT(cppcoreguidelines-macro-usage) — X-macro over keys.def
#define KN(id, name) u"" name,  // NOLINT(cppcoreguidelines-macro-usage)
#include "keys.def"
#undef K
#undef KN
};

struct SortedKeys {
  std::array<std::pair<std::u16string_view, KeyId>, static_cast<std::size_t>(KeyId::kCount_) - 1> entries{};
  SortedKeys() {
    for (std::size_t i = 1; i < kKeyNames.size(); ++i) entries[i - 1] = {kKeyNames[i], static_cast<KeyId>(i)};
    std::ranges::sort(entries);
  }
};

const SortedKeys& sorted_keys() {
  static const SortedKeys s;
  return s;
}

constexpr std::array<std::u16string_view, static_cast<std::size_t>(Global::kCount_)> kGlobalNames = {
    u"time",          u"value",       u"audio",       u"ctrl",       u"wiggle",       u"clamp",
    u"linear",        u"ease",        u"easeIn",      u"easeOut",    u"timeToFrames", u"framesToTime",
    u"random",        u"Math",        u"valueAtTime", u"velocity",   u"speed",        u"velocityAtTime",
    u"layer",         u"layerAt",     u"loopOut",     u"loopIn",     u"thisComp",     u"thisLayer",
    u"thisProperty",  u"sourceRectAtTime", u"toComp", u"toWorld",    u"fromComp",     u"fromWorld",
    u"seedRandom",    u"gaussRandom", u"noise",       u"numKeys",    u"key",          u"nearestKey",
    u"marker",        u"posterizeTime", u"add",       u"sub",        u"mul",          u"div",
    u"dot",           u"cross",       u"length",      u"normalize",  u"text",         u"plugin",
};

}  // namespace

KeyId key_of(std::u16string_view name) noexcept {
  const auto& e = sorted_keys().entries;
  const auto it = std::ranges::lower_bound(e, name, {}, [](const auto& entry) { return entry.first; });
  if (it != e.end() && it->first == name) return it->second;
  return KeyId::kUnknown;
}

std::u16string_view key_name(KeyId k) noexcept { return kKeyNames[static_cast<std::size_t>(k)]; }

Global global_of(std::u16string_view name) noexcept {
  for (std::size_t i = 0; i < kGlobalNames.size(); ++i) {
    if (kGlobalNames[i] == name) return static_cast<Global>(i);
  }
  return Global::kNone;
}

}  // namespace motion::expr::detail
