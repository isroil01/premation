// render3DGroup, ported: depth-tested quads (solid / textured / masked / LUT),
// extruded + model meshes (flat, textured, glTF PBR maps), effect-laden 3D
// layers pre-resolved in layer space with a margin, per-fragment lighting via
// the shade tail, and image-based reflections. Shadow maps, SSAO and the camera
// DOF gather are refused by `unported_3d` until they are ported.
#include "threed.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <cstring>
#include <numbers>

#include "passes.hpp"

namespace premation::rg {

// emit helpers from composition_pass.cpp
void emit_textured(PassContext& ctx, Commands& cmds, const Mat3& mvp, const Color& tint, double opacity, Blend blend,
                   const TexRef& tex, const SamplerRef& smp, const Rect& uv, const ColorTransform& ct, bool sampleLinear);
void emit_solid(PassContext& ctx, Commands& cmds, const Mat3& mvp, const Color& c, double opacity, Blend blend,
                const SolidShape& shape);
void emit_masked_textured(PassContext& ctx, Commands& cmds, const Mat3& mvp, const Color& tint, double opacity,
                          Blend blend, const TexRef& tex, const SamplerRef& smp, const TexRef& mask, const Rect& uv,
                          const ColorTransform& ct, bool sampleLinear);
void emit_lut_textured(PassContext& ctx, Commands& cmds, const Mat3& mvp, const Color& tint, double opacity, Blend blend,
                       const TexRef& tex, const SamplerRef& smp, const TexRef& lut, const Rect& uv,
                       const ColorTransform& ct, bool sampleLinear);

namespace {

constexpr std::size_t kMaxLights = 8;
constexpr std::uint32_t kEnvSpecLevels = 5;
constexpr double kBlurTail = 2.5;
constexpr double kMaxFxMargin = 1.5;
constexpr std::size_t kShadeFloats = 16 + 4 + 4 + static_cast<std::size_t>(kMaxLights) * 4 * 4 + 4 + 8 + 20 + std::size_t{28} * 2;

Blend blend_of(api::RenderBlendMode b) { return static_cast<Blend>(static_cast<std::uint32_t>(b)); }

SolidShape solid_shape(const std::optional<api::RenderSdf>& sdf) {
  if (!sdf) return {};
  if (sdf->shape == api::RenderSdfShape::ellipse) return {2, 0, sdf->width, sdf->height};
  return {1, std::max(0.0, std::min(sdf->radius_px, std::min(sdf->width, sdf->height) / 2)), sdf->width, sdf->height};
}

ColorTransform color_transform(const std::optional<api::RenderColorMatrix>& cm) {
  ColorTransform ct;
  if (!cm) return ct;
  for (std::size_t i = 0; i < 9 && i < cm->m.size(); ++i) ct.m.at(i) = cm->m[i];
  for (std::size_t i = 0; i < 3 && i < cm->offset.size(); ++i) ct.offset.at(i) = cm->offset[i];
  return ct;
}

/// Shade3D (uniforms.ts), as the C++ graph builds it per draw.
struct Shade {
  std::vector<double> model;
  std::array<double, 3> eye{};
  double specular = 0;
  double shininess = 0;
  std::optional<double> metal, roughness, toonBands;
  bool oneSided = false;
  std::optional<std::array<double, 3>> env;  // intensity, rotationRad, scale
  std::optional<double> reflectionIntensity, reflectionSharpness, reflectionRolloff, transparency, transparencyRolloff, ior;
  const std::vector<api::RenderLight3D>* lights = nullptr;
  double kAmbient = 1;
  double kDiffuse = 1;
  /// A shadow-mapped light's receiver block (packShade3D's shadow / shadow2).
  struct ShadowBlock {
    Mat4 matrix;
    std::array<double, 3> axis{};
    std::array<double, 3> origin{};
    double invFar = 0, darkness = 0, bias = 0, step = 0;
    /// Index of the light in scene.lights3d (resolved after filtering at pack time).
    std::size_t light = 0;
  };
  std::optional<ShadowBlock> shadow, shadow2;
  /// SSAO receiver block: world → main-camera clip + strength.
  std::optional<Mat4> aoMatrix;
  double aoStrength = 0;
};

/// packShade3D: the 240-float tail.
void pack_shade(Packer& p, const Shade* s) {
  std::array<float, kShadeFloats> out{};
  if (s != nullptr) {
    std::size_t o = 0;
    for (std::size_t i = 0; i < 16; ++i) out.at(o + i) = f32(i < s->model.size() ? s->model[i] : 0);
    o += 16;
    out.at(o + 0) = f32(s->eye[0]);
    out.at(o + 1) = f32(s->eye[1]);
    out.at(o + 2) = f32(s->eye[2]);
    const bool toon = s->toonBands.has_value();
    out.at(o + 3) = toon ? (s->oneSided ? 4.0F : 3.0F) : s->oneSided ? 2.0F : 1.0F;
    o += 4;
    std::vector<const api::RenderLight3D*> lights;
    std::vector<double> gains;
    std::vector<std::size_t> sceneIndex;
    for (std::size_t li = 0; li < s->lights->size(); ++li) {
      const auto& l = (*s->lights)[li];
      const double gain = l.gain * (l.type == api::RenderLightType::ambient ? s->kAmbient : s->kDiffuse);
      if (gain > 0 && lights.size() < kMaxLights) {
        lights.push_back(&l);
        gains.push_back(gain);
        sceneIndex.push_back(li);
      }
    }
    out.at(o + 0) = static_cast<float>(lights.size());
    out.at(o + 1) = f32(s->specular);
    out.at(o + 2) = f32(toon ? std::max(2.0, std::min(8.0, std::floor(*s->toonBands + 0.5)))
                             : s->roughness ? -std::max(0.001, std::min(1.0, *s->roughness))
                                            : s->shininess);
    out.at(o + 3) = f32(s->metal.value_or(0));
    o += 4;
    ColorPipeline cp = p.pipeline();
    for (std::size_t i = 0; i < lights.size(); ++i) {
      const auto& l = *lights[i];
      out.at(o + 0) = f32(l.x);
      out.at(o + 1) = f32(l.y);
      out.at(o + 2) = f32(l.z);
      out.at(o + 3) = static_cast<float>(static_cast<std::uint32_t>(l.type));
      const Color lc = to_working({l.color.size() > 2 ? l.color[0] : 1, l.color.size() > 2 ? l.color[1] : 1,
                                   l.color.size() > 2 ? l.color[2] : 1, 1},
                                  cp);
      out.at(o + 4) = f32(lc.r);
      out.at(o + 5) = f32(lc.g);
      out.at(o + 6) = f32(lc.b);
      out.at(o + 7) = f32(gains[i]);
      out.at(o + 8) = f32(l.radius);
      out.at(o + 9) = f32(l.half_cone_rad);
      out.at(o + 10) = f32(l.aim_x);
      out.at(o + 11) = f32(l.aim_y);
      out.at(o + 12) = f32(l.aim_z);
      out.at(o + 13) = f32(l.cone_feather_rad);
      out.at(o + 14) = f32(l.falloff_mode);
      out.at(o + 15) = f32(l.falloff_distance);
      o += 16;
    }
    const std::size_t envAt = kShadeFloats - 56 - 20 - 8 - 4;
    if (s->env) {
      out.at(envAt + 0) = 1;
      out.at(envAt + 1) = f32((*s->env)[0]);
      out.at(envAt + 2) = f32((*s->env)[1]);
      out.at(envAt + 3) = f32((*s->env)[2]);
    }
    const std::size_t reflAt = envAt + 4;
    const auto clamp01 = [](double v) { return std::max(0.0, std::min(1.0, v)); };
    const double ior = s->ior.value_or(1.52);
    const double rr = (ior - 1) / (ior + 1);
    out.at(reflAt + 0) = f32(clamp01(s->reflectionIntensity.value_or(1)));
    out.at(reflAt + 1) = f32(clamp01(s->reflectionSharpness.value_or(0)));
    out.at(reflAt + 2) = f32(clamp01(s->reflectionRolloff.value_or(0)));
    out.at(reflAt + 3) = f32(rr * rr);
    out.at(reflAt + 4) = f32(clamp01(s->transparency.value_or(0)));
    out.at(reflAt + 5) = f32(clamp01(s->transparencyRolloff.value_or(0)));
    // AO block (zeros unless the run rendered an AO buffer), then the shadow blocks.
    const std::size_t aoAt = reflAt + 8;
    if (s->aoMatrix && s->aoStrength > 0) {
      for (std::size_t i = 0; i < 16; ++i) out.at(aoAt + i) = s->aoMatrix->m.at(i);
      out.at(aoAt + 16) = f32(std::max(0.0, std::min(1.0, s->aoStrength)));
      out.at(aoAt + 17) = 1;  // flipV (WebGPU)
    }
    const auto pack_block = [&](std::size_t at, const Shade::ShadowBlock& b) {
      const auto it = std::ranges::find(sceneIndex, b.light);
      if (it == sceneIndex.end()) return;
      for (std::size_t i = 0; i < 16; ++i) out.at(at + i) = b.matrix.m.at(i);
      out.at(at + 16) = f32(b.axis[0]);
      out.at(at + 17) = f32(b.axis[1]);
      out.at(at + 18) = f32(b.axis[2]);
      out.at(at + 19) = f32(b.invFar);
      out.at(at + 20) = f32(b.origin[0]);
      out.at(at + 21) = f32(b.origin[1]);
      out.at(at + 22) = f32(b.origin[2]);
      out.at(at + 23) = static_cast<float>(it - sceneIndex.begin());
      out.at(at + 24) = f32(std::max(0.0, std::min(1.0, b.darkness)));
      out.at(at + 25) = f32(b.bias);
      out.at(at + 26) = f32(b.step);
      out.at(at + 27) = 1;  // flipV: WebGPU writes targets top-down, the light's NDC +1 lands at v = 0
    };
    if (s->shadow) pack_block(aoAt + 20, *s->shadow);
    if (s->shadow2) pack_block(aoAt + 20 + 28, *s->shadow2);
  }
  for (std::size_t i = 0; i < kShadeFloats; i += 4) p.vec4(out.at(i), out.at(i + 1), out.at(i + 2), out.at(i + 3));
}

/// mvp3dFor: lift(camera2D VP) · projection3d · view3d · model.
Mat4 mvp3d(const ViewportState& vp, const api::RenderCamera3D& cam, const std::vector<double>& model) {
  const Mat4 cam2d = mat4_from_mat3(vp.viewProjection);
  const Mat4 pv = mul(mat4_of(cam.projection), mat4_of(cam.view));
  return mul(cam2d, mul(pv, mat4_of(model)));
}

void pack_textured3d(Packer& p, const Mat4& mvp, const Rect& uv, const Color& tint, double opacity, const ColorTransform& ct,
                     const Shade* shade, bool sampleLinear) {
  p.mat4(mvp).rect(uv).color(tint, opacity).color_rows(ct).src_space(sampleLinear);
  pack_shade(p, shade);
}

/// effectSpreadPx (CompositionPass.ts): how far a chain reaches outside the layer, comp px.
double effect_spread_px(const std::vector<api::RenderEffect>& effects, double layerW, double layerH) {
  double mx = 0;
  for (const auto& e : effects) {
    const Fx fx(e);
    const std::string_view t = fx.type();
    double s = 0;
    if (t == "blur" || t == "gaussian-blur" || t == "fast-box-blur") s = fx.num("radiusPx") * kBlurTail;
    else if (t == "glow") s = (fx.num("radiusPx") + fx.num("spreadPx")) * kBlurTail;
    else if (t == "deep-glow") {
      const auto a = fx.nums("aspect");
      const auto c = fx.nums("chroma");
      const double am = a.size() > 1 ? std::max(a[0], a[1]) : 1;
      const double cm = c.size() > 2 ? std::max({c[0], c[1], c[2]}) : 1;
      s = fx.num("radiusPx") * am * cm * kBlurTail;
    } else if (t == "beam-path" || t == "plugin") s = fx.num("spreadPx");
    else if (t == "beam") {
      const double sx = fx.num("startX"), ex = fx.num("endX"), sy = fx.num("startY"), ey = fx.num("endY");
      const double overX = std::max({0.0, -sx, -ex, sx - 1, ex - 1}) * layerW;
      const double overY = std::max({0.0, -sy, -ey, sy - 1, ey - 1}) * layerH;
      s = overX + overY + std::max(0.5, fx.num("thickness")) * (1 + fx.num("softness") * 3);
    } else if (t == "light-rays") s = std::hypot(fx.num("centerX"), fx.num("centerY")) + fx.num("rayLength");
    else if (t == "lens-flare") s = 3 * std::hypot(fx.num("centerX"), fx.num("centerY")) + 0.5 * std::max(layerW, layerH) * fx.num("scale");
    else if (t == "motion-tile") {
      if (fx.num("scale") != 1) s = std::numeric_limits<double>::infinity();
    } else if (t == "drop-shadow") {
      s = std::hypot(fx.num("offsetX"), fx.num("offsetY")) + (fx.num("radiusPx") + fx.num("spreadPx")) * kBlurTail;
    } else if (t == "stroke") {
      const double pos = fx.num("position");
      s = pos == 1 ? 0 : pos == 2 ? fx.num("widthPx") * 0.5 : fx.num("widthPx");
    } else if (t == "displacement-map") s = fx.num("amount");
    else if (t == "compound-blur") s = fx.num("maxRadiusPx") * kBlurTail;
    mx = std::max(mx, s);
  }
  return mx;
}

/// expandUnitQuadModel: grow a unit-quad model about its centre by (ex, ey).
std::vector<double> expand_model(const std::vector<double>& model, double ex, double ey) {
  std::vector<double> m = model;
  m.resize(16, 0);
  for (std::size_t i = 0; i < 3; ++i) {
    const double cx = m[i] * ex;
    const double cy = m[4 + i] * ey;
    m[12 + i] = m[12 + i] - (cx - m[i]) * 0.5 - (cy - m[4 + i]) * 0.5;
    m[i] = cx;
    m[4 + i] = cy;
  }
  return m;
}

// ── shadowMap.ts ─────────────────────────────────────────────────────────
struct WorldBox {
  double minX = std::numeric_limits<double>::infinity(), minY = minX, minZ = minX;
  double maxX = -std::numeric_limits<double>::infinity(), maxY = maxX, maxZ = maxX;
  [[nodiscard]] bool empty() const { return !(maxX >= minX && maxY >= minY && maxZ >= minZ); }
  void add(double x, double y, double z) {
    minX = std::min(minX, x); minY = std::min(minY, y); minZ = std::min(minZ, z);
    maxX = std::max(maxX, x); maxY = std::max(maxY, y); maxZ = std::max(maxZ, z);
  }
};

void add_transformed_box(WorldBox& b, const std::vector<double>& m, const std::array<double, 3>& lo, const std::array<double, 3>& hi) {
  for (unsigned i = 0; i < 8U; ++i) {
    const double x = (i & 1U) != 0 ? hi[0] : lo[0];
    const double y = (i & 2U) != 0 ? hi[1] : lo[1];
    const double z = (i & 4U) != 0 ? hi[2] : lo[2];
    const double w = m[3] * x + m[7] * y + m[11] * z + m[15];
    const double iw = std::abs(w) < 1e-9 ? 1 : 1 / w;
    b.add((m[0] * x + m[4] * y + m[8] * z + m[12]) * iw, (m[1] * x + m[5] * y + m[9] * z + m[13]) * iw,
          (m[2] * x + m[6] * y + m[10] * z + m[14]) * iw);
  }
}

/// Local bounds of an extruded mesh (8 floats per vertex, position first).
void mesh_bounds(const api::RenderExtrudedMesh& mesh, std::array<double, 3>& lo, std::array<double, 3>& hi) {
  const std::size_t n = mesh.vertices.size() / 4;
  lo = {std::numeric_limits<double>::infinity(), std::numeric_limits<double>::infinity(), std::numeric_limits<double>::infinity()};
  hi = {-lo[0], -lo[1], -lo[2]};
  for (std::size_t i = 0; i + 2 < n; i += 8) {
    for (std::size_t a = 0; a < 3; ++a) {
      float v = 0;
      std::memcpy(&v, std::span(mesh.vertices).subspan((i + a) * 4, 4).data(), 4);
      lo.at(a) = std::min(lo.at(a), static_cast<double>(v));
      hi.at(a) = std::max(hi.at(a), static_cast<double>(v));
    }
  }
  if (!std::isfinite(lo[0])) {
    lo = {0, 0, 0};
    hi = {0, 0, 0};
  }
}

WorldBox run_world_box(std::span<const api::Renderable* const> group) {
  WorldBox box;
  for (const api::Renderable* r : group) {
    if (!r->three_d) continue;
    if (r->extruded_mesh) {
      std::array<double, 3> lo{}, hi{};
      mesh_bounds(*r->extruded_mesh, lo, hi);
      add_transformed_box(box, r->three_d->model, lo, hi);
    } else {
      add_transformed_box(box, r->three_d->model, {0, 0, 0}, {1, 1, 0});
    }
  }
  return box;
}

using V3 = std::array<double, 3>;
V3 normalize3(double x, double y, double z) {
  const double l = std::hypot(x, y, z);
  return l < 1e-9 ? V3{0, 0, 1} : V3{x / l, y / l, z / l};
}

struct ShadowCamera {
  Mat4 matrix;
  V3 axis{};
  V3 origin{};
  double invFar = 0;
  double footprint = 0;
};

Mat4 mat4_list(std::initializer_list<double> v) {
  Mat4 m;
  std::size_t i = 0;
  for (const double x : v) m.m.at(i++) = f32(x);
  return m;
}

std::optional<ShadowCamera> shadow_camera_for(const api::RenderLight3D& light, const WorldBox& box) {
  if (light.type == api::RenderLightType::ambient || box.empty()) return std::nullopt;
  const V3 f = normalize3(light.aim_x, light.aim_y, light.aim_z);
  const V3 up = std::abs(f[1]) > 0.99 ? V3{0, 0, 1} : V3{0, 1, 0};
  const V3 r = normalize3(up[1] * f[2] - up[2] * f[1], up[2] * f[0] - up[0] * f[2], up[0] * f[1] - up[1] * f[0]);
  const V3 u = normalize3(f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]);
  const double cx = (box.minX + box.maxX) / 2;
  const double cy = (box.minY + box.maxY) / 2;
  const double cz = (box.minZ + box.maxZ) / 2;
  const double radius = std::max(1.0, 0.5 * std::hypot(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ));
  const auto view_of = [&](const V3& eye) {
    const auto dot = [&](const V3& a) { return a[0] * eye[0] + a[1] * eye[1] + a[2] * eye[2]; };
    return mat4_list({r[0], u[0], f[0], 0, r[1], u[1], f[1], 0, r[2], u[2], f[2], 0, -dot(r), -dot(u), -dot(f), 1});
  };
  const auto corners = [&](const V3& eye) {
    std::array<V3, 8> out{};
    for (unsigned i = 0; i < 8U; ++i) {
      const double dx = ((i & 1U) != 0 ? box.maxX : box.minX) - eye[0];
      const double dy = ((i & 2U) != 0 ? box.maxY : box.minY) - eye[1];
      const double dz = ((i & 4U) != 0 ? box.maxZ : box.minZ) - eye[2];
      out.at(static_cast<std::size_t>(i)) = {r[0] * dx + r[1] * dy + r[2] * dz, u[0] * dx + u[1] * dy + u[2] * dz,
                                             f[0] * dx + f[1] * dy + f[2] * dz};
    }
    return out;
  };
  if (light.type == api::RenderLightType::parallel) {
    const V3 eye{cx - f[0] * radius * 1.5, cy - f[1] * radius * 1.5, cz - f[2] * radius * 1.5};
    const Mat4 view = view_of(eye);
    double hw = 0, hh = 0;
    for (const V3& pt : corners(eye)) {
      hw = std::max(hw, std::abs(pt[0]));
      hh = std::max(hh, std::abs(pt[1]));
    }
    const double half = std::max(1.0, std::max(hw, hh) * 1.05);
    const double far = radius * 3;
    const Mat4 proj = mat4_list({1 / half, 0, 0, 0, 0, 1 / half, 0, 0, 0, 0, 1 / far, 0, 0, 0, 0, 1});
    return ShadowCamera{mul(proj, view), f, eye, 1 / far, 2 * half};
  }
  const V3 eye{light.x, light.y, light.z};
  const Mat4 view = view_of(eye);
  double maxTan = 0;
  double minZ = std::numeric_limits<double>::infinity();
  double maxZ = -std::numeric_limits<double>::infinity();
  for (const V3& pt : corners(eye)) {
    minZ = std::min(minZ, pt[2]);
    maxZ = std::max(maxZ, pt[2]);
    if (pt[2] > 1e-3) maxTan = std::max({maxTan, std::abs(pt[0]) / pt[2], std::abs(pt[1]) / pt[2]});
  }
  if (!(maxZ > 0)) return std::nullopt;
  const double tan = std::min(std::max(maxTan * 1.05, 0.05), 12.0);
  const double near = std::max(1.0, std::min(minZ, maxZ) * 0.5);
  const double far = std::max(near + 1, maxZ * 1.1);
  const Mat4 proj = mat4_list({1 / tan, 0, 0, 0, 0, 1 / tan, 0, 0, 0, 0, far / (far - near), 1, 0, 0, -(near * far) / (far - near), 0});
  const double midZ = std::max(near, (std::max(minZ, 0.0) + maxZ) / 2);
  return ShadowCamera{mul(proj, view), f, eye, 1 / far, 2 * tan * midZ};
}

std::uint32_t shadow_map_size(const std::optional<double>& requested) {
  if (!requested) return 1024;
  if (*requested <= 640) return 512;
  if (*requested <= 1400) return 1024;
  return 2048;
}

TexRef fallback(PassContext& ctx, std::string_view key, std::uint8_t v, std::uint8_t a) {
  const std::array<std::uint8_t, 4> px = {v, v, v, a};
  return ctx.dev.texture(key, 1, 1, wgpu::TextureFormat::RGBA8Unorm, px, false);
}

}  // namespace

