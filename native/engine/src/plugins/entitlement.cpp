#include "entitlement.hpp"

#include <algorithm>
#include <fstream>
#include <sstream>

#include "bundle_io.hpp"
#include "json.hpp"

namespace premation::plugins {
namespace {

// ── 256-bit unsigned integers: eight 32-bit limbs, least significant first ──

using U256 = std::array<std::uint32_t, 8>;

constexpr U256 from_hex(std::string_view hex) {
  // 64 hex digits, most significant first.
  U256 r{};
  for (std::size_t i = 0; i < 64; ++i) {
    const char c = hex[63 - i];
    const std::uint32_t d = c <= '9' ? static_cast<std::uint32_t>(c - '0') : static_cast<std::uint32_t>(c - 'A' + 10);
    r.at(i / 8) |= d << (4U * (i % 8));
  }
  return r;
}

constexpr U256 kP = from_hex("FFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF");
constexpr U256 kN = from_hex("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
constexpr U256 kB = from_hex("5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B");
constexpr U256 kGx = from_hex("6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296");
constexpr U256 kGy = from_hex("4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5");

U256 from_be(std::span<const std::uint8_t> b) {
  U256 r{};
  for (std::size_t i = 0; i < 32; ++i) {
    r.at((31 - i) / 4) |= static_cast<std::uint32_t>(b[i]) << (8U * ((31 - i) % 4));
  }
  return r;
}

bool is_zero(const U256& a) {
  return std::ranges::all_of(a, [](std::uint32_t w) { return w == 0; });
}

/// -1, 0, 1.
int cmp(const U256& a, const U256& b) {
  for (std::size_t i = 8; i-- > 0;) {
    if (a.at(i) != b.at(i)) return a.at(i) < b.at(i) ? -1 : 1;
  }
  return 0;
}

/// r = a + b; returns the carry out.
std::uint32_t add(U256& r, const U256& a, const U256& b) {
  std::uint64_t carry = 0;
  for (std::size_t i = 0; i < 8; ++i) {
    const std::uint64_t s = static_cast<std::uint64_t>(a.at(i)) + b.at(i) + carry;
    r.at(i) = static_cast<std::uint32_t>(s);
    carry = s >> 32U;
  }
  return static_cast<std::uint32_t>(carry);
}

/// r = a - b; returns the borrow out.
std::uint32_t sub(U256& r, const U256& a, const U256& b) {
  std::uint64_t borrow = 0;
  for (std::size_t i = 0; i < 8; ++i) {
    const std::uint64_t d = static_cast<std::uint64_t>(a.at(i)) - b.at(i) - borrow;
    r.at(i) = static_cast<std::uint32_t>(d);
    borrow = (d >> 32U) & 1U;
  }
  return static_cast<std::uint32_t>(borrow);
}

bool bit(const U256& a, std::size_t i) { return ((a.at(i / 32) >> (i % 32)) & 1U) != 0; }

// Modular arithmetic for an odd 256-bit modulus m; operands are < m.

U256 addmod(const U256& a, const U256& b, const U256& m) {
  U256 r{};
  const std::uint32_t carry = add(r, a, b);
  if (carry != 0 || cmp(r, m) >= 0) (void)sub(r, r, m);
  return r;
}

U256 submod(const U256& a, const U256& b, const U256& m) {
  U256 r{};
  if (sub(r, a, b) != 0) (void)add(r, r, m);
  return r;
}

/// Double-and-add over b's bits: 256 doublings, each reduced. Simple and exact.
U256 mulmod(const U256& a, const U256& b, const U256& m) {
  U256 r{};
  for (std::size_t i = 256; i-- > 0;) {
    r = addmod(r, r, m);
    if (bit(b, i)) r = addmod(r, a, m);
  }
  return r;
}

U256 powmod(const U256& a, const U256& e, const U256& m) {
  U256 r{};
  r.at(0) = 1;
  for (std::size_t i = 256; i-- > 0;) {
    r = mulmod(r, r, m);
    if (bit(e, i)) r = mulmod(r, a, m);
  }
  return r;
}

/// Inverse modulo a prime (Fermat: a^(m-2)).
U256 invmod(const U256& a, const U256& m) {
  U256 two{};
  two.at(0) = 2;
  U256 e{};
  (void)sub(e, m, two);
  return powmod(a, e, m);
}

U256 reduce(const U256& a, const U256& m) {
  U256 r = a;
  while (cmp(r, m) >= 0) (void)sub(r, r, m);
  return r;
}

// ── P-256 points, Jacobian coordinates (X/Z², Y/Z³); Z = 0 is infinity ──

struct Point {
  U256 x{};
  U256 y{};
  U256 z{};
};

U256 small(std::uint32_t v) {
  U256 r{};
  r.at(0) = v;
  return r;
}

Point dbl(const Point& p) {
  if (is_zero(p.z) || is_zero(p.y)) return Point{};
  const U256& m = kP;
  const U256 delta = mulmod(p.z, p.z, m);
  const U256 gamma = mulmod(p.y, p.y, m);
  const U256 beta = mulmod(p.x, gamma, m);
  // a = -3: alpha = 3 (X - delta)(X + delta)
  const U256 alpha = mulmod(small(3), mulmod(submod(p.x, delta, m), addmod(p.x, delta, m), m), m);
  const U256 beta4 = mulmod(small(4), beta, m);
  const U256 beta8 = addmod(beta4, beta4, m);
  Point r;
  r.x = submod(mulmod(alpha, alpha, m), beta8, m);
  const U256 yz = addmod(p.y, p.z, m);
  r.z = submod(submod(mulmod(yz, yz, m), gamma, m), delta, m);
  const U256 gamma2 = mulmod(gamma, gamma, m);
  r.y = submod(mulmod(alpha, submod(beta4, r.x, m), m), mulmod(small(8), gamma2, m), m);
  return r;
}

Point addp(const Point& p, const Point& q) {
  if (is_zero(p.z)) return q;
  if (is_zero(q.z)) return p;
  const U256& m = kP;
  const U256 z1z1 = mulmod(p.z, p.z, m);
  const U256 z2z2 = mulmod(q.z, q.z, m);
  const U256 u1 = mulmod(p.x, z2z2, m);
  const U256 u2 = mulmod(q.x, z1z1, m);
  const U256 s1 = mulmod(mulmod(p.y, q.z, m), z2z2, m);
  const U256 s2 = mulmod(mulmod(q.y, p.z, m), z1z1, m);
  const U256 h = submod(u2, u1, m);
  const U256 rr = addmod(submod(s2, s1, m), submod(s2, s1, m), m);
  if (is_zero(h)) return is_zero(rr) ? dbl(p) : Point{};
  const U256 h2 = addmod(h, h, m);
  const U256 i = mulmod(h2, h2, m);
  const U256 j = mulmod(h, i, m);
  const U256 v = mulmod(u1, i, m);
  Point r;
  r.x = submod(submod(mulmod(rr, rr, m), j, m), addmod(v, v, m), m);
  const U256 s1j = mulmod(s1, j, m);
  r.y = submod(mulmod(rr, submod(v, r.x, m), m), addmod(s1j, s1j, m), m);
  const U256 zz = addmod(p.z, q.z, m);
  r.z = mulmod(submod(submod(mulmod(zz, zz, m), z1z1, m), z2z2, m), h, m);
  return r;
}

/// u1·G + u2·Q (Shamir's trick: one shared doubling chain).
Point twin_mul(const U256& u1, const Point& g, const U256& u2, const Point& q) {
  const Point gq = addp(g, q);
  Point r{};
  for (std::size_t i = 256; i-- > 0;) {
    r = dbl(r);
    const bool a = bit(u1, i);
    const bool b = bit(u2, i);
    if (a && b) r = addp(r, gq);
    else if (a) r = addp(r, g);
    else if (b) r = addp(r, q);
  }
  return r;
}

bool on_curve(const U256& x, const U256& y) {
  const U256& m = kP;
  if (cmp(x, m) >= 0 || cmp(y, m) >= 0) return false;
  const U256 y2 = mulmod(y, y, m);
  const U256 x3 = mulmod(mulmod(x, x, m), x, m);
  const U256 rhs = addmod(submod(x3, mulmod(small(3), x, m), m), kB, m);
  return cmp(y2, rhs) == 0;
}

/// The fixed DER header of a P-256 SubjectPublicKeyInfo, up to the 0x04 point tag.
constexpr std::array<std::uint8_t, 26> kSpkiPrefix = {0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
                                                      0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00};

std::array<std::uint8_t, 32> sha256(std::string_view message) {
  const std::string hex = doc::sha256_hex(message);
  std::array<std::uint8_t, 32> out{};
  const auto nib = [](char c) { return static_cast<std::uint8_t>(c <= '9' ? c - '0' : c - 'a' + 10); };
  for (std::size_t i = 0; i < 32; ++i) out.at(i) = static_cast<std::uint8_t>((nib(hex[2 * i]) << 4U) | nib(hex[2 * i + 1]));
  return out;
}

std::span<const std::uint8_t> bytes_of(const std::string& s) {
  return {reinterpret_cast<const std::uint8_t*>(s.data()), s.size()};  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): byte view
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
std::int64_t days_from_civil(std::int64_t y, std::int64_t m, std::int64_t d) {
  y -= m <= 2 ? 1 : 0;
  const std::int64_t era = (y >= 0 ? y : y - 399) / 400;
  const std::int64_t yoe = y - era * 400;
  const std::int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const std::int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + doe - 719468;
}

}  // namespace

std::optional<std::string> base64_decode(std::string_view in) {
  std::string out;
  out.reserve(in.size() * 3 / 4);
  std::uint32_t acc = 0;
  int bits = 0;
  std::size_t pad = 0;
  for (const char c : in) {
    std::uint32_t v = 0;
    if (c >= 'A' && c <= 'Z') v = static_cast<std::uint32_t>(c - 'A');
    else if (c >= 'a' && c <= 'z') v = static_cast<std::uint32_t>(c - 'a' + 26);
    else if (c >= '0' && c <= '9') v = static_cast<std::uint32_t>(c - '0' + 52);
    else if (c == '+') v = 62;
    else if (c == '/') v = 63;
    else if (c == '=') {
      ++pad;
      continue;
    } else {
      return std::nullopt;
    }
    if (pad != 0) return std::nullopt;  // data after padding
    acc = (acc << 6U) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<char>((acc >> static_cast<std::uint32_t>(bits)) & 0xFFU));
    }
  }
  if (pad > 2) return std::nullopt;
  return out;
}

