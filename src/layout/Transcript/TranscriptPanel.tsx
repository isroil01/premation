/**
 * Transcript — editing the video by editing its words.
 *
 * ## What this surface is for
 *
 * Everything else in this app edits time by pointing at time: a bar, a
 * playhead, a frame number. This panel is the one place that edits time by
 * pointing at CONTENT. Select "um, so, anyway" and press Delete and the comp
 * loses those two seconds — picture, sound, captions and all — with the gap
 * closed behind it. That is a different job from captions, which is why it is a
 * panel and captions are commands: captions are something you do twice per
 * project, a transcript edit is something you sit in.
 *
 * ## Why the words are chips and not a text area
 *
 * A `<textarea>` would be the obvious rendering and it cannot work: every word
 * has to carry its own time range, be individually clickable, be individually
 * selectable in runs, and light up as the playhead passes it. That is a list of
 * buttons, and calling it a paragraph would mean reimplementing selection,
 * hit-testing and highlighting against a text node's character offsets — for a
 * transcript nobody types into. Words are read here and deleted here; they are
 * not typed here, and the panel does not pretend otherwise.
 *
 * ## The playhead subscription
 *
 * Ten hertz, on a timer, from `TimelineController.currentSeconds` — the same
 * rate and the same argument as the Scopes panel. Nobody reads a moving word at
 * 60 Hz, and a `setState` per frame would re-render every chip in a
 * five-hundred-word transcript sixty times a second to move one highlight. The
 * timer only runs while the panel is on screen: a docked panel behind another
 * tab stays MOUNTED, so unmount is not the signal — the `ResizeObserver`
 * measuring zero is.
 *
 * ## What the word timings actually are
 *
 * Estimates, and the panel says so. See `transcriptEdit.ts` — the provider
 * returns segment timings, and word times are interpolated inside them. The
 * chips are exact enough to select a phrase and cut it; they are not frame
 * accurate, and a UI that implied they were would be lying about the one thing
 * the user is about to cut with.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { Input } from '@components/Input';
import { cn } from '@utils/cn';
import { activeCompRootId } from '@core/scene/activeComp';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useWorkspaceStore } from '@stores/projectStore';
import {
  findFillerWordIds,
  idsBetween,
  parseFillerList,
  selectionRanges,
  wordAtTime,
  wordMatchesQuery,
  type TranscriptWord,
} from '@core/captions/transcriptEdit';
import {
  addTranscriptAsCaptions,
  deleteSelectedWords,
  exportTranscript,
  runTranscription,
  transcribeScope,
  transcriptFromCaptions,
  transcriptionAvailable,
} from './transcriptOps';
import { useTranscriptStore, type CompTranscript } from './transcriptStore';
import styles from './TranscriptPanel.module.css';

/** Playhead poll rate. The ceiling the task set, and the Scopes panel's rate. */
export const PLAYHEAD_HZ = 10;

/** `M:SS.s` — short enough to sit on a segment header without wrapping. */
export function formatShortTime(seconds: number): string {
  const t = Math.max(0, seconds);
  const minutes = Math.floor(t / 60);
  const rest = t - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}

/** The progress line while a transcription runs. */
export function progressText(
  phase: 'idle' | 'mixing' | 'transcribing' | 'editing',
  elapsedMs: number,
): string {
  const secs = Math.floor(elapsedMs / 1000);
  switch (phase) {
    case 'mixing':
      return `Mixing the composition's audio… ${secs}s`;
    case 'transcribing':
      // No percentage, because there is no percentage to report — one upload,
      // one wait. Saying "47%" would be inventing a number.
      return `Transcribing… ${secs}s`;
    case 'editing':
      return 'Cutting the timeline…';
    default:
      return '';
  }
}

/** Words grouped into the segments they came from, for the rendered list. */
export interface WordGroup {
  readonly cueIndex: number;
  readonly start: number;
  readonly end: number;
  readonly words: readonly TranscriptWord[];
}

/**
 * Group a (possibly filtered) word list into contiguous runs of one segment.
 *
 * Runs rather than segments, for the same reason `cuesFromWords` uses runs: a
 * filtered list is not contiguous, and lumping the survivors of one sentence
 * under one timecode would put a heading on a group whose words are minutes
 * apart.
 */
export function groupWords(words: readonly TranscriptWord[]): WordGroup[] {
  const groups: WordGroup[] = [];
  for (const word of words) {
    const last = groups[groups.length - 1];
    if (last && last.cueIndex === word.cueIndex) {
      groups[groups.length - 1] = {
        cueIndex: last.cueIndex,
        start: last.start,
        end: Math.max(last.end, word.end),
        words: [...last.words, word],
      };
      continue;
    }
    groups.push({ cueIndex: word.cueIndex, start: word.start, end: word.end, words: [word] });
  }
  return groups;
}

