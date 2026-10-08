// Premation Cloud entitlements for native plugins (docs/PLUGIN_PLATFORM_PLAN.md §3.2).
//
// A bundle whose manifest says `"entitlement": "premation-cloud"` loads only
// with a valid entitlement token: `{ "payload": "<json>", "signature": "<b64>" }`
// written by Electron main from the registry's `GET /plugins/entitlement`
// (`--entitlement <file>`, the export job's `pluginEntitlement`). The payload
// is `{ v, userId, plan: "pro", validUntil, issuedAt }`, signed with the
// registry's operator key — ECDSA P-256 / SHA-256, IEEE P1363 r||s — whose
// public half is pinned here, as Electron pins it for the revocation list.
//
// Checked in the engine, before the bundle's binary is opened, so the plugin
// itself needs no licence code. A missing, malformed, forged or expired token
// leaves the plugin `locked`: listed, never loaded, its effects passing
// through (the missing-plugin path; projects keep every value).
//
// The verifier is self-contained (no crypto library is linked into the
// engine): 256-bit modular arithmetic in 32-bit limbs, Jacobian points. It is
// run once per such bundle at load, on public data, so it is written for
// clarity rather than speed or constant time.
#pragma once

#include <array>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <span>
#include <string>
#include <string_view>

namespace premation::plugins {

/// The registry operator's public key (SPKI DER, base64) — electron/nativePluginStore.ts OPERATOR_PUBLIC_KEY.
inline constexpr std::string_view kOperatorPublicKey =
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2Zrt+EZ6T/vYPa0w4AFFdiQf7UGyVBi5S6TPQiSQjTDqFgVyFcEsseMG+rBk/AE/NhWxWYTRE/WInb2Xx4lgqA==";

/// The only entitlement a manifest may name today.
inline constexpr std::string_view kPremationCloud = "premation-cloud";

/// Standard base64 (with or without padding); nullopt on any other character.
[[nodiscard]] std::optional<std::string> base64_decode(std::string_view in);

/// ECDSA P-256 / SHA-256 over `message`. `signature`: 64 bytes r||s. `spki`: the
/// 91-byte DER SubjectPublicKeyInfo of an uncompressed P-256 key. False for
/// anything malformed, never throws.
[[nodiscard]] bool ecdsa_p256_verify(std::string_view message, std::span<const std::uint8_t> signature,
                                     std::span<const std::uint8_t> spki) noexcept;

/// The same with base64 signature and key (the wire form).
[[nodiscard]] bool ecdsa_p256_verify_b64(std::string_view message, std::string_view signatureB64,
                                         std::string_view spkiB64) noexcept;

/// `2026-11-15T00:00:00.000Z` (UTC, optional fraction) → milliseconds since the epoch.
[[nodiscard]] std::optional<std::int64_t> parse_iso8601_utc_ms(std::string_view s) noexcept;

/// A verified token.
struct Entitlement {
  std::string userId;
  std::string plan;
  std::int64_t validUntilMs = 0;
};

/// Read and verify an entitlement file. nullopt with `why` (shown on the
/// locked plugin) when the file is missing, malformed or not signed by `operatorKeyB64`.
[[nodiscard]] std::optional<Entitlement> read_entitlement(const std::filesystem::path& file, std::string_view operatorKeyB64,
                                                          std::string& why);

/// Does `e` grant `required` at `nowMs`? Empty `why` when it does.
[[nodiscard]] std::string entitlement_problem(const std::optional<Entitlement>& e, std::string_view loadWhy,
                                              std::string_view required, std::int64_t nowMs);

}  // namespace premation::plugins
