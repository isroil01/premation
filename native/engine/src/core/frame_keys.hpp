// The document side of cached playback without a build (render/coverage_ledger.hpp
// consumes what this derives): a key per frame of the active composition,
// computed from the INPUTS the frame builder reads — the document parts
// reachable from the comp, the keyframes that decide each frame, the layer
// clocks — in microseconds, where the build itself (scene/engine_frames.cpp)
// is hundreds of milliseconds on a heavy comp. A frame whose key the render
// thread has seen built before is presented from the cache tiers without
// building it; an edit invalidates the frames it can reach, not the bar.
//
// The key is a CONTENT key over the document, never a revision: undo, a
// slider released where it started, a layer toggled off and on give the same
// keys back. It may be conservative (two frames of the same picture may get
// different keys) and never the reverse — equal keys must build equal frames.
// What makes that hold:
//
//  * STATIC inputs are hashed whole, and any change to them changes every
//    frame's key: every node reachable from the comp (its name — expressions
//    resolve layers by it — parent, children order, visibility and solo, every
//    component's props: transform, content, effects, masks, timing), the comp
//    records and timelines (bars are the layer clocks), the assets, project
//    settings, motion blur, colour management, materials, swatches, guides,
//    transitions, and the media base. Label colour, lock and shy are left out:
//    no frame reads them.
//  * KEYFRAME tracks are hashed per frame through the keys that decide the
//    value at that frame: the segment the frame's layer time falls in, one key
//    either side (the tangents motion_eval reads from the neighbours), and the
//    same around the layer time three frames before and after (motion-blur
//    samples: a 720° shutter and its phase reach two frames; the sub-frame
//    clock of a blur sample is within a frame of an integer frame's). A track
//    with a roving key (its times are solved over the whole path) hashes all
//    its keys. So a key edit changes the frames between its neighbours and a
//    few around them — not the comp.
//  * Layers INSIDE a precomp node or an instanced composition run on the
//    parent's remapped clock: their whole animation goes into the static hash.
//    An edit there reaches every frame — correct, just not fine.
//  * EXPRESSIONS: a source that reads only the current time (value, time,
//    wiggle, other layers' properties — all part of this frame's key already)
//    is LOCAL and is hashed with its layer. One that can read other times or
//    other comps (valueAtTime, loopOut, key(), comp(), sampleImage, a wiggle
//    with its own time, …) makes the comp hash every key of every track.
//  * Effects that read their layer at other times (echo, timewarp, the time
//    effects) make their layer and what it holds hash every key; a simulation
//    (fluid, particles: state over previous frames of other layers too), a
//    cloner (clones run behind in time), a native plugin and an effect type
//    the engine does not know do that for the comp.
//  * An audio-waveform layer reads decoded audio that arrives later than the
//    document: the comp is VOLATILE — the keys still drive the bars, but no
//    frame is presented without a build (Session reads `volatile_inputs`).
//
// Core thread only: it reads the document between edits, as a query would.
//
// Storage (long timelines: a 30-minute comp is 54,000 frames, a 4-hour one at
// 120 fps 1.7 million): a layer's hash is PIECEWISE CONSTANT over the frames —
// it changes only where a sampled clock crosses a key (± the blur reach), so
// each layer at the comp's level keeps a sorted vector of (startFrame, hash)
// SPANS, ~4 per keyframe, not a word per frame; a key-less layer is one span.
// The per-frame sum of the spans (`total_`) stays dense: `key()` is one load
// per frame on the core thread during playback, and at kMaxFrames the dense
// total is 16 MB, within the smallest budget. An edit re-spans only its layer
// and corrects the total over the frames whose span hash differs. The whole
// index is held to a byte budget — 1 % of the machine's RAM, clamped to
// [32 MB, 512 MB] (`budget_for`, set by the Session from the host memory it is
// given; tests set it directly) — past which the comp is not indexed (keys are
// 0; the bars fall back to all-or-nothing and every frame builds, as before).
#pragma once

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "anim.hpp"
#include "catalog_data.hpp"
#include "fxstate.hpp"
#include "jsmath.hpp"
#include "model.hpp"
#include "native_effects.hpp"
#include "premation/protocol/wire.hpp"
#include "readmodel.hpp"
#include "scene.hpp"
#include "timeline.hpp"

namespace premation::doc {

namespace frame_keys {

/// A 64-bit mixer (the frame content hash's recipe, scene/engine_frames.cpp).
class Mix {
 public:
  void u64(std::uint64_t v) noexcept {
    h_ ^= v * 0x9e3779b97f4a7c15ULL;
    h_ = std::rotl(h_, 27) * 0xc2b2ae3d27d4eb4fULL + 0x165667b19e3779f9ULL;
  }
  void f64(double v) noexcept { u64(std::bit_cast<std::uint64_t>(v == 0 ? 0.0 : v)); }  // -0 and 0 are one value
  void flag(bool b) noexcept { u64(b ? 0x51U : 0x1fU); }
  void str(std::string_view s) noexcept {
    u64(s.size());
    std::size_t i = 0;
    for (; i + 8 <= s.size(); i += 8) {
      std::uint64_t w = 0;
      std::memcpy(&w, s.data() + i, 8);
      u64(w);
    }
    std::uint64_t tail = 0;
    for (std::size_t k = 0; i + k < s.size(); ++k) tail |= std::uint64_t{static_cast<unsigned char>(s[i + k])} << (8U * k);
    u64(tail);
  }
  template <class T>
  void opt(const std::optional<T>& v) noexcept {
    flag(v.has_value());
    if constexpr (std::is_same_v<T, double>) {
      if (v) f64(*v);
    } else if constexpr (std::is_same_v<T, bool>) {
      if (v) flag(*v);
    } else {
      if (v) u64(static_cast<std::uint64_t>(*v));
    }
  }
  [[nodiscard]] std::uint64_t value() const noexcept {
    std::uint64_t x = h_;
    x ^= x >> 33U;
    x *= 0xff51afd7ed558ccdULL;
    x ^= x >> 33U;
    return x;
  }

