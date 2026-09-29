// Job kinds `physicsBake` and `particleBake` — a simulation turned into
// ordinary animation (src/core/simulation/bakeDynamics.ts, whose rules these
// keep):
//
//   * The bake plays back identically to the viewport it replaced: it calls the
//     renderer's own solvers — physics::poses_at (rigid_body.hpp) with the seeds
//     and world snapshot_build.cpp builds, particles_at_frame (particle_port.hpp)
//     with the config the renderer resolves — never a second stepper.
//   * Baked keys are frame-aligned samples of an already-curved motion, so they
//     interpolate LINEARLY; the LAST key holds (no extrapolated motion past the
//     range). `simplifyTolerance` thins a track by Douglas-Peucker on VALUE
//     deviation (keyframeAssistants.ts smoothTrackKeyframes' test) before the
//     easing is stamped.
//   * ONE history entry: keys, the physics switch-off / the baked layers and the
//     hidden emitter all go through commands inside the job's journal.
//
// Physics: every body of the composition seeds the solver (bodies collide — a
// seed list missing the floor is a different history); only the requested
// layers with an enabled DYNAMIC body are written. Position goes on the
// layer's position property (its members — x / y, z kept — or the separated
// dimensions); rotation only for a body that spins (a constant 0 would turn a
// rotation lock into a rotation freeze). `layer/physics` becomes
// `{...raw, enabled: false}`.
//
// Particles: grouped by birth index (Particle.index), the earliest-born kept
// up to the cap. One ellipse (a square emitter: rectangle) per particle at its
// first-seen size, filled with the start colour, keyed x / y / scale (relative
// to that size) / opacity (a zero hold one frame either side of its life),
// under a "<emitter> Baked" null parented to the emitter at (0, 0) — particle
// positions are emitter-local px, so the layers follow an animated emitter.
// The emitter is hidden (its config and transform stay: the bake re-runs).
#include <algorithm>
#include <array>
#include <cmath>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "fail.hpp"
#include "job_apply_util.hpp"
#include "job_inputs.hpp"
#include "job_kinds.hpp"
#include "json.hpp"
#include "model.hpp"
#include "props.hpp"
#include "readmodel.hpp"
#include "rigid_body.hpp"
#include "scene.hpp"
#include "time_conv.hpp"
#include "track_apply.hpp"
#include "values.hpp"
#if defined(PREMATION_JOBS_HAVE_SCENE) && PREMATION_JOBS_HAVE_SCENE
#include "particle_port.hpp"
#include "readers.hpp"
#endif

