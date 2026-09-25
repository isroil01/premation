#include "particle_port.hpp"

#include <algorithm>
#include <bit>
#include <array>
#include <cmath>
#include <cstdio>
#include <map>
#include <memory>
#include <mutex>
#include <numbers>
#include <string_view>
#include <vector>

#include "css.hpp"
#include "image_decode.hpp"
#include "jsmath.hpp"
#include "scene_math.hpp"
#include "scene_textures.hpp"

namespace premation::scene {
namespace {

namespace mjs = motion::js;
constexpr double kPi = std::numbers::pi;

// ── The config ───────────────────────────────────────────────────────────────

/// DEFAULT_PARTICLE_CONFIG, in declaration order.
Json default_config() {
  Json d = Json::object();
  const auto n = [&d](const char* k, double v) { d.set(k, Json::number(v)); };
  const auto s = [&d](const char* k, const char* v) { d.set(k, Json::string(v)); };
  const auto b = [&d](const char* k, bool v) { d.set(k, Json::boolean(v)); };
  s("emitterType", "point");
  n("emitterWidth", 40);
  n("emitterHeight", 40);
  n("birthRate", 80);
  n("maxParticles", 5000);
  n("lifetime", 2);
  n("lifetimeRandom", 0.35);
  n("speed", 180);
  n("speedRandom", 0.4);
  n("direction", -90);
  n("spread", 45);
  n("gravityX", 0);
  n("gravityY", 220);
  n("spin", 0);
  n("sizeStart", 10);
  n("sizeEnd", 2);
  s("colorStart", "#ffd166");
  s("colorEnd", "#ff3d6e");
  n("opacityStart", 1);
  n("opacityEnd", 0);
  s("shape", "circle");
  s("blend", "add");
  n("seed", 1);
  s("simMode", "ballistic");
  n("bounceFloor", 160);
  n("bounceRestitution", 0.65);
  n("bounceDamping", 0.998);
  n("windX", 0);
  n("windY", 0);
  n("turbulence", 0);
  n("turbulenceScale", 100);
  n("turbulenceSpeed", 1);
  n("trailLength", 0);
  n("trailSpacing", 1.0 / 30);
  n("emitterDepth", 0);
  n("speedZ", 0);
  n("perspective", 0);
  b("collide", false);
  n("collideRestitution", 0.7);
  s("subEmit", "off");
  n("subCount", 8);
  n("subSpeed", 120);
  n("subLifetime", 0.6);
  n("subSizeScale", 0.5);
  n("subRate", 10);
  n("drag", 0);
  n("midAge", 0.5);
  n("motionBlur", 0);
  n("spriteFrames", 1);
  n("spriteFps", 0);
  n("plexusDistance", 0);
  n("plexusWidth", 1);
  n("plexusOpacity", 0.6);
  s("plexusColor", "#9fd0ff");
  b("plexusTriangles", false);
  n("plexusTriangleOpacity", 0.15);
  return d;
}

constexpr std::array<std::string_view, 36> kNumericKeys = {
    "emitterWidth", "emitterHeight", "birthRate", "lifetime", "lifetimeRandom", "speed", "speedRandom", "direction",
    "spread", "gravityX", "gravityY", "spin", "sizeStart", "sizeEnd", "opacityStart", "opacityEnd", "windX", "windY",
    "turbulence", "turbulenceScale", "turbulenceSpeed", "emitterDepth", "speedZ", "perspective", "drag", "sizeMid",
    "opacityMid", "midAge", "subRate", "motionBlur", "plexusDistance", "plexusWidth", "plexusOpacity",
    "plexusTriangleOpacity", "", ""};

/// The typed view of a resolved config the simulation reads (`cfg.x ?? default`).
struct Cfg {
  std::string emitterType, shape, blend, simMode, subEmit, colorStart, colorEnd, plexusColor;
  std::optional<std::string> colorMid, spriteSrc;
  double emitterWidth = 40, emitterHeight = 40, birthRate = 80, maxParticles = 5000, lifetime = 2, lifetimeRandom = 0.35;
  double speed = 180, speedRandom = 0.4, direction = -90, spread = 45, gravityX = 0, gravityY = 220, spin = 0;
  double sizeStart = 10, sizeEnd = 2, opacityStart = 1, opacityEnd = 0, seed = 1;
  double bounceFloor = 160, bounceRestitution = 0.65, bounceDamping = 0.998, windX = 0, windY = 0;
  double turbulence = 0, turbulenceScale = 100, turbulenceSpeed = 1, trailLength = 0, trailSpacing = 1.0 / 30;
  double emitterDepth = 0, speedZ = 0, perspective = 0;
  bool collide = false, plexusTriangles = false;
  double collideRestitution = 0.7, subCount = 8, subSpeed = 120, subLifetime = 0.6, subSizeScale = 0.5, subRate = 10;
  double drag = 0, midAge = 0.5, motionBlur = 0, shutterSec = 0, spriteFrames = 1, spriteFps = 0;
  std::optional<double> sizeMid, opacityMid;
  double plexusDistance = 0, plexusWidth = 1, plexusOpacity = 0.6, plexusTriangleOpacity = 0.15;
};

Cfg typed(const Json& j) {
  Cfg c;
  const auto str = [&j](const char* k, std::string& out, const char* def) { out = j.at(k).is_string() ? j.at(k).str() : def; };
  const auto num = [&j](const char* k, double& out) {
    if (j.at(k).is_number()) out = j.at(k).num();
  };
  const auto flag = [&j](const char* k, bool& out) {
    const Json& v = j.at(k);
    if (v.is_bool()) out = v.b();
    else if (v.is_number()) out = v.num() != 0 && !std::isnan(v.num());
  };
  str("emitterType", c.emitterType, "point");
  str("shape", c.shape, "circle");
  str("blend", c.blend, "add");
  str("simMode", c.simMode, "ballistic");
  str("subEmit", c.subEmit, "off");
  str("colorStart", c.colorStart, "#ffd166");
  str("colorEnd", c.colorEnd, "#ff3d6e");
  str("plexusColor", c.plexusColor, "#9fd0ff");
  if (j.at("colorMid").is_string() && !j.at("colorMid").str().empty()) c.colorMid = j.at("colorMid").str();
  if (j.at("spriteSrc").is_string()) c.spriteSrc = j.at("spriteSrc").str();
  num("emitterWidth", c.emitterWidth);
  num("emitterHeight", c.emitterHeight);
  num("birthRate", c.birthRate);
  num("maxParticles", c.maxParticles);
  num("lifetime", c.lifetime);
  num("lifetimeRandom", c.lifetimeRandom);
  num("speed", c.speed);
  num("speedRandom", c.speedRandom);
  num("direction", c.direction);
  num("spread", c.spread);
  num("gravityX", c.gravityX);
  num("gravityY", c.gravityY);
  num("spin", c.spin);
  num("sizeStart", c.sizeStart);
  num("sizeEnd", c.sizeEnd);
  num("opacityStart", c.opacityStart);
  num("opacityEnd", c.opacityEnd);
  num("seed", c.seed);
  num("bounceFloor", c.bounceFloor);
  num("bounceRestitution", c.bounceRestitution);
  num("bounceDamping", c.bounceDamping);
  num("windX", c.windX);
  num("windY", c.windY);
  num("turbulence", c.turbulence);
  num("turbulenceScale", c.turbulenceScale);
  num("turbulenceSpeed", c.turbulenceSpeed);
  num("trailLength", c.trailLength);
  num("trailSpacing", c.trailSpacing);
  num("emitterDepth", c.emitterDepth);
  num("speedZ", c.speedZ);
  num("perspective", c.perspective);
  flag("collide", c.collide);
  num("collideRestitution", c.collideRestitution);
  num("subCount", c.subCount);
  num("subSpeed", c.subSpeed);
  num("subLifetime", c.subLifetime);
  num("subSizeScale", c.subSizeScale);
  num("subRate", c.subRate);
  num("drag", c.drag);
  num("midAge", c.midAge);
  num("motionBlur", c.motionBlur);
  num("shutterSec", c.shutterSec);
  num("spriteFrames", c.spriteFrames);
  num("spriteFps", c.spriteFps);
  if (j.at("sizeMid").is_number()) c.sizeMid = j.at("sizeMid").num();
  if (j.at("opacityMid").is_number()) c.opacityMid = j.at("opacityMid").num();
  num("plexusDistance", c.plexusDistance);
  num("plexusWidth", c.plexusWidth);
  num("plexusOpacity", c.plexusOpacity);
  flag("plexusTriangles", c.plexusTriangles);
  num("plexusTriangleOpacity", c.plexusTriangleOpacity);
  return c;
}

// ── Numerics shared by both emitters ────────────────────────────────────────

/// particleSim / particleField hash01 (double arithmetic, ToInt32 / ToUint32).
double hash01(double i, double salt, double seed) {
  using mjs::to_int32;
  using mjs::to_uint32;
  double n = static_cast<double>(to_int32(i)) * 374761393 + static_cast<double>(to_int32(salt)) * 668265263 +
             static_cast<double>(to_int32(seed)) * 2246822519.0;
  n = static_cast<double>(std::bit_cast<std::int32_t>(to_uint32(n) ^ (to_uint32(n) >> 13U))) * 1274126177;
  n = static_cast<double>(std::bit_cast<std::int32_t>(to_uint32(n) ^ (to_uint32(n) >> 16U)));
  return static_cast<double>(to_uint32(n)) / 4294967296.0;
}

/// statefulParticleSim hash01 (uint32, Math.imul).
double hash01_stateful(double i, double salt, double seed) {
  std::uint32_t h = mjs::to_uint32(i * 374761393 + salt * 668265263 + seed * 2246822519.0);
  h = h ^ (h >> 13U);
  h = h * 1274126177U;
  return static_cast<double>(h ^ (h >> 16U)) / 4294967296.0;
}

double lerp(double a, double b, double t) { return a + (b - a) * t; }

/// canvas2dEffects parseHex: #rrggbb / #rgb, anything else mid grey.
std::array<double, 3> parse_hex(std::string s) {
  const auto b = s.find_first_not_of(" \t\r\n\f\v");
  const auto e = s.find_last_not_of(" \t\r\n\f\v");
  s = b == std::string::npos ? std::string() : s.substr(b, e - b + 1);
  const auto hex = [](char ch) { return std::isxdigit(static_cast<unsigned char>(ch)) != 0; };
  if (s.size() == 7 && s[0] == '#' && std::all_of(s.begin() + 1, s.end(), hex)) {
    const auto n = std::stoul(s.substr(1), nullptr, 16);
    return {static_cast<double>((n >> 16U) & 255U), static_cast<double>((n >> 8U) & 255U), static_cast<double>(n & 255U)};
  }
  if (s.size() == 4 && s[0] == '#' && std::all_of(s.begin() + 1, s.end(), hex)) {
    const auto one = [&](char ch) { return static_cast<double>(std::stoul(std::string(2, ch), nullptr, 16)); };
    return {one(s[1]), one(s[2]), one(s[3])};
  }
  return {128, 128, 128};
}

/// lerpColor → `rgba(r,g,b,a)` (the string the canvas parses).
std::string lerp_color(const std::string& a, const std::string& b, double t, double alpha) {
  const auto ca = parse_hex(a);
  const auto cb = parse_hex(b);
  const double al = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  return "rgba(" + js::number_to_string(mjs::round(lerp(ca[0], cb[0], t))) + "," +
         js::number_to_string(mjs::round(lerp(ca[1], cb[1], t))) + "," + js::number_to_string(mjs::round(lerp(ca[2], cb[2], t))) +
         "," + js::number_to_string(al) + ")";
}

double ramp_at(double start, double end, double age01, const std::optional<double>& mid, double midAge) {
  if (!mid) return lerp(start, end, age01);
  const double m = std::min(0.999, std::max(0.001, midAge));
  return age01 <= m ? lerp(start, *mid, age01 / m) : lerp(*mid, end, (age01 - m) / (1 - m));
}

std::string color_ramp_at(const Cfg& c, double age01, double alpha) {
  if (!c.colorMid) return lerp_color(c.colorStart, c.colorEnd, age01, alpha);
  const double m = std::min(0.999, std::max(0.001, c.midAge));
  return age01 <= m ? lerp_color(c.colorStart, *c.colorMid, age01 / m, alpha)
                    : lerp_color(*c.colorMid, c.colorEnd, (age01 - m) / (1 - m), alpha);
}

struct Flight {
  double x, y, vx, vy;
};
Flight flight_at(double ox, double oy, double v0x, double v0y, double ax, double ay, double t, double k) {
  if (!(k > 1e-6)) return {ox + v0x * t + 0.5 * ax * t * t, oy + v0y * t + 0.5 * ay * t * t, v0x + ax * t, v0y + ay * t};
  const double e = mjs::exp(-k * t);
  const double s = (1 - e) / k;
  const double tx = ax / k;
  const double ty = ay / k;
  return {ox + tx * t + (v0x - tx) * s, oy + ty * t + (v0y - ty) * s, tx + (v0x - tx) * e, ty + (v0y - ty) * e};
}

struct Vec3 {
  double x = 0, y = 0, z = 0;
};
template <typename H>
Vec3 emitter_origin(const Cfg& c, double i, double seed, H h) {
  double ox = 0, oy = 0, oz = 0;
  if (c.emitterType == "box") {
    ox = (h(i, 4, seed) - 0.5) * c.emitterWidth;
    oy = (h(i, 5, seed) - 0.5) * c.emitterHeight;
  } else if (c.emitterType == "circle") {
    const double ang = h(i, 4, seed) * kPi * 2;
    const double rad = std::sqrt(h(i, 5, seed)) * (c.emitterWidth / 2);
    ox = mjs::cos(ang) * rad;
    oy = mjs::sin(ang) * rad;
  } else if (c.emitterType == "sphere") {
    const double ang = h(i, 4, seed) * kPi * 2;
    const double cosLat = h(i, 9, seed) * 2 - 1;
    const double sinLat = std::sqrt(std::max(0.0, 1 - cosLat * cosLat));
    const double rad = mjs::cbrt(h(i, 5, seed)) * (c.emitterWidth / 2);
    ox = mjs::cos(ang) * sinLat * rad;
    oy = mjs::sin(ang) * sinLat * rad;
    oz = cosLat * rad;
  }
  oz += (h(i, 6, seed) - 0.5) * c.emitterDepth;
  return {ox, oy, oz};
}

struct V2 {
  double x = 0, y = 0;
};
/// particleField wanderOffset.
V2 wander_offset(double i, double age, const Cfg& c) {
  const double amp = c.turbulence;
  if (amp <= 0) return {};
  const double speed = c.turbulenceSpeed;
  const auto seed = static_cast<double>(mjs::to_int32(c.seed));
  const double t = age * speed;
  const auto axis = [&](double saltA, double saltB) {
    const double f1 = 0.7 + hash01(i, saltA, seed) * 1.1;
    const double f2 = 1.9 + hash01(i, saltA + 10, seed) * 1.7;
    const double p1 = hash01(i, saltB, seed) * kPi * 2;
    const double p2 = hash01(i, saltB + 10, seed) * kPi * 2;
    const double w1 = mjs::sin(p1 + f1 * kPi * 2 * t) - mjs::sin(p1);
    const double w2 = mjs::sin(p2 + f2 * kPi * 2 * t) - mjs::sin(p2);
    return (w1 + 0.5 * w2) / 1.5;
  };
  return {amp * axis(20, 21), amp * axis(22, 23)};
}

double value_noise(double x, double y, double t, double seed) {
  const double xi = std::floor(x);
  const double yi = std::floor(y);
  const double ti = std::floor(t);
  const auto sm = [](double v) { return v * v * (3 - 2 * v); };
  const double sx = sm(x - xi);
  const double sy = sm(y - yi);
  const double st = sm(t - ti);
  const auto corner = [&](double dx, double dy, double dt) {
    const auto k = std::bit_cast<std::int32_t>(mjs::to_uint32((xi + dx) * 73856093) ^ mjs::to_uint32((yi + dy) * 19349663) ^ mjs::to_uint32((ti + dt) * 83492791));
    return hash01(static_cast<double>(k), 7, seed) * 2 - 1;
  };
  const auto plane = [&](double dt) { return lerp(lerp(corner(0, 0, dt), corner(1, 0, dt), sx), lerp(corner(0, 1, dt), corner(1, 1, dt), sx), sy); };
  return lerp(plane(0), plane(1), st);
}

/// particleField curlForce.
V2 curl_force(double x, double y, double timeSec, const Cfg& c) {
  const double amp = c.turbulence;
  if (amp <= 0) return {};
  const double scale = std::max(1.0, c.turbulenceScale);
  const double speed = c.turbulenceSpeed;
  const auto seed = static_cast<double>(mjs::to_int32(c.seed));
  const double nx = x / scale;
  const double ny = y / scale;
  const double nt = timeSec * speed;
  constexpr double kEps = 0.25;
  const double dndy = (value_noise(nx, ny + kEps, nt, seed) - value_noise(nx, ny - kEps, nt, seed)) / (2 * kEps);
  const double dndx = (value_noise(nx + kEps, ny, nt, seed) - value_noise(nx - kEps, ny, nt, seed)) / (2 * kEps);
  return {amp * dndy, -amp * dndx};
}

struct Particle {
  double x = 0, y = 0, z = 0, size = 0, opacity = 0, rotation = 0, age01 = 0;
  std::string color;
  std::vector<V2> trail;
  std::optional<double> vx, vy, spriteFrame;
};

std::optional<double> sprite_frame_at(const Cfg& c, double age, double age01) {
  if (c.shape != "sprite") return std::nullopt;
  const double frames = std::max(1.0, std::floor(c.spriteFrames));
  if (frames <= 1) return 0.0;
  if (c.spriteFps > 0) return std::fmod(std::floor(age * c.spriteFps), frames);
  return std::min(frames - 1, std::floor(age01 * frames));
}

// ── The closed-form (ballistic) emitter ─────────────────────────────────────

void emit_death_burst(std::vector<Particle>& out, const Cfg& c, double parent, double parentLife, double childAge, double seed) {
  const double dirBase = (c.direction * kPi) / 180;
  const double spreadRad = (c.spread * kPi) / 180;
  const double speed = c.speed * (1 + c.speedRandom * (hash01(parent, 2, seed) * 2 - 1));
  const double dir = dirBase + spreadRad * (hash01(parent, 3, seed) - 0.5);
  const double v0x = mjs::cos(dir) * speed;
  const double v0y = mjs::sin(dir) * speed;
  const Vec3 origin = emitter_origin(c, parent, seed, hash01);
  const double ax = c.gravityX + c.windX;
  const double ay = c.gravityY + c.windY;
  const double drag = std::max(0.0, c.drag);
  const V2 dw = wander_offset(parent, parentLife, c);
  const Flight death = flight_at(origin.x, origin.y, v0x, v0y, ax, ay, parentLife, drag);
  const double deathX = death.x + dw.x;
  const double deathY = death.y + dw.y;
  const double vz = (hash01(parent, 8, seed) * 2 - 1) * c.speedZ;
  const double deathZ = origin.z + vz * parentLife;
  const double subLife = std::max(0.05, c.subLifetime);
  const double count = std::min(16.0, std::max(0.0, std::floor(c.subCount)));
  const double sizeScale = std::max(0.0, c.subSizeScale);
  const double a01 = childAge / subLife;
  for (double k = 0; k < count; ++k) {
    const double j = parent * 977 + k;
    const double cdir = hash01(j, 30, seed) * kPi * 2;
    const double cspeed = c.subSpeed * (0.5 + hash01(j, 31, seed));
    const Flight cf = flight_at(deathX, deathY, mjs::cos(cdir) * cspeed, mjs::sin(cdir) * cspeed, ax, ay, childAge, drag);
    Particle p;
    p.x = cf.x;
    p.y = cf.y;
    p.z = deathZ;
    p.size = std::max(0.0, ramp_at(c.sizeStart, c.sizeEnd, a01, c.sizeMid, c.midAge)) * sizeScale;
    p.opacity = ramp_at(c.opacityStart, c.opacityEnd, a01, c.opacityMid, c.midAge);
    p.color = color_ramp_at(c, a01, p.opacity);
    p.rotation = c.spin * childAge;
    p.age01 = a01;
    out.push_back(std::move(p));
  }
}

void emit_continuous_children(std::vector<Particle>& out, const Cfg& c, double parent, double parentLife, double parentAge,
                              double seed, double drag, double streak) {
  const double subRate = std::max(0.0, c.subRate);
  if (subRate <= 0) return;
  const double subLife = std::max(0.05, c.subLifetime);
  const double sizeScale = std::max(0.0, c.subSizeScale);
  const double dirBase = (c.direction * kPi) / 180;
  const double spreadRad = (c.spread * kPi) / 180;
  const double speed = c.speed * (1 + c.speedRandom * (hash01(parent, 2, seed) * 2 - 1));
  const double dir = dirBase + spreadRad * (hash01(parent, 3, seed) - 0.5);
  const double v0x = mjs::cos(dir) * speed;
  const double v0y = mjs::sin(dir) * speed;
  const Vec3 origin = emitter_origin(c, parent, seed, hash01);
  const double ax = c.gravityX + c.windX;
  const double ay = c.gravityY + c.windY;
  const double vz = (hash01(parent, 8, seed) * 2 - 1) * c.speedZ;
  const double kMax = std::floor(std::min(parentAge, parentLife) * subRate);
  const double kMin = std::max(0.0, std::ceil((parentAge - subLife) * subRate));
  const double cap = c.maxParticles * 2;
  for (double k = kMin; k <= kMax; ++k) {
    if (static_cast<double>(out.size()) >= cap) return;
    const double tb = k / subRate;
    const double childAge = parentAge - tb;
    if (childAge < 0 || childAge >= subLife) continue;
    const double j = parent * 977 + k;
    const V2 w = wander_offset(parent, tb, c);
    const Flight at = flight_at(origin.x, origin.y, v0x, v0y, ax, ay, tb, drag);
    const double cdir = hash01(j, 32, seed) * kPi * 2;
    const double cspeed = c.subSpeed * (0.5 + hash01(j, 33, seed));
    const Flight cf = flight_at(at.x + w.x, at.y + w.y, mjs::cos(cdir) * cspeed, mjs::sin(cdir) * cspeed, ax, ay, childAge, drag);
    const double a01 = childAge / subLife;
    Particle p;
    p.x = cf.x;
    p.y = cf.y;
    p.z = origin.z + vz * tb;
    p.size = std::max(0.0, ramp_at(c.sizeStart, c.sizeEnd, a01, c.sizeMid, c.midAge)) * sizeScale;
    p.opacity = ramp_at(c.opacityStart, c.opacityEnd, a01, c.opacityMid, c.midAge);
    p.color = color_ramp_at(c, a01, p.opacity);
    p.rotation = c.spin * childAge;
    p.age01 = a01;
    if (streak > 0) {
      p.vx = cf.vx;
      p.vy = cf.vy;
    }
    out.push_back(std::move(p));
  }
}

/// simulateParticles.
std::vector<Particle> simulate_particles(const Cfg& c, double time) {
  std::vector<Particle> out;
  const double rate = c.birthRate;
  if (rate <= 0 || time <= 0) return out;
  const bool subEmitDeath = c.subEmit == "death";
  const bool subContinuous = c.subEmit == "continuous" && c.simMode != "stateful";
  const double subLife = std::max(0.05, c.subLifetime);
  const double maxLife = std::max(0.05, c.lifetime * (1 + std::max(0.0, c.lifetimeRandom))) + (subEmitDeath || subContinuous ? subLife : 0);
  const double drag = std::max(0.0, c.drag);
  const double streak = std::max(0.0, c.motionBlur) * std::max(0.0, c.shutterSec);
  double iStart = std::max(0.0, std::ceil((time - maxLife) * rate));
  const double iEnd = std::floor(time * rate);
  if (iEnd - iStart > c.maxParticles) iStart = iEnd - c.maxParticles;
  const auto seed = static_cast<double>(mjs::to_int32(c.seed));
  const double dirBase = (c.direction * kPi) / 180;
  const double spreadRad = (c.spread * kPi) / 180;
  for (double i = iStart; i <= iEnd; ++i) {
    const double birth = i / rate;
    const double age = time - birth;
    if (age < 0) continue;
    const double life = std::max(0.05, c.lifetime * (1 + c.lifetimeRandom * (hash01(i, 1, seed) * 2 - 1)));
    if (subContinuous && static_cast<double>(out.size()) < c.maxParticles * 2) {
      emit_continuous_children(out, c, i, life, age, seed, drag, streak);
    }
    if (age >= life) {
      if (subEmitDeath && c.simMode != "stateful") {
        const double childAge = age - life;
        if (childAge < subLife && static_cast<double>(out.size()) < c.maxParticles * 2) emit_death_burst(out, c, i, life, childAge, seed);
      }
      continue;
    }
    const double age01 = age / life;
    const double speed = c.speed * (1 + c.speedRandom * (hash01(i, 2, seed) * 2 - 1));
    const double dir = dirBase + spreadRad * (hash01(i, 3, seed) - 0.5);
    const double v0x = mjs::cos(dir) * speed;
    const double v0y = mjs::sin(dir) * speed;
    const double vz = (hash01(i, 8, seed) * 2 - 1) * c.speedZ;
    const Vec3 origin = emitter_origin(c, i, seed, hash01);
    const double ax = c.gravityX + c.windX;
    const double ay = c.gravityY + c.windY;
    const V2 wander = wander_offset(i, age, c);
    const Flight fl = flight_at(origin.x, origin.y, v0x, v0y, ax, ay, age, drag);
    Particle p;
    p.x = fl.x + wander.x;
    p.y = fl.y + wander.y;
    p.size = std::max(0.0, ramp_at(c.sizeStart, c.sizeEnd, age01, c.sizeMid, c.midAge));
    p.opacity = ramp_at(c.opacityStart, c.opacityEnd, age01, c.opacityMid, c.midAge);
    p.rotation = c.spin * age;
    const double trailN = std::min(24.0, std::max(0.0, std::floor(c.trailLength)));
    if (trailN > 0) {
      const double spacing = std::max(1.0 / 240, c.trailSpacing);
      for (double k = 1; k <= trailN; ++k) {
        const double ta = age - k * spacing;
        if (ta < 0) break;
        const V2 tw = wander_offset(i, ta, c);
        const Flight tf = flight_at(origin.x, origin.y, v0x, v0y, ax, ay, ta, drag);
        p.trail.push_back({tf.x + tw.x, tf.y + tw.y});
      }
    }
    p.color = color_ramp_at(c, age01, p.opacity);
    p.age01 = age01;
    if (streak > 0) {
      p.vx = fl.vx;
      p.vy = fl.vy;
    }
    p.spriteFrame = sprite_frame_at(c, age, age01);
    p.z = origin.z + vz * age;
    out.push_back(std::move(p));
  }
  return out;
}

// ── The frame-stepping (stateful) emitter ───────────────────────────────────

struct SoA {
  std::vector<double> id, x, y, vx, vy, age, life, alive, trailRing, z, vz, generation, aliveFrames;
  double emitAcc = 0, nextId = 0;
};

struct RingSpec {
  double points = 0, stride = 1, ringSize = 0;
};
RingSpec trail_ring_spec(const Cfg& c, double fps) {
  RingSpec r;
  r.points = std::min(24.0, std::max(0.0, std::floor(c.trailLength)));
  r.stride = std::max(1.0, mjs::round(c.trailSpacing * std::max(1.0, fps)));
  r.ringSize = r.points > 0 ? std::min(121.0, r.points * r.stride + 1) : 0;
  return r;
}

double js_mod(double a, double b) { return std::fmod(a, b); }

class StatefulSim {
 public:
  StatefulSim(const Cfg& c, double fps)
      : c_(c), n_(static_cast<std::size_t>(std::max(1.0, std::floor(c.maxParticles)))), fps_(std::max(1.0, fps)),
        dt_(1 / fps_), floorY_(c.bounceFloor) {
    restitution_ = std::max(0.0, std::min(1.0, c.bounceRestitution));
    damping_ = std::max(0.0, std::min(1.0, c.bounceDamping)) * mjs::exp(-std::max(0.0, c.drag) * dt_);
    birthPerFrame_ = std::max(0.0, c.birthRate) / fps_;
    ringSize_ = static_cast<std::size_t>(trail_ring_spec(c, fps_).ringSize);
  }
  [[nodiscard]] SoA init() const {
    SoA s;
    for (auto* v : {&s.id, &s.x, &s.y, &s.vx, &s.vy, &s.age, &s.life, &s.alive, &s.z, &s.vz, &s.generation, &s.aliveFrames}) v->assign(n_, 0);
    s.trailRing.assign(n_ * ringSize_ * 2, 0);
    return s;
  }
  void step(SoA& s, double frame) const {
    const Cfg& c = c_;
    struct Birth {
      double x, y, z, parentId;
    };
    std::vector<Birth> births;
    const bool subDeath = c.subEmit == "death";
    const bool subBounce = c.subEmit == "bounce";
    for (std::size_t i = 0; i < n_; ++i) {
      if (s.alive[i] < 0.5) continue;
      const V2 turb = curl_force(s.x[i], s.y[i], frame * dt_, c);
      const double vx = s.vx[i] * damping_ + (c.gravityX + c.windX + turb.x) * dt_;
      double vy = s.vy[i] * damping_ + (c.gravityY + c.windY + turb.y) * dt_;
      const double x = s.x[i] + vx * dt_;
      double y = s.y[i] + vy * dt_;
      const double age = s.age[i] + dt_;
      if (age >= s.life[i]) {
        if (subDeath && s.generation[i] < 0.5) births.push_back({s.x[i], s.y[i], s.z[i], s.id[i]});
        s.alive[i] = 0;
        continue;
      }
      if (y >= floorY_) {
        y = floorY_;
        if (vy > 0) {
          if (subBounce && s.generation[i] < 0.5) births.push_back({x, y, s.z[i], s.id[i]});
          vy = -vy * restitution_;
        }
        if (std::abs(vy) < 0.5) vy = 0;
      }
      s.x[i] = x;
      s.y[i] = y;
      s.z[i] = s.z[i] + s.vz[i] * dt_;
      s.vx[i] = vx;
      s.vy[i] = vy;
      s.age[i] = age;
      if (ringSize_ > 0) {
        const auto rs = static_cast<double>(ringSize_);
        const auto head = static_cast<std::size_t>(js_mod(js_mod(frame, rs) + rs, rs));
        s.trailRing[(i * ringSize_ + head) * 2] = x;
        s.trailRing[(i * ringSize_ + head) * 2 + 1] = y;
        s.aliveFrames[i] = s.aliveFrames[i] + 1;
      }
    }
    if (c.collide) {
      const double collideRest = std::max(0.0, std::min(1.0, c.collideRestitution));
      for (std::size_t i = 0; i < n_; ++i) {
        if (s.alive[i] < 0.5) continue;
        const double ri = radius_at(s, i);
        for (std::size_t j = i + 1; j < n_; ++j) {
          if (s.alive[j] < 0.5) continue;
          const double dx = s.x[j] - s.x[i];
          const double dy = s.y[j] - s.y[i];
          const double r = ri + radius_at(s, j);
          const double dist = hypot2(dx, dy);
          if (dist >= r || r <= 0) continue;
          const double nx = dist < 1e-9 ? 1 : dx / dist;
          const double ny = dist < 1e-9 ? 0 : dy / dist;
          const double push = (r - dist) / 2;
          s.x[i] -= nx * push;
          s.y[i] -= ny * push;
          s.x[j] += nx * push;
          s.y[j] += ny * push;
          const double vn = (s.vx[j] - s.vx[i]) * nx + (s.vy[j] - s.vy[i]) * ny;
          if (vn < 0) {
            const double jn = (-(1 + collideRest) * vn) / 2;
            s.vx[i] -= jn * nx;
            s.vy[i] -= jn * ny;
            s.vx[j] += jn * nx;
            s.vy[j] += jn * ny;
          }
        }
      }
    }
    for (const Birth& b : births) {
      const double count = std::min(16.0, std::max(0.0, std::floor(c.subCount)));
      for (double k = 0; k < count; ++k) {
        const std::size_t slot = free_slot(s);
        const double j = static_cast<double>(mjs::to_int32(b.parentId)) * 977 + k;
        spawn_child(s, slot, j, b.x, b.y, b.z);
      }
    }
    double acc = s.emitAcc + birthPerFrame_;
    while (acc >= 1) {
      const std::size_t slot = free_slot(s);
      const double id = s.nextId;
      spawn(s, slot, id);
      s.nextId = id + 1;
      acc -= 1;
    }
    s.emitAcc = acc;
  }
  [[nodiscard]] std::size_t ring_size() const noexcept { return ringSize_; }

