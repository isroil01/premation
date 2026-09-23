// E1 media on the GPU (Dawn): decoded frame → RGBA16F texture against the
// CPU twin of the conversion; the zero-copy hardware route (D3D11VA surface
// imported into Dawn) against the software decode of the same stream; and
// the render graph's media texture source.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <webgpu/webgpu_cpp.h>

#include <chrono>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <optional>

#include "decoder.hpp"
#include "frame_convert.hpp"
#include "media_fixture_ffi.hpp"
#include "media_system.hpp"
#include "media_textures.hpp"
#include "platform_ffi.hpp"
#include "yuv.hpp"

using namespace premation::media;
using namespace std::chrono_literals;
namespace fs = std::filesystem;

namespace {

struct Gpu {
  wgpu::Instance instance;
  wgpu::Adapter adapter;
  wgpu::Device device;
};

std::optional<Gpu> make_gpu() {
  static constexpr auto kTimedWaitAny = wgpu::InstanceFeatureName::TimedWaitAny;
  wgpu::InstanceDescriptor id{};
  id.requiredFeatureCount = 1;
  id.requiredFeatures = &kTimedWaitAny;
  Gpu g;
  g.instance = wgpu::CreateInstance(&id);
  wgpu::RequestAdapterOptions o{};
#if defined(_WIN32)
  o.backendType = wgpu::BackendType::D3D12;
#endif
  o.powerPreference = wgpu::PowerPreference::HighPerformance;
  g.instance.WaitAny(g.instance.RequestAdapter(&o, wgpu::CallbackMode::WaitAnyOnly,
                                               [&g](wgpu::RequestAdapterStatus s, wgpu::Adapter a, wgpu::StringView) {
                                                 if (s == wgpu::RequestAdapterStatus::Success) g.adapter = std::move(a);
                                               }),
                     UINT64_MAX);
  if (g.adapter == nullptr) return std::nullopt;
  const auto features = wanted_device_features(g.adapter);
  wgpu::DeviceDescriptor dd{};
  dd.requiredFeatureCount = features.size();
  dd.requiredFeatures = features.data();
  dd.SetUncapturedErrorCallback([](const wgpu::Device&, wgpu::ErrorType, wgpu::StringView msg) {
    FAIL_CHECK("Dawn error: " << std::string_view(msg.data, msg.length == wgpu::kStrlen ? std::strlen(msg.data) : msg.length));
  });
  g.instance.WaitAny(g.adapter.RequestDevice(&dd, wgpu::CallbackMode::WaitAnyOnly,
                                             [&g](wgpu::RequestDeviceStatus s, wgpu::Device d, wgpu::StringView) {
                                               if (s == wgpu::RequestDeviceStatus::Success) g.device = std::move(d);
                                             }),
                     UINT64_MAX);
  if (g.device == nullptr) return std::nullopt;
  return g;
}

float half_to_float(std::uint16_t h) {
  const std::uint32_t s = (h >> 15U) & 1U;
  const std::uint32_t e = (h >> 10U) & 0x1FU;
  const std::uint32_t m = h & 0x3FFU;
  float v = 0;
  if (e == 0) {
    v = std::ldexp(static_cast<float>(m), -24);
  } else if (e == 31) {
    v = m == 0 ? INFINITY : NAN;
  } else {
    v = std::ldexp(static_cast<float>(m | 0x400U), static_cast<int>(e) - 25);
  }
  return s != 0 ? -v : v;
}

/// RGBA16F texture → float RGBA, top-down.
std::vector<float> read_back(const Gpu& g, const ConvertedFrame& t) {
  const std::uint32_t rowBytes = (t.width * 8 + 255) & ~255U;
  wgpu::BufferDescriptor bd{};
  bd.size = std::uint64_t{rowBytes} * t.height;
  bd.usage = wgpu::BufferUsage::CopyDst | wgpu::BufferUsage::MapRead;
  const wgpu::Buffer buf = g.device.CreateBuffer(&bd);
  wgpu::CommandEncoder enc = g.device.CreateCommandEncoder();
  wgpu::TexelCopyTextureInfo src{};
  src.texture = t.texture;
  wgpu::TexelCopyBufferInfo dst{};
  dst.buffer = buf;
  dst.layout.bytesPerRow = rowBytes;
  dst.layout.rowsPerImage = t.height;
  const wgpu::Extent3D ext{t.width, t.height, 1};
  enc.CopyTextureToBuffer(&src, &dst, &ext);
  const wgpu::CommandBuffer cb = enc.Finish();
  g.device.GetQueue().Submit(1, &cb);
  bool done = false;
  g.instance.WaitAny(buf.MapAsync(wgpu::MapMode::Read, 0, bd.size, wgpu::CallbackMode::WaitAnyOnly,
                                  [&done](wgpu::MapAsyncStatus s, wgpu::StringView) { done = s == wgpu::MapAsyncStatus::Success; }),
                     UINT64_MAX);
  REQUIRE(done);
  const auto* bytes = static_cast<const std::uint8_t*>(buf.GetConstMappedRange(0, bd.size));
  std::vector<float> out(std::size_t{t.width} * t.height * 4);
  for (std::uint32_t y = 0; y < t.height; ++y) {
    for (std::uint32_t x = 0; x < t.width * 4; ++x) {
      std::uint16_t h = 0;
      std::memcpy(&h, bytes + std::size_t{y} * rowBytes + std::size_t{x} * 2, 2);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      out[std::size_t{y} * t.width * 4 + x] = half_to_float(h);
    }
  }
  buf.Unmap();
  return out;
}

std::uint32_t sample(const DecodedFrame& f, std::size_t plane, std::uint32_t x, std::uint32_t y, std::uint32_t comp = 0) {
  const Plane& p = f.planes.at(plane);
  const std::uint8_t* row = p.data + std::size_t{y} * p.stride;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  const std::size_t i = (std::size_t{x} * p.components + comp) * f.format.bytesPerSample;
  if (f.format.bytesPerSample == 2) {
    return (static_cast<std::uint32_t>(row[i]) | (static_cast<std::uint32_t>(row[i + 1]) << 8U)) >> f.format.storageShift;  // NOLINT
  }
  return row[i];  // NOLINT
}

FramePtr decode_one(const std::string& path, std::int64_t frame, DecoderOptions opt) {
  std::string error;
  auto d = VideoDecoder::open(path, opt, error);
  REQUIRE(d);
  REQUIRE(d->seek(frame, error));
  for (;;) {
    FramePtr f;
    REQUIRE(d->next(f, error) == DecodeStatus::frame);
    if (f->index >= frame) return f;
  }
}

std::string fixture_path(fixture::Kind k, const char* name) {
  const fs::path p = fs::temp_directory_path() / "premation-media-tests" / name;
  fs::create_directories(p.parent_path());
  fixture::Spec s;
  s.kind = k;
  s.frames = 8;
  std::string error;
  REQUIRE(fixture::write(s, p.string(), error));
  return p.string();
}

}  // namespace

