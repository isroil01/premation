// Program X0 (docs/PROGRAM_DEEP_EFFECTS.md): writes an `fx-graph` chain entry —
// the passes render_graph/fx_graph.cpp runs (see fx_graph.hpp for the format).
#pragma once

#include <algorithm>
#include <array>
#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "effects_port.hpp"

namespace premation::scene::fxg {

// Slots (fx_graph.hpp).
inline constexpr int IN = 0;
inline constexpr int A = 1;
inline constexpr int B = 2;
inline constexpr int C = 3;
inline constexpr int X0 = 4;
inline constexpr int X1 = 5;
inline constexpr int X2 = 6;
inline constexpr int X3 = 7;
inline constexpr int H0 = 8;
inline constexpr int H1 = 9;
inline constexpr int Q0 = 10;
inline constexpr int Q1 = 11;
inline constexpr int MAP = 12;
inline constexpr int MAP2 = 13;
inline constexpr int MAP3 = 14;
inline constexpr int DATA = 15;
inline constexpr int MASK0 = 16;
inline constexpr int MASK1 = 17;
inline constexpr int STRIP = 18;
inline constexpr int TAP0 = 19;  ///< TAP0..TAP3 = 19..22: the layer at other times (Program X1)
inline constexpr int TAP1 = 20;
inline constexpr int TAP2 = 21;
inline constexpr int TAP3 = 22;
inline constexpr int SIM0 = 23;  ///< SIM0..SIM7 = 23..30: a simulation's slots (Program X2)
inline constexpr int BACKDROP = 31;  ///< the scene under the layer (stream D; needs Graph::backdrop())
inline constexpr int NONE = -1;

// Pass blends (fx_graph.cpp blend_of).
inline constexpr int kReplace = 0;
inline constexpr int kOver = 1;
inline constexpr int kAdd = 2;
inline constexpr int kScreen = 3;
inline constexpr int kMultiply = 4;
inline constexpr int kLighten = 5;

inline constexpr unsigned kKeep = 1U;
inline constexpr unsigned kDepth = 2U;

using Ins = std::array<int, 4>;

/// Rows of four, built left to right (`r(a, b, c, d)` per row).
class Rows {
 public:
  Rows& r(double a, double b = 0, double c = 0, double d = 0) {
    v_.insert(v_.end(), {a, b, c, d});
    return *this;
  }
  /// A colour (three channels) + a fourth value.
  Rows& c3(const std::array<double, 3>& c, double d = 0) { return r(c[0], c[1], c[2], d); }
  [[nodiscard]] const std::vector<double>& values() const noexcept { return v_; }

 private:
  std::vector<double> v_;
};

class Graph {
 public:
  Graph(std::string type, double lw, double lh) : type_(std::move(type)), lw_(lw), lh_(lh) {}

