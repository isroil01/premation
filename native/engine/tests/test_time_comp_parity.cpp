// Cross-engine parity of the time / composition family (tests/data/
// time_comp_parity.json, frozen from the TypeScript engine's
// timeCompCrossEngine.test.ts): composition instances (sealed recursive passes,
// collapsed clones, Essential Properties, the cycle guard), precomp and layer
// retime, frame blending, temporal ghosts, auto-orient, points bound to nulls,
// Continuous Rasterization and corner pin. Each case opens the SAME document
// the TypeScript exported (the golden harness's sceneToProject), builds the
// snapshot and FrameScene with the engine's own builder, and must reproduce the
// TypeScript's projection — and report nothing unported. PARITY_REBLESS=1
// writes the C++ answers instead (parity_rebless.hpp): the projection below
// (proj_layer / proj_renderable) mirrors the TypeScript's projLayer /
// projRenderable key for key.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

#include "docexpr.hpp"
#include "docio.hpp"
#include "frame_build.hpp"
#include "path_ops.hpp"
#include "json.hpp"
#include "model.hpp"
#include "parity_rebless.hpp"
#include "snapshot_build.hpp"
#include "scene_textures.hpp"
#include "timeline.hpp"

using premation::js::Json;
using premation::test::json_numbers;
namespace doc = premation::doc;
namespace sc = premation::scene;
namespace api = premation::api;