namespace premation::jobs {

using api::ErrorCode;
using doc::fail;
namespace physics = scene::physics;

namespace {

// ── Range and track plumbing (bakeFrames / finishBakedTrack) ─────────────────

struct Range {
  double from = 0;  ///< composition seconds
  double to = 0;    ///< composition seconds, inclusive
  double fps = 30;
  std::uint32_t every = 1;
  double tolerance = 0;
};

Range range_of(const api::TimeRange& r, double fps, std::optional<std::uint32_t> every, std::optional<double> tol) {
  Range out;
  out.from = seconds_of(r.start);
  out.to = seconds_of(r.start + r.duration);
  out.fps = fps > 0 ? fps : 30;
  out.every = std::max<std::uint32_t>(1, every.value_or(1));
  out.tolerance = std::max(0.0, tol.value_or(0));
  return out;
}

/// `bakeFrames`: every `every`th frame from round(from·fps) to round(to·fps), the end frame always.
std::vector<double> bake_frames(const Range& r) {
  const double f0 = std::max(0.0, std::round(r.from * r.fps));
  const double f1 = std::max(f0, std::round(r.to * r.fps));
  std::vector<double> out;
  for (double f = f0; f <= f1; f += r.every) out.push_back(f);
  if (out.empty() || out.back() != f1) out.push_back(f1);
  return out;
}

/// One baked key: composition seconds, the member's own unit, held or linear.
struct Key {
  double t = 0;
  double v = 0;
  bool hold = false;
};
using Samples = std::vector<std::pair<double, double>>;

/// smoothTrackKeyframes' Douglas-Peucker (vertical deviation; the endpoints survive), without recursion.
std::vector<bool> rdp_keep(const Samples& s, double tolerance) {
  std::vector<bool> keep(s.size(), s.size() < 3 || !(tolerance > 0));
  if (s.size() < 3 || !(tolerance > 0)) return keep;
  keep.front() = true;
  keep.back() = true;
  std::vector<std::pair<std::size_t, std::size_t>> todo{{0, s.size() - 1}};
  while (!todo.empty()) {
    const auto [i0, i1] = todo.back();
    todo.pop_back();
    if (i1 <= i0 + 1) continue;
    const auto& [ta, va] = s[i0];
    const auto& [tb, vb] = s[i1];
    const double span = tb - ta;
    double maxD = -1;
    std::size_t maxI = 0;
    for (std::size_t i = i0 + 1; i < i1; ++i) {
      const double f = span > 0 ? (s[i].first - ta) / span : 0;
      const double d = std::abs(s[i].second - (va + (vb - va) * f));
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > tolerance && maxI > 0) {
      keep[maxI] = true;
      // Right half pushed first so the left half is taken next (the TS recursion's order; the result is order-free).
      todo.emplace_back(maxI, i1);
      todo.emplace_back(i0, maxI);
    }
  }
  return keep;
}

/// `finishBakedTrack`: thin, then linear keys with the last one held.
std::vector<Key> finish_track(const Samples& s, double tolerance) {
  std::vector<Key> out;
  const std::vector<bool> keep = rdp_keep(s, tolerance);
  for (std::size_t i = 0; i < s.size(); ++i) {
    if (keep[i]) out.push_back(Key{s[i].first, s[i].second, false});
  }
  if (!out.empty()) out.back().hold = true;
  return out;
}

/// A baked track's value at `t` (between its keys: linear, or the held value).
double value_at(const std::vector<Key>& keys, double t) {
  if (t <= keys.front().t) return keys.front().v;
  for (std::size_t i = 0; i + 1 < keys.size(); ++i) {
    const Key& a = keys[i];
    const Key& b = keys[i + 1];
    if (t > b.t) continue;
    if (a.hold || b.t <= a.t) return t >= b.t ? b.v : a.v;
    return a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t));
  }
  return keys.back().v;
}

/// Write baked member tracks onto a layer: the members of one API property go
/// out together as ONE setKeyframes (the union of their key times; a member
/// without a key there reads its own baked curve, a member not baked at all its
/// stored value). Returns the keys written.
std::size_t write_tracks(JobApply& a, const std::string& layer, const std::vector<std::pair<std::string, std::vector<Key>>>& tracks) {
  const doc::Document& d = a.document();
  const std::optional<std::string> comp = doc::comp_of_layer(d, layer);
  if (!comp) fail(ErrorCode::not_found, "no layer '" + layer + "'", {.layer = layer});
  const doc::Catalog cat = doc::catalog_for(d, layer);
  struct Group {
    const doc::PropBinding* b;
    std::map<std::string, const std::vector<Key>*> byMember;
  };
  std::vector<Group> groups;
  for (const auto& [member, keys] : tracks) {
    if (keys.empty()) continue;
    const doc::PropBinding* b = cat.by_member(member);
    if (b == nullptr || b->members.empty()) fail(ErrorCode::not_found, "'" + member + "' cannot be keyed on this layer", {.layer = layer});
    auto g = std::find_if(groups.begin(), groups.end(), [&](const Group& x) { return x.b->path == b->path; });
    if (g == groups.end()) {
      groups.push_back(Group{b, {}});
      g = std::prev(groups.end());
    }
    g->byMember[member] = &keys;
  }
  std::vector<api::SetKeyframes> sets;
  std::size_t count = 0;
  {
    const trackapply::DocView v(d, *comp);
    for (const Group& g : groups) {
      std::set<double> times;
      std::set<double> held;
      for (const auto& [member, keys] : g.byMember) {
        for (const Key& k : *keys) {
          times.insert(k.t);
          if (k.hold) held.insert(k.t);
        }
      }
      const bool spatial = std::find(g.b->members.begin(), g.b->members.end(), "x") != g.b->members.end();
      api::SetKeyframes set;
      set.prop = api::PropRef{layer, g.b->path};
      for (const double t : times) {
        std::vector<double> nums;
        nums.reserve(g.b->members.size());
        for (const std::string& member : g.b->members) {
          const auto m = g.byMember.find(member);
          const double value = m != g.byMember.end() ? value_at(*m->second, t) : v.member_stored_at(layer, member, t);
          nums.push_back(value * doc::api_unit_factor(member));
        }
        api::Keyframe k;
        k.time = doc::seconds_to_flicks(t);
        k.value = doc::vector_value(g.b->valueType, nums);
        k.easing = held.contains(t) ? api::Easing::hold : api::Easing::linear;
        // A baked path is its samples joined straight (the TS keyed x / y as scalars: no spatial curve).
        if (spatial) k.spatial_interp = api::SpatialInterp::linear;
        set.keys.push_back(std::move(k));
      }
      count += set.keys.size();
      sets.push_back(std::move(set));
    }
  }
  for (api::SetKeyframes& s : sets) (void)a.run(command(std::move(s)));
  return count;
}

