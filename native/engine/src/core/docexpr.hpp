// The expression host over the document — the providers the editor binds into
// its AnimationEngine at boot (src/providers/Providers.tsx):
//
//   layerResolver      first node (insertion order) with that name
//   baseValueProvider  Transform first, then every other component
//   compInfo           the ACTIVE composition (EditorView.tabComp), numLayers = every node
//   layerInfo          name + Transform width/height (else the comp's)
//   controlProvider    `ctrl_<name>` on a Transform (expressionControls.ts `controlValue`)
//   sourceRect         the Transform box (text is measured by the renderer: not here)
//   layerSpace         layerSpaceAt: 2D affine, or 3D matrix + active camera (worldxf.hpp)
//   markers            the active comp's markers / the layer's bar markers (absolute)
#pragma once

#include <set>
#include <string>

#include "anim.hpp"
#include "model.hpp"
#include "timeline.hpp"
#include "worldxf.hpp"

namespace premation::doc {

class DocExprEnv final : public ExprEnv {
 public:
  DocExprEnv(const Document& d, const EditorView& view, ExprCache& cache) : d_(d), view_(view), cache_(cache) {}

  [[nodiscard]] std::optional<double> base_value(std::string_view node, std::string_view prop) const override;
  [[nodiscard]] std::optional<std::string> resolve_layer(std::u16string_view name) const override;
  [[nodiscard]] motion::expr::CompInfo comp_info() const override;
  [[nodiscard]] motion::expr::LayerInfo layer_info(std::string_view node) const override;
  [[nodiscard]] double ctrl(std::u16string_view name, double t) const override;
  [[nodiscard]] std::optional<motion::expr::SourceRect> source_rect(std::string_view node, double t,
                                                                    bool extents) const override;
  [[nodiscard]] std::vector<motion::expr::MarkerData> markers(std::string_view node,
                                                              motion::expr::MarkerScope scope) const override;
  [[nodiscard]] bool space_exists(std::string_view self, const std::u16string* name, double t) const override;
  [[nodiscard]] std::array<double, 3> space_convert(std::string_view self, const std::u16string* name, double t,
                                                    motion::expr::SpaceOp op, std::array<double, 3> p) const override;
  [[nodiscard]] std::optional<motion::expr::SourceTextSample> source_text(std::string_view node,
                                                                          double t) const override;

 private:
  [[nodiscard]] std::optional<std::string> space_node(std::string_view self, const std::u16string* name) const;
  [[nodiscard]] std::optional<LayerSpace> space_at(const std::string& id, double t) const;
  const Document& d_;
  const EditorView& view_;
  ExprCache& cache_;
  mutable std::set<std::u16string> resolving_;
};

/// UTF-8 ⇄ UTF-16 (expressions are UTF-16, the document UTF-8).
[[nodiscard]] std::u16string to_u16(std::string_view s);
[[nodiscard]] std::string to_u8(std::u16string_view s);

}  // namespace premation::doc
