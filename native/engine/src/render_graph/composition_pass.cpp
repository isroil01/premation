// CompositionPass — rendergraph/passes/CompositionPass.ts, ported branch by
// branch in the same order (the per-layer order of operations is documented at
// the top of the TS file and holds here unchanged):
//
//   renderList → processRenderable:
//     matte source (skipped) → quad-gain fold → isolated precomp → track matte
//     → adjustment layer → cull → backdrop blur / glass → advanced blend /
//     preserve transparency → direct draw | offscreen route (motion blur +
//     effect chain) → composite
//
// What is not ported yet is refused up front by support.cpp (the frame is
// reported `not-ported`), so every branch below is exercised by a golden scene.
#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "effect_chain.hpp"
#include "effect_stats.hpp"
#include "fx_distance.hpp"
#include "fx_keys.hpp"
#include "passes.hpp"
#include "render_context.hpp"
#include "scene_depth.hpp"
#include "threed.hpp"

namespace premation::rg {
namespace {

bool is_solid_kind(api::RenderableKind k) {
  return k == api::RenderableKind::rect || k == api::RenderableKind::path || k == api::RenderableKind::group;
}
bool is_textured_kind(api::RenderableKind k) {
  return k == api::RenderableKind::image || k == api::RenderableKind::video || k == api::RenderableKind::text;
}

SolidShape to_solid_shape(const std::optional<api::RenderSdf>& sdf) {
  if (!sdf) return {};
  if (sdf->shape == api::RenderSdfShape::ellipse) return {2, 0, sdf->width, sdf->height};
  const double r = std::max(0.0, std::min(sdf->radius_px, std::min(sdf->width, sdf->height) / 2));
  return {1, r, sdf->width, sdf->height};
}

ColorTransform color_transform(const std::optional<api::RenderColorMatrix>& cm) {
  ColorTransform ct;
  if (!cm) return ct;
  for (std::size_t i = 0; i < 9 && i < cm->m.size(); ++i) ct.m.at(i) = cm->m[i];
  for (std::size_t i = 0; i < 3 && i < cm->offset.size(); ++i) ct.offset.at(i) = cm->offset[i];
  return ct;
}

Blend blend_of(api::RenderBlendMode b) { return static_cast<Blend>(static_cast<std::uint32_t>(b)); }

Color color_or_white(const api::Renderable& r) { return r.color ? color_of(*r.color) : Color::white(); }
Rect uv_or_full(const api::Renderable& r) { return r.uv_rect ? rect_of(*r.uv_rect) : Rect{0, 0, 1, 1}; }

}  // namespace

// fx_keys.hpp (KeyMix lives there: the 3D surface path keys its chains the same way).
std::uint64_t chain_content_key(const PassContext& ctx, const api::Renderable& r, double opacity,
                                std::optional<std::array<double, 2>> placePhase) {
  if (r.precomp || !r.precomp_children.empty() || r.deformed_mesh) return 0;
  const bool translationFree = placePhase.has_value();
  KeyMix k;
  // P8b: a key without the layer's place on screen but its sub-pixel phase — the slot keeps where it was drawn.
  k.u64(translationFree ? 0x7038625ULL : 0);
  if (placePhase) {
    k.f64((*placePhase)[0]);
    k.f64((*placePhase)[1]);
  }
  k.u64(static_cast<std::uint64_t>(r.kind));
  k.u64(static_cast<std::uint64_t>(r.blend));
  k.u64(static_cast<std::uint64_t>(r.sampling));
  for (const std::optional<std::string>* key : {&r.texture_key, &r.mask_texture_key, &r.lut_texture_key}) {
    if (!*key) {
      k.u64(0);
      continue;
    }
    const ResolvedBlob rb = ctx.textures.resolve(**key);
    if (rb.hash.empty()) return 0;
    k.str(rb.hash);
  }
  for (std::size_t i = 0; i < r.model_matrix.size(); ++i) {
    if (translationFree && (i == 6 || i == 7)) continue;
    k.f64(r.model_matrix[i]);
  }
  if (r.uv_rect) {
    k.f64(r.uv_rect->x);
    k.f64(r.uv_rect->y);
    k.f64(r.uv_rect->width);
    k.f64(r.uv_rect->height);
  }
  if (r.color) {
    k.f64(r.color->r);
    k.f64(r.color->g);
    k.f64(r.color->b);
    k.f64(r.color->a);
  }
  if (r.color_matrix) {
    for (const double v : r.color_matrix->m) k.f64(v);
    for (const double v : r.color_matrix->offset) k.f64(v);
  }
  if (r.sdf) {
    k.u64(static_cast<std::uint64_t>(r.sdf->shape));
    k.f64(r.sdf->width);
    k.f64(r.sdf->height);
    k.f64(r.sdf->radius_px);
  }
  k.f64(opacity);
  for (const auto& s : r.motion_samples) {
    for (const double v : s.model_matrix) k.f64(v);
    k.f64(s.opacity);
  }
  k.u64((std::uint64_t{ctx.viewport.pixelWidth} << 32U) | ctx.viewport.pixelHeight);
  for (std::size_t i = 0; i < 9; ++i) {
    if (translationFree && (i == 6 || i == 7)) continue;  // a pan is a translation too
    k.f64(ctx.viewport.viewProjection[i]);
  }
  return k.value();
}

namespace {

/// P8b: a 2D layer's chain run in a buffer placement of its own. The layer is
/// drawn at its own sub-pixel phase — and, when the chain's reach would leave
/// the buffer, moved inside it by whole pixels — under a view shifted by that
/// offset (ViewShift: every position the chain reads moves with it). The
/// result is then a function of the layer's content and phase, not of where
/// it is on screen: a layer that only moves by WHOLE pixels reuses it (AE runs
/// effects in layer space for the same reason), composited where the layer is
/// by a whole-pixel shift — an exact copy. (Drawing on a whole pixel and
/// shifting the result back by the fraction let every move reuse the chain,
/// but the bilinear shift softened every effected layer on a fractional place,
/// static ones included: a centred title with an odd height lost its edges.)
struct PixelSnap {
  bool on = false;
  double px = 0;  // the layer origin on screen (viewport px, top-left origin)
  double py = 0;
  double bx = 0;  // where it is drawn in the chain's buffer: px's phase (kPhaseSteps) + whole px
  double by = 0;
};

/// The phase grid of a buffer placement: 1/1024 px — far under a visible
/// shift, and a power of two, so a placement and its whole-pixel moves are
/// exact doubles (equal phases key and compare equal).
constexpr double kPhaseSteps = 1024;

double phase_of(double v) noexcept { return v - std::floor(v); }

PxBox unite_box(const PxBox& a, const PxBox& b) noexcept {
  return {std::min(a.x0, b.x0), std::min(a.y0, b.y0), std::max(a.x1, b.x1), std::max(a.y1, b.y1)};
}

/// Where `r`'s chain can draw (fx_bounds), from its drawn box: every pass and the result.
std::optional<PxBox> chain_reach(const PassContext& ctx, const api::Renderable& r) {
  const double pw = ctx.viewport.pixelWidth;
  const double ph = ctx.viewport.pixelHeight;
  const std::optional<PxBox> in = content_box(r, ctx.viewport.viewProjection, pw, ph);
  if (!in) return std::nullopt;
  const Rect world = ctx.viewport.visibleWorldRect;
  const FxBoundsView view{world.width > 0 ? pw / world.width : 1, world.height > 0 ? ph / world.height : 1};
  PxBox box = *in;
  PxBox all = *in;
  for (const api::RenderEffect& e : r.effects) {
    const std::optional<FxReach> reach = fx_reach(e, box, view);
    if (!reach) return std::nullopt;
    all = unite_box(unite_box(all, reach->passes), reach->out);
    box = reach->out;
  }
  return all;
}

PixelSnap pixel_snap(const PassContext& ctx, const api::Renderable& r) {
  PixelSnap s;
  if (r.precomp || !r.precomp_children.empty() || r.deformed_mesh || r.motion_samples.size() > 1) return s;
  const Mat3& vp = ctx.viewport.viewProjection;
  // A 2D view is scale + translate (Camera2D): anything else is not snapped.
  if (vp[1] != 0 || vp[3] != 0 || vp[0] == 0 || vp[4] == 0) return s;
  const double pw = ctx.viewport.pixelWidth;
  const double ph = ctx.viewport.pixelHeight;
  if (pw <= 0 || ph <= 0) return s;
  const Vec2 c = transform_point(mul(vp, mat3_of(r.model_matrix)), {0, 0});
  s.px = (c.x + 1) * 0.5 * pw;
  s.py = (1 - c.y) * 0.5 * ph;
  if (!std::isfinite(s.px) || !std::isfinite(s.py)) return s;
  s.bx = std::round(s.px * kPhaseSteps) / kPhaseSteps;
  s.by = std::round(s.py * kPhaseSteps) / kPhaseSteps;
  // A reach that would leave the buffer is moved inside it (when it fits), so
  // the kept result is whole and may be moved anywhere later. (Whatever the
  // grow-bounds switch: the result must not depend on it.)
  {
    if (const std::optional<PxBox> reach = chain_reach(ctx, r)) {
      const double ox = s.bx - s.px;
      const double oy = s.by - s.py;
      const PxBox b{reach->x0 + ox, reach->y0 + oy, reach->x1 + ox, reach->y1 + oy};
      if (b.x1 - b.x0 <= pw - 2) {
        if (b.x0 < 1) s.bx += std::ceil(1 - b.x0);
        else if (b.x1 > pw - 1) s.bx -= std::ceil(b.x1 - (pw - 1));
      }
      if (b.y1 - b.y0 <= ph - 2) {
        if (b.y0 < 1) s.by += std::ceil(1 - b.y0);
        else if (b.y1 > ph - 1) s.by -= std::ceil(b.y1 - (ph - 1));
      }
    }
  }
  s.on = true;
  return s;
}

/// P8b: the pass context's view moved by (dx, dy) viewport px — what the
/// layer's draw and its chain see — and put back when the scope ends.
class ViewShift {
 public:
  ViewShift(PassContext& ctx, double dx, double dy) : ctx_(&ctx), saved_(ctx.viewport) {
    if (dx == 0 && dy == 0) return;
    ViewportState& v = ctx.viewport;
    v.viewProjection = mul(translation(2 * dx / v.pixelWidth, -2 * dy / v.pixelHeight), v.viewProjection);
    const double wx = v.visibleWorldRect.width / v.pixelWidth;  // world units a pixel
    const double wy = v.visibleWorldRect.height / v.pixelHeight;
    v.visibleWorldRect.x -= dx * wx;
    v.visibleWorldRect.y -= dy * wy;
    v.centerX -= dx * wx;
    v.centerY -= dy * wy;
  }
  ~ViewShift() { ctx_->viewport = saved_; }
  ViewShift(const ViewShift&) = delete;
  ViewShift& operator=(const ViewShift&) = delete;
  ViewShift(ViewShift&&) = delete;
  ViewShift& operator=(ViewShift&&) = delete;

