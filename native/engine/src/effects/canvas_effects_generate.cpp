// Canvas-drawn effects, round three (E4): the generators that draw text, audio,
// bolts, networks and contour lights — ported call for call from
// generateText.ts (Lens Flare, Numbers, Timecode, Audio Spectrum),
// generateAdvanced.ts (Lightning, Audio Waveform), audioVizLayout.ts,
// plexus.ts and vegas.ts, with the canvas2dEffects.ts wrappers that resolve
// their params. Same V8 Math, same colour strings, same PRNG arithmetic
// (doubles through ToUint32), so the Canvas2D program is the TS's
// (tests/test_effect_chain.cpp against effectChainCrossEngine.test.ts).
//
// Text is drawn with the canvas's fillText / measureText, so its glyphs are the
// FontSet's; Plexus blends in a float16 canvas (Canvas2D::create_float16_canvas)
// where the canvas has one, and takes the TS's direct path where it has none.

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <bit>
#include <map>
#include <unordered_map>
#include <string>
#include <utility>
#include <vector>

#include "canvas_effects.hpp"
#include "canvas_effects_common.hpp"
#include "kernels.hpp"
#include "noise_hash.hpp"

namespace premation::effects {
namespace {

using namespace canvas_detail;  // NOLINT(google-build-using-namespace): the shared canvas-effect helpers
namespace mjs = motion::js;

double hyp(double a, double b) {
  const std::array<double, 2> v{a, b};
  return mjs::hypot(v);
}
/// `drawImage(src, dx, dy)`.
void draw_whole_at(Canvas2D& dst, const Canvas2D& src, double dx, double dy) {
  const double sw = src.width();
  const double sh = src.height();
  dst.drawImage(src, 0, 0, sw, sh, dx, dy, sw, sh);
}
std::string trimmed(const std::string& s) {
  std::size_t b = 0;
  std::size_t e = s.size();
  while (b < e && std::isspace(static_cast<unsigned char>(s[b])) != 0) ++b;
  while (e > b && std::isspace(static_cast<unsigned char>(s[e - 1])) != 0) --e;
  return s.substr(b, e - b);
}
bool all_hexd(std::string_view s) {
  return std::ranges::all_of(s, [](char c) { return std::isxdigit(static_cast<unsigned char>(c)) != 0; });
}
std::array<double, 3> bytes_of(long v) {
  return {static_cast<double>((v >> 16) & 255), static_cast<double>((v >> 8) & 255), static_cast<double>(v & 255)};
}
/// `/^#?([0-9a-f]{6})$/i` on the trimmed string → bytes, else nullopt.
std::optional<std::array<double, 3>> hex6(const std::string& hex) {
  std::string s = trimmed(hex);
  if (!s.empty() && s[0] == '#') s.erase(0, 1);
  if (s.size() != 6 || !all_hexd(s)) return std::nullopt;
  return bytes_of(std::strtol(s.c_str(), nullptr, 16));
}
/// `parseInt(s, 16)` on the longest hex prefix; nullopt = NaN.
std::optional<double> parse_int16(std::string_view s) {
  std::size_t i = 0;
  while (i < s.size() && std::isspace(static_cast<unsigned char>(s[i])) != 0) ++i;
  double v = 0;
  bool any = false;
  for (; i < s.size() && std::isxdigit(static_cast<unsigned char>(s[i])) != 0; ++i) {
    const int ch = s[i];
    v = v * 16 + (ch <= '9' ? ch - '0' : (ch | 0x20) - 'a' + 10);
    any = true;
  }
  if (!any) return std::nullopt;
  return v;
}
/// `String(effectParam(e, k) ?? fallback)` — effectParam's own `?? 0` makes an absent param "0".
std::string param_str(const Value& p, std::string_view k) {
  const Value& v = p[k];
  if (v.is_string()) return v.str();
  if (v.is_number()) return jsn(v.num());
  if (v.is_bool()) return v.truthy() ? "true" : "false";
  if (v.is_null()) return "0";
  return v.is_object() ? "[object Object]" : "";
}
/// A resolved numeric array param: numbers, anything else NaN (as JS arithmetic reads it).
std::vector<double> numbers(const Value& v) {
  std::vector<double> out;
  for (const auto& x : v.items()) out.push_back(x.is_number() ? x.num() : std::nan(""));
  return out;
}
void set_fill(Canvas2D& c, const Grad& g) { c.setFillStyle(g.style()); }

// ── generateText.ts: Lens Flare ─────────────────────────────────────────────

/// generateText.ts withAlpha: `#rrggbb` (optional #) + alpha, else white.
std::string wa(const std::string& hex, double a) {
  const auto c = hex6(hex);
  if (!c) return "rgba(255,255,255," + jsn(a) + ")";
  return "rgba(" + jsn((*c)[0]) + "," + jsn((*c)[1]) + "," + jsn((*c)[2]) + "," + jsn(a) + ")";
}

void apply_lens_flare(CanvasEffectContext& /*x*/, Canvas2D& oc, double w, double h, const Value& p) {
  const double center_x = w / 2 + num(p, "centerX");
  const double center_y = h / 2 + num(p, "centerY");
  const double brightness = num(p, "brightness") / 100;
  const double scale = num(p, "scale");
  const std::string hue = str(p, "color", "#ffd9a0");
  if (brightness <= 0) return;
  const double b = std::max(0.0, std::min(1.0, brightness));
  oc.save();
  oc.setTransform({});
  (void)oc.setGlobalCompositeOperation("lighter");
  const double mid_x = w / 2;
  const double mid_y = h / 2;
  const double axis_x = mid_x - center_x;
  const double axis_y = mid_y - center_y;
  const double span = std::max(w, h);
  const double core_r = span * 0.06 * scale;
  const double halo_r = span * 0.35 * scale;
  const Grad halo = radial(center_x, center_y, 0, center_x, center_y, std::max(1.0, halo_r));
  halo.stop(0, wa(hue, 0.55 * b));
  halo.stop(0.25, wa(hue, 0.18 * b));
  halo.stop(1, wa(hue, 0));
  set_fill(oc, halo);
  oc.fillRect(0, 0, w, h);
  const Grad core = radial(center_x, center_y, 0, center_x, center_y, std::max(1.0, core_r));
  core.stop(0, "rgba(255,255,255," + jsn(0.95 * b) + ")");
  core.stop(0.5, wa(hue, 0.5 * b));
  core.stop(1, wa(hue, 0));
  set_fill(oc, core);
  oc.fillRect(0, 0, w, h);
  const Grad streak = linear(center_x - halo_r, center_y, center_x + halo_r, center_y);
  streak.stop(0, wa(hue, 0));
  streak.stop(0.5, wa(hue, 0.35 * b));
  streak.stop(1, wa(hue, 0));
  set_fill(oc, streak);
  oc.fillRect(center_x - halo_r, center_y - std::max(1.0, core_r * 0.12), halo_r * 2, std::max(2.0, core_r * 0.24));
  static constexpr std::array<double, 7> kPos{-0.35, 0.25, 0.55, 0.8, 1.15, 1.45, 1.9};
  static constexpr std::array<double, 7> kSize{0.09, 0.05, 0.13, 0.07, 0.045, 0.1, 0.06};
  for (std::size_t i = 0; i < kPos.size(); ++i) {
    const double t = kPos[i];
    const double gx = center_x + axis_x * 2 * t;
    const double gy = center_y + axis_y * 2 * t;
    const double gr = std::max(1.0, span * kSize[i] * scale);
    const double alpha = 0.14 * b * (1 - std::min(1.0, std::abs(t) / 2.2));
    if (alpha <= 0) continue;
    const Grad g = radial(gx, gy, 0, gx, gy, gr);
    g.stop(0, wa(hue, alpha));
    g.stop(0.7, wa(hue, alpha * 0.5));
    g.stop(1, wa(hue, 0));
    set_fill(oc, g);
    oc.beginPath();
    oc.arc(gx, gy, gr, 0, kPi * 2, false);
    oc.fill(raster::FillRule::nonzero);
  }
  oc.restore();
}

// ── generateText.ts: Numbers, Timecode ──────────────────────────────────────

std::string pad_start(std::string s, double target, char fill) {
  if (!(target > static_cast<double>(s.size()))) return s;
  return std::string(static_cast<std::size_t>(target) - s.size(), fill) + s;
}

/// generateText.ts formatNumber.
std::string format_number(double value, double decimals, bool use_commas, double pad_to) {
  const double d = std::max(0.0, std::min(10.0, mjs::round(decimals)));
  const bool negative = value < 0;
  const std::string fixed = mjs::to_fixed(std::abs(value), static_cast<int>(d));
  const std::size_t dot = fixed.find('.');
  std::string whole = dot == std::string::npos ? fixed : fixed.substr(0, dot);
  const std::string frac = dot == std::string::npos ? "" : fixed.substr(dot + 1);
  if (pad_to > 0 && static_cast<double>(whole.size()) < pad_to) whole = pad_start(whole, mjs::round(pad_to), '0');
  if (use_commas && std::ranges::all_of(whole, [](char c) { return c >= '0' && c <= '9'; })) {
    // /\B(?=(\d{3})+(?!\d))/g on a run of digits: a comma before every group of three from the right.
    std::string out;
    for (std::size_t i = 0; i < whole.size(); ++i) {
      if (i > 0 && (whole.size() - i) % 3 == 0) out += ',';
      out += whole[i];
    }
    whole = out;
  }
  return (negative ? "-" : "") + whole + (dot != std::string::npos ? "." + frac : "");
}

/// generateText.ts formatTimecode.
std::string format_timecode(double time_sec, double fps, bool drop_frame) {
  const double rate = std::max(1.0, fps);
  const bool negative = time_sec < 0;
  const double t = std::abs(time_sec);
  const double total_frames = std::floor(t * rate + 1e-6);
  const double frames = std::fmod(total_frames, mjs::round(rate));
  const double total_seconds = std::floor(total_frames / mjs::round(rate));
  const double hh = std::floor(total_seconds / 3600);
  const double mm = std::floor(std::fmod(total_seconds, 3600) / 60);
  const double ss = std::fmod(total_seconds, 60);
  const auto p2 = [](double v) { return pad_start(jsn(v), 2, '0'); };
  return (negative ? "-" : "") + p2(hh) + ":" + p2(mm) + ":" + p2(ss) + (drop_frame ? ";" : ":") + p2(frames);
}

/// generateText.ts drawTextReadout (align 'center').
void draw_text_readout(Canvas2D& ctx, const std::string& text, double px, double py, double size, const std::string& color, bool show_box,
                       const std::string& box_color) {
  ctx.save();
  ctx.setTransform({});
  (void)ctx.setFont(jsn(std::max(1.0, size)) + "px \"SF Mono\", \"Consolas\", \"Menlo\", monospace");
  ctx.setTextAlign(raster::TextAlign::center);
  ctx.setTextBaseline(raster::TextBaseline::middle);
  if (show_box) {
    const raster::TextMetrics m = ctx.measureText(text);
    const double pad_x = size * 0.4;
    const double pad_y = size * 0.3;
    const double box_w = m.width + pad_x * 2;
    const double box_h = size + pad_y * 2;
    fill_css(ctx, box_color);
    ctx.fillRect(px - box_w / 2, py - box_h / 2, box_w, box_h);
  }
  fill_css(ctx, color);
  ctx.fillText(text, px, py);
  ctx.restore();
}

void apply_numbers(CanvasEffectContext& /*x*/, Canvas2D& oc, double w, double h, const Value& p) {
  const std::string text = format_number(num(p, "value"), num(p, "decimals"), flag(p, "useCommas", false), num(p, "padTo"));
  draw_text_readout(oc, text, w / 2 + num(p, "positionX"), h / 2 + num(p, "positionY"), num(p, "size"), str(p, "color", "#ffffff"),
                    flag(p, "showBox", false), str(p, "boxColor", "#000000"));
}

void apply_timecode(CanvasEffectContext& /*x*/, Canvas2D& oc, double w, double h, const Value& p) {
  const std::string text = format_timecode(num(p, "time"), num(p, "fps"), flag(p, "dropFrame", false));
  draw_text_readout(oc, text, w / 2 + num(p, "positionX"), h / 2 + num(p, "positionY"), num(p, "size"), str(p, "color", "#ffffff"),
                    flag(p, "showBox", true), str(p, "boxColor", "#000000"));
}

// ── audioVizLayout.ts ────────────────────────────────────────────────────────

struct VizSample {
  double x, y, nx, ny;
};
struct VizLayout {
  std::vector<double> path_points;
  bool use_polar_path = false;
  double polar_radius = 0, start_angle = 0, start_x = 0, start_y = 0, end_x = 0, end_y = 0;
  double side = 2, softness = 0, hue_interpolation = 0;
};

/// canvas2dEffects.ts audioVizLayoutOf.
VizLayout viz_layout_of(const Value& p) {
  VizLayout l;
  if (p["pathPoints"].is_array()) l.path_points = numbers(p["pathPoints"]);
  l.use_polar_path = flag(p, "usePolarPath", false);
  l.polar_radius = num(p, "polarRadius");
  l.start_angle = num(p, "startAngle");
  l.start_x = num(p, "startX");
  l.start_y = num(p, "startY");
  l.end_x = num(p, "endX");
  l.end_y = num(p, "endY");
  l.side = mjs::round(num(p, "side"));
  l.softness = num(p, "softness");
  l.hue_interpolation = num(p, "hueInterpolation");
  return l;
}

std::vector<VizSample> along_path(const std::vector<double>& pts, double n, bool polar) {
  const std::size_t count = pts.size() / 2;
  if (count < 2) return {};
  std::vector<double> cum{0};
  for (std::size_t i = 1; i < count; ++i) cum.push_back(cum[i - 1] + hyp(pts[i * 2] - pts[(i - 1) * 2], pts[i * 2 + 1] - pts[(i - 1) * 2 + 1]));
  const double total = cum[count - 1];
  if (!(total > 0)) return {};
  const bool closed = std::abs(pts[0] - pts[(count - 1) * 2]) < 1e-6 && std::abs(pts[1] - pts[(count - 1) * 2 + 1]) < 1e-6;
  const std::size_t vertices = closed && count > 1 ? count - 1 : count;
  double mx = 0;
  double my = 0;
  for (std::size_t i = 0; i < vertices; ++i) {
    mx += pts[i * 2];
    my += pts[i * 2 + 1];
  }
  mx /= static_cast<double>(vertices);
  my /= static_cast<double>(vertices);
  std::vector<VizSample> out;
  std::size_t seg = 1;
  for (double i = 0; i < n; ++i) {
    const double target = (i / n) * total;
    while (seg < count - 1 && cum[seg] < target) ++seg;
    const std::size_t a = seg - 1;
    const double span_len = cum[seg] - cum[a];
    const double t = span_len > 0 ? (target - cum[a]) / span_len : 0;
    const double ax = pts[a * 2];
    const double ay = pts[a * 2 + 1];
    const double bx = pts[seg * 2];
    const double by = pts[seg * 2 + 1];
    const double x = ax + (bx - ax) * t;
    const double y = ay + (by - ay) * t;
    double nx = 0;
    double ny = -1;
    if (polar) {
      const double rx = x - mx;
      const double ry = y - my;
      const double rl = hyp(rx, ry);
      if (rl > 0) {
        nx = rx / rl;
        ny = ry / rl;
      }
    } else {
      const double tx = bx - ax;
      const double ty = by - ay;
      const double tl = hyp(tx, ty);
      if (tl > 0) {
        nx = ty / tl;
        ny = -tx / tl;
      }
    }
    out.push_back({x, y, nx, ny});
  }
  return out;
}

/// audioVizLayout.ts layoutViz.
std::vector<VizSample> layout_viz(double w, double h, double count, const VizLayout& o) {
  const double n = std::max(0.0, std::floor(count));
  if (n == 0) return {};
  const double cx = w / 2;
  const double cy = h / 2;
  if (o.path_points.size() >= 4) return along_path(o.path_points, n, o.use_polar_path);
  std::vector<VizSample> out;
  if (o.use_polar_path) {
    const double r = std::max(0.0, o.polar_radius);
    const double a0 = (o.start_angle * kPi) / 180;
    for (double i = 0; i < n; ++i) {
      const double a = a0 + (i / n) * kPi * 2;
      const double nx = mjs::cos(a);
      const double ny = mjs::sin(a);
      out.push_back({cx + nx * r, cy + ny * r, nx, ny});
    }
    return out;
  }
  const double x0 = cx + o.start_x;
  const double y0 = cy + o.start_y;
  const double x1 = cx + o.end_x;
  const double y1 = cy + o.end_y;
  const double dx = x1 - x0;
  const double dy = y1 - y0;
  const double len = hyp(dx, dy);
  const double ux = len > 0 ? dx / len : 1;
  const double uy = len > 0 ? dy / len : 0;
  for (double i = 0; i < n; ++i) {
    const double t = n == 1 ? 0 : i / (n - 1);
    out.push_back({x0 + dx * t, y0 + dy * t, uy, -ux});
  }
  return out;
}

/// audioVizLayout.ts parseHex: `#rrggbb`, else white.
std::array<double, 3> viz_hex(const std::string& hex) { return hex6(hex).value_or(std::array<double, 3>{255, 255, 255}); }

/// audioVizLayout.ts bandColor → "rgb(r, g, b)".
std::string band_color(double i, double n, const std::string& inside, const std::string& outside, double hue_shift) {
  const double t = n <= 1 ? 0 : i / (n - 1);
  const auto a = viz_hex(inside);
  const auto b = viz_hex(outside);
  double r = a[0] + (b[0] - a[0]) * t;
  double g = a[1] + (b[1] - a[1]) * t;
  double bl = a[2] + (b[2] - a[2]) * t;
  if (hue_shift != 0) {
    const double ang = (std::fmod(hue_shift * t, 360) * kPi) / 180;
    const double c = mjs::cos(ang);
    const double s = mjs::sin(ang);
    const std::array<double, 9> m{0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
                                  0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
                                  0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072};
    const auto clamp = [](double v) { return std::max(0.0, std::min(255.0, v)); };
    const double r2 = clamp(r * m[0] + g * m[1] + bl * m[2]);
    const double g2 = clamp(r * m[3] + g * m[4] + bl * m[5]);
    const double b2 = clamp(r * m[6] + g * m[7] + bl * m[8]);
    r = r2;
    g = g2;
    bl = b2;
  }
  return "rgb(" + jsn(mjs::round(r)) + ", " + jsn(mjs::round(g)) + ", " + jsn(mjs::round(bl)) + ")";
}

void set_shadow_color(Canvas2D& c, const std::string& css) {
  if (const auto col = raster::css::parse_color(css)) c.setShadowColor(*col);
}

// ── generateText.ts: Audio Spectrum ─────────────────────────────────────────

void apply_audio_spectrum(CanvasEffectContext& /*x*/, Canvas2D& ctx, double w, double h, const Value& p) {
  const Value& raw = p["magnitudes"];
  const std::vector<double> mags = raw.is_array() ? numbers(raw) : std::vector<double>{};
  if (mags.empty()) return;
  const double mode_n = num(p, "displayMode");
  const int mode = mode_n == 1 ? 1 : mode_n == 2 ? 2 : 0;  // line · mirrored · bars
  const double max_height = num(p, "maxHeight");
  const double thickness = num(p, "thickness");
  const std::string inside = str(p, "insideColor", "#00e5ff");
  const std::string outside = str(p, "outsideColor", "#0066ff");
  const VizLayout lay = viz_layout_of(p);
  const auto n = static_cast<double>(mags.size());
  ctx.save();
  ctx.setTransform({});
  const std::vector<VizSample> samples = layout_viz(w, h, n, lay);
  if (samples.empty()) {
    ctx.restore();
    return;
  }
  const double side = mode == 2 ? 2 : lay.side;
  const double softness = std::max(0.0, std::min(100.0, lay.softness));
  const double hue = lay.hue_interpolation;
  if (softness > 0) ctx.setShadowBlur((softness / 100) * std::max(2.0, thickness * 2));
  const double spacing = samples.size() > 1 ? hyp(samples[1].x - samples[0].x, samples[1].y - samples[0].y) : thickness;
  const double bar_w = std::max(1.0, std::min(std::max(1.0, spacing * 0.9), thickness));
  if (mode == 1) {
    stroke_css(ctx, inside);
    ctx.setLineWidth(std::max(1.0, thickness * 0.25));
    ctx.setLineJoin(raster::LineJoin::round);
    ctx.beginPath();
    for (std::size_t i = 0; i < mags.size(); ++i) {
      const VizSample& sp = samples[i];
      const double m = mags[i] * max_height;
      const double x = sp.x + sp.nx * m;
      const double y = sp.y + sp.ny * m;
      if (i == 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    if (lay.use_polar_path) ctx.closePath();
    ctx.stroke();
    ctx.restore();
    return;
  }
  for (std::size_t i = 0; i < mags.size(); ++i) {
    const VizSample& sp = samples[i];
    const double bar_h = std::max(0.0, mags[i] * max_height);
    if (bar_h <= 0) continue;
    const std::string near_c = band_color(static_cast<double>(i), n, inside, inside, hue);
    const std::string far_c = band_color(static_cast<double>(i), n, outside, outside, hue);
    ctx.save();
    ctx.translate(sp.x, sp.y);
    ctx.rotate(mjs::atan2(sp.ny, sp.nx) - kPi / 2);
    const Grad g = linear(0, 0, 0, -bar_h);
    g.stop(0, near_c);
    g.stop(1, far_c);
    set_fill(ctx, g);
    if (softness > 0) set_shadow_color(ctx, near_c);
    if (side == 0 || side == 2) ctx.fillRect(-bar_w / 2, -bar_h, bar_w, bar_h);
    if (side == 1 || side == 2) ctx.fillRect(-bar_w / 2, 0, bar_w, bar_h);
    ctx.restore();
  }
  ctx.restore();
}

// ── generateAdvanced.ts: Audio Waveform, Lightning ──────────────────────────

void apply_audio_waveform(CanvasEffectContext& /*x*/, Canvas2D& oc, double w, double h, const Value& p) {
  const Value& raw = p["samples"];
  const std::vector<double> samples = raw.is_array() ? numbers(raw) : std::vector<double>{};
  const double display_mode = num(p, "displayMode");
  const double max_height = num(p, "maxHeight");
  const double thickness = num(p, "thickness");
  const std::string inside = str(p, "insideColor", "#7dd3fc");
  const std::string outside = str(p, "outsideColor", "#1d4ed8");
  const double opacity = num(p, "opacity");
  const double composite = num(p, "composite");
  const VizLayout lay = viz_layout_of(p);
  const double a = clamp01_cs(opacity / 100);
  if (a <= 0) return;
  const auto n = static_cast<double>(samples.size());
  if (samples.size() < 2) return;
  const double amp = max_height / 2;
  const double mode = mjs::round(display_mode);
  const double side = lay.side;
  const double softness = std::max(0.0, std::min(100.0, lay.softness));
  const double hue = lay.hue_interpolation;
  const std::vector<VizSample> places = layout_viz(w, h, n, lay);
  if (places.empty()) return;
  const auto signed_v = [&](double v) { return side == 0 ? std::max(0.0, v) : side == 1 ? std::min(0.0, v) : v; };
  with_composite(oc, composite, [&] {
    oc.save();
    if (softness > 0) oc.setShadowBlur((softness / 100) * std::max(2.0, thickness * 2));
    if (mode == 1) {
      const double spacing = places.size() > 1 ? hyp(places[1].x - places[0].x, places[1].y - places[0].y) : thickness;
      oc.setLineWidth(std::max(1.0, std::min(std::max(1.0, spacing * 0.8), std::max(1.0, thickness))));
      oc.setLineCap(raster::LineCap::butt);
      for (std::size_t i = 0; i < samples.size(); ++i) {
        const VizSample& sp = places[i];
        const double m = signed_v(samples[i]) * amp;
        if (m == 0) continue;
        // rgba() of an "rgb(…)" band colour is not a hex, so it reads mid grey — as the TS draws it.
        const std::string color = rgba(band_color(static_cast<double>(i), n, inside, outside, hue), a);
        stroke_css(oc, color);
        if (softness > 0) set_shadow_color(oc, color);
        oc.beginPath();
        oc.moveTo(sp.x, sp.y);
        oc.lineTo(sp.x + sp.nx * m, sp.y + sp.ny * m);
        oc.stroke();
      }
    } else if (mode == 2) {
      fill_css(oc, rgba(band_color(0, 1, inside, outside, hue), a));
      if (softness > 0) set_shadow_color(oc, rgba(inside, a));
      oc.beginPath();
      for (std::size_t i = 0; i < samples.size(); ++i) {
        const VizSample& sp = places[i];
        const double m = signed_v(samples[i]) * amp;
        const double x = sp.x + sp.nx * m;
        const double y = sp.y + sp.ny * m;
        if (i == 0) oc.moveTo(x, y);
        else oc.lineTo(x, y);
      }
      for (std::size_t k = samples.size(); k-- > 0;) {
        const VizSample& sp = places[k];
        const double m = -signed_v(samples[k]) * amp;
        oc.lineTo(sp.x + sp.nx * m, sp.y + sp.ny * m);
      }
      oc.closePath();
      oc.fill(raster::FillRule::nonzero);
    } else {
      stroke_css(oc, rgba(band_color(0, 1, inside, outside, hue), a));
      if (softness > 0) set_shadow_color(oc, rgba(inside, a));
      oc.setLineWidth(std::max(0.5, thickness));
      oc.setLineJoin(raster::LineJoin::round);
      oc.beginPath();
      for (std::size_t i = 0; i < samples.size(); ++i) {
        const VizSample& sp = places[i];
        const double m = signed_v(samples[i]) * amp;
        const double x = sp.x + sp.nx * m;
        const double y = sp.y + sp.ny * m;
        if (i == 0) oc.moveTo(x, y);
        else oc.lineTo(x, y);
      }
      if (lay.use_polar_path) oc.closePath();
      oc.stroke();
    }
    oc.restore();
  });
}

using Pts = std::vector<std::array<double, 2>>;

void apply_lightning(CanvasEffectContext& /*x*/, Canvas2D& oc, double w, double h, const Value& p) {
  // canvas2dEffects.ts applyLightning: the resolved spine, centred → raster px, pen-ups dropped.
  std::vector<double> spine;
  bool has_spine = false;
  const Value& flat = p["pathPoints"];
  if (flat.is_array() && flat.size() >= 4) {
    for (std::size_t i = 0; i + 1 < flat.size(); i += 2) {
      const Value& vx = flat[i];
      const Value& vy = flat[i + 1];
      if (vx.is_number() && vy.is_number() && vx.num() < 1e9) {
        spine.push_back(w / 2 + vx.num());
        spine.push_back(h / 2 + vy.num());
      }
    }
    has_spine = spine.size() >= 4;
  }
  const double start_x = num(p, "startX");
  const double start_y = num(p, "startY");
  const double end_x = num(p, "endX");
  const double end_y = num(p, "endY");
  const double detail = num(p, "detail");
  const double amplitude = num(p, "amplitude");
  const double branches = num(p, "branches");
  const double thickness = num(p, "thickness");
  const std::string color = str(p, "color", "#cfe8ff");
  const double glow = num(p, "glow");
  const double opacity = num(p, "opacity");
  const double seed = num(p, "seed");
  const double composite = num(p, "composite");
  // generateAdvanced.ts drawLightning.
  const double a = clamp01_cs(opacity / 100);
  if (a <= 0) return;
  const double depth = std::max(1.0, std::min(9.0, mjs::round(detail)));
  double state = mjs::to_uint32(mjs::round(seed) * 1103515245 + 12345);
  const auto rand = [&state] {
    state = mjs::to_uint32(state * 1103515245 + 12345);
    return state / 4294967296.0;
  };
  const double x0 = w / 2 + start_x;
  const double y0 = h / 2 + start_y;
  const double x1 = w / 2 + end_x;
  const double y1 = h / 2 + end_y;
  const auto or1 = [](double v) { return v == 0 || std::isnan(v) ? 1.0 : v; };  // `x || 1`
  std::function<void(double, double, double, double, double, double, Pts&)> bolt = [&](double ax, double ay, double bx, double by, double amp,
                                                                                       double d, Pts& out) {
    if (d <= 0) {
      out.push_back({ax, ay});
      out.push_back({bx, by});
      return;
    }
    const double mx = (ax + bx) / 2;
    const double my = (ay + by) / 2;
    const double dx = bx - ax;
    const double dy = by - ay;
    const double len = or1(hyp(dx, dy));
    const double off = (rand() - 0.5) * amp;
    const double px = mx + (-dy / len) * off;
    const double py = my + (dx / len) * off;
    bolt(ax, ay, px, py, amp / 2, d - 1, out);
    bolt(px, py, bx, by, amp / 2, d - 1, out);
  };
  const auto stroke_path = [&](const Pts& pts, double width, double alpha) {
    if (pts.size() < 2) return;
    stroke_css(oc, rgba(color, alpha));
    oc.setLineWidth(std::max(0.5, width));
    oc.setLineJoin(raster::LineJoin::round);
    oc.setLineCap(raster::LineCap::round);
    oc.beginPath();
    oc.moveTo(pts[0][0], pts[0][1]);
    for (std::size_t i = 1; i < pts.size(); ++i) oc.lineTo(pts[i][0], pts[i][1]);
    oc.stroke();
  };
  std::vector<double> spine_len{0};
  if (has_spine) {
    for (std::size_t i = 2; i + 1 < spine.size(); i += 2) spine_len.push_back(spine_len.back() + hyp(spine[i] - spine[i - 2], spine[i + 1] - spine[i - 1]));
  }
  struct SpinePt {
    double x, y, nx, ny;
  };
  const auto spine_at = [&](double s) {
    const double total = spine_len.back();
    const double target = std::max(0.0, std::min(1.0, s)) * total;
    std::size_t i = 0;
    while (i + 2 < spine_len.size() && spine_len[i + 1] < target) ++i;
    const double l0 = spine_len[i];
    const double l1 = spine_len[i + 1];
    const double t = l1 > l0 ? (target - l0) / (l1 - l0) : 0;
    const double ax = spine[i * 2];
    const double ay = spine[i * 2 + 1];
    const double bx = spine[i * 2 + 2];
    const double by = spine[i * 2 + 3];
    const double dx = bx - ax;
    const double dy = by - ay;
    const double len = or1(hyp(dx, dy));
    return SpinePt{ax + dx * t, ay + dy * t, -dy / len, dx / len};
  };
  std::function<void(double, double, double, double, double, double, Pts&)> bolt_along = [&](double s0, double s1, double off0, double off1,
                                                                                             double amp, double d, Pts& out) {
    if (d <= 0) {
      const SpinePt p0 = spine_at(s0);
      const SpinePt p1 = spine_at(s1);
      out.push_back({p0.x + p0.nx * off0, p0.y + p0.ny * off0});
      out.push_back({p1.x + p1.nx * off1, p1.y + p1.ny * off1});
      return;
    }
    const double sm = (s0 + s1) / 2;
    const double offm = (off0 + off1) / 2 + (rand() - 0.5) * amp;
    bolt_along(s0, sm, off0, offm, amp / 2, d - 1, out);
    bolt_along(sm, s1, offm, off1, amp / 2, d - 1, out);
  };
  with_composite(oc, composite, [&] {
    oc.save();
    Pts main;
    if (has_spine && spine_len.back() > 0) bolt_along(0, 1, 0, 0, amplitude, depth, main);
    else bolt(x0, y0, x1, y1, amplitude, depth, main);
    if (glow > 0) stroke_path(main, thickness + glow, a * 0.35);
    stroke_path(main, thickness, a);
    const double nb = std::max(0.0, std::min(12.0, mjs::round(branches)));
    for (double i = 0; i < nb; ++i) {
      const auto idx = static_cast<std::size_t>(1 + std::floor(rand() * std::max(1.0, static_cast<double>(main.size()) - 2)));
      const auto pt = main[idx];
      const auto prev = main[idx - 1];
      const double dx = pt[0] - prev[0];
      const double dy = pt[1] - prev[1];
      const double ang = mjs::atan2(dy, dx) + (rand() - 0.5) * 1.2;
      const double blen = hyp(x1 - x0, y1 - y0) * (0.15 + rand() * 0.25);
      Pts sub;
      bolt(pt[0], pt[1], pt[0] + mjs::cos(ang) * blen, pt[1] + mjs::sin(ang) * blen, amplitude * 0.5, std::max(1.0, depth - 2), sub);
      if (glow > 0) stroke_path(sub, thickness * 0.6 + glow * 0.5, a * 0.2);
      stroke_path(sub, thickness * 0.6, a * 0.7);
    }
    oc.restore();
  });
}

// ── plexus.ts ────────────────────────────────────────────────────────────────

/// plexus.ts hexRgb.
std::array<double, 3> plexus_rgb(const std::string& hex) {
  std::string s = trimmed(hex);
  if (!s.empty() && s[0] == '#') s.erase(0, 1);
  if (s.size() == 3) s = std::string(2, s[0]) + std::string(2, s[1]) + std::string(2, s[2]);
  const auto v = parse_int16(std::string_view(s).substr(0, std::min<std::size_t>(6, s.size())));
  if (!v) return {255, 255, 255};
  return bytes_of(static_cast<long>(*v));
}

/// drawPlexusInto.
void draw_plexus_into(Canvas2D& oc, double w, double h, const Value& p) {
  constexpr double kMaxPoints = 700;  // PLEXUS_MAX_POINTS
  const double opacity = std::max(0.0, std::min(1.0, num(p, "opacity") / 100));
  if (opacity <= 0) return;
  struct P {
    double x, y;
  };
  std::vector<P> pts;
  const Value& flat = p["pathPoints"];
  if (flat.is_array() && flat.size() >= 4) {
    const double step = std::max(1.0, mjs::round(num(p, "pathStep")));
    double k = 0;
    for (std::size_t i = 0; i + 1 < flat.size(); i += 2, ++k) {
      const Value& vx = flat[i];
      const Value& vy = flat[i + 1];
      if (!vx.is_number() || !vy.is_number() || vx.num() >= 1e9) continue;
      if (std::fmod(k, step) == 0) pts.push_back({w / 2 + vx.num(), h / 2 + vy.num()});
    }
  } else {
    // plexusPointCloud.
    const double cnt = std::max(0.0, std::min(kMaxPoints, std::floor(num(p, "pointCount"))));
    const double spread = std::max(0.0, std::min(1.0, num(p, "spread") / 100));
    const double drift = std::max(0.0, num(p, "drift"));
    const double evolution = num(p, "evolution");
    const double seed = mjs::round(num(p, "seed"));
    const double sw = w * spread;
    const double sh = h * spread;
    const double bx0 = (w - sw) / 2;
    const double by0 = (h - sh) / 2;
    const double ev = evolution * 0.05;
    for (double i = 0; i < cnt; ++i) {
      const double bx = bx0 + hash01u(ju32(i), 1, ju32(seed)) * sw;
      const double by = by0 + hash01u(ju32(i), 2, ju32(seed)) * sh;
      const double dx = (vnoise_u(ev + i * 7.13, 0.5, seed + 11) * 2 - 1) * drift;
      const double dy = (vnoise_u(ev + i * 7.13, 9.5, seed + 23) * 2 - 1) * drift;
      pts.push_back({bx + dx, by + dy});
    }
  }
  const double comp = mjs::round(num(p, "composite"));
  static constexpr std::array<std::string_view, 5> kComposite{"source-over", "lighter", "screen", "multiply", "source-atop"};
  const std::string prev = oc.globalCompositeOperation();
  (void)oc.setGlobalCompositeOperation(comp >= 0 && comp <= 4 ? kComposite[static_cast<std::size_t>(comp)] : "source-over");
  oc.save();
  oc.setTransform({});
  // drawPlexusLinks.
  const double max_distance = std::max(0.0, num(p, "maxDistance"));
  const double line_width = std::max(0.0, num(p, "lineWidth"));
  const double line_opacity = std::max(0.0, std::min(1.0, num(p, "lineOpacity") / 100)) * opacity;
  const bool triangles = p["triangles"].is_bool() && p["triangles"].truthy();
  const double triangle_opacity = std::max(0.0, std::min(1.0, num(p, "triangleOpacity") / 100)) * opacity;
  const std::size_t n = std::min(pts.size(), static_cast<std::size_t>(kMaxPoints));
  struct Line {
    std::size_t i, j;
    double w;
  };
  std::vector<Line> lines;
  std::vector<std::array<std::size_t, 3>> tris;
  if (max_distance > 0) {
    const double d2max = max_distance * max_distance;
    std::vector<std::vector<std::size_t>> near(triangles ? n : 0);
    for (std::size_t i = 0; i < n; ++i) {
      for (std::size_t j = i + 1; j < n; ++j) {
        const double dx = pts[j].x - pts[i].x;
        const double dy = pts[j].y - pts[i].y;
        const double d2 = dx * dx + dy * dy;
        if (d2 >= d2max) continue;
        lines.push_back({i, j, 1 - std::sqrt(d2) / max_distance});
        if (triangles) near[i].push_back(j);
      }
    }
    if (triangles) {
      for (std::size_t i = 0; i < n; ++i) {
        const auto& ni = near[i];
        for (std::size_t q = 0; q < ni.size(); ++q) {
          const std::size_t j = ni[q];
          const auto& nj = near[j];
          for (std::size_t r = q + 1; r < ni.size(); ++r) {
            if (std::ranges::find(nj, ni[r]) != nj.end()) tris.push_back({i, j, ni[r]});
          }
        }
      }
    }
  }
  const auto [cr, cg, cb] = plexus_rgb(param_str(p, "lineColor"));
  const std::string rgb = jsn(cr) + "," + jsn(cg) + "," + jsn(cb) + ",";
  if (triangles && triangle_opacity > 0) {
    for (const auto& [i, j, k] : tris) {
      const P& a = pts[i];
      const P& c = pts[j];
      const P& d = pts[k];
      const double wt = std::min({1 - hyp(c.x - a.x, c.y - a.y) / max_distance, 1 - hyp(d.x - a.x, d.y - a.y) / max_distance,
                                  1 - hyp(d.x - c.x, d.y - c.y) / max_distance});
      fill_css(oc, "rgba(" + rgb + jsn(std::max(0.0, wt) * triangle_opacity) + ")");
      oc.beginPath();
      oc.moveTo(a.x, a.y);
      oc.lineTo(c.x, c.y);
      oc.lineTo(d.x, d.y);
      oc.closePath();
      oc.fill(raster::FillRule::nonzero);
    }
  }
  if (line_opacity > 0 && line_width > 0) {
    oc.setLineWidth(line_width);
    oc.setLineCap(raster::LineCap::round);
    for (const Line& l : lines) {
      stroke_css(oc, "rgba(" + rgb + jsn(l.w * line_opacity) + ")");
      oc.beginPath();
      oc.moveTo(pts[l.i].x, pts[l.i].y);
      oc.lineTo(pts[l.j].x, pts[l.j].y);
      oc.stroke();
    }
  }
  const double ps = std::max(0.0, num(p, "pointSize"));
  if (ps > 0) {
    const auto [pr, pg, pb] = plexus_rgb(param_str(p, "pointColor"));
    fill_css(oc, "rgba(" + jsn(pr) + "," + jsn(pg) + "," + jsn(pb) + "," + jsn(opacity) + ")");
    for (const P& q : pts) {
      oc.beginPath();
      oc.arc(q.x, q.y, ps / 2, 0, kPi * 2, false);
      oc.fill(raster::FillRule::nonzero);
    }
  }
  oc.restore();
  (void)oc.setGlobalCompositeOperation(prev);
}

/// drawPlexus: blend in a float16 canvas and round once (floatScratch) where
/// the canvas offers one — Skia's CPU raster here, Chromium there. A recording
/// canvas has none and takes the direct path, as the TS does under jsdom.
void apply_plexus(CanvasEffectContext& /*x*/, Canvas2D& oc, double w, double h, const Value& p) {
  const auto scratch = w > 0 && h > 0 ? oc.create_float16_canvas(static_cast<std::uint32_t>(w), static_cast<std::uint32_t>(h)) : nullptr;
  if (!scratch) {
    draw_plexus_into(oc, w, h, p);
    return;
  }
  const auto ow = static_cast<double>(oc.width());
  const auto oh = static_cast<double>(oc.height());
  scratch->drawImage(oc, 0, 0, ow, oh, 0, 0, ow, oh);
  draw_plexus_into(*scratch, w, h, p);
  const std::string prevOp = oc.globalCompositeOperation();
  oc.save();
  oc.setTransform({});
  (void)oc.setGlobalCompositeOperation("copy");
  const auto sw = static_cast<double>(scratch->width());
  const auto sh = static_cast<double>(scratch->height());
  oc.drawImage(*scratch, 0, 0, sw, sh, 0, 0, sw, sh);
  oc.restore();
  (void)oc.setGlobalCompositeOperation(prevOp);
}

// ── vegas.ts ─────────────────────────────────────────────────────────────────

struct CPt {
  double x, y;
};
using Contour = std::vector<CPt>;

double clampd(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }

/// extractAlphaContours: marching squares over the alpha plane, chained into loops.
std::vector<Contour> extract_alpha_contours(const std::vector<std::uint8_t>& alpha, int w, int h, double threshold) {
  if (w <= 0 || h <= 0) return {};
  const auto s = [&](int x, int y) -> double {
    if (x < 0 || y < 0 || x >= w || y >= h) return 0;
    return alpha[static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x)];
  };
  const auto crossing = [threshold](double a, double b) {
    const double d = b - a;
    if (d == 0) return 0.5;
    return clampd((threshold - a) / d, 0, 1);
  };
  enum Side : std::uint8_t { T, R, B, L };
  using Seg = std::pair<Side, Side>;
  static const std::array<std::vector<Seg>, 16> kCases{{
      {}, {{B, L}}, {{R, B}}, {{R, L}}, {{T, R}}, {}, {{T, B}}, {{T, L}},
      {{L, T}}, {{B, T}}, {}, {{R, T}}, {{L, R}}, {{B, R}}, {{L, B}}, {},
  }};
  const auto key = [](const CPt& p) { return std::pair<double, double>{mjs::round(p.x * 1e6), mjs::round(p.y * 1e6)}; };
  struct S {
    CPt a, b;
  };
  std::vector<S> segs;
  // vegas.ts keys endpoints by the string of their rounded µpx coordinates; a
  // hash of the two rounded doubles (−0 folded into +0, as the string does)
  // groups the same points. Lookups only: the per-key lists keep insertion order.
  struct KeyHash {
    std::size_t operator()(const std::pair<double, double>& k) const noexcept {
      const auto a = std::bit_cast<std::uint64_t>(k.first + 0.0);
      const auto b = std::bit_cast<std::uint64_t>(k.second + 0.0);
      return static_cast<std::size_t>(a * 0x9E3779B97F4A7C15ULL ^ (b + 0x632BE59BD9B4E019ULL + (a << 6U) + (a >> 2U)));
    }
  };
  struct KeyEq {
    bool operator()(const std::pair<double, double>& x, const std::pair<double, double>& y) const noexcept {
      return x.first == y.first && x.second == y.second;
    }
  };
  std::unordered_map<std::pair<double, double>, std::vector<std::size_t>, KeyHash, KeyEq> by_start;
  for (int cy = -1; cy < h; ++cy) {
    for (int cx = -1; cx < w; ++cx) {
      const double tl = s(cx, cy);
      const double tr = s(cx + 1, cy);
      const double br = s(cx + 1, cy + 1);
      const double bl = s(cx, cy + 1);
      const int bits = (tl >= threshold ? 8 : 0) | (tr >= threshold ? 4 : 0) | (br >= threshold ? 2 : 0) | (bl >= threshold ? 1 : 0);
      if (bits == 0 || bits == 15) continue;
      const std::array<CPt, 4> pts{CPt{cx + crossing(tl, tr), static_cast<double>(cy)}, CPt{cx + 1.0, cy + crossing(tr, br)},
                                   CPt{cx + crossing(bl, br), cy + 1.0}, CPt{static_cast<double>(cx), cy + crossing(tl, bl)}};
      std::vector<Seg> cell;
      if (bits == 5 || bits == 10) {
        const bool centre = (tl + tr + br + bl) / 4 >= threshold;
        if (bits == 5) cell = centre ? std::vector<Seg>{{T, L}, {B, R}} : std::vector<Seg>{{T, R}, {B, L}};
        else cell = centre ? std::vector<Seg>{{R, T}, {L, B}} : std::vector<Seg>{{L, T}, {R, B}};
      } else {
        cell = kCases[static_cast<std::size_t>(bits)];
      }
      for (const auto& [a, b] : cell) {
        by_start[key(pts[a])].push_back(segs.size());
        segs.push_back({pts[a], pts[b]});
      }
    }
  }
  std::vector<Contour> contours;
  std::vector<bool> consumed(segs.size(), false);
  const auto next_from = [&](const std::pair<double, double>& k) -> long {
    const auto it = by_start.find(k);
    if (it == by_start.end()) return -1;
    for (const std::size_t i : it->second) {
      if (!consumed[i]) return static_cast<long>(i);
    }
    return -1;
  };
  for (std::size_t start = 0; start < segs.size(); ++start) {
    if (consumed[start]) continue;
    Contour loop;
    long i = static_cast<long>(start);
    while (i >= 0 && !consumed[static_cast<std::size_t>(i)]) {
      const auto u = static_cast<std::size_t>(i);
      consumed[u] = true;
      loop.push_back(segs[u].a);
      i = next_from(key(segs[u].b));
    }
    if (loop.size() >= 3) {
      std::size_t best = 0;
      for (std::size_t k = 1; k < loop.size(); ++k) {
        if (loop[k].y < loop[best].y || (loop[k].y == loop[best].y && loop[k].x < loop[best].x)) best = k;
      }
      if (best != 0) std::rotate(loop.begin(), loop.begin() + static_cast<long>(best), loop.end());
      contours.push_back(std::move(loop));
    }
  }
  return contours;
}

struct Arc {
  std::vector<double> cum;
  double total = 0;
  bool closed = true;
};
Arc arc_table(const Contour& pts, bool closed) {
  const std::size_t n = pts.size();
  Arc t;
  t.cum.assign(n, 0);
  t.closed = closed;
  double acc = 0;
  for (std::size_t i = 1; i < n; ++i) {
    acc += hyp(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    t.cum[i] = acc;
  }
  const double closing = closed && n > 1 ? hyp(pts[0].x - pts[n - 1].x, pts[0].y - pts[n - 1].y) : 0;
  t.total = n > 1 ? acc + closing : 0;
  return t;
}
CPt point_at_arc(const Contour& pts, const Arc& t, double s) {
  const std::size_t n = pts.size();
  if (n == 0) return {0, 0};
  if (t.total <= 0) return pts[0];
  const double u = t.closed ? std::fmod(std::fmod(s, t.total) + t.total, t.total) : clampd(s, 0, t.total);
  // The first j with u < cum[j + 1] (cum never decreases: a binary search finds
  // the vertex the TS's linear scan does); none → the closing edge.
  const auto it = std::upper_bound(t.cum.begin() + 1, t.cum.end(), u);
  const auto i = static_cast<std::size_t>(it - (t.cum.begin() + 1));
  const double seg_len = (i == n - 1 ? t.total : t.cum[i + 1]) - t.cum[i];
  const double f = seg_len > 0 ? (u - t.cum[i]) / seg_len : 0;
  const CPt& a = pts[i];
  const CPt& b = pts[(i + 1) % n];
  return {a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f};
}
Contour walk_arc(const Contour& pts, const Arc& t, double from, double len) {
  const std::size_t n = pts.size();
  if (n < 2 || t.total <= 0 || len <= 0) return {};
  if (!t.closed) {
    const double s0 = clampd(from, 0, t.total);
    const double s1 = clampd(from + len, 0, t.total);
    if (s1 <= s0) return {};
    Contour run{point_at_arc(pts, t, s0)};
    // The vertices strictly inside (s0, s1): one contiguous run of the sorted `cum`.
    const auto first = std::upper_bound(t.cum.begin(), t.cum.end(), s0);
    const auto last = std::lower_bound(first, t.cum.end(), s1);
    for (auto k = first; k != last; ++k) run.push_back(pts[static_cast<std::size_t>(k - t.cum.begin())]);
    run.push_back(point_at_arc(pts, t, s1));
    return run;
  }
  const double span = std::min(len, t.total);
  Contour out{point_at_arc(pts, t, from)};
  const double start = std::fmod(std::fmod(from, t.total) + t.total, t.total);
  const auto arc_of = [&](std::size_t k) { return t.cum[k % n] + t.total * std::floor(static_cast<double>(k) / static_cast<double>(n)); };
  auto k = static_cast<std::size_t>(std::upper_bound(t.cum.begin(), t.cum.end(), start) - t.cum.begin());
  const double target = start + span;
  const std::size_t last = k + n;
  while (k <= last && arc_of(k) < target) {
    out.push_back(pts[k % n]);
    ++k;
  }
  out.push_back(point_at_arc(pts, t, start + span));
  return out;
}

struct Run {
  Contour points;
  double u0, u1;
};
constexpr double kBunchGap = 0.5;  // VEGAS_BUNCH_GAP

std::vector<Run> vegas_runs(const Contour& contour, double segments, double length_pct, double rotation_deg, bool closed, bool bunched,
                            double phase_arc) {
  const double n = std::max(1.0, mjs::round(segments));
  const Arc t = arc_table(contour, closed);
  if (t.total <= 0) return {};
  const double slot = t.total / n;
  const double lit = clampd(length_pct / 100, 0, 1) * slot;
  if (lit <= 0) return {};
  const double pitch = bunched ? lit + std::min(slot - lit, lit * kBunchGap) : slot;
  const double phase = (rotation_deg / 360) * t.total + phase_arc;
  std::vector<Run> out;
  const auto push = [&](Contour run, double u0, double u1) {
    if (run.size() >= 2) out.push_back({std::move(run), u0, u1});
  };
  for (double k = 0; k < n; ++k) {
    if (closed) {
      push(walk_arc(contour, t, phase + k * pitch, lit), 0, 1);
      continue;
    }
    const double s = std::fmod(std::fmod(phase + k * pitch, t.total) + t.total, t.total);
    if (s + lit <= t.total + 1e-9) {
      push(walk_arc(contour, t, s, lit), 0, 1);
    } else {
      const double split = (t.total - s) / lit;
      push(walk_arc(contour, t, s, t.total - s), 0, split);
      push(walk_arc(contour, t, 0, s + lit - t.total), split, 1);
    }
  }
  return out;
}

struct PathIn {
  Contour points;
  bool closed;
};
std::vector<Run> vegas_sequential_runs(const std::vector<PathIn>& paths, double segments, double length_pct, double rotation_deg, bool bunched,
                                       double phase_arc) {
  struct Open {
    Contour pts;
    Arc table;
  };
  std::vector<Open> opens;
  double total = 0;
  for (const PathIn& pth : paths) {
    Contour pts = pth.points;
    if (pth.closed && pth.points.size() > 1) pts.push_back(pth.points[0]);
    Arc table = arc_table(pts, false);
    total += table.total;
    opens.push_back({std::move(pts), std::move(table)});
  }
  if (total <= 0) return {};
  const double n = std::max(1.0, mjs::round(segments));
  const double slot = total / n;
  const double lit = clampd(length_pct / 100, 0, 1) * slot;
  if (lit <= 0) return {};
  const double pitch = bunched ? lit + std::min(slot - lit, lit * kBunchGap) : slot;
  const double phase = (rotation_deg / 360) * total + phase_arc;
  std::vector<Run> out;
  const auto emit = [&](double a, double b, double u_base) {
    double base = 0;
    for (const Open& o : opens) {
      const double len = o.table.total;
      const double lo = std::max(a, base);
      const double hi = std::min(b, base + len);
      if (hi > lo) {
        Contour run = walk_arc(o.pts, o.table, lo - base, hi - lo);
        if (run.size() >= 2) out.push_back({std::move(run), u_base + (lo - a) / lit, u_base + (hi - a) / lit});
      }
      base += len;
    }
  };
  for (double k = 0; k < n; ++k) {
    const double s = std::fmod(std::fmod(phase + k * pitch, total) + total, total);
    if (s + lit <= total + 1e-9) {
      emit(s, s + lit, 0);
    } else {
      emit(s, total, 0);
      emit(0, s + lit - total, (total - s) / lit);
    }
  }
  return out;
}

/// vegas.ts hash01: Random Phase's per-contour offset (int32 arithmetic).
double vegas_hash01(double a, double b) {
  const auto ua = static_cast<std::uint32_t>(ji32(a));
  const auto ub = static_cast<std::uint32_t>(ji32(b));
  std::uint32_t x = ua * 374761393U + ub * 668265263U;
  x = (x ^ (x >> 13U)) * 1274126177U;
  return static_cast<double>(x ^ (x >> 16U)) / 4294967296.0;
}

double vegas_opacity_at(double u, double start, double mid, double end, double mid_position) {
  const double m = clampd(mid_position / 100, 0.001, 0.999);
  const double uu = clampd(u, 0, 1);
  const double v = uu <= m ? start + ((mid - start) * uu) / m : mid + ((end - mid) * (uu - m)) / (1 - m);
  return clampd(v / 100, 0, 1);
}

void apply_vegas(CanvasEffectContext& x, Canvas2D& oc, double w, double h, const Value& p) {
  const double opacity = num(p, "opacity") / 100;
  if (opacity <= 0 || w <= 0 || h <= 0) return;
  const double length_pct = num(p, "length");
  if (length_pct <= 0) return;
  const double width = std::max(0.1, num(p, "width"));
  const double segments = std::max(1.0, mjs::round(num(p, "segments")));
  const double rotation = num(p, "rotation");
  const double hardness = clampd(num(p, "hardness"), 0, 100);
  const double threshold = clampd(num(p, "threshold"), 1, 254);
  const std::string color = str(p, "color", "#ffffff");
  const bool bunched = mjs::round(num(p, "segmentDistribution")) == 0;
  const bool random_phase = p["randomPhase"].is_bool() && p["randomPhase"].truthy();
  const double seed = std::floor(num(p, "randomSeed"));
  const double blend = mjs::round(num(p, "blendMode"));
  const double start_op = num(p, "startOpacity");
  const double mid_op = num(p, "midOpacity");
  const double end_op = num(p, "endOpacity");
  const double mid_pos = num(p, "midPosition");
  const bool flat_profile = start_op == 100 && mid_op == 100 && end_op == 100;
  const auto iw = static_cast<int>(w);
  const auto ih = static_cast<int>(h);

  std::vector<Contour> contours;
  bool path_closed = true;
  std::vector<PathIn> mask_paths;
  const bool all_masks = p["allMasks"].is_bool() && p["allMasks"].truthy();
  if (all_masks) {
    std::vector<double> meta;
    std::vector<double> xy;
    for (const auto& v : p["maskPathsMeta"].items()) meta.push_back(v.is_number() ? v.num() : 0);
    for (const auto& v : p["maskPathsXY"].items()) xy.push_back(v.is_number() ? v.num() : std::nan(""));
    for (const MaskPolyline& m : unpack_mask_paths(meta, xy, iw, ih)) {
      if (m.points.size() < 2) continue;
      PathIn pi{{}, m.closed};
      for (const Pt2& q : m.points) pi.points.push_back({q.x, q.y});
      mask_paths.push_back(std::move(pi));
    }
  } else if (p["pathPoints"].is_array() && p["pathPoints"].size() >= 6) {
    Contour loop;
    const Value& flat = p["pathPoints"];
    for (std::size_t i = 0; i + 1 < flat.size(); i += 2) {
      if (flat[i].is_number() && flat[i + 1].is_number()) loop.push_back({w / 2 + flat[i].num(), h / 2 + flat[i + 1].num()});
    }
    if (loop.size() >= 3) contours.push_back(std::move(loop));
    path_closed = !(p["pathClosed"].is_bool() && !p["pathClosed"].truthy());
  } else {
    const std::vector<std::uint8_t> img = oc.getImageData(0, 0, static_cast<std::uint32_t>(iw), static_cast<std::uint32_t>(ih));
    std::vector<std::uint8_t> alpha(static_cast<std::size_t>(iw) * static_cast<std::size_t>(ih));
    for (std::size_t i = 0; i < alpha.size(); ++i) alpha[i] = img[i * 4 + 3];
    contours = extract_alpha_contours(alpha, iw, ih, threshold);
  }

  std::vector<Run> runs;
  const auto append = [&runs](std::vector<Run> more) {
    for (Run& r : more) runs.push_back(std::move(r));
  };
  if (all_masks) {
    if (p["strokeSequentially"].is_bool() && p["strokeSequentially"].truthy()) {
      double total = 0;
      for (const PathIn& m : mask_paths) total += arc_table(m.points, m.closed).total;
      append(vegas_sequential_runs(mask_paths, segments, length_pct, rotation, bunched, random_phase ? vegas_hash01(seed, 0) * total : 0));
    } else {
      for (std::size_t i = 0; i < mask_paths.size(); ++i) {
        const PathIn& m = mask_paths[i];
        const double phase_arc = random_phase ? vegas_hash01(seed, static_cast<double>(i)) * arc_table(m.points, m.closed).total : 0;
        append(vegas_runs(m.points, segments, length_pct, rotation, m.closed, bunched, phase_arc));
      }
    }
  } else {
    for (std::size_t i = 0; i < contours.size(); ++i) {
      const double phase_arc = random_phase ? vegas_hash01(seed, static_cast<double>(i)) * arc_table(contours[i], path_closed).total : 0;
      append(vegas_runs(contours[i], segments, length_pct, rotation, path_closed, bunched, phase_arc));
    }
  }

  const bool needs_scratch = blend == 2 || blend == 3;
  Canvas2D* scratch = needs_scratch ? &x.scratch(oc, "vegas", static_cast<std::uint32_t>(iw), static_cast<std::uint32_t>(ih)) : nullptr;
  Canvas2D& dc = scratch != nullptr ? *scratch : oc;
  if (blend == 0) {
    oc.save();
    oc.setTransform({});
    oc.clearRect(0, 0, w, h);
    oc.restore();
  }
  if (runs.empty()) {
    if (blend == 3 && scratch != nullptr) {
      oc.save();
      oc.setTransform({});
      oc.clearRect(0, 0, w, h);
      oc.restore();
    }
    return;
  }
  if (&dc != &oc) {
    dc.setTransform({});
    dc.clearRect(0, 0, w, h);
  }
  dc.save();
  dc.setGlobalAlpha(std::min(1.0, opacity));
  stroke_css(dc, color);
  dc.setLineWidth(width);
  dc.setLineCap(raster::LineCap::round);
  dc.setLineJoin(raster::LineJoin::round);
  if (hardness < 100) (void)dc.setFilterString("blur(" + jsn(((100 - hardness) / 100) * width * 0.5) + "px)");
  const auto stroke_run = [&dc](const Contour& pts) {
    dc.beginPath();
    dc.moveTo(pts[0].x, pts[0].y);
    for (std::size_t i = 1; i < pts.size(); ++i) dc.lineTo(pts[i].x, pts[i].y);
    dc.stroke();
  };
  for (const Run& run : runs) {
    if (flat_profile) {
      stroke_run(run.points);
      continue;
    }
    const Arc table = arc_table(run.points, false);
    const double pieces = std::max(2.0, std::min(96.0, std::ceil(table.total / std::max(1.0, width * 0.5))));
    for (double j = 0; j < pieces; ++j) {
      const double a = (table.total * j) / pieces;
      const Contour piece = walk_arc(run.points, table, a, table.total / pieces);
      if (piece.size() < 2) continue;
      const double u = run.u0 + (run.u1 - run.u0) * ((j + 0.5) / pieces);
      dc.setGlobalAlpha(std::min(1.0, opacity) * vegas_opacity_at(u, start_op, mid_op, end_op, mid_pos));
      dc.setLineCap((j == 0 && run.u0 <= 0) || (j == pieces - 1 && run.u1 >= 1) ? raster::LineCap::round : raster::LineCap::butt);
      stroke_run(piece);
    }
  }
  dc.restore();
  if (scratch != nullptr) {
    oc.save();
    oc.setTransform({});
    oc.setGlobalAlpha(1);
    (void)oc.setGlobalCompositeOperation(blend == 2 ? "destination-over" : "destination-in");
    draw_whole_at(oc, *scratch, 0, 0);
    oc.restore();
  }
}

using GenFn = void (*)(CanvasEffectContext&, Canvas2D&, double, double, const Value&);
constexpr std::array<std::pair<std::string_view, GenFn>, 8> kGenerate{{
    {"lens-flare", apply_lens_flare},
    {"numbers", apply_numbers},
    {"timecode", apply_timecode},
    {"audio-spectrum", apply_audio_spectrum},
    {"audio-waveform", apply_audio_waveform},
    {"lightning", apply_lightning},
    {"plexus", apply_plexus},
    {"vegas", apply_vegas},
}};

constexpr std::array<std::string_view, kGenerate.size()> kGenerateNames = [] {
  std::array<std::string_view, kGenerate.size()> out{};
  for (std::size_t i = 0; i < kGenerate.size(); ++i) out[i] = kGenerate[i].first;
  return out;
}();

}  // namespace

bool run_generate_canvas_effect(std::string_view type, const raster::json::Value& params, raster::Canvas2D& oc, double w, double h,
                                CanvasEffectContext& ctx) {
  for (const auto& [name, fn] : kGenerate) {
    if (name == type) {
      fn(ctx, oc, w, h, params);
      return true;
    }
  }
  return false;
}

std::span<const std::string_view> generate_canvas_effects() noexcept { return kGenerateNames; }

}  // namespace premation::effects
