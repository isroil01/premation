// Which neighbouring frames to ghost, and how strongly (src/core/rendering/onionSkin.ts).
// Draw order is farthest first, the two sides interleaved, so the nearest ghost
// lands on top. Frames outside [min, max] are dropped, not clamped.
#pragma once

#include <algorithm>
#include <cstdint>
#include <vector>

namespace premation {

struct OnionGhostPlan {
  std::int64_t frame = 0;
  float opacity = 0;
  /// sRGB 0..1. strength 0 = no tint.
  float tintR = 0;
  float tintG = 0;
  float tintB = 0;
  float tintStrength = 0;
};

struct OnionPlanSettings {
  int before = 0;
  int after = 0;
  int step = 1;
  double opacity = 0.35;
  bool colorize = true;
};

/// Past #ff5a3c, future #3ca0ff. Tint strength matches the page painter.
inline constexpr float kOnionTintStrength = 0.55F;

[[nodiscard]] inline std::vector<OnionGhostPlan> onion_skin_plan(std::int64_t current, OnionPlanSettings settings,
                                                                  std::int64_t minFrame, std::int64_t maxFrame) {
  const int step = std::max(1, settings.step);
  const int before = std::clamp(settings.before, 0, 8);
  const int after = std::clamp(settings.after, 0, 8);
  const double peak = std::clamp(settings.opacity, 0.0, 1.0);
  if (before == 0 && after == 0) return {};
  if (peak == 0) return {};

  const auto side = [&](int count, int dir, bool past) {
    std::vector<OnionGhostPlan> list;
    for (int i = count; i >= 1; --i) {
      const std::int64_t frame = current + static_cast<std::int64_t>(dir) * i * step;
      if (frame < minFrame || frame > maxFrame) continue;
      OnionGhostPlan g;
      g.frame = frame;
      g.opacity = static_cast<float>(peak * (static_cast<double>(count - i + 1) / count));
      if (settings.colorize) {
        g.tintStrength = kOnionTintStrength;
        if (past) {
          g.tintR = 1.0F;
          g.tintG = 90.0F / 255.0F;
          g.tintB = 60.0F / 255.0F;
        } else {
          g.tintR = 60.0F / 255.0F;
          g.tintG = 160.0F / 255.0F;
          g.tintB = 1.0F;
        }
      }
      list.push_back(g);
    }
    return list;
  };

  const auto past = side(before, -1, true);
  const auto future = side(after, 1, false);
  std::vector<OnionGhostPlan> out;
  const std::size_t n = std::max(past.size(), future.size());
  for (std::size_t i = 0; i < n; ++i) {
    if (i < past.size()) out.push_back(past[i]);
    if (i < future.size()) out.push_back(future[i]);
  }
  return out;
}

}  // namespace premation
