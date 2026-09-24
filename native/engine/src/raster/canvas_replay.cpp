#include "canvas_replay.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <map>
#include <memory>
#include <set>

#include "json.hpp"

namespace premation::raster {
namespace {

using json::Value;

std::optional<LineCap> cap_of(std::string_view s) {
  if (s == "butt") return LineCap::butt;
  if (s == "round") return LineCap::round;
  if (s == "square") return LineCap::square;
  return std::nullopt;
}
std::optional<LineJoin> join_of(std::string_view s) {
  if (s == "miter") return LineJoin::miter;
  if (s == "round") return LineJoin::round;
  if (s == "bevel") return LineJoin::bevel;
  return std::nullopt;
}
std::optional<TextAlign> align_of(std::string_view s) {
  if (s == "start") return TextAlign::start;
  if (s == "end") return TextAlign::end;
  if (s == "left") return TextAlign::left;
  if (s == "right") return TextAlign::right;
  if (s == "center") return TextAlign::center;
  return std::nullopt;
}
std::optional<TextBaseline> baseline_of(std::string_view s) {
  if (s == "alphabetic") return TextBaseline::alphabetic;
  if (s == "top") return TextBaseline::top;
  if (s == "hanging") return TextBaseline::hanging;
  if (s == "middle") return TextBaseline::middle;
  if (s == "ideographic") return TextBaseline::ideographic;
  if (s == "bottom") return TextBaseline::bottom;
  return std::nullopt;
}

class Replayer {
 public:
  explicit Replayer(const CanvasOptions& o) : opts_(o) {}

  ReplayResult run(std::string_view opsJson) {
    ReplayResult res;
    Value ops;
    if (!json::parse(opsJson, ops, res.error)) return res;
    if (!ops.is_array()) {
      res.error = "ops is not an array";
      return res;
    }
    for (const Value& op : ops.items()) {
      ++res.ops;
      step(op, res);
    }
    const auto it = canvases_.find(0);
    if (it == canvases_.end()) {
      res.error = "no canvas 0 in the log";
      return res;
    }
    res.width = it->second->width();
    res.height = it->second->height();
    res.rgba = it->second->pixels();
    res.unsupported.assign(unsupported_.begin(), unsupported_.end());
    res.ok = true;
    return res;
  }

 private:
  CanvasOptions opts_;
  std::map<int, std::unique_ptr<Canvas2D>> canvases_;
  std::map<int, std::shared_ptr<Gradient>> gradients_;
  std::map<int, std::shared_ptr<Pattern>> patterns_;
  std::map<int, Path2D> paths_;
  std::set<std::string> unsupported_;

  Canvas2D* canvas(int id) {
    const auto it = canvases_.find(id);
    return it == canvases_.end() ? nullptr : it->second.get();
  }

  std::optional<Style> style_of(const Value& v) {
    Style s;
    if (v.is_string()) {
      const auto c = css::parse_color(v.str());
      if (!c) return std::nullopt;
      s.kind = Style::Kind::color;
      s.color = *c;
      return s;
    }
    if (v.has("$g")) {
      const auto it = gradients_.find(static_cast<int>(v["$g"].num()));
      if (it == gradients_.end()) return std::nullopt;
      s.kind = Style::Kind::gradient;
      s.gradient = it->second;
      return s;
    }
    if (v.has("$p")) {
      const auto it = patterns_.find(static_cast<int>(v["$p"].num()));
      if (it == patterns_.end()) return std::nullopt;
      s.kind = Style::Kind::pattern;
      s.pattern = it->second;
      return s;
    }
    return std::nullopt;
  }

  static double n(const Value& op, std::size_t i) { return op[i].num(std::nan("")); }

