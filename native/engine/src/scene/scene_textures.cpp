#include "scene_textures.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <thread>

#include "image_decode.hpp"
#include "json.hpp"
#include "raster_source.hpp"

#if defined(PREMATION_HAVE_MEDIA)
#include "media_system.hpp"
#include "media_textures.hpp"
#include "time_map.hpp"
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

SceneTextures::SceneTextures(Options opts) : opts_(std::move(opts)) {}
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
}

void SceneTextures::prepare(const std::vector<TextureRequest>& reqs, std::vector<api::RenderTextureRef>& refs,
                            PrepareStats& stats) {
  struct Miss {
    const TextureRequest* req;
    std::string hash;
    std::string spec;
  };
  std::vector<Miss> misses;
  std::vector<std::string> seen;
  refs.reserve(refs.size() + reqs.size());
  for (const TextureRequest& r : reqs) {
    api::RenderTextureRef ref;
    ref.key = r.key;
    if (r.kind == TexKind::media) {
      ref.hash = media_ref(r, stats);
      ref.ready = !ref.hash.empty();
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
    if ((r.kind == TexKind::path || r.kind == TexKind::mask) && r.spec.is_object()) {
      js::Json keyed = r.spec;
      for (const char* k : {"x", "y", "rotation", "scaleX", "scaleY", "depth", "opacity", "blend"}) keyed.erase(k);
      // sourceTime reaches the pixels only through a CPU-baked effect chain.
      if (!r.spec.at("__baked").b()) keyed.erase("sourceTime");
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
    if (find(ref.hash)) {
      ++stats.rasterHits;
    } else if (std::ranges::find(seen, ref.hash) == seen.end()) {
      seen.push_back(ref.hash);
      misses.push_back({&r, ref.hash, std::move(spec)});
    }
    refs.push_back(std::move(ref));
  }
  if (misses.empty()) return;
  stats.rasterMisses += static_cast<std::uint32_t>(misses.size());
  const auto t0 = std::chrono::steady_clock::now();
  std::vector<std::shared_ptr<RasterEntry>> done(misses.size());
  const auto work = [&](std::size_t i) {
    const Miss& m = misses[i];
    auto e = std::make_shared<RasterEntry>();
    raster::RasterOutput out =
        raster::draw_raster_source(raster_kind(m.req->kind), m.spec, m.req->resolutionScale, m.req->padding, opts_.canvas);
    e->width = out.width;
    e->height = out.height;
    e->rgba = std::move(out.rgba);
    e->unsupported = std::move(out.unsupported);
    if (!out.ok) e->error = out.error.empty() ? "raster failed" : out.error;
    done[i] = std::move(e);
  };
  unsigned threads = opts_.threads != 0 ? opts_.threads : std::min(8U, std::max(1U, std::thread::hardware_concurrency()));
  threads = std::min<unsigned>(threads, static_cast<unsigned>(misses.size()));
  if (threads <= 1) {
    for (std::size_t i = 0; i < misses.size(); ++i) work(i);
  } else {
    std::atomic<std::size_t> next{0};
    std::vector<std::jthread> pool;
    pool.reserve(threads);
    for (unsigned t = 0; t < threads; ++t) {
      pool.emplace_back([&] {
        for (std::size_t i = next.fetch_add(1); i < misses.size(); i = next.fetch_add(1)) work(i);
      });
    }
  }
  stats.rasterMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  for (std::size_t i = 0; i < misses.size(); ++i) {
    for (const std::string& u : done[i]->unsupported) stats.unsupported.emplace_back(misses[i].req->key, u);
    if (!done[i]->error.empty()) stats.unsupported.emplace_back(misses[i].req->key, "raster error: " + done[i]->error);
    insert(misses[i].hash, std::move(done[i]));
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

std::string SceneTextures::media_ref(const TextureRequest& r, PrepareStats& stats) {
  if (r.src.empty()) return {};
  // SVG footage is rasterised by the browser in the TS engine; the engine has no SVG renderer yet.
  const auto lower = [](std::string s) {
    for (char& c : s) c = c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c;
    return s;
  };
  if (lower(r.src).ends_with(".svg") || r.src.starts_with("data:image/svg")) {
    stats.unsupported.emplace_back(r.key, "SVG image footage");
    return {};
  }
  if (r.src.starts_with("data:") || r.src.starts_with("blob:") || r.src.starts_with("http:") ||
      r.src.starts_with("https:")) {
    stats.unsupported.emplace_back(r.key, "footage that is not a file on disk");
    return {};
  }
  std::filesystem::path p = file_url_path(r.src);
  if (p.is_relative() && !opts_.mediaBase.empty()) p = opts_.mediaBase / p;
  if (is_still_image_path(p)) return image_ref(r, p, stats);
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
  media::FootageInterpretation interp;
  const media::FramePlan plan =
      media::plan_frames(*index, r.sourceTime, interp, media::FrameBlend::none, probeFps, r.compFps);
  ++stats.mediaRefs;
  // Playback: the source's worker decodes ahead of the playhead (MediaSystem::playhead).
  if (playing_) media_->playhead(id, plan.a.index, 1);
  if (plan.a.bottom) return media::media_hash(id, plan.a.index, *plan.a.bottom);
  return media::media_hash(id, plan.a.index);
#else
  stats.unsupported.emplace_back(r.key, "footage (built without E1 media)");
  return {};
#endif
}

}  // namespace premation::scene
