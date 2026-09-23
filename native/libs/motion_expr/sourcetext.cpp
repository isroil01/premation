// Source Text in expressions — a port of packages/animation/src/sourceText.ts:
// `text.sourceText` (a String object carrying `.style`, `.value`,
// `.getStyleAt(i)`), the chainable, immutable style object with AE's getters
// and setters, and the colour helpers. `coerce_source_text_result` (in
// expr.cpp) turns what an expression returned into SourceTextResult data.

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "interp.hpp"
#include "jsmath.hpp"
#include "numconv.hpp"
#include "ops.hpp"
#include "sourcetext.hpp"

namespace motion::expr::detail {
namespace {

// Functions, not globals: a static std::u16string may throw at startup. They
// return Str (not a view) because every use is a `+` concatenation.
Str lq() { return u"“"; }  // NOLINT(modernize-use-string-view)
Str rq() { return u"”"; }  // NOLINT(modernize-use-string-view)

bool is_ws(char16_t c) noexcept {
  switch (c) {
    case 0x09: case 0x0A: case 0x0B: case 0x0C: case 0x0D: case 0x20: case 0xA0:
    case 0x1680: case 0x2028: case 0x2029: case 0x202F: case 0x205F: case 0x3000: case 0xFEFF:
      return true;
    default:
      return c >= 0x2000 && c <= 0x200A;
  }
}

Str trim(const Str& s) {
  std::size_t b = 0;
  std::size_t e = s.size();
  while (b < e && is_ws(s[b])) ++b;
  while (e > b && is_ws(s[e - 1])) --e;
  return s.substr(b, e - b);
}

double clamp01(double v) noexcept { return is_finite(v) ? std::min(1.0, std::max(0.0, v)) : 0; }

/// `num(v, fn)`: a finite number or a stated error.
double num(const Value& v, std::u16string_view fn) {
  if (v.is_number() && is_finite(v.n)) return v.n;
  throw_eval(Str(fn) + u"() needs a number.");
}

std::u16string_view align_to_justify(const Str& a) {
  if (a == u"left") return u"alignLeft";
  if (a == u"center") return u"alignCenter";
  if (a == u"right") return u"alignRight";
  if (a == u"justify") return u"justifyLastLineLeft";
  return u"alignLeft";
}

std::optional<Str> justify_to_align(const Str& v) {
  if (v == u"alignLeft" || v == u"left") return Str(u"left");
  if (v == u"alignCenter" || v == u"center") return Str(u"center");
  if (v == u"alignRight" || v == u"right") return Str(u"right");
  if (v == u"justifyLastLineLeft" || v == u"justifyLastLineCenter" || v == u"justifyLastLineRight" ||
      v == u"justifyLastLineFull" || v == u"justify") {
    return Str(u"justify");
  }
  return std::nullopt;
}

// ── Grapheme split ──────────────────────────────────────────────────────────
//
// The TypeScript uses Intl.Segmenter (ICU's extended grapheme clusters). This
// is the practical subset of UAX #29: CR LF, combining marks, variation
// selectors, ZWJ sequences, emoji modifiers, regional-indicator pairs and
// Hangul syllable sequences. Differences from ICU on rarer scripts
// (Indic conjuncts, prepend characters) are documented in native/README.md.

char32_t code_point_at(const Str& s, std::size_t i, std::size_t& len) {
  const char16_t c = s[i];
  if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.size() && s[i + 1] >= 0xDC00 && s[i + 1] <= 0xDFFF) {
    len = 2;
    return static_cast<char32_t>(((c - 0xD800U) << 10U) + (s[i + 1] - 0xDC00U) + 0x10000U);
  }
  len = 1;
  return c;
}

bool is_extend(char32_t c) noexcept {
  return (c >= 0x0300 && c <= 0x036F) || (c >= 0x0483 && c <= 0x0489) || (c >= 0x0591 && c <= 0x05BD) ||
         (c >= 0x0610 && c <= 0x061A) || (c >= 0x064B && c <= 0x065F) || (c >= 0x0900 && c <= 0x0903) ||
         (c >= 0x093A && c <= 0x094F) || (c >= 0x0E31 && c <= 0x0E3A && c != 0x0E32 && c != 0x0E33) ||
         (c >= 0x0E47 && c <= 0x0E4E) || (c >= 0x1AB0 && c <= 0x1AFF) || (c >= 0x1DC0 && c <= 0x1DFF) ||
         (c >= 0x200C && c <= 0x200D) || (c >= 0x20D0 && c <= 0x20FF) || (c >= 0x302A && c <= 0x302F) ||
         (c >= 0x3099 && c <= 0x309A) || (c >= 0xFE00 && c <= 0xFE0F) || (c >= 0xFE20 && c <= 0xFE2F) ||
         (c >= 0x1F3FB && c <= 0x1F3FF) || (c >= 0xE0020 && c <= 0xE007F) || (c >= 0xE0100 && c <= 0xE01EF);
}

bool is_regional(char32_t c) noexcept { return c >= 0x1F1E6 && c <= 0x1F1FF; }
bool is_hangul_l(char32_t c) noexcept { return c >= 0x1100 && c <= 0x115F; }
bool is_hangul_v(char32_t c) noexcept { return c >= 0x1160 && c <= 0x11A7; }
bool is_hangul_t(char32_t c) noexcept { return c >= 0x11A8 && c <= 0x11FF; }
bool is_hangul_syl(char32_t c) noexcept { return c >= 0xAC00 && c <= 0xD7A3; }

}  // namespace

