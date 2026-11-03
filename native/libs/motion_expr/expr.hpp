// motion_expr — the property-expression language, ported from TypeScript.
//
// A line-for-line port of packages/animation/src/exprLang.ts (lexer, Pratt
// parser, evaluator, budgets), expressions.ts (the AE-style API: wiggle,
// random, loopOut, valueAtTime, thisComp/thisLayer/thisProperty, markers,
// coordinate spaces, vector maths, ...), and sourceText.ts (text.sourceText
// and the chainable style object). The contract is PARITY: the same source and
// the same context give the same numbers — bit for bit — and the same error
// text as the TypeScript engine, gated by native/tests/golden_expr.inc which
// the TypeScript itself generates (native/tests/gen_golden_expr.ts).
//
// Expressions are PARSED, never executed as code, exactly as in TypeScript:
// an expression can reach only the names bound here. Values follow JavaScript
// semantics (the language is a JavaScript expression subset and people paste
// AE expressions into it): `+` concatenates strings, `==` coerces, `[1,2]+""`
// is "1,2", `(0.1).toFixed(20)` has 20 exact digits, and `Math.sin` is V8's
// fdlibm (motion_jsmath) — which is what makes `wiggle` and `random` land on
// the same values.
//
// Cross-layer reads, coordinate spaces, markers and text go through `Host`,
// an interface the engine implements; nothing here reaches a global.

#ifndef MOTION_EXPR_EXPR_HPP
#define MOTION_EXPR_EXPR_HPP

#include <array>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace motion::expr {

// ── Limits (exprLang.ts / expressions.ts / sourceText.ts) ───────────────────

/// AST nodes one evaluation may visit, shared with nested (cross-layer) ones.
inline constexpr int kMaxEvalSteps = 200000;
/// Nesting depth one evaluation may reach, shared with nested ones.
inline constexpr int kMaxEvalDepth = 512;
/// `wiggle` octave clamp.
inline constexpr int kMaxWiggleOctaves = 8;
/// Longest text a Source Text expression may produce.
inline constexpr std::size_t kMaxSourceTextLength = 100000;
/// Most per-character style ranges one Source Text expression may stack.
inline constexpr std::size_t kMaxRangeOverrides = 256;
/// Parser nesting limit — exprLang.ts MAX_PARSE_DEPTH / MAX_PARSE_DEPTH_MESSAGE,
/// the same count and text in both engines (a level: the expression, each
/// bracketed sub-expression, each binary right operand, each prefix operator).
/// Past it the compile error is "Syntax error: " + the message.
inline constexpr int kMaxParseDepth = 2000;
inline constexpr std::u16string_view kMaxParseDepthMessage =
    u"This expression is nested too deeply to read (more than 2000 levels).";

// ── Context data ────────────────────────────────────────────────────────────

struct CompInfo {
  double width = 1920;
  double height = 1080;
  double duration = 10;
  double fps = 60;
  double num_layers = 1;
};

struct LayerInfo {
  std::u16string name;
  double width = 0;
  double height = 0;
};

struct SourceRect {
  double top = 0;
  double left = 0;
  double width = 0;
  double height = 0;
};

/// First→last keyframe time of the current property's own track.
struct KeySpan {
  double start = 0;
  double end = 0;
};

/// One marker as the host supplies it (`time` in composition seconds).
struct MarkerData {
  double time = 0;
  double duration = 0;
  std::u16string name;
  std::u16string comment;
};

enum class MarkerScope : std::uint8_t { kComp, kLayer };

enum class SpaceOp : std::uint8_t { kToComp, kFromComp, kToWorld, kFromWorld };

/// AE's layer facts (`inPoint`, `outPoint`, `index`, `parent`, `enabled`), in
/// composition seconds; `index` is 1 at the top of the stack. `parent` is the
/// parent layer's reference (`#<id>` or its name), absent for a layer parented
/// to the composition.
struct LayerFacts {
  double in_point = 0;
  double out_point = 0;
  double index = 1;
  bool enabled = true;
  std::optional<std::u16string> parent;
  /// The layer's own name (`thisComp.layer(2).name`); empty = not known.
  std::u16string name{};
};

/// A composition as `comp("Name")` / `thisComp.name` see it.
struct CompFacts {
  CompInfo info;
  std::u16string name{};
};

/// An effect parameter's value: a scalar, a point `[x, y]`, or a colour
/// `[r, g, b, a]` in 0..1.
struct EffectParam {
  std::array<double, 4> v{};
  std::size_t size = 1;
};

