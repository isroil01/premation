// D1's exit (docs/NATIVE_CORE_PLAN.md §5): replayed sessions produce identical
// evaluated values to the TypeScript engine — in process, no engine binary,
// no Dawn.
//
// tests/data/d1_eval_parity.bin is written by the TypeScript engine
// (src/core/engine/__tests__/d1EvalParity.test.ts, GEN_NATIVE_D1=1): every
// replay-corpus session's requests and responses, then PROBES of the finished
// document — property trees, every numeric property evaluated and
// pre-expression at twelve composition times, world transforms (parenting),
// motion paths, dense samples with speed of every animated property, and
// keyframes. Each session is replayed into a fresh Session here and every
// response is compared BYTE FOR BYTE with the TypeScript's (seq and revision
// zeroed; refusals by error code only — messages are each engine's own), and
// every revision step.
//
// The gap is reported per session (D1_VERBOSE=1 prints every difference) and
// ratcheted: kMaxMismatches may only go down.

#include <catch2/catch_test_macros.hpp>

#include "parity_fixture.hpp"

namespace {

/// Differences (request outcomes + probes) the C++ engine may still show. Only goes down.
constexpr std::size_t kMaxMismatches = 0;

}  // namespace

TEST_CASE("D1: replayed sessions evaluate identically to the TypeScript engine", "[d1][parity]") {
  // D1_FIXTURE=<GEN_NATIVE_D1_FULL file> explains each difference with both values.
  const Fixture fx = load_fixture("d1_eval_parity.bin", "D1_FIXTURE");
  CHECK(run_parity("D1 eval parity", fx, "premation-d1-eval-parity", "D1_VERBOSE") <= kMaxMismatches);
}