bool ecdsa_p256_verify(std::string_view message, std::span<const std::uint8_t> signature,
                       std::span<const std::uint8_t> spki) noexcept {
  if (signature.size() != 64 || spki.size() != 91) return false;
  if (!std::equal(kSpkiPrefix.begin(), kSpkiPrefix.end(), spki.begin()) || spki[26] != 0x04) return false;
  const U256 qx = from_be(spki.subspan(27, 32));
  const U256 qy = from_be(spki.subspan(59, 32));
  if (!on_curve(qx, qy)) return false;
  const U256 r = from_be(signature.subspan(0, 32));
  const U256 s = from_be(signature.subspan(32, 32));
  if (is_zero(r) || is_zero(s) || cmp(r, kN) >= 0 || cmp(s, kN) >= 0) return false;
  const std::array<std::uint8_t, 32> digest = sha256(message);
  const U256 e = reduce(from_be(digest), kN);
  const U256 w = invmod(s, kN);
  const U256 u1 = mulmod(e, w, kN);
  const U256 u2 = mulmod(r, w, kN);
  const Point g{kGx, kGy, small(1)};
  const Point q{qx, qy, small(1)};
  const Point x = twin_mul(u1, g, u2, q);
  if (is_zero(x.z)) return false;
  const U256 zinv = invmod(x.z, kP);
  const U256 ax = mulmod(x.x, mulmod(zinv, zinv, kP), kP);
  return cmp(reduce(ax, kN), r) == 0;
}

