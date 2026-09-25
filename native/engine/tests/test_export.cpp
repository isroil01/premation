// F1: the export job's GPU-free parts — the encoder child, the bundle reader,
// the raw-pipe pixel conversion and the WAV writer.
#include <catch2/catch_test_macros.hpp>

#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "child_process.hpp"
#include "exr_write.hpp"
#include "ffmetadata.hpp"
#include "frame_convert.hpp"
#include "png_write.hpp"
#include "project_open.hpp"
#include "wav_write.hpp"
#include "zip_write.hpp"

namespace ex = premation::exporter;
namespace fs = std::filesystem;
using premation::js::Json;

namespace {

fs::path temp_dir(const char* name) {
  const fs::path d = fs::temp_directory_path() / (std::string("premation-export-test-") + name);
  std::error_code ec;
  fs::remove_all(d, ec);
  fs::create_directories(d);
  return d;
}

void write_text(const fs::path& p, const std::string& s) {
  fs::create_directories(p.parent_path());
  std::ofstream(p, std::ios::binary) << s;
}

std::string read_text(const fs::path& p) {
  std::ifstream in(p, std::ios::binary);
  std::ostringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

}  // namespace

TEST_CASE("Windows argument quoting follows CommandLineToArgvW", "[export]") {
  CHECK(ex::quote_windows_arg("plain") == "plain");
  CHECK(ex::quote_windows_arg("") == "\"\"");
  CHECK(ex::quote_windows_arg("a b") == "\"a b\"");
  CHECK(ex::quote_windows_arg("C:\\Program Files\\x\\") == "\"C:\\Program Files\\x\\\\\"");
  CHECK(ex::quote_windows_arg("say \"hi\"") == "\"say \\\"hi\\\"\"");
  CHECK(ex::quote_windows_arg("scale=trunc(iw/2)*2:trunc(ih/2)*2") == "scale=trunc(iw/2)*2:trunc(ih/2)*2");
}

TEST_CASE("the encoder child receives every byte, in order", "[export]") {
  const fs::path dir = temp_dir("child");
  const fs::path out = dir / "out file.raw";
  std::string err;
  auto child = ex::ChildProcess::spawn(PREMATION_EXPORT_SINK, {"-f", "rawvideo", "-i", "pipe:0", out.string()},
                                       (dir / "log.txt").string(), err);
  REQUIRE(child);
  std::vector<std::uint8_t> frame(1920U * 1080U * 4U);
  for (std::size_t i = 0; i < frame.size(); ++i) frame[i] = static_cast<std::uint8_t>(i * 31U + 7U);
  for (int k = 0; k < 3; ++k) REQUIRE(child->write(frame));
  CHECK(child->finish() == 0);
  const std::string got = read_text(out);
  REQUIRE(got.size() == frame.size() * 3);
  CHECK(std::equal(frame.begin(), frame.end(), reinterpret_cast<const std::uint8_t*>(got.data())));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
}

TEST_CASE("a missing encoder fails at spawn, a killed one refuses writes", "[export]") {
  std::string err;
  auto none = ex::ChildProcess::spawn((temp_dir("none") / "no-such-ffmpeg.exe").string(), {}, "", err);
  CHECK_FALSE(none);
  CHECK_FALSE(err.empty());
  const fs::path dir = temp_dir("kill");
  auto child = ex::ChildProcess::spawn(PREMATION_EXPORT_SINK, {(dir / "o").string()}, "", err);
  REQUIRE(child);
  child->kill();
  std::vector<std::uint8_t> big(8U << 20U, 1);
  CHECK_FALSE(child->write(big));
}

TEST_CASE("premultiplied surface rows become the raw pipe's straight RGBA", "[export]") {
  // opaque, transparent, half-alpha: (100,50,0,128) premultiplied → c·255/128.
  const std::vector<std::uint8_t> src = {10, 20, 30, 255, 7, 8, 9, 0, 100, 50, 0, 128, 0, 0, 0, 0};
  std::vector<std::uint8_t> dst(16);
  ex::surface_to_straight_rgba(src, 4, 1, 16, false, dst);
  CHECK(dst[0] == 10);
  CHECK(dst[3] == 255);
  CHECK(dst[4] == 0);
  CHECK(dst[7] == 0);
  CHECK(dst[8] == 199);  // 100 / 128 × 255 = 199.2
  CHECK(dst[9] == 100);  // 50 / 128 × 255 = 99.6
  CHECK(dst[11] == 128);
  // BGRA source, padded stride.
  const std::vector<std::uint8_t> bgra = {30, 20, 10, 255, 0xEE, 0xEE, 0xEE, 0xEE};
  std::vector<std::uint8_t> one(4);
  ex::surface_to_straight_rgba(bgra, 1, 1, 8, true, one);
  CHECK(one == std::vector<std::uint8_t>{10, 20, 30, 255});
  // Every (c ≤ a) pair round-trips within one step of the exact quotient.
  for (unsigned a = 1; a < 255; ++a) {
    for (unsigned c = 0; c <= a; c += 7) {
      const std::vector<std::uint8_t> px = {static_cast<std::uint8_t>(c), 0, 0, static_cast<std::uint8_t>(a)};
      std::vector<std::uint8_t> o(4);
      ex::surface_to_straight_rgba(px, 1, 1, 4, false, o);
      const double exact = static_cast<double>(c) * 255.0 / a;
      CHECK(std::abs(static_cast<double>(o[0]) - exact) <= 0.5 + 1e-3);
    }
  }
}

TEST_CASE("16-bit output: half-float surface → straight rgba64le", "[export]") {
  CHECK(ex::half_to_float(0x3C00) == 1.0F);
  CHECK(ex::half_to_float(0x3800) == 0.5F);
  CHECK(ex::half_to_float(0x0001) == 5.9604645e-08F);  // smallest subnormal, 2^-24
  CHECK(ex::half_to_float(0xC000) == -2.0F);
  // (0.25, 0.5, 1.5, a = 0.5) premultiplied → straight (0.5, 1.0, clamp 1.0, 0.5); then a = 0.
  const std::vector<std::uint16_t> px = {0x3400, 0x3800, 0x3E00, 0x3800, 0x3C00, 0x3C00, 0x3C00, 0x0000};
  std::vector<std::uint8_t> src(px.size() * 2);
  std::memcpy(src.data(), px.data(), src.size());
  std::vector<std::uint8_t> dst(16);
  ex::half_surface_to_rgba64(src, 2, 1, 16, dst);
  std::vector<std::uint16_t> o(8);
  std::memcpy(o.data(), dst.data(), dst.size());
  CHECK(o[0] == 32768);  // round(0.5 × 65535) = 32767.5 → 32768
  CHECK(o[1] == 65535);
  CHECK(o[2] == 65535);
  CHECK(o[3] == 32768);
  CHECK(o[4] == 0);
  CHECK(o[7] == 0);
}

TEST_CASE("the WAV matches audioMixdown.ts encodeWav", "[export]") {
  const std::vector<std::vector<float>> ch = {{0.0F, 1.0F, -1.0F, 0.5F, 2.0F}, {-0.5F, 0.25F, -0.0001F, 0.0F, -2.0F}};
  const auto w = ex::encode_wav16(ch, 48000);
  REQUIRE(w.size() == 44 + 5 * 4);
  CHECK(std::string(w.begin(), w.begin() + 4) == "RIFF");
  CHECK(std::string(w.begin() + 8, w.begin() + 16) == "WAVEfmt ");
  const auto s16 = [&](std::size_t i) { return static_cast<std::int16_t>(w[44 + i * 2] | (w[45 + i * 2] << 8)); };
  CHECK(s16(0) == 0);
  CHECK(s16(1) == -16384);  // -0.5 × 0x8000
  CHECK(s16(2) == 32767);   // 1 × 0x7fff
  CHECK(s16(4) == -32768);
  CHECK(s16(5) == -3);      // -0.0001 × 32768 = -3.2768 → ToInt16 truncates to -3
  CHECK(s16(6) == 16383);   // 0.5 × 32767 = 16383.5 → 16383
  CHECK(s16(8) == 32767);   // clamped
  CHECK(s16(9) == -32768);
}

TEST_CASE("a .motion bundle opens as decodeBundle reads it, footage pointing at its blobs", "[export]") {
  const fs::path b = temp_dir("bundle") / "p.motion";
  const std::string hash = "0123456789abcdef0123456789abcdef";
  write_text(b / "manifest.json", R"({"bundleFormat":"2.0.0","documentVersion":"1.8.0","chunks":{}})");
  write_text(b / "scene.json", R"({"version":"1.0.0","nodes":[{"id":"n","components":[{"props":{"src":"motion-blob:)" + hash +
                                     R"("}}]}]})");
  write_text(b / "meta.json", R"({"comps":{"c1":{"name":"Main"}}})");
  write_text(b / "timeline.json", R"({"motionBlur":{"enabled":true}})");
  write_text(b / "assets" / "registry.json",
             R"({"version":"1","assets":[{"id":"a1","hash":")" + hash + R"(","name":"clip.mp4","type":"video","mime":"video/mp4","size":9,"width":64},{"id":"f","hash":"ab","name":"x.ttf","type":"font","mime":"","size":1}]})");
  ex::OpenedProject p;
  std::string err;
  REQUIRE(ex::open_project(b, p, err));
  CHECK(p.document.at("version").str() == "1.8.0");
  CHECK(p.document.at("comps").at("c1").at("name").str() == "Main");
  CHECK(p.document.at("motionBlur").at("enabled").b());
  CHECK(p.document.at("animation").at("tracks").is_object());
  const std::string blob = (b / "blobs" / "01" / hash).string();
  CHECK(fs::path(p.document.at("scene").at("nodes").arr()[0].at("components").arr()[0].at("props").at("src").str()) == fs::path(blob));
  REQUIRE(p.sessionAssets.size() == 1);  // fonts are not library entries
  CHECK(p.sessionAssets[0].at("id").str() == "a1");
  CHECK(fs::path(p.sessionAssets[0].at("src").str()) == fs::path(blob));
  CHECK(p.sessionAssets[0].at("metadata").at("width").num() == 64);
}

