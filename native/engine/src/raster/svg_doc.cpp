// SVG documents for the C++ rasterizer (D2w) — see svg_doc.hpp. Every rule
// here names the Blink behaviour it follows; the TS engine hands SVG to
// Chromium as an <img>, so Blink is the reference.

#include "svg_doc.hpp"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <map>
#include <numbers>
#include <tuple>

namespace premation::raster::svg {
namespace {

constexpr std::string_view kSvgNs = "http://www.w3.org/2000/svg";
constexpr std::string_view kXlinkNs = "http://www.w3.org/1999/xlink";

bool is_ws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f'; }
bool is_digit(char c) { return c >= '0' && c <= '9'; }
bool is_name_start(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == ':' || static_cast<unsigned char>(c) >= 0x80;
}
bool is_name_char(char c) { return is_name_start(c) || is_digit(c) || c == '-' || c == '.'; }

std::string_view trim(std::string_view s) {
  while (!s.empty() && is_ws(s.front())) s.remove_prefix(1);
  while (!s.empty() && is_ws(s.back())) s.remove_suffix(1);
  return s;
}

std::string lower(std::string_view s) {
  std::string o(s);
  for (char& c : o) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return o;
}

void append_utf8(std::string& out, char32_t cp) {
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

/// Decode entity / character references in attribute values and text.
bool decode_entities(std::string_view in, std::string& out, std::string& error) {
  out.clear();
  out.reserve(in.size());
  for (std::size_t i = 0; i < in.size(); ++i) {
    if (in[i] != '&') {
      out.push_back(in[i]);
      continue;
    }
    const std::size_t semi = in.find(';', i);
    if (semi == std::string_view::npos) {
      error = "unterminated entity reference";
      return false;
    }
    const std::string_view ent = in.substr(i + 1, semi - i - 1);
    if (ent == "lt") out.push_back('<');
    else if (ent == "gt") out.push_back('>');
    else if (ent == "amp") out.push_back('&');
    else if (ent == "apos") out.push_back('\'');
    else if (ent == "quot") out.push_back('"');
    else if (!ent.empty() && ent[0] == '#') {
      std::uint32_t cp = 0;
      std::from_chars_result r{};
      if (ent.size() > 1 && (ent[1] == 'x' || ent[1] == 'X')) {
        r = std::from_chars(ent.data() + 2, ent.data() + ent.size(), cp, 16);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      } else {
        r = std::from_chars(ent.data() + 1, ent.data() + ent.size(), cp, 10);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      }
      if (r.ec != std::errc() || r.ptr != ent.data() + ent.size() || cp == 0 || cp > 0x10FFFF) {  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
        error = "bad character reference";
        return false;
      }
      append_utf8(out, static_cast<char32_t>(cp));
    } else {
      // libxml2 (Blink's XML parser) rejects an undeclared entity in a standalone document.
      error = "undefined entity &" + std::string(ent) + ";";
      return false;
    }
    i = semi;
  }
  return true;
}

struct NsScope {
  std::map<std::string, std::string, std::less<>> prefixes;  // "" = default namespace
};

std::string resolve_ns(const std::vector<NsScope>& scopes, std::string_view prefix) {
  for (auto it = scopes.rbegin(); it != scopes.rend(); ++it) {
    const auto f = it->prefixes.find(prefix);
    if (f != it->prefixes.end()) return f->second;
  }
  if (prefix == "xml") return "http://www.w3.org/XML/1998/namespace";
  return {};
}

}  // namespace

// ── Node / Document ──────────────────────────────────────────────────────────

const std::string* Node::attr(std::string_view n) const {
  for (const auto& [k, v] : attrs) {
    if (k == n) return &v;
  }
  return nullptr;
}

void Node::set_attr(std::string_view n, std::string value) {
  for (auto& [k, v] : attrs) {
    if (k == n) {
      v = std::move(value);
      return;
    }
  }
  attrs.emplace_back(std::string(n), std::move(value));
}

const std::string* Document::href(int node) const {
  if (node < 0 || static_cast<std::size_t>(node) >= nodes.size()) return nullptr;
  const Node& n = nodes[static_cast<std::size_t>(node)];
  if (const std::string* h = n.attr("href")) return h;
  return n.attr("xlink:href");
}

int Document::by_id(std::string_view id) const {
  if (id.empty()) return -1;
  for (std::size_t i = 0; i < nodes.size(); ++i) {
    const Node& n = nodes[i];
    if (!n.element || n.shadow) continue;
    if (const std::string* v = n.attr("id"); v != nullptr && *v == id) return static_cast<int>(i);
  }
  return -1;
}

// ── XML ──────────────────────────────────────────────────────────────────────

bool parse_xml(std::string_view src, Document& out, std::string& error) {
  out = Document{};
  std::size_t i = 0;
  if (src.starts_with("\xEF\xBB\xBF")) i = 3;
  std::vector<int> open;
  std::vector<NsScope> scopes;
  std::vector<std::string> qnames;  // qualified tag names of the open elements
  const auto add_text = [&](std::string_view raw, bool decode) -> bool {
    if (open.empty()) {
      if (!trim(raw).empty()) {
        error = "text outside the root element";
        return false;
      }
      return true;
    }
    std::string t;
    if (decode) {
      if (!decode_entities(raw, t, error)) return false;
    } else {
      t = std::string(raw);
    }
    if (t.empty()) return true;
    Node n;
    n.element = false;
    n.text = std::move(t);
    n.parent = open.back();
    out.nodes.push_back(std::move(n));
    out.nodes[static_cast<std::size_t>(open.back())].children.push_back(static_cast<int>(out.nodes.size() - 1));
    return true;
  };
  bool sawRoot = false;
  while (i < src.size()) {
    if (src[i] != '<') {
      const std::size_t lt = src.find('<', i);
      const std::size_t end = lt == std::string_view::npos ? src.size() : lt;
      if (!add_text(src.substr(i, end - i), true)) return false;
      i = end;
      continue;
    }
    if (src.substr(i).starts_with("<!--")) {
      const std::size_t e = src.find("-->", i + 4);
      if (e == std::string_view::npos) {
        error = "unterminated comment";
        return false;
      }
      i = e + 3;
      continue;
    }
    if (src.substr(i).starts_with("<![CDATA[")) {
      const std::size_t e = src.find("]]>", i + 9);
      if (e == std::string_view::npos) {
        error = "unterminated CDATA section";
        return false;
      }
      if (!add_text(src.substr(i + 9, e - i - 9), false)) return false;
      i = e + 3;
      continue;
    }
    if (src.substr(i).starts_with("<?")) {
      const std::size_t e = src.find("?>", i + 2);
      if (e == std::string_view::npos) {
        error = "unterminated processing instruction";
        return false;
      }
      i = e + 2;
      continue;
    }
    if (src.substr(i).starts_with("<!")) {
      // DOCTYPE (with an optional internal subset).
      int depth = 0;
      std::size_t j = i + 2;
      for (; j < src.size(); ++j) {
        if (src[j] == '[') ++depth;
        else if (src[j] == ']') --depth;
        else if (src[j] == '>' && depth <= 0) break;
      }
      if (j >= src.size()) {
        error = "unterminated declaration";
        return false;
      }
      i = j + 1;
      continue;
    }
    if (i + 1 < src.size() && src[i + 1] == '/') {
      std::size_t j = i + 2;
      while (j < src.size() && is_name_char(src[j])) ++j;
      const std::string_view name = src.substr(i + 2, j - i - 2);
      while (j < src.size() && is_ws(src[j])) ++j;
      if (j >= src.size() || src[j] != '>') {
        error = "malformed end tag";
        return false;
      }
      if (open.empty() || qnames.back() != name) {
        error = "mismatched end tag </" + std::string(name) + ">";
        return false;
      }
      open.pop_back();
      qnames.pop_back();
      scopes.pop_back();
      i = j + 1;
      continue;
    }
    // Start tag.
    std::size_t j = i + 1;
    if (j >= src.size() || !is_name_start(src[j])) {
      error = "malformed start tag";
      return false;
    }
    while (j < src.size() && is_name_char(src[j])) ++j;
    const std::string qname(src.substr(i + 1, j - i - 1));
    std::vector<std::pair<std::string, std::string>> rawAttrs;
    bool selfClose = false;
    for (;;) {
      while (j < src.size() && is_ws(src[j])) ++j;
      if (j >= src.size()) {
        error = "unterminated start tag";
        return false;
      }
      if (src[j] == '>') {
        ++j;
        break;
      }
      if (src[j] == '/' && j + 1 < src.size() && src[j + 1] == '>') {
        selfClose = true;
        j += 2;
        break;
      }
      if (!is_name_start(src[j])) {
        error = "malformed attribute";
        return false;
      }
      const std::size_t ns = j;
      while (j < src.size() && is_name_char(src[j])) ++j;
      std::string an(src.substr(ns, j - ns));
      while (j < src.size() && is_ws(src[j])) ++j;
      if (j >= src.size() || src[j] != '=') {
        error = "attribute without a value";
        return false;
      }
      ++j;
      while (j < src.size() && is_ws(src[j])) ++j;
      if (j >= src.size() || (src[j] != '"' && src[j] != '\'')) {
        error = "unquoted attribute value";
        return false;
      }
      const char q = src[j];
      const std::size_t vs = j + 1;
      const std::size_t ve = src.find(q, vs);
      if (ve == std::string_view::npos) {
        error = "unterminated attribute value";
        return false;
      }
      std::string v;
      if (!decode_entities(src.substr(vs, ve - vs), v, error)) return false;
      // Attribute-value normalisation: literal whitespace characters become spaces.
      for (char& c : v) {
        if (c == '\t' || c == '\n' || c == '\r') c = ' ';
      }
      for (const auto& [k, _] : rawAttrs) {
        if (k == an) {
          error = "duplicate attribute " + an;
          return false;
        }
      }
      rawAttrs.emplace_back(std::move(an), std::move(v));
      j = ve + 1;
    }
    if (open.empty() && sawRoot) {
      error = "more than one root element";
      return false;
    }
    NsScope scope;
    for (const auto& [k, v] : rawAttrs) {
      if (k == "xmlns") scope.prefixes[""] = v;
      else if (k.starts_with("xmlns:")) scope.prefixes[k.substr(6)] = v;
    }
    scopes.push_back(std::move(scope));
    Node n;
    const std::size_t colon = qname.find(':');
    const std::string prefix = colon == std::string::npos ? "" : qname.substr(0, colon);
    n.name = colon == std::string::npos ? qname : qname.substr(colon + 1);
    n.svgNs = resolve_ns(scopes, prefix) == kSvgNs;
    for (auto& [k, v] : rawAttrs) {
      if (k == "xmlns" || k.starts_with("xmlns:")) continue;
      const std::size_t c = k.find(':');
      if (c == std::string::npos) {
        n.attrs.emplace_back(std::move(k), std::move(v));
        continue;
      }
      const std::string uri = resolve_ns(scopes, std::string_view(k).substr(0, c));
      if (uri.empty()) {
        error = "unbound namespace prefix in " + k;
        return false;
      }
      if (uri == kXlinkNs) n.attrs.emplace_back("xlink:" + k.substr(c + 1), std::move(v));
      else if (k.starts_with("xml:")) n.attrs.emplace_back(std::move(k), std::move(v));
      else n.attrs.emplace_back("{" + uri + "}" + k.substr(c + 1), std::move(v));
    }
    if (!prefix.empty() && resolve_ns(scopes, prefix).empty()) {
      error = "unbound namespace prefix " + prefix;
      return false;
    }
    n.parent = open.empty() ? -1 : open.back();
    out.nodes.push_back(std::move(n));
    const int idx = static_cast<int>(out.nodes.size() - 1);
    if (open.empty()) {
      out.root = idx;
      sawRoot = true;
    } else {
      out.nodes[static_cast<std::size_t>(open.back())].children.push_back(idx);
    }
    if (selfClose) {
      scopes.pop_back();
    } else {
      open.push_back(idx);
      qnames.push_back(qname);
    }
    i = j;
  }
  if (!open.empty()) {
    error = "unclosed element <" + qnames.back() + ">";
    return false;
  }
  if (out.root < 0) {
    error = "no root element";
    return false;
  }
  return true;
}

namespace {

int clone_subtree(Document& doc, int src, int parent) {
  Node copy = doc.nodes[static_cast<std::size_t>(src)];
  copy.parent = parent;
  copy.shadow = true;
  const std::vector<int> kids = copy.children;
  copy.children.clear();
  doc.nodes.push_back(std::move(copy));
  const int idx = static_cast<int>(doc.nodes.size() - 1);
  for (const int k : kids) {
    const int c = clone_subtree(doc, k, idx);
    doc.nodes[static_cast<std::size_t>(idx)].children.push_back(c);
  }
  return idx;
}

std::string_view href_id(const std::string* h) {
  if (h == nullptr) return {};
  std::string_view v = trim(*h);
  if (!v.starts_with('#')) return {};
  return v.substr(1);
}

/// The use sits inside its own target, or inside a clone of it: a reference cycle.
bool inside_target(const Document& doc, int target, std::string_view id, int node) {
  for (int n = node; n >= 0; n = doc.nodes[static_cast<std::size_t>(n)].parent) {
    if (n == target) return true;
    const std::string* v = doc.nodes[static_cast<std::size_t>(n)].attr("id");
    if (doc.nodes[static_cast<std::size_t>(n)].shadow && v != nullptr && *v == id) return true;
  }
  return false;
}

}  // namespace

void expand_uses(Document& doc) {
  // Blink caps nested use expansion (SVGUseElement: kMaxUseNesting-ish); a use
  // whose target contains the use itself is a cycle and renders nothing.
  constexpr int kMaxDepth = 32;
  constexpr std::size_t kMaxNodes = 200000;
  std::vector<std::pair<int, int>> work;  // (use node, depth)
  for (std::size_t i = 0; i < doc.nodes.size(); ++i) {
    const Node& n = doc.nodes[i];
    if (n.element && n.svgNs && n.name == "use") work.emplace_back(static_cast<int>(i), 0);
  }
  for (std::size_t w = 0; w < work.size(); ++w) {
    const auto [use, depth] = work[w];
    if (depth > kMaxDepth || doc.nodes.size() > kMaxNodes) continue;
    // Resolve against the ORIGINAL document (the target's id).
    const std::string id(href_id(doc.href(use)));  // a copy: cloning reallocates the node array
    const int target = doc.by_id(id);
    if (target < 0) continue;
    const Node& t = doc.nodes[static_cast<std::size_t>(target)];
    if (!t.element || !t.svgNs) continue;
    if (inside_target(doc, target, id, use)) continue;
    const std::size_t before = doc.nodes.size();
    const int c = clone_subtree(doc, target, use);
    doc.nodes[static_cast<std::size_t>(use)].children.push_back(c);
    for (std::size_t k = before; k < doc.nodes.size(); ++k) {
      const Node& cn = doc.nodes[k];
      if (cn.element && cn.svgNs && cn.name == "use") work.emplace_back(static_cast<int>(k), depth + 1);
    }
  }
}

// ── values ───────────────────────────────────────────────────────────────────

std::optional<float> parse_number(std::string_view& s) {
  // Blink GenericParseNumber (svg_parser_utilities.cc), float accumulation.
  std::size_t p = 0;
  const std::size_t n = s.size();
  float sign = 1.0F;
  if (p < n && s[p] == '+') ++p;
  else if (p < n && s[p] == '-') {
    ++p;
    sign = -1.0F;
  }
  if (p == n || (!is_digit(s[p]) && s[p] != '.')) return std::nullopt;
  const std::size_t intStart = p;
  while (p < n && is_digit(s[p])) ++p;
  float integer = 0.0F;
  if (p != intStart) {
    float mul = 1.0F;
    for (std::size_t k = p; k > intStart; --k) {
      integer += mul * static_cast<float>(s[k - 1] - '0');
      mul *= 10.0F;
    }
    if (!std::isfinite(integer)) return std::nullopt;
  }
  float decimal = 0.0F;
  if (p < n && s[p] == '.') {
    ++p;
    if (p >= n || !is_digit(s[p])) return std::nullopt;
    float frac = 1.0F;
    while (p < n && is_digit(s[p])) {
      frac *= 0.1F;
      decimal += static_cast<float>(s[p] - '0') * frac;
      ++p;
    }
  }
  if (p == intStart) return std::nullopt;
  double number = static_cast<double>(integer) + static_cast<double>(decimal);
  number *= static_cast<double>(sign);
  if (p + 1 < n && (s[p] == 'e' || s[p] == 'E') && s[p + 1] != 'x' && s[p + 1] != 'm') {
    std::size_t q = p + 1;
    double expSign = 1.0;
    if (q < n && s[q] == '+') ++q;
    else if (q < n && s[q] == '-') {
      ++q;
      expSign = -1.0;
    }
    if (q >= n || !is_digit(s[q])) return std::nullopt;
    double exponent = 0.0;
    while (q < n && is_digit(s[q])) {
      exponent = exponent * 10.0 + (s[q] - '0');
      ++q;
    }
    if (exponent != 0.0) number *= std::pow(10.0, expSign * exponent);
    p = q;
  }
  const auto f = static_cast<float>(number);
  if (!std::isfinite(f)) return std::nullopt;
  s.remove_prefix(p);
  return f;
}

void skip_comma_ws(std::string_view& s) {
  while (!s.empty() && is_ws(s.front())) s.remove_prefix(1);
  if (!s.empty() && s.front() == ',') {
    s.remove_prefix(1);
    while (!s.empty() && is_ws(s.front())) s.remove_prefix(1);
  }
}

std::optional<Length> parse_length(std::string_view in) {
  std::string_view s = trim(in);
  const auto v = parse_number(s);
  if (!v) return std::nullopt;
  const std::string u = lower(s);
  Length l;
  l.v = static_cast<double>(*v);
  if (u.empty()) l.unit = Unit::number;
  else if (u == "px") l.unit = Unit::px;
  else if (u == "%") l.unit = Unit::percent;
  else if (u == "em") l.unit = Unit::em;
  else if (u == "ex") l.unit = Unit::ex;
  else if (u == "cm") l.unit = Unit::cm;
  else if (u == "mm") l.unit = Unit::mm;
  else if (u == "in") l.unit = Unit::in;
  else if (u == "pt") l.unit = Unit::pt;
  else if (u == "pc") l.unit = Unit::pc;
  else return std::nullopt;
  return l;
}

double resolve(const Length& l, double ref, double fontPx) {
  switch (l.unit) {
    case Unit::number:
    case Unit::px: return l.v;
    case Unit::percent: return l.v / 100.0 * ref;
    case Unit::em: return l.v * fontPx;
    case Unit::ex: return l.v * fontPx * 0.5;  // Blink: the font's x-height; half an em without one
    case Unit::cm: return l.v * 96.0 / 2.54;
    case Unit::mm: return l.v * 96.0 / 25.4;
    case Unit::in: return l.v * 96.0;
    case Unit::pt: return l.v * 96.0 / 72.0;
    case Unit::pc: return l.v * 16.0;
  }
  return l.v;
}

std::optional<Mat2D> parse_transform(std::string_view s) {
  // SVGTransformList parsing: name '(' numbers ')' separated by whitespace / commas.
  Mat2D m;
  s = trim(s);
  if (s.empty()) return m;
  while (!s.empty()) {
    std::size_t k = 0;
    while (k < s.size() && ((s[k] >= 'a' && s[k] <= 'z') || (s[k] >= 'A' && s[k] <= 'Z'))) ++k;
    const std::string_view name = s.substr(0, k);
    s.remove_prefix(k);
    while (!s.empty() && is_ws(s.front())) s.remove_prefix(1);
    if (s.empty() || s.front() != '(') return std::nullopt;
    s.remove_prefix(1);
    while (!s.empty() && is_ws(s.front())) s.remove_prefix(1);
    std::vector<double> args;
    while (!s.empty() && s.front() != ')') {
      const auto v = parse_number(s);
      if (!v) return std::nullopt;
      args.push_back(static_cast<double>(*v));
      skip_comma_ws(s);
      if (args.size() > 6) return std::nullopt;
    }
    if (s.empty()) return std::nullopt;
    s.remove_prefix(1);  // ')'
    Mat2D t;
    const double deg = std::numbers::pi / 180.0;
    if (name == "matrix" && args.size() == 6) {
      t = {args[0], args[1], args[2], args[3], args[4], args[5]};
    } else if (name == "translate" && (args.size() == 1 || args.size() == 2)) {
      t = {1, 0, 0, 1, args[0], args.size() == 2 ? args[1] : 0};
    } else if (name == "scale" && (args.size() == 1 || args.size() == 2)) {
      t = {args[0], 0, 0, args.size() == 2 ? args[1] : args[0], 0, 0};
    } else if (name == "rotate" && (args.size() == 1 || args.size() == 3)) {
      const double c = std::cos(args[0] * deg);
      const double sn = std::sin(args[0] * deg);
      t = {c, sn, -sn, c, 0, 0};
      if (args.size() == 3) t = Mat2D{1, 0, 0, 1, args[1], args[2]} * t * Mat2D{1, 0, 0, 1, -args[1], -args[2]};
    } else if (name == "skewX" && args.size() == 1) {
      t = {1, 0, std::tan(args[0] * deg), 1, 0, 0};
    } else if (name == "skewY" && args.size() == 1) {
      t = {1, std::tan(args[0] * deg), 0, 1, 0, 0};
    } else {
      return std::nullopt;
    }
    m = m * t;
    skip_comma_ws(s);
  }
  return m;
}

namespace {

struct PathParser {
  std::string_view s;
  std::vector<PathSeg> out;
  float cx = 0, cy = 0;          // current point
  float sx = 0, sy = 0;          // subpath start
  float lcx = 0, lcy = 0;        // last cubic control 2 (for S)
  float lqx = 0, lqy = 0;        // last quadratic control (for T)
  char prev = 0;

