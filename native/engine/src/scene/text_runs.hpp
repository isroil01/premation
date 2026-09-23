// Rich text runs for the scene builder — richText.ts `readRuns` (code-point
// runs migrated to grapheme indices) + `normalizeRuns` (disjoint, clamped,
// coalesced spans over the grapheme count of the drawn text).
#pragma once

#include <string>

#include "json.hpp"

namespace premation::scene {

/// The normalized runs of a Text component's props over `rawText`; undefined when none.
[[nodiscard]] js::Json normalize_runs(const js::Json& textProps, const std::string& rawText);

}  // namespace premation::scene
