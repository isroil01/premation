#include "temporal_ghosts.hpp"

#include <algorithm>
#include <array>
#include <cmath>

#include "effects_port.hpp"
#include "jsmath.hpp"

namespace premation::scene {
namespace {

/// Ghosts too faint to see cost a full layer draw each (MIN_VISIBLE).
constexpr double kMinVisible = 0.002;

struct EchoOp {
  std::string_view blend;
  bool inFront;
};
/// ECHO_OPERATORS, menu order.
constexpr std::array<EchoOp, 6> kEchoOps = {{
    {"add", false}, {"lighten", false}, {"darken", false}, {"screen", false}, {"normal", false}, {"normal", true},
}};

double clamp01(double v) { return std::max(0.0, std::min(1.0, v)); }

const Json* find_enabled(const std::vector<Json>& effects, std::string_view type) {
  for (const Json& e : effects) {
    if (e.at("type").is_string() && e.at("type").str() == type && !(e.at("enabled").is_bool() && !e.at("enabled").b())) {
      return &e;
    }
  }
  return nullptr;
}

/// order(): drop the invisible, farthest first (Array.prototype.sort is stable).
std::vector<GhostStep> order(std::vector<GhostStep> steps) {
  std::erase_if(steps, [](const GhostStep& s) { return !(s.opacity > kMinVisible); });
  std::ranges::stable_sort(steps, [](const GhostStep& a, const GhostStep& b) { return std::abs(b.dt) < std::abs(a.dt); });
  return steps;
}

}  // namespace

std::optional<GhostSpec> read_ghost_spec(const std::vector<Json>& effects, double fps) {
  if (const Json* e = find_enabled(effects, "echo")) {
    // readEchoConfig: an operator index naming no operator falls back to Add.
    const double opIdx = motion::js::round(effect_number(*e, "echoOperator"));
    const EchoOp op = opIdx >= 0 && opIdx < static_cast<double>(kEchoOps.size()) ? kEchoOps[static_cast<std::size_t>(opIdx)]
                                                                                  : kEchoOps[0];
    const double time = effect_number(*e, "echoTime");
    const double count = std::max(0.0, std::min(64.0, motion::js::round(effect_number(*e, "numEchoes"))));
    const double start = clamp01(effect_number(*e, "startIntensity") / 100);
    const double decay = clamp01(effect_number(*e, "decay") / 100);
    if (count > 0 && time != 0) {
      GhostSpec g;
      std::vector<GhostStep> steps;
      for (int k = 1; k <= static_cast<int>(count); ++k) steps.push_back({k * time, start * motion::js::pow(decay, k - 1)});
      g.steps = order(std::move(steps));
      g.blend = std::string(op.blend);
      g.inFront = op.inFront;
      return g;
    }
  }
  if (const Json* e = find_enabled(effects, "wide-time")) {
    const double fwd = std::max(0.0, std::min(64.0, motion::js::round(effect_number(*e, "forwardSteps"))));
    const double back = std::max(0.0, std::min(64.0, motion::js::round(effect_number(*e, "backwardSteps"))));
    if (fwd + back == 0 || fps <= 0) return std::nullopt;
    const double weight = 1 / (fwd + back + 1);
    std::vector<GhostStep> steps;
    for (int k = 1; k <= static_cast<int>(back); ++k) steps.push_back({-k / fps, weight});
    for (int k = 1; k <= static_cast<int>(fwd); ++k) steps.push_back({k / fps, weight});
    GhostSpec g;
    g.steps = order(std::move(steps));
    return g;
  }
  return std::nullopt;
}

std::vector<RLayer> ghost_layers(const RLayer& layer, const GhostSpec& spec, double t, const GhostSampler& sample,
                                 double localX, double localY, double localRot, double px, double py, double rot,
                                 const GhostPlace3D& place3d) {
  std::vector<RLayer> out;
  for (std::size_t k = 0; k < spec.steps.size(); ++k) {
    const GhostStep& step = spec.steps[k];
    const double ti = t + step.dt;
    if (ti < 0) continue;
    const double op = layer.opacity * step.opacity;
    if (op <= 0.002) continue;
    RLayer g = layer;
    g.id = layer.id + "__echo" + std::to_string(k);
    g.opacity = op;
    g.blend = spec.blend;
    g.matte = std::nullopt;
    g.matteSourceId = std::nullopt;
    g.isMatteSource = false;
    g.isAdjustment = false;
    g.motionSamples.clear();
    const double dx = sample("x", ti).value_or(localX) - localX;
    const double dy = sample("y", ti).value_or(localY) - localY;
    const double drot = sample("rotation", ti).value_or(localRot) - localRot;
    if (place3d) {
      place3d(g, ti, dx, dy, drot);
    } else {
      g.x = px + dx;
      g.y = py + dy;
      g.rotation = rot + drot;
    }
    out.push_back(std::move(g));
  }
  return out;
}

}  // namespace premation::scene
