// The JavaScript built-ins an expression can reach through a value: `Math`,
// and the Number / Boolean / String / Array / Function / Object prototype
// methods (the TypeScript's `readMember` does a plain property read, so
// `value.toFixed(2)`, `"a,b".split(",")` and `[1, 2].join()` all work there,
// and people's AE text expressions rely on them).
//
// Each method follows ECMA-262's algorithm (argument coercion order,
// clamping, negative indices, `$&` substitutions, …). What is deliberately
// NOT here is listed in native/README.md (regex-based methods, locale
// methods, full-Unicode case mapping, generic array methods on non-arrays);
// reading such a member yields `undefined`, so calling it fails with the
// usual "is not a function".

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <numbers>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "interp.hpp"
#include "jsmath.hpp"
#include "numconv.hpp"
#include "ops.hpp"

namespace motion::expr::detail {
namespace {

// V8 caps strings at 2^29 - 24 code units ("Invalid string length").
constexpr double kMaxStringLength = 536870888.0;

[[noreturn]] void throw_range(const Str& message) { throw_eval(message); }

Str ascii(std::string_view s) { return {s.begin(), s.end()}; }

double to_length(double d) noexcept {
  const double n = integer_or_infinity(d);
  if (n <= 0) return 0;
  return std::min(n, 9007199254740991.0);
}

/// Clamp a relative index (slice/at semantics): negative counts from `len`.
double relative_index(const Value& v, double len, double dflt) {
  if (v.is_undefined()) return dflt;
  const double rel = integer_or_infinity(to_number(v));
  if (rel < 0) return std::max(len + rel, 0.0);
  return std::min(rel, len);
}

double clamp_d(double v, double lo, double hi) noexcept { return std::min(std::max(v, lo), hi); }

bool is_ws(char16_t c) noexcept {
  switch (c) {
    case 0x09: case 0x0A: case 0x0B: case 0x0C: case 0x0D: case 0x20: case 0xA0:
    case 0x1680: case 0x2028: case 0x2029: case 0x202F: case 0x205F: case 0x3000: case 0xFEFF:
      return true;
    default:
      return c >= 0x2000 && c <= 0x200A;
  }
}

// Case mapping: ASCII, Latin-1, Latin Extended-A, basic Greek and Cyrillic.
// (V8 uses ICU's full mapping incl. SpecialCasing; see native/README.md.)
void upper_into(Str& out, char16_t c) {
  if ((c >= u'a' && c <= u'z') || (c >= 0xE0 && c <= 0xFE && c != 0xF7) || (c >= 0x3B1 && c <= 0x3C9 && c != 0x3C2) ||
      (c >= 0x430 && c <= 0x44F)) {
    out += static_cast<char16_t>(c - 32);
  } else if (c == 0xDF) {
    out += u"SS";
  } else if (c == 0xB5) {
    out += static_cast<char16_t>(0x39C);
  } else if (c == 0xFF) {
    out += static_cast<char16_t>(0x178);
  } else if (c == 0x131) {
    out += u'I';
  } else if (c == 0x17F) {
    out += u'S';
  } else if ((c >= 0x100 && c <= 0x137 && c != 0x130 && (c & 1U) == 1U) ||
             (c >= 0x14A && c <= 0x177 && (c & 1U) == 1U) || (c >= 0x139 && c <= 0x148 && (c & 1U) == 0U) ||
             (c >= 0x179 && c <= 0x17E && (c & 1U) == 0U)) {
    out += static_cast<char16_t>(c - 1);
  } else if (c == 0x3C2) {
    out += static_cast<char16_t>(0x3A3);
  } else if (c >= 0x450 && c <= 0x45F) {
    out += static_cast<char16_t>(c - 80);
  } else {
    out += c;
  }
}

void lower_into(Str& out, char16_t c) {
  if ((c >= u'A' && c <= u'Z') || (c >= 0xC0 && c <= 0xDE && c != 0xD7) || (c >= 0x391 && c <= 0x3A9 && c != 0x3A2) ||
      (c >= 0x410 && c <= 0x42F)) {
    out += static_cast<char16_t>(c + 32);
  } else if (c == 0x178) {
    out += static_cast<char16_t>(0xFF);
  } else if (c == 0x130) {
    out += u"i̇";
  } else if ((c >= 0x100 && c <= 0x137 && c != 0x130 && (c & 1U) == 0U) ||
             (c >= 0x14A && c <= 0x177 && (c & 1U) == 0U) || (c >= 0x139 && c <= 0x148 && (c & 1U) == 1U) ||
             (c >= 0x179 && c <= 0x17E && (c & 1U) == 1U)) {
    out += static_cast<char16_t>(c + 1);
  } else if (c >= 0x400 && c <= 0x40F) {
    out += static_cast<char16_t>(c + 80);
  } else {
    out += c;
  }
}

/// Math.f16round: round the double DIRECTLY to binary16 (ties to even).
double f16round(double x) noexcept {
  if (std::isnan(x) || std::isinf(x) || x == 0) return x;
  const double a = std::fabs(x);
  int e = 0;
  (void)std::frexp(a, &e);  // a = m × 2^e, m in [0.5, 1)
  const int unbiased = e - 1;
  const double quantum = unbiased < -14 ? std::ldexp(1.0, -24) : std::ldexp(1.0, unbiased - 10);
  const double v = a / quantum;  // exact
  double r = std::floor(v);
  const double diff = v - r;
  if (diff > 0.5 || (diff == 0.5 && std::fmod(r, 2.0) != 0)) r += 1;
  double out = r * quantum;
  if (out >= 65520.0) out = motion::js::kInf;  // beyond 65504 rounds to Infinity
  return x < 0 ? -out : out;
}

/// `this` for String.prototype methods: RequireObjectCoercible + ToString.
Str this_string(const Value& t, std::string_view method) {
  if (t.is_nullish()) {
    throw_eval(u"String.prototype." + ascii(method) + u" called on null or undefined");
  }
  return to_string(t);
}

std::vector<Value>& this_array(const Value& t, std::string_view method) {
  if (!is_array(t)) {
    // Generic array methods on array-likes are not ported (native/README.md).
    throw_eval(u"Array.prototype." + ascii(method) + u" is only supported on arrays here");
  }
  return t.o->elems;
}

/// String.prototype.indexOf's core: first `search` in `s` at or after `from`.
std::optional<std::size_t> find_from(const Str& s, const Str& search, std::size_t from) {
  if (from > s.size()) return std::nullopt;
  const std::size_t p = s.find(search, from);
  if (p == Str::npos) return std::nullopt;
  return p;
}

/// GetSubstitution for a string pattern (no captures).
Str substitution(const Str& matched, const Str& str, std::size_t position, const Str& replacement) {
  Str out;
  const std::size_t tail = position + matched.size();
  for (std::size_t i = 0; i < replacement.size(); ++i) {
    const char16_t c = replacement[i];
    if (c == u'$' && i + 1 < replacement.size()) {
      const char16_t d = replacement[i + 1];
      if (d == u'$') {
        out += u'$';
        ++i;
        continue;
      }
      if (d == u'&') {
        out += matched;
        ++i;
        continue;
      }
      if (d == u'`') {
        out += str.substr(0, position);
        ++i;
        continue;
      }
      if (d == u'\'') {
        if (tail < str.size()) out += str.substr(tail);
        ++i;
        continue;
      }
    }
    out += c;
  }
  return out;
}

std::u16string_view object_to_string_tag(const Value& t) {
  switch (t.tag) {
    case Tag::kUndefined:
      return u"[object Undefined]";
    case Tag::kNull:
      return u"[object Null]";
    case Tag::kBool:
      return u"[object Boolean]";
    case Tag::kNumber:
      return u"[object Number]";
    case Tag::kString:
      return u"[object String]";
    case Tag::kObject:
      break;
  }
  switch (t.o->kind) {
    case ObjKind::kArray:
      return u"[object Array]";
    case ObjKind::kFunction:
      return u"[object Function]";
    case ObjKind::kMath:
      return u"[object Math]";
    case ObjKind::kStringObject:
      return u"[object String]";
    default:
      return u"[object Object]";
  }
}

bool has_own(const Value& t, const Value& key) {
  const Str k = to_string(key);
  const KeyId kid = key_of(k);
  const Value ks = Value::string(&k);
  switch (t.tag) {
    case Tag::kString: {
      if (kid == KeyId::k_length) return true;
      const auto idx = array_index_of(ks);
      return idx && *idx < t.s->size();
    }
    case Tag::kObject:
      break;
    default:
      return false;
  }
  const Obj& o = *t.o;
  switch (o.kind) {
    case ObjKind::kArray: {
      if (kid == KeyId::k_length) return true;
      const auto idx = array_index_of(ks);
      return idx && *idx < o.elems.size();
    }
    case ObjKind::kPlain:
      return kid != KeyId::kUnknown &&
             std::ranges::any_of(o.props, [&](const Prop& p) { return p.key == kid; });
    case ObjKind::kStringObject: {
      if (kid == KeyId::k_length || kid == KeyId::k_style || kid == KeyId::k_value || kid == KeyId::k_getStyleAt) {
        return true;
      }
      const auto idx = array_index_of(ks);
      return idx && *idx < o.str->size();
    }
    case ObjKind::kMath:
      return kid != KeyId::kUnknown && kid >= KeyId::k_abs && kid <= KeyId::k_SQRT2;
    case ObjKind::kStyle:
      return kid >= KeyId::k_font && kid <= KeyId::k_setText;
    case ObjKind::kFunction:
      return false;
  }
  return false;
}

}  // namespace

// ── Member tables ───────────────────────────────────────────────────────────

Value read_math(Interp& in, KeyId kid) {
  switch (kid) {
    case KeyId::k_E:
      return Value::number(std::numbers::e);
    case KeyId::k_LN10:
      return Value::number(std::numbers::ln10);
    case KeyId::k_LN2:
      return Value::number(std::numbers::ln2);
    case KeyId::k_LOG10E:
      return Value::number(std::numbers::log10e);
    case KeyId::k_LOG2E:
      return Value::number(std::numbers::log2e);
    case KeyId::k_PI:
      return Value::number(std::numbers::pi);
    case KeyId::k_SQRT1_2:
      return Value::number(0.7071067811865476);
    case KeyId::k_SQRT2:
      return Value::number(std::numbers::sqrt2);
    default:
      break;
  }
  static constexpr std::array<std::pair<KeyId, Fn>, 36> kFns = {{
      {KeyId::k_abs, Fn::kMathAbs},       {KeyId::k_acos, Fn::kMathAcos},   {KeyId::k_acosh, Fn::kMathAcosh},
      {KeyId::k_asin, Fn::kMathAsin},     {KeyId::k_asinh, Fn::kMathAsinh}, {KeyId::k_atan, Fn::kMathAtan},
      {KeyId::k_atanh, Fn::kMathAtanh},   {KeyId::k_atan2, Fn::kMathAtan2}, {KeyId::k_ceil, Fn::kMathCeil},
      {KeyId::k_cbrt, Fn::kMathCbrt},     {KeyId::k_expm1, Fn::kMathExpm1}, {KeyId::k_clz32, Fn::kMathClz32},
      {KeyId::k_cos, Fn::kMathCos},       {KeyId::k_cosh, Fn::kMathCosh},   {KeyId::k_exp, Fn::kMathExp},
      {KeyId::k_floor, Fn::kMathFloor},   {KeyId::k_fround, Fn::kMathFround}, {KeyId::k_hypot, Fn::kMathHypot},
      {KeyId::k_imul, Fn::kMathImul},     {KeyId::k_log, Fn::kMathLog},     {KeyId::k_log1p, Fn::kMathLog1p},
      {KeyId::k_log2, Fn::kMathLog2},     {KeyId::k_log10, Fn::kMathLog10}, {KeyId::k_max, Fn::kMathMax},
      {KeyId::k_min, Fn::kMathMin},       {KeyId::k_pow, Fn::kMathPow},     {KeyId::k_random, Fn::kMathRandom},
      {KeyId::k_round, Fn::kMathRound},   {KeyId::k_sign, Fn::kMathSign},   {KeyId::k_sin, Fn::kMathSin},
      {KeyId::k_sinh, Fn::kMathSinh},     {KeyId::k_sqrt, Fn::kMathSqrt},   {KeyId::k_tan, Fn::kMathTan},
      {KeyId::k_tanh, Fn::kMathTanh},     {KeyId::k_trunc, Fn::kMathTrunc}, {KeyId::k_f16round, Fn::kMathF16round},
  }};
  for (const auto& [k, f] : kFns) {
    if (k == kid) return in.fn_value(f);
  }
  return {};
}

std::optional<Value> read_proto(Interp& in, const Value& r, KeyId kid) {
  const auto fnv = [&](Fn f) { return std::optional<Value>(in.fn_value(f)); };
  bool stringy = r.tag == Tag::kString;
  bool arr = false;
  bool func = false;
  if (r.tag == Tag::kObject) {
    stringy = r.o->kind == ObjKind::kStringObject;
    arr = r.o->kind == ObjKind::kArray;
    func = r.o->kind == ObjKind::kFunction;
  }
  if (r.tag == Tag::kNumber) {
    switch (kid) {
      case KeyId::k_toFixed: return fnv(Fn::kNumToFixed);
      case KeyId::k_toPrecision: return fnv(Fn::kNumToPrecision);
      case KeyId::k_toExponential: return fnv(Fn::kNumToExponential);
      case KeyId::k_toString: return fnv(Fn::kNumToString);
      case KeyId::k_valueOf: return fnv(Fn::kNumValueOf);
      case KeyId::k_toLocaleString: return std::nullopt;  // locale formatting not ported
      default: break;
    }
  } else if (r.tag == Tag::kBool) {
    if (kid == KeyId::k_toString) return fnv(Fn::kBoolToString);
    if (kid == KeyId::k_valueOf) return fnv(Fn::kBoolValueOf);
  } else if (stringy) {
    switch (kid) {
      case KeyId::k_at: return fnv(Fn::kStrAt);
      case KeyId::k_charAt: return fnv(Fn::kStrCharAt);
      case KeyId::k_charCodeAt: return fnv(Fn::kStrCharCodeAt);
      case KeyId::k_codePointAt: return fnv(Fn::kStrCodePointAt);
      case KeyId::k_concat: return fnv(Fn::kStrConcat);
      case KeyId::k_endsWith: return fnv(Fn::kStrEndsWith);
      case KeyId::k_includes: return fnv(Fn::kStrIncludes);
      case KeyId::k_indexOf: return fnv(Fn::kStrIndexOf);
      case KeyId::k_lastIndexOf: return fnv(Fn::kStrLastIndexOf);
      case KeyId::k_padEnd: return fnv(Fn::kStrPadEnd);
      case KeyId::k_padStart: return fnv(Fn::kStrPadStart);
      case KeyId::k_repeat: return fnv(Fn::kStrRepeat);
      case KeyId::k_replace: return fnv(Fn::kStrReplace);
      case KeyId::k_replaceAll: return fnv(Fn::kStrReplaceAll);
      case KeyId::k_slice: return fnv(Fn::kStrSlice);
      case KeyId::k_split: return fnv(Fn::kStrSplit);
      case KeyId::k_startsWith: return fnv(Fn::kStrStartsWith);
      case KeyId::k_substr: return fnv(Fn::kStrSubstr);
      case KeyId::k_substring: return fnv(Fn::kStrSubstring);
      case KeyId::k_toLowerCase:
      case KeyId::k_toLocaleLowerCase: return fnv(Fn::kStrToLowerCase);
      case KeyId::k_toUpperCase:
      case KeyId::k_toLocaleUpperCase: return fnv(Fn::kStrToUpperCase);
      case KeyId::k_toString: return fnv(Fn::kStrToString);
      case KeyId::k_valueOf: return fnv(Fn::kStrValueOf);
      case KeyId::k_trim: return fnv(Fn::kStrTrim);
      case KeyId::k_trimStart:
      case KeyId::k_trimLeft: return fnv(Fn::kStrTrimStart);
      case KeyId::k_trimEnd:
      case KeyId::k_trimRight: return fnv(Fn::kStrTrimEnd);
      case KeyId::k_isWellFormed: return fnv(Fn::kStrIsWellFormed);
      case KeyId::k_anchor: case KeyId::k_big: case KeyId::k_blink: case KeyId::k_bold: case KeyId::k_fixed:
      case KeyId::k_fontcolor: case KeyId::k_fontsize: case KeyId::k_italics: case KeyId::k_link:
      case KeyId::k_small: case KeyId::k_strike: case KeyId::k_sub: case KeyId::k_sup:
        return in.bound_fn(Fn::kStrHtml, Value{}, static_cast<std::uint8_t>(static_cast<unsigned>(kid) & 0xffU),
                           static_cast<std::size_t>(kid));
      default: break;
    }
  } else if (arr) {
    switch (kid) {
      case KeyId::k_at: return fnv(Fn::kArrAt);
      case KeyId::k_concat: return fnv(Fn::kArrConcat);
      case KeyId::k_every: return fnv(Fn::kArrEvery);
      case KeyId::k_fill: return fnv(Fn::kArrFill);
      case KeyId::k_filter: return fnv(Fn::kArrFilter);
      case KeyId::k_find: return fnv(Fn::kArrFind);
      case KeyId::k_findIndex: return fnv(Fn::kArrFindIndex);
      case KeyId::k_findLast: return fnv(Fn::kArrFindLast);
      case KeyId::k_findLastIndex: return fnv(Fn::kArrFindLastIndex);
      case KeyId::k_flat: return fnv(Fn::kArrFlat);
      case KeyId::k_includes: return fnv(Fn::kArrIncludes);
      case KeyId::k_indexOf: return fnv(Fn::kArrIndexOf);
      case KeyId::k_join: return fnv(Fn::kArrJoin);
      case KeyId::k_lastIndexOf: return fnv(Fn::kArrLastIndexOf);
      case KeyId::k_map: return fnv(Fn::kArrMap);
      case KeyId::k_pop: return fnv(Fn::kArrPop);
      case KeyId::k_push: return fnv(Fn::kArrPush);
      case KeyId::k_reduce: return fnv(Fn::kArrReduce);
      case KeyId::k_reduceRight: return fnv(Fn::kArrReduceRight);
      case KeyId::k_reverse: return fnv(Fn::kArrReverse);
      case KeyId::k_shift: return fnv(Fn::kArrShift);
      case KeyId::k_slice: return fnv(Fn::kArrSlice);
      case KeyId::k_some: return fnv(Fn::kArrSome);
      case KeyId::k_sort: return fnv(Fn::kArrSort);
      case KeyId::k_toString: return fnv(Fn::kArrToString);
      case KeyId::k_unshift: return fnv(Fn::kArrUnshift);
      case KeyId::k_forEach: return fnv(Fn::kArrForEach);
      case KeyId::k_toReversed: return fnv(Fn::kArrToReversed);
      case KeyId::k_toLocaleString: return std::nullopt;
      default: break;
    }
  } else if (func) {
    switch (kid) {
      case KeyId::k_call: return fnv(Fn::kFnCall);
      case KeyId::k_apply: return fnv(Fn::kFnApply);
      case KeyId::k_toString: return fnv(Fn::kFnToString);
      default: break;
    }
  }
  // Object.prototype
  switch (kid) {
    case KeyId::k_toString: return fnv(Fn::kObjToString);
    case KeyId::k_valueOf: return fnv(Fn::kObjValueOf);
    case KeyId::k_hasOwnProperty: return fnv(Fn::kObjHasOwnProperty);
    case KeyId::k_isPrototypeOf: return fnv(Fn::kObjIsPrototypeOf);
    case KeyId::k_propertyIsEnumerable: return fnv(Fn::kObjPropertyIsEnumerable);
    case KeyId::k_toLocaleString: return fnv(Fn::kObjToLocaleString);
    default: break;
  }
  return std::nullopt;
}

// ── Calls ───────────────────────────────────────────────────────────────────

namespace {

Value call_math(Interp& in, Fn fn, Args a) {
  namespace js = motion::js;
  const auto x = [&]() { return to_number(a[0]); };
  switch (fn) {
    case Fn::kMathAbs: return Value::number(std::fabs(x()));
    case Fn::kMathAcos: return Value::number(js::acos(x()));
    case Fn::kMathAcosh: return Value::number(js::acosh(x()));
    case Fn::kMathAsin: return Value::number(js::asin(x()));
    case Fn::kMathAsinh: return Value::number(js::asinh(x()));
    case Fn::kMathAtan: return Value::number(js::atan(x()));
    case Fn::kMathAtanh: return Value::number(js::atanh(x()));
    case Fn::kMathAtan2: {
      const double y = to_number(a[0]);
      return Value::number(js::atan2(y, to_number(a[1])));
    }
    case Fn::kMathCeil: return Value::number(std::ceil(x()));
    case Fn::kMathCbrt: return Value::number(js::cbrt(x()));
    case Fn::kMathExpm1: return Value::number(js::expm1(x()));
    case Fn::kMathClz32: return Value::number(js::clz32(x()));
    case Fn::kMathCos: return Value::number(js::cos(x()));
    case Fn::kMathCosh: return Value::number(js::cosh(x()));
    case Fn::kMathExp: return Value::number(js::exp(x()));
    case Fn::kMathFloor: return Value::number(std::floor(x()));
    case Fn::kMathFround: return Value::number(js::fround(x()));
    case Fn::kMathF16round: return Value::number(f16round(x()));
    case Fn::kMathHypot:
    case Fn::kMathMax:
    case Fn::kMathMin: {
      std::vector<double> v;
      v.reserve(a.size());
      for (const Value& e : a.span()) v.push_back(to_number(e));
      if (fn == Fn::kMathHypot) return Value::number(js::hypot(v));
      return Value::number(fn == Fn::kMathMax ? js::max_of(v) : js::min_of(v));
    }
    case Fn::kMathImul: {
      const double p = to_number(a[0]);
      return Value::number(js::imul(p, to_number(a[1])));
    }
    case Fn::kMathLog: return Value::number(js::log(x()));
    case Fn::kMathLog1p: return Value::number(js::log1p(x()));
    case Fn::kMathLog2: return Value::number(js::log2(x()));
    case Fn::kMathLog10: return Value::number(js::log10(x()));
    case Fn::kMathPow: {
      const double b = to_number(a[0]);
      return Value::number(js::pow(b, to_number(a[1])));
    }
    case Fn::kMathRandom: {
      // NON-DETERMINISTIC in the TypeScript (it is V8's Math.random), which the
      // determinism rule forbids in rendering. The port answers from a
      // separate seeded sequence — reproducible, never equal to the TS.
      // Flagged in native/README.md; excluded from the golden table.
      (void)in;
      static thread_local double counter = 0;  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)
      counter += 1;
      return Value::number(hash01(counter * 71.3 + 0.5));
    }
    case Fn::kMathRound: return Value::number(js::round(x()));
    case Fn::kMathSign: return Value::number(js::sign(x()));
    case Fn::kMathSin: return Value::number(js::sin(x()));
    case Fn::kMathSinh: return Value::number(js::sinh(x()));
    case Fn::kMathSqrt: return Value::number(std::sqrt(x()));
    case Fn::kMathTan: return Value::number(js::tan(x()));
    case Fn::kMathTanh: return Value::number(js::tanh(x()));
    case Fn::kMathTrunc: return Value::number(std::trunc(x()));
    default: break;
  }
  return {};
}

Value call_number(Interp& in, Fn fn, const Value& t, Args a) {
  static constexpr std::array<std::string_view, 5> kNames = {"toFixed", "toPrecision", "toExponential",
                                                             "toString", "valueOf"};
  if (!t.is_number()) {
    const auto i = static_cast<std::size_t>(fn) - static_cast<std::size_t>(Fn::kNumToFixed);
    throw_eval(u"Number.prototype." + ascii(kNames[i]) + u" requires that 'this' be a Number");
  }
  const double x = t.n;
  switch (fn) {
    case Fn::kNumToFixed: {
      const double f = integer_or_infinity(to_number(a[0]));
      if (!is_finite(f) || f < 0 || f > 100) throw_range(u"toFixed() digits argument must be between 0 and 100");
      const std::string s = motion::js::to_fixed(x, static_cast<int>(f));
      return in.str({s.begin(), s.end()});
    }
    case Fn::kNumToPrecision: {
      if (a[0].is_undefined()) return in.str(number_to_str(x));
      const double p = integer_or_infinity(to_number(a[0]));
      if (!is_finite(x)) return in.str(number_to_str(x));
      if (p < 1 || p > 100) throw_range(u"toPrecision() argument must be between 1 and 100");
      const std::string s = motion::js::to_precision(x, static_cast<int>(p));
      return in.str({s.begin(), s.end()});
    }
    case Fn::kNumToExponential: {
      const double f = integer_or_infinity(to_number(a[0]));
      if (!is_finite(x)) return in.str(number_to_str(x));
      if (f < 0 || f > 100) throw_range(u"toExponential() argument must be between 0 and 100");
      const std::string s = motion::js::to_exponential(x, a[0].is_undefined() ? -1 : static_cast<int>(f));
      return in.str({s.begin(), s.end()});
    }
    case Fn::kNumToString: {
      double radix = 10;
      if (!a[0].is_undefined()) radix = integer_or_infinity(to_number(a[0]));
      if (radix < 2 || radix > 36) throw_range(u"toString() radix argument must be between 2 and 36");
      if (radix == 10) return in.str(number_to_str(x));
      const std::string s = motion::js::number_to_radix(x, static_cast<int>(radix));
      return in.str({s.begin(), s.end()});
    }
    default:
      return t;  // valueOf
  }
}

Value call_string(Interp& in, const Obj& f, Fn fn, const Value& t, Args a) {
  switch (fn) {
    case Fn::kStrToString:
    case Fn::kStrValueOf: {
      if (t.tag == Tag::kString) return t;
      if (t.tag == Tag::kObject && t.o->kind == ObjKind::kStringObject) return Value::string(t.o->str);
      throw_eval(Str(u"String.prototype.") + (fn == Fn::kStrToString ? u"toString" : u"valueOf") +
                 u" requires that 'this' be a String");
    }
    default:
      break;
  }
  static constexpr std::array<std::string_view, 28> kNames = {
      "at",       "charAt",      "charCodeAt",  "codePointAt", "concat",  "endsWith",   "includes",
      "indexOf",  "lastIndexOf", "padEnd",      "padStart",    "repeat",  "replace",    "replaceAll",
      "slice",    "split",       "startsWith",  "substr",      "substring", "toLowerCase", "toUpperCase",
      "toString", "valueOf",     "trim",        "trimStart",   "trimEnd", "isWellFormed", "html"};
  const Str s = this_string(t, kNames[static_cast<std::size_t>(fn) - static_cast<std::size_t>(Fn::kStrAt)]);
  const auto len = static_cast<double>(s.size());
  const auto sub = [&](double from, double to) {
    return in.str(s.substr(static_cast<std::size_t>(from), static_cast<std::size_t>(to - from)));
  };
  switch (fn) {
    case Fn::kStrAt: {
      const double rel = integer_or_infinity(to_number(a[0]));
      const double k = rel >= 0 ? rel : len + rel;
      if (k < 0 || k >= len) return {};
      return sub(k, k + 1);
    }
    case Fn::kStrCharAt: {
      const double p = integer_or_infinity(to_number(a[0]));
      if (p < 0 || p >= len) return in.str(u"");
      return sub(p, p + 1);
    }
    case Fn::kStrCharCodeAt: {
      const double p = integer_or_infinity(to_number(a[0]));
      if (p < 0 || p >= len) return Value::number(motion::js::kNaN);
      return Value::number(static_cast<double>(s[static_cast<std::size_t>(p)]));
    }
    case Fn::kStrCodePointAt: {
      const double p = integer_or_infinity(to_number(a[0]));
      if (p < 0 || p >= len) return {};
      const auto i = static_cast<std::size_t>(p);
      const char16_t first = s[i];
      if (first >= 0xD800 && first <= 0xDBFF && i + 1 < s.size() && s[i + 1] >= 0xDC00 && s[i + 1] <= 0xDFFF) {
        return Value::number(static_cast<double>(((first - 0xD800U) << 10U) + (s[i + 1] - 0xDC00U) + 0x10000U));
      }
      return Value::number(static_cast<double>(first));
    }
    case Fn::kStrConcat: {
      Str out = s;
      for (const Value& v : a.span()) out += to_string(v);
      return in.str(std::move(out));
    }
    case Fn::kStrEndsWith:
    case Fn::kStrStartsWith:
    case Fn::kStrIncludes:
    case Fn::kStrIndexOf: {
      const Str search = to_string(a[0]);
      const auto slen = static_cast<double>(search.size());
      if (fn == Fn::kStrEndsWith) {
        const double end = a[1].is_undefined() ? len : clamp_d(integer_or_infinity(to_number(a[1])), 0, len);
        const double start = end - slen;
        if (start < 0) return Value::boolean(false);
        return Value::boolean(s.compare(static_cast<std::size_t>(start), search.size(), search) == 0);
      }
      const double pos = clamp_d(integer_or_infinity(to_number(a[1])), 0, len);
      if (fn == Fn::kStrStartsWith) {
        if (pos + slen > len) return Value::boolean(false);
        return Value::boolean(s.compare(static_cast<std::size_t>(pos), search.size(), search) == 0);
      }
      const auto found = find_from(s, search, static_cast<std::size_t>(pos));
      if (fn == Fn::kStrIncludes) return Value::boolean(found.has_value());
      return Value::number(found ? static_cast<double>(*found) : -1.0);
    }
    case Fn::kStrLastIndexOf: {
      const Str search = to_string(a[0]);
      const double num_pos = to_number(a[1]);
      const double pos = std::isnan(num_pos) ? motion::js::kInf : integer_or_infinity(num_pos);
      const double start = clamp_d(pos, 0, len);
      const auto slen = static_cast<double>(search.size());
      if (slen > len) return Value::number(-1);
      for (auto i = static_cast<std::ptrdiff_t>(std::min(start, len - slen)); i >= 0; --i) {
        if (s.compare(static_cast<std::size_t>(i), search.size(), search) == 0) {
          return Value::number(static_cast<double>(i));
        }
      }
      return Value::number(-1);
    }
    case Fn::kStrPadEnd:
    case Fn::kStrPadStart: {
      const double max_len = to_length(to_number(a[0]));
      if (max_len <= len) return in.str(s);
      const Str filler = a[1].is_undefined() ? Str(u" ") : to_string(a[1]);
      if (filler.empty()) return in.str(s);
      if (max_len > kMaxStringLength) throw_range(u"Invalid string length");
      const auto fill_len = static_cast<std::size_t>(max_len - len);
      Str pad;
      while (pad.size() < fill_len) pad += filler;
      pad.resize(fill_len);
      return in.str(fn == Fn::kStrPadEnd ? s + pad : pad + s);
    }
    case Fn::kStrRepeat: {
      const double n = integer_or_infinity(to_number(a[0]));
      if (n < 0 || std::isinf(n)) throw_range(u"Invalid count value: " + number_to_str(to_number(a[0])));
      if (n == 0 || s.empty()) return in.str(u"");
      if (n * len > kMaxStringLength) throw_range(u"Invalid string length");
      Str out;
      out.reserve(static_cast<std::size_t>(n * len));
      for (auto i = static_cast<std::size_t>(n); i > 0; --i) out += s;
      return in.str(std::move(out));
    }
    case Fn::kStrReplace:
    case Fn::kStrReplaceAll: {
      const Str search = to_string(a[0]);
      const bool functional = is_callable(a[1]);
      const Str replace = functional ? Str() : to_string(a[1]);
      std::vector<std::size_t> positions;
      if (fn == Fn::kStrReplace) {
        if (const auto p = find_from(s, search, 0)) positions.push_back(*p);
      } else {
        const std::size_t adv = std::max<std::size_t>(1, search.size());
        auto p = find_from(s, search, 0);
        while (p) {
          positions.push_back(*p);
          p = find_from(s, search, *p + adv);
        }
      }
      if (positions.empty()) return in.str(s);
      Str out;
      std::size_t end_of_last = 0;
      for (const std::size_t p : positions) {
        Str replacement;
        if (functional) {
          const std::array<Value, 3> args = {in.str(search), Value::number(static_cast<double>(p)), in.str(s)};
          replacement = to_string(in.call(a[1], Value{}, Args(args)));
        } else {
          replacement = substitution(search, s, p, replace);
        }
        out += s.substr(end_of_last, p - end_of_last);
        out += replacement;
        end_of_last = p + search.size();
      }
      if (end_of_last < s.size()) out += s.substr(end_of_last);
      return in.str(std::move(out));
    }
    case Fn::kStrSlice: {
      const double from = relative_index(a[0], len, 0);
      const double to = relative_index(a[1], len, len);
      if (from >= to) return in.str(u"");
      return sub(from, to);
    }
    case Fn::kStrSplit: {
      const double lim = a[1].is_undefined() ? 4294967295.0 : static_cast<double>(motion::js::to_uint32(to_number(a[1])));
      const Str r = to_string(a[0]);
      std::vector<Value> out;
      if (lim == 0) return in.array({});
      if (a[0].is_undefined()) return in.array({in.str(s)});
      if (r.empty()) {
        for (std::size_t i = 0; i < s.size() && static_cast<double>(out.size()) < lim; ++i) {
          out.push_back(in.str(Str(1, s[i])));
        }
        return in.array(std::move(out));
      }
      if (s.empty()) return in.array({in.str(s)});
      std::size_t p = 0;
      std::size_t q = s.find(r, p);
      while (q != Str::npos) {
        out.push_back(in.str(s.substr(p, q - p)));
        if (static_cast<double>(out.size()) >= lim) return in.array(std::move(out));
        p = q + r.size();
        q = s.find(r, p);
      }
      out.push_back(in.str(s.substr(p)));
      return in.array(std::move(out));
    }
    case Fn::kStrSubstr: {
      double start = integer_or_infinity(to_number(a[0]));
      if (start == -motion::js::kInf) {
        start = 0;
      } else if (start < 0) {
        start = std::max(len + start, 0.0);
      } else {
        start = std::min(start, len);
      }
      const double length = a[1].is_undefined() ? len : clamp_d(integer_or_infinity(to_number(a[1])), 0, len);
      const double end = std::min(start + length, len);
      if (start >= end) return in.str(u"");
      return sub(start, end);
    }
    case Fn::kStrSubstring: {
      const double st = clamp_d(integer_or_infinity(to_number(a[0])), 0, len);
      const double en = a[1].is_undefined() ? len : clamp_d(integer_or_infinity(to_number(a[1])), 0, len);
      return sub(std::min(st, en), std::max(st, en));
    }
    case Fn::kStrToLowerCase:
    case Fn::kStrToUpperCase: {
      Str out;
      out.reserve(s.size());
      for (const char16_t c : s) {
        if (fn == Fn::kStrToLowerCase) {
          lower_into(out, c);
        } else {
          upper_into(out, c);
        }
      }
      return in.str(std::move(out));
    }
    case Fn::kStrTrim:
    case Fn::kStrTrimStart:
    case Fn::kStrTrimEnd: {
      std::size_t b = 0;
      std::size_t e = s.size();
      if (fn != Fn::kStrTrimEnd) {
        while (b < e && is_ws(s[b])) ++b;
      }
      if (fn != Fn::kStrTrimStart) {
        while (e > b && is_ws(s[e - 1])) --e;
      }
      return in.str(s.substr(b, e - b));
    }
    case Fn::kStrHtml: {
      // Annex B CreateHTML: <tag attr="value">s</tag>, `"` escaped as &quot;.
      const auto kid = static_cast<KeyId>(f.state);
      std::u16string_view tag;
      std::u16string_view attr;
      switch (kid) {
        case KeyId::k_anchor: tag = u"a"; attr = u"name"; break;
        case KeyId::k_big: tag = u"big"; break;
        case KeyId::k_blink: tag = u"blink"; break;
        case KeyId::k_bold: tag = u"b"; break;
        case KeyId::k_fixed: tag = u"tt"; break;
        case KeyId::k_fontcolor: tag = u"font"; attr = u"color"; break;
        case KeyId::k_fontsize: tag = u"font"; attr = u"size"; break;
        case KeyId::k_italics: tag = u"i"; break;
        case KeyId::k_link: tag = u"a"; attr = u"href"; break;
        case KeyId::k_small: tag = u"small"; break;
        case KeyId::k_strike: tag = u"strike"; break;
        case KeyId::k_sub: tag = u"sub"; break;
        default: tag = u"sup"; break;
      }
      Str out = u"<" + Str(tag);
      if (!attr.empty()) {
        Str v;
        for (const char16_t c : to_string(a[0])) {
          if (c == u'"') {
            v += u"&quot;";
          } else {
            v += c;
          }
        }
        out += u" " + Str(attr) + u"=\"" + v + u"\"";
      }
      return in.str(out + u">" + s + u"</" + Str(tag) + u">");
    }
    case Fn::kStrIsWellFormed: {
      for (std::size_t i = 0; i < s.size(); ++i) {
        const char16_t c = s[i];
        if (c >= 0xD800 && c <= 0xDBFF) {
          if (i + 1 < s.size() && s[i + 1] >= 0xDC00 && s[i + 1] <= 0xDFFF) {
            ++i;
            continue;
          }
          return Value::boolean(false);
        }
        if (c >= 0xDC00 && c <= 0xDFFF) return Value::boolean(false);
      }
      return Value::boolean(true);
    }
    default:
      break;
  }
  return {};
}

/// V8's Array.prototype.sort for a user comparator (third_party/v8/builtins/
/// array-sort.tq): TimSort, which for fewer than 64 elements is ONE run —
/// CountAndMakeRun, then BinaryInsertionSort — so the comparator is called in
/// exactly V8's order and an inconsistent comparator gives V8's result.
/// Longer arrays use a stable merge sort: the same result for any consistent
/// comparator (documented divergence only for inconsistent ones, n >= 64).
template <class Cmp>
void v8_sort(std::vector<Value>& a, const Cmp& compare) {
  const std::size_t n = a.size();
  if (n < 2) return;
  if (n >= 64) {
    std::vector<Value> tmp(n);
    for (std::size_t width = 1; width < n; width *= 2) {
      for (std::size_t lo = 0; lo < n; lo += 2 * width) {
        const std::size_t mid = std::min(lo + width, n);
        const std::size_t hi = std::min(lo + 2 * width, n);
        std::size_t i = lo;
        std::size_t j = mid;
        std::size_t k = lo;
        while (i < mid && j < hi) tmp[k++] = compare(a[j], a[i]) < 0 ? a[j++] : a[i++];
        while (i < mid) tmp[k++] = a[i++];
        while (j < hi) tmp[k++] = a[j++];
      }
      a.swap(tmp);
    }
    return;
  }
  // CountAndMakeRun(0, n)
  std::size_t run = 2;
  const bool descending = compare(a[1], a[0]) < 0;
  for (std::size_t idx = 2; idx < n; ++idx) {
    const double order = compare(a[idx], a[idx - 1]);
    if (descending ? !(order < 0) : order < 0) break;
    ++run;
  }
  if (descending) std::reverse(a.begin(), a.begin() + static_cast<std::ptrdiff_t>(run));  // NOLINT(modernize-use-ranges)
  // BinaryInsertionSort(0, run, n)
  for (std::size_t start = run; start < n; ++start) {
    std::size_t left = 0;
    std::size_t right = start;
    const Value pivot = a[start];
    while (left < right) {
      const std::size_t mid = left + ((right - left) >> 1U);
      if (compare(pivot, a[mid]) < 0) {
        right = mid;
      } else {
        left = mid + 1;
      }
    }
    for (std::size_t p = start; p > left; --p) a[p] = a[p - 1];
    a[left] = pivot;
  }
}

/// SameValueZero (Array.prototype.includes).
bool same_value_zero(const Value& a, const Value& b) {
  if (a.is_number() && b.is_number() && std::isnan(a.n) && std::isnan(b.n)) return true;
  return strict_equals(a, b);
}

void flatten_into(std::vector<Value>& out, const std::vector<Value>& src, double depth) {
  for (const Value& v : src) {
    if (depth > 0 && is_array(v)) {
      flatten_into(out, v.o->elems, depth - 1);
    } else {
      out.push_back(v);
    }
  }
}

Value call_array(Interp& in, Fn fn, const Value& t, Args a) {
  static constexpr std::array<std::string_view, 28> kNames = {
      "at",          "concat",  "every",   "fill",   "filter", "find",        "findIndex",
      "findLast",    "findLastIndex", "flat", "includes", "indexOf", "join",   "lastIndexOf",
      "map",         "pop",     "push",    "reduce", "reduceRight", "reverse", "shift",
      "slice",       "some",    "sort",    "toString", "unshift", "forEach",  "toReversed"};
  const std::string_view name = kNames[static_cast<std::size_t>(fn) - static_cast<std::size_t>(Fn::kArrAt)];
  std::vector<Value>& e = this_array(t, name);
  const auto len = static_cast<double>(e.size());
  const auto callback = [&]() -> const Value& {
    if (!is_callable(a[0])) throw_eval(to_string(a[0]) + u" is not a function");
    return a.span()[0];
  };
  const auto invoke = [&](const Value& cb, std::size_t i) {
    const std::array<Value, 3> args = {e[i], Value::number(static_cast<double>(i)), t};
    return in.call(cb, a[1], Args(args));
  };
  switch (fn) {
    case Fn::kArrAt: {
      const double rel = integer_or_infinity(to_number(a[0]));
      const double k = rel >= 0 ? rel : len + rel;
      if (k < 0 || k >= len) return {};
      return e[static_cast<std::size_t>(k)];
    }
    case Fn::kArrConcat: {
      std::vector<Value> out = e;
      for (const Value& v : a.span()) {
        if (is_array(v)) {
          out.insert(out.end(), v.o->elems.begin(), v.o->elems.end());
        } else {
          out.push_back(v);
        }
      }
      return in.array(std::move(out));
    }
    case Fn::kArrEvery:
    case Fn::kArrSome:
    case Fn::kArrFilter:
    case Fn::kArrFind:
    case Fn::kArrFindIndex:
    case Fn::kArrMap:
    case Fn::kArrForEach: {
      const Value& cb = callback();
      std::vector<Value> out;
      const std::size_t n = e.size();
      for (std::size_t i = 0; i < n && i < e.size(); ++i) {
        const Value r = invoke(cb, i);
        switch (fn) {
          case Fn::kArrEvery:
            if (!truthy(r)) return Value::boolean(false);
            break;
          case Fn::kArrSome:
            if (truthy(r)) return Value::boolean(true);
            break;
          case Fn::kArrFilter:
            if (truthy(r)) out.push_back(e[i]);
            break;
          case Fn::kArrFind:
            if (truthy(r)) return e[i];
            break;
          case Fn::kArrFindIndex:
            if (truthy(r)) return Value::number(static_cast<double>(i));
            break;
          case Fn::kArrMap:
            out.push_back(r);
            break;
          default:
            break;
        }
      }
      switch (fn) {
        case Fn::kArrEvery: return Value::boolean(true);
        case Fn::kArrSome: return Value::boolean(false);
        case Fn::kArrFind: return {};
        case Fn::kArrFindIndex: return Value::number(-1);
        case Fn::kArrForEach: return {};
        default: return in.array(std::move(out));
      }
    }
    case Fn::kArrFindLast:
    case Fn::kArrFindLastIndex: {
      const Value& cb = callback();
      for (std::size_t i = e.size(); i-- > 0;) {
        if (truthy(invoke(cb, i))) return fn == Fn::kArrFindLast ? e[i] : Value::number(static_cast<double>(i));
      }
      return fn == Fn::kArrFindLast ? Value{} : Value::number(-1);
    }
    case Fn::kArrFill: {
      const double from = relative_index(a[1], len, 0);
      const double to = relative_index(a[2], len, len);
      for (auto i = static_cast<std::size_t>(from); i < static_cast<std::size_t>(to); ++i) e[i] = a[0];
      return t;
    }
    case Fn::kArrFlat: {
      const double depth = a[0].is_undefined() ? 1 : integer_or_infinity(to_number(a[0]));
      std::vector<Value> out;
      flatten_into(out, e, depth);
      return in.array(std::move(out));
    }
    case Fn::kArrIncludes:
    case Fn::kArrIndexOf: {
      if (e.empty()) return fn == Fn::kArrIncludes ? Value::boolean(false) : Value::number(-1);
      double k = integer_or_infinity(to_number(a[1]));
      if (k < 0) k = std::max(len + k, 0.0);
      for (auto i = static_cast<std::size_t>(k); i < e.size(); ++i) {
        const Value& v = e[i];
        if (fn == Fn::kArrIncludes ? same_value_zero(v, a[0]) : strict_equals(v, a[0])) {
          return fn == Fn::kArrIncludes ? Value::boolean(true) : Value::number(static_cast<double>(i));
        }
      }
      return fn == Fn::kArrIncludes ? Value::boolean(false) : Value::number(-1);
    }
    case Fn::kArrLastIndexOf: {
      if (e.empty()) return Value::number(-1);
      double k = a.size() > 1 ? integer_or_infinity(to_number(a[1])) : len - 1;
      k = k >= 0 ? std::min(k, len - 1) : len + k;
      for (auto i = static_cast<std::ptrdiff_t>(k); i >= 0; --i) {
        if (strict_equals(e[static_cast<std::size_t>(i)], a[0])) return Value::number(static_cast<double>(i));
      }
      return Value::number(-1);
    }
    case Fn::kArrJoin:
    case Fn::kArrToString: {
      const Str sep = (fn == Fn::kArrToString || a[0].is_undefined()) ? Str(u",") : to_string(a[0]);
      return in.str(join(e, sep));
    }
    case Fn::kArrPop: {
      if (e.empty()) return {};
      Value v = e.back();
      e.pop_back();
      return v;
    }
    case Fn::kArrPush:
      for (const Value& v : a.span()) e.push_back(v);
      return Value::number(static_cast<double>(e.size()));
    case Fn::kArrShift: {
      if (e.empty()) return {};
      Value v = e.front();
      e.erase(e.begin());
      return v;
    }
    case Fn::kArrUnshift:
      e.insert(e.begin(), a.span().begin(), a.span().end());
      return Value::number(static_cast<double>(e.size()));
    case Fn::kArrReduce:
    case Fn::kArrReduceRight: {
      const Value& cb = callback();
      const bool right = fn == Fn::kArrReduceRight;
      std::size_t i = 0;
      const std::size_t n = e.size();
      Value acc;
      if (a.size() >= 2) {
        acc = a[1];
      } else {
        if (n == 0) throw_eval(u"Reduce of empty array with no initial value");
        acc = right ? e[n - 1] : e[0];
        i = 1;
      }
      for (; i < n; ++i) {
        const std::size_t k = right ? n - 1 - i : i;
        const std::array<Value, 4> args = {acc, e[k], Value::number(static_cast<double>(k)), t};
        acc = in.call(cb, Value{}, Args(args));
      }
      return acc;
    }
    case Fn::kArrReverse:
      std::ranges::reverse(e);
      return t;
    case Fn::kArrToReversed: {
      std::vector<Value> out(e.rbegin(), e.rend());
      return in.array(std::move(out));
    }
    case Fn::kArrSlice: {
      const double from = relative_index(a[0], len, 0);
      const double to = relative_index(a[1], len, len);
      std::vector<Value> out;
      for (auto i = static_cast<std::size_t>(from); i < static_cast<std::size_t>(to); ++i) out.push_back(e[i]);
      return in.array(std::move(out));
    }
    case Fn::kArrSort: {
      const Value cmp = a[0];
      if (!cmp.is_undefined() && !is_callable(cmp)) {
        throw_eval(u"The comparison function must be either a function or undefined");
      }
      // Undefined sorts last; the rest by comparator, or by ToString (code units).
      std::vector<Value> defined;
      std::size_t undefs = 0;
      for (const Value& v : e) {
        if (v.is_undefined()) {
          ++undefs;
        } else {
          defined.push_back(v);
        }
      }
      if (cmp.is_undefined()) {
        std::vector<std::pair<Str, Value>> keyed;
        keyed.reserve(defined.size());
        for (const Value& v : defined) keyed.emplace_back(to_string(v), v);
        std::ranges::stable_sort(keyed, [](const auto& x, const auto& y) { return x.first < y.first; });
        for (std::size_t i = 0; i < keyed.size(); ++i) defined[i] = keyed[i].second;
      } else {
        // A user comparator need not be a consistent ordering (`sort(Math.max)`
        // is legal JavaScript), so std::sort-family algorithms — which assume
        // one — are out. v8_sort reproduces V8's own algorithm.
        v8_sort(defined, [&](const Value& x, const Value& y) {
          const std::array<Value, 2> args = {x, y};
          return to_number(in.call(cmp, Value{}, Args(args)));
        });
      }
      for (std::size_t i = 0; i < undefs; ++i) defined.emplace_back();
      e = std::move(defined);
      return t;
    }
    default:
      break;
  }
  return {};
}

}  // namespace

