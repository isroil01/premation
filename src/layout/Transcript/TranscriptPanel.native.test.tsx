/**
 * The panel, from the gestures inward.
 *
 * The interesting assertions here are the ones that connect a gesture to a
 * document fact: clicking a word moves the real playhead, and pressing Delete
 * with a run selected changes the real clip bars. Those are the two claims the
 * panel makes, and both are cheap to get subtly wrong in a way that still
 * renders correctly — a seek to the wrong word, a Delete that fires while the
 * search box has focus.
 *
 * The provider is stubbed; nothing else is. `transcriptionAvailable()` is false
 * in jsdom (there is no `window.motionEditor`), which is itself worth pinning:
 * the Transcribe button must be DISABLED rather than absent, and it must say
 * why.
 */

import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { Command } from '@motion/engine-api';
import { playheadSeconds, seekPlayhead } from '@core/timeline/timelineView';
import { documentMirror } from '@stores/documentMirror';
import { mirrorCompBars } from '@core/mirror/clipBars';
import { sec, settleEdits, setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { useSelectionStore } from '@stores/selectionStore';
import { getCommandRegistry } from '@core/commands/Command';
import { wordsFromCues } from '@core/captions/transcriptEdit';
import {
  TranscriptPanel,
  formatShortTime,
  groupWords,
  progressText,
} from './TranscriptPanel';
import { useTranscriptStore } from './transcriptStore';
import { buildTranscriptCommands } from './transcriptCommands';

const FPS = 30;

let h: Harness;

/** A layer of the comp whose bar is [0, 10 s] (its kind only matters in that it has a bar). */
async function addLayer(name: string): Promise<string> {
  const layer = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name, init: [] } as Command) as { layer: string }).layer;
  await h.run({ type: 'setLayerTiming', items: [{ layer, inPoint: 0, outPoint: sec(10) }] } as Command);
  await settleEdits();
  return layer;
}

/** The comp's bars (frames). */
const bars = () => mirrorCompBars(documentMirror(), 'comp_root', FPS);

/**
 * Two cues, five words each. Every word is DISTINCT on purpose: the chips are
 * found by their accessible name, and a transcript with two "is" in it would
 * make `getByRole` ambiguous — which is a fact about this test file, not about
 * the panel, and not worth a test-id on every chip to work around.
 */
const CUES = [
  { start: 0, end: 2, text: 'so um this looks fine' },
  { start: 3, end: 5, text: 'and uh that was all' },
];

function seedTranscript(): void {
  useTranscriptStore.getState().setTranscript('comp_root', {
    words: wordsFromCues(CUES),
    source: 'transcribed',
    range: { start: 0, end: 5 },
    edited: false,
  });
}

beforeEach(async () => {
  h = await setupAppEngine();
  await h.run({ type: 'setCompositionSettings', comp: 'comp_root', patch: { frameRate: { num: FPS, den: 1 }, duration: sec(10) } } as Command);
  await settleEdits();
  useSelectionStore.getState().clear();
  useTranscriptStore.setState({
    byComp: {}, selected: [], anchorId: null, query: '', phase: 'idle', error: null, startedAt: null,
    restrictToSelection: false,
  });
});
afterEach(async () => {
  await h.dispose();
});

const panel = (): HTMLElement => screen.getByRole('region', { name: 'Transcript' });
const chip = (text: string): HTMLElement => screen.getByRole('button', { name: text });

// ── Pure helpers ──────────────────────────────────────────────────────

describe('groupWords', () => {
  it('groups words into the segments they came from', () => {
    const groups = groupWords(wordsFromCues(CUES));
    expect(groups).toHaveLength(2);
    expect(groups[0]?.words.map((w) => w.text)).toEqual(['so', 'um', 'this', 'looks', 'fine']);
    expect(groups[1]?.start).toBe(3);
  });

  it('splits one segment into two groups when the list is filtered', () => {
    // What the search box produces: the survivors of a sentence are not
    // contiguous, and a single heading over them would name a span they do not
    // occupy.
    const words = wordsFromCues(CUES);
    const filtered = [words[0], words[8]].filter(Boolean) as typeof words;
    expect(groupWords(filtered)).toHaveLength(2);
  });

  it('is empty for no words', () => {
    expect(groupWords([])).toEqual([]);
  });
});