// ── Source Text data (sourceText.ts) ────────────────────────────────────────

/// A text layer's layer-wide style, in the APP's units.
struct SourceTextStyle {
  std::u16string font_family;
  double font_size = 0;
  std::u16string font_weight;
  std::u16string font_style;
  std::u16string fill;
  std::optional<std::u16string> stroke;
  double stroke_width = 0;
  double letter_spacing = 0;
  double line_height = 0;
  double baseline_shift = 0;
  double horizontal_scale = 100;
  double vertical_scale = 100;
  std::u16string text_transform;
  std::u16string font_variant;
  std::u16string align;
  double paragraph_spacing = 0;
  double first_line_indent = 0;
  double left_indent = 0;
  double right_indent = 0;
  double space_before = 0;
  std::optional<std::u16string> direction;
};

struct SourceTextRunStyle {
  std::optional<double> font_size;
  std::optional<std::u16string> font_family;
  std::optional<std::u16string> font_weight;
  std::optional<std::u16string> font_style;
  std::optional<double> letter_spacing;
  std::optional<std::u16string> fill;
};

/// `[start, end)` in grapheme indices.
struct SourceTextRun {
  double start = 0;
  double end = 0;
  SourceTextRunStyle style;
};

struct SourceTextSample {
  std::u16string text;
  SourceTextStyle style;
  std::optional<std::vector<SourceTextRun>> runs;
};

/// Layer-wide overrides an expression set (absent = untouched). `tracking`
/// (1/1000 em) and `leading` (px) are AE units, as in the TypeScript.
struct SourceTextStyleOverrides {
  std::optional<std::u16string> font_family;
  std::optional<double> font_size;
  std::optional<std::u16string> font_weight;
  std::optional<std::u16string> font_style;
  std::optional<std::u16string> fill;
  std::optional<bool> apply_fill;
  std::optional<std::u16string> stroke;
  std::optional<double> stroke_width;
  std::optional<bool> apply_stroke;
  std::optional<double> tracking;
  std::optional<double> leading;
  std::optional<double> baseline_shift;
  std::optional<double> horizontal_scale;
  std::optional<double> vertical_scale;
  std::optional<std::u16string> text_transform;
  std::optional<std::u16string> font_variant;
  std::optional<std::u16string> align;
  std::optional<double> first_line_indent;
  std::optional<double> left_indent;
  std::optional<double> right_indent;
  std::optional<double> space_before;
  std::optional<double> space_after;
  std::optional<std::u16string> direction;
  std::optional<std::u16string> leading_type;
};

struct SourceTextRangeOverride {
  double start = 0;
  double count = 0;
  SourceTextStyleOverrides style;  // only range-capable keys are ever set
};

/// What an expression on Source Text evaluates to, as data.
struct SourceTextResult {
  std::u16string text;
  SourceTextStyleOverrides style;
  std::vector<SourceTextRangeOverride> ranges;
};

// ── The host ────────────────────────────────────────────────────────────────

/// Thrown by a Host callback to fail the whole expression with `message` —
/// the TypeScript engine's "Cycle detected …" / "Maximum cross-layer
/// evaluation depth …" errors travel this way. Never crosses the C ABI.
struct HostError : std::exception {
  explicit HostError(std::u16string m) : message(std::move(m)) {}
  [[nodiscard]] const char* what() const noexcept override { return "motion::expr::HostError"; }
  std::u16string message;
};

/// A bezier path as AE expressions see it: vertices, and each vertex's in /
/// out tangent RELATIVE to it; `closed` joins the last vertex to the first.
struct PathSample {
  std::vector<std::array<double, 2>> points;
  std::vector<std::array<double, 2>> in_tangents;
  std::vector<std::array<double, 2>> out_tangents;
  bool closed = true;
};

/// The engine's side of an evaluation. Every provider is OPTIONAL, mirroring
/// the optional fields of the TypeScript `ExprContext`: `has_x()` false means
/// "provider absent", which several builtins treat differently from a
/// provider that returns nothing (see each method).
class Host {
 public:
  Host() = default;
  Host(const Host&) = default;
  Host(Host&&) = default;
  Host& operator=(const Host&) = default;
  Host& operator=(Host&&) = default;
  virtual ~Host() = default;

  /// `ctrl(name)`: named slider control. Absent → every control reads 0.
  [[nodiscard]] virtual bool has_ctrl() const { return false; }
  virtual double ctrl(std::u16string_view /*name*/) { return 0; }

