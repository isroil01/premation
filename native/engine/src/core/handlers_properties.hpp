// Edit handlers: Properties, expressions and keyframes — src/core/engine/handlers/properties.ts.
//
// Each handler: `ResultOf<api::Cmd> handle(const api::Cmd&, HCtx&)` — validate
// (throw EngineFail), then mutate the document through its journaled writers.
// The dispatcher (session.cpp) finds a handler by overload resolution; a
// command with no `handle` overload answers `unsupported`.
#pragma once

#include "handlers_common.hpp"

namespace premation::doc {

ResultOf<api::SetProperty> handle(const api::SetProperty& c, HCtx& x);
ResultOf<api::SetProperties> handle(const api::SetProperties& c, HCtx& x);
ResultOf<api::ResetProperty> handle(const api::ResetProperty& c, HCtx& x);
ResultOf<api::SetAnimated> handle(const api::SetAnimated& c, HCtx& x);
ResultOf<api::SetDimensionsSeparated> handle(const api::SetDimensionsSeparated& c, HCtx& x);
ResultOf<api::SetExpression> handle(const api::SetExpression& c, HCtx& x);
ResultOf<api::SetExpressionEnabled> handle(const api::SetExpressionEnabled& c, HCtx& x);
ResultOf<api::ConvertExpressionToKeyframes> handle(const api::ConvertExpressionToKeyframes& c, HCtx& x);
ResultOf<api::LinkProperty> handle(const api::LinkProperty& c, HCtx& x);

ResultOf<api::AddKeyframes> handle(const api::AddKeyframes& c, HCtx& x);
ResultOf<api::DeleteKeyframes> handle(const api::DeleteKeyframes& c, HCtx& x);
ResultOf<api::MoveKeyframes> handle(const api::MoveKeyframes& c, HCtx& x);
ResultOf<api::UpdateKeyframes> handle(const api::UpdateKeyframes& c, HCtx& x);
ResultOf<api::ScaleKeyframes> handle(const api::ScaleKeyframes& c, HCtx& x);
ResultOf<api::ReverseKeyframes> handle(const api::ReverseKeyframes& c, HCtx& x);
ResultOf<api::PasteKeyframes> handle(const api::PasteKeyframes& c, HCtx& x);

}  // namespace premation::doc
