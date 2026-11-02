#include "fx_graph.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
#include <iterator>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

#include "effect_chain.hpp"
#include "fx_distance.hpp"
#include "materials.hpp"
#include "passes.hpp"
#include "uniforms.hpp"

namespace premation::rg {
namespace {

constexpr std::size_t kHeader = 10;
constexpr int kOpShader = 0;
constexpr int kOpBlurX = 1;
constexpr int kOpBlurY = 2;
constexpr int kOpCopy = 3;
constexpr int kOpField = 4;
static_assert(kOpField == kOpCopy + 1, "the ops are dense: parse() accepts kOpShader..kOpField");
/// The field op's slot copy (raw: the signed distance is negative inside).
constexpr std::string_view kFieldCopy = "fxx-copy";
constexpr unsigned kFlagKeep = 1U;
constexpr unsigned kFlagDepth = 2U;
constexpr std::array<std::string_view, 2> kHalf = {"plugin-half1", "plugin-half2"};
constexpr std::array<std::string_view, 2> kQuarter = {"plugin-quarter1", "plugin-quarter2"};
/// X2: checkpoints kept per simulation, and the most frames one call steps.
constexpr std::size_t kMaxCheckpoints = 32;
constexpr int kMaxStepFrames = 2400;

/// The graph's blend index → the device's (0 none · 1 normal · 2 add · 3 screen
/// · 4 multiply · 5 lighten · 6 darken · 7 lighter): a pass that accumulates
/// into a kept slot (`keep`) adds, the rest replace.
Blend blend_of(double v) {
  switch (static_cast<int>(v)) {
    case 1: return Blend::normal;
    case 2: return Blend::add;
    case 3: return Blend::screen;
    case 4: return Blend::multiply;
    case 5: return Blend::lighten;
    case 6: return Blend::darken;
    case 7: return Blend::lighter;
    default: return Blend::none;
  }
}

std::vector<std::string_view> split(std::string_view s) {
  std::vector<std::string_view> out;
  while (!s.empty()) {
    const std::size_t c = s.find(',');
    out.push_back(s.substr(0, c));
    if (c == std::string_view::npos) break;
    s.remove_prefix(c + 1);
  }
  return out;
}

struct Slot {
  std::string_view name;  ///< a target (empty: read-only texture)
  TexRef tex;             ///< a read-only slot's texture
  std::uint32_t w = 0;
  std::uint32_t h = 0;
  double scale = 1;  ///< texels per full-resolution texel
};

struct Pass {
  int op = 0;
  int arg = 0;
  int out = 0;
  double argValue = 0;  ///< the blur ops' sigma, the field op's range (layer px)
  std::array<int, 4> in{};
  Blend blend = Blend::none;
  unsigned flags = 0;
  std::span<const double> rows;
};

bool is_sim(int s) { return s >= kFxgSim0 && s < kFxgSim0 + static_cast<int>(kFxgSimSlots); }

/// One pass list (the graph, or a simulation's init / step program). A graph
/// pass writes the colour / scratch slots; a simulation pass writes only the
/// simulation's own slots.
std::optional<std::vector<Pass>> parse(std::span<const double> g, std::size_t mats, bool simProgram, std::array<bool, kFxgSlots>& used,
                                       bool& needsDepth, std::string& why) {
  std::vector<Pass> passes;
  for (std::size_t i = 0; i + kHeader <= g.size();) {
    Pass p;
    p.op = static_cast<int>(g[i]);
    p.argValue = g[i + 1];
    p.arg = static_cast<int>(g[i + 1]);
    p.out = static_cast<int>(g[i + 2]);
    for (std::size_t k = 0; k < 4; ++k) p.in.at(k) = static_cast<int>(g[i + 3 + k]);
    p.blend = blend_of(g[i + 7]);
    p.flags = static_cast<unsigned>(std::max(0.0, g[i + 8]));
    const auto nrows = static_cast<std::size_t>(std::max(0.0, g[i + 9]));
    if (nrows > kFxgRows || i + kHeader + nrows * 4 > g.size()) {
      why = "fx-graph: a pass's rows run past the graph";
      return std::nullopt;
    }
    p.rows = g.subspan(i + kHeader, nrows * 4);
    i += kHeader + nrows * 4;
    const auto writable = [&](int s) { return simProgram ? is_sim(s) : (s >= kFxgA && s < kFxgMap) || s == kFxgStrip; };
    if (!writable(p.out) || p.op < kOpShader || p.op > kOpField || (p.op == kOpShader && (p.arg < 0 || static_cast<std::size_t>(p.arg) >= mats))) {
      why = "fx-graph: a malformed pass";
      return std::nullopt;
    }
    for (int s : p.in) {
      if (s < -1 || s >= kFxgSlots) {
        why = "fx-graph: an input slot out of range";
        return std::nullopt;
      }
      if (s == p.out) {
        why = "fx-graph: a pass reads the slot it writes";
        return std::nullopt;
      }
      if (s >= 0) used.at(static_cast<std::size_t>(s)) = true;
    }
    used.at(static_cast<std::size_t>(p.out)) = true;
    if ((p.flags & kFlagDepth) != 0) needsDepth = true;
    passes.push_back(p);
  }
  return passes;
}

/// X2: what a simulation's state holds — the frame it has reached (−1 =
/// nothing yet), what it was started with, and its checkpoints (frames).
struct SimRec {
  double hash = 0;
  std::uint32_t w = 0;
  std::uint32_t h = 0;
  int frame = -1;
  std::set<int> checkpoints;
};
/// The render thread is the only caller (as fx_graph_wgsl's cache).
std::unordered_map<std::string, SimRec>& sims() {
  static std::unordered_map<std::string, SimRec> m;
  if (m.size() > 256) m.clear();  // simulations come and go over a session: bounded
  return m;
}

void copy_target(PassContext& ctx, const RenderTarget& from, const RenderTarget& to) {
  wgpu::TexelCopyTextureInfo a{};
  a.texture = from.texture;
  wgpu::TexelCopyTextureInfo b{};
  b.texture = to.texture;
  const wgpu::Extent3D size{std::min(from.width, to.width), std::min(from.height, to.height), 1};
  ctx.dev.encoder().CopyTextureToTexture(&a, &b, &size);
}

}  // namespace

const std::string& fx_graph_wgsl(std::string_view shader) {
  // The render thread is the only caller (as depth_wgsl in effect_chain.cpp).
  static std::unordered_map<std::string, std::string> cache;
  auto it = cache.find(std::string(shader));
  if (it == cache.end()) {
    const std::string body = builtin_wgsl(shader);
    it = cache.emplace(std::string(shader), body.empty() ? std::string() : builtin_wgsl("fxx-prelude") + body).first;
  }
  return it->second;
}

std::optional<FxGraphResult> run_fx_graph(PassContext& ctx, const Fx& fx, const FxGraphIO& io, std::string& why) {
  const ViewportState& vp = ctx.viewport;
  const std::uint32_t pw = vp.pixelWidth;
  const std::uint32_t ph = vp.pixelHeight;
  const auto mats = split(fx.text("mats"));
  const int outSlot = static_cast<int>(fx.num("out", -1));

  // Which slots the graph touches (to resolve maps, and to refuse a bad graph up front).
  std::array<bool, kFxgSlots> used{};
  bool needsDepth = false;
  const std::optional<std::vector<Pass>> parsed = parse(fx.nums("g"), mats.size(), false, used, needsDepth, why);
  if (!parsed) return std::nullopt;
  const std::vector<Pass>& passes = *parsed;
  if (passes.empty() || outSlot < kFxgA || outSlot >= kFxgMap) {  // the result is a full-size colour slot
    why = "fx-graph: no passes or no result slot";
    return std::nullopt;
  }
  // X2: a simulation's init and step programs.
  const std::string_view simKey = fx.text("simKey");
  std::vector<Pass> simInit;
  std::vector<Pass> simStep;
  if (!simKey.empty()) {
    auto a = parse(fx.nums("simInit"), mats.size(), true, used, needsDepth, why);
    auto b = parse(fx.nums("simStep"), mats.size(), true, used, needsDepth, why);
    if (!a || !b || a->empty() || b->empty()) {
      if (why.empty()) why = "fx-graph: a simulation needs an init and a step program";
      return std::nullopt;
    }
    simInit = std::move(*a);
    simStep = std::move(*b);
  }

  // Slots → targets.
  std::array<Slot, kFxgSlots> slot{};
  const Slot full{{}, {}, pw, ph, 1};
  slot[kFxgIn] = full;
  slot[kFxgIn].tex = io.in;
  for (std::size_t k = 0; k < 3; ++k) {
    slot.at(kFxgA + k) = full;
    slot.at(kFxgA + k).name = io.free.at(k);
  }
  if (slot[kFxgC].name.empty()) slot[kFxgC].name = kFxAux[3];
  for (std::size_t k = 0; k < 4; ++k) {
    slot.at(kFxgX0 + k) = full;
    slot.at(kFxgX0 + k).name = kFxAux.at(k);
  }
  for (std::size_t k = 0; k < 2; ++k) {
    slot.at(kFxgH0 + k) = {kHalf.at(k), {}, std::max(1U, pw / 2), std::max(1U, ph / 2), 0.5};
    slot.at(kFxgQ0 + k) = {kQuarter.at(k), {}, std::max(1U, pw / 4), std::max(1U, ph / 4), 0.25};
  }
  for (std::size_t k = 0; k < 3; ++k) {
    if (slot.at(kFxgA + k).name.empty()) {
      if (used.at(kFxgA + k)) {
        why = "fx-graph: the pool has too few targets";
        return std::nullopt;
      }
    }
  }
  // MAP slots: each map is drawn into the matte target, which the next map
  // overwrites — with several, all but the last are copied out first.
  std::vector<int> mapsUsed;
  for (int s = kFxgMap; s < kFxgMap + 3; ++s) {
    if (used.at(static_cast<std::size_t>(s))) mapsUsed.push_back(s);
  }
  static constexpr std::array<std::string_view, 3> kMapIds = {"mapLayerId", "mapLayerId2", "mapLayerId3"};
  for (std::size_t k = 0; k < mapsUsed.size(); ++k) {
    const int s = mapsUsed[k];
    const std::string_view id = fx.text(kMapIds.at(static_cast<std::size_t>(s - kFxgMap)));
    TexRef t = io.mapLayer && !id.empty() ? io.mapLayer(id) : TexRef{};
    slot.at(static_cast<std::size_t>(s)) = full;
    if (!t) {
      // No such layer (or the pool holds the matte target): the map reads transparent black.
      slot.at(static_cast<std::size_t>(s)).tex = TexRef{};
      continue;
    }
    if (k + 1 < mapsUsed.size()) {
      const std::string_view keep = kFxAux.at(3 - k);
      Commands c;
      emit_textured(ctx, c, io.mvp, Color::white(), 1, Blend::none, t, ctx.linear_clamp(), io.targetUv, kIdentityColor, true);
      ctx.draw_into(keep, c, true);
      t = ctx.target(keep)->tex();
    }
    slot.at(static_cast<std::size_t>(s)).tex = t;
  }
  slot[kFxgData] = full;
  slot[kFxgData].tex = fx.text("dataKey").empty() ? TexRef{} : ctx.texture(fx.text("dataKey"));
  if (used[kFxgData] && !slot[kFxgData].tex) {
    why = "fx-graph: the effect's data texture did not arrive";
    return std::nullopt;
  }
  static constexpr std::array<std::string_view, 2> kMaskKeys = {"maskKey0", "maskKey1"};
  for (std::size_t k = 0; k < 2; ++k) {
    Slot& sl = slot.at(kFxgMask0 + k);
    sl = full;
    if (!used.at(kFxgMask0 + k)) continue;
    const std::string_view key = fx.text(kMaskKeys.at(k));
    sl.tex = io.maskInto && !key.empty() ? io.maskInto(key, kFxMaskTargets.at(k)) : TexRef{};
    // A mask the effect cannot do without (fx_graph_writer Graph::mask required — an Object Matte
    // card's stored frame): missing, the entry runs nothing and the chain keeps its input, rather
    // than reading transparent black and cutting the whole layer away. Recorded on the frame.
    if (!sl.tex && fx.flag(k == 0 ? "maskRequired0" : "maskRequired1")) {
      why = "fx-graph: the effect's matte texture did not arrive (the layer shows uncut)";
      return std::nullopt;
    }
  }
  slot[kFxgStrip] = {kFxHist, {}, 256, 1, 1};
  // Program X1: each time tap drawn (as a map layer) and parked in its own target.
  static constexpr std::array<std::string_view, 4> kTapIds = {"tapId0", "tapId1", "tapId2", "tapId3"};
  for (std::size_t k = 0; k < 4; ++k) {
    Slot& sl = slot.at(kFxgTap0 + k);
    sl = full;
    if (!used.at(kFxgTap0 + k)) continue;
    const std::string_view id = fx.text(kTapIds.at(k));
    const TexRef t = io.mapLayer && !id.empty() ? io.mapLayer(id) : TexRef{};
    if (!t) continue;  // the layer has no picture then (before its in point): transparent
    Commands c;
    emit_textured(ctx, c, io.mvp, Color::white(), 1, Blend::none, t, ctx.linear_clamp(), io.targetUv, kIdentityColor, true);
    ctx.draw_into(kFxTapTargets.at(k), c, true);
    sl.tex = ctx.target(kFxTapTargets.at(k))->tex();
  }
  // X2: the simulation's slots — persistent device targets at the
  // simulation's resolution, named after the simulation (they outlive the frame).
  std::array<std::string, kFxgSimSlots> simNames{};
  const auto simW = static_cast<std::uint32_t>(std::clamp(fx.num("simW", 256), 8.0, 2048.0));
  const auto simH = static_cast<std::uint32_t>(std::clamp(fx.num("simH", 256), 8.0, 2048.0));
  bool simFresh = false;  // a state slot's target was (re)created: the simulation starts over
  if (!simKey.empty()) {
    for (std::size_t k = 0; k < kFxgSimSlots; ++k) {
      if (!used.at(kFxgSim0 + k)) continue;
      simNames.at(k) = std::string(simKey) + "/s" + std::to_string(k);
      bool created = false;
      RenderTarget& t = ctx.dev.target(simNames.at(k), simW, simH, wgpu::TextureFormat::RGBA16Float, 1, false, &created);
      ctx.targets.insert_or_assign(simNames.at(k), &t);
      simFresh = simFresh || created;
      slot.at(kFxgSim0 + k) = {simNames.at(k), {}, simW, simH, static_cast<double>(simW) / std::max(1U, pw)};
    }
  }
  // Stream D: the scene under the layer (read only; transparent black when the
  // composition pass did not copy it for this chain).
  slot[kFxgBackdrop] = full;
  if (used[kFxgBackdrop] && io.backdrop) slot[kFxgBackdrop].tex = io.backdrop();
  TexRef depth;
  if (needsDepth) {
    depth = io.depth ? io.depth() : TexRef{};
    if (!depth) {
      why = "fx-graph: the effect reads the scene depth, which this frame has none of";
      return std::nullopt;
    }
  }

  // An empty read-only slot (a missing map / mask) reads transparent black: the
  // LUT strip, cleared (only the auto-colour entries use it, inside their own entry).
  TexRef blank;
  const auto texOf = [&](int s) -> TexRef {
    if (s < 0) return io.in;
    const Slot& sl = slot.at(static_cast<std::size_t>(s));
    if (!sl.name.empty()) {
      RenderTarget* t = ctx.target(sl.name);
      return t != nullptr ? t->tex() : TexRef{};
    }
    if (sl.tex) return sl.tex;
    if (!blank) {
      ctx.draw_into_sized(kFxLut, Commands{}, true, 256, 1);
      blank = ctx.target(kFxLut)->tex();
    }
    return blank;
  };

  static constexpr std::array<LayoutEntry, 6> kLayout{{{0, BindingType::uniform, kStageVertex | kStageFragment},
                                                       {1, BindingType::texture, kStageFragment},
                                                       {2, BindingType::sampler, kStageFragment},
                                                       {3, BindingType::texture, kStageFragment},
                                                       {4, BindingType::texture, kStageFragment},
                                                       {5, BindingType::texture, kStageFragment}}};
  static constexpr std::array<LayoutEntry, 7> kDepthLayout{{{0, BindingType::uniform, kStageVertex | kStageFragment},
                                                            {1, BindingType::texture, kStageFragment},
                                                            {2, BindingType::sampler, kStageFragment},
                                                            {3, BindingType::texture, kStageFragment},
                                                            {4, BindingType::texture, kStageFragment},
                                                            {5, BindingType::texture, kStageFragment},
                                                            {6, BindingType::unfilterable, kStageFragment}}};
  const auto materialOf = [&](const Pass& p) -> std::optional<Mat> {
    const std::string_view shader = p.op == kOpField ? kFieldCopy : mats.at(static_cast<std::size_t>(p.arg));
    const std::string& wgsl = fx_graph_wgsl(shader);
    if (wgsl.empty()) {
      why = "fx-graph: no shader named \"" + std::string(shader) + "\"";
      return std::nullopt;
    }
    return (p.flags & kFlagDepth) != 0 ? ctx.dev.dynamic_material("fxx:" + std::string(shader), wgsl, kDepthLayout)
                                       : ctx.dev.dynamic_material("fxx:" + std::string(shader), wgsl, kLayout);
  };
  // Every shader pass's pipeline is validated before anything is drawn: a bad
  // shader (or layout) skips this effect, never the frame (device.hpp pipeline_error).
  for (const std::vector<Pass>* list : std::array<const std::vector<Pass>*, 3>{&passes, &simInit, &simStep}) {
    for (const Pass& p : *list) {
      if (p.op != kOpShader && p.op != kOpField) continue;
      const std::optional<Mat> m = materialOf(p);
      if (!m) return std::nullopt;
      const RenderTarget* target = ctx.target(slot.at(static_cast<std::size_t>(p.out)).name);
      if (target == nullptr) {
        why = "fx-graph: a pass's target is missing";
        return std::nullopt;
      }
      if (const std::string& err = ctx.dev.pipeline_error(*m, p.blend, target->format); !err.empty()) {
        const std::string_view name = p.op == kOpField ? kFieldCopy : mats.at(static_cast<std::size_t>(p.arg));
        why = "fx-graph: " + std::string(name) + ": " + err.substr(0, 400);
        return std::nullopt;
      }
    }
  }
  const double lw = std::max(1.0, fx.num("lw", 1));
  const double lh = std::max(1.0, fx.num("lh", 1));
  const double texPerPxX = io.screenSpace ? io.fxBox.width * io.targetUv.width * pw / lw : io.kx;
  const double texPerPxY = io.screenSpace ? io.fxBox.height * io.targetUv.height * ph / lh : io.ky;

  /// One pass; `simRow` (a simulation pass): its row 14 — (sim time, step dt, frame, substep).
  const auto runPass = [&](const Pass& p, const std::optional<Vec4>& simRow) {
    const Slot& out = slot.at(static_cast<std::size_t>(p.out));
    Commands cmds;
    if (p.op == kOpShader) {
      const bool readsDepth = (p.flags & kFlagDepth) != 0;
      const Mat m = *materialOf(p);
      std::array<Vec4, kFxgRows + 2> rows{};
      for (std::size_t r = 0; r * 4 < p.rows.size(); ++r) rows.at(r) = {p.rows[r * 4], p.rows[r * 4 + 1], p.rows[r * 4 + 2], p.rows[r * 4 + 3]};
      if (simRow) rows[kFxgRows - 1] = *simRow;
      rows[kFxgRows] = {lw, lh, static_cast<double>(out.w), static_cast<double>(out.h)};
      rows[kFxgRows + 1] = io.screenSpace ? Vec4{io.world.x, io.world.y, io.world.width, io.world.height} : Vec4{0, 0, 0, 0};
      DrawItem& it = cmds.add(m, p.blend, pack_fx_block(ctx.packer(), io.mvp, io.targetUv, rows, io.fxBox));
      it.texture = texOf(p.in[0]);
      it.sampler = ctx.linear_clamp();
      it.mask = texOf(p.in[1]);
      it.origin = texOf(p.in[2]);
      it.bind(5, texOf(p.in[3]));
      if (readsDepth) it.bind(6, depth);
    } else if (p.op == kOpBlurX || p.op == kOpBlurY) {
      // blur.wgsl: the radius IS sigma, in texels of the slot drawn into.
      const double sigma = std::max(0.0, p.argValue) * out.scale * (p.op == kOpBlurX ? texPerPxX : texPerPxY);
      const double dx = p.op == kOpBlurX ? 1.0 / out.w : 0.0;
      const double dy = p.op == kOpBlurY ? 1.0 / out.h : 0.0;
      DrawItem& it = cmds.add(Mat::BLUR_MATERIAL, p.blend, pack_blur(ctx.packer(), io.mvp, io.targetUv, dx, dy, sigma));
      it.texture = texOf(p.in[0]);
      it.sampler = ctx.linear_clamp();
    } else if (p.op == kOpField) {
      // E4's jump-flood field of in0's alpha (fx_distance.hpp), exact to `arg`
      // layer px: r = signed distance to the 1/2-contour in buffer texels
      // (+ outside), g = the alpha. Copied raw into the slot; no field (an
      // empty input) leaves the slot cleared.
      const double rangeTex = std::max(1.0, std::max(0.0, p.argValue) * std::max(texPerPxX, texPerPxY));
      const DistanceField f = distance_field(ctx, texOf(p.in[0]), rangeTex, 0);
      const std::optional<Mat> copy = materialOf(p);  // validated up front
      if (f.tex && copy.has_value()) {
        const std::array<Vec4, kFxgRows + 2> none{};
        DrawItem& it = cmds.add(copy.value(), Blend::none, pack_fx_block(ctx.packer(), io.mvp, io.targetUv, none, io.fxBox));
        it.texture = f.tex;
        it.sampler = ctx.nearest_clamp();
        it.mask = f.tex;
        it.origin = f.tex;
        it.bind(5, f.tex);
      }
    } else {
      emit_textured(ctx, cmds, io.mvp, Color::white(), 1, p.blend, texOf(p.in[0]), ctx.linear_clamp(), io.targetUv, kIdentityColor, true);
    }
    const bool clear = (p.flags & kFlagKeep) == 0;
    if (out.w == pw && out.h == ph) ctx.draw_into(out.name, cmds, clear);
    else ctx.draw_into_sized(out.name, cmds, clear, out.w, out.h);
  };

  // X2: bring the simulation to this frame — from where it is, from the
  // nearest checkpoint at or before it, or from its init — stepping its program
  // `sub` times a frame. Every frame of the simulation is the same function of
  // its controls, reached in any order.
  if (!simKey.empty()) {
    const double hash = fx.num("simHash");
    const int target = static_cast<int>(std::max(0.0, std::floor(fx.num("simFrame") + 1e-6)));
    const int sub = static_cast<int>(std::clamp(fx.num("simSub", 1), 1.0, 64.0));
    const int every = static_cast<int>(std::clamp(fx.num("simEvery", 30), 5.0, 1000.0));
    const double fps = std::max(1.0, fx.num("simFps", 30));
    std::vector<std::size_t> state;
    for (const double s : fx.nums("simState")) {
      if (s >= 0 && s < kFxgSimSlots && !simNames.at(static_cast<std::size_t>(s)).empty()) state.push_back(static_cast<std::size_t>(s));
    }
    SimRec& rec = sims()[std::string(simKey)];
    if (simFresh || rec.hash != hash || rec.w != simW || rec.h != simH) rec = SimRec{hash, simW, simH, -1, {}};
    // A checkpoint whose targets the device collected is gone.
    const auto ckName = [&](int frame, std::size_t k) { return std::string(simKey) + "/ck" + std::to_string(frame) + "/" + std::to_string(k); };
    for (auto it = rec.checkpoints.begin(); it != rec.checkpoints.end();) {
      bool lost = false;
      for (const std::size_t k : state) {
        bool created = false;
        (void)ctx.dev.target(ckName(*it, k), simW, simH, wgpu::TextureFormat::RGBA16Float, 1, false, &created);
        lost = lost || created;
      }
      it = lost ? rec.checkpoints.erase(it) : std::next(it);
    }
    if (rec.frame > target || rec.frame < 0) {
      const auto ck = rec.checkpoints.upper_bound(target);
      if (ck != rec.checkpoints.begin()) {
        const int from = *std::prev(ck);
        for (const std::size_t k : state) {
          RenderTarget& src = ctx.dev.target(ckName(from, k), simW, simH, wgpu::TextureFormat::RGBA16Float, 1, false);
          copy_target(ctx, src, *ctx.target(simNames.at(k)));
        }
        rec.frame = from;
      } else {
        for (const Pass& p : simInit) runPass(p, Vec4{0, 1 / (fps * sub), 0, 0});
        rec.frame = 0;
      }
    }
    int stepped = 0;
    while (rec.frame < target && stepped < kMaxStepFrames) {
      for (int s = 0; s < sub; ++s) {
        const Vec4 row{(rec.frame + static_cast<double>(s) / sub) / fps, 1 / (fps * sub), static_cast<double>(rec.frame), static_cast<double>(s)};
        for (const Pass& p : simStep) runPass(p, row);
      }
      ++rec.frame;
      ++stepped;
      if (rec.frame % every == 0 && rec.checkpoints.size() < kMaxCheckpoints && !rec.checkpoints.contains(rec.frame)) {
        for (const std::size_t k : state) {
          RenderTarget& dst = ctx.dev.target(ckName(rec.frame, k), simW, simH, wgpu::TextureFormat::RGBA16Float, 1, false);
          copy_target(ctx, *ctx.target(simNames.at(k)), dst);
        }
        rec.checkpoints.insert(rec.frame);
      }
    }
  }

  for (const Pass& p : passes) runPass(p, std::nullopt);

  // The result must live in the chain's pool: copy it to a free target otherwise.
  const Slot& res = slot.at(static_cast<std::size_t>(outSlot));
  const bool inPool = std::ranges::find(io.free, res.name) != io.free.end();
  if (inPool) return FxGraphResult{ctx.target(res.name)->tex(), res.name};
  const std::string_view dest = io.free[0];
  Commands c;
  emit_textured(ctx, c, io.mvp, Color::white(), 1, Blend::none, texOf(outSlot), ctx.linear_clamp(), io.targetUv, kIdentityColor, true);
  ctx.draw_into(dest, c, true);
  return FxGraphResult{ctx.target(dest)->tex(), dest};
}

}  // namespace premation::rg