double comp_fps_of(const doc::Document& d, const std::string& comp) {
  const double fps = doc::comp_fps(d, comp);
  return fps > 0 ? fps : 30;
}

std::string layer_comp(const doc::Document& d, const std::string& layer) {
  const std::optional<std::string> comp = d.node(layer) != nullptr ? doc::comp_of_layer(d, layer) : std::nullopt;
  if (!comp || *comp == layer) fail(ErrorCode::not_found, "no layer '" + layer + "'", {.layer = layer});
  return *comp;
}

// ── Physics ─────────────────────────────────────────────────────────────────

/// flattenComposition(graph, rootId): the root, then its subtree depth-first, children back-most first
/// (snapshot_build.cpp's walk order — the order the renderer seeds bodies in).
std::vector<const doc::Node*> flatten(const doc::Document& d, const std::string& rootId) {
  std::vector<const doc::Node*> out;
  const doc::Node* root = d.node(rootId);
  if (root == nullptr) return out;
  struct Frame {
    const doc::Node* n;
    std::size_t next;
  };
  std::vector<Frame> stack{{root, 0}};
  out.push_back(root);
  std::set<std::string, std::less<>> seen{root->id};
  while (!stack.empty()) {
    Frame& f = stack.back();
    if (f.next >= f.n->children.size()) {
      stack.pop_back();
      continue;
    }
    const std::string& cid = f.n->children[f.next++];
    const doc::Node* child = d.node(cid);
    if (child == nullptr || !seen.insert(child->id).second) continue;
    out.push_back(child);
    stack.push_back({child, 0});
  }
  return out;
}

/// The raw `__physics` object of the first component carrying one (readNodePhysicsRaw), or undefined.
const doc::Json* physics_raw(const doc::Node& n) {
  for (const doc::Component& c : n.components) {
    const doc::Json& raw = c.props.at("__physics");
    if (raw.is_object()) return &raw;
  }
  return nullptr;
}

/// snapshot_build.cpp's seeds: every enabled body of the composition at its AUTHORED pose (readBase).
std::vector<physics::BodySeed> collect_seeds(const doc::Document& d, const std::string& comp) {
  std::vector<physics::BodySeed> seeds;
  for (const doc::Node* n : flatten(d, comp)) {
    const doc::Json* raw = physics_raw(*n);
    if (raw == nullptr) continue;
    const std::optional<physics::BodyConfig> cfg = physics::read_physics(*raw);
    if (!cfg) continue;
    physics::BodySeed s;
    s.id = n->id;
    std::optional<double> w;
    std::optional<double> h;
    for (const doc::Component& c : n->components) {
      const doc::Json& p = c.props;
      if (p.at("x").is_number()) s.x = p.at("x").num();
      if (p.at("y").is_number()) s.y = p.at("y").num();
      if (p.at("rotation").is_number()) s.rotation = p.at("rotation").num();
      if (p.at("width").is_number()) w = p.at("width").num();
      if (p.at("height").is_number()) h = p.at("height").num();
    }
    s.width = w.value_or(100);
    s.height = h.value_or(100);
    s.cfg = *cfg;
    seeds.push_back(std::move(s));
  }
  return seeds;
}