 private:
  PassContext* ctx_;
  ViewportState saved_;
};

std::optional<PxBox> shifted(const std::optional<PxBox>& b, double dx, double dy) {
  if (!b) return std::nullopt;
  // A fractional move spreads the box's edge texels by one pixel.
  const double gx = dx != std::floor(dx) ? 1 : 0;
  const double gy = dy != std::floor(dy) ? 1 : 0;
  return PxBox{b->x0 + dx - gx, b->y0 + dy - gy, b->x1 + dx + gx, b->y1 + dy + gy};
}

bool inside_view(const std::optional<PxBox>& b, double pw, double ph) {
  return b && b->x0 >= 0 && b->y0 >= 0 && b->x1 <= pw && b->y1 <= ph;
}

}  // namespace

// fx_keys.hpp: the key of a layer's whole effect-chain RESULT (P8).
std::uint64_t layer_fx_key(const PassContext& ctx, const api::Renderable& r, std::uint64_t contentKey, double opacity) {
  if (contentKey == 0) return 0;
  KeyMix k;
  k.u64(contentKey);
  k.f64(opacity);
  // The renderer's own switches choose the chain's passes (distance fields, grow bounds).
  k.u64((ctx.fxFields ? 1U : 0U) | (ctx.fxBounds ? 2U : 0U));
  // … and the project's working precision and space its intermediates run in.
  const api::RenderView& view = ctx.file.view;
  k.u64((std::uint64_t{view.bit_depth} << 8U) | (view.float16_textures ? 1U : 0U) | (view.float32_textures ? 2U : 0U));
  k.u64(static_cast<std::uint64_t>(view.working_space));
  for (const api::RenderEffect& e : r.effects) {
    if (e.type == "native-plugin") return 0;
    k.str(e.type);
    for (const api::RenderEffectParam& p : e.params) {
      if (!p.text.empty() || !p.texts.empty()) return 0;
      k.str(p.name);
      k.u64(static_cast<std::uint64_t>(p.kind));
      k.f64(p.number);
      k.u64(p.numbers.size());
      for (const double v : p.numbers) k.f64(v);
    }
  }
  return k.value();
}

namespace {

/// P8: finished effect-chain outputs of layers whose input and parameters did
/// not change, kept across frames in persistent device targets (`<prefix><i>`,
/// rgba16float at the chain buffer's size). A static glowing title or a textured
/// backdrop under moving layers pays its chain once, not every frame. A slot is
/// valid while its target lives: the device pool collects targets idle 120
/// frames, and a re-created one is reported `created` (as FxCache's distance
/// fields). E1: a second instance holds the 3D surfaces' chains (threed.cpp),
/// whose buffers are layer-sized.
class LayerFxCache {
 public:
  struct Slot {
    std::string name;
    std::uint64_t key = 0;
    std::uint32_t w = 0;
    std::uint32_t h = 0;
    std::uint64_t used = 0;
    std::optional<PxBox> covered;  // the chain result's reach (ChainResult::covered)
    /// P8b: where the layer's origin was drawn in the buffer (PixelSnap bx, by), for a translation-free key.
    std::optional<std::array<double, 2>> at;
    /// P8b: the whole result was on screen, so it may be moved (else reused in place only).
    bool movable = false;
    wgpu::TextureFormat format = wgpu::TextureFormat::RGBA16Float;  // the chain target's: a lossless copy
  };
  LayerFxCache(std::string_view prefix, std::size_t slots) : slots_(slots) {
    for (std::size_t i = 0; i < slots; ++i) slots_[i].name = std::string(prefix) + std::to_string(i);
  }
  [[nodiscard]] Slot* find(std::uint64_t key, std::uint32_t w, std::uint32_t h) noexcept {
    for (Slot& s : slots_) {
      if (s.key == key && s.w == w && s.h == h) return &s;
    }
    return nullptr;
  }
  /// The free or least recently used slot — never one this frame read or
  /// wrote (its texture may still be composited this frame); nullptr if all were.
  Slot* claim(std::uint64_t key, std::uint32_t w, std::uint32_t h, std::uint64_t frame) noexcept {
    Slot* pick = nullptr;
    for (Slot& s : slots_) {
      if (s.key == 0) { pick = &s; break; }
      if (s.used != frame && (pick == nullptr || s.used < pick->used)) pick = &s;
    }
    if (pick == nullptr) return nullptr;
    pick->key = key;
    pick->w = w;
    pick->h = h;
    pick->used = frame;
    pick->at.reset();
    pick->movable = false;
    return pick;
  }
  static void forget(Slot& s) noexcept { s.key = 0; }
  /// Whether `layer`'s chain key is the one it had last time (a layer whose
  /// chain changes every frame — animated — is never stored: the copy into a
  /// slot would be paid every frame and never read).
  bool steady(const std::string& layer, std::uint64_t key) {
    if (last_.size() > 4096) last_.clear();  // layers come and go over a session: bounded
    auto [it, fresh] = last_.try_emplace(layer, key);
    if (fresh) return false;
    const bool same = it->second == key;
    it->second = key;
    return same;
  }

 private:
  std::vector<Slot> slots_;
  std::unordered_map<std::string, std::uint64_t> last_;
};

/// The VRAM the precomp slots past the four declared ones may hold together
/// (each an MSAA colour pair + depth: ~116 MB at 1080p in rgba16float, so ~9
/// more levels; ~2 at 4K). Past it a deeper precomp draws inline.
constexpr std::uint64_t kExtraPrecompTargetBudget = std::uint64_t{1} << 30U;

/// Bytes a texel of `f` takes (device.cpp bytes_per_texel).
std::uint64_t texel_bytes(wgpu::TextureFormat f) noexcept {
  switch (f) {
    case wgpu::TextureFormat::R8Unorm: return 1;
    case wgpu::TextureFormat::RGBA16Float: return 8;
    case wgpu::TextureFormat::RGBA32Float: return 16;
    default: return 4;
  }
}

/// Byte-exact content into a key, eight bytes a step.
void mix_bytes(KeyMix& k, std::span<const std::uint8_t> b) noexcept {
  k.u64(b.size());
  std::size_t i = 0;
  for (; i + 8 <= b.size(); i += 8) {
    std::uint64_t v = 0;
    std::memcpy(&v, b.subspan(i, 8).data(), 8);
    k.u64(v);
  }
  std::uint64_t tail = 0;
  if (i < b.size()) std::memcpy(&tail, b.subspan(i).data(), b.size() - i);
  k.u64(tail);
}

/// Finished isolated-precomp images kept across frames, keyed by a hash of
/// everything their pixels depend on (CompositionPass::precomp_key): a static
/// nested comp is drawn once, then composited from here. Entries name
/// persistent single-sample Device targets (`precomp-cache-<n>`) holding an
/// exact texel copy of the precomp target's resolved image (same format), and
/// fit a byte budget, least recently used out first. A target the Device pool
/// collected (idle 120 frames) is reported `created` and the entry dropped.
/// Render thread only.
class PrecompCache {
 public:
  /// The kept images' budget: ~15 precomps at 1080p in rgba16float, 3 at 4K.
  static constexpr std::uint64_t kBudgetBytes = std::uint64_t{256} << 20U;
  /// Entries idle this long go (the Device pool would collect their targets anyway).
  static constexpr std::uint64_t kMaxIdle = 120;

  struct Entry {
    std::string name;
    std::uint64_t key = 0;
    std::uint32_t w = 0;
    std::uint32_t h = 0;
    wgpu::TextureFormat format = wgpu::TextureFormat::RGBA16Float;
    std::uint64_t bytes = 0;
    std::uint64_t used = 0;  ///< the Device frame it was last read or written
  };

  [[nodiscard]] Entry* find(std::uint64_t key, std::uint32_t w, std::uint32_t h, wgpu::TextureFormat f) noexcept {
    for (Entry& e : entries_) {
      if (e.key == key && e.w == w && e.h == h && e.format == f) return &e;
    }
    return nullptr;
  }

  /// Whether precomp `who` (its id and variant) should be kept under `key`:
  /// the first time it is seen, or when its key held since last frame. One
  /// whose content changes every frame (animated) is not copied every frame
  /// for a result never read; it is kept again once it settles.
  bool worth_keeping(std::uint64_t who, std::uint64_t key) {
    if (last_.size() > 4096) last_.clear();  // precomps come and go over a session: bounded
    auto [it, fresh] = last_.try_emplace(who, key);
    if (fresh) return true;
    const bool same = it->second == key;
    it->second = key;
    return same;
  }

  /// An entry for `key` (w × h, `bytes`): a fresh one under the budget, the
  /// least recently used ones evicted for room — never one read or written
  /// this frame (its image may still be composited). nullptr when it cannot fit.
  Entry* claim(std::uint64_t key, std::uint32_t w, std::uint32_t h, wgpu::TextureFormat f, std::uint64_t bytes,
               std::uint64_t frame) {
    if (bytes == 0 || bytes > kBudgetBytes) return nullptr;
    std::uint64_t total = 0;
    for (const Entry& e : entries_) total += e.bytes;
    const auto victim = [&](bool sameShape) {
      Entry* pick = nullptr;
      for (Entry& e : entries_) {
        if (e.used == frame || (sameShape && (e.w != w || e.h != h || e.format != f))) continue;
        if (pick == nullptr || e.used < pick->used) pick = &e;
      }
      return pick;
    };
    if (total + bytes > kBudgetBytes) {
      // Over budget: a same-shaped victim is re-keyed in place (its target is reused as is).
      if (Entry* e = victim(true)) return rekey(*e, key, frame);
    }
    while (total + bytes > kBudgetBytes) {
      Entry* e = victim(false);
      if (e == nullptr) return nullptr;
      total -= e->bytes;
      forget(*e);
    }
    std::string name;
    if (!free_.empty()) {
      name = std::move(free_.back());
      free_.pop_back();
    } else {
      name = "precomp-cache-" + std::to_string(next_++);
    }
    entries_.push_back({std::move(name), key, w, h, f, bytes, frame});
    return &entries_.back();
  }

  /// Drop `e`; its target name is reused by a later claim.
  void forget(const Entry& e) {
    for (std::size_t i = 0; i < entries_.size(); ++i) {
      if (&entries_[i] == &e) {
        evict_at(i);
        return;
      }
    }
  }

  /// Drop entries idle more than kMaxIdle frames.
  void expire(std::uint64_t frame) {
    for (std::size_t i = entries_.size(); i-- > 0;) {
      if (frame > entries_[i].used + kMaxIdle) evict_at(i);
    }
  }

 private:
  static Entry* rekey(Entry& e, std::uint64_t key, std::uint64_t frame) noexcept {
    e.key = key;
    e.used = frame;
    return &e;
  }
  /// Remove entry `i` (the last one moved into its place), keeping its target name.
  void evict_at(std::size_t i) {
    free_.push_back(std::move(entries_[i].name));
    if (i + 1 != entries_.size()) entries_[i] = std::move(entries_.back());
    entries_.pop_back();
  }

  std::vector<Entry> entries_;
  std::vector<std::string> free_;
  std::uint64_t next_ = 0;
  std::unordered_map<std::uint64_t, std::uint64_t> last_;
};

/// The engine's texture feed seen through one precomp's subtree: forwards
/// every lookup and records whether any of them drew pixels the frame's
/// hashes do not pin down — a texture not available yet (its draw is skipped
/// now and made next frame under the same hash) or footage (`media:` hashes:
/// a preview draws the nearest decoded frame under the wanted frame's name).
/// A subtree that looked one up is drawn, never kept.
class TaintingSource final : public ExternalTextureSource {
 public:
  explicit TaintingSource(ExternalTextureSource& inner) : inner_(&inner) {}
  [[nodiscard]] TexRef external_texture(std::string_view hash) override { return check(hash, inner_->external_texture(hash)); }
  [[nodiscard]] TexRef external_texture_mipmapped(std::string_view hash, const MipFootprint& fp) override {
    return check(hash, inner_->external_texture_mipmapped(hash, fp));
  }
  [[nodiscard]] bool tainted() const noexcept { return tainted_; }

