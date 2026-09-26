// F2 bundles: the `.motion` forms the engine writes (core/bundle_io.hpp) —
// bundleCodec.ts's chunk partition and hash, BundleRepository's
// manifest-last incremental save, footage collected from the source bundle,
// and portableMotion.ts's STORE zip. The cross-engine proof that the page's
// BundleRepository reads what this writes (and the other way round) is
// src/core/project/bundleCrossEngine.test.ts; these pin the pieces on their own.

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <map>
#include <random>
#include <sstream>

#include "core/bundle_io.hpp"
#include "core/fail.hpp"

using namespace premation;
namespace fs = std::filesystem;
using js::Json;

namespace {

struct TempDir {
  fs::path path;
  TempDir() {
    std::random_device rd;
    path = fs::temp_directory_path() / ("premation-bundle-" + std::to_string(rd()) + "-" +
                                        std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    fs::create_directories(path);
  }
  TempDir(const TempDir&) = delete;
  TempDir& operator=(const TempDir&) = delete;
  TempDir(TempDir&&) = delete;
  TempDir& operator=(TempDir&&) = delete;
  ~TempDir() {
    std::error_code ec;
    fs::remove_all(path, ec);
  }
};

std::string slurp(const fs::path& p) {
  std::ifstream in(p, std::ios::binary);
  std::ostringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

void spit(const fs::path& p, const std::string& s) {
  fs::create_directories(p.parent_path());
  std::ofstream out(p, std::ios::binary | std::ios::trunc);
  out << s;
}

Json parse(const std::string& s) {
  auto j = js::parse(s);
  REQUIRE(j.has_value());
  return std::move(*j);
}

constexpr const char* kHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

Json sample_doc() {
  return parse(std::string(R"({"version":"1.8.0","scene":{"version":"1.0.0","nodes":[)") +
               R"({"id":"comp_root","parent":null,"children":["n1"],"components":[]},)" +
               R"({"id":"n1","parent":"comp_root","children":[],"components":[{"id":"n1_video","type":"video","props":{"assetId":"asset_plate","src":"motion-blob:)" +
               kHash + R"("}}]}]},)" +
               R"("animation":{"tracks":{},"expressions":{}},)" +
               R"("comps":{"comp_root":{"id":"comp_root","name":"C"}},"swatches":[]})");
}

/// The STORE zip's entries (name → bytes), read back the way unzip does.
std::map<std::string, std::string> unzip_store(const std::string& z) {
  auto u16 = [&z](std::size_t o) { return static_cast<std::uint32_t>(static_cast<unsigned char>(z[o])) | (static_cast<std::uint32_t>(static_cast<unsigned char>(z[o + 1])) << 8U); };
  auto u32 = [&u16](std::size_t o) { return u16(o) | (u16(o + 2) << 16U); };
  std::map<std::string, std::string> out;
  std::size_t o = 0;
  while (o + 30 <= z.size() && u32(o) == 0x04034b50U) {
    const std::uint32_t size = u32(o + 18);
    const std::uint32_t nameLen = u16(o + 26);
    const std::string name = z.substr(o + 30, nameLen);
    const std::string data = z.substr(o + 30 + nameLen, size);
    CHECK(doc::zip_crc32(data) == u32(o + 14));
    out.emplace(name, data);
    o += 30 + nameLen + size;
  }
  CHECK(u32(o) == 0x02014b50U);  // the central directory follows the entries
  return out;
}

}  // namespace

TEST_CASE("bundle hash is hash.ts hashString over UTF-16 code units", "[bundle]") {
  // Reference values from the TypeScript implementation.
  CHECK(doc::bundle_hash("") == "cbf29ce484222325");
  CHECK(doc::bundle_hash(R"({"a":1})") == "4d11c27d39f25a19");
  CHECK(doc::bundle_hash("\xC3\xA9\xE6\xBC\xA2\xE5\xAD\x97\xF0\x9F\x98\x80") == "d0efb03af34f07fe");  // é漢字😀
  CHECK(doc::zip_crc32("123456789") == 0xCBF43926U);
}