bool ecdsa_p256_verify_b64(std::string_view message, std::string_view signatureB64, std::string_view spkiB64) noexcept {
  try {
    const auto sig = base64_decode(signatureB64);
    const auto key = base64_decode(spkiB64);
    if (!sig || !key) return false;
    return ecdsa_p256_verify(message, bytes_of(*sig), bytes_of(*key));
  } catch (...) {  // allocation only
    return false;
  }
}

std::optional<std::int64_t> parse_iso8601_utc_ms(std::string_view s) noexcept {
  // YYYY-MM-DDTHH:MM:SS[.fff…]Z
  if (s.size() < 20 || s[4] != '-' || s[7] != '-' || s[10] != 'T' || s[13] != ':' || s[16] != ':' || s.back() != 'Z') return std::nullopt;
  const auto num = [&](std::size_t at, std::size_t len) -> std::optional<std::int64_t> {
    std::int64_t v = 0;
    for (std::size_t i = at; i < at + len; ++i) {
      if (s[i] < '0' || s[i] > '9') return std::nullopt;
      v = v * 10 + (s[i] - '0');
    }
    return v;
  };
  const auto y = num(0, 4);
  const auto mo = num(5, 2);
  const auto d = num(8, 2);
  const auto h = num(11, 2);
  const auto mi = num(14, 2);
  const auto se = num(17, 2);
  if (!y || !mo || !d || !h || !mi || !se || *mo < 1 || *mo > 12 || *d < 1 || *d > 31 || *h > 23 || *mi > 59 || *se > 60) return std::nullopt;
  std::int64_t ms = 0;
  if (s.size() > 20) {
    if (s[19] != '.') return std::nullopt;
    const std::string_view frac = s.substr(20, s.size() - 21);
    if (frac.empty() || frac.size() > 9) return std::nullopt;
    for (std::size_t i = 0; i < frac.size(); ++i) {
      if (frac[i] < '0' || frac[i] > '9') return std::nullopt;
      if (i < 3) ms = ms * 10 + (frac[i] - '0');
    }
    for (std::size_t i = frac.size(); i < 3; ++i) ms *= 10;
  }
  const std::int64_t days = days_from_civil(*y, *mo, *d);
  return ((days * 24 + *h) * 60 + *mi) * 60000 + *se * 1000 + ms;
}