 private:
  std::uint64_t h_ = 0x243f6a8885a308d3ULL;
};

/// `j` mixed into `m` by walking it, with the stringify rules Json's == uses (an undefined
/// member dropped, an undefined element and a non-finite number as null): values that
/// stringify alike mix alike. A layer's fx can be megabytes (a Follow stores a mask key per
/// frame); printing it to text to hash it cost ~30 ms per edit of the layer, the walk ~1 ms.
/// A Project-panel field of an asset record: its name, folder, label colour,
/// notes. None of them reaches a frame, so none of them is keyed.
inline bool asset_label_field(std::string_view k) noexcept {
  return k == "name" || k == "folderId" || k == "folder" || k == "label" || k == "labelColor" || k == "comment" ||
         k == "comments" || k == "notes" || k == "tags" || k == "favorite" || k == "addedAt" || k == "lastUsed" ||
         k == "thumbnail" || k == "thumb";
}

inline void mix_json(Mix& m, const Json& j) {  // NOLINT(misc-no-recursion): bounded by the document's depth
  switch (j.kind()) {
    case Json::Kind::undefined:
    case Json::Kind::null: m.u64(0x6e75U); return;
    case Json::Kind::boolean: m.u64(j.b() ? 0x7472U : 0x6661U); return;
    case Json::Kind::number:
      if (!std::isfinite(j.num())) {
        m.u64(0x6e75U);
      } else {
        m.u64(0x6e6dU);
        m.f64(j.num());
      }
      return;
    case Json::Kind::string:
      m.u64(0x7374U);
      m.str(j.str());
      return;
    case Json::Kind::array:
      m.u64(0x6172U);
      m.u64(j.arr().size());
      for (const Json& e : j.arr()) mix_json(m, e);
      return;
    case Json::Kind::object: {
      m.u64(0x6f62U);
      std::uint64_t members = 0;
      for (const Json::Member& e : j.obj()) {
        if (e.value.is_undefined()) continue;
        m.str(e.key);
        mix_json(m, e.value);
        ++members;
      }
      m.u64(members);
      return;
    }
  }
}

[[nodiscard]] inline std::uint64_t hash_json(const Json& j) {
  Mix m;
  mix_json(m, j);
  return m.value();
}

/// Effects that read their own layer at other times: the layer (and what it holds) hashes every key.
[[nodiscard]] inline bool temporal_effect(std::string_view t) noexcept {
  constexpr auto kTemporal = std::to_array<std::string_view>(
      {"echo", "posterize-time", "wide-time", "force-motion-blur", "timewarp", "pixel-motion-blur", "time-displacement",
       "time-difference", "time-blend", "light-trails", "datamosh", "temporal-denoise", "warp-stabilizer", "color-stabilizer",
       "camera-shake-deblur", "match-grain"});
  return std::ranges::find(kTemporal, t) != kTemporal.end();
}

/// Simulations: state carried over previous frames, of other layers too (a layer map, an emitter): the comp hashes every key.
[[nodiscard]] inline bool simulation_effect(std::string_view t) noexcept {
  constexpr auto kSimulation = std::to_array<std::string_view>({"fluid-ink", "reaction-diffusion", "crystal-growth", "mr-mercury",
                                                                 "foam", "hair", "rain-on-glass", "particle-world", "particle-systems"});
  return std::ranges::find(kSimulation, t) != kSimulation.end();
}

/// Whether an expression source can only read the current time. Any
/// identifier of the non-local set anywhere in the source (a string, a
/// comment) counts: conservative, never wrong.
[[nodiscard]] inline bool expression_is_local(std::string_view src) noexcept {
  constexpr auto kNonLocal = std::to_array<std::string_view>(
      {"valueAtTime", "velocityAtTime", "speedAtTime", "loopIn", "loopOut", "loopInDuration", "loopOutDuration", "key",
       "nearestKey", "numKeys", "sourceRectAtTime", "posterizeTime", "smooth", "temporalWiggle", "sampleImage", "comp",
       "footage", "source", "eval", "Function"});
  const auto identStart = [](char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == '$'; };
  const auto identChar = [&identStart](char c) { return identStart(c) || (c >= '0' && c <= '9'); };
  const std::size_t n = src.size();
  std::size_t i = 0;
  while (i < n) {
    if (!identStart(src[i])) {
      ++i;
      continue;
    }
    std::size_t j = i;
    while (j < n && identChar(src[j])) ++j;
    const std::string_view word = src.substr(i, j - i);
    if (std::ranges::find(kNonLocal, word) != kNonLocal.end()) return false;
    if (word == "wiggle") {
      // wiggle(freq, amp, octaves, ampMult, t): a fifth argument is another time.
      std::size_t k = j;
      while (k < n && (src[k] == ' ' || src[k] == '\t' || src[k] == '\r' || src[k] == '\n')) ++k;
      if (k < n && src[k] == '(') {
        int depth = 0;
        int commas = 0;
        for (std::size_t m = k; m < n; ++m) {
          const char ch = src[m];
          if (ch == '(') {
            ++depth;
          } else if (ch == ')') {
            if (--depth == 0) break;
          } else if (ch == ',' && depth == 1) {
            ++commas;
          }
        }
        if (commas >= 4) return false;
      }
    }
    i = j;
  }
  return true;
}

}  // namespace frame_keys

class FrameKeyIndex {
 public:
  /// What an update found: every frame changed (or unknown), or these frames (sorted, unique).
  struct Delta {
    bool all = true;
    std::vector<std::int64_t> frames;
  };
  /// Frames a comp may have and still be indexed: 4 h 37 min at 120 fps
  /// (18.5 h at 30). The dense total is 8 bytes a frame: 16 MB here.
  static constexpr std::int64_t kMaxFrames = 2'000'000;
  /// Motion-blur reach, frames either side (a 720° shutter and its phase).
  static constexpr std::int64_t kBlurFrames = 3;
  /// The byte budget's bounds: `budget_for` is 1 % of the machine's RAM inside them.
  static constexpr std::size_t kMinBudgetBytes = std::size_t{32} << 20U;
  static constexpr std::size_t kMaxBudgetBytes = std::size_t{512} << 20U;
  /// The budget for a machine with `physicalBytes` of RAM (0 = unknown: the floor).
  [[nodiscard]] static constexpr std::size_t budget_for(std::uint64_t physicalBytes) noexcept {
    const std::uint64_t share = physicalBytes / 100U;
    return static_cast<std::size_t>(std::clamp<std::uint64_t>(share, kMinBudgetBytes, kMaxBudgetBytes));
  }
  /// The bytes the index may hold (dense total + every layer's spans). Kept
  /// across resets; a comp past it is not indexed until the next rebuild.
  void set_budget_bytes(std::size_t bytes) noexcept { budget_ = bytes; }
  [[nodiscard]] std::size_t budget_bytes() const noexcept { return budget_; }
  /// What the index holds now (0 when not indexed).
  [[nodiscard]] std::size_t bytes() const noexcept { return bytes_; }

  void reset() {
    comp_.clear();
    mediaBase_.clear();
    indexed_ = false;
    volatile_ = false;
    global_ = false;
    exprs_ = false;
    frames_ = 0;
    fps_ = 30;
    static_ = 0;
    bytes_ = 0;
    layers_.clear();
    layerIndex_.clear();
    compList_.clear();
    nodeHash_.clear();
    total_.clear();
  }

