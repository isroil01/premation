// The preview cache's disk tier (src/render/disk_cache.hpp): round trips,
// persistence across instances (sessions), LRU eviction at the size limit,
// purge touching only its own files, and damaged files read as misses.
#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "disk_cache.hpp"
#include "frame_codec.hpp"
#include "ram_cache.hpp"

namespace fs = std::filesystem;
using premation::render::DiskCache;

namespace {

constexpr std::uint32_t kW = 64;
constexpr std::uint32_t kH = 64;
constexpr std::uint64_t kFrameBytes = std::uint64_t{kW} * kH * 4U;

/// A fresh folder per test (removed first: a crashed run's leftovers never leak in).
fs::path fresh_dir(const std::string& name) {
  const fs::path dir = fs::temp_directory_path() / ("premation-disk-cache-test-" + name);
  std::error_code ec;
  fs::remove_all(dir, ec);
  fs::create_directories(dir);
  return dir;
}

std::string utf8(const fs::path& p) {
  const std::u8string s = p.u8string();
  return {s.begin(), s.end()};
}

/// Seeded noise: does not compress, so a file's size is known (header + raw pixels).
std::vector<std::uint8_t> noise(std::uint32_t seed) {
  std::vector<std::uint8_t> px(kFrameBytes);
  std::uint32_t x = seed * 2654435761U + 1U;
  for (auto& b : px) {
    x = x * 1664525U + 1013904223U;
    b = static_cast<std::uint8_t>(x >> 24U);
  }
  return px;
}

/// Flat colour: compresses to almost nothing.
std::vector<std::uint8_t> flat(std::uint8_t v) { return std::vector<std::uint8_t>(kFrameBytes, v); }

std::size_t count_files(const fs::path& dir, const std::string& ext) {
  std::size_t n = 0;
  std::error_code ec;
  for (fs::directory_iterator it(dir, ec), end; !ec && it != end; it.increment(ec)) {
    if (it->path().extension() == ext) ++n;
  }
  return n;
}

}  // namespace

TEST_CASE("disk cache: a stored frame loads back byte for byte", "[disk_cache]") {
  const fs::path dir = fresh_dir("roundtrip");
  DiskCache cache;
  cache.configure(utf8(dir), 64ULL * 1024 * 1024);
  cache.flush();
  REQUIRE(cache.enabled());

  const auto a = noise(1);
  const auto b = flat(200);
  REQUIRE(cache.wants(11));
  REQUIRE(cache.store(11, kW, kH, a));
  REQUIRE(cache.store(12, kW, kH, b));
  CHECK_FALSE(cache.wants(11));  // queued: never read back twice
  cache.flush();

  std::vector<std::uint8_t> out;
  REQUIRE(cache.load(11, kW, kH, out));
  CHECK(out == a);
  REQUIRE(cache.load(12, kW, kH, out));
  CHECK(out == b);
  CHECK_FALSE(cache.load(13, kW, kH, out));      // never stored
  CHECK_FALSE(cache.load(11, kW * 2, kH, out));  // another size: a miss, not garbage

  const auto s = cache.stats();
  CHECK(s.entries == 1);  // the wrong-size read dropped 11
  CHECK(s.writes == 2);
  cache.flush();  // the dropped file's delete
  CHECK(count_files(dir / DiskCache::kSubfolder, ".pfc") == 1);
}

TEST_CASE("disk cache: frames outlive the instance (the next session reads them)", "[disk_cache]") {
  const fs::path dir = fresh_dir("persist");
  const auto a = noise(7);
  {
    DiskCache cache;
    cache.configure(utf8(dir), 64ULL * 1024 * 1024);
    REQUIRE(cache.store(42, kW, kH, a));
    cache.flush();
  }
  DiskCache next;
  next.configure(utf8(dir), 64ULL * 1024 * 1024);
  next.flush();  // the scan
  REQUIRE(next.contains(42));
  std::vector<std::uint8_t> out;
  REQUIRE(next.load(42, kW, kH, out));
  CHECK(out == a);
  CHECK(next.bytes() > 0);
}

