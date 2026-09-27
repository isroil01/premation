// What a text layer says (src/core/aep/aepText.ts).
//
// The `btdk` COS document, for the parts that matter:
//
//     root
//       /0                       the RESOURCE dictionary
//         /1 /0 [ … ]              the font table
//       /1                       the DOCUMENT
//         /1 [0] /0
//           /0                     the text itself
//           /5 …                   paragraph styles
//           /6 …                   character styles
//
// A character style's `/0` indexes the font table, `/1` is the size, `/53` the
// fill paint (`[alpha, r, g, b]`). Deliberately partial: the string, font,
// size, fill, justification, tracking, leading, faux bold/italic — and a run
// count so a mixed-style layer is reported rather than silently flattened.
#pragma once

#include <optional>

#include "core/aep/aep_model.hpp"
#include "core/aep/riff.hpp"

namespace premation::doc::aep {

/// `readTextDocument`: nullopt when the blob holds no text at all. Never throws.
[[nodiscard]] std::optional<AepTextDocument> read_text_document(Bytes btdk);

}  // namespace premation::doc::aep
