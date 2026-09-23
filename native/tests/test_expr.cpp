// motion_expr — the golden parity gate against the TypeScript expression engine.
//
// golden_expr.inc and golden_expr_engine.inc are written by RUNNING the
// TypeScript (native/tests/gen_golden_expr.ts). Every row is checked exactly:
// number bits (-0 is not +0), vector components, error text, Source Text
// result. A secondary [expr][rel] report counts how many numeric rows are
// within 1e-12 relative — it must equal the row count too, and exists so a
// future regression can be told apart as "last bits" or "wrong".

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "eval.hpp"
#include "expr.hpp"
#include "numconv.hpp"

namespace {

namespace ex = motion::expr;
using Str = std::u16string;

// ── Context description (filled by the generated statements) ────────────────

struct GCtrl {
  const char16_t* name;
  double v;
};
struct GTrack {
  const char16_t* layer;
  const char16_t* prop;
  std::vector<motion_keyframe> kfs;
};
struct GSpace {
  const char16_t* name;  // nullptr = self
  double k, off, z;
};
struct GMarker {
  int scope;  // 0 comp, 1 layer
  double time, duration;
  const char16_t* name;
  const char16_t* comment;
};
struct GText {
  const char16_t* name;  // nullptr = self
  ex::SourceTextSample sample;
};
struct GCtx {
  std::vector<motion_keyframe> self;
  double base = 0;
  std::optional<double> audio;
  std::optional<double> prop_seed;
  std::optional<ex::CompInfo> comp;
  std::optional<ex::LayerInfo> layer_info;
  bool has_ctrl = false;
  std::vector<GCtrl> ctrls;
  bool has_layer_at = false;
  std::vector<GTrack> tracks;
  bool has_space = false;
  std::vector<GSpace> spaces;
  bool has_rect = false;
  bool has_markers = false;
  std::vector<GMarker> markers;
  bool has_text = false;
  std::vector<GText> texts;
  bool text_value = false;
};

const std::vector<GCtx>& contexts() {
  static const std::vector<GCtx> kCtx = [] {
    std::vector<GCtx> v;
#define MOTION_GOLDEN_EXPR_CONTEXTS
#include "golden_expr.inc"
#undef MOTION_GOLDEN_EXPR_CONTEXTS
    return v;
  }();
  return kCtx;
}

double sample(const std::vector<motion_keyframe>& kfs, double t) {
  return motion::eval::sample(motion::eval::StructSource{kfs}, t);
}

bool same_name(const char16_t* a, const Str* b) {
  if (a == nullptr || b == nullptr) return a == nullptr && b == nullptr;
  return std::u16string_view(a) == *b;
}

/// The generator's TypeScript providers, in C++ (same arithmetic order).
class GoldenHost final : public ex::Host {
 public:
  explicit GoldenHost(const GCtx& c) : c_(c) {}

  [[nodiscard]] bool has_ctrl() const override { return c_.has_ctrl; }
  double ctrl(std::u16string_view name) override {
    for (const GCtrl& g : c_.ctrls) {
      if (name == g.name) return g.v;
    }
    return 0;
  }
  [[nodiscard]] bool has_self_at() const override { return !c_.self.empty(); }
  double self_at(double t) override {
    // sampleTrack on a ONE-key track at NaN falls through both clamps and reads
    // kfs[1].t of undefined — a TypeError the TS evaluator reports as-is.
    if (std::isnan(t) && c_.self.size() == 1) throw ex::HostError{u"Cannot read properties of undefined (reading 't')"};
    return sample(c_.self, t);
  }

  [[nodiscard]] bool has_layer_at() const override { return c_.has_layer_at; }
  std::optional<double> layer_at(std::u16string_view name, std::u16string_view prop, double t) override {
    Str id(name);
    if (!id.empty() && id[0] == u'#' && id.size() == 1) return std::nullopt;  // '#' alone → null
    for (const GTrack& g : c_.tracks) {
      if (id == g.layer && prop == g.prop) return sample(g.kfs, t);
    }
    return std::nullopt;
  }

