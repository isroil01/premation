/**
 * My Transitions — transitions the user builds from scratch (2026-10-07).
 *
 * Animate a layer however you like (any properties, effects, expressions),
 * then Save as Transition: the engine captures the layer's animation as a
 * preset body (`capturePreset`, keys measured from the first one), and it is
 * kept in the user's preset library under `My Transitions`. Each one is a card
 * here that drops onto a layer's start (an entrance at its in-point) or end
 * (an exit ending at its out-point) in the timeline, or applies at the playhead
 * on a click — the same gestures as the built-in layer transitions.
 *
 * The library is editor state, never the document; `applyPreset{body}` carries
 * the preset to the engine.
 */

import { useState } from 'react';
import { Icon } from '@components/Icon';
import { customPrompt } from '@components/Modal';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { getTime as getPlayheadTime } from '@stores/playbackClockStore';
import { engine } from '@core/engine/engineInstance';
import {
  deletePreset,
  listPresets,
  saveUserPreset,
  type AnimationPreset,
  type CapturedPresetBody,
} from '@core/animation/animationPresets';
import { applyAnimationPresetEdit } from '@layout/Menu/appEdits';
import { markLayerTransitionDrag } from '@layout/Timeline/transitionDrag';
import styles from './panels.module.css';

/** The preset folder the user's transitions live in. */
export const MY_TRANSITIONS_FOLDER = 'My Transitions';

/** A user transition's drag / drop id (the Library's own ids are `tr-*`). */
export const USER_TRANSITION_PREFIX = 'preset:';

export function myTransitions(): AnimationPreset[] {
  return listPresets().filter((p) => !p.builtin && p.folder === MY_TRANSITIONS_FOLDER);
}

/** A preset's length in seconds: its last key (captured presets start at 0). */
export function presetSpanSeconds(p: Pick<AnimationPreset, 'tracks'>): number {
  let end = 0;
  for (const t of p.tracks) for (const k of t.keyframes) end = Math.max(end, k.t);
  return end;
}

/** Save the selected layer's animation as a new transition. Resolves to the saved name, or null. */
export async function saveSelectionAsTransition(): Promise<string | null> {
  const notify = useUIStore.getState().notify;
  const layer = useSelectionStore.getState().ids[0];
  if (!layer) {
    notify({ level: 'warning', message: 'Select the layer whose animation should become a transition', durationMs: 2400 });
    return null;
  }
  const name = (await customPrompt('Save as Transition', 'Name the transition. It is saved to My Transitions in the Library.', '', { placeholder: 'e.g. Soft Push In', confirmLabel: 'Save' }))?.trim();
  if (!name) return null;
  const res = await engine().query({ type: 'capturePreset', layer });
  let body: CapturedPresetBody | null = null;
  if (res.ok && !res.value.empty) {
    try {
      body = JSON.parse(res.value.preset) as CapturedPresetBody;
    } catch {
      body = null;
    }
  }
  if (!body || (body.tracks ?? []).length === 0) {
    notify({ level: 'warning', message: res.ok ? 'Nothing to save — keyframe the layer first' : `Could not capture the layer: ${res.error.message}`, durationMs: 2600 });
    return null;
  }
  saveUserPreset(name, body, MY_TRANSITIONS_FOLDER);
  notify({ level: 'success', message: `Saved “${name}” to My Transitions`, durationMs: 2200 });
  return name;
}

export function MyTransitions(): JSX.Element {
  // The library is settings, not a store: re-read after this panel changes it.
  const [, setRev] = useState(0);
  const bump = (): void => setRev((n) => n + 1);
  const items = myTransitions();
  const notify = useUIStore((s) => s.notify);

  return (
    <>
      <div className={styles.libSectionTitle}>My Transitions — your own, built from any animation</div>
      <div className={styles.libCutRow}>
        <button
          type="button"
          className={styles.libCutItem}
          title="Animate a layer (any properties, effects or expressions), select it, then save its animation as a reusable transition"
          onClick={() => { void saveSelectionAsTransition().then((n) => { if (n) bump(); }); }}
        >
          <Icon name="plus" size="sm" /> Save Selected as Transition
        </button>
      </div>
      {items.length > 0 && (
        <div className={styles.libCutRow} aria-label="My transitions">
          {items.map((p) => (
            <button
              key={p.name}
              type="button"
              draggable
              className={styles.libCutItem}
              title={`${p.name} (${presetSpanSeconds(p).toFixed(2)}s) — drag onto a layer's start or end, or click to apply at the playhead. Alt-click deletes it.`}
              aria-label={`${p.name} — my transition`}
              onDragStart={(e) => markLayerTransitionDrag(e.dataTransfer, `${USER_TRANSITION_PREFIX}${p.name}`)}
              onClick={(e) => {
                if (e.altKey) {
                  deletePreset(p.name);
                  bump();
                  return;
                }
                const layers = useSelectionStore.getState().ids;
                if (layers.length === 0) {
                  notify({ level: 'warning', message: 'Select a layer, or drag the transition onto one in the timeline', durationMs: 2400 });
                  return;
                }
                void applyAnimationPresetEdit(layers, p.name, getPlayheadTime());
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
