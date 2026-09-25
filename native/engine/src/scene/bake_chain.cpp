// The CPU bake of a layer raster (see bake_chain.hpp): the scene builder's side
// of Canvas2DVectorRasterizer's bake branch — the mask matte, the stack resolved
// (paramsOf) with its px lengths scaled to the raster (scaleEffectLengths) —
// handed to the E4 effect chain (effects/effect_chain.cpp, applyEffectChain).

#include "bake_chain.hpp"

#include <algorithm>
#include <memory>
#include <string>
#include <utility>

#include "catalog_data.hpp"
#include "effects/effect_chain.hpp"
#include "effects_port.hpp"
#include "fxstate.hpp"
#include "json.hpp"
#include "mask_paint.hpp"
#include "thread_pool.hpp"

namespace premation::scene::bake {
namespace {

namespace rj = raster::json;
using raster::Canvas2D;
using raster::Mat2D;

std::string type_of(const Json& e) { return e.at("type").is_string() ? e.at("type").str() : std::string(); }

/// The raster module's JSON for a scene value (exact: shortest-round-trip numbers).
rj::Value to_raster(const Json& v) {
  rj::Value out;
  std::string err;
  if (!rj::parse(js::stringify(v), out, err)) return rj::Value{};
  return out;
}

/// scaleEffectLengths: paramsOf(e) with every px length × k (k = the raster scale).
Json scaled_params(const Json& e, double k) {
  Json params = doc::params_of(e);
  if (k == 1 || !(k > 0)) return params;
  const doc::EffectDef* def = doc::registry().effect(type_of(e));
  if (def == nullptr) return params;
  for (const auto& p : def->params) {
    if (!(p.type == "number" || p.type == "resolved") || p.unit.value_or("") != "px") continue;
    const Json& v = params.at(p.key);
    if (v.is_number()) {
      params.set(p.key, Json::number(v.num() * k));
    } else if (p.type == "resolved" && v.is_array()) {
      Json a = Json::array();
      for (const Json& x : v.arr()) a.arr_mut().push_back(x.is_number() ? Json::number(x.num() * k) : x);
      params.set(p.key, std::move(a));
    }
  }
  return params;
}

void draw_at(Canvas2D& dst, const Canvas2D& src) {
  const auto sw = static_cast<double>(src.width());
  const auto sh = static_cast<double>(src.height());
  dst.drawImage(src, 0, 0, sw, sh, 0, 0, sw, sh);
}

}  // namespace

void bake_layer_raster(Canvas2D& ctx, const Json& spec, double bw, double bh, double ss, std::vector<std::string>& unsupported,
                       SharedPool pool) {
  const Json& mask = spec.at("mask");
  const bool masked = mask.is_object() && mask.at("paths").is_array() && !mask.at("paths").arr().empty();
  const rj::Value rmask = masked ? to_raster(mask) : rj::Value{};
  if (masked) {
    // The layer mask as a destination-in matte, centred on the PADDED box.
    const auto matte = ctx.create_canvas(ctx.width(), ctx.height());
    Mat2D t;
    t.e = bw / 2;
    t.f = bh / 2;
    matte->setTransform(t);
    const double lw = spec.at("width").is_number() ? spec.at("width").num() : std::nan("");
    const double lh = spec.at("height").is_number() ? spec.at("height").num() : std::nan("");
    raster::paint_mask_matte(*matte, rmask, lw, lh, unsupported);
    ctx.setTransform(Mat2D{});
    (void)ctx.setGlobalCompositeOperation("destination-in");
    draw_at(ctx, *matte);
    (void)ctx.setGlobalCompositeOperation("source-over");
  }
  ctx.setTransform(Mat2D{});
  // The stack as the chain takes it: {type, enabled?, params (resolved, scaled), opacity?, maskId?}.
  Json stack = Json::array();
  if (spec.at("effects").is_array()) {
    for (const Json& e : spec.at("effects").arr()) {
      Json o = Json::object();
      o.set("type", Json::string(type_of(e)));
      if (!e.at("enabled").is_undefined()) o.set("enabled", e.at("enabled"));
      if (!e.at("opacity").is_undefined()) o.set("opacity", e.at("opacity"));
      if (!e.at("maskId").is_undefined()) o.set("maskId", e.at("maskId"));
      o.set("params", scaled_params(e, ss));
      stack.arr_mut().push_back(std::move(o));
    }
  }
  const Json& fo = spec.at("fillOpacity");
  const double fillOpacity = fo.is_number() ? fo.num() : 1;
  // One bake at a time uses the shared kernel pool; the others run inline (same bytes).
  effects::ThreadPool* threads = nullptr;
  std::unique_lock<std::mutex> lock;
  if (pool.pool != nullptr && pool.m != nullptr) {
    lock = std::unique_lock<std::mutex>(*pool.m, std::try_to_lock);
    if (lock.owns_lock()) threads = pool.pool;
  }
  effects::ChainReport report;
  effects::apply_effect_chain(ctx, static_cast<int>(ctx.width()), static_cast<int>(ctx.height()), to_raster(stack), fillOpacity,
                              masked ? &rmask : nullptr, threads, report);
  for (std::string& u : report.unported) unsupported.push_back("effect chain: " + std::move(u));
  for (std::string& u : report.unsupported) unsupported.push_back(std::move(u));
}

double baked_effect_spread(const RLayer& l) {
  if (!layer_is_baked(l)) return 0;
  if (l.effects.empty()) return 0;
  constexpr double kBlurExtent = 3;
  constexpr double kMaxEffectPad = 256;
  double spread = 0;
  for (const Json& e : l.effects) {
    if (!effect_enabled(e)) continue;
    const std::string t = type_of(e);
    const auto n = [&e](const char* k) { return effect_number(e, k); };
    double s = 0;
    if (t == "blur") s = n("amount") * kBlurExtent;
    else if (t == "glow" || t == "deep-glow") s = n("radius") * kBlurExtent;
    else if (t == "beam-path") s = n("coreWidth") * std::max(n("startSize"), n("endSize")) / 100 + n("glowSpread") * 10 + n("distortion");
    else if (t == "drop-shadow") s = n("distance") + n("softness") * kBlurExtent;
    else if (t == "stroke" || t == "vegas") s = n("width");
    else if (t == "path-stroke") s = n("brushSize") / 2 + 1;
    else if (t == "scribble") s = n("edgeWidth") + n("strokeWidth") + 2 * n("spacing");
    else if (t == "write-on") s = n("writeOnMode") == 0 ? n("brushSize") / 2 + 1 : 0;
    // A JS plugin effect's declared reach (pluginEffectSpreadPx) is outside the
    // port (G2); the snapshot reports the effect.
    if (s > spread) spread = s;
  }
  return std::min(spread, kMaxEffectPad);
}

}  // namespace premation::scene::bake