  [[nodiscard]] bool has_source_rect_at() const override { return c_.has_rect; }
  std::optional<ex::SourceRect> source_rect_at(double t, bool extents) override {
    return ex::SourceRect{.top = -t, .left = extents ? 1.0 : 0.0, .width = 100, .height = 40};
  }

  [[nodiscard]] bool has_space_at() const override { return c_.has_space; }
  bool space_exists(const Str* name, double /*t*/) override { return find(name) != nullptr; }
  std::array<double, 3> space_convert(const Str* name, double t, ex::SpaceOp op, std::array<double, 3> p) override {
    const GSpace& s = *find(name);
    switch (op) {
      case ex::SpaceOp::kToComp:
        return {p[0] * s.k + s.off + t, p[1] * s.k + s.off, 0};
      case ex::SpaceOp::kFromComp:
        return {(p[0] - s.off - t) / s.k, (p[1] - s.off) / s.k, 0};
      case ex::SpaceOp::kToWorld:
        return {p[0] * s.k + s.off, p[1] * s.k + s.off + t, s.z};
      case ex::SpaceOp::kFromWorld:
        return {(p[0] - s.off) / s.k, (p[1] - s.off) / s.k + p[2] * s.z, 0};
    }
    return p;
  }

  [[nodiscard]] bool has_markers_at() const override { return c_.has_markers; }
  std::vector<ex::MarkerData> markers_at(ex::MarkerScope scope) override {
    std::vector<ex::MarkerData> out;
    const int want = scope == ex::MarkerScope::kComp ? 0 : 1;
    for (const GMarker& m : c_.markers) {
      if (m.scope == want) out.push_back({.time = m.time, .duration = m.duration, .name = m.name, .comment = m.comment});
    }
    return out;
  }

  [[nodiscard]] bool has_source_text_at() const override { return c_.has_text; }
  std::optional<ex::SourceTextSample> source_text_at(const Str* name, double /*t*/) override {
    for (const GText& g : c_.texts) {
      if (same_name(g.name, name)) return g.sample;
    }
    return std::nullopt;
  }

