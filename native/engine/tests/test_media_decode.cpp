// E1 media with ffmpeg: probe, frame-accurate seeks on every codec family
// (intra ProRes/DNxHR, long-GOP with B-frames, VP9 alpha, planar RGB), the
// hardware path when this machine has one, and MediaSystem's scheduling
// (latest-wins, exact lane, readahead, close under load).
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <map>
#include <random>
#include <string>
#include <thread>

#include "decoder.hpp"
#include "media_fixture_ffi.hpp"
#include "media_system.hpp"

using namespace premation::media;
namespace fs = std::filesystem;
using namespace std::chrono_literals;

namespace {

fs::path fixture_dir() {
  fs::path d = fs::temp_directory_path() / "premation-media-tests";
  fs::create_directories(d);
  return d;
}

std::string make_fixture(fixture::Kind kind, int frames = 30, int w = 256, int h = 144) {
  static std::map<int, std::string> made;
  const int key = static_cast<int>(kind) * 100000 + frames;
  if (const auto it = made.find(key); it != made.end()) return it->second;
  static constexpr std::array<const char*, 6> kExt{"prores422.mov", "prores4444.mov", "dnxhr.mov", "mpeg4.mp4", "vp9a.webm", "ffv1.mkv"};
  const fs::path p = fixture_dir() / (std::to_string(frames) + "-" + kExt.at(static_cast<std::size_t>(kind)));
  fixture::Spec s;
  s.kind = kind;
  s.frames = frames;
  s.width = w;
  s.height = h;
  if (kind == fixture::Kind::dnxhr) {  // DNxHR needs a real raster
    s.width = 1280;
    s.height = 720;
  }
  std::string error;
  if (!fixture::write(s, p.string(), error)) {
    FAIL("fixture " << p.string() << ": " << error);
  }
  made.emplace(key, p.string());
  return p.string();
}

/// Luma (8-bit scale) of plane 0 at column x, middle row.
double luma_at(const DecodedFrame& f, std::uint32_t x) {
  REQUIRE(f.planeCount >= 1);
  const Plane& y = f.planes[0];
  const std::uint8_t* p = y.data + (y.height / 2) * y.stride;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  const std::size_t i = std::size_t{x} * y.components;
  if (f.format.bytesPerSample == 2) {
    const unsigned v = static_cast<unsigned>(p[2 * i]) | (static_cast<unsigned>(p[2 * i + 1]) << 8U);  // NOLINT
    return static_cast<double>(v >> f.format.storageShift) / static_cast<double>(1U << (f.format.bitDepth - 8U));
  }
  return p[i];  // NOLINT
}

/// Which fixture frame this decoded frame is: its index read back from the bands.
int identify(const DecodedFrame& f, int frames) {
  const std::uint32_t half = f.planes[0].width / 2;
  int idx = 0;
  for (int b = 0; b < fixture::kBands; ++b) {
    const auto x = static_cast<std::uint32_t>((2 * b + 1) * static_cast<int>(half) / (2 * fixture::kBands));
    const double v = luma_at(f, x);
    if (std::abs(v - fixture::kBitOn) < 30) idx |= 1 << b;
    else if (std::abs(v - fixture::kBitOff) >= 30) return -1;
  }
  return idx < frames ? idx : -1;
}

double alpha_at(const DecodedFrame& f) {
  const Plane& a = f.planes[3];
  const std::uint8_t* p = a.data + (a.height / 2) * a.stride;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  const std::uint32_t x = a.width / 4;
  if (f.format.bytesPerSample == 2) {
    const unsigned v = static_cast<unsigned>(p[2 * x]) | (static_cast<unsigned>(p[2 * x + 1]) << 8U);  // NOLINT
    return static_cast<double>(v >> f.format.storageShift) / static_cast<double>(1U << (f.format.bitDepth - 8U));
  }
  return p[x];  // NOLINT
}

FramePtr decode_frame(VideoDecoder& d, std::int64_t target) {
  std::string error;
  REQUIRE(d.seek(target, error));
  for (int guard = 0; guard < 1000; ++guard) {
    FramePtr f;
    const DecodeStatus st = d.next(f, error);
    if (st != DecodeStatus::frame) {
      FAIL("decode ended before frame " << target << ": " << error);
    }
    if (f->index >= target) return f;
  }
  FAIL("no frame");
  return nullptr;
}

void check_random_access(const std::string& path, int frames, DecoderOptions opt = {}) {
  opt.hw = HwPolicy::softwareOnly;
  std::string error;
  auto d = VideoDecoder::open(path, opt, error);
  REQUIRE(d);
  REQUIRE(d->index().size() == frames);
  std::mt19937 rng(7);  // seeded: the test is deterministic
  std::vector<std::int64_t> order;
  for (int i = 0; i < frames; ++i) order.push_back(i);
  std::shuffle(order.begin(), order.end(), rng);
  order.push_back(frames - 1);
  order.push_back(0);
  for (const std::int64_t i : order) {
    const FramePtr f = decode_frame(*d, i);
    INFO(path << " frame " << i);
    CHECK(f->index == i);
    CHECK(identify(*f, frames) == i);
  }
  // Sequential from the start: every frame, in order.
  REQUIRE(d->seek(0, error));
  for (int i = 0; i < frames; ++i) {
    FramePtr f;
    REQUIRE(d->next(f, error) == DecodeStatus::frame);
    CHECK(f->index == i);
    CHECK(identify(*f, frames) == i);
  }
  FramePtr f;
  CHECK(d->next(f, error) == DecodeStatus::eof);
}

}  // namespace