namespace {

/// Collects the first mismatches by path.
struct Cmp {
  std::vector<std::string> diffs;
  void num(const std::string& path, double got, const Json& want) {
    if (want.is_null() || want.is_undefined()) {
      diffs.push_back(path + ": expected none, got " + std::to_string(got));
      return;
    }
    const double w = want.num();
    if (std::isnan(w) && std::isnan(got)) return;
    if (!(std::abs(got - w) <= 1e-9 * std::max(1.0, std::abs(w)))) {
      std::ostringstream o;
      o.precision(17);
      o << path << ": got " << got << " want " << w;
      diffs.push_back(o.str());
    }
  }
  void opt(const std::string& path, const std::optional<double>& got, const Json& want) {
    if (!got) {
      if (!want.is_null()) diffs.push_back(path + ": expected a value, got none");
      return;
    }
    num(path, *got, want);
  }
  void str(const std::string& path, const std::string& got, const Json& want) {
    const std::string w = want.is_string() ? want.str() : "<null>";
    if (got != w) diffs.push_back(path + ": got '" + got + "' want '" + w + "'");
  }
  void boolean(const std::string& path, bool got, const Json& want) {
    if (got != want.b()) diffs.push_back(path + ": got " + (got ? "true" : "false"));
  }
  template <typename V>
  void vec(const std::string& path, const V& got, const Json& want) {
    if (!want.is_array()) {
      if (!got.empty()) diffs.push_back(path + ": expected none, got " + std::to_string(got.size()));
      return;
    }
    if (want.arr().size() != got.size()) {
      diffs.push_back(path + ": size " + std::to_string(got.size()) + " want " + std::to_string(want.arr().size()));
      return;
    }
    for (std::size_t i = 0; i < got.size(); ++i) num(path + "[" + std::to_string(i) + "]", static_cast<double>(got[i]), want.arr()[i]);
  }
};

void cmp_layers(Cmp& c, const std::string& at, const std::vector<sc::RLayer>& got, const Json& want);

void cmp_layer(Cmp& c, const std::string& at, const sc::RLayer& l, const Json& w) {
  const std::string p = at + l.id + ".";
  c.boolean(p + "visible", l.visible, w.at("visible"));
  c.num(p + "x", l.x, w.at("x"));
  c.num(p + "y", l.y, w.at("y"));
  c.num(p + "rotation", l.rotation, w.at("rotation"));
  c.num(p + "scaleX", l.scaleX, w.at("scaleX"));
  c.num(p + "scaleY", l.scaleY, w.at("scaleY"));
  c.num(p + "anchorX", l.anchorX, w.at("anchorX"));
  c.num(p + "anchorY", l.anchorY, w.at("anchorY"));
  c.num(p + "opacity", l.opacity, w.at("opacity"));
  c.num(p + "width", l.width, w.at("width"));
  c.num(p + "height", l.height, w.at("height"));
  c.str(p + "blend", l.blend, w.at("blend"));
  c.opt(p + "sourceTime", l.sourceTime, w.at("sourceTime"));
  if (w.at("frameBlend").is_object()) {
    if (!l.frameBlend) {
      c.diffs.push_back(p + "frameBlend: missing");
    } else {
      c.num(p + "frameBlend.a", l.frameBlend->a, w.at("frameBlend").at("a"));
      c.num(p + "frameBlend.b", l.frameBlend->b, w.at("frameBlend").at("b"));
      c.num(p + "frameBlend.weight", l.frameBlend->weight, w.at("frameBlend").at("weight"));
      c.str(p + "frameBlend.mode", l.frameBlend->mode, w.at("frameBlend").at("mode"));
    }
  } else if (l.frameBlend) {
    c.diffs.push_back(p + "frameBlend: unexpected");
  }
  if (w.at("cornerPin").is_array()) {
    if (!l.cornerPin) c.diffs.push_back(p + "cornerPin: missing");
    else c.vec(p + "cornerPin", *l.cornerPin, w.at("cornerPin"));
  } else if (l.cornerPin) {
    c.diffs.push_back(p + "cornerPin: unexpected");
  }
  c.boolean(p + "continuousRaster", l.continuousRaster, w.at("continuousRaster"));
  const Json& ms = w.at("motionSamples");
  if (ms.arr().size() != (l.motionSamples.size() > 1 ? l.motionSamples.size() : 0)) {
    c.diffs.push_back(p + "motionSamples: " + std::to_string(l.motionSamples.size()) + " want " + std::to_string(ms.arr().size()));
  } else {
    for (std::size_t i = 0; i < ms.arr().size(); ++i) {
      const sc::MotionSample& s = l.motionSamples[i];
      const std::vector<double> got = {s.x, s.y, s.rotation, s.scaleX, s.scaleY, s.opacity};
      c.vec(p + "motionSamples[" + std::to_string(i) + "]", got, ms.arr()[i]);
    }
  }
  const std::size_t maskPaths = l.mask.is_object() && l.mask.at("paths").is_array() ? l.mask.at("paths").arr().size() : 0;
  c.num(p + "maskPaths", static_cast<double>(maskPaths), w.at("maskPaths"));
  if (w.at("pathPoints").is_array()) {
    if (!l.pathPoints.is_array() || l.pathPoints.arr().size() != w.at("pathPoints").arr().size()) {
      c.diffs.push_back(p + "pathPoints: count differs");
    } else {
      for (std::size_t i = 0; i < l.pathPoints.arr().size(); ++i) {
        const Json& q = l.pathPoints.arr()[i];
        const std::vector<double> got = {q.at("x").num(), q.at("y").num(), q.at("inX").num(), q.at("inY").num(), q.at("outX").num(), q.at("outY").num()};
        c.vec(p + "pathPoints[" + std::to_string(i) + "]", got, w.at("pathPoints").arr()[i]);
      }
    }
  }
  if (w.at("subpaths").is_array()) {
    if (!l.subpaths.is_array() || l.subpaths.arr().size() != w.at("subpaths").arr().size()) {
      c.diffs.push_back(p + "subpaths: count differs");
    } else {
      for (std::size_t s = 0; s < l.subpaths.arr().size(); ++s) {
        const Json& gotPts = l.subpaths.arr()[s].at("points");
        const Json& wantPts = w.at("subpaths").arr()[s];
        if (gotPts.arr().size() != wantPts.arr().size()) {
          c.diffs.push_back(p + "subpaths[" + std::to_string(s) + "]: point count differs");
          continue;
        }
        for (std::size_t i = 0; i < gotPts.arr().size(); ++i) {
          const std::vector<double> got = {gotPts.arr()[i].at("x").num(), gotPts.arr()[i].at("y").num()};
          c.vec(p + "subpaths[" + std::to_string(s) + "][" + std::to_string(i) + "]", got, wantPts.arr()[i]);
        }
      }
    }
  } else if (l.subpaths.is_array()) {
    c.diffs.push_back(p + "subpaths: unexpected");
  }
  c.boolean(p + "precompScene3d", l.precompScene3d.has_value(), w.at("precompScene3d"));
  if (!w.at("depth").is_null()) c.num(p + "depth", l.depth, w.at("depth"));
  const auto optArr = [&](const std::string& what, const auto& got, const Json& want) {
    if (want.is_array()) {
      if (!got) c.diffs.push_back(p + what + ": missing");
      else c.vec(p + what, *got, want);
    } else if (got) {
      c.diffs.push_back(p + what + ": unexpected");
    }
  };
  if (w.at("particles").is_string()) {
    c.str(p + "particles", l.particles.is_undefined() ? std::string("<none>") : premation::js::stringify(l.particles), w.at("particles"));
  } else if (!l.particles.is_undefined()) {
    c.diffs.push_back(p + "particles: unexpected");
  }
  c.str(p + "contentAwareFillSrc", l.contentAwareFillSrc.value_or("<null>"),
        w.at("contentAwareFillSrc").is_string() ? w.at("contentAwareFillSrc") : Json::string("<null>"));
  optArr("matrix", l.matrix, w.at("matrix"));
  optArr("world3d", l.world3d, w.at("world3d"));
  optArr("quad3d", l.quad3d, w.at("quad3d"));
  optArr("lighting", l.lighting, w.at("lighting"));
  const Json& sq = w.at("sampleQuads");
  if (sq.arr().size() == (l.motionSamples.size() > 1 ? l.motionSamples.size() : 0)) {
    for (std::size_t i = 0; i < sq.arr().size(); ++i) optArr("sampleQuads[" + std::to_string(i) + "]", l.motionSamples[i].quad, sq.arr()[i]);
  }
  std::size_t pathIdx = 0;
  const Json::Array& wantPaths = w.at("effectPaths").arr();
  for (const Json& e : l.effects) {
    const Json& pts = e.at("params").at("pathPoints");
    if (!pts.is_array()) continue;
    const std::string q = p + "effectPaths[" + std::to_string(pathIdx) + "].";
    if (pathIdx >= wantPaths.size()) {
      c.diffs.push_back(q + "unexpected");
      break;
    }
    const Json& want = wantPaths[pathIdx++];
    c.str(q + "id", e.at("id").str(), want.at("id"));
    std::vector<double> got;
    for (const Json& v : pts.arr()) got.push_back(v.num());
    c.vec(q + "points", got, want.at("points"));
    const Json& closed = e.at("params").at("pathClosed");
    if (want.at("closed").is_null() != closed.is_undefined()) c.diffs.push_back(q + "closed: presence differs");
    else if (closed.is_bool()) c.boolean(q + "closed", closed.b(), want.at("closed"));
  }
  if (pathIdx != wantPaths.size()) c.diffs.push_back(p + "effectPaths: " + std::to_string(pathIdx) + " want " + std::to_string(wantPaths.size()));
  if (w.at("precompLayers").is_array()) {
    if (!l.precompLayers) c.diffs.push_back(p + "precompLayers: missing");
    else cmp_layers(c, p, *l.precompLayers, w.at("precompLayers"));
  } else if (l.precompLayers) {
    c.diffs.push_back(p + "precompLayers: unexpected");
  }
}

void cmp_layers(Cmp& c, const std::string& at, const std::vector<sc::RLayer>& got, const Json& want) {
  if (got.size() != want.arr().size()) {
    std::string ids;
    for (const sc::RLayer& l : got) ids += l.id + " ";
    c.diffs.push_back(at + "layers: " + std::to_string(got.size()) + " want " + std::to_string(want.arr().size()) + " (" + ids + ")");
    return;
  }
  for (std::size_t i = 0; i < got.size(); ++i) {
    c.str(at + "[" + std::to_string(i) + "].id", got[i].id, want.arr()[i].at("id"));
    cmp_layer(c, at, got[i], want.arr()[i]);
  }
}

void cmp_renderables(Cmp& c, const std::string& at, const std::vector<api::Renderable>& got, const Json& want) {
  if (got.size() != want.arr().size()) {
    std::string ids;
    for (const api::Renderable& r : got) ids += r.id + " ";
    c.diffs.push_back(at + "renderables: " + std::to_string(got.size()) + " want " + std::to_string(want.arr().size()) + " (" + ids + ")");
    return;
  }
  for (std::size_t i = 0; i < got.size(); ++i) {
    const api::Renderable& r = got[i];
    const Json& w = want.arr()[i];
    const std::string p = at + r.id + ".";
    c.str(p + "id", r.id, w.at("id"));
    c.str(p + "kind", std::string(api::to_string(r.kind)), w.at("kind"));
    c.str(p + "textureKey", r.texture_key.value_or("<null>"), w.at("textureKey").is_string() ? w.at("textureKey") : Json::string("<null>"));
    c.str(p + "maskTextureKey", r.mask_texture_key.value_or("<null>"),
          w.at("maskTextureKey").is_string() ? w.at("maskTextureKey") : Json::string("<null>"));
    c.vec(p + "modelMatrix", r.model_matrix, w.at("modelMatrix"));
    const std::vector<double> b = {r.bounds.x, r.bounds.y, r.bounds.width, r.bounds.height};
    c.vec(p + "bounds", b, w.at("bounds"));
    c.num(p + "opacity", r.opacity, w.at("opacity"));
    c.str(p + "blend", std::string(api::to_string(r.blend)), w.at("blend"));
    c.vec(p + "cornerPin", r.corner_pin, w.at("cornerPin"));
    const Json& ms = w.at("motionSamples");
    if (ms.arr().size() != r.motion_samples.size()) {
      c.diffs.push_back(p + "motionSamples: " + std::to_string(r.motion_samples.size()) + " want " + std::to_string(ms.arr().size()));
    } else {
      for (std::size_t k = 0; k < ms.arr().size(); ++k) {
        std::vector<double> v = r.motion_samples[k].model_matrix;
        v.push_back(r.motion_samples[k].opacity);
        c.vec(p + "motionSamples[" + std::to_string(k) + "]", v, ms.arr()[k]);
      }
    }
    const Json& pc = w.at("precomp");
    if (pc.is_object()) {
      if (!r.precomp) {
        c.diffs.push_back(p + "precomp: missing");
        continue;
      }
      if (pc.at("flat").is_array()) {
        c.opt(p + "flat.w", r.precomp->flat_width, pc.at("flat").arr()[0]);
        c.opt(p + "flat.h", r.precomp->flat_height, pc.at("flat").arr()[1]);
      }
      if (pc.at("projection").is_array()) {
        if (!r.precomp->camera3d) c.diffs.push_back(p + "precomp.camera3d: missing");
        else c.vec(p + "precomp.projection", r.precomp->camera3d->projection, pc.at("projection"));
      } else if (r.precomp->camera3d) {
        c.diffs.push_back(p + "precomp.camera3d: unexpected");
      }
      cmp_renderables(c, p, r.precomp_children, pc.at("renderables"));
    } else if (r.precomp) {
      c.diffs.push_back(p + "precomp: unexpected");
    }
  }
}

// ── the TypeScript projection (projLayer / projRenderable), for re-blessing ──

Json jnum(double v) { return Json::number(v); }
Json str_or_null(const std::optional<std::string>& v) { return v ? Json::string(*v) : Json::null(); }
Json num_or_null(const std::optional<double>& v) { return v ? Json::number(*v) : Json::null(); }
template <typename A>
Json nums_or_null(const std::optional<A>& v) {
  return v ? json_numbers(*v) : Json::null();
}
/// A member read as JSON.stringify writes it inside an array (undefined → null).
Json elem(const Json& v) { return v.is_undefined() ? Json::null() : v; }

Json proj_layers(const std::vector<sc::RLayer>& layers);

Json proj_layer(const sc::RLayer& l) {
  Json o = Json::object();
  o.set("id", Json::string(l.id));
  o.set("visible", Json::boolean(l.visible));
  o.set("x", jnum(l.x));
  o.set("y", jnum(l.y));
  o.set("rotation", jnum(l.rotation));
  o.set("scaleX", jnum(l.scaleX));
  o.set("scaleY", jnum(l.scaleY));
  o.set("anchorX", jnum(l.anchorX));
  o.set("anchorY", jnum(l.anchorY));
  o.set("opacity", jnum(l.opacity));
  o.set("width", jnum(l.width));
  o.set("height", jnum(l.height));
  o.set("blend", Json::string(l.blend.empty() ? std::string("normal") : l.blend));
  o.set("sourceTime", num_or_null(l.sourceTime));
  if (l.frameBlend) {
    Json fb = Json::object();
    fb.set("a", jnum(l.frameBlend->a));
    fb.set("b", jnum(l.frameBlend->b));
    fb.set("weight", jnum(l.frameBlend->weight));
    fb.set("mode", Json::string(l.frameBlend->mode.empty() ? std::string("mix") : l.frameBlend->mode));
    o.set("frameBlend", std::move(fb));
  } else {
    o.set("frameBlend", Json::null());
  }
  o.set("cornerPin", nums_or_null(l.cornerPin));
  o.set("continuousRaster", Json::boolean(l.continuousRaster));
  Json::Array ms;
  if (l.motionSamples.size() > 1) {
    for (const sc::MotionSample& m : l.motionSamples) ms.push_back(json_numbers(std::array{m.x, m.y, m.rotation, m.scaleX, m.scaleY, m.opacity}));
  }
  o.set("motionSamples", Json::array(std::move(ms)));
  const std::size_t maskPaths = l.mask.is_object() && l.mask.at("paths").is_array() ? l.mask.at("paths").arr().size() : 0;
  o.set("maskPaths", jnum(static_cast<double>(maskPaths)));
  if (l.pathPoints.is_array()) {
    Json::Array pts;
    for (const Json& q : l.pathPoints.arr()) {
      pts.push_back(Json::array(Json::Array{elem(q.at("x")), elem(q.at("y")), elem(q.at("inX")), elem(q.at("inY")), elem(q.at("outX")),
                                            elem(q.at("outY"))}));
    }
    o.set("pathPoints", Json::array(std::move(pts)));
  } else {
    o.set("pathPoints", Json::null());
  }
  if (l.subpaths.is_array()) {
    Json::Array subs;
    for (const Json& sp : l.subpaths.arr()) {
      Json::Array pts;
      for (const Json& q : sp.at("points").arr()) pts.push_back(Json::array(Json::Array{elem(q.at("x")), elem(q.at("y"))}));
      subs.push_back(Json::array(std::move(pts)));
    }
    o.set("subpaths", Json::array(std::move(subs)));
  } else {
    o.set("subpaths", Json::null());
  }
  o.set("precompScene3d", Json::boolean(l.precompScene3d.has_value()));
  o.set("depth", l.matrix ? jnum(l.depth) : Json::null());  // a 2D layer's depth is never read
  o.set("matrix", nums_or_null(l.matrix));
  o.set("world3d", nums_or_null(l.world3d));
  o.set("quad3d", nums_or_null(l.quad3d));
  o.set("lighting", nums_or_null(l.lighting));
  const bool hasParticles = !l.particles.is_undefined() && !l.particles.is_null();
  o.set("particles", hasParticles ? Json::string(premation::js::stringify(l.particles)) : Json::null());
  o.set("contentAwareFillSrc", str_or_null(l.contentAwareFillSrc));
  Json::Array sq;
  if (l.motionSamples.size() > 1) {
    for (const sc::MotionSample& m : l.motionSamples) sq.push_back(nums_or_null(m.quad));
  }
  o.set("sampleQuads", Json::array(std::move(sq)));
  Json::Array paths;
  for (const Json& e : l.effects) {
    const Json& params = e.at("params");
    if (!params.at("pathPoints").is_array()) continue;
    Json ep = Json::object();
    ep.set("id", e.at("id"));
    ep.set("points", params.at("pathPoints"));
    const Json& closed = params.at("pathClosed");
    ep.set("closed", closed.is_undefined() ? Json::null() : closed);
    paths.push_back(std::move(ep));
  }
  o.set("effectPaths", Json::array(std::move(paths)));
  o.set("precompLayers", l.precompLayers ? proj_layers(*l.precompLayers) : Json::null());
  return o;
}

Json proj_layers(const std::vector<sc::RLayer>& layers) {
  Json::Array a;
  for (const sc::RLayer& l : layers) a.push_back(proj_layer(l));
  return Json::array(std::move(a));
}

Json proj_renderables(const std::vector<api::Renderable>& rs);

Json proj_renderable(const api::Renderable& r) {
  Json o = Json::object();
  o.set("id", Json::string(r.id));
  o.set("kind", Json::string(std::string(api::to_string(r.kind))));
  o.set("textureKey", str_or_null(r.texture_key));
  o.set("maskTextureKey", str_or_null(r.mask_texture_key));
  o.set("modelMatrix", json_numbers(r.model_matrix));
  o.set("bounds", json_numbers(std::array{r.bounds.x, r.bounds.y, r.bounds.width, r.bounds.height}));
  o.set("opacity", jnum(r.opacity));
  o.set("blend", Json::string(std::string(api::to_string(r.blend))));
  o.set("cornerPin", r.corner_pin.empty() ? Json::null() : json_numbers(r.corner_pin));
  Json::Array ms;
  for (const api::RenderMotionSample& m : r.motion_samples) {
    std::vector<double> v = m.model_matrix;
    v.push_back(m.opacity);
    ms.push_back(json_numbers(v));
  }
  o.set("motionSamples", Json::array(std::move(ms)));
  if (r.precomp) {
    Json pc = Json::object();
    pc.set("flat", r.precomp->flat_width && r.precomp->flat_height ? json_numbers(std::array{*r.precomp->flat_width, *r.precomp->flat_height})
                                                                  : Json::null());
    pc.set("projection", r.precomp->camera3d ? json_numbers(r.precomp->camera3d->projection) : Json::null());
    pc.set("renderables", proj_renderables(r.precomp_children));
    o.set("precomp", std::move(pc));
  } else {
    o.set("precomp", Json::null());
  }
  return o;
}

Json proj_renderables(const std::vector<api::Renderable>& rs) {
  Json::Array a;
  for (const api::Renderable& r : rs) a.push_back(proj_renderable(r));
  return Json::array(std::move(a));
}

}  // namespace

