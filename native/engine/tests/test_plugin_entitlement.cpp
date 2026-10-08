// Premation Cloud entitlements (plugins/entitlement.hpp, docs/PLUGIN_PLATFORM_PLAN.md §3.2):
// the hand-written ECDSA P-256 verifier against signatures made by Node's
// crypto (the registry's signer), the token file, and the host's `locked`
// status for a bundle that requires the entitlement.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <optional>
#include <span>
#include <string>

#include "entitlement.hpp"
#include "host.hpp"

namespace pl = premation::plugins;
namespace fs = std::filesystem;

namespace {

// A throwaway key pair; the signatures below were made with its private half
// by node:crypto (`sign('sha256', …, { dsaEncoding: 'ieee-p1363' })`).
constexpr const char* kKey = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEccxatKvJe030D+bVpKPsH7hbou168sRaTbAPE6jRnSUKJp5ncgxEv2A/QIQcS4PpoUuN6Heh9nxIKypoNXFckQ==";
constexpr const char* kPayload = R"({"v":1,"userId":"u1","plan":"pro","validUntil":"2026-11-15T00:00:00.000Z","issuedAt":"2026-10-08T00:00:00.000Z"})";
constexpr const char* kPayloadSig = "i8Af8uiQ5Ag3w9mM1QdhTAnWaId/jv87OiU1wO7hiXSQiACeXTWV0+PQyTsMp1lwxvHjieEjECM4Fz0tz606mg==";
constexpr const char* kFreePayload = R"({"v":1,"userId":"u1","plan":"free","validUntil":"2026-11-15T00:00:00.000Z","issuedAt":"2026-10-08T00:00:00.000Z"})";
constexpr const char* kFreeSig = "qpZ1Mc/pBykt4gSi9DaZMYXe+HV6IGDhMbGRsyl9374eYcyhy9StQGtuJOXMKHUcKChQG70ibtqEPMeA+X9Dhw==";
constexpr const char* kEmptySig = "af7kbM3jmO7SmpbHViXECr+MoPaEhKbZY8o5wuz2Kpaffyt7WL+IvKybXxeYyzdN4KH/CCBO3W0BdodF+PogPw==";
constexpr const char* kAbcSig = "8PZBJVS/4w7xSlQ7GAzlcomc6Ap3akY3BUqklNob/8w8PWLQjbDw8D4qOBj3m478bj9klK/kQLmqds1GgTuU6Q==";
constexpr const char* kLongSig = "sGZRYnRBavaFkJRB7ffohMhFvKfz0szPHRYotudgQNf427GHUtgwXefGQ4vTGK9cq0l1/IVRXcEdxy/kLdBNew==";

// 2026-10-08T00:00:00Z and the token's validUntil, 2026-11-15T00:00:00Z.
constexpr std::int64_t kNow = 1791417600000;
constexpr std::int64_t kUntil = 1794700800000;

fs::path write_token(const std::string& name, const std::string& payload, const std::string& sig) {
  const fs::path p = fs::temp_directory_path() / ("premation-entitlement-" + name + ".json");
  std::ofstream f(p, std::ios::binary);
  std::string esc;
  for (const char c : payload) {
    if (c == '"' || c == '\\') esc.push_back('\\');
    esc.push_back(c);
  }
  f << R"({"payload":")" << esc << R"(","signature":")" << sig << R"("})";
  return p;
}

}  // namespace

TEST_CASE("entitlement: ECDSA P-256 verifies what node:crypto signs", "[plugins][entitlement]") {
  CHECK(pl::ecdsa_p256_verify_b64(kPayload, kPayloadSig, kKey));
  CHECK(pl::ecdsa_p256_verify_b64("", kEmptySig, kKey));
  CHECK(pl::ecdsa_p256_verify_b64("abc", kAbcSig, kKey));
  CHECK(pl::ecdsa_p256_verify_b64(std::string(1000, 'x'), kLongSig, kKey));
}

TEST_CASE("entitlement: ECDSA P-256 refuses anything else", "[plugins][entitlement]") {
  // Another message, another signature, a flipped bit, the wrong key.
  CHECK_FALSE(pl::ecdsa_p256_verify_b64("abd", kAbcSig, kKey));
  CHECK_FALSE(pl::ecdsa_p256_verify_b64("abc", kEmptySig, kKey));
  const std::optional<std::string> sig = pl::base64_decode(kAbcSig);
  const std::optional<std::string> key = pl::base64_decode(kKey);
  REQUIRE(sig.has_value());
  REQUIRE(key.has_value());
  std::string flipped = sig.value();
  flipped[10] = static_cast<char>(flipped[10] ^ 1);
  const auto bytes = [](const std::string& b) {
    return std::span(reinterpret_cast<const std::uint8_t*>(b.data()), b.size());  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): byte view
  };
  CHECK(pl::ecdsa_p256_verify("abc", bytes(sig.value()), bytes(key.value())));
  CHECK_FALSE(pl::ecdsa_p256_verify("abc", bytes(flipped), bytes(key.value())));
  CHECK_FALSE(pl::ecdsa_p256_verify_b64("abc", kAbcSig, pl::kOperatorPublicKey));
  // Malformed inputs: never a crash, always false.
  CHECK_FALSE(pl::ecdsa_p256_verify_b64("abc", "not base64!", kKey));
  CHECK_FALSE(pl::ecdsa_p256_verify_b64("abc", kAbcSig, "AAAA"));
  CHECK_FALSE(pl::ecdsa_p256_verify_b64("abc", std::string(88, 'A'), kKey));  // r = s = 0
}

