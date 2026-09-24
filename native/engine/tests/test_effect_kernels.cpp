// E4 cross-engine effect-kernel parity (tests/data/effect_kernel_parity.json,
// written by src/core/effects/nativeKernelCrossEngine.test.ts): every ported
// CPU kernel, run on the fixture's synthetic RGBA inputs with the recorded
// arguments, must give the TypeScript kernel's output byte for byte (FNV-1a
// 64) — on the calling thread alone and split across a thread pool.
//
// EFFECT_KERNEL_DUMP=<dir> writes each C++ output as raw RGBA on mismatch.
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <bit>
#include <cmath>
#include <limits>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include "effects/kernel_dispatch.hpp"
#include "jsmath.hpp"
#include "raster/json.hpp"

namespace fx = premation::effects;
namespace json = premation::raster::json;

namespace {

std::string fnv1a64(const std::vector<std::uint8_t>& bytes) {
  std::uint64_t h = 0xcbf29ce484222325ULL;
  for (const std::uint8_t b : bytes) {
    h ^= b;
    h *= 0x100000001b3ULL;
  }
  std::array<char, 17> out{};
  std::snprintf(out.data(), out.size(), "%016llx", static_cast<unsigned long long>(h));  // NOLINT(cppcoreguidelines-pro-type-vararg)
  return {out.data()};
}

std::vector<std::uint8_t> base64(std::string_view s) {
  std::array<int, 256> dec{};
  dec.fill(-1);
  const std::string_view abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (std::size_t i = 0; i < abc.size(); ++i) dec[static_cast<unsigned char>(abc[i])] = static_cast<int>(i);
  std::vector<std::uint8_t> out;
  std::uint32_t acc = 0;
  int bits = 0;
  for (const char c : s) {
    const int v = dec[static_cast<unsigned char>(c)];
    if (v < 0) continue;  // '=' padding
    acc = (acc << 6U) | static_cast<std::uint32_t>(v);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<std::uint8_t>((acc >> static_cast<unsigned>(bits)) & 0xFFU));
    }
  }
  return out;
}

json::Value load_fixture() {
  std::ifstream f(std::string(PREMATION_ENGINE_TEST_DATA) + "/effect_kernel_parity.json", std::ios::binary);
  REQUIRE(f.good());
  std::stringstream ss;
  ss << f.rdbuf();
  json::Value v;
  std::string err;
  REQUIRE(json::parse(ss.str(), v, err));
  return v;
}

struct Image {
  int w = 0;
  int h = 0;
  std::vector<std::uint8_t> rgba;
};

}  // namespace

TEST_CASE("effect kernels: the fixture's inputs decode to the TS bytes", "[effects][parity]") {
  const json::Value fixture = load_fixture();
  REQUIRE(fixture["images"].size() >= 3);
  for (const json::Value& im : fixture["images"].items()) {
    const auto bytes = base64(im["rgba"].str());
    CHECK(bytes.size() == static_cast<std::size_t>(im["w"].num() * im["h"].num() * 4));
    CHECK(fnv1a64(bytes) == im["fnv"].str());
  }
}

TEST_CASE("effect kernels: C++ equals the TS kernels byte for byte, 1 thread and N", "[effects][parity]") {
  const json::Value fixture = load_fixture();
  std::map<std::string, Image, std::less<>> images;
  for (const json::Value& im : fixture["images"].items()) {
    images[im["name"].str()] = Image{static_cast<int>(im["w"].num()), static_cast<int>(im["h"].num()), base64(im["rgba"].str())};
  }
  fx::ThreadPool pool(4);
  const char* dump = std::getenv("EFFECT_KERNEL_DUMP");  // NOLINT(concurrency-mt-unsafe)
  std::set<std::string> covered;
  int index = 0;
  for (const json::Value& row : fixture["rows"].items()) {
    const std::string effect = row["effect"].str();
    const json::Value& args = row["args"];
    INFO(effect << " #" << index << " on " << row["image"].str());
    const Image& im = images.at(row["image"].str());
    const fx::KernelArgs a = [&](std::string_view k, double def) { return args.has(k) ? args[k].num(def) : def; };
    const fx::KernelLists kl = [&](std::string_view k) {
      std::vector<double> v;
      if (args.has(k) && args[k].is_array()) {
        for (const json::Value& x : args[k].items()) v.push_back(x.num());
      }
      return v;
    };
    for (fx::ThreadPool* p : {static_cast<fx::ThreadPool*>(nullptr), &pool}) {
      std::vector<std::uint8_t> buf = im.rgba;
      REQUIRE(fx::run_kernel(effect, a, kl, fx::RgbaView{buf, im.w, im.h}, p));
      const std::string got = fnv1a64(buf);
      if (got != row["fnv"].str() && dump != nullptr) {
        std::ofstream o(std::string(dump) + "/" + std::to_string(index) + "-" + effect + (p ? "-mt" : "") + ".rgba",
                        std::ios::binary);
        o.write(reinterpret_cast<const char*>(buf.data()), static_cast<std::streamsize>(buf.size()));  // NOLINT
      }
      CHECK(got == row["fnv"].str());
    }
    covered.insert(effect);
    ++index;
  }
  // Every ported kernel has at least one fixture row.
  for (const std::string_view k : fx::ported_kernels()) {
    INFO(k);
    CHECK(covered.count(std::string(k)) == 1);
  }
}

