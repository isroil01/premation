// Change events from a delta (ENGINE_API.md §8.1) — src/core/engine/events.ts.
//
// The engine knows exactly which parts a request changed (the ChangeSet). This
// turns it into the revisioned events a mirror applies: full records, never
// deltas. Property- and keyframe-level events are found by comparing the
// layer's current infos with what this builder last reported for it (its view
// of the mirror); a layer it has never reported emits all its properties once.
#pragma once

#include <map>
#include <string>
#include <unordered_map>
#include <vector>

#include "engine_api.hpp"
#include "model.hpp"
#include "props.hpp"

namespace premation::doc {

class EventBuilder {
 public:
  void reset() {
    props_.clear();
    keys_.clear();
  }
  void forget(const std::string& layer) {
    props_.erase(layer);
    keys_.erase(layer);
  }
  /// Events for `changes` (before = changes.before, after = the live document).
  [[nodiscard]] std::vector<api::Event> build(const ChangeSet& changes, const PCtx& c);

 private:
  void layer_properties(const PCtx& c, const std::string& layer, std::vector<api::Event>& events);
  void layer_keyframes(const PCtx& c, const std::string& layer, std::vector<api::KeyframeSet>& out);

  struct PropCache {
    std::map<std::string, api::PropertyInfo> infos;
    std::map<std::string, std::string> groups;  ///< `#children:<parent>` → signature
  };
  std::unordered_map<std::string, PropCache> props_;
  std::unordered_map<std::string, std::map<std::string, std::vector<api::Keyframe>>> keys_;
};

}  // namespace premation::doc
