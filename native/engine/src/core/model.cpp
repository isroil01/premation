#include "model.hpp"

#include <utility>

namespace premation::doc {

// ── Node ─────────────────────────────────────────────────────────────────

const Component* Node::comp(std::string_view type) const noexcept {
  for (const auto& c : components) {
    if (c.type == type) return &c;
  }
  return nullptr;
}
Component* Node::comp_mut(std::string_view type) noexcept {
  for (auto& c : components) {
    if (c.type == type) return &c;
  }
  return nullptr;
}
const Component* Node::comp_by_id(std::string_view cid) const noexcept {
  for (const auto& c : components) {
    if (c.id == cid) return &c;
  }
  return nullptr;
}
const Component* Node::comp_with_number(std::string_view key) const noexcept {
  for (const auto& c : components) {
    const Json* v = c.props.find(key);
    if (v != nullptr && v->is_number()) return &c;
  }
  return nullptr;
}
std::string Node::kind() const {
  for (const auto& c : components) {
    const Json* k = c.props.find("__kind");
    if (k != nullptr && k->is_string()) return k->str();
  }
  return "shape";
}
const Json& Node::fx() const noexcept {
  static const Json kEmpty = Json::object();
  const Component* c = comp("fx");
  return c != nullptr ? c->props : kEmpty;
}

api::ProjectSettings default_project_settings() {
  api::ProjectSettings s;
  s.bit_depth = api::BitDepth::u8;
  s.working_space = api::ColorWorkingSpace::srgb_linear;
  s.linear_blending = false;
  s.ocio_config = "";
  s.time_display = api::TimeDisplay::timecode;
  s.expression_engine = api::ExpressionEngine::premation;
  s.frames_start_at = 0;
  s.audio_sample_rate = 48000;
  return s;
}

// ── Parts / ChangeSet ────────────────────────────────────────────────────

bool Parts::empty() const noexcept {
  return nodes.empty() && anims.empty() && comps.empty() && timelines.empty() && !nodeOrder && !compOrder &&
         !tlOrder && !items && !project && !rq && !mb && !cm;
}

namespace {

template <class M>
void merge_map_after(M& mine, const M& later) {
  for (const auto& [k, v] : later) mine.insert_or_assign(k, v);
}
template <class M>
void merge_map_before(M& mine, const M& later) {
  for (const auto& [k, v] : later) mine.emplace(k, v);  // first seen wins
}
template <class O>
void merge_opt_after(O& mine, const O& later) {
  if (later) mine = later;
}
template <class O>
void merge_opt_before(O& mine, const O& later) {
  if (!mine && later) mine = later;
}

template <class T>
bool same(const Ptr<T>& a, const Ptr<T>& b) {
  if (a == b) return true;
  if (!a || !b) return false;
  return *a == *b;
}

template <class M>
void prune_map(M& before, M& after) {
  for (auto it = before.begin(); it != before.end();) {
    const auto a = after.find(it->first);
    const bool equal = a != after.end() && same(it->second, a->second);
    if (equal) {
      after.erase(a);
      it = before.erase(it);
    } else {
      ++it;
    }
  }
}
template <class O>
void prune_opt(O& before, O& after) {
  if (before && after && same(*before, *after)) {
    before.reset();
    after.reset();
  }
}

}  // namespace

void ChangeSet::merge(const ChangeSet& later) {
  merge_map_before(before.nodes, later.before.nodes);
  merge_map_before(before.anims, later.before.anims);
  merge_map_before(before.comps, later.before.comps);
  merge_map_before(before.timelines, later.before.timelines);
  merge_opt_before(before.nodeOrder, later.before.nodeOrder);
  merge_opt_before(before.compOrder, later.before.compOrder);
  merge_opt_before(before.tlOrder, later.before.tlOrder);
  merge_opt_before(before.items, later.before.items);
  merge_opt_before(before.project, later.before.project);
  merge_opt_before(before.rq, later.before.rq);
  merge_opt_before(before.mb, later.before.mb);
  merge_opt_before(before.cm, later.before.cm);
  merge_map_after(after.nodes, later.after.nodes);
  merge_map_after(after.anims, later.after.anims);
  merge_map_after(after.comps, later.after.comps);
  merge_map_after(after.timelines, later.after.timelines);
  merge_opt_after(after.nodeOrder, later.after.nodeOrder);
  merge_opt_after(after.compOrder, later.after.compOrder);
  merge_opt_after(after.tlOrder, later.after.tlOrder);
  merge_opt_after(after.items, later.after.items);
  merge_opt_after(after.project, later.after.project);
  merge_opt_after(after.rq, later.after.rq);
  merge_opt_after(after.mb, later.after.mb);
  merge_opt_after(after.cm, later.after.cm);
}

void ChangeSet::prune() {
  prune_map(before.nodes, after.nodes);
  prune_map(before.anims, after.anims);
  prune_map(before.comps, after.comps);
  prune_map(before.timelines, after.timelines);
  prune_opt(before.nodeOrder, after.nodeOrder);
  prune_opt(before.compOrder, after.compOrder);
  prune_opt(before.tlOrder, after.tlOrder);
  prune_opt(before.items, after.items);
  prune_opt(before.project, after.project);
  prune_opt(before.rq, after.rq);
  prune_opt(before.mb, after.mb);
  prune_opt(before.cm, after.cm);
}

ChangeSet ChangeSet::reversed() const {
  ChangeSet r;
  r.before = after;
  r.after = before;
  return r;
}

std::vector<std::string> ChangeSet::keys() const {
  std::vector<std::string> out;
  for (const auto& [k, v] : before.nodes) out.push_back("node:" + k);
  for (const auto& [k, v] : before.anims) out.push_back("anim:" + k);
  for (const auto& [k, v] : before.comps) out.push_back("comp:" + k);
  for (const auto& [k, v] : before.timelines) out.push_back("tl:" + k);
  if (before.nodeOrder) out.emplace_back("order");
  if (before.compOrder) out.emplace_back("comporder");
  if (before.tlOrder) out.emplace_back("tlorder");
  if (before.items) out.emplace_back("items");
  if (before.project) out.emplace_back("project");
  if (before.rq) out.emplace_back("rq");
  if (before.mb) out.emplace_back("mb");
  if (before.cm) out.emplace_back("cm");
  return out;
}

// ── Document ─────────────────────────────────────────────────────────────

Document::Document()
    : items_(std::make_shared<Items>()),
      project_(std::make_shared<api::ProjectSettings>(default_project_settings())),
      rq_(std::make_shared<RenderQueue>()),
      mb_(std::make_shared<MotionBlur>()),
      cm_(std::make_shared<ColorMgmt>()) {}

const Node* Document::node(std::string_view id) const {
  const auto* p = nodes_.find(id);
  return p != nullptr ? p->get() : nullptr;
}
const NodeAnim* Document::anim(std::string_view id) const {
  const auto* p = anims_.find(id);
  return p != nullptr ? p->get() : nullptr;
}
const Json* Document::comp(std::string_view id) const {
  const auto* p = comps_.find(id);
  return p != nullptr ? p->get() : nullptr;
}
const Timeline* Document::timeline(std::string_view c) const {
  const auto* p = timelines_.find(c);
  return p != nullptr ? p->get() : nullptr;
}

void Document::note_node(std::string_view id) {
  if (!journal_ || journal_->nodes.contains(id)) return;
  const auto* p = nodes_.find(id);
  journal_->nodes.emplace(std::string(id), p != nullptr ? *p : Ptr<Node>());
}
void Document::note_anim(std::string_view id) {
  if (!journal_ || journal_->anims.contains(id)) return;
  const auto* p = anims_.find(id);
  journal_->anims.emplace(std::string(id), p != nullptr ? *p : Ptr<NodeAnim>());
}
void Document::note_comp(std::string_view id) {
  if (!journal_ || journal_->comps.contains(id)) return;
  const auto* p = comps_.find(id);
  journal_->comps.emplace(std::string(id), p != nullptr ? *p : Ptr<Json>());
}
void Document::note_tl(std::string_view id) {
  if (!journal_ || journal_->timelines.contains(id)) return;
  const auto* p = timelines_.find(id);
  journal_->timelines.emplace(std::string(id), p != nullptr ? *p : Ptr<Timeline>());
}
void Document::note_node_order() {
  if (journal_ && !journal_->nodeOrder) journal_->nodeOrder = std::make_shared<IdList>(nodes_.keys());
}
// The composition records and the timeline registry have NO order part in the
// TypeScript engine (state.ts): a record restored by undo is re-inserted and
// so lands at the END of `projectStore.comps` / the controller's registry, and
// the engine reports items in that order. Journaling an order here would put
// it back in place and diverge — so these are deliberately not journaled.
void Document::note_comp_order() {}
void Document::note_tl_order() {}

Node& Document::node_mut(std::string_view id) {
  note_node(id);
  tlTouched_.emplace(id);
  return unshare(*nodes_.find(id));
}

Node& Document::add_node(Node n, std::optional<std::size_t> index) {
  const std::string id = n.id;
  note_node(id);
  tlTouched_.insert(id);
  note_node_order();
  auto p = std::make_shared<Node>(std::move(n));
  if (index) return *nodes_.insert_at(*index, id, std::move(p));
  return *nodes_.set(id, std::move(p));
}

void Document::remove_node_only(std::string_view id) {
  if (!nodes_.contains(id)) return;
  note_node(id);
  tlTouched_.emplace(id);
  note_node_order();
  nodes_.erase(id);
}

NodeAnim& Document::anim_mut(std::string_view id) {
  note_anim(id);
  if (auto* p = anims_.find(id)) return unshare(*p);
  return *anims_.set(id, std::make_shared<NodeAnim>());
}

void Document::set_anim(std::string_view id, std::optional<NodeAnim> a) {
  note_anim(id);
  if (!a || a->empty()) {
    anims_.erase(id);
    return;
  }
  anims_.set(id, std::make_shared<NodeAnim>(std::move(*a)));
}

Json& Document::comp_mut(std::string_view id) {
  note_comp(id);
  if (auto* p = comps_.find(id)) return unshare(*p);
  note_comp_order();
  return *comps_.set(id, std::make_shared<Json>(Json::object()));
}

void Document::remove_comp(std::string_view id) {
  if (!comps_.contains(id)) return;
  note_comp(id);
  note_comp_order();
  comps_.erase(id);
}

Timeline& Document::timeline_mut(std::string_view c) {
  note_tl(c);
  if (auto* p = timelines_.find(c)) return unshare(*p);
  note_tl_order();
  return *timelines_.set(c, std::make_shared<Timeline>());
}

void Document::remove_timeline(std::string_view c) {
  if (!timelines_.contains(c)) return;
  note_tl(c);
  note_tl_order();
  timelines_.erase(c);
}

Items& Document::items_mut() {
  if (journal_ && !journal_->items) journal_->items = items_;
  return unshare(items_);
}
api::ProjectSettings& Document::project_mut() {
  if (journal_ && !journal_->project) journal_->project = project_;
  return unshare(project_);
}
RenderQueue& Document::render_queue_mut() {
  if (journal_ && !journal_->rq) journal_->rq = rq_;
  return unshare(rq_);
}
MotionBlur& Document::motion_blur_mut() {
  if (journal_ && !journal_->mb) journal_->mb = mb_;
  return unshare(mb_);
}
ColorMgmt& Document::color_mut() {
  if (journal_ && !journal_->cm) journal_->cm = cm_;
  return unshare(cm_);
}

void Document::reorder_nodes(const IdList& order) {
  note_node_order();
  nodes_.reorder(order);
}

void Document::begin() { journal_ = std::make_unique<Parts>(); }

Parts Document::current_of(const Parts& keys) const {
  Parts out;
  for (const auto& [k, v] : keys.nodes) {
    const auto* p = nodes_.find(k);
    out.nodes.emplace(k, p != nullptr ? *p : Ptr<Node>());
  }
  for (const auto& [k, v] : keys.anims) {
    const auto* p = anims_.find(k);
    out.anims.emplace(k, p != nullptr ? *p : Ptr<NodeAnim>());
  }
  for (const auto& [k, v] : keys.comps) {
    const auto* p = comps_.find(k);
    out.comps.emplace(k, p != nullptr ? *p : Ptr<Json>());
  }
  for (const auto& [k, v] : keys.timelines) {
    const auto* p = timelines_.find(k);
    out.timelines.emplace(k, p != nullptr ? *p : Ptr<Timeline>());
  }
  if (keys.nodeOrder) out.nodeOrder = std::make_shared<IdList>(nodes_.keys());
  if (keys.compOrder) out.compOrder = std::make_shared<IdList>(comps_.keys());
  if (keys.tlOrder) out.tlOrder = std::make_shared<IdList>(timelines_.keys());
  if (keys.items) out.items = items_;
  if (keys.project) out.project = project_;
  if (keys.rq) out.rq = rq_;
  if (keys.mb) out.mb = mb_;
  if (keys.cm) out.cm = cm_;
  return out;
}

ChangeSet Document::commit() {
  ChangeSet cs;
  if (!journal_) return cs;
  cs.before = std::move(*journal_);
  journal_.reset();
  cs.after = current_of(cs.before);
  cs.prune();
  return cs;
}

void Document::rollback() {
  if (!journal_) return;
  Parts before = std::move(*journal_);
  journal_.reset();
  apply(before);
}

void Document::apply(const Parts& p) {
  tlAllDirty_ = true;  // timelines and nodes arrive together, as a whole state
  // Entities first, then the orders that arrange them.
  for (const auto& [k, v] : p.nodes) {
    note_node(k);
    if (v) {
      if (!nodes_.contains(k)) note_node_order();
      nodes_.set(k, v);
    } else if (nodes_.contains(k)) {
      note_node_order();
      nodes_.erase(k);
    }
  }
  for (const auto& [k, v] : p.anims) {
    note_anim(k);
    if (v) anims_.set(k, v);
    else anims_.erase(k);
  }
  for (const auto& [k, v] : p.comps) {
    note_comp(k);
    if (v) {
      if (!comps_.contains(k)) note_comp_order();
      comps_.set(k, v);
    } else if (comps_.contains(k)) {
      note_comp_order();
      comps_.erase(k);
    }
  }
  for (const auto& [k, v] : p.timelines) {
    note_tl(k);
    if (v) {
      if (!timelines_.contains(k)) note_tl_order();
      timelines_.set(k, v);
    } else if (timelines_.contains(k)) {
      note_tl_order();
      timelines_.erase(k);
    }
  }
  if (p.nodeOrder && *p.nodeOrder) {
    note_node_order();
    nodes_.reorder(**p.nodeOrder);
  }
  if (p.compOrder && *p.compOrder) {
    note_comp_order();
    comps_.reorder(**p.compOrder);
  }
  if (p.tlOrder && *p.tlOrder) {
    note_tl_order();
    timelines_.reorder(**p.tlOrder);
  }
  if (p.items && *p.items) {
    if (journal_ && !journal_->items) journal_->items = items_;
    items_ = *p.items;
  }
  if (p.project && *p.project) {
    if (journal_ && !journal_->project) journal_->project = project_;
    project_ = *p.project;
  }
  if (p.rq && *p.rq) {
    if (journal_ && !journal_->rq) journal_->rq = rq_;
    rq_ = *p.rq;
  }
  if (p.mb && *p.mb) {
    if (journal_ && !journal_->mb) journal_->mb = mb_;
    mb_ = *p.mb;
  }
  if (p.cm && *p.cm) {
    if (journal_ && !journal_->cm) journal_->cm = cm_;
    cm_ = *p.cm;
  }
}

Parts Document::capture_all() const {
  Parts out;
  for (const auto& [k, v] : nodes_) out.nodes.emplace(k, v);
  for (const auto& [k, v] : anims_) out.anims.emplace(k, v);
  for (const auto& [k, v] : comps_) out.comps.emplace(k, v);
  for (const auto& [k, v] : timelines_) out.timelines.emplace(k, v);
  out.nodeOrder = std::make_shared<IdList>(nodes_.keys());
  out.compOrder = std::make_shared<IdList>(comps_.keys());
  out.tlOrder = std::make_shared<IdList>(timelines_.keys());
  out.items = items_;
  out.project = project_;
  out.rq = rq_;
  out.mb = mb_;
  out.cm = cm_;
  return out;
}

}  // namespace premation::doc