  bool num(float& v) {
    const auto r = parse_number(s);
    if (!r) return false;
    v = *r;
    skip_comma_ws(s);
    return true;
  }
  bool flag(bool& v) {
    // Arc flags are single characters '0' / '1', not general numbers.
    if (s.empty() || (s.front() != '0' && s.front() != '1')) return false;
    v = s.front() == '1';
    s.remove_prefix(1);
    skip_comma_ws(s);
    return true;
  }
  void emit(PathSeg::Op op, std::array<float, 6> p) { out.push_back({op, p}); }

  void arc(float rx, float ry, float angle, bool large, bool sweep, float x, float y) {
    // SVGPathNormalizer::DecomposeArcToCubic.
    rx = std::fabs(rx);
    ry = std::fabs(ry);
    if (rx == 0.0F || ry == 0.0F) {
      emit(PathSeg::Op::line, {x, y});
      return;
    }
    if (x == cx && y == cy) return;
    const double a = static_cast<double>(angle) * std::numbers::pi / 180.0;
    const auto ca = static_cast<float>(std::cos(a));
    const auto sa = static_cast<float>(std::sin(a));
    const float mx = (cx - x) * 0.5F;
    const float my = (cy - y) * 0.5F;
    // Rotate(-angle).
    const float tx = ca * mx + sa * my;
    const float ty = -sa * mx + ca * my;
    const float scale = (tx * tx) / (rx * rx) + (ty * ty) / (ry * ry);
    if (scale > 1.0F) {
      rx *= std::sqrt(scale);
      ry *= std::sqrt(scale);
    }
    // Scale(1/rx, 1/ry) · Rotate(-angle).
    const auto map_in = [&](float px, float py) {
      const float rx0 = ca * px + sa * py;
      const float ry0 = -sa * px + ca * py;
      return std::array<float, 2>{rx0 / rx, ry0 / ry};
    };
    auto p1 = map_in(cx, cy);
    auto p2 = map_in(x, y);
    float dx = p2[0] - p1[0];
    float dy = p2[1] - p1[1];
    const float d = dx * dx + dy * dy;
    float sf = std::sqrt(std::max(1.0F / d - 0.25F, 0.0F));
    if (sweep == large) sf = -sf;
    dx *= sf;
    dy *= sf;
    const float ccx = (p1[0] + p2[0]) * 0.5F - dy;
    const float ccy = (p1[1] + p2[1]) * 0.5F + dx;
    const float th1 = std::atan2(p1[1] - ccy, p1[0] - ccx);
    const float th2 = std::atan2(p2[1] - ccy, p2[0] - ccx);
    float thArc = th2 - th1;
    constexpr float kTwoPi = 2.0F * std::numbers::pi_v<float>;
    if (thArc < 0 && sweep) thArc += kTwoPi;
    else if (thArc > 0 && !sweep) thArc -= kTwoPi;
    // Rotate(angle) · Scale(rx, ry).
    const auto map_out = [&](float px, float py) {
      const float qx = px * rx;
      const float qy = py * ry;
      return std::array<float, 2>{ca * qx - sa * qy, sa * qx + ca * qy};
    };
    const int segs = static_cast<int>(std::ceil(std::fabs(thArc / (std::numbers::pi_v<float> / 2.0F + 0.001F))));
    for (int i = 0; i < segs; ++i) {
      const float st = th1 + static_cast<float>(i) * thArc / static_cast<float>(segs);
      const float et = th1 + static_cast<float>(i + 1) * thArc / static_cast<float>(segs);
      const float t = (8.0F / 6.0F) * std::tan(0.25F * (et - st));
      if (!std::isfinite(t)) return;
      const float ss = std::sin(st);
      const float cs = std::cos(st);
      const float se = std::sin(et);
      const float ce = std::cos(et);
      const auto c1 = map_out(cs - t * ss + ccx, ss + t * cs + ccy);
      const auto e = map_out(ce + ccx, se + ccy);
      const auto c2 = map_out(ce + ccx + t * se, se + ccy - t * ce);
      emit(PathSeg::Op::cubic, {c1[0], c1[1], c2[0], c2[1], e[0], e[1]});
    }
  }

