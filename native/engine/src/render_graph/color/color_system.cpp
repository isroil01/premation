#include "color_system.hpp"

#include <array>
#include <cstring>

#include "color_wgsl.hpp"
#include "render_context.hpp"
#include "uniforms.hpp"

namespace premation::rg {
namespace {

color::Space space_of(api::RenderColorSpace s) noexcept {
  switch (s) {
    case api::RenderColorSpace::srgb: return color::Space::srgb;
    case api::RenderColorSpace::rec709: return color::Space::rec709;
    case api::RenderColorSpace::linear_srgb: return color::Space::linear_srgb;
    case api::RenderColorSpace::aces_cg: return color::Space::aces_cg;
    case api::RenderColorSpace::rec2020: return color::Space::rec2020;
    case api::RenderColorSpace::linear_rec2020: return color::Space::linear_rec2020;
    case api::RenderColorSpace::aces2065: return color::Space::aces2065;
  }
  return color::Space::srgb;
}

constexpr std::array<LayoutEntry, 5> kDisplayLayout{{{0, BindingType::uniform, kStageVertex | kStageFragment},
                                                     {1, BindingType::texture, kStageFragment},
                                                     {2, BindingType::sampler, kStageFragment},
                                                     {3, BindingType::unfilterable, kStageFragment},
                                                     {4, BindingType::texture, kStageFragment}}};
constexpr std::array<LayoutEntry, 3> kInputLayout{{{0, BindingType::uniform, kStageVertex | kStageFragment},
                                                   {1, BindingType::unfilterable, kStageFragment},
                                                   {3, BindingType::unfilterable, kStageFragment}}};

}  // namespace

#if PREMATION_HAVE_OCIO
bool ColorSystem::available() noexcept { return true; }
#else
bool ColorSystem::available() noexcept { return false; }
namespace color {
// No OpenColorIO in this build (no vcpkg `engine` feature): every request fails
// cleanly and support.cpp reports managed frames not-ported.
std::unique_ptr<Ocio> Ocio::open(std::string_view /*config*/, std::string& error) {
  error = "this build has no OpenColorIO (vcpkg feature `engine`)";
  return nullptr;
}
struct Ocio::Impl {};  // nothing to hold without OpenColorIO
Ocio::~Ocio() = default;
bool Ocio::program(const Request& /*req*/, Program& /*out*/, std::string& error) const {
  error = "no OpenColorIO";
  return false;
}
bool Ocio::apply_cpu(const Request& /*req*/, std::span<float> /*rgb*/, std::string& error) const {
  error = "no OpenColorIO";
  return false;
}
bool Ocio::describe(const Request& /*req*/, std::string& /*out*/, std::string& error) const {
  error = "no OpenColorIO";
  return false;
}
}  // namespace color
#endif

ColorSystem::ColorSystem(Device& dev) : dev_(dev) {}
ColorSystem::~ColorSystem() = default;

const color::Program* ColorSystem::program(const color::Request& req, std::string& error) {
  const std::string key = req.key();
  if (const auto it = programs_.find(key); it != programs_.end()) return &it->second;
  if (!ocio_) {
    ocio_ = color::Ocio::open(configName_, error);
    if (!ocio_) return nullptr;
  }
  color::Program p;
  if (!ocio_->program(req, p, error)) return nullptr;
  return &programs_.emplace(key, std::move(p)).first->second;
}

bool ColorSystem::begin_frame(const api::RenderView& view, IntermediatePrecision precision, ColorPipeline& pipeline,
                              std::string& error) {
  active_ = false;
  display_ = nullptr;
  pipeline.managed = false;
  if (!view.color_management) return true;
  const api::RenderColorManagement& cm = *view.color_management;
  const std::string config = cm.ocio_config.value_or("");
  if (config != configName_) {
    // A different config invalidates every program built from the old one.
    configName_ = config;
    ocio_.reset();
    programs_.clear();
    luts_.clear();
  }
  working_ = space_of(cm.working_space);
  inputFormat_ = precision == IntermediatePrecision::float32 ? wgpu::TextureFormat::RGBA32Float : wgpu::TextureFormat::RGBA16Float;
  color::Request display;
  display.src = working_;
  display.dst = space_of(cm.output_space.value_or(cm.display_space));
  display.view = cm.view.value_or("");
  if (forceLattice_ != 0) {
    display.forceLut = true;
    display.lutSize = forceLattice_;
  }
  display_ = program(display, error);
  if (display_ == nullptr) return false;
  // Authored colours: sRGB-decoded, then linear Rec.709 → working primaries.
  color::Request primaries;
  primaries.src = color::Space::linear_srgb;
  primaries.dst = working_;
  std::array<float, 9> basis = {1, 0, 0, 0, 1, 0, 0, 0, 1};
  if (!ocio_->apply_cpu(primaries, basis, error)) return false;
  for (std::size_t r = 0; r < 3; ++r) {
    for (std::size_t c = 0; c < 3; ++c) pipeline.fromLinear709.at(r * 3 + c) = basis.at(c * 3 + r);  // column c = image of e_c
  }
  pipeline.managed = true;
  if (!materials_) {
    displayMat_ = dev_.dynamic_material("cm-display", shaders::color_display_wgsl(), kDisplayLayout);
    inputMat_ = dev_.dynamic_material("cm-input", shaders::color_input_wgsl(), kInputLayout);
    materials_ = true;
  }
  active_ = true;
  return true;
}

TexRef ColorSystem::dummy_f32() {
  static constexpr std::array<std::uint8_t, 16> kZero{};
  return dev_.texture("cm:dummy-f32", 1, 1, wgpu::TextureFormat::RGBA32Float, kZero, false);
}

TexRef ColorSystem::dummy_rgba8() {
  static constexpr std::array<std::uint8_t, 4> kZero{};
  return dev_.texture("cm:dummy-rgba8", 1, 1, wgpu::TextureFormat::RGBA8Unorm, kZero, false);
}

TexRef ColorSystem::lut_texture(const color::Program& p) {
  if (!p.baked()) return dummy_f32();
  // Uploaded once per program and held here (the view keeps the texture alive
  // past the pool's GC), so a frame never re-packs the lattice.
  if (const auto it = luts_.find(p.key); it != luts_.end()) return it->second;
  std::vector<std::uint8_t> bytes(p.lut.size() * sizeof(float));
  std::memcpy(bytes.data(), p.lut.data(), bytes.size());
  const TexRef t = dev_.texture("cm:lut:" + p.key, p.lutSize * p.lutSize, p.lutSize, wgpu::TextureFormat::RGBA32Float, bytes, false);
  luts_.emplace(p.key, t);
  return t;
}

void ColorSystem::pack_object(std::vector<float>& out, const color::Program& p, const std::array<double, 4>& viewer) {
  const ColorPipeline plain{};
  Packer pk(out, plain);
  pk.mat3(screen_mvp()).rect({0, 0, 1, 1}).vec4(static_cast<double>(p.ops.size()), 0, 0, 0).vec4(viewer[0], viewer[1], viewer[2], viewer[3]);
  color::pack(p, out);
}

TexRef ColorSystem::input(const TexRef& src, std::string_view hash, api::RenderColorSpace space) {
  // Managed frames only: a couple of short key strings per colour texture per
  // frame (the program + target lookups); the conversion itself runs once.
  color::Request req;
  req.src = space_of(space);
  req.dst = working_;
  std::string error;
  const color::Program* p = program(req, error);
  if (p == nullptr || !src) return src;  // the frame's diagnostics already carry OCIO failures (begin_frame)
  std::string name = "cm-in:";
  name += hash;
  name += ':';
  name += p->key;
  bool created = false;
  RenderTarget& t = dev_.target(name, src.width, src.height, inputFormat_, 1, false, &created);
  if (created) {
    DrawItem it;
    it.material = inputMat_;
    it.texture = src;
    it.mask = lut_texture(*p);
    pack_object(scratch_, *p, {0, 0, 0, 0});
    dev_.side_draw(t.view, t.format, t.width, t.height, it, scratch_);
  }
  TexRef out = t.tex();
  out.sampleLinear = true;
  return out;
}

void ColorSystem::emit_display(PassContext& ctx, Commands& cmds, const TexRef& scene, const TexRef& viewerTex,
                               const api::RenderViewerLut* viewerMeta) {
  if (display_ == nullptr) return;
  std::array<double, 4> viewer{0, 0, 0, 0};
  const bool lut = viewerMeta != nullptr && viewerTex;
  if (lut) {
    // packSceneBlitLut's cr0: ±size (negative = 1D), intensity, domain.
    viewer = {viewerMeta->is1d ? -static_cast<double>(viewerMeta->size) : static_cast<double>(viewerMeta->size), viewerMeta->intensity,
              viewerMeta->domain_min, viewerMeta->domain_max};
  }
  pack_object(scratch_, *display_, viewer);
  DrawItem& it = cmds.add(displayMat_, Blend::none, scratch_);
  it.texture = scene;
  it.sampler = ctx.linear_clamp();
  it.mask = lut_texture(*display_);
  it.origin = lut ? viewerTex : dummy_rgba8();
}

}  // namespace premation::rg
