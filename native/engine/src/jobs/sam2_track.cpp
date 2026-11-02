#include "sam2_track.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <sstream>
#include <system_error>

#include "json.hpp"

namespace premation::jobs::sam2 {

namespace {

std::filesystem::path u8path(const std::string& s) { return std::filesystem::path(std::u8string(s.begin(), s.end())); }

double ms_since(std::chrono::steady_clock::time_point t0) {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
}

/// Bilinear sample of a single-channel plane at continuous (x, y), clamped at the edges.
float sample(std::span<const float> plane, int w, int h, double x, double y) {
  x = std::clamp(x, 0.0, static_cast<double>(w - 1));
  y = std::clamp(y, 0.0, static_cast<double>(h - 1));
  const int x0 = static_cast<int>(x);
  const int y0 = static_cast<int>(y);
  const int x1 = std::min(x0 + 1, w - 1);
  const int y1 = std::min(y0 + 1, h - 1);
  const auto fx = static_cast<float>(x - x0);
  const auto fy = static_cast<float>(y - y0);
  const auto at = [&](int xx, int yy) { return plane[static_cast<std::size_t>(yy) * static_cast<std::size_t>(w) + static_cast<std::size_t>(xx)]; };
  const float top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * fx;
  const float bot = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * fx;
  return top + (bot - top) * fy;
}

}  // namespace

std::optional<Constants> parse_constants(std::string_view json, std::string& error) {
  const std::optional<js::Json> j = js::parse(json);
  if (!j || !j->is_object()) {
    error = "constants.json is not a JSON object";
    return std::nullopt;
  }
  Constants c;
  const js::Json& t = j->at("memory_temporal_positional_encoding");
  if (!t.is_array() || t.arr().size() != kMaskMem) {
    error = "constants.json: memory_temporal_positional_encoding is not 7 rows";
    return std::nullopt;
  }
  for (std::size_t r = 0; r < kMaskMem; ++r) {
    const js::Json& row = t.arr()[r];
    if (!row.is_array() || row.arr().size() != kMemDim) {
      error = "constants.json: a temporal position row is not 64 wide";
      return std::nullopt;
    }
    for (std::size_t k = 0; k < kMemDim; ++k) c.tpos[r * kMemDim + k] = static_cast<float>(row.arr()[k].num());
  }
  const auto triple = [&](std::string_view key, std::array<float, 3>& out) {
    const js::Json& a = j->at(key);
    if (!a.is_array() || a.arr().size() != 3) return;
    for (std::size_t k = 0; k < 3; ++k) out[k] = static_cast<float>(a.arr()[k].num());
  };
  triple("image_mean", c.mean);
  triple("image_std", c.stdev);
  for (const char* key : {"image_size", "feat_size", "mem_dim", "num_maskmem", "max_object_pointers"}) {
    const js::Json& v = j->at(key);
    const double want = std::string_view(key) == "image_size" ? kInput
                        : std::string_view(key) == "feat_size" ? kFeat
                        : std::string_view(key) == "mem_dim"   ? static_cast<double>(kMemDim)
                        : std::string_view(key) == "num_maskmem" ? static_cast<double>(kMaskMem)
                                                                 : static_cast<double>(kMaxPointers);
    if (v.is_number() && v.num() != want) {
      error = std::string("constants.json: ") + key + " is not the export this tracker drives";
      return std::nullopt;
    }
  }
  return c;
}

void preprocess(std::span<const std::uint8_t> rgba, std::uint32_t width, std::uint32_t height, const Constants& c,
                std::vector<float>& out) {
  const std::size_t plane = kHighRes;
  out.assign(3 * plane, 0.0F);
  if (width == 0 || height == 0 || rgba.size() < std::size_t{width} * height * 4) return;
  const double sx = static_cast<double>(width) / kInput;
  const double sy = static_cast<double>(height) / kInput;
  // Precomputed column taps: the same for every row (no per-pixel division).
  std::vector<std::uint32_t> cx0(kInput), cx1(kInput);
  std::vector<float> cfx(kInput);
  for (int x = 0; x < kInput; ++x) {
    const double fx = std::clamp((x + 0.5) * sx - 0.5, 0.0, static_cast<double>(width - 1));
    const auto ix = static_cast<std::uint32_t>(fx);
    cx0[static_cast<std::size_t>(x)] = ix;
    cx1[static_cast<std::size_t>(x)] = std::min(ix + 1, width - 1);
    cfx[static_cast<std::size_t>(x)] = static_cast<float>(fx - ix);
  }
  std::array<float, 3> scale{};
  std::array<float, 3> bias{};
  for (std::size_t k = 0; k < 3; ++k) {
    scale[k] = 1.0F / (255.0F * c.stdev[k]);
    bias[k] = -c.mean[k] / c.stdev[k];
  }
  for (int y = 0; y < kInput; ++y) {
    const double fy = std::clamp((y + 0.5) * sy - 0.5, 0.0, static_cast<double>(height - 1));
    const auto y0 = static_cast<std::uint32_t>(fy);
    const std::uint32_t y1 = std::min(y0 + 1, height - 1);
    const auto wy = static_cast<float>(fy - y0);
    const std::uint8_t* r0 = rgba.data() + std::size_t{y0} * width * 4;
    const std::uint8_t* r1 = rgba.data() + std::size_t{y1} * width * 4;
    for (int x = 0; x < kInput; ++x) {
      const std::size_t xi = static_cast<std::size_t>(x);
      const std::size_t a = std::size_t{cx0[xi]} * 4;
      const std::size_t b = std::size_t{cx1[xi]} * 4;
      const float wx = cfx[xi];
      const std::size_t o = static_cast<std::size_t>(y) * kInput + xi;
      for (std::size_t k = 0; k < 3; ++k) {
        const float top = static_cast<float>(r0[a + k]) + (static_cast<float>(r0[b + k]) - static_cast<float>(r0[a + k])) * wx;
        const float bot = static_cast<float>(r1[a + k]) + (static_cast<float>(r1[b + k]) - static_cast<float>(r1[a + k])) * wx;
        out[k * plane + o] = (top + (bot - top) * wy) * scale[k] + bias[k];
      }
    }
  }
}

void to_tokens(std::span<const float> nchw, std::size_t channels, std::vector<float>& out) {
  out.resize(kTokens * channels);
  for (std::size_t ch = 0; ch < channels; ++ch)
    for (std::size_t t = 0; t < kTokens; ++t) out[t * channels + ch] = nchw[ch * kTokens + t];
}

void logits_to_alpha(std::span<const float> logits, std::uint32_t width, std::uint32_t height, std::vector<float>& out) {
  out.assign(std::size_t{width} * height, 0.0F);
  if (logits.size() < kHighRes || width == 0 || height == 0) return;
  const double sx = static_cast<double>(kInput) / width;
  const double sy = static_cast<double>(kInput) / height;
  for (std::uint32_t y = 0; y < height; ++y)
    for (std::uint32_t x = 0; x < width; ++x) {
      const float l = sample(logits, kInput, kInput, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5);
      out[std::size_t{y} * width + x] = 1.0F / (1.0F + std::exp(-l));
    }
}

void MemoryBank::add(std::int64_t step, Memory mem, std::vector<float> pointer, bool conditioning) {
  Entry e{step, std::move(mem), std::move(pointer)};
  if (conditioning) {
    cond_.push_back(std::move(e));
    return;
  }
  pointers_.push_back(Entry{step, Memory{}, e.pointer});
  while (pointers_.size() > kMaxPointers - 1) pointers_.pop_front();
  recent_.push_back(std::move(e));
  while (recent_.size() > kRecentMemories) recent_.pop_front();
}

bool MemoryBank::assemble(std::int64_t step, const Constants& c, Assembled& out) const {
  if (empty()) return false;
  const std::size_t block = kTokens * kMemDim;
  out.memory.resize(kMemoryTokens * kMemDim);
  out.memoryPos.resize(kMemoryTokens * kMemDim);
  out.pointerDiffs.assign(kMaxPointers, 0.0F);

  // Conditioning frames closest to this step first (SAM 2 select_closest_cond_frames).
  std::vector<const Entry*> conds;
  conds.reserve(cond_.size());
  for (const Entry& e : cond_) conds.push_back(&e);
  std::stable_sort(conds.begin(), conds.end(), [&](const Entry* a, const Entry* b) {
    return std::llabs(step - a->step) < std::llabs(step - b->step);
  });

  std::size_t n = 0;
  const auto put = [&](const Entry& e, std::size_t row) {
    std::copy(e.mem.tokens.begin(), e.mem.tokens.end(), out.memory.begin() + static_cast<std::ptrdiff_t>(n * block));
    float* pos = out.memoryPos.data() + n * block;
    const float* tp = c.tpos.data() + row * kMemDim;
    for (std::size_t t = 0; t < kTokens; ++t)
      for (std::size_t k = 0; k < kMemDim; ++k) pos[t * kMemDim + k] = e.mem.pos[t * kMemDim + k] + tp[k];
    out.blockFrame[n] = e.step;
    out.blockRow[n] = static_cast<int>(row);
    ++n;
  };
  for (std::size_t i = 0; i < conds.size() && i < kMaxCondInAttention && n < kMaskMem; ++i) put(*conds[i], kMaskMem - 1);
  // Recent memories, newest first, each on the row of how far back it is.
  for (auto it = recent_.rbegin(); it != recent_.rend() && n < kMaskMem; ++it) {
    const std::int64_t back = std::clamp<std::int64_t>(step - it->step, 1, static_cast<std::int64_t>(kRecentMemories));
    put(*it, static_cast<std::size_t>(back - 1));
  }
  // The graph takes exactly seven blocks: repeat the last.
  for (; n < kMaskMem; ++n) {
    std::copy_n(out.memory.begin() + static_cast<std::ptrdiff_t>((n - 1) * block), block, out.memory.begin() + static_cast<std::ptrdiff_t>(n * block));
    std::copy_n(out.memoryPos.begin() + static_cast<std::ptrdiff_t>((n - 1) * block), block, out.memoryPos.begin() + static_cast<std::ptrdiff_t>(n * block));
    out.blockFrame[n] = out.blockFrame[n - 1];
    out.blockRow[n] = out.blockRow[n - 1];
  }

  // Object pointers: conditioning frames (closest first), then the recent ones newest first.
  std::vector<std::pair<const std::vector<float>*, std::int64_t>> ptrs;
  for (const Entry* e : conds) {
    if (ptrs.size() >= kMaxPointers) break;
    ptrs.emplace_back(&e->pointer, e->step);
  }
  for (auto it = pointers_.rbegin(); it != pointers_.rend() && ptrs.size() < kMaxPointers; ++it) ptrs.emplace_back(&it->pointer, it->step);
  const double norm = static_cast<double>(std::max<std::size_t>(1, std::min(frameCount_, kMaxPointers) - 1));
  float* ptrTokens = out.memory.data() + kMaskMem * block;
  for (std::size_t p = 0; p < kMaxPointers; ++p) {
    const std::size_t src = std::min(p, ptrs.size() - 1);
    const std::vector<float>& v = *ptrs[src].first;
    // [256] → 4 consecutive tokens of 64 (SAM 2's reshape(-1, B, C/64, 64).permute.flatten).
    std::copy_n(v.begin(), kHidden, ptrTokens + p * kHidden);
    out.pointerDiffs[p] = static_cast<float>(static_cast<double>(std::llabs(step - ptrs[src].second)) / norm);
    out.pointerFrame[p] = ptrs[src].second;
  }
  return true;
}

void MemoryBank::place_pointer_pos(std::span<const float> pointerPos, Assembled& out) {
  float* pos = out.memoryPos.data() + kMaskMem * kTokens * kMemDim;
  for (std::size_t p = 0; p < kMaxPointers; ++p)
    for (std::size_t s = 0; s < kPointerSplit; ++s)
      std::copy_n(pointerPos.begin() + static_cast<std::ptrdiff_t>(p * kMemDim), kMemDim, pos + (p * kPointerSplit + s) * kMemDim);
}

bool Tracker::step(std::span<const std::uint8_t> rgba, std::uint32_t width, std::uint32_t height, std::span<const Prompt> prompts,
                   FrameResult& out, std::string& error, std::span<const float> mask) {
  if (width == 0 || height == 0) {
    error = "empty frame";
    return false;
  }
  const bool given = !mask.empty();
  if (given && mask.size() != static_cast<std::size_t>(width) * height) {
    error = "the mask is not the frame's size";
    return false;
  }
  const bool first = bank_.empty();
  if (first && prompts.empty() && !given) {
    error = "the first frame needs a prompt";
    return false;
  }
  auto t0 = std::chrono::steady_clock::now();
  preprocess(rgba, width, height, constants_, pixels_);
  if (!models_.encode(pixels_, vision_, error)) return false;
  out.encodeMs = ms_since(t0);

  t0 = std::chrono::steady_clock::now();
  std::span<const float> cond = vision_.feats2NoMem;
  if (!first) {
    bank_.assemble(step_, constants_, assembled_);
    if (!models_.pointer_pos(assembled_.pointerDiffs, pointerPos_, error)) return false;
    if (pointerPos_.size() != kMaxPointers * kMemDim) {
      error = "pointer_tpos answered the wrong shape";
      return false;
    }
    MemoryBank::place_pointer_pos(pointerPos_, assembled_);
    to_tokens(vision_.feats2, kHidden, tokens_);
    to_tokens(vision_.pos, kHidden, posTokens_);
    if (!models_.attend(tokens_, posTokens_, assembled_.memory, assembled_.memoryPos, conditioned_, error)) return false;
    cond = conditioned_;
  }
  out.attendMs = ms_since(t0);

  t0 = std::chrono::steady_clock::now();
  std::vector<float> pts;
  std::vector<std::int32_t> labels;
  for (const Prompt& p : prompts) {
    pts.push_back(static_cast<float>(p.x * kInput / width));
    pts.push_back(static_cast<float>(p.y * kInput / height));
    labels.push_back(p.label);
  }
  if (labels.empty()) {  // a tracked frame: SAM 2's single padding point
    pts = {0.0F, 0.0F};
    labels = {-1};
  }
  Decoded dec;
  if (!models_.decode(vision_, cond, pts, labels, dec, error)) return false;
  if (dec.highRes.size() != kHighRes || dec.pointer.size() != kHidden) {
    error = "mask_decoder answered the wrong shapes";
    return false;
  }
  out.decodeMs = ms_since(t0);
  if (given) {
    // SAM 2's _use_mask_as_output: the mask as 1024² logits (×20 − 10), the object present.
    constexpr auto in = static_cast<std::size_t>(kInput);
    for (std::size_t y = 0; y < in; ++y) {
      const std::size_t sy = std::min<std::size_t>(height - 1, y * height / in);
      for (std::size_t x = 0; x < in; ++x) {
        const std::size_t sx = std::min<std::size_t>(width - 1, x * width / in);
        dec.highRes[y * in + x] = mask[sy * width + sx] * 20.0F - 10.0F;
      }
    }
    dec.objectScore = std::max(dec.objectScore, 10.0F);
  }

  t0 = std::chrono::steady_clock::now();
  const bool conditioning = !prompts.empty() || given;
  Memory mem;
  if (!models_.encode_memory(vision_.feats2, dec.highRes, dec.objectScore, conditioning, mem, error)) return false;
  if (mem.tokens.size() != kTokens * kMemDim || mem.pos.size() != kTokens * kMemDim) {
    error = "memory_encoder answered the wrong shapes";
    return false;
  }
  out.memoryMs = ms_since(t0);
  if (given) {
    out.alpha.assign(mask.begin(), mask.end());
  } else {
    logits_to_alpha(dec.highRes, width, height, out.alpha);
  }
  if (first) {
    // The origin, kept for a walk the other way (start_from): one encode serves both directions.
    Origin o;
    o.mem = mem;
    o.pointer = dec.pointer;
    o.alpha = out.alpha;
    o.iou = dec.iou;
    o.objectScore = dec.objectScore;
    origin_ = std::move(o);
  }
  bank_.add(step_, std::move(mem), dec.pointer, conditioning);
  ++step_;
  out.iou = dec.iou;
  out.objectScore = dec.objectScore;
  out.conditioning = conditioning;
  return true;
}

bool Tracker::start_from(const Origin& o) {
  if (!bank_.empty() || step_ != 0) return false;
  if (o.mem.tokens.size() != kTokens * kMemDim || o.mem.pos.size() != kTokens * kMemDim || o.pointer.size() != kHidden) return false;
  bank_.add(0, o.mem, o.pointer, /*conditioning=*/true);
  origin_ = o;
  step_ = 1;
  return true;
}

bool installed(const std::string& dir) {
  if (dir.empty()) return false;
  std::error_code ec;
  const std::filesystem::path d = u8path(dir);
  return std::all_of(kModelFiles.begin(), kModelFiles.end(), [&](const char* f) { return std::filesystem::is_regular_file(d / f, ec); });
}

std::optional<Constants> load_constants(const std::string& dir, std::string& error) {
  std::ifstream in(u8path(dir) / "constants.json", std::ios::binary);
  if (!in) {
    error = "cannot read constants.json in '" + dir + "'";
    return std::nullopt;
  }
  std::ostringstream ss;
  ss << in.rdbuf();
  return parse_constants(ss.str(), error);
}

}  // namespace premation::jobs::sam2