TEST_CASE("disk cache: a frame's pre-build alias outlives the instance, and dies with its file", "[disk_cache][alias]") {
  // The next session finds a frame by its (salted) pre-build key without building
  // it: the alias says which content and disk keys the frame had.
  const fs::path dir = fresh_dir("alias");
  {
    DiskCache cache;
    cache.configure(utf8(dir), 64ULL * 1024 * 1024);
    cache.flush();
    REQUIRE(cache.store(42, kW, kH, noise(3)));
    cache.store_alias(900, 77, 42);
    cache.store_alias(901, 78, 43);  // its frame never reached disk
    cache.flush();
    const auto a = cache.find_alias(900);
    REQUIRE(a.has_value());
    CHECK(a->first == 77);
    CHECK(a->second == 42);
    CHECK_FALSE(cache.find_alias(901).has_value());  // no file: nothing to serve
  }
  {
    DiskCache next;
    next.configure(utf8(dir), 64ULL * 1024 * 1024);
    next.flush();  // the scan loads the alias log
    const auto a = next.find_alias(900);
    REQUIRE(a.has_value());
    CHECK(a->first == 77);
    CHECK(a->second == 42);
    // Re-pointed (the frame was drawn again under other keys): the last record wins.
    REQUIRE(next.store(44, kW, kH, noise(4)));
    next.store_alias(900, 79, 44);
    next.flush();
  }
  DiskCache third;
  third.configure(utf8(dir), 64ULL * 1024 * 1024);
  third.flush();
  const auto b = third.find_alias(900);
  REQUIRE(b.has_value());
  CHECK(b->first == 79);
  CHECK(b->second == 44);
  // Purge: the log goes with the frames.
  third.purge();
  third.flush();
  CHECK_FALSE(third.find_alias(900).has_value());
  CHECK_FALSE(fs::exists(dir / DiskCache::kSubfolder / "aliases-v1.bin"));
}

TEST_CASE("disk cache: the read cost is measured on the folder's own files", "[disk_cache]") {
  const fs::path dir = fresh_dir("readcost");
  {
    DiskCache cache;
    cache.configure(utf8(dir), 64ULL * 1024 * 1024);
    cache.flush();
    CHECK(cache.read_ms_per_mp() == 0);  // an empty folder: nothing to time yet
    REQUIRE(cache.store(1, kW, kH, noise(1)));
    cache.flush();
    CHECK(cache.read_ms_per_mp() > 0);  // the first frame written was timed
  }
  DiskCache next;
  next.configure(utf8(dir), 64ULL * 1024 * 1024);
  next.flush();  // the scan times the newest file
  CHECK(next.read_ms_per_mp() > 0);
  next.configure("", 0);
  CHECK(next.read_ms_per_mp() == 0);  // off (another folder): not this folder's measurement
}

TEST_CASE("disk cache: the least recently used frame goes first at the limit", "[disk_cache]") {
  const fs::path dir = fresh_dir("lru");
  DiskCache cache;
  // Room for two noise frames, not three.
  cache.configure(utf8(dir), kFrameBytes * 2 + kFrameBytes / 2);
  cache.flush();
  REQUIRE(cache.store(1, kW, kH, noise(1)));
  cache.flush();
  REQUIRE(cache.store(2, kW, kH, noise(2)));
  cache.flush();
  std::vector<std::uint8_t> out;
  REQUIRE(cache.load(1, kW, kH, out));  // 1 is now the most recently used
  REQUIRE(cache.store(3, kW, kH, noise(3)));
  cache.flush();
  CHECK(cache.contains(1));
  CHECK_FALSE(cache.contains(2));
  CHECK(cache.contains(3));
  CHECK(cache.stats().evictions == 1);
  CHECK(count_files(dir / DiskCache::kSubfolder, ".pfc") == 2);

  // A smaller limit evicts down to it.
  cache.configure(utf8(dir), kFrameBytes + kFrameBytes / 2);
  cache.flush();
  CHECK(cache.contains(3));
  CHECK_FALSE(cache.contains(1));
}

TEST_CASE("disk cache: purge deletes its own files and nothing else", "[disk_cache]") {
  const fs::path dir = fresh_dir("purge");
  { std::ofstream(dir / "keep-me.txt") << "the user's file"; }
  DiskCache cache;
  cache.configure(utf8(dir), 64ULL * 1024 * 1024);
  REQUIRE(cache.store(5, kW, kH, flat(9)));
  REQUIRE(cache.store(6, kW, kH, flat(10)));
  cache.flush();
  { std::ofstream(dir / DiskCache::kSubfolder / "notes.txt") << "not a frame"; }
  cache.purge();
  cache.flush();
  CHECK_FALSE(cache.contains(5));
  CHECK(cache.bytes() == 0);
  CHECK(count_files(dir / DiskCache::kSubfolder, ".pfc") == 0);
  CHECK(fs::exists(dir / "keep-me.txt"));
  CHECK(fs::exists(dir / DiskCache::kSubfolder / "notes.txt"));
}

