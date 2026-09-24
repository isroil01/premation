// D4: the frame cache (render/frame_cache.hpp) — a stored frame comes back
// byte-identical, the byte budget is honoured LRU-first, and a key only ever
// serves a frame of its own size. Skips when no adapter exists.
#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <optional>
#include <vector>

#include "frame_cache.hpp"
#include "gpu.hpp"

using namespace premation;

namespace {

std::optional<Gpu>& cache_gpu() {
  static std::optional<Gpu> gpu = create_gpu(false, true, 0);
  return gpu;
}

wgpu::Texture make_texture(const Gpu& gpu, std::uint32_t w, std::uint32_t h) {
  wgpu::TextureDescriptor td{};
  td.size = {w, h, 1};
  td.format = wgpu::TextureFormat::RGBA8Unorm;
  td.usage = wgpu::TextureUsage::CopySrc | wgpu::TextureUsage::CopyDst;
  return gpu.device.CreateTexture(&td);
}

/// A texture filled with a pattern that depends on `seed`.
wgpu::Texture filled(const Gpu& gpu, std::uint32_t w, std::uint32_t h, std::uint8_t seed) {
  wgpu::Texture t = make_texture(gpu, w, h);
  std::vector<std::uint8_t> px(static_cast<std::size_t>(w) * h * 4);
  for (std::size_t i = 0; i < px.size(); ++i) px[i] = static_cast<std::uint8_t>((i * 7U + seed) & 0xFFU);
  wgpu::TexelCopyTextureInfo dst{};
  dst.texture = t;
  wgpu::TexelCopyBufferLayout layout{};
  layout.bytesPerRow = w * 4;
  layout.rowsPerImage = h;
  const wgpu::Extent3D size{w, h, 1};
  gpu.queue.WriteTexture(&dst, px.data(), px.size(), &layout, &size);
  return t;
}

std::vector<std::uint8_t> read(const Gpu& gpu, const wgpu::Texture& tex, std::uint32_t w, std::uint32_t h) {
  const std::uint32_t row = (w * 4 + 255U) & ~255U;
  wgpu::BufferDescriptor bd{};
  bd.size = static_cast<std::uint64_t>(row) * h;
  bd.usage = wgpu::BufferUsage::MapRead | wgpu::BufferUsage::CopyDst;
  const wgpu::Buffer buf = gpu.device.CreateBuffer(&bd);
  wgpu::CommandEncoder enc = gpu.device.CreateCommandEncoder();
  wgpu::TexelCopyTextureInfo src{};
  src.texture = tex;
  wgpu::TexelCopyBufferInfo dst{};
  dst.buffer = buf;
  dst.layout.bytesPerRow = row;
  dst.layout.rowsPerImage = h;
  const wgpu::Extent3D size{w, h, 1};
  enc.CopyTextureToBuffer(&src, &dst, &size);
  const wgpu::CommandBuffer cb = enc.Finish();
  gpu.queue.Submit(1, &cb);
  gpu.instance.WaitAny(buf.MapAsync(wgpu::MapMode::Read, 0, bd.size, wgpu::CallbackMode::WaitAnyOnly,
                                    [](wgpu::MapAsyncStatus, wgpu::StringView) {}),
                       UINT64_MAX);
  const auto* p = static_cast<const std::uint8_t*>(buf.GetConstMappedRange());
  std::vector<std::uint8_t> out(static_cast<std::size_t>(w) * h * 4);
  for (std::uint32_t y = 0; y < h; ++y) {
    std::copy_n(p + static_cast<std::size_t>(y) * row, w * 4, out.data() + static_cast<std::size_t>(y) * w * 4);
  }
  buf.Unmap();
  return out;
}

void submit(const Gpu& gpu, wgpu::CommandEncoder& enc) {
  const wgpu::CommandBuffer cb = enc.Finish();
  gpu.queue.Submit(1, &cb);
}

}  // namespace

TEST_CASE("frame cache: a stored frame comes back byte-identical", "[gpu][d4]") {
  auto& gpu = cache_gpu();
  if (!gpu) SKIP("no GPU adapter");
  constexpr std::uint32_t W = 64;
  constexpr std::uint32_t H = 48;
  render::FrameCache cache(gpu->device, std::size_t{1} << 20U);
  const wgpu::Texture a = filled(*gpu, W, H, 3);
  const auto expected = read(*gpu, a, W, H);

  wgpu::CommandEncoder e1 = gpu->device.CreateCommandEncoder();
  cache.store(42, W, H, a, e1);
  submit(*gpu, e1);
  CHECK(cache.contains(42));

  const wgpu::Texture out = make_texture(*gpu, W, H);
  wgpu::CommandEncoder e2 = gpu->device.CreateCommandEncoder();
  REQUIRE(cache.copy_to(42, W, H, out, e2));
  submit(*gpu, e2);
  CHECK(read(*gpu, out, W, H) == expected);

  const auto s = cache.stats();
  CHECK(s.hits == 1);
  CHECK(s.stores == 1);
  CHECK(s.bytes == std::size_t{W} * H * 4);
}

