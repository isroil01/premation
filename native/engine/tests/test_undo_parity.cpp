// F2's undo parity suite (docs/NATIVE_CORE_PLAN.md §5 Phase F): the engine
// owns the document and undo, so the C++ engine's history must behave exactly
// as the TypeScript engine's — in process, no engine binary, no Dawn.
//
// tests/data/undo_parity.bin was recorded from the TypeScript engine
// (src/core/engine/__tests__/undoParity.test.ts) and is frozen data: every
// replay-corpus session with `getHistory` (labels, origins, position,
// can-undo/redo, gesture open, limit) and `getDocument` (property trees,
// keyframes, items, comps, layers, dirty flag) probed after EVERY request that
// is not a query, then a history WALK — undo/redo to both ends and past them,
// jumpToHistory to 0 / the middle / the end / past it, checkpoints, cancelled
// and committed gestures, the refusals inside a gesture, empty and round-trip
// gestures, a batch, the redo tail cleared by a new edit, the history limit,
// clearHistory — each step probed the same way. Responses are compared byte
// for byte (refusals by error code), with every revision step.
//
// UNDO_VERBOSE=1 prints every difference; UNDO_FIXTURE=<a full (unhashed)
// fixture> explains each one with both values. Ratcheted: kMaxMismatches may
// only go down. PARITY_REBLESS=1 writes the C++ responses into the fixture
// instead (parity_fixture.hpp); review the diff.

#include <catch2/catch_test_macros.hpp>

#include "parity_fixture.hpp"

namespace {

/// Differences (requests, walk steps and probes) the C++ engine may still show. Only goes down.
constexpr std::size_t kMaxMismatches = 0;

}  // namespace

TEST_CASE("F2: history walked on the replay corpus matches the TypeScript engine", "[f2][undo][parity]") {
  Fixture fx = load_fixture("undo_parity.bin", "UNDO_FIXTURE");
  if (premation::test::parity_rebless()) {
    REQUIRE(rebless_parity("F2 undo parity", fx, "premation-undo-parity"));
    return;
  }
  CHECK(run_parity("F2 undo parity", fx, "premation-undo-parity", "UNDO_VERBOSE") <= kMaxMismatches);
}
