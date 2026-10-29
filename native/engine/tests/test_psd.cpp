// Photoshop reader (core/psd_read.cpp): files written here byte by byte, the
// way Photoshop lays them out, then read back — layers, groups, masks, names,
// the three channel compressions, 16-bit samples and the merged image.

#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "core/deflate.hpp"
#include "core/engine_ctx.hpp"
#include "core/psd_read.hpp"

namespace psd = premation::doc::psd;

namespace {

struct Out {
  std::vector<std::uint8_t> b;
  void u8(int v) { b.push_back(static_cast<std::uint8_t>(v)); }
  void u16(int v) {
    u8((v >> 8) & 0xFF);
    u8(v & 0xFF);
  }
  void u32(std::uint32_t v) {
    for (int s = 24; s >= 0; s -= 8) u8(static_cast<int>((v >> s) & 0xFF));
  }
  void str(const std::string& s) { b.insert(b.end(), s.begin(), s.end()); }
  void bytes(const std::vector<std::uint8_t>& v) { b.insert(b.end(), v.begin(), v.end()); }
};

struct TestLayer {
  std::string name;
  int left = 0, top = 0, w = 0, h = 0;
  int opacity = 255;
  std::string blend = "norm";
  bool hidden = false;
  bool clipped = false;
  int section = 0;
  /// Straight RGBA8; channel data per `compression` (0 raw, 1 RLE, 2 ZIP, 3 ZIP + prediction).
  std::vector<std::uint8_t> rgba;
  int compression = 0;
  /// A user mask over the layer's rectangle (w × h values), when not empty.
  std::vector<std::uint8_t> mask;
  int fill = 255;
};

std::vector<std::uint8_t> plane(const TestLayer& l, int c) {
  std::vector<std::uint8_t> p(static_cast<std::size_t>(l.w * l.h));
  for (std::size_t i = 0; i < p.size(); ++i) p[i] = l.rgba[i * 4 + static_cast<std::size_t>(c)];
  return p;
}

/// PackBits, literal runs only (what a reader must accept; Photoshop also writes repeats).
std::vector<std::uint8_t> packbits_row(const std::uint8_t* row, int n) {
  std::vector<std::uint8_t> out;
  int i = 0;
  while (i < n) {
    // A repeat run when three or more equal bytes follow.
    int run = 1;
    while (i + run < n && run < 128 && row[i + run] == row[i]) ++run;
    if (run >= 3) {
      out.push_back(static_cast<std::uint8_t>(1 - run));
      out.push_back(row[i]);
      i += run;
      continue;
    }
    const int len = std::min(128, n - i);
    out.push_back(static_cast<std::uint8_t>(len - 1));
    out.insert(out.end(), row + i, row + i + len);
    i += len;
  }
  return out;
}

std::vector<std::uint8_t> channel_data(const std::vector<std::uint8_t>& p, int w, int h, int compression) {
  Out o;
  o.u16(compression);
  if (compression == 0) {
    o.bytes(p);
  } else if (compression == 1) {
    std::vector<std::vector<std::uint8_t>> rows;
    for (int y = 0; y < h; ++y) rows.push_back(packbits_row(p.data() + y * w, w));
    for (const auto& r : rows) o.u16(static_cast<int>(r.size()));
    for (const auto& r : rows) o.bytes(r);
  } else {
    std::vector<std::uint8_t> src = p;
    if (compression == 3) {
      for (int y = 0; y < h; ++y) {
        for (int x = w - 1; x > 0; --x) src[static_cast<std::size_t>(y * w + x)] = static_cast<std::uint8_t>(src[static_cast<std::size_t>(y * w + x)] - src[static_cast<std::size_t>(y * w + x - 1)]);
      }
    }
    std::vector<std::uint8_t> z;
    REQUIRE(premation::zlib::zlib_compress(src, 6, z));
    o.bytes(z);
  }
  return o.b;
}

std::vector<std::uint8_t> make_psd(int width, int height, const std::vector<TestLayer>& layers, const std::vector<std::uint8_t>& composite) {
  Out f;
  f.str("8BPS");
  f.u16(1);
  for (int i = 0; i < 6; ++i) f.u8(0);
  f.u16(4);
  f.u32(static_cast<std::uint32_t>(height));
  f.u32(static_cast<std::uint32_t>(width));
  f.u16(8);
  f.u16(3);
  f.u32(0);  // colour mode data
  f.u32(0);  // image resources
  Out li;
  li.u16(static_cast<int>(layers.size()));
  std::vector<std::vector<std::vector<std::uint8_t>>> data;
  for (const TestLayer& l : layers) {
    std::vector<std::pair<int, std::vector<std::uint8_t>>> chans;
    if (l.w > 0 && l.h > 0 && l.section == 0) {
      chans.push_back({-1, channel_data(plane(l, 3), l.w, l.h, l.compression)});
      for (int c = 0; c < 3; ++c) chans.push_back({c, channel_data(plane(l, c), l.w, l.h, l.compression)});
      if (!l.mask.empty()) chans.push_back({-2, channel_data(l.mask, l.w, l.h, 0)});
    } else {
      for (int c = -1; c < 3; ++c) chans.push_back({c, channel_data({}, 0, 0, 0)});
    }
    li.u32(static_cast<std::uint32_t>(l.top));
    li.u32(static_cast<std::uint32_t>(l.left));
    li.u32(static_cast<std::uint32_t>(l.top + l.h));
    li.u32(static_cast<std::uint32_t>(l.left + l.w));
    li.u16(static_cast<int>(chans.size()));
    std::vector<std::vector<std::uint8_t>> ds;
    for (auto& [id, d] : chans) {
      li.u16(id & 0xFFFF);
      li.u32(static_cast<std::uint32_t>(d.size()));
      ds.push_back(d);
    }
    data.push_back(ds);
    li.str("8BIM");
    li.str(l.blend);
    li.u8(l.opacity);
    li.u8(l.clipped ? 1 : 0);
    li.u8(l.hidden ? 0x02 : 0);
    li.u8(0);
    Out extra;
    if (!l.mask.empty()) {
      extra.u32(20);
      extra.u32(static_cast<std::uint32_t>(l.top));
      extra.u32(static_cast<std::uint32_t>(l.left));
      extra.u32(static_cast<std::uint32_t>(l.top + l.h));
      extra.u32(static_cast<std::uint32_t>(l.left + l.w));
      extra.u8(0);
      extra.u8(0);
      extra.u16(0);
    } else {
      extra.u32(0);
    }
    extra.u32(0);  // blending ranges
    // A Pascal name that is not the real one: the luni block wins.
    const std::string ascii = "x";
    extra.u8(static_cast<int>(ascii.size()));
    extra.str(ascii);
    for (std::size_t k = ascii.size() + 1; k % 4 != 0; ++k) extra.u8(0);
    // luni: UTF-16BE.
    Out uni;
    std::vector<std::uint16_t> units;
    for (const char ch : l.name) units.push_back(static_cast<std::uint8_t>(ch));
    uni.u32(static_cast<std::uint32_t>(units.size()));
    for (auto u : units) uni.u16(u);
    if (uni.b.size() % 2 != 0) uni.u8(0);
    extra.str("8BIM");
    extra.str("luni");
    extra.u32(static_cast<std::uint32_t>(uni.b.size()));
    extra.bytes(uni.b);
    if (l.section != 0) {
      extra.str("8BIM");
      extra.str("lsct");
      extra.u32(12);
      extra.u32(static_cast<std::uint32_t>(l.section));
      extra.str("8BIM");
      extra.str(l.blend);
    }
    if (l.fill != 255) {
      extra.str("8BIM");
      extra.str("iOpa");
      extra.u32(4);
      extra.u8(l.fill);
      extra.u8(0);
      extra.u16(0);
    }
    li.u32(static_cast<std::uint32_t>(extra.b.size()));
    li.bytes(extra.b);
  }
  for (const auto& ds : data) {
    for (const auto& d : ds) li.bytes(d);
  }
  if (li.b.size() % 2 != 0) li.u8(0);
  Out lm;
  lm.u32(static_cast<std::uint32_t>(li.b.size()));
  lm.bytes(li.b);
  lm.u32(0);  // global mask info
  f.u32(static_cast<std::uint32_t>(lm.b.size()));
  f.bytes(lm.b);
  // The merged image: raw, R G B A planes.
  f.u16(0);
  for (int c = 0; c < 4; ++c) {
    for (int i = 0; i < width * height; ++i) f.u8(composite[static_cast<std::size_t>(i * 4 + c)]);
  }
  return f.b;
}

std::vector<std::uint8_t> solid(int w, int h, std::uint8_t r, std::uint8_t g, std::uint8_t b, std::uint8_t a = 255) {
  std::vector<std::uint8_t> v(static_cast<std::size_t>(w * h * 4));
  for (int i = 0; i < w * h; ++i) {
    v[static_cast<std::size_t>(i * 4)] = r;
    v[static_cast<std::size_t>(i * 4 + 1)] = g;
    v[static_cast<std::size_t>(i * 4 + 2)] = b;
    v[static_cast<std::size_t>(i * 4 + 3)] = a;
  }
  return v;
}

TestLayer layer(const std::string& name, int left, int top, int w, int h, std::vector<std::uint8_t> rgba, int compression = 0) {
  TestLayer l;
  l.name = name;
  l.left = left;
  l.top = top;
  l.w = w;
  l.h = h;
  l.rgba = std::move(rgba);
  l.compression = compression;
  return l;
}

TestLayer section(const std::string& name, int kind) {
  TestLayer l;
  l.name = name;
  l.section = kind;
  return l;
}

}  // namespace

