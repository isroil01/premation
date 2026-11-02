// A layer's subjects united with their live edge (scene/subject_matte.hpp), the
// stored frames indexed (core/subjects.hpp SubjectIndex) and the stored files'
// collection rules (core/subject_files.hpp) — stream B of the subject program.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>
#include <unordered_set>
#include <vector>

#include "json.hpp"
#include "subject_files.hpp"
#include "subject_matte.hpp"
#include "subjects.hpp"

using namespace premation::scene::subject_matte;
using premation::doc::Json;

namespace {

/// A w × h premultiplied RGBA8 picture, opaque white inside [x0, x1) × [y0, y1) (a legacy cut-out).
std::vector<std::uint8_t> square(std::uint32_t w, std::uint32_t h, std::uint32_t x0, std::uint32_t y0, std::uint32_t x1, std::uint32_t y1) {
  std::vector<std::uint8_t> px(static_cast<std::size_t>(w) * h * 4, 0);
  for (std::uint32_t y = y0; y < y1; ++y)
    for (std::uint32_t x = x0; x < x1; ++x)
      for (std::size_t c = 0; c < 4; ++c) px[(static_cast<std::size_t>(y) * w + x) * 4 + c] = 255;
  return px;
}

/// The same as an alpha plane (what a stream-B1 file decodes to).
std::vector<std::uint8_t> plane(std::uint32_t w, std::uint32_t h, std::uint32_t x0, std::uint32_t y0, std::uint32_t x1, std::uint32_t y1) {
  std::vector<std::uint8_t> a(static_cast<std::size_t>(w) * h, 0);
  for (std::uint32_t y = y0; y < y1; ++y)
    for (std::uint32_t x = x0; x < x1; ++x) a[static_cast<std::size_t>(y) * w + x] = 255;
  return a;
}

std::uint8_t alpha_at(const std::vector<std::uint8_t>& px, std::uint32_t w, std::uint32_t x, std::uint32_t y) {
  return px[(static_cast<std::size_t>(y) * w + x) * 4 + 3];
}

Picture rgba_picture(std::uint32_t w, std::uint32_t h, const std::vector<std::uint8_t>& rgba) {
  Picture p;
  p.width = w;
  p.height = h;
  p.rgba = rgba;
  return p;
}

Picture alpha_picture(std::uint32_t w, std::uint32_t h, const std::vector<std::uint8_t>& a) {
  Picture p;
  p.width = w;
  p.height = h;
  p.alpha = a;
  return p;
}

/// One stored frame record {t, src[, s]}.
Json frame(double t, const std::string& src, const std::string& subject = {}) {
  Json f = Json::object();
  f.set("t", Json::number(t));
  f.set("src", Json::string(src));
  if (!subject.empty()) f.set("s", Json::string(subject));
  return f;
}

std::filesystem::path temp_file(const char* name) {
  return std::filesystem::temp_directory_path() / (std::string("premation-subject-test-") + name);
}

void write_bytes(const std::filesystem::path& p, const std::vector<std::uint8_t>& bytes) {
  std::ofstream f(p, std::ios::binary | std::ios::trunc);
  f.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
}

/// A PNG's first 26 bytes (signature, IHDR length + type, 1×1, bit depth 8, the colour type).
std::vector<std::uint8_t> png_head(std::uint8_t colourType) {
  std::vector<std::uint8_t> b = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n', 0, 0, 0, 13, 'I', 'H', 'D', 'R', 0, 0, 0, 1, 0, 0, 0, 1, 8, colourType, 0, 0, 0};
  return b;
}

}  // namespace

