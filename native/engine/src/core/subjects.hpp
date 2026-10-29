// A layer's subjects (setLayerMatte): several per layer, each its own matte
// frames in fx.alphaMatte.frames (tagged `s`; untagged = "s1", the first) and
// its entry in fx.subjects ({id, name, color, hidden, locked, invert, feather,
// choke, contrast, smooth} — `layer/subjects`). A layer with frames and no
// entries has one subject, "s1".
#pragma once

#include "json.hpp"

#include <algorithm>
#include <cmath>
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

}  // namespace premation::doc