TEST_CASE("a JSON document opens; a render-tests scene brings its footage", "[export]") {
  const fs::path d = temp_dir("json");
  write_text(d / "project.json", R"({"version":"1.9.0","scene":{"nodes":[]},"harness":{"assets":[{"id":"x","src":"file:///a.png"}]}})");
  ex::OpenedProject p;
  std::string err;
  REQUIRE(ex::open_project(d / "project.json", p, err));
  CHECK(p.sessionAssets.size() == 1);
  CHECK(p.mediaBase == d);
  write_text(d / "bad.json", "{nope");
  CHECK_FALSE(ex::open_project(d / "bad.json", p, err));
  CHECK_FALSE(ex::open_project(d / "missing.json", p, err));
}

TEST_CASE("chapter metadata matches the editor's FFMETADATA1 text", "[export]") {
  CHECK(ex::format_ffmetadata({}).empty());
  const std::string text = ex::format_ffmetadata({{0, 2000, "Intro"}, {2000, 5000, "Body"}});
  CHECK(text == ";FFMETADATA1\n"
                 "[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2000\ntitle=Intro\n"
                 "[CHAPTER]\nTIMEBASE=1/1000\nSTART=2000\nEND=5000\ntitle=Body\n");
  const std::string escaped = ex::format_ffmetadata({{0, 1000, "A = B; Take #3"}});
  CHECK(escaped.find("title=A \\= B\\; Take \\#3\n") != std::string::npos);
}

TEST_CASE("a PNG sequence frame is a readable RGBA PNG, and a zip of frames stores them", "[export]") {
  const std::vector<std::uint8_t> px = {255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128};
  std::vector<std::uint8_t> png;
  REQUIRE(ex::encode_png_rgba8(px, 2, 2, png));
  REQUIRE(png.size() > 8);
  CHECK(png[0] == 0x89);
  CHECK(png[1] == 'P');
  CHECK(png[2] == 'N');
  CHECK(png[3] == 'G');
  const std::vector<std::uint8_t> half(2 * 2 * 8, 0);
  const std::vector<std::uint8_t> exr = ex::encode_exr_half(half, 2, 2);
  REQUIRE(exr.size() > 8);
  CHECK(exr[0] == 0x76);  // magic 20000630 little-endian starts with 0x76
  const fs::path d = temp_dir("zip");
  ex::ZipWriter zip;
  REQUIRE(zip.open(d / "frames.zip"));
  REQUIRE(zip.add("frame_0001.png", png));
  REQUIRE(zip.finish());
  CHECK(fs::file_size(d / "frames.zip") > png.size());
}
