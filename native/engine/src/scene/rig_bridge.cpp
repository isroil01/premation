#include "rig_bridge.hpp"

#include <string>

namespace premation::scene {

RigResult build_rig_mesh_for(const doc::Document& d, const doc::ExprEnv& env, doc::ExprCache& cache, std::string_view node,
                             const RigInputs& in) {
  const std::string id(node);
  RigSampler s;
  s.sample = [&d, &env, &cache, &id](std::string_view path, double t) { return doc::anim_sample(d, env, cache, id, path, t); };
  s.sampleData = [&d, &id](std::string_view path, double t) -> std::optional<Json> {
    const doc::DataTrack* tr = doc::anim_data_track(d, id, path);
    if (tr == nullptr) return std::nullopt;
    return doc::sample_data_track(*tr, t);
  };
  return build_rig_mesh(in, s);
}

}  // namespace premation::scene