  /// The current property's KEYFRAMED value at `t` (valueAtTime, loopOut, key(n)).
  /// Absent → the context's `value` whatever `t` is.
  [[nodiscard]] virtual bool has_self_at() const { return false; }
  virtual double self_at(double /*t*/) { return 0; }

  /// Another layer's property at `t`. nullopt = no such layer/prop (reads 0).
  /// May throw HostError (cycle / depth).
  [[nodiscard]] virtual bool has_layer_at() const { return false; }
  virtual std::optional<double> layer_at(std::u16string_view /*name*/, std::u16string_view /*prop*/,
                                         double /*t*/) {
    return std::nullopt;
  }

  /// Content bounds for sourceRectAtTime. nullopt / absent → the layer box.
  [[nodiscard]] virtual bool has_source_rect_at() const { return false; }
  virtual std::optional<SourceRect> source_rect_at(double /*t*/, bool /*extents*/) {
    return std::nullopt;
  }

  /// Coordinate spaces. `name` nullptr = the current layer. `space_exists`
  /// false (or no provider) → a stated error; `space_convert` returns the
  /// converted point (2 or 3 components, per `op`).
  [[nodiscard]] virtual bool has_space_at() const { return false; }
  virtual bool space_exists(const std::u16string* /*name*/, double /*t*/) { return false; }
  virtual std::array<double, 3> space_convert(const std::u16string* /*name*/, double /*t*/, SpaceOp /*op*/,
                                              std::array<double, 3> p) {
    return p;
  }

  /// Markers for one scope (any order; sorted here). Absent → none.
  [[nodiscard]] virtual bool has_markers_at() const { return false; }
  virtual std::vector<MarkerData> markers_at(MarkerScope /*scope*/) { return {}; }

  /// Source Text of a layer (`name` nullptr = this one). nullopt → a stated
  /// error. May throw HostError.
  [[nodiscard]] virtual bool has_source_text_at() const { return false; }
  virtual std::optional<SourceTextSample> source_text_at(const std::u16string* /*name*/, double /*t*/) {
    return std::nullopt;
  }

  /// Camera program D6 — cameras and lights.
  /// One property of a layer at `t` (`name` nullptr = this layer), with the
  /// engine's effective default when unset (a camera's Zoom, Focus Distance,
  /// Point of Interest…). `prop` is the document's name (`focalLength`,
  /// `poiX`, `intensity`…). nullopt = no such layer / property (reads 0).
  /// May throw HostError (cycle / depth). Default: `layer_at` for a named layer.
  virtual std::optional<double> layer_prop_at(const std::u16string* name, std::u16string_view prop, double t) {
    if (name != nullptr && has_layer_at()) return layer_at(*name, prop, t);
    return std::nullopt;
  }
  /// A layer's colour property (a light's Color) as RGBA 0..1 at `t`.
  virtual std::optional<std::array<double, 4>> layer_color_at(const std::u16string* /*name*/,
                                                              std::u16string_view /*prop*/, double /*t*/) {
    return std::nullopt;
  }
  /// `thisComp.activeCamera`: the layer reference (`#<id>`) of the camera the
  /// composition renders through at `t`, nullopt when it has none.
  virtual std::optional<std::u16string> active_camera_at(double /*t*/) { return std::nullopt; }

  /// AE-style rigs (docs/EXPRESSION_LANGUAGE.md).
  /// A layer's facts (`name` nullptr = this layer); nullopt = no such layer.
  virtual std::optional<LayerFacts> layer_facts_at(const std::u16string* /*name*/, double /*t*/) {
    return std::nullopt;
  }
  /// `thisComp.layer(index)`: the reference (`#<id>`) of the layer at that
  /// 1-based stack index (1 = top), nullopt when there is none.
  virtual std::optional<std::u16string> layer_ref_by_index(double /*index*/) { return std::nullopt; }
  /// `effect("Name")`: whether the layer carries an effect or expression control
  /// of that name (display name, then match name). `has_effects()` false means
  /// no provider: every `effect()` call is then a stated error.
  [[nodiscard]] virtual bool has_effects() const { return false; }
  virtual bool effect_exists(const std::u16string* /*layer*/, std::u16string_view /*effect*/) { return false; }
  /// `effect("Name")("Param")` / `effect("Name")(1)`: the parameter by name
  /// (its label, then its key) when `param` is set, else by 1-based index, at
  /// `t`; nullopt = no such parameter.
  virtual std::optional<EffectParam> effect_param_at(const std::u16string* /*layer*/, std::u16string_view /*effect*/,
                                                     const std::u16string* /*param*/, double /*index*/, double /*t*/) {
    return std::nullopt;
  }

