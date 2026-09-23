// Typed failures inside the document core — src/core/engine/errors.ts.
//
// A handler validates and throws `EngineFail` (usually before it mutates
// anything); the request loop catches it and answers the request with the
// `EngineError`. Anything the handler changed before failing is rolled back
// through the document's journal, so a failed request changes nothing either
// way. EngineFail never leaves the core: the dispatcher turns it into a
// response, so no exception crosses the protocol (CLAUDE.md native rules).
#pragma once

#include <optional>
#include <string>
#include <utility>

#include "engine_api.hpp"

namespace premation::doc {

struct EngineFail {
  api::EngineError error;
};

/// The optional fields of an EngineError (TS `extra`).
struct FailExtra {
  // Default member initializers: designated initialisers may name any subset.
  std::optional<std::string> layer = std::nullopt;
  std::optional<std::string> path = std::nullopt;
  std::optional<std::string> item = std::nullopt;
  std::optional<std::string> detail = std::nullopt;
  std::optional<std::uint32_t> commandIndex = std::nullopt;
};

[[noreturn]] inline void fail(api::ErrorCode code, std::string message, FailExtra extra = {}) {
  api::EngineError e;
  e.code = code;
  e.message = std::move(message);
  e.layer = std::move(extra.layer);
  e.path = std::move(extra.path);
  e.item = std::move(extra.item);
  e.detail = std::move(extra.detail);
  e.command_index = extra.commandIndex;
  throw EngineFail{std::move(e)};
}

inline void check(bool cond, api::ErrorCode code, std::string message, FailExtra extra = {}) {
  if (!cond) fail(code, std::move(message), std::move(extra));
}

}  // namespace premation::doc
