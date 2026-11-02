// AE's data footage in expressions: footage("name") on a .json / .csv / .tsv
// item (Host::footage_text) — `sourceText`, `sourceData` (parsed on first
// read), `dataValue(path)` and `dataKeyCount(path)`.
//
//   JSON  sourceData is the document; dataValue([a, b, …]) walks it (a number
//         indexes an array, or an object's n-th value; a string is a key).
//   CSV / TSV  the first row is the header; sourceData is one object per data
//         row keyed by the header, dataValue([column, row]) one cell (row 0 =
//         the first data row), dataKeyCount([column]) the data rows.
//
// A cell or value that reads entirely as a number is a number. Malformed JSON
// is an expression error that says where; the file is the user's to fix.

#include <cmath>
#include <cstdlib>
#include <string>
#include <string_view>

#include "interp.hpp"
#include "ops.hpp"

namespace motion::expr::detail {
namespace {

constexpr int kMaxDepth = 256;

enum class DataKind : std::uint8_t { kJson = 0, kCsv = 1, kTsv = 2 };

DataKind kind_of(std::u16string_view name) {
  const auto ends = [&](std::u16string_view ext) {
    if (name.size() < ext.size()) return false;
    for (std::size_t i = 0; i < ext.size(); ++i) {
      char16_t c = name[name.size() - ext.size() + i];
      if (c >= u'A' && c <= u'Z') c = static_cast<char16_t>(c - u'A' + u'a');
      if (c != ext[i]) return false;
    }
    return true;
  };
  if (ends(u".csv")) return DataKind::kCsv;
  if (ends(u".tsv")) return DataKind::kTsv;
  return DataKind::kJson;
}

/// A cell as AE reads it: a number when the whole cell is one, else its text.
Value cell_value(Interp& in, std::string_view cell) {
  std::string s(cell);
  while (!s.empty() && (s.back() == ' ' || s.back() == '\t' || s.back() == '\r')) s.pop_back();
  std::size_t b = 0;
  while (b < s.size() && (s[b] == ' ' || s[b] == '\t')) ++b;
  const std::string trimmed = s.substr(b);
  if (!trimmed.empty()) {
    char* end = nullptr;
    const double v = std::strtod(trimmed.c_str(), &end);
    if (end != nullptr && static_cast<std::size_t>(end - trimmed.c_str()) == trimmed.size() && std::isfinite(v)) return Value::number(v);
  }
  return in.str(utf8_to_utf16(cell));
}

class JsonReader {
 public:
  JsonReader(Interp& in, std::string_view text) : in_(&in), s_(text) {}

  Value document() {
    Value v = value(0);
    skip_ws();
    if (i_ != s_.size()) fail("unexpected text after the document");
    return v;
  }

