// ECMAScript Number ⇄ String — see numconv.hpp.
//
// Everything reduces to one exact question — "is D × 10^K above, below or on
// N × 2^F?" — answered with a small arbitrary-precision unsigned integer. With
// that, parsing is a binary search over the doubles, shortest formatting is
// "does this candidate lie inside the double's rounding interval", and the
// fixed-digit methods are exact rounding of the double's full decimal
// expansion (every double has a finite one).
//
// None of this is on the per-frame path of a numeric expression. It runs when
// an expression builds a string from a number, compares a string with a
// number, or when a literal is parsed at compile time.

#include "numconv.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace motion::js {
namespace {

// ── BigUint: little-endian base-2^32 magnitude ──────────────────────────────

class BigUint {
 public:
  BigUint() = default;
  explicit BigUint(std::uint64_t v) {
    while (v != 0) {
      limbs_.push_back(static_cast<std::uint32_t>(v & 0xffffffffU));
      v >>= 32U;
    }
  }

  [[nodiscard]] bool is_zero() const noexcept { return limbs_.empty(); }

  void mul_small(std::uint32_t m) {
    if (m == 0) {
      limbs_.clear();
      return;
    }
    std::uint64_t carry = 0;
    for (std::uint32_t& l : limbs_) {
      const std::uint64_t p = static_cast<std::uint64_t>(l) * m + carry;
      l = static_cast<std::uint32_t>(p & 0xffffffffU);
      carry = p >> 32U;
    }
    if (carry != 0) limbs_.push_back(static_cast<std::uint32_t>(carry));
  }

  void add_small(std::uint32_t a) {
    std::uint64_t carry = a;
    for (std::uint32_t& l : limbs_) {
      if (carry == 0) return;
      const std::uint64_t s = static_cast<std::uint64_t>(l) + carry;
      l = static_cast<std::uint32_t>(s & 0xffffffffU);
      carry = s >> 32U;
    }
    if (carry != 0) limbs_.push_back(static_cast<std::uint32_t>(carry));
  }

  void add(const BigUint& o) {
    if (o.limbs_.size() > limbs_.size()) limbs_.resize(o.limbs_.size(), 0U);
    std::uint64_t carry = 0;
    for (std::size_t i = 0; i < limbs_.size(); ++i) {
      const std::uint64_t s =
          static_cast<std::uint64_t>(limbs_[i]) + (i < o.limbs_.size() ? o.limbs_[i] : 0U) + carry;
      limbs_[i] = static_cast<std::uint32_t>(s & 0xffffffffU);
      carry = s >> 32U;
    }
    if (carry != 0) limbs_.push_back(static_cast<std::uint32_t>(carry));
  }

  void mul_u64(std::uint64_t m) {
    const auto lo = static_cast<std::uint32_t>(m & 0xffffffffU);
    const auto hi = static_cast<std::uint32_t>(m >> 32U);
    if (hi == 0) {
      mul_small(lo);
      return;
    }
    BigUint high = *this;
    high.mul_small(hi);
    high.shl(32);
    mul_small(lo);
    add(high);
  }

  void mul_pow10(int k) {
    while (k >= 9) {
      mul_small(1000000000U);
      k -= 9;
    }
    static constexpr std::array<std::uint32_t, 9> kPow = {1U, 10U, 100U, 1000U, 10000U,
                                                          100000U, 1000000U, 10000000U, 100000000U};
    if (k > 0) mul_small(kPow[static_cast<std::size_t>(k)]);
  }

  void mul_pow5(int k) {
    while (k >= 13) {
      mul_small(1220703125U);  // 5^13
      k -= 13;
    }
    std::uint32_t p = 1;
    for (int i = 0; i < k; ++i) p *= 5U;
    mul_small(p);
  }

  void shl(int bits) {
    if (is_zero() || bits <= 0) return;
    const auto words = static_cast<std::size_t>(bits / 32);
    const auto rem = static_cast<std::uint32_t>(bits % 32);
    if (rem != 0) {
      std::uint32_t carry = 0;
      for (std::uint32_t& l : limbs_) {
        const std::uint32_t next = l >> (32U - rem);
        l = (l << rem) | carry;
        carry = next;
      }
      if (carry != 0) limbs_.push_back(carry);
    }
    if (words != 0) limbs_.insert(limbs_.begin(), words, 0U);
  }

