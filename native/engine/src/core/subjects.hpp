// A layer's subjects (setLayerMatte): several per layer, each its own matte
// frames in fx.alphaMatte.frames (tagged `s`; untagged = "s1", the first) and
// its entry in fx.subjects ({id, name, color, hidden, locked, invert, feather,
// choke, contrast, smooth} — `layer/subjects`). A layer with frames and no
// entries has one subject, "s1".
#pragma once

#include "json.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <iterator>
#include <string>
#include <string_view>
#include <vector>

namespace premation::doc {

inline constexpr std::string_view kFirstSubject = "s1";

/// Which subject a stored matte frame belongs to.
inline std::string_view frame_subject(const Json& frame) {
  const Json& s = frame.at("s");
  return s.is_string() && !s.str().empty() ? std::string_view(s.str()) : kFirstSubject;
}

/// The stored frame of `subject` nearest keyframe time `kt` (nullptr: none).
inline const Json* nearest_subject_frame(const Json& alphaMatte, std::string_view subject, double kt) {
  if (!alphaMatte.is_object() || !alphaMatte.at("frames").is_array()) return nullptr;
  const Json* best = nullptr;
  for (const Json& f : alphaMatte.at("frames").arr()) {
    if (!f.at("t").is_number() || !f.at("src").is_string() || frame_subject(f) != subject) continue;
    if (best == nullptr || std::abs(f.at("t").num() - kt) < std::abs(best->at("t").num() - kt)) best = &f;
  }
  return best;
}

/// The subject ids with frames, in fx.subjects order (entries without frames left out), then any others by first frame.
inline std::vector<std::string> subject_ids(const Json& alphaMatte, const Json& entries) {
  std::vector<std::string> withFrames;
  if (alphaMatte.is_object() && alphaMatte.at("frames").is_array())
    for (const Json& f : alphaMatte.at("frames").arr()) {
      const std::string id(frame_subject(f));
      if (std::find(withFrames.begin(), withFrames.end(), id) == withFrames.end()) withFrames.push_back(id);
    }
  std::vector<std::string> out;
  if (entries.is_array())
    for (const Json& e : entries.arr())
      if (e.at("id").is_string() && std::find(withFrames.begin(), withFrames.end(), e.at("id").str()) != withFrames.end() &&
          std::find(out.begin(), out.end(), e.at("id").str()) == out.end())
        out.push_back(e.at("id").str());
  for (std::string& id : withFrames)
    if (std::find(out.begin(), out.end(), id) == out.end()) out.push_back(std::move(id));
  return out;
}

/// The fx.subjects entry of `id` (a null Json when there is none).
inline const Json& subject_entry(const Json& entries, std::string_view id) {
  static const Json kNone;
  if (entries.is_array())
    for (const Json& e : entries.arr())
      if (e.at("id").is_string() && e.at("id").str() == id) return e;
  return kNone;
}

/// The outline mask a subject's edits keep ("Object Matte" for the first, as before several subjects).
inline std::string subject_outline_name(std::string_view id) {
  return id == kFirstSubject ? std::string("Object Matte") : "Object Matte " + std::string(id);
}

/// A layer's stored frames indexed once (stream B3): per subject, its frames sorted by time, so
/// the frame nearest a time is a binary search and the tracked span is read, not scanned. Built
/// from one fx.alphaMatte value and valid while that value lives (it keeps pointers into it).
class SubjectIndex {
 public:
  struct Frame {
    double t = 0;
    const Json* json = nullptr;
  };
  struct Subject {
    std::string id;
    std::vector<Frame> frames;  ///< by time, ascending (frames with a `t` and a `src` only)
    /// Follow's walk (frames every frame or so): the subject is there over [lo − pad, hi + pad]
    /// and nowhere else; a subject selected on one frame, or edited on a few, holds everywhere.
    bool tracked = false;
    double lo = 0;
    double hi = 0;
  };

  SubjectIndex() = default;
  /// `fps`: the comp's rate (a walk is "tracked" when its frames come at most 1.5 frames apart).
  SubjectIndex(const Json& alphaMatte, const Json& entries, double fps) : source_(&alphaMatte), fps_(fps) {
    for (const std::string& id : subject_ids(alphaMatte, entries)) {
      Subject s;
      s.id = id;
      if (alphaMatte.is_object() && alphaMatte.at("frames").is_array())
        for (const Json& f : alphaMatte.at("frames").arr())
          if (f.at("t").is_number() && f.at("src").is_string() && frame_subject(f) == id) s.frames.push_back({f.at("t").num(), &f});
      std::stable_sort(s.frames.begin(), s.frames.end(), [](const Frame& a, const Frame& b) { return a.t < b.t; });
      if (!s.frames.empty()) {
        s.lo = s.frames.front().t;
        s.hi = s.frames.back().t;
        const double pad = 1.0 / std::max(1.0, fps);
        const std::size_t n = s.frames.size();
        s.tracked = n >= 3 && (s.hi - s.lo) / static_cast<double>(n - 1) <= 1.5 * pad;
      }
      subjects_.push_back(std::move(s));
    }
  }

  [[nodiscard]] const std::vector<Subject>& subjects() const noexcept { return subjects_; }
  [[nodiscard]] const Subject* subject(std::string_view id) const noexcept {
    for (const Subject& s : subjects_)
      if (s.id == id) return &s;
    return nullptr;
  }

  /// The index into `s.frames` of the frame nearest `t` (O(log n)); npos when it has none.
  [[nodiscard]] static std::size_t nearest(const Subject& s, double t) noexcept {
    if (s.frames.empty()) return npos;
    const auto it = std::lower_bound(s.frames.begin(), s.frames.end(), t, [](const Frame& f, double v) { return f.t < v; });
    if (it == s.frames.end()) return s.frames.size() - 1;
    if (it == s.frames.begin()) return 0;
    const auto before = std::prev(it);
    // The earlier frame wins a tie, as the linear scan did (strict < on the distance).
    return std::abs(before->t - t) <= std::abs(it->t - t) ? static_cast<std::size_t>(before - s.frames.begin())
                                                         : static_cast<std::size_t>(it - s.frames.begin());
  }
  /// Whether a tracked subject is away at `t` (outside its span and a frame's pad either side).
  [[nodiscard]] static bool away(const Subject& s, double t, double fps) noexcept {
    const double pad = 1.0 / std::max(1.0, fps);
    return s.tracked && (t < s.lo - pad || t > s.hi + pad);
  }

  /// Whether this index was built from `alphaMatte` at `fps` (a memo's validity check).
  [[nodiscard]] bool built_from(const Json& alphaMatte, double fps) const noexcept { return source_ == &alphaMatte && fps_ == fps; }

  static constexpr std::size_t npos = static_cast<std::size_t>(-1);

 private:
  std::vector<Subject> subjects_;
  const Json* source_ = nullptr;
  double fps_ = 0;
};

}  // namespace premation::doc