  /// Index `comp` of `d` from scratch. False = not indexable (no such comp,
  /// too large): `key` answers 0 until the next rebuild. `comp()` names the
  /// comp either way, so a caller does not retry every frame.
  bool rebuild(const Document& d, const EditorView& v, std::string_view comp, std::string_view mediaBase) {
    reset();
    comp_ = std::string(comp);
    mediaBase_ = std::string(mediaBase);
    const Node* root = d.node(comp);
    if (root == nullptr || d.comp(comp) == nullptr) return false;
    fps_ = comp_fps(d, comp);
    if (!(fps_ > 0)) fps_ = 30;
    const double frames = std::floor(comp_duration_frames(d, comp));
    if (!(frames >= 1) || frames > static_cast<double>(kMaxFrames)) return false;
    frames_ = static_cast<std::int64_t>(frames);
    std::unordered_set<std::string> seen;
    seen.insert(comp_);
    compList_.push_back(comp_);
    collect(d, *root, false, false, 0, seen);
    std::ranges::sort(compList_);
    mark_local(d);
    bytes_ = static_cast<std::size_t>(frames_) * sizeof(std::uint64_t);
    if (bytes_ > budget_) return give_up();
    total_.assign(static_cast<std::size_t>(frames_), 0);
    for (Layer& l : layers_) {
      if (l.nested) {
        l.constant = anim_hash(d, l.id);
        continue;
      }
      l.clock = clock_of(d, v, l.id);
      if (l.local) l.node = node_hash(d, l.id);
      l.spans = spans_of(d, l);
      bytes_ += l.spans.size() * sizeof(Span);
      if (bytes_ > budget_) return give_up();
      add_spans(l.spans, true);
    }
    static_ = static_of(d);
    indexed_ = true;
    return true;
  }

  /// After a commit of `changes`: the frames whose key changed. The structure
  /// (layers added, removed, moved, retimed; a comp setting; an expression)
  /// rebuilds the index and answers every frame.
  Delta update(const Document& d, const EditorView& v, const ChangeSet& changes, std::string_view mediaBase) {
    Delta all;
    if (!indexed_) return all;
    if (mediaBase != mediaBase_) {
      (void)rebuild(d, v, comp_, mediaBase);
      return all;
    }
    const Parts& after = changes.after;
    const Parts& before = changes.before;
    bool structural = false;
    bool staticChanged = false;
    std::vector<std::string> rows;
    for (const auto& [id, node] : after.nodes) {
      const bool reachable = layerIndex_.contains(id);
      if (node == nullptr) {  // removed
        if (reachable || compList_end(id)) structural = true;
        continue;
      }
      if (!reachable) {
        // Added under a reachable node (or a reachable comp's root changed).
        if (compList_end(id) || (node->parent && (compList_end(*node->parent) || layerIndex_.contains(*node->parent)))) structural = true;
        continue;
      }
      const auto old = before.nodes.find(id);
      const Node* prev = old != before.nodes.end() ? old->second.get() : nullptr;
      if (prev == nullptr || prev->children != node->children || prev->parent != node->parent || is_precomp(*prev) != is_precomp(*node) ||
          read_comp_ref(*prev) != read_comp_ref(*node) || node_flags(*prev) != node_flags(*node)) {
        structural = true;
        continue;
      }
      nodeHash_.erase(id);
      // A layer whose own props only it renders: its spans carry them (its active
      // frames only). Anything else (a parent, a layer another reads) is static.
      // A props edit that now names a local layer makes that layer read by another: rebuild.
      if (references_local(*node)) {
        structural = true;
        continue;
      }
      if (!layers_[layerIndex_.at(id)].local) staticChanged = true;
      rows.push_back(id);  // its clock (fx.time) may have changed
    }
    for (const auto& [id, anim] : after.anims) {
      if (!layerIndex_.contains(id)) continue;
      const auto old = before.anims.find(id);
      const NodeAnim* prev = old != before.anims.end() ? old->second.get() : nullptr;
      // An expression edit may change what is local: rare, and a rebuild is cheap next to it.
      if ((anim != nullptr && !anim->exprs.empty()) || (prev != nullptr && !prev->exprs.empty())) structural = true;
      rows.push_back(id);
    }
    for (const auto& [id, rec] : after.comps) {
      if (!compList_end(id)) continue;
      staticChanged = true;
      if (id == comp_ && (rec == nullptr || std::floor(comp_duration_frames(d, comp_)) != static_cast<double>(frames_) || comp_fps(d, comp_) != fps_)) {
        structural = true;
      }
    }
    for (const auto& [id, tl] : after.timelines) {
      if (compList_end(id)) structural = true;  // the bars are the layer clocks
    }
    // Guides and swatches never reach a frame: not keyed (static_of skips them).
    if (after.items || after.project || after.mb || after.cm || after.tx || after.materials) staticChanged = true;
    if (structural) {
      (void)rebuild(d, v, comp_, mediaBase);
      return all;
    }
    // Frame ranges [first, end) whose total changed: a re-spanned layer's
    // spans against its old ones, hash by hash.
    std::vector<std::pair<std::int64_t, std::int64_t>> ranges;
    for (const std::string& id : rows) {
      Layer& l = layers_[layerIndex_.at(id)];
      if (l.nested) {
        l.constant = anim_hash(d, l.id);
        staticChanged = true;
        continue;
      }
      l.clock = clock_of(d, v, l.id);
      if (l.local) l.node = node_hash(d, l.id);
      const std::vector<Span> old = std::move(l.spans);
      l.spans = spans_of(d, l);
      bytes_ = bytes_ - old.size() * sizeof(Span) + l.spans.size() * sizeof(Span);
      diff_spans(old, l.spans, ranges);
    }
    if (bytes_ > budget_) {
      (void)give_up();  // the keys grew past the budget: not indexed until the next rebuild
      return all;
    }
    if (staticChanged) {
      // Only when the static key moved: a renamed marker, an asset's label, a
      // project display setting leave it as it was, and every frame with it.
      const std::uint64_t now = static_of(d);
      if (now != static_) {
        static_ = now;
        return all;
      }
    }
    std::vector<std::int64_t> changed = frames_of(std::move(ranges));
    if (changed.size() >= static_cast<std::size_t>(frames_)) return all;
    Delta some;
    some.all = false;
    some.frames = std::move(changed);
    return some;
  }