 private:
  [[noreturn]] void fail(std::string_view what) const {
    std::size_t line = 1;
    std::size_t col = 1;
    for (std::size_t k = 0; k < i_ && k < s_.size(); ++k) {
      if (s_[k] == '\n') {
        ++line;
        col = 1;
      } else {
        ++col;
      }
    }
    throw_eval(u"sourceData: invalid JSON (" + utf8_to_utf16(what) + u") at line " + utf8_to_utf16(std::to_string(line)) +
               u", column " + utf8_to_utf16(std::to_string(col)));
  }
  void skip_ws() {
    while (i_ < s_.size() && (s_[i_] == ' ' || s_[i_] == '\t' || s_[i_] == '\n' || s_[i_] == '\r')) ++i_;
  }
  bool eat(char c) {
    skip_ws();
    if (i_ < s_.size() && s_[i_] == c) {
      ++i_;
      return true;
    }
    return false;
  }
  Value value(int depth) {
    if (depth > kMaxDepth) fail("nested too deeply");
    skip_ws();
    if (i_ >= s_.size()) fail("unexpected end");
    const char c = s_[i_];
    if (c == '{') return object(depth);
    if (c == '[') return array(depth);
    if (c == '"') return in_->str(string());
    if (s_.compare(i_, 4, "true") == 0) {
      i_ += 4;
      return Value::boolean(true);
    }
    if (s_.compare(i_, 5, "false") == 0) {
      i_ += 5;
      return Value::boolean(false);
    }
    if (s_.compare(i_, 4, "null") == 0) {
      i_ += 4;
      return Value::null();
    }
    return number();
  }
  Value number() {
    const std::size_t start = i_;
    if (i_ < s_.size() && (s_[i_] == '-' || s_[i_] == '+')) ++i_;
    while (i_ < s_.size() && ((s_[i_] >= '0' && s_[i_] <= '9') || s_[i_] == '.' || s_[i_] == 'e' || s_[i_] == 'E' ||
                              s_[i_] == '-' || s_[i_] == '+')) {
      ++i_;
    }
    const std::string num(s_.substr(start, i_ - start));
    char* end = nullptr;
    const double v = num.empty() ? 0 : std::strtod(num.c_str(), &end);
    if (num.empty() || end == nullptr || static_cast<std::size_t>(end - num.c_str()) != num.size()) {
      i_ = start;
      fail("a value was expected");
    }
    return Value::number(v);
  }
  Str string() {
    ++i_;  // the opening quote
    std::string out;
    while (true) {
      if (i_ >= s_.size()) fail("unterminated string");
      const char c = s_[i_++];
      if (c == '"') break;
      if (c != '\\') {
        out.push_back(c);
        continue;
      }
      if (i_ >= s_.size()) fail("unterminated escape");
      const char e = s_[i_++];
      switch (e) {
        case 'n': out.push_back('\n'); break;
        case 't': out.push_back('\t'); break;
        case 'r': out.push_back('\r'); break;
        case 'b': out.push_back('\b'); break;
        case 'f': out.push_back('\f'); break;
        case 'u': {
          if (i_ + 4 > s_.size()) fail("short \\u escape");
          const unsigned long cp = std::strtoul(std::string(s_.substr(i_, 4)).c_str(), nullptr, 16);
          i_ += 4;
          // Encoded back to UTF-8 so the whole string converts once (surrogates pass as-is).
          if (cp < 0x80) {
            out.push_back(static_cast<char>(cp));
          } else if (cp < 0x800) {
            out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
          } else {
            out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
          }
          break;
        }
        default: out.push_back(e);  // \" \\ \/
      }
    }
    return utf8_to_utf16(out);
  }
  Value array(int depth) {
    ++i_;
    std::vector<Value> items;
    if (eat(']')) return in_->array(std::move(items));
    while (true) {
      items.push_back(value(depth + 1));
      if (eat(',')) continue;
      if (eat(']')) break;
      fail("',' or ']' was expected");
    }
    return in_->array(std::move(items));
  }
  Value object(int depth) {
    ++i_;
    Obj* o = in_->arena().obj(ObjKind::kPlain);
    if (eat('}')) return Value::object(o);
    while (true) {
      skip_ws();
      if (i_ >= s_.size() || s_[i_] != '"') fail("a key was expected");
      Str key = string();
      if (!eat(':')) fail("':' was expected");
      const Value v = value(depth + 1);
      const KeyId kid = key_of(key);
      const Str* name = kid == KeyId::kUnknown ? in_->arena().str(std::move(key)) : nullptr;
      bool found = false;
      for (Prop& p : o->props) {
        if (p.key == kid && (name == nullptr || (p.name != nullptr && *p.name == *name))) {
          p.value = v;  // a repeated key: the last one wins, as JSON.parse
          found = true;
          break;
        }
      }
      if (!found) o->props.push_back({.key = kid, .value = v, .lazy = Lazy::kNone, .name = name});
      if (eat(',')) continue;
      if (eat('}')) break;
      fail("',' or '}' was expected");
    }
    return Value::object(o);
  }

