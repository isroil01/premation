// E3 text, Skia-free half, against the TS: line breaking + Intl word joins
// (tests/data/line_break_parity.json, frozen from the TypeScript engine's
// lineBreakCrossEngine.test.ts), vertical optical kerning
// (optical_kerning_parity.json, frozen from the TypeScript engine's
// opticalKerningCrossEngine.test.ts) and fontconfig lookups. For both fixtures
// PARITY_REBLESS=1 writes the C++ answers instead (parity_rebless.hpp).
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <optional>
#include <string>
#include <vector>

#include "json.hpp"
#include "parity_rebless.hpp"
#include "raster/font_features.hpp"
#include "raster/line_break.hpp"
#include "raster/optical_math.hpp"
#include "raster/system_fonts.hpp"
#include "raster/text_unicode.hpp"
#include "jsmath.hpp"

using namespace premation::raster;
namespace js = premation::js;
using premation::test::JsonFixture;
using premation::test::json_numbers;

namespace {

std::vector<std::string> strings(const js::Json& a) {
  std::vector<std::string> out;
  for (const auto& s : a.arr()) out.push_back(s.str());
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

// line_break_parity.json is shared by the next two cases: each loads it, answers
// its own keys (withoutSegmenter here; withSegmenter and wrap.starts below) and
// finishes, so a re-bless of both rewrites the whole file in turn.
TEST_CASE("line breaks: lineBreak.ts parity without Intl.Segmenter", "[raster][linebreak][parity]") {
  JsonFixture fx("line_break_parity.json");
  REQUIRE(fx.ok());
  set_word_segmenter_disabled_for_test(true);
  for (js::Json& row : fx.root().find_mut("rows")->arr_mut()) {
    INFO(row.at("text").str());
    CHECK(fx.answer(row, "withoutSegmenter", json_numbers(true_indices(break_opportunities(strings(row.at("units")))))));
  }
  set_word_segmenter_disabled_for_test(false);
  REQUIRE(fx.finish());
}

TEST_CASE("line breaks: Intl.Segmenter word joins through ICU", "[raster][linebreak][icu][parity]") {
  JsonFixture fx("line_break_parity.json");
  REQUIRE(fx.ok());
  const std::string info = word_segmenter_info();
  if (info.empty()) SKIP("no ICU on this machine: the engine takes lineBreak.ts's no-Segmenter branch");
  std::printf("word segmenter: %s; fixture written with Node ICU %s\n", info.c_str(), fx.root().at("icu").str().c_str());
  int rows = 0;
  int segmentRowsExact = 0;
  int breakRowsExact = 0;
  int wrapRowsExact = 0;
  for (js::Json& row : fx.root().find_mut("rows")->arr_mut()) {
    INFO(row.at("text").str());
    const auto units = strings(row.at("units"));
    ++rows;
    const auto segs = word_segments(utf16_of(units));
    REQUIRE(segs);
    std::vector<std::pair<std::size_t, bool>> got;
    for (const auto& s : *segs) got.emplace_back(s.index, s.wordLike);
    std::vector<std::pair<std::size_t, bool>> want;
    for (const auto& s : row.at("segments").arr()) want.emplace_back(static_cast<std::size_t>(s.arr()[0].num()), s.arr()[1].b());
    // Raw segments may differ across ICU versions (Node's vs the OS's) where
    // the joins do not: reported, not required — and not re-blessed (they,
    // like "icu", record Node's ICU, not an engine answer).
    if (got == want) ++segmentRowsExact;
    else std::printf("  segments differ (ICU version): %s\n", row.at("text").str().c_str());
    const js::Json breaks = json_numbers(true_indices(break_opportunities(units)));
    if (breaks == row.at("withSegmenter")) ++breakRowsExact;
    CHECK(fx.answer(row, "withSegmenter", breaks));
    js::Json& wrap = *row.find_mut("wrap");
    std::vector<double> lengths;
    for (const auto& l : wrap.at("lengths").arr()) lengths.push_back(l.num());
    const js::Json starts = json_numbers(wrap_units(units, lengths, wrap.at("limit").num()));
    if (starts == wrap.at("starts")) ++wrapRowsExact;
    CHECK(fx.answer(wrap, "starts", starts));
  }
  std::printf("line breaks vs lineBreak.ts: segments %d/%d rows, break opportunities %d/%d, wraps %d/%d\n", segmentRowsExact,
              rows, breakRowsExact, rows, wrapRowsExact, rows);
  REQUIRE(fx.finish());
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

// ── alias FontFace features (font_features.hpp) ─────────────────────────────

TEST_CASE("font features: fontFaceVariants.ts featureSettingsString", "[raster][fonts]") {
  CHECK(feature_settings_string(false, false, false, {}).empty());
  // The TS unit test's case (fontAxes.test.ts).
  CHECK(feature_settings_string(true, true, true, {3, 1, 3, 25}) == "'liga' 0, 'clig' 0, 'dlig' 1, 'calt' 0, 'ss01' 1, 'ss03' 1");
  CHECK(feature_settings_string(true, false, false, {}) == "'liga' 0, 'clig' 0");
  CHECK(feature_settings_string(false, false, false, {20, 0, 7, 7, 21, 12}) == "'ss07' 1, 'ss12' 1, 'ss20' 1");
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
std::vector<std::uint8_t> render_rects(const js::Json& rects, std::uint32_t w, std::uint32_t h) {
  std::vector<std::uint8_t> out(static_cast<std::size_t>(w) * h * 4, 0);
  for (std::uint32_t y = 0; y < h; ++y) {
    for (std::uint32_t x = 0; x < w; ++x) {
      double a = 0;
      for (const auto& rj : rects.arr()) {
        const auto& r = rj.arr();
        const double ox = std::max(0.0, std::min(r[2].num(), x + 1.0) - std::max(r[0].num(), static_cast<double>(x)));
        const double oy = std::max(0.0, std::min(r[3].num(), y + 1.0) - std::max(r[1].num(), static_cast<double>(y)));
        a += motion::js::round(255 * ox * oy);
      }
      out[(static_cast<std::size_t>(y) * w + x) * 4 + 3] = static_cast<std::uint8_t>(std::min(255.0, a));
    }
  }
  return out;
}

/// A number as JSON.stringify writes it: NaN (and ±Infinity) become null.
js::Json json_number(double v) { return std::isfinite(v) ? js::Json::number(v) : js::Json::null(); }

/// opticalKerningCrossEngine.test.ts `clean(profile)`: { advance, left, right, top }, NaN as null.
js::Json profile_json(const optical::InkProfile& p) {
  const auto bands = [](const std::vector<double>& v) {
    js::Json::Array a;
    for (const double x : v) a.push_back(json_number(x));
    return js::Json::array(std::move(a));
  };
  js::Json o = js::Json::object();
  o.set("advance", json_number(p.advance));
  o.set("left", bands(p.left));
  o.set("right", bands(p.right));
  o.set("top", json_number(p.top));
  return o;
}

}  // namespace

TEST_CASE("optical kerning: vertical pairs match opticalKernVerticalPx exactly", "[raster][optical][parity]") {
  JsonFixture fixture("optical_kerning_parity.json");
  REQUIRE(fixture.ok());
  js::Json& fx = fixture.root();
  constexpr std::uint32_t kSide = 256;
  const double em0 = kSide / 2.0 - optical::kRefEmPx / 2;
  const js::Json& rectsByFace = fx.at("rects");
  const auto raster = [&](const std::string& css, const std::string& cluster) -> std::optional<optical::InkProfile> {
    const auto& rects = rectsByFace.at(css).at(cluster);
    if (!rects.is_array()) return std::nullopt;
    return optical::vertical_profile_from_alpha(render_rects(rects, kSide, kSide), kSide, kSide, em0, em0, optical::kRefEmPx);
  };

  int profilesExact = 0;
  js::Json::Object& profiles = fx.find_mut("profiles")->obj_mut();
  for (js::Json::Member& m : profiles) {
    const std::string& key = m.key;
    const auto bar = key.find('|');
    const auto p = raster(key.substr(0, bar), key.substr(bar + 1));
    REQUIRE(p);
    INFO(key);
    const js::Json got = profile_json(*p);
    profilesExact += got == m.value ? 1 : 0;
    CHECK(fixture.answer(m.value, got));
  }

  const auto horizontal = optical::profile_from_alpha(render_rects(rectsByFace.at("128px FaceA").at("\xE3\x81\x82"), kSide, kSide), kSide,
                                                      kSide, 80, 170, optical::kRefEmPx, 90);
  CHECK(fixture.answer(fx, "horizontal", profile_json(horizontal)));

  const auto pa = raster("128px FaceA", "\xE3\x81\x82");  // あ
  const auto pb = raster("128px FaceB", "\xE3\x80\x8C");  // 「
  REQUIRE(pa);
  REQUIRE(pb);
  for (js::Json& g : fx.find_mut("gaps")->arr_mut()) {
    const auto gap = optical::measure_pair_gap(*pa, g.at("sizeA").num(), *pb, g.at("sizeB").num(), g.at("xHeight").num());
    js::Json gapJson = js::Json::null();
    js::Json adjJson = js::Json::null();
    if (gap) {
      gapJson = js::Json::object();
      gapJson.set("area", js::Json::number(gap->area));
      gapJson.set("dmin", js::Json::number(gap->dmin));
      adjJson = json_numbers(std::array{optical::pair_adjustment(*gap, 0.1, 1), optical::pair_adjustment(*gap, 0.3, 0.8)});
    }
    CHECK(fixture.answer(g, "gap", std::move(gapJson)));
    CHECK(fixture.answer(g, "adj", std::move(adjJson)));
  }

  optical::VerticalKerner kerner(raster);
  int pairsExact = 0;
  int kerned = 0;
  js::Json::Array& pairs = fx.find_mut("pairs")->arr_mut();
  for (js::Json& pj : pairs) {
    js::Json::Array& p = pj.arr_mut();
    const double got = kerner.kern_px(p[0].str(), p[1].str(), p[2].num(), p[3].str(), p[4].str(), p[5].num());
    INFO(p[1].str() << " / " << p[4].str());
    pairsExact += p[6].is_number() && got == p[6].num() ? 1 : 0;
    CHECK(fixture.answer(p[6], js::Json::number(got)));
    kerned += p[6].num() < 0 ? 1 : 0;
  }
  for (js::Json& cj : fx.find_mut("proportional")->arr_mut()) {
    js::Json::Array& c = cj.arr_mut();
    std::string s;
    append_utf8(s, static_cast<char32_t>(c[0].num()));
    CHECK(fixture.answer(c[1], js::Json::boolean(optical::is_proportional_cjk(s))));
  }
  std::printf("vertical optical kerning vs opticalKerning.ts: profiles %d/%zu, pairs %d/%zu exact (%d kerned)\n", profilesExact,
              profiles.size(), pairsExact, pairs.size(), kerned);
  REQUIRE(fixture.finish());
}

TEST_CASE("line breaks: CJK paragraph wrap, inserted breaks and shifted runs (cjk_wrap_parity.json)", "[raster][linebreak][cjk]") {
  const std::optional<std::string> text = premation::test::read_fixture_file(premation::test::fixture_path("cjk_wrap_parity.json"));
  if (!text) {
    WARN("cjk_wrap_parity.json not generated yet (GEN_NATIVE_CJKWRAP=1 npx jest cjkWrapCrossEngine)");
    return;
  }
  const std::optional<js::Json> parsed = js::parse(*text);
  REQUIRE(parsed.has_value());
  const js::Json& fx = *parsed;
  const auto indices = [](const js::Json& a) {
    std::vector<std::size_t> out;
    for (const auto& v : a.arr()) out.push_back(static_cast<std::size_t>(v.num()));
    return out;
  };
  set_word_segmenter_disabled_for_test(true);  // the fixture is written without Intl.Segmenter
  for (const auto& row : fx.at("rows").arr()) {
    INFO(row.at("text").str());
    std::string wrapped;
    bool firstParagraph = true;
    for (const auto& p : row.at("paragraphs").arr()) {
      const auto units = strings(p.at("units"));
      std::vector<double> lengths;
      for (const auto& l : p.at("lengths").arr()) lengths.push_back(l.num());
      const double limit = p.at("limit").num();
      const double indent = p.at("firstLineIndent").num();
      const auto starts = wrap_units(units, lengths, [&](std::size_t line) { return limit - (line == 0 ? indent : 0); });
      CHECK(starts == indices(p.at("starts")));
      const std::string joined = join_wrapped(units, starts);
      CHECK(joined == p.at("joined").str());
      if (!firstParagraph) wrapped += '\n';
      wrapped += joined;
      firstParagraph = false;
    }
    CHECK(wrapped == row.at("wrapped").str());
    const auto inserted = inserted_break_indices(split_graphemes(row.at("text").str()), split_graphemes(wrapped));
    CHECK(inserted == indices(row.at("inserted")));
    const auto& runs = row.at("runs").arr();
    const auto& shifted = row.at("shifted").arr();
    REQUIRE(runs.size() == shifted.size());
    for (std::size_t i = 0; i < runs.size(); ++i) {
      const auto [s, e] = shift_span_for_inserted_breaks(runs[i].at("start").num(), runs[i].at("end").num(), inserted);
      CHECK(s == shifted[i].at("start").num());
      CHECK(e == shifted[i].at("end").num());
    }
  }
  set_word_segmenter_disabled_for_test(false);
}