  /// The document's key for `frame` (0 = not indexed, or outside the comp).
  /// One load from the dense total: no search, no allocation.
  [[nodiscard]] std::uint64_t key(std::int64_t frame) const noexcept {
    if (!indexed_ || frame < 0 || frame >= frames_) return 0;
    return key_of(static_, total_[static_cast<std::size_t>(frame)], frame);
  }
  /// The key's recipe: the static hash, the frame's summed layer hashes, the frame. Never 0.
  [[nodiscard]] static std::uint64_t key_of(std::uint64_t staticHash, std::uint64_t total, std::int64_t frame) noexcept {
    frame_keys::Mix m;
    m.u64(staticHash);
    m.u64(total);
    m.u64(static_cast<std::uint64_t>(frame));
    const std::uint64_t v = m.value();
    return v == 0 ? 1 : v;
  }
  [[nodiscard]] bool indexed() const noexcept { return indexed_; }
  /// An input arrives later than the document (decoded audio): never present a frame without a build.
  [[nodiscard]] bool volatile_inputs() const noexcept { return volatile_; }
  [[nodiscard]] const std::string& comp() const noexcept { return comp_; }
  [[nodiscard]] std::int64_t frames() const noexcept { return frames_; }
  /// Every track of every layer hashed whole (an expression, a simulation, a plugin).
  [[nodiscard]] bool whole_comp() const noexcept { return global_; }
  /// Tests: the layer clock the index evaluates frame `frame` of `layer` at
  /// (comp_to_keyframe_time's answer for a plain property); nullopt = no such
  /// layer at the comp's level.
  [[nodiscard]] std::optional<double> layer_time(std::string_view layer, std::int64_t frame) const {
    const auto it = layerIndex_.find(std::string(layer));
    if (it == layerIndex_.end() || layers_[it->second].nested) return std::nullopt;
    return clock_time(layers_[it->second].clock, static_cast<double>(frame) / fps_);
  }
  /// Tests: the layers at the comp's level (the ones with spans), in index order.
  [[nodiscard]] std::vector<std::string> indexed_layers() const {
    std::vector<std::string> out;
    for (const Layer& l : layers_) {
      if (!l.nested) out.push_back(l.id);
    }
    return out;
  }
  /// Tests: how many spans `layer` holds (0 = nested, or no such layer).
  [[nodiscard]] std::size_t span_count(std::string_view layer) const {
    const auto it = layerIndex_.find(std::string(layer));
    return it == layerIndex_.end() ? 0 : layers_[it->second].spans.size();
  }
  /// Tests: the static hash `key_of` mixes with every frame's total.
  [[nodiscard]] std::uint64_t static_hash() const noexcept { return static_; }
  /// Tests: `layer`'s hash at `frame` computed from scratch, frame by frame —
  /// the dense reference the spans compress (sampling every clock, walking
  /// every track; slow: it plans the row on each call). The sum over the
  /// comp's layers is `total_[frame]`. nullopt = nested or no such layer.
  [[nodiscard]] std::optional<std::uint64_t> layer_hash(const Document& d, std::string_view layer, std::int64_t frame) const {
    const auto it = layerIndex_.find(std::string(layer));
    if (it == layerIndex_.end() || layers_[it->second].nested || frame < 0 || frame >= frames_) return std::nullopt;
    const Layer& l = layers_[it->second];
    return frame_hash(plan_of(d, l), l.clock, frame);
  }

 private:
  struct ClipSpan {
    double start = 0;
    double duration = 0;
    double sourceIn = 0;
    bool enabled = true;
  };
  /// A layer's clock: comp seconds → keyframe seconds (timeline.cpp comp_to_keyframe_time).
  struct Clock {
    double fps = 30;
    std::vector<ClipSpan> clips;
    std::optional<LayerTime> cfg;
    double spanStart = 0;
    double spanEnd = 1;
  };
  /// A run of frames over which a layer's hash is one value: [start, next span's start).
  struct Span {
    std::int64_t start = 0;
    std::uint64_t hash = 0;
  };
  struct Layer {
    std::string id;
    bool nested = false;  ///< inside a precomp / an instanced comp: on the parent's clock, hashed whole
    bool whole = false;   ///< every key of every track (a temporal effect on it or above it)
    std::uint64_t constant = 0;  ///< nested: the animation's hash
    std::vector<Span> spans;     ///< not nested: sorted by start, the first at frame 0, never empty once indexed
    Clock clock;
    /// Its own props are read by it alone (no expressions in the comp, no other
    /// layer naming it, no children): node_hash goes into its spans on the
    /// frames it is active, not into static_ — an edit re-keys those frames only.
    bool local = false;
    std::uint64_t node = 0;  ///< local: node_hash
  };
  static constexpr std::size_t kSamples = static_cast<std::size_t>(2 * kBlurFrames + 1);
  using Samples = std::array<double, kSamples>;
  using KeyRange = std::pair<std::ptrdiff_t, std::ptrdiff_t>;

  /// Not indexable after all (past the budget): keep the comp's name so the caller does not retry every frame.
  bool give_up() {
    const std::string keep = comp_;
    reset();
    comp_ = keep;
    return false;
  }

  /// Add (or take back) a layer's spans to the dense total.
  void add_spans(const std::vector<Span>& spans, bool add) noexcept {
    for (std::size_t i = 0; i < spans.size(); ++i) {
      const std::int64_t stop = i + 1 < spans.size() ? spans[i + 1].start : frames_;
      for (std::int64_t f = spans[i].start; f < stop; ++f) {
        if (add) total_[static_cast<std::size_t>(f)] += spans[i].hash;
        else total_[static_cast<std::size_t>(f)] -= spans[i].hash;
      }
    }
  }

  /// Walk two span lists of one layer in step: where the hashes differ, move
  /// the total from the old hash to the new and note the range.
  void diff_spans(const std::vector<Span>& old, const std::vector<Span>& neu, std::vector<std::pair<std::int64_t, std::int64_t>>& ranges) {
    if (old.empty() || neu.empty()) return;
    std::size_t i = 0;
    std::size_t j = 0;
    std::int64_t pos = 0;
    while (pos < frames_) {
      const std::int64_t nextOld = i + 1 < old.size() ? old[i + 1].start : frames_;
      const std::int64_t nextNew = j + 1 < neu.size() ? neu[j + 1].start : frames_;
      const std::int64_t stop = std::min(nextOld, nextNew);
      if (old[i].hash != neu[j].hash) {
        const std::uint64_t shift = neu[j].hash - old[i].hash;
        for (std::int64_t f = pos; f < stop; ++f) total_[static_cast<std::size_t>(f)] += shift;
        if (!ranges.empty() && ranges.back().second == pos) ranges.back().second = stop;
        else ranges.emplace_back(pos, stop);
      }
      pos = stop;
      if (stop == nextOld) ++i;
      if (stop == nextNew) ++j;
    }
  }