TEST_CASE("effect kernels: jhypot2 is motion::js::hypot bit for bit", "[effects][math]") {
  std::uint64_t s = 0x9e3779b97f4a7c15ULL;
  const auto next = [&] {
    s ^= s << 13U;
    s ^= s >> 7U;
    s ^= s << 17U;
    return s;
  };
  const auto same = [](double a, double b) {
    const std::array<double, 2> v{a, b};
    const double want = motion::js::hypot(v);
    const double got = fx::jhypot2(a, b);
    return (std::isnan(want) && std::isnan(got)) || std::bit_cast<std::uint64_t>(want) == std::bit_cast<std::uint64_t>(got);
  };
  const double inf = std::numeric_limits<double>::infinity();
  const double nan = std::numeric_limits<double>::quiet_NaN();
  for (const auto& [a, b] : std::array<std::array<double, 2>, 9>{{{0, 0}, {-0.0, 0}, {3, 4}, {inf, nan}, {nan, -inf},
                                                                  {nan, 1}, {1e-310, 3e-310}, {1e300, 1e300}, {-5, 5}}}) {
    CHECK(same(a, b));
  }
  int bad = 0;
  for (int i = 0; i < 200000; ++i) {
    // Pixel-scale offsets and arbitrary finite doubles.
    const double a = static_cast<double>(static_cast<std::int64_t>(next() % 8000001) - 4000000) / 1024.0;
    const double b = static_cast<double>(static_cast<std::int64_t>(next() % 8000001) - 4000000) / 3.0;
    const double c = std::bit_cast<double>(next() & 0x7FEFFFFFFFFFFFFFULL);
    const double d = std::bit_cast<double>(next() & 0xFFEFFFFFFFFFFFFFULL);
    if (!same(a, b) || !same(c, d) || !same(a, c)) ++bad;
  }
  CHECK(bad == 0);
  // ji32 (the kernels' inline ToInt32) against motion::js::to_int32, over
  // hash-scale sums, huge magnitudes and every exponent.
  int bad32 = 0;
  for (int i = 0; i < 200000; ++i) {
    const double a = static_cast<double>(static_cast<std::int64_t>(next() % 20001) - 10000) * 374761393.0 +
                     static_cast<double>(static_cast<std::int64_t>(next() % 20001) - 10000) * 668265263.0;
    const double c = std::bit_cast<double>(next() & 0xFFEFFFFFFFFFFFFFULL);
    if (fx::ji32(a) != motion::js::to_int32(a) || fx::ji32(c) != motion::js::to_int32(c)) ++bad32;
  }
  CHECK(bad32 == 0);
}

TEST_CASE("effect kernels: the thread pool covers every row exactly once", "[effects][pool]") {
  for (const unsigned threads : {1U, 2U, 3U, 8U}) {
    fx::ThreadPool pool(threads);
    for (const int n : {0, 1, 7, 64, 1000, 1081}) {
      std::vector<int> hits(static_cast<std::size_t>(n), 0);
      for (int rep = 0; rep < 3; ++rep) {
        pool.parallel_for(n, 1, [&](int b, int e) {
          for (int i = b; i < e; ++i) ++hits[static_cast<std::size_t>(i)];
        });
      }
      for (const int h : hits) CHECK(h == 3);
    }
  }
}
