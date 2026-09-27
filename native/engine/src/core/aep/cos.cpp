#include "core/aep/cos.hpp"

#include <cmath>

#include "numconv.hpp"

namespace premation::doc::aep {

namespace {

/// Deeper than any text document; a runaway `<<` cannot outlast it.
constexpr int kMaxDepth = 96;
/// A 100 KB blob of `true`s would stop here long before it mattered.
constexpr std::size_t kMaxNodes = 400'000;

bool is_space(std::uint8_t b) { return b == 0x20 || b == 0x09 || b == 0x0a || b == 0x0d || b == 0x00 || b == 0x0c; }
bool is_digit(std::uint8_t b) { return b >= 0x30 && b <= 0x39; }
bool is_delim(std::uint8_t b) {
  return is_space(b) || b == 0x2f || b == 0x5b || b == 0x5d || b == 0x3c || b == 0x3e || b == 0x28 || b == 0x29;
}

void append_utf8(std::string& out, std::uint32_t cp) {
  if (cp < 0x80) {
    out.push_back(static_cast<char>(cp));
  } else if (cp < 0x800) {
    out.push_back(static_cast<char>(0xC0U | (cp >> 6U)));
    out.push_back(static_cast<char>(0x80U | (cp & 63U)));
  } else if (cp < 0x10000) {
    out.push_back(static_cast<char>(0xE0U | (cp >> 12U)));
    out.push_back(static_cast<char>(0x80U | ((cp >> 6U) & 63U)));
    out.push_back(static_cast<char>(0x80U | (cp & 63U)));
  } else {
    out.push_back(static_cast<char>(0xF0U | (cp >> 18U)));
    out.push_back(static_cast<char>(0x80U | ((cp >> 12U) & 63U)));
    out.push_back(static_cast<char>(0x80U | ((cp >> 6U) & 63U)));
    out.push_back(static_cast<char>(0x80U | (cp & 63U)));
  }
}

/// JavaScript `parseFloat`: the longest StrDecimalLiteral prefix (NaN → nullopt).
std::optional<double> parse_float_prefix(std::string_view s) {
  std::size_t i = 0;
  if (i < s.size() && (s[i] == '+' || s[i] == '-')) ++i;
  if (s.substr(i).starts_with("Infinity")) return std::nullopt;  // not finite → null, as the TS does
  const std::size_t intStart = i;
  while (i < s.size() && s[i] >= '0' && s[i] <= '9') ++i;
  bool digits = i > intStart;
  if (i < s.size() && s[i] == '.') {
    const std::size_t fracStart = ++i;
    while (i < s.size() && s[i] >= '0' && s[i] <= '9') ++i;
    digits = digits || i > fracStart;
  }
  if (!digits) return std::nullopt;
  if (i < s.size() && (s[i] == 'e' || s[i] == 'E')) {
    std::size_t j = i + 1;
    if (j < s.size() && (s[j] == '+' || s[j] == '-')) ++j;
    const std::size_t expStart = j;
    while (j < s.size() && s[j] >= '0' && s[j] <= '9') ++j;
    if (j > expStart) i = j;
  }
  std::string_view lit = s.substr(0, i);
  // numconv's StringToNumber rejects a trailing '.', which parseFloat accepts ("3." = 3).
  std::string buf(lit);
  if (!buf.empty() && buf.back() == '.') buf.pop_back();
  if (!buf.empty() && (buf.front() == '.' || ((buf.front() == '-' || buf.front() == '+') && buf.size() > 1 && buf[1] == '.'))) {
    buf.insert(buf.front() == '.' ? 0 : 1, "0");
  }
  const double v = motion::js::string_to_number(std::string_view(buf));
  if (!std::isfinite(v)) return std::nullopt;
  return v;
}

class Scanner {
 public:
  explicit Scanner(Bytes b) : bytes_(b) {}
  std::size_t pos = 0;

  [[nodiscard]] bool at_end() const { return pos >= bytes_.size(); }
  [[nodiscard]] std::uint8_t cur() const { return bytes_[pos]; }
  [[nodiscard]] int peek(std::size_t k) const { return pos + k < bytes_.size() ? bytes_[pos + k] : -1; }