  void step(const Value& op, ReplayResult& res) {
    const int cid = static_cast<int>(op[0].num(-1));
    const std::string_view kind = op[1].str_or("");
    if (kind == "canvas") {
      const auto w = static_cast<std::uint32_t>(std::max(1.0, op[2].num(1)));
      const auto h = static_cast<std::uint32_t>(std::max(1.0, op[3].num(1)));
      if (auto* c = canvas(cid)) c->resize(w, h);
      else canvases_[cid] = Canvas2D::make(w, h, opts_);
      return;
    }
    if (kind == "stop") {
      const auto it = gradients_.find(static_cast<int>(op[2].num(-1)));
      const auto c = css::parse_color(op[4].str_or(""));
      if (it != gradients_.end() && c) it->second->add_stop(op[3].num(0), *c);
      return;
    }
    if (kind == "path2d") {
      Path2D p;
      const Value& init = op[3];
      if (init.has("$path")) {
        const auto it = paths_.find(static_cast<int>(init["$path"].num(-1)));
        if (it != paths_.end()) p = it->second;
      } else if (init.is_string()) {
        unsupported_.insert("Path2D from an SVG path string");
      }
      paths_[static_cast<int>(op[2].num(-1))] = std::move(p);
      return;
    }
    if (kind == "p2d") {
      const auto it = paths_.find(static_cast<int>(op[2].num(-1)));
      if (it == paths_.end()) return;
      Path2D& p = it->second;
      const std::string_view m = op[3].str_or("");
      const auto a = [&op](std::size_t i) { return op[4 + i].num(std::nan("")); };
      if (m == "moveTo") p.moveTo(a(0), a(1));
      else if (m == "lineTo") p.lineTo(a(0), a(1));
      else if (m == "quadraticCurveTo") p.quadraticCurveTo(a(0), a(1), a(2), a(3));
      else if (m == "bezierCurveTo") p.bezierCurveTo(a(0), a(1), a(2), a(3), a(4), a(5));
      else if (m == "arc") p.arc(a(0), a(1), a(2), a(3), a(4), op[9].truthy());
      else if (m == "arcTo") p.arcTo(a(0), a(1), a(2), a(3), a(4));
      else if (m == "ellipse") p.ellipse(a(0), a(1), a(2), a(3), a(4), a(5), a(6), op[11].truthy());
      else if (m == "rect") p.rect(a(0), a(1), a(2), a(3));
      else if (m == "closePath") p.closePath();
      else unsupported_.insert("Path2D." + std::string(m));
      return;
    }
    if (kind == "patxf") {
      const auto it = patterns_.find(static_cast<int>(op[2].num(-1)));
      if (it != patterns_.end()) it->second->transform = Mat2D{n(op, 3), n(op, 4), n(op, 5), n(op, 6), n(op, 7), n(op, 8)};
      return;
    }
    Canvas2D* c = canvas(cid);
    if (c == nullptr) {
      unsupported_.insert("op on an unknown canvas");
      return;
    }
    if (kind == "grad") {
      auto g = std::make_shared<Gradient>();
      const std::string_view type = op[3].str_or("linear");
      g->kind = type == "radial" ? Gradient::Kind::radial : type == "conic" ? Gradient::Kind::conic : Gradient::Kind::linear;
      for (std::size_t i = 0; i < 6; ++i) g->p[i] = op[4 + i].num(0);  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
      gradients_[static_cast<int>(op[2].num(-1))] = std::move(g);
      return;
    }
    if (kind == "pattern") {
      const Value& src = op[3];
      Canvas2D* sc = src.has("$c") ? canvas(static_cast<int>(src["$c"].num(-1))) : nullptr;
      if (sc == nullptr) {
        unsupported_.insert("pattern from an unrecorded source");
        return;
      }
      patterns_[static_cast<int>(op[2].num(-1))] = sc->createPattern(op[4].str_or("repeat"));
      return;
    }
    if (kind == "measure") {
      const TextMetrics m = c->measureText(op[2].str_or(""));
      MeasureDiff d;
      d.text = op[2].str();
      d.font = op[3].str();
      d.tsWidth = op[5].num(0);
      d.cxxWidth = m.width;
      const std::array<double, 5> deltas{std::fabs(m.width - op[5].num(0)), std::fabs(m.actualBoundingBoxLeft - op[6].num(0)),
                                         std::fabs(m.actualBoundingBoxRight - op[7].num(0)),
                                         std::fabs(m.actualBoundingBoxAscent - op[8].num(0)),
                                         std::fabs(m.actualBoundingBoxDescent - op[9].num(0))};
      d.maxDelta = *std::ranges::max_element(deltas);
      res.measures.push_back(std::move(d));
      return;
    }
    if (kind == "set") set(*c, op[2].str_or(""), op[3]);
    else if (kind == "call") call(*c, op);
    else unsupported_.insert(std::string(kind));
  }

