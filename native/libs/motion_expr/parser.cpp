// Lexer + Pratt parser — a port of packages/animation/src/exprLang.ts,
// extended with statements (docs/EXPRESSION_LANGUAGE.md).
//
// Same grammar for a single expression, same token rules (longest-first
// punctuation, `1e` lexing as `1` then `e`, the three escapes), same
// precedence table and the same error text, character for character (the
// curly quotes are part of the message the editor shows, and of the golden
// table). On top of that: `//` and `/* */` comments, a statement list
// separated by `;` or line breaks, var/let/const, assignment, if/else,
// while/do…while/for/for…of/for…in, switch, try/catch/finally, throw, function
// declarations, function expressions and arrows (with default parameters),
// object and template literals, `??`, `?.` and the bitwise operators. Local
// variables are resolved to frame slots here, after the parse, so the
// evaluator never looks a name up at run time.
//
// Every token and node carries its source offset (`pos`): a syntax error and
// a runtime error report the line and column of what failed
// (Expression::compile_error_line / Result::line), never inside the message.

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <ranges>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "numconv.hpp"
#include "ops.hpp"
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
bool is_line_terminator(char16_t c) noexcept { return c == 0x0A || c == 0x0D || c == 0x2028 || c == 0x2029; }
bool is_digit(char16_t c) noexcept { return c >= u'0' && c <= u'9'; }
bool is_ident_start(char16_t c) noexcept {
  return (c >= u'A' && c <= u'Z') || (c >= u'a' && c <= u'z') || c == u'_' || c == u'$';
}
bool is_ident_part(char16_t c) noexcept { return is_ident_start(c) || is_digit(c); }

enum class TokType : std::uint8_t { kNum, kStr, kName, kPunct, kTemplate, kEof };

struct Tok {
  TokType type = TokType::kEof;
  Str value;
  bool nl_before = false;  // a line terminator (or a comment holding one) precedes the token
  bool tail = false;       // kTemplate: the piece ends the literal (a closing backtick, not `${`)
  std::uint32_t pos = 0;   // source offset of the token's first character
};

// Longest-first: '===' must be tried before '==', which must beat '='.
// (`++` / `--` and `?.` are decided in the lexer itself: see there.)
constexpr std::array<std::u16string_view, 43> kPunct = {
    u"===", u"!==", u">>>", u"=>", u"==", u"!=", u"<=", u">=", u"&&", u"||", u"??", u"+=", u"-=", u"*=", u"/=",
    u"%=",  u"**",  u"<<",  u">>", u"(",  u")",  u"[",  u"]",  u"{",  u"}",  u",",  u".",  u";",  u"?",  u":",
    u"=",   u"+",   u"-",   u"*",  u"/",  u"%",  u"<",  u">",  u"!",  u"&",  u"|",  u"^",  u"~"};

constexpr std::array<std::u16string_view, 22> kKeywords = {
    u"var",   u"let",    u"const", u"if",     u"else", u"function", u"return",  u"for",
    u"while", u"break",  u"continue", u"typeof", u"new", u"do",     u"switch",  u"case",
    u"default", u"try",  u"catch", u"finally", u"throw", u"in"};

bool is_keyword(std::u16string_view v) noexcept { return std::ranges::find(kKeywords, v) != kKeywords.end(); }

// Functions, not globals: a static std::u16string may throw at startup. They
// return Str (not a view) because every use is a `+` concatenation.
Str lq() { return u"“"; }  // NOLINT(modernize-use-string-view)
Str rq() { return u"”"; }  // NOLINT(modernize-use-string-view)

std::uint32_t pos32(std::size_t i) noexcept { return static_cast<std::uint32_t>(std::min<std::size_t>(i, kNoPos - 1)); }

