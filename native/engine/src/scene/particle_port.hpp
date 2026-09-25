// Particle layers for the scene builder (D2w time / comp) — the TypeScript it ports:
//
//   src/core/particles/particleSim.ts          readNodeParticle, resolveParticleConfig,
//                                              the closed-form (ballistic) emitter with
//                                              drag, wander, trails, 3-point ramps and
//                                              death / continuous sub-emission
//   src/core/particles/statefulParticleSim.ts  the frame-stepping emitter (floor bounce,
//                                              curl turbulence, collisions, bursts)
//   src/core/particles/particleField.ts        wanderOffset, curlForce
//   src/core/particles/particleRender.ts       toSprites + drawParticleField (the Canvas2D
//                                              field AppTextureProvider.setParticles draws)
//   src/core/effects/plexus.ts                 drawPlexusLinks over the live particles
//
// The snapshot resolves the config (particle_layer_config); the frame build names
// the `particles:<id>` texture and hands this the spec; SceneTextures draws it.
#pragma once

#include <filesystem>
#include <optional>
#include <string>

#include "canvas.hpp"
#include "model.hpp"
#include "raster_source.hpp"
#include "readers.hpp"
#include "scene_types.hpp"

namespace premation::scene {

/// `readNodeParticle(node)`: the `fx.particle` object over DEFAULT_PARTICLE_CONFIG,
/// or undefined when the node is not an emitter.
[[nodiscard]] Json read_node_particle(const doc::Node& n);

/// `resolveParticleConfig(cfg, path => values.get(path))`: every numeric key's
/// `particle.<key>` track, the colours from their channel tracks.
[[nodiscard]] Json resolve_particle_config(const Json& cfg, const Values& values);

/// The field texture's spec (AppTextureProvider.setParticles' inputs).
[[nodiscard]] Json particle_field_spec(const Json& cfg, double timeSec, double fieldW, double fieldH, double transformScale,
                                       double rasterScale, double fps);

/// `drawParticleField` into a fresh canvas sized by the spec's scale. `mediaBase`
/// resolves a relative sprite source; a sprite that does not decode draws the
/// circles the TypeScript shows until its image lands.
[[nodiscard]] raster::RasterOutput draw_particle_field(const Json& spec, const raster::CanvasOptions& opts,
                                                       const std::filesystem::path& mediaBase);

/// The same field painted onto a given canvas (sized by the spec: w·scale × h·scale),
/// without a sprite image — the cross-engine fixture draws it on a recording canvas.
void paint_particle_field(raster::Canvas2D& canvas, const Json& spec);

}  // namespace premation::scene
