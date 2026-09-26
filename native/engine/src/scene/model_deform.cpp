#include "model_deform.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>

#include "jsmath.hpp"

namespace premation::scene::gltf {

namespace {

namespace mjs = motion::js;
namespace xf = motion::xf;

constexpr std::size_t kVertexFloats = 8;  // MESH_VERTEX_FLOATS

/// The first Transform component's props, or null (modelMorph.ts transformProps).
const Json* transform_props(const doc::Node& n) {
  for (const doc::Component& c : n.components) {
    if (c.type == "Transform") return &c.props;
  }
  return nullptr;
}

/// `(h >>> 0).toString(36)`.
std::string base36(std::uint32_t h) {
  constexpr std::string_view kDigits = "0123456789abcdefghijklmnopqrstuvwxyz";
  if (h == 0) return "0";
  std::string s;
  while (h != 0) {
    s.insert(s.begin(), kDigits[h % 36U]);
    h /= 36U;
  }
  return s;
}

/// `Math.imul(h ^ x, 0x01000193)` on uint32 state.
std::uint32_t fnv_step(std::uint32_t h, std::uint32_t x) { return (h ^ x) * 0x01000193U; }

double hypot3(double a, double b, double c) {
  const std::array<double, 3> v = {a, b, c};
  return mjs::hypot(v);
}

/// readNodeModelSource(n)?.modelKey === modelKey.
bool is_model_source(const doc::Node& n, std::string_view modelKey) {
  for (const doc::Component& c : n.components) {
    if (c.type != "Model") continue;
    const Json& p = c.props;
    if (p.at("modelKey").is_string() && p.at("glbData").is_string() && p.at("glbData").str().starts_with("data:")) {
      return p.at("modelKey").str() == modelKey;
    }
  }
  return false;
}

/// readNodeGltfIndex(n): { modelKey, gltfNode } from the first Model component that has both.
std::optional<std::pair<std::string, double>> gltf_index(const doc::Node& n) {
  for (const doc::Component& c : n.components) {
    if (c.type != "Model") continue;
    const Json& p = c.props;
    if (p.at("modelKey").is_string() && p.at("gltfNode").is_number()) return std::make_pair(p.at("modelKey").str(), p.at("gltfNode").num());
  }
  return std::nullopt;
}

}  // namespace

std::optional<std::vector<double>> read_morph_weights(const doc::Node& n, const Values* animated, std::size_t targetCount) {
  if (targetCount == 0) return std::nullopt;
  const Json* props = transform_props(n);
  std::vector<double> out(targetCount, 0);
  bool any = false;
  for (std::size_t i = 0; i < targetCount; ++i) {
    const std::string key = "morph" + std::to_string(i);
    const std::optional<double> av = animated != nullptr ? animated->get(key) : std::nullopt;
    const double base = props != nullptr && props->at(key).is_number() ? props->at(key).num() : 0;
    const double w = av ? *av : base;
    out[i] = w;
    if (w != 0) any = true;
  }
  if (!any) return std::nullopt;
  return out;
}

std::vector<float> morph_vertices(const std::vector<float>& base, const std::vector<Entry::MorphTarget>& targets,
                                  const std::vector<double>& weights) {
  std::vector<float> out = base;
  const std::size_t vcount = base.size() / kVertexFloats;
  // Float32Array reads past the end are undefined → NaN in the sum.
  const auto at = [](const std::vector<float>& v, std::size_t i) {
    return i < v.size() ? static_cast<double>(v[i]) : std::numeric_limits<double>::quiet_NaN();
  };
  for (std::size_t t = 0; t < weights.size() && t < targets.size(); ++t) {
    const double w = weights[t];
    if (w == 0) continue;
    const Entry::MorphTarget& tg = targets[t];
    for (std::size_t v = 0; v < vcount; ++v) {
      const std::size_t o = v * kVertexFloats;
      const std::size_t d = v * 3;
      if (tg.positions) {
        out[o] = static_cast<float>(static_cast<double>(out[o]) + (w * at(*tg.positions, d)));
        out[o + 1] = static_cast<float>(static_cast<double>(out[o + 1]) + (w * at(*tg.positions, d + 1)));
        out[o + 2] = static_cast<float>(static_cast<double>(out[o + 2]) + (w * at(*tg.positions, d + 2)));
      }
      if (tg.normals) {
        out[o + 3] = static_cast<float>(static_cast<double>(out[o + 3]) + (w * at(*tg.normals, d)));
        out[o + 4] = static_cast<float>(static_cast<double>(out[o + 4]) + (w * at(*tg.normals, d + 1)));
        out[o + 5] = static_cast<float>(static_cast<double>(out[o + 5]) + (w * at(*tg.normals, d + 2)));
      }
    }
  }
  // One renormalize pass, after all targets have stacked their deltas.
  for (std::size_t v = 0; v < vcount; ++v) {
    const std::size_t o = v * kVertexFloats;
    const double len = hypot3(out[o + 3], out[o + 4], out[o + 5]);
    if (len > 1e-6) {
      out[o + 3] = static_cast<float>(static_cast<double>(out[o + 3]) / len);
      out[o + 4] = static_cast<float>(static_cast<double>(out[o + 4]) / len);
      out[o + 5] = static_cast<float>(static_cast<double>(out[o + 5]) / len);
    }
  }
  return out;
}

std::string morph_tag(const std::vector<double>& weights) {
  std::uint32_t h = 0x811c9dc5U;
  for (const double w : weights) {
    const std::int32_t q = mjs::to_int32(mjs::round(w * 4096));
    const auto uq = static_cast<std::uint32_t>(q);
    h = fnv_step(h, uq & 0xFFFFU);
    h = fnv_step(h, static_cast<std::uint32_t>(q >> 16) & 0xFFFFU);  // `>>` is arithmetic
  }
  return base36(h);
}

std::optional<Deformed> morphed_mesh_for(const doc::Node& n, const Entry& entry, const Values* animated) {
  if (entry.morphTargetData.empty()) return std::nullopt;
  const auto weights = read_morph_weights(n, animated, entry.morphTargetData.size());
  if (!weights) return std::nullopt;
  Deformed d;
  d.tag = morph_tag(*weights);
  d.vertices = morph_vertices(entry.vertices, entry.morphTargetData, *weights);
  d.key = entry.key + ":mo-" + d.tag;
  return d;
}

const std::map<double, std::string>* joint_layer_map_for(const std::string& meshNodeId, std::string_view modelKey,
                                                        const SkinResolvers& r, JointMapCache& cache) {
  // Ascend to the instance root.
  std::optional<std::string> rootId;
  std::vector<std::string> seen;
  for (std::optional<std::string> id = meshNodeId; id && !id->empty() && std::ranges::find(seen, *id) == seen.end();) {
    seen.push_back(*id);
    const doc::Node* n = r.node(*id);
    if (n != nullptr && is_model_source(*n, modelKey)) {
      rootId = *id;
      break;
    }
    id = r.parentOf(*id);
  }
  if (!rootId) return nullptr;
  if (const auto hit = cache.find(*rootId); hit != cache.end()) return hit->second ? &*hit->second : nullptr;

  std::map<double, std::string> map;
  std::vector<std::string> stack{*rootId};
  while (!stack.empty()) {
    const std::string id = std::move(stack.back());
    stack.pop_back();
    const doc::Node* n = r.node(id);
    if (n == nullptr) continue;
    const auto gi = gltf_index(*n);
    if (gi && gi->first == modelKey && !map.contains(gi->second)) map.emplace(gi->second, id);
    for (const std::string& c : n->children) stack.push_back(c);
  }
  const auto it = cache.emplace(*rootId, std::move(map)).first;
  return &*it->second;
}

std::string pose_hash(const std::vector<float>& mats) {
  std::uint32_t h = 0x811c9dc5U;
  for (const float m : mats) {
    // ~1/1024 px quantization: a looped cycle lands on identical hashes each pass.
    const auto q = static_cast<std::uint32_t>(mjs::to_int32(mjs::round(static_cast<double>(m) * 1024)));
    h = fnv_step(h, q & 0xFFU);
    h = fnv_step(h, (q >> 8U) & 0xFFU);
    h = fnv_step(h, (q >> 16U) & 0xFFU);
    h = fnv_step(h, (q >> 24U) & 0xFFU);
  }
  return base36(h);
}

std::vector<float> skin_vertices(const std::vector<float>& src, const std::vector<std::uint16_t>& joints,
                                 const std::vector<float>& weights, const std::vector<float>& mats) {
  std::vector<float> out(src.size(), 0.0F);
  const std::size_t vcount = src.size() / kVertexFloats;
  const std::size_t jointCount = mats.size() / 16;
  const auto f = [](float v) { return static_cast<double>(v); };
  for (std::size_t v = 0; v < vcount; ++v) {
    const std::size_t o = v * kVertexFloats;
    const double x = f(src[o]), y = f(src[o + 1]), z = f(src[o + 2]);
    const double nx = f(src[o + 3]), ny = f(src[o + 4]), nz = f(src[o + 5]);
    double px = 0, py = 0, pz = 0;
    double qx = 0, qy = 0, qz = 0;
    for (std::size_t c = 0; c < 4; ++c) {
      const double w = f(weights[(v * 4) + c]);
      if (w == 0) continue;
      const std::size_t j = joints[(v * 4) + c];
      if (j >= jointCount) continue;
      const std::size_t m = j * 16;
      const double m0 = f(mats[m]), m1 = f(mats[m + 1]), m2 = f(mats[m + 2]);
      const double m4 = f(mats[m + 4]), m5 = f(mats[m + 5]), m6 = f(mats[m + 6]);
      const double m8 = f(mats[m + 8]), m9 = f(mats[m + 9]), m10 = f(mats[m + 10]);
      px += w * ((m0 * x) + (m4 * y) + (m8 * z) + f(mats[m + 12]));
      py += w * ((m1 * x) + (m5 * y) + (m9 * z) + f(mats[m + 13]));
      pz += w * ((m2 * x) + (m6 * y) + (m10 * z) + f(mats[m + 14]));
      // Normals through the basis only, then a renormalize.
      qx += w * ((m0 * nx) + (m4 * ny) + (m8 * nz));
      qy += w * ((m1 * nx) + (m5 * ny) + (m9 * nz));
      qz += w * ((m2 * nx) + (m6 * ny) + (m10 * nz));
    }
    const double nlen = hypot3(qx, qy, qz);
    out[o] = static_cast<float>(px);
    out[o + 1] = static_cast<float>(py);
    out[o + 2] = static_cast<float>(pz);
    if (nlen > 1e-6) {
      out[o + 3] = static_cast<float>(qx / nlen);
      out[o + 4] = static_cast<float>(qy / nlen);
      out[o + 5] = static_cast<float>(qz / nlen);
    } else {
      out[o + 3] = src[o + 3];
      out[o + 4] = src[o + 4];
      out[o + 5] = src[o + 5];
    }
    out[o + 6] = src[o + 6];
    out[o + 7] = src[o + 7];
  }
  return out;
}

std::optional<Deformed> skinned_mesh_for(const doc::Node& meshNode, std::string_view modelKey, std::optional<double> skinIndex,
                                         const Entry& entry, const std::vector<ModelSkin>& skins, const xf::Mat4& layerWorld,
                                         const SkinResolvers& r, JointMapCache& cache, const Deformed* morphedBase) {
  if (!entry.skinned || !skinIndex) return std::nullopt;
  // modelSkinFor: `skins[skinIndex] ?? null` (an array index: a non-negative integer).
  const double si = *skinIndex;
  if (!(si >= 0) || si != std::floor(si) || si >= static_cast<double>(skins.size())) return std::nullopt;
  const ModelSkin& skin = skins[static_cast<std::size_t>(si)];
  if (skin.joints.empty()) return std::nullopt;
  const std::map<double, std::string>* jointMap = joint_layer_map_for(meshNode.id, modelKey, r, cache);
  if (jointMap == nullptr) return std::nullopt;
  const std::optional<xf::Mat4> minv = xf::invert(layerWorld);
  if (!minv) return std::nullopt;

  std::vector<float> mats(skin.joints.size() * 16, 0.0F);
  for (std::size_t j = 0; j < skin.joints.size(); ++j) {
    const double jn = skin.joints[j];
    const auto layer = std::isnan(jn) ? jointMap->end() : jointMap->find(jn);
    const std::optional<xf::Mat4> world = layer != jointMap->end() ? r.jointWorld(layer->second) : std::nullopt;
    if (!world) return std::nullopt;
    xf::Mat4 bind{};
    for (std::size_t k = 0; k < 16; ++k) bind[k] = static_cast<double>(skin.invBind[(j * 16) + k]);
    const xf::Mat4 full = xf::multiply(*minv, xf::multiply(*world, bind));
    for (std::size_t k = 0; k < 16; ++k) mats[(j * 16) + k] = static_cast<float>(full[k]);
  }

  const std::string hash = morphedBase != nullptr ? pose_hash(mats) + "~" + morphedBase->tag : pose_hash(mats);
  Deformed d;
  d.vertices = skin_vertices(morphedBase != nullptr ? morphedBase->vertices : entry.vertices, entry.skinJoints, entry.skinWeights, mats);
  d.key = entry.key + ":sk-" + hash;
  return d;
}

}  // namespace premation::scene::gltf
