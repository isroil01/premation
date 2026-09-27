// A tiny After Effects project writer, for tests — the C++ port of
// src/core/aep/__testHelpers__/buildAep.ts, option for option.
//
// It writes real RIFX bytes (real `cdta`, `ldta`, keyframe `ldat`) from named
// options, and every offset here is the INVERSE of one in the reader
// (core/aep/*.cpp), so the pair is a genuine round trip: a wrong offset in
// either direction fails.
#pragma once

#include <bit>
#include <cmath>
#include <cstdint>
#include <initializer_list>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace premation::test::aepb {

using Buf = std::vector<std::uint8_t>;

inline Buf concat(std::initializer_list<Buf> parts) {
  Buf out;
  for (const Buf& p : parts) out.insert(out.end(), p.begin(), p.end());
  return out;
}
inline Buf concat(const std::vector<Buf>& parts) {
  Buf out;
  for (const Buf& p : parts) out.insert(out.end(), p.begin(), p.end());
  return out;
}
inline void append(std::vector<Buf>& to, const std::vector<Buf>& more) { to.insert(to.end(), more.begin(), more.end()); }
inline Buf bytes_of(std::string_view s) { return Buf(s.begin(), s.end()); }

inline Buf fourcc(std::string_view id) {
  Buf out(4, 0x20);
  for (std::size_t i = 0; i < 4 && i < id.size(); ++i) out[i] = static_cast<std::uint8_t>(id[i]);
  return out;
}
inline Buf u32be(std::uint32_t v) {
  return {static_cast<std::uint8_t>(v >> 24U), static_cast<std::uint8_t>(v >> 16U), static_cast<std::uint8_t>(v >> 8U),
          static_cast<std::uint8_t>(v)};
}

/// A leaf chunk: id, big-endian size, body, and a pad byte when odd.
inline Buf chunk(std::string_view id, const Buf& body) {
  Buf out = concat({fourcc(id), u32be(static_cast<std::uint32_t>(body.size())), body});
  if (body.size() % 2 == 1) out.push_back(0);
  return out;
}
/// A `LIST` chunk of the given type.
inline Buf list(std::string_view type, const std::vector<Buf>& children) {
  std::vector<Buf> parts{fourcc(type)};
  append(parts, children);
  return chunk("LIST", concat(parts));
}
inline Buf utf8(std::string_view text) { return chunk("Utf8", bytes_of(text)); }
/// The 40-byte NUL-padded match name before every member.
inline Buf tdmn(std::string_view matchName) {
  Buf body(40, 0);
  for (std::size_t i = 0; i < 40 && i < matchName.size(); ++i) body[i] = static_cast<std::uint8_t>(matchName[i]);
  return chunk("tdmn", body);
}

/// A writable fixed-size big-endian record.
class Record {
 public:
  explicit Record(std::size_t size) : bytes(size, 0) {}
  Buf bytes;
  Record& u8(std::size_t at, std::uint32_t v) {
    bytes[at] = static_cast<std::uint8_t>(v);
    return *this;
  }
  Record& u16(std::size_t at, std::uint32_t v) {
    bytes[at] = static_cast<std::uint8_t>(v >> 8U);
    bytes[at + 1] = static_cast<std::uint8_t>(v);
    return *this;
  }
  Record& u32(std::size_t at, std::uint32_t v) {
    for (std::size_t i = 0; i < 4; ++i) bytes[at + i] = static_cast<std::uint8_t>(v >> (24U - 8U * i));
    return *this;
  }
  Record& i32(std::size_t at, std::int32_t v) { return u32(at, static_cast<std::uint32_t>(v)); }
  Record& f32(std::size_t at, double v) { return u32(at, std::bit_cast<std::uint32_t>(static_cast<float>(v))); }
  Record& f64(std::size_t at, double v) {
    const auto b = std::bit_cast<std::uint64_t>(v);
    for (std::size_t i = 0; i < 8; ++i) bytes[at + i] = static_cast<std::uint8_t>(b >> (56U - 8U * i));
    return *this;
  }
  Record& str(std::size_t at, std::size_t size, std::string_view text) {
    for (std::size_t i = 0; i + 1 < size && i < text.size(); ++i) bytes[at + i] = static_cast<std::uint8_t>(text[i]);
    return *this;
  }
  Record& bit(std::size_t at, unsigned b, bool on) {
    if (on) bytes[at] = static_cast<std::uint8_t>(bytes[at] | (1U << b));
    else bytes[at] = static_cast<std::uint8_t>(bytes[at] & ~(1U << b));
    return *this;
  }
};

