// Port of src/core/effects/aeRoundSevenSimulation.ts — CC Particle Systems II
// and CC Bubbles. Both are closed form (a particle is a function of its index,
// the seed and the time / evolution), drawn in index order; threads split
// OUTPUT rows and each replays every particle in that order, clipped to its
// rows.
#include <algorithm>
#include <array>
#include <cmath>
#include <vector>

#include "kernels.hpp"
#include "noise_hash.hpp"

namespace premation::effects {

namespace {

constexpr double kPi = 3.141592653589793;
constexpr double kMaxParticles = 512;

double hyp(double a, double b) { return jhypot2(a, b); }

struct Particle {
  double x, y, size, r, g, b, alpha;
};

/// `particleAt(i, time, o)`; false when unborn or expired.
bool particle_at(double i, double time, const ParticleOptions& o, Particle& p) {
  const double rate = std::max(0.0001, o.birth_rate);
  const double jitter = hash2(i, o.seed + 3) - 0.5;
  const double birth = (i + jitter * 0.8) / rate;
  const double age = time - birth;
  if (age < 0 || age > o.longevity) return false;
  const double h1 = hash2(i, o.seed);
  const double h2 = hash2(i, o.seed + 101);
  const double h3 = hash2(i, o.seed + 211);
  const double h4 = hash2(i, o.seed + 307);
  const double angle0 = h1 * kPi * 2;
  const double rad0 = std::sqrt(h2);
  const double x0 = o.producer_x + js::cos(angle0) * o.producer_radius_x * rad0;
  const double y0 = o.producer_y + js::sin(angle0) * o.producer_radius_y * rad0;
  double dir = 0;
  const double spread = (o.spread * kPi) / 180;
  if (o.animation == 0) {
    dir = h3 * kPi * 2;
  } else {
    const double base = (o.direction * kPi) / 180;
    dir = base + (h3 - 0.5) * spread;
  }
  const double speed = o.velocity * (1 + (h4 - 0.5) * 2 * clamp01(o.velocity_variation / 100));
  const double vx = js::cos(dir) * speed;
  const double vy = js::sin(dir) * speed;
  const double r = o.resistance;
  double px = 0;
  double py = 0;
  if (r > 0.0001) {
    const double decay = (1 - js::exp(-r * age)) / r;
    px = x0 + vx * decay;
    py = y0 + vy * decay;
  } else {
    px = x0 + vx * age;
    py = y0 + vy * age;
  }
  py += 0.5 * o.gravity * age * age;
  const double life_t = clamp01(age / std::max(0.0001, o.longevity));
  const double size_var = 1 + (hash2(i, o.seed + 401) - 0.5) * 2 * clamp01(o.size_variation / 100);
  const double size = std::max(0.1, (o.birth_size + (o.death_size - o.birth_size) * life_t) * size_var);
  const double alpha = clamp01(o.opacity / 100) * (1 - life_t * life_t);
  p = Particle{px,
               py,
               size,
               o.birth.r + (o.death.r - o.birth.r) * life_t,
               o.birth.g + (o.death.g - o.birth.g) * life_t,
               o.birth.b + (o.death.b - o.birth.b) * life_t,
               alpha};
  return true;
}

}  // namespace

void particle_systems(RgbaView img, double time, const ParticleOptions& o, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  if (o.birth_rate <= 0 || time < 0) return;
  const double rate = std::max(0.0001, o.birth_rate);
  const double first = std::max(0.0, std::floor((time - o.longevity) * rate) - 1);
  const double last = std::min(std::floor(time * rate) + 1, first + kMaxParticles - 1);
  std::vector<Particle> live;
  for (double i = first; i <= last; ++i) {
    Particle p{};
    if (!particle_at(i, time, o, p) || p.alpha <= 0) continue;
    live.push_back(p);
  }
  if (live.empty()) return;
  std::uint8_t* out = img.data.data();
  const bool add = o.blend == 0;
  for_rows(pool, h, [&](int ry0, int ry1) {
    for (const Particle& p : live) {
      const double px = w / 2.0 + p.x;
      const double py = h / 2.0 + p.y;
      const double rad = p.size / 2;
      const double fx0 = std::max(0.0, std::floor(px - rad));
      const double fx1 = std::min(static_cast<double>(w - 1), std::ceil(px + rad));
      const double fy0 = std::max(static_cast<double>(ry0), std::floor(py - rad));
      const double fy1 = std::min(static_cast<double>(ry1 - 1), std::ceil(py + rad));
      if (!(fx0 <= fx1) || !(fy0 <= fy1)) continue;
      const double inv = std::max(0.0001, rad);
      for (int y = static_cast<int>(fy0); y <= static_cast<int>(fy1); ++y) {
        for (int x = static_cast<int>(fx0); x <= static_cast<int>(fx1); ++x) {
          const double d = hyp(x + 0.5 - px, y + 0.5 - py);
          if (d > rad) continue;
          const double t = d / inv;
          const double cover = t < 0.6 ? 1 : 0.5 + 0.5 * js::cos(((t - 0.6) / 0.4) * kPi);
          const double a = clamp01(p.alpha * cover);
          if (a <= 0) continue;
          std::uint8_t* q = out + idx4(x, y, w);
          if (add) {
            q[0] = u8c(q[0] + p.r * a);
            q[1] = u8c(q[1] + p.g * a);
            q[2] = u8c(q[2] + p.b * a);
            q[3] = u8c(std::max(static_cast<double>(q[3]), a * 255));
          } else {
            q[0] = u8c(q[0] * (1 - a) + p.r * a);
            q[1] = u8c(q[1] * (1 - a) + p.g * a);
            q[2] = u8c(q[2] * (1 - a) + p.b * a);
            q[3] = u8c(q[3] * (1 - a) + 255 * a);
          }
        }
      }
    }
  });
}

void bubbles(RgbaView img, const BubbleOptions& o, ThreadPool* pool) {
  const int w = img.w;
  const int h = img.h;
  const double count = std::max(0.0, js::round(o.amount));
  if (count == 0 || o.opacity <= 0) return;
  const double cell = std::max(4.0, std::sqrt((static_cast<double>(w) * h) / std::max(1.0, count)));
  const double cols = std::max(1.0, std::ceil(w / cell));
  const double rows = std::max(1.0, std::ceil(h / cell));
  const double sd = std::floor(o.seed);
  const double base_alpha = clamp01(o.opacity / 100);
  const double span = h + o.size * 2;
  struct Bubble {
    double px, py, rad;
  };
  std::vector<Bubble> list;
  for (double row = 0; row < rows; ++row) {
    for (double ci = 0; ci < cols; ++ci) {
      const double id = row * cols + ci;
      if (id >= count) continue;
      const double speed = 0.5 + hash2(id, sd + 23);
      const double size_var = 1 + (hash2(id, sd + 51) - 0.5) * 2 * clamp01(o.size_variation / 100);
      const double rad = std::max(0.5, (o.size * size_var) / 2);
      const double x0 = (ci + hash2(id, sd)) * cell;
      const double y0 = (row + hash2(id, sd + 11)) * cell;
      const double rise = (o.evolution / 100) * o.speed * speed;
      const double wobble = js::sin(o.evolution / 40 + id * 1.7) * o.wobble_amplitude *
                            (0.5 + 0.5 * js::sin(id + o.evolution * o.wobble_frequency / 500));
      const double px = x0 + wobble;
      const double py = std::fmod(std::fmod(y0 - rise, span) + span, span) - o.size;
      list.push_back(Bubble{px, py, rad});
    }
  }
  std::uint8_t* out = img.data.data();
  for_rows(pool, h, [&](int ry0, int ry1) {
    for (const Bubble& bb : list) {
      const double fxa = std::max(0.0, std::floor(bb.px - bb.rad));
      const double fxb = std::min(static_cast<double>(w - 1), std::ceil(bb.px + bb.rad));
      const double fya = std::max(static_cast<double>(ry0), std::floor(bb.py - bb.rad));
      const double fyb = std::min(static_cast<double>(ry1 - 1), std::ceil(bb.py + bb.rad));
      if (!(fxa <= fxb) || !(fya <= fyb)) continue;
      const double inv = std::max(0.0001, bb.rad);
      for (int y = static_cast<int>(fya); y <= static_cast<int>(fyb); ++y) {
        for (int x = static_cast<int>(fxa); x <= static_cast<int>(fxb); ++x) {
          const double dx = x + 0.5 - bb.px;
          const double dy = y + 0.5 - bb.py;
          const double d = hyp(dx, dy);
          if (d > bb.rad) continue;
          const double t = d / inv;
          double cover = 0;
          if (o.shading == 1) {
            cover = t;
          } else if (o.shading == 2) {
            const double nz = std::sqrt(std::max(0.0, 1 - t * t));
            cover = clamp01(0.25 + 0.75 * (nz * 0.6 + (-dx / bb.rad) * 0.2 + (-dy / bb.rad) * 0.2));
          } else {
            cover = 1 - t;
          }
          if (t > 0.9) cover *= (1 - t) / 0.1;
          const double a = clamp01(base_alpha * cover);
          if (a <= 0) continue;
          std::uint8_t* q = out + idx4(x, y, w);
          q[0] = u8c(q[0] * (1 - a) + o.color.r * a);
          q[1] = u8c(q[1] * (1 - a) + o.color.g * a);
          q[2] = u8c(q[2] * (1 - a) + o.color.b * a);
          q[3] = u8c(q[3] * (1 - a) + 255 * a);
        }
      }
    }
  });
}

}  // namespace premation::effects