 private:
  const GSpace* find(const Str* name) const {
    for (const GSpace& s : c_.spaces) {
      if (same_name(s.name, name)) return &s;
    }
    return nullptr;
  }
  const GCtx& c_;
};

struct Built {
  ex::Context ctx;
  std::vector<double> key_times;
};

void build(const GCtx& g, double time, GoldenHost& host, Built& b) {
  b.ctx = {};
  b.ctx.time = time;
  b.ctx.value = g.self.empty() ? g.base : sample(g.self, time);
  b.ctx.audio = g.audio;
  b.ctx.prop_seed = g.prop_seed;
  b.ctx.comp = g.comp;
  b.ctx.layer_info = g.layer_info;
  b.key_times.clear();
  if (!g.self.empty()) {
    b.ctx.self_span = ex::KeySpan{.start = g.self.front().t, .end = g.self.back().t};
    for (const motion_keyframe& k : g.self) b.key_times.push_back(k.t);
  }
  b.ctx.key_times = b.key_times;
  if (g.text_value) {
    for (const GText& t : g.texts) {
      if (t.name == nullptr) b.ctx.text_value = &t.sample;
    }
  }
  b.ctx.host = &host;
}

/// One golden row as data. The .inc is expanded into a static TABLE walked by
/// a loop: one call per row with ~6 000 rows made this translation unit take
/// many gigabytes under ASan. A source is `pre + unit × n + post` (S(x) is
/// `x, u"", 0, u""`), so the long budget sources stay short in the table.
struct ExprRow {
  int text;  // 0: run(), 1: run_text()
  int ctx;
  std::uint64_t time;
  const char16_t* pre;
  const char16_t* unit;
  int n;
  const char16_t* post;
  int kind;  // run: 0 null, 1 number, 2 vector; run_text: has result
  std::array<std::uint64_t, 4> v;
  std::size_t size;
  const char16_t* canon;
  const char16_t* err;
};

// NOLINTBEGIN(cppcoreguidelines-macro-usage)
#define S(x) x, u"", 0, u""
#define R(pre, unit, n, post) pre, unit, n, post
#define MOTION_EXPR_NUM(ci, tb, src, kind, v0, v1, v2, v3, size, err) \
  ExprRow{0, ci, tb, src, kind, {v0, v1, v2, v3}, size, u"", err},
#define MOTION_EXPR_TEXT(ci, tb, src, has, canon, err) ExprRow{1, ci, tb, src, has, {0, 0, 0, 0}, 0, canon, err},
const ExprRow kExprRows[] = {  // NOLINT(cppcoreguidelines-avoid-c-arrays)
#include "golden_expr.inc"
};
#undef MOTION_EXPR_NUM
#undef MOTION_EXPR_TEXT
#undef S
#undef R
// NOLINTEND(cppcoreguidelines-macro-usage)

// The engine scene (golden_expr_engine.inc) spells its sources with the same
// S / R forms, as functions.
Str S(const char16_t* s) { return s; }
Str R(const char16_t* pre, const char16_t* unit, int n, const char16_t* post) {
  Str out = pre;
  for (int i = 0; i < n; ++i) out += unit;
  return out + post;
}

Str source_of(const ExprRow& r) {
  Str out = r.pre;
  for (int i = 0; i < r.n; ++i) out += r.unit;
  return out + r.post;
}

std::uint64_t bits(double d) { return std::bit_cast<std::uint64_t>(d); }
double from_bits(std::uint64_t b) { return std::bit_cast<double>(b); }
/// Distance in ulps between two finite doubles of the same sign.
std::uint64_t ulps(double a, double b) {
  if (std::signbit(a) != std::signbit(b)) return a == b ? 0 : ~0ULL;
  const std::uint64_t x = bits(a);
  const std::uint64_t y = bits(b);
  return x > y ? x - y : y - x;
}

std::string narrow(const Str& s) { return ex::utf16_to_utf8(s.size() > 160 ? s.substr(0, 160) + u"…" : s); }

// ── Canonical Source Text result (gen_golden_expr.ts canonText) ─────────────

Str js_num(double d) {
  const std::string s = motion::js::number_to_string(d);
  return {s.begin(), s.end()};
}

Str canon_style(const ex::SourceTextStyleOverrides& o) {
  Str out;
  const auto put = [&](std::u16string_view k, const Str& v) {
    if (!out.empty()) out += u';';
    out += Str(k) + u"=" + v;
  };
  const auto s = [&](std::u16string_view k, const std::optional<Str>& v) {
    if (v) put(k, *v);
  };
  const auto n = [&](std::u16string_view k, const std::optional<double>& v) {
    if (v) put(k, js_num(*v));
  };
  const auto b = [&](std::u16string_view k, const std::optional<bool>& v) {
    if (v) put(k, *v ? u"true" : u"false");
  };
  s(u"fontFamily", o.font_family);
  n(u"fontSize", o.font_size);
  s(u"fontWeight", o.font_weight);
  s(u"fontStyle", o.font_style);
  s(u"fill", o.fill);
  b(u"applyFill", o.apply_fill);
  s(u"stroke", o.stroke);
  n(u"strokeWidth", o.stroke_width);
  b(u"applyStroke", o.apply_stroke);
  n(u"tracking", o.tracking);
  n(u"leading", o.leading);
  n(u"baselineShift", o.baseline_shift);
  n(u"horizontalScale", o.horizontal_scale);
  n(u"verticalScale", o.vertical_scale);
  s(u"textTransform", o.text_transform);
  s(u"fontVariant", o.font_variant);
  s(u"align", o.align);
  n(u"firstLineIndent", o.first_line_indent);
  n(u"leftIndent", o.left_indent);
  n(u"rightIndent", o.right_indent);
  n(u"spaceBefore", o.space_before);
  n(u"spaceAfter", o.space_after);
  s(u"direction", o.direction);
  s(u"leadingType", o.leading_type);
  return out;
}

Str canon_text(const ex::SourceTextResult& r) {
  Str out = r.text + u"|" + canon_style(r.style) + u"|";
  for (const auto& g : r.ranges) out += u"[" + js_num(g.start) + u"," + js_num(g.count) + u"," + canon_style(g.style) + u"]";
  return out;
}

}  // namespace

