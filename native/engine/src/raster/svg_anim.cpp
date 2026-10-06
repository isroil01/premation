// Animated SVG: SMIL and CSS animations at one document time (svg_anim.hpp).

#include "svg_anim.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <functional>
#include <limits>
#include <map>
#include <numbers>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "css.hpp"

namespace premation::raster::svg {
namespace {

constexpr double kInf = std::numeric_limits<double>::infinity();
/// Syncbase resolution bounds: a chain of animations that restart each other
/// resolves one cycle per pass.
constexpr int kMaxPasses = 2000;
constexpr std::size_t kMaxInstances = 2048;

bool is_space(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f'; }
bool is_digit(char c) { return c >= '0' && c <= '9'; }

std::string_view trim_sv(std::string_view s) {
  while (!s.empty() && is_space(s.front())) s.remove_prefix(1);
  while (!s.empty() && is_space(s.back())) s.remove_suffix(1);
  return s;
}

std::string lower_s(std::string_view s) {
  std::string o(s);
  for (char& c : o) c = c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c;
  return o;
}

/// Split on `sep` outside parentheses; pieces trimmed, empty ones dropped.
std::vector<std::string_view> split_list(std::string_view s, char sep) {
  std::vector<std::string_view> out;
  int depth = 0;
  std::size_t start = 0;
  for (std::size_t i = 0; i <= s.size(); ++i) {
    const char c = i < s.size() ? s[i] : sep;
    if (c == '(') {
      ++depth;
    } else if (c == ')') {
      --depth;
    } else if (c == sep && depth <= 0) {
      const std::string_view piece = trim_sv(s.substr(start, i - start));
      if (!piece.empty()) out.push_back(piece);
      start = i + 1;
    }
  }
  return out;
}

/// Split on whitespace outside parentheses.
std::vector<std::string_view> split_ws(std::string_view s) {
  std::vector<std::string_view> out;
  int depth = 0;
  std::size_t start = 0;
  bool in = false;
  for (std::size_t i = 0; i <= s.size(); ++i) {
    const char c = i < s.size() ? s[i] : ' ';
    if (c == '(') ++depth;
    if (c == ')') --depth;
    if (is_space(c) && depth <= 0) {
      if (in) out.push_back(s.substr(start, i - start));
      in = false;
    } else if (!in) {
      in = true;
      start = i;
    }
  }
  return out;
}

/// A number at the start of `s` (SVG / CSS syntax): its value and length.
std::optional<std::pair<double, std::size_t>> lead_number(std::string_view s) {
  std::size_t i = 0;
  if (i < s.size() && (s[i] == '+' || s[i] == '-')) ++i;
  const std::size_t d0 = i;
  while (i < s.size() && is_digit(s[i])) ++i;
  bool any = i > d0;
  if (i < s.size() && s[i] == '.') {
    std::size_t j = i + 1;
    while (j < s.size() && is_digit(s[j])) ++j;
    if (j > i + 1 || any) {
      any = true;
      i = j;
    }
  }
  if (!any) return std::nullopt;
  if (i < s.size() && (s[i] == 'e' || s[i] == 'E')) {
    std::size_t j = i + 1;
    if (j < s.size() && (s[j] == '+' || s[j] == '-')) ++j;
    const std::size_t e0 = j;
    while (j < s.size() && is_digit(s[j])) ++j;
    if (j > e0) i = j;
  }
  std::string_view num = s.substr(0, i);
  if (num.starts_with('+')) num.remove_prefix(1);
  double v = 0;
  const auto r = std::from_chars(num.data(), num.data() + num.size(), v);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  if (r.ec != std::errc()) return std::nullopt;
  return std::make_pair(v, i);
}

/// A SMIL clock value or a CSS <time>, in seconds: "2s", "250ms", "1.5min",
/// "1h", "3" (seconds), "02:30", "0:01:02.5".
std::optional<double> parse_clock(std::string_view s) {
  s = trim_sv(s);
  if (s.empty()) return std::nullopt;
  if (s.find(':') != std::string_view::npos) {
    double total = 0;
    int parts = 0;
    for (const std::string_view part : split_list(s, ':')) {
      const auto n = lead_number(part);
      if (!n || n->second != part.size()) return std::nullopt;
      total = total * 60 + n->first;
      ++parts;
    }
    if (parts != 2 && parts != 3) return std::nullopt;
    return total;
  }
  const auto n = lead_number(s);
  if (!n) return std::nullopt;
  const std::string unit = lower_s(trim_sv(s.substr(n->second)));
  if (unit.empty() || unit == "s") return n->first;
  if (unit == "ms") return n->first / 1000;
  if (unit == "min") return n->first * 60;
  if (unit == "h") return n->first * 3600;
  return std::nullopt;
}

// ── values ───────────────────────────────────────────────────────────────────

/// A value as numbers and the text between them ("translate(", "10", " ", …).
struct Tmpl {
  std::vector<std::string> gaps;  // nums.size() + 1, whitespace collapsed
  std::vector<double> nums;
};

/// Whitespace runs as one space, none around a comma: "10, 20" and "10,20" have the same shape.
std::string tidy_gap(const std::string& g) {
  std::string out;
  for (const char c : g) {
    if (is_space(c)) {
      if (out.empty() || (out.back() != ' ' && out.back() != ',')) out.push_back(' ');
      continue;
    }
    if (c == ',' && !out.empty() && out.back() == ' ') out.pop_back();
    out.push_back(c);
  }
  return out;
}

Tmpl tmpl_of(std::string_view s) {
  Tmpl t;
  std::string gap;
  std::size_t i = 0;
  while (i < s.size()) {
    const char c = s[i];
    const bool starts = is_digit(c) || c == '.' ||
                        ((c == '-' || c == '+') && i + 1 < s.size() && (is_digit(s[i + 1]) || s[i + 1] == '.'));
    if (starts) {
      if (const auto n = lead_number(s.substr(i))) {
        t.gaps.push_back(tidy_gap(gap));
        gap.clear();
        t.nums.push_back(n->first);
        i += n->second;
        continue;
      }
    }
    gap.push_back(c);
    ++i;
  }
  t.gaps.push_back(tidy_gap(gap));
  return t;
}

std::string num_text(double v) {
  if (std::abs(v) < 1e-9) v = 0;
  std::array<char, 32> b{};
  const auto r = std::to_chars(b.data(), b.data() + b.size(), v, std::chars_format::general, 7);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  return {b.data(), r.ptr};
}

std::string join(const Tmpl& t, const std::vector<double>& nums) {
  std::string out = t.gaps[0];
  for (std::size_t i = 0; i < nums.size(); ++i) {
    // Two numbers must not run together ("1" "-2" → "1-2" is fine, "1" "2" is not).
    if (!out.empty() && t.gaps[i].empty() && i > 0 && nums[i] >= 0) out.push_back(' ');
    out += num_text(nums[i]);
    out += t.gaps[i + 1];
  }
  return out;
}

std::string color_text(const css::Color& c) {
  const auto ch = [](double v) { return std::to_string(std::lround(std::clamp(v, 0.0, 255.0))); };
  return "rgba(" + ch(c.r) + "," + ch(c.g) + "," + ch(c.b) + "," + num_text(std::clamp(c.a, 0.0, 1.0)) + ")";
}

/// `a` → `b` at `p`: colours channel by channel, anything else number by number
/// when both have the same shape ("10px" / "20px", path data with the same
/// commands, transform lists). nullopt: not interpolable (discrete).
std::optional<std::string> lerp_value(std::string_view a, std::string_view b, double p) {
  a = trim_sv(a);
  b = trim_sv(b);
  const auto ca = css::parse_color(a);
  const auto cb = css::parse_color(b);
  if (ca && cb) {
    return color_text({ca->r + (cb->r - ca->r) * p, ca->g + (cb->g - ca->g) * p, ca->b + (cb->b - ca->b) * p,
                       ca->a + (cb->a - ca->a) * p});
  }
  if (ca || cb) return std::nullopt;
  const Tmpl ta = tmpl_of(a);
  const Tmpl tb = tmpl_of(b);
  if (ta.nums.empty() || ta.nums.size() != tb.nums.size() || ta.gaps != tb.gaps) return std::nullopt;
  std::vector<double> n(ta.nums.size());
  for (std::size_t i = 0; i < n.size(); ++i) n[i] = ta.nums[i] + (tb.nums[i] - ta.nums[i]) * p;
  return join(ta, n);
}

/// `a` + `b` number by number (SMIL `by`); nullopt when the shapes differ.
std::optional<std::string> add_value(std::string_view a, std::string_view b) {
  const Tmpl ta = tmpl_of(a);
  const Tmpl tb = tmpl_of(b);
  if (ta.nums.empty() || ta.nums.size() != tb.nums.size()) return std::nullopt;
  std::vector<double> n(ta.nums.size());
  for (std::size_t i = 0; i < n.size(); ++i) n[i] = ta.nums[i] + tb.nums[i];
  return join(ta, n);
}

double bezier1(double p1, double p2, double u) {
  const double v = 1 - u;
  return 3 * v * v * u * p1 + 3 * v * u * u * p2 + u * u * u;
}

/// cubic-bezier(x1, y1, x2, y2) at x (keySplines, CSS timing functions).
double spline_y(const std::array<double, 4>& s, double x) {
  double lo = 0;
  double hi = 1;
  double u = x;
  for (int i = 0; i < 48; ++i) {
    const double xu = bezier1(s[0], s[2], u);
    if (std::abs(xu - x) < 1e-7) break;
    if (xu < x) lo = u;
    else hi = u;
    u = (lo + hi) / 2;
  }
  return bezier1(s[1], s[3], u);
}

/// The value of a SMIL `values` list at progress `p` (keyTimes, calcMode).
std::optional<std::string> value_at(const std::vector<std::string>& vals, const std::vector<double>& keyTimes,
                                    const std::string& calcMode, const std::vector<std::array<double, 4>>& splines, double p) {
  const std::size_t n = vals.size();
  if (n == 0) return std::nullopt;
  if (n == 1) return vals[0];
  const bool discrete = calcMode == "discrete";
  std::vector<double> kt = keyTimes;
  if (kt.size() != n) {
    kt.resize(n);
    for (std::size_t i = 0; i < n; ++i) {
      kt[i] = discrete ? static_cast<double>(i) / static_cast<double>(n) : static_cast<double>(i) / static_cast<double>(n - 1);
    }
  }
  if (!discrete) {
    std::size_t i = 0;
    while (i + 2 < n && p >= kt[i + 1]) ++i;
    const double span = kt[i + 1] - kt[i];
    double f = span > 0 ? std::clamp((p - kt[i]) / span, 0.0, 1.0) : 1.0;
    if (calcMode == "spline" && i < splines.size()) f = spline_y(splines[i], f);
    if (auto v = lerp_value(vals[i], vals[i + 1], f)) return v;
    return f >= 1 ? vals[i + 1] : vals[i];  // not interpolable: each value holds its interval
  }
  std::size_t i = 0;
  while (i + 1 < n && p >= kt[i + 1]) ++i;
  return vals[i];
}

/// The presentation attributes that are CSS properties: an animated value goes
/// in as inline style too, so it beats a <style> rule as an animation does.
bool is_css_property(std::string_view a) {
  static constexpr std::array<std::string_view, 31> kProps = {
      "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray",
      "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "opacity", "visibility",
      "display", "color", "stop-color", "stop-opacity", "flood-color", "flood-opacity", "lighting-color",
      "font-size", "font-family", "font-weight", "font-style", "letter-spacing", "word-spacing", "text-anchor",
      "clip-path", "mask", "filter", "paint-order"};
  return std::ranges::find(kProps, a) != kProps.end();
}

// ── SMIL ─────────────────────────────────────────────────────────────────────

struct BeginSpec {
  enum class Kind : std::uint8_t { offset, syncBegin, syncEnd };
  Kind kind = Kind::offset;
  std::string ref;
  double offset = 0;
};

struct Smil {
  int target = -1;
  std::string tag;   // animate / set / animateColor / animateTransform / animateMotion
  std::string id;
  std::string attr;  // attributeName
  std::string type;  // animateTransform's
  std::string calcMode;
  std::string rotate;  // animateMotion's
  std::vector<std::string> values;
  std::vector<double> keyTimes;
  std::vector<std::array<double, 4>> keySplines;
  std::vector<std::array<double, 2>> motion;  // animateMotion: the path as a polyline
  std::vector<BeginSpec> begins;
  std::vector<double> instances;  // resolved begin times, ascending
  double dur = kInf;
  double active = kInf;
  double endAt = kInf;
  bool toAnimation = false;  // `to` alone: from = the base value
  bool byAnimation = false;  // `by` alone: base + by
  bool freeze = false;
  bool additiveSum = false;
};

std::optional<BeginSpec> parse_begin(std::string_view tok) {
  tok = trim_sv(tok);
  if (tok.empty() || tok == "indefinite") return std::nullopt;
  if (const auto c = parse_clock(tok)) return BeginSpec{BeginSpec::Kind::offset, {}, *c};
  const std::size_t dot = tok.find('.');
  if (dot == std::string_view::npos || dot == 0) return std::nullopt;  // an event (click …): never in an image
  std::string_view rest = tok.substr(dot + 1);
  BeginSpec b;
  b.ref = std::string(tok.substr(0, dot));
  if (rest.starts_with("begin")) {
    b.kind = BeginSpec::Kind::syncBegin;
    rest.remove_prefix(5);
  } else if (rest.starts_with("end")) {
    b.kind = BeginSpec::Kind::syncEnd;
    rest.remove_prefix(3);
  } else {
    return std::nullopt;  // id.click, id.repeat(n) …
  }
  rest = trim_sv(rest);
  if (!rest.empty()) {
    const bool neg = rest.front() == '-';
    if (rest.front() != '+' && !neg) return std::nullopt;
    const auto c = parse_clock(rest.substr(1));
    if (!c) return std::nullopt;
    b.offset = neg ? -*c : *c;
  }
  return b;
}

/// The polyline of path data (cubics in 16 steps), for animateMotion.
std::vector<std::array<double, 2>> flatten_path(std::string_view d) {
  std::vector<std::array<double, 2>> pts;
  std::array<double, 2> cur{0, 0};
  std::array<double, 2> start{0, 0};
  for (const PathSeg& s : parse_path_data(d)) {
    const auto at = [&s](std::size_t i) { return static_cast<double>(s.p.at(i)); };
    switch (s.op) {
      case PathSeg::Op::move:
        cur = {at(0), at(1)};
        start = cur;
        pts.push_back(cur);
        break;
      case PathSeg::Op::line:
        cur = {at(0), at(1)};
        pts.push_back(cur);
        break;
      case PathSeg::Op::cubic: {
        const std::array<double, 2> p0 = cur;
        for (int k = 1; k <= 16; ++k) {
          const double u = k / 16.0;
          const double v = 1 - u;
          pts.push_back({v * v * v * p0[0] + 3 * v * v * u * at(0) + 3 * v * u * u * at(2) + u * u * u * at(4),
                         v * v * v * p0[1] + 3 * v * v * u * at(1) + 3 * v * u * u * at(3) + u * u * u * at(5)});
        }
        cur = {at(4), at(5)};
        break;
      }
      case PathSeg::Op::close:
        cur = start;
        pts.push_back(cur);
        break;
    }
  }
  return pts;
}

std::vector<std::array<double, 2>> points_of(std::string_view s) {
  std::vector<std::array<double, 2>> pts;
  const std::vector<double> n = tmpl_of(s).nums;
  for (std::size_t i = 0; i + 1 < n.size(); i += 2) pts.push_back({n[i], n[i + 1]});
  return pts;
}

/// The point (and the tangent's angle, degrees) at a fraction of the polyline's length.
std::array<double, 3> along(const std::vector<std::array<double, 2>>& pts, double p) {
  if (pts.empty()) return {0, 0, 0};
  if (pts.size() == 1) return {pts[0][0], pts[0][1], 0};
  double total = 0;
  for (std::size_t i = 1; i < pts.size(); ++i) total += std::hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  double want = std::clamp(p, 0.0, 1.0) * total;
  for (std::size_t i = 1; i < pts.size(); ++i) {
    const double dx = pts[i][0] - pts[i - 1][0];
    const double dy = pts[i][1] - pts[i - 1][1];
    const double len = std::hypot(dx, dy);
    if (want <= len || i + 1 == pts.size()) {
      const double f = len > 0 ? std::clamp(want / len, 0.0, 1.0) : 0.0;
      return {pts[i - 1][0] + dx * f, pts[i - 1][1] + dy * f, std::atan2(dy, dx) * 180.0 / std::numbers::pi};
    }
    want -= len;
  }
  return {pts.back()[0], pts.back()[1], 0};
}

std::vector<Smil> collect_smil(const Document& doc) {
  std::vector<Smil> out;
  for (std::size_t i = 0; i < doc.nodes.size(); ++i) {
    const Node& n = doc.nodes[i];
    if (!n.element || !n.svgNs || n.shadow) continue;
    if (n.name != "animate" && n.name != "set" && n.name != "animateColor" && n.name != "animateTransform" &&
        n.name != "animateMotion") {
      continue;
    }
    Smil a;
    a.tag = n.name;
    const std::string* href = doc.href(static_cast<int>(i));
    a.target = href != nullptr && href->starts_with('#') ? doc.by_id(std::string_view(*href).substr(1)) : n.parent;
    if (a.target < 0) continue;
    const auto attr = [&n](std::string_view k) {
      const std::string* v = n.attr(k);
      return v != nullptr ? std::string(trim_sv(*v)) : std::string();
    };
    a.id = attr("id");
    a.attr = attr("attributeName");
    if (a.tag != "animateMotion" && a.attr.empty()) continue;
    if (a.tag == "animateTransform") {
      a.type = attr("type");
      if (a.type.empty()) a.type = "translate";
    }
    // Timing.
    const std::string begin = attr("begin");
    if (begin.empty()) {
      a.begins.emplace_back();
    } else {
      for (const std::string_view tok : split_list(begin, ';')) {
        if (auto b = parse_begin(tok)) a.begins.push_back(std::move(*b));
      }
    }
    if (const auto d = parse_clock(attr("dur")); d && *d > 0) a.dur = *d;
    const std::string rc = attr("repeatCount");
    const std::string rd = attr("repeatDur");
    double ad = kInf;
    bool repeats = false;
    if (!rc.empty()) {
      repeats = true;
      if (rc != "indefinite") {
        if (const auto c = lead_number(rc); c && c->first > 0) ad = std::min(ad, c->first * a.dur);
      }
    }
    if (!rd.empty()) {
      repeats = true;
      if (rd != "indefinite") {
        if (const auto c = parse_clock(rd)) ad = std::min(ad, *c);
      }
    }
    a.active = repeats ? ad : a.dur;
    if (const auto e = parse_clock(attr("end"))) a.endAt = *e;
    a.freeze = attr("fill") == "freeze";
    a.additiveSum = attr("additive") == "sum";
    a.calcMode = attr("calcMode");
    if (a.calcMode.empty()) a.calcMode = a.tag == "set" ? "discrete" : a.tag == "animateMotion" ? "paced" : "linear";
    // Values.
    if (a.tag == "set") {
      a.values = {attr("to")};
    } else if (const std::string* vs = n.attr("values")) {
      for (const std::string_view v : split_list(*vs, ';')) a.values.emplace_back(v);
    } else {
      const std::string from = attr("from");
      const std::string to = attr("to");
      const std::string by = attr("by");
      if (!from.empty() && !to.empty()) {
        a.values = {from, to};
      } else if (!to.empty()) {
        a.values = {to};
        a.toAnimation = true;
      } else if (!by.empty()) {
        if (!from.empty()) {
          if (auto sum = add_value(from, by)) a.values = {from, *sum};
        } else {
          a.values = {by};
          a.byAnimation = true;
        }
      }
    }
    if (const std::string* kt = n.attr("keyTimes")) {
      for (const std::string_view v : split_list(*kt, ';')) {
        if (const auto x = lead_number(v)) a.keyTimes.push_back(x->first);
      }
    }
    if (const std::string* ks = n.attr("keySplines")) {
      for (const std::string_view seg : split_list(*ks, ';')) {
        const std::vector<double> v = tmpl_of(seg).nums;
        if (v.size() == 4) a.keySplines.push_back({v[0], v[1], v[2], v[3]});
      }
    }
    if (a.tag == "animateMotion") {
      a.rotate = attr("rotate");
      std::string pathData = attr("path");
      for (const int c : n.children) {
        const Node& ch = doc.nodes[static_cast<std::size_t>(c)];
        if (!ch.element || ch.name != "mpath") continue;
        const std::string* mh = doc.href(c);
        const int ref = mh != nullptr && mh->starts_with('#') ? doc.by_id(std::string_view(*mh).substr(1)) : -1;
        if (ref >= 0) {
          if (const std::string* d = doc.nodes[static_cast<std::size_t>(ref)].attr("d")) pathData = *d;
        }
      }
      if (!pathData.empty()) {
        a.motion = flatten_path(pathData);
      } else {
        for (const std::string& v : a.values) {
          for (const auto& p : points_of(v)) a.motion.push_back(p);
        }
        if (a.toAnimation) a.motion.insert(a.motion.begin(), std::array<double, 2>{0, 0});
      }
      if (a.motion.empty()) continue;
    } else if (a.values.empty()) {
      continue;
    }
    out.push_back(std::move(a));
  }
  return out;
}

double active_for(const Smil& a, double begin) {
  double ad = a.active;
  if (a.endAt < kInf && a.endAt > begin) ad = std::min(ad, a.endAt - begin);
  return ad;
}

/// Every animation's begin times up to `horizon`, syncbase references followed
/// until nothing changes (at most `passes` rounds).
void resolve_instances(std::vector<Smil>& anims, double horizon, int passes) {
  std::map<std::string, std::size_t, std::less<>> byId;
  for (std::size_t i = 0; i < anims.size(); ++i) {
    if (!anims[i].id.empty()) byId.emplace(anims[i].id, i);
  }
  for (Smil& a : anims) {
    a.instances.clear();
    for (const BeginSpec& b : a.begins) {
      if (b.kind == BeginSpec::Kind::offset && b.offset <= horizon) a.instances.push_back(b.offset);
    }
    std::ranges::sort(a.instances);
  }
  for (int pass = 0; pass < passes; ++pass) {
    bool changed = false;
    for (Smil& a : anims) {
      const bool sync = std::ranges::any_of(a.begins, [](const BeginSpec& b) { return b.kind != BeginSpec::Kind::offset; });
      if (!sync) continue;
      std::vector<double> next;
      for (const BeginSpec& b : a.begins) {
        if (b.kind == BeginSpec::Kind::offset) {
          if (b.offset <= horizon) next.push_back(b.offset);
          continue;
        }
        const auto it = byId.find(b.ref);
        if (it == byId.end()) continue;
        const Smil& r = anims[it->second];
        for (const double rb : r.instances) {
          const double at = b.kind == BeginSpec::Kind::syncBegin ? rb + b.offset : rb + active_for(r, rb) + b.offset;
          if (std::isfinite(at) && at <= horizon) next.push_back(at);
          if (next.size() >= kMaxInstances) break;
        }
      }
      std::ranges::sort(next);
      next.erase(std::unique(next.begin(), next.end(), [](double x, double y) { return std::abs(x - y) < 1e-9; }), next.end());
      if (next != a.instances) {
        a.instances = std::move(next);
        changed = true;
      }
    }
    if (!changed) break;
  }
}

struct Sample {
  bool on = false;
  double p = 0;
};

/// Whether the animation applies at `t`, and its simple-duration progress.
Sample sample(const Smil& a, double t) {
  double b = -kInf;
  for (const double x : a.instances) {
    if (x > t + 1e-9) break;
    b = x;
  }
  if (!std::isfinite(b)) return {};
  const double ad = active_for(a, b);
  const double elapsed = t - b;
  const bool finiteDur = a.dur < kInf && a.dur > 0;
  if (elapsed < ad) {
    if (!finiteDur) return {true, 0.0};
    const double st = elapsed - std::floor(elapsed / a.dur) * a.dur;
    return {true, std::clamp(st / a.dur, 0.0, 1.0)};
  }
  if (!a.freeze) return {};
  if (!finiteDur) return {true, 0.0};
  const double st = ad - std::floor(ad / a.dur) * a.dur;
  return {true, st < 1e-9 && ad > 0 ? 1.0 : std::clamp(st / a.dur, 0.0, 1.0)};
}

void apply_smil(Document& doc, double t) {
  std::vector<Smil> anims = collect_smil(doc);
  if (anims.empty()) return;
  resolve_instances(anims, t, kMaxPasses);
  std::map<int, std::string> xf;      // target → its transform being built (animateTransform)
  std::map<int, std::string> motion;  // target → its motion transform
  std::map<int, std::string> inlineCss;
  for (const Smil& a : anims) {
    const Sample s = sample(a, t);
    if (!s.on) continue;
    Node& tgt = doc.nodes[static_cast<std::size_t>(a.target)];
    if (a.tag == "animateMotion") {
      const std::array<double, 3> at = along(a.motion, s.p);
      std::string m = "translate(" + num_text(at[0]) + " " + num_text(at[1]) + ")";
      if (a.rotate == "auto") m += " rotate(" + num_text(at[2]) + ")";
      else if (a.rotate == "auto-reverse") m += " rotate(" + num_text(at[2] + 180) + ")";
      else if (const auto r = lead_number(a.rotate)) m += " rotate(" + num_text(r->first) + ")";
      motion[a.target] = std::move(m);
      continue;
    }
    std::vector<std::string> vals = a.values;
    if (a.toAnimation || a.byAnimation) {
      const std::string* cur = tgt.attr(a.tag == "animateTransform" ? "transform" : a.attr);
      const std::string base = cur != nullptr ? *cur : std::string();
      if (a.byAnimation) {
        const auto sum = add_value(base.empty() ? "0" : base, vals[0]);
        if (!sum) continue;
        vals = {base.empty() ? "0" : base, *sum};
      } else if (!base.empty() && a.tag != "animateTransform") {
        vals.insert(vals.begin(), base);
      }
    }
    const auto value = value_at(vals, a.keyTimes, a.calcMode, a.keySplines, s.p);
    if (!value) continue;
    if (a.tag == "animateTransform") {
      const std::string fn = a.type + "(" + *value + ")";
      const std::string* base = tgt.attr("transform");
      const auto it = xf.try_emplace(a.target, base != nullptr ? *base : std::string()).first;
      it->second = a.additiveSum && !it->second.empty() ? it->second + " " + fn : fn;
      continue;
    }
    tgt.set_attr(a.attr, *value);
    if (is_css_property(a.attr)) inlineCss[a.target] += ";" + a.attr + ":" + *value;
  }
  for (const auto& [node, v] : xf) doc.nodes[static_cast<std::size_t>(node)].set_attr("transform", v);
  for (const auto& [node, m] : motion) {
    Node& n = doc.nodes[static_cast<std::size_t>(node)];
    const std::string* cur = n.attr("transform");
    n.set_attr("transform", cur != nullptr && !cur->empty() ? m + " " + *cur : m);
  }
  for (const auto& [node, decls] : inlineCss) {
    Node& n = doc.nodes[static_cast<std::size_t>(node)];
    const std::string* cur = n.attr("style");
    n.set_attr("style", (cur != nullptr ? *cur : std::string()) + decls);
  }
}

// ── CSS animations ───────────────────────────────────────────────────────────

using Decls = std::vector<std::pair<std::string, std::string>>;

struct Keyframe {
  double offset = 0;
  Decls decls;
};

struct CssRule {
  std::string selector;
  Decls decls;
};

struct CssAnim {
  std::string name;
  std::string timing = "ease";
  std::string direction = "normal";
  std::string fill = "none";
  double duration = 0;
  double delay = 0;
  double count = 1;
};

struct Sheet {
  std::vector<CssRule> rules;
  std::map<std::string, std::vector<Keyframe>, std::less<>> keyframes;
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

/// The end of the block whose `{` is at `open` (one past its `}`).
std::size_t block_end(std::string_view s, std::size_t open) {
  int depth = 0;
  char quote = 0;
  for (std::size_t k = open; k < s.size(); ++k) {
    const char c = s[k];
    if (quote != 0) {
      if (c == quote) quote = 0;
      continue;
    }
    if (c == '"' || c == '\'') quote = c;
    else if (c == '{') ++depth;
    else if (c == '}' && --depth == 0) return k + 1;
  }
  return s.size();
}

Decls parse_decls(std::string_view body) {
  Decls out;
  for (const std::string_view d : split_list(body, ';')) {
    const std::size_t colon = d.find(':');
    if (colon == std::string_view::npos) continue;
    std::string value(trim_sv(d.substr(colon + 1)));
    if (const std::size_t imp = lower_s(value).find("!important"); imp != std::string::npos) value = std::string(trim_sv(std::string_view(value).substr(0, imp)));
    out.emplace_back(lower_s(trim_sv(d.substr(0, colon))), std::move(value));
  }
  return out;
}

/// Parse a style sheet's rules and @keyframes; `stripped` gets the sheet without its @keyframes blocks.
void parse_sheet(std::string_view css, Sheet& sheet, std::string& stripped) {
  const std::string text = strip_comments(css);
  std::string_view s = text;
  while (true) {
    stripped.push_back('\n');
    s = trim_sv(s);
    if (s.empty()) return;
    const std::size_t open = s.find('{');
    const std::size_t semi = s.find(';');
    if (s.front() == '@') {
      std::size_t nameEnd = 1;
      while (nameEnd < s.size() && !is_space(s[nameEnd]) && s[nameEnd] != '{' && s[nameEnd] != ';') ++nameEnd;
      const std::string at = lower_s(s.substr(0, nameEnd));
      if (open == std::string_view::npos || (semi != std::string_view::npos && semi < open)) {
        const std::size_t stop = semi == std::string_view::npos ? s.size() : semi + 1;
        stripped.append(s.substr(0, stop));
        s.remove_prefix(stop);
        continue;
      }
      const std::size_t end = block_end(s, open);
      if (at == "@keyframes" || at == "@-webkit-keyframes") {
        std::string name(trim_sv(s.substr(nameEnd, open - nameEnd)));
        if (name.size() >= 2 && (name.front() == '"' || name.front() == '\'')) name = name.substr(1, name.size() - 2);
        std::vector<Keyframe>& frames = sheet.keyframes[name];
        frames.clear();
        std::string_view inner = s.substr(open + 1, end - open - 2);
        while (true) {
          inner = trim_sv(inner);
          const std::size_t fo = inner.find('{');
          if (inner.empty() || fo == std::string_view::npos) break;
          const std::size_t fe = block_end(inner, fo);
          const Decls decls = parse_decls(inner.substr(fo + 1, fe - fo - 2));
          for (const std::string_view sel : split_list(inner.substr(0, fo), ',')) {
            const std::string k = lower_s(sel);
            double off = -1;
            if (k == "from") off = 0;
            else if (k == "to") off = 1;
            else if (const auto n = lead_number(k); n && k.substr(n->second) == "%") off = n->first / 100;
            if (off >= 0 && off <= 1) frames.push_back({off, decls});
          }
          inner.remove_prefix(fe);
        }
        std::ranges::stable_sort(frames, [](const Keyframe& x, const Keyframe& y) { return x.offset < y.offset; });
      } else {
        stripped.append(s.substr(0, end));
      }
      s.remove_prefix(end);
      continue;
    }
    if (open == std::string_view::npos) {
      stripped.append(s);
      return;
    }
    const std::size_t end = block_end(s, open);
    sheet.rules.push_back({std::string(trim_sv(s.substr(0, open))), parse_decls(s.substr(open + 1, end - open - 2))});
    stripped.append(s.substr(0, end));
    s.remove_prefix(end);
  }
}

bool is_timing(std::string_view t) {
  return t == "linear" || t == "ease" || t == "ease-in" || t == "ease-out" || t == "ease-in-out" || t == "step-start" ||
         t == "step-end" || t.starts_with("cubic-bezier(") || t.starts_with("steps(");
}

/// A rule's animations (the shorthand, then the longhands over it).
std::vector<CssAnim> animations_of(const Decls& decls) {
  std::vector<CssAnim> anims;
  for (const auto& [prop, value] : decls) {
    if (prop == "animation") {
      anims.clear();
      for (const std::string_view one : split_list(value, ',')) {
        CssAnim a;
        bool haveDuration = false;
        for (const std::string_view tok0 : split_ws(one)) {
          const std::string tok = lower_s(tok0);
          if (const auto c = parse_clock(tok); c && (tok.ends_with('s'))) {
            if (!haveDuration) a.duration = *c;
            else a.delay = *c;
            haveDuration = true;
          } else if (tok == "infinite") {
            a.count = kInf;
          } else if (const auto n = lead_number(tok); n && n->second == tok.size()) {
            a.count = n->first;
          } else if (tok == "normal" || tok == "reverse" || tok == "alternate" || tok == "alternate-reverse") {
            a.direction = tok;
          } else if (tok == "forwards" || tok == "backwards" || tok == "both") {
            a.fill = tok;
          } else if (is_timing(tok)) {
            a.timing = tok;
          } else if (tok != "running" && tok != "paused" && tok != "none") {
            a.name = std::string(tok0);
          }
        }
        anims.push_back(std::move(a));
      }
      continue;
    }
    if (!prop.starts_with("animation-")) continue;
    const std::vector<std::string_view> items = split_list(value, ',');
    if (items.empty()) continue;
    if (prop == "animation-name" && anims.size() < items.size()) anims.resize(items.size());
    for (std::size_t i = 0; i < anims.size(); ++i) {
      const std::string_view item = items[i % items.size()];
      const std::string v = lower_s(item);
      CssAnim& a = anims[i];
      if (prop == "animation-name") a.name = std::string(item);
      else if (prop == "animation-duration") a.duration = parse_clock(v).value_or(a.duration);
      else if (prop == "animation-delay") a.delay = parse_clock(v).value_or(a.delay);
      else if (prop == "animation-iteration-count") a.count = v == "infinite" ? kInf : lead_number(v).value_or(std::make_pair(a.count, std::size_t{0})).first;
      else if (prop == "animation-direction") a.direction = v;
      else if (prop == "animation-fill-mode") a.fill = v;
      else if (prop == "animation-timing-function") a.timing = v;
    }
  }
  std::erase_if(anims, [](const CssAnim& a) { return a.name.empty() || a.name == "none"; });
  return anims;
}

/// A CSS timing function at x.
double ease(std::string_view fn, double x) {
  if (fn == "linear") return x;
  if (fn == "ease") return spline_y({0.25, 0.1, 0.25, 1}, x);
  if (fn == "ease-in") return spline_y({0.42, 0, 1, 1}, x);
  if (fn == "ease-out") return spline_y({0, 0, 0.58, 1}, x);
  if (fn == "ease-in-out") return spline_y({0.42, 0, 0.58, 1}, x);
  if (fn.starts_with("cubic-bezier(")) {
    const std::vector<double> v = tmpl_of(fn.substr(12)).nums;
    if (v.size() == 4) return spline_y({v[0], v[1], v[2], v[3]}, x);
    return x;
  }
  std::string pos = "end";
  double steps = 1;
  if (fn == "step-start") {
    pos = "start";
  } else if (fn.starts_with("steps(")) {
    const std::vector<std::string_view> args = split_list(fn.substr(6, fn.size() > 7 ? fn.size() - 7 : 0), ',');
    if (!args.empty()) steps = std::max(1.0, lead_number(args[0]).value_or(std::make_pair(1.0, std::size_t{0})).first);
    if (args.size() > 1) pos = std::string(args[1]);
  } else if (fn != "step-end") {
    return x;
  }
  if (pos == "start" || pos == "jump-start") return std::min(1.0, std::ceil(x * steps) / steps);
  if (pos == "jump-none") return steps > 1 ? std::min(1.0, std::floor(x * steps) / (steps - 1)) : x;
  if (pos == "jump-both") return std::min(1.0, (std::floor(x * steps) + 1) / (steps + 1));
  return x >= 1 ? 1.0 : std::floor(x * steps) / steps;
}

/// A CSS transform as SVG transform syntax (px / angles normalised); "" for none.
std::optional<std::string> svg_transform_of(std::string_view v) {
  v = trim_sv(v);
  if (v.empty() || lower_s(v) == "none") return std::string();
  std::string out;
  std::size_t i = 0;
  while (i < v.size()) {
    while (i < v.size() && is_space(v[i])) ++i;
    if (i >= v.size()) break;
    const std::size_t open = v.find('(', i);
    if (open == std::string_view::npos) return std::nullopt;
    const std::size_t close = v.find(')', open);
    if (close == std::string_view::npos) return std::nullopt;
    const std::string fn = lower_s(trim_sv(v.substr(i, open - i)));
    std::vector<double> args;
    for (const std::string_view raw : split_list(v.substr(open + 1, close - open - 1), ',')) {
      for (const std::string_view a : split_ws(raw)) {
        const auto n = lead_number(a);
        if (!n) return std::nullopt;
        const std::string unit = lower_s(a.substr(n->second));
        double x = n->first;
        if (unit == "rad") x = x * 180.0 / std::numbers::pi;
        else if (unit == "turn") x *= 360.0;
        else if (unit == "grad") x *= 0.9;
        else if (!unit.empty() && unit != "px" && unit != "deg") return std::nullopt;  // % needs a box
        args.push_back(x);
      }
    }
    const auto arg = [&args](std::size_t k, double dflt) { return k < args.size() ? args[k] : dflt; };
    std::string part;
    if (fn == "translate" || fn == "translate3d") part = "translate(" + num_text(arg(0, 0)) + " " + num_text(arg(1, 0)) + ")";
    else if (fn == "translatex") part = "translate(" + num_text(arg(0, 0)) + " 0)";
    else if (fn == "translatey") part = "translate(0 " + num_text(arg(0, 0)) + ")";
    else if (fn == "scale" || fn == "scale3d") part = "scale(" + num_text(arg(0, 1)) + " " + num_text(arg(1, arg(0, 1))) + ")";
    else if (fn == "scalex") part = "scale(" + num_text(arg(0, 1)) + " 1)";
    else if (fn == "scaley") part = "scale(1 " + num_text(arg(0, 1)) + ")";
    else if (fn == "rotate" || fn == "rotatez") part = "rotate(" + num_text(arg(0, 0)) + ")";
    else if (fn == "skewx") part = "skewX(" + num_text(arg(0, 0)) + ")";
    else if (fn == "skewy") part = "skewY(" + num_text(arg(0, 0)) + ")";
    else if (fn == "skew") part = "skewX(" + num_text(arg(0, 0)) + ") skewY(" + num_text(arg(1, 0)) + ")";
    else if (fn == "matrix" && args.size() == 6) {
      part = "matrix(" + num_text(args[0]) + " " + num_text(args[1]) + " " + num_text(args[2]) + " " + num_text(args[3]) + " " +
             num_text(args[4]) + " " + num_text(args[5]) + ")";
    } else {
      return std::nullopt;
    }
    if (!out.empty()) out.push_back(' ');
    out += part;
    i = close + 1;
  }
  return out;
}

/// The identity of the same shape as an SVG transform list ("rotate(30)" → "rotate(0)").
std::string identity_like(const std::string& svg) {
  std::string out;
  std::size_t i = 0;
  while (i < svg.size()) {
    const std::size_t open = svg.find('(', i);
    if (open == std::string::npos) break;
    const std::size_t close = svg.find(')', open);
    if (close == std::string::npos) break;
    const std::string fn(trim_sv(std::string_view(svg).substr(i, open - i)));
    const std::size_t n = tmpl_of(std::string_view(svg).substr(open, close - open)).nums.size();
    std::string args;
    for (std::size_t k = 0; k < n; ++k) {
      const bool one = fn == "scale" || (fn == "matrix" && (k == 0 || k == 3));
      args += (k > 0 ? " " : "") + std::string(one ? "1" : "0");
    }
    if (!out.empty()) out.push_back(' ');
    out += fn + "(" + args + ")";
    i = close + 1;
  }
  return out;
}

const std::string* decl(const Decls& d, std::string_view prop) {
  const std::string* found = nullptr;
  for (const auto& [p, v] : d) {
    if (p == prop) found = &v;
  }
  return found;
}

/// A property's keyframed value at iteration progress x (SVG transform syntax for `transform`).
std::optional<std::string> keyframe_value(const std::vector<Keyframe>& frames, const std::string& prop, double x,
                                          const std::string& timing) {
  std::vector<const Keyframe*> fs;
  for (const Keyframe& k : frames) {
    if (decl(k.decls, prop) != nullptr) fs.push_back(&k);
  }
  if (fs.empty()) return std::nullopt;
  const bool isTransform = prop == "transform";
  const auto value = [&](const Keyframe* k) -> std::optional<std::string> {
    const std::string& v = *decl(k->decls, prop);
    return isTransform ? svg_transform_of(v) : std::optional<std::string>(v);
  };
  if (x <= fs.front()->offset || fs.size() == 1) return value(fs.front());
  if (x >= fs.back()->offset) return value(fs.back());
  std::size_t i = 0;
  while (i + 2 < fs.size() && x >= fs[i + 1]->offset) ++i;
  const double span = fs[i + 1]->offset - fs[i]->offset;
  double f = span > 0 ? std::clamp((x - fs[i]->offset) / span, 0.0, 1.0) : 1.0;
  const std::string* own = decl(fs[i]->decls, "animation-timing-function");
  f = ease(own != nullptr ? lower_s(*own) : timing, f);
  auto a = value(fs[i]);
  auto b = value(fs[i + 1]);
  if (!a || !b) return std::nullopt;
  if (isTransform) {
    if (a->empty() && !b->empty()) *a = identity_like(*b);
    if (b->empty() && !a->empty()) *b = identity_like(*a);
  }
  if (auto v = lerp_value(*a, *b, f)) return v;
  return f < 0.5 ? a : b;
}

/// An animation's iteration progress at `t` (direction applied); nullopt when it has no effect.
std::optional<double> css_progress(const CssAnim& a, double t) {
  const double local = t - a.delay;
  const auto directed = [&a](double iter, double x) {
    const bool odd = std::fmod(iter, 2.0) >= 1.0;
    if (a.direction == "reverse") return 1 - x;
    if (a.direction == "alternate") return odd ? 1 - x : x;
    if (a.direction == "alternate-reverse") return odd ? x : 1 - x;
    return x;
  };
  if (local < 0) {
    if (a.fill != "backwards" && a.fill != "both") return std::nullopt;
    return directed(0, 0);
  }
  if (a.duration <= 0) return std::nullopt;
  const double total = a.count * a.duration;
  if (local >= total) {
    if (a.fill != "forwards" && a.fill != "both") return std::nullopt;
    const double frac = a.count - std::floor(a.count);
    const double iter = frac == 0 ? a.count - 1 : std::floor(a.count);
    return directed(iter, frac == 0 ? 1.0 : frac);
  }
  const double iter = std::floor(local / a.duration);
  return directed(iter, (local - iter * a.duration) / a.duration);
}

struct Box {
  double x = 0, y = 0, w = 0, h = 0;
};

/// transform-box: view-box — the root's viewBox, else its size.
Box view_box(const Document& doc) {
  const Node& root = doc.nodes[static_cast<std::size_t>(doc.root)];
  if (const std::string* vb = root.attr("viewBox")) {
    if (const auto v = parse_view_box(*vb)) return {v->x, v->y, v->w, v->h};
  }
  const auto len = [&root](std::string_view k) {
    const std::string* v = root.attr(k);
    const auto n = v != nullptr ? lead_number(trim_sv(*v)) : std::nullopt;
    return n ? n->first : 0.0;
  };
  return {0, 0, len("width"), len("height")};
}

/// transform-box: fill-box — the element's own geometry (basic shapes, points, path control points).
std::optional<Box> fill_box(const Node& n) {
  const auto num = [&n](std::string_view k) {
    const std::string* v = n.attr(k);
    const auto x = v != nullptr ? lead_number(trim_sv(*v)) : std::nullopt;
    return x ? x->first : 0.0;
  };
  if (n.name == "rect" || n.name == "image" || n.name == "use") return Box{num("x"), num("y"), num("width"), num("height")};
  if (n.name == "circle") return Box{num("cx") - num("r"), num("cy") - num("r"), 2 * num("r"), 2 * num("r")};
  if (n.name == "ellipse") return Box{num("cx") - num("rx"), num("cy") - num("ry"), 2 * num("rx"), 2 * num("ry")};
  std::vector<std::array<double, 2>> pts;
  if (n.name == "line") pts = {{num("x1"), num("y1")}, {num("x2"), num("y2")}};
  else if ((n.name == "polygon" || n.name == "polyline") && n.attr("points") != nullptr) pts = points_of(*n.attr("points"));
  else if (n.name == "path" && n.attr("d") != nullptr) pts = flatten_path(*n.attr("d"));
  if (pts.empty()) return std::nullopt;
  double x0 = kInf, y0 = kInf, x1 = -kInf, y1 = -kInf;
  for (const auto& p : pts) {
    x0 = std::min(x0, p[0]);
    y0 = std::min(y0, p[1]);
    x1 = std::max(x1, p[0]);
    y1 = std::max(y1, p[1]);
  }
  return Box{x0, y0, x1 - x0, y1 - y0};
}

/// transform-origin against the reference box (CSS default for SVG elements: 0 0 of the view box).
std::array<double, 2> origin_of(const std::string* spec, const Box& box) {
  if (spec == nullptr) return {box.x, box.y};
  std::vector<std::string> toks;
  for (const std::string_view t : split_ws(*spec)) toks.push_back(lower_s(t));
  if (toks.empty()) return {box.x, box.y};
  // One value: the other axis is centred ("top" alone is the vertical one).
  if (toks.size() == 1) toks.insert(toks[0] == "top" || toks[0] == "bottom" ? toks.begin() : toks.end(), "center");
  if (toks[0] == "top" || toks[0] == "bottom" || toks[1] == "left" || toks[1] == "right") std::swap(toks[0], toks[1]);
  const auto resolve = [](const std::string& t, double start, double size) {
    if (t == "left" || t == "top") return start;
    if (t == "right" || t == "bottom") return start + size;
    if (t == "center") return start + size / 2;
    const auto n = lead_number(t);
    if (!n) return start;
    return t.substr(n->second) == "%" ? start + size * n->first / 100 : start + n->first;
  };
  return {resolve(toks[0], box.x, box.w), resolve(toks[1], box.y, box.h)};
}

void apply_css(Document& doc, double t, std::string& extraCss, std::vector<std::string>& unsupported) {
  Sheet sheet;
  std::vector<std::pair<int, std::string>> rewritten;  // <style> text nodes without their @keyframes
  for (std::size_t i = 0; i < doc.nodes.size(); ++i) {
    const Node& n = doc.nodes[i];
    if (!n.element || n.name != "style") continue;
    for (const int c : n.children) {
      const Node& tx = doc.nodes[static_cast<std::size_t>(c)];
      if (tx.element) continue;
      std::string stripped;
      parse_sheet(tx.text, sheet, stripped);
      rewritten.emplace_back(c, std::move(stripped));
    }
  }
  if (sheet.keyframes.empty()) return;
  for (auto& [node, text] : rewritten) doc.nodes[static_cast<std::size_t>(node)].text = std::move(text);
  const Box vb = view_box(doc);
  for (const CssRule& rule : sheet.rules) {
    for (const CssAnim& a : animations_of(rule.decls)) {
      const auto kf = sheet.keyframes.find(a.name);
      if (kf == sheet.keyframes.end()) continue;
      const auto x = css_progress(a, t);
      if (!x) continue;
      std::vector<std::string> props;
      for (const Keyframe& k : kf->second) {
        for (const auto& [p, v] : k.decls) {
          if (p != "animation-timing-function" && std::ranges::find(props, p) == props.end()) props.push_back(p);
        }
      }
      std::string decls;
      for (const std::string& p : props) {
        const auto v = keyframe_value(kf->second, p, *x, a.timing);
        if (!v) {
          const std::string why = "CSS animation of transform with % lengths";
          if (p == "transform" && std::ranges::find(unsupported, why) == unsupported.end()) unsupported.push_back(why);
          continue;
        }
        if (p != "transform") {
          decls += p + ":" + *v + " !important;";
          continue;
        }
        // CSS transform beats the transform attribute: written as one, about transform-origin.
        const std::string* originSpec = nullptr;
        const std::string* boxSpec = nullptr;
        for (const CssRule& r : sheet.rules) {
          if (r.selector != rule.selector) continue;
          if (const std::string* o = decl(r.decls, "transform-origin")) originSpec = o;
          if (const std::string* b = decl(r.decls, "transform-box")) boxSpec = b;
        }
        for (const int node : select_nodes(doc, rule.selector)) {
          const Node& n = doc.nodes[static_cast<std::size_t>(node)];
          Box box = vb;
          if (boxSpec != nullptr && lower_s(*boxSpec) != "view-box") box = fill_box(n).value_or(vb);
          const std::array<double, 2> o = origin_of(originSpec, box);
          std::string xf = *v;
          if (!xf.empty() && (o[0] != 0 || o[1] != 0)) {
            xf = "translate(" + num_text(o[0]) + " " + num_text(o[1]) + ") " + xf + " translate(" + num_text(-o[0]) + " " + num_text(-o[1]) + ")";
          }
          doc.nodes[static_cast<std::size_t>(node)].set_attr("transform", xf);
        }
      }
      if (!decls.empty()) extraCss += rule.selector + "{" + decls + "}\n";
    }
  }
}

}  // namespace

AnimationInfo animation_info(const Document& doc) {
  AnimationInfo info;
  std::vector<Smil> anims = collect_smil(doc);
  if (!anims.empty()) {
    info.animated = true;
    resolve_instances(anims, kInf, static_cast<int>(anims.size()) + 2);
    for (const Smil& a : anims) {
      if (a.instances.empty()) continue;
      const double first = a.instances.front();
      const double ad = active_for(a, first);
      const double end = std::isfinite(ad) ? first + ad : a.dur < kInf ? first + a.dur : first;
      info.durationSec = std::max(info.durationSec, end);
    }
  }
  Sheet sheet;
  for (const Node& n : doc.nodes) {
    if (!n.element || n.name != "style") continue;
    for (const int c : n.children) {
      const Node& tx = doc.nodes[static_cast<std::size_t>(c)];
      if (tx.element) continue;
      std::string ignored;
      parse_sheet(tx.text, sheet, ignored);
    }
  }
  for (const CssRule& rule : sheet.rules) {
    for (const CssAnim& a : animations_of(rule.decls)) {
      if (!sheet.keyframes.contains(a.name) || a.duration <= 0) continue;
      info.animated = true;
      const double run = std::isfinite(a.count) ? a.count * a.duration : a.duration;
      info.durationSec = std::max(info.durationSec, a.delay + run);
    }
  }
  return info;
}

void apply_animations(Document& doc, double t, std::string& extraCss, std::vector<std::string>& unsupported) {
  apply_smil(doc, t);
  apply_css(doc, t, extraCss, unsupported);
}

}  // namespace premation::raster::svg
