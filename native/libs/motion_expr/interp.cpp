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
#include <exception>
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

/// ECMAScript ToInt32 / ToUint32 (the bitwise operators).
std::uint32_t to_uint32(double d) noexcept {
  if (!std::isfinite(d)) return 0;
  double m = std::fmod(std::trunc(d), 4294967296.0);
  if (m < 0) m += 4294967296.0;
  return static_cast<std::uint32_t>(m);
}
std::int32_t to_int32(double d) noexcept { return static_cast<std::int32_t>(to_uint32(d)); }

}  // namespace

void throw_eval(Str message) { throw EvalError{std::move(message)}; }
void throw_fatal(Str message) { throw EvalError{std::move(message), true}; }

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
  // The program's own frame (top-level var/let/const), only when it has one.
  if (prog_.top_slots > 0) env_ = arena_.env(prog_.top_slots, nullptr);
  const Value out = eval(prog_.root);
  // A top-level `return x` ends the program with x (AE lets rigs do this).
  return flow_ == Flow::kReturn ? return_value_ : out;
}

Value Interp::eval(std::uint32_t id) {
  Budget& b = g_budget;
  b.steps += 1;
  if (b.steps > kMaxEvalSteps) throw_fatal(u"This expression is too expensive to evaluate.");
  if (b.node_depth >= kMaxEvalDepth) throw_fatal(u"This expression is nested too deeply.");
  b.node_depth += 1;
  struct Leave {
    Leave() = default;
    Leave(const Leave&) = delete;
    Leave(Leave&&) = delete;
    Leave& operator=(const Leave&) = delete;
    Leave& operator=(Leave&&) = delete;
    ~Leave() { g_budget.node_depth -= 1; }
  } const leave;
  stmt_empty_ = false;  // an expression always completes with a value
  // The innermost node that fails names the error's line and column. (Table-
  // based unwinding: nothing runs here unless something throws.)
  try {
    return eval_inner(id);
  } catch (const EvalError&) {
    note_pos(id);
    throw;
  } catch (const HostError&) {
    note_pos(id);
    throw;
  }
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

Value Interp::eval_inner(std::uint32_t id) {
  const Node& n = prog_.nodes[id];
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
      if (n.optional && object.is_nullish()) throw ShortCircuit{};
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
      if (n.op == Op::kTypeof) {
        // `typeof name` of a name nothing defines is "undefined", not an error.
        const Node& arg = prog_.nodes[n.a];
        if (arg.kind == NodeKind::kIdent && arg.global == Global::kNone) return str(u"undefined");
        return type_of(eval(n.a));
      }
      const Value v = eval(n.a);
      if (n.op == Op::kNot) return Value::boolean(!truthy(v));
      const double d = to_number(v);
      if (n.op == Op::kBitNot) return Value::number(static_cast<double>(~to_int32(d)));
      return Value::number(n.op == Op::kNeg ? -d : +d);
    }
    case NodeKind::kLogical: {
      // Short-circuit, like JS — the right side must not evaluate.
      const Value left = eval(n.a);
      if (n.op == Op::kAnd) return truthy(left) ? eval(n.b) : left;
      if (n.op == Op::kNullish) return left.is_nullish() ? eval(n.b) : left;
      return truthy(left) ? left : eval(n.b);
    }
    case NodeKind::kBinary: {
      const Value l = eval(n.a);
      const Value r = eval(n.b);
      return binary(n.op, l, r);
    }
    case NodeKind::kConditional:
      return truthy(eval(n.a)) ? eval(n.b) : eval(n.c);

    // ── statements, locals and functions ──
    case NodeKind::kLocal:
      return frame(n.depth).slots[n.slot];
    case NodeKind::kAssign: {
      const Ref target = ref_of(prog_.nodes[n.a]);
      Value v;
      if (n.op == Op::kNone) {
        v = eval(n.b);
      } else {
        const Value cur = ref_get(target);
        v = binary(n.op, cur, eval(n.b));
      }
      ref_set(target, v);
      return v;
    }
    case NodeKind::kUpdate: {
      const Ref target = ref_of(prog_.nodes[n.a]);
      const double old = to_number(ref_get(target));
      const double now = n.op == Op::kAdd ? old + 1 : old - 1;
      ref_set(target, Value::number(now));
      return Value::number(n.prefix ? now : old);
    }
    case NodeKind::kFunction:
      if (n.decl) {  // hoisted by its block; as a statement it completes empty
        stmt_empty_ = true;
        return {};
      }
      return closure(id);
    case NodeKind::kBlock:
      return exec_block(n);
    case NodeKind::kVarList: {
      for (std::uint32_t i = 0; i < n.count; ++i) {
        const Node& d = prog_.nodes[prog_.lists[n.list + i]];
        if (d.a != kNoNode) frame(0).slots[d.slot] = eval(d.a);
      }
      stmt_empty_ = true;
      return {};
    }
    case NodeKind::kVarDecl:  // only ever reached through kVarList
      stmt_empty_ = true;
      return {};
    case NodeKind::kIf: {
      const std::uint32_t branch = truthy(eval(n.a)) ? n.b : n.c;
      Value v;
      if (branch != kNoNode) {
        v = eval(branch);
        if (stmt_empty_) v = {};
      }
      stmt_empty_ = false;  // UpdateEmpty(…, undefined)
      return v;
    }
    case NodeKind::kWhile:
    case NodeKind::kFor:
      return exec_loop(n);
    case NodeKind::kReturn:
      return_value_ = n.a == kNoNode ? Value{} : eval(n.a);
      flow_ = Flow::kReturn;
      stmt_empty_ = true;
      return {};
    case NodeKind::kBreak:
      flow_ = Flow::kBreak;
      stmt_empty_ = true;
      return {};
    case NodeKind::kContinue:
      flow_ = Flow::kContinue;
      stmt_empty_ = true;
      return {};
    case NodeKind::kEmpty:
      stmt_empty_ = true;
      return {};
    // ── 2026-10-21 ──
    case NodeKind::kObject:
      return eval_object(n);
    case NodeKind::kTemplate:
      return eval_template(n);
    case NodeKind::kOptChain:
      try {
        return eval(n.a);
      } catch (const ShortCircuit&) {
        return {};
      }
    case NodeKind::kDoWhile:
      return exec_do_while(n);
    case NodeKind::kForOf:
      return exec_for_of(n);
    case NodeKind::kSwitch:
      return exec_switch(n);
    case NodeKind::kCase:  // only ever reached through kSwitch
      stmt_empty_ = true;
      return {};
    case NodeKind::kTry:
      return exec_try(n);
    case NodeKind::kThrow: {
      const Value v = eval(n.a);
      thrown_ = v;
      has_thrown_ = true;
      // The message an uncaught throw reports: an Error-like object's
      // `message`, else the value itself.
      Str msg;
      if (v.is_object() && v.o->kind == ObjKind::kPlain) {
        const Value m = read_member(v, str(u"message"), KeyId::k_message);
        msg = m.is_undefined() ? to_string(v) : to_string(m);
      } else {
        msg = to_string(v);
      }
      throw_eval(std::move(msg));
    }
  }
  return {};
}

// ── Statements, locals and functions ────────────────────────────────────────

Env& Interp::frame(std::uint16_t depth) {
  Env* e = env_;
  for (std::uint16_t i = 0; i < depth && e != nullptr; ++i) e = e->parent;
  if (e == nullptr) throw_eval(u"Internal: a local variable has no frame.");
  return *e;
}

Interp::Ref Interp::ref_of(const Node& target) {
  Ref r;
  if (target.kind == NodeKind::kLocal) {
    r.local = true;
    r.env = &frame(target.depth);
    r.slot = target.slot;
    r.is_const = target.boolean;
    return r;
  }
  if (target.kind != NodeKind::kMember) throw_eval(u"Invalid assignment target.");
  r.obj = eval(target.a);
  r.kid = target.key;
  if (target.computed) {
    r.key = eval(target.b);
    if (r.key.tag != Tag::kString && r.key.tag != Tag::kNumber) throw_eval(u"Property names must be a string or number.");
    r.kid = kid_of(r.key);
  } else {
    r.key = Value::string(&prog_.strings[target.str]);
  }
  return r;
}

Value Interp::ref_get(const Ref& r) {
  if (r.local) return r.env->slots[r.slot];
  return read_member(r.obj, r.key, r.kid);
}

void Interp::ref_set(const Ref& r, const Value& v) {
  if (r.local) {
    if (r.is_const) throw_eval(u"Assignment to constant variable.");
    r.env->slots[r.slot] = v;
    return;
  }
  if (r.obj.is_nullish()) {
    throw_eval(u"Cannot set " + lq() + to_string(r.key) + rq() + u" of " + (r.obj.is_null() ? u"null" : u"undefined") +
               u".");
  }
  if (r.obj.tag != Tag::kObject) return;  // a primitive's property: silently dropped, as in sloppy JS
  Obj& o = *r.obj.o;
  if (o.kind == ObjKind::kArray) {
    const std::optional<std::size_t> idx = array_index_of(r.key);
    if (!idx) {
      if (r.kid == KeyId::k_length) {
        const double len = to_number(v);
        if (!(len >= 0) || len > static_cast<double>(kMaxArrayLength) || std::trunc(len) != len) {
          throw_eval(u"Invalid array length.");
        }
        o.elems.resize(static_cast<std::size_t>(len));
      }
      return;
    }
    if (*idx >= kMaxArrayLength) throw_fatal(u"This expression is too expensive to evaluate.");
    if (*idx >= o.elems.size()) o.elems.resize(*idx + 1);
    o.elems[*idx] = v;
    return;
  }
  if (o.kind == ObjKind::kPlain) {
    if (r.kid == KeyId::kUnknown) {
      // A key of the expression's own (`o.foo = 1`).
      const Str name = to_string(r.key);
      for (Prop& p : o.props) {
        if (p.key == KeyId::kUnknown && p.name != nullptr && *p.name == name) {
          p.value = v;
          return;
        }
      }
      o.props.push_back({.key = KeyId::kUnknown, .value = v, .lazy = Lazy::kNone, .name = arena_.str(name)});
      return;
    }
    for (Prop& p : o.props) {
      if (p.key != r.kid) continue;
      p.value = v;
      p.lazy = Lazy::kNone;
      return;
    }
    o.props.push_back({.key = r.kid, .value = v, .lazy = Lazy::kNone});
    return;
  }
  throw_eval(u"Cannot set " + lq() + to_string(r.key) + rq() + u" on that value.");
}