TEST_CASE("probe: codec, NTSC rate, colour, alpha, exact index", "[media][decode]") {
  const std::string p = make_fixture(fixture::Kind::prores4444);
  MediaInfo info;
  FrameIndex idx;
  std::string error;
  REQUIRE(VideoDecoder::probe(p, info, idx, error));
  REQUIRE(info.video);
  const VideoInfo& v = *info.video;
  CHECK(v.codec == "prores");
  CHECK(v.fps == Rational{24000, 1001});
  CHECK(v.width == 256);
  CHECK(v.height == 144);
  CHECK(v.hasAlpha);
  CHECK(v.intraOnly);
  CHECK(v.chromaShiftX == 0);
  CHECK(v.color.matrix == Matrix::bt709);
  CHECK(v.color.range == Range::limited);
  CHECK(v.color.primaries == Primaries::bt709);
  CHECK(v.exactIndex);
  CHECK(idx.size() == 30);
  CHECK(v.frameCount == 30);
}

TEST_CASE("frame-accurate random access: ProRes 422 HQ (10-bit 4:2:2)", "[media][decode]") {
  check_random_access(make_fixture(fixture::Kind::prores422), 30);
}

TEST_CASE("frame-accurate random access: ProRes 4444 with alpha", "[media][decode]") {
  const std::string p = make_fixture(fixture::Kind::prores4444);
  check_random_access(p, 30);
  DecoderOptions opt;
  opt.hw = HwPolicy::softwareOnly;
  std::string error;
  auto d = VideoDecoder::open(p, opt, error);
  REQUIRE(d);
  const FramePtr f = decode_frame(*d, 17);
  REQUIRE(f->format.hasAlpha);
  REQUIRE(f->planeCount == 4);
  CHECK(f->format.layout == Layout::planarYuv);
  CHECK(std::abs(alpha_at(*f) - fixture::fixture_alpha(17)) < 1.5);
}

TEST_CASE("frame-accurate random access: DNxHR HQ (8-bit 4:2:2)", "[media][decode]") {
  check_random_access(make_fixture(fixture::Kind::dnxhr, 12), 12);
}

TEST_CASE("frame-accurate random access: long GOP with B-frames (MPEG-4 in MP4)", "[media][decode]") {
  const std::string p = make_fixture(fixture::Kind::mpeg4, 40);
  check_random_access(p, 40);
  MediaInfo info;
  FrameIndex idx;
  std::string error;
  REQUIRE(VideoDecoder::probe(p, info, idx, error));
  CHECK_FALSE(info.video->intraOnly);
}

TEST_CASE("frame-accurate random access: VP9 with alpha (libvpx, WebM)", "[media][decode]") {
  const std::string p = make_fixture(fixture::Kind::vp9alpha, 20);
  check_random_access(p, 20);
  DecoderOptions opt;
  opt.hw = HwPolicy::softwareOnly;
  std::string error;
  auto d = VideoDecoder::open(p, opt, error);
  REQUIRE(d);
  CHECK(d->info().video->hasAlpha);
  const FramePtr f = decode_frame(*d, 13);
  REQUIRE(f->format.hasAlpha);
  CHECK(std::abs(alpha_at(*f) - fixture::fixture_alpha(13)) < 1.5);
}

