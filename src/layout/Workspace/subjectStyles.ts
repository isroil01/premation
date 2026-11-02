/**
 * Subject styles — looks for ONE subject of a footage layer (the approved
 * Subjects Pro design, board 2). A style is a stack of ordinary effects, each
 * reading that subject alone (Compositing Options ▸ subjectId), so every part
 * of it stays editable in Effect Controls and toggles / deletes on its own.
 * Applying a preset is one undo entry.
 *
 * The presets and their parameters are `subjectStylePresets.ts`; this file
 * turns one into engine commands.
 */

import type { Command } from '@motion/engine-api';
import { edit } from '@core/engine/uiEdits';
import { values } from '@core/engine/propRefs';
import { activeCompSettingsNow } from '@hooks/useMirrorFrame';
import { settingsFps } from '@core/mirror/compFacts';
import { playheadSeconds } from '@core/timeline/timelineView';
import { t } from '@core/i18n';
import { SUBJECT_STYLES, defaultParams, type StyleContext, type StyleParams, type SubjectStylePreset } from './subjectStylePresets';

export { SUBJECT_STYLES, IMAGE_FITS, defaultParams, presetById, type ImageFit, type StyleParams, type StyleContext, type SubjectStylePreset, type StyleKind } from './subjectStylePresets';

let seq = 0;

/** The context a style is applied in now: the active composition's rate and the playhead. */
function contextNow(): StyleContext {
  return { fps: settingsFps(activeCompSettingsNow()), time: playheadSeconds() };
}

/**
 * The commands that add `preset` for `subject` of `layer` (`subject` null:
 * every subject of the layer), at `params` (the preset's defaults when
 * omitted) and `ctx` (the composition now when omitted).
 */
export function subjectStyleCommands(
  layer: string,
  subject: string | null,
  preset: SubjectStylePreset,
  params: StyleParams = defaultParams(preset),
  ctx: StyleContext = contextNow(),
): Command[] {
  const out: Command[] = [];
  for (const part of preset.parts(params, ctx)) {
    const id = `fx_style_${Date.now().toString(36)}_${(seq++).toString(36)}`;
    out.push({ type: 'addEffect', layers: [layer], effect: part.effect, params: part.params, id });
    if (part.scope) out.push({ type: 'setProperty', prop: { layer, path: `effects/${id}/compositing/subject` }, value: values.string(part.scope) });
    if (subject) out.push({ type: 'setProperty', prop: { layer, path: `effects/${id}/compositing/subjectId` }, value: values.string(subject) });
    for (const k of part.keys ?? []) out.push({ type: 'setKeyframes', prop: { layer, path: `effects/${id}/${k.path}` }, keys: k.keys });
  }
  return out;
}

/** Add a style for one subject, one undo entry. */
export async function applySubjectStyle(layer: string, subject: string | null, preset: SubjectStylePreset, params?: StyleParams): Promise<boolean> {
  return (await edit(t('subjects.style.apply', 'Style: {name}', { name: preset.label() }), subjectStyleCommands(layer, subject, preset, params))).ok;
}

/** Every preset, favourites first in the order given. */
export function orderedPresets(favourites: readonly string[]): SubjectStylePreset[] {
  const fav = favourites.map((id) => SUBJECT_STYLES.find((p) => p.id === id)).filter((p): p is SubjectStylePreset => !!p);
  return [...fav, ...SUBJECT_STYLES.filter((p) => !favourites.includes(p.id))];
}
