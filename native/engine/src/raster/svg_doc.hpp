// SVG documents for the C++ rasterizer (D2w): the Skia-free half of the SVG
// renderer — an XML parser, the CSS cascade Blink applies to SVG content
// (presentation attributes < <style> rules by specificity < style="" and
// !important), and the SVG micro-syntaxes (lengths, transform lists, path data
// normalised the way Blink's SVGPathNormalizer hands it to its path builder,
// point lists, viewBox + preserveAspectRatio).
//
// The TS engine rasterises an SVG by handing it to Chromium as an <img>
// (AppTextureProvider.rasterizeSvg), so "the reference" is Blink's SVG
// renderer; svg_render_ffi.cpp draws the parsed document with Skia the way
// Blink's SVG painters do.
#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "canvas.hpp"
#include "css.hpp"

namespace premation::raster::svg {

// ── XML ──────────────────────────────────────────────────────────────────────

struct Node {
  /// false = a text (or CDATA) node.
  bool element = true;
  /// Element: local name. Only elements in the SVG namespace render.
  std::string name;
  bool svgNs = false;
  /// Attributes by qualified name; an attribute in the XLink namespace is
  /// stored as "xlink:<local>" whatever prefix the file bound it to.
  std::vector<std::pair<std::string, std::string>> attrs;
  /// Text node content (entities decoded).
  std::string text;
  int parent = -1;
  std::vector<int> children;

