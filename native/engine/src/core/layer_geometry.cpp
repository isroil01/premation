#include "layer_geometry.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <limits>
#include <string>
#include <utility>
#include <vector>

#include "anim.hpp"
#include "fail.hpp"
#include "scene.hpp"
#include "scene/session_hooks.hpp"
#include "timeline.hpp"

namespace premation::doc {
namespace {

using api::ErrorCode;
using Values = std::vector<std::pair<std::string, double>>;

/// geometry.ts `isDrawableKind`.
bool is_drawable_kind(const std::string& kind) {
  if (kind.find('.') != std::string::npos) return true;
  return kind == "shape" || kind == "text" || kind == "image" || kind == "video" || kind == "svg" || kind == "light" ||
         kind == "camera" || kind == "particle" || kind == "comp" || kind == "null" || kind == "group";
}

std::optional<double> value_of(const Values& av, std::string_view k) {
  for (const auto& [prop, v] : av) {
    if (prop == k) return v;
  }
  return std::nullopt;
}

/// geometry.ts `animatedPropsOf` at `seconds` (the node's keyframe axis).
Values animated_at(const SpaceCtx& c, std::string_view node, double seconds) {
  const NodeAnim* a = c.d.anim(node);
  if (a == nullptr || a->empty()) return {};
  return anim_evaluate_node(c.d, c.expr, c.cache, node, comp_to_keyframe_time(c.d, c.view, node, seconds));
}

/// The layer's composition size (geometry.ts reads the active comp; the layer's own is the one it is drawn in).
std::pair<double, double> comp_size_of(const Document& d, std::string_view node) {
  if (const auto comp = comp_of_layer(d, node)) {
    if (const Json* rec = d.comp(*comp)) {
      const double w = rec->at("width").is_number() && rec->at("width").num() != 0 ? rec->at("width").num() : 1920;
      const double h = rec->at("height").is_number() && rec->at("height").num() != 0 ? rec->at("height").num() : 1080;
      return {w, h};
    }
  }
  return {1920, 1080};
}

/// buildSnapshot.ts SIZE, keyed by RENDER kind (an svg renders as an image).
std::pair<double, double> kind_size(const std::string& kind, double compW, double compH) {
  if (kind == "light" || kind == "camera") return {48, 48};
  if (kind == "particle") return {140, 140};
  if (kind == "null") return {60, 60};
  if (kind == "group") return {280, 280};
  if (kind == "comp") return {compW, compH};
  if (kind == "svg" || kind == "image") return {280, 180};
  if (kind == "shape") return {220, 220};
  if (kind == "text") return {320, 80};
  if (kind == "video") return {480, 270};
  return {100, 100};
}

bool name_is_round(const std::string& name) {
  std::string lower = name;
  for (char& ch : lower) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
  return lower.find("circle") != std::string::npos || lower.find("ellip") != std::string::npos ||
         lower.find("dot") != std::string::npos || lower.find("orb") != std::string::npos;
}

std::optional<LayerGeometry> geometry(const SpaceCtx& c, TextQueries* text, const Node& n, double seconds, int depth);

/// geometry.ts `groupContentBounds(node, depth, live = true)` at `seconds`.
struct Box {
  double minX, minY, maxX, maxY;
};
std::optional<Box> group_union(const SpaceCtx& c, TextQueries* text, const Node& n, double seconds, int depth) {
  if (depth > 16) return std::nullopt;  // cycle guard
  if (n.children.empty()) return std::nullopt;
  constexpr double kInf = std::numeric_limits<double>::infinity();
  Box b{kInf, kInf, -kInf, -kInf};
  for (const std::string& id : n.children) {
    const Node* child = c.d.node(id);
    if (child == nullptr) continue;
    const auto g = geometry(c, text, *child, seconds, depth + 1);
    if (!g) continue;
    const double halfW = std::abs(g->width * g->scaleX) / 2;
    const double halfH = std::abs(g->height * g->scaleY) / 2;
    const double cx = g->x + g->offsetX * g->scaleX;
    const double cy = g->y + g->offsetY * g->scaleY;
    b.minX = std::min(b.minX, cx - halfW);
    b.minY = std::min(b.minY, cy - halfH);
    b.maxX = std::max(b.maxX, cx + halfW);
    b.maxY = std::max(b.maxY, cy + halfH);
  }
  if (!std::isfinite(b.minX) || !std::isfinite(b.minY) || !std::isfinite(b.maxX) || !std::isfinite(b.maxY)) return std::nullopt;
  return b;
}

std::optional<LayerGeometry> geometry(const SpaceCtx& c, TextQueries* text, const Node& n, double seconds, int depth) {
  const std::string kind = n.kind();
  if (!is_drawable_kind(kind)) return std::nullopt;
  const Values av = animated_at(c, n.id, seconds);

  std::optional<double> x, y, rotation, scaleX, scaleY, scale, width, height, radius;
  std::optional<std::string> shapeType;
  for (const Component& comp : n.components) {
    const Json& p = comp.props;
    if (p.at("x").is_number()) x = p.at("x").num();
    if (p.at("y").is_number()) y = p.at("y").num();
    if (p.at("rotation").is_number()) rotation = p.at("rotation").num();
    if (p.at("scaleX").is_number()) scaleX = p.at("scaleX").num();
    if (p.at("scaleY").is_number()) scaleY = p.at("scaleY").num();
    if (p.at("scale").is_number()) scale = p.at("scale").num();
    if (p.at("width").is_number()) width = p.at("width").num();
    if (p.at("height").is_number()) height = p.at("height").num();
    if (p.at("shapeType").is_string()) shapeType = p.at("shapeType").str();
    if (p.at("radius").is_number()) radius = p.at("radius").num();
    else if (p.at("outerRadius").is_number()) radius = p.at("outerRadius").num();
    else if (p.at("r").is_number()) radius = p.at("r").num();
  }
  // The evaluated values at the time win.
  for (const char* k : {"x", "y", "rotation", "scaleX", "scaleY", "scale", "width", "height"}) {
    const auto v = value_of(av, k);
    if (!v) continue;
    const std::string_view key = k;
    if (key == "x") x = v;
    else if (key == "y") y = v;
    else if (key == "rotation") rotation = v;
    else if (key == "scaleX") scaleX = v;
    else if (key == "scaleY") scaleY = v;
    else if (key == "scale") scale = v;
    else if (key == "width") width = v;
    else height = v;
  }

  // A shape's stored geometry points.
  std::optional<std::pair<double, double>> pointsBounds;
  if (kind == "shape") {
    for (const Component& comp : n.components) {
      const Json& pts = comp.props.at("points");
      if (!pts.is_array() || pts.arr().empty()) continue;
      constexpr double kInf = std::numeric_limits<double>::infinity();
      double minX = kInf, maxX = -kInf, minY = kInf, maxY = -kInf;
      for (const Json& pt : pts.arr()) {
        if (!pt.at("x").is_number() || !pt.at("y").is_number()) continue;
        minX = std::min(minX, pt.at("x").num());
        maxX = std::max(maxX, pt.at("x").num());
        minY = std::min(minY, pt.at("y").num());
        maxY = std::max(maxY, pt.at("y").num());
      }
      if (std::isfinite(minX) && std::isfinite(maxX) && std::isfinite(minY) && std::isfinite(maxY)) {
        pointsBounds = std::pair<double, double>{std::max(10.0, maxX - minX), std::max(10.0, maxY - minY)};
      }
    }
  }

  // Text sizes to its MEASURED box (the text port: fixed paragraph box, else the font box).
  std::optional<TextGeometry> measured;
  if (kind == "text") {
    if (text == nullptr) fail(ErrorCode::unsupported, "text is measured with fonts, which this engine has none of (headless)", {.layer = n.id});
    measured = text->text_geometry(n, av);
    if (!measured) fail(ErrorCode::unsupported, "this text style is outside the engine's text port", {.layer = n.id});
  }

  const auto [compW, compH] = comp_size_of(c.d, n.id);
  std::pair<double, double> size;
  if (measured) size = {measured->width, measured->height};
  else if (pointsBounds) size = *pointsBounds;
  else if (kind == "light" || kind == "camera") size = {48, 48};
  else if (radius && *radius > 0) size = {*radius * 2, *radius * 2};
  else size = kind_size(kind, compW, compH);

  const bool hasAuthoredDim = width && height && *width > 0 && *height > 0;
  double finalW = measured ? measured->width : hasAuthoredDim ? *width : pointsBounds ? pointsBounds->first : size.first;
  double finalH = measured ? measured->height : hasAuthoredDim ? *height : pointsBounds ? pointsBounds->second : size.second;
  double offsetX = 0;
  double offsetY = measured ? measured->dy : 0;

  // Full-frame solids: an unseeded solid fills the composition.
  bool isSolid = false;
  if (kind == "shape") {
    for (const Component& comp : n.components) {
      if (comp.type == "fx" && comp.props.at("solid").is_bool() && comp.props.at("solid").b()) isSolid = true;
    }
  }
  const ViewTransform vt = view_transform(n);
  double finalX = x.value_or(vt.x);
  double finalY = y.value_or(vt.y);
  if (isSolid && (!hasAuthoredDim || (*width == 100 && *height == 100))) {
    finalW = compW;
    finalH = compH;
    finalX = compW / 2;
    finalY = compH / 2;
  }

  // A group wraps its content at the time.
  if (kind == "group") {
    if (const auto b = group_union(c, text, n, seconds, depth)) {
      finalW = std::max(1.0, b->maxX - b->minX);
      finalH = std::max(1.0, b->maxY - b->minY);
      offsetX = (b->minX + b->maxX) / 2;
      offsetY = (b->minY + b->maxY) / 2;
    }
  }

  LayerGeometry g;
  g.x = finalX;
  g.y = finalY;
  g.rotationDeg = rotation.value_or(vt.rotation);
  g.width = finalW;
  g.height = finalH;
  g.scaleX = scaleX ? *scaleX : scale.value_or(1);
  g.scaleY = scaleY ? *scaleY : scale.value_or(1);
  g.ellipse = shapeType ? *shapeType == "ellipse" : name_is_round(n.name);
  g.offsetX = offsetX;
  g.offsetY = offsetY;
  return g;
}

}  // namespace

std::optional<LayerGeometry> layer_geometry_at(const SpaceCtx& c, TextQueries* text, std::string_view node, double seconds) {
  const Node* n = c.d.node(node);
  if (n == nullptr) return std::nullopt;
  return geometry(c, text, *n, seconds, 0);
}

}  // namespace premation::doc
