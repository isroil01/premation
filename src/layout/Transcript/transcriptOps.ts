/**
 * Everything text-based editing does to a document.
 *
 * The arithmetic is `@core/captions/transcriptEdit`; this is the half that
 * splits bars, deletes layers and calls a provider. Split that way for the
 * usual reason — the ranges are the part that has to be exactly right and the
 * part that can be tested without a scene — but also because the surgery below
 * has an order that matters, and it is easier to see when the maths is not
 * interleaved with it.
 *
 * ## The surgery, and why it is not `rippleDeleteLayer`
 *
 * `TimelineController.rippleDeleteLayer` deletes ONE bar and slides everything
 * after it left by that bar's length. Deleting a time RANGE is a different
 * operation: several layers are cut at the same two instants, and the gap that
 * closes is the range's length — once — not the sum of the lengths of the
 * clips that were in it. Calling the ripple delete once per layer would shift
 * later clips once per layer, which for a video plus its audio is exactly
 * twice as far as it should be. So the ripple is done ONCE per range, after
 * the deletions, over every clip in the comp.
 *
 * Ranges are applied LAST first. Every earlier range's boundaries are stated in
 * the current time base, and closing a later gap does not move them; closing an
 * earlier one would move every range after it.
 *
 * ## The ripple covers layers the user excluded
 *
 * `nodeIds` narrows what gets CUT, not what gets moved. A comp where the gap
 * closed for three layers and stayed open for a fourth is not a comp with a
 * protected layer in it — it is a comp that is out of sync from that point on,
 * which is not what anyone means by "don't cut my logo".
 */

import { activeCompRootId } from '@core/scene/activeComp';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useCompositionStore } from '@stores/compositionStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { runAsOneHistoryEntry } from '@core/composition/compositeEdit';
import { downloadBlob } from '@core/export/exportManager';
import { toSrt, toVtt, type Cue } from '@core/captions/captionFormat';
import {
  captionNodes,
  insertCaptionLayers,
  readCaptionCues,
  removeCaptionLayers,
} from '@core/captions/captionLayers';
import {
  TranscribeError,
  transcribeComposition,
  transcriptionAvailable,
} from '@core/captions/transcribe';
import {
  applyDeletionsToWords,
  cuesFromWords,
  deletedDuration,
  mergeRanges,
  wordsFromCues,
  type TimeRange,
  type TranscriptWord,
} from '@core/captions/transcriptEdit';
import { useTranscriptStore, type CompTranscript } from './transcriptStore';

function notify(
  message: string,
  level: 'success' | 'info' | 'warning' | 'error' = 'success',
  durationMs = 4000,
): void {
  useUIStore.getState().notify({ level, message, durationMs });
}

// ── What gets transcribed ─────────────────────────────────────────────

export interface TranscribeScope extends TimeRange {
  /** What to call this range in the UI, so the button is not a mystery. */
  readonly label: string;
}

/**
 * The range the Transcribe button will cover.
 *
 * Preference order, and each step is a narrower statement of intent than the
 * one after it: the layers you SELECTED, then the work area you SET, then the
 * whole composition. A user with a clip selected who presses Transcribe means
 * that clip; falling straight through to the comp would bill them for ten
 * minutes of audio to caption forty seconds of it.
 *
 * The bars are read in FRAMES and converted once, here. A video's sound is a
 * separate audio layer, so selecting the picture alone still gives the right
 * WINDOW — the mixdown underneath takes the comp's whole sound across it.
 */
export function transcribeScope(): TranscribeScope {
  const controller = getTimelineController();
  const selected = useSelectionStore.getState().ids;

  if (selected.length > 0) {
    let startF = Number.POSITIVE_INFINITY;
    let endF = Number.NEGATIVE_INFINITY;
    let fps = controller.fps;
    for (const nodeId of selected) {
      for (const layer of controller.getLayersForNode(nodeId)) {
        fps = controller.fpsForNode(nodeId);
        startF = Math.min(startF, layer.start);
        endF = Math.max(endF, layer.end);
      }
    }
    if (Number.isFinite(startF) && endF > startF) {
      return {
        start: startF / fps,
        end: endF / fps,
        label: selected.length === 1 ? 'selected layer' : `${selected.length} selected layers`,
      };
    }
  }

  const work = controller.getWorkArea();
  if (work && work.end > work.start) {
    return { start: work.start, end: work.end, label: 'work area' };
  }

  return {
    start: 0,
    end: useCompositionStore.getState().comp().durationSeconds,
    label: 'composition',
  };
}

/** True when this build can transcribe at all — mirrors the caption command. */
export { transcriptionAvailable };

// ── Producing a transcript ────────────────────────────────────────────

/**
 * Transcribe `scope` and cache the words against the active composition.
 *
 * Progress is honest about being coarse: `transcribeComposition` mixes the comp
 * down and then makes one network call, and there is no callback between them
 * that would let this report a percentage. What the panel shows is the phase
 * and the elapsed time, which is what the user can actually act on ("this is
 * taking a while" / "this is stuck").
 */