TEST_CASE("disk cache: a damaged file is a miss and is forgotten", "[disk_cache]") {
  const fs::path dir = fresh_dir("damaged");
  DiskCache cache;
  cache.configure(utf8(dir), 64ULL * 1024 * 1024);
  REQUIRE(cache.store(0xabcULL, kW, kH, noise(3)));
  cache.flush();
  const fs::path file = dir / DiskCache::kSubfolder / "0000000000000abc.pfc";
  REQUIRE(fs::exists(file));
  fs::resize_file(file, fs::file_size(file) / 2);  // a torn write
  std::vector<std::uint8_t> out;
  CHECK_FALSE(cache.load(0xabcULL, kW, kH, out));
  CHECK_FALSE(cache.contains(0xabcULL));
  cache.flush();
  CHECK_FALSE(fs::exists(file));
}

TEST_CASE("disk cache: a reserved frame counts as on its way until it is written or released", "[disk_cache]") {
  const fs::path dir = fresh_dir("reserve");
  DiskCache cache;
  cache.configure(utf8(dir), 64ULL * 1024 * 1024);
  cache.flush();
  REQUIRE(cache.reserve(1));
  CHECK_FALSE(cache.reserve(1));  // read back once
  CHECK_FALSE(cache.wants(1));
  CHECK(cache.writing());

  // The coverage walk keeps a reserved key (not yet a frame on disk), drops an unknown one.
  std::unordered_map<std::int64_t, std::vector<std::uint64_t>> byFrame{{0, {1}}, {1, {99}}};
  std::vector<std::int64_t> onDisk;
  cache.retain_present(byFrame, onDisk);
  CHECK(byFrame.contains(0));
  CHECK_FALSE(byFrame.contains(1));
  CHECK(onDisk.empty());

  REQUIRE(cache.store(1, kW, kH, flat(3)));  // the reservation's frame
  cache.flush();
  onDisk.clear();
  cache.retain_present(byFrame, onDisk);
  CHECK(onDisk == std::vector<std::int64_t>{0});

  REQUIRE(cache.reserve(2));
  cache.release(2);  // the read-back failed
  CHECK(cache.wants(2));
  CHECK_FALSE(cache.writing());
}

TEST_CASE("disk cache: presence says written, on its way or absent, per key", "[disk_cache]") {
  const fs::path dir = fresh_dir("presence");
  DiskCache cache;
  std::vector<std::uint8_t> state;
  cache.presence({1, 2}, state);
  CHECK(state == std::vector<std::uint8_t>{0, 0});  // off: nothing anywhere
  cache.configure(utf8(dir), 64ULL * 1024 * 1024);
  cache.flush();
  REQUIRE(cache.store(1, kW, kH, flat(1)));
  cache.flush();
  REQUIRE(cache.reserve(2));
  cache.presence({1, 2, 3}, state);
  CHECK(state == std::vector<std::uint8_t>{2, 1, 0});
  cache.release(2);
}

TEST_CASE("disk cache: off takes nothing", "[disk_cache]") {
  const fs::path dir = fresh_dir("off");
  DiskCache cache;
  CHECK_FALSE(cache.enabled());
  CHECK_FALSE(cache.store(1, kW, kH, flat(1)));
  cache.configure(utf8(dir), 0);  // a 0 MB limit = off
  CHECK_FALSE(cache.enabled());
  CHECK_FALSE(cache.wants(1));
  CHECK_FALSE(cache.store(1, kW, kH, flat(1)));
  CHECK_FALSE(cache.store(2, kW, kH, std::vector<std::uint8_t>(10)));  // wrong size, refused anyway
}

// ── back-pressure: the queue's soft target and hard cap, the writer pool ────

using premation::render::DiskCacheOptions;
using premation::render::StoreResult;

