// Helpers for a JobResult's apply(): read a command's typed result, build
// commands and values, read the document between steps.
#pragma once

#include <optional>
#include <string>
#include <type_traits>
#include <utility>
#include <variant>

#include "engine_api.hpp"
#include "values.hpp"

namespace premation::jobs {

/// The payload of type T in a command's result (CommandResult repeats payload
/// types, so it is found by visiting). nullopt when the result carries no T.
template <class T>
[[nodiscard]] std::optional<T> result_payload(const api::CommandResult& r) {
  return std::visit(
      [](const auto& x) -> std::optional<T> {
        if constexpr (std::is_same_v<std::decay_t<decltype(x)>, T>) {
          return x;
        } else {
          return std::nullopt;
        }
      },
      r.v);
}

/// A command from one of its alternatives.
template <class C>
[[nodiscard]] api::Command command(C c) {
  api::Command out;
  out.v = std::move(c);
  return out;
}

}  // namespace premation::jobs