  /// The frames of a union of ranges, sorted and unique (the Delta's shape).
  [[nodiscard]] static std::vector<std::int64_t> frames_of(std::vector<std::pair<std::int64_t, std::int64_t>> ranges) {
    std::ranges::sort(ranges);
    std::vector<std::int64_t> out;
    std::int64_t next = std::numeric_limits<std::int64_t>::min();
    for (const auto& [first, stop] : ranges) {
      for (std::int64_t f = std::max(first, next); f < stop; ++f) out.push_back(f);
      next = std::max(next, stop);
    }
    return out;
  }

  [[nodiscard]] bool compList_end(std::string_view id) const { return std::ranges::find(compList_, id) != compList_.end(); }

  /// What of a node decides the index's structure beyond its tree position.
  [[nodiscard]] static std::uint64_t node_flags(const Node& n) {
    std::uint64_t f = 0;
    for (const Json& e : read_node_effects(n)) {
      if (!e.at("type").is_string()) continue;
      const std::string& t = e.at("type").str();
      if (frame_keys::simulation_effect(t) || NativeEffects::find(t) != nullptr || registry().effect(t) == nullptr) f |= 1U;
      if (frame_keys::temporal_effect(t)) f |= 2U;
    }
    for (const Component& c : n.components) {
      if (c.props.at("__cloner").is_object()) f |= 4U;
    }
    if (n.fx().at("audioWaveform").is_object()) f |= 8U;
    return f;
  }

  void collect(const Document& d, const Node& root, bool nested, bool whole, int depth, std::unordered_set<std::string>& seenComps) {
    for (const std::string& childId : root.children) {
      const Node* n = d.node(childId);
      if (n == nullptr || layerIndex_.contains(childId)) continue;
      const std::uint64_t flags = node_flags(*n);
      if ((flags & 1U) != 0 || (flags & 4U) != 0) global_ = true;
      if ((flags & 8U) != 0) volatile_ = true;
      const bool own = whole || (flags & 2U) != 0 || (flags & 8U) != 0;
      if (const NodeAnim* a = d.anim(childId)) {
        for (const auto& [prop, st] : a->exprs) {
          if (st.enabled) exprs_ = true;
          if (st.enabled && !frame_keys::expression_is_local(st.src)) global_ = true;
        }
      }
      Layer l;
      l.id = childId;
      l.nested = nested;
      l.whole = own;
      layerIndex_.emplace(childId, layers_.size());
      layers_.push_back(std::move(l));
      collect(d, *n, nested || is_precomp(*n), own, depth, seenComps);
      if (const std::optional<std::string> ref = read_comp_ref(*n); ref && depth < 8 && seenComps.insert(*ref).second) {
        if (const Node* other = d.node(*ref); other != nullptr && d.comp(*ref) != nullptr) {
          compList_.push_back(*ref);
          collect(d, *other, true, own, depth + 1, seenComps);
        }
      }
    }
  }

  /// Whether `j` holds, anywhere, a string naming a layer in `ids`.
  [[nodiscard]] static bool names_any(const Json& j, const std::unordered_set<std::string>& ids) {  // NOLINT(misc-no-recursion): bounded by the document's depth
    if (j.is_string()) return ids.contains(j.str());
    if (j.is_array()) return std::ranges::any_of(j.arr(), [&](const Json& e) { return names_any(e, ids); });
    if (j.is_object()) return std::ranges::any_of(j.obj(), [&](const auto& e) { return names_any(e.value, ids); });
    return false;
  }

  /// Every string in `j` that names a layer of `ids`, into `out`.
  static void named_in(const Json& j, const std::unordered_set<std::string>& ids, std::unordered_set<std::string>& out) {  // NOLINT(misc-no-recursion): bounded by the document's depth
    if (j.is_string()) {
      if (ids.contains(j.str())) out.insert(j.str());
    } else if (j.is_array()) {
      for (const Json& e : j.arr()) named_in(e, ids, out);
    } else if (j.is_object()) {
      for (const auto& e : j.obj()) named_in(e.value, ids, out);
    }
  }

  /// Layer.local for every layer at the comp's level, after collect.
  void mark_local(const Document& d) {
    if (exprs_ || global_) return;
    std::unordered_set<std::string> ids;
    for (const Layer& l : layers_) ids.insert(l.id);
    std::unordered_set<std::string> read;  // named in another node's props
    for (const Layer& l : layers_) {
      const Node* n = d.node(l.id);
      if (n == nullptr) continue;
      std::unordered_set<std::string> named;
      for (const Component& c : n->components) named_in(c.props, ids, named);
      named.erase(l.id);
      read.insert(named.begin(), named.end());
    }
    for (Layer& l : layers_) {
      const Node* n = d.node(l.id);
      l.local = !l.nested && n != nullptr && n->children.empty() && !read.contains(l.id);
    }
  }

  /// A node's props name a layer that is local now (an edit made it read by another).
  [[nodiscard]] bool references_local(const Node& n) const {
    std::unordered_set<std::string> local;
    for (const Layer& l : layers_) {
      if (l.local && l.id != n.id) local.insert(l.id);
    }
    if (local.empty()) return false;
    return std::ranges::any_of(n.components, [&](const Component& c) { return names_any(c.props, local); });
  }

  [[nodiscard]] std::uint64_t node_hash(const Document& d, const std::string& id) {
    if (const auto it = nodeHash_.find(id); it != nodeHash_.end()) return it->second;
    frame_keys::Mix m;
    if (const Node* n = d.node(id)) {
      m.str(n->id);
      // A layer's name reaches the frame only through an expression (thisComp.layer("...")).
      if (exprs_) m.str(n->name);
      m.str(n->parent.value_or(""));
      for (const std::string& c : n->children) m.str(c);
      m.flag(n->visible);
      m.flag(n->solo);
      for (const Component& c : n->components) {
        m.str(c.id);
        m.str(c.type);
        frame_keys::mix_json(m, c.props);
      }
    }
    const std::uint64_t h = m.value();
    nodeHash_.emplace(id, h);
    return h;
  }

  static void mix_key(frame_keys::Mix& m, const Key& k) {
    m.f64(k.t);
    m.f64(k.value);
    m.opt(k.easing);
    m.flag(k.bezier.has_value());
    if (k.bezier) {
      for (const double b : *k.bezier) m.f64(b);
    }
    m.opt(k.continuous);
    m.opt(k.roving);
    m.opt(k.si);
    m.opt(k.so);
    m.opt(k.spatial);
  }
  static void mix_data_key(frame_keys::Mix& m, const DataKey& k) {
    m.f64(k.t);
    frame_keys::mix_json(m, k.value);
    m.opt(k.easing);
    m.flag(k.bezier.has_value());
    if (k.bezier) {
      for (const double b : *k.bezier) m.f64(b);
    }
    m.flag(k.so.has_value());
    if (k.so) frame_keys::mix_json(m, *k.so);
    m.flag(k.si.has_value());
    if (k.si) frame_keys::mix_json(m, *k.si);
  }