TEST_CASE("disk cache: a burst past the soft target is taken and written in full", "[disk_cache][backpressure]") {
  // A long fill evicting RAM faster than the disk writes: nothing may be dropped.
  const fs::path dir = fresh_dir("burst");
  DiskCache cache(DiskCacheOptions{.writers = 2, .softQueueBytes = 4 * kFrameBytes, .hardQueueBytes = 0});
  cache.configure(utf8(dir), 64ULL * 1024 * 1024);
  cache.flush();
  cache.pause(true);  // the writers fall behind: nothing drains while the burst arrives
  constexpr std::uint32_t kFrames = 12;
  for (std::uint32_t i = 0; i < kFrames; ++i) {
    auto px = noise(100 + i);
    const StoreResult r = cache.enqueue(1000 + i, kW, kH, px);
    CHECK(r == (i < 4 ? StoreResult::queued : StoreResult::queuedBehind));
    CHECK(px.empty());  // taken: moved from
  }
  CHECK(cache.behind());
  CHECK_FALSE(cache.reserve(5000));  // optional read-backs wait while behind
  CHECK_FALSE(cache.wants(5000));
  auto s = cache.stats();
  CHECK(s.behind == kFrames - 4);
  CHECK(s.refused == 0);
  CHECK(s.queuedBytes == kFrames * kFrameBytes);
  CHECK(s.queueHighWater == kFrames * kFrameBytes);

  cache.pause(false);
  cache.flush();
  CHECK_FALSE(cache.behind());
  s = cache.stats();
  CHECK(s.writes == kFrames);
  CHECK(s.dropped == 0);
  CHECK(s.entries == kFrames);
  CHECK(s.queuedBytes == 0);
  CHECK(s.queueHighWater == kFrames * kFrameBytes);  // a high-water mark stays
  std::vector<std::uint8_t> out;
  for (std::uint32_t i = 0; i < kFrames; ++i) {
    REQUIRE(cache.load(1000 + i, kW, kH, out));
    CHECK(out == noise(100 + i));
  }
  CHECK(cache.reserve(5000));  // caught up: read-backs are claimed again
  cache.release(5000);
}

TEST_CASE("disk cache: the hard cap refuses a frame and leaves the caller's bytes", "[disk_cache][backpressure]") {
  const fs::path dir = fresh_dir("hardcap");
  DiskCache cache(DiskCacheOptions{.writers = 1, .softQueueBytes = 2 * kFrameBytes, .hardQueueBytes = 4 * kFrameBytes});
  cache.configure(utf8(dir), 64ULL * 1024 * 1024);
  cache.flush();
  cache.pause(true);
  for (std::uint32_t i = 0; i < 4; ++i) CHECK(cache.store(10 + i, kW, kH, noise(i)));
  auto keep = noise(77);
  CHECK(cache.enqueue(99, kW, kH, keep) == StoreResult::refused);
  CHECK(keep == noise(77));  // untouched: the caller keeps its RAM copy
  CHECK_FALSE(cache.store(98, kW, kH, noise(78)));  // the bool wrapper says the same
  // Not wanted is not refused: a frame already queued is skipped, and not counted.
  auto again = noise(0);
  CHECK(cache.enqueue(10, kW, kH, again) == StoreResult::skipped);
  CHECK(again == noise(0));
  auto s = cache.stats();
  CHECK(s.refused == 2);
  CHECK(s.queueSoftBytes == 2 * kFrameBytes);
  CHECK(s.queueHardBytes == 4 * kFrameBytes);
  CHECK(s.writers == 1);

  cache.pause(false);
  cache.flush();
  CHECK_FALSE(cache.contains(99));
  CHECK(cache.enqueue(99, kW, kH, keep) == StoreResult::queued);  // room again
  CHECK(keep.empty());
  cache.flush();
  std::vector<std::uint8_t> out;
  REQUIRE(cache.load(99, kW, kH, out));
  CHECK(out == noise(77));
  s = cache.stats();
  CHECK(s.dropped == 0);
  CHECK(s.writes == 5);
}

TEST_CASE("disk cache: an empty queue takes a frame larger than the hard cap", "[disk_cache][backpressure]") {
  const fs::path dir = fresh_dir("oversize");
  DiskCache cache(DiskCacheOptions{.writers = 1, .softQueueBytes = kFrameBytes / 4, .hardQueueBytes = kFrameBytes / 2});
  cache.configure(utf8(dir), 64ULL * 1024 * 1024);
  cache.flush();
  cache.pause(true);
  auto big = flat(1);
  CHECK(cache.enqueue(1, kW, kH, big) == StoreResult::queuedBehind);
  auto next = flat(2);
  CHECK(cache.enqueue(2, kW, kH, next) == StoreResult::refused);
  cache.pause(false);
  cache.flush();
  CHECK(cache.contains(1));
}