Value Interp::exec_block(const Node& n) {
  // Function declarations hoist: every one in the block is bound before any
  // statement runs, so a helper may be used above its definition.
  for (std::uint32_t i = 0; i < n.count; ++i) {
    const std::uint32_t sid = prog_.lists[n.list + i];
    const Node& s = prog_.nodes[sid];
    if (s.kind == NodeKind::kFunction && s.decl) frame(0).slots[s.slot] = closure(sid);
  }
  Value last;
  bool any = false;
  for (std::uint32_t i = 0; i < n.count; ++i) {
    const std::uint32_t sid = prog_.lists[n.list + i];
    const Node& s = prog_.nodes[sid];
    if (s.kind == NodeKind::kFunction && s.decl) continue;
    const Value v = eval(sid);
    if (!stmt_empty_) {
      last = v;
      any = true;
    }
    if (flow_ != Flow::kNormal) break;
  }
  stmt_empty_ = !any;
  return last;
}

Value Interp::exec_loop(const Node& n) {
  const bool is_for = n.kind == NodeKind::kFor;
  if (is_for && n.a != kNoNode) (void)eval(n.a);
  const std::uint32_t test = is_for ? n.b : n.a;
  const std::uint32_t body = is_for ? n.d : n.b;
  Value last;
  for (int iterations = 0;; ++iterations) {
    if (iterations >= kMaxLoopIterations) {
      throw_fatal(u"This loop ran more than 50000 times — expressions must finish in bounded time.");
    }
    if (test != kNoNode && !truthy(eval(test))) break;
    if (loop_body(body, last)) break;
    if (is_for && n.c != kNoNode) (void)eval(n.c);
  }
  stmt_empty_ = false;
  return last;
}

bool Interp::loop_body(std::uint32_t body, Value& last) {
  const Value v = eval(body);
  if (!stmt_empty_) last = v;
  if (flow_ == Flow::kBreak) {
    flow_ = Flow::kNormal;
    return true;
  }
  if (flow_ == Flow::kContinue) flow_ = Flow::kNormal;
  return flow_ == Flow::kReturn;
}

Value Interp::exec_do_while(const Node& n) {
  Value last;
  for (int iterations = 0;; ++iterations) {
    if (iterations >= kMaxLoopIterations) {
      throw_fatal(u"This loop ran more than 50000 times — expressions must finish in bounded time.");
    }
    if (loop_body(n.b, last)) break;
    if (!truthy(eval(n.a))) break;
  }
  stmt_empty_ = false;
  return last;
}

Value Interp::exec_for_of(const Node& n) {
  const bool of = n.boolean;
  const Value src = eval(n.b);
  // The values to visit, taken up front (the body may change the array).
  std::vector<Value> items;
  if (src.is_nullish()) {
    if (of) throw_eval(to_string(src) + u" is not iterable.");
  } else if (src.is_string()) {
    for (std::size_t i = 0; i < src.s->size(); ++i) {
      items.push_back(of ? str(Str(1, (*src.s)[i])) : str(number_to_str(static_cast<double>(i))));
    }
  } else if (is_array(src)) {
    if (of) {
      items = src.o->elems;
    } else {
      for (std::size_t i = 0; i < src.o->elems.size(); ++i) items.push_back(str(number_to_str(static_cast<double>(i))));
    }
  } else if (!of && src.is_object() && src.o->kind == ObjKind::kPlain) {
    for (const Prop& p : src.o->props) {
      items.push_back(p.name != nullptr ? Value::string(p.name) : str(Str(key_name(p.key))));
    }
  } else if (of) {
    throw_eval(u"That value is not iterable — for…of walks an array or a string.");
  }
  const Node& target = prog_.nodes[n.a];
  Value last;
  for (std::size_t i = 0; i < items.size(); ++i) {
    if (std::cmp_greater_equal(i, kMaxLoopIterations)) {
      throw_fatal(u"This loop ran more than 50000 times — expressions must finish in bounded time.");
    }
    if (target.kind == NodeKind::kVarDecl) {
      frame(0).slots[target.slot] = items[i];
    } else {
      ref_set(ref_of(target), items[i]);
    }
    if (loop_body(n.d, last)) break;
  }
  stmt_empty_ = false;
  return last;
}

Value Interp::exec_switch(const Node& n) {
  const Value d = unwrap_prop(eval(n.a));
  std::uint32_t start = kNoNode;
  std::uint32_t fallback = kNoNode;
  for (std::uint32_t i = 0; i < n.count; ++i) {
    const Node& c = prog_.nodes[prog_.lists[n.list + i]];
    if (c.a == kNoNode) {
      fallback = i;
      continue;
    }
    if (strict_equals(d, unwrap_prop(eval(c.a)))) {
      start = i;
      break;
    }
  }
  if (start == kNoNode) start = fallback;
  Value last;
  if (start != kNoNode) {
    for (std::uint32_t i = start; i < n.count && flow_ == Flow::kNormal; ++i) {
      const Node& c = prog_.nodes[prog_.lists[n.list + i]];
      for (std::uint32_t k = 0; k < c.count; ++k) {
        const Value v = eval(prog_.lists[c.list + k]);
        if (!stmt_empty_) last = v;
        if (flow_ != Flow::kNormal) break;
      }
    }
  }
  if (flow_ == Flow::kBreak) flow_ = Flow::kNormal;
  stmt_empty_ = false;
  return last;
}

Value Interp::exec_try(const Node& n) {
  std::exception_ptr pending;
  Value v;
  try {
    v = eval(n.a);
  } catch (const EvalError& e) {
    if (e.fatal || n.b == kNoNode) {
      pending = std::current_exception();
    } else {
      // Caught: the error no longer has a position, and `e` is an Error-like
      // object (or the value a `throw` threw).
      err_pos_ = kNoPos;
      flow_ = Flow::kNormal;
      const Value caught = has_thrown_ ? thrown_
                                       : plain({{.key = KeyId::k_message, .value = str(e.message)},
                                                {.key = KeyId::k_name, .value = str(u"Error")}});
      has_thrown_ = false;
      thrown_ = {};
      if (n.decl) frame(0).slots[n.slot] = caught;
      try {
        v = eval(n.b);
      } catch (const EvalError&) {
        pending = std::current_exception();
      } catch (const HostError&) {
        pending = std::current_exception();
      }
    }
  } catch (const HostError&) {
    pending = std::current_exception();  // a cycle is the engine's to report, never the rig's to catch
  }
  if (n.c != kNoNode) {
    const Flow f = flow_;
    const Value rv = return_value_;
    const bool empty = stmt_empty_;
    flow_ = Flow::kNormal;
    (void)eval(n.c);
    // A `return` / `break` in the finally block wins over everything before it.
    if (flow_ != Flow::kNormal) {
      stmt_empty_ = true;
      return {};
    }
    flow_ = f;
    return_value_ = rv;
    stmt_empty_ = empty;
  }
  if (pending) std::rethrow_exception(pending);
  return v;
}

Value Interp::eval_object(const Node& n) {
  Obj* o = arena_.obj(ObjKind::kPlain);
  o->props.reserve(n.count / 2);
  for (std::uint32_t i = 0; i + 1 < n.count; i += 2) {
    const Node& k = prog_.nodes[prog_.lists[n.list + i]];
    const Value v = eval(prog_.lists[n.list + i + 1]);
    const Str* name = k.key == KeyId::kUnknown ? &prog_.strings[k.str] : nullptr;
    bool found = false;
    for (Prop& p : o->props) {
      if (p.key == k.key && (name == nullptr || (p.name != nullptr && *p.name == *name))) {
        p.value = v;  // a repeated key: the last one wins
        found = true;
        break;
      }
    }
    if (!found) o->props.push_back({.key = k.key, .value = v, .lazy = Lazy::kNone, .name = name});
  }
  return Value::object(o);
}

Value Interp::eval_template(const Node& n) {
  Str out;
  for (std::uint32_t i = 0; i < n.count; ++i) {
    const std::uint32_t id = prog_.lists[n.list + i];
    const Node& part = prog_.nodes[id];
    if ((i % 2) == 0) {
      out += prog_.strings[part.str];
    } else {
      out += to_string(eval(id));
    }
  }
  return str(std::move(out));
}

Value Interp::closure(std::uint32_t id) {
  const Node& fn = prog_.nodes[id];
  Obj* o = arena_.obj(ObjKind::kFunction);
  o->fn = Fn::kNone;
  o->node = id;
  o->env = env_;
  o->str = &prog_.strings[fn.str];
  // `f.length`: the parameters before the first default.
  std::uint32_t length = fn.count;
  if (fn.has_defaults) {
    for (std::uint32_t i = 0; i < fn.count; ++i) {
      if (prog_.lists[fn.list + i] != kNoNode) {
        length = i;
        break;
      }
    }
  }
  o->aux = static_cast<std::uint8_t>(std::min<std::uint32_t>(length, 255));
  return Value::object(o);
}