std::optional<Entitlement> read_entitlement(const std::filesystem::path& file, std::string_view operatorKeyB64, std::string& why) {
  if (file.empty()) {
    why = "no Premation Cloud sign-in on this computer";
    return std::nullopt;
  }
  std::string text;
  {
    std::ifstream f(file, std::ios::binary);
    if (!f) {
      why = "no Premation Cloud sign-in on this computer";
      return std::nullopt;
    }
    std::stringstream ss;
    ss << f.rdbuf();
    text = ss.str();
  }
  const auto outer = js::parse(text);
  if (!outer || !outer->at("payload").is_string() || !outer->at("signature").is_string()) {
    why = "the entitlement file is not readable";
    return std::nullopt;
  }
  const std::string& payload = outer->at("payload").str();
  if (!ecdsa_p256_verify_b64(payload, outer->at("signature").str(), operatorKeyB64)) {
    why = "the entitlement is not signed by Premation";
    return std::nullopt;
  }
  const auto body = js::parse(payload);
  if (!body || !body->at("plan").is_string() || !body->at("validUntil").is_string()) {
    why = "the entitlement is not readable";
    return std::nullopt;
  }
  const auto until = parse_iso8601_utc_ms(body->at("validUntil").str());
  if (!until) {
    why = "the entitlement has no valid end date";
    return std::nullopt;
  }
  Entitlement e;
  e.plan = body->at("plan").str();
  e.userId = body->at("userId").is_string() ? body->at("userId").str() : std::string();
  e.validUntilMs = *until;
  return e;
}

std::string entitlement_problem(const std::optional<Entitlement>& e, std::string_view loadWhy, std::string_view required,
                                std::int64_t nowMs) {
  if (required != kPremationCloud) return "requires an unknown entitlement '" + std::string(required) + "'";
  if (!e) return "Requires Premation Cloud (" + std::string(loadWhy) + ")";
  if (e->plan != "pro") return "Requires Premation Cloud (this account's plan does not include it)";
  if (nowMs > e->validUntilMs) return "Requires Premation Cloud (the subscription ended; sign in again after renewing)";
  return {};
}

}  // namespace premation::plugins