TEST_CASE("choke shrinks and grows a subject by whole pixels", "[subject]") {
  std::vector<float> a(20 * 20, 0.0f);
  for (std::uint32_t y = 5; y < 15; ++y)
    for (std::uint32_t x = 5; x < 15; ++x) a[y * 20 + x] = 1.0f;
  std::vector<float> shrunk = a;
  refine_alpha(shrunk, 20, 20, 0, 2, 0, false);
  CHECK(shrunk[10 * 20 + 6] == 0.0f);   // 1 px inside the edge: gone
  CHECK(shrunk[10 * 20 + 7] == 1.0f);   // 2 px inside: kept
  std::vector<float> grown = a;
  refine_alpha(grown, 20, 20, 0, -2, 0, false);
  CHECK(grown[10 * 20 + 3] == 1.0f);    // 2 px outside: covered
  CHECK(grown[10 * 20 + 2] == 0.0f);
}

TEST_CASE("a subject touching the frame's edge keeps it when choked", "[subject]") {
  std::vector<float> a(10 * 10, 0.0f);
  for (std::uint32_t y = 0; y < 10; ++y)
    for (std::uint32_t x = 0; x < 5; ++x) a[y * 10 + x] = 1.0f;
  refine_alpha(a, 10, 10, 0, 2, 0, false);
  CHECK(a[5 * 10 + 0] == 1.0f);
  CHECK(a[5 * 10 + 2] == 1.0f);
  CHECK(a[5 * 10 + 3] == 0.0f);
}

TEST_CASE("feather softens the edge, contrast steepens it, invert flips it", "[subject]") {
  std::vector<float> a(40, 0.0f);
  for (std::size_t i = 20; i < 40; ++i) a[i] = 1.0f;
  std::vector<float> soft = a;
  refine_alpha(soft, 40, 1, 6, 0, 0, false);
  CHECK(soft[19] > 0.2f);
  CHECK(soft[19] < 0.5f);
  CHECK(soft[20] > 0.5f);
  std::vector<float> steep = soft;
  refine_alpha(steep, 40, 1, 0, 0, 0.8, false);
  CHECK(steep[17] < soft[17]);
  CHECK(steep[22] > soft[22]);
  std::vector<float> inv = a;
  refine_alpha(inv, 40, 1, 0, 0, 0, true);
  CHECK(inv[0] == 1.0f);
  CHECK(inv[39] == 0.0f);
}

TEST_CASE("the edge plan: a choke in windows of 32, a feather as Gaussians whose variances add up", "[subject][b3]") {
  CHECK(edge_plan(0, 0).empty());
  CHECK(edge_plan(0.1, 0.2).empty());  // below a texel: nothing to do
  const std::vector<EdgePass> choke = edge_plan(0, 70);
  REQUIRE(choke.size() == 3);
  double radius = 0;
  for (const EdgePass& p : choke) {
    CHECK(p.kind == EdgePass::Kind::erode);
    CHECK(p.amount <= kMaxMorphRadius);
    radius += p.amount;
  }
  CHECK(radius == 70.0);
  CHECK(edge_plan(0, -3).front().kind == EdgePass::Kind::dilate);
  // Feather 100 px: sigma 50 → 10 passes of sigma 50/√10, variances summing to 2500.
  const std::vector<EdgePass> feather = edge_plan(100, 0);
  REQUIRE(feather.size() == 10);
  double variance = 0;
  for (const EdgePass& p : feather) {
    CHECK(p.kind == EdgePass::Kind::gauss);
    CHECK(p.amount <= kMaxGaussSigma);
    variance += p.amount * p.amount;
  }
  CHECK(std::abs(variance - 2500) < 1e-6);
  // Both: the choke first (the GPU and CPU paths run the plan in this order).
  const std::vector<EdgePass> both = edge_plan(10, 5);
  REQUIRE(both.size() == 2);
  CHECK(both[0].kind == EdgePass::Kind::erode);
  CHECK(both[1].kind == EdgePass::Kind::gauss);
}