  void skip_space() {
    while (pos < bytes_.size()) {
      const std::uint8_t b = bytes_[pos];
      if (is_space(b)) {
        ++pos;
        continue;
      }
      if (b == 0x25) {  // `%` comment to end of line
        while (pos < bytes_.size() && bytes_[pos] != 0x0a) ++pos;
        continue;
      }
      return;
    }
  }

  std::string read_string() {
    ++pos;  // '('
    std::vector<std::uint8_t> out;
    int depth = 1;
    while (pos < bytes_.size()) {
      const std::uint8_t b = bytes_[pos];
      if (b == 0x5c) {
        // AE only escapes the delimiters; the next byte passes through verbatim.
        if (pos + 1 < bytes_.size()) out.push_back(bytes_[pos + 1]);
        pos += 2;
        continue;
      }
      if (b == 0x28) ++depth;
      if (b == 0x29) {
        --depth;
        if (depth == 0) {
          ++pos;
          break;
        }
      }
      out.push_back(b);
      ++pos;
    }
    return decode_cos_string(Bytes(out));
  }

  CosValue read_value(int depth) {
    if ((nodes_ += 1) > kMaxNodes || depth > kMaxDepth) return {};
    skip_space();
    if (at_end()) return {};
    const std::uint8_t b = cur();
    if (b == 0x3c && peek(1) == 0x3c) return read_dict(depth, false);
    if (b == 0x5b) return read_array(depth);
    if (b == 0x28) {
      CosValue v;
      v.kind = CosValue::Kind::string;
      v.text = read_string();
      return v;
    }
    if (b == 0x2f) {
      CosValue v;
      v.kind = CosValue::Kind::name;
      v.text = read_name_token();
      return v;
    }
    if (is_digit(b) || b == 0x2d || b == 0x2b || b == 0x2e) {
      const std::string token = read_bare_token();
      CosValue v;
      if (const auto n = parse_float_prefix(token)) {
        v.kind = CosValue::Kind::number;
        v.number = *n;
      }
      return v;
    }
    const std::string word = read_bare_token();
    CosValue v;
    if (word == "true" || word == "false") {
      v.kind = CosValue::Kind::boolean;
      v.boolean = word == "true";
    } else if (word == "null" || word == "nil" || word.empty()) {
      v.kind = CosValue::Kind::null;
    } else {
      v.kind = CosValue::Kind::name;
      v.text = word;
    }
    return v;
  }

  /// A dictionary; `implicit` = no `<<` … `>>` around it (the document itself).
  CosValue read_dict(int depth, bool implicit) {
    if (!implicit) pos += 2;
    CosValue d;
    d.kind = CosValue::Kind::dict;
    for (;;) {
      skip_space();
      if (at_end()) break;
      if (cur() == 0x3e && peek(1) == 0x3e) {
        if (implicit) break;  // a stray close is not ours to consume
        pos += 2;
        break;
      }
      if (cur() != 0x2f) {
        // Not a key where one was due: skip a value and try again.
        const std::size_t before = pos;
        (void)read_value(depth + 1);
        if (pos == before) ++pos;
        continue;
      }
      std::string key = read_name_token();
      CosValue value = read_value(depth + 1);
      bool replaced = false;
      for (std::size_t i = 0; i < d.keys.size(); ++i) {
        if (d.keys[i] == key) {
          d.values[i] = std::move(value);
          replaced = true;
          break;
        }
      }
      if (!replaced) {
        d.keys.push_back(std::move(key));
        d.values.push_back(std::move(value));
      }
    }
    return d;
  }

 private:
  CosValue read_array(int depth) {
    ++pos;  // '['
    CosValue a;
    a.kind = CosValue::Kind::array;
    for (;;) {
      skip_space();
      if (at_end()) break;
      if (cur() == 0x5d) {
        ++pos;
        break;
      }
      const std::size_t before = pos;
      a.items.push_back(read_value(depth + 1));
      if (pos == before) ++pos;  // never spin on a byte we cannot classify
    }
    return a;
  }