struct PhysicsTarget {
  std::string id;
  std::string physicsJson;  ///< `{...raw, enabled: false}`
  std::vector<std::pair<std::string, std::vector<Key>>> tracks;
};

class PhysicsBakeResult final : public JobResult {
 public:
  PhysicsBakeResult(std::vector<PhysicsTarget> targets, std::size_t frames) : targets_(std::move(targets)), frames_(frames) {}

  [[nodiscard]] std::string summary_json() const override {
    std::string s = "{\"layers\":[";
    std::size_t tracks = 0;
    std::size_t keys = 0;
    for (std::size_t i = 0; i < targets_.size(); ++i) {
      s += (i > 0 ? "," : "") + json_string(targets_[i].id);
      for (const auto& [member, k] : targets_[i].tracks) {
        if (k.empty()) continue;
        ++tracks;
        keys += k.size();
      }
    }
    return s + "],\"frames\":" + std::to_string(frames_) + ",\"tracks\":" + std::to_string(tracks) +
           ",\"keyframes\":" + std::to_string(keys) + "}";
  }
  [[nodiscard]] std::string label() const override { return "Bake physics to keyframes"; }
  [[nodiscard]] bool has_edits() const override { return !targets_.empty(); }

  void apply(JobApply& a) const override {
    for (const PhysicsTarget& t : targets_) (void)write_tracks(a, t.id, t.tracks);
    // The solver off in the SAME entry: from here the keys are all that moves the layer.
    api::SetProperties off;
    for (const PhysicsTarget& t : targets_) {
      off.writes.push_back(api::PropertyWrite{api::PropRef{t.id, "layer/physics"}, doc::v_json(t.physicsJson), std::nullopt});
    }
    if (!off.writes.empty()) (void)a.run(command(std::move(off)));
  }

 private:
  std::vector<PhysicsTarget> targets_;
  std::size_t frames_;
};

#if defined(PREMATION_JOBS_HAVE_SCENE) && PREMATION_JOBS_HAVE_SCENE
// ── Particles ───────────────────────────────────────────────────────────────

struct BakedParticle {
  double index = 0;
  double baseSize = 1;
  Samples x, y, scale, opacity;
};

struct ParticleJob {
  std::string emitter;
  std::string comp;
  std::string containerName;
  bool square = false;
  std::string fill;
  Range range;
  std::vector<BakedParticle> particles;
  std::size_t seen = 0;
  bool capped = false;
};

/// `padLife`: a zero hold one frame outside the track on either side (not before 0).
std::vector<Key> pad_life(std::vector<Key> keys, double fps) {
  if (keys.empty()) return keys;
  const double dt = 1 / fps;
  std::vector<Key> out;
  if (keys.front().t - dt >= 0) out.push_back(Key{keys.front().t - dt, 0, true});
  const double last = keys.back().t;
  out.insert(out.end(), keys.begin(), keys.end());
  out.push_back(Key{last + dt, 0, true});
  return out;
}

class ParticleBakeResult final : public JobResult {
 public:
  explicit ParticleBakeResult(ParticleJob job) : job_(std::move(job)) {}

  [[nodiscard]] std::string summary_json() const override {
    std::string s = "{\"containerId\":" + json_string(containerId_) + ",\"layerIds\":[";
    for (std::size_t i = 0; i < layerIds_.size(); ++i) s += (i > 0 ? "," : "") + json_string(layerIds_[i]);
    return s + "],\"seen\":" + std::to_string(job_.seen) + ",\"capped\":" + (job_.capped ? "true" : "false") +
           ",\"particles\":" + std::to_string(job_.particles.size()) + ",\"keyframes\":" + std::to_string(keyframes_) + "}";
  }
  [[nodiscard]] std::string label() const override { return "Bake particles to layers"; }
  [[nodiscard]] bool has_edits() const override { return !job_.particles.empty(); }

