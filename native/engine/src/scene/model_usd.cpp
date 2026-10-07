// ASCII USD (.usda) and .usdz → SceneModel (model_convert.hpp, AE parity 4.7).
//
// A reader for the layer structure exporters actually write: `def` / `over`
// prims (Xform, Scope, Mesh, Material, Shader), xformOps (translate, rotate*,
// scale, transform, in xformOpOrder), Mesh topology (faceVertexCounts /
// Indices, points, normals, primvars:st with indices, displayColor,
// orientation), material:binding to a UsdPreviewSurface (diffuseColor,
// metallic, roughness, emissiveColor, opacity, ior, normal) and the
// UsdUVTexture files feeding it. The stage's upAxis and metersPerUnit are
// honoured. Not read: composition arcs (references, payloads, sublayers,
// variants), GeomSubsets, skeletal data and time samples (the default value
// wins) — each reported. A .usdz is a store-only zip whose first layer is the
// root; a binary crate (.usdc) layer is refused with the alternatives.
#include <algorithm>
#include <cctype>
#include <charconv>
#include <cmath>
#include <cstring>
#include <map>
#include <memory>
#include <numbers>
#include <string>
#include <variant>

#include "model_convert.hpp"

namespace premation::scene::modelio {
namespace {

// ── tokens ──────────────────────────────────────────────────────────────────

enum class Tok : std::uint8_t { end, ident, number, string, path, asset, punct };

struct Token {
  Tok kind = Tok::end;
  std::string text;
};

class Lexer {
 public:
  explicit Lexer(std::string_view s) : s_(s) {}

  Token next() {
    skip_ws();
    if (i_ >= s_.size()) return {Tok::end, ""};
    const char c = s_[i_];
    if (c == '"' || c == '\'') return string_tok(c);
    if (c == '@') return asset_tok();
    if (c == '<') {
      const auto e = s_.find('>', i_);
      if (e == std::string_view::npos) throw ConvertError("USD: an unterminated path");
      Token t{Tok::path, std::string(s_.substr(i_ + 1, e - i_ - 1))};
      i_ = e + 1;
      return t;
    }
    if (std::string_view("()[]{}=,;").find(c) != std::string_view::npos) {
      ++i_;
      return {Tok::punct, std::string(1, c)};
    }
    if (std::isdigit(static_cast<unsigned char>(c)) != 0 || ((c == '-' || c == '+' || c == '.') && i_ + 1 < s_.size() &&
                                                             (std::isdigit(static_cast<unsigned char>(s_[i_ + 1])) != 0 || s_[i_ + 1] == '.'))) {
      const std::size_t st = i_;
      ++i_;
      while (i_ < s_.size() && (std::isalnum(static_cast<unsigned char>(s_[i_])) != 0 || s_[i_] == '.' || s_[i_] == '-' || s_[i_] == '+')) ++i_;
      return {Tok::number, std::string(s_.substr(st, i_ - st))};
    }
    const std::size_t st = i_;
    while (i_ < s_.size()) {
      const char d = s_[i_];
      if (std::isalnum(static_cast<unsigned char>(d)) != 0 || d == '_' || d == ':' || d == '.' || d == '-' || d == '#') {
        ++i_;
        continue;
      }
      break;
    }
    if (i_ == st) ++i_;  // an unknown character: skip it as a punct
    return {Tok::ident, std::string(s_.substr(st, i_ - st))};
  }

 private:
  void skip_ws() {
    while (i_ < s_.size()) {
      const char c = s_[i_];
      if (std::isspace(static_cast<unsigned char>(c)) != 0) {
        ++i_;
      } else if (c == '#' && (i_ == 0 || s_[i_ - 1] == '\n' || std::isspace(static_cast<unsigned char>(s_[i_ - 1])) != 0) &&
                 !(i_ + 4 < s_.size() && s_.substr(i_, 5) == "#usda")) {
        while (i_ < s_.size() && s_[i_] != '\n') ++i_;
      } else if (c == '#' && s_.substr(i_, 5) == "#usda") {
        while (i_ < s_.size() && s_[i_] != '\n') ++i_;  // the header line
      } else {
        break;
      }
    }
  }

  Token string_tok(char q) {
    const bool triple = i_ + 2 < s_.size() && s_[i_ + 1] == q && s_[i_ + 2] == q;
    std::string out;
    if (triple) {
      const std::string term(3, q);
      const auto e = s_.find(term, i_ + 3);
      if (e == std::string_view::npos) throw ConvertError("USD: an unterminated string");
      out = std::string(s_.substr(i_ + 3, e - i_ - 3));
      i_ = e + 3;
      return {Tok::string, out};
    }
    ++i_;
    while (i_ < s_.size() && s_[i_] != q) {
      if (s_[i_] == '\\' && i_ + 1 < s_.size()) ++i_;
      out.push_back(s_[i_]);
      ++i_;
    }
    ++i_;
    return {Tok::string, out};
  }

