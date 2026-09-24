// E4 kernels by effect type, with their TS kernel arguments by name — the form
// the cross-engine fixture (tests/data/effect_kernel_parity.json) and the
// bench tool (tools/premation_effects.cpp) drive them in.
//
// The argument names are the TS kernel's parameter names (`radius`,
// `iterations`, `repeatEdge`, …), NOT the effect's stored param keys: mapping
// an Effect's params onto kernel arguments is the bake chain's job (the
// `apply*` wrappers in canvas2dEffects.ts) and lands with the chain itself.
#pragma once

#include <functional>
#include <span>
#include <string_view>
#include <vector>

#include "kernels.hpp"

namespace premation::effects {

/// `args(name, fallback)` → the number (booleans as 0/1).
using KernelArgs = std::function<double(std::string_view, double)>;

/// `lists(name)` → a numeric-array argument (resolved mask paths, trails,
/// LUT tables, particle lists); empty when absent.
using KernelLists = std::function<std::vector<double>(std::string_view)>;

/// Run the kernel of effect `type` on `img`. False when `type` has no C++ kernel.
bool run_kernel(std::string_view type, const KernelArgs& args, const KernelLists& lists, RgbaView img,
                ThreadPool* pool);
/// The same with no array arguments.
bool run_kernel(std::string_view type, const KernelArgs& args, RgbaView img, ThreadPool* pool);

/// Every effect type `run_kernel` accepts.
[[nodiscard]] std::span<const std::string_view> ported_kernels() noexcept;

/// The E4 second batch (kernel_dispatch_generate.cpp): the path / paint
/// effects, the generators and the round-seven kernels `run_kernel` falls
/// through to. False when `type` is not one of them.
bool run_generate_kernel(std::string_view type, const KernelArgs& args, const KernelLists& lists, RgbaView img,
                         ThreadPool* pool);
[[nodiscard]] std::span<const std::string_view> generate_kernels() noexcept;

}  // namespace premation::effects