TEST_CASE("disk cache: the writer pool sizes itself to the machine", "[disk_cache][backpressure]") {
  DiskCache cache;
  const auto s = cache.stats();
  CHECK(s.writers >= 1);
  CHECK(s.writers <= DiskCache::kMaxWriters);
  CHECK(s.queueSoftBytes == DiskCache::kSoftQueuedBytes);
  CHECK(s.queueHardBytes == 4 * DiskCache::kSoftQueuedBytes);
}

TEST_CASE("disk cache: many writers at once keep the index and the files whole", "[disk_cache][backpressure]") {
  const fs::path dir = fresh_dir("pool");
  constexpr std::uint32_t kFrames = 200;
  {
    DiskCache cache(DiskCacheOptions{.writers = 4, .softQueueBytes = 0, .hardQueueBytes = 0});
    cache.configure(utf8(dir), 256ULL * 1024 * 1024);
    cache.flush();
    for (std::uint32_t i = 0; i < kFrames; ++i) {
      // Half noise (stored raw), half flat (compressed): both paths at once.
      REQUIRE(cache.store(1 + i, kW, kH, i % 2 == 0 ? noise(i) : flat(static_cast<std::uint8_t>(i))));
      cache.store_alias(100000 + i, 50000 + i, 1 + i);
    }
    cache.flush();
    const auto s = cache.stats();
    CHECK(s.writes == kFrames);
    CHECK(s.entries == kFrames);
    CHECK(s.dropped == 0);
    CHECK(s.refused == 0);
    CHECK(s.queuedBytes == 0);
    std::vector<std::uint8_t> out;
    for (std::uint32_t i = 0; i < kFrames; ++i) {
      REQUIRE(cache.load(1 + i, kW, kH, out));
      CHECK(out == (i % 2 == 0 ? noise(i) : flat(static_cast<std::uint8_t>(i))));
    }
    cache.flush();  // the hits' touches
    CHECK(count_files(dir / DiskCache::kSubfolder, ".pfc") == kFrames);
    CHECK(count_files(dir / DiskCache::kSubfolder, ".tmp") == 0);
  }
  // The next session's scan: the same files, the same bytes, every alias record whole.
  DiskCache next(DiskCacheOptions{.writers = 4, .softQueueBytes = 0, .hardQueueBytes = 0});
  next.configure(utf8(dir), 256ULL * 1024 * 1024);
  next.flush();
  CHECK(next.stats().entries == kFrames);
  std::vector<std::uint8_t> out;
  for (std::uint32_t i = 0; i < kFrames; ++i) {
    REQUIRE(next.load(1 + i, kW, kH, out));
    CHECK(out == (i % 2 == 0 ? noise(i) : flat(static_cast<std::uint8_t>(i))));
    const auto a = next.find_alias(100000 + i);
    REQUIRE(a.has_value());
    CHECK(a->first == 50000 + i);
    CHECK(a->second == 1 + i);
  }
  CHECK(fs::file_size(dir / DiskCache::kSubfolder / "aliases-v1.bin") == std::uintmax_t{kFrames} * 24U);
}