  void apply(JobApply& a) const override {
    containerId_.clear();
    layerIds_.clear();
    keyframes_ = 0;
    api::CreateLayer container;
    container.comp = job_.comp;
    container.kind = api::LayerKind::null;
    container.name = job_.containerName;
    container.parent = job_.emitter;
    container.init.push_back(api::PropertyInit{"transform/position", doc::v_vec2(0, 0)});
    const std::optional<api::LayerRef> made = result_payload<api::LayerRef>(a.run(command(std::move(container))));
    if (!made) fail(ErrorCode::internal, "createLayer returned no null");
    containerId_ = made->layer;
    const double tol = job_.range.tolerance;
    for (const BakedParticle& p : job_.particles) {
      api::CreateLayer create;
      create.comp = job_.comp;
      create.kind = job_.square ? api::LayerKind::rectangle : api::LayerKind::ellipse;
      create.name = "Particle " + json_number(p.index);
      create.parent = containerId_;
      create.init.push_back(api::PropertyInit{"transform/position", doc::v_vec2(0, 0)});
      const std::optional<api::LayerRef> layer = result_payload<api::LayerRef>(a.run(command(std::move(create))));
      if (!layer) fail(ErrorCode::internal, "createLayer returned no layer");
      layerIds_.push_back(layer->layer);
      set_box(a, layer->layer, p.baseSize);
      std::vector<std::pair<std::string, std::vector<Key>>> tracks;
      tracks.emplace_back("x", finish_track(p.x, tol));
      tracks.emplace_back("y", finish_track(p.y, tol));
      tracks.emplace_back("scaleX", finish_track(p.scale, tol));
      tracks.emplace_back("scaleY", finish_track(p.scale, tol));
      tracks.emplace_back("opacity", pad_life(finish_track(p.opacity, tol), job_.range.fps));
      keyframes_ += write_tracks(a, layer->layer, tracks);
    }
    api::SetLayerSwitches hide;
    hide.layers = {job_.emitter};
    hide.patch.visible = false;
    (void)a.run(command(std::move(hide)));
  }

 private:
  /// The layer built at the particle's first-seen size, filled with the emitter's start colour.
  void set_box(JobApply& a, const std::string& layer, double size) const {
    const doc::Catalog cat = doc::catalog_for(a.document(), layer);
    api::SetProperties writes;
    if (const doc::PropBinding* b = cat.by_member("width"); b != nullptr && !b->members.empty()) {
      std::vector<double> nums;
      for (const std::string& m : b->members) nums.push_back(m == "width" || m == "height" ? size : 0);
      writes.writes.push_back(api::PropertyWrite{api::PropRef{layer, b->path}, doc::vector_value(b->valueType, nums), std::nullopt});
    }
    if (!job_.fill.empty()) {
      if (const doc::PropBinding* b = cat.find("layer/fill"); b != nullptr) {
        const api::Color c = doc::hex_to_color(doc::Json::string(job_.fill), api::Color{1, 1, 1, 1});
        writes.writes.push_back(api::PropertyWrite{api::PropRef{layer, b->path}, doc::v_color(c.r, c.g, c.b, c.a), std::nullopt});
      }
    }
    if (!writes.writes.empty()) (void)a.run(command(std::move(writes)));
  }

  ParticleJob job_;
  mutable std::string containerId_;
  mutable std::vector<std::string> layerIds_;
  mutable std::size_t keyframes_ = 0;
};
#endif

}  // namespace