bool depth_eligible_3d(const api::Renderable& r) noexcept {
  if (!r.three_d) return false;
  if (r.depth_exempt) return false;
  if (r.matte_source || r.matte || r.adjustment || r.precomp || r.generator) return false;
  if (r.advanced_blend && *r.advanced_blend > 0) return false;
  if (r.preserve_transparency) return false;
  if (r.glass || (r.backdrop_blur && *r.backdrop_blur > 0)) return false;
  if (r.motion_samples.size() > 1) return false;
  if (r.deformed_mesh) return false;
  return true;
}

Scope3D Scope3D::of(const api::RenderFrameScene& s) {
  return {s.camera3d ? &*s.camera3d : nullptr, &s.lights3d, s.env_map ? &*s.env_map : nullptr, s.ssao && s.ssao->enabled};
}

void unported_3d(const api::RenderFrameFile& f, std::vector<std::string>& reasons) {
  // Every scene-level 3D feature of the TS renderer is ported now (shadow maps
  // ×2, SSAO, the camera DOF gather, environment reflections, sealed-precomp
  // scopes). Kept as the gate the next scene-level feature registers in.
  (void)f;
  (void)reasons;
}

void render_3d_group(PassContext& ctx, std::span<const api::Renderable* const> group, std::string_view out,
                     const ById& byId, const TexFor& texFor, MapLayerSource& maps) {
  const ViewportState& vp = ctx.viewport;
  // The 3D frame this group draws under: the comp's, or a sealed precomp's own (precompScope).
  const Scope3D& scene = ctx.scope;
  const api::RenderCamera3D& cam = *scene.camera3d;
  const api::RenderEnvMap* envMap = scene.env_map != nullptr && scene.env_map->levels == kEnvSpecLevels ? scene.env_map : nullptr;

  // envBindingFor + the shadow/AO stand-ins every lit-3d material declares.
  const SamplerRef envSampler = ctx.dev.sampler("sampler:env-equirect", wgpu::FilterMode::Linear, wgpu::AddressMode::Repeat);
  TexRef envTex;
  if (envMap != nullptr) {
    envTex = ctx.dev.texture("texture:env:" + envMap->id, envMap->width, envMap->height, wgpu::TextureFormat::RGBA8Unorm,
                             envMap->data, false);
  } else {
    envTex = fallback(ctx, "texture:env-none", 0, 255);
  }
  TexRef shadowTex = fallback(ctx, "texture:shadow-none", 255, 255);
  TexRef shadow2Tex = shadowTex;
  const SamplerRef shadowSampler = ctx.dev.sampler("sampler:shadow-map", wgpu::FilterMode::Nearest, wgpu::AddressMode::ClampToEdge);
  TexRef aoTex = fallback(ctx, "texture:ssao-none", 255, 255);
  const SamplerRef aoSampler = ctx.dev.sampler("sampler:ssao", wgpu::FilterMode::Linear, wgpu::AddressMode::ClampToEdge);
  const auto bind_scene = [&](DrawItem& it) {
    it.bind(7, envTex);
    it.bind(8, envSampler);
    it.bind(9, shadowTex);
    it.bind(10, shadowSampler);
    it.bind(11, aoTex);
    it.bind(12, aoSampler);
    it.bind(13, shadow2Tex);
    it.bind(14, shadowSampler);
  };

  // Geometry-aware shadows for up to TWO lights per run (renderShadowMap).
  std::optional<Shade::ShadowBlock> shadowBlock;
  std::optional<Shade::ShadowBlock> shadow2Block;
  {
    const auto mapped = [&](std::size_t from) -> std::optional<std::size_t> {
      for (std::size_t i = from; i < scene.lights3d->size(); ++i) {
        const auto& l = (*scene.lights3d)[i];
        if (l.shadow_map.value_or(false) && l.type != api::RenderLightType::ambient && l.gain > 0) return i;
      }
      return std::nullopt;
    };
    const auto render_map = [&](std::size_t lightIndex, int slot, TexRef& texOut) -> std::optional<Shade::ShadowBlock> {
      const auto& light = (*scene.lights3d)[lightIndex];
      std::vector<const api::Renderable*> casters;
      for (const api::Renderable* r : group) {
        if (r->three_d && r->three_d->casts_shadow.value_or(false) && r->opacity > 0) casters.push_back(r);
      }
      if (casters.empty()) return std::nullopt;
      const WorldBox box = run_world_box(group);
      if (box.empty()) return std::nullopt;
      const auto camera = shadow_camera_for(light, box);
      if (!camera) return std::nullopt;
      const std::uint32_t size = shadow_map_size(light.shadow_map_size);
      RenderTarget& rt = ctx.dev.target("shadow-map:" + std::to_string(slot), size, size, wgpu::TextureFormat::RGBA8Unorm, 1, true);
      Commands sc;
      for (const api::Renderable* r : casters) {
        const auto& model = r->three_d->model;
        const Mat4 mvp = mul(camera->matrix, mat4_of(model));
        const auto caster = [&](Mat m) -> DrawItem& {
          Packer p = ctx.packer();
          p.mat4(mvp).mat4(mat4_of(model));
          p.vec4(camera->axis[0], camera->axis[1], camera->axis[2], camera->invFar);
          p.vec4(camera->origin[0], camera->origin[1], camera->origin[2], 0);
          return sc.add(m, Blend::none, p.span());
        };
        if (r->extruded_mesh) {
          const auto& mesh = *r->extruded_mesh;
          const wgpu::Buffer vb = ctx.dev.geometry("geometry:ext-vertex:" + mesh.key, mesh.vertices, false);
          const wgpu::Buffer ib = ctx.dev.geometry("geometry:ext-index:" + mesh.key, mesh.indices, true);
          for (const auto& range : mesh.ranges) {
            if (range.count == 0) continue;
            DrawItem& it = caster(Mat::SHADOW_DEPTH_MESH_MATERIAL);
            it.vertexBuffer = vb;
            it.indexBuffer = ib;
            it.indexFormat = mesh.index_format == api::RenderIndexFormat::uint32 ? wgpu::IndexFormat::Uint32 : wgpu::IndexFormat::Uint16;
            it.firstIndex = range.first;
            it.indexCount = range.count;
          }
          continue;
        }
        caster(Mat::SHADOW_DEPTH_MATERIAL);
      }
      Attachment att;
      att.target = &rt;
      att.clear = true;
      att.clear_r = att.clear_g = att.clear_b = att.clear_a = 1;
      wgpu::RenderPassEncoder pass = ctx.dev.begin_pass(att, size, size, ctx.surfaceView, ctx.surfaceFormat, nullptr, true);
      ctx.dev.execute(pass, sc, rt.format, 1);
      pass.End();
      texOut = rt.tex();
      Shade::ShadowBlock b;
      b.matrix = camera->matrix;
      b.axis = camera->axis;
      b.origin = camera->origin;
      b.invFar = camera->invFar;
      b.darkness = std::max(0.0, std::min(1.0, light.shadow_darkness.value_or(1)));
      const double softness = light.shadow_softness.value_or(1);
      const double texel = camera->footprint / std::max(1.0, static_cast<double>(size));
      b.bias = (std::max(0.0, light.shadow_bias.value_or(3)) + texel * (1 + std::max(0.0, softness))) * camera->invFar;
      b.step = std::max(0.0, softness) / size;
      b.light = lightIndex;
      return b;
    };
    if (const auto first = mapped(0)) {
      shadowBlock = render_map(*first, 0, shadowTex);
      if (shadowBlock) {
        if (const auto second = mapped(*first + 1)) shadow2Block = render_map(*second, 1, shadow2Tex);
      } else {
        // TS: the second map is looked for only when the first light exists, and
        // rendered even if the first refused — keep that exact order.
        if (const auto second = mapped(*first + 1)) shadow2Block = render_map(*second, 1, shadow2Tex);
      }
    }
  }

  // Ambient occlusion for the whole run (renderSsao): a linear-depth prepass
  // from the camera, the hemisphere estimate, a bilateral 4×4.
  TexRef aoResult;
  std::optional<Mat4> aoMatrix;
  if (scene.ssao && ctx.file.scene.ssao) {
    const auto& settings = *ctx.file.scene.ssao;
    const double intensity = std::max(0.0, std::min(2.0, std::isfinite(settings.intensity) ? settings.intensity : 1.0));
    std::vector<const api::Renderable*> occluders;
    for (const api::Renderable* r : group) {
      if (r->three_d && r->opacity > 0) occluders.push_back(r);
    }
    const WorldBox box = run_world_box(group);
    if (settings.enabled && intensity > 0 && !occluders.empty() && !box.empty()) {
      // ssaoCameraFor / ssaoFarFor
      const auto& view = cam.view;
      const double ax = view.size() > 2 ? view[2] : 0, ay = view.size() > 6 ? view[6] : 0, az = view.size() > 10 ? view[10] : 1;
      const double len = std::hypot(ax, ay, az);
      const V3 axis = len < 1e-9 ? V3{0, 0, 1} : V3{ax / len, ay / len, az / len};
      const double d = -(view.size() > 14 ? view[14] : 0) / (len < 1e-9 ? 1 : len);
      const V3 origin{axis[0] * d, axis[1] * d, axis[2] * d};
      double maxD = 0;
      for (unsigned i = 0; i < 8U; ++i) {
        const double x = ((i & 1U) != 0 ? box.maxX : box.minX) - origin[0];
        const double y = ((i & 2U) != 0 ? box.maxY : box.minY) - origin[1];
        const double z = ((i & 4U) != 0 ? box.maxZ : box.minZ) - origin[2];
        maxD = std::max(maxD, x * axis[0] + y * axis[1] + z * axis[2]);
      }
      const double far = std::max(1.0, maxD * 1.25);
      const double invFar = 1 / far;
      const bool full = settings.quality == api::RenderSsaoQuality::full;
      const std::uint32_t sw = std::max(1U, vp.pixelWidth / (full ? 1U : 2U));
      const std::uint32_t shh = std::max(1U, vp.pixelHeight / (full ? 1U : 2U));
      RenderTarget& depthRt = ctx.dev.target("ssao-depth", sw, shh, wgpu::TextureFormat::RGBA8Unorm, 1, true);
      Commands dc;
      for (const api::Renderable* r : occluders) {
        const auto& model = r->three_d->model;
        const Mat4 mvp = mvp3d(vp, cam, model);
        const auto caster = [&](Mat m) -> DrawItem& {
          Packer pk = ctx.packer();
          pk.mat4(mvp).mat4(mat4_of(model)).vec4(axis[0], axis[1], axis[2], invFar).vec4(origin[0], origin[1], origin[2], 0);
          return dc.add(m, Blend::none, pk.span());
        };
        if (r->extruded_mesh) {
          const auto& mesh = *r->extruded_mesh;
          const wgpu::Buffer vb = ctx.dev.geometry("geometry:ext-vertex:" + mesh.key, mesh.vertices, false);
          const wgpu::Buffer ib = ctx.dev.geometry("geometry:ext-index:" + mesh.key, mesh.indices, true);
          for (const auto& range : mesh.ranges) {
            if (range.count == 0) continue;
            DrawItem& it = caster(Mat::SHADOW_DEPTH_MESH_MATERIAL);
            it.vertexBuffer = vb;
            it.indexBuffer = ib;
            it.indexFormat = mesh.index_format == api::RenderIndexFormat::uint32 ? wgpu::IndexFormat::Uint32 : wgpu::IndexFormat::Uint16;
            it.firstIndex = range.first;
            it.indexCount = range.count;
          }
          continue;
        }
        caster(Mat::SHADOW_DEPTH_MATERIAL);
      }
      const auto sized = [&](RenderTarget& t, const Commands& c, bool depth) {
        Attachment att;
        att.target = &t;
        att.clear = true;
        att.clear_r = att.clear_g = att.clear_b = att.clear_a = 1;
        wgpu::RenderPassEncoder pass = ctx.dev.begin_pass(att, sw, shh, ctx.surfaceView, ctx.surfaceFormat, nullptr, depth);
        ctx.dev.execute(pass, c, t.format, 1);
        pass.End();
      };
      sized(depthRt, dc, true);
      const Mat4 proj = mul(mat4_from_mat3(vp.viewProjection), mat4_of(cam.projection));
      const SamplerRef nearest = ctx.dev.sampler("ssao-depth", wgpu::FilterMode::Nearest, wgpu::AddressMode::ClampToEdge);
      const double radius = std::max(1.0, std::min(2000.0, std::isfinite(settings.radius) ? settings.radius : 40.0));
      RenderTarget& aoRt = ctx.dev.target("ssao-raw", sw, shh, wgpu::TextureFormat::RGBA8Unorm, 1, false);
      Commands ac;
      {
        Packer pk = ctx.packer();
        pk.mat3(screen_mvp()).rect({0, 0, 1, 1}).vec4(radius, intensity, far, std::max(0.05, radius * 0.02));
        pk.vec4(sw, shh, full ? 16 : 12, 0).mat4(proj);
        DrawItem& it = ac.add(Mat::SSAO_MATERIAL, Blend::none, pk.span());
        it.texture = depthRt.tex();
        it.sampler = nearest;
      }
      sized(aoRt, ac, false);
      RenderTarget& blurRt = ctx.dev.target("ssao-blur", sw, shh, wgpu::TextureFormat::RGBA8Unorm, 1, false);
      Commands bc;
      {
        Packer pk = ctx.packer();
        pk.mat3(screen_mvp()).rect({0, 0, 1, 1}).vec4(1.0 / sw, 1.0 / shh, far, radius);
        DrawItem& it = bc.add(Mat::SSAO_BLUR_MATERIAL, Blend::none, pk.span());
        it.texture = aoRt.tex();
        it.sampler = nearest;
        it.mask = depthRt.tex();
      }
      sized(blurRt, bc, false);
      aoResult = blurRt.tex();
      aoMatrix = mvp3d(vp, cam, {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1});
    }
  }
  if (aoResult) aoTex = aoResult;

  // Camera DOF: the group renders into the single-sample DOF pair and one
  // gather composites it back (dofGatherFor / compositeDofGather).
  const bool gather = cam.dof && cam.eye.size() >= 3 && cam.dof->strength > 0 && ctx.target(kDofTarget) != nullptr &&
                      cam.projection.size() > 14 && cam.projection[14] != 0;
  const std::string_view groupOut = gather ? kDofTarget : out;
  bool depthCleared = false;

  const Rect targetUv{0, 0, 1, 1};
  const SamplerRef clamp = ctx.linear_clamp();
  const bool haveLights = !scene.lights3d->empty();
  const auto shade_for = [&](const api::Renderable& r, Shade& s) -> bool {
    if (!r.three_d || !r.three_d->shade || !haveLights) return false;
    const auto& sh = *r.three_d->shade;
    s = Shade{};
    s.model = r.three_d->model;
    const bool eye = cam.eye.size() >= 3;
    s.eye = eye ? std::array<double, 3>{cam.eye[0], cam.eye[1], cam.eye[2]} : std::array<double, 3>{0, 0, -1e6};
    s.specular = eye ? sh.specular : 0;
    s.shininess = sh.shininess;
    if (sh.metal && *sh.metal != 0) s.metal = sh.metal;
    s.roughness = sh.roughness;
    s.toonBands = sh.toon_bands;
    s.oneSided = sh.one_sided.value_or(false);
    s.reflectionIntensity = sh.reflection_intensity;
    s.reflectionSharpness = sh.reflection_sharpness;
    s.reflectionRolloff = sh.reflection_rolloff;
    s.transparency = sh.transparency;
    s.transparencyRolloff = sh.transparency_rolloff;
    s.ior = sh.ior;
    if (envMap != nullptr && !sh.toon_bands) {
      s.env = std::array<double, 3>{envMap->intensity, envMap->rotation_deg * std::numbers::pi / 180, envMap->scale};
    }
    s.lights = scene.lights3d;
    if (aoMatrix) {
      s.aoMatrix = aoMatrix;
      s.aoStrength = 1;
    }
    if (sh.accepts_shadows.value_or(true)) {
      s.shadow = shadowBlock;
      s.shadow2 = shadow2Block;
    }
    s.kAmbient = sh.ambient.value_or(100) / 100;
    s.kDiffuse = sh.diffuse.value_or(50) / 50;
    return true;
  };
  const auto lit_color = [](const api::Renderable& r, Color c, bool shaded) {
    if (shaded || !r.three_d || !r.three_d->shade || r.three_d->shade->quad_gain.size() < 3) return c;
    const auto& g = r.three_d->shade->quad_gain;
    return Color{c.r * g[0], c.g * g[1], c.b * g[2], c.a};
  };

  Commands cmds;
  bool pendingResolved = false;
  const auto flush = [&] {
    if (cmds.empty()) return;
    RenderTarget* t = ctx.target(groupOut);
    Attachment att;
    att.target = t;
    att.clear = gather && !depthCleared;
    depthCleared = true;
    wgpu::RenderPassEncoder pass = ctx.dev.begin_pass(att, vp.pixelWidth, vp.pixelHeight, ctx.surfaceView, ctx.surfaceFormat,
                                                      nullptr, true);
    ctx.dev.execute(pass, cmds, t->format, t->samples);
    pass.End();
    cmds.clear();
    pendingResolved = false;
  };

  std::vector<api::Renderable> stripped;  // withoutDofEffects copies (only in a gathered group)
  stripped.reserve(gather ? group.size() : 0);
  for (const api::Renderable* rp0 : group) {
    const api::Renderable* rp = rp0;
    if (gather && std::ranges::any_of(rp0->effects, [](const api::RenderEffect& e) {
          return e.type == "blur" && Fx(e).flag("dofSource");
        })) {
      api::Renderable c = *rp0;
      std::erase_if(c.effects, [](const api::RenderEffect& e) { return e.type == "blur" && Fx(e).flag("dofSource"); });
      stripped.push_back(std::move(c));
      rp = &stripped.back();
    }
    const api::Renderable& r = *rp;
    if (r.opacity <= 0) continue;
    const Mat4 mvp = mvp3d(vp, cam, r.three_d->model);
    const Rect uv = r.uv_rect ? rect_of(*r.uv_rect) : Rect{0, 0, 1, 1};
    Shade shade;
    const bool shaded = shade_for(r, shade);
    const Shade* sp = shaded ? &shade : nullptr;

    if (r.extruded_mesh) {
      const auto& mesh = *r.extruded_mesh;
      const wgpu::Buffer vb = ctx.dev.geometry("geometry:ext-vertex:" + mesh.key, mesh.vertices, false);
      const wgpu::Buffer ib = ctx.dev.geometry("geometry:ext-index:" + mesh.key, mesh.indices, true);
      const wgpu::IndexFormat fmt = mesh.index_format == api::RenderIndexFormat::uint32 ? wgpu::IndexFormat::Uint32 : wgpu::IndexFormat::Uint16;
      const TexRef tex = r.texture_key ? texFor(r.texture_key) : TexRef{};
      const TexRef lut = r.lut_texture_key ? ctx.texture(*r.lut_texture_key) : TexRef{};
      const TexRef white = ctx.texture("texture:white");
      TexRef normalTex, mrTex, occTex, emTex;
      const bool pbr = mesh.pbr.has_value() && static_cast<bool>(white);
      if (pbr) {
        const auto mapTex = [&](const std::optional<std::string>& k) { return k ? texFor(k) : TexRef{}; };
        normalTex = mapTex(mesh.pbr->normal_key);
        mrTex = mapTex(mesh.pbr->metallic_roughness_key);
        occTex = mapTex(mesh.pbr->occlusion_key);
        emTex = mapTex(mesh.pbr->emissive_key);
      }
      for (const auto& range : mesh.ranges) {
        if (range.count == 0) continue;
        const Color c = color_of(range.color);
        const Color color = shaded ? c : Color{c.r * range.gain, c.g * range.gain, c.b * range.gain, c.a};
        Shade rangeShade = shade;
        if (shaded && range.role == api::RenderMeshRole::front && shade.oneSided) rangeShade.oneSided = false;
        const Shade* rsp = shaded ? &rangeShade : nullptr;
        const TexRef rangeTex = range.texture_key ? texFor(range.texture_key) : tex;
        const bool own = range.texture_key.has_value() && static_cast<bool>(rangeTex);
        const auto geo = [&](DrawItem& it) {
          it.vertexBuffer = vb;
          it.indexBuffer = ib;
          it.indexFormat = fmt;
          it.firstIndex = range.first;
          it.indexCount = range.count;
          bind_scene(it);
        };
        const auto pbr_bind = [&](DrawItem& it) {
          it.bind(3, normalTex ? normalTex : white);
          it.bind(4, mrTex ? mrTex : white);
          it.bind(5, occTex ? occTex : white);
          it.bind(6, emTex ? emTex : white);
        };
        const auto pbr_tail = [&](Packer& p) {
          p.vec4(mesh.pbr->normal_scale, mesh.pbr->occlusion_strength, normalTex ? 1 : 0, 0);
          const auto& e = mesh.pbr->emissive;
          p.vec4(e.size() > 2 ? e[0] : 0, e.size() > 2 ? e[1] : 0, e.size() > 2 ? e[2] : 0, 0);
        };
        if (range.textured && rangeTex) {
          const Color tint = own && !shaded ? Color{range.gain, range.gain, range.gain, 1} : Color::white();
          const bool lin = rangeTex.sampleLinear;
          Packer p = ctx.packer();
          pack_textured3d(p, mvp, own || !r.uv_rect ? Rect{0, 0, 1, 1} : rect_of(*r.uv_rect), tint, r.opacity,
                          color_transform(r.color_matrix), rsp, lin);
          Mat m = Mat::TEXTURED3D_MATERIAL;
          if (pbr) {
            pbr_tail(p);
            m = lut ? Mat::MESH3D_PBR_LUT_MATERIAL : Mat::MESH3D_PBR_MATERIAL;
          } else {
            m = lut ? (lin ? Mat::MESH3D_TEXTURED_LUT_LINEAR_MATERIAL : Mat::MESH3D_TEXTURED_LUT_MATERIAL)
                    : (lin ? Mat::MESH3D_TEXTURED_LINEAR_MATERIAL : Mat::MESH3D_TEXTURED_MATERIAL);
          }
          DrawItem& it = cmds.add(m, blend_of(r.blend), p.span());
          it.texture = rangeTex;
          it.sampler = clamp;
          if (pbr) pbr_bind(it);
          if (lut) it.bind(15, lut);
          geo(it);
        } else if (pbr && !(range.textured && range.texture_key)) {
          Packer p = ctx.packer();
          pack_textured3d(p, mvp, {0, 0, 1, 1}, color, r.opacity,
                          range.textured ? color_transform(r.color_matrix) : kIdentityColor, rsp, false);
          pbr_tail(p);
          DrawItem& it = cmds.add(Mat::MESH3D_PBR_MATERIAL, blend_of(r.blend), p.span());
          it.texture = white;
          it.sampler = clamp;
          pbr_bind(it);
          geo(it);
        } else {
          Packer p = ctx.packer();
          pack_textured3d(p, mvp, {0, 0, 1, 1}, color, r.opacity, kIdentityColor, rsp, false);
          DrawItem& it = cmds.add(Mat::MESH3D_SOLID_MATERIAL, blend_of(r.blend), p.span());
          geo(it);
        }
      }
      continue;
    }

    const bool solid = r.kind == api::RenderableKind::rect || r.kind == api::RenderableKind::path || r.kind == api::RenderableKind::group;
    const bool textured = r.kind == api::RenderableKind::image || r.kind == api::RenderableKind::video || r.kind == api::RenderableKind::text;

    if (!r.effects.empty()) {
      if (pendingResolved) flush();
      // resolveEffect3DTexture: content inset by the effects' margin, chain in layer space.
      const auto& model = r.three_d->model;
      const double worldW = [&] { const double v = std::hypot(model[0], model[1], model[2]); return v != 0 ? v : 1; }();
      const double worldH = [&] { const double v = std::hypot(model[4], model[5], model[6]); return v != 0 ? v : 1; }();
      const double spread = effect_spread_px(r.effects, worldW, worldH);
      const double fxm = std::min(spread / worldW, kMaxFxMargin);
      const double fym = std::min(spread / worldH, kMaxFxMargin);
      const double ex = 1 + 2 * fxm;
      const double ey = 1 + 2 * fym;
      const Rect inset{fxm / ex, fym / ey, 1 / ex, 1 / ey};
      const Mat3 fillMvp = mul(screen_mvp(), model_from_rect(inset));
      Commands fill;
      if (r.mask_texture_key) {
        const TexRef mask = ctx.texture(*r.mask_texture_key);
        TexRef tex = textured && r.texture_key ? texFor(r.texture_key) : TexRef{};
        if (solid && !tex) tex = ctx.texture("texture:white");
        if (mask && tex) {
          emit_masked_textured(ctx, fill, fillMvp, r.color ? color_of(*r.color) : Color::white(), 1, Blend::normal, tex, clamp,
                               mask, uv, color_transform(r.color_matrix), tex.sampleLinear);
        }
      } else if (solid && r.color) {
        emit_solid(ctx, fill, fillMvp, color_of(*r.color), 1, Blend::normal, solid_shape(r.sdf));
      } else if (textured && r.texture_key) {
        const TexRef tex = texFor(r.texture_key);
        const TexRef lut = r.lut_texture_key ? ctx.texture(*r.lut_texture_key) : TexRef{};
        if (tex && lut) {
          emit_lut_textured(ctx, fill, fillMvp, r.color ? color_of(*r.color) : Color::white(), 1, Blend::normal, tex, clamp, lut,
                            uv, color_transform(r.color_matrix), tex.sampleLinear);
        } else if (tex) {
          emit_textured(ctx, fill, fillMvp, r.color ? color_of(*r.color) : Color::white(), 1, Blend::normal, tex, clamp, uv,
                        color_transform(r.color_matrix), tex.sampleLinear);
        }
      }
      if (fill.empty()) continue;
      ctx.draw_into(kLayerTarget, fill, true);
      const FxSpace space{vp.pixelWidth / (worldW * ex), vp.pixelHeight / (worldH * ey), inset};
      const std::array<std::string_view, 4> pool = {kLayerTarget, kBlur1, kBlur2, kBlur3};
      const ChainResult res = run_effects_chain(ctx, r.effects, ctx.target(kLayerTarget)->tex(), pool, byId, r.id, maps, &space);
      TexRef resolved = res.tex;
      if (res.name != kLayerTarget) {
        Commands copy;
        emit_textured(ctx, copy, screen_mvp(), Color::white(), 1, Blend::none, res.tex, clamp, targetUv, kIdentityColor, true);
        ctx.draw_into(kLayerTarget, copy, true);
        resolved = ctx.target(kLayerTarget)->tex();
      }
      const std::vector<double> fxModel = expand_model(model, ex, ey);
      const Mat4 fxMvp = mvp3d(vp, cam, fxModel);
      Shade fxShade = shade;
      fxShade.model = fxModel;
      const Color tint = lit_color(r, Color::white(), shaded);
      Packer p = ctx.packer();
      pack_textured3d(p, fxMvp, targetUv, tint, r.opacity, kIdentityColor, shaded ? &fxShade : nullptr, true);
      DrawItem& it = cmds.add(Mat::TEXTURED3D_LINEAR_NO_DEPTH_WRITE_MATERIAL, blend_of(r.blend), p.span());
      it.texture = resolved;
      it.sampler = clamp;
      bind_scene(it);
      pendingResolved = true;
      continue;
    }

    const Color tint = lit_color(r, r.color ? color_of(*r.color) : Color::white(), shaded);
    const ColorTransform ct = color_transform(r.color_matrix);
    if (r.mask_texture_key) {
      const TexRef mask = ctx.texture(*r.mask_texture_key);
      TexRef tex = textured && r.texture_key ? texFor(r.texture_key) : TexRef{};
      if (solid && !tex) tex = ctx.texture("texture:white");
      if (mask && tex) {
        Packer p = ctx.packer();
        pack_textured3d(p, mvp, uv, tint, r.opacity, ct, sp, tex.sampleLinear);
        DrawItem& it = cmds.add(tex.sampleLinear ? Mat::MASKED_TEXTURED3D_LINEAR_MATERIAL : Mat::MASKED_TEXTURED3D_MATERIAL,
                                blend_of(r.blend), p.span());
        it.texture = tex;
        it.sampler = clamp;
        it.mask = mask;
        bind_scene(it);
      }
    } else if (solid && r.color) {
      Packer p = ctx.packer();
      const SolidShape s = solid_shape(r.sdf);
      p.mat4(mvp).color(tint, r.opacity).vec4(s.kind, s.radiusPx, s.width, s.height);
      pack_shade(p, sp);
      DrawItem& it = cmds.add(Mat::SOLID3D_MATERIAL, blend_of(r.blend), p.span());
      bind_scene(it);
    } else if (textured && r.texture_key) {
      const TexRef tex = texFor(r.texture_key);
      const TexRef lut = r.lut_texture_key ? ctx.texture(*r.lut_texture_key) : TexRef{};
      if (tex) {
        Packer p = ctx.packer();
        pack_textured3d(p, mvp, uv, tint, r.opacity, ct, sp, tex.sampleLinear);
        const Mat m = lut ? (tex.sampleLinear ? Mat::TEXTURED3D_LUT_LINEAR_MATERIAL : Mat::TEXTURED3D_LUT_MATERIAL)
                          : (tex.sampleLinear ? Mat::TEXTURED3D_LINEAR_MATERIAL : Mat::TEXTURED3D_MATERIAL);
        DrawItem& it = cmds.add(m, blend_of(r.blend), p.span());
        it.texture = tex;
        it.sampler = clamp;
        if (lut) it.bind(15, lut);
        bind_scene(it);
      }
    }
  }
  flush();
  if (gather && depthCleared) {
    RenderTarget* dt = ctx.target(kDofTarget);
    const auto& dof = *cam.dof;
    Packer p = ctx.packer();
    p.mat3(screen_mvp()).rect(targetUv);
    p.vec4(1.0 / std::max(1U, vp.pixelWidth), 1.0 / std::max(1U, vp.pixelHeight), dof.iris_blades.value_or(0), dof.iris_roundness.value_or(0.65));
    p.vec4(dof.highlight_gain.value_or(0), dof.strength, cam.projection[10], cam.projection[14]);
    p.vec4(dof.focus, dof.aperture, dof.strength, dof.focal_length.value_or(dof.focus));
    p.vec4(dof.f_stop.value_or(0), dof.iris_rotation.value_or(0) * std::numbers::pi / 180, dof.iris_aspect.value_or(1),
           dof.highlight_threshold.value_or(0));
    p.vec4(dof.highlight_saturation.value_or(0), dof.diffraction_fringe.value_or(0), 0, 0);
    Commands gc;
    DrawItem& it = gc.add(Mat::DOF_GATHER_MATERIAL, Blend::normal, p.span());
    it.texture = dt->tex();
    it.sampler = clamp;
    it.mask = TexRef{dt->depthView, dt->id | (std::uint64_t{1} << 62U), dt->width, dt->height, false};
    ctx.draw_into(out, gc, false);
  }
}

}  // namespace premation::rg
