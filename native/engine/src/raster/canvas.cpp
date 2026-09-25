#include "canvas.hpp"

#include <algorithm>
#include <cmath>
#include <functional>

namespace premation::raster {

std::optional<Mat2D> Mat2D::inverse() const noexcept {
  const double det = a * d - b * c;
  if (det == 0.0 || !std::isfinite(det)) return std::nullopt;
  const double id = 1.0 / det;
  return Mat2D{d * id, -b * id, -c * id, a * id, (c * f - d * e) * id, (b * e - a * f) * id};
}

void Gradient::add_stop(double offset, const css::Color& c) {
  // Blink keeps stops in insertion order and sorts them stably by offset when
  // the shader is built; inserting in place is the same order.
  Stop s{offset, c};
  const auto it = std::ranges::upper_bound(stops, offset, std::less<>{}, &Stop::offset);
  stops.insert(it, s);
}

Canvas2D::~Canvas2D() = default;

bool Canvas2D::setFilterString(std::string_view css) {
  const auto f = css::parse_filter_list(css);
  if (!f) return false;
  setFilter(*f);
  return true;
}

std::shared_ptr<Pattern> Canvas2D::createPattern(std::string_view repetition) const {
  auto p = std::make_shared<Pattern>();
  p->width = width();
  p->height = height();
  p->rgba = pixels();
  p->repeatX = repetition.empty() || repetition == "repeat" || repetition == "repeat-x";
  p->repeatY = repetition.empty() || repetition == "repeat" || repetition == "repeat-y";
  return p;
}

}  // namespace premation::raster