TEST_CASE("time/comp parity: the C++ scene builder reproduces buildSnapshot + snapshotToFrameScene", "[scene][timecomp][parity]") {
  premation::test::JsonFixture fx("time_comp_parity.json");
  REQUIRE(fx.ok());
  auto& cases = fx.root().find_mut("cases")->arr_mut();
  REQUIRE(cases.size() >= 7);
  std::size_t frames = 0;
  for (Json& c : cases) {
    const std::string name = c.at("name").str();
    INFO(name);
    doc::Document d;
    doc::EditorView view;
    const Json& document = c.at("document");
    std::vector<Json> assets;
    if (document.at("harness").at("assets").is_array()) assets = document.at("harness").at("assets").arr();
    (void)doc::restore_document(d, view, document, assets);
    doc::ExprCache cache;
    const doc::DocExprEnv env(d, view, cache);
    const std::string compId = c.at("compId").str();
    const bool mbOn = document.at("harness").at("motionBlurOn").b();
    const double fps = document.at("harness").at("fps").num();
    for (Json& f : c.find_mut("frames")->arr_mut()) {
      const double frame = f.at("frame").num();
      INFO("frame " << frame);
      const sc::BuildContext ctx{d, view, env, cache, nullptr, {}};
      std::optional<sc::MotionBlurCfg> mb;
      if (mbOn) mb = sc::motion_blur_of(d, compId);
      const sc::Snapshot snap = sc::build_snapshot(ctx, sc::snapshot_comp_of(d, compId), frame / fps, mb);
      const sc::FrameBuild fb = sc::build_frame_scene(snap, 1);
      std::string unported;
      Json::Array errors;
      for (const sc::LayerError& e : snap.layerErrors) {
        unported += e.layerId + ": " + e.message + "; ";
        errors.push_back(Json::string(e.layerId + ": " + e.message));
      }
      for (const auto& [id, what] : fb.unported) unported += id + ": " + what + "; ";
      INFO("unported: " << unported);
      CHECK(unported.empty());
      CHECK(fx.answer(f, "errors", Json::array(std::move(errors))));
      if (fx.reblessing()) {
        // The whole projection, as projLayer / projRenderable wrote it.
        (void)fx.answer(f, "layers", proj_layers(snap.layers));
        (void)fx.answer(f, "renderables", proj_renderables(fb.scene.renderables));
      } else {
        // Compare mode keeps the path-by-path diff (numbers within 1e-9 relative).
        Cmp cmp;
        cmp_layers(cmp, "", snap.layers, f.at("layers"));
        cmp_renderables(cmp, "", fb.scene.renderables, f.at("renderables"));
        std::string first;
        for (std::size_t i = 0; i < cmp.diffs.size() && i < 12; ++i) first += cmp.diffs[i] + "\n";
        INFO(cmp.diffs.size() << " difference(s):\n" << first);
        CHECK(cmp.diffs.empty());
      }
      ++frames;
    }
  }
  CHECK(frames >= 14);
  REQUIRE(fx.finish());
}