 private:
  TexRef check(std::string_view hash, TexRef t) {
    if (!t || hash.starts_with("media:")) tainted_ = true;
    return t;
  }
  ExternalTextureSource* inner_;
  bool tainted_ = false;
};

/// Grow bounds: where a chain input drawn from `r` (renderable_cmds) can be non-zero.
std::optional<PxBox> drawn_box(const PassContext& ctx, const api::Renderable& r) {
  return content_box(r, ctx.viewport.viewProjection, ctx.viewport.pixelWidth, ctx.viewport.pixelHeight);
}

/// The blends (device.cpp blend_state) under which a transparent source texel
/// leaves the destination exactly as it was.
bool transparent_is_noop(Blend b) {
  return b == Blend::normal || b == Blend::add || b == Blend::screen || b == Blend::subtract || b == Blend::overlay ||
         b == Blend::lighter || b == Blend::atop;
}

/// The device-pixel lengths of an affine quad's two sides (the unit quad's x
/// and y through `mvp`); 0 × 0 for a projective or degenerate draw.
MipFootprint quad_footprint(const ViewportState& vp, const Mat3& mvp) {
  const auto& m = mvp.m;
  const double w = m[8];
  if (std::abs(m[2]) > 1e-7 || std::abs(m[5]) > 1e-7 || !(std::abs(w) > 1e-7)) return {};
  const double hw = 0.5 * vp.pixelWidth / w;
  const double hh = 0.5 * vp.pixelHeight / w;
  const double ax = std::hypot(m[0] * hw, m[1] * hh);
  const double ay = std::hypot(m[3] * hw, m[4] * hh);
  if (!std::isfinite(ax) || !std::isfinite(ay) || !(ax > 1e-6) || !(ay > 1e-6)) return {};
  return {ax, ay};
}

/// AE's layer-edge antialiasing for a layer quad drawn with `mvp` (uniforms.hpp
/// LayerEdge): one device pixel of margin, in local units along each axis, and
/// coverage on. Without it a solid, a still, a filled shape or a precomp drawn
/// rotated, scaled or at a fraction of a pixel had a hard stair-stepped edge,
/// and a circle's antialiased fringe was clipped flat at the box. Off for a
/// projective quad (no affine pixel metric), a degenerate one, and a blend under
/// which the margin's transparent texels — or a partly covered edge texel —
/// would not blend as coverage (multiply's src × dst, darken / lighten's min /
/// max, none's replace).
LayerEdge layer_edge(const ViewportState& vp, const Mat3& mvp, Blend blend) {
  if (!transparent_is_noop(blend)) return {};
  // Device pixels per local unit along the quad's x and y.
  const MipFootprint px = quad_footprint(vp, mvp);
  if (!(px.width > 0)) return {};
  return {1 / px.width, 1 / px.height, 1, 0};
}

/// A layer texture's mip-level gradient scale (LayerEdge::lodScale): ½, so the
/// level sampled is one finer than the footprint — up to a 2:1 minification
/// bilinear reads level 0, as it always did (crisp: a vector raster is
/// supersampled 2× and already antialiased, a still or SVG shown 1:1 stays
/// sharp), and past it the mip chain averages what bilinear skipped. The plain
/// footprint level would add a second pixel of blur to every edge.
constexpr double kLayerLodScale = 0.5;

}  // namespace

// ── emit helpers (passUtils.ts) ─────────────────────────────────────────────

void emit_solid(PassContext& ctx, Commands& cmds, const Mat3& mvp, const Color& c, double opacity, Blend blend,
                const SolidShape& shape, const LayerEdge& edge = {}) {
  cmds.add(Mat::SOLID_MATERIAL, blend, pack_solid(ctx.packer(), mvp, c, opacity, shape, edge));
}

void emit_textured(PassContext& ctx, Commands& cmds, const Mat3& mvp, const Color& tint, double opacity, Blend blend,
                   const TexRef& tex, const SamplerRef& smp, const Rect& uv, const ColorTransform& ct, bool sampleLinear,
                   const LayerEdge& edge) {
  DrawItem& it = cmds.add(sampleLinear ? Mat::TEXTURED_LINEAR_MATERIAL : Mat::TEXTURED_MATERIAL, blend,
                          pack_textured(ctx.packer(), mvp, uv, tint, opacity, ct, sampleLinear, edge));
  it.texture = tex;
  it.sampler = smp;
}

void emit_silhouette(PassContext& ctx, Commands& cmds, const Mat3& mvp, const Color& c, double opacity, Blend blend,
                     const TexRef& tex, const SamplerRef& smp, const Rect& uv) {
  DrawItem& it = cmds.add(Mat::TEXTURED_SILHOUETTE_MATERIAL, blend, pack_textured(ctx.packer(), mvp, uv, c, opacity));
  it.texture = tex;
  it.sampler = smp;
}

void emit_masked_textured(PassContext& ctx, Commands& cmds, const Mat3& mvp, const Color& tint, double opacity,
                          Blend blend, const TexRef& tex, const SamplerRef& smp, const TexRef& mask, const Rect& uv,
                          const ColorTransform& ct, bool sampleLinear, const LayerEdge& edge = {}) {
  DrawItem& it = cmds.add(sampleLinear ? Mat::MASKED_TEXTURED_LINEAR_MATERIAL : Mat::MASKED_TEXTURED_MATERIAL, blend,
                          pack_textured(ctx.packer(), mvp, uv, tint, opacity, ct, sampleLinear, edge));
  it.texture = tex;
  it.sampler = smp;
  it.mask = mask;
}

void emit_lut_textured(PassContext& ctx, Commands& cmds, const Mat3& mvp, const Color& tint, double opacity, Blend blend,
                       const TexRef& tex, const SamplerRef& smp, const TexRef& lut, const Rect& uv,
                       const ColorTransform& ct, bool sampleLinear, const LayerEdge& edge = {}) {
  DrawItem& it = cmds.add(sampleLinear ? Mat::LUT_TEXTURED_LINEAR_MATERIAL : Mat::LUT_TEXTURED_MATERIAL, blend,
                          pack_textured(ctx.packer(), mvp, uv, tint, opacity, ct, sampleLinear, edge));
  it.texture = tex;
  it.sampler = smp;
  it.mask = lut;
}

void emit_matte_combine(PassContext& ctx, Commands& cmds, const Mat3& mvp, Blend blend, const TexRef& tex,
                        const SamplerRef& smp, const TexRef& matte, const ColorTransform& mode, const Rect& uv) {
  DrawItem& it = cmds.add(Mat::MATTE_COMBINE_MATERIAL, blend, pack_textured(ctx.packer(), mvp, uv, Color::white(), 1, mode));
  it.texture = tex;
  it.sampler = smp;
  it.mask = matte;
}

void emit_blend_combine(PassContext& ctx, Commands& cmds, const Mat3& mvp, Blend blend, const TexRef& tex,
                        const SamplerRef& smp, const TexRef& backdrop, const ColorTransform& mode, const Rect& uv) {
  DrawItem& it = cmds.add(Mat::BLEND_COMBINE_MATERIAL, blend, pack_textured(ctx.packer(), mvp, uv, Color::white(), 1, mode));
  it.texture = tex;
  it.sampler = smp;
  it.mask = backdrop;
}

/// emitLayerTexture: a deformed mesh if present, else a textured quad.
void emit_layer_texture(PassContext& ctx, Commands& cmds, const api::Renderable& r, const TexRef& tex,
                        const SamplerRef& smp, const Rect& uv, double opacity, const Mat3* modelOverride,
                        const Blend* blendOverride, bool sampleLinear, bool edgeAA, double lodScale) {
  const Blend blend = blendOverride != nullptr ? *blendOverride : blend_of(r.blend);
  const Mat3 mvp = mvp_for(ctx.viewport, modelOverride != nullptr ? *modelOverride : mat3_of(r.model_matrix));
  if (r.deformed_mesh) {
    const auto& dm = *r.deformed_mesh;
    const std::size_t vertexFloats = dm.vertices.size() / 4;
    const std::size_t indexCount = dm.triangles.size() / 2;
    std::string vkey = "geometry:mesh-vertex:" + r.id + ":" + std::to_string(vertexFloats);
    std::string ikey = "geometry:mesh-index:" + r.id + ":" + std::to_string(indexCount);
    const wgpu::Buffer vb = ctx.dev.geometry(vkey, dm.vertices, false, true);
    const wgpu::Buffer ib = ctx.dev.geometry(ikey, dm.triangles, true, true);
    // packDeformedMesh: mat3 mvp + tint + 3 colour rows + srcSpace (no uvRect).
    Packer p = ctx.packer();
    p.mat3(mvp).color(color_or_white(r), opacity).color_rows(color_transform(r.color_matrix)).src_space(sampleLinear);
    DrawItem& it = cmds.add(sampleLinear ? Mat::DEFORMED_MESH_LINEAR_MATERIAL : Mat::DEFORMED_MESH_MATERIAL, blend, p.span());
    it.texture = tex;
    it.sampler = smp;
    it.vertexBuffer = vb;
    it.indexBuffer = ib;
    it.indexCount = static_cast<std::uint32_t>(indexCount);
    it.indexFormat = wgpu::IndexFormat::Uint16;
    return;
  }
  LayerEdge edge = edgeAA ? layer_edge(ctx.viewport, mvp, blend) : LayerEdge{};
  edge.lodScale = lodScale;
  emit_textured(ctx, cmds, mvp, color_or_white(r), opacity, blend, tex, smp, r.uv_rect ? rect_of(*r.uv_rect) : uv,
                color_transform(r.color_matrix), sampleLinear, edge);
}

namespace {

struct ListState {
  std::string out;
  std::size_t depth = 0;
  Commands main;
  ById byId;
};

class CompositionPass final : public RenderPass, public MapLayerSource {
 public:
  [[nodiscard]] std::string_view name() const override { return "composition"; }
  [[nodiscard]] std::vector<std::string> writes() const override {
    std::vector<std::string> w = {std::string(kSceneColor), std::string(kLayerTarget), std::string(kBlur1),
                                  std::string(kBlur2),      std::string(kBlur3),       std::string(kMatteTarget),
                                  std::string(kDofTarget),  std::string(kFxHist),     std::string(kFxLut),
                                  std::string(kGeneratorTarget), std::string(kFxSilhouette), std::string(kFxScopeMask),
                                  std::string(kFxBlendInput)};
    for (const auto n : kPrecompTargets) w.emplace_back(n);
    for (const auto n : kFxAux) w.emplace_back(n);
    return w;
  }
  [[nodiscard]] std::vector<std::string> after() const override { return {"background"}; }

  bool execute(PassContext& ctx, std::string& /*error*/) override {
    precompTex_.clear();
    owned_.clear();  // last frame's synthesized renderables
    precompCache_.expire(ctx.dev.frame());
    if (ctx.effectStats != nullptr) {
      ctx.effectStats->precompsRendered = ctx.effectStats->precompsCached = ctx.effectStats->precompsInline = 0;
    }
    std::vector<const api::Renderable*> list;
    list.reserve(ctx.file.scene.renderables.size());
    for (const auto& r : ctx.file.scene.renderables) list.push_back(&r);
    // AE parity 4.4: a visible environment is the backdrop under every layer.
    if (ctx.target(ctx.activeColorTarget) != nullptr) {
      render_sky(ctx, ctx.activeColorTarget, [this, &ctx](const std::optional<std::string>& k) { return tex_for(ctx, k); });
    }
    // E8: the viewport's ground grid rides the frame's last 3D run (threed.cpp);
    // with no 3D run it is drawn here over the finished frame.
    ctx.groundGridPending = ctx.file.scene.ground_grid.has_value() && ctx.scope.camera3d != nullptr;
    ctx.groundGridRun = false;
    render_list(ctx, list, ctx.activeColorTarget, 0);
    if (ctx.groundGridPending) render_ground_grid(ctx, ctx.activeColorTarget);
    return true;
  }

 private:
  /// Offscreen textures of isolated precomps this frame (drawn, or kept from an earlier frame), by `precomp:<id>` key.
  std::unordered_map<std::string, TexRef> precompTex_;
  /// AE parity 4.2: images of 3D-run layers drawn by render_3d_group, during composite_special_3d.
  const std::unordered_map<std::string, TexRef>* predrawn_ = nullptr;
  /// P8: finished layer chains kept across frames (render thread only).
  LayerFxCache layerFx_{"fx-layer-", 8};
  /// E1: finished 3D surface chains (threed.cpp resolve_surface), layer-sized
  /// buffers — a 3D comp holds more effect layers at once than a 2D one.
  LayerFxCache surfaceFx_{"fx-surface-", 16};
  /// Whether the switch `name` is on: unset or anything but "0" (read once, at construction).
  static bool env_on(const char* name) {
#ifdef _WIN32
    char* v = nullptr;
    std::size_t len = 0;
    if (_dupenv_s(&v, &len, name) != 0 || v == nullptr) return true;
    const bool on = std::string_view(v) != "0";
    std::free(v);  // NOLINT(cppcoreguidelines-no-malloc,cppcoreguidelines-owning-memory): _dupenv_s allocates with malloc
    return on;
#else
    const char* v = std::getenv(name);  // NOLINT(concurrency-mt-unsafe): read once, at construction
    return v == nullptr || std::string_view(v) != "0";
#endif
  }
  /// Kill switch (PREMATION_LAYER_FX_CACHE=0): every chain runs, as before P8.
  bool layerFxEnabled_ = env_on("PREMATION_LAYER_FX_CACHE");
  /// Kill switch (PREMATION_PRECOMP_CACHE=0): every isolated precomp is drawn every frame.
  bool precompCacheEnabled_ = env_on("PREMATION_PRECOMP_CACHE");
  /// Finished precomp images kept across frames (PrecompCache).
  PrecompCache precompCache_;
  /// Names of the precomp slots past the declared four (`precomp-target-<n>`,
  /// n ≥ 4), made once per depth reached. A deque: views into it stay valid as it grows.
  std::deque<std::string> precompNames_;
  /// The VRAM budget refused a slot this session (reported once).
  bool precompBudgetReported_ = false;
  /// Scratch for a precomp's content key (the wire bytes of its subtree);
  /// cleared, never shrunk: no allocation once warm.
  wire::Writer keyBuf_;
  /// Renderables synthesized this frame (reparented precomp children, prepared containers).
  std::vector<std::unique_ptr<std::vector<api::Renderable>>> owned_;
  /// The list an effect chain runs in (set around run_effects_chain): what
  /// map_layer needs to draw a precomp source (Program X1 time taps, layer
  /// controls naming a precomp).
  ListState* chainList_ = nullptr;
  /// Precomp layers the current layer's effects read as maps (Displacement Map,
  /// Set Matte, …), drawn into their precomp slots BEFORE the layer is drawn;
  /// map_layer reads them from here. See prepare_map_precomps.
  std::unordered_map<std::string, api::Renderable> mapPrecomps_;
  /// One layer's mapPrecomps_: a precomp drawn inside it has its own, and the
  /// outer layer's come back when it is done.
  struct MapPrecompScope {
    std::unordered_map<std::string, api::Renderable>& slot;
    std::unordered_map<std::string, api::Renderable> saved;
    explicit MapPrecompScope(std::unordered_map<std::string, api::Renderable>& s) : slot(s), saved(std::move(s)) { slot.clear(); }
    ~MapPrecompScope() { slot = std::move(saved); }
    MapPrecompScope(const MapPrecompScope&) = delete;
    MapPrecompScope& operator=(const MapPrecompScope&) = delete;
    MapPrecompScope(MapPrecompScope&&) = delete;
    MapPrecompScope& operator=(MapPrecompScope&&) = delete;
  };
  /// Sets chainList_ for one chain run.
  struct ChainListScope {
    ListState*& slot;
    ListState* saved;
    ChainListScope(ListState*& s, ListState& st) : slot(s), saved(s) { slot = &st; }
    ~ChainListScope() { slot = saved; }
    ChainListScope(const ChainListScope&) = delete;
    ChainListScope& operator=(const ChainListScope&) = delete;
    ChainListScope(ChainListScope&&) = delete;
    ChainListScope& operator=(ChainListScope&&) = delete;
  };
  /// Puts the pass context's texture feed back when a precomp's subtree is done.
  struct ExternalScope {
    PassContext* pass;
    ExternalTextureSource* outer;
    explicit ExternalScope(PassContext& c) : pass(&c), outer(c.external) {}
    ~ExternalScope() { pass->external = outer; }
    ExternalScope(const ExternalScope&) = delete;
    ExternalScope& operator=(const ExternalScope&) = delete;
    ExternalScope(ExternalScope&&) = delete;
    ExternalScope& operator=(ExternalScope&&) = delete;
  };

