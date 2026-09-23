#include "handlers_strokes.hpp"

#include "strokes.hpp"

namespace premation::doc {

ResultOf<api::RemoveStroke> handle(const api::RemoveStroke& c, HCtx& x) {
  (void)require_layer(x.d, c.layer);
  const auto apply = plan_remove_stroke(x.d, c.layer, static_cast<double>(c.index));
  x.label = "Remove Stroke " + std::to_string(static_cast<std::uint64_t>(c.index) + 1);
  apply();
  return {};
}

}  // namespace premation::doc
