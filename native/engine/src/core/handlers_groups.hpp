// Edit handlers: Property groups (effects, masks, text animators, layer styles, path operators, presets) — src/core/engine/handlers/groups.ts.
//
// Each handler: `ResultOf<api::Cmd> handle(const api::Cmd&, HCtx&)` — validate
// (throw EngineFail), then mutate the document through its journaled writers.
// The dispatcher (session.cpp) finds a handler by overload resolution; a
// command with no `handle` overload answers `unsupported`.
//
// Presets (src/core/animation/animationPresets.ts `applyPreset` and
// `applyPresetTracks`) are ported here too: the preset library is generated
// into `registry().presets`; the one preset that is code (`hasApplyFn`: the
// camera Dolly Zoom, cameraPresets.ts `applyDollyZoom`) is ported by hand.
#pragma once

#include "handlers_common.hpp"

namespace premation::doc {

ResultOf<api::AddEffect> handle(const api::AddEffect& c, HCtx& x);
ResultOf<api::AddMask> handle(const api::AddMask& c, HCtx& x);
ResultOf<api::AddPropertyGroup> handle(const api::AddPropertyGroup& c, HCtx& x);
ResultOf<api::RemovePropertyGroups> handle(const api::RemovePropertyGroups& c, HCtx& x);
ResultOf<api::MovePropertyGroup> handle(const api::MovePropertyGroup& c, HCtx& x);
ResultOf<api::DuplicatePropertyGroups> handle(const api::DuplicatePropertyGroups& c, HCtx& x);
ResultOf<api::SetGroupEnabled> handle(const api::SetGroupEnabled& c, HCtx& x);
ResultOf<api::RenamePropertyGroup> handle(const api::RenamePropertyGroup& c, HCtx& x);
ResultOf<api::CopyPropertyGroups> handle(const api::CopyPropertyGroups& c, HCtx& x);
/// B3z — paste captured effects (the editor's CopiedEffect[] JSON) onto layers (groups.ts pasteEffects).
ResultOf<api::PasteEffects> handle(const api::PasteEffects& c, HCtx& x);
ResultOf<api::ApplyPreset> handle(const api::ApplyPreset& c, HCtx& x);
ResultOf<api::InvokeEffectAction> handle(const api::InvokeEffectAction& c, HCtx& x);

/// textAnimators.ts `rekeyTextAnimatorTracks(node, mapAnim, mapSel?)`: move every
/// `ta.*` track, expression and data track to the slots the maps give (nullopt
/// drops it). `mapSel` empty = selectors keep their index.
void rekey_text_animator_tracks(Document& d, std::string_view layer,
                                const std::function<std::optional<int>(int)>& mapAnim,
                                const std::function<std::optional<int>(int, int)>& mapSel = {});

}  // namespace premation::doc