  void run() {
    skip_ws();
    char cmd = 0;
    bool first = true;
    while (!s.empty()) {
      char c = s.front();
      if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
        s.remove_prefix(1);
        skip_ws();
        cmd = c;
      } else if (cmd == 0 || cmd == 'z' || cmd == 'Z') {
        return;  // a number where a command is required
      } else if (cmd == 'M') {
        cmd = 'L';
      } else if (cmd == 'm') {
        cmd = 'l';
      }
      if (first && cmd != 'M' && cmd != 'm') return;  // path data must start with a moveto
      first = false;
      const bool rel = cmd >= 'a' && cmd <= 'z';
      const float ox = rel ? cx : 0.0F;
      const float oy = rel ? cy : 0.0F;
      const char up = static_cast<char>(rel ? cmd - 'a' + 'A' : cmd);
      float a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0;
      switch (up) {
        case 'M':
          if (!num(a0) || !num(a1)) return;
          cx = sx = a0 + ox;
          cy = sy = a1 + oy;
          emit(PathSeg::Op::move, {cx, cy});
          break;
        case 'L':
          if (!num(a0) || !num(a1)) return;
          cx = a0 + ox;
          cy = a1 + oy;
          emit(PathSeg::Op::line, {cx, cy});
          break;
        case 'H':
          if (!num(a0)) return;
          cx = a0 + ox;
          emit(PathSeg::Op::line, {cx, cy});
          break;
        case 'V':
          if (!num(a0)) return;
          cy = a0 + (rel ? cy : 0.0F);
          emit(PathSeg::Op::line, {cx, cy});
          break;
        case 'C':
          if (!num(a0) || !num(a1) || !num(a2) || !num(a3) || !num(a4) || !num(a5)) return;
          emit(PathSeg::Op::cubic, {a0 + ox, a1 + oy, a2 + ox, a3 + oy, a4 + ox, a5 + oy});
          lcx = a2 + ox;
          lcy = a3 + oy;
          cx = a4 + ox;
          cy = a5 + oy;
          break;
        case 'S': {
          if (!num(a2) || !num(a3) || !num(a4) || !num(a5)) return;
          const bool smooth = prev == 'C' || prev == 'S';
          const float c1x = smooth ? 2 * cx - lcx : cx;
          const float c1y = smooth ? 2 * cy - lcy : cy;
          emit(PathSeg::Op::cubic, {c1x, c1y, a2 + ox, a3 + oy, a4 + ox, a5 + oy});
          lcx = a2 + ox;
          lcy = a3 + oy;
          cx = a4 + ox;
          cy = a5 + oy;
          break;
        }
        case 'Q': {
          if (!num(a0) || !num(a1) || !num(a2) || !num(a3)) return;
          const float qx = a0 + ox;
          const float qy = a1 + oy;
          const float x = a2 + ox;
          const float y = a3 + oy;
          emit(PathSeg::Op::cubic, {cx + 2.0F / 3.0F * (qx - cx), cy + 2.0F / 3.0F * (qy - cy), x + 2.0F / 3.0F * (qx - x),
                                    y + 2.0F / 3.0F * (qy - y), x, y});
          lqx = qx;
          lqy = qy;
          cx = x;
          cy = y;
          break;
        }
        case 'T': {
          if (!num(a2) || !num(a3)) return;
          const bool smooth = prev == 'Q' || prev == 'T';
          const float qx = smooth ? 2 * cx - lqx : cx;
          const float qy = smooth ? 2 * cy - lqy : cy;
          const float x = a2 + ox;
          const float y = a3 + oy;
          emit(PathSeg::Op::cubic, {cx + 2.0F / 3.0F * (qx - cx), cy + 2.0F / 3.0F * (qy - cy), x + 2.0F / 3.0F * (qx - x),
                                    y + 2.0F / 3.0F * (qy - y), x, y});
          lqx = qx;
          lqy = qy;
          cx = x;
          cy = y;
          break;
        }
        case 'A': {
          bool large = false;
          bool sweep = false;
          if (!num(a0) || !num(a1) || !num(a2) || !flag(large) || !flag(sweep) || !num(a4) || !num(a5)) return;
          const float x = a4 + ox;
          const float y = a5 + oy;
          arc(a0, a1, a2, large, sweep, x, y);
          cx = x;
          cy = y;
          break;
        }
        case 'Z':
          emit(PathSeg::Op::close, {});
          cx = sx;
          cy = sy;
          break;
        default:
          return;
      }
      prev = up;
      if (up == 'Z') skip_ws();
    }
  }
  void skip_ws() {
    while (!s.empty() && is_ws(s.front())) s.remove_prefix(1);
  }
};

}  // namespace

std::vector<PathSeg> parse_path_data(std::string_view d) {
  PathParser p;
  p.s = d;
  p.run();
  return std::move(p.out);
}

std::vector<std::array<float, 2>> parse_points(std::string_view s) {
  std::vector<std::array<float, 2>> out;
  s = trim(s);
  while (!s.empty()) {
    const auto x = parse_number(s);
    if (!x) break;
    skip_comma_ws(s);
    const auto y = parse_number(s);
    if (!y) break;
    skip_comma_ws(s);
    out.push_back({*x, *y});
  }
  return out;
}

std::optional<ViewBox> parse_view_box(std::string_view s) {
  s = trim(s);
  std::array<double, 4> v{};
  for (double& x : v) {
    const auto n = parse_number(s);
    if (!n) return std::nullopt;
    x = static_cast<double>(*n);
    skip_comma_ws(s);
  }
  if (!trim(s).empty()) return std::nullopt;
  if (v[2] < 0 || v[3] < 0) return std::nullopt;  // negative width / height: an error, the attribute is ignored
  return ViewBox{v[0], v[1], v[2], v[3]};
}

AspectRatio parse_aspect_ratio(std::string_view s) {
  AspectRatio r;
  std::string_view t = trim(s);
  const auto word = [&t]() {
    while (!t.empty() && is_ws(t.front())) t.remove_prefix(1);
    std::size_t k = 0;
    while (k < t.size() && !is_ws(t[k])) ++k;
    const std::string_view w = t.substr(0, k);
    t.remove_prefix(k);
    return w;
  };
  std::string_view w = word();
  if (w == "defer") w = word();
  AspectRatio out;
  if (w == "none") {
    out.none = true;
  } else if (w.size() == 8 && w.substr(0, 1) == "x" && w.substr(4, 1) == "Y") {
    const std::string_view ax = w.substr(1, 3);
    const std::string_view ay = w.substr(5, 3);
    const auto al = [](std::string_view a) -> std::uint8_t { return a == "Min" ? 1 : a == "Mid" ? 2 : a == "Max" ? 3 : 0; };
    out.alignX = al(ax);
    out.alignY = al(ay);
    if (out.alignX == 0 || out.alignY == 0) return r;
  } else {
    return r;  // unknown: the default (xMidYMid meet)
  }
  const std::string_view ms = word();
  if (ms == "slice") out.slice = true;
  else if (!ms.empty() && ms != "meet") return r;
  if (!trim(t).empty()) return r;
  return out;
}

Mat2D view_box_transform(const ViewBox& vb, const AspectRatio& par, double w, double h) {
  // SVGPreserveAspectRatio::ComputeTransform.
  if (vb.w <= 0 || vb.h <= 0) return {};
  if (par.none) {
    return Mat2D{w / vb.w, 0, 0, h / vb.h, 0, 0} * Mat2D{1, 0, 0, 1, -vb.x, -vb.y};
  }
  const double lr = vb.w / vb.h;
  const double pr = w / h;
  if ((lr < pr && !par.slice) || (lr >= pr && par.slice)) {
    const double s = h / vb.h;
    double tx = -vb.x;
    if (par.alignX == 2) tx = -vb.x - (vb.w - w * vb.h / h) / 2;
    else if (par.alignX == 3) tx = -vb.x - (vb.w - w * vb.h / h);
    return Mat2D{s, 0, 0, s, 0, 0} * Mat2D{1, 0, 0, 1, tx, -vb.y};
  }
  const double s = w / vb.w;
  double ty = -vb.y;
  if (par.alignY == 2) ty = -vb.y - (vb.h - h * vb.w / w) / 2;
  else if (par.alignY == 3) ty = -vb.y - (vb.h - h * vb.w / w);
  return Mat2D{s, 0, 0, s, 0, 0} * Mat2D{1, 0, 0, 1, -vb.x, ty};
}

// ── style ────────────────────────────────────────────────────────────────────

namespace {

struct AttrSel {
  std::string name;
  char op = 0;  // 0 = presence, '=' exact, '~' word, '^' prefix, '$' suffix, '*' substring, '|' dash
  std::string value;
};

struct Compound {
  std::string tag;  // "" = any
  std::vector<std::string> ids;
  std::vector<std::string> classes;
  std::vector<AttrSel> attrs;
  bool root = false;
  bool firstChild = false;
  bool lastChild = false;
};

struct Complex {
  std::vector<Compound> parts;  // left to right
  std::vector<char> combs;      // combs[i] joins parts[i] and parts[i + 1]: ' ', '>', '+', '~'
  std::uint32_t specificity = 0;
};

struct Decl {
  std::string prop;
  std::string value;
  bool important = false;
};

struct Rule {
  std::vector<Complex> selectors;
  std::vector<Decl> decls;
  std::size_t order = 0;
};

std::string strip_comments(std::string_view css) {
  std::string out;
  out.reserve(css.size());
  for (std::size_t i = 0; i < css.size(); ++i) {
    if (css[i] == '/' && i + 1 < css.size() && css[i + 1] == '*') {
      const std::size_t e = css.find("*/", i + 2);
      if (e == std::string_view::npos) break;
      i = e + 1;
      out.push_back(' ');
      continue;
    }
    out.push_back(css[i]);
  }
  return out;
}

/// Split on `sep` outside parentheses and quotes.
std::vector<std::string_view> split_top(std::string_view s, char sep) {
  std::vector<std::string_view> out;
  int depth = 0;
  char quote = 0;
  std::size_t start = 0;
  for (std::size_t i = 0; i < s.size(); ++i) {
    const char c = s[i];
    if (quote != 0) {
      if (c == quote) quote = 0;
      continue;
    }
    if (c == '"' || c == '\'') quote = c;
    else if (c == '(') ++depth;
    else if (c == ')') --depth;
    else if (c == sep && depth == 0) {
      out.push_back(s.substr(start, i - start));
      start = i + 1;
    }
  }
  out.push_back(s.substr(start));
  return out;
}

std::vector<Decl> parse_decls(std::string_view block) {
  std::vector<Decl> out;
  for (std::string_view d : split_top(block, ';')) {
    d = trim(d);
    const std::size_t colon = d.find(':');
    if (colon == std::string_view::npos) continue;
    Decl x;
    x.prop = lower(trim(d.substr(0, colon)));
    std::string_view v = trim(d.substr(colon + 1));
    const std::size_t bang = v.rfind('!');
    if (bang != std::string_view::npos && lower(trim(v.substr(bang + 1))) == "important") {
      x.important = true;
      v = trim(v.substr(0, bang));
    }
    x.value = std::string(v);
    if (!x.prop.empty() && !x.value.empty()) out.push_back(std::move(x));
  }
  return out;
}

bool ident_char(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || is_digit(c) || c == '-' || c == '_' ||
         static_cast<unsigned char>(c) >= 0x80 || c == '\\';
}

std::string read_ident(std::string_view& s) {
  std::string o;
  while (!s.empty() && ident_char(s.front())) {
    if (s.front() == '\\' && s.size() > 1) {
      s.remove_prefix(1);
    }
    o.push_back(s.front());
    s.remove_prefix(1);
  }
  return o;
}

/// One complex selector; false = a selector the port does not implement (the rule is skipped, as an invalid selector would be).
bool parse_complex(std::string_view s, Complex& out, std::string& why) {
  s = trim(s);
  if (s.empty()) return false;
  std::uint32_t a = 0, b = 0, c = 0;
  char pending = 0;
  while (!s.empty()) {
    Compound cp;
    bool any = false;
    if (s.front() == '*') {
      s.remove_prefix(1);
      any = true;
    } else if (ident_char(s.front())) {
      cp.tag = read_ident(s);
      ++c;
      any = true;
    }
    while (!s.empty() && (s.front() == '.' || s.front() == '#' || s.front() == '[' || s.front() == ':')) {
      const char k = s.front();
      s.remove_prefix(1);
      if (k == '.') {
        cp.classes.push_back(read_ident(s));
        ++b;
      } else if (k == '#') {
        cp.ids.push_back(read_ident(s));
        ++a;
      } else if (k == '[') {
        const std::size_t e = s.find(']');
        if (e == std::string_view::npos) return false;
        std::string_view body = trim(s.substr(0, e));
        s.remove_prefix(e + 1);
        AttrSel at;
        std::size_t op = body.find_first_of("=~^$*|");
        if (op == std::string_view::npos) {
          at.name = std::string(trim(body));
        } else {
          at.name = std::string(trim(body.substr(0, op)));
          at.op = body[op];
          std::string_view val = body.substr(op + 1);
          if (at.op != '=') {
            if (val.empty() || val.front() != '=') return false;
            val.remove_prefix(1);
          }
          val = trim(val);
          if (val.size() >= 2 && (val.front() == '"' || val.front() == '\'')) val = val.substr(1, val.size() - 2);
          at.value = std::string(val);
        }
        cp.attrs.push_back(std::move(at));
        ++b;
      } else {
        const std::string pc = lower(read_ident(s));
        if (!s.empty() && s.front() == '(') {
          why = "CSS selector :" + pc + "()";
          return false;
        }
        if (pc == "root") cp.root = true;
        else if (pc == "first-child") cp.firstChild = true;
        else if (pc == "last-child") cp.lastChild = true;
        else if (pc == "link" || pc == "visited" || pc == "hover" || pc == "active" || pc == "focus") {
          return false;  // never matches in an image
        } else {
          why = "CSS selector :" + pc;
          return false;
        }
        ++b;
      }
      any = true;
    }
    if (!any) return false;
    if (pending != 0) out.combs.push_back(pending);
    out.parts.push_back(std::move(cp));
    // Combinator.
    bool ws = false;
    while (!s.empty() && is_ws(s.front())) {
      s.remove_prefix(1);
      ws = true;
    }
    if (s.empty()) break;
    if (s.front() == '>' || s.front() == '+' || s.front() == '~') {
      pending = s.front();
      s.remove_prefix(1);
      while (!s.empty() && is_ws(s.front())) s.remove_prefix(1);
    } else if (ws) {
      pending = ' ';
    } else {
      why = "CSS selector syntax";
      return false;
    }
  }
  if (out.parts.empty()) return false;
  out.specificity = (std::min(a, 255U) << 16U) | (std::min(b, 255U) << 8U) | std::min(c, 255U);
  return true;
}

bool has_class(const Node& n, std::string_view cls) {
  const std::string* v = n.attr("class");
  if (v == nullptr) return false;
  std::string_view s = *v;
  while (!s.empty()) {
    while (!s.empty() && is_ws(s.front())) s.remove_prefix(1);
    std::size_t k = 0;
    while (k < s.size() && !is_ws(s[k])) ++k;
    if (s.substr(0, k) == cls) return true;
    s.remove_prefix(k);
  }
  return false;
}

int element_sibling(const Document& doc, int node, int dir) {
  const Node& n = doc.nodes[static_cast<std::size_t>(node)];
  if (n.parent < 0) return -1;
  const auto& kids = doc.nodes[static_cast<std::size_t>(n.parent)].children;
  const auto it = std::ranges::find(kids, node);
  if (it == kids.end()) return -1;
  auto idx = static_cast<std::ptrdiff_t>(it - kids.begin());
  for (idx += dir; idx >= 0 && idx < static_cast<std::ptrdiff_t>(kids.size()); idx += dir) {
    const int k = kids[static_cast<std::size_t>(idx)];
    if (doc.nodes[static_cast<std::size_t>(k)].element) return k;
  }
  return -1;
}

bool match_compound(const Document& doc, int node, const Compound& c) {
  const Node& n = doc.nodes[static_cast<std::size_t>(node)];
  if (!n.element) return false;
  if (!c.tag.empty() && c.tag != n.name) return false;
  for (const auto& id : c.ids) {
    const std::string* v = n.attr("id");
    if (v == nullptr || *v != id) return false;
  }
  for (const auto& cl : c.classes) {
    if (!has_class(n, cl)) return false;
  }
  for (const auto& at : c.attrs) {
    const std::string* v = n.attr(at.name);
    if (v == nullptr) return false;
    const std::string_view sv = *v;
    switch (at.op) {
      case 0: break;
      case '=': if (sv != at.value) return false; break;
      case '^': if (at.value.empty() || !sv.starts_with(at.value)) return false; break;
      case '$': if (at.value.empty() || !sv.ends_with(at.value)) return false; break;
      case '*': if (at.value.empty() || sv.find(at.value) == std::string_view::npos) return false; break;
      case '|': if (sv != at.value && !sv.starts_with(at.value + "-")) return false; break;
      case '~': {
        bool found = false;
        std::string_view s = sv;
        while (!s.empty() && !found) {
          while (!s.empty() && is_ws(s.front())) s.remove_prefix(1);
          std::size_t k = 0;
          while (k < s.size() && !is_ws(s[k])) ++k;
          found = s.substr(0, k) == at.value;
          s.remove_prefix(k);
        }
        if (!found) return false;
        break;
      }
      default: return false;
    }
  }
  if (c.root && node != doc.root) return false;
  if (c.firstChild && element_sibling(doc, node, -1) >= 0) return false;
  if (c.lastChild && element_sibling(doc, node, 1) >= 0) return false;
  return true;
}

bool match_from(const Document& doc, int node, const Complex& cx, std::size_t part) {
  if (!match_compound(doc, node, cx.parts[part])) return false;
  if (part == 0) return true;
  const char comb = cx.combs[part - 1];
  const Node& n = doc.nodes[static_cast<std::size_t>(node)];
  switch (comb) {
    case '>': return n.parent >= 0 && match_from(doc, n.parent, cx, part - 1);
    case ' ':
      for (int p = n.parent; p >= 0; p = doc.nodes[static_cast<std::size_t>(p)].parent) {
        if (match_from(doc, p, cx, part - 1)) return true;
      }
      return false;
    case '+': {
      const int s = element_sibling(doc, node, -1);
      return s >= 0 && match_from(doc, s, cx, part - 1);
    }
    case '~':
      for (int s = element_sibling(doc, node, -1); s >= 0; s = element_sibling(doc, s, -1)) {
        if (match_from(doc, s, cx, part - 1)) return true;
      }
      return false;
    default: return false;
  }
}

void parse_sheet(std::string_view css, std::vector<Rule>& rules, std::vector<std::string>& unsupported) {
  const std::string text = strip_comments(css);
  std::string_view s = text;
  while (true) {
    s = trim(s);
    if (s.empty()) return;
    if (s.front() == '@') {
      // At-rules: skip the statement or the block (media queries etc. are not evaluated).
      std::size_t k = 0;
      while (k < s.size() && s[k] != ';' && s[k] != '{') ++k;
      const std::string name = std::string(trim(s.substr(0, std::min(k, s.find_first_of(" \t\n\r", 0)))));
      if (k < s.size() && s[k] == '{') {
        int depth = 0;
        for (; k < s.size(); ++k) {
          if (s[k] == '{') ++depth;
          else if (s[k] == '}' && --depth == 0) break;
        }
      }
      if (name != "@charset" && name != "@namespace") unsupported.push_back("CSS " + name);
      s.remove_prefix(std::min(s.size(), k + 1));
      continue;
    }
    const std::size_t open = s.find('{');
    if (open == std::string_view::npos) return;
    const std::string_view sel = s.substr(0, open);
    std::size_t close = open + 1;
    int depth = 1;
    char quote = 0;
    for (; close < s.size(); ++close) {
      const char c = s[close];
      if (quote != 0) {
        if (c == quote) quote = 0;
        continue;
      }
      if (c == '"' || c == '\'') quote = c;
      else if (c == '{') ++depth;
      else if (c == '}' && --depth == 0) break;
    }
    const std::string_view body = s.substr(open + 1, std::min(close, s.size()) - open - 1);
    Rule r;
    bool ok = true;
    for (const std::string_view one : split_top(sel, ',')) {
      Complex cx;
      std::string why;
      if (!parse_complex(one, cx, why)) {
        // One invalid selector invalidates the whole rule (CSS selector-list rule).
        if (!why.empty()) unsupported.push_back(why);
        ok = false;
        break;
      }
      r.selectors.push_back(std::move(cx));
    }
    if (ok) {
      r.decls = parse_decls(body);
      r.order = rules.size();
      rules.push_back(std::move(r));
    }
    s.remove_prefix(std::min(s.size(), close + 1));
  }
}

// ── property values ──

std::optional<Paint> parse_paint(std::string_view v) {
  v = trim(v);
  Paint p;
  const std::string lv = lower(v);
  if (lv == "none") {
    p.kind = Paint::Kind::none;
    return p;
  }
  if (lv == "currentcolor") {
    p.kind = Paint::Kind::current;
    return p;
  }
  if (lv.starts_with("url(")) {
    const std::size_t close = v.find(')');
    if (close == std::string_view::npos) return std::nullopt;
    std::string_view u = trim(v.substr(4, close - 4));
    if (u.size() >= 2 && (u.front() == '"' || u.front() == '\'')) u = u.substr(1, u.size() - 2);
    const std::size_t hash = u.find('#');
    if (hash == std::string_view::npos) return std::nullopt;
    if (hash != 0) return std::nullopt;  // external references never resolve in an image
    p.kind = Paint::Kind::url;
    p.url = std::string(u.substr(1));
    const std::string_view rest = trim(v.substr(close + 1));
    if (!rest.empty()) {
      const std::string lr = lower(rest);
      if (lr == "none") p.fallback = Paint::Kind::none;
      else if (lr == "currentcolor") p.fallback = Paint::Kind::current;
      else if (const auto c = css::parse_color(rest)) {
        p.fallback = Paint::Kind::color;
        p.fallbackColor = *c;
      } else {
        return std::nullopt;
      }
    }
    return p;
  }
  if (lv == "context-fill" || lv == "context-stroke") return std::nullopt;
  const auto c = css::parse_color(v);
  if (!c) return std::nullopt;
  p.kind = Paint::Kind::color;
  p.color = *c;
  return p;
}

std::optional<std::string> parse_url_ref(std::string_view v) {
  v = trim(v);
  if (lower(v) == "none") return std::string();
  if (!lower(v).starts_with("url(")) return std::nullopt;
  const std::size_t close = v.find(')');
  if (close == std::string_view::npos) return std::nullopt;
  std::string_view u = trim(v.substr(4, close - 4));
  if (u.size() >= 2 && (u.front() == '"' || u.front() == '\'')) u = u.substr(1, u.size() - 2);
  if (!u.starts_with('#')) return std::nullopt;
  if (!trim(v.substr(close + 1)).empty()) return std::nullopt;
  return std::string(u.substr(1));
}

std::optional<double> parse_number_value(std::string_view v) {
  v = trim(v);
  const auto n = parse_number(v);
  if (!n) return std::nullopt;
  if (v == "%") return static_cast<double>(*n) / 100.0;
  if (!v.empty()) return std::nullopt;
  return static_cast<double>(*n);
}

double clamp01(double v) { return std::min(1.0, std::max(0.0, v)); }

std::vector<std::string> parse_families(std::string_view v) {
  std::vector<std::string> out;
  for (std::string_view f : split_top(v, ',')) {
    f = trim(f);
    if (f.size() >= 2 && (f.front() == '"' || f.front() == '\'')) f = f.substr(1, f.size() - 2);
    if (!f.empty()) out.emplace_back(f);
  }
  return out;
}

/// The properties the renderer reads (presentation attributes are exactly these names).
bool is_presentation(std::string_view p) {
  static constexpr auto kProps = std::to_array<std::string_view>({
      "fill", "stroke", "fill-opacity", "stroke-opacity", "fill-rule", "clip-rule", "stroke-width", "stroke-linecap",
      "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "visibility", "marker-start",
      "marker-mid", "marker-end", "color", "font-family", "font-size", "font-weight", "font-style", "text-anchor",
      "color-interpolation-filters", "letter-spacing", "word-spacing", "shape-rendering", "image-rendering",
      "paint-order", "opacity", "display", "clip-path", "mask", "filter", "stop-color", "stop-opacity", "flood-color",
      "flood-opacity", "lighting-color", "overflow", "mask-type", "vector-effect", "dominant-baseline",
      "text-decoration"});
  return std::ranges::find(kProps, p) != kProps.end();
}

class Cascader {
 public:
  Cascader(const Document& doc, std::vector<Style>& styles, std::vector<std::string>& unsupported)
      : doc_(doc), styles_(styles), unsupported_(unsupported) {}

