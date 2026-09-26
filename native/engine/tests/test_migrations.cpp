// Document migrations (docio.cpp `migrate_document`) over frozen input/output
// pairs: tests/data/migrations/*.json. Each pair is a document the TypeScript
// engine's migration tests (src/core/project/migrations/*.test.ts) fed to
// `migrateDocument` or to one migration step, and what the TypeScript
// production chain made of it — the upgraded document at the current version,
// or the refusal (a newer document, no migration path). The TypeScript
// migrations are deleted with the TypeScript engine; these pairs are what
// keeps the C++ chain honest after that.
//
// Compared as JSON.stringify would print them (key order included: a document
// saved after the migration must be byte-identical whichever engine opened
// it). PARITY_REBLESS=1 writes the C++ answers into the pairs instead
// (parity_rebless.hpp); review the diff.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <filesystem>
#include <string>
#include <vector>

#include "docio.hpp"
#include "fail.hpp"
#include "json.hpp"
#include "parity_rebless.hpp"

namespace fs = std::filesystem;
using premation::js::Json;

namespace {

/// Where two JSON values first differ, as a JSON path (best effort, for the report).
std::string first_difference(const Json& want, const Json& got, const std::string& at) {
  if (want == got) return {};
  if (want.is_object() && got.is_object()) {
    for (std::size_t i = 0; i < want.obj().size() || i < got.obj().size(); ++i) {
      const Json::Member* a = i < want.obj().size() ? &want.obj()[i] : nullptr;
      const Json::Member* b = i < got.obj().size() ? &got.obj()[i] : nullptr;
      if (a == nullptr || b == nullptr || a->key != b->key) {
        return at + ": member #" + std::to_string(i) + " is '" + (a != nullptr ? a->key : "(none)") + "' (TS) vs '" +
               (b != nullptr ? b->key : "(none)") + "' (C++)";
      }
      std::string inner = first_difference(a->value, b->value, at + "." + a->key);
      if (!inner.empty()) return inner;
    }
  }
  if (want.is_array() && got.is_array() && want.arr().size() == got.arr().size()) {
    for (std::size_t i = 0; i < want.arr().size(); ++i) {
      std::string inner = first_difference(want.arr()[i], got.arr()[i], at + "[" + std::to_string(i) + "]");
      if (!inner.empty()) return inner;
    }
  }
  std::string a = premation::js::stringify(want);
  std::string b = premation::js::stringify(got);
  if (a.size() > 200) a = a.substr(0, 200) + "…";
  if (b.size() > 200) b = b.substr(0, 200) + "…";
  return at + ": " + a + " (TS) vs " + b + " (C++)";
}

/// A refusal's first sentence — what both engines say (the TypeScript adds advice after it).
std::string first_sentence(const std::string& message) {
  const auto end = message.find(". ");
  return end == std::string::npos ? message : message.substr(0, end + 1);
}

}  // namespace

TEST_CASE("migrations: frozen TypeScript input/output pairs through migrate_document", "[docio][migrations][parity]") {
  const fs::path dir = fs::path(PREMATION_ENGINE_TEST_DATA) / "migrations";
  REQUIRE(fs::is_directory(dir));
  std::vector<std::string> files;
  for (const auto& e : fs::directory_iterator(dir)) {
    if (e.is_regular_file() && e.path().extension() == ".json") files.push_back(e.path().filename().string());
  }
  std::ranges::sort(files);
  REQUIRE(files.size() >= 20);

  std::size_t upgraded = 0;
  std::size_t refused = 0;
  for (const std::string& file : files) {
    premation::test::JsonFixture fx("migrations/" + file);
    REQUIRE(fx.ok());
    INFO(file << " — " << fx.root().at("source").str());
    Json& pair = fx.root();
    REQUIRE(pair.has("input"));
    Json got;
    std::string refusal;
    try {
      got = premation::doc::migrate_document(pair.at("input"));
    } catch (const premation::doc::EngineFail& e) {
      refusal = e.error.message;
    }
    if (fx.reblessing()) {
      if (refusal.empty()) {
        pair.erase("error");
        pair.set("output", std::move(got));
      } else {
        pair.erase("output");
        Json err = Json::object();
        err.set("message", Json::string(refusal));
        pair.set("error", std::move(err));
      }
      REQUIRE(fx.finish());
      continue;
    }
    if (pair.has("error")) {
      ++refused;
      // A refusal is compared by what it says (the open dialog shows it); the
      // TypeScript's messages add a sentence of advice the C++ ones leave out.
      REQUIRE_FALSE(refusal.empty());
      CHECK(first_sentence(refusal) == first_sentence(pair.at("error").at("message").str()));
      continue;
    }
    ++upgraded;
    REQUIRE(refusal.empty());
    const std::string diff = first_difference(pair.at("output"), got, "$");
    INFO(diff);
    CHECK(diff.empty());
  }
  if (!premation::test::parity_rebless()) {
    CHECK(upgraded > 0);
    CHECK(refused > 0);
  }
}