TEST_CASE("PSD: layers, groups, masks, names and every channel compression", "[psd]") {
  std::vector<TestLayer> ls;
  ls.push_back(layer("Background", 0, 0, 8, 6, solid(8, 6, 10, 20, 30), 1));
  // A gradient-ish layer through ZIP with prediction.
  TestLayer grad = layer("Grad", 2, 1, 4, 3, solid(4, 3, 0, 0, 0), 3);
  grad.opacity = 128;
  grad.blend = "mul ";
  for (int i = 0; i < 12; ++i) grad.rgba[static_cast<std::size_t>(i * 4)] = static_cast<std::uint8_t>(i * 20);
  ls.push_back(grad);
  TestLayer clipLayer = layer("Clip", 2, 1, 2, 2, solid(2, 2, 255, 0, 0), 2);
  clipLayer.clipped = true;
  ls.push_back(clipLayer);
  // A group: divider, child, folder.
  ls.push_back(section("</Layer group>", 3));
  TestLayer masked = layer("Masked", 1, 1, 2, 1, solid(2, 1, 0, 255, 0));
  masked.hidden = true;
  masked.mask = {255, 0};
  ls.push_back(masked);
  TestLayer folderRec = section("Folder", 1);
  folderRec.opacity = 200;
  folderRec.blend = "scrn";
  folderRec.fill = 128;
  ls.push_back(folderRec);
  ls.push_back(layer("Adjust", 0, 0, 0, 0, {}));
  const auto file = make_psd(8, 6, ls, solid(8, 6, 1, 2, 3, 255));

  std::string error;
  const auto doc = psd::read(file, true, error);
  INFO(error);
  REQUIRE(doc);
  CHECK(doc->width == 8);
  CHECK(doc->height == 6);
  REQUIRE(doc->layers.size() == 4);
  CHECK(doc->skipped == 1);

  const psd::Layer& bg = doc->layers[0];
  CHECK(bg.name == "Background");
  CHECK(bg.rgba == solid(8, 6, 10, 20, 30));

  const psd::Layer& g = doc->layers[1];
  CHECK(g.name == "Grad");
  CHECK(g.opacity == 128);
  CHECK(psd::blend_mode_of(g.blend) == "multiply");
  CHECK(g.left == 2);
  CHECK(g.top == 1);
  CHECK(g.rgba == grad.rgba);

  const psd::Layer& clip = doc->layers[2];
  CHECK(clip.clipped);
  CHECK(clip.rgba == solid(2, 2, 255, 0, 0));

  const psd::Layer& folder = doc->layers[3];
  CHECK(folder.isGroup);
  CHECK(folder.name == "Folder");
  CHECK(folder.opacity == (200 * 128 + 127) / 255);
  CHECK(psd::blend_mode_of(folder.blend) == "screen");
  REQUIRE(folder.children.size() == 1);
  const psd::Layer& m = folder.children[0];
  CHECK(m.name == "Masked");
  CHECK_FALSE(m.visible);
  CHECK(m.rgba[3] == 255);
  CHECK(m.rgba[7] == 0);  // the mask's black pixel

  CHECK(doc->composite == solid(8, 6, 1, 2, 3, 255));
}

