// Frozen parity fixtures and their re-bless mode (docs/TS_ENGINE_REMOVAL.md,
// "Parity fixtures → frozen data").
//
// The fixtures under tests/data were recorded from the TypeScript engine and
// are now plain data: nothing regenerates them. A C++ parity test compares its
// answers with the fixture; when the C++ answer changes ON PURPOSE (a fix, a
// deliberate divergence from the old TypeScript behaviour), run the test with
//
//     PARITY_REBLESS=1 <test binary> "[parity]"
//
// and it writes its own answers into the fixture instead of comparing — the
// inputs are kept, only the answers change. Review the fixture diff like code:
// every changed answer is a behaviour change.
//
// A re-bless of a passing test rewrites the file byte for byte (JSON is written
// with JSON.stringify's exact number formatting and the fixture's own layout,
// compact or one-space indented), so an unintended change is always visible.
#pragma once

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <optional>
#include <span>
#include <sstream>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>

// By path: several engine modules have a json.hpp (raster has its own), and
// a test target's include order must not decide which one this is.
#include "../src/core/json.hpp"

#ifndef PREMATION_ENGINE_TEST_DATA
#define PREMATION_ENGINE_TEST_DATA "."
#endif

namespace premation::test {

/// PARITY_REBLESS=1: parity tests write their answers into their fixtures.
[[nodiscard]] inline bool parity_rebless() {
  const char* v = std::getenv("PARITY_REBLESS");
  return v != nullptr && std::string_view(v) == "1";
}

/// A file of the test data directory (tests/data).
[[nodiscard]] inline std::string fixture_path(std::string_view file) {
  return std::string(PREMATION_ENGINE_TEST_DATA) + "/" + std::string(file);
}

[[nodiscard]] inline std::optional<std::string> read_fixture_file(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f.good()) return std::nullopt;
  std::stringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

/// Replace `path` with `bytes` through a temp file + rename, so an interrupted
/// re-bless never leaves a truncated fixture.
[[nodiscard]] inline bool write_fixture_file(const std::string& path, std::span<const char> bytes) {
  const std::string tmp = path + ".rebless.tmp";
  {
    std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
    if (!out.good()) return false;
    out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    if (!out.good()) return false;
  }
  std::error_code ec;
  std::filesystem::rename(tmp, path, ec);
  if (ec) {
    std::filesystem::remove(tmp, ec);
    return false;
  }
  std::fprintf(stderr, "PARITY_REBLESS: wrote %s\n", path.c_str());
  return true;
}

namespace detail {

/// JSON.stringify(v, null, 1).
inline void stringify_indented(std::string& out, const js::Json& v, std::size_t depth) {
  using Kind = js::Json::Kind;
  const auto newline = [&out](std::size_t d) {
    out.push_back('\n');
    out.append(d, ' ');
  };
  if (v.kind() == Kind::array) {
    const auto& a = v.arr();
    if (a.empty()) {
      out += "[]";
      return;
    }
    out.push_back('[');
    for (std::size_t i = 0; i < a.size(); ++i) {
      if (i > 0) out.push_back(',');
      newline(depth + 1);
      if (a[i].is_undefined()) {
        out += "null";  // JSON.stringify writes an undefined element as null
      } else {
        stringify_indented(out, a[i], depth + 1);
      }
    }
    newline(depth);
    out.push_back(']');
    return;
  }
  if (v.kind() == Kind::object) {
    bool any = false;
    for (const auto& m : v.obj()) {
      if (m.value.is_undefined()) continue;  // vanishes, as in JSON.stringify
      out.push_back(any ? ',' : '{');
      any = true;
      newline(depth + 1);
      out += js::stringify(js::Json::string(m.key));
      out += ": ";
      stringify_indented(out, m.value, depth + 1);
    }
    if (!any) {
      out += "{}";
      return;
    }
    newline(depth);
    out.push_back('}');
    return;
  }
  out += js::stringify(v);
}

}  // namespace detail

/// `v` as the fixture writers wrote it: JSON.stringify(v) or, `indented`,
/// JSON.stringify(v, null, 1); a trailing newline either way.
[[nodiscard]] inline std::string fixture_json_text(const js::Json& v, bool indented) {
  std::string out;
  if (indented) {
    detail::stringify_indented(out, v, 0);
  } else {
    out = js::stringify(v);
  }
  out.push_back('\n');
  return out;
}

/// A JSON parity fixture of tests/data: compare-or-record answers, then
/// finish() (writes the file back when re-blessing).
///
///   JsonFixture fx("corner_pin_parity.json");
///   REQUIRE(fx.ok());
///   for (Json& row : fx.root().find_mut("rows")->arr_mut()) {
///     CHECK(fx.answer(row, "fill", Json::string(styled_surface_fill(...))));
///   }
///   REQUIRE(fx.finish());
///
/// In compare mode answer() is `row[key] == got` (JSON equality: numbers are
/// compared exactly); when re-blessing it stores `got` and returns true.
class JsonFixture {
 public:
  explicit JsonFixture(std::string file) : path_(fixture_path(file)), rebless_(parity_rebless()) {
    const auto text = read_fixture_file(path_);
    if (!text) return;
    indented_ = text->size() > 1 && (*text)[1] == '\n';
    auto parsed = js::parse(*text);
    if (!parsed) return;
    root_ = std::move(*parsed);
    ok_ = root_.is_object();
  }

  [[nodiscard]] bool ok() const noexcept { return ok_; }
  [[nodiscard]] bool reblessing() const noexcept { return rebless_; }
  [[nodiscard]] const std::string& path() const noexcept { return path_; }
  [[nodiscard]] js::Json& root() noexcept { return root_; }
  [[nodiscard]] const js::Json& root() const noexcept { return root_; }

  /// Compare `holder[key]` with `got`, or (re-blessing) store `got` there.
  bool answer(js::Json& holder, std::string_view key, js::Json got) {
    if (rebless_) {
      holder.set(key, std::move(got));
      return true;
    }
    return holder.at(key) == got;
  }

  /// Compare `slot` with `got`, or (re-blessing) replace it.
  bool answer(js::Json& slot, js::Json got) {
    if (rebless_) {
      slot = std::move(got);
      return true;
    }
    return slot == got;
  }

  /// Re-blessing: write the fixture back (inputs unchanged, answers replaced).
  /// Compare mode: nothing to do. False only when the write failed.
  [[nodiscard]] bool finish() const {
    if (!rebless_) return true;
    const std::string text = fixture_json_text(root_, indented_);
    return write_fixture_file(path_, text);
  }

 private:
  std::string path_;
  bool rebless_ = false;
  bool indented_ = false;
  bool ok_ = false;
  js::Json root_;
};

/// A JSON array of numbers.
template <class Range>
[[nodiscard]] js::Json json_numbers(const Range& values) {
  js::Json::Array a;
  for (const auto& x : values) a.push_back(js::Json::number(static_cast<double>(x)));
  return js::Json::array(std::move(a));
}

}  // namespace premation::test