std::size_t grapheme_count(const Str& s) {
  std::size_t count = 0;
  std::size_t i = 0;
  while (i < s.size()) {
    std::size_t len = 0;
    char32_t prev = code_point_at(s, i, len);
    i += len;
    ++count;
    int ri = is_regional(prev) ? 1 : 0;
    while (i < s.size()) {
      const char32_t c = code_point_at(s, i, len);
      bool join = false;
      if (prev == U'\r' || prev == U'\n') {
        join = prev == U'\r' && c == U'\n';  // CR LF is one cluster; anything else breaks after CR/LF
      } else {
        join = is_extend(c) ||                           // combining marks, variation selectors, modifiers
               (prev == 0x200D && c >= 0x2000) ||         // ZWJ sequence
               (is_regional(c) && ri % 2 == 1) ||         // the second flag letter
               (is_hangul_l(prev) && (is_hangul_l(c) || is_hangul_v(c) || is_hangul_syl(c))) ||
               ((is_hangul_v(prev) || is_hangul_syl(prev)) && (is_hangul_v(c) || is_hangul_t(c))) ||
               (is_hangul_t(prev) && is_hangul_t(c));
      }
      if (!join) break;
      if (is_regional(c)) ++ri;
      prev = c;
      i += len;
    }
  }
  return count;
}

// ── Colour ──────────────────────────────────────────────────────────────────