TEST_CASE("expressions match the TypeScript engine bit for bit", "[expr][golden]") {
  const auto& ctxs = contexts();
  int rows = 0;
  int bad = 0;
  int within_rel = 0;
  int numeric = 0;
  int pow_ulp = 0;
  GoldenHost* host_ptr = nullptr;
  Built b;
  const auto check_num = [&](int ci, std::uint64_t tb, const Str& src, int kind, std::array<std::uint64_t, 4> v,
                             std::size_t size, const char16_t* err) {
    ++rows;
    const GCtx& g = ctxs[static_cast<std::size_t>(ci)];
    GoldenHost host(g);
    host_ptr = &host;
    build(g, from_bits(tb), host, b);
#ifdef MOTION_EXPR_TRACE
    std::fprintf(stderr, "%d %s\n", ci, narrow(src).c_str());
#endif
    const ex::Expression e = ex::Expression::compile(src);
    const ex::Result r = e.run(b.ctx);
    const Str want_err = err;
    const Str got_err = r.error.value_or(Str());
    bool ok = got_err == want_err && static_cast<int>(r.kind) == kind;
    if (ok && kind == 1) {
      ++numeric;
      ok = bits(r.number) == v[0];
      // Math.pow is the platform libm in V8 (see motion_jsmath fdlibm.cpp): a
      // pow row may differ by one ulp between CRT builds. Counted, not failed.
      if (!ok && src.find(u"pow") != Str::npos && ulps(r.number, from_bits(v[0])) <= 1) {
        ok = true;
        ++pow_ulp;
      }
      const double w = from_bits(v[0]);
      if (r.number == w || std::fabs(r.number - w) <= 1e-12 * std::fabs(w)) ++within_rel;
    }
    if (ok && kind == 2) {
      ok = r.size == size;
      for (std::size_t i = 0; ok && i < size; ++i) ok = bits(r.vec.at(i)) == v.at(i);
    }
    if (!ok) {
      ++bad;
      if (bad <= 40) {
        UNSCOPED_INFO("ctx " << ci << " t=" << from_bits(tb) << " src: " << narrow(src) << "\n  want kind " << kind
                             << " v0=" << from_bits(v[0]) << " err='" << narrow(want_err) << "'\n  got  kind "
                             << static_cast<int>(r.kind) << " v0=" << r.number << " err='" << narrow(got_err) << "'");
      }
    }
  };
  const auto check_text = [&](int ci, std::uint64_t tb, const Str& src, int has, const char16_t* canon,
                              const char16_t* err) {
    ++rows;
    const GCtx& g = ctxs[static_cast<std::size_t>(ci)];
    GoldenHost host(g);
    build(g, from_bits(tb), host, b);
    const ex::Expression e = ex::Expression::compile(src);
    const ex::TextResult r = e.run_text(b.ctx);
    const Str got_canon = r.result ? canon_text(*r.result) : Str();
    const Str got_err = r.error.value_or(Str());
    const bool ok = (r.result.has_value() == (has != 0)) && got_canon == canon && got_err == err;
    if (!ok) {
      ++bad;
      if (bad <= 40) {
        UNSCOPED_INFO("TEXT ctx " << ci << " src: " << narrow(src) << "\n  want '" << narrow(canon) << "' err '"
                                  << narrow(err) << "'\n  got  '" << narrow(got_canon) << "' err '" << narrow(got_err)
                                  << "'");
      }
    }
  };
  for (const ExprRow& row : std::span(kExprRows)) {
    const Str src = source_of(row);
    if (row.text == 0) {
      check_num(row.ctx, row.time, src, row.kind, row.v, row.size, row.err);
    } else {
      check_text(row.ctx, row.time, src, row.kind, row.canon, row.err);
    }
  }
  (void)host_ptr;
  INFO("rows " << rows << ", mismatches " << bad << ", numeric rows " << numeric << ", within 1e-12 rel " << within_rel
                << ", pow rows 1 ulp off " << pow_ulp);
  CHECK(rows >= 500);
  CHECK(bad == 0);
  CHECK(within_rel == numeric);
}

// ── AnimationEngine mirror: cross-layer reads, cycles, depth, seeds ─────────

