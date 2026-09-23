// premation/protocol/frame_channel.hpp — the engine's second pipe: frame
// slots and the heartbeat.
//
// docs/VIEWPORT_ROUTE.md (C1) decided that pixels never travel over the
// command pipe: the engine renders into a ring of shared GPU textures and only
// announces "frame ready in slot N"; the host releases a slot when Chromium has
// finished with it; a full ring drops a frame and never blocks. Those messages,
// plus the supervisor's ping/pong, travel on a SEPARATE pipe (the child's
// fd 3) so that
//   • a large query result (a 3.6 MB getDocument) never delays a frame
//     announcement or a slot release queued behind it, and
//   • a stalled document core is detectable: pong is answered by the core
//     thread, so a heartbeat through it proves the core is draining its queue.
//
// ★ These messages are NOT in packages/engine-api/schema yet. The schema
//   reserves event ids 2100–2199 for the frame route (ENGINE_API.md §13) but
//   defines none; C2 was told not to edit the schema. This hand-written codec
//   is the stop-gap, deliberately tiny (fixed little-endian fields, no nesting)
//   and mirrored in electron/engineFraming.ts. Moving it into the schema is a
//   one-for-one translation of the structs below.
//
// Framing: the same 4-byte little-endian length prefix as the command pipe
// (framing.hpp), payload = [u8 type][fields…]. A payload longer than a type's
// fields is accepted (fields appended by a newer peer are ignored); shorter is
// an error. Unknown types decode as `Kind::unknown` and are skipped.

#ifndef PREMATION_PROTOCOL_FRAME_CHANNEL_HPP
#define PREMATION_PROTOCOL_FRAME_CHANNEL_HPP

#include <bit>
#include <cstddef>
#include <cstdint>
#include <span>
#include <variant>
#include <vector>

namespace premation::frames {

/// Largest frame-channel payload either side accepts (a Slots message with 16
/// handles is 148 bytes).
inline constexpr std::uint32_t kMaxPayload = 4096;
inline constexpr std::uint32_t kMaxSlots = 16;

enum class PixelFormat : std::uint8_t { rgba8unorm = 1 };

// ── engine → host ─────────────────────────────────────────────────────────

/// The ring changed (first viewport, resize, restart of the GPU side). Every
/// slot of an older generation is gone; the host drops its imports of them.
struct Slots {
  static constexpr std::uint8_t kType = 1;
  std::uint32_t generation = 0;
  std::uint32_t viewport = 0;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  PixelFormat format = PixelFormat::rgba8unorm;
  /// true: `handles` are NT handles valid in the host process (sharedTexture
  /// import). false: offscreen slots (headless / tests); handles are 0.
  bool shared = false;
  std::vector<std::uint64_t> handles;  // one per slot, ≤ kMaxSlots
  bool operator==(const Slots&) const = default;
};

/// A finished frame is in `slot`. The GPU work is complete (the engine waited
/// for its queue; Electron's rgba import takes no fence). The slot belongs to
/// the host until it sends Release for this generation + slot.
struct FrameReady {
  static constexpr std::uint8_t kType = 2;
  std::uint32_t generation = 0;
  std::uint32_t slot = 0;
  std::uint32_t viewport = 0;
  /// Frames not delivered since the previous FrameReady (ring full or the
  /// clock ran ahead of the GPU).
  std::uint32_t dropped = 0;
  std::int64_t frame = 0;   ///< comp frame index
  std::int64_t time = 0;    ///< comp time, flicks
  std::uint64_t revision = 0;  ///< document revision the frame shows
  double renderStartUs = 0;  ///< epoch µs — MEASUREMENT ONLY, never an input to pixels
  double renderDoneUs = 0;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  bool operator==(const FrameReady&) const = default;
};

/// Heartbeat answer, sent by the document core thread.
struct Pong {
  static constexpr std::uint8_t kType = 3;
  std::uint64_t nonce = 0;
  std::uint64_t revision = 0;
  bool playing = false;
  std::uint32_t queued = 0;  ///< messages waiting in the core queue when the ping was served
  bool operator==(const Pong&) const = default;
};

// ── host → engine ─────────────────────────────────────────────────────────

/// The host (Chromium) is done with a slot. A stale generation is ignored.
struct Release {
  static constexpr std::uint8_t kType = 16;
  std::uint32_t generation = 0;
  std::uint32_t slot = 0;
  bool operator==(const Release&) const = default;
};

struct Ping {
  static constexpr std::uint8_t kType = 17;
  std::uint64_t nonce = 0;
  bool operator==(const Ping&) const = default;
};

struct Unknown {
  std::uint8_t type = 0;
  bool operator==(const Unknown&) const = default;
};

using Message = std::variant<Unknown, Slots, FrameReady, Pong, Release, Ping>;

enum class Status : std::uint8_t { ok = 0, empty, truncated, bad_value };

namespace detail {

class Out {
 public:
  explicit Out(std::vector<std::uint8_t>& b) noexcept : b_(b) {}
  void u8(std::uint8_t v) { b_.push_back(v); }
  void u32(std::uint32_t v) {
    for (unsigned i = 0; i < 4; ++i) b_.push_back(static_cast<std::uint8_t>(v >> (8U * i)));
  }
  void u64(std::uint64_t v) {
    for (unsigned i = 0; i < 8; ++i) b_.push_back(static_cast<std::uint8_t>(v >> (8U * i)));
  }
  void i64(std::int64_t v) { u64(static_cast<std::uint64_t>(v)); }
  void f64(double v) { u64(std::bit_cast<std::uint64_t>(v)); }

