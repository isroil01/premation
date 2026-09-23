// Structural invariants of a Document that must hold after ANY request
// sequence — checked by the stress test and the fuzzer after every step.
#pragma once

#include <set>
#include <string>

#include "core/document.hpp"

namespace premation::test {

inline bool document_consistent(const doc::Document& d, std::string& why) {
  std::set<std::string> seenLayers;
  for (const auto& [id, comp] : d.comps) {
    if (comp.id != id) {
      why = "comp key/id mismatch";
      return false;
    }
    for (const auto& lid : comp.layers) {
      const doc::Layer* l = d.layer(lid);
      if (l == nullptr) {
        why = "comp " + id + " lists missing layer " + lid;
        return false;
      }
      if (l->comp != id) {
        why = "layer " + lid + " is listed by the wrong comp";
        return false;
      }
      if (!seenLayers.insert(lid).second) {
        why = "layer " + lid + " listed twice";
        return false;
      }
    }
  }
  for (const auto& [id, layer] : d.layers) {
    if (layer.id != id) {
      why = "layer key/id mismatch";
      return false;
    }
    if (seenLayers.count(id) == 0) {
      why = "layer " + id + " is in no comp's stack";
      return false;
    }
    for (const auto& [path, prop] : layer.props) {
      for (std::size_t i = 1; i < prop.keys.size(); ++i) {
        if (!(prop.keys[i - 1].time < prop.keys[i].time)) {
          why = "keys of " + id + "/" + path + " are not strictly increasing";
          return false;
        }
      }
      for (const auto& k : prop.keys) {
        if (doc::value_type_of(k.value) != prop.type) {
          why = "key of the wrong type on " + id + "/" + path;
          return false;
        }
      }
      if (doc::value_type_of(prop.value) != prop.type) {
        why = "static value of the wrong type on " + id + "/" + path;
        return false;
      }
    }
  }
  if (d.itemOrder.size() != d.comps.size()) {
    why = "itemOrder does not match comps";
    return false;
  }
  return true;
}

}  // namespace premation::test