  TexRef tex_for(PassContext& ctx, const std::optional<std::string>& key) {
    if (!key) return {};
    const auto it = precompTex_.find(*key);
    if (it != precompTex_.end()) return it->second;
    return ctx.texture(*key);
  }

  void flush(PassContext& ctx, ListState& st) {
    if (st.main.empty()) return;
    ctx.draw_into(st.out, st.main, false);
    st.main.clear();
  }

  SamplerRef sampler_for(PassContext& ctx, const api::Renderable& r) {
    return r.sampling == api::RenderSampling::nearest ? ctx.nearest_clamp() : ctx.linear_clamp();
  }

  /// A layer's content texture as drawn on screen, with its sampler: a layer
  /// drawn smaller than its raster — a scaled-down or squashed shape, text,
  /// stroke, paint stroke or still — samples a mip chain, trilinear and 16×
  /// anisotropic, averaging its texels instead of skipping them (thin strokes
  /// broke into dashes, edges and small type stair-stepped). `mvp` gives the
  /// quad's device size: the chain is built only as deep as that samples
  /// (Device::mip_texture) — none at up to 2:1, most layers — and the sampler
  /// never reads past it. The plain texture stays for Draft quality (nearest),
  /// a precomp's offscreen (a render target: no chain) and a sub-rect (uv_rect:
  /// its coarse levels would bleed the neighbouring content in).
  std::pair<TexRef, SamplerRef> layer_texture(PassContext& ctx, const api::Renderable& r, const std::string& key, const Mat3& mvp) {
    const bool plain = r.sampling == api::RenderSampling::nearest || precompTex_.contains(key) || r.uv_rect.has_value();
    if (!plain) {
      // No second try at the plain texture when this one is missing: the same
      // pixels (not ready, or over the device's size limit — refused once).
      TexRef t = ctx.texture_mipmapped(key, quad_footprint(ctx.viewport, mvp));
      return {t, ctx.linear_clamp_levels(t.mipLevels, true)};
    }
    return {tex_for(ctx, key), sampler_for(ctx, r)};
  }

  /// renderableCmds: one renderable (solid / textured / masked / LUT) at `opacity`.
  void renderable_cmds(PassContext& ctx, const api::Renderable& r, double opacity, Commands& cmds,
                       const Mat3* modelOverride = nullptr, const Blend* blendOverride = nullptr) {
    const Blend blend = blendOverride != nullptr ? *blendOverride : Blend::normal;
    const Rect uv = uv_or_full(r);
    const Mat3 mvp = mvp_for(ctx.viewport, modelOverride != nullptr ? *modelOverride : mat3_of(r.model_matrix));
    LayerEdge edge = layer_edge(ctx.viewport, mvp, blend);
    edge.lodScale = kLayerLodScale;
    const bool solid = is_solid_kind(r.kind);
    const bool textured = is_textured_kind(r.kind);
    if (r.mask_texture_key) {
      const TexRef mask = ctx.texture_mipmapped(*r.mask_texture_key, quad_footprint(ctx.viewport, mvp));
      auto [tex, smp] = textured && r.texture_key ? layer_texture(ctx, r, *r.texture_key, mvp) : std::pair<TexRef, SamplerRef>{};
      if (solid && !tex) {
        tex = ctx.texture("texture:white");
        smp = r.sampling == api::RenderSampling::nearest ? ctx.nearest_clamp() : ctx.linear_clamp_levels(mask.mipLevels, true);
      } else if (tex && r.sampling != api::RenderSampling::nearest && (tex.mipLevels > 1 || mask.mipLevels > 1)) {
        // One sampler reads both: never past the shallower of the two chains.
        smp = ctx.linear_clamp_levels(std::min(std::max(1U, tex.mipLevels), std::max(1U, mask.mipLevels)), true);
      }
      if (mask && tex) {
        emit_masked_textured(ctx, cmds, mvp, color_or_white(r), opacity, blend, tex, smp, mask, uv,
                             color_transform(r.color_matrix), tex.sampleLinear, edge);
      }
    } else if (solid && r.color) {
      emit_solid(ctx, cmds, mvp, color_of(*r.color), opacity, blend, to_solid_shape(r.sdf), edge);
    } else if (textured && r.texture_key) {
      const auto [tex, smp] = layer_texture(ctx, r, *r.texture_key, mvp);
      const TexRef lut = r.lut_texture_key ? ctx.texture(*r.lut_texture_key) : TexRef{};
      if (tex && lut) {
        // The LUT is looked up through the same sampler: trilinear, never
        // anisotropic (its taps would spread along the colour's gradient).
        const SamplerRef lutSmp = tex.mipLevels > 1 ? ctx.linear_clamp_levels(tex.mipLevels, false) : smp;
        emit_lut_textured(ctx, cmds, mvp, color_or_white(r), opacity, blend, tex, lutSmp, lut, uv,
                          color_transform(r.color_matrix), tex.sampleLinear, edge);
      } else if (tex) {
        emit_layer_texture(ctx, cmds, r, tex, smp, uv, opacity, modelOverride, blendOverride, tex.sampleLinear, true,
                           edge.lodScale);
      }
    }
  }

  /// layerIntoTarget: content (+ motion-blur accumulation) into `dest`, then its effect chain, settled in `dest`.
  TexRef layer_into_target(PassContext& ctx, const api::Renderable& r, double opacity, std::string_view dest,
                           const ListState& st) {
    // AE parity 4.2: a 3D-run layer arrives already drawn in 3D (perspective,
    // its effects, its motion samples, occluded by the run).
    if (predrawn_ != nullptr) {
      if (const auto it = predrawn_->find(r.id); it != predrawn_->end()) return it->second;
    }
    Commands cmds;
    if (r.motion_samples.size() > 1) {
      const auto n = static_cast<double>(r.motion_samples.size());
      const Blend add = Blend::add;
      for (const auto& s : r.motion_samples) {
        const Mat3 m = mat3_of(s.model_matrix);
        renderable_cmds(ctx, r, s.opacity / n, cmds, &m, &add);
      }
    } else {
      renderable_cmds(ctx, r, opacity, cmds);
    }
    if (cmds.empty()) return {};
    ctx.draw_into(dest, cmds, true);
    RenderTarget* t = ctx.target(dest);
    if (t == nullptr) return {};
    return apply_layer_effects(ctx, r, t->tex(), dest, st, opacity);
  }

  TexRef apply_layer_effects(PassContext& ctx, const api::Renderable& r, const TexRef& src, std::string_view dest,
                             const ListState& st, double opacity) {
    if (r.effects.empty()) return src;
    const std::uint64_t contentKey = chain_content_key(ctx, r, opacity);
    const std::uint64_t fxKey = layerFxEnabled_ ? layer_fx_key(ctx, r, contentKey, opacity) : 0;
    if (const std::optional<ChainResult> kept = reuse_layer_fx(ctx, fxKey, dest)) return kept->tex;
    const std::array<std::string_view, 4> pool = {dest, kBlur1, kBlur2, kBlur3};
    const ChainListScope chainList(chainList_, const_cast<ListState&>(st));  // NOLINT(cppcoreguidelines-pro-type-const-cast): read-mostly; the precomp draw flushes it
    const ChainResult res = run_effects_chain(ctx, r.effects, src, pool, st.byId, r.id, *this, nullptr, contentKey,
                                              drawn_box(ctx, r));
    TexRef out = res.tex;
    if (res.name != dest) {
      Commands copy;
      emit_textured(ctx, copy, screen_mvp(), Color::white(), 1, Blend::none, res.tex, ctx.linear_clamp(), {0, 0, 1, 1},
                    kIdentityColor, true);
      ctx.draw_into(dest, copy, true);
      out = ctx.target(dest)->tex();
    }
    keep_layer_fx(ctx, r.id, fxKey, out, dest, res.covered);
    return out;
  }

  /// P8: an earlier frame's chain result under `fxKey` (0 = not cacheable) —
  /// the same input and parameters draw the same result. Copied into `dest`
  /// when one is named; otherwise the kept texture itself (it outlives the frame).
  std::optional<ChainResult> reuse_layer_fx(PassContext& ctx, std::uint64_t fxKey, std::string_view dest) {
    if (fxKey == 0) return std::nullopt;
    const std::uint32_t w = ctx.viewport.pixelWidth;
    const std::uint32_t h = ctx.viewport.pixelHeight;
    LayerFxCache::Slot* s = layerFx_.find(fxKey, w, h);
    if (s == nullptr) return std::nullopt;
    bool created = false;
    RenderTarget& t = ctx.dev.target(s->name, w, h, s->format, 1, false, &created);
    if (created) {
      LayerFxCache::forget(*s);  // the pool collected it: the chain runs again
      return std::nullopt;
    }
    s->used = ctx.dev.frame();
    if (ctx.effectStats != nullptr) ++ctx.effectStats->layerChainsReused;
    if (dest.empty()) return ChainResult{t.tex(), s->name, s->covered};
    // Exact: a texture copy. The textured shader's storage decode darkened every
    // reused result's midtones in a linear working space, and even raw its
    // unpremultiply round trip moved half-float texels by an ulp (P8b, 2026-10-10).
    RenderTarget* d = ctx.target(dest);
    if (d != nullptr && d->format == t.format && d->width == t.width && d->height == t.height) {
      copy_texels(ctx, t, *d);
    } else {
      Commands copy;
      emit_textured(ctx, copy, screen_mvp(), Color::white(), 1, Blend::none, t.tex(), ctx.nearest_clamp(), {0, 0, 1, 1},
                    kIdentityColor, true);
      ctx.draw_into(dest, copy, true);
    }
    return ChainResult{ctx.target(dest)->tex(), dest, s->covered};
  }

  /// P8b: a kept chain result for a snapped layer (PixelSnap), and the move
  /// from where its origin sits in the kept buffer to where the layer is now.
  struct KeptFx {
    TexRef tex;
    std::optional<PxBox> covered;  // at the kept place
    double dx = 0;
    double dy = 0;
  };

  /// P8b: an earlier frame's chain result under the translation-free `fxKey`
  /// (which holds the placement's phase), moved by whole pixels to where the
  /// layer is now. A result the buffer's edge cut (not `movable`) is reused
  /// only where it was drawn.
  std::optional<KeptFx> reuse_layer_fx_moved(PassContext& ctx, std::uint64_t fxKey, const PixelSnap& snap) {
    if (fxKey == 0 || !snap.on) return std::nullopt;
    const std::uint32_t w = ctx.viewport.pixelWidth;
    const std::uint32_t h = ctx.viewport.pixelHeight;
    LayerFxCache::Slot* s = layerFx_.find(fxKey, w, h);
    if (s == nullptr || !s->at) return std::nullopt;
    if (!s->movable && ((*s->at)[0] != snap.bx || (*s->at)[1] != snap.by)) return std::nullopt;
    // Equal phases (the key) make the move whole; a stray fraction is a re-run, never a resample.
    const double mx = snap.bx - (*s->at)[0];
    const double my = snap.by - (*s->at)[1];
    if (mx != std::round(mx) || my != std::round(my)) return std::nullopt;
    const double dx = mx + std::round(snap.px - snap.bx);
    const double dy = my + std::round(snap.py - snap.by);
    bool created = false;
    RenderTarget& t = ctx.dev.target(s->name, w, h, s->format, 1, false, &created);
    if (created) {
      LayerFxCache::forget(*s);  // the pool collected it: the chain runs again
      return std::nullopt;
    }
    s->used = ctx.dev.frame();
    if (ctx.effectStats != nullptr) ++ctx.effectStats->layerChainsReused;
    return KeptFx{t.tex(), s->covered, dx, dy};
  }

  /// P8: keep `out` (the chain result of layer `id` under `fxKey`) for later
  /// frames — once the layer's key held for two frames in a row. P8b: a snapped
  /// layer's result is kept with where it was drawn; it may be MOVED only when
  /// its whole reach was on screen (a result cut by the viewport's edge cannot).
  void keep_layer_fx(PassContext& ctx, const std::string& id, std::uint64_t fxKey, const TexRef& out, std::string_view outName,
                     const std::optional<PxBox>& covered, const PixelSnap* snap = nullptr) {
    if (fxKey == 0 || !layerFx_.steady(id, fxKey)) return;
    const RenderTarget* src = ctx.target(outName);
    if (src == nullptr) return;
    const std::uint32_t w = ctx.viewport.pixelWidth;
    const std::uint32_t h = ctx.viewport.pixelHeight;
    const bool snapped = snap != nullptr && snap->on;
    LayerFxCache::Slot* slot = layerFx_.claim(fxKey, w, h, ctx.dev.frame());
    if (slot == nullptr) return;  // every slot is in use this frame
    slot->covered = covered;
    if (snapped) {
      slot->at = std::array<double, 2>{snap->bx, snap->by};
      slot->movable = inside_view(covered, w, h);
    }
    slot->format = src->format;
    RenderTarget& t = ctx.dev.target(slot->name, w, h, slot->format, 1, false);
    if (src->width == t.width && src->height == t.height) {
      copy_texels(ctx, *src, t);  // exact, as reuse_layer_fx copies it back
      return;
    }
    Commands keep;
    emit_textured(ctx, keep, screen_mvp(), Color::white(), 1, Blend::none, out, ctx.nearest_clamp(), {0, 0, 1, 1},
                  kIdentityColor, true);  // raw: the chain's working-space texels as they are
    draw_to_target(ctx, t, keep);
  }

