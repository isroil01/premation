#include "scene_textures.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cstring>
#include <span>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <thread>

#include "core/joining_thread.hpp"
#include "bake_chain.hpp"
#include "contour_texture.hpp"
#include "image_decode.hpp"
#include "json.hpp"
#include "pixel_motion.hpp"
#include "light_wash.hpp"
#include "native_effects.hpp"
#include "particle_port.hpp"
#include "raster_source.hpp"
#include "svg_layer.hpp"
#include "thread_pool.hpp"

#if defined(PREMATION_HAVE_MEDIA)
#include "media_system.hpp"
#include "media_textures.hpp"
#include "time_map.hpp"
#include "yuv.hpp"
#endif

namespace premation::scene {
namespace {

std::uint64_t fnv1a(std::string_view s, std::uint64_t h = 0xcbf29ce484222325ULL) {
  for (const char c : s) {
    h ^= static_cast<std::uint8_t>(c);
    h *= 0x100000001b3ULL;
  }
  return h;
}

std::string hex64(std::uint64_t v) {
  std::array<char, 17> b{};
  std::snprintf(b.data(), b.size(), "%016llx", static_cast<unsigned long long>(v));  // NOLINT(cppcoreguidelines-pro-type-vararg)
  return {b.data(), 16};
}

raster::RasterKind raster_kind(TexKind k) {
  switch (k) {
    case TexKind::text: return raster::RasterKind::text;
    case TexKind::mask: return raster::RasterKind::mask;
    default: return raster::RasterKind::path;
  }
}

}  // namespace

/// `file:///C:/x%20y.mp4` → `C:/x y.mp4`; the desktop app's `local-file://C:/…`,
/// `local-file://C/…` and `local-file:///C:/…` (electron/localFileUrl.ts) likewise;
/// anything else unchanged.
std::string file_url_path(std::string_view src) {
  std::string_view rest;
  if (src.starts_with("file://")) {
    rest = src.substr(7);
  } else if (src.starts_with("local-file://")) {
    rest = src.substr(13);
    // local-file://C/Users/… — Chromium parsed the drive's colon as an empty port.
    if (rest.size() >= 2 && std::isalpha(static_cast<unsigned char>(rest[0])) != 0 && rest[1] == '/') {
      std::string fixed;
      fixed.push_back(rest[0]);
      fixed.push_back(':');
      fixed.append(rest.substr(1));
      return file_url_path("file:///" + fixed);
    }
  } else {
    return std::string(src);
  }
  const std::size_t q = rest.find_first_of("?#");
  if (q != std::string_view::npos) rest = rest.substr(0, q);
  if (rest.starts_with('/') && rest.size() > 2 && rest[2] == ':') rest.remove_prefix(1);  // /C:/…
  std::string out;
  for (std::size_t i = 0; i < rest.size(); ++i) {
    if (rest[i] == '%' && i + 2 < rest.size()) {
      const auto hexv = [](char c) {
        return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
      };
      const int hi = hexv(rest[i + 1]);
      const int lo = hexv(rest[i + 2]);
      if (hi >= 0 && lo >= 0) {
        out.push_back(static_cast<char>(hi * 16 + lo));
        i += 2;
        continue;
      }
    }
    out.push_back(rest[i]);
  }
  return out;
}

SceneTextures::SceneTextures(Options opts)
    : opts_(std::move(opts)),
      bakePool_(std::make_unique<effects::ThreadPool>(std::min(8U, std::max(1U, std::thread::hardware_concurrency())))) {}
SceneTextures::~SceneTextures() = default;

void SceneTextures::set_media(media::MediaSystem* system, media::MediaTextures* frames) noexcept {
  media_ = system;
  mediaFrames_ = frames;
}

std::shared_ptr<const RasterEntry> SceneTextures::find(std::string_view hash) {
  const std::scoped_lock lock(m_);
  const auto it = byHash_.find(hash);
  if (it == byHash_.end()) return nullptr;
  lru_.splice(lru_.begin(), lru_, it->second);
  return it->second->entry;
}

const RasterEntry* SceneTextures::raster(std::string_view hash) const {
  const std::scoped_lock lock(m_);
  const auto it = byHash_.find(hash);
  return it == byHash_.end() ? nullptr : it->second->entry.get();
}

void SceneTextures::insert(std::string hash, std::shared_ptr<const RasterEntry> e) {
  const std::scoped_lock lock(m_);
  if (byHash_.contains(hash)) return;
  bytes_ += e->rgba.size();
  lru_.push_front(Slot{hash, std::move(e)});
  byHash_.emplace(std::move(hash), lru_.begin());
  while (bytes_ > opts_.rasterCacheBytes && lru_.size() > 1) {
    Slot& back = lru_.back();
    bytes_ -= back.entry->rgba.size();
    byHash_.erase(back.hash);
    lru_.pop_back();
  }
}

void SceneTextures::clear() {
  const std::scoped_lock lock(m_);
  lru_.clear();
  byHash_.clear();
  bytes_ = 0;
  contentLru_.clear();
  contentByKey_.clear();
  contentBytes_ = 0;
}

std::shared_ptr<const raster::BakedContent> SceneTextures::find_content(std::uint64_t key) {
  const std::scoped_lock lock(m_);
  const auto it = contentByKey_.find(key);
  if (it == contentByKey_.end()) return nullptr;
  contentLru_.splice(contentLru_.begin(), contentLru_, it->second);
  return it->second->content;
}

void SceneTextures::insert_content(std::uint64_t key, std::shared_ptr<const raster::BakedContent> c) {
  if (c == nullptr || c->canvas == nullptr) return;
  const std::size_t bytes = static_cast<std::size_t>(c->canvas->width()) * c->canvas->height() * 4;
  const std::scoped_lock lock(m_);
  if (bytes > opts_.contentCacheBytes || contentByKey_.contains(key)) return;
  contentBytes_ += bytes;
  contentLru_.push_front(ContentSlot{key, std::move(c), bytes});
  contentByKey_.emplace(key, contentLru_.begin());
  while (contentBytes_ > opts_.contentCacheBytes && contentLru_.size() > 1) {
    contentBytes_ -= contentLru_.back().bytes;
    contentByKey_.erase(contentLru_.back().key);
    contentLru_.pop_back();
  }
}

void SceneTextures::prepare(const std::vector<TextureRequest>& reqs, std::vector<api::RenderTextureRef>& refs,
                            PrepareStats& stats) {
  struct Miss {
    const TextureRequest* req;
    std::string hash;
    std::string spec;
    std::uint64_t contentKey = 0;  // a baked raster's content key (0 = not baked)
  };
  std::vector<Miss> misses;
  std::vector<std::string> seen;
  // E4: GPU Vegas contours read another raster of this frame — resolved last.
  std::vector<std::pair<const TextureRequest*, std::size_t>> contourReqs;
  refs.reserve(refs.size() + reqs.size());
  for (const TextureRequest& r : reqs) {
    api::RenderTextureRef ref;
    ref.key = r.key;
    if (r.kind == TexKind::contours) {
      contourReqs.emplace_back(&r, refs.size());
      refs.push_back(std::move(ref));  // hash filled by resolve_contours
      continue;
    }
    if (r.kind == TexKind::media) {
      std::optional<api::RenderColorSpace> space;
      ref.hash = media_ref(r, stats, space);
      ref.ready = !ref.hash.empty();
      if (colorManaged_ && ref.ready) ref.input_space = space;
      refs.push_back(std::move(ref));
      continue;
    }
    if (r.kind == TexKind::pixels) {
      // A builder-computed texture (colour-LUT strip): data, not colour, so no
      // inputSpace; keyed by its bytes like a raster.
      std::array<char, 32> dims{};
      std::snprintf(dims.data(), dims.size(), "|px|%u|%u", r.pxWidth, r.pxHeight);  // NOLINT(cppcoreguidelines-pro-type-vararg)
      const std::string_view bytes(reinterpret_cast<const char*>(r.pixels.data()), r.pixels.size());  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
      ref.hash = "rs:" + hex64(fnv1a(dims.data(), fnv1a(bytes)));
      ref.ready = r.pxWidth > 0 && r.pxHeight > 0 && r.pixels.size() == static_cast<std::size_t>(r.pxWidth) * r.pxHeight * 4;
      if (ref.ready && !find(ref.hash)) {
        auto e = std::make_shared<RasterEntry>();
        e->width = r.pxWidth;
        e->height = r.pxHeight;
        e->rgba = r.pixels;
        insert(ref.hash, std::move(e));
      }
      refs.push_back(std::move(ref));
      continue;
    }
    std::string spec = js::stringify(r.spec);
    std::array<char, 64> tail{};
    std::snprintf(tail.data(), tail.size(), "|%d|%.17g|%.17g", static_cast<int>(r.kind), r.resolutionScale, r.padding);  // NOLINT(cppcoreguidelines-pro-type-vararg)
    // Keyed by CONTENT, as the TS keys a path raster by contentHash × tier ×
    // padding: the placement fields the painters never read (position,
    // rotation, scale, depth, opacity, blend) stay out of the key, so a layer
    // that only moves keeps its raster.
    std::uint64_t h = 0;
    std::uint64_t contentKey = 0;
    if ((r.kind == TexKind::path || r.kind == TexKind::text) && r.spec.is_object() && r.spec.at("__baked").b() &&
        opts_.contentCacheBytes > 0) {
      // What the painters read: the drawable without what only the bake reads
      // (effects, fillOpacity, mask — bake_chain.cpp) and without placement.
      js::Json keyed = r.spec;
      for (const char* k : {"x", "y", "rotation", "scaleX", "scaleY", "depth", "opacity", "blend", "sourceTime", "effects",
                            "fillOpacity", "mask"}) {
        keyed.erase(k);
      }
      contentKey = fnv1a(tail.data(), fnv1a(js::stringify(keyed), fnv1a("baked-content")));
      if (contentKey == 0) contentKey = 1;
    }
    if ((r.kind == TexKind::path || r.kind == TexKind::mask) && r.spec.is_object()) {
      js::Json keyed = r.spec;
      // sourceTime too, baked or not (contentHash.ts keys it for media layers
      // only): the painters never read it, and a baked chain sees time only
      // through its resolved params (resolve_effect_params puts the layer time
      // into timecode / strobe-light / particle-systems), which ARE keyed — so a
      // baked layer whose stack does not animate keeps its bake across frames.
      for (const char* k : {"x", "y", "rotation", "scaleX", "scaleY", "depth", "opacity", "blend", "sourceTime"}) keyed.erase(k);
      h = fnv1a(tail.data(), fnv1a(js::stringify(keyed)));
    } else if (r.kind == TexKind::text && r.spec.is_object()) {
      // The layer scale picks the tier (in `tail`); the text painters never read it.
      js::Json keyed = r.spec;
      keyed.erase("scaleX");
      keyed.erase("scaleY");
      h = fnv1a(tail.data(), fnv1a(js::stringify(keyed)));
    } else {
      h = fnv1a(tail.data(), fnv1a(spec));
    }
    ref.hash = "rs:" + hex64(h);
    ref.ready = true;
    // Authored text / shape colours are sRGB; a mask raster is coverage (data).
    if (colorManaged_ && r.kind != TexKind::mask) ref.input_space = api::RenderColorSpace::srgb;
    if (find(ref.hash)) {
      ++stats.rasterHits;
    } else if (std::ranges::find(seen, ref.hash) == seen.end()) {
      seen.push_back(ref.hash);
      misses.push_back({&r, ref.hash, std::move(spec), contentKey});
    }
    refs.push_back(std::move(ref));
  }
  if (misses.empty()) {
    resolve_contours(contourReqs, refs, stats);
    return;
  }
  stats.rasterMisses += static_cast<std::uint32_t>(misses.size());
  const auto t0 = std::chrono::steady_clock::now();
  std::vector<std::shared_ptr<RasterEntry>> done(misses.size());
  std::vector<std::array<double, 3>> timing(misses.size());
  const auto work = [&](std::size_t i) {
    const Miss& m = misses[i];
    auto e = std::make_shared<RasterEntry>();
    // A baked layer's chain runs on the raster canvas (bake_chain.cpp, E4 wiring).
    const Json& drawable = m.req->spec;
    const raster::BakeHook bake = [this, &drawable](raster::Canvas2D& ctx, double bw, double bh, double ss,
                                                   std::vector<std::string>& unsupported) {
      bake::bake_layer_raster(ctx, drawable, bw, bh, ss, unsupported, bake::SharedPool{bakePool_.get(), &bakePoolM_});
    };
    raster::ContentReuse reuse;
    std::shared_ptr<const raster::BakedContent> cached;
    if (m.contentKey != 0) {
      cached = find_content(m.contentKey);
      reuse.cached = cached.get();
    }
    raster::RasterOutput out =
        m.req->kind == TexKind::light  // a light's glow wash (light_wash.cpp)
            ? draw_light_wash(light_wash_of_spec(m.req->spec), opts_.canvas)
        : m.req->kind == TexKind::particles  // a particle emitter's field (particle_port.cpp)
            ? draw_particle_field(m.req->spec, opts_.canvas, opts_.mediaBase)
            : raster::draw_raster_source(raster_kind(m.req->kind), m.spec, m.req->resolutionScale, m.req->padding, opts_.canvas,
                                         &bake, m.contentKey != 0 ? &reuse : nullptr);
    if (reuse.painted) insert_content(m.contentKey, std::move(reuse.painted));
    e->width = out.width;
    e->height = out.height;
    e->rgba = std::move(out.rgba);
    e->unsupported = std::move(out.unsupported);
    if (!out.ok) e->error = out.error.empty() ? "raster failed" : out.error;
    timing[i] = {out.contentMs, out.bakeMs, out.readMs};
    done[i] = std::move(e);
  };
  unsigned threads = opts_.threads != 0 ? opts_.threads : std::min(8U, std::max(1U, std::thread::hardware_concurrency()));
  threads = std::min<unsigned>(threads, static_cast<unsigned>(misses.size()));
  if (threads <= 1) {
    for (std::size_t i = 0; i < misses.size(); ++i) work(i);
  } else {
    std::atomic<std::size_t> next{0};
    std::vector<JoiningThread> pool;
    pool.reserve(threads);
    for (unsigned t = 0; t < threads; ++t) {
      pool.emplace_back([&] {
        for (std::size_t i = next.fetch_add(1); i < misses.size(); i = next.fetch_add(1)) work(i);
      });
    }
  }
  stats.rasterMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  for (std::size_t i = 0; i < misses.size(); ++i) {
    stats.contentMs += timing[i][0];
    stats.bakeMs += timing[i][1];
    stats.readMs += timing[i][2];
    for (const std::string& u : done[i]->unsupported) stats.unsupported.emplace_back(misses[i].req->key, u);
    if (!done[i]->error.empty()) stats.unsupported.emplace_back(misses[i].req->key, "raster error: " + done[i]->error);
    insert(misses[i].hash, std::move(done[i]));
  }
  resolve_contours(contourReqs, refs, stats);
}

void SceneTextures::resolve_contours(std::span<const std::pair<const TextureRequest*, std::size_t>> reqs,
                                     std::vector<api::RenderTextureRef>& refs, PrepareStats& stats) {
  for (const auto& [req, at] : reqs) {
    const Json& spec = req->spec;
    const std::string source = spec.at("source").is_string() ? spec.at("source").str() : std::string();
    const auto src = std::ranges::find_if(refs, [&](const api::RenderTextureRef& r) { return r.key == source; });
    api::RenderTextureRef& ref = refs[at];
    ref.ready = false;
    if (src == refs.end() || src->hash.empty()) continue;
    const std::shared_ptr<const RasterEntry> raster = find(src->hash);
    if (raster == nullptr || raster->width == 0 || raster->height == 0) continue;
    const double threshold = spec.at("threshold").is_number() ? spec.at("threshold").num() : 128;
    std::array<char, 48> tail{};
    std::snprintf(tail.data(), tail.size(), "|contours|%.17g", threshold);  // NOLINT(cppcoreguidelines-pro-type-vararg)
    // Keyed by the content raster and the threshold: the contours are made
    // once per content, whatever the Vegas params do (E4 cached silhouettes).
    ref.hash = "rs:" + hex64(fnv1a(tail.data(), fnv1a(src->hash)));
    ref.ready = true;
    if (find(ref.hash)) {
      ++stats.rasterHits;
      continue;
    }
    const auto t0 = std::chrono::steady_clock::now();
    const double lw = spec.at("width").is_number() ? spec.at("width").num() : 0;
    const double pad = spec.at("padding").is_number() ? spec.at("padding").num() : 0;
    const double ss = lw + 2 * pad > 0 ? static_cast<double>(raster->width) / (lw + 2 * pad) : 1;
    effects::ContourTexture ct = effects::pack_alpha_contours(raster->rgba, raster->width, raster->height, threshold, ss);
    auto e = std::make_shared<RasterEntry>();
    e->width = ct.width;
    e->height = std::max<std::uint32_t>(1, ct.height);
    e->rgba = std::move(ct.rgba);
    e->rgba.resize(static_cast<std::size_t>(e->width) * e->height * 4, 0);
    insert(ref.hash, std::move(e));
    ++stats.rasterMisses;
    ++stats.contourBuilds;
    stats.rasterMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  }
}

rg::TexRef SceneTextures::external_texture(std::string_view hash) {
  if (hash.starts_with("rs:") || hash.starts_with("img:")) {
    if (dev_ == nullptr) return {};
    const std::shared_ptr<const RasterEntry> e = find(hash);
    // A pooled texture hits by hash and ignores the pixels; on a miss the
    // pixels upload once (an evicted raster that is not re-prepared draws nothing).
    if (!e) return {};
    return dev_->texture(hash, e->width, e->height, wgpu::TextureFormat::RGBA8Unorm, std::span<const std::uint8_t>(e->rgba),
                         false);
  }
#if defined(PREMATION_HAVE_MEDIA)
  if (mediaFrames_ != nullptr) return mediaFrames_->external_texture(hash);
#endif
  return {};
}

std::string SceneTextures::image_ref(const TextureRequest& r, const std::filesystem::path& p, PrepareStats& stats) {
  // Still footage: the file's RGBA8 (image_decode.hpp), cached with the rasters
  // by path + size + last write (a re-saved file decodes again).
  const FileStamp st = file_stamp(p);
  std::array<char, 64> tail{};
  std::snprintf(tail.data(), tail.size(), "|%llu|%llu|%d", static_cast<unsigned long long>(st.size),  // NOLINT(cppcoreguidelines-pro-type-vararg)
                static_cast<unsigned long long>(st.modified), r.premultiplied ? 1 : 0);
  const std::string key = p.lexically_normal().string();
  std::string hash = "img:" + hex64(fnv1a(tail.data(), fnv1a(key)));
  if (const auto oe = openErrors_.find(hash); oe != openErrors_.end()) {
    stats.unsupported.emplace_back(r.key, "image did not decode: " + oe->second);
    return {};
  }
  if (find(hash)) return hash;
  const auto t0 = std::chrono::steady_clock::now();
  DecodedImage img;
  std::string error;
  if (!decode_image_file(p, img, error)) {
    openErrors_.emplace(hash, error);
    stats.unsupported.emplace_back(r.key, "image did not decode: " + error);
    return {};
  }
  if (!r.premultiplied) {
    // Straight-alpha footage is premultiplied at decode, as the browser's image
    // decode does for the TS engine (Skia's SkMulDiv255Round); a source marked
    // premultiplied keeps its channels as stored.
    for (std::size_t i = 0; i + 3 < img.rgba.size(); i += 4) {
      const unsigned a = img.rgba[i + 3];
      for (std::size_t c = 0; c < 3; ++c) {
        const unsigned prod = (img.rgba[i + c] * a) + 128U;
        img.rgba[i + c] = static_cast<std::uint8_t>((prod + (prod >> 8U)) >> 8U);
      }
    }
  }
  auto e = std::make_shared<RasterEntry>();
  e->width = img.width;
  e->height = img.height;
  e->rgba = std::move(img.rgba);
  insert(hash, std::move(e));
  ++stats.rasterMisses;
  stats.rasterMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  return hash;
}

std::string SceneTextures::media_ref(const TextureRequest& r, PrepareStats& stats,
                                     std::optional<api::RenderColorSpace>& space) {
  // Still footage decodes to sRGB-encoded RGBA8 (PNG / JPEG / WebP without a profile).
  space = api::RenderColorSpace::srgb;
  if (r.src.empty()) return {};
  // A still's CPU-baked effect chain runs on its decoded bitmap (setImage's bake).
  const auto baked_still = [&](std::string hash) {
    if (!r.bake || r.video || hash.empty()) return hash;
    return footage_bake_ref(r, hash, stats);
  };
  // SVG footage and SVG layers: AppTextureProvider.rasterizeSvg, on the C++ SVG renderer (svg_layer.cpp).
  if (is_svg_src(r.src)) return baked_still(svg_ref(r, stats));
  // An imported model's images (gltf_model.hpp): decoded out of the model file.
  if (r.src.starts_with("gltf:")) return model_ref(r, stats);
  if (r.src.starts_with("data:image/") && !r.video) return baked_still(data_image_ref(r, stats));
  if (r.src.starts_with("data:") || r.src.starts_with("blob:") || r.src.starts_with("http:") ||
      r.src.starts_with("https:")) {
    stats.unsupported.emplace_back(r.key, "footage that is not a file on disk");
    return {};
  }
  std::filesystem::path p = file_url_path(r.src);
  if (p.is_relative() && !opts_.mediaBase.empty()) p = opts_.mediaBase / p;
  if (is_still_image_path(p)) return baked_still(image_ref(r, p, stats));
#if defined(PREMATION_HAVE_MEDIA)
  if (media_ == nullptr) return {};
  const std::string key = p.lexically_normal().string();
  std::uint32_t id = 0;
  if (const auto it = sources_.find(key); it != sources_.end()) {
    id = it->second;
  } else {
    if (const auto oe = openErrors_.find(key); oe != openErrors_.end()) {
      stats.unsupported.emplace_back(r.key, "footage did not open: " + oe->second);
      return {};
    }
    std::string error;
    const auto sid = media_->open(key, error);
    if (!sid) {
      openErrors_.emplace(key, error);
      stats.unsupported.emplace_back(r.key, "footage did not open: " + error);
      return {};
    }
    id = *sid;
    sources_.emplace(key, id);
  }
  if (mediaFrames_ != nullptr) {
    mediaFrames_->set_alpha(id, r.premultiplied ? media::AlphaMode::premultiplied : media::AlphaMode::straight);
  }
  const auto index = media_->index(id);
  media::MediaInfo info;
  const bool haveInfo = media_->info(id, info);
  if (!index) {
    if (!haveInfo || !info.video) stats.unsupported.emplace_back(r.key, "footage has no decodable video stream");
    return {};
  }
  const double probeFps = info.video ? info.video->fps.value() : 0;
  // Interpret Footage ▸ Color = what the file states (H.273 primaries / transfer).
  if (haveInfo && info.video) {
    const media::InputSpaceGuess g = media::input_space_of(info.video->color);
    space = static_cast<api::RenderColorSpace>(g.renderColorSpace);
    if (g.hdrUnmodelled && colorManaged_) {
      stats.unsupported.emplace_back(r.key, "HDR (PQ / HLG) footage under colour management: no RenderColorSpace for the curve");
    }
  }
  media::FootageInterpretation interp;
  interp.pulldownPhase = r.pulldownPhase;  // Remove Pulldown: plan_frames weaves the film frame back
  const media::FramePlan plan =
      media::plan_frames(*index, r.sourceTime, interp, media::FrameBlend::none, probeFps, r.compFps);
  ++stats.mediaRefs;
  // Playback: the source's worker decodes ahead of the playhead (MediaSystem::playhead).
  if (playing_) media_->playhead(id, plan.a.index, 1);
  if (r.bake) return video_bake_ref(r, id, plan.a, stats);
  if (r.pixelMotion) {
    const media::FramePlan second =
        media::plan_frames(*index, r.blendTime, interp, media::FrameBlend::none, probeFps, r.compFps);
    return pixel_motion_ref(r, id, plan.a, second.a, stats);
  }
  return media::media_hash(id, plan.a.index, plan.a.bottom, r.fields);
#else
  stats.unsupported.emplace_back(r.key, "footage (built without E1 media)");
  return {};
#endif
}

#if defined(PREMATION_HAVE_MEDIA)
namespace {

float half_bits_to_float(std::uint16_t h) noexcept {
  const std::uint32_t sign = (h & 0x8000U) << 16U;
  const std::uint32_t exp = (h >> 10U) & 0x1FU;
  std::uint32_t mant = h & 0x3FFU;
  std::uint32_t bits = 0;
  if (exp == 0) {
    if (mant == 0) {
      bits = sign;
    } else {  // subnormal: normalise
      int e = -1;
      do {
        ++e;
        mant <<= 1U;
      } while ((mant & 0x400U) == 0);
      bits = sign | (static_cast<std::uint32_t>(127 - 15 - e) << 23U) | ((mant & 0x3FFU) << 13U);
    }
  } else if (exp == 31) {
    bits = sign | 0x7F800000U | (mant << 13U);
  } else {
    bits = sign | ((exp + (127 - 15)) << 23U) | (mant << 13U);
  }
  return std::bit_cast<float>(bits);
}

/// Pixel Motion's flow raster: the frame box-averaged down to fw × fh
/// (pixelMotion.ts draws it through a canvas at FLOW_MAX_DIM).
std::vector<std::uint8_t> box_downscale(const std::vector<std::uint8_t>& rgba, int w, int h, int fw, int fh) {
  std::vector<std::uint8_t> out(static_cast<std::size_t>(fw) * static_cast<std::size_t>(fh) * 4);
  for (int y = 0; y < fh; ++y) {
    const int y0 = y * h / fh;
    const int y1 = std::max(y0 + 1, (y + 1) * h / fh);
    for (int x = 0; x < fw; ++x) {
      const int x0 = x * w / fw;
      const int x1 = std::max(x0 + 1, (x + 1) * w / fw);
      std::array<std::uint32_t, 4> sum{};
      for (int yy = y0; yy < y1; ++yy) {
        for (int xx = x0; xx < x1; ++xx) {
          const std::size_t i = (static_cast<std::size_t>(yy) * static_cast<std::size_t>(w) + static_cast<std::size_t>(xx)) * 4;
          for (std::size_t c = 0; c < 4; ++c) sum.at(c) += rgba[i + c];
        }
      }
      const auto n = static_cast<std::uint32_t>((y1 - y0) * (x1 - x0));
      const std::size_t o = (static_cast<std::size_t>(y) * static_cast<std::size_t>(fw) + static_cast<std::size_t>(x)) * 4;
      for (std::size_t c = 0; c < 4; ++c) out[o + c] = static_cast<std::uint8_t>((sum.at(c) + n / 2) / n);
    }
  }
  return out;
}

}  // namespace

bool SceneTextures::read_frame_rgba8(const media::ConvertedFrame& f, std::vector<std::uint8_t>& rgba, std::string& error) {
  if (dev_ == nullptr || f.texture == nullptr) {
    error = "no device";
    return false;
  }
  const wgpu::TextureFormat format = f.texture.GetFormat();
  std::uint32_t bpp = 0;
  if (format == wgpu::TextureFormat::RGBA16Float) bpp = 8;
  else if (format == wgpu::TextureFormat::RGBA8Unorm) bpp = 4;
  else if (format == wgpu::TextureFormat::RGBA32Float) bpp = 16;
  if (bpp == 0) {
    error = "unexpected converted-frame format";
    return false;
  }
  const std::uint32_t rowBytes = f.width * bpp;
  const std::uint32_t bytesPerRow = (rowBytes + 255) / 256 * 256;
  wgpu::BufferDescriptor bd{};
  bd.size = std::uint64_t{bytesPerRow} * f.height;
  bd.usage = wgpu::BufferUsage::CopyDst | wgpu::BufferUsage::MapRead;
  const wgpu::Buffer staging = dev_->device().CreateBuffer(&bd);
  wgpu::CommandEncoder enc = dev_->device().CreateCommandEncoder();
  wgpu::TexelCopyTextureInfo src{};
  src.texture = f.texture;
  wgpu::TexelCopyBufferInfo dst{};
  dst.buffer = staging;
  dst.layout.bytesPerRow = bytesPerRow;
  dst.layout.rowsPerImage = f.height;
  const wgpu::Extent3D size{f.width, f.height, 1};
  enc.CopyTextureToBuffer(&src, &dst, &size);
  const wgpu::CommandBuffer cb = enc.Finish();
  dev_->queue().Submit(1, &cb);
  bool mapped = false;
  dev_->instance().WaitAny(staging.MapAsync(wgpu::MapMode::Read, 0, staging.GetSize(), wgpu::CallbackMode::WaitAnyOnly,
                                            [&mapped](wgpu::MapAsyncStatus st, wgpu::StringView) {
                                              mapped = st == wgpu::MapAsyncStatus::Success;
                                            }),
                           UINT64_MAX);
  if (!mapped) {
    error = "frame readback failed";
    return false;
  }
  const auto* bytes = static_cast<const std::uint8_t*>(staging.GetConstMappedRange(0, staging.GetSize()));
  const std::span<const std::uint8_t> all(bytes, staging.GetSize());
  rgba.resize(std::size_t{f.width} * f.height * 4);
  const auto to8 = [](float v) {
    // The canvas bytes pixelMotion.ts reads: round-to-nearest, clamped.
    return pixmo::to_uint8_clamp(static_cast<double>(v) * 255.0);
  };
  for (std::uint32_t y = 0; y < f.height; ++y) {
    const auto row = all.subspan(std::size_t{y} * bytesPerRow, rowBytes);
    std::uint8_t* out = rgba.data() + std::size_t{y} * f.width * 4;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    for (std::uint32_t i = 0; i < f.width * 4; ++i) {
      if (bpp == 4) {
        out[i] = row[i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      } else if (bpp == 8) {
        std::uint16_t hv = 0;
        std::memcpy(&hv, row.subspan(std::size_t{i} * 2, 2).data(), 2);
        out[i] = to8(half_bits_to_float(hv));  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      } else {
        float fv = 0;
        std::memcpy(&fv, row.subspan(std::size_t{i} * 4, 4).data(), 4);
        out[i] = to8(fv);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      }
    }
  }
  staging.Unmap();
  return true;
}

std::string SceneTextures::video_bake_ref(const TextureRequest& r, std::uint32_t id, const media::FramePick& pick,
                                          PrepareStats& stats) {
  // setVideoBaked: the decoded frame (fields rebuilt), the mask and the chain,
  // at the size it will be shown. While the exact frame is still decoding the
  // stand-in frame is baked under its own key (the TS's `:seeking` signature),
  // so the settled frame bakes again.
  const std::string plain = media::media_hash(id, pick.index, std::nullopt, 0);
  if (dev_ == nullptr || mediaFrames_ == nullptr) return media::media_hash(id, pick.index, std::nullopt, r.fields);
  media::ConvertedFrame f;
  bool exact = false;
  std::string error;
  if (!mediaFrames_->convert_frame(id, pick.index, f, exact, error)) return media::media_hash(id, pick.index, std::nullopt, r.fields);
  std::shared_ptr<RasterEntry> frame = std::make_shared<RasterEntry>();
  frame->width = f.width;
  frame->height = f.height;
  const bool read = read_frame_rgba8(f, frame->rgba, error);
  mediaFrames_->recycle(std::move(f));
  if (!read) {
    stats.unsupported.emplace_back(r.key, "baked footage: " + error);
    return media::media_hash(id, pick.index, std::nullopt, r.fields);
  }
  return footage_bake_ref(r, exact ? plain : plain + "~near", stats, frame);
}

std::string SceneTextures::pixel_motion_ref(const TextureRequest& r, std::uint32_t id, const media::FramePick& a,
                                            const media::FramePick& b, PrepareStats& stats) {
  const double t = std::clamp(r.blendWeight, 0.0, 1.0);
  // The nearer bracket frame: what draws while either frame is still decoding
  // (MotionRendererBackend.feedPixelMotion — nearest, never a half-warped guess),
  // for a pair that is one frame, and for woven (pulldown) frames.
  const media::FramePick& near = t < 0.5 ? a : b;
  const std::string nearest = media::media_hash(id, near.index, near.bottom, r.fields);
  if (a.index == b.index || a.bottom || b.bottom || dev_ == nullptr || mediaFrames_ == nullptr) return nearest;
  std::array<char, 96> sig{};
  std::snprintf(sig.data(), sig.size(), "img:pm:%u:%lld:%lld:%.4f:%c", id, static_cast<long long>(a.index),  // NOLINT(cppcoreguidelines-pro-type-vararg)
                static_cast<long long>(b.index), t, r.fields != 0 ? r.fields : '-');
  std::string hash(sig.data());
  if (find(hash)) return hash;

  media::ConvertedFrame fa;
  media::ConvertedFrame fb;
  bool exactA = false;
  bool exactB = false;
  std::string error;
  const bool okA = mediaFrames_->convert_frame(id, a.index, fa, exactA, error);
  const bool okB = okA && mediaFrames_->convert_frame(id, b.index, fb, exactB, error);
  std::vector<std::uint8_t> pa;
  std::vector<std::uint8_t> pb;
  bool ok = okA && okB && exactA && exactB && fa.width == fb.width && fa.height == fb.height && fa.width >= 8 && fa.height >= 8;
  if (ok) ok = read_frame_rgba8(fa, pa, error) && read_frame_rgba8(fb, pb, error);
  const int w = static_cast<int>(fa.width);
  const int h = static_cast<int>(fa.height);
  if (fa.texture != nullptr) mediaFrames_->recycle(std::move(fa));
  if (fb.texture != nullptr) mediaFrames_->recycle(std::move(fb));
  if (!ok) {
    if (!error.empty() && okA && okB) stats.unsupported.emplace_back(r.key, "Pixel Motion: " + error);
    return nearest;
  }

  // The flow is a function of the frame PAIR (every comp frame inside the
  // bracket reuses it), estimated at ≤ 384 px; the warp runs per weight at
  // full resolution (pixelMotion.ts). Render thread only, like the feed.
  const std::string pairKey = std::to_string(id) + "|" + std::to_string(a.index) + "|" + std::to_string(b.index);
  auto flowIt = std::ranges::find(flows_, pairKey, &FlowEntry::key);
  if (flowIt == flows_.end()) {
    constexpr double kFlowMaxDim = 384;
    const double scale = std::min(1.0, kFlowMaxDim / std::max(w, h));
    const int fw = std::max(8, static_cast<int>(std::lround(w * scale)));
    const int fh = std::max(8, static_cast<int>(std::lround(h * scale)));
    const std::vector<std::uint8_t> sa = box_downscale(pa, w, h, fw, fh);
    const std::vector<std::uint8_t> sb = box_downscale(pb, w, h, fw, fh);
    FlowEntry fe;
    fe.key = pairKey;
    fe.flow = pixmo::compute_flow(pixmo::luma_int_of(sa, fw, fh), pixmo::luma_int_of(sb, fw, fh), fw, fh);
    fe.fw = fw;
    fe.fh = fh;
    flows_.push_front(std::move(fe));
    constexpr std::size_t kFlowCacheMax = 4;  // FLOW_CACHE_MAX
    while (flows_.size() > kFlowCacheMax) flows_.pop_back();
    flowIt = flows_.begin();
  } else {
    flows_.splice(flows_.begin(), flows_, flowIt);  // recency
    flowIt = flows_.begin();
  }
  auto e = std::make_shared<RasterEntry>();
  e->width = static_cast<std::uint32_t>(w);
  e->height = static_cast<std::uint32_t>(h);
  e->rgba.resize(pa.size());
  pixmo::warp_blend(pa, pb, w, h, flowIt->flow, static_cast<double>(w) / flowIt->fw, static_cast<double>(h) / flowIt->fh, t,
                    e->rgba);
  // A Fields interpretation treats the in-between as it treats any frame (setFrame's fields).
  if (r.fields != 0) pixmo::deinterlace_data(e->rgba, w, h, r.fields == 'u');
  insert(hash, std::move(e));
  return hash;
}
#endif

std::string SceneTextures::footage_bake_ref(const TextureRequest& r, const std::string& baseHash, PrepareStats& stats,
                                            std::shared_ptr<const RasterEntry> base) {
  if (!base) base = find(baseHash);
  if (!base || base->width == 0 || base->height == 0) return baseHash;
  const double srcW = base->width;
  const double srcH = base->height;
  const double lw = r.spec.at("width").is_number() ? r.spec.at("width").num() : 0;
  const double lh = r.spec.at("height").is_number() ? r.spec.at("height").num() : 0;
  double w = srcW;
  double h = srcH;
  if (r.video) {
    // bakeSize: the layer box's device px, the limiting axis decides; never above native.
    const double ts = r.bakeTargetScale;
    if (ts > 0 && std::isfinite(ts)) {
      const double boxW = std::max(1.0, lw) * ts;
      const double boxH = std::max(1.0, lh) * ts;
      const double factor = std::min(1.0, std::max(boxW / srcW, boxH / srcH));
      w = std::max(1.0, std::round(srcW * factor));
      h = std::max(1.0, std::round(srcH * factor));
    }
  } else {
    // bakeImageBitmap: the displayed width × BAKE_HEADROOM, 0.05..1 of the source, ≤ the max raster dimension.
    constexpr double kBakeHeadroom = 1.5;
    constexpr double kMaxRasterDimension = 8192;  // DEFAULT_MAX_RASTER_DIMENSION
    const double needW = lw > 0 ? lw * r.resolutionScale * kBakeHeadroom : srcW;
    const double factor = std::min(1.0, std::max(0.05, needW / srcW));
    w = std::max(1.0, std::round(srcW * factor));
    h = std::max(1.0, std::round(srcH * factor));
    if (w > kMaxRasterDimension || h > kMaxRasterDimension) {
      const double clampScale = std::min(kMaxRasterDimension / w, kMaxRasterDimension / h);
      w = std::max(1.0, std::round(w * clampScale));
      h = std::max(1.0, std::round(h * clampScale));
    }
  }
  const auto bw = static_cast<std::uint32_t>(w);
  const auto bh = static_cast<std::uint32_t>(h);
  std::array<char, 48> dims{};
  std::snprintf(dims.data(), dims.size(), "|%ux%u|%c", bw, bh, r.fields != 0 ? r.fields : '-');  // NOLINT(cppcoreguidelines-pro-type-vararg)
  const std::string hash = "img:bake:" + hex64(fnv1a(js::stringify(r.spec), fnv1a(dims.data(), fnv1a(baseHash))));
  if (const std::shared_ptr<const RasterEntry> hit = find(hash)) {
    ++stats.rasterHits;
    for (const std::string& u : hit->unsupported) stats.unsupported.emplace_back(r.key, u);
    return hash;
  }
  const auto t0 = std::chrono::steady_clock::now();
  // The frame into a canvas (straight alpha, as a canvas holds it), drawn at the bake size.
  std::vector<std::uint8_t> straight = base->rgba;
  for (std::size_t i = 0; i + 3 < straight.size(); i += 4) {
    const unsigned a = straight[i + 3];
    if (a == 0 || a == 255) continue;
    for (std::size_t c = 0; c < 3; ++c) straight[i + c] = static_cast<std::uint8_t>(std::min(255U, (straight[i + c] * 255U + a / 2) / a));
  }
  const auto canvas = raster::Canvas2D::make(bw, bh, opts_.canvas);
  if (!canvas) return baseHash;
  if (bw == base->width && bh == base->height) {
    canvas->putImageData(straight, bw, bh, 0, 0);
  } else {
    const auto src = raster::Canvas2D::make(base->width, base->height, opts_.canvas);
    if (!src) return baseHash;
    src->putImageData(straight, base->width, base->height, 0, 0);
    canvas->setImageSmoothing(true);
    canvas->drawImage(*src, 0, 0, srcW, srcH, 0, 0, w, h);
  }
  if (r.fields != 0) {
    // Before the chain: effects sampling a combed frame would smear the comb into their output.
    std::vector<std::uint8_t> px = canvas->getImageData(0, 0, bw, bh);
    pixmo::deinterlace_data(px, static_cast<int>(bw), static_cast<int>(bh), r.fields == 'u');
    canvas->putImageData(px, bw, bh, 0, 0);
  }
  std::vector<std::string> unsupported;
  bake::bake_footage(*canvas, r.spec, unsupported, bake::SharedPool{bakePool_.get(), &bakePoolM_});
  auto e = std::make_shared<RasterEntry>();
  e->width = bw;
  e->height = bh;
  e->rgba = canvas->pixels();
  e->unsupported = unsupported;
  for (const std::string& u : unsupported) stats.unsupported.emplace_back(r.key, u);
  insert(hash, std::move(e));
  ++stats.rasterMisses;
  stats.rasterMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  return hash;
}

std::string SceneTextures::data_image_ref(const TextureRequest& r, PrepareStats& stats) {
  // Cached by the URL itself (its bytes ARE the content) × the alpha mode.
  std::string hash = "img:data:" + hex64(fnv1a(r.premultiplied ? "|p" : "|s", fnv1a(r.src)));
  if (const auto oe = openErrors_.find(hash); oe != openErrors_.end()) {
    stats.unsupported.emplace_back(r.key, "image did not decode: " + oe->second);
    return {};
  }
  if (find(hash)) return hash;
  const auto t0 = std::chrono::steady_clock::now();
  const std::size_t comma = r.src.find(',');
  const std::string_view head = std::string_view(r.src).substr(0, comma == std::string::npos ? 0 : comma);
  std::optional<std::vector<std::uint8_t>> bytes;
  if (comma != std::string::npos && head.ends_with(";base64")) bytes = doc::native_unbase64(std::string_view(r.src).substr(comma + 1));
  DecodedImage img;
  std::string error = bytes ? std::string() : std::string("not a base64 data URL");
  if (!bytes || !decode_image_bytes(*bytes, img, error)) {
    openErrors_.emplace(hash, error);
    stats.unsupported.emplace_back(r.key, "image did not decode: " + error);
    return {};
  }
  if (!r.premultiplied) {  // premultiplied at decode, as image_ref does
    for (std::size_t i = 0; i + 3 < img.rgba.size(); i += 4) {
      const unsigned a = img.rgba[i + 3];
      for (std::size_t c = 0; c < 3; ++c) {
        const unsigned prod = (img.rgba[i + c] * a) + 128U;
        img.rgba[i + c] = static_cast<std::uint8_t>((prod + (prod >> 8U)) >> 8U);
      }
    }
  }
  auto e = std::make_shared<RasterEntry>();
  e->width = img.width;
  e->height = img.height;
  e->rgba = std::move(img.rgba);
  insert(hash, std::move(e));
  ++stats.rasterMisses;
  stats.rasterMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  return hash;
}

std::string SceneTextures::svg_ref(const TextureRequest& r, PrepareStats& stats) {
  // Cached by document (the src, or the file's path + stamp) × recolour fill.
  std::string path;
  std::uint64_t h = fnv1a(r.fill.value_or(""), fnv1a(r.src));
  if (!r.src.starts_with("data:")) {
    std::filesystem::path p = file_url_path(r.src);
    if (p.is_relative() && !opts_.mediaBase.empty()) p = opts_.mediaBase / p;
    path = p.lexically_normal().string();
    const FileStamp st = file_stamp(p);
    std::array<char, 48> tail{};
    std::snprintf(tail.data(), tail.size(), "|%llu|%llu", static_cast<unsigned long long>(st.size),  // NOLINT(cppcoreguidelines-pro-type-vararg)
                  static_cast<unsigned long long>(st.modified));
    h = fnv1a(tail.data(), fnv1a(path, h));
  }
  std::string hash = "img:svg:" + hex64(h);
  if (const auto oe = openErrors_.find(hash); oe != openErrors_.end()) {
    stats.unsupported.emplace_back(r.key, "SVG did not render: " + oe->second);
    return {};
  }
  if (const std::shared_ptr<const RasterEntry> hit = find(hash)) {
    ++stats.rasterHits;
    for (const std::string& u : hit->unsupported) stats.unsupported.emplace_back(r.key, "SVG: " + u);
    return hash;
  }
  const auto t0 = std::chrono::steady_clock::now();
  raster::RasterOutput out = rasterize_svg_src(r.src, r.fill, path);
  stats.rasterMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  ++stats.rasterMisses;
  if (!out.ok) {
    openErrors_.emplace(hash, out.error);
    stats.unsupported.emplace_back(r.key, "SVG did not render: " + out.error);
    return {};
  }
  for (const std::string& u : out.unsupported) stats.unsupported.emplace_back(r.key, "SVG: " + u);
  auto e = std::make_shared<RasterEntry>();
  e->width = out.width;
  e->height = out.height;
  e->rgba = std::move(out.rgba);
  e->unsupported = std::move(out.unsupported);
  insert(hash, std::move(e));
  return hash;
}

}  // namespace premation::scene