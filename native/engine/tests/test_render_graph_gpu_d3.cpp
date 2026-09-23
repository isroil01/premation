// D3 + the D2 leftovers on a real Dawn device (skipped without an adapter):
//
//   * OCIO programs against OCIO's own CPU processor — ACEScg → sRGB, the
//     Rec.709 round trips, an ACES output view (baked), op list vs lattice
//     measured;
//   * the WGSL interpreter against OCIO on the GPU (footage input conversion
//     read back in float; the display encode read back in 8 bits);
//   * 32-bit float intermediates: over-range values survive a blur and an add
//     and clip only at the output; 20 stacked low-opacity layers stay exact
//     (the banding test), where 16 and 8 bits drift;
//   * mip-mapped textures, the overlay pass, the viewer-LUT blit.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <set>
#include <string>
#include <vector>

#include "color/color_system.hpp"
#include "color/ocio_ffi.hpp"
#include "scene_renderer.hpp"

using namespace premation::rg;

namespace {

constexpr std::uint32_t kW = 64;
constexpr std::uint32_t kH = 48;

api::RenderFrameFile base_frame(std::uint32_t bitDepth = 16) {
  api::RenderFrameFile f;
  f.format_version = 1;
  f.scene_id = "d3";
  f.view.css_width = kW;
  f.view.css_height = kH;
  f.view.device_pixel_ratio = 1;
  f.view.camera_center_x = kW / 2.0;
  f.view.camera_center_y = kH / 2.0;
  f.view.camera_zoom = 1;
  f.view.bit_depth = bitDepth;
  f.view.float16_textures = true;
  f.view.float32_textures = true;
  f.view.surface_format = api::RenderTextureFormat::bgra8unorm;
  f.scene.width = kW;
  f.scene.height = kH;
  f.scene.background = api::Color{0, 0, 0, 1};
  f.scene.has_effects = true;
  return f;
}

/// Unit quad → the world rect (x, y, w, h).
std::vector<double> model(double x, double y, double w, double h) { return {w, 0, 0, 0, h, 0, x, y, 1}; }

std::vector<std::uint8_t> f32_bytes(const std::vector<float>& v) {
  std::vector<std::uint8_t> b(v.size() * sizeof(float));
  std::memcpy(b.data(), v.data(), b.size());
  return b;
}

/// An image renderable sampling blob `hash` (added to the file once).
api::Renderable image(api::RenderFrameFile& f, const std::string& key, std::uint32_t w, std::uint32_t h,
                      api::RenderTextureFormat fmt, std::vector<std::uint8_t> pixels, bool sampleLinear,
                      std::optional<api::RenderColorSpace> inputSpace, double x, double y, double dw, double dh,
                      bool mipmapped = false) {
  const std::string hash = "hash:" + key;
  f.blobs.push_back({hash, w, h, fmt, std::move(pixels), mipmapped});
  api::RenderTextureRef ref;
  ref.key = key;
  ref.hash = hash;
  ref.sample_linear = sampleLinear;
  ref.ready = true;
  ref.input_space = inputSpace;
  f.textures.push_back(ref);
  api::Renderable r;
  r.id = key;
  r.kind = api::RenderableKind::image;
  r.model_matrix = model(x, y, dw, dh);
  r.bounds = {x, y, dw, dh};
  r.opacity = 1;
  r.texture_key = key;
  return r;
}

api::Renderable rect(double x, double y, double w, double h, api::Color c) {
  api::Renderable r;
  r.id = "rect";
  r.kind = api::RenderableKind::rect;
  r.model_matrix = model(x, y, w, h);
  r.bounds = {x, y, w, h};
  r.opacity = 1;
  r.color = c;
  return r;
}

std::unique_ptr<SceneRenderer> renderer_or_skip() {
  std::string err;
  auto r = SceneRenderer::create({}, err);
  if (!r) WARN("no GPU adapter: " << err);
  return r;
}

/// Test inputs: an in-gamut ramp, HDR values, negatives, and colours.
std::vector<float> probe_values(bool hdr) {
  std::vector<float> v;
  for (int i = 0; i <= 64; ++i) {
    const float x = static_cast<float>(i) / 64.0F;
    v.insert(v.end(), {x, x * 0.5F, 1.0F - x});
  }
  if (hdr) {
    for (const float x : {1.5F, 2.0F, 4.0F, 8.0F, 16.0F, -0.01F, -0.1F}) v.insert(v.end(), {x, 0.18F, x * 0.25F});
  }
  return v;
}

double worst_error(const std::vector<float>& a, const std::vector<float>& b, bool relative) {
  double w = 0;
  for (std::size_t i = 0; i < a.size(); ++i) {
    const double d = std::abs(static_cast<double>(a[i]) - static_cast<double>(b[i]));
    w = std::max(w, relative ? d / std::max(1.0, std::abs(static_cast<double>(b[i]))) : d);
  }
  return w;
}

}  // namespace

