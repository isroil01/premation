// The evaluator — exprLang.ts evalNode/applyBinary/readMember, and the scope
// that expressions.ts `evaluateRaw` builds (every API function is ported
// here with its JavaScript coercions: an argument that is a string where a
// number is expected behaves as it does in TypeScript, `+` included).

#include "interp.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <numbers>
#include <optional>
#include <span>
#include <string>
#include <utility>
#include <vector>

#include "jsmath.hpp"
#include "ops.hpp"

namespace motion::expr::detail {
namespace {

/// exprLang.ts module state (`steps`, `depth`, `nodeDepth`). Per thread,
/// because a cross-layer read re-enters the evaluator on the same thread and
/// must SHARE the caller's budget — exactly the TypeScript's module globals.
struct Budget {
  int steps = 0;
  int depth = 0;
  int node_depth = 0;
};
thread_local Budget g_budget;  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables) — see above

// Functions, not globals: a static std::u16string may throw at startup. They
// return Str (not a view) because every use is a `+` concatenation.
Str lq() { return u"“"; }  // NOLINT(modernize-use-string-view)
Str rq() { return u"”"; }  // NOLINT(modernize-use-string-view)

double js_max2(double a, double b) noexcept {
  const std::array<double, 2> v{a, b};
  return motion::js::max_of(v);
}
double js_min2(double a, double b) noexcept {
  const std::array<double, 2> v{a, b};
  return motion::js::min_of(v);
}

}  // namespace

void throw_eval(Str message) { throw EvalError{std::move(message)}; }

double integer_or_infinity(double d) noexcept {
  if (std::isnan(d) || d == 0) return 0;
  if (std::isinf(d)) return d;
  return std::trunc(d);
}

double hash01(double n) noexcept {
  const double s = motion::js::sin(n * 127.1) * 43758.5453;
  return s - std::floor(s);
}

double smooth_noise(double x) noexcept {
  const double xi = std::floor(x);
  const double xf = x - xi;
  const double a = hash01(xi);
  const double b = hash01(xi + 1);
  const double u = xf * xf * (3 - 2 * xf);
  return a + (b - a) * u;
}

// ── Values ──────────────────────────────────────────────────────────────────

Value Interp::array(std::vector<Value> elems) {
  Obj* o = arena_.obj(ObjKind::kArray);
  o->elems = std::move(elems);
  return Value::object(o);
}

Value Interp::plain(std::initializer_list<Prop> props) {
  Obj* o = arena_.obj(ObjKind::kPlain);
  o->props.assign(props.begin(), props.end());
  return Value::object(o);
}

Value Interp::fn_value(Fn fn) {
  Obj*& slot = fn_cache_[static_cast<std::size_t>(fn)];
  if (slot == nullptr) {
    slot = arena_.obj(ObjKind::kFunction);
    slot->fn = fn;
  }
  return Value::object(slot);
}

Value Interp::bound_fn(Fn fn, const Value& bound, std::uint8_t aux, std::size_t state) {
  Obj* o = arena_.obj(ObjKind::kFunction);
  o->fn = fn;
  o->bound = bound;
  o->aux = aux;
  o->state = state;
  return Value::object(o);
}

// ── evaluateExpression / evalNode ───────────────────────────────────────────

Value Interp::run() {
  Budget& b = g_budget;
  // The budget resets only at the OUTERMOST entry, so a cross-layer read shares
  // its caller's allowance instead of being handed a fresh one.
  if (b.depth == 0) {
    b.steps = 0;
    b.node_depth = 0;
  }
  ++b.depth;
  struct Leave {
    Leave() = default;
    Leave(const Leave&) = delete;
    Leave(Leave&&) = delete;
    Leave& operator=(const Leave&) = delete;
    Leave& operator=(Leave&&) = delete;
    ~Leave() { --g_budget.depth; }
  } const leave;
  return eval(prog_.root);
}

Value Interp::eval(std::uint32_t id) {
  Budget& b = g_budget;
  b.steps += 1;
  if (b.steps > kMaxEvalSteps) throw_eval(u"This expression is too expensive to evaluate.");
  if (b.node_depth >= kMaxEvalDepth) throw_eval(u"This expression is nested too deeply.");
  b.node_depth += 1;
  struct Leave {
    Leave() = default;
    Leave(const Leave&) = delete;
    Leave(Leave&&) = delete;
    Leave& operator=(const Leave&) = delete;
    Leave& operator=(Leave&&) = delete;
    ~Leave() { g_budget.node_depth -= 1; }
  } const leave;
  return eval_inner(prog_.nodes[id]);
}

namespace {

/// The key of a member node as a Value, and its KeyId.
struct MemberKey {
  Value key;
  KeyId kid = KeyId::kUnknown;
};

KeyId kid_of(const Value& key) {
  if (key.tag == Tag::kString) return key_of(*key.s);
  return key_of(number_to_str(key.n));
}

}  // namespace