std::array<double, 3> css_to_rgb01(const std::optional<Str>& css) {
  const Str s = trim(css.value_or(Str()));
  // /^#([0-9a-f]{3,8})$/i
  if (s.size() >= 4 && s.size() <= 9 && s[0] == u'#') {
    const Str hex = s.substr(1);
    const bool all_hex = std::ranges::all_of(hex, [](char16_t c) {
      return (c >= u'0' && c <= u'9') || (c >= u'a' && c <= u'f') || (c >= u'A' && c <= u'F');
    });
    if (all_hex) {
      Str h = hex;
      if (h.size() == 3 || h.size() == 4) {
        Str e;
        for (std::size_t i = 0; i < 3; ++i) e += Str(2, h[i]);
        h = e;
      }
      std::uint32_t n = 0;
      for (std::size_t i = 0; i < std::min<std::size_t>(6, h.size()); ++i) {
        const char16_t c = h[i];
        const std::uint32_t d = c <= u'9' ? c - u'0' : (c | 0x20U) - u'a' + 10U;
        n = n * 16U + d;
      }
      return {static_cast<double>((n >> 16U) & 255U) / 255, static_cast<double>((n >> 8U) & 255U) / 255,
              static_cast<double>(n & 255U) / 255};
    }
  }
  // /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i
  const auto lower = [](char16_t c) { return (c >= u'A' && c <= u'Z') ? static_cast<char16_t>(c + 32) : c; };
  std::size_t i = 0;
  if (s.size() >= 4 && lower(s[0]) == u'r' && lower(s[1]) == u'g' && lower(s[2]) == u'b') {
    i = 3;
    if (lower(s[i]) == u'a') ++i;
    if (i < s.size() && s[i] == u'(') {
      ++i;
      while (i < s.size() && is_ws(s[i])) ++i;
      std::array<Str, 3> parts;
      bool ok = true;
      for (std::size_t k = 0; k < 3 && ok; ++k) {
        if (k > 0) {
          const std::size_t start = i;
          while (i < s.size() && (is_ws(s[i]) || s[i] == u',')) ++i;
          if (i == start) ok = false;
        }
        const std::size_t start = i;
        while (i < s.size() && ((s[i] >= u'0' && s[i] <= u'9') || s[i] == u'.')) ++i;
        if (i == start) ok = false;
        parts[k] = s.substr(start, i - start);
      }
      // Regex backtracking only matters when a separator could be absorbed by
      // [\d.]+; digits never are, so this greedy scan finds the same match.
      if (ok) {
        std::array<double, 3> out{};
        for (std::size_t k = 0; k < 3; ++k) out[k] = clamp01(motion::js::string_to_number(std::u16string_view(parts[k])) / 255);
        return out;
      }
    }
  }
  return {1, 1, 1};
}

Str rgb01_to_css(const Value& v, std::u16string_view fn) {
  if (v.is_string()) {
    const Str t = trim(*v.s);
    if (!t.empty()) return t;
  }
  if (is_array(v) && v.o->elems.size() >= 3) {
    const auto& e = v.o->elems;
    if (std::all_of(e.begin(), e.begin() + 3, [](const Value& c) { return c.is_number() && is_finite(c.n); })) {
      Str out = u"#";
      for (std::size_t k = 0; k < 3; ++k) {
        const auto n = static_cast<unsigned>(motion::js::round(clamp01(e[k].n) * 255));
        static constexpr std::u16string_view kHex = u"0123456789abcdef";
        out += kHex[(n >> 4U) & 15U];
        out += kHex[n & 15U];
      }
      return out;
    }
  }
  throw_eval(Str(fn) + u"() needs a colour, e.g. " + Str(fn) + u"([1, 0, 0]).");
}

// ── Style resolution ────────────────────────────────────────────────────────

SourceTextStyle resolve_style(const SourceTextStyle& base, const SourceTextStyleOverrides& o) {
  const double font_size = o.font_size.value_or(base.font_size);
  SourceTextStyle out = base;
  out.font_family = o.font_family.value_or(base.font_family);
  out.font_size = font_size;
  out.font_weight = o.font_weight.value_or(base.font_weight);
  out.font_style = o.font_style.value_or(base.font_style);
  out.fill = o.fill.value_or(base.fill);
  out.stroke = o.stroke ? o.stroke : base.stroke;
  out.stroke_width = o.stroke_width.value_or(base.stroke_width);
  out.letter_spacing = o.tracking ? (*o.tracking * font_size) / 1000 : base.letter_spacing;
  out.line_height = (o.leading && font_size > 0) ? *o.leading / font_size : base.line_height;
  out.baseline_shift = o.baseline_shift.value_or(base.baseline_shift);
  out.horizontal_scale = o.horizontal_scale.value_or(base.horizontal_scale);
  out.vertical_scale = o.vertical_scale.value_or(base.vertical_scale);
  out.text_transform = o.text_transform.value_or(base.text_transform);
  out.font_variant = o.font_variant.value_or(base.font_variant);
  out.align = o.align.value_or(base.align);
  out.paragraph_spacing = (o.space_after || o.space_before)
                              ? o.space_after.value_or(base.paragraph_spacing) + o.space_before.value_or(0)
                              : base.paragraph_spacing;
  out.first_line_indent = o.first_line_indent.value_or(base.first_line_indent);
  out.left_indent = o.left_indent.value_or(base.left_indent);
  out.right_indent = o.right_indent.value_or(base.right_indent);
  out.space_before = o.space_before.value_or(base.space_before);
  if (o.apply_fill && !*o.apply_fill) out.fill = u"transparent";
  if (o.apply_stroke && !*o.apply_stroke) out.stroke_width = 0;
  return out;
}

