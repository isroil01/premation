// A particle emitter's keyframeable numbers and colours as catalog properties
// (B3z-a worker E1) — the C++ port of src/core/engine/particleProps.ts
// (ENGINE_API.md §15.9). The key lists are particleSim.ts PARTICLE_NUMERIC_KEYS /
// PARTICLE_COLOR_KEYS, generated into the catalog data (`fields.particle`).
//
//   layer/particle.<key>    scalar, keys on `particle.<key>`, static fx.particle[key]
//   layer/particle.<color>  colour, keys on `particle.<color>_r/_g/_b/_a`, static hex fx.particle[color]
#pragma once

#include <functional>
#include <optional>
#include <string>
#include <string_view>

#include "model.hpp"
#include "props.hpp"

namespace premation::doc {

/// The emitter's bindings (numbers, then colours); `claimed(member)` skips a member already bound.
void add_particle_bindings(const Node& node, const std::function<void(PropBinding)>& add,
                           const std::function<bool(std::string_view)>& claimed);
/// `particle.<key>`'s static number (stored, else the emitter default); nullopt when not one (or no number).
[[nodiscard]] std::optional<double> read_particle_static(const Node& node, std::string_view member);
/// Store `particle.<key>`: nullopt when `member` is not a particle number; false without a config.
[[nodiscard]] std::optional<bool> write_particle_static(Document& d, std::string_view nodeId, std::string_view member,
                                                        double value);
/// The hex at colour base `particle.<color>` (an unset Mid reads as Birth); nullopt when not one.
[[nodiscard]] std::optional<std::string> read_particle_color(const Node& node, std::string_view base);
/// Store colour base `particle.<color>` := hex: nullopt when not one; false without a config.
[[nodiscard]] std::optional<bool> write_particle_color(Document& d, std::string_view nodeId, std::string_view base,
                                                       const std::string& hex);

}  // namespace premation::doc