Value Interp::eval_inner(const Node& n) {
  switch (n.kind) {
    case NodeKind::kNum:
      return Value::number(n.num);
    case NodeKind::kStr:
      return Value::string(&prog_.strings[n.str]);
    case NodeKind::kBool:
      return Value::boolean(n.boolean);
    case NodeKind::kNull:
      return Value::null();
    case NodeKind::kIdent:
      return global(n);
    case NodeKind::kArray: {
      std::vector<Value> items;
      items.reserve(n.count);
      for (std::uint32_t i = 0; i < n.count; ++i) items.push_back(eval(prog_.lists[n.list + i]));
      return array(std::move(items));
    }
    case NodeKind::kMember: {
      const Value object = eval(n.a);
      Value key;
      KeyId kid = n.key;
      if (n.computed) {
        key = eval(n.b);
        if (key.tag != Tag::kString && key.tag != Tag::kNumber) {
          throw_eval(u"Property names must be a string or number.");
        }
        kid = kid_of(key);
      } else {
        key = Value::string(&prog_.strings[n.str]);
      }
      return read_member(object, key, kid);
    }
    case NodeKind::kCall:
      return eval_call(n);
    case NodeKind::kUnary: {
      const Value v = eval(n.a);
      if (n.op == Op::kNot) return Value::boolean(!truthy(v));
      const double d = to_number(v);
      return Value::number(n.op == Op::kNeg ? -d : +d);
    }
    case NodeKind::kLogical: {
      // Short-circuit, like JS — the right side must not evaluate.
      const Value left = eval(n.a);
      if (n.op == Op::kAnd) return truthy(left) ? eval(n.b) : left;
      return truthy(left) ? left : eval(n.b);
    }
    case NodeKind::kBinary: {
      const Value l = eval(n.a);
      const Value r = eval(n.b);
      return binary(n.op, l, r);
    }
    case NodeKind::kConditional:
      return truthy(eval(n.a)) ? eval(n.b) : eval(n.c);
  }
  return {};
}

Value Interp::eval_call(const Node& n) {
  const Node& callee = prog_.nodes[n.a];
  Value this_arg;
  Value fn;
  if (callee.kind == NodeKind::kMember) {
    // Member calls need their receiver as `this`.
    this_arg = eval(callee.a);
    Value key;
    KeyId kid = callee.key;
    if (callee.computed) {
      key = eval(callee.b);
      if (key.tag != Tag::kString && key.tag != Tag::kNumber) {
        throw_eval(u"Property names must be a string or number.");
      }
      kid = kid_of(key);
    } else {
      key = Value::string(&prog_.strings[callee.str]);
    }
    fn = read_member(this_arg, key, kid);
    if (!is_callable(fn)) throw_eval(to_string(key) + u" is not a function");
  } else {
    fn = eval(n.a);
    if (!is_callable(fn)) {
      const Str name = callee.kind == NodeKind::kIdent ? prog_.strings[callee.str] : Str(u"That");
      throw_eval(name + u" is not a function");
    }
  }
  std::array<Value, 8> small{};
  std::vector<Value> big;
  std::span<const Value> args;
  if (n.count <= small.size()) {
    for (std::uint32_t i = 0; i < n.count; ++i) small[i] = eval(prog_.lists[n.list + i]);
    args = std::span<const Value>(small.data(), n.count);
  } else {
    big.reserve(n.count);
    for (std::uint32_t i = 0; i < n.count; ++i) big.push_back(eval(prog_.lists[n.list + i]));
    args = big;
  }
  return call(fn, this_arg, Args(args));
}

Value Interp::binary(Op op, const Value& l, const Value& r) {
  switch (op) {
    // `+` stays polymorphic so string concat works ('a' + 'b').
    case Op::kAdd:
      return js_add(l, r, arena_);
    case Op::kSub:
      return Value::number(to_number(l) - to_number(r));
    case Op::kMul:
      return Value::number(to_number(l) * to_number(r));
    case Op::kDiv:
      return Value::number(to_number(l) / to_number(r));
    case Op::kMod:
      return Value::number(motion::js::mod(to_number(l), to_number(r)));
    case Op::kLt:
      return Value::boolean(less_than(l, r).value_or(false));
    case Op::kGt:
      return Value::boolean(less_than(r, l).value_or(false));
    case Op::kLe: {
      const std::optional<bool> x = less_than(r, l);
      return Value::boolean(x.has_value() && !*x);
    }
    case Op::kGe: {
      const std::optional<bool> x = less_than(l, r);
      return Value::boolean(x.has_value() && !*x);
    }
    case Op::kEq:
      return Value::boolean(loose_equals(l, r));
    case Op::kNe:
      return Value::boolean(!loose_equals(l, r));
    case Op::kStrictEq:
      return Value::boolean(strict_equals(l, r));
    case Op::kStrictNe:
      return Value::boolean(!strict_equals(l, r));
    default:
      break;
  }
  return {};
}

// ── readMember ──────────────────────────────────────────────────────────────

Value Interp::read_member(const Value& obj, const Value& key, KeyId kid) {
  if (obj.is_nullish()) {
    throw_eval(u"Cannot read " + lq() + to_string(key) + rq() + u" of " + (obj.is_null() ? u"null" : u"undefined") +
               u".");
  }
  if (key.tag == Tag::kString && (kid == KeyId::k_proto_escape || kid == KeyId::k_constructor ||
                                  kid == KeyId::k_prototype)) {
    throw_eval(u"Access to " + lq() + *key.s + rq() + u" isn’t allowed.");
  }
  switch (obj.tag) {
    case Tag::kString: {
      if (kid == KeyId::k_length) return Value::number(static_cast<double>(obj.s->size()));
      if (const auto idx = array_index_of(key)) {
        if (*idx < obj.s->size()) return str(Str(1, (*obj.s)[*idx]));
        return {};
      }
      return read_proto(*this, obj, kid).value_or(Value{});
    }
    case Tag::kNumber:
    case Tag::kBool:
      return read_proto(*this, obj, kid).value_or(Value{});
    case Tag::kObject:
      break;
    default:
      return {};
  }
  Obj& o = *obj.o;
  switch (o.kind) {
    case ObjKind::kArray: {
      if (kid == KeyId::k_length) return Value::number(static_cast<double>(o.elems.size()));
      if (const auto idx = array_index_of(key)) {
        if (*idx < o.elems.size()) return o.elems[*idx];
        return {};
      }
      break;
    }
    case ObjKind::kPlain: {
      if (kid == KeyId::kUnknown) break;
      for (Prop& p : o.props) {
        if (p.key != kid) continue;
        switch (p.lazy) {
          case Lazy::kNone:
            return p.value;
          case Lazy::kMarkerNumKeys:
            return Value::number(
                static_cast<double>(markers(static_cast<MarkerScope>(o.lazy_arg)).sorted.size()));
          case Lazy::kSourceText:
            if (o.memo == nullptr) o.memo = source_text_of(o.bound, ctx_.time).o;
            return Value::object(o.memo);
        }
      }
      break;
    }
    case ObjKind::kMath: {
      const Value m = read_math(*this, kid);
      if (!m.is_undefined()) return m;
      break;
    }
    case ObjKind::kStringObject:
      return read_string_object(o, key, kid);
    case ObjKind::kStyle: {
      const Value s = read_style(o, kid);
      if (!s.is_undefined()) return s;
      break;
    }
    case ObjKind::kFunction:
      if (kid == KeyId::k_name) return str(Str(function_name(o, ctx_)));
      if (kid == KeyId::k_length) return Value::number(function_length(o, ctx_));
      break;
  }
  return read_proto(*this, obj, kid).value_or(Value{});
}

