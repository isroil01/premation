// motion_expr internals — the evaluator (exprLang.ts evaluateExpression +
// expressions.ts evaluateRaw's scope).

#ifndef MOTION_EXPR_INTERP_HPP
#define MOTION_EXPR_INTERP_HPP

#include <array>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <utility>
#include <initializer_list>
#include <optional>
#include <span>
#include <string>
#include <vector>

#include "program.hpp"
#include "value.hpp"

namespace motion::expr::detail {

/// Thrown for any failed evaluation (exprLang.ts ExprRuntimeError, the API's
/// `throw new Error(...)`, and the V8 TypeErrors/RangeErrors the TypeScript
/// would raise). `message` is pre-humanize, as the TypeScript's `e.message`.
struct EvalError : std::exception {
  explicit EvalError(Str m) : message(std::move(m)) {}
  [[nodiscard]] const char* what() const noexcept override { return "motion::expr::EvalError"; }
  Str message;
};

/// Arguments of one call. Missing arguments read as `undefined`.
class Args {
 public:
  explicit Args(std::span<const Value> v) noexcept : v_(v) {}
  [[nodiscard]] Value operator[](std::size_t i) const noexcept { return i < v_.size() ? v_[i] : Value{}; }
  [[nodiscard]] std::size_t size() const noexcept { return v_.size(); }
  [[nodiscard]] std::span<const Value> span() const noexcept { return v_; }

 private:
  std::span<const Value> v_;
};

class Interp {
 public:
  Interp(const Program& prog, const Context& ctx, Arena& arena) : prog_(prog), ctx_(ctx), arena_(arena) {}

  /// exprLang.ts `evaluateExpression`: the shared budget + the root node.
  Value run();

  // ── Used by stdlib.cpp / sourcetext.cpp ──
  [[nodiscard]] Arena& arena() noexcept { return arena_; }
  [[nodiscard]] const Context& ctx() const noexcept { return ctx_; }
  [[nodiscard]] Value call(const Value& fn, const Value& this_arg, Args args);
  [[nodiscard]] Value read_member(const Value& obj, const Value& key, KeyId kid);
  /// The (memoised, so identity-stable) function object for an unbound builtin.
  [[nodiscard]] Value fn_value(Fn fn);
  [[nodiscard]] Value bound_fn(Fn fn, const Value& bound, std::uint8_t aux = 0, std::size_t state = 0);
  [[nodiscard]] Value str(Str s) { return Value::string(arena_.str(std::move(s))); }
  [[nodiscard]] Value array(std::vector<Value> elems);
  [[nodiscard]] Value plain(std::initializer_list<Prop> props);

 private:
  Value eval(std::uint32_t id);
  Value eval_inner(const Node& n);
  Value eval_call(const Node& n);
  Value global(const Node& n);
  Value binary(Op op, const Value& l, const Value& r);

  // expressions.ts API
  Value call_api(const Obj& f, Args a);
  double self_at(const Value& t);
  double velocity_at(const Value& t);
  double next_random();
  Value wiggle(Args a);
  Value range_fn(Fn fn, Args a);
  Value space_fn(const Obj& f, Args a);
  Value key_fn(const Value& n);
  Value nearest_key(Args a);
  Value loop(bool out, const Value& mode);
  Value layer_at(const Value& name, const Value& prop, const Value& t);
  Value source_rect(Args a);
  Value zip(const Value& a, const Value& b, Op op);

  // Scope objects (built on first use, one per evaluation)
  Value this_comp();
  Value this_layer();
  Value this_property();
  Value property_value();
  Value own_space_fn(Fn fn);
  Value marker_scope(MarkerScope scope);
  Value text_group(const Value& name);
  Value comp_layer(const Value& name, const Value& prop);

  // Markers
  struct MarkerList {
    bool built = false;
    std::vector<Value> sorted;  // marker objects, ascending time, index = position + 1
    Value empty;
  };
  MarkerList& markers(MarkerScope scope);
  Value marker_key(MarkerScope scope, const Value& n);
  Value marker_nearest(MarkerScope scope, Args a);

 public:
  // Source Text (sourcetext.cpp)
  Value source_text_of(const Value& name, double t);
  Value make_source_text_value(const SourceTextSample& sample, bool foreign);
  Value make_style(StyleState state);
  Value read_style(const Obj& style, KeyId kid);
  Value read_string_object(const Obj& so, const Value& key, KeyId kid);
  Value call_style(const Obj& f, Args a);

 private:
  // An Interp lives for exactly one evaluation, on the caller's stack, and
  // never outlives these three; references state that none can be empty.
  const Program& prog_;  // NOLINT(cppcoreguidelines-avoid-const-or-ref-data-members)
  const Context& ctx_;   // NOLINT(cppcoreguidelines-avoid-const-or-ref-data-members)
  Arena& arena_;         // NOLINT(cppcoreguidelines-avoid-const-or-ref-data-members)
  CompInfo comp_ = ctx_.comp.value_or(CompInfo{});

  std::array<Obj*, static_cast<std::size_t>(Fn::kCount_)> fn_cache_{};
  Value this_comp_;
  Value this_layer_;
  Value this_property_;
  Value property_value_;
  bool property_value_built_ = false;
  std::array<Value, 4> own_space_{};
  std::array<Value, 2> marker_scope_{};
  std::array<MarkerList, 2> markers_{};
  Value own_text_;
  Value plugin_;
  Value math_;
  std::optional<double> velocity_;

  // AE's random sequence: (seed, call index) → value; see expressions.ts.
  Value random_seed_ = ctx_.prop_seed ? Value::number(*ctx_.prop_seed) : Value::number(0);
  double random_counter_ = 0;
};

// stdlib.cpp — Math and the Object/Function/Number/Boolean/String/Array prototypes.
[[nodiscard]] Value read_math(Interp& in, KeyId kid);
/// Prototype member for a primitive or object receiver, or nullopt if none.
[[nodiscard]] std::optional<Value> read_proto(Interp& in, const Value& receiver, KeyId kid);
[[nodiscard]] Value call_std(Interp& in, const Obj& f, const Value& this_arg, Args a);
/// A builtin's `.name` / `.length`, as V8 reports them for the TypeScript's
/// functions (arrow functions: inferred name, params before the first default).
[[nodiscard]] std::u16string_view function_name(const Obj& f, const Context& ctx);
[[nodiscard]] double function_length(const Obj& f, const Context& ctx);

// Helpers shared by the builtins.
[[nodiscard]] double integer_or_infinity(double d) noexcept;  // ToIntegerOrInfinity
[[noreturn]] void throw_eval(Str message);
/// JS hash01 / smoothNoise (expressions.ts), on motion::js::sin.
[[nodiscard]] double hash01(double n) noexcept;
[[nodiscard]] double smooth_noise(double x) noexcept;

}  // namespace motion::expr::detail

#endif  // MOTION_EXPR_INTERP_HPP
