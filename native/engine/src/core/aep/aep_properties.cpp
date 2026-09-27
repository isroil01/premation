#include "core/aep/aep_properties.hpp"

#include <algorithm>
#include <cmath>
#include <map>
#include <optional>

#include "core/aep/aep_text.hpp"

namespace premation::doc::aep {

namespace {

constexpr std::string_view kGroupEnd = "ADBE Group End";
/// AE's "this property was never renamed" display-name sentinel.
constexpr std::string_view kUnnamed = "-_0_/-";
constexpr int kControlType2dPoint = 6;

bool value_list_type(std::string_view t) {
  return t == "tdbs" || t == "tdgp" || t == "sspc" || t == "om-s" || t == "otst" || t == "btds" || t == "omks";
}

// ── Stored units vs AE's units ──────────────────────────────────────────

/// How to rescale each dimension (keyframe SPEEDS move with it), or empty for "as stored".
std::vector<double> unit_scale(std::string_view matchName, const PropertyContext& ctx) {
  if (matchName == "ADBE Opacity" || matchName == "ADBE Scale" || matchName == "ADBE Mask Opacity") return {100, 100, 100, 100};
  if (matchName == "ADBE Anchor Point" && ctx.hasSource) return {ctx.layerWidth, ctx.layerHeight, ctx.layerWidth};
  return {};
}

std::vector<double> apply_scale(const std::vector<double>& values, const std::vector<double>& scale) {
  std::vector<double> out;
  out.reserve(values.size());
  for (std::size_t i = 0; i < values.size(); ++i) {
    const double s = i < scale.size() ? scale[i] : (scale.empty() ? 1 : scale.back());
    out.push_back(values[i] * s);
  }
  return out;
}

/// ARGB 0–255 → RGBA 0–1 (what AE's scripting reports, and every colour here).
std::vector<double> to_rgba(const std::vector<double>& argb) {
  if (argb.size() != 4) return argb;
  return {argb[1] / 255, argb[2] / 255, argb[3] / 255, argb[0] / 255};
}

// ── tdb4 ─────────────────────────────────────────────────────────────────

struct Tdb4 {
  std::size_t dimensions = 1;
  bool isSpatial = false, isColor = false, isInteger = false, animated = false;
  bool hasExpression = false, expressionDisabled = false;
};

Tdb4 read_tdb4(const Chunk* chunk) {
  const Reader r = reader_for(chunk);
  Tdb4 t;
  t.dimensions = std::max<std::size_t>(1, std::min<std::size_t>(16, r.u16(2)));
  t.isSpatial = r.bit(5, 3);
  t.isColor = r.bit(59, 0);
  t.isInteger = r.bit(59, 2);
  t.animated = r.u8(68) != 0;
  t.hasExpression = r.bit(120, 0);
  t.expressionDisabled = r.bit(119, 0);
  return t;
}

// ── Keyframes ────────────────────────────────────────────────────────────

enum class KfShape : std::uint8_t { scalar, spatial, color, no_value, shape, other };
struct KfLayout {
  KfShape kind = KfShape::other;
  std::size_t dims = 0;
};

/// The per-item layout from `lhd3`'s item size plus the spatial flag (listed, not derived).
KfLayout keyframe_shape(std::uint32_t itemSize, bool isSpatial) {
  switch (itemSize) {
    case 152: return {KfShape::color, 0};
    case 128: return isSpatial ? KfLayout{KfShape::spatial, 3} : KfLayout{KfShape::scalar, 3};  // the collision
    case 104: return {KfShape::spatial, 2};
    case 88: return {KfShape::scalar, 2};
    case 80: return {KfShape::scalar, 1};  // orientation: one value + a trailing block
    case 64: return {KfShape::no_value, 0};
    case 48: return {KfShape::scalar, 1};
    case 8: return {KfShape::shape, 0};
    default: return {KfShape::other, 0};
  }
}

Interp interp_of(std::uint32_t raw) {
  if (raw == 2) return Interp::bezier;
  if (raw == 3) return Interp::hold;
  return Interp::linear;
}

std::vector<double> slice(const std::vector<double>& d, std::size_t from, std::size_t to) {
  from = std::min(from, d.size());
  to = std::min(std::max(to, from), d.size());
  return {d.begin() + static_cast<std::ptrdiff_t>(from), d.begin() + static_cast<std::ptrdiff_t>(to)};
}

std::optional<AepKeyframe> read_keyframe(const Reader& r, std::size_t at, const KfLayout& shape, double timebase) {
  AepKeyframe kf;
  kf.time = static_cast<double>(r.i32(at)) / timebase;
  kf.inInterp = interp_of(r.u8(at + 4));
  kf.outInterp = interp_of(r.u8(at + 5));
  const std::uint32_t flags = r.u8(at + 7);
  kf.temporalContinuous = (flags & (1U << 3U)) != 0;
  kf.temporalAutoBezier = (flags & (1U << 4U)) != 0;
  kf.roving = (flags & (1U << 5U)) != 0;
  const std::size_t payload = at + 8;
  switch (shape.kind) {
    case KfShape::color: {
      const std::vector<double> d = r.f64s(payload, 18);
      kf.value = {d[6], d[7], d[8], d[9]};
      kf.inSpeed = {d[2]};
      kf.inInfluence = {d[3]};
      kf.outSpeed = {d[4]};
      kf.outInfluence = {d[5]};
      return kf;
    }
    case KfShape::no_value: {
      const std::vector<double> d = r.f64s(payload, 6);
      kf.inSpeed = {d[2]};
      kf.inInfluence = {d[3]};
      kf.outSpeed = {d[4]};
      kf.outInfluence = {d[5]};
      return kf;
    }
    case KfShape::spatial: {
      const std::size_t n = shape.dims;
      const std::uint32_t spatialFlags = r.u8(payload + 3);
      const std::vector<double> d = r.f64s(payload + 8, 5 + 3 * n);
      kf.spatialAutoBezier = (spatialFlags & (1U << 1U)) != 0;
      kf.spatialContinuous = (spatialFlags & 1U) != 0;
      kf.value = slice(d, 5, 5 + n);
      // ONE ease for the whole spatial property (a motion path has one speed graph), repeated per axis.
      kf.inSpeed.assign(n, d[1]);
      kf.inInfluence.assign(n, d[2]);
      kf.outSpeed.assign(n, d[3]);
      kf.outInfluence.assign(n, d[4]);
      kf.inTangent = slice(d, 5 + n, 5 + 2 * n);
      kf.outTangent = slice(d, 5 + 2 * n, 5 + 3 * n);
      return kf;
    }
    case KfShape::scalar: {
      const std::size_t n = shape.dims;
      const std::vector<double> d = r.f64s(payload, 5 * n);
      kf.value = slice(d, 0, n);
      kf.inSpeed = slice(d, n, 2 * n);
      kf.inInfluence = slice(d, 2 * n, 3 * n);
      kf.outSpeed = slice(d, 3 * n, 4 * n);
      kf.outInfluence = slice(d, 4 * n, 5 * n);
      return kf;
    }
    default: return std::nullopt;
  }
}

struct KeyframeList {
  std::uint32_t count = 0;
  std::uint32_t itemSize = 0;
  const Chunk* data = nullptr;
};

std::optional<KeyframeList> read_keyframe_list(const Chunk* list) {
  const Chunk* header = find_chunk(list, "lhd3");
  if (header == nullptr) return std::nullopt;
  const Reader r = reader_for(header);
  return KeyframeList{r.u16(10), r.u16(18), find_chunk(list, "ldat")};
}

std::vector<AepKeyframe> read_keyframes(const Chunk* list, bool isSpatial, const PropertyContext& ctx) {
  std::vector<AepKeyframe> out;
  const auto meta = read_keyframe_list(list);
  if (!meta || meta->data == nullptr || meta->count == 0 || meta->itemSize == 0) return out;
  const KfLayout shape = keyframe_shape(meta->itemSize, isSpatial);
  if (shape.kind == KfShape::other || shape.kind == KfShape::shape) return out;
  const Reader r = reader_for(meta->data);
  const double timebase = ctx.timebase > 0 ? ctx.timebase : 24576;
  for (std::uint32_t i = 0; i < meta->count; ++i) {
    const std::size_t at = std::size_t{i} * meta->itemSize;
    if (!r.has(at, meta->itemSize)) break;  // truncated tail — keep what is whole
    if (auto kf = read_keyframe(r, at, shape, timebase)) out.push_back(std::move(*kf));
  }
  // AE writes them in order; a hand-edited file need not.
  std::stable_sort(out.begin(), out.end(), [](const AepKeyframe& a, const AepKeyframe& b) { return a.time < b.time; });
  return out;
}

// ── Shapes ───────────────────────────────────────────────────────────────

/// A mask outline: vertices normalised to the `shph` box, the box a fraction of the layer.
std::optional<AepShape> read_shape(const Chunk* shap, const PropertyContext& ctx) {
  if (shap == nullptr) return std::nullopt;
  const Reader header = reader_for(find_chunk(shap, "shph"));
  const auto meta = read_keyframe_list(find_list(shap, "list"));
  if (!meta || meta->data == nullptr) return std::nullopt;
  const std::uint32_t flags = header.u8(3);
  const bool normalised = (flags & 1U) != 0;
  const bool closed = (flags & (1U << 3U)) == 0;
  const double left = header.f32(4);
  const double top = header.f32(8);
  const double right = header.f32(12);
  const double bottom = header.f32(16);
  const Reader r = reader_for(meta->data);
  struct P {
    double x, y;
  };
  std::vector<P> points;
  const double sx = ctx.layerWidth != 0 ? ctx.layerWidth : 1;
  const double sy = ctx.layerHeight != 0 ? ctx.layerHeight : 1;
  for (std::uint32_t i = 0; i < meta->count; ++i) {
    const std::size_t at = std::size_t{i} * 8;
    if (!r.has(at, 8)) break;
    const double x = r.f32(at);
    const double y = r.f32(at + 4);
    points.push_back(normalised ? P{(left + x * (right - left)) * sx, (top + y * (bottom - top)) * sy} : P{x * sx, y * sy});
  }
  if (points.size() < 3) return std::nullopt;
  const std::size_t count = closed ? points.size() / 3 : (points.size() + 2) / 3;
  AepShape shape;
  shape.closed = closed;
  for (std::size_t k = 0; k < count; ++k) {
    if (k * 3 >= points.size()) break;
    const P vertex = points[k * 3];
    const P out = k * 3 + 1 < points.size() ? points[k * 3 + 1] : vertex;
    // The in-control of vertex k is the third point of the PREVIOUS triple; for
    // the first vertex of a closed path, the very last point.
    std::optional<std::size_t> inIndex;
    if (k == 0) {
      if (closed) inIndex = points.size() - 1;
    } else {
      inIndex = k * 3 - 1;
    }
    const P incoming = inIndex && *inIndex < points.size() ? points[*inIndex] : vertex;
    shape.vertices.push_back({vertex.x, vertex.y, incoming.x - vertex.x, incoming.y - vertex.y, out.x - vertex.x, out.y - vertex.y});
  }
  return shape;
}

// ── Leaves ───────────────────────────────────────────────────────────────

std::optional<std::string> display_name(const Chunk* parent) {
  const Chunk* tdsn = find_chunk(parent, "tdsn");
  std::string text = chunk_text(find_chunk(tdsn, "Utf8"));
  if (text.empty() || text == kUnnamed) return std::nullopt;
  return text;
}

AepProp empty_leaf(const std::string& matchName, std::size_t dims) {
  AepProp p;
  p.matchName = matchName;
  p.dimensions = dims;
  return p;
}

AepProp read_leaf(const std::string& matchName, const Chunk& tdbs, const PropertyContext& ctx) {
  const Tdb4 meta = read_tdb4(find_chunk(&tdbs, "tdb4"));
  const Reader r = reader_for(find_chunk(&tdbs, "cdat"));
  const std::vector<double> raw = r.f64s(0, std::min(meta.dimensions, r.length() / 8));
  std::vector<AepKeyframe> keyframes = read_keyframes(find_list(&tdbs, "list"), meta.isSpatial, ctx);
  const std::string expression = meta.hasExpression ? chunk_text(find_chunk(&tdbs, "Utf8")) : std::string();

  const std::vector<double> scale = unit_scale(matchName, ctx);
  auto convert = [&](const std::vector<double>& values) {
    std::vector<double> scaled = scale.empty() ? values : apply_scale(values, scale);
    return meta.isColor ? to_rgba(scaled) : scaled;
  };
  const std::vector<double> value = convert(raw);
  if (!scale.empty()) {
    for (AepKeyframe& kf : keyframes) {
      kf.value = convert(kf.value);
      // A speed is value-units per second: scaling the value alone flattens every ease.
      kf.inSpeed = apply_scale(kf.inSpeed, scale);
      kf.outSpeed = apply_scale(kf.outSpeed, scale);
    }
  } else if (meta.isColor) {
    for (AepKeyframe& kf : keyframes) kf.value = to_rgba(kf.value);
  }

  AepProp p;
  p.matchName = matchName;
  p.name = display_name(&tdbs);
  p.dimensions = meta.dimensions;
  p.isColor = meta.isColor;
  p.isSpatial = meta.isSpatial;
  p.isInteger = meta.isInteger;
  p.animated = meta.animated || !keyframes.empty();
  // A keyframed property's `cdat` is the value at the current time; consumers that see keyframes use them.
  p.value = !value.empty() ? value : (!keyframes.empty() ? keyframes[0].value : std::vector<double>{});
  p.keyframes = std::move(keyframes);
  if (!expression.empty()) p.expression = expression;
  p.expressionEnabled = meta.hasExpression && !meta.expressionDisabled;
  return p;
}

/// A mask/path property: `om-s` wraps the `tdbs` metadata and an `omks` list of `shap` outlines.
AepProp read_outline(const std::string& matchName, const Chunk& oms, const PropertyContext& ctx) {
  const Chunk* tdbs = find_list(&oms, "tdbs");
  AepProp base = tdbs != nullptr ? read_leaf(matchName, *tdbs, ctx) : empty_leaf(matchName, 1);
  const std::vector<const Chunk*> shapes = find_lists(find_list(&oms, "omks"), "shap");
  if (!shapes.empty()) {
    if (auto s = read_shape(shapes[0], ctx)) base.shape = std::move(*s);
  }
  if (shapes.size() > 1 && ctx.warnings != nullptr) {
    // An animated outline: the first shape comes across, the animation does not (yet).
    ctx.warnings->push_back("\"" + matchName + "\" has an animated outline; the first shape was imported and the rest dropped");
  }
  return base;
}

/// 3-D orientation: `otst` keeps the metadata in a nested `tdbs` and values in `otky`/`otda`.
AepProp read_orientation(const std::string& matchName, const Chunk& otst, const PropertyContext& ctx) {
  const Chunk* tdbs = find_list(&otst, "tdbs");
  AepProp base = tdbs != nullptr ? read_leaf(matchName, *tdbs, ctx) : empty_leaf(matchName, 3);
  if (base.value.empty()) {
    if (const Chunk* otda = find_chunk(find_list(&otst, "otky"), "otda")) base.value = reader_for(otda).f64s(0, 3);
  }
  base.dimensions = 3;
  return base;
}

/// A text property: `btds` holds the metadata plus the COS document.
AepProp read_text_property(const std::string& matchName, const Chunk& btds, const PropertyContext& ctx) {
  const Chunk* tdbs = find_list(&btds, "tdbs");
  AepProp base = tdbs != nullptr ? read_leaf(matchName, *tdbs, ctx) : empty_leaf(matchName, 1);
  const Chunk* btdk = find_list(&btds, "btdk");
  if (btdk != nullptr && btdk->hasBody) {
    if (auto doc = read_text_document(btdk->body)) {
      base.text = std::move(*doc);
    } else if (ctx.warnings != nullptr) {
      ctx.warnings->push_back("the text of \"" + matchName + "\" could not be read");
    }
  }
  return base;
}

struct ParamDef {
  std::string label;
  int controlType = 0;
};

/// `parT` → match name ▸ label and `PF_ParamType` (a `pard`: type at byte 15, 32-byte name at 16).
std::map<std::string, ParamDef, std::less<>> read_param_definitions(const Chunk* parT) {
  std::map<std::string, ParamDef, std::less<>> out;
  std::optional<std::string> pending;
  if (parT == nullptr) return out;
  for (const Chunk& child : parT->children) {
    if (child.id == "tdmn") {
      pending = chunk_text(&child);
      continue;
    }
    if (child.id == "pard" && pending && !pending->empty()) {
      const Reader r = reader_for(&child);
      out.insert_or_assign(*pending, ParamDef{r.str(16, 32), static_cast<int>(r.u8(15))});
      pending.reset();
    }
  }
  return out;
}

AepProp read_effect(const std::string& matchName, const Chunk& sspc, const PropertyContext& ctx) {
  const Chunk* inner = find_list(&sspc, "tdgp");
  AepProp group;
  if (inner != nullptr) {
    group = read_group(*inner, ctx, matchName);
  } else {
    group.isGroup = true;
    group.matchName = matchName;
  }
  const std::string name = chunk_text(find_chunk(find_chunk(&sspc, "fnam"), "Utf8"));
  const auto defs = read_param_definitions(find_list(&sspc, "parT"));
  for (AepProp& child : group.children) {
    const auto it = defs.find(child.matchName);
    if (it == defs.end()) continue;
    const ParamDef& def = it->second;
    if (!def.label.empty() && !child.name) child.name = def.label;
    if (child.isGroup) continue;
    child.controlType = def.controlType;
    // A point parameter is a fraction of the layer, not a pixel coordinate.
    if (def.controlType == kControlType2dPoint) {
      const std::vector<double> scale{ctx.layerWidth, ctx.layerHeight};
      child.value = apply_scale(child.value, scale);
      for (AepKeyframe& kf : child.keyframes) {
        kf.value = apply_scale(kf.value, scale);
        kf.inSpeed = apply_scale(kf.inSpeed, scale);
        kf.outSpeed = apply_scale(kf.outSpeed, scale);
        if (kf.inTangent) kf.inTangent = apply_scale(*kf.inTangent, scale);
        if (kf.outTangent) kf.outTangent = apply_scale(*kf.outTangent, scale);
      }
    }
  }
  group.matchName = matchName;
  if (!name.empty()) group.name = name;
  return group;
}

std::optional<AepProp> read_member(const std::string& matchName, const Chunk& value, const PropertyContext& ctx) {
  const std::string& t = value.listType;
  if (t == "tdbs") return read_leaf(matchName, value, ctx);
  if (t == "tdgp") return read_group(value, ctx, matchName);
  if (t == "sspc") return read_effect(matchName, value, ctx);
  if (t == "om-s") return read_outline(matchName, value, ctx);
  if (t == "otst") return read_orientation(matchName, value, ctx);
  if (t == "btds") return read_text_property(matchName, value, ctx);
  return std::nullopt;  // view state and per-panel data: importing none of it is correct
}

}  // namespace

AepProp read_group(const Chunk& list, const PropertyContext& ctx, const std::string& matchName) {
  AepProp g;
  g.isGroup = true;
  g.matchName = matchName;
  g.name = display_name(&list);
  std::optional<std::string> pending;
  for (const Chunk& child : list.children) {
    if (child.id == "tdmn") {
      std::string name = chunk_text(&child);
      if (name == kGroupEnd) break;
      pending = std::move(name);
      continue;
    }
    if (!pending) continue;
    // Not every chunk between a name and its value is the value (a mask's `mkif`).
    if (child.listType.empty() || !value_list_type(child.listType)) continue;
    if (auto node = read_member(*pending, child, ctx)) g.children.push_back(std::move(*node));
    pending.reset();
  }
  return g;
}

std::vector<GroupMember> group_members(const Chunk& list) {
  std::vector<GroupMember> out;
  std::optional<std::string> pending;
  std::vector<const Chunk*> between;
  for (const Chunk& child : list.children) {
    if (child.id == "tdmn") {
      std::string name = chunk_text(&child);
      if (name == kGroupEnd) break;
      pending = std::move(name);
      between.clear();
      continue;
    }
    if (!pending) continue;
    if (child.listType.empty() || !value_list_type(child.listType)) {
      between.push_back(&child);
      continue;
    }
    out.push_back(GroupMember{*pending, between, &child});
    pending.reset();
    between.clear();
  }
  return out;
}

}  // namespace premation::doc::aep