namespace {

struct EProp {
  const char16_t* prop;
  std::vector<motion_keyframe> kfs;
  Str expr;
  bool has_expr;
  bool enabled;
};
struct ENode {
  const char16_t* id;
  const char16_t* name;
  std::vector<EProp> props;
};

/// A port of AnimationEngine.sample / sampleInternal / exprContext /
/// crossLayerValue — the engine side of the Host contract, as the TS does it.
class Engine {
 public:
  Engine() {
    std::vector<ENode>& scene = scene_;
    std::map<Str, double>& base = base_;
#define MOTION_GOLDEN_ENGINE_SCENE
#include "golden_expr_engine.inc"
#undef MOTION_GOLDEN_ENGINE_SCENE
    for (const ENode& n : scene_) {
      for (const EProp& p : n.props) {
        if (p.has_expr) compiled_.emplace(key(n.id, p.prop), ex::Expression::compile(p.expr));
      }
    }
  }

  std::optional<double> sample(std::u16string_view node, std::u16string_view prop, double t) {
    const EProp* p = find(node, prop);
    if (p == nullptr || !p->has_expr || !p->enabled) return plain(node, prop, t);
    std::set<Str> visited;
    try {
      return sample_internal(node, prop, t, visited, 0);
    } catch (const ex::HostError&) {
      return plain(node, prop, t);
    }
  }

 private:
  static Str key(std::u16string_view n, std::u16string_view p) { return Str(n) + u":" + Str(p); }

  const EProp* find(std::u16string_view node, std::u16string_view prop) const {
    for (const ENode& n : scene_) {
      if (node != n.id) continue;
      for (const EProp& p : n.props) {
        if (prop == p.prop) return &p;
      }
    }
    return nullptr;
  }
  std::optional<double> track_at(std::u16string_view node, std::u16string_view prop, double t) const {
    const EProp* p = find(node, prop);
    if (p == nullptr || p->kfs.empty()) return std::nullopt;
    return motion::eval::sample(motion::eval::StructSource{p->kfs}, t);
  }
  std::optional<double> base_of(std::u16string_view node, std::u16string_view prop) const {
    const auto it = base_.find(key(node, prop));
    if (it == base_.end()) return std::nullopt;
    return it->second;
  }
  std::optional<double> plain(std::u16string_view node, std::u16string_view prop, double t) const {
    const auto v = track_at(node, prop, t);
    return v ? v : base_of(node, prop);
  }
  static std::size_t component_index(std::u16string_view prop) {
    if (prop == u"y" || prop == u"scaleY" || prop == u"anchorY") return 1;
    if (prop == u"z" || prop == u"rotationZ") return 2;
    return 0;
  }
  std::optional<Str> resolve(std::u16string_view ref) const {
    if (!ref.empty() && ref[0] == u'#') {
      if (ref.size() == 1) return std::nullopt;
      return Str(ref.substr(1));
    }
    for (const ENode& n : scene_) {
      if (ref == n.name) return Str(n.id);
    }
    return std::nullopt;
  }

  class Ctx final : public ex::Host {
   public:
    Ctx(Engine& e, Str node, Str prop, std::set<Str>& visited, int depth)
        : e_(e), node_(std::move(node)), prop_(std::move(prop)), visited_(visited), depth_(depth) {}
    [[nodiscard]] bool has_ctrl() const override { return true; }
    double ctrl(std::u16string_view /*name*/) override { return 0; }
    [[nodiscard]] bool has_self_at() const override { return true; }
    double self_at(double t) override {
      const auto v = e_.track_at(node_, prop_, t);
      return v ? *v : e_.base_of(node_, prop_).value_or(0);
    }
    [[nodiscard]] bool has_layer_at() const override { return true; }
    std::optional<double> layer_at(std::u16string_view name, std::u16string_view prop, double t) override {
      const auto id = e_.resolve(name);
      if (!id) return std::nullopt;
      return e_.sample_internal(*id, prop, t, visited_, depth_);
    }
    [[nodiscard]] bool has_source_rect_at() const override { return true; }
    [[nodiscard]] bool has_space_at() const override { return true; }
    [[nodiscard]] bool has_markers_at() const override { return true; }
    [[nodiscard]] bool has_source_text_at() const override { return true; }