export async function runTranscription(scope: TranscribeScope = transcribeScope()): Promise<boolean> {
  const store = useTranscriptStore.getState();
  const rootId = activeCompRootId();
  store.setError(null);
  store.setPhase('mixing');
  try {
    // The mixdown happens inside `transcribeComposition`; the phase flips
    // optimistically after a tick so the label is not stuck on "Mixing" for
    // the whole upload. Coarse, and labelled as coarse in the UI.
    const flip = setTimeout(() => useTranscriptStore.getState().setPhase('transcribing'), 400);
    let cues: Cue[];
    try {
      cues = await transcribeComposition({
        startSec: scope.start,
        endSec: scope.end,
        rootId,
      });
    } finally {
      clearTimeout(flip);
    }
    const transcript: CompTranscript = {
      words: wordsFromCues(cues),
      source: 'transcribed',
      range: { start: scope.start, end: scope.end },
      edited: false,
    };
    useTranscriptStore.getState().setTranscript(rootId, transcript);
    useTranscriptStore.getState().setPhase('idle');
    return true;
  } catch (err) {
    const message = err instanceof TranscribeError
      ? err.message
      : `Transcription failed: ${String(err)}`;
    useTranscriptStore.getState().setError(message);
    useTranscriptStore.getState().setPhase('idle');
    notify(message, 'error', 8000);
    return false;
  }
}

/**
 * Rebuild a transcript from the comp's caption layers.
 *
 * The one durable home a transcript has. Word timings are re-estimated inside
 * each cue, so this is a lower-fidelity transcript than the provider's — which
 * is why it is a fallback for a comp with no cache rather than something that
 * overwrites a live transcript.
 */
export function transcriptFromCaptions(rootId: string = activeCompRootId()): CompTranscript | null {
  const cues = readCaptionCues(rootId);
  if (cues.length === 0) return null;
  const words = wordsFromCues(cues);
  if (words.length === 0) return null;
  const first = words[0] as TranscriptWord;
  const last = words[words.length - 1] as TranscriptWord;
  return {
    words,
    source: 'captions',
    range: { start: first.start, end: last.end },
    edited: false,
  };
}

// ── Deleting time ─────────────────────────────────────────────────────

export interface DeleteRangesResult {
  /** How much comp time the edit removed. */
  removedSeconds: number;
  /** Clips cut at a range boundary. */
  splits: number;
  /** Clip pieces removed outright. */
  deletedClips: number;
}

/**
 * Remove `ranges` from the active composition's timeline, closing the gaps.
 *
 * One undo entry for the whole thing, via `runAsOneHistoryEntry` — which is the
 * right tool here rather than a hand-written inverse for the reason its own
 * header gives: this touches clip geometry (invisible to the scene snapshot),
 * scene nodes (deleted layers) and, through the splits, nodes that did not
 * exist before the operation started.
 *
 * `nodeIds`, when given, restricts which layers are CUT. The default — no
 * `nodeIds` — is every layer with a clip overlapping the range, which is what
 * "delete these words from my video" means: the picture, its separate audio
 * layer, and anything else sitting across that moment.
 */
export async function deleteTimeRanges(
  ranges: readonly TimeRange[],
  opts: { nodeIds?: readonly string[] } = {},
): Promise<DeleteRangesResult> {
  const merged = mergeRanges(ranges);
  const empty: DeleteRangesResult = { removedSeconds: 0, splits: 0, deletedClips: 0 };
  if (merged.length === 0) return empty;

  const controller = getTimelineController();
  const rootId = activeCompRootId();
  const restrict = opts.nodeIds && opts.nodeIds.length > 0 ? new Set(opts.nodeIds) : null;
  const cuttable = (sourceId: string | null): boolean =>
    !restrict || (sourceId !== null && restrict.has(sourceId));

  const label = merged.length === 1
    ? 'Delete Transcript Selection'
    : `Delete ${merged.length} Transcript Selections`;

  return runAsOneHistoryEntry(label, () => {
    const result: DeleteRangesResult = { removedSeconds: deletedDuration(merged), splits: 0, deletedClips: 0 };
    const fps = controller.fps;

    for (const range of [...merged].reverse()) {
      const startF = Math.round(range.start * fps);
      const endF = Math.round(range.end * fps);
      // Sub-frame ranges exist — a single short word can be one — and there is
      // nothing to cut in less than a frame. Skipping is better than rounding
      // up into the word beside it.
      if (endF <= startF) continue;

      // Two passes rather than one: splitting at the IN point creates the bar
      // that then has to be split at the OUT point, and a single pass over a
      // snapshot of the list would never see it.
      for (const edge of [startF, endF]) {
        for (const layer of [...controller.layersOfComp(rootId)]) {
          if (layer.locked || !cuttable(layer.sourceId)) continue;
          if (layer.start < edge && layer.end > edge) {
            if (controller.splitClip(layer.id, edge / fps)) result.splits += 1;
          }
        }
      }

      for (const layer of [...controller.layersOfComp(rootId)]) {
        if (layer.locked || !cuttable(layer.sourceId)) continue;
        if (layer.start >= startF && layer.end <= endF) {
          if (controller.deleteLayerForClip(layer.id, { ripple: false })) result.deletedClips += 1;
        }
      }

      // The ripple, once, over EVERY clip — see the header. Locked bars are
      // left where they are: the engine refuses to move them anyway, and
      // pretending otherwise would report a shift that did not happen.
      const gap = endF - startF;
      for (const layer of [...controller.layersOfComp(rootId)]) {
        if (layer.locked || layer.start < endF) continue;
        controller.setClipStart(layer.id, Math.max(0, layer.start - gap) / fps);
      }
    }

    controller.invalidateLayerIndex();
    return result;
  });
}