TEST_CASE("OCIO: ACEScg → sRGB and the Rec.709 round trips, op programs against OCIO's CPU processor", "[color][ocio]") {
  if (!ColorSystem::available()) {
    WARN("built without OpenColorIO");
    return;
  }
  std::string err;
  auto ocio = color::Ocio::open("", err);
  REQUIRE(ocio);

  const auto check = [&](color::Space src, color::Space dst, bool hdr, double tol, const char* expectOps) {
    color::Request req;
    req.src = src;
    req.dst = dst;
    color::Program prog;
    REQUIRE(ocio->program(req, prog, err));
    CHECK_FALSE(prog.baked());  // expressible as ops: no lattice
    std::string ops;
    REQUIRE(ocio->describe(req, ops, err));
    CHECK(ops == expectOps);
    auto ours = probe_values(hdr);
    auto ref = ours;
    color::evaluate(prog, ours);
    REQUIRE(ocio->apply_cpu(req, ref, err));
    const double w = worst_error(ours, ref, true);
    INFO(ops << " worst " << w);
    CHECK(w < tol);
  };
  // Scene-linear AP1 → the sRGB encode: one matrix + the moncurve inverse.
  check(color::Space::aces_cg, color::Space::srgb, true, 2e-6, "matrix → exponent-with-linear⁻¹");
  // Footage input: sRGB-encoded → ACEScg.
  check(color::Space::srgb, color::Space::aces_cg, false, 2e-6, "exponent-with-linear → matrix");
  // Rec.709 gamma 2.4 ↔ linear.
  check(color::Space::rec709, color::Space::linear_srgb, false, 2e-6, "exponent");
  check(color::Space::linear_rec2020, color::Space::rec709, true, 2e-6, "matrix → exponent⁻¹");

  // Round trips through OCIO: sRGB → ACEScg → sRGB and Rec.709 → Rec.2020 → Rec.709 are identities.
  const auto round_trip = [&](color::Space a, color::Space b) {
    color::Request there{a, b, "", false, 33};
    color::Request back{b, a, "", false, 33};
    color::Program p1;
    color::Program p2;
    REQUIRE(ocio->program(there, p1, err));
    REQUIRE(ocio->program(back, p2, err));
    auto v = probe_values(false);
    const auto orig = v;
    color::evaluate(p1, v);
    color::evaluate(p2, v);
    CHECK(worst_error(v, orig, false) < 5e-6);
    auto r = orig;
    REQUIRE(ocio->apply_cpu(there, r, err));
    REQUIRE(ocio->apply_cpu(back, r, err));
    CHECK(worst_error(r, orig, false) < 5e-6);
  };
  round_trip(color::Space::srgb, color::Space::aces_cg);
  round_trip(color::Space::rec709, color::Space::rec2020);
  round_trip(color::Space::linear_srgb, color::Space::aces2065);
}