  void set(Canvas2D& c, std::string_view prop, const Value& v) {
    if (prop == "fillStyle" || prop == "strokeStyle") {
      const auto s = style_of(v);
      if (!s) return;  // the canvas ignores what it cannot parse
      if (prop == "fillStyle") c.setFillStyle(*s);
      else c.setStrokeStyle(*s);
    } else if (prop == "lineWidth") {
      c.setLineWidth(v.num(std::nan("")));
    } else if (prop == "lineCap") {
      if (const auto x = cap_of(v.str_or(""))) c.setLineCap(*x);
    } else if (prop == "lineJoin") {
      if (const auto x = join_of(v.str_or(""))) c.setLineJoin(*x);
    } else if (prop == "miterLimit") {
      c.setMiterLimit(v.num(std::nan("")));
    } else if (prop == "lineDashOffset") {
      c.setLineDashOffset(v.num(std::nan("")));
    } else if (prop == "globalAlpha") {
      c.setGlobalAlpha(v.num(std::nan("")));
    } else if (prop == "globalCompositeOperation") {
      (void)c.setGlobalCompositeOperation(v.str_or(""));
    } else if (prop == "filter") {
      if (const auto fl = css::parse_filter(v.str_or(""))) c.setFilter(*fl);
      else unsupported_.insert("filter " + v.str());
    } else if (prop == "font") {
      (void)c.setFont(v.str_or(""));
    } else if (prop == "textAlign") {
      if (const auto x = align_of(v.str_or(""))) c.setTextAlign(*x);
    } else if (prop == "textBaseline") {
      if (const auto x = baseline_of(v.str_or(""))) c.setTextBaseline(*x);
    } else if (prop == "direction") {
      const std::string_view d = v.str_or("");
      c.setDirection(d == "rtl" ? Direction::rtl : d == "ltr" ? Direction::ltr : Direction::inherit);
    } else if (prop == "letterSpacing" || prop == "wordSpacing") {
      const auto px = css::parse_length_px(v.str_or(""), 10.0);
      if (!px) return;
      if (prop == "letterSpacing") c.setLetterSpacing(*px);
      else c.setWordSpacing(*px);
    } else if (prop == "fontKerning") {
      c.setFontKerning(v.str_or("auto") != "none");
    } else if (prop == "fontVariantCaps") {
      c.setSmallCaps(v.str_or("normal") == "small-caps");
    } else if (prop == "imageSmoothingEnabled") {
      c.setImageSmoothing(v.truthy());
    } else if (prop == "shadowColor") {
      if (const auto col = css::parse_color(v.str_or(""))) c.setShadowColor(*col);
    } else if (prop == "shadowBlur") {
      c.setShadowBlur(v.num(std::nan("")));
    } else if (prop == "shadowOffsetX") {
      c.setShadowOffsetX(v.num(std::nan("")));
    } else if (prop == "shadowOffsetY") {
      c.setShadowOffsetY(v.num(std::nan("")));
    } else if (prop == "fontVariationSettings" || prop == "getImageData" || prop == "putImageData") {
      // Not canvas properties in Chromium: the TS assignment only adds an
      // expando (fontVariationSettings) or patches a method; nothing to draw.
    } else {
      unsupported_.insert("set " + std::string(prop));
    }
  }

  static std::vector<double> numbers(const Value& v) {
    std::vector<double> out;
    for (const auto& x : v.items()) out.push_back(x.num(std::nan("")));
    return out;
  }