  /// A shader pass: `shader` (fxx-*.wgsl, prelude-less) reads `in` and writes `out`.
  Graph& pass(std::string_view shader, int out, Ins in, const Rows& rows, int blend = kReplace, unsigned flags = 0) {
    const std::vector<double>& v = rows.values();
    head(0, mat(shader), out, in, blend, flags, v.size() / 4);
    cur_->insert(cur_->end(), v.begin(), v.end());
    return *this;
  }
  /// Program X2: the passes that follow go to the simulation's init program,
  /// its step program, or (again) the graph.
  Graph& init_program() {
    cur_ = &init_;
    return *this;
  }
  Graph& step_program() {
    cur_ = &step_;
    return *this;
  }
  Graph& graph_program() {
    cur_ = &g_;
    return *this;
  }
  /// Program X2: the simulation's identity and clock (fx_graph.hpp).
  struct Sim {
    std::string key;
    double w = 256, h = 256;
    double frame = 0;
    double hash = 0;
    double sub = 1;
    double fps = 30;
    double every = 30;
    std::vector<double> state;
  };
  Graph& sim(Sim s) {
    sim_ = std::move(s);
    return *this;
  }
  /// A separable Gaussian of sigma `sigmaPx` (layer px) from `in` into `out`, through `tmp`.
  Graph& blur(int out, int in, double sigmaPx, int tmp) {
    head(1, sigmaPx, tmp, {in, NONE, NONE, NONE}, kReplace, 0, 0);
    head(2, sigmaPx, out, {tmp, NONE, NONE, NONE}, kReplace, 0, 0);
    return *this;
  }
  /// The same with its own sigma per axis (an anamorphic blur).
  Graph& blurxy(int out, int in, double sigmaX, double sigmaY, int tmp) {
    head(1, sigmaX, tmp, {in, NONE, NONE, NONE}, kReplace, 0, 0);
    head(2, sigmaY, out, {tmp, NONE, NONE, NONE}, kReplace, 0, 0);
    return *this;
  }
  /// `in` resampled into `out` (a half / quarter slot: a downsample) — raw
  /// values (fxx-copy): data slots (flow, velocity, pressure) keep their
  /// negative values and zero alphas, which the colour textured draw would not.
  Graph& copy(int out, int in, int blend = kReplace, unsigned flags = 0) {
    return pass("fxx-copy", out, {in, NONE, NONE, NONE}, Rows(), blend, flags);
  }
  /// The alpha distance field of `in` (render_graph/fx_distance.hpp) into the
  /// float slot `out`, exact to `rangePx` layer px: r = signed distance to the
  /// 1/2-contour in buffer texels (+ outside; × pxPerOut() = layer px), g = alpha.
  Graph& field(int out, int in, double rangePx) {
    head(4, rangePx, out, {in, NONE, NONE, NONE}, kReplace, 0, 0);
    return *this;
  }
  /// The layer a MAP slot reads (`k` 0..2).
  Graph& map(int k, std::string layerId) {
    maps_.at(static_cast<std::size_t>(std::clamp(k, 0, 2))) = std::move(layerId);
    return *this;
  }
  Graph& data(std::string key) {
    dataKey_ = std::move(key);
    return *this;
  }
  /// The time tap a TAP slot reads (`k` 0..3; deep_fx_scene.hpp time_tap_id).
  Graph& tap(int k, std::string layerId) {
    taps_.at(static_cast<std::size_t>(std::clamp(k, 0, 3))) = std::move(layerId);
    return *this;
  }
  /// The mask raster a MASK slot reads (`k` 0..1; a scope_mask_key). `required`: the effect is
  /// meaningless without it (an Object Matte card and its stored frame) — the graph then runs
  /// nothing and the chain keeps its input when the texture did not arrive, instead of reading
  /// the slot as transparent black and cutting the whole layer away (fx_graph.cpp).
  Graph& mask(int k, std::string key, bool required = false) {
    const auto i = static_cast<std::size_t>(std::clamp(k, 0, 1));
    masks_.at(i) = std::move(key);
    maskRequired_.at(i) = required;
    return *this;
  }
  /// Stream D: the graph reads BACKDROP — the composition pass copies the
  /// scene under the layer before the chain (`readsBackdrop`), and the
  /// chain's result is never kept across frames.
  Graph& backdrop() {
    backdrop_ = true;
    return *this;
  }
  /// Stream D: `reachPx` > 0 is MEASURED — read off the passes' farthest tap
  /// in layer px — so fx_bounds may scissor the chain to it (`reachMeasured`);
  /// without this a non-zero reach runs the chain full frame.
  Graph& measured() {
    measured_ = true;
    return *this;
  }
  /// The chain entry; `reachPx` 0 = per-pixel (bounded to the input), absent = full frame.
  [[nodiscard]] api::RenderEffect done(int out, std::optional<double> reachPx = std::nullopt) {
    FxWriter w("fx-graph");
    w.text("fxType", type_);
    if (backdrop_) w.flag("readsBackdrop", true);
    if (measured_ && reachPx && *reachPx > 0) w.flag("reachMeasured", true);
    std::string names;
    for (const std::string& m : mats_) {
      if (!names.empty()) names += ',';
      names += m;
    }
    w.text("mats", std::move(names));
    w.nums("g", std::move(g_));
    if (!sim_.key.empty()) {
      w.text("simKey", sim_.key);
      w.num("simW", sim_.w).num("simH", sim_.h).num("simFrame", sim_.frame).num("simHash", sim_.hash);
      w.num("simSub", sim_.sub).num("simFps", sim_.fps).num("simEvery", sim_.every);
      w.nums("simState", sim_.state);
      w.nums("simInit", std::move(init_));
      w.nums("simStep", std::move(step_));
    }
    w.num("out", out);
    w.num("lw", lw_);
    w.num("lh", lh_);
    static constexpr std::array<const char*, 3> kIds = {"mapLayerId", "mapLayerId2", "mapLayerId3"};
    for (std::size_t k = 0; k < maps_.size(); ++k) {
      if (!maps_.at(k).empty()) w.text(kIds.at(k), maps_.at(k));
    }
    if (!dataKey_.empty()) w.text("dataKey", dataKey_);
    if (!masks_[0].empty()) w.text("maskKey0", masks_[0]);
    if (!masks_[1].empty()) w.text("maskKey1", masks_[1]);
    if (maskRequired_[0]) w.flag("maskRequired0", true);
    if (maskRequired_[1]) w.flag("maskRequired1", true);
    static constexpr std::array<const char*, 4> kTaps = {"tapId0", "tapId1", "tapId2", "tapId3"};
    for (std::size_t k = 0; k < taps_.size(); ++k) {
      if (!taps_.at(k).empty()) w.text(kTaps.at(k), taps_.at(k));
    }
    if (reachPx) w.num("reachPx", *reachPx);
    return w.done();
  }

 private:
  double mat(std::string_view shader) {
    const auto it = std::ranges::find(mats_, shader);
    if (it != mats_.end()) return static_cast<double>(it - mats_.begin());
    mats_.emplace_back(shader);
    return static_cast<double>(mats_.size() - 1);
  }
  void head(double op, double arg, int out, Ins in, int blend, unsigned flags, std::size_t nrows) {
    cur_->insert(cur_->end(), {op, arg, static_cast<double>(out), static_cast<double>(in[0]), static_cast<double>(in[1]),
                         static_cast<double>(in[2]), static_cast<double>(in[3]), static_cast<double>(blend),
                         static_cast<double>(flags), static_cast<double>(nrows)});
  }

  std::string type_;
  double lw_;
  double lh_;
  std::vector<std::string> mats_;
  std::vector<double> g_;
  std::vector<double> init_;
  std::vector<double> step_;
  std::vector<double>* cur_ = &g_;
  Sim sim_;
  std::array<std::string, 3> maps_{};
  std::array<std::string, 2> masks_{};
  std::array<bool, 2> maskRequired_{};
  std::array<std::string, 4> taps_{};
  std::string dataKey_;
  bool backdrop_ = false;
  bool measured_ = false;
};

}  // namespace premation::scene::fxg
