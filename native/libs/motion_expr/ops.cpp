// ECMAScript abstract operations — see ops.hpp.

#include "ops.hpp"

#include <cmath>
#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "numconv.hpp"

namespace motion::expr::detail {

Str number_to_str(double d) {
  const std::string a = motion::js::number_to_string(d);
  return {a.begin(), a.end()};
}

Str join(const std::vector<Value>& elems, std::u16string_view sep) {
  Str out;
  for (std::size_t i = 0; i < elems.size(); ++i) {
    if (i > 0) out += sep;
    if (!elems[i].is_nullish()) out += to_string(elems[i]);
  }
  return out;
}

Prim to_primitive(const Value& v) {
  switch (v.tag) {
    case Tag::kUndefined:
      return {};
    case Tag::kNull:
      return {.tag = Tag::kNull};
    case Tag::kBool:
      return {.tag = Tag::kBool, .b = v.b};
    case Tag::kNumber:
      return {.tag = Tag::kNumber, .n = v.n};
    case Tag::kString:
      return {.tag = Tag::kString, .s = *v.s};
    case Tag::kObject:
      break;
  }
  const Obj& o = *v.o;
  switch (o.kind) {
    case ObjKind::kStringObject:
      return {.tag = Tag::kString, .s = *o.str};
    case ObjKind::kArray:
      return {.tag = Tag::kString, .s = join(o.elems, u",")};
    case ObjKind::kMath:
      return {.tag = Tag::kString, .s = u"[object Math]"};
    case ObjKind::kFunction:
      // V8 prints the function's SOURCE TEXT, i.e. the transpiled TypeScript of
      // the arrow function — not reproducible and not meaningful. Documented
      // divergence (native/README.md); no golden depends on it.
      return {.tag = Tag::kString, .s = u"function () { [native code] }"};
    case ObjKind::kPlain:
    case ObjKind::kStyle:
      break;
  }
  return {.tag = Tag::kString, .s = u"[object Object]"};
}

bool truthy(const Value& v) noexcept {
  switch (v.tag) {
    case Tag::kUndefined:
    case Tag::kNull:
      return false;
    case Tag::kBool:
      return v.b;
    case Tag::kNumber:
      return !(v.n == 0 || std::isnan(v.n));
    case Tag::kString:
      return !v.s->empty();
    case Tag::kObject:
      return true;
  }
  return false;
}

double to_number(const Prim& p) {
  switch (p.tag) {
    case Tag::kUndefined:
      return std::nan("");
    case Tag::kNull:
      return 0;
    case Tag::kBool:
      return p.b ? 1 : 0;
    case Tag::kNumber:
      return p.n;
    case Tag::kString:
      return motion::js::string_to_number(std::u16string_view(p.s));
    case Tag::kObject:
      break;
  }
  return std::nan("");
}

double to_number(const Value& v) {
  switch (v.tag) {
    case Tag::kNumber:
      return v.n;
    case Tag::kUndefined:
      return std::nan("");
    case Tag::kNull:
      return 0;
    case Tag::kBool:
      return v.b ? 1 : 0;
    case Tag::kString:
      return motion::js::string_to_number(std::u16string_view(*v.s));
    case Tag::kObject:
      return to_number(to_primitive(v));
  }
  return std::nan("");
}

Str to_string(const Prim& p) {
  switch (p.tag) {
    case Tag::kUndefined:
      return u"undefined";
    case Tag::kNull:
      return u"null";
    case Tag::kBool:
      return p.b ? u"true" : u"false";
    case Tag::kNumber:
      return number_to_str(p.n);
    case Tag::kString:
      return p.s;
    case Tag::kObject:
      break;
  }
  return {};
}

Str to_string(const Value& v) {
  switch (v.tag) {
    case Tag::kString:
      return *v.s;
    case Tag::kNumber:
      return number_to_str(v.n);
    case Tag::kUndefined:
      return u"undefined";
    case Tag::kNull:
      return u"null";
    case Tag::kBool:
      return v.b ? u"true" : u"false";
    case Tag::kObject:
      return to_string(to_primitive(v));
  }
  return {};
}

bool strict_equals(const Value& a, const Value& b) noexcept {
  if (a.tag != b.tag) return false;
  switch (a.tag) {
    case Tag::kUndefined:
    case Tag::kNull:
      return true;
    case Tag::kBool:
      return a.b == b.b;
    case Tag::kNumber:
      return a.n == b.n;
    case Tag::kString:
      return *a.s == *b.s;
    case Tag::kObject:
      return a.o == b.o;
  }
  return false;
}

namespace {

/// IsLooselyEqual over primitives (after any ToPrimitive).
bool loose_prim(const Prim& x, const Prim& y) {
  if (x.tag == y.tag) {
    switch (x.tag) {
      case Tag::kUndefined:
      case Tag::kNull:
        return true;
      case Tag::kBool:
        return x.b == y.b;
      case Tag::kNumber:
        return x.n == y.n;
      case Tag::kString:
        return x.s == y.s;
      case Tag::kObject:
        return false;
    }
  }
  const auto nullish = [](Tag t) { return t == Tag::kUndefined || t == Tag::kNull; };
  if (nullish(x.tag) && nullish(y.tag)) return true;
  if (nullish(x.tag) || nullish(y.tag)) return false;
  // number/string/bool mixes: everything goes through ToNumber.
  return to_number(x) == to_number(y);
}

}  // namespace

bool loose_equals(const Value& a, const Value& b) {
  if (a.tag == b.tag) return strict_equals(a, b);
  const auto nullish = [](const Value& v) { return v.is_nullish(); };
  if (nullish(a) && nullish(b)) return true;
  if (nullish(a) || nullish(b)) return false;
  // Object vs primitive: ToPrimitive the object (a boolean first becomes a
  // number, which changes nothing for our objects' primitives).
  return loose_prim(to_primitive(a), to_primitive(b));
}

std::optional<bool> less_than(const Value& a, const Value& b) {
  if (a.tag == Tag::kNumber && b.tag == Tag::kNumber) {
    if (std::isnan(a.n) || std::isnan(b.n)) return std::nullopt;
    return a.n < b.n;
  }
  const Prim px = to_primitive(a);
  const Prim py = to_primitive(b);
  if (px.tag == Tag::kString && py.tag == Tag::kString) return px.s < py.s;  // code-unit order
  const double nx = to_number(px);
  const double ny = to_number(py);
  if (std::isnan(nx) || std::isnan(ny)) return std::nullopt;
  return nx < ny;
}

Value js_add(const Value& a, const Value& b, Arena& arena) {
  if (a.tag == Tag::kNumber && b.tag == Tag::kNumber) return Value::number(a.n + b.n);
  const Prim pa = to_primitive(a);
  const Prim pb = to_primitive(b);
  if (pa.tag == Tag::kString || pb.tag == Tag::kString) {
    return Value::string(arena.str(to_string(pa) + to_string(pb)));
  }
  return Value::number(to_number(pa) + to_number(pb));
}

std::optional<std::size_t> array_index_of(const Value& key) {
  if (key.tag == Tag::kNumber) {
    const double d = key.n;
    if (d >= 0 && d <= 4294967294.0 && std::trunc(d) == d) return static_cast<std::size_t>(d);
    return std::nullopt;  // -0 is "0": handled by the trunc/compare above (−0 >= 0)
  }
  if (key.tag != Tag::kString) return std::nullopt;
  const Str& s = *key.s;
  if (s.empty() || s.size() > 10) return std::nullopt;
  if (s.size() > 1 && s[0] == u'0') return std::nullopt;
  std::size_t v = 0;
  for (const char16_t c : s) {
    if (c < u'0' || c > u'9') return std::nullopt;
    v = v * 10 + static_cast<std::size_t>(c - u'0');
  }
  if (v > 4294967294ULL) return std::nullopt;
  return v;
}

}  // namespace motion::expr::detail