  /// this /= d, returns the remainder. d > 0.
  std::uint32_t divmod_small(std::uint32_t d) {
    std::uint64_t rem = 0;
    for (std::size_t i = limbs_.size(); i-- > 0;) {
      const std::uint64_t cur = (rem << 32U) | limbs_[i];
      limbs_[i] = static_cast<std::uint32_t>(cur / d);
      rem = cur % d;
    }
    trim();
    return static_cast<std::uint32_t>(rem);
  }

  [[nodiscard]] std::string to_decimal() const {
    if (is_zero()) return "0";
    BigUint t = *this;
    std::vector<std::uint32_t> chunks;
    while (!t.is_zero()) chunks.push_back(t.divmod_small(1000000000U));
    std::string out = std::to_string(chunks.back());
    for (std::size_t i = chunks.size() - 1; i-- > 0;) {
      std::string c = std::to_string(chunks[i]);
      out.append(9 - c.size(), '0');
      out += c;
    }
    return out;
  }

  static BigUint from_decimal(std::string_view digits) {
    BigUint b;
    std::size_t i = 0;
    const std::size_t head = digits.size() % 9;
    auto chunk = [&](std::size_t n) {
      std::uint32_t v = 0;
      for (std::size_t j = 0; j < n; ++j) v = v * 10U + static_cast<std::uint32_t>(digits[i + j] - '0');
      i += n;
      return v;
    };
    if (head != 0) b.add_small(chunk(head));
    while (i < digits.size()) {
      b.mul_small(1000000000U);
      b.add_small(chunk(9));
    }
    return b;
  }

  friend int compare(const BigUint& a, const BigUint& b) noexcept {
    if (a.limbs_.size() != b.limbs_.size()) return a.limbs_.size() < b.limbs_.size() ? -1 : 1;
    for (std::size_t i = a.limbs_.size(); i-- > 0;) {
      if (a.limbs_[i] != b.limbs_[i]) return a.limbs_[i] < b.limbs_[i] ? -1 : 1;
    }
    return 0;
  }

  [[nodiscard]] int bit_length() const noexcept {
    if (is_zero()) return 0;
    return static_cast<int>((limbs_.size() - 1) * 32) + (32 - std::countl_zero(limbs_.back()));
  }

  /// Bit `i` (0 = least significant).
  [[nodiscard]] bool bit(int i) const noexcept {
    const auto w = static_cast<std::size_t>(i / 32);
    if (w >= limbs_.size()) return false;
    return ((limbs_[w] >> static_cast<std::uint32_t>(i % 32)) & 1U) != 0;
  }

  /// Any bit below `i` set?
  [[nodiscard]] bool any_below(int i) const noexcept {
    for (int j = 0; j < i; ++j) {
      if (bit(j)) return true;
    }
    return false;
  }

