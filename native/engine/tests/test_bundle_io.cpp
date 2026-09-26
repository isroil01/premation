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
#include "core/deflate.hpp"
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

/// The same entries as a zip another tool would write: every entry DEFLATE (method 8).
std::string deflate_zip(const std::map<std::string, std::string>& entries) {
  std::string out;
  std::string central;
  auto p16 = [](std::string& b, std::uint32_t v) {
    b.push_back(static_cast<char>(v & 0xFFU));
    b.push_back(static_cast<char>((v >> 8U) & 0xFFU));
  };
  auto p32 = [&p16](std::string& b, std::uint32_t v) {
    p16(b, v & 0xFFFFU);
    p16(b, v >> 16U);
  };
  for (const auto& [name, data] : entries) {
    const std::span<const std::uint8_t> raw(reinterpret_cast<const std::uint8_t*>(data.data()), data.size());
    std::vector<std::uint8_t> packed;
    REQUIRE(zlib::deflate_raw(raw, 9, packed));
    const auto offset = static_cast<std::uint32_t>(out.size());
    const std::uint32_t crc = doc::zip_crc32(data);
    p32(out, 0x04034b50U);
    p16(out, 20);
    p16(out, 0);
    p16(out, 8);
    p32(out, 0);
    p32(out, crc);
    p32(out, static_cast<std::uint32_t>(packed.size()));
    p32(out, static_cast<std::uint32_t>(data.size()));
    p16(out, static_cast<std::uint32_t>(name.size()));
    p16(out, 0);
    out += name;
    out.append(packed.begin(), packed.end());
    p32(central, 0x02014b50U);
    p16(central, 20);
    p16(central, 20);
    p16(central, 0);
    p16(central, 8);
    p32(central, 0);
    p32(central, crc);
    p32(central, static_cast<std::uint32_t>(packed.size()));
    p32(central, static_cast<std::uint32_t>(data.size()));
    p16(central, static_cast<std::uint32_t>(name.size()));
    p16(central, 0);
    p16(central, 0);
    p16(central, 0);
    p16(central, 0);
    p32(central, 0);
    p32(central, offset);
    central += name;
  }
  const auto cdStart = static_cast<std::uint32_t>(out.size());
  out += central;
  p32(out, 0x06054b50U);
  p16(out, 0);
  p16(out, 0);
  p16(out, static_cast<std::uint32_t>(entries.size()));
  p16(out, static_cast<std::uint32_t>(entries.size()));
  p32(out, static_cast<std::uint32_t>(central.size()));
  p32(out, cdStart);
  p16(out, 0);
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

TEST_CASE("sha256_hex is contentHash.ts sha256Hex", "[bundle]") {
  CHECK(doc::sha256_hex("") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  CHECK(doc::sha256_hex("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  // 56 bytes: the padding spills into a second block.
  CHECK(doc::sha256_hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq") ==
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
}

TEST_CASE("a portable .motion opens in the engine: chunks decoded, footage staged as a bundle", "[bundle]") {
  TempDir t;
  const fs::path src = t.path / "Old.motion";
  spit(src / "blobs" / "01" / kHash, "VIDEO-BYTES");
  spit(src / "assets" / "registry.json",
       std::string(R"({"version":"1.0.0","assets":[{"id":"asset_plate","hash":")") + kHash +
           R"(","name":"plate.mp4","type":"video","mime":"video/mp4","size":11}]})");
  const fs::path z = t.path / "Copy.motion";
  doc::write_portable(z, sample_doc(), src);
  REQUIRE(doc::is_portable_file(z));
  CHECK_FALSE(doc::is_portable_file(src));  // a bundle directory is not a zip

  const fs::path staging = t.path / "staging";
  const doc::PortableOpen o = doc::read_portable(z, staging);
  CHECK(o.embedded == 1);
  CHECK(o.footageRoot == staging);
  const std::string sha = doc::sha256_hex("VIDEO-BYTES");
  CHECK(slurp(staging / "blobs" / sha.substr(0, 2) / sha) == "VIDEO-BYTES");
  const Json& props = o.doc.at("scene").at("nodes").arr()[1].at("components").arr()[0].at("props");
  CHECK(props.at("src").str() == "motion-blob:" + sha);
  CHECK(props.at("assetId").str() == "asset_plate");
  CHECK(js::stringify(o.doc.at("comps")) == js::stringify(sample_doc().at("comps")));
  CHECK(o.doc.at("version").str() == "1.8.0");
  const Json reg = parse(slurp(staging / "assets" / "registry.json"));
  REQUIRE(reg.at("assets").arr().size() == 1);
  CHECK(reg.at("assets").arr()[0].at("id").str() == "asset_plate");  // the layer's library binding kept
  CHECK(reg.at("assets").arr()[0].at("mime").str() == "video/mp4");
  CHECK(reg.at("assets").arr()[0].at("type").str() == "video");

  // Save As bundle from the staging root collects the footage like any bundle's.
  const fs::path out = t.path / "Saved.motion";
  doc::write_bundle(out, o.doc, o.footageRoot);
  CHECK(slurp(out / "blobs" / sha.substr(0, 2) / sha) == "VIDEO-BYTES");
  CHECK(parse(slurp(out / "assets" / "registry.json")).at("assets").arr().size() == 1);
}

TEST_CASE("opening a zip that is not a STORE Premation project is refused", "[bundle]") {
  TempDir t;
  auto refused = [](const fs::path& p, const fs::path& staging) {
    try {
      (void)doc::read_portable(p, staging);
    } catch (const doc::EngineFail& e) {
      return e.error.code == api::ErrorCode::io;
    }
    return false;
  };
  const fs::path junk = t.path / "junk.motion";
  spit(junk, "PK-not-really-a-zip");
  CHECK(refused(junk, t.path / "s1"));
  // A valid zip that holds no project.
  const fs::path other = t.path / "other.zip";
  Json d = sample_doc();
  doc::write_portable(other, d, {});
  std::string bytes = slurp(other);
  const auto at = bytes.find("manifest.json");
  REQUIRE(at != std::string::npos);
  // Rename every "manifest.json" and "scene.json" entry so the zip no longer reads as a project.
  for (std::size_t p = bytes.find("manifest.json"); p != std::string::npos; p = bytes.find("manifest.json", p + 1)) bytes[p] = 'X';
  for (std::size_t p = bytes.find("scene.json"); p != std::string::npos; p = bytes.find("scene.json", p + 1)) bytes[p] = 'X';
  spit(other, bytes);
  CHECK(refused(other, t.path / "s2"));
}

TEST_CASE("a portable .motion repacked with DEFLATE opens like the STORE original", "[bundle]") {
  TempDir t;
  const fs::path src = t.path / "Old.motion";
  spit(src / "blobs" / "01" / kHash, "VIDEO-BYTES");
  spit(src / "assets" / "registry.json",
       std::string(R"({"version":"1.0.0","assets":[{"id":"asset_plate","hash":")") + kHash +
           R"(","name":"plate.mp4","type":"video","mime":"video/mp4","size":11}]})");
  const fs::path store = t.path / "Store.motion";
  doc::write_portable(store, sample_doc(), src);
  const auto entries = unzip_store(slurp(store));
  const fs::path packed = t.path / "Deflate.motion";
  spit(packed, deflate_zip(entries));
  REQUIRE(doc::is_portable_file(packed));

  const doc::PortableOpen a = doc::read_portable(store, t.path / "sa");
  const doc::PortableOpen b = doc::read_portable(packed, t.path / "sb");
  CHECK(b.embedded == a.embedded);
  CHECK(js::stringify(b.doc) == js::stringify(a.doc));
  const std::string sha = doc::sha256_hex("VIDEO-BYTES");
  CHECK(slurp(t.path / "sb" / "blobs" / sha.substr(0, 2) / sha) == "VIDEO-BYTES");

  // A damaged DEFLATE stream is `io`, never a partial document.
  std::string bad = slurp(packed);
  const auto at = bad.find("scene.json");
  REQUIRE(at != std::string::npos);
  for (std::size_t i = at + 10; i < at + 20 && i < bad.size(); ++i) bad[i] = static_cast<char>(~bad[i]);
  const fs::path broken = t.path / "Broken.motion";
  spit(broken, bad);
  bool refused = false;
  try {
    (void)doc::read_portable(broken, t.path / "sc");
  } catch (const doc::EngineFail& e) {
    refused = e.error.code == api::ErrorCode::io;
  }
  CHECK(refused);
}

TEST_CASE("inflate_raw inflates to exactly the declared size", "[bundle]") {
  std::string text;
  for (int i = 0; i < 5000; ++i) text += "premation " + std::to_string(i % 97) + "\n";
  const std::span<const std::uint8_t> raw(reinterpret_cast<const std::uint8_t*>(text.data()), text.size());
  std::vector<std::uint8_t> packed;
  REQUIRE(zlib::deflate_raw(raw, 6, packed));
  CHECK(packed.size() < text.size());
  std::vector<std::uint8_t> out;
  REQUIRE(zlib::inflate_raw(packed, text.size(), out));
  CHECK(std::string(out.begin(), out.end()) == text);
  CHECK_FALSE(zlib::inflate_raw(packed, text.size() - 1, out));  // longer than declared
  CHECK_FALSE(zlib::inflate_raw(packed, text.size() + 1, out));  // shorter than declared
  const std::span<const std::uint8_t> cut(packed.data(), packed.size() / 2);
  CHECK_FALSE(zlib::inflate_raw(cut, text.size(), out));         // truncated
}