  /// P8: `from` into `to` texel for texel (same format and size), in encode order.
  static void copy_texels(PassContext& ctx, const RenderTarget& from, const RenderTarget& to) {
    wgpu::TexelCopyTextureInfo a{};
    a.texture = from.texture;
    wgpu::TexelCopyTextureInfo b{};
    b.texture = to.texture;
    const wgpu::Extent3D size{from.width, from.height, 1};
    ctx.dev.encoder().CopyTextureToTexture(&a, &b, &size);
  }

 public:
  /// E1: an earlier frame's chain result for a 3D surface under `key` at w × h
  /// (threed.cpp resolve_surface). The slot's own texture: it outlives the
  /// frame, and no slot read or written this frame is claimed again in it.
  TexRef reuse_surface_fx(PassContext& ctx, std::uint64_t key, std::uint32_t w, std::uint32_t h) override {
    if (key == 0 || !layerFxEnabled_) return {};
    LayerFxCache::Slot* s = surfaceFx_.find(key, w, h);
    if (s == nullptr) return {};
    bool created = false;
    RenderTarget& t = ctx.dev.target(s->name, w, h, s->format, 1, false, &created);
    if (created) {
      LayerFxCache::forget(*s);  // the pool collected it: the chain runs again
      return {};
    }
    s->used = ctx.dev.frame();
    if (ctx.effectStats != nullptr) ++ctx.effectStats->layerChainsReused;
    return t.tex();
  }

  /// E1: keep `result` (layer `id`'s surface chain under `key`) once the key
  /// held two frames in a row; the kept copy's texture, which the surface's
  /// draw samples directly (empty = not kept this frame).
  TexRef keep_surface_fx(PassContext& ctx, const std::string& id, std::uint64_t key, const RenderTarget& result) override {
    if (key == 0 || !layerFxEnabled_ || !surfaceFx_.steady(id, key)) return {};
    LayerFxCache::Slot* slot = surfaceFx_.claim(key, result.width, result.height, ctx.dev.frame());
    if (slot == nullptr) return {};  // every slot is in use this frame
    slot->covered.reset();
    slot->format = result.format;
    RenderTarget& t = ctx.dev.target(slot->name, result.width, result.height, result.format, 1, false);
    copy_texels(ctx, result, t);
    return t.tex();
  }

  bool composite_special_3d(PassContext& ctx, const api::Renderable& r, const std::unordered_map<std::string, TexRef>& predrawn,
                            std::string_view out, const ById& byId) override {
    ListState st;
    st.out = std::string(out);
    st.byId = byId;
    predrawn_ = &predrawn;
    process(ctx, r, st);
    flush(ctx, st);
    predrawn_ = nullptr;
    return true;
  }

  /// Camera program D1: the comp's scene depth for a depth-reading effect
  /// (one pass per frame and placement, shared — scene_depth.cpp).
  TexRef scene_depth(PassContext& ctx, std::uint32_t w, std::uint32_t h, const std::array<double, 9>& compToWorld,
                     std::string_view selfId) override {
    SceneDepth::Request req;
    req.width = w;
    req.height = h;
    req.compToWorld = compToWorld;
    req.selfId = selfId;
    const SceneDepth::Result* r = sceneDepth_.render(ctx, req);
    if (r == nullptr || !r->view) return {};
    // External identity (high bit): stable per texture object, never a Device id.
    const auto id = (std::uint64_t{1} << 63U) | static_cast<std::uint64_t>(std::bit_cast<std::uintptr_t>(r->texture.Get()));
    return TexRef{r->view, id, r->width, r->height, false, 0, 0};
  }

  /// displacementMapTexture: render a referenced layer into MATTE_TARGET.
  TexRef map_layer(PassContext& ctx, const ById& byId, std::string_view mapLayerId, std::string_view selfId) override {
    if (mapLayerId.empty() || mapLayerId == selfId) return {};
    // `<layer>#subject` (Behind Subject, effects_spatial.hpp kSubjectMapSuffix): that layer's subject
    // matte frame ("fxmatte:<layer>", requested by frame_build) drawn through its placement alone —
    // no effects, masks, matte or opacity: the subject's coverage where the layer sits.
    // `<layer>#subject~<id>+<id>`: some of its subjects (their own texture, "fxmatte:<layer>~<id>+<id>").
    constexpr std::string_view kSubject = "#subject";
    if (const std::size_t at = mapLayerId.rfind(kSubject);
        at != std::string_view::npos && at > 0 &&
        (at + kSubject.size() == mapLayerId.size() || mapLayerId[at + kSubject.size()] == '~')) {
      const std::string_view base = mapLayerId.substr(0, at);
      const std::string_view which = mapLayerId.substr(at + kSubject.size());
      const auto sit = byId.find(base);
      if (sit == byId.end() || base == selfId) return {};
      api::Renderable subject = *sit->second;
      subject.texture_key = "fxmatte:" + std::string(base) + std::string(which);
      subject.kind = api::RenderableKind::image;  // a still, whatever the footage was
      subject.effects.clear();
      subject.mask_id.reset();
      subject.mask_texture_key.reset();
      subject.lut_texture_key.reset();
      subject.color_matrix.reset();
      subject.matte.reset();
      subject.adjustment.reset();
      subject.motion_samples.clear();
      subject.opacity = 1;
      subject.blend = api::RenderBlendMode::normal;
      subject.matte_source = false;
      subject.precomp.reset();
      subject.precomp_children.clear();
      if (!ctx.texture(*subject.texture_key)) return {};
      Commands cmds;
      renderable_cmds(ctx, subject, 1, cmds);
      if (cmds.empty()) return {};
      ctx.draw_into(kMatteTarget, cmds, true);
      return ctx.target(kMatteTarget)->tex();
    }
    const auto it = byId.find(mapLayerId);
    if (it == byId.end()) return {};
    const api::Renderable* src = it->second;
    api::Renderable prepared;
    if (const auto pre = mapPrecomps_.find(std::string(mapLayerId)); pre != mapPrecomps_.end()) {
      src = &pre->second;
    } else if (src->precomp) {
      // A precomp source: its subtree drawn offscreen first (as a matte source's
      // is), without its own mask — that step borrows the chain's blur targets.
      if (chainList_ == nullptr || !prepare_isolated_precomp(ctx, *src, *chainList_, chainList_->depth + 1, false, prepared, false)) return {};
      src = &prepared;
    }
    Commands cmds;
    renderable_cmds(ctx, *src, 1, cmds);
    if (cmds.empty()) return {};
    ctx.draw_into(kMatteTarget, cmds, true);
    return ctx.target(kMatteTarget)->tex();
  }

 private:
  /// Draws every precomp layer `r`'s effect params name (a map, matte or extra
  /// layer input) into its own precomp slot, from `slot` up, into mapPrecomps_.
  /// It runs before `r` is drawn: drawn from inside the effect chain instead,
  /// a precomp's subtree runs through the same layer / blur / matte targets the
  /// chain holds its image in, and the layer comes out as that subtree's last
  /// draw. A slot the VRAM budget refuses (precomp_target) falls back to map_layer's own draw.
  void prepare_map_precomps(PassContext& ctx, const api::Renderable& r, ListState& st, std::size_t slot) {
    auto consider = [&](const std::string& id) {
      if (id.empty() || id == r.id || mapPrecomps_.contains(id)) return;
      const auto it = st.byId.find(id);
      if (it == st.byId.end() || !it->second->precomp) return;
      api::Renderable prepared;
      if (!prepare_isolated_precomp(ctx, *it->second, st, slot, false, prepared, false)) return;
      mapPrecomps_.emplace(id, std::move(prepared));
      ++slot;
    };
    for (const api::RenderEffect& fx : r.effects) {
      for (const api::RenderEffectParam& p : fx.params) {
        consider(p.text);
        for (const std::string& t : p.texts) consider(t);
      }
    }
  }

  /// D1: the scene depth depth-reading effects sample (render thread only).
  SceneDepth sceneDepth_;
  /// Mat3 reparent of a renderable list (prepareIsolatedPrecomp `reparent`).
  static std::vector<api::Renderable> reparent(const std::vector<const api::Renderable*>& list, const Mat3& P) {
    std::vector<api::Renderable> out;
    out.reserve(list.size());
    for (const api::Renderable* c : list) {
      api::Renderable x = *c;
      const Mat3 m = mul(P, mat3_of(c->model_matrix));
      x.model_matrix.assign(m.m.begin(), m.m.end());
      const Rect b = rect_of(c->bounds);
      const std::array<Vec2, 4> pts = {transform_point(P, {b.x, b.y}), transform_point(P, {b.x + b.width, b.y}),
                                       transform_point(P, {b.x, b.y + b.height}),
                                       transform_point(P, {b.x + b.width, b.y + b.height})};
      double minX = pts[0].x, maxX = pts[0].x, minY = pts[0].y, maxY = pts[0].y;
      for (const Vec2& p : pts) {
        minX = std::min(minX, p.x);
        maxX = std::max(maxX, p.x);
        minY = std::min(minY, p.y);
        maxY = std::max(maxY, p.y);
      }
      x.bounds = {minX, minY, maxX - minX, maxY - minY};
      for (auto& s : x.motion_samples) {
        const Mat3 sm = mul(P, mat3_of(s.model_matrix));
        s.model_matrix.assign(sm.m.begin(), sm.m.end());
      }
      if (c->precomp && !c->precomp->flat_width) {
        std::vector<const api::Renderable*> kids;
        kids.reserve(c->precomp_children.size());
        for (const auto& k : c->precomp_children) kids.push_back(&k);
        x.precomp_children = reparent(kids, P);
      }
      out.push_back(std::move(x));
    }
    return out;
  }

  /// prepareIsolatedPrecomp: render the subtree offscreen and return the container as a textured renderable.
  bool prepare_isolated_precomp(PassContext& ctx, const api::Renderable& r, ListState& st, std::size_t slot,
                                bool inlineFallback, api::Renderable& prepared, bool applyMask = true) {
    if (!r.precomp) return false;
    const auto& pre = *r.precomp;
    const bool flat = pre.flat_width.has_value();
    const Mat3 fullModel = model_from_rect(ctx.viewport.visibleWorldRect);
    const Mat3 cardToUnit = flat ? scaling(1 / std::max(1.0, *pre.flat_width), 1 / std::max(1.0, pre.flat_height.value_or(1)))
                                 : Mat3{};
    std::vector<const api::Renderable*> kids;
    kids.reserve(r.precomp_children.size());
    for (const auto& k : r.precomp_children) kids.push_back(&k);

    const std::string_view targetName = precomp_target(ctx, slot);
    if (targetName.empty()) {
      // No isolated target (over the VRAM budget): the children drawn straight
      // into the parent — not an isolated group, so blending differs (logged once).
      if (!inlineFallback) return false;
      if (ctx.effectStats != nullptr) ++ctx.effectStats->precompsInline;
      flush(ctx, st);
      std::vector<api::Renderable> direct;
      if (flat) {
        direct = reparent(kids, mul(mat3_of(r.model_matrix), cardToUnit));
      } else {
        for (const auto* k : kids) direct.push_back(*k);
      }
      for (auto& c : direct) c.opacity *= r.opacity;
      auto& keep = owned_.emplace_back(std::make_unique<std::vector<api::Renderable>>(std::move(direct)));
      std::vector<const api::Renderable*> ptrs;
      for (const auto& c : *keep) ptrs.push_back(&c);
      render_list(ctx, ptrs, st.out, st.depth);
      return false;
    }
    const PassContext::TargetSpec* spec = ctx.spec(targetName);
    if (spec == nullptr) return false;
    // A result kept from an earlier frame under the same content key is these
    // pixels exactly (a texel copy of the resolved target): nothing is drawn.
    const std::uint64_t cacheKey = precompCacheEnabled_ ? precomp_key(ctx, r, *spec, applyMask) : 0;
    TexRef tex = reuse_precomp(ctx, cacheKey, *spec);
    if (tex) {
      if (ctx.effectStats != nullptr) ++ctx.effectStats->precompsCached;
    } else if (!render_isolated_precomp(ctx, r, st, slot, targetName, applyMask, cacheKey, tex)) {
      return false;
    }
    if (r.texture_key) precompTex_[*r.texture_key] = tex;

    prepared = r;
    prepared.mask_texture_key.reset();
    prepared.precomp.reset();
    prepared.precomp_children.clear();
    prepared.sdf.reset();
    prepared.deformed_mesh.reset();
    prepared.kind = api::RenderableKind::image;
    const Mat3 model = flat ? mat3_of(r.model_matrix) : fullModel;
    prepared.model_matrix.assign(model.m.begin(), model.m.end());
    if (!flat) {
      const Rect v = ctx.viewport.visibleWorldRect;
      prepared.bounds = {v.x, v.y, v.width, v.height};
    }
    prepared.uv_rect = api::Rect{0, 0, 1, 1};
    prepared.color = r.color ? *r.color : api::Color{1, 1, 1, 1};
    prepared.motion_samples.clear();
    if (r.motion_samples.size() > 1) {
      Mat3 inv;
      if (!flat && invert(mat3_of(r.model_matrix), inv)) {
        for (const auto& s : r.motion_samples) {
          const Mat3 m = mul(mat3_of(s.model_matrix), mul(inv, fullModel));
          prepared.motion_samples.push_back({std::vector<double>(m.m.begin(), m.m.end()), s.opacity, {}});
        }
      } else if (flat) {
        prepared.motion_samples = r.motion_samples;
      }
    }
    return true;
  }

