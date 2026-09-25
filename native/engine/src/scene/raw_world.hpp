// buildSnapshot's RAW-graph world transforms (`rawLocalOf` / `rawParentOf` /
// `rawWorldCache`): a node's pose from the document itself, evaluated at comp
// time with no clip map or layer time, composed along its real parent chain.
// The walk's own world chain (remapped, clone-aware) is a different question;
// these answer the resolvers that read the raw graph — points bound to nulls,
// the cloner's field and path drivers.
#pragma once

#include <optional>
#include <string>
#include <unordered_map>

#include "anim.hpp"
#include "model.hpp"
#include "transform.hpp"

namespace premation::scene {

using js::Json;

class RawWorld {
 public:
  RawWorld(const doc::Document& d, const doc::ExprEnv& expr, doc::ExprCache& cache, double t)
      : d_(d), expr_(expr), cache_(cache), t_(t) {}

  /// `rawLocalOf(id)` (null for a node the document does not hold).
  [[nodiscard]] std::optional<motion::xf::Local2D> local(const std::string& id);
  /// `worldMatrixOf(id, rawLocalOf, rawParentOf, rawWorldCache)` (a missing node is identity).
  [[nodiscard]] motion::xf::Mat2D world_matrix(const std::string& id);
  [[nodiscard]] const doc::Document& document() const noexcept { return d_; }

 private:
  const doc::Document& d_;
  const doc::ExprEnv& expr_;
  doc::ExprCache& cache_;
  double t_;
  std::unordered_map<std::string, motion::xf::Mat2D> world_;
};

/// buildSnapshot's POINTS FOLLOW NULLS: each bound vertex (with its handles) moved
/// to the null's world position in the shape's local space. Returns the moved
/// points, or undefined when nothing moved.
[[nodiscard]] Json bind_path_points(RawWorld& raw, const std::string& shapeId, const Json& pathPoints,
                                    const Json& bindings);

}  // namespace premation::scene
