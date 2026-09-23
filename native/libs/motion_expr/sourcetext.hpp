// motion_expr internals — sourceText.ts helpers shared with expr.cpp.

#ifndef MOTION_EXPR_SOURCETEXT_HPP
#define MOTION_EXPR_SOURCETEXT_HPP

#include <array>
#include <cstddef>
#include <optional>
#include <string_view>

#include "value.hpp"

namespace motion::expr::detail {

/// Grapheme count (splitSourceGraphemes(text).length) — see sourcetext.cpp.
[[nodiscard]] std::size_t grapheme_count(const Str& s);
/// `cssToRgb01`: CSS colour → [r, g, b] 0..1; unparseable reads as white.
[[nodiscard]] std::array<double, 3> css_to_rgb01(const std::optional<Str>& css);
/// `rgb01ToCss`: [r, g, b] 0..1 (or a CSS string) → CSS hex; throws EvalError.
[[nodiscard]] Str rgb01_to_css(const Value& v, std::u16string_view fn);
/// `resolveSourceTextStyle`.
[[nodiscard]] SourceTextStyle resolve_style(const SourceTextStyle& base, const SourceTextStyleOverrides& o);
/// `coerceSourceTextResult`.
[[nodiscard]] TextResult coerce_source_text_result(const Value& out, const Arena& arena, const Str& fallback);

}  // namespace motion::expr::detail

#endif  // MOTION_EXPR_SOURCETEXT_HPP
