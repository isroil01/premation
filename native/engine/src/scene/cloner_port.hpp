// Cloners for the scene builder (D2w time / comp): one layer laid out many
// times, shaped by effectors — the TypeScript it ports:
//
//   src/core/scene/cloner.ts        clonerPlan (linear / grid / radial, step,
//                                   hashed random, order and layer falloff, push)
//   src/core/scene/clonerExpand.ts  expandCloners (a cloner's subtree replaced by
//                                   its clones, ids `<cloner>~c<i>::…`, the offset
//                                   on the clone root, animation from the source)
//   buildSnapshot.ts                fieldOf (the driving layer in the cloner's
//                                   frame, raw graph), the offset applied to the
//                                   resolved transform and opacity, and the
//                                   cascade (a clone's animation runs behind).
//
// `mode: 'path'` (clones along another layer's outline) needs mergePaths'
// nodeWorldOutline, not in the port: such a cloner is reported and expanded as
// the TypeScript does with no usable path (the linear arrangement).
#pragma once

#include <string>
#include <vector>

#include "comp_instance.hpp"
#include "raw_world.hpp"

namespace premation::scene {


/// `expandCloners(nodes, fieldOf, pathOf)` over the walk's nodes: rewrites
/// `w.nodes`, records the clones' sources and root offsets. `unported` gets
/// (cloner id, feature) for what the port leaves out.
void expand_cloners(WalkNodes& w, RawWorld& raw, std::vector<std::pair<std::string, std::string>>& unported);

}  // namespace premation::scene
