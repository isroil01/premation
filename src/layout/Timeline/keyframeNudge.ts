/**
 * Arrow-key keyframe nudging.
 *
 *   ← / →              one frame earlier / later
 *   Shift + ← / →      ten frames
 *   Ctrl/Cmd + ← / →   a TENTH of a frame — sub-frame, for audio sync
 *   Alt + ↑ / ↓        value ±1
 *   Alt+Shift ↑/↓      value ±10
 *
 * The sub-frame step exists because keyframe times are continuous — the engine
 * compares them at 1e-9 and the renderer samples between frames for motion
 * blur — but every gesture that moved a key quantized to the frame grid, so a
 * time between two frames was reachable by nothing at all. Landing a hit on a
 * transient that falls 4ms after a frame boundary was therefore impossible,
 * and the workaround was to change the comp frame rate.
 *
 * A tenth of a frame (3.3ms at 30fps) is the step because it is fine enough to
 * beat human audio-sync perception (~10ms) and coarse enough that ten presses
 * is one frame, which keeps the relationship between the two steps legible.
 *
 * A burst of presses is ONE undo step: holding → for a second moves the key
 * thirty frames and should cost one Ctrl+Z, not thirty. The batcher applies
 * every press live and commits once the keys have been quiet for
 * {@link NUDGE_BATCH_MS}.
 */

import { beginAnimEdit, recordAnimEdit } from '@core/animation/animationCommands';
import { defaultAnimation, expandKeyframeProp, makeKeyframeId, parseKeyframeId } from '@motion/animation';
import { compToKeyframeTime, keyframeToCompTime } from '@core/timeline/TimelineController';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';

export const NUDGE_BATCH_MS = 300;

/**
 * Presses per frame for the sub-frame nudge. Ten, so the fine and coarse steps
 * are related by a round number the user can count.
 */
export const SUBFRAME_NUDGE_DIVISIONS = 10;

export interface NudgeDelta {
  /** Seconds, on the comp axis. */
  dt: number;
  /** Value units. */
  dv: number;
}

/** What a key means, or null when it is not a nudge. */
export function nudgeForKey(
  key: string,
  mods: { shift: boolean; alt: boolean; meta?: boolean },
  frameDuration: number,
): NudgeDelta | null {
  // Ctrl/Cmd goes FINE, Shift goes coarse. Both together is read as fine: the
  // two are the same axis, and a "ten sub-frames" step is just one frame,
  // which the unmodified key already does.
  const fine = mods.meta === true;
  const timeStep = fine
    ? frameDuration / SUBFRAME_NUDGE_DIVISIONS
    : (mods.shift ? 10 : 1) * frameDuration;
  const valueStep = mods.shift ? 10 : 1;
  switch (key) {
    case 'ArrowLeft':
      return mods.alt ? null : { dt: -timeStep, dv: 0 };
    case 'ArrowRight':
      return mods.alt ? null : { dt: timeStep, dv: 0 };
    case 'ArrowUp':
      return mods.alt ? { dt: 0, dv: valueStep } : null;
    case 'ArrowDown':
      return mods.alt ? { dt: 0, dv: -valueStep } : null;
    default:
      return null;
  }
}

export interface NudgeBatcher {
  /** Apply one press; opens the batch on the first. Returns the running total. */
  push(delta: NudgeDelta): NudgeDelta;
  /** Commit now (a click elsewhere, an unmount). No-op when nothing is open. */
  flush(): void;
  /** Whether a batch is open — a Delete during one must flush first. */
  isOpen(): boolean;
}

/**
 * Debounce presses into one commit.
 *
 * `apply` runs on EVERY press (so the diamond moves under the key), `commit`
 * once per burst with the total — where the caller records the undo entry.
 * Pure over its two callbacks, so the grouping rule is testable with fake
 * timers and nothing else.
 */
export function createNudgeBatcher(
  hooks: { begin(): void; apply(delta: NudgeDelta): void; commit(total: NudgeDelta): void },
  delayMs = NUDGE_BATCH_MS,
): NudgeBatcher {
  let total: NudgeDelta | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!total) return;
    const done = total;
    total = null;
    hooks.commit(done);
  };

  return {
    push(delta) {
      if (!total) {
        total = { dt: 0, dv: 0 };
        hooks.begin();
      }
      total = { dt: total.dt + delta.dt, dv: total.dv + delta.dv };
      hooks.apply(delta);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
      return total;
    },
    flush,
    isOpen: () => total !== null,
  };
}

/**
 * The engine side: move / re-value every selected keyframe by `delta`, and
 * keep the selection pointing at the keys after they retime — a keyframe id
 * embeds its time, so a moved key would otherwise silently drop out of the
 * selection on the next press.
 */
export function applyNudgeToSelection(delta: NudgeDelta): void {
  const store = useKeyframeSelectionStore.getState();
  const next = new Set<string>();
  for (const id of store.ids) {
    const ref = parseKeyframeId(id);
    if (!ref) {
      next.add(id);
      continue;
    }
    let newT = ref.t;
    for (const prop of expandKeyframeProp(ref.prop)) {
      const kfs = defaultAnimation.getTrackKeyframes(ref.nodeId, prop);
      const kf = kfs?.find((k) => Math.abs(k.t - ref.t) < 1e-9);
      if (!kf) continue;
      const patch: { t?: number; value?: number } = {};
      if (delta.dt !== 0) {
        const compT = keyframeToCompTime(ref.nodeId, ref.t, prop) + delta.dt;
        patch.t = Math.max(0, compToKeyframeTime(ref.nodeId, Math.max(0, compT), prop));
        newT = patch.t;
      }
      if (delta.dv !== 0) patch.value = kf.value + delta.dv;
      // A move onto an occupied frame would swallow the neighbour; refuse it.
      if (patch.t !== undefined && kfs?.some((k) => k.t !== ref.t && Math.abs(k.t - patch.t!) < 1e-9)) {
        delete patch.t;
        newT = ref.t;
      }
      if (patch.t === undefined && patch.value === undefined) continue;
      defaultAnimation.updateKeyframe(ref.nodeId, prop, ref.t, patch);
    }
    next.add(makeKeyframeId(ref.nodeId, ref.prop, newT));
  }
  store.set(next);
}

/** A batcher wired to the animation engine's transaction API. */
export function createSelectionNudger(): NudgeBatcher {
  let tx: ReturnType<typeof beginAnimEdit> | null = null;
  return createNudgeBatcher({
    begin: () => {
      tx = beginAnimEdit();
    },
    apply: applyNudgeToSelection,
    commit: (total) => {
      const label = total.dt !== 0 && total.dv !== 0
        ? 'Nudge keyframes'
        : total.dv !== 0
          ? 'Nudge keyframe value'
          : 'Nudge keyframes in time';
      recordAnimEdit(tx?.commit(label) ?? null);
      tx = null;
    },
  });
}
