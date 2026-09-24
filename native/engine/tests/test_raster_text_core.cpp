// E3 text, Skia-free half, against the TS: line breaking + Intl word joins
// (tests/data/line_break_parity.json, src/core/text/lineBreakCrossEngine.test.ts),
// vertical optical kerning (optical_kerning_parity.json,
// src/core/text/opticalKerningCrossEngine.test.ts) and fontconfig lookups.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

#include "raster/json.hpp"
#include "raster/line_break.hpp"
#include "raster/optical_math.hpp"
#include "raster/system_fonts.hpp"
#include "raster/text_unicode.hpp"
#include "jsmath.hpp"

using namespace premation::raster;

namespace {

json::Value load_fixture(const char* name) {
  std::ifstream in(std::string(PREMATION_ENGINE_TEST_DATA) + "/" + name, std::ios::binary);
  std::stringstream ss;
  ss << in.rdbuf();
  json::Value v;
  std::string err;
  REQUIRE(json::parse(ss.str(), v, err));
  return v;
}

std::vector<std::string> strings(const json::Value& a) {
  std::vector<std::string> out;
  for (const auto& s : a.items()) out.push_back(s.str());
  return out;
}

std::vector<std::size_t> indices(const json::Value& a) {
  std::vector<std::size_t> out;
  for (const auto& s : a.items()) out.push_back(static_cast<std::size_t>(s.num()));
  return out;
}

std::vector<std::size_t> true_indices(const std::vector<bool>& b) {
  std::vector<std::size_t> out;
  for (std::size_t i = 0; i < b.size(); ++i) {
    if (b[i]) out.push_back(i);
  }
  return out;
}

std::u16string utf16_of(const std::vector<std::string>& units) {
  std::u16string out;
  for (const auto& u : units) {
    for (const char32_t cp : code_points(u)) {
      if (cp < 0x10000) {
        out.push_back(static_cast<char16_t>(cp));
      } else {
        out.push_back(static_cast<char16_t>(0xD800 + ((cp - 0x10000) >> 10)));
        out.push_back(static_cast<char16_t>(0xDC00 + ((cp - 0x10000) & 0x3FF)));
      }
    }
  }
  return out;
}

}  // namespace

TEST_CASE("line breaks: lineBreak.ts parity without Intl.Segmenter", "[raster][linebreak]") {
  const auto fx = load_fixture("line_break_parity.json");
  set_word_segmenter_disabled_for_test(true);
  for (const auto& row : fx["rows"].items()) {
    INFO(row["text"].str());
    CHECK(true_indices(break_opportunities(strings(row["units"]))) == indices(row["withoutSegmenter"]));
  }
  set_word_segmenter_disabled_for_test(false);
}

TEST_CASE("line breaks: Intl.Segmenter word joins through ICU", "[raster][linebreak][icu]") {
  const auto fx = load_fixture("line_break_parity.json");
  const std::string info = word_segmenter_info();
  if (info.empty()) SKIP("no ICU on this machine: the engine takes lineBreak.ts's no-Segmenter branch");
  std::printf("word segmenter: %s; fixture written with Node ICU %s\n", info.c_str(), fx["icu"].str().c_str());
  int rows = 0;
  int segmentRowsExact = 0;
  int breakRowsExact = 0;
  int wrapRowsExact = 0;
  for (const auto& row : fx["rows"].items()) {
    INFO(row["text"].str());
    const auto units = strings(row["units"]);
    ++rows;
    const auto segs = word_segments(utf16_of(units));
    REQUIRE(segs);
    std::vector<std::pair<std::size_t, bool>> got;
    for (const auto& s : *segs) got.emplace_back(s.index, s.wordLike);
    std::vector<std::pair<std::size_t, bool>> want;
    for (const auto& s : row["segments"].items()) want.emplace_back(static_cast<std::size_t>(s[0].num()), s[1].truthy());
    // Raw segments may differ across ICU versions (Node's vs the OS's) where
    // the joins do not: reported, not required.
    if (got == want) ++segmentRowsExact;
    else std::printf("  segments differ (ICU version): %s\n", row["text"].str().c_str());
    const auto breaks = true_indices(break_opportunities(units));
    if (breaks == indices(row["withSegmenter"])) ++breakRowsExact;
    CHECK(breaks == indices(row["withSegmenter"]));
    std::vector<double> lengths;
    for (const auto& l : row["wrap"]["lengths"].items()) lengths.push_back(l.num());
    const auto starts = wrap_units(units, lengths, row["wrap"]["limit"].num());
    if (starts == indices(row["wrap"]["starts"])) ++wrapRowsExact;
    CHECK(starts == indices(row["wrap"]["starts"]));
  }
  std::printf("line breaks vs lineBreak.ts: segments %d/%d rows, break opportunities %d/%d, wraps %d/%d\n", segmentRowsExact,
              rows, breakRowsExact, rows, wrapRowsExact, rows);
}

