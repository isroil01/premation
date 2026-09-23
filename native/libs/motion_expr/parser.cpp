// Lexer + Pratt parser — a port of packages/animation/src/exprLang.ts.
//
// Same grammar, same token rules (longest-first punctuation, `1e` lexing as
// `1` then `e`, the three escapes), same precedence table and the same error
// text, character for character (the curly quotes are part of the message the
// editor shows, and of the golden table).

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <ranges>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "numconv.hpp"
#include "program.hpp"

namespace motion::expr::detail {
namespace {

bool is_space(char16_t c) noexcept {
  // JavaScript's /\s/: WhiteSpace + LineTerminator.
  switch (c) {
    case 0x09: case 0x0A: case 0x0B: case 0x0C: case 0x0D: case 0x20: case 0xA0:
    case 0x1680: case 0x2028: case 0x2029: case 0x202F: case 0x205F: case 0x3000: case 0xFEFF:
      return true;
    default:
      return c >= 0x2000 && c <= 0x200A;
  }
}
bool is_digit(char16_t c) noexcept { return c >= u'0' && c <= u'9'; }
bool is_ident_start(char16_t c) noexcept {
  return (c >= u'A' && c <= u'Z') || (c >= u'a' && c <= u'z') || c == u'_' || c == u'$';
}
bool is_ident_part(char16_t c) noexcept { return is_ident_start(c) || is_digit(c); }

enum class TokType : std::uint8_t { kNum, kStr, kName, kPunct, kEof };

struct Tok {
  TokType type = TokType::kEof;
  Str value;
};

// Longest-first: '===' must be tried before '==', which must beat '='.
constexpr std::array<std::u16string_view, 24> kPunct = {
    u"===", u"!==", u"==", u"!=", u"<=", u">=", u"&&", u"||", u"(", u")", u"[", u"]",
    u",",   u".",   u"?",  u":",  u"+",  u"-",  u"*",  u"/",  u"%", u"<", u">", u"!"};

// Functions, not globals: a static std::u16string may throw at startup. They
// return Str (not a view) because every use is a `+` concatenation.
Str lq() { return u"“"; }  // NOLINT(modernize-use-string-view)
Str rq() { return u"”"; }  // NOLINT(modernize-use-string-view)

std::vector<Tok> lex(std::u16string_view src) {
  std::vector<Tok> out;
  std::size_t i = 0;
  const std::size_t n = src.size();
  const auto at = [&](std::size_t k) -> char16_t { return k < n ? src[k] : u'\0'; };
  while (i < n) {
    const char16_t c = src[i];
    if (is_space(c)) {
      ++i;
      continue;
    }
    // Number: 1, 1.5, .5, 1e-3
    if (is_digit(c) || (c == u'.' && is_digit(at(i + 1)))) {
      const std::size_t start = i;
      while (i < n && is_digit(src[i])) ++i;
      if (at(i) == u'.') {
        ++i;
        while (i < n && is_digit(src[i])) ++i;
      }
      if (at(i) == u'e' || at(i) == u'E') {
        const std::size_t save = i;
        ++i;
        if (at(i) == u'+' || at(i) == u'-') ++i;
        if (i < n && is_digit(src[i])) {
          while (i < n && is_digit(src[i])) ++i;
        } else {
          i = save;  // "1e" — the 'e' isn't part of the number
        }
      }
      out.push_back({.type = TokType::kNum, .value = Str(src.substr(start, i - start))});
      continue;
    }
    // String
    if (c == u'"' || c == u'\'') {
      const char16_t quote = c;
      ++i;
      Str value;
      while (i < n && src[i] != quote) {
        if (src[i] == u'\\') {
          if (i + 1 < n) {
            const char16_t esc = src[i + 1];
            value += esc == u'n' ? u'\n' : esc == u't' ? u'\t' : esc == u'r' ? u'\r' : esc;
          }
          i += 2;
          continue;
        }
        value += src[i];
        ++i;
      }
      if (i >= n) throw SyntaxError{u"Unterminated string — missing a closing quote."};
      ++i;  // closing quote
      out.push_back({.type = TokType::kStr, .value = std::move(value)});
      continue;
    }
    // Identifier
    if (is_ident_start(c)) {
      const std::size_t start = i;
      while (i < n && is_ident_part(src[i])) ++i;
      out.push_back({.type = TokType::kName, .value = Str(src.substr(start, i - start))});
      continue;
    }
    bool matched = false;
    for (const std::u16string_view p : kPunct) {
      if (src.substr(i).starts_with(p)) {
        out.push_back({.type = TokType::kPunct, .value = Str(p)});
        i += p.size();
        matched = true;
        break;
      }
    }
    if (matched) continue;
    Str msg = u"Unexpected character ";
    msg += lq();
    msg += c;
    msg += rq();
    msg += u'.';
    throw SyntaxError{std::move(msg)};
  }
  out.push_back({.type = TokType::kEof, .value = {}});
  return out;
}

/// JS binary precedence. Higher binds tighter; 0 = not a binary operator.
int precedence_of(std::u16string_view v) noexcept {
  if (v == u"||") return 1;
  if (v == u"&&") return 2;
  if (v == u"==" || v == u"!=" || v == u"===" || v == u"!==") return 3;
  if (v == u"<" || v == u"<=" || v == u">" || v == u">=") return 4;
  if (v == u"+" || v == u"-") return 5;
  if (v == u"*" || v == u"/" || v == u"%") return 6;
  return 0;
}

Op binary_op(std::u16string_view v) noexcept {
  if (v == u"*") return Op::kMul;
  if (v == u"/") return Op::kDiv;
  if (v == u"%") return Op::kMod;
  if (v == u"+") return Op::kAdd;
  if (v == u"-") return Op::kSub;
  if (v == u"<") return Op::kLt;
  if (v == u"<=") return Op::kLe;
  if (v == u">") return Op::kGt;
  if (v == u">=") return Op::kGe;
  if (v == u"==") return Op::kEq;
  if (v == u"!=") return Op::kNe;
  if (v == u"===") return Op::kStrictEq;
  if (v == u"!==") return Op::kStrictNe;
  if (v == u"&&") return Op::kAnd;
  return Op::kOr;
}

class Parser {
 public:
  explicit Parser(std::u16string_view src) : toks_(lex(src)) {}