 private:
  [[nodiscard]] double radius_at(const SoA& s, std::size_t i) const {
    const double life = s.life[i];
    const double a01 = life > 0 ? std::min(1.0, s.age[i] / life) : 1;
    return std::max(0.0, lerp(c_.sizeStart, c_.sizeEnd, a01)) / 2;
  }
  [[nodiscard]] std::size_t free_slot(const SoA& s) const {
    for (std::size_t i = 0; i < n_; ++i) {
      if (s.alive[i] < 0.5) return i;
    }
    std::size_t oldest = 0;
    double maxAge = -1;
    for (std::size_t i = 0; i < n_; ++i) {
      if (s.alive[i] >= 0.5 && s.age[i] > maxAge) {
        maxAge = s.age[i];
        oldest = i;
      }
    }
    return oldest;
  }
  void spawn(SoA& s, std::size_t slot, double birthId) const {
    const Cfg& c = c_;
    const auto seed = static_cast<double>(mjs::to_int32(c.seed));
    const auto i = static_cast<double>(mjs::to_int32(birthId));
    const double life = std::max(0.05, c.lifetime * (1 + c.lifetimeRandom * (hash01_stateful(i, 1, seed) * 2 - 1)));
    const double speed = c.speed * (1 + c.speedRandom * (hash01_stateful(i, 2, seed) * 2 - 1));
    const double dirBase = (c.direction * kPi) / 180;
    const double spreadRad = (c.spread * kPi) / 180;
    const double dir = dirBase + spreadRad * (hash01_stateful(i, 3, seed) - 0.5);
    const Vec3 origin = emitter_origin(c, i, seed, hash01_stateful);
    s.id[slot] = i;
    s.x[slot] = origin.x;
    s.y[slot] = origin.y;
    s.z[slot] = origin.z;
    s.vz[slot] = (hash01_stateful(i, 8, seed) * 2 - 1) * c.speedZ;
    s.generation[slot] = 0;
    s.vx[slot] = mjs::cos(dir) * speed;
    s.vy[slot] = mjs::sin(dir) * speed;
    s.age[slot] = 0;
    s.life[slot] = life;
    s.alive[slot] = 1;
    s.aliveFrames[slot] = 0;
  }
  void spawn_child(SoA& s, std::size_t slot, double childId, double x, double y, double z) const {
    const auto seed = static_cast<double>(mjs::to_int32(c_.seed));
    const double dir = hash01_stateful(childId, 30, seed) * kPi * 2;
    const double speed = c_.subSpeed * (0.5 + hash01_stateful(childId, 31, seed));
    s.id[slot] = childId;
    s.x[slot] = x;
    s.y[slot] = y;
    s.z[slot] = z;
    s.vz[slot] = 0;
    s.vx[slot] = mjs::cos(dir) * speed;
    s.vy[slot] = mjs::sin(dir) * speed;
    s.age[slot] = 0;
    s.life[slot] = std::max(0.05, c_.subLifetime);
    s.alive[slot] = 1;
    s.generation[slot] = 1;
    s.aliveFrames[slot] = 0;
  }