// ── Scope ───────────────────────────────────────────────────────────────────

Value Interp::global(const Node& n) {
  switch (n.global) {
    case Global::kNone:
    case Global::kCount_:
      throw_eval(prog_.strings[n.str] + u" is not defined");
    case Global::kTime:
      return Value::number(ctx_.time);
    case Global::kValue:
      return property_value();
    case Global::kAudio:
      return Value::number(ctx_.audio.value_or(0));
    case Global::kCtrl:
      return fn_value(Fn::kCtrl);
    case Global::kWiggle:
      return fn_value(Fn::kWiggle);
    case Global::kClamp:
      return fn_value(Fn::kClamp);
    case Global::kLinear:
      return fn_value(Fn::kLinear);
    case Global::kEase:
      return fn_value(Fn::kEase);
    case Global::kEaseIn:
      return fn_value(Fn::kEaseIn);
    case Global::kEaseOut:
      return fn_value(Fn::kEaseOut);
    case Global::kTimeToFrames:
      return fn_value(Fn::kTimeToFrames);
    case Global::kFramesToTime:
      return fn_value(Fn::kFramesToTime);
    case Global::kRandom:
      return fn_value(Fn::kRandom);
    case Global::kMath:
      if (math_.is_undefined()) math_ = Value::object(arena_.obj(ObjKind::kMath));
      return math_;
    case Global::kValueAtTime:
      return fn_value(ctx_.text_value != nullptr ? Fn::kValueAtTimeText : Fn::kValueAtTime);
    case Global::kVelocity:
      return Value::number(velocity_at(Value::number(ctx_.time)));
    case Global::kSpeed:
      return Value::number(std::fabs(velocity_at(Value::number(ctx_.time))));
    case Global::kVelocityAtTime:
      return fn_value(Fn::kVelocityAtTime);
    case Global::kLayer:
      return fn_value(Fn::kLayer);
    case Global::kLayerAt:
      return fn_value(Fn::kLayerAt);
    case Global::kLoopOut:
      return fn_value(Fn::kLoopOut);
    case Global::kLoopIn:
      return fn_value(Fn::kLoopIn);
    case Global::kThisComp:
      return this_comp();
    case Global::kThisLayer:
      return this_layer();
    case Global::kThisProperty:
      return this_property();
    case Global::kSourceRectAtTime:
      return fn_value(Fn::kSourceRectAtTime);
    case Global::kToComp:
      return own_space_fn(Fn::kToComp);
    case Global::kToWorld:
      return own_space_fn(Fn::kToWorld);
    case Global::kFromComp:
      return own_space_fn(Fn::kFromComp);
    case Global::kFromWorld:
      return own_space_fn(Fn::kFromWorld);
    case Global::kSeedRandom:
      return fn_value(Fn::kSeedRandom);
    case Global::kGaussRandom:
      return fn_value(Fn::kGaussRandom);
    case Global::kNoise:
      return fn_value(Fn::kNoise);
    case Global::kNumKeys:
      return Value::number(static_cast<double>(ctx_.key_times.size()));
    case Global::kKey:
      return fn_value(Fn::kKey);
    case Global::kNearestKey:
      return fn_value(Fn::kNearestKey);
    case Global::kMarker:
      return marker_scope(MarkerScope::kLayer);
    case Global::kPosterizeTime:
      return fn_value(Fn::kPosterizeTime);
    case Global::kAdd:
      return fn_value(Fn::kAdd);
    case Global::kSub:
      return fn_value(Fn::kSub);
    case Global::kMul:
      return fn_value(Fn::kMul);
    case Global::kDiv:
      return fn_value(Fn::kDiv);
    case Global::kDot:
      return fn_value(Fn::kDot);
    case Global::kCross:
      return fn_value(Fn::kCross);
    case Global::kLength:
      return fn_value(Fn::kLength);
    case Global::kNormalize:
      return fn_value(Fn::kNormalize);
    case Global::kText:
      if (own_text_.is_undefined()) own_text_ = text_group(Value::null());
      return own_text_;
    case Global::kPlugin:
      // No plugin expression functions in the native engine (plan §10: the
      // JavaScript plugin system is not ported), which is exactly the
      // TypeScript's default: a frozen empty object.
      if (plugin_.is_undefined()) plugin_ = plain({});
      return plugin_;
  }
  return {};
}