TEST_CASE("OCIO: op list vs a baked lattice — the measurement behind the default", "[color][ocio][measure]") {
  if (!ColorSystem::available()) return;
  std::string err;
  auto ocio = color::Ocio::open("", err);
  REQUIRE(ocio);
  color::Request req{color::Space::aces_cg, color::Space::srgb, "", false, 33};
  color::Program ops;
  REQUIRE(ocio->program(req, ops, err));
  auto ref = probe_values(false);
  REQUIRE(ocio->apply_cpu(req, ref, err));
  auto a = probe_values(false);
  color::evaluate(ops, a);
  const double opErr = worst_error(a, ref, false);
  double lutErr33 = 0;
  double lutErr65 = 0;
  for (const std::uint32_t n : {33U, 65U}) {
    color::Request lr = req;
    lr.forceLut = true;
    lr.lutSize = n;
    color::Program lut;
    REQUIRE(ocio->program(lr, lut, err));
    REQUIRE(lut.baked());
    auto b = probe_values(false);
    color::evaluate(lut, b);
    (n == 33 ? lutErr33 : lutErr65) = worst_error(b, ref, false);
  }
  std::printf("[measure] ACEScg -> sRGB, worst |error| vs OCIO CPU on the ramp: op list %.2e, lattice 33^3 %.2e, 65^3 %.2e\n",
              opErr, lutErr33, lutErr65);
  CHECK(opErr < 1e-6);
  CHECK(lutErr33 > opErr);  // the reason the op list is the default
  CHECK(lutErr65 < lutErr33);

  // An ACES output view has fixed-function ops no op list expresses: baked.
  color::Request view{color::Space::aces_cg, color::Space::srgb, "ACES 1.0 - SDR Video", false, 65};
  color::Program aces;
  REQUIRE(ocio->program(view, aces, err));
  CHECK(aces.baked());
  auto v = probe_values(true);
  auto vr = v;
  REQUIRE(ocio->apply_cpu(view, vr, err));
  color::evaluate(aces, v);
  // Worst over the in-gamut ramp (the first 65 triples: non-negative, ≤ 1) and over everything (HDR, negatives).
  const std::size_t inGamut = 65 * 3;
  const double acesErrInGamut =
      worst_error(std::vector<float>(v.begin(), v.begin() + inGamut), std::vector<float>(vr.begin(), vr.begin() + inGamut), false);
  const double acesErr = worst_error(v, vr, false);
  std::string opsDesc;
  REQUIRE(ocio->describe(view, opsDesc, err));
  std::printf("[measure] ACES 1.0 SDR Video view (%s), 65^3 log2-shaped lattice: worst |error| in gamut %.2e, with HDR + negatives %.2e\n",
              opsDesc.c_str(), acesErrInGamut, acesErr);
  CHECK(acesErrInGamut < 2e-2);  // ≈ 5/255 — a lattice limit; see native/README.md (D3) for the fixed-function port that removes it
}

