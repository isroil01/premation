// COS — the object notation a text layer's source is written in (src/core/aep/cos.ts).
//
// A text layer's document lives in a `btdk` blob written in Adobe's COS: the
// `<< /key value >>` dictionaries, `[ … ]` arrays and `( … )` strings of
// PostScript/PDF. Keys are ordinals (`/0`, `/1`), strings are UTF-16BE behind
// a byte-order mark, parentheses nest and escape, and the document body is a
// dictionary with NO `<<` around it.
//
// The parser is total: it never throws on malformed input, stops at the end of
// the buffer, and has a node budget and a depth cap.
#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <initializer_list>
#include <optional>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include "core/aep/riff.hpp"

namespace premation::doc::aep {

struct CosValue {
  enum class Kind : std::uint8_t { null, dict, array, string, number, boolean, name };
  Kind kind = Kind::null;
  /// dict: keys and values in insertion order (a repeated key replaces in place, as a JS Map).
  std::vector<std::string> keys;
  std::vector<CosValue> values;
  /// array.
  std::vector<CosValue> items;
  /// string (decoded to UTF-8) or name.
  std::string text;
  double number = 0;
  bool boolean = false;

  [[nodiscard]] const CosValue* get(std::string_view key) const noexcept;
};

/// `parseCos`: the top-level value, always (an unwrapped body reads as a dictionary).
[[nodiscard]] CosValue parse_cos(Bytes bytes);
/// `decodeCosString`: UTF-16BE behind a BOM, else latin-1 — as UTF-8.
[[nodiscard]] std::string decode_cos_string(Bytes bytes);

/// One step of a `cosGet` path: a dictionary key or an array index.
using CosStep = std::variant<std::string_view, std::size_t>;
[[nodiscard]] const CosValue* cos_get(const CosValue* v, std::initializer_list<CosStep> path) noexcept;
[[nodiscard]] std::optional<std::string> cos_string(const CosValue* v);
[[nodiscard]] std::optional<double> cos_number(const CosValue* v) noexcept;
[[nodiscard]] const std::vector<CosValue>* cos_array(const CosValue* v) noexcept;
/// `cosWalk`: every value in the tree, depth-first, pre-order.
void cos_walk(const CosValue* v, const std::function<bool(const CosValue&)>& visit);

}  // namespace premation::doc::aep