Value Interp::property_value() {
  if (!property_value_built_) {
    property_value_built_ = true;
    property_value_ = ctx_.text_value != nullptr ? make_source_text_value(*ctx_.text_value, false)
                                                 : Value::number(ctx_.value);
  }
  return property_value_;
}

Value Interp::own_space_fn(Fn fn) {
  const auto i = static_cast<std::size_t>(fn) - static_cast<std::size_t>(Fn::kToComp);
  if (own_space_[i].is_undefined()) own_space_[i] = bound_fn(fn, Value::null());
  return own_space_[i];
}

Value Interp::this_comp() {
  if (this_comp_.is_undefined()) {
    const CompInfo& c = comp_;
    this_comp_ = plain({
        {.key = KeyId::k_width, .value = Value::number(c.width)},
        {.key = KeyId::k_height, .value = Value::number(c.height)},
        {.key = KeyId::k_duration, .value = Value::number(c.duration)},
        {.key = KeyId::k_frameDuration, .value = Value::number(1 / js_max2(1, c.fps))},
        {.key = KeyId::k_fps, .value = Value::number(c.fps)},
        {.key = KeyId::k_numLayers, .value = Value::number(c.num_layers)},
        {.key = KeyId::k_layer, .value = bound_fn(Fn::kCompLayer, Value{})},
        {.key = KeyId::k_marker, .value = marker_scope(MarkerScope::kComp)},
    });
  }
  return this_comp_;
}

Value Interp::this_layer() {
  if (this_layer_.is_undefined()) {
    const LayerInfo* li = ctx_.layer_info ? &*ctx_.layer_info : nullptr;
    if (own_text_.is_undefined()) own_text_ = text_group(Value::null());
    this_layer_ = plain({
        {.key = KeyId::k_name, .value = str(li != nullptr ? li->name : Str(u"Layer"))},
        {.key = KeyId::k_width, .value = Value::number(li != nullptr ? li->width : comp_.width)},
        {.key = KeyId::k_height, .value = Value::number(li != nullptr ? li->height : comp_.height)},
        {.key = KeyId::k_toComp, .value = own_space_fn(Fn::kToComp)},
        {.key = KeyId::k_toWorld, .value = own_space_fn(Fn::kToWorld)},
        {.key = KeyId::k_fromComp, .value = own_space_fn(Fn::kFromComp)},
        {.key = KeyId::k_fromWorld, .value = own_space_fn(Fn::kFromWorld)},
        {.key = KeyId::k_marker, .value = marker_scope(MarkerScope::kLayer)},
        {.key = KeyId::k_text, .value = own_text_},
    });
  }
  return this_layer_;
}

Value Interp::this_property() {
  if (this_property_.is_undefined()) {
    const double v = velocity_at(Value::number(ctx_.time));
    this_property_ = plain({
        {.key = KeyId::k_value, .value = property_value()},
        {.key = KeyId::k_valueAtTime,
         .value = fn_value(ctx_.text_value != nullptr ? Fn::kValueAtTimeText : Fn::kValueAtTime)},
        {.key = KeyId::k_velocity, .value = Value::number(v)},
        {.key = KeyId::k_speed, .value = Value::number(std::fabs(v))},
        {.key = KeyId::k_velocityAtTime, .value = fn_value(Fn::kVelocityAtTime)},
        {.key = KeyId::k_loopOut, .value = fn_value(Fn::kLoopOut)},
        {.key = KeyId::k_loopIn, .value = fn_value(Fn::kLoopIn)},
    });
  }
  return this_property_;
}

Value Interp::marker_scope(MarkerScope scope) {
  Value& slot = marker_scope_[static_cast<std::size_t>(scope)];
  if (slot.is_undefined()) {
    const auto aux = static_cast<std::uint8_t>(scope);
    slot = plain({
        {.key = KeyId::k_numKeys, .value = {}, .lazy = Lazy::kMarkerNumKeys},
        {.key = KeyId::k_key, .value = bound_fn(Fn::kMarkerKey, Value{}, aux)},
        {.key = KeyId::k_nearestKey, .value = bound_fn(Fn::kMarkerNearestKey, Value{}, aux)},
    });
    slot.o->lazy_arg = static_cast<int>(scope);
  }
  return slot;
}

Value Interp::text_group(const Value& name) {
  Value g = plain({{.key = KeyId::k_sourceText, .value = {}, .lazy = Lazy::kSourceText}});
  g.o->bound = name;
  return g;
}

Value Interp::comp_layer(const Value& name, const Value& prop) {
  // Without a prop this is a LAYER OBJECT whose coordinate-space functions are
  // bound to THAT layer.
  if (truthy(prop)) return layer_at(name, prop, Value::number(ctx_.time));
  return plain({
      {.key = KeyId::k_width, .value = Value::number(comp_.width)},
      {.key = KeyId::k_height, .value = Value::number(comp_.height)},
      {.key = KeyId::k_name, .value = name},
      {.key = KeyId::k_toComp, .value = bound_fn(Fn::kToComp, name)},
      {.key = KeyId::k_toWorld, .value = bound_fn(Fn::kToWorld, name)},
      {.key = KeyId::k_fromComp, .value = bound_fn(Fn::kFromComp, name)},
      {.key = KeyId::k_fromWorld, .value = bound_fn(Fn::kFromWorld, name)},
      {.key = KeyId::k_text, .value = text_group(name)},
  });
}

// ── Markers ─────────────────────────────────────────────────────────────────