// Hidden (run with "[.disk_cache_bench]"): where a 1080p disk hit's time goes, without the GPU upload.
TEST_CASE("disk cache: 1080p load timing", "[.disk_cache_bench]") {
  constexpr std::uint32_t w = 1920;
  constexpr std::uint32_t h = 1080;
  const fs::path dir = fresh_dir("bench");
  DiskCache cache;
  cache.configure(utf8(dir), 8ULL * 1024 * 1024 * 1024);
  cache.flush();
  // A motion-graphics-like frame: flat background, soft shapes, a noisy band.
  std::vector<std::uint8_t> px(std::size_t{w} * h * 4U);
  std::uint32_t x = 12345;
  for (std::uint32_t y = 0; y < h; ++y) {
    for (std::uint32_t c = 0; c < w; ++c) {
      const std::size_t i = (std::size_t{y} * w + c) * 4U;
      x = x * 1664525U + 1013904223U;
      const bool noisy = y > 400 && y < 520;
      const auto v = static_cast<std::uint8_t>(noisy ? (x >> 24U) : ((c / 8U + y / 8U) & 0xFFU));
      px[i] = v;
      px[i + 1] = static_cast<std::uint8_t>(255U - v);
      px[i + 2] = 40;
      px[i + 3] = 255;
    }
  }
  REQUIRE(cache.store(1, w, h, px));
  cache.flush();
  std::vector<std::uint8_t> out;
  REQUIRE(cache.load(1, w, h, out));  // warm the OS file cache
  const auto t0 = std::chrono::steady_clock::now();
  constexpr int kRuns = 20;
  for (int i = 0; i < kRuns; ++i) REQUIRE(cache.load(1, w, h, out));
  const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count() / kRuns;
  const auto file = fs::file_size(dir / DiskCache::kSubfolder / "0000000000000001.pfc");
  std::printf("[disk_cache_bench] 1080p load %.2f ms, file %.2f MB of %.2f MB raw\n", ms,
              static_cast<double>(file) / 1048576.0, static_cast<double>(px.size()) / 1048576.0);
  CHECK(out == px);

  std::vector<std::uint8_t> packed;
  REQUIRE(premation::render::frame_codec::compress(px, packed));
  const auto t1 = std::chrono::steady_clock::now();
  for (int i = 0; i < kRuns; ++i) {
    REQUIRE(premation::render::frame_codec::decompress(premation::render::frame_codec::preferred(), packed, out));
  }
  const double dec = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t1).count() / kRuns;
  const auto t2 = std::chrono::steady_clock::now();
  for (int i = 0; i < kRuns; ++i) std::memcpy(out.data(), px.data(), px.size());
  const double copy = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t2).count() / kRuns;
  std::printf("[disk_cache_bench] decode %.2f ms, memcpy %.2f ms\n", dec, copy);
}

// ── the RAM tier (src/render/ram_cache.hpp) ─────────────────────────────────

namespace {

using premation::render::FrameTag;
using premation::render::ProtectedRange;
using premation::render::RamFrame;
using premation::render::RamFrameCache;

RamFrame ram_frame(std::uint64_t scope, std::int64_t frame, std::uint8_t fill = 1, double drawMs = 0, std::uint64_t diskKey = 0) {
  RamFrame f;
  f.rgba = std::make_shared<std::vector<std::uint8_t>>(flat(fill));
  f.width = kW;
  f.height = kH;
  f.drawMs = drawMs;
  f.diskKey = diskKey;
  f.tag = FrameTag{scope, frame};
  return f;
}

}  // namespace

TEST_CASE("ram cache: a stored frame comes back, shared, and re-tagged by the hit", "[ram_cache]") {
  RamFrameCache ram(10 * kFrameBytes);
  std::vector<RamFrame> evicted;
  REQUIRE(ram.store(7, ram_frame(1, 3, 42), ProtectedRange{}, evicted));
  CHECK(evicted.empty());
  const auto hit = ram.find(7, kW, kH, FrameTag{2, 3});
  REQUIRE(hit);
  CHECK((*hit->rgba)[0] == 42);
  CHECK(hit->tag.scope == 2);
  CHECK_FALSE(ram.find(7, kW * 2, kH, FrameTag{}));  // the right key at another size (a resize in flight)
  CHECK_FALSE(ram.find(8, kW, kH, FrameTag{}));
  CHECK(ram.stats().hits == 1);
  CHECK(ram.stats().misses == 2);
}

TEST_CASE("ram cache: a loop larger than the cache keeps its first frames instead of thrashing", "[ram_cache]") {
  // Room for 4 frames; the play range is frames 0–9 of scope 1. Plain LRU
  // would hold 6–9 after the first pass and miss every frame of the next one.
  RamFrameCache ram(4 * kFrameBytes);
  const ProtectedRange range{1, 0, 9};
  std::vector<RamFrame> evicted;
  for (std::int64_t f = 0; f < 10; ++f) (void)ram.store(static_cast<std::uint64_t>(100 + f), ram_frame(1, f), range, evicted);
  CHECK(evicted.empty());
  for (std::int64_t f = 0; f < 4; ++f) CHECK(ram.contains(static_cast<std::uint64_t>(100 + f)));
  for (std::int64_t f = 4; f < 10; ++f) CHECK_FALSE(ram.contains(static_cast<std::uint64_t>(100 + f)));
  CHECK(ram.stats().refused == 6);
  // The second pass hits the four it kept, every time round.
  int hits = 0;
  for (std::int64_t f = 0; f < 10; ++f) hits += ram.find(static_cast<std::uint64_t>(100 + f), kW, kH, FrameTag{1, f}) ? 1 : 0;
  CHECK(hits == 4);
}