TEST_CASE("footage input conversion on the GPU matches OCIO (read back in float)", "[color][gpu]") {
  if (!ColorSystem::available()) return;
  auto r = renderer_or_skip();
  if (!r) return;
  if (!r->supports_float32()) {
    WARN("device has no float32-filterable + float32-blendable");
    return;
  }
  auto f = base_frame(32);
  api::RenderColorManagement cm;
  cm.working_space = api::RenderColorSpace::aces_cg;
  cm.display_space = api::RenderColorSpace::srgb;
  f.view.color_management = cm;
  // A 64×48 sRGB-encoded ramp covering the frame 1:1: R = x·4, G = y·5, B = 255 − R.
  std::vector<std::uint8_t> px(std::size_t{kW} * kH * 4);
  for (std::uint32_t y = 0; y < kH; ++y) {
    for (std::uint32_t x = 0; x < kW; ++x) {
      const std::size_t i = (std::size_t{y} * kW + x) * 4;
      px[i] = static_cast<std::uint8_t>(x * 4);
      px[i + 1] = static_cast<std::uint8_t>(y * 5);
      px[i + 2] = static_cast<std::uint8_t>(255 - x * 4);
      px[i + 3] = 255;
    }
  }
  f.scene.renderables.push_back(image(f, "footage", kW, kH, api::RenderTextureFormat::rgba8unorm, px, false,
                                      api::RenderColorSpace::srgb, 0, 0, kW, kH));
  Frame frame;
  FrameStats s;
  std::string err;
  REQUIRE(r->render(f, &frame, s, err));
  CHECK(s.gpuError.empty());
  CHECK(s.diagnostics.empty());
  TargetPixels scene;
  REQUIRE(r->read_target("scene-color", scene, err));
  REQUIRE(scene.format == wgpu::TextureFormat::RGBA32Float);
  // Reference: OCIO's CPU processor on the same texels.
  std::vector<float> ref;
  for (std::size_t i = 0; i < px.size(); i += 4) {
    for (std::size_t c = 0; c < 3; ++c) ref.push_back(static_cast<float>(px[i + c]) / 255.0F);
  }
  auto ocio = color::Ocio::open("", err);
  REQUIRE(ocio);
  REQUIRE(ocio->apply_cpu({color::Space::srgb, color::Space::aces_cg, "", false, 33}, ref, err));
  double worst = 0;
  for (std::size_t p = 0; p < std::size_t{kW} * kH; ++p) {
    for (std::size_t c = 0; c < 3; ++c) worst = std::max(worst, std::abs(static_cast<double>(scene.rgba[p * 4 + c]) - ref[p * 3 + c]));
    CHECK(scene.rgba[p * 4 + 3] == 1.0F);
  }
  std::printf("[measure] GPU sRGB -> ACEScg footage conversion vs OCIO CPU, 3072 texels: worst |error| %.2e\n", worst);
  CHECK(worst < 1e-5);
}

TEST_CASE("the display encode is OCIO's (8-bit readback), and an unmanaged frame is the TS blit", "[color][gpu]") {
  if (!ColorSystem::available()) return;
  auto r = renderer_or_skip();
  if (!r) return;
  if (!r->supports_float32()) return;  // the probe texture is rgba32float, filtered
  // Linear light values (a float "EXR" texture: sampleLinear, no interpretation).
  std::vector<float> lin;
  for (std::uint32_t y = 0; y < kH; ++y) {
    for (std::uint32_t x = 0; x < kW; ++x) lin.insert(lin.end(), {static_cast<float>(x) / 63.0F, 0.18F, static_cast<float>(y) / 47.0F, 1.0F});
  }
  const auto frame_for = [&](std::optional<api::RenderColorManagement> cm) {
    auto f = base_frame(16);
    f.view.color_management = cm;
    f.scene.renderables.push_back(
        image(f, "lin", kW, kH, api::RenderTextureFormat::rgba32float, f32_bytes(lin), true, std::nullopt, 0, 0, kW, kH));
    return f;
  };
  std::string err;
  auto ocio = color::Ocio::open("", err);
  REQUIRE(ocio);
  for (const api::RenderColorSpace display : {api::RenderColorSpace::srgb, api::RenderColorSpace::rec709}) {
    api::RenderColorManagement cm;
    cm.working_space = api::RenderColorSpace::linear_srgb;
    cm.display_space = display;
    Frame frame;
    FrameStats s;
    REQUIRE(r->render(frame_for(cm), &frame, s, err));
    CHECK(s.gpuError.empty());
    std::vector<float> ref;
    for (std::size_t i = 0; i < lin.size(); i += 4) ref.insert(ref.end(), {lin[i], lin[i + 1], lin[i + 2]});
    REQUIRE(ocio->apply_cpu({color::Space::linear_srgb, display == api::RenderColorSpace::srgb ? color::Space::srgb : color::Space::rec709, "", false, 33},
                            ref, err));
    int worst = 0;
    for (std::size_t p = 0; p < std::size_t{kW} * kH; ++p) {
      for (std::size_t c = 0; c < 3; ++c) {
        const int want = static_cast<int>(std::lround(std::clamp(static_cast<double>(ref[p * 3 + c]), 0.0, 1.0) * 255.0));
        worst = std::max(worst, std::abs(static_cast<int>(frame.rgba[p * 4 + c]) - want));
      }
    }
    INFO("display " << static_cast<int>(display));
    CHECK(worst <= 1);
  }
  // Managed linear-sRGB working + sRGB display is the same picture as the
  // unmanaged TS scene blit (IEC curve vs OCIO's tangent-matched moncurve: ≤ 1).
  Frame managed;
  Frame plain;
  FrameStats s;
  api::RenderColorManagement cm;
  cm.working_space = api::RenderColorSpace::linear_srgb;
  cm.display_space = api::RenderColorSpace::srgb;
  REQUIRE(r->render(frame_for(cm), &managed, s, err));
  REQUIRE(r->render(frame_for(std::nullopt), &plain, s, err));
  int worst = 0;
  for (std::size_t i = 0; i < plain.rgba.size(); ++i) worst = std::max(worst, std::abs(managed.rgba[i] - plain.rgba[i]));
  CHECK(worst <= 1);
}