TEST_CASE("planar RGB (FFV1 gbrp10) is carried as planar RGB, full range", "[media][decode]") {
  const std::string p = make_fixture(fixture::Kind::ffv1rgb, 6);
  DecoderOptions opt;
  opt.hw = HwPolicy::softwareOnly;
  std::string error;
  auto d = VideoDecoder::open(p, opt, error);
  REQUIRE(d);
  const FramePtr f = decode_frame(*d, 4);
  CHECK(f->format.layout == Layout::planarRgb);
  CHECK(f->format.matrix == Matrix::rgb);
  CHECK(f->format.bitDepth == 10);
  CHECK(identify(*f, 6) == 4);
}

#ifdef PREMATION_MEDIA_FIXTURES
TEST_CASE("H.264 with B-frames (the TS fixture): seek == sequential, software and hardware", "[media][decode][hw]") {
  const std::string p = std::string(PREMATION_MEDIA_FIXTURES) + "/tiny-bframes.mp4";
  std::string error;
  DecoderOptions sw;
  sw.hw = HwPolicy::softwareOnly;
  auto seq = VideoDecoder::open(p, sw, error);
  REQUIRE(seq);
  const std::int64_t n = seq->index().size();
  REQUIRE(n > 8);
  // Reference: a checksum of each frame's luma, decoded sequentially.
  auto sum = [](const DecodedFrame& f) {
    std::uint64_t h = 1469598103934665603ULL;
    const Plane& y = f.planes[0];
    for (std::uint32_t r = 0; r < y.height; ++r) {
      for (std::uint32_t x = 0; x < y.width; ++x) {
        h = (h ^ y.data[r * y.stride + x]) * 1099511628211ULL;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      }
    }
    return h;
  };
  std::vector<std::uint64_t> ref;
  REQUIRE(seq->seek(0, error));
  for (std::int64_t i = 0; i < n; ++i) {
    FramePtr f;
    REQUIRE(seq->next(f, error) == DecodeStatus::frame);
    REQUIRE(f->index == i);
    ref.push_back(sum(*f));
  }
  for (const std::int64_t i : {n - 1, std::int64_t{3}, std::int64_t{1}, n / 2, std::int64_t{0}, std::int64_t{2}}) {
    CHECK(sum(*decode_frame(*seq, i)) == ref.at(static_cast<std::size_t>(i)));
  }

  // Hardware, downloaded to NV12 (the portable route): H.264 decoders are bit-exact.
  HwContextOptions ho;
  auto hw = create_hw_context(ho, error);
  if (!hw) {
    WARN("no hardware decode device here: " << error);
    return;
  }
  DecoderOptions ho2;
  ho2.hw = HwPolicy::hardwareOnly;
  ho2.hwContext = hw;
  ho2.keepOnGpu = false;
  auto hd = VideoDecoder::open(p, ho2, error);
  REQUIRE(hd);
  CHECK(hd->path() != DecodePath::software);
  for (const std::int64_t i : {n - 1, std::int64_t{3}, std::int64_t{0}, n / 2}) {
    const FramePtr f = decode_frame(*hd, i);
    CHECK(f->path != DecodePath::software);
    CHECK(f->format.layout == Layout::semiPlanarYuv);
    // NV12 luma plane vs yuv420p luma plane: same samples.
    std::uint64_t h = 1469598103934665603ULL;
    const Plane& y = f->planes[0];
    for (std::uint32_t r = 0; r < y.height; ++r) {
      for (std::uint32_t x = 0; x < y.width; ++x) h = (h ^ y.data[r * y.stride + x]) * 1099511628211ULL;  // NOLINT
    }
    CHECK(h == ref.at(static_cast<std::size_t>(i)));
  }
}
#endif

// ── MediaSystem ────────────────────────────────────────────────────────────

TEST_CASE("MediaSystem: wait() delivers exact frames; cache hits after", "[media][system]") {
  MediaConfig cfg;
  MediaSystem ms(cfg);
  std::string error;
  const auto id = ms.open(make_fixture(fixture::Kind::mpeg4, 40), error);
  REQUIRE(id);
  REQUIRE(ms.wait_ready(*id, 10s));
  for (const std::int64_t i : {std::int64_t{25}, std::int64_t{3}, std::int64_t{39}, std::int64_t{12}}) {
    const FramePtr f = ms.wait(*id, i, Lane::exact, 10s);
    REQUIRE(f);
    CHECK(f->index == i);
    CHECK(identify(*f, 40) == i);
    CHECK(ms.cached(*id, i));
  }
  // Out of range clamps.
  const FramePtr last = ms.wait(*id, 1000, Lane::exact, 10s);
  REQUIRE(last);
  CHECK(last->index == 39);
}

