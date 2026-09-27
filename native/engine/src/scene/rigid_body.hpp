// Rigid-body physics for layers — a port of src/core/simulation/rigidBody.ts
// (the solver), simulationCore.ts (SimulationCache: snapshots every 30 frames,
// frame 0 pinned, so stateAt(f) never depends on earlier calls) and
// physicsBodies.ts (readNodePhysics, physicsPosesAt). Operation for operation,
// with V8's Math (motion::js) so a replay is bit-identical to the TypeScript.
//
// The physics WORLD (gravity, walls, passes) is the TS physicsStore — editor
// working values, never saved; the engine uses its defaults (gravity 0 / 1800,
// the comp rectangle as walls, 4 passes).
#pragma once

#include <map>
#include <optional>
#include <string>
#include <vector>

#include "json.hpp"

namespace premation::scene::physics {

struct BodyConfig {
  std::string kind = "dynamic";  ///< "static" | "dynamic"
  std::string shape = "box";     ///< "circle" | "box"
  double mass = 1;
  double restitution = 0.4;
  double friction = 0.2;
  double damping = 0.999;
  bool rotate = false;
};

struct Bounds {
  double left = 0, top = 0, right = 0, bottom = 0;
};

struct World {
  double gravityX = 0;
  double gravityY = 1800;
  std::optional<Bounds> bounds;
  double iterations = 4;
};

struct BodySeed {
  std::string id;
  double x = 0, y = 0;
  double rotation = 0;  ///< degrees
  double width = 100, height = 100;
  BodyConfig cfg;
};

struct Pose {
  double x = 0, y = 0;
  std::optional<double> rotation;  ///< degrees; only for bodies that spin
};

/// readNodePhysics: `{...DEFAULT_PHYSICS_BODY, ...fx.__physics}` of the first
/// component that carries one, or nullopt when absent / disabled.
[[nodiscard]] std::optional<BodyConfig> read_physics(const js::Json& raw);

/// physicsPosesAt: the simulated poses at `frame` keyed by id (static bodies
/// omitted). Histories are cached process-wide by their signature (the seeds,
/// the world and the rate), so playback steps each frame once.
[[nodiscard]] std::map<std::string, Pose> poses_at(const std::vector<BodySeed>& seeds, const World& world, double fps,
                                                   double frame);

}  // namespace premation::scene::physics