  Cfg c_;
  std::size_t n_ = 1;
  double fps_ = 30, dt_ = 1.0 / 30, floorY_ = 160, restitution_ = 0.65, damping_ = 1, birthPerFrame_ = 0;
  std::size_t ringSize_ = 0;
};

/// statefulParticleCache: the last state per layer and config, stepped forward
/// when the next ask is later (the state at a frame is the same by any route).
struct StateCacheEntry {
  std::string signature;
  double frame = 0;
  SoA state;
};
std::mutex& state_cache_mutex() {
  static std::mutex m;
  return m;
}
std::map<std::string, StateCacheEntry>& state_cache() {
  static std::map<std::string, StateCacheEntry> m;
  return m;
}

SoA stateful_state_at(const std::string& key, const std::string& signature, const Cfg& c, double fps, double frame) {
  const StatefulSim sim(c, fps);
  SoA s;
  double from = 0;
  {
    const std::scoped_lock lock(state_cache_mutex());
    auto& m = state_cache();
    if (const auto it = m.find(key); it != m.end() && it->second.signature == signature && it->second.frame <= frame) {
      s = it->second.state;
      from = it->second.frame;
    } else {
      s = sim.init();
    }
  }
  for (double f = from + 1; f <= frame; ++f) sim.step(s, f);
  {
    const std::scoped_lock lock(state_cache_mutex());
    auto& m = state_cache();
    if (m.size() > 64) m.clear();
    m.insert_or_assign(key, StateCacheEntry{signature, frame, s});
  }
  return s;
}

/// particlesFromSoA.
std::vector<Particle> particles_from_soa(const SoA& s, const Cfg& c, double frame, double fps) {
  const RingSpec spec = trail_ring_spec(c, fps);
  const auto ringSize = static_cast<std::size_t>(spec.ringSize);
  std::vector<Particle> out;
  for (std::size_t i = 0; i < s.alive.size(); ++i) {
    if (s.alive[i] < 0.5) continue;
    Particle p;
    if (ringSize > 0 && s.trailRing.size() >= s.alive.size() * ringSize * 2) {
      const double rs = spec.ringSize;
      const double head = js_mod(js_mod(frame, rs) + rs, rs);
      const double maxBack = std::min({spec.points * spec.stride, rs - 1, std::max(0.0, s.aliveFrames[i] - 1)});
      for (double k = spec.stride; k <= maxBack; k += spec.stride) {
        const auto slot = static_cast<std::size_t>(js_mod(js_mod(head - k, rs) + rs, rs));
        p.trail.push_back({s.trailRing[(i * ringSize + slot) * 2], s.trailRing[(i * ringSize + slot) * 2 + 1]});
      }
    }
    const double life = s.life[i];
    const double age = s.age[i];
    const double age01 = life > 0 ? std::min(1.0, age / life) : 1;
    const double size = std::max(0.0, ramp_at(c.sizeStart, c.sizeEnd, age01, c.sizeMid, c.midAge));
    p.opacity = ramp_at(c.opacityStart, c.opacityEnd, age01, c.opacityMid, c.midAge);
    const double streak = std::max(0.0, c.motionBlur) * std::max(0.0, c.shutterSec);
    const double genScale = s.generation[i] >= 0.5 ? std::max(0.0, c.subSizeScale) : 1;
    p.z = s.z[i];
    p.x = s.x[i];
    p.y = s.y[i];
    p.size = size * genScale;
    p.color = color_ramp_at(c, age01, p.opacity);
    p.rotation = c.spin * age;
    p.age01 = age01;
    if (streak > 0) {
      p.vx = s.vx[i] * fps;
      p.vy = s.vy[i] * fps;
    }
    out.push_back(std::move(p));
  }
  return out;
}

// ── Sprites and the field ───────────────────────────────────────────────────

struct Sprite {
  double x = 0, y = 0, size = 0, rotation = 0, opacity = 0;
  std::string color;
  std::optional<double> sx, sy, spriteFrame;
  bool head = false;
};

std::vector<Sprite> to_sprites(std::vector<Particle> particles, double fieldW, double fieldH, double perspective, double streakSec) {
  const double cx = fieldW / 2;
  const double cy = fieldH / 2;
  if (perspective > 0) std::ranges::stable_sort(particles, [](const Particle& a, const Particle& b) { return b.z - a.z < 0; });
  const auto scaleAt = [perspective](double z) { return perspective > 0 ? perspective / std::max(perspective * 0.1, perspective + z) : 1.0; };
  std::vector<Sprite> out;
  for (const Particle& p : particles) {
    if (!p.trail.empty()) {
      const auto n = static_cast<double>(p.trail.size());
      for (std::size_t kk = p.trail.size(); kk-- > 0;) {
        const double fade = (n - static_cast<double>(kk)) / (n + 1);
        const double ts = scaleAt(p.z);
        Sprite t;
        t.x = cx + p.trail[kk].x * ts;
        t.y = cy + p.trail[kk].y * ts;
        t.size = p.size * (0.35 + 0.65 * fade) * ts;
        t.rotation = p.rotation;
        t.color = p.color;
        t.opacity = p.opacity * fade * 0.7;
        out.push_back(std::move(t));
      }
    }
    const double sc = scaleAt(p.z);
    Sprite s;
    s.x = cx + p.x * sc;
    s.y = cy + p.y * sc;
    s.size = p.size * sc;
    s.rotation = p.rotation;
    s.color = p.color;
    s.opacity = p.opacity;
    s.head = true;
    if (streakSec > 0 && p.vx && p.vy) {
      s.sx = p.vx.value_or(0) * streakSec * sc * 0.5;
      s.sy = p.vy.value_or(0) * streakSec * sc * 0.5;
    }
    s.spriteFrame = p.spriteFrame;
    out.push_back(std::move(s));
  }
  return out;
}

void fill_css(raster::Canvas2D& ctx, const std::string& css) {
  raster::Style st;
  if (const auto col = raster::css::parse_color(css)) st.color = *col;
  ctx.setFillStyle(st);
}
void stroke_css(raster::Canvas2D& ctx, const std::string& css) {
  raster::Style st;
  if (const auto col = raster::css::parse_color(css)) st.color = *col;
  ctx.setStrokeStyle(st);
}

struct SpriteImage {
  std::unique_ptr<raster::Canvas2D> canvas;
  double width = 0, height = 0, frames = 1;
};

void paint_shape(raster::Canvas2D& ctx, const Sprite& s, const std::string& shape, const SpriteImage* sprite) {
  const double r = s.size / 2;
  if (shape == "sprite" && sprite != nullptr) {
    const double frames = std::max(1.0, sprite->frames);
    const double fw = sprite->width / frames;
    const double f = std::min(frames - 1, std::max(0.0, s.spriteFrame.value_or(0)));
    const double k = s.size / std::max({1.0, fw, sprite->height});
    const double dw = fw * k;
    const double dh = sprite->height * k;
    ctx.drawImage(*sprite->canvas, f * fw, 0, fw, sprite->height, -dw / 2, -dh / 2, dw, dh);
    return;
  }
  fill_css(ctx, s.color);
  if (shape == "circle" || shape == "sprite") {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, kPi * 2, false);
    ctx.fill(raster::FillRule::nonzero);
  } else if (shape == "square") {
    ctx.fillRect(-r, -r, s.size, s.size);
  } else if (shape == "line") {
    stroke_css(ctx, s.color);
    ctx.setLineWidth(std::max(1.0, s.size / 6));
    ctx.setLineCap(raster::LineCap::round);
    ctx.beginPath();
    ctx.moveTo(-s.size, 0);
    ctx.lineTo(s.size, 0);
    ctx.stroke();
  } else {
    // starPoints(r, r * 0.45, 5).
    const double rot = (0 * kPi) / 180 - kPi / 2;
    ctx.beginPath();
    for (int i = 0; i < 10; ++i) {
      const double rr = i % 2 == 0 ? r : r * 0.45;
      const double a = rot + (i * kPi) / 5;
      const double px = mjs::cos(a) * rr;
      const double py = mjs::sin(a) * rr;
      if (i == 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill(raster::FillRule::nonzero);
  }
}

/// plexus.ts hexRgb.
std::array<double, 3> hex_rgb(std::string h) {
  const auto b = h.find_first_not_of(" \t\r\n\f\v");
  const auto e = h.find_last_not_of(" \t\r\n\f\v");
  h = b == std::string::npos ? std::string() : h.substr(b, e - b + 1);
  if (!h.empty() && h[0] == '#') h.erase(0, 1);
  if (h.size() == 3) h = std::string(2, h[0]) + std::string(2, h[1]) + std::string(2, h[2]);
  // Number.parseInt(h.slice(0, 6), 16): the leading hex digits, NaN for none.
  std::size_t len = 0;
  while (len < std::min<std::size_t>(6, h.size()) && std::isxdigit(static_cast<unsigned char>(h[len])) != 0) ++len;
  if (len == 0) return {255, 255, 255};
  const auto v = std::stoul(h.substr(0, len), nullptr, 16);
  return {static_cast<double>((v >> 16U) & 255U), static_cast<double>((v >> 8U) & 255U), static_cast<double>(v & 255U)};
}

/// plexus.ts drawPlexusLinks over the head sprites.
void draw_plexus_links(raster::Canvas2D& ctx, const std::vector<const Sprite*>& pts, double maxDistance, double lineWidth,
                       double lineOpacity, const std::string& color, bool triangles, double triangleOpacity) {
  constexpr std::size_t kMaxPoints = 700;  // PLEXUS_MAX_POINTS
  const std::size_t n = std::min(pts.size(), kMaxPoints);
  struct Line {
    std::size_t i, j;
    double w;
  };
  std::vector<Line> lines;
  std::vector<std::array<std::size_t, 3>> tris;
  if (maxDistance > 0) {
    const double d2max = maxDistance * maxDistance;
    std::vector<std::vector<std::size_t>> near(triangles ? n : 0);
    for (std::size_t i = 0; i < n; ++i) {
      for (std::size_t j = i + 1; j < n; ++j) {
        const double dx = pts[j]->x - pts[i]->x;
        const double dy = pts[j]->y - pts[i]->y;
        const double d2 = dx * dx + dy * dy;
        if (d2 >= d2max) continue;
        lines.push_back({i, j, 1 - std::sqrt(d2) / maxDistance});
        if (triangles) near[i].push_back(j);
      }
    }
    if (triangles) {
      for (std::size_t i = 0; i < n; ++i) {
        const auto& ni = near[i];
        for (std::size_t p = 0; p < ni.size(); ++p) {
          const auto& nj = near[ni[p]];
          for (std::size_t q = p + 1; q < ni.size(); ++q) {
            if (std::ranges::find(nj, ni[q]) != nj.end()) tris.push_back({i, ni[p], ni[q]});
          }
        }
      }
    }
  }
  const auto [r, g, b] = hex_rgb(color);
  const std::string rgb = js::number_to_string(r) + "," + js::number_to_string(g) + "," + js::number_to_string(b) + ",";
  if (triangles && triangleOpacity > 0) {
    for (const auto& [i, j, k] : tris) {
      const Sprite& a = *pts[i];
      const Sprite& c = *pts[j];
      const Sprite& d = *pts[k];
      const double w = std::min({1 - hypot2(c.x - a.x, c.y - a.y) / maxDistance, 1 - hypot2(d.x - a.x, d.y - a.y) / maxDistance,
                                 1 - hypot2(d.x - c.x, d.y - c.y) / maxDistance});
      fill_css(ctx, "rgba(" + rgb + js::number_to_string(std::max(0.0, w) * triangleOpacity) + ")");
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
      ctx.closePath();
      ctx.fill(raster::FillRule::nonzero);
    }
  }
  if (lineOpacity > 0 && lineWidth > 0) {
    ctx.setLineWidth(lineWidth);
    ctx.setLineCap(raster::LineCap::round);
    for (const Line& l : lines) {
      stroke_css(ctx, "rgba(" + rgb + js::number_to_string(l.w * lineOpacity) + ")");
      ctx.beginPath();
      ctx.moveTo(pts[l.i]->x, pts[l.i]->y);
      ctx.lineTo(pts[l.j]->x, pts[l.j]->y);
      ctx.stroke();
    }
  }
}

void paint_field(raster::Canvas2D& canvas, const Json& spec, const SpriteImage* spr);

}  // namespace

Json read_node_particle(const doc::Node& n) {
  const doc::Component* fx = n.comp("fx");
  if (fx == nullptr) return {};
  const Json& raw = fx->props.at("particle");
  if (!raw.is_object()) return {};
  Json out = default_config();
  for (const Json::Member& m : raw.obj()) out.set(m.key, m.value);
  return out;
}

Json resolve_particle_config(const Json& cfg, const Values& values) {
  Json out = cfg;
  for (const std::string_view key : kNumericKeys) {
    if (key.empty()) continue;
    if (const auto v = values.get("particle." + std::string(key))) out.set(key, Json::number(*v));
  }
  for (const char* key : {"colorStart", "colorEnd", "colorMid"}) {
    const std::string base = std::string("particle.") + key;
    const auto r = values.get(base + "_r");
    const auto g = values.get(base + "_g");
    const auto b = values.get(base + "_b");
    const auto a = values.get(base + "_a");
    if (!r && !g && !b && !a) continue;
    // parseColorChannels(cfg[key] ?? cfg.colorStart) → channelsToColor.
    const Json& stored = cfg.at(key).is_string() ? cfg.at(key) : cfg.at("colorStart");
    std::string h = stored.is_string() ? stored.str() : "";
    const auto s0 = h.find_first_not_of(" \t\r\n\f\v");
    const auto s1 = h.find_last_not_of(" \t\r\n\f\v");
    h = s0 == std::string::npos ? std::string() : h.substr(s0, s1 - s0 + 1);
    if (!h.empty() && h[0] == '#') h.erase(0, 1);
    if (h.size() == 3) h = std::string(2, h[0]) + std::string(2, h[1]) + std::string(2, h[2]);
    if (h.size() == 6) h += "ff";
    std::array<double, 4> ch = {1, 1, 1, 1};
    if (h.size() == 8 && std::ranges::all_of(h, [](char c) { return std::isxdigit(static_cast<unsigned char>(c)) != 0; })) {
      const auto nn = std::stoul(h, nullptr, 16);
      ch = {static_cast<double>((nn >> 24U) & 0xFFU) / 255, static_cast<double>((nn >> 16U) & 0xFFU) / 255,
            static_cast<double>((nn >> 8U) & 0xFFU) / 255, static_cast<double>(nn & 0xFFU) / 255};
    }
    const auto c2 = [](double v) {
      const auto k = static_cast<unsigned>(mjs::round(std::max(0.0, std::min(1.0, v)) * 255));
      std::array<char, 3> buf{};
      std::snprintf(buf.data(), buf.size(), "%02x", k);  // NOLINT(cppcoreguidelines-pro-type-vararg)
      return std::string(buf.data(), 2);
    };
    const double A = a.value_or(ch[3]);
    std::string col = "#" + c2(r.value_or(ch[0])) + c2(g.value_or(ch[1])) + c2(b.value_or(ch[2]));
    if (A < 1) col += c2(A);
    out.set(key, Json::string(col));
  }
  return out;
}

Json particle_field_spec(const Json& cfg, double timeSec, double fieldW, double fieldH, double transformScale,
                         double rasterScale, double fps) {
  // AppTextureProvider.setParticles: the box rounded, the raster scale capped by
  // PARTICLE_TEX_MAX, the time clamped at 0.
  const double w = std::max(1.0, mjs::round(fieldW));
  const double h = std::max(1.0, mjs::round(fieldH));
  const double requested = std::max(1.0, transformScale) * (rasterScale != 0 ? rasterScale : 1);
  const double scale = std::max(0.5, std::min(requested, 4096 / std::max(w, h)));
  Json s = Json::object();
  s.set("cfg", cfg);
  s.set("time", Json::number(std::max(0.0, timeSec)));
  s.set("w", Json::number(w));
  s.set("h", Json::number(h));
  s.set("scale", Json::number(scale));
  s.set("fps", Json::number(fps));
  return s;
}

raster::RasterOutput draw_particle_field(const Json& spec, const raster::CanvasOptions& opts, const std::filesystem::path& mediaBase) {
  raster::RasterOutput out;
  const Json& cfgJson = spec.at("cfg");
  const Cfg c = typed(cfgJson);
  const double w = spec.at("w").num();
  const double h = spec.at("h").num();
  const double scale = spec.at("scale").num();
  const auto pxW = static_cast<std::uint32_t>(std::max(1.0, mjs::round(w * scale)));
  const auto pxH = static_cast<std::uint32_t>(std::max(1.0, mjs::round(h * scale)));
  out.width = pxW;
  out.height = pxH;
  const auto ctx = raster::Canvas2D::make(pxW, pxH, opts);
  if (!ctx) {
    out.error = "no canvas";
    return out;
  }
  ctx->set_will_read_frequently(true);  // CPU raster, as AppTextureProvider asks for
  // The sprite image (shape 'sprite'): decoded from the resolved asset source.
  std::optional<SpriteImage> sprite;
  if (c.shape == "sprite" && c.spriteSrc && !c.spriteSrc->empty()) {
    std::filesystem::path p(file_url_path(*c.spriteSrc));
    if (p.is_relative()) p = mediaBase / p;
    DecodedImage img;
    std::string err;
    if (decode_image_file(p, img, err) && img.width > 0 && img.height > 0) {
      SpriteImage si;
      si.canvas = ctx->create_canvas(img.width, img.height);
      if (si.canvas) {
        si.canvas->putImageData(img.rgba, img.width, img.height, 0, 0);
        si.width = img.width;
        si.height = img.height;
        si.frames = std::max(1.0, std::floor(c.spriteFrames));
        sprite = std::move(si);
      }
    }
  }
  paint_field(*ctx, spec, sprite ? &*sprite : nullptr);
  out.rgba = ctx->pixels();
  out.ok = true;
  return out;
}

void paint_particle_field(raster::Canvas2D& canvas, const Json& spec) { paint_field(canvas, spec, nullptr); }

namespace {

void paint_field(raster::Canvas2D& canvas, const Json& spec, const SpriteImage* spr) {
  raster::Canvas2D* ctx = &canvas;
  const Json& cfgJson = spec.at("cfg");
  const Cfg c = typed(cfgJson);
  const double time = spec.at("time").num();
  const double w = spec.at("w").num();
  const double h = spec.at("h").num();
  const double scale = spec.at("scale").num();
  const double fpsIn = spec.at("fps").num();
  ctx->clearRect(0, 0, ctx->width(), ctx->height());
  ctx->save();
  ctx->scale(scale, scale);
  ctx->setImageSmoothing(true);
  (void)ctx->setGlobalCompositeOperation(c.blend == "add" ? "lighter" : "source-over");
  // particleSprites.
  const double streakSec = std::max(0.0, c.motionBlur) * std::max(0.0, c.shutterSec);
  std::vector<Particle> particles;
  if (c.simMode == "stateful") {
    const double fps = std::max(1.0, fpsIn != 0 ? fpsIn : 30);
    const double frame = std::max(0.0, std::floor(time * fps + 1e-9));
    const std::string key = spec.at("key").is_string() ? spec.at("key").str() : js::stringify(cfgJson);
    const SoA st = stateful_state_at(key, js::stringify(cfgJson) + "|" + js::number_to_string(fps), c, fps, frame);
    particles = particles_from_soa(st, c, frame, fps);
  } else {
    particles = simulate_particles(c, time);
  }
  const std::vector<Sprite> sprites = to_sprites(std::move(particles), w, h, c.perspective, streakSec);
  if (const double pd = std::max(0.0, c.plexusDistance); pd > 0) {
    std::vector<const Sprite*> heads;
    for (const Sprite& s : sprites) {
      if (s.head) heads.push_back(&s);
    }
    draw_plexus_links(*ctx, heads, pd, std::max(0.0, c.plexusWidth), std::max(0.0, std::min(1.0, c.plexusOpacity)), c.plexusColor,
                      c.plexusTriangles, std::max(0.0, std::min(1.0, c.plexusTriangleOpacity)));
  }
  for (const Sprite& s : sprites) {
    if (s.size <= 0 || s.opacity <= 0) continue;
    if (c.shape == "circle" && !s.sx) {
      fill_css(*ctx, s.color);
      ctx->beginPath();
      ctx->arc(s.x, s.y, s.size / 2, 0, kPi * 2, false);
      ctx->fill(raster::FillRule::nonzero);
      continue;
    }
    ctx->save();
    ctx->translate(s.x, s.y);
    const double len = s.sx && s.sy ? hypot2(*s.sx, *s.sy) * 2 : 0;
    if (len > 0.5) {
      const double nn = std::min(12.0, std::max(2.0, std::ceil(len / std::max(1.0, s.size * 0.5))));
      const double alpha = ctx->globalAlpha();
      ctx->setGlobalAlpha(alpha / nn);
      for (double k = 0; k < nn; ++k) {
        const double t = nn == 1 ? 0 : (k / (nn - 1)) * 2 - 1;
        ctx->save();
        ctx->translate(s.sx.value_or(0) * t, s.sy.value_or(0) * t);
        ctx->rotate((s.rotation * kPi) / 180);
        paint_shape(*ctx, s, c.shape, spr);
        ctx->restore();
      }
      ctx->setGlobalAlpha(alpha);
    } else {
      ctx->rotate((s.rotation * kPi) / 180);
      paint_shape(*ctx, s, c.shape, spr);
    }
    ctx->restore();
  }
  ctx->restore();
  (void)ctx->setGlobalCompositeOperation("source-over");
}

}  // namespace
}  // namespace premation::scene