PreparedJob prepare_physics_bake(const api::PhysicsBakeJob& spec, const JobDocContext& ctx) {
  if (spec.layers.empty()) fail(ErrorCode::invalid_argument, "no layers to bake");
  const std::string comp = layer_comp(ctx.doc, spec.layers.front());
  for (const std::string& id : spec.layers) {
    if (layer_comp(ctx.doc, id) != comp) fail(ErrorCode::invalid_argument, "the layers to bake must share one composition", {.layer = id});
  }
  const Range range = range_of(spec.range, comp_fps_of(ctx.doc, comp), spec.every_n_frames, spec.simplify_tolerance);
  std::vector<physics::BodySeed> seeds = collect_seeds(ctx.doc, comp);
  // Only DYNAMIC bodies have a simulated pose (poses_at omits static ones).
  std::vector<std::string> targets;
  for (const std::string& id : spec.layers) {
    const bool dynamic = std::any_of(seeds.begin(), seeds.end(), [&](const physics::BodySeed& s) { return s.id == id && s.cfg.kind == "dynamic"; });
    if (dynamic && std::find(targets.begin(), targets.end(), id) == targets.end()) targets.push_back(id);
  }
  if (targets.empty()) fail(ErrorCode::invalid_argument, "Nothing to bake: select a layer with an enabled DYNAMIC rigid body.");
  physics::World world;
  {
    double cw = 1920;
    double ch = 1080;
    if (const doc::Json* rec = ctx.doc.comp(comp); rec != nullptr && rec->at("width").is_number() && rec->at("height").is_number()) {
      cw = rec->at("width").num();
      ch = rec->at("height").num();
    }
    world.bounds = physics::Bounds{0, 0, cw, ch};
  }
  std::vector<std::string> physicsJson;
  for (const std::string& id : targets) {
    // readNodePhysicsRaw: {...DEFAULT_PHYSICS_BODY, ...raw}, then enabled off.
    doc::Json j = doc::Json::object();
    j.set("enabled", doc::Json::boolean(false));
    j.set("kind", doc::Json::string("dynamic"));
    j.set("shape", doc::Json::string("box"));
    j.set("mass", doc::Json::number(1));
    j.set("restitution", doc::Json::number(0.4));
    j.set("friction", doc::Json::number(0.2));
    j.set("damping", doc::Json::number(0.999));
    j.set("rotate", doc::Json::boolean(false));
    if (const doc::Json* raw = physics_raw(*ctx.doc.node(id)); raw != nullptr) {
      for (const auto& [k, v] : raw->obj()) j.set(k, v);
    }
    j.set("enabled", doc::Json::boolean(false));
    physicsJson.push_back(js::stringify(j));
  }
  return PreparedJob{"physicsBake", [seeds = std::move(seeds), world, range, targets = std::move(targets),
                                     physicsJson = std::move(physicsJson)](JobControl& control) -> std::unique_ptr<JobResult> {
    const std::vector<double> frames = bake_frames(range);
    std::map<std::string, std::array<Samples, 3>> samples;  // x, y, rotation
    for (std::size_t i = 0; i < frames.size(); ++i) {
      if (control.cancelled()) return nullptr;
      const double frame = frames[i];
      const std::map<std::string, physics::Pose> poses = physics::poses_at(seeds, world, range.fps, frame);
      const double t = frame / range.fps;
      for (const std::string& id : targets) {
        const auto it = poses.find(id);
        if (it == poses.end()) continue;
        auto& b = samples[id];
        b[0].emplace_back(t, it->second.x);
        b[1].emplace_back(t, it->second.y);
        if (it->second.rotation) b[2].emplace_back(t, *it->second.rotation);
      }
      if (i % 16 == 0) control.progress(static_cast<double>(i) / static_cast<double>(frames.size()), "Baking frame " + std::to_string(i + 1));
    }
    std::vector<PhysicsTarget> out;
    for (std::size_t i = 0; i < targets.size(); ++i) {
      const auto it = samples.find(targets[i]);
      if (it == samples.end()) continue;
      PhysicsTarget pt{targets[i], physicsJson[i], {}};
      const char* names[] = {"x", "y", "rotation"};
      for (std::size_t k = 0; k < 3; ++k) {
        if (!it->second[k].empty()) pt.tracks.emplace_back(names[k], finish_track(it->second[k], range.tolerance));
      }
      out.push_back(std::move(pt));
    }
    return std::make_unique<PhysicsBakeResult>(std::move(out), frames.size());
  }};
}