  Token asset_tok() {
    if (s_.substr(i_, 3) == "@@@") {
      const auto e = s_.find("@@@", i_ + 3);
      if (e == std::string_view::npos) throw ConvertError("USD: an unterminated asset path");
      Token t{Tok::asset, std::string(s_.substr(i_ + 3, e - i_ - 3))};
      i_ = e + 3;
      return t;
    }
    const auto e = s_.find('@', i_ + 1);
    if (e == std::string_view::npos) throw ConvertError("USD: an unterminated asset path");
    Token t{Tok::asset, std::string(s_.substr(i_ + 1, e - i_ - 1))};
    i_ = e + 1;
    return t;
  }

  std::string_view s_;
  std::size_t i_ = 0;
};

// ── values ──────────────────────────────────────────────────────────────────

struct Value;
using ValueList = std::vector<Value>;
struct Value {
  enum class K : std::uint8_t { none, number, string, path, asset, list, tuple } k = K::none;
  double n = 0;
  std::string s;
  std::shared_ptr<ValueList> items;
};

struct Prim {
  std::string type;
  std::string name;
  std::string path;
  std::map<std::string, Value, std::less<>> props;  ///< attribute name (".connect" kept in the name) → value
  std::map<std::string, std::string, std::less<>> rels;
  std::map<std::string, std::string, std::less<>> meta;  ///< interpolation per attribute: "<name>:interpolation"
  std::vector<std::unique_ptr<Prim>> children;
};

class Parser {
 public:
  explicit Parser(std::string_view s) : lx_(s) { advance(); }

  std::unique_ptr<Prim> parse_layer(std::map<std::string, Value, std::less<>>& layerMeta, std::vector<std::string>& warnings) {
    auto root = std::make_unique<Prim>();
    root->path = "";
    if (is_punct("(")) parse_metadata(layerMeta, nullptr, warnings);
    while (t_.kind != Tok::end) {
      if (t_.kind == Tok::ident && (t_.text == "def" || t_.text == "over" || t_.text == "class")) {
        auto p = parse_prim("", warnings);
        if (p) root->children.push_back(std::move(p));
      } else {
        advance();
      }
    }
    return root;
  }

 private:
  void advance() { t_ = lx_.next(); }
  bool is_punct(const char* p) const { return t_.kind == Tok::punct && t_.text == p; }
  void expect(const char* p) {
    if (!is_punct(p)) throw ConvertError(std::string("USD: expected '") + p + "' near '" + t_.text + "'");
    advance();
  }

  /// `( key = value … )` metadata. Collects into `into` (layer or prop metadata); notes composition arcs.
  void parse_metadata(std::map<std::string, Value, std::less<>>& into, const std::string* forProp, std::vector<std::string>& warnings) {
    expect("(");
    while (!is_punct(")") && t_.kind != Tok::end) {
      if (t_.kind == Tok::string) {  // a doc string
        advance();
        continue;
      }
      if (t_.kind == Tok::ident) {
        std::string key = t_.text;
        advance();
        if (key == "prepend" || key == "append" || key == "add" || key == "delete" || key == "reorder") {
          if (t_.kind == Tok::ident) {
            key = t_.text;
            advance();
          }
        }
        if (key == "references" || key == "payload" || key == "subLayers" || key == "inherits" || key == "variantSets" ||
            key == "specializes") {
          warnings.push_back("USD " + key + " are not followed (only the layer's own prims import)");
        }
        if (is_punct("=")) {
          advance();
          Value v = parse_value();
          if (forProp == nullptr) into[key] = std::move(v);
          else into[*forProp + ":" + key] = std::move(v);
        } else if (is_punct("{")) {
          skip_block("{", "}");
        }
        continue;
      }
      if (is_punct(";") || is_punct(",")) {
        advance();
        continue;
      }
      advance();
    }
    expect(")");
  }

  void skip_block(const char* open, const char* close) {
    int depth = 0;
    do {
      if (is_punct(open)) ++depth;
      else if (is_punct(close)) --depth;
      advance();
    } while (depth > 0 && t_.kind != Tok::end);
  }

  Value parse_value() {
    Value v;
    if (t_.kind == Tok::number) {
      v.k = Value::K::number;
      const auto r = std::from_chars(t_.text.data() + (t_.text.front() == '+' ? 1 : 0), t_.text.data() + t_.text.size(), v.n);
      if (r.ec != std::errc()) v.n = 0;
      advance();
    } else if (t_.kind == Tok::string || t_.kind == Tok::ident) {
      v.k = t_.kind == Tok::string ? Value::K::string : Value::K::string;
      v.s = t_.text;
      if (t_.kind == Tok::ident && (t_.text == "None" || t_.text == "none")) v.k = Value::K::none;
      if (t_.kind == Tok::ident && (t_.text == "inf" || t_.text == "-inf" || t_.text == "nan")) {
        v.k = Value::K::number;
        v.n = t_.text == "inf" ? std::numeric_limits<double>::infinity() : t_.text == "-inf" ? -std::numeric_limits<double>::infinity() : 0;
      }
      advance();
    } else if (t_.kind == Tok::path) {
      v.k = Value::K::path;
      v.s = t_.text;
      advance();
    } else if (t_.kind == Tok::asset) {
      v.k = Value::K::asset;
      v.s = t_.text;
      advance();
    } else if (is_punct("[") || is_punct("(")) {
      const bool list = is_punct("[");
      v.k = list ? Value::K::list : Value::K::tuple;
      v.items = std::make_shared<ValueList>();
      const char* close = list ? "]" : ")";
      advance();
      while (!is_punct(close) && t_.kind != Tok::end) {
        if (is_punct(",")) {
          advance();
          continue;
        }
        v.items->push_back(parse_value());
      }
      expect(close);
    } else if (is_punct("{")) {
      skip_block("{", "}");  // a dictionary or time samples
    } else {
      advance();
    }
    return v;
  }

