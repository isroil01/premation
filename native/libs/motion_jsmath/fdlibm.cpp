// fdlibm, as V8 carries it (src/base/ieee754.cc), ported for bit parity.
//
// ====================================================
// Copyright (C) 1993-2004 by Sun Microsystems, Inc. All rights reserved.
//
// Permission to use, copy, modify, and distribute this
// software is freely granted, provided that this notice
// is preserved.
// ====================================================
//
// Differences from the C original are mechanical only: word access goes
// through std::bit_cast instead of unions, arrays are std::array/std::span,
// `goto recompute` in __kernel_rem_pio2 is a loop, the "raise inexact"
// comparisons (`huge + x > one`, always true) are dropped because the
// floating-point environment is not observable from JavaScript, and
// `huge * huge` / `tiny * tiny` are written as their values. Every constant is
// given by its bit pattern (the hex that fdlibm documents beside each decimal),
// so no decimal parsing can move a bit.
//
// Every routine keeps its arithmetic order; do not "simplify" an expression
// here without re-running the [jsmath] golden suite.

#include <array>
#include <bit>
#include <cmath>
#include <cstdint>
#include <span>

#include "jsmath.hpp"

// fdlibm IS 32-bit word arithmetic on signed high words (`hx & 0x7fffffff`,
// `hx >> 20`): the signed bitwise operations are the algorithm, transcribed.
// NOLINTBEGIN(bugprone-signed-bitwise, hicpp-signed-bitwise)
namespace motion::js {
namespace {

// ── Word access (fdlibm's EXTRACT_WORDS & friends) ──────────────────────────

[[nodiscard]] constexpr double bits(std::uint32_t hi, std::uint32_t lo) noexcept {
  return std::bit_cast<double>((static_cast<std::uint64_t>(hi) << 32U) | lo);
}
[[nodiscard]] constexpr std::int32_t high_word(double x) noexcept {
  return std::bit_cast<std::int32_t>(static_cast<std::uint32_t>(std::bit_cast<std::uint64_t>(x) >> 32U));
}
[[nodiscard]] constexpr std::uint32_t low_word(double x) noexcept {
  return static_cast<std::uint32_t>(std::bit_cast<std::uint64_t>(x) & 0xffffffffU);
}
[[nodiscard]] constexpr double insert_words(std::int32_t hi, std::uint32_t lo) noexcept {
  return bits(std::bit_cast<std::uint32_t>(hi), lo);
}
[[nodiscard]] constexpr double set_high_word(double x, std::int32_t hi) noexcept {
  return insert_words(hi, low_word(x));
}
[[nodiscard]] constexpr double set_low_word(double x, std::uint32_t lo) noexcept {
  return insert_words(high_word(x), lo);
}
/// `a << n` for a possibly negative int32, as the C source relies on
/// (two's-complement wrap), without the signed-shift UB lint.
[[nodiscard]] constexpr std::int32_t shl(std::int32_t a, std::int32_t n) noexcept {
  return std::bit_cast<std::int32_t>(std::bit_cast<std::uint32_t>(a) << static_cast<std::uint32_t>(n));
}
/// Arithmetic `a >> n` (C++20 defines it; spelled out for the reader).
[[nodiscard]] constexpr std::int32_t sar(std::int32_t a, std::int32_t n) noexcept { return a >> n; }

[[nodiscard]] inline double scalbn(double x, int n) noexcept { return std::ldexp(x, n); }

constexpr double kZero = 0.0;
constexpr double kOne = 1.0;
constexpr double kHalf = 0.5;
constexpr double kTwo24 = bits(0x41700000U, 0U);   // 1.67772160000000000000e+07
constexpr double kTwon24 = bits(0x3E700000U, 0U);  // 5.96046447753906250000e-08
constexpr double kTwo54 = bits(0x43500000U, 0U);   // 1.80143985094819840000e+16

// ── __kernel_sin / __kernel_cos / __kernel_tan ──────────────────────────────

constexpr double S1 = bits(0xBFC55555U, 0x55555549U);
constexpr double S2 = bits(0x3F811111U, 0x1110F8A6U);
constexpr double S3 = bits(0xBF2A01A0U, 0x19C161D5U);
constexpr double S4 = bits(0x3EC71DE3U, 0x57B1FE7DU);
constexpr double S5 = bits(0xBE5AE5E6U, 0x8A2B9CEBU);
constexpr double S6 = bits(0x3DE5D93AU, 0x5ACFD57CU);

double kernel_sin(double x, double y, int iy) noexcept {
  const std::int32_t ix = high_word(x) & 0x7fffffff;
  if (ix < 0x3e400000) {  // |x| < 2**-27
    if (static_cast<int>(x) == 0) return x;
  }
  const double z = x * x;
  const double v = z * x;
  const double r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (iy == 0) return x + v * (S1 + z * r);
  return x - ((z * (kHalf * y - v * r) - y) - v * S1);
}

constexpr double C1 = bits(0x3FA55555U, 0x5555554CU);
constexpr double C2 = bits(0xBF56C16CU, 0x16C15177U);
constexpr double C3 = bits(0x3EFA01A0U, 0x19CB1590U);
constexpr double C4 = bits(0xBE927E4FU, 0x809C52ADU);
constexpr double C5 = bits(0x3E21EE9EU, 0xBDB4B1C4U);
constexpr double C6 = bits(0xBDA8FAE9U, 0xBE8838D4U);

double kernel_cos(double x, double y) noexcept {
  const std::int32_t ix = high_word(x) & 0x7fffffff;
  if (ix < 0x3e400000) {  // |x| < 2**-27
    if (static_cast<int>(x) == 0) return kOne;
  }
  const double z = x * x;
  const double r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ix < 0x3FD33333) {  // |x| < 0.3
    return kOne - (0.5 * z - (z * r - x * y));
  }
  double qx = 0.0;
  if (ix > 0x3fe90000) {  // x > 0.78125
    qx = 0.28125;
  } else {
    qx = insert_words(ix - 0x00200000, 0U);  // x/4
  }
  const double iz = 0.5 * z - qx;
  const double a = kOne - qx;
  return a - (iz - (z * r - x * y));
}

constexpr std::array<double, 16> kTanT = {
    bits(0x3FD55555U, 0x55555563U), bits(0x3FC11111U, 0x1110FE7AU), bits(0x3FABA1BAU, 0x1BB341FEU),
    bits(0x3F9664F4U, 0x8406D637U), bits(0x3F8226E3U, 0xE96E8493U), bits(0x3F6D6D22U, 0xC9560328U),
    bits(0x3F57DBC8U, 0xFEE08315U), bits(0x3F4344D8U, 0xF2F26501U), bits(0x3F3026F7U, 0x1A8D1068U),
    bits(0x3F147E88U, 0xA03792A6U), bits(0x3F12B80FU, 0x32F0A7E9U), bits(0xBEF375CBU, 0xDB605373U),
    bits(0x3EFB2A70U, 0x74BF7AD4U),
    /* one */ bits(0x3FF00000U, 0U),
    /* pio4 */ bits(0x3FE921FBU, 0x54442D18U),
    /* pio4lo */ bits(0x3C81A626U, 0x33145C07U)};

double kernel_tan(double x, double y, int iy) noexcept {
  const auto& T = kTanT;
  const double one = T[13];
  const double pio4 = T[14];
  const double pio4lo = T[15];
  double z = 0.0;
  double r = 0.0;
  double v = 0.0;
  double w = 0.0;
  double s = 0.0;
  const std::int32_t hx = high_word(x);
  const std::int32_t ix = hx & 0x7fffffff;
  if (ix < 0x3e300000) {  // x < 2**-28
    if (static_cast<int>(x) == 0) {
      const std::uint32_t low = low_word(x);
      if ((static_cast<std::uint32_t>(ix) | low | static_cast<std::uint32_t>(iy + 1)) == 0U) {
        return one / std::fabs(x);
      }
      if (iy == 1) return x;
      // compute -1 / (x+y) carefully
      w = x + y;
      z = set_low_word(w, 0U);
      v = y - (z - x);
      const double a = -one / w;
      const double t = set_low_word(a, 0U);
      s = one + t * z;
      return t + a * (s + t * v);
    }
  }
  if (ix >= 0x3FE59428) {  // |x| >= 0.6744
    if (hx < 0) {
      x = -x;
      y = -y;
    }
    z = pio4 - x;
    w = pio4lo - y;
    x = z + w;
    y = 0.0;
  }
  z = x * x;
  w = z * z;
  r = T[1] + w * (T[3] + w * (T[5] + w * (T[7] + w * (T[9] + w * T[11]))));
  v = z * (T[2] + w * (T[4] + w * (T[6] + w * (T[8] + w * (T[10] + w * T[12])))));
  s = z * x;
  r = y + z * (s * (r + v) + y);
  r += T[0] * s;
  w = x + r;
  if (ix >= 0x3FE59428) {
    v = static_cast<double>(iy);
    return static_cast<double>(1 - (sar(hx, 30) & 2)) * (v - 2.0 * (x - (w * w / (w + v) - r)));
  }
  if (iy == 1) return w;
  // compute -1.0 / (x+r) accurately
  z = set_low_word(w, 0U);
  v = r - (z - x);         // z+v = r+x
  const double a = -1.0 / w;  // a = -1.0/w
  const double t = set_low_word(a, 0U);
  s = 1.0 + t * z;
  return t + a * (s + t * v);
}

// ── Argument reduction: __kernel_rem_pio2 / __ieee754_rem_pio2 ──────────────

/// 2/pi in 24-bit chunks (fdlibm `two_over_pi`), 66 of them.
constexpr std::array<std::int32_t, 66> kTwoOverPi = {
    0xA2F983, 0x6E4E44, 0x1529FC, 0x2757D1, 0xF534DD, 0xC0DB62, 0x95993C, 0x439041, 0xFE5163,
    0xABDEBB, 0xC561B7, 0x246E3A, 0x424DD2, 0xE00649, 0x2EEA09, 0xD1921C, 0xFE1DEB, 0x1CB129,
    0xA73EE8, 0x8235F5, 0x2EBB44, 0x84E99C, 0x7026B4, 0x5F7E41, 0x3991D6, 0x398353, 0x39F49C,
    0x845F8B, 0xBDF928, 0x3B1FF8, 0x97FFDE, 0x05980F, 0xEF2F11, 0x8B5A0A, 0x6D1F6D, 0x367ECF,
    0x27CB09, 0xB74F46, 0x3F669E, 0x5FEA2D, 0x7527BA, 0xC7EBE5, 0xF17B3D, 0x0739F7, 0x8A5292,
    0xEA6BFB, 0x5FB11F, 0x8D5D08, 0x560330, 0x46FC7B, 0x6BABF0, 0xCFBC20, 0x9AF436, 0x1DA9E3,
    0x91615E, 0xE61B08, 0x659985, 0x5F14A0, 0x68408D, 0xFFD880, 0x4D7327, 0x310606, 0x1556CA,
    0x73A8C9, 0x60E27B, 0xC08C6B};

constexpr std::array<double, 8> kPIo2 = {
    bits(0x3FF921FBU, 0x40000000U), bits(0x3E74442DU, 0x00000000U),
    bits(0x3CF84698U, 0x80000000U), bits(0x3B78CC51U, 0x60000000U),
    bits(0x39F01B83U, 0x80000000U), bits(0x387A2520U, 0x40000000U),
    bits(0x36E38222U, 0x80000000U), bits(0x3569F31DU, 0x00000000U)};

/// fdlibm k_rem_pio2.c, prec = 2 (the only precision rem_pio2 asks for).
/// Returns n & 7 and writes y[0], y[1].
int kernel_rem_pio2(std::span<const double> x, std::span<double, 2> y, int e0) noexcept {
  constexpr int jk = 4;  // init_jk[prec = 2]
  constexpr int jp = jk;
  const std::span<const std::int32_t> ipio2(kTwoOverPi);
  const std::span<const double> PIo2(kPIo2);

  std::array<std::int32_t, 20> iq_store{};
  std::array<double, 20> f_store{};
  std::array<double, 20> fq_store{};
  std::array<double, 20> q_store{};
  const std::span<std::int32_t> iq(iq_store);
  const std::span<double> f(f_store);
  const std::span<double> fq(fq_store);
  const std::span<double> q(q_store);

  const int nx = static_cast<int>(x.size());
  // determine jx, jv, q0, note that 3 > q0
  const int jx = nx - 1;
  int jv = (e0 - 3) / 24;
  if (jv < 0) jv = 0;
  int q0 = e0 - 24 * (jv + 1);

  // set up f[0] to f[jx+jk] where f[jx+jk] = ipio2[jv+jk]
  {
    int j = jv - jx;
    const int m = jx + jk;
    for (int i = 0; i <= m; ++i, ++j) {
      f[static_cast<std::size_t>(i)] = (j < 0) ? kZero : static_cast<double>(ipio2[static_cast<std::size_t>(j)]);
    }
  }
  const auto X = [&](int i) { return x[static_cast<std::size_t>(i)]; };
  const auto F = [&](int i) -> double& { return f[static_cast<std::size_t>(i)]; };
  const auto Q = [&](int i) -> double& { return q[static_cast<std::size_t>(i)]; };
  const auto IQ = [&](int i) -> std::int32_t& { return iq[static_cast<std::size_t>(i)]; };

  // compute q[0], q[1], ... q[jk]
  for (int i = 0; i <= jk; ++i) {
    double fw = 0.0;
    for (int j = 0; j <= jx; ++j) fw += X(j) * F(jx + i - j);
    Q(i) = fw;
  }

  int jz = jk;
  int n = 0;
  int ih = 0;
  double z = 0.0;
  for (;;) {  // `recompute:` in the C source
    // distill q[] into iq[] reversingly
    {
      int i = 0;
      int j = jz;
      for (z = Q(jz); j > 0; ++i, --j) {
        const auto fw = static_cast<double>(static_cast<std::int32_t>(kTwon24 * z));
        IQ(i) = static_cast<std::int32_t>(z - kTwo24 * fw);
        z = Q(j - 1) + fw;
      }
    }

    // compute n
    z = scalbn(z, q0);            // actual value of z
    z -= 8.0 * std::floor(z * 0.125);  // trim off integer >= 8
    n = static_cast<std::int32_t>(z);
    z -= static_cast<double>(n);
    ih = 0;
    if (q0 > 0) {  // need iq[jz-1] to determine n
      const std::int32_t i = sar(IQ(jz - 1), 24 - q0);
      n += i;
      IQ(jz - 1) -= shl(i, 24 - q0);
      ih = sar(IQ(jz - 1), 23 - q0);
    } else if (q0 == 0) {
      ih = sar(IQ(jz - 1), 23);
    } else if (z >= 0.5) {
      ih = 2;
    }

    if (ih > 0) {  // q > 0.5
      n += 1;
      int carry = 0;
      for (int i = 0; i < jz; ++i) {  // compute 1-q
        const std::int32_t j = IQ(i);
        if (carry == 0) {
          if (j != 0) {
            carry = 1;
            IQ(i) = 0x1000000 - j;
          }
        } else {
          IQ(i) = 0xffffff - j;
        }
      }
      if (q0 > 0) {  // rare case: chance is 1 in 12
        if (q0 == 1) {
          IQ(jz - 1) &= 0x7fffff;
        } else if (q0 == 2) {
          IQ(jz - 1) &= 0x3fffff;
        }
      }
      if (ih == 2) {
        z = kOne - z;
        if (carry != 0) z -= scalbn(kOne, q0);
      }
    }

    // check if recomputation is needed
    if (z == kZero) {
      std::int32_t j = 0;
      for (int i = jz - 1; i >= jk; --i) j |= IQ(i);
      if (j == 0) {  // need recomputation
        int k = 1;
        while (jk >= k && IQ(jk - k) == 0) ++k;  // k = no. of terms needed
        for (int i = jz + 1; i <= jz + k; ++i) {  // add q[jz+1] to q[jz+k]
          F(jx + i) = static_cast<double>(ipio2[static_cast<std::size_t>(jv) + static_cast<std::size_t>(i)]);
          double fw = 0.0;
          for (int jj = 0; jj <= jx; ++jj) fw += X(jj) * F(jx + i - jj);
          Q(i) = fw;
        }
        jz += k;
        continue;  // goto recompute
      }
    }
    break;
  }

  // chop off zero terms
  if (z == 0.0) {
    jz -= 1;
    q0 -= 24;
    while (IQ(jz) == 0) {
      jz--;
      q0 -= 24;
    }
  } else {  // break z into 24-bit if necessary
    z = scalbn(z, -q0);
    if (z >= kTwo24) {
      const auto fw = static_cast<double>(static_cast<std::int32_t>(kTwon24 * z));
      IQ(jz) = static_cast<std::int32_t>(z - kTwo24 * fw);
      jz += 1;
      q0 += 24;
      IQ(jz) = static_cast<std::int32_t>(fw);
    } else {
      IQ(jz) = static_cast<std::int32_t>(z);
    }
  }

  // convert integer "bit" chunk to floating-point value
  double fw = scalbn(kOne, q0);
  for (int i = jz; i >= 0; --i) {
    Q(i) = fw * static_cast<double>(IQ(i));
    fw *= kTwon24;
  }

  // compute PIo2[0,...,jp]*q[jz,...,0]
  for (int i = jz; i >= 0; --i) {
    fw = 0.0;
    for (int k = 0; k <= jp && k <= jz - i; ++k) fw += PIo2[static_cast<std::size_t>(k)] * Q(i + k);
    fq[static_cast<std::size_t>(jz - i)] = fw;
  }

  // compress fq[] into y[] (prec 2)
  fw = 0.0;
  for (int i = jz; i >= 0; --i) fw += fq[static_cast<std::size_t>(i)];
  y[0] = (ih == 0) ? fw : -fw;
  fw = fq[0] - fw;
  for (int i = 1; i <= jz; ++i) fw += fq[static_cast<std::size_t>(i)];
  y[1] = (ih == 0) ? fw : -fw;
  return n & 7;
}

constexpr std::array<std::int32_t, 32> kNpio2Hw = {
    0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C, 0x4025FDBB,
    0x402921FB, 0x402C463A, 0x402F6A7A, 0x4031475C, 0x4032D97C, 0x40346B9C, 0x4035FDBB,
    0x40378FDB, 0x403921FB, 0x403AB41B, 0x403C463A, 0x403DD85A, 0x403F6A7A, 0x40407E4C,
    0x4041475C, 0x4042106C, 0x4042D97C, 0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB,
    0x4046C6CB, 0x40478FDB, 0x404858EB, 0x404921FB};

constexpr double kInvpio2 = bits(0x3FE45F30U, 0x6DC9C883U);
constexpr double kPio2_1 = bits(0x3FF921FBU, 0x54400000U);
constexpr double kPio2_1t = bits(0x3DD0B461U, 0x1A626331U);
constexpr double kPio2_2 = bits(0x3DD0B461U, 0x1A600000U);
constexpr double kPio2_2t = bits(0x3BA3198AU, 0x2E037073U);
constexpr double kPio2_3 = bits(0x3BA3198AU, 0x2E000000U);
constexpr double kPio2_3t = bits(0x397B839AU, 0x252049C1U);

/// fdlibm e_rem_pio2.c. Returns n, writes y = x - n*pi/2 as y[0] + y[1].
std::int32_t ieee754_rem_pio2(double x, std::span<double, 2> y) noexcept {
  const std::int32_t hx = high_word(x);
  const std::int32_t ix = hx & 0x7fffffff;
  if (ix <= 0x3fe921fb) {  // |x| ~<= pi/4, no need for reduction
    y[0] = x;
    y[1] = 0;
    return 0;
  }
  if (ix < 0x4002d97c) {  // |x| < 3pi/4, special case with n=+-1
    if (hx > 0) {
      double z = x - kPio2_1;
      if (ix != 0x3ff921fb) {  // 33+53 bit pi is good enough
        y[0] = z - kPio2_1t;
        y[1] = (z - y[0]) - kPio2_1t;
      } else {  // near pi/2, use 33+33+53 bit pi
        z -= kPio2_2;
        y[0] = z - kPio2_2t;
        y[1] = (z - y[0]) - kPio2_2t;
      }
      return 1;
    }
    // negative x
    double z = x + kPio2_1;
    if (ix != 0x3ff921fb) {
      y[0] = z + kPio2_1t;
      y[1] = (z - y[0]) + kPio2_1t;
    } else {
      z += kPio2_2;
      y[0] = z + kPio2_2t;
      y[1] = (z - y[0]) + kPio2_2t;
    }
    return -1;
  }
  if (ix <= 0x413921fb) {  // |x| ~<= 2^19*(pi/2), medium size
    double t = std::fabs(x);
    const auto n = static_cast<std::int32_t>(t * kInvpio2 + kHalf);
    const auto fn = static_cast<double>(n);
    double r = t - fn * kPio2_1;
    double w = fn * kPio2_1t;  // 1st round good to 85 bit
    if (n < 32 && ix != kNpio2Hw[static_cast<std::size_t>(n - 1)]) {
      y[0] = r - w;  // quick check no cancellation
    } else {
      const std::int32_t j = sar(ix, 20);
      y[0] = r - w;
      std::int32_t i = j - (sar(high_word(y[0]), 20) & 0x7ff);
      if (i > 16) {  // 2nd iteration needed, good to 118
        t = r;
        w = fn * kPio2_2;
        r = t - w;
        w = fn * kPio2_2t - ((t - r) - w);
        y[0] = r - w;
        i = j - (sar(high_word(y[0]), 20) & 0x7ff);
        if (i > 49) {  // 3rd iteration need, 151 bits acc
          t = r;       // will cover all possible cases
          w = fn * kPio2_3;
          r = t - w;
          w = fn * kPio2_3t - ((t - r) - w);
          y[0] = r - w;
        }
      }
    }
    y[1] = (r - y[0]) - w;
    if (hx < 0) {
      y[0] = -y[0];
      y[1] = -y[1];
      return -n;
    }
    return n;
  }
  // all other (large) arguments
  if (ix >= 0x7ff00000) {  // x is inf or NaN
    y[0] = y[1] = x - x;
    return 0;
  }
  // set z = scalbn(|x|, ilogb(x)-23)
  double z = set_low_word(0.0, low_word(x));
  const std::int32_t e0 = sar(ix, 20) - 1046;  // e0 = ilogb(z)-23;
  z = set_high_word(z, ix - shl(e0, 20));
  std::array<double, 3> tx{};
  for (std::size_t i = 0; i < 2; ++i) {
    tx[i] = static_cast<double>(static_cast<std::int32_t>(z));
    z = (z - tx[i]) * kTwo24;
  }
  tx[2] = z;
  std::size_t nx = 3;
  while (tx[nx - 1] == kZero) nx--;  // skip zero term
  const std::int32_t n = kernel_rem_pio2(std::span<const double>(tx).first(nx), y, e0);
  if (hx < 0) {
    y[0] = -y[0];
    y[1] = -y[1];
    return -n;
  }
  return n;
}

// ── Constants shared by exp / log / expm1 / log1p / atan / asin / acos ─────

constexpr double kLn2Hi = bits(0x3FE62E42U, 0xFEE00000U);
constexpr double kLn2Lo = bits(0x3DEA39EFU, 0x35793C76U);
constexpr double kInvLn2 = bits(0x3FF71547U, 0x652B82FEU);
constexpr double kOThreshold = bits(0x40862E42U, 0xFEFA39EFU);
constexpr double kUThreshold = bits(0xC0874910U, 0xD52D3051U);

constexpr double P1 = bits(0x3FC55555U, 0x5555553EU);
constexpr double P2 = bits(0xBF66C16CU, 0x16BEBD93U);
constexpr double P3 = bits(0x3F11566AU, 0xAF25DE2CU);
constexpr double P4 = bits(0xBEBBBD41U, 0xC5D26BF1U);
constexpr double P5 = bits(0x3E663769U, 0x72BEA4D0U);

constexpr double Lg1 = bits(0x3FE55555U, 0x55555593U);
constexpr double Lg2 = bits(0x3FD99999U, 0x9997FA04U);
constexpr double Lg3 = bits(0x3FD24924U, 0x94229359U);
constexpr double Lg4 = bits(0x3FCC71C5U, 0x1D8E78AFU);
constexpr double Lg5 = bits(0x3FC74664U, 0x96CB03DEU);
constexpr double Lg6 = bits(0x3FC39A09U, 0xD078C69FU);
constexpr double Lg7 = bits(0x3FC2F112U, 0xDF3E5244U);

constexpr double kPio2Hi = bits(0x3FF921FBU, 0x54442D18U);
constexpr double kPio2Lo = bits(0x3C91A626U, 0x33145C07U);
constexpr double kPio4Hi = bits(0x3FE921FBU, 0x54442D18U);
constexpr double kPi = bits(0x400921FBU, 0x54442D18U);

constexpr double pS0 = bits(0x3FC55555U, 0x55555555U);
constexpr double pS1 = bits(0xBFD4D612U, 0x03EB6F7DU);
constexpr double pS2 = bits(0x3FC9C155U, 0x0E884455U);
constexpr double pS3 = bits(0xBFA48228U, 0xB5688F3BU);
constexpr double pS4 = bits(0x3F49EFE0U, 0x7501B288U);
constexpr double pS5 = bits(0x3F023DE1U, 0x0DFDF709U);
constexpr double qS1 = bits(0xC0033A27U, 0x1C8A2D4BU);
constexpr double qS2 = bits(0x40002AE5U, 0x9C598AC8U);
constexpr double qS3 = bits(0xBFE6066CU, 0x1B8D0159U);
constexpr double qS4 = bits(0x3FB3B8C5U, 0xB12E9282U);

/// FreeBSD k_log.h `k_log1p(f)`: log(1+f) - f for 1+f in ~[sqrt(2)/2, sqrt(2)].
double k_log1p(double f) noexcept {
  const double s = f / (2.0 + f);
  const double z = s * s;
  const double w = z * z;
  const double t1 = w * (Lg2 + w * (Lg4 + w * Lg6));
  const double t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
  const double R = t2 + t1;
  const double hfsq = 0.5 * f * f;
  return s * (hfsq + R);
}

}  // namespace