inline std::int32_t ms(double seconds) { return static_cast<std::int32_t>(std::lround(seconds * 1000)); }

// ── Items ───────────────────────────────────────────────────────────────

inline Buf idta(std::uint32_t type, std::uint32_t id, std::uint32_t label = 0) {
  return chunk("idta", Record(84).u16(0, type).u32(16, id).u8(58, label).bytes);
}

struct CdtaOptions {
  std::uint32_t width = 200;
  std::uint32_t height = 100;
  double fps = 24;
  double durationSeconds = 10;
  std::uint32_t bg[3] = {0, 0, 0};
  std::uint32_t timebase = 24576;
  bool motionBlur = false;
  std::uint32_t shutterAngle = 180;
};

inline Buf cdta(const CdtaOptions& o) {
  Record r(204);
  const auto fpsInt = static_cast<std::uint32_t>(std::floor(o.fps));
  r.u32(8, o.timebase);
  r.u32(16, 600);
  r.u32(20, 0).u32(24, 1);           // work area start
  r.u32(28, 0xffffffffU).u32(32, 1);  // work area end: AE's "to the end" sentinel
  r.u32(44, static_cast<std::uint32_t>(std::lround(o.durationSeconds * 1000))).u32(48, 1000);
  r.u8(52, o.bg[0]).u8(53, o.bg[1]).u8(54, o.bg[2]);
  if (o.motionBlur) r.bit(139, 3, true);
  r.u16(140, o.width).u16(142, o.height);
  r.u32(144, 1).u32(148, 1);
  r.u16(156, fpsInt).u16(158, static_cast<std::uint32_t>(std::lround((o.fps - fpsInt) * 65536)));
  r.i32(164, 0).u32(168, 1);
  r.u16(174, o.shutterAngle);
  r.i32(196, 128).i32(200, 16);
  return chunk("cdta", r.bytes);
}

struct SspcOptions {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  double durationSeconds = 0;
  double frameRate = 0;
  std::string sourceFormat = "png!";
  bool missing = false;
  double sampleRate = 0;
};

inline Buf sspc(const SspcOptions& o) {
  Record r(224);
  r.str(22, 5, o.sourceFormat);
  r.u16(32, o.width).u16(36, o.height);
  r.u32(38, static_cast<std::uint32_t>(std::lround(o.durationSeconds * 1000))).u32(42, 1000);
  r.u32(56, static_cast<std::uint32_t>(std::floor(o.frameRate))).u16(60, 0);
  if (o.missing) r.u8(115, 1);
  r.u32(136, 1).u32(140, 1);
  r.f64(160, o.sampleRate);
  return chunk("sspc", r.bytes);
}

inline Buf soli_opti(double cr, double cg, double cb, std::string_view name) {
  Record r(282);
  r.str(0, 5, "Soli");
  r.u16(4, 9);
  r.f32(14, cr).f32(18, cg).f32(22, cb);
  r.str(26, 256, name);
  return chunk("opti", r.bytes);
}

inline std::string json_escape(std::string_view s) {
  std::string out;
  for (const char c : s) {
    if (c == '\\' || c == '"') out.push_back('\\');
    out.push_back(c);
  }
  return out;
}
inline Buf alas(std::string_view fullpath) {
  return list("Als2", {chunk("alas", bytes_of("{\"fullpath\":\"" + json_escape(fullpath) + "\"}"))});
}

// ── Layers ──────────────────────────────────────────────────────────────

struct LdtaOptions {
  std::uint32_t id = 1;
  std::uint32_t type = 0;  ///< 0 av, 1 light, 2 camera, 3 text, 4 shape
  std::uint32_t sourceId = 0;
  std::uint32_t parentId = 0;
  double inPoint = 0, outPoint = 0, startTime = 0;
  std::string name;
  std::uint32_t blendingMode = 2;
  std::uint32_t trackMatte = 0;
  std::uint32_t label = 0;
  bool threeD = false, solo = false, shy = false, locked = false, guide = false, adjustment = false, nullLayer = false;
  bool enabled = true, motionBlur = false;
  std::uint32_t matteLayerId = 0;
};