namespace {

/// Object.assign(target, src) over the fields src sets.
void merge_overrides(SourceTextStyleOverrides& t, const SourceTextStyleOverrides& s) {
  const auto m = [](auto& dst, const auto& src) {
    if (src) dst = src;
  };
  m(t.font_family, s.font_family);
  m(t.font_size, s.font_size);
  m(t.font_weight, s.font_weight);
  m(t.font_style, s.font_style);
  m(t.fill, s.fill);
  m(t.apply_fill, s.apply_fill);
  m(t.stroke, s.stroke);
  m(t.stroke_width, s.stroke_width);
  m(t.apply_stroke, s.apply_stroke);
  m(t.tracking, s.tracking);
  m(t.leading, s.leading);
  m(t.baseline_shift, s.baseline_shift);
  m(t.horizontal_scale, s.horizontal_scale);
  m(t.vertical_scale, s.vertical_scale);
  m(t.text_transform, s.text_transform);
  m(t.font_variant, s.font_variant);
  m(t.align, s.align);
  m(t.first_line_indent, s.first_line_indent);
  m(t.left_indent, s.left_indent);
  m(t.right_indent, s.right_indent);
  m(t.space_before, s.space_before);
  m(t.space_after, s.space_after);
  m(t.direction, s.direction);
  m(t.leading_type, s.leading_type);
}

SourceTextStyle effective_style(const StyleState& st) {
  SourceTextStyle base = st.base->style;
  SourceTextStyleOverrides o = st.style;
  if (st.at) {
    const double i = *st.at;
    if (st.base->runs) {
      for (const SourceTextRun& r : *st.base->runs) {
        if (!(i >= r.start && i < r.end)) continue;
        if (r.style.font_size) base.font_size = *r.style.font_size;
        if (r.style.font_family) base.font_family = *r.style.font_family;
        if (r.style.font_weight) base.font_weight = *r.style.font_weight;
        if (r.style.font_style) base.font_style = *r.style.font_style;
        if (r.style.letter_spacing) base.letter_spacing = *r.style.letter_spacing;
        if (r.style.fill) base.fill = *r.style.fill;
      }
    }
    for (const SourceTextRangeOverride& r : st.ranges) {
      if (i >= r.start && i < r.start + r.count) merge_overrides(o, r.style);
    }
  }
  return resolve_style(base, o);
}

enum class Setter : std::uint8_t {
  kFont, kFontSize, kFillColor, kStrokeColor, kStrokeWidth, kTracking, kLeading, kFauxBold, kFauxItalic,
  kAllCaps, kSmallCaps, kApplyFill, kApplyStroke, kBaselineShift, kHorizontalScaling, kVerticalScaling,
  kJustification, kFirstLineIndent, kLeftMargin, kRightMargin, kSpaceBefore, kSpaceAfter, kDirection,
  kLeadingType, kCount_
};

constexpr std::array<std::u16string_view, static_cast<std::size_t>(Setter::kCount_)> kSetterNames = {
    u"setFont",         u"setFontSize",        u"setFillColor",      u"setStrokeColor",   u"setStrokeWidth",
    u"setTracking",     u"setLeading",         u"setFauxBold",       u"setFauxItalic",    u"setAllCaps",
    u"setSmallCaps",    u"setApplyFill",       u"setApplyStroke",    u"setBaselineShift", u"setHorizontalScaling",
    u"setVerticalScaling", u"setJustification", u"setFirstLineIndent", u"setLeftMargin",   u"setRightMargin",
    u"setSpaceBefore",  u"setSpaceAfter",      u"setDirection",      u"setLeadingType"};

/// Setters whose TypeScript range key is null (paragraph-wide).
bool paragraph_only(Setter s) noexcept { return s == Setter::kLeading || s >= Setter::kJustification; }

std::optional<Setter> setter_of(KeyId kid) {
  static constexpr std::array<KeyId, static_cast<std::size_t>(Setter::kCount_)> kKeys = {
      KeyId::k_setFont,          KeyId::k_setFontSize,        KeyId::k_setFillColor,   KeyId::k_setStrokeColor,
      KeyId::k_setStrokeWidth,   KeyId::k_setTracking,        KeyId::k_setLeading,     KeyId::k_setFauxBold,
      KeyId::k_setFauxItalic,    KeyId::k_setAllCaps,         KeyId::k_setSmallCaps,   KeyId::k_setApplyFill,
      KeyId::k_setApplyStroke,   KeyId::k_setBaselineShift,   KeyId::k_setHorizontalScaling,
      KeyId::k_setVerticalScaling, KeyId::k_setJustification, KeyId::k_setFirstLineIndent, KeyId::k_setLeftMargin,
      KeyId::k_setRightMargin,   KeyId::k_setSpaceBefore,     KeyId::k_setSpaceAfter,  KeyId::k_setDirection,
      KeyId::k_setLeadingType};
  for (std::size_t i = 0; i < kKeys.size(); ++i) {
    if (kKeys[i] == kid) return static_cast<Setter>(i);
  }
  return std::nullopt;
}

}  // namespace