  /// AE property objects (2026-10-21).
  /// `effect("Name").active`: whether the effect is switched on.
  virtual bool effect_active(const std::u16string* /*layer*/, std::u16string_view /*effect*/) { return true; }
  /// Key times (seconds, ascending) of a layer property's track (`prop` is the
  /// document's name: `x`, `rotation`…), for `.numKeys` / `.key(n)`. Empty = not keyed.
  virtual std::vector<double> layer_key_times(const std::u16string* /*name*/, std::u16string_view /*prop*/) {
    return {};
  }
  /// The same for an effect parameter (its first member's track).
  virtual std::vector<double> effect_param_key_times(const std::u16string* /*layer*/, std::u16string_view /*effect*/,
                                                     const std::u16string* /*param*/, double /*index*/) {
    return {};
  }
  /// `comp("Name")` (`name` nullptr = the expression's own composition, for
  /// `thisComp.name`); nullopt = no such composition.
  virtual std::optional<CompFacts> comp_facts(const std::u16string* /*name*/) { return std::nullopt; }
  /// `comp("Name").layer("Layer")` / `.layer(index)`: the reference (`#<id>`)
  /// of that layer of that composition, nullopt when it has none.
  virtual std::optional<std::u16string> comp_layer_ref(const std::u16string& /*comp*/, const std::u16string* /*name*/,
                                                       double /*index*/) {
    return std::nullopt;
  }
  /// AE's `footage("name")` on a DATA item (.json / .csv / .tsv): the item's
  /// name and its file's text (UTF-8); nullopt = no such data footage.
  struct FootageText {
    std::u16string name;
    std::string text;
  };
  virtual std::optional<FootageText> footage_text(std::u16string_view /*name*/) { return std::nullopt; }
  /// AE path properties (path.cpp): a layer's mask path (`mask` true; `name`
  /// the mask's name, nullptr = its first) or its shape path (`mask` false) at
  /// `t`, after its own expression. `layer` nullptr = this layer; nullopt =
  /// no such layer / mask / path.
  virtual std::optional<PathSample> path_at(const std::u16string* /*layer*/, bool /*mask*/, const std::u16string* /*name*/,
                                            double /*t*/) {
    return std::nullopt;
  }
  /// AE `layer.sampleImage(point, radius, postEffect, t)`: the layer's pixels
  /// over the rectangle `point ± radius` in its own space, after its masks and
  /// effects (`post_effect`) or its untouched source, at `t`. `error` set = the
  /// pixels could not be had (the expression fails with it). nullopt = no such
  /// layer. `layer` nullptr = this layer.
  struct ImageSample {
    std::array<double, 4> rgba{};
    std::u16string error;
  };
  virtual std::optional<ImageSample> sample_image(const std::u16string* /*layer*/, std::array<double, 2> /*point*/,
                                                  std::array<double, 2> /*radius*/, bool /*post_effect*/, double /*t*/) {
    return ImageSample{{}, u"sampleImage needs the renderer, which this evaluation does not have."};
  }
};

/// One evaluation's inputs (`ExprContext`).
struct Context {
  /// Present only when the expression is ON a path property (a mask's Mask Path,
  /// a shape's Path): `value` is this path.
  const PathSample* path_value = nullptr;
  double time = 0;
  double value = 0;
  std::optional<double> audio;
  std::optional<KeySpan> self_span;
  std::optional<CompInfo> comp;
  std::optional<LayerInfo> layer_info;
  std::optional<double> prop_seed;
  std::span<const double> key_times;
  /// Present only when the expression is ON the Source Text property.
  const SourceTextSample* text_value = nullptr;
  Host* host = nullptr;
};

/// `ExprResult`: a finite number, a 1..4 vector of finite numbers, or an error.
struct Result {
  enum class Kind : std::uint8_t { kNull, kNumber, kVector };
  Kind kind = Kind::kNull;
  double number = 0;
  std::array<double, 4> vec{};
  std::size_t size = 0;
  std::optional<std::u16string> error;
  /// Where `error` happened: 1-based line and column (UTF-16 units) of the
  /// node that failed in the expression's source; 0 = not known (or no error).
  /// Never part of the message text.
  std::uint32_t line = 0;
  std::uint32_t column = 0;
};

/// `runPath(ctx)`: the path a path property's expression returned (`value`, a
/// changed copy, `createPath(...)`, another layer's mask / shape path).
struct PathResult {
  std::optional<PathSample> result;
  std::optional<std::u16string> error;
  std::uint32_t line = 0;    // as Result::line
  std::uint32_t column = 0;  // as Result::column
};

