/**
 * Integration ports — the optional seams through which the Timeline Engine
 * cooperates with the rest of the app without depending on it. The engine is
 * self-contained (it owns its data and its own undo history); these interfaces
 * document how a host bridges it to the Scene Graph, Animation Engine, and a
 * global Command System.
 *
 * None of these are required to use the engine — it emits typed events an app
 * can forward anywhere. They exist so integration is typed, not ad-hoc.
 */

import type { TimelineEventMap } from './events/TimelineEvents';

/**
 * Resolves a layer's `sourceId` (a Scene Graph node id) to facts the timeline
 * needs — chiefly the source's intrinsic length so trims can be bounded. Return
 * null length for generative/infinite sources.
 */
export interface SourceResolver {
  getSourceDuration(sourceId: string): number | null;
  hasSource(sourceId: string): boolean;
}

/**
 * A sink for mirroring timeline mutations into an app-wide command system (so a
 * single global undo stack can span the whole editor). The engine's own History
 * still runs; a host that prefers one unified stack can disable local history
 * (`timeline.history.setEnabled(false)`) and drive undo/redo through this.
 */
export interface TimelineCommandSink {
  submit(label: string, apply: () => void, revert: () => void): void;
}

/**
 * The Animation Engine listens for time changes to sample keyframes. It only
 * needs the current frame; wire it to `CurrentTimeChanged`.
 */
export interface TimeConsumer {
  onCurrentTimeChanged(frame: number, seconds: number): void;
}

/** Forward every timeline event onto an external event bus. */
export type TimelineEventForwarder = <K extends keyof TimelineEventMap>(
  event: K,
  payload: TimelineEventMap[K],
) => void;