TEST_CASE("the display pass costs: TS scene blit vs OCIO op list vs baked lattice, 1080p", "[color][gpu][measure]") {
  if (!ColorSystem::available()) return;
  auto r = renderer_or_skip();
  if (!r) return;
  // One full-frame 8-bit image at 1920×1080 — the blit dominates what differs.
  auto f = base_frame(16);
  f.view.css_width = 1920;
  f.view.css_height = 1080;
  f.view.camera_center_x = 960;
  f.view.camera_center_y = 540;
  f.scene.width = 1920;
  f.scene.height = 1080;
  std::vector<std::uint8_t> px(std::size_t{1920} * 1080 * 4, 128);
  f.scene.renderables.push_back(image(f, "hd", 1920, 1080, api::RenderTextureFormat::rgba8unorm, px, false, std::nullopt, 0, 0, 1920, 1080));
  const auto time = [&](std::optional<api::RenderColorManagement> cm, std::uint32_t lattice) {
    r->color_system().force_lattice(lattice);
    auto g = f;
    g.view.color_management = cm;
    std::string err;
    FrameStats s;
    for (int i = 0; i < 5; ++i) REQUIRE(r->render(g, nullptr, s, err));  // warm: pipelines, programs, uploads
    std::vector<double> ms;
    for (int i = 0; i < 40; ++i) {
      FrameStats t;
      REQUIRE(r->render(g, nullptr, t, err));
      ms.push_back(t.encodeMs + t.gpuMs);
    }
    std::sort(ms.begin(), ms.end());
    return ms[ms.size() / 2];
  };
  api::RenderColorManagement cm;
  cm.working_space = api::RenderColorSpace::aces_cg;
  cm.display_space = api::RenderColorSpace::srgb;
  const double blit = time(std::nullopt, 0);
  const double ops = time(cm, 0);
  const double lattice = time(cm, 33);
  api::RenderColorManagement aces = cm;
  aces.view = "ACES 1.0 - SDR Video";
  const double acesView = time(aces, 0);
  r->color_system().force_lattice(0);
  std::printf("[measure] 1080p frame, median ms (render + submit + GPU idle): TS scene blit %.3f, OCIO op list %.3f, "
              "33^3 lattice %.3f, ACES view (65^3 lattice) %.3f\n",
              blit, ops, lattice, acesView);
  CHECK(ops > 0);
}

