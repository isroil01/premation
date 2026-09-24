// E3 text, Skia-free half: line breaking + Intl word joins against lineBreak.ts
// (tests/data/line_break_parity.json, written by
// src/core/text/lineBreakCrossEngine.test.ts).
#include <catch2/catch_test_macros.hpp>

#include <cstdio>
#include <fstream>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

#include "raster/json.hpp"
#include "raster/line_break.hpp"
#include "raster/system_fonts.hpp"
#include "raster/text_unicode.hpp"

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