  void run(std::string_view extraCss) {
    for (std::size_t i = 0; i < doc_.nodes.size(); ++i) {
      const Node& n = doc_.nodes[i];
      if (!n.element || !n.svgNs || n.name != "style" || n.shadow) continue;
      if (const std::string* t = n.attr("type"); t != nullptr && !t->empty() && lower(trim(*t)) != "text/css") continue;
      std::string text;
      for (const int k : n.children) {
        const Node& c = doc_.nodes[static_cast<std::size_t>(k)];
        if (!c.element) text += c.text;
      }
      parse_sheet(text, rules_, unsupported_);
    }
    if (!extraCss.empty()) parse_sheet(extraCss, rules_, unsupported_);
    styles_.assign(doc_.nodes.size(), Style{});
    // Parents precede children in the node array (parse order, clones appended after their host).
    for (std::size_t i = 0; i < doc_.nodes.size(); ++i) compute(static_cast<int>(i));
  }

 private:
  struct Winner {
    std::tuple<int, int, std::uint32_t, std::size_t> key;
    std::string value;
  };

  void compute(int idx) {
    const Node& n = doc_.nodes[static_cast<std::size_t>(idx)];
    const Style parent = n.parent >= 0 ? styles_[static_cast<std::size_t>(n.parent)] : Style{};
    Style s = inherit_from(parent);
    if (!n.element) {
      styles_[static_cast<std::size_t>(idx)] = parent;
      return;
    }
    // UA sheet: overflow: hidden on svg:not(:root), symbol, image, marker, pattern, foreignObject.
    if (idx != doc_.root && (n.name == "svg" || n.name == "symbol" || n.name == "image" || n.name == "marker" ||
                             n.name == "pattern" || n.name == "foreignObject")) {
      s.overflowVisible = false;
    } else {
      s.overflowVisible = true;
    }
    std::map<std::string, Winner, std::less<>> win;
    std::size_t order = 0;
    const auto offer = [&](const std::string& prop, const std::string& value, std::tuple<int, int, std::uint32_t, std::size_t> key) {
      // Shorthands expand to their longhands at the same priority.
      if (prop == "marker") {
        for (const char* p : {"marker-start", "marker-mid", "marker-end"}) offer_one(win, p, value, key);
        return;
      }
      if (prop == "font") {
        const auto f = css::parse_font(value);
        if (!f) return;
        offer_one(win, "font-style", f->italic ? "italic" : "normal", key);
        offer_one(win, "font-weight", std::to_string(f->weight), key);
        offer_one(win, "font-size", std::to_string(f->sizePx) + "px", key);
        std::string fam;
        for (const auto& x : f->families) fam += (fam.empty() ? "" : ",") + ("\"" + x + "\"");
        offer_one(win, "font-family", fam, key);
        return;
      }
      offer_one(win, prop, value, key);
    };
    if (n.svgNs) {
      for (const auto& [k, v] : n.attrs) {
        if (is_presentation(k)) offer(k, v, {0, 0, 0, order++});
      }
    }
    for (const Rule& r : rules_) {
      std::uint32_t best = 0;
      bool matched = false;
      for (const Complex& cx : r.selectors) {
        if (match_from(doc_, idx, cx, cx.parts.size() - 1)) {
          matched = true;
          best = std::max(best, cx.specificity);
        }
      }
      if (!matched) continue;
      for (const Decl& d : r.decls) offer(d.prop, d.value, {d.important ? 1 : 0, 1, best, order++});
    }
    if (const std::string* st = n.attr("style")) {
      for (const Decl& d : parse_decls(*st)) offer(d.prop, d.value, {d.important ? 1 : 0, 2, 0, order++});
    }
    // `color` first: currentColor in the other properties resolves against it.
    if (const auto it = win.find("color"); it != win.end()) apply(s, parent, "color", it->second.value);
    for (const auto& [prop, w] : win) {
      if (prop != "color") apply(s, parent, prop, w.value);
    }
    styles_[static_cast<std::size_t>(idx)] = std::move(s);
  }

