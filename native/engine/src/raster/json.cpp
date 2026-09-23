#include "json.hpp"

#include <charconv>
#include <system_error>

namespace premation::raster::json {

const Value& null_value() noexcept {
  static const Value kNull;
  return kNull;
}

bool Value::truthy() const noexcept {
  switch (type_) {
    case Type::boolean:
    case Type::number: return num_ != 0.0 && num_ == num_;  // NaN is falsy
    case Type::string: return !str_.empty();
    case Type::array:
    case Type::object: return true;
    case Type::null: return false;
  }
  return false;
}

const Value& Value::operator[](std::size_t i) const noexcept {
  return type_ == Type::array && i < items_.size() ? items_[i] : null_value();
}

const Value& Value::operator[](std::string_view key) const noexcept {
  if (type_ != Type::object) return null_value();
  for (std::size_t i = 0; i < keys_.size(); ++i) {
    if (keys_[i] == key) return items_[i];
  }
  return null_value();
}

bool Value::has(std::string_view key) const noexcept {
  if (type_ != Type::object) return false;
  for (const auto& k : keys_) {
    if (k == key) return true;
  }
  return false;
}

namespace {

class Parser {
 public:
  explicit Parser(std::string_view t) : t_(t) {}

  bool document(Value& out, std::string& err) {
    ws();
    if (!value(out, 0)) {
      err = err_.empty() ? "invalid JSON" : err_;
      err += " at byte " + std::to_string(i_);
      return false;
    }
    ws();
    if (i_ != t_.size()) {
      err = "trailing characters at byte " + std::to_string(i_);
      return false;
    }
    return true;
  }

 private:
  static constexpr int kMaxDepth = 512;
  std::string_view t_;
  std::size_t i_ = 0;
  std::string err_;

  void ws() {
    while (i_ < t_.size() && (t_[i_] == ' ' || t_[i_] == '\n' || t_[i_] == '\r' || t_[i_] == '\t')) ++i_;
  }
  bool lit(std::string_view s) {
    if (t_.substr(i_, s.size()) != s) return false;
    i_ += s.size();
    return true;
  }

  bool value(Value& out, int depth) {
    if (depth > kMaxDepth) { err_ = "nested too deeply"; return false; }
    if (i_ >= t_.size()) { err_ = "unexpected end"; return false; }
    const char c = t_[i_];
    if (c == '{') return object(out, depth);
    if (c == '[') return array(out, depth);
    if (c == '"') {
      std::string s;
      if (!string(s)) return false;
      out = Value::make_string(std::move(s));
      return true;
    }
    if (lit("true")) { out = Value::make_bool(true); return true; }
    if (lit("false")) { out = Value::make_bool(false); return true; }
    if (lit("null")) { out = Value(); return true; }
    return number(out);
  }

  bool number(Value& out) {
    const std::size_t start = i_;
    if (i_ < t_.size() && t_[i_] == '-') ++i_;
    while (i_ < t_.size()) {
      const char c = t_[i_];
      if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') ++i_;
      else break;
    }
    double d = 0.0;
    const char* b = t_.data() + start;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    const char* e = t_.data() + i_;     // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    const auto r = std::from_chars(b, e, d);
    if (r.ec != std::errc() || r.ptr != e || start == i_) { err_ = "bad number"; return false; }
    out = Value::make_number(d);
    return true;
  }

  static void utf8(std::string& s, std::uint32_t cp) {
    if (cp < 0x80) {
      s.push_back(static_cast<char>(cp));
    } else if (cp < 0x800) {
      s.push_back(static_cast<char>(0xC0U | (cp >> 6U)));
      s.push_back(static_cast<char>(0x80U | (cp & 0x3FU)));
    } else if (cp < 0x10000) {
      s.push_back(static_cast<char>(0xE0U | (cp >> 12U)));
      s.push_back(static_cast<char>(0x80U | ((cp >> 6U) & 0x3FU)));
      s.push_back(static_cast<char>(0x80U | (cp & 0x3FU)));
    } else {
      s.push_back(static_cast<char>(0xF0U | (cp >> 18U)));
      s.push_back(static_cast<char>(0x80U | ((cp >> 12U) & 0x3FU)));
      s.push_back(static_cast<char>(0x80U | ((cp >> 6U) & 0x3FU)));
      s.push_back(static_cast<char>(0x80U | (cp & 0x3FU)));
    }
  }

