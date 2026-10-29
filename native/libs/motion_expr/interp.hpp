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
  explicit EvalError(Str m, bool f = false) : message(std::move(m)), fatal(f) {}
  [[nodiscard]] const char* what() const noexcept override { return "motion::expr::EvalError"; }
  Str message;
  /// A budget (steps, depth, loop count): `try … catch` in the language
  /// cannot catch it, so a rig can never turn a runaway into a value.
  bool fatal;
};

/// Thrown by a `?.` whose object is null / undefined; the enclosing kOptChain
/// turns it into `undefined`. Never leaves the interpreter.
struct ShortCircuit {};

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
  /// After `run` threw: the source offset of the innermost node that failed
  /// (kNoPos when none is known).
  [[nodiscard]] std::uint32_t error_pos() const noexcept { return err_pos_; }

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
  /// The next value of AE's random sequence — random(), gaussRandom() and
  /// Math.random() all draw from it.
  double next_random();

 private:
  Value eval(std::uint32_t id);
  Value eval_inner(std::uint32_t id);
  Value eval_call(const Node& n);
  Value global(const Node& n);
  Value binary(Op op, const Value& l, const Value& r);
  /// AE's vector arithmetic on `+ - * /`: array ⊕ array, array ⊕ number.
  std::optional<Value> vector_binary(Op op, const Value& l, const Value& r);

  // Statements, locals and functions (docs/EXPRESSION_LANGUAGE.md)
  enum class Flow : std::uint8_t { kNormal, kBreak, kContinue, kReturn };
  /// An assignment target: a local slot or an object member, evaluated once.
  struct Ref {
    Env* env = nullptr;  // local: the frame
    std::uint32_t slot = 0;
    bool is_const = false;
    bool local = false;
    Value obj;           // member: the object…
    Value key;           // … and the key
    KeyId kid = KeyId::kUnknown;
  };
  Ref ref_of(const Node& target);
  Value ref_get(const Ref& r);
  void ref_set(const Ref& r, const Value& v);
  Env& frame(std::uint16_t depth);
  Value exec_block(const Node& n);
  Value exec_loop(const Node& n);
  Value exec_do_while(const Node& n);
  Value exec_for_of(const Node& n);
  Value exec_switch(const Node& n);
  Value exec_try(const Node& n);
  Value eval_object(const Node& n);
  Value eval_template(const Node& n);
  /// Run one loop body; true when the loop must stop (break / return).
  bool loop_body(std::uint32_t body, Value& last);
  void note_pos(std::uint32_t id) noexcept {
    if (err_pos_ == kNoPos) err_pos_ = prog_.nodes[id].pos;
  }
  Value closure(std::uint32_t id);
  Value call_user(const Obj& f, Args args);
  Value type_of(const Value& v);

  // expressions.ts API
  Value call_api(const Obj& f, Args a);
  double self_at(const Value& t);
  double velocity_at(const Value& t);
  /// expressions.ts `needTime`: valueAtTime/velocityAtTime need a numeric time.
  void need_time(const Value& t, std::u16string_view fn);
  Value wiggle(Args a);
  Value range_fn(Fn fn, Args a);
  Value space_fn(const Obj& f, Args a);
  Value key_fn(const Value& n);
  Value nearest_key(Args a);
  // AE's data footage (data.cpp)
  Value footage(const Value& name);
  Value footage_table(Obj& f);
  Value footage_source_data(Obj& f);
  Value footage_data_value(Obj& f, const Value& path);
  Value footage_data_key_count(Obj& f, const Value& path);
  // AE path properties (path.cpp)
  Value make_path(PathSample sample, const Value& layer, std::uint8_t source, const Value& name);
  Value create_path(Args a);
  Value path_method(Fn fn, Obj& self, Args a);
  Value layer_mask(const Value& layer, const Value& name);
  Value layer_content(const Value& layer, const Value& name);
  /// AE `layer.sampleImage(point, radius = [0.5, 0.5], postEffect = true, t = time)`.
  Value sample_image(const Value& layer, Args a);
  Value path_of(Obj& holder);
  /// loopOut / loopIn (limit = numKeyframes) and loopOutDuration / loopInDuration (limit = seconds).
  Value loop(bool out, const Value& mode, const Value& limit, bool by_duration);
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

  // Cameras and lights (camera program D6)
  /// The camera / light members every layer object carries (`bound`: the layer
  /// name or `#id`, null = this layer).
  void add_layer_members(std::vector<Prop>& props, const Value& bound);
  Value plain_bound(std::vector<Prop> props, const Value& bound);
  Value read_layer_lazy(Obj& o, const Prop& p);
  Value active_camera();
  Value look_at(Args a);
  Value space_vec_fn(const Obj& f, Args a);
  // AE-style rigs: layer facts, the transform group, effect("Name")("Param")
  Value layer_fact(const Obj& o, KeyId key);
  Value transform_group(const Value& bound);
  Value effect_fn(const Obj& f, Args a);
  Value effect_param(const Obj& f, Args a);

  // AE property objects and globals (2026-10-21)
  /// Turn a sampled value (a fresh array or a number) into a property object.
  Value prop_object(const Value& v, PropKind kind, const Value& bound, KeyId pkey, const Str* effect, const Value& arg);
  /// A layer property (position, rotation…) of `bound` (null = this layer) at `t`, as a plain value.
  Value sample_layer(const Value& bound, KeyId key, double t);
  /// A property object's plain value at `t` (`prop` nullptr = the expression's own property).
  Value sample_prop(const Obj* prop, double t);
  Value prop_velocity(const Obj* prop, double t);
  std::optional<Value> prop_member(Obj& o, KeyId kid);
  std::vector<double> prop_key_times(const Obj& o);
  Value prop_key(const Obj& o, const Value& n);
  Value prop_nearest_key(const Obj& o, Args a);
  Value smooth(const Obj* prop, Args a);
  Value temporal_wiggle(Args a);
  Value comp_fn(Args a);
  Value comp_layer_by_name(const Obj& f, Args a);
  Value color_convert(bool to_rgb, const Value& v);
  Value timecode(const Value& t, const Value& base);

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
  std::array<Value, 4> own_space_{};
  std::array<Value, 2> marker_scope_{};
  std::array<MarkerList, 2> markers_{};
  Value own_text_;
  Value active_camera_;
  Value plugin_;
  Value math_;
  std::optional<double> velocity_;

  // AE's random sequence: (seed, call index) → value; see expressions.ts.
  Value random_seed_ = ctx_.prop_seed ? Value::number(*ctx_.prop_seed) : Value::number(0);
  double random_counter_ = 0;

  // Statements: the current frame, the pending return value, and (below)
  // the control flow and whether the statement just run produced a
  // completion value (`stmt_empty_` false).
  Env* env_ = nullptr;
  Value return_value_;
  // `throw v`: the value, for the `catch (e)` that receives it.
  Value thrown_;
  std::uint32_t err_pos_ = kNoPos;

  // The flags, together (padding).
  bool property_value_built_ = false;
  bool active_camera_built_ = false;
  bool random_timeless_ = false;  // seedRandom(s, true)
  bool stmt_empty_ = false;
  bool has_thrown_ = false;
  Flow flow_ = Flow::kNormal;
};

/// Most times one loop may iterate in an evaluation; past it the expression
/// fails with a stated error. Below half the step budget (kMaxEvalSteps), so
/// even an empty loop body reports the loop, not "too expensive".
inline constexpr int kMaxLoopIterations = 50000;
/// Most elements an expression may give an array by index assignment.
inline constexpr std::size_t kMaxArrayLength = 1U << 20U;

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
/// path.cpp: a returned value as a path (nullopt when it is not a path object).
[[nodiscard]] std::optional<PathSample> path_sample_of(const Value& v);
/// A budget error: not catchable by the language's `try`.
[[noreturn]] void throw_fatal(Str message);
/// JS hash01 / smoothNoise (expressions.ts), on motion::js::sin.
[[nodiscard]] double hash01(double n) noexcept;
[[nodiscard]] double smooth_noise(double x) noexcept;

}  // namespace motion::expr::detail

#endif  // MOTION_EXPR_INTERP_HPP