TEST_CASE("a chunked feather matches one Gaussian of the full sigma", "[subject][b3]") {
  // Sigma 20 is two passes of sigma 20/√2 (edge_plan); against a direct kernel of sigma 20 the
  // step's ramp agrees to a percent — what the GPU passes (the same plan) produce too.
  constexpr std::uint32_t n = 256;
  std::vector<float> a(n, 0.0f);
  for (std::size_t i = n / 2; i < n; ++i) a[i] = 1.0f;
  std::vector<float> chunked = a;
  refine_alpha(chunked, n, 1, 40, 0, 0, false);
  REQUIRE(edge_plan(40, 0).size() == 2);
  const double sigma = 20;
  const auto r = static_cast<std::ptrdiff_t>(std::ceil(3 * sigma));
  for (std::size_t x = 0; x < n; x += 7) {
    double acc = 0;
    double wsum = 0;
    for (std::ptrdiff_t k = -r; k <= r; ++k) {
      const auto i = std::clamp<std::ptrdiff_t>(static_cast<std::ptrdiff_t>(x) + k, 0, static_cast<std::ptrdiff_t>(n) - 1);
      const double w = std::exp(-static_cast<double>(k * k) / (2 * sigma * sigma));
      acc += w * a[static_cast<std::size_t>(i)];
      wsum += w;
    }
    CHECK(std::abs(chunked[x] - acc / wsum) < 0.01);
  }
}

TEST_CASE("subjects unite as coverage in every channel, a hidden one covers nothing", "[subject]") {
  const std::vector<std::uint8_t> left = square(16, 8, 0, 0, 6, 8);
  const std::vector<std::uint8_t> right = square(16, 8, 10, 0, 16, 8);
  std::vector<Part> parts(2);
  parts[0].frame = rgba_picture(16, 8, left);
  parts[1].frame = rgba_picture(16, 8, right);
  std::uint32_t w = 0;
  std::uint32_t h = 0;
  std::vector<std::uint8_t> both = combine(parts, w, h);
  REQUIRE(w == 16);
  REQUIRE(h == 8);
  CHECK(alpha_at(both, w, 2, 4) == 255);
  CHECK(alpha_at(both, w, 12, 4) == 255);
  CHECK(alpha_at(both, w, 8, 4) == 0);
  // Stream B1: (a, a, a, a) — luminance readers and alpha readers agree.
  CHECK(both[(4 * 16 + 2) * 4] == 255);
  CHECK(both[(4 * 16 + 8) * 4] == 0);
  parts[1].hidden = true;
  std::vector<std::uint8_t> one = combine(parts, w, h);
  CHECK(alpha_at(one, w, 2, 4) == 255);
  CHECK(alpha_at(one, w, 12, 4) == 0);
  parts[0].hidden = true;
  std::vector<std::uint8_t> none = combine(parts, w, h);
  REQUIRE(none.size() == static_cast<std::size_t>(16) * 8 * 4);
  CHECK(alpha_at(none, w, 2, 4) == 0);
}

TEST_CASE("a legacy RGBA cut-out and a stored alpha plane read the same", "[subject][b1]") {
  const std::vector<std::uint8_t> legacy = square(12, 6, 3, 0, 9, 6);
  const std::vector<std::uint8_t> stored = plane(12, 6, 3, 0, 9, 6);
  std::vector<Part> a(1);
  a[0].frame = rgba_picture(12, 6, legacy);
  a[0].feather = 4;
  std::vector<Part> b(1);
  b[0].frame = alpha_picture(12, 6, stored);
  b[0].feather = 4;
  std::uint32_t w = 0;
  std::uint32_t h = 0;
  const std::vector<std::uint8_t> fromLegacy = combine(a, w, h);
  const std::vector<std::uint8_t> fromPlane = combine(b, w, h);
  REQUIRE(fromLegacy.size() == fromPlane.size());
  CHECK(fromLegacy == fromPlane);
  // Feather 4 px is sigma 2; the square is 6 px wide, so its centre sits 3 px from each edge and
  // a Gaussian of sigma 2 integrated over ±3 px is ≈ 0.87 — the centre softens to ≈ 222, not 255.
  CHECK(alpha_at(fromPlane, w, 6, 3) > 200);
  CHECK(alpha_at(fromPlane, w, 6, 3) < 240);
  CHECK(alpha_at(fromPlane, w, 0, 3) < 64);
  // Unfeathered, the plane reads back exactly.
  b[0].feather = 0;
  const std::vector<std::uint8_t> exact = combine(b, w, h);
  CHECK(alpha_at(exact, w, 6, 3) == 255);
  CHECK(alpha_at(exact, w, 0, 3) == 0);
}

