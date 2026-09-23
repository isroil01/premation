// motion_expr internals — JavaScript values as the interpreter sees them.
//
// The language is a JavaScript-expression subset, so its values are
// JavaScript's: undefined, null, boolean, number, string, and objects (arrays,
// plain objects, functions, the Math object, String objects for
// text.sourceText, and the style objects of sourceText.ts).
//
// Ownership: an evaluation allocates its strings and objects in an `Arena`
// that lives exactly as long as the evaluation (Value holds non-owning
// pointers into it, or into the Program for string literals). Nothing escapes
// an evaluation except the final Result, which is converted to plain data
// before the arena dies. A purely numeric expression allocates nothing.

#ifndef MOTION_EXPR_VALUE_HPP
#define MOTION_EXPR_VALUE_HPP

#include <array>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "expr.hpp"

namespace motion::expr::detail {

using Str = std::u16string;

// ── Property names ──────────────────────────────────────────────────────────

enum class KeyId : std::uint8_t {
  kUnknown = 0,
#define K(id) k_##id,      // NOLINT(cppcoreguidelines-macro-usage) — X-macro over keys.def
#define KN(id, name) id,  // NOLINT(cppcoreguidelines-macro-usage)
#include "keys.def"
#undef K
#undef KN
  kCount_
};
static_assert(static_cast<unsigned>(KeyId::kCount_) <= 255, "KeyId outgrew a byte: widen its base type");

/// Resolve a property name (UTF-16) to its KeyId, kUnknown if not a known name.
[[nodiscard]] KeyId key_of(std::u16string_view name) noexcept;
/// The property name of a KeyId (ASCII, static storage).
[[nodiscard]] std::u16string_view key_name(KeyId k) noexcept;

// ── The global scope (expressions.ts `scope` Map, in its order) ─────────────

enum class Global : std::int8_t {
  kNone = -1,
  kTime, kValue, kAudio, kCtrl, kWiggle, kClamp, kLinear, kEase, kEaseIn, kEaseOut,
  kTimeToFrames, kFramesToTime, kRandom, kMath, kValueAtTime, kVelocity, kSpeed,
  kVelocityAtTime, kLayer, kLayerAt, kLoopOut, kLoopIn, kThisComp, kThisLayer,
  kThisProperty, kSourceRectAtTime, kToComp, kToWorld, kFromComp, kFromWorld,
  kSeedRandom, kGaussRandom, kNoise, kNumKeys, kKey, kNearestKey, kMarker,
  kPosterizeTime, kAdd, kSub, kMul, kDiv, kDot, kCross, kLength, kNormalize, kText,
  kPlugin,
  kCount_
};

[[nodiscard]] Global global_of(std::u16string_view name) noexcept;

// ── Builtin functions ───────────────────────────────────────────────────────

enum class Fn : std::uint8_t {
  kNone,
  // expressions.ts API
  kCtrl, kWiggle, kClamp, kLinear, kEase, kEaseIn, kEaseOut, kTimeToFrames, kFramesToTime,
  kRandom, kValueAtTime, kValueAtTimeText, kVelocityAtTime, kLayer, kLayerAt, kLoopOut,
  kLoopIn, kSourceRectAtTime, kToComp, kToWorld, kFromComp, kFromWorld, kSeedRandom,
  kGaussRandom, kNoise, kKey, kNearestKey, kPosterizeTime, kAdd, kSub, kMul, kDiv, kDot,
  kCross, kLength, kNormalize, kCompLayer, kMarkerKey, kMarkerNearestKey,
  // sourceText.ts
  kGetStyleAt, kStyleSetter, kStyleSetText,
  // Math
  kMathAbs, kMathAcos, kMathAcosh, kMathAsin, kMathAsinh, kMathAtan, kMathAtanh, kMathAtan2,
  kMathCeil, kMathCbrt, kMathExpm1, kMathClz32, kMathCos, kMathCosh, kMathExp, kMathFloor,
  kMathFround, kMathHypot, kMathImul, kMathLog, kMathLog1p, kMathLog2, kMathLog10, kMathMax,
  kMathMin, kMathPow, kMathRandom, kMathRound, kMathSign, kMathSin, kMathSinh, kMathSqrt,
  kMathTan, kMathTanh, kMathTrunc, kMathF16round,
  // Object.prototype / Function.prototype
  kObjToString, kObjValueOf, kObjHasOwnProperty, kObjIsPrototypeOf, kObjPropertyIsEnumerable,
  kObjToLocaleString, kFnCall, kFnApply, kFnToString,
  // Number.prototype / Boolean.prototype
  kNumToFixed, kNumToPrecision, kNumToExponential, kNumToString, kNumValueOf,
  kBoolToString, kBoolValueOf,
  // String.prototype
  kStrAt, kStrCharAt, kStrCharCodeAt, kStrCodePointAt, kStrConcat, kStrEndsWith, kStrIncludes,
  kStrIndexOf, kStrLastIndexOf, kStrPadEnd, kStrPadStart, kStrRepeat, kStrReplace,
  kStrReplaceAll, kStrSlice, kStrSplit, kStrStartsWith, kStrSubstr, kStrSubstring,
  kStrToLowerCase, kStrToUpperCase, kStrToString, kStrValueOf, kStrTrim, kStrTrimStart,
  kStrTrimEnd, kStrIsWellFormed, kStrHtml,
  // Array.prototype
  kArrAt, kArrConcat, kArrEvery, kArrFill, kArrFilter, kArrFind, kArrFindIndex, kArrFindLast,
  kArrFindLastIndex, kArrFlat, kArrIncludes, kArrIndexOf, kArrJoin, kArrLastIndexOf, kArrMap,
  kArrPop, kArrPush, kArrReduce, kArrReduceRight, kArrReverse, kArrShift, kArrSlice, kArrSome,
  kArrSort, kArrToString, kArrUnshift, kArrForEach, kArrToReversed,
  kCount_
};

// ── Values ──────────────────────────────────────────────────────────────────

enum class Tag : std::uint8_t { kUndefined, kNull, kBool, kNumber, kString, kObject };

struct Obj;

struct Value {
  Tag tag = Tag::kUndefined;
  bool b = false;
  double n = 0;
  const Str* s = nullptr;
  Obj* o = nullptr;

