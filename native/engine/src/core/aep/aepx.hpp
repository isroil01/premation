// `.aepx` — the XML form of the same project (src/core/aep/aepx.ts).
//
// AE's "Save a Copy as XML" writes the SAME chunk tree, transcribed: a leaf is
// `<idta bdata="0004…"/>` with its body in hex, a `LIST` is an element named
// after its list type, a `Utf8` chunk is `<string>Comp 1</string>`, and the
// `Egg!` form is `<AfterEffectsProject>`. So this is a second front end onto
// aep_read.cpp producing the identical ChunkTree.
//
// A hand-rolled scanner, not an XML library: it knows elements, attributes,
// CDATA, comments, processing instructions and declarations; it resolves only
// the five predefined entities and numeric references; it never interprets a
// DOCTYPE (no external entities — no XXE) and never opens anything.
#pragma once

#include <string_view>

#include "core/aep/riff.hpp"

namespace premation::doc::aep {

/// `parseAepx`: the root as `RIFX` / `Egg!`, bodies owned by the tree. Throws EngineFail(decode).
[[nodiscard]] ChunkTree parse_aepx(std::string_view xml);

}  // namespace premation::doc::aep