TEST_CASE("MediaSystem: latest-wins — a burst of scrub requests lands on the last one", "[media][system]") {
  MediaConfig cfg;
  cfg.keepInFlightMs = 0;       // never finish a superseded decode...
  cfg.starvationMs = 1e9;       // ...unless starved (off here)
  MediaSystem ms(cfg);
  std::string error;
  const auto id = ms.open(make_fixture(fixture::Kind::mpeg4, 120), error);
  REQUIRE(id);
  REQUIRE(ms.wait_ready(*id, 10s));
  // 60 scrub positions as fast as possible; only the last must be delivered.
  std::mt19937 rng(11);
  std::int64_t last = 0;
  for (int k = 0; k < 60; ++k) {
    last = static_cast<std::int64_t>(rng() % 120);
    (void)ms.request(*id, last, Lane::latest);
  }
  const FramePtr f = ms.wait(*id, last, Lane::latest, 10s);
  REQUIRE(f);
  CHECK(f->index == last);
  CHECK(identify(*f, 120) == last);
  const SourceStats st = ms.stats(*id);
  // Most of the burst never started a decode.
  CHECK(st.superseded + st.abandoned + st.retargets > 30);
  CHECK(st.framesDecoded < 600);
}

TEST_CASE("MediaSystem: exact lane is never superseded", "[media][system]") {
  MediaSystem ms(MediaConfig{});
  std::string error;
  const auto id = ms.open(make_fixture(fixture::Kind::prores422, 30), error);
  REQUIRE(id);
  REQUIRE(ms.wait_ready(*id, 10s));
  for (int i = 0; i < 30; i += 3) (void)ms.request(*id, i, Lane::exact);
  for (int k = 0; k < 20; ++k) (void)ms.request(*id, 29 - k, Lane::latest);
  for (int i = 0; i < 30; i += 3) {
    const FramePtr f = ms.wait(*id, i, Lane::exact, 10s);
    REQUIRE(f);
    CHECK(identify(*f, 30) == i);
  }
}

TEST_CASE("MediaSystem: readahead fills the window ahead of the playhead", "[media][system]") {
  MediaConfig cfg;
  cfg.readahead = 8;
  MediaSystem ms(cfg);
  std::string error;
  const auto id = ms.open(make_fixture(fixture::Kind::mpeg4, 60), error);
  REQUIRE(id);
  REQUIRE(ms.wait_ready(*id, 10s));
  REQUIRE(ms.wait(*id, 10, Lane::latest, 10s));
  ms.playhead(*id, 10, +1);
  const auto deadline = std::chrono::steady_clock::now() + 10s;
  while (!ms.cached(*id, 18) && std::chrono::steady_clock::now() < deadline) std::this_thread::sleep_for(5ms);
  for (int i = 11; i <= 18; ++i) CHECK(ms.cached(*id, i));
  ms.playhead(*id, 18, 0);
}

TEST_CASE("MediaSystem: close while decoding, bad files fail cleanly", "[media][system]") {
  MediaSystem ms(MediaConfig{});
  std::string error;
  const auto id = ms.open(make_fixture(fixture::Kind::mpeg4, 120), error);
  REQUIRE(id);
  (void)ms.request(*id, 119, Lane::latest);
  ms.playhead(*id, 0, +1);
  ms.close(*id);
  CHECK(ms.stats(*id).framesDecoded == 0);  // unknown id → defaults
  CHECK_FALSE(ms.open((fixture_dir() / "does-not-exist.mov").string(), error));
  CHECK_FALSE(error.empty());
  // A file that is not video.
  const fs::path junk = fixture_dir() / "junk.mp4";
  if (FILE* fp = std::fopen(junk.string().c_str(), "wb")) {
    std::fputs("not a video file at all", fp);
    std::fclose(fp);
  }
  CHECK_FALSE(ms.open(junk.string(), error));
}

TEST_CASE("MediaSystem: several sources decode concurrently", "[media][system]") {
  MediaSystem ms(MediaConfig{});
  std::string error;
  std::vector<SourceId> ids;
  for (int k = 0; k < 4; ++k) {
    const auto id = ms.open(make_fixture(fixture::Kind::mpeg4, 60), error);
    REQUIRE(id);
    ids.push_back(*id);
  }
  for (const SourceId id : ids) REQUIRE(ms.wait_ready(id, 10s));
  for (const SourceId id : ids) ms.playhead(id, 0, +1);
  for (const SourceId id : ids) {
    const FramePtr f = ms.wait(id, 40, Lane::exact, 10s);
    REQUIRE(f);
    CHECK(identify(*f, 60) == 40);
  }
}