TEST_CASE("32-bit intermediates: over-range values survive blur and add, and clip only at the output", "[bitdepth][gpu]") {
  auto r = renderer_or_skip();
  if (!r) return;
  if (!r->supports_float32()) {
    WARN("device has no float32-filterable + float32-blendable");
    return;
  }
  // A 4.0 (scene-referred) square, blurred, with a 1.0 square ADDED on top: held
  // in float the centre is ≈ 5.0 in scene-color and the surface clips it to 255
  // only at the display encode. In unorm8 intermediates it is clipped at every write.
  const auto frame_for = [&](std::uint32_t bits) {
    auto f = base_frame(bits);
    std::vector<float> bright(16 * 16 * 4);
    for (std::size_t i = 0; i < bright.size(); i += 4) {
      bright[i] = bright[i + 1] = bright[i + 2] = 4.0F;
      bright[i + 3] = 1.0F;
    }
    auto a = image(f, "bright", 16, 16, api::RenderTextureFormat::rgba32float, f32_bytes(bright), true, std::nullopt, 16, 8, 32, 32);
    api::RenderEffect blur;
    blur.type = "blur";
    blur.params.push_back({"radiusPx", api::RenderParamKind::number, 3, {}, "", {}});
    a.effects.push_back(blur);
    f.scene.renderables.push_back(a);
    auto add = rect(24, 16, 16, 16, {1, 1, 1, 1});
    add.blend = api::RenderBlendMode::add;
    f.scene.renderables.push_back(add);
    return f;
  };
  std::string err;
  double centre32 = 0;
  double centre8 = 0;
  for (const std::uint32_t bits : {32U, 16U, 8U}) {
    Frame frame;
    FrameStats s;
    REQUIRE(r->render(frame_for(bits), &frame, s, err));
    CHECK(s.gpuError.empty());
    TargetPixels scene;
    REQUIRE(r->read_target("scene-color", scene, err));
    const std::size_t c = (std::size_t{24} * kW + 32) * 4;
    const double v = scene.rgba[c];
    INFO("bits " << bits << " centre " << v);
    if (bits == 32) {
      CHECK(r->precision() == IntermediatePrecision::float32);
      CHECK(v > 4.5);  // blurred 4.0 + the added 1.0, kept
      centre32 = v;
      // The surface is clipped at the output encode only.
      CHECK(frame.rgba[(std::size_t{24} * kW + 32) * 4] == 255);
    } else if (bits == 16) {
      CHECK(v > 4.5);
      CHECK(std::abs(v - centre32) < 4e-3);  // half precision: 11-bit mantissa
    } else {
      CHECK(r->precision() == IntermediatePrecision::unorm8);
      CHECK(v <= 1.0);  // unorm intermediates clip before the output
      centre8 = v;
    }
  }
  CHECK(centre32 > centre8 * 4);
}