TEST_CASE("alpha_plane takes a grey file's value and a cut-out's alpha", "[subject][b1]") {
  const std::vector<std::uint8_t> rgba = {200, 200, 200, 255, 10, 20, 30, 40};  // 2 × 1
  const std::vector<std::uint8_t> grey = alpha_plane(rgba, 2, 1, true);
  const std::vector<std::uint8_t> cut = alpha_plane(rgba, 2, 1, false);
  REQUIRE(grey.size() == 2);
  CHECK(grey[0] == 200);
  CHECK(grey[1] == 10);
  CHECK(cut[0] == 255);
  CHECK(cut[1] == 40);
}

TEST_CASE("png_is_gray reads the colour type off the header", "[subject][b1]") {
  const std::filesystem::path grey = temp_file("grey.png");
  const std::filesystem::path rgba = temp_file("rgba.png");
  const std::filesystem::path text = temp_file("note.txt");
  write_bytes(grey, png_head(0));
  write_bytes(rgba, png_head(6));
  write_bytes(text, {'h', 'e', 'l', 'l', 'o'});
  CHECK(png_is_gray(grey));
  CHECK_FALSE(png_is_gray(rgba));
  CHECK_FALSE(png_is_gray(text));
  CHECK_FALSE(png_is_gray(temp_file("missing.png")));
  std::error_code ec;
  std::filesystem::remove(grey, ec);
  std::filesystem::remove(rgba, ec);
  std::filesystem::remove(text, ec);
}

TEST_CASE("temporal smooth mixes in the neighbouring frames", "[subject]") {
  const std::vector<std::uint8_t> now = plane(8, 1, 0, 0, 4, 1);
  const std::vector<std::uint8_t> next = plane(8, 1, 0, 0, 6, 1);
  std::vector<Part> parts(1);
  parts[0].frame = alpha_picture(8, 1, now);
  parts[0].blend.emplace_back(alpha_picture(8, 1, next), 0.5);
  std::uint32_t w = 0;
  std::uint32_t h = 0;
  const std::vector<std::uint8_t> out = combine(parts, w, h);
  CHECK(alpha_at(out, w, 2, 0) == 255);
  CHECK(alpha_at(out, w, 4, 0) >= 127);
  CHECK(alpha_at(out, w, 4, 0) <= 128);
  CHECK(alpha_at(out, w, 7, 0) == 0);
}