// ── The expression-facing objects ───────────────────────────────────────────

Value Interp::make_style(StyleState state) {
  arena_.styles.push_back(std::move(state));
  Obj* o = arena_.obj(ObjKind::kStyle);
  o->state = arena_.styles.size() - 1;
  return Value::object(o);
}

Value Interp::make_source_text_value(const SourceTextSample& sample, bool foreign) {
  StyleState st;
  st.base = &sample;
  st.text = sample.text;
  st.foreign = foreign;
  arena_.styles.push_back(std::move(st));
  Obj* o = arena_.obj(ObjKind::kStringObject);
  o->str = arena_.str(sample.text);
  o->state = arena_.styles.size() - 1;
  return Value::object(o);
}

Value Interp::source_text_of(const Value& name, double t) {
  Host* host = ctx_.host;
  const bool self = name.is_null();
  Str name_s;
  if (!self) name_s = to_string(name);
  std::optional<SourceTextSample> sample;
  if (host != nullptr && host->has_source_text_at()) {
    sample = host->source_text_at(self ? nullptr : &name_s, t);  // a HostError propagates to evaluate_raw
  }
  if (!sample) {
    throw_eval(self ? Str(u"text.sourceText: this layer has no Source Text.")
                    : u"text.sourceText: no text layer named " + lq() + name_s + rq() + u".");
  }
  const SourceTextSample& stored = arena_.samples.emplace_back(std::move(*sample));
  return make_source_text_value(stored, !self);
}

Value Interp::read_string_object(const Obj& so, const Value& key, KeyId kid) {
  switch (kid) {
    case KeyId::k_length:
      return Value::number(static_cast<double>(so.str->size()));
    case KeyId::k_style: {
      StyleState st = arena_.styles[so.state];
      return make_style(std::move(st));
    }
    case KeyId::k_value:
      return Value::string(so.str);
    case KeyId::k_getStyleAt:
      return bound_fn(Fn::kGetStyleAt, Value{}, 0, so.state);
    default:
      break;
  }
  if (const auto idx = array_index_of(key)) {
    if (*idx < so.str->size()) return str(Str(1, (*so.str)[*idx]));
    return {};
  }
  return read_proto(*this, Value::object(const_cast<Obj*>(&so)), kid).value_or(Value{});  // NOLINT(cppcoreguidelines-pro-type-const-cast) — receiver identity only
}

