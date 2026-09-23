#include "json.hpp"

#include <cmath>
#include <cstdint>

#include "numconv.hpp"

namespace premation::js {
namespace {

const std::string kEmptyString;
const Json::Array kEmptyArray;
const Json::Object kEmptyObject;
const Json kUndefined;

void escape_into(std::string& out, std::string_view s) {
  out.push_back('"');
  for (const char ch : s) {
    const auto c = static_cast<unsigned char>(ch);
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          static constexpr char kHex[] = "0123456789abcdef";
          out += "\\u00";
          out.push_back(kHex[(c >> 4U) & 0xFU]);
          out.push_back(kHex[c & 0xFU]);
        } else {
          out.push_back(ch);
        }
    }
  }
  out.push_back('"');
}

void stringify_into(std::string& out, const Json& v) {
  switch (v.kind()) {
    case Json::Kind::undefined:
    case Json::Kind::null: out += "null"; return;
    case Json::Kind::boolean: out += v.b() ? "true" : "false"; return;
    case Json::Kind::number: {
      const double d = v.num();
      if (!std::isfinite(d)) {
        out += "null";
      } else {
        out += motion::js::number_to_string(d);
      }
      return;
    }
    case Json::Kind::string: escape_into(out, v.str()); return;
    case Json::Kind::array: {
      out.push_back('[');
      bool first = true;
      for (const Json& e : v.arr()) {
        if (!first) out.push_back(',');
        first = false;
        stringify_into(out, e);  // undefined element → null
      }
      out.push_back(']');
      return;
    }
    case Json::Kind::object: {
      out.push_back('{');
      bool first = true;
      for (const auto& m : v.obj()) {
        if (m.value.is_undefined()) continue;
        if (!first) out.push_back(',');
        first = false;
        escape_into(out, m.key);
        out.push_back(':');
        stringify_into(out, m.value);
      }
      out.push_back('}');
      return;
    }
  }
}

void append_utf8(std::string& out, std::uint32_t cp) {
  if (cp < 0x80) {
    out.push_back(static_cast<char>(cp));
  } else if (cp < 0x800) {
    out.push_back(static_cast<char>(0xC0U | (cp >> 6U)));
    out.push_back(static_cast<char>(0x80U | (cp & 0x3FU)));
  } else if (cp < 0x10000) {
    out.push_back(static_cast<char>(0xE0U | (cp >> 12U)));
    out.push_back(static_cast<char>(0x80U | ((cp >> 6U) & 0x3FU)));
    out.push_back(static_cast<char>(0x80U | (cp & 0x3FU)));
  } else {
    out.push_back(static_cast<char>(0xF0U | (cp >> 18U)));
    out.push_back(static_cast<char>(0x80U | ((cp >> 12U) & 0x3FU)));
    out.push_back(static_cast<char>(0x80U | ((cp >> 6U) & 0x3FU)));
    out.push_back(static_cast<char>(0x80U | (cp & 0x3FU)));
  }
}

class Parser {
 public:
  explicit Parser(std::string_view s) : s_(s) {}

  std::optional<Json> run() {
    Json v;
    ws();
    if (!value(v, 0)) return std::nullopt;
    ws();
    if (i_ != s_.size()) return std::nullopt;
    return v;
  }

 private:
  static constexpr int kMaxDepth = 512;

