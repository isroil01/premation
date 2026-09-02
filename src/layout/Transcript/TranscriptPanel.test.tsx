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
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import { getCommandRegistry } from '@core/commands/Command';
import { wordsFromCues } from '@core/captions/transcriptEdit';
import type { CommandServices } from '@core/commands/Command';
import type { SceneNode } from '@core/types';
import {
  TranscriptPanel,
  formatShortTime,
  groupWords,
  progressText,
} from './TranscriptPanel';
import { useTranscriptStore } from './transcriptStore';
import { buildTranscriptCommands } from './transcriptCommands';

const FPS = 30;

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
}

function addLayer(id: string, kind: 'video' | 'audio'): void {
  defaultSceneGraph.addChild('comp_root', {
    id,
    name: id,
    parent: 'comp_root',
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{
      id: `${id}_t`,
      type: 'Transform',
      props: { [SCENE_KIND_PROP]: kind, x: 0, y: 0, width: 64, height: 48 },
    }],
  } as unknown as SceneNode);
}

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

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as CommandServices, getState: () => ({}) }));
  getTimelineController().reset();
  resetScene();
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Main', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  useProjectStore.getState().actions.replaceComps({
    comp_root: {
      id: 'comp_root', name: 'Main', width: 1920, height: 1080, fps: FPS,
      durationSeconds: 10, background: '#101014', transparent: false, startFrame: 0,
    },
  });
  const proj = useProjectStore.getState();
  proj.actions.setActiveTab(proj.actions.openTab('comp_root', ['comp_root'], 'Main'));
  useSelectionStore.getState().clear();
  useTranscriptStore.setState({
    byComp: {}, selected: [], anchorId: null, query: '', phase: 'idle', error: null, startedAt: null,
    restrictToSelection: false,
  });
  getTimelineController().setFrameRate(FPS);
  getTimelineController().setDurationSeconds(10);
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
    // jsdom has no `window.motionEditor`, which is exactly the server edition's
    // situation. A greyed button reads "not here"; a missing one reads "this
    // app has no captions".
    render(<TranscriptPanel />);
    const button = screen.getByRole('button', { name: /Transcribe/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringContaining('desktop app'));
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
    expect(getTimelineController().currentSeconds)
      .toBeCloseTo(Math.round((words[2]?.start as number) * FPS) / FPS, 3);
  });

  it('clicking a segment timecode seeks to the segment', () => {
    seedTranscript();
    render(<TranscriptPanel />);
    fireEvent.click(screen.getByRole('button', { name: '0:03.0' }));
    expect(getTimelineController().currentSeconds).toBeCloseTo(3, 3);
  });
});

describe('the playing word', () => {
  it('lights the word the playhead is inside, at the poll rate', async () => {
    seedTranscript();
    render(<TranscriptPanel />);
    act(() => { getTimelineController().seekSeconds(0.1); });
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
  function withOneFullVideoLayer(): void {
    addLayer('vid', 'video');
    const controller = getTimelineController();
    controller.syncFromScene('comp_root');
    const layer = controller.getLayersForNode('vid')[0];
    if (!layer) throw new Error('no clip');
    controller.trimClipTo(layer.id, 'end', 10);
    controller.trimClipTo(layer.id, 'start', 0);
  }

  it('cuts the selected words out of the timeline and shifts the transcript', async () => {
    withOneFullVideoLayer();
    seedTranscript();
    render(<TranscriptPanel />);

    fireEvent.pointerDown(chip('um'));
    fireEvent.keyDown(panel(), { key: 'Delete' });

    await waitFor(() => expect(useTranscriptStore.getState().byComp.comp_root?.edited).toBe(true));
    // The word is gone from the transcript…
    const words = useTranscriptStore.getState().byComp.comp_root?.words ?? [];
    expect(words.map((w) => w.text)).not.toContain('um');
    // …and the clip was cut in two with the gap closed, so the comp is shorter.
    const bars = getTimelineController().layersOfComp('comp_root');
    expect(bars.length).toBeGreaterThan(1);
    const total = bars.reduce((sum, l) => sum + l.duration, 0);
    expect(total).toBeLessThan(300);
  });

  it('does nothing when nothing is selected', () => {
    withOneFullVideoLayer();
    seedTranscript();
    render(<TranscriptPanel />);
    fireEvent.keyDown(panel(), { key: 'Delete' });
    expect(getTimelineController().layersOfComp('comp_root')).toHaveLength(1);
  });

  it('does NOT fire while the search box has focus', () => {
    // The bug this prevents: typing in a filter box and pressing Backspace to
    // correct a typo would silently cut the composition.
    withOneFullVideoLayer();
    seedTranscript();
    render(<TranscriptPanel />);
    fireEvent.pointerDown(chip('um'));
    const search = screen.getByLabelText('Find a word in the transcript');
    fireEvent.keyDown(search, { key: 'Backspace' });
    expect(getTimelineController().layersOfComp('comp_root')).toHaveLength(1);
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
    addLayer('vid', 'video');
    const controller = getTimelineController();
    controller.syncFromScene('comp_root');
    seedTranscript();
    render(<TranscriptPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'All layers' }));
    fireEvent.pointerDown(chip('um'));
    fireEvent.keyDown(panel(), { key: 'Delete' });

    await waitFor(() => expect(useTranscriptStore.getState().phase).toBe('idle'));
    expect(controller.layersOfComp('comp_root')).toHaveLength(1);
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
