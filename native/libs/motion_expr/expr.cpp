// motion_expr — compileExpression / run / runText (expressions.ts), humanize,
// stringSeed (AnimationEngine.ts), and the UTF-8 ⇄ UTF-16 boundary.

#include "expr.hpp"

#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "interp.hpp"
#include "ops.hpp"
#include "program.hpp"
#include "sourcetext.hpp"

namespace motion::expr {
namespace {

using detail::Str;

bool is_word(char16_t c) noexcept {
  return (c >= u'a' && c <= u'z') || (c >= u'A' && c <= u'Z') || (c >= u'0' && c <= u'9') || c == u'_';
}

char16_t ascii_lower(char16_t c) noexcept { return (c >= u'A' && c <= u'Z') ? static_cast<char16_t>(c + 32) : c; }

bool contains_ci(std::u16string_view hay, std::u16string_view needle) {
  if (needle.size() > hay.size()) return false;
  for (std::size_t i = 0; i + needle.size() <= hay.size(); ++i) {
    bool ok = true;
    for (std::size_t j = 0; j < needle.size() && ok; ++j) ok = ascii_lower(hay[i + j]) == ascii_lower(needle[j]);
    if (ok) return true;
  }
  return false;
}

/// expressions.ts `humanize`, with its regexes' exact matching rules.
Str humanize(const Str& msg) {
  if (contains_ci(msg, u"Cycle detected") || contains_ci(msg, u"Maximum cross-layer evaluation depth")) return msg;
  // /(\w+) is not defined/ — leftmost match: a maximal word run from s that
  // ends exactly where " is not defined" begins.
  constexpr std::u16string_view kNotDefined = u" is not defined";
  for (std::size_t s = 0; s < msg.size(); ++s) {
    if (!is_word(msg[s])) continue;
    std::size_t e = s;
    while (e < msg.size() && is_word(msg[e])) ++e;
    if (std::u16string_view(msg).substr(e).starts_with(kNotDefined)) {
      return u"Unknown name “" + msg.substr(s, e - s) +
             u"”. Try time, value, audio, wiggle, layer, loopOut, valueAtTime, clamp, linear, ease, thisComp or "
             u"Math.";
    }
  }
  if (msg.find(u"is not a function") != Str::npos) {
    return u"That isn’t a function — check the name and parentheses.";
  }
  if (msg.find(u"Unexpected") != Str::npos || msg.find(u"missing") != Str::npos) return u"Syntax error: " + msg;
  return msg;
}

bool is_js_ws(char16_t c) noexcept {
  switch (c) {
    case 0x09: case 0x0A: case 0x0B: case 0x0C: case 0x0D: case 0x20: case 0xA0:
    case 0x1680: case 0x2028: case 0x2029: case 0x202F: case 0x205F: case 0x3000: case 0xFEFF:
      return true;
    default:
      return c >= 0x2000 && c <= 0x200A;
  }
}

struct RawOut {
  detail::Value out;
  std::optional<Str> error;
};

/// `evaluateRaw`: evaluate, humanizing any failure.
RawOut evaluate_raw(const detail::Program& prog, const Context& ctx, detail::Arena& arena) {
  try {
    detail::Interp in(prog, ctx, arena);
    return {.out = in.run(), .error = std::nullopt};
  } catch (detail::EvalError& e) {
    return {.out = {}, .error = humanize(e.message)};
  } catch (HostError& e) {
    return {.out = {}, .error = humanize(e.message)};
  }
}

}  // namespace

Expression::Expression(Expression&&) noexcept = default;
Expression& Expression::operator=(Expression&&) noexcept = default;
Expression::~Expression() = default;

Expression Expression::compile(std::u16string_view src) {
  Expression e;
  std::size_t b = 0;
  std::size_t end = src.size();
  while (b < end && is_js_ws(src[b])) ++b;
  while (end > b && is_js_ws(src[end - 1])) --end;
  if (b == end) return e;  // empty: a no-op
  try {
    e.program_ = std::make_unique<const detail::Program>(detail::parse(src.substr(b, end - b)));
  } catch (detail::SyntaxError& err) {
    e.compile_error_ = humanize(err.message);
  }
  return e;
}

Result Expression::run(const Context& ctx) const {
  Result r;
  if (compile_error_) {
    r.error = compile_error_;
    return r;
  }
  if (!program_) return r;
  detail::Arena arena;
  RawOut raw = evaluate_raw(*program_, ctx, arena);
  if (raw.error) {
    r.error = std::move(raw.error);
    return r;
  }
  const detail::Value& out = raw.out;
  if (out.is_number() && detail::is_finite(out.n)) {
    r.kind = Result::Kind::kNumber;
    r.number = out.n;
    return r;
  }
  // AE-style vector returns: 1..4 finite numbers.
  if (detail::is_array(out)) {
    const auto& e = out.o->elems;
    bool ok = !e.empty() && e.size() <= 4;
    for (const detail::Value& v : e) ok = ok && v.is_number() && detail::is_finite(v.n);
    if (ok) {
      r.kind = Result::Kind::kVector;
      r.size = e.size();
      for (std::size_t i = 0; i < e.size(); ++i) r.vec.at(i) = e[i].n;
      return r;
    }
  }
  r.error = Str(u"Expression must return a number (or a [x, y] array).");
  return r;
}

TextResult Expression::run_text(const Context& ctx) const {
  TextResult r;
  if (compile_error_) {
    r.error = compile_error_;
    return r;
  }
  if (!program_) return r;
  detail::Arena arena;
  RawOut raw = evaluate_raw(*program_, ctx, arena);
  if (raw.error) {
    r.error = std::move(raw.error);
    return r;
  }
  const Str fallback = ctx.text_value != nullptr ? ctx.text_value->text : Str();
  return detail::coerce_source_text_result(raw.out, arena, fallback);
}

double string_seed(std::u16string_view s) noexcept {
  std::int32_t h = 0;
  for (const char16_t c : s) {
    // (h * 31 + code) | 0 — exact in a double (< 2^37), then ToInt32.
    const std::int64_t v = static_cast<std::int64_t>(h) * 31 + c;
    h = static_cast<std::int32_t>(static_cast<std::uint32_t>(static_cast<std::uint64_t>(v) & 0xffffffffULL));
  }
  return static_cast<double>(static_cast<std::uint32_t>(h) % 10007U);
}

std::u16string utf8_to_utf16(std::string_view s) {
  std::u16string out;
  out.reserve(s.size());
  std::size_t i = 0;
  const auto byte = [&](std::size_t k) { return static_cast<std::uint32_t>(static_cast<unsigned char>(s[k])); };
  while (i < s.size()) {
    const std::uint32_t c = byte(i);
    std::uint32_t cp = 0xFFFD;
    std::size_t len = 1;
    const auto cont = [&](std::size_t k) { return k < s.size() && (byte(k) & 0xC0U) == 0x80U; };
    if (c < 0x80) {
      cp = c;
    } else if ((c & 0xE0U) == 0xC0U && cont(i + 1)) {
      cp = ((c & 0x1FU) << 6U) | (byte(i + 1) & 0x3FU);
      len = 2;
      if (cp < 0x80) cp = 0xFFFD;
    } else if ((c & 0xF0U) == 0xE0U && cont(i + 1) && cont(i + 2)) {
      cp = ((c & 0x0FU) << 12U) | ((byte(i + 1) & 0x3FU) << 6U) | (byte(i + 2) & 0x3FU);
      len = 3;
      if (cp < 0x800) cp = 0xFFFD;
    } else if ((c & 0xF8U) == 0xF0U && cont(i + 1) && cont(i + 2) && cont(i + 3)) {
      cp = ((c & 0x07U) << 18U) | ((byte(i + 1) & 0x3FU) << 12U) | ((byte(i + 2) & 0x3FU) << 6U) |
           (byte(i + 3) & 0x3FU);
      len = 4;
      if (cp < 0x10000 || cp > 0x10FFFF) cp = 0xFFFD;
    }
    if (cp >= 0x10000) {
      cp -= 0x10000;
      out += static_cast<char16_t>(0xD800U + (cp >> 10U));
      out += static_cast<char16_t>(0xDC00U + (cp & 0x3FFU));
    } else {
      out += static_cast<char16_t>(cp);
    }
    i += len;
  }
  return out;
}

std::string utf16_to_utf8(std::u16string_view s) {
  std::string out;
  out.reserve(s.size());
  for (std::size_t i = 0; i < s.size(); ++i) {
    std::uint32_t cp = s[i];
    if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < s.size() && s[i + 1] >= 0xDC00 && s[i + 1] <= 0xDFFF) {
      cp = 0x10000U + ((cp - 0xD800U) << 10U) + (static_cast<std::uint32_t>(s[i + 1]) - 0xDC00U);
      ++i;
    } else if (cp >= 0xD800 && cp <= 0xDFFF) {
      cp = 0xFFFD;
    }
    if (cp < 0x80) {
      out += static_cast<char>(cp);
    } else if (cp < 0x800) {
      out += static_cast<char>(0xC0U | (cp >> 6U));
      out += static_cast<char>(0x80U | (cp & 0x3FU));
    } else if (cp < 0x10000) {
      out += static_cast<char>(0xE0U | (cp >> 12U));
      out += static_cast<char>(0x80U | ((cp >> 6U) & 0x3FU));
      out += static_cast<char>(0x80U | (cp & 0x3FU));
    } else {
      out += static_cast<char>(0xF0U | (cp >> 18U));
      out += static_cast<char>(0x80U | ((cp >> 12U) & 0x3FU));
      out += static_cast<char>(0x80U | ((cp >> 6U) & 0x3FU));
      out += static_cast<char>(0x80U | (cp & 0x3FU));
    }
  }
  return out;
}

}  // namespace motion::expr
