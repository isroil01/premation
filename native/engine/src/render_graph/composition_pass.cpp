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
#include <cmath>
#include <cstdlib>
#include <string>
#include <unordered_map>
#include <vector>

#include "effect_chain.hpp"
#include "passes.hpp"
#include "render_context.hpp"
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

// ── emit helpers (passUtils.ts) ─────────────────────────────────────────────

void emit_solid(PassContext& ctx, Commands& cmds, const Mat3& mvp, const Color& c, double opacity, Blend blend,
                const SolidShape& shape) {
  cmds.add(Mat::SOLID_MATERIAL, blend, pack_solid(ctx.packer(), mvp, c, opacity, shape));
}

void emit_textured(PassContext& ctx, Commands& cmds, const Mat3& mvp, const Color& tint, double opacity, Blend blend,
                   const TexRef& tex, const SamplerRef& smp, const Rect& uv, const ColorTransform& ct, bool sampleLinear) {
  DrawItem& it = cmds.add(sampleLinear ? Mat::TEXTURED_LINEAR_MATERIAL : Mat::TEXTURED_MATERIAL, blend,
                          pack_textured(ctx.packer(), mvp, uv, tint, opacity, ct, sampleLinear));
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
                          const ColorTransform& ct, bool sampleLinear) {
  DrawItem& it = cmds.add(sampleLinear ? Mat::MASKED_TEXTURED_LINEAR_MATERIAL : Mat::MASKED_TEXTURED_MATERIAL, blend,
                          pack_textured(ctx.packer(), mvp, uv, tint, opacity, ct, sampleLinear));
  it.texture = tex;
  it.sampler = smp;
  it.mask = mask;
}

