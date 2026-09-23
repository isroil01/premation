// A small JSON DOM for the raster module (E3): reads the raster sources the TS
// harness exports (RenderRasterSource.specJson / opsJson) and the font manifest.
// Numbers are parsed with std::from_chars (correctly rounded, so a double the TS
// wrote with JSON.stringify comes back bit-identical). No exceptions: a parse
// failure returns false with a message.
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace premation::raster::json {

enum class Type : std::uint8_t { null, boolean, number, string, array, object };

class Value {
 public:
  Value() = default;
  static Value make_bool(bool b) { Value v; v.type_ = Type::boolean; v.num_ = b ? 1.0 : 0.0; return v; }
  static Value make_number(double d) { Value v; v.type_ = Type::number; v.num_ = d; return v; }
  static Value make_string(std::string s) { Value v; v.type_ = Type::string; v.str_ = std::move(s); return v; }
  static Value make_array() { Value v; v.type_ = Type::array; return v; }
  static Value make_object() { Value v; v.type_ = Type::object; return v; }

  [[nodiscard]] Type type() const noexcept { return type_; }
  [[nodiscard]] bool is_null() const noexcept { return type_ == Type::null; }
  [[nodiscard]] bool is_bool() const noexcept { return type_ == Type::boolean; }
  [[nodiscard]] bool is_number() const noexcept { return type_ == Type::number; }
  [[nodiscard]] bool is_string() const noexcept { return type_ == Type::string; }
  [[nodiscard]] bool is_array() const noexcept { return type_ == Type::array; }
  [[nodiscard]] bool is_object() const noexcept { return type_ == Type::object; }

  /// The number (booleans read as 0/1), or `fallback` for anything else.
  [[nodiscard]] double num(double fallback = 0.0) const noexcept {
    return type_ == Type::number || type_ == Type::boolean ? num_ : fallback;
  }
  /// JS truthiness of a boolean / number / string (null/absent = false).
  [[nodiscard]] bool truthy() const noexcept;
  [[nodiscard]] const std::string& str() const noexcept { return str_; }
  [[nodiscard]] std::string_view str_or(std::string_view fallback) const noexcept {
    return type_ == Type::string ? std::string_view(str_) : fallback;
  }

  [[nodiscard]] const std::vector<Value>& items() const noexcept { return items_; }
  [[nodiscard]] std::size_t size() const noexcept { return type_ == Type::object ? keys_.size() : items_.size(); }
  [[nodiscard]] const Value& operator[](std::size_t i) const noexcept;
  /// Member by key; a shared null Value when absent or not an object.
  [[nodiscard]] const Value& operator[](std::string_view key) const noexcept;
  [[nodiscard]] bool has(std::string_view key) const noexcept;
  [[nodiscard]] const std::vector<std::string>& keys() const noexcept { return keys_; }

  void push(Value v) { items_.push_back(std::move(v)); }
  void set(std::string key, Value v) {
    keys_.push_back(std::move(key));
    items_.push_back(std::move(v));
  }

 private:
  Type type_ = Type::null;
  double num_ = 0.0;
  std::string str_;
  std::vector<std::string> keys_;  // object: parallel to items_
  std::vector<Value> items_;
};

/// Parse a whole document.
[[nodiscard]] bool parse(std::string_view text, Value& out, std::string& error);

/// Shared null.
[[nodiscard]] const Value& null_value() noexcept;

}  // namespace premation::raster::json