TEST_CASE("banding: 20 stacked low-opacity layers of a subtle gradient stay exact at 32 bits", "[bitdepth][gpu]") {
  auto r = renderer_or_skip();
  if (!r) return;
  if (!r->supports_float32()) return;
  // v(x) = 0.2 + 0.01·x/63, 20 layers at opacity 0.05 over black: in exact
  // arithmetic C₂₀ = v·(1 − 0.95²⁰).
  std::vector<float> grad;
  for (std::uint32_t y = 0; y < kH; ++y) {
    for (std::uint32_t x = 0; x < kW; ++x) grad.insert(grad.end(), {0.2F + 0.01F * static_cast<float>(x) / 63.0F, 0.2F, 0.2F, 1.0F});
  }
  const auto frame_for = [&](std::uint32_t bits) {
    auto f = base_frame(bits);
    for (int layer = 0; layer < 20; ++layer) {
      auto g = image(f, "grad" + std::to_string(layer), kW, kH, api::RenderTextureFormat::rgba32float, f32_bytes(grad), true,
                     std::nullopt, 0, 0, kW, kH);
      g.opacity = 0.05;
      f.scene.renderables.push_back(g);
    }
    return f;
  };
  std::string err;
  std::array<double, 3> worst{};
  std::array<std::size_t, 3> levels{};
  int slot = 0;
  for (const std::uint32_t bits : {32U, 16U, 8U}) {
    Frame frame;
    FrameStats s;
    REQUIRE(r->render(frame_for(bits), &frame, s, err));
    TargetPixels scene;
    REQUIRE(r->read_target("scene-color", scene, err));
    std::set<float> distinct;
    double w = 0;
    for (std::uint32_t x = 0; x < kW; ++x) {
      const double v = 0.2 + 0.01 * static_cast<double>(static_cast<float>(x) / 63.0F);
      const double exact = v * (1 - std::pow(0.95, 20));
      const float got = scene.rgba[(std::size_t{20} * kW + x) * 4];
      w = std::max(w, std::abs(static_cast<double>(got) - exact));
      distinct.insert(got);
    }
    worst.at(static_cast<std::size_t>(slot)) = w;
    levels.at(static_cast<std::size_t>(slot)) = distinct.size();
    ++slot;
  }
  std::printf("[measure] 20 x 5%% layers of a 1%% gradient: worst |error| 32f %.2e (%zu levels), 16f %.2e (%zu levels), 8 %.2e (%zu levels)\n",
              worst[0], levels[0], worst[1], levels[1], worst[2], levels[2]);
  CHECK(worst[0] < 1e-6);
  CHECK(levels[0] == kW);          // every column its own value: no banding
  CHECK(worst[1] > worst[0] * 10);  // half floats drift across 20 blends
  CHECK(levels[2] < levels[0] / 4);  // unorm8: the gradient collapses into bands
}

TEST_CASE("mip-mapped textures: the chain is generated and minification filters through it", "[mip][gpu]") {
  auto r = renderer_or_skip();
  if (!r) return;
  CHECK(mip_levels(256, 256) == 9);
  CHECK(mip_levels(256, 1) == 9);
  CHECK(mip_levels(1, 1) == 1);
  // 256² of deterministic 0/255 noise (an LCG), drawn at 32² (8:1). Mipped:
  // every output pixel is the mean of its 64-texel footprint (≈ mid grey, low
  // spread). Un-mipped: bilinear reads 4 texels, the rest alias.
  std::vector<std::uint8_t> noise(256 * 256 * 4);
  std::uint32_t lcg = 12345;
  for (std::size_t i = 0; i < noise.size(); i += 4) {
    lcg = lcg * 1664525U + 1013904223U;
    const std::uint8_t v = (lcg >> 24U) & 1U ? 255 : 0;
    noise[i] = noise[i + 1] = noise[i + 2] = v;
    noise[i + 3] = 255;
  }
  const auto spread = [&](bool mipmapped) {
    auto f = base_frame(16);
    f.scene.renderables.push_back(image(f, mipmapped ? "noise-mip" : "noise", 256, 256, api::RenderTextureFormat::rgba8unorm, noise, false,
                                        std::nullopt, 16, 8, 32, 32, mipmapped));
    Frame frame;
    FrameStats s;
    std::string err;
    REQUIRE(r->render(f, &frame, s, err));
    CHECK(s.gpuError.empty());
    double sum = 0;
    double sum2 = 0;
    for (std::uint32_t y = 9; y < 39; ++y) {
      for (std::uint32_t x = 17; x < 47; ++x) {
        const double v = frame.rgba[(std::size_t{y} * kW + x) * 4];
        sum += v;
        sum2 += v * v;
      }
    }
    const double n = 30.0 * 30.0;
    return std::sqrt(std::max(0.0, sum2 / n - (sum / n) * (sum / n)));
  };
  const double mipped = spread(true);
  const double aliased = spread(false);
  std::printf("[measure] 8:1 minified 0/255 noise, output std-dev: mip-mapped %.1f, single level %.1f\n", mipped, aliased);
  CHECK(mipped < 20);
  CHECK(aliased > 40);
}