  std::unique_ptr<Prim> parse_prim(const std::string& parentPath, std::vector<std::string>& warnings) {
    const std::string specifier = t_.text;
    advance();
    auto p = std::make_unique<Prim>();
    if (t_.kind == Tok::ident) {
      p->type = t_.text;
      advance();
    }
    if (t_.kind != Tok::string) throw ConvertError("USD: a prim without a name");
    p->name = t_.text;
    p->path = parentPath + "/" + p->name;
    advance();
    if (is_punct("(")) {
      std::map<std::string, Value, std::less<>> meta;
      parse_metadata(meta, nullptr, warnings);
    }
    expect("{");
    while (!is_punct("}") && t_.kind != Tok::end) {
      if (t_.kind == Tok::ident && (t_.text == "def" || t_.text == "over" || t_.text == "class")) {
        if (auto c = parse_prim(p->path, warnings)) p->children.push_back(std::move(c));
        continue;
      }
      if (t_.kind == Tok::ident && t_.text == "variantSet") {
        warnings.push_back("USD variant sets are not followed");
        while (!is_punct("{") && t_.kind != Tok::end) advance();
        skip_block("{", "}");
        continue;
      }
      if (t_.kind == Tok::ident) {
        parse_property(*p, warnings);
        continue;
      }
      advance();
    }
    expect("}");
    if (specifier == "class") return nullptr;  // an abstract prim draws nothing
    return p;
  }

  void parse_property(Prim& p, std::vector<std::string>& warnings) {
    // [custom] [uniform|varying] type[[]] name[.connect|.timeSamples] [= value] [(metadata)]
    // rel name [= <path>]
    std::vector<std::string> words;
    while (t_.kind == Tok::ident) {
      words.push_back(t_.text);
      advance();
      if (is_punct("[")) {  // `float3[]`: the array marker belongs to the type
        advance();
        if (is_punct("]")) advance();
        words.back() += "[]";
      }
    }
    if (words.empty()) {
      advance();
      return;
    }
    const std::string name = words.back();
    const bool isRel = std::ranges::find(words, "rel") != words.end();
    if (is_punct("=")) {
      advance();
      if (name.ends_with(".timeSamples")) {
        if (is_punct("{")) skip_block("{", "}");
        warnings.push_back("USD time samples are not read (the default value imports)");
      } else {
        Value v = parse_value();
        if (isRel) {
          if (v.k == Value::K::path) p.rels[name] = v.s;
          else if (v.k == Value::K::list && v.items && !v.items->empty() && v.items->front().k == Value::K::path) p.rels[name] = v.items->front().s;
        } else {
          p.props[name] = std::move(v);
        }
      }
    }
    if (is_punct("(")) {
      std::map<std::string, Value, std::less<>> meta;
      parse_metadata(meta, &name, warnings);
      for (auto& [k, v] : meta) {
        if (v.k == Value::K::string) p.meta[k] = v.s;
      }
    }
  }

