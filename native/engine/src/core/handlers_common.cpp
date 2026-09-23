#include "handlers_common.hpp"

#include <algorithm>
#include <map>
#include <set>

#include "fxstate.hpp"
#include "readmodel.hpp"
#include "time_conv.hpp"

namespace premation::doc {

using api::ErrorCode;

const Node& require_layer(const Document& d, std::string_view id) {
  const Node* n = d.node(id);
  if (n == nullptr || !n->parent) fail(ErrorCode::not_found, "no layer '" + std::string(id) + "'", {.layer = std::string(id)});
  return *n;
}

void require_comp(const Document& d, std::string_view id) {
  if (!is_comp_item(d, id)) fail(ErrorCode::not_found, "no composition '" + std::string(id) + "'", {.item = std::string(id)});
}

ItemRef require_item(const Document& d, std::string_view id) {
  auto r = resolve_item(d, id);
  if (!r) fail(ErrorCode::not_found, "no item '" + std::string(id) + "'", {.item = std::string(id)});
  return *r;
}

void ensure_timeline(Document& d, std::string_view comp) { (void)tl_ensure(d, comp); }

std::string require_layers_in_one_comp(const Document& d, const std::vector<std::string>& ids) {
  if (ids.empty()) fail(ErrorCode::invalid_argument, "no layers given");
  std::optional<std::string> comp;
  for (const auto& id : ids) {
    (void)require_layer(d, id);
    const auto c = comp_of_layer(d, id);
    if (!c) fail(ErrorCode::not_found, "no layer '" + id + "'", {.layer = id});
    if (comp && *c != *comp) fail(ErrorCode::invalid_argument, "all layers must be in the same composition", {.layer = id});
    comp = c;
  }
  const std::set<std::string> unique(ids.begin(), ids.end());
  if (unique.size() != ids.size()) fail(ErrorCode::invalid_argument, "a layer is listed twice");
  return *comp;
}

void remint_key_ids(HCtx& x, std::string_view layer) {
  Document& d = x.d;
  if (const NodeAnim* a = d.anim(layer)) {
    NodeAnim snap = *a;
    bool changed = false;
    // Dimension tracks of one combined key share an id; the copies keep sharing.
    std::map<std::string, std::string> byOld;
    for (auto& [prop, keys] : snap.tracks) {
      for (Key& k : keys) {
        if (!k.id || k.id->empty()) continue;
        auto it = byOld.find(*k.id);
        std::string fresh;
        if (it != byOld.end()) {
          fresh = it->second;
        } else {
          fresh = x.mint_key_id();
          byOld.emplace(*k.id, fresh);
        }
        k.id = fresh;
        changed = true;
      }
    }
    for (auto& [prop, t] : snap.data) {
      for (DataKey& k : t.keys) {
        if (k.id && !k.id->empty()) {
          k.id = x.mint_key_id();
          changed = true;
        }
      }
    }
    if (changed) d.set_anim(layer, std::move(snap));
  }
  if (const Node* n = d.node(layer)) {
    std::vector<Json> anim = read_node_mask_anim(*n);
    const bool any = std::any_of(anim.begin(), anim.end(), [](const Json& k) {
      return k.at("id").is_string() && !k.at("id").str().empty();
    });
    if (any) {
      for (Json& k : anim) {
        if (k.at("id").is_string() && !k.at("id").str().empty()) k.set("id", Json::string(x.mint_key_id()));
      }
      set_mask_anim(d, layer, std::move(anim));
    }
  }
}

void move_in_stack(Document& d, std::string_view comp, const std::vector<std::string>& ids, std::size_t toIndex,
                   const std::set<std::string>* ignore) {
  const Node* first = d.node(ids.at(0));
  if (first == nullptr || !first->parent) fail(ErrorCode::not_found, "no layer '" + ids[0] + "'");
  const std::string parent = *first->parent;
  for (const auto& id : ids) {
    const Node* n = d.node(id);
    if (n == nullptr || n->parent != parent) {
      fail(ErrorCode::invalid_argument, "layers moved together must share a parent (parenting is nesting in this engine)",
           {.layer = id});
    }
  }
  // The layer createLayer just appended is already the front of its comp:
  // moving it to index 0 is a no-op (and this runs once per created layer).
  if (ids.size() == 1 && toIndex == 0 && parent == comp) {
    const Node* p = d.node(parent);
    if (p != nullptr && !p->children.empty() && p->children.back() == ids[0]) return;
  }
  const std::set<std::string> moving(ids.begin(), ids.end());
  const std::vector<std::string> kids = sg_child_order(d, parent);  // back → front
  std::vector<std::string> frontFirst(kids.rbegin(), kids.rend());
  std::vector<std::string> movingOrdered;
  std::vector<std::string> rest;
  for (const auto& id : frontFirst) (moving.contains(id) ? movingOrdered : rest).push_back(id);
  std::vector<std::string> stack;
  for (const auto& id : layer_ids_of_comp(d, comp)) {
    if (!moving.contains(id) && (ignore == nullptr || !ignore->contains(id))) stack.push_back(id);
  }
  std::size_t insertAt = rest.size();
  for (std::size_t i = 0; i < rest.size(); ++i) {
    const auto pos = std::find(stack.begin(), stack.end(), rest[i]);
    // indexOf = -1 when absent (never ≥ toIndex)
    if (pos != stack.end() && static_cast<std::size_t>(pos - stack.begin()) >= toIndex) {
      insertAt = i;
      break;
    }
  }
  std::vector<std::string> next(rest.begin(), rest.begin() + static_cast<std::ptrdiff_t>(insertAt));
  next.insert(next.end(), movingOrdered.begin(), movingOrdered.end());
  next.insert(next.end(), rest.begin() + static_cast<std::ptrdiff_t>(insertAt), rest.end());
  std::reverse(next.begin(), next.end());
  if (!sg_set_child_order(d, parent, next)) fail(ErrorCode::internal, "stack reorder refused");
}

double comp_frames(const Document& d, std::string_view comp, api::Time flicks) {
  return flicks_to_frames(flicks, comp_fps(d, comp));
}

}  // namespace premation::doc