TEST_CASE("the subject index finds the nearest frame by binary search, as the scan did", "[subject][b3]") {
  using premation::doc::SubjectIndex;
  Json am = Json::object();
  Json frames = Json::array();
  // Out of order on purpose, two subjects, a frame without a src (skipped).
  for (const double t : {0.5, 0.1, 0.3, 0.2, 0.4}) frames.arr_mut().push_back(frame(t, "a_" + std::to_string(t)));
  for (const double t : {2.0, 1.0}) frames.arr_mut().push_back(frame(t, "b_" + std::to_string(t), "s2"));
  Json bad = Json::object();
  bad.set("t", Json::number(0.35));
  frames.arr_mut().push_back(std::move(bad));
  am.set("frames", std::move(frames));
  const SubjectIndex idx(am, Json(), 10);
  REQUIRE(idx.subjects().size() == 2);
  const SubjectIndex::Subject* s1 = idx.subject("s1");
  REQUIRE(s1 != nullptr);
  REQUIRE(s1->frames.size() == 5);
  CHECK(s1->frames.front().t == 0.1);
  CHECK(s1->frames.back().t == 0.5);
  for (const double t : {-1.0, 0.0, 0.14, 0.15, 0.16, 0.26, 0.44, 0.49, 0.5, 9.0}) {
    const std::size_t at = SubjectIndex::nearest(*s1, t);
    REQUIRE(at != SubjectIndex::npos);
    const Json* linear = premation::doc::nearest_subject_frame(am, "s1", t);
    REQUIRE(linear != nullptr);
    CHECK(s1->frames[at].json->at("src").str() == linear->at("src").str());
  }
  // A tracked subject (five frames 0.1 s apart at 10 fps) is away past a frame either side.
  CHECK(s1->tracked);
  CHECK_FALSE(SubjectIndex::away(*s1, 0.3, 10));
  CHECK_FALSE(SubjectIndex::away(*s1, 0.05, 10));
  CHECK(SubjectIndex::away(*s1, 0.7, 10));
  CHECK(SubjectIndex::away(*s1, -0.1, 10));
  // Two frames a second apart: not tracked, holds everywhere.
  const SubjectIndex::Subject* s2 = idx.subject("s2");
  REQUIRE(s2 != nullptr);
  CHECK_FALSE(s2->tracked);
  CHECK_FALSE(SubjectIndex::away(*s2, 50, 10));
  CHECK(SubjectIndex::nearest(*s2, 1.4) == 0);
  CHECK(SubjectIndex::nearest(*s2, 1.6) == 1);
  CHECK(idx.built_from(am, 10));
  CHECK_FALSE(idx.built_from(am, 30));
  SubjectIndex::Subject empty;
  CHECK(SubjectIndex::nearest(empty, 0) == SubjectIndex::npos);
}

TEST_CASE("the GC takes only stored-matte names nothing references, whatever the path's spelling", "[subject][b2]") {
  using namespace premation::doc;
  CHECK(is_stored_matte_name("matte_000012_kx3f9.png"));
  CHECK(is_stored_matte_name("matte_000012.png"));  // a file from before run ids
  CHECK(is_stored_matte_name("subject_000012_1762000000.png"));
  CHECK(is_stored_matte_name("matte_000012_kx3f9.png.tmp"));
  CHECK_FALSE(is_stored_matte_name("notes.txt"));
  CHECK_FALSE(is_stored_matte_name("footage.png"));
  const std::filesystem::path folder = std::filesystem::path("C:/Projects/Film/Object Matte/layer_1");
  const std::filesystem::path kept = folder / "matte_000001_abc.png";
  const std::filesystem::path undone = folder / "matte_000001_aaa.png";
  const std::filesystem::path stale = folder / "matte_000002_aaa.png";
  const std::filesystem::path other = folder / "readme.txt";
  std::unordered_set<std::string> referenced;
  // The document names one as a plain path, the undo stack one as a file URL with an escaped space.
  referenced.insert(matte_file_key(std::string_view("C:\\Projects\\Film\\Object Matte\\layer_1\\matte_000001_abc.png")));
  referenced.insert(matte_file_key(std::string_view("file:///C:/Projects/Film/Object%20Matte/layer_1/matte_000001_aaa.png")));
  const std::array<std::filesystem::path, 4> onDisk = {kept, undone, stale, other};
  const std::vector<std::filesystem::path> doomed = matte_files_to_delete(onDisk, referenced);
  REQUIRE(doomed.size() == 1);
  CHECK(doomed.front() == stale);
  // A `local-file://` URL (the desktop app's) keys the same as the path.
  CHECK(matte_file_key(std::string_view("local-file:///C:/Projects/Film/Object%20Matte/x.png")) == matte_file_key(std::filesystem::path("C:/Projects/Film/Object Matte/x.png")));
  CHECK(object_matte_folder("C:/Projects/Film/film.premation") == std::filesystem::path("C:/Projects/Film") / "Object Matte");
  CHECK(object_matte_folder("").empty());
}