  [[nodiscard]] const std::string* attr(std::string_view name) const;
  void set_attr(std::string_view name, std::string value);
};

struct Document {
  std::vector<Node> nodes;
  int root = -1;
  /// `href` / `xlink:href` of an element (plain href wins, as in SVG 2).
  [[nodiscard]] const std::string* href(int node) const;
  /// getElementById: the first element in tree order with this id.
  [[nodiscard]] int by_id(std::string_view id) const;
};

/// Parse an XML document (elements, attributes, text, CDATA, character and the
/// five predefined entity references; comments, processing instructions and a
/// DOCTYPE are skipped). False + a message on a well-formedness error — the
/// image then fails to load in Chromium too.
[[nodiscard]] bool parse_xml(std::string_view src, Document& out, std::string& error);

// ── values ───────────────────────────────────────────────────────────────────

enum class Unit : std::uint8_t { number, px, percent, em, ex, cm, mm, in, pt, pc };
struct Length {
  double v = 0.0;
  Unit unit = Unit::number;
};
/// An SVG <length> or <percentage> (unitless allowed).
[[nodiscard]] std::optional<Length> parse_length(std::string_view s);
/// Absolute value: `ref` for %, `fontPx` for em/ex.
[[nodiscard]] double resolve(const Length& l, double ref, double fontPx);

/// A number the way Blink's SVG parser reads one (float accumulation).
[[nodiscard]] std::optional<float> parse_number(std::string_view& s);
/// Skip whitespace, then an optional comma and whitespace.
void skip_comma_ws(std::string_view& s);

/// A transform list (`transform`, `gradientTransform`, `patternTransform`).
/// nullopt on a syntax error (Blink then drops the whole list).
[[nodiscard]] std::optional<Mat2D> parse_transform(std::string_view s);

/// Path data normalised as Blink's SVGPathNormalizer emits it to its builder:
/// absolute moveto / lineto / cubic / close (quadratics and arcs converted to
/// cubics), float coordinates. Parsing stops at the first error, keeping the
/// segments before it (the path renders up to the error).
struct PathSeg {
  enum class Op : std::uint8_t { move, line, cubic, close };
  Op op = Op::move;
  std::array<float, 6> p{};
};
[[nodiscard]] std::vector<PathSeg> parse_path_data(std::string_view d);

/// `points` of <polyline>/<polygon> (a trailing odd coordinate is dropped).
[[nodiscard]] std::vector<std::array<float, 2>> parse_points(std::string_view s);

struct ViewBox {
  double x = 0, y = 0, w = 0, h = 0;
};
[[nodiscard]] std::optional<ViewBox> parse_view_box(std::string_view s);

struct AspectRatio {
  /// 0 = none; else xMin/xMid/xMax (1..3) and yMin/yMid/yMax (1..3).
  std::uint8_t alignX = 2;
  std::uint8_t alignY = 2;
  bool none = false;
  bool slice = false;
};
[[nodiscard]] AspectRatio parse_aspect_ratio(std::string_view s);
/// SVGPreserveAspectRatio::ComputeTransform.
[[nodiscard]] Mat2D view_box_transform(const ViewBox& vb, const AspectRatio& par, double w, double h);

// ── style ────────────────────────────────────────────────────────────────────

struct Paint {
  enum class Kind : std::uint8_t { none, color, url, current };
  Kind kind = Kind::none;
  css::Color color;
  std::string url;  // element id (no '#')
  /// The fallback after a url(): none / a colour / currentColor; absent = none.
  Kind fallback = Kind::none;
  css::Color fallbackColor;
};

enum class Cap : std::uint8_t { butt, round, square };
enum class Join : std::uint8_t { miter, round, bevel, miterClip, arcs };
enum class Anchor : std::uint8_t { start, middle, end };

/// Computed style of one element (the properties the renderer reads).
struct Style {
  // inherited
  Paint fill{Paint::Kind::color, {0, 0, 0, 1}, {}, Paint::Kind::none, {}};
  Paint stroke;
  double fillOpacity = 1.0;
  double strokeOpacity = 1.0;
  bool fillEvenOdd = false;
  bool clipEvenOdd = false;
  Length strokeWidth{1.0, Unit::number};
  Cap cap = Cap::butt;
  Join join = Join::miter;
  double miterLimit = 4.0;
  std::vector<Length> dashArray;
  Length dashOffset;
  bool hidden = false;  // visibility: hidden / collapse
  std::string markerStart, markerMid, markerEnd;
  css::Color color{0, 0, 0, 1};
  std::vector<std::string> fontFamily;  // empty = the standard font
  double fontSizePx = 16.0;
  int fontWeight = 400;
  bool italic = false;
  Anchor anchor = Anchor::start;
  bool filtersLinearRGB = true;
  double letterSpacing = 0.0;
  double wordSpacing = 0.0;
  bool crispEdges = false;
  bool pixelatedImages = false;
  bool paintOrderStrokeFirst = false;
  bool paintOrderMarkersBeforeStroke = false;
  // not inherited
  double opacity = 1.0;
  bool displayNone = false;
  std::string clipPath, mask, filter;  // url ids ("" = none)
  bool filterUnsupported = false;      // a CSS filter function list
  css::Color stopColor{0, 0, 0, 1};
  double stopOpacity = 1.0;
  css::Color floodColor{0, 0, 0, 1};
  double floodOpacity = 1.0;
  css::Color lightingColor{255, 255, 255, 1};
  bool overflowVisible = false;
  bool maskAlpha = false;
  std::string blendMode;  // mix-blend-mode ("" = normal)
  bool isolate = false;
};

/// Cascade the document's styles (UA sheet + <style> elements + `extraCss`
/// appended as a last <style>, presentation attributes, style="").
/// `styles[i]` is the computed style of node i (text nodes copy their parent's).
/// CSS the port does not implement is named in `unsupported`.
void compute_styles(const Document& doc, std::string_view extraCss, std::vector<Style>& styles,
                    std::vector<std::string>& unsupported);

/// base64 → bytes (whitespace ignored). nullopt on invalid input.
[[nodiscard]] std::optional<std::vector<std::uint8_t>> base64_decode(std::string_view s);
/// A `data:` URL's payload (base64 or percent-encoded). nullopt if not a data URL.
[[nodiscard]] std::optional<std::vector<std::uint8_t>> data_url_bytes(std::string_view url, std::string* mime = nullptr);

}  // namespace premation::raster::svg