TEST_CASE("content-aware fill: a data: URL still decodes as the footage texture", "[scene][timecomp]") {
  // A 2×1 PNG: (255,0,0,128) then (0,0,0,255), premultiplied at decode.
  sc::SceneTextures tex(sc::SceneTextures::Options{});
  sc::TextureRequest r;
  r.key = "asset:filled";
  r.kind = sc::TexKind::media;
  r.src = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR4nGP4z8DQwMDA8P8/AA7+A35TPsZnAAAAAElFTkSuQmCC";
  std::vector<api::RenderTextureRef> refs;
  sc::PrepareStats stats;
  tex.prepare({r}, refs, stats);
  REQUIRE(refs.size() == 1);
  CHECK(stats.unsupported.empty());
  REQUIRE(refs[0].ready);
  const sc::RasterEntry* e = tex.raster(refs[0].hash);
  REQUIRE(e != nullptr);
  CHECK(e->width == 2);
  CHECK(e->height == 1);
  CHECK(e->rgba == std::vector<std::uint8_t>{128, 0, 0, 128, 0, 0, 0, 255});
}

TEST_CASE("an audio waveform outline matches the TypeScript envelope geometry", "[scene]") {
  const std::vector<float> peaks{0, 1, 0, 1};
  const premation::js::Json pts = sc::waveform_points(peaks, 4, 100, 100, 0, "full", 4, 1, 0, 1);
  REQUIRE(pts.arr().size() == 8);
  CHECK(pts.arr()[0].at("x").num() == -50);
  CHECK(pts.arr()[0].at("y").num() == 0);
  CHECK(pts.arr()[1].at("y").num() == -50);
  const premation::js::Json empty = sc::waveform_points({}, 4, 100, 100, 0, "full", 4, 1, 0, 1);
  CHECK(empty.arr().empty());
}