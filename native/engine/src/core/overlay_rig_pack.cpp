#include "overlay_rig_pack.hpp"

#include <algorithm>
#include <cstdint>
#include <utility>

namespace premation::doc {

namespace {

/// Per record: the layer id, the field tags and the `rig` wrapper.
constexpr std::size_t kRecordOverhead = 64;

std::size_t size_of(const api::RigPinPose& p) { return 16 + p.id.size() + p.kind.size() + 6 * 9; }
std::size_t size_of(const api::RigBonePose& b) { return 24 + b.id.size() + 8 * 9 + b.world.size() * 8; }
std::size_t size_of(const api::RigIkGoal& g) { return 32 + g.bone.size() + g.mode.size() + 4 * 9 + g.pole.size() * 8; }

}  // namespace

std::size_t estimate_overlay_rig(const api::OverlayRig& r) {
  std::size_t n = 16;
  for (const auto& p : r.pins) n += size_of(p);
  for (const auto& b : r.bones) n += size_of(b);
  for (const auto& g : r.ik) n += size_of(g);
  const std::size_t doubles = r.vertices.size() + r.rest.size() + r.weights.size() + r.pin_path.size() + r.pin_keys.size();
  const std::size_t ints = r.triangles.size() + r.edges.size();
  return n + 8 * doubles + 5 * ints + 10 * 8;
}

void split_overlay_rig(const std::string& layer, api::OverlayRig r, std::size_t budget,
                       std::vector<api::OverlayLayerGeometry>& out) {
  const std::size_t room = budget > kRecordOverhead + layer.size() + 64 ? budget - kRecordOverhead - layer.size() : 64;
  const auto piece = [&]() -> api::OverlayRig& {
    api::OverlayLayerGeometry g;
    g.layer = layer;
    g.rig = api::OverlayRig{};
    out.push_back(std::move(g));
    return *out.back().rig;
  };
  // The struct lists: as many whole elements as fit per record.
  const auto structs = [&](auto member, auto& src) {
    std::size_t i = 0;
    while (i < src.size()) {
      api::OverlayRig& p = piece();
      std::size_t used = 0;
      do {
        used += size_of(src[i]);
        (p.*member).push_back(std::move(src[i]));
        ++i;
      } while (i < src.size() && used + size_of(src[i]) <= room);
    }
  };
  structs(&api::OverlayRig::pins, r.pins);
  structs(&api::OverlayRig::bones, r.bones);
  structs(&api::OverlayRig::ik, r.ik);
  // The flat arrays: whole groups (bytes per element, elements per group).
  const auto flat = [&](auto member, auto& src, std::size_t bytes, std::size_t group) {
    const std::size_t take = std::max<std::size_t>(group, (room / bytes / group) * group);
    for (std::size_t i = 0; i < src.size(); i += take) {
      api::OverlayRig& p = piece();
      const auto end = static_cast<std::ptrdiff_t>(std::min(src.size(), i + take));
      (p.*member).assign(src.begin() + static_cast<std::ptrdiff_t>(i), src.begin() + end);
    }
  };
  flat(&api::OverlayRig::vertices, r.vertices, 8, 2);
  flat(&api::OverlayRig::rest, r.rest, 8, 2);
  flat(&api::OverlayRig::triangles, r.triangles, 5, 3);
  flat(&api::OverlayRig::edges, r.edges, 5, 2);
  flat(&api::OverlayRig::weights, r.weights, 8, 1);
  flat(&api::OverlayRig::pin_path, r.pin_path, 8, 2);
  flat(&api::OverlayRig::pin_keys, r.pin_keys, 8, 9);
  // A rig with nothing in it still says so (an empty record: the layer HAS a rig record this frame).
  if (std::none_of(out.begin(), out.end(), [&layer](const api::OverlayLayerGeometry& g) { return g.layer == layer && g.rig; })) {
    (void)piece();
  }
}

}  // namespace premation::doc
