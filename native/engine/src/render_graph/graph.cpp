#include "graph.hpp"

#include <algorithm>
#include <deque>
#include <map>
#include <unordered_map>

namespace premation::rg {

bool RenderGraph::add_pass(std::unique_ptr<RenderPass> p) {
  if (!p || pass(p->name()) != nullptr) return false;
  passes_.push_back(std::move(p));
  compiled_.reset();
  return true;
}

bool RenderGraph::remove_pass(std::string_view name) {
  const auto it = std::ranges::find_if(passes_, [&](const auto& p) { return p->name() == name; });
  if (it == passes_.end()) return false;
  passes_.erase(it);
  compiled_.reset();
  return true;
}

RenderPass* RenderGraph::pass(std::string_view name) const {
  for (const auto& p : passes_) {
    if (p->name() == name) return p.get();
  }
  return nullptr;
}

void RenderGraph::declare_target(std::string name, TargetDeclFn descriptor) {
  for (auto& t : targets_) {
    if (t.name == name) {
      t.descriptor = std::move(descriptor);
      return;
    }
  }
  targets_.push_back({std::move(name), std::move(descriptor)});
}

bool RenderGraph::compile(std::vector<RenderPass*>& order, std::string& error) {
  if (compiled_) {
    order = *compiled_;
    return true;
  }
  std::vector<RenderPass*> active;
  for (const auto& p : passes_) {
    if (p->enabled) active.push_back(p.get());
  }
  const std::size_t n = active.size();
  std::unordered_map<std::string, std::size_t> index;
  for (std::size_t i = 0; i < n; ++i) index.emplace(std::string(active[i]->name()), i);

  // Producers of each resource, in insertion order.
  std::map<std::string, std::vector<std::size_t>> producers;
  for (std::size_t i = 0; i < n; ++i) {
    for (const auto& w : active[i]->writes()) producers[w].push_back(i);
  }
  // adjacency as insertion-ordered sets (TS Set semantics: first link wins the slot).
  std::vector<std::vector<std::size_t>> adj(n);
  std::vector<std::size_t> indeg(n, 0);
  const auto link = [&](std::size_t from, std::size_t to) {
    if (from == to) return;
    auto& out = adj[from];
    if (std::ranges::find(out, to) != out.end()) return;
    out.push_back(to);
    ++indeg[to];
  };
  for (std::size_t i = 0; i < n; ++i) {
    for (const auto& r : active[i]->reads()) {
      const auto it = producers.find(r);
      if (it == producers.end()) continue;
      for (const std::size_t prod : it->second) link(prod, i);
    }
    for (const auto& a : active[i]->after()) {
      const auto it = index.find(a);
      if (it != index.end()) link(it->second, i);
    }
  }
  std::deque<std::size_t> ready;
  for (std::size_t i = 0; i < n; ++i) {
    if (indeg[i] == 0) ready.push_back(i);
  }
  std::vector<RenderPass*> result;
  result.reserve(n);
  while (!ready.empty()) {
    const std::size_t i = ready.front();
    ready.pop_front();
    result.push_back(active[i]);
    for (const std::size_t next : adj[i]) {
      if (--indeg[next] == 0) ready.push_back(next);
    }
  }
  if (result.size() != n) {
    error = "cycle in render graph among:";
    for (std::size_t i = 0; i < n; ++i) {
      if (std::ranges::find(result, active[i]) == result.end()) {
        error += ' ';
        error += active[i]->name();
      }
    }
    return false;
  }
  compiled_ = std::make_unique<std::vector<RenderPass*>>(result);
  order = std::move(result);
  return true;
}

std::unordered_set<std::string> RenderGraph::orphaned_targets() const {
  std::unordered_set<std::string> declared;
  std::unordered_set<std::string> writable;
  for (const auto& p : passes_) {
    for (const auto& w : p->writes()) {
      declared.insert(w);
      if (p->enabled) writable.insert(w);
    }
  }
  std::unordered_set<std::string> out;
  for (const auto& d : declared) {
    if (writable.find(d) == writable.end()) out.insert(d);
  }
  return out;
}

std::vector<std::pair<std::string, TargetDesc>> RenderGraph::active_targets(std::uint32_t w, std::uint32_t h) const {
  const auto orphaned = orphaned_targets();
  std::vector<std::pair<std::string, TargetDesc>> out;
  for (const auto& t : targets_) {
    if (orphaned.find(t.name) != orphaned.end()) continue;
    out.emplace_back(t.name, t.descriptor(w, h));
  }
  return out;
}

std::vector<std::string> RenderGraph::pass_names() const {
  std::vector<std::string> out;
  out.reserve(passes_.size());
  for (const auto& p : passes_) out.emplace_back(p->name());
  return out;
}

void RenderGraph::execute(PassContext& ctx, const std::function<void()>& abortOpenPass,
                          std::vector<GraphDiagnostic>& diags) {
  std::vector<RenderPass*> order;
  std::string error;
  if (!compile(order, error)) {
    diags.push_back({"pass-failed", "Frame composition failed: " + error});
    return;
  }
  for (RenderPass* p : order) {
    error.clear();
    if (!p->execute(ctx, error)) {
      if (abortOpenPass) abortOpenPass();
      diags.push_back({"pass-failed", "Render pass \"" + std::string(p->name()) + "\" failed and was skipped: " + error});
    }
  }
}

}  // namespace premation::rg