TEST_CASE("line breaks: kinsoku and the greedy wrap", "[raster][linebreak]") {
  const std::vector<std::string> units = split_graphemes("日本語、「引用」です");
  const auto ops = break_opportunities(units);
  // No break before 、 or 」, none after 「.
  CHECK_FALSE(ops[3]);
  CHECK_FALSE(ops[5]);
  CHECK_FALSE(ops[7]);
  CHECK(ops[1]);
  CHECK(is_ideographic_unit("日"));
  CHECK_FALSE(is_ideographic_unit("a"));
  CHECK(vertical_orientation_of(U'a') == 'R');
}

// ── system fonts (system_fonts_ffi.cpp, fontconfig) ──────────────────────────

TEST_CASE("system fonts: Chromium's family acceptance rules", "[raster][fonts]") {
  CHECK(is_metric_compatible_replacement("Arial", "liberation sans"));
  CHECK(is_metric_compatible_replacement("Times New Roman", "Tinos"));
  CHECK(is_metric_compatible_replacement("MS Gothic", "IPAGothic"));
  CHECK_FALSE(is_metric_compatible_replacement("Arial", "Liberation Serif"));
  CHECK_FALSE(is_metric_compatible_replacement("Verdana", "DejaVu Sans"));
  // "Noto Serif CJK JP" belongs to the first group that lists it (MS PMincho), as in Skia.
  CHECK(is_metric_compatible_replacement("MS PMincho", "Noto Serif CJK JP"));
  CHECK_FALSE(is_metric_compatible_replacement("MS Mincho", "Noto Serif CJK JP"));
  CHECK(linux_generic_family("sans-serif") == "Arial");
  CHECK(linux_generic_family("SERIF") == "Times New Roman");
  CHECK(linux_generic_family("system-ui") == "sans");
  CHECK(linux_generic_family("Inter") == "Inter");
  CHECK(blink_alternate_family("helvetica") == "Arial");
  CHECK(blink_alternate_family("Courier") == "Courier New");
  CHECK(blink_alternate_family("Inter").empty());
}

TEST_CASE("system fonts: fontconfig lookups on this machine", "[raster][fonts][fontconfig]") {
  if (!system_fonts_available()) SKIP("built without fontconfig");
  // Never accepted: a family nobody has installed (fontconfig would happily
  // hand back its default sans; Chromium moves on to the next family).
  CHECK_FALSE(resolve_system_family("Premation Nonexistent Family"));
  // A generic "sans" resolves to something whenever any font is installed.
  const auto sans = resolve_system_family("system-ui");
  if (!sans) SKIP("no scalable fonts installed");
  std::printf("system-ui -> %s\n", sans->c_str());
  const auto faces = list_system_faces(*sans);
  REQUIRE_FALSE(faces.empty());
  for (const auto& f : faces) {
    CHECK_FALSE(f.file.empty());
    CHECK(f.weight >= 1);
    CHECK(f.weight <= 1000);
  }
  // Where the metric-compatible Liberation fonts are installed (most Linux
  // desktops, and this image), Chromium draws Arial / Helvetica / sans-serif
  // with Liberation Sans (measured with Chromium 141).
  if (match_system_family("Liberation Sans")) {
    CHECK(resolve_system_family("Arial") == std::optional<std::string>("Liberation Sans"));
    CHECK(resolve_system_family("sans-serif") == std::optional<std::string>("Liberation Sans"));
    CHECK(resolve_system_family("Helvetica") == std::optional<std::string>("Liberation Sans"));
  }
}

// ── vertical optical kerning (optical_math.cpp) vs opticalKerning.ts ──────────