Value Interp::read_style(const Obj& style, KeyId kid) {
  const StyleState& st = arena_.styles[style.state];
  if (const auto s = setter_of(kid)) {
    return bound_fn(Fn::kStyleSetter, Value{}, static_cast<std::uint8_t>(*s), style.state);
  }
  if (kid == KeyId::k_setText) return bound_fn(Fn::kStyleSetText, Value{}, 0, style.state);
  const auto rgb = [&](const std::array<double, 3>& c) {
    return array({Value::number(c[0]), Value::number(c[1]), Value::number(c[2])});
  };
  switch (kid) {
    case KeyId::k_font: return str(effective_style(st).font_family);
    case KeyId::k_fontSize: return Value::number(effective_style(st).font_size);
    case KeyId::k_fillColor: return rgb(css_to_rgb01(effective_style(st).fill));
    case KeyId::k_strokeColor: return rgb(css_to_rgb01(effective_style(st).stroke.value_or(u"#000000")));
    case KeyId::k_strokeWidth: return Value::number(effective_style(st).stroke_width);
    case KeyId::k_tracking: {
      const SourceTextStyle e = effective_style(st);
      return Value::number(e.font_size > 0 ? (e.letter_spacing * 1000) / e.font_size : 0);
    }
    case KeyId::k_leading: {
      const SourceTextStyle e = effective_style(st);
      return Value::number(e.line_height * e.font_size);
    }
    case KeyId::k_isFauxBold:
      return Value::boolean(motion::js::string_to_number(std::u16string_view(effective_style(st).font_weight)) >= 700);
    case KeyId::k_isFauxItalic: return Value::boolean(effective_style(st).font_style == u"italic");
    case KeyId::k_isAllCaps: return Value::boolean(effective_style(st).text_transform == u"uppercase");
    case KeyId::k_isSmallCaps: return Value::boolean(effective_style(st).font_variant == u"small-caps");
    case KeyId::k_applyFill: {
      const Str f = effective_style(st).fill;
      return Value::boolean(f != u"transparent" && f != u"none");
    }
    case KeyId::k_applyStroke: return Value::boolean(effective_style(st).stroke_width > 0);
    case KeyId::k_baselineShift: return Value::number(effective_style(st).baseline_shift);
    case KeyId::k_horizontalScaling: return Value::number(effective_style(st).horizontal_scale / 100);
    case KeyId::k_verticalScaling: return Value::number(effective_style(st).vertical_scale / 100);
    case KeyId::k_justification: return str(Str(align_to_justify(effective_style(st).align)));
    case KeyId::k_firstLineIndent: return Value::number(effective_style(st).first_line_indent);
    case KeyId::k_leftMargin: return Value::number(effective_style(st).left_indent);
    case KeyId::k_rightMargin: return Value::number(effective_style(st).right_indent);
    case KeyId::k_spaceBefore: return Value::number(effective_style(st).space_before);
    case KeyId::k_spaceAfter: return Value::number(st.style.space_after.value_or(st.base->style.paragraph_spacing));
    case KeyId::k_direction:
      return str(st.style.direction == Str(u"rtl") ? u"dirRightToLeft" : u"dirLeftToRight");
    case KeyId::k_leadingType:
      return str(st.style.leading_type == Str(u"eastAsian") ? u"leadingEastAsian" : u"leadingRoman");
    default:
      break;
  }
  return {};
}

