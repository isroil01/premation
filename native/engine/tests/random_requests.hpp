// Seeded random protocol traffic for the stress test and the fuzzer: valid
// requests over the whole command set (with plausible and implausible ids,
// values of the wrong type, NaNs, huge numbers), and byte-level corruption of
// valid messages. Deterministic: same seed, same traffic.
#pragma once

#include <cmath>
#include <cstdint>
#include <limits>
#include <random>
#include <string>
#include <vector>

#include "session_harness.hpp"

namespace premation::test {

inline constexpr api::Time kFlicksPerSecond = 705'600'000;

class RandomTraffic {
 public:
  explicit RandomTraffic(std::uint64_t seed) : rng_(seed) {}

  std::uint64_t u(std::uint64_t n) { return n == 0 ? 0 : std::uniform_int_distribution<std::uint64_t>(0, n - 1)(rng_); }
  bool coin(double p = 0.5) { return std::bernoulli_distribution(p)(rng_); }

  double number() {
    switch (u(8)) {
      case 0: return std::numeric_limits<double>::quiet_NaN();
      case 1: return std::numeric_limits<double>::infinity();
      case 2: return -1e300;
      case 3: return 0.0;
      default: return std::uniform_real_distribution<double>(-2000.0, 2000.0)(rng_);
    }
  }

  api::Time time() {
    switch (u(10)) {
      case 0: return -kFlicksPerSecond;
      case 1: return std::numeric_limits<api::Time>::max() / 4;
      default: return static_cast<api::Time>(u(12 * 30)) * (kFlicksPerSecond / 30);
    }
  }

  // The ids the engine mints (IdAllocator: layer_<n>, comp_<n>, k<n>; New Project is comp_root).
  std::string layer_id() { return coin(0.9) ? "layer_" + std::to_string(u(12) + 1) : junk_string(); }
  std::string comp_id() {
    if (!coin(0.9)) return junk_string();
    return coin(0.5) ? std::string("comp_root") : "comp_" + std::to_string(u(3) + 1);
  }
  std::string key_id() { return "k" + std::to_string(u(60) + 1); }

  std::string path() {
    static const char* const kPaths[] = {"transform/anchorPoint", "transform/position", "transform/scale",
                                         "transform/rotation",    "transform/opacity",  "text/sourceText",
                                         "contents/size",         "transform",          "",
                                         "effects/x/y",           "masks/mask_1/path",  "styles/dropShadow/distance"};
    return kPaths[u(std::size(kPaths))];
  }

  std::string junk_string() {
    std::string s;
    const auto n = u(12);
    for (std::uint64_t i = 0; i < n; ++i) s.push_back(static_cast<char>(u(256)));
    return s;
  }

  api::Value value() {
    api::Value v;
    switch (u(9)) {
      case 0: v.v.emplace<3>(number()); break;
      case 1: v.v.emplace<4>(api::Vec2{number(), number()}); break;
      case 2: v.v.emplace<7>(api::Color{number(), number(), number(), number()}); break;
      case 3: v.v.emplace<1>(coin()); break;
      case 4: v.v.emplace<8>(junk_string()); break;
      case 5: v.v.emplace<5>(api::Vec3{number(), number(), number()}); break;
      case 6: v.v.emplace<4>(api::Vec2{static_cast<double>(u(2000)), static_cast<double>(u(2000))}); break;
      case 7: v.v.emplace<3>(static_cast<double>(u(100))); break;
      default: v.v.emplace<7>(api::Color{0.1, 0.5, 0.9, 1.0}); break;
    }
    return v;
  }