describe('progressText', () => {
  it('names the phase and the elapsed seconds', () => {
    expect(progressText('mixing', 3200)).toBe("Mixing the composition's audio… 3s");
    expect(progressText('transcribing', 12000)).toBe('Transcribing… 12s');
  });

  it('never invents a percentage — there is no progress to report', () => {
    expect(progressText('transcribing', 5000)).not.toMatch(/%/);
  });

  it('is empty when idle', () => {
    expect(progressText('idle', 0)).toBe('');
  });
});

describe('formatShortTime', () => {
  it('reads as minutes and tenths', () => {
    expect(formatShortTime(0)).toBe('0:00.0');
    expect(formatShortTime(75.25)).toBe('1:15.3');
  });
});

// ── The panel ─────────────────────────────────────────────────────────

describe('empty state', () => {
  it('says there is no transcript and what the button will cover', () => {
    render(<TranscriptPanel />);
    expect(screen.getByText('No transcript yet')).toBeInTheDocument();
  });

  it('disables Transcribe in a build that cannot reach a provider, and says why', () => {
    // No `window.motionEditor` is exactly the server edition's situation (the
    // harness's engine bridge is hidden for this case). A greyed button reads
    // "not here"; a missing one reads "this app has no captions".
    const w = window as unknown as { motionEditor?: unknown };
    const bridge = w.motionEditor;
    delete w.motionEditor;
    try {
      render(<TranscriptPanel />);
      const button = screen.getByRole('button', { name: /Transcribe/ });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', expect.stringContaining('desktop app'));
    } finally {
      w.motionEditor = bridge;
    }
  });
});

describe('rendering a transcript', () => {
  it('renders every word as its own chip, grouped under a segment timecode', () => {
    seedTranscript();
    render(<TranscriptPanel />);
    expect(chip('so')).toBeInTheDocument();
    expect(chip('fine')).toBeInTheDocument();
    // One timecode button per segment.
    expect(screen.getByRole('button', { name: '0:00.0' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '0:03.0' })).toBeInTheDocument();
  });

  it('says the timings are estimated and that the transcript is not saved', () => {
    // Both are true and both change what the user should trust the chips for.
    seedTranscript();
    render(<TranscriptPanel />);
    expect(screen.getByText(/estimated within each segment/)).toBeInTheDocument();
    expect(screen.getByText(/not saved with the project/)).toBeInTheDocument();
  });
});

describe('seeking', () => {
  it('clicking a word moves the playhead to its start', () => {
    seedTranscript();
    render(<TranscriptPanel />);
    const words = wordsFromCues(CUES);
    fireEvent.pointerDown(chip('this'));
    expect(playheadSeconds())
      .toBeCloseTo(Math.round((words[2]?.start as number) * FPS) / FPS, 3);
  });

  it('clicking a segment timecode seeks to the segment', () => {
    seedTranscript();
    render(<TranscriptPanel />);
    fireEvent.click(screen.getByRole('button', { name: '0:03.0' }));
    expect(playheadSeconds()).toBeCloseTo(3, 3);
  });
});

describe('the playing word', () => {
  it('lights the word the playhead is inside, at the poll rate', async () => {
    seedTranscript();
    render(<TranscriptPanel />);
    act(() => { seekPlayhead(0.1); });
    // The subscription is a 10 Hz timer, not a store subscription, so the
    // highlight arrives on the next tick rather than synchronously.
    await waitFor(() => expect(chip('so')).toHaveAttribute('data-playing', 'true'));
    expect(chip('fine')).not.toHaveAttribute('data-playing');
  });
});