 private:
  std::vector<std::uint8_t>& b_;
};

class In {
 public:
  explicit In(std::span<const std::uint8_t> d) noexcept : d_(d) {}
  [[nodiscard]] bool u8(std::uint8_t& v) noexcept {
    if (d_.size() - p_ < 1 || p_ > d_.size()) return false;
    v = d_[p_++];
    return true;
  }
  [[nodiscard]] bool u32(std::uint32_t& v) noexcept {
    if (d_.size() - p_ < 4 || p_ > d_.size()) return false;
    v = 0;
    for (unsigned i = 0; i < 4; ++i) v |= static_cast<std::uint32_t>(d_[p_ + i]) << (8U * i);
    p_ += 4;
    return true;
  }
  [[nodiscard]] bool u64(std::uint64_t& v) noexcept {
    if (d_.size() - p_ < 8 || p_ > d_.size()) return false;
    v = 0;
    for (unsigned i = 0; i < 8; ++i) v |= static_cast<std::uint64_t>(d_[p_ + i]) << (8U * i);
    p_ += 8;
    return true;
  }
  [[nodiscard]] bool i64(std::int64_t& v) noexcept {
    std::uint64_t u = 0;
    if (!u64(u)) return false;
    v = static_cast<std::int64_t>(u);
    return true;
  }
  [[nodiscard]] bool f64(double& v) noexcept {
    std::uint64_t u = 0;
    if (!u64(u)) return false;
    v = std::bit_cast<double>(u);
    return true;
  }

