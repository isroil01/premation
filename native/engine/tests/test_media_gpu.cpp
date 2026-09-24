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
#include "media_gpu_harness.hpp"
#include "media_system.hpp"
#include "media_textures.hpp"
#include "platform_ffi.hpp"
#include "swscale_ref_ffi.hpp"
#include "yuv.hpp"

using namespace premation::media;
using namespace premation::media::testing;
using namespace std::chrono_literals;
namespace fs = std::filesystem;

namespace {

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

namespace {

/// A synthetic CPU frame over `img`'s codes: planar 4:4:4 (8- or 16-bit words),
/// or semi-planar 4:4:4 with the code MSB-aligned in 16 bits (P010/P012/P016's
/// storage, as the hardware download route delivers it).
struct SyntheticFrame {
  std::vector<std::uint8_t> y, u, v, uv;
  std::shared_ptr<DecodedFrame> frame = std::make_shared<DecodedFrame>();
};

SyntheticFrame synthetic(const swsref::Yuv444& img, Matrix m, Range r, bool semiPlanar) {
  SyntheticFrame s;
  DecodedFrame& f = *s.frame;
  const std::uint8_t bytes = img.bitDepth > 8 ? 2 : 1;
  const std::uint8_t shift = semiPlanar ? static_cast<std::uint8_t>(16 - img.bitDepth) : 0;
  f.width = img.width;
  f.height = img.height;
  f.format.layout = semiPlanar ? Layout::semiPlanarYuv : Layout::planarYuv;
  f.format.bitDepth = img.bitDepth;
  f.format.bytesPerSample = bytes;
  f.format.storageShift = shift;
  f.format.chromaShiftX = 0;
  f.format.chromaShiftY = 0;
  f.format.matrix = m;
  f.format.range = r;
  auto put = [bytes, shift](std::vector<std::uint8_t>& dst, std::uint16_t code) {
    const auto v = static_cast<std::uint16_t>(code << shift);
    dst.push_back(static_cast<std::uint8_t>(v & 0xFFU));
    if (bytes == 2) dst.push_back(static_cast<std::uint8_t>(v >> 8U));
  };
  for (std::size_t i = 0; i < img.y.size(); ++i) {
    put(s.y, img.y[i]);
    if (semiPlanar) {
      put(s.uv, img.cb[i]);
      put(s.uv, img.cr[i]);
    } else {
      put(s.u, img.cb[i]);
      put(s.v, img.cr[i]);
    }
  }
  const std::size_t row = std::size_t{img.width} * bytes;
  f.planes[0] = {s.y.data(), row, img.width, img.height, 1};
  if (semiPlanar) {
    f.planes[1] = {s.uv.data(), row * 2, img.width, img.height, 2};
    f.planeCount = 2;
  } else {
    f.planes[1] = {s.u.data(), row, img.width, img.height, 1};
    f.planes[2] = {s.v.data(), row, img.width, img.height, 1};
    f.planeCount = 3;
  }
  return s;
}

}  // namespace

TEST_CASE("GPU conversion matches swscale: BT.601/709/2020 x limited/full x 8/10/12-bit, planar and P01x", "[media][gpu][color]") {
  const auto g = make_gpu();
  if (!g) SKIP("no GPU adapter");
  FrameConverter conv(g->device);
  // swscale (one 8-bit step short of white at worst: see test_media_color.cpp) + the RGBA16F output (half a ulp: 2.4e-4 at 1.0).
  constexpr double kTolerance = 5e-3;
  for (const Matrix m : {Matrix::smpte170m, Matrix::bt709, Matrix::bt2020nc}) {
    for (const Range r : {Range::limited, Range::full}) {
      for (const std::uint8_t depth : {std::uint8_t{8}, std::uint8_t{10}, std::uint8_t{12}}) {
        const swsref::Yuv444 img = swsref::code_grid(depth, r);
        std::vector<double> ref;
        std::string error;
        REQUIRE(swsref::to_rgb(img, m, r, ref, error));
        for (const bool semi : {false, true}) {
          if (semi && depth == 8) continue;  // 8-bit semi-planar is NV12: the zero-copy test covers it
          const SyntheticFrame sf = synthetic(img, m, r, semi);
          ConvertedFrame out;
          REQUIRE(conv.convert(*sf.frame, AlphaMode::straight, out, error));
          const auto px = read_back(*g, out);
          // Against swscale, and (tighter) against the CPU twin of the same matrices.
          const YuvToRgb twin = yuv_to_rgb(sf.frame->format);
          double worst = 0;
          double worstTwin = 0;
          for (std::size_t i = 0; i < img.y.size(); ++i) {
            const auto o = convert_codes(twin, img.y[i], img.cb[i], img.cr[i], 0, false);
            for (std::size_t k = 0; k < 3; ++k) {
              const double gpu = static_cast<double>(px.at(i * 4 + k));
              worst = std::max(worst, std::abs(gpu - ref.at(i * 3 + k)));
              worstTwin = std::max(worstTwin, std::abs(gpu - o.at(k)));
            }
          }
          INFO("matrix " << static_cast<int>(m) << " range " << static_cast<int>(r) << " depth " << int{depth} << (semi ? " semi-planar" : " planar")
                         << ": worst " << worst << " vs swscale, " << worstTwin << " vs the CPU twin");
          CHECK(worst < kTolerance);
          CHECK(worstTwin < 1.5e-3);  // half-float output: ~2^-11 at 1.0
          conv.recycle(std::move(out));
        }
      }
    }
  }
}