/**
 * Delete the selected words: cut the time, then move the transcript with it.
 *
 * The transcript is edited from the SAME ranges the timeline was, rather than
 * re-derived, so the words cannot end up describing a different edit than the
 * one that happened.
 */
export async function deleteSelectedWords(
  rootId: string = activeCompRootId(),
): Promise<DeleteRangesResult | null> {
  const state = useTranscriptStore.getState();
  const transcript = state.byComp[rootId];
  if (!transcript) return null;
  const selected = new Set(state.selected);
  if (selected.size === 0) return null;

  const ranges = mergeRanges(
    transcript.words.filter((w) => selected.has(w.id)).map((w) => ({ start: w.start, end: w.end })),
  );
  if (ranges.length === 0) return null;

  // The scene selection is only consulted when the user asked for it. Read
  // here rather than inside `deleteTimeRanges` so the ops function stays a
  // plain "delete these ranges from these layers" and the POLICY lives at the
  // one call site that has a checkbox behind it.
  const scoped = state.restrictToSelection ? useSelectionStore.getState().ids : [];
  if (state.restrictToSelection && scoped.length === 0) {
    notify(
      'No layers are selected, so there is nothing to cut. Select the layers to cut, '
      + 'or turn off “Selected layers only”.',
      'warning',
    );
    return null;
  }

  const result = await deleteTimeRanges(ranges, { nodeIds: scoped });
  useTranscriptStore.getState().replaceWords(rootId, applyDeletionsToWords(transcript.words, ranges));
  notify(
    `Removed ${result.removedSeconds.toFixed(2)}s — ${result.deletedClips} clip piece(s) deleted, `
    + `${result.splits} clip(s) split`,
  );
  return result;
}

// ── Downstream: captions and files ────────────────────────────────────

/** The transcript as cues — what both captions and export are built from. */
export function transcriptCues(rootId: string = activeCompRootId()): Cue[] {
  const transcript = useTranscriptStore.getState().byComp[rootId];
  return transcript ? cuesFromWords(transcript.words) : [];
}

/**
 * Turn the (edited) transcript into caption text layers.
 *
 * Straight through `insertCaptionLayers` — the same path the import and the
 * generate commands use, so a caption made this way is an ordinary text layer
 * with `__caption` on it, stylable and re-timable like any other, and readable
 * back by the existing export.
 */
export function addTranscriptAsCaptions(rootId: string = activeCompRootId()): number {
  const cues = transcriptCues(rootId);
  if (cues.length === 0) {
    notify('There is no transcript to add. Transcribe the composition first.', 'warning');
    return 0;
  }
  const existing = captionNodes(rootId).length;
  // Replacing, not adding — the same argument `captionCommands.importCaptions`
  // makes: a second pass over an unremoved first is doubled text on screen,
  // which reads as a renderer bug rather than as the user's own second click.
  if (existing > 0) removeCaptionLayers(rootId);
  const result = insertCaptionLayers(cues);
  notify(
    `Added ${result.nodeIds.length} caption layer(s) from the transcript`
    + (existing > 0 ? ` (replaced ${existing})` : ''),
  );
  return result.nodeIds.length;
}

/** Write the transcript out through the existing SubRip / WebVTT writers. */
export function exportTranscript(format: 'srt' | 'vtt', rootId: string = activeCompRootId()): boolean {
  const cues = transcriptCues(rootId);
  if (cues.length === 0) {
    notify('There is no transcript to export. Transcribe the composition first.', 'warning');
    return false;
  }
  const text = format === 'srt' ? toSrt(cues) : toVtt(cues);
  const stem = useCompositionStore.getState().comp().name?.trim() || 'transcript';
  downloadBlob(
    new Blob([text], { type: format === 'srt' ? 'application/x-subrip' : 'text/vtt' }),
    `${stem}.${format}`,
  );
  notify(`Exported ${cues.length} cue(s)`);
  return true;
}