// ── sin / cos / tan (fdlibm s_sin.c, s_cos.c, s_tan.c) ──────────────────────

double sin(double x) noexcept {
  const std::int32_t ix = high_word(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernel_sin(x, 0.0, 0);  // |x| ~< pi/4
  if (ix >= 0x7ff00000) return x - x;                   // sin(Inf or NaN) is NaN
  std::array<double, 2> y{};
  const std::int32_t n = ieee754_rem_pio2(x, y);
  switch (n & 3) {
    case 0:
      return kernel_sin(y[0], y[1], 1);
    case 1:
      return kernel_cos(y[0], y[1]);
    case 2:
      return -kernel_sin(y[0], y[1], 1);
    default:
      return -kernel_cos(y[0], y[1]);
  }
}

double cos(double x) noexcept {
  const std::int32_t ix = high_word(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernel_cos(x, 0.0);  // |x| ~< pi/4
  if (ix >= 0x7ff00000) return x - x;               // cos(Inf or NaN) is NaN
  std::array<double, 2> y{};
  const std::int32_t n = ieee754_rem_pio2(x, y);
  switch (n & 3) {
    case 0:
      return kernel_cos(y[0], y[1]);
    case 1:
      return -kernel_sin(y[0], y[1], 1);
    case 2:
      return -kernel_cos(y[0], y[1]);
    default:
      return kernel_sin(y[0], y[1], 1);
  }
}

double tan(double x) noexcept {
  const std::int32_t ix = high_word(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernel_tan(x, 0.0, 1);  // |x| ~< pi/4
  if (ix >= 0x7ff00000) return x - x;                  // tan(Inf or NaN) is NaN
  std::array<double, 2> y{};
  const std::int32_t n = ieee754_rem_pio2(x, y);
  // 1 -- n even, -1 -- n odd
  return kernel_tan(y[0], y[1], 1 - static_cast<int>(shl(n & 1, 1)));
}

// ── asin / acos (fdlibm e_asin.c, e_acos.c) ─────────────────────────────────

double asin(double x) noexcept {
  double t = 0.0;
  const std::int32_t hx = high_word(x);
  const std::int32_t ix = hx & 0x7fffffff;
  if (ix >= 0x3ff00000) {  // |x| >= 1
    const std::uint32_t lx = low_word(x);
    if (((static_cast<std::uint32_t>(ix) - 0x3ff00000U) | lx) == 0U) {
      return x * kPio2Hi + x * kPio2Lo;  // asin(1)=+-pi/2 with inexact
    }
    return kNaN;  // asin(|x|>1) is NaN
  }
  if (ix < 0x3fe00000) {  // |x| < 0.5
    if (ix < 0x3e400000) return x;  // if |x| < 2**-27
    t = x * x;
    const double p = t * (pS0 + t * (pS1 + t * (pS2 + t * (pS3 + t * (pS4 + t * pS5)))));
    const double q = kOne + t * (qS1 + t * (qS2 + t * (qS3 + t * qS4)));
    const double w = p / q;
    return x + x * w;
  }
  // 1 > |x| >= 0.5
  double w = kOne - std::fabs(x);
  t = w * 0.5;
  double p = t * (pS0 + t * (pS1 + t * (pS2 + t * (pS3 + t * (pS4 + t * pS5)))));
  double q = kOne + t * (qS1 + t * (qS2 + t * (qS3 + t * qS4)));
  const double s = std::sqrt(t);
  if (ix >= 0x3FEF3333) {  // if |x| > 0.975
    w = p / q;
    t = kPio2Hi - (2.0 * (s + s * w) - kPio2Lo);
  } else {
    w = set_low_word(s, 0U);
    const double c = (t - w * w) / (s + w);
    const double r = p / q;
    p = 2.0 * s * r - (kPio2Lo - 2.0 * c);
    q = kPio4Hi - 2.0 * w;
    t = kPio4Hi - (p - q);
  }
  return hx > 0 ? t : -t;
}

double acos(double x) noexcept {
  const std::int32_t hx = high_word(x);
  const std::int32_t ix = hx & 0x7fffffff;
  if (ix >= 0x3ff00000) {  // |x| >= 1
    const std::uint32_t lx = low_word(x);
    if (((static_cast<std::uint32_t>(ix) - 0x3ff00000U) | lx) == 0U) {  // |x| == 1
      if (hx > 0) return 0.0;                                         // acos(1) = 0
      return kPi + 2.0 * kPio2Lo;                                     // acos(-1)= pi
    }
    return kNaN;  // acos(|x|>1) is NaN
  }
  if (ix < 0x3fe00000) {                              // |x| < 0.5
    if (ix <= 0x3c600000) return kPio2Hi + kPio2Lo;  // if|x|<2**-57
    const double z = x * x;
    const double p = z * (pS0 + z * (pS1 + z * (pS2 + z * (pS3 + z * (pS4 + z * pS5)))));
    const double q = kOne + z * (qS1 + z * (qS2 + z * (qS3 + z * qS4)));
    const double r = p / q;
    return kPio2Hi - (x - (kPio2Lo - x * r));
  }
  if (hx < 0) {  // x < -0.5
    const double z = (kOne + x) * 0.5;
    const double p = z * (pS0 + z * (pS1 + z * (pS2 + z * (pS3 + z * (pS4 + z * pS5)))));
    const double q = kOne + z * (qS1 + z * (qS2 + z * (qS3 + z * qS4)));
    const double s = std::sqrt(z);
    const double r = p / q;
    const double w = r * s - kPio2Lo;
    return kPi - 2.0 * (s + w);
  }
  // x > 0.5
  const double z = (kOne - x) * 0.5;
  const double s = std::sqrt(z);
  const double df = set_low_word(s, 0U);
  const double c = (z - df * df) / (s + df);
  const double p = z * (pS0 + z * (pS1 + z * (pS2 + z * (pS3 + z * (pS4 + z * pS5)))));
  const double q = kOne + z * (qS1 + z * (qS2 + z * (qS3 + z * qS4)));
  const double r = p / q;
  const double w = r * s + c;
  return 2.0 * (df + w);
}

// ── atan / atan2 (fdlibm s_atan.c, e_atan2.c) ───────────────────────────────

double atan(double x) noexcept {
  static constexpr std::array<double, 4> atanhi = {
      bits(0x3FDDAC67U, 0x0561BB4FU), bits(0x3FE921FBU, 0x54442D18U),
      bits(0x3FEF730BU, 0xD281F69BU), bits(0x3FF921FBU, 0x54442D18U)};
  static constexpr std::array<double, 4> atanlo = {
      bits(0x3C7A2B7FU, 0x222F65E2U), bits(0x3C81A626U, 0x33145C07U),
      bits(0x3C700788U, 0x7AF0CBBDU), bits(0x3C91A626U, 0x33145C07U)};
  static constexpr std::array<double, 11> aT = {
      bits(0x3FD55555U, 0x5555550DU), bits(0xBFC99999U, 0x9998EBC4U), bits(0x3FC24924U, 0x920083FFU),
      bits(0xBFBC71C6U, 0xFE231671U), bits(0x3FB745CDU, 0xC54C206EU), bits(0xBFB3B0F2U, 0xAF749A6DU),
      bits(0x3FB10D66U, 0xA0D03D51U), bits(0xBFADDE2DU, 0x52DEFD9AU), bits(0x3FA97B4BU, 0x24760DEBU),
      bits(0xBFA2B444U, 0x2C6A6C2FU), bits(0x3F90AD3AU, 0xE322DA11U)};

  const std::int32_t hx = high_word(x);
  const std::int32_t ix = hx & 0x7fffffff;
  int id = 0;
  if (ix >= 0x44100000) {  // if |x| >= 2^66
    const std::uint32_t low = low_word(x);
    if (ix > 0x7ff00000 || (ix == 0x7ff00000 && (low != 0U))) return x + x;  // NaN
    if (hx > 0) return atanhi[3] + atanlo[3];
    return -atanhi[3] - atanlo[3];
  }
  if (ix < 0x3fdc0000) {            // |x| < 0.4375
    if (ix < 0x3e400000) return x;  // |x| < 2^-27
    id = -1;
  } else {
    x = std::fabs(x);
    if (ix < 0x3ff30000) {    // |x| < 1.1875
      if (ix < 0x3fe60000) {  // 7/16 <= |x| < 11/16
        id = 0;
        x = (2.0 * x - kOne) / (2.0 + x);
      } else {  // 11/16 <= |x| < 19/16
        id = 1;
        x = (x - kOne) / (x + kOne);
      }
    } else {
      if (ix < 0x40038000) {  // |x| < 2.4375
        id = 2;
        x = (x - 1.5) / (kOne + 1.5 * x);
      } else {  // 2.4375 <= |x| < 2^66
        id = 3;
        x = -1.0 / x;
      }
    }
  }
  // end of argument reduction
  double z = x * x;
  const double w = z * z;
  // break sum from i=0 to 10 aT[i]z**(i+1) into odd and even poly
  const double s1 = z * (aT[0] + w * (aT[2] + w * (aT[4] + w * (aT[6] + w * (aT[8] + w * aT[10])))));
  const double s2 = w * (aT[1] + w * (aT[3] + w * (aT[5] + w * (aT[7] + w * aT[9]))));
  if (id < 0) return x - x * (s1 + s2);
  const auto uid = static_cast<std::size_t>(id);
  z = atanhi[uid] - ((x * (s1 + s2) - atanlo[uid]) - x);
  return (hx < 0) ? -z : z;
}

double atan2(double y, double x) noexcept {
  constexpr double tiny = 1.0e-300;
  constexpr double pi_o_4 = bits(0x3FE921FBU, 0x54442D18U);
  constexpr double pi_o_2 = bits(0x3FF921FBU, 0x54442D18U);
  constexpr double pi_lo = bits(0x3CA1A626U, 0x33145C07U);

  const std::int32_t hx = high_word(x);
  const std::uint32_t lx = low_word(x);
  const std::int32_t ix = hx & 0x7fffffff;
  const std::int32_t hy = high_word(y);
  const std::uint32_t ly = low_word(y);
  const std::int32_t iy = hy & 0x7fffffff;
  const auto nz = [](std::uint32_t v) { return static_cast<std::int32_t>((v | (0U - v)) >> 31U); };
  if ((ix | nz(lx)) > 0x7ff00000 || (iy | nz(ly)) > 0x7ff00000) return x + y;  // x or y is NaN
  if (((static_cast<std::uint32_t>(hx) - 0x3ff00000U) | lx) == 0U) return atan(y);  // x=1.0
  const std::int32_t m = (sar(hy, 31) & 1) | (sar(hx, 30) & 2);  // 2*sign(x)+sign(y)

  // when y = 0
  if ((static_cast<std::uint32_t>(iy) | ly) == 0U) {
    switch (m) {
      case 0:
      case 1:
        return y;  // atan(+-0,+anything)=+-0
      case 2:
        return kPi + tiny;  // atan(+0,-anything) = pi
      default:
        return -kPi - tiny;  // atan(-0,-anything) =-pi
    }
  }
  // when x = 0
  if ((static_cast<std::uint32_t>(ix) | lx) == 0U) return (hy < 0) ? -pi_o_2 - tiny : pi_o_2 + tiny;

  // when x is INF
  if (ix == 0x7ff00000) {
    if (iy == 0x7ff00000) {
      switch (m) {
        case 0:
          return pi_o_4 + tiny;  // atan(+INF,+INF)
        case 1:
          return -pi_o_4 - tiny;  // atan(-INF,+INF)
        case 2:
          return 3.0 * pi_o_4 + tiny;  // atan(+INF,-INF)
        default:
          return -3.0 * pi_o_4 - tiny;  // atan(-INF,-INF)
      }
    }
    switch (m) {
      case 0:
        return kZero;  // atan(+...,+INF)
      case 1:
        return -kZero;  // atan(-...,+INF)
      case 2:
        return kPi + tiny;  // atan(+...,-INF)
      default:
        return -kPi - tiny;  // atan(-...,-INF)
    }
  }
  // when y is INF
  if (iy == 0x7ff00000) return (hy < 0) ? -pi_o_2 - tiny : pi_o_2 + tiny;

  // compute y/x
  const std::int32_t k = sar(iy - ix, 20);
  double z = 0.0;
  std::int32_t mm = m;
  if (k > 60) {  // |y/x| > 2**60
    z = pi_o_2 + 0.5 * pi_lo;
    mm &= 1;
  } else if (hx < 0 && k < -60) {
    z = 0.0;  // 0 > |y|/x > -2**-60
  } else {
    z = atan(std::fabs(y / x));  // safe to do y/x
  }
  switch (mm) {
    case 0:
      return z;  // atan(+,+)
    case 1:
      return -z;  // atan(-,+)
    case 2:
      return kPi - (z - pi_lo);  // atan(+,-)
    default:
      return (z - pi_lo) - kPi;  // atan(-,-)
  }
}

// ── exp / expm1 (fdlibm e_exp.c, s_expm1.c as V8 has them) ─────────────────

double exp(double x) noexcept {
  constexpr std::array<double, 2> halF = {0.5, -0.5};
  constexpr std::array<double, 2> ln2HI = {kLn2Hi, -kLn2Hi};
  constexpr std::array<double, 2> ln2LO = {kLn2Lo, -kLn2Lo};
  constexpr double E = bits(0x4005BF0AU, 0x8B145769U);
  constexpr double twom1000 = bits(0x01700000U, 0U);
  constexpr double two1023 = bits(0x7FE00000U, 0U);

  double y = 0.0;
  double hi = 0.0;
  double lo = 0.0;
  double t = 0.0;
  double twopk = 0.0;
  std::int32_t k = 0;
  const auto uhx = std::bit_cast<std::uint32_t>(high_word(x));
  const auto xsb = static_cast<std::size_t>((uhx >> 31U) & 1U);  // sign bit of x
  const std::uint32_t hx = uhx & 0x7fffffffU;                    // high word of |x|

  // filter out non-finite argument
  if (hx >= 0x40862E42U) {  // if |x| >= 709.78...
    if (hx >= 0x7ff00000U) {
      const std::uint32_t lx = low_word(x);
      if (((hx & 0xfffffU) | lx) != 0U) return x + x;  // NaN
      return (xsb == 0) ? x : 0.0;                     // exp(+-inf)={inf,0}
    }
    if (x > kOThreshold) return kInf;  // overflow
    if (x < kUThreshold) return 0.0;   // underflow
  }

  // argument reduction
  if (hx > 0x3fd62e42U) {    // if |x| > 0.5 ln2
    if (hx < 0x3FF0A2B2U) {  // and |x| < 1.5 ln2
      // V8 special-cases exp(1): the reduction below gets the last bit of E wrong.
      if (x == 1.0) return E;
      hi = x - ln2HI[xsb];
      lo = ln2LO[xsb];
      k = 1 - static_cast<std::int32_t>(xsb) - static_cast<std::int32_t>(xsb);
    } else {
      k = static_cast<std::int32_t>(kInvLn2 * x + halF[xsb]);
      t = static_cast<double>(k);
      hi = x - t * ln2HI[0];  // t*ln2HI is exact here
      lo = t * ln2LO[0];
    }
    x = hi - lo;
  } else if (hx < 0x3e300000U) {  // when |x| < 2**-28
    return kOne + x;
  } else {
    k = 0;
  }

  // x is now in primary range
  t = x * x;
  if (k >= -1021) {
    twopk = insert_words(0x3ff00000 + shl(k, 20), 0U);
  } else {
    twopk = insert_words(0x3ff00000 + shl(k + 1000, 20), 0U);
  }
  const double c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k == 0) return kOne - ((x * c) / (c - 2.0) - x);
  y = kOne - ((lo - (x * c) / (2.0 - c)) - hi);
  if (k >= -1021) {
    if (k == 1024) return y * 2.0 * two1023;
    return y * twopk;
  }
  return y * twopk * twom1000;
}

double expm1(double x) noexcept {
  constexpr double Q1 = bits(0xBFA11111U, 0x111110F4U);
  constexpr double Q2 = bits(0x3F5A01A0U, 0x19FE5585U);
  constexpr double Q3 = bits(0xBF14CE19U, 0x9EAADBB7U);
  constexpr double Q4 = bits(0x3ED0CFCAU, 0x86E65239U);
  constexpr double Q5 = bits(0xBE8AFDB7U, 0x6E09C32DU);
  constexpr double two1023 = bits(0x7FE00000U, 0U);

  double y = 0.0;
  double hi = 0.0;
  double lo = 0.0;
  double c = 0.0;
  double t = 0.0;
  std::int32_t k = 0;
  const auto uhx = std::bit_cast<std::uint32_t>(high_word(x));
  const std::uint32_t xsb = uhx & 0x80000000U;  // sign bit of x
  const std::uint32_t hx = uhx & 0x7fffffffU;   // high word of |x|

  // filter out huge and non-finite argument
  if (hx >= 0x4043687AU) {    // if |x| >= 56*ln2
    if (hx >= 0x40862E42U) {  // if |x| >= 709.78...
      if (hx >= 0x7ff00000U) {
        const std::uint32_t low = low_word(x);
        if (((hx & 0xfffffU) | low) != 0U) return x + x;  // NaN
        return (xsb == 0U) ? x : -1.0;                    // exp(+-inf)={inf,-1}
      }
      if (x > kOThreshold) return kInf;  // overflow
    }
    if (xsb != 0U) return -1.0;  // x < -56*ln2, return -1.0 with inexact
  }

  // argument reduction
  if (hx > 0x3fd62e42U) {    // if |x| > 0.5 ln2
    if (hx < 0x3FF0A2B2U) {  // and |x| < 1.5 ln2
      if (xsb == 0U) {
        hi = x - kLn2Hi;
        lo = kLn2Lo;
        k = 1;
      } else {
        hi = x + kLn2Hi;
        lo = -kLn2Lo;
        k = -1;
      }
    } else {
      k = static_cast<std::int32_t>(kInvLn2 * x + ((xsb == 0U) ? 0.5 : -0.5));
      t = static_cast<double>(k);
      hi = x - t * kLn2Hi;  // t*ln2_hi is exact here
      lo = t * kLn2Lo;
    }
    x = hi - lo;
    c = (hi - x) - lo;
  } else if (hx < 0x3c900000U) {  // when |x| < 2**-54, return x
    return x;
  } else {
    k = 0;
  }

  // x is now in primary range
  const double hfx = 0.5 * x;
  const double hxs = x * hfx;
  const double r1 = kOne + hxs * (Q1 + hxs * (Q2 + hxs * (Q3 + hxs * (Q4 + hxs * Q5))));
  t = 3.0 - r1 * hfx;
  double e = hxs * ((r1 - t) / (6.0 - x * t));
  if (k == 0) return x - (x * e - hxs);  // c is 0
  const double twopk = insert_words(0x3ff00000 + shl(k, 20), 0U);  // add k to y's exponent
  e = (x * (e - c) - c);
  e -= hxs;
  if (k == -1) return 0.5 * (x - e) - 0.5;
  if (k == 1) {
    if (x < -0.25) return -2.0 * (e - (x + 0.5));
    return kOne + 2.0 * (x - e);
  }
  if (k <= -2 || k > 56) {  // suffice to return exp(x)-1
    y = kOne - (e - x);
    if (k == 1024) {
      y = y * 2.0 * two1023;
    } else {
      y = y * twopk;
    }
    return y - kOne;
  }
  t = kOne;
  if (k < 20) {
    t = set_high_word(t, 0x3ff00000 - sar(0x200000, k));  // t=1-2^-k
    y = t - (e - x);
    y = y * twopk;
  } else {
    t = set_high_word(t, shl(0x3ff - k, 20));  // 2^-k
    y = x - (e + t);
    y += kOne;
    y = y * twopk;
  }
  return y;
}

// ── log family (FreeBSD e_log.c, s_log1p.c, e_log2.c; fdlibm e_log10.c) ────

double log(double x) noexcept {
  std::int32_t hx = high_word(x);
  const std::uint32_t lx = low_word(x);
  std::int32_t k = 0;
  if (hx < 0x00100000) {  // x < 2**-1022
    if ((static_cast<std::uint32_t>(hx & 0x7fffffff) | lx) == 0U) return -kInf;  // log(+-0)=-inf
    if (hx < 0) return kNaN;  // log(-#) = NaN
    k -= 54;
    x *= kTwo54;  // subnormal number, scale up x
    hx = high_word(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  k += sar(hx, 20) - 1023;
  hx &= 0x000fffff;
  std::int32_t i = (hx + 0x95f64) & 0x100000;
  x = set_high_word(x, hx | (i ^ 0x3ff00000));  // normalize x or x/2
  k += sar(i, 20);
  const double f = x - 1.0;
  if ((0x000fffff & (2 + hx)) < 3) {  // -2**-20 <= f < 2**-20
    if (f == kZero) {
      if (k == 0) return kZero;
      const auto dk = static_cast<double>(k);
      return dk * kLn2Hi + dk * kLn2Lo;
    }
    const double R = f * f * (0.5 - 0.33333333333333333 * f);
    if (k == 0) return f - R;
    const auto dk = static_cast<double>(k);
    return dk * kLn2Hi - ((R - dk * kLn2Lo) - f);
  }
  const double s = f / (2.0 + f);
  const auto dk = static_cast<double>(k);
  const double z = s * s;
  i = hx - 0x6147a;
  const double w = z * z;
  const std::int32_t j = 0x6b851 - hx;
  const double t1 = w * (Lg2 + w * (Lg4 + w * Lg6));
  const double t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
  i |= j;
  const double R = t2 + t1;
  if (i > 0) {
    const double hfsq = 0.5 * f * f;
    if (k == 0) return f - (hfsq - s * (hfsq + R));
    return dk * kLn2Hi - ((hfsq - (s * (hfsq + R) + dk * kLn2Lo)) - f);
  }
  if (k == 0) return f - s * (f - R);
  return dk * kLn2Hi - ((s * (f - R) - dk * kLn2Lo) - f);
}

double log1p(double x) noexcept {
  const std::int32_t hx = high_word(x);
  const std::int32_t ax = hx & 0x7fffffff;
  double f = 0.0;
  double c = 0.0;
  std::int32_t hu = 0;
  std::int32_t k = 1;
  if (hx < 0x3FDA827A) {     // 1+x < sqrt(2)+
    if (ax >= 0x3ff00000) {  // x <= -1.0
      if (x == -1.0) return -kInf;  // log1p(-1)=-inf
      return kNaN;                  // log1p(x<-1)=NaN
    }
    if (ax < 0x3e200000) {  // |x| < 2**-29
      if (ax < 0x3c900000) return x;  // |x| < 2**-54
      return x - x * x * 0.5;
    }
    if (hx > 0 || hx <= std::bit_cast<std::int32_t>(0xbfd2bec4U)) {  // sqrt(2)/2- <= 1+x < sqrt(2)+
      k = 0;
      f = x;
      hu = 1;
    }
  } else if (hx >= 0x7ff00000) {
    return x + x;
  }
  if (k != 0) {
    double u = 0.0;
    if (hx < 0x43400000) {
      u = 1.0 + x;
      hu = high_word(u);
      k = sar(hu, 20) - 1023;
      c = (k > 0) ? 1.0 - (u - x) : x - (u - 1.0);  // correction term
      c /= u;
    } else {
      u = x;
      hu = high_word(u);
      k = sar(hu, 20) - 1023;
      c = 0;
    }
    hu &= 0x000fffff;
    if (hu < 0x6a09e) {                  // u ~< sqrt(2)
      u = set_high_word(u, hu | 0x3ff00000);  // normalize u
    } else {
      k += 1;
      u = set_high_word(u, hu | 0x3fe00000);  // normalize u/2
      hu = sar(0x00100000 - hu, 2);
    }
    f = u - 1.0;
  }
  constexpr double Lp1 = Lg1;
  constexpr double Lp2 = Lg2;
  constexpr double Lp3 = Lg3;
  constexpr double Lp4 = Lg4;
  constexpr double Lp5 = Lg5;
  constexpr double Lp6 = Lg6;
  constexpr double Lp7 = Lg7;
  const double hfsq = 0.5 * f * f;
  const auto dk = static_cast<double>(k);
  if (hu == 0) {  // |f| < 2**-20
    if (f == kZero) {
      if (k == 0) return kZero;
      c += dk * kLn2Lo;
      return dk * kLn2Hi + c;
    }
    const double R = hfsq * (1.0 - 0.66666666666666666 * f);
    if (k == 0) return f - R;
    return dk * kLn2Hi - ((R - (dk * kLn2Lo + c)) - f);
  }
  const double s = f / (2.0 + f);
  const double z = s * s;
  const double R = z * (Lp1 + z * (Lp2 + z * (Lp3 + z * (Lp4 + z * (Lp5 + z * (Lp6 + z * Lp7))))));
  if (k == 0) return f - (hfsq - s * (hfsq + R));
  return dk * kLn2Hi - ((hfsq - (s * (hfsq + R) + (dk * kLn2Lo + c))) - f);
}

double log2(double x) noexcept {
  constexpr double ivln2hi = bits(0x3FF71547U, 0x65200000U);
  constexpr double ivln2lo = bits(0x3DE705FCU, 0x2EEFA200U);
  std::int32_t hx = high_word(x);
  const std::uint32_t lx = low_word(x);
  std::int32_t k = 0;
  if (hx < 0x00100000) {  // x < 2**-1022
    if ((static_cast<std::uint32_t>(hx & 0x7fffffff) | lx) == 0U) return -kInf;  // log(+-0)=-inf
    if (hx < 0) return kNaN;  // log(-#) = NaN
    k -= 54;
    x *= kTwo54;  // subnormal number, scale up x
    hx = high_word(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  if (hx == 0x3ff00000 && lx == 0U) return kZero;  // log(1) = +0
  k += sar(hx, 20) - 1023;
  hx &= 0x000fffff;
  const std::int32_t i = (hx + 0x95f64) & 0x100000;
  x = set_high_word(x, hx | (i ^ 0x3ff00000));  // normalize x or x/2
  k += sar(i, 20);
  const auto y = static_cast<double>(k);
  const double f = x - 1.0;
  const double hfsq = 0.5 * f * f;
  const double r = k_log1p(f);
  double hi = f - hfsq;
  hi = set_low_word(hi, 0U);
  const double lo = (f - hi) - hfsq + r;
  double val_hi = hi * ivln2hi;
  double val_lo = (lo + hi) * ivln2lo + lo * ivln2hi;
  // spadd(val_hi, val_lo, y), except for not using double_t:
  const double w = y + val_hi;
  val_lo += (y - w) + val_hi;
  val_hi = w;
  return val_lo + val_hi;
}

double log10(double x) noexcept {
  constexpr double ivln10 = bits(0x3FDBCB7BU, 0x1526E50EU);
  constexpr double log10_2hi = bits(0x3FD34413U, 0x509F6000U);
  constexpr double log10_2lo = bits(0x3D59FEF3U, 0x11F12B36U);
  std::int32_t hx = high_word(x);
  std::uint32_t lx = low_word(x);
  std::int32_t k = 0;
  if (hx < 0x00100000) {  // x < 2**-1022
    if ((static_cast<std::uint32_t>(hx & 0x7fffffff) | lx) == 0U) return -kInf;  // log(+-0)=-inf
    if (hx < 0) return kNaN;  // log(-#) = NaN
    k -= 54;
    x *= kTwo54;  // subnormal number, scale up x
    hx = high_word(x);
    lx = low_word(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  if (hx == 0x3ff00000 && lx == 0U) return 0;  // log(1) = +0
  k += sar(hx, 20) - 1023;
  const auto i = static_cast<std::int32_t>((std::bit_cast<std::uint32_t>(k) & 0x80000000U) >> 31U);
  hx = (hx & 0x000fffff) | shl(0x3ff - i, 20);
  const auto y = static_cast<double>(k + i);
  x = insert_words(hx, lx);
  const double z = y * log10_2lo + ivln10 * log(x);
  return z + y * log10_2hi;
}

// ── Hyperbolic (V8's own sinh/cosh; fdlibm tanh, asinh, acosh, atanh) ───────

double sinh(double x) noexcept {
  constexpr double KSINH_OVERFLOW = 710.4758600739439;
  constexpr double TWO_M28 = 3.725290298461914e-9;  // 2^-28, empty lower half
  constexpr double LOG_MAXD = 709.7822265625;       // 0x40862E42 00000000, empty lower half
  constexpr double shuge = 1.0e307;

  const double h = (x < 0) ? -0.5 : 0.5;
  // |x| in [0, 22]. return sign(x)*0.5*(E+E/(E+1))
  const double ax = std::fabs(x);
  if (ax < 22) {
    // For |x| < 2^-28, sinh(x) = x
    if (ax < TWO_M28) return x;
    const double t = expm1(ax);
    if (ax < 1) return h * (2.0 * t - t * t / (t + 1.0));
    return h * (t + t / (t + 1.0));
  }
  // |x| in [22, log(maxdouble)], return 0.5 * exp(|x|)
  if (ax < LOG_MAXD) return h * exp(ax);
  // |x| in [log(maxdouble), overflowthreshold]
  if (ax <= KSINH_OVERFLOW) {
    const double w = exp(0.5 * ax);
    const double t = h * w;
    return t * w;
  }
  // |x| > overflowthreshold or x = NaN, return inf; NaN from NaN.
  return x * shuge;
}

double cosh(double x) noexcept {
  constexpr double KCOSH_OVERFLOW = 710.4758600739439;
  const std::int32_t ix = high_word(x) & 0x7fffffff;  // High word of |x|.

  // |x| in [0,0.5*log2], return 1+expm1(|x|)^2/(2*exp(|x|))
  if (ix < 0x3fd62e43) {
    const double t = expm1(std::fabs(x));
    const double w = kOne + t;
    // For |x| < 2^-55, cosh(x) = 1
    if (ix < 0x3c800000) return w;
    return kOne + (t * t) / (w + w);
  }
  // |x| in [0.5*log2, 22], return (exp(|x|)+1/exp(|x|)/2
  if (ix < 0x40360000) {
    const double t = exp(std::fabs(x));
    return kHalf * t + kHalf / t;
  }
  // |x| in [22, log(maxdouble)], return half*exp(|x|)
  if (ix < 0x40862e42) return kHalf * exp(std::fabs(x));
  // |x| in [log(maxdouble), overflowthreshhold]
  if (std::fabs(x) <= KCOSH_OVERFLOW) {
    const double w = exp(kHalf * std::fabs(x));
    const double t = kHalf * w;
    return t * w;
  }
  // x is INF or NaN
  if (ix >= 0x7ff00000) return x * x;
  // |x| > overflowthreshold.
  return kInf;
}

double tanh(double x) noexcept {
  constexpr double tiny = 1.0e-300;
  const std::int32_t jx = high_word(x);
  const std::int32_t ix = jx & 0x7fffffff;
  // x is INF or NaN
  if (ix >= 0x7ff00000) {
    if (jx >= 0) return kOne / x + kOne;  // tanh(+-inf)=+-1
    return kOne / x - kOne;               // tanh(NaN) = NaN
  }
  double z = 0.0;
  if (ix < 0x40360000) {            // |x| < 22
    if (ix < 0x3e300000) return x;  // |x| < 2**-28
    if (ix >= 0x3ff00000) {         // |x| >= 1
      const double t = expm1(2.0 * std::fabs(x));
      z = kOne - 2.0 / (t + 2.0);
    } else {
      const double t = expm1(-2.0 * std::fabs(x));
      z = -t / (t + 2.0);
    }
  } else {  // |x| >= 22, return +-1
    z = kOne - tiny;
  }
  return (jx >= 0) ? z : -z;
}

double asinh(double x) noexcept {
  constexpr double ln2 = bits(0x3FE62E42U, 0xFEFA39EFU);
  const std::int32_t hx = high_word(x);
  const std::int32_t ix = hx & 0x7fffffff;
  if (ix >= 0x7ff00000) return x + x;  // x is inf or NaN
  if (ix < 0x3e300000) return x;       // |x| < 2**-28
  double w = 0.0;
  if (ix > 0x41b00000) {  // |x| > 2**28
    w = log(std::fabs(x)) + ln2;
  } else if (ix > 0x40000000) {  // 2**28 > |x| > 2.0
    const double t = std::fabs(x);
    w = log(2.0 * t + kOne / (std::sqrt(x * x + kOne) + t));
  } else {  // 2.0 > |x| > 2**-28
    const double t = x * x;
    w = log1p(std::fabs(x) + t / (kOne + std::sqrt(kOne + t)));
  }
  return hx > 0 ? w : -w;
}

double acosh(double x) noexcept {
  constexpr double ln2 = bits(0x3FE62E42U, 0xFEFA39EFU);
  const std::int32_t hx = high_word(x);
  const std::uint32_t lx = low_word(x);
  if (hx < 0x3ff00000) return kNaN;  // x < 1
  if (hx >= 0x41b00000) {            // x > 2**28
    if (hx >= 0x7ff00000) return x + x;  // x is inf of NaN
    return log(x) + ln2;                 // acosh(huge)=log(2x)
  }
  if (((static_cast<std::uint32_t>(hx) - 0x3ff00000U) | lx) == 0U) return 0.0;  // acosh(1) = 0
  if (hx > 0x40000000) {  // 2**28 > x > 2
    const double t = x * x;
    return log(2.0 * x - kOne / (x + std::sqrt(t - kOne)));
  }
  // 1 < x < 2
  const double t = x - kOne;
  return log1p(t + std::sqrt(2.0 * t + t * t));
}

double atanh(double x) noexcept {
  const std::int32_t hx = high_word(x);
  const std::uint32_t lx = low_word(x);
  const std::int32_t ix = hx & 0x7fffffff;
  if ((ix | static_cast<std::int32_t>((lx | (0U - lx)) >> 31U)) > 0x3ff00000) return kNaN;  // |x|>1
  if (ix == 0x3ff00000) return x > 0 ? kInf : -kInf;
  if (ix < 0x3e300000) return x;  // x < 2**-28
  x = set_high_word(x, ix);
  double t = 0.0;
  if (ix < 0x3fe00000) {  // x < 0.5
    t = x + x;
    t = 0.5 * log1p(t + t * x / (kOne - x));
  } else {
    t = 0.5 * log1p((x + x) / (kOne - x));
  }
  return hx >= 0 ? t : -t;
}

// ── cbrt (FreeBSD s_cbrt.c) ──────────────────────────────────────────────────

double cbrt(double x) noexcept {
  constexpr std::uint32_t B1 = 715094163;  // B1 = (1023-1023/3-0.03306235651)*2**20
  constexpr std::uint32_t B2 = 696219795;  // B2 = (1023-1023/3-54/3-0.03306235651)*2**20
  constexpr double P0 = bits(0x3ffe03e6U, 0x0f61e692U);
  constexpr double Pc1 = bits(0xbffe28e0U, 0x92f02420U);
  constexpr double Pc2 = bits(0x3ff9f160U, 0x4a49d6c2U);
  constexpr double Pc3 = bits(0xbfe844cbU, 0xbee751d9U);
  constexpr double Pc4 = bits(0x3fc2b000U, 0xd4e4edd7U);

  auto hx = std::bit_cast<std::uint32_t>(high_word(x));
  const std::uint32_t low = low_word(x);
  const std::uint32_t sign = hx & 0x80000000U;  // sign= sign(x)
  hx ^= sign;
  if (hx >= 0x7ff00000U) return x + x;  // cbrt(NaN,INF) is itself

  double t = 0.0;
  if (hx < 0x00100000U) {           // zero or subnormal?
    if ((hx | low) == 0U) return x;  // cbrt(0) is itself
    t = set_high_word(t, 0x43500000);  // set t= 2**54
    t *= x;
    const auto high = std::bit_cast<std::uint32_t>(high_word(t));
    t = bits(sign | ((high & 0x7fffffffU) / 3U + B2), 0U);
  } else {
    t = bits(sign | (hx / 3U + B1), 0U);
  }

  // New cbrt to 23 bits: cbrt(x) = t*cbrt(x/t**3) ~= t*P(t**3/x)
  double r = (t * t) * (t / x);
  t = t * ((P0 + r * (Pc1 + r * Pc2)) + ((r * r) * r) * (Pc3 + r * Pc4));

  // Round t away from zero to 23 bits.
  auto ubits = std::bit_cast<std::uint64_t>(t);
  ubits = (ubits + 0x80000000ULL) & 0xffffffffc0000000ULL;
  t = std::bit_cast<double>(ubits);

  // one step Newton iteration to 53 bits with error < 0.667 ulps
  const double s = t * t;  // t*t is exact
  r = x / s;               // error <= 0.5 ulps; |r| < |t|
  const double w = t + t;  // t+t is exact
  r = (r - t) / (w + r);   // r-t is exact; w+r ~= 3*t
  t = t + t * r;           // error <= 0.5 + 0.5/3 + epsilon
  return t;
}

// ── pow ──────────────────────────────────────────────────────────────────────
//
// NOT fdlibm. V8's `Math.pow` hands the general case to the PLATFORM libm
// (std::pow), after ECMAScript's own special cases and two fast paths. That was
// established by measurement, not by reading: over 40k golden inputs an fdlibm
// e_pow.c port differed from Node on 4.6% of them (e.g. pow(4.5, -3),
// pow(0.9999999999999999, -1)), while `std::pow` plus the rules below matched
// every one on Windows (UCRT). Consequence, flagged in native/README.md: the
// TypeScript engine's `Math.pow` is not the same function on Windows, Linux
// and macOS, so neither is this one — it matches the TS engine running on the
// same OS, which is the parity that can exist.
double pow(double x, double y) noexcept {
  if (std::isnan(y)) return kNaN;                              // 1 ** NaN is NaN in JS
  if ((x == 1 || x == -1) && std::isinf(y)) return kNaN;       // (+-1) ** +-Infinity is NaN in JS
  if (y == 2) return x * x;                                    // V8 fast path
  if (y == 0.5) {                                              // V8 fast path, minus sqrt's -0 / -Inf
    if (x == 0) return 0.0;
    if (x == -kInf) return kInf;
    return std::sqrt(x);
  }
  return std::pow(x, y);
}

// ── Helpers declared in jsmath.hpp ──────────────────────────────────────────

std::uint32_t to_uint32(double x) noexcept {
  if (!std::isfinite(x) || x == 0) return 0U;
  const double t = std::trunc(x);
  // t mod 2^32, exact: fmod is exact and 2^32 is representable.
  double m = std::fmod(t, 4294967296.0);
  if (m < 0) m += 4294967296.0;
  return static_cast<std::uint32_t>(m);
}

double max_of(std::span<const double> v) noexcept {
  double r = -kInf;
  bool nan = false;
  for (const double d : v) {
    if (std::isnan(d)) {
      nan = true;
    } else if (d > r || (d == 0 && r == 0 && !std::signbit(d))) {
      r = d;
    }
  }
  return nan ? kNaN : r;
}

double min_of(std::span<const double> v) noexcept {
  double r = kInf;
  bool nan = false;
  for (const double d : v) {
    if (std::isnan(d)) {
      nan = true;
    } else if (d < r || (d == 0 && r == 0 && std::signbit(d))) {
      r = d;
    }
  }
  return nan ? kNaN : r;
}

double hypot(std::span<const double> v) noexcept {
  if (v.empty()) return 0;
  bool one_arg_is_nan = false;
  double max = 0;
  for (const double d : v) {
    if (std::isnan(d)) {
      one_arg_is_nan = true;
    } else {
      const double a = std::fabs(d);
      if (a > max) max = a;
    }
  }
  if (max == kInf) return kInf;
  if (one_arg_is_nan) return kNaN;
  if (max == 0) return 0;
  // Kahan summation to avoid rounding errors; normalise to the largest to avoid overflow.
  double sum = 0;
  double compensation = 0;
  for (const double d : v) {
    const double n = std::fabs(d) / max;
    const double summand = n * n - compensation;
    const double preliminary = sum + summand;
    compensation = (preliminary - sum) - summand;
    sum = preliminary;
  }
  return std::sqrt(sum) * max;
}

}  // namespace motion::js
// NOLINTEND(bugprone-signed-bitwise, hicpp-signed-bitwise)
