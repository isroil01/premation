// Cloners for the scene builder (D2w time / comp): one layer laid out many
// times, shaped by effectors — the TypeScript it ports:
//
//   src/core/scene/cloner.ts        clonerPlan (linear / grid / radial / path,
//                                   step, hashed random, order and layer falloff, push)
//   src/core/scene/clonerExpand.ts  expandCloners (a cloner's subtree replaced by
//                                   its clones, ids `<cloner>~c<i>::…`, the offset
//                                   on the clone root, animation from the source)
//   buildSnapshot.ts                fieldOf / pathOf (the driving layer's position
//                                   or outline in the cloner's frame, raw graph),
//                                   the offset applied to the resolved transform
//                                   and opacity, and the cascade (a clone's
//                                   animation runs behind).
#pragma once

#include "comp_instance.hpp"
#include "raw_world.hpp"

namespace premation::scene {

/// `expandCloners(nodes, fieldOf, pathOf)` over the walk's nodes: rewrites
/// `w.nodes`, records the clones' sources and root offsets.
void expand_cloners(WalkNodes& w, RawWorld& raw);

}  // namespace premation::scene