  /// A nested layer's animation, whole.
  [[nodiscard]] static std::uint64_t anim_hash(const Document& d, const std::string& id) {
    frame_keys::Mix m;
    const NodeAnim* a = d.anim(id);
    if (a == nullptr) return m.value();
    for (const auto& [prop, keys] : a->tracks) {
      m.str(prop);
      m.u64(keys.size());
      for (const Key& k : keys) mix_key(m, k);
    }
    for (const auto& [prop, track] : a->data) {
      m.str(prop);
      m.str(track.kind);
      m.u64(track.keys.size());
      for (const DataKey& k : track.keys) mix_data_key(m, k);
    }
    for (const auto& [prop, st] : a->exprs) {
      m.str(prop);
      m.str(st.src);
      m.flag(st.enabled);
    }
    return m.value();
  }

  [[nodiscard]] static Clock clock_of(const Document& d, const EditorView& v, const std::string& id) {
    Clock c;
    c.fps = tl_fps_for_node(d, v, id);
    if (!(c.fps > 0)) c.fps = 30;
    // Governing clips: the node's own, else an enclosing plain group's (comp_to_keyframe_time).
    std::vector<const Bar*> clips = tl_bars_for_node(d, v, id);
    if (clips.empty()) {
      const Node* n = d.node(id);
      for (int depth = 0; depth < 32 && n != nullptr; ++depth) {
        if (!n->parent) break;
        const Node* parent = d.node(*n->parent);
        if (parent == nullptr) break;
        if (is_precomp(*parent) || parent->kind() != "group") break;
        clips = tl_bars_for_node(d, v, parent->id);
        if (!clips.empty()) break;
        n = parent;
      }
    }
    c.clips.reserve(clips.size());
    for (const Bar* b : clips) c.clips.push_back(ClipSpan{b->clip.start, b->clip.duration, b->clip.sourceIn, b->enabled});
    if (const Node* n = d.node(id)) c.cfg = read_node_layer_time(*n);
    if (const auto span = anim_time_span(d, id)) {
      c.spanStart = span->start;
      c.spanEnd = span->end;
    }
    return c;
  }

  [[nodiscard]] static double clock_time(const Clock& c, double compTime) noexcept {
    double time = compTime;
    const double frame = motion::js::round(time * c.fps);
    // comp_to_keyframe_time's governing clip: the one active here, else the
    // NEAREST one (a layer's time runs on past its in / out points, as in AE).
    // Leaving an out-of-clip frame on the comp clock hashed the layer at the
    // wrong time, so its cached frames could be keyed by another frame's content.
    const ClipSpan* governing = nullptr;
    double bestDist = std::numeric_limits<double>::infinity();
    for (const ClipSpan& k : c.clips) {
      if (k.enabled && frame >= k.start && frame < k.start + k.duration) {
        governing = &k;
        break;
      }
      const double clamped = std::max(k.start, std::min(k.start + k.duration - 1, frame));
      const double dist = std::fabs(frame - clamped);
      if (dist < bestDist) {
        bestDist = dist;
        governing = &k;
      }
    }
    if (governing != nullptr) time = (governing->sourceIn + (frame - governing->start)) / c.fps;
    if (c.cfg) time = remap_time(time, *c.cfg, c.spanStart, c.spanEnd);
    return time;
  }

  /// The index of the key segment `t` falls in (-1 = before the first key).
  template <class K>
  [[nodiscard]] static std::ptrdiff_t segment(const std::vector<K>& keys, double t) noexcept {
    const auto it = std::upper_bound(keys.begin(), keys.end(), t, [](double x, const K& k) { return x < k.t; });
    return (it - keys.begin()) - 1;
  }

  /// What a layer's clock is made of (clock_time reads nothing else): hashed
  /// into every frame of the layer instead of the clock TIME at the frame,
  /// so the hash is constant between key crossings. Equal parameters give
  /// equal times at equal frames; the frame itself is in the key (`key_of`).
  [[nodiscard]] static std::uint64_t clock_hash(const Clock& c) noexcept {
    frame_keys::Mix m;
    m.f64(c.fps);
    m.u64(c.clips.size());
    for (const ClipSpan& k : c.clips) {
      m.f64(k.start);
      m.f64(k.duration);
      m.f64(k.sourceIn);
      m.flag(k.enabled);
    }
    m.flag(c.cfg.has_value());
    if (c.cfg) {
      // remap_time: frozen reads only freezeTime; else the stretch anchors on
      // the keys' span start, and reverse mirrors through its end too.
      m.flag(c.cfg->freeze);
      if (c.cfg->freeze) {
        m.f64(c.cfg->freezeTime);
      } else {
        m.f64(c.cfg->stretch);
        m.flag(c.cfg->reverse);
        m.f64(c.spanStart);
        if (c.cfg->reverse) m.f64(c.spanEnd);
      }
    }
    return m.value();
  }

  /// Per track: its keys' hashes (once), and whether it hashes whole.
  struct Track {
    const std::string* prop = nullptr;
    const std::vector<Key>* keys = nullptr;
    const DataTrack* data = nullptr;
    std::vector<std::uint64_t> keyHash;
    std::uint64_t allHash = 0;  ///< every key's hash mixed in order: what a whole track contributes
    bool whole = false;
    bool raw = false;  // timeRemap / precompTime: on the comp clock
  };
  /// A layer's frame-hash inputs, gathered once per (re)span.
  struct RowPlan {
    std::vector<Track> tracks;
    std::uint64_t clock = 0;  ///< clock_hash
    std::uint64_t exprs = 0;
    double reach = 0;      ///< keyframe seconds either side of a sampled clock (a comp frame, stretched)
    bool constant = true;  ///< no track picks keys per frame: the layer is one span
    bool local = false;    ///< Layer.local: `node` is mixed on active frames
    std::uint64_t node = 0;
    const Clock* clockSrc = nullptr;  ///< local: whose clips decide the active frames
  };