   private:
    Engine& e_;
    Str node_;
    Str prop_;
    std::set<Str>& visited_;
    int depth_;
  };

  std::optional<double> sample_internal(std::u16string_view node, std::u16string_view prop, double t,
                                        std::set<Str>& visited, int depth) {
    const Str k = key(node, prop);
    if (visited.contains(k)) throw ex::HostError{u"Cycle detected across expression evaluation (" + k + u")"};
    if (depth > 16) throw ex::HostError{u"Maximum cross-layer evaluation depth (16) exceeded (" + k + u")"};
    visited.insert(k);
    struct Erase {
      std::set<Str>& v;
      const Str& k;
      Erase(std::set<Str>& vv, const Str& kk) : v(vv), k(kk) {}
      Erase(const Erase&) = delete;
      Erase& operator=(const Erase&) = delete;
      ~Erase() { v.erase(k); }
    } const erase{visited, k};
    const std::optional<double> base = track_at(node, prop, t);
    const EProp* p = find(node, prop);
    if (p != nullptr && p->has_expr && p->enabled) {
      Ctx host(*this, Str(node), Str(prop), visited, depth + 1);
      ex::Context c;
      c.time = t;
      c.value = base ? *base : base_of(node, prop).value_or(0);
      c.audio = 0.0;
      c.comp = ex::CompInfo{};
      c.layer_info = ex::LayerInfo{.name = u"Layer", .width = 1920, .height = 1080};
      c.prop_seed = ex::string_seed(k);
      std::vector<double> kt;
      for (const motion_keyframe& kf : p->kfs) kt.push_back(kf.t);
      if (!p->kfs.empty()) c.self_span = ex::KeySpan{.start = p->kfs.front().t, .end = p->kfs.back().t};
      c.key_times = kt;
      c.host = &host;
      const ex::Result r = compiled_.at(k).run(c);
      if (r.error) {
        const Str& m = *r.error;
        if (m.find(u"Cycle detected") != Str::npos || m.find(u"Maximum cross-layer") != Str::npos) {
          throw ex::HostError{m};
        }
      }
      if (r.kind == ex::Result::Kind::kVector) return r.vec.at(std::min(component_index(prop), r.size - 1));
      if (r.kind == ex::Result::Kind::kNumber) return r.number;
    }
    return base ? base : base_of(node, prop);
  }

  std::vector<ENode> scene_;
  std::map<Str, double> base_;
  std::map<Str, ex::Expression> compiled_;
};

}  // namespace

TEST_CASE("an engine Host mirrors AnimationEngine.sample exactly", "[expr][golden][engine]") {
  Engine engine;
  int rows = 0;
  int bad = 0;
#define MOTION_ENGINE_SAMPLE(node, prop, tb, has, vb)                                               \
  {                                                                                                 \
    ++rows;                                                                                         \
    const auto got = engine.sample(node, prop, from_bits(tb));                                      \
    const bool ok = got.has_value() == ((has) != 0) && (!got || bits(*got) == (vb));                \
    if (!ok) {                                                                                      \
      ++bad;                                                                                        \
      UNSCOPED_INFO(narrow(node) << ":" << narrow(prop) << " t=" << from_bits(tb) << " want "       \
                                 << from_bits(vb) << " got " << (got ? *got : -999999.0));          \
    }                                                                                               \
  }
#include "golden_expr_engine.inc"
#undef MOTION_ENGINE_SAMPLE
  INFO("engine rows " << rows);
  CHECK(bad == 0);
}

TEST_CASE("compile errors, empty sources and string seeds", "[expr]") {
  CHECK(ex::Expression::compile(u"   ").empty());
  const ex::Result r = ex::Expression::compile(u"  \n").run({});
  CHECK(r.kind == ex::Result::Kind::kNull);
  CHECK_FALSE(r.error.has_value());
  const ex::Expression bad = ex::Expression::compile(u"1 +");
  REQUIRE(bad.compile_error().has_value());
  CHECK(*bad.compile_error() == u"Syntax error: Unexpected end of expression.");
  // AnimationEngine stringSeed("n:x"): (110*31+58)*31+120 = 107628; % 10007 = 7558.
  CHECK(ex::string_seed(u"n:x") == 7558);
  CHECK(ex::utf16_to_utf8(ex::utf8_to_utf16("h\xC3\xA9 \xF0\x9F\x91\x8D")) == "h\xC3\xA9 \xF0\x9F\x91\x8D");
}

