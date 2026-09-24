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
 * {@link NUDGE_BATCH_MS}. Through the engine API (B3): the burst is a GESTURE
 * whose every message carries the ABSOLUTE time/value for the running total
 * (`updateKeyframes`), so a dropped intermediate message loses nothing.
 */

import type { KeyframePatch, ValueType } from '@motion/engine-api';
import { expandKeyframeProp } from '@motion/animation';
import { GestureSession } from '@core/engine/uiEdits';
import { engineIdle } from '@core/engine/engineInstance';
import { compTime, propRefForTrack, valueOfNumbers } from '@core/engine/propRefs';
import { apiUnitFactor } from '@core/engine/props';
import { memberTrackRef } from '@core/mirror/memberKeys';
import { numbersOfValue, storedNumber } from '@core/mirror/trackIndex';
import { documentMirror } from '@stores/documentMirror';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { keyTimeById, parseUiKey, resolveKeys, uiKeyId, type UiKey } from './keyframeEdits';
import { mirrorKeyOf, storedTimeOf } from './keyframeSelectionIds';

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

/** One selected key, snapshotted when a burst opens. */
interface NudgeKey {
  ui: UiKey;
  /** Engine keyframe id. */
  id: string;
  /** Comp time of the key at burst start (seconds). */
  startCompT: number;
  /** The row's member tracks keyed at the start time, with their stored values. */
  members: Array<{ prop: string; value: number }>;
  /** Every member of the API property, in order (for a whole-value write). */
  allMembers: readonly string[];
  valueType: ValueType;
  /** The whole key's numbers at burst start, API units (members the row does not stand for keep them). */
  apiNums: number[];
  /** Comp times of the property's OTHER keys — a move onto one is refused, as before. */
  otherCompTimes: number[];
}

/** The key a selection id names, as the document MIRROR has it (B4), when the burst opens. */
function snapshotKey(ui: UiKey): Omit<NudgeKey, 'id'> | null {
  const m = documentMirror();
  const hit = mirrorKeyOf(m, ui, storedTimeOf(ui.nodeId));
  if (!hit) return null;
  const r = propRefForTrack(ui.nodeId, hit.track);
  if (!r) return null;
  // The row's own tracks on this property (a merged Position row: x and y; a
  // Scale X row: X alone) move by the value step.
  const tree = m.tree(ui.nodeId);
  const members: Array<{ prop: string; value: number }> = [];
  for (const prop of expandKeyframeProp(ui.prop)) {
    const ref = memberTrackRef(tree, prop);
    const value = ref && ref.path === hit.ref.path ? storedNumber(ref, hit.key.key.value) : undefined;
    if (value !== undefined) members.push({ prop, value });
  }
  if (members.length === 0) return null;
  return {
    ui,
    startCompT: hit.key.tAbs,
    members,
    allMembers: r.members,
    valueType: r.valueType,
    apiNums: numbersOfValue(hit.key.key.value),
    otherCompTimes: hit.keys.filter((_k, i) => i !== hit.index).map((k) => k.tAbs),
  };
}

/** The absolute patch for one key after a running total. */
function patchFor(k: NudgeKey, total: NudgeDelta): KeyframePatch | null {
  const patch: KeyframePatch = { id: k.id, spatialIn: [], spatialOut: [] };
  let any = false;
  if (total.dt !== 0) {
    const to = Math.max(0, k.startCompT + total.dt);
    // A move onto an occupied time would swallow the neighbour; refuse it.
    if (!k.otherCompTimes.some((t) => Math.abs(t - to) < 1e-6)) {
      patch.time = compTime(to);
      any = true;
    }
  }
  if (total.dv !== 0) {
    // Every keyed member moves by dv in STORED units (Scale's multiplier
    // included), as the per-track writer did; the API takes the whole value.
    const nums = k.allMembers.map((m, i) => {
      const mv = k.members.find((x) => x.prop === m);
      // The other members keep the key's own numbers (already API units).
      return mv ? (mv.value + total.dv) * apiUnitFactor(m) : k.apiNums[i] ?? 0;
    });
    patch.value = valueOfNumbers(k.valueType, nums);
    any = true;
  }
  return any ? patch : null;
}

/**
 * The selection ids after the engine moved the keys: each key is found by
 * its ENGINE id on its tracks, and renamed to its new position (the selection
 * store's positional format — see keyframeEdits).
 */
function reselect(keys: ReadonlyArray<NudgeKey>, untouched: ReadonlySet<string>): void {
  const next = new Set<string>(untouched);
  for (const k of keys) {
    // The key's stored time now, by its engine id, from the document mirror.
    const t = keyTimeById(k.ui.nodeId, k.members[0]?.prop ?? k.ui.prop, k.id);
    next.add(t === null ? k.ui.id : uiKeyId(k.ui.nodeId, k.ui.prop, t));
  }
  useKeyframeSelectionStore.getState().set(next);
}

function nudgeLabel(total: NudgeDelta): string {
  return total.dt !== 0 && total.dv !== 0
    ? 'Nudge keyframes'
    : total.dv !== 0
      ? 'Nudge keyframe value'
      : 'Nudge keyframes in time';
}

/**
 * A batcher wired to the engine: the burst is one gesture (one undo entry),
 * named after the burst's first press. Keys are resolved to engine ids when
 * the burst opens; presses that land before that finishes are folded into the
 * running total, which the first message then carries.
 */
export function createSelectionNudger(): NudgeBatcher {
  let session: GestureSession | null = null;
  let keys: NudgeKey[] | null = null;
  let untouched = new Set<string>();
  let total: NudgeDelta = { dt: 0, dv: 0 };
  let ready: Promise<void> | null = null;

  const send = (): void => {
    if (!session || !keys) return;
    const patches = keys.map((k) => patchFor(k, total)).filter((p): p is KeyframePatch => p !== null);
    if (patches.length === 0) return;
    session.send({ type: 'updateKeyframes', patches });
    const sent = keys;
    const keep = untouched;
    void engineIdle().then(() => reselect(sent, keep));
  };

  return createNudgeBatcher({
    begin: () => {
      total = { dt: 0, dv: 0 };
      const snaps: Array<Omit<NudgeKey, 'id'>> = [];
      untouched = new Set<string>();
      for (const id of useKeyframeSelectionStore.getState().ids) {
        const ui = parseUiKey(id);
        const snap = ui ? snapshotKey(ui) : null;
        if (snap) snaps.push(snap);
        else untouched.add(id);
      }
      ready = (async () => {
        const resolved = await resolveKeys(snaps.map((x) => x.ui));
        // Null: the API cannot address one of the keys (keyframeEdits header);
        // nothing moves, as for a selection the writer could not find.
        if (!resolved) return;
        keys = snaps.flatMap((x) => {
          const id = resolved.get(x.ui.id);
          return id ? [{ ...x, id }] : [];
        });
        session = new GestureSession(nudgeLabel(total));
        send();
      })();
    },
    apply: (delta) => {
      total = { dt: total.dt + delta.dt, dv: total.dv + delta.dv };
      if (keys) send();
    },
    commit: () => {
      const s = session;
      const r = ready;
      session = null;
      keys = null;
      ready = null;
      void (async () => {
        await r;
        await s?.end();
      })();
    },
  });
}