Interp::MarkerList& Interp::markers(MarkerScope scope) {
  MarkerList& m = markers_[static_cast<std::size_t>(scope)];
  if (m.built) return m;
  m.built = true;
  std::vector<MarkerData> data;
  if (ctx_.host != nullptr && ctx_.host->has_markers_at()) data = ctx_.host->markers_at(scope);
  // `.sort((a, b) => a.time - b.time)` — V8's sort is stable (TimSort); so is
  // this. (With NaN times the comparator is not an ordering in either
  // language and the orders may differ — documented.)
  std::ranges::stable_sort(data, [](const MarkerData& a, const MarkerData& b) { return a.time - b.time < 0; });
  m.sorted.reserve(data.size());
  for (std::size_t i = 0; i < data.size(); ++i) {
    const MarkerData& d = data[i];
    m.sorted.push_back(plain({
        {.key = KeyId::k_time, .value = Value::number(d.time)},
        {.key = KeyId::k_duration, .value = Value::number(d.duration)},
        {.key = KeyId::k_name, .value = str(d.name)},
        {.key = KeyId::k_comment, .value = str(d.comment)},
        {.key = KeyId::k_index, .value = Value::number(static_cast<double>(i + 1))},
    }));
  }
  m.empty = plain({
      {.key = KeyId::k_time, .value = Value::number(0)},
      {.key = KeyId::k_duration, .value = Value::number(0)},
      {.key = KeyId::k_name, .value = str(u"")},
      {.key = KeyId::k_comment, .value = str(u"")},
      {.key = KeyId::k_index, .value = Value::number(0)},
  });
  return m;
}

namespace {
const Value& prop_of(const Value& obj, KeyId k) {
  for (const Prop& p : obj.o->props) {
    if (p.key == k) return p.value;
  }
  static const Value kUndef{};
  return kUndef;
}
}  // namespace

Value Interp::marker_key(MarkerScope scope, const Value& n) {
  MarkerList& m = markers(scope);
  if (n.tag == Tag::kString) {
    const auto field_is = [&](const Value& mk, KeyId k) {
      const Value& f = prop_of(mk, k);
      return f.is_string() && *f.s == *n.s;
    };
    for (const Value& mk : m.sorted) {
      if (field_is(mk, KeyId::k_comment)) return mk;
    }
    for (const Value& mk : m.sorted) {
      if (field_is(mk, KeyId::k_name)) return mk;
    }
    return m.empty;
  }
  if (m.sorted.empty()) return m.empty;
  const double i = js_max2(1, js_min2(static_cast<double>(m.sorted.size()), motion::js::round(to_number(n))));
  if (std::isnan(i)) return {};  // sorted[NaN] is undefined
  return m.sorted[static_cast<std::size_t>(i) - 1];
}

Value Interp::marker_nearest(MarkerScope scope, Args a) {
  MarkerList& m = markers(scope);
  if (m.sorted.empty()) return m.empty;
  const double t = a[0].is_undefined() ? ctx_.time : to_number(a[0]);
  std::size_t best = 0;
  for (std::size_t i = 1; i < m.sorted.size(); ++i) {
    if (std::fabs(prop_of(m.sorted[i], KeyId::k_time).n - t) < std::fabs(prop_of(m.sorted[best], KeyId::k_time).n - t)) {
      best = i;
    }
  }
  return m.sorted[best];
}

// ── The API ─────────────────────────────────────────────────────────────────

double Interp::self_at(const Value& t) {
  if (ctx_.host != nullptr && ctx_.host->has_self_at()) return ctx_.host->self_at(to_number(t));
  return ctx_.value;
}

double Interp::velocity_at(const Value& t) {
  constexpr double dt = 0.001;
  const double v1 = self_at(Value::number(to_number(t) - dt));
  const double v2 = self_at(js_add(t, Value::number(dt), arena_));
  return (v2 - v1) / (2 * dt);
}

double Interp::next_random() {
  random_counter_ += 1;
  return hash01(to_number(random_seed_) * 1013.7 + random_counter_ * 71.3);
}

Value Interp::wiggle(Args a) {
  const Value freq = a[0].is_undefined() ? Value::number(2) : a[0];
  const Value amp = a[1].is_undefined() ? Value::number(30) : a[1];
  const Value octaves = a[2].is_undefined() ? Value::number(1) : a[2];
  const Value amp_mult = a[3].is_undefined() ? Value::number(0.5) : a[3];
  const Value tt = a[4].is_undefined() ? Value::number(ctx_.time) : a[4];
  const double seed = ctx_.prop_seed.value_or(0);
  double total = 0;
  Value f = freq;
  Value am = amp;
  Value max_a = Value::number(0);
  // CLAMPED AT BOTH ENDS: the count comes straight from expression source.
  double floored = std::floor(to_number(octaves));
  if (floored == 0 || std::isnan(floored)) floored = 1;  // `|| 1`
  const double n = js_min2(kMaxWiggleOctaves, js_max2(1, floored));
  const auto octave_count = static_cast<int>(n);  // 1..8, integral
  for (int i = 0; i < octave_count; i++) {
    total += (smooth_noise(to_number(tt) * to_number(f) + seed) * 2 - 1) * to_number(am);
    max_a = js_add(max_a, am, arena_);
    f = Value::number(to_number(f) * 2);
    am = Value::number(to_number(am) * to_number(amp_mult));
  }
  const bool positive = less_than(Value::number(0), max_a).value_or(false);  // maxA > 0
  const double wig = positive ? (total / to_number(max_a)) * to_number(amp) : 0;
  return Value::number(ctx_.value + wig);
}