inline Buf ldta(const LdtaOptions& o) {
  Record r(164);
  r.u32(0, o.id);
  r.i32(8, 1);  // stretch dividend
  r.i32(12, ms(o.startTime)).u32(16, 1000);
  r.i32(20, ms(o.inPoint)).u32(24, 1000);
  r.i32(28, ms(o.outPoint)).u32(32, 1000);
  r.bit(37, 1, o.guide);
  r.bit(38, 7, o.nullLayer).bit(38, 3, o.solo).bit(38, 2, o.threeD).bit(38, 1, o.adjustment);
  r.bit(39, 6, o.shy).bit(39, 5, o.locked).bit(39, 3, o.motionBlur).bit(39, 2, true).bit(39, 1, true).bit(39, 0, o.enabled);
  r.u32(40, o.sourceId);
  r.u8(61, o.label);
  r.str(64, 32, o.name);
  r.u8(99, o.blendingMode);
  r.u8(107, o.trackMatte);
  r.u32(108, 1);  // stretch divisor
  r.u8(131, o.type);
  r.u32(132, o.parentId);
  r.u32(160, o.matteLayerId);
  return chunk("ldta", r.bytes);
}

// ── Properties ──────────────────────────────────────────────────────────

struct AeKeyframe {
  double time = 0;
  std::vector<double> value;
  std::uint32_t inInterp = 1, outInterp = 1;  ///< 1 linear, 2 bezier, 3 hold
  std::vector<double> inSpeed, inInfluence, outSpeed, outInfluence, inTangent, outTangent;
};

struct PropertyOptions {
  std::uint32_t dimensions = 1;
  bool spatial = false;
  bool color = false;
  std::optional<std::vector<double>> value;
  std::vector<AeKeyframe> keyframes;
  std::uint32_t timebase = 24576;
  std::string expressionSource;
};

inline Buf tdb4(std::uint32_t dimensions, bool spatial, bool color, bool animated, bool expression) {
  Record r(124);
  r.u16(0, 0xdb99).u16(2, dimensions);
  r.bit(5, 3, spatial);
  r.bit(59, 0, color);
  r.u8(68, animated ? 1 : 0);
  if (expression) r.bit(120, 0, true);
  return chunk("tdb4", r.bytes);
}

inline Buf cdat(const std::vector<double>& values) {
  Record r(values.size() * 8);
  for (std::size_t i = 0; i < values.size(); ++i) r.f64(i * 8, values[i]);
  return chunk("cdat", r.bytes);
}

inline double pick(const std::vector<double>& a, std::size_t d) { return d < a.size() ? a[d] : a.empty() ? 0 : a[0]; }

inline Buf keyframe_list(std::uint32_t n, bool spatial, std::uint32_t timebase, const std::vector<AeKeyframe>& kfs) {
  const std::size_t itemSize = spatial ? 8 + 8 + 5 * 8 + 3 * n * 8 : 8 + 5 * n * 8;
  Record header(52);
  header.u16(10, static_cast<std::uint32_t>(kfs.size())).u32(12, 1).u16(18, static_cast<std::uint32_t>(itemSize)).u8(23, 4).u32(24, 1).u32(28, 2);
  Record data(itemSize * kfs.size());
  for (std::size_t i = 0; i < kfs.size(); ++i) {
    const AeKeyframe& kf = kfs[i];
    const std::size_t at = i * itemSize;
    data.i32(at, static_cast<std::int32_t>(std::lround(kf.time * timebase)));
    data.u8(at + 4, kf.inInterp).u8(at + 5, kf.outInterp);
    if (spatial) {
      const std::size_t base = at + 16;
      data.f64(base, 0);
      data.f64(base + 8, pick(kf.inSpeed, 0));
      data.f64(base + 16, pick(kf.inInfluence, 0));
      data.f64(base + 24, pick(kf.outSpeed, 0));
      data.f64(base + 32, pick(kf.outInfluence, 0));
      for (std::size_t d = 0; d < n; ++d) {
        data.f64(base + 40 + d * 8, d < kf.value.size() ? kf.value[d] : 0);
        data.f64(base + 40 + (n + d) * 8, pick(kf.inTangent, d));
        data.f64(base + 40 + (2 * n + d) * 8, pick(kf.outTangent, d));
      }
    } else {
      const std::size_t base = at + 8;
      for (std::size_t d = 0; d < n; ++d) {
        data.f64(base + d * 8, d < kf.value.size() ? kf.value[d] : 0);
        data.f64(base + (n + d) * 8, pick(kf.inSpeed, d));
        data.f64(base + (2 * n + d) * 8, pick(kf.inInfluence, d));
        data.f64(base + (3 * n + d) * 8, pick(kf.outSpeed, d));
        data.f64(base + (4 * n + d) * 8, pick(kf.outInfluence, d));
      }
    }
  }
  return list("list", {chunk("lhd3", header.bytes), chunk("ldat", data.bytes)});
}