Value Interp::call_style(const Obj& f, Args a) {
  // Copy: make_style may grow the deque (references into it stay valid, but
  // the state is about to be modified into a NEW one anyway).
  const StyleState state = arena_.styles[f.state];
  const auto next = [&](StyleState s) {
    s.at.reset();
    return make_style(std::move(s));
  };
  if (f.fn == Fn::kGetStyleAt) {
    const double i = std::max(0.0, std::floor(num(a[0], u"getStyleAt")));
    StyleState s = state;
    s.at = i;
    return make_style(std::move(s));
  }
  if (f.fn == Fn::kStyleSetText) {
    const Value v = a[0];
    const Str s = v.is_string() ? *v.s : (v.is_nullish() ? Str() : to_string(v));
    if (s.size() > kMaxSourceTextLength) {
      throw_eval(u"setText() text is too long (limit " + number_to_str(static_cast<double>(kMaxSourceTextLength)) +
                 u" characters).");
    }
    StyleState ns = state;
    ns.text = s;
    ns.text_set = true;
    return next(std::move(ns));
  }
  const auto which = static_cast<Setter>(f.aux);
  const std::u16string_view fn = kSetterNames[f.aux];
  const Value value = a[0];
  // ── convert(value) first, as the TypeScript does ──
  SourceTextStyleOverrides v;
  switch (which) {
    case Setter::kFont: {
      if (!value.is_string() || trim(*value.s).empty()) {
        throw_eval(u"setFont() needs a font name, e.g. setFont(\"Inter\").");
      }
      v.font_family = trim(*value.s);
      break;
    }
    case Setter::kFontSize: v.font_size = std::max(0.1, num(value, fn)); break;
    case Setter::kFillColor: v.fill = rgb01_to_css(value, fn); break;
    case Setter::kStrokeColor: v.stroke = rgb01_to_css(value, fn); break;
    case Setter::kStrokeWidth: v.stroke_width = std::max(0.0, num(value, fn)); break;
    case Setter::kTracking: v.tracking = num(value, fn); break;
    case Setter::kLeading: v.leading = std::max(0.0, num(value, fn)); break;
    case Setter::kFauxBold: {
      double base_w = motion::js::string_to_number(std::u16string_view(state.base->style.font_weight));
      if (base_w == 0 || std::isnan(base_w)) base_w = 400;  // `|| 400`
      const double w = truthy(value) ? std::max(700.0, base_w) : (base_w >= 700 ? 400 : base_w);
      v.font_weight = number_to_str(w);
      break;
    }
    case Setter::kFauxItalic: v.font_style = Str(truthy(value) ? u"italic" : u"normal"); break;
    case Setter::kAllCaps: v.text_transform = Str(truthy(value) ? u"uppercase" : u"none"); break;
    case Setter::kSmallCaps: v.font_variant = Str(truthy(value) ? u"small-caps" : u"normal"); break;
    case Setter::kApplyFill: v.apply_fill = truthy(value); break;
    case Setter::kApplyStroke: v.apply_stroke = truthy(value); break;
    case Setter::kBaselineShift: v.baseline_shift = num(value, fn); break;
    case Setter::kHorizontalScaling: v.horizontal_scale = num(value, fn) * 100; break;
    case Setter::kVerticalScaling: v.vertical_scale = num(value, fn) * 100; break;
    case Setter::kJustification: {
      std::optional<Str> al;
      if (value.is_string()) al = justify_to_align(*value.s);
      if (!al) {
        throw_eval(u"setJustification() takes \"alignLeft\", \"alignCenter\", \"alignRight\" or a "
                   u"\"justifyLastLine…\" value.");
      }
      v.align = *al;
      break;
    }
    case Setter::kFirstLineIndent: v.first_line_indent = num(value, fn); break;
    case Setter::kLeftMargin: v.left_indent = num(value, fn); break;
    case Setter::kRightMargin: v.right_indent = num(value, fn); break;
    case Setter::kSpaceBefore: v.space_before = num(value, fn); break;
    case Setter::kSpaceAfter: v.space_after = num(value, fn); break;
    case Setter::kDirection: {
      const bool rtl = value.is_string() && (*value.s == u"dirRightToLeft" || *value.s == u"rtl");
      v.direction = Str(rtl ? u"rtl" : u"ltr");
      break;
    }
    case Setter::kLeadingType: {
      const bool ea = value.is_string() && (*value.s == u"leadingEastAsian" || *value.s == u"eastAsian");
      v.leading_type = Str(ea ? u"eastAsian" : u"roman");
      break;
    }
    case Setter::kCount_:
      break;
  }
  const Value start = a[1];
  if (!start.is_undefined() && !paragraph_only(which)) {
    // pushRange
    const double s = std::max(0.0, std::floor(num(start, fn)));
    const double c = a[2].is_undefined() ? static_cast<double>(grapheme_count(state.text)) - s
                                         : std::max(0.0, std::floor(num(a[2], fn)));
    if (c <= 0) return next(state);
    if (state.ranges.size() >= kMaxRangeOverrides) {
      throw_eval(u"Too many per-character style ranges (limit " +
                 number_to_str(static_cast<double>(kMaxRangeOverrides)) + u").");
    }
    StyleState ns = state;
    ns.ranges.push_back({.start = s, .count = c, .style = v});
    return next(std::move(ns));
  }
  if (!start.is_undefined()) throw_eval(Str(fn) + u"() is paragraph-wide and takes no character range.");
  StyleState ns = state;
  merge_overrides(ns.style, v);
  return next(std::move(ns));
}