export function TranscriptPanel(): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(true);
  const [playhead, setPlayhead] = useState(0);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [showFillers, setShowFillers] = useState(false);
  const dragging = useRef(false);

  // The comp the panel is looking at. Read from the workspace store rather than
  // called once, so switching tabs swaps the transcript instead of leaving the
  // previous comp's words under a different comp's timeline.
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const rootId = useMemo(() => activeCompRootId(), [activeTabId]);

  const transcript = useTranscriptStore((s) => s.byComp[rootId]);
  const phase = useTranscriptStore((s) => s.phase);
  const startedAt = useTranscriptStore((s) => s.startedAt);
  const error = useTranscriptStore((s) => s.error);
  const selected = useTranscriptStore((s) => s.selected);
  const anchorId = useTranscriptStore((s) => s.anchorId);
  const query = useTranscriptStore((s) => s.query);
  const fillerText = useTranscriptStore((s) => s.fillerText);
  const restrictToSelection = useTranscriptStore((s) => s.restrictToSelection);
  const setRestrictToSelection = useTranscriptStore((s) => s.setRestrictToSelection);
  const setQuery = useTranscriptStore((s) => s.setQuery);
  const setFillerText = useTranscriptStore((s) => s.setFillerText);
  const select = useTranscriptStore((s) => s.select);
  const clearSelection = useTranscriptStore((s) => s.clearSelection);
  const setAnchor = useTranscriptStore((s) => s.setAnchor);
  const setTranscript = useTranscriptStore((s) => s.setTranscript);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const words = transcript?.words ?? [];

  const filtered = useMemo(
    () => (query.trim() === '' ? words : words.filter((w) => wordMatchesQuery(w, query))),
    [words, query],
  );
  const groups = useMemo(() => groupWords(filtered), [filtered]);

  /**
   * Seed from the comp's caption layers when there is no cached transcript.
   *
   * The recovery path the store's header describes: a transcript does not
   * survive a reload, captions do, so a comp that already has captions can show
   * a transcript immediately instead of asking for a second provider call.
   */
  useEffect(() => {
    if (transcript) return;
    const seeded = transcriptFromCaptions(rootId);
    if (seeded) setTranscript(rootId, seeded);
  }, [rootId, transcript, setTranscript]);

  /**
   * On screen or not. A docked panel on an inactive tab stays mounted and
   * measures zero, which is the only reliable signal — and the difference
   * between a 10 Hz timer that stops and one that runs forever behind a tab.
   */
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      setVisible(!!rect && rect.width > 0 && rect.height > 0);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** The playhead, at 10 Hz, and only while there is a transcript to light up. */
  useEffect(() => {
    if (!visible || words.length === 0) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = (): void => {
      timer = null;
      if (stopped) return;
      const seconds = getTimelineController().currentSeconds;
      // Only a CHANGE re-renders. During a pause this is a no-op ten times a
      // second, which is the cheapest thing a subscription can be.
      setPlayhead((prev) => (Math.abs(prev - seconds) < 1e-4 ? prev : seconds));
      timer = setTimeout(tick, 1000 / PLAYHEAD_HZ);
    };
    tick();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [visible, words.length]);

  /** The elapsed counter, which only exists while something is running. */
  useEffect(() => {
    if (phase === 'idle' || startedAt === null) {
      setElapsed(0);
      return undefined;
    }
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 250);
    setElapsed(Date.now() - startedAt);
    return () => clearInterval(id);
  }, [phase, startedAt]);

  const playingWordId = useMemo(() => wordAtTime(words, playhead)?.id ?? null, [words, playhead]);

  // ── Gestures ────────────────────────────────────────────────────────

  const seekTo = useCallback((word: TranscriptWord) => {
    getTimelineController().seekSeconds(word.start);
  }, []);

  const onWordPointerDown = useCallback(
    (word: TranscriptWord, event: ReactPointerEvent<HTMLButtonElement>) => {
      // Shift extends from the anchor; a plain press starts a new run and arms
      // the drag. Ctrl/Cmd toggles one chip, which is how every list in this
      // app already behaves.
      if (event.shiftKey && anchorId) {
        select(idsBetween(filtered, anchorId, word.id), 'replace');
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        select([word.id], 'toggle');
        setAnchor(word.id);
        return;
      }
      dragging.current = true;
      setAnchor(word.id);
      select([word.id], 'replace');
      seekTo(word);
    },
    [anchorId, filtered, select, setAnchor, seekTo],
  );

  const onWordPointerEnter = useCallback(
    (word: TranscriptWord) => {
      if (!dragging.current || !anchorId) return;
      select(idsBetween(filtered, anchorId, word.id), 'replace');
    },
    [anchorId, filtered, select],
  );

  useEffect(() => {
    const stop = (): void => { dragging.current = false; };
    window.addEventListener('pointerup', stop);
    return () => window.removeEventListener('pointerup', stop);
  }, []);

  const runDelete = useCallback(async () => {
    if (busy || selected.length === 0) return;
    setBusy(true);
    useTranscriptStore.getState().setPhase('editing');
    try {
      await deleteSelectedWords(rootId);
    } finally {
      useTranscriptStore.getState().setPhase('idle');
      setBusy(false);
    }
  }, [busy, rootId, selected.length]);

  /**
   * Delete, while the panel has focus.
   *
   * Scoped to this subtree rather than to the window: Delete is the timeline's
   * and the canvas's key too, and a window listener here would delete words
   * because the user pressed Delete over a layer. `onKeyDown` on the root with
   * a `tabIndex` is what "the panel has focus" means in the DOM.
   */
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selected.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        void runDelete();
        return;
      }
      if (event.key === 'Escape' && selected.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        clearSelection();
      }
    },
    [clearSelection, runDelete, selected.length],
  );

  const runTranscribe = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await runTranscription();
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const selectFillers = useCallback(() => {
    const ids = findFillerWordIds(words, parseFillerList(fillerText));
    select(ids, 'replace');
    if (ids.length === 0) {
      useTranscriptStore.getState().setError('No filler words from that list are in this transcript.');
      return;
    }
    useTranscriptStore.getState().setError(null);
  }, [fillerText, select, words]);

  // ── Render ──────────────────────────────────────────────────────────

  const scope = useMemo(
    () => transcribeScope(),
    // Deliberately keyed on the comp and the transcript rather than on the
    // scene selection: the button's LABEL names the range it will cover, which
    // is the only warning the user gets before a billable call, and it does not
    // need to be re-derived ten times a second while the playhead moves. The
    // range itself is read again at click time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transcript, activeTabId],
  );
  const ranges = useMemo(
    () => (transcript ? selectionRanges(transcript.words, selectedSet) : []),
    [transcript, selectedSet],
  );
  const selectedSeconds = ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
  const available = transcriptionAvailable();

  return (
    <div
      className={styles.root}
      ref={rootRef}
      tabIndex={0}
      role="region"
      aria-label="Transcript"
      onKeyDown={onKeyDown}
    >
      <div className={styles.toolbar}>
        <Button
          size="xs"
          variant="primary"
          leftIcon={<Icon name="mic" size="sm" />}
          disabled={busy || !available}
          onClick={() => { void runTranscribe(); }}
          title={
            available
              ? `Transcribe the ${scope.label}`
              : 'This build cannot transcribe audio — the desktop app holds the provider key.'
          }
        >
          {transcript ? 'Re-transcribe' : 'Transcribe'}
        </Button>
        <Button
          size="xs"
          leftIcon={<Icon name="trash" size="sm" />}
          disabled={busy || selected.length === 0}
          onClick={() => { void runDelete(); }}
          title="Remove the selected words' time from the composition and close the gap (Delete)"
        >
          Delete selection
        </Button>
        <button
          type="button"
          className={styles.scopeToggle}
          aria-pressed={restrictToSelection}
          onClick={() => setRestrictToSelection(!restrictToSelection)}
          title={
            restrictToSelection
              ? 'Cutting only the layers selected in the scene. The gap still closes for every layer.'
              : 'Cutting every layer the selection crosses — including a video’s separate audio layer.'
          }
        >
          {restrictToSelection ? 'Selected layers only' : 'All layers'}
        </button>
        <span className={styles.spacer} />
        <Button
          size="xs"
          leftIcon={<Icon name="type" size="sm" />}
          disabled={busy || words.length === 0}
          onClick={() => addTranscriptAsCaptions(rootId)}
          title="Create one text layer per segment, timed to the edited transcript"
        >
          Add as captions
        </Button>
        <Button
          size="xs"
          leftIcon={<Icon name="download" size="sm" />}
          disabled={words.length === 0}
          onClick={() => exportTranscript('srt', rootId)}
          title="Export the transcript as SubRip"
        >
          SRT
        </Button>
        <Button
          size="xs"
          leftIcon={<Icon name="download" size="sm" />}
          disabled={words.length === 0}
          onClick={() => exportTranscript('vtt', rootId)}
          title="Export the transcript as WebVTT"
        >
          VTT
        </Button>
      </div>

      <div className={styles.toolbar}>
        <Input
          size="xs"
          leftIcon="search"
          placeholder="Find a word"
          value={query}
          clearable
          onClear={() => setQuery('')}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Find a word in the transcript"
        />
        <Button
          size="xs"
          leftIcon={<Icon name="magic-wand" size="sm" />}
          disabled={words.length === 0}
          onClick={selectFillers}
          title="Select every filler word, ready to delete"
        >
          Select fillers
        </Button>
        <button
          type="button"
          className={styles.linkButton}
          aria-expanded={showFillers}
          onClick={() => setShowFillers((v) => !v)}
        >
          {showFillers ? 'Hide list' : 'Edit list'}
        </button>
      </div>

      {showFillers && (
        <textarea
          className={styles.fillerList}
          value={fillerText}
          spellCheck={false}
          aria-label="Filler words, comma separated"
          onChange={(e) => setFillerText(e.target.value)}
        />
      )}

      {phase !== 'idle' && (
        <div className={styles.progress} role="status">
          <span className={styles.spinner} aria-hidden="true" />
          {progressText(phase, elapsed)}
        </div>
      )}

      {error && <div className={styles.error} role="alert">{error}</div>}

      {transcript && (
        <div className={styles.meta}>
          {transcript.source === 'captions'
            ? 'Rebuilt from this composition’s caption layers'
            : `Transcribed ${formatShortTime(transcript.range.start)}–${formatShortTime(transcript.range.end)}`}
          {transcript.edited ? ' · edited' : ''}
          {' · '}
          {words.length} words · word timings are estimated within each segment
          {' · not saved with the project'}
        </div>
      )}

      {selected.length > 0 && (
        <div className={styles.selectionBar}>
          {selected.length} word{selected.length === 1 ? '' : 's'} selected ·{' '}
          {selectedSeconds.toFixed(2)}s in {ranges.length} range{ranges.length === 1 ? '' : 's'}
          <button type="button" className={styles.linkButton} onClick={clearSelection}>
            Clear
          </button>
        </div>
      )}

      <div className={styles.body}>
        {words.length === 0 && phase === 'idle' && (
          <div className={styles.empty}>
            <Icon name="mic" size="lg" />
            <p className={styles.emptyTitle}>No transcript yet</p>
            <p className={styles.emptyText}>
              {available
                ? `Transcribe the ${scope.label} `
                  + `(${(scope.end - scope.start).toFixed(1)}s of audio), `
                  + 'then click a word to seek, drag or shift-click to select a run, and press '
                  + 'Delete to cut that time out of every layer.'
                : 'Transcription runs in the desktop app, which holds your provider key. '
                  + 'This build cannot reach one.'}
            </p>
          </div>
        )}

        {words.length > 0 && filtered.length === 0 && (
          <div className={styles.empty}>
            <p className={styles.emptyText}>No word matches “{query}”.</p>
          </div>
        )}

        {groups.map((group) => (
          <div className={styles.segment} key={`${group.cueIndex}_${group.start}`}>
            <button
              type="button"
              className={styles.segmentTime}
              onClick={() => getTimelineController().seekSeconds(group.start)}
              title="Seek to this segment"
            >
              {formatShortTime(group.start)}
            </button>
            <div className={styles.words}>
              {group.words.map((word) => (
                <button
                  type="button"
                  key={word.id}
                  data-word-id={word.id}
                  // `data-playing` mirrors the class rather than duplicating
                  // it: CSS-module names do not survive a test build, and the
                  // one thing a test of a live highlight must be able to see is
                  // WHICH word is lit.
                  data-playing={playingWordId === word.id ? 'true' : undefined}
                  className={cn(
                    styles.word,
                    selectedSet.has(word.id) && styles.wordSelected,
                    playingWordId === word.id && styles.wordPlaying,
                  )}
                  aria-pressed={selectedSet.has(word.id)}
                  title={`${formatShortTime(word.start)} – ${formatShortTime(word.end)} (estimated)`}
                  onPointerDown={(e) => onWordPointerDown(word, e)}
                  onPointerEnter={() => onWordPointerEnter(word)}
                >
                  {word.text}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Exported for the panel test — the shape the store hands the list. */
export type { CompTranscript };