TEST_CASE("frame cache: unknown keys and other sizes miss, encoding nothing", "[gpu][d4]") {
  auto& gpu = cache_gpu();
  if (!gpu) SKIP("no GPU adapter");
  render::FrameCache cache(gpu->device, std::size_t{1} << 20U);
  const wgpu::Texture a = filled(*gpu, 32, 32, 1);
  wgpu::CommandEncoder e1 = gpu->device.CreateCommandEncoder();
  cache.store(7, 32, 32, a, e1);
  submit(*gpu, e1);

  const wgpu::Texture big = make_texture(*gpu, 64, 64);
  wgpu::CommandEncoder e2 = gpu->device.CreateCommandEncoder();
  CHECK_FALSE(cache.copy_to(8, 32, 32, big, e2));  // unknown key
  CHECK_FALSE(cache.copy_to(7, 64, 64, big, e2));  // right key, wrong size (a resize in flight)
  submit(*gpu, e2);
  CHECK(cache.stats().misses == 2);
}

TEST_CASE("frame cache: the byte budget evicts least recently used first", "[gpu][d4]") {
  auto& gpu = cache_gpu();
  if (!gpu) SKIP("no GPU adapter");
  constexpr std::uint32_t W = 16;
  constexpr std::uint32_t H = 16;
  constexpr std::size_t kFrame = std::size_t{W} * H * 4;
  render::FrameCache cache(gpu->device, 3 * kFrame);  // room for exactly three frames
  const wgpu::Texture src = filled(*gpu, W, H, 9);
  const wgpu::Texture out = make_texture(*gpu, W, H);

  wgpu::CommandEncoder enc = gpu->device.CreateCommandEncoder();
  cache.store(1, W, H, src, enc);
  cache.store(2, W, H, src, enc);
  cache.store(3, W, H, src, enc);
  REQUIRE(cache.copy_to(1, W, H, out, enc));  // 1 is now the most recent; 2 is the LRU
  cache.store(4, W, H, src, enc);             // evicts 2
  submit(*gpu, enc);

  CHECK(cache.contains(1));
  CHECK_FALSE(cache.contains(2));
  CHECK(cache.contains(3));
  CHECK(cache.contains(4));
  const auto s = cache.stats();
  CHECK(s.entries == 3);
  CHECK(s.bytes == 3 * kFrame);
  CHECK(s.evictions == 1);
}

TEST_CASE("frame cache: a frame larger than the whole budget is not kept", "[gpu][d4]") {
  auto& gpu = cache_gpu();
  if (!gpu) SKIP("no GPU adapter");
  render::FrameCache cache(gpu->device, 1024);  // smaller than one 32×32 frame
  const wgpu::Texture src = filled(*gpu, 32, 32, 2);
  wgpu::CommandEncoder enc = gpu->device.CreateCommandEncoder();
  cache.store(1, 32, 32, src, enc);
  submit(*gpu, enc);
  CHECK_FALSE(cache.contains(1));
  CHECK(cache.stats().bytes == 0);
}

TEST_CASE("frame cache: storing an existing key refreshes it without a second copy", "[gpu][d4]") {
  auto& gpu = cache_gpu();
  if (!gpu) SKIP("no GPU adapter");
  render::FrameCache cache(gpu->device, std::size_t{1} << 20U);
  const wgpu::Texture src = filled(*gpu, 8, 8, 5);
  wgpu::CommandEncoder enc = gpu->device.CreateCommandEncoder();
  cache.store(11, 8, 8, src, enc);
  cache.store(11, 8, 8, src, enc);
  submit(*gpu, enc);
  CHECK(cache.stats().stores == 1);
  CHECK(cache.stats().entries == 1);
}

TEST_CASE("frame cache: the machine budget is sane", "[d4]") {
  const std::size_t b = render::default_frame_cache_budget(0, 0);
  CHECK(b >= (std::size_t{256} << 20U));
  CHECK(b <= (std::size_t{4} << 30U));
}