  void call(Canvas2D& c, const Value& op) {
    const std::string_view name = op[2].str_or("");
    const std::size_t argc = op.size() - 3;
    const auto a = [&op](std::size_t i) { return op[3 + i].num(std::nan("")); };
    if (name == "save") c.save();
    else if (name == "restore") c.restore();
    else if (name == "scale") c.scale(a(0), a(1));
    else if (name == "rotate") c.rotate(a(0));
    else if (name == "translate") c.translate(a(0), a(1));
    else if (name == "transform") c.transform({a(0), a(1), a(2), a(3), a(4), a(5)});
    else if (name == "setTransform") {
      if (argc == 1 && op[3].has("$m")) {
        const Value& m = op[3]["$m"];
        c.setTransform({m[0].num(), m[1].num(), m[2].num(), m[3].num(), m[4].num(), m[5].num()});
      } else if (argc == 0) {
        c.setTransform({});
      } else {
        c.setTransform({a(0), a(1), a(2), a(3), a(4), a(5)});
      }
    } else if (name == "resetTransform") c.setTransform({});
    else if (name == "beginPath") c.beginPath();
    else if (name == "moveTo") c.moveTo(a(0), a(1));
    else if (name == "lineTo") c.lineTo(a(0), a(1));
    else if (name == "quadraticCurveTo") c.quadraticCurveTo(a(0), a(1), a(2), a(3));
    else if (name == "bezierCurveTo") c.bezierCurveTo(a(0), a(1), a(2), a(3), a(4), a(5));
    else if (name == "arc") c.arc(a(0), a(1), a(2), a(3), a(4), op[8].truthy());
    else if (name == "arcTo") c.arcTo(a(0), a(1), a(2), a(3), a(4));
    else if (name == "ellipse") c.ellipse(a(0), a(1), a(2), a(3), a(4), a(5), a(6), op[10].truthy());
    else if (name == "rect") c.rect(a(0), a(1), a(2), a(3));
    else if (name == "roundRect") c.roundRect(a(0), a(1), a(2), a(3), op[7].is_array() ? numbers(op[7]) : std::vector<double>{op[7].num(0)});
    else if (name == "closePath") c.closePath();
    else if (name == "fill" || name == "clip" || name == "stroke") {
      const Path2D* path = nullptr;
      std::size_t ruleAt = 3;
      if (op[3].has("$path")) {
        const auto it = paths_.find(static_cast<int>(op[3]["$path"].num(-1)));
        if (it == paths_.end()) {
          unsupported_.insert("fill/stroke of an unrecorded Path2D");
          return;
        }
        path = &it->second;
        ruleAt = 4;
      }
      const FillRule rule = op[ruleAt].str_or("nonzero") == "evenodd" ? FillRule::evenodd : FillRule::nonzero;
      if (path != nullptr) {
        if (name == "fill") c.fill(*path, rule);
        else if (name == "clip") c.clip(*path, rule);
        else c.stroke(*path);
      } else {
        if (name == "fill") c.fill(rule);
        else if (name == "clip") c.clip(rule);
        else c.stroke();
      }
    }
    else if (name == "fillRect") c.fillRect(a(0), a(1), a(2), a(3));
    else if (name == "strokeRect") c.strokeRect(a(0), a(1), a(2), a(3));
    else if (name == "clearRect") c.clearRect(a(0), a(1), a(2), a(3));
    else if (name == "fillText") {
      if (argc > 3) unsupported_.insert("fillText maxWidth");
      c.fillText(op[3].str_or(""), a(1), a(2));
    } else if (name == "strokeText") {
      c.strokeText(op[3].str_or(""), a(1), a(2));
    } else if (name == "setLineDash") {
      c.setLineDash(numbers(op[3]));
    } else if (name == "drawImage") {
      const Value& src = op[3];
      Canvas2D* sc = src.has("$c") ? canvas(static_cast<int>(src["$c"].num(-1))) : nullptr;
      if (sc == nullptr) {
        unsupported_.insert("drawImage from an unrecorded source");
        return;
      }
      const double sw = sc->width();
      const double sh = sc->height();
      if (argc == 3) c.drawImage(*sc, 0, 0, sw, sh, a(1), a(2), sw, sh);
      else if (argc == 5) c.drawImage(*sc, 0, 0, sw, sh, a(1), a(2), a(3), a(4));
      else if (argc == 9) c.drawImage(*sc, a(1), a(2), a(3), a(4), a(5), a(6), a(7), a(8));
    } else {
      unsupported_.insert("call " + std::string(name));
    }
  }
};

}  // namespace

ReplayResult replay_canvas_ops(std::string_view opsJson, const CanvasOptions& opts) {
  Replayer r(opts);
  return r.run(opsJson);
}

}  // namespace premation::raster