Value Interp::range_fn(Fn fn, Args a) {
  Value t_min = Value::number(0);
  Value t_max = Value::number(1);
  Value v_min = a[1];
  Value v_max = a[2];
  if (!a[3].is_undefined() && !a[4].is_undefined()) {
    t_min = a[1];
    t_max = a[2];
    v_min = a[3];
    v_max = a[4];
  }
  double k = 0;
  if (!strict_equals(t_max, t_min)) {
    k = js_min2(1, js_max2(0, (to_number(a[0]) - to_number(t_min)) / (to_number(t_max) - to_number(t_min))));
  }
  double u = k;
  switch (fn) {
    case Fn::kEase:
      u = k * k * (3 - 2 * k);  // smoothstep
      break;
    case Fn::kEaseIn:
      u = k * k;  // quadratic ease in
      break;
    case Fn::kEaseOut:
      u = k * (2 - k);  // quadratic ease out
      break;
    default:
      break;
  }
  return js_add(v_min, Value::number((to_number(v_max) - to_number(v_min)) * u), arena_);
}

namespace {

std::array<double, 2> as_point2(const Value& p, const Str& fn) {
  if (p.tag == Tag::kObject && p.o->kind == ObjKind::kArray && p.o->elems.size() >= 2) {
    const Value& x = p.o->elems[0];
    const Value& y = p.o->elems[1];
    if (x.is_number() && y.is_number() && is_finite(x.n) && is_finite(y.n)) return {x.n, y.n};
  }
  throw_eval(fn + u"() needs a point, e.g. " + fn + u"([0, 0]).");
}

const Str& space_name(Fn fn) {
  static const std::array<Str, 4> kNames = {u"toComp", u"toWorld", u"fromComp", u"fromWorld"};
  return kNames[static_cast<std::size_t>(fn) - static_cast<std::size_t>(Fn::kToComp)];
}

}  // namespace

Value Interp::space_fn(const Obj& f, Args a) {
  const Str& fn = space_name(f.fn);
  const double t = a[1].is_undefined() ? ctx_.time : to_number(a[1]);
  const bool self = f.bound.is_null();
  Str name_storage;
  const Str* name = nullptr;
  if (!self) {
    name_storage = to_string(f.bound);
    name = &name_storage;
  }
  // spaceOf first (a missing layer outranks a bad point), then the point.
  Host* host = ctx_.host;
  if (host == nullptr || !host->has_space_at() || !host->space_exists(name, t)) {
    throw_eval(self ? fn + u"() cannot see this layer’s transform here."
                    : fn + u"(): no layer named " + lq() + name_storage + rq() + u".");
  }
  const std::array<double, 2> p2 = as_point2(a[0], fn);
  std::array<double, 3> p{p2[0], p2[1], 0};
  SpaceOp op = SpaceOp::kToComp;
  std::size_t out_n = 2;
  switch (f.fn) {
    case Fn::kToComp:
      op = SpaceOp::kToComp;
      break;
    case Fn::kFromComp:
      op = SpaceOp::kFromComp;
      break;
    case Fn::kToWorld:
      op = SpaceOp::kToWorld;
      out_n = 3;
      break;
    default: {
      op = SpaceOp::kFromWorld;
      // A world point: `[x, y]` is accepted with z = 0, as AE does.
      const Value& pv = a[0];  // as_point2 above proved it is an array
      if (is_array(pv) && pv.o->elems.size() >= 3 && pv.o->elems[2].is_number() && is_finite(pv.o->elems[2].n)) {
        p[2] = pv.o->elems[2].n;
      }
      break;
    }
  }
  const std::array<double, 3> r = host->space_convert(name, t, op, p);
  std::vector<Value> out;
  out.reserve(out_n);
  for (std::size_t i = 0; i < out_n; ++i) out.push_back(Value::number(r[i]));
  return array(std::move(out));
}

Value Interp::key_fn(const Value& n) {
  const std::span<const double> kt = ctx_.key_times;
  const auto num_keys = static_cast<double>(kt.size());
  const double i = js_max2(1, js_min2(num_keys, motion::js::round(to_number(n))));
  double t = 0;  // keyTimes[i - 1] ?? 0
  if (!std::isnan(i) && i - 1 < num_keys) t = kt[static_cast<std::size_t>(i - 1)];
  return plain({
      {.key = KeyId::k_index, .value = Value::number(i)},
      {.key = KeyId::k_time, .value = Value::number(t)},
      {.key = KeyId::k_value, .value = Value::number(self_at(Value::number(t)))},
  });
}

Value Interp::nearest_key(Args a) {
  const std::span<const double> kt = ctx_.key_times;
  if (kt.empty()) {
    return plain({
        {.key = KeyId::k_index, .value = Value::number(0)},
        {.key = KeyId::k_time, .value = Value::number(0)},
        {.key = KeyId::k_value, .value = Value::number(ctx_.value)},
    });
  }
  const double t = a[0].is_undefined() ? ctx_.time : to_number(a[0]);
  std::size_t best = 0;
  for (std::size_t i = 1; i < kt.size(); ++i) {
    if (std::fabs(kt[i] - t) < std::fabs(kt[best] - t)) best = i;
  }
  return key_fn(Value::number(static_cast<double>(best + 1)));
}

