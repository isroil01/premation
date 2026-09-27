// Realise an import plan in the document (src/core/aep/aepApply.ts), and the
// whole `.aep` / `.aepx` import behind importProject.
//
// Order is the design:
//   1. every composition first, empty — a comp layer can point at any comp;
//   2. footage, ONE import per path (a missing file keeps its layer, pointing
//      at a missing placeholder item that carries the original path);
//   3. layers, bottom of the stack first (AE's layer 1 is the top);
//   4. keyframes; 5. parenting WITHOUT world compensation (AE's transforms are
//      already parent-relative); 6. track mattes (pre-AE-23: "the layer
//      above"); 7. each layer's bar trimmed to its in/out points.
// Everything goes through the journaled Document writers inside the handler,
// so the dispatcher makes the whole import ONE undoable entry. A bad layer or
// effect costs a warning, never the import.
#pragma once

#include <optional>
#include <string>
#include <vector>

#include "core/aep/aep_plan.hpp"
#include "core/aep/riff.hpp"
#include "engine_ctx.hpp"

namespace premation::doc::aep {

struct AepApplyResult {
  /// The new folder first, then sub-folders, compositions and footage items, in creation order.
  std::vector<std::string> items;
  std::vector<std::string> warnings;
  std::vector<std::string> missingFootage;
  std::optional<std::string> openComp;
};

/// `applyAepPlan`: build `plan` into the document under a new folder named `folderName` (inside `parentFolder`).
[[nodiscard]] AepApplyResult apply_aep_plan(HCtx& x, const AepImportPlan& plan, const std::string& folderName,
                                            const std::optional<std::string>& parentFolder);

/// `parseAepBytes`: sniff XML vs RIFX by CONTENT (people rename these files). Throws EngineFail(decode).
[[nodiscard]] ChunkTree parse_aep_bytes(Bytes bytes);

/// `.aep` / `.aepx` (case-insensitive).
[[nodiscard]] bool is_aep_path(std::string_view path);

}  // namespace premation::doc::aep