  [[nodiscard]] RowPlan plan_of(const Document& d, const Layer& l) const {
    RowPlan p;
    p.clock = clock_hash(l.clock);
    p.local = l.local;
    p.node = l.node;
    p.clockSrc = &l.clock;
    const NodeAnim* a = d.anim(l.id);
    if (a != nullptr) {
      p.tracks.reserve(a->tracks.size() + a->data.size());
      for (const auto& [prop, keys] : a->tracks) {
        Track t;
        t.prop = &prop;
        t.keys = &keys;
        t.raw = prop == "timeRemap" || prop == "precompTime";
        t.whole = l.whole || global_;
        t.keyHash.reserve(keys.size());
        for (std::size_t i = 0; i < keys.size(); ++i) {
          const Key& k = keys[i];
          if (k.roving.value_or(false) || (i > 0 && k.t < keys[i - 1].t)) t.whole = true;  // roving solves times over the path; unsorted: all
          frame_keys::Mix m;
          mix_key(m, k);
          t.keyHash.push_back(m.value());
        }
        p.tracks.push_back(std::move(t));
      }
      for (const auto& [prop, data] : a->data) {
        Track t;
        t.prop = &prop;
        t.data = &data;
        t.raw = prop == "timeRemap" || prop == "precompTime";
        t.whole = l.whole || global_;
        t.keyHash.reserve(data.keys.size());
        for (std::size_t i = 0; i < data.keys.size(); ++i) {
          const DataKey& k = data.keys[i];
          if (i > 0 && k.t < data.keys[i - 1].t) t.whole = true;
          frame_keys::Mix m;
          m.str(data.kind);
          mix_data_key(m, k);
          t.keyHash.push_back(m.value());
        }
        p.tracks.push_back(std::move(t));
      }
      for (Track& t : p.tracks) {
        frame_keys::Mix m;
        for (const std::uint64_t h : t.keyHash) m.u64(h);
        t.allHash = m.value();
        if (!t.whole && !t.keyHash.empty()) p.constant = false;
      }
      frame_keys::Mix e;
      for (const auto& [prop, st] : a->exprs) {
        e.str(prop);
        e.str(st.src);
        e.flag(st.enabled);
      }
      p.exprs = e.value();
    }
    // Reach in keyframe seconds around each sampled clock: a frame of the
    // comp, stretched as the layer's time is (remap_time's 100 / stretch).
    p.reach = 1.0 / fps_;
    if (l.clock.cfg && l.clock.cfg->stretch > 0) p.reach *= std::max(1.0, 100.0 / l.clock.cfg->stretch);
    // A local layer on clips is not one value over the comp: its props key only its active frames.
    if (l.local && !l.clock.clips.empty()) p.constant = false;
    return p;
  }

  /// The comp time of frame `g` (may be negative: the blur samples before frame 0).
  [[nodiscard]] double comp_time(std::int64_t g) const noexcept { return static_cast<double>(g) / fps_; }

  /// The keys a track contributes at a frame whose sampled times are `times`:
  /// the segment either side of each sample ± reach, one key beyond (the
  /// tangents), clamped to the track. `segment` is monotone, so the outer
  /// samples decide: two searches, not fourteen.
  [[nodiscard]] static KeyRange key_range(const Track& t, const Samples& times, double reach) noexcept {
    double lo = times[0];
    double hi = times[0];
    for (const double x : times) {
      lo = std::min(lo, x);
      hi = std::max(hi, x);
    }
    const std::ptrdiff_t n = static_cast<std::ptrdiff_t>(t.keyHash.size());
    const std::ptrdiff_t first = (t.keys != nullptr ? segment(*t.keys, lo - reach) : segment(t.data->keys, lo - reach)) - 1;
    const std::ptrdiff_t last = (t.keys != nullptr ? segment(*t.keys, hi + reach) : segment(t.data->keys, hi + reach)) + 2;
    return KeyRange{std::clamp<std::ptrdiff_t>(first, 0, n - 1), std::clamp<std::ptrdiff_t>(last, 0, n - 1)};
  }

  /// The hash of one frame of a layer from its sampled times and the ranges
  /// `key_range` picked per track (a whole or key-less track ignores `ranges`).
  [[nodiscard]] static std::uint64_t mix_frame(const RowPlan& p, const std::vector<KeyRange>& ranges, bool active) noexcept {
    frame_keys::Mix m;
    m.u64(p.clock);
    m.u64(p.exprs);
    if (p.local) m.u64(active ? p.node : 0x1D1EULL);
    for (std::size_t i = 0; i < p.tracks.size(); ++i) {
      const Track& t = p.tracks[i];
      m.str(*t.prop);
      if (t.keyHash.empty()) continue;
      if (t.whole) {
        m.u64(t.allHash);
        continue;
      }
      for (std::ptrdiff_t k = ranges[i].first; k <= ranges[i].second; ++k) m.u64(t.keyHash[static_cast<std::size_t>(k)]);
    }
    return m.value();
  }

  /// The dense reference: one frame, every clock sampled afresh, the per-sample
  /// search of the key range written out (what `spans_of` must agree with).
  [[nodiscard]] std::uint64_t frame_hash(const RowPlan& p, const Clock& c, std::int64_t f) const {
    Samples clocks{};
    Samples comps{};
    for (std::size_t s = 0; s < kSamples; ++s) {
      comps[s] = comp_time(f - kBlurFrames + static_cast<std::int64_t>(s));
      clocks[s] = clock_time(c, comps[s]);
    }
    std::vector<KeyRange> ranges(p.tracks.size());
    for (std::size_t i = 0; i < p.tracks.size(); ++i) {
      const Track& t = p.tracks[i];
      const std::ptrdiff_t n = static_cast<std::ptrdiff_t>(t.keyHash.size());
      if (n == 0 || t.whole) continue;
      std::ptrdiff_t lo = n - 1;
      std::ptrdiff_t hi = 0;
      const Samples& times = t.raw ? comps : clocks;
      for (const double x : times) {
        const std::ptrdiff_t a0 = t.keys != nullptr ? segment(*t.keys, x - p.reach) : segment(t.data->keys, x - p.reach);
        const std::ptrdiff_t a1 = t.keys != nullptr ? segment(*t.keys, x + p.reach) : segment(t.data->keys, x + p.reach);
        lo = std::min(lo, a0 - 1);
        hi = std::max(hi, a1 + 2);
      }
      ranges[i] = KeyRange{std::clamp<std::ptrdiff_t>(lo, 0, n - 1), std::clamp<std::ptrdiff_t>(hi, 0, n - 1)};
    }
    return mix_frame(p, ranges, active_at(p, comps));
  }

  /// Whether a layer draws at any of a frame's sampled comp times (its motion
  /// blur window): an enabled clip covers one, or it has no clips at all.
  [[nodiscard]] static bool active_at(const RowPlan& p, const Samples& comps) noexcept {
    if (!p.local || p.clockSrc == nullptr || p.clockSrc->clips.empty()) return true;
    const Clock& c = *p.clockSrc;
    for (const double t : comps) {
      const double frame = motion::js::round(t * c.fps);
      for (const ClipSpan& k : c.clips) {
        if (k.enabled && frame >= k.start && frame < k.start + k.duration) return true;
      }
    }
    return false;
  }