  static void offer_one(std::map<std::string, Winner, std::less<>>& win, const std::string& prop, const std::string& value,
                        std::tuple<int, int, std::uint32_t, std::size_t> key) {
    auto it = win.find(prop);
    if (it == win.end()) win.emplace(prop, Winner{key, value});
    else if (key > it->second.key) it->second = Winner{key, value};
  }

  static Style inherit_from(const Style& p) {
    Style s;  // non-inherited properties at their initial values
    s.fill = p.fill;
    s.stroke = p.stroke;
    s.fillOpacity = p.fillOpacity;
    s.strokeOpacity = p.strokeOpacity;
    s.fillEvenOdd = p.fillEvenOdd;
    s.clipEvenOdd = p.clipEvenOdd;
    s.strokeWidth = p.strokeWidth;
    s.cap = p.cap;
    s.join = p.join;
    s.miterLimit = p.miterLimit;
    s.dashArray = p.dashArray;
    s.dashOffset = p.dashOffset;
    s.hidden = p.hidden;
    s.markerStart = p.markerStart;
    s.markerMid = p.markerMid;
    s.markerEnd = p.markerEnd;
    s.color = p.color;
    s.fontFamily = p.fontFamily;
    s.fontSizePx = p.fontSizePx;
    s.fontWeight = p.fontWeight;
    s.italic = p.italic;
    s.anchor = p.anchor;
    s.filtersLinearRGB = p.filtersLinearRGB;
    s.letterSpacing = p.letterSpacing;
    s.wordSpacing = p.wordSpacing;
    s.crispEdges = p.crispEdges;
    s.pixelatedImages = p.pixelatedImages;
    s.paintOrderStrokeFirst = p.paintOrderStrokeFirst;
    s.paintOrderMarkersBeforeStroke = p.paintOrderMarkersBeforeStroke;
    return s;
  }

