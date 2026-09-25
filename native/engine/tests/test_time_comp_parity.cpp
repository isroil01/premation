// Cross-engine parity of the time / composition family (tests/data/
// time_comp_parity.json, written by src/core/rendering/timeCompCrossEngine.test.ts):
// composition instances (sealed recursive passes, collapsed clones, Essential
// Properties, the cycle guard), precomp and layer retime, frame blending,
// temporal ghosts, auto-orient, points bound to nulls, Continuous Rasterization
// and corner pin. Each case opens the SAME document the TypeScript exported (the
// golden harness's sceneToProject), builds the snapshot and FrameScene with the
// engine's own builder, and must reproduce the TypeScript's projection — and
// report nothing unported.
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <fstream>
#include <sstream>
#include <string>

#include "docexpr.hpp"
#include "docio.hpp"
#include "frame_build.hpp"
#include "json.hpp"
#include "model.hpp"
#include "snapshot_build.hpp"
#include "scene_textures.hpp"
#include "timeline.hpp"

using premation::js::Json;
namespace doc = premation::doc;
namespace sc = premation::scene;
namespace api = premation::api;

namespace {

Json load_fixture() {
  std::ifstream f(std::string(PREMATION_ENGINE_TEST_DATA) + "/time_comp_parity.json", std::ios::binary);
  REQUIRE(f.good());
  std::stringstream ss;
  ss << f.rdbuf();
  auto j = premation::js::parse(ss.str());
  REQUIRE(j.has_value());
  return std::move(*j);
}

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
  optArr("quad3d", l.quad3d, w.at("quad3d"));
  optArr("lighting", l.lighting, w.at("lighting"));
  const Json& sq = w.at("sampleQuads");
  if (sq.arr().size() == (l.motionSamples.size() > 1 ? l.motionSamples.size() : 0)) {
    for (std::size_t i = 0; i < sq.arr().size(); ++i) optArr("sampleQuads[" + std::to_string(i) + "]", l.motionSamples[i].quad, sq.arr()[i]);
  }
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

}  // namespace

TEST_CASE("time/comp parity: the C++ scene builder reproduces buildSnapshot + snapshotToFrameScene", "[scene][timecomp][parity]") {
  const Json fixture = load_fixture();
  const auto& cases = fixture.at("cases").arr();
  REQUIRE(cases.size() >= 7);
  std::size_t frames = 0;
  for (const Json& c : cases) {
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
    for (const Json& f : c.at("frames").arr()) {
      const double frame = f.at("frame").num();
      INFO("frame " << frame);
      const sc::BuildContext ctx{d, view, env, cache, nullptr};
      std::optional<sc::MotionBlurCfg> mb;
      if (mbOn) mb = sc::motion_blur_of(d, compId);
      const sc::Snapshot snap = sc::build_snapshot(ctx, sc::snapshot_comp_of(d, compId), frame / fps, mb);
      const sc::FrameBuild fb = sc::build_frame_scene(snap, 1);
      std::string unported;
      for (const sc::LayerError& e : snap.layerErrors) unported += e.layerId + ": " + e.message + "; ";
      for (const auto& [id, what] : fb.unported) unported += id + ": " + what + "; ";
      INFO("unported: " << unported);
      CHECK(unported.empty());
      Cmp cmp;
      cmp_layers(cmp, "", snap.layers, f.at("layers"));
      cmp_renderables(cmp, "", fb.scene.renderables, f.at("renderables"));
      std::string first;
      for (std::size_t i = 0; i < cmp.diffs.size() && i < 12; ++i) first += cmp.diffs[i] + "\n";
      INFO(cmp.diffs.size() << " difference(s):\n" << first);
      CHECK(cmp.diffs.empty());
      ++frames;
    }
  }
  CHECK(frames >= 14);
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