Value Interp::call_user(const Obj& f, Args args) {
  const Node& fn = prog_.nodes[f.node];
  Env* e = arena_.env(fn.nslots, f.env);
  for (std::uint32_t i = 0; i < fn.count; ++i) e->slots[i] = args[i];
  // The caller's frame comes back however the call ends — a `try` in the
  // caller may catch what the callee threw.
  struct Restore {
    Env*& env;  // NOLINT(cppcoreguidelines-avoid-const-or-ref-data-members) — scoped RAII restore
    Env* saved;
    Restore(Env*& e, Env* s) : env(e), saved(s) {}
    Restore(const Restore&) = delete;
    Restore(Restore&&) = delete;
    Restore& operator=(const Restore&) = delete;
    Restore& operator=(Restore&&) = delete;
    ~Restore() { env = saved; }
  } const restore{env_, env_};
  env_ = e;
  // Default parameters, left to right (a default may read the ones before it).
  if (fn.has_defaults) {
    for (std::uint32_t i = 0; i < fn.count; ++i) {
      const std::uint32_t d = prog_.lists[fn.list + i];
      if (d != kNoNode && e->slots[i].is_undefined()) e->slots[i] = eval(d);
    }
  }
  Value out;
  if (fn.expr_body) {
    out = eval(fn.a);
  } else {
    (void)eval(fn.a);
    if (flow_ == Flow::kReturn) out = return_value_;
    flow_ = Flow::kNormal;
  }
  // The call is an expression: whatever its body's statements left behind,
  // the statement that contains the call completes with a value.
  stmt_empty_ = false;
  return out;
}

Value Interp::type_of(const Value& v) {
  switch (v.tag) {
    case Tag::kUndefined:
      return str(u"undefined");
    case Tag::kNull:
      return str(u"object");
    case Tag::kBool:
      return str(u"boolean");
    case Tag::kNumber:
      return str(u"number");
    case Tag::kString:
      return str(u"string");
    case Tag::kObject:
      break;
  }
  return str(v.o->kind == ObjKind::kFunction ? u"function" : u"object");
}

Value Interp::eval_call(const Node& n) {
  const Node& callee = prog_.nodes[n.a];
  Value this_arg;
  Value fn;
  if (callee.kind == NodeKind::kMember) {
    // Member calls need their receiver as `this`.
    this_arg = eval(callee.a);
    if (callee.optional && this_arg.is_nullish()) throw ShortCircuit{};
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
    if (n.optional && fn.is_nullish()) throw ShortCircuit{};
    if (!is_callable(fn)) throw_eval(to_string(key) + u" is not a function");
  } else {
    fn = eval(n.a);
    if (n.optional && fn.is_nullish()) throw ShortCircuit{};
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

std::optional<Value> Interp::vector_binary(Op op, const Value& l, const Value& r) {
  const bool la = is_array(l);
  const bool ra = is_array(r);
  if (!la && !ra) return std::nullopt;
  // The other operand must be an array or a number: `[1, 2] + ""` stays
  // JavaScript's "1,2" (the TypeScript parity rows).
  if (!la && !l.is_number()) return std::nullopt;
  if (!ra && !r.is_number()) return std::nullopt;
  const auto size_of = [](const Value& v, bool arr) { return arr && v.o != nullptr ? v.o->elems.size() : std::size_t{1}; };
  const std::size_t n = std::max(size_of(l, la), size_of(r, ra));
  const auto at = [](const Value& v, bool arr, std::size_t i) {
    if (!arr || v.o == nullptr) return to_number(v);
    const std::vector<Value>& e = v.o->elems;
    return i < e.size() ? to_number(e[i]) : 0.0;  // a shorter vector reads 0 past its end
  };
  std::vector<Value> out;
  out.reserve(n);
  for (std::size_t i = 0; i < n; ++i) {
    const double x = at(l, la, i);
    const double y = at(r, ra, i);
    double z = 0;
    switch (op) {
      case Op::kAdd: z = x + y; break;
      case Op::kSub: z = x - y; break;
      case Op::kMul: z = x * y; break;
      default: z = x / y; break;
    }
    out.push_back(Value::number(z));
  }
  return array(std::move(out));
}

Value Interp::binary(Op op, const Value& l, const Value& r) {
  // AE's vector arithmetic: `position + [10, 0]`, `scale * 2`, `[1, 2] - [1, 1]`.
  if (op == Op::kAdd || op == Op::kSub || op == Op::kMul || op == Op::kDiv) {
    if (const std::optional<Value> v = vector_binary(op, l, r)) return *v;
  }
  switch (op) {
    // `+` stays polymorphic so string concat works ('a' + 'b').
    case Op::kAdd:
      return js_add(l, r, arena_);
    case Op::kPow:
      return Value::number(motion::js::pow(to_number(l), to_number(r)));
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
    case Op::kBitAnd:
      return Value::number(static_cast<double>(to_int32(to_number(l)) & to_int32(to_number(r))));
    case Op::kBitOr:
      return Value::number(static_cast<double>(to_int32(to_number(l)) | to_int32(to_number(r))));
    case Op::kBitXor:
      return Value::number(static_cast<double>(to_int32(to_number(l)) ^ to_int32(to_number(r))));
    case Op::kShl: {
      const std::uint32_t shifted = to_uint32(to_number(l)) << (to_uint32(to_number(r)) & 31U);
      return Value::number(static_cast<double>(static_cast<std::int32_t>(shifted)));
    }
    case Op::kShr: {
      // An arithmetic shift of a negative int32 is defined (C++20).
      return Value::number(static_cast<double>(to_int32(to_number(l)) >> (to_uint32(to_number(r)) & 31U)));
    }
    case Op::kUShr:
      return Value::number(static_cast<double>(to_uint32(to_number(l)) >> (to_uint32(to_number(r)) & 31U)));
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
      // A vector property object (`thisComp.layer("A").position`): its members.
      if (o.pkind != PropKind::kNone) {
        if (std::optional<Value> m = prop_member(o, kid)) return *m;
      }
      break;
    }
    case ObjKind::kNumberObject: {
      if (std::optional<Value> m = prop_member(o, kid)) return *m;
      return read_proto(*this, Value::number(o.num), kid).value_or(Value{});
    }
    case ObjKind::kPlain: {
      if (kid == KeyId::kUnknown) {
        // An object literal's own key (`{ foo: 1 }.foo`).
        Str storage;
        const Str* name = key.tag == Tag::kString ? key.s : &(storage = to_string(key));
        for (const Prop& p : o.props) {
          if (p.key == KeyId::kUnknown && p.name != nullptr && *p.name == *name) return p.value;
        }
        break;
      }
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
          case Lazy::kLayerProp:
          case Lazy::kLayerVec:
          case Lazy::kLayerColor:
          case Lazy::kCameraOption:
          case Lazy::kLightOption:
            return read_layer_lazy(o, p);
          case Lazy::kLayerTransform:
            return transform_group(o.bound);
          case Lazy::kLayerFact:
            return layer_fact(o, p.key);
          case Lazy::kCompName: {
            std::optional<CompFacts> f;
            if (ctx_.host != nullptr) f = ctx_.host->comp_facts(nullptr);
            return str(f ? f->name : Str(u"Comp 1"));
          }
          case Lazy::kFootageSourceData: {
            // Parsed on first read, then kept for the rest of this evaluation.
            const Value v = footage_source_data(o);
            p.value = v;
            p.lazy = Lazy::kNone;
            return v;
          }
          case Lazy::kPathOf: {
            const Value v = path_of(o);
            p.value = v;
            p.lazy = Lazy::kNone;
            return v;
          }
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
      // An effect object (`effect("Name")`) is callable AND has members.
      for (const Prop& p : o.props) {
        if (p.key == kid) return p.value;
      }
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
    case Global::kLoopOutDuration:
      return fn_value(Fn::kLoopOutDuration);
    case Global::kLoopInDuration:
      return fn_value(Fn::kLoopInDuration);
    case Global::kFootage:
      return fn_value(Fn::kFootage);
    case Global::kCreatePath:
      return fn_value(Fn::kCreatePath);
    case Global::kMask:
      return bound_fn(Fn::kLayerMask, Value::null());
    case Global::kContent:
      return bound_fn(Fn::kLayerContent, Value::null());
    case Global::kSampleImage:
      return bound_fn(Fn::kSampleImage, Value::null());
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
    case Global::kLookAt:
      return fn_value(Fn::kLookAt);
    // AE: thisLayer's members by their bare names.
    case Global::kEffect:
    case Global::kTransform:
    case Global::kInPoint:
    case Global::kOutPoint:
    case Global::kIndex:
    case Global::kParent:
    case Global::kHasParent:
    case Global::kPosition:
    case Global::kAnchorPoint:
    case Global::kScale:
    case Global::kRotation:
    case Global::kOpacity:
    case Global::kStartTime: {
      const Str& name = prog_.strings[n.str];
      return read_member(this_layer(), Value::string(&name), key_of(name));
    }
    case Global::kDegreesToRadians:
      return fn_value(Fn::kDegreesToRadians);
    case Global::kRadiansToDegrees:
      return fn_value(Fn::kRadiansToDegrees);
    case Global::kHslToRgb:
      return fn_value(Fn::kHslToRgb);
    case Global::kRgbToHsl:
      return fn_value(Fn::kRgbToHsl);
    case Global::kSmooth:
      return fn_value(Fn::kSmooth);
    case Global::kTemporalWiggle:
      return fn_value(Fn::kTemporalWiggle);
    case Global::kComp:
      return fn_value(Fn::kComp);
    case Global::kTimeToTimecode:
      return fn_value(Fn::kTimeToTimecode);
    case Global::kTimeToCurrentFormat:
      return fn_value(Fn::kTimeToCurrentFormat);
  }
  return {};
}

Value Interp::property_value() {
  if (!property_value_built_) {
    property_value_built_ = true;
    property_value_ = ctx_.text_value != nullptr   ? make_source_text_value(*ctx_.text_value, false)
                      : ctx_.path_value != nullptr ? make_path(*ctx_.path_value, Value::null(), 0, Value{})
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
        {.key = KeyId::k_activeCamera, .value = {}, .lazy = Lazy::kLayerProp},
        {.key = KeyId::k_name, .value = {}, .lazy = Lazy::kCompName},
    });
  }
  return this_comp_;
}

