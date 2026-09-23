// A JavaScript value, as the TypeScript engine's documents hold them.
//
// The TypeScript engine stores a layer's components, a composition record, an
// imported asset and a copy/paste fragment as loosely typed JavaScript objects
// (`Record<string, unknown>`), and a surprising amount of observable behaviour
// hangs on JavaScript's object model: key INSERTION order (a component-prop
// scan lists rows in `Object.entries` order), `undefined` members that exist but
// vanish from `JSON.stringify`, numbers that are all doubles. D1b ports that
// document model to C++ (native/engine/src/core/model.hpp), so the value type is
// ported with it rather than approximated: an ordered object, a distinct
// `undefined`, and `stringify`/`parse` with `JSON.stringify` / `JSON.parse`'s
// exact output (numbers through motion_jsmath's ECMAScript formatting).
//
// Plain value semantics: copying a Json copies the whole tree.
#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

namespace premation::js {

class Json {
 public:
  enum class Kind : std::uint8_t { undefined, null, boolean, number, string, array, object };
  struct Member;
  using Array = std::vector<Json>;
  using Object = std::vector<Member>;

  Json() = default;  // undefined
  // Defined after `Member` is complete (a vector of an incomplete type cannot
  // be destroyed, and every variant emplace may destroy the old alternative).
  static Json null();
  static Json boolean(bool b);
  static Json number(double d);
  static Json string(std::string s);
  static Json array();
  static Json array(Array a);
  static Json object();
  static Json object(Object o);

  [[nodiscard]] Kind kind() const noexcept { return static_cast<Kind>(v_.index()); }
  [[nodiscard]] bool is_undefined() const noexcept { return v_.index() == 0; }
  [[nodiscard]] bool is_null() const noexcept { return v_.index() == 1; }
  [[nodiscard]] bool is_bool() const noexcept { return v_.index() == 2; }
  [[nodiscard]] bool is_number() const noexcept { return v_.index() == 3; }
  [[nodiscard]] bool is_string() const noexcept { return v_.index() == 4; }
  [[nodiscard]] bool is_array() const noexcept { return v_.index() == 5; }
  [[nodiscard]] bool is_object() const noexcept { return v_.index() == 6; }
  /// `typeof v === 'number' && Number.isFinite(v)`.
  [[nodiscard]] bool is_finite_number() const noexcept;

  [[nodiscard]] bool b() const noexcept { return is_bool() && std::get<2>(v_); }
  [[nodiscard]] double num() const noexcept { return is_number() ? std::get<3>(v_) : 0.0; }
  [[nodiscard]] const std::string& str() const noexcept;
  [[nodiscard]] const Array& arr() const noexcept;
  [[nodiscard]] Array& arr_mut();  ///< converts to an empty array when not one
  [[nodiscard]] const Object& obj() const noexcept;
  [[nodiscard]] Object& obj_mut();  ///< converts to an empty object when not one

  // ── objects (JavaScript semantics) ──
  /// The member, or nullptr when the key is absent. A present key whose value
  /// is `undefined` returns a pointer to that undefined (JS `in` is true).
  [[nodiscard]] const Json* find(std::string_view key) const noexcept;
  [[nodiscard]] Json* find_mut(std::string_view key) noexcept;
  /// `o[key]` read: undefined when absent.
  [[nodiscard]] const Json& at(std::string_view key) const noexcept;
  /// `o[key] = value`: replaces in place, else appends (insertion order).
  void set(std::string_view key, Json value);
  /// `delete o[key]`.
  void erase(std::string_view key);
  [[nodiscard]] bool has(std::string_view key) const noexcept { return find(key) != nullptr; }
  /// `typeof o[key] === 'number'` → the number.
  [[nodiscard]] std::optional<double> number_at(std::string_view key) const noexcept;
  [[nodiscard]] std::optional<std::string> string_at(std::string_view key) const;
  [[nodiscard]] std::optional<bool> bool_at(std::string_view key) const noexcept;

  /// Structural equality under JSON.stringify: `undefined` members are ignored,
  /// member ORDER matters (as it does for a stringify comparison), -0 == 0.
  friend bool operator==(const Json& a, const Json& b);

 private:
  enum class Tag : std::uint8_t { null_ };
  explicit Json(Tag);
  std::variant<std::monostate, std::nullptr_t, bool, double, std::string, Array, Object> v_;
};

struct Json::Member {
  std::string key;
  Json value;
};

inline Json::Json(Tag) { v_.emplace<1>(nullptr); }
inline Json Json::null() { return Json(Tag::null_); }
inline Json Json::boolean(bool b) { Json j; j.v_.emplace<2>(b); return j; }
inline Json Json::number(double d) { Json j; j.v_.emplace<3>(d); return j; }
inline Json Json::string(std::string s) { Json j; j.v_.emplace<4>(std::move(s)); return j; }
inline Json Json::array(Array a) { Json j; j.v_.emplace<5>(std::move(a)); return j; }
inline Json Json::object(Object o) { Json j; j.v_.emplace<6>(std::move(o)); return j; }
inline Json Json::array() { return array(Array{}); }
inline Json Json::object() { return object(Object{}); }

/// `JSON.stringify(v)` — `undefined` at the top level gives "" (JS: undefined).
[[nodiscard]] std::string stringify(const Json& v);

/// `JSON.parse(text)`; nullopt on a syntax error. Duplicate keys: last wins,
/// keeping the FIRST position (JS semantics).
[[nodiscard]] std::optional<Json> parse(std::string_view text);

/// ECMAScript Number::toString (radix 10).
[[nodiscard]] std::string number_to_string(double x);

}  // namespace premation::js
