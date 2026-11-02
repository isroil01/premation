#include "scene_textures.hpp"

#include "native_contrib.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cstring>
#include <span>
#include <cctype>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <thread>
#include <unordered_set>

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
#include "subject_matte.hpp"
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

/// An animated SVG's samples per second of source time (svg_ref).
constexpr double kSvgSamplesPerSecond = 60;
/// E4: SVG display steps — the raster's long edge is 2^(step/2) px: 16 … 4096.
/// A first sight in the viewport draws the preview step (512 px) now.
constexpr int kSvgMinStep = 8;
constexpr int kSvgMaxStep = 24;
constexpr int kSvgPreviewStep = 18;
double svg_step_long(int step) { return std::round(std::pow(2.0, static_cast<double>(step) / 2.0)); }

std::uint64_t fnv1a(std::string_view s, std::uint64_t h = 0xcbf29ce484222325ULL) {
  for (const char c : s) {
    h ^= static_cast<std::uint8_t>(c);
    h *= 0x100000001b3ULL;
  }
  return h;
}

/// FNV-1a over what `js::stringify(v)` would say, without building the text:
/// kinds, keys, string bytes and the BITS of numbers (printing a long path's
/// numbers was most of a stroked layer's frame — every frame, cached raster or
/// not). Equal values hash equal; -0 is hashed as 0, as stringify prints it.
/// `skip`: top-level keys left out (what `keyed.erase(…)` did, without the copy).
std::uint64_t hash_json(const js::Json& v, std::uint64_t h, std::span<const std::string_view> skip = {}) {
  const auto mix = [&h](std::uint64_t bits) {
    for (unsigned i = 0; i < 8; ++i) {
      h ^= (bits >> (8U * i)) & 0xFFU;
      h *= 0x100000001b3ULL;
    }
  };
  mix(static_cast<std::uint64_t>(v.kind() == js::Json::Kind::undefined ? js::Json::Kind::null : v.kind()));
  switch (v.kind()) {
    case js::Json::Kind::undefined:
    case js::Json::Kind::null:
      return h;
    case js::Json::Kind::boolean:
      mix(v.b() ? 1U : 0U);
      return h;
    case js::Json::Kind::number: {
      const double d = v.num();
      // Non-finite prints as null; ±0 prints as "0".
      mix(!std::isfinite(d) ? 0x7FF8000000000001ULL : std::bit_cast<std::uint64_t>(d == 0 ? 0.0 : d));
      return h;
    }
    case js::Json::Kind::string:
      mix(v.str().size());
      return fnv1a(v.str(), h);
    case js::Json::Kind::array:
      mix(v.arr().size());
      for (const js::Json& e : v.arr()) h = hash_json(e, h);
      return h;
    case js::Json::Kind::object:
      for (const auto& m : v.obj()) {
        if (m.value.is_undefined() || std::ranges::find(skip, std::string_view(m.key)) != skip.end()) continue;
        mix(m.key.size());
        h = fnv1a(m.key, h);
        h = hash_json(m.value, h);
      }
      mix(0xFFFFFFFFFFFFFFFFULL);  // end of object
      return h;
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


// ── E4: the SVG worker ─────────────────────────────────────────────────────
// One thread draws the exact display step of an SVG the viewport asked for
// while the frame draws a stand-in (the nearest cached step, or a quick
// preview). Keys are de-duplicated: a step queued or in flight is not queued
// again. The result lands in the raster cache through `insert` (its lock);
// the render thread finds it on its next prepare. Exact mode (exports, Cache
// Work Area) never uses the worker: it draws synchronously.
struct SceneTextures::SvgWorker {
  explicit SvgWorker(SceneTextures& owner) : owner_(owner), thread_([this] { run(); }) {}
  ~SvgWorker() {
    {
      const std::scoped_lock lock(m_);
      stop_ = true;
    }
    cv_.notify_all();
    thread_.join();
  }
  SvgWorker(const SvgWorker&) = delete;
  SvgWorker& operator=(const SvgWorker&) = delete;
  SvgWorker(SvgWorker&&) = delete;
  SvgWorker& operator=(SvgWorker&&) = delete;

  void enqueue(SvgJob job) {
    {
      const std::scoped_lock lock(m_);
      if (!keys_.insert(job.key).second) return;  // queued or in flight already
      queue_.push_back(std::move(job));
    }
    cv_.notify_one();
  }
  [[nodiscard]] bool pending() const {
    const std::scoped_lock lock(m_);
    return !keys_.empty();
  }
  bool wait_idle(std::uint32_t timeoutMs) {
    std::unique_lock lock(m_);
    return idle_.wait_for(lock, std::chrono::milliseconds(timeoutMs), [this] { return keys_.empty(); });
  }

 private:
  void run() {
    for (;;) {
      SvgJob job;
      {
        std::unique_lock lock(m_);
        cv_.wait(lock, [this] { return stop_ || !queue_.empty(); });
        if (stop_) return;
        job = std::move(queue_.front());
        queue_.pop_front();
      }
      raster::RasterOutput out = rasterize_svg_src(job.src, job.fill, job.path, job.time, job.targetLong);
      auto e = std::make_shared<RasterEntry>();
      if (out.ok) {
        e->width = out.width;
        e->height = out.height;
        e->rgba = std::move(out.rgba);
        e->unsupported = std::move(out.unsupported);
      } else {
        e->error = out.error.empty() ? "SVG render failed" : out.error;  // a failed step stays failed (no re-queue loop)
      }
      owner_.insert(job.key, std::move(e));
      {
        const std::scoped_lock lock(m_);
        keys_.erase(job.key);
      }
      idle_.notify_all();
    }
  }

  SceneTextures& owner_;
  mutable std::mutex m_;
  std::condition_variable cv_;
  std::condition_variable idle_;
  std::deque<SvgJob> queue_;
  std::unordered_set<std::string> keys_;
  bool stop_ = false;
  JoiningThread thread_;  // last: joined first
};

namespace {

/// A stored subject matte file's cache hash (`img:…|a`): path + size + last write, like image_ref's,
/// with the alpha-plane tag — the read-ahead worker and the render thread agree on it.
std::string matte_hash(const std::filesystem::path& p) {
  const FileStamp st = file_stamp(p);
  std::array<char, 64> tail{};
  std::snprintf(tail.data(), tail.size(), "|%llu|%llu|a", static_cast<unsigned long long>(st.size),  // NOLINT(cppcoreguidelines-pro-type-vararg)
                static_cast<unsigned long long>(st.modified));
  return "img:" + hex64(fnv1a(tail.data(), fnv1a(utf8_path(p.lexically_normal()))));
}

/// A stored subject matte file decoded to its alpha plane (a greyscale PNG's value, a legacy RGBA
/// cut-out's alpha). False with `error` when it does not decode.
bool decode_matte(const std::filesystem::path& p, RasterEntry& e, std::string& error) {
  DecodedImage img;
  if (!decode_image_file(p, img, error)) return false;
  e.width = img.width;
  e.height = img.height;
  e.alpha = subject_matte::alpha_plane(img.rgba, img.width, img.height, subject_matte::png_is_gray(p));
  return true;
}

}  // namespace

/// Stream B5: the matte read-ahead worker. One thread, FIFO, paths de-duplicated; each path
/// decodes to an alpha-plane raster the render thread's matte_ref then finds (the same hash).
struct SceneTextures::MatteWorker {
  explicit MatteWorker(SceneTextures& owner) : owner_(owner), thread_([this] { run(); }) {}
  ~MatteWorker() {
    {
      const std::scoped_lock lock(m_);
      stop_ = true;
    }
    cv_.notify_all();
    thread_.join();
  }
  MatteWorker(const MatteWorker&) = delete;
  MatteWorker& operator=(const MatteWorker&) = delete;
  MatteWorker(MatteWorker&&) = delete;
  MatteWorker& operator=(MatteWorker&&) = delete;

  void enqueue(std::filesystem::path p) {
    {
      const std::scoped_lock lock(m_);
      if (!keys_.insert(utf8_path(p)).second) return;  // queued or in flight already
      queue_.push_back(std::move(p));
    }
    cv_.notify_one();
  }
  [[nodiscard]] bool pending() const {
    const std::scoped_lock lock(m_);
    return !keys_.empty();
  }
  bool wait_idle(std::uint32_t timeoutMs) {
    std::unique_lock lock(m_);
    return idle_.wait_for(lock, std::chrono::milliseconds(timeoutMs), [this] { return keys_.empty(); });
  }

 private:
  void run() {
    for (;;) {
      std::filesystem::path p;
      {
        std::unique_lock lock(m_);
        cv_.wait(lock, [this] { return stop_ || !queue_.empty(); });
        if (stop_) return;
        p = std::move(queue_.front());
        queue_.pop_front();
      }
      const std::string hash = matte_hash(p);
      if (!owner_.find(hash)) {
        auto e = std::make_shared<RasterEntry>();
        std::string error;
        // A file that does not decode is left to the render thread, which records the reason.
        if (decode_matte(p, *e, error)) owner_.insert(hash, std::move(e));
      }
      {
        const std::scoped_lock lock(m_);
        keys_.erase(utf8_path(p));
      }
      idle_.notify_all();
    }
  }

  SceneTextures& owner_;
  mutable std::mutex m_;
  std::condition_variable cv_;
  std::condition_variable idle_;
  std::deque<std::filesystem::path> queue_;
  std::unordered_set<std::string> keys_;
  bool stop_ = false;
  JoiningThread thread_;  // last: joined first
};

SceneTextures::SceneTextures(Options opts)
    : opts_(std::move(opts)),
      bakePool_(std::make_unique<effects::ThreadPool>(std::min(8U, std::max(1U, std::thread::hardware_concurrency())))) {}
SceneTextures::~SceneTextures() = default;

bool SceneTextures::svg_pending() const { return svgWorker_ != nullptr && svgWorker_->pending(); }

bool SceneTextures::wait_svg_idle(std::uint32_t timeoutMs) { return svgWorker_ == nullptr || svgWorker_->wait_idle(timeoutMs); }

void SceneTextures::svg_enqueue(SvgJob job) {
  if (!svgWorker_) svgWorker_ = std::make_unique<SvgWorker>(*this);
  svgWorker_->enqueue(std::move(job));
}

bool SceneTextures::matte_pending() const { return matteWorker_ != nullptr && matteWorker_->pending(); }

bool SceneTextures::wait_matte_idle(std::uint32_t timeoutMs) { return matteWorker_ == nullptr || matteWorker_->wait_idle(timeoutMs); }

void SceneTextures::matte_prefetch(const std::vector<std::string>& srcs) {
  for (const std::string& src : srcs) {
    if (src.empty() || src.starts_with("data:") || is_svg_src(src)) continue;
    std::filesystem::path p = file_url_fs_path(src);
    if (p.is_relative() && !opts_.mediaBase.empty()) p = opts_.mediaBase / p;
    // Already decoded (or decoding): nothing to queue. A hash miss here costs one stat per
    // frame ahead, once per playback frame — the frames the walk stored are read in order.
    if (find(matte_hash(p))) continue;
    if (!matteWorker_) matteWorker_ = std::make_unique<MatteWorker>(*this);
    matteWorker_->enqueue(std::move(p));
  }
}

void SceneTextures::set_media(media::MediaSystem* system, media::MediaTextures* frames) noexcept {
  media_ = system;
  mediaFrames_ = frames;
}

std::shared_ptr<const RasterEntry> SceneTextures::find(std::string_view hash) {
  const std::scoped_lock lock(m_);
  const auto it = byHash_.find(hash);
  if (it == byHash_.end()) return nullptr;
  lru_.splice(lru_.begin(), lru_, it->second);
  it->second->lastUse = frame_;
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
  bytes_ += e->bytes();
  lru_.push_front(Slot{hash, std::move(e), frame_});
  byHash_.emplace(std::move(hash), lru_.begin());
  // Least recently used first — but never a raster of the frame being prepared
  // (every one of them was found or made under `frame_`, so they sit ahead of
  // every older entry): a frame that outgrows the budget keeps all its layers
  // and the cache shrinks back to the budget on the frames after it.
  while (bytes_ > opts_.rasterCacheBytes && lru_.size() > 1 && lru_.back().lastUse != frame_) {
    Slot& back = lru_.back();
    bytes_ -= back.entry->bytes();
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

namespace {

/// A path as forget_media compares it: one separator, and case-folded on
/// Windows (whose file names are case-insensitive), lexically normal.
std::string comparable_path(const std::string& path) {
  std::string s = utf8_path(file_url_fs_path(path).lexically_normal());
  for (char& ch : s) {
    if (ch == '\\') ch = '/';
#if defined(_WIN32)
    if (ch >= 'A' && ch <= 'Z') ch = static_cast<char>(ch - 'A' + 'a');
#endif
  }
  return s;
}

}  // namespace

void SceneTextures::forget_media(const std::vector<std::string>& paths, bool everything) {
  if (!everything && paths.empty()) return;
  std::unordered_set<std::string> wanted;
  wanted.reserve(paths.size());
  for (const std::string& p : paths) {
    // A document `src` (file:// / local-file:// URL) or `path`; relative ones against the project, as prepare resolves them.
    std::filesystem::path fs = file_url_fs_path(p);
    if (fs.is_relative() && !opts_.mediaBase.empty()) fs = opts_.mediaBase / fs;
    wanted.insert(comparable_path(utf8_path(fs)));
  }
  const auto hit = [&](const std::string& key) { return everything || wanted.contains(comparable_path(key)); };
  for (auto it = sources_.begin(); it != sources_.end();) {
    if (!hit(it->first)) {
      ++it;
      continue;
    }
#if defined(PREMATION_HAVE_MEDIA)
    if (media_ != nullptr) media_->close(it->second);
#endif
    it = sources_.erase(it);
  }
  for (auto it = openErrors_.begin(); it != openErrors_.end();) it = hit(it->first) ? openErrors_.erase(it) : std::next(it);
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
  const std::size_t first = refs.size();
  svgStandIn_ = false;
  {
    // A new frame: its rasters are pinned against eviction until the next one (insert).
    const std::scoped_lock lock(m_);
    ++frame_;
  }
  prepare_refs(reqs, refs, stats);
  {
    const std::scoped_lock lock(m_);
    stats.rasterOverBudget = bytes_ > opts_.rasterCacheBytes ? bytes_ - opts_.rasterCacheBytes : 0;
  }
  // A raster over the device's 2D limit (frame_build plans to texture_dimension_limit,
  // but a still, a light wash or a particle field is sized by its content) is never
  // handed to the GPU: Dawn would make an error texture and fail the whole frame.
  // The ref is not ready — its layer draws nothing — and the reason is reported.
  const double limit = dev_ != nullptr ? dev_->max_texture_dimension() : texture_dimension_limit();
  for (std::size_t i = first; i < refs.size(); ++i) {
    api::RenderTextureRef& ref = refs[i];
    if (!ref.ready || !(ref.hash.starts_with("rs:") || ref.hash.starts_with("img:"))) continue;
    const RasterEntry* e = raster(ref.hash);
    if (e == nullptr || (e->width <= limit && e->height <= limit)) continue;
    ref.ready = false;
    ++stats.oversizeRefused;
    stats.unsupported.emplace_back(ref.key, "texture " + std::to_string(e->width) + "x" + std::to_string(e->height) +
                                                " is over the GPU limit of " + std::to_string(static_cast<std::uint32_t>(limit)) +
                                                " px; the layer is skipped");
  }
}

void SceneTextures::prepare_refs(const std::vector<TextureRequest>& reqs, std::vector<api::RenderTextureRef>& refs,
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
      // One footage file that cannot be read (a name, a codec, a decoder that
      // throws) skips its layer and says why — never the frame, never the engine.
      try {
        ref.hash = media_ref(r, stats, space);
      } catch (const std::exception& e) {
        ref.hash.clear();
        stats.unsupported.emplace_back(r.key, std::string("footage failed: ") + e.what());
      }
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
      static constexpr std::array<std::string_view, 12> kBakedSkip = {
          "x", "y", "rotation", "scaleX", "scaleY", "depth", "opacity", "blend", "sourceTime", "effects", "fillOpacity", "mask"};
      contentKey = fnv1a(tail.data(), hash_json(r.spec, fnv1a("baked-content"), kBakedSkip));
      if (contentKey == 0) contentKey = 1;
    }
    const std::uint64_t seed = 0xcbf29ce484222325ULL;
    if ((r.kind == TexKind::path || r.kind == TexKind::mask) && r.spec.is_object()) {
      // sourceTime too, baked or not (contentHash.ts keys it for media layers
      // only): the painters never read it, and a baked chain sees time only
      // through its resolved params (resolve_effect_params puts the layer time
      // into timecode / strobe-light / particle-systems), which ARE keyed — so a
      // baked layer whose stack does not animate keeps its bake across frames.
      // GPU route (not baked): the chain applies fill opacity and the effect
      // stack, and the painters do not read them. Leaving them in the key
      // re-rasterizes the shape on every fill-opacity frame (the E4 bench).
      static constexpr std::array<std::string_view, 9> kPlacement = {"x",     "y",       "rotation", "scaleX",    "scaleY",
                                                                     "depth", "opacity", "blend",    "sourceTime"};
      static constexpr std::array<std::string_view, 11> kPlacementChain = {
          "x", "y", "rotation", "scaleX", "scaleY", "depth", "opacity", "blend", "sourceTime", "fillOpacity", "effects"};
      h = fnv1a(tail.data(), r.spec.at("__baked").b() ? hash_json(r.spec, seed, kPlacement)
                                                      : hash_json(r.spec, seed, kPlacementChain));
    } else if (r.kind == TexKind::text && r.spec.is_object()) {
      // The layer scale picks the tier (in `tail`); the text painters never read it.
      static constexpr std::array<std::string_view, 2> kScale = {"scaleX", "scaleY"};
      static constexpr std::array<std::string_view, 4> kScaleChain = {"scaleX", "scaleY", "fillOpacity", "effects"};
      h = fnv1a(tail.data(), r.spec.at("__baked").b() ? hash_json(r.spec, seed, kScale) : hash_json(r.spec, seed, kScaleChain));
    } else {
      h = fnv1a(tail.data(), hash_json(r.spec, seed));
    }
    ref.hash = "rs:" + hex64(h);
    ref.ready = true;
    // Authored text / shape colours are sRGB; a mask raster is coverage (data).
    if (colorManaged_ && r.kind != TexKind::mask) ref.input_space = api::RenderColorSpace::srgb;
    if (find(ref.hash)) {
      ++stats.rasterHits;
    } else if (std::ranges::find(seen, ref.hash) == seen.end()) {
      seen.push_back(ref.hash);
      // The rasterizer reads the drawable as text: printed only for a miss.
      misses.push_back({&r, ref.hash, js::stringify(r.spec), contentKey});
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
    if (m.req->kind == TexKind::overlay) {  // E4 round 2: a drawn effect alone (bake_chain.cpp)
      bake::OverlayOutput ov = bake::draw_effect_overlay(m.req->spec, m.req->resolutionScale, m.req->padding, opts_.canvas,
                                                         bake::SharedPool{bakePool_.get(), &bakePoolM_});
      e->width = ov.width;
      e->height = ov.height;
      e->rgba = std::move(ov.rgba);
      e->unsupported = std::move(ov.unsupported);
      if (e->width == 0) e->error = "effect overlay failed";
      done[i] = std::move(e);
      return;
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
  // A raster that throws is that layer's error, not a dead worker thread (std::terminate).
  const auto guarded = [&](std::size_t i) {
    try {
      work(i);
    } catch (const std::exception& e) {
      auto failed = std::make_shared<RasterEntry>();
      failed->error = e.what();
      done[i] = std::move(failed);
    }
  };
  unsigned threads = opts_.threads != 0 ? opts_.threads : std::min(8U, std::max(1U, std::thread::hardware_concurrency()));
  threads = std::min<unsigned>(threads, static_cast<unsigned>(misses.size()));
  if (threads <= 1) {
    for (std::size_t i = 0; i < misses.size(); ++i) guarded(i);
  } else {
    std::atomic<std::size_t> next{0};
    std::vector<JoiningThread> pool;
    pool.reserve(threads);
    for (unsigned t = 0; t < threads; ++t) {
      pool.emplace_back([&] {
        for (std::size_t i = next.fetch_add(1); i < misses.size(); i = next.fetch_add(1)) guarded(i);
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
  if (hash.starts_with("sm:")) return subject_texture(hash);  // stream B3: built by the subject-edge passes
  if (hash.starts_with("rs:") || hash.starts_with("img:")) {
    if (dev_ == nullptr) return {};
    const std::shared_ptr<const RasterEntry> e = find(hash);
    // A pooled texture hits by hash and ignores the pixels; on a miss the
    // pixels upload once (an evicted raster that is not re-prepared draws nothing).
    if (!e) return {};
    // A stored subject matte's alpha plane: one channel (the subject-edge passes read .r).
    if (e->rgba.empty() && !e->alpha.empty())
      return dev_->texture(hash, e->width, e->height, wgpu::TextureFormat::R8Unorm, std::span<const std::uint8_t>(e->alpha), false);
    return dev_->texture(hash, e->width, e->height, wgpu::TextureFormat::RGBA8Unorm, std::span<const std::uint8_t>(e->rgba),
                         false);
  }
#if defined(PREMATION_HAVE_MEDIA)
  if (mediaFrames_ != nullptr) return mediaFrames_->external_texture(hash);
#endif
  return {};
}

rg::TexRef SceneTextures::external_texture_mipmapped(std::string_view hash, const rg::MipFootprint& fp) {
  if (!hash.starts_with("rs:") && !hash.starts_with("img:")) return external_texture(hash);
  if (dev_ == nullptr) return {};
  const std::shared_ptr<const RasterEntry> e = find(hash);
  if (!e) return {};
  if (e->rgba.empty()) return external_texture(hash);  // an alpha plane: level 0 alone
  // Built as deep as the draw samples (rg::Device::mip_texture): a raster shown
  // at up to 2:1 — most of them, rasters are supersampled 2× — keeps level 0
  // alone, and an animating layer's re-rasters build no chain they never read.
  std::string key(hash);
  key += "#mip";
  return dev_->mip_texture(key, e->width, e->height, wgpu::TextureFormat::RGBA8Unorm, std::span<const std::uint8_t>(e->rgba),
                           rg::mip_levels_needed(e->width, e->height, fp));
}

std::string SceneTextures::image_ref(const TextureRequest& r, const std::filesystem::path& p, PrepareStats& stats) {
  // Still footage: the file's RGBA8 (image_decode.hpp), cached with the rasters
  // by path + size + last write (a re-saved file decodes again).
  const FileStamp st = file_stamp(p);
  std::array<char, 64> tail{};
  std::snprintf(tail.data(), tail.size(), "|%llu|%llu|%d", static_cast<unsigned long long>(st.size),  // NOLINT(cppcoreguidelines-pro-type-vararg)
                static_cast<unsigned long long>(st.modified), r.premultiplied ? 1 : 0);
  const std::string key = utf8_path(p.lexically_normal());
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

std::string SceneTextures::matte_ref(const std::string& src, std::string_view requestKey, PrepareStats& stats) {
  if (src.empty() || is_svg_src(src)) return {};
  if (src.starts_with("data:")) {
    // A matte carried in the document as a `data:image/…;base64,` URL (the render-tests' scenes,
    // a frame pasted by a script): its bytes are the content — cached by the URL, like data_image_ref.
    const std::string hash = "img:data:" + hex64(fnv1a("|a", fnv1a(src)));
    if (const auto oe = openErrors_.find(hash); oe != openErrors_.end()) {
      stats.unsupported.emplace_back(std::string(requestKey), "matte did not decode: " + oe->second);
      return {};
    }
    if (find(hash)) return hash;
    const auto t0 = std::chrono::steady_clock::now();
    const std::size_t comma = src.find(',');
    const std::string_view head = std::string_view(src).substr(0, comma == std::string::npos ? 0 : comma);
    std::optional<std::vector<std::uint8_t>> bytes;
    if (comma != std::string::npos && head.ends_with(";base64")) bytes = doc::native_unbase64(std::string_view(src).substr(comma + 1));
    DecodedImage img;
    std::string error = bytes ? std::string() : std::string("not a base64 data URL");
    if (!bytes || !decode_image_bytes(*bytes, img, error)) {
      openErrors_.emplace(hash, error);
      stats.unsupported.emplace_back(std::string(requestKey), "matte did not decode: " + error);
      return {};
    }
    auto e = std::make_shared<RasterEntry>();
    e->width = img.width;
    e->height = img.height;
    e->alpha = subject_matte::alpha_plane(img.rgba, img.width, img.height, subject_matte::png_bytes_gray(*bytes));
    insert(hash, std::move(e));
    ++stats.rasterMisses;
    stats.rasterMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    return hash;
  }
  std::filesystem::path p = file_url_fs_path(src);
  if (p.is_relative() && !opts_.mediaBase.empty()) p = opts_.mediaBase / p;
  const std::string hash = matte_hash(p);
  if (const auto oe = openErrors_.find(hash); oe != openErrors_.end()) {
    stats.unsupported.emplace_back(std::string(requestKey), "matte did not decode: " + oe->second);
    return {};
  }
  if (find(hash)) return hash;  // decoded on an earlier frame, or by the read-ahead worker (B5)
  const auto t0 = std::chrono::steady_clock::now();
  auto e = std::make_shared<RasterEntry>();
  std::string error;
  if (!decode_matte(p, *e, error)) {
    openErrors_.emplace(hash, error);
    stats.unsupported.emplace_back(std::string(requestKey), "matte did not decode: " + error);
    return {};
  }
  insert(hash, std::move(e));
  ++stats.rasterMisses;
  stats.rasterMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  return hash;
}

std::string SceneTextures::subject_ref(const TextureRequest& r, PrepareStats& stats) {
  // Each file to its alpha plane (matte_ref: its own cache entry, keyed by path and last write),
  // then the combination keyed by those entries and every part's settings. Playing, the frames
  // each subject reaches next go to the read-ahead worker first (stream B5).
  if (playing_ && !exact_)
    for (const SubjectPart& p : r.subjectParts)
      if (!p.ahead.empty()) matte_prefetch(p.ahead);
  std::string spec;
  std::vector<std::string> frames(r.subjectParts.size());
  std::vector<std::vector<std::string>> blends(r.subjectParts.size());
  for (std::size_t i = 0; i < r.subjectParts.size(); ++i) {
    const SubjectPart& p = r.subjectParts[i];
    frames[i] = matte_ref(p.src, r.key, stats);
    std::array<char, 160> s{};
    std::snprintf(s.data(), s.size(), "|%s|%.6g|%.6g|%.6g|%d|%d", frames[i].c_str(), p.feather, p.choke, p.contrast, p.invert ? 1 : 0,  // NOLINT(cppcoreguidelines-pro-type-vararg)
                  p.hidden ? 1 : 0);
    spec += s.data();
    for (const auto& [src, w] : p.blend) {
      blends[i].push_back(matte_ref(src, r.key, stats));
      std::snprintf(s.data(), s.size(), "~%s*%.6g", blends[i].back().c_str(), w);  // NOLINT(cppcoreguidelines-pro-type-vararg)
      spec += s.data();
    }
  }
  if (std::ranges::all_of(frames, [](const std::string& f) { return f.empty(); })) return {};
  const std::string tail = hex64(fnv1a(spec, fnv1a("subject-matte")));
  if (dev_ != nullptr) {
    // Stream B3: the GPU path. The spec is remembered under its `sm:` hash; the texture is built
    // (and rebuilt after the pool drops it) by subject_texture when the frame samples it. A slider
    // move changes the spec, not the frames: the alpha planes stay cached, only the passes rerun.
    std::string hash = "sm:" + tail;
    if (!subjectSpecs_.contains(hash)) {
      SubjectGpuSpec gs;
      for (std::size_t i = 0; i < r.subjectParts.size(); ++i) {
        const SubjectPart& sp = r.subjectParts[i];
        SubjectGpuPart gp;
        gp.frame = frames[i];
        for (std::size_t j = 0; j < blends[i].size(); ++j)
          if (!blends[i][j].empty()) gp.blend.emplace_back(blends[i][j], sp.blend[j].second);
        gp.feather = sp.feather;
        gp.choke = sp.choke;
        gp.contrast = sp.contrast;
        gp.invert = sp.invert;
        gp.hidden = sp.hidden;
        // The first shown part's size; every part hidden, the first one's (as the CPU combine).
        if (gs.width == 0 && !gp.frame.empty() && !gp.hidden)
          if (const std::shared_ptr<const RasterEntry> e = find(gp.frame)) {
            gs.width = e->width;
            gs.height = e->height;
          }
        gs.parts.push_back(std::move(gp));
      }
      if (gs.width == 0)
        for (const SubjectGpuPart& gp : gs.parts)
          if (const std::shared_ptr<const RasterEntry> e = gp.frame.empty() ? nullptr : find(gp.frame)) {
            gs.width = e->width;
            gs.height = e->height;
            break;
          }
      if (gs.width == 0 || gs.height == 0) return {};
      if (subjectSpecOrder_.size() >= kSubjectSpecCap) {  // bounded: the oldest half goes
        for (std::size_t i = 0; i < kSubjectSpecCap / 2; ++i) {
          subjectSpecs_.erase(subjectSpecOrder_.front());
          subjectSpecOrder_.pop_front();
        }
      }
      subjectSpecOrder_.push_back(hash);
      subjectSpecs_.emplace(hash, std::move(gs));
    }
    return hash;
  }
  // No device (tests, a CPU-only session): the CPU combine, an `img:` raster.
  std::string hash = "img:" + tail;
  if (find(hash)) return hash;
  const auto t0 = std::chrono::steady_clock::now();
  // The decoded entries stay alive while they are read.
  std::vector<std::shared_ptr<const RasterEntry>> keep;
  const auto picture = [&](const std::string& h) {
    subject_matte::Picture pic;
    if (h.empty()) return pic;
    std::shared_ptr<const RasterEntry> e = find(h);
    if (!e) return pic;
    pic.width = e->width;
    pic.height = e->height;
    pic.alpha = std::span<const std::uint8_t>(e->alpha);
    keep.push_back(std::move(e));
    return pic;
  };
  std::vector<subject_matte::Part> parts;
  for (std::size_t i = 0; i < r.subjectParts.size(); ++i) {
    const SubjectPart& sp = r.subjectParts[i];
    subject_matte::Part part;
    part.frame = picture(frames[i]);
    for (std::size_t j = 0; j < blends[i].size(); ++j)
      if (const subject_matte::Picture n = picture(blends[i][j]); n.width > 0) part.blend.emplace_back(n, sp.blend[j].second);
    part.feather = sp.feather;
    part.choke = sp.choke;
    part.contrast = sp.contrast;
    part.invert = sp.invert;
    part.hidden = sp.hidden;
    parts.push_back(std::move(part));
  }
  auto e = std::make_shared<RasterEntry>();
  e->rgba = subject_matte::combine(parts, e->width, e->height);
  if (e->rgba.empty()) return {};
  insert(hash, std::move(e));
  ++stats.rasterMisses;
  stats.rasterMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  return hash;
}

rg::TexRef SceneTextures::subject_texture(std::string_view hash) {
  if (dev_ == nullptr) return {};
  const auto it = subjectSpecs_.find(std::string(hash));
  if (it == subjectSpecs_.end()) return {};
  const SubjectGpuSpec& gs = it->second;
  bool created = false;
  rg::RenderTarget& out = dev_->target(hash, gs.width, gs.height, wgpu::TextureFormat::RGBA8Unorm, 1, false, &created);
  if (!created) return out.tex();  // the pool holds it: a slider that did not move costs nothing
  ++subjectEdgeBuilds_;
  // One-off texture preparation, off the hot path (side_draw: its own command buffer, submitted
  // now): the allocations below happen once per content, never per frame.
  const std::uint32_t w = gs.width;
  const std::uint32_t h = gs.height;
  const rg::SamplerRef nearest = dev_->sampler("nearest-clamp", wgpu::FilterMode::Nearest, wgpu::AddressMode::ClampToEdge);
  const auto scratch = [&](std::string_view name, wgpu::TextureFormat format) -> rg::RenderTarget& {
    return dev_->target(name, w, h, format, 1, false);
  };
  const rg::ColorPipeline plain{};
  std::vector<float> uniforms;
  const auto pass = [&](const rg::RenderTarget& dest, double mode, double dirX, double dirY, double amount, double a, double b,
                        const rg::TexRef& in, const rg::TexRef& texB, const rg::TexRef& texC) {
    rg::DrawItem item;
    item.material = rg::Mat::SUBJECT_EDGE_MATERIAL;
    item.texture = in;
    item.sampler = nearest;
    item.mask = texB ? texB : in;
    item.origin = texC ? texC : in;
    rg::Packer pk(uniforms, plain);
    pk.mat3(rg::screen_mvp()).rect({0, 0, 1, 1}).vec4(mode, dirX, dirY, amount).vec4(1.0 / w, 1.0 / h, a, b);
    dev_->side_draw(dest.view, dest.format, dest.width, dest.height, item, uniforms);
  };
  // The frames' alpha planes as R8 textures (kept alive while they are read).
  std::vector<std::shared_ptr<const RasterEntry>> keep;
  const auto frameTex = [&](const std::string& frameHash) -> rg::TexRef {
    if (frameHash.empty()) return {};
    std::shared_ptr<const RasterEntry> e = find(frameHash);
    if (!e || e->alpha.empty()) return {};
    rg::TexRef t = dev_->texture(frameHash, e->width, e->height, wgpu::TextureFormat::R8Unorm, std::span<const std::uint8_t>(e->alpha), false);
    keep.push_back(std::move(e));
    return t;
  };
  constexpr double kMix = 0, kGauss = 1, kErode = 2, kDilate = 3, kFinish = 4;
  // Two R8 scratches for the separable passes (a pass never reads the target it writes: the
  // destination is whichever one the input is not), two RGBA scratches for the union so far.
  const rg::RenderTarget& r0 = scratch("subject-edge-r0", wgpu::TextureFormat::R8Unorm);
  const rg::RenderTarget& r1 = scratch("subject-edge-r1", wgpu::TextureFormat::R8Unorm);
  const std::array<const rg::RenderTarget*, 2> unions = {&scratch("subject-edge-u0", wgpu::TextureFormat::RGBA8Unorm),
                                                         &scratch("subject-edge-u1", wgpu::TextureFormat::RGBA8Unorm)};
  const auto other = [&](const rg::TexRef& in) -> const rg::RenderTarget& { return in.id == r0.id ? r1 : r0; };
  std::size_t shown = 0;
  for (const SubjectGpuPart& gp : gs.parts)
    if (!gp.hidden && !gp.frame.empty()) ++shown;
  std::size_t done = 0;
  const rg::RenderTarget* prev = nullptr;  // the union of the subjects finished so far
  for (const SubjectGpuPart& gp : gs.parts) {
    if (gp.hidden || gp.frame.empty()) continue;
    rg::TexRef cur = frameTex(gp.frame);
    if (!cur) {
      --shown;
      continue;
    }
    ++done;
    // Temporal Smooth: the frame with its neighbours (the frame keeps 1 − Σ weights).
    if (!gp.blend.empty()) {
      const rg::TexRef nb0 = frameTex(gp.blend[0].first);
      const rg::TexRef nb1 = gp.blend.size() > 1 ? frameTex(gp.blend[1].first) : rg::TexRef{};
      const double wa = nb0 ? gp.blend[0].second : 0.0;
      const double wb = nb1 ? gp.blend[1].second : 0.0;
      pass(r0, kMix, 0, 0, 0, wa, wb, cur, nb0 ? nb0 : cur, nb1 ? nb1 : cur);
      cur = r0.tex();
    }
    // The live edge: each pass of the plan along x, then along y (subject_matte.cpp run_pass).
    for (const subject_matte::EdgePass& ep : subject_matte::edge_plan(gp.feather, gp.choke)) {
      const double mode = ep.kind == subject_matte::EdgePass::Kind::gauss ? kGauss : ep.kind == subject_matte::EdgePass::Kind::erode ? kErode : kDilate;
      const rg::RenderTarget& x = other(cur);
      pass(x, mode, 1, 0, ep.amount, 0, 0, cur, {}, {});
      const rg::RenderTarget& y = other(x.tex());
      pass(y, mode, 0, 1, ep.amount, 0, 0, x.tex(), {}, {});
      cur = y.tex();
    }
    // Contrast, invert, the union with the subjects so far (p0.y: read texB) — the last subject
    // straight into the result, the others into the union scratch the previous one did not use.
    const bool last = done >= shown;
    const rg::RenderTarget& dest = last ? out : *unions[done % 2];
    pass(dest, kFinish, prev != nullptr ? 1 : 0, 0, 0, gp.contrast, gp.invert ? 1 : 0, cur, prev != nullptr ? prev->tex() : cur, {});
    prev = &dest;
  }
  if (prev == nullptr) {
    // Every subject hidden, or no frame decoded: a transparent matte of the spec's size (p0.z: clear).
    pass(out, kFinish, 0, 1, 0, 0, 0, r0.tex(), {}, {});
  } else if (prev != &out) {
    // The last subject's frame did not decode after earlier ones were united into a scratch: the
    // union so far is the result (a FINISH with a neutral curve copies (a, a, a, a) through).
    pass(out, kFinish, 0, 0, 0, 0, 0, prev->tex(), {}, {});
  }
  return out.tex();
}

std::string SceneTextures::media_ref(const TextureRequest& r, PrepareStats& stats,
                                     std::optional<api::RenderColorSpace>& space) {
  // Still footage decodes to sRGB-encoded RGBA8 (PNG / JPEG / WebP without a profile).
  space = api::RenderColorSpace::srgb;
  if (r.colorProfile) space = *r.colorProfile;
  if (r.src.empty()) return {};
  // A subject matte (stream B1): the stored alpha planes combined as read — one plain subject
  // too, since its file is coverage alone and the consumers read (a, a, a, a). Data, not colour:
  // untagged, so colour management leaves it be.
  if (!r.subjectParts.empty()) {
    space.reset();
    return subject_ref(r, stats);
  }
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
  std::filesystem::path p = file_url_fs_path(r.src);
  if (p.is_relative() && !opts_.mediaBase.empty()) p = opts_.mediaBase / p;
  // An animated GIF / WebP imported as footage that moves (the probe's `video`)
  // is decoded frame by frame like any video; as a still, its first frame.
  // P7b: an extension a native plugin importer claims is read by the plugin (still or moving).
  if (const std::u8string ext = p.extension().u8string(); !ext.empty() && doc::NativeImporters::claims(std::string(ext.begin(), ext.end()))) return r.video ? plugin_image_ref(r, p, stats) : baked_still(plugin_image_ref(r, p, stats));
  if (is_still_image_path(p) && !r.video) return baked_still(image_ref(r, p, stats));
#if defined(PREMATION_HAVE_MEDIA)
  if (media_ == nullptr) return {};
  // A SourceId stays valid for the MediaSystem's lifetime, but its decoder may
  // be closed for the decoder-pool cap at any time (media_system.hpp). Nothing
  // here needs it open: index() / info() come from the probe, and the frame is
  // requested through MediaTextures, whose miss re-opens the source and draws
  // a stand-in until the frame settles (render_thread's retry).
  std::string error;
  std::optional<std::uint32_t> sid = open_media(utf8_path(p.lexically_normal()), error);
  if (!r.fallbackSrc.empty()) {
    // Use Proxies: `p` is the item's proxy. One that does not open, or holds no
    // video, is dropped for the original behind it (said — never a blank
    // layer). Its own source id makes every hash of its frames its own, so
    // proxy and original frames never share a converted texture or a bake.
    // (The strings below are built on this failure path only.)
    media::MediaInfo proxyInfo;
    if (sid && !(media_->info(*sid, proxyInfo) && proxyInfo.video)) {
      sid.reset();
      error = "no video stream";
    }
    if (!sid) {
      stats.unsupported.emplace_back(r.key, "proxy did not open (" + error + "); drawn from the original");
      std::filesystem::path original = file_url_fs_path(r.fallbackSrc);
      if (original.is_relative() && !opts_.mediaBase.empty()) original = opts_.mediaBase / original;
      error.clear();
      sid = open_media(utf8_path(original.lexically_normal()), error);
    }
  }
  if (!sid) {
    stats.unsupported.emplace_back(r.key, "footage did not open: " + error);
    return {};
  }
  const std::uint32_t id = *sid;
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
  }
  // Interpret Footage > Color > Assign Profile: the user's choice over the file's tags.
  if (r.colorProfile) space = *r.colorProfile;
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
std::optional<std::uint32_t> SceneTextures::open_media(const std::string& key, std::string& error) {
  // A source opens once per path; a path that failed stays failed (no re-probe per frame).
  if (const auto it = sources_.find(key); it != sources_.end()) return it->second;
  if (const auto oe = openErrors_.find(key); oe != openErrors_.end()) {
    error = oe->second;
    return std::nullopt;
  }
  const auto sid = media_->open(key, error);
  if (!sid) {
    openErrors_.emplace(key, error);
    return std::nullopt;
  }
  sources_.emplace(key, *sid);
  return *sid;
}

namespace {

float half_bits_to_float(std::uint16_t half) noexcept {
  const std::uint32_t h = half;  // unsigned before any shift (a uint16_t promotes to int)
  const std::uint32_t sign = (h & 0x8000U) << 16U;
  const std::uint32_t exp = (h >> 10U) & 0x1FU;
  std::uint32_t mant = h & 0x3FFU;
  std::uint32_t bits = 0;
  if (exp == 0) {
    if (mant == 0) {
      bits = sign;
    } else {  // subnormal: normalise
      int e = 0;
      mant <<= 1U;
      while ((mant & 0x400U) == 0) {
        ++e;
        mant <<= 1U;
      }
      bits = sign | (static_cast<std::uint32_t>(127 - 15 - e) << 23U) | ((mant & 0x3FFU) << 13U);
    }
  } else if (exp == 31) {
    bits = sign | 0x7F800000U | (mant << 13U);
  } else {
    bits = sign | ((exp + (127 - 15)) << 23U) | (mant << 13U);
  }
  return std::bit_cast<float>(bits);
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
  std::string nearest = media::media_hash(id, near.index, near.bottom, r.fields);  // not const: returned by move
  if (a.index == b.index || a.bottom || b.bottom || dev_ == nullptr || mediaFrames_ == nullptr) return nearest;
  std::array<char, 96> sig{};
  std::snprintf(sig.data(), sig.size(), "img:pm2:%u:%lld:%lld:%.4f:%c", id, static_cast<long long>(a.index),  // NOLINT(cppcoreguidelines-pro-type-vararg)
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
  // bracket reuses it), estimated both ways on a ≤ 512 px pyramid; the
  // in-between is resolved per weight at full resolution (pixel_motion.hpp
  // interpolate_pair). Render thread only; rows split on the bake pool when
  // no bake holds it (as bake_chain.cpp borrows it), else inline — same bytes.
  const pixmo::RowRunner rows = [this](int n, const std::function<void(int, int)>& fn) {
    const std::unique_lock<std::mutex> lock(bakePoolM_, std::try_to_lock);
    effects::for_rows(lock.owns_lock() ? bakePool_.get() : nullptr, n, fn, 4);
  };
  const std::string pairKey = std::to_string(id) + "|" + std::to_string(a.index) + "|" + std::to_string(b.index);
  auto flowIt = std::ranges::find(flows_, pairKey, &FlowEntry::key);
  if (flowIt == flows_.end()) {
    FlowEntry fe;
    fe.key = pairKey;
    fe.flow = pixmo::estimate_pair_flow(pa, pb, w, h, pixmo::kPairFlowMaxDim, rows);
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
  pixmo::interpolate_pair(pa, pb, w, h, flowIt->flow, t, e->rgba, rows);
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
  // Not const: returned by move.
  std::string hash = "img:bake:" + hex64(hash_json(r.spec, fnv1a(dims.data(), fnv1a(baseHash))));
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
    std::filesystem::path p = file_url_fs_path(r.src);
    if (p.is_relative() && !opts_.mediaBase.empty()) p = opts_.mediaBase / p;
    const std::u8string u8 = p.lexically_normal().u8string();
    path.assign(u8.begin(), u8.end());
    const FileStamp st = file_stamp(p);
    std::array<char, 48> tail{};
    std::snprintf(tail.data(), tail.size(), "|%llu|%llu", static_cast<unsigned long long>(st.size),  // NOLINT(cppcoreguidelines-pro-type-vararg)
                  static_cast<unsigned long long>(st.modified));
    h = fnv1a(tail.data(), fnv1a(path, h));
  }
  const std::string doc = "img:svg:" + hex64(h);
  if (const auto oe = openErrors_.find(doc); oe != openErrors_.end()) {
    stats.unsupported.emplace_back(r.key, "SVG did not render: " + oe->second);
    return {};
  }
  // An animated SVG (SMIL / CSS) is drawn at the layer's source time, sampled
  // 60 times a second, each sample its own entry; a static one is one entry.
  const long long frame = std::llround(std::max(0.0, r.sourceTime) * kSvgSamplesPerSecond);
  const double time = static_cast<double>(frame) / kSvgSamplesPerSecond;
  // E4: at the displayed size, one entry per (document, time, display step).
  const int step = r.svgDisplayLong > 0 ? svg_step_for(r) : 0;
  const double targetLong = step > 0 ? svg_step_long(step) : 0;
  const auto keyFor = [&doc, frame](bool animated, int s) {
    std::string k = animated ? doc + "@" + std::to_string(frame) : doc;
    if (s > 0) k += "#s" + std::to_string(s);
    return k;
  };
  const auto report_hit = [&](const std::shared_ptr<const RasterEntry>& hit) {
    for (const std::string& u : hit->unsupported) stats.unsupported.emplace_back(r.key, "SVG: " + u);
  };
  const auto known = svgAnimated_.find(doc);
  if (known != svgAnimated_.end()) {
    const std::string key = keyFor(known->second, step);
    if (const std::shared_ptr<const RasterEntry> hit = find(key)) {
      if (!hit->error.empty()) {  // the worker's failed step
        stats.unsupported.emplace_back(r.key, "SVG did not render: " + hit->error);
        return {};
      }
      ++stats.rasterHits;
      report_hit(hit);
      if (step > 0 && !known->second) svg_drop_below(doc, step);  // the exact step is in: the stand-ins below it go
      return key;
    }
    if (step > 0 && !known->second && !exact_) {
      // The viewport. A static document keeps ONE raster: the largest step
      // asked for so far (frame_build caps the need at the comp's displayed
      // size). A larger cached step serves a smaller need outright — the 3D
      // sampler minifies it through its mips — so a camera pulling back never
      // re-rasters, and the cache holds one raster per document, not one per
      // step. Only growth rasterises: the exact step goes to the worker, the
      // largest cached step (or a quick preview) draws meanwhile, and the
      // frame is not final until the exact step is in.
      for (int s = kSvgMaxStep; s > step; --s) {
        const std::string bigger = keyFor(false, s);
        if (const std::shared_ptr<const RasterEntry> hit = find(bigger); hit && hit->error.empty()) {
          ++stats.rasterHits;
          report_hit(hit);
          return bigger;
        }
      }
      svg_enqueue(SvgJob{key, r.src, r.fill, path, time, targetLong});
      ++stats.svgAsync;
      svgStandIn_ = true;
      for (int s = step - 1; s >= kSvgMinStep; --s) {
        const std::string smaller = keyFor(false, s);
        if (const std::shared_ptr<const RasterEntry> hit = find(smaller); hit && hit->error.empty()) {
          ++stats.rasterHits;
          report_hit(hit);
          return smaller;
        }
      }
      // Nothing of this document is cached: a preview step draws now (cheap), the exact step follows.
      const int previewStep = std::min(step, kSvgPreviewStep);
      const std::string previewKey = keyFor(false, previewStep);
      const auto tp = std::chrono::steady_clock::now();
      raster::RasterOutput pv = rasterize_svg_src(r.src, r.fill, path, time, svg_step_long(previewStep));
      stats.rasterMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - tp).count();
      ++stats.rasterMisses;
      if (!pv.ok) {
        openErrors_.emplace(doc, pv.error);
        stats.unsupported.emplace_back(r.key, "SVG did not render: " + pv.error);
        return {};
      }
      for (const std::string& u : pv.unsupported) stats.unsupported.emplace_back(r.key, "SVG: " + u);
      auto pe = std::make_shared<RasterEntry>();
      pe->width = pv.width;
      pe->height = pv.height;
      pe->rgba = std::move(pv.rgba);
      pe->unsupported = std::move(pv.unsupported);
      insert(previewKey, std::move(pe));
      return previewKey;
    }
  }
  // A document never seen (or an animated one, or exact mode): drawn now. In
  // the viewport a first sight draws the preview step (cheap, no spike) and
  // the exact step follows on the worker once the document is known static.
  const int syncStep = step > 0 && !exact_ && known == svgAnimated_.end() ? std::min(step, kSvgPreviewStep) : step;
  const auto t0 = std::chrono::steady_clock::now();
  raster::RasterOutput out = rasterize_svg_src(r.src, r.fill, path, time, syncStep > 0 ? svg_step_long(syncStep) : 0);
  stats.rasterMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  ++stats.rasterMisses;
  if (!out.ok) {
    openErrors_.emplace(doc, out.error);
    stats.unsupported.emplace_back(r.key, "SVG did not render: " + out.error);
    return {};
  }
  svgAnimated_[doc] = out.animated;
  for (const std::string& u : out.unsupported) stats.unsupported.emplace_back(r.key, "SVG: " + u);
  auto e = std::make_shared<RasterEntry>();
  e->width = out.width;
  e->height = out.height;
  e->rgba = std::move(out.rgba);
  e->unsupported = std::move(out.unsupported);
  std::string key = keyFor(out.animated, syncStep);
  insert(key, std::move(e));
  if (syncStep != step && !out.animated) {
    svg_enqueue(SvgJob{keyFor(false, step), r.src, r.fill, path, time, targetLong});
    ++stats.svgAsync;
    svgStandIn_ = true;
  } else if (syncStep > 0 && !out.animated) {
    svg_drop_below(doc, syncStep);
  }
  return key;
}

void SceneTextures::svg_drop_below(const std::string& doc, int step) {
  const std::scoped_lock lock(m_);
  for (int s = kSvgMinStep; s < step; ++s) {
    const auto it = byHash_.find(doc + "#s" + std::to_string(s));
    if (it == byHash_.end()) continue;
    // Another layer showing the same document smaller drew from this step in
    // the frame being prepared: dropping it would blank that layer. It goes
    // once a frame passes without it (or is evicted as any raster is).
    if (it->second->lastUse == frame_) continue;
    bytes_ -= it->second->entry->bytes();
    lru_.erase(it->second);
    byHash_.erase(it);
  }
}

int SceneTextures::svg_step_for(const TextureRequest& r) {
  // The step whose size covers the need (√2 apart), within the device's 2D limit.
  const double limit = std::min(raster::svg::kSvgRasterMax, dev_ != nullptr ? dev_->max_texture_dimension() : texture_dimension_limit());
  int maxStep = kSvgMaxStep;
  while (maxStep > kSvgMinStep && svg_step_long(maxStep) > limit) --maxStep;
  const double need = std::max(1.0, r.svgDisplayLong);
  int step = static_cast<int>(std::ceil(2.0 * std::log2(need)));
  step = std::clamp(step, kSvgMinStep, maxStep);
  if (playing_ && !exact_) {
    // Playback hysteresis: the last step serves while it still covers the need
    // and is not more than 2× oversampled — a scale animation re-rasters at
    // step boundaries only, not once per frame.
    if (const auto last = svgLastStep_.find(r.key); last != svgLastStep_.end()) {
      const double have = svg_step_long(last->second);
      if (have >= need && have <= 2 * need && last->second <= maxStep) step = last->second;
    }
  }
  svgLastStep_[r.key] = step;
  return step;
}

}  // namespace premation::scene