namespace {

/// opticalKerningCrossEngine.test.ts renderRects: exact-coverage rectangles.
std::vector<std::uint8_t> render_rects(const json::Value& rects, std::uint32_t w, std::uint32_t h) {
  std::vector<std::uint8_t> out(static_cast<std::size_t>(w) * h * 4, 0);
  for (std::uint32_t y = 0; y < h; ++y) {
    for (std::uint32_t x = 0; x < w; ++x) {
      double a = 0;
      for (const auto& r : rects.items()) {
        const double ox = std::max(0.0, std::min(r[2].num(), x + 1.0) - std::max(r[0].num(), static_cast<double>(x)));
        const double oy = std::max(0.0, std::min(r[3].num(), y + 1.0) - std::max(r[1].num(), static_cast<double>(y)));
        a += motion::js::round(255 * ox * oy);
      }
      out[(static_cast<std::size_t>(y) * w + x) * 4 + 3] = static_cast<std::uint8_t>(std::min(255.0, a));
    }
  }
  return out;
}

bool same_number(double got, const json::Value& want) {
  if (want.is_null()) return std::isnan(got);
  return got == want.num();
}

bool same_profile(const optical::InkProfile& p, const json::Value& want) {
  if (!same_number(p.advance, want["advance"]) || !same_number(p.top, want["top"])) return false;
  for (std::size_t i = 0; i < p.left.size(); ++i) {
    if (!same_number(p.left[i], want["left"][i]) || !same_number(p.right[i], want["right"][i])) return false;
  }
  return true;
}

}  // namespace

TEST_CASE("optical kerning: vertical pairs match opticalKernVerticalPx exactly", "[raster][optical]") {
  const auto fx = load_fixture("optical_kerning_parity.json");
  constexpr std::uint32_t kSide = 256;
  const double em0 = kSide / 2.0 - optical::kRefEmPx / 2;
  const auto raster = [&](const std::string& css, const std::string& cluster) -> std::optional<optical::InkProfile> {
    const auto& rects = fx["rects"][css][cluster];
    if (!rects.is_array()) return std::nullopt;
    return optical::vertical_profile_from_alpha(render_rects(rects, kSide, kSide), kSide, kSide, em0, em0, optical::kRefEmPx);
  };

  int profilesExact = 0;
  for (const auto& key : fx["profiles"].keys()) {
    const auto bar = key.find('|');
    const auto p = raster(key.substr(0, bar), key.substr(bar + 1));
    REQUIRE(p);
    INFO(key);
    const bool same = same_profile(*p, fx["profiles"][key]);
    CHECK(same);
    profilesExact += same ? 1 : 0;
  }

  const auto horizontal = optical::profile_from_alpha(render_rects(fx["rects"]["128px FaceA"]["\xE3\x81\x82"], kSide, kSide), kSide,
                                                      kSide, 80, 170, optical::kRefEmPx, 90);
  CHECK(same_profile(horizontal, fx["horizontal"]));

  const auto pa = raster("128px FaceA", "\xE3\x81\x82");  // あ
  const auto pb = raster("128px FaceB", "\xE3\x80\x8C");  // 「
  REQUIRE(pa);
  REQUIRE(pb);
  for (const auto& g : fx["gaps"].items()) {
    const auto gap = optical::measure_pair_gap(*pa, g["sizeA"].num(), *pb, g["sizeB"].num(), g["xHeight"].num());
    REQUIRE(gap.has_value() == g["gap"].is_object());
    if (!gap) continue;
    CHECK(gap->area == g["gap"]["area"].num());
    CHECK(gap->dmin == g["gap"]["dmin"].num());
    CHECK(optical::pair_adjustment(*gap, 0.1, 1) == g["adj"][0].num());
    CHECK(optical::pair_adjustment(*gap, 0.3, 0.8) == g["adj"][1].num());
  }

  optical::VerticalKerner kerner(raster);
  int pairsExact = 0;
  int kerned = 0;
  for (const auto& p : fx["pairs"].items()) {
    const double got = kerner.kern_px(p[0].str(), p[1].str(), p[2].num(), p[3].str(), p[4].str(), p[5].num());
    INFO(p[1].str() << " / " << p[4].str());
    CHECK(got == p[6].num());
    pairsExact += got == p[6].num() ? 1 : 0;
    kerned += p[6].num() < 0 ? 1 : 0;
  }
  for (const auto& c : fx["proportional"].items()) {
    std::string s;
    append_utf8(s, static_cast<char32_t>(c[0].num()));
    CHECK(optical::is_proportional_cjk(s) == c[1].truthy());
  }
  std::printf("vertical optical kerning vs opticalKerning.ts: profiles %d/%zu, pairs %d/%zu exact (%d kerned)\n", profilesExact,
              fx["profiles"].size(), pairsExact, fx["pairs"].size(), kerned);
}