 private:
  void trim() {
    while (!limbs_.empty() && limbs_.back() == 0) limbs_.pop_back();
  }
  std::vector<std::uint32_t> limbs_;
};

// ── Doubles as M × 2^E ──────────────────────────────────────────────────────

struct Decomposed {
  std::uint64_t m = 0;  // significand (implicit bit included for normals)
  int e = 0;            // x = m × 2^e
};

Decomposed decompose(double x) noexcept {  // x >= 0, finite
  const auto b = std::bit_cast<std::uint64_t>(x);
  const auto biased = static_cast<int>((b >> 52U) & 0x7ffU);
  const std::uint64_t frac = b & ((std::uint64_t{1} << 52U) - 1U);
  if (biased == 0) return {.m = frac, .e = -1074};
  return {.m = frac | (std::uint64_t{1} << 52U), .e = biased - 1075};
}

/// Sign of D × 10^K − N × 2^F.
int cmp_dec_bin(const BigUint& D, int K, std::uint64_t N, int F) {
  BigUint L = D;
  if (K > 0) L.mul_pow10(K);
  BigUint R(N);
  if (K < 0) R.mul_pow10(-K);
  if (F > 0) R.shl(F);
  if (F < 0) L.shl(-F);
  return compare(L, R);
}

/// Correctly rounded D × 10^K (D > 0) — binary search over the positive
/// doubles (ordered like their bit patterns), then round-half-even at the
/// midpoint to the next one.
double decimal_to_double(const BigUint& D, int K) {
  // Callers bound digits + K to ±400, so the search space is finite.
  // Hoist the parts that do not depend on the candidate.
  BigUint L0 = D;
  if (K > 0) L0.mul_pow10(K);
  BigUint R0(1);
  if (K < 0) R0.mul_pow10(-K);
  const auto cmp = [&](std::uint64_t m, int f) {  // sign of V − m × 2^f
    BigUint L = L0;
    BigUint R = R0;
    R.mul_u64(m);
    if (f > 0) R.shl(f);
    if (f < 0) L.shl(-f);
    return compare(L, R);
  };
  constexpr std::uint64_t kInfBits = 0x7FF0000000000000ULL;
  std::uint64_t lo = 0;         // value(lo) <= V
  std::uint64_t hi = kInfBits;  // value(hi) > V (Infinity)
  while (hi - lo > 1) {
    const std::uint64_t mid = lo + (hi - lo) / 2;
    const Decomposed d = decompose(std::bit_cast<double>(mid));
    if (cmp(d.m, d.e) >= 0) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const Decomposed d = decompose(std::bit_cast<double>(lo));
  if (cmp(d.m, d.e) == 0) return std::bit_cast<double>(lo);
  const int c = cmp(2 * d.m + 1, d.e - 1);  // midpoint to the next double
  std::uint64_t pick = lo;
  if (c > 0 || (c == 0 && (lo & 1U) != 0)) pick = lo + 1;
  return std::bit_cast<double>(pick);  // lo + 1 == kInfBits is Infinity
}

// ── Exact decimal expansion ─────────────────────────────────────────────────

/// x = 0.D × 10^n, D without leading or trailing zeros. x > 0, finite.
struct Digits {
  std::string d;
  int n = 0;
};

Digits exact_digits(double x) {
  const Decomposed dec = decompose(x);
  BigUint N(dec.m);
  int exp10 = 0;  // x = N × 10^exp10
  if (dec.e >= 0) {
    N.shl(dec.e);
  } else {
    N.mul_pow5(-dec.e);
    exp10 = dec.e;
  }
  std::string s = N.to_decimal();
  const int len = static_cast<int>(s.size());
  while (!s.empty() && s.back() == '0') s.pop_back();
  return {.d = std::move(s), .n = len + exp10};
}

enum class Tie : std::uint8_t { kEven, kUp };

/// Increment a decimal digit string in place; returns true on overflow
/// ("999" → "000", caller prepends the 1).
bool increment(std::string& s) {
  for (std::size_t i = s.size(); i-- > 0;) {
    if (s[i] != '9') {
      ++s[i];
      return false;
    }
    s[i] = '0';
  }
  return true;
}

/// round(0.D × 10^e) as a decimal integer string ("0" when it rounds to 0).
std::string round_to_integer(const Digits& x, int e, Tie tie) {
  const std::string& D = x.d;
  const int len = static_cast<int>(D.size());
  if (e < 0) return "0";
  std::string ip;
  bool up = false;
  if (e == 0) {
    ip = "0";
    const char first = D[0];
    if (first > '5' || (first == '5' && len > 1)) {
      up = true;
    } else if (first == '5') {
      up = (tie == Tie::kUp);  // tie: even keeps 0
    }
  } else {
    if (len <= e) {
      ip = D;
      ip.append(static_cast<std::size_t>(e - len), '0');
      return ip;
    }
    ip = D.substr(0, static_cast<std::size_t>(e));
    const char first = D[static_cast<std::size_t>(e)];
    if (first > '5' || (first == '5' && len > e + 1)) {
      up = true;
    } else if (first == '5') {
      up = (tie == Tie::kUp) || ((static_cast<unsigned>(ip.back() - '0') & 1U) != 0U);
    }
  }
  if (up) {
    if (ip == "0") return "1";
    if (increment(ip)) ip.insert(ip.begin(), '1');
  }
  return ip;
}

std::string strip_trailing_zeros(std::string s) {
  while (s.size() > 1 && s.back() == '0') s.pop_back();
  return s;
}

/// Is C × 10^K inside x's round-to-nearest-even interval?
bool round_trips(const Decomposed& x, const std::string& C, int K) {
  const BigUint c = BigUint::from_decimal(C);
  const bool inclusive = (x.m & 1U) == 0;
  const int hi = cmp_dec_bin(c, K, 2 * x.m + 1, x.e - 1);
  if (hi > 0 || (hi == 0 && !inclusive)) return false;
  int lo = 0;
  if (x.m == (std::uint64_t{1} << 52U) && x.e > -1074) {
    lo = cmp_dec_bin(c, K, 4 * x.m - 1, x.e - 2);  // lower neighbour is half as far
  } else {
    lo = cmp_dec_bin(c, K, 2 * x.m - 1, x.e - 1);
  }
  return lo > 0 || (lo == 0 && inclusive);
}

/// Number::toString's digits: shortest round-tripping s, closest to x, ties
/// to even. x > 0, finite.
Digits shortest_digits(double x) {
  const Decomposed dx = decompose(x);
  const Digits ex = exact_digits(x);
  const int len = static_cast<int>(ex.d.size());
  for (int p = 1; p < len; ++p) {
    const std::string c1 = round_to_integer(ex, p, Tie::kEven);
    const std::string trunc = ex.d.substr(0, static_cast<std::size_t>(p));
    const auto accept = [&](const std::string& c) -> Digits {
      // c is p digits, or p+1 digits after a carry ("10…0").
      const int n = ex.n + static_cast<int>(c.size()) - p;
      return {.d = strip_trailing_zeros(c), .n = n};
    };
    if (round_trips(dx, c1, ex.n - p)) return accept(c1);
    std::string c2 = trunc;
    if (c1 == trunc) {
      if (increment(c2)) c2.insert(c2.begin(), '1');
    }
    if (c2 != c1 && round_trips(dx, c2, ex.n - p)) return accept(c2);
  }
  return Digits{ex};
}

std::string exponent_suffix(int e) {
  std::string out = "e";
  out += e < 0 ? '-' : '+';
  out += std::to_string(e < 0 ? -e : e);
  return out;
}

bool is_js_whitespace(char16_t c) noexcept {
  switch (c) {
    case 0x09: case 0x0A: case 0x0B: case 0x0C: case 0x0D: case 0x20: case 0xA0:
    case 0x1680: case 0x2028: case 0x2029: case 0x202F: case 0x205F: case 0x3000: case 0xFEFF:
      return true;
    default:
      return c >= 0x2000 && c <= 0x200A;
  }
}

/// Correctly rounded conversion of a big integer (non-decimal literals).
double biguint_to_double(const BigUint& v) {
  const int bl = v.bit_length();
  if (bl == 0) return 0.0;
  if (bl > 1024) return std::numeric_limits<double>::infinity();
  if (bl <= 53) {
    double r = 0;
    for (int i = bl - 1; i >= 0; --i) r = r * 2 + (v.bit(i) ? 1 : 0);
    return r;
  }
  // Top 53 bits, then round half to even on the rest.
  std::uint64_t m = 0;
  for (int i = bl - 1; i >= bl - 53; --i) m = (m << 1U) | (v.bit(i) ? 1U : 0U);
  const int shift = bl - 53;
  const bool half = v.bit(shift - 1);
  const bool sticky = v.any_below(shift - 1);
  if (half && (sticky || (m & 1U) != 0)) ++m;
  return std::ldexp(static_cast<double>(m), shift);
}

double parse_trimmed_ascii(std::string_view s) {
  constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
  if (s.empty()) return 0.0;
  // Non-decimal integer literals: no sign allowed.
  if (s.size() > 2 && s[0] == '0') {
    int radix = 0;
    if (s[1] == 'x' || s[1] == 'X') radix = 16;
    if (s[1] == 'o' || s[1] == 'O') radix = 8;
    if (s[1] == 'b' || s[1] == 'B') radix = 2;
    if (radix != 0) {
      BigUint v;
      for (std::size_t i = 2; i < s.size(); ++i) {
        const char c = s[i];
        int d = -1;
        if (c >= '0' && c <= '9') d = c - '0';
        if (c >= 'a' && c <= 'z') d = c - 'a' + 10;
        if (c >= 'A' && c <= 'Z') d = c - 'A' + 10;
        if (d < 0 || d >= radix) return kNaN;
        v.mul_small(static_cast<std::uint32_t>(radix));
        v.add_small(static_cast<std::uint32_t>(d));
      }
      return biguint_to_double(v);
    }
  }
  std::size_t i = 0;
  bool negative = false;
  if (s[0] == '+' || s[0] == '-') {
    negative = s[0] == '-';
    i = 1;
  }
  const std::string_view rest = s.substr(i);
  if (rest == "Infinity") return negative ? -std::numeric_limits<double>::infinity() : std::numeric_limits<double>::infinity();
  std::string digits;
  int frac_digits = 0;
  bool any_digit = false;
  while (i < s.size() && s[i] >= '0' && s[i] <= '9') {
    digits += s[i++];
    any_digit = true;
  }
  if (i < s.size() && s[i] == '.') {
    ++i;
    while (i < s.size() && s[i] >= '0' && s[i] <= '9') {
      digits += s[i++];
      ++frac_digits;
      any_digit = true;
    }
  }
  if (!any_digit) return kNaN;
  long long exp10 = 0;
  if (i < s.size() && (s[i] == 'e' || s[i] == 'E')) {
    ++i;
    bool eneg = false;
    if (i < s.size() && (s[i] == '+' || s[i] == '-')) {
      eneg = s[i] == '-';
      ++i;
    }
    bool any_exp = false;
    while (i < s.size() && s[i] >= '0' && s[i] <= '9') {
      if (exp10 < 100000000) exp10 = exp10 * 10 + (s[i] - '0');
      ++i;
      any_exp = true;
    }
    if (!any_exp) return kNaN;
    if (eneg) exp10 = -exp10;
  }
  if (i != s.size()) return kNaN;
  // Strip leading zeros; an all-zero mantissa is ±0 whatever the exponent.
  const std::size_t nz = digits.find_first_not_of('0');
  if (nz == std::string::npos) return negative ? -0.0 : 0.0;
  digits.erase(0, nz);
  // Strip trailing zeros into the exponent (keeps the big integer small).
  long long k = exp10 - frac_digits;
  while (digits.size() > 1 && digits.back() == '0') {
    digits.pop_back();
    ++k;
  }
  const long long total = static_cast<long long>(digits.size()) + k;
  double v = 0.0;
  // Clinger's fast path: an integer mantissa below 2^53 times an EXACT power of
  // ten (10^0..10^22) is a single correctly rounded IEEE multiply or divide —
  // the same double the big-integer search finds, without the search. Covers
  // every literal a person types ("40", "0.5", "1e-3").
  static constexpr std::array<double, 23> kPow10 = {1e0,  1e1,  1e2,  1e3,  1e4,  1e5,  1e6,  1e7,
                                                    1e8,  1e9,  1e10, 1e11, 1e12, 1e13, 1e14, 1e15,
                                                    1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22};
  if (digits.size() <= 15 && k >= -22 && k <= 22) {
    std::uint64_t m = 0;
    for (const char c : digits) m = m * 10 + static_cast<std::uint64_t>(c - '0');
    const auto dm = static_cast<double>(m);  // exact: m < 10^15 < 2^53
    v = k >= 0 ? dm * kPow10[static_cast<std::size_t>(k)] : dm / kPow10[static_cast<std::size_t>(-k)];
    return negative ? -v : v;
  }
  if (total > 400) {
    v = std::numeric_limits<double>::infinity();
  } else if (total < -400) {
    v = 0.0;
  } else {
    v = decimal_to_double(BigUint::from_decimal(digits), static_cast<int>(k));
  }
  return negative ? -v : v;
}

}  // namespace

// ── Public API ──────────────────────────────────────────────────────────────

std::string number_to_string(double x) {
  if (std::isnan(x)) return "NaN";
  if (x == 0) return "0";
  if (std::isinf(x)) return x > 0 ? "Infinity" : "-Infinity";
  std::string sign;
  if (x < 0) {
    sign = "-";
    x = -x;
  }
  if (x < 9007199254740992.0 && std::trunc(x) == x) {  // exact small integer
    return sign + std::to_string(static_cast<std::uint64_t>(x));
  }
  const Digits sd = shortest_digits(x);
  const std::string& s = sd.d;
  const int k = static_cast<int>(s.size());
  const int n = sd.n;
  std::string out = sign;
  if (k <= n && n <= 21) {
    out += s;
    out.append(static_cast<std::size_t>(n - k), '0');
  } else if (0 < n && n <= 21) {
    out += s.substr(0, static_cast<std::size_t>(n));
    out += '.';
    out += s.substr(static_cast<std::size_t>(n));
  } else if (-6 < n && n <= 0) {
    out += "0.";
    out.append(static_cast<std::size_t>(-n), '0');
    out += s;
  } else {
    out += s[0];
    if (k > 1) {
      out += '.';
      out += s.substr(1);
    }
    out += exponent_suffix(n - 1);
  }
  return out;
}

std::string to_fixed(double x, int f) {
  if (std::isnan(x)) return "NaN";
  if (std::fabs(x) >= 1e21) return number_to_string(x);
  std::string sign;
  if (x < 0) {
    sign = "-";
    x = -x;
  }
  std::string m = "0";
  if (x != 0) {
    const Digits ex = exact_digits(x);
    m = round_to_integer(ex, ex.n + f, Tie::kUp);
  }
  if (f != 0) {
    int k = static_cast<int>(m.size());
    if (k <= f) {
      m.insert(0, static_cast<std::size_t>(f + 1 - k), '0');
      k = f + 1;
    }
    m = m.substr(0, static_cast<std::size_t>(k - f)) + "." + m.substr(static_cast<std::size_t>(k - f));
  }
  return sign + m;
}

std::string to_exponential(double x, int f) {
  if (!std::isfinite(x)) return number_to_string(x);
  std::string sign;
  if (x < 0) {
    sign = "-";
    x = -x;
  }
  std::string m;
  int e = 0;
  if (x == 0) {
    m.assign(static_cast<std::size_t>(f < 0 ? 1 : f + 1), '0');
    if (f < 0) f = 0;
  } else if (f >= 0) {
    const Digits ex = exact_digits(x);
    m = round_to_integer(ex, f + 1, Tie::kUp);
    e = ex.n - 1;
    if (static_cast<int>(m.size()) > f + 1) {  // carry: 99.9 → 100
      m.pop_back();
      ++e;
    }
  } else {
    const Digits sd = shortest_digits(x);
    m = sd.d;
    f = static_cast<int>(m.size()) - 1;
    e = sd.n - 1;
  }
  if (f != 0) m = m.substr(0, 1) + "." + m.substr(1);
  return sign + m + exponent_suffix(e);
}

std::string to_precision(double x, int p) {
  if (!std::isfinite(x)) return number_to_string(x);
  std::string sign;
  if (x < 0) {
    sign = "-";
    x = -x;
  }
  std::string m;
  int e = 0;
  if (x == 0) {
    m.assign(static_cast<std::size_t>(p), '0');
  } else {
    const Digits ex = exact_digits(x);
    m = round_to_integer(ex, p, Tie::kUp);
    e = ex.n - 1;
    if (std::cmp_greater(m.size(), p)) {
      m.pop_back();
      ++e;
    }
    if (e < -6 || e >= p) {
      std::string out = sign + m.substr(0, 1);
      if (p != 1) out += "." + m.substr(1);
      return out + exponent_suffix(e);
    }
  }
  if (e == p - 1) return sign + m;
  if (e >= 0) {
    const auto cut = static_cast<std::size_t>(e) + 1;
    return sign + m.substr(0, cut) + "." + m.substr(cut);
  }
  return sign + "0." + std::string(static_cast<std::size_t>(-(e + 1)), '0') + m;
}

std::string number_to_radix(double value, int radix) {
  if (std::isnan(value)) return "NaN";
  if (std::isinf(value)) return value > 0 ? "Infinity" : "-Infinity";
  static constexpr std::string_view kChars = "0123456789abcdefghijklmnopqrstuvwxyz";
  const auto next_double = [](double v) {
    return std::nextafter(v, std::numeric_limits<double>::infinity());
  };
  // V8 Double::Exponent(): x = significand × 2^exponent.
  const auto exponent_of = [](double v) {
    const auto b = std::bit_cast<std::uint64_t>(v);
    const auto biased = static_cast<int>((b >> 52U) & 0x7ffU);
    if (biased == 0) return -1074;
    return biased - 1075;
  };
  const auto r = static_cast<double>(radix);
  std::string fraction_part;
  std::string integer_part;
  const bool negative = value < 0;
  if (negative) value = -value;

  double integer = std::floor(value);
  double fraction = value - integer;
  // We only compute fractional digits up to the input double's precision.
  double delta = 0.5 * (next_double(value) - value);
  delta = std::max(next_double(0.0), delta);
  if (fraction >= delta) {
    fraction_part += '.';
    for (;;) {
      // Shift up by one digit.
      fraction *= r;
      delta *= r;
      // Write digit.
      const int digit = static_cast<int>(fraction);
      fraction_part += kChars[static_cast<std::size_t>(digit)];
      // Calculate remainder.
      fraction -= digit;
      // Round to even.
      if (fraction > 0.5 || (fraction == 0.5 && (static_cast<unsigned>(digit) & 1U) != 0U)) {
        if (fraction + delta > 1) {
          // We need to back trace already written digits in case of carry-over.
          for (;;) {
            if (fraction_part.size() == 1) {
              // Only the '.' is left: carry over to the integer part and
              // drop the fraction (V8's cursor stops on the '.').
              fraction_part.clear();
              integer += 1;
              break;
            }
            const char c = fraction_part.back();
            // Reconstruct digit.
            const int d = c > '9' ? (c - 'a' + 10) : (c - '0');
            if (d + 1 < radix) {
              fraction_part.back() = kChars[static_cast<std::size_t>(d) + 1];
              break;
            }
            fraction_part.pop_back();
          }
          break;
        }
      }
      if (!(fraction >= delta)) break;
    }
  }
  // Compute integer digits. Fill unrepresented digits with zero.
  while (exponent_of(integer / r) > 0) {
    integer /= r;
    integer_part += '0';
  }
  for (;;) {
    const double remainder = std::fmod(integer, r);
    integer_part += kChars[static_cast<std::size_t>(static_cast<int>(remainder))];
    integer = (integer - remainder) / r;
    if (!(integer > 0)) break;
  }
  if (negative) integer_part += '-';
  std::ranges::reverse(integer_part);
  return integer_part + fraction_part;
}

double string_to_number(std::u16string_view s) {
  std::size_t b = 0;
  std::size_t e = s.size();
  while (b < e && is_js_whitespace(s[b])) ++b;
  while (e > b && is_js_whitespace(s[e - 1])) --e;
  std::string ascii;
  ascii.reserve(e - b);
  for (std::size_t i = b; i < e; ++i) {
    if (s[i] > 0x7F) return std::numeric_limits<double>::quiet_NaN();
    ascii += static_cast<char>(s[i]);
  }
  return parse_trimmed_ascii(ascii);
}

double string_to_number(std::string_view s) {
  std::u16string wide;
  wide.reserve(s.size());
  for (const char c : s) wide += static_cast<char16_t>(static_cast<unsigned char>(c));
  return string_to_number(std::u16string_view(wide));
}

}  // namespace motion::js