  void ws() {
    while (i_ < s_.size() && (s_[i_] == ' ' || s_[i_] == '\t' || s_[i_] == '\n' || s_[i_] == '\r')) ++i_;
  }
  bool lit(std::string_view w) {
    if (s_.substr(i_, w.size()) != w) return false;
    i_ += w.size();
    return true;
  }
  bool hex4(std::uint32_t& out) {
    if (i_ + 4 > s_.size()) return false;
    out = 0;
    for (int k = 0; k < 4; ++k) {
      const char c = s_[i_++];
      out <<= 4U;
      if (c >= '0' && c <= '9') out |= static_cast<std::uint32_t>(c - '0');
      else if (c >= 'a' && c <= 'f') out |= static_cast<std::uint32_t>(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') out |= static_cast<std::uint32_t>(c - 'A' + 10);
      else return false;
    }
    return true;
  }
  bool string(std::string& out) {
    if (i_ >= s_.size() || s_[i_] != '"') return false;
    ++i_;
    while (i_ < s_.size()) {
      const char c = s_[i_++];
      if (c == '"') return true;
      if (static_cast<unsigned char>(c) < 0x20) return false;
      if (c != '\\') {
        out.push_back(c);
        continue;
      }
      if (i_ >= s_.size()) return false;
      const char e = s_[i_++];
      switch (e) {
        case '"': out.push_back('"'); break;
        case '\\': out.push_back('\\'); break;
        case '/': out.push_back('/'); break;
        case 'b': out.push_back('\b'); break;
        case 'f': out.push_back('\f'); break;
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        case 'u': {
          std::uint32_t cp = 0;
          if (!hex4(cp)) return false;
          if (cp >= 0xD800 && cp <= 0xDBFF && i_ + 6 <= s_.size() && s_[i_] == '\\' && s_[i_ + 1] == 'u') {
            const std::size_t save = i_;
            i_ += 2;
            std::uint32_t lo = 0;
            if (hex4(lo) && lo >= 0xDC00 && lo <= 0xDFFF) {
              cp = 0x10000U + ((cp - 0xD800U) << 10U) + (lo - 0xDC00U);
            } else {
              i_ = save;
              cp = 0xFFFD;
            }
          } else if (cp >= 0xD800 && cp <= 0xDFFF) {
            cp = 0xFFFD;
          }
          append_utf8(out, cp);
          break;
        }
        default: return false;
      }
    }
    return false;
  }
  bool number(Json& out) {
    const std::size_t b = i_;
    if (i_ < s_.size() && s_[i_] == '-') ++i_;
    if (i_ >= s_.size()) return false;
    if (s_[i_] == '0') {
      ++i_;
    } else if (s_[i_] >= '1' && s_[i_] <= '9') {
      while (i_ < s_.size() && s_[i_] >= '0' && s_[i_] <= '9') ++i_;
    } else {
      return false;
    }
    if (i_ < s_.size() && s_[i_] == '.') {
      ++i_;
      const std::size_t d = i_;
      while (i_ < s_.size() && s_[i_] >= '0' && s_[i_] <= '9') ++i_;
      if (i_ == d) return false;
    }
    if (i_ < s_.size() && (s_[i_] == 'e' || s_[i_] == 'E')) {
      ++i_;
      if (i_ < s_.size() && (s_[i_] == '+' || s_[i_] == '-')) ++i_;
      const std::size_t d = i_;
      while (i_ < s_.size() && s_[i_] >= '0' && s_[i_] <= '9') ++i_;
      if (i_ == d) return false;
    }
    out = Json::number(motion::js::string_to_number(s_.substr(b, i_ - b)));
    return true;
  }
  bool value(Json& out, int depth) {
    if (depth > kMaxDepth || i_ >= s_.size()) return false;
    const char c = s_[i_];
    if (c == '{') {
      ++i_;
      Json o = Json::object();
      ws();
      if (i_ < s_.size() && s_[i_] == '}') {
        ++i_;
        out = std::move(o);
        return true;
      }
      for (;;) {
        ws();
        std::string key;
        if (!string(key)) return false;
        ws();
        if (i_ >= s_.size() || s_[i_] != ':') return false;
        ++i_;
        ws();
        Json v;
        if (!value(v, depth + 1)) return false;
        o.set(key, std::move(v));
        ws();
        if (i_ < s_.size() && s_[i_] == ',') {
          ++i_;
          continue;
        }
        if (i_ < s_.size() && s_[i_] == '}') {
          ++i_;
          out = std::move(o);
          return true;
        }
        return false;
      }
    }
    if (c == '[') {
      ++i_;
      Json a = Json::array();
      ws();
      if (i_ < s_.size() && s_[i_] == ']') {
        ++i_;
        out = std::move(a);
        return true;
      }
      for (;;) {
        ws();
        Json v;
        if (!value(v, depth + 1)) return false;
        a.arr_mut().push_back(std::move(v));
        ws();
        if (i_ < s_.size() && s_[i_] == ',') {
          ++i_;
          continue;
        }
        if (i_ < s_.size() && s_[i_] == ']') {
          ++i_;
          out = std::move(a);
          return true;
        }
        return false;
      }
    }
    if (c == '"') {
      std::string s;
      if (!string(s)) return false;
      out = Json::string(std::move(s));
      return true;
    }
    if (lit("true")) {
      out = Json::boolean(true);
      return true;
    }
    if (lit("false")) {
      out = Json::boolean(false);
      return true;
    }
    if (lit("null")) {
      out = Json::null();
      return true;
    }
    return number(out);
  }

  std::string_view s_;
  std::size_t i_ = 0;
};

}  // namespace

