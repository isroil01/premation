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

enum class KeyId : std::uint16_t {
  kUnknown = 0,
#define K(id) k_##id,      // NOLINT(cppcoreguidelines-macro-usage) — X-macro over keys.def
#define KN(id, name) id,  // NOLINT(cppcoreguidelines-macro-usage)
#include "keys.def"
#undef K
#undef KN
  kCount_
};
static_assert(static_cast<unsigned>(KeyId::kCount_) <= 65535, "KeyId outgrew two bytes: widen its base type");

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
  kLookAt,  // camera program D6
  // AE-style rigs: thisLayer's members in scope by their bare names
  kEffect, kTransform, kInPoint, kOutPoint, kIndex, kParent, kHasParent, kPosition, kAnchorPoint, kScale,
  kRotation, kOpacity, kStartTime,
  // AE globals (2026-10-21)
  kDegreesToRadians, kRadiansToDegrees, kHslToRgb, kRgbToHsl, kSmooth, kTemporalWiggle, kComp,
  kTimeToTimecode, kTimeToCurrentFormat,
  // AE: loop the last / first `duration` seconds (2026-10-29)
  kLoopOutDuration, kLoopInDuration,
  // AE's data footage: footage("name").sourceData / dataValue (2026-10-29)
  kFootage,
  kCreatePath, kMask, kContent,
  // AE: layer.sampleImage (2026-10-29)
  kSampleImage,
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
  // cameras and lights (camera program D6)
  kLookAt, kToCompVec, kFromCompToSurface,
  // AE-style rigs: layer.effect("Name"), the effect object (callable), its .param()
  kEffect, kEffectParam, kEffectParamMethod,
  // AE globals and property objects (2026-10-21): conversions, smooth / temporalWiggle,
  // comp("Name") and its layer(), and the methods of a layer / effect property object
  kDegreesToRadians, kRadiansToDegrees, kHslToRgb, kRgbToHsl, kSmooth, kTemporalWiggle, kComp, kCompByNameLayer,
  kTimeToTimecode, kTimeToCurrentFormat, kLoopOutDuration, kLoopInDuration,
  kFootage, kFootageDataValue, kFootageDataKeyCount,
  // AE path properties (path.cpp): createPath, a path's methods, layer.mask() / layer.content()
  kCreatePath, kPathPoints, kPathInTangents, kPathOutTangents, kPathIsClosed, kPathPointOnPath, kPathTangentOnPath,
  kPathNormalOnPath, kLayerMask, kLayerContent,
  kSampleImage,
  kPropValueAtTime, kPropVelocityAtTime, kPropKey, kPropNearestKey, kPropSmooth,
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
struct Env;

/// "No node" — a Node link that points nowhere (program.hpp uses the same).
inline constexpr std::uint32_t kNoNode = 0xffffffffU;

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
  kNumberObject, // a scalar PROPERTY (`transform.rotation`, a slider): a number (`num`) with members
};

/// What property a property object stands for (AE's Property): its value is
/// the object itself (an array, or a kNumberObject), and `.valueAtTime(t)`,
/// `.velocity`, `.numKeys`, `.key(n)`… sample the same property at other times.
enum class PropKind : std::uint8_t {
  kNone,
  kLayer,   // a layer property: `bound` = the layer (null = this one), `pkey` = which (position, rotation…)
  kEffect,  // an effect parameter: `bound` = the layer, `str` = the effect name, `arg` = the parameter (name or index)
};

/// A lazily computed property (a JavaScript getter in the TypeScript).
/// D6 (camera program): kLayerProp reads one property of the object's bound
/// layer (the key names which), kLayerVec a 3-vector (position / point of
/// interest), kLayerColor a colour; kCameraOption / kLightOption build the
/// option group of the bound layer.
enum class Lazy : std::uint8_t {
  kNone, kMarkerNumKeys, kSourceText, kLayerProp, kLayerVec, kLayerColor, kCameraOption, kLightOption,
  // AE-style rigs: the `transform` group, and inPoint / outPoint / index /
  // parent / hasParent / enabled (Host::layer_facts_at)
  kLayerTransform, kLayerFact,
  // `thisComp.name` (Host::comp_facts)
  kCompName,
  // footage("name").sourceData: parsed on first read (data.cpp)
  kFootageSourceData,
  // mask("M").maskPath / content("Path 1").path: the layer's path, read on first use (path.cpp)
  kPathOf
};

struct Prop {
  KeyId key = KeyId::kUnknown;
  Value value;
  Lazy lazy = Lazy::kNone;
  /// An object literal's own key that is not a known name (`{ foo: 1 }`):
  /// `key` is kUnknown and this holds the name.
  const Str* name = nullptr;
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
  // A function the expression itself declared (`function f() {}`, `x => x`):
  // the kFunction node and the environment it closed over. `fn` is kNone.
  std::uint32_t node = kNoNode;
  Env* env = nullptr;
  // A property object (kArray / kNumberObject with `pkind` set): see PropKind.
  double num = 0;              // kNumberObject: the value
  PropKind pkind = PropKind::kNone;
  KeyId pkey = KeyId::kUnknown;
  Value arg;                   // kEffect: the parameter's name or 1-based index
};

/// A property object's plain value: a kNumberObject reads as its number,
/// anything else as itself.
[[nodiscard]] inline Value unwrap_prop(const Value& v) noexcept {
  if (v.tag == Tag::kObject && v.o->kind == ObjKind::kNumberObject) return Value::number(v.o->num);
  return v;
}

/// One activation's local variables (a function call, or the program itself):
/// slot-indexed, resolved at parse time; `parent` is the defining function's
/// environment (the closure chain).
struct Env {
  std::vector<Value> slots;
  Env* parent = nullptr;
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
  std::deque<Env> envs;                  // activations (closures keep theirs alive)

  const Str* str(Str s) { return &strings.emplace_back(std::move(s)); }
  Obj* obj(ObjKind k) {
    Obj& o = objects.emplace_back();
    o.kind = k;
    return &o;
  }
  Env* env(std::size_t slots, Env* parent) {
    Env& e = envs.emplace_back();
    e.slots.resize(slots);
    e.parent = parent;
    return &e;
  }
};

}  // namespace motion::expr::detail

#endif  // MOTION_EXPR_VALUE_HPP