  /// The target of precomp nesting slot `slot`: the four declared ones, then
  /// `precomp-target-<n>` declared on demand like slot 0 (the project's
  /// precision, MSAA and depth) — every depth an isolated group of its own.
  /// Pool targets: allocated on first use, kept warm across frames, collected
  /// idle. Empty when the slots past the fourth would exceed
  /// kExtraPrecompTargetBudget (reported once per session).
  std::string_view precomp_target(PassContext& ctx, std::size_t slot) {
    if (slot < kPrecompTargets.size()) return kPrecompTargets.at(slot);
    const PassContext::TargetSpec* base = ctx.spec(kPrecompTargets.front());
    if (base == nullptr) return {};
    const std::uint64_t each = render_target_bytes(base->width, base->height, texel_bytes(base->format), base->samples, base->depth);
    const std::uint64_t extra = slot - kPrecompTargets.size() + 1;
    if (each == 0 || extra > kExtraPrecompTargetBudget / each) {
      if (!precompBudgetReported_) {
        precompBudgetReported_ = true;
        ctx.diagnostics.push_back({"precomp-inline", "Precomps nested " + std::to_string(slot + 1) +
                                                         " deep exceed the precomp target budget; deeper ones draw into their parent"});
      }
      return {};
    }
    const std::size_t idx = slot - kPrecompTargets.size();
    while (precompNames_.size() <= idx) {
      precompNames_.push_back(std::string(kPrecompTargetPrefix) + std::to_string(precompNames_.size() + kPrecompTargets.size()));
    }
    const std::string& name = precompNames_[idx];
    // Declared for this frame (PassContext::specs is per frame): one map node per deep slot used.
    if (ctx.spec(name) == nullptr) {
      const PassContext::TargetSpec like = *base;  // copied first: the insert may rehash
      ctx.specs.emplace(name, like);
    }
    return name;
  }

  /// The subtree of precomp `r` drawn into `targetName` (and masked), its image
  /// in `tex`; kept under `cacheKey` when every texture it drew was pinned by its hash.
  bool render_isolated_precomp(PassContext& ctx, const api::Renderable& r, ListState& st, std::size_t slot,
                               std::string_view targetName, bool applyMask, std::uint64_t cacheKey, TexRef& tex) {
    if (!r.precomp) return false;
    const auto& pre = *r.precomp;
    const bool flat = pre.flat_width.has_value();
    const Mat3 fullModel = model_from_rect(ctx.viewport.visibleWorldRect);
    const Mat3 cardToUnit = flat ? scaling(1 / std::max(1.0, *pre.flat_width), 1 / std::max(1.0, pre.flat_height.value_or(1)))
                                 : Mat3{};
    flush(ctx, st);
    std::vector<const api::Renderable*> children;
    children.reserve(r.precomp_children.size());
    if (flat) {
      std::vector<const api::Renderable*> kids;
      kids.reserve(r.precomp_children.size());
      for (const auto& k : r.precomp_children) kids.push_back(&k);
      auto& keep = owned_.emplace_back(
          std::make_unique<std::vector<api::Renderable>>(reparent(kids, mul(fullModel, cardToUnit))));
      for (const auto& c : *keep) children.push_back(&c);
    } else {
      for (const auto& k : r.precomp_children) children.push_back(&k);
    }
    // Every texture the subtree (and its mask) draws is looked up through a
    // TaintingSource: one not pinned by its hash keeps the result out of the cache.
    std::optional<TaintingSource> taint;
    const ExternalScope feed(ctx);
    // A subtree that reports something (a missing matte source, an effect it
    // could not run) is drawn every frame, so the frame keeps reporting it.
    const std::size_t diagnosticsBefore = ctx.diagnostics.size();
    if (cacheKey != 0 && feed.outer != nullptr) ctx.external = &taint.emplace(*feed.outer);
    {
      const Commands none;
      ctx.draw_into(targetName, none, true);
    }
    // precompScope: a sealed comp instance with its own 3D frame replaces the
    // camera, lights and environment wholesale (SSAO off) for its subtree.
    const Scope3D saved = ctx.scope;
    if (pre.camera3d) {
      ctx.scope = Scope3D{&*pre.camera3d, &pre.lights3d, pre.env_map ? &*pre.env_map : nullptr, false,
                          pre.fog ? &*pre.fog : nullptr, nullptr, &r.precomp_children};
    }
    render_list(ctx, children, std::string(targetName), slot + 1);
    ctx.scope = saved;
    RenderTarget* pt = ctx.target(targetName);
    if (pt == nullptr) return false;
    tex = pt->tex();

    if (r.mask_texture_key && applyMask) {
      const TexRef maskRes = ctx.texture(*r.mask_texture_key);
      if (maskRes) {
        Commands maskCmds;
        emit_textured(ctx, maskCmds, mvp_for(ctx.viewport, flat ? fullModel : mat3_of(r.model_matrix)), Color::white(), 1,
                      Blend::normal, maskRes, ctx.linear_clamp(), {0, 0, 1, 1}, kIdentityColor, maskRes.sampleLinear);
        ctx.draw_into(kBlur1, maskCmds, true);
        const TexRef maskTex = ctx.target(kBlur1)->tex();
        Commands combine;
        ColorTransform alphaMode;
        alphaMode.m = {0, 0, 0, 0, 0, 0, 0, 0, 0};
        emit_matte_combine(ctx, combine, screen_mvp(), Blend::none, tex, ctx.linear_clamp(), maskTex, alphaMode, {0, 0, 1, 1});
        ctx.draw_into(kBlur2, combine, true);
        const TexRef masked = ctx.target(kBlur2)->tex();
        Commands copy;
        emit_textured(ctx, copy, screen_mvp(), Color::white(), 1, Blend::none, masked, ctx.linear_clamp(), {0, 0, 1, 1},
                      kIdentityColor, true);
        ctx.draw_into(targetName, copy, true);
        tex = pt->tex();
      }
    }
    if (ctx.effectStats != nullptr) ++ctx.effectStats->precompsRendered;
    if (cacheKey != 0 && !(taint && taint->tainted()) && ctx.diagnostics.size() == diagnosticsBefore) {
      keep_precomp(ctx, r, applyMask, cacheKey, *pt);
    }
    return true;
  }

  /// A texture key's content into a precomp's key: its hash, sampling and
  /// colour interpretation. False = the subtree is not kept: a placeholder
  /// (not ready) or footage (`media:` — a preview may draw a nearer frame).
  /// A key with no content (unknown, or not a texture at all — an effect
  /// param naming a layer) draws nothing either way and adds a 0.
  static bool fold_texture(const PassContext& ctx, std::string_view key, KeyMix& k) {
    const ResolvedBlob rb = ctx.textures.resolve(key);
    if (rb.hash.empty()) {
      k.u64(0);
      return true;
    }
    if (!rb.ready || rb.hash.starts_with("media:")) return false;
    k.str(rb.hash);
    k.u64((rb.sampleLinear ? 1U : 0U) | (rb.inputSpace ? (static_cast<std::uint64_t>(*rb.inputSpace) + 1) << 1U : 0U));
    return true;
  }

  /// A precomp frame's environment texture (its sky), by content.
  static bool fold_env_map(const PassContext& ctx, const api::RenderPrecompFrame& f, KeyMix& k) {
    if (!f.env_map) return true;
    const api::RenderEnvMap& env = *f.env_map;
    return !env.texture_key || fold_texture(ctx, *env.texture_key, k);
  }

  /// Every texture `list` (recursively) draws, by content. False = a renderable
  /// whose pixels are not a function of the frame's data: footage, a plugin
  /// generator, a WGSL or native plugin effect, a stepped simulation.
  static bool fold_inputs(const PassContext& ctx, const std::vector<api::Renderable>& list, KeyMix& k) {
    for (const api::Renderable& c : list) {
      if (c.kind == api::RenderableKind::video || c.generator) return false;
      if (c.precomp) {
        const api::RenderPrecompFrame& inner = *c.precomp;
        if (!fold_env_map(ctx, inner, k)) return false;
      }
      if (c.adjustment) {
        const api::RenderAdjustment& adj = *c.adjustment;
        if (adj.lut_texture_key && !fold_texture(ctx, *adj.lut_texture_key, k)) return false;
      }
      if (c.extruded_mesh) {
        const api::RenderExtrudedMesh& mesh = *c.extruded_mesh;
        if (mesh.pbr) {
          const api::RenderPbrMaps& m = *mesh.pbr;
          for (const std::optional<std::string>* key : {&m.normal_key, &m.metallic_roughness_key, &m.occlusion_key, &m.emissive_key}) {
            if (*key && !fold_texture(ctx, **key, k)) return false;
          }
        }
      }
      for (const api::RenderEffect& e : c.effects) {
        if (e.type == "native-plugin" || e.type == "plugin") return false;
        // Texture keys an effect names (LUT strips, data textures, scoped masks, …).
        for (const api::RenderEffectParam& p : e.params) {
          // An fx-graph simulation (X2) is stepped across frames, a capped number a
          // frame: the same params can draw a state still catching up.
          if (p.name == "simKey" && !p.text.empty()) return false;
          if (!p.text.empty() && !fold_texture(ctx, p.text, k)) return false;
          for (const std::string& t : p.texts) {
            if (!t.empty() && !fold_texture(ctx, t, k)) return false;
          }
        }
      }
      for (const std::optional<std::string>* key : {&c.texture_key, &c.mask_texture_key, &c.lut_texture_key}) {
        if (*key && !fold_texture(ctx, **key, k)) return false;
      }
      if (!fold_inputs(ctx, c.precomp_children, k)) return false;
    }
    return true;
  }