Value call_std(Interp& in, const Obj& f, const Value& t, Args a) {
  const Fn fn = f.fn;
  if (fn >= Fn::kMathAbs && fn <= Fn::kMathF16round) return call_math(in, fn, a);
  if (fn >= Fn::kNumToFixed && fn <= Fn::kNumValueOf) return call_number(in, fn, t, a);
  if (fn >= Fn::kStrAt && fn <= Fn::kStrHtml) return call_string(in, f, fn, t, a);
  if (fn >= Fn::kArrAt && fn <= Fn::kArrToReversed) return call_array(in, fn, t, a);
  switch (fn) {
    case Fn::kBoolToString:
    case Fn::kBoolValueOf:
      if (t.tag != Tag::kBool) {
        throw_eval(Str(u"Boolean.prototype.") + (fn == Fn::kBoolToString ? u"toString" : u"valueOf") +
                   u" requires that 'this' be a Boolean");
      }
      return fn == Fn::kBoolToString ? in.str(t.b ? u"true" : u"false") : t;
    case Fn::kObjToString:
      return in.str(Str(object_to_string_tag(t)));
    case Fn::kObjValueOf:
      if (t.is_nullish()) throw_eval(u"Cannot convert undefined or null to object");
      return t;
    case Fn::kObjHasOwnProperty:
      return Value::boolean(has_own(t, a[0]));
    case Fn::kObjIsPrototypeOf:
      return Value::boolean(false);
    case Fn::kObjPropertyIsEnumerable: {
      const Str k = to_string(a[0]);
      if (key_of(k) == KeyId::k_length) return Value::boolean(false);
      return Value::boolean(has_own(t, a[0]));
    }
    case Fn::kObjToLocaleString: {
      const Value ts = in.read_member(t, in.str(u"toString"), KeyId::k_toString);
      if (!is_callable(ts)) throw_eval(u"toString is not a function");
      return in.call(ts, t, Args({}));
    }
    case Fn::kFnCall: {
      if (!is_callable(t)) throw_eval(u"Function.prototype.call called on a non-function");
      const std::span<const Value> rest = a.size() > 0 ? a.span().subspan(1) : std::span<const Value>{};
      return in.call(t, a[0], Args(rest));
    }
    case Fn::kFnApply: {
      if (!is_callable(t)) throw_eval(u"Function.prototype.apply was called on a non-function");
      const Value list = a[1];
      if (list.is_nullish()) return in.call(t, a[0], Args({}));
      if (!is_array(list)) throw_eval(u"CreateListFromArrayLike called on non-object");
      const std::vector<Value> args = list.o->elems;
      return in.call(t, a[0], Args(args));
    }
    case Fn::kFnToString:
      return in.str(u"function () { [native code] }");
    default:
      break;
  }
  return {};
}

}  // namespace motion::expr::detail

