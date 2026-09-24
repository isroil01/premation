#include "env_light.hpp"

#include <algorithm>
#include <cmath>
#include <numbers>

#include "jsmath.hpp"

namespace premation::scene {

namespace {

constexpr double kPi = std::numbers::pi;  // Math.PI
constexpr double Y00 = 0.282095;
constexpr double Y1 = 0.488603;
constexpr double Y2A = 1.092548;
constexpr double Y20 = 0.315392;
constexpr double Y22 = 0.546274;
constexpr double A0 = 1.0;
constexpr double A1 = 2.0 / 3.0;
constexpr double A2 = 0.25;

struct V3 {
  double x, y, z;
};

std::array<double, 9> basis(V3 d) {
  const double x = d.x;
  const double y = d.y;
  const double z = d.z;
  return {Y00, Y1 * y, Y1 * z, Y1 * x, Y2A * x * y, Y2A * y * z, Y20 * (3 * z * z - 1), Y2A * x * z, Y22 * (x * x - y * y)};
}

V3 equirect_dir(double u, double v) {
  const double phi = u * kPi * 2;
  const double theta = v * kPi;
  const double s = motion::js::sin(theta);
  return {s * motion::js::sin(phi), -motion::js::cos(theta), s * motion::js::cos(phi)};
}

double mix(double a, double b, double t) { return a + (b - a) * t; }

/// `presetPixels(id, 32, 16)` (Float32Array storage).
std::vector<float> preset_pixels(std::string_view id, int width, int height) {
  std::vector<float> data(static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 3);
  for (int j = 0; j < height; ++j) {
    const double v = (j + 0.5) / height;
    for (int i = 0; i < width; ++i) {
      const double u = (i + 0.5) / width;
      double r = 0;
      double g = 0;
      double b = 0;
      if (id == "studio") {
        const double up = 1 - v;
        const double l = 0.15 + 0.85 * motion::js::pow(up, 1.6);
        r = l;
        g = l;
        b = l;
      } else if (id == "sky") {
        if (v < 0.55) {
          const double t = v / 0.55;
          r = mix(0.18, 0.75, t);
          g = mix(0.35, 0.85, t);
          b = mix(0.95, 1.0, t);
        } else {
          const double t = (v - 0.55) / 0.45;
          r = mix(0.55, 0.32, t);
          g = mix(0.48, 0.27, t);
          b = mix(0.38, 0.2, t);
        }
      } else {
        const double west = std::max(0.0, motion::js::cos((u - 0.75) * kPi * 2));
        if (v < 0.5) {
          const double t = v / 0.5;
          r = mix(0.25, 0.5, t) + 0.9 * west * t;
          g = mix(0.2, 0.3, t) + 0.35 * west * t;
          b = mix(0.55, 0.45, t) + 0.05 * west * t;
        } else {
          const double t = (v - 0.5) / 0.5;
          r = mix(0.5, 0.12, t) + 0.4 * west * (1 - t);
          g = mix(0.3, 0.09, t) + 0.12 * west * (1 - t);
          b = mix(0.35, 0.1, t);
        }
      }
      const std::size_t o = (static_cast<std::size_t>(j) * static_cast<std::size_t>(width) + static_cast<std::size_t>(i)) * 3;
      data[o] = static_cast<float>(r);
      data[o + 1] = static_cast<float>(g);
      data[o + 2] = static_cast<float>(b);
    }
  }
  return data;
}

/// `shProject(px)`.
std::array<float, 27> sh_project(const std::vector<float>& data, int width, int height) {
  std::array<float, 27> sh{};
  double weightSum = 0;
  for (int j = 0; j < height; ++j) {
    const double v = (j + 0.5) / height;
    const double sinTheta = motion::js::sin(v * kPi);
    for (int i = 0; i < width; ++i) {
      const double u = (i + 0.5) / width;
      const auto b = basis(equirect_dir(u, v));
      const std::size_t o = (static_cast<std::size_t>(j) * static_cast<std::size_t>(width) + static_cast<std::size_t>(i)) * 3;
      const double r = data[o];
      const double g = data[o + 1];
      const double bl = data[o + 2];
      for (std::size_t k = 0; k < 9; ++k) {
        const double w = b[k] * sinTheta;
        sh[k * 3] = static_cast<float>(static_cast<double>(sh[k * 3]) + r * w);
        sh[k * 3 + 1] = static_cast<float>(static_cast<double>(sh[k * 3 + 1]) + g * w);
        sh[k * 3 + 2] = static_cast<float>(static_cast<double>(sh[k * 3 + 2]) + bl * w);
      }
      weightSum += sinTheta;
    }
  }
  const double norm = (4 * kPi) / std::max(1e-9, weightSum);
  for (float& c : sh) c = static_cast<float>(static_cast<double>(c) * norm);
  return sh;
}

std::array<double, 3> sh_irradiance(const std::array<float, 27>& sh, V3 dir) {
  const auto b = basis(dir);
  constexpr std::array<double, 9> a = {A0, A1, A1, A1, A2, A2, A2, A2, A2};
  std::array<double, 3> out{0, 0, 0};
  for (std::size_t k = 0; k < 9; ++k) {
    const double w = a[k] * b[k];
    out[0] += sh[k * 3] * w;
    out[1] += sh[k * 3 + 1] * w;
    out[2] += sh[k * 3 + 2] * w;
  }
  for (double& c : out) c = std::max(0.0, c);
  return out;
}

V3 rotate_y(V3 d, double deg) {
  const double a = (deg * kPi) / 180;
  const double c = motion::js::cos(a);
  const double s = motion::js::sin(a);
  return {d.x * c + d.z * s, d.y, -d.x * s + d.z * c};
}

std::string to_hex_color(const std::array<double, 3>& rgb, double max) {
  static constexpr char kHex[] = "0123456789abcdef";
  std::string out = "#";
  for (const double v : rgb) {
    const double q = motion::js::round(std::max(0.0, std::min(1.0, max > 1e-6 ? v / max : 0)) * 255);
    const auto iv = static_cast<unsigned>(q);
    out.push_back(kHex[(iv >> 4U) & 0xFU]);
    out.push_back(kHex[iv & 0xFU]);
  }
  return out;
}

constexpr std::array<V3, 6> kAxes = {{{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}}};

}  // namespace

std::array<float, 27> preset_sh(std::string_view id) {
  const std::string_view p = id == "sky" || id == "sunset" ? id : std::string_view("studio");
  return sh_project(preset_pixels(p, 32, 16), 32, 16);
}

std::vector<EnvRigLight> environment_rig(const std::array<float, 27>& sh, double intensityPct, double rotationDeg) {
  const double gain = std::max(0.0, intensityPct) / 100;
  if (gain <= 0) return {};
  std::array<std::array<double, 3>, 6> E{};
  for (std::size_t i = 0; i < 6; ++i) E[i] = sh_irradiance(sh, rotate_y(kAxes[i], -rotationDeg));
  std::array<double, 3> floor{};
  for (std::size_t c = 0; c < 3; ++c) {
    double m = E[0][c];
    for (std::size_t i = 1; i < 6; ++i) m = std::min(m, E[i][c]);
    floor[c] = m;
  }
  std::vector<EnvRigLight> out;
  const double floorMax = std::max({floor[0], floor[1], floor[2]});
  if (floorMax > 1e-4) {
    EnvRigLight l;
    l.ambient = true;
    l.color = to_hex_color(floor, floorMax);
    l.intensity = floorMax * 100 * gain;
    out.push_back(std::move(l));
  }
  const double devCutoff = std::max(0.02 * floorMax, 0.01);
  for (std::size_t i = 0; i < 6; ++i) {
    const std::array<double, 3> dev = {std::max(0.0, E[i][0] - floor[0]), std::max(0.0, E[i][1] - floor[1]),
                                       std::max(0.0, E[i][2] - floor[2])};
    const double m = std::max({dev[0], dev[1], dev[2]});
    if (m <= devCutoff) continue;
    EnvRigLight l;
    l.ambient = false;
    l.color = to_hex_color(dev, m);
    l.intensity = m * 100 * gain;
    l.from = {kAxes[i].x, kAxes[i].y, kAxes[i].z};
    out.push_back(std::move(l));
  }
  return out;
}

std::optional<std::vector<EnvRigLight>> environment_rig_for(std::string_view sky, double intensityPct, double rotationDeg) {
  if (sky.starts_with("asset:")) return std::nullopt;
  return environment_rig(preset_sh(sky), intensityPct, rotationDeg);
}

}  // namespace premation::scene
