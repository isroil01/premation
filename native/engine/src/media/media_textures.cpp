#include "media_textures.hpp"

#include <charconv>

namespace premation::media {

namespace {
constexpr std::string_view kPrefix = "media:";
constexpr std::uint64_t kIdBit = std::uint64_t{1} << 63U;  // never collides with rg::Device ids

bool parse_int(std::string_view s, std::int64_t& out) noexcept {
  if (s.empty()) return false;
  const char* begin = s.data();  // NOLINT(bugprone-suspicious-stringview-data-usage): from_chars takes [begin, end), no terminator needed
  const char* end = begin + s.size();  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  const auto r = std::from_chars(begin, end, out);
  return r.ec == std::errc{} && r.ptr == end;
}
}  // namespace

std::string media_hash(SourceId source, std::int64_t frame) {
  return std::string(kPrefix) + std::to_string(source) + ':' + std::to_string(frame);
}

std::string media_hash(SourceId source, std::int64_t top, std::int64_t bottom) {
  return media_hash(source, top) + '~' + std::to_string(bottom);
}

std::optional<MediaKey> parse_media_hash(std::string_view hash) noexcept {
  if (!hash.starts_with(kPrefix)) return std::nullopt;
  hash.remove_prefix(kPrefix.size());
  const auto colon = hash.find(':');
  if (colon == std::string_view::npos) return std::nullopt;
  std::int64_t src = 0;
  if (!parse_int(hash.substr(0, colon), src) || src <= 0 || src > 0xFFFFFFFFLL) return std::nullopt;
  std::string_view rest = hash.substr(colon + 1);
  MediaKey k;
  k.source = static_cast<SourceId>(src);
  const auto tilde = rest.find('~');
  if (tilde != std::string_view::npos) {
    if (!parse_int(rest.substr(tilde + 1), k.bottom) || k.bottom < 0) return std::nullopt;
    rest = rest.substr(0, tilde);
  }
  if (!parse_int(rest, k.frame) || k.frame < 0) return std::nullopt;
  return k;
}

MediaTextures::MediaTextures(MediaSystem& media, wgpu::Device device, Mode mode)
    : media_(media), converter_(std::move(device)), mode_(mode) {}

MediaTextures::~MediaTextures() = default;

void MediaTextures::set_alpha(SourceId source, AlphaMode alpha) { alpha_[source] = alpha; }

MediaTextures::Misses MediaTextures::take_misses() noexcept {
  const Misses m = misses_;
  misses_ = {};
  return m;
}

FramePtr MediaTextures::frame_for(SourceId src, std::int64_t frame, bool& exact) {
  exact = true;
  if (mode_ == Mode::exact) return media_.wait(src, frame, Lane::exact, timeout_);
  if (FramePtr f = media_.request(src, frame, Lane::latest)) return f;
  exact = false;
  return media_.nearest(src, frame);
}

bool MediaTextures::convert_into(Entry& e, const DecodedFrame& f, SourceId src, std::string& error) {
  const auto a = alpha_.find(src);
  const AlphaMode alpha = a == alpha_.end() ? AlphaMode::straight : a->second;
  ConvertedFrame fresh;
  if (!converter_.convert(f, alpha, fresh, error)) return false;
  if (e.tex.texture != nullptr) converter_.recycle(std::move(e.tex));
  e.tex = std::move(fresh);
  e.id = kIdBit | nextId_++;
  return true;
}

void MediaTextures::touch(std::list<Entry>::iterator it) { lru_.splice(lru_.begin(), lru_, it); }

void MediaTextures::trim() {
  while (lru_.size() > capacity_) {
    Entry& last = lru_.back();
    converter_.recycle(std::move(last.tex));
    byHash_.erase(last.hash);
    lru_.pop_back();
  }
}

rg::TexRef MediaTextures::external_texture(std::string_view hash) {
  const auto key = parse_media_hash(hash);
  if (!key) return {};
  auto it = byHash_.find(hash);
  if (it != byHash_.end() && it->second->exact) {
    touch(it->second);
    const Entry& e = *it->second;
    return {e.tex.view, e.id, e.tex.width, e.tex.height, false};
  }

  bool exactA = true;
  const FramePtr a = frame_for(key->source, key->frame, exactA);
  FramePtr b;
  bool exactB = true;
  if (key->bottom >= 0) b = frame_for(key->source, key->bottom, exactB);
  if (!a) {
    ++misses_.skipped;
    return {};
  }
  const bool exact = exactA && (key->bottom < 0 || (b && exactB));
  if (it != byHash_.end() && it->second->heldFrame == a->index && !exact) {
    // Same stand-in as last time: nothing new to convert.
    ++misses_.approximate;
    touch(it->second);
    const Entry& e = *it->second;
    return {e.tex.view, e.id, e.tex.width, e.tex.height, false};
  }
  if (it == byHash_.end()) {
    lru_.push_front(Entry{std::string(hash), {}, 0, -1, false});
    it = byHash_.emplace(lru_.front().hash, lru_.begin()).first;
  } else {
    touch(it->second);
  }
  Entry& e = *it->second;
  std::string error;
  bool ok = convert_into(e, *a, key->source, error);
  if (ok && key->bottom >= 0 && b) {
    Entry bottom{{}, {}, 0, -1, false};
    ok = convert_into(bottom, *b, key->source, error);
    ConvertedFrame woven;
    if (ok && converter_.weave(e.tex, bottom.tex, woven, error)) {
      converter_.recycle(std::move(e.tex));
      e.tex = std::move(woven);
      e.id = kIdBit | nextId_++;
    }
    converter_.recycle(std::move(bottom.tex));
  }
  if (!ok) {
    ++misses_.skipped;
    const auto node = it->second;
    converter_.recycle(std::move(e.tex));
    byHash_.erase(it);
    lru_.erase(node);
    return {};
  }
  e.heldFrame = a->index;
  e.exact = exact;
  if (!exact) ++misses_.approximate;
  const rg::TexRef out{e.tex.view, e.id, e.tex.width, e.tex.height, false};
  trim();
  return out;
}

}  // namespace premation::media