  Lexer lx_;
  Token t_;
};

// ── scene building ──────────────────────────────────────────────────────────

using M4 = std::array<double, 16>;  // column-major

M4 identity() { return {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1}; }

M4 mul(const M4& a, const M4& b) {
  M4 o{};
  for (std::size_t c = 0; c < 4; ++c) {
    for (std::size_t r = 0; r < 4; ++r) {
      double s = 0;
      for (std::size_t k = 0; k < 4; ++k) s += a.at(k * 4 + r) * b.at(c * 4 + k);
      o.at(c * 4 + r) = s;
    }
  }
  return o;
}

M4 rot_axis(int axis, double deg) {
  const double a = deg * std::numbers::pi / 180;
  const double c = std::cos(a);
  const double s = std::sin(a);
  M4 m = identity();
  if (axis == 0) {
    m[5] = c;
    m[6] = s;
    m[9] = -s;
    m[10] = c;
  } else if (axis == 1) {
    m[0] = c;
    m[2] = -s;
    m[8] = s;
    m[10] = c;
  } else {
    m[0] = c;
    m[1] = s;
    m[4] = -s;
    m[5] = c;
  }
  return m;
}

std::vector<double> nums(const Value& v) {
  std::vector<double> out;
  if (v.k == Value::K::number) {
    out.push_back(v.n);
  } else if ((v.k == Value::K::list || v.k == Value::K::tuple) && v.items) {
    for (const Value& x : *v.items) {
      const auto sub = nums(x);
      out.insert(out.end(), sub.begin(), sub.end());
    }
  }
  return out;
}

/// The prim's local matrix from its xformOps, in xformOpOrder (USD: the first op is outermost).
M4 local_matrix(const Prim& p) {
  std::vector<std::string> order;
  if (const auto it = p.props.find("xformOpOrder"); it != p.props.end() && it->second.items) {
    for (const Value& v : *it->second.items) order.push_back(v.s);
  } else {
    for (const auto& [k, v] : p.props) {
      if (k.starts_with("xformOp:")) order.push_back(k);
    }
  }
  M4 m = identity();
  for (std::string op : order) {
    bool inverse = false;
    if (op.starts_with("!invert!")) {
      inverse = true;
      op = op.substr(8);
    }
    const auto it = p.props.find(op);
    if (it == p.props.end()) continue;
    const std::vector<double> v = nums(it->second);
    const std::string kind = op.substr(8, op.find(':', 8) == std::string::npos ? std::string::npos : op.find(':', 8) - 8);
    M4 o = identity();
    if (kind == "translate" && v.size() >= 3) {
      o[12] = inverse ? -v[0] : v[0];
      o[13] = inverse ? -v[1] : v[1];
      o[14] = inverse ? -v[2] : v[2];
    } else if (kind == "scale" && v.size() >= 3) {
      o[0] = inverse && v[0] != 0 ? 1 / v[0] : v[0];
      o[5] = inverse && v[1] != 0 ? 1 / v[1] : v[1];
      o[10] = inverse && v[2] != 0 ? 1 / v[2] : v[2];
    } else if (kind.starts_with("rotate") && kind.size() == 7 && !v.empty()) {
      const int ax = kind[6] == 'X' ? 0 : kind[6] == 'Y' ? 1 : 2;
      o = rot_axis(ax, inverse ? -v[0] : v[0]);
    } else if (kind.starts_with("rotate") && kind.size() == 9 && v.size() >= 3) {
      // rotateXYZ: X first, then Y, then Z (column vectors: Rz·Ry·Rx) — the letters name the application order.
      const std::array<int, 3> axes = {kind[6] - 'X', kind[7] - 'X', kind[8] - 'X'};
      for (std::size_t k = 0; k < 3; ++k) {
        const int ax = axes.at(k);
        o = mul(rot_axis(ax, v.at(static_cast<std::size_t>(ax))), o);
      }
      if (inverse) {
        M4 t = o;  // a rotation's inverse is its transpose
        for (std::size_t c = 0; c < 3; ++c) {
          for (std::size_t r = 0; r < 3; ++r) o.at(c * 4 + r) = t.at(r * 4 + c);
        }
      }
    } else if (kind == "transform" && v.size() >= 16) {
      // USD matrices are row-major with row vectors: the same 16 numbers are a column-major column-vector matrix.
      for (std::size_t k = 0; k < 16; ++k) o.at(k) = v[k];
    } else if (kind == "orient" && v.size() >= 4) {
      // quaternion (w, x, y, z)
      const double w = v[0], x = v[1], y = v[2], z = v[3];
      o = {1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0, 2 * (x * y - z * w), 1 - 2 * (x * x + z * z),
           2 * (y * z + x * w), 0, 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0, 0, 0, 0, 1};
    } else {
      continue;
    }
    m = mul(m, o);
  }
  return m;
}

/// TRS of a column-major matrix (no shear): translation, quaternion xyzw, scale.
void decompose(const M4& m, NodeDef& n) {
  n.translation = {m[12], m[13], m[14]};
  double sx = std::hypot(m[0], m[1], m[2]);
  const double sy = std::hypot(m[4], m[5], m[6]);
  const double sz = std::hypot(m[8], m[9], m[10]);
  const double det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (det < 0) sx = -sx;
  n.scale = {sx, sy, sz};
  const double r00 = sx != 0 ? m[0] / sx : 1, r10 = sx != 0 ? m[1] / sx : 0, r20 = sx != 0 ? m[2] / sx : 0;
  const double r01 = sy != 0 ? m[4] / sy : 0, r11 = sy != 0 ? m[5] / sy : 1, r21 = sy != 0 ? m[6] / sy : 0;
  const double r02 = sz != 0 ? m[8] / sz : 0, r12 = sz != 0 ? m[9] / sz : 0, r22 = sz != 0 ? m[10] / sz : 1;
  const double tr = r00 + r11 + r22;
  double qw = 1, qx = 0, qy = 0, qz = 0;
  if (tr > 0) {
    const double s = std::sqrt(tr + 1) * 2;
    qw = 0.25 * s;
    qx = (r21 - r12) / s;
    qy = (r02 - r20) / s;
    qz = (r10 - r01) / s;
  } else if (r00 > r11 && r00 > r22) {
    const double s = std::sqrt(1 + r00 - r11 - r22) * 2;
    qw = (r21 - r12) / s;
    qx = 0.25 * s;
    qy = (r01 + r10) / s;
    qz = (r02 + r20) / s;
  } else if (r11 > r22) {
    const double s = std::sqrt(1 + r11 - r00 - r22) * 2;
    qw = (r02 - r20) / s;
    qx = (r01 + r10) / s;
    qy = 0.25 * s;
    qz = (r12 + r21) / s;
  } else {
    const double s = std::sqrt(1 + r22 - r00 - r11) * 2;
    qw = (r10 - r01) / s;
    qx = (r02 + r20) / s;
    qy = (r12 + r21) / s;
    qz = 0.25 * s;
  }
  const double l = std::sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
  n.rotation = l > 0 ? std::array<double, 4>{qx / l, qy / l, qz / l, qw / l} : std::array<double, 4>{0, 0, 0, 1};
}

std::string mime_of(const std::vector<std::uint8_t>& b) {
  if (b.size() >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return "image/jpeg";
  if (b.size() >= 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F') return "image/webp";
  return "image/png";
}

class Builder {
 public:
  Builder(const FileSet& files, std::string baseDir, std::vector<std::string>& warnings)
      : files_(files), baseDir_(std::move(baseDir)), warnings_(warnings) {}

  SceneModel scene;

  void index(const Prim& p) {
    byPath_[p.path] = &p;
    for (const auto& c : p.children) index(*c);
  }

  int node(const Prim& p, bool leftHandedParent) {
    (void)leftHandedParent;
    if (p.type == "Material" || p.type == "Shader" || p.type == "NodeGraph" || p.type == "GeomSubset") return -1;
    NodeDef n;
    n.name = p.name;
    decompose(local_matrix(p), n);
    if (p.type == "Mesh") n.mesh = mesh(p);
    for (const auto& c : p.children) {
      if (c->type == "GeomSubset") warnGeomSubset_ = true;
    }
    if (p.type == "Skeleton" || p.type == "SkelRoot") warnSkel_ = true;
    scene.nodes.push_back(std::move(n));
    const int self = static_cast<int>(scene.nodes.size()) - 1;
    for (const auto& c : p.children) {
      const int ci = node(*c, false);
      if (ci >= 0) scene.nodes[static_cast<std::size_t>(self)].children.push_back(ci);
    }
    return self;
  }

  void finish() {
    if (warnGeomSubset_) warnings_.emplace_back("USD GeomSubsets (per-face materials) import with the mesh's own material");
    if (warnSkel_) warnings_.emplace_back("USD skeletons are not converted (the meshes import in their rest pose)");
  }

 private:
  const Value* prop(const Prim& p, std::string_view name) const {
    const auto it = p.props.find(name);
    return it == p.props.end() ? nullptr : &it->second;
  }

  std::string interp(const Prim& p, std::string_view name) const {
    const auto it = p.meta.find(std::string(name) + ":interpolation");
    return it == p.meta.end() ? std::string() : it->second;
  }

  /// The shader prim a `.connect` path points at (`/a/b/Shader.outputs:rgb` → `/a/b/Shader`).
  const Prim* connected(const Prim& shader, std::string_view input) const {
    const Value* c = prop(shader, std::string(input) + ".connect");
    if (c == nullptr) return nullptr;
    std::string path = c->k == Value::K::path ? c->s : (c->items && !c->items->empty() ? c->items->front().s : std::string());
    const auto dot = path.rfind('.');
    if (dot != std::string::npos) path = path.substr(0, dot);
    const auto it = byPath_.find(path);
    return it == byPath_.end() ? nullptr : it->second;
  }

  int texture_from(const Prim* tex) {
    if (tex == nullptr) return -1;
    const Value* f = prop(*tex, "inputs:file");
    if (f == nullptr || f->k != Value::K::asset) return -1;
    if (const auto it = textureIndex_.find(f->s); it != textureIndex_.end()) return it->second;
    std::string uri = f->s;
    if (uri.starts_with("./")) uri = uri.substr(2);
    const SourceFile* src = files_.find(baseDir_.empty() ? uri : baseDir_ + "/" + uri);
    if (src == nullptr) src = files_.find(uri);
    int index = -1;
    if (src == nullptr) {
      warnings_.push_back("texture “" + f->s + "” was not in the selection");
    } else {
      TextureDef t;
      t.bytes = src->bytes;
      t.mimeType = mime_of(t.bytes);
      scene.textures.push_back(std::move(t));
      index = static_cast<int>(scene.textures.size()) - 1;
    }
    textureIndex_.emplace(f->s, index);
    return index;
  }

  int material(const std::string& path) {
    if (const auto it = materialIndex_.find(path); it != materialIndex_.end()) return it->second;
    const auto mp = byPath_.find(path);
    int index = -1;
    if (mp != byPath_.end()) {
      const Prim& mat = *mp->second;
      // The surface shader: outputs:surface.connect, else the first UsdPreviewSurface child.
      const Prim* surf = connected(mat, "outputs:surface");
      if (surf == nullptr) {
        for (const auto& c : mat.children) {
          const Value* id = prop(*c, "info:id");
          if (id != nullptr && id->s == "UsdPreviewSurface") surf = c.get();
        }
      }
      MaterialDef md;
      md.name = mat.name;
      if (surf != nullptr) {
        const auto f3 = [&](std::string_view k, std::array<double, 3> fb) {
          const Value* v = prop(*surf, k);
          const auto n = v != nullptr ? nums(*v) : std::vector<double>{};
          return n.size() >= 3 ? std::array<double, 3>{n[0], n[1], n[2]} : fb;
        };
        const auto f1 = [&](std::string_view k, double fb) {
          const Value* v = prop(*surf, k);
          return v != nullptr && v->k == Value::K::number ? v->n : fb;
        };
        const auto dc = f3("inputs:diffuseColor", {0.18, 0.18, 0.18});
        md.baseColor = {dc[0], dc[1], dc[2], 1};
        md.baseColorTexture = texture_from(connected(*surf, "inputs:diffuseColor"));
        if (md.baseColorTexture >= 0) md.baseColor = {1, 1, 1, 1};
        md.metallic = std::clamp(f1("inputs:metallic", 0), 0.0, 1.0);
        md.roughness = std::clamp(f1("inputs:roughness", 0.5), 0.0, 1.0);
        md.emissive = f3("inputs:emissiveColor", {0, 0, 0});
        md.emissiveTexture = texture_from(connected(*surf, "inputs:emissiveColor"));
        md.normalTexture = texture_from(connected(*surf, "inputs:normal"));
        const double opacity = std::clamp(f1("inputs:opacity", 1), 0.0, 1.0);
        const double threshold = f1("inputs:opacityThreshold", 0);
        if (opacity < 0.999) {
          md.baseColor[3] = opacity;
          md.alphaMode = threshold > 0 ? "MASK" : "BLEND";
          md.alphaCutoff = threshold;
        }
        md.ior = std::clamp(f1("inputs:ior", 1.5), 1.0, 4.0);
      }
      scene.materials.push_back(std::move(md));
      index = static_cast<int>(scene.materials.size()) - 1;
    }
    materialIndex_.emplace(path, index);
    return index;
  }

  int mesh(const Prim& p) {
    const Value* counts = prop(p, "faceVertexCounts");
    const Value* fvi = prop(p, "faceVertexIndices");
    const Value* pts = prop(p, "points");
    if (counts == nullptr || fvi == nullptr || pts == nullptr) return -1;
    const std::vector<double> cnt = nums(*counts);
    const std::vector<double> idx = nums(*fvi);
    const std::vector<double> P = nums(*pts);
    const Value* nv = prop(p, "normals");
    if (nv == nullptr) nv = prop(p, "primvars:normals");
    const std::vector<double> N = nv != nullptr ? nums(*nv) : std::vector<double>{};
    const std::string nInterp = nv != nullptr ? (interp(p, "normals").empty() ? interp(p, "primvars:normals") : interp(p, "normals")) : "";
    const Value* stv = prop(p, "primvars:st");
    if (stv == nullptr) stv = prop(p, "primvars:UVMap");
    const std::vector<double> ST = stv != nullptr ? nums(*stv) : std::vector<double>{};
    const std::string stName = prop(p, "primvars:st") != nullptr ? "primvars:st" : "primvars:UVMap";
    const Value* sti = prop(p, stName + ":indices");
    const std::vector<double> STI = sti != nullptr ? nums(*sti) : std::vector<double>{};
    const std::string stInterp = interp(p, stName);
    const Value* dcv = prop(p, "primvars:displayColor");
    const std::vector<double> DC = dcv != nullptr ? nums(*dcv) : std::vector<double>{};
    const std::string dcInterp = interp(p, "primvars:displayColor");
    const Value* orient = prop(p, "orientation");
    const bool leftHanded = orient != nullptr && orient->s == "leftHanded";
    const std::size_t nPts = P.size() / 3;
    const std::size_t nFv = idx.size();

    // Corner attribute lookups by interpolation (vertex / faceVarying / uniform / constant).
    const auto pick = [&](const std::vector<double>& data, std::size_t comps, const std::string& in, std::size_t pointIx, std::size_t cornerIx,
                          std::size_t faceIx, const std::vector<double>* indices) -> std::optional<std::size_t> {
      if (data.empty()) return std::nullopt;
      std::size_t k = 0;
      if (in == "faceVarying") k = cornerIx;
      else if (in == "uniform") k = faceIx;
      else if (in == "constant") k = 0;
      else k = pointIx;  // vertex / varying / unspecified
      if (indices != nullptr && !indices->empty()) {
        if (k >= indices->size()) return std::nullopt;
        k = static_cast<std::size_t>((*indices)[k]);
      }
      if ((k + 1) * comps > data.size()) {
        // Unspecified interpolation with faceVarying-sized data.
        if (in.empty() && (cornerIx + 1) * comps <= data.size() && data.size() / comps == nFv) return cornerIx;
        return std::nullopt;
      }
      return k;
    };

    PrimitiveDef prim;
    const bool hasN = !N.empty();
    const bool hasUv = !ST.empty();
    const bool hasC = DC.size() >= 3 && !(DC.size() == 3 && DC[0] == DC[1] && DC[1] == DC[2] && (dcInterp.empty() || dcInterp == "constant"));
    std::map<std::array<std::int64_t, 4>, std::uint32_t> weld;
    std::size_t corner = 0;
    for (std::size_t f = 0; f < cnt.size(); ++f) {
      const auto n = static_cast<std::size_t>(cnt[f]);
      std::vector<std::uint32_t> poly;
      for (std::size_t c = 0; c < n; ++c, ++corner) {
        if (corner >= nFv) break;
        const auto pi = static_cast<std::size_t>(idx[corner]);
        if (pi >= nPts) continue;
        const auto ni = hasN ? pick(N, 3, nInterp, pi, corner, f, nullptr) : std::nullopt;
        const auto ti = hasUv ? pick(ST, 2, stInterp, pi, corner, f, &STI) : std::nullopt;
        const auto ci = hasC ? pick(DC, 3, dcInterp, pi, corner, f, nullptr) : std::nullopt;
        const std::array<std::int64_t, 4> key = {static_cast<std::int64_t>(pi), ni ? static_cast<std::int64_t>(*ni) : -1,
                                                 ti ? static_cast<std::int64_t>(*ti) : -1, ci ? static_cast<std::int64_t>(*ci) : -1};
        auto it = weld.find(key);
        if (it == weld.end()) {
          const auto vi = static_cast<std::uint32_t>(prim.positions.size() / 3);
          prim.positions.insert(prim.positions.end(), {static_cast<float>(P[pi * 3]), static_cast<float>(P[pi * 3 + 1]), static_cast<float>(P[pi * 3 + 2])});
          if (hasN) {
            const std::size_t k = ni.value_or(0);
            const bool ok = ni && (k + 1) * 3 <= N.size();
            prim.normals.insert(prim.normals.end(), {ok ? static_cast<float>(N[k * 3]) : 0.0F, ok ? static_cast<float>(N[k * 3 + 1]) : 1.0F,
                                                     ok ? static_cast<float>(N[k * 3 + 2]) : 0.0F});
          }
          if (hasUv) {
            const std::size_t k = ti.value_or(0);
            const bool ok = ti && (k + 1) * 2 <= ST.size();
            prim.uvs.insert(prim.uvs.end(), {ok ? static_cast<float>(ST[k * 2]) : 0.0F, ok ? static_cast<float>(1.0 - ST[k * 2 + 1]) : 0.0F});
          }
          if (hasC) {
            const std::size_t k = ci.value_or(0);
            const bool ok = ci && (k + 1) * 3 <= DC.size();
            prim.colors.insert(prim.colors.end(), {ok ? static_cast<float>(DC[k * 3]) : 1.0F, ok ? static_cast<float>(DC[k * 3 + 1]) : 1.0F,
                                                   ok ? static_cast<float>(DC[k * 3 + 2]) : 1.0F, 1.0F});
          }
          it = weld.emplace(key, vi).first;
        }
        poly.push_back(it->second);
      }
      for (std::size_t k = 1; k + 1 < poly.size(); ++k) {
        if (leftHanded) {
          prim.indices.insert(prim.indices.end(), {poly[0], poly[k + 1], poly[k]});
        } else {
          prim.indices.insert(prim.indices.end(), {poly[0], poly[k], poly[k + 1]});
        }
      }
    }
    if (prim.normals.size() != prim.positions.size()) prim.normals.clear();
    if (const auto it = p.rels.find("material:binding"); it != p.rels.end()) prim.material = material(it->second);
    if (prim.material < 0 && DC.size() >= 3 && !hasC) {
      // A constant display colour is the mesh's colour.
      MaterialDef md;
      md.name = p.name + " display color";
      md.baseColor = {DC[0], DC[1], DC[2], 1};
      scene.materials.push_back(std::move(md));
      prim.material = static_cast<int>(scene.materials.size()) - 1;
    }
    MeshDef m;
    m.name = p.name;
    if (!prim.indices.empty()) m.primitives.push_back(std::move(prim));
    scene.meshes.push_back(std::move(m));
    return static_cast<int>(scene.meshes.size()) - 1;
  }

  const FileSet& files_;
  std::string baseDir_;
  std::vector<std::string>& warnings_;
  std::map<std::string, const Prim*, std::less<>> byPath_;
  std::map<std::string, int, std::less<>> materialIndex_;
  std::map<std::string, int, std::less<>> textureIndex_;
  bool warnGeomSubset_ = false;
  bool warnSkel_ = false;
};

// ── usdz (a store-only zip) ─────────────────────────────────────────────────

std::uint32_t rd32(std::span<const std::uint8_t> b, std::size_t o) {
  if (o + 4 > b.size()) throw ConvertError("the .usdz is truncated");
  return static_cast<std::uint32_t>(b[o]) | (static_cast<std::uint32_t>(b[o + 1]) << 8U) | (static_cast<std::uint32_t>(b[o + 2]) << 16U) |
         (static_cast<std::uint32_t>(b[o + 3]) << 24U);
}
std::uint16_t rd16(std::span<const std::uint8_t> b, std::size_t o) {
  if (o + 2 > b.size()) throw ConvertError("the .usdz is truncated");
  return static_cast<std::uint16_t>(b[o] | (b[o + 1] << 8U));
}

}  // namespace

SceneModel load_usda(std::string_view text, const FileSet& files, std::string_view baseDir) {
  std::map<std::string, Value, std::less<>> layerMeta;
  std::vector<std::string> warnings;
  Parser parser(text);
  std::unique_ptr<Prim> root = parser.parse_layer(layerMeta, warnings);
  Builder b(files, std::string(baseDir), warnings);
  b.index(*root);
  std::vector<int> tops;
  for (const auto& c : root->children) {
    const int n = b.node(*c, false);
    if (n >= 0) tops.push_back(n);
  }
  b.finish();
  // The stage's axis and units onto a wrapper node: glTF is Y up, in metres.
  const auto up = layerMeta.find("upAxis");
  const bool zUp = up != layerMeta.end() && up->second.s == "Z";
  const auto mpu = layerMeta.find("metersPerUnit");
  const double meters = mpu != layerMeta.end() && mpu->second.k == Value::K::number && mpu->second.n > 0 ? mpu->second.n : 0.01;
  NodeDef stage;
  stage.name = "Stage";
  stage.scale = {meters, meters, meters};
  if (zUp) stage.rotation = {-std::sqrt(0.5), 0, 0, std::sqrt(0.5)};  // −90° about X: Z up → Y up
  stage.children = tops;
  b.scene.nodes.push_back(std::move(stage));
  b.scene.roots.push_back(static_cast<int>(b.scene.nodes.size()) - 1);
  // De-duplicate repeated warnings, in first-seen order.
  for (const std::string& w : warnings) {
    if (std::ranges::find(b.scene.warnings, w) == b.scene.warnings.end()) b.scene.warnings.push_back(w);
  }
  return std::move(b.scene);
}

SceneModel load_usdz(const FileSet& files) {
  const std::vector<std::uint8_t>& z = files.model().bytes;
  const std::span<const std::uint8_t> zs(z);
  std::vector<SourceFile> entries;
  std::size_t o = 0;
  while (o + 30 <= z.size() && rd32(zs, o) == 0x04034b50U) {
    const std::uint16_t flags = rd16(zs, o + 6);
    const std::uint16_t method = rd16(zs, o + 8);
    std::uint32_t csize = rd32(zs, o + 18);
    const std::uint16_t nameLen = rd16(zs, o + 26);
    const std::uint16_t extraLen = rd16(zs, o + 28);
    if (o + 30 + nameLen > z.size()) throw ConvertError("the .usdz is truncated");
    const std::string name(reinterpret_cast<const char*>(z.data() + o + 30), nameLen);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
    const std::size_t data = o + 30 + nameLen + extraLen;
    if ((flags & 0x8U) != 0) throw ConvertError("the .usdz uses streamed zip entries, which USDZ does not allow");
    if (method != 0) throw ConvertError("the .usdz is compressed (USDZ requires stored, uncompressed entries)");
    if (data + csize > z.size()) throw ConvertError("the .usdz entry “" + name + "” is truncated");
    SourceFile f;
    f.path = name;
    f.bytes.assign(z.begin() + static_cast<std::ptrdiff_t>(data), z.begin() + static_cast<std::ptrdiff_t>(data + csize));
    entries.push_back(std::move(f));
    o = data + csize;
  }
  if (entries.empty()) throw ConvertError("the .usdz holds no files");
  // The root layer is the first .usd* entry (the USDZ rule).
  const auto rootIt = std::ranges::find_if(entries, [](const SourceFile& f) {
    const std::string n = f.path;
    return n.ends_with(".usda") || n.ends_with(".usdc") || n.ends_with(".usd");
  });
  if (rootIt == entries.end()) throw ConvertError("the .usdz has no USD layer");
  if (rootIt->path.ends_with(".usdc") ||
      (rootIt->bytes.size() >= 8 && std::memcmp(rootIt->bytes.data(), "PXR-USDC", 8) == 0)) {
    throw ConvertError("This .usdz holds a binary crate layer (USDC), which the importer does not read. "
                       "Export it as .usdz with an ASCII (.usda) layer, or as .glb / .fbx.");
  }
  // The root first, so FileSet resolves textures relative to it.
  std::vector<SourceFile> ordered;
  ordered.push_back(*rootIt);
  for (const SourceFile& f : entries) {
    if (&f != &*rootIt) ordered.push_back(f);
  }
  const FileSet inner(ordered);
  const std::string& t = ordered.front().path;
  const auto slash = t.rfind('/');
  return load_usda(std::string_view(reinterpret_cast<const char*>(ordered.front().bytes.data()), ordered.front().bytes.size()), inner,  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
                   slash == std::string::npos ? std::string_view() : std::string_view(t).substr(0, slash));
}

}  // namespace premation::scene::modelio