TEST_CASE("GPU conversion matches the CPU twin: ProRes 4444 (4:4:4 10-bit + alpha, premultiplied)", "[media][gpu]") {
  const auto g = make_gpu();
  if (!g) SKIP("no GPU adapter");
  DecoderOptions opt;
  opt.hw = HwPolicy::softwareOnly;
  const FramePtr f = decode_one(fixture_path(fixture::Kind::prores4444, "gpu-4444.mov"), 5, opt);
  FrameConverter conv(g->device);
  ConvertedFrame out;
  std::string error;
  REQUIRE(conv.convert(*f, AlphaMode::straight, out, error));
  const auto px = read_back(*g, out);
  const YuvToRgb c = yuv_to_rgb(f->format);
  double worst = 0;
  for (const std::uint32_t y : {0U, 37U, 71U, 143U}) {
    for (const std::uint32_t x : {0U, 60U, 130U, 200U, 255U}) {
      const auto ref = convert_codes(c, sample(*f, 0, x, y), sample(*f, 1, x, y), sample(*f, 2, x, y), sample(*f, 3, x, y), true);
      for (std::size_t k = 0; k < 3; ++k) worst = std::max(worst, std::abs(px[(std::size_t{y} * out.width + x) * 4 + k] - ref.at(k) * ref[3]));
      worst = std::max(worst, std::abs(px[(std::size_t{y} * out.width + x) * 4 + 3] - ref[3]));
    }
  }
  INFO("worst abs error " << worst);
  CHECK(worst < 1.5e-3);  // half-float output: ~2^-11 at 1.0
}

TEST_CASE("GPU conversion: 4:2:2 chroma upsampling co-sited (ProRes 422 HQ), planar RGB (FFV1)", "[media][gpu]") {
  const auto g = make_gpu();
  if (!g) SKIP("no GPU adapter");
  DecoderOptions opt;
  opt.hw = HwPolicy::softwareOnly;
  FrameConverter conv(g->device);
  std::string error;
  {
    const FramePtr f = decode_one(fixture_path(fixture::Kind::prores422, "gpu-422.mov"), 3, opt);
    ConvertedFrame out;
    REQUIRE(conv.convert(*f, AlphaMode::straight, out, error));
    const auto px = read_back(*g, out);
    const YuvToRgb c = yuv_to_rgb(f->format);
    // Even luma columns sit exactly on a chroma sample.
    for (const std::uint32_t x : {10U, 64U, 200U}) {
      const std::uint32_t y = 50;
      const auto ref = convert_codes(c, sample(*f, 0, x, y), sample(*f, 1, x / 2, y), sample(*f, 2, x / 2, y), 0, false);
      for (std::size_t k = 0; k < 3; ++k) CHECK(px[(std::size_t{y} * out.width + x) * 4 + k] == Catch::Approx(ref.at(k)).margin(1.5e-3));
      CHECK(px[(std::size_t{y} * out.width + x) * 4 + 3] == 1.0F);
    }
    conv.recycle(std::move(out));
  }
  {
    const FramePtr f = decode_one(fixture_path(fixture::Kind::ffv1rgb, "gpu-ffv1.mkv"), 2, opt);
    ConvertedFrame out;
    REQUIRE(conv.convert(*f, AlphaMode::straight, out, error));
    const auto px = read_back(*g, out);
    const double code = sample(*f, 0, 10, 10);
    CHECK(px[(10 * std::size_t{out.width} + 10) * 4] == Catch::Approx(code / 1023.0).margin(1e-3));
  }
}