/// One leaf property: the `tdmn` naming it and the `LIST tdbs` holding it.
inline std::vector<Buf> property(std::string_view matchName, const PropertyOptions& o) {
  std::vector<Buf> children{chunk("tdsb", Buf(4, 0)),
                            tdb4(o.dimensions, o.spatial, o.color, !o.keyframes.empty(), !o.expressionSource.empty())};
  if (o.value) children.push_back(cdat(*o.value));
  if (!o.keyframes.empty()) children.push_back(keyframe_list(o.dimensions, o.spatial, o.timebase, o.keyframes));
  if (!o.expressionSource.empty()) children.push_back(utf8(o.expressionSource));
  return {tdmn(matchName), list("tdbs", children)};
}

/// A property group: its members, terminated the way AE terminates them.
inline std::vector<Buf> group(std::string_view matchName, const std::vector<Buf>& members) {
  std::vector<Buf> inner{chunk("tdsb", Buf(4, 0))};
  append(inner, members);
  inner.push_back(tdmn("ADBE Group End"));
  return {tdmn(matchName), list("tdgp", inner)};
}

struct Box {
  double left, top, right, bottom;
};

/// A mask outline: `shph` bounding box plus its normalised vertices.
inline Buf mask_shape(Box box, const std::vector<std::pair<double, double>>& points, bool closed = true) {
  Record header(24);
  header.u8(3, closed ? 1U : (1U | (1U << 3U)));
  header.f32(4, box.left).f32(8, box.top).f32(12, box.right).f32(16, box.bottom);
  Record listHeader(52);
  listHeader.u16(10, static_cast<std::uint32_t>(points.size())).u32(12, 1).u16(18, 8).u8(23, 4);
  Record data(points.size() * 8);
  for (std::size_t i = 0; i < points.size(); ++i) data.f32(i * 8, points[i].first).f32(i * 8 + 4, points[i].second);
  return list("shap", {chunk("shph", header.bytes), list("list", {chunk("lhd3", listHeader.bytes), chunk("ldat", data.bytes)})});
}

/// The 12-point unit square the TS tests use.
inline std::vector<std::pair<double, double>> unit_square() {
  return {{0, 0}, {0, 0}, {1, 0}, {1, 0}, {1, 0}, {1, 1}, {1, 1}, {1, 1}, {0, 1}, {0, 1}, {0, 1}, {0, 0}};
}

struct MaskOptions {
  std::uint32_t mode = 1;  ///< 0 none, 1 add, 2 subtract, …
  bool inverted = false;
  std::string name;
  Buf shape;
};

/// One `ADBE Mask Atom`: its `mkif` and its property group.
inline std::vector<Buf> mask(const MaskOptions& o) {
  Record info(48);
  info.u8(0, o.inverted ? 1 : 0).u16(6, o.mode).u32(8, 1);
  std::vector<Buf> inner{chunk("tdsb", Buf(4, 0))};
  if (!o.name.empty()) inner.push_back(chunk("tdsn", utf8(o.name)));
  inner.push_back(tdmn("ADBE Mask Shape"));
  inner.push_back(list("om-s", {list("tdbs", {chunk("tdsb", Buf(4, 0)), tdb4(1, false, false, false, false), cdat({0})}),
                                list("omks", {o.shape})}));
  PropertyOptions op;
  op.value = std::vector<double>{1};
  append(inner, property("ADBE Mask Opacity", op));
  PropertyOptions fe;
  fe.dimensions = 2;
  fe.value = std::vector<double>{0, 0};
  append(inner, property("ADBE Mask Feather", fe));
  inner.push_back(tdmn("ADBE Group End"));
  return {tdmn("ADBE Mask Atom"), chunk("mkif", info.bytes), list("tdgp", inner)};
}

