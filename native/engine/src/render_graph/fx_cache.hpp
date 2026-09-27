// E4: what the effect chain keeps across frames — the alpha distance fields of
// the styles (fx_distance.hpp), keyed by the CONTENT the chain started from
// (composition_pass.cpp chain_content_key: the layer's texture hashes, its
// placement, the viewport) and not by the effect's params, so animating a
// stroke's width, a glow's spread or the fill opacity re-uses the field and
// pays only the style's own pass.
//
// Slots name persistent Device targets (`fx-sdf-<i>`). A slot is valid while
// its target lives: the Device pool collects a target untouched for 120 frames
// and a re-created one reports `created`, which invalidates the slot
// (distance_field checks it). Owned by the SceneRenderer; render thread only.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>

namespace premation::rg {

class FxCache {
 public:
  static constexpr std::size_t kSlots = 4;

  struct Slot {
    std::string name;
    std::uint64_t key = 0;  ///< 0 = empty
    double range = 0;       ///< texels the field is exact to
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint64_t used = 0;  ///< the Device frame it was last read or written
  };

  FxCache() {
    for (std::size_t i = 0; i < kSlots; ++i) slots_.at(i).name = "fx-sdf-" + std::to_string(i);
  }

  /// The slot holding `key` at least `range` deep at w × h, or null.
  [[nodiscard]] Slot* find(std::uint64_t key, double range, std::uint32_t w, std::uint32_t h) noexcept {
    if (key == 0) return nullptr;
    for (Slot& s : slots_) {
      if (s.key == key && s.range >= range && s.width == w && s.height == h) return &s;
    }
    return nullptr;
  }

  /// A slot for `key`: its own if held (at a smaller range), else the least recently used one.
  Slot& claim(std::uint64_t key, double range, std::uint32_t w, std::uint32_t h, std::uint64_t frame) noexcept {
    Slot* pick = nullptr;
    for (Slot& s : slots_) {
      if (s.key == key && s.width == w && s.height == h) {
        pick = &s;
        break;
      }
    }
    if (pick == nullptr) {
      pick = &slots_.front();
      for (Slot& s : slots_) {
        if (s.key == 0 || s.used < pick->used) pick = &s;
        if (s.key == 0) break;
      }
    }
    pick->key = key;
    pick->range = range;
    pick->width = w;
    pick->height = h;
    pick->used = frame;
    return *pick;
  }

  void forget(Slot& s) noexcept { s.key = 0; }

  void clear() noexcept {
    for (Slot& s : slots_) s.key = 0;
  }

 private:
  std::array<Slot, kSlots> slots_;
};

}  // namespace premation::rg