Value Interp::this_layer() {
  if (this_layer_.is_undefined()) {
    const LayerInfo* li = ctx_.layer_info ? &*ctx_.layer_info : nullptr;
    if (own_text_.is_undefined()) own_text_ = text_group(Value::null());
    std::vector<Prop> props = {
        {.key = KeyId::k_name, .value = str(li != nullptr ? li->name : Str(u"Layer"))},
        {.key = KeyId::k_width, .value = Value::number(li != nullptr ? li->width : comp_.width)},
        {.key = KeyId::k_height, .value = Value::number(li != nullptr ? li->height : comp_.height)},
        {.key = KeyId::k_toComp, .value = own_space_fn(Fn::kToComp)},
        {.key = KeyId::k_toWorld, .value = own_space_fn(Fn::kToWorld)},
        {.key = KeyId::k_fromComp, .value = own_space_fn(Fn::kFromComp)},
        {.key = KeyId::k_fromWorld, .value = own_space_fn(Fn::kFromWorld)},
        {.key = KeyId::k_marker, .value = marker_scope(MarkerScope::kLayer)},
        {.key = KeyId::k_text, .value = own_text_},
    };
    add_layer_members(props, Value::null());
    this_layer_ = plain_bound(std::move(props), Value::null());
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
        {.key = KeyId::k_loopOutDuration, .value = fn_value(Fn::kLoopOutDuration)},
        {.key = KeyId::k_loopInDuration, .value = fn_value(Fn::kLoopInDuration)},
        {.key = KeyId::k_smooth, .value = fn_value(Fn::kSmooth)},
        {.key = KeyId::k_temporalWiggle, .value = fn_value(Fn::kTemporalWiggle)},
        {.key = KeyId::k_wiggle, .value = fn_value(Fn::kWiggle)},
        {.key = KeyId::k_numKeys, .value = Value::number(static_cast<double>(ctx_.key_times.size()))},
        {.key = KeyId::k_key, .value = fn_value(Fn::kKey)},
        {.key = KeyId::k_nearestKey, .value = fn_value(Fn::kNearestKey)},
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

Value Interp::comp_layer(const Value& name_arg, const Value& prop) {
  // `thisComp.layer(3)`: by 1-based stack index, through the host. A host
  // that cannot answer leaves the number to resolve as a name, as before.
  Value name = name_arg;
  if (name.is_number() && ctx_.host != nullptr) {
    if (std::optional<Str> ref = ctx_.host->layer_ref_by_index(name.n)) name = str(std::move(*ref));
  }
  // Without a prop this is a LAYER OBJECT whose coordinate-space functions are
  // bound to THAT layer.
  if (truthy(prop)) return layer_at(name, prop, Value::number(ctx_.time));
  std::vector<Prop> props = {
      {.key = KeyId::k_width, .value = Value::number(comp_.width)},
      {.key = KeyId::k_height, .value = Value::number(comp_.height)},
      // The layer's own name when the host knows it (a layer found by index
      // or as a parent), else the name it was asked by.
      {.key = KeyId::k_name, .value = {}, .lazy = Lazy::kLayerFact},
      {.key = KeyId::k_toComp, .value = bound_fn(Fn::kToComp, name)},
      {.key = KeyId::k_toWorld, .value = bound_fn(Fn::kToWorld, name)},
      {.key = KeyId::k_fromComp, .value = bound_fn(Fn::kFromComp, name)},
      {.key = KeyId::k_fromWorld, .value = bound_fn(Fn::kFromWorld, name)},
      {.key = KeyId::k_text, .value = text_group(name)},
  };
  add_layer_members(props, name);
  return plain_bound(std::move(props), name);
}

// ── Cameras and lights (camera program D6) ──────────────────────────────────

namespace {

/// The document property an option key reads (camera / light options and
/// their AE match names); nullptr when the key is not a scalar option.
const char16_t* option_prop(KeyId k) {
  switch (k) {
    case KeyId::k_zoom:
    case KeyId::k_adbe_camera_zoom:
      return u"focalLength";
    case KeyId::k_focusDistance:
    case KeyId::k_adbe_camera_focus_distance:
      return u"focusDistance";
    case KeyId::k_aperture:
    case KeyId::k_adbe_camera_aperture:
      return u"dofAperture";
    case KeyId::k_blurLevel:
    case KeyId::k_adbe_camera_blur_level:
    case KeyId::k_depthOfField:
      return u"dofStrength";
    case KeyId::k_irisRotation:
      return u"irisRotation";
    case KeyId::k_irisRoundness:
      return u"irisRoundness";
    case KeyId::k_irisAspectRatio:
      return u"irisAspect";
    case KeyId::k_irisDiffractionFringe:
      return u"diffractionFringe";
    case KeyId::k_highlightGain:
      return u"highlightGain";
    case KeyId::k_highlightThreshold:
      return u"highlightThreshold";
    case KeyId::k_highlightSaturation:
      return u"highlightSaturation";
    case KeyId::k_intensity:
    case KeyId::k_adbe_light_intensity:
      return u"intensity";
    case KeyId::k_coneAngle:
    case KeyId::k_adbe_light_cone_angle:
      return u"lightCone";
    case KeyId::k_coneFeather:
    case KeyId::k_adbe_light_cone_feather:
      return u"lightConeFeather";
    case KeyId::k_shadowDarkness:
    case KeyId::k_adbe_light_shadow_darkness:
      return u"shadowDarkness";
    case KeyId::k_shadowDiffusion:
    case KeyId::k_adbe_light_shadow_diffusion:
      return u"shadowDiffusion";
    case KeyId::k_falloffDistance:
      return u"falloffDistance";
    case KeyId::k_radius:
      return u"radius";
    // AE-style rigs: the transform scalars (Premation's document names).
    case KeyId::k_rotation:
    case KeyId::k_zRotation:
      return u"rotation";
    case KeyId::k_xRotation:
      return u"rotationX";
    case KeyId::k_yRotation:
      return u"rotationY";
    case KeyId::k_opacity:
      return u"opacity";
    default:
      return nullptr;
  }
}

constexpr std::array kCameraOptionKeys = {
    KeyId::k_zoom, KeyId::k_depthOfField, KeyId::k_focusDistance, KeyId::k_aperture, KeyId::k_blurLevel,
    KeyId::k_irisRotation, KeyId::k_irisRoundness, KeyId::k_irisAspectRatio, KeyId::k_irisDiffractionFringe,
    KeyId::k_highlightGain, KeyId::k_highlightThreshold, KeyId::k_highlightSaturation,
    KeyId::k_adbe_camera_zoom, KeyId::k_adbe_camera_focus_distance, KeyId::k_adbe_camera_aperture,
    KeyId::k_adbe_camera_blur_level};
constexpr std::array kLightOptionKeys = {
    KeyId::k_intensity, KeyId::k_coneAngle, KeyId::k_coneFeather, KeyId::k_shadowDarkness, KeyId::k_shadowDiffusion,
    KeyId::k_falloffDistance, KeyId::k_radius, KeyId::k_adbe_light_intensity, KeyId::k_adbe_light_cone_angle,
    KeyId::k_adbe_light_cone_feather, KeyId::k_adbe_light_shadow_darkness, KeyId::k_adbe_light_shadow_diffusion};

/// A point argument as three numbers (`[x, y]` reads z = 0); nullopt when it is not one.
std::optional<std::array<double, 3>> point3(const Value& p) {
  if (p.tag != Tag::kObject || p.o->kind != ObjKind::kArray || p.o->elems.size() < 2) return std::nullopt;
  std::array<double, 3> out{0, 0, 0};
  for (std::size_t i = 0; i < 3 && i < p.o->elems.size(); ++i) {
    const Value& v = p.o->elems[i];
    if (!v.is_number() || !is_finite(v.n)) return std::nullopt;
    out.at(i) = v.n;
  }
  return out;
}

}  // namespace

void Interp::add_layer_members(std::vector<Prop>& props, const Value& bound) {
  props.push_back({.key = KeyId::k_position, .value = {}, .lazy = Lazy::kLayerVec});
  props.push_back({.key = KeyId::k_pointOfInterest, .value = {}, .lazy = Lazy::kLayerVec});
  props.push_back({.key = KeyId::k_cameraOption, .value = {}, .lazy = Lazy::kCameraOption});
  props.push_back({.key = KeyId::k_lightOption, .value = {}, .lazy = Lazy::kLightOption});
  props.push_back({.key = KeyId::k_toCompVec, .value = bound_fn(Fn::kToCompVec, bound), .lazy = Lazy::kNone});
  props.push_back(
      {.key = KeyId::k_fromCompToSurface, .value = bound_fn(Fn::kFromCompToSurface, bound), .lazy = Lazy::kNone});
  // AE-style rigs: transform.<member> (and the members directly on the
  // layer, as AE allows), timing facts, parenting, effect("Name").
  props.push_back({.key = KeyId::k_transform, .value = {}, .lazy = Lazy::kLayerTransform});
  for (const KeyId k : {KeyId::k_anchorPoint, KeyId::k_scale, KeyId::k_orientation}) {
    props.push_back({.key = k, .value = {}, .lazy = Lazy::kLayerVec});
  }
  for (const KeyId k : {KeyId::k_rotation, KeyId::k_xRotation, KeyId::k_yRotation, KeyId::k_zRotation, KeyId::k_opacity}) {
    props.push_back({.key = k, .value = {}, .lazy = Lazy::kLayerProp});
  }
  for (const KeyId k : {KeyId::k_inPoint, KeyId::k_outPoint, KeyId::k_startTime, KeyId::k_index, KeyId::k_parent,
                        KeyId::k_hasParent, KeyId::k_enabled, KeyId::k_active}) {
    props.push_back({.key = k, .value = {}, .lazy = Lazy::kLayerFact});
  }
  props.push_back({.key = KeyId::k_effect, .value = bound_fn(Fn::kEffect, bound), .lazy = Lazy::kNone});
  // AE path properties: layer.mask("Mask 1").maskPath, layer.content("Path 1").path (path.cpp).
  props.push_back({.key = KeyId::k_mask, .value = bound_fn(Fn::kLayerMask, bound), .lazy = Lazy::kNone});
  props.push_back({.key = KeyId::k_content, .value = bound_fn(Fn::kLayerContent, bound), .lazy = Lazy::kNone});
  props.push_back({.key = KeyId::k_sampleImage, .value = bound_fn(Fn::kSampleImage, bound), .lazy = Lazy::kNone});
}

Value Interp::plain_bound(std::vector<Prop> props, const Value& bound) {
  Obj* o = arena_.obj(ObjKind::kPlain);
  o->props = std::move(props);
  o->bound = bound;
  return Value::object(o);
}

Value Interp::active_camera() {
  if (!active_camera_built_) {
    active_camera_built_ = true;
    std::optional<Str> ref;
    if (ctx_.host != nullptr) ref = ctx_.host->active_camera_at(ctx_.time);
    // AE: thisComp.activeCamera with no camera is an error to read through;
    // undefined makes `.position` etc. fail with the usual message.
    if (ref) active_camera_ = comp_layer(str(std::move(*ref)), Value{});
  }
  return active_camera_;
}

Value Interp::read_layer_lazy(Obj& o, const Prop& p) {
  if (p.key == KeyId::k_activeCamera) return active_camera();
  Host* host = ctx_.host;
  Str name_storage;
  const Str* name = nullptr;
  if (!o.bound.is_nullish()) {
    name_storage = to_string(o.bound);
    name = &name_storage;
  }
  const double t = ctx_.time;
  switch (p.lazy) {
    case Lazy::kLayerVec:
    case Lazy::kLayerProp:
      if (p.lazy == Lazy::kLayerProp && option_prop(p.key) == nullptr) return {};
      // A property object: its value now, and .valueAtTime(t), .velocity, .key(n)…
      return prop_object(sample_layer(o.bound, p.key, t), PropKind::kLayer, o.bound, p.key, nullptr, Value{});
    case Lazy::kLayerColor: {
      std::optional<std::array<double, 4>> c;
      if (host != nullptr) c = host->layer_color_at(name, u"fill", t);
      const std::array<double, 4> v = c.value_or(std::array<double, 4>{1, 1, 1, 1});
      return array({Value::number(v[0]), Value::number(v[1]), Value::number(v[2]), Value::number(v[3])});
    }
    case Lazy::kCameraOption:
    case Lazy::kLightOption: {
      std::vector<Prop> props;
      if (p.lazy == Lazy::kCameraOption) {
        for (const KeyId k : kCameraOptionKeys) props.push_back({.key = k, .value = {}, .lazy = Lazy::kLayerProp});
      } else {
        for (const KeyId k : kLightOptionKeys) props.push_back({.key = k, .value = {}, .lazy = Lazy::kLayerProp});
        props.push_back({.key = KeyId::k_color, .value = {}, .lazy = Lazy::kLayerColor});
        props.push_back({.key = KeyId::k_adbe_light_color, .value = {}, .lazy = Lazy::kLayerColor});
      }
      return plain_bound(std::move(props), o.bound);
    }
    default:
      break;
  }
  return {};
}

Value Interp::look_at(Args a) {
  // AE lookAt(fromPoint, atPoint): the orientation that aims a camera at
  // `fromPoint` toward `atPoint`, in Premation's camera axes —
  // [X Rotation (tilt), Y Rotation (pan), 0], the values a one-node camera's
  // orientationX / orientationY take (transform.cpp look_at_orientation).
  const auto from = point3(a[0]);
  const auto to = point3(a[1]);
  if (!from || !to) throw_eval(u"lookAt() needs two points, e.g. lookAt(position, [960, 540, 0]).");
  const double dx = (*to)[0] - (*from)[0];
  const double dy = (*to)[1] - (*from)[1];
  const double dz = (*to)[2] - (*from)[2];
  const std::array<double, 2> h2{dx, dz};
  const double h = motion::js::hypot(h2);
  const double yaw = motion::js::atan2(dx, dz) * 180 / std::numbers::pi;
  const double pitch = motion::js::atan2(-dy, h) * 180 / std::numbers::pi;
  return array({Value::number(pitch + 0), Value::number(yaw + 0), Value::number(0)});
}

Value Interp::space_vec_fn(const Obj& f, Args a) {
  const bool vec = f.fn == Fn::kToCompVec;
  const Str fn = vec ? Str(u"toCompVec") : Str(u"fromCompToSurface");
  const double t = a[1].is_undefined() ? ctx_.time : to_number(a[1]);
  const bool self = f.bound.is_nullish();
  Str name_storage;
  const Str* name = nullptr;
  if (!self) {
    name_storage = to_string(f.bound);
    name = &name_storage;
  }
  Host* host = ctx_.host;
  if (host == nullptr || !host->has_space_at() || !host->space_exists(name, t)) {
    throw_eval(self ? fn + u"() cannot see this layer’s transform here."
                    : fn + u"(): no layer named " + lq() + name_storage + rq() + u".");
  }
  const auto p = point3(a[0]);
  if (!p) throw_eval(fn + u"() needs a point, e.g. " + fn + u"([0, 0]).");
  std::array<double, 2> out{};
  if (vec) {
    // A vector, not a point: the layer-space origin's image is subtracted.
    const std::array<double, 3> q = host->space_convert(name, t, SpaceOp::kToComp, {(*p)[0], (*p)[1], 0});
    const std::array<double, 3> o0 = host->space_convert(name, t, SpaceOp::kToComp, {0, 0, 0});
    out = {q[0] - o0[0], q[1] - o0[1]};
  } else {
    // The point on the layer's surface (z = 0) the active camera sees at this
    // comp point: the ray/plane intersection fromComp runs for a 3D layer.
    const std::array<double, 3> q = host->space_convert(name, t, SpaceOp::kFromComp, {(*p)[0], (*p)[1], 0});
    out = {q[0], q[1]};
  }
  return array({Value::number(out[0]), Value::number(out[1])});
}

// ── Markers ─────────────────────────────────────────────────────────────────

Interp::MarkerList& Interp::markers(MarkerScope scope) {
  MarkerList& m = markers_[static_cast<std::size_t>(scope)];
  if (m.built) return m;
  m.built = true;
  std::vector<MarkerData> data;
  if (ctx_.host != nullptr && ctx_.host->has_markers_at()) data = ctx_.host->markers_at(scope);
  // `.sort((a, b) => compareMarkerTimes(a.time, b.time))`: ascending, NaN
  // last. A total order, so any stable sort (V8's TimSort, this) agrees.
  std::ranges::stable_sort(data, [](const MarkerData& a, const MarkerData& b) {
    if (std::isnan(a.time)) return false;
    if (std::isnan(b.time)) return true;
    return a.time - b.time < 0;
  });
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
/// expressions.ts `clampKeyIndex`: 1-based, rounded, clamped to 1..count; an
/// index that rounds to NaN is 1 (key(n) and marker.key(n) alike).
double clamp_key_index(const Value& n, double count) {
  const double r = motion::js::round(to_number(n));
  if (std::isnan(r)) return 1;
  return js_max2(1, js_min2(count, r));
}

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
  return m.sorted[static_cast<std::size_t>(clamp_key_index(n, static_cast<double>(m.sorted.size()))) - 1];
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

void Interp::need_time(const Value& t, std::u16string_view fn) {
  if (!std::isnan(to_number(t))) return;
  Str msg(fn);
  msg += u"() needs a time in seconds, e.g. ";
  msg += fn;
  msg += u"(time - 0.5).";
  throw_eval(std::move(msg));
}

double Interp::velocity_at(const Value& t) {
  constexpr double dt = 0.001;
  const double v1 = self_at(Value::number(to_number(t) - dt));
  const double v2 = self_at(js_add(t, Value::number(dt), arena_));
  return (v2 - v1) / (2 * dt);
}

double Interp::next_random() {
  // expressions.ts `nextRandom`: (seed, frame, call) unless timeless — see the
  // comment there for the frame rounding (motion-blur samples) and the salt.
  random_counter_ += 1;
  const double base = to_number(random_seed_) * 1013.7 + random_counter_ * 71.3;
  if (random_timeless_) return hash01(base);
  const double frame = motion::js::round(ctx_.time * comp_.fps);
  const double salt = frame - frame == 0 ? frame * 7.919 : 0;  // Number.isFinite
  return hash01(base + salt);
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
  const double i = clamp_key_index(n, num_keys);
  double t = 0;  // keyTimes[i - 1] ?? 0
  if (i - 1 < num_keys) t = kt[static_cast<std::size_t>(i - 1)];
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

Value Interp::loop(bool out, const Value& mode_arg, const Value& limit_arg, bool by_duration) {
  const double time = ctx_.time;
  const std::optional<KeySpan>& span = ctx_.self_span;
  if (!span || span->end <= span->start || (out ? time <= span->end : time >= span->start)) {
    return Value::number(ctx_.value);
  }
  double start = span->start;
  double end = span->end;
  // AE's second argument narrows the looped stretch to its end (loopOut) or
  // start (loopIn): loopOut(type, numKeyframes) loops the last numKeyframes
  // segments, loopOutDuration(type, duration) the last `duration` seconds.
  // 0 / absent = the whole keyed span.
  if (!limit_arg.is_undefined()) {
    const double n = to_number(limit_arg);
    if (by_duration) {
      if (n > 0 && std::isfinite(n)) {
        if (out) start = std::max(start, end - n);
        else end = std::min(end, start + n);
      }
    } else if (n >= 1 && std::isfinite(n) && ctx_.key_times.size() >= 2) {
      const std::size_t last = ctx_.key_times.size() - 1;
      const std::size_t k = std::min(last, static_cast<std::size_t>(std::floor(n)));
      if (out) start = ctx_.key_times[last - k];
      else end = ctx_.key_times[k];
    }
  }
  if (end <= start) return Value::number(ctx_.value);
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

Value Interp::sample_image(const Value& layer, Args a) {
  // A point / radius is [x, y] (a property object reads its value; a scalar is both).
  const auto pair = [](const Value& v, std::array<double, 2> fallback) -> std::optional<std::array<double, 2>> {
    if (v.is_undefined()) return fallback;
    const Value u = unwrap_prop(v);
    if (!is_array(u)) {
      const double s = to_number(u);
      if (!std::isfinite(s)) return std::nullopt;
      return std::array<double, 2>{s, s};
    }
    if (u.o->elems.size() < 2) return std::nullopt;
    const double x = to_number(unwrap_prop(u.o->elems[0]));
    const double y = to_number(unwrap_prop(u.o->elems[1]));
    if (!std::isfinite(x) || !std::isfinite(y)) return std::nullopt;
    return std::array<double, 2>{x, y};
  };
  if (a[0].is_undefined()) throw_eval(u"sampleImage: give the point to sample, as [x, y] in the layer's own space.");
  const auto point = pair(a[0], {0, 0});
  if (!point) throw_eval(u"sampleImage: the point must be [x, y] (two numbers).");
  const auto radius = pair(a[1], {0.5, 0.5});
  if (!radius || (*radius)[0] < 0 || (*radius)[1] < 0) throw_eval(u"sampleImage: the radius must be [x, y], neither below 0.");
  const bool post_effect = a[2].is_undefined() ? true : truthy(unwrap_prop(a[2]));
  const double t = a[3].is_undefined() ? ctx_.time : to_number(unwrap_prop(a[3]));
  if (!std::isfinite(t)) throw_eval(u"sampleImage: the time must be a number of seconds.");
  if (ctx_.host == nullptr) throw_eval(u"sampleImage needs the renderer, which this evaluation does not have.");
  const bool self_layer = layer.is_null();
  Str name;
  if (!self_layer) name = to_string(layer);
  const std::optional<Host::ImageSample> s = ctx_.host->sample_image(self_layer ? nullptr : &name, *point, *radius, post_effect, t);
  if (!s) throw_eval(u"sampleImage: no such layer.");
  if (!s->error.empty()) throw_eval(s->error);
  return array({Value::number(s->rgba[0]), Value::number(s->rgba[1]), Value::number(s->rgba[2]), Value::number(s->rgba[3])});
}

Value Interp::source_rect(Args a) {
  const double t = a[0].is_undefined() ? ctx_.time : to_number(a[0]);
  const bool extents = a[1].is_undefined() ? false : truthy(a[1]);
  std::optional<SourceRect> r;
  if (ctx_.host != nullptr && ctx_.host->has_source_rect_at()) r = ctx_.host->source_rect_at(t, extents);
  const SourceRect rect = r.value_or(SourceRect{.top = 0,
                                                .left = 0,
                                                .width = ctx_.layer_info ? ctx_.layer_info->width : comp_.width,
                                                .height = ctx_.layer_info ? ctx_.layer_info->height : comp_.height});
  return plain({
      {.key = KeyId::k_top, .value = Value::number(rect.top)},
      {.key = KeyId::k_left, .value = Value::number(rect.left)},
      {.key = KeyId::k_width, .value = Value::number(rect.width)},
      {.key = KeyId::k_height, .value = Value::number(rect.height)},
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
  if (f.fn == Fn::kNone && f.node != kNoNode) return call_user(f, args);
  // A scalar property object answers the Number methods as its number.
  if (f.fn >= Fn::kMathAbs) return call_std(*this, f, unwrap_prop(this_arg), args);
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
      need_time(a[0], u"valueAtTime");
      return Value::number(self_at(a[0]));
    case Fn::kValueAtTimeText:
      return source_text_of(Value::null(), to_number(a[0]));
    case Fn::kVelocityAtTime:
      need_time(a[0], u"velocityAtTime");
      return Value::number(velocity_at(a[0]));
    case Fn::kLayer:
      return layer_at(a[0], a[1], Value::number(ctx_.time));
    case Fn::kLayerAt:
      return layer_at(a[0], a[1], a[2]);
    case Fn::kLoopOut:
      return loop(true, a[0], a[1], false);
    case Fn::kLoopIn:
      return loop(false, a[0], a[1], false);
    case Fn::kLoopOutDuration:
      return loop(true, a[0], a[1], true);
    case Fn::kLoopInDuration:
      return loop(false, a[0], a[1], true);
    case Fn::kFootage:
      return footage(a[0]);
    case Fn::kFootageDataValue:
      return footage_data_value(*f.bound.o, a[0]);
    case Fn::kFootageDataKeyCount:
      return footage_data_key_count(*f.bound.o, a[0]);
    case Fn::kCreatePath:
      return create_path(a);
    case Fn::kPathPoints:
    case Fn::kPathInTangents:
    case Fn::kPathOutTangents:
    case Fn::kPathIsClosed:
    case Fn::kPathPointOnPath:
    case Fn::kPathTangentOnPath:
    case Fn::kPathNormalOnPath:
      return path_method(f.fn, *f.bound.o, a);
    case Fn::kLayerMask:
      return layer_mask(f.bound, a[0]);
    case Fn::kLayerContent:
      return layer_content(f.bound, a[0]);
    case Fn::kSampleImage:
      return sample_image(f.bound, a);
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
      random_timeless_ = truthy(a[1]);
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
    case Fn::kLookAt:
      return look_at(a);
    case Fn::kToCompVec:
    case Fn::kFromCompToSurface:
      return space_vec_fn(f, a);
    case Fn::kMarkerKey:
      return marker_key(static_cast<MarkerScope>(f.aux), a[0]);
    case Fn::kMarkerNearestKey:
      return marker_nearest(static_cast<MarkerScope>(f.aux), a);
    case Fn::kEffect:
      return effect_fn(f, a);
    case Fn::kEffectParam:
    case Fn::kEffectParamMethod:
      return effect_param(f, a);
    // AE globals and property objects (2026-10-21)
    case Fn::kDegreesToRadians:
      return Value::number(to_number(a[0]) * std::numbers::pi / 180);
    case Fn::kRadiansToDegrees:
      return Value::number(to_number(a[0]) * 180 / std::numbers::pi);
    case Fn::kHslToRgb:
      return color_convert(true, a[0]);
    case Fn::kRgbToHsl:
      return color_convert(false, a[0]);
    case Fn::kSmooth:
      return smooth(nullptr, a);
    case Fn::kTemporalWiggle:
      return temporal_wiggle(a);
    case Fn::kComp:
      return comp_fn(a);
    case Fn::kCompByNameLayer:
      return comp_layer_by_name(f, a);
    case Fn::kTimeToTimecode:
      return timecode(a[0], a[1]);
    case Fn::kTimeToCurrentFormat:
      return timecode(a[0], a[1].is_undefined() ? Value::number(comp_.fps) : a[1]);
    case Fn::kPropValueAtTime:
      need_time(a[0], u"valueAtTime");
      return sample_prop(f.bound.o, to_number(a[0]));
    case Fn::kPropVelocityAtTime:
      need_time(a[0], u"velocityAtTime");
      return prop_velocity(f.bound.o, to_number(a[0]));
    case Fn::kPropKey:
      return prop_key(*f.bound.o, a[0]);
    case Fn::kPropNearestKey:
      return prop_nearest_key(*f.bound.o, a);
    case Fn::kPropSmooth:
      return smooth(f.bound.o, a);
    default:
      break;
  }
  return {};
}

// ── AE-style rigs: layer facts, the transform group, effects ────────────────

namespace {

/// The layer reference a bound object carries, as the Host wants it
/// (nullptr = this layer).
struct BoundName {
  Str storage;
  const Str* name = nullptr;
  explicit BoundName(const Value& bound) {
    if (bound.is_nullish()) return;
    storage = to_string(bound);
    name = &storage;
  }
};

}  // namespace

Value Interp::layer_fact(const Obj& o, KeyId key) {
  const BoundName bn(o.bound);
  std::optional<LayerFacts> facts;
  if (ctx_.host != nullptr) facts = ctx_.host->layer_facts_at(bn.name, ctx_.time);
  // No provider (or a layer the host cannot see): AE's defaults for a layer
  // that spans the composition.
  LayerFacts f;
  f.out_point = comp_.duration;
  if (facts) f = *facts;
  switch (key) {
    case KeyId::k_inPoint:
    case KeyId::k_startTime:
      return Value::number(f.in_point);
    case KeyId::k_outPoint:
      return Value::number(f.out_point);
    case KeyId::k_index:
      return Value::number(f.index);
    case KeyId::k_hasParent:
      return Value::boolean(f.parent.has_value());
    case KeyId::k_enabled:
    case KeyId::k_active:
      return Value::boolean(f.enabled);
    case KeyId::k_parent:
      if (!f.parent) return Value::null();
      return comp_layer(str(*f.parent), Value{});
    case KeyId::k_name:
      if (facts && !facts->name.empty()) return str(facts->name);
      return o.bound;
    default:
      return {};
  }
}

Value Interp::transform_group(const Value& bound) {
  std::vector<Prop> props = {
      {.key = KeyId::k_position, .value = {}, .lazy = Lazy::kLayerVec},
      {.key = KeyId::k_anchorPoint, .value = {}, .lazy = Lazy::kLayerVec},
      {.key = KeyId::k_scale, .value = {}, .lazy = Lazy::kLayerVec},
      {.key = KeyId::k_orientation, .value = {}, .lazy = Lazy::kLayerVec},
      {.key = KeyId::k_rotation, .value = {}, .lazy = Lazy::kLayerProp},
      {.key = KeyId::k_xRotation, .value = {}, .lazy = Lazy::kLayerProp},
      {.key = KeyId::k_yRotation, .value = {}, .lazy = Lazy::kLayerProp},
      {.key = KeyId::k_zRotation, .value = {}, .lazy = Lazy::kLayerProp},
      {.key = KeyId::k_opacity, .value = {}, .lazy = Lazy::kLayerProp},
      {.key = KeyId::k_pointOfInterest, .value = {}, .lazy = Lazy::kLayerVec},
  };
  return plain_bound(std::move(props), bound);
}

Value Interp::effect_fn(const Obj& f, Args a) {
  Host* host = ctx_.host;
  if (host == nullptr || !host->has_effects()) throw_eval(u"effect() cannot see this layer’s effects here.");
  const Value name_v = a[0];
  if (!name_v.is_string() || name_v.s == nullptr) {
    throw_eval(u"effect() needs the effect’s name, e.g. effect(\"Slider Control\").");
  }
  const BoundName bn(f.bound);
  const Str& name = *name_v.s;
  if (!host->effect_exists(bn.name, name)) {
    const Str where = bn.name != nullptr ? u" on layer " + lq() + *bn.name + rq() : Str(u" on this layer");
    throw_eval(u"No effect named " + lq() + name + rq() + where + u".");
  }
  // The effect object: callable (`effect("X")("Param")`), with `.param("…")`
  // and `.name`.
  Obj* e = arena_.obj(ObjKind::kFunction);
  e->fn = Fn::kEffectParam;
  e->bound = f.bound;
  e->str = name_v.s;
  Obj* method = arena_.obj(ObjKind::kFunction);
  method->fn = Fn::kEffectParamMethod;
  method->bound = f.bound;
  method->str = name_v.s;
  // `.active` / `.enabled`: the effect's on/off switch (AE's Effect.active).
  const Value on = Value::boolean(host->effect_active(bn.name, name));
  e->props = {{.key = KeyId::k_name, .value = name_v, .lazy = Lazy::kNone},
              {.key = KeyId::k_param, .value = Value::object(method), .lazy = Lazy::kNone},
              {.key = KeyId::k_active, .value = on, .lazy = Lazy::kNone},
              {.key = KeyId::k_enabled, .value = on, .lazy = Lazy::kNone}};
  return Value::object(e);
}

Value Interp::effect_param(const Obj& f, Args a) {
  Host* host = ctx_.host;
  if (host == nullptr) return Value::number(0);
  const Str& effect = *f.str;
  if (!a[0].is_string() && !a[0].is_number()) {
    throw_eval(u"effect(" + lq() + effect + rq() + u")(…) needs a parameter name or number, e.g. (\"Slider\").");
  }
  // The parameter as a property object: its value now, and `.value`,
  // `.valueAtTime(t)`, `.velocity`, `.numKeys`, `.key(n)` on it.
  Obj probe;
  probe.pkind = PropKind::kEffect;
  probe.bound = f.bound;
  probe.str = f.str;
  probe.arg = a[0];
  const Value v = sample_prop(&probe, ctx_.time);
  return prop_object(v, PropKind::kEffect, f.bound, KeyId::kUnknown, f.str, a[0]);
}

// ── AE property objects (2026-10-21) ────────────────────────────────────────

Value Interp::prop_object(const Value& v, PropKind kind, const Value& bound, KeyId pkey, const Str* effect,
                          const Value& arg) {
  Obj* o = nullptr;
  if (is_array(v)) {
    o = v.o;  // a fresh array the sampler built: it carries the members itself
  } else {
    o = arena_.obj(ObjKind::kNumberObject);
    o->num = to_number(v);
  }
  o->pkind = kind;
  o->bound = bound;
  o->pkey = pkey;
  o->str = effect;
  o->arg = arg;
  return Value::object(o);
}

Value Interp::sample_layer(const Value& bound, KeyId key, double t) {
  Host* host = ctx_.host;
  const BoundName bn(bound);
  const auto read = [&](const char16_t* prop, double fallback = 0.0) {
    if (host == nullptr) return fallback;
    return host->layer_prop_at(bn.name, prop, t).value_or(fallback);
  };
  switch (key) {
    case KeyId::k_position:
      return array({Value::number(read(u"x")), Value::number(read(u"y")), Value::number(read(u"z"))});
    case KeyId::k_pointOfInterest:
      return array({Value::number(read(u"poiX")), Value::number(read(u"poiY")), Value::number(read(u"poiZ"))});
    case KeyId::k_anchorPoint:
      return array({Value::number(read(u"anchorX")), Value::number(read(u"anchorY")), Value::number(read(u"anchorZ"))});
    case KeyId::k_scale:
      // Stored as a multiplier (1 = 100 %); AE reads percent.
      return array({Value::number(read(u"scaleX", 1) * 100), Value::number(read(u"scaleY", 1) * 100),
                    Value::number(read(u"scaleZ", 1) * 100)});
    case KeyId::k_orientation:
      return array({Value::number(read(u"orientationX")), Value::number(read(u"orientationY")),
                    Value::number(read(u"orientationZ"))});
    default:
      break;
  }
  const char16_t* prop = option_prop(key);
  if (prop == nullptr) return {};
  const double v = read(prop, key == KeyId::k_opacity ? 100.0 : 0.0);
  // AE's Depth of Field is a switch: on when the blur level is above zero.
  if (key == KeyId::k_depthOfField) return Value::number(v > 0 ? 1 : 0);
  return Value::number(v);
}

Value Interp::sample_prop(const Obj* p, double t) {
  if (p == nullptr) return Value::number(self_at(Value::number(t)));
  if (p->pkind == PropKind::kLayer) return sample_layer(p->bound, p->pkey, t);
  Host* host = ctx_.host;
  if (host == nullptr) return Value::number(0);
  const BoundName bn(p->bound);
  const Str& effect = *p->str;
  const std::optional<EffectParam> v = p->arg.is_string()
                                           ? host->effect_param_at(bn.name, effect, p->arg.s, 0, t)
                                           : host->effect_param_at(bn.name, effect, nullptr, to_number(p->arg), t);
  if (!v) {
    throw_eval(u"Effect " + lq() + effect + rq() + u" has no parameter " + lq() + to_string(p->arg) + rq() + u".");
  }
  if (v->size <= 1) return Value::number(v->v[0]);
  std::vector<Value> out;
  out.reserve(v->size);
  for (std::size_t i = 0; i < v->size && i < v->v.size(); ++i) out.push_back(Value::number(v->v[i]));
  return array(std::move(out));
}

Value Interp::prop_velocity(const Obj* p, double t) {
  if (p == nullptr) return Value::number(velocity_at(Value::number(t)));
  constexpr double dt = 0.001;
  const Value a = sample_prop(p, t - dt);
  const Value b = sample_prop(p, t + dt);
  if (!is_array(a) || !is_array(b)) return Value::number((to_number(b) - to_number(a)) / (2 * dt));
  const std::size_t n = std::min(a.o->elems.size(), b.o->elems.size());
  std::vector<Value> out;
  out.reserve(n);
  for (std::size_t i = 0; i < n; ++i) {
    out.push_back(Value::number((to_number(b.o->elems[i]) - to_number(a.o->elems[i])) / (2 * dt)));
  }
  return array(std::move(out));
}

std::optional<Value> Interp::prop_member(Obj& o, KeyId kid) {
  const Value self = Value::object(&o);
  switch (kid) {
    case KeyId::k_value:
      return sample_prop(&o, ctx_.time);
    case KeyId::k_valueAtTime:
      return bound_fn(Fn::kPropValueAtTime, self);
    case KeyId::k_velocityAtTime:
      return bound_fn(Fn::kPropVelocityAtTime, self);
    case KeyId::k_velocity:
      return prop_velocity(&o, ctx_.time);
    case KeyId::k_speed: {
      const Value v = prop_velocity(&o, ctx_.time);
      if (!is_array(v)) return Value::number(std::fabs(to_number(v)));
      return Value::number(hypot_of(v.o->elems));
    }
    case KeyId::k_numKeys:
      return Value::number(static_cast<double>(prop_key_times(o).size()));
    case KeyId::k_key:
      return bound_fn(Fn::kPropKey, self);
    case KeyId::k_nearestKey:
      return bound_fn(Fn::kPropNearestKey, self);
    case KeyId::k_smooth:
      return bound_fn(Fn::kPropSmooth, self);
    default:
      return std::nullopt;
  }
}

std::vector<double> Interp::prop_key_times(const Obj& o) {
  Host* host = ctx_.host;
  if (host == nullptr) return {};
  const BoundName bn(o.bound);
  if (o.pkind == PropKind::kEffect) {
    return o.arg.is_string() ? host->effect_param_key_times(bn.name, *o.str, o.arg.s, 0)
                             : host->effect_param_key_times(bn.name, *o.str, nullptr, to_number(o.arg));
  }
  // A vector's keys are its first member's (the API keys the members together).
  const char16_t* prop = nullptr;
  switch (o.pkey) {
    case KeyId::k_position: prop = u"x"; break;
    case KeyId::k_pointOfInterest: prop = u"poiX"; break;
    case KeyId::k_anchorPoint: prop = u"anchorX"; break;
    case KeyId::k_scale: prop = u"scaleX"; break;
    case KeyId::k_orientation: prop = u"orientationX"; break;
    default: prop = option_prop(o.pkey); break;
  }
  if (prop == nullptr) return {};
  return host->layer_key_times(bn.name, prop);
}

Value Interp::prop_key(const Obj& o, const Value& n) {
  const std::vector<double> kt = prop_key_times(o);
  if (kt.empty()) throw_eval(u"key() needs a keyframe — this property has none.");
  const double i = clamp_key_index(n, static_cast<double>(kt.size()));
  const double t = kt[static_cast<std::size_t>(i) - 1];
  return plain({
      {.key = KeyId::k_index, .value = Value::number(i)},
      {.key = KeyId::k_time, .value = Value::number(t)},
      {.key = KeyId::k_value, .value = sample_prop(&o, t)},
  });
}

Value Interp::prop_nearest_key(const Obj& o, Args a) {
  const std::vector<double> kt = prop_key_times(o);
  if (kt.empty()) {
    return plain({
        {.key = KeyId::k_index, .value = Value::number(0)},
        {.key = KeyId::k_time, .value = Value::number(0)},
        {.key = KeyId::k_value, .value = sample_prop(&o, ctx_.time)},
    });
  }
  const double t = a[0].is_undefined() ? ctx_.time : to_number(a[0]);
  std::size_t best = 0;
  for (std::size_t i = 1; i < kt.size(); ++i) {
    if (std::fabs(kt[i] - t) < std::fabs(kt[best] - t)) best = i;
  }
  return prop_key(o, Value::number(static_cast<double>(best + 1)));
}

Value Interp::smooth(const Obj* prop, Args a) {
  // AE smooth(width = .2, samples = 5, t = time): the mean of `samples`
  // values spread evenly over [t - width/2, t + width/2].
  const double width = a[0].is_undefined() ? 0.2 : to_number(a[0]);
  double samples = a[1].is_undefined() ? 5 : std::floor(to_number(a[1]));
  if (!(samples >= 1)) samples = 1;
  samples = js_min2(samples, 256);  // bounded: the source picks the count
  const double t = a[2].is_undefined() ? ctx_.time : to_number(a[2]);
  if (samples <= 1 || !(width > 0)) return sample_prop(prop, t);
  const auto count = static_cast<std::size_t>(samples);
  std::vector<double> sum;
  bool vector = false;
  for (std::size_t i = 0; i < count; ++i) {
    const double ti = t - width / 2 + width * static_cast<double>(i) / static_cast<double>(count - 1);
    const Value v = sample_prop(prop, ti);
    if (is_array(v)) {
      vector = true;
      if (sum.size() < v.o->elems.size()) sum.resize(v.o->elems.size(), 0.0);
      for (std::size_t k = 0; k < v.o->elems.size(); ++k) sum[k] += to_number(v.o->elems[k]);
    } else {
      if (sum.empty()) sum.push_back(0);
      sum[0] += to_number(v);
    }
  }
  if (!vector) return Value::number(sum.empty() ? 0 : sum[0] / samples);
  std::vector<Value> out;
  out.reserve(sum.size());
  for (const double s : sum) out.push_back(Value::number(s / samples));
  return array(std::move(out));
}

Value Interp::temporal_wiggle(Args a) {
  // AE temporalWiggle(freq, amp, octaves = 1, amp_mult = .5, t = time): the
  // property sampled at a time wiggled by up to `amp` seconds.
  const double freq = to_number(a[0]);
  const double amp = to_number(a[1]);
  double floored = a[2].is_undefined() ? 1 : std::floor(to_number(a[2]));
  if (floored == 0 || std::isnan(floored)) floored = 1;
  const auto octaves = static_cast<int>(js_min2(kMaxWiggleOctaves, js_max2(1, floored)));
  const double mult = a[3].is_undefined() ? 0.5 : to_number(a[3]);
  const double t = a[4].is_undefined() ? ctx_.time : to_number(a[4]);
  const double seed = ctx_.prop_seed.value_or(0) + 101.3;  // a phase of its own, apart from wiggle()'s
  double total = 0;
  double max_a = 0;
  double f = freq;
  double am = amp;
  for (int i = 0; i < octaves; ++i) {
    total += (smooth_noise(t * f + seed) * 2 - 1) * am;
    max_a += am;
    f *= 2;
    am *= mult;
  }
  const double offset = max_a > 0 ? (total / max_a) * amp : 0;
  return sample_prop(nullptr, t + offset);
}

Value Interp::comp_fn(Args a) {
  if (!a[0].is_string()) throw_eval(u"comp() needs a composition name, e.g. comp(\"Main\").");
  std::optional<CompFacts> f;
  if (ctx_.host != nullptr) f = ctx_.host->comp_facts(a[0].s);
  if (!f) throw_eval(u"No composition named " + lq() + *a[0].s + rq() + u".");
  const CompInfo& c = f->info;
  return plain({
      {.key = KeyId::k_name, .value = str(f->name)},
      {.key = KeyId::k_width, .value = Value::number(c.width)},
      {.key = KeyId::k_height, .value = Value::number(c.height)},
      {.key = KeyId::k_duration, .value = Value::number(c.duration)},
      {.key = KeyId::k_frameDuration, .value = Value::number(1 / js_max2(1, c.fps))},
      {.key = KeyId::k_fps, .value = Value::number(c.fps)},
      {.key = KeyId::k_numLayers, .value = Value::number(c.num_layers)},
      {.key = KeyId::k_layer, .value = bound_fn(Fn::kCompByNameLayer, a[0])},
  });
}

Value Interp::comp_layer_by_name(const Obj& f, Args a) {
  const Str comp = to_string(f.bound);
  std::optional<Str> ref;
  if (ctx_.host != nullptr) {
    if (a[0].is_string()) {
      ref = ctx_.host->comp_layer_ref(comp, a[0].s, 0);
    } else if (a[0].is_number()) {
      ref = ctx_.host->comp_layer_ref(comp, nullptr, a[0].n);
    } else {
      throw_eval(u"layer() needs a layer name or number, e.g. layer(\"Title\").");
    }
  }
  if (!ref) {
    throw_eval(u"No layer " + lq() + to_string(a[0]) + rq() + u" in composition " + lq() + comp + rq() + u".");
  }
  return comp_layer(str(std::move(*ref)), Value{});
}

namespace {

double hue_to_rgb(double p, double q, double t) noexcept {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1.0 / 6) return p + (q - p) * 6 * t;
  if (t < 1.0 / 2) return q;
  if (t < 2.0 / 3) return p + (q - p) * (2.0 / 3 - t) * 6;
  return p;
}

}  // namespace

Value Interp::color_convert(bool to_rgb, const Value& v) {
  if (!is_array(v) || v.o->elems.size() < 3) {
    throw_eval(to_rgb ? Str(u"hslToRgb() needs a colour, e.g. hslToRgb([0.5, 1, 0.5, 1]).")
                      : Str(u"rgbToHsl() needs a colour, e.g. rgbToHsl([1, 0, 0, 1])."));
  }
  const std::vector<Value>& e = v.o->elems;
  const double x = to_number(e[0]);
  const double y = to_number(e[1]);
  const double z = to_number(e[2]);
  const double alpha = e.size() > 3 ? to_number(e[3]) : 1.0;
  std::array<double, 3> out{};
  if (to_rgb) {
    const double h = x;
    const double s = y;
    const double l = z;
    if (s == 0) {
      out = {l, l, l};
    } else {
      const double q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const double p = 2 * l - q;
      out = {hue_to_rgb(p, q, h + 1.0 / 3), hue_to_rgb(p, q, h), hue_to_rgb(p, q, h - 1.0 / 3)};
    }
  } else {
    const double mx = std::max({x, y, z});
    const double mn = std::min({x, y, z});
    const double l = (mx + mn) / 2;
    double h = 0;
    double s = 0;
    if (mx != mn) {
      const double d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx == x) {
        h = (y - z) / d + (y < z ? 6 : 0);
      } else if (mx == y) {
        h = (z - x) / d + 2;
      } else {
        h = (x - y) / d + 4;
      }
      h /= 6;
    }
    out = {h, s, l};
  }
  return array({Value::number(out[0]), Value::number(out[1]), Value::number(out[2]), Value::number(alpha)});
}

Value Interp::timecode(const Value& tv, const Value& base) {
  // AE timeToTimecode: "H:MM:SS:FF" on a whole-frame base (29.97 counts as 30).
  const double t = tv.is_undefined() ? ctx_.time : to_number(tv);
  double fps = base.is_undefined() ? 30 : motion::js::round(to_number(base));
  if (!(fps >= 1)) fps = 30;
  double total = motion::js::round(t * fps);
  if (!is_finite(total)) total = 0;
  const bool negative = total < 0;
  total = std::fabs(total);
  const double frames = std::fmod(total, fps);
  const double seconds_total = std::floor(total / fps);
  const double ss = std::fmod(seconds_total, 60);
  const double mm = std::fmod(std::floor(seconds_total / 60), 60);
  const double hh = std::floor(seconds_total / 3600);
  const auto pad = [](double n, std::size_t width) {
    Str s = number_to_str(n);
    while (s.size() < width) s.insert(s.begin(), u'0');
    return s;
  };
  const std::size_t frame_width = std::max<std::size_t>(2, number_to_str(fps - 1).size());
  Str out = negative ? Str(u"-") : Str();
  out += number_to_str(hh) + u":" + pad(mm, 2) + u":" + pad(ss, 2) + u":" + pad(frames, frame_width);
  return str(std::move(out));
}
}  // namespace motion::expr::detail