bool Json::is_finite_number() const noexcept { return is_number() && std::isfinite(std::get<3>(v_)); }

const std::string& Json::str() const noexcept { return is_string() ? std::get<4>(v_) : kEmptyString; }
const Json::Array& Json::arr() const noexcept { return is_array() ? std::get<5>(v_) : kEmptyArray; }
const Json::Object& Json::obj() const noexcept { return is_object() ? std::get<6>(v_) : kEmptyObject; }

Json::Array& Json::arr_mut() {
  if (!is_array()) v_.emplace<5>();
  return std::get<5>(v_);
}
Json::Object& Json::obj_mut() {
  if (!is_object()) v_.emplace<6>();
  return std::get<6>(v_);
}

const Json* Json::find(std::string_view key) const noexcept {
  if (!is_object()) return nullptr;
  for (const auto& m : std::get<6>(v_)) {
    if (m.key == key) return &m.value;
  }
  return nullptr;
}
Json* Json::find_mut(std::string_view key) noexcept {
  if (!is_object()) return nullptr;
  for (auto& m : std::get<6>(v_)) {
    if (m.key == key) return &m.value;
  }
  return nullptr;
}
const Json& Json::at(std::string_view key) const noexcept {
  const Json* j = find(key);
  return j != nullptr ? *j : kUndefined;
}
void Json::set(std::string_view key, Json value) {
  if (Json* j = find_mut(key)) {
    *j = std::move(value);
    return;
  }
  obj_mut().push_back(Member{std::string(key), std::move(value)});
}
void Json::erase(std::string_view key) {
  if (!is_object()) return;
  auto& o = std::get<6>(v_);
  for (auto it = o.begin(); it != o.end(); ++it) {
    if (it->key == key) {
      o.erase(it);
      return;
    }
  }
}
std::optional<double> Json::number_at(std::string_view key) const noexcept {
  const Json* j = find(key);
  if (j == nullptr || !j->is_number()) return std::nullopt;
  return j->num();
}
std::optional<std::string> Json::string_at(std::string_view key) const {
  const Json* j = find(key);
  if (j == nullptr || !j->is_string()) return std::nullopt;
  return j->str();
}
std::optional<bool> Json::bool_at(std::string_view key) const noexcept {
  const Json* j = find(key);
  if (j == nullptr || !j->is_bool()) return std::nullopt;
  return j->b();
}

bool operator==(const Json& a, const Json& b) {
  const bool au = a.is_undefined();
  const bool bu = b.is_undefined();
  if (au || bu) return au && bu;
  if (a.v_.index() != b.v_.index()) return false;
  switch (a.kind()) {
    case Json::Kind::undefined:
    case Json::Kind::null: return true;
    case Json::Kind::boolean: return a.b() == b.b();
    case Json::Kind::number: {
      const double x = a.num();
      const double y = b.num();
      // JSON.stringify(NaN) === JSON.stringify(Infinity) === "null".
      if (!std::isfinite(x) || !std::isfinite(y)) return !std::isfinite(x) && !std::isfinite(y);
      return x == y;
    }
    case Json::Kind::string: return a.str() == b.str();
    case Json::Kind::array: {
      const auto& x = a.arr();
      const auto& y = b.arr();
      if (x.size() != y.size()) return false;
      for (std::size_t i = 0; i < x.size(); ++i) {
        // An undefined element stringifies as null.
        const bool xn = x[i].is_undefined() || x[i].is_null();
        const bool yn = y[i].is_undefined() || y[i].is_null();
        if (xn || yn) {
          if (xn != yn) return false;
          continue;
        }
        if (!(x[i] == y[i])) return false;
      }
      return true;
    }
    case Json::Kind::object: {
      const auto& x = a.obj();
      const auto& y = b.obj();
      std::size_t i = 0;
      std::size_t j = 0;
      for (;;) {
        while (i < x.size() && x[i].value.is_undefined()) ++i;
        while (j < y.size() && y[j].value.is_undefined()) ++j;
        if (i == x.size() || j == y.size()) return i == x.size() && j == y.size();
        if (x[i].key != y[j].key || !(x[i].value == y[j].value)) return false;
        ++i;
        ++j;
      }
    }
  }
  return false;
}

std::string stringify(const Json& v) {
  if (v.is_undefined()) return {};
  std::string out;
  stringify_into(out, v);
  return out;
}

std::optional<Json> parse(std::string_view text) { return Parser(text).run(); }

std::string number_to_string(double x) { return motion::js::number_to_string(x); }

}  // namespace premation::js