  bool hex4(std::uint32_t& v) {
    if (i_ + 4 > t_.size()) return false;
    v = 0;
    for (int k = 0; k < 4; ++k) {
      const char c = t_[i_++];
      v <<= 4U;
      if (c >= '0' && c <= '9') v |= static_cast<std::uint32_t>(c - '0');
      else if (c >= 'a' && c <= 'f') v |= static_cast<std::uint32_t>(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') v |= static_cast<std::uint32_t>(c - 'A' + 10);
      else return false;
    }
    return true;
  }

  bool string(std::string& s) {
    ++i_;  // opening quote
    while (i_ < t_.size()) {
      const char c = t_[i_++];
      if (c == '"') return true;
      if (c != '\\') { s.push_back(c); continue; }
      if (i_ >= t_.size()) break;
      const char e = t_[i_++];
      switch (e) {
        case '"': s.push_back('"'); break;
        case '\\': s.push_back('\\'); break;
        case '/': s.push_back('/'); break;
        case 'b': s.push_back('\b'); break;
        case 'f': s.push_back('\f'); break;
        case 'n': s.push_back('\n'); break;
        case 'r': s.push_back('\r'); break;
        case 't': s.push_back('\t'); break;
        case 'u': {
          std::uint32_t cp = 0;
          if (!hex4(cp)) { err_ = "bad \\u escape"; return false; }
          if (cp >= 0xD800 && cp < 0xDC00 && i_ + 6 <= t_.size() && t_[i_] == '\\' && t_[i_ + 1] == 'u') {
            i_ += 2;
            std::uint32_t lo = 0;
            if (!hex4(lo)) { err_ = "bad \\u escape"; return false; }
            if (lo >= 0xDC00 && lo < 0xE000) cp = 0x10000 + ((cp - 0xD800) << 10U) + (lo - 0xDC00);
            else { utf8(s, 0xFFFD); cp = lo; }
          }
          utf8(s, cp);
          break;
        }
        default: err_ = "bad escape"; return false;
      }
    }
    err_ = "unterminated string";
    return false;
  }

  bool array(Value& out, int depth) {
    ++i_;
    out = Value::make_array();
    ws();
    if (i_ < t_.size() && t_[i_] == ']') { ++i_; return true; }
    for (;;) {
      Value v;
      ws();
      if (!value(v, depth + 1)) return false;
      out.push(std::move(v));
      ws();
      if (i_ < t_.size() && t_[i_] == ',') { ++i_; continue; }
      if (i_ < t_.size() && t_[i_] == ']') { ++i_; return true; }
      err_ = "expected , or ]";
      return false;
    }
  }

  bool object(Value& out, int depth) {
    ++i_;
    out = Value::make_object();
    ws();
    if (i_ < t_.size() && t_[i_] == '}') { ++i_; return true; }
    for (;;) {
      ws();
      if (i_ >= t_.size() || t_[i_] != '"') { err_ = "expected key"; return false; }
      std::string k;
      if (!string(k)) return false;
      ws();
      if (i_ >= t_.size() || t_[i_] != ':') { err_ = "expected :"; return false; }
      ++i_;
      ws();
      Value v;
      if (!value(v, depth + 1)) return false;
      out.set(std::move(k), std::move(v));
      ws();
      if (i_ < t_.size() && t_[i_] == ',') { ++i_; continue; }
      if (i_ < t_.size() && t_[i_] == '}') { ++i_; return true; }
      err_ = "expected , or }";
      return false;
    }
  }
};

}  // namespace

bool parse(std::string_view text, Value& out, std::string& error) {
  Parser p(text);
  return p.document(out, error);
}

}  // namespace premation::raster::json