  Program parse() {
    prog_.root = parse_expression();
    if (peek().type != TokType::kEof) {
      throw SyntaxError{u"Unexpected " + lq() + peek().value + rq() +
                        u". An expression must be a single value — statements and " + lq() + u";" + rq() +
                        u" aren’t supported."};
    }
    return std::move(prog_);
  }

 private:
  /// One nesting level; see kMaxParseDepth.
  struct DepthGuard {
    explicit DepthGuard(int& d) : depth(d) { enter(depth); }
    DepthGuard(const DepthGuard&) = delete;
    DepthGuard(DepthGuard&&) = delete;
    DepthGuard& operator=(const DepthGuard&) = delete;
    DepthGuard& operator=(DepthGuard&&) = delete;
    ~DepthGuard() { --depth; }
    int& depth;  // NOLINT(cppcoreguidelines-avoid-const-or-ref-data-members) — scoped RAII counter
  };
  /// exprLang.ts `enter`: open a level or fail at kMaxParseDepth.
  static void enter(int& depth) {
    if (++depth > kMaxParseDepth) throw SyntaxError{Str(kMaxParseDepthMessage)};
  }

  [[nodiscard]] const Tok& peek() const { return toks_[pos_]; }
  const Tok& next() { return toks_[pos_++]; }
  [[nodiscard]] bool is(std::u16string_view v) const {
    const Tok& t = peek();
    return t.type == TokType::kPunct && t.value == v;
  }
  bool eat(std::u16string_view v) {
    if (is(v)) {
      ++pos_;
      return true;
    }
    return false;
  }
  void expect(std::u16string_view v) {
    if (!eat(v)) {
      const Tok& t = peek();
      const Str found = t.type == TokType::kEof ? Str(u"end of expression") : lq() + t.value + rq();
      throw SyntaxError{u"Expected " + lq() + Str(v) + rq() + u" but found " + found + u"."};
    }
  }

  std::uint32_t add(const Node& node) {
    prog_.nodes.push_back(node);
    return static_cast<std::uint32_t>(prog_.nodes.size() - 1);
  }
  std::uint32_t add_string(Str s) {
    prog_.strings.push_back(std::move(s));
    return static_cast<std::uint32_t>(prog_.strings.size() - 1);
  }
  void set_list(Node& node, const std::vector<std::uint32_t>& items) {
    node.list = static_cast<std::uint32_t>(prog_.lists.size());
    node.count = static_cast<std::uint32_t>(items.size());
    prog_.lists.insert(prog_.lists.end(), items.begin(), items.end());
  }

  // ── exprLang.ts `parseLevel`, statement for statement ──────────────────
  //
  // The whole grammar in one recursive function, as in the TypeScript: prefix
  // operators are collected in a loop, the postfix chain and the binary loop
  // are loops, and only a bracketed sub-expression or a binary operator's
  // right side recurses. Same tokens consumed in the same order, same nodes,
  // same errors, and the same depth accounting — the level itself, plus one
  // per prefix operator while its operand is parsed — so both engines refuse
  // exactly the same sources at kMaxParseDepth.

  std::uint32_t parse_expression() { return parse_level(0, true); }