TEST_CASE("ram cache: frames of another scope or outside the range make room first, least recently used first", "[ram_cache]") {
  RamFrameCache ram(3 * kFrameBytes);
  std::vector<RamFrame> evicted;
  const ProtectedRange old{1, 0, 99};
  REQUIRE(ram.store(1, ram_frame(1, 0, 1, 12.0, 501), old, evicted));  // an older scope (an edit since)
  REQUIRE(ram.store(2, ram_frame(1, 1, 2, 3.0, 502), old, evicted));
  REQUIRE(ram.store(3, ram_frame(2, 0), ProtectedRange{2, 0, 9}, evicted));
  // Scope 2 now plays frames 0–9: scope 1's frames are not protected any more.
  const ProtectedRange now{2, 0, 9};
  REQUIRE(ram.store(4, ram_frame(2, 1), now, evicted));
  REQUIRE(evicted.size() == 1);
  CHECK(evicted[0].diskKey == 501);  // the least recently used of the unprotected ones
  CHECK(evicted[0].drawMs == 12.0);  // what it cost travels with it (the disk tier's test)
  REQUIRE(ram.store(5, ram_frame(2, 2), now, evicted));
  CHECK(evicted.size() == 2);
  CHECK_FALSE(ram.contains(1));
  CHECK_FALSE(ram.contains(2));
  // Full of the playing range: a frame outside it is refused, nothing evicted.
  CHECK_FALSE(ram.store(6, ram_frame(2, 50), now, evicted));
  CHECK(evicted.size() == 2);
  CHECK(ram.contains(3));
}

TEST_CASE("ram cache: a smaller budget evicts down to it, protected frames too", "[ram_cache]") {
  RamFrameCache ram(4 * kFrameBytes);
  const ProtectedRange range{1, 0, 9};
  std::vector<RamFrame> evicted;
  for (std::int64_t f = 0; f < 4; ++f) REQUIRE(ram.store(static_cast<std::uint64_t>(f + 1), ram_frame(1, f), range, evicted));
  (void)ram.find(1, kW, kH, FrameTag{1, 0});  // 1 is the most recently used now
  ram.set_budget(2 * kFrameBytes, evicted);    // the machine runs short of memory
  CHECK(evicted.size() == 2);
  CHECK(ram.bytes() == 2 * kFrameBytes);
  CHECK(ram.contains(1));
  CHECK(ram.contains(4));
  CHECK_FALSE(ram.store(9, ram_frame(1, 5), range, evicted));  // still full of the range
  ram.clear();
  CHECK(ram.bytes() == 0);
  CHECK_FALSE(ram.contains(1));
}

TEST_CASE("ram cache: the default size follows the machine", "[ram_cache]") {
  constexpr std::uint64_t kGiB = std::uint64_t{1} << 30U;
  using premation::render::auto_ram_budget;
  CHECK(auto_ram_budget(0) == 2 * kGiB);
  CHECK(auto_ram_budget(4 * kGiB) == kGiB / 2);   // never below half a GiB
  CHECK(auto_ram_budget(8 * kGiB) == 2 * kGiB);   // a small machine: a quarter (Chromium, decode, the iGPU share the rest)
  CHECK(auto_ram_budget(12 * kGiB) == 3 * kGiB);
  CHECK(auto_ram_budget(16 * kGiB) == 8 * kGiB);  // half, leaving 4 GiB
  CHECK(auto_ram_budget(32 * kGiB) == 16 * kGiB);
  CHECK(auto_ram_budget(512 * kGiB) == 64 * kGiB);  // capped
}