TEST_CASE("zero-copy: D3D11VA surface imported into Dawn equals the software decode", "[media][gpu][hw]") {
  const auto g = make_gpu();
  if (!g) SKIP("no GPU adapter");
  FrameConverter conv(g->device);
  if (!conv.zero_copy_capable()) SKIP("Dawn device lacks shared-handle / multi-planar import");
#ifndef PREMATION_MEDIA_FIXTURES
  SKIP("no fixture dir");
#else
  const std::string p = std::string(PREMATION_MEDIA_FIXTURES) + "/tiny-bframes.mp4";
  HwContextOptions ho;
  ho.adapterLuid = platform::adapter_luid(g->device);
  std::string error;
  auto hw = create_hw_context(ho, error);
  if (!hw) SKIP("no D3D11VA device: " << error);
  DecoderOptions hopt;
  hopt.hw = HwPolicy::hardwareOnly;
  hopt.hwContext = hw;
  hopt.keepOnGpu = true;
  DecoderOptions sopt;
  sopt.hw = HwPolicy::softwareOnly;
  for (const std::int64_t frame : {std::int64_t{0}, std::int64_t{5}, std::int64_t{9}}) {
    const FramePtr hf = decode_one(p, frame, hopt);
    REQUIRE(hf->gpu != nullptr);  // stayed on the GPU
    const FramePtr sf = decode_one(p, frame, sopt);
    ConvertedFrame a;
    ConvertedFrame b;
    REQUIRE(conv.convert(*hf, AlphaMode::straight, a, error));
    CHECK(a.zeroCopy);
    REQUIRE(conv.convert(*sf, AlphaMode::straight, b, error));
    const auto pa = read_back(*g, a);
    const auto pb = read_back(*g, b);
    REQUIRE(pa.size() == pb.size());
    double worst = 0;
    for (std::size_t i = 0; i < pa.size(); ++i) worst = std::max(worst, static_cast<double>(std::abs(pa[i] - pb[i])));
    INFO("frame " << frame << " worst " << worst);
    CHECK(worst < 2e-3);
    conv.recycle(std::move(a));
    conv.recycle(std::move(b));
  }
  CHECK(conv.stats().zeroCopy == 3);
#endif
}

TEST_CASE("MediaTextures: media hashes resolve to textures; preview never blocks", "[media][gpu]") {
  CHECK(parse_media_hash("media:3:17")->frame == 17);
  CHECK(parse_media_hash("media:3:17~16")->bottom == 16);
  CHECK_FALSE(parse_media_hash("media:0:1"));
  CHECK_FALSE(parse_media_hash("sha:abc"));
  CHECK_FALSE(parse_media_hash("media:3:x"));
  CHECK(media_hash(3, 17) == "media:3:17");
  CHECK(media_hash(3, 17, 16) == "media:3:17~16");

  const auto g = make_gpu();
  if (!g) SKIP("no GPU adapter");
  MediaSystem ms(MediaConfig{});
  std::string error;
  const auto id = ms.open(fixture_path(fixture::Kind::prores422, "tex-422.mov"), error);
  REQUIRE(id);
  REQUIRE(ms.wait_ready(*id, 10s));
  MediaTextures tex(ms, g->device, MediaTextures::Mode::exact);
  const auto t = tex.external_texture(media_hash(*id, 4));
  REQUIRE(t);
  CHECK(t.width == 256);
  CHECK((t.id >> 63U) == 1U);
  // Same hash again: cached, same texture.
  CHECK(tex.external_texture(media_hash(*id, 4)).id == t.id);
  // Weave of two fields.
  CHECK(tex.external_texture(media_hash(*id, 3, 2)));
  // Preview: an undecoded frame falls back to the nearest cached one.
  tex.set_mode(MediaTextures::Mode::preview);
  const auto near = tex.external_texture(media_hash(*id, 7));
  CHECK(near);
  const auto m = tex.take_misses();
  CHECK(m.approximate + m.skipped <= 1);
  CHECK_FALSE(tex.external_texture("media:99:0"));
}