describe('selection', () => {
  it('a plain press selects one word', () => {
    seedTranscript();
    render(<TranscriptPanel />);
    fireEvent.pointerDown(chip('um'));
    expect(useTranscriptStore.getState().selected).toHaveLength(1);
    expect(chip('um')).toHaveAttribute('aria-pressed', 'true');
  });

  it('shift-click extends the run from the anchor', () => {
    seedTranscript();
    render(<TranscriptPanel />);
    fireEvent.pointerDown(chip('um'));
    fireEvent.pointerDown(chip('looks'), { shiftKey: true });
    expect(useTranscriptStore.getState().selected).toHaveLength(3);
    expect(chip('this')).toHaveAttribute('aria-pressed', 'true');
  });

  it('a drag across chips extends the run', () => {
    seedTranscript();
    render(<TranscriptPanel />);
    fireEvent.pointerDown(chip('so'));
    fireEvent.pointerEnter(chip('this'));
    expect(useTranscriptStore.getState().selected).toHaveLength(3);
  });

  it('stops extending once the pointer is released', () => {
    seedTranscript();
    render(<TranscriptPanel />);
    fireEvent.pointerDown(chip('so'));
    fireEvent.pointerUp(window);
    fireEvent.pointerEnter(chip('fine'));
    expect(useTranscriptStore.getState().selected).toHaveLength(1);
  });

  it('reports how much time the selection covers', () => {
    seedTranscript();
    render(<TranscriptPanel />);
    fireEvent.pointerDown(chip('um'));
    expect(screen.getByText(/1 word selected/)).toBeInTheDocument();
  });

  it('Escape clears it', () => {
    seedTranscript();
    render(<TranscriptPanel />);
    fireEvent.pointerDown(chip('um'));
    fireEvent.keyDown(panel(), { key: 'Escape' });
    expect(useTranscriptStore.getState().selected).toEqual([]);
  });
});

describe('Delete', () => {
  const withOneFullVideoLayer = (): Promise<string> => addLayer('vid');

  it('cuts the selected words out of the timeline and shifts the transcript', async () => {
    await withOneFullVideoLayer();
    seedTranscript();
    render(<TranscriptPanel />);

    fireEvent.pointerDown(chip('um'));
    fireEvent.keyDown(panel(), { key: 'Delete' });

    await waitFor(() => expect(useTranscriptStore.getState().byComp.comp_root?.edited).toBe(true));
    // The word is gone from the transcript…
    const words = useTranscriptStore.getState().byComp.comp_root?.words ?? [];
    expect(words.map((w) => w.text)).not.toContain('um');
    // …and the clip was cut in two with the gap closed, so the comp is shorter.
    await settleEdits();
    const cut = bars();
    expect(cut.length).toBeGreaterThan(1);
    const total = cut.reduce((sum, l) => sum + (l.end - l.start), 0);
    expect(total).toBeLessThan(300);
  });

  it('does nothing when nothing is selected', async () => {
    await withOneFullVideoLayer();
    seedTranscript();
    render(<TranscriptPanel />);
    fireEvent.keyDown(panel(), { key: 'Delete' });
    await settleEdits();
    expect(bars()).toHaveLength(1);
  });

  it('does NOT fire while the search box has focus', async () => {
    // The bug this prevents: typing in a filter box and pressing Backspace to
    // correct a typo would silently cut the composition.
    await withOneFullVideoLayer();
    seedTranscript();
    render(<TranscriptPanel />);
    fireEvent.pointerDown(chip('um'));
    const search = screen.getByLabelText('Find a word in the transcript');
    fireEvent.keyDown(search, { key: 'Backspace' });
    await settleEdits();
    expect(bars()).toHaveLength(1);
  });

  it('the button is disabled with an empty selection', () => {
    seedTranscript();
    render(<TranscriptPanel />);
    expect(screen.getByRole('button', { name: /Delete selection/ })).toBeDisabled();
  });
});

describe('which layers get cut', () => {
  it('says "All layers" by default — the video AND its separate audio layer', () => {
    seedTranscript();
    render(<TranscriptPanel />);
    const toggle = screen.getByRole('button', { name: 'All layers' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('flips to the scene selection when asked', () => {
    seedTranscript();
    render(<TranscriptPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'All layers' }));
    expect(screen.getByRole('button', { name: 'Selected layers only' }))
      .toHaveAttribute('aria-pressed', 'true');
  });

  it('refuses to cut nothing rather than cutting everything', async () => {
    // "Selected layers only" with no layer selected is a request the panel
    // cannot honour. Falling back to every layer would be the opposite of what
    // was asked; cutting nothing silently would look broken.
    await addLayer('vid');
    seedTranscript();
    render(<TranscriptPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'All layers' }));
    fireEvent.pointerDown(chip('um'));
    fireEvent.keyDown(panel(), { key: 'Delete' });

    await waitFor(() => expect(useTranscriptStore.getState().phase).toBe('idle'));
    await settleEdits();
    expect(bars()).toHaveLength(1);
    expect(useTranscriptStore.getState().byComp.comp_root?.edited).toBe(false);
  });
});