  api::Command command(int depth = 0) {
    api::Command c;
    switch (u(depth > 0 ? 12 : 30)) {
      case 0: {
        api::CreateComposition x;
        if (coin()) x.settings.width = static_cast<std::uint32_t>(u(40000));
        if (coin()) x.settings.frame_rate = api::Rational{static_cast<std::uint32_t>(u(200)), static_cast<std::uint32_t>(u(3))};
        if (coin()) x.settings.duration = time();
        c.v = x;
        break;
      }
      case 1:
      case 2: {
        api::CreateLayer x;
        x.comp = comp_id();
        x.kind = static_cast<api::LayerKind>(u(22));
        if (coin(0.2)) x.index = static_cast<std::uint32_t>(u(20));
        if (coin(0.2)) x.init.push_back(api::PropertyInit{path(), value()});
        c.v = x;
        break;
      }
      case 3:
      case 4:
      case 5: {
        api::SetProperty x;
        x.prop = {layer_id(), path()};
        x.value = value();
        if (coin()) x.time = time();
        c.v = x;
        break;
      }
      case 6:
      case 7: {
        api::AddKeyframes x;
        const auto n = u(4);
        for (std::uint64_t i = 0; i < n; ++i) {
          api::KeyframeInsert k;
          k.prop = {layer_id(), path()};
          k.time = time();
          if (coin(0.8)) k.value = value();
          if (coin(0.3)) k.easing = static_cast<api::Easing>(u(10));
          if (coin(0.2)) k.bezier = api::CubicBezier{number(), number(), number(), number()};
          if (coin(0.2)) k.spatial_in = {number(), number()};
          x.keys.push_back(std::move(k));
        }
        c.v = x;
        break;
      }
      case 8: {
        api::DeleteKeyframes x;
        x.ids = {key_id(), key_id()};
        c.v = x;
        break;
      }
      case 9: {
        api::DeleteLayers x;
        x.layers = {layer_id()};
        if (coin(0.3)) x.layers.push_back(layer_id());
        c.v = x;
        break;
      }
      case 10: {
        api::ReorderLayers x;
        x.comp = comp_id();
        x.layers = {layer_id(), layer_id()};
        x.to_index = static_cast<std::uint32_t>(u(6));
        c.v = x;
        break;
      }
      case 11: {
        api::SetAnimated x;
        x.prop = {layer_id(), path()};
        x.animated = coin();
        x.time = time();
        c.v = x;
        break;
      }
      case 12: c.v = api::Undo{}; break;
      case 13: c.v = api::Redo{}; break;
      case 14: c.v = api::BeginGesture{"g"}; break;
      case 15: c.v = api::EndGesture{static_cast<std::uint32_t>(u(4)), coin()}; break;
      case 16: c.v = api::Play{coin() ? 1.0 : number(), static_cast<api::PlayRange>(u(3)), {}, false, false, {}}; break;
      case 17: c.v = api::Pause{coin()}; break;
      case 18: c.v = api::Seek{time(), api::SeekMode::exact}; break;
      case 19: c.v = api::Step{static_cast<std::int32_t>(u(21)) - 10}; break;
      case 20: c.v = api::SetLoop{static_cast<api::LoopMode>(u(3))}; break;
      case 21: {
        api::SetViewport x;
        x.viewport = static_cast<std::uint32_t>(u(2));
        x.width = static_cast<std::uint32_t>(u(4000));
        x.height = static_cast<std::uint32_t>(u(3000));
        x.device_pixel_ratio = coin() ? 1.0 : number();
        c.v = x;
        break;
      }
      case 22: c.v = api::CloseViewport{static_cast<std::uint32_t>(u(2))}; break;
      case 23: c.v = api::SetActiveComposition{comp_id()}; break;
      case 24: c.v = api::JumpToHistory{static_cast<std::uint32_t>(u(10))}; break;
      case 25: {
        api::SetCompositionSettings x;
        x.comp = comp_id();
        if (coin()) x.patch.frame_rate = api::Rational{static_cast<std::uint32_t>(u(120)), 1};
        if (coin()) x.patch.duration = time();
        if (coin()) x.patch.height = static_cast<std::uint32_t>(u(4000));
        c.v = x;
        break;
      }
      case 26: c.v = api::NewProject{}; break;
      case 27: c.v = api::ImportFiles{}; break;
      case 28: c.v = api::SetPreviewQuality{static_cast<api::PreviewResolution>(u(5)), {}, false, false, {}}; break;
      default: {
        api::SetProperties x;
        x.writes = {api::PropertyWrite{{layer_id(), path()}, value(), {}}};
        c.v = x;
        break;
      }
    }
    return c;
  }

  api::Query query() {
    api::Query q;
    switch (u(8)) {
      case 0: q.v = api::GetDocument{coin(), coin()}; break;
      case 1: q.v = api::GetComposition{comp_id()}; break;
      case 2: q.v = api::GetLayers{{layer_id()}}; break;
      case 3: q.v = api::GetPropertyTree{layer_id(), path(), 2, time()}; break;
      case 4: q.v = api::GetPropertyValues{{api::PropRef{layer_id(), path()}}, time(), true}; break;
      case 5: q.v = api::GetKeyframes{{api::PropRef{layer_id(), path()}}, {}}; break;
      case 6: q.v = api::GetLayerTransforms{{layer_id()}, time()}; break;
      default: q.v = api::GetHistory{}; break;
    }
    return q;
  }

  api::EngineMessage message(api::Seq seq) {
    api::Request r;
    r.seq = seq;
    const auto kind = u(10);
    if (kind < 6) {
      r.body.v = command();
    } else if (kind < 9) {
      r.body.v = query();
    } else {
      api::CommandBatch b;
      b.label = "batch";
      const auto n = u(5);
      for (std::uint64_t i = 0; i < n; ++i) b.commands.push_back(command(1));
      r.body.v = std::move(b);
    }
    if (coin(0.05)) r.base_revision = u(50);
    r.origin = static_cast<api::Origin>(u(6));
    api::EngineMessage m;
    m.v = std::move(r);
    return m;
  }

  /// Corrupt valid bytes: flips, truncation, insertion, splice.
  void mutate(std::vector<std::uint8_t>& b) {
    const auto n = u(4) + 1;
    for (std::uint64_t i = 0; i < n && !b.empty(); ++i) {
      switch (u(4)) {
        case 0: b[u(b.size())] ^= static_cast<std::uint8_t>(1U << u(8)); break;
        case 1: b.resize(u(b.size())); break;
        case 2: b.insert(b.begin() + static_cast<std::ptrdiff_t>(u(b.size() + 1)), static_cast<std::uint8_t>(u(256))); break;
        default: b[u(b.size())] = static_cast<std::uint8_t>(u(256)); break;
      }
    }
  }

 private:
  std::mt19937_64 rng_;
};

}  // namespace premation::test
