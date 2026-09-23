// Structural invariants of a Document that must hold after ANY request
// sequence — checked by the stress test and the fuzzer after every step —
// and a value snapshot of the whole document for undo/redo round trips.
#pragma once

#include <cmath>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "core/model.hpp"
#include "core/timeline.hpp"

namespace premation::test {

inline bool document_consistent(const doc::Document& d, std::string& why) {
  // Scene graph: keys match ids; parent/child links agree both ways; no cycles.
  for (const auto& [id, np] : d.nodes()) {
    if (!np) {
      why = "node " + id + " is a null entry";
      return false;
    }
    const doc::Node& n = *np;
    if (n.id != id) {
      why = "node key/id mismatch: " + id;
      return false;
    }
    if (n.parent) {
      const doc::Node* p = d.node(*n.parent);
      if (p == nullptr) {
        why = "node " + id + " has a missing parent " + *n.parent;
        return false;
      }
      std::size_t listed = 0;
      for (const auto& c : p->children) listed += c == id ? 1U : 0U;
      if (listed != 1) {
        why = "node " + id + " is listed " + std::to_string(listed) + " times by its parent";
        return false;
      }
    }
    std::set<std::string> kids;
    for (const auto& c : n.children) {
      const doc::Node* k = d.node(c);
      if (k == nullptr || k->parent != id) {
        why = "node " + id + " lists child " + c + " that does not point back";
        return false;
      }
      if (!kids.insert(c).second) {
        why = "node " + id + " lists child " + c + " twice";
        return false;
      }
    }
    std::set<std::string> seen{id};
    for (auto up = n.parent; up; up = d.node(*up)->parent) {
      if (!seen.insert(*up).second) {
        why = "parent cycle through " + id;
        return false;
      }
    }
    std::set<std::string> compTypes;
    for (const auto& c : n.components) {
      if (!compTypes.insert(c.type).second) {
        why = "node " + id + " has two " + c.type + " components";
        return false;
      }
    }
  }
  // Compositions: every record has its root node.
  for (const auto& [id, rec] : d.comps()) {
    if (!rec) continue;
    const doc::Node* root = d.node(id);
    if (root == nullptr || root->parent) {
      why = "comp " + id + " has no root node";
      return false;
    }
  }
  // Animation: keys on the axis are finite and in time order.
  for (const auto& [id, ap] : d.anims()) {
    if (!ap) continue;
    for (const auto& [prop, keys] : ap->tracks) {
      for (std::size_t i = 0; i < keys.size(); ++i) {
        if (!std::isfinite(keys[i].t)) {
          why = "non-finite key time on " + id + "/" + prop;
          return false;
        }
        if (i > 0 && keys[i - 1].t > keys[i].t) {
          why = "keys of " + id + "/" + prop + " are out of order";
          return false;
        }
      }
    }
  }
  // Timelines agree with the scene exactly as a full syncFromScene would leave
  // them (the per-command sync is incremental).
  for (const auto& [comp, tp] : d.timelines()) {
    if (tp && !doc::tl_in_sync(d, comp)) {
      why = "timeline " + comp + " is out of sync with the scene";
      return false;
    }
  }
  // Timelines: unique bar ids, finite non-negative geometry, sorted markers.
  for (const auto& [comp, tp] : d.timelines()) {
    if (!tp) continue;
    std::set<std::string> ids;
    for (const auto& b : tp->bars) {
      if (!ids.insert(b.id).second) {
        why = "timeline " + comp + " has two bars " + b.id;
        return false;
      }
      if (!std::isfinite(b.clip.start) || !std::isfinite(b.clip.duration) || b.clip.duration < 0) {
        why = "bad clip geometry on " + comp + "/" + b.id;
        return false;
      }
    }
    for (std::size_t i = 1; i < tp->markers.size(); ++i) {
      if (tp->markers[i - 1].frame > tp->markers[i].frame) {
        why = "comp markers of " + comp + " are out of order";
        return false;
      }
    }
  }
  return true;
}

/// The document's VALUE, order-insensitive where TS is (a restored comp or
/// timeline re-enters at the end), for exact undo/redo comparisons.
struct DocState {
  std::map<std::string, doc::Node> nodes;
  std::map<std::string, doc::NodeAnim> anims;  ///< empty animations are "absent"
  std::map<std::string, doc::Json> comps;
  std::map<std::string, doc::Timeline> timelines;
  doc::Items items;
  api::ProjectSettings project;
  doc::RenderQueue rq;
  doc::MotionBlur mb;
  doc::ColorMgmt cm;
  friend bool operator==(const DocState&, const DocState&) = default;
};

inline DocState state_of(const doc::Document& d) {
  DocState s;
  for (const auto& [id, p] : d.nodes()) {
    if (p) s.nodes.emplace(id, *p);
  }
  for (const auto& [id, p] : d.anims()) {
    if (p && !p->empty()) s.anims.emplace(id, *p);
  }
  for (const auto& [id, p] : d.comps()) {
    if (p) s.comps.emplace(id, *p);
  }
  for (const auto& [id, p] : d.timelines()) {
    if (p) s.timelines.emplace(id, *p);
  }
  s.items = d.items();
  s.project = d.project();
  s.rq = d.render_queue();
  s.mb = d.motion_blur();
  s.cm = d.color();
  return s;
}

/// Which part of two states differs first (for a readable failure).
inline std::string first_difference(const DocState& a, const DocState& b) {
  auto diff_map = [](const auto& x, const auto& y, const char* what) -> std::string {
    for (const auto& [k, v] : x) {
      const auto it = y.find(k);
      if (it == y.end()) return std::string(what) + " " + k + " only on the left";
      if (!(it->second == v)) return std::string(what) + " " + k + " differs";
    }
    for (const auto& [k, v] : y) {
      if (!x.contains(k)) return std::string(what) + " " + k + " only on the right";
    }
    return {};
  };
  for (auto s : {diff_map(a.nodes, b.nodes, "node"), diff_map(a.anims, b.anims, "anim"),
                 diff_map(a.comps, b.comps, "comp"), diff_map(a.timelines, b.timelines, "timeline")}) {
    if (!s.empty()) return s;
  }
  if (!(a.items == b.items)) return "items differ";
  if (!(a.project == b.project)) return "project settings differ";
  if (!(a.rq == b.rq)) return "render queue differs";
  if (!(a.mb == b.mb) || !(a.cm == b.cm)) return "motion blur / colour differ";
  return {};
}

}  // namespace premation::test
