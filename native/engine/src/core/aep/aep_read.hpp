// Chunk tree → AepProject (src/core/aep/aepRead.ts).
//
// `LIST Fold` is the root folder; each `LIST Item` is a folder (idta type 1),
// a composition (4) or footage (7), and a folder's contents are another
// `LIST Sfdr`. Two passes: every footage and comp SIZE first (a layer's mask
// vertices, anchor and effect points are fractions of its source's size, and a
// source can be declared after the comp using it), then the layers.
//
// `DLay` / `SLay` look exactly like layers and are the comp viewer's own
// cameras: only `Layr` is a layer. Nothing here interprets — units, axes and
// names stay AE's (aep_plan.cpp translates).
#pragma once

#include "core/aep/aep_model.hpp"
#include "core/aep/riff.hpp"

namespace premation::doc::aep {

/// `readAepProject(root)`. Never throws: an unreadable part becomes a warning.
[[nodiscard]] AepProject read_aep_project(const Chunk& root);

}  // namespace premation::doc::aep