TEST_CASE("a bundle round-trips, manifest hashes name the chunk text, unchanged chunks are not rewritten", "[bundle]") {
  TempDir t;
  const fs::path b = t.path / "P.motion";
  const Json d = sample_doc();
  doc::write_bundle(b, d, {});
  REQUIRE(doc::is_bundle_dir(b));
  const Json manifest = parse(slurp(b / "manifest.json"));
  CHECK(manifest.at("bundleFormat").str() == "2.0.0");
  CHECK(manifest.at("documentVersion").str() == "1.8.0");
  for (const char* name : {"scene.json", "animation.json", "meta.json"}) {
    REQUIRE(manifest.at("chunks").at(name).is_string());
    CHECK(manifest.at("chunks").at(name).str() == doc::bundle_hash(slurp(b / name)));
  }
  // No timeline or project fields: those chunks are omitted, as encodeBundle does.
  CHECK_FALSE(fs::exists(b / "timeline.json"));
  CHECK_FALSE(manifest.at("chunks").has("project.json"));
  CHECK(slurp(b / "meta.json") == R"({"comps":{"comp_root":{"id":"comp_root","name":"C"}},"swatches":[]})");

  const Json back = doc::read_bundle(b);
  CHECK(js::stringify(back.at("scene")) == js::stringify(d.at("scene")));
  CHECK(js::stringify(back.at("comps")) == js::stringify(d.at("comps")));
  CHECK(back.at("swatches").is_array());  // present-but-empty survives

  // Incremental: a chunk whose hash did not change is not rewritten (tamper, save, still tampered).
  spit(b / "animation.json", "tampered");
  doc::write_bundle(b, d, {});
  CHECK(slurp(b / "animation.json") == "tampered");
  // A chunk that went away is removed; files the codec does not know are kept.
  spit(b / "versions" / "index.json", "{}");
  Json noMeta = d;
  noMeta.erase("comps");
  noMeta.erase("swatches");
  doc::write_bundle(b, noMeta, {});
  CHECK_FALSE(fs::exists(b / "meta.json"));
  CHECK(fs::exists(b / "versions" / "index.json"));
  CHECK_FALSE(parse(slurp(b / "manifest.json")).at("chunks").has("meta.json"));
  // No temp file is left behind.
  for (const auto& e : fs::recursive_directory_iterator(b)) CHECK(e.path().extension() != ".premation-tmp");
}

TEST_CASE("a bundle save collects the footage the target lacks from the source bundle", "[bundle]") {
  TempDir t;
  const fs::path src = t.path / "Old.motion";
  const fs::path dst = t.path / "New.motion";
  spit(src / "blobs" / "01" / kHash, "VIDEO-BYTES");
  spit(src / "assets" / "registry.json",
       std::string(R"({"version":"1.0.0","assets":[{"id":"asset_plate","hash":")") + kHash +
           R"(","name":"plate.mp4","type":"video","mime":"video/mp4","size":11},{"id":"other","hash":"ffff0000ffff0000","name":"x.png","type":"image","mime":"image/png","size":1}]})");
  doc::write_bundle(dst, sample_doc(), src);
  CHECK(slurp(dst / "blobs" / "01" / kHash) == "VIDEO-BYTES");
  const Json reg = parse(slurp(dst / "assets" / "registry.json"));
  REQUIRE(reg.at("assets").arr().size() == 1);  // only the rows of blobs it copied
  CHECK(reg.at("assets").arr()[0].at("id").str() == "asset_plate");
  // The document keeps naming its footage by hash.
  CHECK(slurp(dst / "scene.json").find(std::string("motion-blob:") + kHash) != std::string::npos);
}

TEST_CASE("a bundle never replaces a plain file", "[bundle]") {
  TempDir t;
  const fs::path f = t.path / "P.motion";
  spit(f, "{\"version\":\"1.1.0\"}");
  bool refused = false;
  try {
    doc::write_bundle(f, sample_doc(), {});
  } catch (const doc::EngineFail& e) {
    refused = e.error.code == api::ErrorCode::io;
  }
  CHECK(refused);
  CHECK(slurp(f) == "{\"version\":\"1.1.0\"}");
}

TEST_CASE("a portable .motion is portableMotion.ts's zip with the footage embedded", "[bundle]") {
  TempDir t;
  const fs::path src = t.path / "Old.motion";
  spit(src / "blobs" / "01" / kHash, "VIDEO-BYTES");
  spit(src / "assets" / "registry.json",
       std::string(R"({"version":"1.0.0","assets":[{"id":"asset_plate","hash":")") + kHash +
           R"(","name":"plate.mp4","type":"video","mime":"video/mp4","size":11}]})");
  const fs::path z = t.path / "Copy.motion";
  const std::uint64_t bytes = doc::write_portable(z, sample_doc(), src);
  CHECK(bytes == fs::file_size(z));
  const auto entries = unzip_store(slurp(z));
  REQUIRE(entries.contains("manifest.json"));
  REQUIRE(entries.contains("scene.json"));
  CHECK(entries.at("assets/n1.mp4") == "VIDEO-BYTES");
  const Json scene = parse(entries.at("scene.json"));
  CHECK(scene.at("nodes").arr()[1].at("components").arr()[0].at("props").at("src").str() == "assets/n1.mp4");
  const Json reg = parse(entries.at("assets/registry.json"));
  CHECK(reg.at("assets").arr()[0].at("fileName").str() == "n1.mp4");
  CHECK(reg.at("assets").arr()[0].at("mime").str() == "video/mp4");
}