TEST_CASE("entitlement: ISO 8601 UTC dates", "[plugins][entitlement]") {
  CHECK(pl::parse_iso8601_utc_ms("1970-01-01T00:00:00Z") == 0);
  CHECK(pl::parse_iso8601_utc_ms("2026-10-08T00:00:00.000Z") == kNow);
  CHECK(pl::parse_iso8601_utc_ms("2026-11-15T00:00:00Z") == kUntil);
  CHECK(pl::parse_iso8601_utc_ms("2000-02-29T12:34:56.789Z") == 951827696789);
  CHECK_FALSE(pl::parse_iso8601_utc_ms("2026-11-15 00:00:00Z"));
  CHECK_FALSE(pl::parse_iso8601_utc_ms("2026-13-15T00:00:00Z"));
  CHECK_FALSE(pl::parse_iso8601_utc_ms("2026-11-15T00:00:00+02:00"));
}

TEST_CASE("entitlement: the token file", "[plugins][entitlement]") {
  std::string why;
  const auto ok = pl::read_entitlement(write_token("ok", kPayload, kPayloadSig), kKey, why);
  REQUIRE(ok.has_value());
  CHECK(ok.value().plan == "pro");
  CHECK(ok.value().userId == "u1");
  CHECK(ok.value().validUntilMs == kUntil);
  CHECK(pl::entitlement_problem(ok, why, pl::kPremationCloud, kNow).empty());
  // Expired: honest, and says what to do.
  CHECK(pl::entitlement_problem(ok, why, pl::kPremationCloud, kUntil + 1).find("subscription ended") != std::string::npos);
  // A plan without Premation plugins.
  const auto free = pl::read_entitlement(write_token("free", kFreePayload, kFreeSig), kKey, why);
  CHECK(pl::entitlement_problem(free, why, pl::kPremationCloud, kNow).find("does not include") != std::string::npos);
  // Forged: a payload edited after signing, or signed by someone else.
  std::string forged = kPayload;
  forged.replace(forged.find("2026-11-15"), 10, "2099-11-15");
  CHECK_FALSE(pl::read_entitlement(write_token("forged", forged, kPayloadSig), kKey, why));
  CHECK(why.find("not signed by Premation") != std::string::npos);
  CHECK_FALSE(pl::read_entitlement(write_token("ok2", kPayload, kPayloadSig), pl::kOperatorPublicKey, why));
  // No file: locked, with the reason.
  CHECK_FALSE(pl::read_entitlement(fs::temp_directory_path() / "premation-entitlement-missing.json", kKey, why));
  CHECK(pl::entitlement_problem(std::nullopt, why, pl::kPremationCloud, kNow).starts_with("Requires Premation Cloud"));
  CHECK(pl::entitlement_problem(ok, why, "gold", kNow).find("unknown entitlement") != std::string::npos);
}

TEST_CASE("plugin host: a bundle that requires Premation Cloud loads only with a valid token", "[plugins][entitlement][store]") {
  const fs::path root = fs::temp_directory_path() / "premation-plugin-test-entitled";
  std::error_code ec;
  fs::remove_all(root, ec);
  fs::create_directories(root);
  fs::copy(fs::path(PREMATION_PLUGIN_BUNDLES) / "ripple", root / "ripple", fs::copy_options::recursive);
  {
    const fs::path man = root / "ripple" / "premation-plugin.json";
    std::ifstream in(man);
    std::string text((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    in.close();
    const auto brace = text.rfind('}');
    text.insert(brace, R"(, "entitlement": "premation-cloud")");
    std::ofstream(man) << text;
  }
  const auto host_with = [&](fs::path token, std::int64_t now) {
    pl::HostOptions o;
    o.searchPaths = {root};
    o.threads = 1;
    o.attachToDocument = false;
    o.entitlement = std::move(token);
    o.operatorKey = kKey;
    o.nowMs = [now] { return now; };
    return std::make_unique<pl::PluginHost>(std::move(o));
  };
  constexpr const char* kRipple = "com.premation.samples.ripple";

  auto none = host_with({}, kNow);
  auto recs = none->scan();
  REQUIRE(recs.size() == 1);
  CHECK(recs.front().status == pl::PluginStatus::locked);
  CHECK(recs.front().error.starts_with("Requires Premation Cloud"));
  CHECK(none->effect(kRipple) == nullptr);
  CHECK(none->set_enabled("com.premation.samples.ripple", true));  // stays locked
  CHECK(none->effect(kRipple) == nullptr);

  auto expired = host_with(write_token("host-ok", kPayload, kPayloadSig), kUntil + 1);
  CHECK(expired->scan().front().status == pl::PluginStatus::locked);

  auto entitled = host_with(write_token("host-ok2", kPayload, kPayloadSig), kNow);
  recs = entitled->scan();
  CHECK(recs.front().status == pl::PluginStatus::loaded);
  CHECK(entitled->effect(kRipple) != nullptr);
}