struct TextResult {
  std::optional<SourceTextResult> result;
  std::optional<std::u16string> error;
  std::uint32_t line = 0;    // as Result::line
  std::uint32_t column = 0;  // as Result::column
};

namespace detail {
struct Program;  // parsed AST (program.hpp)
}  // namespace detail

/// A compiled expression (`CompiledExpression`). Immutable after compile;
/// `run` may be called concurrently from several threads.
///
/// Stack: parsing and evaluation recurse once per nesting level (bounded by
/// kMaxParseDepth / kMaxEvalDepth). A normal build needs well under 1 MB for
/// the worst case; sanitizer builds need several MB — evaluate on threads with
/// at least 8 MB of stack (the Linux/macOS default; Windows' is 1 MB).
class Expression {
 public:
  /// Parse `src` (UTF-16). Never throws for bad source: the error is kept and
  /// every run returns it, like the TypeScript.
  static Expression compile(std::u16string_view src);

  Expression(Expression&&) noexcept;
  Expression& operator=(Expression&&) noexcept;
  Expression(const Expression&) = delete;
  Expression& operator=(const Expression&) = delete;
  ~Expression();

  [[nodiscard]] const std::optional<std::u16string>& compile_error() const noexcept { return compile_error_; }
  /// 1-based line / column of the compile error in the source (0 = none).
  [[nodiscard]] std::uint32_t compile_error_line() const noexcept { return error_line_; }
  [[nodiscard]] std::uint32_t compile_error_column() const noexcept { return error_column_; }
  /// True for an empty/blank source: run() then returns {null, no error}.
  [[nodiscard]] bool empty() const noexcept { return program_ == nullptr && !compile_error_; }

  /// `run(ctx)` — numeric evaluation.
  [[nodiscard]] Result run(const Context& ctx) const;
  /// `runText(ctx)` — Source Text evaluation.
  [[nodiscard]] TextResult run_text(const Context& ctx) const;
  /// Path evaluation (a Mask Path / shape Path expression).
  [[nodiscard]] PathResult run_path(const Context& ctx) const;

 private:
  Expression() = default;
  /// Line / column of an offset into the parsed (trimmed) source.
  void locate(std::uint32_t pos, std::uint32_t& line, std::uint32_t& column) const noexcept;
  std::unique_ptr<const detail::Program> program_;
  std::optional<std::u16string> compile_error_;
  std::vector<std::uint32_t> line_starts_;  // offsets (into the original source) where each line begins
  std::uint32_t base_ = 0;                  // the trimmed source's offset in the original
  std::uint32_t error_line_ = 0;
  std::uint32_t error_column_ = 0;
};

/// AnimationEngine's `stringSeed(nodeId + ':' + prop)` — the per-property
/// noise phase the engine passes as `prop_seed`.
[[nodiscard]] double string_seed(std::u16string_view s) noexcept;

// ── Native plugin expression functions (SDK 1.4, E1) ────────────────────────
//
// `plugin` in an expression is { "<plugin id>": { <name>: function, … }, … } of what the engine's
// plugin host registered. A call flattens its arguments to numbers (arrays element by element)
// and returns a number (one result) or an array. Process-wide; the host replaces the set when a
// plugin loads, reloads or goes.

struct PluginFunction {
  std::string plugin;  ///< the plugin id
  std::string name;    ///< the function's name
};
/// Call "<plugin id>.<name>" with `args`; false + `error` when it fails (unknown, a fault, …).
using PluginCallFn = bool (*)(void* user, std::string_view plugin, std::string_view name, std::span<const double> args,
                              std::vector<double>& out, std::string& error);
void set_plugin_functions(std::vector<PluginFunction> list, PluginCallFn call, void* user);
[[nodiscard]] std::vector<PluginFunction> plugin_functions();
bool call_plugin_function(std::string_view plugin, std::string_view name, std::span<const double> args, std::vector<double>& out,
                          std::string& error);

// ── UTF-8 ⇄ UTF-16 (the C ABI speaks UTF-8; the language speaks UTF-16) ────

[[nodiscard]] std::u16string utf8_to_utf16(std::string_view s);
/// Lone surrogates (legal in a JavaScript string) become U+FFFD.
[[nodiscard]] std::string utf16_to_utf8(std::u16string_view s);

}  // namespace motion::expr

#endif  // MOTION_EXPR_EXPR_HPP