 private:
  std::span<const std::uint8_t> d_;
  std::size_t p_ = 0;
};

}  // namespace detail

/// Encode one message's payload (without the length prefix) into `out` (cleared first).
inline void encode(const Message& m, std::vector<std::uint8_t>& out) {
  out.clear();
  detail::Out w(out);
  if (const auto* s = std::get_if<Slots>(&m)) {
    w.u8(Slots::kType);
    w.u32(s->generation);
    w.u32(s->viewport);
    w.u32(s->width);
    w.u32(s->height);
    w.u8(static_cast<std::uint8_t>(s->format));
    w.u8(s->shared ? 1U : 0U);
    const std::size_t n = s->handles.size() < kMaxSlots ? s->handles.size() : kMaxSlots;
    w.u8(static_cast<std::uint8_t>(n));
    w.u8(0);
    for (std::size_t i = 0; i < n; ++i) w.u64(s->handles[i]);
  } else if (const auto* f = std::get_if<FrameReady>(&m)) {
    w.u8(FrameReady::kType);
    w.u32(f->generation);
    w.u32(f->slot);
    w.u32(f->viewport);
    w.u32(f->dropped);
    w.i64(f->frame);
    w.i64(f->time);
    w.u64(f->revision);
    w.f64(f->renderStartUs);
    w.f64(f->renderDoneUs);
    w.u32(f->width);
    w.u32(f->height);
  } else if (const auto* p = std::get_if<Pong>(&m)) {
    w.u8(Pong::kType);
    w.u64(p->nonce);
    w.u64(p->revision);
    w.u8(p->playing ? 1U : 0U);
    w.u8(0);
    w.u8(0);
    w.u8(0);
    w.u32(p->queued);
  } else if (const auto* r = std::get_if<Release>(&m)) {
    w.u8(Release::kType);
    w.u32(r->generation);
    w.u32(r->slot);
  } else if (const auto* g = std::get_if<Ping>(&m)) {
    w.u8(Ping::kType);
    w.u64(g->nonce);
  } else if (const auto* u = std::get_if<Unknown>(&m)) {
    w.u8(u->type);
  }
}

/// Decode one payload. Never throws; `out` is only meaningful on Status::ok.
[[nodiscard]] inline Status decode(std::span<const std::uint8_t> payload, Message& out) {
  detail::In r(payload);
  std::uint8_t type = 0;
  if (!r.u8(type)) return Status::empty;
  switch (type) {
    case Slots::kType: {
      Slots s;
      std::uint8_t format = 0;
      std::uint8_t shared = 0;
      std::uint8_t count = 0;
      std::uint8_t pad = 0;
      if (!r.u32(s.generation) || !r.u32(s.viewport) || !r.u32(s.width) || !r.u32(s.height) || !r.u8(format) ||
          !r.u8(shared) || !r.u8(count) || !r.u8(pad)) {
        return Status::truncated;
      }
      if (format != static_cast<std::uint8_t>(PixelFormat::rgba8unorm) || shared > 1 || count > kMaxSlots) {
        return Status::bad_value;
      }
      s.format = PixelFormat::rgba8unorm;
      s.shared = shared == 1;
      s.handles.resize(count);
      for (auto& h : s.handles) {
        if (!r.u64(h)) return Status::truncated;
      }
      out = std::move(s);
      return Status::ok;
    }
    case FrameReady::kType: {
      FrameReady f;
      if (!r.u32(f.generation) || !r.u32(f.slot) || !r.u32(f.viewport) || !r.u32(f.dropped) || !r.i64(f.frame) ||
          !r.i64(f.time) || !r.u64(f.revision) || !r.f64(f.renderStartUs) || !r.f64(f.renderDoneUs) ||
          !r.u32(f.width) || !r.u32(f.height)) {
        return Status::truncated;
      }
      out = f;
      return Status::ok;
    }
    case Pong::kType: {
      Pong p;
      std::uint8_t playing = 0;
      std::uint8_t pad = 0;
      if (!r.u64(p.nonce) || !r.u64(p.revision) || !r.u8(playing) || !r.u8(pad) || !r.u8(pad) || !r.u8(pad) ||
          !r.u32(p.queued)) {
        return Status::truncated;
      }
      if (playing > 1) return Status::bad_value;
      p.playing = playing == 1;
      out = p;
      return Status::ok;
    }
    case Release::kType: {
      Release m;
      if (!r.u32(m.generation) || !r.u32(m.slot)) return Status::truncated;
      out = m;
      return Status::ok;
    }
    case Ping::kType: {
      Ping m;
      if (!r.u64(m.nonce)) return Status::truncated;
      out = m;
      return Status::ok;
    }
    default:
      out = Unknown{type};
      return Status::ok;
  }
}

}  // namespace premation::frames

#endif  // PREMATION_PROTOCOL_FRAME_CHANNEL_HPP
