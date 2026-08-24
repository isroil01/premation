/**
 * Quick Apply — the palette's effect and preset sources.
 *
 * After Effects 26.2 added a search box that finds any effect, animation preset
 * or menu command and applies it to the selection on Enter. This editor already
 * had the search box (`CommandPalette`) and already had 174 effects; what it
 * did not have was the join. Browsing an accordion of folders to reach one
 * effect is the single largest friction in the app for the amount of work it
 * hides, and this file removes it.
 *
 * Pure data in, pure data out: the palette renders whatever comes back, and
 * the apply is one call into the same entry points the panels use. Kept apart
 * from `CommandPalette.tsx` so the sources can be unit-tested without a DOM.
 */

import { EFFECT_DEFS, effectDefFor, type EffectType } from '@core/effects/effects';
import { pluginEffectDefs, PLUGIN_EFFECT_CATEGORY } from '@core/effects/pluginEffectDefs';
import { EFFECT_CATEGORY } from '@layout/Effects/effectCategory';
import { addEffectAndReveal } from '@layout/Effects/revealEffectControls';
import { listPresets, presetFolder, applyPreset, type AnimationPreset } from '@core/animation/animationPresets';
import { useSelectionStore } from '@stores/selectionStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { getEventBus } from '@core/events/EventBus';
import { fuzzyScore } from './paletteSearch';

export interface QuickApplyHit {
  key: string;
  label: string;
  /** The folder the item lives in — its hint, so "Glow" says "Stylize". */
  hint: string;
  /** Fuzzy score; the caller merges and ranks. */
  score: number;
  /** False when there is no selection to apply to (or the preset cannot act on it). */
  enabled: boolean;
  apply: () => void;
}

/** The layers an apply lands on: the current selection, in order. */
function targets(): string[] {
  return [...useSelectionStore.getState().ids];
}

/**
 * Effects, ranked by fuzzy match on the label.
 *
 * Matches on the category too ("blur" finds everything in Blur & Sharpen),
 * weighted below a label hit so the folder is a tiebreaker and not the
 * ranking. Plugin effects are included — a plugin's effect is an effect.
 */
export function effectHits(term: string, limit: number): QuickApplyHit[] {
  const sel = targets();
  const defs = [...EFFECT_DEFS, ...pluginEffectDefs()];
  const out: QuickApplyHit[] = [];
  for (const d of defs) {
    const category = EFFECT_CATEGORY[d.type as EffectType] ?? PLUGIN_EFFECT_CATEGORY;
    const byLabel = fuzzyScore(term, d.label);
    const byCat = term ? fuzzyScore(term, category) : -1;
    const score = byLabel >= 0 ? byLabel + 10 : byCat >= 0 ? byCat : -1;
    if (score < 0) continue;
    out.push({
      key: `fx:${d.type}`,
      label: d.label,
      hint: category,
      score,
      enabled: sel.length > 0,
      apply: () => {
        // Every selected layer gets the effect — AE applies to the whole
        // selection, and a search-to-apply that only hit the first would force
        // the user to repeat the search per layer.
        for (const id of sel) addEffectAndReveal(id, d.type as EffectType);
      },
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Can this preset do anything on this layer? Text presets need a text layer. */
function presetFits(p: AnimationPreset, nodeId: string): boolean {
  if (p.requires !== 'text' && !(p.animators && p.animators.length)) return true;
  const node = defaultSceneGraph.getNode(nodeId);
  return !!node && readNodeKind(node) === 'text';
}

/**
 * Animation presets, ranked the same way. Applied at the playhead to every
 * selected layer the preset fits; a text-only preset on a shape is skipped
 * rather than silently no-op'd, and the palette shows it disabled up front.
 */
export function presetHits(term: string, limit: number): QuickApplyHit[] {
  const sel = targets();
  const out: QuickApplyHit[] = [];
  for (const p of listPresets()) {
    const folder = presetFolder(p);
    const byLabel = fuzzyScore(term, p.name);
    const byFolder = term ? fuzzyScore(term, folder) : -1;
    const score = byLabel >= 0 ? byLabel + 10 : byFolder >= 0 ? byFolder : -1;
    if (score < 0) continue;
    const fits = sel.filter((id) => presetFits(p, id));
    out.push({
      key: `preset:${folder}/${p.name}`,
      label: p.name,
      hint: folder,
      score,
      enabled: fits.length > 0,
      apply: () => {
        const t = getTimelineController().currentSeconds;
        for (const id of fits) applyPreset(p, id, t);
        // Show what just landed: the preset's keyframes are the whole point,
        // and a preset applied to a collapsed layer is invisible until U.
        if (fits.length) getEventBus().emit('RevealAnimatedProps', { nodeIds: fits, mode: 'animated', force: true });
      },
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Exposed for the palette's "nothing selected" hint. */
export function hasApplyTarget(): boolean {
  return targets().length > 0;
}

/** True when this type exists — used by tests to assert the catalogue is live. */
export function isKnownEffect(type: string): boolean {
  return effectDefFor(type) !== undefined;
}