  void note(std::string what) {
    if (std::ranges::find(unsupported_, what) == unsupported_.end()) unsupported_.push_back(std::move(what));
  }

  // NOLINTNEXTLINE(readability-function-cognitive-complexity) — one branch per property, as Blink's property table
  void apply(Style& s, const Style& parent, std::string_view prop, std::string_view raw) {
    const std::string_view v = trim(raw);
    const std::string lv = lower(v);
    const bool inherit = lv == "inherit";
    const bool initial = lv == "initial";
    const Style init;
    // `unset` = inherit for inherited properties, initial otherwise.
    const auto pick = [&](auto member) -> bool {
      if (inherit || (lv == "unset" && is_inherited(prop))) {
        s.*member = parent.*member;
        return true;
      }
      if (initial || lv == "unset") {
        s.*member = init.*member;
        return true;
      }
      return false;
    };
    const auto current_or = [&](std::string_view val) -> std::optional<css::Color> {
      if (lower(val) == "currentcolor") return s.color;
      return css::parse_color(val);
    };
    if (prop == "fill" || prop == "stroke") {
      Paint Style::*m = prop == "fill" ? &Style::fill : &Style::stroke;
      if (pick(m)) return;
      // currentColor stays a keyword (it inherits as one); the painter resolves it
      // against the painted element's own `color`.
      if (const auto p = parse_paint(v)) {
        s.*m = *p;
      } else if (lv == "context-fill" || lv == "context-stroke") {
        note("SVG paint " + lv);
      }
    } else if (prop == "fill-opacity" || prop == "stroke-opacity" || prop == "opacity" || prop == "stop-opacity" ||
               prop == "flood-opacity") {
      double Style::*m = prop == "fill-opacity"    ? &Style::fillOpacity
                         : prop == "stroke-opacity" ? &Style::strokeOpacity
                         : prop == "opacity"        ? &Style::opacity
                         : prop == "stop-opacity"   ? &Style::stopOpacity
                                                    : &Style::floodOpacity;
      if (pick(m)) return;
      if (const auto n = parse_number_value(v)) s.*m = clamp01(*n);
    } else if (prop == "fill-rule" || prop == "clip-rule") {
      bool Style::*m = prop == "fill-rule" ? &Style::fillEvenOdd : &Style::clipEvenOdd;
      if (pick(m)) return;
      if (lv == "evenodd") s.*m = true;
      else if (lv == "nonzero") s.*m = false;
    } else if (prop == "stroke-width" || prop == "stroke-dashoffset") {
      Length Style::*m = prop == "stroke-width" ? &Style::strokeWidth : &Style::dashOffset;
      if (pick(m)) return;
      if (const auto l = parse_length(v); l && (prop != "stroke-width" || l->v >= 0)) s.*m = em_to_px(*l, s);
    } else if (prop == "stroke-linecap") {
      if (pick(&Style::cap)) return;
      if (lv == "butt") s.cap = Cap::butt;
      else if (lv == "round") s.cap = Cap::round;
      else if (lv == "square") s.cap = Cap::square;
    } else if (prop == "stroke-linejoin") {
      if (pick(&Style::join)) return;
      if (lv == "miter") s.join = Join::miter;
      else if (lv == "round") s.join = Join::round;
      else if (lv == "bevel") s.join = Join::bevel;
      else if (lv == "miter-clip" || lv == "arcs") note("stroke-linejoin: " + lv);
    } else if (prop == "stroke-miterlimit") {
      if (pick(&Style::miterLimit)) return;
      if (const auto n = parse_number_value(v); n && *n >= 1) s.miterLimit = *n;
    } else if (prop == "stroke-dasharray") {
      if (pick(&Style::dashArray)) return;
      if (lv == "none") {
        s.dashArray.clear();
        return;
      }
      std::vector<Length> dash;
      std::string_view t = v;
      bool ok = true;
      while (!trim(t).empty()) {
        t = trim(t);
        std::size_t k = 0;
        while (k < t.size() && !is_ws(t[k]) && t[k] != ',') ++k;
        const auto l = parse_length(t.substr(0, k));
        if (!l || l->v < 0) {
          ok = false;
          break;
        }
        dash.push_back(em_to_px(*l, s));
        t.remove_prefix(k);
        skip_comma_ws(t);
      }
      if (ok) s.dashArray = std::move(dash);
    } else if (prop == "visibility") {
      if (pick(&Style::hidden)) return;
      if (lv == "hidden" || lv == "collapse") s.hidden = true;
      else if (lv == "visible") s.hidden = false;
    } else if (prop == "marker-start" || prop == "marker-mid" || prop == "marker-end") {
      std::string Style::*m = prop == "marker-start" ? &Style::markerStart : prop == "marker-mid" ? &Style::markerMid : &Style::markerEnd;
      if (pick(m)) return;
      if (const auto u = parse_url_ref(v)) s.*m = *u;
    } else if (prop == "color") {
      if (pick(&Style::color)) return;
      if (lv == "currentcolor") s.color = parent.color;
      else if (const auto c = css::parse_color(v)) s.color = *c;
    } else if (prop == "font-family") {
      if (pick(&Style::fontFamily)) return;
      s.fontFamily = parse_families(v);
    } else if (prop == "font-size") {
      if (pick(&Style::fontSizePx)) return;
      static constexpr std::array<std::pair<std::string_view, double>, 8> kSizes{
          {{"xx-small", 9}, {"x-small", 10}, {"small", 13}, {"medium", 16}, {"large", 18}, {"x-large", 24}, {"xx-large", 32},
           {"xxx-large", 48}}};
      for (const auto& [k, px] : kSizes) {
        if (lv == k) {
          s.fontSizePx = px;
          return;
        }
      }
      if (lv == "larger") s.fontSizePx = parent.fontSizePx * 1.2;
      else if (lv == "smaller") s.fontSizePx = parent.fontSizePx / 1.2;
      else if (const auto l = parse_length(v); l && l->v >= 0) {
        s.fontSizePx = l->unit == Unit::percent ? l->v / 100.0 * parent.fontSizePx : resolve(*l, 0, parent.fontSizePx);
      }
    } else if (prop == "font-weight") {
      if (pick(&Style::fontWeight)) return;
      if (lv == "normal") s.fontWeight = 400;
      else if (lv == "bold") s.fontWeight = 700;
      else if (lv == "bolder") s.fontWeight = parent.fontWeight < 350 ? 400 : parent.fontWeight < 550 ? 700 : 900;
      else if (lv == "lighter") s.fontWeight = parent.fontWeight < 550 ? 100 : parent.fontWeight < 750 ? 400 : 700;
      else if (const auto n = parse_number_value(v); n && *n >= 1 && *n <= 1000) s.fontWeight = static_cast<int>(*n);
    } else if (prop == "font-style") {
      if (pick(&Style::italic)) return;
      s.italic = lv == "italic" || lv.starts_with("oblique");
    } else if (prop == "text-anchor") {
      if (pick(&Style::anchor)) return;
      if (lv == "start") s.anchor = Anchor::start;
      else if (lv == "middle") s.anchor = Anchor::middle;
      else if (lv == "end") s.anchor = Anchor::end;
    } else if (prop == "color-interpolation-filters") {
      if (pick(&Style::filtersLinearRGB)) return;
      if (lv == "srgb") s.filtersLinearRGB = false;
      else if (lv == "linearrgb" || lv == "auto") s.filtersLinearRGB = true;
    } else if (prop == "letter-spacing" || prop == "word-spacing") {
      double Style::*m = prop == "letter-spacing" ? &Style::letterSpacing : &Style::wordSpacing;
      if (pick(m)) return;
      if (lv == "normal") s.*m = 0;
      else if (const auto l = parse_length(v); l && l->unit != Unit::percent) s.*m = resolve(*l, 0, s.fontSizePx);
    } else if (prop == "shape-rendering") {
      if (pick(&Style::crispEdges)) return;
      s.crispEdges = lv == "crispedges" || lv == "optimizespeed";
    } else if (prop == "image-rendering") {
      if (pick(&Style::pixelatedImages)) return;
      s.pixelatedImages = lv == "pixelated" || lv == "optimizespeed" || lv == "crisp-edges";
    } else if (prop == "paint-order") {
      if (inherit) {
        s.paintOrderStrokeFirst = parent.paintOrderStrokeFirst;
        s.paintOrderMarkersBeforeStroke = parent.paintOrderMarkersBeforeStroke;
        return;
      }
      if (lv == "normal" || initial) {
        s.paintOrderStrokeFirst = false;
        s.paintOrderMarkersBeforeStroke = false;
        return;
      }
      // The first keyword(s) given, the rest in the default order.
      std::vector<std::string> order;
      std::string_view t = lv;
      while (!trim(t).empty()) {
        t = trim(t);
        std::size_t k = 0;
        while (k < t.size() && !is_ws(t[k])) ++k;
        order.emplace_back(t.substr(0, k));
        t.remove_prefix(k);
      }
      for (const char* d : {"fill", "stroke", "markers"}) {
        if (std::ranges::find(order, d) == order.end()) order.emplace_back(d);
      }
      const auto pos = [&](std::string_view k) { return std::ranges::find(order, k) - order.begin(); };
      s.paintOrderStrokeFirst = pos("stroke") < pos("fill");
      s.paintOrderMarkersBeforeStroke = pos("markers") < pos("stroke");
      if (pos("markers") < pos("fill")) note("paint-order with markers before fill");
    } else if (prop == "display") {
      if (pick(&Style::displayNone)) return;
      s.displayNone = lv == "none";
    } else if (prop == "clip-path" || prop == "mask" || prop == "filter") {
      std::string Style::*m = prop == "clip-path" ? &Style::clipPath : prop == "mask" ? &Style::mask : &Style::filter;
      if (pick(m)) return;
      if (const auto u = parse_url_ref(v)) {
        s.*m = *u;
      } else if (prop == "filter") {
        s.filterUnsupported = true;
        note("CSS filter functions");
      } else {
        note(std::string(prop) + ": " + std::string(v));
      }
    } else if (prop == "stop-color" || prop == "flood-color" || prop == "lighting-color") {
      css::Color Style::*m = prop == "stop-color" ? &Style::stopColor : prop == "flood-color" ? &Style::floodColor : &Style::lightingColor;
      if (pick(m)) return;
      if (const auto c = current_or(v)) s.*m = *c;
    } else if (prop == "overflow") {
      if (pick(&Style::overflowVisible)) return;
      if (lv == "visible" || lv == "auto") s.overflowVisible = true;
      else if (lv == "hidden" || lv == "scroll" || lv == "clip") s.overflowVisible = false;
    } else if (prop == "mask-type") {
      if (pick(&Style::maskAlpha)) return;
      s.maskAlpha = lv == "alpha";
    } else if (prop == "mix-blend-mode") {
      if (pick(&Style::blendMode)) return;
      s.blendMode = lv == "normal" ? "" : lv;
    } else if (prop == "isolation") {
      if (pick(&Style::isolate)) return;
      s.isolate = lv == "isolate";
    } else if (prop == "vector-effect") {
      if (lv != "none" && !inherit && !initial) note("vector-effect: " + lv);
    } else if (prop == "dominant-baseline" || prop == "alignment-baseline" || prop == "baseline-shift") {
      if (lv != "auto" && lv != "alphabetic" && lv != "baseline" && !inherit && !initial) note(std::string(prop) + ": " + lv);
    } else if (prop == "text-decoration" || prop == "text-decoration-line") {
      if (lv != "none" && !inherit && !initial) note("text-decoration");
    } else if (prop == "transform" || prop == "transform-origin" || prop == "transform-box") {
      note("CSS " + std::string(prop));
    } else if (prop == "writing-mode" || prop == "direction" || prop == "unicode-bidi" || prop == "glyph-orientation-vertical" ||
               prop == "text-orientation") {
      if (lv != "horizontal-tb" && lv != "lr" && lv != "lr-tb" && lv != "ltr" && lv != "normal" && lv != "mixed" &&
          lv != "auto" && !inherit && !initial) {
        note(std::string(prop) + ": " + lv);
      }
    } else if (prop == "font-variant" || prop == "font-stretch" || prop == "font-feature-settings" ||
               prop == "font-variation-settings" || prop == "font-kerning" || prop == "text-rendering" ||
               prop == "font-variant-ligatures") {
      if (lv != "normal" && lv != "auto" && lv != "optimizelegibility" && lv != "geometricprecision" &&
          lv != "optimizespeed" && lv != "100%" && !inherit && !initial) {
        note(std::string(prop) + ": " + lv);
      }
    } else if (prop == "animation" || prop.starts_with("animation-") || prop == "transition" || prop.starts_with("transition-")) {
      note("CSS animations");
    }
    // Everything else has no effect on the rendered image (cursor, pointer-events, …).
  }