TEST_CASE("ram cache: the limit grows into free memory and gives back a shortfall", "[ram_cache]") {
  constexpr std::uint64_t kMiB = std::uint64_t{1} << 20U;
  constexpr std::uint64_t kGiB = std::uint64_t{1} << 30U;
  using premation::render::ram_budget_now;
  // 32 GiB installed: the reserve is a tenth.
  const std::uint64_t phys = 32 * kGiB;
  const std::uint64_t reserve = phys / 10;
  CHECK(ram_budget_now(16 * kGiB, 0, 0, 0) == 16 * kGiB);                               // memory unknown: the target
  CHECK(ram_budget_now(16 * kGiB, 2 * kGiB, phys, 20 * kGiB) == 16 * kGiB);             // plenty free: the target
  CHECK(ram_budget_now(16 * kGiB, 2 * kGiB, phys, reserve + kGiB) == 3 * kGiB);         // grows by what is free above the reserve
  CHECK(ram_budget_now(16 * kGiB, 8 * kGiB, phys, reserve) == 8 * kGiB);                // at the reserve: holds
  CHECK(ram_budget_now(16 * kGiB, 8 * kGiB, phys, reserve - 100 * kMiB) == 8 * kGiB);   // a small dip: no churn
  CHECK(ram_budget_now(16 * kGiB, 8 * kGiB, phys, reserve - 2 * kGiB) == 6 * kGiB);     // 2 GiB short: gives 2 GiB back
  CHECK(ram_budget_now(16 * kGiB, kGiB, phys, 512 * kMiB) == 0);                        // shorter than it holds: empties
  // The shrunk limit evicts the frames (protected ones too: the machine comes first), handed back for the disk tier.
  RamFrameCache ram(4 * kFrameBytes);
  std::vector<RamFrame> evicted;
  for (std::int64_t f = 0; f < 4; ++f) REQUIRE(ram.store(static_cast<std::uint64_t>(f + 1), ram_frame(1, f), ProtectedRange{}, evicted));
  ram.set_budget(static_cast<std::size_t>(ram_budget_now(4 * kFrameBytes, ram.bytes(), phys, reserve - kGiB)), evicted);
  CHECK(ram.bytes() == 0);
  CHECK(evicted.size() == 4);
}

TEST_CASE("ram cache: the frame an open view shows is pinned — another view's fill never evicts it", "[ram_cache][pins]") {
  // Room for 3 frames. View A shows frame 5 of scope 1 (key 105); view B fills
  // scope 2's range 0–9. Without the pin, B's third frame would take A's.
  RamFrameCache ram(3 * kFrameBytes);
  std::vector<RamFrame> evicted;
  REQUIRE(ram.store(105, ram_frame(1, 5), ProtectedRange{}, evicted));
  ProtectedRange b{2, 0, 9};
  b.pin(105);
  REQUIRE(ram.store(200, ram_frame(2, 0), b, evicted));
  REQUIRE(ram.store(201, ram_frame(2, 1), b, evicted));
  // Full: B's range is protected and A's frame is pinned — the next frame is refused, nothing evicted.
  CHECK_FALSE(ram.store(202, ram_frame(2, 2), b, evicted));
  CHECK(evicted.empty());
  CHECK(ram.contains(105));
  CHECK(ram.stats().refused == 1);
  // The pin is the only thing keeping it: without it, A's frame is the first to go.
  const ProtectedRange unpinned{2, 0, 9};
  REQUIRE(ram.store(202, ram_frame(2, 2), unpinned, evicted));
  REQUIRE(evicted.size() == 1);
  CHECK(evicted[0].tag.scope == 1);
  CHECK_FALSE(ram.contains(105));
}

TEST_CASE("ram cache: pins hold a few keys, oldest out, never 0", "[ram_cache][pins]") {
  ProtectedRange p;
  p.pin(0);
  CHECK_FALSE(p.pins(0));
  for (std::uint64_t k = 1; k <= ProtectedRange::kMaxPinned; ++k) p.pin(k);
  p.pin(3);  // already there: no change
  CHECK(p.pins(1));
  CHECK(p.pins(ProtectedRange::kMaxPinned));
  p.pin(ProtectedRange::kMaxPinned + 1);  // one too many: the oldest goes
  CHECK_FALSE(p.pins(1));
  CHECK(p.pins(2));
  CHECK(p.pins(ProtectedRange::kMaxPinned + 1));
  CHECK(p.keeps(2, FrameTag{}));
  CHECK_FALSE(p.keeps(999, FrameTag{}));
  p.clear_pins();
  CHECK_FALSE(p.pins(2));
}