  Interp* in_;  // never null: the reader lives inside one Interp call
  std::string_view s_;
  std::size_t i_ = 0;
};

/// RFC 4180-ish rows: quoted cells with "" escapes, the delimiter, CR/LF ends.
std::vector<std::vector<std::string>> rows_of(std::string_view s, char delim) {
  std::vector<std::vector<std::string>> rows;
  std::vector<std::string> row;
  std::string cell;
  bool quoted = false;
  bool any = false;
  for (std::size_t i = 0; i < s.size(); ++i) {
    const char c = s[i];
    if (quoted) {
      if (c == '"') {
        if (i + 1 < s.size() && s[i + 1] == '"') {
          cell.push_back('"');
          ++i;
        } else {
          quoted = false;
        }
      } else {
        cell.push_back(c);
      }
      continue;
    }
    if (c == '"' && cell.empty()) {
      quoted = true;
      any = true;
    } else if (c == delim) {
      row.push_back(std::move(cell));
      cell.clear();
      any = true;
    } else if (c == '\n' || c == '\r') {
      if (c == '\r' && i + 1 < s.size() && s[i + 1] == '\n') ++i;
      if (any || !cell.empty()) {
        row.push_back(std::move(cell));
        rows.push_back(std::move(row));
      }
      row.clear();
      cell.clear();
      any = false;
    } else {
      cell.push_back(c);
      any = true;
    }
  }
  if (any || !cell.empty()) {
    row.push_back(std::move(cell));
    rows.push_back(std::move(row));
  }
  // A UTF-8 byte-order mark is not part of the first header.
  if (!rows.empty() && !rows[0].empty() && rows[0][0].starts_with("\xEF\xBB\xBF")) rows[0][0].erase(0, 3);
  return rows;
}

}  // namespace

Value Interp::footage(const Value& name_arg) {
  const Str name = to_string(name_arg);
  std::optional<Host::FootageText> f;
  if (ctx_.host != nullptr) f = ctx_.host->footage_text(name);
  if (!f) throw_eval(u"There is no data footage named “" + name + u"” (import a .json, .csv or .tsv file).");
  Obj* o = arena_.obj(ObjKind::kPlain);
  o->aux = static_cast<std::uint8_t>(kind_of(f->name));
  o->arg = str(utf8_to_utf16(f->text));
  const Value self = Value::object(o);
  o->props = {
      {.key = KeyId::k_name, .value = str(f->name)},
      {.key = KeyId::k_sourceText, .value = o->arg},
      {.key = KeyId::k_sourceData, .value = {}, .lazy = Lazy::kFootageSourceData},
      {.key = KeyId::k_dataValue, .value = bound_fn(Fn::kFootageDataValue, self)},
      {.key = KeyId::k_dataKeyCount, .value = bound_fn(Fn::kFootageDataKeyCount, self)},
  };
  return self;
}

/// The footage's table (CSV / TSV) as rows of cell values, parsed once per evaluation.
Value Interp::footage_table(Obj& f) {
  if (f.memo != nullptr) return Value::object(f.memo);
  const std::string text = utf16_to_utf8(*f.arg.s);
  const char delim = static_cast<DataKind>(f.aux) == DataKind::kTsv ? '\t' : ',';
  std::vector<Value> rows;
  for (const auto& r : rows_of(text, delim)) {
    std::vector<Value> cells;
    cells.reserve(r.size());
    for (const std::string& c : r) cells.push_back(cell_value(*this, c));
    rows.push_back(array(std::move(cells)));
  }
  const Value table = array(std::move(rows));
  f.memo = table.o;
  return table;
}

Value Interp::footage_source_data(Obj& f) {
  if (static_cast<DataKind>(f.aux) == DataKind::kJson) {
    return JsonReader(*this, utf16_to_utf8(*f.arg.s)).document();
  }
  // CSV / TSV: one object per data row, keyed by the header.
  const Value table = footage_table(f);
  const auto& rows = table.o->elems;
  std::vector<Value> out;
  if (rows.empty()) return array(std::move(out));
  const auto& header = rows.front().o->elems;
  for (std::size_t r = 1; r < rows.size(); ++r) {
    Obj* o = arena_.obj(ObjKind::kPlain);
    const auto& cells = rows[r].o->elems;
    for (std::size_t c = 0; c < header.size(); ++c) {
      Str key = to_string(header[c]);
      const KeyId kid = key_of(key);
      const Str* name = kid == KeyId::kUnknown ? arena_.str(std::move(key)) : nullptr;
      o->props.push_back({.key = kid, .value = c < cells.size() ? cells[c] : Value::undefined(), .lazy = Lazy::kNone, .name = name});
    }
    out.push_back(Value::object(o));
  }
  return array(std::move(out));
}

namespace {

/// `path` as a list of segments: an array's elements, or the one value.
std::vector<Value> segments_of(const Value& path) {
  if (path.tag == Tag::kObject && path.o->kind == ObjKind::kArray) return path.o->elems;
  if (path.is_undefined()) return {};
  return {path};
}

}  // namespace

Value Interp::footage_data_value(Obj& f, const Value& path) {
  const std::vector<Value> segs = segments_of(path);
  if (static_cast<DataKind>(f.aux) != DataKind::kJson) {
    if (segs.size() < 2) throw_eval(u"dataValue([column, row]) takes a column and a row.");
    const auto& rows = footage_table(f).o->elems;
    const double c = to_number(segs[0]);
    const double r = to_number(segs[1]);
    if (!(c >= 0) || !(r >= 0) || static_cast<std::size_t>(r) + 1 >= rows.size()) return Value::undefined();
    const auto& cells = rows[static_cast<std::size_t>(r) + 1].o->elems;
    return static_cast<std::size_t>(c) < cells.size() ? cells[static_cast<std::size_t>(c)] : Value::undefined();
  }
  Value cur = read_member(Value::object(&f), Value{}, KeyId::k_sourceData);
  for (const Value& s : segs) {
    if (cur.tag != Tag::kObject) return Value::undefined();
    Obj& o = *cur.o;
    if (s.tag == Tag::kNumber) {
      const double k = s.n;
      if (!(k >= 0)) return Value::undefined();
      const auto i = static_cast<std::size_t>(k);
      if (o.kind == ObjKind::kArray) {
        cur = i < o.elems.size() ? o.elems[i] : Value::undefined();
      } else {
        cur = i < o.props.size() ? o.props[i].value : Value::undefined();
      }
    } else {
      const Str key = to_string(s);
      cur = read_member(cur, str(key), key_of(key));
    }
  }
  return cur;
}

Value Interp::footage_data_key_count(Obj& f, const Value& path) {
  if (static_cast<DataKind>(f.aux) != DataKind::kJson) {
    const auto& rows = footage_table(f).o->elems;
    return Value::number(rows.empty() ? 0 : static_cast<double>(rows.size() - 1));
  }
  Value cur = footage_data_value(f, path);
  if (cur.tag != Tag::kObject) return Value::number(0);
  return Value::number(static_cast<double>(cur.o->kind == ObjKind::kArray ? cur.o->elems.size() : cur.o->props.size()));
}

}  // namespace motion::expr::detail