// ── coerceSourceTextResult ──────────────────────────────────────────────────

namespace {

SourceTextStyleOverrides style_as_overrides(const SourceTextStyle& s) {
  SourceTextStyleOverrides o;
  o.font_family = s.font_family;
  o.font_size = s.font_size;
  o.font_weight = s.font_weight;
  o.font_style = s.font_style;
  o.fill = s.fill;
  if (s.stroke) o.stroke = s.stroke;
  o.stroke_width = s.stroke_width;
  o.tracking = s.font_size > 0 ? (s.letter_spacing * 1000) / s.font_size : 0;
  o.leading = s.line_height * s.font_size;
  o.baseline_shift = s.baseline_shift;
  o.horizontal_scale = s.horizontal_scale;
  o.vertical_scale = s.vertical_scale;
  o.text_transform = s.text_transform;
  o.font_variant = s.font_variant;
  o.align = s.align;
  o.space_after = s.paragraph_spacing;
  return o;
}

}  // namespace

TextResult coerce_source_text_result(const Value& out, const Arena& arena, const Str& fallback) {
  const Str must = u"Source Text expressions must return text (or text.sourceText.style…).";
  TextResult r;
  if (out.is_object()) {
    const Obj& o = *out.o;
    if (o.kind == ObjKind::kStringObject) {
      r.result = SourceTextResult{.text = *o.str, .style = {}, .ranges = {}};
      return r;
    }
    if (o.kind == ObjKind::kStyle) {
      const StyleState& st = arena.styles[o.state];
      SourceTextResult res;
      res.text = st.text_set ? st.text : fallback;
      if (st.foreign) {
        res.style = style_as_overrides(st.base->style);
        merge_overrides(res.style, st.style);
      } else {
        res.style = st.style;
      }
      res.ranges = st.ranges;
      r.result = std::move(res);
      return r;
    }
    if (o.kind == ObjKind::kArray) {
      r.result = SourceTextResult{.text = join(o.elems, u","), .style = {}, .ranges = {}};
      return r;
    }
    r.error = must;  // functions are typeof 'function' and land here too
    return r;
  }
  switch (out.tag) {
    case Tag::kString:
      if (out.s->size() > kMaxSourceTextLength) {
        r.error = u"Text is too long (limit " + number_to_str(static_cast<double>(kMaxSourceTextLength)) +
                  u" characters).";
      } else {
        r.result = SourceTextResult{.text = *out.s, .style = {}, .ranges = {}};
      }
      return r;
    case Tag::kNumber:
      if (is_finite(out.n)) {
        r.result = SourceTextResult{.text = number_to_str(out.n), .style = {}, .ranges = {}};
      } else {
        r.error = Str(u"Expression returned a non-finite number.");
      }
      return r;
    case Tag::kBool:
      r.result = SourceTextResult{.text = out.b ? u"true" : u"false", .style = {}, .ranges = {}};
      return r;
    default:
      r.error = must;
      return r;
  }
}

}  // namespace motion::expr::detail