void emit_lut_textured(PassContext& ctx, Commands& cmds, const Mat3& mvp, const Color& tint, double opacity, Blend blend,
                       const TexRef& tex, const SamplerRef& smp, const TexRef& lut, const Rect& uv,
                       const ColorTransform& ct, bool sampleLinear) {
  DrawItem& it = cmds.add(sampleLinear ? Mat::LUT_TEXTURED_LINEAR_MATERIAL : Mat::LUT_TEXTURED_MATERIAL, blend,
                          pack_textured(ctx.packer(), mvp, uv, tint, opacity, ct, sampleLinear));
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
                        const Blend* blendOverride, bool sampleLinear) {
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
  emit_textured(ctx, cmds, mvp, color_or_white(r), opacity, blend, tex, smp, r.uv_rect ? rect_of(*r.uv_rect) : uv,
                color_transform(r.color_matrix), sampleLinear);
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
                                  std::string(kGeneratorTarget)};
    for (const auto n : kPrecompTargets) w.emplace_back(n);
    return w;
  }
  [[nodiscard]] std::vector<std::string> after() const override { return {"background"}; }

  bool execute(PassContext& ctx, std::string& /*error*/) override {
    precompTex_.clear();
    owned_.clear();  // last frame's synthesized renderables
    std::vector<const api::Renderable*> list;
    list.reserve(ctx.file.scene.renderables.size());
    for (const auto& r : ctx.file.scene.renderables) list.push_back(&r);
    render_list(ctx, list, ctx.activeColorTarget, 0);
    return true;
  }

 private:
  /// Offscreen textures of isolated precomps rendered this frame, by `precomp:<id>` key.
  std::unordered_map<std::string, TexRef> precompTex_;
  /// Renderables synthesized this frame (reparented precomp children, prepared containers).
  std::vector<std::unique_ptr<std::vector<api::Renderable>>> owned_;

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

  /// renderableCmds: one renderable (solid / textured / masked / LUT) at `opacity`.
  void renderable_cmds(PassContext& ctx, const api::Renderable& r, double opacity, Commands& cmds,
                       const Mat3* modelOverride = nullptr, const Blend* blendOverride = nullptr) {
    const Blend blend = blendOverride != nullptr ? *blendOverride : Blend::normal;
    const SamplerRef smp = sampler_for(ctx, r);
    const Rect uv = uv_or_full(r);
    const Mat3 mvp = mvp_for(ctx.viewport, modelOverride != nullptr ? *modelOverride : mat3_of(r.model_matrix));
    const bool solid = is_solid_kind(r.kind);
    const bool textured = is_textured_kind(r.kind);
    if (r.mask_texture_key) {
      const TexRef mask = ctx.texture(*r.mask_texture_key);
      TexRef tex = textured && r.texture_key ? tex_for(ctx, r.texture_key) : TexRef{};
      if (solid && !tex) tex = ctx.texture("texture:white");
      if (mask && tex) {
        emit_masked_textured(ctx, cmds, mvp, color_or_white(r), opacity, blend, tex, smp, mask, uv,
                             color_transform(r.color_matrix), tex.sampleLinear);
      }
    } else if (solid && r.color) {
      emit_solid(ctx, cmds, mvp, color_of(*r.color), opacity, blend, to_solid_shape(r.sdf));
    } else if (textured && r.texture_key) {
      const TexRef tex = tex_for(ctx, r.texture_key);
      const TexRef lut = r.lut_texture_key ? ctx.texture(*r.lut_texture_key) : TexRef{};
      if (tex && lut) {
        emit_lut_textured(ctx, cmds, mvp, color_or_white(r), opacity, blend, tex, smp, lut, uv,
                          color_transform(r.color_matrix), tex.sampleLinear);
      } else if (tex) {
        emit_layer_texture(ctx, cmds, r, tex, smp, uv, opacity, modelOverride, blendOverride, tex.sampleLinear);
      }
    }
  }

  /// layerIntoTarget: content (+ motion-blur accumulation) into `dest`, then its effect chain, settled in `dest`.
  TexRef layer_into_target(PassContext& ctx, const api::Renderable& r, double opacity, std::string_view dest,
                           const ListState& st) {
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
    return apply_layer_effects(ctx, r, t->tex(), dest, st);
  }

  TexRef apply_layer_effects(PassContext& ctx, const api::Renderable& r, const TexRef& src, std::string_view dest,
                             const ListState& st) {
    if (r.effects.empty()) return src;
    const std::array<std::string_view, 4> pool = {dest, kBlur1, kBlur2, kBlur3};
    const ChainResult res = run_effects_chain(ctx, r.effects, src, pool, st.byId, r.id, *this);
    if (res.name == dest) return res.tex;
    Commands copy;
    emit_textured(ctx, copy, screen_mvp(), Color::white(), 1, Blend::none, res.tex, ctx.linear_clamp(), {0, 0, 1, 1},
                  kIdentityColor, true);
    ctx.draw_into(dest, copy, true);
    return ctx.target(dest)->tex();
  }

 public:
  /// displacementMapTexture: render a referenced layer into MATTE_TARGET.
  TexRef map_layer(PassContext& ctx, const ById& byId, std::string_view mapLayerId, std::string_view selfId) override {
    if (mapLayerId.empty() || mapLayerId == selfId) return {};
    const auto it = byId.find(mapLayerId);
    if (it == byId.end()) return {};
    Commands cmds;
    renderable_cmds(ctx, *it->second, 1, cmds);
    if (cmds.empty()) return {};
    ctx.draw_into(kMatteTarget, cmds, true);
    return ctx.target(kMatteTarget)->tex();
  }

 private:
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
                                bool inlineFallback, api::Renderable& prepared) {
    if (!r.precomp) return false;
    const auto& pre = *r.precomp;
    const bool flat = pre.flat_width.has_value();
    const Mat3 fullModel = model_from_rect(ctx.viewport.visibleWorldRect);
    const Mat3 cardToUnit = flat ? scaling(1 / std::max(1.0, *pre.flat_width), 1 / std::max(1.0, pre.flat_height.value_or(1)))
                                 : Mat3{};
    std::vector<const api::Renderable*> kids;
    kids.reserve(r.precomp_children.size());
    for (const auto& k : r.precomp_children) kids.push_back(&k);

    if (slot >= kPrecompTargets.size()) {
      if (!inlineFallback) return false;
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
    flush(ctx, st);
    const std::string_view targetName = kPrecompTargets.at(slot);
    std::vector<const api::Renderable*> children = kids;
    if (flat) {
      auto& keep = owned_.emplace_back(
          std::make_unique<std::vector<api::Renderable>>(reparent(kids, mul(fullModel, cardToUnit))));
      children.clear();
      for (const auto& c : *keep) children.push_back(&c);
    }
    {
      const Commands none;
      ctx.draw_into(targetName, none, true);
    }
    // precompScope: a sealed comp instance with its own 3D frame replaces the
    // camera, lights and environment wholesale (SSAO off) for its subtree.
    const Scope3D saved = ctx.scope;
    if (pre.camera3d) ctx.scope = Scope3D{&*pre.camera3d, &pre.lights3d, pre.env_map ? &*pre.env_map : nullptr, false};
    render_list(ctx, children, std::string(targetName), slot + 1);
    ctx.scope = saved;
    RenderTarget* pt = ctx.target(targetName);
    if (pt == nullptr) return false;
    TexRef tex = pt->tex();

    if (r.mask_texture_key) {
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
          prepared.motion_samples.push_back({std::vector<double>(m.m.begin(), m.m.end()), s.opacity});
        }
      } else if (flat) {
        prepared.motion_samples = r.motion_samples;
      }
    }
    return true;
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
    std::size_t i = 0;
    while (i < list.size()) {
      if (canDepthGroup && depth_eligible_3d(*list[i])) {
        std::vector<const api::Renderable*> group;
        while (i < list.size() && depth_eligible_3d(*list[i])) {
          const api::Renderable* g = list[i];
          if (rects_intersect(visible, rect_of(g->bounds)) && g->opacity > 0) group.push_back(g);
          ++i;
        }
        if (!group.empty()) {
          flush(ctx, st);
          render_3d_group(ctx, group, out, st.byId, [this, &ctx](const std::optional<std::string>& k) { return tex_for(ctx, k); },
                          *this);
        }
        continue;
      }
      process(ctx, *list[i], st);
      ++i;
    }
    flush(ctx, st);
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

    if (r.matte) {
      const auto it = st.byId.find(r.matte->source_id);
      if (it != st.byId.end()) {
        flush(ctx, st);
        const TexRef matted = layer_into_target(ctx, r, r.opacity, kLayerTarget, st);
        const api::Renderable* source = it->second;
        api::Renderable preparedSource;
        if (source->precomp) {
          source = prepare_isolated_precomp(ctx, *source, st, st.depth + 1, false, preparedSource) ? &preparedSource : nullptr;
        }
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
    const bool solid = is_solid_kind(r.kind);
    const bool textured = is_textured_kind(r.kind);

    if (!hasEffects && !hasMotion) {
      const Mat3 mvp = mvp_for(ctx.viewport, mat3_of(r.model_matrix));
      if (r.mask_texture_key) {
        const TexRef mask = ctx.texture(*r.mask_texture_key);
        if (mask) {
          TexRef tex = textured && r.texture_key ? tex_for(ctx, r.texture_key) : TexRef{};
          if (solid && !tex) tex = ctx.texture("texture:white");
          if (tex) {
            emit_masked_textured(ctx, st.main, mvp, color_or_white(r), r.opacity, blend_of(r.blend), tex, ctx.linear_clamp(),
                                 mask, uv_or_full(r), color_transform(r.color_matrix), tex.sampleLinear);
          }
        }
      } else if (solid && r.color) {
        emit_solid(ctx, st.main, mvp, color_of(*r.color), r.opacity, blend_of(r.blend), to_solid_shape(r.sdf));
      } else if (textured && r.texture_key) {
        const TexRef tex = tex_for(ctx, r.texture_key);
        if (tex) {
          const Rect uv = uv_or_full(r);
          const TexRef lut = r.lut_texture_key ? ctx.texture(*r.lut_texture_key) : TexRef{};
          if (lut) {
            emit_lut_textured(ctx, st.main, mvp, color_or_white(r), r.opacity, blend_of(r.blend), tex, ctx.linear_clamp(), lut,
                              uv, color_transform(r.color_matrix), tex.sampleLinear);
          } else {
            emit_layer_texture(ctx, st.main, r, tex, ctx.linear_clamp(), uv, r.opacity, nullptr, nullptr, tex.sampleLinear);
          }
        }
      }
      return;
    }

    flush(ctx, st);
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
    const TexRef effectTex = run_effects_chain(ctx, r.effects, layerTex, pool, st.byId, r.id, *this).tex;
    emit_textured(ctx, st.main, screen_mvp(), Color::white(), r.opacity, blend_of(r.blend), effectTex, ctx.linear_clamp(),
                  targetUv, kIdentityColor, true);
  }

};

}  // namespace

std::unique_ptr<RenderPass> make_composition_pass() { return std::make_unique<CompositionPass>(); }

}  // namespace premation::rg