std::vector<Tok> lex(std::u16string_view src) {
  std::vector<Tok> out;
  std::size_t i = 0;
  const std::size_t n = src.size();
  bool nl = false;  // pending "a line break came before the next token"
  // Open template substitutions: the `{` depth inside each `${ … }`.
  std::vector<int> tmpl;
  const auto at = [&](std::size_t k) -> char16_t { return k < n ? src[k] : u'\0'; };
  const auto push = [&](TokType type, Str value, std::size_t start) {
    out.push_back({.type = type, .value = std::move(value), .nl_before = nl, .tail = false, .pos = pos32(start)});
    nl = false;
  };
  // One template piece from `i` (just past the backtick or the closing `}`)
  // to the next backtick (the tail) or `${`.
  const auto template_piece = [&](std::size_t start) {
    Str value;
    for (;;) {
      if (i >= n) {
        throw SyntaxError{u"Unterminated template literal — missing a closing " + lq() + u"`" + rq() + u".",
                          pos32(start)};
      }
      const char16_t c = src[i];
      if (c == u'`') {
        ++i;
        push(TokType::kTemplate, std::move(value), start);
        out.back().tail = true;
        return;
      }
      if (c == u'$' && at(i + 1) == u'{') {
        i += 2;
        tmpl.push_back(0);
        push(TokType::kTemplate, std::move(value), start);
        return;
      }
      if (c == u'\\') {
        if (i + 1 < n) {
          const char16_t esc = src[i + 1];
          value += esc == u'n' ? u'\n' : esc == u't' ? u'\t' : esc == u'r' ? u'\r' : esc;
        }
        i += 2;
        continue;
      }
      value += c;
      ++i;
    }
  };
  while (i < n) {
    const char16_t c = src[i];
    if (is_space(c)) {
      if (is_line_terminator(c)) nl = true;
      ++i;
      continue;
    }
    // Comments: `// …` to the end of the line, `/* … */`.
    if (c == u'/' && at(i + 1) == u'/') {
      while (i < n && !is_line_terminator(src[i])) ++i;
      continue;
    }
    if (c == u'/' && at(i + 1) == u'*') {
      const std::size_t start = i;
      i += 2;
      for (;;) {
        if (i >= n) {
          throw SyntaxError{u"Unterminated comment — missing a closing " + lq() + u"*/" + rq() + u".", pos32(start)};
        }
        if (src[i] == u'*' && at(i + 1) == u'/') {
          i += 2;
          break;
        }
        if (is_line_terminator(src[i])) nl = true;
        ++i;
      }
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
      push(TokType::kNum, Str(src.substr(start, i - start)), start);
      continue;
    }
    // String
    if (c == u'"' || c == u'\'') {
      const std::size_t start = i;
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
      if (i >= n) throw SyntaxError{u"Unterminated string — missing a closing quote.", pos32(start)};
      ++i;  // closing quote
      push(TokType::kStr, std::move(value), start);
      continue;
    }
    // Template literal
    if (c == u'`') {
      const std::size_t start = i;
      ++i;
      template_piece(start);
      continue;
    }
    // Identifier
    if (is_ident_start(c)) {
      const std::size_t start = i;
      while (i < n && is_ident_part(src[i])) ++i;
      push(TokType::kName, Str(src.substr(start, i - start)), start);
      continue;
    }
    // `++` / `--` are one token only where they read as an increment: before
    // a name or `(` (prefix), or after a name / `)` / `]` with nothing an
    // operand could start with next (postfix). Elsewhere `----1` stays four
    // negations, as it always did.
    if ((c == u'+' || c == u'-') && at(i + 1) == c) {
      const char16_t after = at(i + 2);
      const bool prefix = is_ident_start(after) || after == u'(';
      const bool postfix = !out.empty() &&
                           (out.back().type == TokType::kName ||
                            (out.back().type == TokType::kPunct && (out.back().value == u")" || out.back().value == u"]"))) &&
                           !is_ident_start(after) && !is_digit(after) && after != u'.' && after != u'(' && after != u'[' &&
                           after != u'+' && after != u'-';
      if (prefix || postfix) {
        push(TokType::kPunct, Str(2, c), i);
        i += 2;
        continue;
      }
    }
    // `?.` is optional chaining unless a digit follows (`a ?.5 : 1` is a conditional).
    if (c == u'?' && at(i + 1) == u'.' && !is_digit(at(i + 2))) {
      push(TokType::kPunct, Str(u"?."), i);
      i += 2;
      continue;
    }
    // The `}` that closes a template substitution resumes the literal.
    if (c == u'}' && !tmpl.empty()) {
      if (tmpl.back() == 0) {
        tmpl.pop_back();
        const std::size_t start = i;
        ++i;
        template_piece(start);
        continue;
      }
      --tmpl.back();
    } else if (c == u'{' && !tmpl.empty()) {
      ++tmpl.back();
    }
    bool matched = false;
    for (const std::u16string_view p : kPunct) {
      if (src.substr(i).starts_with(p)) {
        push(TokType::kPunct, Str(p), i);
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
    throw SyntaxError{std::move(msg), pos32(i)};
  }
  push(TokType::kEof, {}, n);
  return out;
}

/// JS binary precedence. Higher binds tighter; 0 = not a binary operator.
int precedence_of(std::u16string_view v) noexcept {
  if (v == u"||" || v == u"??") return 1;
  if (v == u"&&") return 2;
  if (v == u"|") return 3;
  if (v == u"^") return 4;
  if (v == u"&") return 5;
  if (v == u"==" || v == u"!=" || v == u"===" || v == u"!==") return 6;
  if (v == u"<" || v == u"<=" || v == u">" || v == u">=") return 7;
  if (v == u"<<" || v == u">>" || v == u">>>") return 8;
  if (v == u"+" || v == u"-") return 9;
  if (v == u"*" || v == u"/" || v == u"%") return 10;
  if (v == u"**") return 11;
  return 0;
}

Op binary_op(std::u16string_view v) noexcept {
  if (v == u"*") return Op::kMul;
  if (v == u"/") return Op::kDiv;
  if (v == u"%") return Op::kMod;
  if (v == u"+") return Op::kAdd;
  if (v == u"-") return Op::kSub;
  if (v == u"**") return Op::kPow;
  if (v == u"<") return Op::kLt;
  if (v == u"<=") return Op::kLe;
  if (v == u">") return Op::kGt;
  if (v == u">=") return Op::kGe;
  if (v == u"==") return Op::kEq;
  if (v == u"!=") return Op::kNe;
  if (v == u"===") return Op::kStrictEq;
  if (v == u"!==") return Op::kStrictNe;
  if (v == u"&&") return Op::kAnd;
  if (v == u"??") return Op::kNullish;
  if (v == u"&") return Op::kBitAnd;
  if (v == u"|") return Op::kBitOr;
  if (v == u"^") return Op::kBitXor;
  if (v == u"<<") return Op::kShl;
  if (v == u">>") return Op::kShr;
  if (v == u">>>") return Op::kUShr;
  return Op::kOr;
}

/// `=` and the compound assignments: kNone for plain `=`, else the binary op.
std::optional<Op> assign_op(std::u16string_view v) noexcept {
  if (v == u"=") return Op::kNone;
  if (v == u"+=") return Op::kAdd;
  if (v == u"-=") return Op::kSub;
  if (v == u"*=") return Op::kMul;
  if (v == u"/=") return Op::kDiv;
  if (v == u"%=") return Op::kMod;
  return std::nullopt;
}

enum class DeclKind : std::uint8_t { kVar, kLet, kConst, kParam, kFunction, kImplicit };

class Parser {
 public:
  explicit Parser(std::u16string_view src) : toks_(lex(src)) {}

  Program parse() {
    try {
      return parse_program();
    } catch (SyntaxError& e) {
      // A message thrown without a position points at the token being read.
      if (e.pos == kNoPos) e.pos = toks_[std::min(pos_, toks_.size() - 1)].pos;
      throw;
    }
  }

 private:
  Program parse_program() {
    // The program is a function frame of its own (top-level var/let/const).
    cur_scope_ = new_scope(kNoNode, true);
    std::vector<std::uint32_t> stmts;
    while (peek().type != TokType::kEof) stmts.push_back(parse_statement());
    if (stmts.size() == 1 && !is_statement(prog_.nodes[stmts[0]]) && !any_decls_) {
      // The fast path: one expression, exactly the nodes exprLang.ts builds.
      prog_.root = stmts[0];
      return std::move(prog_);
    }
    Node block;
    block.kind = NodeKind::kBlock;
    block.scope = cur_scope_;
    block.pos = 0;
    set_list(block, stmts);
    prog_.root = add(block);
    if (any_decls_) {
      scope_stack_.clear();
      resolve(prog_.root);
      prog_.top_slots = func_slots_[0];
    }
    return std::move(prog_);
  }

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
  [[nodiscard]] const Tok& peek_at(std::size_t k) const { return toks_[std::min(pos_ + k, toks_.size() - 1)]; }
  const Tok& next() { return toks_[pos_++]; }
  [[nodiscard]] bool is(std::u16string_view v) const {
    const Tok& t = peek();
    return t.type == TokType::kPunct && t.value == v;
  }
  [[nodiscard]] bool is_name(std::u16string_view v) const {
    const Tok& t = peek();
    return t.type == TokType::kName && t.value == v;
  }
  [[nodiscard]] static bool tok_is(const Tok& t, std::u16string_view v) {
    return t.type == TokType::kPunct && t.value == v;
  }
  [[nodiscard]] static bool tok_is_name(const Tok& t, std::u16string_view v) {
    return t.type == TokType::kName && t.value == v;
  }
  bool eat(std::u16string_view v) {
    if (is(v)) {
      ++pos_;
      return true;
    }
    return false;
  }
  bool eat_name(std::u16string_view v) {
    if (is_name(v)) {
      ++pos_;
      return true;
    }
    return false;
  }
  [[nodiscard]] static Str describe(const Tok& t) {
    if (t.type == TokType::kEof) return {u"end of expression"};
    if (t.type == TokType::kTemplate) return lq() + u"`" + rq();
    return lq() + t.value + rq();
  }
  void expect(std::u16string_view v) {
    if (!eat(v)) {
      throw SyntaxError{u"Expected " + lq() + Str(v) + rq() + u" but found " + describe(peek()) + u".", peek().pos};
    }
  }
  /// The offset of the token just consumed.
  [[nodiscard]] std::uint32_t last_pos() const { return toks_[pos_ > 0 ? pos_ - 1 : 0].pos; }

  std::uint32_t add(Node node) {
    if (node.pos == kNoPos) node.pos = last_pos();
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
  std::uint32_t str_node(Str s, std::uint32_t pos) {
    Node node;
    node.kind = NodeKind::kStr;
    node.key = key_of(s);
    node.str = add_string(std::move(s));
    node.pos = pos;
    return add(node);
  }

  static bool is_statement(const Node& n) noexcept { return n.kind >= NodeKind::kBlock; }

  // ── Scopes (parse-time) ─────────────────────────────────────────────────

  struct Decl {
    Str name;
    std::uint32_t slot = 0;
    bool is_const = false;
  };
  struct Scope {
    std::vector<Decl> decls;
    std::uint32_t parent = kNoNode;
    std::uint32_t func = 0;  // index into func_slots_
    bool is_func = false;
  };

  std::uint32_t new_scope(std::uint32_t parent, bool is_func) {
    Scope s;
    s.parent = parent;
    s.is_func = is_func;
    if (is_func) {
      s.func = static_cast<std::uint32_t>(func_slots_.size());
      func_slots_.push_back(0);
    } else {
      s.func = scopes_[parent].func;
    }
    scopes_.push_back(std::move(s));
    return static_cast<std::uint32_t>(scopes_.size() - 1);
  }

  /// Declare `name` and return its slot. `var` goes to the nearest function
  /// scope, an implicit global (`x = 1` with no declaration) to the program's.
  std::uint32_t declare(const Str& name, DeclKind kind) {
    any_decls_ = true;
    std::uint32_t sid = cur_scope_;
    if (kind == DeclKind::kVar) {
      while (!scopes_[sid].is_func) sid = scopes_[sid].parent;
    } else if (kind == DeclKind::kImplicit) {
      sid = 0;
    }
    Scope& s = scopes_[sid];
    for (const Decl& d : s.decls) {
      if (d.name == name) return d.slot;
    }
    const std::uint32_t slot = func_slots_[s.func]++;
    s.decls.push_back({.name = name, .slot = slot, .is_const = kind == DeclKind::kConst});
    return slot;
  }

  /// Is `name` declared anywhere up the current scope chain (at this point of the parse)?
  [[nodiscard]] bool visible(const Str& name) const {
    for (std::uint32_t sid = cur_scope_; sid != kNoNode; sid = scopes_[sid].parent) {
      for (const Decl& d : scopes_[sid].decls) {
        if (d.name == name) return true;
      }
    }
    return false;
  }

  // ── Statements ───────────────────────────────────────────────────────────

  /// A statement ends at `;`, before `}`, at the end, or at a line break (ASI).
  void end_statement() {
    if (eat(u";") || is(u"}") || peek().type == TokType::kEof || peek().nl_before) return;
    throw SyntaxError{u"Unexpected " + describe(peek()) + u". Separate statements with " + lq() + u";" + rq() +
                          u" or a line break.",
                      peek().pos};
  }

  std::uint32_t parse_statement() {
    const Tok& t = peek();
    if (t.type == TokType::kPunct) {
      if (t.value == u"{") return parse_block();
      if (t.value == u";") {
        next();
        Node e;
        e.kind = NodeKind::kEmpty;
        return add(e);
      }
    }
    if (t.type == TokType::kName) {
      if (t.value == u"var" || t.value == u"let" || t.value == u"const") {
        const std::uint32_t id = parse_var_list();
        end_statement();
        return id;
      }
      if (t.value == u"if") return parse_if();
      if (t.value == u"while") return parse_while();
      if (t.value == u"do") return parse_do();
      if (t.value == u"for") return parse_for();
      if (t.value == u"switch") return parse_switch();
      if (t.value == u"try") return parse_try();
      if (t.value == u"function" && peek_at(1).type == TokType::kName) return parse_function(true);
      if (t.value == u"return") {
        const std::uint32_t at = t.pos;
        next();
        Node r;
        r.kind = NodeKind::kReturn;
        r.pos = at;
        if (!(is(u";") || is(u"}") || peek().type == TokType::kEof || peek().nl_before)) r.a = parse_expression();
        end_statement();
        return add(r);
      }
      if (t.value == u"throw") {
        const std::uint32_t at = t.pos;
        next();
        if (peek().nl_before || peek().type == TokType::kEof) {
          throw SyntaxError{u"Illegal newline after throw.", peek().pos};
        }
        Node r;
        r.kind = NodeKind::kThrow;
        r.pos = at;
        r.a = parse_expression();
        end_statement();
        return add(r);
      }
      if (t.value == u"break" || t.value == u"continue") {
        const bool brk = t.value == u"break";
        if (loop_depth_ == 0 && (!brk || switch_depth_ == 0)) {
          throw SyntaxError{Str(brk ? u"Illegal break statement." : u"Illegal continue statement."), t.pos};
        }
        const std::uint32_t at = t.pos;
        next();
        Node r;
        r.kind = brk ? NodeKind::kBreak : NodeKind::kContinue;
        r.pos = at;
        end_statement();
        return add(r);
      }
    }
    const std::uint32_t id = parse_expression();
    end_statement();
    return id;
  }

  /// The statements of a `{ … }` body up to (and eating) the `}`, in the current scope.
  std::vector<std::uint32_t> parse_body() {
    std::vector<std::uint32_t> stmts;
    while (!is(u"}")) {
      if (peek().type == TokType::kEof) {
        throw SyntaxError{u"Expected " + lq() + u"}" + rq() + u" but found end of expression.", peek().pos};
      }
      stmts.push_back(parse_statement());
    }
    expect(u"}");
    return stmts;
  }

  std::uint32_t parse_block() {
    const DepthGuard g(depth_);
    const std::uint32_t at = peek().pos;
    expect(u"{");
    const std::uint32_t saved = cur_scope_;
    cur_scope_ = new_scope(saved, false);
    const std::vector<std::uint32_t> stmts = parse_body();
    Node block;
    block.kind = NodeKind::kBlock;
    block.scope = cur_scope_;
    block.pos = at;
    set_list(block, stmts);
    cur_scope_ = saved;
    return add(block);
  }

  /// `var a = 1, b` (also let / const). No terminator: `for (var …;` shares it.
  std::uint32_t parse_var_list() {
    const std::uint32_t at = peek().pos;
    const Str kw = next().value;
    const DeclKind kind = kw == u"var" ? DeclKind::kVar : kw == u"let" ? DeclKind::kLet : DeclKind::kConst;
    std::vector<std::uint32_t> decls;
    for (;;) {
      const Tok& name = next();
      if (name.type != TokType::kName || is_keyword(name.value)) {
        throw SyntaxError{u"Expected a variable name after " + lq() + kw + rq() + u" but found " + describe(name) + u".",
                          name.pos};
      }
      Node d;
      d.kind = NodeKind::kVarDecl;
      d.pos = name.pos;
      d.slot = declare(name.value, kind);
      if (eat(u"=")) {
        d.a = parse_assignment();
      } else if (kind == DeclKind::kConst) {
        throw SyntaxError{u"Missing initializer in const declaration of " + lq() + name.value + rq() + u".", name.pos};
      }
      decls.push_back(add(d));
      if (!eat(u",")) break;
    }
    Node list;
    list.kind = NodeKind::kVarList;
    list.pos = at;
    set_list(list, decls);
    return add(list);
  }

  std::uint32_t parse_if() {
    const DepthGuard g(depth_);
    const std::uint32_t at = next().pos;  // if
    expect(u"(");
    Node n;
    n.kind = NodeKind::kIf;
    n.pos = at;
    n.a = parse_expression();
    expect(u")");
    n.b = parse_statement();
    if (eat_name(u"else")) n.c = parse_statement();
    return add(n);
  }

  std::uint32_t parse_while() {
    const DepthGuard g(depth_);
    const std::uint32_t at = next().pos;  // while
    expect(u"(");
    Node n;
    n.kind = NodeKind::kWhile;
    n.pos = at;
    n.a = parse_expression();
    expect(u")");
    ++loop_depth_;
    n.b = parse_statement();
    --loop_depth_;
    return add(n);
  }

  std::uint32_t parse_do() {
    const DepthGuard g(depth_);
    const std::uint32_t at = next().pos;  // do
    Node n;
    n.kind = NodeKind::kDoWhile;
    n.pos = at;
    ++loop_depth_;
    n.b = parse_statement();
    --loop_depth_;
    if (!eat_name(u"while")) {
      throw SyntaxError{u"Expected " + lq() + u"while" + rq() + u" but found " + describe(peek()) + u".", peek().pos};
    }
    expect(u"(");
    n.a = parse_expression();
    expect(u")");
    (void)eat(u";");  // `do … while (…)` needs no separator after it
    return add(n);
  }

  std::uint32_t parse_for() {
    const DepthGuard g(depth_);
    const std::uint32_t at = next().pos;  // for
    expect(u"(");
    const std::uint32_t saved = cur_scope_;
    cur_scope_ = new_scope(saved, false);
    // for (var x of …) / for (x in …)
    const bool decl = is_name(u"var") || is_name(u"let") || is_name(u"const");
    const Tok& name_tok = peek_at(decl ? 1 : 0);
    const Tok& kw_tok = peek_at(decl ? 2 : 1);
    if (name_tok.type == TokType::kName && !is_keyword(name_tok.value) &&
        (tok_is_name(kw_tok, u"of") || tok_is_name(kw_tok, u"in"))) {
      Node n;
      n.kind = NodeKind::kForOf;
      n.pos = at;
      n.scope = cur_scope_;
      n.boolean = tok_is_name(kw_tok, u"of");
      if (decl) {
        const Str kw = next().value;
        const DeclKind kind = kw == u"var" ? DeclKind::kVar : kw == u"let" ? DeclKind::kLet : DeclKind::kConst;
        const Tok& name = next();
        Node d;
        d.kind = NodeKind::kVarDecl;
        d.pos = name.pos;
        // A const loop variable takes a new value every iteration: bind it as a let.
        d.slot = declare(name.value, kind == DeclKind::kConst ? DeclKind::kLet : kind);
        n.a = add(d);
      } else {
        n.a = parse_postfix(parse_primary());
        check_target(n.a, u"for…" + kw_tok.value + u" loop");
      }
      next();  // of / in
      n.b = parse_expression();
      expect(u")");
      ++loop_depth_;
      n.d = parse_statement();
      --loop_depth_;
      cur_scope_ = saved;
      return add(n);
    }
    Node n;
    n.kind = NodeKind::kFor;
    n.pos = at;
    n.scope = cur_scope_;
    if (!is(u";")) n.a = decl ? parse_var_list() : parse_expression();
    expect(u";");
    if (!is(u";")) n.b = parse_expression();
    expect(u";");
    if (!is(u")")) n.c = parse_expression();
    expect(u")");
    ++loop_depth_;
    n.d = parse_statement();
    --loop_depth_;
    cur_scope_ = saved;
    return add(n);
  }

  std::uint32_t parse_switch() {
    const DepthGuard g(depth_);
    const std::uint32_t at = next().pos;  // switch
    expect(u"(");
    Node n;
    n.kind = NodeKind::kSwitch;
    n.pos = at;
    n.a = parse_expression();
    expect(u")");
    expect(u"{");
    const std::uint32_t saved = cur_scope_;
    cur_scope_ = new_scope(saved, false);
    n.scope = cur_scope_;
    ++switch_depth_;
    std::vector<std::uint32_t> cases;
    bool seen_default = false;
    while (!eat(u"}")) {
      Node c;
      c.kind = NodeKind::kCase;
      c.pos = peek().pos;
      if (eat_name(u"case")) {
        c.a = parse_expression();
      } else if (is_name(u"default")) {
        if (seen_default) throw SyntaxError{u"More than one default clause in switch statement.", peek().pos};
        seen_default = true;
        next();
      } else {
        throw SyntaxError{u"Expected " + lq() + u"case" + rq() + u" or " + lq() + u"default" + rq() + u" but found " +
                              describe(peek()) + u".",
                          peek().pos};
      }
      expect(u":");
      std::vector<std::uint32_t> stmts;
      while (!is(u"}") && !is_name(u"case") && !is_name(u"default")) {
        if (peek().type == TokType::kEof) {
          throw SyntaxError{u"Expected " + lq() + u"}" + rq() + u" but found end of expression.", peek().pos};
        }
        stmts.push_back(parse_statement());
      }
      set_list(c, stmts);
      cases.push_back(add(c));
    }
    --switch_depth_;
    cur_scope_ = saved;
    set_list(n, cases);
    return add(n);
  }

  std::uint32_t parse_try() {
    const DepthGuard g(depth_);
    const std::uint32_t at = next().pos;  // try
    Node n;
    n.kind = NodeKind::kTry;
    n.pos = at;
    n.a = parse_block();
    if (is_name(u"catch")) {
      const std::uint32_t cat = next().pos;
      // The catch block is the parameter's scope.
      const std::uint32_t saved = cur_scope_;
      cur_scope_ = new_scope(saved, false);
      if (eat(u"(")) {
        const Tok& p = next();
        if (p.type != TokType::kName || is_keyword(p.value)) {
          throw SyntaxError{u"Expected a parameter name but found " + describe(p) + u".", p.pos};
        }
        n.decl = true;
        n.slot = declare(p.value, DeclKind::kLet);
        expect(u")");
      }
      if (!is(u"{")) throw SyntaxError{u"Expected " + lq() + u"{" + rq() + u" but found " + describe(peek()) + u".", peek().pos};
      const DepthGuard gb(depth_);
      next();  // {
      const std::vector<std::uint32_t> stmts = parse_body();
      Node block;
      block.kind = NodeKind::kBlock;
      block.scope = cur_scope_;
      block.pos = cat;
      set_list(block, stmts);
      cur_scope_ = saved;
      n.b = add(block);
    }
    if (eat_name(u"finally")) n.c = parse_block();
    if (n.b == kNoNode && n.c == kNoNode) throw SyntaxError{u"Missing catch or finally after try.", peek().pos};
    return add(n);
  }

  /// `function name(params) { body }` — a declaration (hoisted into its block,
  /// `decl`) or an expression (the name, if any, is not bound).
  std::uint32_t parse_function(bool decl) {
    const DepthGuard g(depth_);
    const std::uint32_t at = next().pos;  // function
    Node fn;
    fn.kind = NodeKind::kFunction;
    fn.decl = decl;
    fn.pos = at;
    if (peek().type == TokType::kName && !is_keyword(peek().value)) {
      const Str name = next().value;
      fn.str = add_string(name);
      if (decl) fn.slot = declare(name, DeclKind::kFunction);
    } else if (decl) {
      throw SyntaxError{u"Expected a function name but found " + describe(peek()) + u".", peek().pos};
    } else {
      fn.str = add_string(Str());
    }
    const std::uint32_t saved = cur_scope_;
    const int saved_loops = loop_depth_;
    const int saved_switches = switch_depth_;
    loop_depth_ = 0;
    switch_depth_ = 0;
    cur_scope_ = new_scope(saved, true);
    fn.scope = cur_scope_;
    expect(u"(");
    parse_params(u")", fn);
    expect(u")");
    fn.a = parse_block();
    fn.nslots = func_slots_[scopes_[cur_scope_].func];
    cur_scope_ = saved;
    loop_depth_ = saved_loops;
    switch_depth_ = saved_switches;
    return add(fn);
  }

  /// Parameter names up to `close` (not consumed); declared as slots 0..n-1.
  /// `name = expr` defaults go to `fn`'s list (one entry per parameter).
  void parse_params(std::u16string_view close, Node& fn) {
    std::uint32_t count = 0;
    std::vector<std::uint32_t> defaults;
    if (!is(close)) {
      for (;;) {
        const Tok& p = next();
        if (p.type != TokType::kName || is_keyword(p.value)) {
          throw SyntaxError{u"Expected a parameter name but found " + describe(p) + u".", p.pos};
        }
        (void)declare(p.value, DeclKind::kParam);
        ++count;
        defaults.push_back(eat(u"=") ? parse_assignment() : kNoNode);
        if (!eat(u",")) break;
      }
    }
    fn.count = count;
    if (std::ranges::any_of(defaults, [](std::uint32_t d) { return d != kNoNode; })) {
      fn.has_defaults = true;
      fn.list = static_cast<std::uint32_t>(prog_.lists.size());
      prog_.lists.insert(prog_.lists.end(), defaults.begin(), defaults.end());
    }
  }

  /// `(a, b) => …` / `a => …`: the parameters have been peeked; parse them and the body.
  std::uint32_t parse_arrow(bool parenthesised) {
    const DepthGuard g(depth_);
    Node fn;
    fn.kind = NodeKind::kFunction;
    fn.arrow = true;
    fn.pos = peek().pos;
    fn.str = add_string(Str());
    const std::uint32_t saved = cur_scope_;
    const int saved_loops = loop_depth_;
    const int saved_switches = switch_depth_;
    loop_depth_ = 0;
    switch_depth_ = 0;
    cur_scope_ = new_scope(saved, true);
    fn.scope = cur_scope_;
    if (parenthesised) {
      expect(u"(");
      parse_params(u")", fn);
      expect(u")");
    } else {
      (void)declare(next().value, DeclKind::kParam);
      fn.count = 1;
    }
    expect(u"=>");
    if (is(u"{")) {
      fn.a = parse_block();
    } else {
      fn.expr_body = true;
      fn.a = parse_assignment();
    }
    fn.nslots = func_slots_[scopes_[cur_scope_].func];
    cur_scope_ = saved;
    loop_depth_ = saved_loops;
    switch_depth_ = saved_switches;
    return add(fn);
  }

  /// At `(`: is this the parameter list of an arrow function? (The bracket's
  /// match is followed by `=>`.)
  [[nodiscard]] bool arrow_ahead() const {
    int depth = 0;
    for (std::size_t k = 0;; ++k) {
      const Tok& t = peek_at(k);
      if (t.type == TokType::kEof) return false;
      if (t.type != TokType::kPunct) continue;
      if (t.value == u"(" || t.value == u"[" || t.value == u"{") {
        ++depth;
      } else if (t.value == u")" || t.value == u"]" || t.value == u"}") {
        if (--depth == 0) return tok_is(peek_at(k + 1), u"=>");
      }
    }
  }

  // ── Expressions ─────────────────────────────────────────────────────────

  std::uint32_t parse_expression() { return parse_assignment(); }

  /// AssignmentExpression: a conditional, or `target = value` (right-associative).
  std::uint32_t parse_assignment() {
    const std::uint32_t left = parse_level(0, true);
    const Tok& t = peek();
    if (t.type != TokType::kPunct) return left;
    const std::optional<Op> op = assign_op(t.value);
    if (!op) return left;
    check_target(left, u"assignment");
    const std::uint32_t at = next().pos;
    const std::uint32_t right = parse_assignment();
    Node n;
    n.kind = NodeKind::kAssign;
    n.op = *op;
    n.a = left;
    n.b = right;
    n.pos = at;
    return add(n);
  }

  /// A valid assignment target: a name or a member. A name that nothing
  /// declares becomes a variable of the program (sloppy-mode JavaScript) —
  /// unless it is one of the language's own names.
  void check_target(std::uint32_t id, std::u16string_view what) {
    const Node& n = prog_.nodes[id];
    if (n.kind == NodeKind::kMember) return;
    if (n.kind != NodeKind::kIdent) throw SyntaxError{u"Invalid left-hand side in " + Str(what) + u".", n.pos};
    const Str& name = prog_.strings[n.str];
    if (visible(name)) return;
    if (n.global != Global::kNone) {
      throw SyntaxError{lq() + name + rq() + u" is a built-in name — declare your own variable with var.", n.pos};
    }
    (void)declare(name, DeclKind::kImplicit);
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

  struct Prefix {
    Op op = Op::kNone;
    bool update = false;  // ++ / --
    std::uint32_t pos = 0;
  };

  /// parseConditional (allow_conditional) or parseBinary(min_prec).
  std::uint32_t parse_level(int min_prec, bool allow_conditional) {
    const DepthGuard g(depth_);
    // parseUnary: prefix operators, applied innermost-last.
    std::vector<Prefix> prefix;
    for (;;) {
      const Tok& t = peek();
      if (t.type == TokType::kPunct && (t.value == u"-" || t.value == u"+" || t.value == u"!" || t.value == u"~")) {
        const Op op = t.value == u"-" ? Op::kNeg : t.value == u"+" ? Op::kPlus : t.value == u"!" ? Op::kNot : Op::kBitNot;
        prefix.push_back({.op = op, .update = false, .pos = t.pos});
      } else if (t.type == TokType::kPunct && (t.value == u"++" || t.value == u"--")) {
        prefix.push_back({.op = t.value == u"++" ? Op::kAdd : Op::kSub, .update = true, .pos = t.pos});
      } else if (t.type == TokType::kName && t.value == u"typeof") {
        prefix.push_back({.op = Op::kTypeof, .update = false, .pos = t.pos});
      } else {
        break;
      }
      next();
      enter(depth_);
    }
    std::uint32_t left = parse_postfix(parse_primary());
    for (const Prefix& p : std::views::reverse(prefix)) {
      Node node;
      if (p.update) {
        check_target(left, u"prefix operation");
        node.kind = NodeKind::kUpdate;
        node.prefix = true;
      } else {
        node.kind = NodeKind::kUnary;
      }
      node.op = p.op;
      node.a = left;
      node.pos = p.pos;
      left = add(node);
    }
    depth_ -= static_cast<int>(prefix.size());
    // parseBinary: all these operators are left-associative (`**` right).
    for (;;) {
      const Tok& t = peek();
      if (t.type != TokType::kPunct) break;
      const int prec = precedence_of(t.value);
      if (prec == 0 || prec < min_prec) break;
      const Op op = binary_op(t.value);
      const std::uint32_t at = next().pos;
      const std::uint32_t right = parse_level(op == Op::kPow ? prec : prec + 1, false);
      Node node;
      node.kind = (op == Op::kAnd || op == Op::kOr || op == Op::kNullish) ? NodeKind::kLogical : NodeKind::kBinary;
      node.op = op;
      node.a = left;
      node.b = right;
      node.pos = at;
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
    node.pos = prog_.nodes[left].pos;
    return add(node);
  }

  /// parseCallMember's loop over an already-parsed primary. A chain that
  /// holds a `?.` is wrapped in kOptChain, where a nullish `?.` ends it.
  std::uint32_t parse_postfix(std::uint32_t node) {
    bool chain = false;
    const auto done = [&](std::uint32_t id) {
      if (!chain) return id;
      Node w;
      w.kind = NodeKind::kOptChain;
      w.a = id;
      w.pos = prog_.nodes[id].pos;
      return add(w);
    };
    for (;;) {
      bool optional = false;
      if (eat(u"?.")) {
        optional = true;
        chain = true;
        if (!is(u"(") && !is(u"[")) {
          // `a?.b`: the name follows directly.
          node = member_named(node, true);
          continue;
        }
      }
      if (!optional && eat(u".")) {
        node = member_named(node, false);
      } else if (eat(u"[")) {
        const std::uint32_t property = parse_expression();
        expect(u"]");
        Node m;
        m.kind = NodeKind::kMember;
        m.a = node;
        m.b = property;
        m.computed = true;
        m.optional = optional;
        m.pos = prog_.nodes[property].pos;
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
        call.optional = optional;
        call.pos = prog_.nodes[node].pos;
        set_list(call, args);
        node = add(call);
      } else if ((is(u"++") || is(u"--")) && !peek().nl_before) {
        // Postfix ++/--: no line break allowed before it (`a\n++b` is two statements).
        check_target(node, u"postfix operation");
        Node u;
        u.kind = NodeKind::kUpdate;
        u.pos = peek().pos;
        u.op = next().value == u"++" ? Op::kAdd : Op::kSub;
        u.a = node;
        return done(add(u));
      } else {
        return done(node);
      }
    }
  }

  /// `.name` / `?.name`: the name token is next.
  std::uint32_t member_named(std::uint32_t object, bool optional) {
    const Tok& t = next();
    if (t.type != TokType::kName) throw_after_dot(t);
    Node prop;
    prop.kind = NodeKind::kStr;
    prop.str = add_string(t.value);
    prop.pos = t.pos;
    const std::uint32_t p = add(prop);
    Node m;
    m.kind = NodeKind::kMember;
    m.a = object;
    m.b = p;
    m.computed = false;
    m.optional = optional;
    m.key = key_of(t.value);
    m.str = prop.str;
    m.pos = t.pos;
    return add(m);
  }

  [[noreturn]] static void throw_after_dot(const Tok& t) {
    throw SyntaxError{u"Expected a property name after " + lq() + u"." + rq() + u".", t.pos};
  }
  [[noreturn]] static void throw_unexpected(const Tok& t) {
    throw SyntaxError{u"Unexpected " + describe(t) + u".", t.pos};
  }
  [[noreturn]] static void throw_bad_number(const Tok& t) {
    throw SyntaxError{lq() + t.value + rq() + u" isn’t a valid number.", t.pos};
  }

  /// `{ a: 1, "b c": 2, 3: x, d, }` — the `{` has been consumed.
  std::uint32_t parse_object(std::uint32_t at) {
    std::vector<std::uint32_t> items;
    while (!is(u"}")) {
      const Tok& k = next();
      Str key;
      if (k.type == TokType::kName || k.type == TokType::kStr) {
        key = k.value;
      } else if (k.type == TokType::kNum) {
        key = number_to_str(motion::js::string_to_number(std::u16string_view(k.value)));
      } else {
        throw SyntaxError{u"Expected a property name but found " + describe(k) + u".", k.pos};
      }
      const std::uint32_t key_node = str_node(key, k.pos);
      std::uint32_t value = kNoNode;
      if (eat(u":")) {
        value = parse_assignment();
      } else if (k.type == TokType::kName && !is_keyword(k.value) && (is(u",") || is(u"}"))) {
        // Shorthand `{ a }`: the variable a.
        Node id;
        id.kind = NodeKind::kIdent;
        id.str = add_string(k.value);
        id.global = global_of(k.value);
        id.pos = k.pos;
        value = add(id);
      } else {
        throw SyntaxError{u"Expected " + lq() + u":" + rq() + u" but found " + describe(peek()) + u".", peek().pos};
      }
      items.push_back(key_node);
      items.push_back(value);
      if (!eat(u",")) break;
    }
    expect(u"}");
    Node node;
    node.kind = NodeKind::kObject;
    node.pos = at;
    set_list(node, items);
    return add(node);
  }

  /// A template literal; its first piece has been consumed.
  std::uint32_t parse_template(const Tok& first) {
    std::vector<std::uint32_t> parts;
    parts.push_back(str_node(first.value, first.pos));
    bool tail = first.tail;
    while (!tail) {
      parts.push_back(parse_expression());
      const Tok& piece = next();
      if (piece.type != TokType::kTemplate) {
        throw SyntaxError{u"Expected " + lq() + u"}" + rq() + u" but found " + describe(piece) + u".", piece.pos};
      }
      parts.push_back(str_node(piece.value, piece.pos));
      tail = piece.tail;
    }
    Node node;
    node.kind = NodeKind::kTemplate;
    node.pos = first.pos;
    set_list(node, parts);
    return add(node);
  }

  std::uint32_t parse_primary() {
    const Tok& t = peek();
    if (t.type == TokType::kName) {
      if (t.value == u"function") return parse_function(false);
      const Tok& after = peek_at(1);
      if (!is_keyword(t.value) && after.type == TokType::kPunct && after.value == u"=>") return parse_arrow(false);
    }
    if (t.type == TokType::kPunct && t.value == u"(" && arrow_ahead()) return parse_arrow(true);
    next();
    if (t.type == TokType::kNum) {
      const double value = motion::js::string_to_number(std::u16string_view(t.value));
      if (!(value - value == 0)) throw_bad_number(t);  // !Number.isFinite(value)
      Node node;
      node.kind = NodeKind::kNum;
      node.num = value;
      node.pos = t.pos;
      return add(node);
    }
    if (t.type == TokType::kStr) {
      Node node;
      node.kind = NodeKind::kStr;
      node.str = add_string(t.value);
      node.pos = t.pos;
      return add(node);
    }
    if (t.type == TokType::kTemplate) return parse_template(t);
    if (t.type == TokType::kName) {
      Node node;
      node.pos = t.pos;
      if (t.value == u"true" || t.value == u"false") {
        node.kind = NodeKind::kBool;
        node.boolean = t.value == u"true";
      } else if (t.value == u"null" || t.value == u"undefined") {
        node.kind = NodeKind::kNull;
      } else if (is_keyword(t.value)) {
        throw_unexpected(t);
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
        node.pos = t.pos;
        set_list(node, items);
        return add(node);
      }
      if (t.value == u"{") {
        const DepthGuard g(depth_);
        return parse_object(t.pos);
      }
    }
    throw_unexpected(t);
  }

  // ── Name resolution (after the parse: declarations hoist) ───────────────

  struct Found {
    std::uint32_t slot = 0;
    std::uint16_t depth = 0;
    bool is_const = false;
  };

  [[nodiscard]] std::optional<Found> lookup(const Str& name) const {
    std::uint16_t depth = 0;
    for (const std::uint32_t sid : std::views::reverse(scope_stack_)) {
      const Scope& s = scopes_[sid];
      for (const Decl& d : s.decls) {
        if (d.name == name) return Found{.slot = d.slot, .depth = depth, .is_const = d.is_const};
      }
      if (s.is_func) ++depth;
    }
    return std::nullopt;
  }

  static bool has_scope(NodeKind k) noexcept {
    return k == NodeKind::kBlock || k == NodeKind::kFunction || k == NodeKind::kFor || k == NodeKind::kForOf ||
           k == NodeKind::kSwitch;
  }

  void resolve(std::uint32_t id) {
    if (id == kNoNode) return;
    Node& n = prog_.nodes[id];
    if (n.kind == NodeKind::kIdent) {
      if (const auto f = lookup(prog_.strings[n.str])) {
        n.kind = NodeKind::kLocal;
        n.slot = f->slot;
        n.depth = f->depth;
        n.boolean = f->is_const;
      }
      return;
    }
    const NodeKind kind = n.kind;
    if (has_scope(kind)) scope_stack_.push_back(n.scope);
    // The node array never grows during resolution, so `n` stays valid; its
    // links are copied out only so the recursion reads naturally.
    resolve(n.a);
    resolve(n.b);  // a non-computed member's b is its kStr name: a no-op
    resolve(n.c);
    resolve(n.d);
    // kFunction's count is its parameter count; its list (if any) the defaults.
    if (kind != NodeKind::kFunction || n.has_defaults) {
      for (std::uint32_t i = 0; i < n.count; ++i) resolve(prog_.lists[n.list + i]);
    }
    if (has_scope(kind)) scope_stack_.pop_back();
  }

  std::vector<Tok> toks_;
  std::size_t pos_ = 0;
  int depth_ = 0;
  int loop_depth_ = 0;
  int switch_depth_ = 0;
  Program prog_;
  std::vector<Scope> scopes_;
  std::vector<std::uint32_t> func_slots_;
  std::vector<std::uint32_t> scope_stack_;
  std::uint32_t cur_scope_ = kNoNode;
  bool any_decls_ = false;
};

}  // namespace

Program parse(std::u16string_view src) { return Parser(src).parse(); }

}  // namespace motion::expr::detail