TEST_CASE("PSD: the merged image alone, a PNG of it, and what is refused", "[psd]") {
  const auto file = make_psd(3, 2, {layer("L", 0, 0, 3, 2, solid(3, 2, 9, 9, 9))}, solid(3, 2, 200, 100, 50, 255));
  std::string error;
  const auto doc = psd::read(file, false, error);
  REQUIRE(doc);
  CHECK(doc->layers.empty());
  CHECK(doc->composite == solid(3, 2, 200, 100, 50, 255));
  std::vector<std::uint8_t> png;
  REQUIRE(psd::encode_png(doc->composite, 3, 2, png));
  CHECK(png.size() > 40);
  CHECK(png[1] == 'P');

  auto lab = file;
  lab[25] = 9;  // colour mode Lab
  CHECK_FALSE(psd::read(lab, true, error));
  CHECK(error.find("Lab") != std::string::npos);
  std::vector<std::uint8_t> cut(file.begin(), file.begin() + 40);
  CHECK_FALSE(psd::read(cut, true, error));
  CHECK_FALSE(psd::read(std::vector<std::uint8_t>{'n', 'o', 'p', 'e'}, true, error));
}

TEST_CASE("PSD footage through the file ports: the merged image as a PNG, the .psd as the item's path", "[psd]") {
  namespace doc = premation::doc;
  const auto dir = std::filesystem::temp_directory_path() / "premation-psd-ports";
  std::filesystem::remove_all(dir);
  std::filesystem::create_directories(dir);
  const auto psdPath = dir / "Flat.psd";
  {
    const auto bytes = make_psd(4, 2, {layer("L", 0, 0, 4, 2, solid(4, 2, 9, 9, 9))}, solid(4, 2, 10, 200, 30, 255));
    std::ofstream(psdPath, std::ios::binary).write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
  }
  std::string probed;
  doc::FilePorts ports([&](const std::string& path, doc::Json& facts, std::string&) {
    probed = path;
    facts.set("type", doc::Json::string("image"));
    return true;
  });
  ports.set_footage_dir((dir / "cache").generic_string());
  premation::api::ImportFile f;
  f.path = psdPath.generic_string();
  const doc::Json rec = ports.import_file(f, "item_1");
  CHECK(rec.at("name").str() == "Flat.psd");
  CHECK(rec.at("path").str() == psdPath.generic_string());
  CHECK(rec.at("type").str() == "image");
  // The decoders read the cached PNG, not the .psd.
  REQUIRE(probed.ends_with(".png"));
  std::vector<char> head(8);
  {
    std::ifstream png(std::filesystem::path(probed), std::ios::binary);
    png.read(head.data(), 8);
  }
  CHECK(head[1] == 'P');
  std::error_code ec;
  std::filesystem::remove_all(dir, ec);
}