Value Interp::loop(bool out, const Value& mode_arg) {
  const double time = ctx_.time;
  const std::optional<KeySpan>& span = ctx_.self_span;
  if (!span || span->end <= span->start || (out ? time <= span->end : time >= span->start)) {
    return Value::number(ctx_.value);
  }
  const double start = span->start;
  const double end = span->end;
  const double dur = end - start;
  const double rel = time - start;
  const auto is_mode = [&](std::u16string_view m) {
    if (mode_arg.is_undefined()) return m == u"cycle";
    return mode_arg.tag == Tag::kString && *mode_arg.s == m;
  };
  const auto at = [&](double t) { return self_at(Value::number(t)); };
  if (is_mode(u"pingpong")) {
    double ph = out ? motion::js::mod(rel, 2 * dur) : motion::js::mod(motion::js::mod(rel, 2 * dur) + 2 * dur, 2 * dur);
    if (ph > dur) ph = 2 * dur - ph;
    return Value::number(at(start + ph));
  }
  if (is_mode(u"offset")) {
    const double n = std::floor(rel / dur);
    const double delta = at(end) - at(start);
    return Value::number(at(start + (rel - n * dur)) + n * delta);
  }
  if (is_mode(u"continue")) {
    // Keep the last (first) segment's speed, sampled just inside the span.
    if (out) {
      const double tip = end - js_min2(0.001, dur / 2);
      return Value::number(at(end) + velocity_at(Value::number(tip)) * (time - end));
    }
    const double tip = start + js_min2(0.001, dur / 2);
    return Value::number(at(start) + velocity_at(Value::number(tip)) * (time - start));
  }
  if (out) return Value::number(at(start + motion::js::mod(rel, dur)));
  return Value::number(at(start + motion::js::mod(motion::js::mod(rel, dur) + dur, dur)));
}

Value Interp::layer_at(const Value& name, const Value& prop, const Value& t) {
  Host* host = ctx_.host;
  if (host == nullptr || !host->has_layer_at()) return Value::number(0);
  // What the TypeScript ENGINE's provider does with the name
  // (AnimationEngine.crossLayerValue → resolveLayerRef(name)): a primitive
  // string resolves; a String object only via the `#id` form; anything else
  // fails inside `name.startsWith(...)`.
  Str name_s;
  if (name.tag == Tag::kString) {
    name_s = *name.s;
  } else if (name.tag == Tag::kObject && name.o->kind == ObjKind::kStringObject) {
    const Str& s = *name.o->str;
    if (s.size() < 2 || s[0] != u'#') return Value::number(0);
    name_s = s;
  } else if (name.is_nullish()) {
    throw_eval(Str(u"Cannot read properties of ") + (name.is_null() ? u"null" : u"undefined") +
               u" (reading 'startsWith')");
  } else {
    throw_eval(u"ref.startsWith is not a function");
  }
  if (prop.tag != Tag::kString) return Value::number(0);  // Map lookup by a non-string misses
  // A HostError (cycle / depth) propagates as-is: evaluate_raw reports it,
  // exactly like the TypeScript's rethrown Error.
  const std::optional<double> r = host->layer_at(name_s, *prop.s, to_number(t));
  return Value::number(r.value_or(0));
}

Value Interp::source_rect(Args a) {
  const double t = a[0].is_undefined() ? ctx_.time : to_number(a[0]);
  const bool extents = a[1].is_undefined() ? false : truthy(a[1]);
  std::optional<SourceRect> r;
  if (ctx_.host != nullptr && ctx_.host->has_source_rect_at()) r = ctx_.host->source_rect_at(t, extents);
  if (!r) {
    r = SourceRect{.top = 0,
                   .left = 0,
                   .width = ctx_.layer_info ? ctx_.layer_info->width : comp_.width,
                   .height = ctx_.layer_info ? ctx_.layer_info->height : comp_.height};
  }
  return plain({
      {.key = KeyId::k_top, .value = Value::number(r->top)},
      {.key = KeyId::k_left, .value = Value::number(r->left)},
      {.key = KeyId::k_width, .value = Value::number(r->width)},
      {.key = KeyId::k_height, .value = Value::number(r->height)},
  });
}

namespace {

/// `vec(v)`: AE treats a 1-element vector and a scalar interchangeably.
std::vector<Value> vec_of(const Value& v) {
  if (is_array(v)) return v.o->elems;
  return {v};
}

/// `at(v, i) = v[i] ?? v[v.length - 1] ?? 0`
Value at_or_last(const std::vector<Value>& v, std::size_t i) {
  if (i < v.size() && !v[i].is_nullish()) return v[i];
  if (!v.empty() && !v.back().is_nullish()) return v.back();
  return Value::number(0);
}

double hypot_of(const std::vector<Value>& v) {
  std::vector<double> d;
  d.reserve(v.size());
  for (const Value& x : v) d.push_back(to_number(x));
  return motion::js::hypot(d);
}

}  // namespace

Value Interp::zip(const Value& a, const Value& b, Op op) {
  const std::vector<Value> va = vec_of(a);
  const std::vector<Value> vb = vec_of(b);
  const std::size_t n = std::max(va.size(), vb.size());
  std::vector<Value> out;
  out.reserve(n);
  for (std::size_t i = 0; i < n; ++i) {
    const Value x = at_or_last(va, i);
    const Value y = at_or_last(vb, i);
    switch (op) {
      case Op::kAdd:
        out.push_back(js_add(x, y, arena_));
        break;
      case Op::kSub:
        out.push_back(Value::number(to_number(x) - to_number(y)));
        break;
      case Op::kMul:
        out.push_back(Value::number(to_number(x) * to_number(y)));
        break;
      default:  // div: ÷0 → 0 (strict `y === 0`)
        out.push_back(y.is_number() && y.n == 0 ? Value::number(0) : Value::number(to_number(x) / to_number(y)));
        break;
    }
  }
  return array(std::move(out));
}

Value Interp::call(const Value& fn, const Value& this_arg, Args args) {
  const Obj& f = *fn.o;
  if (f.fn >= Fn::kMathAbs) return call_std(*this, f, this_arg, args);
  if (f.fn >= Fn::kGetStyleAt) return call_style(f, args);
  return call_api(f, args);
}

