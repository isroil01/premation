/**
 * The Transcript panel's own state.
 *
 * ## Why it is here and not in `src/stores`
 *
 * `src/stores` is the DOCUMENT's state — the set `docFeatureCounts.test.ts`
 * pins a number for, and the set `cloudDocument.ts` captures and restores.
 * Nothing in this file belongs in a saved project: a transcript is a cache of
 * what a provider said about the audio, a selection is a gesture in progress,
 * and a search box is a search box.
 *
 * ## Why the transcript is SESSION-ONLY, and what that costs
 *
 * There is no home for a transcript in the document. Captions have one — they
 * are text layers carrying `__caption` (`captionLayers.ts`), which is a real
 * document home and the reason "Add as captions" is the button that makes an
 * edit durable. A transcript is not captions: it holds word-level timings, a
 * cue index and a selection, and inventing a `__transcript` blob on the comp
 * root to hold it would put a second source of truth for "when is this word"
 * beside the clip bars that already answer it — the exact mistake
 * `captionLayers.ts` documents itself as avoiding.
 *
 * So: reopening the project loses the transcript, and the panel SAYS so. What
 * survives is the recovery path — a comp that has caption layers can rebuild a
 * transcript from them (`readCaptionCues`), which the panel does automatically
 * when it opens onto a comp it has no cache for. That is not the same fidelity
 * (word timings are re-estimated from the cue), and the panel says that too.
 *
 * The cache is keyed by composition ROOT NODE ID, which is what the timeline
 * registries are keyed by — so switching tabs shows that comp's transcript
 * rather than the last one transcribed.
 */

import { create } from 'zustand';
import {
  DEFAULT_FILLER_WORDS,
  type TranscriptWord,
  type TimeRange,
} from '@core/captions/transcriptEdit';

/** Where a comp's transcript came from. Shown to the user; not decoration. */
export type TranscriptSource = 'transcribed' | 'captions';

export interface CompTranscript {
  readonly words: readonly TranscriptWord[];
  readonly source: TranscriptSource;
  /** The comp-time window that was transcribed. */
  readonly range: TimeRange;
  /** Language the provider reported, when it reported one. */
  readonly language?: string;
  /** True once a deletion has been applied to it. */
  readonly edited: boolean;
}

/** What the panel is doing, for the progress line. */
export type TranscriptPhase = 'idle' | 'mixing' | 'transcribing' | 'editing';

interface TranscriptState {
  /** Transcripts by composition root node id. Session-only — see the header. */
  byComp: Readonly<Record<string, CompTranscript>>;
  phase: TranscriptPhase;
  /** Epoch ms the current run started, for the elapsed counter. */
  startedAt: number | null;
  error: string | null;
  /** Selected word ids, in the order they were added. */
  selected: readonly string[];
  /** Where a shift-click measures from. */
  anchorId: string | null;
  query: string;
  /** The editable filler list, as typed. */
  fillerText: string;
  /**
   * Cut only the layers selected in the scene, rather than everything the
   * range crosses.
   *
   * Off by default, because "delete these words" almost always means delete
   * them from the video AND from its separate audio layer, and a default that
   * cut only what happened to be selected would leave the sound of the words
   * the user just removed. The gap still closes for every layer either way —
   * see `transcriptOps.deleteTimeRanges`.
   */
  restrictToSelection: boolean;
}

interface TranscriptActions {
  setTranscript(rootId: string, transcript: CompTranscript): void;
  /** Replace a comp's words after an edit, keeping its provenance. */
  replaceWords(rootId: string, words: readonly TranscriptWord[]): void;
  clearTranscript(rootId: string): void;
  setPhase(phase: TranscriptPhase): void;
  setError(error: string | null): void;
  select(ids: readonly string[], mode?: 'replace' | 'add' | 'toggle'): void;
  clearSelection(): void;
  setAnchor(id: string | null): void;
  setQuery(query: string): void;
  setFillerText(text: string): void;
  setRestrictToSelection(on: boolean): void;
}

export const DEFAULT_FILLER_TEXT = DEFAULT_FILLER_WORDS.join(', ');

export const useTranscriptStore = create<TranscriptState & TranscriptActions>((set) => ({
  byComp: {},
  phase: 'idle',
  startedAt: null,
  error: null,
  selected: [],
  anchorId: null,
  query: '',
  fillerText: DEFAULT_FILLER_TEXT,
  restrictToSelection: false,

  setTranscript: (rootId, transcript) =>
    set((s) => ({
      byComp: { ...s.byComp, [rootId]: transcript },
      // A fresh transcript invalidates a selection made against the old one:
      // the ids are regenerated per transcript, so keeping them would leave a
      // selection that highlights nothing and deletes nothing.
      selected: [],
      anchorId: null,
      error: null,
    })),

  replaceWords: (rootId, words) =>
    set((s) => {
      const existing = s.byComp[rootId];
      if (!existing) return {};
      return {
        byComp: { ...s.byComp, [rootId]: { ...existing, words, edited: true } },
        selected: [],
        anchorId: null,
      };
    }),

  clearTranscript: (rootId) =>
    set((s) => {
      const next = { ...s.byComp };
      delete next[rootId];
      return { byComp: next, selected: [], anchorId: null };
    }),

  setPhase: (phase) =>
    set((s) => ({
      phase,
      // The clock starts on the first non-idle phase and keeps running across
      // the phase change, so "mixing" → "transcribing" does not reset the
      // elapsed counter halfway through one wait.
      startedAt: phase === 'idle' ? null : s.startedAt ?? Date.now(),
    })),

  setError: (error) => set({ error }),

  select: (ids, mode = 'replace') =>
    set((s) => {
      if (mode === 'replace') return { selected: [...ids] };
      if (mode === 'add') {
        const seen = new Set(s.selected);
        return { selected: [...s.selected, ...ids.filter((id) => !seen.has(id))] };
      }
      const seen = new Set(s.selected);
      const next = s.selected.filter((id) => !ids.includes(id));
      return { selected: [...next, ...ids.filter((id) => !seen.has(id))] };
    }),

  clearSelection: () => set({ selected: [], anchorId: null }),
  setAnchor: (anchorId) => set({ anchorId }),
  setQuery: (query) => set({ query }),
  setFillerText: (fillerText) => set({ fillerText }),
  setRestrictToSelection: (restrictToSelection) => set({ restrictToSelection }),
}));

/** Read a comp's transcript outside React (commands, `enabled` predicates). */
export function transcriptFor(rootId: string): CompTranscript | undefined {
  return useTranscriptStore.getState().byComp[rootId];
}
