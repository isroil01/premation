// A 256-bin histogram that answers "the k-th smallest sample" while samples
// come and go (Huang's running median): the candidate moves by the few bins an
// update shifted, so a sliding window costs O(1) amortised per query. Gives the
// same order statistic as sorting the window, which is what the TS does.
#pragma once

#include <array>
#include <cstddef>

namespace premation::effects {

struct RankHist {
  std::array<int, 256> bins{};
  int med = 0;  // current candidate
  int lt = 0;   // samples < med
  void add(int v) noexcept {
    ++bins[static_cast<std::size_t>(v)];
    if (v < med) ++lt;
  }
  void remove(int v) noexcept {
    --bins[static_cast<std::size_t>(v)];
    if (v < med) --lt;
  }
  /// The k-th smallest sample (0-based).
  int kth(int k) noexcept {
    while (lt > k) {
      --med;
      lt -= bins[static_cast<std::size_t>(med)];
    }
    while (lt + bins[static_cast<std::size_t>(med)] <= k) {
      lt += bins[static_cast<std::size_t>(med)];
      ++med;
    }
    return med;
  }
};

}  // namespace premation::effects