  [[nodiscard]] static Value undefined() noexcept { return {}; }
  [[nodiscard]] static Value null() noexcept { return {.tag = Tag::kNull}; }
  [[nodiscard]] static Value boolean(bool v) noexcept { return {.tag = Tag::kBool, .b = v}; }
  [[nodiscard]] static Value number(double v) noexcept { return {.tag = Tag::kNumber, .n = v}; }
  [[nodiscard]] static Value string(const Str* v) noexcept { return {.tag = Tag::kString, .s = v}; }
  [[nodiscard]] static Value object(Obj* v) noexcept { return {.tag = Tag::kObject, .o = v}; }

  [[nodiscard]] bool is_undefined() const noexcept { return tag == Tag::kUndefined; }
  [[nodiscard]] bool is_null() const noexcept { return tag == Tag::kNull; }
  [[nodiscard]] bool is_nullish() const noexcept { return tag == Tag::kUndefined || tag == Tag::kNull; }
  [[nodiscard]] bool is_number() const noexcept { return tag == Tag::kNumber; }
  [[nodiscard]] bool is_string() const noexcept { return tag == Tag::kString; }
  [[nodiscard]] bool is_object() const noexcept { return tag == Tag::kObject; }
};

enum class ObjKind : std::uint8_t {
  kArray,        // elems
  kPlain,        // props (and lazy props: see Prop::lazy)
  kFunction,     // fn (+ bound, aux)
  kMath,         // the Math object
  kStringObject, // text.sourceText: a String object (str) carrying style state
  kStyle,        // the chainable style object (state)
};

/// A lazily computed property (a JavaScript getter in the TypeScript).
enum class Lazy : std::uint8_t { kNone, kMarkerNumKeys, kSourceText };

struct Prop {
  KeyId key = KeyId::kUnknown;
  Value value;
  Lazy lazy = Lazy::kNone;
};

struct Obj {
  ObjKind kind = ObjKind::kPlain;
  Fn fn = Fn::kNone;
  std::uint8_t aux = 0;        // function: marker scope / style setter id
  std::vector<Value> elems;    // kArray
  std::vector<Prop> props;     // kPlain
  Value bound;                 // function: bound layer name (or null) / marker scope object
  const Str* str = nullptr;    // kStringObject: the primitive
  std::size_t state = 0;       // kStringObject / kStyle / kGetStyleAt / setters: index into Arena::styles
  Obj* memo = nullptr;         // lazy memo (marker list, sourceText value)
  int lazy_arg = 0;            // marker scope for kMarkerNumKeys
};

// ── Source Text style state (sourceText.ts StyleState) ──────────────────────

struct StyleState {
  const SourceTextSample* base = nullptr;
  Str text;
  SourceTextStyleOverrides style;
  std::vector<SourceTextRangeOverride> ranges;
  std::optional<double> at;
  bool text_set = false;
  bool foreign = false;
};

/// One evaluation's allocations. Deques keep addresses stable.
struct Arena {
  std::deque<Str> strings;
  std::deque<Obj> objects;
  std::deque<StyleState> styles;
  std::deque<SourceTextSample> samples;  // samples fetched from the host during the evaluation

  const Str* str(Str s) { return &strings.emplace_back(std::move(s)); }
  Obj* obj(ObjKind k) {
    Obj& o = objects.emplace_back();
    o.kind = k;
    return &o;
  }
};

}  // namespace motion::expr::detail

#endif  // MOTION_EXPR_VALUE_HPP
