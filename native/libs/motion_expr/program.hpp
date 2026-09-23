// motion_expr internals — the parsed expression (exprLang.ts `ExprNode`).
//
// A flat node array with index links instead of a pointer tree: a 200 000-term
// `1+1+…` (which the TypeScript parses and then refuses to evaluate) builds and
// frees without recursion, and a Program is one allocation-stable block that
// Values may point into (string literals).

#ifndef MOTION_EXPR_PROGRAM_HPP
#define MOTION_EXPR_PROGRAM_HPP

#include <cstdint>
#include <exception>
#include <utility>
#include <string>
#include <string_view>
#include <vector>

#include "value.hpp"

namespace motion::expr::detail {

enum class NodeKind : std::uint8_t {
  kNum, kStr, kBool, kNull, kIdent, kArray, kMember, kCall, kUnary, kBinary, kLogical, kConditional
};

enum class Op : std::uint8_t {
  kNone,
  // binary (exprLang.ts BinaryOp)
  kMul, kDiv, kMod, kAdd, kSub, kLt, kLe, kGt, kGe, kEq, kNe, kStrictEq, kStrictNe,
  // logical
  kAnd, kOr,
  // unary
  kNeg, kPlus, kNot
};

inline constexpr std::uint32_t kNoNode = 0xffffffffU;

struct Node {
  NodeKind kind = NodeKind::kNull;
  Op op = Op::kNone;
  bool computed = false;    // member: a[b] vs a.b
  bool boolean = false;     // kBool
  Global global = Global::kNone;  // kIdent: resolved scope slot (kNone → "X is not defined")
  KeyId key = KeyId::kUnknown;    // kMember (non-computed): the property's KeyId
  double num = 0;           // kNum
  std::uint32_t a = kNoNode;  // member object / call callee / unary arg / binary left / cond test
  std::uint32_t b = kNoNode;  // member property / binary right / cond consequent
  std::uint32_t c = kNoNode;  // cond alternate
  std::uint32_t list = 0;     // array items / call args: first index into Program::lists
  std::uint32_t count = 0;    // … and how many
  std::uint32_t str = 0;      // kStr / kIdent / non-computed member: index into Program::strings
};

struct Program {
  std::vector<Node> nodes;
  std::vector<std::uint32_t> lists;
  std::vector<Str> strings;  // never grows after parse: Values point into it
  std::uint32_t root = kNoNode;
};

/// Thrown by the lexer/parser (exprLang.ts ExprSyntaxError).
struct SyntaxError : std::exception {
  explicit SyntaxError(Str m) : message(std::move(m)) {}
  [[nodiscard]] const char* what() const noexcept override { return "motion::expr::SyntaxError"; }
  Str message;
};

/// Parse `src` (already trimmed) into a Program. Throws SyntaxError.
[[nodiscard]] Program parse(std::u16string_view src);

}  // namespace motion::expr::detail

#endif  // MOTION_EXPR_PROGRAM_HPP