namespace motion::expr::detail {

namespace {

struct FnMeta {
  Fn fn = Fn::kNone;
  std::u16string_view name;
  double length = 0;
};
constexpr FnMeta M(Fn fn, std::u16string_view name, double length) {
  return {.fn = fn, .name = name, .length = length};
}

// `.name` / `.length`. Spec built-ins carry their spec values. The expression
// API's functions are TypeScript arrow functions: `name` is what V8 infers
// from the binding (`const wiggle = (...) =>` → "wiggle"; a property
// `key: (n) =>` → "key"; an arrow returned from a helper → ""), and `length`
// counts the parameters before the first DEFAULTED one (`t?: number` is not a
// default, so it counts).
constexpr std::array kMeta = {
    M(Fn::kWiggle, u"wiggle", 0), M(Fn::kClamp, u"clamp", 3), M(Fn::kLinear, u"linear", 5),
    M(Fn::kEase, u"ease", 5), M(Fn::kEaseIn, u"easeIn", 5), M(Fn::kEaseOut, u"easeOut", 5),
    M(Fn::kTimeToFrames, u"timeToFrames", 0), M(Fn::kFramesToTime, u"framesToTime", 1),
    M(Fn::kRandom, u"random", 2), M(Fn::kValueAtTime, u"valueAtTime", 1), M(Fn::kValueAtTimeText, u"", 1),
    M(Fn::kVelocityAtTime, u"velocityAtTime", 1), M(Fn::kLayer, u"layer", 2), M(Fn::kLayerAt, u"layerAt", 3),
    M(Fn::kLoopOut, u"loopOut", 0), M(Fn::kLoopIn, u"loopIn", 0), M(Fn::kSourceRectAtTime, u"sourceRectAtTime", 0),
    M(Fn::kToComp, u"toComp", 1), M(Fn::kToWorld, u"toWorld", 1), M(Fn::kFromComp, u"fromComp", 1),
    M(Fn::kFromWorld, u"fromWorld", 1), M(Fn::kSeedRandom, u"seedRandom", 1), M(Fn::kGaussRandom, u"gaussRandom", 0),
    M(Fn::kNoise, u"noise", 1), M(Fn::kKey, u"key", 1), M(Fn::kNearestKey, u"nearestKey", 0),
    M(Fn::kPosterizeTime, u"posterizeTime", 1), M(Fn::kAdd, u"add", 2), M(Fn::kSub, u"sub", 2), M(Fn::kMul, u"mul", 2),
    M(Fn::kDiv, u"div", 2), M(Fn::kDot, u"dot", 2), M(Fn::kCross, u"cross", 2), M(Fn::kLength, u"length", 2),
    M(Fn::kNormalize, u"normalize", 1), M(Fn::kCompLayer, u"layer", 2), M(Fn::kMarkerKey, u"key", 1),
    M(Fn::kMarkerNearestKey, u"nearestKey", 1), M(Fn::kGetStyleAt, u"value", 1), M(Fn::kStyleSetter, u"", 3),
    M(Fn::kStyleSetText, u"setText", 1),
    M(Fn::kMathAbs, u"abs", 1), M(Fn::kMathAcos, u"acos", 1), M(Fn::kMathAcosh, u"acosh", 1), M(Fn::kMathAsin, u"asin", 1),
    M(Fn::kMathAsinh, u"asinh", 1), M(Fn::kMathAtan, u"atan", 1), M(Fn::kMathAtanh, u"atanh", 1),
    M(Fn::kMathAtan2, u"atan2", 2), M(Fn::kMathCeil, u"ceil", 1), M(Fn::kMathCbrt, u"cbrt", 1), M(Fn::kMathExpm1, u"expm1", 1),
    M(Fn::kMathClz32, u"clz32", 1), M(Fn::kMathCos, u"cos", 1), M(Fn::kMathCosh, u"cosh", 1), M(Fn::kMathExp, u"exp", 1),
    M(Fn::kMathFloor, u"floor", 1), M(Fn::kMathFround, u"fround", 1), M(Fn::kMathHypot, u"hypot", 2),
    M(Fn::kMathImul, u"imul", 2), M(Fn::kMathLog, u"log", 1), M(Fn::kMathLog1p, u"log1p", 1), M(Fn::kMathLog2, u"log2", 1),
    M(Fn::kMathLog10, u"log10", 1), M(Fn::kMathMax, u"max", 2), M(Fn::kMathMin, u"min", 2), M(Fn::kMathPow, u"pow", 2),
    M(Fn::kMathRandom, u"random", 0), M(Fn::kMathRound, u"round", 1), M(Fn::kMathSign, u"sign", 1),
    M(Fn::kMathSin, u"sin", 1), M(Fn::kMathSinh, u"sinh", 1), M(Fn::kMathSqrt, u"sqrt", 1), M(Fn::kMathTan, u"tan", 1),
    M(Fn::kMathTanh, u"tanh", 1), M(Fn::kMathTrunc, u"trunc", 1), M(Fn::kMathF16round, u"f16round", 1),
    M(Fn::kObjToString, u"toString", 0), M(Fn::kObjValueOf, u"valueOf", 0), M(Fn::kObjHasOwnProperty, u"hasOwnProperty", 1),
    M(Fn::kObjIsPrototypeOf, u"isPrototypeOf", 1), M(Fn::kObjPropertyIsEnumerable, u"propertyIsEnumerable", 1),
    M(Fn::kObjToLocaleString, u"toLocaleString", 0), M(Fn::kFnCall, u"call", 1), M(Fn::kFnApply, u"apply", 2),
    M(Fn::kFnToString, u"toString", 0), M(Fn::kNumToFixed, u"toFixed", 1), M(Fn::kNumToPrecision, u"toPrecision", 1),
    M(Fn::kNumToExponential, u"toExponential", 1), M(Fn::kNumToString, u"toString", 1), M(Fn::kNumValueOf, u"valueOf", 0),
    M(Fn::kBoolToString, u"toString", 0), M(Fn::kBoolValueOf, u"valueOf", 0),
    M(Fn::kStrAt, u"at", 1), M(Fn::kStrCharAt, u"charAt", 1), M(Fn::kStrCharCodeAt, u"charCodeAt", 1),
    M(Fn::kStrCodePointAt, u"codePointAt", 1), M(Fn::kStrConcat, u"concat", 1), M(Fn::kStrEndsWith, u"endsWith", 1),
    M(Fn::kStrIncludes, u"includes", 1), M(Fn::kStrIndexOf, u"indexOf", 1), M(Fn::kStrLastIndexOf, u"lastIndexOf", 1),
    M(Fn::kStrPadEnd, u"padEnd", 1), M(Fn::kStrPadStart, u"padStart", 1), M(Fn::kStrRepeat, u"repeat", 1),
    M(Fn::kStrReplace, u"replace", 2), M(Fn::kStrReplaceAll, u"replaceAll", 2), M(Fn::kStrSlice, u"slice", 2),
    M(Fn::kStrSplit, u"split", 2), M(Fn::kStrStartsWith, u"startsWith", 1), M(Fn::kStrSubstr, u"substr", 2),
    M(Fn::kStrSubstring, u"substring", 2), M(Fn::kStrToLowerCase, u"toLowerCase", 0),
    M(Fn::kStrToUpperCase, u"toUpperCase", 0), M(Fn::kStrToString, u"toString", 0), M(Fn::kStrValueOf, u"valueOf", 0),
    M(Fn::kStrTrim, u"trim", 0), M(Fn::kStrTrimStart, u"trimStart", 0), M(Fn::kStrTrimEnd, u"trimEnd", 0),
    M(Fn::kStrIsWellFormed, u"isWellFormed", 0),
    M(Fn::kArrAt, u"at", 1), M(Fn::kArrConcat, u"concat", 1), M(Fn::kArrEvery, u"every", 1), M(Fn::kArrFill, u"fill", 1),
    M(Fn::kArrFilter, u"filter", 1), M(Fn::kArrFind, u"find", 1), M(Fn::kArrFindIndex, u"findIndex", 1),
    M(Fn::kArrFindLast, u"findLast", 1), M(Fn::kArrFindLastIndex, u"findLastIndex", 1), M(Fn::kArrFlat, u"flat", 0),
    M(Fn::kArrIncludes, u"includes", 1), M(Fn::kArrIndexOf, u"indexOf", 1), M(Fn::kArrJoin, u"join", 1),
    M(Fn::kArrLastIndexOf, u"lastIndexOf", 1), M(Fn::kArrMap, u"map", 1), M(Fn::kArrPop, u"pop", 0),
    M(Fn::kArrPush, u"push", 1), M(Fn::kArrReduce, u"reduce", 1), M(Fn::kArrReduceRight, u"reduceRight", 1),
    M(Fn::kArrReverse, u"reverse", 0), M(Fn::kArrShift, u"shift", 0), M(Fn::kArrSlice, u"slice", 2),
    M(Fn::kArrSome, u"some", 1), M(Fn::kArrSort, u"sort", 1), M(Fn::kArrToString, u"toString", 0),
    M(Fn::kArrUnshift, u"unshift", 1), M(Fn::kArrForEach, u"forEach", 1), M(Fn::kArrToReversed, u"toReversed", 0),
};

std::u16string_view html_name(const Obj& f) { return key_name(static_cast<KeyId>(f.state)); }

}  // namespace

std::u16string_view function_name(const Obj& f, const Context& ctx) {
  if (f.fn == Fn::kCtrl) return (ctx.host != nullptr && ctx.host->has_ctrl()) ? u"ctrl" : u"";
  if (f.fn == Fn::kStrHtml) return html_name(f);
  for (const FnMeta& m : kMeta) {
    if (m.fn == f.fn) return m.name;
  }
  return u"";
}

double function_length(const Obj& f, const Context& ctx) {
  if (f.fn == Fn::kCtrl) return (ctx.host != nullptr && ctx.host->has_ctrl()) ? 1 : 0;
  if (f.fn == Fn::kStrHtml) {
    const auto k = static_cast<KeyId>(f.state);
    return (k == KeyId::k_anchor || k == KeyId::k_fontcolor || k == KeyId::k_fontsize || k == KeyId::k_link) ? 1 : 0;
  }
  for (const FnMeta& m : kMeta) {
    if (m.fn == f.fn) return m.length;
  }
  return 0;
}

}  // namespace motion::expr::detail