  /// A layer's spans over the comp's frames. The sampled clocks slide one
  /// frame at a time (one clock_time per frame, not seven); a frame whose key
  /// ranges match the previous frame's has its hash and is skipped; a new
  /// span opens where the hash differs.
  [[nodiscard]] std::vector<Span> spans_of(const Document& d, const Layer& l) const {
    std::vector<Span> spans;
    if (frames_ <= 0) return spans;
    const RowPlan p = plan_of(d, l);
    if (p.constant) {
      spans.push_back(Span{0, frame_hash(p, l.clock, 0)});
      return spans;
    }
    Samples clocks{};
    Samples comps{};
    // Before frame 0: samples 1..kSamples-1 hold frames -kBlurFrames-1+s; the loop shifts them down and adds the last.
    for (std::size_t s = 1; s < kSamples; ++s) {
      comps[s] = comp_time(static_cast<std::int64_t>(s) - 1 - kBlurFrames);
      clocks[s] = clock_time(l.clock, comps[s]);
    }
    std::vector<KeyRange> prev(p.tracks.size(), KeyRange{-1, -1});
    std::vector<KeyRange> cur(p.tracks.size(), KeyRange{-1, -1});
    bool prevActive = true;
    for (std::int64_t f = 0; f < frames_; ++f) {
      for (std::size_t s = 0; s + 1 < kSamples; ++s) {
        comps[s] = comps[s + 1];
        clocks[s] = clocks[s + 1];
      }
      comps[kSamples - 1] = comp_time(f + kBlurFrames);
      clocks[kSamples - 1] = clock_time(l.clock, comps[kSamples - 1]);
      bool same = f > 0;
      for (std::size_t i = 0; i < p.tracks.size(); ++i) {
        const Track& t = p.tracks[i];
        if (t.keyHash.empty() || t.whole) continue;
        cur[i] = key_range(t, t.raw ? comps : clocks, p.reach);
        if (cur[i] != prev[i]) same = false;
      }
      const bool active = active_at(p, comps);
      if (active != prevActive) same = false;
      if (same) continue;
      prevActive = active;
      prev.swap(cur);
      const std::uint64_t h = mix_frame(p, prev, active);
      if (spans.empty() || spans.back().hash != h) spans.push_back(Span{f, h});
    }
    return spans;
  }

  [[nodiscard]] std::uint64_t static_of(const Document& d) {
    frame_keys::Mix m;
    m.str(mediaBase_);
    m.str(comp_);
    m.flag(global_);
    for (const Layer& l : layers_) {
      if (!l.local) m.u64(node_hash(d, l.id));  // a local layer's props are in its spans
      m.flag(l.local);
      m.flag(l.nested);
      m.flag(l.whole);
      if (l.nested) m.u64(l.constant);
    }
    for (const std::string& c : compList_) {
      m.str(c);
      if (const Json* rec = d.comp(c)) m.u64(frame_keys::hash_json(*rec));
      m.u64(node_hash(d, c));  // the root: its children order is the paint order
      if (const Timeline* t = d.timeline(c)) {
        m.f64(t->fps);
        m.f64(t->duration);
        m.flag(t->workArea.has_value());
        if (t->workArea) {
          m.f64(t->workArea->start);
          m.f64(t->workArea->duration);
        }
        // Markers reach a frame only through an expression (marker.key(n), .comment).
        if (exprs_) {
          for (const TMarker& k : t->markers) {
            m.str(k.id);
            m.f64(k.frame);
            m.f64(k.duration);
            m.str(k.name);
            m.str(k.comment);
          }
        }
        for (const Bar& b : t->bars) {
          m.str(b.id);
          m.f64(b.clip.start);
          m.f64(b.clip.duration);
          m.f64(b.clip.sourceIn);
          m.opt(b.clip.sourceDuration);
          m.flag(b.enabled);
          m.str(b.sourceId.value_or(""));
          if (exprs_) {
            for (const TMarker& k : b.markers) {
              m.str(k.id);
              m.f64(k.frame);
              m.f64(k.duration);
              m.str(k.name);
              m.str(k.comment);
            }
          }
        }
      }
      m.u64(frame_keys::hash_json(d.transitions().at(c)));
    }
    // An asset's file and decode settings, not how the Project panel shows it.
    for (const Json& asset : d.items().assets) {
      if (!asset.is_object()) {
        m.u64(frame_keys::hash_json(asset));
        continue;
      }
      for (const Json::Member& e : asset.obj()) {
        if (e.value.is_undefined() || frame_keys::asset_label_field(e.key)) continue;
        m.str(e.key);
        frame_keys::mix_json(m, e.value);
      }
    }
    // The project settings a frame reads: precision, working space, OCIO.
    const api::ProjectSettings& ps = d.project();
    m.u64(static_cast<std::uint64_t>(ps.bit_depth));
    m.u64(static_cast<std::uint64_t>(ps.working_space));
    m.flag(ps.linear_blending);
    m.str(ps.ocio_config);
    if (exprs_) {  // what an expression may read of them
      m.u64(static_cast<std::uint64_t>(ps.expression_engine));
      m.u64(ps.frames_start_at);
    }
    const MotionBlur& mb = d.motion_blur();
    m.flag(mb.enabled);
    m.f64(mb.shutterAngle);
    m.f64(mb.shutterPhase);
    m.f64(mb.samples);
    m.f64(mb.adaptiveSampleLimit);
    const ColorMgmt& cm = d.color();
    m.str(cm.workingSpace);
    m.str(cm.displayTransform);
    m.f64(cm.bitDepth);
    m.u64(frame_keys::hash_json(d.materials()));
    return m.value();
  }

  std::string comp_;
  std::string mediaBase_;
  bool indexed_ = false;
  bool volatile_ = false;
  bool global_ = false;
  bool exprs_ = false;  ///< any enabled expression: layer names may be read
  std::int64_t frames_ = 0;
  double fps_ = 30;
  std::uint64_t static_ = 0;
  std::vector<Layer> layers_;
  std::unordered_map<std::string, std::size_t> layerIndex_;
  std::vector<std::string> compList_;  ///< the comp and every instanced comp reached, sorted
  std::unordered_map<std::string, std::uint64_t> nodeHash_;
  std::vector<std::uint64_t> total_;  ///< per frame: the sum of the layers' span hashes (dense: `key` is one load)
  std::size_t budget_ = kMinBudgetBytes;  ///< set_budget_bytes; the Session sets it from the machine's RAM
  std::size_t bytes_ = 0;                 ///< total_ + every layer's spans
};

}  // namespace premation::doc
