// motion_expr internals — ECMAScript abstract operations over Value.
//
// ToPrimitive, ToNumber, ToString, ToBoolean, IsLooselyEqual, IsStrictlyEqual,
// IsLessThan and the `+` operator, as ECMA-262 defines them, restricted to the
// value kinds this language can produce. None of our objects has a
// user-defined valueOf/toString, so ToPrimitive is a pure function of the
// object: a String object gives its string, an array its join(","), Math
// "[object Math]", a function a fixed text (see ops.cpp), anything else
// "[object Object]".

#ifndef MOTION_EXPR_OPS_HPP
#define MOTION_EXPR_OPS_HPP

#include <optional>

#include "value.hpp"

namespace motion::expr::detail {

/// A primitive with an owned string (ToPrimitive may build one).
struct Prim {
  Tag tag = Tag::kUndefined;  // never kObject
  bool b = false;
  double n = 0;
  Str s{};
};

[[nodiscard]] Prim to_primitive(const Value& v);
[[nodiscard]] bool truthy(const Value& v) noexcept;
[[nodiscard]] double to_number(const Value& v);
[[nodiscard]] double to_number(const Prim& p);
[[nodiscard]] Str to_string(const Value& v);
[[nodiscard]] Str to_string(const Prim& p);
[[nodiscard]] Str number_to_str(double d);
/// Array.prototype.join over already-evaluated elements.
[[nodiscard]] Str join(const std::vector<Value>& elems, std::u16string_view sep);

[[nodiscard]] bool strict_equals(const Value& a, const Value& b) noexcept;
[[nodiscard]] bool loose_equals(const Value& a, const Value& b);
/// IsLessThan(a, b): nullopt is ECMAScript's `undefined` (a NaN was involved).
[[nodiscard]] std::optional<bool> less_than(const Value& a, const Value& b);
/// The `+` operator.
[[nodiscard]] Value js_add(const Value& a, const Value& b, Arena& arena);

/// `a[k]` array-index test: an integer 0..2^32-2 whose ToString is the key.
[[nodiscard]] std::optional<std::size_t> array_index_of(const Value& key);

[[nodiscard]] inline bool is_array(const Value& v) noexcept {
  return v.tag == Tag::kObject && v.o->kind == ObjKind::kArray;
}
[[nodiscard]] inline bool is_callable(const Value& v) noexcept {
  return v.tag == Tag::kObject && v.o->kind == ObjKind::kFunction;
}
[[nodiscard]] inline bool is_finite(double d) noexcept { return d - d == 0; }

}  // namespace motion::expr::detail

#endif  // MOTION_EXPR_OPS_HPP