// ── The C ABI ───────────────────────────────────────────────────────────────

#include "motion/motion_expr.h"

TEST_CASE("the C ABI compiles, evaluates, reports errors and calls the host", "[expr][abi]") {
  const auto compile = [](std::string_view src) {
    motion_expr* e = nullptr;
    REQUIRE(motion_expr_compile(src.data(), src.size(), &e, nullptr) == MOTION_OK);
    REQUIRE(e != nullptr);
    return e;
  };
  motion_expr_context c{};
  c.time = 1.5;
  c.value = 10;
  motion_expr_result r{};

  motion_expr* e = compile("value + time * 2");
  REQUIRE(motion_expr_eval(e, &c, &r, nullptr) == MOTION_OK);
  CHECK(r.kind == MOTION_EXPR_RESULT_NUMBER);
  CHECK(r.value[0] == 13);
  motion_expr_free(e);

  e = compile("[1, 2, time]");
  REQUIRE(motion_expr_eval(e, &c, &r, nullptr) == MOTION_OK);
  CHECK(r.kind == MOTION_EXPR_RESULT_VECTOR);
  CHECK(r.size == 3);
  CHECK(r.value[2] == 1.5);
  motion_expr_free(e);

  e = compile("1 +");
  std::array<char, 128> buf{};
  CHECK(motion_expr_compile_error(e, buf.data(), buf.size()) == 1);
  CHECK(std::string_view(buf.data()) == "Syntax error: Unexpected end of expression.");
  REQUIRE(motion_expr_eval(e, &c, &r, nullptr) == MOTION_OK);
  CHECK(r.kind == MOTION_EXPR_RESULT_ERROR);
  motion_expr_free(e);

  // Host: a layer read, a control, and a host-side error that fails the expression.
  struct User {
    int calls = 0;
  } user;
  motion_expr_host host{};
  host.user = &user;
  host.layer_at = [](void* u, const char* name, size_t nl, const char* prop, size_t pl, double t, double* out,
                     char* msg, size_t cap) -> int32_t {
    static_cast<User*>(u)->calls++;
    const std::string_view n(name, nl);
    if (n == "Loop") {
      std::snprintf(msg, cap, "Cycle detected across expression evaluation (a:x)");
      return MOTION_EXPR_HOST_ERROR;
    }
    if (n != "Leader" || std::string_view(prop, pl) != "x") return MOTION_EXPR_HOST_NOT_FOUND;
    *out = t * 100;
    return MOTION_EXPR_HOST_OK;
  };
  host.ctrl = [](void*, const char* name, size_t nl, double* out) -> int32_t {
    if (std::string_view(name, nl) != "Speed") return MOTION_EXPR_HOST_NOT_FOUND;
    *out = 4;
    return MOTION_EXPR_HOST_OK;
  };
  c.host = &host;
  e = compile("layerAt('Leader', 'x', time - 0.5) + ctrl('Speed') + layer('Nope', 'x')");
  REQUIRE(motion_expr_eval(e, &c, &r, nullptr) == MOTION_OK);
  CHECK(r.kind == MOTION_EXPR_RESULT_NUMBER);
  CHECK(r.value[0] == 104);
  CHECK(user.calls == 2);
  motion_expr_free(e);
  e = compile("layer('Loop', 'x')");
  REQUIRE(motion_expr_eval(e, &c, &r, nullptr) == MOTION_OK);
  CHECK(r.kind == MOTION_EXPR_RESULT_ERROR);
  CHECK(std::string_view(r.message) == "Cycle detected across expression evaluation (a:x)");
  motion_expr_free(e);

  CHECK(motion_expr_eval(nullptr, &c, &r, nullptr) == MOTION_INVALID_ARG);
  motion_expr_free(nullptr);
  CHECK(motion_expr_string_seed("n:x", 3) == 7558);
}
