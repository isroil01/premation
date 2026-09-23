// api::Value construction and inspection. The generated Value is a variant
// whose alternatives repeat types (string / choice / json are all
// std::string), so a value can only be built by index — these helpers name
// them.
#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "engine_api.hpp"

namespace premation::doc {

namespace api = premation::api;
using VK = api::Value::Kind;

template <VK K, class... A>
[[nodiscard]] api::Value make_value(A&&... a) {
  api::Value v;
  v.v.template emplace<static_cast<std::size_t>(K) - 1>(std::forward<A>(a)...);
  return v;
}

[[nodiscard]] inline api::Value v_none() { return make_value<VK::none>(); }
[[nodiscard]] inline api::Value v_bool(bool b) { return make_value<VK::bool_>(b); }
[[nodiscard]] inline api::Value v_scalar(double d) { return make_value<VK::scalar>(d); }
[[nodiscard]] inline api::Value v_vec2(double x, double y) { return make_value<VK::vec2>(api::Vec2{x, y}); }
[[nodiscard]] inline api::Value v_vec3(double x, double y, double z) { return make_value<VK::vec3>(api::Vec3{x, y, z}); }
[[nodiscard]] inline api::Value v_vec4(double x, double y, double z, double w) {
  return make_value<VK::vec4>(api::Vec4{x, y, z, w});
}
[[nodiscard]] inline api::Value v_color(double r, double g, double b, double a) {
  return make_value<VK::color>(api::Color{r, g, b, a});
}
[[nodiscard]] inline api::Value v_string(std::string s) { return make_value<VK::string>(std::move(s)); }
[[nodiscard]] inline api::Value v_choice(std::string s) { return make_value<VK::choice>(std::move(s)); }
[[nodiscard]] inline api::Value v_json(std::string s) { return make_value<VK::json>(std::move(s)); }
[[nodiscard]] inline api::Value v_layer(std::string s) { return make_value<VK::layer>(std::move(s)); }
[[nodiscard]] inline api::Value v_path(api::BezierPath p) { return make_value<VK::path>(std::move(p)); }
/// A textDocument as the TypeScript engine reports one: text only, no runs.
[[nodiscard]] inline api::Value v_text(std::string text) {
  api::TextDocument t;
  t.text = std::move(text);
  t.orientation = api::TextOrientation::horizontal;
  t.kerning = "metrics";
  return make_value<VK::text_document>(std::move(t));
}

template <VK K>
[[nodiscard]] const auto& get(const api::Value& v) {
  return std::get<static_cast<std::size_t>(K) - 1>(v.v);
}

/// The TypeScript `value.kind` spelling.
[[nodiscard]] inline std::string_view kind_name(VK k) noexcept {
  switch (k) {
    case VK::none: return "none";
    case VK::bool_: return "bool";
    case VK::int_: return "int";
    case VK::scalar: return "scalar";
    case VK::vec2: return "vec2";
    case VK::vec3: return "vec3";
    case VK::vec4: return "vec4";
    case VK::color: return "color";
    case VK::string: return "string";
    case VK::choice: return "choice";
    case VK::path: return "path";
    case VK::gradient: return "gradient";
    case VK::text_document: return "textDocument";
    case VK::layer: return "layer";
    case VK::item: return "item";
    case VK::scalars: return "scalars";
    case VK::json: return "json";
  }
  return "none";
}

[[nodiscard]] inline std::string_view value_type_name(api::ValueType t) noexcept {
  switch (t) {
    case api::ValueType::none: return "none";
    case api::ValueType::bool_: return "bool";
    case api::ValueType::int_: return "int";
    case api::ValueType::scalar: return "scalar";
    case api::ValueType::vec2: return "vec2";
    case api::ValueType::vec3: return "vec3";
    case api::ValueType::vec4: return "vec4";
    case api::ValueType::color: return "color";
    case api::ValueType::string: return "string";
    case api::ValueType::choice: return "choice";
    case api::ValueType::path: return "path";
    case api::ValueType::gradient: return "gradient";
    case api::ValueType::text_document: return "textDocument";
    case api::ValueType::layer: return "layer";
    case api::ValueType::item: return "item";
    case api::ValueType::scalars: return "scalars";
    case api::ValueType::json: return "json";
  }
  return "none";
}

/// A value's kind as the ValueType of the same name (they are declared in the same order).
[[nodiscard]] inline api::ValueType type_of_kind(VK k) noexcept {
  return static_cast<api::ValueType>(static_cast<std::uint32_t>(k) - 1);
}

/// A schema enum member from its wire spelling (`to_string` inverted); nullopt when unknown.
template <class E>
[[nodiscard]] std::optional<E> enum_from_string(std::string_view s) noexcept {
  for (std::uint32_t i = 0; i < 256; ++i) {
    E e{};
    if (!api::from_u32(i, e)) continue;
    if (api::to_string(e) == s) return e;
  }
  return std::nullopt;
}

/// `numbersOfLoose`: a numeric value's numbers ([] for non-numeric kinds).
[[nodiscard]] inline std::vector<double> numbers_loose(const api::Value& v) {
  switch (v.kind()) {
    case VK::scalar: return {get<VK::scalar>(v)};
    case VK::int_: return {static_cast<double>(get<VK::int_>(v))};
    case VK::bool_: return {get<VK::bool_>(v) ? 1.0 : 0.0};
    case VK::vec2: return {get<VK::vec2>(v).x, get<VK::vec2>(v).y};
    case VK::vec3: return {get<VK::vec3>(v).x, get<VK::vec3>(v).y, get<VK::vec3>(v).z};
    case VK::vec4: return {get<VK::vec4>(v).x, get<VK::vec4>(v).y, get<VK::vec4>(v).z, get<VK::vec4>(v).w};
    case VK::color: return {get<VK::color>(v).r, get<VK::color>(v).g, get<VK::color>(v).b, get<VK::color>(v).a};
    default: return {};
  }
}

}  // namespace premation::doc