Value Interp::call_api(const Obj& f, Args a) {
  switch (f.fn) {
    case Fn::kCtrl: {
      Host* const host = ctx_.host;
      if (host == nullptr || !host->has_ctrl()) return Value::number(0);
      // Controls are looked up by NAME; a non-string reads 0 (a Map lookup miss).
      const Value name = a[0];
      if (!name.is_string() || name.s == nullptr) return Value::number(0);
      return Value::number(host->ctrl(*name.s));
    }
    case Fn::kWiggle:
      return wiggle(a);
    case Fn::kClamp: {
      // Math.min(max, Math.max(min, v))
      const double lo = to_number(a[1]);
      const double v = to_number(a[0]);
      const double inner = js_max2(lo, v);
      return Value::number(js_min2(to_number(a[2]), inner));
    }
    case Fn::kLinear:
    case Fn::kEase:
    case Fn::kEaseIn:
    case Fn::kEaseOut:
      return range_fn(f.fn, a);
    case Fn::kTimeToFrames: {
      const double t = a[0].is_undefined() ? ctx_.time : to_number(a[0]);
      const double fps = a[1].is_undefined() ? comp_.fps : to_number(a[1]);
      return Value::number(motion::js::round(t * fps));
    }
    case Fn::kFramesToTime: {
      const double fps = a[1].is_undefined() ? comp_.fps : to_number(a[1]);
      return Value::number(to_number(a[0]) / fps);
    }
    case Fn::kRandom: {
      const double u = next_random();
      if (a[0].is_undefined()) return Value::number(u);
      if (a[1].is_undefined()) return Value::number(u * to_number(a[0]));
      return js_add(a[0], Value::number(u * (to_number(a[1]) - to_number(a[0]))), arena_);
    }
    case Fn::kValueAtTime:
      return Value::number(self_at(a[0]));
    case Fn::kValueAtTimeText:
      return source_text_of(Value::null(), to_number(a[0]));
    case Fn::kVelocityAtTime:
      return Value::number(velocity_at(a[0]));
    case Fn::kLayer:
      return layer_at(a[0], a[1], Value::number(ctx_.time));
    case Fn::kLayerAt:
      return layer_at(a[0], a[1], a[2]);
    case Fn::kLoopOut:
      return loop(true, a[0]);
    case Fn::kLoopIn:
      return loop(false, a[0]);
    case Fn::kSourceRectAtTime:
      return source_rect(a);
    case Fn::kToComp:
    case Fn::kToWorld:
    case Fn::kFromComp:
    case Fn::kFromWorld:
      return space_fn(f, a);
    case Fn::kSeedRandom:
      random_seed_ = a[0];
      random_counter_ = 0;
      return Value::number(0);  // AE returns undefined; 0 keeps the expression numeric.
    case Fn::kGaussRandom: {
      const double u1 = js_max2(1e-9, next_random());
      const double u2 = next_random();
      return Value::number(std::sqrt(-2 * motion::js::log(u1)) * motion::js::cos(2 * std::numbers::pi * u2));
    }
    case Fn::kNoise: {
      const double y = a[1].is_undefined() ? 0 : to_number(a[1]);
      return Value::number((smooth_noise(to_number(a[0]) * 1.7 + y * 31.4) - 0.5) * 2);
    }
    case Fn::kKey:
      return key_fn(a[0]);
    case Fn::kNearestKey:
      return nearest_key(a);
    case Fn::kPosterizeTime: {
      const Value t = a[1].is_undefined() ? Value::number(ctx_.time) : a[1];
      if (less_than(Value::number(0), a[0]).value_or(false)) {
        const double fps = to_number(a[0]);
        return Value::number(std::floor(to_number(t) * fps) / fps);
      }
      return t;
    }
    case Fn::kAdd:
      return zip(a[0], a[1], Op::kAdd);
    case Fn::kSub:
      return zip(a[0], a[1], Op::kSub);
    case Fn::kMul:
      return zip(a[0], a[1], Op::kMul);
    case Fn::kDiv:
      return zip(a[0], a[1], Op::kDiv);
    case Fn::kDot: {
      const Value prod = zip(a[0], a[1], Op::kMul);
      double s = 0;
      for (const Value& v : prod.o->elems) s = s + v.n;
      return Value::number(s);
    }
    case Fn::kCross: {
      const std::vector<Value> va = vec_of(a[0]);
      const std::vector<Value> vb = vec_of(a[1]);
      const auto get = [](const std::vector<Value>& v, std::size_t i) {
        return (i < v.size() && !v[i].is_undefined()) ? to_number(v[i]) : 0.0;
      };
      const double ax = get(va, 0);
      const double ay = get(va, 1);
      const double az = get(va, 2);
      const double bx = get(vb, 0);
      const double by = get(vb, 1);
      const double bz = get(vb, 2);
      return array({Value::number(ay * bz - az * by), Value::number(az * bx - ax * bz),
                    Value::number(ax * by - ay * bx)});
    }
    case Fn::kLength: {
      if (a[1].is_undefined()) return Value::number(hypot_of(vec_of(a[0])));
      return Value::number(hypot_of(zip(a[0], a[1], Op::kSub).o->elems));
    }
    case Fn::kNormalize: {
      const std::vector<Value> v = vec_of(a[0]);
      const double len = hypot_of(v);
      std::vector<Value> out;
      out.reserve(v.size());
      for (const Value& x : v) out.push_back(Value::number(len == 0 ? 0 : to_number(x) / len));
      return array(std::move(out));
    }
    case Fn::kCompLayer:
      return comp_layer(a[0], a[1]);
    case Fn::kMarkerKey:
      return marker_key(static_cast<MarkerScope>(f.aux), a[0]);
    case Fn::kMarkerNearestKey:
      return marker_nearest(static_cast<MarkerScope>(f.aux), a);
    default:
      break;
  }
  return {};
}

}  // namespace motion::expr::detail