TEST_CASE("the overlay pass draws the grid, the proportional grid and guides (OverlayPass.ts)", "[overlay][gpu]") {
  auto r = renderer_or_skip();
  if (!r) return;
  auto f = base_frame(16);
  f.scene.background = api::Color{0, 0, 0, 1};
  api::RenderOverlays o;
  o.grid = true;
  o.grid_spacing = 16;
  o.grid_subdivisions = 1;
  o.grid_style = api::RenderGridStyle::lines;
  o.grid_color = api::Color{1, 0, 0, 1};
  o.proportional_grid = true;
  o.proportional_columns = 2;
  o.proportional_rows = 1;
  o.comp_rect = api::Rect{0, 0, kW, kH};
  api::RenderGuide guide;
  guide.axis = api::RenderGuideAxis::y;
  guide.position = 20;
  guide.color = api::Color{0, 1, 0, 1};
  o.guides.push_back(guide);
  f.view.overlays_active = true;
  f.view.overlays = o;
  Frame frame;
  FrameStats s;
  std::string err;
  REQUIRE(r->render(f, &frame, s, err));
  CHECK(s.gpuError.empty());
  const auto px = [&](std::uint32_t x, std::uint32_t y, std::size_t c) { return frame.rgba.at((std::size_t{y} * kW + x) * 4 + c); };
  // Vertical grid lines at x = 16, 32, 48 (1 px): the solid colour, as the TS
  // pass sends it (packColor linearises; the surface stores it as is).
  for (const std::uint32_t x : {16U, 48U}) {
    CHECK(px(x, 5, 0) == 255);
    CHECK(px(x, 5, 1) == 0);
  }
  CHECK(px(8, 5, 0) == 0);  // between lines: the black comp
  // The proportional grid's single interior column line is at x = 32 (same colour).
  CHECK(px(32, 5, 0) == 255);
  // The guide at y = 20 is green, drawn after (over) the grid.
  CHECK(px(8, 20, 1) == 255);
  CHECK(px(8, 20, 0) == 0);
  CHECK(px(16, 20, 1) == 255);
  // Horizontal grid line at y = 32.
  CHECK(px(8, 32, 0) == 255);
}

TEST_CASE("the viewer LUT blit applies the LUT after the display encode (scene-blit-lut)", "[viewerlut][gpu]") {
  auto r = renderer_or_skip();
  if (!r) return;
  // A 1D inverting LUT (2 entries: 0 → 1, 1 → 0) at full intensity: out = 1 − encode(in).
  auto f = base_frame(16);
  f.scene.renderables.push_back(rect(0, 0, kW, kH, {0.25, 0.5, 0.75, 1}));
  const std::vector<std::uint8_t> strip = {255, 255, 255, 255, 0, 0, 0, 255};
  f.blobs.push_back({"hash:viewer-lut", 2, 1, api::RenderTextureFormat::rgba8unorm, strip, false});
  api::RenderTextureRef ref;
  ref.key = "viewer-lut";
  ref.hash = "hash:viewer-lut";
  ref.ready = true;
  f.textures.push_back(ref);
  f.view.viewer_lut_active = true;
  f.view.viewer_lut = api::RenderViewerLut{2, true, 1.0, 0.0, 1.0};
  Frame lutFrame;
  FrameStats s;
  std::string err;
  REQUIRE(r->render(f, &lutFrame, s, err));
  CHECK(s.gpuError.empty());
  f.view.viewer_lut_active = false;
  Frame plain;
  REQUIRE(r->render(f, &plain, s, err));
  for (std::size_t c = 0; c < 3; ++c) {
    const int encoded = plain.rgba.at((std::size_t{24} * kW + 32) * 4 + c);
    const int inverted = lutFrame.rgba.at((std::size_t{24} * kW + 32) * 4 + c);
    INFO("channel " << c);
    CHECK(std::abs(inverted - (255 - encoded)) <= 1);
  }
}