inline Buf pard(std::string_view label, std::uint32_t controlType = 10) {
  return chunk("pard", Record(56).u8(15, controlType).str(16, 32, label).bytes);
}

struct EffectParamSpec {
  std::uint32_t index = 1;
  std::string label;
  std::uint32_t controlType = 10;
  std::optional<std::vector<double>> value;
  std::vector<AeKeyframe> keyframes;
  std::uint32_t dimensions = 0;  ///< 0 = by control type
  bool color = false;
};

inline std::string param_name(std::string_view effect, std::uint32_t index) {
  std::string n = std::to_string(index);
  while (n.size() < 4) n.insert(0, "0");
  return std::string(effect) + "-" + n;
}

/// An effect: the `sspc` wrapper, its display name, the `parT` declarations, the `tdgp` values.
inline std::vector<Buf> effect(std::string_view matchName, std::string_view displayName, const std::vector<EffectParamSpec>& params) {
  std::vector<Buf> defs{chunk("parn", Buf(4, 0))};
  std::vector<Buf> values{chunk("tdsb", Buf(4, 0))};
  for (const EffectParamSpec& p : params) {
    const std::string name = param_name(matchName, p.index);
    defs.push_back(tdmn(name));
    defs.push_back(pard(p.label, p.controlType));
    PropertyOptions po;
    po.dimensions = p.dimensions != 0 ? p.dimensions : p.controlType == 6 ? 2 : p.color ? 4 : 1;
    po.color = p.color;
    po.value = p.value;
    po.keyframes = p.keyframes;
    append(values, property(name, po));
  }
  values.push_back(tdmn("ADBE Group End"));
  return {tdmn(matchName), list("sspc", {chunk("fnam", utf8(displayName)), list("parT", defs), list("tdgp", values)})};
}

// ── Whole files ─────────────────────────────────────────────────────────

struct LayerOptions : LdtaOptions {
  std::string displayName;
  std::vector<Buf> properties;
};

inline Buf layer(const LayerOptions& o) {
  std::vector<Buf> props{chunk("tdsb", Buf(4, 0))};
  append(props, o.properties);
  props.push_back(tdmn("ADBE Group End"));
  return list("Layr", {ldta(o), utf8(o.displayName), list("tdgp", props)});
}

struct CompItemOptions : CdtaOptions {
  std::uint32_t id = 1;
  std::string name = "Main";
  std::vector<Buf> layers;
};

inline Buf comp_item(const CompItemOptions& o) {
  std::vector<Buf> parts{idta(4, o.id), utf8(o.name), cdta(o)};
  append(parts, o.layers);
  return list("Item", parts);
}

struct FootageItemOptions : SspcOptions {
  std::uint32_t id = 9;
  std::string name;
  std::string path;
  bool solid = false;
  double solidColor[3] = {0, 0, 0};
  std::string solidName;
};

inline Buf footage_item(const FootageItemOptions& o) {
  std::vector<Buf> pin{sspc(o)};
  if (!o.path.empty()) pin.push_back(alas(o.path));
  if (o.solid) pin.push_back(soli_opti(o.solidColor[0], o.solidColor[1], o.solidColor[2], o.solidName));
  return list("Item", {idta(7, o.id), utf8(o.name), list("Pin ", pin)});
}

inline Buf folder_item(std::uint32_t id, std::string_view name, const std::vector<Buf>& children) {
  return list("Item", {idta(1, id), utf8(name), list("Sfdr", children)});
}

/// The whole file: `RIFX`, its size, `Egg!`, then the chunks.
inline Buf aep_file(const std::vector<Buf>& items, std::uint32_t aeMajor = 24, std::uint32_t aeMinor = 0) {
  Record head(20);
  const std::uint32_t word = (((aeMajor / 8) & 0x1fU) << 26U) | ((aeMajor % 8) << 19U) | ((aeMinor & 0x0fU) << 15U);
  head.u32(4, word);
  std::vector<Buf> fold{chunk("fdta", Buf(14, 0))};
  append(fold, items);
  const Buf body = concat({fourcc("Egg!"), chunk("head", head.bytes), list("Fold", fold)});
  return concat({fourcc("RIFX"), u32be(static_cast<std::uint32_t>(body.size())), body});
}

}  // namespace premation::test::aepb