  static bool is_inherited(std::string_view p) {
    return !(p == "opacity" || p == "display" || p == "clip-path" || p == "mask" || p == "filter" || p == "stop-color" ||
             p == "stop-opacity" || p == "flood-color" || p == "flood-opacity" || p == "lighting-color" || p == "overflow" ||
             p == "mask-type" || p == "mix-blend-mode" || p == "isolation");
  }

  static Length em_to_px(const Length& l, const Style& s) {
    if (l.unit == Unit::em || l.unit == Unit::ex) return Length{resolve(l, 0, s.fontSizePx), Unit::px};
    return l;
  }

  const Document& doc_;
  std::vector<Style>& styles_;
  std::vector<std::string>& unsupported_;
  std::vector<Rule> rules_;
};

}  // namespace

void compute_styles(const Document& doc, std::string_view extraCss, std::vector<Style>& styles,
                    std::vector<std::string>& unsupported) {
  Cascader c(doc, styles, unsupported);
  c.run(extraCss);
}

// ── data ─────────────────────────────────────────────────────────────────────

std::optional<std::vector<std::uint8_t>> base64_decode(std::string_view s) {
  std::vector<std::uint8_t> out;
  out.reserve(s.size() * 3 / 4);
  std::uint32_t acc = 0;
  int bits = 0;
  int pad = 0;
  for (const char c : s) {
    if (is_ws(c)) continue;
    int v = -1;
    if (c >= 'A' && c <= 'Z') v = c - 'A';
    else if (c >= 'a' && c <= 'z') v = c - 'a' + 26;
    else if (c >= '0' && c <= '9') v = c - '0' + 52;
    else if (c == '+' || c == '-') v = 62;
    else if (c == '/' || c == '_') v = 63;
    else if (c == '=') {
      ++pad;
      continue;
    } else {
      return std::nullopt;
    }
    if (pad > 0) return std::nullopt;
    acc = (acc << 6U) | static_cast<std::uint32_t>(v);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<std::uint8_t>((acc >> static_cast<unsigned>(bits)) & 0xFFU));
    }
  }
  if (pad > 2) return std::nullopt;
  return out;
}

std::optional<std::vector<std::uint8_t>> data_url_bytes(std::string_view url, std::string* mime) {
  std::string_view u = trim(url);
  if (u.size() < 5 || lower(u.substr(0, 5)) != "data:") return std::nullopt;
  u.remove_prefix(5);
  const std::size_t comma = u.find(',');
  if (comma == std::string_view::npos) return std::nullopt;
  const std::string meta = lower(u.substr(0, comma));
  const std::string_view body = u.substr(comma + 1);
  if (mime != nullptr) *mime = meta.substr(0, meta.find(';'));
  if (meta.find(";base64") != std::string::npos) return base64_decode(body);
  std::vector<std::uint8_t> out;
  out.reserve(body.size());
  for (std::size_t i = 0; i < body.size(); ++i) {
    if (body[i] == '%' && i + 2 < body.size()) {
      const auto hv = [](char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1; };
      const int hi = hv(body[i + 1]);
      const int lo = hv(body[i + 2]);
      if (hi >= 0 && lo >= 0) {
        out.push_back(static_cast<std::uint8_t>(hi * 16 + lo));
        i += 2;
        continue;
      }
    }
    out.push_back(static_cast<std::uint8_t>(body[i]));
  }
  return out;
}

}  // namespace premation::raster::svg
