// Building the generated protocol unions by alternative type. The generated
// CommandResult / QueryResult unions have one alternative per command, in the
// SAME order as Command / Query, with repeated payload types (many are Empty) —
// so they are built by the COMMAND's index, never by payload type.
#pragma once

#include <cstddef>
#include <type_traits>
#include <utility>
#include <variant>

#include "engine_api.hpp"

namespace premation {

template <class T, class V>
struct IndexOf;
template <class T, class... Ts>
struct IndexOf<T, std::variant<Ts...>> {
  static constexpr std::size_t value = [] {
    constexpr bool same[] = {std::is_same_v<T, Ts>...};
    for (std::size_t i = 0; i < sizeof...(Ts); ++i) {
      if (same[i]) return i;
    }
    return sizeof...(Ts);
  }();
};

using CommandVariant = decltype(api::Command::v);
using QueryVariant = decltype(api::Query::v);
using CommandResultVariant = decltype(api::CommandResult::v);
using QueryResultVariant = decltype(api::QueryResult::v);

/// The result payload type of command `Cmd`.
template <class Cmd>
using ResultOf = std::variant_alternative_t<IndexOf<Cmd, CommandVariant>::value, CommandResultVariant>;
/// The result payload type of query `Q`.
template <class Q>
using QResultOf = std::variant_alternative_t<IndexOf<Q, QueryVariant>::value, QueryResultVariant>;

template <class Cmd, class... Args>
api::CommandResult result_for(Args&&... args) {
  constexpr std::size_t i = IndexOf<Cmd, CommandVariant>::value;
  static_assert(i < std::variant_size_v<CommandVariant>);
  api::CommandResult r;
  r.v.template emplace<i>(std::forward<Args>(args)...);
  return r;
}

template <class Q, class... Args>
api::QueryResult query_result_for(Args&&... args) {
  constexpr std::size_t i = IndexOf<Q, QueryVariant>::value;
  static_assert(i < std::variant_size_v<QueryVariant>);
  api::QueryResult r;
  r.v.template emplace<i>(std::forward<Args>(args)...);
  return r;
}

template <class Payload>
api::Event make_event(Payload p) {
  api::Event e;
  e.v.template emplace<IndexOf<Payload, decltype(api::Event::v)>::value>(std::move(p));
  return e;
}

}  // namespace premation