PreparedJob prepare_particle_bake(const api::ParticleBakeJob& spec, const JobDocContext& ctx) {
#if defined(PREMATION_JOBS_HAVE_SCENE) && PREMATION_JOBS_HAVE_SCENE
  ParticleJob job;
  job.emitter = spec.layer;
  job.comp = layer_comp(ctx.doc, spec.layer);
  const doc::Node& n = *ctx.doc.node(spec.layer);
  const doc::Json stored = scene::read_node_particle(n);
  if (stored.is_undefined() || !stored.is_object()) fail(ErrorCode::invalid_argument, "that layer is not a particle emitter", {.layer = spec.layer});
  if (!ctx.layerValues) fail(ErrorCode::unsupported, "this engine cannot evaluate the emitter's tracks", {.layer = spec.layer});
  job.range = range_of(spec.range, comp_fps_of(ctx.doc, job.comp), spec.every_n_frames, spec.simplify_tolerance);
  job.containerName = (n.name.empty() ? std::string("Emitter") : n.name) + " Baked";
  job.square = stored.at("shape").is_string() && stored.at("shape").str() == "square";
  if (stored.at("colorStart").is_string()) job.fill = stored.at("colorStart").str();
  // The emitter box as the renderer syncs it (the authored width / height, evaluated values winning; else 2·radius, else 140).
  std::optional<double> gw, gh, radius;
  for (const doc::Component& c : n.components) {
    const doc::Json& p = c.props;
    if (p.at("width").is_number()) gw = p.at("width").num();
    if (p.at("height").is_number()) gh = p.at("height").num();
    if (p.at("radius").is_number()) radius = p.at("radius").num();
    else if (p.at("outerRadius").is_number()) radius = p.at("outerRadius").num();
    else if (p.at("r").is_number()) radius = p.at("r").num();
  }
  // The config the renderer would use at each frame — resolved here, on the core thread (it reads the document).
  const std::vector<double> frames = bake_frames(job.range);
  std::vector<doc::Json> configs;
  configs.reserve(frames.size());
  for (const double frame : frames) {
    const scene::Values values(ctx.layerValues(spec.layer, frame / job.range.fps));
    std::optional<double> w = gw;
    std::optional<double> h = gh;
    if (const auto v = values.get("width")) w = v;
    if (const auto v = values.get("height")) h = v;
    const bool authored = w && h && *w > 0 && *h > 0;
    doc::Json synced = stored;
    synced.set("emitterWidth", doc::Json::number(authored ? *w : radius && *radius > 0 ? *radius * 2 : 140));
    synced.set("emitterHeight", doc::Json::number(authored ? *h : radius && *radius > 0 ? *radius * 2 : 140));
    configs.push_back(scene::resolve_particle_config(synced, values));
  }
  const std::size_t cap = std::max<std::uint32_t>(1, spec.max_particles.value_or(200));
  return PreparedJob{"particleBake", [job = std::move(job), frames, configs = std::move(configs), cap](JobControl& control) mutable -> std::unique_ptr<JobResult> {
    std::map<double, BakedParticle> byIndex;
    const std::string key = "bake:" + job.emitter;
    for (std::size_t i = 0; i < frames.size(); ++i) {
      if (control.cancelled()) return nullptr;
      const double t = frames[i] / job.range.fps;
      for (const scene::ParticleSample& p : scene::particles_at_frame(configs[i], frames[i], job.range.fps, key)) {
        auto it = byIndex.find(p.index);
        if (it == byIndex.end()) {
          BakedParticle rec;
          rec.index = p.index;
          rec.baseSize = std::max(1.0, p.size);
          it = byIndex.emplace(p.index, std::move(rec)).first;
        }
        BakedParticle& rec = it->second;
        rec.x.emplace_back(t, p.x);
        rec.y.emplace_back(t, p.y);
        rec.scale.emplace_back(t, p.size / rec.baseSize);
        rec.opacity.emplace_back(t, std::max(0.0, std::min(1.0, p.opacity)) * 100);
      }
      if (i % 16 == 0) control.progress(static_cast<double>(i) / static_cast<double>(frames.size()), "Baking frame " + std::to_string(i + 1));
    }
    job.seen = byIndex.size();
    job.capped = job.seen > cap;
    for (auto& [index, rec] : byIndex) {  // by birth index: a capped bake is the front of the emission
      if (job.particles.size() >= cap) break;
      job.particles.push_back(std::move(rec));
    }
    if (job.particles.empty()) fail(ErrorCode::invalid_argument, "Nothing to bake: the range holds no particles.");
    return std::make_unique<ParticleBakeResult>(std::move(job));
  }};
#else
  (void)spec;
  (void)ctx;
  fail(ErrorCode::unsupported, "this engine build cannot bake particles (no scene library)");
#endif
}

}  // namespace premation::jobs
