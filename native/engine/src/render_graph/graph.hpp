// The render graph — the C++ twin of packages/renderer/src/rendergraph/
// RenderGraph.ts + RenderPass.ts.
//
// Passes declare what they read, what they write and whom they run after; the
// graph derives the order (Kahn's algorithm, ties broken by insertion order, so
// the order is deterministic and identical to the TS graph's), detects cycles,
// and executes each pass in isolation: a pass that fails is skipped, whatever
// render pass it left open is closed, and a `pass-failed` diagnostic says what
// was lost (the TS per-pass error guard). No exceptions: a pass returns false.
//
// Transient targets are DECLARED here (name → descriptor from the viewport
// size) and allocated by the resource layer, deduped by name + size, so a
// target is reused across frames and reallocated only on a resize. Targets
// whose only writers are disabled passes are not allocated at all
// (`orphanedTargets`).
//
// GPU-free: the graph never touches Dawn. PassContext is defined by the GPU
// layer (render_context.hpp); the graph only forwards it.
#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>

namespace premation::rg {

inline constexpr std::string_view kSurface = "surface";

struct PassContext;  // render_context.hpp

class RenderPass {
 public:
  RenderPass() = default;
  virtual ~RenderPass() = default;
  RenderPass(const RenderPass&) = delete;
  RenderPass& operator=(const RenderPass&) = delete;
  RenderPass(RenderPass&&) = delete;
  RenderPass& operator=(RenderPass&&) = delete;

  [[nodiscard]] virtual std::string_view name() const = 0;
  [[nodiscard]] virtual std::vector<std::string> reads() const { return {}; }
  [[nodiscard]] virtual std::vector<std::string> writes() const { return {std::string(kSurface)}; }
  [[nodiscard]] virtual std::vector<std::string> after() const { return {}; }
  /// Record this pass. False (with `error`) = the pass failed and is skipped.
  virtual bool execute(PassContext& ctx, std::string& error) = 0;

  bool enabled = true;
};

/// A transient render target's descriptor (RenderTargetDescriptor).
struct TargetDesc {
  std::uint32_t width = 1;
  std::uint32_t height = 1;
  /// 'rgba16float' | 'rgba8unorm' | … (the TS names).
  std::string format = "rgba16float";
  bool depth = false;
  std::uint32_t samples = 1;
};

using TargetDeclFn = std::function<TargetDesc(std::uint32_t viewportW, std::uint32_t viewportH)>;

struct TargetDecl {
  std::string name;
  TargetDeclFn descriptor;
};

struct GraphDiagnostic {
  std::string code;
  std::string detail;
};

class RenderGraph {
 public:
  /// False when a pass of that name exists (duplicate-pass).
  bool add_pass(std::unique_ptr<RenderPass> pass);
  bool remove_pass(std::string_view name);
  [[nodiscard]] RenderPass* pass(std::string_view name) const;
  void declare_target(std::string name, TargetDeclFn descriptor);
  void invalidate() noexcept { compiled_.reset(); }

  /// Execution order of the enabled passes. False (with the stuck names in
  /// `error`) on a cycle. Memoised until the pass set or an `enabled` changes
  /// through `invalidate`.
  bool compile(std::vector<RenderPass*>& order, std::string& error);

  /// Declared targets some enabled pass may still write (or nobody claims to
  /// write — scratch pools), with their descriptors for this viewport.
  [[nodiscard]] std::vector<std::pair<std::string, TargetDesc>> active_targets(std::uint32_t viewportW,
                                                                              std::uint32_t viewportH) const;

  [[nodiscard]] std::vector<std::string> pass_names() const;

  /// Run every pass in order; failures are isolated and reported. `abortOpenPass`
  /// closes a render pass a failing pass left open.
  void execute(PassContext& ctx, const std::function<void()>& abortOpenPass, std::vector<GraphDiagnostic>& diags);

 private:
  [[nodiscard]] std::unordered_set<std::string> orphaned_targets() const;

  std::vector<std::unique_ptr<RenderPass>> passes_;
  std::vector<TargetDecl> targets_;
  std::unique_ptr<std::vector<RenderPass*>> compiled_;
};

}  // namespace premation::rg