  /// The key of precomp `r`'s finished image in `spec`'s target: everything its
  /// pixels depend on — the subtree byte for byte (every renderable field the
  /// draw reads: transforms, opacity, blend, colours, effects and their
  /// params, masks, mattes, motion samples, meshes, nested precomps), each
  /// texture it draws by content hash, its own 3D frame and mask, the target's
  /// size / format / samples, the view, and the renderer's switches, precision
  /// and colour pipeline. 0 = not kept (see fold_inputs; a precomp under a 3D
  /// camera it does not seal reads the parent's 3D scope — camera, lights,
  /// shadow casters, scene depth — none of which is in the subtree).
  std::uint64_t precomp_key(PassContext& ctx, const api::Renderable& r, const PassContext::TargetSpec& spec, bool applyMask) {
    if (!r.precomp) return 0;
    const api::RenderPrecompFrame& pre = *r.precomp;
    // Drawn inside an effect chain (scissored to its reach) or a 3D run's offscreen step: drawn, not kept.
    if (predrawn_ != nullptr || ctx.fxScissor) return 0;
    if (!pre.camera3d && (ctx.scope.camera3d != nullptr || ctx.file.scene.camera3d)) return 0;
    KeyMix k;
    k.u64(0x7072'6563'6f6d'7031ULL);  // "precomp1": the key's layout version
    if (!fold_inputs(ctx, r.precomp_children, k)) return 0;
    if (!fold_env_map(ctx, pre, k)) return 0;
    const bool masked = applyMask && r.mask_texture_key.has_value();
    k.u64(masked ? 1U : 0U);
    if (masked) {
      if (!fold_texture(ctx, *r.mask_texture_key, k)) return 0;
      for (const double v : r.model_matrix) k.f64(v);  // where the mask is drawn
    }
    keyBuf_.clear();
    api::encode(keyBuf_, pre);
    for (const api::Renderable& c : r.precomp_children) api::encode(keyBuf_, c);
    const api::RenderView& view = ctx.file.view;
    const api::RenderFrameScene& scene = ctx.file.scene;
    if (view.color_management) api::encode(keyBuf_, *view.color_management);
    if (scene.renderer) api::encode(keyBuf_, *scene.renderer);
    mix_bytes(k, keyBuf_.bytes());
    // The target.
    k.u64((std::uint64_t{spec.width} << 32U) | spec.height);
    k.u64(static_cast<std::uint64_t>(spec.format));
    k.u64((std::uint64_t{spec.samples} << 1U) | (spec.depth ? 1U : 0U));
    // The view the subtree is drawn under (P8b's ViewShift moves it).
    const ViewportState& vp = ctx.viewport;
    k.u64((std::uint64_t{vp.pixelWidth} << 32U) | vp.pixelHeight);
    for (std::size_t i = 0; i < 9; ++i) k.f64(vp.viewProjection[i]);
    for (const double v : {vp.visibleWorldRect.x, vp.visibleWorldRect.y, vp.visibleWorldRect.width, vp.visibleWorldRect.height,
                           vp.cssWidth, vp.cssHeight, vp.dpr, vp.centerX, vp.centerY, vp.zoom}) {
      k.f64(v);
    }
    // The renderer's switches, precision and colour pipeline.
    k.u64((ctx.fxFields ? 1U : 0U) | (ctx.fxBounds ? 2U : 0U) | (ctx.fxLayerBuffers ? 4U : 0U) | (layerFxEnabled_ ? 8U : 0U) |
          (ctx.colorSystem != nullptr ? 16U : 0U) | (ctx.color.managed ? 32U : 0U));
    k.u64((std::uint64_t{view.bit_depth} << 8U) | (view.float16_textures ? 1U : 0U) | (view.float32_textures ? 2U : 0U));
    k.u64((static_cast<std::uint64_t>(view.working_space) << 16U) | (static_cast<std::uint64_t>(view.display_transform) << 8U));
    k.u64((static_cast<std::uint64_t>(ctx.color.working) << 40U) | (static_cast<std::uint64_t>(ctx.color.display) << 32U) |
          ctx.color.bitDepth);
    for (const double v : ctx.color.fromLinear709) k.f64(v);
    // Comp-level inputs a layer of the subtree reads (advanced blends: the comp's size, Dissolve's frame).
    k.f64(scene.width);
    k.f64(scene.height);
    k.f64(scene.dissolve_frame.value_or(-1));
    return k.value();
  }

  /// An earlier frame's image of the precomp under `key` in `spec`'s shape (the entry's own target), or nothing.
  TexRef reuse_precomp(PassContext& ctx, std::uint64_t key, const PassContext::TargetSpec& spec) {
    if (key == 0) return {};
    PrecompCache::Entry* e = precompCache_.find(key, spec.width, spec.height, spec.format);
    if (e == nullptr) return {};
    bool created = false;
    RenderTarget& t = ctx.dev.target(e->name, e->w, e->h, e->format, 1, false, &created);
    if (created) {
      precompCache_.forget(*e);  // the pool collected it: the subtree is drawn again
      return {};
    }
    e->used = ctx.dev.frame();
    return t.tex();
  }

  /// Keep precomp `r`'s finished image (`from`, the resolved target) under
  /// `key`: an exact texel copy into a single-sample target of the same format.
  void keep_precomp(PassContext& ctx, const api::Renderable& r, bool applyMask, std::uint64_t key, const RenderTarget& from) {
    KeyMix who;
    who.str(r.id);
    who.u64(applyMask ? 1U : 0U);
    if (!precompCache_.worth_keeping(who.value(), key)) return;
    const std::uint64_t bytes = std::uint64_t{from.width} * from.height * texel_bytes(from.format);
    PrecompCache::Entry* e = precompCache_.claim(key, from.width, from.height, from.format, bytes, ctx.dev.frame());
    if (e == nullptr) return;  // over the budget, every other entry in use this frame
    RenderTarget& t = ctx.dev.target(e->name, from.width, from.height, from.format, 1, false);
    copy_texels(ctx, from, t);
  }

  /// renderGeneratorField: draw a plugin generator's instances into
  /// GENERATOR_TARGET and hand the layer on as a plain textured renderable.
  bool render_generator_field(PassContext& ctx, const api::Renderable& r, api::Renderable& prepared) {
    if (!r.generator) return false;
    const auto& gen = *r.generator;
    Commands cmds;
    if (gen.count > 0) {
      std::size_t cap = 64;
      while (cap < gen.count) cap *= 2;
      const std::size_t floats = cap * gen.stride;
      std::vector<std::uint8_t> bytes(floats * 4, 0);
      const std::size_t used = std::min<std::size_t>(gen.instances.size(), std::size_t{gen.count} * gen.stride * 4);
      std::copy_n(gen.instances.begin(), used, bytes.begin());
      const wgpu::Buffer instances =
          ctx.dev.geometry("generator:instances:" + r.id + ":" + std::to_string(floats), bytes, false, true);
      const double w = gen.width > 0 ? gen.width : 1;
      const double h = gen.height > 0 ? gen.height : 1;
      const Mat3 fieldToWorld = mul(mat3_of(r.model_matrix), mul(translation(0.5, 0.5), scaling(1 / w, 1 / h)));
      const Mat3 mvp = mvp_for(ctx.viewport, fieldToWorld);
      const TexRef texture = gen.texture_key && ctx.texture_ready(*gen.texture_key) ? ctx.texture(*gen.texture_key) : TexRef{};
      const double kind = gen.primitive == api::RenderGeneratorPrimitive::point  ? 0
                          : gen.primitive == api::RenderGeneratorPrimitive::quad ? 1
                                                                                 : 2;
      const double focal = gen.perspective.value_or(0);
      const double cw = gen.cell_size.size() > 1 ? gen.cell_size[0] : 1;
      const double chh = gen.cell_size.size() > 1 ? gen.cell_size[1] : 1;
      const Blend blend = gen.blend == api::RenderGeneratorBlend::add ? Blend::add : Blend::normal;
      const bool wide = gen.stride == 11;
      // packGenerator: mat3 mvp + (kind, focal, cell). Copied out of the scratch
      // packer so two calls cannot alias.
      const auto uniforms = [&](double k) {
        Packer p = ctx.packer();
        const std::span<const float> u = p.mat3(mvp).vec4(k, focal, cw, chh).span();
        return std::vector<float>(u.begin(), u.end());
      };
      if (gen.primitive == api::RenderGeneratorPrimitive::mesh) {
        const TexRef meshTex = texture ? texture : ctx.texture("texture:white");
        if (gen.mesh_vertices && gen.mesh_indices && meshTex) {
          const std::string rev = std::to_string(static_cast<std::int64_t>(gen.revision));
          const bool u32 = gen.mesh_index_format == api::RenderIndexFormat::uint32;
          DrawItem& it = cmds.add(wide ? Mat::GENERATOR_MESH_WIDE_MATERIAL : Mat::GENERATOR_MESH_MATERIAL, blend, uniforms(kind));
          it.texture = meshTex;
          it.sampler = ctx.linear_clamp();
          it.vertexBuffer = ctx.dev.geometry("generator:mesh-v:" + r.id + ":" + rev, *gen.mesh_vertices, false);
          it.indexBuffer = ctx.dev.geometry("generator:mesh-i:" + r.id + ":" + rev, *gen.mesh_indices, true);
          it.indexCount = static_cast<std::uint32_t>(gen.mesh_indices->size() / (u32 ? 4 : 2));
          it.indexFormat = u32 ? wgpu::IndexFormat::Uint32 : wgpu::IndexFormat::Uint16;
          it.instanceBuffer = instances;
          it.instanceCount = gen.count;
        }
      } else if (gen.primitive == api::RenderGeneratorPrimitive::sprite && texture && wide) {
        DrawItem& it = cmds.add(Mat::GENERATOR_SPRITE_MATERIAL, blend, uniforms(kind));
        it.texture = texture;
        it.sampler = ctx.linear_clamp();
        it.instanceBuffer = instances;
        it.instanceCount = gen.count;
      } else {
        DrawItem& it = cmds.add(wide ? Mat::GENERATOR_POINT_WIDE_MATERIAL : Mat::GENERATOR_POINT_MATERIAL, blend,
                                uniforms(gen.primitive == api::RenderGeneratorPrimitive::sprite ? 0 : kind));
        it.instanceBuffer = instances;
        it.instanceCount = gen.count;
      }
    }
    if (ctx.target(kGeneratorTarget) == nullptr) return false;
    ctx.draw_into(kGeneratorTarget, cmds, true);
    if (!r.texture_key) return false;
    precompTex_[*r.texture_key] = ctx.target(kGeneratorTarget)->tex();
    prepared = r;
    prepared.generator.reset();
    prepared.kind = api::RenderableKind::image;
    const Mat3 full = model_from_rect(ctx.viewport.visibleWorldRect);
    prepared.model_matrix.assign(full.m.begin(), full.m.end());
    const Rect v = ctx.viewport.visibleWorldRect;
    prepared.bounds = {v.x, v.y, v.width, v.height};
    prepared.uv_rect = api::Rect{0, 0, 1, 1};
    prepared.color = api::Color{1, 1, 1, 1};
    return true;
  }

  void render_list(PassContext& ctx, const std::vector<const api::Renderable*>& list, const std::string& out,
                   std::size_t depth) {
    ListState st;
    st.out = out;
    st.depth = depth;
    for (const api::Renderable* r : list) st.byId.emplace(r->id, r);
    // A contiguous run of depth-eligible 3D renderables → one depth-tested group
    // (renderList). Shadow-mapped light washes are never hoisted here: a frame
    // with a mapped light is refused until shadow maps are ported.
    const bool canDepthGroup = ctx.scope.camera3d != nullptr && ctx.target(out) != nullptr;
    const Rect visible = ctx.viewport.visibleWorldRect;
    // E8: the index past the frame's last depth-eligible renderable (root list only).
    const bool rootList = depth == 0 && ctx.scope.all == &ctx.file.scene.renderables;
    std::size_t lastEligibleEnd = 0;
    if (rootList && ctx.groundGridPending) {
      for (std::size_t k = 0; k < list.size(); ++k) {
        if (depth_eligible_3d(*list[k])) lastEligibleEnd = k + 1;
      }
    }
    // A sampled frame (gpu_profiler.hpp) times each root-level layer on its
    // own: its scope is set before it draws and its batch is flushed after it,
    // so no pass mixes two layers. Same draws, same order: the same pixels.
    GpuProfiler& prof = ctx.dev.profiler();
    const bool profiling = rootList && prof.active();
    std::size_t i = 0;
    while (i < list.size()) {
      if (canDepthGroup && depth_eligible_3d(*list[i])) {
        if (profiling) {
          flush(ctx, st);
          prof.set_scope(list[i]->id, GpuScopeCost::Kind::scene3d);
        }
        std::vector<const api::Renderable*> group;
        while (i < list.size() && depth_eligible_3d(*list[i])) {
          const api::Renderable* g = list[i];
          if (rects_intersect(visible, rect_of(g->bounds)) && g->opacity > 0) group.push_back(g);
          ++i;
        }
        if (!group.empty()) {
          flush(ctx, st);
          ctx.groundGridRun = rootList && ctx.groundGridPending && i >= lastEligibleEnd;
          // 3D quads sample their content mipmapped (anisotropic in threed.cpp):
          // a layer at a steep angle no longer drops a thin stroke into dots.
          render_3d_group(ctx, group, out, st.byId, [this, &ctx](const std::optional<std::string>& k) {
            if (k && precompTex_.find(*k) == precompTex_.end()) return ctx.texture_mipmapped(*k);
            return tex_for(ctx, k);
          },
                          *this);
        }
        continue;
      }
      if (profiling) prof.set_scope(list[i]->id);
      process(ctx, *list[i], st);
      if (profiling) flush(ctx, st);
      ++i;
    }
    flush(ctx, st);
    if (profiling) prof.clear_scope();
  }

  void process(PassContext& ctx, const api::Renderable& r0, ListState& st) {
    const Rect visible = ctx.viewport.visibleWorldRect;
    const Rect targetUv{0, 0, 1, 1};  // WebGPU writes targets top-down: identity UV
    if (r0.matte_source) return;

    api::Renderable folded;
    const api::Renderable* rp = &r0;
    if (r0.three_d && r0.three_d->shade && r0.three_d->shade->quad_gain.size() >= 3 && r0.color) {
      folded = r0;
      const auto& g = r0.three_d->shade->quad_gain;
      folded.color = api::Color{r0.color->r * g[0], r0.color->g * g[1], r0.color->b * g[2], r0.color->a};
      rp = &folded;
    }

    api::Renderable prepared;
    if (r0.precomp) {
      if (!rects_intersect(visible, rect_of(r0.bounds)) || r0.opacity <= 0) return;
      if (!prepare_isolated_precomp(ctx, r0, st, st.depth, true, prepared)) return;
      rp = &prepared;
    }
    if (r0.generator) {
      if (r0.opacity <= 0) return;
      flush(ctx, st);
      if (!render_generator_field(ctx, *rp, prepared)) return;
      rp = &prepared;
    }
    const api::Renderable& r = *rp;

    // Precomps this layer needs besides its own are drawn BEFORE it, each into
    // its own precomp slot: a precomp's subtree runs through process() too, so a
    // matte or effect inside it writes the shared layer / matte / blur targets,
    // and drawn after the layer (or from inside its effect chain) it would
    // overwrite the layer's image. The matte source takes depth + 1, the
    // precomps the effects read as maps the slots after it.
    const MapPrecompScope maps(mapPrecomps_);
    const auto matteIt = r.matte ? st.byId.find(r.matte->source_id) : st.byId.end();
    const api::Renderable* matteSource = matteIt != st.byId.end() ? matteIt->second : nullptr;
    api::Renderable preparedSource;
    if (matteSource != nullptr && matteSource->precomp) {
      matteSource = prepare_isolated_precomp(ctx, *matteSource, st, st.depth + 1, false, preparedSource) ? &preparedSource : nullptr;
    }
    if (r.matte || r.adjustment || (rects_intersect(visible, rect_of(r.bounds)) && r.opacity > 0)) {
      prepare_map_precomps(ctx, r, st, st.depth + 2 + mapPrecomps_.size());
      if (matteSource != nullptr) prepare_map_precomps(ctx, *matteSource, st, st.depth + 2 + mapPrecomps_.size());
    }

    if (r.matte) {
      if (matteIt != st.byId.end()) {
        flush(ctx, st);
        const api::Renderable* source = matteSource;
        const TexRef matted = layer_into_target(ctx, r, r.opacity, kLayerTarget, st);
        const TexRef matte = source != nullptr ? layer_into_target(ctx, *source, 1, kMatteTarget, st) : TexRef{};
        if (matte && matted) {
          ColorTransform mode;
          mode.m = {r.matte->mode == api::RenderMatteMode::luma ? 1.0 : 0.0, r.matte->inverted ? 1.0 : 0.0, 0, 0, 0, 0, 0, 0, 0};
          emit_matte_combine(ctx, st.main, screen_mvp(), blend_of(r.blend), matted, ctx.linear_clamp(), matte, mode, targetUv);
        } else {
          ctx.diagnostics.push_back({"matte-source-unavailable", "Track matte on \"" + r.id + "\" could not be built"});
        }
        return;
      }
      ctx.diagnostics.push_back({"matte-source-unavailable", "Track matte on \"" + r.id + "\" references a missing source"});
    }

    if (r.adjustment) {
      flush(ctx, st);
      RenderTarget* scene = ctx.target(st.out);
      if (scene == nullptr) return;
      const TexRef sceneTex = scene->tex();
      Commands copy;
      const TexRef lut = r.adjustment->lut_texture_key ? ctx.texture(*r.adjustment->lut_texture_key) : TexRef{};
      const ColorTransform ct = color_transform(r.adjustment->color_matrix);
      if (lut) {
        emit_lut_textured(ctx, copy, screen_mvp(), Color::white(), 1, Blend::normal, sceneTex, ctx.linear_clamp(), lut,
                          targetUv, ct, true);
      } else {
        emit_textured(ctx, copy, screen_mvp(), Color::white(), 1, Blend::normal, sceneTex, ctx.linear_clamp(), targetUv, ct,
                      true);
      }
      ctx.draw_into(kLayerTarget, copy, true);
      TexRef finalTex = ctx.target(kLayerTarget)->tex();
      if (!r.effects.empty()) {
        const std::array<std::string_view, 4> pool = {kLayerTarget, kBlur1, kBlur2, kBlur3};
        const ChainListScope chainList(chainList_, st);
        finalTex = run_effects_chain(ctx, r.effects, finalTex, pool, st.byId, r.id, *this).tex;
      }
      Commands apply;
      emit_textured(ctx, apply, screen_mvp(), Color::white(), 1, Blend::normal, finalTex, ctx.linear_clamp(), targetUv,
                    kIdentityColor, true);
      ctx.draw_into(st.out, apply, true);
      return;
    }

    if (!rects_intersect(visible, rect_of(r.bounds)) || r.opacity <= 0) return;

    if ((r.backdrop_blur && *r.backdrop_blur > 0) || r.glass) {
      flush(ctx, st);
      RenderTarget* scene = ctx.target(st.out);
      if (scene != nullptr) {
        const TexRef sceneTex = scene->tex();
        const Mat3 fullMvp = screen_mvp();
        const TexRef layerTex = layer_into_target(ctx, r, r.opacity, kMatteTarget, st);
        const double blurRadius = r.backdrop_blur.value_or(0);
        const bool half = blurRadius > 0;
        const std::uint32_t bw = half ? std::max(1U, ctx.viewport.pixelWidth / kBackdropDownscale) : ctx.viewport.pixelWidth;
        const std::uint32_t bh = half ? std::max(1U, ctx.viewport.pixelHeight / kBackdropDownscale) : ctx.viewport.pixelHeight;
        const std::string_view t1 = half ? kBackdropHalf1 : kBlur1;
        const std::string_view t2 = half ? kBackdropHalf2 : kBlur2;
        Commands copy;
        emit_textured(ctx, copy, fullMvp, Color::white(), 1, Blend::normal, sceneTex, ctx.linear_clamp(), targetUv,
                      kIdentityColor, true);
        if (half) ctx.draw_into_sized(t1, copy, true, bw, bh);
        else ctx.draw_into(t1, copy, true);
        TexRef blurred = ctx.target(t1)->tex();
        if (blurRadius > 0) {
          const double scale = half ? kBackdropDownscale : 1;
          Commands h;
          DrawItem& hi = h.add(Mat::BLUR_MATERIAL, Blend::normal,
                               pack_blur(ctx.packer(), fullMvp, targetUv, 1.0 / bw, 0, blurRadius / scale));
          hi.texture = blurred;
          hi.sampler = ctx.linear_clamp();
          ctx.draw_into_sized(t2, h, true, bw, bh);
          Commands v;
          DrawItem& vi = v.add(Mat::BLUR_MATERIAL, Blend::normal,
                               pack_blur(ctx.packer(), fullMvp, targetUv, 0, 1.0 / bh, blurRadius / scale));
          vi.texture = ctx.target(t2)->tex();
          vi.sampler = ctx.linear_clamp();
          ctx.draw_into_sized(t1, v, true, bw, bh);
          blurred = ctx.target(t1)->tex();
        }
        if (blurred && layerTex) {
          if (r.glass) {
            const auto& g = *r.glass;
            Packer p = ctx.packer();
            p.mat3(fullMvp).rect(targetUv);
            p.vec4(g.refraction, g.edge_width, g.aberration, g.saturation);
            p.vec4(g.tint.r, g.tint.g, g.tint.b, g.tint.a * g.tint_opacity);
            p.vec4(g.rim.r, g.rim.g, g.rim.b, g.rim.a * g.rim_opacity);
            p.vec4(g.rim_width, g.rim_angle, g.specular_intensity, g.specular_falloff);
            p.vec4(g.specular_angle, g.grain, 1.0 / ctx.viewport.pixelWidth, 1.0 / ctx.viewport.pixelHeight);
            DrawItem& it = st.main.add(Mat::GLASS_MATERIAL, Blend::normal, p.span());
            it.texture = std::move(blurred);
            it.sampler = ctx.linear_clamp();
            it.mask = layerTex;
          } else {
            emit_masked_textured(ctx, st.main, fullMvp, Color::white(), 1, Blend::normal, blurred, ctx.linear_clamp(),
                                 layerTex, targetUv, kIdentityColor, true);
            emit_textured(ctx, st.main, fullMvp, Color::white(), 1, blend_of(r.blend), layerTex, ctx.linear_clamp(), targetUv,
                          kIdentityColor, true);
          }
        }
        return;
      }
    }

    if ((r.advanced_blend && *r.advanced_blend > 0) || r.preserve_transparency) {
      flush(ctx, st);
      RenderTarget* scene = ctx.target(st.out);
      if (scene != nullptr) {
        const TexRef sceneTex = scene->tex();
        const TexRef layerTex = layer_into_target(ctx, r, r.opacity, kLayerTarget, st);
        Commands copy;
        emit_textured(ctx, copy, screen_mvp(), Color::white(), 1, Blend::normal, sceneTex, ctx.linear_clamp(), targetUv,
                      kIdentityColor, true);
        ctx.draw_into(kMatteTarget, copy, true);
        const TexRef backdrop = ctx.target(kMatteTarget)->tex();
        if (backdrop && layerTex) {
          const double ab = r.advanced_blend.value_or(0);
          ColorTransform mode;
          mode.m = {ab,
                    r.preserve_transparency ? 1.0 : 0.0,
                    ab == 36 ? ctx.file.scene.dissolve_frame.value_or(0) : 0.0,
                    ctx.file.scene.width,
                    ctx.file.scene.height,
                    0,
                    0,
                    0,
                    0};
          Commands combine;
          emit_blend_combine(ctx, combine, screen_mvp(), Blend::none, layerTex, ctx.linear_clamp(), backdrop, mode, targetUv);
          ctx.draw_into(st.out, combine, false);
        }
        return;
      }
    }

    const bool hasEffects = !r.effects.empty();
    const bool hasMotion = r.motion_samples.size() > 1;

    if (!hasEffects && !hasMotion) {
      // Straight into the list under the layer's own blend (the same draw a
      // chain input gets: layer-edge antialiasing, the mip-filtered texture).
      const Blend blend = blend_of(r.blend);
      renderable_cmds(ctx, r, r.opacity, st.main, nullptr, &blend);
      return;
    }

    flush(ctx, st);
    // P8: a layer whose chain input and parameters match a kept result is a copy of it.
    // P8b: the input is drawn at its own sub-pixel phase and keyed without its
    // place (with the phase), so a layer that only moves by whole pixels reuses
    // its chain — the result composited where the layer is by a whole-pixel shift.
    const PixelSnap snap = hasEffects && layerFxEnabled_ ? pixel_snap(ctx, r) : PixelSnap{};
    // The layer's draw and its chain see the view moved to its buffer placement (restored at scope end).
    const ViewShift shiftView(ctx, snap.on ? snap.bx - snap.px : 0, snap.on ? snap.by - snap.py : 0);
    const std::uint64_t contentKey =
        hasEffects ? chain_content_key(ctx, r, 1,
                                       snap.on ? std::optional(std::array<double, 2>{phase_of(snap.bx), phase_of(snap.by)}) : std::nullopt)
                   : 0;
    const std::uint64_t fxKey = hasEffects && layerFxEnabled_ ? layer_fx_key(ctx, r, contentKey, 1) : 0;
    const double vw = ctx.viewport.pixelWidth;
    const double vh = ctx.viewport.pixelHeight;
    const auto composite = [&](const TexRef& tex, const std::optional<PxBox>& covered, double dx, double dy) {
      const Blend blend = blend_of(r.blend);
      const Mat3 mvp = dx == 0 && dy == 0 ? screen_mvp() : mul(translation(2 * dx / vw, -2 * dy / vh), screen_mvp());
      emit_textured(ctx, st.main, mvp, Color::white(), r.opacity, blend, tex, ctx.linear_clamp(), targetUv, kIdentityColor, true);
      const std::optional<PxBox> at = shifted(covered, dx, dy);
      if (at && transparent_is_noop(blend)) st.main.last().scissor = scissor_of(*at, ctx.viewport.pixelWidth, ctx.viewport.pixelHeight);
    };
    if (snap.on) {
      if (const std::optional<KeptFx> kept = reuse_layer_fx_moved(ctx, fxKey, snap)) {
        composite(kept->tex, kept->covered, kept->dx, kept->dy);
        return;
      }
    } else if (const std::optional<ChainResult> kept = reuse_layer_fx(ctx, fxKey, {})) {
      composite(kept->tex, kept->covered, 0, 0);
      return;
    }
    Commands layerCmds;
    if (hasMotion) {
      const auto n = static_cast<double>(r.motion_samples.size());
      const Blend add = Blend::add;
      for (const auto& s : r.motion_samples) {
        const Mat3 m = mat3_of(s.model_matrix);
        renderable_cmds(ctx, r, s.opacity / n, layerCmds, &m, &add);
      }
    } else {
      renderable_cmds(ctx, r, 1, layerCmds);
    }
    if (layerCmds.empty()) return;
    ctx.draw_into(kLayerTarget, layerCmds, true);
    const TexRef layerTex = ctx.target(kLayerTarget)->tex();
    if (!hasEffects) {
      emit_textured(ctx, st.main, screen_mvp(), Color::white(), 1, blend_of(r.blend), layerTex, ctx.linear_clamp(), targetUv,
                    kIdentityColor, true);
      return;
    }
    const std::array<std::string_view, 4> pool = {kLayerTarget, kBlur1, kBlur2, kBlur3};
    const ChainListScope chainList(chainList_, st);
    const ChainResult res = run_effects_chain(ctx, r.effects, layerTex, pool, st.byId, r.id, *this, nullptr, contentKey,
                                              drawn_box(ctx, r));
    keep_layer_fx(ctx, r.id, fxKey, res.tex, res.name, res.covered, &snap);
    // Outside the chain's reach its result is transparent: the composite covers the reach, not the frame.
    // Drawn at the layer's own phase: the way back is whole pixels (an exact copy).
    composite(res.tex, res.covered, snap.on ? std::round(snap.px - snap.bx) : 0, snap.on ? std::round(snap.py - snap.by) : 0);
  }

};

}  // namespace

std::unique_ptr<RenderPass> make_composition_pass() { return std::make_unique<CompositionPass>(); }

}  // namespace premation::rg