  /// parseConditional (allow_conditional) or parseBinary(min_prec).
  std::uint32_t parse_level(int min_prec, bool allow_conditional) {
    const DepthGuard g(depth_);
    // parseUnary: prefix operators, applied innermost-last.
    std::vector<Op> prefix;
    for (;;) {
      const Tok& t = peek();
      if (t.type != TokType::kPunct || !(t.value == u"-" || t.value == u"+" || t.value == u"!")) break;
      prefix.push_back(t.value == u"-" ? Op::kNeg : t.value == u"+" ? Op::kPlus : Op::kNot);
      next();
      enter(depth_);
    }
    std::uint32_t left = parse_postfix(parse_primary());
    for (const Op op : std::views::reverse(prefix)) {
      Node node;
      node.kind = NodeKind::kUnary;
      node.op = op;
      node.a = left;
      left = add(node);
    }
    depth_ -= static_cast<int>(prefix.size());
    // parseBinary: all these operators are left-associative.
    for (;;) {
      const Tok& t = peek();
      if (t.type != TokType::kPunct) break;
      const int prec = precedence_of(t.value);
      if (prec == 0 || prec < min_prec) break;
      const Op op = binary_op(t.value);
      next();
      const std::uint32_t right = parse_level(prec + 1, false);
      Node node;
      node.kind = (op == Op::kAnd || op == Op::kOr) ? NodeKind::kLogical : NodeKind::kBinary;
      node.op = op;
      node.a = left;
      node.b = right;
      left = add(node);
    }
    if (!allow_conditional || !eat(u"?")) return left;
    const std::uint32_t consequent = parse_expression();
    expect(u":");
    const std::uint32_t alternate = parse_expression();
    Node node;
    node.kind = NodeKind::kConditional;
    node.a = left;
    node.b = consequent;
    node.c = alternate;
    return add(node);
  }

  /// parseCallMember's loop over an already-parsed primary.
  std::uint32_t parse_postfix(std::uint32_t node) {
    for (;;) {
      if (eat(u".")) {
        const Tok& t = next();
        if (t.type != TokType::kName) throw_after_dot();
        Node prop;
        prop.kind = NodeKind::kStr;
        prop.str = add_string(t.value);
        const std::uint32_t p = add(prop);
        Node m;
        m.kind = NodeKind::kMember;
        m.a = node;
        m.b = p;
        m.computed = false;
        m.key = key_of(t.value);
        m.str = prop.str;
        node = add(m);
      } else if (eat(u"[")) {
        const std::uint32_t property = parse_expression();
        expect(u"]");
        Node m;
        m.kind = NodeKind::kMember;
        m.a = node;
        m.b = property;
        m.computed = true;
        node = add(m);
      } else if (eat(u"(")) {
        std::vector<std::uint32_t> args;
        if (!is(u")")) {
          for (;;) {
            args.push_back(parse_expression());
            if (!eat(u",")) break;
          }
        }
        expect(u")");
        Node call;
        call.kind = NodeKind::kCall;
        call.a = node;
        set_list(call, args);
        node = add(call);
      } else {
        return node;
      }
    }
  }

  [[noreturn]] static void throw_after_dot() {
    throw SyntaxError{u"Expected a property name after " + lq() + u"." + rq() + u"."};
  }
  [[noreturn]] static void throw_unexpected(const Tok& t) {
    const Str found = t.type == TokType::kEof ? Str(u"end of expression") : lq() + t.value + rq();
    throw SyntaxError{u"Unexpected " + found + u"."};
  }
  [[noreturn]] static void throw_bad_number(const Tok& t) {
    throw SyntaxError{lq() + t.value + rq() + u" isn’t a valid number."};
  }

  std::uint32_t parse_primary() {
    const Tok& t = next();
    if (t.type == TokType::kNum) {
      const double value = motion::js::string_to_number(std::u16string_view(t.value));
      if (!(value - value == 0)) throw_bad_number(t);  // !Number.isFinite(value)
      Node node;
      node.kind = NodeKind::kNum;
      node.num = value;
      return add(node);
    }
    if (t.type == TokType::kStr) {
      Node node;
      node.kind = NodeKind::kStr;
      node.str = add_string(t.value);
      return add(node);
    }
    if (t.type == TokType::kName) {
      Node node;
      if (t.value == u"true" || t.value == u"false") {
        node.kind = NodeKind::kBool;
        node.boolean = t.value == u"true";
      } else if (t.value == u"null" || t.value == u"undefined") {
        node.kind = NodeKind::kNull;
      } else {
        node.kind = NodeKind::kIdent;
        node.str = add_string(t.value);
        node.global = global_of(t.value);
      }
      return add(node);
    }
    if (t.type == TokType::kPunct) {
      if (t.value == u"(") {
        const std::uint32_t node = parse_expression();
        expect(u")");
        return node;
      }
      if (t.value == u"[") {
        std::vector<std::uint32_t> items;
        if (!is(u"]")) {
          for (;;) {
            items.push_back(parse_expression());
            if (!eat(u",")) break;
          }
        }
        expect(u"]");
        Node node;
        node.kind = NodeKind::kArray;
        set_list(node, items);
        return add(node);
      }
    }
    throw_unexpected(t);
  }

  std::vector<Tok> toks_;
  std::size_t pos_ = 0;
  int depth_ = 0;
  Program prog_;
};

}  // namespace

Program parse(std::u16string_view src) { return Parser(src).parse(); }

}  // namespace motion::expr::detail