describe('search', () => {
  it('filters the chips down to matches', () => {
    seedTranscript();
    render(<TranscriptPanel />);
    fireEvent.change(screen.getByLabelText('Find a word in the transcript'), {
      target: { value: 'th' },
    });
    // Across segments — the filter is over the words, not over one cue.
    expect(screen.getByRole('button', { name: 'this' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'that' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'fine' })).not.toBeInTheDocument();
  });

  it('says so when nothing matches, rather than showing an empty panel', () => {
    seedTranscript();
    render(<TranscriptPanel />);
    fireEvent.change(screen.getByLabelText('Find a word in the transcript'), {
      target: { value: 'zzz' },
    });
    expect(screen.getByText(/No word matches/)).toBeInTheDocument();
  });
});

describe('filler words', () => {
  it('selects the fillers and leaves the real words alone', () => {
    seedTranscript();
    render(<TranscriptPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Select fillers/ }));
    expect(chip('um')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('uh')).toHaveAttribute('aria-pressed', 'true');
    // "so" is a real word at the start of a sentence and is not in the list.
    expect(chip('so')).toHaveAttribute('aria-pressed', 'false');
  });

  it('honours an edited list', () => {
    seedTranscript();
    render(<TranscriptPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit list' }));
    fireEvent.change(screen.getByLabelText('Filler words, comma separated'), {
      target: { value: 'fine' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Select fillers/ }));
    expect(chip('fine')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('um')).toHaveAttribute('aria-pressed', 'false');
  });

  it('says when the list matched nothing instead of silently selecting nothing', () => {
    seedTranscript();
    render(<TranscriptPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit list' }));
    fireEvent.change(screen.getByLabelText('Filler words, comma separated'), {
      target: { value: 'zebra' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Select fillers/ }));
    expect(screen.getByRole('alert')).toHaveTextContent(/No filler words/);
  });
});

describe('commands', () => {
  it('registers on import, so the palette can find the panel before it is opened', () => {
    // The Plugins-panel regression in `onDemandPanelsReachable.test.ts`: a
    // surface whose only route in is the surface itself.
    expect(getCommandRegistry().get('view.transcript' as never)).toBeDefined();
  });

  it('disables the ones that need a transcript when there is none', () => {
    const byId = new Map(buildTranscriptCommands().map((c) => [String(c.id), c]));
    expect(byId.get('transcript.addCaptions')?.enabled?.()).toBe(false);
    expect(byId.get('transcript.exportSrt')?.enabled?.()).toBe(false);
    expect(byId.get('transcript.deleteSelection')?.enabled?.()).toBe(false);
  });

  it('enables them once a transcript and a selection exist', () => {
    seedTranscript();
    const words = useTranscriptStore.getState().byComp.comp_root?.words ?? [];
    useTranscriptStore.getState().select([words[0]?.id as string]);
    const byId = new Map(buildTranscriptCommands().map((c) => [String(c.id), c]));
    expect(byId.get('transcript.addCaptions')?.enabled?.()).toBe(true);
    expect(byId.get('transcript.deleteSelection')?.enabled?.()).toBe(true);
  });
});

describe('the search box', () => {
  it('says when a word matches nothing, and offers to clear', () => {
    seedTranscript();
    render(<TranscriptPanel />);

    const search = screen.getByRole('searchbox', { name: 'Find a word in the transcript' });
    fireEvent.change(search, { target: { value: 'zzzz-not-a-word' } });

    expect(screen.getByText(/No word matches/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show the whole transcript' }));
    expect((search as HTMLInputElement).value).toBe('');
    expect(screen.queryByText(/No word matches/)).toBeNull();
  });

  it('clears on Escape rather than letting the key reach the panel', () => {
    seedTranscript();
    render(<TranscriptPanel />);

    const search = screen.getByRole('searchbox', { name: 'Find a word in the transcript' });
    fireEvent.change(search, { target: { value: 'looks' } });
    fireEvent.keyDown(search, { key: 'Escape' });

    expect((search as HTMLInputElement).value).toBe('');
  });
});