  std::string read_name_token() {
    ++pos;  // '/'
    return read_bare_token();
  }

  /// Latin-1 → UTF-8 of the bytes up to the next delimiter.
  std::string read_bare_token() {
    std::string out;
    while (pos < bytes_.size()) {
      const std::uint8_t b = bytes_[pos];
      if (is_delim(b)) break;
      append_utf8(out, b);
      ++pos;
    }
    return out;
  }

  Bytes bytes_;
  std::size_t nodes_ = 0;
};

}  // namespace

const CosValue* CosValue::get(std::string_view key) const noexcept {
  if (kind != Kind::dict) return nullptr;
  for (std::size_t i = 0; i < keys.size(); ++i) {
    if (keys[i] == key) return &values[i];
  }
  return nullptr;
}

std::string decode_cos_string(Bytes bytes) {
  std::string out;
  if (bytes.size() >= 2 && bytes[0] == 0xfe && bytes[1] == 0xff) {
    std::size_t i = 2;
    while (i + 1 < bytes.size()) {
      const std::uint32_t unit = (std::uint32_t{bytes[i]} << 8U) | bytes[i + 1];
      i += 2;
      if (unit >= 0xD800 && unit <= 0xDBFF && i + 1 < bytes.size()) {
        const std::uint32_t lo = (std::uint32_t{bytes[i]} << 8U) | bytes[i + 1];
        if (lo >= 0xDC00 && lo <= 0xDFFF) {
          i += 2;
          append_utf8(out, 0x10000U + ((unit - 0xD800U) << 10U) + (lo - 0xDC00U));
          continue;
        }
      }
      append_utf8(out, unit >= 0xD800 && unit <= 0xDFFF ? 0xFFFDU : unit);
    }
    return out;
  }
  for (const std::uint8_t b : bytes) append_utf8(out, b);
  return out;
}

CosValue parse_cos(Bytes bytes) {
  Scanner sc(bytes);
  sc.skip_space();
  if (!sc.at_end() && sc.cur() == 0x2f) return sc.read_dict(0, true);
  return sc.read_value(0);
}

const CosValue* cos_get(const CosValue* v, std::initializer_list<CosStep> path) noexcept {
  const CosValue* cur = v;
  for (const CosStep& step : path) {
    if (cur == nullptr) return nullptr;
    if (const auto* index = std::get_if<std::size_t>(&step)) {
      if (cur->kind != CosValue::Kind::array || *index >= cur->items.size()) return nullptr;
      cur = &cur->items[*index];
    } else {
      cur = cur->get(std::get<std::string_view>(step));
    }
  }
  return cur;
}

std::optional<std::string> cos_string(const CosValue* v) {
  if (v == nullptr || v->kind != CosValue::Kind::string) return std::nullopt;
  return v->text;
}

std::optional<double> cos_number(const CosValue* v) noexcept {
  if (v == nullptr || v->kind != CosValue::Kind::number) return std::nullopt;
  return v->number;
}

const std::vector<CosValue>* cos_array(const CosValue* v) noexcept {
  if (v == nullptr || v->kind != CosValue::Kind::array) return nullptr;
  return &v->items;
}

void cos_walk(const CosValue* v, const std::function<bool(const CosValue&)>& visit) {
  if (v == nullptr) return;
  // Iterative pre-order (a hostile blob is depth-capped at parse, but a stack keeps this bounded anyway).
  std::vector<const CosValue*> stack{v};
  while (!stack.empty()) {
    const CosValue* n = stack.back();
    stack.pop_back();
    if (!visit(*n)) return;
    if (n->kind == CosValue::Kind::dict) {
      for (auto it = n->values.rbegin(); it != n->values.rend(); ++it) stack.push_back(&*it);
    } else if (n->kind == CosValue::Kind::array) {
      for (auto it = n->items.rbegin(); it != n->items.rend(); ++it) stack.push_back(&*it);
    }
  }
}

}  // namespace premation::doc::aep
